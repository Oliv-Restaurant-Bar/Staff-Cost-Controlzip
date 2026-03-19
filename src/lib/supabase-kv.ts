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
 * Feld-Level-Merge zweier reporting_v1-Objekte.
 * Für jeden Monatsdatensatz gewinnt das Feld mit dem "mehr Inhalt":
 * - arrays: längere Liste gewinnt
 * - numbers: Wert > 0 gewinnt; wenn beide > 0 → local gewinnt
 * - sonstige: local gewinnt wenn definiert, sonst remote
 */
function mergeReportingV1(
  local: Record<string, Record<string, unknown>>,
  remote: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const result: Record<string, Record<string, unknown>> = {};
  for (const monthKey of allKeys) {
    const l = local[monthKey] ?? {};
    const r = remote[monthKey] ?? {};
    const merged: Record<string, unknown> = { ...r };
    for (const field of Object.keys(l)) {
      const lv = l[field];
      const rv = r[field];
      if (Array.isArray(lv) && Array.isArray(rv)) {
        merged[field] = lv.length >= rv.length ? lv : rv;
      } else if (typeof lv === 'number' && typeof rv === 'number') {
        merged[field] = (lv > 0 ? lv : rv);
      } else {
        merged[field] = lv !== undefined && lv !== null ? lv : rv;
      }
    }
    result[monthKey] = merged;
  }
  return result;
}

/**
 * Sync bekannte localStorage-Schlüssel zu Supabase.
 *
 * Für 'reporting_v1': Feld-Level-Merge (local + remote vereinigt),
 *   damit VJ-Daten aus Preview nie durch einen stalen Published-Stand
 *   überschrieben werden.
 * Für alle anderen Schlüssel: nur hochladen wenn Supabase leer ist
 *   (verhindert Überschreiben mit veralteten Daten).
 */
export async function syncLocalToSupabase(keys: string[]): Promise<void> {
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const local = JSON.parse(raw);
      const remote = await kvGet(key);
      const remoteIsEmpty = remote === null
        || remote === undefined
        || JSON.stringify(remote) === '{}'
        || JSON.stringify(remote) === '[]';

      if (key === 'reporting_v1' && !remoteIsEmpty) {
        // Smart merge: vereinige local + remote auf Feldebene
        const merged = mergeReportingV1(
          local as Record<string, Record<string, unknown>>,
          remote as Record<string, Record<string, unknown>>,
        );
        const mergedStr = JSON.stringify(merged);
        const remoteStr = JSON.stringify(remote);
        if (mergedStr !== remoteStr) {
          await kvSet(key, merged);
          localStorage.setItem(key, mergedStr);
          console.log(`[KV] syncLocalToSupabase: 'reporting_v1' → Merge hochgeladen`);
        } else {
          console.log(`[KV] syncLocalToSupabase: 'reporting_v1' – kein Merge-Unterschied`);
        }
        continue;
      }

      if (!remoteIsEmpty) {
        console.log(`[KV] syncLocalToSupabase: überspringe '${key}' – Supabase hat bereits Daten`);
        continue;
      }
      await kvSet(key, local);
      console.log(`[KV] syncLocalToSupabase: '${key}' → Supabase (Erstmigration)`);
    } catch {
      // skip if not valid JSON
    }
  }
}

/**
 * Lädt alle bekannten Schlüssel aus Supabase in localStorage.
 * Supabase ist der Master-Speicher – lokale Daten werden IMMER
 * mit dem Supabase-Stand überschrieben, wenn Supabase Daten hat.
 * So landen neue PY-Daten (aus Preview importiert) auch in der
 * Published-App, selbst wenn deren localStorage schon (alten) Stand hat.
 * Gibt true zurück wenn mindestens ein Schlüssel aktualisiert wurde.
 */
export async function syncSupabaseToLocal(keys: string[]): Promise<boolean> {
  let changed = false;
  for (const key of keys) {
    const remote = await kvGet(key);
    if (remote === null || remote === undefined) {
      console.log(`[KV] syncSupabaseToLocal: '${key}' – kein Eintrag in Supabase`);
      continue;
    }
    const remoteStr = JSON.stringify(remote);
    if (remoteStr === '{}' || remoteStr === '[]' || remoteStr === 'null') {
      console.log(`[KV] syncSupabaseToLocal: '${key}' – Supabase leer, überspringe`);
      continue;
    }

    const localStr = localStorage.getItem(key) ?? '';
    if (localStr === remoteStr) {
      console.log(`[KV] syncSupabaseToLocal: '${key}' – identisch, kein Update nötig`);
      continue;
    }

    // Vorjahr-Diagnose: Einträge mit revenuePreviousYear zählen
    if (key === 'reporting_v1') {
      try {
        const obj = remote as Record<string, { revenuePreviousYear?: number }>;
        const pyCount = Object.values(obj).filter(m => m?.revenuePreviousYear !== undefined && m.revenuePreviousYear > 0).length;
        const totalCount = Object.keys(obj).length;
        console.log(`[KV] syncSupabaseToLocal: 'reporting_v1' – ${totalCount} Monate total, ${pyCount} mit revenuePreviousYear > 0`);
      } catch { /* ignore */ }
    }

    localStorage.setItem(key, remoteStr);
    notifyKV(key);
    changed = true;
    console.log(`[KV] syncSupabaseToLocal: '${key}' → localStorage (${remoteStr.length} Zeichen)`);
  }
  return changed;
}
