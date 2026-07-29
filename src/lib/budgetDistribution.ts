/**
 * budgetDistribution – Tagesverteilung des Monatsbudgets
 * ========================================================
 * Verteilt den monatlichen Umsatz auf einzelne Tage nach Wochentag-Gewichtung.
 * Gewichte werden aus den Einstellungen (localStorage) geladen — KEINE Hardcode-Defaults.
 */

import { format } from 'date-fns';
import { loadBudgetWithPL, computePLCategoryTotals } from './budget-store';
import { loadWeekdayWeights, getDailyBudgetMap } from './budget-day';
import { buildBudgetByRowForMonth } from './pl-engine';

// ─── Für Abwärtskompatibilität: dynamische Gewichte aus Einstellungen ─────────
/** @deprecated Bitte getDailyBudgetMap() aus budget-day.ts verwenden. */
export function getDAY_WEIGHTS(): Record<number, number> {
  const w = loadWeekdayWeights(); // normiert (Summe ≈ 1)
  const out: Record<number, number> = {};
  for (let d = 0; d <= 6; d++) out[d] = w[d] * 100;
  return out;
}

/**
 * Liest den geplanten Monats-Umsatz aus dem Budget-Store (P&L-Format).
 * @param year       Jahreszahl (z.B. 2026)
 * @param monthIndex Monat 0-basiert (0 = Januar, 11 = Dezember)
 * @param storeKey   Optionaler Tenant-Speicherschlüssel (default: Oliv 'budget_v1')
 */
export function getMonthlyBudgetRevenue(year: number, monthIndex: number, storeKey?: string): number {
  try {
    const budget  = loadBudgetWithPL(year, storeKey);
    const totals  = computePLCategoryTotals(budget.plLineItems ?? []);
    const byMonth = totals['pl_revenue'] ?? Array(12).fill(0);
    return byMonth[monthIndex] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Liest das budgetierte Personalkosten-Budget des Monats aus dem Budget-Modul.
 *
 * SSoT: Es wird EXAKT dieselbe Ableitung wie in der Erfolgsrechnung/PLView
 * verwendet (`buildBudgetByRowForMonth` → budgetByRow), NICHT das actual-gated
 * Direktfeld. „Personalaufwand" = Löhne (`personnel_wages`) + Sozialleistungen
 * (`personnel_social`) — EXKLUSIVE „Übriger Personalaufwand" (`personnel_other`).
 *
 * @returns `{ total, wages, social }` oder `null`, wenn im Budget-Modul für
 *          diesen Monat KEIN Personalkosten-Budget hinterlegt ist (dann darf
 *          NICHT still auf eine Konstante zurückgefallen werden).
 * @param year       Jahreszahl (z.B. 2026)
 * @param monthIndex Monat 0-basiert (0 = Januar, 11 = Dezember)
 * @param storeKey   Optionaler Tenant-Speicherschlüssel (default: Oliv 'budget_v1')
 */
export function getMonthlyBudgetPersonnel(
  year: number,
  monthIndex: number,
  storeKey?: string,
): { total: number; wages: number; social: number } | null {
  try {
    const budget = loadBudgetWithPL(year, storeKey);
    const byRow  = buildBudgetByRowForMonth(budget, monthIndex);
    const wages  = byRow.get('personnel_wages')  ?? 0;
    const social = byRow.get('personnel_social') ?? 0;
    const total  = wages + social;
    if (total <= 0) return null; // kein PK-Budget im Budget-Modul hinterlegt
    return { total, wages, social };
  } catch {
    return null;
  }
}

/**
 * Verteilt den Monats-Umsatz anteilig auf alle übergebenen Tage
 * nach Wochentag-Gewichtung aus den Einstellungen.
 * Die Summe über alle Tage ergibt exakt den Monats-Umsatz.
 *
 * @param monthlyRevenue  Geplanter Monats-Umsatz in CHF
 * @param days            Alle Tage des Monats (Date-Objekte, müssen alle im selben Monat sein)
 * @returns               Record { 'yyyy-MM-dd': { plannedRevenue: number } }
 */
export function distributeBudgetByWeekday(
  monthlyRevenue: number,
  days: Date[],
): Record<string, { plannedRevenue: number }> {
  if (!monthlyRevenue || days.length === 0) return {};

  // Monat und Jahr aus dem ersten Tag ableiten (alle Tage müssen im selben Monat liegen)
  const firstDay = days[0];
  const year  = firstDay.getFullYear();
  const month = firstDay.getMonth() + 1; // 1-basiert

  // getDailyBudgetMap nutzt loadWeekdayWeights() intern (Single Source of Truth)
  const dailyMap = getDailyBudgetMap(monthlyRevenue, year, month);

  const result: Record<string, { plannedRevenue: number }> = {};
  for (const day of days) {
    const dateStr = format(day, 'yyyy-MM-dd');
    result[dateStr] = { plannedRevenue: dailyMap[dateStr] ?? 0 };
  }
  return result;
}
