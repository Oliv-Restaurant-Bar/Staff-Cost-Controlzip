/**
 * Reporting Store – Datenzugriff für Monatsdaten
 * ================================================
 *
 * Aktuell: localStorage (Schlüssel: 'reporting_v1')
 * Zukünftig: Supabase-Tabelle "monthly_financial_records"
 *
 * Die API ist bewusst so gestaltet, dass der Wechsel auf Supabase
 * nur diese Datei betrifft – alle Seiten bleiben unverändert.
 *
 * ─── Import-Deduplication-Konzept ───────────────────────────────
 *
 * Problem:  Wenn derselbe Monat zweimal importiert wird, entstehen
 *           sonst doppelte Werte (z.B. Umsatz wird addiert).
 *
 * Lösung:   Jeder Monat hat eine eindeutige ID ("YYYY-MM").
 *           Kein zweiter Datensatz kann mit derselben ID existieren.
 *
 * Zwei Import-Modi steuern, was passiert:
 *
 *   "replace" → Das komplette Monats-Objekt wird durch den neuen
 *               Datensatz ersetzt. Import-Protokoll bleibt erhalten.
 *               Wann: Neuer Buchhaltungsabschluss liegt vor.
 *
 *   "update"  → Nur die explizit mitgelieferten Felder werden
 *               überschrieben. Alle anderen Felder bleiben wie bisher.
 *               Wann: Nachtrag einzelner Positionen ohne Neuimport.
 */

import {
  MonthlyFinancialRecord,
  ImportRecord,
  ImportMode,
  ImportSource,
  ExpenseCategory,
  createEmptyMonth,
  monthId,
  AnnualSummary,
  MONTH_NAMES_DE,
  SageJournalEntry,
} from '@/types/reporting';
import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet, kvSetStrict, safeUpsertReportingMonth, safeDeleteReportingMonth, notifyKVBackupProblem } from './supabase-kv';
import { readLocalRecord } from './kv-blob-utils';
import { sameCategorySet } from './annual-cost-preview';

// ─── Konstanten ───────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'reporting_v1';

// ─── Interne Hilfsfunktionen ──────────────────────────────────────────────────

function loadAll(storeKey: string = STORAGE_KEY): Record<string, MonthlyFinancialRecord> {
  // Parse-/Shape-Guard zentral (kv-blob-utils)
  return readLocalRecord(storeKey) as unknown as Record<string, MonthlyFinancialRecord>;
}

function saveAll(data: Record<string, MonthlyFinancialRecord>, storeKey: string = STORAGE_KEY): void {
  // Nur localStorage – Supabase-Schreib erfolgt via safeUpsertReportingMonth / safeDeleteReportingMonth
  // (verhindert stale-Overwrite anderer Monate bei unvollständig synchronisiertem localStorage)
  localStorage.setItem(storeKey, JSON.stringify(data));
}

// ─── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * Alle Monate eines bestimmten Jahres laden.
 * Gibt 12 Einträge zurück – leere Monate ohne Daten sind enthalten.
 */
export function loadYear(year: number, storeKey: string = STORAGE_KEY): MonthlyFinancialRecord[] {
  const all = loadAll(storeKey);
  return Array.from({ length: 12 }, (_, i) => {
    const id = monthId(year, i + 1);
    return all[id] ?? createEmptyMonth(year, i + 1);
  });
}

/**
 * Manuelles Abstimmungsfeld eines Monats LÖSCHEN (leeres Feld = kein Wert,
 * nie 0 erzwingen). Nur für die manuellen Umsatzabstimmungs-Felder gedacht;
 * schreibt wie saveMonth ein Import-Protokoll und sichert per Monats-Upsert.
 * No-op, wenn der Monat nicht existiert oder das Feld bereits leer ist.
 */
export function clearManualUmsatzField(
  year: number,
  month: number,
  field: 'grossRevenueManual' | 'takeAwayGrossManual',
  storeKey: string = STORAGE_KEY,
): void {
  const all = loadAll(storeKey);
  const id  = monthId(year, month);
  const existing = all[id];
  if (!existing || existing[field] === undefined) return;

  const saved: MonthlyFinancialRecord = { ...existing };
  delete saved[field];
  saved.imports = [...saved.imports, {
    importId:   uuidv4(),
    importedAt: new Date().toISOString(),
    source:     'manual',
    mode:       'update',
    note:       field === 'grossRevenueManual' ? 'Bruttoumsatz manuell gelöscht' : 'Take Away manuell gelöscht',
    affectedFields: [field],
  }];
  saved.updatedAt = new Date().toISOString();
  all[id] = saved;
  saveAll(all, storeKey);
  safeUpsertReportingMonth(id, saved, storeKey).catch(err => {
    console.error('[REPORTING] clearManualUmsatzField: safeUpsertReportingMonth fehlgeschlagen', err);
  });
}

/**
 * Einzelnen Monat laden.
 * Gibt einen leeren Datensatz zurück, wenn noch keine Daten vorhanden.
 */
export function loadMonth(year: number, month: number, storeKey: string = STORAGE_KEY): MonthlyFinancialRecord {
  const all = loadAll(storeKey);
  const id  = monthId(year, month);
  return all[id] ?? createEmptyMonth(year, month);
}

/**
 * Monat speichern.
 *
 * ImportMode entscheidet, was passiert:
 *   "replace" → bestehenden Eintrag vollständig ersetzen
 *               (Import-Protokoll wird angehängt, nicht gelöscht)
 *   "update"  → bestehenden Eintrag mit neuen Daten mergen
 *               (undefined-Felder im neuen Objekt werden ignoriert)
 *
 * In beiden Fällen wird ein ImportRecord angelegt.
 *
 * opts.skipKvBackup: NUR für Mehrmonats-Schleifen — parallele fire-and-forget
 * safeUpserts desselben Blobs können sich gegenseitig mit veralteten Monats-
 * werten überschreiben (Basis-Union bevorzugt remote pro Monat). Der Aufrufer
 * MUSS danach selbst sequenziell sichern (retryReportingMonthsBackup) und
 * Fehler sichtbar machen — nie still weglassen.
 */
export function saveMonth(
  incoming: Partial<MonthlyFinancialRecord> & { year: number; month: number },
  source: ImportSource,
  mode: ImportMode,
  opts?: { fileName?: string; note?: string; skipKvBackup?: boolean },
  storeKey: string = STORAGE_KEY,
): MonthlyFinancialRecord {
  const all      = loadAll(storeKey);
  const id       = monthId(incoming.year, incoming.month);
  const existing = all[id] ?? createEmptyMonth(incoming.year, incoming.month);
  const now      = new Date().toISOString();

  // Feststellen welche Felder sich ändern
  const affectedFields: (keyof MonthlyFinancialRecord)[] = [];
  const trackableFields: (keyof MonthlyFinancialRecord)[] = [
    'revenueActual', 'revenueBudget', 'revenuePreviousYear', 'grossRevenueManual', 'takeAwayGrossManual',
    'personnelCostActual', 'personnelCostPlanned', 'personnelCostPreviousYear',
    'expenseCategories', 'expenseCategoriesPreviousYear',
  ];
  for (const f of trackableFields) {
    if (incoming[f] !== undefined) {
      affectedFields.push(f);
    }
  }

  const importRecord: ImportRecord = {
    importId:       uuidv4(),
    importedAt:     now,
    source,
    mode,
    fileName:       opts?.fileName,
    note:           opts?.note,
    affectedFields,
  };

  let saved: MonthlyFinancialRecord;

  if (mode === 'replace') {
    // Komplett ersetzen – Import-Protokoll aus bestehend anhängen
    saved = {
      ...createEmptyMonth(incoming.year, incoming.month),
      ...incoming,
      id,
      imports:   [...existing.imports, importRecord],
      createdAt: existing.createdAt, // Originaldatum behalten
      updatedAt: now,
    };
  } else {
    // Update: nur gelieferte Felder überschreiben
    const merged: MonthlyFinancialRecord = { ...existing };

    if (incoming.revenueActual          !== undefined) merged.revenueActual          = incoming.revenueActual;
    if (incoming.revenueBudget          !== undefined) merged.revenueBudget          = incoming.revenueBudget;
    if (incoming.revenuePreviousYear    !== undefined) merged.revenuePreviousYear    = incoming.revenuePreviousYear;
    if (incoming.grossRevenueManual     !== undefined) merged.grossRevenueManual     = incoming.grossRevenueManual;
    if (incoming.takeAwayGrossManual    !== undefined) merged.takeAwayGrossManual    = incoming.takeAwayGrossManual;
    if (incoming.personnelCostActual    !== undefined) merged.personnelCostActual    = incoming.personnelCostActual;
    if (incoming.personnelCostPlanned   !== undefined) merged.personnelCostPlanned   = incoming.personnelCostPlanned;
    if (incoming.personnelCostPreviousYear !== undefined) merged.personnelCostPreviousYear = incoming.personnelCostPreviousYear;

    // Für Ausgabenkategorien: vorhandene Kategorien aktualisieren
    // oder neue anhängen – niemals duplizieren
    if (incoming.expenseCategories && incoming.expenseCategories.length > 0) {
      merged.expenseCategories = mergeExpenseCategories(
        merged.expenseCategories,
        incoming.expenseCategories,
      );
    }
    if (incoming.expenseCategoriesPreviousYear && incoming.expenseCategoriesPreviousYear.length > 0) {
      merged.expenseCategoriesPreviousYear = mergeExpenseCategories(
        merged.expenseCategoriesPreviousYear,
        incoming.expenseCategoriesPreviousYear,
      );
    }

    merged.imports   = [...merged.imports, importRecord];
    merged.updatedAt = now;
    saved = merged;
  }

  all[id] = saved;
  saveAll(all, storeKey);
  // Sicher nach Supabase schreiben: erst KV-Stand lesen, nur diesen Monat mergen,
  // dann zurückschreiben — verhindert Datenverlust bei stale localStorage.
  // skipKvBackup: Mehrmonats-Schleifen sichern danach selbst SEQUENZIELL
  // (retryReportingMonthsBackup) — parallele Upserts desselben Blobs würden
  // sich gegenseitig mit veralteten Monatswerten überschreiben.
  if (!opts?.skipKvBackup) {
    safeUpsertReportingMonth(id, saved, storeKey).catch(err => {
      console.error('[REPORTING] saveMonth: safeUpsertReportingMonth fehlgeschlagen', err);
    });
  }
  return saved;
}

/**
 * Undo-Wiederherstellung: einzelne FELDER pro Monat auf den Stand vor einem
 * Import zurücksetzen (Import-Center «Letzten Import rückgängig machen»).
 * `null` = Feld war vor dem Import nicht vorhanden → wird entfernt.
 * Scope-treu: nur die genannten Felder der genannten Monate werden angefasst.
 * Supabase-Sicherung SEQUENZIELL (retryReportingMonthsBackup-Disziplin).
 */
export async function restoreReportingFields(
  storeKey: string,
  months: Array<{ monthId: string; fields: Record<string, unknown | null> }>,
): Promise<{ failedMonths: string[] }> {
  const all = loadAll(storeKey);
  const now = new Date().toISOString();
  const touched: string[] = [];
  for (const m of months) {
    const existing = all[m.monthId];
    // Monat existiert nicht (mehr) und alle Felder waren vorher leer → nichts zu tun.
    const [y, mo] = m.monthId.split('-').map(Number);
    const rec: MonthlyFinancialRecord = existing ?? createEmptyMonth(y, mo);
    const restored: MonthlyFinancialRecord = { ...rec };
    let changed = false;
    for (const [field, prior] of Object.entries(m.fields)) {
      const cur = (restored as unknown as Record<string, unknown>)[field];
      const target = prior === null ? undefined : prior;
      if (JSON.stringify(cur ?? null) === JSON.stringify(target ?? null)) continue;
      if (target === undefined) {
        delete (restored as unknown as Record<string, unknown>)[field];
      } else {
        (restored as unknown as Record<string, unknown>)[field] = target;
      }
      changed = true;
    }
    if (!changed) continue;
    restored.updatedAt = now;
    all[m.monthId] = restored;
    touched.push(m.monthId);
  }
  if (touched.length === 0) return { failedMonths: [] };
  saveAll(all, storeKey);
  const res = await retryReportingMonthsBackup(touched, storeKey);
  return { failedMonths: res.failedMonths };
}

/**
 * Undo-Wiederherstellung: kompletten Monats-Record ersetzen (oder entfernen,
 * wenn er vor dem Import nicht existierte) + optional Journalzeilen.
 * Für Importe im replace-Modus (z. B. Ist Kosten Buchhaltung).
 */
export async function restoreReportingRecord(
  storeKey: string,
  monthId: string,
  record: MonthlyFinancialRecord | null,
  journal?: { year: number; month: number; entries: SageJournalEntry[]; tenantId?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const all = loadAll(storeKey);
    if (record === null) {
      delete all[monthId];
      saveAll(all, storeKey);
      await safeDeleteReportingMonth(monthId, storeKey);
    } else {
      all[monthId] = { ...record, updatedAt: new Date().toISOString() };
      saveAll(all, storeKey);
      const res = await retryReportingMonthsBackup([monthId], storeKey);
      if (res.failedMonths.length > 0) {
        return { ok: false, error: 'Lokal zurückgesetzt, aber Supabase-Sicherung fehlgeschlagen — bitte erneut versuchen.' };
      }
    }
    if (journal) {
      try {
        await saveJournalEntriesStrict(journal.year, journal.month, journal.entries, journal.tenantId ?? 'oliv');
      } catch (err) {
        return {
          ok: false,
          error: 'Monat wiederhergestellt, aber das Journal konnte nicht nach Supabase gesichert werden — bitte «Rückgängig» erneut versuchen. '
            + (err instanceof Error ? err.message : String(err)),
        };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Monat löschen (Admin-Funktion, z.B. Testdaten entfernen).
 */
export function deleteMonth(year: number, month: number, storeKey: string = STORAGE_KEY): void {
  const id = monthId(year, month);
  const all = loadAll(storeKey);
  delete all[id];
  saveAll(all, storeKey);
  // Sicher aus Supabase entfernen: erst KV-Stand lesen, nur diesen Monat entfernen,
  // dann zurückschreiben — andere Monate bleiben erhalten
  safeDeleteReportingMonth(id, storeKey).catch(async err => {
    console.error('[REPORTING] deleteMonth: safeDeleteReportingMonth fehlgeschlagen', err);
    try {
      const { toast } = await import('sonner');
      toast.error(
        `Monat ${id} wurde lokal gelöscht, aber das Löschen im Supabase-Backup ist fehlgeschlagen. ` +
        'Der Monat kann beim nächsten Sync wieder erscheinen — bitte Verbindung prüfen und erneut löschen.',
        { duration: 10000, id: 'reporting-delete-failed' },
      );
    } catch { /* Sonner nicht verfügbar */ }
  });
}

// ─── Jahres-Kontoblatt-Import: Replace-Scope pro Geschäftsjahr ────────────────

/**
 * Numerische Konto-Kategorien (FIBU-Quelle Sage Kontoblatt) — exakt dieselbe
 * Grenze, die pl-engine (resolveRowId) und PLView (prevYearByRow) verwenden.
 * Auch '[Unzugeordnet]'-Zeilen tragen numerische IDs und gehören dazu.
 */
const NUMERIC_ACCOUNT_RE = /^\d{3,5}$/;

export interface ReplaceAnnualCostResult {
  /** Manuell geschützte Konto-Zeilen (Konto×Monat), die der Import NICHT angefasst hat */
  zeilenGeschuetzt: number;
  /** Monate, die neue Kontodaten erhalten haben */
  monthsWritten: number;
  /** Monate, in denen nur alte Kontodaten entfernt wurden */
  monthsCleared: number;
  /**
   * Monate, deren effektive Kategorien dem Bestand entsprechen (Dirty-Check):
   * kein Write, kein updatedAt-Bump, kein KV-Backup — identisches Speichern
   * ist ein No-op (verbindliche updatedAt-Regel).
   */
  monthsUnchanged: number;
  /**
   * Supabase-Backup-Ergebnis (localStorage ist bereits geschrieben).
   * failedMonths ≠ [] → Backup unvollständig (nach 1 automatischem Retry),
   * Aufrufer muss es actionable sichtbar machen (notifyKVBackupProblem + Retry).
   */
  kvBackup: Promise<{ failedMonths: string[]; lastError?: unknown }>;
}

/**
 * Ergebnis der Backup-Prüfung (ImportHub «Backup prüfen»):
 * missing = Monate, die lokal existieren und remote FEHLEN (Reparaturkandidaten).
 */
export interface BackupRepairDiff {
  missing: string[];
  localCount: number;
  remoteCount: number;
}

/**
 * REINE Kandidaten-Berechnung der Backup-Prüfung (kein IO — der Aufrufer
 * liest lokal via readLocalRecord und remote via kvGetStrict):
 * - Kandidaten sind ausschliesslich Monate, die lokal existieren und remote fehlen.
 * - Tombstoned Monate (deleted:true) sind gewollte Löschungen → nie Kandidaten.
 * - Inhaltliche Unterschiede werden bewusst NICHT angefasst (kein stilles
 *   Überschreiben des Remote-Stands).
 */
export function computeBackupRepairCandidates(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): BackupRepairDiff {
  const missing = Object.keys(local)
    .filter(id => {
      const rec = local[id];
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
      if ((rec as { deleted?: boolean }).deleted === true) return false;
      return remote[id] === undefined;
    })
    .sort();
  return { missing, localCount: Object.keys(local).length, remoteCount: Object.keys(remote).length };
}

/**
 * Nachsicherung fehlgeschlagener Monats-Backups: liest den LOKALEN Stand
 * frisch (nie alte Snapshots) und schreibt jeden Monat sequenziell über
 * safeUpsertReportingMonth ins Supabase-KV. Monate, die lokal nicht (mehr)
 * existieren, werden übersprungen — Nachsicherung erfindet nie Daten.
 */
export async function retryReportingMonthsBackup(
  monthIds: string[],
  storeKey: string = STORAGE_KEY,
): Promise<{ failedMonths: string[]; lastError?: unknown }> {
  const current = loadAll(storeKey);
  const failedMonths: string[] = [];
  let lastError: unknown;
  for (const id of monthIds) {
    const rec = current[id];
    if (!rec) continue;
    try {
      await safeUpsertReportingMonth(id, rec, storeKey);
    } catch (err) {
      console.error('[REPORTING] retryReportingMonthsBackup: Monat fehlgeschlagen', id, err);
      failedMonths.push(id);
      lastError = err;
    }
  }
  return { failedMonths, lastError };
}

/**
 * Integritätsprüfung für Jahres-Schreiboperationen (Schreibschutz fremder Jahre).
 *
 * Vergleicht den Datenbestand VOR und NACH einer geplanten Jahres-Operation:
 * Es dürfen ausschliesslich Monats-Records des Zieljahres angelegt, verändert
 * oder entfernt werden. Jeder Record eines anderen Jahres muss bitgenau
 * (JSON-identisch) erhalten bleiben — sonst wird mit einem Fehler abgebrochen,
 * BEVOR irgendetwas gespeichert wird.
 */
export function assertYearScopedChanges(
  before: Record<string, MonthlyFinancialRecord>,
  after: Record<string, MonthlyFinancialRecord>,
  targetYear: number,
): void {
  const prefix = `${targetYear}-`;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const violations: string[] = [];
  for (const id of ids) {
    if (id.startsWith(prefix)) continue;
    const b = before[id];
    const a = after[id];
    if (b === undefined && a !== undefined) violations.push(`${id} (würde neu angelegt)`);
    else if (b !== undefined && a === undefined) violations.push(`${id} (würde gelöscht)`);
    else if (JSON.stringify(b) !== JSON.stringify(a)) violations.push(`${id} (würde verändert)`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Integritätsprüfung fehlgeschlagen: Die Jahres-Operation ${targetYear} würde Daten anderer Jahre verändern — ` +
      `${violations.join(', ')}. Es wurde NICHTS gespeichert.`,
    );
  }
}

/**
 * Merge-Schutz für manuell erfasste Konto-Zeilen (quelle='manuell'):
 * - `geschuetzt` = numerische Bestandszeilen mit quelle='manuell', die NICHT
 *   explizit per «Importwert übernehmen» freigegeben sind — sie bleiben
 *   unverändert erhalten (auch wenn sie in der Datei fehlen).
 * - `newCats` = Import-Zeilen OHNE die geschützten Konten; explizit
 *   übernommene Zeilen werden danach wieder als quelle='manuell' geführt.
 *
 * `uebernehmen`-Schlüssel: `${month}|${accountNumber}`.
 */
function mergeProtectedCats(
  existingCats: ExpenseCategory[],
  importCats: ExpenseCategory[],
  month: number,
  uebernehmen?: ReadonlySet<string>,
): { geschuetzt: ExpenseCategory[]; newCats: ExpenseCategory[] } {
  const frei = uebernehmen ?? new Set<string>();
  const geschuetzt = existingCats.filter(c =>
    NUMERIC_ACCOUNT_RE.test(c.categoryId)
    && c.quelle === 'manuell'
    && !frei.has(`${month}|${c.categoryId}`));
  const geschuetztIds = new Set(geschuetzt.map(c => c.categoryId));
  const newCats = importCats
    .filter(c => !geschuetztIds.has(c.categoryId))
    .map(c => frei.has(`${month}|${c.categoryId}`) && NUMERIC_ACCOUNT_RE.test(c.categoryId)
      ? { ...c, quelle: 'manuell' as const }
      : c);
  return { geschuetzt, newCats };
}

/**
 * Ersetzt für ein Geschäftsjahr in ALLEN 12 Monaten die numerischen
 * Konto-Kategorien (expenseCategories) durch die Daten eines
 * Jahres-Kontoblatt-Imports — idempotent:
 *
 * - Numerische Kategorien werden komplett ersetzt (auch in Monaten, die in
 *   der neuen Datei fehlen → entfernt stale Werte aus früheren Importen).
 * - Manuelle (nicht-numerische) Kategorien, revenueActual (Gastronovi),
 *   personnelCost*-Felder, Budget- und PY-Felder bleiben unangetastet.
 * - Andere Jahre bleiben unberührt.
 * - Schreibpfad pro Monat über safeUpsertReportingMonth (kein naiver Blob-Write).
 *
 * `categoriesByMonth` = Monat (1–12) → fertige ExpenseCategory-Liste
 * (aus matchCSVRows + buildExpenseCategoriesOnly, Vorzeichen bereits korrekt).
 */
export function replaceAnnualCostYear(
  year: number,
  categoriesByMonth: Map<number, ExpenseCategory[]>,
  opts: {
    fileName?: string;
    note?: string;
    uebernehmen?: ReadonlySet<string>;
    /**
     * NUR für das explizite Löschen (removeAnnualCostYear): hebt den
     * Merge-Schutz manueller Zeilen auf, damit «Jahr entfernen» wirklich
     * ALLE numerischen Konto-Kategorien entfernt. Imports setzen das NIE.
     */
    ignoreManualProtection?: boolean;
  },
  storeKey: string = STORAGE_KEY,
): ReplaceAnnualCostResult {
  const before = loadAll(storeKey);
  const next: Record<string, MonthlyFinancialRecord> = { ...before };
  const now = new Date().toISOString();
  let monthsWritten = 0;
  let monthsCleared = 0;
  let monthsUnchanged = 0;
  let zeilenGeschuetzt = 0;
  const touchedIds: string[] = [];

  for (let month = 1; month <= 12; month++) {
    const id = monthId(year, month);
    const existing = next[id];
    const merged = opts.ignoreManualProtection
      ? { geschuetzt: [] as ExpenseCategory[], newCats: categoriesByMonth.get(month) ?? [] }
      : mergeProtectedCats(
          existing?.expenseCategories ?? [], categoriesByMonth.get(month) ?? [], month, opts.uebernehmen);
    const newCats = merged.newCats;
    zeilenGeschuetzt += merged.geschuetzt.length;
    const hadNumeric = (existing?.expenseCategories ?? []).some(c => NUMERIC_ACCOUNT_RE.test(c.categoryId));

    // Nichts zu ersetzen und nichts Neues → Monat nicht anfassen (keine leeren Records erzeugen)
    if (newCats.length === 0 && merged.geschuetzt.length === 0 && !hadNumeric) continue;

    const rec = existing ?? createEmptyMonth(year, month);
    // Nicht-numerische Kategorien UND manuell geschützte Konto-Zeilen bleiben
    // IMMER erhalten — nie überschreiben, nie löschen (auch wenn sie in der
    // Datei fehlen). Ausnahme: explizit «Importwert übernehmen» (opts.uebernehmen).
    const keptManual = [
      ...(rec.expenseCategories ?? []).filter(c => !NUMERIC_ACCOUNT_RE.test(c.categoryId)),
      ...merged.geschuetzt,
    ];

    // Dirty-Check (verbindliche updatedAt-Regel): entspricht das Ergebnis
    // [manuelle + neue Konten] fachlich exakt dem Bestand, ist der Monat ein
    // No-op — kein Write, kein updatedAt-Bump, kein KV-Backup. Damit werden
    // «unangetastet lassen»-Monate der Konfliktmodi (Pre-Merge liefert die
    // bestehenden Kategorien) technisch garantiert nicht angefasst.
    if (existing && sameCategorySet(existing.expenseCategories ?? [], [...keptManual, ...newCats])) {
      monthsUnchanged++;
      continue;
    }

    const importRecord: ImportRecord = {
      importId: uuidv4(),
      importedAt: now,
      source: 'annual_cost_import',
      mode: 'replace',
      fileName: opts.fileName,
      note: opts.note ?? `Jahres-Kontoblatt ${year}: Konto-Kategorien ersetzt`,
      affectedFields: ['expenseCategories'],
    };

    next[id] = {
      ...rec,
      expenseCategories: [...keptManual, ...newCats],
      imports: [...rec.imports, importRecord],
      updatedAt: now,
    };
    touchedIds.push(id);
    if (newCats.length > 0) monthsWritten++; else monthsCleared++;
  }

  // Integritätsprüfung VOR jedem Schreiben: ausschliesslich Monate des
  // Zieljahres dürfen sich geändert haben — sonst Abbruch ohne zu speichern.
  assertYearScopedChanges(before, next, year);

  saveAll(next, storeKey);
  // Supabase-Backup SEQUENZIELL (read→merge→write pro Monat): parallele
  // safeUpserts würden denselben Blob gleichzeitig lesen und sich gegenseitig
  // überschreiben (last-writer-wins → Monatsverlust im KV-Backup).
  const kvBackup = (async () => {
    const failedMonths: string[] = [];
    let lastError: unknown;
    for (const id of touchedIds) {
      try {
        await safeUpsertReportingMonth(id, next[id], storeKey);
      } catch (err) {
        console.error('[REPORTING] replaceAnnualCostYear: safeUpsertReportingMonth fehlgeschlagen', id, err);
        failedMonths.push(id);
        lastError = err;
      }
    }
    // Fehlgeschlagene Monate lokal re-schreiben: nachfolgende erfolgreiche
    // Upserts synchronisieren localStorage mit dem Remote-Stand (remote gewinnt
    // pro Monat) und könnten den fehlgeschlagenen Monat lokal auf den alten
    // Remote-Wert zurückdrehen — «lokal gespeichert» muss aber strikt gelten.
    if (failedMonths.length > 0) {
      try {
        const current = loadAll(storeKey);
        for (const id of failedMonths) current[id] = next[id];
        localStorage.setItem(storeKey, JSON.stringify(current));
      } catch (err) {
        console.error('[REPORTING] replaceAnnualCostYear: lokales Re-Write fehlgeschlagen', err);
      }
      // EIN automatischer Retry (sequenziell, liest den lokalen Stand frisch):
      // transiente Netzwerkfehler sollen nicht sofort beim User landen.
      const retry = await retryReportingMonthsBackup(failedMonths, storeKey);
      return {
        failedMonths: retry.failedMonths,
        lastError: retry.failedMonths.length > 0 ? (retry.lastError ?? lastError) : undefined,
      };
    }
    return { failedMonths, lastError };
  })();

  return { zeilenGeschuetzt, monthsWritten, monthsCleared, monthsUnchanged, kvBackup };
}

/**
 * Upsert der numerischen Konto-Kategorien NUR für die übergebenen Monate
 * (Mehrmonats-Import aus einem Kontoblatt, das nicht das ganze Jahr abdeckt).
 *
 * Unterschied zu replaceAnnualCostYear: Monate OHNE Daten in der Datei werden
 * NICHT angefasst (kein Bereinigen anderer Monate). Innerhalb eines betroffenen
 * Monats gilt Ersetzen: numerische Konto-Kategorien werden komplett durch die
 * Datei ersetzt (idempotent, keine Verdoppelung), manuelle Kategorien und alle
 * anderen Felder bleiben unberührt. Unveränderte Monate: kein Write.
 */
export function upsertCostMonths(
  year: number,
  categoriesByMonth: Map<number, ExpenseCategory[]>,
  opts: { fileName?: string; note?: string; source?: ImportSource; uebernehmen?: ReadonlySet<string> },
  storeKey: string = STORAGE_KEY,
): ReplaceAnnualCostResult {
  const before = loadAll(storeKey);
  const next: Record<string, MonthlyFinancialRecord> = { ...before };
  const now = new Date().toISOString();
  let monthsWritten = 0;
  let monthsUnchanged = 0;
  let zeilenGeschuetzt = 0;
  const touchedIds: string[] = [];

  for (const [month, fileCats] of categoriesByMonth.entries()) {
    if (month < 1 || month > 12) continue;
    const id = monthId(year, month);
    const existing = next[id];
    const merged = mergeProtectedCats(existing?.expenseCategories ?? [], fileCats, month, opts.uebernehmen);
    const newCats = merged.newCats;
    zeilenGeschuetzt += merged.geschuetzt.length;
    const hadNumeric = (existing?.expenseCategories ?? []).some(c => NUMERIC_ACCOUNT_RE.test(c.categoryId));
    if (newCats.length === 0 && merged.geschuetzt.length === 0 && !hadNumeric) continue;

    const rec = existing ?? createEmptyMonth(year, month);
    // Manuell geschützte Konto-Zeilen bleiben IMMER erhalten (Merge-Schutz).
    const keptManual = [
      ...(rec.expenseCategories ?? []).filter(c => !NUMERIC_ACCOUNT_RE.test(c.categoryId)),
      ...merged.geschuetzt,
    ];

    if (existing && sameCategorySet(existing.expenseCategories ?? [], [...keptManual, ...newCats])) {
      monthsUnchanged++;
      continue;
    }

    const importRecord: ImportRecord = {
      importId: uuidv4(),
      importedAt: now,
      source: opts.source ?? 'annual_cost_import',
      mode: 'replace',
      fileName: opts.fileName,
      note: opts.note ?? `Mehrmonats-Kontoblatt ${year}: Konto-Kategorien ersetzt`,
      affectedFields: ['expenseCategories'],
    };

    next[id] = {
      ...rec,
      expenseCategories: [...keptManual, ...newCats],
      imports: [...rec.imports, importRecord],
      updatedAt: now,
    };
    touchedIds.push(id);
    monthsWritten++;
  }

  assertYearScopedChanges(before, next, year);
  saveAll(next, storeKey);

  // KV-Backup SEQUENZIELL (gleiches Muster wie replaceAnnualCostYear).
  const kvBackup = (async () => {
    const failedMonths: string[] = [];
    let lastError: unknown;
    for (const id of touchedIds) {
      try {
        await safeUpsertReportingMonth(id, next[id], storeKey);
      } catch (err) {
        console.error('[REPORTING] upsertCostMonths: safeUpsertReportingMonth fehlgeschlagen', id, err);
        failedMonths.push(id);
        lastError = err;
      }
    }
    if (failedMonths.length > 0) {
      try {
        const current = loadAll(storeKey);
        for (const id of failedMonths) current[id] = next[id];
        localStorage.setItem(storeKey, JSON.stringify(current));
      } catch (err) {
        console.error('[REPORTING] upsertCostMonths: lokales Re-Write fehlgeschlagen', err);
      }
      const retry = await retryReportingMonthsBackup(failedMonths, storeKey);
      return {
        failedMonths: retry.failedMonths,
        lastError: retry.failedMonths.length > 0 ? (retry.lastError ?? lastError) : undefined,
      };
    }
    return { failedMonths, lastError };
  })();

  return { zeilenGeschuetzt, monthsWritten, monthsCleared: 0, monthsUnchanged, kvBackup };
}

/**
 * Entfernt alle numerischen Konto-Kategorien eines Geschäftsjahres
 * (Lösch-Aktion der Import-Verwaltung). Manuelle Kategorien und
 * Direktfelder bleiben erhalten.
 */
export function removeAnnualCostYear(
  year: number,
  opts: { note?: string },
  storeKey: string = STORAGE_KEY,
): ReplaceAnnualCostResult {
  return replaceAnnualCostYear(
    year,
    new Map(),
    {
      note: opts.note ?? `Jahres-Kontoblatt ${year}: Konto-Kategorien entfernt`,
      // Explizites Löschen entfernt bewusst ALLE numerischen Konto-Kategorien —
      // auch manuell erfasste (der Merge-Schutz gilt nur für Imports).
      ignoreManualProtection: true,
    },
    storeKey,
  );
}

/**
 * Gibt an, welche Jahre Daten enthalten.
 * Nützlich für den Jahr-Selector in der UI.
 */
export function availableYears(storeKey: string = STORAGE_KEY): number[] {
  const all = loadAll(storeKey);
  const years = new Set<number>();
  Object.keys(all).forEach(id => {
    const y = parseInt(id.split('-')[0]);
    if (!isNaN(y)) years.add(y);
  });
  const current = new Date().getFullYear();
  years.add(current);
  return Array.from(years).sort((a, b) => b - a); // Neueste zuerst
}

/**
 * Jahre, die tatsächlich Monats-Records enthalten (ohne das automatisch
 * ergänzte laufende Jahr aus availableYears). Für Hinweise wie
 * «Daten der Jahre X, Y bleiben unverändert» beim Jahresimport.
 */
export function yearsWithData(storeKey: string = STORAGE_KEY): number[] {
  const all = loadAll(storeKey);
  const years = new Set<number>();
  Object.keys(all).forEach(id => {
    const y = parseInt(id.split('-')[0]);
    if (!isNaN(y)) years.add(y);
  });
  return Array.from(years).sort((a, b) => a - b);
}

/**
 * Optionen für Jahr-Selektoren: Jahre mit Daten ∪ [aktuell−2 … aktuell+1],
 * aufsteigend sortiert. Macht abgeschlossene Geschäftsjahre (z. B. 2024)
 * wählbar, auch bevor Daten importiert wurden — ohne harte Jahreszahlen.
 */
export function yearSelectOptions(available: number[], current: number): number[] {
  const years = new Set<number>(available);
  for (let y = current - 2; y <= current + 1; y++) years.add(y);
  return Array.from(years).sort((a, b) => a - b);
}

// ─── Aggregationen ────────────────────────────────────────────────────────────

/**
 * Berechnet die Jahresübersicht aus den Monatsdaten.
 * Nur Monate mit tatsächlichen Daten werden einbezogen.
 */
export function calcAnnualSummary(year: number, storeKey: string = STORAGE_KEY): AnnualSummary {
  const months = loadYear(year, storeKey);
  let totalRevenueActual      = 0;
  let totalRevenueBudget      = 0;
  let totalRevenuePreviousYear = 0;
  let totalPersonnelCostActual = 0;
  let totalPersonnelCostPlanned = 0;
  let monthsWithData = 0;

  for (const m of months) {
    const hasData = m.revenueActual !== undefined || m.personnelCostActual !== undefined;
    if (hasData) monthsWithData++;
    totalRevenueActual       += m.revenueActual       ?? 0;
    totalRevenueBudget       += m.revenueBudget       ?? 0;
    totalRevenuePreviousYear += m.revenuePreviousYear ?? 0;
    totalPersonnelCostActual += m.personnelCostActual ?? 0;
    totalPersonnelCostPlanned += m.personnelCostPlanned ?? 0;
  }

  const personnelCostRatio = totalRevenueActual > 0
    ? (totalPersonnelCostActual / totalRevenueActual) * 100
    : 0;

  return {
    year,
    totalRevenueActual,
    totalRevenueBudget,
    totalRevenuePreviousYear,
    totalPersonnelCostActual,
    totalPersonnelCostPlanned,
    personnelCostRatio,
    monthsWithData,
  };
}

// ─── Interne Hilfsfunktion: Kategorie-Merge ───────────────────────────────────

/**
 * Ausgabenkategorien zusammenführen ohne Duplikate.
 *
 * Regel:
 *   - Kategorie existiert bereits → Betrag überschreiben
 *   - Neue Kategorie → anhängen
 *
 * Dies ist der Kern der "update"-Deduplication für Kostenpositionen.
 */
function mergeExpenseCategories(
  existing: { categoryId: string; label: string; amount: number }[],
  incoming: { categoryId: string; label: string; amount: number }[],
): { categoryId: string; label: string; amount: number }[] {
  const map = new Map(existing.map(e => [e.categoryId, { ...e }]));
  for (const item of incoming) {
    map.set(item.categoryId, { ...item }); // Überschreiben oder neu einfügen
  }
  return Array.from(map.values());
}

// ─── Sage Buchungsjournal ─────────────────────────────────────────────────────

const JOURNAL_KEY = 'sage_journal_v1';

/**
 * Journal-Key, mandantenfähig: Oliv bleibt aus historischen Gründen OHNE
 * Präfix (`sage_journal_v1_*`, alle Alt-Importe), andere Mandanten (Beaulieu)
 * erhalten das übliche Tenant-Präfix (`beaulieu:sage_journal_v1_*`).
 */
function journalMonthKey(year: number, month: number, tenantId: string = 'oliv'): string {
  const base = `${JOURNAL_KEY}_${year}_${String(month).padStart(2, '0')}`;
  return tenantId === 'oliv' ? base : `${tenantId}:${base}`;
}

/**
 * Buchungszeilen für einen Monat speichern.
 * Schreibt immer nach localStorage UND Supabase (fire-and-forget).
 */
export function saveJournalEntries(
  year: number,
  month: number,
  entries: SageJournalEntry[],
  mode: ImportMode = 'replace',
  tenantId: string = 'oliv',
): void {
  const key = journalMonthKey(year, month, tenantId);
  let final: SageJournalEntry[];
  if (mode === 'replace') {
    final = entries;
  } else {
    final = [...loadJournalEntries(year, month, tenantId), ...entries];
  }
  localStorage.setItem(key, JSON.stringify(final));
  // kvSetStrict statt kvSet: Backup-Fehler dürfen nie still verschluckt werden (T007).
  // Offline/nicht konfiguriert → dezenter Hinweis; echter Fehler → Fehler-Toast + Retry.
  kvSetStrict(key, final).catch(err => {
    console.error(`[Journal] KV-Backup fehlgeschlagen: ${key}`, err);
    void notifyKVBackupProblem(err, 'Buchungszeilen', {
      toastId: 'journal-kv-failed',
      // Beim Retry FRISCH aus localStorage lesen — kein eingefrorener Snapshot,
      // sonst würde ein inzwischen neuerer Save zurückgedreht. Der Key ist zur
      // Save-Zeit gebunden und bleibt nach Tenant-/Monatswechsel korrekt.
      retry: () => {
        let fresh: SageJournalEntry[] = final;
        try {
          fresh = JSON.parse(localStorage.getItem(key) ?? '[]') as SageJournalEntry[];
        } catch { /* localStorage unlesbar → Snapshot als letzter Fallback */ }
        return kvSetStrict(key, fresh);
      },
    });
  });
  console.log(`[Journal] Gespeichert: ${key} (${final.length} Einträge) → localStorage + Supabase`);
}

/**
 * Strikte Variante für Undo/Restore: schreibt localStorage UND wartet auf das
 * Supabase-KV-Backup; wirft bei Backup-Fehlern (Aufrufer meldet dann Misserfolg,
 * statt einen halb wiederhergestellten Zustand als Erfolg zu verbuchen).
 */
export async function saveJournalEntriesStrict(
  year: number,
  month: number,
  entries: SageJournalEntry[],
  tenantId: string = 'oliv',
): Promise<void> {
  const key = journalMonthKey(year, month, tenantId);
  localStorage.setItem(key, JSON.stringify(entries));
  await kvSetStrict(key, entries);
  console.log(`[Journal] Strikt wiederhergestellt: ${key} (${entries.length} Einträge)`);
}

/**
 * Buchungszeilen für einen Monat aus localStorage laden (sync, sofort).
 */
export function loadJournalEntries(year: number, month: number, tenantId: string = 'oliv'): SageJournalEntry[] {
  const key = journalMonthKey(year, month, tenantId);
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
}

/**
 * Buchungszeilen für einen Monat aus Supabase laden (async).
 * Führt einmalige Auto-Migration durch wenn Supabase leer ist aber localStorage Daten hat.
 */
export async function loadJournalEntriesFromDB(year: number, month: number, tenantId: string = 'oliv'): Promise<SageJournalEntry[]> {
  const key = journalMonthKey(year, month, tenantId);
  try {
    const remote = await kvGet(key);
    if (remote !== null && Array.isArray(remote) && (remote as SageJournalEntry[]).length > 0) {
      const entries = remote as SageJournalEntry[];
      localStorage.setItem(key, JSON.stringify(entries));
      console.log(`[Journal] Aus Supabase geladen: ${key} (${entries.length} Einträge)`);
      return entries;
    }
    // Supabase leer — localStorage prüfen und ggf. migrieren
    const local = loadJournalEntries(year, month, tenantId);
    if (local.length > 0) {
      console.log(`[Journal] Supabase leer – sync localStorage→Supabase: ${key} (${local.length} Einträge)`);
      kvSet(key, local).catch(err => console.error(`[Journal] Auto-Migration nach Supabase fehlgeschlagen: ${key}`, err));
    } else {
      console.log(`[Journal] Keine Daten: ${key}`);
    }
    return local;
  } catch (err) {
    console.error(`[Journal] loadJournalEntriesFromDB Fehler: ${key}`, err);
    return loadJournalEntries(year, month, tenantId);
  }
}

/**
 * Buchungszeilen für ein ganzes Jahr laden (alle 12 Monate, sync).
 */
export function loadJournalYear(year: number, tenantId: string = 'oliv'): SageJournalEntry[] {
  const all: SageJournalEntry[] = [];
  for (let m = 1; m <= 12; m++) {
    all.push(...loadJournalEntries(year, m, tenantId));
  }
  return all;
}

/**
 * Ganzes Journal-Jahr aus Supabase laden und in localStorage synchronisieren.
 * Für Auto-Migration beim Seitenaufruf.
 */
export async function syncJournalYearFromDB(year: number, tenantId: string = 'oliv'): Promise<void> {
  for (let m = 1; m <= 12; m++) {
    await loadJournalEntriesFromDB(year, m, tenantId);
  }
}

// ─── Formatierungshilfen ──────────────────────────────────────────────────────

export function formatCHF(value: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatMonthLabel(year: number, month: number): string {
  return `${MONTH_NAMES_DE[month]} ${year}`;
}
