// ── Effektiver Arbeitgeber-Stundenansatz eines Mitarbeiters (pure) ───────────
// Zentrale, pure Quelle der Wahrheit für den "berechneten Stundenkostensatz".
// Wird in Dienstplan-/Ist-Stunden-Ansichten, Kennzahlen und der Überstunden-
// auswertung verwendet. KEIN React/Supabase/DOM hier — die zentralen
// AG-Sozialkostensätze werden IMMER als Parameter übergeben (useSocialCostRates).
//
// Personalaufwand = Bruttolohn + AG-Sozialkosten:
//  - SL: Brutto = auszahlbarer Stundenlohn inkl. Ferien-/Feiertagsentschädigung
//        und 13. (calcSL.totalPayableHourly) — NICHT der rohe Vertragslohn.
//  - ML: Brutto = effektiver Monatslohn inkl. 13. ÷ 182 h (L-GAV).
// Der frühere per-Mitarbeiter-socialCostFactor ist abgelöst (Hard-Cut).
import type { Employee } from '@/types/personnel';
import { calcML, calcSL, LGAV } from '@/lib/salaryCalc';
import { socialCostFactorFromRates, type SocialCostRates } from '@/lib/social-costs';

export interface EmployerRateBreakdown {
  /** Brutto-Stundenlohn (auszahlbar, inkl. Zuschlägen bzw. 13.) */
  grossHourly: number;
  /** AG-Sozialkosten pro Stunde */
  socialHourly: number;
  /** Total Arbeitgeberkosten pro Stunde (= gross + social) */
  totalHourly: number;
  /** Lohnbasis: Stundenlohn (sl) oder Monatslohn (ml) */
  source: 'sl' | 'ml';
}

/**
 * Vollständiger AG-Stundenkosten-Breakdown.
 * Priorität: 1) hourlyWage > 0 → SL  2) Monatslohn → ML  3) null (Lohn fehlt).
 */
export function getEmployerCostRate(emp: Employee, rates: SocialCostRates): EmployerRateBreakdown | null {
  const factor = socialCostFactorFromRates(rates);
  if (emp.hourlyWage && emp.hourlyWage > 0) {
    const sl = calcSL(emp.hourlyWage, emp.has13thSalary ?? false, factor);
    return {
      grossHourly: sl.totalPayableHourly,
      socialHourly: sl.socialCostPerHour,
      totalHourly: sl.internalHourlyCost,
      source: 'sl',
    };
  }
  const base = emp.monthlySalary || 0;
  if (base > 0) {
    const ml = calcML(
      base,
      emp.has13thSalary ?? false,
      emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME,
      factor,
    );
    return {
      grossHourly: ml.effectiveMonthlyGross / LGAV.MONTHLY_HOURS,
      socialHourly: ml.socialCostMonthly / LGAV.MONTHLY_HOURS,
      totalHourly: ml.internalHourlyCost,
      source: 'ml',
    };
  }
  return null;
}

/**
 * Effektiver Stundenansatz = Total Arbeitgeberkosten pro Stunde.
 * Drop-in-Nachfolger des alten getEffectiveHourlyRate(emp) — die zentralen
 * Sätze sind jetzt Pflicht-Parameter, damit KEINE Call-Site still auf einer
 * alten Basis (roher Stundenlohn / hardcoded 1.13) weiterrechnet.
 */
export function getEffectiveHourlyRate(emp: Employee, rates: SocialCostRates): number | null {
  return getEmployerCostRate(emp, rates)?.totalHourly ?? null;
}

// Wage source label (for display) — zeigt den VERTRAGSLOHN (nicht AG-Kosten).
export function getWageLabel(emp: Employee, rates: SocialCostRates): string {
  if (emp.hourlyWage && emp.hourlyWage > 0) return `${emp.hourlyWage.toFixed(2)} CHF/h`;
  if (emp.monthlySalary && emp.monthlySalary > 0) {
    const rate = getEffectiveHourlyRate(emp, rates);
    return rate != null ? `ML ~${rate.toFixed(2)} CHF/h` : 'Monatslohn';
  }
  return 'Lohn fehlt';
}
