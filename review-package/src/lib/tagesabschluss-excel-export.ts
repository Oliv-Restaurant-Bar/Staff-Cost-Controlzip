/**
 * Excel-Export (.xlsx) der Tagesabschluss-Übersicht — zusätzlich zum
 * Buchhaltungs-Export (CSV). Exportiert die buchungsrelevanten Spalten der
 * Übersicht mit EFFEKTIVWERTEN (DayCell.value = korrigiert > manuell > auto);
 * Tombstones sind bereits upstream in buildTagesabschlussRows gefiltert.
 *
 * Aufbau: reine Datenaufbereitung (buildTagesabschlussExcelData — synthetisch
 * testbar, keine XLSX-/DOM-Abhängigkeit) + dünner Workbook-Builder. Datum wird
 * als ECHTE Excel-Datumszelle geschrieben (deterministische UTC-Serial-Zahl,
 * kein cellDates/Timezone-Risiko), Beträge als echte Zahlen mit Zahlenformat.
 */
import * as XLSX from 'xlsx';
import {
  TAGESABSCHLUSS_FIELD_LABEL,
  cashDiffReasonLabel,
  type TagesabschlussMonth,
  type TagesabschlussRow,
  type TagesabschlussField,
} from './tagesabschluss';

export const TAGESABSCHLUSS_EXCEL_HEADERS = [
  'Datum',
  'Umsatz',
  'Bargeld Soll',
  'Kassensaldo Soll',
  'KK Adyen',
  'Barausgaben',
  'Debitoren',
  'Verkaufte Gutscheine',
  'Eingelöste Gutscheine',
  'Einzahlung Bank',
  'Kassendifferenz',
  'Kommentar',
] as const;

/** Zellwert der Datenaufbereitung: Datum als yyyy-MM-dd-String (Spalte 0). */
export type TagesabschlussExcelCell = string | number | null;

export interface TagesabschlussExcelData {
  header: string[];
  /** Eine Zeile je exportiertem Tag (Tage mit Status „fehlt" ausgelassen). */
  rows: TagesabschlussExcelCell[][];
  /** Summenzeile („Total"); Kassensaldo Soll = Monatsend-Saldo (kein Summenwert). */
  totalsRow: TagesabschlussExcelCell[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * „KK Adyen" mit der Doppelsemantik der Übersichts-Spalte: bei karten-Override
 * der EFFEKTIVE Z-KK-Wert (karten + TWINT), sonst das Adyen-Import-Total
 * (effektiv inkl. Adyen-Overrides). null = weder Override noch Adyen-Import.
 */
export function excelKkAdyenValue(row: TagesabschlussRow): number | null {
  if (row.cells.karten.source === 'corrected') {
    if (row.cells.karten.value === null && row.cells.twint.value === null) return null;
    return round2((row.cells.karten.value ?? 0) + (row.cells.twint.value ?? 0));
  }
  return row.adyenTotal;
}

/** Kassensaldo Soll wie in der Tabelle: gesperrte Tage zeigen den FIXIERTEN Saldo. */
export function excelKassensaldoValue(row: TagesabschlussRow): number | null {
  return row.locked && row.fixedKassensaldo !== null ? row.fixedKassensaldo : row.kassensaldoSoll;
}

/** Feste Reihenfolge für Feld-Kommentare in der Kommentar-Spalte. */
const COMMENT_FIELD_ORDER: readonly TagesabschlussField[] = [
  'umsatz', 'karten', 'twint', 'rechnung', 'gutscheinVerkauft',
  'gutscheinEingeloest', 'bestandKasse', 'einzahlungBank', 'bar',
  'netto', 'mwst', 'trinkgeld',
];

/**
 * Kommentar-Spalte: Tages-Bemerkung + Feld-Kommentare („Label: Text") +
 * Kassendifferenz-Begründung (Gründe + Notiz). Tombstone-Kommentare tauchen
 * hier nie auf (buildCell filtert deleted). null = kein Kommentar.
 */
export function excelKommentar(row: TagesabschlussRow): string | null {
  const parts: string[] = [];
  const bemerkung = row.bemerkung?.trim();
  if (bemerkung) parts.push(bemerkung);
  for (const field of COMMENT_FIELD_ORDER) {
    const comment = row.cells[field]?.comment?.trim();
    if (comment) parts.push(`${TAGESABSCHLUSS_FIELD_LABEL[field]}: ${comment}`);
  }
  if (row.cashDiffReasons.length > 0 || row.cashDiffNote?.trim()) {
    const reasons = row.cashDiffReasons.map(cashDiffReasonLabel);
    const note = row.cashDiffNote?.trim();
    const text = [reasons.join(', '), note].filter(Boolean).join(' — ');
    if (text) parts.push(`Kassendifferenz: ${text}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/** Summe einer Spalte über die Datenzeilen; null, wenn KEIN Wert vorhanden. */
function sumColumn(rows: TagesabschlussExcelCell[][], idx: number): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    const v = r[idx];
    if (typeof v === 'number') { sum += v; any = true; }
  }
  return any ? round2(sum) : null;
}

/**
 * Reine Datenaufbereitung: Header + eine Zeile je Tag mit Daten (Status
 * „fehlt" wird ausgelassen) + Summenzeile. Zahlen bleiben Zahlen (null =
 * leere Zelle), Datum als yyyy-MM-dd-String — der Workbook-Builder macht
 * daraus eine echte Excel-Datumszelle.
 */
export function buildTagesabschlussExcelData(month: TagesabschlussMonth): TagesabschlussExcelData {
  const rows: TagesabschlussExcelCell[][] = [];
  for (const row of month.rows) {
    if (row.status === 'fehlt') continue;
    rows.push([
      row.date,
      row.cells.umsatz.value,
      row.bargeldSoll,
      excelKassensaldoValue(row),
      excelKkAdyenValue(row),
      row.barausgabenTotal !== 0 || row.expenseCount > 0 ? round2(row.barausgabenTotal) : null,
      row.cells.rechnung.value,
      row.cells.gutscheinVerkauft.value,
      row.cells.gutscheinEingeloest.value,
      row.cells.einzahlungBank.value,
      row.cashDiff,
      excelKommentar(row),
    ]);
  }
  const totalsRow: TagesabschlussExcelCell[] = [
    'Total',
    sumColumn(rows, 1),
    sumColumn(rows, 2),
    // Kassensaldo ist ein fortlaufender Bestand — Total = Monatsend-Saldo.
    month.endSaldo,
    sumColumn(rows, 4),
    sumColumn(rows, 5),
    sumColumn(rows, 6),
    sumColumn(rows, 7),
    sumColumn(rows, 8),
    sumColumn(rows, 9),
    sumColumn(rows, 10),
    null,
  ];
  return { header: [...TAGESABSCHLUSS_EXCEL_HEADERS], rows, totalsRow };
}

export function tagesabschlussExcelFilename(monthKey: string): string {
  return `tagesabschluesse_${monthKey}.xlsx`;
}

/**
 * Deterministische Excel-Datums-Serial (Tage seit 1899-12-30) aus einem
 * yyyy-MM-dd-String — bewusst über Date.UTC, damit KEINE Timezone-Verschiebung
 * entsteht (vgl. Mirus-1904-Bug: nie auf cellDates vertrauen).
 */
export function excelDateSerial(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return 25569 + Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

const DATE_FORMAT = 'dd.mm.yyyy';
const NUMBER_FORMAT = '#,##0.00';

/** Workbook mit einem Blatt „Tagesabschlüsse" aus den aufbereiteten Daten. */
export function buildTagesabschlussExcelWorkbook(data: TagesabschlussExcelData): XLSX.WorkBook {
  const aoa: (string | number | null)[][] = [
    data.header,
    ...data.rows.map(r => [excelDateSerial(String(r[0])), ...r.slice(1)]),
    data.totalsRow,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Datums- und Zahlenformate setzen (echte Excel-Zahlen/-Daten, kein Text).
  for (let i = 0; i < data.rows.length; i++) {
    const excelRow = i + 1; // Zeile 0 = Header
    const dateCell = ws[XLSX.utils.encode_cell({ r: excelRow, c: 0 })];
    if (dateCell) dateCell.z = DATE_FORMAT;
    for (let c = 1; c <= 10; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: excelRow, c })];
      if (cell && cell.t === 'n') cell.z = NUMBER_FORMAT;
    }
  }
  const totalRowIdx = data.rows.length + 1;
  for (let c = 1; c <= 10; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: totalRowIdx, c })];
    if (cell && cell.t === 'n') cell.z = NUMBER_FORMAT;
  }
  ws['!cols'] = [
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
    { wch: 14 }, { wch: 50 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tagesabschlüsse');
  return wb;
}

/** Browser-Download des Excel-Exports (XLSX.writeFile triggert den Download). */
export function exportTagesabschlussExcel(month: TagesabschlussMonth, monthKey: string): void {
  const data = buildTagesabschlussExcelData(month);
  const wb = buildTagesabschlussExcelWorkbook(data);
  XLSX.writeFile(wb, tagesabschlussExcelFilename(monthKey));
}
