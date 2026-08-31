import type { ControlListDay, ShiftWindow } from './control-list-import';

export const TIMELINE_START = 7;
export const TIMELINE_END = 26;
export const TIMELINE_HOURS = TIMELINE_END - TIMELINE_START;
export type TimelineScope = 'week' | 'month' | 'year';

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export function calendarDatesForScope(anchorDate: string, scope: TimelineScope): string[] {
  const anchor = new Date(`${anchorDate}T00:00:00.000Z`);
  if (Number.isNaN(anchor.getTime())) return [];
  const start = scope === 'week'
    ? anchor
    : scope === 'month'
      ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
      : new Date(Date.UTC(anchor.getUTCFullYear(), 0, 1));
  const end = scope === 'week'
    ? new Date(start.getTime() + 7 * 86_400_000)
    : scope === 'month'
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
      : new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
  const dates: string[] = [];
  for (const cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(isoDate(cursor));
  return dates;
}

export function timelineWindow(window: ShiftWindow): ShiftWindow | null {
  let start = window.start;
  let end = window.end;
  if (end < start) end += 24;
  if (start < TIMELINE_START) {
    start += 24;
    if (end < 24) end += 24;
  }
  const clippedStart = Math.max(start, TIMELINE_START);
  const clippedEnd = Math.min(end, TIMELINE_END);
  return clippedEnd > clippedStart ? { start: clippedStart, end: clippedEnd } : null;
}

export function timelineStyle(window: ShiftWindow): { left: string; width: string } | null {
  const visible = timelineWindow(window);
  if (!visible) return null;
  return {
    left: `${((visible.start - TIMELINE_START) / TIMELINE_HOURS) * 100}%`,
    width: `${Math.max(((visible.end - visible.start) / TIMELINE_HOURS) * 100, 1.5)}%`,
  };
}

export function requiresTimelineAttention(day: Pick<ControlListDay, 'netHours' | 'effectiveWindows'>): boolean {
  return day.netHours >= 9 || day.effectiveWindows.some(window => window.end > 24 || window.end < window.start);
}

export function workedDays<T extends Pick<ControlListDay, 'netHours'>>(days: T[]): T[] {
  return days.filter(day => day.netHours > 0);
}