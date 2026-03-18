/**
 * annual-revenue-import.ts
 * ========================
 * Parst ein Jahres-Umsatz-Excel (Gastronovi-Format) mit tagesweisen Werten
 * und gibt monatliche Summen zurück, die dann in saveMonth() geschrieben werden.
 *
 * Erwartetes Format:
 *   Spalte A = "Bezeichnung" (Gesamt, Food, Beverage, ...)
 *   Spalte B = "Zeitraum" (Jahrestotal als "CHF X")
 *   Spalte C+ = Tageswerte "01.01.", "02.01.", ... "31.12." (365 oder 366 Spalten)
 *
 *   Zeile "Gesamt" enthält den tagesweisen Brutto-Umsatz.
 */

import * as XLSX from 'xlsx';

export interface MonthImportRow {
  month: number;        // 1–12
  revenue: number;      // CHF-Summe aus "Gesamt"-Zeile
  food: number;         // Food (Speisen)
  beverage: number;     // Beverage (Getränke)
  discounts: number;    // Rabatte (negativ → als positiver Betrag)
}

export interface AnnualImportResult {
  months: MonthImportRow[];
  yearTotal: number;
  warnings: string[];
}

function parseCHFValue(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  const str = String(val)
    .replace(/CHF\s*/i, '')
    .replace(/\s/g, '')
    .replace("'", '')
    .replace(',', '.');
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

/**
 * Liest eine XLSX-Datei im Browser (via FileReader + XLSX.read) und
 * gibt ein Promise mit den monatlichen Summen zurück.
 */
export async function parseAnnualRevenueXLSX(file: File): Promise<AnnualImportResult> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const data: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (!data || data.length < 2) {
    throw new Error('Die Datei enthält keine auswertbaren Daten.');
  }

  const header = data[0] as string[];
  const warnings: string[] = [];

  // Spalten-Index je Monat ermitteln
  // Format: "01.01." = Tag 1 Monat 1, "01.02." = Tag 1 Monat 2
  const monthColumns: Record<number, number[]> = {};
  for (let i = 2; i < header.length; i++) {
    const cell = String(header[i]);
    const match = cell.match(/^(\d{2})\.(\d{2})\.$/);
    if (!match) continue;
    const month = parseInt(match[2]);
    if (month < 1 || month > 12) continue;
    if (!monthColumns[month]) monthColumns[month] = [];
    monthColumns[month].push(i);
  }

  if (Object.keys(monthColumns).length < 12) {
    warnings.push(`Nur ${Object.keys(monthColumns).length} Monate gefunden (12 erwartet).`);
  }

  // Relevante Zeilen finden (case-insensitive Suche)
  const findRow = (labels: string[]): unknown[] | undefined => {
    for (const label of labels) {
      const row = data.find(r => String((r as unknown[])[0]).toLowerCase().includes(label.toLowerCase()));
      if (row) return row as unknown[];
    }
    return undefined;
  };

  const gesamtRow  = findRow(['Gesamt', 'Total', 'Umsatz gesamt']);
  const foodRow    = findRow(['Food', 'Speisen', 'Essen']);
  const beverageRow = findRow(['Beverage', 'Getränke']);
  const discountRow = findRow(['Rabatt', 'Discount']);

  if (!gesamtRow) {
    throw new Error('Keine "Gesamt"-Zeile gefunden. Bitte prüfen Sie das Dateiformat.');
  }

  const months: MonthImportRow[] = [];
  let yearTotal = 0;

  for (let m = 1; m <= 12; m++) {
    const cols = monthColumns[m] ?? [];
    let revenue = 0;
    let food = 0;
    let beverage = 0;
    let discounts = 0;

    for (const col of cols) {
      revenue   += parseCHFValue(gesamtRow[col]);
      food      += foodRow    ? parseCHFValue(foodRow[col])     : 0;
      beverage  += beverageRow ? parseCHFValue(beverageRow[col]) : 0;
      discounts += discountRow ? Math.abs(parseCHFValue(discountRow[col])) : 0;
    }

    // Runde auf 2 Dezimalen
    months.push({
      month: m,
      revenue: Math.round(revenue * 100) / 100,
      food: Math.round(food * 100) / 100,
      beverage: Math.round(beverage * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
    });
    yearTotal += revenue;
  }

  yearTotal = Math.round(yearTotal * 100) / 100;

  // Plausibilitätscheck: Jahrestotal aus "Zeitraum"-Spalte (Spalte B)
  const declaredTotal = parseCHFValue(gesamtRow[1]);
  if (declaredTotal > 0) {
    const diff = Math.abs(yearTotal - declaredTotal);
    if (diff > 10) {
      warnings.push(
        `Berechnetes Jahrestotal (${yearTotal.toLocaleString('de-CH')} CHF) weicht um ${diff.toFixed(2)} CHF vom deklarierten Total (${declaredTotal.toLocaleString('de-CH')} CHF) ab.`
      );
    }
  }

  return { months, yearTotal, warnings };
}
