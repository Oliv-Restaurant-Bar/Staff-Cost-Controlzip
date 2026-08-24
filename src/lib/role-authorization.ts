import type { UserRole } from '@/contexts/AuthContext';

/**
 * Zentrale, rollenbasierte Fähigkeiten, die mehrere Routen/Komponenten teilen.
 * Beaulieu-Geschäftsführer ist operativ nahezu Admin, aber ausdrücklich ohne
 * Finanzen, Cockpit-Export und Admin-/Systemverwaltung.
 */
export type RoleCapability =
  | 'operational_management'
  | 'guest_management'
  | 'finance'
  | 'cockpit_export'
  | 'admin_system';

export function roleCan(role: UserRole, capability: RoleCapability): boolean {
  if (role === 'admin') return true;
  if (role !== 'beaulieu_manager') return false;
  return capability === 'operational_management' || capability === 'guest_management';
}