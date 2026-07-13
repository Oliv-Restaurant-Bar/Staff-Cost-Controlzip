// @vitest-environment node
/**
 * Tests der reinen Empfehlungslogik (staffing-recommendations.ts).
 * Synthetische Fixtures — Juli 2026: Freitage = 3./10./17./24./31.,
 * Montage = 6./13./20./27.
 */
import { describe, it, expect } from 'vitest';
import type { DrilldownFactCell, DrilldownShiftTimes } from '../personal-controlling-drilldown';
import {
  RECO_THRESHOLDS,
  MAX_VISIBLE_RECOMMENDATIONS,
  DEFAULT_SIMULATION_ADJUSTMENTS,
  isoWeekdayFromDate,
  dataBasisForDays,
  buildRecoDayFacts,
  groupComparableDays,
  buildStaffingRecommendations,
  sortRecommendations,
  filterRecommendations,
  visibleRecommendations,
  applySimulation,
  type StaffingRecoInput,
  type StaffingRecommendation,
  type SimulationBase,
} from '../staffing-recommendations';

// ── Fixture-Helfer ───────────────────────────────────────────────────────────

const FRIDAYS = ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24'];
const MONDAYS = ['2026-07-06', '2026-07-13', '2026-07-20'];

function cell(empId: string, date: string, over: Partial<DrilldownFactCell> = {}): DrilldownFactCell {
  return {
    empId, date, dayNum: parseInt(date.slice(-2), 10),
    planH: 0, istH: 0, planCHF: 0, istCHF: 0,
    zusatz: false, absence: null, overtime: false, missingStamp: false,
    ...over,
  };
}

function baseInput(over: Partial<StaffingRecoInput> = {}): StaffingRecoInput {
  return {
    year: 2026, month: 7, lastCompletedDay: 31,
    cells: [], employees: [], shiftTimes: {},
    requirements: [], season: 'standard',
    positionLabels: { service: 'Service', kueche: 'Küche' },
    dailyRevenue: {}, personsByDate: null,
    ...over,
  };
}

function slots(empId: string, date: string, st: Partial<DrilldownShiftTimes>): [string, DrilldownShiftTimes] {
  return [`${empId}|${date}`, { planSlots: [], istSlots: [], planBreakH: null, ...st }];
}

/** Unterbesetzungs-Szenario: SOLL 2, geplant 1 an allen 4 Freitagen. */
function understaffedInput(): StaffingRecoInput {
  const cells: DrilldownFactCell[] = [];
  const shiftTimes: Record<string, DrilldownShiftTimes> = {};
  for (const d of FRIDAYS) {
    cells.push(cell('e1', d, { planH: 5, istH: 5, planCHF: 200, istCHF: 200 }));
    const [k, v] = slots('e1', d, {
      planSlots: [{ start: '18:00', end: '23:00' }],
      istSlots: [{ start: '18:00', end: '23:00' }],
    });
    shiftTimes[k] = v;
  }
  return baseInput({
    cells, shiftTimes,
    employees: [{ id: 'e1', position: 'service' }],
    requirements: [{ season: 'standard', weekday: 5, positionKey: 'service', shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 2 }],
  });
}

/** Überbesetzungs-Szenario: SOLL 1, geplant 2 an allen 4 Freitagen. */
function overstaffedInput(): StaffingRecoInput {
  const cells: DrilldownFactCell[] = [];
  const shiftTimes: Record<string, DrilldownShiftTimes> = {};
  for (const d of FRIDAYS) {
    for (const e of ['e1', 'e2']) {
      cells.push(cell(e, d, { planH: 4, istH: 4, planCHF: 160, istCHF: 160 }));
      const [k, v] = slots(e, d, {
        planSlots: [{ start: '18:00', end: '22:00' }],
        istSlots: [{ start: '18:00', end: '22:00' }],
      });
      shiftTimes[k] = v;
    }
  }
  return baseInput({
    cells, shiftTimes,
    employees: [{ id: 'e1', position: 'service' }, { id: 'e2', position: 'service' }],
    requirements: [{ season: 'standard', weekday: 5, positionKey: 'service', shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 1 }],
  });
}

// ── Basis-Helfer ─────────────────────────────────────────────────────────────

describe('isoWeekdayFromDate', () => {
  it('liefert ISO-Wochentage (Mo=1 … So=7)', () => {
    expect(isoWeekdayFromDate('2026-07-13')).toBe(1); // Montag
    expect(isoWeekdayFromDate('2026-07-03')).toBe(5); // Freitag
    expect(isoWeekdayFromDate('2026-07-12')).toBe(7); // Sonntag
  });
  it('liefert null bei defektem Datum', () => {
    expect(isoWeekdayFromDate('kaputt')).toBeNull();
  });
});

describe('dataBasisForDays', () => {
  it('Skala: gering 3, mittel 4, hoch ab 5', () => {
    expect(dataBasisForDays(3)).toBe('gering');
    expect(dataBasisForDays(4)).toBe('mittel');
    expect(dataBasisForDays(5)).toBe('hoch');
  });
});

// ── Faktenaufbau & Gruppierung ───────────────────────────────────────────────

describe('buildRecoDayFacts', () => {
  it('gruppiert gleiche Wochentage korrekt und trennt Positionen', () => {
    const cells = [
      ...FRIDAYS.map((d) => cell('e1', d, { planH: 5, istH: 5 })),
      ...FRIDAYS.map((d) => cell('e2', d, { planH: 6, istH: 6 })),
      ...MONDAYS.map((d) => cell('e1', d, { planH: 4, istH: 4 })),
    ];
    const input = baseInput({
      cells,
      employees: [{ id: 'e1', position: 'service' }, { id: 'e2', position: 'kueche' }],
    });
    const groups = groupComparableDays(buildRecoDayFacts(input));
    const keys = groups.map((g) => `${g.weekday}|${g.positionKey}`);
    expect(keys).toEqual(['1|service', '5|kueche', '5|service']);
    expect(groups.find((g) => g.positionKey === 'kueche')!.days).toHaveLength(4);
  });

  it('schliesst Tage ohne jede Aktivität (Ruhetage) aus — auch bei vorhandenem SOLL', () => {
    const input = baseInput({
      cells: [cell('e1', '2026-07-03', { planH: 5 })], // nur 1 aktiver Tag
      employees: [{ id: 'e1', position: 'service' }],
      requirements: [{ season: 'standard', weekday: 5, positionKey: 'service', shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 2 }],
    });
    const facts = buildRecoDayFacts(input);
    expect(facts.map((f) => f.date)).toEqual(['2026-07-03']);
  });

  it('schliesst Tage nach lastCompletedDay aus', () => {
    const input = baseInput({
      lastCompletedDay: 12,
      cells: FRIDAYS.map((d) => cell('e1', d, { planH: 5, istH: 5 })),
      employees: [{ id: 'e1', position: 'service' }],
    });
    const facts = buildRecoDayFacts(input);
    expect(facts.map((f) => f.date)).toEqual(['2026-07-03', '2026-07-10']);
  });

  it('Besetzungs-Abdeckung: fehlende Plan-Zeiten ⇒ planned=null (nie geschätzt)', () => {
    const input = understaffedInput();
    delete input.shiftTimes['e1|2026-07-03'];
    const facts = buildRecoDayFacts(input);
    const day3 = facts.find((f) => f.date === '2026-07-03')!;
    expect(day3.coverage[0].planned).toBeNull();
    const day10 = facts.find((f) => f.date === '2026-07-10')!;
    expect(day10.coverage[0].planned).toBe(1);
  });

  it('Saison wird berücksichtigt: Requirements anderer Saison zählen nicht', () => {
    const input = understaffedInput();
    input.requirements = input.requirements.map((r) => ({ ...r, season: 'sommer' }));
    const facts = buildRecoDayFacts(input);
    expect(facts.every((f) => f.coverage.length === 0)).toBe(true);
  });

  it('SOLL ohne eingeplante Personen erzeugt Fakten (echte Unterbesetzung)', () => {
    const cells = FRIDAYS.map((d) => cell('e9', d, { planH: 8, istH: 8 })); // Küche aktiv
    const input = baseInput({
      cells,
      employees: [{ id: 'e9', position: 'kueche' }],
      requirements: [{ season: 'standard', weekday: 5, positionKey: 'service', shiftStart: '18:00', shiftEnd: '22:00', requiredCount: 2 }],
    });
    const facts = buildRecoDayFacts(input);
    const servFacts = facts.filter((f) => f.positionKey === 'service');
    expect(servFacts).toHaveLength(4);
    // Keine MA-Tage mit Stunden → Abdeckung bekannt (0 geplant), nicht null.
    expect(servFacts[0].coverage[0].planned).toBe(0);
  });
});

// ── Erkennungen ──────────────────────────────────────────────────────────────

describe('buildStaffingRecommendations — Erkennungen', () => {
  it('Unterbesetzung erkannt: zusätzliche Person empfohlen (kritisch, mit Zeitfenster)', () => {
    const res = buildStaffingRecommendations(understaffedInput());
    const rec = res.recommendations.find((r) => r.id === 'unterbesetzung|5|service|person-plus');
    expect(rec).toBeDefined();
    expect(rec!.tone).toBe('critical');
    expect(rec!.timeWindow).toEqual({ start: '18:00', end: '22:00' });
    expect(rec!.action).toContain('zusätzliche Person');
    expect(rec!.hitDayCount).toBe(4);
    expect(rec!.comparableDayCount).toBe(4);
    expect(rec!.comparableDays.filter((d) => d.hit)).toHaveLength(4);
  });

  it('Überbesetzung erkannt: eine Person weniger empfohlen (orange)', () => {
    const res = buildStaffingRecommendations(overstaffedInput());
    const rec = res.recommendations.find((r) => r.id === 'ueberbesetzung|5|service|person-minus');
    expect(rec).toBeDefined();
    expect(rec!.tone).toBe('warn');
    expect(rec!.action).toContain('weniger einplanen');
    // Erwartete Einsparung aus echten Zahlen (Stundensatz 40, 4 h/Person)
    expect(rec!.costImpactCHF).not.toBeNull();
    expect(rec!.costImpactCHF!).toBeCloseTo(160, 0);
  });

  it('Mehrstunden/ungeplante Einsätze ⇒ Unterbesetzungs-Empfehlung (Stunden)', () => {
    const cells: DrilldownFactCell[] = [];
    for (const d of FRIDAYS) {
      cells.push(cell('e1', d, { planH: 4, istH: 7, planCHF: 160, istCHF: 280 }));
      cells.push(cell('e2', d, { planH: 0, istH: 3, planCHF: 0, istCHF: 120 })); // ungeplant
    }
    const res = buildStaffingRecommendations(baseInput({
      cells,
      employees: [{ id: 'e1', position: 'service' }, { id: 'e2', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.id === 'unterbesetzung|5|service|stunden-plus');
    expect(rec).toBeDefined();
    expect(rec!.reasoning).toContain('ungeplante Einsätze');
    expect(rec!.costImpactCHF).toBeGreaterThan(0);
  });

  it('kürzere Schicht empfohlen, wenn Ist wiederholt deutlich unter Plan', () => {
    const cells = FRIDAYS.map((d) => cell('e1', d, { planH: 8, istH: 5, planCHF: 320, istCHF: 200 }));
    const res = buildStaffingRecommendations(baseInput({
      cells, employees: [{ id: 'e1', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.id === 'ueberbesetzung|5|service|stunden-minus');
    expect(rec).toBeDefined();
    expect(rec!.tone).toBe('good');
    expect(rec!.action).toContain('kürzen');
    expect(rec!.costImpactCHF).toBeCloseTo(120, 0);
  });

  it('spätere Startzeit empfohlen (Median-Verschiebung ≥ 30 Min., echte Zeiten)', () => {
    const cells: DrilldownFactCell[] = [];
    const shiftTimes: Record<string, DrilldownShiftTimes> = {};
    for (const d of FRIDAYS) {
      cells.push(cell('e1', d, { planH: 5, istH: 4.25, planCHF: 200, istCHF: 170 }));
      const [k, v] = slots('e1', d, {
        planSlots: [{ start: '17:00', end: '22:00' }],
        istSlots: [{ start: '17:45', end: '22:00' }],
      });
      shiftTimes[k] = v;
    }
    const res = buildStaffingRecommendations(baseInput({
      cells, shiftTimes, employees: [{ id: 'e1', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.id === 'schichtzeit|5|service|start-spaeter');
    expect(rec).toBeDefined();
    expect(rec!.action).toContain('45 Min.');
  });

  it('frühere Endzeit empfohlen, wenn Ist-Ende wiederholt vor Plan-Ende liegt', () => {
    const cells: DrilldownFactCell[] = [];
    const shiftTimes: Record<string, DrilldownShiftTimes> = {};
    for (const d of FRIDAYS) {
      cells.push(cell('e1', d, { planH: 5, istH: 4.25, planCHF: 200, istCHF: 170 }));
      const [k, v] = slots('e1', d, {
        planSlots: [{ start: '17:00', end: '23:00' }],
        istSlots: [{ start: '17:00', end: '22:15' }],
      });
      shiftTimes[k] = v;
    }
    const res = buildStaffingRecommendations(baseInput({
      cells, shiftTimes, employees: [{ id: 'e1', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.id === 'schichtzeit|5|service|ende-frueher');
    expect(rec).toBeDefined();
    expect(rec!.action).toContain('45 Min.');
  });

  it('keine Schichtzeit-Empfehlung ohne echte Ist-Zeiten', () => {
    const cells = FRIDAYS.map((d) => cell('e1', d, { planH: 5, istH: 5, planCHF: 200, istCHF: 200 }));
    const shiftTimes: Record<string, DrilldownShiftTimes> = {};
    for (const d of FRIDAYS) {
      const [k, v] = slots('e1', d, { planSlots: [{ start: '17:00', end: '22:00' }] });
      shiftTimes[k] = v;
    }
    const res = buildStaffingRecommendations(baseInput({
      cells, shiftTimes, employees: [{ id: 'e1', position: 'service' }],
    }));
    expect(res.recommendations.filter((r) => r.type === 'schichtzeit')).toHaveLength(0);
  });

  it('Kosten-Empfehlung bei wiederholten Mehrkosten ohne Stundenmuster', () => {
    // +1 h (unter hoursFlag-artiger Schwelle extraHoursH=2), aber +60 CHF
    const cells = FRIDAYS.map((d) => cell('e1', d, { planH: 5, istH: 6, planCHF: 200, istCHF: 260 }));
    const res = buildStaffingRecommendations(baseInput({
      cells, employees: [{ id: 'e1', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.type === 'kosten');
    expect(rec).toBeDefined();
    expect(rec!.costImpactCHF).toBeCloseTo(60, 0);
  });

  it('Datenqualität: fehlende Stempelungen ⇒ Info-Empfehlung', () => {
    const cells = FRIDAYS.map((d) => cell('e1', d, { planH: 5, istH: 0, planCHF: 200, istCHF: 0, missingStamp: true }));
    const res = buildStaffingRecommendations(baseInput({
      cells, employees: [{ id: 'e1', position: 'service' }],
    }));
    const rec = res.recommendations.find((r) => r.type === 'datenqualitaet');
    expect(rec).toBeDefined();
    expect(rec!.tone).toBe('info');
  });

  it('Datenqualität: SOLL vorhanden, aber Plan-Zeiten fehlen ⇒ Hinweis statt Besetzungsurteil', () => {
    const input = understaffedInput();
    input.shiftTimes = {}; // keine Zeiten
    const res = buildStaffingRecommendations(input);
    expect(res.recommendations.find((r) => r.id.includes('person-plus'))).toBeUndefined();
    const dq = res.recommendations.find((r) => r.id === 'datenqualitaet|5|service|planzeiten');
    expect(dq).toBeDefined();
  });
});

// ── Mindestdatenbasis & fehlende Quellen ─────────────────────────────────────

describe('Mindestdatenbasis & fehlende Daten', () => {
  it('unter 3 Vergleichstagen entsteht keine Empfehlung (Gruppe übersprungen)', () => {
    const input = understaffedInput();
    input.cells = input.cells.filter((c) => c.date <= '2026-07-10'); // nur 2 Freitage
    const res = buildStaffingRecommendations(input);
    expect(res.recommendations).toHaveLength(0);
    expect(res.skippedGroups).toBe(1);
    expect(res.evaluatedGroups).toBe(0);
  });

  it('fehlender Umsatz: Limitation ausgewiesen, keine erfundenen Werte', () => {
    const res = buildStaffingRecommendations(understaffedInput());
    const rec = res.recommendations[0];
    expect(res.revenueAvailable).toBe(false);
    expect(rec.limitations).toContain('Kein Tagesumsatz für diese Tage vorhanden.');
    expect(rec.simulationBase.avgRevenueCHF).toBeNull();
  });

  it('fehlende Reservationen: als nicht verfügbar gekennzeichnet', () => {
    const res = buildStaffingRecommendations(understaffedInput());
    expect(res.reservationsAvailable).toBe(false);
    expect(res.recommendations[0].limitations).toContain('Keine Reservationsdaten verfügbar.');
    expect(res.recommendations[0].comparableDays.every((d) => d.persons === null)).toBe(true);
  });

  it('leere Datenmenge: keine Empfehlungen, hasAnyData=false, kein Fehler', () => {
    const res = buildStaffingRecommendations(baseInput());
    expect(res.recommendations).toHaveLength(0);
    expect(res.hasAnyData).toBe(false);
  });

  it('hohe Reservationen fliessen als Kontext in die Begründung ein', () => {
    const input = understaffedInput();
    // Aktivität auch an Montagen, damit ein Monatsschnitt entsteht.
    input.cells.push(...MONDAYS.map((d) => cell('e1', d, { planH: 4, istH: 4, planCHF: 160, istCHF: 160 })));
    input.personsByDate = {
      '2026-07-03': 120, '2026-07-10': 130, '2026-07-17': 125, '2026-07-24': 135,
      '2026-07-06': 30, '2026-07-13': 25, '2026-07-20': 35,
    };
    const res = buildStaffingRecommendations(input);
    const rec = res.recommendations.find((r) => r.id.includes('person-plus'))!;
    expect(rec.reasoning).toContain('über dem Monatsschnitt');
  });
});

// ── Priorisierung, Filter, Limit ─────────────────────────────────────────────

function mkRec(over: Partial<StaffingRecommendation>): StaffingRecommendation {
  return {
    id: 'x', type: 'kosten', tone: 'warn', title: '', action: '', weekday: 5,
    weekdayLabel: 'Freitag', positionKey: 'service', positionLabel: 'Service',
    timeWindow: null, expectedChange: null, reasoning: '', dataBasis: 'gering',
    comparableDayCount: 3, hitDayCount: 2, recurrenceShare: 0.5, costImpactCHF: null,
    keyMetrics: [], comparableDays: [], limitations: [],
    simulationBase: {
      weekdayLabel: 'Freitag', positionLabel: 'Service', avgPlanHoursPerDay: 0,
      avgPlanHeadcount: null, avgHourlyCostCHF: null, avgRevenueCHF: null,
      requiredPersons: null, shiftStart: null, shiftEnd: null, avgHoursPerPerson: null,
    },
    ...over,
  };
}

describe('Priorisierung / Filter / Limit', () => {
  it('sortiert nach Dringlichkeit → Wiederholung → CHF → Datenbasis', () => {
    const recs = [
      mkRec({ id: 'a', tone: 'good', recurrenceShare: 1 }),
      mkRec({ id: 'b', tone: 'critical', recurrenceShare: 0.6 }),
      mkRec({ id: 'c', tone: 'warn', recurrenceShare: 0.8, costImpactCHF: 10 }),
      mkRec({ id: 'd', tone: 'warn', recurrenceShare: 0.8, costImpactCHF: 500 }),
      mkRec({ id: 'e', tone: 'warn', recurrenceShare: 0.9 }),
    ];
    expect(sortRecommendations(recs).map((r) => r.id)).toEqual(['b', 'e', 'd', 'c', 'a']);
  });

  it('stabile Sortierung: bei Gleichstand entscheidet die id', () => {
    const recs = [mkRec({ id: 'z' }), mkRec({ id: 'a' }), mkRec({ id: 'm' })];
    expect(sortRecommendations(recs).map((r) => r.id)).toEqual(['a', 'm', 'z']);
    // Referenz bleibt unverändert (keine Mutation)
    expect(recs.map((r) => r.id)).toEqual(['z', 'a', 'm']);
  });

  it('filterRecommendations filtert nach Typ, "alle" lässt alles durch', () => {
    const recs = [mkRec({ id: 'a', type: 'unterbesetzung' }), mkRec({ id: 'b', type: 'kosten' })];
    expect(filterRecommendations(recs, 'alle')).toHaveLength(2);
    expect(filterRecommendations(recs, 'unterbesetzung').map((r) => r.id)).toEqual(['a']);
  });

  it('Begrenzung: maximal 6 sichtbar, showAll zeigt alle', () => {
    const recs = Array.from({ length: 9 }, (_, i) => mkRec({ id: `r${i}` }));
    expect(visibleRecommendations(recs, false)).toHaveLength(MAX_VISIBLE_RECOMMENDATIONS);
    expect(visibleRecommendations(recs, true)).toHaveLength(9);
  });
});

// ── Simulation ───────────────────────────────────────────────────────────────

const SIM_BASE: SimulationBase = {
  weekdayLabel: 'Freitag', positionLabel: 'Service',
  avgPlanHoursPerDay: 10, avgPlanHeadcount: 2, avgHourlyCostCHF: 40,
  avgRevenueCHF: 5000, requiredPersons: 2,
  shiftStart: '18:00', shiftEnd: '22:00', avgHoursPerPerson: 5,
};

describe('applySimulation', () => {
  it('Reset (Default-Anpassungen) reproduziert die Basis', () => {
    const r = applySimulation(SIM_BASE, DEFAULT_SIMULATION_ADJUSTMENTS);
    expect(r.newPlanHours).toBe(10);
    expect(r.newCostCHF).toBeCloseTo(400);
    expect(r.newPkqPct).toBeCloseTo(8);
    expect(r.deltaHours).toBe(0);
    expect(r.deltaCostCHF).toBeCloseTo(0);
    expect(r.staffingDiff).toBe(0);
  });

  it('plus 1 Person: Stunden/Kosten/Quote/Besetzung steigen nachvollziehbar', () => {
    const r = applySimulation(SIM_BASE, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaPeople: 1 });
    expect(r.newPlanHours).toBe(15);
    expect(r.newCostCHF).toBeCloseTo(600);
    expect(r.newPkqPct).toBeCloseTo(12);
    expect(r.newHeadcount).toBe(3);
    expect(r.staffingDiff).toBe(1);
    expect(r.deltaCostCHF).toBeCloseTo(200);
  });

  it('minus 1 Person: Besetzung sinkt unter Soll (Diff −1)', () => {
    const r = applySimulation(SIM_BASE, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaPeople: -1 });
    expect(r.newPlanHours).toBe(5);
    expect(r.newHeadcount).toBe(1);
    expect(r.staffingDiff).toBe(-1);
    expect(r.deltaCostCHF).toBeCloseTo(-200);
  });

  it('Stundenänderung wirkt direkt (+2 h)', () => {
    const r = applySimulation(SIM_BASE, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaHours: 2 });
    expect(r.newPlanHours).toBe(12);
    expect(r.deltaHours).toBe(2);
  });

  it('spätere Startzeit reduziert Stunden über die Schichtdauer × Soll-Personen', () => {
    const r = applySimulation(SIM_BASE, { ...DEFAULT_SIMULATION_ADJUSTMENTS, startTime: '19:00' });
    // Dauer 4h → 3h, −1h × 2 Personen = −2h
    expect(r.newPlanHours).toBe(8);
  });

  it('ohne Umsatz keine Quote (null) + Hinweis — nie 0 erfinden', () => {
    const r = applySimulation({ ...SIM_BASE, avgRevenueCHF: null }, DEFAULT_SIMULATION_ADJUSTMENTS);
    expect(r.newPkqPct).toBeNull();
    expect(r.basePkqPct).toBeNull();
    expect(r.issues.some((i) => i.includes('Personalkostenquote'))).toBe(true);
  });

  it('ohne Stundensatz keine Kosten (null) + Hinweis', () => {
    const r = applySimulation({ ...SIM_BASE, avgHourlyCostCHF: null }, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaPeople: 1 });
    expect(r.newCostCHF).toBeNull();
    expect(r.deltaCostCHF).toBeNull();
    expect(r.issues.some((i) => i.includes('Stundensatz'))).toBe(true);
  });

  it('keine Division durch 0: Umsatz 0 ⇒ Quote null statt Infinity', () => {
    const r = applySimulation({ ...SIM_BASE, avgRevenueCHF: 0 }, DEFAULT_SIMULATION_ADJUSTMENTS);
    expect(r.newPkqPct).toBeNull();
  });

  it('negative Stunden werden auf 0 begrenzt und ausgewiesen — keine NaN/Infinity', () => {
    const r = applySimulation(SIM_BASE, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaHours: -50 });
    expect(r.newPlanHours).toBe(0);
    expect(r.issues.some((i) => i.includes('negative'))).toBe(true);
    for (const v of [r.newPlanHours, r.deltaHours, r.newCostCHF ?? 0, r.newPkqPct ?? 0]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('Personen-Änderung ohne Stunden-pro-Person-Basis wirkt nicht still (Hinweis)', () => {
    const base = { ...SIM_BASE, avgHoursPerPerson: null, shiftStart: null, shiftEnd: null };
    const r = applySimulation(base, { ...DEFAULT_SIMULATION_ADJUSTMENTS, deltaPeople: 1 });
    expect(r.newPlanHours).toBe(10); // unverändert
    expect(r.issues.some((i) => i.includes('Stunden pro Person'))).toBe(true);
  });
});
