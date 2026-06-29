// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Department, Employee, DaySchedule } from '@/types/personnel';
import {
  comparisonStatus,
  formatStaffingDiff,
  slotOverlapsShift,
  countPlanned,
  buildPlannedEmployees,
  computeStaffingComparison,
  type PlannedEmployeeDay,
} from '@/lib/staffing-comparison-utils';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function pos(
  over: Partial<Position> & { key: string; department: Department },
): Position {
  return {
    id: over.id ?? over.key,
    restaurantId: 'b-1',
    key: over.key,
    name: over.name ?? over.key,
    department: over.department,
    departmentGroup: over.departmentGroup,
    color: over.color,
    icon: over.icon,
    sortOrder: over.sortOrder ?? 0,
    active: over.active ?? true,
  };
}

function req(
  over: Partial<StaffingRequirement> & {
    positionKey: string;
    shiftStart: string;
    shiftEnd: string;
    requiredCount: number;
  },
): StaffingRequirement {
  return {
    id: over.id ?? `${over.positionKey}-${over.shiftStart}-${over.shiftEnd}`,
    restaurantId: 'b-1',
    scopeType: over.scopeType ?? 'weekly',
    season: over.season ?? 'standard',
    weekday: over.weekday ?? 1,
    scopeRef: over.scopeRef ?? null,
    positionKey: over.positionKey,
    shiftStart: over.shiftStart,
    shiftEnd: over.shiftEnd,
    requiredCount: over.requiredCount,
    sortOrder: over.sortOrder ?? 0,
    meta: over.meta ?? {},
  };
}

function emp(over: Partial<Employee> & { id: string }): Employee {
  return {
    id: over.id,
    name: over.name ?? over.id,
    department: over.department ?? 'service',
    employmentType: over.employmentType ?? 'vollzeit',
    hourlyWage: over.hourlyWage ?? 0,
    primaryStation: over.primaryStation,
    secondaryStations: over.secondaryStations,
    isActive: over.isActive,
  };
}

function pe(
  id: string,
  positionKey: string | null,
  slots: { start: string; end: string }[],
): PlannedEmployeeDay {
  return { id, positionKey, slots };
}

// Standard-Positionen (mit Default-Bereichen über DEFAULT_AREA_BY_KEY auflösbar)
const POSITIONS: Position[] = [
  pos({ key: 'service', name: 'Service', department: 'service', departmentGroup: 'restaurant', sortOrder: 1 }),
  pos({ key: 'bar_buffet_springer', name: 'BAR Buffet/Springer', department: 'service', departmentGroup: 'bar_buffet', sortOrder: 0 }),
  pos({ key: 'kueche', name: 'Küche', department: 'küche', departmentGroup: 'kueche_produktion', sortOrder: 2 }),
  pos({ key: 'abwasch', name: 'Abwasch', department: 'küche', departmentGroup: 'abwasch', sortOrder: 1 }),
];

// ─── comparisonStatus (symmetrisch über |diff|) ───────────────────────────────

describe('comparisonStatus', () => {
  it('grün NUR bei exakter Erfüllung', () => {
    expect(comparisonStatus(2, 2)).toBe('green');
    expect(comparisonStatus(0, 0)).toBe('green');
  });
  it('rot bei jeder Abweichung — bereits bei 1 zu wenig oder 1 zu viel', () => {
    expect(comparisonStatus(3, 2)).toBe('red'); // -1
    expect(comparisonStatus(2, 3)).toBe('red'); // +1
  });
  it('rot auch bei größeren Abweichungen', () => {
    expect(comparisonStatus(3, 1)).toBe('red'); // -2
    expect(comparisonStatus(1, 3)).toBe('red'); // +2
    expect(comparisonStatus(5, 1)).toBe('red'); // -4
  });
});

// ─── formatStaffingDiff ───────────────────────────────────────────────────────

describe('formatStaffingDiff', () => {
  it('zeigt die genaue Differenz mit Vorzeichen, Plural und Richtung', () => {
    expect(formatStaffingDiff(0)).toBe('±0');
    expect(formatStaffingDiff(1)).toBe('+1 Person zu viel');
    expect(formatStaffingDiff(2)).toBe('+2 Personen zu viel');
    expect(formatStaffingDiff(-1)).toBe('−1 Person zu wenig');
    expect(formatStaffingDiff(-2)).toBe('−2 Personen zu wenig');
  });
});

// ─── slotOverlapsShift ────────────────────────────────────────────────────────

describe('slotOverlapsShift', () => {
  it('true bei echter Überschneidung', () => {
    expect(slotOverlapsShift({ start: '09:00', end: '17:00' }, '11:00', '22:00')).toBe(true);
    expect(slotOverlapsShift({ start: '18:00', end: '23:00' }, '11:00', '22:00')).toBe(true);
  });
  it('false wenn sich die Slots nur berühren (Ende == Beginn)', () => {
    expect(slotOverlapsShift({ start: '08:00', end: '11:00' }, '11:00', '22:00')).toBe(false);
    expect(slotOverlapsShift({ start: '22:00', end: '23:00' }, '11:00', '22:00')).toBe(false);
  });
  it('false bei disjunkten, leeren oder ungültigen Slots', () => {
    expect(slotOverlapsShift({ start: '06:00', end: '09:00' }, '11:00', '22:00')).toBe(false);
    expect(slotOverlapsShift({ start: '17:00', end: '17:00' }, '11:00', '22:00')).toBe(false);
    expect(slotOverlapsShift({ start: 'xx:xx', end: '17:00' }, '11:00', '22:00')).toBe(false);
  });
});

// ─── countPlanned ─────────────────────────────────────────────────────────────

describe('countPlanned', () => {
  const planned = [
    pe('a', 'service', [{ start: '11:00', end: '22:00' }]),
    pe('b', 'service', [{ start: '09:00', end: '13:00' }]),
    pe('c', 'service', [{ start: '06:00', end: '10:00' }]), // außerhalb
    pe('d', 'kueche', [{ start: '11:00', end: '22:00' }]), // falsche Position
  ];
  it('zählt nur passende Position + Zeitüberschneidung', () => {
    expect(countPlanned(planned, 'service', '11:00', '22:00')).toBe(2);
    expect(countPlanned(planned, 'kueche', '11:00', '22:00')).toBe(1);
    expect(countPlanned(planned, 'abwasch', '11:00', '22:00')).toBe(0);
  });
});

// ─── buildPlannedEmployees ────────────────────────────────────────────────────

describe('buildPlannedEmployees', () => {
  const employees: Employee[] = [
    emp({ id: 'e1', primaryStation: 'service' }),
    emp({ id: 'e2', primaryStation: 'kueche', department: 'küche' }),
    emp({ id: 'e3', primaryStation: 'service', isActive: false }), // archiviert
    emp({ id: 'e4', primaryStation: 'Service' }), // Alt-Anzeigename
    emp({ id: 'e5', primaryStation: 'service' }), // Abwesenheit
    emp({ id: 'e6', primaryStation: 'service' }), // kein Eintrag
  ];
  const date = '2026-06-29';
  const schedule: Record<string, DaySchedule> = {
    'e1-2026-06-29': { früh: { start: '11:00', end: '16:00' }, spät: { start: '16:00', end: '22:00' } },
    'e2-2026-06-29': { früh: { start: '09:00', end: '17:00' } },
    'e3-2026-06-29': { früh: { start: '11:00', end: '16:00' } },
    'e4-2026-06-29': { früh: { start: '11:00', end: '16:00' } },
    'e5-2026-06-29': { früh: { start: '11:00', end: '16:00' }, frühAbsence: 'FE' },
    // e6 hat keinen Eintrag
  };

  it('inkludiert aktive Mitarbeiter mit produktiven Slots', () => {
    const result = buildPlannedEmployees(employees, schedule, POSITIONS, date);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(['e1', 'e2', 'e4']);
  });
  it('nimmt beide produktiven Slots (früh + spät)', () => {
    const result = buildPlannedEmployees(employees, schedule, POSITIONS, date);
    const e1 = result.find((r) => r.id === 'e1')!;
    expect(e1.slots).toHaveLength(2);
  });
  it('löst Alt-Anzeigenamen der Hauptposition auf einen Slug auf', () => {
    const result = buildPlannedEmployees(employees, schedule, POSITIONS, date);
    expect(result.find((r) => r.id === 'e4')!.positionKey).toBe('service');
  });
  it('schließt Abwesenheiten und fehlende Einträge aus', () => {
    const result = buildPlannedEmployees(employees, schedule, POSITIONS, date);
    expect(result.some((r) => r.id === 'e5')).toBe(false);
    expect(result.some((r) => r.id === 'e6')).toBe(false);
  });
});

// ─── computeStaffingComparison: geforderte Szenarien ──────────────────────────

describe('computeStaffingComparison', () => {
  it('Szenario 1 — Bedarf exakt erfüllt → grün, Differenz 0', () => {
    const requirements = [req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 })];
    const planned = [
      pe('a', 'service', [{ start: '11:00', end: '22:00' }]),
      pe('b', 'service', [{ start: '12:00', end: '20:00' }]),
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    expect(r.hasRequirements).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ required: 2, planned: 2, diff: 0, status: 'green' });
    expect(r.groups.find((g) => g.department === 'service')).toBeTruthy();
  });

  it('Szenario 2 — Unterbesetzung → rot bereits bei −1 und auch bei −2+', () => {
    const requirements = [
      req({ positionKey: 'abwasch', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 }),
      req({ positionKey: 'kueche', shiftStart: '09:00', shiftEnd: '17:00', requiredCount: 3 }),
    ];
    const planned = [
      pe('a', 'abwasch', [{ start: '11:00', end: '22:00' }]), // -1 → rot
      pe('b', 'kueche', [{ start: '09:00', end: '17:00' }]), // -2 → rot
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const abw = r.rows.find((x) => x.positionKey === 'abwasch')!;
    const kue = r.rows.find((x) => x.positionKey === 'kueche')!;
    expect(abw).toMatchObject({ planned: 1, diff: -1, status: 'red' });
    expect(kue).toMatchObject({ planned: 1, diff: -2, status: 'red' });
  });

  it('Szenario 3 — Überbesetzung → rot bereits bei +1 und auch bei +2', () => {
    const reqs1 = [req({ positionKey: 'bar_buffet_springer', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 })];
    const over1 = [
      pe('a', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }]),
      pe('b', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }]),
    ];
    const r1 = computeStaffingComparison({ positions: POSITIONS, requirements: reqs1, plannedEmployees: over1, season: 'standard', weekday: 1 });
    expect(r1.rows[0]).toMatchObject({ planned: 2, diff: 1, status: 'red' });

    const over2 = [...over1, pe('c', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }])];
    const r2 = computeStaffingComparison({ positions: POSITIONS, requirements: reqs1, plannedEmployees: over2, season: 'standard', weekday: 1 });
    expect(r2.rows[0]).toMatchObject({ planned: 3, diff: 2, status: 'red' });
  });

  it('Szenario 4 — kein Bedarf für den Tag → hasRequirements=false, keine Gruppen', () => {
    const requirements = [req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2, weekday: 1 })];
    // anderer Wochentag
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: [], season: 'standard', weekday: 2 });
    expect(r.hasRequirements).toBe(false);
    expect(r.groups).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
    // leere Bedarfsliste
    const empty = computeStaffingComparison({ positions: POSITIONS, requirements: [], plannedEmployees: [], season: 'standard', weekday: 1 });
    expect(empty.hasRequirements).toBe(false);
  });

  it('Szenario 5 — mehrere Schichten am gleichen Tag werden je Schicht bewertet', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '09:00', shiftEnd: '15:00', requiredCount: 2, sortOrder: 0 }),
      req({ positionKey: 'service', shiftStart: '15:00', shiftEnd: '22:00', requiredCount: 3, sortOrder: 1 }),
    ];
    const planned = [
      pe('a', 'service', [{ start: '09:00', end: '15:00' }]), // nur früh
      pe('b', 'service', [{ start: '09:00', end: '15:00' }]), // nur früh
      pe('c', 'service', [{ start: '15:00', end: '22:00' }]), // nur spät
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const servicePos = r.groups
      .flatMap((g) => g.areas)
      .flatMap((a) => a.positions)
      .find((p) => p.position.key === 'service')!;
    expect(servicePos.shifts).toHaveLength(2);
    const früh = servicePos.shifts.find((s) => s.shiftStart === '09:00')!;
    const spät = servicePos.shifts.find((s) => s.shiftStart === '15:00')!;
    expect(früh).toMatchObject({ required: 2, planned: 2, status: 'green' });
    expect(spät).toMatchObject({ required: 3, planned: 1, diff: -2, status: 'red' });
  });

  it('Szenario 6 — Position ohne aktive Mitarbeitende → geplant 0, rot', () => {
    const requirements = [req({ positionKey: 'kueche', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 })];
    // niemand hat Hauptposition kueche
    const planned = [pe('a', 'service', [{ start: '11:00', end: '22:00' }])];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const kue = r.rows.find((x) => x.positionKey === 'kueche')!;
    expect(kue).toMatchObject({ planned: 0, diff: -2, status: 'red' });
  });

  // ─── Zusatz: Robustheit ─────────────────────────────────────────────────────

  it('weist Bedarf für inaktive/unbekannte Positions-Slugs als Orphan aus (kein stilles Verwerfen)', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
      req({ positionKey: 'alt_geloescht', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const planned = [
      pe('a', 'service', [{ start: '11:00', end: '22:00' }]),
      pe('z', 'alt_geloescht', [{ start: '11:00', end: '22:00' }]),
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    expect(r.orphanPositions).toHaveLength(1);
    expect(r.orphanPositions[0]).toMatchObject({ positionKey: 'alt_geloescht' });
    expect(r.orphanPositions[0].shifts[0]).toMatchObject({ planned: 1, status: 'green' });
    // beide Zeilen fließen in die Summen ein
    expect(r.rows).toHaveLength(2);
  });

  it('Abteilungsfilter (Rollen-Scoping) blendet fremde Abteilungen + Orphans aus', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
      req({ positionKey: 'kueche', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
      req({ positionKey: 'alt_geloescht', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: [], season: 'standard', weekday: 1, departments: ['küche'] });
    expect(r.groups.every((g) => g.department === 'küche')).toBe(true);
    expect(r.rows.every((row) => row.positionKey === 'kueche')).toBe(true);
    expect(r.orphanPositions).toHaveLength(0);
    // hasRequirements bleibt true (es GIBT Bedarf an dem Tag), auch wenn gescopt
    expect(r.hasRequirements).toBe(true);
  });

  it('aggregiert Summen und Ampel-Zählung über alle gerenderten Zeilen', () => {
    const requirements = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 }), // 2/2 grün
      req({ positionKey: 'kueche', shiftStart: '09:00', shiftEnd: '17:00', requiredCount: 3 }), // 1/3 rot
      req({ positionKey: 'abwasch', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }), // 2/1 rot (+1)
    ];
    const planned = [
      pe('a', 'service', [{ start: '11:00', end: '22:00' }]),
      pe('b', 'service', [{ start: '11:00', end: '22:00' }]),
      pe('c', 'kueche', [{ start: '09:00', end: '17:00' }]),
      pe('d', 'abwasch', [{ start: '11:00', end: '22:00' }]),
      pe('e', 'abwasch', [{ start: '11:00', end: '22:00' }]),
    ];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    expect(r.totals).toEqual({ required: 6, planned: 5, diff: -1 });
    expect(r.counts).toEqual({ green: 1, red: 2 });
  });
});
