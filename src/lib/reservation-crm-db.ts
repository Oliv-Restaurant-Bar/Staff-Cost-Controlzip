/**
 * Gäste-CRM — Supabase Lese-Datenschicht (nur lesend)
 * =====================================================
 * Lädt Gästeprofile eines Mandanten sowie alle Reservationen eines einzelnen
 * Gastes aus den bestehenden Tabellen `guest_profiles` / `reservation_records`.
 *
 *  - KEINE Schreiboperationen (reine Analyse-/Leseansicht).
 *  - KEINE neue Tabelle/Migration — die Kennzahlen/Segmente werden in der App
 *    aus diesen Rohdaten berechnet (siehe reservation-crm.ts).
 *  - KEIN Logging von PII (E-Mail/Mobile/Name).
 *
 * Datentypen werden über `(supabase as any)` umgangen (Projektmuster, siehe
 * reservation-import-db.ts), da die generierten Supabase-Typen diese Tabellen
 * nicht kennen.
 */

import { supabase } from '@/integrations/supabase/client';
import type { GuestProfile, GuestReservationRecord, CompletedVisitAgg } from './reservation-crm';
import type { ReservationStatusNormalized } from './reservation-import-parser';
import type { ReservationDetailRow } from './reservation-dashboard';
import type { ActiveVisitRow } from './guest-top-flop';

const PROFILE_COLS =
  'id, restaurant_id, first_name, last_name, email, mobile, first_seen_at, last_seen_at, ' +
  'total_reservations, total_persons, cancelled_reservations, completed_reservations';

/** Alle Gästeprofile eines Mandanten (zuletzt gesehen zuerst). */
export async function fetchGuestProfiles(restaurantId: string): Promise<GuestProfile[]> {
  const { data, error } = await (supabase as any)
    .from('guest_profiles')
    .select(PROFILE_COLS)
    .eq('restaurant_id', restaurantId)
    .order('last_seen_at', { ascending: false, nullsFirst: false });
  if (error || !data) return [];
  return data as GuestProfile[];
}

/**
 * Wie `fetchGuestProfiles`, wirft jedoch bei Lesefehlern statt still `[]`
 * zurückzugeben. Für schreibende Workflows (z. B. den CRM-Import), die einen
 * Supabase-Lesefehler nicht als „keine Gäste" fehlinterpretieren dürfen
 * (Datenintegrität — kein stilles Fallback).
 */
export async function fetchGuestProfilesStrict(restaurantId: string): Promise<GuestProfile[]> {
  const { data, error } = await (supabase as any)
    .from('guest_profiles')
    .select(PROFILE_COLS)
    .eq('restaurant_id', restaurantId)
    .order('last_seen_at', { ascending: false, nullsFirst: false });
  if (error) {
    throw new Error(`Gästeprofile konnten nicht geladen werden: ${error.message ?? 'unbekannter Fehler'}`);
  }
  return (data ?? []) as GuestProfile[];
}

/** Ein einzelnes Gästeprofil (mandantengeprüft). */
export async function fetchGuestById(
  restaurantId: string,
  guestId: string,
): Promise<GuestProfile | null> {
  const { data, error } = await (supabase as any)
    .from('guest_profiles')
    .select(PROFILE_COLS)
    .eq('restaurant_id', restaurantId)
    .eq('id', guestId)
    .maybeSingle();
  if (error || !data) return null;
  return data as GuestProfile;
}

/**
 * Aggregiert die ABGESCHLOSSENEN Besuche aller Gäste eines Mandanten direkt aus
 * `reservation_records` (status_normalized = 'completed').  Liefert je guest_id
 * die Besuchszahl sowie erstes/letztes Besuchsdatum, damit die Gästeliste exakt
 * dieselben Besuchs-/Segmentwerte wie die Detailseite anzeigt.  Paginiert, um das
 * Supabase-Limit von 1000 Zeilen pro Abfrage zu umgehen.
 */
export async function fetchCompletedVisitAggregates(
  restaurantId: string,
): Promise<Map<string, CompletedVisitAgg>> {
  // Laufende Akkumulatoren inkl. Personenzahl-Summe/-Anzahl für die Ø-Gruppengrösse.
  type Acc = {
    visits: number;
    firstVisit: string | null;
    lastVisit: string | null;
    partySizeSum: number;
    partySizeCount: number;
  };
  const acc = new Map<string, Acc>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id, reservation_date, party_size')
      .eq('restaurant_id', restaurantId)
      .eq('status_normalized', 'completed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Array<{ guest_id: string | null; reservation_date: string | null; party_size: number | null }>) {
      if (!row.guest_id) continue;
      const a = acc.get(row.guest_id) ?? { visits: 0, firstVisit: null, lastVisit: null, partySizeSum: 0, partySizeCount: 0 };
      a.visits++;
      const d = row.reservation_date;
      if (d) {
        if (!a.firstVisit || d < a.firstVisit) a.firstVisit = d;
        if (!a.lastVisit || d > a.lastVisit) a.lastVisit = d;
      }
      if (typeof row.party_size === 'number' && Number.isFinite(row.party_size)) {
        a.partySizeSum += row.party_size;
        a.partySizeCount++;
      }
      acc.set(row.guest_id, a);
    }
    if (data.length < PAGE) break;
  }
  const out = new Map<string, CompletedVisitAgg>();
  for (const [id, a] of acc) {
    out.set(id, {
      visits: a.visits,
      firstVisit: a.firstVisit,
      lastVisit: a.lastVisit,
      avgPartySize: a.partySizeCount > 0 ? a.partySizeSum / a.partySizeCount : null,
    });
  }
  return out;
}

const STATUSES: ReservationStatusNormalized[] = [
  'completed', 'cancelled', 'noshow', 'confirmed', 'pending', 'unknown',
];

function normStatus(s: string | null): ReservationStatusNormalized {
  return STATUSES.includes(s as ReservationStatusNormalized)
    ? (s as ReservationStatusNormalized)
    : 'unknown';
}

/**
 * No-Show-Anzahl je Gast (status_normalized = 'noshow'), paginiert.  Liefert nur
 * `guest_id` (keine PII) und dient dem No-Show-Risiko im CRM-Dashboard.
 */
export async function fetchNoShowCountsByGuest(
  restaurantId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id')
      .eq('restaurant_id', restaurantId)
      .eq('status_normalized', 'noshow')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Array<{ guest_id: string | null }>) {
      if (!row.guest_id) continue;
      out.set(row.guest_id, (out.get(row.guest_id) ?? 0) + 1);
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// ── Reservations-Detailzeilen (für klickbare Detaillisten der Auswertung) ──────
// Liefert zusätzlich Anzeigefelder (Name/Uhrzeit/Raum/Kontakt/Kommentar). Die
// Zähl-Prädikate (countInRange/futureReservationKpis) lesen weiterhin NUR die
// Aggregatfelder (date/partySize/status); werden Kacheln und Detailliste aus
// demselben Array berechnet, stimmen die Zahlen exakt überein. Mandantengefiltert,
// paginiert, KEINE PII-Logs.

const DETAIL_COLS =
  'id, guest_id, reservation_date, reservation_time, party_size, status_normalized, ' +
  'first_name, last_name, mobile, email, room, area, comment, note';

function rowDisplayName(
  first: string | null, last: string | null, email: string | null, mobile: string | null,
): string {
  const name = [first, last].map(s => (s ?? '').trim()).filter(Boolean).join(' ').trim();
  if (name) return name;
  if (email && email.trim()) return email.trim();
  if (mobile && mobile.trim()) return mobile.trim();
  return '—';
}

async function fetchReservationDetailRows(
  restaurantId: string,
  bounds: { gte?: string; lte?: string },
): Promise<ReservationDetailRow[]> {
  const out: ReservationDetailRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = (supabase as any)
      .from('reservation_records')
      .select(DETAIL_COLS)
      .eq('restaurant_id', restaurantId);
    if (bounds.gte) q = q.gte('reservation_date', bounds.gte);
    if (bounds.lte) q = q.lte('reservation_date', bounds.lte);
    const { data, error } = await q
      .order('reservation_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        id: String(r.id),
        guestId: r.guest_id ? String(r.guest_id) : null,
        date: r.reservation_date ?? null,
        partySize: r.party_size ?? null,
        // Rohwert durchreichen — die Dashboard-Prädikate klassifizieren
        // case-insensitive (inkl. seated/arrived/not_answered/storniert …).
        status: r.status_normalized ?? 'unknown',
        displayName: rowDisplayName(r.first_name ?? null, r.last_name ?? null, r.email ?? null, r.mobile ?? null),
        time: r.reservation_time ?? null,
        room: r.room ?? null,
        area: r.area ?? null,
        phone: r.mobile ?? null,
        email: r.email ?? null,
        comment: r.comment ?? null,
        note: r.note ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Zukünftige Reservationen ab (inkl.) `fromDate`, optional bis (inkl.) `toDate`.
 * Die Auswertung begrenzt die Abfrage auf die späteste Zukunfts-Kachelgrenze.
 */
export async function fetchFutureReservations(
  restaurantId: string,
  fromDate: string,
  toDate?: string,
): Promise<ReservationDetailRow[]> {
  return fetchReservationDetailRows(restaurantId, { gte: fromDate, lte: toDate });
}

/** Reservationen im Datumsbereich [from, to] (beide inklusive). */
export async function fetchReservationsInRange(
  restaurantId: string,
  from: string,
  to: string,
): Promise<ReservationDetailRow[]> {
  return fetchReservationDetailRows(restaurantId, { gte: from, lte: to });
}

/** Eine Reservation eines Gastes für die Detailanzeige (inkl. Rohstatus/Res.Nr.). */
export interface GuestReservationDisplay extends GuestReservationRecord {
  id: string;
  externalReservationId: string | null;
  statusRaw: string | null;
}

/**
 * Alle Reservationen eines Gastes, chronologisch (neueste zuerst).  Paginiert
 * (1000er-Seiten wie die übrigen Lese-Helfer), damit Vielbesucher nicht still am
 * Supabase-Standardlimit abgeschnitten werden — Detail-Kennzahlen, Trend und
 * Score würden sonst auf unvollständigen Daten rechnen.  Stabile Sortierung über
 * `id` als letzten Tiebreaker, damit die Seiten lückenlos aneinander anschliessen.
 */
export async function fetchGuestReservations(
  restaurantId: string,
  guestId: string,
): Promise<GuestReservationDisplay[]> {
  const out: GuestReservationDisplay[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select(
        'id, external_reservation_id, reservation_date, reservation_time, party_size, ' +
        'status, status_normalized, room, area, note, comment',
      )
      .eq('restaurant_id', restaurantId)
      .eq('guest_id', guestId)
      .order('reservation_date', { ascending: false })
      .order('reservation_time', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        id: r.id,
        externalReservationId: r.external_reservation_id ?? null,
        reservationDate: r.reservation_date ?? null,
        reservationTime: r.reservation_time ?? null,
        partySize: r.party_size ?? null,
        statusNormalized: normStatus(r.status_normalized ?? null),
        statusRaw: r.status ?? null,
        room: r.room ?? null,
        area: r.area ?? null,
        note: r.note ?? null,
        comment: r.comment ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Alle AKTIVEN Reservationen (status_normalized ∈ {completed, confirmed}) eines
 * Mandanten innerhalb [from, to] (ISO yyyy-MM-dd, inklusive) — liefert die
 * Rohzeilen (guestId/Datum/Personen/Status) für die Top/Flop-Auswertung, ohne
 * sie zu gruppieren. Mandantengefiltert, paginiert (1000), KEINE PII (nur
 * IDs/Datum/Personenzahl). Server-seitige Status- und Datumsfilter; die pure
 * Zählung (`inRangeVisitCounts`) prüft beides defensiv erneut.
 */
export async function fetchActiveVisitsByGuest(
  restaurantId: string,
  from: string,
  to: string,
): Promise<ActiveVisitRow[]> {
  const out: ActiveVisitRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id, reservation_date, party_size, status_normalized')
      .eq('restaurant_id', restaurantId)
      .in('status_normalized', ['completed', 'confirmed'])
      .gte('reservation_date', from)
      .lte('reservation_date', to)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{
      guest_id: string | null;
      reservation_date: string | null;
      party_size: number | null;
      status_normalized: string | null;
    }>) {
      if (!r.guest_id) continue;
      out.push({
        guestId: r.guest_id,
        date: r.reservation_date ?? null,
        partySize: typeof r.party_size === 'number' ? r.party_size : null,
        status: r.status_normalized ?? '',
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
