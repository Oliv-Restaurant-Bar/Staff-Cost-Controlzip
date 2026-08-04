/**
 * Z-Bericht Auto-Import (Inbox → gn_imports) — Browser-Runner
 * ============================================================
 *
 * Verarbeitet ALLE 'pending'-Zeilen des E-Mail-Eingangs (zbericht_inbox)
 * automatisch über den BESTEHENDEN Parser-/Speicherweg
 * (parseGnZBerichtPdf → saveGnImport). Mandantengetrennt — der Runner
 * arbeitet strikt auf dem übergebenen Tenant.
 *
 * Robustheit (ein PDF blockiert nie den Rest):
 * - Jede Zeile läuft isoliert; jeder Fehler setzt NUR diese Zeile auf
 *   status 'error' (mit Grund) und der Rest wird weiter verarbeitet.
 * - 'error'-Zeilen werden NIE automatisch erneut versucht — manuelle Prüfung.
 *
 * Sicherheits-Leitplanken (nur wirklich eindeutige Fälle automatisch):
 * - Checksummen-Duplikat (bereits importiert) ⇒ Zeile wird als 'imported'
 *   mit Verweis auf den bestehenden Import abgeschlossen — NIE doppelt.
 * - NUR Tagesimporte (periodFrom === periodTo). Alles andere ⇒ 'error'.
 * - Zeitraum-Überschneidung mit bestehenden Imports ⇒ 'error' (der
 *   Auto-Import ERSETZT nie einen bestehenden Import — das bleibt eine
 *   manuelle Entscheidung im Wizard).
 * - Download-/Netzwerkfehler ⇒ Zeile bleibt 'pending' (nächster Lauf
 *   versucht es erneut — das ist kein Datei-Problem).
 *
 * Undo: importierte Berichte erscheinen in der Import-Historie der
 * Z-Bericht-Seite und sind dort einzeln löschbar (bestehender Weg).
 */

import type { ZberichtInboxRow } from './zbericht-inbox-db';
import {
  downloadZberichtInboxPdf, markZberichtInboxImported, markZberichtInboxError,
  claimZberichtInboxRow, releaseZberichtInboxClaim, ZBERICHT_CLAIM_STALE_MINUTES,
} from './zbericht-inbox-db';
import {
  saveGnImport, checkGnChecksumDuplicate, checkOverlappingImports,
} from './gn-zbericht-db';
import { parseGnZBerichtPdf } from './gn-zbericht-pdf-parser';
import { extractGnPdfTextItems } from './gn-pdf-text';
import { reconstructGnPdfLines, detectGnPdfReportKind } from './gn-pdf-lines';
import { GN_KPI_KIND_LABELS } from './gn-kpi-pdf-parser';

export interface ZberichtAutoImportItem {
  rowId: string;
  fileName: string;
  outcome: 'imported' | 'duplicate' | 'error' | 'skipped';
  /** Importierter Geschäftstag (nur bei outcome 'imported'). */
  day: string | null;
  /** Fehlergrund (outcome 'error') bzw. Hinweis ('skipped'). */
  reason: string | null;
}

export interface ZberichtAutoImportResult {
  items: ZberichtAutoImportItem[];
  importedCount: number;
  duplicateCount: number;
  errorCount: number;
  /** Zeilen, die pending bleiben (transienter Download-Fehler → nächster Lauf). */
  skippedCount: number;
  /** Importierte Geschäftstage (für den Tagesabschluss-Konfliktcheck). */
  importedDays: string[];
}

/** Kurzfassung für die Abschluss-Meldung: «X importiert · Y brauchen manuelle Prüfung». */
export function autoImportSummary(r: ZberichtAutoImportResult): string {
  const parts: string[] = [];
  if (r.importedCount > 0) parts.push(`${r.importedCount} importiert`);
  if (r.duplicateCount > 0) parts.push(`${r.duplicateCount} bereits vorhanden (übersprungen)`);
  if (r.errorCount > 0) parts.push(`${r.errorCount} brauch${r.errorCount === 1 ? 't' : 'en'} manuelle Prüfung`);
  if (r.skippedCount > 0) parts.push(`${r.skippedCount} zurückgestellt (Download-Fehler)`);
  return parts.length > 0 ? parts.join(' · ') : 'Keine ausstehenden Z-Berichte.';
}

/**
 * Alle übergebenen pending-Zeilen chronologisch (älteste zuerst) verarbeiten.
 * 'error'-Zeilen in der Eingabe werden ignoriert (kein Auto-Retry).
 */
/** Ist die Zeile für einen Auto-Lauf claimbar? (pending oder verwaister Claim) */
export function isZberichtRowClaimable(r: ZberichtInboxRow, now = Date.now()): boolean {
  if (r.status === 'pending') return true;
  if (r.status !== 'processing') return false;
  // Verwaister Claim (Tab geschlossen): nach 10 Min. wieder aufnehmbar.
  const claimedAt = r.claimed_at ? Date.parse(r.claimed_at) : NaN;
  return !Number.isFinite(claimedAt) || now - claimedAt > ZBERICHT_CLAIM_STALE_MINUTES * 60_000;
}

export async function runZberichtAutoImport(
  tenantId: string,
  rows: ZberichtInboxRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<ZberichtAutoImportResult> {
  const pending = rows
    .filter(r => r.restaurant_id === tenantId && isZberichtRowClaimable(r))
    .sort((a, b) => a.received_at.localeCompare(b.received_at));

  const items: ZberichtAutoImportItem[] = [];
  const importedDays: string[] = [];
  let done = 0;

  for (const row of pending) {
    const item = await processOne(tenantId, row);
    items.push(item);
    if (item.outcome === 'imported' && item.day) importedDays.push(item.day);
    done += 1;
    onProgress?.(done, pending.length);
  }

  return {
    items,
    importedCount: items.filter(i => i.outcome === 'imported').length,
    duplicateCount: items.filter(i => i.outcome === 'duplicate').length,
    errorCount: items.filter(i => i.outcome === 'error').length,
    skippedCount: items.filter(i => i.outcome === 'skipped').length,
    importedDays,
  };
}

async function processOne(
  tenantId: string,
  row: ZberichtInboxRow,
): Promise<ZberichtAutoImportItem> {
  const base = { rowId: row.id, fileName: row.file_name, day: null as string | null, reason: null as string | null };

  // Fehlerzeile schreiben; schlägt auch DAS fehl, Claim zurückgeben und die
  // Zeile als 'skipped' melden (bleibt pending), damit der Lauf nie abbricht.
  const fail = async (reason: string): Promise<ZberichtAutoImportItem> => {
    const marked = await markZberichtInboxError(row.id, reason);
    if (marked.error) {
      await releaseZberichtInboxClaim(row.id);
      return { ...base, outcome: 'skipped', reason: `${reason} (Status-Update fehlgeschlagen: ${marked.error})` };
    }
    return { ...base, outcome: 'error', reason };
  };

  // 0) ATOMARER CLAIM (Cross-Tab-Schutz): nur wer die Zeile wirklich auf
  //    'processing' umstellt, verarbeitet sie — der zweite Tab bekommt 0 Zeilen
  //    und überspringt. OHNE Claim wird NIE gespeichert.
  const claim = await claimZberichtInboxRow(row.id);
  if (claim.error) {
    return { ...base, outcome: 'skipped', reason: `Claim fehlgeschlagen: ${claim.error}` };
  }
  if (!claim.claimed) {
    return { ...base, outcome: 'skipped', reason: 'Wird bereits von einem anderen Lauf/Tab verarbeitet.' };
  }

  // Transienter Fehler ⇒ Claim zurückgeben (nächster Lauf versucht erneut).
  const transient = async (reason: string): Promise<ZberichtAutoImportItem> => {
    await releaseZberichtInboxClaim(row.id);
    return { ...base, outcome: 'skipped', reason };
  };

  try {
    // 1) PDF laden — Netzwerk-/Storage-Fehler sind transient ⇒ pending lassen.
    const { blob, error: dlError } = await downloadZberichtInboxPdf(row.storage_path);
    if (dlError || !blob) {
      return transient(dlError ?? 'PDF-Download fehlgeschlagen');
    }
    const file = new File([blob], row.file_name, { type: 'application/pdf' });

    // 2) Text extrahieren + Berichtstyp prüfen.
    const extract = await extractGnPdfTextItems(file);
    if (!extract.hasTextLayer) {
      return fail('PDF hat keinen Textlayer (Scan?) — manuell prüfen.');
    }
    const detection = detectGnPdfReportKind(reconstructGnPdfLines(extract.pages));
    if (detection.kind !== 'zbericht' && detection.kind !== 'unbekannt') {
      return fail(`Kein Z-Bericht, sondern «${GN_KPI_KIND_LABELS[detection.kind]}» — im Bereich «Gäste & Bonanalyse» importieren.`);
    }

    // 3) Parsen — leeres Ergebnis ist ein Datei-Problem.
    const parsed = parseGnZBerichtPdf(extract.pages, row.file_name);
    if (parsed.revenue.totalGross === 0 && parsed.taxes.length === 0) {
      const missing = parsed.debug.missingSections.length > 0
        ? ` Fehlende Sektionen: ${parsed.debug.missingSections.join(', ')}.` : '';
      return fail(`PDF konnte nicht als Z-Bericht gelesen werden (weder Umsatz- noch Steuerdaten).${missing}`);
    }

    // 4) Bereits importiert (Checksumme)? ⇒ Zeile abschliessen, NIE doppelt speichern.
    const dup = await checkGnChecksumDuplicate(tenantId, parsed.checksum);
    if (dup.isDuplicate && dup.existingId) {
      const marked = await markZberichtInboxImported(row.id, dup.existingId);
      if (marked.error) return transient(`Duplikat erkannt, Status-Update fehlgeschlagen: ${marked.error}`);
      return { ...base, outcome: 'duplicate', reason: `Bereits importiert (${dup.existingFileName ?? 'Checksumme identisch'}).` };
    }

    // 5) Nur eindeutige TAGES-Importe automatisch.
    if (!parsed.periodFrom || !parsed.periodTo) {
      return fail('Zeitraum nicht erkannt — Import mit manueller Zeitraum-Angabe nötig.');
    }
    if (parsed.periodFrom !== parsed.periodTo) {
      return fail(`Kein Tagesimport (Zeitraum ${parsed.periodFrom} – ${parsed.periodTo}) — manuell prüfen.`);
    }

    // 6) Überschneidung mit bestehenden Imports ⇒ NIE automatisch ersetzen.
    const overlaps = await checkOverlappingImports(tenantId, parsed.periodFrom, parsed.periodTo);
    if (overlaps.length > 0) {
      return fail(`Zeitraum ${parsed.periodFrom} überschneidet ${overlaps.length} bestehende${overlaps.length === 1 ? 'n' : ''} Import — manuell entscheiden (ersetzen/ignorieren).`);
    }

    // 7) Speichern (bestehender Weg) + Inbox-Zeile abschliessen.
    const { importId, error: saveError } = await saveGnImport(tenantId, parsed, undefined, [], parsed.periodFrom, parsed.periodTo);
    if (saveError || !importId) {
      return fail('Speichern fehlgeschlagen: ' + (saveError ?? 'unbekannter Fehler'));
    }
    const marked = await markZberichtInboxImported(row.id, importId);
    if (marked.error) {
      // Import ist gespeichert — Doppel-Import verhindert die Checksumme beim nächsten Lauf.
      return { ...base, outcome: 'imported', day: parsed.periodFrom, reason: `Import gespeichert, Eingangs-Status-Update fehlgeschlagen: ${marked.error}` };
    }
    return { ...base, outcome: 'imported', day: parsed.periodFrom, reason: null };
  } catch (e) {
    return fail('Unerwarteter Fehler: ' + (e instanceof Error ? e.message : String(e)));
  }
}

