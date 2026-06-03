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
];

function isSummaryRow(rowText: string, row: unknown[]): boolean {
  if (SUMMARY_RE.some(re => re.test(rowText))) return true;
  const first = String(row[0] || '').trim();
  if (/^\d+\s+\w+\s+total\b/i.test(first)) return true;
  return false;
}

// ── Department block detection ────────────────────────────────────────────

const DEPT_RE = /^\d+\s*(küche|kuche|service|geschäftsleitung|geschaftsleitung|leitung|admin)\b/i;

function detectDepartment(row: unknown[]): DetectedDept | null {
  for (const cell of row.slice(0, 8)) {
    const t = String(cell || '').trim();
    if (!DEPT_RE.test(t)) continue;
    const lo = t.toLowerCase();
    if (lo.includes('küch') || lo.includes('kuche')) return 'küche';
    if (lo.includes('service')) return 'service';
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
  if (DEPT_RE.test(s)) return false;
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
  let skipAdmin = false;

  for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!row || row.length === 0) continue;

    const rowText = row.map(c => String(c || '')).join(' ');

    // Department header
    const dept = detectDepartment(row);
    if (dept !== null) {
      if (dept === 'admin') {
        skipAdmin = true;
        console.log('[MIRUS] detected department block: admin (skipping)');
      } else {
        skipAdmin = false;
        currentDept = dept;
        console.log(`[MIRUS] detected department block: ${dept}`);
      }
      continue;
    }
    if (skipAdmin) continue;

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

  console.log(`[MIRUS] total parsed entries: ${entries.length}`);
  return entries;
}

// ── Resolve date columns for a given date range ───────────────────────────

function resolveDateColumns(
  rows: unknown[][],
  start: Date,
  end: Date,
  year: number,
): { headerRowIdx: number; dateColumns: DateColumn[] } | null {
  const expectedDates = buildExpectedDates(start, end);
  const expectedDays  = expectedDates.map(d => d.day);
  const minConsec     = Math.min(5, expectedDays.length);

  // Short-range (1-2 days): full-month offset approach takes priority
  if (expectedDays.length <= 2) {
    const fm = findFullMonthHeader(rows, start, expectedDates);
    if (fm) {
      console.log(`[MIRUS] detected day columns (full-month offset): ${fm.dateColumns.map(dc => `${dc.date}→col${dc.index}`).join(', ')}`);
      return fm;
    }
    // Date-cell fallback
    const dc = detectDateCellHeader(rows, year, 1);
    if (dc) {
      const reqSet = new Set(expectedDates.map(d => d.iso));
      let filtered = dc.dateColumns.filter(c => reqSet.has(c.date));
      if (filtered.length === 0) filtered = dc.dateColumns.slice(0, 1);
      console.log(`[MIRUS] detected day columns (date-cell): ${filtered.map(c => `${c.date}→col${c.index}`).join(', ')}`);
      return { headerRowIdx: dc.headerRowIdx, dateColumns: filtered };
    }
    // Last-resort: fixed column offset
    const fallbackCol = 5;
    const fallbackRow = (() => {
      const idx = rows.findIndex(r => /1\s*küche/i.test(String(r?.[0] || '')));
      return idx > 0 ? idx - 1 : 0;
    })();
    console.log(`[MIRUS] detected day columns (last-resort offset): col ${fallbackCol}`);
    return {
      headerRowIdx: fallbackRow,
      dateColumns: expectedDates.map(ed => ({ index: fallbackCol + (ed.day - 1), date: ed.iso })),
    };
  }

  // Multi-day: search for consecutive day number sequence
  const found = findDayNumberHeader(rows, expectedDays, start);
  if (found && found.dateColumns.length >= minConsec) {
    console.log(`[MIRUS] detected day columns: ${found.dateColumns.map(dc => `${dc.date}→col${dc.index}`).join(', ')}`);
    return { headerRowIdx: found.headerRowIdx, dateColumns: found.dateColumns };
  }

  // Fallback: first try date-cell detection
  const dc = detectDateCellHeader(rows, year, minConsec);
  if (dc) {
    console.log(`[MIRUS] detected day columns (date-cell fallback): ${dc.dateColumns.length} cols`);
    return dc;
  }

  // Last-resort: fixed column at 5
  const fallbackCol = 5;
  const fallbackRow = (() => {
    const idx = rows.findIndex(r => /1\s*küche/i.test(String(r?.[0] || '')));
    return idx > 0 ? idx - 1 : 0;
  })();
  console.log(`[MIRUS] detected day columns (last-resort): row ${fallbackRow}, col ${fallbackCol}`);
  return {
    headerRowIdx: fallbackRow,
    dateColumns: expectedDates.map(ed => ({ index: fallbackCol + (ed.day - 1), date: ed.iso })),
  };
}

// ── Phase 1: Classic parser ────────────────────────────────────────────────

function runClassicParser(
  rows: unknown[][],
  year: number,
  fileName: string,
): { entries: MirusDailyImportEntry[]; dateRange: string[] } {
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
    return { entries: [], dateRange: [] };
  }

  const resolved = resolveDateColumns(rows, dateRange.start, dateRange.end, year);
  if (!resolved || resolved.dateColumns.length === 0) {
    console.log('[MIRUS] classic parser: no date columns resolved');
    return { entries: [], dateRange: [] };
  }

  console.log(`[MIRUS] classic parser: header row ${resolved.headerRowIdx}, ${resolved.dateColumns.length} date cols`);
  const entries = parseEmployeeRows(rows, resolved.headerRowIdx, resolved.dateColumns);
  return { entries, dateRange: resolved.dateColumns.map(dc => dc.date) };
}

// ── Phase 2: Report-style parser ──────────────────────────────────────────

function runReportParser(
  rows: unknown[][],
  year: number,
): { entries: MirusDailyImportEntry[]; dateRange: string[] } {
  const dateRange = extractDateRange(rows, 50);
  if (!dateRange) {
    console.log('[MIRUS] report parser: no date range found');
    return { entries: [], dateRange: [] };
  }

  const resolved = resolveDateColumns(rows, dateRange.start, dateRange.end, year);
  if (!resolved || resolved.dateColumns.length === 0) {
    console.log('[MIRUS] report parser: no date columns resolved');
    return { entries: [], dateRange: [] };
  }

  console.log(`[MIRUS] report parser: header row ${resolved.headerRowIdx}, ${resolved.dateColumns.length} date cols`);
  const entries = parseEmployeeRows(rows, resolved.headerRowIdx, resolved.dateColumns);
  return { entries, dateRange: resolved.dateColumns.map(dc => dc.date) };
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

// ── Main export ───────────────────────────────────────────────────────────

export async function parseMirusDailyExcel(
  file: File,
): Promise<{ entries: MirusDailyImportEntry[]; dateRange: string[] }> {
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

    const year = inferYear(rows);
    console.log(`[MIRUS] inferred year: ${year}`);

    // Detect layout hint
    let reportType = 'classic';
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      if (/tägliche\s+stunden/i.test((rows[i] || []).map(c => String(c || '')).join(' '))) {
        reportType = 'report';
        break;
      }
    }
    console.log(`[MIRUS] detected report type: ${reportType}`);

    // Phase 1: Classic parser
    const classic = runClassicParser(rows, year, file.name);
    if (classic.entries.length > 0) {
      console.log(`[MIRUS] classic parser succeeded: ${classic.entries.length} entries`);
      return sanitizeEntries(classic, year);
    }

    // Phase 2: Report parser
    console.log('[MIRUS] classic parser found 0 entries, trying report parser...');
    const report = runReportParser(rows, year);
    if (report.entries.length > 0) {
      console.log(`[MIRUS] report parser succeeded: ${report.entries.length} entries`);
      return sanitizeEntries(report, year);
    }

    console.warn('[MIRUS] both parsers found 0 entries');
    return { entries: [], dateRange: [] };

  } catch (error) {
    console.error('[MIRUS] parsing error:', error);
    throw error;
  }
}
