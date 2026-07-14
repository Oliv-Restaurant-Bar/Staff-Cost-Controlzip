/**
 * schedule-templates.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Weekly schedule templates and weekday staffing patterns.
 * All data is persisted to localStorage so no backend changes are needed.
 */

import { format } from 'date-fns';
import { Employee } from '@/types/personnel';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';

// ─── Typen ────────────────────────────────────────────────────────────────────

export type TemplateDept    = 'all' | 'service' | 'küche';
export type DemandBand      = 'low' | 'normal' | 'high';
export type ApplyMode       = 'overwrite' | 'merge';

export interface TemplateEntry {
  employeeId:    string;
  employeeName:  string;
  /** JS getDay() convention: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat */
  dayOfWeek:     number;
  früh?:         { start: string; end: string } | null;
  spät?:         { start: string; end: string } | null;
  frühAbsence?:  string | null;
  spätAbsence?:  string | null;
}

export interface WeekTemplate {
  id:          string;
  name:        string;
  department:  TemplateDept;
  demandBand?: DemandBand;
  notes?:      string;
  createdAt:   string;   // ISO
  entryCount:  number;   // cached count
  entries:     TemplateEntry[];
}

// ─── Schlüssel ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'schedule_templates_v1';

// ─── Laden / Speichern ────────────────────────────────────────────────────────

export function loadTemplates(): WeekTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WeekTemplate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTemplate(template: WeekTemplate): void {
  const all = loadTemplates();
  const idx = all.findIndex(t => t.id === template.id);
  if (idx >= 0) {
    all[idx] = template;
  } else {
    all.unshift(template); // newest first
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function deleteTemplate(id: string): void {
  const all = loadTemplates().filter(t => t.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

// ─── Aktuelle Woche als Vorlage erfassen ──────────────────────────────────────

/**
 * Captures the currently displayed week into a reusable WeekTemplate.
 *
 * @param employees     All employees (to filter by dept if needed)
 * @param weekDays      The days currently displayed (the template week)
 * @param scheduleData  Current full schedule map
 * @param name          User-provided template name
 * @param department    Which dept to include ('all' captures both)
 * @param demandBand    Optional demand classification
 * @param notes         Optional free-text notes
 */
export function captureWeek(
  employees: Employee[],
  weekDays:  Date[],
  scheduleData: Record<string, DaySchedule>,
  name:      string,
  department: TemplateDept,
  demandBand?: DemandBand,
  notes?: string,
): WeekTemplate {
  const entries: TemplateEntry[] = [];

  for (const emp of employees) {
    if (department !== 'all' && emp.department !== department) continue;

    for (const day of weekDays) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const key     = `${emp.id}-${dateStr}`;
      const ds      = scheduleData[key];
      if (!ds) continue;

      const hasFrüh = ds.früh?.start || ds.frühAbsence;
      const hasSpät = ds.spät?.start || ds.spätAbsence;
      if (!hasFrüh && !hasSpät) continue;

      entries.push({
        employeeId:   emp.id,
        employeeName: emp.name,
        dayOfWeek:    day.getDay(),
        früh:         ds.früh  ? { start: ds.früh.start,  end: ds.früh.end  } : null,
        spät:         ds.spät  ? { start: ds.spät.start,  end: ds.spät.end  } : null,
        frühAbsence:  ds.frühAbsence ?? null,
        spätAbsence:  ds.spätAbsence ?? null,
      });
    }
  }

  return {
    id:         `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    department,
    demandBand,
    notes,
    createdAt:  new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };
}

// ─── Vorlage anwenden ─────────────────────────────────────────────────────────

export interface ApplyOptions {
  /** Dept filter — 'all' applies everything in the template */
  department: TemplateDept;
  /** 'overwrite' = replace existing entries; 'merge' = skip occupied slots */
  mode: ApplyMode;
  /**
   * If provided, only apply entries for this specific dayOfWeek.
   * Useful for the "Wochentag-Muster" (single-day apply) feature.
   */
  onlyDayOfWeek?: number;
}

/**
 * Applies a template to a target week and returns the changed entries
 * (caller merges them into scheduleData via setScheduleData).
 *
 * Employee matching: by ID first, then by name (case-insensitive) as fallback.
 * Unknown employees are skipped.
 */
export function applyTemplate(
  template:  WeekTemplate,
  weekDays:  Date[],
  employees: Employee[],
  existing:  Record<string, DaySchedule>,
  opts:      ApplyOptions,
): Record<string, DaySchedule> {
  // Build a dayOfWeek → Date map for the target week
  const dayMap: Record<number, Date> = {};
  for (const day of weekDays) dayMap[day.getDay()] = day;

  // Build employee lookup maps
  const byId   = new Map(employees.map(e => [e.id, e]));
  const byName = new Map(employees.map(e => [e.name.toLowerCase().trim(), e]));

  const delta: Record<string, DaySchedule> = {};

  for (const entry of template.entries) {
    // Dept filter
    if (opts.department !== 'all') {
      const emp = byId.get(entry.employeeId) ?? byName.get(entry.employeeName.toLowerCase().trim());
      if (!emp || emp.department !== opts.department) continue;
    }

    // Day filter (for single-day apply)
    if (opts.onlyDayOfWeek !== undefined && entry.dayOfWeek !== opts.onlyDayOfWeek) continue;

    // Map to actual date
    const targetDay = dayMap[entry.dayOfWeek];
    if (!targetDay) continue; // that weekday doesn't exist in the target week

    // Resolve employee
    const resolvedEmp =
      byId.get(entry.employeeId) ??
      byName.get(entry.employeeName.toLowerCase().trim());
    if (!resolvedEmp) continue;

    const dateStr = format(targetDay, 'yyyy-MM-dd');
    const cellKey = `${resolvedEmp.id}-${dateStr}`;

    // Merge mode: skip if the slot already has data
    if (opts.mode === 'merge') {
      const cur = existing[cellKey] ?? delta[cellKey];
      if (cur) {
        const occupied = (cur.früh?.start || cur.frühAbsence) ||
                         (cur.spät?.start || cur.spätAbsence);
        if (occupied) continue;
      }
    }

    delta[cellKey] = {
      früh:        entry.früh        ?? undefined,
      spät:        entry.spät        ?? undefined,
      frühAbsence: entry.frühAbsence ?? null,
      spätAbsence: entry.spätAbsence ?? null,
    };
  }

  return delta;
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

export const WEEKDAY_LABELS: Record<number, string> = {
  0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa',
};

export const WEEKDAY_LABELS_LONG: Record<number, string> = {
  0: 'Sonntag', 1: 'Montag', 2: 'Dienstag', 3: 'Mittwoch',
  4: 'Donnerstag', 5: 'Freitag', 6: 'Samstag',
};

export const DEMAND_BAND_LABELS: Record<DemandBand, string> = {
  low:    'Ruhiger Tag',
  normal: 'Normaltag',
  high:   'Volllast / Event',
};

export const DEMAND_BAND_COLORS: Record<DemandBand, string> = {
  low:    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  normal: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  high:   'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800',
};
