/**
 * Foratable Report — reine Auswertungslogik (ohne DB/DOM)
 * =======================================================
 * Berechnet aus bereits importierten Reservationen denselben Kennzahlensatz
 * wie die CSV-Vorschau im Reservationen-Import.  Die eigentliche Statistik
 * stammt aus `computeReservationStats` (siehe reservation-import-parser.ts) —
 * hier wird nur zusätzlich Neu-/Wiederkehr-Gast bestimmt und der Zeitraum
 * aufbereitet.  Bewusst rein, damit ohne Datenbank testbar.
 */

import {
  startOfMonth, endOfMonth, startOfYear, endOfYear,
  subMonths, subYears, format as fmtDate,
} from 'date-fns';
import { computeReservationStats } from './reservation-import-parser';
import type { ReservationStatsInput, ReservationPreviewStats } from './reservation-import-parser';
import { analyzeReservationTimes } from './reservation-time-analysis';
import type { ReservationTimeAnalysis } from './reservation-time-analysis';

export interface ReportRange {
  from: string;   // yyyy-MM-dd (inklusive)
  to: string;     // yyyy-MM-dd (inklusive)
}

export interface ForatableReport {
  range: ReportRange;
  stats: ReservationPreviewStats;
  /** „Beste Reservationszeiten" — nach Startzeit, ohne Storno/No-Show. */
  timeAnalysis: ReservationTimeAnalysis;
  /** Gäste mit Reservation im Zeitraum, die VORHER noch keine hatten. */
  newGuests: number;
  /** Gäste mit Reservation im Zeitraum, die schon vorher welche hatten. */
  returningGuests: number;
}

/**
 * Teilt die im Zeitraum vorkommenden Gäste (distinct guestKeys) anhand der
 * Menge bereits zuvor bekannter Gäste in neu/wiederkehrend.  Gleiche Semantik
 * wie der Import: „wiederkehrend“ = vorher schon gesehen.
 */
export function splitNewReturningGuests(
  distinctGuestKeys: string[],
  priorGuestKeys: Set<string>,
): { newGuests: number; returningGuests: number } {
  let newGuests = 0;
  let returningGuests = 0;
  for (const key of distinctGuestKeys) {
    if (priorGuestKeys.has(key)) returningGuests++;
    else newGuests++;
  }
  return { newGuests, returningGuests };
}

/**
 * Baut den vollständigen Report aus den Zeilen des Zeitraums und der Menge der
 * vorher bekannten Gäste.  `rows` und `priorGuestKeys` nutzen dieselbe
 * Gast-Identität (guest_id).
 */
export function buildForatableReport(
  rows: ReservationStatsInput[],
  priorGuestKeys: Set<string>,
  range: ReportRange,
): ForatableReport {
  const stats = computeReservationStats(rows);
  const timeAnalysis = analyzeReservationTimes(rows);
  const { newGuests, returningGuests } = splitNewReturningGuests(stats.distinctGuestKeys, priorGuestKeys);
  return { range, stats, timeAnalysis, newGuests, returningGuests };
}

export type QuickRangeKind = 'current-month' | 'last-month' | 'current-year' | 'last-year';

const isoDay = (d: Date): string => fmtDate(d, 'yyyy-MM-dd');

/** Schnellauswahl-Zeiträume (alle inklusive Endtag). */
export function quickRange(kind: QuickRangeKind, today: Date = new Date()): ReportRange {
  switch (kind) {
    case 'current-month':
      return { from: isoDay(startOfMonth(today)), to: isoDay(endOfMonth(today)) };
    case 'last-month': {
      const m = subMonths(today, 1);
      return { from: isoDay(startOfMonth(m)), to: isoDay(endOfMonth(m)) };
    }
    case 'current-year':
      return { from: isoDay(startOfYear(today)), to: isoDay(endOfYear(today)) };
    case 'last-year': {
      const y = subYears(today, 1);
      return { from: isoDay(startOfYear(y)), to: isoDay(endOfYear(y)) };
    }
  }
}
