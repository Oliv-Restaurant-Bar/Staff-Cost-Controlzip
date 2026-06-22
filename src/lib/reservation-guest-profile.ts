/**
 * Gäste-CRM — Kundenakte-Analytik (reine Berechnung, KEINE DB/DOM-Abhängigkeit)
 * =============================================================================
 * Ergänzt die Gäste-Detailseite (Kundenakte) um Präferenzen, Besuchstrend,
 * Reservierungs-Historienfilter und einen CRM-Score.  Bewusst frei von
 * Supabase/DOM, damit alles als Unit ohne Datenbank getestet werden kann.
 *
 * Grundsätze:
 *  - „Besuch" = ABGESCHLOSSENE Reservation (status_normalized === 'completed').
 *    Präferenzen und Trend werden ausschliesslich aus Besuchen abgeleitet —
 *    Stornos/No-Shows spiegeln kein tatsächliches Gästeverhalten wider.
 *  - Defensiv bei leeren/fehlenden Daten: jede Funktion liefert sinnvolle
 *    Nullwerte statt zu werfen.
 *  - Keine PII in Logs (dieses Modul loggt nichts).
 */

import { daysBetween, type GuestReservationRecord, SEGMENT_VIP_MIN } from './reservation-crm';
import { isoToDate, type ExportCell } from './export-cell';

// ── Häufigkeits-Helfer ───────────────────────────────────────────────────────

/**
 * Häufigster Wert einer Liste (null/undefined werden ignoriert).  Bei
 * Gleichstand gewinnt der zuerst auftretende Wert; da die Reservationsliste
 * neueste-zuerst sortiert ist, ist das der jeweils jüngere Wert.  Map bewahrt
 * die Einfügereihenfolge, daher genügt ein striktes `>` für diesen Tie-Break.
 */
export function mostFrequent<T extends string | number>(
  values: ReadonlyArray<T | null | undefined>,
): T | null {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// ── Präferenzen ──────────────────────────────────────────────────────────────

/** Deutsche Wochentagsnamen, Index 0 = Montag … 6 = Sonntag. */
export const WEEKDAY_LABELS = [
  'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag',
] as const;

/**
 * Wochentag (0 = Montag … 6 = Sonntag) eines ISO-Datums „yyyy-MM-dd" über die
 * Tagesnummer seit Epoche (1970-01-01 = Donnerstag).  null bei ungültigem Datum.
 */
export function weekdayIndex(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const dayNumber = Math.floor(ms / 86400000);
  return (((dayNumber % 7) + 3) % 7 + 7) % 7; // 1970-01-01 (Epoche-Tag 0) = Donnerstag → Index 3
}

/**
 * Normalisiert „Bereich" aus `area` (bevorzugt) bzw. `room` auf die typischen
 * Lokal-Bereiche.  Bekannte Schlüsselwörter werden case-insensitiv den
 * kanonischen Labels Restaurant / Terrasse / Bar zugeordnet; unbekannte, aber
 * vorhandene Werte bleiben als getrimmter Rohwert erhalten (kein Datenverlust).
 * null, wenn weder `area` noch `room` gesetzt sind.
 */
export function normalizeArea(
  area: string | null | undefined,
  room: string | null | undefined,
): string | null {
  const raw = (area && area.trim()) || (room && room.trim()) || '';
  if (!raw) return null;
  const k = raw.toLowerCase();
  if (/(terrass|terrace|garten|garden|aussen|außen|outdoor)/.test(k)) return 'Terrasse';
  if (/(\bbar\b|lounge|theke|tresen)/.test(k)) return 'Bar';
  if (/(restaurant|saal|innen|drinnen|stube|indoor)/.test(k)) return 'Restaurant';
  return raw;
}

export interface GuestPreferences {
  /** Häufigster Bereich (Restaurant/Terrasse/Bar bzw. Rohwert) oder null. */
  favoriteArea: string | null;
  /** Häufigster Wochentag (deutsches Label) oder null. */
  favoriteWeekday: string | null;
  /** Häufigste Uhrzeit „HH:mm" oder null. */
  favoriteTime: string | null;
  /** Häufigste Gruppengrösse oder null. */
  mostCommonPartySize: number | null;
}

/**
 * Leitet die Präferenzen eines Gastes aus seinen ABGESCHLOSSENEN Besuchen ab.
 * Defensiv: ohne Besuche/Daten sind die jeweiligen Felder null.
 */
export function computeGuestPreferences(
  reservations: ReadonlyArray<GuestReservationRecord>,
): GuestPreferences {
  const completed = reservations.filter(r => r.statusNormalized === 'completed');
  const areas = completed.map(r => normalizeArea(r.area, r.room));
  const weekdays = completed.map(r => {
    const idx = weekdayIndex(r.reservationDate);
    return idx === null ? null : WEEKDAY_LABELS[idx];
  });
  const times = completed.map(r => {
    const t = r.reservationTime?.trim();
    return t ? t.slice(0, 5) : null;
  });
  const sizes = completed.map(r =>
    typeof r.partySize === 'number' && Number.isFinite(r.partySize) ? r.partySize : null,
  );
  return {
    favoriteArea: mostFrequent(areas),
    favoriteWeekday: mostFrequent(weekdays),
    favoriteTime: mostFrequent(times),
    mostCommonPartySize: mostFrequent(sizes),
  };
}

// ── Besuchstrend (letzte 90 vs. vorherige 90 Tage) ───────────────────────────

/** Toleranz: Differenz ≤ diesem Wert gilt als „stabil" (dämpft Rauschen). */
export const TREND_STABLE_TOLERANCE = 1;

export type TrendDirection = 'steigend' | 'stabil' | 'rückläufig';

export interface GuestVisitTrend {
  /** Abgeschlossene Besuche in den letzten 90 Tagen [heute−89, heute]. */
  last90: number;
  /** Abgeschlossene Besuche in den vorherigen 90 Tagen [heute−179, heute−90]. */
  previous90: number;
  direction: TrendDirection;
}

/**
 * Vergleicht die Besuche der letzten 90 Tage mit den vorherigen 90 Tagen
 * (nicht überlappende, inklusive Fenster).  Nur abgeschlossene Besuche mit
 * gültigem, nicht-zukünftigem Datum zählen.
 */
export function computeVisitTrend(
  reservations: ReadonlyArray<GuestReservationRecord>,
  today: string,
): GuestVisitTrend {
  let last90 = 0;
  let previous90 = 0;
  for (const r of reservations) {
    if (r.statusNormalized !== 'completed') continue;
    const ago = daysBetween(r.reservationDate, today); // heute − Datum (positiv = Vergangenheit)
    if (ago === null) continue;
    if (ago >= 0 && ago <= 89) last90++;
    else if (ago >= 90 && ago <= 179) previous90++;
  }
  const diff = last90 - previous90;
  let direction: TrendDirection;
  if (Math.abs(diff) <= TREND_STABLE_TOLERANCE) direction = 'stabil';
  else direction = diff > 0 ? 'steigend' : 'rückläufig';
  return { last90, previous90, direction };
}

// ── Reservierungs-Historienfilter ────────────────────────────────────────────

export type HistoryFilter = 'alle' | 'besuche' | 'storniert' | 'noshow';

/** Filtert die Reservierungs-Historie nach Status (rein, ohne Sortierung). */
export function filterReservationHistory<T extends { statusNormalized: GuestReservationRecord['statusNormalized'] }>(
  reservations: ReadonlyArray<T>,
  filter: HistoryFilter,
): T[] {
  switch (filter) {
    case 'besuche':   return reservations.filter(r => r.statusNormalized === 'completed');
    case 'storniert': return reservations.filter(r => r.statusNormalized === 'cancelled');
    case 'noshow':    return reservations.filter(r => r.statusNormalized === 'noshow');
    case 'alle':
    default:          return [...reservations];
  }
}

// ── CRM-Score (0–100) ─────────────────────────────────────────────────────────
//
// Gewichtung (Summe = 1,0) — dokumentiert, damit Logik, UI und Tests dieselbe
// Definition teilen:
//   • Besuchsanzahl   40 %  — voll bei ≥ 20 Besuchen (= VIP-Schwelle)
//   • Aktualität      25 %  — voll bei ≤ 30 Tagen seit letztem Besuch, 0 ab 180
//   • Regelmässigkeit 20 %  — voll bei Ø-Intervall ≤ 30 Tage, 0 ab 180 Tage;
//                              0 bei < 2 Besuchen (kein Intervall messbar)
//   • Gruppengrösse   15 %  — voll bei Ø-Gruppengrösse ≥ 6 Personen
// Jede Teilkomponente liefert 0–100; der Gesamtscore ist die gewichtete Summe,
// kaufmännisch gerundet auf 0–100.  Defensiv: fehlende Werte ⇒ Teilscore 0.

export const CRM_SCORE_WEIGHTS = {
  visits: 0.40,
  recency: 0.25,
  regularity: 0.20,
  partySize: 0.15,
} as const;

export const SCORE_VISITS_FULL = SEGMENT_VIP_MIN;     // 20 Besuche ⇒ 100
export const SCORE_RECENCY_FULL_DAYS = 30;            // ≤ 30 Tage ⇒ 100
export const SCORE_RECENCY_ZERO_DAYS = 180;           // ≥ 180 Tage ⇒ 0
export const SCORE_REGULARITY_FULL_DAYS = 30;         // Ø ≤ 30 Tage ⇒ 100
export const SCORE_REGULARITY_ZERO_DAYS = 180;        // Ø ≥ 180 Tage ⇒ 0
export const SCORE_PARTY_FULL = 6;                    // Ø ≥ 6 Personen ⇒ 100

export type CrmScoreTier = 'niedrig' | 'mittel' | 'hoch' | 'vip_potenzial';

export const CRM_SCORE_TIER_LABEL: Record<CrmScoreTier, string> = {
  niedrig:       'Niedrig',
  mittel:        'Mittel',
  hoch:          'Hoch',
  vip_potenzial: 'VIP-Potenzial',
};

export interface CrmScoreComponents {
  visits: number;
  recency: number;
  regularity: number;
  partySize: number;
}

export interface CrmScore {
  score: number;            // 0–100
  tier: CrmScoreTier;
  components: CrmScoreComponents;
}

/** Eingabe für den CRM-Score (Teilmenge der Detail-Kennzahlen). */
export interface CrmScoreInput {
  visits: number;
  daysSinceLastVisit: number | null;
  avgDaysBetweenVisits: number | null;
  avgPartySize: number | null;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Lineare Abnahme von 100 (bei `fullDays`) auf 0 (bei `zeroDays`). */
function linearDecay(days: number, fullDays: number, zeroDays: number): number {
  if (days <= fullDays) return 100;
  if (days >= zeroDays) return 0;
  return clamp01((zeroDays - days) / (zeroDays - fullDays)) * 100;
}

export function visitsScore(visits: number): number {
  if (visits <= 0) return 0;
  return clamp01(visits / SCORE_VISITS_FULL) * 100;
}

export function recencyScore(daysSinceLastVisit: number | null): number {
  if (daysSinceLastVisit === null) return 0;
  return linearDecay(daysSinceLastVisit, SCORE_RECENCY_FULL_DAYS, SCORE_RECENCY_ZERO_DAYS);
}

export function regularityScore(avgDaysBetweenVisits: number | null, visits: number): number {
  if (visits < 2 || avgDaysBetweenVisits === null || avgDaysBetweenVisits <= 0) return 0;
  return linearDecay(avgDaysBetweenVisits, SCORE_REGULARITY_FULL_DAYS, SCORE_REGULARITY_ZERO_DAYS);
}

export function partySizeScore(avgPartySize: number | null): number {
  if (avgPartySize === null || avgPartySize <= 0) return 0;
  return clamp01(avgPartySize / SCORE_PARTY_FULL) * 100;
}

/** Score-Stufe für die visuelle Einordnung. */
export function scoreTier(score: number): CrmScoreTier {
  if (score >= 90) return 'vip_potenzial';
  if (score >= 70) return 'hoch';
  if (score >= 40) return 'mittel';
  return 'niedrig';
}

/**
 * Berechnet den gewichteten CRM-Score (0–100) inkl. Teilkomponenten und Stufe.
 * Defensiv: ohne Besuche ergibt sich Score 0 (Stufe „niedrig").
 */
export function computeCrmScore(input: CrmScoreInput): CrmScore {
  const components: CrmScoreComponents = {
    visits: Math.round(visitsScore(input.visits)),
    recency: Math.round(recencyScore(input.daysSinceLastVisit)),
    regularity: Math.round(regularityScore(input.avgDaysBetweenVisits, input.visits)),
    partySize: Math.round(partySizeScore(input.avgPartySize)),
  };
  const weighted =
    visitsScore(input.visits) * CRM_SCORE_WEIGHTS.visits +
    recencyScore(input.daysSinceLastVisit) * CRM_SCORE_WEIGHTS.recency +
    regularityScore(input.avgDaysBetweenVisits, input.visits) * CRM_SCORE_WEIGHTS.regularity +
    partySizeScore(input.avgPartySize) * CRM_SCORE_WEIGHTS.partySize;
  const score = Math.round(weighted);
  return { score, tier: scoreTier(score), components };
}

/** Summe der Personen über alle ABGESCHLOSSENEN Besuche (defensiv: 0). */
export function totalPersonsOnVisits(
  reservations: ReadonlyArray<GuestReservationRecord>,
): number {
  let sum = 0;
  for (const r of reservations) {
    if (r.statusNormalized !== 'completed') continue;
    if (typeof r.partySize === 'number' && Number.isFinite(r.partySize)) sum += r.partySize;
  }
  return sum;
}

// ── Export der Reservierungshistorie (CSV + Excel) ─────────────────────────────

/** Spaltenüberschriften (deutsch) der Reservierungshistorie. */
export const RESERVATION_HISTORY_HEADERS: string[] = [
  'Datum',
  'Uhrzeit',
  'Personen',
  'Bereich',
  'Status',
  'Notiz',
];

/** Minimal benötigte Felder einer Reservation für den Export. */
export interface ReservationHistoryExportRow {
  reservationDate: string | null;
  reservationTime: string | null;
  partySize: number | null;
  room?: string | null;
  area?: string | null;
  statusNormalized: string;
  note?: string | null;
  comment?: string | null;
}

/**
 * Eine Reservation als typisierte Export-Zellen (Reihenfolge =
 * `RESERVATION_HISTORY_HEADERS`). Das Statuslabel wird übergeben, damit dieses
 * Modul DOM-/Seiten-frei und testbar bleibt.
 */
export function reservationHistoryRowToCells(
  r: ReservationHistoryExportRow,
  statusLabel: (status: string) => string,
): ExportCell[] {
  const bereich = [r.room, r.area].filter(Boolean).join(' · ');
  const notiz = [r.note, r.comment].filter(Boolean).join(' — ');
  return [
    isoToDate(r.reservationDate),
    r.reservationTime ?? null,
    r.partySize ?? null,
    bereich || null,
    statusLabel(r.statusNormalized),
    notiz || null,
  ];
}
