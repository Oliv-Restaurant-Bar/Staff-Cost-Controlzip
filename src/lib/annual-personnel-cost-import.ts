/**
 * annual-personnel-cost-import.ts
 * ================================
 * Parst eine Excel-Datei mit monatlichen Personalkosten Vorjahr.
 *
 * Unterstützte Formate:
 *
 * A) Vertikales Format (empfohlen / Template):
 *    Spalte A = Monatsname (Januar, Feb, März, ...)
 *    Spalte B = Betrag CHF
 *    Beispiel:
 *      | Monat    | Personalkosten CHF |
 *      | Januar   | 45'800             |
 *      | Februar  | 47'200             |
 *      | ...      | ...                |
 *
 * B) Horizontales Format (wie Gastronovi-Jahresbericht):
 *    Zeile 1 = Spaltenköpfe (Jan, Feb, ..., Dez)
 *    Zeile 2 = Beträge
 *
 * C) Zweispaltig mit Monats-Nummern:
 *    Spalte A = 1–12
 *    Spalte B = Betrag CHF
 */

import * as XLSX from 'xlsx';

export interface PersonnelCostMonthRow {
  month: number; // 1–12
  amount: number; // CHF
}

export interface AnnualPersonnelCostResult {
  months: PersonnelCostMonthRow[];   // always 12 entries (0 for missing)
  yearTotal: number;
  detectedYear: number | null;
  warnings: string[];
}

// ─── Monatsnamen-Map ──────────────────────────────────────────────────────────

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, januar: 1, january: 1,
  feb: 2, februar: 2, february: 2,
  mär: 3, maer: 3, märz: 3, march: 3, mar: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, october: 10, oct: 10,
  nov: 11, november: 11,
  dez: 12, dezember: 12, december: 12, dec: 12,
};

function monthFromName(cell: unknown): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  const s = String(cell).toLowerCase().trim().replace(/[^a-züä]/g, '');
  return MONTH_NAME_MAP[s] ?? null;
}

function monthFromNumber(cell: unknown): number | null {
  const n = typeof cell === 'number' ? cell : parseFloat(String(cell));
  if (!isNaN(n) && n >= 1 && n <= 12 && Number.isInteger(n)) return n;
  return null;
}

function parseAmount(val: unknown): number {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  const s = String(val)
    .replace(/CHF\s*/i, '')
    .replace(/\s/g, '')
    .replace(/'/g, '')       // Swiss thousand separator
    .replace(/,/g, '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

export function parseAnnualPersonnelCostXLSX(buf: ArrayBuffer): AnnualPersonnelCostResult {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as unknown[][];

  const warnings: string[] = [];
  const amounts: Record<number, number> = {};
  let detectedYear: number | null = null;

  // Detect year from sheet name or a cell containing a 4-digit year
  const sheetName = wb.SheetNames[0] ?? '';
  const yearMatch = sheetName.match(/\b(20\d{2})\b/);
  if (yearMatch) detectedYear = parseInt(yearMatch[1]);

  if (!rows || rows.length === 0) {
    throw new Error('Die Datei enthält keine auswertbaren Daten.');
  }

  // ── Strategie A: Vertikal (Spalte A = Monat, Spalte B = Betrag) ────────────
  let verticalHits = 0;
  for (const row of rows) {
    const colA = row[0];
    const colB = row[1];

    // Try name first, then number
    const m = monthFromName(colA) ?? monthFromNumber(colA);
    if (m !== null) {
      const val = parseAmount(colB);
      // Only count as a hit if column B contains something numeric
      if (val !== 0 || String(colB).trim() !== '') {
        amounts[m] = (amounts[m] ?? 0) + val;
        verticalHits++;
      }
    }

    // Year detection from cells
    if (!detectedYear) {
      for (const cell of row) {
        const y = typeof cell === 'number' && cell >= 2018 && cell <= 2035
          ? cell
          : parseInt(String(cell));
        if (!isNaN(y) && y >= 2018 && y <= 2035 && String(cell).length === 4) {
          detectedYear = y;
          break;
        }
      }
    }
  }

  // ── Strategie B: Horizontal (Header = Monate, Zeile 2 = Beträge) ──────────
  if (verticalHits < 3) {
    // Look for a header row that contains multiple month names
    for (let ri = 0; ri < Math.min(5, rows.length); ri++) {
      const headerRow = rows[ri];
      const colToMonth: Record<number, number> = {};
      let monthHits = 0;
      for (let ci = 0; ci < headerRow.length; ci++) {
        const m = monthFromName(headerRow[ci]);
        if (m !== null) { colToMonth[ci] = m; monthHits++; }
      }
      if (monthHits >= 3) {
        // Next data row
        const dataRow = rows[ri + 1];
        if (dataRow) {
          for (const [ci, m] of Object.entries(colToMonth)) {
            amounts[m] = parseAmount(dataRow[parseInt(ci)]);
          }
          verticalHits = monthHits;
          break;
        }
      }
    }
  }

  if (verticalHits === 0) {
    throw new Error(
      'Keine Monatsdaten gefunden. Erwartet: Spalte A = Monatsname (Januar–Dezember), ' +
      'Spalte B = Betrag CHF. Alternativ: Kopfzeile mit Monatsnamen und darunter die Beträge. ' +
      'Tipp: Vorlage herunterladen und befüllen.'
    );
  }

  // Build result array
  let yearTotal = 0;
  const months: PersonnelCostMonthRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const amount = amounts[m] ?? 0;
    months.push({ month: m, amount });
    yearTotal += amount;
  }
  yearTotal = Math.round(yearTotal * 100) / 100;

  const populated = months.filter(r => r.amount > 0).length;
  if (populated < 12) {
    warnings.push(
      `Nur ${populated} Monate mit Werten gefunden. ` +
      `Fehlende Monate werden als 0 gespeichert.`
    );
  }
  if (yearTotal === 0) {
    warnings.push('Alle Beträge sind 0 – bitte Dateiformat prüfen.');
  }

  return { months, yearTotal, detectedYear, warnings };
}

// ─── Template-Generator ───────────────────────────────────────────────────────

export function generatePersonnelCostTemplate(year: number): ArrayBuffer {
  const MONTH_NAMES = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  const wsData = [
    ['Monat', `Personalkosten CHF (${year})`],
    ...MONTH_NAMES.map(name => [name, '']),
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 16 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, ws, `Personalkosten ${year}`);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}
