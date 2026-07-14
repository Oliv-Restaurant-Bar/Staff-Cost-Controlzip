import type { Employee } from '@/types/personnel';

export type ExportDepartmentScope = 'service' | 'küche' | 'all';

/**
 * Wählt die Mitarbeiter einer Abteilung für den Export aus.
 * - 'all'     → alle Mitarbeiter (beide Abteilungen)
 * - 'service' → nur Service-Mitarbeiter
 * - 'küche'   → nur Küchen-Mitarbeiter
 *
 * Reine Funktion ohne Seiteneffekte / ohne Supabase- oder DOM-Abhängigkeiten,
 * damit der Export-Abteilungsfilter isoliert testbar ist.
 */
export function selectEmployeesForDepartment(
  employees: Employee[],
  department: ExportDepartmentScope,
): Employee[] {
  if (department === 'all') return employees;
  return employees.filter(e => e.department === department);
}
