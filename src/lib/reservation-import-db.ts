/**
 * Reservationen Import — Supabase DB-Schicht
 * ===========================================
 * Schreib-/Lese-Operationen für die Tabellen reservation_imports,
 * guest_profiles, reservation_records.
 *
 * Wichtige Eigenschaften:
 *  - Dedup/Upsert pro Reservation über (restaurant_id, external_reservation_id):
 *    erneuter Import derselben Res.Nr. AKTUALISIERT statt zu duplizieren.
 *  - Gast-Wiedererkennung gegen bestehende Profile NUR über Telefon → E-Mail
 *    (Telefon hat Vorrang). Ein neuer Gast wird angelegt, wenn weder Telefon noch
 *    E-Mail ein bestehendes Profil treffen; Namensgleichheit allein führt KEINE
 *    bestehenden Profile zusammen (siehe resolveExisting).
 *  - Gast-Aggregate werden NACH dem Schreiben aus reservation_records neu
 *    berechnet (Upserts machen inkrementelle Zähler unzuverlässig), beschränkt
 *    auf die betroffenen guest_ids (gechunkte .in()-Abfragen).
 *  - Wiederherstellbarer Import-Lebenszyklus: 'processing' → 'active' | 'failed'.
 *  - KEIN Logging von PII (E-Mail/Mobile/Name) und kein Löschen fremder Zeilen.
 *
 * Datentypen werden über `(supabase as any)` umgangen (Projektmuster, siehe
 * gn-zbericht-db.ts), da die generierten Supabase-Typen diese Tabellen nicht
 * kennen.
 */

import { supabase } from '@/integrations/supabase/client';
import { buildMatchKey, dedupeReservationsByExternalId } from './reservation-import-parser';
import type { ParsedReservation, ReservationParseResult } from './reservation-import-parser';

// ── Typen ────────────────────────────────────────────────────────────────────

export interface ReservationImportRow {
  id: string;
  restaurant_id: string;
  file_name: string;
  period_from: string | null;
  period_to: string | null;
  reservation_count: number | null;
  total_persons: number | null;
  cancelled_count: number | null;
  completed_count: number | null;
  new_guests: number | null;
  returning_guests: number | null;
  status: string;
  error_message: string | null;
  checksum: string | null;
  imported_at: string;
  created_at: string;
}

interface GuestProfileRow {
  id: string;
  restaurant_id: string;
  match_key: string;
  normalized_email: string | null;
  normalized_mobile: string | null;
  normalized_name: string | null;
}

export interface GuestClassification {
  distinctGuests: number;
  newGuests: number;
  returningGuests: number;
  reservationsWithoutGuest: number;
}

// ── Hilfen ───────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface DistinctGuest {
  matchKey: string;
  normalizedEmail: string | null;
  normalizedMobile: string | null;
  normalizedName: string | null;
  firstName: string;
  lastName: string;
  email: string;
  mobile: string;
}

/** Eindeutige Gäste (mit matchKey) aus den Reservationen extrahieren. */
function distinctGuestsFrom(reservations: ParsedReservation[]): DistinctGuest[] {
  const map = new Map<string, DistinctGuest>();
  for (const r of reservations) {
    if (!r.matchKey) continue;
    if (!map.has(r.matchKey)) {
      map.set(r.matchKey, {
        matchKey: r.matchKey,
        normalizedEmail: r.normalizedEmail,
        normalizedMobile: r.normalizedMobile,
        normalizedName: r.normalizedName,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        mobile: r.mobile,
      });
    }
  }
  return [...map.values()];
}

interface GuestCluster {
  members: DistinctGuest[];
  canonical: DistinctGuest;
}

/**
 * Fasst eindeutige Gäste eines Imports zusammen, die sich Identitäten teilen
 * (E-Mail, Mobile oder normalisierter Name) — transitiv via Union-Find. So
 * erzeugt derselbe physische Gast mit z. B. E-Mail+Mobile vs. Mobile-only NICHT
 * mehrere guest_profiles. Jeder Cluster bekommt eine kanonische Identität
 * (Union aller bekannten Felder, match_key bevorzugt E-Mail → Mobile → Name).
 */
function clusterGuests(guests: DistinctGuest[]): GuestCluster[] {
  const n = guests.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const firstByIdentity = new Map<string, number>();
  const link = (key: string | null, i: number) => {
    if (!key) return;
    const prev = firstByIdentity.get(key);
    if (prev !== undefined) union(i, prev);
    else firstByIdentity.set(key, i);
  };

  guests.forEach((g, i) => {
    link(g.normalizedEmail ? `e:${g.normalizedEmail}` : null, i);
    link(g.normalizedMobile ? `m:${g.normalizedMobile}` : null, i);
    link(g.normalizedName ? `n:${g.normalizedName}` : null, i);
  });

  const byRoot = new Map<number, DistinctGuest[]>();
  guests.forEach((g, i) => {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(g);
    byRoot.set(r, arr);
  });

  return [...byRoot.values()].map(members => ({ members, canonical: mergeCluster(members) }));
}

/** Verschmilzt die Identitäten eines Clusters zu einer kanonischen DistinctGuest. */
function mergeCluster(members: DistinctGuest[]): DistinctGuest {
  const pick = (sel: (g: DistinctGuest) => string | null | undefined): string | null => {
    for (const m of members) {
      const v = sel(m);
      if (v) return v;
    }
    return null;
  };
  const normalizedEmail = pick(m => m.normalizedEmail);
  const normalizedMobile = pick(m => m.normalizedMobile);
  const normalizedName = pick(m => m.normalizedName);
  const named = members.find(m => m.firstName || m.lastName) ?? members[0];
  const withEmail = members.find(m => m.email) ?? members[0];
  const withMobile = members.find(m => m.mobile) ?? members[0];
  return {
    matchKey: buildMatchKey(normalizedEmail, normalizedMobile, normalizedName) ?? members[0].matchKey,
    normalizedEmail,
    normalizedMobile,
    normalizedName,
    firstName: named.firstName,
    lastName: named.lastName,
    email: withEmail.email,
    mobile: withMobile.mobile,
  };
}

/**
 * Lädt bestehende Gästeprofile, die zu einer der Identitäten passen.
 * Es wird über match_key sowie normalisierte E-Mail/Mobile/Name gesucht, damit
 * z. B. eine spätere Telefon-only-Buchung ein früheres E-Mail-Profil findet.
 */
async function fetchExistingGuests(
  restaurantId: string,
  guests: DistinctGuest[],
): Promise<GuestProfileRow[]> {
  const cols = 'id, restaurant_id, match_key, normalized_email, normalized_mobile, normalized_name';
  const byId = new Map<string, GuestProfileRow>();

  const queryIn = async (column: string, values: string[]) => {
    const distinct = [...new Set(values.filter(v => !!v))];
    for (const part of chunk(distinct, 150)) {
      if (part.length === 0) continue;
      const { data, error } = await (supabase as any)
        .from('guest_profiles')
        .select(cols)
        .eq('restaurant_id', restaurantId)
        .in(column, part);
      if (error) throw new Error(error.message ?? String(error));
      for (const row of (data ?? []) as GuestProfileRow[]) byId.set(row.id, row);
    }
  };

  await queryIn('match_key', guests.map(g => g.matchKey));
  await queryIn('normalized_email', guests.map(g => g.normalizedEmail ?? '').filter(Boolean));
  await queryIn('normalized_mobile', guests.map(g => g.normalizedMobile ?? '').filter(Boolean));
  await queryIn('normalized_name', guests.map(g => g.normalizedName ?? '').filter(Boolean));

  return [...byId.values()];
}

/**
 * Findet ein bestehendes Profil zu einer Identität — Priorität: Telefon → E-Mail.
 *
 * Ein neuer Gast wird angelegt, wenn WEDER die normalisierte Telefonnummer NOCH
 * die (case-insensitive) E-Mail ein bestehendes Profil treffen. Die Telefon-
 * nummer hat Vorrang vor der E-Mail (zuverlässigster Identifikator; E-Mails
 * werden eher geteilt/gewechselt).
 *
 * Es wird BEWUSST NICHT über Name/match_key auf bestehende DB-Profile gematcht:
 * Namensgleichheit ist kein verlässlicher Identitätsbeweis (zwei verschiedene
 * Personen können denselben Namen tragen) und würde fremde, per Kontaktdaten
 * identifizierte Profile fälschlich zusammenführen. Die Zusammenfassung mehrerer
 * Zeilen DESSELBEN Imports erfolgt weiterhin in clusterGuests; die Idempotenz
 * reiner Namens-Gäste (ohne Telefon/E-Mail) sichert der spätere Upsert über
 * (restaurant_id, match_key). Alle Kandidaten stammen aus mandantengefilterten
 * Reads (siehe fetchExistingGuests).
 */
function resolveExisting(g: DistinctGuest, existing: GuestProfileRow[]): GuestProfileRow | null {
  if (g.normalizedMobile) {
    const hit = existing.find(e => e.normalized_mobile && e.normalized_mobile === g.normalizedMobile);
    if (hit) return hit;
  }
  if (g.normalizedEmail) {
    const hit = existing.find(e => e.normalized_email && e.normalized_email === g.normalizedEmail);
    if (hit) return hit;
  }
  return null;
}

// ── Tabellen-Setup prüfen ────────────────────────────────────────────────────

// ── Upsert-Vorschau & Undo-Snapshot (dublettensicher über Res.Nr.) ───────────

/** Import-relevante Spalten einer Reservation (für Diff-Vergleich + Snapshot). */
const RESERVATION_COMPARE_COLS = [
  'external_reservation_id', 'restaurant_name', 'reservation_date', 'reservation_time',
  'party_size', 'company', 'first_name', 'last_name', 'mobile', 'email',
  'status', 'status_normalized', 'reserved_at', 'comment', 'note',
  'table_name', 'selection', 'guest_information', 'room', 'area',
] as const;

/** Mapped eine geparste Reservation auf die vergleichbaren DB-Feldwerte. */
function comparableFields(r: ParsedReservation): Record<string, unknown> {
  return {
    restaurant_name: r.restaurantName || null,
    reservation_date: r.reservationDate,
    reservation_time: r.reservationTime,
    party_size: r.partySize,
    company: r.company || null,
    first_name: r.firstName || null,
    last_name: r.lastName || null,
    mobile: r.mobile || null,
    email: r.email || null,
    status: r.statusRaw || null,
    status_normalized: r.statusNormalized,
    reserved_at: r.reservedAt,
    comment: r.comment || null,
    note: r.note || null,
    table_name: r.tableName || null,
    selection: r.selection || null,
    guest_information: r.guestInformation || null,
    room: r.room || null,
    area: r.area || null,
  };
}

export interface ReservationDiffPreview {
  neu: number;
  aktualisiert: number;
  unveraendert: number;
}

/**
 * Vorschau VOR dem Schreiben: vergleicht die (über Res.Nr. deduplizierten)
 * CSV-Reservationen mit dem DB-Bestand des Mandanten →
 * «X neu · Y aktualisiert · Z unverändert». Wirft bei DB-Fehler.
 */
export async function previewReservationDiff(
  restaurantId: string, reservations: ParsedReservation[],
): Promise<ReservationDiffPreview> {
  const { deduped } = dedupeReservationsByExternalId(reservations);
  const existing = new Map<string, Record<string, unknown>>();
  for (const part of chunk([...new Set(deduped.map(r => r.externalReservationId))], 200)) {
    if (part.length === 0) continue;
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select(RESERVATION_COMPARE_COLS.join(', '))
      .eq('restaurant_id', restaurantId)
      .in('external_reservation_id', part);
    if (error) throw new Error(`Bestehende Reservationen konnten nicht geprüft werden: ${error.message ?? error}`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      existing.set(String(row.external_reservation_id), row);
    }
  }
  let neu = 0, aktualisiert = 0, unveraendert = 0;
  for (const r of deduped) {
    const ex = existing.get(r.externalReservationId);
    if (!ex) { neu++; continue; }
    const want = comparableFields(r);
    // Reine Feldgleichheit (dieselben Spalten, die der Import schreibt).
    const same = Object.entries(want).every(([k, v]) => {
      const cur = ex[k] ?? null;
      // reserved_at kommt aus der DB als Timestamp-String — nur Wertvergleich auf String-Basis.
      if (k === 'reserved_at') {
        const a = cur == null ? null : String(cur).slice(0, 16);
        const b = v == null ? null : String(v).slice(0, 16);
        return a === b;
      }
      return (cur ?? null) === (v ?? null);
    });
    if (same) unveraendert++; else aktualisiert++;
  }
  return { neu, aktualisiert, unveraendert };
}

/**
 * Snapshot-Spalten = exakt die Spalten, die der Import schreibt (+ Schlüssel).
 * KEIN select('*'): hält den Undo-Snapshot klein; Spalten, die der Import nie
 * anfasst (z.B. created_at), müssen nicht gesichert werden — der Restore-Upsert
 * einer Teilmenge lässt sie unverändert.
 */
const RESERVATION_SNAPSHOT_COLS =
  ['restaurant_id', 'guest_id', 'source_file_name', 'last_import_id', 'updated_at',
   ...RESERVATION_COMPARE_COLS] as const;

/**
 * Vorzustands-Zeilen der betroffenen Res.Nr. (für den Undo-Snapshot; nur die
 * vom Import geschriebenen Spalten). Nur Zeilen, die bereits existieren —
 * fehlende Res.Nr. = neu. Wirft bei DB-Fehler (Backup unvollständig = Import
 * nicht starten).
 */
export async function fetchPriorReservationRows(
  restaurantId: string, externalIds: string[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const part of chunk([...new Set(externalIds)], 200)) {
    if (part.length === 0) continue;
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select(RESERVATION_SNAPSHOT_COLS.join(', '))
      .eq('restaurant_id', restaurantId)
      .in('external_reservation_id', part);
    if (error) throw new Error(`Backup fehlgeschlagen: ${error.message ?? error}`);
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
  }
  return rows;
}

export async function checkReservationTablesExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any)
      .from('reservation_imports')
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ── Vorschau: neue vs. wiederkehrende Gäste ──────────────────────────────────

/**
 * Klassifiziert die Gäste einer Datei in neu/wiederkehrend (für die Vorschau),
 * ohne etwas zu schreiben.
 */
export async function classifyGuests(
  restaurantId: string,
  reservations: ParsedReservation[],
): Promise<GuestClassification> {
  const guests = distinctGuestsFrom(reservations);
  const reservationsWithoutGuest = reservations.filter(r => !r.matchKey).length;

  if (guests.length === 0) {
    return { distinctGuests: 0, newGuests: 0, returningGuests: 0, reservationsWithoutGuest };
  }

  const existing = await fetchExistingGuests(restaurantId, guests);
  const clusters = clusterGuests(guests);
  let newGuests = 0;
  let returningGuests = 0;
  for (const c of clusters) {
    if (resolveExisting(c.canonical, existing)) returningGuests++;
    else newGuests++;
  }
  return { distinctGuests: clusters.length, newGuests, returningGuests, reservationsWithoutGuest };
}

// ── Import speichern (Lebenszyklus) ──────────────────────────────────────────

export interface SaveReservationImportResult {
  importId: string;
  error: string | null;
  newGuests: number;
  returningGuests: number;
  /** Eindeutige Reservationen, die gespeichert wurden (= inserted + updated). */
  reservationCount: number;
  /** Reservationen, deren Res.Nr. es für diesen Mandanten noch nicht gab (neu angelegt). */
  inserted: number;
  /** Reservationen, deren Res.Nr. bereits existierte (aktualisiert/ersetzt statt dupliziert). */
  updated: number;
  /** Anzahl CSV-Zeilen, die wegen identischer Res.Nr. (Conflict-Key) zusammengeführt wurden. */
  duplicateKeyMerged: number;
  /** CSV-Zeilen, die gar nicht importiert wurden (z. B. ohne Res.Nr.). */
  skippedRows: number;
}

export async function saveReservationImport(
  restaurantId: string,
  parseResult: ReservationParseResult,
): Promise<SaveReservationImportResult> {
  const reservations = parseResult.reservations;
  const stats = parseResult.stats;

  const fail = (importId: string, error: string): SaveReservationImportResult =>
    ({ importId: '', error, newGuests: 0, returningGuests: 0, reservationCount: 0, inserted: 0, updated: 0, duplicateKeyMerged: 0, skippedRows: 0 });

  // Zeilen, die der Parser gar nicht erst übernommen hat (z. B. ohne Res.Nr.).
  const skippedRows = (parseResult.errors ?? []).filter(e => e.kind === 'skipped').length;

  // 1. Import-Kopf als 'processing' anlegen.
  let importId = '';
  try {
    const { data, error } = await (supabase as any)
      .from('reservation_imports')
      .insert({
        restaurant_id: restaurantId,
        file_name: parseResult.fileName,
        period_from: stats.periodFrom,
        period_to: stats.periodTo,
        status: 'processing',
        checksum: parseResult.checksum,
      })
      .select('id')
      .single();
    if (error || !data) return fail('', error?.message ?? 'Import-Kopf konnte nicht angelegt werden.');
    importId = data.id;
  } catch (e) {
    return fail('', e instanceof Error ? e.message : String(e));
  }

  // Ab hier: bei Fehler Import als 'failed' markieren.
  const markFailed = async (msg: string): Promise<SaveReservationImportResult> => {
    try {
      await (supabase as any)
        .from('reservation_imports')
        .update({ status: 'failed', error_message: msg.slice(0, 500) })
        .eq('id', importId);
    } catch { /* sekundärer Fehler — primärer Fehler wird zurückgegeben */ }
    return fail(importId, msg);
  };

  try {
    // 2. Gäste auflösen / neu anlegen. Identitäts-Cluster verhindern Duplikate,
    //    wenn derselbe Gast im Import mit unterschiedlich vollständigen Daten auftaucht.
    const guests = distinctGuestsFrom(reservations);
    const existing = guests.length > 0 ? await fetchExistingGuests(restaurantId, guests) : [];
    const clusters = clusterGuests(guests);

    const guestIdByMatchKey = new Map<string, string>();
    const pendingNew: GuestCluster[] = [];
    const upgrades: Array<{ id: string; fields: Record<string, string> }> = [];
    let returningGuests = 0;

    for (const c of clusters) {
      const hit = resolveExisting(c.canonical, existing);
      if (hit) {
        returningGuests++;
        for (const m of c.members) guestIdByMatchKey.set(m.matchKey, hit.id);
        // Bestehendes Profil mit neu gelernten Identitäten anreichern, damit eine
        // spätere E-Mail/Mobile-only-Buchung dieses Profil wiederfindet.
        const fields: Record<string, string> = {};
        if (!hit.normalized_email && c.canonical.normalizedEmail) {
          fields.normalized_email = c.canonical.normalizedEmail;
          if (c.canonical.email) fields.email = c.canonical.email;
        }
        if (!hit.normalized_mobile && c.canonical.normalizedMobile) {
          fields.normalized_mobile = c.canonical.normalizedMobile;
          if (c.canonical.mobile) fields.mobile = c.canonical.mobile;
        }
        if (!hit.normalized_name && c.canonical.normalizedName) {
          fields.normalized_name = c.canonical.normalizedName;
        }
        if (Object.keys(fields).length > 0) upgrades.push({ id: hit.id, fields });
      } else {
        pendingNew.push(c);
      }
    }

    // Neue Gäste anlegen (Upsert gegen (restaurant_id, match_key) — robust gegen Doppelläufe).
    const nowIso = new Date().toISOString();
    const membersByCanonKey = new Map<string, DistinctGuest[]>(
      pendingNew.map(c => [c.canonical.matchKey, c.members]),
    );
    let newGuests = 0;
    for (const part of chunk(pendingNew, 200)) {
      if (part.length === 0) continue;
      const rows = part.map(({ canonical: g }) => ({
        restaurant_id: restaurantId,
        match_key: g.matchKey,
        first_name: g.firstName || null,
        last_name: g.lastName || null,
        email: g.email || null,
        mobile: g.mobile || null,
        normalized_email: g.normalizedEmail,
        normalized_mobile: g.normalizedMobile,
        normalized_name: g.normalizedName,
        updated_at: nowIso,
      }));
      const { data, error } = await (supabase as any)
        .from('guest_profiles')
        .upsert(rows, { onConflict: 'restaurant_id,match_key' })
        .select('id, match_key');
      if (error) return await markFailed(`Gästeprofile konnten nicht gespeichert werden: ${error.message ?? error}`);
      for (const row of (data ?? []) as Array<{ id: string; match_key: string }>) {
        const members = membersByCanonKey.get(row.match_key) ?? [];
        for (const m of members) guestIdByMatchKey.set(m.matchKey, row.id);
        newGuests++;
      }
    }

    // Bestehende Profile mit neu gelernten Identitäten aktualisieren.
    for (const u of upgrades) {
      const { error } = await (supabase as any)
        .from('guest_profiles')
        .update({ ...u.fields, updated_at: nowIso })
        .eq('id', u.id);
      if (error) return await markFailed(`Gästeprofil konnte nicht aktualisiert werden: ${error.message ?? error}`);
    }

    // 3. Reservationen upserten (Dedup über (restaurant_id, external_reservation_id)).
    //    WICHTIG: Innerhalb derselben CSV können mehrere Zeilen dieselbe Res.Nr.
    //    tragen. Ein einzelner Bulk-Upsert darf dieselbe Zielzeile nicht zweimal
    //    treffen ("ON CONFLICT DO UPDATE command cannot affect row a second
    //    time"), deshalb pro Conflict-Key nur einen Datensatz behalten
    //    (deterministisch: letzte Zeile gewinnt).
    const { deduped: dedupedReservations, duplicateKeyMerged } =
      dedupeReservationsByExternalId(reservations);

    // Kopf-Statistik aus dem tatsächlich gespeicherten (deduplizierten) Datensatz
    // berechnen, damit reservation_count / total_persons / cancelled / completed
    // konsistent dieselbe Datenmenge beschreiben (gleiche Definitionen wie der Parser).
    const dedupTotalPersons = dedupedReservations.reduce((s, r) => s + (r.partySize ?? 0), 0);
    const dedupCompletedCount = dedupedReservations.filter(r => r.statusNormalized === 'completed').length;
    const dedupCancelledCount = dedupedReservations.filter(r => r.statusNormalized === 'cancelled').length;

    // Vor dem Upsert die bereits gespeicherten Res.Nr. dieses Mandanten lesen, um
    // neu-eingefügt vs. aktualisiert/ersetzt zu unterscheiden. Supabase' upsert
    // meldet nicht, welche Zeilen INSERT vs. UPDATE waren, deshalb dieser
    // gechunkte, tenant-gefilterte Read-before-write (Projektmuster, vgl.
    // fetchExistingGuests). Race-Conditions sind hier unkritisch: der UNIQUE-
    // Constraint verhindert Duplikate, die Zahlen sind nur Statistik.
    const incomingExtIds = dedupedReservations.map(r => r.externalReservationId);
    const existingExtIds = new Set<string>();
    for (const part of chunk([...new Set(incomingExtIds)], 200)) {
      if (part.length === 0) continue;
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('external_reservation_id')
        .eq('restaurant_id', restaurantId)
        .in('external_reservation_id', part);
      if (error) return await markFailed(`Bestehende Reservationen konnten nicht geprüft werden: ${error.message ?? error}`);
      for (const row of (data ?? []) as Array<{ external_reservation_id: string }>) {
        existingExtIds.add(row.external_reservation_id);
      }
    }
    const updated = incomingExtIds.filter(id => existingExtIds.has(id)).length;
    const inserted = incomingExtIds.length - updated;

    const recordRows = dedupedReservations.map(r => ({
      restaurant_id: restaurantId,
      external_reservation_id: r.externalReservationId,
      guest_id: r.matchKey ? guestIdByMatchKey.get(r.matchKey) ?? null : null,
      restaurant_name: r.restaurantName || null,
      reservation_date: r.reservationDate,
      reservation_time: r.reservationTime,
      party_size: r.partySize,
      company: r.company || null,
      first_name: r.firstName || null,
      last_name: r.lastName || null,
      mobile: r.mobile || null,
      email: r.email || null,
      status: r.statusRaw || null,
      status_normalized: r.statusNormalized,
      reserved_at: r.reservedAt,
      comment: r.comment || null,
      note: r.note || null,
      table_name: r.tableName || null,
      selection: r.selection || null,
      guest_information: r.guestInformation || null,
      room: r.room || null,
      area: r.area || null,
      source_file_name: parseResult.fileName,
      last_import_id: importId,
      updated_at: nowIso,
    }));

    for (const part of chunk(recordRows, 400)) {
      if (part.length === 0) continue;
      const { error } = await (supabase as any)
        .from('reservation_records')
        .upsert(part, { onConflict: 'restaurant_id,external_reservation_id' });
      if (error) return await markFailed(`Reservationen konnten nicht gespeichert werden: ${error.message ?? error}`);
    }

    // 4. Gast-Aggregate neu berechnen (nur betroffene guest_ids).
    const affectedIds = [...new Set([...guestIdByMatchKey.values()])];
    if (affectedIds.length > 0) {
      const recompErr = await recomputeGuestAggregates(restaurantId, affectedIds);
      if (recompErr) return await markFailed(`Gäste-Statistik konnte nicht aktualisiert werden: ${recompErr}`);
    }

    // 5. Import-Kopf finalisieren.
    const { error: finErr } = await (supabase as any)
      .from('reservation_imports')
      .update({
        reservation_count: dedupedReservations.length,
        total_persons: dedupTotalPersons,
        cancelled_count: dedupCancelledCount,
        completed_count: dedupCompletedCount,
        new_guests: newGuests,
        returning_guests: returningGuests,
        status: 'active',
        imported_at: nowIso,
      })
      .eq('id', importId);
    if (finErr) return await markFailed(`Import-Kopf konnte nicht finalisiert werden: ${finErr.message ?? finErr}`);

    return {
      importId,
      error: null,
      newGuests,
      returningGuests,
      reservationCount: dedupedReservations.length,
      inserted,
      updated,
      duplicateKeyMerged,
      skippedRows,
    };
  } catch (e) {
    return await markFailed(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Berechnet total/cancelled/completed/persons sowie first/last_seen für die
 * angegebenen guest_ids aus reservation_records neu.  Rückgabe: Fehlertext | null.
 */
export async function recomputeGuestAggregates(restaurantId: string, guestIds: string[]): Promise<string | null> {
  interface Agg {
    total: number;
    persons: number;
    cancelled: number;
    completed: number;
    first: string | null;
    last: string | null;
  }
  const agg = new Map<string, Agg>();
  for (const id of guestIds) agg.set(id, { total: 0, persons: 0, cancelled: 0, completed: 0, first: null, last: null });

  try {
    for (const part of chunk(guestIds, 150)) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('guest_id, party_size, status_normalized, reservation_date')
        .eq('restaurant_id', restaurantId)
        .in('guest_id', part);
      if (error) return error.message ?? String(error);
      for (const row of (data ?? []) as Array<{
        guest_id: string | null;
        party_size: number | null;
        status_normalized: string | null;
        reservation_date: string | null;
      }>) {
        if (!row.guest_id) continue;
        const a = agg.get(row.guest_id);
        if (!a) continue;
        a.total++;
        a.persons += row.party_size ?? 0;
        if (row.status_normalized === 'cancelled') a.cancelled++;
        if (row.status_normalized === 'completed') a.completed++;
        if (row.reservation_date) {
          if (!a.first || row.reservation_date < a.first) a.first = row.reservation_date;
          if (!a.last || row.reservation_date > a.last) a.last = row.reservation_date;
        }
      }
    }

    const nowIso = new Date().toISOString();
    for (const [id, a] of agg.entries()) {
      const { error } = await (supabase as any)
        .from('guest_profiles')
        .update({
          total_reservations: a.total,
          total_persons: a.persons,
          cancelled_reservations: a.cancelled,
          completed_reservations: a.completed,
          first_seen_at: a.first,
          last_seen_at: a.last,
          updated_at: nowIso,
        })
        .eq('id', id);
      if (error) return error.message ?? String(error);
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── Importverlauf laden ──────────────────────────────────────────────────────

export async function fetchReservationImports(restaurantId: string): Promise<ReservationImportRow[]> {
  const { data, error } = await (supabase as any)
    .from('reservation_imports')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as ReservationImportRow[];
}
