// @vitest-environment node
/**
 * Tests für den Stunden-Stapel «Bedarf → Dienstplan → Ist».
 */
import { describe, it, expect } from 'vitest';

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Employee } from '@/types/personnel';
import type { DaySchedule, ActualHourEntry } from '@/lib/supabase-db';
import {
  isoWeekdayOf,
  bedarfNettoHoursForDate,
  bedarfNettoHoursForDates,
  planNettoHoursForDate,
  istHoursForDate,
  diffToBedarf,
} from '@/lib/bedarf-stunden-utils';
import { defaultStaffingProfilesConfig } from '@/lib/staffing-profiles-utils';

const POSITIONS: Position[] = [
  { id: '1', key: 'service', name: 'Service', department: 'service', departmentGroup: null, sortOrder: 1, active: true },
  { id: '2', key: 'kueche', name: 'Kochen (heiss)', department: 'küche', departmentGroup: null, sortOrder: 1, active: true },
] as unknown as Position[];

function req(partial: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: `${partial.positionKey}-${partial.weekday}-${partial.shiftStart}`,
    positionKey: 'service',
    scopeType: 'weekly',
    season: 'standard',
    weekday: 1,
    shiftStart: '11:00',
    shiftEnd: '14:00',
    requiredCount: 1,
    sortOrder: 0,
    meta: null,
    ...partial,
  } as StaffingRequirement;
}

function emp(partial: Partial<Employee>): Employee {
  return {
    id: 'e1',
    name: 'Test',
    department: 'service',
    employmentType: 'hourly',
    hourlyWage: 30,
    isActive: true,
    primaryStation: 'service',
    ...partial,
  } as Employee;
}

const config = defaultStaffingProfilesConfig('beaulieu');

describe('isoWeekdayOf', () => {
  it('liefert ISO-Wochentage (Mo=1 … So=7)', () => {
    expect(isoWeekdayOf('2026-07-27')).toBe(1); // Montag
    expect(isoWeekdayOf('2026-08-02')).toBe(7); // Sonntag
  });
});

describe('bedarfNettoHoursForDate/Dates', () => {
  const requirements = [
    // Mo: 11–14 (3h, keine Pause) × 2 = 6h
    req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }),
    // Mo: 11–22 (11h brutto, 1h ArG-Pause) × 1 = 10h
    req({ positionKey: 'kueche', weekday: 1, shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
  ];

  it('summiert Netto-Stunden (ArG) des zum Datum passenden Wochentags', () => {
    // 2026-07-27 = Montag
    expect(bedarfNettoHoursForDate({ positions: POSITIONS, requirements, config, dateStr: '2026-07-27' })).toBe(16);
    // 2026-07-28 = Dienstag ohne Bedarf
    expect(bedarfNettoHoursForDate({ positions: POSITIONS, requirements, config, dateStr: '2026-07-28' })).toBe(0);
  });

  it('Bereichssumme; null, wenn KEIN Tag Bedarf hat', () => {
    expect(bedarfNettoHoursForDates({
      positions: POSITIONS, requirements, config,
      dates: ['2026-07-27', '2026-07-28'],
    })).toBe(16);
    expect(bedarfNettoHoursForDates({
      positions: POSITIONS, requirements, config,
      dates: ['2026-07-28', '2026-07-29'],
    })).toBeNull();
  });
});

describe('planNettoHoursForDate', () => {
  it('summiert Netto-Stunden der geplanten Einsätze; Absenzen zählen nicht', () => {
    const employees = [emp({ id: 'e1' }), emp({ id: 'e2', name: 'Zwei' })];
    const scheduleData: Record<string, DaySchedule> = {
      // e1: 11–14 (3h) + 18–22 (4h) = 7h (je Segment < 5.5h → keine Pause)
      'e1-2026-07-27': { früh: { start: '11:00', end: '14:00' }, spät: { start: '18:00', end: '22:00' } },
      // e2: Absenz → zählt nicht
      'e2-2026-07-27': { früh: { start: '11:00', end: '14:00' }, frühAbsence: 'ferien' },
    };
    expect(planNettoHoursForDate({ employees, scheduleData, positions: POSITIONS, dateStr: '2026-07-27' })).toBe(7);
  });

  it('null (nie 0), wenn an dem Tag niemand eingeplant ist', () => {
    expect(planNettoHoursForDate({ employees: [emp({})], scheduleData: {}, positions: POSITIONS, dateStr: '2026-07-27' })).toBeNull();
  });
});

describe('istHoursForDate', () => {
  it('summiert gestempelte Stunden des Tages ohne Absenz-Einträge', () => {
    const actual: Record<string, ActualHourEntry> = {
      'e1-2026-07-27': { hours: 7.5 },
      'e2-2026-07-27': { hours: 4, absenceType: 'krank' },
      'e1-2026-07-28': { hours: 8 },
    };
    expect(istHoursForDate(actual, '2026-07-27')).toBe(7.5);
    expect(istHoursForDate(actual, '2026-07-28')).toBe(8);
  });

  it('null (nie 0) ohne Einträge für den Tag — kein MIRUS-Import = leer', () => {
    expect(istHoursForDate({}, '2026-07-27')).toBeNull();
    expect(istHoursForDate({ 'e1-2026-07-27': { hours: 4, absenceType: 'ferien' } }, '2026-07-27')).toBeNull();
  });
});

describe('diffToBedarf', () => {
  it('Differenz mit Vorzeichen; null wenn eine Seite fehlt', () => {
    expect(diffToBedarf(18, 16)).toBe(2);
    expect(diffToBedarf(14.5, 16)).toBe(-1.5);
    expect(diffToBedarf(null, 16)).toBeNull();
    expect(diffToBedarf(18, null)).toBeNull();
  });
});
