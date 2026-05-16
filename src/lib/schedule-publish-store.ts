import { kvGet, kvSet } from '@/lib/supabase-kv';

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
  /** Change tracking — set when re-publishing with modifications */
  changed?: boolean;
  changeType?: 'new' | 'changed';
  previousFrüh?: PublicTimeSlot | null;
  previousSpät?: PublicTimeSlot | null;
}

export interface ChangeHistoryEntry {
  timestamp: string;
  description: string;
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
  managerNote?: string;
  changeHistory?: ChangeHistoryEntry[];
}

const LS_PREFIX  = 'schedule-publish:';
const KV_PREFIX  = 'published-schedule:';

function kvKey(token: string): string {
  return KV_PREFIX + token;
}

/**
 * Save a published schedule payload.
 * Writes to localStorage immediately (fast, same-device access),
 * then persists to Supabase KV so other devices can load it via the token.
 */
export async function savePublishedSchedule(
  token: string,
  payload: PublishedSchedulePayload,
): Promise<void> {
  // 1. localStorage — instant, same device
  try {
    localStorage.setItem(LS_PREFIX + token, JSON.stringify(payload));
  } catch (e) {
    console.warn('[publish] localStorage write failed:', e);
  }

  // 2. Supabase KV — persistent, cross-device
  try {
    await kvSet(kvKey(token), payload);
    console.log(`[publish] token=${token} saved to Supabase KV`);
  } catch (e) {
    console.error('[publish] Supabase KV write failed:', e);
    // Non-fatal: localStorage is the fallback on the publishing device
  }
}

/**
 * Load a published schedule synchronously from localStorage.
 * Returns null if not in localStorage (e.g., on a different device).
 * Use `loadPublishedScheduleAsync` for cross-device support.
 */
export function loadPublishedSchedule(token: string): PublishedSchedulePayload | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + token);
    if (!raw) return null;
    return JSON.parse(raw) as PublishedSchedulePayload;
  } catch (e) {
    console.error('[publish] localStorage read failed:', e);
    return null;
  }
}

/**
 * Load a published schedule with full cross-device support:
 * 1. Try localStorage first (instant, zero latency)
 * 2. Fall back to Supabase KV (persistent, works on any device)
 *
 * Also writes back to localStorage after a successful Supabase fetch
 * so subsequent loads on the same device are instant.
 */
export async function loadPublishedScheduleAsync(
  token: string,
): Promise<PublishedSchedulePayload | null> {
  // Fast path: localStorage
  const local = loadPublishedSchedule(token);
  if (local) {
    console.log(`[publish] token=${token} loaded from localStorage`);
    return local;
  }

  // Slow path: Supabase KV — this is what makes cross-device links work
  try {
    const remote = await kvGet(kvKey(token));
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      const payload = remote as PublishedSchedulePayload;
      // Cache locally so next visit on this device is instant
      try {
        localStorage.setItem(LS_PREFIX + token, JSON.stringify(payload));
      } catch { /* ignore */ }
      console.log(`[publish] token=${token} loaded from Supabase KV`);
      return payload;
    }
  } catch (e) {
    console.error('[publish] Supabase KV read failed:', e);
  }

  console.warn(`[publish] token=${token} not found in localStorage or Supabase KV`);
  return null;
}
