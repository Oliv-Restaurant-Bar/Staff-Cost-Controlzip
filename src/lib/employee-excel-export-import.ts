import * as XLSX from 'xlsx';
import { Employee, Department, EmploymentType } from '@/types/personnel';
import { toast } from 'sonner';

// Column headers for the Excel export
const HEADERS = [
  'Name',
  'Abteilung',
  'Anstellungsverhältnis',
  'Wochenstunden',
  'Stundenlohn (CHF)',
  'Bruttolohn (CHF/Monat)',
  '13. Monatslohn'
];

// Map department display names
const DEPARTMENT_MAP: Record<Department, string> = {
  'service': 'Service',
  'küche': 'Küche'
};

const DEPARTMENT_REVERSE_MAP: Record<string, Department> = {
  'service': 'service',
  'küche': 'küche',
  'kueche': 'küche',
  'kuche': 'küche'
};

// Map employment type display names
const EMPLOYMENT_MAP: Record<EmploymentType, string> = {
  'vollzeit': 'Vollzeit',
  'teilzeit': 'Teilzeit',
  'minijob': 'Minijob',
  'aushilfe': 'Aushilfe'
};

const EMPLOYMENT_REVERSE_MAP: Record<string, EmploymentType> = {
  'vollzeit': 'vollzeit',
  'teilzeit': 'teilzeit',
  'minijob': 'minijob',
  'aushilfe': 'aushilfe'
};

// Calculate monthly salary from hourly wage
function calculateMonthlySalary(hourlyWage: number, weeklyHours: number): number {
  const weeksPerMonth = 4.33;
  return hourlyWage * weeklyHours * weeksPerMonth;
}

// Calculate hourly wage from monthly salary
function calculateHourlyWage(monthlySalary: number, weeklyHours: number, include13thMonth: boolean): number {
  if (monthlySalary <= 0 || weeklyHours <= 0) return 0;
  const weeksPerMonth = 4.33;
  const effectiveMonthly = include13thMonth ? (monthlySalary * 13) / 12 : monthlySalary;
  return effectiveMonthly / (weeklyHours * weeksPerMonth);
}

export interface NameMatchInfo {
  importedName: string;
  matchedEmployee: Employee | null;
  matchType: 'exact' | 'firstName' | 'new';
  isNew: boolean;
}

export interface EmployeeImportResult {
  employees: Employee[];
  newCount: number;
  updatedCount: number;
  errors: string[];
  nameMatches: NameMatchInfo[];
}

// Helper function to find best matching employee
function findMatchingEmployee(name: string, existingEmployees: Employee[]): { employee: Employee | null; matchType: 'exact' | 'firstName' | 'new' } {
  const normalizedName = name.toLowerCase().trim();
  
  // Try exact match first
  const exactMatch = existingEmployees.find(emp => 
    emp.name.toLowerCase().trim() === normalizedName
  );
  if (exactMatch) {
    return { employee: exactMatch, matchType: 'exact' };
  }
  
  // Try first name match
  const firstName = normalizedName.split(' ')[0];
  if (firstName.length >= 2) {
    const firstNameMatch = existingEmployees.find(emp => 
      emp.name.toLowerCase().trim().split(' ')[0] === firstName
    );
    if (firstNameMatch) {
      return { employee: firstNameMatch, matchType: 'firstName' };
    }
  }
  
  return { employee: null, matchType: 'new' };
}

/**
 * Export employees to Excel file
 */
export function exportEmployeesToExcel(employees: Employee[]): void {
  if (employees.length === 0) {
    toast.error('Keine Mitarbeiter zum Exportieren vorhanden');
    return;
  }

  // Create worksheet data
  const data: (string | number)[][] = [HEADERS];
  
  employees.forEach(emp => {
    const weeklyHours = emp.weeklyHours || 42;
    const monthlySalary = calculateMonthlySalary(emp.hourlyWage, weeklyHours);
    
    data.push([
      emp.name,
      DEPARTMENT_MAP[emp.department],
      EMPLOYMENT_MAP[emp.employmentType],
      weeklyHours,
      emp.hourlyWage,
      Math.round(monthlySalary), // Round for cleaner display
      '' // 13th month column - empty as we store hourly wage
    ]);
  });

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);

  // Set column widths
  ws['!cols'] = [
    { wch: 25 }, // Name
    { wch: 12 }, // Abteilung
    { wch: 18 }, // Anstellungsverhältnis
    { wch: 14 }, // Wochenstunden
    { wch: 16 }, // Stundenlohn
    { wch: 20 }, // Bruttolohn
    { wch: 14 }, // 13. Monatslohn
  ];

  // Add the worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Mitarbeiter');

  // Generate filename with date
  const date = new Date();
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const filename = `Mitarbeiterliste_${dateStr}.xlsx`;

  // Download the file
  XLSX.writeFile(wb, filename);
  toast.success(`${employees.length} Mitarbeiter exportiert`);
}

/**
 * Import employees from Excel file
 */
export async function importEmployeesFromExcel(
  file: File,
  existingEmployees: Employee[]
): Promise<EmployeeImportResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        // Get first sheet
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to array of arrays
        const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        if (rows.length < 2) {
          resolve({
            employees: [],
            newCount: 0,
            updatedCount: 0,
            errors: ['Die Datei enthält keine Daten'],
            nameMatches: []
          });
          return;
        }

        // Find header row and column indices
        const headerRow = rows[0] as string[];
        const colIndices = {
          name: headerRow.findIndex(h => h?.toString().toLowerCase().includes('name')),
          department: headerRow.findIndex(h => h?.toString().toLowerCase().includes('abteilung')),
          employment: headerRow.findIndex(h => 
            h?.toString().toLowerCase().includes('anstellung') || 
            h?.toString().toLowerCase().includes('verhältnis')
          ),
          weeklyHours: headerRow.findIndex(h => 
            h?.toString().toLowerCase().includes('wochenstunden') || 
            h?.toString().toLowerCase().includes('stunden')
          ),
          hourlyWage: headerRow.findIndex(h => 
            h?.toString().toLowerCase().includes('stundenlohn')
          ),
          monthlySalary: headerRow.findIndex(h => 
            h?.toString().toLowerCase().includes('bruttolohn') || 
            h?.toString().toLowerCase().includes('monatslohn')
          ),
          include13th: headerRow.findIndex(h => 
            h?.toString().toLowerCase().includes('13.') || 
            h?.toString().toLowerCase().includes('13 ')
          )
        };

        if (colIndices.name === -1) {
          resolve({
            employees: [],
            newCount: 0,
            updatedCount: 0,
            errors: ['Spalte "Name" nicht gefunden'],
            nameMatches: []
          });
          return;
        }

        const errors: string[] = [];
        const importedEmployees: Employee[] = [];
        const nameMatches: NameMatchInfo[] = [];
        let newCount = 0;
        let updatedCount = 0;

        // Process data rows
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          const name = row[colIndices.name]?.toString().trim();
          if (!name) continue;

          // Get department
          let department: Department = 'service';
          if (colIndices.department !== -1 && row[colIndices.department]) {
            const deptValue = row[colIndices.department].toString().toLowerCase().trim();
            department = DEPARTMENT_REVERSE_MAP[deptValue] || 'service';
          }

          // Get employment type
          let employmentType: EmploymentType = 'vollzeit';
          if (colIndices.employment !== -1 && row[colIndices.employment]) {
            const empValue = row[colIndices.employment].toString().toLowerCase().trim();
            employmentType = EMPLOYMENT_REVERSE_MAP[empValue] || 'vollzeit';
          }

          // Get weekly hours
          let weeklyHours = 42;
          if (colIndices.weeklyHours !== -1 && row[colIndices.weeklyHours]) {
            const hours = parseFloat(row[colIndices.weeklyHours]);
            if (!isNaN(hours) && hours > 0 && hours <= 60) {
              weeklyHours = hours;
            }
          }

          // Get hourly wage - prioritize hourly wage, fall back to calculating from monthly
          let hourlyWage = 0;
          
          // Check for hourly wage first
          if (colIndices.hourlyWage !== -1 && row[colIndices.hourlyWage]) {
            const wage = parseFloat(row[colIndices.hourlyWage].toString().replace(/[^\d.,]/g, '').replace(',', '.'));
            if (!isNaN(wage) && wage > 0) {
              hourlyWage = wage;
            }
          }
          
          // If no hourly wage, calculate from monthly salary
          if (hourlyWage === 0 && colIndices.monthlySalary !== -1 && row[colIndices.monthlySalary]) {
            const monthly = parseFloat(row[colIndices.monthlySalary].toString().replace(/[^\d.,]/g, '').replace(',', '.'));
            if (!isNaN(monthly) && monthly > 0) {
              // Check for 13th month indicator
              let include13th = false;
              if (colIndices.include13th !== -1 && row[colIndices.include13th]) {
                const val = row[colIndices.include13th].toString().toLowerCase().trim();
                include13th = val === 'ja' || val === 'yes' || val === 'true' || val === '1' || val === 'x';
              }
              
              hourlyWage = calculateHourlyWage(monthly, weeklyHours, include13th);
            }
          }

          // Validate hourly wage
          if (hourlyWage <= 0) {
            errors.push(`Zeile ${i + 1}: Kein gültiger Lohn für "${name}" gefunden`);
            hourlyWage = 25; // Default fallback
          }

          // Find matching employee using smart matching
          const { employee: matchedEmployee, matchType } = findMatchingEmployee(name, existingEmployees);

          // Store match info for preview
          nameMatches.push({
            importedName: name,
            matchedEmployee,
            matchType,
            isNew: matchType === 'new'
          });

          // Create employee data (without final ID assignment - that happens after matching confirmation)
          const employeeData: Employee = {
            id: matchedEmployee?.id || `imported-${Date.now()}-${i}`,
            name: matchedEmployee?.name || name,
            department,
            employmentType,
            hourlyWage: Math.round(hourlyWage * 100) / 100,
            weeklyHours
          };

          if (matchedEmployee) {
            updatedCount++;
          } else {
            newCount++;
          }

          importedEmployees.push(employeeData);
        }

        resolve({
          employees: importedEmployees,
          nameMatches,
          newCount,
          updatedCount,
          errors
        });
      } catch (error) {
        console.error('Error importing employees:', error);
        resolve({
          employees: [],
          newCount: 0,
          updatedCount: 0,
          errors: ['Fehler beim Lesen der Excel-Datei'],
          nameMatches: []
        });
      }
    };

    reader.onerror = () => {
      resolve({
        employees: [],
        newCount: 0,
        updatedCount: 0,
        errors: ['Fehler beim Lesen der Datei'],
        nameMatches: []
      });
    };

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Generate a template Excel file for employee import
 */
export function downloadEmployeeTemplate(): void {
  const exampleData = [
    HEADERS,
    ['Max Mustermann', 'Service', 'Vollzeit', 42, '', 4500, 'Ja'],
    ['Anna Schmidt', 'Küche', 'Teilzeit', 20, 28.50, '', ''],
    ['Peter Weber', 'Service', 'Aushilfe', 10, 25.00, '', ''],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(exampleData);

  ws['!cols'] = [
    { wch: 25 },
    { wch: 12 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 14 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Mitarbeiter');
  XLSX.writeFile(wb, 'Mitarbeiter_Vorlage.xlsx');
  toast.success('Vorlage heruntergeladen');
}
