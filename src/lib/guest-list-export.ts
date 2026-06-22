/**
 * Export der Gäste-Liste (reine Logik, KEINE DOM/ExcelJS-Abhängigkeit)
 * =============================================================================
 * Bildet die aktuell sichtbaren Spalten der Gäste-Liste (`/gaeste`) als
 * typisierte Export-Zellen ab — Datumswerte als `Date`, Zahlen als Zahlen.
 * Exportiert wird stets nur die übergebene (bereits gefilterte/sortierte) Liste.
 */

import { SEGMENT_LABEL, type GuestListMetrics } from './reservation-crm';
import { isoToDate, type ExportCell, type ExportTable } from './export-cell';

/** Spaltenüberschriften (deutsch) in fester Reihenfolge. */
export const GUEST_LIST_EXPORT_HEADERS: string[] = [
  'Name',
  'E-Mail',
  'Telefon',
  'Segment',
  'Firma',
  'Geburtstag',
  'Besuche',
  'Ø Gruppengröße',
  'Erster Besuch',
  'Letzter Besuch',
  'Ø Intervall (Tage)',
  'Tage seit letztem Besuch',
  'VIP (manuell)',
  'Stammgast (manuell)',
  'Firmenkunde',
  'Newsletter',
  'Sperrliste',
  'Allergien',
];

/** Eine Gästezeile als typisierte Zellen (Reihenfolge = `GUEST_LIST_EXPORT_HEADERS`). */
export function guestListRowToCells(m: GuestListMetrics): ExportCell[] {
  const crm = m.crm ?? null;
  return [
    m.displayName,
    m.email ?? null,
    m.mobile ?? null,
    SEGMENT_LABEL[m.segment],
    crm?.company ?? null,
    isoToDate(crm?.birthday ?? null),
    m.visits,
    m.avgPartySize === null ? null : Math.round(m.avgPartySize * 10) / 10,
    isoToDate(m.firstVisit),
    isoToDate(m.lastVisit),
    m.avgDaysBetweenVisits === null ? null : Math.round(m.avgDaysBetweenVisits),
    m.daysSinceLastVisit,
    crm?.vipManual ? 'Ja' : '',
    crm?.stammgastManual ? 'Ja' : '',
    crm?.companyCustomer ? 'Ja' : '',
    crm?.newsletterOptIn ? 'Ja' : '',
    crm?.blockedGuest ? 'Ja' : '',
    crm?.allergies ?? null,
  ];
}

/** Baut eine `ExportTable` (CSV/Excel) aus der gefilterten Gäste-Liste. */
export function guestListExportTable(rows: GuestListMetrics[]): ExportTable {
  return {
    filename: 'gaeste-liste',
    sheetName: 'Gäste',
    headers: GUEST_LIST_EXPORT_HEADERS.slice(),
    rows: rows.map(guestListRowToCells),
  };
}
