/**
 * Reservationen-Import — Selbstkontrolle je Monat
 * ================================================
 * Zwei Bausteine für den dublettensicheren Reservations-Import:
 *
 *  1) `monatsAggregateAusDatei` (rein): aggregiert die geparsten Zeilen der
 *     Datei je Monat nach der ZENTRALEN Zählregel (reservation-cockpit-settings)
 *     — Reservierte Gäste = Σ Personen der gezählten Status; Gruppen ab N Pax =
 *     Anzahl + Σ Personen. Wird in der Vorschau angezeigt (Kontrolle VOR Import).
 *
 *  2) `selfCheckNachImport`: prüft NACH dem Speichern, ob die Res.Nr. der Datei
 *     in der DB exakt die Datei-Werte tragen (gleiche Aggregation über die
 *     DB-Zeilen der Datei-Res.Nr.), und lädt zusätzlich die GEMERGTEN
 *     Monats-Totale (Datei + Bestand) via loadReservationMetrics — das sind die
 *     Kontrollzahlen, die auch Monatsreport/Cockpit zeigen.
 *
 * Regeln: mandantengetrennt (restaurant_id), leer statt 0 (Monate ohne
 * gezählte Reservationen erscheinen mit «—»), KEINE parallele Zählregel —
 * ausschliesslich statusCounts + groupThreshold aus den zentralen Settings.
 */

import { supabase } from '@/integrations/supabase/client';
import type { TenantId } from '@/contexts/TenantContext';
import type { ParsedReservation, ReservationStatusNormalized } from '@/lib/reservation-import-parser';
import { statusCounts, type ReservationCountingSettings } from '@/lib/reservation-cockpit-settings';
import { loadReservationMetrics, type ReservationMetrics } from '@/lib/reservation-cockpit-metrics';

/** Monats-Aggregat (aus Datei oder aus DB-Zeilen der Datei-Res.Nr.). */
export interface MonatsAggregat {
  /** 'yyyy-MM' */
  month: string;
  /** Σ Personen der gezählten Reservationen (null = keine gezählten). */
  reservedGuests: number | null;
  /** Anzahl gezählter Reservationen mit Personen >= Schwelle. */
  groupCount: number | null;
  /** Σ Personen dieser Gruppen. */
  groupPersons: number | null;
  /** Anzahl gezählter Reservationen (Diagnose). */
  countedReservations: number;
  /** Anzahl Zeilen des Monats insgesamt (inkl. nicht gezählter Status). */
  totalReservations: number;
}

/** Schlanke Zeile für die Aggregation (Datei- oder DB-Herkunft). */
interface AggRow {
  month: string | null;
  partySize: number | null;
  status: ReservationStatusNormalized;
}

function aggregate(rows: AggRow[], settings: ReservationCountingSettings): MonatsAggregat[] {
  const byMonth = new Map<string, MonatsAggregat>();
  for (const r of rows) {
    if (!r.month) continue; // Zeilen ohne Datum können keinem Monat zugeordnet werden
    let m = byMonth.get(r.month);
    if (!m) {
      m = {
        month: r.month, reservedGuests: null, groupCount: null,
        groupPersons: null, countedReservations: 0, totalReservations: 0,
      };
      byMonth.set(r.month, m);
    }
    m.totalReservations++;
    if (!statusCounts(r.status, settings)) continue;
    const pax = typeof r.partySize === 'number' && Number.isFinite(r.partySize) ? r.partySize : 0;
    m.countedReservations++;
    m.reservedGuests = (m.reservedGuests ?? 0) + pax;
    if (pax >= settings.groupThreshold) {
      m.groupCount = (m.groupCount ?? 0) + 1;
      m.groupPersons = (m.groupPersons ?? 0) + pax;
    } else {
      // Gruppen bleiben null, solange KEINE Gruppe existiert, aber der Monat
      // gezählte Reservationen hat → dann explizit 0 (Monat hat Datenbasis).
      m.groupCount = m.groupCount ?? 0;
      m.groupPersons = m.groupPersons ?? 0;
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Monats-Aggregate aus den GEPARSTEN Datei-Zeilen (rein, testbar).
 * Dedupliziert je Res.Nr. (letzte Zeile gewinnt — gleiches Verhalten wie der
 * Import-Upsert, der Doppel-Res.Nr. innerhalb der CSV zusammenführt).
 */
export function monatsAggregateAusDatei(
  reservations: ParsedReservation[],
  settings: ReservationCountingSettings,
): MonatsAggregat[] {
  const byId = new Map<string, ParsedReservation>();
  for (const r of reservations) byId.set(r.externalReservationId, r);
  const rows: AggRow[] = [...byId.values()].map(r => ({
    month: r.reservationDate ? r.reservationDate.slice(0, 7) : null,
    partySize: r.partySize,
    status: r.statusNormalized,
  }));
  return aggregate(rows, settings);
}

/** Ergebnis der Selbstkontrolle eines Monats. */
export interface MonatsKontrolle {
  month: string;
  /** Soll gemäss Datei. */
  file: MonatsAggregat;
  /** Ist in der DB — NUR die Res.Nr. der Datei (muss der Datei entsprechen). */
  dbFile: MonatsAggregat | null;
  /** Gemergtes Monats-Total (Datei + Bestand) — die Kontrollzahl des Cockpits. */
  merged: ReservationMetrics;
  /** true = Datei-Werte exakt in der DB angekommen. */
  ok: boolean;
}

export interface SelfCheckResult {
  rows: MonatsKontrolle[];
  allOk: boolean;
  /** Fehlermeldung, falls die DB-Prüfung selbst scheiterte (Netz etc.). */
  error: string | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sameAgg(a: MonatsAggregat, b: MonatsAggregat | null): boolean {
  if (!b) return false;
  return a.reservedGuests === b.reservedGuests
    && a.groupCount === b.groupCount
    && a.groupPersons === b.groupPersons
    && a.countedReservations === b.countedReservations;
}

/** DB-Zeile je Res.Nr. für den exakten Abgleich. */
export interface DbResRow {
  extId: string;
  month: string | null;
  partySize: number | null;
  status: ReservationStatusNormalized;
}

/**
 * Exakter Abgleich je Res.Nr. (rein, testbar): jede Datei-Res.Nr. muss in der
 * DB mit GLEICHEM Monat, GLEICHER Personenzahl und GLEICHEM Status stehen.
 * Rückgabe: Menge der Monate mit Abweichung (Aggregat-Ausgleich zweier Fehler
 * im selben Monat kann so nicht mehr «OK» vortäuschen).
 */
export function abweichendeMonate(
  fileRows: ParsedReservation[],
  dbRows: DbResRow[],
): Set<string> {
  const fileById = new Map<string, ParsedReservation>();
  for (const r of fileRows) fileById.set(r.externalReservationId, r); // letzte gewinnt (wie Import)
  const dbById = new Map<string, DbResRow>();
  for (const r of dbRows) dbById.set(r.extId, r);
  const bad = new Set<string>();
  for (const [id, f] of fileById) {
    const fMonth = f.reservationDate ? f.reservationDate.slice(0, 7) : null;
    if (!fMonth) continue; // ohne Datum keinem Monat zuordenbar (bereits in Vorschau ausgewiesen)
    const d = dbById.get(id);
    const fPax = typeof f.partySize === 'number' && Number.isFinite(f.partySize) ? f.partySize : null;
    if (!d || d.month !== fMonth || d.partySize !== fPax || d.status !== f.statusNormalized) {
      bad.add(fMonth);
      if (d?.month && d.month !== fMonth) bad.add(d.month);
    }
  }
  return bad;
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

/**
 * Selbstkontrolle NACH dem Import: liest die Res.Nr. der Datei aus der DB
 * (mandantengetrennt), aggregiert sie mit derselben Zählregel und vergleicht
 * je Monat gegen die Datei. Zusätzlich das gemergte Monats-Total.
 */
export async function selfCheckNachImport(
  tenantId: TenantId,
  reservations: ParsedReservation[],
  settings: ReservationCountingSettings,
): Promise<SelfCheckResult> {
  const fileMonths = monatsAggregateAusDatei(reservations, settings);
  const extIds = [...new Set(reservations.map(r => r.externalReservationId))];
  try {
    const dbRows: DbResRow[] = [];
    for (const part of chunk(extIds, 200)) {
      const { data, error } = await (supabase as any)
        .from('reservation_records')
        .select('external_reservation_id, party_size, status_normalized, reservation_date')
        .eq('restaurant_id', tenantId)
        .in('external_reservation_id', part);
      if (error) throw new Error(String(error.message ?? error));
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        dbRows.push({
          extId: String(r.external_reservation_id ?? ''),
          month: typeof r.reservation_date === 'string' ? r.reservation_date.slice(0, 7) : null,
          partySize: typeof r.party_size === 'number' ? r.party_size : null,
          status: ((r.status_normalized as string | null) ?? 'unknown') as ReservationStatusNormalized,
        });
      }
    }
    // Exakter Res.Nr.-Abgleich (Feldebene) — Aggregat-Ausgleich kann nicht täuschen.
    const badMonths = abweichendeMonate(reservations, dbRows);
    const dbAgg = new Map(aggregate(
      dbRows.map(r => ({ month: r.month, partySize: r.partySize, status: r.status })),
      settings,
    ).map(m => [m.month, m]));
    const rows: MonatsKontrolle[] = [];
    for (const f of fileMonths) {
      const merged = await loadReservationMetrics(
        tenantId, `${f.month}-01`, lastDayOfMonth(f.month), settings,
      );
      const dbFile = dbAgg.get(f.month) ?? null;
      rows.push({
        month: f.month, file: f, dbFile, merged,
        ok: sameAgg(f, dbFile) && !badMonths.has(f.month),
      });
    }
    return { rows, allOk: rows.every(r => r.ok), error: null };
  } catch (e) {
    return {
      rows: fileMonths.map(f => ({
        month: f.month, file: f, dbFile: null,
        merged: { reservedGuests: null, largeGroupCount: null, largeGroupPersons: null },
        ok: false,
      })),
      allOk: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
