/**
 * Gäste-CRM — reine Berechnungslogik (KEINE DB-Abhängigkeit)
 * ===========================================================
 * Leitet aus einem Gästeprofil (`guest_profiles`) und/oder dessen Reservationen
 * (`reservation_records`) die CRM-Kennzahlen und das Segment ab.  Bewusst frei
 * von Supabase/DOM, damit es als Unit ohne Datenbank getestet werden kann.
 *
 * Begriffsklärung (vom Nutzer bestätigt):
 *  - „Besuch“ = tatsächlich wahrgenommene, d. h. ABGESCHLOSSENE Reservation
 *    (status_normalized === 'completed').  Stornos und No-Shows zählen NICHT als
 *    Besuch.
 *  - „Ø Besuchsintervall“ = durchschnittliche Anzahl Tage zwischen zwei Besuchen
 *    = (letzter Besuch − erster Besuch) / (Besuche − 1); null bei < 2 Besuchen.
 *  - „Tage seit letztem Besuch“ = heute − letzter Besuch (nie negativ).
 *
 * Segment-Regeln:
 *  - VIP            ≥ 20 Besuche
 *  - Stammgast      8–19 Besuche
 *  - Wiederkehrend  3–7 Besuche
 *  - Neukunde       1–2 Besuche
 *  - Inaktiv        zuvor mind. wiederkehrend (≥ 3 Besuche), aber seit > 90 Tagen
 *                   kein Besuch mehr (überschreibt die zahlbasierten Segmente).
 *  - Ohne Besuch    0 Besuche (nur Reservationen ohne abgeschlossenen Besuch,
 *                   z. B. ausschliesslich Stornos/offene Buchungen).
 */

import type { ReservationStatusNormalized } from './reservation-import-parser';
import type { GuestCrmProfile } from './guest-crm-profile';

// ── Segmente ─────────────────────────────────────────────────────────────────

export type GuestSegment =
  | 'vip'
  | 'stammgast'
  | 'wiederkehrend'
  | 'neukunde'
  | 'inaktiv'
  | 'ohne_besuch';

/** Anzeigereihenfolge (geschäftliche Wichtigkeit). */
export const SEGMENT_ORDER: GuestSegment[] = [
  'vip',
  'stammgast',
  'wiederkehrend',
  'neukunde',
  'inaktiv',
  'ohne_besuch',
];

export const SEGMENT_LABEL: Record<GuestSegment, string> = {
  vip:           'VIP',
  stammgast:     'Stammgast',
  wiederkehrend: 'Wiederkehrend',
  neukunde:      'Neukunde',
  inaktiv:       'Inaktiv',
  ohne_besuch:   'Ohne Besuch',
};

/** Schwellen — zentral, damit Logik und Tests dieselben Werte nutzen. */
export const SEGMENT_VIP_MIN = 20;
export const SEGMENT_STAMMGAST_MIN = 8;
export const SEGMENT_WIEDERKEHREND_MIN = 3;
export const INACTIVE_DAYS_THRESHOLD = 90;
export const INACTIVE_MIN_VISITS = 3;

/**
 * Rückkehrpotenzial — Mindestanzahl früherer Besuche, damit das persönliche
 * Ø-Besuchsintervall belastbar ist (sonst ist die „Überfälligkeit" Rauschen).
 */
export const RETURN_RISK_MIN_VISITS = 3;
/**
 * Rückkehrpotenzial — ein Gast gilt als gefährdet/überfällig, sobald die Tage
 * seit dem letzten Besuch mindestens das Faktor-Fache seines persönlichen
 * Ø-Intervalls betragen.
 */
export const RETURN_RISK_FACTOR = 2;

// ── Eingabe-Typen (schlank, testbar) ─────────────────────────────────────────

/** Teilmenge von `guest_profiles` (snake_case wie in der DB). */
export interface GuestProfile {
  id: string;
  restaurant_id?: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mobile: string | null;
  first_seen_at: string | null;          // "yyyy-MM-dd"
  last_seen_at: string | null;           // "yyyy-MM-dd"
  total_reservations: number | null;
  total_persons: number | null;
  cancelled_reservations: number | null;
  completed_reservations: number | null;
}

/** Teilmenge von `reservation_records`, die die Detail-Kennzahlen benötigen. */
export interface GuestReservationRecord {
  reservationDate: string | null;        // "yyyy-MM-dd"
  reservationTime: string | null;        // "HH:mm"
  partySize: number | null;
  statusNormalized: ReservationStatusNormalized;
  room: string | null;
  area: string | null;
  note: string | null;
  comment: string | null;
}

// ── Datums-Helfer ────────────────────────────────────────────────────────────

function toDayNumber(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86400000);
}

/** Ganzzahlige Tagesdifferenz `to − from` (kann negativ sein) oder null. */
export function daysBetween(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  if (a === null || b === null) return null;
  return b - a;
}

/** Tage seit `date` bis `today` (nie negativ). null bei fehlendem/ungültigem Datum. */
export function daysSince(date: string | null | undefined, today: string): number | null {
  const d = daysBetween(date, today);
  if (d === null) return null;
  return d < 0 ? 0 : d;
}

/** Ø Tage zwischen Besuchen aus Spanne und Anzahl. null bei < 2 Besuchen. */
export function averageDaysBetweenVisits(
  firstVisit: string | null,
  lastVisit: string | null,
  visits: number,
): number | null {
  if (visits < 2) return null;
  const span = daysBetween(firstVisit, lastVisit);
  if (span === null || span <= 0) return null;
  return span / (visits - 1);
}

// ── Segmentierung ────────────────────────────────────────────────────────────

/**
 * Reines zahlbasiertes Segment (Tier) OHNE die Inaktiv-Überschreibung:
 * VIP ≥ 20, Stammgast 8–19, Wiederkehrend 3–7, Neukunde 1–2, sonst „ohne Besuch".
 * Wird für „gefährdete" hochwertige Gäste benötigt: deren Live-Segment kippt wegen
 * der Inaktiv-Regel evtl. schon auf „inaktiv", das Tier bleibt aber VIP/Stammgast.
 */
export function baseSegmentByVisits(visits: number): GuestSegment {
  if (visits <= 0) return 'ohne_besuch';
  if (visits >= SEGMENT_VIP_MIN) return 'vip';
  if (visits >= SEGMENT_STAMMGAST_MIN) return 'stammgast';
  if (visits >= SEGMENT_WIEDERKEHREND_MIN) return 'wiederkehrend';
  return 'neukunde';
}

/**
 * Bestimmt das Segment aus der Besuchszahl (abgeschlossene Reservationen) und
 * der Anzahl Tage seit dem letzten Besuch.  Die Inaktiv-Regel überschreibt die
 * zahlbasierten Segmente.
 */
export function classifySegment(
  visits: number,
  daysSinceLastVisit: number | null,
): GuestSegment {
  if (visits <= 0) return 'ohne_besuch';
  if (
    visits >= INACTIVE_MIN_VISITS &&
    daysSinceLastVisit !== null &&
    daysSinceLastVisit > INACTIVE_DAYS_THRESHOLD
  ) {
    return 'inaktiv';
  }
  return baseSegmentByVisits(visits);
}

// ── Anzeige-Name ─────────────────────────────────────────────────────────────

export function guestDisplayName(p: {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  mobile: string | null;
}): string {
  const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  if (name) return name;
  if (p.email) return p.email;
  if (p.mobile) return p.mobile;
  return 'Unbekannter Gast';
}

// ── Listen-Kennzahlen (aus dem Aggregat-Profil) ──────────────────────────────

export interface GuestListMetrics {
  id: string;
  displayName: string;
  email: string | null;
  mobile: string | null;
  /** Abgeschlossene Besuche. */
  visits: number;
  totalReservations: number;
  cancelledReservations: number;
  firstVisit: string | null;
  lastVisit: string | null;
  daysSinceLastVisit: number | null;
  avgDaysBetweenVisits: number | null;
  /** Ø Gruppengrösse über die abgeschlossenen Besuche (null, wenn unbekannt). */
  avgPartySize: number | null;
  /** Anzahl No-Shows des Gastes (für No-Show-Risiko-Filter). */
  noShowCount: number;
  segment: GuestSegment;
  /**
   * Manuell gepflegtes CRM-Profil (guest_crm_profiles) — rein additive, von der
   * automatischen Segmentierung/Score-Berechnung STRIKT getrennte Information.
   * Optional: fehlt es (noch kein Profil / nicht geladen), gelten alle manuellen
   * Merkmale als „nicht gesetzt".  Wird NIE in classifySegment/computeCrmScore
   * zurückgeführt.
   */
  crm?: GuestCrmProfile | null;
}

/**
 * Aus den ABGESCHLOSSENEN Reservationen abgeleitete Besuchs-Eckwerte eines
 * Gastes.  Wird der Liste übergeben, damit Besuchszahl, erster/letzter Besuch,
 * Intervall und Segment exakt mit der Detailseite übereinstimmen.
 */
export interface CompletedVisitAgg {
  /** Anzahl abgeschlossener Besuche. */
  visits: number;
  /** Datum des ersten abgeschlossenen Besuchs ("yyyy-MM-dd") oder null. */
  firstVisit: string | null;
  /** Datum des letzten abgeschlossenen Besuchs ("yyyy-MM-dd") oder null. */
  lastVisit: string | null;
  /**
   * Ø Gruppengrösse über die abgeschlossenen Besuche mit bekannter Personenzahl
   * (null, wenn keine Personenzahl bekannt ist).  Optional, damit bestehende
   * Aufrufer/Tests, die das Feld nicht setzen, unverändert funktionieren.
   */
  avgPartySize?: number | null;
}

/**
 * Berechnet die Listen-Kennzahlen.  Besuchszahl, erster/letzter Besuch und damit
 * Intervall + Segment stammen aus den ABGESCHLOSSENEN Reservationen (`visitAgg`),
 * NICHT aus first_seen_at/last_seen_at des Profils (die alle Status umfassen).
 * So zeigt die Liste exakt dieselben Werte wie die Detailseite.  Fehlt `visitAgg`
 * (kein abgeschlossener Besuch), gilt der Gast als „ohne Besuch“.  total/cancelled
 * stammen weiterhin aus den günstigen Profil-Aggregaten (reine Infofelder, fliessen
 * nicht in die Segmentierung ein).
 */
export function guestListMetrics(
  profile: GuestProfile,
  visitAgg: CompletedVisitAgg | undefined,
  today: string,
  noShowCount = 0,
  crm: GuestCrmProfile | null = null,
): GuestListMetrics {
  const visits = visitAgg?.visits ?? 0;
  const firstVisit = visitAgg?.firstVisit ?? null;
  const lastVisit = visitAgg?.lastVisit ?? null;
  const daysSinceLastVisit = daysSince(lastVisit, today);
  return {
    id: profile.id,
    displayName: guestDisplayName(profile),
    email: profile.email,
    mobile: profile.mobile,
    visits,
    totalReservations: profile.total_reservations ?? 0,
    cancelledReservations: profile.cancelled_reservations ?? 0,
    firstVisit,
    lastVisit,
    daysSinceLastVisit,
    avgDaysBetweenVisits: averageDaysBetweenVisits(firstVisit, lastVisit, visits),
    avgPartySize: visitAgg?.avgPartySize ?? null,
    noShowCount: noShowCount < 0 ? 0 : noShowCount,
    segment: classifySegment(visits, daysSinceLastVisit),
    crm: crm ?? null,
  };
}

// ── Detail-Kennzahlen (aus den Einzelreservationen) ──────────────────────────

export interface GuestDetailMetrics {
  /** Abgeschlossene Besuche. */
  visits: number;
  totalReservations: number;
  completedCount: number;
  cancelledCount: number;
  noShowCount: number;
  firstVisit: string | null;
  lastVisit: string | null;
  daysSinceLastVisit: number | null;
  avgDaysBetweenVisits: number | null;
  avgPartySize: number | null;
  segment: GuestSegment;
}

/**
 * Berechnet die exakten Detail-Kennzahlen direkt aus den Reservationen eines
 * Gastes.  Besuche = abgeschlossene Reservationen; Ø Gruppengrösse über die
 * abgeschlossenen Reservationen mit bekannter Personenzahl.
 */
export function guestDetailMetrics(
  reservations: GuestReservationRecord[],
  today: string,
): GuestDetailMetrics {
  const completed = reservations.filter(r => r.statusNormalized === 'completed');
  const cancelledCount = reservations.filter(r => r.statusNormalized === 'cancelled').length;
  const noShowCount = reservations.filter(r => r.statusNormalized === 'noshow').length;

  const completedDates = completed
    .map(r => r.reservationDate)
    .filter((d): d is string => !!d)
    .sort((a, b) => a.localeCompare(b));

  const visits = completed.length;
  const firstVisit = completedDates[0] ?? null;
  const lastVisit = completedDates.length ? completedDates[completedDates.length - 1] : null;
  const daysSinceLastVisit = daysSince(lastVisit, today);

  const sizes = completed
    .map(r => r.partySize)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const avgPartySize = sizes.length ? sizes.reduce((s, n) => s + n, 0) / sizes.length : null;

  return {
    visits,
    totalReservations: reservations.length,
    completedCount: visits,
    cancelledCount,
    noShowCount,
    firstVisit,
    lastVisit,
    daysSinceLastVisit,
    avgDaysBetweenVisits: averageDaysBetweenVisits(firstVisit, lastVisit, visits),
    avgPartySize,
    segment: classifySegment(visits, daysSinceLastVisit),
  };
}

/**
 * Adapter: baut aus einem Profil + den Detail-Kennzahlen ein vollständiges
 * `GuestListMetrics`.  Damit kann die Detailseite die bestehende, getestete
 * Rückkehrpotenzial-Logik (overdueByDays/isOverdue/isAtRiskTier) wiederverwenden,
 * ohne das Objekt von Hand zusammenzusetzen (kein Typ-Drift auf Seitenebene).
 */
export function guestListMetricsFromDetail(
  profile: GuestProfile,
  m: GuestDetailMetrics,
): GuestListMetrics {
  return {
    id: profile.id,
    displayName: guestDisplayName(profile),
    email: profile.email,
    mobile: profile.mobile,
    visits: m.visits,
    totalReservations: m.totalReservations,
    cancelledReservations: m.cancelledCount,
    firstVisit: m.firstVisit,
    lastVisit: m.lastVisit,
    daysSinceLastVisit: m.daysSinceLastVisit,
    avgDaysBetweenVisits: m.avgDaysBetweenVisits,
    avgPartySize: m.avgPartySize,
    noShowCount: m.noShowCount,
    segment: m.segment,
  };
}

// ── Rückkehrpotenzial (gefährdete Stammgäste) ────────────────────────────────

/** Minimal benötigte Kennzahlen zur Beurteilung des Rückkehrpotenzials. */
export interface ReturnRiskInput {
  /** Abgeschlossene Besuche. */
  visits: number;
  daysSinceLastVisit: number | null;
  avgDaysBetweenVisits: number | null;
}

/**
 * „Überfälligkeits-Quote" = Tage seit letztem Besuch ÷ persönliches Ø-Intervall.
 * 1.0 bedeutet „genau im erwarteten Rhythmus fällig", 2.0 „doppelt so lange weg
 * wie üblich".  Liefert null, wenn der Gast zu wenige Besuche (< RETURN_RISK_MIN_VISITS)
 * für ein belastbares Intervall hat oder Kennzahlen fehlen/unbrauchbar sind.
 */
export function returnRiskRatio(m: ReturnRiskInput): number | null {
  if (m.visits < RETURN_RISK_MIN_VISITS) return null;
  if (m.daysSinceLastVisit === null || m.avgDaysBetweenVisits === null) return null;
  if (m.avgDaysBetweenVisits <= 0) return null;
  return m.daysSinceLastVisit / m.avgDaysBetweenVisits;
}

/**
 * Gefährdeter Stammgast mit Rückkehrpotenzial: genügend frühere Besuche UND
 * Tage seit letztem Besuch ≥ RETURN_RISK_FACTOR × persönliches Ø-Intervall.
 * Bewusst unabhängig vom zahlbasierten Segment — erfasst auch (noch) nicht
 * „inaktive" Gäste, die früh aus ihrem gewohnten Rhythmus fallen.
 */
export function isAtReturnRisk(m: ReturnRiskInput): boolean {
  const r = returnRiskRatio(m);
  return r !== null && r >= RETURN_RISK_FACTOR;
}

/** Zählt die Segmente einer Gästeliste (für Übersichts-Kacheln). */
export function countSegments(metrics: GuestListMetrics[]): Record<GuestSegment, number> {
  const out: Record<GuestSegment, number> = {
    vip: 0, stammgast: 0, wiederkehrend: 0, neukunde: 0, inaktiv: 0, ohne_besuch: 0,
  };
  for (const m of metrics) out[m.segment]++;
  return out;
}
