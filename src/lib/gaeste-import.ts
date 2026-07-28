/**
 * gaeste-import.ts — XLSX-Importe für Gäste- und Durchschnittsverkauf-Tageswerte
 * ==============================================================================
 * Gleiche Mechanik wie der Umsatz-Import (Gastronovi-Export):
 *   Zeile 1: Bezeichnung | Zeitraum | 01.07. | 02.07. | …
 *   GÄSTE-Datei:            Zeile «Gesamt»       — Personen («… P.»)
 *   DURCHSCHNITTSVERKAUF:   Zeile «Durchschnitt» — CHF
 *
 * Die «Zeitraum»-Spalte (Spalte 2) ist MASSGEBLICH (wie beim Umsatz-Import):
 *  - Gäste: Tageswerte werden ganzzahlig proportional auf das Zeitraum-Total
 *    abgeglichen (Rest auf den letzten Tag mit Wert).
 *  - Durchschnittsverkauf: der Zeitraum-Wert ist der massgebliche Monatswert;
 *    Tageswerte werden unverändert übernommen (ein Durchschnitt ist nicht
 *    summierbar und wird nicht skaliert).
 */

import ExcelJS from 'exceljs';

export interface TagesmetrikImportResult {
  /** YYYY-MM-DD → Wert (Gäste: Personen, Durchschnitt: CHF) */
  daily: Record<string, number>;
  /** Massgeblicher Wert der «Zeitraum»-Spalte (null wenn Zelle leer) */
  zeitraum: number | null;
  year: number;
  month: number; // 1-basiert, aus den Datumsspalten abgeleitet
  daysWithData: number;
  rowsFound: string[];
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

/** Zahl robust parsen: «CHF 53,47», «8'584 P.», NBSP/Apostroph-tolerant. */
function parseNumberCell(val: ExcelJS.CellValue): number {
  if (typeof val === 'number') return val;
  const str = cellToString(val)
    .replace(/CHF/giu, '')
    .replace(/P\.?\s*$/iu, '')
    .replace(/[\s\u00A0'’]/gu, '')
    .replace(',', '.');
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : 0;
}

async function parseTagesmetrikXlsx(
  file: File,
  year: number,
  labelMatches: (labelLower: string) => boolean,
): Promise<TagesmetrikImportResult> {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Keine Tabelle im Excel gefunden');

  const headerRow = ws.getRow(1);
  const dateCols: { col: number; day: number; month: number }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    if (col < 3) return;
    const str = cellToString(cell.value).trim();
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (m) dateCols.push({ col, day: parseInt(m[1], 10), month: parseInt(m[2], 10) });
  });
  if (dateCols.length === 0) throw new Error('Keine Datumsspalten in Zeile 1 gefunden');

  const inferredMonth = dateCols[0].month;
  const daily: Record<string, number> = {};
  const rowsFound: string[] = [];
  let zeitraum: number | null = null;

  ws.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return;
    const label = cellToString(row.getCell(1).value).replace(/\u00A0/g, ' ').trim();
    if (!labelMatches(label.toLowerCase())) return;
    rowsFound.push(label);

    const z = parseNumberCell(row.getCell(2).value);
    if (z !== 0) zeitraum = (zeitraum ?? 0) + z;

    dateCols.forEach(({ col, day, month }) => {
      const amount = parseNumberCell(row.getCell(col).value);
      if (amount > 0) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        daily[key] = (daily[key] ?? 0) + amount;
      }
    });
  });

  if (rowsFound.length === 0) {
    throw new Error('Erwartete Zeile nicht gefunden — bitte Datei prüfen');
  }

  return {
    daily,
    zeitraum,
    year,
    month: inferredMonth,
    daysWithData: Object.keys(daily).length,
    rowsFound,
  };
}

/**
 * GÄSTE-Import: Zeile «Gesamt» (Personen). Tageswerte werden ganzzahlig auf
 * das Zeitraum-Total abgeglichen — das Zeitraum-Total ist massgeblich.
 */
export async function parseGaesteXlsx(file: File, year: number): Promise<TagesmetrikImportResult> {
  const r = await parseTagesmetrikXlsx(file, year, l => l === 'gesamt');

  // Ganzzahlig runden, dann auf das massgebliche Zeitraum-Total abgleichen.
  const dates = Object.keys(r.daily).sort();
  for (const d of dates) r.daily[d] = Math.round(r.daily[d]);
  if (r.zeitraum != null && dates.length > 0) {
    const target = Math.round(r.zeitraum);
    const sum = dates.reduce((s, d) => s + r.daily[d], 0);
    if (sum > 0 && sum !== target) {
      const factor = target / sum;
      let acc = 0;
      for (const d of dates) { r.daily[d] = Math.round(r.daily[d] * factor); acc += r.daily[d]; }
      // Rest auf den letzten Tag mit Wert
      r.daily[dates[dates.length - 1]] += target - acc;
    } else if (sum === 0) {
      r.daily[dates[dates.length - 1]] += target;
    }
    r.zeitraum = target;
  }
  return r;
}

/**
 * DURCHSCHNITTSVERKAUF-Import: Zeile «Durchschnitt» (CHF). Der Zeitraum-Wert
 * ist der massgebliche Monatswert; Tageswerte bleiben unverändert.
 */
export async function parseDurchschnittXlsx(file: File, year: number): Promise<TagesmetrikImportResult> {
  const r = await parseTagesmetrikXlsx(file, year, l => l === 'durchschnitt');
  if (r.zeitraum != null) r.zeitraum = Math.round(r.zeitraum * 100) / 100;
  return r;
}
