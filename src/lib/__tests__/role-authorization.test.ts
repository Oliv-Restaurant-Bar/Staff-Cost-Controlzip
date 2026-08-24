// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { roleCan, type RoleCapability } from '@/lib/role-authorization';

describe('roleCan', () => {
  const capabilities: RoleCapability[] = [
    'operational_management', 'guest_management', 'finance', 'cockpit_export', 'admin_system',
  ];

  it('Admin darf alle zentralen Fähigkeiten', () => {
    for (const capability of capabilities) expect(roleCan('admin', capability)).toBe(true);
  });

  it('Beaulieu-Geschäftsführer darf operative und Gäste-Bereiche, aber keine Finanzen/Exporte/Systemverwaltung', () => {
    expect(roleCan('beaulieu_manager', 'operational_management')).toBe(true);
    expect(roleCan('beaulieu_manager', 'guest_management')).toBe(true);
    expect(roleCan('beaulieu_manager', 'finance')).toBe(false);
    expect(roleCan('beaulieu_manager', 'cockpit_export')).toBe(false);
    expect(roleCan('beaulieu_manager', 'admin_system')).toBe(false);
  });

  it('andere Rollen erhalten dadurch keine zusätzlichen Admin-Rechte', () => {
    for (const role of ['service_manager', 'kueche_manager', 'beaulieu_viewer'] as const) {
      for (const capability of capabilities) expect(roleCan(role, capability)).toBe(false);
    }
  });
});