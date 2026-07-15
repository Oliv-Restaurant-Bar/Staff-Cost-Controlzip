/**
 * useFinancialMonthInput — EIN gemeinsames Wiring für den Registry-Input.
 * =======================================================================
 * VERBATIM aus Dashboard.tsx extrahiert: lädt die IO-Abhängigkeiten des
 * Financial-Metrics-Registry-Inputs (Monats-Take-Away via kvGet, VJ-Tageswerte
 * via loadVjDailyYear) und baut mit `buildFinancialMetricInput` (SSoT-Builder,
 * EIN computePLForMonth) den Input für getFinancialMetricValues.
 *
 * STRIKT READ-ONLY: reine Reads (kvGet, Supabase-Select, localStorage über den
 * Builder) — kein Write, kein updatedAt-Bump. Konsumenten: Dashboard
 * (FinancialMonthSection) und Startseite («Executive Cockpit») — dieselben
 * Werte, keine Zweitberechnung.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { kvGet } from '@/lib/supabase-kv';
import { loadVjDailyYear, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { buildFinancialMetricInput } from '@/lib/financial-metrics-input';
import type { FinancialMetricRegistryInput } from '@/lib/financial-metrics';
import type { FinancialMetricInputDeps } from '@/lib/financial-metrics-input';

export interface FinancialMonthInputDeps {
  /** Tagesumsätze (tenant-Blob "dailyBudgets", geparst) — vom Aufrufer gehalten. */
  dailyBudgets: FinancialMetricInputDeps['dailyBudgets'];
  /** Maison/Marketing-Tageswerte (maison-store) — leer, wenn nicht genutzt. */
  maisonDaily: Record<string, number>;
  /** Maison aktiviert? (getMaisonEnabledSync) */
  maisonOn: boolean;
  /** Maison explizit ausgeschlossen? (useMaison().maisonExclude) */
  maisonExclude: boolean;
  /** Re-Compute-Tick nach Supabase→localStorage-Sync (reporting_v1). */
  reportingTick: number;
}

export interface FinancialMonthInputResult {
  /** Registry-Input (EIN computePLForMonth) — null = Berechnung fehlgeschlagen. */
  financialInput: FinancialMetricRegistryInput | null;
  /** Monatlicher Take-Away-Nettowert (Kto. 3010) des Monats — 0 wenn keiner. */
  monthlyTakeaway: number;
  /** VJ-Tageswerte (Supabase, Jahr−1) — {} solange nicht geladen. */
  vjDailyData: Record<string, VjDayRecord>;
}

export function useFinancialMonthInput(
  year: number,
  month: number,
  deps: FinancialMonthInputDeps,
): FinancialMonthInputResult {
  const { tenantId, tenantKey } = useTenant();
  const { dailyBudgets, maisonDaily, maisonOn, maisonExclude, reportingTick } = deps;

  // ── Monatliches Take-Away (Kto. 3010 Netto) — verbatim Dashboard ────────────
  const [monthlyTakeaway, setMonthlyTakeaway] = useState(0);
  useEffect(() => {
    const mm = String(month).padStart(2, '0');
    kvGet(tenantKey(`takeaway-monthly-${year}`)).then(raw => {
      const val = (raw as Record<string, number> | null)?.[`${year}-${mm}`] ?? 0;
      setMonthlyTakeaway(val);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, tenantId]);

  // ── VJ-Tagesumsätze (Vorjahr) — verbatim Dashboard ──────────────────────────
  const [vjDailyData, setVjDailyData] = useState<Record<string, VjDayRecord>>({});
  useEffect(() => {
    let alive = true;
    loadVjDailyYear(year - 1, tenantId)
      .then(data => { if (alive) setVjDailyData(data); })
      .catch(() => { if (alive) setVjDailyData({}); });
    return () => { alive = false; };
  }, [year, tenantId]);

  // ── Registry-Input (EIN computePLForMonth) — verbatim Dashboard ─────────────
  const financialInput = useMemo(() => {
    try {
      return buildFinancialMetricInput(year, month, {
        reportingStoreKey: tenantKey('reporting_v1'),
        budgetStoreKey:    tenantKey('budget_v1'),
        dailyBudgets,
        vjDaily:           vjDailyData,
        maisonDaily:       maisonOn && !maisonExclude ? maisonDaily : undefined,
        takeawayMonthly:   monthlyTakeaway > 0
          ? { [`${year}-${String(month).padStart(2, '0')}`]: monthlyTakeaway }
          : undefined,
      });
    } catch (e) {
      console.error('[FINANZKARTEN] Registry-Input fehlgeschlagen:', e);
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, dailyBudgets, vjDailyData, maisonOn, maisonExclude, maisonDaily, monthlyTakeaway, reportingTick, tenantId]);

  return { financialInput, monthlyTakeaway, vjDailyData };
}
