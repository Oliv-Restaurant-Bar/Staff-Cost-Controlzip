/**
 * gaeste-import.ts — XLSX-Importe für Gäste- und Durchschnittsverkauf-Tageswerte
 * ==============================================================================
 * Gleiche Mechanik wie der Umsatz-Import (Gastronovi-Export):
 *   Zeile 1: Bezeichnung | Zeitraum | 01.07. | 02.07. | …
 *   GÄSTE-Datei:            Zeile «Gesamt»       — Personen («… P.»)
 *   DURCHSCHNITTSVERKAUF:   Zeile «Durchschnitt» — CHF
 *
 * Massgeblichkeit der Werte:
 *  - GÄSTE: die TAGESSUMME ist massgeblich. Die Tageswerte werden nur gerundet
 *    (Math.round) und unverändert übernommen — KEINE Skalierung auf das
 *    Zeitraum-Total, KEIN Rest auf den letzten Tag, KEIN Addieren des Zeitraums
 *    bei leerer Tagessumme. Grund: die Gastronovi-«Zeitraum»-Zelle kann einen
 *    abweichenden Zeitraum abdecken (z.B. Zeitraum 8'604 vs. Tagessumme 8'584);
 *    korrekt sind die Tageswerte. Der Zeitraum-Wert (`zeitraum`) wird weiterhin
 *    zurückgegeben — nur als Info, damit die Import-UI bei Abweichung
 *    zeitraum ≠ tagessumme einen HINWEIS zeigen kann (nicht blockieren).
 *  - DURCHSCHNITTSVERKAUF: der «Zeitraum»-Wert ist der massgebliche Monatswert;
 *    Tageswerte werden unverändert übernommen (ein Durchschnitt ist nicht
 *    summierbar und wird nicht skaliert).
 */

import ExcelJS from 'exceljs';
import { parseBetragZelle, type UnlesbareZelle } from '@/lib/tagesdaten-zahlen';

export interface TagesmetrikImportResult {
  /** YYYY-MM-DD → Wert (Gäste: Personen, Durchschnitt: CHF) */
  daily: Record<string, number>;
  /**
   * Wert der «Zeitraum»-Spalte (null wenn Zelle leer). Beim Durchschnittsverkauf
   * der massgebliche Monatswert; bei Gästen nur Info (Tageswerte sind massgeblich).
   */
  zeitraum: number | null;
  /**
   * Summe der (gerundeten) Tageswerte. Bei Gästen der massgebliche Gesamtwert;
   * die Import-UI kann bei Abweichung zeitraum ≠ tagessumme einen Hinweis zeigen.
   */
  tagessumme: number;
  year: number;
  month: number; // 1-basiert, aus den Datumsspalten abgeleitet
  daysWithData: number;
  rowsFound: string[];
  /**
   * Zellen, die keinen gültigen Zahlenwert ergaben (nie als 0/NaN übernommen).
   * Nicht leer ⇒ die Import-UI MUSS den Import blockieren.
   */
  unlesbareWerte: UnlesbareZelle[];
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

/**
 * Zahl STRIKT parsen: «CHF 53,47», «8'584 P.», NBSP/Apostroph-tolerant —
 * unlesbare Zellen werden gesammelt (nie 0/NaN), leer/«-» ⇒ null.
 */
function parseNumberCell(
  val: ExcelJS.CellValue,
  zeile: string,
  spalte: string,
  unlesbar: UnlesbareZelle[],
): number | null {
  const r = parseBetragZelle(typeof val === 'number' ? val : cellToString(val));
  if (!r.ok) { unlesbar.push({ zeile, spalte, roh: r.roh ?? '' }); return null; }
  return r.value;
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
  const dateCols: { col: number; day: number; month: number; year: number }[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    if (col < 3) return;
    const str = cellToString(cell.value).trim();
    // «01.08.» (ohne Jahr → Dropdown-Jahr) ODER «01.08.2026» (Jahr aus Spalte)
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
    if (m) dateCols.push({ col, day: parseInt(m[1], 10), month: parseInt(m[2], 10), year: m[3] ? parseInt(m[3], 10) : year });
  });
  if (dateCols.length === 0) throw new Error('Keine Datumsspalten in Zeile 1 gefunden');

  const inferredMonth = dateCols[0].month;
  const daily: Record<string, number> = {};
  const rowsFound: string[] = [];
  const unlesbareWerte: UnlesbareZelle[] = [];
  let zeitraum: number | null = null;

  ws.eachRow({ includeEmpty: false }, (row, rowIndex) => {
    if (rowIndex === 1) return;
    const label = cellToString(row.getCell(1).value).replace(/\u00A0/g, ' ').trim();
    if (!labelMatches(label.toLowerCase())) return;
    rowsFound.push(label);

    const z = parseNumberCell(row.getCell(2).value, label, 'Zeitraum', unlesbareWerte);
    if (z !== null && z !== 0) zeitraum = (zeitraum ?? 0) + z;

    dateCols.forEach(({ col, day, month, year: y }) => {
      const spalte = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.`;
      const amount = parseNumberCell(row.getCell(col).value, label, spalte, unlesbareWerte);
      if (amount !== null && amount > 0) {
        const key = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        daily[key] = (daily[key] ?? 0) + amount;
      }
    });
  });

  if (rowsFound.length === 0) {
    throw new Error('Erwartete Zeile nicht gefunden — bitte Datei prüfen');
  }

  const tagessumme = Object.values(daily).reduce((s, v) => s + v, 0);

  return {
    daily,
    zeitraum,
    tagessumme,
    year,
    month: inferredMonth,
    daysWithData: Object.keys(daily).length,
    rowsFound,
    unlesbareWerte,
  };
}

/**
 * GÄSTE-Import: Zeile «Gesamt» (Personen). Die TAGESSUMME ist massgeblich —
 * die Tageswerte werden nur ganzzahlig gerundet und unverändert übernommen.
 * KEINE Skalierung auf das Zeitraum-Total, KEIN Rest auf den letzten Tag,
 * KEIN Addieren des Zeitraums bei leerer Tagessumme. Der «Zeitraum»-Wert wird
 * (gerundet) weiterhin als Info zurückgegeben; die Import-UI kann bei
 * Abweichung zeitraum ≠ tagessumme einen Hinweis zeigen.
 */
export async function parseGaesteXlsx(file: File, year: number): Promise<TagesmetrikImportResult> {
  const r = await parseTagesmetrikXlsx(file, year, l => l === 'gesamt');

  // Tageswerte nur ganzzahlig runden — kein Abgleich auf das Zeitraum-Total.
  const dates = Object.keys(r.daily).sort();
  for (const d of dates) r.daily[d] = Math.round(r.daily[d]);

  // Zeitraum bleibt reine Info (gerundet); tagessumme aus den gerundeten Tageswerten.
  if (r.zeitraum != null) r.zeitraum = Math.round(r.zeitraum);
  r.tagessumme = dates.reduce((s, d) => s + r.daily[d], 0);

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
