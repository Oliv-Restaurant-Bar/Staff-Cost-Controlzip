// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { selectEmployeesForDepartment } from '@/lib/schedule-export-department';
import type { Employee } from '@/types/personnel';

function emp(id: string, name: string, department: Employee['department']): Employee {
  return { id, name, department, employmentType: 'aushilfe', hourlyWage: 0 };
}

const employees: Employee[] = [
  emp('1', 'Service A', 'service'),
  emp('2', 'Service B', 'service'),
  emp('14', 'Küche A', 'küche'),
  emp('15', 'Küche B', 'küche'),
  emp('16', 'Küche C', 'küche'),
];

describe('selectEmployeesForDepartment', () => {
  it('Küchen-Export liefert ausschliesslich Küchen-Mitarbeiter', () => {
    const result = selectEmployeesForDepartment(employees, 'küche');
    expect(result.map(e => e.id)).toEqual(['14', '15', '16']);
    expect(result.every(e => e.department === 'küche')).toBe(true);
    expect(result.some(e => e.department === 'service')).toBe(false);
  });

  it('Service-Export liefert ausschliesslich Service-Mitarbeiter', () => {
    const result = selectEmployeesForDepartment(employees, 'service');
    expect(result.map(e => e.id)).toEqual(['1', '2']);
    expect(result.every(e => e.department === 'service')).toBe(true);
    expect(result.some(e => e.department === 'küche')).toBe(false);
  });

  it("'all' liefert beide Abteilungen unverändert", () => {
    const result = selectEmployeesForDepartment(employees, 'all');
    expect(result).toHaveLength(employees.length);
    expect(result.filter(e => e.department === 'service')).toHaveLength(2);
    expect(result.filter(e => e.department === 'küche')).toHaveLength(3);
  });

  it('leere Mitarbeiterliste liefert leere Auswahl pro Abteilung', () => {
    expect(selectEmployeesForDepartment([], 'küche')).toEqual([]);
    expect(selectEmployeesForDepartment([], 'service')).toEqual([]);
    expect(selectEmployeesForDepartment([], 'all')).toEqual([]);
  });

  it('reine Küchen-Liste bleibt bei Service-Export leer (kein Service-Leak)', () => {
    const kitchenOnly = employees.filter(e => e.department === 'küche');
    expect(selectEmployeesForDepartment(kitchenOnly, 'service')).toEqual([]);
    expect(selectEmployeesForDepartment(kitchenOnly, 'küche')).toHaveLength(3);
  });
});
