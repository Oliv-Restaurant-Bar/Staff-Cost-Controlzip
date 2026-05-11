/**
 * Mirus Excel Parser — Monatsblatt (.xls / .xlsx)
 * =================================================
 * Liest Mirus-Monatsblätter aus Excel und extrahiert:
 *   A) Dokumentdaten  B) Mitarbeiterdaten
 *   C) Tageszeilen    D) Totale
 *
 * Verwendet SheetJS (xlsx@0.18.x).
 * Rein diagnostisch — kein Schreiben, kein Supabase.
 */

import * as XLSX from 'xlsx';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type CellVal = string | number | boolean | Date | null | undefined;

export interface RawCell {
  sheetName: string;
  rowIdx: number;   // 0-basiert
  colIdx: number;   // 0-basiert
  cellRef: string;  // "A1", "B3" …
  rawValue: CellVal;
  formatted: string;
}

export interface ExcelDayRow {
  date: string | null;
  weekday: string | null;
  timeBlocks: { from: string; to: string }[];
  department: string | null;
  pause: string | null;
  totalHours: string | null;
  absenceCodes: string[];
  remark: string | null;
  rawCells: RawCell[];
  rowIdx: number;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExcelTotals {
  totalHours: string | null;
  pauseTotal: string | null;
  nettoTotal: string | null;
  zeitzuschlag: string | null;
  ueberzeit: string | null;
  saldo: string | null;
  ferien: string | null;
  rawLines: string[];
}

export interface ExcelEmployee {
  name: string | null;
  personalnummer: string | null;
  kostenstelle: string | null;
  department: string | null;
  employment: string | null;
  weeklyHours: string | null;
  eintritt: string | null;
  austritt: string | null;
  sheetName: string;
  dayRows: ExcelDayRow[];
  totals: ExcelTotals;
  uncertainRows: number;
  headerRowIdx: number;
  rawHeaderCells: RawCell[];
}

export interface ExcelParsedDocument {
  fileName: string;
  month: number | null;
  monthName: string | null;
  year: number | null;
  restaurant: string | null;
  creationDate: string | null;
  employees: ExcelEmployee[];
  warnings: string[];
  quality: {
    totalEmployees: number;
    totalDayRows: number;
    uncertainRows: number;
    employeesWithTotals: number;
    qualityPercent: number;
  };
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

const ABSENCE_CODES = [
  'FE', 'FR', 'KR', 'UN', 'UE', 'GF', 'AB', 'MU', 'MA',
  'BU', 'JU', 'KO', 'AZ', 'ML', 'UU', 'BL', 'ZA', 'NU', 'WK', 'KI', 'SU', 'FL',
];

const MONTH_MAP: Record<string, number> = {
  januar: 1, january: 1, jan: 1,
  februar: 2, february: 2, feb: 2,
  märz: 3, maerz: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, oct: 10, okt: 10,
  november: 11, nov: 11,
  dezember: 12, december: 12, dec: 12, dez: 12,
};

const MONTH_NAMES_DE = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function str(v: CellVal): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString('de-CH');
  return String(v).trim();
}

/** Alle nicht-leeren Werte einer Zeile als Strings */
function rowTexts(row: CellVal[]): string[] {
  return row.map(str).filter(Boolean);
}

/** Gesamter Zeilentext (Leerzeichen-getrennt) */
function rowJoined(row: CellVal[]): string {
  return rowTexts(row).join(' ');
}

/**
 * Zeit aus einem Zellwert extrahieren.
 * Mirus speichert Zeiten meist als Text "10:00" oder als Excel-Dezimalbruch (0.xxx).
 */
function parseTime(v: CellVal): string | null {
  if (v == null) return null;
  // Direkter String HH:MM
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  // Excel-Dezimalbruch (0.0 = 00:00, 0.5 = 12:00, 1.0 = 24:00)
  if (typeof v === 'number' && v >= 0 && v < 2) {
    const totalMinutes = Math.round(v * 24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return null;
}

/** Stunden aus Zellwert (Dezimalzahl oder "HH:MM"-String) */
function parseHours(v: CellVal): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && !isNaN(v) && v >= 0) {
    // Excel-Zeit-Dezimalbruch → Stunden umrechnen
    if (v > 0 && v < 2) return (v * 24).toFixed(2);
    // Direkte Stundenzahl (z.B. 8.5, 42.0)
    if (v <= 300) return v.toFixed(2);
  }
  if (typeof v === 'string') {
    // "8.42" oder "8,42"
    const dec = v.replace(',', '.');
    const n = parseFloat(dec);
    if (!isNaN(n) && n >= 0 && n <= 300) return n.toFixed(2);
    // "8:25" → Stunden
    const hm = v.match(/^(\d{1,3}):(\d{2})$/);
    if (hm) return (parseInt(hm[1]) + parseInt(hm[2]) / 60).toFixed(2);
  }
  return null;
}

/** Datum aus Zellwert */
function parseDate(v: CellVal, year?: number | null): string | null {
  if (v instanceof Date) {
    return `${String(v.getDate()).padStart(2, '0')}.${String(v.getMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (m) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}`;
    const mFull = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (mFull) return `${mFull[1].padStart(2, '0')}.${mFull[2].padStart(2, '0')}`;
    // "01.01.2026"
  }
  if (typeof v === 'number' && year) {
    // Serial-Datum von Excel
    const d = XLSX.SSF.parse_date_code(v);
    if (d && d.m > 0 && d.m <= 12 && d.d > 0 && d.d <= 31) {
      return `${String(d.d).padStart(2, '0')}.${String(d.m).padStart(2, '0')}`;
    }
  }
  return null;
}

function detectWeekday(texts: string[]): string | null {
  for (const t of texts) {
    for (const wd of WEEKDAYS) {
      if (t === wd || new RegExp(`^${wd}$`).test(t.trim())) return wd;
    }
  }
  return null;
}

function extractTimeBlocksFromRow(row: CellVal[]): { from: string; to: string }[] {
  const blocks: { from: string; to: string }[] = [];
  // Durchlaufe Zellen, suche Zeitpaare
  const times: string[] = [];
  for (const cell of row) {
    const t = parseTime(cell);
    if (t) { times.push(t); continue; }
    // String "HH:MM-HH:MM"
    if (typeof cell === 'string') {
      const rangeM = cell.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g);
      if (rangeM) {
        for (const r of rangeM) {
          const rm = r.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
          if (rm) blocks.push({ from: rm[1].padStart(5, '0'), to: rm[2].padStart(5, '0') });
        }
        continue;
      }
      const singleM = cell.match(/^(\d{1,2}:\d{2})$/);
      if (singleM) times.push(singleM[1].padStart(5, '0'));
    }
  }
  // Zeitpaare bilden
  for (let i = 0; i + 1 < times.length; i += 2) {
    blocks.push({ from: times[i], to: times[i + 1] });
  }
  return blocks;
}

function extractAbsenceCodes(texts: string[]): string[] {
  const found: string[] = [];
  for (const t of texts) {
    for (const code of ABSENCE_CODES) {
      if (t === code && !found.includes(code)) found.push(code);
    }
  }
  return found;
}

function detectDepartment(text: string): string | null {
  const l = text.toLowerCase();
  if (l.includes('küche') || l.includes('kueche') || l.includes('kitchen')) return 'küche';
  if (l.includes('service') || l.includes('saal') || l.includes('restaurant') || l.includes('bar')) return 'service';
  return null;
}

function makeCellRef(sheetName: string, rowIdx: number, colIdx: number, rawValue: CellVal, formatted: string): RawCell {
  return {
    sheetName,
    rowIdx,
    colIdx,
    cellRef: XLSX.utils.encode_cell({ r: rowIdx, c: colIdx }),
    rawValue,
    formatted,
  };
}

// ─── Dokument-Metadaten ───────────────────────────────────────────────────────

function detectDocumentMeta(rows: CellVal[][], fileName: string): {
  month: number | null; monthName: string | null; year: number | null;
  restaurant: string | null; creationDate: string | null;
} {
  let month: number | null = null, monthName: string | null = null;
  let year: number | null = null, restaurant: string | null = null;
  let creationDate: string | null = null;

  // Dateiname auswerten
  const fnLower = fileName.toLowerCase();
  for (const [name, num] of Object.entries(MONTH_MAP)) {
    if (fnLower.includes(name)) { month = num; monthName = MONTH_NAMES_DE[num]; break; }
  }
  const yrM = fileName.match(/\b(202[0-9])\b/);
  if (yrM) year = parseInt(yrM[1]);

  // Obere Zeilen scannen (max. 30)
  for (const row of rows.slice(0, 30)) {
    const text = rowJoined(row);
    if (!text) continue;

    // Jahr
    if (!year) { const ym = text.match(/\b(202[0-9])\b/); if (ym) year = parseInt(ym[1]); }

    // Monat
    if (!month) {
      for (const [name, num] of Object.entries(MONTH_MAP)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(text)) { month = num; monthName = MONTH_NAMES_DE[num]; break; }
      }
    }

    // Restaurant
    if (!restaurant) {
      if (/\bOLIV\b/i.test(text)) restaurant = 'OLIV';
      else if (/\bBeaulieu\b/i.test(text)) restaurant = 'Beaulieu';
    }

    // Erstellungsdatum
    if (!creationDate) {
      const dm = text.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/);
      if (dm) creationDate = dm[1];
    }
  }

  return { month, monthName, year, restaurant, creationDate };
}

// ─── Mitarbeiter-Grenzen ──────────────────────────────────────────────────────

function findEmployeeBoundariesInSheet(rows: CellVal[][]): number[] {
  const bounds: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const text = rowJoined(rows[i]);
    if (/Name\s*\/\s*Vorname/i.test(text)) { bounds.push(i); continue; }
    if (/Personal.?Nr\.?/i.test(text) && rows[i].some(c => typeof c === 'number' && c > 100)) {
      bounds.push(i); continue;
    }
  }
  return [...new Set(bounds)].sort((a, b) => a - b);
}

// ─── Mitarbeiter-Kopfzeile ────────────────────────────────────────────────────

function parseEmployeeHeaderRows(
  rows: CellVal[][], startIdx: number, sheetName: string,
): Pick<ExcelEmployee, 'name' | 'personalnummer' | 'kostenstelle' | 'department' | 'employment' | 'weeklyHours' | 'eintritt' | 'austritt' | 'rawHeaderCells'> {
  const result = {
    name: null as string | null,
    personalnummer: null as string | null,
    kostenstelle: null as string | null,
    department: null as string | null,
    employment: null as string | null,
    weeklyHours: null as string | null,
    eintritt: null as string | null,
    austritt: null as string | null,
    rawHeaderCells: [] as RawCell[],
  };

  const headerRows = rows.slice(startIdx, startIdx + 12);

  for (let ri = 0; ri < headerRows.length; ri++) {
    const row = headerRows[ri];
    const absRowIdx = startIdx + ri;
    const texts = rowTexts(row);
    const joined = texts.join(' ');

    // Collect raw cells
    for (let ci = 0; ci < row.length; ci++) {
      if (row[ci] != null && str(row[ci])) {
        result.rawHeaderCells.push(makeCellRef(sheetName, absRowIdx, ci, row[ci], str(row[ci])));
      }
    }

    // ── Name / Vorname ────────────────────────────────────────────────────
    if (/Name\s*\/\s*Vorname/i.test(joined)) {
      // Finde den Index der "Name / Vorname"-Zelle, Name steht daneben
      let labelCol = -1;
      for (let ci = 0; ci < row.length; ci++) {
        if (/Name\s*\/\s*Vorname/i.test(str(row[ci]))) { labelCol = ci; break; }
      }
      if (labelCol >= 0) {
        // Sammle Zellen rechts davon bis "Wöchentliche" oder leere Grenze
        const nameParts: string[] = [];
        for (let ci = labelCol + 1; ci < row.length && ci < labelCol + 8; ci++) {
          const v = str(row[ci]);
          if (!v || /Wöchentliche|Personalnummer|Kostenstelle/i.test(v)) break;
          // Nur Buchstaben-Werte (kein Datum, keine Zahl)
          if (/^[\p{L}\s'\-]+$/u.test(v)) nameParts.push(v);
        }
        if (nameParts.length > 0) result.name = nameParts.join(' ').trim();
      }

      // "Wöchentliche Arbeitszeit" in derselben Zeile suchen
      for (let ci = 0; ci < row.length; ci++) {
        if (/Wöchentliche/i.test(str(row[ci]))) {
          // Wert steht in der nächsten nicht-leeren Zelle
          const wh = parseHours(row[ci + 1]) ?? parseHours(row[ci + 2]);
          if (wh && !result.weeklyHours) result.weeklyHours = wh;
          break;
        }
      }
      // Wochenstunden auch im selben String: "Wöchentliche Arbeitszeit ... 42.0"
      if (!result.weeklyHours) {
        const whM = joined.match(/Wöchentliche\s+Arbeitszeit\D+(\d+[.,]\d+)/i);
        if (whM) result.weeklyHours = whM[1].replace(',', '.');
      }
      continue;
    }

    // ── Personalnummer ────────────────────────────────────────────────────
    if (/Personal.?Nr\.?/i.test(joined) && !result.personalnummer) {
      for (let ci = 0; ci < row.length; ci++) {
        if (/Personal.?Nr\.?/i.test(str(row[ci]))) {
          const v = str(row[ci + 1] ?? row[ci + 2]);
          if (v && /^\d{1,8}$/.test(v)) { result.personalnummer = v; break; }
        }
      }
      continue;
    }

    // ── Kostenstelle ──────────────────────────────────────────────────────
    if (/Kostenstelle/i.test(joined) && !result.kostenstelle) {
      for (let ci = 0; ci < row.length; ci++) {
        if (/^Kostenstelle$/i.test(str(row[ci]).trim())) {
          // Nächste nicht-leere Zelle ist der Wert
          for (let nc = ci + 1; nc < row.length && nc < ci + 4; nc++) {
            const v = str(row[nc]);
            if (v && !/Arbeitsverhältnis/i.test(v)) {
              result.kostenstelle = v.slice(0, 30);
              if (!result.department) result.department = detectDepartment(v);
              break;
            }
          }
          break;
        }
      }
      // Fallback: Gesamtzeile nach "Kostenstelle" bis "Arbeitsverhältnis"
      if (!result.kostenstelle) {
        const ksM = joined.match(/Kostenstelle\s+(.+?)(?:\s+Arbeitsverhältnis|$)/i);
        if (ksM) {
          result.kostenstelle = ksM[1].trim().slice(0, 30);
          if (!result.department) result.department = detectDepartment(result.kostenstelle);
        }
      }
      // ── Arbeitsverhältnis in derselben Zeile ──────────────────────────
      if (!result.employment) {
        const avM = joined.match(/Arbeitsverhältnis\s+(.+?)(?:\s+\d{2}\.\d{2}\.\d{4}|$)/i);
        if (avM) result.employment = avM[1].trim().slice(0, 30);
      }
      // Einritt / Austritt: "01.01.2026 - 31.12.2026"
      if (!result.eintritt) {
        const dates = [...joined.matchAll(/(\d{2}\.\d{2}\.\d{4})/g)].map(m => m[1]);
        if (dates[0]) result.eintritt = dates[0];
        if (dates[1]) result.austritt = dates[1];
      }
      continue;
    }

    // ── Arbeitsverhältnis auf eigener Zeile ───────────────────────────────
    if (/Arbeitsverhältnis/i.test(joined) && !result.employment) {
      const avM = joined.match(/Arbeitsverhältnis\s+(.+?)(?:\s+\d{2}\.\d{2}\.\d{4}|$)/i);
      if (avM) result.employment = avM[1].trim().slice(0, 30);
      if (!result.eintritt) {
        const dates = [...joined.matchAll(/(\d{2}\.\d{2}\.\d{4})/g)].map(m => m[1]);
        if (dates[0]) result.eintritt = dates[0];
        if (dates[1]) result.austritt = dates[1];
      }
      continue;
    }

    // ── Wöchentliche Arbeitszeit auf eigener Zeile ───────────────────────
    if (/Wöchentliche/i.test(joined) && !result.weeklyHours) {
      for (let ci = 0; ci < row.length; ci++) {
        if (/Wöchentliche/i.test(str(row[ci]))) {
          const wh = parseHours(row[ci + 1]) ?? parseHours(row[ci + 2]);
          if (wh) { result.weeklyHours = wh; break; }
        }
      }
      if (!result.weeklyHours) {
        const whM = joined.match(/(\d+[.,]\d+)\s*h?$/i);
        if (whM) result.weeklyHours = whM[1].replace(',', '.');
      }
    }
  }

  return result;
}

// ─── Tageszeile ───────────────────────────────────────────────────────────────

function isDayRow(row: CellVal[], year: number | null): boolean {
  const first = row[0];
  if (first instanceof Date) return true;
  if (typeof first === 'number' && year) {
    // Excel-Serial-Date?
    const d = XLSX.SSF.parse_date_code(first);
    if (d && d.m > 0 && d.m <= 12 && d.d > 0 && d.d <= 31) return true;
  }
  const s = str(first);
  return /^\d{1,2}\.\d{1,2}\.?$/.test(s);
}

function isTotalsRow(row: CellVal[]): boolean {
  const joined = rowJoined(row);
  return /^\s*TOTAL\b/i.test(joined) ||
    /total.*(stunden|std|sum)/i.test(joined) ||
    /^stunden$/i.test(joined.trim()) ||
    /zeitzuschlag|überzeit|ueberzeit/i.test(joined) ||
    /^\s*saldo\b/i.test(joined) ||
    /unterschrift|visum/i.test(joined);
}

function parseDayRow(row: CellVal[], rowIdx: number, sheetName: string, year: number | null): ExcelDayRow {
  const texts = row.map(str);

  // Datum
  const date = parseDate(row[0], year);

  // Wochentag (meist Zelle 1 oder 2)
  const weekday = detectWeekday(texts.slice(0, 4));

  // Zeitblöcke
  const timeBlocks = extractTimeBlocksFromRow(row);

  // Abteilung: suche in Texten
  let department: string | null = null;
  for (const t of texts) { const d = detectDepartment(t); if (d) { department = d; break; } }

  // Absenzcodes
  const absenceCodes = extractAbsenceCodes(texts);

  // Stunden: suche numerische Werte in hinteren Spalten
  // Typische Mirus-Spaltenreihenfolge: ... | Brutto | Pause | Netto
  const numericCols: { idx: number; val: string }[] = [];
  for (let ci = 2; ci < row.length; ci++) {
    const h = parseHours(row[ci]);
    if (h !== null) numericCols.push({ idx: ci, val: h });
  }

  let pause: string | null = null;
  let totalHours: string | null = null;

  if (numericCols.length >= 3) {
    // Drittletzter = Brutto, Vorletzter = Pause, Letzter = Netto
    pause      = numericCols[numericCols.length - 2].val;
    totalHours = numericCols[numericCols.length - 1].val;
  } else if (numericCols.length === 2) {
    pause      = numericCols[0].val;
    totalHours = numericCols[1].val;
  } else if (numericCols.length === 1) {
    totalHours = numericCols[0].val;
  }

  // Bemerkung: letzter Text-String der kein Wochentag / keine Zahl ist
  const remark = texts.filter(t =>
    t && !WEEKDAYS.includes(t) && !/^\d/.test(t) &&
    !ABSENCE_CODES.includes(t) && !/Küche|Service/i.test(t) &&
    t.length > 3
  ).pop() ?? null;

  // Raw-Zellen
  const rawCells: RawCell[] = row.map((v, ci) => makeCellRef(sheetName, rowIdx, ci, v, str(v)));

  // Konfidenz
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!date) confidence = 'low';
  else if (!weekday && timeBlocks.length === 0 && absenceCodes.length === 0 && !totalHours) confidence = 'low';
  else if (!weekday || (!totalHours && timeBlocks.length === 0)) confidence = 'medium';

  return {
    date, weekday, timeBlocks, department,
    pause, totalHours, absenceCodes, remark,
    rawCells, rowIdx,
    confidence,
  };
}

// ─── Totale ───────────────────────────────────────────────────────────────────

function parseTotalsRows(rows: CellVal[][], rowIdxOffset: number, sheetName: string): ExcelTotals {
  const t: ExcelTotals = {
    totalHours: null, pauseTotal: null, nettoTotal: null,
    zeitzuschlag: null, ueberzeit: null, saldo: null,
    ferien: null, rawLines: [],
  };

  for (const row of rows) {
    const joined = rowJoined(row);
    if (!joined) continue;
    t.rawLines.push(joined);

    // Ersten numerischen Wert aus Zeile holen
    const numVals = row.map(parseHours).filter(Boolean) as string[];
    const best = numVals[numVals.length - 1] ?? null;

    if (/^\s*TOTAL\b/i.test(joined) && !t.totalHours) { t.totalHours = best; continue; }
    if (/stunden.?total|total.?stunden|gesamt.?std/i.test(joined) && !t.totalHours) { t.totalHours = best; continue; }
    if (/^stunden$/i.test(joined.trim()) && !t.totalHours) { t.totalHours = best; continue; }
    if (/pause.*total|total.*pause/i.test(joined) && !t.pauseTotal) { t.pauseTotal = best; continue; }
    if (/\bnetto\b/i.test(joined) && !t.nettoTotal) { t.nettoTotal = best; continue; }
    if (/zeitzuschlag/i.test(joined) && !t.zeitzuschlag) { t.zeitzuschlag = best; continue; }
    if (/überzeit|uberzeit/i.test(joined) && !t.ueberzeit) { t.ueberzeit = best; continue; }
    if (/\bsaldo\b/i.test(joined) && !t.saldo) {
      // Saldo kann negativ sein
      const sm = joined.match(/([+-]?\d+[.,]\d+)/); t.saldo = sm ? sm[1] : best; continue;
    }
    if (/\bferien\b|\bferientage\b/i.test(joined) && !t.ferien) { t.ferien = best; continue; }
  }

  return t;
}

// ─── Qualitäts-Score ──────────────────────────────────────────────────────────

function calcQuality(employees: ExcelEmployee[]): number {
  if (employees.length === 0) return 0;
  const totalRows = employees.reduce((s, e) => s + e.dayRows.length, 0);
  if (totalRows === 0 && employees.every(e => !e.name)) return 0;

  const namedPct = employees.filter(e => !!e.name).length / employees.length;
  const highRows  = employees.reduce((s, e) => s + e.dayRows.filter(r => r.confidence === 'high').length, 0);
  const rowPct    = totalRows > 0 ? highRows / totalRows : 0;
  const totPct    = employees.filter(e => !!e.totals.totalHours).length / employees.length;
  const whPct     = employees.filter(e => !!e.weeklyHours).length / employees.length;

  return Math.round(namedPct * 35 + rowPct * 45 + totPct * 15 + whPct * 5);
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

export async function parseMirusExcel(file: File): Promise<ExcelParsedDocument> {
  const warnings: string[] = [];
  const employees: ExcelEmployee[] = [];

  const buffer = await file.arrayBuffer();
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, {
      type: 'array',
      cellDates: true,
      cellNF: true,
      cellText: true,
      raw: false,
    });
  } catch (err) {
    throw new Error(`Excel-Datei konnte nicht gelesen werden: ${String(err)}`);
  }

  // Lese jedes Sheet doppelt: einmal raw (für Zahlen), einmal formatted (für Text-Matching)
  const sheetsData: { name: string; rawRows: CellVal[][]; fmtRows: CellVal[][] }[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<CellVal[]>(ws, {
      header: 1, defval: null, raw: true,
    });
    const fmtRows = XLSX.utils.sheet_to_json<CellVal[]>(ws, {
      header: 1, defval: null, raw: false,
    });
    sheetsData.push({ name: sheetName, rawRows, fmtRows });
  }

  // Alle Zeilen für Metadaten-Erkennung
  const allRows: CellVal[][] = sheetsData.flatMap(s => s.fmtRows);
  const meta = detectDocumentMeta(allRows, file.name);

  if (!meta.month) warnings.push('Monat konnte nicht erkannt werden (Dateiname + Zellinhalte geprüft).');
  if (!meta.year)  warnings.push('Jahr konnte nicht erkannt werden.');

  // ── Mitarbeiter je Sheet ──────────────────────────────────────────────────
  for (const { name: sheetName, rawRows, fmtRows } of sheetsData) {
    // Verwende fmtRows für Text-Matching, rawRows für Zahlenwerte
    const boundaries = findEmployeeBoundariesInSheet(fmtRows);

    if (boundaries.length === 0) {
      // Sheet hat kein "Name / Vorname" — vielleicht Deckblatt oder Zusammenfassung
      if (fmtRows.length > 3) {
        warnings.push(`Sheet "${sheetName}": keine Mitarbeitergrenzen gefunden.`);
      }
      continue;
    }

    for (let b = 0; b < boundaries.length; b++) {
      const startIdx = boundaries[b];
      const endIdx   = b + 1 < boundaries.length ? boundaries[b + 1] : fmtRows.length;

      // Header aus fmt-Zeilen lesen (Text-Matching), aber Zahlen aus raw-Zeilen
      const headerInfo = parseEmployeeHeaderRows(fmtRows, startIdx, sheetName);

      // Tageszeilen
      const dayRows: ExcelDayRow[] = [];
      const totalsRows: CellVal[][] = [];
      let inTotals = false;

      for (let ri = startIdx + 1; ri < endIdx; ri++) {
        const fmtRow = fmtRows[ri];
        const rawRow = rawRows[ri] ?? fmtRow;

        // Übergang Totale-Abschnitt
        if (!inTotals && isTotalsRow(fmtRow)) inTotals = true;

        if (inTotals) { totalsRows.push(rawRow); continue; }

        if (!fmtRow || fmtRow.every(c => c == null || str(c) === '')) continue;

        if (isDayRow(rawRow, meta.year)) {
          // Mische: Datum/Wochentag aus rawRow, Texte aus fmtRow
          const merged: CellVal[] = rawRow.map((rv, ci) =>
            (rv == null || str(rv) === '') ? (fmtRow[ci] ?? null) : rv
          );
          dayRows.push(parseDayRow(merged, ri, sheetName, meta.year));
        }
      }

      const totals = parseTotalsRows(totalsRows, 0, sheetName);
      const uncertainRows = dayRows.filter(r => r.confidence !== 'high').length;

      employees.push({
        ...headerInfo,
        name:           headerInfo.name           ?? null,
        sheetName,
        dayRows, totals, uncertainRows,
        headerRowIdx:   startIdx,
      });
    }
  }

  const totalDayRows     = employees.reduce((s, e) => s + e.dayRows.length, 0);
  const uncertainRows    = employees.reduce((s, e) => s + e.uncertainRows, 0);
  const empWithTotals    = employees.filter(e => !!e.totals.totalHours).length;
  const qualityPercent   = calcQuality(employees);

  return {
    fileName: file.name,
    ...meta,
    employees, warnings,
    quality: {
      totalEmployees: employees.length,
      totalDayRows, uncertainRows,
      employeesWithTotals: empWithTotals,
      qualityPercent,
    },
  };
}
