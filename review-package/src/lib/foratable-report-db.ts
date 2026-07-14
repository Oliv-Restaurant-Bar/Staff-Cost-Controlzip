/**
 * Foratable Report — Datenbankzugriff (read-only)
 * ===============================================
 * Liest bereits importierte Reservationen aus `reservation_records` für einen
 * Mandanten und Zeitraum und baut daraus den Report (siehe foratable-report.ts).
 *
 * - Mandantengefiltert (`restaurant_id`), paginiert (1000er-Seiten).
 * - Verändert NICHTS an der Import- oder CRM-Logik; nutzt nur die bestehende
 *   Tabelle, keine Migration.
 * - Wirft bei Lesefehlern (kein stilles Fallback).
 */

import { supabase } from '@/integrations/supabase/client';
import type {
  ReservationStatsInput, ReservationStatusNormalized,
} from './reservation-import-parser';
import { buildForatableReport } from './foratable-report';
import type { ForatableReport, ReportRange } from './foratable-report';

const PAGE = 1000;

const STATUSES: ReservationStatusNormalized[] = [
  'completed', 'cancelled', 'noshow', 'confirmed', 'pending', 'unknown',
];

function normStatus(s: string | null): ReservationStatusNormalized {
  return STATUSES.includes(s as ReservationStatusNormalized)
    ? (s as ReservationStatusNormalized)
    : 'unknown';
}

/**
 * Alle Reservationen eines Mandanten im Zeitraum [from, to] (beide inklusive)
 * als schlanke Auswertungs-Zeilen.  `guestKey` = guest_id.
 */
export async function fetchReservationReportRows(
  restaurantId: string,
  from: string,
  to: string,
): Promise<ReservationStatsInput[]> {
  const out: ReservationStatsInput[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id, reservation_date, reservation_time, party_size, status, status_normalized, room, area')
      .eq('restaurant_id', restaurantId)
      .gte('reservation_date', from)
      .lte('reservation_date', to)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Reservationen konnten nicht geladen werden: ${error.message ?? error}`);
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        partySize: typeof r.party_size === 'number' ? r.party_size : null,
        statusNormalized: normStatus(r.status_normalized ?? null),
        statusRaw: r.status ?? '',
        reservationTime: r.reservation_time ?? null,
        reservationDate: r.reservation_date ?? null,
        room: r.room ?? null,
        area: r.area ?? null,
        guestKey: r.guest_id ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Menge der guest_ids, die VOR `beforeDate` mindestens eine Reservation hatten —
 * dient der Neu-/Wiederkehr-Unterscheidung.  Liefert nur IDs (keine PII).
 */
export async function fetchPriorGuestKeys(
  restaurantId: string,
  beforeDate: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await (supabase as any)
      .from('reservation_records')
      .select('guest_id')
      .eq('restaurant_id', restaurantId)
      .lt('reservation_date', beforeDate)
      .not('guest_id', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Frühere Gäste konnten nicht geladen werden: ${error.message ?? error}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ guest_id: string | null }>) {
      if (r.guest_id) ids.add(r.guest_id);
    }
    if (data.length < PAGE) break;
  }
  return ids;
}

/** Lädt den vollständigen Report für Mandant + Zeitraum. Wirft bei Lesefehler. */
export async function loadForatableReport(
  restaurantId: string,
  range: ReportRange,
): Promise<ForatableReport> {
  const [rows, priorGuestKeys] = await Promise.all([
    fetchReservationReportRows(restaurantId, range.from, range.to),
    fetchPriorGuestKeys(restaurantId, range.from),
  ]);
  return buildForatableReport(rows, priorGuestKeys, range);
}
