/**
 * Gäste-CRM — Top/Flop-Listen + Zeitraum (reine Logik, KEINE DB/DOM)
 * =============================================================================
 * Rankt Gäste nach AKTIVEN Besuchen (bestätigt + abgeschlossen) innerhalb eines
 * wählbaren Zeitraums:
 *   • Top-Liste  — die aktivsten Gäste im Zeitraum (meiste Besuche).
 *   • Flop-Liste — früher aktive Gäste (Lebenszeit-Besuche ≥ 1), die im Zeitraum
 *                  NICHT da waren (0 Besuche) — Kandidaten zum Reaktivieren.
 *
 * Zeitraum-Auflösung erfolgt über date-fns; Datumsvergleiche laufen über ISO-
 * Strings (yyyy-MM-dd sortiert lexikografisch korrekt). Status-Prüfung nutzt
 * `isActiveStatus` (single source of truth in reservation-dashboard.ts).
 */

import { startOfMonth, endOfMonth, subMonths, subDays, startOfYear, format } from 'date-fns';
import { isActiveStatus } from './reservation-dashboard';
import { SEGMENT_ORDER, baseSegmentByVisits, type GuestListMetrics } from './reservation-crm';

export type ZeitraumPreset =
  | 'akt_monat' | 'letzter_monat' | 'letzte_30' | 'letzte_90' | 'ytd' | 'individuell';

export interface ZeitraumRange {
  /** ISO-Startdatum (inklusive), yyyy-MM-dd. */
  from: string;
  /** ISO-Enddatum (inklusive), yyyy-MM-dd. */
  to: string;
}

/** Auswahl-Optionen (Wert + deutsches Label) für den Zeitraum-Selector. */
export const ZEITRAUM_OPTIONS: { value: ZeitraumPreset; label: string }[] = [
  { value: 'akt_monat',     label: 'Aktueller Monat' },
  { value: 'letzter_monat', label: 'Letzter Monat' },
  { value: 'letzte_30',     label: 'Letzte 30 Tage' },
  { value: 'letzte_90',     label: 'Letzte 90 Tage' },
  { value: 'ytd',           label: 'Jahr bis heute' },
  { value: 'individuell',   label: 'Individuell' },
];

const iso = (d: Date): string => format(d, 'yyyy-MM-dd');

/**
 * Löst einen Preset (relativ zu `today`) in einen inklusiven ISO-Datumsbereich auf.
 * Für 'individuell' wird `custom` genutzt (fehlt es → heute…heute); ein verdrehter
 * Bereich (from > to) wird getauscht.
 */
export function resolveZeitraum(
  preset: ZeitraumPreset,
  today: Date,
  custom?: Partial<ZeitraumRange>,
): ZeitraumRange {
  switch (preset) {
    case 'akt_monat':
      return { from: iso(startOfMonth(today)), to: iso(endOfMonth(today)) };
    case 'letzter_monat': {
      const prev = subMonths(today, 1);
      return { from: iso(startOfMonth(prev)), to: iso(endOfMonth(prev)) };
    }
    case 'letzte_30':
      return { from: iso(subDays(today, 30)), to: iso(today) };
    case 'letzte_90':
      return { from: iso(subDays(today, 90)), to: iso(today) };
    case 'ytd':
      return { from: iso(startOfYear(today)), to: iso(today) };
    case 'individuell': {
      // Leere/fehlende Eingaben → auf heute zurückfallen (kein gte('')/lte('')).
      const from = custom?.from || iso(today);
      const to = custom?.to || iso(today);
      return from <= to ? { from, to } : { from: to, to: from };
    }
  }
}

/** Eine aktive Reservierungszeile (bestätigt/abgeschlossen) eines Gastes. */
export interface ActiveVisitRow {
  guestId: string;
  date: string | null;
  partySize: number | null;
  status: string;
}

export interface RangeVisitCount {
  visits: number;
  persons: number;
}

/**
 * Zählt aktive Besuche je Gast innerhalb [from, to] (inklusive). Defensiv: prüft
 * Status (`isActiveStatus`) und Datum erneut, auch wenn die DB bereits filtert.
 */
export function inRangeVisitCounts(
  rows: ActiveVisitRow[],
  from: string,
  to: string,
): Map<string, RangeVisitCount> {
  const out = new Map<string, RangeVisitCount>();
  for (const r of rows) {
    if (!r.guestId || !r.date) continue;
    if (r.date < from || r.date > to) continue;
    if (!isActiveStatus(r.status)) continue;
    const c = out.get(r.guestId) ?? { visits: 0, persons: 0 };
    c.visits++;
    if (typeof r.partySize === 'number' && Number.isFinite(r.partySize)) c.persons += r.partySize;
    out.set(r.guestId, c);
  }
  return out;
}

/** Gast + seine Kennzahlen im gewählten Zeitraum (für Top/Flop-Tabellen). */
export interface TopFlopRow {
  metric: GuestListMetrics;
  rangeVisits: number;
  rangePersons: number;
}

const segIndex = (m: GuestListMetrics): number => {
  const i = SEGMENT_ORDER.indexOf(baseSegmentByVisits(m.visits));
  return i === -1 ? SEGMENT_ORDER.length : i;
};

const byName = (a: GuestListMetrics, b: GuestListMetrics): number =>
  a.displayName.localeCompare(b.displayName, 'de');

/**
 * Top-Liste: Gäste mit ≥1 aktivem Besuch im Zeitraum, sortiert nach Besuchen ↓,
 * dann Personen ↓, dann Lebenszeit-Besuche ↓, dann Name. Auf `limit` gekürzt.
 */
export function buildTopList(
  metrics: GuestListMetrics[],
  counts: Map<string, RangeVisitCount>,
  limit: number,
): TopFlopRow[] {
  const rows: TopFlopRow[] = [];
  for (const m of metrics) {
    const c = counts.get(m.id);
    if (!c || c.visits < 1) continue;
    rows.push({ metric: m, rangeVisits: c.visits, rangePersons: c.persons });
  }
  rows.sort((a, b) =>
    b.rangeVisits - a.rangeVisits ||
    b.rangePersons - a.rangePersons ||
    b.metric.visits - a.metric.visits ||
    byName(a.metric, b.metric),
  );
  return rows.slice(0, Math.max(0, limit));
}

/**
 * Flop-Liste: früher aktive Gäste (Lebenszeit-Besuche ≥ 1) OHNE Besuch im
 * Zeitraum — Reaktivierungs-Kandidaten. Sortiert nach Wert-Tier (VIP zuerst),
 * dann Lebenszeit-Besuche ↓, dann längste Abwesenheit ↓, dann Name. Auf `limit`.
 */
export function buildFlopList(
  metrics: GuestListMetrics[],
  counts: Map<string, RangeVisitCount>,
  limit = 50,
): TopFlopRow[] {
  const rows: TopFlopRow[] = [];
  for (const m of metrics) {
    if (m.visits < 1) continue;                       // nie aktiv → kein „Flop"
    const c = counts.get(m.id);
    if (c && c.visits > 0) continue;                  // im Zeitraum aktiv → kein Flop
    rows.push({ metric: m, rangeVisits: 0, rangePersons: 0 });
  }
  rows.sort((a, b) =>
    segIndex(a.metric) - segIndex(b.metric) ||
    b.metric.visits - a.metric.visits ||
    (b.metric.daysSinceLastVisit ?? -1) - (a.metric.daysSinceLastVisit ?? -1) ||
    byName(a.metric, b.metric),
  );
  return rows.slice(0, Math.max(0, limit));
}
