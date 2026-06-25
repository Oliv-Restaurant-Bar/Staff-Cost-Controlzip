// ─────────────────────────────────────────────────────────────────────────────
// Überstundenauswertung für Festangestellte (pure)
// ─────────────────────────────────────────────────────────────────────────────
// Berechnet Überstunden NUR für festangestellte Mitarbeiter (fixer Monatslohn)
// aus den Ist-Stunden. Überstunden = Ist-Stunden über
//   - 8.4 h pro Tag   ODER
//   - 42  h pro Woche (ISO-Woche)
// Kosten = Überstunden × bestehendem berechnetem Stundenkostensatz
// (getEffectiveHourlyRate). Es werden KEINE Sätze erfunden. Da nur
// Festangestellte mit fixem Monatslohn einbezogen werden (siehe
// isFixedSalaryEmployee), liefert getEffectiveHourlyRate praktisch immer einen
// Satz; die null-Behandlung (Stunden ausgewiesen, Kosten "nicht verfügbar")
// bleibt nur als defensive Absicherung erhalten.
//
// Doppelzählung wird vermieden: pro (Mitarbeiter, ISO-Woche) gilt
//   effektiveÜberstunden = max( Summe Tages-Überstunden , Wochen-Überstunden )
// — also der GRÖSSERE der beiden Werte, nicht die Summe beider.
//
// Stündliche/flexible Mitarbeiter (minijob/aushilfe ODER ohne fixen Monatslohn)
// sind ausgeschlossen — sie werden bereits über ihre Ist-Stunden abgerechnet und
// dürfen nicht erneut als Überstunden-Zusatzkosten gezählt werden. Festangestellt
// = vollzeit/teilzeit MIT monthlySalary > 0 (siehe isFixedSalaryEmployee).
//
// KEIN React / Supabase / DOM. date-fns wird nur für die ISO-Wochen-Logik
// genutzt (pure). Eingabedaten sind bereits mandanten-/zeitraum-gefiltert.
// ─────────────────────────────────────────────────────────────────────────────
import { getISOWeek, getISOWeekYear } from 'date-fns';
import type { Employee, Department } from '@/types/personnel';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';

export const DAILY_OVERTIME_THRESHOLD = 8.4;
export const WEEKLY_OVERTIME_THRESHOLD = 42;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Eine Ist-Stunden-Position pro Mitarbeiter und Tag. */
export interface OvertimeHoursEntry {
  employeeId: string;
  date: string; // YYYY-MM-DD
  hours: number; // tatsächlich gearbeitete Stunden an diesem Tag
  /**
   * Abwesenheitscode (FE/K/U/…). Ist er gesetzt, ist der Eintrag KEINE
   * produktive Arbeitszeit (Ferien/Krankheit/Unfall) und wird NICHT als
   * Überstunde gezählt — sonst würden z.B. Ferientage über die 42h/Woche
   * drücken und falsche Überstundenkosten erzeugen. Gleiche Semantik wie das
   * Grid: produktiv = hours > 0 && !absenceType.
   */
  absenceType?: string | null;
}

/** Tages-Detail innerhalb einer Woche (für die Tages-Aufschlüsselung). */
export interface OvertimeDay {
  date: string;
  isoYear: number;
  isoWeek: number;
  actualHours: number;
  /** max(0, actualHours - 8.4) */
  dailyOvertime: number;
}

/** Wochen-Detail (für die Wochen-Aufschlüsselung). */
export interface OvertimeWeek {
  isoYear: number;
  isoWeek: number;
  weekKey: string; // `${isoYear}-W${isoWeek}`
  weekHours: number; // Summe Ist-Stunden in dieser Woche (im gelieferten Zeitraum)
  dailyOvertimeSum: number; // Summe der Tages-Überstunden in dieser Woche
  weeklyOvertime: number; // max(0, weekHours - 42)
  /** max(dailyOvertimeSum, weeklyOvertime) — vermeidet Doppelzählung */
  effectiveOvertime: number;
  /** effectiveOvertime × Stundensatz; null wenn Satz nicht verfügbar */
  cost: number | null;
  days: OvertimeDay[];
}

/** Ergebnis pro festangestelltem Mitarbeiter mit Überstunden. */
export interface EmployeeOvertimeResult {
  employeeId: string;
  name: string;
  department: Department;
  /** Berechneter Stundenkostensatz (null = nicht verfügbar) */
  hourlyRate: number | null;
  rateAvailable: boolean;
  /** Summe der wöchentlich effektiven Überstunden im Zeitraum */
  overtimeHours: number;
  /** Summe der Überstundenkosten; null wenn der Satz fehlt (Stunden trotzdem da) */
  overtimeCost: number | null;
  weeks: OvertimeWeek[];
  /** Nur Tage mit Tages-Überstunden (>0), sortiert nach Datum */
  days: OvertimeDay[];
}

export interface OvertimeAnalysis {
  /** Nur festangestellte Mitarbeiter mit Überstunden (>0), sortiert nach Stunden absteigend */
  employees: EmployeeOvertimeResult[];
  totalOvertimeHours: number;
  /** Summe nur der verfügbaren Kosten (Mitarbeiter mit Satz) */
  totalOvertimeCost: number;
  affectedEmployeeCount: number;
  /** true, wenn mindestens ein betroffener Mitarbeiter keinen Stundensatz hat */
  hasUnavailableRates: boolean;
}

export interface OvertimeAnalysisInput {
  employees: Employee[];
  entries: OvertimeHoursEntry[];
  /** Abteilungsfilter; 'all'/undefined = alle Abteilungen */
  departmentFilter?: Department | 'all';
}

/**
 * Ob der Mitarbeiter festangestellt ist (= fixer Monatslohn, NICHT stündlich
 * abgerechnet). Es müssen BEIDE Bedingungen erfüllt sein:
 *   1) Anstellungsart vollzeit | teilzeit (minijob/aushilfe = stündlich), UND
 *   2) ein hinterlegter fixer Monatslohn (monthlySalary > 0).
 *
 * Die zweite Bedingung ist die robuste zweite Sicherheitsschicht: stündliche,
 * flexible bzw. Aushilfs-Mitarbeiter — auch solche, die fälschlich als
 * vollzeit/teilzeit erfasst sind, aber KEINEN fixen Monatslohn haben — werden
 * von der Überstundenauswertung ausgeschlossen. Überstunden(-kosten) sind nur
 * für Festangestellte mit fixem Monatslohn definiert; Stündliche werden bereits
 * über ihre Ist-Stunden abgerechnet. Deckt sich mit `hasFixedSalary` in
 * PersonalFix.tsx (gleiche Semantik).
 */
export function isFixedSalaryEmployee(emp: Employee): boolean {
  return (emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
    && (emp.monthlySalary ?? 0) > 0;
}

function isoWeekInfoFor(dateStr: string): { isoYear: number; isoWeek: number } {
  const d = new Date(dateStr + 'T00:00:00');
  return { isoYear: getISOWeekYear(d), isoWeek: getISOWeek(d) };
}

/**
 * Berechnet die Überstundenauswertung für festangestellte Mitarbeiter.
 *
 * - Stündliche Mitarbeiter werden ignoriert.
 * - Abteilungsfilter wird respektiert.
 * - Wochen werden anhand der ISO-Woche der GELIEFERTEN Einträge gruppiert
 *   (Wochen, die über den geladenen Zeitraum hinausragen, werden mit den
 *   vorhandenen Tagen berechnet — bewusste, dokumentierte Zeitraum-Grenze).
 */
export function computeOvertimeAnalysis(input: OvertimeAnalysisInput): OvertimeAnalysis {
  const { employees, entries, departmentFilter } = input;
  const dept = departmentFilter ?? 'all';

  // Nur festangestellte, ggf. abteilungsgefilterte Mitarbeiter
  const fixedById = new Map<string, Employee>();
  for (const emp of employees) {
    if (!isFixedSalaryEmployee(emp)) continue;
    if (dept !== 'all' && emp.department !== dept) continue;
    fixedById.set(emp.id, emp);
  }

  // Einträge pro Mitarbeiter → pro ISO-Woche → pro Tag aggregieren.
  // (Mehrere Einträge pro Tag werden summiert.)
  interface DayAcc { date: string; isoYear: number; isoWeek: number; hours: number; }
  // employeeId → weekKey → { isoYear, isoWeek, days: Map<date, DayAcc> }
  const perEmp = new Map<string, Map<string, { isoYear: number; isoWeek: number; days: Map<string, DayAcc> }>>();

  for (const e of entries) {
    if (!fixedById.has(e.employeeId)) continue;
    if (!e.date || !Number.isFinite(e.hours) || e.hours <= 0) continue;
    if (e.absenceType) continue; // Abwesenheiten (FE/K/U/…) sind keine Überstunden
    const { isoYear, isoWeek } = isoWeekInfoFor(e.date);
    const weekKey = `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;

    let weeks = perEmp.get(e.employeeId);
    if (!weeks) { weeks = new Map(); perEmp.set(e.employeeId, weeks); }
    let week = weeks.get(weekKey);
    if (!week) { week = { isoYear, isoWeek, days: new Map() }; weeks.set(weekKey, week); }
    const existing = week.days.get(e.date);
    if (existing) existing.hours += e.hours;
    else week.days.set(e.date, { date: e.date, isoYear, isoWeek, hours: e.hours });
  }

  const results: EmployeeOvertimeResult[] = [];

  for (const [empId, weeksMap] of perEmp) {
    const emp = fixedById.get(empId)!;
    const rate = getEffectiveHourlyRate(emp);
    const rateAvailable = rate != null;

    const weeks: OvertimeWeek[] = [];
    const overtimeDays: OvertimeDay[] = [];
    let empOvertimeHours = 0;
    let empOvertimeCost = 0;

    // Wochen stabil nach weekKey sortieren
    const sortedWeekKeys = Array.from(weeksMap.keys()).sort();
    for (const weekKey of sortedWeekKeys) {
      const w = weeksMap.get(weekKey)!;
      const dayAccs = Array.from(w.days.values()).sort((a, b) => a.date.localeCompare(b.date));

      let weekHours = 0;
      let dailyOvertimeSum = 0;
      const days: OvertimeDay[] = [];
      for (const d of dayAccs) {
        const actualHours = round2(d.hours);
        const dailyOvertime = round2(Math.max(0, actualHours - DAILY_OVERTIME_THRESHOLD));
        weekHours = round2(weekHours + actualHours);
        dailyOvertimeSum = round2(dailyOvertimeSum + dailyOvertime);
        const od: OvertimeDay = { date: d.date, isoYear: d.isoYear, isoWeek: d.isoWeek, actualHours, dailyOvertime };
        days.push(od);
        if (dailyOvertime > 0) overtimeDays.push(od);
      }

      const weeklyOvertime = round2(Math.max(0, weekHours - WEEKLY_OVERTIME_THRESHOLD));
      const effectiveOvertime = round2(Math.max(dailyOvertimeSum, weeklyOvertime));
      const cost = rateAvailable ? round2(effectiveOvertime * (rate as number)) : null;

      weeks.push({
        isoYear: w.isoYear,
        isoWeek: w.isoWeek,
        weekKey,
        weekHours,
        dailyOvertimeSum,
        weeklyOvertime,
        effectiveOvertime,
        cost,
        days,
      });

      empOvertimeHours = round2(empOvertimeHours + effectiveOvertime);
      if (rateAvailable && cost != null) empOvertimeCost = round2(empOvertimeCost + cost);
    }

    if (empOvertimeHours <= 0) continue; // keine Überstunden → nicht betroffen

    results.push({
      employeeId: empId,
      name: emp.name,
      department: emp.department,
      hourlyRate: rate,
      rateAvailable,
      overtimeHours: empOvertimeHours,
      overtimeCost: rateAvailable ? empOvertimeCost : null,
      weeks,
      days: overtimeDays.sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  // Sortierung: meiste Überstunden zuerst, dann Name
  results.sort((a, b) => b.overtimeHours - a.overtimeHours || a.name.localeCompare(b.name));

  const totalOvertimeHours = round2(results.reduce((s, r) => s + r.overtimeHours, 0));
  const totalOvertimeCost = round2(
    results.reduce((s, r) => s + (r.overtimeCost ?? 0), 0),
  );
  const hasUnavailableRates = results.some((r) => !r.rateAvailable);

  return {
    employees: results,
    totalOvertimeHours,
    totalOvertimeCost,
    affectedEmployeeCount: results.length,
    hasUnavailableRates,
  };
}

// ─── Totals / PKQ mit Überstunden-Toggle ─────────────────────────────────────

export interface OvertimeTotals {
  regularCost: number;
  overtimeCost: number;
  /** = regularCost */
  totalExclOvertime: number;
  /** = regularCost + overtimeCost */
  totalInclOvertime: number;
  netRevenue: number;
  /** regularCost / netRevenue × 100 (null wenn netRevenue ≤ 0) */
  pkqExclOvertime: number | null;
  /** (regularCost + overtimeCost) / netRevenue × 100 (null wenn netRevenue ≤ 0) */
  pkqInclOvertime: number | null;
  /** Je nach Toggle aktiver Gesamtwert */
  effectiveTotal: number;
  /** Je nach Toggle aktive PKQ */
  effectivePkq: number | null;
}

function safeQuote(cost: number, netRevenue: number): number | null {
  if (!(netRevenue > 0)) return null;
  return round2((cost / netRevenue) * 100);
}

/**
 * Kombiniert reguläre Personalkosten und Überstunden-Zusatzkosten zu den
 * vier auszuweisenden Werten (regulär / Überstunden / Total exkl. / Total inkl.)
 * inklusive PKQ. `includeOvertime` steuert den effektiven Gesamtwert + PKQ:
 *   true  → Überstunden fliessen in Total + PKQ ein
 *   false → Überstunden werden separat ausgewiesen, aber NICHT in Total/PKQ
 */
export function computeOvertimeTotals(
  regularCost: number,
  overtimeCost: number,
  netRevenue: number,
  includeOvertime: boolean,
): OvertimeTotals {
  const reg = round2(regularCost);
  const ot = round2(overtimeCost);
  const totalExclOvertime = reg;
  const totalInclOvertime = round2(reg + ot);
  const pkqExclOvertime = safeQuote(totalExclOvertime, netRevenue);
  const pkqInclOvertime = safeQuote(totalInclOvertime, netRevenue);

  return {
    regularCost: reg,
    overtimeCost: ot,
    totalExclOvertime,
    totalInclOvertime,
    netRevenue,
    pkqExclOvertime,
    pkqInclOvertime,
    effectiveTotal: includeOvertime ? totalInclOvertime : totalExclOvertime,
    effectivePkq: includeOvertime ? pkqInclOvertime : pkqExclOvertime,
  };
}
