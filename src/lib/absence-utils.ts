/**
 * absence-utils.ts
 * Shared utility for absence tracking, replacement detection, and cost calculation.
 * Used by: AbsenzKosten, DayDetailDialog, Dashboard, Reporting.
 */

import { resolveBreakHours } from '@/hooks/useShiftConfig';
import type { Employee } from '@/types/personnel';
import type { DaySchedule } from '@/lib/supabase-db';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VACATION_CODES  = new Set(['FE', 'FW', 'Ferien', 'Urlaub']);
export const SICK_CODES      = new Set(['K', 'KO', 'Krank', 'Krankheit', 'AUF']);
export const ACCIDENT_CODES  = new Set(['U', 'Unfall', 'UNF', 'UNFALL']);
export const SKIP_CODES      = new Set(['F', 'Frei']); // day off, not an absence to track
export const DEFAULT_ABSENCE_HOURS = 8.4;
export const LS_ABSENCE_OVERRIDES  = 'absence_overrides_v1';

/**
 * Returns true for K (Krank) and U (Unfall) — paid absences for hourly workers.
 * These generate costs in Forecast/PersonalFIX but are excluded from the
 * daily operative PKQ (Tages-Personalkostenquote gegen Umsatz).
 */
export function isPayableAbsence(code: string): boolean {
  return SICK_CODES.has(code) || ACCIDENT_CODES.has(code);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type AbsenceKind = 'vacation' | 'sick' | 'accident' | 'other';

export interface ReplacementInfo {
  empId:      string;
  empName:    string;
  hours:      number;
  hourlyWage: number;
  cost:       number;
  source:     'plan' | 'actual';
}

export interface AbsenceEvent {
  id:           string;   // `${empId}-${date}`
  empId:        string;
  empName:      string;
  dept:         'service' | 'küche';
  date:         string;   // YYYY-MM-DD
  absenceCode:  string;
  kind:         AbsenceKind;
  plannedHours: number;
  autoReplacements: ReplacementInfo[];
}

export interface ResolvedEvent extends AbsenceEvent {
  effectiveReplacements: ReplacementInfo[];
  replacedHours:   number;
  replacedCost:    number;
  unreplacedHours: number;
  saving:          number;
}

export interface Override {
  plannedHoursOverride?: number;
  addedEmpIds:       string[];
  removedAutoEmpIds: string[];
}

export interface AbsenceSummary {
  vacationDays:  number;
  sickDays:      number;
  accidentDays:  number;
  vacationCost:  number;
  sickCost:      number;
  accidentCost:  number;
  totalCost:     number;
  totalSaving:   number;
  unreplacedHrs: number;
  byDept: {
    service: { cost: number; saving: number; days: number };
    küche:   { cost: number; saving: number; days: number };
  };
}

// ─── Classification helpers ───────────────────────────────────────────────────

export function absenceKind(code: string): AbsenceKind {
  if (VACATION_CODES.has(code))  return 'vacation';
  if (SICK_CODES.has(code))      return 'sick';
  if (ACCIDENT_CODES.has(code))  return 'accident';
  return 'other';
}

export function absenceLabel(kind: AbsenceKind): string {
  if (kind === 'vacation') return 'Ferien';
  if (kind === 'sick')     return 'Krank';
  if (kind === 'accident') return 'Unfall';
  return 'Abwesenheit';
}

export function isFixedEmployee(e: Employee): boolean {
  return (e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit') &&
         (e.monthlySalary ?? 0) > 0;
}

export function isVariableEmployee(e: Employee): boolean {
  return !isFixedEmployee(e);
}

// ─── Hour calculation helpers ─────────────────────────────────────────────────

export function slotHours(slot: { start: string; end: string } | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60;
  return Math.round(mins / 6) / 10;
}

export function netHoursFromSchedule(ds: DaySchedule): number {
  const gross = slotHours(ds.früh) + slotHours(ds.spät);
  return gross > 0 ? Math.max(0, gross - resolveBreakHours(gross, ds.breakMinutes)) : 0;
}

export function plannedHoursFor(emp: Employee): number {
  if (emp.weeklyHours && emp.weeklyHours > 0) {
    return Math.round((emp.weeklyHours / 5) * 10) / 10;
  }
  return DEFAULT_ABSENCE_HOURS;
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute all absence events for fixed employees for the given days.
 * `actualHours` keys are `${empId}-YYYY-MM-DD`.
 */
export function computeAbsenceEvents(
  employees:   Employee[],
  scheduleData: Record<string, DaySchedule>,
  actualHours: Record<string, { hours: number }>,
  days:        Date[],
): AbsenceEvent[] {
  const fixedEmps    = employees.filter(isFixedEmployee);
  const varEmps      = employees.filter(isVariableEmployee);
  const events: AbsenceEvent[] = [];

  for (const emp of fixedEmps) {
    for (const day of days) {
      const dateStr = formatDate(day);
      const cellKey = `${emp.id}-${dateStr}`;
      const ds      = scheduleData[cellKey];
      if (!ds) continue;

      const codes = new Set<string>();
      if (ds.frühAbsence) codes.add(ds.frühAbsence);
      if (ds.spätAbsence) codes.add(ds.spätAbsence);
      if (codes.size === 0) continue;

      const absenceCode = [...codes][0];

      // Skip day-off codes ('F', 'Frei')
      if (SKIP_CODES.has(absenceCode)) continue;

      const kind = absenceKind(absenceCode);

      // Auto-detect replacements: var emps in same dept with actual shifts
      const autoReplacements: ReplacementInfo[] = [];
      for (const varEmp of varEmps) {
        if (varEmp.department !== emp.department) continue;
        const vKey    = `${varEmp.id}-${dateStr}`;
        const vDs     = scheduleData[vKey];
        const vActual = actualHours[vKey];

        let hours  = 0;
        let source: 'plan' | 'actual' = 'plan';

        if (vActual?.hours && vActual.hours > 0) {
          hours  = vActual.hours;
          source = 'actual';
        } else if (vDs && !vDs.frühAbsence && !vDs.spätAbsence) {
          hours  = netHoursFromSchedule(vDs);
        }

        if (hours > 0) {
          autoReplacements.push({
            empId:      varEmp.id,
            empName:    varEmp.name,
            hours,
            hourlyWage: varEmp.hourlyWage ?? 0,
            cost:       hours * (varEmp.hourlyWage ?? 0),
            source,
          });
        }
      }

      events.push({
        id:               `${emp.id}-${dateStr}`,
        empId:            emp.id,
        empName:          emp.name,
        dept:             emp.department,
        date:             dateStr,
        absenceCode,
        kind,
        plannedHours:     plannedHoursFor(emp),
        autoReplacements,
      });
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Apply manual overrides to an absence event and return the resolved event.
 */
export function resolveAbsenceEvent(
  ev:          AbsenceEvent,
  overrides:   Record<string, Override>,
  employees:   Employee[],
  scheduleData: Record<string, DaySchedule>,
  actualHours: Record<string, { hours: number }>,
): ResolvedEvent {
  const ovr          = overrides[ev.id];
  const plannedHours = ovr?.plannedHoursOverride ?? ev.plannedHours;
  const removed      = new Set(ovr?.removedAutoEmpIds ?? []);
  const effective    = ev.autoReplacements.filter(r => !removed.has(r.empId));

  // Add manually assigned employees
  for (const empId of (ovr?.addedEmpIds ?? [])) {
    if (effective.some(r => r.empId === empId)) continue;
    const emp = employees.find(e => e.id === empId);
    if (!emp) continue;
    const vKey    = `${empId}-${ev.date}`;
    const vDs     = scheduleData[vKey];
    const vActual = actualHours[vKey];
    let hours = 0;
    let source: 'plan' | 'actual' = 'plan';
    if (vActual?.hours && vActual.hours > 0) { hours = vActual.hours; source = 'actual'; }
    else if (vDs) { hours = netHoursFromSchedule(vDs); }
    if (hours === 0) hours = plannedHours;
    effective.push({
      empId, empName: emp.name, hours,
      hourlyWage: emp.hourlyWage ?? 0,
      cost: hours * (emp.hourlyWage ?? 0),
      source,
    });
  }

  const replacedHours   = effective.reduce((s, r) => s + r.hours, 0);
  const replacedCost    = effective.reduce((s, r) => s + r.cost,  0);
  const unreplacedHours = Math.max(0, plannedHours - replacedHours);

  // Estimate saving: avg variable wage × unreplaced hours
  const varEmpsWithWage = employees.filter(isVariableEmployee).filter(e => (e.hourlyWage ?? 0) > 0);
  const avgWage = effective.length > 0
    ? effective.reduce((s, r) => s + r.hourlyWage, 0) / effective.length
    : varEmpsWithWage.length > 0
      ? varEmpsWithWage.reduce((s, e) => s + (e.hourlyWage ?? 0), 0) / varEmpsWithWage.length
      : 0;

  return {
    ...ev,
    plannedHours,
    effectiveReplacements: effective,
    replacedHours,
    replacedCost,
    unreplacedHours,
    saving: unreplacedHours * avgWage,
  };
}

/**
 * Summarize a list of resolved events into KPI totals.
 */
export function summarizeAbsences(events: ResolvedEvent[]): AbsenceSummary {
  const vacation = events.filter(e => e.kind === 'vacation');
  const sick     = events.filter(e => e.kind === 'sick');
  const accident = events.filter(e => e.kind === 'accident');

  const byDept = {
    service: { cost: 0, saving: 0, days: 0 },
    küche:   { cost: 0, saving: 0, days: 0 },
  };
  for (const e of events) {
    const d = e.dept === 'service' ? byDept.service : byDept.küche;
    d.cost   += e.replacedCost;
    d.saving += e.saving;
    d.days   += 1;
  }

  return {
    vacationDays:  vacation.length,
    sickDays:      sick.length,
    accidentDays:  accident.length,
    vacationCost:  vacation.reduce((s, e) => s + e.replacedCost, 0),
    sickCost:      sick.reduce((s, e) => s + e.replacedCost, 0),
    accidentCost:  accident.reduce((s, e) => s + e.replacedCost, 0),
    totalCost:     events.reduce((s, e) => s + e.replacedCost, 0),
    totalSaving:   events.reduce((s, e) => s + e.saving, 0),
    unreplacedHrs: events.reduce((s, e) => s + e.unreplacedHours, 0),
    byDept,
  };
}

/** Load overrides from localStorage */
export function loadAbsenceOverrides(): Record<string, Override> {
  try {
    const raw = localStorage.getItem(LS_ABSENCE_OVERRIDES);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
