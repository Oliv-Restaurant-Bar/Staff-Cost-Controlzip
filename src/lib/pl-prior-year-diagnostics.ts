/**
 * Vorjahres-Diagnose für die Erfolgsrechnung (P&L).
 *
 * Reine Logik (KEIN Supabase / KEIN DOM) – arbeitet ausschliesslich auf den
 * bereits geladenen Vorjahresdaten:
 *   1. `prevYearRecords` – die 12 Monats-Datensätze des Vorjahres aus `reporting_v1`
 *      (geladen via `loadYear(year - 1)`).
 *   2. `vjDailyData` – die Tages-Vorjahresumsätze aus Supabase
 *      (geladen via `loadVjDailyYear(year - 1)`).
 *
 * Sie verändert KEINE Berechnungen und erfindet KEINE Werte – sie macht nur
 * sichtbar, ob (und welche) Vorjahresdaten vorhanden sind, damit klar wird,
 * warum die Vorjahres-Spalten leer bleiben.
 */
import type { MonthlyFinancialRecord } from '@/types/reporting';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

export type PriorYearDataStatus = 'ok' | 'revenue_only' | 'none';

export interface PriorYearDiagnostics {
  /** Das geprüfte Vorjahr (z.B. 2024, wenn 2025 gewählt ist). */
  priorYear: number;
  /** reporting_v1 enthält mind. einen Vorjahres-Monat mit echten Ist-Daten. */
  hasMonthlyRecords: boolean;
  /** Mind. ein Vorjahres-Monat hat `revenueActual` > 0. */
  hasRevenue: boolean;
  /** Mind. ein Vorjahres-Monat hat Kontowerte in `expenseCategories`. */
  hasExpenses: boolean;
  /** Mind. ein Vorjahres-Monat hat `personnelCostActual` > 0. */
  hasPersonnel: boolean;
  /** Es existieren Tages-Vorjahresumsätze (vj_daily) > 0. */
  hasDailyRevenue: boolean;
  /** Umsatz aus Monats- ODER Tagesdaten vorhanden. */
  hasAnyRevenue: boolean;
  /** Kosten (Aufwand ODER Personal) vorhanden. */
  hasAnyCosts: boolean;
  /** Irgendwelche Vorjahresdaten vorhanden. */
  hasAnyData: boolean;
  /** Zusammenfassender Status. */
  status: PriorYearDataStatus;
  /** Deutscher Hinweis für die UI; `null` wenn Status `'ok'`. */
  message: string | null;
}

/**
 * Berechnet die Vorjahres-Diagnose aus den bereits geladenen Daten.
 *
 * @param priorYear        Das Vorjahr (üblicherweise `selectedYear - 1`).
 * @param prevYearRecords  Vorjahres-Monatsdatensätze (aus `loadYear(priorYear)`).
 * @param vjDailyData      Tages-Vorjahresumsätze (aus `loadVjDailyYear(priorYear)`),
 *                         Map mit Datums-Keys "YYYY-MM-DD".
 */
export function computePriorYearDiagnostics(
  priorYear: number,
  prevYearRecords: MonthlyFinancialRecord[] | undefined | null,
  vjDailyData: Record<string, VjDayRecord> | undefined | null,
): PriorYearDiagnostics {
  const recs = prevYearRecords ?? [];

  const hasRevenue = recs.some(r => (r?.revenueActual ?? 0) > 0);
  const hasExpenses = recs.some(r =>
    (r?.expenseCategories ?? []).some(c => Math.abs(c?.amount ?? 0) > 0),
  );
  const hasPersonnel = recs.some(r => (r?.personnelCostActual ?? 0) > 0);

  const prefix = `${priorYear}-`;
  const hasDailyRevenue = Object.entries(vjDailyData ?? {}).some(
    ([key, rec]) =>
      (key.startsWith(prefix) || rec?.year === priorYear) &&
      (rec?.actualRevenue ?? 0) > 0,
  );

  const hasMonthlyRecords = hasRevenue || hasExpenses || hasPersonnel;
  const hasAnyRevenue = hasRevenue || hasDailyRevenue;
  const hasAnyCosts = hasExpenses || hasPersonnel;
  const hasAnyData = hasAnyRevenue || hasAnyCosts;

  let status: PriorYearDataStatus;
  let message: string | null;
  if (!hasAnyData) {
    status = 'none';
    message = `Keine Vorjahresdaten für ${priorYear} vorhanden. Bitte Vorjahres-Kontoblätter oder Vorjahreswerte importieren.`;
  } else if (hasAnyRevenue && !hasAnyCosts) {
    status = 'revenue_only';
    message = 'Vorjahresumsatz vorhanden, aber keine Vorjahreskosten vorhanden.';
  } else {
    status = 'ok';
    message = null;
  }

  return {
    priorYear,
    hasMonthlyRecords,
    hasRevenue,
    hasExpenses,
    hasPersonnel,
    hasDailyRevenue,
    hasAnyRevenue,
    hasAnyCosts,
    hasAnyData,
    status,
    message,
  };
}
