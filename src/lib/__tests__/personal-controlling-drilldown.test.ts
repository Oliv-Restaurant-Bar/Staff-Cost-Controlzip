// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  buildFactCells,
  buildDrilldownRows,
  buildRowExplanation,
  buildMainCauseSentence,
  buildDrilldownCsv,
  summarizeDrilldownCells,
  toneForDrilldownRow,
  positionKeyForEmployee,
  isoWeekOf,
  dayLabel,
  weekLabel,
  daysInMonth,
  DRILLDOWN_THRESHOLDS,
  DRILLDOWN_CAUSE_LABEL,
  type DrilldownInput,
} from '../personal-controlling-drilldown';

// ── Fixture ──────────────────────────────────────────────────────────────────
// Juni 2026: 30 Tage. 2 variable MA (anna Service-Position, ben Küche ohne
// Position) + 1 Fixlohn-MA (carl) mit Zusatzkosten-Tagen.

function makeInput(overrides: Partial<DrilldownInput> = {}): DrilldownInput {
  return {
    year: 2026,
    month: 6,
    cutoffDay: null,
    lastCompletedDay: 30,
    employees: [
      { id: 'anna', name: 'Anna', department: 'service', position: 'service-front', isFixed: false },
      { id: 'ben',  name: 'Ben',  department: 'küche',   position: null,            isFixed: false },
      { id: 'carl', name: 'Carl', department: 'service', position: 'bar',           isFixed: true },
    ],
    planDays: [
      { empId: 'anna', date: '2026-06-01', hours: 8, cost: 200 },
      { empId: 'anna', date: '2026-06-02', hours: 8, cost: 200 },
      { empId: 'ben',  date: '2026-06-01', hours: 6, cost: 120 },
      { empId: 'ben',  date: '2026-06-03', hours: 6, cost: 120 },
    ],
    istDays: [
      { empId: 'anna', date: '2026-06-01', hours: 10, cost: 250 }, // +2h über Plan
      { empId: 'anna', date: '2026-06-02', hours: 8,  cost: 200 }, // im Plan
      { empId: 'ben',  date: '2026-06-01', hours: 6,  cost: 120 }, // im Plan
      // ben 2026-06-03: KEIN Ist, keine Absenz → fehlende Stempelung
      { empId: 'ben',  date: '2026-06-04', hours: 5,  cost: 100 }, // ungeplant
    ],
    zusatzPlanDays: [
      { empId: 'carl', date: '2026-06-05', hours: 4, cost: 100 },
    ],
    zusatzIstDays: [
      { empId: 'carl', date: '2026-06-05', hours: 6, cost: 150 },
    ],
    absences: [
      { empId: 'anna', date: '2026-06-10', type: 'FE' },
      { empId: 'ben',  date: '2026-06-11', type: 'KR' },
    ],
    overtimeDayKeys: ['anna|2026-06-01'],
    vacationCodes: ['FE'],
    sickCodes: ['KR'],
    accidentCodes: ['UN'],
    dailyRevenue: {
      '2026-06-01': 5000,
      '2026-06-02': 4000,
      '2026-06-03': 1000, // < 75% vom Schnitt → umsatz_tief
      '2026-06-04': 4000,
      '2026-06-05': 4000,
    },
    fixMonthCHF: 3000,
    ...overrides,
  };
}

describe('buildFactCells', () => {
  it('merges plan/ist/zusatz/absence into per-emp-per-day cells', () => {
    const input = makeInput();
    const cells = buildFactCells(input);
    const anna1 = cells.find(c => c.empId === 'anna' && c.date === '2026-06-01')!;
    expect(anna1.planH).toBe(8);
    expect(anna1.istH).toBe(10);
    expect(anna1.planCHF).toBe(200);
    expect(anna1.istCHF).toBe(250);
    expect(anna1.overtime).toBe(true);
    expect(anna1.zusatz).toBe(false);

    const carl5 = cells.find(c => c.empId === 'carl' && c.date === '2026-06-05')!;
    expect(carl5.zusatz).toBe(true);
    expect(carl5.planH).toBe(4);
    expect(carl5.istH).toBe(6);

    const annaFe = cells.find(c => c.empId === 'anna' && c.date === '2026-06-10')!;
    expect(annaFe.absence).toBe('FE');
  });

  it('flags missing stamps only for past days (≤ lastCompletedDay), not absences', () => {
    const cells = buildFactCells(makeInput());
    const ben3 = cells.find(c => c.empId === 'ben' && c.date === '2026-06-03')!;
    expect(ben3.missingStamp).toBe(true);
    const benKr = cells.find(c => c.empId === 'ben' && c.date === '2026-06-11')!;
    expect(benKr.missingStamp).toBe(false); // Absenz erklärt den Tag

    // Gleicher Plan, aber Monat "läuft" erst bis zum 2. → Tag 3 nicht mehr geflaggt
    const cellsRunning = buildFactCells(makeInput({ lastCompletedDay: 2 }));
    const ben3b = cellsRunning.find(c => c.empId === 'ben' && c.date === '2026-06-03')!;
    expect(ben3b.missingStamp).toBe(false);
  });

  it('respects cutoffDay (pro-rata): days after cutoff are dropped entirely', () => {
    const cells = buildFactCells(makeInput({ cutoffDay: 3 }));
    expect(cells.some(c => c.date === '2026-06-04')).toBe(false);
    expect(cells.some(c => c.date === '2026-06-05')).toBe(false);
    expect(cells.some(c => c.date === '2026-06-03')).toBe(true);
  });

  it('parity: cell sums equal the sum of the raw loader inputs (no invented values)', () => {
    const input = makeInput();
    const cells = buildFactCells(input);
    const sumIst = cells.reduce((s, c) => s + c.istCHF, 0);
    const expected = [...input.istDays, ...input.zusatzIstDays].reduce((s, d) => s + d.cost, 0);
    expect(sumIst).toBeCloseTo(expected, 6);
    const sumPlan = cells.reduce((s, c) => s + c.planCHF, 0);
    const expectedPlan = [...input.planDays, ...input.zusatzPlanDays].reduce((s, d) => s + d.cost, 0);
    expect(sumPlan).toBeCloseTo(expectedPlan, 6);
  });
});

describe('buildDrilldownRows — day grouping', () => {
  const input = makeInput();
  const cells = buildFactCells(input);
  const rows = buildDrilldownRows(input, cells, { group: 'day', period: 'day' });

  it('one row per date, sorted, with revenue + approximated Personalquote', () => {
    const d1 = rows.find(r => r.key === '2026-06-01')!;
    expect(d1.label).toBe('Mo 01.06.');
    expect(d1.planH).toBe(14); // anna 8 + ben 6
    expect(d1.istH).toBe(16);
    expect(d1.revenue).toBe(5000);
    // pkq = (istCHF 370 + fix 3000/30) / 5000 = (370+100)/5000 = 9.4 %
    expect(d1.pkqPct).toBeCloseTo(9.4, 5);
  });

  it('collects causes per day (ueberstunden, fehlende_stempelung, ungeplant, umsatz_tief)', () => {
    const d1 = rows.find(r => r.key === '2026-06-01')!;
    expect(d1.causes.map(c => c.cause)).toContain('ueberstunden');

    const d3 = rows.find(r => r.key === '2026-06-03')!;
    const d3causes = d3.causes.map(c => c.cause);
    expect(d3causes).toContain('fehlende_stempelung');
    expect(d3causes).toContain('umsatz_tief'); // 1000 < 0.75 × Schnitt (3600)

    const d4 = rows.find(r => r.key === '2026-06-04')!;
    expect(d4.causes.map(c => c.cause)).toContain('ungeplant');

    const d5 = rows.find(r => r.key === '2026-06-05')!;
    expect(d5.causes.map(c => c.cause)).toContain('zusatzkosten');
  });

  it('absence-only days carry ferien/krankheit causes', () => {
    const d10 = rows.find(r => r.key === '2026-06-10')!;
    expect(d10.causes.map(c => c.cause)).toContain('ferien');
    const d11 = rows.find(r => r.key === '2026-06-11')!;
    expect(d11.causes.map(c => c.cause)).toContain('krankheit');
  });
});

describe('buildDrilldownRows — week/month/employee/position grouping', () => {
  const input = makeInput();
  const cells = buildFactCells(input);

  it('week rows use ISO weeks clipped to month with KW label', () => {
    const rows = buildDrilldownRows(input, cells, { group: 'day', period: 'week' });
    // 2026-06-01 ist ein Montag, ISO-KW 23
    expect(isoWeekOf('2026-06-01')).toBe(23);
    const w23 = rows.find(r => r.key === 'w23')!;
    expect(w23.label).toBe('KW 23 (01.–05.06.)');
    expect(w23.planH).toBe(32); // 8+8+6+6+4
  });

  it('month period yields a single aggregated row', () => {
    const rows = buildDrilldownRows(input, cells, { group: 'day', period: 'month' });
    expect(rows).toHaveLength(1);
    expect(rows[0].planH).toBe(32);
    expect(rows[0].istH).toBe(35); // 10+8+6+5+6
  });

  it('employee grouping sorts by |diffCHF| desc and adds position sublabel', () => {
    const rows = buildDrilldownRows(input, cells, { group: 'employee', period: 'day' });
    // anna +50, carl +50, ben −20 → grösste |Abweichung| zuerst, ben zuletzt
    expect(Math.abs(rows[0].diffCHF)).toBe(50);
    expect(rows[2].key).toBe('emp:ben');
    const anna = rows.find(r => r.key === 'emp:anna')!;
    expect(anna.sublabel).toBe('Service Front');
    expect(anna.revenue).toBeNull();
    expect(anna.pkqPct).toBeNull();
  });

  it('position grouping uses primaryStation slug with department fallback', () => {
    const rows = buildDrilldownRows(input, cells, { group: 'position', period: 'day' });
    const keys = rows.map(r => r.key);
    expect(keys).toContain('pos:service-front');
    expect(keys).toContain('pos:bar');
    expect(keys).toContain('dept:Küche');
    const kueche = rows.find(r => r.key === 'dept:Küche')!;
    expect(kueche.label).toBe('Küche (ohne Position)');
  });
});

describe('tones', () => {
  it('under or on plan is good', () => {
    expect(toneForDrilldownRow(500, 0)).toBe('good');
    expect(toneForDrilldownRow(500, -300)).toBe('good');
  });
  it('warn/critical by CHF thresholds', () => {
    expect(toneForDrilldownRow(1000, DRILLDOWN_THRESHOLDS.warnCHF)).toBe('warn');
    expect(toneForDrilldownRow(10000, DRILLDOWN_THRESHOLDS.critCHF)).toBe('critical');
  });
  it('warn/critical by relative thresholds with CHF floor', () => {
    // 20% über Plan bei 300 Plan = 60 CHF ≥ warnCHF-Floor → critical (≥15% & ≥50)
    expect(toneForDrilldownRow(300, 60)).toBe('critical');
    // 10% über Plan bei 300 = 30 CHF → warn (≥5% & ≥20)
    expect(toneForDrilldownRow(300, 30)).toBe('warn');
    // 10% über Plan bei 100 = 10 CHF < minCHFForPct → good (Kleinstbetrag)
    expect(toneForDrilldownRow(100, 10)).toBe('good');
  });
  it('unplanned work with zero plan is not green', () => {
    expect(toneForDrilldownRow(0, 60)).toBe('critical'); // 100% over
  });
});

describe('explanations & main-cause sentence', () => {
  it('row explanation includes hours, CHF and top causes', () => {
    const text = buildRowExplanation(18, 450, [
      { cause: 'ueberstunden', count: 3 },
      { cause: 'ferien', count: 1 },
      { cause: 'mehr_stunden', count: 1 },
    ]);
    expect(text).toContain('+18.0 h gegenüber Soll');
    expect(text).toContain('über Plan');
    expect(text).toContain('Überstunden');
    expect(text).toContain('Ferien');
    expect(text).not.toContain('Mehr Stunden'); // Stunden-Flags nicht doppelt erzählen
  });
  it('on-plan rows say "Im Plan."', () => {
    expect(buildRowExplanation(0, 0, [])).toBe('Im Plan.');
  });
  it('main cause sentence picks top-2 over-plan rows', () => {
    const input = makeInput();
    const rows = buildDrilldownRows(input, buildFactCells(input), { group: 'day', period: 'day' });
    const sentence = buildMainCauseSentence(rows);
    expect(sentence).toMatch(/^Hauptsächlich verursacht durch .+ und .+\.$/);
    expect(sentence).toContain('Mo 01.06.'); // +50 CHF Tag
  });
  it('returns null when nothing is over plan', () => {
    expect(buildMainCauseSentence([])).toBeNull();
  });
});

describe('summarize & CSV', () => {
  const input = makeInput();
  const cells = buildFactCells(input);

  it('totals match raw sums and revenue scope', () => {
    const t = summarizeDrilldownCells(cells, input);
    expect(t.planCHF).toBe(740);  // 200+200+120+120+100
    expect(t.istCHF).toBe(820);   // 250+200+120+100+150
    expect(t.diffCHF).toBe(80);
    expect(t.revenue).toBe(18000);
  });

  it('CSV has header, semicolons, quoted fields with cause labels', () => {
    const rows = buildDrilldownRows(input, cells, { group: 'day', period: 'day' });
    const csv = buildDrilldownCsv(rows, 'Tag');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Tag;Plan h;Ist h;Diff h;Plan CHF;Ist CHF;Diff CHF;Umsatz CHF;Personalquote %;Ursachen;Erklärung');
    expect(lines.length).toBe(rows.length + 1);
    expect(csv).toContain(DRILLDOWN_CAUSE_LABEL.ueberstunden);
    // Erklärungen enthalten Semikolons nie unmaskiert: Felder mit ; oder " sind gequotet
    for (const line of lines.slice(1)) {
      // grobe Struktur-Prüfung: mind. 10 Semikolons ausserhalb von Quotes
      const outside = line.replace(/"[^"]*"/g, '');
      expect(outside.split(';').length).toBeGreaterThanOrEqual(11);
    }
  });
});

describe('date helpers', () => {
  it('daysInMonth / dayLabel / weekLabel', () => {
    expect(daysInMonth(2026, 6)).toBe(30);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(dayLabel('2026-06-01')).toBe('Mo 01.06.');
    expect(weekLabel(2026, 6, 23, ['2026-06-03', '2026-06-01'])).toBe('KW 23 (01.–03.06.)');
  });
  it('isoWeekOf handles year boundaries', () => {
    expect(isoWeekOf('2026-01-01')).toBe(1);  // Do → KW 1
    expect(isoWeekOf('2027-01-01')).toBe(53); // Fr → KW 53 von 2026
    expect(isoWeekOf('2026-12-31')).toBe(53);
  });
});

describe('positionKeyForEmployee', () => {
  it('prettifies slugs and falls back to department', () => {
    expect(positionKeyForEmployee({ id: 'x', name: 'X', department: 'service', position: 'chef-de-rang', isFixed: false }))
      .toEqual({ key: 'pos:chef-de-rang', label: 'Chef De Rang' });
    expect(positionKeyForEmployee({ id: 'x', name: 'X', department: 'kueche', position: null, isFixed: false }).label)
      .toBe('Küche (ohne Position)');
  });
});
