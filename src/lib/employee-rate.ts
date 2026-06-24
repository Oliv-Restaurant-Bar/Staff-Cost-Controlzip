// ── Effektiver Stundenansatz eines Mitarbeiters (pure) ───────────────────────
// Zentrale, pure Quelle der Wahrheit für den "berechneten Stundenkostensatz".
// Wird sowohl in der Dienstplan-/Ist-Stunden-Ansicht als auch in der
// Überstundenauswertung verwendet. KEIN React/Supabase/DOM hier.
import type { Employee } from '@/types/personnel';
import { calcML, LGAV } from '@/lib/salaryCalc';

// Priorität: 1) hourlyWage > 0  2) Monatslohn → L-GAV interner Stundenansatz  3) null
export function getEffectiveHourlyRate(emp: Employee): number | null {
  if (emp.hourlyWage && emp.hourlyWage > 0) return emp.hourlyWage;
  const base = emp.monthlySalary || 0;
  if (base > 0) {
    const ml = calcML(
      base,
      emp.has13thSalary ?? false,
      emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME,
      1.13,
    );
    return ml.internalHourlyCost;
  }
  return null;
}

// Wage source label (for display)
export function getWageLabel(emp: Employee): string {
  if (emp.hourlyWage && emp.hourlyWage > 0) return `${emp.hourlyWage.toFixed(2)} CHF/h`;
  if (emp.monthlySalary && emp.monthlySalary > 0) {
    const rate = getEffectiveHourlyRate(emp);
    return rate != null ? `ML ~${rate.toFixed(2)} CHF/h` : 'Monatslohn';
  }
  return 'Lohn fehlt';
}
