/**
 * mirus-parser.ts
 * ===============
 * Robust Mirus XLS parser for "Tägliche Stunden" exports.
 *
 * Supports two layout modes (tried in order):
 *   Phase 1 – Classic flat/tabular format (original Mirus grid export)
 *   Phase 2 – Formatted report layout (print/report view with header, dept blocks, summary rows)
 *
 * Debug output: console.log prefixed with [MIRUS]
 */

import * as XLSX from 'xlsx';
import { format, parse, addDays, endOfMonth } from 'date-fns';
import { MirusDailyImportEntry } from '@/types/personnel';

// ── Types ─────────────────────────────────────────────────────────────────

interface DateColumn {
  index: number;
  date: string;
}

type DetectedDept = 'küche' | 'service' | 'admin';

// ── Diagnostics (GN-parser-style: every path returns debug + failureReason) ──

export interface MirusParseDebug {
  fileName: string;
  totalRows: number;
  inferredYear: number;
  reportType: string;
  /** Detected title/period range as ISO strings, if any. */
  detectedRange: { startIso: string; endIso: string } | null;
  /** Which strategy resolved the day columns. */
  columnStrategy: string | null;
  /** header row index used (0-based), if resolved. */
  headerRowIdx: number | null;
  /** Resolved day columns as "date→colN". */
  dateColumns: string[];
  /** Weekday cross-check outcome. */
  weekdayCheck: MirusWeekdayCheck | null;
  /** First rows of the sheet for post-mortem inspection. */
  sampleRows: unknown[][];
}

export interface MirusWeekdayCheck {
  ok: boolean;
  /** 'ok' = alle Labels stimmen; 'mismatch' = Off-by-one erkannt; 'none-found' =
   *  keine Wochentags-Labels vorhanden (Gegenprobe nicht möglich). */
  status: 'ok' | 'mismatch' | 'none-found';
  /** Human-readable mismatches: "col12 2025-07-27: Kopf 'Mo' ↔ berechnet 'So'". */
  mismatches: string[];
  /** How many columns carried a checkable weekday label. */
  checked: number;
}

export interface MirusCostCenter {
  /** Kostenträger-Nummer aus dem Dateikopf, z.B. "3027". */
  number: string;
  /** Voller Kopftext, z.B. "3027 Restaurant OLIV". */
  label: string;
  /** Zugeordneter Mandant laut Tabelle, oder null wenn unbekannt. */
  tenant: string | null;
}

export interface MirusParseResult {
  entries: MirusDailyImportEntry[];
  dateRange: string[];
  debug: MirusParseDebug;
  /** Erkannter Kostenträger (Mandanten-Check, Spec Punkt 4); null wenn keiner gefunden. */
  costCenter: MirusCostCenter | null;
  /** Non-null when the import must be STOPPED (e.g. weekday mismatch). */
  failureReason: string | null;
}

// ── Kostenträger → Mandant (konfigurierbare Tabelle, Spec Punkt 4) ─────────
// Robust gegen Zusätze wie «AG»: Zuordnung NUR über die Nummer.
export const COST_CENTER_TENANTS: Record<string, string> = {
  '3027': 'oliv',      // «3027 Restaurant OLIV»
  '3012': 'beaulieu',  // «3012 Restaurant Beaulieu AG»
};

/** Kostenträger-Kopf in den ersten Zeilen suchen: «<Nr> Restaurant <Name…>». */
export function detectCostCenter(rows: unknown[][], maxRows = 40): MirusCostCenter | null {
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    for (const cell of rows[i] || []) {
      const s = String(cell ?? '').trim();
      const m = s.match(/\b(\d{3,5})\s+Restaurant\s+\S/i);
      if (m) {
        const number = m[1];
        return { number, label: s, tenant: COST_CENTER_TENANTS[number] ?? null };
      }
    }
  }
  return null;
}

// Weekday abbreviations Mirus uses (German). JS getDay(): 0=So … 6=Sa.
const WEEKDAY_LABELS: Record<number, string[]> = {
  0: ['so', 'son', 'sonntag'],
  1: ['mo', 'mon', 'montag'],
  2: ['di', 'die', 'dienstag'],
  3: ['mi', 'mit', 'mittwoch'],
  4: ['do', 'don', 'donnerstag'],
  5: ['fr', 'fre', 'freitag'],
  6: ['sa', 'sam', 'samstag'],
};
const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** Extract a leading German weekday abbreviation from a cell, else null (0..6). */
function cellToWeekday(cell: unknown): number | null {
  const s = String(cell ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  for (const [dow, labels] of Object.entries(WEEKDAY_LABELS)) {
    if (labels.includes(s)) return Number(dow);
  }
  // Header cells sometimes read "Mo 27" or "27 Mo".
  const m = s.match(/\b(so|mo|di|mi|do|fr|sa)\b/);
  if (m) {
    for (const [dow, labels] of Object.entries(WEEKDAY_LABELS)) {
      if (labels.includes(m[1])) return Number(dow);
    }
  }
  return null;
}

// ── Date-range regex patterns (most specific first) ───────────────────────

const DATE_RANGE_PATTERNS: RegExp[] = [
  // "von 13.04.2026 bis Datum: 13.04.2026"
  /von\s+(\d{1,2}\.\d{1,2}\.\d{4})\s+bis\s+[Dd]atum\s*[:\-]?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i,
  // "von 13.04.2026 bis 30.04.2026"
  /von\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*bis\s*(\d{1,2}\.\d{1,2}\.\d{4})/i,
  // "Tägliche Stunden ... 01.04.2026 ... 30.04.2026"
  /tägliche\s+stunden[^0-9]*(\d{1,2}\.\d{1,2}\.\d{4})[^0-9]+(\d{1,2}\.\d{1,2}\.\d{4})/i,
  // "13.04.2026 - 13.04.2026"  or  "13.04.2026 – 13.04.2026"
  /(\d{1,2}\.\d{1,2}\.\d{4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{4})/,
];

// ── Cell helpers ──────────────────────────────────────────────────────────

function inferYear(rows: unknown[][]): number {
  const currentYear = new Date().getFullYear();
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    // Skip Date objects — they may have wrong years if the XLS uses the 1904 date system.
    // Only scan plain string/number cells for a 4-digit year in the range 2020-2099.
    const rowStr = (rows[i] || [])
      .filter(c => !(c instanceof Date))
      .map(c => String(c ?? ''))
      .join(' ');
    const m = rowStr.match(/\b(20[2-9]\d)\b/);
    if (m) {
      const y = Number(m[1]);
      // Sanity check: reject years more than 3 years in the future
      if (y <= currentYear + 3) return y;
    }
  }
  return currentYear;
}

function cellToDateObj(cell: unknown, year: number): Date | null {
  if (!cell) return null;

  // Date objects can be produced by XLSX cellDates:true — but may have wrong years
  // due to the Excel 1904 date-system bug (off by exactly 1462 days = 4 years).
  // Accept them only if the year is within ±3 of the inferred/current year.
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    const cellYear = cell.getFullYear();
    const currentYear = new Date().getFullYear();
    if (Math.abs(cellYear - year) <= 3 && cellYear >= 2020 && cellYear <= currentYear + 3) {
      return cell;
    }
    // Year looks wrong (e.g. 2028 when we expect 2026) — fall through to text parsing
    console.warn(`[MIRUS] cellToDateObj: rejected Date with suspicious year ${cellYear} (expected ~${year})`);
    return null;
  }

  if (typeof cell === 'number' && cell > 20000) {
    const dc = XLSX.SSF.parse_date_code(cell);
    if (dc && dc.y && dc.m && dc.d) {
      const d = new Date(dc.y, dc.m - 1, dc.d);
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const s = String(cell).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }
  const full = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (full) {
    const d = new Date(parseInt(full[3]), parseInt(full[2]) - 1, parseInt(full[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const partial = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (partial) {
    const d = new Date(year, parseInt(partial[2]) - 1, parseInt(partial[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function cellToIntDay(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) {
    const n = Math.trunc(cell);
    if (Math.abs(cell - n) < 1e-6 && n >= 1 && n <= 31) return n;
    return null;
  }
  const s = String(cell ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})$/);
  return m ? parseInt(m[1], 10) : null;
}

function cellToHours(cell: unknown): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  const n = typeof cell === 'number' ? cell : parseFloat(String(cell).replace(',', '.'));
  if (isNaN(n) || n < 0 || n > 24) return null;
  if (n === 0) return null;
  return Math.round(n * 100) / 100;
}

// ── Summary-row filter ────────────────────────────────────────────────────

const SUMMARY_RE = [
  /\btotal\s+stunden\b/i,
  /\bgesamt\s*stunden\b/i,
  /\bsumme\b/i,
  /\bzwischensumme\b/i,
  /\bsub[- ]?total\b/i,
  /\banzahl\s+mitarbeiter\b/i, // Fusszeile «Anzahl Mitarbeiter» (Zahlen sind keine Stunden)
];

function isSummaryRow(rowText: string, row: unknown[]): boolean {
  if (SUMMARY_RE.some(re => re.test(rowText))) return true;
  const first = String(row[0] || '').trim();
  if (/^\d+\s+\w+\s+total\b/i.test(first)) return true;
  return false;
}

// ── Department block detection (GENERISCH, Spec Punkt 2) ──────────────────
//
// Beliebig viele Abteilungsblöcke («1 Küche», «2 Service», «3 Hilfsarbeiter»,
// «4 Geschäftsleitung», …): erkannt an einem Blockkopf «<Nr> <Label>» in den
// ersten Spalten. KEINE Hardcodierung bekannter Labels — jeder Block wird
// gelesen (nichts wird mehr übersprungen); Mitarbeiter über Blöcke werden
// später pro Tag SUMMIERT.

const BLOCK_HEADER_RE = /^\d+\s+[\p{L}]/u;

function detectDepartment(row: unknown[]): DetectedDept | null {
  for (const cell of row.slice(0, 8)) {
    const t = String(cell || '').trim();
    if (!t) continue;
    if (!BLOCK_HEADER_RE.test(t)) continue;
    // Kein Blockkopf, wenn es eine Total-/Summenzeile ist («2 Service Total …»)
    if (/\btotal\b/i.test(t)) return null;
    // Datumsartige Zellen («1.7.2026») ausschliessen
    if (/^\d+\s*[.\-/]/.test(t)) continue;
    const lo = t.toLowerCase();
    if (lo.includes('küch') || lo.includes('kuche')) return 'küche';
    if (lo.includes('service')) return 'service';
    // Unbekanntes Block-Label (Hilfsarbeiter, Geschäftsleitung, …) → Block
    // trotzdem lesen; Abteilung neutral als 'admin' signalisieren (Aufrufer
    // behält die bisherige Abteilung bei, überspringt aber NICHT mehr).
    return 'admin';
  }
  return null;
}

// ── Employee name extraction ───────────────────────────────────────────────

const SKIP_NAME_WORDS = /^(Mo|Di|Mi|Do|Fr|Sa|So|Total|Datum|Tägliche|Küche|Service|Restaurant|Standort|Adresse|Bericht|Auswertung)\b/i;

/** True if a cell value looks like a name part (not a number, not a keyword, has letters) */
function isNameLike(raw: unknown): boolean {
  const s = String(raw || '').trim();
  if (!s || s.length < 2) return false;
  if (!/[a-zA-ZäöüÄÖÜàáâèéêùúûß]/.test(s)) return false;
  if (SKIP_NAME_WORDS.test(s)) return false;
  if (/^\d{1,2}[.\-/]/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (BLOCK_HEADER_RE.test(s)) return false; // Blockkopf «<Nr> <Label>» ist kein Name
  return true;
}

/**
 * Extract employee name from a row.
 * Handles three common Mirus layouts:
 *   A) Full name in one cell:  | | Momand Sajed | 8.0 | ...
 *   B) Name in two cells:      | | Momand | Sajed | 8.0 | ...
 *   C) "Last, First" in one:   | | Momand, Sajed | 8.0 | ...  (comma format)
 */
function extractName(row: unknown[], maxCol = 8): string | null {
  for (let i = 0; i < Math.min(row.length, maxCol); i++) {
    const s = String(row[i] || '').trim();
    if (!isNameLike(s)) continue;

    // Layout C: "Nachname, Vorname" — remove comma, keep as single name token
    // We do NOT reorder here; the matcher will handle both orders.
    const cleanedCell = s.replace(/,\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Layout B: check if the very next non-empty cell is also name-like
    // (distinct from a number = hours column)
    let fullName = cleanedCell;
    const nextIdx = i + 1;
    if (nextIdx < Math.min(row.length, maxCol + 1)) {
      const nextRaw = String(row[nextIdx] || '').trim();
      if (isNameLike(nextRaw)) {
        const nextClean = nextRaw.replace(/,\s*/g, ' ').trim();
        fullName = `${cleanedCell} ${nextClean}`;
      }
    }

    return fullName;
  }
  return null;
}

// ── Date-range extraction from row text ───────────────────────────────────

function extractDateRange(rows: unknown[][], maxRows = 50): { start: Date; end: Date } | null {
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    const rowText = (rows[i] || []).map(c => String(c || '')).join(' ');

    for (const pat of DATE_RANGE_PATTERNS) {
      const m = rowText.match(pat);
      if (m) {
        const start = parse(m[1], 'dd.MM.yyyy', new Date());
        const end   = parse(m[2], 'dd.MM.yyyy', new Date());
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          console.log(`[MIRUS] detected date range: ${m[1]} – ${m[2]}`);
          return { start, end };
        }
      }
    }

    // Single-day: "am DD.MM.YYYY"
    const single = rowText.match(/\bam\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (single) {
      const d = parse(single[1], 'dd.MM.yyyy', new Date());
      if (!isNaN(d.getTime())) {
        console.log(`[MIRUS] detected single day (am): ${single[1]}`);
        return { start: d, end: d };
      }
    }

    // Single-day in header when only one date present with "Tägliche Stunden"
    if (/tägliche\s+stunden/i.test(rowText)) {
      const allDates = rowText.match(/\d{1,2}\.\d{1,2}\.\d{4}/g);
      if (allDates && allDates.length === 1) {
        const d = parse(allDates[0], 'dd.MM.yyyy', new Date());
        if (!isNaN(d.getTime())) {
          console.log(`[MIRUS] detected single day (header only): ${allDates[0]}`);
          return { start: d, end: d };
        }
      }
    }
  }
  return null;
}

// ── Build expected date list ───────────────────────────────────────────────

function buildExpectedDates(start: Date, end: Date): { iso: string; day: number }[] {
  const list: { iso: string; day: number }[] = [];
  let cur = new Date(start);
  while (cur <= end) {
    list.push({ iso: format(cur, 'yyyy-MM-dd'), day: cur.getDate() });
    cur = addDays(cur, 1);
  }
  return list;
}

// ── Header row detection (date-cell approach) ─────────────────────────────

function detectDateCellHeader(rows: unknown[][], year: number, minCols = 5): {
  headerRowIdx: number;
  dateColumns: DateColumn[];
} | null {
  let best: { headerRowIdx: number; dateColumns: DateColumn[] } | null = null;

  for (let i = 0; i < Math.min(rows.length, 120); i++) {
    const row = rows[i];
    if (!row) continue;

    const dateCols = row
      .map((cell, idx) => ({ idx, d: cellToDateObj(cell, year) }))
      .filter(x => x.d !== null)
      .filter(x => (x.d as Date).getDate() >= 1)
      .map(x => ({ index: x.idx, date: format(x.d as Date, 'yyyy-MM-dd') }))
      .sort((a, b) => a.index - b.index);

    if (dateCols.length < minCols) continue;

    const nums = dateCols.map(dc => new Date(dc.date + 'T00:00:00').getTime());
    if (!nums.every((v, k) => k === 0 || v >= nums[k - 1])) continue;

    if (!best || dateCols.length > best.dateColumns.length) {
      best = { headerRowIdx: i, dateColumns: dateCols };
    }
  }
  return best;
}

// ── Find day-number header row (integer day numbers in sequence) ──────────

function findDayNumberHeader(
  rows: unknown[][],
  expectedDays: number[],
  startDate: Date,
): { headerRowIdx: number; dateColumns: DateColumn[]; expectedDates: { iso: string; day: number }[] } | null {
  const expectedDates = buildExpectedDates(startDate, addDays(startDate, expectedDays.length - 1));
  let bestRowIdx = -1, bestStartCol = -1, bestLen = 0;

  for (let i = 0; i < Math.min(rows.length, 150); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    for (let col = 0; col < row.length; col++) {
      if (cellToIntDay(row[col]) !== expectedDays[0]) continue;
      let len = 0;
      while (len < expectedDays.length && col + len < row.length) {
        if (cellToIntDay(row[col + len]) === expectedDays[len]) len++;
        else break;
      }
      if (len > bestLen) { bestLen = len; bestRowIdx = i; bestStartCol = col; }
    }
    if (bestLen === expectedDays.length) break;
  }

  if (bestRowIdx < 0 || bestLen < 1) return null;

  const dateColumns: DateColumn[] = [];
  for (let k = 0; k < bestLen && k < expectedDates.length; k++) {
    dateColumns.push({ index: bestStartCol + k, date: expectedDates[k].iso });
  }
  return { headerRowIdx: bestRowIdx, dateColumns, expectedDates };
}

// ── Full-month offset approach (for short date ranges) ────────────────────

function findFullMonthHeader(
  rows: unknown[][],
  startDate: Date,
  expectedDates: { iso: string; day: number }[],
): { headerRowIdx: number; dateColumns: DateColumn[] } | null {
  const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  const fullSeq = Array.from({ length: daysInMonth }, (_, k) => k + 1);
  const minMatch = Math.min(5, daysInMonth);

  let bestRow = -1, bestCol = -1, bestLen = 0;

  for (let i = 0; i < Math.min(rows.length, 150); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    for (let col = 0; col < row.length; col++) {
      if (cellToIntDay(row[col]) !== 1) continue;
      let len = 0;
      while (len < fullSeq.length && col + len < row.length) {
        if (cellToIntDay(row[col + len]) === fullSeq[len]) len++;
        else break;
      }
      if (len >= minMatch && len > bestLen) { bestLen = len; bestRow = i; bestCol = col; }
    }
    if (bestLen >= minMatch) break;
  }

  if (bestRow < 0 || bestLen < minMatch) return null;

  const dateColumns = expectedDates.map(ed => ({ index: bestCol + (ed.day - 1), date: ed.iso }));
  console.log(`[MIRUS] full-month header found: row ${bestRow}, col1 at col ${bestCol}, mapping requested days to offset`);
  return { headerRowIdx: bestRow, dateColumns };
}

// ── Employee row parser (shared) ──────────────────────────────────────────

function parseEmployeeRows(
  rows: unknown[][],
  headerRowIdx: number,
  dateColumns: DateColumn[],
): MirusDailyImportEntry[] {
  const entries: MirusDailyImportEntry[] = [];
  let currentDept: 'küche' | 'service' = 'service';

  for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!row || row.length === 0) continue;

    const rowText = row.map(c => String(c || '')).join(' ');

    // Department block header — ALLE Blöcke werden gelesen (Spec Punkt 2).
    // 'admin' = unbekanntes Label (Hilfsarbeiter, Geschäftsleitung, …):
    // Abteilungszuordnung bleibt die zuletzt bekannte, Zeilen zählen mit.
    const dept = detectDepartment(row);
    if (dept !== null) {
      if (dept !== 'admin') currentDept = dept;
      console.log(`[MIRUS] detected department block: ${dept}${dept === 'admin' ? ` (generic, reading rows as ${currentDept})` : ''}`);
      continue;
    }

    // Summary row
    if (isSummaryRow(rowText, row)) {
      console.log(`[MIRUS] ignored summary row: ${rowText.slice(0, 80)}`);
      continue;
    }

    // Meta rows
    if (/tägliche\s+stunden|restaurant|waisenhausplatz|standort|adresse|bericht/i.test(rowText)) continue;

    // Employee name
    const name = extractName(row);
    if (!name || name.length < 2) continue;

    let added = 0;
    for (const { index, date } of dateColumns) {
      if (index >= row.length) continue;
      const hours = cellToHours(row[index]);
      if (hours === null) continue;
      entries.push({ name, department: currentDept, date, hours });
      console.log(`[MIRUS] parsed entry: ${name} / ${date} / ${hours}h`);
      added++;
    }
    if (added > 0) {
      console.log(`[MIRUS] detected employee row: ${name} (${added} day(s) with hours)`);
    }
  }

  // ── Über Blöcke aggregieren (Spec Punkt 3) ────────────────────────────────
  // Derselbe Mitarbeiter kann in mehreren Blöcken vorkommen (z.B. Küche +
  // Hilfsarbeiter): Stunden pro (Name, Tag) SUMMIEREN, nie überschreiben.
  const byKey = new Map<string, MirusDailyImportEntry>();
  let mergedRows = 0;
  for (const e of entries) {
    const key = `${e.name.toLowerCase()}|${e.date}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.hours = Math.round((prev.hours + e.hours) * 100) / 100;
      mergedRows++;
    } else {
      byKey.set(key, { ...e });
    }
  }
  const aggregated = [...byKey.values()];
  if (mergedRows > 0) {
    console.log(`[MIRUS] aggregated ${mergedRows} duplicate name/day cell(s) across blocks (summed)`);
  }

  console.log(`[MIRUS] total parsed entries: ${aggregated.length}`);
  return aggregated;
}

// ── Day-number header → date mapping (SPEC-KONFORM) ─────────────────────────
//
// Kernidee (Spec Punkt 1): Das Datum jeder Stundenspalte = TAGESZAHL aus der
// Kopfzelle + Monat/Jahr aus dem Titel. NIEMALS die Spaltenposition als Tag.
// Für Teil-Exporte (z.B. nur 27.–28.) gibt es KEINE «1»-Zelle — deshalb ankern
// wir NICHT auf Tag 1, sondern lesen jede Kopfzelle einzeln.
//
// Robustheit: Nur Tageszahlen im gültigen Bereich [1..daysInMonth] und im
// erkannten Zeitraum werden übernommen. Aufsteigend + eindeutig.

interface HeaderRowScan {
  headerRowIdx: number;
  dateColumns: DateColumn[];
  score: number;
}

/**
 * Findet die Kopfzeile mit den meisten gültigen Tageszahlen und mappt jede
 * Spalte auf `year-month-day`. `month`/`year` stammen aus dem Titel-Zeitraum.
 */
function resolveDayNumberColumns(
  rows: unknown[][],
  start: Date,
  end: Date,
): { headerRowIdx: number; dateColumns: DateColumn[]; strategy: string } | null {
  const year = start.getFullYear();
  const month = start.getMonth(); // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Erlaubte Tage = die im erkannten Zeitraum enthaltenen Kalendertage.
  const allowed = new Set<number>();
  {
    let cur = new Date(start);
    while (cur <= end) { allowed.add(cur.getDate()); cur = addDays(cur, 1); }
  }

  let best: HeaderRowScan | null = null;

  for (let i = 0; i < Math.min(rows.length, 150); i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const cols: DateColumn[] = [];
    const seenDays = new Set<number>();
    for (let col = 0; col < row.length; col++) {
      const day = cellToIntDay(row[col]);
      if (day === null) continue;
      if (day < 1 || day > daysInMonth) continue;
      if (!allowed.has(day)) continue;      // nur Tage aus dem Zeitraum
      if (seenDays.has(day)) continue;      // Duplikate (z.B. Total-Spalte) ignorieren
      seenDays.add(day);
      const iso = format(new Date(year, month, day), 'yyyy-MM-dd');
      cols.push({ index: col, date: iso });
    }
    if (cols.length === 0) continue;

    // Streng aufsteigende Tagesfolge über die Spalten HART erzwingen: eine
    // echte Mirus-Kopfzeile listet die Tage aufsteigend (…, 27, 28, …). Eine
    // Zeile mit nicht-monotonen Zahlen ist KEINE Kopfzeile (z.B. zufällige
    // Werte in Datenzeilen) → Kandidat komplett verwerfen, statt ihn nur
    // schlechter zu bewerten. Lieber gar keinen Treffer (→ failureReason) als
    // eine falsche Tag-zu-Spalte-Zuordnung.
    cols.sort((a, b) => a.index - b.index);
    const daysSeq = cols.map(c => Number(c.date.slice(-2)));
    const strictlyAscending = daysSeq.every((d, k) => k === 0 || d > daysSeq[k - 1]);
    if (!strictlyAscending) continue;

    const score = cols.length;
    if (!best || score > best.score) {
      best = { headerRowIdx: i, dateColumns: cols, score };
    }
  }

  if (!best || best.dateColumns.length === 0) return null;
  return {
    headerRowIdx: best.headerRowIdx,
    dateColumns: best.dateColumns,
    strategy: 'day-number-header',
  };
}

/**
 * Wochentags-Gegenprobe (Spec Punkt 1, Off-by-one-Schutz):
 * Vergleicht das Wochentags-Label in der Kopfzeile (Kopfzeile selbst ODER die
 * Zeile direkt darüber) mit dem aus dem Datum berechneten Wochentag. Bei
 * Abweichung → Import stoppen.
 */
export function checkWeekdays(
  rows: unknown[][],
  headerRowIdx: number,
  dateColumns: DateColumn[],
): MirusWeekdayCheck {
  const headerRow = rows[headerRowIdx] ?? [];
  const aboveRow = headerRowIdx > 0 ? (rows[headerRowIdx - 1] ?? []) : [];
  const mismatches: string[] = [];
  let checked = 0;

  for (const dc of dateColumns) {
    // Wochentag aus Kopfzelle selbst, sonst aus der Zeile darüber (gleiche Spalte).
    const label = cellToWeekday(headerRow[dc.index]) ?? cellToWeekday(aboveRow[dc.index]);
    if (label === null) continue;
    checked++;
    const computed = new Date(dc.date + 'T00:00:00').getDay();
    if (label !== computed) {
      mismatches.push(
        `Spalte ${dc.index} (${dc.date}): Kopf «${WEEKDAY_SHORT[label]}» ↔ berechnet «${WEEKDAY_SHORT[computed]}»`,
      );
    }
  }

  if (checked === 0) {
    // Keine Wochentags-Labels gefunden → Gegenprobe war nicht möglich.
    // Eigenes Signal (kein stilles ok), damit der Aufrufer konservativ handeln kann.
    return { ok: false, status: 'none-found', mismatches: [], checked: 0 };
  }
  if (mismatches.length > 0) {
    return { ok: false, status: 'mismatch', mismatches, checked };
  }
  return { ok: true, status: 'ok', mismatches: [], checked };
}

// ── Resolve date columns for a given date range ───────────────────────────

function resolveDateColumns(
  rows: unknown[][],
  start: Date,
  end: Date,
  year: number,
): { headerRowIdx: number; dateColumns: DateColumn[]; strategy: string } | null {
  const expectedDates = buildExpectedDates(start, end);
  const expectedDays  = expectedDates.map(d => d.day);
  const minConsec     = Math.min(5, expectedDays.length);

  // ── PRIMÄR (spec-konform): Tageszahl je Kopfzelle → Datum. Funktioniert auch
  //    für Teil-Exporte (nur 27.–28.), weil NICHT auf Tag 1 geankert wird.
  const byDay = resolveDayNumberColumns(rows, start, end);
  if (byDay && byDay.dateColumns.length > 0) {
    console.log(`[MIRUS] day columns (day-number-header): ${byDay.dateColumns.map(dc => `${dc.date}→col${dc.index}`).join(', ')}`);
    return byDay;
  }

  // Ab hier NUR Fallbacks (ältere Layouts). Diese können Spaltenoffsets nutzen —
  // sie greifen aber nur, wenn die Tageszahl-Kopfzeile NICHT gefunden wurde.

  // Short-range (1-2 days): full-month offset approach
  if (expectedDays.length <= 2) {
    const fm = findFullMonthHeader(rows, start, expectedDates);
    if (fm) {
      console.log(`[MIRUS] day columns (full-month offset, FALLBACK): ${fm.dateColumns.map(dc => `${dc.date}→col${dc.index}`).join(', ')}`);
      return { ...fm, strategy: 'full-month-offset' };
    }
    const dc = detectDateCellHeader(rows, year, 1);
    if (dc) {
      const reqSet = new Set(expectedDates.map(d => d.iso));
      let filtered = dc.dateColumns.filter(c => reqSet.has(c.date));
      if (filtered.length === 0) filtered = dc.dateColumns.slice(0, 1);
      console.log(`[MIRUS] day columns (date-cell, FALLBACK): ${filtered.map(c => `${c.date}→col${c.index}`).join(', ')}`);
      return { headerRowIdx: dc.headerRowIdx, dateColumns: filtered, strategy: 'date-cell' };
    }
    return null; // Kein blindes Raten mehr (früher fixer Offset col 5) → failureReason
  }

  // Multi-day: consecutive day number sequence
  const found = findDayNumberHeader(rows, expectedDays, start);
  if (found && found.dateColumns.length >= minConsec) {
    console.log(`[MIRUS] day columns (consecutive-days, FALLBACK): ${found.dateColumns.map(dc => `${dc.date}→col${dc.index}`).join(', ')}`);
    return { headerRowIdx: found.headerRowIdx, dateColumns: found.dateColumns, strategy: 'consecutive-days' };
  }

  const dc = detectDateCellHeader(rows, year, minConsec);
  if (dc) {
    console.log(`[MIRUS] day columns (date-cell, FALLBACK): ${dc.dateColumns.length} cols`);
    return { headerRowIdx: dc.headerRowIdx, dateColumns: dc.dateColumns, strategy: 'date-cell' };
  }

  return null; // Kein Last-Resort-Fixoffset mehr → statt falscher Tage lieber failureReason
}

// ── Phase 1: Classic parser ────────────────────────────────────────────────

interface RunnerResult {
  entries: MirusDailyImportEntry[];
  dateRange: string[];
  resolved: { headerRowIdx: number; dateColumns: DateColumn[]; strategy: string } | null;
  detectedRange: { start: Date; end: Date } | null;
}

function runClassicParser(
  rows: unknown[][],
  year: number,
  fileName: string,
): RunnerResult {
  let dateRange = extractDateRange(rows, 40);

  // Filename fallback: Tägliche_Stunden_04.2026_...
  if (!dateRange) {
    const fn = fileName.match(/_(\d{2})\.(\d{4})[_.]/);
    if (fn) {
      const mm = parseInt(fn[1], 10), yyyy = parseInt(fn[2], 10);
      if (mm >= 1 && mm <= 12 && yyyy > 2000) {
        const s = new Date(yyyy, mm - 1, 1);
        dateRange = { start: s, end: endOfMonth(s) };
        console.log(`[MIRUS] date range inferred from filename: ${format(s, 'MM.yyyy')}`);
      }
    }
  }

  if (!dateRange) {
    console.log('[MIRUS] classic parser: no date range found');
    return { entries: [], dateRange: [], resolved: null, detectedRange: null };
  }

  const resolved = resolveDateColumns(rows, dateRange.start, dateRange.end, year);
  if (!resolved || resolved.dateColumns.length === 0) {
    console.log('[MIRUS] classic parser: no date columns resolved');
    return { entries: [], dateRange: [], resolved: null, detectedRange: dateRange };
  }

  console.log(`[MIRUS] classic parser: header row ${resolved.headerRowIdx}, ${resolved.dateColumns.length} date cols (${resolved.strategy})`);
  const entries = parseEmployeeRows(rows, resolved.headerRowIdx, resolved.dateColumns);
  return { entries, dateRange: resolved.dateColumns.map(dc => dc.date), resolved, detectedRange: dateRange };
}

// ── Phase 2: Report-style parser ──────────────────────────────────────────

function runReportParser(
  rows: unknown[][],
  year: number,
): RunnerResult {
  const dateRange = extractDateRange(rows, 50);
  if (!dateRange) {
    console.log('[MIRUS] report parser: no date range found');
    return { entries: [], dateRange: [], resolved: null, detectedRange: null };
  }

  const resolved = resolveDateColumns(rows, dateRange.start, dateRange.end, year);
  if (!resolved || resolved.dateColumns.length === 0) {
    console.log('[MIRUS] report parser: no date columns resolved');
    return { entries: [], dateRange: [], resolved: null, detectedRange: dateRange };
  }

  console.log(`[MIRUS] report parser: header row ${resolved.headerRowIdx}, ${resolved.dateColumns.length} date cols (${resolved.strategy})`);
  const entries = parseEmployeeRows(rows, resolved.headerRowIdx, resolved.dateColumns);
  return { entries, dateRange: resolved.dateColumns.map(dc => dc.date), resolved, detectedRange: dateRange };
}

// ── Post-parse date sanity check ──────────────────────────────────────────

/**
 * Filters out entries whose dates are implausible (> 2 years in the future or
 * more than 10 years in the past). This is a last-resort guard against the
 * Excel 1904-date-system bug or any other date-conversion anomaly.
 */
function sanitizeEntries(
  result: { entries: MirusDailyImportEntry[]; dateRange: string[] },
  inferredYear: number,
): { entries: MirusDailyImportEntry[]; dateRange: string[] } {
  const currentYear = new Date().getFullYear();
  const minYear = currentYear - 10;
  const maxYear = currentYear + 2;

  const bad: string[] = [];
  const good = result.entries.filter(e => {
    const y = parseInt(e.date.slice(0, 4), 10);
    if (isNaN(y) || y < minYear || y > maxYear) {
      bad.push(`${e.name}/${e.date}`);
      return false;
    }
    return true;
  });

  if (bad.length > 0) {
    console.warn(
      `[MIRUS] sanitizeEntries: discarded ${bad.length} entries with out-of-range years ` +
      `(inferredYear=${inferredYear}, allowed ${minYear}–${maxYear}):`,
      bad.slice(0, 10),
    );
  }
  if (good.length === 0 && result.entries.length > 0) {
    console.error('[MIRUS] sanitizeEntries: ALL entries discarded — date parsing is completely wrong. Check XLSX date system.');
  }

  return { entries: good, dateRange: result.dateRange };
}

// ── Testable core: parse an already-extracted row grid ─────────────────────
//
// Gibt AUF ALLEN PFADEN ein `debug`-Objekt + `failureReason` zurück (GN-Parser-
// Diagnostik-Regel). `failureReason != null` ⇒ Import STOPPEN (nicht schreiben).

export function parseMirusRows(rows: unknown[][], fileName: string): MirusParseResult {
  const year = inferYear(rows);

  let reportType = 'classic';
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (/tägliche\s+stunden/i.test((rows[i] || []).map(c => String(c || '')).join(' '))) {
      reportType = 'report';
      break;
    }
  }

  const debug: MirusParseDebug = {
    fileName,
    totalRows: rows.length,
    inferredYear: year,
    reportType,
    detectedRange: null,
    columnStrategy: null,
    headerRowIdx: null,
    dateColumns: [],
    weekdayCheck: null,
    sampleRows: rows.slice(0, 12),
  };

  // Kostenträger-Kopf (Mandanten-Check, Spec Punkt 4) — auf allen Pfaden mitgeben.
  const costCenter = detectCostCenter(rows);
  if (costCenter) {
    console.log(`[MIRUS] cost center: «${costCenter.label}» → tenant ${costCenter.tenant ?? 'unbekannt'}`);
  }

  // Phase 1 → Phase 2: nimm den Lauf mit Einträgen; sonst den mit meisten Infos.
  const classic = runClassicParser(rows, year, fileName);
  const run = classic.entries.length > 0 ? classic : runReportParser(rows, year);

  if (run.detectedRange) {
    debug.detectedRange = {
      startIso: format(run.detectedRange.start, 'yyyy-MM-dd'),
      endIso: format(run.detectedRange.end, 'yyyy-MM-dd'),
    };
  }

  if (!run.detectedRange) {
    return { entries: [], dateRange: [], debug, costCenter, failureReason:
      'Kein Datumsbereich erkannt. Erwartet Titel «Tägliche Stunden von TT.MM.JJJJ bis TT.MM.JJJJ».' };
  }
  if (!run.resolved || run.resolved.dateColumns.length === 0) {
    return { entries: [], dateRange: [], debug, costCenter, failureReason:
      'Keine Tages-Spalten in der Kopfzeile gefunden. Erwartet Tageszahlen (z.B. 27, 28) je Stundenspalte.' };
  }

  debug.columnStrategy = run.resolved.strategy;
  debug.headerRowIdx = run.resolved.headerRowIdx;
  debug.dateColumns = run.resolved.dateColumns.map(dc => `${dc.date}→col${dc.index}`);

  // ── Plausibilitätscheck (Spec Punkt 1): Anzahl Tagesspalten muss dem
  //    Titel-Zeitraum (Enddatum − Startdatum + 1) entsprechen — sonst stoppen.
  {
    const expectedCount = buildExpectedDates(run.detectedRange.start, run.detectedRange.end).length;
    const gotCount = run.resolved.dateColumns.length;
    if (gotCount !== expectedCount) {
      return { entries: [], dateRange: [], debug, costCenter, failureReason:
        `Spalten-Plausibilitätscheck fehlgeschlagen: Titel-Zeitraum umfasst ${expectedCount} Tag(e), ` +
        `aber ${gotCount} Tagesspalte(n) erkannt. Import gestoppt, um eine falsche Tag-zu-Spalte-Zuordnung zu verhindern.` };
    }
  }

  // ── Wochentags-Gegenprobe (Off-by-one-Schutz, Spec Punkt 1) ──
  const wd = checkWeekdays(rows, run.resolved.headerRowIdx, run.resolved.dateColumns);
  debug.weekdayCheck = wd;
  if (wd.status === 'mismatch') {
    return { entries: [], dateRange: [], debug, costCenter, failureReason:
      `Wochentags-Prüfung fehlgeschlagen (Off-by-one-Schutz): ${wd.mismatches.slice(0, 5).join('; ')}. ` +
      'Import gestoppt, um falsch zugeordnete Tage zu verhindern.' };
  }
  if (wd.status === 'none-found') {
    // Konservativ (User-Priorität: keine falschen Tage, kein stiller Verlust):
    // Ohne Wochentags-Labels lässt sich die Tag-zu-Spalte-Zuordnung nicht
    // gegenprüfen → Import stoppen mit klarer Meldung statt riskieren.
    return { entries: [], dateRange: [], debug, costCenter, failureReason:
      'Wochentags-Gegenprobe nicht möglich: keine Wochentags-Beschriftung (Mo/Di/…) in oder über der ' +
      'Tageszahl-Kopfzeile gefunden. Import gestoppt, um eine ungeprüfte (evtl. falsche) Tageszuordnung ' +
      'zu vermeiden. Bitte Export mit Wochentagszeile verwenden.' };
  }

  const sane = sanitizeEntries({ entries: run.entries, dateRange: run.dateRange }, year);
  if (sane.entries.length === 0) {
    return { entries: [], dateRange: sane.dateRange, debug, costCenter, failureReason:
      'Keine gültigen Stunden-Einträge extrahiert (evtl. alle Datumswerte ausserhalb des Plausibilitätsbereichs).' };
  }

  return { entries: sane.entries, dateRange: sane.dateRange, debug, costCenter, failureReason: null };
}

// ── Main export ───────────────────────────────────────────────────────────

export async function parseMirusDailyExcel(
  file: File,
): Promise<MirusParseResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    // Do NOT use cellDates:true — it converts date-serial cells to JS Date objects
    // using the workbook's date system (1900 vs 1904). If the 1904 system is detected
    // (or mis-detected), all dates shift by exactly 1462 days (4 years), producing
    // dates like "November 2028" for a file that contains "November 2024" data.
    // Instead we keep raw numeric values and convert them ourselves via XLSX.SSF.parse_date_code.
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const rows: unknown[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    console.log(`[MIRUS] file: ${file.name}, total rows: ${rows.length}`);
    console.log('[MIRUS] first 10 rows:', rows.slice(0, 10));

    const result = parseMirusRows(rows, file.name);
    if (result.failureReason) {
      console.warn(`[MIRUS] parse stopped: ${result.failureReason}`, result.debug);
    } else {
      console.log(`[MIRUS] parse ok: ${result.entries.length} entries, strategy=${result.debug.columnStrategy}`);
    }
    return result;

  } catch (error) {
    console.error('[MIRUS] parsing error:', error);
    throw error;
  }
}
