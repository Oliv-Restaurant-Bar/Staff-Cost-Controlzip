/**
 * Reservationen — Cockpit-Kennzahlen (reserviert / grosse Gruppen)
 * ================================================================
 * Berechnet aus den bereits importierten Reservationen (Tabelle
 * `reservation_records`, Foratable-Import) zwei Cockpit-Kennzahlen für einen
 * Zeitraum — WEITERVERWENDUNG der bestehenden Tabelle, KEINE Paralleltabelle:
 *
 *   a) «Reservierte Gäste»   = Σ Personen aller GEZÄHLTEN Reservationen.
 *   b) «Gruppen ab N Pax»    = Anzahl gezählter Reservationen mit
 *                              Personen >= Schwelle  +  Σ Personen dieser Gruppen.
 *
 * «Gezählt» = Status ∈ zentraler Zählregel (reservation-cockpit-settings).
 * Der Zeitraum ist NICHT auf «heute» geklemmt → zukünftige Reservationen zählen
 * mit (Cockpit zeigt geplante Perioden). Fehlen für den Zeitraum GAR KEINE
 * Reservationen (Import fehlt), liefern die Felder `null` («—», nie still 0).
 *
 * PostgREST-Row-Cap: es wird paginiert (range) statt eines einzelnen grossen
 * Selects; Aggregation erfolgt clientseitig über die schlanken Spalten
 * (party_size, status_normalized). Die reine Aggregations-Logik
 * (`aggregateReservationMetrics`) ist ohne DB testbar.
 */

import { supabase } from '@/integrations/supabase/client';
import type { TenantId } from '@/contexts/TenantContext';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';
import { statusCounts, type ReservationCountingSettings } from '@/lib/reservation-cockpit-settings';

/** Cockpit-Kennzahlen eines Zeitraums. `null` = keine Datenbasis (Import fehlt). */
export interface ReservationMetrics {
  /** Σ Personen aller gezählten Reservationen (null = keine Daten). */
  reservedGuests: number | null;
  /** Anzahl gezählter Reservationen >= Schwelle (null = keine Daten). */
  largeGroupCount: number | null;
  /** Σ Personen dieser grossen Gruppen (null = keine Daten). */
  largeGroupPersons: number | null;
}

const EMPTY: ReservationMetrics = { reservedGuests: null, largeGroupCount: null, largeGroupPersons: null };

/** Schlanke DB-Zeile für die Aggregation. */
export interface ReservationMetricRow {
  party_size: number | null;
  status_normalized: ReservationStatusNormalized | string | null;
}

/**
 * Reine Aggregation: Σ Personen der gezählten Reservationen sowie Anzahl/Σ der
 * grossen Gruppen (Personen >= Schwelle). `hasData=false` → alle Felder null
 * (Import fehlt, «—» statt 0). Rein & testbar (keine DB/DOM).
 */
export function aggregateReservationMetrics(
  rows: ReservationMetricRow[],
  settings: ReservationCountingSettings,
  hasData: boolean,
): ReservationMetrics {
  if (!hasData) return { ...EMPTY };
  let reservedGuests = 0;
  let largeGroupCount = 0;
  let largeGroupPersons = 0;
  for (const row of rows) {
    const status = (row.status_normalized ?? 'unknown') as ReservationStatusNormalized;
    if (!statusCounts(status, settings)) continue;
    const pax = typeof row.party_size === 'number' && Number.isFinite(row.party_size) ? row.party_size : 0;
    reservedGuests += pax;
    if (pax >= settings.groupThreshold) {
      largeGroupCount++;
      largeGroupPersons += pax;
    }
  }
  return { reservedGuests, largeGroupCount, largeGroupPersons };
}

const PAGE = 1000;

/**
 * Lädt alle Reservations-Zeilen eines Zeitraums (nur benötigte Spalten),
 * paginiert gegen den PostgREST-Row-Cap. Rückgabe: alle Zeilen ODER null bei
 * DB-Fehler (Aufrufer behandelt null als «keine Daten»).
 */
async function fetchRows(
  tenantId: TenantId, fromIso: string, toIso: string,
): Promise<ReservationMetricRow[] | null> {
  try {
    const all: ReservationMetricRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('party_size, status_normalized')
        .eq('restaurant_id', tenantId)
        .gte('reservation_date', fromIso)
        .lte('reservation_date', toIso)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return null;
      const batch = (data ?? []) as ReservationMetricRow[];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return all;
  } catch {
    return null;
  }
}

/**
 * Cockpit-Kennzahlen eines Zeitraums [fromIso, toIso] (inkl. beider Grenzen).
 * Leerer Zeitraum (`!fromIso || !toIso`) → EMPTY. DB-Fehler → EMPTY. Wenn der
 * Zeitraum gar keine Reservationen enthält → EMPTY (Daten fehlen ≠ 0).
 */
/** Einzelreservation für den Cockpit-Drilldown (Liste hinter der Kennzahl). */
export interface ReservationDrilldownRow {
  reservationDate: string;
  reservationTime: string | null;
  partySize: number;
  /** Anzeigename: Vorname/Nachname bzw. Firma. */
  name: string;
  status: string;
  area: string | null;
}

/**
 * Drilldown: die GEZÄHLTEN Reservationen eines Zeitraums (dieselbe Zählregel
 * wie die Kennzahlen; `groupsOnly` = nur Gruppen >= Schwelle). Wirft bei
 * DB-Fehler; leerer Zeitraum → [].
 */
export async function fetchReservationDrilldown(
  tenantId: TenantId,
  fromIso: string | null,
  toIso: string | null,
  settings: ReservationCountingSettings,
  groupsOnly: boolean,
): Promise<ReservationDrilldownRow[]> {
  if (!fromIso || !toIso || fromIso > toIso) return [];
  const all: ReservationDrilldownRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = (supabase as any)
      .from('reservation_records')
      .select('reservation_date, reservation_time, party_size, first_name, last_name, company, status, status_normalized, area, room')
      .eq('restaurant_id', tenantId)
      .gte('reservation_date', fromIso)
      .lte('reservation_date', toIso)
      .order('reservation_date', { ascending: true })
      .order('reservation_time', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (groupsOnly) q = q.gte('party_size', settings.groupThreshold);
    const { data, error } = await q;
    if (error) throw new Error(`Reservationen konnten nicht geladen werden: ${error.message ?? error}`);
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of batch) {
      const status = (r.status_normalized ?? 'unknown') as ReservationStatusNormalized;
      if (!statusCounts(status, settings)) continue;
      const first = (r.first_name as string | null) ?? '';
      const last = (r.last_name as string | null) ?? '';
      const company = (r.company as string | null) ?? '';
      const name = [first, last].filter(Boolean).join(' ') || company || '—';
      all.push({
        reservationDate: String(r.reservation_date),
        reservationTime: (r.reservation_time as string | null) ?? null,
        partySize: typeof r.party_size === 'number' ? r.party_size : 0,
        name,
        status: (r.status as string | null) || status,
        area: (r.area as string | null) ?? (r.room as string | null) ?? null,
      });
    }
    if (batch.length < PAGE) break;
  }
  return all;
}

export async function loadReservationMetrics(
  tenantId: TenantId,
  fromIso: string | null,
  toIso: string | null,
  settings: ReservationCountingSettings,
): Promise<ReservationMetrics> {
  if (!fromIso || !toIso || fromIso > toIso) return { ...EMPTY };
  const rows = await fetchRows(tenantId, fromIso, toIso);
  if (rows === null) return { ...EMPTY };
  // Keine Reservationen im Zeitraum → «—» (nie still 0).
  return aggregateReservationMetrics(rows, settings, rows.length > 0);
}
