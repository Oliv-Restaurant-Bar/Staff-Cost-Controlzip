/**
 * Gäste-CRM — Top/Flop-Listen + Zeitraum (reine Logik, KEINE DB/DOM)
 * =============================================================================
 * Rankt Gäste für zwei Auswertungen:
 *   • Top-Liste  — die aktivsten Gäste im gewählten Zeitraum (meiste AKTIVEN
 *                  Besuche = bestätigt + abgeschlossen).
 *   • Flop-Liste — die am stärksten überfälligen Gäste (höchstes Rückkehr-
 *                  potenzial): Tage seit letztem Besuch deutlich über dem
 *                  persönlichen Ø-Intervall (`overdueByDays`, Faktor 1,5). Das ist
 *                  ein Stand-heute-Wert und damit unabhängig vom Zeitraum.
 *
 * Zeitraum-Auflösung erfolgt über date-fns; Datumsvergleiche laufen über ISO-
 * Strings (yyyy-MM-dd sortiert lexikografisch korrekt). Status-Prüfung nutzt
 * `isActiveStatus`, Überfälligkeit `overdueByDays` (single source of truth in
 * reservation-dashboard.ts).
 */

import { startOfMonth, endOfMonth, subMonths, subDays, format } from 'date-fns';
import { isActiveStatus, overdueByDays } from './reservation-dashboard';
import { type GuestListMetrics } from './reservation-crm';

export type ZeitraumPreset =
  | 'akt_monat' | 'letzter_monat' | 'letzte_90' | 'individuell';

export interface ZeitraumRange {
  /** ISO-Startdatum (inklusive), yyyy-MM-dd. */
  from: string;
  /** ISO-Enddatum (inklusive), yyyy-MM-dd. */
  to: string;
}

/** Auswahl-Optionen (Wert + deutsches Label) für den Zeitraum-Selector. */
export const ZEITRAUM_OPTIONS: { value: ZeitraumPreset; label: string }[] = [
  { value: 'akt_monat',     label: 'Dieser Monat' },
  { value: 'letzter_monat', label: 'Letzter Monat' },
  { value: 'letzte_90',     label: 'Letzte 90 Tage' },
  { value: 'individuell',   label: 'Benutzerdefiniert' },
];

const iso = (d: Date): string => format(d, 'yyyy-MM-dd');

/**
 * Löst einen Preset (relativ zu `today`) in einen inklusiven ISO-Datumsbereich
 * auf. Für 'individuell' wird `custom` genutzt (fehlt es → heute…heute); ein
 * verdrehter Bereich (from > to) wird getauscht.
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
    case 'letzte_90':
      return { from: iso(subDays(today, 90)), to: iso(today) };
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

/**
 * Gast + Kennzahlen für die Top/Flop-Tabellen. Im Top-Modus zählen
 * `rangeVisits`/`rangePersons` (Besuche im Zeitraum); im Flop-Modus trägt
 * `overdueDays` die Überfälligkeit (Tage über der Erwartung), die anderen 0.
 */
export interface TopFlopRow {
  metric: GuestListMetrics;
  rangeVisits: number;
  rangePersons: number;
  overdueDays: number | null;
}

const byName = (a: GuestListMetrics, b: GuestListMetrics): number =>
  a.displayName.localeCompare(b.displayName, 'de');

/**
 * Top-Liste: Gäste mit ≥ 1 aktivem Besuch im Zeitraum, sortiert nach Besuchen ↓,
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
    rows.push({ metric: m, rangeVisits: c.visits, rangePersons: c.persons, overdueDays: null });
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
 * Flop-Liste: die am stärksten überfälligen Gäste (höchstes Rückkehrpotenzial).
 * Überfällig = Tage seit letztem Besuch über Ø-Intervall × 1,5 (`overdueByDays`
 * > 0, setzt ≥ 2 Besuche und ein positives Ø-Intervall voraus). Sortiert nach
 * Überfälligkeit ↓, dann Tage seit letztem Besuch ↓, dann Name. Auf `limit`.
 * Stand-heute-Wert — unabhängig vom gewählten Zeitraum.
 */
export function buildFlopList(
  metrics: GuestListMetrics[],
  limit = 50,
): TopFlopRow[] {
  const rows: TopFlopRow[] = [];
  for (const m of metrics) {
    const o = overdueByDays(m);
    if (o === null || o <= 0) continue;          // nur überfällige Gäste
    rows.push({ metric: m, rangeVisits: 0, rangePersons: 0, overdueDays: o });
  }
  rows.sort((a, b) =>
    (b.overdueDays ?? 0) - (a.overdueDays ?? 0) ||
    (b.metric.daysSinceLastVisit ?? 0) - (a.metric.daysSinceLastVisit ?? 0) ||
    byName(a.metric, b.metric),
  );
  return rows.slice(0, Math.max(0, limit));
}
