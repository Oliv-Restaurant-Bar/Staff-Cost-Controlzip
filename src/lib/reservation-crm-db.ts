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
  const out = new Map<string, CompletedVisitAgg>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id, reservation_date')
      .eq('restaurant_id', restaurantId)
      .eq('status_normalized', 'completed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Array<{ guest_id: string | null; reservation_date: string | null }>) {
      if (!row.guest_id) continue;
      const a = out.get(row.guest_id) ?? { visits: 0, firstVisit: null, lastVisit: null };
      a.visits++;
      const d = row.reservation_date;
      if (d) {
        if (!a.firstVisit || d < a.firstVisit) a.firstVisit = d;
        if (!a.lastVisit || d > a.lastVisit) a.lastVisit = d;
      }
      out.set(row.guest_id, a);
    }
    if (data.length < PAGE) break;
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

/** Eine Reservation eines Gastes für die Detailanzeige (inkl. Rohstatus/Res.Nr.). */
export interface GuestReservationDisplay extends GuestReservationRecord {
  id: string;
  externalReservationId: string | null;
  statusRaw: string | null;
}

/** Alle Reservationen eines Gastes, chronologisch (neueste zuerst). */
export async function fetchGuestReservations(
  restaurantId: string,
  guestId: string,
): Promise<GuestReservationDisplay[]> {
  const { data, error } = await (supabase as any)
    .from('reservation_records')
    .select(
      'id, external_reservation_id, reservation_date, reservation_time, party_size, ' +
      'status, status_normalized, room, area, note, comment',
    )
    .eq('restaurant_id', restaurantId)
    .eq('guest_id', guestId)
    .order('reservation_date', { ascending: false })
    .order('reservation_time', { ascending: false });
  if (error || !data) return [];
  return (data as any[]).map(r => ({
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
  }));
}
