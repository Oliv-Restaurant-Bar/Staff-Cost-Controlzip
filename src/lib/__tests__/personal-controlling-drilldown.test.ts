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
  filterCellsForSelection,
  buildDetailShiftRows,
  buildDetailKpis,
  buildDetailContext,
  reconcileDetail,
  sortShiftRows,
  buildShiftCsv,
  detailTitleForSelection,
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

// ── Detailstufe (2. Drilldown-Ebene) ─────────────────────────────────────────

describe('filterCellsForSelection', () => {
  const input = makeInput();
  const cells = buildFactCells(input);

  it('day/day filters to the exact date', () => {
    const f = filterCellsForSelection(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    expect(f.every(c => c.date === '2026-06-01')).toBe(true);
    expect(f.map(c => c.empId).sort()).toEqual(['anna', 'ben']);
  });

  it('day/week filters to the ISO week bucket', () => {
    const f = filterCellsForSelection(input, cells, { group: 'day', period: 'week', key: 'w23' });
    // KW 23 = 01.–07.06. → alle Zellen bis inkl. 05.06.
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(c => isoWeekOf(c.date) === 23)).toBe(true);
  });

  it('day/month returns all cells', () => {
    const f = filterCellsForSelection(input, cells, { group: 'day', period: 'month', key: 'month' });
    expect(f.length).toBe(cells.length);
  });

  it('employee selection filters by empId (emp:-prefix)', () => {
    const f = filterCellsForSelection(input, cells, { group: 'employee', period: 'day', key: 'emp:anna' });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every(c => c.empId === 'anna')).toBe(true);
  });

  it('position selection matches slug key and department fallback', () => {
    const pos = filterCellsForSelection(input, cells, { group: 'position', period: 'day', key: 'pos:service-front' });
    expect(pos.every(c => c.empId === 'anna')).toBe(true);
    const dept = filterCellsForSelection(input, cells, { group: 'position', period: 'day', key: 'dept:Küche' });
    expect(dept.every(c => c.empId === 'ben')).toBe(true);
  });
});

const SHIFT_TIMES_FIXTURE = {
  'anna|2026-06-01': {
    planSlots: [{ start: '11:00', end: '14:00' }, { start: '18:00', end: '23:00' }],
    istSlots:  [{ start: '11:00', end: '15:00' }, { start: '18:00', end: '24:00' }],
    planBreakH: 0.5,
  },
  'ben|2026-06-01': {
    planSlots: [{ start: '10:00', end: '16:00' }],
    istSlots:  [{ start: '10:00', end: '16:00' }],
    planBreakH: 0,
  },
};

describe('buildDetailShiftRows', () => {
  const input = makeInput({ shiftTimes: SHIFT_TIMES_FIXTURE });
  const cells = buildFactCells(input);

  it('formats plan/ist times, keeps pause, never invents missing times', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const anna = rows.find(r => r.empId === 'anna')!;
    expect(anna.planTimes).toBe('11:00–14:00 · 18:00–23:00');
    expect(anna.istTimes).toBe('11:00–15:00 · 18:00–24:00');
    expect(anna.pauseH).toBe(0.5);
    // Tag ohne shiftTimes-Eintrag → null (UI zeigt "—"), NIE geschätzt
    const rows4 = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-04' });
    expect(rows4[0].planTimes).toBeNull();
    expect(rows4[0].istTimes).toBeNull();
    expect(rows4[0].pauseH).toBeNull();
  });

  it('reuses SSOT causes per shift (fehlende_stempelung, ungeplant, ueberstunden)', () => {
    const missing = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-03' });
    expect(missing[0].causes.map(c => c.cause)).toContain('fehlende_stempelung');
    const unplanned = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-04' });
    expect(unplanned[0].causes.map(c => c.cause)).toContain('ungeplant');
    const ot = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    expect(ot.find(r => r.empId === 'anna')!.causes.map(c => c.cause)).toContain('ueberstunden');
  });

  it('flags zeiten_abweichend only when both time sets exist and differ', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    expect(rows.find(r => r.empId === 'anna')!.flags).toContain('zeiten_abweichend');
    expect(rows.find(r => r.empId === 'ben')!.flags).not.toContain('zeiten_abweichend');
  });

  it('flags kosten_ohne_stunden and stunden_ohne_kosten via thresholds', () => {
    const inp = makeInput({
      planDays: [
        { empId: 'anna', date: '2026-06-01', hours: 8, cost: 200 },
        { empId: 'ben',  date: '2026-06-02', hours: 8, cost: 200 },
      ],
      istDays: [
        // gleiche Stunden, +80 CHF → kosten_ohne_stunden
        { empId: 'anna', date: '2026-06-01', hours: 8, cost: 280 },
        // +3 h, aber nur +30 CHF (< warnCHF) → stunden_ohne_kosten
        { empId: 'ben',  date: '2026-06-02', hours: 11, cost: 230 },
      ],
      zusatzPlanDays: [], zusatzIstDays: [], absences: [], overtimeDayKeys: [],
    });
    const c = buildFactCells(inp);
    const r1 = buildDetailShiftRows(inp, c, { group: 'day', period: 'day', key: '2026-06-01' });
    expect(r1[0].flags).toContain('kosten_ohne_stunden');
    const r2 = buildDetailShiftRows(inp, c, { group: 'day', period: 'day', key: '2026-06-02' });
    expect(r2[0].flags).toContain('stunden_ohne_kosten');
  });

  it('status text: erste Ursache, sonst erste Auffälligkeit, sonst "Im Plan"', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const ben = rows.find(r => r.empId === 'ben')!;
    expect(ben.status).toBe('Im Plan');
    const missing = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-03' });
    expect(missing[0].status).toBe(DRILLDOWN_CAUSE_LABEL.fehlende_stempelung);
  });

  it('default sort: date, then name (stable)', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'employee', period: 'day', key: 'emp:anna' });
    const dates = rows.map(r => r.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('buildDetailKpis / buildDetailContext', () => {
  const input = makeInput({ shiftTimes: SHIFT_TIMES_FIXTURE });
  const cells = buildFactCells(input);
  const sel = { group: 'day' as const, period: 'day' as const, key: '2026-06-01' };
  const rows = buildDetailShiftRows(input, cells, sel);

  it('KPIs sum the shift rows (parity with cells)', () => {
    const k = buildDetailKpis(rows);
    expect(k.planH).toBe(14);
    expect(k.istH).toBe(16);
    expect(k.diffH).toBe(2);
    expect(k.planCHF).toBe(320);
    expect(k.istCHF).toBe(370);
    expect(k.diffCHF).toBe(50);
    expect(k.shiftCount).toBe(2);
    expect(k.issueCount).toBe(1); // nur anna (ueberstunden + zeiten_abweichend)
  });

  it('context: revenue only from recorded days, staffing counts from cells', () => {
    const ctx = buildDetailContext(input, filterCellsForSelection(input, cells, sel));
    expect(ctx.revenue).toBe(5000);
    expect(ctx.plannedStaff).toBe(2);
    expect(ctx.actualStaff).toBe(2);
    expect(ctx.dates).toEqual(['2026-06-01']);
  });

  it('context revenue is null (not 0) when no revenue recorded', () => {
    const inp = makeInput({ dailyRevenue: {} });
    const c = buildFactCells(inp);
    const ctx = buildDetailContext(inp, filterCellsForSelection(inp, c, sel));
    expect(ctx.revenue).toBeNull();
  });
});

describe('reconcileDetail', () => {
  const input = makeInput({ shiftTimes: SHIFT_TIMES_FIXTURE });
  const cells = buildFactCells(input);

  it('detail sums match the clicked parent row (ok=true)', () => {
    const parent = buildDrilldownRows(input, cells, { group: 'day', period: 'day' })
      .find(r => r.key === '2026-06-01')!;
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const rec = reconcileDetail(rows, parent);
    expect(rec.ok).toBe(true);
    expect(rec.sumIstH).toBe(parent.istH);
    expect(rec.sumDiffCHF).toBeCloseTo(parent.diffCHF, 2);
  });

  it('mismatch beyond tolerance is flagged, never silent', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const rec = reconcileDetail(rows, { planH: 14, istH: 16, diffCHF: 999 });
    expect(rec.ok).toBe(false);
    expect(rec.diffCHF).toBeCloseTo(50 - 999, 2);
  });
});

describe('sortShiftRows', () => {
  const input = makeInput({ shiftTimes: SHIFT_TIMES_FIXTURE });
  const cells = buildFactCells(input);
  const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'month', key: 'month' });

  it('null sort keeps input order (same content)', () => {
    expect(sortShiftRows(rows, null)).toBe(rows);
  });

  it('sorts numerically and reverses on dir=-1 with stable tie-break', () => {
    const asc = sortShiftRows(rows, { col: 'istCHF', dir: 1 });
    for (let i = 1; i < asc.length; i++) expect(asc[i].istCHF).toBeGreaterThanOrEqual(asc[i - 1].istCHF);
    const desc = sortShiftRows(rows, { col: 'istCHF', dir: -1 });
    for (let i = 1; i < desc.length; i++) expect(desc[i].istCHF).toBeLessThanOrEqual(desc[i - 1].istCHF);
    // Tie-Break deterministisch: gleiche Werte → Datum/empId-Reihenfolge
    const tied = sortShiftRows(rows, { col: 'planCHF', dir: 1 });
    const zeroPlan = tied.filter(r => r.planCHF === 0).map(r => r.key);
    expect(zeroPlan).toEqual([...zeroPlan].sort((a, b) => {
      const [ea, da] = a.split('|'); const [eb, db] = b.split('|');
      return da === db ? ea.localeCompare(eb) : da.localeCompare(db);
    }));
  });

  it('sorts by name with locale compare', () => {
    const byName = sortShiftRows(rows, { col: 'empName', dir: 1 });
    const names = byName.map(r => r.empName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'de-CH')));
  });
});

describe('buildShiftCsv / detailTitleForSelection', () => {
  const input = makeInput({ shiftTimes: SHIFT_TIMES_FIXTURE });
  const cells = buildFactCells(input);

  it('CSV: 15 Spalten, Zeiten in Start/Ende gesplittet, fehlende Zeiten leer', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const csv = buildShiftCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Datum;Mitarbeitender;Position;Plan Start;Plan Ende;Plan h;Ist Start;Ist Ende;Ist h;Pause h;Diff h;Plan CHF;Ist CHF;Diff CHF;Ursache');
    expect(lines.length).toBe(rows.length + 1);
    const annaLine = lines.find(l => l.includes('Anna'))!;
    expect(annaLine).toContain('11:00 / 18:00'); // zwei Plan-Starts
    expect(annaLine).toContain('14:00 / 23:00'); // zwei Plan-Enden
    expect(annaLine).toContain(DRILLDOWN_CAUSE_LABEL.ueberstunden);
    // Tag ohne Zeiten → leere Zeitfelder, kein erfundener Wert
    const rows4 = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-04' });
    const line4 = buildShiftCsv(rows4).split('\n')[1];
    expect(line4.startsWith('2026-06-04;Ben;')).toBe(true);
    expect(line4).toContain(';;;'); // leere Start/Ende-Felder
  });

  it('CSV quotes fields containing semicolons', () => {
    const rows = buildDetailShiftRows(input, cells, { group: 'day', period: 'day', key: '2026-06-01' });
    const hacked = [{ ...rows[0], empName: 'Nach; Name' }];
    expect(buildShiftCsv(hacked)).toContain('"Nach; Name"');
  });

  it('detail title: long weekday for day rows, row label otherwise', () => {
    expect(detailTitleForSelection({ group: 'day', period: 'day', key: '2026-06-01', label: 'Mo 01.06.' }))
      .toBe('Montag 01.06.');
    expect(detailTitleForSelection({ group: 'employee', period: 'day', key: 'emp:anna', label: 'Anna' }))
      .toBe('Anna');
  });
});
