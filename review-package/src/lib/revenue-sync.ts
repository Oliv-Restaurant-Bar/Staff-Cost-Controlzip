/**
 * revenue-sync.ts – Zentrale Umsatz-Berechnung
 * =============================================
 *
 * Identische Logik wie TagesansichtPage (Zeilen 201–230).
 * Stellt sicher: P&L Ist-Umsatz ≡ Tagesansicht Ist-Umsatz für denselben Zeitraum.
 *
 * Warum gross→net?
 *   dailyBudgets.actualRevenue ist der BRUTTO-Umsatz (Kassenbetrag inkl. MwSt).
 *   Die Erfolgsrechnung (P&L) arbeitet immer mit NETTO-Umsatz.
 *   grossToNet() wendet die korrekten CH-MWST-Sätze an (8.1% Standard, 2.6% Take-away).
 *
 * Verwendung in:
 *   - src/pages/PLView.tsx (effectiveAllRecords, allMonthOverrides)
 *   - (Erweiterbar: Dashboard, Reporting-Übersicht)
 */

import { grossToNet } from '@/types/personnel';
import type { VjDayRecord } from './vj-daily-supabase';

interface DailyEntry {
  actualRevenue?:       number;
  takeawayRevenue?:     number;
  previousYearRevenue?: number;
  maisonRevenue?:       number;
}

/**
 * Berechnet den IST-Umsatz NETTO für einen Monat aus den dailyBudgets.
 * Identisch mit der Summierungslogik in TagesansichtPage (useMemo Rows).
 *
 * Gibt 0 zurück wenn keine Tagesdaten vorhanden.
 *
 * @param maisonMonthly Legacy: Record<"YYYY-MM", grossCHF> — monatlicher Blob (veraltet).
 * @param maisonDaily   Bevorzugt: Record<"YYYY-MM-DD", grossCHF> — Tageswerte (Marketing).
 *   Wenn übergeben, hat maisonDaily Priorität über maisonMonthly.
 */
export function computeMonthlyIstNet(
  year:             number,
  month:            number,
  dailyBudgets:     Record<string, DailyEntry>,
  maisonMonthly?:   Record<string, number>,
  maisonDaily?:     Record<string, number>,
  monthlyTakeaway?: number,
): number {
  const days = new Date(year, month, 0).getDate();
  const mm   = String(month).padStart(2, '0');
  let total  = 0;

  if (monthlyTakeaway !== undefined && monthlyTakeaway > 0) {
    // Monats-Takeaway-Override: Tagesbrutto summieren, dann Split-MwSt anwenden.
    // monthlyTakeaway ist der NETTO-Betrag aus der Buchhaltung (Kontoblatt Haben).
    // Umrechnung: Netto → Brutto mit 2.6%-Satz, damit grossToNet() korrekt splittet.
    let totalGross = 0;
    for (let d = 1; d <= days; d++) {
      const key = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      totalGross += dailyBudgets[key]?.actualRevenue ?? 0;
    }
    if (totalGross > 0) {
      const ta_brutto = Math.min(monthlyTakeaway * (1 + 0.026), totalGross);
      total = grossToNet(totalGross, ta_brutto);
    }
  } else {
    for (let d = 1; d <= days; d++) {
      const key  = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      const e    = dailyBudgets[key];
      if (!e) continue;
      const gross    = e.actualRevenue   ?? 0;
      const takeaway = e.takeawayRevenue ?? 0;
      if (gross === 0 && takeaway === 0) continue;
      total += grossToNet(gross, takeaway);
    }
  }
  // Marketing/Maison-Umsatz: Tageswerte haben Priorität über monatlichen Blob
  if (maisonDaily) {
    for (let d = 1; d <= days; d++) {
      const key   = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      const gross = maisonDaily[key] ?? 0;
      if (gross > 0) total += gross / 1.081;
    }
  } else if (maisonMonthly) {
    const maison = maisonMonthly[`${year}-${mm}`] ?? 0;
    if (maison > 0) total += grossToNet(maison, 0);
  }
  return total;
}

/**
 * Berechnet den IST-Umsatz BRUTTO für einen Monat (Kassenbetrag inkl. MwSt).
 * Wird für die Brutto-Kontrollansicht in PLView verwendet.
 */
export function computeMonthlyIstGross(
  year:           number,
  month:          number,
  dailyBudgets:   Record<string, DailyEntry>,
  maisonMonthly?: Record<string, number>,
  maisonDaily?:   Record<string, number>,
): number {
  const days = new Date(year, month, 0).getDate();
  const mm   = String(month).padStart(2, '0');
  let total  = 0;
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    total += dailyBudgets[key]?.actualRevenue ?? 0;
  }
  if (maisonDaily) {
    for (let d = 1; d <= days; d++) {
      const key = `${year}-${mm}-${String(d).padStart(2, '0')}`;
      total += maisonDaily[key] ?? 0;
    }
  } else if (maisonMonthly) {
    total += maisonMonthly[`${year}-${mm}`] ?? 0;
  }
  return total;
}

/**
 * Prüft ob für einen Monat überhaupt Tagesdaten in dailyBudgets vorhanden sind
 * (mindestens ein Tag mit actualRevenue > 0).
 */
export function hasDailyData(
  year:         number,
  month:        number,
  dailyBudgets: Record<string, DailyEntry>,
): boolean {
  const days = new Date(year, month, 0).getDate();
  const mm   = String(month).padStart(2, '0');
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    if ((dailyBudgets[key]?.actualRevenue ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Berechnet den VJ-Umsatz NETTO für einen Monat.
 * Identische Priorität wie TagesansichtPage:
 *   1. vjSupabaseData[vjKey].actualRevenue  (exakte Supabase-Tageswerte)
 *   2. dailyBudgets[currentKey].previousYearRevenue  (direkter VJ-Blob)
 *   3. dailyBudgets[vjKey].actualRevenue  (Blob für das VJ-Datum)
 *   4. 0  (kein Wert → kein pro-rata, PLView hält eigenes Fallback)
 *
 * Gibt 0 zurück wenn keine VJ-Daten vorhanden.
 */
export function computeMonthlyVjNet(
  year:           number,
  month:          number,
  dailyBudgets:   Record<string, DailyEntry>,
  vjSupabaseData: Record<string, VjDayRecord>,
): number {
  const vjYear = year - 1;
  const days   = new Date(year, month, 0).getDate();
  const mm     = String(month).padStart(2, '0');
  const vjYearMM = `${vjYear}-${mm}`;

  const hasVjSupabaseMonth = Object.keys(vjSupabaseData).some(k => k.startsWith(vjYearMM));

  let total = 0;
  for (let d = 1; d <= days; d++) {
    const dd         = String(d).padStart(2, '0');
    const currentKey = `${year}-${mm}-${dd}`;
    const vjKey      = `${vjYear}-${mm}-${dd}`;

    const vjSupabase = vjSupabaseData[vjKey]?.actualRevenue;
    const vjDirect   = dailyBudgets[currentKey]?.previousYearRevenue ?? 0;
    const vjBlob     = vjDirect > 0 ? vjDirect : (dailyBudgets[vjKey]?.actualRevenue ?? 0);

    let vjRaw: number;
    if (vjSupabase !== undefined) {
      vjRaw = vjSupabase;
    } else if (hasVjSupabaseMonth) {
      vjRaw = 0;
    } else if (vjBlob > 0) {
      vjRaw = vjBlob;
    } else {
      vjRaw = 0;
    }

    total += grossToNet(vjRaw);
  }
  return total;
}

/**
 * Prüft ob VJ-Daten für einen Monat vorhanden sind
 * (Supabase oder Blob).
 */
export function hasVjData(
  year:           number,
  month:          number,
  dailyBudgets:   Record<string, DailyEntry>,
  vjSupabaseData: Record<string, VjDayRecord>,
): boolean {
  const vjYear   = year - 1;
  const days     = new Date(year, month, 0).getDate();
  const mm       = String(month).padStart(2, '0');
  const vjYearMM = `${vjYear}-${mm}`;

  if (Object.keys(vjSupabaseData).some(k => k.startsWith(vjYearMM))) return true;

  for (let d = 1; d <= days; d++) {
    const dd         = String(d).padStart(2, '0');
    const currentKey = `${year}-${mm}-${dd}`;
    const vjKey      = `${vjYear}-${mm}-${dd}`;
    if (
      (dailyBudgets[currentKey]?.previousYearRevenue ?? 0) > 0 ||
      (dailyBudgets[vjKey]?.actualRevenue ?? 0) > 0
    ) return true;
  }
  return false;
}
