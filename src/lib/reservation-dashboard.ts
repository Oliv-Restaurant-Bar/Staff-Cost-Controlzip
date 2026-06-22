/**
 * Gäste-CRM — Dashboard-/Auswertungslogik (KEINE DB-Abhängigkeit)
 * ================================================================
 * Reine, testbare Berechnungen für die Seite „CRM Auswertung":
 *  - Gäste-Überblick (aktiv/inaktiv/neu/Wiederkehrerquote/Segmente/No-Show-Risiko)
 *  - Zukunftsreservationen (laufender/nächster Monat, nächste 30/60/90 Tage)
 *  - individueller Datumsbereich (Anzahl Reservationen + Personen)
 *
 * Statuslogik (vom Nutzer vorgegeben, case-insensitive auf `status_normalized`):
 *  - „aktiv" (relevant): confirmed, completed, seated, arrived, active
 *  - „offen / nicht beantwortet" (separat): pending, unknown, not_answered, offen
 *    (sowie alles, was weder aktiv noch ausgeschlossen ist → Auffangkorb)
 *  - „ausgeschlossen" (zählt NICHT): cancelled, canceled, storniert, no_show,
 *    noshow, rejected, abgelehnt
 *
 * Frei von Supabase/DOM, damit es als Unit ohne Datenbank getestet werden kann.
 * Datumswerte sind durchgehend ISO-Strings „yyyy-MM-dd" und werden lexikografisch
 * verglichen (korrekt für dieses Format).
 */

import {
  daysSince,
  INACTIVE_DAYS_THRESHOLD,
  type GuestListMetrics,
} from './reservation-crm';

// ── Schwellen ────────────────────────────────────────────────────────────────

/** „Aktiv": letzter abgeschlossener Besuch innerhalb dieser Tage (= INACTIVE_DAYS_THRESHOLD). */
export const ACTIVE_DAYS_THRESHOLD = INACTIVE_DAYS_THRESHOLD;
/** „Neukunde": erster abgeschlossener Besuch innerhalb dieser Tage. */
export const NEW_GUEST_DAYS = 30;
/** „No-Show-Risiko": mindestens so viele No-Shows. */
export const NO_SHOW_RISK_MIN = 2;

// ── Statuslogik ──────────────────────────────────────────────────────────────
// Vom Nutzer vorgegebene Status-Vokabularien. Vergleich case-insensitive und
// getrimmt, damit Rohwerte aus `status_normalized` robust erkannt werden.

/** Aktive / relevante Reservationen. */
const ACTIVE_STATUSES = new Set<string>([
  'confirmed', 'completed', 'seated', 'arrived', 'active',
]);

/** Offen / nicht beantwortet (separat ausweisen). */
const OPEN_STATUSES = new Set<string>([
  'pending', 'unknown', 'not_answered', 'offen',
]);

/** Ausgeschlossen (Storno / No-Show / abgelehnt) — zählt in keiner Kachel. */
const EXCLUDED_STATUSES = new Set<string>([
  'cancelled', 'canceled', 'storniert', 'no_show', 'noshow', 'rejected', 'abgelehnt',
]);

function statusKey(s: string): string {
  return s.trim().toLowerCase();
}

/** Aktive/relevante Reservation (confirmed, completed, seated, arrived, active). */
export function isActiveStatus(s: string): boolean {
  return ACTIVE_STATUSES.has(statusKey(s));
}

/** Ausgeschlossen: storniert/abgelehnt/No-Show — zählt nicht als Reservation. */
export function isExcludedStatus(s: string): boolean {
  return EXCLUDED_STATUSES.has(statusKey(s));
}

/**
 * Offen / nicht beantwortet: explizit gelistet (pending, unknown, not_answered,
 * offen) ODER alles, was weder aktiv noch ausgeschlossen ist (Auffangkorb, damit
 * keine Reservation verloren geht).  Wird stets separat von „aktiv" ausgewiesen.
 */
export function isOpenStatus(s: string): boolean {
  const k = statusKey(s);
  if (OPEN_STATUSES.has(k)) return true;
  return !ACTIVE_STATUSES.has(k) && !EXCLUDED_STATUSES.has(k);
}

// ── Reservations-Aggregatzeile (schlank, ohne PII) ───────────────────────────

/** Minimal benötigte Felder einer Reservation für die Auswertung (keine PII). */
export interface ReservationAggRow {
  date: string | null;                 // "yyyy-MM-dd"
  partySize: number | null;
  status: string;                      // roher `status_normalized`-Wert
}

// ── Zeitraum-Zählung ─────────────────────────────────────────────────────────

export interface RangeCount {
  reservations: number;
  persons: number;
}

/**
 * Zählt Reservationen und Personen im Datumsbereich [from, to] (beide inklusive),
 * gefiltert über ein Status-Prädikat.  Zeilen ohne Datum werden ignoriert; eine
 * unbekannte Personenzahl zählt als 0 Personen (aber als 1 Reservation).
 */
export function countInRange(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  statusFilter: (s: string) => boolean,
): RangeCount {
  let reservations = 0;
  let persons = 0;
  for (const r of rows) {
    if (!r.date) continue;
    const d = r.date.slice(0, 10);
    if (d < from || d > to) continue;
    if (!statusFilter(r.status)) continue;
    reservations++;
    persons += r.partySize ?? 0;
  }
  return { reservations, persons };
}

// ── Zukunftsreservationen ────────────────────────────────────────────────────

/** Datumsgrenzen für die Zukunfts-Kacheln (alle "yyyy-MM-dd"). */
export interface FutureBoundaries {
  today: string;
  endOfMonth: string;
  startNextMonth: string;
  endNextMonth: string;
  plus30: string;
  plus60: string;
  plus90: string;
}

export interface FutureReservationKpis {
  /** Aktive zukünftige Reservationen im laufenden Monat (ab heute). */
  currentMonth: RangeCount;
  /** Aktive zukünftige Reservationen im nächsten Kalendermonat. */
  nextMonth: RangeCount;
  next30: RangeCount;
  next60: RangeCount;
  next90: RangeCount;
  /** Offene / nicht beantwortete zukünftige Reservationen (nächste 90 Tage), separat. */
  openNext90: RangeCount;
}

/**
 * Berechnet alle Zukunfts-Kacheln aus den (bereits auf `date >= today`
 * gefilterten) Reservationen.  Aktive Kennzahlen nutzen `isActiveStatus`,
 * die Offen-Kachel nutzt `isOpenStatus`.
 */
export function futureReservationKpis(
  rows: ReservationAggRow[],
  b: FutureBoundaries,
): FutureReservationKpis {
  return {
    currentMonth: countInRange(rows, b.today, b.endOfMonth, isActiveStatus),
    nextMonth:    countInRange(rows, b.startNextMonth, b.endNextMonth, isActiveStatus),
    next30:       countInRange(rows, b.today, b.plus30, isActiveStatus),
    next60:       countInRange(rows, b.today, b.plus60, isActiveStatus),
    next90:       countInRange(rows, b.today, b.plus90, isActiveStatus),
    openNext90:   countInRange(rows, b.today, b.plus90, isOpenStatus),
  };
}

// ── Gäste-Überblick ──────────────────────────────────────────────────────────

export interface GuestDashboardKpis {
  totalGuests: number;
  /** Gäste mit abgeschlossenem Besuch innerhalb der letzten 90 Tage. */
  activeGuests: number;
  /** Gäste, deren letzter abgeschlossener Besuch älter als 90 Tage ist. */
  inactiveGuests: number;
  /** Gäste, deren erster abgeschlossener Besuch in den letzten 30 Tagen liegt. */
  newGuests30: number;
  /** Anteil Gäste mit ≥ 2 Besuchen an allen Gästen mit ≥ 1 Besuch (Prozent) — null wenn keiner. */
  repeatRatePct: number | null;
  /** Segment Stammgast (8–19 Besuche, aktiv). */
  stammgaeste: number;
  /** Segment VIP (≥ 20 Besuche, aktiv). */
  vipGuests: number;
  /** Gäste ohne abgeschlossenen Besuch. */
  guestsWithoutVisit: number;
  /** Gäste mit ≥ 2 No-Shows. */
  noShowRiskGuests: number;
}

/**
 * Verdichtet die Listen-Kennzahlen aller Gäste zu Dashboard-Kacheln.  „Aktiv"
 * und „inaktiv" beziehen sich rein auf den letzten abgeschlossenen Besuch
 * (unabhängig vom zahlbasierten Segment).  No-Show-Anzahlen kommen separat aus
 * `reservation_records` (nicht im Profil-Aggregat enthalten).
 */
export function guestDashboardKpis(
  metrics: GuestListMetrics[],
  noShowCounts: Map<string, number>,
  today: string,
): GuestDashboardKpis {
  let activeGuests = 0;
  let inactiveGuests = 0;
  let newGuests30 = 0;
  let withVisit = 0;
  let returning = 0;
  let stammgaeste = 0;
  let vipGuests = 0;
  let guestsWithoutVisit = 0;
  let noShowRiskGuests = 0;

  for (const m of metrics) {
    if (m.visits > 0) {
      withVisit++;
      if (m.visits >= 2) returning++;
      if (m.daysSinceLastVisit !== null) {
        if (m.daysSinceLastVisit <= ACTIVE_DAYS_THRESHOLD) activeGuests++;
        else inactiveGuests++;
      }
      const firstSince = daysSince(m.firstVisit, today);
      if (firstSince !== null && firstSince <= NEW_GUEST_DAYS) newGuests30++;
    } else {
      guestsWithoutVisit++;
    }

    if (m.segment === 'stammgast') stammgaeste++;
    if (m.segment === 'vip') vipGuests++;

    if ((noShowCounts.get(m.id) ?? 0) >= NO_SHOW_RISK_MIN) noShowRiskGuests++;
  }

  return {
    totalGuests: metrics.length,
    activeGuests,
    inactiveGuests,
    newGuests30,
    repeatRatePct: withVisit > 0 ? (returning / withVisit) * 100 : null,
    stammgaeste,
    vipGuests,
    guestsWithoutVisit,
    noShowRiskGuests,
  };
}
