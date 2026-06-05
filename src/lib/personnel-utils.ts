import { Employee, TimeEntry, DailySummary, EmploymentType, MirusImportEntry, MirusDailyImportEntry } from '@/types/personnel';
import * as XLSX from 'xlsx';
import { format, parse, addDays, endOfMonth } from 'date-fns';

/**
 * Kanonischer Anzeigename eines Mitarbeiters aus dem Personalstamm.
 * Einzige Quelle der Wahrheit für alle Namensanzeigen im Dienstplan.
 * Niemals Roh-Importnamen (z.B. aus Mirus-Exporten) direkt anzeigen.
 * Robust gegen null / undefined / fehlende Felder.
 */
export function getEmployeeDisplayName(
  emp: { name?: string | null; display_name?: string | null } | null | undefined
): string {
  if (!emp) return 'Unbekannter Mitarbeiter';
  const name = (emp as { display_name?: string | null }).display_name?.trim()
    || emp.name?.trim();
  return name || 'Unbekannter Mitarbeiter';
}

/**
 * Prüft ob ein Mitarbeiter im angegebenen Monat aktiv war.
 *
 * Regeln:
 *  - Kein Austrittsdatum → aktiv
 *  - Austrittsdatum vor Monatsbeginn → NICHT aktiv (z.B. Austritt 30.04 → Mai = nicht aktiv)
 *  - Austrittsdatum im oder nach dem Monat → aktiv (z.B. Austritt 15.05 → Mai = aktiv)
 *  - Kein Eintrittsdatum (contractStart) → aktiv
 *  - Eintrittsdatum nach Monatsende → NICHT aktiv (z.B. Eintritt 01.06 → Mai = nicht aktiv)
 *  - Eintrittsdatum im oder vor dem Monat → aktiv (z.B. Eintritt 15.05 → Mai = aktiv)
 */
export function isEmployeeActiveInMonth(
  emp: { employmentEndDate?: string | null; contractStart?: string | null; isActive?: boolean },
  year: number,
  month: number,
): boolean {
  // Explizit deaktiviert (archiveEmployee hat is_active=false gesetzt) → nie aktiv
  if (emp.isActive === false) return false;

  if (emp.employmentEndDate) {
    const exit = new Date(emp.employmentEndDate + 'T00:00:00');
    const exitYear  = exit.getFullYear();
    const exitMonth = exit.getMonth() + 1;
    if (exitYear < year || (exitYear === year && exitMonth < month)) {
      return false;
    }
  }
  if (emp.contractStart) {
    const entry = new Date(emp.contractStart + 'T00:00:00');
    const entryYear  = entry.getFullYear();
    const entryMonth = entry.getMonth() + 1;
    if (entryYear > year || (entryYear === year && entryMonth > month)) {
      return false;
    }
  }
  return true;
}

/**
 * Prüft ob ein Mitarbeiter an einem bestimmten Datum aktiv ist.
 * Tages-granular — für Personalstamm-Standardansicht (Stand: heute).
 *
 * Regeln (per Spezifikation):
 *  - isActive === false → ausgetreten (explizit archiviert)
 *  - kein Austrittsdatum → aktiv
 *  - Austrittsdatum >= referenceDate → aktiv (letzter Arbeitstag gilt noch)
 *  - Austrittsdatum <  referenceDate → ausgetreten
 *
 * Beispiel: Ali, Austritt 2026-03-31, referenceDate = 2026-04-01 → ausgetreten
 *           Ali, Austritt 2026-03-31, referenceDate = 2026-03-31 → aktiv (letzter Tag)
 */
export function isEmployeeActiveForDate(
  emp: { employmentEndDate?: string | null; isActive?: boolean },
  referenceDate: Date,
): boolean {
  if (emp.isActive === false) return false;
  if (!emp.employmentEndDate) return true;
  const exit = new Date(emp.employmentEndDate + 'T00:00:00');
  // Datumsvergleich ohne Uhrzeit
  const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  return exit >= ref;
}

export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
  }).format(value);
};

export const formatHours = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${m.toString().padStart(2, '0')}`;
};

export const parseTimeString = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours + minutes / 60;
};

export const calculateHours = (start: string, end: string, breakMinutes: number = 0): number => {
  const startHours = parseTimeString(start);
  let endHours = parseTimeString(end);
  
  // Handle overnight shifts
  if (endHours < startHours) {
    endHours += 24;
  }
  
  return Math.max(0, endHours - startHours - breakMinutes / 60);
};

export const getEmploymentTypeLabel = (type: EmploymentType): string => {
  const labels: Record<EmploymentType, string> = {
    vollzeit: 'Vollzeit',
    teilzeit: 'Teilzeit',
    minijob: 'Minijob',
    aushilfe: 'Aushilfe',
  };
  return labels[type];
};

export const getEmploymentTypeBadgeClass = (type: EmploymentType): string => {
  const classes: Record<EmploymentType, string> = {
    vollzeit: 'badge-fulltime',
    teilzeit: 'badge-parttime',
    minijob: 'badge-minijob',
    aushilfe: 'badge-parttime',
  };
  return classes[type];
};

export const calculateDailySummary = (
  entries: TimeEntry[],
  employees: Employee[],
  plannedRevenue: number,
  actualRevenue: number
): DailySummary => {
  let totalPlannedHours = 0;
  let totalActualHours = 0;
  let totalPlannedCost = 0;
  let totalActualCost = 0;

  entries.forEach((entry) => {
    const employee = employees.find((e) => e.id === entry.employeeId);
    if (!employee) return;

    totalPlannedHours += entry.plannedHours;
    totalPlannedCost += entry.plannedHours * employee.hourlyWage;

    if (entry.actualHours !== undefined) {
      totalActualHours += entry.actualHours;
      totalActualCost += entry.actualHours * employee.hourlyWage;
    }
  });

  const laborCostPercentage = actualRevenue > 0 
    ? (totalActualCost / actualRevenue) * 100 
    : 0;

  const variance = totalPlannedCost - totalActualCost;

  return {
    date: entries[0]?.date || new Date().toISOString().split('T')[0],
    totalPlannedHours,
    totalActualHours,
    totalPlannedCost,
    totalActualCost,
    plannedRevenue,
    actualRevenue,
    laborCostPercentage,
    variance,
  };
};

export const parseScheduleText = (text: string): Partial<TimeEntry>[] => {
  const lines = text.trim().split('\n');
  const entries: Partial<TimeEntry>[] = [];

  lines.forEach((line) => {
    // Try to parse common schedule formats
    // Format: Name HH:MM - HH:MM
    const timePattern = /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/;
    const match = line.match(timePattern);

    if (match) {
      const [, start, end] = match;
      const hours = calculateHours(start, end);
      
      // Extract name (everything before the time)
      const nameMatch = line.substring(0, line.indexOf(match[0])).trim();
      
      if (nameMatch) {
        entries.push({
          plannedStart: start,
          plannedEnd: end,
          plannedHours: hours,
        });
      }
    }
  });

  return entries;
};

// Parse Mirus Excel export ("Tägliche Stunden" format)
export const parseMirusExcel = (file: File): Promise<MirusImportEntry[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to array of arrays
        const rows: (string | number)[][] = XLSX.utils.sheet_to_json(worksheet, { 
          header: 1,
          defval: ''
        });
        
        const entries: MirusImportEntry[] = [];
        let currentDepartment: 'küche' | 'service' = 'service';
        
        console.log('Parsing Mirus Excel, total rows:', rows.length);
        console.log('First 5 rows:', rows.slice(0, 5));
        
        rows.forEach((row, rowIndex) => {
          // Skip empty rows
          if (!row || row.length === 0) return;
          
          const rowText = row.map(cell => String(cell || '').toLowerCase()).join(' ');
          
          // Detect department headers
          if (rowText.includes('küche') && !rowText.includes('total')) {
            currentDepartment = 'küche';
            console.log('Switched to Küche at row', rowIndex);
            return;
          }
          if (rowText.includes('service') && !rowText.includes('total')) {
            currentDepartment = 'service';
            console.log('Switched to Service at row', rowIndex);
            return;
          }
          
          // Skip header rows and total rows
          if (rowText.includes('total') || rowText.includes('anzahl') || 
              rowText.includes('tägliche stunden') || rowText.includes('datum') ||
              rowText.includes('restaurant') || rowText.includes('waisenhausplatz') ||
              rowText.includes('bern') || rowText.includes('mo') && rowText.includes('di') ||
              rowText.includes('filter')) {
            return;
          }
          
          // NEW FORMAT: Name in column A (index 0), hours in subsequent columns
          // Try column A first, then column B for name
          let nameCell = String(row[0] || '').trim();
          let hoursStartIndex = 1;
          
          // If column A is empty or just a number, try column B
          if (!nameCell || nameCell.length < 2 || /^\d+$/.test(nameCell)) {
            nameCell = String(row[1] || '').trim();
            hoursStartIndex = 2;
          }
          
          // Skip if no valid name
          if (!nameCell || nameCell.length < 2) {
            return;
          }
          
          // Skip if it looks like a header (Mo, Di, Total, etc.)
          const nameLower = nameCell.toLowerCase();
          if (nameLower === 'mo' || nameLower === 'di' || nameLower === 'mi' || 
              nameLower === 'do' || nameLower === 'fr' || nameLower === 'sa' || 
              nameLower === 'so' || nameLower === 'total') {
            return;
          }
          
          // Sum up all hours from remaining columns (multiple days)
          let totalHours = 0;
          for (let i = hoursStartIndex; i < row.length; i++) {
            const cellValue = row[i];
            let cellHours = 0;
            
            if (typeof cellValue === 'number' && cellValue >= 0) {
              cellHours = cellValue;
            } else if (typeof cellValue === 'string' && cellValue.trim()) {
              const parsed = parseFloat(cellValue.replace(',', '.'));
              if (!isNaN(parsed) && parsed >= 0) {
                cellHours = parsed;
              }
            }
            
            // Only add reasonable daily hours (0-24)
            if (cellHours > 0 && cellHours <= 24) {
              totalHours += cellHours;
            }
          }
          
          // If we found a name and any hours, add the entry
          if (nameCell && totalHours > 0) {
            console.log(`Found: ${nameCell} - ${totalHours.toFixed(2)}h (${currentDepartment})`);
            entries.push({
              name: nameCell,
              department: currentDepartment,
              hours: Math.round(totalHours * 100) / 100 // Round to 2 decimals
            });
          }
        });
        
        console.log('Total entries found:', entries.length);
        resolve(entries);
      } catch (error) {
        console.error('Excel parsing error:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Fehler beim Lesen der Datei'));
    reader.readAsBinaryString(file);
  });
};

// Parse text-based Mirus export (copy-paste from PDF or screen)
export const parseMirusText = (text: string): MirusImportEntry[] => {
  const lines = text.trim().split('\n');
  const entries: MirusImportEntry[] = [];
  let currentDepartment: 'küche' | 'service' = 'service';
  
  lines.forEach((line) => {
    const trimmedLine = line.trim().toLowerCase();
    
    // Detect department
    if (trimmedLine.includes('küche') && !trimmedLine.includes('total')) {
      currentDepartment = 'küche';
      return;
    }
    if (trimmedLine.includes('service') && !trimmedLine.includes('total')) {
      currentDepartment = 'service';
      return;
    }
    
    // Skip headers and totals
    if (trimmedLine.includes('total') || trimmedLine.includes('anzahl') || 
        trimmedLine.includes('filter') || trimmedLine.includes('name') ||
        trimmedLine.includes('jahr') || trimmedLine.includes('kostenstelle')) {
      return;
    }
    
    // Try to extract name and hours
    // Pattern: Name followed by decimal number (hours)
    const hoursPattern = /(\d+[.,]\d+)\s*$/;
    const hoursMatch = line.match(hoursPattern);
    
    if (hoursMatch) {
      const hours = parseFloat(hoursMatch[1].replace(',', '.'));
      const name = line.substring(0, line.lastIndexOf(hoursMatch[0])).trim();
      
      if (name && hours > 0) {
        entries.push({
          name,
          department: currentDepartment,
          hours
        });
      }
    }
  });
  
  return entries;
};

// Parse Mirus "Tägliche Stunden" PDF format with daily columns
export const parseMirusDailyPDF = async (
  file: File
): Promise<{ entries: MirusDailyImportEntry[]; dateRange: string[] }> => {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Extract all text from PDF (row-wise)
  let fullText = '';
  const allRows: string[][] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const rowMap = new Map<number, { x: number; text: string }[]>();

    textContent.items.forEach((item: any) => {
      const y = Math.round(item.transform[5] / 5) * 5;
      const x = item.transform[4];
      const text = item.str?.trim?.() || '';
      if (!text) return;

      if (!rowMap.has(y)) rowMap.set(y, []);
      rowMap.get(y)!.push({ x, text });
    });

    const sortedYs = Array.from(rowMap.keys()).sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = rowMap.get(y)!.sort((a, b) => a.x - b.x);
      const row = items.map((i) => i.text);
      allRows.push(row);
      fullText += row.join(' ') + '\n';
    }
  }

  console.log('[mirus-daily][pdf] text head:', fullText.substring(0, 600));

  // 1) Dienstplan-Auszug (single day, table with "Kostenstelle")
  const isDienstplanAuszug = /\bdienstplan\b/i.test(fullText) && /kostenstelle/i.test(fullText);
  if (isDienstplanAuszug) {
    const dateMatch = fullText.match(/Monat\s*(\d{2}\.\d{2}\.\d{4})/i);
    const date = dateMatch ? parse(dateMatch[1], 'dd.MM.yyyy', new Date()) : null;
    const dateIso = date ? format(date, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');

    const entries: MirusDailyImportEntry[] = [];

    for (const row of allRows) {
      const rowStr = row.join(' ').trim();
      if (!rowStr) continue;

      // Skip header / legend
      const lower = rowStr.toLowerCase();
      if (lower.includes('dienstplan') || lower.includes('fehler') || lower.includes('fehlzeiten') || lower.includes('abwesenheit')) continue;
      if (lower.includes('name') && lower.includes('kostenstelle')) continue;

      // Tokenize and locate year (2026)
      const tokens = rowStr.split(/\s+/).filter(Boolean);
      const yearIdx = tokens.findIndex((t) => /^20\d{2}$/.test(t));
      if (yearIdx === -1) continue;

      const name = tokens.slice(0, yearIdx).join(' ');
      if (name.length < 3) continue;

      // Find department via kostenstelle after year: e.g. "2 Service" or "1 Küche"
      const afterYear = tokens.slice(yearIdx + 1);
      const deptIdx = afterYear.findIndex((t) => /service|küche|kuche/i.test(t));
      if (deptIdx === -1) continue;

      const deptToken = afterYear[deptIdx].toLowerCase();
      const department: 'service' | 'küche' = deptToken.includes('küch') || deptToken.includes('kuche') ? 'küche' : 'service';

      const valueTokens = afterYear.slice(deptIdx + 1);
      let total = 0;
      for (const t of valueTokens) {
        // Some exports put "FE" strings into the table; ignore non-numeric
        const n = parseFloat(t.replace(',', '.'));
        if (!isNaN(n)) total += n;
      }

      // Only create an entry if there are hours 
      if (total > 0) {
        entries.push({
          name,
          department,
          date: dateIso,
          hours: Math.round(total * 100) / 100,
        });
      }
    }

    console.log('[mirus-daily][pdf][dienstplan] entries:', entries.length, entries.slice(0, 10));
    return { entries, dateRange: [dateIso] };
  }

  // 2) "Tägliche Stunden" month grid (has "von .. bis ..")
  const dateRangeMatch = fullText.match(/von\s*(\d{2}\.\d{2}\.\d{4})\s*bis\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (!dateRangeMatch) {
    console.warn('[mirus-daily][pdf] no date range found');
    return { entries: [], dateRange: [] };
  }

  const startDate = parse(dateRangeMatch[1], 'dd.MM.yyyy', new Date());
  const endDate = parse(dateRangeMatch[2], 'dd.MM.yyyy', new Date());
  console.log('[mirus-daily][pdf] found date range:', dateRangeMatch[1], 'to', dateRangeMatch[2]);

  const dateColumns: string[] = [];
  let currentDate = startDate;
  while (currentDate <= endDate) {
    dateColumns.push(format(currentDate, 'yyyy-MM-dd'));
    currentDate = addDays(currentDate, 1);
  }

  const entries: MirusDailyImportEntry[] = [];
  let currentDepartment: 'küche' | 'service' = 'küche';

  for (const row of allRows) {
    const rowText = row.join(' ').toLowerCase();

    if ((rowText.includes('küche') || rowText.includes('kuche')) && !rowText.includes('total')) {
      currentDepartment = 'küche';
      continue;
    }
    if (rowText.includes('service') && !rowText.includes('total')) {
      currentDepartment = 'service';
      continue;
    }

    if (rowText.includes('tägliche stunden') || rowText.includes('restaurant') || rowText.includes('waisenhausplatz') || rowText.includes('bern') || rowText.includes('seite')) {
      continue;
    }

    const numericTokenIdx = row.findIndex((t) => /^\d+(?:[.,]\d+)?$/.test(String(t).trim()));
    if (numericTokenIdx === -1) continue;

    const employeeName = row
      .slice(0, numericTokenIdx)
      .map((t) => String(t).trim())
      .filter((t) => t && !/^(Do|Fr|Sa|So|Mo|Di|Mi)$/i.test(t) && !/^\d+$/.test(t) && t !== '#')
      .join(' ');

    if (!employeeName || employeeName.length < 3) continue;

    const numericValues: number[] = [];
    for (let i = numericTokenIdx; i < row.length; i++) {
      const parsed = parseFloat(String(row[i]).trim().replace(',', '.'));
      if (!isNaN(parsed)) numericValues.push(parsed);
    }

    while (numericValues.length > dateColumns.length) numericValues.pop();

    for (let i = 0; i < numericValues.length && i < dateColumns.length; i++) {
      const v = numericValues[i];
      if (v > 0 && v <= 24) {
        entries.push({
          name: employeeName,
          department: currentDepartment,
          date: dateColumns[i],
          hours: Math.round(v * 100) / 100,
        });
      }
    }
  }

  console.log('[mirus-daily][pdf] entries:', entries.length, entries.slice(0, 10));
  return { entries, dateRange: dateColumns };
};

// Parse Mirus "Tägliche Stunden" Excel format – delegated to dedicated parser
export { parseMirusDailyExcel } from '@/lib/mirus-parser';

// Legacy stub kept for type-checking only (never called – tree-shaken)
const _parseMirusDailyExcelLegacy = async (file: File): Promise<{ entries: MirusDailyImportEntry[]; dateRange: string[] }> => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    // cellDates=true helps when Excel stores dates as actual date cells
    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const rows: (string | number | Date)[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
    });

    const entries: MirusDailyImportEntry[] = [];
    let currentDepartment: 'küche' | 'service' = 'küche';

    console.log('[mirus-daily][excel] total rows:', rows.length);
    console.log('[mirus-daily][excel] head rows:', rows.slice(0, 12));

    const inferredYear = (() => {
      for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const rowText = (rows[i] || []).map((c) => String(c ?? '')).join(' ');
        const m = rowText.match(/\b(20\d{2})\b/);
        if (m) return Number(m[1]);
      }
      return new Date().getFullYear();
    })();

    const cellToDate = (cell: unknown): Date | null => {
      if (!cell) return null;
      if (cell instanceof Date && !isNaN(cell.getTime())) return cell;

      // Excel stores dates as serial numbers
      if (typeof cell === 'number' && cell > 20000) {
        const dc = XLSX.SSF.parse_date_code(cell);
        if (dc && dc.y && dc.m && dc.d) {
          const d = new Date(dc.y, dc.m - 1, dc.d);
          return isNaN(d.getTime()) ? null : d;
        }
      }

      const s = String(cell).trim();
      if (!s) return null;

      // yyyy-mm-dd
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(s + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d;
      }

      // dd.mm.yyyy
      const full = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (full) {
        const d = parse(s, 'dd.MM.yyyy', new Date());
        return isNaN(d.getTime()) ? null : d;
      }

      // dd.mm. (no year)
      const partial = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
      if (partial) {
        const dd = Number(partial[1]);
        const mm = Number(partial[2]);
        const d = new Date(inferredYear, mm - 1, dd);
        return isNaN(d.getTime()) ? null : d;
      }

      return null;
    };

    const detectDateHeaderRow = (minCols = 5): { headerRowIdx: number; dateColumns: { index: number; date: string }[] } | null => {
      let best: { headerRowIdx: number; dateColumns: { index: number; date: string }[] } | null = null;

      for (let i = 0; i < Math.min(rows.length, 120); i++) {
        const row = rows[i];
        if (!row) continue;

        const dateColumns = row
          .map((cell, index) => ({ index, dateObj: cellToDate(cell) }))
          .filter((x) => x.dateObj)
          // Keep only columns that look like day columns (avoid "created at" etc. by requiring day<=31)
          .filter((x) => (x.dateObj as Date).getDate() >= 1 && (x.dateObj as Date).getDate() <= 31)
          .map((x) => ({ index: x.index, date: format(x.dateObj as Date, 'yyyy-MM-dd') }))
          .sort((a, b) => a.index - b.index);

        if (dateColumns.length < minCols) continue;

        // Ensure dates are strictly increasing (or at least non-decreasing) across columns
        const dateNums = dateColumns.map((dc) => new Date(dc.date + 'T00:00:00').getTime());
        const isIncreasing = dateNums.every((v, idx) => idx === 0 || v >= dateNums[idx - 1]);
        if (!isIncreasing) continue;

        if (!best || dateColumns.length > best.dateColumns.length) {
          best = { headerRowIdx: i, dateColumns };
        }
      }

      return best;
    };

    // --- 1) Try classic Mirus header: "von DD.MM.YYYY bis DD.MM.YYYY" ---
    let headerRowIdx = -1;
    let dateColumns: { index: number; date: string }[] = [];

    let startDate: Date | null = null;
    let endDate: Date | null = null;

    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i];
      if (!row) continue;
      const rowText = row.map((cell) => String(cell || '')).join(' ');
      const dateRangeMatch = rowText.match(/von\s*(\d{2}\.\d{2}\.\d{4})\s*bis\s*(\d{2}\.\d{2}\.\d{4})/i);
      if (dateRangeMatch) {
        startDate = parse(dateRangeMatch[1], 'dd.MM.yyyy', new Date());
        endDate = parse(dateRangeMatch[2], 'dd.MM.yyyy', new Date());
        console.log('[mirus-daily][excel] found date range:', dateRangeMatch[1], 'to', dateRangeMatch[2]);
        break;
      }
      // Single-day export: "am DD.MM.YYYY"
      const singleDayMatch = rowText.match(/\bam\s+(\d{2}\.\d{2}\.\d{4})/i);
      if (singleDayMatch) {
        startDate = parse(singleDayMatch[1], 'dd.MM.yyyy', new Date());
        endDate = startDate;
        console.log('[mirus-daily][excel] found single day (am):', singleDayMatch[1]);
        break;
      }
    }

    // --- 1b) No explicit date range — try to infer month/year from filename ---
    // Expected filename pattern: Tägliche_Stunden_MM.YYYY_*.xls
    if (!startDate || !endDate) {
      const fnMatch = file.name.match(/_(\d{2})\.(\d{4})[_\.]/);
      if (fnMatch) {
        const mm = parseInt(fnMatch[1], 10);
        const yyyy = parseInt(fnMatch[2], 10);
        if (mm >= 1 && mm <= 12 && yyyy > 2000) {
          startDate = new Date(yyyy, mm - 1, 1);
          endDate = endOfMonth(startDate);
          console.log('[mirus-daily][excel] inferred month from filename:', format(startDate, 'MM.yyyy'));
        }
      }
    }

    if (startDate && endDate) {
      // Build expected dates (inclusive) and their day-of-month sequence
      const expectedDates: { date: Date; iso: string; day: number }[] = [];
      let tmpDate = startDate;
      while (tmpDate <= endDate) {
        expectedDates.push({
          date: tmpDate,
          iso: format(tmpDate, 'yyyy-MM-dd'),
          day: tmpDate.getDate(),
        });
        tmpDate = addDays(tmpDate, 1);
      }

      const expectedDays = expectedDates.map((d) => d.day);
      const minConsecutive = Math.min(5, expectedDays.length);

      // Helper to parse a cell as an integer day number (1–31)
      const cellToIntDayFn = (cell: unknown): number | null => {
        if (typeof cell === 'number' && Number.isFinite(cell)) {
          const n = Math.trunc(cell);
          if (Math.abs(cell - n) < 1e-6 && n >= 1 && n <= 31) return n;
          return null;
        }
        const s = String(cell ?? '').trim();
        if (!s) return null;
        const mm = s.match(/^(\d{1,2})$/);
        return mm ? Number(mm[1]) : null;
      };

      // For short-range exports (1–2 days):
      // The Mirus full-month grid format uses day numbers 1…30 in the header row.
      // Searching for a single number like "9" would match many rows; instead we
      // search for the FULL month sequence (1,2,3,…,daysInMonth) which is unique,
      // then calculate the correct column offset for the requested day.
      let shortRangeDone = false;
      if (expectedDays.length <= 2) {
        // [IMPORT] log the requested day(s) up front
        for (const ed of expectedDates) {
          console.log(`[IMPORT] expected day: ${ed.day} (${ed.iso})`);
        }

        const daysInFullMonth = new Date(startDate!.getFullYear(), startDate!.getMonth() + 1, 0).getDate();
        const fullMonthSeq = Array.from({ length: daysInFullMonth }, (_, i) => i + 1);
        const minFullMatch = Math.min(5, daysInFullMonth);

        let fmHeaderRowIdx = -1;
        let fmStartCol = -1;
        let fmLen = 0;

        for (let i = 0; i < Math.min(rows.length, 140); i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          for (let col = 0; col < row.length; col++) {
            if (cellToIntDayFn(row[col]) !== 1) continue; // must start with day 1
            let len = 0;
            while (len < fullMonthSeq.length && col + len < row.length) {
              if (cellToIntDayFn(row[col + len]) === fullMonthSeq[len]) len++;
              else break;
            }
            if (len >= minFullMatch && len > fmLen) {
              fmLen = len; fmHeaderRowIdx = i; fmStartCol = col;
            }
          }
        }

        if (fmHeaderRowIdx >= 0) {
          // Map each requested day to its column via offset from day-1 column
          dateColumns = expectedDates.map(ed => ({
            index: fmStartCol + (ed.day - 1),
            date: ed.iso,
          }));
          headerRowIdx = fmHeaderRowIdx;
          console.log(`[IMPORT] detected header row: ${fmHeaderRowIdx}`);
          console.log(`[IMPORT] detected start column for day 1: ${fmStartCol}`);
          for (const ed of expectedDates) {
            const col = fmStartCol + (ed.day - 1);
            console.log(`[IMPORT] resolved column for day ${ed.day}: ${col}`);
          }
          console.log('[mirus-daily][excel] short-range: full-month header found at row', fmHeaderRowIdx, 'col', fmStartCol, '→ mapped cols:', dateColumns);
          shortRangeDone = true;
        } else {
          // Try date-cell detection (some exports use actual Excel date values)
          const detected = detectDateHeaderRow(1);
          if (detected && detected.dateColumns.length > 0) {
            headerRowIdx = detected.headerRowIdx;
            // BUG 2 FIX: filter to only the requested dates — don't import the whole month
            const requestedIsos = new Set(expectedDates.map(ed => ed.iso));
            dateColumns = detected.dateColumns.filter(dc => requestedIsos.has(dc.date));
            if (dateColumns.length === 0) {
              // Fallback: take closest matching column
              dateColumns = detected.dateColumns.slice(0, 1);
            }
            console.log(`[IMPORT] detected header row: ${headerRowIdx}`);
            console.log(`[IMPORT] detected start column for day 1: ${detected.dateColumns[0]?.index ?? '?'}`);
            for (const ed of expectedDates) {
              const dc = dateColumns.find(c => c.date === ed.iso);
              console.log(`[IMPORT] resolved column for day ${ed.day}: ${dc?.index ?? 'not found'}`);
            }
            console.log('[mirus-daily][excel] short-range: date-cell detection, filtered cols:', dateColumns.length);
            shortRangeDone = true;
          } else {
            // Last-resort: standard grid, day 1 at col 5 → offset by (day-1)
            const firstDayCol = 5;
            dateColumns = expectedDates.map(ed => ({
              index: firstDayCol + (ed.day - 1),
              date: ed.iso,
            }));
            headerRowIdx = (() => {
              const idx = rows.findIndex((r) => String(r?.[0] || '').toLowerCase().includes('küche'));
              return idx > 0 ? idx - 1 : 0;
            })();
            console.log(`[IMPORT] detected header row (last-resort): ${headerRowIdx}`);
            console.log(`[IMPORT] detected start column for day 1 (last-resort): ${firstDayCol}`);
            for (const ed of expectedDates) {
              console.log(`[IMPORT] resolved column for day ${ed.day} (last-resort): ${firstDayCol + (ed.day - 1)}`);
            }
            console.log('[mirus-daily][excel] short-range last-resort: col', dateColumns[0]?.index, 'row', headerRowIdx);
            shortRangeDone = true;
          }
        }
      }

      if (!shortRangeDone) {

      const cellToIntDay = (cell: unknown): number | null => {
        if (typeof cell === 'number' && Number.isFinite(cell)) {
          const n = Math.trunc(cell);
          // Only accept integer-like values (day numbers)
          if (Math.abs(cell - n) < 1e-6) return n;
          return null;
        }
        const s = String(cell ?? '').trim();
        if (!s) return null;
        const m = s.match(/^(\d{1,2})$/);
        return m ? Number(m[1]) : null;
      };

      // Find the row that contains the day-of-month header as a consecutive sequence
      // (e.g. 2..31,1 across a month boundary). This is more robust than mapping days via findIndex,
      // and also works when day numbers repeat across longer ranges.
      let bestRowIdx = -1;
      let bestStartCol = -1;
      let bestLen = 0;

      for (let i = 0; i < Math.min(rows.length, 140); i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        for (let col = 0; col < row.length; col++) {
          if (cellToIntDay(row[col]) !== expectedDays[0]) continue;

          let len = 0;
          while (len < expectedDays.length && col + len < row.length) {
            const day = cellToIntDay(row[col + len]);
            if (day === expectedDays[len]) {
              len++;
            } else {
              break;
            }
          }

          if (len > bestLen) {
            bestLen = len;
            bestRowIdx = i;
            bestStartCol = col;
          }
        }
      }

      // Fallback: common layout (first day at column 5)
      if (bestLen < minConsecutive || bestRowIdx === -1 || bestStartCol === -1) {
        const fallbackFirstDayCol = 5;
        bestRowIdx = (() => {
          const idx = rows.findIndex((r) => String(r?.[0] || '').toLowerCase().includes('1 küche'));
          return idx > 0 ? idx - 1 : 0;
        })();
        bestStartCol = fallbackFirstDayCol;
        bestLen = expectedDays.length;
        console.log('[mirus-daily][excel] using fallback consecutive day mapping');
      }

      console.log('[mirus-daily][excel] day header row idx:', bestRowIdx, 'start col:', bestStartCol, 'len:', bestLen);

      // Build date columns array (date -> column index) from the consecutive sequence
      dateColumns = [];
      for (let k = 0; k < bestLen && k < expectedDates.length; k++) {
        dateColumns.push({ index: bestStartCol + k, date: expectedDates[k].iso });
      }

      headerRowIdx = bestRowIdx;

      // If mapping looks wrong, try detecting actual date cells
      if (dateColumns.length < minConsecutive) {
        const detected = detectDateHeaderRow(minConsecutive);
        if (detected) {
          headerRowIdx = detected.headerRowIdx;
          dateColumns = detected.dateColumns;
          console.log('[mirus-daily][excel] fallback to detected date header row:', headerRowIdx, dateColumns.slice(0, 5));
        }
      }

      } // end if (!shortRangeDone)
    } else {
      // --- 2) Fallback: detect a header row with actual dates (date cells / serials / dd.mm strings) ---
      const detected = detectDateHeaderRow();
      if (!detected) {
        console.warn('[mirus-daily][excel] no date range found and could not detect date header row');
        return { entries: [], dateRange: [] };
      }

      headerRowIdx = detected.headerRowIdx;
      dateColumns = detected.dateColumns;
      console.log('[mirus-daily][excel] detected date header row:', headerRowIdx, 'date cols:', dateColumns.length);
    }

    if (headerRowIdx < 0 || dateColumns.length === 0) {
      console.warn('[mirus-daily][excel] no usable date columns detected');
      return { entries: [], dateRange: [] };
    }

    console.log('[mirus-daily][excel] date columns mapped:', dateColumns.length, dateColumns.slice(0, 5));

    // Parse employee rows
    for (let rowIndex = headerRowIdx + 1; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row || row.length === 0) continue;

      const rowText = row.map((cell) => String(cell || '').toLowerCase()).join(' ');
      const c0 = String(row[0] || '').trim();
      const c1 = String(row[1] || '').trim();

      // Department headers can appear in different columns depending on the export.
      // We look at the first few cells for patterns like "1 Küche" / "2 Service".
      const deptCandidate = row
        .slice(0, 6)
        .map((c) => String(c || '').trim())
        .find((t) => /^\d+\s*(küche|kuche|service|geschäftsleitung|geschaftsleitung|geschaeftsleitung|leitung|admin)\b/i.test(t));

      if (deptCandidate) {
        const d = deptCandidate.toLowerCase();
        if (d.includes('küch') || d.includes('kuche')) currentDepartment = 'küche';
        else if (d.includes('service')) currentDepartment = 'service';
        // Skip management/admin sections entirely
        else if (d.includes('geschäfts') || d.includes('geschaft') || d.includes('leitung') || d.includes('admin')) {
          // skip all rows until next department header by setting a flag-like department
          // We still use 'service' as fallback but these rows will be skipped by the name filter
        }
        continue;
      }

      // Skip totals / headers / section footers
      if (rowText.includes('tägliche stunden') || rowText.includes('restaurant') || rowText.includes('waisenhausplatz')) {
        continue;
      }
      // Skip all total / subtotal / sum rows (various Mirus export variants)
      if (rowText.includes('total stunden')) continue;
      if (/^\s*(total|summe|gesamt|zwischensumme|sub[- ]?total)\b/i.test(rowText)) continue;
      if (/\btotal\s+stunden\b|\bgesamt\s*stunden\b/i.test(rowText)) continue;
      if (/\btotal\b/.test(rowText) && /^\s*(total|\d*\s*total)/i.test(c0 + ' ' + c1)) continue;

      // Name is often in column 2, fallback to col1/col0
      const c2 = String(row[2] || '').trim();
      const employeeName = (c2 && /[a-zA-ZäöüÄÖÜ]/.test(c2) ? c2 : (c1 && /[a-zA-ZäöüÄÖÜ]/.test(c1) ? c1 : c0)).trim();
      if (!employeeName || employeeName.length < 3) continue;
      if (/^(Mo|Di|Mi|Do|Fr|Sa|So|Total|Datum)/i.test(employeeName)) continue;

      for (const { index, date } of dateColumns) {
        if (index >= row.length) continue;
        const cellValue = row[index];

        const hours = typeof cellValue === 'number'
          ? cellValue
          : parseFloat(String(cellValue).replace(',', '.'));

        if (!isNaN(hours) && hours > 0 && hours <= 24) {
          entries.push({
            name: employeeName,
            department: currentDepartment,
            date,
            hours: Math.round(hours * 100) / 100,
          });
        }
      }
    }

    console.log('[mirus-daily][excel] entries:', entries.length, entries.slice(0, 10));
    // [IMPORT] per-date summary log (only for single/short-range imports)
    if (dateColumns.length <= 2) {
      for (const dc of dateColumns) {
        const dayEntries = entries.filter(e => e.date === dc.date);
        console.log(`[IMPORT] imported rows for ${dc.date}: ${dayEntries.length}`, dayEntries.map(e => `${e.name} ${e.hours}h`));
      }
    }
    return { entries, dateRange: dateColumns.map((dc) => dc.date) };
  } catch (error) {
    console.error('[mirus-daily][excel] parsing error:', error);
    throw error;
  }
};
