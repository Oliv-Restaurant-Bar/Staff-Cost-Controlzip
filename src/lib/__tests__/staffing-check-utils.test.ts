// @vitest-environment node
/**
 * Tests der reinen Dienstplan-Prüf-Logik (ArG-Pausenstaffel, Netto-Stunden,
 * CdS-Regel, 3-Dimensionen-Tagesprüfung mit Ampel).
 */
import { describe, it, expect } from 'vitest';
import {
  argBreakMinutes,
  nettoSegmentMinutes,
  nettoMinutesForSlots,
  computeCdsCheck,
  computeDayCheck,
  worstAmpel,
  type PlannedEmployeeDayEx,
} from '@/lib/staffing-check-utils';
import type { StaffingRequirement } from '@/types/staffing';

function req(partial: Partial<StaffingRequirement>): StaffingRequirement {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    restaurantId: 'oliv',
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
  };
}

function emp(partial: Partial<PlannedEmployeeDayEx>): PlannedEmployeeDayEx {
  return {
    id: partial.id ?? 'e1',
    department: 'service',
    positionKey: 'service',
    trainedKeys: ['service'],
    slots: [{ start: '11:00', end: '14:00' }],
    ...partial,
  };
}

describe('argBreakMinutes (Staffel 15/30/60 ab 5.5/7/9 h)', () => {
  it('unter 5.5 h keine Pause', () => {
    expect(argBreakMinutes(0)).toBe(0);
    expect(argBreakMinutes(5 * 60)).toBe(0);
    expect(argBreakMinutes(5.5 * 60 - 1)).toBe(0);
  });
  it('Grenzwerte exakt: 5.5 h → 15, 7 h → 30, 9 h → 60', () => {
    expect(argBreakMinutes(330)).toBe(15);
    expect(argBreakMinutes(419)).toBe(15);
    expect(argBreakMinutes(420)).toBe(30);
    expect(argBreakMinutes(539)).toBe(30);
    expect(argBreakMinutes(540)).toBe(60);
    expect(argBreakMinutes(720)).toBe(60);
  });
});

describe('Netto-Stunden', () => {
  it('durchgehende Schicht: brutto − Staffelpause', () => {
    // 10:00–20:00 = 10 h brutto → 60 min Pause → 9 h netto
    expect(nettoSegmentMinutes('10:00', '20:00')).toBe(540);
    // 11:00–14:00 = 3 h → keine Pause
    expect(nettoSegmentMinutes('11:00', '14:00')).toBe(180);
  });
  it('ungültige/inverse Zeiten → 0', () => {
    expect(nettoSegmentMinutes('14:00', '11:00')).toBe(0);
    expect(nettoSegmentMinutes('xx', '11:00')).toBe(0);
  });
  it('Splitschicht = Summe der Segmente (Staffel je Segment)', () => {
    // 10:00–14:00 (4h, keine Pause) + 17:00–23:00 (6h → 15 min)
    expect(nettoMinutesForSlots([
      { start: '10:00', end: '14:00' },
      { start: '17:00', end: '23:00' },
    ])).toBe(240 + 360 - 15);
  });
});

describe('computeCdsCheck (Artin > Mendim > Ibrahim)', () => {
  const prio = ['artin', 'mendim', 'ibrahim'];
  it('Artin geplant → Artin CdS, Mendim (falls geplant) Gastgeber/GF', () => {
    const r = computeCdsCheck(['artin', 'mendim', 'x'], prio);
    expect(r.activeCdsId).toBe('artin');
    expect(r.gastgeberId).toBe('mendim');
    expect(r.ok).toBe(true);
  });
  it('Artin geplant, Mendim nicht → kein Gastgeber', () => {
    const r = computeCdsCheck(['artin', 'ibrahim'], prio);
    expect(r.activeCdsId).toBe('artin');
    expect(r.gastgeberId).toBeNull();
  });
  it('kein Artin → Mendim CdS (kein Gastgeber)', () => {
    const r = computeCdsCheck(['mendim', 'ibrahim'], prio);
    expect(r.activeCdsId).toBe('mendim');
    expect(r.gastgeberId).toBeNull();
  });
  it('nur Ibrahim → Ibrahim CdS', () => {
    expect(computeCdsCheck(['ibrahim'], prio).activeCdsId).toBe('ibrahim');
  });
  it('niemand aus der Liste geplant → Warnung', () => {
    const r = computeCdsCheck(['x', 'y'], prio);
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/Kein Chef de Service/);
  });
  it('leere Prioritätsliste → keine Regel, keine Warnung', () => {
    const r = computeCdsCheck(['x'], []);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeNull();
  });
});

describe('computeDayCheck (3 Dimensionen + Ampel)', () => {
  it('exakt erfüllt → alles grün', () => {
    const result = computeDayCheck({
      requirements: [req({ requiredCount: 1 })],
      plannedEmployees: [emp({})],
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(result.hasRequirements).toBe(true);
    expect(result.hours.ampel).toBe('gruen');
    expect(result.counts.ampel).toBe('gruen');
    expect(result.coverage.ampel).toBe('gruen');
    expect(result.overall).toBe('gruen');
  });

  it('±1 Person → gelb (Anzahl), Stunden-Abweichung > 1 h → rot', () => {
    const result = computeDayCheck({
      requirements: [req({ requiredCount: 2 })], // Soll 2×3h = 6h
      plannedEmployees: [emp({})],               // Ist 1×3h
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(result.counts.rows[0].ampel).toBe('gelb'); // −1 Person
    expect(result.hours.rows[0].ampel).toBe('rot');   // −3 h
    expect(result.coverage.rows[0].covered).toBe(true);
    expect(result.overall).toBe('rot');
  });

  it('Station unbesetzt → Abdeckung rot; Zweitposition deckt ab → gelb', () => {
    const uncovered = computeDayCheck({
      requirements: [req({ positionKey: 'sushi' })],
      plannedEmployees: [emp({ positionKey: 'service', trainedKeys: ['service'] })],
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(uncovered.coverage.rows[0].covered).toBe(false);
    expect(uncovered.coverage.ampel).toBe('rot');

    const secondary = computeDayCheck({
      requirements: [req({ positionKey: 'sushi' })],
      plannedEmployees: [emp({ positionKey: 'service', trainedKeys: ['service', 'sushi'] })],
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(secondary.coverage.rows[0].covered).toBe(true);
    expect(secondary.coverage.rows[0].coveredOnlyBySecondary).toBe(true);
    expect(secondary.coverage.ampel).toBe('gelb');
  });

  it('CdS fehlt → Abdeckung gelb + Warnung', () => {
    const result = computeDayCheck({
      requirements: [req({})],
      plannedEmployees: [emp({ id: 'x' })],
      season: 'standard',
      weekday: 1,
      cdsPriority: ['artin'],
    });
    expect(result.coverage.cds.ok).toBe(false);
    expect(result.coverage.ampel).toBe('gelb');
  });

  it('Zeitüberschneidung zählt, disjunkte Slots nicht', () => {
    const result = computeDayCheck({
      requirements: [req({ shiftStart: '17:00', shiftEnd: '22:00' })],
      plannedEmployees: [emp({ slots: [{ start: '10:00', end: '14:00' }] })],
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(result.counts.rows[0].ist).toBe(0);
    expect(result.coverage.rows[0].covered).toBe(false);
  });

  it('kein Bedarf definiert → hasRequirements=false, neutral grün', () => {
    const result = computeDayCheck({
      requirements: [],
      plannedEmployees: [emp({})],
      season: 'standard',
      weekday: 1,
      cdsPriority: [],
    });
    expect(result.hasRequirements).toBe(false);
    expect(result.overall).toBe('gruen');
  });
});

describe('worstAmpel', () => {
  it('rot > gelb > grün', () => {
    expect(worstAmpel(['gruen', 'gelb', 'rot'])).toBe('rot');
    expect(worstAmpel(['gruen', 'gelb'])).toBe('gelb');
    expect(worstAmpel(['gruen'])).toBe('gruen');
    expect(worstAmpel([])).toBe('gruen');
  });
});
