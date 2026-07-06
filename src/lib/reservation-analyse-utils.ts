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
  ISO_WEEKDAYS,
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

// ── Heatmap „Monat × Wochentag" ──────────────────────────────────────────────
//
// Matrix: Zeilen = Ist-Monate des Zeitraums, Spalten = ISO-Wochentage Mo..So.
// Je Zelle: Reservationen + Personen (Σ partySize) der Zeilen dieses Monats an
// diesem Wochentag (Status-gefiltert). KEIN Vorjahr — reine Ist-Betrachtung.
// Die Farbklassifizierung ist RELATIV zum aktuell gefilterten Zeitraum
// (`heatmapValueScale` über alle Zellen mit Wert > 0), nicht über alle Jahre.

/** Rohe, ungefilterte Zählungen einer Zelle/eines Monats/Zeitraums. */
export interface MetricCounts {
  reservations: number;
  persons: number;
}

/** Aktive Kennzahl aus rohen Zählungen (Personen ODER Reservationen). */
export function cellMetricValue(counts: MetricCounts, metric: AnalyseMetric): number {
  return metric === 'persons' ? counts.persons : counts.reservations;
}

/** Eine Zelle der Heatmap (ein Wochentag innerhalb eines Monats). */
export interface HeatmapCell extends MetricCounts {
  weekday: IsoWeekday;
}

/** Eine Zeile der Heatmap (ein Monat mit 7 Wochentag-Zellen + Monatssumme). */
export interface HeatmapMonthRow {
  monthKey: string;
  /** Immer 7 Zellen, Montag (1) bis Sonntag (7). */
  cells: HeatmapCell[];
  total: MetricCounts;
}

export interface MonthWeekdayHeatmap {
  months: HeatmapMonthRow[];
  /** Summe über den gesamten (gefilterten) Zeitraum. */
  grandTotal: MetricCounts;
}

export interface BuildMonthWeekdayHeatmapArgs {
  /** Ist-Zeilen (bereits mandantengefiltert geladen). */
  rows: readonly ReservationAggRow[];
  /** Ist-Monate („yyyy-MM", aufsteigend) — gleiche Basis wie der Zeitraum. */
  monthKeys: readonly string[];
  scope: StatusScope;
}

/**
 * Baut die Monat × Wochentag-Matrix. Immer eine Zeile pro Ist-Monat und je
 * Zeile 7 Wochentag-Zellen (leere Kombinationen = 0), damit die Darstellung
 * stabil ist.
 */
export function buildMonthWeekdayHeatmap(
  args: BuildMonthWeekdayHeatmapArgs,
): MonthWeekdayHeatmap {
  const pred = statusPredicate(args.scope);
  const currentKeys = new Set(args.monthKeys);
  const byMonth = new Map<string, Map<IsoWeekday, MetricCounts>>();

  for (const row of args.rows) {
    const key = monthKeyOf(row.date);
    if (!key || !currentKeys.has(key)) continue;
    const wd = isoWeekdayOf(row.date);
    if (wd === null) continue;
    if (!pred(row.status)) continue;
    let wmap = byMonth.get(key);
    if (!wmap) {
      wmap = new Map();
      byMonth.set(key, wmap);
    }
    let bucket = wmap.get(wd);
    if (!bucket) {
      bucket = { reservations: 0, persons: 0 };
      wmap.set(wd, bucket);
    }
    bucket.reservations += 1;
    bucket.persons += row.partySize ?? 0;
  }

  let grandRes = 0;
  let grandPers = 0;
  const months: HeatmapMonthRow[] = args.monthKeys.map((monthKey) => {
    const wmap = byMonth.get(monthKey);
    let totRes = 0;
    let totPers = 0;
    const cells: HeatmapCell[] = ISO_WEEKDAYS.map((weekday) => {
      const b = wmap?.get(weekday) ?? { reservations: 0, persons: 0 };
      totRes += b.reservations;
      totPers += b.persons;
      return { weekday, reservations: b.reservations, persons: b.persons };
    });
    grandRes += totRes;
    grandPers += totPers;
    return { monthKey, cells, total: { reservations: totRes, persons: totPers } };
  });

  return { months, grandTotal: { reservations: grandRes, persons: grandPers } };
}

// ── Farbklassifizierung (relativ zum gefilterten Zeitraum) ────────────────────

/**
 * 5-stufige Intensität (+ `empty` für Nullzellen):
 *  veryLow (sehr schwach) · low (schwach) · mid (durchschnitt) ·
 *  high (gut) · veryHigh (sehr gut).
 */
export type HeatmapLevel =
  | 'empty'
  | 'veryLow'
  | 'low'
  | 'mid'
  | 'high'
  | 'veryHigh';

export interface HeatmapScale {
  /** Kleinster Wert > 0 im Zeitraum. */
  min: number;
  /** Grösster Wert im Zeitraum. */
  max: number;
  /** Gibt es überhaupt eine Spanne (max > min)? */
  hasRange: boolean;
}

/**
 * Min/Max der aktiven Kennzahl über ALLE Zellen mit Wert > 0 des aktuell
 * gefilterten Zeitraums — Grundlage der relativen Farbskala.
 */
export function heatmapValueScale(
  heatmap: MonthWeekdayHeatmap,
  metric: AnalyseMetric,
): HeatmapScale {
  let min = Infinity;
  let max = -Infinity;
  for (const m of heatmap.months) {
    for (const c of m.cells) {
      const v = cellMetricValue(c, metric);
      if (v > 0) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  if (max < 0) return { min: 0, max: 0, hasRange: false };
  return { min, max, hasRange: max > min };
}

/**
 * Ordnet einen Wert relativ zur Skala in eine der 5 Stufen ein.
 * 0/negativ → `empty`; ohne Spanne (alle Werte gleich) → `mid`.
 * Die Spanne min..max wird in 5 gleich breite Bänder geteilt.
 */
export function classifyHeatmapLevel(value: number, scale: HeatmapScale): HeatmapLevel {
  if (value <= 0) return 'empty';
  if (!scale.hasRange) return 'mid';
  const step = (scale.max - scale.min) / 5;
  const t = value - scale.min;
  if (t < step) return 'veryLow';
  if (t < step * 2) return 'low';
  if (t < step * 3) return 'mid';
  if (t < step * 4) return 'high';
  return 'veryHigh';
}

// ── Abgeleitete Zell-Kennzahlen (Anteile, Monatsdurchschnitt) ─────────────────

/** Anteil der Zelle am Monatsvolumen (%) — null wenn Monat leer. */
export function cellShareOfMonth(
  cell: HeatmapCell,
  monthRow: HeatmapMonthRow,
  metric: AnalyseMetric,
): number | null {
  const total = cellMetricValue(monthRow.total, metric);
  if (total <= 0) return null;
  return (cellMetricValue(cell, metric) / total) * 100;
}

/** Anteil der Zelle am gesamten Zeitraum (%) — null wenn Zeitraum leer. */
export function cellShareOfRange(
  cell: HeatmapCell,
  grandTotal: MetricCounts,
  metric: AnalyseMetric,
): number | null {
  const total = cellMetricValue(grandTotal, metric);
  if (total <= 0) return null;
  return (cellMetricValue(cell, metric) / total) * 100;
}

/**
 * Durchschnittlicher Wochentag-Wert dieses Monats (über Wochentage mit Wert > 0)
 * — Basis für „Vergleich zum Durchschnitt dieses Monats". Null wenn leer.
 */
export function monthWeekdayAverage(
  monthRow: HeatmapMonthRow,
  metric: AnalyseMetric,
): number | null {
  const vals = monthRow.cells
    .map((c) => cellMetricValue(c, metric))
    .filter((v) => v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export interface CellVsMonthAverage {
  /** Ø Wochentag-Wert des Monats (null wenn leer). */
  avg: number | null;
  /** Zelle − Ø; null wenn Ø unbekannt. */
  diff: number | null;
  /** (Zelle − Ø) / Ø in %; null wenn Ø unbekannt/0. */
  pct: number | null;
}

/** Vergleich der Zelle mit dem Wochentag-Durchschnitt ihres Monats. */
export function cellVsMonthAverage(
  cell: HeatmapCell,
  monthRow: HeatmapMonthRow,
  metric: AnalyseMetric,
): CellVsMonthAverage {
  const avg = monthWeekdayAverage(monthRow, metric);
  if (avg === null) return { avg: null, diff: null, pct: null };
  const diff = cellMetricValue(cell, metric) - avg;
  const pct = avg > 0 ? (diff / avg) * 100 : null;
  return { avg, diff, pct };
}

// ── Tooltip-Inhalt (rein testbar) ────────────────────────────────────────────

export interface HeatmapCellTooltip {
  monthKey: string;
  weekday: IsoWeekday;
  reservations: number;
  persons: number;
  /** Anteil am Monat (%) der aktiven Kennzahl. */
  shareOfMonth: number | null;
  /** Ø Personen pro Reservation. */
  avgPersonsPerReservation: number | null;
  /** Vergleich mit dem Wochentag-Durchschnitt des Monats (aktive Kennzahl). */
  vsMonthAverage: CellVsMonthAverage;
}

/** Baut den vollständigen Tooltip-Datensatz einer Zelle (aktive Kennzahl). */
export function buildHeatmapCellTooltip(
  cell: HeatmapCell,
  monthRow: HeatmapMonthRow,
  metric: AnalyseMetric,
): HeatmapCellTooltip {
  return {
    monthKey: monthRow.monthKey,
    weekday: cell.weekday,
    reservations: cell.reservations,
    persons: cell.persons,
    shareOfMonth: cellShareOfMonth(cell, monthRow, metric),
    avgPersonsPerReservation: avgPersonsPerReservation(cell.persons, cell.reservations),
    vsMonthAverage: cellVsMonthAverage(cell, monthRow, metric),
  };
}

// ── Detail-Popup: Tagesaufschlüsselung eines Wochentags im Monat ──────────────

/** Uhrzeit-Verteilung, gruppiert je volle Stunde („HH"). */
export interface HeatmapTimeBucket {
  /** Stunde „HH" (00..23). */
  hour: string;
  reservations: number;
  persons: number;
}

/** Ein konkreter Kalendertag (Vorkommen des Wochentags im Monat). */
export interface HeatmapDayEntry {
  /** „yyyy-MM-dd". */
  date: string;
  /** Tag im Monat, 1..31. */
  day: number;
  reservations: number;
  persons: number;
  /** Uhrzeit-Verteilung (leer, falls keine Zeiten vorhanden). */
  times: HeatmapTimeBucket[];
}

export interface WeekdayDayBreakdown {
  /** Alle Vorkommen des Wochentags im Monat, aufsteigend nach Tag. */
  entries: HeatmapDayEntry[];
  /** Stärkster Tag nach aktiver Kennzahl (null, wenn keiner > 0). */
  strongestDate: string | null;
  /** Schwächster Tag nach aktiver Kennzahl (null, wenn keiner > 0). */
  weakestDate: string | null;
}

export interface BuildWeekdayDayBreakdownArgs {
  /** Ist-Zeilen (optional mit Uhrzeit `time` „HH:mm"). */
  rows: readonly (ReservationAggRow & { time?: string | null })[];
  /** Ist-Monat „yyyy-MM". */
  monthKey: string;
  weekday: IsoWeekday;
  scope: StatusScope;
  /** Kennzahl für stärksten/schwächsten Tag (Default: Personen). */
  metric?: AnalyseMetric;
}

/** Stunde „HH" aus „HH:mm" (NaN-/leer-sicher → null). */
function parseHour(time: string | null | undefined): string | null {
  if (!time) return null;
  const m = /^(\d{2}):\d{2}/.exec(time);
  return m ? m[1] : null;
}

interface DayAcc {
  reservations: number;
  persons: number;
  times: Map<string, MetricCounts>;
}

/**
 * Tagesaufschlüsselung EINES Wochentags in EINEM Monat: je konkretem Datum die
 * Reservationen/Personen + Uhrzeit-Verteilung, plus stärkster/schwächster Tag
 * nach der aktiven Kennzahl (nur Tage mit Wert > 0).
 */
export function buildWeekdayDayBreakdown(
  args: BuildWeekdayDayBreakdownArgs,
): WeekdayDayBreakdown {
  const pred = statusPredicate(args.scope);
  const metric = args.metric ?? DEFAULT_ANALYSE_METRIC;
  const byDate = new Map<string, DayAcc>();

  for (const row of args.rows) {
    if (monthKeyOf(row.date) !== args.monthKey) continue;
    if (isoWeekdayOf(row.date) !== args.weekday) continue;
    if (!pred(row.status)) continue;
    const date = (row.date ?? '').slice(0, 10);
    if (!date) continue;
    let acc = byDate.get(date);
    if (!acc) {
      acc = { reservations: 0, persons: 0, times: new Map() };
      byDate.set(date, acc);
    }
    acc.reservations += 1;
    acc.persons += row.partySize ?? 0;
    const hour = parseHour(row.time);
    if (hour !== null) {
      let t = acc.times.get(hour);
      if (!t) {
        t = { reservations: 0, persons: 0 };
        acc.times.set(hour, t);
      }
      t.reservations += 1;
      t.persons += row.partySize ?? 0;
    }
  }

  const entries: HeatmapDayEntry[] = [...byDate.entries()]
    .map(([date, acc]) => ({
      date,
      day: +date.slice(8, 10),
      reservations: acc.reservations,
      persons: acc.persons,
      times: [...acc.times.entries()]
        .map(([hour, t]) => ({ hour, reservations: t.reservations, persons: t.persons }))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    }))
    .sort((a, b) => a.day - b.day);

  const val = (e: HeatmapDayEntry) => cellMetricValue(e, metric);
  const withValue = entries.filter((e) => val(e) > 0);
  let strongestDate: string | null = null;
  let weakestDate: string | null = null;
  if (withValue.length) {
    strongestDate = [...withValue].sort((a, b) => val(b) - val(a) || a.day - b.day)[0].date;
    weakestDate = [...withValue].sort((a, b) => val(a) - val(b) || a.day - b.day)[0].date;
  }

  return { entries, strongestDate, weakestDate };
}
