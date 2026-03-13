/**
 * useBudgetMonth – Gemeinsamer Budget-Hook
 * ==========================================
 *
 * Liefert die aufgelösten Budget-Werte für einen bestimmten Monat.
 * Wird vom Dashboard und der Soll/Ist Analyse verwendet.
 *
 * Datenquelle: localStorage 'budget_v1' (Budget-Modul)
 *
 * Position-IDs aus DEFAULT_BUDGET_POSITIONS:
 *   budget_revenue, budget_food_cost, budget_bev_cost,
 *   budget_personnel, budget_rent, budget_energy,
 *   budget_marketing, budget_insurance, budget_maintenance, budget_other
 */

import { useMemo } from 'react';
import { loadBudgetYear, resolveBudgetYear } from '@/lib/budget-store';

export interface BudgetMonthData {
  revenueBudget:         number;
  personnelBudget:       number;
  personnelRatioTarget:  number | null;
  foodCostBudget:        number;
  beverageCostBudget:    number;
  totalCostBudget:       number;
  operatingResultBudget: number;
  hasBudget:             boolean;
}

export function useBudgetMonth(year: number, month: number): BudgetMonthData {
  return useMemo(() => {
    const budget   = loadBudgetYear(year);
    const resolved = resolveBudgetYear(budget);

    const m = month - 1; // 0-basierter Array-Index (0=Jan, 11=Dez)

    const find = (id: string) => resolved.positions.find(p => p.position.id === id);

    const revPos  = find('budget_revenue');
    const perPos  = find('budget_personnel');
    const foodPos = find('budget_food_cost');
    const bevPos  = find('budget_bev_cost');

    const revenueBudget      = revPos  ? revPos.resolvedCHF[m]  : 0;
    const personnelBudget    = perPos  ? perPos.resolvedCHF[m]  : 0;
    const foodCostBudget     = foodPos ? foodPos.resolvedCHF[m] : 0;
    const beverageCostBudget = bevPos  ? bevPos.resolvedCHF[m]  : 0;

    // Ziel-Personalkostenquote:
    //   – Wenn %-Position: den Prozentwert direkt nehmen (z.B. 32.0 %)
    //   – Wenn CHF-Position: Quote aus Budget berechnen (falls Umsatzbudget vorhanden)
    let personnelRatioTarget: number | null = null;
    if (perPos) {
      if (perPos.position.valueType === 'percent') {
        personnelRatioTarget = perPos.position.monthlyValues[m];
      } else if (revenueBudget > 0) {
        personnelRatioTarget = (personnelBudget / revenueBudget) * 100;
      }
    }

    // Gesamtaufwand für diesen Monat (alle Expense-Positionen)
    const totalCostBudget = resolved.positions
      .filter(r => r.position.isExpense)
      .reduce((s, r) => s + r.resolvedCHF[m], 0);

    const operatingResultBudget = revenueBudget - totalCostBudget;

    const hasBudget = revenueBudget > 0 || personnelBudget > 0;

    return {
      revenueBudget,
      personnelBudget,
      personnelRatioTarget,
      foodCostBudget,
      beverageCostBudget,
      totalCostBudget,
      operatingResultBudget,
      hasBudget,
    };
  }, [year, month]);
}
