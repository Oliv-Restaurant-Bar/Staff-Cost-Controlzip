/**
 * maison-import.ts — XLSX-Import für Marketing-Tagesumsätze
 * ===========================================================
 * Liest einen GastronoVi-/POS-Export und extrahiert Tagesbeträge
 * ausschliesslich aus Zeilen, deren Bezeichnung «marketing» ENTHÄLT —
 * case-insensitive, inkl. Tippvarianten («Marketing», «marketing@»,
 * «Marketing influencerin Tanja»). NICHT gezählt werden «Maison»,
 * «Rabatte», «Mitarbeiter Rabatt», «Gutschein», «Sponsoring» und
 * Einzelnamen/Bewirtungen (enthalten das Wort «marketing» nicht).
 *
 * Format:
 *   Zeile 1: Bezeichnung | Zeitraum | 01.05. | 02.05. | …
 *   Zeile N: marketing   | CHF …    | CHF …  | CHF …  | …
 */

import ExcelJS from 'exceljs';
import { parseBetragZelle, type UnlesbareZelle } from '@/lib/tagesdaten-zahlen';

export interface MaisonImportResult {
  daily: Record<string, number>;
  year: number;
  month: number;
  totalGross: number;
  rowsFound: string[];
  daysWithData: number;
  /**
   * Zellen, die keinen gültigen Zahlenwert ergaben (nie als 0/NaN übernommen).
   * Nicht leer ⇒ die Import-UI MUSS den Import blockieren.
   */
  unlesbareWerte: UnlesbareZelle[];
}

/**
 * Verbindliche Marketing-Erkennung: Bezeichnung enthält «marketing»
 * (case-insensitive). Deckt «Marketing», «marketing@», «Marketing
 * influencerin Tanja» ab; «Maison»/«Rabatte»/«Gutschein»/«Sponsoring»/
 * Namenszeilen matchen nie.
 */
export function isMarketingLabel(label: string): boolean {
  return /marketing/i.test(label);
}

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

/** CHF-Zelle STRIKT parsen — unlesbar wird gesammelt (nie 0/NaN), leer ⇒ null. */
function parseCHFCell(
  val: ExcelJS.CellValue,
  zeile: string,
  spalte: string,
  unlesbar: UnlesbareZelle[],
): number | null {
  const r = parseBetragZelle(typeof val === 'number' ? val : cellToString(val));
  if (!r.ok) { unlesbar.push({ zeile, spalte, roh: r.roh ?? '' }); return null; }
  return r.value;
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
  const dateCols: { col: number; day: number; month: number; year: number }[] = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    if (col < 3) return;
    const str = String(cell.value ?? '').trim();
    // «01.08.» (ohne Jahr → Dropdown-Jahr) ODER «01.08.2026» (Jahr aus Spalte)
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
    if (m) dateCols.push({ col, day: parseInt(m[1], 10), month: parseInt(m[2], 10), year: m[3] ? parseInt(m[3], 10) : year });
  });

  if (dateCols.length === 0) throw new Error('Keine Datumsspalten in Zeile 1 gefunden');

  const inferredMonth = dateCols[0].month;
  const daily: Record<string, number> = {};
  const rowsFound: string[] = [];
  const unlesbareWerte: UnlesbareZelle[] = [];
  let totalGross = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return;
    // Case-insensitive Substring-Match (NBSP-/RichText-tolerant):
    // «Marketing», «marketing@», «Marketing influencerin Tanja» zählen;
    // Maison/Rabatte/Gutschein/Sponsoring/Namens-Zeilen nie.
    const label = cellToString(row.getCell(1).value).replace(/\u00A0/g, ' ').trim();
    if (!isMarketingLabel(label)) return;

    rowsFound.push(label);
    dateCols.forEach(({ col, day, month, year: y }) => {
      const spalte = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.`;
      const amount = parseCHFCell(row.getCell(col).value, label, spalte, unlesbareWerte);
      if (amount !== null && amount > 0) {
        const key = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
    unlesbareWerte,
  };
}
