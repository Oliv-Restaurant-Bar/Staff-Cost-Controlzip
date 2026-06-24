// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  departmentForRole,
  effectiveEmployeeDepartmentScope,
  getVisibleEmployeesForRole,
} from '../employee-visibility';
import type { Employee, Department } from '@/types/personnel';
import type { UserRole } from '@/contexts/AuthContext';

// ── Minimal-Fixtures ────────────────────────────────────────────────────────
// Nur die Felder, die selectEmployeesForDepartment liest (id, name, department).
function emp(id: string, name: string, department: Department): Employee {
  return { id, name, department } as unknown as Employee;
}

const KUECHE_A = emp('k1', 'Koch Anna', 'küche');
const KUECHE_B = emp('k2', 'Koch Bob', 'küche');
const SERVICE_A = emp('s1', 'Service Sara', 'service');
const SERVICE_B = emp('s2', 'Service Sven', 'service');

const ALL_EMPLOYEES: Employee[] = [KUECHE_A, SERVICE_A, KUECHE_B, SERVICE_B];

const depts = (list: Employee[]) => list.map(e => e.department);
const names = (list: Employee[]) => list.map(e => e.name);

describe('departmentForRole', () => {
  it('mappt eingeschränkte Rollen auf ihre Abteilung', () => {
    expect(departmentForRole('kueche_manager')).toBe('küche');
    expect(departmentForRole('service_manager')).toBe('service');
  });

  it('liefert null für uneingeschränkte Rollen', () => {
    expect(departmentForRole('admin')).toBeNull();
    expect(departmentForRole('beaulieu_manager')).toBeNull();
    expect(departmentForRole('beaulieu_viewer')).toBeNull();
  });
});

describe('effectiveEmployeeDepartmentScope', () => {
  it('lässt eingeschränkte Rollen ihre Abteilung gewinnen — auch bei allowedDepartment "all"', () => {
    // Belt & suspenders: selbst wenn allowedDepartment falsch auf "all" steht.
    expect(effectiveEmployeeDepartmentScope('kueche_manager', 'all')).toBe('küche');
    expect(effectiveEmployeeDepartmentScope('service_manager', 'all')).toBe('service');
  });

  it('folgt allowedDepartment für uneingeschränkte Rollen', () => {
    expect(effectiveEmployeeDepartmentScope('admin', 'all')).toBe('all');
    expect(effectiveEmployeeDepartmentScope('beaulieu_manager', 'all')).toBe('all');
  });
});

describe('getVisibleEmployeesForRole', () => {
  it('Küchen-Manager sieht NUR Küche (kein Service)', () => {
    const visible = getVisibleEmployeesForRole('kueche_manager', 'küche', ALL_EMPLOYEES);
    expect(names(visible).sort()).toEqual(['Koch Anna', 'Koch Bob']);
    expect(depts(visible).every(d => d === 'küche')).toBe(true);
    expect(visible).not.toContain(SERVICE_A);
    expect(visible).not.toContain(SERVICE_B);
  });

  it('Service-Manager sieht NUR Service (keine Küche)', () => {
    const visible = getVisibleEmployeesForRole('service_manager', 'service', ALL_EMPLOYEES);
    expect(names(visible).sort()).toEqual(['Service Sara', 'Service Sven']);
    expect(depts(visible).every(d => d === 'service')).toBe(true);
    expect(visible).not.toContain(KUECHE_A);
    expect(visible).not.toContain(KUECHE_B);
  });

  it('Admin sieht ALLE Mitarbeiter (unveränderte Liste)', () => {
    const visible = getVisibleEmployeesForRole('admin', 'all', ALL_EMPLOYEES);
    expect(visible).toEqual(ALL_EMPLOYEES);
  });

  it('Beaulieu-Manager sieht ALLE Mitarbeiter (unverändert)', () => {
    const visible = getVisibleEmployeesForRole('beaulieu_manager', 'all', ALL_EMPLOYEES);
    expect(visible).toEqual(ALL_EMPLOYEES);
  });

  it('Küchen-Manager: Rolle gewinnt selbst bei allowedDepartment "all" (Service bleibt ausgeschlossen)', () => {
    const visible = getVisibleEmployeesForRole('kueche_manager', 'all', ALL_EMPLOYEES);
    expect(depts(visible).every(d => d === 'küche')).toBe(true);
    expect(visible).toHaveLength(2);
    expect(names(visible)).not.toContain('Service Sara');
    expect(names(visible)).not.toContain('Service Sven');
  });

  it('Export-Scope für Küchen-Manager enthält ausschliesslich Küche', () => {
    // Repräsentiert den Export-/Auswahlpfad: dieselbe zentrale Funktion.
    const exportList = getVisibleEmployeesForRole('kueche_manager', 'küche', ALL_EMPLOYEES);
    expect(exportList.some(e => e.department === 'service')).toBe(false);
    expect(exportList.length).toBe(2);
  });

  it('liefert eine leere Liste, wenn keine Mitarbeiter der Abteilung existieren', () => {
    const onlyService = [SERVICE_A, SERVICE_B];
    expect(getVisibleEmployeesForRole('kueche_manager', 'küche', onlyService)).toEqual([]);
  });

  it('verändert die Eingabeliste nicht (keine Mutation)', () => {
    const snapshot = [...ALL_EMPLOYEES];
    getVisibleEmployeesForRole('kueche_manager', 'küche', ALL_EMPLOYEES);
    expect(ALL_EMPLOYEES).toEqual(snapshot);
  });
});
