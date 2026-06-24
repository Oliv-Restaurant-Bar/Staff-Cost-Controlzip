/**
 * Pure helpers for the per-day "manager-safe" header totals shown to the
 * kueche_manager in the weekly Dienstplan view (ModernScheduleGrid day header).
 *
 * NO React / supabase / DOM imports — pure logic only (node-testable).
 *
 * Wage confidentiality: this module computes a personnel-cost RATIO (%) for the
 * kitchen manager, but the grid-facing display shape (`DailyTotalsDisplay`)
 * deliberately OMITS the CHF `personnelCost` so that no salary-sensitive amount
 * (cost in CHF, hourly wage, monthly salary) ever reaches grid props or the DOM.
 * The kitchen manager only ever sees: planned hours, expected revenue, a cost
 * RATIO in percent, and an over/under-target indicator.
 */

export type DailyTotalsMode = 'full' | 'manager';

export interface DailyTotalsVisibility {
  showHours: boolean;
  showRevenue: boolean;
  showRatio: boolean;
  showTargetIndicator: boolean;
  /** CHF personnel-cost amount — intentionally NEVER true (wage-sensitive). */
  showCostChf: boolean;
  /** Individual hourly wage / monthly salary — NEVER true (wage-sensitive). */
  showIndividualWages: boolean;
}

/**
 * Visibility matrix that drives the day-header JSX.
 *
 * - 'full'    (admin / service_manager / beaulieu): only planned hours, exactly
 *             as before this feature → admin & service behaviour UNCHANGED.
 * - 'manager' (kueche_manager): planned hours + expected revenue + cost ratio +
 *             over/under-target indicator — but NEVER CHF cost or wages.
 */
export function dailyTotalsVisibility(mode: DailyTotalsMode): DailyTotalsVisibility {
  if (mode === 'manager') {
    return {
      showHours: true,
      showRevenue: true,
      showRatio: true,
      showTargetIndicator: true,
      showCostChf: false,
      showIndividualWages: false,
    };
  }
  return {
    showHours: true,
    showRevenue: false,
    showRatio: false,
    showTargetIndicator: false,
    showCostChf: false,
    showIndividualWages: false,
  };
}

export interface DailyLaborRatio {
  /** Personnel-cost ratio in PERCENT (e.g. 38.2). null when revenue <= 0. */
  ratio: number | null;
  /** ratio strictly above the target threshold (only meaningful when revenue > 0). */
  isOverTarget: boolean;
}

/**
 * Personnel-cost ratio in PERCENT = cost / revenue * 100. This matches the
 * existing week/month PKQ cards in SchedulePlanner, which compute
 * `(cost / revenue) * 100` and compare it against `targetPercent`.
 * Returns a null ratio and isOverTarget=false when there is no revenue.
 */
export function computeDailyLaborRatio(
  personnelCost: number,
  revenue: number,
  thresholdPercent: number,
): DailyLaborRatio {
  if (!(revenue > 0)) return { ratio: null, isOverTarget: false };
  const ratio = (personnelCost / revenue) * 100;
  return { ratio, isOverTarget: ratio > thresholdPercent };
}

export interface EmployeeDayInput {
  employmentType?: string;
  monthlySalary?: number;
  hourlyWage?: number;
  /** Net work hours for the day (break-deducted), from `calculateDayHours`. */
  dayHours: number;
  /** Paid/counted absence hours for the forecast, from `getDayAbsenceHoursForForecast`. */
  dayAbsenceHours: number;
}

export interface DailyKitchenTotals {
  plannedHours: number;
  /** CHF — internal / test only. NEVER passed to the grid (see toDailyTotalsDisplay). */
  personnelCost: number;
  revenue: number;
  laborCostRatio: number | null;
  isOverTarget: boolean;
}

/** Grid-facing, wage-safe shape (NO personnelCost, NO wages). */
export interface DailyTotalsDisplay {
  plannedHours: number;
  revenue: number;
  laborCostRatio: number | null;
  isOverTarget: boolean;
}

function isSalaried(e: EmployeeDayInput): boolean {
  return (e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit')
    && (e.monthlySalary ?? 0) > 0;
}

/**
 * Per-day kitchen totals. Mirrors the app's existing "Plan-PKQ" cost model
 * (see SchedulePlanner.weeklyPlannedLaborCost):
 *   - salaried (vollzeit/teilzeit with monthlySalary) → monthlySalary prorated
 *     per day (monthlySalary / daysInMonth)
 *   - hourly → (net work hours + paid absence hours) * hourlyWage
 *
 * `emps` MUST already be scoped to the kitchen — the caller passes the
 * role-scoped list, so service employees never contribute to the totals.
 */
export function computeDailyKitchenTotals(
  emps: EmployeeDayInput[],
  revenue: number,
  thresholdPercent: number,
  daysInMonth: number,
): DailyKitchenTotals {
  const safeDays = daysInMonth > 0 ? daysInMonth : 1;
  let plannedHours = 0;
  let personnelCost = 0;
  for (const e of emps) {
    plannedHours += e.dayHours;
    if (isSalaried(e)) {
      personnelCost += (e.monthlySalary as number) / safeDays;
    } else {
      personnelCost += (e.dayHours + e.dayAbsenceHours) * (e.hourlyWage ?? 0);
    }
  }
  const { ratio, isOverTarget } = computeDailyLaborRatio(personnelCost, revenue, thresholdPercent);
  return {
    plannedHours: Math.round(plannedHours * 100) / 100,
    personnelCost,
    revenue,
    laborCostRatio: ratio,
    isOverTarget,
  };
}

/** Strip the CHF personnel cost so it never reaches grid props / the DOM. */
export function toDailyTotalsDisplay(t: DailyKitchenTotals): DailyTotalsDisplay {
  return {
    plannedHours: t.plannedHours,
    revenue: t.revenue,
    laborCostRatio: t.laborCostRatio,
    isOverTarget: t.isOverTarget,
  };
}
