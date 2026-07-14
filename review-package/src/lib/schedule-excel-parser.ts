import * as XLSX from 'xlsx';
import { ScheduleImportEntry } from '@/types/personnel';
import { getShiftConfigMap } from '@/hooks/useShiftConfig';

interface ParsedScheduleResult {
  entries: ScheduleImportEntry[];
  department: 'service' | 'küche';
  weekDates: string[];
  employeeCount: number;
  diagnostics?: {
    bestSheet?: string;
    dateRowFound: boolean;
    headerFound: boolean;
    parsedEmployees: number;
    parsedEntries: number;
  };
}

// Convert shift names like "Früh", "Spät", "Mittag" to actual time ranges
function resolveShiftNameToTimes(value: string): { start: string; end: string; hours: number } | null {
  if (!value) return null;
  
  const shiftMap = getShiftConfigMap();
  const normalized = value.trim();
  
  // Direct match
  if (shiftMap[normalized] && shiftMap[normalized].start && shiftMap[normalized].end) {
    return {
      start: shiftMap[normalized].start,
      end: shiftMap[normalized].end,
      hours: shiftMap[normalized].hours
    };
  }
  
  // Case-insensitive match
  const lowerValue = normalized.toLowerCase();
  for (const [name, config] of Object.entries(shiftMap)) {
    if (name.toLowerCase() === lowerValue && config.start && config.end) {
      return {
        start: config.start,
        end: config.end,
        hours: config.hours
      };
    }
  }
  
  // Match by abbreviation
  for (const [, config] of Object.entries(shiftMap)) {
    if (config.abbrev && config.abbrev.toLowerCase() === lowerValue && config.start && config.end) {
      return {
        start: config.start,
        end: config.end,
        hours: config.hours
      };
    }
  }
  
  return null;
}

function parseTimeValue(value: string | number | undefined | null): string {
  if (value === null || value === undefined) return '';

  const strValue = String(value).trim();

  // Skip "F" (frei) or other non-time values
  if (strValue.toUpperCase() === 'F' || strValue === '' || strValue === '-') {
    return '';
  }

  // Handle time ranges in a single cell (e.g. "11:00|23:00", "11:00-23:00")
  // NOTE: start/end extraction is handled in parseStartEnd(), but we keep this
  // normalization here for single times.

  // Handle time in HH:MM format
  if (strValue.includes(':')) {
    const parts = strValue.split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    if (!isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours <= 24) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
  }

  // Handle decimal time (Excel might store 0.5 for 12:00)
  const numValue = parseFloat(strValue.replace(',', '.'));
  if (!isNaN(numValue) && numValue >= 0 && numValue <= 1) {
    // Excel stores time as fraction of day
    const totalMinutes = Math.round(numValue * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }

  // Handle just hours (e.g., "11" or "23")
  const hourOnly = parseInt(strValue, 10);
  if (!isNaN(hourOnly) && hourOnly >= 0 && hourOnly <= 24) {
    return `${hourOnly.toString().padStart(2, '0')}:00`;
  }

  return '';
}

type StartEnd = { start: string; end: string };

function parseTimeRange(value: unknown): StartEnd & { hours?: number } {
  const raw = String(value ?? '').trim();
  if (!raw) return { start: '', end: '' };

  const upper = raw.toUpperCase();
  if (upper === 'F' || raw === '-' || raw === '—') return { start: '', end: '' };

  // First, check if it's a shift name like "Früh", "Spät", "Mittag"
  const shiftTimes = resolveShiftNameToTimes(raw);
  if (shiftTimes) {
    return { start: shiftTimes.start, end: shiftTimes.end, hours: shiftTimes.hours };
  }

  const normalized = raw.replace(/\s+/g, '').replace(/[–—]/g, '-');

  // strict patterns like 11:00|23:00, 11:00-23:00, 11-23
  const strict = normalized.match(/^([0-2]?\d)(?::([0-5]\d))?(?:\||-)([0-2]?\d)(?::([0-5]\d))?$/);
  if (strict) {
    const a = `${strict[1]}:${strict[2] ?? '00'}`;
    const b = `${strict[3]}:${strict[4] ?? '00'}`;
    return { start: parseTimeValue(a), end: parseTimeValue(b) };
  }

  // fallback: take first two times anywhere in the cell
  const times = normalized.match(/\b[0-2]?\d(?::[0-5]\d)?\b/g);
  if (times && times.length >= 2) {
    return { start: parseTimeValue(times[0]), end: parseTimeValue(times[1]) };
  }

  return { start: '', end: '' };
}

function parseStartEnd(cellA: unknown, cellB: unknown): StartEnd & { hours?: number } {
  // First check if cellA is a shift name like "Früh", "Spät", "Mittag"
  const cellAStr = String(cellA ?? '').trim();
  const shiftTimes = resolveShiftNameToTimes(cellAStr);
  if (shiftTimes) {
    return { start: shiftTimes.start, end: shiftTimes.end, hours: shiftTimes.hours };
  }

  const end = parseTimeValue(cellB as any);

  // If end is present, treat A/B as start/end columns
  if (end) {
    return { start: parseTimeValue(cellA as any), end };
  }

  // Otherwise, try to parse a range from the first cell (common in these plans)
  const range = parseTimeRange(cellA);
  if (range.start && range.end) return range;

  // Fallback: single time in A (not enough to create a shift)
  return { start: parseTimeValue(cellA as any), end: '' };
}

function parseStartEndFromRow(row: unknown[], startCol: number): StartEnd & { hours?: number } {
  // First check if the cell contains a shift name
  const cellValue = String(row[startCol] ?? '').trim();
  const shiftTimes = resolveShiftNameToTimes(cellValue);
  if (shiftTimes) {
    return { start: shiftTimes.start, end: shiftTimes.end, hours: shiftTimes.hours };
  }

  // 1) Adjacent columns (classic)
  const direct = parseStartEnd(row[startCol], row[startCol + 1]);
  if (direct.start && direct.end) return direct;

  // 2) If start is present but end is a couple columns later (common when there are "spacer" columns)
  const start = parseTimeValue(row[startCol] as any);
  if (start && !direct.end) {
    for (let offset = 2; offset <= 3; offset++) {
      const maybeEnd = parseTimeValue(row[startCol + offset] as any);
      if (maybeEnd) return { start, end: maybeEnd };
    }
  }

  // 3) If start cell contains a range (11:00|23:00) or a shift name
  const range = parseTimeRange(row[startCol]);
  if (range.start && range.end) return range;

  return direct;
}

function calculateHoursFromTimes(start: string, end: string): number {
  if (!start || !end) return 0;

  const startParts = start.split(':');
  const endParts = end.split(':');

  if (startParts.length !== 2 || endParts.length !== 2) return 0;

  const startH = parseInt(startParts[0], 10);
  const startM = parseInt(startParts[1], 10);
  const endH = parseInt(endParts[0], 10);
  const endM = parseInt(endParts[1], 10);

  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return 0;

  let startMinutes = startH * 60 + startM;
  let endMinutes = endH * 60 + endM;

  // Handle overnight shifts (e.g., 17:00 - 00:30)
  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60;
  }

  return (endMinutes - startMinutes) / 60;
}

function parseDateFromRow(row: (string | number)[]): string[] {
  const dates: string[] = [];
  
  for (let i = 0; i < row.length; i++) {
    const cell = String(row[i] || '').trim();
    const dateMatch = cell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10);
      const year = parseInt(dateMatch[3], 10);
      
      const date = new Date(year, month - 1, day);
      dates.push(date.toISOString().split('T')[0]);
    }
  }
  
  return dates;
}

function isSkippableName(name: string): boolean {
  const nameLower = name.toLowerCase().trim();
  const skipPatterns = [
    'vorgaben', 'früh', 'spät', 'pause', 'name',
    'januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli',
    'august', 'september', 'oktober', 'november', 'dezember',
    'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag',
    'labor', 'umsatz', 'bar/pass', 'service unten', 'service oben', 'event',
    'corner bar', 'schulung', 'kochen', 'pizza', 'sushi', 'pass', 'spüle',
    'produktion', 'kalte küche', 'feiertag', 'ferien', 'krank',
    'dienstplan', 'k-woche', 'stundenansatz', 'gesamt', 'woche',
    'f= frei', 'ft=', 'fe=', 'ko=', 'mi=', 'ms=', 'fw=', 'k=',
    'plus', 'stunde', 'fr.'
  ];
  
  // Skip if matches pattern
  if (skipPatterns.some(p => nameLower.includes(p))) return true;
  
  // Skip if looks like time (HH:MM or H:MM)
  if (/^\d{1,2}:\d{2}/.test(name)) return true;
  
  // Skip if just a number
  if (/^\d+$/.test(name)) return true;
  
  // Skip if just "F" or empty
  if (nameLower === 'f' || nameLower === '') return true;
  
  // Skip if contains only numbers and colons (time totals like 84:30:00)
  if (/^\d+:\d+:\d+$/.test(name)) return true;
  
  return false;
}

export async function parseScheduleExcel(file: File): Promise<ParsedScheduleResult> {
  try {
    const buffer = await file.arrayBuffer();
    const data = new Uint8Array(buffer);

    const workbook = XLSX.read(data, { type: 'array' });
    console.log('Parsing Schedule Excel, sheets:', workbook.SheetNames);

    // Detect department from filename
    let department: 'service' | 'küche' = 'service';
    const fileName = file.name.toLowerCase();
    if (fileName.includes('küche') || fileName.includes('kuche') || fileName.includes('kitchen')) {
      department = 'küche';
    }
    console.log('Detected department from filename:', department);

    type SheetParseResult = {
      sheetName: string;
      entries: ScheduleImportEntry[];
      weekDates: string[];
      employeeNames: Set<string>;
      diagnostics: {
        dateRowFound: boolean;
        headerFound: boolean;
        parsedEmployees: number;
        parsedEntries: number;
        nameColumns?: number[];
        dateColumns?: number[];
        fruehSpaetColumns?: { dayIdx: number; fruehCol: number; spaetCol: number }[];
      };
    };

    const tryParseSheet = (sheetName: string): SheetParseResult => {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) {
        return {
          sheetName,
          entries: [],
          weekDates: [],
          employeeNames: new Set<string>(),
          diagnostics: { dateRowFound: false, headerFound: false, parsedEmployees: 0, parsedEntries: 0 },
        };
      }

      // Convert to array of arrays with formatted values.
      // raw:false is important for these templates because dates appear formatted as strings.
      const rows: (string | number)[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        raw: false,
      });

      console.log(`Sheet "${sheetName}" has ${rows.length} rows`);

      const entries: ScheduleImportEntry[] = [];
      const employeeNames = new Set<string>();
      let weekDates: string[] = [];

      // ===== Heuristik 1: Name-Spalte(n) erkennen =====
      // In den Arbeitsplan-Vorlagen ist "NAME" oft eine Kopfzelle, aber die echten Namen
      // können (wegen gemergter Zellen) 1 Spalte rechts davon stehen.
      let nameHeaderColIdx = -1;

      for (let i = 0; i < Math.min(50, rows.length); i++) {
        const row = rows[i];
        if (!row) continue;
        for (let j = 0; j < Math.min(row.length, 20); j++) {
          const cell = String(row[j] || '').toLowerCase().trim();
          if (cell === 'name') {
            nameHeaderColIdx = j;
            break;
          }
        }
        if (nameHeaderColIdx !== -1) break;
      }

      const candidateNameCols = (() => {
        const cols: number[] = [];
        const push = (n: number) => {
          if (n >= 0 && !cols.includes(n)) cols.push(n);
        };

        if (nameHeaderColIdx !== -1) {
          push(nameHeaderColIdx);
          push(nameHeaderColIdx + 1);
          push(nameHeaderColIdx - 1);
        }

        // Fallbacks (typisch: B oder C)
        push(1);
        push(2);
        push(0);
        push(3);
        push(4);
        return cols;
      })();

      // ===== Heuristik 2: Datumszeile + Tagesblock-Startspalten erkennen =====
      let dateRowIdx = -1;
      let dateColumns: number[] = [];

      const toIsoFromExcelSerial = (serial: number): string | null => {
        const dc = XLSX.SSF.parse_date_code(serial);
        if (!dc || !dc.y || !dc.m || !dc.d) return null;
        const dt = new Date(dc.y, dc.m - 1, dc.d);
        if (isNaN(dt.getTime())) return null;
        return dt.toISOString().split('T')[0];
      };

      const parseDateCell = (value: unknown): string | null => {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number' && value > 20000 && value < 60000) {
          return toIsoFromExcelSerial(value);
        }
        const cell = String(value).trim();
        const m = cell.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
        if (m) {
          const day = parseInt(m[1], 10);
          const month = parseInt(m[2], 10);
          const yearRaw = parseInt(m[3], 10);
          const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
          const dt = new Date(year, month - 1, day);
          if (!isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
        }
        return null;
      };

      for (let i = 0; i < Math.min(80, rows.length); i++) {
        const row = rows[i];
        if (!row) continue;

        const found: { iso: string; colIdx: number }[] = [];
        for (let colIdx = 0; colIdx < row.length; colIdx++) {
          const iso = parseDateCell(row[colIdx]);
          if (iso) found.push({ iso, colIdx });
        }

        if (found.length >= 7) {
          dateRowIdx = i;
          // unique + sort by column
          const unique = new Map<string, number>();
          for (const f of found) if (!unique.has(f.iso)) unique.set(f.iso, f.colIdx);

          const sorted = Array.from(unique.entries())
            .sort((a, b) => a[1] - b[1])
            .slice(0, 7);

          weekDates = sorted.map((x) => x[0]);
          dateColumns = sorted.map((x) => x[1]);
          console.log('Found week dates at row', i, ':', weekDates, 'dateColumns:', dateColumns);
          break;
        }
      }

      if (weekDates.length === 0) {
        // Fallback: generate dates from current week
        const today = new Date();
        const mondayOffset = today.getDay() === 0 ? -6 : 1 - today.getDay();
        const monday = new Date(today);
        monday.setDate(today.getDate() + mondayOffset);

        for (let i = 0; i < 7; i++) {
          const date = new Date(monday);
          date.setDate(monday.getDate() + i);
          weekDates.push(date.toISOString().split('T')[0]);
        }
        console.log('Generated week dates:', weekDates);
      }

      // ===== Heuristik 3: Früh/Spät-Blöcke pro Tag erkennen =====
      let headerRowIdx = -1;
      let fruehSpaetColumns: { dayIdx: number; fruehCol: number; spaetCol: number }[] = [];

      const headerScanStart = 0;
      const headerScanEnd = Math.min(rows.length, dateRowIdx !== -1 ? dateRowIdx + 80 : 160);

      const isFrueh = (v: unknown) => {
        const s = String(v ?? '').toLowerCase().trim();
        return s === 'früh' || s === 'frueh';
      };
      const isSpaet = (v: unknown) => {
        const s = String(v ?? '').toLowerCase().trim();
        return s === 'spät' || s === 'spaet';
      };

      for (let i = headerScanStart; i < headerScanEnd; i++) {
        const row = rows[i];
        if (!row) continue;

        const rowText = row.map((c) => String(c || '').toLowerCase()).join(' ');
        const hasFrueh = rowText.includes('früh') || rowText.includes('frueh');
        const hasSpaet = rowText.includes('spät') || rowText.includes('spaet');

        if (!hasFrueh || !hasSpaet) continue;

        headerRowIdx = i;

        // Prefer mapping based on the detected date columns (this avoids picking the Umsatz-Früh/Spät block)
        if (dateColumns.length >= 7) {
          for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
            const dayStart = dateColumns[dayIdx];

            // In these templates, "Früh" often sits exactly at the dayStart column.
            let fruehCol = dayStart;
            for (let c = Math.max(0, dayStart - 2); c <= Math.min(row.length - 1, dayStart + 2); c++) {
              if (isFrueh(row[c])) {
                fruehCol = c;
                break;
              }
            }

            let spaetCol = -1;
            for (let offset = 1; offset <= 10; offset++) {
              const c = fruehCol + offset;
              if (c < row.length && isSpaet(row[c])) {
                spaetCol = c;
                break;
              }
            }

            // If labels are missing, assume the standard pattern: Früh then (blank) then Spät
            if (spaetCol === -1) spaetCol = fruehCol + 2;

            fruehSpaetColumns.push({ dayIdx, fruehCol, spaetCol });
          }
        } else {
          // Generic fallback: take first 7 Früh/Spät pairs from left to right
          let currentDayIdx = 0;
          for (let colIdx = 0; colIdx < row.length && currentDayIdx < 7; colIdx++) {
            if (isFrueh(row[colIdx])) {
              for (let spaetOffset = 1; spaetOffset <= 10; spaetOffset++) {
                const spaetCol = colIdx + spaetOffset;
                if (spaetCol < row.length && isSpaet(row[spaetCol])) {
                  fruehSpaetColumns.push({ dayIdx: currentDayIdx, fruehCol: colIdx, spaetCol });
                  currentDayIdx++;
                  break;
                }
              }
            }
          }
        }

        console.log('Found Früh/Spät header at row', i);
        console.log('Column mapping:', fruehSpaetColumns);
        break;
      }

      const startRow = headerRowIdx !== -1 ? headerRowIdx + 1 : Math.max(0, (dateRowIdx !== -1 ? dateRowIdx + 3 : 0));
      let currentDepartment = department;

      const pickEmployeeName = (row: (string | number)[]): string => {
        for (const col of candidateNameCols) {
          const v = String(row[col] || '').trim();
          if (v && v.length >= 2 && !isSkippableName(v)) return v;
        }
        return '';
      };

      for (let rowIdx = startRow; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length < 3) continue;

        const rowText = row.map((c) => String(c || '').toLowerCase()).join(' ');

        // Stop at legend sections
        if (rowText.includes('f= frei') || rowText.includes('ft= feiertag')) {
          break;
        }

        // Handle department markers in column A
        const colA = String(row[0] || '').toLowerCase().trim();
        if (colA === 'küche' || colA === 'kuche') {
          currentDepartment = 'küche';
        } else if (colA === 'service') {
          currentDepartment = 'service';
        }

        const nameCell = pickEmployeeName(row);
        if (!nameCell) continue;

        // Process each day
        if (fruehSpaetColumns.length > 0) {
          for (const dayMapping of fruehSpaetColumns) {
            if (dayMapping.dayIdx >= weekDates.length) continue;

            const frueh = parseStartEndFromRow(row as unknown[], dayMapping.fruehCol);
            const spaet = parseStartEndFromRow(row as unknown[], dayMapping.spaetCol);

            let totalHours = 0;
            let firstStart = '';
            let lastEnd = '';

            if (frueh.start && frueh.end) {
              totalHours += calculateHoursFromTimes(frueh.start, frueh.end);
              firstStart = frueh.start;
              lastEnd = frueh.end;
            }

            if (spaet.start && spaet.end) {
              totalHours += calculateHoursFromTimes(spaet.start, spaet.end);
              if (!firstStart) firstStart = spaet.start;
              lastEnd = spaet.end;
            }

            if (totalHours > 0) {
              employeeNames.add(nameCell);
              entries.push({
                name: nameCell,
                department: currentDepartment,
                date: weekDates[dayMapping.dayIdx],
                plannedHours: Math.round(totalHours * 100) / 100,
                plannedStart: firstStart,
                plannedEnd: lastEnd,
              });
            }
          }
        } else {
          // Fallback: assume each day has 2 columns with a possible range inside a single cell
          // starting after NAME block (heuristic base: C)
          for (let dayIdx = 0; dayIdx < 7 && dayIdx < weekDates.length; dayIdx++) {
            const baseCol = 2 + dayIdx * 2;
            const shift = parseStartEndFromRow(row as unknown[], baseCol);

            if (shift.start && shift.end) {
              const hours = calculateHoursFromTimes(shift.start, shift.end);
              if (hours > 0) {
                employeeNames.add(nameCell);
                entries.push({
                  name: nameCell,
                  department: currentDepartment,
                  date: weekDates[dayIdx],
                  plannedHours: Math.round(hours * 100) / 100,
                  plannedStart: shift.start,
                  plannedEnd: shift.end,
                });
              }
            }
          }
        }
      }

      const uniqueEntries = deduplicateEntries(entries);

      const diagnostics = {
        dateRowFound: dateRowIdx !== -1,
        headerFound: headerRowIdx !== -1 && fruehSpaetColumns.length > 0,
        parsedEmployees: employeeNames.size,
        parsedEntries: uniqueEntries.length,
        nameColumns: candidateNameCols,
        dateColumns,
        fruehSpaetColumns,
      };

      return { sheetName, entries: uniqueEntries, weekDates, employeeNames, diagnostics };
    };

    let best: SheetParseResult | null = null;

    for (const sheetName of workbook.SheetNames) {
      const parsed = tryParseSheet(sheetName);
      if (!best || parsed.entries.length > best.entries.length) {
        best = parsed;
      }
    }

    if (!best) {
      return {
        entries: [],
        department,
        weekDates: [],
        employeeCount: 0,
        diagnostics: { bestSheet: undefined, dateRowFound: false, headerFound: false, parsedEmployees: 0, parsedEntries: 0 },
      };
    }

    console.log('=== PARSING COMPLETE ===');
    console.log('Best sheet:', best.sheetName);
    console.log('Total unique entries found:', best.entries.length);
    console.log('Employees:', Array.from(best.employeeNames));
    console.log('Department:', department);

    return {
      entries: best.entries,
      department,
      weekDates: best.weekDates,
      employeeCount: best.employeeNames.size,
      diagnostics: {
        bestSheet: best.sheetName,
        dateRowFound: best.diagnostics.dateRowFound,
        headerFound: best.diagnostics.headerFound,
        parsedEmployees: best.diagnostics.parsedEmployees,
        parsedEntries: best.diagnostics.parsedEntries,
      },
    };
  } catch (error) {
    console.error('Excel parsing error:', error);
    throw new Error(
      'Fehler beim Lesen der Excel-Datei: ' + (error instanceof Error ? error.message : 'Unbekannter Fehler')
    );
  }
}

function deduplicateEntries(entries: ScheduleImportEntry[]): ScheduleImportEntry[] {
  const seen = new Map<string, ScheduleImportEntry>();
  
  for (const entry of entries) {
    const key = `${entry.name}-${entry.date}`;
    const existing = seen.get(key);
    
    // Keep the entry with more hours
    if (!existing || entry.plannedHours > existing.plannedHours) {
      seen.set(key, entry);
    }
  }
  
  return Array.from(seen.values());
}

export function aggregateScheduleByEmployee(entries: ScheduleImportEntry[]): {
  name: string;
  department: 'service' | 'küche';
  totalHours: number;
  days: number;
}[] {
  const byEmployee = new Map<string, {
    name: string;
    department: 'service' | 'küche';
    totalHours: number;
    dates: Set<string>;
  }>();
  
  entries.forEach(entry => {
    const key = entry.name;
    const existing = byEmployee.get(key);
    
    if (existing) {
      existing.totalHours += entry.plannedHours;
      existing.dates.add(entry.date);
    } else {
      byEmployee.set(key, {
        name: entry.name,
        department: entry.department,
        totalHours: entry.plannedHours,
        dates: new Set([entry.date]),
      });
    }
  });
  
  return Array.from(byEmployee.values()).map(emp => ({
    name: emp.name,
    department: emp.department,
    totalHours: emp.totalHours,
    days: emp.dates.size,
  }));
}
