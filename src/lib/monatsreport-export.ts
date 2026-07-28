/**
 * Monatsreport — Excel-Export (.xlsx) exakt im Layout der Meeting-Vorlage:
 * Kopfzeile «Monat <Name> | Budget | Vorjahr | Woche | +/- in % | Monat | +/- in %»,
 * dieselben Zeilen/Beschriftungen und Leerzeilen zwischen den Blöcken.
 * Schweizer Zahlenformat (1'234.56), Prozente als % mit einer Nachkommastelle.
 */
import ExcelJS from 'exceljs';
import type { MrRow } from '@/lib/monatsreport';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const FMT_CHF = "#'##0.00";
const FMT_COUNT = "#'##0";
const FMT_PCT = '0.0" %"';

export async function exportMonatsreportXlsx(rows: MrRow[], year: number, month: number): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(`Monatsreport ${MONATE[month - 1]}`, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { width: 34 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 10 }, { width: 14 }, { width: 10 },
  ];

  // Kopfzeile
  const head = ws.addRow([
    `Monat ${MONATE[month - 1]}`, 'Budget', 'Vorjahr', 'Woche', '+/- in %', 'Monat', '+/- in %',
  ]);
  head.font = { bold: true };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFA0A0A0' } } };
  });
  for (let i = 2; i <= 7; i++) head.getCell(i).alignment = { horizontal: 'right' };

  for (const row of rows) {
    if (row.type === 'empty') { ws.addRow([]); continue; }

    const wDev = row.week !== null && row.weekBudget !== null && row.weekBudget > 0
      ? ((row.week - row.weekBudget) / row.weekBudget) * 100 : null;
    const mDev = row.month !== null && row.budget !== null && row.budget > 0
      ? ((row.month - row.budget) / row.budget) * 100 : null;

    const r = ws.addRow([
      row.label ?? '',
      row.budget ?? null,
      row.vj ?? null,
      row.week ?? null,
      wDev,
      row.month ?? null,
      mDev,
    ]);

    const numFmt = row.fmt === 'count' || row.fmt === 'hours' ? FMT_COUNT
      : row.fmt === 'pct' ? FMT_PCT
      : FMT_CHF;
    for (const col of [2, 3, 4, 6]) {
      const cell = r.getCell(col);
      cell.numFmt = numFmt;
      cell.alignment = { horizontal: 'right' };
    }
    for (const col of [5, 7]) {
      const cell = r.getCell(col);
      cell.numFmt = '+0.0" %";-0.0" %"';
      cell.alignment = { horizontal: 'right' };
      const v = cell.value;
      if (typeof v === 'number') {
        cell.font = { color: { argb: v >= 0 ? 'FF196B24' : 'FFC00000' } };
      }
    }
    if (row.bold) r.font = { bold: true };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `monatsreport-${year}-${String(month).padStart(2, '0')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
