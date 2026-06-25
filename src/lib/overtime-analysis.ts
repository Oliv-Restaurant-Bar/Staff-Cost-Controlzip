// ─────────────────────────────────────────────────────────────────────────────
// Überstundenauswertung für Festangestellte (pure)
// ─────────────────────────────────────────────────────────────────────────────
// Berechnet Überstunden NUR für festangestellte Mitarbeiter (fixer Monatslohn)
// aus den produktiven Ist-Stunden. Überstunden werden AUSSCHLIESSLICH auf
// Wochenbasis ermittelt:
//   effektiveÜberstunden je (Mitarbeiter, ISO-Woche)
//     = max(0, produktive Wochen-Ist-Stunden − Wochensoll)
// Das Wochensoll ist pensumabhängig: 42 h × Pensum (= die vertraglichen
// Wochenstunden `weeklyHours`; fehlt der Wert → 42 h = 100 %). Beispiele:
//   100 % → 42.0 h, 80 % → 33.6 h, 50 % → 21.0 h.
//
// WICHTIG (Korrektur): Tage über 8.4 h erzeugen KEINE Überstunden mehr, solange
// die Wochensumme das Wochensoll nicht überschreitet. Beispiel: 33.07 h in einer
// Woche → 0.00 h Überstunden, auch wenn einzelne Tage über 8.4 h liegen. Die
// 8.4-h-Tagesgrenze dient nur noch der INFORMATIVEN Tages-Aufschlüsselung
// ("Tage über 8.4h, nur Info") und fliesst NICHT in die Überstundenkosten ein.
//
// Kosten = Überstunden × bestehendem berechnetem Stundenkostensatz
// (getEffectiveHourlyRate). Es werden KEINE Sätze erfunden. Da nur
// Festangestellte mit fixem Monatslohn einbezogen werden (siehe
// isFixedSalaryEmployee), liefert getEffectiveHourlyRate praktisch immer einen
// Satz; die null-Behandlung (Stunden ausgewiesen, Kosten "nicht verfügbar")
// bleibt nur als defensive Absicherung erhalten.
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

/**
 * Tagesgrenze — NUR informativ. Tage über diesem Wert werden in der
 * Tages-Aufschlüsselung als „Tage über 8.4h, nur Info" angezeigt, erzeugen aber
 * KEINE Überstunden(-kosten). Überstunden werden ausschliesslich wöchentlich
 * gegen das pensumabhängige Wochensoll berechnet.
 */
export const DAILY_OVERTIME_THRESHOLD = 8.4;
/** Wochensoll bei 100 % Pensum (Vollzeit). Pro Mitarbeiter via Pensum skaliert. */
export const WEEKLY_FULLTIME_TARGET = 42;
/** @deprecated Alias für das Vollzeit-Wochensoll (100 %). Nutze WEEKLY_FULLTIME_TARGET. */
export const WEEKLY_OVERTIME_THRESHOLD = WEEKLY_FULLTIME_TARGET;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Pensumabhängiges Wochensoll eines Festangestellten = 42 h × Pensum.
 * Im Datenmodell sind die vertraglichen Wochenstunden `weeklyHours` bereits
 * das Produkt „42 × Pensum" (100 % → 42, 80 % → 33.6, 50 % → 21). Fehlt der
 * Wert (oder ≤ 0), wird Vollzeit (42 h = 100 %) angenommen.
 */
export function weeklyTargetHours(emp: Employee): number {
  const wh = emp.weeklyHours;
  return typeof wh === 'number' && wh > 0 ? round2(wh) : WEEKLY_FULLTIME_TARGET;
}

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
  /**
   * max(0, actualHours - 8.4). NUR informativ („Tage über 8.4h, nur Info") —
   * fliesst NICHT in die Überstundenberechnung/-kosten ein.
   */
  dailyOvertime: number;
}

/** Wochen-Detail (für die Wochen-Aufschlüsselung). */
export interface OvertimeWeek {
  isoYear: number;
  isoWeek: number;
  weekKey: string; // `${isoYear}-W${isoWeek}`
  weekHours: number; // Summe produktiver Ist-Stunden in dieser Woche (Wochen-Ist)
  /** Pensumabhängiges Wochensoll (42 h × Pensum) für diese Woche/diesen MA */
  targetHours: number;
  /**
   * Summe der Tages-Überstunden (Tage über 8.4h) — NUR informativ, fliesst
   * NICHT in effectiveOvertime/Kosten ein.
   */
  dailyOvertimeSum: number;
  /** max(0, weekHours - targetHours) — die einzig massgebliche Überstundenzahl */
  weeklyOvertime: number;
  /** = weeklyOvertime (Tages-Überstunden werden bewusst NICHT mehr einbezogen) */
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
    const targetHours = weeklyTargetHours(emp);

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

      // Überstunden ausschliesslich wöchentlich gegen das pensumabhängige
      // Wochensoll (42 × Pensum). Tages-Überstunden (dailyOvertimeSum) sind nur
      // informativ und fliessen bewusst NICHT mehr ein (keine Doppel-/Über-
      // bewertung langer Einzeltage bei unterschrittenem Wochensoll).
      const weeklyOvertime = round2(Math.max(0, weekHours - targetHours));
      const effectiveOvertime = weeklyOvertime;
      const cost = rateAvailable ? round2(effectiveOvertime * (rate as number)) : null;

      weeks.push({
        isoYear: w.isoYear,
        isoWeek: w.isoWeek,
        weekKey,
        weekHours,
        targetHours,
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
