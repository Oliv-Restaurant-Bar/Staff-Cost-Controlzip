/**
 * maison-import.ts — XLSX-Import für Maison-Tagesumsätze
 * ========================================================
 * Liest einen GastronoVi-/POS-Export und extrahiert Tagesbeträge
 * aus Zeilen mit den Bezeichnungen "Maison", "marketing", "Marketing".
 *
 * Format:
 *   Zeile 1: Bezeichnung | Zeitraum | 01.05. | 02.05. | …
 *   Zeile N: Maison | CHF 2164,30 | CHF 191,10 | CHF 378,30 | …
 */

import ExcelJS from 'exceljs';

export interface MaisonImportResult {
  daily: Record<string, number>;
  year: number;
  month: number;
  totalGross: number;
  rowsFound: string[];
  daysWithData: number;
}

const MAISON_LABELS = new Set(['maison', 'marketing']);

function parseCHFCell(val: ExcelJS.CellValue): number {
  if (val === null || val === undefined) return 0;
  const str = String(val).replace(/CHF\s*/i, '').replace(/\s/g, '').replace(',', '.');
  return parseFloat(str) || 0;
}

export async function parseMaisonXlsx(
  file: File,
  year: number,
): Promise<MaisonImportResult> {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Keine Tabelle im Excel gefunden');

  const headerRow = ws.getRow(1);
  const dateCols: { col: number; day: number; month: number }[] = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    if (col < 3) return;
    const str = String(cell.value ?? '').trim();
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (m) dateCols.push({ col, day: parseInt(m[1], 10), month: parseInt(m[2], 10) });
  });

  if (dateCols.length === 0) throw new Error('Keine Datumsspalten in Zeile 1 gefunden');

  const inferredMonth = dateCols[0].month;
  const daily: Record<string, number> = {};
  const rowsFound: string[] = [];
  let totalGross = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return;
    const label = String(row.getCell(1).value ?? '').trim();
    if (!MAISON_LABELS.has(label.toLowerCase())) return;

    rowsFound.push(label);
    dateCols.forEach(({ col, day, month }) => {
      const amount = parseCHFCell(row.getCell(col).value);
      if (amount > 0) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        daily[key] = (daily[key] ?? 0) + amount;
        totalGross += amount;
      }
    });
  });

  return {
    daily,
    year,
    month: inferredMonth,
    totalGross,
    rowsFound,
    daysWithData: Object.keys(daily).length,
  };
}
