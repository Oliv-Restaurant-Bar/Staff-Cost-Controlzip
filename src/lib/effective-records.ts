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
 * Zusätzlich zentral (für Monatssicht-VJ-Konsumenten — PLView UND
 * Financial-Metrics-Registry/Dashboard):
 *   3. VJ-Umsatz (`applyVjRevenueRule`): Tagesansicht-VJ-NETTO schlägt
 *      reporting_v1, AUSSER wenn Sage 3xxx-PY-Konten vorhanden sind;
 *      Fallback auf revenueActual des Vorjahres-Records.
 *      (Die IST-Serien der Mehrjahresanalyse brauchen diese Regel nicht.)
 *
 * Rein: kein DOM, kein Supabase, keine Seiteneffekte (nur Typ-Importe).
 */

import type { MonthlyFinancialRecord } from '@/types/reporting';
import type { VjDayRecord } from './vj-daily-supabase';
import { computeMonthlyIstNet, computeMonthlyIstGross, computeMonthlyVjNet } from './revenue-sync';

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

// ─── Kanonischer IST-Umsatz (umsatz.ts) — gemeinsame Regel für ER + Reporting ──
/** Netto/Brutto-Summe eines Monats aus den gn-Imports (Tage ohne Import fehlen). */
export interface CanonicalMonthRevenue { net: number; gross: number; hasData: boolean }
export type CanonicalRevenueByMonth = Record<number, CanonicalMonthRevenue>;

export interface CanonicalIstDeps {
  /** Geschäftsjahr (für die Take-Away-Monats-Keys "YYYY-MM") */
  year: number;
  /** Kanonische Monats-Umsätze (1-basiert) aus umsatz.ts (ladeUmsatzTage → aggregat). */
  canonical: CanonicalRevenueByMonth;
  /** Monatliche Take-Away-Nettowerte (Keys "YYYY-MM"), manueller Override. */
  takeawayMonthly?: Record<string, number>;
  /** true = Netto-Anzeige (Standard), false = Brutto. */
  net: boolean;
}

/**
 * Gemeinsame IST-Umsatz-Regel für Erfolgsrechnung (PLView) UND Reporting.
 * Setzt revenueActual = EXAKT dem kanonischen Netto/Brutto-Wert (Σ nettoUmsatzTag)
 * — KEIN additiver Maison-Zuschlag (Maison ist ggf. eine reine Anzeige-Spalte).
 * Regeln (identisch auf beiden Seiten):
 *   - 3xxx-Umsatzkonten haben Vorrang: bei individuellen Konten wird nichts gesetzt.
 *   - Take-Away Kto. 3000/3010-Split bei monatlichem Override (Netto direkt,
 *     Brutto = Netto × 1.026).
 *   - Personalkosten: Buchhaltung 5000–5009 schlägt Dienstplan
 *     (personnelCostActual wird entfernt).
 * VJ-Umsatz + Budget werden separat behandelt.
 */
export function applyCanonicalIstRule(
  rec: MonthlyFinancialRecord,
  month: number,
  deps: CanonicalIstDeps,
): MonthlyFinancialRecord {
  let r = rec;
  const { year, canonical, takeawayMonthly, net } = deps;

  if (!hasIndividualRevenueAccounts(r)) {
    const mm = String(month).padStart(2, '0');
    const um = canonical[month];
    if (um?.hasData) {
      const base = net ? um.net : um.gross;
      const istRev = Math.round(base * 100) / 100;
      if (istRev > 0) {
        const taMonthly = takeawayMonthly?.[`${year}-${mm}`] ?? 0;
        if (taMonthly > 0) {
          // Kto. 3000/3010 aufteilen: Netto = direkt; Brutto = Netto × 1.026
          const kto3010 = net ? taMonthly : Math.round(taMonthly * 1.026 * 100) / 100;
          const kto3000 = istRev - kto3010;
          r = {
            ...r,
            revenueActual: istRev,
            expenseCategories: [
              ...r.expenseCategories,
              { categoryId: '3000', amount: kto3000, label: net ? 'Betriebsertrag Netto' : 'Betriebsertrag Brutto' },
              { categoryId: '3010', amount: kto3010, label: 'Take-Away Umsatz' },
            ],
          };
        } else {
          r = { ...r, revenueActual: istRev };
        }
      }
    }
  }

  // Personalkosten: Buchhaltung (5000–5009) hat Vorrang vor Dienstplan.
  if (hasAccountingWageAccounts(r) && r.personnelCostActual !== undefined) {
    r = { ...r, personnelCostActual: undefined };
  }
  return r;
}

/** Hat der Record individuelle Sage-Umsatzkonten (3xxx) im VORJAHR (PY-Spalte)? */
export function hasIndividualPYRevenueAccounts(rec: MonthlyFinancialRecord): boolean {
  return (rec.expenseCategoriesPreviousYear ?? []).some(c => {
    const n = parseInt(c.categoryId);
    return !isNaN(n) && n >= 3000 && n <= 3999;
  });
}

export interface VjRevenueDeps {
  /** Geschäftsjahr des Records (VJ = year − 1) */
  year: number;
  /** Tagesumsätze (tenant-Blob "dailyBudgets", jahresübergreifend) */
  dailyBudgets: Record<string, DailyEntry>;
  /** Exakte VJ-Tageswerte aus Supabase (loadVjDailyYear(year−1)); leer = nur Blob-Fallbacks */
  vjDaily: Record<string, VjDayRecord>;
  /** reporting_v1-Record des ECHTEN Vorjahres (loadMonth(year−1, month)) — Fallback-Quelle */
  prevYearRecord?: MonthlyFinancialRecord;
}

/**
 * VJ-Umsatz-Regel der Erfolgsrechnung (extrahiert aus PLView.effectiveAllRecords):
 * setzt `revenuePreviousYear` auf den Tagesansicht-VJ-NETTO-Wert
 * (computeMonthlyVjNet), AUSSER es sind individuelle 3xxx-PY-Konten vorhanden.
 * Fallback: revenueActual des Vorjahres-Records, wenn weder Tagesansicht-VJ
 * noch ein bestehender revenuePreviousYear-Wert existiert.
 */
export function applyVjRevenueRule(
  rec: MonthlyFinancialRecord,
  month: number,
  deps: VjRevenueDeps,
): MonthlyFinancialRecord {
  let r = rec;
  if (!hasIndividualPYRevenueAccounts(r)) {
    const tagesansichtVj = computeMonthlyVjNet(deps.year, month, deps.dailyBudgets, deps.vjDaily);
    if (tagesansichtVj > 0) {
      r = { ...r, revenuePreviousYear: tagesansichtVj };
    } else if (!r.revenuePreviousYear) {
      const prevActual = deps.prevYearRecord?.revenueActual;
      if (prevActual) r = { ...r, revenuePreviousYear: prevActual };
    }
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
