/**
 * reservation-analyse-utils — Zentrale „Reservations Analyse"-Seite
 * ==================================================================
 * Reine, testbare Logik (KEIN supabase/DOM) für die konsolidierte Analyse-Seite
 * `/gaeste/analyse`, die „Monat Ist vs. Vorjahr" und „Reservationen nach
 * Wochentag" in einer Ansicht zusammenführt.
 *
 * Wichtige Entscheidungen:
 *  - Globale Kennzahl: `AnalyseMetric` ('persons' | 'reservations'),
 *    DEFAULT = 'persons' (Personen). `pickMetric` wählt aus jeder Zeile mit
 *    beiden Kennzahlen (YoyMonthRow/YoyWeekdayRow/Totals) die aktive aus —
 *    EIN Umschalter steuert damit alle Auswertungen der Seite.
 *  - Zeitraum-Presets (`presetMonthRange`) sind rein arithmetisch aus einem
 *    übergebenen `today`-Datum abgeleitet (deterministisch testbar):
 *    Aktueller/letzter Monat (Jahreswechsel-fest), aktuelles/letztes Jahr,
 *    Wintersaison Okt–Dez (des aktuellen Jahres — Jahr danach frei wählbar).
 *  - `buildWeekdayMonthBreakdown` (Popup „Zusammensetzung" eines Wochentags):
 *    je Ist-Monat die Werte NUR dieses Wochentags vs. denselben Vorjahres-
 *    Monat. `hasPriorData` gilt auf MONATS-Ebene (alle Wochentage, vor dem
 *    Status-Filter) — konsistent mit `buildYoyComparison`: hat der Vorjahres-
 *    monat Daten, aber keine an diesem Wochentag, ist das ein echtes Vorjahr 0
 *    (kein „kein Vorjahr").
 *
 * Wiederverwendet die reinen Helfer aus `reservation-weekday-analytics` und
 * `reservation-yoy-utils` — KEINE neue Migration, KEINE Schreibzugriffe,
 * Mandanten-Filter passiert im DB-Layer der Seite.
 */

import type { ReservationAggRow } from './reservation-dashboard';
import {
  isoWeekdayOf,
  monthKeyOf,
  statusPredicate,
  type IsoWeekday,
  type StatusScope,
} from './reservation-weekday-analytics';
import {
  makeYoyMetric,
  priorYearMonthKey,
  type YoyMetric,
} from './reservation-yoy-utils';

// ── Globale Kennzahl (Umschalter) ────────────────────────────────────────────

export type AnalyseMetric = 'persons' | 'reservations';

/** Standard-Auswertung der Analyse-Seite: Personen. */
export const DEFAULT_ANALYSE_METRIC: AnalyseMetric = 'persons';

export const ANALYSE_METRICS: AnalyseMetric[] = ['persons', 'reservations'];

export const ANALYSE_METRIC_LABEL: Record<AnalyseMetric, string> = {
  persons: 'Personen',
  reservations: 'Reservationen',
};

/** Eine Zeile mit beiden Kennzahlen (YoyMonthRow, YoyWeekdayRow, YoyTotals …). */
export interface MetricPair {
  reservations: YoyMetric;
  persons: YoyMetric;
}

/** Wählt aus einer Zeile die aktive Kennzahl — steuert ALLE Auswertungen. */
export function pickMetric(pair: MetricPair, metric: AnalyseMetric): YoyMetric {
  return metric === 'persons' ? pair.persons : pair.reservations;
}

/** Ø Personen pro Reservation; null wenn keine Reservationen (kein Div/0). */
export function avgPersonsPerReservation(
  persons: number,
  reservations: number,
): number | null {
  if (!Number.isFinite(persons) || !Number.isFinite(reservations)) return null;
  if (reservations <= 0) return null;
  return persons / reservations;
}

// ── Zeitraum-Presets ─────────────────────────────────────────────────────────

export type AnalysePreset =
  | 'currentMonth'
  | 'lastMonth'
  | 'currentYear'
  | 'lastYear'
  | 'winter';

/** Monatsbasierter Zeitraum innerhalb EINES Jahres (wie die Seiten-Selects). */
export interface AnalyseMonthRange {
  year: number;
  /** 1..12 */
  fromMonth: number;
  /** 1..12 */
  toMonth: number;
}

export const ANALYSE_PRESETS: { key: AnalysePreset; label: string }[] = [
  { key: 'currentMonth', label: 'Aktueller Monat' },
  { key: 'lastMonth', label: 'Letzter Monat' },
  { key: 'currentYear', label: 'Aktuelles Jahr' },
  { key: 'lastYear', label: 'Letztes Jahr' },
  { key: 'winter', label: 'Wintersaison Okt–Dez' },
];

/**
 * Zeitraum eines Presets, rein aus `today` abgeleitet.
 * „Letzter Monat" rollt über den Jahreswechsel (Januar → Dezember Vorjahr).
 */
export function presetMonthRange(preset: AnalysePreset, today: Date): AnalyseMonthRange {
  const year = today.getFullYear();
  const month = today.getMonth() + 1; // 1..12
  switch (preset) {
    case 'currentMonth':
      return { year, fromMonth: month, toMonth: month };
    case 'lastMonth':
      return month === 1
        ? { year: year - 1, fromMonth: 12, toMonth: 12 }
        : { year, fromMonth: month - 1, toMonth: month - 1 };
    case 'currentYear':
      return { year, fromMonth: 1, toMonth: 12 };
    case 'lastYear':
      return { year: year - 1, fromMonth: 1, toMonth: 12 };
    case 'winter':
      return { year, fromMonth: 10, toMonth: 12 };
  }
}

/** Entspricht der Zeitraum exakt einem Preset? (für aktive Button-Optik) */
export function matchesPreset(
  range: AnalyseMonthRange,
  preset: AnalysePreset,
  today: Date,
): boolean {
  const p = presetMonthRange(preset, today);
  return p.year === range.year
    && p.fromMonth === range.fromMonth
    && p.toMonth === range.toMonth;
}

// ── Wochentag-Zusammensetzung (Popup) ────────────────────────────────────────

export interface WeekdayMonthBreakdownRow {
  /** Ist-Monat „yyyy-MM". */
  monthKey: string;
  /** Gleicher Monat im Vorjahr. */
  priorMonthKey: string;
  /** Hat der Vorjahresmonat ÜBERHAUPT Zeilen (alle Wochentage, vor Filter)? */
  hasPriorData: boolean;
  reservations: YoyMetric;
  persons: YoyMetric;
}

export interface BuildWeekdayMonthBreakdownArgs {
  currentRows: readonly ReservationAggRow[];
  priorRows: readonly ReservationAggRow[];
  /** Ist-Monate („yyyy-MM", aufsteigend) — gleiche Basis wie der Zeitraum. */
  monthKeys: readonly string[];
  weekday: IsoWeekday;
  scope: StatusScope;
}

interface Bucket {
  reservations: number;
  persons: number;
}

/**
 * Zusammensetzung EINES Wochentags über die Ist-Monate des Zeitraums:
 * je Monat die Summen NUR dieses Wochentags, verglichen mit demselben
 * Vorjahres-Monat. Immer eine Zeile pro Ist-Monat (leere Monate = 0).
 */
export function buildWeekdayMonthBreakdown(
  args: BuildWeekdayMonthBreakdownArgs,
): WeekdayMonthBreakdownRow[] {
  const pred = statusPredicate(args.scope);
  const priorKeyByCurrent = new Map(
    args.monthKeys.map((k) => [k, priorYearMonthKey(k)] as const),
  );
  const priorKeys = new Set(priorKeyByCurrent.values());
  const currentKeys = new Set(args.monthKeys);

  const curByMonth = new Map<string, Bucket>();
  const priorByMonth = new Map<string, Bucket>();
  /** Rohe Zeilen je VORJAHRES-Monat (alle Wochentage, vor Status-Filter). */
  const priorRawByMonth = new Map<string, number>();

  const addWeekdayRow = (
    map: Map<string, Bucket>,
    key: string,
    row: ReservationAggRow,
  ): void => {
    if (isoWeekdayOf(row.date) !== args.weekday) return;
    if (!pred(row.status)) return;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { reservations: 0, persons: 0 };
      map.set(key, bucket);
    }
    bucket.reservations += 1;
    bucket.persons += row.partySize ?? 0;
  };

  for (const row of args.currentRows) {
    const key = monthKeyOf(row.date);
    if (!key || !currentKeys.has(key)) continue;
    addWeekdayRow(curByMonth, key, row);
  }
  for (const row of args.priorRows) {
    const key = monthKeyOf(row.date);
    if (!key || !priorKeys.has(key)) continue;
    priorRawByMonth.set(key, (priorRawByMonth.get(key) ?? 0) + 1);
    addWeekdayRow(priorByMonth, key, row);
  }

  return args.monthKeys.map((monthKey) => {
    const priorKey = priorKeyByCurrent.get(monthKey)!;
    const cur = curByMonth.get(monthKey) ?? { reservations: 0, persons: 0 };
    const prior = priorByMonth.get(priorKey) ?? { reservations: 0, persons: 0 };
    const hasPriorData = (priorRawByMonth.get(priorKey) ?? 0) > 0;
    return {
      monthKey,
      priorMonthKey: priorKey,
      hasPriorData,
      reservations: makeYoyMetric(cur.reservations, prior.reservations, hasPriorData),
      persons: makeYoyMetric(cur.persons, prior.persons, hasPriorData),
    };
  });
}
