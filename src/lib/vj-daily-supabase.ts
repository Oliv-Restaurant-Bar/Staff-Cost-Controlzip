/**
 * vj-daily-supabase.ts
 * ====================
 * Persistente Speicherung von Vorjahres-Tagesumsätzen in Supabase.
 *
 * Speicherstruktur (Tabelle: app_settings)
 * -----------------------------------------
 *   key   = "vj_daily:2025-04-03"
 *   value = {
 *     date:          "2025-04-03",
 *     year:          2025,
 *     actualRevenue: 7118.50,       // = Gesamt (Brutto)
 *     foodRevenue:   3245.00,       // optional
 *     beverageRevenue: 3873.50,     // optional
 *     source:        "vorjahr_import"
 *   }
 *
 * Pro Datum = eine Zeile in app_settings → Upsert (kein Doppeln).
 *
 * Debug-Logs
 * ----------
 *   [VJ-SUPABASE] rows parsed: 365
 *   [VJ-SUPABASE] rows upserted to supabase: 365
 *   [VJ-SUPABASE] source of truth: supabase
 *   [VJ-SUPABASE] loaded month 2025-04: 30 rows from supabase
 *   [VJ-SUPABASE] fallback: using dailyBudgets blob
 */

import { supabase } from '@/integrations/supabase/client';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface VjDayRecord {
  date:            string;     // "2025-04-03"
  year:            number;
  actualRevenue:   number;
  foodRevenue?:    number;
  beverageRevenue?: number;
  source:          string;     // "vorjahr_import"
}

const KEY_PREFIX = 'vj_daily:';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function keyOf(date: string): string {
  return `${KEY_PREFIX}${date}`;
}

function keyOfMonth(year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return `${KEY_PREFIX}${year}-${mm}-`;
}

// ── Schreiben: Batch-Upsert ───────────────────────────────────────────────────

/**
 * Speichert VJ-Tagesumsätze für ein ganzes Jahr per Batch-Upsert in Supabase.
 * Bestehende Datensätze für dasselbe Datum werden überschrieben.
 *
 * @param records  Array mit VjDayRecord (typisch 365 Einträge)
 */
export async function upsertVjDailyBatch(records: VjDayRecord[]): Promise<{ upserted: number; error: string | null }> {
  console.log(`[VJ-SUPABASE] rows parsed: ${records.length}`);

  const rows = records.map(r => ({
    key:   keyOf(r.date),
    value: r as unknown as Record<string, unknown>,
  }));

  try {
    const { error } = await (supabase as any)
      .from('app_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      console.warn('[VJ-SUPABASE] upsert error:', error.message);
      return { upserted: 0, error: error.message };
    }

    console.log(`[VJ-SUPABASE] rows upserted to supabase: ${records.length}`);
    console.log('[VJ-SUPABASE] source of truth: supabase');
    return { upserted: records.length, error: null };
  } catch (e) {
    const msg = String(e);
    console.warn('[VJ-SUPABASE] upsert exception:', msg);
    return { upserted: 0, error: msg };
  }
}

// ── Lesen: Monatsweise ────────────────────────────────────────────────────────

/**
 * Lädt alle VJ-Tageswerte eines Monats aus Supabase.
 * Gibt eine Map { "2025-04-03": VjDayRecord } zurück.
 * Leere Map wenn nichts gefunden oder Fehler.
 */
export async function loadVjDailyMonth(
  year: number,
  month: number,
): Promise<Record<string, VjDayRecord>> {
  const prefix = keyOfMonth(year, month);
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('key, value')
      .like('key', `${prefix}%`);

    if (error || !data || data.length === 0) {
      console.log(`[VJ-SUPABASE] loaded month ${year}-${String(month).padStart(2,'0')}: 0 rows from supabase`);
      return {};
    }

    console.log(`[VJ-SUPABASE] loaded month ${year}-${String(month).padStart(2,'0')}: ${data.length} rows from supabase`);
    console.log('[VJ-SUPABASE] source of truth: supabase');

    const result: Record<string, VjDayRecord> = {};
    for (const row of data as Array<{ key: string; value: unknown }>) {
      const rec = row.value as VjDayRecord;
      const date = row.key.replace(KEY_PREFIX, '');
      result[date] = { ...rec, date };
    }
    return result;
  } catch (e) {
    console.warn('[VJ-SUPABASE] load error:', String(e));
    return {};
  }
}

// ── Lesen: Einzeltag ─────────────────────────────────────────────────────────

/**
 * Lädt den VJ-Wert eines einzelnen Datums aus Supabase.
 * Gibt null zurück wenn nicht gefunden.
 */
export async function loadVjDailyDate(date: string): Promise<VjDayRecord | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('value')
      .eq('key', keyOf(date))
      .maybeSingle();

    if (error || !data) return null;
    return data.value as VjDayRecord;
  } catch {
    return null;
  }
}

// ── Status: Prüfen ob VJ-Daten vorhanden ──────────────────────────────────────

/**
 * Prüft ob für ein gegebenes Jahr bereits VJ-Daten in Supabase vorhanden sind.
 * Gibt Anzahl der vorhandenen Datensätze zurück.
 */
export async function countVjDailyYear(year: number): Promise<number> {
  try {
    const { count, error } = await (supabase as any)
      .from('app_settings')
      .select('key', { count: 'exact', head: true })
      .like('key', `${KEY_PREFIX}${year}-%`);

    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
