/**
 * budgetDistribution – Tagesverteilung des Monatsbudgets
 * ========================================================
 * Verteilt den monatlichen Umsatz auf einzelne Tage nach Wochentag-Gewichtung.
 *
 * Gewichtung (pro Woche = 100 %):
 *   Mo 10 %  Di 10 %  Mi 10 %  Do 12.5 %  Fr 22.5 %  Sa 22.5 %  So 12.5 %
 */

import { format } from 'date-fns';
import { loadBudgetWithPL, computePLCategoryTotals } from './budget-store';

// ─── Tages-Gewichtung ─────────────────────────────────────────────────────────
// Index entspricht JavaScript getDay(): 0=So, 1=Mo, 2=Di, 3=Mi, 4=Do, 5=Fr, 6=Sa

export const DAY_WEIGHTS: Record<number, number> = {
  0: 12.5, // Sonntag
  1: 10.0, // Montag
  2: 10.0, // Dienstag
  3: 10.0, // Mittwoch
  4: 12.5, // Donnerstag
  5: 22.5, // Freitag
  6: 22.5, // Samstag
};

/**
 * Liest den geplanten Monats-Umsatz aus dem Budget-Store (P&L-Format).
 * @param year       Jahreszahl (z.B. 2026)
 * @param monthIndex Monat 0-basiert (0 = Januar, 11 = Dezember)
 */
export function getMonthlyBudgetRevenue(year: number, monthIndex: number): number {
  try {
    const budget  = loadBudgetWithPL(year);
    const totals  = computePLCategoryTotals(budget.plLineItems ?? []);
    const byMonth = totals['pl_revenue'] ?? Array(12).fill(0);
    return byMonth[monthIndex] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Verteilt den Monats-Umsatz anteilig auf alle übergebenen Tage
 * nach Wochentag-Gewichtung. Die Summe über alle Tage ergibt exakt
 * den Monats-Umsatz (Rundungsfehler < 1 CHF werden dem letzten Tag zugeschlagen).
 *
 * @param monthlyRevenue  Geplanter Monats-Umsatz in CHF
 * @param days            Alle Tage des Monats (Date-Objekte)
 * @returns               Record { 'yyyy-MM-dd': { plannedRevenue: number } }
 */
export function distributeBudgetByWeekday(
  monthlyRevenue: number,
  days: Date[],
): Record<string, { plannedRevenue: number }> {
  if (!monthlyRevenue || days.length === 0) return {};

  const totalWeight = days.reduce((sum, d) => sum + DAY_WEIGHTS[d.getDay()], 0);
  if (totalWeight === 0) return {};

  const result: Record<string, { plannedRevenue: number }> = {};
  let distributed = 0;

  days.forEach((day, idx) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const weight  = DAY_WEIGHTS[day.getDay()];
    const isLast  = idx === days.length - 1;

    const amount = isLast
      ? Math.round(monthlyRevenue - distributed)   // Restbetrag dem letzten Tag
      : Math.round((monthlyRevenue * weight) / totalWeight);

    distributed += amount;
    result[dateStr] = { plannedRevenue: amount };
  });

  return result;
}
