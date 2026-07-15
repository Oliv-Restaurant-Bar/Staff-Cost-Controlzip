/**
 * financial-metrics-input.ts — IO-Builder für die Financial Metrics Registry
 * ===========================================================================
 *
 * Baut den Registry-Input (`{ pl }`) für EINEN Monat — STRIKT READ-ONLY und
 * EXAKT auf dem Berechnungspfad der Erfolgsrechnung (keine Zweitberechnung):
 *
 *   1. reporting_v1-Monat laden (EXPLIZITER tenant-präfixierter Store-Key —
 *      der Default-Key von loadMonth ist NICHT tenant-präfixiert!)
 *   2. Effektive ER-Regeln anwenden (effective-records, SSoT):
 *      IST-Umsatz Tagesansicht > reporting_v1 (ausser Sage-3xxx),
 *      Personalkosten Buchhaltung > Dienstplan, VJ-Umsatz-Regel.
 *      Finanzkennzahlen sind IMMER NETTO (net: true) — kein Brutto-Switch.
 *   3. Budget-Overrides zentral aus pl-engine (buildBudgetByRowForMonth +
 *      buildCogsBudgetSplitForMonth), VJ-Overrides via
 *      buildPrevYearByRowForMonth — identisch zur PLView-Monatssicht.
 *   4. EIN computePLForMonth mit allen drei Spalten.
 *
 * Keine Writes: nur loadMonth/loadBudgetWithPL/lookupAccount (localStorage-
 * Reads). VJ-Supabase-Tageswerte (vjDaily) werden vom Aufrufer geladen und
 * hereingereicht — dieses Modul öffnet selbst keine Supabase-Verbindung.
 */

import { loadMonth } from './reporting-store';
import { loadBudgetWithPL } from './budget-store';
import { lookupAccount } from './account-mapping-store';
import {
  computePLForMonth,
  buildBudgetByRowForMonth,
  buildCogsBudgetSplitForMonth,
  buildPrevYearByRowForMonth,
} from './pl-engine';
import {
  applyEffectiveMonthRules,
  applyVjRevenueRule,
  type EffectiveRecordDeps,
  type VjRevenueDeps,
} from './effective-records';
import type { FinancialMetricRegistryInput } from './financial-metrics';

export interface FinancialMetricInputDeps {
  /** Tenant-präfixierter Reporting-Store-Key: tenantKey('reporting_v1') */
  reportingStoreKey: string;
  /** Tenant-präfixierter Budget-Store-Key: tenantKey('budget_v1') */
  budgetStoreKey: string;
  /** Tagesumsätze (tenant-Blob "dailyBudgets", geparst, jahresübergreifend) */
  dailyBudgets: EffectiveRecordDeps['dailyBudgets'];
  /** VJ-Tageswerte aus Supabase (loadVjDailyYear(year−1)); weglassen ⇒ Blob-Fallbacks */
  vjDaily?: VjRevenueDeps['vjDaily'];
  /** Marketing/Maison-Tageswerte — nur übergeben, wenn Maison aktiviert ist */
  maisonDaily?: EffectiveRecordDeps['maisonDaily'];
  /** Monatliche Take-Away-Nettowerte (Keys "YYYY-MM") */
  takeawayMonthly?: EffectiveRecordDeps['takeawayMonthly'];
}

/**
 * Registry-Input für einen Monat (month 1-basiert) — read-only.
 * IST/Budget/VJ stammen aus EINEM computePLForMonth-Lauf, identisch zur
 * Erfolgsrechnungs-Monatssicht (netto).
 */
export function buildFinancialMetricInput(
  year: number,
  month: number,
  deps: FinancialMetricInputDeps,
): FinancialMetricRegistryInput {
  const rec     = loadMonth(year,     month, deps.reportingStoreKey);
  const prevRec = loadMonth(year - 1, month, deps.reportingStoreKey);

  // Effektive ER-Regeln (SSoT) — Finanzkennzahlen immer NETTO
  let eff = applyEffectiveMonthRules(rec, month, {
    year,
    dailyBudgets: deps.dailyBudgets,
    maisonDaily: deps.maisonDaily,
    takeawayMonthly: deps.takeawayMonthly,
    net: true,
  });
  eff = applyVjRevenueRule(eff, month, {
    year,
    dailyBudgets: deps.dailyBudgets,
    vjDaily: deps.vjDaily ?? {},
    prevYearRecord: prevRec,
  });

  // Budget- + VJ-Overrides zentral aus pl-engine (identisch zur PLView)
  const budgetData      = loadBudgetWithPL(year, deps.budgetStoreKey);
  const budgetByRow     = buildBudgetByRowForMonth(budgetData, month - 1, lookupAccount);
  const prevYearByRow   = buildPrevYearByRowForMonth(prevRec, eff, lookupAccount);
  const cogsBudgetSplit = buildCogsBudgetSplitForMonth(budgetData, month - 1, lookupAccount);

  const pl = computePLForMonth(eff, {
    budgetByRow:   budgetByRow.size   > 0 ? budgetByRow   : undefined,
    prevYearByRow: prevYearByRow.size > 0 ? prevYearByRow : undefined,
    cogsBudgetSplit,
  });

  return { pl };
}
