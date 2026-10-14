import * as pdfjs from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

// Set up the worker for pdfjs-dist v3.x
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

export interface ScheduleEntry {
  name: string;
  department: 'service' | 'küche';
  date: string;
  plannedHours: number;
  plannedStart?: string;
  plannedEnd?: string;
}

export interface WeeklyScheduleImport {
  entries: ScheduleEntry[];
  weekDates: string[];
  department: 'service' | 'küche';
}

// Dienst-Legende für Küchen-Schichtcodes
const SHIFT_CODES: Record<string, { start: string; end: string; hours: number; breakMinutes: number }> = {
  'A': { start: '10:00', end: '23:00', hours: 9.5, breakMinutes: 30 }, // 10:00-14:00 / 17:30-23:00 (9.5h mit Pause)
  'B': { start: '11:30', end: '21:30', hours: 9, breakMinutes: 60 },   // 11:30-21:30 (9h mit 1h Pause)
  'C': { start: '10:00', end: '14:00', hours: 3.5, breakMinutes: 30 }, // 10:00-14:00 (3.5h mit Pause)
  'D': { start: '18:00', end: '23:30', hours: 5, breakMinutes: 30 },   // 18:00-23:30 (5h mit Pause)
  'E': { start: '14:00', end: '23:00', hours: 8.5, breakMinutes: 30 }, // 14:00-23:00 (8.5h mit Pause)
  'O1': { start: '11:00', end: '23:30', hours: 8.5, breakMinutes: 0 }, // 11:00-14:00 / 18:00-23:30 (8.5h)
  '1': { start: '10:00', end: '14:00', hours: 4, breakMinutes: 0 },    // Kurze Schicht (geschätzt)
};

// Codes die "frei" bedeuten
const FREE_CODES = ['F', 'FE', 'FW', 'KO', 'K', 'FT', 'MS', 'MI', 'FREI', ''];

// Parse time range like "11:00-23:00" or "11:00 - 23:00" or split times
function parseTimeRange(early: string, late?: string): { hours: number; start: string; end: string } | null {
  // Handle single time range string
  if (early && !late) {
    const match = early.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
    if (match) {
      const [, start, end] = match;
      const startHours = parseTimeToHours(start);
      let endHours = parseTimeToHours(end);
      if (endHours < startHours) endHours += 24;
      return { hours: endHours - startHours, start, end };
    }
  }
  
  // Handle two separate times
  if (early && late) {
    const startMatch = early.match(/(\d{1,2}:\d{2})/);
    const endMatch = late.match(/(\d{1,2}:\d{2})/);
    if (startMatch && endMatch) {
      const start = startMatch[1];
      const end = endMatch[1];
      const startHours = parseTimeToHours(start);
      let endHours = parseTimeToHours(end);
      if (endHours < startHours) endHours += 24;
      return { hours: endHours - startHours, start, end };
    }
  }
  
  return null;
}

function parseTimeToHours(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours + minutes / 60;
}

// Calculate hours from shift code
function getHoursFromShiftCode(code: string): { hours: number; start: string; end: string } | null {
  const upperCode = code.toUpperCase().trim();
  const shift = SHIFT_CODES[upperCode];
  if (shift) {
    return { hours: shift.hours, start: shift.start, end: shift.end };
  }
  return null;
}

// Check if a code means "free/off"
function isFreeCode(code: string): boolean {
  const upperCode = code.toUpperCase().trim();
  return FREE_CODES.includes(upperCode);
}

// Parse dates from header row (e.g., "19/01/2026" or just day numbers "5", "6", etc.)
function parseDatesFromHeader(row: string[], startYear: number, startMonth: number): string[] {
  const dates: string[] = [];
  
  for (const cell of row) {
    // Try full date format DD/MM/YYYY
    const fullDateMatch = cell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (fullDateMatch) {
      const [, day, month, year] = fullDateMatch;
      dates.push(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
      continue;
    }
    
    // Try just day number
    const dayMatch = cell.match(/^(\d{1,2})$/);
    if (dayMatch && startYear && startMonth) {
      const day = parseInt(dayMatch[1], 10);
      // Handle month overflow
      let month = startMonth;
      let year = startYear;
      if (day < 1 || day > 31) continue;
      
      // Create date
      const date = new Date(year, month - 1, day);
      dates.push(date.toISOString().split('T')[0]);
    }
  }
  
  return dates;
}

// Extract text content from PDF
async function extractPDFText(file: File): Promise<string[][]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  
  const allRows: string[][] = [];
  
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    // Group text items by Y position (row)
    const rows: Map<number, { x: number; text: string }[]> = new Map();
    
    for (const item of textContent.items) {
      const textItem = item as TextItem;
      if (textItem.str && textItem.str.trim()) {
        const y = Math.round(textItem.transform[5]);
        const x = textItem.transform[4];
        
        if (!rows.has(y)) {
          rows.set(y, []);
        }
        rows.get(y)!.push({ x, text: textItem.str.trim() });
      }
    }
    
    // Sort rows by Y (descending for PDF coordinate system) and items by X
    const sortedYs = Array.from(rows.keys()).sort((a, b) => b - a);
    
    for (const y of sortedYs) {
      const rowItems = rows.get(y)!;
      rowItems.sort((a, b) => a.x - b.x);
      allRows.push(rowItems.map(item => item.text));
    }
  }
  
  return allRows;
}

// Parse Service-style PDF (with time ranges like "11:00-23:00" or "Früh"/"Spät" columns)
function parseServiceSchedule(rows: string[][], dates: string[]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  let inEmployeeSection = false;
  
  for (const row of rows) {
    const rowText = row.join(' ').toLowerCase();
    
    // Skip header rows
    if (rowText.includes('dienstplan') || rowText.includes('montag') || rowText.includes('labor')) {
      continue;
    }
    
    // Look for NAME section
    if (rowText.includes('name') && !rowText.includes('vorname')) {
      inEmployeeSection = true;
      continue;
    }
    
    // Skip non-employee rows
    if (rowText.includes('aushilfe') && row.length < 3) {
      continue;
    }
    
    // Try to find employee name (usually first column, followed by schedule data)
    if (row.length >= 2) {
      const potentialName = row[0];
      
      // Skip if it looks like a header or label
      if (!potentialName || potentialName.length < 2 ||
          /^(früh|spät|mo|di|mi|do|fr|sa|so|kw|labor)$/i.test(potentialName)) {
        continue;
      }
      
      // Process each day's schedule
      for (let i = 0; i < dates.length && i < row.length - 1; i++) {
        const dayData: string[] = [];
        // Collect cells for this day (may have Früh/Spät split)
        const cellIndex = i * 2 + 1; // Approximate - depends on format
        
        if (cellIndex < row.length) {
          const cell = row[cellIndex];
          
          // Skip free days
          if (isFreeCode(cell)) continue;
          
          // Try to parse time range
          const timeInfo = parseTimeRange(cell);
          if (timeInfo && timeInfo.hours > 0) {
            entries.push({
              name: potentialName,
              department: 'service',
              date: dates[i],
              plannedHours: timeInfo.hours,
              plannedStart: timeInfo.start,
              plannedEnd: timeInfo.end,
            });
          }
        }
      }
    }
  }
  
  return entries;
}

// Parse Kitchen-style PDF (with shift codes A, B, E, O1, etc.)
function parseKitchenSchedule(rows: string[][], dates: string[]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  let employeeStarted = false;
  
  for (const row of rows) {
    const rowText = row.join(' ').toLowerCase();
    
    // Skip header and legend rows
    if (rowText.includes('dienstplan') || rowText.includes('küche') && rowText.includes('bis') ||
        rowText.includes('dienste legende') || rowText.includes('pause') ||
        rowText.includes('montag') || rowText.includes('mo') && rowText.includes('di') && rowText.includes('mi')) {
      continue;
    }
    
    // Look for Name header to start processing employees
    if (rowText.includes('name') && row.length > 1) {
      employeeStarted = true;
      continue;
    }
    
    // Process employee rows
    if (row.length >= 2) {
      const potentialName = row[0];
      
      // Skip invalid names
      if (!potentialName || potentialName.length < 2 ||
          /^(name|legende|fe=|ft=|ko=|k=|a\s|b\s|c\s|d\s|e\s|o1)$/i.test(potentialName) ||
          potentialName.includes('=')) {
        continue;
      }
      
      // Process each day's shift code
      for (let i = 1; i < row.length && i - 1 < dates.length; i++) {
        const shiftCode = row[i];
        
        // Skip free days
        if (isFreeCode(shiftCode)) continue;
        
        // Try to get hours from shift code
        const shiftInfo = getHoursFromShiftCode(shiftCode);
        if (shiftInfo && shiftInfo.hours > 0) {
          entries.push({
            name: potentialName,
            department: 'küche',
            date: dates[i - 1],
            plannedHours: shiftInfo.hours,
            plannedStart: shiftInfo.start,
            plannedEnd: shiftInfo.end,
          });
        }
      }
    }
  }
  
  return entries;
}

// Main function to parse schedule PDFs
export async function parseSchedulePDF(file: File): Promise<WeeklyScheduleImport> {
  console.log('Parsing schedule PDF:', file.name);
  
  const rows = await extractPDFText(file);
  console.log('Extracted rows:', rows.length);
  console.log('First 10 rows:', rows.slice(0, 10));
  
  // Detect format and department
  const allText = rows.map(r => r.join(' ')).join('\n').toLowerCase();
  const isKitchen = allText.includes('küche') || allText.includes('dienste legende');
  const isService = allText.includes('service') || allText.includes('früh') && allText.includes('spät');
  
  // Extract dates from header
  let dates: string[] = [];
  let year = new Date().getFullYear();
  let month = new Date().getMonth() + 1;
  
  // Look for date information
  for (const row of rows) {
    const rowText = row.join(' ');
    
    // Full date pattern
    const fullDateMatch = rowText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (fullDateMatch) {
      year = parseInt(fullDateMatch[3], 10);
      month = parseInt(fullDateMatch[2], 10);
    }
    
    // Month-year pattern like "05.01.2026 BIS 01.02.2026"
    const monthYearMatch = rowText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (monthYearMatch) {
      year = parseInt(monthYearMatch[3], 10);
      month = parseInt(monthYearMatch[2], 10);
    }
    
    // KW pattern for week info
    const kwMatch = rowText.match(/KW\s*(\d+)/i);
    if (kwMatch) {
      console.log('Found week:', kwMatch[1]);
    }
    
    // Try to extract dates from this row
    const rowDates = parseDatesFromHeader(row, year, month);
    if (rowDates.length > dates.length) {
      dates = rowDates;
    }
  }
  
  console.log('Detected dates:', dates);
  console.log('Is Kitchen:', isKitchen, 'Is Service:', isService);
  
  // Parse based on detected format
  let entries: ScheduleEntry[] = [];
  
  if (isKitchen) {
    entries = parseKitchenSchedule(rows, dates);
  } else {
    entries = parseServiceSchedule(rows, dates);
  }
  
  // If no entries found, try a more generic approach
  if (entries.length === 0) {
    console.log('No entries found with specific parser, trying generic...');
    entries = parseGenericSchedule(rows, dates, isKitchen ? 'küche' : 'service');
  }
  
  console.log('Total entries parsed:', entries.length);
  
  return {
    entries,
    weekDates: dates,
    department: isKitchen ? 'küche' : 'service',
  };
}

// Generic fallback parser
function parseGenericSchedule(rows: string[][], dates: string[], department: 'service' | 'küche'): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const namePattern = /^[A-ZÄÖÜa-zäöü][a-zäöüA-ZÄÖÜ\s\-]+$/;
  
  for (const row of rows) {
    if (row.length < 2) continue;
    
    const potentialName = row[0];
    
    // Check if it looks like a name
    if (!potentialName || potentialName.length < 2 || !namePattern.test(potentialName)) {
      continue;
    }
    
    // Skip known headers
    const lowerName = potentialName.toLowerCase();
    if (['name', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'].includes(lowerName)) {
      continue;
    }
    
    // Process remaining cells as potential shift data
    for (let i = 1; i < row.length; i++) {
      const cell = row[i];
      const dateIndex = i - 1;
      
      if (dateIndex >= dates.length) break;
      if (isFreeCode(cell)) continue;
      
      // Try shift code first
      const shiftInfo = getHoursFromShiftCode(cell);
      if (shiftInfo && shiftInfo.hours > 0) {
        entries.push({
          name: potentialName,
          department,
          date: dates[dateIndex],
          plannedHours: shiftInfo.hours,
          plannedStart: shiftInfo.start,
          plannedEnd: shiftInfo.end,
        });
        continue;
      }
      
      // Try time range
      const timeInfo = parseTimeRange(cell);
      if (timeInfo && timeInfo.hours > 0) {
        entries.push({
          name: potentialName,
          department,
          date: dates[dateIndex],
          plannedHours: timeInfo.hours,
          plannedStart: timeInfo.start,
          plannedEnd: timeInfo.end,
        });
      }
    }
  }
  
  return entries;
}

// Aggregate entries by employee for a summary view
export function aggregateScheduleByEmployee(entries: ScheduleEntry[]): { name: string; department: 'service' | 'küche'; totalHours: number; days: number }[] {
  const byEmployee = new Map<string, { department: 'service' | 'küche'; totalHours: number; days: Set<string> }>();
  
  for (const entry of entries) {
    const existing = byEmployee.get(entry.name);
    if (existing) {
      existing.totalHours += entry.plannedHours;
      existing.days.add(entry.date);
    } else {
      byEmployee.set(entry.name, {
        department: entry.department,
        totalHours: entry.plannedHours,
        days: new Set([entry.date]),
      });
    }
  }
  
  return Array.from(byEmployee.entries()).map(([name, data]) => ({
    name,
    department: data.department,
    totalHours: Math.round(data.totalHours * 100) / 100,
    days: data.days.size,
  }));
}
