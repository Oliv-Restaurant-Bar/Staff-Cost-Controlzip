// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { Department, Employee, DaySchedule } from '@/types/personnel';
import {
  comparisonStatus,
  statusColor,
  statusLabel,
  formatStaffingDiff,
  formatStaffingDiffPersons,
  formatShortStaffingDiff,
  slotOverlapsShift,
  countPlanned,
  plannedIdsForShift,
  assignPlannedToShifts,
  buildPlannedEmployees,
  computeStaffingComparison,
  computeDayStaffingSummary,
  summarizeStaffingKpis,
  staffingTooltipLines,
  staffingHeadline,
  type PlannedEmployeeDay,
  type ShiftComparisonRow,
  type StaffingComparisonResult,
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
  department: Department = 'service',
): PlannedEmployeeDay {
  return { id, department, positionKey, slots };
}

// Standard-Positionen (mit Default-Bereichen über DEFAULT_AREA_BY_KEY auflösbar)
const POSITIONS: Position[] = [
  pos({ key: 'service', name: 'Service', department: 'service', departmentGroup: 'restaurant', sortOrder: 1 }),
  pos({ key: 'bar_buffet_springer', name: 'BAR Buffet/Springer', department: 'service', departmentGroup: 'bar_buffet', sortOrder: 0 }),
  pos({ key: 'kueche', name: 'Küche', department: 'küche', departmentGroup: 'kueche_produktion', sortOrder: 2 }),
  pos({ key: 'abwasch', name: 'Abwasch', department: 'küche', departmentGroup: 'abwasch', sortOrder: 1 }),
];

// ─── comparisonStatus (2 Farben: exakt = optimal/grün, jede Abweichung = rot) ─

describe('comparisonStatus', () => {
  it('optimal NUR bei exakter Erfüllung', () => {
    expect(comparisonStatus(2, 2)).toBe('optimal');
    expect(comparisonStatus(0, 0)).toBe('optimal');
  });
  it('bereits ±1 Person löst aus: zu wenig → understaffed, zu viel → overstaffed', () => {
    expect(comparisonStatus(3, 2)).toBe('understaffed'); // -1
    expect(comparisonStatus(2, 3)).toBe('overstaffed'); // +1
  });
  it('auch bei größeren Abweichungen: Richtung bestimmt den Status', () => {
    expect(comparisonStatus(3, 1)).toBe('understaffed'); // -2
    expect(comparisonStatus(1, 3)).toBe('overstaffed'); // +2
    expect(comparisonStatus(5, 1)).toBe('understaffed'); // -4
  });
});

// ─── statusColor / statusLabel (2-Farben-Abbildung + Beschriftung) ────────────

describe('statusColor / statusLabel', () => {
  it('nur optimal ist grün, über-/unterbesetzt sind rot', () => {
    expect(statusColor('optimal')).toBe('green');
    expect(statusColor('overstaffed')).toBe('red');
    expect(statusColor('understaffed')).toBe('red');
  });
  it('liefert die deutschen Anzeigebezeichnungen', () => {
    expect(statusLabel('optimal')).toBe('Optimal');
    expect(statusLabel('overstaffed')).toBe('Überbesetzt');
    expect(statusLabel('understaffed')).toBe('Unterbesetzt');
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
    expect(r.rows[0]).toMatchObject({ required: 2, planned: 2, diff: 0, status: 'optimal' });
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
    expect(abw).toMatchObject({ planned: 1, diff: -1, status: 'understaffed' });
    expect(kue).toMatchObject({ planned: 1, diff: -2, status: 'understaffed' });
  });

  it('Szenario 3 — Überbesetzung → overstaffed (rot) bereits bei +1 und auch bei +2', () => {
    const reqs1 = [req({ positionKey: 'bar_buffet_springer', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 })];
    const over1 = [
      pe('a', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }]),
      pe('b', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }]),
    ];
    const r1 = computeStaffingComparison({ positions: POSITIONS, requirements: reqs1, plannedEmployees: over1, season: 'standard', weekday: 1 });
    expect(r1.rows[0]).toMatchObject({ planned: 2, diff: 1, status: 'overstaffed' });

    const over2 = [...over1, pe('c', 'bar_buffet_springer', [{ start: '11:00', end: '22:00' }])];
    const r2 = computeStaffingComparison({ positions: POSITIONS, requirements: reqs1, plannedEmployees: over2, season: 'standard', weekday: 1 });
    expect(r2.rows[0]).toMatchObject({ planned: 3, diff: 2, status: 'overstaffed' });
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
    expect(früh).toMatchObject({ required: 2, planned: 2, status: 'optimal' });
    expect(spät).toMatchObject({ required: 3, planned: 1, diff: -2, status: 'understaffed' });
  });

  it('Szenario 6 — Position ohne aktive Mitarbeitende → geplant 0, rot', () => {
    const requirements = [req({ positionKey: 'kueche', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 })];
    // niemand hat Hauptposition kueche
    const planned = [pe('a', 'service', [{ start: '11:00', end: '22:00' }])];
    const r = computeStaffingComparison({ positions: POSITIONS, requirements, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const kue = r.rows.find((x) => x.positionKey === 'kueche')!;
    expect(kue).toMatchObject({ planned: 0, diff: -2, status: 'understaffed' });
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
    expect(r.orphanPositions[0].shifts[0]).toMatchObject({ planned: 1, status: 'optimal' });
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
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 }), // 2/2 optimal
      req({ positionKey: 'kueche', shiftStart: '09:00', shiftEnd: '17:00', requiredCount: 3 }), // 1/3 unterbesetzt (−2)
      req({ positionKey: 'abwasch', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }), // 2/1 überbesetzt (+1)
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
    expect(r.counts).toEqual({ optimal: 1, overstaffed: 1, understaffed: 1 });
  });
});

// ─── formatShortStaffingDiff (Badge-Kurzform) ─────────────────────────────────

describe('formatShortStaffingDiff', () => {
  it('kompakt mit Vorzeichen (U+2212) und ±0', () => {
    expect(formatShortStaffingDiff(0)).toBe('±0');
    expect(formatShortStaffingDiff(1)).toBe('+1');
    expect(formatShortStaffingDiff(-1)).toBe('−1');
    expect(formatShortStaffingDiff(-3)).toBe('−3');
  });
});

// ─── computeDayStaffingSummary (Tages-Badge je Abteilung) ─────────────────────

describe('computeDayStaffingSummary', () => {
  const DAY_REQS = [
    req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 }),
    req({ positionKey: 'kueche', shiftStart: '09:00', shiftEnd: '17:00', requiredCount: 2 }),
  ];

  it('exakt passend → grün, diff 0 (Service und Küche getrennt)', () => {
    const planned = [
      pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('s2', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('k1', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
      pe('k2', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: planned, season: 'standard', weekday: 1 });
    expect(r.hasRequirements).toBe(true);
    expect(r.departments).toHaveLength(2);
    const service = r.departments.find((d) => d.department === 'service')!;
    const kueche = r.departments.find((d) => d.department === 'küche')!;
    expect(service).toMatchObject({ required: 2, planned: 2, diff: 0, status: 'optimal', unmatchedPlanned: 0 });
    expect(kueche).toMatchObject({ required: 2, planned: 2, diff: 0, status: 'optimal', unmatchedPlanned: 0 });
  });

  it('1 Person zu viel → overstaffed (+1), andere Abteilung bleibt unberührt', () => {
    const planned = [
      pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('s2', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('s3', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('k1', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
      pe('k2', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const service = r.departments.find((d) => d.department === 'service')!;
    const kueche = r.departments.find((d) => d.department === 'küche')!;
    expect(service).toMatchObject({ required: 2, planned: 3, diff: 1, status: 'overstaffed' });
    expect(kueche).toMatchObject({ diff: 0, status: 'optimal' });
  });

  it('1 Person zu wenig → understaffed (−1), Service/Küche getrennt bewertet', () => {
    const planned = [
      pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('s2', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('k1', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const service = r.departments.find((d) => d.department === 'service')!;
    const kueche = r.departments.find((d) => d.department === 'küche')!;
    expect(service).toMatchObject({ diff: 0, status: 'optimal' });
    expect(kueche).toMatchObject({ required: 2, planned: 1, diff: -1, status: 'understaffed' });
  });

  it('Tag ohne Personalbedarf → hasRequirements=false, keine Abteilungen', () => {
    const r = computeDayStaffingSummary({
      positions: POSITIONS,
      requirements: DAY_REQS, // nur weekday 1
      plannedEmployees: [pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service')],
      season: 'standard',
      weekday: 3,
    });
    expect(r.hasRequirements).toBe(false);
    expect(r.departments).toHaveLength(0);
  });

  it('Tag ohne Dienstplan-Einträge → Ist 0, rot mit voller Unterdeckung', () => {
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: [], season: 'standard', weekday: 1 });
    const service = r.departments.find((d) => d.department === 'service')!;
    expect(service).toMatchObject({ required: 2, planned: 0, diff: -2, status: 'understaffed', unmatchedPlanned: 0 });
  });

  it('Einheiten: 1 MA mit Früh+Spät erfüllt 2 Bedarfs-Schichten derselben Position', () => {
    const reqs = [
      req({ positionKey: 'service', shiftStart: '10:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ positionKey: 'service', shiftStart: '17:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const planned = [
      pe('s1', 'service', [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '22:00' }], 'service'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: reqs, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const service = r.departments.find((d) => d.department === 'service')!;
    expect(service).toMatchObject({ required: 2, planned: 2, diff: 0, status: 'optimal' });
  });

  it('unmatchedPlanned: produktiv geplante MA ohne passende Bedarfs-Schicht werden ausgewiesen', () => {
    const planned = [
      pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('s2', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      // Hauptposition fehlt → matcht keine Schicht, ist aber eingeplant:
      pe('x1', null, [{ start: '11:00', end: '22:00' }], 'service'),
      // Zeit ohne Überschneidung mit der Küchen-Schicht (09–17):
      pe('k1', 'kueche', [{ start: '18:00', end: '23:00' }], 'küche'),
      pe('k2', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
      pe('k3', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: planned, season: 'standard', weekday: 1 });
    const service = r.departments.find((d) => d.department === 'service')!;
    const kueche = r.departments.find((d) => d.department === 'küche')!;
    expect(service).toMatchObject({ planned: 2, status: 'optimal', unmatchedPlanned: 1 });
    expect(kueche).toMatchObject({ planned: 2, status: 'optimal', unmatchedPlanned: 1 });
  });

  it('Abteilungsfilter (Rollen-Scoping): nur gescopte Abteilungen erscheinen', () => {
    const planned = [
      pe('s1', 'service', [{ start: '11:00', end: '22:00' }], 'service'),
      pe('k1', 'kueche', [{ start: '09:00', end: '17:00' }], 'küche'),
    ];
    const r = computeDayStaffingSummary({ positions: POSITIONS, requirements: DAY_REQS, plannedEmployees: planned, season: 'standard', weekday: 1, departments: ['küche'] });
    expect(r.departments).toHaveLength(1);
    expect(r.departments[0].department).toBe('küche');
    // hasRequirements bezieht sich auf den TAG (vor Filter)
    expect(r.hasRequirements).toBe(true);
  });

  it('plannedIdsForShift liefert die gematchten IDs (Basis für unmatched-Hinweis)', () => {
    const planned = [
      pe('a', 'service', [{ start: '11:00', end: '22:00' }]),
      pe('b', 'service', [{ start: '06:00', end: '10:00' }]),
      pe('c', 'kueche', [{ start: '11:00', end: '22:00' }]),
    ];
    expect(plannedIdsForShift(planned, 'service', '11:00', '22:00')).toEqual(['a']);
  });
});

// ─── formatStaffingDiffPersons (Personenangabe ohne Richtungstext) ────────────

describe('formatStaffingDiffPersons', () => {
  it('±0 bei exakter Erfüllung', () => {
    expect(formatStaffingDiffPersons(0)).toBe('±0');
  });
  it('Überbesetzung mit Plus-Vorzeichen und Plural', () => {
    expect(formatStaffingDiffPersons(1)).toBe('+1 Person');
    expect(formatStaffingDiffPersons(2)).toBe('+2 Personen');
  });
  it('Unterbesetzung mit U+2212-Minus und Plural', () => {
    expect(formatStaffingDiffPersons(-1)).toBe('−1 Person');
    expect(formatStaffingDiffPersons(-3)).toBe('−3 Personen');
  });
});

// ─── summarizeStaffingKpis (KPI-Kacheln) ──────────────────────────────────────

describe('summarizeStaffingKpis', () => {
  function kpiRow(diff: number, shiftStart = '11:00', shiftEnd = '22:00'): ShiftComparisonRow {
    const required = 2;
    const planned = required + diff;
    return {
      positionKey: 'service',
      shiftStart,
      shiftEnd,
      required,
      planned,
      diff,
      status: comparisonStatus(required, planned),
      assigned: [],
    };
  }

  it('leere Liste → alles 0', () => {
    expect(summarizeStaffingKpis([])).toEqual({
      optimal: 0,
      overstaffed: 0,
      understaffed: 0,
      overstaffPersonShifts: 0,
      understaffPersonShifts: 0,
      overtimePotentialHours: 0,
    });
  });

  it('zählt Status je Schicht und summiert Personen-Schichten', () => {
    const rows = [kpiRow(0), kpiRow(1), kpiRow(2), kpiRow(-1), kpiRow(-3)];
    const k = summarizeStaffingKpis(rows);
    expect(k.optimal).toBe(1);
    expect(k.overstaffed).toBe(2);
    expect(k.understaffed).toBe(2);
    expect(k.overstaffPersonShifts).toBe(3); // +1 +2
    expect(k.understaffPersonShifts).toBe(4); // 1 + 3
  });

  it('Überstunden-Potenzial = fehlende Personen × Schichtdauer (nur Unterbesetzung)', () => {
    // −2 Personen auf einer 4h-Schicht (09:00–13:00) → 8 h; Überbesetzung zählt nicht.
    const rows = [kpiRow(-2, '09:00', '13:00'), kpiRow(3, '11:00', '22:00')];
    const k = summarizeStaffingKpis(rows);
    expect(k.overtimePotentialHours).toBe(8);
  });

  it('ignoriert ungültige/leere Schichtzeiten bei den Stunden (Dauer 0)', () => {
    const rows = [kpiRow(-1, '22:00', '11:00'), kpiRow(-2, '10:00', '10:00')];
    const k = summarizeStaffingKpis(rows);
    expect(k.understaffPersonShifts).toBe(3);
    expect(k.overtimePotentialHours).toBe(0);
  });
});

// ─── staffingTooltipLines (Differenz-Tooltip) ─────────────────────────────────

describe('staffingTooltipLines', () => {
  it('immer Benötigt/Geplant/Differenz/Berechnungsgrundlage, Umsatz nur falls vorhanden', () => {
    const lines = staffingTooltipLines({ required: 3, planned: 2, diff: -1 });
    expect(lines.map((l) => l.label)).toEqual([
      'Benötigtes Personal',
      'Geplantes Personal',
      'Differenz',
      'Berechnungsgrundlage',
    ]);
    expect(lines.find((l) => l.label === 'Differenz')!.value).toBe('−1 Person');
  });

  it('rendert Umsatz/Produktivität/Umsatz pro Mitarbeiter, wenn Werte übergeben werden', () => {
    const lines = staffingTooltipLines({
      required: 2,
      planned: 3,
      diff: 1,
      revenue: 5400,
      productivity: 1350,
      revenuePerEmployee: 1800,
    });
    const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
    expect(byLabel['Umsatz']).toBe('CHF 5400');
    expect(byLabel['Produktivität']).toBe('1350');
    expect(byLabel['Umsatz pro Mitarbeiter']).toBe('CHF 1800');
    expect(byLabel['Differenz']).toBe('+1 Person');
  });
});

// ─── staffingHeadline (kompakter Kopfzeilen-Status) ───────────────────────────

function headlineRow(required: number, planned: number): ShiftComparisonRow {
  return {
    positionKey: 'srv',
    shiftStart: '10:00',
    shiftEnd: '14:00',
    required,
    planned,
    diff: planned - required,
    status: comparisonStatus(required, planned),
    assigned: [],
  };
}

function resultFrom(
  rows: ShiftComparisonRow[],
  hasRequirements = rows.length > 0,
): StaffingComparisonResult {
  const totals = rows.reduce(
    (t, r) => ({
      required: t.required + r.required,
      planned: t.planned + r.planned,
      diff: t.diff + r.diff,
    }),
    { required: 0, planned: 0, diff: 0 },
  );
  const counts = rows.reduce(
    (c, r) => {
      c[r.status] += 1;
      return c;
    },
    { optimal: 0, overstaffed: 0, understaffed: 0 },
  );
  return { hasRequirements, groups: [], orphanPositions: [], rows, totals, counts };
}

describe('staffingHeadline', () => {
  it('kein Bedarf definiert → kind none, neutral', () => {
    const h = staffingHeadline(resultFrom([], false));
    expect(h.kind).toBe('none');
    expect(h.tone).toBe('neutral');
    expect(h.label).toBe('Kein Bedarf definiert');
  });

  it('Bedarf vorhanden aber keine Zeilen im eigenen Bereich → none', () => {
    // hasRequirements true, aber rows leer (z.B. gescopte Rolle)
    const h = staffingHeadline(resultFrom([], true));
    expect(h.kind).toBe('none');
  });

  it('alle Schichten exakt erfüllt → Im Plan (grün)', () => {
    const h = staffingHeadline(resultFrom([headlineRow(3, 3), headlineRow(2, 2)]));
    expect(h.kind).toBe('optimal');
    expect(h.tone).toBe('green');
    expect(h.label).toBe('Im Plan');
  });

  it('nur Unterbesetzung → understaffed mit Personenanzahl (rot)', () => {
    const h = staffingHeadline(resultFrom([headlineRow(3, 1), headlineRow(2, 2)]));
    expect(h.kind).toBe('understaffed');
    expect(h.tone).toBe('red');
    expect(h.understaffPersons).toBe(2);
    expect(h.label).toBe('2 Personen unterbesetzt');
  });

  it('Singular bei genau 1 Person', () => {
    const h = staffingHeadline(resultFrom([headlineRow(3, 2)]));
    expect(h.label).toBe('1 Person unterbesetzt');
  });

  it('nur Überbesetzung → overstaffed mit Personenanzahl (rot)', () => {
    const h = staffingHeadline(resultFrom([headlineRow(2, 4)]));
    expect(h.kind).toBe('overstaffed');
    expect(h.tone).toBe('red');
    expect(h.overstaffPersons).toBe(2);
    expect(h.label).toBe('2 Personen überbesetzt');
  });

  it('Mischfall (unter- UND überbesetzt) mittelt sich NICHT zu Im Plan', () => {
    // Netto diff = 0, aber es gibt echte Abweichungen → mixed, rot.
    const h = staffingHeadline(resultFrom([headlineRow(3, 1), headlineRow(1, 3)]));
    expect(h.kind).toBe('mixed');
    expect(h.tone).toBe('red');
    expect(h.understaffPersons).toBe(2);
    expect(h.overstaffPersons).toBe(2);
  });
});

// ─── assignPlannedToShifts (eindeutige Einsatz-Zuordnung) ─────────────────────

describe('assignPlannedToShifts', () => {
  const p = (over: Partial<PlannedEmployeeDay> & { id: string }): PlannedEmployeeDay => ({
    department: 'service',
    positionKey: 'service',
    slots: [{ start: '11:00', end: '22:00' }],
    ...over,
  });

  it('keine Mehrfachzählung: durchgehende Schicht zählt nur im Block mit grösster Überlappung', () => {
    const shifts = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }),
      req({ positionKey: 'service', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 2 }),
    ];
    const m = assignPlannedToShifts(shifts, [p({ id: 'a' })]);
    expect(m.get(0)).toBeUndefined(); // 3h Überlappung
    expect(m.get(1)?.map((x) => x.id)).toEqual(['a']); // 5h Überlappung gewinnt
  });

  it('getrennte Früh+Spät-Einsätze füllen zwei Blöcke (je Einsatz ein Block)', () => {
    const shifts = [
      req({ positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ positionKey: 'service', shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const m = assignPlannedToShifts(shifts, [
      p({ id: 'a', slots: [{ start: '11:00', end: '14:00' }, { start: '18:00', end: '22:00' }] }),
    ]);
    expect(m.get(0)?.map((x) => x.id)).toEqual(['a']);
    expect(m.get(1)?.map((x) => x.id)).toEqual(['a']);
  });

  it('Zweitposition zählt, wenn kein Block der Hauptposition passt', () => {
    const shifts = [req({ positionKey: 'bar_oben', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 })];
    const m = assignPlannedToShifts(shifts, [
      p({ id: 'a', positionKey: 'service', trainedKeys: ['service', 'bar_oben'] }),
    ]);
    expect(m.get(0)?.[0]).toMatchObject({ id: 'a', via: 'zweit' });
  });

  it('Hauptposition gewinnt bei gleicher Überlappung vor Zweitposition', () => {
    const shifts = [
      req({ positionKey: 'bar_oben', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 }),
      req({ positionKey: 'service', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const m = assignPlannedToShifts(shifts, [
      p({ id: 'a', positionKey: 'service', trainedKeys: ['service', 'bar_oben'] }),
    ]);
    expect(m.get(1)?.[0]).toMatchObject({ id: 'a', via: 'haupt' });
    expect(m.get(0)).toBeUndefined();
  });

  it('dynamische Regel (preferredKeysById) hat Vorrang vor der Hauptposition', () => {
    const shifts = [
      req({ positionKey: 'service', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 }),
      req({ positionKey: 'chef_de_service', shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 }),
    ];
    const m = assignPlannedToShifts(shifts, [p({ id: 'cds', positionKey: 'service' })], {
      cds: ['chef_de_service'],
    });
    expect(m.get(1)?.[0]).toMatchObject({ id: 'cds', via: 'regel' });
    expect(m.get(0)).toBeUndefined();
  });

  it('Legacy-Alias: Hauptposition «bar» zählt auf BAR-Buffet-Bedarf (via alias)', () => {
    const shifts = [req({ positionKey: 'bar_buffet_springer', shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 })];
    const m = assignPlannedToShifts(shifts, [p({ id: 'a', positionKey: 'bar', trainedKeys: ['bar'] })]);
    expect(m.get(0)?.[0]).toMatchObject({ id: 'a', via: 'alias' });
  });

  it('ohne Zeitüberlappung oder ohne passende Position keine Zuordnung', () => {
    const shifts = [req({ positionKey: 'service', shiftStart: '06:00', shiftEnd: '08:00', requiredCount: 1 })];
    const m = assignPlannedToShifts(shifts, [
      p({ id: 'a' }), // Zeit passt nicht
      p({ id: 'b', positionKey: 'kueche', trainedKeys: ['kueche'], department: 'küche' }), // Position passt nicht
    ]);
    expect(m.size).toBe(0);
  });
});

// Determinismus-Absicherung: gleiche Überlappung + gleiche Stufe → erster Block
// der (sortierten) Liste gewinnt stabil.
describe('assignPlannedToShifts – deterministischer Gleichstand', () => {
  it('bei identischer Überlappung und Stufe gewinnt der zuerst gelistete Block', () => {
    const shifts = [
      req({ id: 'block-a', positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ id: 'block-b', positionKey: 'service', shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
    ];
    const m = assignPlannedToShifts(shifts, [
      { id: 'a', department: 'service', positionKey: 'service', slots: [{ start: '11:00', end: '14:00' }] },
    ]);
    expect(m.get(0)?.map((x) => x.id)).toEqual(['a']);
    expect(m.get(1)).toBeUndefined();
  });
});
