/**
 * Cockpit — Excel-Export (.xlsx) der Report-Tabelle je Granularität.
 * DIESELBE Datenquelle wie die Bildschirmtabelle (MrRow), nur andere Felder:
 *  - 'monat': Budget = monthBudget, Vorjahr = vjMonth, Ist = month
 *  - 'woche': Budget = budget (Woche), Vorjahr = vj (Woche), Ist = week
 * Spalten: Kennzahl | Budget | Vorjahr | Ist | Δ %.
 * Schweizer Zahlenformat (1'234.56), Prozente als % mit einer Nachkommastelle.
 * Δ%-Färbung invertiert bei Kosten (deltaInverted); Ist-Wert rot bei warnAbove.
 */
import ExcelJS from 'exceljs';
import type { MrRow } from '@/lib/monatsreport';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const FMT_CHF = "#'##0.00";
const FMT_COUNT = "#'##0";
const FMT_PCT = '0.0" %"';

/** Granularität des Exports (spiegelt den aktiven Cockpit-Tab). */
export type ExportGranularity = 'monat' | 'woche';

/** Aufbereitete Zellwerte einer Zeile für den Export (rein, ohne ExcelJS). */
export interface ExportCell {
  budget: number | null;
  vj: number | null;
  ist: number | null;
  /** Δ% (Ist vs. Budget der jeweiligen Granularität), null wenn nicht bestimmbar. */
  dev: number | null;
  /** true → Ist-Wert rot (warnAbove überschritten). */
  istWarn: boolean;
  /** true → Δ% grün, false → rot (berücksichtigt deltaInverted). */
  devGut: boolean | null;
  /** Begleit-«Personen» für fmt='countPax' (Anzeige «Anzahl (Σ Personen)»). */
  vjPax: number | null;
  istPax: number | null;
}

/**
 * Wählt je Granularität die passenden Felder derselben `MrRow` und berechnet
 * Δ% + Färb-Flags — identisch zur Bildschirmtabelle. Rein & testbar (canvas-frei).
 */
export function mapRowForExport(row: MrRow, granularity: ExportGranularity): ExportCell {
  const budget = granularity === 'monat' ? row.monthBudget : row.budget;
  const vj = granularity === 'monat' ? row.vjMonth : row.vj;
  const ist = granularity === 'monat' ? row.month : row.week;
  const devBudget = granularity === 'monat' ? row.monthBudget : row.weekBudget;
  const dev = ist !== null && devBudget !== null && devBudget > 0
    ? ((ist - devBudget) / devBudget) * 100 : null;
  const istWarn = row.warnAbove != null && ist !== null && ist > row.warnAbove;
  // Kosten-Zeilen (deltaInverted): über Budget (dev>0) = schlecht/rot.
  const devGut = dev === null ? null : (row.deltaInverted ? dev <= 0 : dev >= 0);
  const vjPax = granularity === 'monat' ? (row.vjMonthPax ?? null) : null;
  const istPax = granularity === 'monat' ? (row.monthPax ?? null) : (row.weekPax ?? null);
  return { budget, vj, ist, dev, istWarn, devGut, vjPax, istPax };
}

/**
 * Eindeutiger Vorjahres-Spaltentitel mit DYNAMISCHEM Jahr (JJJJ−1), damit Ist
 * und Vorjahr im Export nicht verwechselt werden. Fehlt das Jahr → schlichtes
 * «Vorjahr» (Rückwärtskompatibilität).
 */
export function vjColumnHeader(
  granularity: ExportGranularity, year?: number,
): string {
  if (year == null || !Number.isFinite(year)) return 'Vorjahr';
  const kind = granularity === 'monat' ? 'Monat' : 'Woche';
  return `Vorjahr (${kind} ${year - 1})`;
}

/** «Anzahl (Σ Personen)»-Text für fmt='countPax'; null → leer. */
function countPaxText(count: number | null, pax: number | null): string {
  if (count === null || count === undefined) return '';
  const c = Math.round(count).toLocaleString('de-CH');
  return pax !== null && pax !== undefined
    ? `${c} (${Math.round(pax).toLocaleString('de-CH')})`
    : c;
}

/**
 * Baut die Arbeitsmappe (ohne Download-Seiteneffekt) — rein & testbar.
 * Zieht je Granularität dieselben Felder wie die Bildschirmtabelle.
 */
export function buildMonatsreportWorkbook(
  rows: MrRow[], month: number, granularity: ExportGranularity = 'woche',
  year?: number,
): ExcelJS.Workbook {
  const istHeader = granularity === 'monat' ? 'Ist (Monat)' : 'Woche';
  // Eindeutiger Vorjahres-Spaltentitel mit DYNAMISCHEM Jahr (Ist ≠ Vorjahr).
  const vjHeader = vjColumnHeader(granularity, year);
  const sheetName = granularity === 'monat'
    ? `Monatsübersicht ${MONATE[month - 1]}`
    : `Wochenübersicht ${MONATE[month - 1]}`;

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { width: 34 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 10 },
  ];

  // Kopfzeile
  const head = ws.addRow([
    `${granularity === 'monat' ? 'Monat' : 'Woche'} ${MONATE[month - 1]}`,
    'Budget', vjHeader, istHeader, 'Δ %',
  ]);
  head.font = { bold: true };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFA0A0A0' } } };
  });
  for (let i = 2; i <= 5; i++) head.getCell(i).alignment = { horizontal: 'right' };

  for (const row of rows) {
    if (row.type === 'empty') { ws.addRow([]); continue; }

    // Felder je Granularität (identisch zur Bildschirm-Ansicht ReportTable).
    const c = mapRowForExport(row, granularity);

    // countPax («Anzahl (Σ Personen)») wird als Text geschrieben, sonst als Zahl.
    const isCountPax = row.fmt === 'countPax';
    const vjOut = isCountPax ? countPaxText(c.vj, c.vjPax) : c.vj;
    const istOut = isCountPax ? countPaxText(c.ist, c.istPax) : c.ist;

    const r = ws.addRow([row.label ?? '', c.budget, vjOut, istOut, c.dev]);

    const numFmt = row.fmt === 'count' || row.fmt === 'hours' ? FMT_COUNT
      : row.fmt === 'pct' ? FMT_PCT
      : FMT_CHF;
    for (const col of [2, 3, 4]) {
      const cell = r.getCell(col);
      // countPax-Text (Spalten 3/4) bleibt Text — kein Zahlenformat.
      if (!(isCountPax && (col === 3 || col === 4))) cell.numFmt = numFmt;
      cell.alignment = { horizontal: 'right' };
    }
    // Schwellen-Rot (warnAbove, z.B. PKQ > 40 %) für den Ist-Wert (Spalte 4).
    if (c.istWarn) {
      r.getCell(4).font = { color: { argb: 'FFC00000' }, bold: true };
    }
    // Δ%-Spalte (5): Kosten-Zeilen (deltaInverted) → über Budget (>0) = rot.
    const devCell = r.getCell(5);
    devCell.numFmt = '+0.0" %";-0.0" %"';
    devCell.alignment = { horizontal: 'right' };
    if (c.devGut !== null) {
      devCell.font = { color: { argb: c.devGut ? 'FF196B24' : 'FFC00000' } };
    }
    // Fett pro Zelle mergen — r.font = {bold} würde die gesetzten Zellfarben
    // (istWarn / Δ%-Färbung) der ganzen Zeile überschreiben.
    if (row.bold) {
      for (let col = 1; col <= 5; col++) {
        const cell = r.getCell(col);
        cell.font = { ...(cell.font ?? {}), bold: true };
      }
    }
  }

  return wb;
}

export async function exportMonatsreportXlsx(
  rows: MrRow[], year: number, month: number, granularity: ExportGranularity = 'woche',
): Promise<void> {
  const wb = buildMonatsreportWorkbook(rows, month, granularity, year);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cockpit-${granularity === 'monat' ? 'monatsuebersicht' : 'wochenuebersicht'}-${year}-${String(month).padStart(2, '0')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
