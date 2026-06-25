/**
 * positions-db — Supabase-Anbindung der Positionsverwaltung.
 * ──────────────────────────────────────────────────────────────────────────────
 * Liest/schreibt die Tabelle `positions` (siehe Migration 20260625_positions.sql).
 *
 * MANDANTENTRENNUNG (Pflicht): Jeder Lese-/Schreibzugriff filtert nach
 *   `restaurant_id` ('oliv' | 'beaulieu').
 *
 * DATENINTEGRITÄT:
 *   - Schreibvorgänge (upsert/delete/seed) WERFEN bei Fehlern (kein stilles
 *     Fallback) — die UI zeigt den Fehler an.
 *   - `loadPositions` ist best-effort: liefert `[]`, falls die Tabelle (noch)
 *     nicht existiert (Migration wird manuell im SQL-Editor ausgeführt).
 *
 * Abteilung wird in der DB als 'service' | 'kueche' gespeichert (analog
 * employees), im TS-Modell als 'service' | 'küche'.
 */

import { supabase } from '@/integrations/supabase/client';
import type { Department } from '@/types/personnel';
import type { Position, PositionDraft } from '@/types/positions';
import { defaultPositions } from '@/lib/position-utils';

const TABLE = 'positions';
const COLS =
  'id, restaurant_id, key, name, department, department_group, color, icon, ' +
  'sort_order, active, created_at, updated_at';

const TABLE_MISSING = /relation .* does not exist|schema cache|not exist|404/i;

const toDbDept = (d: Department): string => (d === 'küche' ? 'kueche' : 'service');
const fromDbDept = (d: string): Department => (d === 'kueche' ? 'küche' : 'service');

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToPosition(row: any): Position {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    key: row.key,
    name: row.name,
    department: fromDbDept(row.department),
    departmentGroup: row.department_group ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    sortOrder: row.sort_order ?? 0,
    active: row.active ?? true,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function draftToRow(restaurantId: string, p: PositionDraft, id: string): Record<string, any> {
  return {
    id,
    restaurant_id: restaurantId,
    key: p.key,
    name: p.name,
    department: toDbDept(p.department),
    department_group: p.departmentGroup ?? null,
    color: p.color ?? null,
    icon: p.icon ?? null,
    sort_order: p.sortOrder ?? 0,
    active: p.active ?? true,
  };
}

/** Positionen eines Mandanten laden. Best-effort (Tabelle fehlt → []). */
export async function loadPositions(restaurantId: string): Promise<Position[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .select(COLS)
      .eq('restaurant_id', restaurantId)
      .order('department', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      throw new Error(`Positionen konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as any[]).map(rowToPosition);
  } catch (e) {
    if (e instanceof Error && TABLE_MISSING.test(e.message)) return [];
    throw e;
  }
}

/**
 * Position anlegen oder aktualisieren (Upsert auf id). Bei neuen Positionen
 * wird clientseitig eine id erzeugt. WIRFT bei Fehlern.
 */
export async function upsertPosition(
  restaurantId: string,
  position: PositionDraft & { id?: string },
): Promise<Position> {
  const id = position.id ?? newId();
  const row = { ...draftToRow(restaurantId, position, id), updated_at: new Date().toISOString() };

  // MANDANTENSICHERHEIT: Update nur auf einen Datensatz, der DIESEM Mandanten
  // gehört (RLS ist authenticated-weit → ein .eq('id') allein könnte fremde
  // Tenant-Zeilen überschreiben/verschieben). Insert stempelt restaurant_id immer.
  if (position.id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .update(row)
      .eq('id', position.id)
      .eq('restaurant_id', restaurantId)
      .select(COLS)
      .maybeSingle();
    if (error || !data) {
      throw new Error(`Position konnte nicht aktualisiert werden: ${error?.message ?? 'nicht gefunden oder kein Zugriff'}`);
    }
    return rowToPosition(data);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from(TABLE)
    .insert(row)
    .select(COLS)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Position konnte nicht angelegt werden: ${error?.message ?? 'unbekannter Fehler'}`);
  }
  return rowToPosition(data);
}

/** Position löschen (mandantengeprüft). WIRFT bei Fehlern. */
export async function deletePosition(restaurantId: string, id: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from(TABLE)
    .delete()
    .eq('restaurant_id', restaurantId)
    .eq('id', id);
  if (error) {
    throw new Error(`Position konnte nicht gelöscht werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
}

/**
 * Standard-Positionen (abgeleitet aus station-config) für einen Mandanten
 * anlegen — NUR falls noch keine Positionen existieren (idempotent). Liefert
 * die danach vorhandenen Positionen. WIRFT, wenn die Tabelle fehlt.
 */
export async function seedDefaultPositions(restaurantId: string): Promise<Position[]> {
  const existing = await loadPositions(restaurantId);
  if (existing.length > 0) return existing;

  const rows = defaultPositions().map((d) => draftToRow(restaurantId, d, newId()));

  // ignoreDuplicates: bei paralleler Erst-Initialisierung doppelte Keys ignorieren.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from(TABLE)
    .upsert(rows, { onConflict: 'restaurant_id,key', ignoreDuplicates: true });
  if (error) {
    if (TABLE_MISSING.test(error.message ?? '')) {
      throw new Error(
        'Die Tabelle "positions" existiert noch nicht. Bitte die Migration ' +
        '20260625_positions.sql im Supabase SQL-Editor ausführen.',
      );
    }
    throw new Error(`Standard-Positionen konnten nicht angelegt werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
  return loadPositions(restaurantId);
}

/** Prüft, ob die positions-Tabelle erreichbar ist (für UI-Hinweise). */
export async function checkPositionsTableExists(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(TABLE).select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
