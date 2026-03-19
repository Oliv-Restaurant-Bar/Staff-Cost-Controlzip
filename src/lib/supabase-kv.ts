/**
 * Supabase Key-Value Store
 * ========================
 * Liest und schreibt Daten in die bestehende `app_settings`-Tabelle.
 * Wird als persistenter Backend-Speicher für reporting_v1, budget_v1
 * und dailyBudgets genutzt (Fallback: localStorage).
 *
 * Durch diese Schicht bleiben Daten auch nach Logout / Browser-Wechsel
 * erhalten, weil sie im Supabase-Backend gespeichert werden.
 */

import { supabase } from '@/integrations/supabase/client';

type Listener = () => void;

const _listeners = new Map<string, Set<Listener>>();
let _available: boolean | null = null;

export function subscribeKV(key: string, fn: Listener): () => void {
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key)!.add(fn);
  return () => _listeners.get(key)?.delete(fn);
}

function notifyKV(key: string) {
  _listeners.get(key)?.forEach(fn => fn());
}

async function isAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const { error } = await (supabase as any)
      .from('app_settings')
      .select('key')
      .limit(1);
    _available = !error;
  } catch {
    _available = false;
  }
  return _available;
}

export async function kvGet(key: string): Promise<unknown | null> {
  if (!(await isAvailable())) return null;
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) return null;
    return data?.value ?? null;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!(await isAvailable())) return;
  try {
    await (supabase as any)
      .from('app_settings')
      .upsert({ key, value }, { onConflict: 'key' });
    notifyKV(key);
  } catch {
    // silently fail – localStorage bleibt primärer Speicher
  }
}

/**
 * Sync alle bekannten localStorage-Schlüssel zu Supabase.
 * Wird nach Login aufgerufen.
 */
export async function syncLocalToSupabase(keys: string[]): Promise<void> {
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        await kvSet(key, parsed);
      } catch {
        // skip if not valid JSON
      }
    }
  }
}

/**
 * Lädt alle bekannten Schlüssel aus Supabase in localStorage –
 * aber nur, wenn localStorage für diesen Schlüssel leer ist.
 * Lokale Daten haben immer Vorrang (localStorage = primärer Speicher).
 * Gibt true zurück wenn mindestens ein Schlüssel geladen wurde.
 */
export async function syncSupabaseToLocal(keys: string[]): Promise<boolean> {
  let changed = false;
  for (const key of keys) {
    const local = localStorage.getItem(key);
    // Nur holen wenn localStorage leer oder leeres Objekt enthält
    const localIsEmpty = !local || local === '{}' || local === '[]' || local === 'null';
    if (!localIsEmpty) continue;

    const remote = await kvGet(key);
    if (remote !== null) {
      const remoteStr = JSON.stringify(remote);
      if (remoteStr !== '{}' && remoteStr !== '[]' && remoteStr !== 'null') {
        localStorage.setItem(key, remoteStr);
        notifyKV(key);
        changed = true;
      }
    }
  }
  return changed;
}
