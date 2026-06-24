import type { Employee } from '@/types/personnel';
import type { UserRole } from '@/contexts/AuthContext';
import type { Department } from '@/hooks/usePermissions';
import { selectEmployeesForDepartment } from './schedule-export-department';

/**
 * Zentrale Manager-Sichtbarkeit für Mitarbeiter
 * ============================================
 * Eine einzige Quelle der Wahrheit dafür, welche Mitarbeiter eine Rolle sehen,
 * auswählen, exportieren und zählen darf — überall im Dienstplan & Personalstamm.
 *
 * Regeln:
 *   admin / owner      → alle Mitarbeiter
 *   beaulieu_manager   → alle Mitarbeiter (unverändert)
 *   kueche_manager     → nur Küche
 *   service_manager    → nur Service
 *
 * Reine Funktionen ohne Seiteneffekte (kein Supabase / DOM) → isoliert testbar.
 */

/** Rollen, die strikt auf eine einzige Abteilung beschränkt sind. */
const RESTRICTED_ROLE_DEPARTMENT: Partial<Record<UserRole, 'service' | 'küche'>> = {
  service_manager: 'service',
  kueche_manager: 'küche',
};

/**
 * Liefert die fest zugeordnete Abteilung einer eingeschränkten Rolle
 * (kueche_manager → 'küche', service_manager → 'service'), sonst `null`.
 */
export function departmentForRole(role: UserRole): 'service' | 'küche' | null {
  return RESTRICTED_ROLE_DEPARTMENT[role] ?? null;
}

/**
 * Die effektive Abteilungs-Sichtbarkeit einer Rolle.
 * Für eingeschränkte Rollen GEWINNT die Rolle (defense-in-depth gegen
 * veralteten/falsch berechneten `allowedDepartment`); alle anderen Rollen
 * folgen dem übergebenen `allowedDepartment` (Admin/Beaulieu = 'all').
 */
export function effectiveEmployeeDepartmentScope(
  role: UserRole,
  allowedDepartment: Department,
): Department {
  return departmentForRole(role) ?? allowedDepartment;
}

/**
 * Filtert die Mitarbeiterliste auf das, was die Rolle sehen darf.
 * - admin / beaulieu_manager (allowedDepartment 'all') → unveränderte Liste
 * - kueche_manager → nur Küche, service_manager → nur Service
 */
export function getVisibleEmployeesForRole(
  role: UserRole,
  allowedDepartment: Department,
  employees: Employee[],
): Employee[] {
  return selectEmployeesForDepartment(
    employees,
    effectiveEmployeeDepartmentScope(role, allowedDepartment),
  );
}
