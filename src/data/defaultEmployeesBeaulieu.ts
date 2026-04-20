/**
 * Default-Mitarbeiter für Mandant Beaulieu
 * ==========================================
 * Wird als Fallback genutzt, wenn keine Mitarbeiter in Supabase vorhanden sind.
 * IDs haben das Präfix "b-" um Kollisionen mit Oliv-IDs (1-24) zu vermeiden.
 *
 * HINWEIS: Diese Liste kann über den Import-Hub durch eine Excel-Datei
 * ersetzt werden (Abteilung + Stundenlohn werden dann aus Supabase geladen).
 */

import { Employee } from '@/types/personnel';

export const defaultEmployeesBeaulieu: Employee[] = [
  // === SERVICE ===
  {
    id: 'b-1',
    name: 'Chefin Service',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 38.00,
    weeklyHours: 42,
    monthlySalary: 5700.00,
    monthlySalaryWith13th: 6384.00,
  },
  {
    id: 'b-2',
    name: 'Mitarbeiter Service 1',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 30.00,
    weeklyHours: 42,
    monthlySalary: 4500.00,
    monthlySalaryWith13th: 5040.00,
  },
  {
    id: 'b-3',
    name: 'Mitarbeiterin Service 2',
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 28.50,
    weeklyHours: 42,
    monthlySalary: 4275.00,
    monthlySalaryWith13th: 4788.00,
  },
  {
    id: 'b-4',
    name: 'Mitarbeiter Service 3',
    department: 'service',
    employmentType: 'teilzeit',
    hourlyWage: 25.00,
  },
  {
    id: 'b-5',
    name: 'Mitarbeiterin Service 4',
    department: 'service',
    employmentType: 'teilzeit',
    hourlyWage: 25.00,
  },
  {
    id: 'b-6',
    name: 'Aushilfe Service',
    department: 'service',
    employmentType: 'teilzeit',
    hourlyWage: 22.00,
  },

  // === KÜCHE ===
  {
    id: 'b-7',
    name: 'Küchenchef',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 48.00,
    weeklyHours: 42,
    monthlySalary: 7200.00,
    monthlySalaryWith13th: 8064.00,
  },
  {
    id: 'b-8',
    name: 'Sous Chef',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 36.00,
    weeklyHours: 42,
    monthlySalary: 5400.00,
    monthlySalaryWith13th: 6048.00,
  },
  {
    id: 'b-9',
    name: 'Koch / Köchin 1',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 30.00,
    weeklyHours: 42,
    monthlySalary: 4500.00,
    monthlySalaryWith13th: 5040.00,
  },
  {
    id: 'b-10',
    name: 'Koch / Köchin 2',
    department: 'küche',
    employmentType: 'vollzeit',
    hourlyWage: 28.00,
    weeklyHours: 42,
    monthlySalary: 4200.00,
    monthlySalaryWith13th: 4704.00,
  },
  {
    id: 'b-11',
    name: 'Küchenmitarbeiter 1',
    department: 'küche',
    employmentType: 'teilzeit',
    hourlyWage: 22.00,
  },
  {
    id: 'b-12',
    name: 'Aushilfe Küche',
    department: 'küche',
    employmentType: 'teilzeit',
    hourlyWage: 20.00,
  },
];
