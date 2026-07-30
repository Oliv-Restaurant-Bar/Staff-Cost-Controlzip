// @vitest-environment node
/**
 * buildWeekCompare — Wochen-Abgleich «Bedarf vs. Planung vs. Ist» der
 * Personalbedarf-Seite (gemeinsame Berechnung mit computeDayPlanHints).
 */
import { describe, it, expect } from 'vitest';
import { buildWeekCompare } from '@/lib/staffing-week-compare';
import { defaultStaffingProfilesConfig } from '@/lib/staffing-profiles-utils';
import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Employee } from '@/types/personnel';

const WEEK = [
  '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30',
  '2026-07-31', '2026-08-01', '2026-08-02',
]; // Mo–So

const pos = (over: Partial<Position>): Position => ({
  id: over.key ?? 'p', restaurantId: 'oliv', key: 'service', name: 'Service',
  department: 'service', sortOrder: 0, active: true, ...over,
} as Position);

let reqId = 0;
const req = (over: Partial<StaffingRequirement>): StaffingRequirement => ({
  id: `r${++reqId}`, scopeType: 'weekly', season: 'standard', weekday: 1,
  scopeRef: null, positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00',
  requiredCount: 1, sortOrder: 0, meta: {},
  ...over,
} as StaffingRequirement);

const emp = (id: string, station = 'Service'): Employee => ({
  id, name: id, department: 'service', primaryStation: station, isActive: true,
} as unknown as Employee);

const config = defaultStaffingProfilesConfig('oliv');

describe('buildWeekCompare', () => {
  it('Kopfzahl je Position/Tag, Stunden und Ist aus einer gemeinsamen Berechnung', () => {
    const positions = [pos({})];
    const requirements = [
      req({ weekday: 1 }),                                  // Mo 11–14 ×1
      req({ weekday: 5, requiredCount: 2 }),                // Fr 11–14 ×2
    ];
    const scheduleData = {
      // Mo: eine Person geplant (deckt den Block).
      'a-2026-07-27': { früh: { start: '11:00', end: '14:00' } },
      // Di: Planung OHNE Bedarf.
      'a-2026-07-28': { früh: { start: '11:00', end: '14:00' } },
    } as never;
    const actualHours = {
      'a-2026-07-27': { hours: 4 },
    } as never;

    const c = buildWeekCompare({
      positions, requirements, config,
      employees: [emp('a')], scheduleData, actualHours, dates: WEEK,
    });

    expect(c.hasAnyRequirement).toBe(true);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].positionKey).toBe('service');
    expect(c.rows[0].cells[1]).toEqual({ soll: 1, planned: 1, diff: 0 });
    expect(c.rows[0].cells[5]).toEqual({ soll: 2, planned: 0, diff: -2 });
    expect(c.rows[0].cells[2]).toBeUndefined(); // Di: kein Bedarf → keine Zelle

    // Tage: Mo hat Plan+Ist, Di nur Plan (unmatched), Mi–So leer.
    const mo = c.days[0];
    expect(mo.weekday).toBe(1);
    expect(mo.bedarfHours).toBe(3); // 11–14 netto 3 h
    expect(mo.planHours).toBe(3);
    expect(mo.istHours).toBe(4);
    const di = c.days[1];
    expect(di.planHours).toBe(3);
    expect(di.istHours).toBeNull();
    expect(c.days[2].planHours).toBeNull(); // niemand geplant → null, nie 0

    // Wochen-Totale (Kopfzahl in Soll-Einheit; Stunden 0.1 h gerundet).
    expect(c.totals.sollPersons).toBe(3); // Mo 1 + Fr 2
    expect(c.totals.planPersons).toBe(1); // nur Mo zugeordnet (Di unmatched)
    expect(c.totals.sollHours).toBe(9);   // Mo 3 + Fr 6
    expect(c.totals.planHours).toBe(6);   // Mo 3 + Di 3
    expect(c.totals.istHours).toBe(4);
  });

  it('leere Woche: keine Zeilen, Plan/Ist-Totale null (nie 0)', () => {
    const c = buildWeekCompare({
      positions: [pos({})], requirements: [], config,
      employees: [], scheduleData: {}, actualHours: {}, dates: WEEK,
    });
    expect(c.hasAnyRequirement).toBe(false);
    expect(c.hasAnyPlan).toBe(false);
    expect(c.rows).toHaveLength(0);
    expect(c.totals.planPersons).toBeNull();
    expect(c.totals.planHours).toBeNull();
    expect(c.totals.istHours).toBeNull();
  });

  it('Splitschicht über 2 Positionen: Person zählt 2× (gleiche Einheit wie Soll)', () => {
    const positions = [pos({}), pos({ key: 'bar', name: 'Bar', id: 'bar' })];
    const requirements = [
      req({ weekday: 1, positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00' }),
      req({ weekday: 1, positionKey: 'bar', shiftStart: '17:00', shiftEnd: '20:00' }),
    ];
    // Eine Person deckt beide Blöcke ab (Zweitposition Bar).
    const scheduleData = {
      'a-2026-07-27': {
        früh: { start: '11:00', end: '14:00' },
        spät: { start: '17:00', end: '20:00' },
      },
    } as never;
    const employees = [{
      id: 'a', name: 'a', department: 'service', primaryStation: 'Service',
      secondaryStations: ['Bar'], isActive: true,
    } as unknown as Employee];

    const c = buildWeekCompare({
      positions, requirements, config,
      employees, scheduleData, actualHours: {}, dates: WEEK,
    });
    // Beide Positionszellen gedeckt UND Tages-/Wochen-Plan-Total in derselben
    // Einheit (Σ Positions-Kopfzahlen = 2), nicht «unique Personen» (1).
    expect(c.rows.find((r) => r.positionKey === 'service')?.cells[1].planned).toBe(1);
    expect(c.rows.find((r) => r.positionKey === 'bar')?.cells[1].planned).toBe(1);
    expect(c.days[0].hints.totals.plannedPersons).toBe(2);
    expect(c.totals.planPersons).toBe(2);
    expect(c.totals.sollPersons).toBe(2);
  });

  it('explizite Kopfzahl (meta.dayHeadcount) führt das Soll der Zelle', () => {
    const requirements = [
      req({ weekday: 3, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 3, meta: { dayHeadcount: 5 } }),
      req({ weekday: 3, shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3 }),
    ];
    const c = buildWeekCompare({
      positions: [pos({})], requirements, config,
      employees: [], scheduleData: {}, actualHours: {}, dates: WEEK,
    });
    expect(c.rows[0].cells[3].soll).toBe(5);
    expect(c.totals.sollPersons).toBe(5);
  });
});
