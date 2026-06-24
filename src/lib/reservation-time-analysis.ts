/**
 * Reservationen — „Beste Reservationszeiten" (reine Auswertung, ohne DB/DOM)
 * =========================================================================
 * Gruppiert Reservationen nach exakter Startzeit ("HH:mm") und berechnet je
 * Zeitfenster Anzahl, Personen sowie den Anteil an allen berücksichtigten
 * Reservationen/Personen.  Bewusst rein (nur `import type`), damit ohne
 * Datenbank testbar.
 *
 * „Beste Reservationszeiten" zählt nur REALISIERTE Nachfrage: Stornos und
 * No-Shows werden ausgeschlossen (siehe `MEANINGFUL_TIME_STATUSES`).  Das weicht
 * bewusst von `computeReservationStats.topTimes` ab (dort werden alle Status
 * gezählt) — daher eine eigene Funktion, statt die bestehende zu verändern.
 *
 * Mandantentrennung: Diese Schicht arbeitet auf bereits mandantengefilterten
 * Zeilen (Filter passiert im DB-Layer via `restaurant_id`).  Hier findet keine
 * Mandantenlogik statt; die Funktionen sind grenzentreu rein.
 */

import type { ReservationStatusNormalized } from './reservation-import-parser';

/**
 * Status, die als „echte"/realisierte Reservation in die Zeitenauswertung
 * eingehen.  Ausgeschlossen werden `cancelled` und `noshow` (kein Gast am Platz).
 * `unknown` wird bewusst eingeschlossen, da die Status-Erkennung nicht perfekt
 * ist und solche Zeilen sonst stillschweigend verschwänden.
 */
export const MEANINGFUL_TIME_STATUSES: readonly ReservationStatusNormalized[] = [
  'completed', 'confirmed', 'pending', 'unknown',
];

/** Status, die NICHT in die Zeitenauswertung eingehen. */
export const EXCLUDED_TIME_STATUSES: readonly ReservationStatusNormalized[] = [
  'cancelled', 'noshow',
];

/** Zählt dieser Status als realisierte Reservation für die Zeitenauswertung? */
export function isMeaningfulTimeStatus(status: ReservationStatusNormalized): boolean {
  return status !== 'cancelled' && status !== 'noshow';
}

/** Schlanke Eingabezeile — kompatibel zu `ReservationStatsInput`/DB-Zeilen. */
export interface TimeAnalysisInput {
  reservationTime: string | null;   // "HH:mm"
  partySize: number | null;
  statusNormalized: ReservationStatusNormalized;
}

/** Ein Zeitfenster der Auswertung. */
export interface TimeSlotStat {
  time: string;          // "HH:mm"
  count: number;         // Anzahl Reservationen
  persons: number;       // Summe Gruppengrössen
  shareCount: number;    // Anteil an allen berücksichtigten Reservationen (0..1)
  sharePersons: number;  // Anteil an allen berücksichtigten Personen (0..1)
}

/** Ergebnis der Zeitenauswertung. */
export interface ReservationTimeAnalysis {
  /** Alle Zeitfenster, standardmässig nach Anzahl absteigend sortiert. */
  slots: TimeSlotStat[];
  /** Summe berücksichtigter Reservationen (mit Uhrzeit, ohne Storno/No-Show). */
  totalReservations: number;
  /** Summe berücksichtigter Personen. */
  totalPersons: number;
  /** Berücksichtigte Reservationen OHNE erkannte Uhrzeit (nicht in `slots`). */
  ignoredNoTime: number;
  /** Wegen Status (Storno/No-Show) ausgeschlossene Reservationen. */
  excludedByStatus: number;
}

export type TimeSortKey = 'count' | 'persons';

/**
 * Sortiert eine Kopie der Zeitfenster nach Anzahl oder Personen (absteigend,
 * Gleichstand: Uhrzeit aufsteigend).  Mutiert die Eingabe nicht.
 */
export function sortTimeSlots(slots: TimeSlotStat[], by: TimeSortKey): TimeSlotStat[] {
  return [...slots].sort((a, b) => {
    const primary = by === 'persons' ? b.persons - a.persons : b.count - a.count;
    return primary || a.time.localeCompare(b.time);
  });
}

/** Erste `limit` Einträge (limit ≤ 0 → alle).  Mutiert die Eingabe nicht. */
export function topTimeSlots(slots: TimeSlotStat[], limit: number): TimeSlotStat[] {
  return limit > 0 ? slots.slice(0, limit) : [...slots];
}

/**
 * Gruppiert Reservationen nach exakter Startzeit.  Storno/No-Show und Zeilen
 * ohne Uhrzeit fliessen NICHT in die Zeitfenster ein; die Anteile beziehen sich
 * auf die Summe der berücksichtigten (zeitbehafteten) Reservationen/Personen,
 * sodass sie sich zu ~100 % addieren.
 */
export function analyzeReservationTimes(rows: TimeAnalysisInput[]): ReservationTimeAnalysis {
  const map = new Map<string, { count: number; persons: number }>();
  let totalReservations = 0;
  let totalPersons = 0;
  let ignoredNoTime = 0;
  let excludedByStatus = 0;

  for (const r of rows) {
    if (!isMeaningfulTimeStatus(r.statusNormalized)) { excludedByStatus++; continue; }
    if (!r.reservationTime) { ignoredNoTime++; continue; }
    const persons = r.partySize ?? 0;
    const v = map.get(r.reservationTime) ?? { count: 0, persons: 0 };
    v.count++;
    v.persons += persons;
    map.set(r.reservationTime, v);
    totalReservations++;
    totalPersons += persons;
  }

  const slots: TimeSlotStat[] = [...map.entries()].map(([time, v]) => ({
    time,
    count: v.count,
    persons: v.persons,
    shareCount: totalReservations > 0 ? v.count / totalReservations : 0,
    sharePersons: totalPersons > 0 ? v.persons / totalPersons : 0,
  }));
  slots.sort((a, b) => b.count - a.count || a.time.localeCompare(b.time));

  return { slots, totalReservations, totalPersons, ignoredNoTime, excludedByStatus };
}
