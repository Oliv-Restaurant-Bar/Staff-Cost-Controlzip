// @vitest-environment node
/**
 * Tests für die «Ganze Woche»-Übersicht des Personalbedarfs.
 */
import { describe, it, expect } from 'vitest';

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import { buildWeekOverview, isEveningShift, buildCellSaveDrafts, ruleFallbackHeadcount, EVENING_START_MINUTES } from '@/lib/staffing-week-utils';
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

  it("part 'day' ersetzt ALLE Blöcke der Position an dem Tag; Rest verbatim", () => {
    const drafts = buildCellSaveDrafts({
      existing: base, season: 'standard', weekday: 1,
      positionKey: 'service', part: 'day',
      partDrafts: [
        { shiftStart: '11:00', shiftEnd: '14:00', requiredCount: 1 },
        { shiftStart: '17:30', shiftEnd: '23:00', requiredCount: 2 },
      ],
    });
    const service = drafts.filter((d) => d.positionKey === 'service');
    expect(service).toHaveLength(2);
    expect(service.some((d) => d.shiftStart === '18:00')).toBe(false); // alte Abend-Zeile ersetzt
    expect(service.some((d) => d.shiftStart === '17:30' && d.requiredCount === 2)).toBe(true);
    expect(drafts.filter((d) => d.positionKey === 'kueche')).toHaveLength(1);
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

describe('ruleFallbackHeadcount (Regelwert regelbasierter Positionen)', () => {
  const cfg = defaultStaffingProfilesConfig('oliv');

  it('CdS: 1 sobald Prioritätenliste konfiguriert, sonst null', () => {
    expect(ruleFallbackHeadcount('chef_de_service', 2, cfg)).toBe(1);
    expect(ruleFallbackHeadcount('chef_de_service', 2, { ...cfg, cdsPriority: [] })).toBeNull();
  });

  it('Gastgeber/GF: 1 an Do–Sa, 0 an So–Mi, null ohne zweite Priorität', () => {
    expect(ruleFallbackHeadcount('gastgeber_gf', 4, cfg)).toBe(1);
    expect(ruleFallbackHeadcount('gastgeber_gf', 6, cfg)).toBe(1);
    expect(ruleFallbackHeadcount('gastgeber_gf', 1, cfg)).toBe(0);
    expect(ruleFallbackHeadcount('gastgeber_gf', 7, cfg)).toBe(0);
    expect(ruleFallbackHeadcount('gastgeber_gf', 5, { ...cfg, cdsPriority: ['nur-eine'] })).toBeNull();
  });

  it('Kalte Küche/Sushi: 1 mit Küchen-Regel, null ohne', () => {
    expect(ruleFallbackHeadcount('kalte_kueche', 3, cfg)).toBe(cfg.kitchenCold ? 1 : null);
    expect(ruleFallbackHeadcount('sushi', 3, { ...cfg, kitchenCold: null })).toBeNull();
    expect(ruleFallbackHeadcount('service', 3, cfg)).toBeNull();
  });
});

describe('Manuelle Übersteuerung regelbasierter Zellen (Zellen-Speichern)', () => {
  it('Eintrag setzt Zeilen für gastgeber_gf; Zelle leeren entfernt sie wieder (Regel greift)', () => {
    // Übersteuern: leerer Bestand → ein Block Do 17–23 × 1.
    const set = buildCellSaveDrafts({
      existing: [req({ positionKey: 'service', weekday: 4 })],
      season: 'standard', weekday: 4, positionKey: 'gastgeber_gf', part: 'day',
      partDrafts: [{ shiftStart: '17:00', shiftEnd: '23:00', requiredCount: 1 }],
    });
    expect(set.filter((d) => d.positionKey === 'gastgeber_gf')).toHaveLength(1);
    expect(set.filter((d) => d.positionKey === 'service')).toHaveLength(1); // verbatim erhalten

    // Leeren: bestehende Übersteuerung + keine neuen Blöcke → Zeilen weg.
    const cleared = buildCellSaveDrafts({
      existing: [
        req({ positionKey: 'gastgeber_gf', weekday: 4, shiftStart: '17:00', shiftEnd: '23:00' }),
        req({ positionKey: 'service', weekday: 4 }),
      ],
      season: 'standard', weekday: 4, positionKey: 'gastgeber_gf', part: 'day',
      partDrafts: [], dayHeadcount: null,
    });
    expect(cleared.filter((d) => d.positionKey === 'gastgeber_gf')).toHaveLength(0);
    expect(cleared.filter((d) => d.positionKey === 'service')).toHaveLength(1);
  });
});

describe('Regelbasierte Positionen erscheinen IMMER in der Wochenübersicht', () => {
  const cfg = defaultStaffingProfilesConfig('oliv');
  const posWithRule: Position[] = [
    ...POSITIONS,
    { id: '3', key: 'gastgeber_gf', name: 'Gastgeber/GF', department: 'service', departmentGroup: null, sortOrder: 2, active: true },
  ] as unknown as Position[];

  it('ohne Zeilen: Zeile vorhanden, alle Zellen leer, Totale unverändert', () => {
    const ov = buildWeekOverview({
      positions: posWithRule,
      requirements: [req({ positionKey: 'service', weekday: 1 })],
      config: cfg, season: 'standard',
    });
    const rows = ov.groups.flatMap((g) => g.areas.flatMap((a) => a.positions));
    const gg = rows.find((r) => r.positionKey === 'gastgeber_gf');
    expect(gg).toBeDefined();
    expect(Object.keys(gg!.cells)).toHaveLength(0); // leer = Regel greift
    // Nicht-regelbasierte Position ohne Bedarf bleibt ausgeblendet.
    expect(rows.find((r) => r.positionKey === 'kueche')).toBeUndefined();
    // Regelwert fliesst NIE in die Totale ein.
    expect(ov.totals[4].persons).toBe(0);
  });

  it('mit Übersteuerung: Zelle gefüllt und in den Totalen enthalten', () => {
    const ov = buildWeekOverview({
      positions: posWithRule,
      requirements: [req({ positionKey: 'gastgeber_gf', weekday: 4, shiftStart: '17:00', shiftEnd: '23:00' })],
      config: cfg, season: 'standard',
    });
    const gg = ov.groups.flatMap((g) => g.areas.flatMap((a) => a.positions))
      .find((r) => r.positionKey === 'gastgeber_gf');
    expect(gg?.cells[4]?.headcount).toBe(1);
    expect(ov.totals[4].persons).toBe(1);
  });
});
