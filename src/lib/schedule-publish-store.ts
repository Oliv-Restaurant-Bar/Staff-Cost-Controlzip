import { supabase } from '@/integrations/supabase/client';

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

/** Prepared for future swap-request feature — not yet active in UI */
export interface SwapRequest {
  id: string;
  employeeId: string;
  date: string;
  shift: 'früh' | 'spät';
  requestedAt: string;
  status: 'pending' | 'accepted' | 'declined';
  note?: string;
}

export interface PublicEmployee {
  id: string;
  name: string;
  department: 'service' | 'küche';
  days: PublicDayEntry[];
  /** Reserved for future swap-request feature */
  swapRequests?: SwapRequest[];
}

export type PublishType = 'department' | 'personal';
export type PublishDept = 'service' | 'küche' | 'all';
export type PublishPeriod = 'week' | 'month';

export interface PublishedSchedulePayload {
  /** Payload schema version — increment when making breaking changes */
  version?: number;
  /** Publish revision — increments with every re-publish of the same stable key */
  revision?: number;
  type: PublishType;
  period: PublishPeriod;
  restaurant: string;
  kw: number;
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  /** ISO timestamp of first publish — never changes for a stable key */
  publishedAt: string;
  /** ISO timestamp of last update — changes on every re-publish */
  updatedAt?: string;
  status: 'draft' | 'published' | 'changed';
  department?: PublishDept;
  employees?: PublicEmployee[];
  employeeId?: string;
  employeeName?: string;
  managerNote?: string;
  changeHistory?: ChangeHistoryEntry[];
  /** Staff portal feature flags — snapshot of admin settings at publish time */
  settings?: import('@/lib/staff-portal-settings').StaffPortalSettings;
}

/**
 * Compute the stable, human-readable token for a tenant + department combination.
 * This token never changes, so admins can save the link to their home screen once
 * and it will always show the latest published schedule.
 *
 * Examples:
 *   oliv     + all     → "oliv-team"
 *   oliv     + service → "oliv-service"
 *   oliv     + küche   → "oliv-kueche"
 *   beaulieu + all     → "beaulieu-team"
 */
export function stablePublishToken(tenantId: string, dept: PublishDept): string {
  const deptSlug =
    dept === 'all'    ? 'team'    :
    dept === 'küche'  ? 'kueche'  :
    dept; // 'service'
  return `${tenantId}-${deptSlug}`;
}

const LS_PREFIX = 'schedule-publish:';
const KV_KEY_PREFIX = 'published-schedule:';

const WRITE_TIMEOUT_MS = 12_000;
const READ_TIMEOUT_MS  = 10_000;

function lsKey(token: string): string { return LS_PREFIX + token; }
function kvKey(token: string): string { return KV_KEY_PREFIX + token; }

/** Race a promise against a timeout. Throws if the timeout fires first. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[publish] ${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Direct Supabase helpers (bypass isAvailable() cache) ────────────────────
//
// WHY: The `isAvailable()` helper in supabase-kv.ts caches a boolean at module
// level. On the public /staff-schedule/:token page the visitor is NOT logged in.
// Before the anon RLS policy was added, any query to app_settings returned an
// RLS error → `_available = false` → ALL subsequent kvGet calls return null.
// Even after adding the anon policy the cache might have been set to false in
// a previous render. We bypass that cache entirely and talk to Supabase directly.
//
// REQUIRED: run supabase/migrations/20260517_published_schedule_public_read.sql
// in the Supabase SQL editor so anon users can SELECT rows matching
// 'published-schedule:%'.

async function supabaseRead(key: string): Promise<unknown | null> {
  console.log(`[publish] supabaseRead key="${key}"`);
  try {
    const { data, error } = await withTimeout(
      (supabase as any).from('app_settings').select('value').eq('key', key).maybeSingle(),
      READ_TIMEOUT_MS,
      'supabaseRead',
    );

    if (error) {
      console.error(`[publish] supabaseRead ERROR key="${key}":`, error.message, `(code=${error.code})`);
      return null;
    }
    if (!data) {
      console.warn(`[publish] supabaseRead: no row found for key="${key}"`);
      return null;
    }
    console.log(`[publish] supabaseRead: row found for key="${key}" ✓`);
    return data.value ?? null;
  } catch (e) {
    console.error(`[publish] supabaseRead threw for key="${key}":`, e);
    return null;
  }
}

async function supabaseWrite(
  key: string,
  value: unknown,
): Promise<{ ok: boolean; error?: string }> {
  console.log(`[publish] supabaseWrite key="${key}"`);
  try {
    const { error } = await withTimeout(
      (supabase as any).from('app_settings').upsert({ key, value }, { onConflict: 'key' }),
      WRITE_TIMEOUT_MS,
      'supabaseWrite',
    );

    if (error) {
      console.error(`[publish] supabaseWrite ERROR key="${key}":`, error.message, `(code=${error.code})`);
      return { ok: false, error: error.message };
    }
    console.log(`[publish] supabaseWrite: success for key="${key}" ✓`);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[publish] supabaseWrite threw for key="${key}":`, e);
    return { ok: false, error: msg };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save a published schedule payload.
 *
 * 1. Writes to localStorage immediately (fast, same-device access).
 * 2. Writes to Supabase app_settings via direct query (persistent, cross-device).
 *
 * Returns { ok: true } on success, { ok: false, error } on failure.
 * Callers should await this and check ok before showing a success toast.
 */
export async function savePublishedSchedule(
  token: string,
  payload: PublishedSchedulePayload,
): Promise<{ ok: boolean; error?: string }> {
  console.log(`[publish] savePublishedSchedule START  token="${token}"`);

  // 1. localStorage — instant, same-device
  try {
    localStorage.setItem(lsKey(token), JSON.stringify(payload));
    const lsKeys = Object.keys(localStorage).filter(k => k.startsWith(LS_PREFIX));
    console.log(`[publish] localStorage write OK. Active publish keys: [${lsKeys.join(', ')}]`);
  } catch (e) {
    console.warn('[publish] localStorage write failed:', e);
  }

  // 2. Supabase direct write — persistent, cross-device
  const result = await supabaseWrite(kvKey(token), payload);

  if (result.ok) {
    console.log(`[publish] savePublishedSchedule COMPLETE  token="${token}" ✓`);
  } else {
    console.error(`[publish] savePublishedSchedule FAILED  token="${token}":`, result.error);
  }

  return result;
}

/**
 * Immediately read back the payload from Supabase after publishing.
 * Returns true if the payload is readable by an anon user, false otherwise.
 * Call this right after savePublishedSchedule to confirm the write round-tripped.
 */
export async function validatePublishedSchedule(token: string): Promise<boolean> {
  console.log(`[publish] validatePublishedSchedule token="${token}"`);
  const data = await supabaseRead(kvKey(token));
  const ok = data !== null && typeof data === 'object' && !Array.isArray(data);
  console.log(`[publish] validate: ${ok ? 'OK ✓' : 'FAILED ✗'}  token="${token}"`);
  return ok;
}

/**
 * Load from localStorage only (synchronous, same-device).
 */
export function loadPublishedSchedule(token: string): PublishedSchedulePayload | null {
  try {
    const raw = localStorage.getItem(lsKey(token));
    if (!raw) {
      console.log(`[publish] loadPublishedSchedule: localStorage MISS  token="${token}"`);
      return null;
    }
    console.log(`[publish] loadPublishedSchedule: localStorage HIT  token="${token}"`);
    return JSON.parse(raw) as PublishedSchedulePayload;
  } catch (e) {
    console.error('[publish] localStorage read failed:', e);
    return null;
  }
}

/**
 * Load with full cross-device support.
 *
 * With stable tokens, Supabase is always queried first so employees always see
 * the latest published version — not a stale localStorage cache from a previous
 * visit. localStorage is used only as an offline fallback.
 *
 * 1. Supabase direct query — always fresh, bypasses isAvailable() cache,
 *    works for anon users provided the anon RLS policy is active.
 * 2. localStorage fallback — only if Supabase returns nothing (offline / error).
 */
export async function loadPublishedScheduleAsync(
  token: string,
): Promise<PublishedSchedulePayload | null> {
  console.log(`[publish] loadPublishedScheduleAsync START  token="${token}"`);

  // Primary: Supabase — always fetch fresh so stable-token re-publishes are
  // immediately visible to employees (no stale localStorage cache problem).
  const key    = kvKey(token);
  const remote = await supabaseRead(key);

  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    const p = remote as PublishedSchedulePayload;
    try {
      localStorage.setItem(lsKey(token), JSON.stringify(p));
      console.log(`[publish] loadPublishedScheduleAsync: Supabase HIT (revision=${p.revision ?? '?'}), cached to localStorage`);
    } catch { /* ignore */ }
    return p;
  }

  // Fallback: localStorage (offline / Supabase unavailable)
  const local = loadPublishedSchedule(token);
  if (local) {
    console.log(`[publish] loadPublishedScheduleAsync: Supabase miss, returning localStorage fallback (revision=${local.revision ?? '?'})`);
    return local;
  }

  console.warn(
    `[publish] loadPublishedScheduleAsync: MISS  token="${token}"`,
    '(Supabase=null, localStorage=null)',
    '→ check anon RLS policy and that the token was saved',
  );
  return null;
}
