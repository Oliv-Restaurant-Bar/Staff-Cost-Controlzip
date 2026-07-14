/**
 * Reservationen — Auswertungs-Helper (rein, ohne DB)
 * ===================================================
 * Vorbereitete Helfer für spätere Gäste- und Verhaltensanalysen.  Alle
 * Funktionen arbeiten auf einer schlanken Zeilenform (`ReservationAnalyticsRow`),
 * sodass sie sowohl mit frisch geparsten Reservationen als auch mit DB-Zeilen
 * funktionieren und ohne Datenbank testbar sind.
 */

import type { ReservationStatusNormalized } from './reservation-import-parser';

export interface ReservationAnalyticsRow {
  reservationDate: string | null;    // "yyyy-MM-dd"
  reservationTime: string | null;    // "HH:mm"
  partySize: number | null;
  statusNormalized: ReservationStatusNormalized;
  reservedAt: string | null;         // ISO
  /** Stabile Gast-Identität (matchKey oder guest_id). */
  guestKey: string | null;
}

const COUNTS_AS_CANCELLED: ReservationStatusNormalized[] = ['cancelled'];

export interface DayCount { date: string; count: number; }
export interface DayPersons { date: string; persons: number; }
export interface TimeCount { time: string; count: number; persons: number; }

/** Reservationen pro Tag (chronologisch). Storno standardmässig eingeschlossen. */
export function reservationsPerDay(
  rows: ReservationAnalyticsRow[],
  opts: { excludeCancelled?: boolean } = {},
): DayCount[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.reservationDate) continue;
    if (opts.excludeCancelled && COUNTS_AS_CANCELLED.includes(r.statusNormalized)) continue;
    map.set(r.reservationDate, (map.get(r.reservationDate) ?? 0) + 1);
  }
  return [...map.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
}

/** Personen pro Tag (Summe Gruppengrössen). */
export function personsPerDay(
  rows: ReservationAnalyticsRow[],
  opts: { excludeCancelled?: boolean } = {},
): DayPersons[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.reservationDate) continue;
    if (opts.excludeCancelled && COUNTS_AS_CANCELLED.includes(r.statusNormalized)) continue;
    map.set(r.reservationDate, (map.get(r.reservationDate) ?? 0) + (r.partySize ?? 0));
  }
  return [...map.entries()].map(([date, persons]) => ({ date, persons })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Reservationen nach Uhrzeit.
 * mode='exact' → pro "HH:mm"; mode='hour' → pro Stunde "HH:00".
 */
export function reservationsByTime(
  rows: ReservationAnalyticsRow[],
  mode: 'exact' | 'hour' = 'hour',
): TimeCount[] {
  const map = new Map<string, { count: number; persons: number }>();
  for (const r of rows) {
    if (!r.reservationTime) continue;
    const key = mode === 'hour' ? `${r.reservationTime.slice(0, 2)}:00` : r.reservationTime;
    const v = map.get(key) ?? { count: 0, persons: 0 };
    v.count++;
    v.persons += r.partySize ?? 0;
    map.set(key, v);
  }
  return [...map.entries()]
    .map(([time, v]) => ({ time, count: v.count, persons: v.persons }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** Stornoquote (0..1). Nenner = alle Reservationen mit Status. */
export function cancellationRate(rows: ReservationAnalyticsRow[]): number {
  if (rows.length === 0) return 0;
  const cancelled = rows.filter(r => r.statusNormalized === 'cancelled').length;
  return cancelled / rows.length;
}

/** No-Show-Quote (0..1). */
export function noShowRate(rows: ReservationAnalyticsRow[]): number {
  if (rows.length === 0) return 0;
  const noshow = rows.filter(r => r.statusNormalized === 'noshow').length;
  return noshow / rows.length;
}

/** Durchschnittliche Gruppengrösse. Storno standardmässig ausgeschlossen. */
export function avgGroupSize(
  rows: ReservationAnalyticsRow[],
  opts: { excludeCancelled?: boolean } = { excludeCancelled: true },
): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (opts.excludeCancelled && r.statusNormalized === 'cancelled') continue;
    if (r.partySize === null) continue;
    sum += r.partySize;
    n++;
  }
  return n > 0 ? sum / n : null;
}

export interface ReturnRateResult {
  totalGuests: number;
  returningGuests: number;   // Gäste mit > 1 Reservation
  oneTimeGuests: number;
  returnRate: number;        // returningGuests / totalGuests (0..1)
}

/** Gäste-Wiederkehrrate: Anteil der Gäste mit mehr als einer Reservation. */
export function guestReturnRate(rows: ReservationAnalyticsRow[]): ReturnRateResult {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.guestKey) continue;
    counts.set(r.guestKey, (counts.get(r.guestKey) ?? 0) + 1);
  }
  const totalGuests = counts.size;
  let returningGuests = 0;
  for (const c of counts.values()) if (c > 1) returningGuests++;
  return {
    totalGuests,
    returningGuests,
    oneTimeGuests: totalGuests - returningGuests,
    returnRate: totalGuests > 0 ? returningGuests / totalGuests : 0,
  };
}

/** Vorlaufzeit in Tagen zwischen "reserviert am" und Besuchsdatum. */
export function leadTimeDays(row: ReservationAnalyticsRow): number | null {
  if (!row.reservedAt || !row.reservationDate) return null;
  const reservedMs = Date.parse(row.reservedAt);
  const visitMs = Date.parse(`${row.reservationDate}T00:00:00`);
  if (Number.isNaN(reservedMs) || Number.isNaN(visitMs)) return null;
  const reservedDay = Math.floor(reservedMs / 86400000);
  const visitDay = Math.floor(visitMs / 86400000);
  return visitDay - reservedDay;
}

export interface LeadTimeStats {
  count: number;
  avgDays: number | null;
  medianDays: number | null;
  minDays: number | null;
  maxDays: number | null;
}

export function leadTimeStats(rows: ReservationAnalyticsRow[]): LeadTimeStats {
  const days = rows.map(leadTimeDays).filter((d): d is number => d !== null);
  if (days.length === 0) return { count: 0, avgDays: null, medianDays: null, minDays: null, maxDays: null };
  const sorted = [...days].sort((a, b) => a - b);
  const sum = sorted.reduce((s, d) => s + d, 0);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count: sorted.length,
    avgDays: sum / sorted.length,
    medianDays: median,
    minDays: sorted[0],
    maxDays: sorted[sorted.length - 1],
  };
}

export interface RevenueComparisonRow {
  date: string;
  reservations: number;
  persons: number;
  revenue: number | null;
  revenuePerReservation: number | null;
  revenuePerPerson: number | null;
}

/**
 * Vergleich Reservationen vs. Tagesumsatz (z. B. aus Z-Bericht).
 * `revenueByDate` mappt "yyyy-MM-dd" → Bruttoumsatz.  Storno wird für die
 * Reservations-/Personenzählung ausgeschlossen (realisierte Gäste).
 */
export function compareWithRevenue(
  rows: ReservationAnalyticsRow[],
  revenueByDate: Record<string, number>,
): RevenueComparisonRow[] {
  const resByDay = new Map<string, { reservations: number; persons: number }>();
  for (const r of rows) {
    if (!r.reservationDate) continue;
    if (r.statusNormalized === 'cancelled') continue;
    const v = resByDay.get(r.reservationDate) ?? { reservations: 0, persons: 0 };
    v.reservations++;
    v.persons += r.partySize ?? 0;
    resByDay.set(r.reservationDate, v);
  }
  const dates = new Set<string>([...resByDay.keys(), ...Object.keys(revenueByDate)]);
  return [...dates].sort().map(date => {
    const v = resByDay.get(date) ?? { reservations: 0, persons: 0 };
    const revenue = revenueByDate[date] ?? null;
    return {
      date,
      reservations: v.reservations,
      persons: v.persons,
      revenue,
      revenuePerReservation: revenue !== null && v.reservations > 0 ? revenue / v.reservations : null,
      revenuePerPerson: revenue !== null && v.persons > 0 ? revenue / v.persons : null,
    };
  });
}
