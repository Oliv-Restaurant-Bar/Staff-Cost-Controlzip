/**
 * staffing-targets.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Defines Mindest- and Idealbesetzung per dept × weekday × slot.
 * All data stored in localStorage — no backend required.
 */

import { format } from 'date-fns';
import { Department } from '@/types/personnel';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type SlotType = 'früh' | 'spät';

export interface StaffingTarget {
  id:         string;
  department: Department;
  /** JS getDay(): 0=Sun, 1=Mon … 6=Sat */
  dayOfWeek:  number;
  slot:       SlotType;
  minStaff:   number;   // Mindestbesetzung
  idealStaff: number;   // Idealbesetzung
}

export type StaffingStatusLevel = 'under' | 'ok' | 'over' | 'unconfigured';

export interface StaffingStatus {
  actual:     number;
  min:        number;
  ideal:      number;
  status:     StaffingStatusLevel;
}

// ─── Speicher ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'staffing_targets_v1';

export function loadTargets(): StaffingTarget[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StaffingTarget[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTargets(targets: StaffingTarget[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(targets));
}

export function upsertTarget(target: StaffingTarget): void {
  const all = loadTargets();
  const idx = all.findIndex(t => t.id === target.id);
  if (idx >= 0) all[idx] = target; else all.push(target);
  saveTargets(all);
}

export function deleteTarget(id: string): void {
  saveTargets(loadTargets().filter(t => t.id !== id));
}

/** Find the target for a specific (dept, dayOfWeek, slot) combination */
export function getTarget(
  targets:   StaffingTarget[],
  dept:      Department,
  dayOfWeek: number,
  slot:      SlotType,
): StaffingTarget | null {
  return targets.find(
    t => t.department === dept && t.dayOfWeek === dayOfWeek && t.slot === slot
  ) ?? null;
}

// ─── Besetzungsberechnung ─────────────────────────────────────────────────────

/**
 * Count how many employees from a given dept have a real (non-absence) shift
 * in the specified slot on the specified date.
 */
export function countActualStaff(
  employees:    Employee[],
  scheduleData: Record<string, DaySchedule>,
  dateStr:      string,
  dept:         Department,
  slot:         SlotType,
): number {
  return employees.filter(emp => {
    if (emp.department !== dept) return false;
    const ds = scheduleData[`${emp.id}-${dateStr}`];
    if (!ds) return false;
    if (slot === 'früh') return !!(ds.früh?.start && !ds.frühAbsence);
    return !!(ds.spät?.start && !ds.spätAbsence);
  }).length;
}

/**
 * Full staffing status for one (dept, date, slot) cell.
 */
export function computeStaffingStatus(
  targets:      StaffingTarget[],
  employees:    Employee[],
  scheduleData: Record<string, DaySchedule>,
  date:         Date,
  dept:         Department,
  slot:         SlotType,
): StaffingStatus {
  const dateStr = format(date, 'yyyy-MM-dd');
  const target  = getTarget(targets, dept, date.getDay(), slot);
  const actual  = countActualStaff(employees, scheduleData, dateStr, dept, slot);

  if (!target) {
    return { actual, min: 0, ideal: 0, status: 'unconfigured' };
  }

  let status: StaffingStatusLevel;
  if (actual < target.minStaff)        status = 'under';
  else if (actual > target.idealStaff) status = 'over';
  else                                  status = 'ok';

  return { actual, min: target.minStaff, ideal: target.idealStaff, status };
}

// ─── Hilfslabel ───────────────────────────────────────────────────────────────

export const WEEKDAY_SHORT: Record<number, string> = {
  0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa',
};
export const WEEKDAY_LONG: Record<number, string> = {
  0: 'Sonntag', 1: 'Montag', 2: 'Dienstag', 3: 'Mittwoch',
  4: 'Donnerstag', 5: 'Freitag', 6: 'Samstag',
};
export const SLOT_LABEL: Record<SlotType, string> = { früh: 'Früh', spät: 'Spät' };

/** Tailwind classes for each status level */
export const STATUS_CLASSES: Record<StaffingStatusLevel, string> = {
  under:        'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  ok:           'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  over:         'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
  unconfigured: 'bg-muted/40 text-muted-foreground border-border',
};

export const STATUS_ICON: Record<StaffingStatusLevel, string> = {
  under: '↓', ok: '✓', over: '↑', unconfigured: '–',
};

/** Human-readable status label */
export function statusLabel(s: StaffingStatus, slot: SlotType, dept: Department): string {
  const slotStr = SLOT_LABEL[slot];
  const deptStr = dept === 'service' ? 'Service' : 'Küche';
  if (s.status === 'under')  return `${deptStr} ${slotStr}: ${s.actual} von mind. ${s.min} besetzt`;
  if (s.status === 'ok')     return `${deptStr} ${slotStr}: ${s.actual} (Ziel ${s.min}–${s.ideal}) ✓`;
  if (s.status === 'over')   return `${deptStr} ${slotStr}: ${s.actual} — über Ideal (${s.ideal})`;
  return `${deptStr} ${slotStr}: ${s.actual} (kein Ziel definiert)`;
}

/** Returns a concise planning-assistant description for under/over situations */
export function staffingHint(s: StaffingStatus, slot: SlotType, dept: Department, dayLabel: string): string | null {
  if (s.status === 'under') {
    const missing = s.min - s.actual;
    return `${dayLabel} ${SLOT_LABEL[slot]} ${dept === 'service' ? 'Service' : 'Küche'}: ${missing} Person${missing !== 1 ? 'en' : ''} unter Mindestbesetzung`;
  }
  if (s.status === 'over') {
    const excess = s.actual - s.ideal;
    return `${dayLabel} ${SLOT_LABEL[slot]} ${dept === 'service' ? 'Service' : 'Küche'}: ${excess} Person${excess !== 1 ? 'en' : ''} über Idealbesetzung`;
  }
  return null;
}
