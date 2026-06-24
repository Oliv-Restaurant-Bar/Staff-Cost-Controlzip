/**
 * crm-activities-db — Supabase-Anbindung der Gäste-CRM-Aktionen
 * =============================================================
 * Schreibt/liest `guest_crm_activities` und `guest_crm_contact_lists`
 * (siehe Migration `20260624_crm_activities.sql`). Alle Aktionen sind INTERN
 * (keine E-Mails/WhatsApp/externe Integrationen) und manuell ausgelöst.
 *
 * MANDANTENTRENNUNG (Pflicht):
 *   - Jeder Lese-/Schreibzugriff filtert nach `restaurant_id`.
 *   - Vor JEDEM Schreibvorgang prüft `verifyGuestsBelongToTenant`, dass ALLE
 *     betroffenen Gäste zum Mandanten gehören (count-match über guest_profiles).
 *     Schon ein einziger fremder/unbekannter Gast bricht die Aktion ab, BEVOR
 *     etwas geschrieben wird.
 *
 * DATENINTEGRITÄT:
 *   - Schreibvorgänge werfen bei Fehlern (kein stilles Fallback).
 *   - `fetchGuestActivities`/`fetchContactLists` sind best-effort und liefern
 *     `[]`, falls die Tabelle (noch) nicht existiert — die Migration wird
 *     manuell im SQL-Editor ausgeführt.
 *
 * DATENSCHUTZ: `created_by` ist ausschliesslich die Operator-UUID (keine PII).
 *
 * Datentypen werden über `(supabase as any)` umgangen (Projektmuster), da die
 * generierten Supabase-Typen diese Tabellen nicht kennen.
 */

import { supabase } from '@/integrations/supabase/client';
import { fetchGuestById } from './reservation-crm-db';
import {
  buildActivityInsertRows, rowToCrmActivity, rowToContactList, uniqueGuestIds,
  cleanText,
  type CrmActivity, type CrmActivityRow,
  type ContactList, type ContactListRow,
  type FollowUpStatus,
} from './crm-activities';

const ACTIVITY_TABLE = 'guest_crm_activities';
const CONTACT_LIST_TABLE = 'guest_crm_contact_lists';

const ACTIVITY_COLS =
  'id, guest_id, activity_type, segment_key, note, due_date, status, ' +
  'contacted_on, batch_id, created_by, completed_at, created_at';
const CONTACT_LIST_COLS =
  'id, name, segment_key, guest_ids, member_count, created_by, created_at';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

function newBatchId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Stellt sicher, dass ALLE übergebenen Gäste zum Mandanten gehören. Liefert die
 * eindeutigen IDs zurück oder wirft (vor jedem Schreibvorgang aufgerufen).
 */
export async function verifyGuestsBelongToTenant(
  restaurantId: string,
  guestIds: readonly string[],
): Promise<string[]> {
  const unique = uniqueGuestIds(guestIds);
  if (unique.length === 0) throw new Error('Keine Gäste ausgewählt.');

  const found = new Set<string>();
  const CHUNK = 200;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const { data, error } = await (supabase as any)
      .from('guest_profiles')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .in('id', chunk);
    if (error) {
      throw new Error(`Mandanten-Prüfung fehlgeschlagen: ${error.message ?? 'unbekannter Fehler'}`);
    }
    for (const r of (data ?? []) as Array<{ id: string }>) found.add(r.id);
  }

  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} ausgewählte(r) Gast/Gäste gehören nicht zum aktuellen Restaurant — Aktion abgebrochen.`,
    );
  }
  return unique;
}

// ── Aktivitäten schreiben (Fan-out, mandantengeprüft) ─────────────────────────

interface InsertActivityOptions {
  activityType: 'contacted' | 'note' | 'follow_up';
  segmentKey?: string | null;
  note?: string | null;
  dueDate?: string | null;
  status?: FollowUpStatus | null;
  contactedOn?: string | null;
}

async function insertActivities(
  restaurantId: string,
  guestIds: readonly string[],
  opts: InsertActivityOptions,
): Promise<number> {
  const verified = await verifyGuestsBelongToTenant(restaurantId, guestIds);
  const createdBy = await currentUserId();
  // Sammelaktion (mehrere Gäste) über eine gemeinsame batch_id gruppieren.
  const batchId = verified.length > 1 ? newBatchId() : null;

  const rows = buildActivityInsertRows({
    restaurantId,
    guestIds: verified,
    activityType: opts.activityType,
    segmentKey: opts.segmentKey ?? null,
    note: opts.note ?? null,
    dueDate: opts.dueDate ?? null,
    status: opts.status ?? null,
    contactedOn: opts.contactedOn ?? null,
    createdBy,
    batchId,
  });

  const { error } = await (supabase as any).from(ACTIVITY_TABLE).insert(rows);
  if (error) {
    throw new Error(`CRM-Aktion konnte nicht gespeichert werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
  return rows.length;
}

/** Gäste „als kontaktiert" markieren (Datum + Segment + optionale Notiz). */
export async function markGuestsContacted(
  restaurantId: string,
  guestIds: readonly string[],
  opts?: { segmentKey?: string | null; note?: string | null; contactedOn?: string | null },
): Promise<number> {
  return insertActivities(restaurantId, guestIds, {
    activityType: 'contacted',
    segmentKey: opts?.segmentKey ?? null,
    note: cleanText(opts?.note),
    contactedOn: opts?.contactedOn ?? todayISO(),
  });
}

/** Interne Notiz an Gäste/Segment anhängen (Pflichttext). */
export async function addGuestNote(
  restaurantId: string,
  guestIds: readonly string[],
  note: string,
  opts?: { segmentKey?: string | null },
): Promise<number> {
  const text = cleanText(note);
  if (!text) throw new Error('Die Notiz darf nicht leer sein.');
  return insertActivities(restaurantId, guestIds, {
    activityType: 'note',
    segmentKey: opts?.segmentKey ?? null,
    note: text,
  });
}

/** Folgeaufgabe für Gäste/Segment anlegen (Fälligkeitsdatum Pflicht). */
export async function createFollowUpTask(
  restaurantId: string,
  guestIds: readonly string[],
  dueDate: string,
  opts?: { description?: string | null; segmentKey?: string | null },
): Promise<number> {
  if (!dueDate) throw new Error('Für eine Folgeaufgabe ist ein Fälligkeitsdatum erforderlich.');
  return insertActivities(restaurantId, guestIds, {
    activityType: 'follow_up',
    segmentKey: opts?.segmentKey ?? null,
    note: cleanText(opts?.description),
    dueDate,
    status: 'open',
  });
}

// ── Status einer Folgeaufgabe umschalten (mandantengeprüft) ───────────────────

export async function setFollowUpStatus(
  restaurantId: string,
  activityId: string,
  status: FollowUpStatus,
): Promise<void> {
  const { data, error } = await (supabase as any)
    .from(ACTIVITY_TABLE)
    .update({
      status,
      completed_at: status === 'done' ? new Date().toISOString() : null,
    })
    .eq('restaurant_id', restaurantId)
    .eq('id', activityId)
    .eq('activity_type', 'follow_up')
    .select('id')
    .maybeSingle();
  if (error) {
    throw new Error(`Status konnte nicht aktualisiert werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
  if (!data) {
    throw new Error('Folgeaufgabe nicht gefunden oder kein Zugriff.');
  }
}

// ── Aktivitäten eines Gastes lesen (mandantengeprüft, best-effort) ────────────

export async function fetchGuestActivities(
  restaurantId: string,
  guestId: string,
): Promise<CrmActivity[]> {
  // Tenant-Gate: Gast muss zum Mandanten gehören.
  const guest = await fetchGuestById(restaurantId, guestId);
  if (!guest) return [];
  try {
    const { data, error } = await (supabase as any)
      .from(ACTIVITY_TABLE)
      .select(ACTIVITY_COLS)
      .eq('restaurant_id', restaurantId)
      .eq('guest_id', guestId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(`CRM-Aktivitäten konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    return ((data ?? []) as CrmActivityRow[]).map(rowToCrmActivity);
  } catch (e) {
    // Tabelle fehlt evtl. noch (Migration manuell) → als „leer" behandeln, aber
    // echte Fehler weiterreichen, damit die UI eine Warnung zeigen kann.
    if (e instanceof Error && /relation .* does not exist|schema cache|not exist/i.test(e.message)) {
      return [];
    }
    throw e;
  }
}

// ── Kontaktlisten ─────────────────────────────────────────────────────────────

export async function createContactList(
  restaurantId: string,
  name: string,
  guestIds: readonly string[],
  opts?: { segmentKey?: string | null },
): Promise<ContactList> {
  const cleanName = (name ?? '').trim();
  if (!cleanName) throw new Error('Bitte einen Namen für die Kontaktliste angeben.');
  const verified = await verifyGuestsBelongToTenant(restaurantId, guestIds);
  const createdBy = await currentUserId();

  const row = {
    restaurant_id: restaurantId,
    name: cleanName,
    segment_key: opts?.segmentKey ?? null,
    guest_ids: verified,
    member_count: verified.length,
    created_by: createdBy,
  };

  const { data, error } = await (supabase as any)
    .from(CONTACT_LIST_TABLE)
    .insert(row)
    .select(CONTACT_LIST_COLS)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Kontaktliste konnte nicht gespeichert werden: ${error?.message ?? 'unbekannter Fehler'}`);
  }
  return rowToContactList(data as ContactListRow);
}

export async function fetchContactLists(restaurantId: string): Promise<ContactList[]> {
  try {
    const { data, error } = await (supabase as any)
      .from(CONTACT_LIST_TABLE)
      .select(CONTACT_LIST_COLS)
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false });
    if (error) {
      throw new Error(`Kontaktlisten konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
    }
    return ((data ?? []) as ContactListRow[]).map(rowToContactList);
  } catch (e) {
    // Tabelle fehlt evtl. noch (Migration manuell) → als „leer" behandeln, aber
    // echte Fehler weiterreichen.
    if (e instanceof Error && /relation .* does not exist|schema cache|not exist/i.test(e.message)) {
      return [];
    }
    throw e;
  }
}

export async function checkCrmActivitiesTableExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any).from(ACTIVITY_TABLE).select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
