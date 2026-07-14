/**
 * crm-activities — reine Logik der Gäste-CRM-Aktionen (KEIN supabase/DOM)
 * ======================================================================
 * Modellierung der INTERNEN, manuell ausgelösten CRM-Aktionen je Gast
 * (siehe Migration `20260624_crm_activities.sql`):
 *
 *   - `contacted`  → „als kontaktiert markiert" (`contactedOn` Pflicht)
 *   - `note`       → interne Notiz (`note` Pflicht, nicht leer)
 *   - `follow_up`  → Folgeaufgabe (`dueDate` + `status` Pflicht)
 *
 * Sammelaktionen über ein ganzes Segment / eine Auswahl FÄCHERN AUF: eine Zeile
 * pro Gast, gruppiert über eine gemeinsame `batchId`. Dieses Modul übernimmt nur
 * Mapping (snake↔camel), das Erzeugen der Insert-Zeilen (Fan-out) sowie das
 * Sortieren/Gruppieren für die Anzeige — alle Datenbankzugriffe liegen in
 * `crm-activities-db.ts`.
 *
 * STRIKT GETRENNT von den automatisch berechneten Kennzahlen/Segmenten und vom
 * manuellen Profil (`guest_crm_profiles`); diese werden nicht berührt.
 */

// ── Typen ─────────────────────────────────────────────────────────────────────

export type CrmActivityType = 'contacted' | 'note' | 'follow_up';
export type FollowUpStatus = 'open' | 'done';

/** Eine CRM-Aktivität (App-Sicht, camelCase). */
export interface CrmActivity {
  id: string;
  guestId: string;
  activityType: CrmActivityType;
  /** Smart-Segment, aus dem die Aktion ausgelöst wurde (Slug) — optional. */
  segmentKey: string | null;
  /** Notiz/Beschreibung (Pflicht bei `note`, optional bei `contacted`/`follow_up`). */
  note: string | null;
  /** Fälligkeitsdatum (yyyy-MM-dd) — nur `follow_up`. */
  dueDate: string | null;
  /** Status — nur `follow_up`. */
  status: FollowUpStatus | null;
  /** Kontaktdatum (yyyy-MM-dd) — nur `contacted`. */
  contactedOn: string | null;
  /** Gruppierung einer Sammelaktion (eine Zeile pro Gast) — optional. */
  batchId: string | null;
  /** Operator-UUID (keine PII). */
  createdBy: string | null;
  /** Zeitpunkt der Erledigung (nur `follow_up`, wenn `done`). */
  completedAt: string | null;
  createdAt: string;
}

/** Roh-Zeile aus `guest_crm_activities` (snake_case). */
export interface CrmActivityRow {
  id: string;
  guest_id: string;
  activity_type: string;
  segment_key: string | null;
  note: string | null;
  due_date: string | null;
  status: string | null;
  contacted_on: string | null;
  batch_id: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
}

/** Insert-Zeile (ohne von der DB gesetzte Felder id/created_at/completed_at). */
export interface ActivityInsertRow {
  restaurant_id: string;
  guest_id: string;
  activity_type: CrmActivityType;
  segment_key: string | null;
  note: string | null;
  due_date: string | null;
  status: FollowUpStatus | null;
  contacted_on: string | null;
  batch_id: string | null;
  created_by: string | null;
}

/** Eine benannte Kontaktliste (App-Sicht). */
export interface ContactList {
  id: string;
  name: string;
  segmentKey: string | null;
  guestIds: string[];
  memberCount: number;
  createdBy: string | null;
  createdAt: string;
}

/** Roh-Zeile aus `guest_crm_contact_lists`. */
export interface ContactListRow {
  id: string;
  name: string;
  segment_key: string | null;
  guest_ids: unknown;
  member_count: number | null;
  created_by: string | null;
  created_at: string;
}

// ── Beschriftungen ──────────────────────────────────────────────────────────

export const ACTIVITY_TYPE_LABEL: Record<CrmActivityType, string> = {
  contacted: 'Kontaktiert',
  note: 'Notiz',
  follow_up: 'Folgeaufgabe',
};

export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = {
  open: 'Offen',
  done: 'Erledigt',
};

const ACTIVITY_TYPES: CrmActivityType[] = ['contacted', 'note', 'follow_up'];

// ── Normalisierung / Mapping ──────────────────────────────────────────────────

function normalizeActivityType(v: string | null): CrmActivityType {
  return ACTIVITY_TYPES.includes(v as CrmActivityType) ? (v as CrmActivityType) : 'note';
}

function normalizeStatus(v: string | null): FollowUpStatus | null {
  return v === 'open' || v === 'done' ? v : null;
}

/** Leeren/whitespace-Text → null, sonst getrimmt. */
export function cleanText(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** Eindeutige, nicht-leere Gäste-IDs (Reihenfolge des ersten Auftretens). */
export function uniqueGuestIds(ids: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function rowToCrmActivity(row: CrmActivityRow): CrmActivity {
  return {
    id: row.id,
    guestId: row.guest_id,
    activityType: normalizeActivityType(row.activity_type),
    segmentKey: row.segment_key ?? null,
    note: row.note ?? null,
    dueDate: row.due_date ?? null,
    status: normalizeStatus(row.status ?? null),
    contactedOn: row.contacted_on ?? null,
    batchId: row.batch_id ?? null,
    createdBy: row.created_by ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
  };
}

export function rowToContactList(row: ContactListRow): ContactList {
  const ids = Array.isArray(row.guest_ids)
    ? (row.guest_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return {
    id: row.id,
    name: row.name,
    segmentKey: row.segment_key ?? null,
    guestIds: ids,
    memberCount: typeof row.member_count === 'number' ? row.member_count : ids.length,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  };
}

// ── Fan-out: Insert-Zeilen erzeugen ──────────────────────────────────────────

export interface BuildActivityRowsInput {
  restaurantId: string;
  guestIds: readonly string[];
  activityType: CrmActivityType;
  segmentKey?: string | null;
  note?: string | null;
  dueDate?: string | null;
  status?: FollowUpStatus | null;
  contactedOn?: string | null;
  createdBy?: string | null;
  batchId?: string | null;
}

/**
 * Erzeugt EINE Insert-Zeile je (eindeutigem) Gast. Typ-fremde Felder werden
 * bewusst auf null gesetzt, damit die DB-CHECK-Bedingung immer erfüllt ist;
 * für `follow_up` ist der Default-Status `open`.
 */
export function buildActivityInsertRows(input: BuildActivityRowsInput): ActivityInsertRow[] {
  const ids = uniqueGuestIds(input.guestIds);
  const segmentKey = input.segmentKey ?? null;
  const note = cleanText(input.note);
  const batchId = input.batchId ?? null;
  const createdBy = input.createdBy ?? null;

  const base = (guestId: string): ActivityInsertRow => ({
    restaurant_id: input.restaurantId,
    guest_id: guestId,
    activity_type: input.activityType,
    segment_key: segmentKey,
    note: null,
    due_date: null,
    status: null,
    contacted_on: null,
    batch_id: batchId,
    created_by: createdBy,
  });

  return ids.map((guestId) => {
    const row = base(guestId);
    switch (input.activityType) {
      case 'contacted':
        row.contacted_on = input.contactedOn ?? null;
        row.note = note; // optionale Notiz
        break;
      case 'note':
        row.note = note; // Pflicht (Aufrufer stellt sicher, dass nicht leer)
        break;
      case 'follow_up':
        row.due_date = input.dueDate ?? null;
        row.status = input.status ?? 'open';
        row.note = note; // optionale Beschreibung
        break;
    }
    return row;
  });
}

// ── Sortierung / Gruppierung für die Anzeige ─────────────────────────────────

/** Absteigend nach ISO-String, null/leer ans Ende. */
function descNullsLast(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

/** Aufsteigend nach ISO-String, null/leer ans Ende. */
function ascNullsLast(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export function sortContacted(a: CrmActivity, b: CrmActivity): number {
  return descNullsLast(a.contactedOn, b.contactedOn) || descNullsLast(a.createdAt, b.createdAt);
}

export function sortNotes(a: CrmActivity, b: CrmActivity): number {
  return descNullsLast(a.createdAt, b.createdAt);
}

export function sortFollowUps(a: CrmActivity, b: CrmActivity): number {
  // Offene zuerst, dann nach Fälligkeit (früh zuerst), dann neueste zuerst.
  const sa = a.status === 'open' ? 0 : 1;
  const sb = b.status === 'open' ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return ascNullsLast(a.dueDate, b.dueDate) || descNullsLast(a.createdAt, b.createdAt);
}

export interface SplitActivities {
  contacted: CrmActivity[];
  notes: CrmActivity[];
  followUps: CrmActivity[];
}

/** Teilt eine flache Aktivitätsliste nach Typ auf und sortiert je Bereich. */
export function splitActivitiesByType(activities: readonly CrmActivity[]): SplitActivities {
  const contacted: CrmActivity[] = [];
  const notes: CrmActivity[] = [];
  const followUps: CrmActivity[] = [];
  for (const a of activities) {
    if (a.activityType === 'contacted') contacted.push(a);
    else if (a.activityType === 'note') notes.push(a);
    else if (a.activityType === 'follow_up') followUps.push(a);
  }
  contacted.sort(sortContacted);
  notes.sort(sortNotes);
  followUps.sort(sortFollowUps);
  return { contacted, notes, followUps };
}
