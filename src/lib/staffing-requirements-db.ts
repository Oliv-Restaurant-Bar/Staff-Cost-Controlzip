/**
 * staffing-requirements-db — Supabase-Anbindung des Personalbedarfs.
 * ──────────────────────────────────────────────────────────────────────────────
 * Liest/schreibt die Tabelle `staffing_requirements`
 * (siehe Migration 20260625_staffing_requirements.sql).
 *
 * MANDANTENTRENNUNG (Pflicht): Jeder Lese-/Schreibzugriff filtert nach
 *   `restaurant_id` ('oliv' | 'beaulieu').
 *
 * DATENINTEGRITÄT:
 *   - Schreibvorgänge (saveStaffingScope) WERFEN bei Fehlern (kein stilles
 *     Fallback) — die UI zeigt den Fehler an.
 *   - `loadStaffingRequirements` ist best-effort: liefert `[]`, falls die
 *     Tabelle (noch) nicht existiert (Migration wird manuell ausgeführt).
 *
 * MANDANTEN-/SCOPE-SICHERHEIT (wichtig): RLS ist authenticated-weit (USING
 *   true), schützt also NICHT pro Mandant. Darum NICHT per Bulk-Upsert auf den
 *   PK schreiben — ein authentifizierter Client könnte sonst fremde ids
 *   übergeben und damit fremde Zeilen überschreiben. Stattdessen:
 *     1) bestehende ids des EXAKTEN Mandanten+Scope laden,
 *     2) nur Zeilen UPDATEN, deren id in diesem Scope existiert
 *        (.eq('id').eq('restaurant_id') + Scope-Prädikate),
 *     3) übrige Zeilen frisch INSERTEN (server-/client-neue id),
 *     4) entfernte Zeilen löschen (mandanten- + scope-gefiltert).
 */

import { supabase } from '@/integrations/supabase/client';
import type {
  StaffingRequirement,
  StaffingRequirementDraft,
  StaffingScope,
} from '@/types/staffing';

const TABLE = 'staffing_requirements';
const COLS =
  'id, restaurant_id, scope_type, season, weekday, scope_ref, position_key, ' +
  'shift_start, shift_end, required_count, sort_order, meta, created_at, updated_at';

const TABLE_MISSING = /relation .* does not exist|schema cache|not exist|404/i;

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `sr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 'HH:MM:SS' → 'HH:MM' (sonst unverändert). */
function normalizeTime(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return /^\d{2}:\d{2}:\d{2}$/.test(s) ? s.slice(0, 5) : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRequirement(row: any): StaffingRequirement {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    scopeType: row.scope_type ?? 'weekly',
    season: row.season ?? 'standard',
    weekday: row.weekday ?? null,
    scopeRef: row.scope_ref ?? null,
    positionKey: row.position_key,
    // DB kann 'HH:MM:SS' liefern (Alt-Daten) — auf 'HH:MM' normalisieren,
    // sonst scheitert isValidTime und die Stunden-Berechnung wird NaN.
    shiftStart: normalizeTime(row.shift_start),
    shiftEnd: normalizeTime(row.shift_end),
    requiredCount: row.required_count ?? 0,
    sortOrder: row.sort_order ?? 0,
    meta: (row.meta ?? {}) as Record<string, unknown>,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function draftToRow(restaurantId: string, d: StaffingRequirementDraft, id: string): Record<string, any> {
  return {
    id,
    restaurant_id: restaurantId,
    scope_type: d.scopeType,
    season: d.season,
    weekday: d.weekday,
    scope_ref: d.scopeRef ?? null,
    position_key: d.positionKey,
    shift_start: d.shiftStart,
    shift_end: d.shiftEnd,
    required_count: d.requiredCount,
    sort_order: d.sortOrder,
    meta: d.meta ?? {},
  };
}

/**
 * Wendet die Scope-Prädikate auf eine Query an. Für NULL-Felder (z.B. weekly
 * hat scope_ref = null) wird `.is(col, null)` genutzt, sonst `.eq(col, value)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyScope(query: any, restaurantId: string, scope: StaffingScope): any {
  let q = query.eq('restaurant_id', restaurantId).eq('scope_type', scope.scopeType).eq('season', scope.season);
  q = scope.weekday === null || scope.weekday === undefined ? q.is('weekday', null) : q.eq('weekday', scope.weekday);
  q = scope.scopeRef === null || scope.scopeRef === undefined ? q.is('scope_ref', null) : q.eq('scope_ref', scope.scopeRef);
  return q;
}

/** Alle Bedarfs-Zeilen eines Mandanten laden. Best-effort (Tabelle fehlt → []). */
export async function loadStaffingRequirements(restaurantId: string): Promise<StaffingRequirement[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from(TABLE)
      .select(COLS)
      .eq('restaurant_id', restaurantId)
      .order('season', { ascending: true })
      .order('weekday', { ascending: true })
      .order('sort_order', { ascending: true });
    if (error) {
      throw new Error(`Personalbedarf konnte nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data ?? []) as any[]).map(rowToRequirement);
  } catch (e) {
    if (e instanceof Error && TABLE_MISSING.test(e.message)) return [];
    throw e;
  }
}

/**
 * Speichert den gesamten Bedarf EINES Geltungsbereichs (z.B. ein Saison-
 * Wochentag) transaktionsnah per Diff: vorhandene Zeilen aktualisieren, neue
 * anlegen, entfernte löschen. WIRFT bei Fehlern. Liefert die danach
 * vorhandenen Zeilen dieses Bereichs.
 *
 * `drafts` ist die VOLLSTÄNDIGE gewünschte Liste der Schichten dieses Bereichs
 * (alle Positionen). Jeder Draft trägt bereits scopeType/season/weekday/scopeRef
 * passend zum Scope. Drafts mit `id` aus dem aktuellen Scope werden aktualisiert,
 * alle anderen (kein id ODER fremde id) werden neu eingefügt.
 */
export async function saveStaffingScope(
  restaurantId: string,
  scope: StaffingScope,
  drafts: (StaffingRequirementDraft & { id?: string })[],
): Promise<StaffingRequirement[]> {
  // 1) Bestehende ids dieses Mandanten + Scope laden.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingData, error: loadErr } = await applyScope(
    (supabase as any).from(TABLE).select('id'),
    restaurantId,
    scope,
  );
  if (loadErr) {
    if (TABLE_MISSING.test(loadErr.message ?? '')) {
      throw new Error(
        'Die Tabelle "staffing_requirements" existiert noch nicht. Bitte die Migration ' +
        '20260625_staffing_requirements.sql im Supabase SQL-Editor ausführen.',
      );
    }
    throw new Error(`Personalbedarf konnte nicht geladen werden: ${loadErr.message ?? 'unbekannter Fehler'}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existingIds = new Set(((existingData ?? []) as any[]).map((r) => r.id as string));

  const keptIds: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: { id: string; row: Record<string, unknown> }[] = [];

  drafts.forEach((d) => {
    // Scope der Draft-Zeile aus dem übergebenen Scope erzwingen (kein Vertrauen
    // auf evtl. abweichende Draft-Felder). `sortOrder` wird vom Aufrufer je
    // Position vergeben und hier NICHT überschrieben — damit bleiben erhaltene
    // Zeilen inaktiver/gelöschter Positionen (Orphans) wirklich unverändert.
    const normalized: StaffingRequirementDraft = {
      ...d,
      scopeType: scope.scopeType,
      season: scope.season,
      weekday: scope.weekday,
      scopeRef: scope.scopeRef ?? null,
    };
    if (d.id && existingIds.has(d.id)) {
      const row = { ...draftToRow(restaurantId, normalized, d.id), updated_at: new Date().toISOString() };
      // restaurant_id/id werden im UPDATE über die Prädikate gesichert.
      delete (row as Record<string, unknown>).id;
      delete (row as Record<string, unknown>).restaurant_id;
      updates.push({ id: d.id, row });
      keptIds.push(d.id);
    } else {
      const id = newId();
      inserts.push(draftToRow(restaurantId, normalized, id));
      keptIds.push(id);
    }
  });

  // 2) Updates (mandanten- + scope-gesichert pro Zeile).
  for (const u of updates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await applyScope(
      (supabase as any).from(TABLE).update(u.row).eq('id', u.id),
      restaurantId,
      scope,
    );
    if (error) {
      throw new Error(`Personalbedarf konnte nicht gespeichert werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
  }

  // 3) Inserts (jede Zeile trägt restaurant_id + Scope).
  if (inserts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(TABLE).insert(inserts);
    if (error) {
      throw new Error(`Personalbedarf konnte nicht gespeichert werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
  }

  // 4) Entfernte Zeilen löschen (im Scope vorhanden, aber nicht mehr gewünscht).
  const keptSet = new Set(keptIds);
  const staleIds = [...existingIds].filter((id) => !keptSet.has(id));
  if (staleIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await applyScope(
      (supabase as any).from(TABLE).delete().in('id', staleIds),
      restaurantId,
      scope,
    );
    if (error) {
      throw new Error(`Entfernte Schichten konnten nicht gelöscht werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
  }

  // Frische Daten dieses Scopes zurückliefern.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await applyScope(
    (supabase as any).from(TABLE).select(COLS),
    restaurantId,
    scope,
  ).order('sort_order', { ascending: true });
  if (error) {
    throw new Error(`Personalbedarf konnte nicht neu geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map(rowToRequirement);
}

/** Prüft, ob die staffing_requirements-Tabelle erreichbar ist (für UI-Hinweise). */
export async function checkStaffingTableExists(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(TABLE).select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
