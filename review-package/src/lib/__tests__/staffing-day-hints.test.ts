// @vitest-environment node
/**
 * Tests des Live-Hinweises «Plan vs. Bedarf» (Kopfzahl-Logik):
 * Konsistenz mit computeWeekCell, EINDEUTIGE Slot-Zuordnung ohne
 * Mehrfachzählung, Abdeckungs-Warnungen und Stunden-Kostenwarnung.
 */
import { describe, it, expect } from 'vitest';

import { computeDayPlanHints, positionHintLabel } from '@/lib/staffing-day-hints';
import { computeWeekCell } from '@/lib/staffing-week-utils';
import type { StaffingRequirement } from '@/types/staffing';
import type { Position } from '@/types/positions';
import type { PlannedEmployeeDay } from '@/lib/staffing-comparison-utils';

let seq = 0;
function req(partial: Partial<StaffingRequirement>): StaffingRequirement {
  seq += 1;
  return {
    id: `r${seq}`,
    scopeType: 'weekly',
    season: 'standard',
    weekday: 1,
    scopeRef: null,
    positionKey: 'service',
    shiftStart: '11:00',
    shiftEnd: '14:00',
    requiredCount: 1,
    sortOrder: 0,
    meta: {},
    ...partial,
  } as StaffingRequirement;
}

function pos(key: string, name: string, department: 'service' | 'küche' = 'service'): Position {
  return {
    id: key, key, name, department,
    active: true, sortOrder: 0,
  } as unknown as Position;
}

function emp(id: string, positionKey: string | null, slots: { start: string; end: string }[]): PlannedEmployeeDay {
  return { id, department: 'service', positionKey, trainedKeys: positionKey ? [positionKey] : [], slots };
}

const positions = [pos('service', 'Service'), pos('kueche', 'Kochen', 'küche')];

describe('computeDayPlanHints', () => {
  it('durchgehende Person zählt 1× (Kopfzahl, keine Einsätze) — im Bedarf', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [emp('a', 'service', [{ start: '11:00', end: '14:00' }, { start: '18:00', end: '23:00' }])],
    });
    const row = hints.positions.find((p) => p.positionKey === 'service')!;
    // Soll-Kopfzahl = max(M, A) = 1 (identisch zur Wochenzelle) …
    expect(row.soll).toBe(computeWeekCell(requirements).headcount);
    expect(row.soll).toBe(1);
    // … geplant = 1 PERSON (Splitschicht wird nicht doppelt gezählt).
    expect(row.planned).toBe(1);
    expect(row.diff).toBe(0);
    expect(row.status).toBe('optimal');
    expect(hints.warnings).toHaveLength(0);
  });

  it('über/unter Bedarf je Position, Tages-Summen = Σ Kopfzahlen', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 2 }),
      req({ positionKey: 'kueche', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [
        emp('a', 'service', [{ start: '18:00', end: '23:00' }]),
        emp('k1', 'kueche', [{ start: '18:00', end: '23:00' }]),
        emp('k2', 'kueche', [{ start: '18:00', end: '23:00' }]),
      ],
    });
    const service = hints.positions.find((p) => p.positionKey === 'service')!;
    const kueche = hints.positions.find((p) => p.positionKey === 'kueche')!;
    expect(service.diff).toBe(-1);
    expect(service.status).toBe('understaffed');
    expect(positionHintLabel(service.diff)).toBe('unter Bedarf −1');
    expect(kueche.diff).toBe(1);
    expect(kueche.status).toBe('overstaffed');
    expect(positionHintLabel(kueche.diff)).toBe('über Bedarf +1');
    expect(hints.totals.sollPersons).toBe(3);
    expect(hints.totals.plannedPersons).toBe(3);
  });

  it('Splitschicht auf ZWEI Positionen: zählt je Position 1× und im Total 2× (gleiche Einheit wie Soll)', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ positionKey: 'kueche', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [{
        id: 'a', department: 'service', positionKey: 'service',
        trainedKeys: ['service', 'kueche'],
        slots: [{ start: '11:00', end: '14:00' }, { start: '18:00', end: '23:00' }],
      }],
    });
    for (const p of hints.positions) {
      expect(p.planned).toBe(1);
      expect(p.status).toBe('optimal');
    }
    // Total in Soll-Einheit (Σ Positions-Kopfzahlen): 2/2, KEINE falsche Unterbesetzung.
    expect(hints.totals.sollPersons).toBe(2);
    expect(hints.totals.plannedPersons).toBe(2);
    expect(hints.totals.personsStatus).toBe('optimal');
    expect(hints.warnings).toHaveLength(0);
  });

  it('explizite Kopfzahl (meta.dayHeadcount) ist das Soll — wie die Wochenzelle', () => {
    const requirements = [
      req({ positionKey: 'kueche', shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 2, meta: { dayHeadcount: 3 } }),
      req({ positionKey: 'kueche', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 2, meta: { dayHeadcount: 3 } }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1, plannedEmployees: [],
    });
    const row = hints.positions.find((p) => p.positionKey === 'kueche')!;
    expect(row.soll).toBe(3);
    expect(row.headcountExplicit).toBe(true);
    expect(row.soll).toBe(computeWeekCell(requirements).headcount);
  });

  it('unbesetzter Pflicht-Block → Warnung; Regel-Warnungen werden angehängt', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [],
      ruleWarnings: ['Kein Chef de Service planbar — X.', null],
    });
    expect(hints.warnings).toEqual([
      'Service 18:00–23:00 unbesetzt',
      'Kein Chef de Service planbar — X.',
    ]);
    expect(hints.totals.personsStatus).toBe('understaffed');
  });

  it('Kostenwarnung: geplante Netto-Stunden über Bedarf (ArG-Pausenabzug beidseitig)', () => {
    // Soll: 1 Block 18:00–23:00 (5 h brutto, keine Pause) = 5.0 h.
    const requirements = [
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [
        // 11:00–23:00 (12 h brutto → −60 min Pause) = 11.0 h netto > 5.0 h Soll.
        emp('a', 'service', [{ start: '11:00', end: '23:00' }]),
      ],
    });
    expect(hints.totals.sollHours).toBe(5);
    expect(hints.totals.plannedHours).toBe(11);
    expect(hints.totals.hoursOver).toBe(true);
    expect(hints.totals.hoursDiff).toBe(6);
  });

  it('dynamische Regel (preferredKeysById) ordnet fremde Hauptposition dem Regel-Block zu', () => {
    const requirements = [
      req({ positionKey: 'kueche', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const hints = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [emp('miro', 'service', [{ start: '18:00', end: '23:00' }])],
      preferredKeysById: { miro: ['kueche'] },
    });
    const row = hints.positions.find((p) => p.positionKey === 'kueche')!;
    expect(row.planned).toBe(1);
    expect(hints.unmatchedPlanned).toBe(0);
  });

  it('Abteilungsfilter blendet fremde Positionen und Orphans aus', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
      req({ positionKey: 'kueche', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
      req({ positionKey: 'geist', shiftStart: '18:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const scoped = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1,
      plannedEmployees: [], departments: ['küche'],
    });
    expect(scoped.positions.map((p) => p.positionKey)).toEqual(['kueche']);
    const admin = computeDayPlanHints({
      positions, requirements, season: 'standard', weekday: 1, plannedEmployees: [],
    });
    expect(admin.positions.map((p) => p.positionKey).sort()).toEqual(['geist', 'kueche', 'service']);
  });
});
