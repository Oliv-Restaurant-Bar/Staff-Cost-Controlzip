/**
 * maison-import.ts — XLSX-Import für Marketing-Tagesumsätze
 * ===========================================================
 * Liest einen GastronoVi-/POS-Export und extrahiert Tagesbeträge
 * ausschliesslich aus Zeilen mit der Bezeichnung "marketing" oder "Marketing".
 * Andere Zeilen (z.B. "Maison", "Rabatte") werden ignoriert.
 *
 * Format:
 *   Zeile 1: Bezeichnung | Zeitraum | 01.05. | 02.05. | …
 *   Zeile N: marketing   | CHF …    | CHF …  | CHF …  | …
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

const MAISON_LABELS = new Set(['marketing']);

/** Zellwert robust in Text wandeln (auch RichText-/Formel-Zellen). */
function cellToString(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    const o = val as { richText?: { text: string }[]; result?: ExcelJS.CellValue; text?: string };
    if (Array.isArray(o.richText)) return o.richText.map(t => t.text ?? '').join('');
    if (o.result !== undefined) return cellToString(o.result);
    if (typeof o.text === 'string') return o.text;
  }
  return String(val);
}

function parseCHFCell(val: ExcelJS.CellValue): number {
  if (typeof val === 'number') return val;
  const str = cellToString(val).replace(/CHF\s*/iu, '').replace(/[\s\u00A0']/gu, '').replace(',', '.');
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
    // Case-insensitive: «Marketing» UND «marketing» zählen BEIDE
    // (NBSP-/RichText-tolerant); Maison/Rabatte/Namens-Zeilen nie.
    const label = cellToString(row.getCell(1).value).replace(/\u00A0/g, ' ').trim();
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
