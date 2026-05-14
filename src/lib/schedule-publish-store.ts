export interface PublicTimeSlot {
  start: string;
  end: string;
}

export interface PublicDayEntry {
  date: string;
  dayLabel: string;
  früh?: PublicTimeSlot | null;
  spät?: PublicTimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

export interface PublicEmployee {
  id: string;
  name: string;
  department: 'service' | 'küche';
  days: PublicDayEntry[];
}

export type PublishType = 'department' | 'personal';
export type PublishDept = 'service' | 'küche' | 'all';
export type PublishPeriod = 'week' | 'month';

export interface PublishedSchedulePayload {
  type: PublishType;
  period: PublishPeriod;
  restaurant: string;
  kw: number;
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  publishedAt: string;
  status: 'draft' | 'published' | 'changed';
  department?: PublishDept;
  employees?: PublicEmployee[];
  employeeId?: string;
  employeeName?: string;
}

const STORAGE_PREFIX = 'schedule-publish:';

export function savePublishedSchedule(token: string, payload: PublishedSchedulePayload): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + token, JSON.stringify(payload));
  } catch (e) {
    console.error('[publish] Failed to save schedule:', e);
  }
}

export function loadPublishedSchedule(token: string): PublishedSchedulePayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + token);
    if (!raw) return null;
    return JSON.parse(raw) as PublishedSchedulePayload;
  } catch (e) {
    console.error('[publish] Failed to load schedule:', e);
    return null;
  }
}
