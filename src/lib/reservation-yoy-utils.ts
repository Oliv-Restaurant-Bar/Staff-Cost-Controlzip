/**
 * reservation-yoy-utils — Reservationen: Monatsvergleich „Ist vs. Vorjahr"
 * ========================================================================
 * Reine, testbare Logik (KEIN supabase/DOM) für den Jahresvergleich der
 * Reservationen: pro Monat des gewählten Zeitraums wird der gleiche Monat des
 * Vorjahres gegenübergestellt (Okt 2025 ↔ Okt 2024; Okt–Dez 2025 ↔ Okt–Dez 2024).
 *
 * Kennzahlen je Monat und als Total: Reservationen (Anzahl) und Personen
 * (Σ partySize), jeweils Ist, Vorjahr, Differenz absolut und in Prozent.
 *
 * Wichtige Entscheidungen:
 *  - `hasPriorData` prüft, ob der Vorjahresmonat ÜBERHAUPT Zeilen hat (vor dem
 *    Status-Filter). Ohne Vorjahresdaten: prior/diff/diffPct = null, Trend
 *    'neutral' (kein fälschliches „Wachstum" gegen einen leeren Monat).
 *  - `diffPct` ist null, wenn das Vorjahr 0 oder unbekannt ist (keine Division
 *    durch 0); die absolute Differenz bleibt aussagekräftig.
 *  - Trend: 'up' bei diff > 0, 'down' bei diff < 0, sonst 'neutral'.
 *  - Totals: Vorjahres-Summe NUR über Monate MIT Vorjahresdaten;
 *    `monthsWithPrior`/`monthCount` erlauben der UI den Hinweis
 *    „Vorjahr unvollständig".
 *  - Tagesvergleich: Paarung über den Tag im Monat (1..31); Tage, die es nur in
 *    einem der beiden Monate gibt (z. B. 29. Februar), erscheinen mit
 *    `currentDate`/`priorDate` = null auf der fehlenden Seite.
 *  - Stärkste/schwächste Tage: nach IST-Wert der gewählten Kennzahl, nur unter
 *    Tagen mit Ist > 0 (Ruhetage/geschlossene Tage verfälschen sonst die
 *    „schwächsten" Tage).
 *
 * Wiederverwendet die reinen Helfer aus `reservation-weekday-analytics`
 * (monthKeyOf, shiftMonthKey, statusPredicate, …) — KEINE neue Migration,
 * KEINE Schreibzugriffe, Mandanten-Filter passiert im DB-Layer der Seite.
 */

import type { ReservationAggRow } from './reservation-dashboard';
import {
  monthKeyOf,
  shiftMonthKey,
  statusPredicate,
  type StatusScope,
} from './reservation-weekday-analytics';

// ── Typen ────────────────────────────────────────────────────────────────────

export type YoyTrend = 'up' | 'down' | 'neutral';

/** Eine Kennzahl (Reservationen ODER Personen) im Ist-vs-Vorjahr-Vergleich. */
export interface YoyMetric {
  current: number;
  /** null = keine Vorjahresdaten vorhanden (Monat komplett ohne Zeilen). */
  prior: number | null;
  /** current − prior; null wenn Vorjahr unbekannt. */
  diff: number | null;
  /** Differenz in % vom Vorjahr; null wenn Vorjahr unbekannt ODER 0. */
  diffPct: number | null;
  trend: YoyTrend;
}

export interface YoyMonthRow {
  /** Ist-Monat, „yyyy-MM". */
  monthKey: string;
  /** Vergleichsmonat im Vorjahr, „yyyy-MM". */
  priorMonthKey: string;
  /** Hat der Vorjahresmonat überhaupt Zeilen (vor Status-Filter)? */
  hasPriorData: boolean;
  reservations: YoyMetric;
  persons: YoyMetric;
}

export interface YoyTotals {
  reservations: YoyMetric;
  persons: YoyMetric;
  /** Anzahl Monate im Zeitraum mit Vorjahresdaten. */
  monthsWithPrior: number;
  /** Anzahl Monate im Zeitraum insgesamt. */
  monthCount: number;
}

export interface YoyComparison {
  months: YoyMonthRow[];
  totals: YoyTotals;
}

/** Ein Tag im Tagesvergleich (Paarung über den Tag im Monat). */
export interface YoyDayRow {
  /** Tag im Monat, 1..31. */
  day: number;
  /** „yyyy-MM-dd" im Ist-Monat; null wenn der Tag dort nicht existiert. */
  currentDate: string | null;
  /** „yyyy-MM-dd" im Vorjahresmonat; null wenn der Tag dort nicht existiert. */
  priorDate: string | null;
  reservations: YoyMetric;
  persons: YoyMetric;
}

export type YoyDayMetricKey = 'reservations' | 'persons';

export interface YoyDayComparison {
  monthKey: string;
  priorMonthKey: string;
  /** Hat der Vorjahresmonat überhaupt Zeilen (vor Status-Filter)? */
  hasPriorData: boolean;
  days: YoyDayRow[];
  /** Top 3 nach Ist-Wert der Kennzahl (nur Tage mit Ist > 0), absteigend. */
  strongestDays: YoyDayRow[];
  /** Bottom 3 nach Ist-Wert der Kennzahl (nur Tage mit Ist > 0), aufsteigend. */
  weakestDays: YoyDayRow[];
}

// ── Monats-Helfer ────────────────────────────────────────────────────────────

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

/** Gleicher Monat im Vorjahr („2025-10" → „2024-10"). */
export function priorYearMonthKey(monthKey: string): string {
  return shiftMonthKey(monthKey, -12);
}

/** Maximale Zeitraum-Länge in Monaten (Schutz gegen kaputte Eingaben). */
const MAX_RANGE_MONTHS = 48;

/**
 * Alle Monats-Keys von `startKey` bis `endKey` (inklusive, aufsteigend).
 * Ungültige Keys oder Start > Ende → leeres Array.
 */
export function monthKeysInRange(startKey: string, endKey: string): string[] {
  if (!MONTH_KEY_RE.test(startKey) || !MONTH_KEY_RE.test(endKey)) return [];
  if (startKey > endKey) return [];
  const keys: string[] = [];
  let key = startKey;
  for (let i = 0; i < MAX_RANGE_MONTHS && key <= endKey; i++) {
    keys.push(key);
    key = shiftMonthKey(key, 1);
  }
  return keys;
}

/** Letzter Tag eines Monats (Schaltjahr-fest, rein arithmetisch via UTC). */
export function lastDayOfMonthKey(monthKey: string): number {
  const m = MONTH_KEY_RE.exec(monthKey);
  if (!m) return 0;
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return 0;
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Bucket {
  reservations: number;
  persons: number;
  /** Zeilen VOR dem Status-Filter (für „gibt es überhaupt Daten?"). */
  rawRows: number;
}

function emptyBucket(): Bucket {
  return { reservations: 0, persons: 0, rawRows: 0 };
}

/** Summiert Zeilen je Monats-Key (Scope-gefiltert) + rohe Zeilenzahl je Monat. */
function bucketByMonth(
  rows: readonly ReservationAggRow[],
  scope: StatusScope,
): Map<string, Bucket> {
  const pred = statusPredicate(scope);
  const map = new Map<string, Bucket>();
  for (const row of rows) {
    const key = monthKeyOf(row.date);
    if (!key) continue;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      map.set(key, bucket);
    }
    bucket.rawRows += 1;
    if (!pred(row.status)) continue;
    bucket.reservations += 1;
    bucket.persons += row.partySize ?? 0;
  }
  return map;
}

/** Tag im Monat aus „yyyy-MM-dd" (NaN-sicher → null). */
function dayOfDate(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const m = /^\d{4}-\d{2}-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const day = +m[1];
  return day >= 1 && day <= 31 ? day : null;
}

/** Summiert Zeilen EINES Monats je Tag im Monat (Scope-gefiltert). */
function bucketByDay(
  rows: readonly ReservationAggRow[],
  monthKey: string,
  scope: StatusScope,
): { byDay: Map<number, Bucket>; rawRows: number } {
  const pred = statusPredicate(scope);
  const byDay = new Map<number, Bucket>();
  let rawRows = 0;
  for (const row of rows) {
    if (monthKeyOf(row.date) !== monthKey) continue;
    const day = dayOfDate(row.date);
    if (day === null) continue;
    rawRows += 1;
    if (!pred(row.status)) continue;
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = emptyBucket();
      byDay.set(day, bucket);
    }
    bucket.reservations += 1;
    bucket.persons += row.partySize ?? 0;
  }
  return { byDay, rawRows };
}

// ── Kennzahl-Bildung ─────────────────────────────────────────────────────────

/**
 * Baut eine YoyMetric. `priorKnown=false` (keine Vorjahresdaten) → prior/diff/
 * diffPct null + Trend neutral. Vorjahr 0 → diffPct null, Trend nach diff.
 */
export function makeYoyMetric(current: number, prior: number, priorKnown: boolean): YoyMetric {
  if (!priorKnown) {
    return { current, prior: null, diff: null, diffPct: null, trend: 'neutral' };
  }
  const diff = current - prior;
  const diffPct = prior > 0 ? (diff / prior) * 100 : null;
  const trend: YoyTrend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral';
  return { current, prior, diff, diffPct, trend };
}

// ── Monatsvergleich ──────────────────────────────────────────────────────────

export interface BuildYoyComparisonArgs {
  /** Zeilen des Ist-Zeitraums (bereits mandantengefiltert geladen). */
  currentRows: readonly ReservationAggRow[];
  /** Zeilen des Vorjahres-Zeitraums. */
  priorRows: readonly ReservationAggRow[];
  /** Ist-Monate („yyyy-MM", aufsteigend) — z. B. aus `monthKeysInRange`. */
  monthKeys: readonly string[];
  scope: StatusScope;
}

/**
 * Monatszeilen + KPI-Totals für den Ist-vs-Vorjahr-Vergleich.
 * Jeder Ist-Monat wird mit demselben Monat des Vorjahres verglichen.
 */
export function buildYoyComparison(args: BuildYoyComparisonArgs): YoyComparison {
  const currentByMonth = bucketByMonth(args.currentRows, args.scope);
  const priorByMonth = bucketByMonth(args.priorRows, args.scope);

  const months: YoyMonthRow[] = [];
  let totalCurRes = 0;
  let totalCurPers = 0;
  let totalPriorRes = 0;
  let totalPriorPers = 0;
  let monthsWithPrior = 0;

  for (const monthKey of args.monthKeys) {
    const priorKey = priorYearMonthKey(monthKey);
    const cur = currentByMonth.get(monthKey) ?? emptyBucket();
    const prior = priorByMonth.get(priorKey) ?? emptyBucket();
    const hasPriorData = prior.rawRows > 0;

    months.push({
      monthKey,
      priorMonthKey: priorKey,
      hasPriorData,
      reservations: makeYoyMetric(cur.reservations, prior.reservations, hasPriorData),
      persons: makeYoyMetric(cur.persons, prior.persons, hasPriorData),
    });

    totalCurRes += cur.reservations;
    totalCurPers += cur.persons;
    if (hasPriorData) {
      monthsWithPrior += 1;
      totalPriorRes += prior.reservations;
      totalPriorPers += prior.persons;
    }
  }

  const anyPrior = monthsWithPrior > 0;
  return {
    months,
    totals: {
      reservations: makeYoyMetric(totalCurRes, totalPriorRes, anyPrior),
      persons: makeYoyMetric(totalCurPers, totalPriorPers, anyPrior),
      monthsWithPrior,
      monthCount: args.monthKeys.length,
    },
  };
}

// ── Tagesvergleich (Popup) ───────────────────────────────────────────────────

export interface BuildYoyDayComparisonArgs {
  currentRows: readonly ReservationAggRow[];
  priorRows: readonly ReservationAggRow[];
  /** Ist-Monat („yyyy-MM"). */
  monthKey: string;
  scope: StatusScope;
  /** Kennzahl für stärkste/schwächste Tage (Default: Reservationen). */
  metric?: YoyDayMetricKey;
}

/**
 * Tagesvergleich Ist vs. Vorjahr für EINEN Monat: Paarung über den Tag im
 * Monat, plus stärkste/schwächste Tage nach Ist-Wert (nur Tage mit Ist > 0).
 */
export function buildYoyDayComparison(args: BuildYoyDayComparisonArgs): YoyDayComparison {
  const metric: YoyDayMetricKey = args.metric ?? 'reservations';
  const priorMonthKey = priorYearMonthKey(args.monthKey);
  const cur = bucketByDay(args.currentRows, args.monthKey, args.scope);
  const prior = bucketByDay(args.priorRows, priorMonthKey, args.scope);
  const hasPriorData = prior.rawRows > 0;

  const curLast = lastDayOfMonthKey(args.monthKey);
  const priorLast = lastDayOfMonthKey(priorMonthKey);
  const maxDay = Math.max(curLast, priorLast);

  const days: YoyDayRow[] = [];
  for (let day = 1; day <= maxDay; day++) {
    const curBucket = cur.byDay.get(day) ?? emptyBucket();
    const priorBucket = prior.byDay.get(day) ?? emptyBucket();
    const dd = String(day).padStart(2, '0');
    days.push({
      day,
      currentDate: day <= curLast ? `${args.monthKey}-${dd}` : null,
      priorDate: day <= priorLast ? `${priorMonthKey}-${dd}` : null,
      reservations: makeYoyMetric(curBucket.reservations, priorBucket.reservations, hasPriorData),
      persons: makeYoyMetric(curBucket.persons, priorBucket.persons, hasPriorData),
    });
  }

  const activeDays = days.filter((d) => d[metric].current > 0);
  const desc = [...activeDays].sort(
    (a, b) => b[metric].current - a[metric].current || a.day - b.day,
  );
  const asc = [...activeDays].sort(
    (a, b) => a[metric].current - b[metric].current || a.day - b.day,
  );

  return {
    monthKey: args.monthKey,
    priorMonthKey,
    hasPriorData,
    days,
    strongestDays: desc.slice(0, 3),
    weakestDays: asc.slice(0, 3),
  };
}
