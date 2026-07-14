/**
 * Export der Gäste-Liste (reine Logik, KEINE DOM/ExcelJS-Abhängigkeit)
 * =============================================================================
 * Exportiert genau die aktuell SICHTBAREN Spalten der Gäste-Liste (`/gaeste`) als
 * typisierte Export-Zellen — Datumswerte als `Date`, Zahlen als Zahlen. Es wird
 * stets nur die übergebene (bereits gefilterte/sortierte) Liste exportiert.
 *
 * Spalten-Mapping = 1 Spalte → 1 Zelle, mit EINER dokumentierten Ausnahme:
 * die Spalte `name` ("Gast") expandiert zu DREI Export-Spalten Name/E-Mail/Telefon,
 * damit Kontaktdaten im CSV/Excel getrennt nutzbar sind.
 */

import { SEGMENT_LABEL, returnRiskRatio, type GuestListMetrics } from './reservation-crm';
import { isoToDate, type ExportCell, type ExportTable } from './export-cell';
import { GUEST_COLUMNS, type GuestColumnKey } from './guest-list-columns';

interface ColumnExport {
  /** Eine oder (nur bei `name`) mehrere Überschriften. */
  headers: string[];
  /** Liefert genau so viele Zellen wie `headers`. */
  cells: (m: GuestListMetrics) => ExportCell[];
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Export-Definition je Spalte (Reihenfolge folgt der sichtbaren Auswahl). */
const COLUMN_EXPORT: Record<GuestColumnKey, ColumnExport> = {
  name: {
    headers: ['Name', 'E-Mail', 'Telefon'],
    cells: m => [m.displayName, m.email ?? null, m.mobile ?? null],
  },
  segment:         { headers: ['Segment'],                  cells: m => [SEGMENT_LABEL[m.segment]] },
  company:         { headers: ['Firma'],                    cells: m => [m.crm?.company ?? null] },
  birthday:        { headers: ['Geburtstag'],               cells: m => [isoToDate(m.crm?.birthday ?? null)] },
  visits:          { headers: ['Besuche'],                  cells: m => [m.visits] },
  partySize:       { headers: ['Ø Gruppengröße'],           cells: m => [round1(m.avgPartySize)] },
  firstVisit:      { headers: ['Erster Besuch'],            cells: m => [isoToDate(m.firstVisit)] },
  lastVisit:       { headers: ['Letzter Besuch'],           cells: m => [isoToDate(m.lastVisit)] },
  interval:        { headers: ['Ø Intervall (Tage)'],       cells: m => [m.avgDaysBetweenVisits === null ? null : Math.round(m.avgDaysBetweenVisits)] },
  sinceLast:       { headers: ['Tage seit letztem Besuch'], cells: m => [m.daysSinceLastVisit] },
  returnRisk:      { headers: ['Rückkehr-Risiko'],          cells: m => [round1(returnRiskRatio(m))] },
  vipManual:       { headers: ['VIP (manuell)'],            cells: m => [m.crm?.vipManual ? 'Ja' : ''] },
  stammgastManual: { headers: ['Stammgast (manuell)'],      cells: m => [m.crm?.stammgastManual ? 'Ja' : ''] },
  companyCustomer: { headers: ['Firmenkunde'],              cells: m => [m.crm?.companyCustomer ? 'Ja' : ''] },
  newsletter:      { headers: ['Newsletter'],               cells: m => [m.crm?.newsletterOptIn ? 'Ja' : ''] },
  blocked:         { headers: ['Sperrliste'],               cells: m => [m.crm?.blockedGuest ? 'Ja' : ''] },
};

/** Überschriften für die sichtbaren Spalten (kanonische Reihenfolge der Auswahl). */
export function guestListExportHeaders(visible: GuestColumnKey[]): string[] {
  return visible.flatMap(k => COLUMN_EXPORT[k].headers);
}

/** Eine Gästezeile als typisierte Zellen — nur für die sichtbaren Spalten. */
export function guestListRowToCells(m: GuestListMetrics, visible: GuestColumnKey[]): ExportCell[] {
  return visible.flatMap(k => COLUMN_EXPORT[k].cells(m));
}

/** Baut eine `ExportTable` (CSV/Excel) aus der gefilterten Gäste-Liste + Spaltenauswahl. */
export function guestListExportTable(rows: GuestListMetrics[], visible: GuestColumnKey[]): ExportTable {
  return {
    filename: 'gaeste-liste',
    sheetName: 'Gäste',
    headers: guestListExportHeaders(visible),
    rows: rows.map(m => guestListRowToCells(m, visible)),
  };
}

/** Alle Spalten in kanonischer Reihenfolge — Komfort für „alles exportieren". */
export const ALL_EXPORT_COLUMNS: GuestColumnKey[] = GUEST_COLUMNS.map(c => c.key);
