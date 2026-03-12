import * as XLSX from 'xlsx';
import { Employee } from '@/types/personnel';

interface ScheduleTemplateOptions {
  employees: Employee[];
  month: number; // 0-11
  year: number;
}

// Vordefinierte Schichten
const SHIFT_OPTIONS = {
  'Früh': { start: '11:00', end: '14:00' },
  'Spät': { start: '17:00', end: '23:30' },
  'Durchgehend': { start: '11:00', end: '23:00' },
  'Sa-Spät': { start: '17:00', end: '00:30' },
  'Sonntag': { start: '09:00', end: '21:00' },
  'Frei': { start: '', end: '' },
};

const SHIFT_DROPDOWN_OPTIONS = Object.keys(SHIFT_OPTIONS);

const WEEKDAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function getDaysInMonth(year: number, month: number): Date[] {
  const days: Date[] = [];
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  
  for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }
  return days;
}

function formatDateShort(date: Date): string {
  const day = date.getDate();
  const weekday = WEEKDAY_NAMES[date.getDay() === 0 ? 6 : date.getDay() - 1];
  return `${weekday} ${day}.`;
}

export function generateScheduleTemplate(options: ScheduleTemplateOptions): XLSX.WorkBook {
  const { employees, month, year } = options;
  const days = getDaysInMonth(year, month);
  
  // Mitarbeiter nach Abteilung trennen
  // Sort employees by ID to maintain consistent order from Excel file
  const sortByEmployeeId = (a: Employee, b: Employee) => parseInt(a.id) - parseInt(b.id);
  const serviceEmployees = employees.filter(e => e.department === 'service').sort(sortByEmployeeId);
  const kücheEmployees = employees.filter(e => e.department === 'küche').sort(sortByEmployeeId);
  
  const wb = XLSX.utils.book_new();
  
  // Service Sheet erstellen
  const serviceSheet = createDepartmentSheet(serviceEmployees, days, 'Service', month, year);
  XLSX.utils.book_append_sheet(wb, serviceSheet, 'Service');
  
  // Küche Sheet erstellen
  const kücheSheet = createDepartmentSheet(kücheEmployees, days, 'Küche', month, year);
  XLSX.utils.book_append_sheet(wb, kücheSheet, 'Küche');
  
  return wb;
}

function createDepartmentSheet(
  employees: Employee[], 
  days: Date[], 
  department: string,
  month: number,
  year: number
): XLSX.WorkSheet {
  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 
                      'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  
  const data: (string | null)[][] = [];
  
  // Header Zeile 1: Dienstplan Titel
  const headerRow1: (string | null)[] = [`Dienstplan ${department} - ${monthNames[month]} ${year}`];
  data.push(headerRow1);
  
  // Header Zeile 2: leer
  data.push([]);
  
  // Header Zeile 3: Schicht-Legende
  data.push(['Schicht-Optionen:', ...SHIFT_DROPDOWN_OPTIONS.map(s => {
    const shift = SHIFT_OPTIONS[s as keyof typeof SHIFT_OPTIONS];
    return shift.start ? `${s}: ${shift.start}-${shift.end}` : s;
  })]);
  
  // Header Zeile 4: leer
  data.push([]);
  
  // Header Zeile 5: NAME + Tage des Monats
  const headerRow5: (string | null)[] = ['NAME'];
  days.forEach(date => {
    headerRow5.push(formatDateShort(date));
  });
  data.push(headerRow5);
  
  // Mitarbeiter Zeilen (ab Zeile 6, Index 5)
  const employeeStartRow = 6; // 1-indexed für Excel
  employees.forEach((emp, empIdx) => {
    const row: (string | null)[] = [emp.name];
    
    for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
      // Leere Zelle - User wählt aus Dropdown
      row.push(null);
    }
    
    data.push(row);
  });
  
  // Leere Zeilen für zusätzliche Mitarbeiter
  for (let i = 0; i < 10; i++) {
    const emptyRow: (string | null)[] = [null];
    for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
      emptyRow.push(null);
    }
    data.push(emptyRow);
  }
  
  // Legende
  data.push([]);
  data.push(['=== LEGENDE ===']);
  data.push(['Wähle eine Schicht aus dem Dropdown-Menü in jeder Zelle:']);
  data.push([]);
  Object.entries(SHIFT_OPTIONS).forEach(([name, times]) => {
    if (times.start) {
      data.push([`${name}: ${times.start} - ${times.end}`]);
    } else {
      data.push([`${name}: Kein Dienst`]);
    }
  });
  data.push([]);
  data.push(['Oder gib manuelle Zeiten ein im Format: 11:00-23:00']);
  
  const ws = XLSX.utils.aoa_to_sheet(data);
  
  // Spaltenbreiten setzen
  const colWidths: XLSX.ColInfo[] = [
    { wch: 20 }, // NAME
  ];
  for (let i = 0; i < days.length; i++) {
    colWidths.push({ wch: 12 });
  }
  ws['!cols'] = colWidths;
  
  // Data Validation für Dropdown-Auswahl hinzufügen
  // Leider unterstützt xlsx keine direkte dataValidation,
  // aber wir können die Zellen mit einem Hinweis versehen
  // Alternative: Wir fügen ein verstecktes Sheet mit den Optionen hinzu
  
  // Für jetzt: Wir fügen die Dropdown-Werte als Kommentar/Hinweis ein
  // und der Parser wird diese Werte erkennen
  
  return ws;
}

export function downloadScheduleTemplate(employees: Employee[], month: number, year: number): void {
  const wb = generateScheduleTemplate({ employees, month, year });
  
  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 
                      'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const monthName = monthNames[month];
  const yearShort = String(year).slice(-2);
  
  const fileName = `Dienstplan_Vorlage_${monthName}_${yearShort}.xlsx`;
  
  XLSX.writeFile(wb, fileName);
}

// Hilfsfunktion um Schichtzeiten aus dem Namen zu extrahieren
export function getShiftTimes(shiftName: string): { start: string; end: string } | null {
  const shift = SHIFT_OPTIONS[shiftName as keyof typeof SHIFT_OPTIONS];
  if (shift && shift.start) {
    return { start: shift.start, end: shift.end };
  }
  
  // Versuche manuelles Format zu parsen: "11:00-23:00" oder "11:00 - 23:00"
  const manualMatch = shiftName.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
  if (manualMatch) {
    return { start: manualMatch[1], end: manualMatch[2] };
  }
  
  return null;
}

export const AVAILABLE_SHIFTS = SHIFT_OPTIONS;
