/**
 * operational-day.ts — Reine operative Tages-/Summenlogik (Dashboard + Cockpit).
 * ==============================================================================
 * VERBATIM aus Dashboard.tsx extrahiert (keine neue Berechnungslogik): die
 * Stunden-, AG-Kosten- und Tagesumsatz-Summenformeln leben hier EINMAL und
 * werden vom Dashboard UND der Startseite («Executive Cockpit») konsumiert.
 *
 * Reine Logik: KEIN React, KEIN Supabase, KEIN DOM — nur Typ-Importe und die
 * zentralen AG-Kosten-Helfer (getEffectiveHourlyRate, socialCostFactorFromRates).
 * fehlend ≠ 0: keine Einträge ⇒ null, nie stille 0.
 */

import type { DaySchedule, ActualHourEntry } from './supabase-db';
import type { Employee } from '@/types/personnel';
import { getEffectiveHourlyRate } from './employee-rate';
import { socialCostFactorFromRates, type SocialCostRates } from './social-costs';

// ─── Stunden aus Dienstplan-Einträgen (verbatim Dashboard) ───────────────────

function parseTimeToHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}

function shiftHours(start: string, end: string): number {
  const s = parseTimeToHours(start);
  let e = parseTimeToHours(end);
  if (e < s) e += 24;
  return Math.max(0, e - s);
}

/** Geplante Stunden eines Dienstplan-Tages (Früh + Spät, Absenzen zählen nicht). */
export function calcDayHours(schedule: DaySchedule): number {
  let total = 0;
  if (schedule.früh && !schedule.frühAbsence) {
    total += shiftHours(schedule.früh.start, schedule.früh.end);
  }
  if (schedule.spät && !schedule.spätAbsence) {
    total += shiftHours(schedule.spät.start, schedule.spät.end);
  }
  return total;
}

// ─── Schedule-Key-Konvention: `${empId}-${yyyy-MM-dd}` ───────────────────────

/** Zerlegt einen Schedule-/ActualHours-Key in {empId, date} (Konvention Dashboard). */
export function splitScheduleKey(key: string): { empId: string; date: string } {
  return { date: key.slice(-10), empId: key.slice(0, key.length - 11) };
}

// ─── AG-Kosten-Helfer (verbatim Dashboard agRate/agMonthly) ──────────────────

/** AG-Stundensatz (inkl. Sozialkosten) — 0 wenn kein Satz ermittelbar. */
export function agHourlyRate(emp: Employee, rates: SocialCostRates): number {
  return getEffectiveHourlyRate(emp, rates) ?? 0;
}

/** AG-Monatslohn (inkl. anteiligem 13. + AG-Sozialkostenfaktor). */
export function agMonthlySalary(emp: Employee, agFactor: number): number {
  return (emp.monthlySalaryWith13th ?? emp.monthlySalary ?? 0) * agFactor;
}

// ─── Heute-Stunden (verbatim Dashboard todayHours-Memo) ──────────────────────

/**
 * Geplante/Ist-Stunden eines Tages über die sichtbaren Mitarbeitenden.
 * Keine Einträge ⇒ null (nicht erfasst ≠ 0 h).
 */
export function calcDayHoursForEmployees(opts: {
  scheduleData: Record<string, DaySchedule>;
  actualData: Record<string, ActualHourEntry>;
  visibleIds: Set<string>;
  dateStr: string;
}): { planned: number | null; actual: number | null } {
  const { scheduleData, actualData, visibleIds, dateStr } = opts;
  let planned: number | null = null;
  let actual: number | null = null;
  for (const [key, day] of Object.entries(scheduleData)) {
    const { empId, date } = splitScheduleKey(key);
    if (date !== dateStr || !visibleIds.has(empId)) continue;
    planned = (planned ?? 0) + calcDayHours(day);
  }
  for (const [key, e] of Object.entries(actualData)) {
    const { empId, date } = splitScheduleKey(key);
    if (date !== dateStr || !visibleIds.has(empId)) continue;
    actual = (actual ?? 0) + e.hours;
  }
  return { planned, actual };
}

// ─── Geplante Personalkosten eines Tages (verbatim Dashboard plannedCostToday) ─

/**
 * Geplante Personalkosten eines Tages gemäss Dienstplan: Stunden×AG-Satz plus
 * Tagesanteil der Fixlöhne (dieselbe AG-Kostenlogik wie die Monats-Memos).
 * Der Aufrufer prüft vorher, ob überhaupt Plan-Stunden existieren (sonst null).
 */
export function calcPlannedCostForDay(opts: {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  dateStr: string;
  daysInMonth: number;
  rates: SocialCostRates;
}): number {
  const { employees, scheduleData, dateStr, daysInMonth, rates } = opts;
  const agFactor = socialCostFactorFromRates(rates);
  return employees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + agMonthlySalary(emp, agFactor) / daysInMonth;
    }
    const hrs = Object.entries(scheduleData)
      .filter(([key]) => {
        const { empId, date } = splitScheduleKey(key);
        return empId === emp.id && date === dateStr;
      })
      .reduce((s, [, day]) => s + calcDayHours(day), 0);
    return sum + hrs * agHourlyRate(emp, rates);
  }, 0);
}

// ─── Tagesumsatz-Summen (verbatim Dashboard sumRevenue) ──────────────────────

/**
 * Summe eines numerischen Tagesfelds über eine Tagesliste (z. B. actualRevenue
 * über die Wochentage). Fehlende Tage/Felder zählen 0 — reine Summierung
 * BESTEHENDER Tageswerte, keine neue Berechnung.
 */
export function sumDailyRevenue<T extends object>(
  dailyBudgets: Record<string, T | undefined>,
  days: string[],
  field: keyof T,
): number {
  return days.reduce((s, d) => {
    const v = dailyBudgets[d]?.[field];
    return s + (typeof v === 'number' ? v : 0);
  }, 0);
}
