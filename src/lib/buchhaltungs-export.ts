/**
 * Buchhaltungs-Export-Assistent (/tagesabschluesse) — REINE Logik
 * =============================================================================
 * Checkliste der Export-Voraussetzungen (§2), Monatsprüfung-Totale (§3),
 * Buchungsvorschau (§4), Export-Historie/-Protokoll mit Versionierung (§7/§8),
 * „Export veraltet"-Erkennung (§10) und Statusableitung für die
 * Import-Cockpit-Kontrollaufgabe (§11).
 *
 * Persistenz: KEINE Migration — Protokolle leben als write-once-Records im
 * bestehenden Blob `tagesabschluss_v1` (`exportProtokolle`, merge-on-save =
 * Union je Export-ID, s. mergeTagesabschlussBlobs).
 *
 * VERALTET-ERKENNUNG: deterministischer FNV-1a-Fingerprint über den
 * monatsbezogenen Datenstand (updatedAt-Stände aller Monats-Einträge) —
 * bewusst KEIN Zeitvergleich (`exportedAt < jüngste Mutation`), weil der
 * bei Clock-Skew zwischen Geräten UND bei merge-on-save-Nachzüglern
 * (ein später gemergter Eintrag kann ein ÄLTERES updatedAt tragen) versagt.
 * exportSettings fliessen NICHT in den Fingerprint ein (eine Mapping-Änderung
 * invalidiert keinen bereits erstellten Export).
 */

import {
  type TagesabschlussBlob,
  type TagesabschlussMonth,
  type BuchhaltungsExportRecord,
  isMonthClosed,
} from './tagesabschluss';
import { type Tabelle2Row, type Tabelle2Kategorie } from './tagesabschluss-export';

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ── Fingerprint (Veraltet-Erkennung, §10) ────────────────────────────────────

/** FNV-1a 32-Bit als 8-stelliger Hex-String. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Datumsteil (yyyy-MM-dd) eines `date:field`-Schlüssels. */
const keyDate = (key: string): string => key.slice(0, 10);

/**
 * Deterministischer Fingerprint des monatsbezogenen Blob-Datenstands.
 * Einbezogen: Tageswerte, Barausgaben, Korrekturen, Kommentare,
 * Differenzgründe, Anfangsbestand des Monats, Tages- und Monatsabschlüsse
 * (inkl. Status + Historienlänge — Wiederöffnen ändert den Fingerprint).
 * NICHT einbezogen: exportSettings, exportProtokolle.
 */
export function computeMonthFingerprint(blob: TagesabschlussBlob, monthKey: string): string {
  const inMonth = (date: string): boolean => date.startsWith(`${monthKey}-`);
  const parts: string[] = [];

  for (const [date, day] of Object.entries(blob.days)) {
    if (inMonth(date)) parts.push(`day:${date}:${day.updatedAt}`);
  }
  for (const [date, list] of Object.entries(blob.expenses)) {
    if (!inMonth(date)) continue;
    for (const e of list) parts.push(`exp:${e.id}:${e.updatedAt}`);
  }
  for (const [key, ov] of Object.entries(blob.overrides)) {
    if (inMonth(keyDate(key))) parts.push(`ov:${key}:${ov.updatedAt}`);
  }
  for (const [key, c] of Object.entries(blob.comments)) {
    if (inMonth(keyDate(key))) parts.push(`cm:${key}:${c.updatedAt}`);
  }
  for (const [date, entry] of Object.entries(blob.cashDiffReasons)) {
    if (inMonth(date)) parts.push(`cdr:${date}:${entry.updatedAt}`);
  }
  const anf = blob.anfangsbestand[monthKey];
  if (anf) parts.push(`anf:${monthKey}:${anf.value}:${anf.updatedAt}`);
  for (const [date, cl] of Object.entries(blob.abschluesse)) {
    if (inMonth(date)) parts.push(`cl:${date}:${cl.status}:${cl.updatedAt}:${cl.history.length}`);
  }
  const mc = blob.monatsabschluesse[monthKey];
  if (mc) parts.push(`mc:${monthKey}:${mc.status}:${mc.updatedAt}`);

  parts.sort();
  return fnv1a(parts.join('\n'));
}

// ── Checkliste der Export-Voraussetzungen (§2) ───────────────────────────────

export interface ExportChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  /** Menschentauglicher Zusatz (Zählung/Begründung), auch wenn ok. */
  detail: string;
}

/**
 * Prüft alle Export-Voraussetzungen. Der Export ist NUR erlaubt, wenn jedes
 * Item ok ist (`exportChecklistOk`). Reihenfolge = Anzeige-Reihenfolge.
 */
export function buildExportChecklist(
  month: TagesabschlussMonth,
  blob: TagesabschlussBlob,
  monthKey: string,
): ExportChecklistItem[] {
  const t = month.totals;
  const zRows = month.rows.filter(r => r.hasZbericht);
  const unclosedZ = zRows.filter(r => !r.locked);
  const adyenUnchecked = month.rows.filter(r =>
    r.hasAdyen && r.adyenDiffStatus !== null && r.adyenDiffStatus !== 'ok'
    && r.confirmation?.confirmed !== true,
  );
  const monthClosed = isMonthClosed(blob, monthKey);

  return [
    {
      key: 'anfangsbestand',
      label: 'Anfangsbestand vorhanden',
      ok: month.startSaldo !== null,
      detail: month.startSaldo !== null
        ? `Kassensaldo Anfang: ${month.startSaldo.toFixed(2)}`
        : 'Kassen-Anfangsbestand fehlt — über der Monatsübersicht erfassen.',
    },
    {
      key: 'zberichte',
      label: 'Z-Berichte vollständig',
      ok: t.daysWithZbericht > 0,
      detail: t.daysWithZbericht > 0
        ? `${t.daysWithZbericht} Tag(e) mit Z-Bericht.`
        : 'Keine Z-Berichte im Monat importiert.',
    },
    {
      key: 'alle_tage_abgeschlossen',
      label: 'Alle Tage abgeschlossen',
      ok: t.daysWithZbericht > 0 && unclosedZ.length === 0,
      detail: unclosedZ.length === 0
        ? 'Jeder Z-Bericht-Tag ist definitiv abgeschlossen.'
        : `${unclosedZ.length} Tag(e) noch nicht abgeschlossen.`,
    },
    {
      key: 'keine_offenen_tage',
      label: 'Keine offenen Tage',
      ok: t.daysOpen === 0 && t.daysInBearbeitung === 0 && t.daysWiederGeoeffnet === 0,
      detail: t.daysOpen === 0 && t.daysInBearbeitung === 0 && t.daysWiederGeoeffnet === 0
        ? 'Kein offener, in Bearbeitung befindlicher oder wieder geöffneter Tag.'
        : `Offen: ${t.daysOpen}, in Bearbeitung: ${t.daysInBearbeitung}, wieder geöffnet: ${t.daysWiederGeoeffnet}.`,
    },
    {
      key: 'keine_unbegruendeten_differenzen',
      label: 'Keine unbegründeten Differenzen',
      ok: t.daysUnbegruendet === 0,
      detail: t.daysUnbegruendet === 0
        ? 'Alle Kassendifferenzen sind grün oder begründet.'
        : `${t.daysUnbegruendet} Tag(e) mit unbegründeter Kassendifferenz.`,
    },
    {
      key: 'kassensaldo_plausibel',
      label: 'Kassensaldo plausibel',
      ok: month.endSaldo !== null && t.daysNeedsReview === 0,
      detail: month.endSaldo === null
        ? 'Kassensaldo Ende unbekannt (Anfangsbestand fehlt).'
        : t.daysNeedsReview > 0
          ? `${t.daysNeedsReview} abgeschlossene(r) Tag(e) mit abweichendem Saldo — überprüfen.`
          : `Kassensaldo Ende: ${month.endSaldo.toFixed(2)}`,
    },
    {
      key: 'adyen_geprueft',
      label: 'Adyen-Abgleiche geprüft oder begründet',
      ok: adyenUnchecked.length === 0,
      detail: adyenUnchecked.length === 0
        ? 'Alle Adyen-Differenzen sind grün, übersteuert oder bestätigt.'
        : `${adyenUnchecked.length} Tag(e) mit ungeprüfter Adyen-Differenz.`,
    },
    {
      key: 'monatsabschluss',
      label: 'Monatsabschluss erstellt',
      ok: monthClosed,
      detail: monthClosed
        ? 'Monat ist definitiv abgeschlossen.'
        : 'Monat noch nicht abgeschlossen — zuerst den Monatsabschluss erstellen.',
    },
  ];
}

/** Export erlaubt = JEDES Checklisten-Item ok. */
export function exportChecklistOk(items: readonly ExportChecklistItem[]): boolean {
  return items.length > 0 && items.every(i => i.ok);
}

// ── Monatsprüfung (§3) ───────────────────────────────────────────────────────

export interface MonatspruefungItem {
  key: string;
  label: string;
  /** CHF; null = unbekannt (z. B. Saldo ohne Anfangsbestand) → „—". */
  value: number | null;
}

/** Die 9 Monats-Totale der Monatsprüfung, in Anzeige-Reihenfolge. */
export function buildMonatspruefung(month: TagesabschlussMonth): MonatspruefungItem[] {
  const v = month.totals.values;
  return [
    { key: 'umsatz', label: 'Umsatz Total', value: round2(v.umsatz) },
    { key: 'kreditkarten', label: 'Kreditkarten Total (inkl. TWINT)', value: round2(v.karten + v.twint) },
    { key: 'debitoren', label: 'Debitoren Total', value: round2(v.rechnung) },
    { key: 'barausgaben', label: 'Barausgaben Total', value: round2(month.totals.barausgaben) },
    { key: 'gutscheine_verkauft', label: 'Verkaufte Gutscheine', value: round2(v.gutscheinVerkauft) },
    { key: 'gutscheine_eingeloest', label: 'Eingelöste Gutscheine', value: round2(v.gutscheinEingeloest) },
    { key: 'einzahlung_bank', label: 'Einzahlung Bank', value: round2(v.einzahlungBank) },
    { key: 'saldo_anfang', label: 'Kassensaldo Anfang', value: month.startSaldo },
    { key: 'saldo_ende', label: 'Kassensaldo Ende', value: month.endSaldo },
  ];
}

// ── Buchungsvorschau (§4) ────────────────────────────────────────────────────

export const VORSCHAU_KATEGORIE_LABEL: Record<Tabelle2Kategorie, string> = {
  barumsatz: 'Barumsatz (Kasse)',
  kreditkarten: 'Kreditkarten',
  twint: 'TWINT',
  debitoren: 'Debitoren',
  weitere_zahlungsarten: 'Weitere Zahlungsarten (KD Tisch & Co.)',
  gutschein_verkauft: 'Verkaufte Gutscheine',
  gutschein_eingeloest: 'Eingelöste Gutscheine',
  barausgabe: 'Barausgaben',
  bank: 'Bankeinzahlungen',
};

/** Anzeige-Reihenfolge der Vorschau-Bereiche (Brutto-Modell, Spec §4). */
export const VORSCHAU_KATEGORIEN: readonly Tabelle2Kategorie[] = [
  'barumsatz', 'kreditkarten', 'twint', 'debitoren', 'weitere_zahlungsarten',
  'gutschein_verkauft', 'gutschein_eingeloest', 'barausgabe', 'bank',
];

export interface VorschauGruppe {
  kategorie: Tabelle2Kategorie;
  label: string;
  anzahl: number;
  netto: number;
  steuer: number;
  brutto: number;
}

export interface Buchungsvorschau {
  gruppen: VorschauGruppe[];
  /** Summe aller Beträge (Brutto-Modell: identisch mit bruttoTotal). */
  nettoTotal: number;
  /** LEGACY: seit dem Brutto-Modell immer 0 (keine MWST-Buchungen mehr). */
  mwstTotal: number;
  /** Summe aller Buchungsbeträge (brutto). */
  bruttoTotal: number;
  /** Gesamtzahl der Buchungszeilen. */
  anzahlBuchungen: number;
}

/**
 * Aggregiert die Tabelle2-Zeilen zur Buchungsvorschau — es wird KEINE Datei
 * erzeugt. Gruppierung über die strukturell gesetzte `kategorie` (nie über
 * Kontonummern/Texte rückwärts klassifiziert).
 */
export function summarizeBuchungsvorschau(rows: readonly Tabelle2Row[]): Buchungsvorschau {
  const byKat = new Map<Tabelle2Kategorie, { anzahl: number; netto: number; steuer: number }>();
  for (const kat of VORSCHAU_KATEGORIEN) byKat.set(kat, { anzahl: 0, netto: 0, steuer: 0 });
  for (const r of rows) {
    const g = byKat.get(r.kategorie);
    if (!g) continue;
    g.anzahl += 1;
    g.netto += r.netto;
    g.steuer += r.steuer;
  }
  const gruppen: VorschauGruppe[] = VORSCHAU_KATEGORIEN.map(kat => {
    const g = byKat.get(kat) as { anzahl: number; netto: number; steuer: number };
    return {
      kategorie: kat,
      label: VORSCHAU_KATEGORIE_LABEL[kat],
      anzahl: g.anzahl,
      netto: round2(g.netto),
      steuer: round2(g.steuer),
      brutto: round2(g.netto + g.steuer),
    };
  });
  const nettoTotal = round2(rows.reduce((s, r) => s + r.netto, 0));
  const mwstTotal = round2(rows.reduce((s, r) => s + r.steuer, 0));
  return {
    gruppen,
    nettoTotal,
    mwstTotal,
    bruttoTotal: round2(nettoTotal + mwstTotal),
    anzahlBuchungen: rows.length,
  };
}

// ── Export-Historie / Protokoll (§7/§8) ──────────────────────────────────────

/** Alle Export-Protokolle eines Monats, chronologisch (älteste zuerst). */
export function exportsForMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportRecord[] {
  return Object.values(blob.exportProtokolle)
    .filter(r => r.monat === monthKey)
    .sort((a, b) => a.exportedAt.localeCompare(b.exportedAt) || a.version - b.version);
}

/** Jüngstes Export-Protokoll eines Monats (null = noch nie exportiert). */
export function latestExportForMonth(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportRecord | null {
  const list = exportsForMonth(blob, monthKey);
  return list.length > 0 ? list[list.length - 1] : null;
}

/** Nächste Versionsnummer eines Monats: max(vorhandene Versionen) + 1. */
export function nextExportVersion(blob: TagesabschlussBlob, monthKey: string): number {
  const versions = exportsForMonth(blob, monthKey).map(r => r.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/**
 * Erstellt das Protokoll eines soeben erzeugten Exports (write-once):
 * Export-ID, Version (fortlaufend je Monat), Benutzer, Zeitstempel, Anzahl
 * Buchungen, Kassensaldo Ende und Fingerprint des AKTUELLEN Datenstands.
 */
export function createExportRecord(params: {
  blob: TagesabschlussBlob;
  monthKey: string;
  user: string;
  now: string; // ISO
  anzahlBuchungen: number;
  kassensaldoEnde: number | null;
}): BuchhaltungsExportRecord {
  const { blob, monthKey, user, now, anzahlBuchungen, kassensaldoEnde } = params;
  const version = nextExportVersion(blob, monthKey);
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    id: `exp-${monthKey}-v${version}-${rand}`,
    monat: monthKey,
    version,
    exportedAt: now,
    exportedBy: user,
    anzahlBuchungen,
    kassensaldoEnde,
    fingerprint: computeMonthFingerprint(blob, monthKey),
    updatedAt: now,
  };
}

/** Fügt ein Export-Protokoll immutabel in den Blob ein. */
export function addExportRecord(
  blob: TagesabschlussBlob,
  record: BuchhaltungsExportRecord,
): TagesabschlussBlob {
  return { ...blob, exportProtokolle: { ...blob.exportProtokolle, [record.id]: record } };
}

// ── Statusableitung (§10/§11) ────────────────────────────────────────────────

export type BuchhaltungsExportStatus = 'offen' | 'bereit' | 'exportiert' | 'veraltet';

export const EXPORT_STATUS_LABEL: Record<BuchhaltungsExportStatus, string> = {
  offen: 'Offen',
  bereit: 'Bereit für Export',
  exportiert: 'Exportiert',
  veraltet: 'Export veraltet',
};

/**
 * Status des Buchhaltungs-Exports eines Monats — rein aus dem Blob ableitbar
 * (auch synchron aus localStorage für die Import-Cockpit-Kontrollaufgabe):
 *  - veraltet:   es gibt einen Export, aber der Monats-Datenstand hat sich
 *                seither geändert (Fingerprint-Mismatch, §10)
 *  - exportiert: jüngster Export entspricht dem aktuellen Datenstand
 *  - bereit:     Monat definitiv abgeschlossen, noch kein Export
 *  - offen:      sonst
 */
export function deriveExportStatus(
  blob: TagesabschlussBlob,
  monthKey: string,
): BuchhaltungsExportStatus {
  const latest = latestExportForMonth(blob, monthKey);
  if (latest) {
    return latest.fingerprint === computeMonthFingerprint(blob, monthKey)
      ? 'exportiert'
      : 'veraltet';
  }
  return isMonthClosed(blob, monthKey) ? 'bereit' : 'offen';
}

/**
 * Jüngster Monat (yyyy-MM) mit Tagesabschluss-Aktivität — Bezugsmonat für die
 * Import-Cockpit-Kontrollaufgabe (§11). Betrachtet manuelle Tageswerte,
 * Barausgaben, Tages-/Monatsabschlüsse und Export-Protokolle; null = keinerlei
 * Daten (Cockpit zeigt dann „nie").
 */
export function latestRelevantExportMonth(blob: TagesabschlussBlob): string | null {
  const months = new Set<string>();
  const addDate = (date: string): void => {
    if (/^\d{4}-\d{2}/.test(date)) months.add(date.slice(0, 7));
  };
  for (const d of Object.keys(blob.days)) addDate(d);
  // blob.expenses ist Record<Datum, CashExpense[]> — der SCHLÜSSEL ist das Datum.
  for (const [date, list] of Object.entries(blob.expenses)) {
    if (list.length > 0) addDate(date);
  }
  for (const d of Object.keys(blob.abschluesse)) addDate(d);
  for (const m of Object.keys(blob.monatsabschluesse)) {
    if (/^\d{4}-\d{2}$/.test(m)) months.add(m);
  }
  for (const r of Object.values(blob.exportProtokolle)) {
    if (/^\d{4}-\d{2}$/.test(r.monat)) months.add(r.monat);
  }
  if (months.size === 0) return null;
  return [...months].sort().at(-1)!;
}
