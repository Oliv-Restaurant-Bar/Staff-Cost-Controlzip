// @vitest-environment node
/**
 * Tests für die «Ganze Woche»-Übersicht des Personalbedarfs.
 */
import { describe, it, expect } from 'vitest';

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import { buildWeekOverview, isEveningShift, buildCellSaveDrafts, EVENING_START_MINUTES } from '@/lib/staffing-week-utils';
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

describe('isEveningShift', () => {
  it('Beginn vor 16:00 = Mittag, ab 16:00 = Abend', () => {
    expect(isEveningShift('11:00')).toBe(false);
    expect(isEveningShift('15:59')).toBe(false);
    expect(isEveningShift('16:00')).toBe(true);
    expect(isEveningShift('18:30')).toBe(true);
    expect(EVENING_START_MINUTES).toBe(960);
  });
});

describe('buildWeekOverview', () => {
  const config = defaultStaffingProfilesConfig('beaulieu'); // kein Umsatzbudget-Default

  it('verteilt Blöcke auf Mittag/Abend und liefert Zellen nur für Tage mit Bedarf', () => {
    const requirements = [
      req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }),
      req({ positionKey: 'service', weekday: 1, shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 3 }),
      req({ positionKey: 'kueche', weekday: 5, shiftStart: '09:00', shiftEnd: '14:00', requiredCount: 1 }),
    ];
    const o = buildWeekOverview({ positions: POSITIONS, requirements, config, season: 'standard' });
    expect(o.hasAny).toBe(true);
    const serviceRow = o.groups
      .flatMap((g) => g.areas)
      .flatMap((a) => a.positions)
      .find((r) => r.positionKey === 'service')!;
    expect(serviceRow.cells[1]).toMatchObject({ mittag: 2, abend: 3 });
    expect(serviceRow.cells[2]).toBeUndefined();
    const kuecheRow = o.groups
      .flatMap((g) => g.areas)
      .flatMap((a) => a.positions)
      .find((r) => r.positionKey === 'kueche')!;
    expect(kuecheRow.cells[5]).toMatchObject({ mittag: 1, abend: 0 });
  });

  it('Tages-Summen: Einsätze und Netto-Stunden (ARG-Pausenabzug) je Tag', () => {
    const requirements = [
      // 11–14 (3h brutto, <5.5h → keine Pause) × 2 = 6.0 h
      req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }),
      // 11–22 (11h brutto, >9h → 1h Pause) × 1 = 10.0 h
      req({ positionKey: 'kueche', weekday: 1, shiftStart: '11:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const o = buildWeekOverview({ positions: POSITIONS, requirements, config, season: 'standard' });
    expect(o.totals[1].persons).toBe(3);
    expect(o.totals[1].nettoHours).toBe(16);
    expect(o.totals[2]).toMatchObject({ persons: 0, nettoHours: 0 });
  });

  it('Umsatzbudget je Wochentag aus der Konfiguration (null wenn fehlt)', () => {
    const withBudget = { ...config, revenueBudgetByWeekday: { 1: 5000 } };
    const o = buildWeekOverview({ positions: POSITIONS, requirements: [req({})], config: withBudget, season: 'standard' });
    expect(o.totals[1].budget).toBe(5000);
    expect(o.totals[2].budget).toBeNull();
  });

  it('leerer Bedarf → hasAny false', () => {
    const o = buildWeekOverview({ positions: POSITIONS, requirements: [], config, season: 'standard' });
    expect(o.hasAny).toBe(false);
  });

  // KOPFZAHL: eine Person zählt 1× pro Tag — Automatik = max(Mittag, Abend),
  // nie die Blocksumme (durchgehende Person mit 2 Blöcken = 1).
  it('Kopfzahl automatisch = max(Mittag, Abend), nicht die Blocksumme', () => {
    const requirements = [
      req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 }),
      req({ positionKey: 'service', weekday: 1, shiftStart: '17:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const o = buildWeekOverview({ positions: POSITIONS, requirements, config, season: 'standard' });
    const row = o.groups.flatMap((g) => g.areas).flatMap((a) => a.positions)
      .find((r) => r.positionKey === 'service')!;
    expect(row.cells[1]).toMatchObject({ mittag: 1, abend: 1, headcount: 1, headcountExplicit: false });
    expect(o.totals[1].persons).toBe(1); // NICHT 2 (dieselbe Person deckt beide Hälften)
  });

  it('explizite Kopfzahl (meta.dayHeadcount) übersteuert die Automatik', () => {
    const requirements = [
      req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1, meta: { dayHeadcount: 2 } }),
      req({ positionKey: 'service', weekday: 1, shiftStart: '17:00', shiftEnd: '22:00', requiredCount: 1 }),
    ];
    const o = buildWeekOverview({ positions: POSITIONS, requirements, config, season: 'standard' });
    const row = o.groups.flatMap((g) => g.areas).flatMap((a) => a.positions)
      .find((r) => r.positionKey === 'service')!;
    expect(row.cells[1]).toMatchObject({ headcount: 2, headcountExplicit: true });
    expect(o.totals[1].persons).toBe(2); // Mittag und Abend sind VERSCHIEDENE Personen
  });

  it('UG-Zuschlag (meta.ugSurcharge) addiert auch auf eine EXPLIZITE Kopfzahl', () => {
    // Basis-Profil sagt explizit 2 Personen; der UG-Zuschlag (+1) darf davon
    // nicht verschluckt werden — Zuschlag = immer zusätzliche Person(en).
    const requirements = [
      req({ positionKey: 'service', weekday: 5, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2, meta: { dayHeadcount: 2 } }),
      req({ positionKey: 'service', weekday: 5, shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 3, meta: { dayHeadcount: 2, ugSurcharge: 1 } }),
    ];
    const o = buildWeekOverview({ positions: POSITIONS, requirements, config, season: 'standard' });
    const row = o.groups.flatMap((g) => g.areas).flatMap((a) => a.positions)
      .find((r) => r.positionKey === 'service')!;
    expect(row.cells[5]).toMatchObject({ headcount: 3, headcountExplicit: true });
  });
});

describe('buildCellSaveDrafts', () => {
  const base = [
    // Mittag-Zeile der bearbeiteten Position
    req({ positionKey: 'service', weekday: 1, shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }),
    // Abend-Zeile derselben Position (andere Tageshälfte)
    req({ positionKey: 'service', weekday: 1, shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 3 }),
    // Andere Position (muss verbatim erhalten bleiben)
    req({ positionKey: 'kueche', weekday: 1, shiftStart: '09:00', shiftEnd: '14:00', requiredCount: 1 }),
  ];

  it('ersetzt nur die bearbeitete Tageshälfte; Rest verbatim', () => {
    const drafts = buildCellSaveDrafts({
      existing: base, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '10:30', shiftEnd: '14:30', requiredCount: 1 }],
    });
    const service = drafts.filter((d) => d.positionKey === 'service');
    expect(service).toHaveLength(2);
    expect(service.some((d) => d.shiftStart === '18:00' && d.requiredCount === 3)).toBe(true);
    expect(service.some((d) => d.shiftStart === '10:30' && d.requiredCount === 1)).toBe(true);
    expect(drafts.filter((d) => d.positionKey === 'kueche')).toHaveLength(1);
  });

  it('Regression: paralleler Refresh der ANDEREN Hälfte überlebt das Speichern', () => {
    // Mittag-Editor offen; währenddessen wird die Abend-Zeile auf 5 geändert.
    const refreshed = base.map((r) =>
      r.shiftStart === '18:00' ? { ...r, requiredCount: 5 } : r);
    const drafts = buildCellSaveDrafts({
      existing: refreshed, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }],
    });
    const abend = drafts.find((d) => d.positionKey === 'service' && d.shiftStart === '18:00');
    expect(abend?.requiredCount).toBe(5);
  });

  it('leere partDrafts löschen die Tageshälfte (Zelle leeren)', () => {
    const drafts = buildCellSaveDrafts({
      existing: base, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'abend', partDrafts: [],
    });
    const service = drafts.filter((d) => d.positionKey === 'service');
    expect(service).toHaveLength(1);
    expect(service[0].shiftStart).toBe('11:00');
  });

  it('dayHeadcount setzt meta.dayHeadcount auf ALLEN Zeilen der Position, andere Positionen unberührt', () => {
    const drafts = buildCellSaveDrafts({
      existing: base, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }],
      dayHeadcount: 3,
    });
    for (const d of drafts.filter((x) => x.positionKey === 'service')) {
      expect(d.meta).toMatchObject({ dayHeadcount: 3 });
    }
    expect(drafts.find((x) => x.positionKey === 'kueche')!.meta ?? {}).not.toHaveProperty('dayHeadcount');
  });

  it('dayHeadcount null löscht das Feld; undefined lässt es unverändert', () => {
    const withHead = base.map((r) =>
      r.positionKey === 'service' ? { ...r, meta: { dayHeadcount: 4, keep: true } } : r);
    const cleared = buildCellSaveDrafts({
      existing: withHead, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }],
      dayHeadcount: null,
    });
    for (const d of cleared.filter((x) => x.positionKey === 'service')) {
      expect(d.meta ?? {}).not.toHaveProperty('dayHeadcount');
    }
    // andere meta-Felder überleben das Löschen
    expect(cleared.find((x) => x.positionKey === 'service' && x.shiftStart === '18:00')!.meta)
      .toMatchObject({ keep: true });
    const untouched = buildCellSaveDrafts({
      existing: withHead, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'mittag',
      partDrafts: [{ shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 2 }],
    });
    expect(untouched.find((x) => x.positionKey === 'service' && x.shiftStart === '18:00')!.meta)
      .toMatchObject({ dayHeadcount: 4 });
  });
});
