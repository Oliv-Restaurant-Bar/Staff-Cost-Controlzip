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
 *
 * Robustheit:
 *   - Spaltenköpfe können Strings ("01.01."), Datum-Zahlen (Excel-Serial)
 *     oder JavaScript Date-Objekte sein.
 *   - Zahlenformat: "CHF 96,70", "96.70", "96,70" – alle werden korrekt geparst.
 */

import * as XLSX from 'xlsx';

export interface MonthImportRow {
  month: number;        // 1–12
  revenue: number;      // CHF-Summe aus "Gesamt"-Zeile
  food: number;         // Food (Speisen)
  beverage: number;     // Beverage (Getränke)
  takeAway: number;     // Take Away (brutto, 2.6 % MwSt) — 0 wenn Zeile fehlt (z.B. Beaulieu)
  discounts: number;    // Rabatte (negativ → als positiver Betrag)
}

export interface AnnualImportResult {
  months: MonthImportRow[];
  yearTotal: number;
  warnings: string[];
  debugInfo?: string;
}

function parseCHFValue(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const str = String(val)
    .replace(/CHF\s*/i, '')
    .replace(/\s/g, '')
    .replace(/'/g, '')
    .replace(',', '.');
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

/**
 * Versucht, den Monat (1–12) aus einem Spaltenkopf zu extrahieren.
 * Unterstützt:
 *   - String "01.01." / "01.01" / "01.01.2025"
 *   - Excel-Date-Serial (Zahl > 1000)
 *   - JavaScript Date-Objekt
 */
function extractMonthFromHeader(cell: unknown): number | null {
  if (cell === null || cell === undefined || cell === '') return null;

  // String-basiert: "dd.mm." oder "dd.mm" oder "dd.mm.yyyy"
  if (typeof cell === 'string') {
    const m1 = cell.trim().match(/^\d{1,2}\.(\d{1,2})\.?(\d{0,4})?$/);
    if (m1) {
      const month = parseInt(m1[1]);
      if (month >= 1 && month <= 12) return month;
    }
    // Versuch: "mm/dd/yyyy" oder "yyyy-mm-dd"
    const m2 = cell.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m2) {
      const month = parseInt(m2[2]);
      if (month >= 1 && month <= 12) return month;
    }
    const m3 = cell.match(/^(\d{1,2})\/(\d{1,2})/);
    if (m3) {
      const month = parseInt(m3[1]);
      if (month >= 1 && month <= 12) return month;
    }
    return null;
  }

  // JavaScript Date-Objekt
  if (cell instanceof Date) {
    const month = cell.getMonth() + 1;
    if (month >= 1 && month <= 12) return month;
    return null;
  }

  // Excel-Date-Serial (Zahl): Konvertierung via XLSX
  if (typeof cell === 'number' && cell > 1) {
    try {
      const date = XLSX.SSF.parse_date_code(cell);
      if (date && date.m >= 1 && date.m <= 12) return date.m;
    } catch {
      // ignore
    }
    return null;
  }

  return null;
}

/**
 * Liest eine XLSX-Datei im Browser (via FileReader + XLSX.read) und
 * gibt ein Promise mit den monatlichen Summen zurück.
 *
 * Strategie:
 *   1. Zuerst mit raw=true lesen (gibt exakte Zellwerte/Date-Serials)
 *   2. Spaltenköpfe in Monats-Indizes übersetzen
 *   3. Zeilen "Gesamt", "Food", "Beverage", "Rabatt" auswerten
 */
export async function parseAnnualRevenueXLSX(file: File): Promise<AnnualImportResult> {
  const buffer = await file.arrayBuffer();

  // Erst mit raw=true (Datum als Zahl), dann fallback mit raw=false (Datum als String)
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as unknown[][];

  const warnings: string[] = [];
  const debugParts: string[] = [];

  if (!rawData || rawData.length < 2) {
    throw new Error('Die Datei enthält keine auswertbaren Daten.');
  }

  const header = rawData[0] as unknown[];

  // Spalten-Index je Monat ermitteln
  const monthColumns: Record<number, number[]> = {};
  let detectedCount = 0;

  for (let i = 2; i < header.length; i++) {
    const cell = header[i];
    const month = extractMonthFromHeader(cell);
    if (month !== null) {
      if (!monthColumns[month]) monthColumns[month] = [];
      monthColumns[month].push(i);
      detectedCount++;
    }
  }

  // Wenn raw=true nichts ergibt, nochmals mit raw=false versuchen (Datum als formatierter String)
  let data = rawData;
  if (detectedCount < 28) {
    const wbFormatted = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheetF = wbFormatted.Sheets[wbFormatted.SheetNames[0]];
    const formattedData: unknown[][] = XLSX.utils.sheet_to_json(sheetF, {
      header: 1,
      defval: '',
      raw: false,
    }) as unknown[][];

    if (formattedData && formattedData.length >= 2) {
      const headerF = formattedData[0] as unknown[];
      const monthColsF: Record<number, number[]> = {};
      let countF = 0;

      for (let i = 2; i < headerF.length; i++) {
        const cell = headerF[i];
        const month = extractMonthFromHeader(cell);
        if (month !== null) {
          if (!monthColsF[month]) monthColsF[month] = [];
          monthColsF[month].push(i);
          countF++;
        }
      }

      if (countF > detectedCount) {
        data = formattedData;
        Object.assign(monthColumns, monthColsF);
        detectedCount = countF;
      }
    }
  }

  const monthCount = Object.keys(monthColumns).length;
  debugParts.push(`Erkannte Tagesspalten: ${detectedCount} (${monthCount} Monate)`);

  // Kein einziger Monat erkannt → echten Formatfehler werfen
  if (monthCount === 0) {
    const sampleHeaders = (data[0] as unknown[]).slice(2, 7).map(String).join(' | ');
    throw new Error(
      `Spaltenköpfe wurden nicht erkannt (0 Monate gefunden). ` +
      `Stichprobe der Spaltenköpfe: "${sampleHeaders}". ` +
      `Erwartet: "01.01.", "02.01.", ... (Format DD.MM.) oder Excel-Datumszellen.`
    );
  }

  // Monats-Export (< 12 Monate) → Warnung, aber kein Fehler
  if (monthCount < 12) {
    const foundMonths = Object.keys(monthColumns)
      .map(Number)
      .sort((a, b) => a - b)
      .map(m => new Date(2000, m - 1, 1).toLocaleString('de-CH', { month: 'long' }))
      .join(', ');
    warnings.push(
      `Teilimport: ${monthCount} Monat${monthCount === 1 ? '' : 'e'} gefunden (${foundMonths}). ` +
      `Nur diese Monate werden gespeichert.`
    );
  }

  // Relevante Zeilen finden (case-insensitive Suche in Spalte A)
  const findRow = (labels: string[]): unknown[] | undefined => {
    for (const label of labels) {
      const row = data.find(r => {
        const cell = String((r as unknown[])[0]).toLowerCase().trim();
        return cell.includes(label.toLowerCase());
      });
      if (row) return row as unknown[];
    }
    return undefined;
  };

  const gesamtRow   = findRow(['gesamt', 'total', 'umsatz gesamt', 'umsatz netto', 'netto umsatz']);
  const foodRow     = findRow(['food', 'speisen', 'essen', 'küche']);
  const beverageRow = findRow(['beverage', 'getränke', 'drinks']);
  const takeAwayRow = findRow(['take away', 'takeaway', 'take-away']);
  const discountRow = findRow(['rabatt', 'discount', 'nachlass']);

  debugParts.push(`Gesamt-Zeile: ${gesamtRow ? String((gesamtRow as unknown[])[0]) : 'NICHT GEFUNDEN'}`);
  if (foodRow)     debugParts.push(`Food-Zeile: ${String((foodRow as unknown[])[0])}`);
  if (beverageRow) debugParts.push(`Beverage-Zeile: ${String((beverageRow as unknown[])[0])}`);
  if (takeAwayRow) debugParts.push(`Take-Away-Zeile: ${String((takeAwayRow as unknown[])[0])}`);

  if (!gesamtRow) {
    const rowLabels = data.slice(0, 15).map(r => String((r as unknown[])[0])).filter(Boolean).join(', ');
    throw new Error(
      `Keine "Gesamt"-Zeile gefunden. Gefundene Zeilenbeschriftungen: ${rowLabels || '(leer)'}. ` +
      `Bitte prüfen Sie, ob die erste Spalte "Gesamt", "Total" oder ähnliches enthält.`
    );
  }

  const months: MonthImportRow[] = [];
  let yearTotal = 0;

  for (let m = 1; m <= 12; m++) {
    const cols = monthColumns[m] ?? [];
    let revenue = 0;
    let food = 0;
    let beverage = 0;
    let takeAway = 0;
    let discounts = 0;

    for (const col of cols) {
      revenue   += parseCHFValue((gesamtRow as unknown[])[col]);
      food      += foodRow     ? parseCHFValue((foodRow as unknown[])[col])     : 0;
      beverage  += beverageRow ? parseCHFValue((beverageRow as unknown[])[col]) : 0;
      takeAway  += takeAwayRow ? parseCHFValue((takeAwayRow as unknown[])[col]) : 0;
      discounts += discountRow ? Math.abs(parseCHFValue((discountRow as unknown[])[col])) : 0;
    }

    months.push({
      month: m,
      revenue:   Math.round(revenue   * 100) / 100,
      food:      Math.round(food      * 100) / 100,
      beverage:  Math.round(beverage  * 100) / 100,
      takeAway:  Math.round(takeAway  * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
    });
    yearTotal += revenue;
  }

  yearTotal = Math.round(yearTotal * 100) / 100;

  // Plausibilitätscheck: Zeitraumsumme aus Spalte B (nur bei Volljahres-Import aussagekräftig)
  const declaredTotal = parseCHFValue((gesamtRow as unknown[])[1]);
  if (declaredTotal > 0 && monthCount === 12) {
    const diff = Math.abs(yearTotal - declaredTotal);
    if (diff > 50) {
      warnings.push(
        `Berechnetes Jahrestotal (${yearTotal.toLocaleString('de-CH')} CHF) weicht um ` +
        `${diff.toFixed(2)} CHF vom deklarierten Total (${declaredTotal.toLocaleString('de-CH')} CHF) ab.`
      );
    }
  }

  if (yearTotal === 0) {
    warnings.push('Alle Monatswerte sind 0. Bitte prüfen Sie, ob die Datei Zahlen enthält (nicht nur Text).');
  }

  return { months, yearTotal, warnings, debugInfo: debugParts.join(' | ') };
}
