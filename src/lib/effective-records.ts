/**
 * effective-records.ts — Effektive Monats-Records (SSoT Erfolgsrechnung)
 * ======================================================================
 *
 * Zentrale, reine Logik für die "effektiven" Reporting-Records, wie sie die
 * Erfolgsrechnung anzeigt. Extrahiert aus PLView.effectiveAllRecords, damit
 * die Mehrjahresanalyse und der Banken-/Investorenbericht EXAKT dieselben
 * Monatswerte verwenden wie die Erfolgsrechnung (keine Zweitberechnung).
 *
 * Regeln (identisch zur Erfolgsrechnung):
 *   1. IST-Umsatz: Tagesansicht (dailyBudgets) schlägt reporting_v1,
 *      AUSSER wenn Sage 3xxx-Umsatzkonten vorhanden sind.
 *      Bei Monats-Take-Away wird Kto. 3000/3010 aufgeteilt.
 *   2. Personalkosten: Buchhaltung (5000–5009) hat Vorrang vor dem
 *      Dienstplan-Wert (personnelCostActual wird entfernt).
 *
 * Die VJ-Umsatz-Regel (revenuePreviousYear) bleibt bewusst in der
 * Erfolgsrechnung: sie betrifft nur die VJ-Spalte der Monatssicht, nicht
 * die IST-Serien der Mehrjahresanalyse.
 *
 * Rein: kein DOM, kein Supabase, keine Seiteneffekte (nur Typ-Importe).
 */

import type { MonthlyFinancialRecord } from '@/types/reporting';
import { computeMonthlyIstNet, computeMonthlyIstGross } from './revenue-sync';

interface DailyEntry {
  actualRevenue?:       number;
  takeawayRevenue?:     number;
  previousYearRevenue?: number;
  maisonRevenue?:       number;
}

export interface EffectiveRecordDeps {
  /** Geschäftsjahr der Records */
  year: number;
  /** Tagesumsätze (tenant-Blob "dailyBudgets", Keys "YYYY-MM-DD", jahresübergreifend) */
  dailyBudgets: Record<string, DailyEntry>;
  /** Marketing/Maison-Tageswerte (nur übergeben, wenn Maison aktiviert ist) */
  maisonDaily?: Record<string, number>;
  /** Monatliche Take-Away-Nettowerte (Keys "YYYY-MM") */
  takeawayMonthly?: Record<string, number>;
  /** true = Netto-Anzeige (Standard der Erfolgsrechnung), false = Brutto */
  net: boolean;
}

/** Hat der Record individuelle Sage-Umsatzkonten (3xxx) im laufenden Jahr? */
export function hasIndividualRevenueAccounts(rec: MonthlyFinancialRecord): boolean {
  return rec.expenseCategories.some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 3000 && n <= 3999;
  });
}

/** Hat der Record Buchhaltungs-Lohnkonten (5000–5009)? */
export function hasAccountingWageAccounts(rec: MonthlyFinancialRecord): boolean {
  return rec.expenseCategories.some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 5000 && n <= 5009;
  });
}

/**
 * Wendet die ER-Regeln 1+2 auf einen einzelnen Monats-Record an (1-basiert).
 * Gibt den unveränderten Record zurück, wenn keine Regel greift.
 */
export function applyEffectiveMonthRules(
  rec: MonthlyFinancialRecord,
  month: number,
  deps: EffectiveRecordDeps,
): MonthlyFinancialRecord {
  let r = rec;
  const { year, dailyBudgets, maisonDaily, takeawayMonthly, net } = deps;

  // ── Regel 1: IST-Umsatz aus der Tagesansicht ──────────────────────────────
  if (!hasIndividualRevenueAccounts(r)) {
    const mm = String(month).padStart(2, '0');
    const taMonthly = takeawayMonthly?.[`${year}-${mm}`] ?? 0;
    const tagesansichtRev = net
      ? computeMonthlyIstNet(year, month, dailyBudgets, undefined, maisonDaily, taMonthly > 0 ? taMonthly : undefined)
      : computeMonthlyIstGross(year, month, dailyBudgets, undefined, maisonDaily);
    if (tagesansichtRev > 0) {
      if (r.revenueActual && Math.abs(r.revenueActual - tagesansichtRev) > 1) {
        console.warn(
          `[REVENUE-SYNC] ${year}-${mm}: ` +
          `reporting_v1=${r.revenueActual.toFixed(0)} vs tagesansicht_${net ? 'net' : 'gross'}=${tagesansichtRev.toFixed(0)} ` +
          `(diff=${(tagesansichtRev - r.revenueActual).toFixed(0)}) → verwende Tagesansicht`,
        );
      }
      // Kto. 3000/3010 aufteilen: Netto = direkt; Brutto = Netto × 1.026
      if (taMonthly > 0) {
        const kto3010 = net ? taMonthly : Math.round(taMonthly * 1.026 * 100) / 100;
        const kto3000 = tagesansichtRev - kto3010;
        r = {
          ...r,
          revenueActual: tagesansichtRev,
          expenseCategories: [
            ...r.expenseCategories,
            { categoryId: '3000', amount: kto3000, label: net ? 'Betriebsertrag Netto' : 'Betriebsertrag Brutto' },
            { categoryId: '3010', amount: kto3010, label: 'Take-Away Umsatz' },
          ],
        };
      } else {
        r = { ...r, revenueActual: tagesansichtRev };
      }
    }
  }

  // ── Regel 2: Personalkosten — Buchhaltung hat Vorrang vor Dienstplan ─────
  // Wenn 5xxx-Lohnkonten (5000–5009) vorhanden sind, personnelCostActual
  // entfernen → die P&L-Engine nutzt direkt die Buchhaltungskonten.
  if (hasAccountingWageAccounts(r) && r.personnelCostActual !== undefined) {
    r = { ...r, personnelCostActual: undefined };
  }

  return r;
}

/**
 * Wendet die ER-Regeln auf alle 12 Monats-Records eines Jahres an.
 * `records[idx]` entspricht Monat idx+1 (loadYear-Konvention).
 */
export function applyEffectiveYearRules(
  records: MonthlyFinancialRecord[],
  deps: EffectiveRecordDeps,
): MonthlyFinancialRecord[] {
  return records.map((rec, idx) => applyEffectiveMonthRules(rec, idx + 1, deps));
}
