/**
 * useCockpitFinancials — dünner READ-ONLY Kompositions-Hook der Startseite.
 * =========================================================================
 * Stellt dem Executive Cockpit den Financial-Metrics-Registry-Input für den
 * AKTUELLEN Monat bereit — über DASSELBE Wiring wie das Dashboard
 * (useFinancialMonthInput → buildFinancialMetricInput → EIN computePLForMonth).
 * KEINE Zweitberechnung, KEINE neue Datenquelle.
 *
 * Strikt read-only: dailyBudgets werden nur aus localStorage GELESEN (kein
 * Schnelleingabe-Schreibpfad wie im Dashboard), Maison-Tageswerte über den
 * bestehenden Loader, Re-Compute nach Supabase→localStorage-Sync über das
 * bestehende 'store-synced'-Event. Reines Laden löst NIE einen Write aus.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { useMaison } from '@/contexts/MaisonContext';
import { getMaisonEnabledSync, getMaisonDailySync, loadMaisonDaily } from '@/lib/maison-store';
import { useFinancialMonthInput } from '@/hooks/useFinancialMonthInput';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import type { FinancialMetricRegistryInput } from '@/lib/financial-metrics';
import type { DailyBudget } from '@/types/personnel';

export interface CockpitFinancials {
  year: number;
  month: number;
  /** Registry-Input (EIN computePLForMonth) — null solange nicht berechenbar. */
  financialInput: FinancialMetricRegistryInput | null;
  /** Ziel-Personalquote (%) aus dem Budget — null = kein Ziel hinterlegt. */
  personnelRatioTarget: number | null;
  /** Tagesumsätze (read-only, tenant-Key) — für operative Heute-/Wochenwerte. */
  dailyBudgets: Record<string, DailyBudget>;
}

export function useCockpitFinancials(enabled: boolean): CockpitFinancials {
  const { tenantId, tenantKey } = useTenant();
  const { maisonExclude } = useMaison();

  // Aktueller Monat — die Startseite zeigt IMMER den laufenden Monat.
  const now = useMemo(() => new Date(), []);
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // Re-Compute-Tick nach Supabase→localStorage-Sync (bestehendes Event).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const handler = () => setTick(t => t + 1);
    window.addEventListener('store-synced', handler);
    return () => window.removeEventListener('store-synced', handler);
  }, []);

  // Tagesumsätze: reiner localStorage-Read (tenant-Key), NIE ein Write.
  const dailyBudgets = useMemo<Record<string, DailyBudget>>(() => {
    if (!enabled) return {};
    try {
      return JSON.parse(localStorage.getItem(tenantKey('dailyBudgets')) || '{}');
    } catch {
      return {};
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tenantId, tick]);

  // Maison-Tageswerte (bestehender Loader, read-only).
  const [maisonDaily, setMaisonDaily] = useState<Record<string, number>>(() => getMaisonDailySync(tenantKey));
  useEffect(() => {
    if (enabled) loadMaisonDaily(tenantKey).then(setMaisonDaily);
  }, [tenantKey, enabled]);
  const maisonOn = getMaisonEnabledSync(tenantKey);

  const { financialInput } = useFinancialMonthInput(year, month, {
    dailyBudgets,
    maisonDaily,
    maisonOn,
    maisonExclude,
    reportingTick: tick,
  });

  const budgetData = useBudgetMonth(year, month);

  return {
    year,
    month,
    financialInput: enabled ? financialInput : null,
    personnelRatioTarget: budgetData.personnelRatioTarget,
    dailyBudgets,
  };
}
