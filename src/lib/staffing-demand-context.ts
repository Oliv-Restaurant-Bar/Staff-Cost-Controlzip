/**
 * staffing-demand-context — Reservationszahlen als Nachfrage-Kontext für den
 * Personalbedarf-SOLL/Ist-Abgleich (NUR Anzeige).
 *
 * Beantwortet für einen geprüften Tag: Wie viele Personen/Reservationen sind
 * gebucht, und wie liegt das im Vergleich zum Ø der letzten k Vorkommen
 * desselben Wochentags? Ändert KEINE Plan-/Kosten-/Overtime-Daten und führt
 * keine eigene Umsatzquelle.
 *
 * Rein (DOM-/Supabase-frei): Eingabe sind bereits geladene, mandantengefilterte
 * Aggregatzeilen ohne PII ({date, partySize, status}).
 *
 * Ø-Semantik: Der Durchschnitt läuft über ALLE k Lookback-Vorkommen — auch
 * solche ohne Reservationen (0 zählt mit). Schliesstage drücken den Ø also
 * bewusst; `occurrencesWithData` erlaubt der UI einen „wenig Vergleichsdaten"-
 * Hinweis. Die Saison der Bedarfs-Definition hat bewusst KEINEN Einfluss.
 */

import {
  isoWeekdayOf,
  statusPredicate,
  type IsoWeekday,
  type StatusScope,
} from './reservation-weekday-analytics';

/** Anzahl betrachteter früherer Vorkommen desselben Wochentags (~8 Wochen). */
export const LOOKBACK_OCCURRENCES = 8;

/** Minimal benötigte Reservations-Zeile (keine PII). */
export interface DemandContextRow {
  date: string | null;      // "yyyy-MM-dd"
  partySize: number | null;
  status: string;
}

/** Rohe Zählung eines Tages. */
interface DayCount {
  reservations: number;
  persons: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "yyyy-MM-dd" ± n Tage — UTC-Arithmetik, keine Zeitzonen-Verschiebung. */
function addDaysIso(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Die k Vorkommen desselben Wochentags STRIKT vor `targetDate`, aufsteigend
 * (ältestes zuerst). Leer bei ungültigem Datum.
 */
export function lookbackDates(targetDate: string, k: number = LOOKBACK_OCCURRENCES): string[] {
  if (!ISO_DATE_RE.test(targetDate) || k <= 0) return [];
  const out: string[] = [];
  for (let i = k; i >= 1; i--) out.push(addDaysIso(targetDate, -7 * i));
  return out;
}

/** Ergebnis des Nachfrage-Kontexts für einen Tag. */
export interface DayDemandContext {
  date: string;
  weekday: IsoWeekday;
  /** „Erwartet" (Zieltag heute/zukünftig) oder „war gebucht" (Vergangenheit). */
  kind: 'expected' | 'past';
  dayReservations: number;
  dayPersons: number;
  /** Ø je Lookback-Vorkommen (inkl. 0-Tage); null ohne Lookback-Vorkommen. */
  avgReservations: number | null;
  avgPersons: number | null;
  /** Abweichung des Tages vom Ø in % (+ = über Ø); null wenn Ø 0/fehlt. */
  pctDiffReservations: number | null;
  pctDiffPersons: number | null;
  /** Anzahl betrachteter Lookback-Vorkommen (= k). */
  occurrences: number;
  /** Davon Vorkommen mit mindestens einer gezählten Reservation. */
  occurrencesWithData: number;
}

export interface BuildDayDemandContextArgs {
  /** Aggregatzeilen (mandantengefiltert geladen); dürfen mehr Tage enthalten. */
  rows: readonly DemandContextRow[];
  /** Geprüfter Tag "yyyy-MM-dd". */
  targetDate: string;
  /** Heutiges Datum "yyyy-MM-dd" — als Parameter, damit deterministisch testbar. */
  today: string;
  /** Status-Sicht; Default 'booked' (gebuchte Reservationen). */
  scope?: StatusScope;
  /** Lookback-Fenster; Default LOOKBACK_OCCURRENCES. */
  k?: number;
}

function pctDiff(day: number, avg: number | null): number | null {
  if (avg === null || avg === 0) return null;
  return ((day - avg) / avg) * 100;
}

/**
 * Baut den Nachfrage-Kontext für einen Tag. null bei ungültigem Zieldatum.
 * Zeilen ausserhalb von Zieltag/Lookback-Terminen werden ignoriert; eine
 * Reservation ohne Personenzahl zählt als 1 Reservation / 0 Personen.
 */
export function buildDayDemandContext(
  args: BuildDayDemandContextArgs,
): DayDemandContext | null {
  const { targetDate, today } = args;
  const weekday = isoWeekdayOf(targetDate);
  if (!ISO_DATE_RE.test(targetDate) || weekday === null) return null;

  const k = args.k ?? LOOKBACK_OCCURRENCES;
  const pred = statusPredicate(args.scope ?? 'booked');
  const lookback = lookbackDates(targetDate, k);
  const wanted = new Map<string, DayCount>();
  wanted.set(targetDate, { reservations: 0, persons: 0 });
  for (const d of lookback) wanted.set(d, { reservations: 0, persons: 0 });

  for (const row of args.rows) {
    const d = row.date ? row.date.slice(0, 10) : null;
    if (!d) continue;
    const bucket = wanted.get(d);
    if (!bucket) continue;
    if (!pred(row.status)) continue;
    bucket.reservations += 1;
    bucket.persons += row.partySize ?? 0;
  }

  const day = wanted.get(targetDate)!;
  let sumRes = 0;
  let sumPers = 0;
  let withData = 0;
  for (const d of lookback) {
    const b = wanted.get(d)!;
    sumRes += b.reservations;
    sumPers += b.persons;
    if (b.reservations > 0) withData += 1;
  }
  const avgReservations = lookback.length > 0 ? sumRes / lookback.length : null;
  const avgPersons = lookback.length > 0 ? sumPers / lookback.length : null;

  return {
    date: targetDate,
    weekday,
    kind: targetDate < today ? 'past' : 'expected',
    dayReservations: day.reservations,
    dayPersons: day.persons,
    avgReservations,
    avgPersons,
    pctDiffReservations: pctDiff(day.reservations, avgReservations),
    pctDiffPersons: pctDiff(day.persons, avgPersons),
    occurrences: lookback.length,
    occurrencesWithData: withData,
  };
}

/** Frühestes benötigtes Ladedatum (ältestes Lookback-Vorkommen); null bei ungültigem Datum. */
export function demandContextLoadFrom(
  targetDate: string,
  k: number = LOOKBACK_OCCURRENCES,
): string | null {
  const dates = lookbackDates(targetDate, k);
  return dates.length > 0 ? dates[0] : null;
}
