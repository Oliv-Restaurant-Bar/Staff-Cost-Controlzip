/**
 * Foratable Report — Zukunftsübersicht & Kalenderlogik (rein, ohne DB/DOM)
 * ========================================================================
 * Baut die Zukunfts-Kacheln, die Kalenderübersicht und die Tages-Detailwerte
 * des Foratable Reports AUS DENSELBEN zentralen Bausteinen wie die
 * CRM-Auswertung — es gibt KEINE zweite/parallele Zukunfts- oder Statuslogik:
 *
 *  - Statuslogik + Zählung:  isActiveStatus + countInRange   (reservation-dashboard.ts)
 *  - Tagesaggregation:       aggregateReservationsByDay      (reservation-dashboard.ts)
 *  - Farb-/Intensitätsskala: classifyHeatmapLevel            (reservation-analyse-utils.ts)
 *
 * Damit liefert diese Datei für denselben Zeitraum exakt dieselben Personen-/
 * Reservationszahlen wie die CRM-Auswertung (Anforderung „identische Werte").
 *
 * WICHTIG (PII): `buildDayDetail` gibt bewusst nur AGGREGATE zurück (keine
 * Namen/Telefon/E-Mail/Kommentare), damit das Kalender-Popup keine PII zeigt.
 *
 * Frei von Supabase/DOM; ISO-Datumsstrings „yyyy-MM-dd", lexikografisch
 * vergleichbar. Reine Datums-Arithmetik über UTC (DST-sicher).
 */

import {
  countInRange,
  aggregateReservationsByDay,
  addIsoDays,
  isActiveStatus,
  type ReservationAggRow,
  type ReservationDetailRow,
  type RangeCount,
  type DayAggregate,
} from './reservation-dashboard';
import { classifyHeatmapLevel, type HeatmapLevel, type HeatmapScale } from './reservation-analyse-utils';
import type { Tone } from '@/components/ui/tones';

// ── Kennzahl ─────────────────────────────────────────────────────────────────

/** Kennzahl der Kalender-Einfärbung / „stärkster Tag" (Default: Personen). */
export type FutureMetric = 'persons' | 'reservations';

function metricValue(d: DayAggregate, metric: FutureMetric): number {
  return metric === 'persons' ? d.persons : d.reservations;
}

// ── Wochentage (deutsche Labels, 1 = Mo … 7 = So) ────────────────────────────

/** ISO-Wochentag (1 = Montag … 7 = Sonntag) eines „yyyy-MM-dd" (UTC). */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = So … 6 = Sa
  return wd === 0 ? 7 : wd;
}

export const WEEKDAY_LABEL_SHORT: Record<number, string> = {
  1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa', 7: 'So',
};

export const WEEKDAY_LABEL_LONG: Record<number, string> = {
  1: 'Montag', 2: 'Dienstag', 3: 'Mittwoch', 4: 'Donnerstag',
  5: 'Freitag', 6: 'Samstag', 7: 'Sonntag',
};

// ── Zeitraum-Schnellauswahl ──────────────────────────────────────────────────

/**
 * Schnellauswahl-Kinds. Fenster (Nutzervorgabe, inklusive Grenzen):
 *  - current-month = heute … Monatsende
 *  - next-7  = heute … heute + 6   (7 Tage)
 *  - next-14 = heute … heute + 13  (14 Tage)
 *  - next-30 = heute … heute + 29  (30 Tage)
 * Hinweis: „Nächste 30 Tage" umfasst hier bewusst 30 Kalendertage (heute + 29)
 * und weicht damit um einen Tag von der CRM-Kachel „Nächste 30 Tage" ab
 * (dort heute + 30 = 31 Tage). Für IDENTISCHE Zeiträume sind die Werte gleich.
 */
export type FutureRangeKind = 'current-month' | 'next-7' | 'next-14' | 'next-30' | 'custom';

export interface FutureRange {
  kind: FutureRangeKind;
  /** „yyyy-MM-dd" inklusive. */
  from: string;
  /** „yyyy-MM-dd" inklusive. */
  to: string;
}

/** Monatsletzter eines „yyyy-MM-dd" als „yyyy-MM-dd" (UTC). */
function endOfMonthIso(iso: string): string {
  const [y, m] = iso.slice(0, 10).split('-').map(Number);
  // Tag 0 des Folgemonats = letzter Tag dieses Monats.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Baut den Schnellauswahl-Zeitraum ab „heute". */
export function futureQuickRange(
  kind: Exclude<FutureRangeKind, 'custom'>,
  today: string,
): FutureRange {
  const t = today.slice(0, 10);
  switch (kind) {
    case 'current-month': return { kind, from: t, to: endOfMonthIso(t) };
    case 'next-7':  return { kind, from: t, to: addIsoDays(t, 6) };
    case 'next-14': return { kind, from: t, to: addIsoDays(t, 13) };
    case 'next-30': return { kind, from: t, to: addIsoDays(t, 29) };
  }
}

// ── Farb-/Intensitätsskala des Kalenders ─────────────────────────────────────

/** 4 Ampelfarben des Kalenders (aus den 6 Heatmap-Stufen abgeleitet). */
export type FutureLevelColor = 'grau' | 'gruen' | 'orange' | 'rot';

/** Relative Skala (min/max über Tage mit Wert > 0) für `classifyHeatmapLevel`. */
export function dayValueScale(days: DayAggregate[], metric: FutureMetric): HeatmapScale {
  let min = Infinity;
  let max = -Infinity;
  for (const d of days) {
    const v = metricValue(d, metric);
    if (v > 0) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (max < 0) return { min: 0, max: 0, hasRange: false };
  return { min, max, hasRange: max > min };
}

/** Bildet die 6 Heatmap-Stufen auf die 4 Ampel-Farben ab (Grau=leer … Rot=Spitze). */
export function levelColor(level: HeatmapLevel): FutureLevelColor {
  switch (level) {
    case 'empty': return 'grau';
    case 'veryLow':
    case 'low':
    case 'mid': return 'gruen';
    case 'high': return 'orange';
    case 'veryHigh': return 'rot';
  }
}

/** Ampel-Farbe → Design-System-Ton (tones.ts). */
export function levelTone(level: HeatmapLevel): Tone {
  switch (levelColor(level)) {
    case 'grau': return 'neutral';
    case 'gruen': return 'good';
    case 'orange': return 'warn';
    case 'rot': return 'critical';
  }
}

// ── Kalendertag mit Einstufung ───────────────────────────────────────────────

export interface CalendarDay extends DayAggregate {
  /** ISO-Wochentag 1 = Mo … 7 = So. */
  weekday: number;
  level: HeatmapLevel;
  color: FutureLevelColor;
}

/** Reichert Tagesaggregate um Wochentag + relative Einstufung (Farbe) an. */
export function buildCalendarDays(
  days: DayAggregate[],
  metric: FutureMetric = 'persons',
): CalendarDay[] {
  const scale = dayValueScale(days, metric);
  return days.map((d) => {
    const level = classifyHeatmapLevel(metricValue(d, metric), scale);
    return { ...d, weekday: isoWeekday(d.date), level, color: levelColor(level) };
  });
}

// ── Zukunftsübersicht ────────────────────────────────────────────────────────

export interface FutureOverview {
  /** Gewählter (roher) Zeitraum. */
  range: FutureRange;
  /** Auf [max(heute, from), to] geklammerter, effektiv ausgewerteter Zukunftsbereich. */
  effectiveFrom: string;
  effectiveTo: string;
  /** true, wenn der Zeitraum vollständig in der Vergangenheit liegt (kein Zukunftstag). */
  empty: boolean;
  /** Aktive Reservationen/Personen im effektiven Bereich (= countInRange, isActiveStatus). */
  totals: RangeCount;
  /** Ø Gruppengrösse (Personen / Reservationen) — null, wenn keine Reservationen. */
  avgPartySize: number | null;
  /** Absolute Fenster ab heute (Nutzer-Definition 7/14/30 Kalendertage). */
  next7: RangeCount;
  next14: RangeCount;
  next30: RangeCount;
  /** Kalendertage des effektiven Bereichs (inkl. Nulltage), chronologisch. */
  days: CalendarDay[];
  /** Anzahl Tage mit ≥ 1 aktiven Reservation. */
  daysWithReservations: number;
  /** Stärkster Tag im Bereich (meiste Kennzahl; bei Gleichstand der frühere). */
  strongestDay: CalendarDay | null;
  /** Frühester kommender Tag mit hoher Auslastung (Stufe high/veryHigh). */
  nextStrongDay: CalendarDay | null;
}

/**
 * Baut die vollständige Zukunftsübersicht aus den (ab heute geladenen) Rohzeilen.
 * `rows` müssen mindestens [heute, max(range.to, heute+29)] abdecken, damit die
 * 7/14/30-Tage-Kacheln vollständig sind.
 */
export function buildFutureOverview(
  rows: ReservationAggRow[],
  range: FutureRange,
  today: string,
  metric: FutureMetric = 'persons',
): FutureOverview {
  const t = today.slice(0, 10);
  const from = range.from < t ? t : range.from; // Vergangenheit abschneiden
  const to = range.to;
  const empty = !to || to < from;

  const totals = empty
    ? { reservations: 0, persons: 0 }
    : countInRange(rows, from, to, isActiveStatus);
  const avgPartySize = totals.reservations > 0 ? totals.persons / totals.reservations : null;

  const next7  = countInRange(rows, t, addIsoDays(t, 6),  isActiveStatus);
  const next14 = countInRange(rows, t, addIsoDays(t, 13), isActiveStatus);
  const next30 = countInRange(rows, t, addIsoDays(t, 29), isActiveStatus);

  const dayAggs = empty ? [] : aggregateReservationsByDay(rows, from, to, isActiveStatus);
  const days = buildCalendarDays(dayAggs, metric);
  const daysWithReservations = days.filter((d) => d.reservations > 0).length;

  let strongestDay: CalendarDay | null = null;
  for (const d of days) {
    if (metricValue(d, metric) <= 0) continue;
    // Tage sind chronologisch → strikt „>" behält bei Gleichstand den früheren.
    if (!strongestDay || metricValue(d, metric) > metricValue(strongestDay, metric)) {
      strongestDay = d;
    }
  }
  const nextStrongDay = days.find((d) => d.level === 'high' || d.level === 'veryHigh') ?? null;

  return {
    range, effectiveFrom: from, effectiveTo: to, empty,
    totals, avgPartySize, next7, next14, next30,
    days, daysWithReservations, strongestDay, nextStrongDay,
  };
}

// ── Tages-Detail (nur Aggregate, KEINE PII) ──────────────────────────────────

export interface RoomBreakdown {
  room: string;
  reservations: number;
  persons: number;
}

export interface StatusBreakdown {
  /** Roher (klein geschriebener) status_normalized-Schlüssel. */
  status: string;
  reservations: number;
  persons: number;
}

/**
 * Aggregierte Tages-Detailwerte für das Kalender-Popup — bewusst OHNE PII
 * (keine Namen/Telefon/E-Mail/Kommentare). Die aktiven Totale sind deckungs-
 * gleich mit der Kalenderzelle; die Statusverteilung umfasst ALLE Reservationen
 * des Tages (auch Storno/offen) zur Einordnung.
 */
export interface DayDetail {
  date: string;
  weekday: number;
  /** Aktive Reservationen/Personen (= Kalenderzelle). */
  active: RangeCount;
  avgPartySize: number | null;
  /** Frühestes/spätestes „HH:mm" der aktiven Reservationen (null, wenn keine Zeit). */
  timeFrom: string | null;
  timeTo: string | null;
  /** Räume der aktiven Reservationen (absteigend nach Personen). */
  rooms: RoomBreakdown[];
  /** Statusverteilung ALLER Reservationen des Tages (absteigend nach Anzahl). */
  statuses: StatusBreakdown[];
}

const HHMM = /^(\d{1,2}):(\d{2})/;

/** Baut die aggregierten Tages-Detailwerte (nur Aggregate) für einen Kalendertag. */
export function buildDayDetail(rows: ReservationDetailRow[], date: string): DayDetail {
  const d = date.slice(0, 10);
  const dayRows = rows.filter((r) => r.date && r.date.slice(0, 10) === d);
  const activeRows = dayRows.filter((r) => isActiveStatus(r.status));

  const active: RangeCount = {
    reservations: activeRows.length,
    persons: activeRows.reduce((s, r) => s + (r.partySize ?? 0), 0),
  };
  const avgPartySize = active.reservations > 0 ? active.persons / active.reservations : null;

  const times = activeRows
    .map((r) => r.time)
    .filter((tm): tm is string => !!tm && HHMM.test(tm))
    .map((tm) => tm.slice(0, 5))
    .sort();
  const timeFrom = times.length ? times[0] : null;
  const timeTo = times.length ? times[times.length - 1] : null;

  const roomMap = new Map<string, RoomBreakdown>();
  for (const r of activeRows) {
    const room = (r.room ?? r.area ?? '').trim() || '—';
    const cur = roomMap.get(room) ?? { room, reservations: 0, persons: 0 };
    cur.reservations++;
    cur.persons += r.partySize ?? 0;
    roomMap.set(room, cur);
  }
  const rooms = [...roomMap.values()].sort(
    (a, b) => b.persons - a.persons || b.reservations - a.reservations || (a.room < b.room ? -1 : 1),
  );

  const statusMap = new Map<string, StatusBreakdown>();
  for (const r of dayRows) {
    const key = (r.status ?? 'unknown').trim().toLowerCase() || 'unknown';
    const cur = statusMap.get(key) ?? { status: key, reservations: 0, persons: 0 };
    cur.reservations++;
    cur.persons += r.partySize ?? 0;
    statusMap.set(key, cur);
  }
  const statuses = [...statusMap.values()].sort(
    (a, b) => b.reservations - a.reservations || (a.status < b.status ? -1 : 1),
  );

  return { date: d, weekday: isoWeekday(d), active, avgPartySize, timeFrom, timeTo, rooms, statuses };
}
