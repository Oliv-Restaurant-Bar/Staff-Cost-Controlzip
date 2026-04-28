/**
 * prior-year-lock.ts
 * ==================
 * Lock-Mechanismus für Vorjahreszahlen (VJ-Daten).
 *
 * Verhindert dass bereits bestätigte VJ-Daten durch neue Imports,
 * Fallback-Logik oder Seed-Hooks überschrieben werden.
 *
 * Speicherung: Supabase app_settings
 *   key   = "prior_year_locked:{tenantId}:{year}"
 *   value = PriorYearLockState
 *
 * Beispiele:
 *   prior_year_locked:oliv:2025     → { locked: true, ... }
 *   prior_year_locked:beaulieu:2025 → { locked: false }
 *
 * Debug-Logs:
 *   [PRIOR-YEAR] tenant: beaulieu | year: 2025 | locked: true
 *   [PRIOR-YEAR] import blocked: locked
 *   [PRIOR-YEAR] values preserved: yes
 */

import { supabase } from '@/integrations/supabase/client';

// ── Typen ──────────────────────────────────────────────────────────────────

export interface PriorYearLockState {
  locked:     boolean;
  lockedAt?:  string;    // ISO timestamp
  lockedBy?:  string;    // 'admin'
  source?:    string;    // 'vorjahr_import' | 'seed_2025' | 'manual'
  days?:      number;    // Anzahl importierte Tage
  year?:      number;
  tenantId?:  string;
}

// ── Key-Generierung ────────────────────────────────────────────────────────

function lockKey(tenantId: string, year: number): string {
  return `prior_year_locked:${tenantId}:${year}`;
}

// ── Lesen ──────────────────────────────────────────────────────────────────

export async function getLockState(
  tenantId: string,
  year: number,
): Promise<PriorYearLockState> {
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('value')
      .eq('key', lockKey(tenantId, year))
      .maybeSingle();

    if (error || !data) return { locked: false };
    const val = data.value as PriorYearLockState;
    const state = val ?? { locked: false };

    console.log(`[PRIOR-YEAR] tenant: ${tenantId} | year: ${year} | locked: ${state.locked}`);
    return state;
  } catch {
    return { locked: false };
  }
}

export async function isLocked(tenantId: string, year: number): Promise<boolean> {
  const state = await getLockState(tenantId, year);
  return state.locked === true;
}

// ── Schreiben ──────────────────────────────────────────────────────────────

export async function setLockState(
  tenantId: string,
  year: number,
  state: PriorYearLockState,
): Promise<{ error: string | null }> {
  const key = lockKey(tenantId, year);
  try {
    const { error } = await (supabase as any)
      .from('app_settings')
      .upsert(
        { key, value: { ...state, tenantId, year } as unknown as Record<string, unknown> },
        { onConflict: 'key' },
      );
    if (error) return { error: error.message };
    console.log(`[PRIOR-YEAR] tenant: ${tenantId} | year: ${year} | locked: ${state.locked} | written`);
    return { error: null };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function lockYear(
  tenantId: string,
  year: number,
  opts: { source?: string; days?: number } = {},
): Promise<{ error: string | null }> {
  const state: PriorYearLockState = {
    locked:   true,
    lockedAt: new Date().toISOString(),
    lockedBy: 'admin',
    source:   opts.source ?? 'manual',
    ...(opts.days !== undefined ? { days: opts.days } : {}),
  };
  console.log(`[PRIOR-YEAR] tenant: ${tenantId} | year: ${year} | locking`);
  return setLockState(tenantId, year, state);
}

export async function unlockYear(
  tenantId: string,
  year: number,
): Promise<{ error: string | null }> {
  console.log(`[PRIOR-YEAR] tenant: ${tenantId} | year: ${year} | unlocking`);
  return setLockState(tenantId, year, { locked: false });
}

// ── Import-Guard ───────────────────────────────────────────────────────────

/**
 * Prüft ob ein Import erlaubt ist.
 * Gibt true zurück wenn Import blockiert (locked).
 * Loggt den Versuch.
 */
export async function checkImportBlocked(
  tenantId: string,
  year: number,
): Promise<{ blocked: boolean; state: PriorYearLockState }> {
  const state = await getLockState(tenantId, year);
  if (state.locked) {
    console.warn(
      `[PRIOR-YEAR] import blocked: locked | tenant: ${tenantId} | year: ${year}` +
      ` | lockedAt: ${state.lockedAt ?? '?'} | source: ${state.source ?? '?'}`,
    );
    return { blocked: true, state };
  }
  console.log(`[PRIOR-YEAR] values preserved: yes | tenant: ${tenantId} | year: ${year} | import allowed`);
  return { blocked: false, state };
}

// ── Hilfsfunktion: Formatierung ────────────────────────────────────────────

export function formatLockedAt(lockedAt?: string): string {
  if (!lockedAt) return '–';
  try {
    return new Date(lockedAt).toLocaleString('de-CH', {
      day:    '2-digit',
      month:  '2-digit',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
    });
  } catch {
    return lockedAt;
  }
}
