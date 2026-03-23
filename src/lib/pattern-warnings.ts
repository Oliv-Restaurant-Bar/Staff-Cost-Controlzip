/**
 * pattern-warnings.ts
 * Detects operationally risky planning patterns for the schedule planner.
 * Not legal payroll advice — practical warnings for the scheduler.
 *
 * Thresholds (practical, not legal):
 *   consecutive-days  ≥ 6 days → warning; ≥ 7 → critical
 *   consecutive-late  ≥ 3 late shifts → warning; ≥ 4 → critical
 *   short-recovery    < 11 h between end and next start → warning; < 8 h → critical
 *   weekly-overload   > 50 h in any rolling 7-day window → warning; > 55 h → critical
 */

import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PatternType =
  | 'consecutive-days'
  | 'consecutive-late'
  | 'short-recovery'
  | 'weekly-overload';

export interface PatternWarning {
  empId: string;
  empName: string;
  dept: string;
  type: PatternType;
  severity: 'critical' | 'warning';
  /** Short message shown in chip, e.g. "6 Tage am Stück" */
  message: string;
  /** Longer detail line with dates and numbers */
  detail: string;
  /** yyyy-MM-dd of first affected day (used for jump-to-day) */
  firstDate: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function slotNetHours(
  slot: { start: string; end: string } | null | undefined,
): number {
  if (!slot?.start || !slot?.end) return 0;
  const gross = (timeToMin(slot.end) - timeToMin(slot.start)) / 60;
  if (gross <= 0) return 0;
  return gross - calculateBreakDeduction(gross);
}

function dayTotalHours(ds: DaySchedule | null): number {
  if (!ds) return 0;
  return (ds.frühAbsence ? 0 : slotNetHours(ds.früh)) +
         (ds.spätAbsence ? 0 : slotNetHours(ds.spät));
}

function isWorking(ds: DaySchedule | null): boolean {
  return dayTotalHours(ds) > 0;
}

function hasLate(ds: DaySchedule | null): boolean {
  if (!ds || ds.spätAbsence) return false;
  return slotNetHours(ds.spät) > 0;
}

function lastEnd(ds: DaySchedule | null): string | null {
  if (!ds) return null;
  let latestMin = -1;
  let result: string | null = null;
  if (!ds.spätAbsence && ds.spät?.end && slotNetHours(ds.spät) > 0) {
    const m = timeToMin(ds.spät.end);
    if (m > latestMin) { latestMin = m; result = ds.spät.end; }
  }
  if (!ds.frühAbsence && ds.früh?.end && slotNetHours(ds.früh) > 0) {
    const m = timeToMin(ds.früh.end);
    if (m > latestMin) { latestMin = m; result = ds.früh.end; }
  }
  return result;
}

function firstStart(ds: DaySchedule | null): string | null {
  if (!ds) return null;
  let earliestMin = Infinity;
  let result: string | null = null;
  if (!ds.frühAbsence && ds.früh?.start && slotNetHours(ds.früh) > 0) {
    const m = timeToMin(ds.früh.start);
    if (m < earliestMin) { earliestMin = m; result = ds.früh.start; }
  }
  if (!ds.spätAbsence && ds.spät?.start && slotNetHours(ds.spät) > 0) {
    const m = timeToMin(ds.spät.start);
    if (m < earliestMin) { earliestMin = m; result = ds.spät.start; }
  }
  return result;
}

function getDs(
  empId: string,
  dateStr: string,
  data: Record<string, DaySchedule>,
): DaySchedule | null {
  return data[`${empId}-${dateStr}`] ?? null;
}

function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return format(new Date(y, m - 1, d), 'EEE d.M.', { locale: de });
}

// ── Main export ───────────────────────────────────────────────────────────────

export function detectPatternWarnings(
  employees: Employee[],
  allDays: Date[],
  scheduleData: Record<string, DaySchedule>,
): PatternWarning[] {
  const dateStrs = allDays.map(d => format(d, 'yyyy-MM-dd'));
  const result: PatternWarning[] = [];
  for (const emp of employees) {
    result.push(...detectForEmp(emp, dateStrs, scheduleData));
  }
  return result;
}

// ── Per-employee detection ─────────────────────────────────────────────────────

function detectForEmp(
  emp: Employee,
  dateStrs: string[],
  data: Record<string, DaySchedule>,
): PatternWarning[] {
  const warns: PatternWarning[] = [];
  const dept = emp.department ?? '';

  // ── 1. Consecutive working days ──────────────────────────────────────────

  let streak = 0;
  let streakStart: string | null = null;

  const flushDays = (endDate: string) => {
    if (streak >= 6) {
      warns.push({
        empId: emp.id, empName: emp.name, dept,
        type: 'consecutive-days',
        severity: streak >= 7 ? 'critical' : 'warning',
        message: `${streak} Tage am Stück`,
        detail: `${fmtDate(streakStart!)} – ${fmtDate(endDate)}`,
        firstDate: streakStart!,
      });
    }
    streak = 0;
    streakStart = null;
  };

  for (let i = 0; i < dateStrs.length; i++) {
    if (isWorking(getDs(emp.id, dateStrs[i], data))) {
      if (streak === 0) streakStart = dateStrs[i];
      streak++;
    } else {
      if (streak > 0) flushDays(dateStrs[i - 1]);
    }
  }
  if (streak > 0) flushDays(dateStrs[dateStrs.length - 1]);

  // ── 2. Consecutive late shifts ──────────────────────────────────────────

  let lStreak = 0;
  let lStart: string | null = null;

  const flushLate = (endDate: string) => {
    if (lStreak >= 3) {
      warns.push({
        empId: emp.id, empName: emp.name, dept,
        type: 'consecutive-late',
        severity: lStreak >= 4 ? 'critical' : 'warning',
        message: `${lStreak} Spätschichten in Folge`,
        detail: `${fmtDate(lStart!)} – ${fmtDate(endDate)}`,
        firstDate: lStart!,
      });
    }
    lStreak = 0;
    lStart = null;
  };

  for (let i = 0; i < dateStrs.length; i++) {
    if (hasLate(getDs(emp.id, dateStrs[i], data))) {
      if (lStreak === 0) lStart = dateStrs[i];
      lStreak++;
    } else {
      if (lStreak > 0) flushLate(dateStrs[i - 1]);
    }
  }
  if (lStreak > 0) flushLate(dateStrs[dateStrs.length - 1]);

  // ── 3. Short recovery between consecutive working days ───────────────────

  for (let i = 0; i < dateStrs.length - 1; i++) {
    const todayDs = getDs(emp.id, dateStrs[i],     data);
    const nextDs  = getDs(emp.id, dateStrs[i + 1], data);
    if (!isWorking(todayDs) || !isWorking(nextDs)) continue;

    const endStr   = lastEnd(todayDs);
    const startStr = firstStart(nextDs);
    if (!endStr || !startStr) continue;

    // Recovery = minutes from end of today until start of tomorrow
    const recovMin = (24 * 60 - timeToMin(endStr)) + timeToMin(startStr);
    const recovH   = recovMin / 60;

    if (recovH < 11) {
      const recovStr = recovH.toFixed(1).replace('.', ',');
      warns.push({
        empId: emp.id, empName: emp.name, dept,
        type: 'short-recovery',
        severity: recovH < 8 ? 'critical' : 'warning',
        message: 'Erholung zwischen Einsätzen kritisch',
        detail: `${fmtDate(dateStrs[i])} Ende ${endStr} → ${fmtDate(dateStrs[i + 1])} Start ${startStr} (nur ${recovStr}h Pause)`,
        firstDate: dateStrs[i + 1],
      });
    }
  }

  // ── 4. Weekly overload: rolling 7-day window ─────────────────────────────

  let skip = 0;
  for (let i = 0; i <= dateStrs.length - 7; i++) {
    if (skip > 0) { skip--; continue; }
    const window  = dateStrs.slice(i, i + 7);
    const total   = window.reduce(
      (s, d) => s + dayTotalHours(getDs(emp.id, d, data)),
      0,
    );
    if (total > 50) {
      const hoursStr = total.toFixed(1).replace('.', ',');
      warns.push({
        empId: emp.id, empName: emp.name, dept,
        type: 'weekly-overload',
        severity: total > 55 ? 'critical' : 'warning',
        message: `${hoursStr}h in 7 Tagen`,
        detail: `${fmtDate(window[0])} – ${fmtDate(window[6])} · ${hoursStr}h geplant`,
        firstDate: window[0],
      });
      skip = 6;
    }
  }

  return warns;
}
