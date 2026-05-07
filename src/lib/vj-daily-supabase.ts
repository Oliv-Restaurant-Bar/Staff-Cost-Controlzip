/**
 * vj-daily-supabase.ts
 * ====================
 * Persistente Speicherung von Vorjahres-Tagesumsätzen in Supabase.
 *
 * Speicherstruktur (Tabelle: app_settings)
 * -----------------------------------------
 *   Oliv (Standard / Rückwärtskompatibel):
 *     key   = "vj_daily:2025-04-03"
 *   Beaulieu (tenant-isoliert):
 *     key   = "vj_daily:beaulieu:2025-04-03"
 *
 *   value = {
 *     date:          "2025-04-03",
 *     year:          2025,
 *     actualRevenue: 7118.50,
 *     foodRevenue:   3245.00,        // optional
 *     beverageRevenue: 3873.50,      // optional
 *     source:        "vorjahr_import"
 *   }
 *
 * Pro Datum = eine Zeile in app_settings → Upsert (kein Doppeln).
 * Tenant-Isolation: Beaulieu benutzt vj_daily:beaulieu: Prefix;
 *   Oliv behält vj_daily: (Rückwärtskompatibilität).
 *
 * Debug-Logs
 * ----------
 *   [VJ-SUPABASE] rows parsed: 365
 *   [VJ-SUPABASE] rows upserted to supabase: 365
 *   [VJ-SUPABASE] source of truth: supabase
 *   [VJ-SUPABASE] loaded month 2025-04: 30 rows from supabase
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

const BASE_PREFIX = 'vj_daily:';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/**
 * Gibt den Key-Prefix für den angegebenen Mandanten zurück.
 * Oliv: "vj_daily:"          (rückwärtskompatibel mit bestehenden Daten)
 * Beaulieu: "vj_daily:beaulieu:"
 */
function tenantPrefix(tenantId?: string): string {
  if (!tenantId || tenantId === 'oliv') return BASE_PREFIX;
  return `${BASE_PREFIX}${tenantId}:`;
}

function keyOf(date: string, tenantId?: string): string {
  return `${tenantPrefix(tenantId)}${date}`;
}

function keyOfMonth(year: number, month: number, tenantId?: string): string {
  const mm = String(month).padStart(2, '0');
  return `${tenantPrefix(tenantId)}${year}-${mm}-`;
}

// ── Schreiben: Batch-Upsert ───────────────────────────────────────────────────

/**
 * Speichert VJ-Tagesumsätze für ein ganzes Jahr per Batch-Upsert in Supabase.
 * Bestehende Datensätze für dasselbe Datum werden überschrieben.
 *
 * @param records   Array mit VjDayRecord (typisch 365 Einträge)
 * @param tenantId  Mandanten-ID ('oliv' oder 'beaulieu')
 */
export async function upsertVjDailyBatch(
  records: VjDayRecord[],
  tenantId?: string,
): Promise<{ upserted: number; error: string | null }> {
  console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] rows parsed: ${records.length}`);

  const rows = records.map(r => ({
    key:   keyOf(r.date, tenantId),
    value: r as unknown as Record<string, unknown>,
  }));

  try {
    const { error } = await (supabase as any)
      .from('app_settings')
      .upsert(rows, { onConflict: 'key' });

    if (error) {
      console.warn(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] upsert error:`, error.message);
      return { upserted: 0, error: error.message };
    }

    console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] rows upserted to supabase: ${records.length}`);
    console.log('[VJ-SUPABASE] source of truth: supabase');
    return { upserted: records.length, error: null };
  } catch (e) {
    const msg = String(e);
    console.warn(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] upsert exception:`, msg);
    return { upserted: 0, error: msg };
  }
}

// ── Lesen: Monatsweise ────────────────────────────────────────────────────────

/**
 * Lädt alle VJ-Tageswerte eines Monats aus Supabase.
 * Gibt eine Map { "2025-04-03": VjDayRecord } zurück.
 * Leere Map wenn nichts gefunden oder Fehler.
 *
 * @param tenantId  Mandanten-ID ('oliv' oder 'beaulieu')
 */
export async function loadVjDailyMonth(
  year: number,
  month: number,
  tenantId?: string,
): Promise<Record<string, VjDayRecord>> {
  const prefix = keyOfMonth(year, month, tenantId);
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('key, value')
      .like('key', `${prefix}%`);

    if (error || !data || data.length === 0) {
      console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] loaded month ${year}-${String(month).padStart(2,'0')}: 0 rows from supabase`);
      return {};
    }

    console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] loaded month ${year}-${String(month).padStart(2,'0')}: ${data.length} rows from supabase`);
    console.log('[VJ-SUPABASE] source of truth: supabase');

    const result: Record<string, VjDayRecord> = {};
    for (const row of data as Array<{ key: string; value: unknown }>) {
      const rec  = row.value as VjDayRecord;
      const date = row.key.replace(tenantPrefix(tenantId), '');
      result[date] = { ...rec, date };
    }
    return result;
  } catch (e) {
    console.warn(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] load error:`, String(e));
    return {};
  }
}

// ── Lesen: Einzeltag ─────────────────────────────────────────────────────────

/**
 * Lädt den VJ-Wert eines einzelnen Datums aus Supabase.
 * Gibt null zurück wenn nicht gefunden.
 *
 * @param tenantId  Mandanten-ID ('oliv' oder 'beaulieu')
 */
export async function loadVjDailyDate(
  date: string,
  tenantId?: string,
): Promise<VjDayRecord | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('value')
      .eq('key', keyOf(date, tenantId))
      .maybeSingle();

    if (error || !data) return null;
    return data.value as VjDayRecord;
  } catch {
    return null;
  }
}

// ── Lesen: Ganzes Jahr ────────────────────────────────────────────────────────

/**
 * Lädt alle VJ-Tageswerte eines Jahres aus Supabase in einem einzigen Query.
 * Gibt eine Map { "2025-04-03": VjDayRecord } zurück (Key = Datum ohne Prefix).
 * Leere Map wenn nichts gefunden oder Fehler.
 *
 * Wird von PLView verwendet, um alle 12 Monate auf einmal zu laden.
 */
export async function loadVjDailyYear(
  year:      number,
  tenantId?: string,
): Promise<Record<string, VjDayRecord>> {
  const prefix = `${tenantPrefix(tenantId)}${year}-`;
  try {
    const { data, error } = await (supabase as any)
      .from('app_settings')
      .select('key, value')
      .like('key', `${prefix}%`);

    if (error || !data || data.length === 0) {
      console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] loaded year ${year}: 0 rows from supabase`);
      return {};
    }

    console.log(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] loaded year ${year}: ${data.length} rows from supabase`);

    const result: Record<string, VjDayRecord> = {};
    for (const row of data as Array<{ key: string; value: unknown }>) {
      const rec  = row.value as VjDayRecord;
      const date = row.key.replace(tenantPrefix(tenantId), '');
      result[date] = { ...rec, date };
    }
    return result;
  } catch (e) {
    console.warn(`[VJ-SUPABASE][${tenantId ?? 'oliv'}] loadVjDailyYear error:`, String(e));
    return {};
  }
}

// ── Status: Prüfen ob VJ-Daten vorhanden ──────────────────────────────────────

/**
 * Prüft ob für ein gegebenes Jahr bereits VJ-Daten in Supabase vorhanden sind.
 * Gibt Anzahl der vorhandenen Datensätze zurück.
 *
 * @param tenantId  Mandanten-ID ('oliv' oder 'beaulieu')
 */
export async function countVjDailyYear(
  year: number,
  tenantId?: string,
): Promise<number> {
  try {
    const { count, error } = await (supabase as any)
      .from('app_settings')
      .select('key', { count: 'exact', head: true })
      .like('key', `${tenantPrefix(tenantId)}${year}-%`);

    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}
