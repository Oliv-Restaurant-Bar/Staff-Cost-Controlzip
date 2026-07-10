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

import { isoToDate, type ExportCell } from './export-cell';
import {
  daysSince,
  isAtReturnRisk,
  INACTIVE_DAYS_THRESHOLD,
  baseSegmentByVisits,
  type GuestListMetrics,
  type GuestSegment,
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

// ── Tagesaggregation (Kalenderübersicht) ─────────────────────────────────────

/** Aggregat eines einzelnen Kalendertags (keine PII). */
export interface DayAggregate {
  /** "yyyy-MM-dd". */
  date: string;
  reservations: number;
  persons: number;
}

/** "yyyy-MM-dd" + n Tage (UTC-Arithmetik, DST-sicher) → "yyyy-MM-dd". */
export function addIsoDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Aggregiert Reservationen je Kalendertag im Bereich [from, to] (beide inkl.),
 * gefiltert über ein Status-Prädikat.  Enthält AUCH Nulltage (0 Reservationen),
 * damit die Kalenderübersicht lückenlos ist.  Verwendet dieselbe Datums-,
 * Status- und Personen-Zähllogik wie `countInRange` → über denselben Bereich
 * gilt garantiert:  Σ days.reservations === countInRange(…).reservations  und
 * Σ days.persons === countInRange(…).persons.
 *
 * Zeilen ohne Datum werden ignoriert; unbekannte Personenzahl zählt als 0
 * Personen (aber 1 Reservation) — exakt wie `countInRange`.  Tage sind
 * chronologisch aufsteigend sortiert.
 */
export function aggregateReservationsByDay(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  statusFilter: (s: string) => boolean,
): DayAggregate[] {
  if (!from || !to || from > to) return [];
  // Alle Kalendertage im Bereich vorbelegen, damit Nulltage erhalten bleiben.
  const byDate = new Map<string, DayAggregate>();
  for (let d = from.slice(0, 10); d <= to; d = addIsoDays(d, 1)) {
    byDate.set(d, { date: d, reservations: 0, persons: 0 });
  }
  for (const r of rows) {
    if (!r.date) continue;
    const d = r.date.slice(0, 10);
    const bucket = byDate.get(d);
    if (!bucket) continue; // ausserhalb [from, to]
    if (!statusFilter(r.status)) continue;
    bucket.reservations++;
    bucket.persons += r.partySize ?? 0;
  }
  return [...byDate.values()];
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

// ── Detailzeilen für klickbare Kacheln (Teil 1 & 2) ──────────────────────────
// Erweitert die schlanke Aggregatzeile um Anzeigefelder. Die Zähl-Prädikate
// (countInRange/futureReservationKpis) lesen NUR die Aggregatfelder, daher
// stimmen Kachelzahl und Detaillistenlänge exakt überein, wenn beide aus
// demselben Array berechnet werden.

/** Reservations-Detailzeile (Aggregatfelder + Anzeigefelder für die Detailliste). */
export interface ReservationDetailRow extends ReservationAggRow {
  id: string;
  guestId: string | null;
  displayName: string;
  time: string | null;      // "HH:mm"
  room: string | null;
  area: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  note: string | null;
}

/** Auswählbare Zukunfts-Kachel. */
export type FutureSelectionKey =
  | 'currentMonth' | 'nextMonth' | 'next30' | 'next60' | 'next90' | 'openNext90';

/** Aktiv/Offen-Auswahl im individuellen Zeitraum. */
export type RangeSelectionKind = 'active' | 'open';

/**
 * [from, to] + Status-Prädikat einer Zukunfts-Kachel — EXAKT identisch zu den in
 * `futureReservationKpis` verwendeten Grenzen/Prädikaten, damit die Detailliste
 * genau die gezählten Reservationen enthält.
 */
export function futureSelectionBounds(
  b: FutureBoundaries,
  key: FutureSelectionKey,
): { from: string; to: string; filter: (s: string) => boolean } {
  switch (key) {
    case 'currentMonth': return { from: b.today,          to: b.endOfMonth,   filter: isActiveStatus };
    case 'nextMonth':    return { from: b.startNextMonth, to: b.endNextMonth, filter: isActiveStatus };
    case 'next30':       return { from: b.today,          to: b.plus30,       filter: isActiveStatus };
    case 'next60':       return { from: b.today,          to: b.plus60,       filter: isActiveStatus };
    case 'next90':       return { from: b.today,          to: b.plus90,       filter: isActiveStatus };
    case 'openNext90':   return { from: b.today,          to: b.plus90,       filter: isOpenStatus };
  }
}

/** Späteste Datumsgrenze aller Zukunfts-Kacheln (begrenzt die Detail-Abfrage). */
export function maxFutureBoundary(b: FutureBoundaries): string {
  return [b.endOfMonth, b.endNextMonth, b.plus30, b.plus60, b.plus90]
    .reduce((max, d) => (d > max ? d : max), b.today);
}

/** "HH:mm" → Minuten seit Mitternacht; leer/ungültig → +∞ (ans Ende sortieren). */
function timeToMinutes(t: string | null): number {
  if (!t) return Number.POSITIVE_INFINITY;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Filtert Detailzeilen EXAKT wie `countInRange` (Datum in [from, to] inkl.,
 * Status-Prädikat) und sortiert „nächste zuerst, dann chronologisch aufsteigend":
 * Datum aufsteigend, dann Uhrzeit aufsteigend (leere Uhrzeit zuletzt), dann id.
 */
export function filterReservationDetails<T extends ReservationDetailRow>(
  rows: T[],
  from: string,
  to: string,
  statusFilter: (s: string) => boolean,
): T[] {
  const out = rows.filter(r => {
    if (!r.date) return false;
    const d = r.date.slice(0, 10);
    if (d < from || d > to) return false;
    return statusFilter(r.status);
  });
  out.sort((a, b) => {
    const da = (a.date ?? '').slice(0, 10);
    const db = (b.date ?? '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    const ta = timeToMinutes(a.time);
    const tb = timeToMinutes(b.time);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/** Detailliste einer Zukunfts-Kachel (gleicher Filter wie die Kachelzahl). */
export function futureReservationList<T extends ReservationDetailRow>(
  rows: T[],
  b: FutureBoundaries,
  key: FutureSelectionKey,
): T[] {
  const { from, to, filter } = futureSelectionBounds(b, key);
  return filterReservationDetails(rows, from, to, filter);
}

/** Detailliste für den individuellen Zeitraum (aktiv bzw. offen). */
export function rangeReservationList<T extends ReservationDetailRow>(
  rows: T[],
  from: string,
  to: string,
  kind: RangeSelectionKind,
): T[] {
  return filterReservationDetails(rows, from, to, kind === 'active' ? isActiveStatus : isOpenStatus);
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
  /**
   * Gefährdete Stammgäste mit Rückkehrpotenzial: genügend frühere Besuche und
   * überfällig ggü. dem persönlichen Ø-Besuchsintervall (siehe isAtReturnRisk).
   */
  returnRiskGuests: number;
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
  let returnRiskGuests = 0;

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
    if (isAtReturnRisk(m)) returnRiskGuests++;
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
    returnRiskGuests,
  };
}

// ── Rückkehrpotenzial & gefährdete Stammgäste ────────────────────────────────
// Reine Berechnung auf den bereits vorhandenen Listen-Kennzahlen (GuestListMetrics).
// Keine neue DB-Abfrage, keine Migration, keine Änderung an der Import-Logik.

/**
 * Faktor auf das Ø-Besuchsintervall, ab dem ein Gast als „überfällig" gilt:
 * Tage seit letztem Besuch > Ø-Intervall × Faktor.
 */
export const OVERDUE_INTERVAL_FACTOR = 1.5;

/**
 * Tage, um die ein Gast über der Überfällig-Schwelle (Ø-Intervall × Faktor)
 * liegt.  Positiv ⟺ überfällig; 0/negativ ⟺ (noch) im gewohnten Rhythmus.
 * null, wenn kein Ø-Intervall (< 2 Besuche) oder kein letzter Besuch bekannt ist.
 */
export function overdueByDays(m: GuestListMetrics): number | null {
  // Überfälligkeit setzt mindestens zwei Besuche (≥1 Intervall) voraus; ohne
  // positives Ø-Intervall gibt es keine Erwartungshaltung, die überschritten
  // werden könnte. Guard hier, damit die reine Funktion unabhängig vom Aufrufer
  // korrekt ist.
  if (
    m.daysSinceLastVisit === null ||
    m.avgDaysBetweenVisits === null ||
    m.avgDaysBetweenVisits <= 0 ||
    m.visits < 2
  ) return null;
  return m.daysSinceLastVisit - m.avgDaysBetweenVisits * OVERDUE_INTERVAL_FACTOR;
}

/** Überfällig: Tage seit letztem Besuch > Ø-Intervall × Faktor (1,5). */
export function isOverdue(m: GuestListMetrics): boolean {
  const o = overdueByDays(m);
  return o !== null && o > 0;
}

/**
 * „Gefährdet" für ein hochwertiges Tier: Der Gast gehört nach Besuchszahl zum
 * angegebenen Tier (Stammgast oder VIP) UND war seit mehr als 90 Tagen nicht
 * mehr da.  Bewusst wird das zahlbasierte Tier (`baseSegmentByVisits`) geprüft,
 * NICHT das Live-Segment — denn dieses ist bei > 90 Tagen bereits auf „inaktiv"
 * gekippt, obwohl es sich nach wie vor um einen wertvollen Stammgast/VIP handelt.
 */
export function isAtRiskTier(m: GuestListMetrics, tier: 'stammgast' | 'vip'): boolean {
  if (m.daysSinceLastVisit === null || m.daysSinceLastVisit <= INACTIVE_DAYS_THRESHOLD) {
    return false;
  }
  return baseSegmentByVisits(m.visits) === tier;
}

export interface ReturnPotentialKpis {
  /** Überfällige Gäste (Tage seit letztem Besuch > Ø-Intervall × 1,5). */
  overdueGuests: number;
  /** Gefährdete Stammgäste (Stammgast-Tier, > 90 Tage kein Besuch). */
  atRiskStammgaeste: number;
  /** Gefährdete VIP-Gäste (VIP-Tier, > 90 Tage kein Besuch). */
  atRiskVips: number;
}

/** Verdichtet die Listen-Kennzahlen zu den Rückkehrpotenzial-Kacheln. */
export function returnPotentialKpis(metrics: GuestListMetrics[]): ReturnPotentialKpis {
  let overdueGuests = 0;
  let atRiskStammgaeste = 0;
  let atRiskVips = 0;
  for (const m of metrics) {
    if (isOverdue(m)) overdueGuests++;
    if (isAtRiskTier(m, 'stammgast')) atRiskStammgaeste++;
    if (isAtRiskTier(m, 'vip')) atRiskVips++;
  }
  return { overdueGuests, atRiskStammgaeste, atRiskVips };
}

/** Eine Zeile der „Rückkehrpotenzial"-Liste (nur überfällige Gäste). */
export interface ReturnPotentialRow {
  id: string;
  displayName: string;
  segment: GuestSegment;
  visits: number;
  avgDaysBetweenVisits: number | null;
  lastVisit: string | null;
  daysSinceLastVisit: number | null;
  /** Tage über der Überfällig-Schwelle (immer > 0). */
  overdueByDays: number;
}

/**
 * Baut die „Rückkehrpotenzial"-Liste: alle überfälligen Gäste, sortiert nach den
 * überfälligsten zuerst (overdueByDays absteigend; bei Gleichstand Tage seit
 * letztem Besuch absteigend).
 */
export function buildReturnPotentialList(metrics: GuestListMetrics[]): ReturnPotentialRow[] {
  const rows: ReturnPotentialRow[] = [];
  for (const m of metrics) {
    const o = overdueByDays(m);
    if (o === null || o <= 0) continue;
    rows.push({
      id: m.id,
      displayName: m.displayName,
      segment: m.segment,
      visits: m.visits,
      avgDaysBetweenVisits: m.avgDaysBetweenVisits,
      lastVisit: m.lastVisit,
      daysSinceLastVisit: m.daysSinceLastVisit,
      overdueByDays: o,
    });
  }
  rows.sort((a, b) =>
    b.overdueByDays - a.overdueByDays ||
    (b.daysSinceLastVisit ?? 0) - (a.daysSinceLastVisit ?? 0),
  );
  return rows;
}

// ── Export der Rückkehrpotenzial-Liste (CSV + Excel) ───────────────────────────

/** Spaltenüberschriften (deutsch) der Rückkehrpotenzial-Liste. */
export const RETURN_POTENTIAL_HEADERS: string[] = [
  'Gast',
  'Segment',
  'Besuche',
  'Ø Intervall (Tage)',
  'Letzter Besuch',
  'Tage seit letztem',
  'Überfällig seit (Tage)',
];

/**
 * Eine Rückkehrpotenzial-Zeile als typisierte Export-Zellen (Reihenfolge =
 * `RETURN_POTENTIAL_HEADERS`). Das Segmentlabel wird übergeben, damit dieses
 * Modul frei von Label-/UI-Abhängigkeiten bleibt.
 */
export function returnPotentialRowToCells(
  r: ReturnPotentialRow,
  segmentLabel: (segment: GuestSegment) => string,
): ExportCell[] {
  return [
    r.displayName,
    segmentLabel(r.segment),
    r.visits,
    r.avgDaysBetweenVisits === null ? null : Math.round(r.avgDaysBetweenVisits),
    isoToDate(r.lastVisit),
    r.daysSinceLastVisit,
    Math.round(r.overdueByDays),
  ];
}
