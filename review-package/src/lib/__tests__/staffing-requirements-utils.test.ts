// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import {
  SEASONS,
  DEFAULT_SEASON,
  SCOPE_WEEKLY,
  seasonLabel,
  isSeasonAvailable,
  WEEKDAYS,
  weekdayLabel,
  weekdayShort,
  isValidTime,
  timeToMinutes,
  minutesToTime,
  shiftDuration,
  defaultShiftDraft,
  validateShiftDraft,
  isShiftDraftValid,
  sortShifts,
  shiftsForScope,
  totalRequired,
  buildRequirementMatrix,
} from '@/lib/staffing-requirements-utils';

// ── Test-Fixtures ──────────────────────────────────────────────────────────────

let posSeq = 0;
function pos(p: Partial<Position> & { key: string; department: Position['department'] }): Position {
  posSeq += 1;
  return {
    id: `p-${posSeq}`,
    restaurantId: 'oliv',
    key: p.key,
    name: p.name ?? p.key,
    department: p.department,
    departmentGroup: p.departmentGroup,
    color: p.color,
    icon: p.icon,
    sortOrder: p.sortOrder ?? 0,
    active: p.active ?? true,
  };
}

let reqSeq = 0;
function req(r: Partial<StaffingRequirement> & { positionKey: string }): StaffingRequirement {
  reqSeq += 1;
  return {
    id: `r-${reqSeq}`,
    restaurantId: 'oliv',
    scopeType: r.scopeType ?? SCOPE_WEEKLY,
    season: r.season ?? 'standard',
    weekday: r.weekday ?? 1,
    scopeRef: r.scopeRef ?? null,
    positionKey: r.positionKey,
    shiftStart: r.shiftStart ?? '11:00',
    shiftEnd: r.shiftEnd ?? '22:00',
    requiredCount: r.requiredCount ?? 1,
    sortOrder: r.sortOrder ?? 0,
    meta: r.meta ?? {},
  };
}

// ── Saison ──────────────────────────────────────────────────────────────────────

describe('Saison', () => {
  it('hat genau die vier definierten Saisons; custom ist deaktiviert', () => {
    expect(SEASONS.map((s) => s.key)).toEqual(['standard', 'sommer', 'winter', 'custom']);
    expect(SEASONS.filter((s) => s.available).map((s) => s.key)).toEqual(['standard', 'sommer', 'winter']);
    expect(DEFAULT_SEASON).toBe('standard');
  });

  it('seasonLabel / isSeasonAvailable', () => {
    expect(seasonLabel('sommer')).toBe('Sommer');
    expect(seasonLabel('custom')).toBe('Individuelle Saison');
    expect(seasonLabel('unbekannt')).toBe('unbekannt');
    expect(isSeasonAvailable('winter')).toBe(true);
    expect(isSeasonAvailable('custom')).toBe(false);
    expect(isSeasonAvailable('xyz')).toBe(false);
  });
});

// ── Wochentag ────────────────────────────────────────────────────────────────────

describe('Wochentag (ISO 1..7)', () => {
  it('ist Mo..So in Reihenfolge', () => {
    expect(WEEKDAYS.map((w) => w.value)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(WEEKDAYS[0]).toMatchObject({ value: 1, label: 'Montag', short: 'Mo' });
    expect(WEEKDAYS[6]).toMatchObject({ value: 7, label: 'Sonntag', short: 'So' });
  });

  it('weekdayLabel / weekdayShort tolerieren ungültige Werte', () => {
    expect(weekdayLabel(3)).toBe('Mittwoch');
    expect(weekdayShort(6)).toBe('Sa');
    expect(weekdayLabel(null)).toBe('');
    expect(weekdayLabel(0)).toBe('');
    expect(weekdayShort(8)).toBe('');
  });
});

// ── Zeit-Helfer ──────────────────────────────────────────────────────────────────

describe('Zeit-Helfer', () => {
  it('isValidTime akzeptiert nur 00:00..23:59', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('09:05')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('9:5')).toBe(false);
    expect(isValidTime('11:60')).toBe(false);
    expect(isValidTime('')).toBe(false);
    expect(isValidTime(null)).toBe(false);
    expect(isValidTime(undefined)).toBe(false);
  });

  it('timeToMinutes / minutesToTime', () => {
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('11:30')).toBe(690);
    expect(timeToMinutes('23:59')).toBe(1439);
    expect(timeToMinutes('bad')).toBeNaN();
    expect(minutesToTime(0)).toBe('00:00');
    expect(minutesToTime(690)).toBe('11:30');
    expect(minutesToTime(1439)).toBe('23:59');
    expect(minutesToTime(-10)).toBe('00:00');
    expect(minutesToTime(99999)).toBe('23:59');
  });

  it('shiftDuration nur bei Ende NACH Start', () => {
    expect(shiftDuration('11:00', '22:00')).toBe(660);
    expect(shiftDuration('18:00', '23:00')).toBe(300);
    expect(shiftDuration('22:00', '22:00')).toBeNaN();
    expect(shiftDuration('22:00', '06:00')).toBeNaN();
    expect(shiftDuration('bad', '22:00')).toBeNaN();
  });
});

// ── Validierung ──────────────────────────────────────────────────────────────────

describe('validateShiftDraft', () => {
  it('gültiger Entwurf hat keine Fehler', () => {
    expect(validateShiftDraft({ shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 })).toEqual([]);
    expect(isShiftDraftValid({ shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 2 })).toBe(true);
  });

  it('defaultShiftDraft ist gültig', () => {
    expect(isShiftDraftValid(defaultShiftDraft())).toBe(true);
  });

  it('ungültige Zeiten / Reihenfolge / Anzahl werden gemeldet', () => {
    expect(validateShiftDraft({ shiftStart: 'x', shiftEnd: '22:00', requiredCount: 1 })).toHaveLength(1);
    expect(validateShiftDraft({ shiftStart: '22:00', shiftEnd: '11:00', requiredCount: 1 })).toContain(
      'Schichtende muss nach dem Schichtbeginn liegen.',
    );
    expect(validateShiftDraft({ shiftStart: '11:00', shiftEnd: '11:00', requiredCount: 1 })).toHaveLength(1);
    expect(validateShiftDraft({ shiftStart: '11:00', shiftEnd: '22:00', requiredCount: -1 })).toHaveLength(1);
    expect(validateShiftDraft({ shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1.5 })).toHaveLength(1);
    expect(isShiftDraftValid({ shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 0 })).toBe(true);
  });
});

// ── Sortieren / Filtern ──────────────────────────────────────────────────────────

describe('sortShifts', () => {
  it('sortiert nach sortOrder, dann Start, dann Ende', () => {
    const shifts = [
      req({ positionKey: 'a', sortOrder: 1, shiftStart: '18:00', shiftEnd: '23:00' }),
      req({ positionKey: 'a', sortOrder: 0, shiftStart: '11:00', shiftEnd: '15:00' }),
      req({ positionKey: 'a', sortOrder: 0, shiftStart: '11:00', shiftEnd: '14:00' }),
    ];
    const sorted = sortShifts(shifts);
    expect(sorted.map((s) => s.shiftEnd)).toEqual(['14:00', '15:00', '23:00']);
  });

  it('mutiert die Eingabe nicht', () => {
    const shifts = [req({ positionKey: 'a', sortOrder: 1 }), req({ positionKey: 'a', sortOrder: 0 })];
    const before = shifts.map((s) => s.id);
    sortShifts(shifts);
    expect(shifts.map((s) => s.id)).toEqual(before);
  });
});

describe('shiftsForScope', () => {
  const data = [
    req({ positionKey: 'kueche', season: 'standard', weekday: 1, shiftStart: '11:00' }),
    req({ positionKey: 'kueche', season: 'standard', weekday: 1, shiftStart: '17:00', sortOrder: 1 }),
    req({ positionKey: 'kueche', season: 'standard', weekday: 2 }), // anderer Wochentag
    req({ positionKey: 'kueche', season: 'sommer', weekday: 1 }), // andere Saison
    req({ positionKey: 'service', season: 'standard', weekday: 1 }), // andere Position
    req({ positionKey: 'kueche', season: 'standard', weekday: 1, scopeType: 'holiday' }), // anderer scopeType
  ];

  it('filtert exakt auf scopeType=weekly × Saison × Wochentag × Position', () => {
    const res = shiftsForScope(data, 'standard', 1, 'kueche');
    expect(res).toHaveLength(2);
    expect(res.map((s) => s.shiftStart)).toEqual(['11:00', '17:00']);
  });

  it('ohne positionKey liefert alle Positionen des Bereichs', () => {
    const res = shiftsForScope(data, 'standard', 1);
    expect(res.map((s) => s.positionKey).sort()).toEqual(['kueche', 'kueche', 'service']);
  });

  it('leeres Ergebnis bei unbekanntem Bereich', () => {
    expect(shiftsForScope(data, 'winter', 1, 'kueche')).toEqual([]);
  });
});

describe('totalRequired', () => {
  it('summiert requiredCount', () => {
    expect(totalRequired([req({ positionKey: 'a', requiredCount: 2 }), req({ positionKey: 'a', requiredCount: 3 })])).toBe(5);
    expect(totalRequired([])).toBe(0);
  });
});

// ── Bedarfsmatrix ────────────────────────────────────────────────────────────────

describe('buildRequirementMatrix', () => {
  const positions = [
    pos({ key: 'service', name: 'Service', department: 'service', departmentGroup: 'restaurant', sortOrder: 0 }),
    pos({ key: 'bar_buffet_springer', name: 'BAR', department: 'service', departmentGroup: 'bar_buffet', sortOrder: 1 }),
    pos({ key: 'kueche', name: 'Küche', department: 'küche', departmentGroup: 'kueche_produktion', sortOrder: 0 }),
    pos({ key: 'abwasch', name: 'Abwasch', department: 'küche', departmentGroup: 'abwasch', sortOrder: 1 }),
    pos({ key: 'alt_inaktiv', name: 'Alt', department: 'küche', departmentGroup: 'abwasch', active: false }),
  ];

  it('gruppiert hierarchisch Abteilung → Bereich → Position (kanonische Reihenfolge)', () => {
    const matrix = buildRequirementMatrix(positions, [], 'standard', 1);
    expect(matrix.map((d) => d.department)).toEqual(['service', 'küche']);
    // Service: Restaurant vor Bar/Buffet (AREAS_BY_DEPARTMENT-Reihenfolge)
    expect(matrix[0].areas.map((a) => a.area?.key)).toEqual(['restaurant', 'bar_buffet']);
    expect(matrix[0].areas[0].positions.map((p) => p.position.key)).toEqual(['service']);
    // Küche: Küche Produktion vor Abwasch
    expect(matrix[1].areas.map((a) => a.area?.key)).toEqual(['kueche_produktion', 'abwasch']);
  });

  it('blendet inaktive Positionen aus', () => {
    const matrix = buildRequirementMatrix(positions, [], 'standard', 1);
    const abwasch = matrix[1].areas.find((a) => a.area?.key === 'abwasch');
    expect(abwasch?.positions.map((p) => p.position.key)).toEqual(['abwasch']);
  });

  it('blendet leere Bereiche und leere Abteilungen aus', () => {
    const onlyService = [pos({ key: 'service', department: 'service', departmentGroup: 'restaurant' })];
    const matrix = buildRequirementMatrix(onlyService, [], 'standard', 1);
    expect(matrix).toHaveLength(1);
    expect(matrix[0].department).toBe('service');
    expect(matrix[0].areas).toHaveLength(1);
    expect(matrix[0].areas[0].area?.key).toBe('restaurant');
  });

  it('ordnet jeder Position ihre Schichten des Geltungsbereichs zu', () => {
    const reqs = [
      req({ positionKey: 'kueche', season: 'standard', weekday: 1, shiftStart: '11:00' }),
      req({ positionKey: 'kueche', season: 'standard', weekday: 1, shiftStart: '17:00', sortOrder: 1 }),
      req({ positionKey: 'kueche', season: 'standard', weekday: 2 }), // anderer Tag → ignoriert
      req({ positionKey: 'service', season: 'standard', weekday: 1 }),
    ];
    const matrix = buildRequirementMatrix(positions, reqs, 'standard', 1);
    const kueche = matrix[1].areas[0].positions.find((p) => p.position.key === 'kueche');
    expect(kueche?.shifts.map((s) => s.shiftStart)).toEqual(['11:00', '17:00']);
    const service = matrix[0].areas[0].positions.find((p) => p.position.key === 'service');
    expect(service?.shifts).toHaveLength(1);
  });

  it('leere Positionsliste → leere Matrix', () => {
    expect(buildRequirementMatrix([], [], 'standard', 1)).toEqual([]);
  });
});
