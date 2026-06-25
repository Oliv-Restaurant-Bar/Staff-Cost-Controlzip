// ─────────────────────────────────────────────────────────────────────────────
// Überstundenauswertung für Festangestellte (pure)
// ─────────────────────────────────────────────────────────────────────────────
// Berechnet Überstunden NUR für festangestellte Mitarbeiter (fixer Monatslohn)
// aus den produktiven Ist-Stunden. Überstunden werden AUSSCHLIESSLICH auf
// MONATSBASIS ermittelt:
//   Überstunden je Mitarbeiter
//     = max(0, produktive Monats-Ist-Stunden − Monatssoll)
//
// Das Monatssoll ist pensum- und monatslängenabhängig:
//   Monatssoll = 42 h × Anzahl Wochen im Monat × Pensum
// Die „Anzahl Wochen im Monat" wird stetig als (Tage im Monat ÷ 7) angesetzt
// (dokumentierte Annahme, leicht änderbar). Da 42 ÷ 7 = 6 ergibt sich bei 100 %
// das saubere Monatssoll = 6 × Tage im Monat (30 Tage → 180 h, 31 → 186 h,
// 28 → 168 h). Das Pensum entspricht den vertraglichen Wochenstunden
// `weeklyHours` (bereits „42 × Pensum"; fehlt der Wert → 42 h = 100 %):
//   100 % → ×1.0, 80 % → ×0.8, 50 % → ×0.5.
//
// WICHTIG: Tage über 8.4 h erzeugen KEINE Überstunden. Die 8.4-h-Tagesgrenze
// dient nur noch der INFORMATIVEN Anzeige (Anzahl Tage über 8.4 h) und fliesst
// NICHT in die Überstundenberechnung/-kosten ein.
//
// Abwesenheiten (FE/K/U/…) sind keine produktive Arbeitszeit und werden NICHT
// gezählt — sonst würden Ferien-/Kranktage über das Monatssoll drücken und
// falsche Überstunden erzeugen (gleiche Semantik wie Grid: produktiv =
// hours > 0 && !absenceType).
//
// Manuelle Zusatzkosten-Tage (isAdditionalCost) werden ebenfalls NICHT als
// produktive Überstunden-Stunden gezählt: sie sind im regulären Personalkosten-
// Total (pfix.month.istTotal enthält zusatzIstCHF) bereits enthalten — eine
// erneute Zählung als Überstunden wäre eine Doppelverrechnung. Sie werden
// stattdessen SEPARAT pro Mitarbeiter als Zusatzkosten ausgewiesen
// (additionalCost / additionalCostHours / additionalCostDays — reine Anzeige).
//
// Kosten = Überstunden × bestehendem berechnetem Stundenkostensatz
// (getEffectiveHourlyRate). Es werden KEINE Sätze erfunden. Stündliche/flexible
// Mitarbeiter (minijob/aushilfe ODER ohne fixen Monatslohn) sind ausgeschlossen.
//
// Pro Mitarbeiter kann die Überstundenberechnung dauerhaft deaktiviert werden
// (disabledEmployeeIds): dann sind overtimeHours = 0 und overtimeCost = 0
// (Soll/Ist/Differenz bleiben zur Transparenz erhalten).
//
// KEIN React / Supabase / DOM. Eingabedaten sind bereits mandanten-/
// zeitraum-gefiltert (alle Einträge gehören zum selben Monat).
// ─────────────────────────────────────────────────────────────────────────────
import type { Employee, Department } from '@/types/personnel';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';

/**
 * Tagesgrenze — NUR informativ. Tage über diesem Wert werden als „Tage über
 * 8.4h (nur Info)" gezählt, erzeugen aber KEINE Überstunden(-kosten).
 */
export const DAILY_OVERTIME_THRESHOLD = 8.4;
/** Wochensoll bei 100 % Pensum (Vollzeit). Basis für das Monatssoll. */
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

/**
 * Pensum in Prozent (für die Anzeige), abgeleitet aus dem Wochensoll.
 * 42 h → 100, 33.6 h → 80, 21 h → 50. Fehlt `weeklyHours` → 100.
 */
export function workloadPercent(emp: Employee): number {
  return round2((weeklyTargetHours(emp) / WEEKLY_FULLTIME_TARGET) * 100);
}

/**
 * Monatssoll = 42 h × (Tage im Monat ÷ 7) × Pensum.
 * Äquivalent zu weeklyTargetHours(emp) × Tage ÷ 7. `daysInMonth` ist die Anzahl
 * Kalendertage des gewählten Monats (z.B. 30/31/28/29).
 */
export function monthlyTargetHours(emp: Employee, daysInMonth: number): number {
  const days = Number.isFinite(daysInMonth) && daysInMonth > 0 ? daysInMonth : 0;
  return round2((weeklyTargetHours(emp) * days) / 7);
}

/** Eine Ist-Stunden-Position pro Mitarbeiter und Tag. */
export interface OvertimeHoursEntry {
  employeeId: string;
  date: string; // YYYY-MM-DD
  hours: number; // tatsächlich gearbeitete Stunden an diesem Tag
  /**
   * Abwesenheitscode (FE/K/U/…). Ist er gesetzt, ist der Eintrag KEINE
   * produktive Arbeitszeit und wird vollständig ignoriert.
   */
  absenceType?: string | null;
  /**
   * true = manueller Zusatzkosten-Tag eines Festangestellten. Diese Stunden
   * zählen NICHT als produktive Überstunden-Stunden (sie sind bereits im
   * regulären Personalkosten-Total enthalten), werden aber separat als
   * Zusatzkosten pro Mitarbeiter ausgewiesen.
   */
  isAdditionalCost?: boolean;
}

/** Ergebnis pro festangestelltem Mitarbeiter. */
export interface EmployeeOvertimeResult {
  employeeId: string;
  name: string;
  department: Department;
  /** Berechneter Stundenkostensatz (null = nicht verfügbar) */
  hourlyRate: number | null;
  rateAvailable: boolean;
  /** Pensum in Prozent (z.B. 100, 80, 50) */
  workloadPercent: number;
  /** Soll Monat = 42 h × Wochen im Monat × Pensum */
  monthlyTargetHours: number;
  /** Ist Monat produktiv (ohne Abwesenheiten und ohne Zusatzkosten-Tage) */
  productiveHours: number;
  /** Differenz = produktive Monats-Ist − Monatssoll (kann negativ sein) */
  difference: number;
  /** max(0, Differenz); 0 wenn für diesen Mitarbeiter deaktiviert */
  overtimeHours: number;
  /** overtimeHours × Satz; null wenn Satz fehlt; 0 wenn deaktiviert */
  overtimeCost: number | null;
  /** true = Überstundenberechnung für diesen Mitarbeiter deaktiviert */
  overtimeDisabled: boolean;
  /** Anzahl Tage über 8.4 h — NUR informativ */
  daysOver84Count: number;
  /** Summe der manuellen Zusatzkosten-Stunden (isAdditionalCost) */
  additionalCostHours: number;
  /** Anzahl Tage mit manuellen Zusatzkosten */
  additionalCostDays: number;
  /**
   * Manuelle Zusatzkosten in CHF (pro Tag gerundet × Satz; null wenn Satz
   * fehlt). REINE ANZEIGE — bereits im regulären Personalkosten-Total enthalten,
   * NICHT erneut in die Überstunden-/Gesamtsummen einrechnen.
   */
  additionalCost: number | null;
}

export interface OvertimeAnalysis {
  /**
   * Festangestellte mit produktiven Ist-Stunden ODER Zusatzkosten im Monat,
   * sortiert nach Überstunden absteigend (dann Differenz, dann Name).
   */
  employees: EmployeeOvertimeResult[];
  totalOvertimeHours: number;
  /** Summe nur der verfügbaren Überstundenkosten (deaktivierte zählen 0) */
  totalOvertimeCost: number;
  /** Anzahl Mitarbeiter mit tatsächlichen Überstunden (> 0) */
  affectedEmployeeCount: number;
  /** true, wenn mindestens ein betroffener Mitarbeiter keinen Stundensatz hat */
  hasUnavailableRates: boolean;
}

export interface OvertimeAnalysisInput {
  employees: Employee[];
  entries: OvertimeHoursEntry[];
  /** Kalendertage des gewählten Monats (für das Monatssoll) */
  daysInMonth: number;
  /** Abteilungsfilter; 'all'/undefined = alle Abteilungen */
  departmentFilter?: Department | 'all';
  /** Mitarbeiter-IDs mit deaktivierter Überstundenberechnung */
  disabledEmployeeIds?: Iterable<string>;
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
 * von der Überstundenauswertung ausgeschlossen. Deckt sich mit `hasFixedSalary`
 * in PersonalFix.tsx (gleiche Semantik).
 */
export function isFixedSalaryEmployee(emp: Employee): boolean {
  return (emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
    && (emp.monthlySalary ?? 0) > 0;
}

/**
 * Berechnet die monatliche Überstundenauswertung für festangestellte
 * Mitarbeiter.
 *
 * - Stündliche/flexible Mitarbeiter werden ignoriert.
 * - Abteilungsfilter wird respektiert.
 * - Abwesenheiten und Zusatzkosten-Tage zählen nicht als produktive Stunden.
 * - Pro Mitarbeiter deaktivierbar (disabledEmployeeIds) → 0 Überstunden/Kosten.
 */
export function computeOvertimeAnalysis(input: OvertimeAnalysisInput): OvertimeAnalysis {
  const { employees, entries, daysInMonth, departmentFilter } = input;
  const dept = departmentFilter ?? 'all';
  const disabled = new Set<string>(input.disabledEmployeeIds ?? []);

  // Nur festangestellte, ggf. abteilungsgefilterte Mitarbeiter
  const fixedById = new Map<string, Employee>();
  for (const emp of employees) {
    if (!isFixedSalaryEmployee(emp)) continue;
    if (dept !== 'all' && emp.department !== dept) continue;
    fixedById.set(emp.id, emp);
  }

  // Pro Mitarbeiter: produktive Stunden je Tag + Zusatzkosten-Stunden je Tag.
  // (Mehrere Einträge pro Tag werden summiert — für korrekte Tages-Rundung und
  //  die 8.4-h-Tagesinfo.)
  interface Acc {
    productiveByDate: Map<string, number>;
    additionalByDate: Map<string, number>;
  }
  const perEmp = new Map<string, Acc>();

  for (const e of entries) {
    if (!fixedById.has(e.employeeId)) continue;
    if (!e.date || !Number.isFinite(e.hours) || e.hours <= 0) continue;
    if (e.absenceType) continue; // Abwesenheiten sind keine produktive Zeit

    let acc = perEmp.get(e.employeeId);
    if (!acc) { acc = { productiveByDate: new Map(), additionalByDate: new Map() }; perEmp.set(e.employeeId, acc); }

    if (e.isAdditionalCost) {
      acc.additionalByDate.set(e.date, (acc.additionalByDate.get(e.date) ?? 0) + e.hours);
    } else {
      acc.productiveByDate.set(e.date, (acc.productiveByDate.get(e.date) ?? 0) + e.hours);
    }
  }

  const results: EmployeeOvertimeResult[] = [];

  for (const [empId, acc] of perEmp) {
    const emp = fixedById.get(empId)!;
    const rate = getEffectiveHourlyRate(emp);
    const rateAvailable = rate != null;

    // Produktive Stunden + Tages-Info (über 8.4 h)
    let productiveHours = 0;
    let daysOver84Count = 0;
    for (const dayHours of acc.productiveByDate.values()) {
      const dh = round2(dayHours);
      productiveHours = round2(productiveHours + dh);
      if (dh > DAILY_OVERTIME_THRESHOLD) daysOver84Count++;
    }

    // Manuelle Zusatzkosten (pro Tag gerundet × Satz)
    let additionalCostHours = 0;
    let additionalCostRaw = 0;
    for (const dayHours of acc.additionalByDate.values()) {
      const dh = round2(dayHours);
      additionalCostHours = round2(additionalCostHours + dh);
      if (rateAvailable) additionalCostRaw = round2(additionalCostRaw + round2(dh * (rate as number)));
    }
    const additionalCostDays = acc.additionalByDate.size;
    const additionalCost = rateAvailable ? additionalCostRaw : null;

    // Nur Mitarbeiter mit produktiven Stunden ODER Zusatzkosten ausweisen
    if (productiveHours <= 0 && additionalCostHours <= 0) continue;

    const target = monthlyTargetHours(emp, daysInMonth);
    const difference = round2(productiveHours - target);
    const overtimeDisabled = disabled.has(empId);
    const rawOvertime = round2(Math.max(0, difference));
    const overtimeHours = overtimeDisabled ? 0 : rawOvertime;
    const overtimeCost = overtimeDisabled
      ? 0
      : (rateAvailable ? round2(overtimeHours * (rate as number)) : null);

    results.push({
      employeeId: empId,
      name: emp.name,
      department: emp.department,
      hourlyRate: rate,
      rateAvailable,
      workloadPercent: workloadPercent(emp),
      monthlyTargetHours: target,
      productiveHours,
      difference,
      overtimeHours,
      overtimeCost,
      overtimeDisabled,
      daysOver84Count,
      additionalCostHours,
      additionalCostDays,
      additionalCost,
    });
  }

  // Sortierung: meiste Überstunden zuerst, dann grösste Differenz, dann Name
  results.sort((a, b) =>
    b.overtimeHours - a.overtimeHours
    || b.difference - a.difference
    || a.name.localeCompare(b.name),
  );

  const totalOvertimeHours = round2(results.reduce((s, r) => s + r.overtimeHours, 0));
  const totalOvertimeCost = round2(results.reduce((s, r) => s + (r.overtimeCost ?? 0), 0));
  const affected = results.filter((r) => r.overtimeHours > 0);
  const hasUnavailableRates = affected.some((r) => !r.rateAvailable);

  return {
    employees: results,
    totalOvertimeHours,
    totalOvertimeCost,
    affectedEmployeeCount: affected.length,
    hasUnavailableRates,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wochenauswertung (ISO-Wochen innerhalb des gewählten Monats)
// ─────────────────────────────────────────────────────────────────────────────
// Zusätzlich zur Monatsauswertung können Überstunden je ISO-Kalenderwoche
// INNERHALB des gewählten Monats ausgewertet werden. Jede Woche wird ANTEILIG
// nach der Anzahl ihrer Tage im gewählten Monat berechnet:
//   Wochensoll = 42 h × Pensum × (Tage dieser Woche im Monat ÷ 7)
// Eine volle Woche (7 Tage im Monat) entspricht damit dem vollen pensum-
// abhängigen Wochensoll; eine Randwoche (z.B. nur 2 Tage im Monat) erhält ein
// anteilig reduziertes Soll. Produktive Ist-Stunden je Woche schliessen
// Abwesenheiten (FE/K/U) und Zusatzkosten-Tage aus (gleiche Semantik wie die
// Monatsauswertung). Überstunden je Woche = max(0, produktive Wochen-Ist −
// Wochensoll). Die Pro-Mitarbeiter-Deaktivierung gilt auch hier (Kosten = 0,
// Differenz bleibt sichtbar).
// ─────────────────────────────────────────────────────────────────────────────

interface YMD { y: number; m: number; d: number; }

function parseYMD(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ISO-8601-Woche (Mo–So) eines Datums + Montag-Zeitstempel (für Sortierung). */
function isoWeekParts(y: number, m: number, d: number): { isoYear: number; isoWeek: number; mondayMs: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mo=0 … So=6
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayNum);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const isoWeek = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { isoYear, isoWeek, mondayMs: monday.getTime() };
}

/** Beschreibung einer ISO-Woche, die (teilweise) im gewählten Monat liegt. */
export interface MonthWeekDescriptor {
  isoYear: number;
  isoWeek: number;
  /** z.B. "KW 23" */
  weekLabel: string;
  /** Auf den Monat beschnittener Zeitraum, z.B. "29.06.–30.06.2026" */
  rangeLabel: string;
  /** Anzahl Tage dieser Woche, die im gewählten Monat liegen (1..7) */
  daysInMonth: number;
}

/**
 * Liefert alle ISO-Wochen, die (teilweise) im gewählten Monat liegen, in
 * chronologischer Reihenfolge — inklusive Anzahl Tage je Woche im Monat
 * (für die anteilige Soll-Berechnung) und einem auf den Monat beschnittenen
 * Zeitraum-Label. `month` ist 1-basiert.
 */
export function weeksInMonth(year: number, month: number): MonthWeekDescriptor[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  interface Bucket { isoYear: number; isoWeek: number; mondayMs: number; count: number; first: number; last: number; }
  const map = new Map<string, Bucket>();
  for (let d = 1; d <= daysInMonth; d++) {
    const { isoYear, isoWeek, mondayMs } = isoWeekParts(year, month, d);
    const key = `${isoYear}-${isoWeek}`;
    let b = map.get(key);
    if (!b) { b = { isoYear, isoWeek, mondayMs, count: 0, first: d, last: d }; map.set(key, b); }
    b.count++;
    b.last = d;
  }
  return Array.from(map.values())
    .sort((a, b) => a.mondayMs - b.mondayMs)
    .map((b) => ({
      isoYear: b.isoYear,
      isoWeek: b.isoWeek,
      weekLabel: `KW ${b.isoWeek}`,
      rangeLabel: `${pad2(b.first)}.${pad2(month)}.–${pad2(b.last)}.${pad2(month)}.${year}`,
      daysInMonth: b.count,
    }));
}

/**
 * Anteiliges Wochensoll = 42 h × Pensum × (Tage der Woche im Monat ÷ 7).
 * `daysInWeekWithinMonth` wird auf 0..7 begrenzt.
 */
export function proratedWeeklyTargetHours(emp: Employee, daysInWeekWithinMonth: number): number {
  const d = Number.isFinite(daysInWeekWithinMonth) && daysInWeekWithinMonth > 0
    ? Math.min(7, daysInWeekWithinMonth) : 0;
  return round2((weeklyTargetHours(emp) * d) / 7);
}

/** Eine ausgewertete Woche eines Mitarbeiters. */
export interface WeekOvertimeRow {
  isoYear: number;
  isoWeek: number;
  weekLabel: string;
  rangeLabel: string;
  /** Anzahl Tage dieser Woche im gewählten Monat (1..7) */
  daysInMonth: number;
  /** Anteiliges Wochensoll = 42 h × Pensum × Tage/7 */
  weeklyTargetHours: number;
  /** Produktive Ist-Stunden dieser Woche (ohne Abwesenheiten/Zusatzkosten) */
  productiveHours: number;
  /** Differenz = produktive Ist − Wochensoll (kann negativ sein) */
  difference: number;
  /** max(0, Differenz); 0 wenn deaktiviert */
  overtimeHours: number;
  /** overtimeHours × Satz; null wenn Satz fehlt; 0 wenn deaktiviert */
  overtimeCost: number | null;
  /** Summe manueller Zusatzkosten-Stunden dieser Woche (reine Anzeige) */
  additionalCostHours: number;
  additionalCostDays: number;
  /** Manuelle Zusatzkosten in CHF (reine Anzeige; null wenn Satz fehlt) */
  additionalCost: number | null;
  /** Anzahl Tage über 8.4 h dieser Woche — NUR informativ */
  daysOver84Count: number;
}

/** Wochenauswertung pro festangestelltem Mitarbeiter. */
export interface EmployeeWeeklyOvertimeResult {
  employeeId: string;
  name: string;
  department: Department;
  hourlyRate: number | null;
  rateAvailable: boolean;
  workloadPercent: number;
  overtimeDisabled: boolean;
  /** Wochen mit produktiven Stunden ODER Zusatzkosten, chronologisch */
  weeks: WeekOvertimeRow[];
  totalProductiveHours: number;
  totalOvertimeHours: number;
  /** Summe der Wochen-Überstundenkosten; null wenn Satz fehlt; 0 wenn deaktiviert */
  totalOvertimeCost: number | null;
  totalAdditionalCostHours: number;
  totalAdditionalCost: number | null;
}

export interface WeeklyOvertimeAnalysis {
  employees: EmployeeWeeklyOvertimeResult[];
  totalOvertimeHours: number;
  totalOvertimeCost: number;
  affectedEmployeeCount: number;
  hasUnavailableRates: boolean;
  /** Alle ISO-Wochen des Monats (für Kontext/Anzeige) */
  weeks: MonthWeekDescriptor[];
}

export interface WeeklyOvertimeInput {
  employees: Employee[];
  entries: OvertimeHoursEntry[];
  /** Jahr des gewählten Monats */
  year: number;
  /** Monat (1-basiert) */
  month: number;
  departmentFilter?: Department | 'all';
  disabledEmployeeIds?: Iterable<string>;
}

/**
 * Berechnet die Überstunden je ISO-Woche innerhalb des gewählten Monats.
 * Gleiche Ausschluss-Regeln wie die Monatsauswertung (stündliche MA, Abwesen-
 * heiten, Zusatzkosten, Abteilungsfilter, Pro-Mitarbeiter-Deaktivierung), aber
 * je Woche mit anteiligem Wochensoll. Einträge ausserhalb des gewählten Monats
 * werden ignoriert.
 */
export function computeWeeklyOvertimeAnalysis(input: WeeklyOvertimeInput): WeeklyOvertimeAnalysis {
  const { employees, entries, year, month, departmentFilter } = input;
  const dept = departmentFilter ?? 'all';
  const disabled = new Set<string>(input.disabledEmployeeIds ?? []);

  const monthWeeks = weeksInMonth(year, month);
  const weekByKey = new Map(monthWeeks.map((w) => [`${w.isoYear}-${w.isoWeek}`, w]));

  const fixedById = new Map<string, Employee>();
  for (const emp of employees) {
    if (!isFixedSalaryEmployee(emp)) continue;
    if (dept !== 'all' && emp.department !== dept) continue;
    fixedById.set(emp.id, emp);
  }

  interface WeekAcc { productiveByDate: Map<string, number>; additionalByDate: Map<string, number>; }
  const perEmp = new Map<string, Map<string, WeekAcc>>(); // empId → weekKey → acc

  for (const e of entries) {
    if (!fixedById.has(e.employeeId)) continue;
    if (!e.date || !Number.isFinite(e.hours) || e.hours <= 0) continue;
    if (e.absenceType) continue;
    const ymd = parseYMD(e.date);
    if (!ymd || ymd.y !== year || ymd.m !== month) continue; // nur gewählter Monat
    const { isoYear, isoWeek } = isoWeekParts(ymd.y, ymd.m, ymd.d);
    const key = `${isoYear}-${isoWeek}`;
    if (!weekByKey.has(key)) continue;

    let weeks = perEmp.get(e.employeeId);
    if (!weeks) { weeks = new Map(); perEmp.set(e.employeeId, weeks); }
    let acc = weeks.get(key);
    if (!acc) { acc = { productiveByDate: new Map(), additionalByDate: new Map() }; weeks.set(key, acc); }

    if (e.isAdditionalCost) {
      acc.additionalByDate.set(e.date, (acc.additionalByDate.get(e.date) ?? 0) + e.hours);
    } else {
      acc.productiveByDate.set(e.date, (acc.productiveByDate.get(e.date) ?? 0) + e.hours);
    }
  }

  const results: EmployeeWeeklyOvertimeResult[] = [];

  for (const [empId, weeks] of perEmp) {
    const emp = fixedById.get(empId)!;
    const rate = getEffectiveHourlyRate(emp);
    const rateAvailable = rate != null;
    const overtimeDisabled = disabled.has(empId);

    const weekRows: WeekOvertimeRow[] = [];
    for (const desc of monthWeeks) {
      const acc = weeks.get(`${desc.isoYear}-${desc.isoWeek}`);
      if (!acc) continue;

      let productiveHours = 0;
      let daysOver84Count = 0;
      for (const dayHours of acc.productiveByDate.values()) {
        const dh = round2(dayHours);
        productiveHours = round2(productiveHours + dh);
        if (dh > DAILY_OVERTIME_THRESHOLD) daysOver84Count++;
      }

      let additionalCostHours = 0;
      let additionalCostRaw = 0;
      for (const dayHours of acc.additionalByDate.values()) {
        const dh = round2(dayHours);
        additionalCostHours = round2(additionalCostHours + dh);
        if (rateAvailable) additionalCostRaw = round2(additionalCostRaw + round2(dh * (rate as number)));
      }
      const additionalCostDays = acc.additionalByDate.size;

      if (productiveHours <= 0 && additionalCostHours <= 0) continue;

      const target = proratedWeeklyTargetHours(emp, desc.daysInMonth);
      const difference = round2(productiveHours - target);
      const rawOvertime = round2(Math.max(0, difference));
      const overtimeHours = overtimeDisabled ? 0 : rawOvertime;
      const overtimeCost = overtimeDisabled
        ? 0
        : (rateAvailable ? round2(overtimeHours * (rate as number)) : null);

      weekRows.push({
        isoYear: desc.isoYear,
        isoWeek: desc.isoWeek,
        weekLabel: desc.weekLabel,
        rangeLabel: desc.rangeLabel,
        daysInMonth: desc.daysInMonth,
        weeklyTargetHours: target,
        productiveHours,
        difference,
        overtimeHours,
        overtimeCost,
        additionalCostHours,
        additionalCostDays,
        additionalCost: rateAvailable ? additionalCostRaw : null,
        daysOver84Count,
      });
    }

    if (weekRows.length === 0) continue;

    const totalProductiveHours = round2(weekRows.reduce((s, w) => s + w.productiveHours, 0));
    const totalOvertimeHours = round2(weekRows.reduce((s, w) => s + w.overtimeHours, 0));
    const totalOvertimeCost = overtimeDisabled
      ? 0
      : (!rateAvailable && totalOvertimeHours > 0
        ? null
        : round2(weekRows.reduce((s, w) => s + (w.overtimeCost ?? 0), 0)));
    const totalAdditionalCostHours = round2(weekRows.reduce((s, w) => s + w.additionalCostHours, 0));
    const totalAdditionalCost = rateAvailable
      ? round2(weekRows.reduce((s, w) => s + (w.additionalCost ?? 0), 0))
      : null;

    results.push({
      employeeId: empId,
      name: emp.name,
      department: emp.department,
      hourlyRate: rate,
      rateAvailable,
      workloadPercent: workloadPercent(emp),
      overtimeDisabled,
      weeks: weekRows,
      totalProductiveHours,
      totalOvertimeHours,
      totalOvertimeCost,
      totalAdditionalCostHours,
      totalAdditionalCost,
    });
  }

  results.sort((a, b) =>
    b.totalOvertimeHours - a.totalOvertimeHours
    || a.name.localeCompare(b.name),
  );

  const totalOvertimeHours = round2(results.reduce((s, r) => s + r.totalOvertimeHours, 0));
  const totalOvertimeCost = round2(results.reduce((s, r) => s + (r.totalOvertimeCost ?? 0), 0));
  const affected = results.filter((r) => r.totalOvertimeHours > 0);
  const hasUnavailableRates = affected.some((r) => !r.rateAvailable);

  return {
    employees: results,
    totalOvertimeHours,
    totalOvertimeCost,
    affectedEmployeeCount: affected.length,
    hasUnavailableRates,
    weeks: monthWeeks,
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

// ─────────────────────────────────────────────────────────────────────────────
// Tages-Detail (Drill-down Ebene 3) — REINE ANZEIGE, KEINE Berechnung
// ─────────────────────────────────────────────────────────────────────────────
// Liefert die Tageszeilen einer einzelnen ISO-Woche eines Mitarbeiters für die
// aufklappbare Detailansicht. Dies berührt KEINE Überstundenberechnung — es ist
// ausschliesslich eine Aufbereitung der bereits geladenen Ist-Daten zur Anzeige
// (Datum, Wochentag, Arbeitszeit, produktive Stunden, Abwesenheit, 8.4-h-Info).
// Im Gegensatz zu den Berechnungs-Eingaben (OvertimeHoursEntry) enthalten die
// Detail-Einträge AUCH Abwesenheitstage (FE/K/U), damit die Tagesliste vollständig
// ist; die produktiven Stunden bleiben aber konsistent definiert
// (produktiv = hours > 0 && !absenceType && !isAdditionalCost).
// ─────────────────────────────────────────────────────────────────────────────

/** Eine Ist-Position pro Mitarbeiter und Tag inkl. Anzeige-Zeiten (für das Tages-Detail). */
export interface DayDetailEntry {
  employeeId: string;
  date: string; // YYYY-MM-DD
  hours: number;
  absenceType?: string | null;
  isAdditionalCost?: boolean;
  /** Schichtzeiten (reine Anzeige) — erste Schicht */
  start?: string | null;
  end?: string | null;
  /** Schichtzeiten (reine Anzeige) — zweite Schicht (geteilter Dienst) */
  start2?: string | null;
  end2?: string | null;
}

/** Eine aufbereitete Tageszeile für die Detailansicht. */
export interface DayDetailRow {
  date: string; // YYYY-MM-DD
  /** Tag des Monats, z.B. "09.06." */
  dayLabel: string;
  /** Deutscher Wochentag, z.B. "Montag" */
  weekday: string;
  /** Arbeitszeit-Bereiche, z.B. "09:00–15:00 / 17:00–23:00" ('' wenn keine) */
  timeRange: string;
  /** Produktive Stunden (0 bei Abwesenheit/Zusatzkosten) */
  productiveHours: number;
  /** Abwesenheitscode (FE/K/U/…) oder null */
  absenceType: string | null;
  /** true = manueller Zusatzkosten-Tag (nicht produktiv, separat) */
  isAdditionalCost: boolean;
  /** produktive Stunden > 8.4 — NUR informativ */
  over84: boolean;
}

const WEEKDAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'] as const;

function formatTimeRange(e: DayDetailEntry): string {
  const parts: string[] = [];
  if (e.start && e.end) parts.push(`${e.start}–${e.end}`);
  if (e.start2 && e.end2) parts.push(`${e.start2}–${e.end2}`);
  return parts.join(' / ');
}

/**
 * Liefert die Tageszeilen EINER ISO-Woche eines Mitarbeiters, chronologisch
 * sortiert. Mehrere Einträge desselben Tages werden zusammengefasst (Stunden
 * summiert, Zeitbereiche verbunden). Nur die Tage, deren ISO-Woche exakt
 * (isoYear, isoWeek) entspricht. REINE ANZEIGE — keine Berechnungslogik.
 */
export function buildWeekDayRows(
  entries: DayDetailEntry[],
  employeeId: string,
  isoYear: number,
  isoWeek: number,
): DayDetailRow[] {
  interface Acc {
    date: string;
    productiveHours: number;
    absenceType: string | null;
    isAdditionalCost: boolean;
    ranges: string[];
  }
  const byDate = new Map<string, Acc>();

  for (const e of entries) {
    if (e.employeeId !== employeeId) continue;
    const ymd = parseYMD(e.date);
    if (!ymd) continue;
    const parts = isoWeekParts(ymd.y, ymd.m, ymd.d);
    if (parts.isoYear !== isoYear || parts.isoWeek !== isoWeek) continue;

    let acc = byDate.get(e.date);
    if (!acc) {
      acc = { date: e.date, productiveHours: 0, absenceType: null, isAdditionalCost: false, ranges: [] };
      byDate.set(e.date, acc);
    }
    const absence = e.absenceType ?? null;
    if (absence) {
      if (!acc.absenceType) acc.absenceType = absence;
    } else if (e.isAdditionalCost) {
      acc.isAdditionalCost = true;
    } else if (Number.isFinite(e.hours) && e.hours > 0) {
      acc.productiveHours = round2(acc.productiveHours + e.hours);
    }
    const tr = formatTimeRange(e);
    if (tr) acc.ranges.push(tr);
  }

  return Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => {
      const ymd = parseYMD(a.date)!;
      const weekdayIdx = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
      return {
        date: a.date,
        dayLabel: `${pad2(ymd.d)}.${pad2(ymd.m)}.`,
        weekday: WEEKDAYS_DE[weekdayIdx],
        timeRange: a.ranges.join(' / '),
        productiveHours: round2(a.productiveHours),
        absenceType: a.absenceType,
        isAdditionalCost: a.isAdditionalCost,
        over84: a.productiveHours > DAILY_OVERTIME_THRESHOLD,
      };
    });
}
