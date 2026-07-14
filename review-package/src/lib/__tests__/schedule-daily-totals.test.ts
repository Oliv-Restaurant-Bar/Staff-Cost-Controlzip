// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  dailyTotalsVisibility,
  computeDailyLaborRatio,
  computeDailyKitchenTotals,
  toDailyTotalsDisplay,
  type EmployeeDayInput,
} from '../schedule-daily-totals';
import { getVisibleEmployeesForRole } from '../employee-visibility';
import type { Employee } from '@/types/personnel';

describe('schedule-daily-totals (kueche_manager daily header totals)', () => {
  // ── Required #1: kitchen manager sees daily planned hours ──────────────────
  it('kitchen manager sees daily planned hours (sum of net day hours)', () => {
    const vis = dailyTotalsVisibility('manager');
    expect(vis.showHours).toBe(true);

    const emps: EmployeeDayInput[] = [
      { employmentType: 'teilzeit', hourlyWage: 30, dayHours: 5, dayAbsenceHours: 0 },
      { employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 40, dayHours: 8, dayAbsenceHours: 0 },
    ];
    const t = computeDailyKitchenTotals(emps, 2000, 40, 30);
    expect(t.plannedHours).toBe(13);
  });

  // ── Required #2: kitchen manager sees expected/budget revenue + ratio ──────
  it('kitchen manager sees expected revenue and a personnel-cost ratio', () => {
    const vis = dailyTotalsVisibility('manager');
    expect(vis.showRevenue).toBe(true);
    expect(vis.showRatio).toBe(true);

    // one hourly employee: 5h * 30 = 150 cost; revenue 2500 → ratio 6%
    const t = computeDailyKitchenTotals(
      [{ hourlyWage: 30, dayHours: 5, dayAbsenceHours: 0 }],
      2500,
      40,
      30,
    );
    expect(t.revenue).toBe(2500);
    expect(t.laborCostRatio).toBeCloseTo((150 / 2500) * 100, 6);
    expect(t.isOverTarget).toBe(false);
  });

  // ── Required #3: kitchen manager does NOT see individual wages / CHF cost ──
  it('kitchen manager never sees individual wages or CHF cost (display strips personnelCost)', () => {
    const vis = dailyTotalsVisibility('manager');
    expect(vis.showIndividualWages).toBe(false);
    expect(vis.showCostChf).toBe(false);

    const t = computeDailyKitchenTotals(
      [{ hourlyWage: 99, dayHours: 5, dayAbsenceHours: 0 }],
      1000,
      40,
      30,
    );
    const display = toDailyTotalsDisplay(t);
    // Internal totals carry the CHF cost; the grid-facing display must NOT.
    expect('personnelCost' in t).toBe(true);
    expect('personnelCost' in display).toBe(false);
    expect(Object.keys(display).sort()).toEqual([
      'isOverTarget', 'laborCostRatio', 'plannedHours', 'revenue',
    ]);
    // The ratio is still available to the manager (just not the CHF amount).
    expect(display.laborCostRatio).not.toBeNull();
  });

  // ── Required #4: totals include only kitchen employees ────────────────────
  it('totals include only kitchen employees (service excluded via role scoping)', () => {
    const mixed = [
      { id: 'k1', name: 'Koch', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30, isActive: true },
      { id: 's1', name: 'Kellner', department: 'service', employmentType: 'teilzeit', hourlyWage: 50, isActive: true },
    ] as unknown as Employee[];

    const kitchen = getVisibleEmployeesForRole('kueche_manager', 'küche', mixed);
    expect(kitchen.map(e => e.id)).toEqual(['k1']);

    const inputs: EmployeeDayInput[] = kitchen.map(e => ({
      employmentType: e.employmentType,
      monthlySalary: e.monthlySalary,
      hourlyWage: e.hourlyWage,
      dayHours: 5,
      dayAbsenceHours: 0,
    }));
    const t = computeDailyKitchenTotals(inputs, 1000, 40, 30);
    // Only küche (5h, 5*30=150). Service (5h, 5*50=250) is NOT counted.
    expect(t.plannedHours).toBe(5);
    expect(t.personnelCost).toBe(150);
  });

  // ── Required #5: admin behaviour unchanged (full mode = hours only) ────────
  it("admin ('full' mode) still sees only the existing planned-hours total", () => {
    const vis = dailyTotalsVisibility('full');
    expect(vis.showHours).toBe(true);
    expect(vis.showRevenue).toBe(false);
    expect(vis.showRatio).toBe(false);
    expect(vis.showTargetIndicator).toBe(false);
    expect(vis.showCostChf).toBe(false);
    expect(vis.showIndividualWages).toBe(false);
  });

  // ── Extra: ratio edge cases ───────────────────────────────────────────────
  it('returns null ratio and no over-target when revenue is 0', () => {
    const r = computeDailyLaborRatio(500, 0, 40);
    expect(r.ratio).toBeNull();
    expect(r.isOverTarget).toBe(false);

    const t = computeDailyKitchenTotals(
      [{ hourlyWage: 30, dayHours: 5, dayAbsenceHours: 0 }],
      0,
      40,
      30,
    );
    expect(t.laborCostRatio).toBeNull();
    expect(t.isOverTarget).toBe(false);
  });

  it('flags over-target when ratio exceeds the threshold percent', () => {
    // cost 500, revenue 1000 → 50% > 40% threshold
    const r = computeDailyLaborRatio(500, 1000, 40);
    expect(r.ratio).toBeCloseTo(50, 6);
    expect(r.isOverTarget).toBe(true);

    // exactly at threshold is NOT over target
    const atTarget = computeDailyLaborRatio(400, 1000, 40);
    expect(atTarget.isOverTarget).toBe(false);
  });

  it('prorates salaried cost by days in month (no day hours dependency)', () => {
    // salaried: 6000 / 30 = 200 per day, regardless of dayHours
    const t = computeDailyKitchenTotals(
      [{ employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 40, dayHours: 8, dayAbsenceHours: 0 }],
      0,
      40,
      30,
    );
    expect(t.personnelCost).toBeCloseTo(200, 6);
    expect(t.plannedHours).toBe(8);
  });
});
