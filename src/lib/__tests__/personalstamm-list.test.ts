// @vitest-environment node
/**
 * personalstamm-list — Zeilen-View-Model, Status, Sortierung, Zusatzfilter.
 *
 * Fixiert: (1) Status-Wrapper delegiert an die SSoT isEmployeeActiveForDate
 * (inaktiv > ausgetreten > geplant > aktiv), (2) Eintritt TT.MM.JJJJ,
 * fehlend = «—» NIE heutiges Datum, (3) Pensum 42 h = 100 %, fehlend = «—»
 * nie 100 %, (4) zentrale Sortierung (fehlende Eintritte ans Ende),
 * (5) Filter-Optionen nur aus vorhandenen Daten, (6) local.active fliesst
 * NICHT in den Listenstatus ein (Supabase = SSoT).
 */

import { describe, it, expect } from 'vitest';
import {
  employeeListStatus,
  formatEintritt,
  pensumPercent,
  pensumLabel,
  buildEmployeeRow,
  sortEmployeeRows,
  buildPositionOptions,
  buildEintrittsjahrOptions,
  filterEmployeeRows,
  isEmployeeSortKey,
  EMPLOYEE_SORT_OPTIONS,
  type EmployeeListRow,
} from '../personalstamm-list';
import type { Employee } from '@/types/personnel';
import type { Position } from '@/types/positions';

const TODAY = new Date(2026, 6, 23); // 23.07.2026

function makeEmp(over: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    name: 'Anna Muster',
    department: 'service',
    employmentType: 'vollzeit',
    weeklyHours: 42,
    hourlyWage: 30,
    ...over,
  } as Employee;
}

describe('employeeListStatus', () => {
  it('aktiv: kein Austritt, kein Zukunfts-Eintritt', () => {
    expect(employeeListStatus(makeEmp(), TODAY)).toBe('aktiv');
  });

  it('inaktiv gewinnt vor allem anderen (isActive === false)', () => {
    expect(employeeListStatus(makeEmp({ isActive: false }), TODAY)).toBe('inaktiv');
    expect(
      employeeListStatus(makeEmp({ isActive: false, employmentEndDate: '2020-01-01' }), TODAY),
    ).toBe('inaktiv');
  });

  it('ausgetreten: Austritt in der Vergangenheit (SSoT isEmployeeActiveForDate)', () => {
    expect(employeeListStatus(makeEmp({ employmentEndDate: '2026-06-30' }), TODAY)).toBe('ausgetreten');
  });

  it('Austritt heute/zukünftig zählt noch als aktiv (SSoT-Verhalten)', () => {
    expect(employeeListStatus(makeEmp({ employmentEndDate: '2026-07-23' }), TODAY)).toBe('aktiv');
    expect(employeeListStatus(makeEmp({ employmentEndDate: '2026-12-31' }), TODAY)).toBe('aktiv');
  });

  it('eintritt_geplant: contractStart in der Zukunft', () => {
    expect(employeeListStatus(makeEmp({ contractStart: '2026-08-01' }), TODAY)).toBe('eintritt_geplant');
  });

  it('Eintritt heute oder früher = aktiv (nicht geplant)', () => {
    expect(employeeListStatus(makeEmp({ contractStart: '2026-07-23' }), TODAY)).toBe('aktiv');
    expect(employeeListStatus(makeEmp({ contractStart: '2020-01-01' }), TODAY)).toBe('aktiv');
  });

  it('ungültiger contractStart löst keinen Geplant-Status aus', () => {
    expect(employeeListStatus(makeEmp({ contractStart: 'kaputt' }), TODAY)).toBe('aktiv');
  });
});

describe('formatEintritt', () => {
  it('TT.MM.JJJJ aus ISO', () => {
    expect(formatEintritt('2024-03-01')).toBe('01.03.2024');
  });
  it('fehlend/ungültig = «—», nie heutiges Datum', () => {
    expect(formatEintritt(undefined)).toBe('—');
    expect(formatEintritt(null)).toBe('—');
    expect(formatEintritt('')).toBe('—');
    expect(formatEintritt('unsinn')).toBe('—');
  });
});

describe('pensum', () => {
  it('42 h = 100 %, 21 h = 50 %', () => {
    expect(pensumPercent(42)).toBe(100);
    expect(pensumPercent(21)).toBe(50);
    expect(pensumLabel(33.6)).toBe('80 %');
  });
  it('fehlend/0/negativ = «—», NIE 100 %', () => {
    expect(pensumPercent(undefined)).toBeUndefined();
    expect(pensumPercent(0)).toBeUndefined();
    expect(pensumPercent(-5)).toBeUndefined();
    expect(pensumLabel(undefined)).toBe('—');
    expect(pensumLabel(0)).toBe('—');
  });
});

describe('buildEmployeeRow', () => {
  const positions: Position[] = [
    {
      id: 'p1', restaurantId: 'oliv', key: 'chef_de_service', name: 'Chef de Service',
      department: 'service', sortOrder: 1, active: true,
    } as Position,
  ];

  it('füllt Labels, Eintritt, Pensum, Status und Vertrags-Flag', () => {
    const row = buildEmployeeRow(
      makeEmp({ contractStart: '2023-05-15', primaryStation: 'chef_de_service', weeklyHours: 42 }),
      positions, TODAY, true,
    );
    expect(row.deptLabel).toBe('Service');
    expect(row.typeLabel).toBe('Vollzeit');
    expect(row.positionLabel).toBe('Chef de Service');
    expect(row.eintrittLabel).toBe('15.05.2023');
    expect(row.pensumLabel).toBe('100 %');
    expect(row.status).toBe('aktiv');
    expect(row.statusLabel).toBe('Aktiv');
    expect(row.hasContractFile).toBe(true);
  });

  it('Fallback auf positionTitle wenn kein Positions-Key aufgelöst wird', () => {
    const row = buildEmployeeRow(
      makeEmp({ primaryStation: undefined, positionTitle: ' Küchenhilfe ' }),
      positions, TODAY,
    );
    expect(row.positionLabel).toBe('Küchenhilfe');
    expect(row.hasContractFile).toBe(false);
  });
});

describe('sortEmployeeRows (zentrale Sortierung)', () => {
  const rows: EmployeeListRow[] = [
    buildEmployeeRow(makeEmp({ id: 'a', name: 'Zoe', contractStart: '2024-01-01', department: 'küche' }), [], TODAY),
    buildEmployeeRow(makeEmp({ id: 'b', name: 'Anna', contractStart: undefined }), [], TODAY),
    buildEmployeeRow(makeEmp({ id: 'c', name: 'Mia', contractStart: '2025-06-01', employmentEndDate: '2026-01-31' }), [], TODAY),
  ];

  it('name: A–Z (Default)', () => {
    expect(sortEmployeeRows(rows, 'name').map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('eintritt_neu/eintritt_alt: fehlende Eintritte IMMER ans Ende', () => {
    expect(sortEmployeeRows(rows, 'eintritt_neu').map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortEmployeeRows(rows, 'eintritt_alt').map(r => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('status: aktiv vor ausgetreten; Original bleibt unverändert', () => {
    const before = rows.map(r => r.id);
    const sorted = sortEmployeeRows(rows, 'status');
    expect(sorted[sorted.length - 1].id).toBe('c'); // ausgetreten ans Ende
    expect(rows.map(r => r.id)).toEqual(before);
  });

  it('isEmployeeSortKey akzeptiert nur bekannte Keys', () => {
    for (const o of EMPLOYEE_SORT_OPTIONS) expect(isEmployeeSortKey(o.key)).toBe(true);
    expect(isEmployeeSortKey('lohn')).toBe(false);
    expect(isEmployeeSortKey(undefined)).toBe(false);
  });
});

describe('Zusatzfilter Position/Eintrittsjahr', () => {
  const rows: EmployeeListRow[] = [
    buildEmployeeRow(makeEmp({ id: 'a', positionTitle: 'Koch', contractStart: '2024-02-01' }), [], TODAY),
    buildEmployeeRow(makeEmp({ id: 'b', positionTitle: 'Service', contractStart: '2023-09-01' }), [], TODAY),
    buildEmployeeRow(makeEmp({ id: 'c', positionTitle: '', contractStart: undefined }), [], TODAY),
  ];

  it('Optionen nur aus vorhandenen Daten', () => {
    expect(buildPositionOptions(rows)).toEqual(['Koch', 'Service']);
    expect(buildEintrittsjahrOptions(rows)).toEqual(['2024', '2023']);
    expect(buildPositionOptions([rows[2]])).toEqual([]);
    expect(buildEintrittsjahrOptions([rows[2]])).toEqual([]);
  });

  it('filtert nach Position und Jahr; "all" = kein Filter', () => {
    expect(filterEmployeeRows(rows, { position: 'Koch' }).map(r => r.id)).toEqual(['a']);
    expect(filterEmployeeRows(rows, { eintrittsjahr: '2023' }).map(r => r.id)).toEqual(['b']);
    expect(filterEmployeeRows(rows, { position: 'all', eintrittsjahr: 'all' })).toHaveLength(3);
  });

  it('fehlender Eintritt matcht KEIN Jahr (fehlend ≠ 0)', () => {
    expect(filterEmployeeRows(rows, { eintrittsjahr: '2024' }).map(r => r.id)).toEqual(['a']);
  });
});
