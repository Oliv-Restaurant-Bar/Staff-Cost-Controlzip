import type { ControlListDay } from './control-list-import';

export interface ProductivityDay {
  date: string;
  isoWeek: string;
  netHours: number;
  revenue?: number;
  productivity?: number;
  meetsBudget?: boolean;
}

export interface ProductivityWeek {
  isoWeek: string;
  netHours: number;
  revenue?: number;
  productivity?: number;
  meetsBudget?: boolean;
  days: ProductivityDay[];
}

export const PRODUCTIVITY_BUDGET_CHF_PER_HOUR = 100;

export function isoWeekForDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Pure day model. Revenue is optional because a sales import can legitimately be absent. */
export function aggregateProductivityDays(
  days: Iterable<Pick<ControlListDay, 'date' | 'netHours'>>,
  dailyNetRevenue: Readonly<Record<string, number>>,
  budget = PRODUCTIVITY_BUDGET_CHF_PER_HOUR,
): ProductivityDay[] {
  const hoursByDate = new Map<string, number>();
  for (const day of days) hoursByDate.set(day.date, (hoursByDate.get(day.date) ?? 0) + day.netHours);
  return [...hoursByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, netHours]) => {
    const revenue = dailyNetRevenue[date];
    const productivity = Number.isFinite(revenue) && netHours > 0 ? revenue / netHours : undefined;
    return { date, isoWeek: isoWeekForDate(date), netHours, revenue, productivity,
      meetsBudget: productivity === undefined ? undefined : Math.round(productivity) >= budget };
  });
}

export function aggregateProductivityWeeks(days: Iterable<ProductivityDay>, budget = PRODUCTIVITY_BUDGET_CHF_PER_HOUR): ProductivityWeek[] {
  const weeks = new Map<string, ProductivityWeek>();
  for (const day of days) {
    const week = weeks.get(day.isoWeek) ?? { isoWeek: day.isoWeek, netHours: 0, days: [] };
    week.netHours += day.netHours;
    week.days.push(day);
    if (day.revenue !== undefined) week.revenue = (week.revenue ?? 0) + day.revenue;
    weeks.set(day.isoWeek, week);
  }
  return [...weeks.values()].sort((a, b) => a.isoWeek.localeCompare(b.isoWeek)).map(week => {
    const productivity = week.revenue !== undefined && week.netHours > 0 ? week.revenue / week.netHours : undefined;
    return { ...week, productivity, meetsBudget: productivity === undefined ? undefined : Math.round(productivity) >= budget };
  });
}

/** Last five calendar weeks in the supplied model (oldest first). */
export function lastFiveProductivityWeeks(weeks: Iterable<ProductivityWeek>): ProductivityWeek[] {
  return [...weeks].sort((a, b) => a.isoWeek.localeCompare(b.isoWeek)).slice(-5);
}