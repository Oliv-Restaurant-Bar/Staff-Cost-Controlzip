/**
 * useBudgetMonth – Gemeinsamer Budget-Hook
 * ==========================================
 *
 * Liefert die aufgelösten Budget-Werte für einen bestimmten Monat.
 * Wird vom Dashboard und der Soll/Ist Analyse verwendet.
 *
 * Datenquelle: localStorage 'budget_v1' (Budget-Modul)
 *
 * Wichtig: Nutzt loadBudgetWithPL (nicht nur loadBudgetYear) um sicherzustellen,
 * dass plLineItems → legacy positions synchronisiert sind, damit hasBudget
 * auch dann true ist wenn der Nutzer Budget über die P&L-Hierarchie erfasst hat.
 */

import { useMemo } from 'react';
import { loadBudgetWithPL, resolveBudgetYear, STORAGE_KEY } from '@/lib/budget-store';
import { useTenant } from '@/contexts/TenantContext';

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
  const { tenantId, tenantKey } = useTenant();
  return useMemo(() => {
    // loadBudgetWithPL stellt sicher dass plLineItems → positions sync läuft
    // tenantKey() liefert den korrekten storeKey je Mandant (Oliv: 'budget_v1', Beaulieu: 'beaulieu:budget_v1')
    const storeKey = tenantKey(STORAGE_KEY);
    const budget   = loadBudgetWithPL(year, storeKey);
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

    // hasBudget: true wenn Umsatz- oder Personalbudget vorhanden
    // Fallback: direkt in plLineItems prüfen (falls positions noch nicht synced)
    const hasPositionValues = revenueBudget > 0 || personnelBudget > 0;
    const hasLineItemValues = budget.plLineItems?.some(
      item => (item.categoryId === 'pl_revenue' || item.categoryId === 'pl_wages') &&
              item.monthlyValues.some(v => v !== 0)
    ) ?? false;
    const hasBudget = hasPositionValues || hasLineItemValues;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, tenantId]);
}
