/**
 * Reservationen nach Wochentag — reine Auswertungslogik (ohne DB/DOM)
 * ====================================================================
 * Berechnet aus den bestehenden Reservationen (`reservation_records`, schlanke
 * Form `ReservationAggRow`) Wochentags-Kennzahlen für einen frei wählbaren
 * Zeitraum:
 *
 *  - je Wochentag (Mo–So): Anzahl Reservationen, Anzahl Personen,
 *    Ø Personen/Reservation und Anteil am Gesamtzeitraum in %.
 *  - Matrix „Wochentage nach Monat" (Zeile = Monat, Spalte = Wochentag) mit
 *    Reservationen + Personen je Zelle sowie Zeilen-/Spalten-/Gesamtsummen.
 *  - Zusammenfassung: stärkster/schwächster Wochentag sowie bester/schwächster
 *    Monat für einen Fokus-Wochentag.
 *  - Schnell-Auswahl / Saison-Zeiträume (frei anpassbar, ohne neue DB-Tabelle).
 *
 * Frei von Supabase/DOM (nur `import type` + die reinen Status-Prädikate aus
 * `reservation-dashboard`), damit es als Unit ohne Datenbank getestet werden
 * kann. Datumswerte sind durchgehend ISO-Strings „yyyy-MM-dd" und werden
 * lexikografisch verglichen (für dieses Format korrekt).
 *
 * KEINE neue Tabelle, KEINE Migration, KEINE Schreiboperation — reine Anzeige.
 */

import { isActiveStatus, isExcludedStatus } from './reservation-dashboard';
import type { ReservationAggRow } from './reservation-dashboard';

// ── Wochentage (ISO Mo=1 … So=7) ─────────────────────────────────────────────

export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

export const WEEKDAY_LABEL: Record<IsoWeekday, string> = {
  1: 'Montag',
  2: 'Dienstag',
  3: 'Mittwoch',
  4: 'Donnerstag',
  5: 'Freitag',
  6: 'Samstag',
  7: 'Sonntag',
};

export const WEEKDAY_SHORT: Record<IsoWeekday, string> = {
  1: 'Mo',
  2: 'Di',
  3: 'Mi',
  4: 'Do',
  5: 'Fr',
  6: 'Sa',
  7: 'So',
};

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];
const MONTH_LONG = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ── Datums-Helfer (rein, UTC-basiert → keine Zeitzonen-Verschiebung) ──────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Letzter Tag eines Monats (m = 1..12). */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * ISO-Wochentag (1=Mo … 7=So) eines „yyyy-MM-dd"-Datums oder `null` bei
 * fehlendem/ungültigem Datum (inkl. nicht existierender Tage wie 2025-02-30).
 */
export function isoWeekdayOf(dateStr: string | null | undefined): IsoWeekday | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  const dow = dt.getUTCDay(); // 0=So … 6=Sa
  return (dow === 0 ? 7 : dow) as IsoWeekday;
}

/** Monatsschlüssel „yyyy-MM" eines Datums oder `null`. */
export function monthKeyOf(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})/.exec(dateStr);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Kurzes Monatslabel, z. B. „Okt 2025". */
export function monthLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const idx = +m[2] - 1;
  return `${MONTH_SHORT[idx] ?? m[2]} ${m[1]}`;
}

/** Langes Monatslabel, z. B. „Oktober 2025". */
export function monthLongLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const idx = +m[2] - 1;
  return `${MONTH_LONG[idx] ?? m[2]} ${m[1]}`;
}

// ── Wochentags-Vorkommen im Zeitraum ─────────────────────────────────────────

/** Parst „yyyy-MM-dd" (optionaler Zeitanhang) als UTC-`Date` oder `null`. */
function parseYmdToUtc(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

function zeroWeekdayCounts(): Record<IsoWeekday, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
}

const MS_PER_DAY = 86_400_000;

/**
 * Zählt, wie oft jeder ISO-Wochentag (Mo=1 … So=7) im Zeitraum [from, to]
 * (inklusive) vorkommt — z. B. „wie viele Montage liegen im Juni?".  Liefert bei
 * ungültigem/leerem Bereich (oder from > to) alle 0.  Rein UTC-basiert (keine
 * Zeitzonen-/DST-Verschiebung), iteriert tageweise.
 */
export function countWeekdayOccurrences(from: string, to: string): Record<IsoWeekday, number> {
  const counts = zeroWeekdayCounts();
  const start = parseYmdToUtc(from);
  const end = parseYmdToUtc(to);
  if (!start || !end) return counts;
  const startT = start.getTime();
  const endT = end.getTime();
  if (startT > endT) return counts;
  for (let t = startT; t <= endT; t += MS_PER_DAY) {
    const dow = new Date(t).getUTCDay(); // 0=So … 6=Sa
    const iso = (dow === 0 ? 7 : dow) as IsoWeekday;
    counts[iso] += 1;
  }
  return counts;
}

/**
 * Wie `countWeekdayOccurrences`, aber begrenzt auf die Schnittmenge eines Monats
 * („yyyy-MM") mit dem Zeitraum [from, to].  So werden bei einem Zeitraum, der
 * mitten im Monat beginnt/endet, nur die tatsächlich enthaltenen Wochentage
 * gezählt.  Ungültiger Monatsschlüssel → alle 0.
 */
export function countWeekdayOccurrencesInMonth(
  monthKey: string,
  from: string,
  to: string,
): Record<IsoWeekday, number> {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return zeroWeekdayCounts();
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return zeroWeekdayCounts();
  const monthStart = ymd(y, mo, 1);
  const monthEnd = ymd(y, mo, lastDayOfMonth(y, mo));
  // Schnittmenge mit [from, to] (lexikografischer Vergleich für „yyyy-MM-dd").
  const clampStart = monthStart > from ? monthStart : from;
  const clampEnd = monthEnd < to ? monthEnd : to;
  return countWeekdayOccurrences(clampStart, clampEnd);
}

// ── Status-Auswahl ───────────────────────────────────────────────────────────

/**
 * Welche Reservationen in die Auswertung einfliessen:
 *  - `booked`  : alle ausser Storno/No-Show/abgelehnt (Standard — gebuchte Gäste)
 *  - `active`  : nur aktive (confirmed/completed/seated/arrived)
 *  - `all`     : alle (inkl. Storno/No-Show)
 */
export type StatusScope = 'booked' | 'active' | 'all';

export const STATUS_SCOPE_LABEL: Record<StatusScope, string> = {
  booked: 'Ohne Storno / No-Show',
  active: 'Nur aktive',
  all: 'Alle',
};

export function statusPredicate(scope: StatusScope): (status: string) => boolean {
  switch (scope) {
    case 'active':
      return isActiveStatus;
    case 'all':
      return () => true;
    case 'booked':
    default:
      return (s) => !isExcludedStatus(s);
  }
}

// ── Auswertungs-Kennzahl (Umschalter) ────────────────────────────────────────

/**
 * Nach welcher Kennzahl die Matrix/Zusammenfassung primär ausgewertet wird:
 *  - `reservations`  : Anzahl Reservationen
 *  - `persons`       : Anzahl Personen
 *  - `avgPersons`    : Ø Personen pro Reservation
 *
 * Die Anzahl Reservationen bleibt in JEDEM Modus sichtbar (als kleine Sekundär-
 * zahl), damit sie nie ganz verschwindet.
 */
export type MetricKey = 'reservations' | 'persons' | 'avgPersons';

export const METRIC_LABEL: Record<MetricKey, string> = {
  reservations: 'Reservationen',
  persons: 'Personen',
  avgPersons: 'Personen pro Reservation',
};

export const METRICS: MetricKey[] = ['reservations', 'persons', 'avgPersons'];

/** Ø Personen pro Reservation einer Zelle (null wenn keine Reservation). */
export function cellAverage(cell: Cell): number | null {
  return cell.reservations > 0 ? cell.persons / cell.reservations : null;
}

/**
 * Vergleichswert einer Reservations-/Personen-Zelle für die gewählte Kennzahl.
 * Für `avgPersons` ohne Reservationen → 0 (die Aufrufer überspringen leere Eimer
 * ohnehin, daher fliesst dieser Fall nie in eine Rangbildung ein).
 */
export function metricValue(reservations: number, persons: number, metric: MetricKey): number {
  switch (metric) {
    case 'persons':
      return persons;
    case 'avgPersons':
      return reservations > 0 ? persons / reservations : 0;
    case 'reservations':
    default:
      return reservations;
  }
}

/** Wie eine Matrix-Zelle je Kennzahl darzustellen ist (reine Werte, ohne Format). */
export interface CellDisplay {
  /** Grosse Zahl der Zelle (null = leere Zelle, nichts zu zeigen). */
  primary: number | null;
  /** true → die grosse Zahl ist ein Ø (mit Nachkommastelle anzeigen). */
  primaryIsAverage: boolean;
  /** Anzahl Reservationen — wird IN JEDEM Modus mitgeführt (verschwindet nie). */
  reservations: number;
  /** Anzahl Personen. */
  persons: number;
}

/**
 * Liefert die Anzeigewerte einer Matrix-Zelle für die gewählte Kennzahl.  Die
 * grosse Zahl wechselt je Modus; die Anzahl Reservationen (und Personen) bleibt
 * IMMER erhalten, damit die Reservationen nie ganz verschwinden.
 */
export function matrixCellDisplay(cell: Cell, metric: MetricKey): CellDisplay {
  const base = { reservations: cell.reservations, persons: cell.persons };
  if (cell.reservations === 0) {
    return { primary: null, primaryIsAverage: false, ...base };
  }
  switch (metric) {
    case 'persons':
      return { primary: cell.persons, primaryIsAverage: false, ...base };
    case 'avgPersons':
      return { primary: cell.persons / cell.reservations, primaryIsAverage: true, ...base };
    case 'reservations':
    default:
      return { primary: cell.reservations, primaryIsAverage: false, ...base };
  }
}

// ── Interne Filterung ────────────────────────────────────────────────────────

interface PreparedRow {
  weekday: IsoWeekday;
  monthKey: string;
  persons: number;
}

/**
 * Filtert Rohzeilen auf [from, to] (inklusive) + Status-Prädikat und liefert die
 * für die Aggregation nötigen Felder. Zeilen ohne/ungültiges Datum werden
 * verworfen; eine unbekannte Personenzahl zählt als 0 Personen (aber als 1
 * Reservation).
 */
function prepareRows(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  include: (status: string) => boolean,
): PreparedRow[] {
  const out: PreparedRow[] = [];
  for (const r of rows) {
    if (!r.date) continue;
    const d = r.date.slice(0, 10);
    if (d < from || d > to) continue;
    if (!include(r.status)) continue;
    const weekday = isoWeekdayOf(d);
    const monthKey = monthKeyOf(d);
    if (weekday === null || monthKey === null) continue;
    out.push({ weekday, monthKey, persons: r.partySize ?? 0 });
  }
  return out;
}

// ── Wochentags-Kennzahlen ────────────────────────────────────────────────────

export interface WeekdayStat {
  weekday: IsoWeekday;
  reservations: number;
  persons: number;
  /** Ø Personen pro Reservation (null wenn keine Reservation). */
  avgPersons: number | null;
  /** Anteil der Reservationen am Gesamtzeitraum in Prozent (0..100). */
  sharePct: number;
  /** Anzahl Vorkommen dieses Wochentags im Zeitraum (z. B. 5 Montage). */
  occurrences: number;
  /** Ø Reservationen pro Vorkommen dieses Wochentags (null wenn 0 Vorkommen). */
  avgReservationsPerDay: number | null;
  /** Ø Personen pro Vorkommen dieses Wochentags (null wenn 0 Vorkommen). */
  avgPersonsPerDay: number | null;
}

export interface WeekdayAggregate {
  /** Immer alle 7 Wochentage Mo→So (auch leere). */
  weekdays: WeekdayStat[];
  totalReservations: number;
  totalPersons: number;
  /** Summe der Wochentags-Vorkommen = Anzahl Kalendertage im Zeitraum. */
  totalOccurrences: number;
  /** Ø Reservationen pro Tag im Zeitraum (totalReservations / totalOccurrences). */
  avgReservationsPerDay: number | null;
  /** Ø Personen pro Reservation im Zeitraum (totalPersons / totalReservations). */
  avgPersonsPerReservation: number | null;
}

/**
 * Kennzahlen je Wochentag über den gesamten Zeitraum.  Liefert IMMER alle 7
 * Wochentage (Mo→So), damit fehlende Tage als 0 sichtbar bleiben.
 */
export function aggregateByWeekday(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  scope: StatusScope = 'booked',
): WeekdayAggregate {
  const prepared = prepareRows(rows, from, to, statusPredicate(scope));
  const occ = countWeekdayOccurrences(from, to);
  const res: Record<IsoWeekday, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  const per: Record<IsoWeekday, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  let totalReservations = 0;
  let totalPersons = 0;
  for (const p of prepared) {
    res[p.weekday] += 1;
    per[p.weekday] += p.persons;
    totalReservations += 1;
    totalPersons += p.persons;
  }
  const weekdays = ISO_WEEKDAYS.map<WeekdayStat>((wd) => ({
    weekday: wd,
    reservations: res[wd],
    persons: per[wd],
    avgPersons: res[wd] > 0 ? per[wd] / res[wd] : null,
    sharePct: totalReservations > 0 ? (res[wd] / totalReservations) * 100 : 0,
    occurrences: occ[wd],
    avgReservationsPerDay: occ[wd] > 0 ? res[wd] / occ[wd] : null,
    avgPersonsPerDay: occ[wd] > 0 ? per[wd] / occ[wd] : null,
  }));
  const totalOccurrences = ISO_WEEKDAYS.reduce((s, wd) => s + occ[wd], 0);
  return {
    weekdays,
    totalReservations,
    totalPersons,
    totalOccurrences,
    avgReservationsPerDay: totalOccurrences > 0 ? totalReservations / totalOccurrences : null,
    avgPersonsPerReservation: totalReservations > 0 ? totalPersons / totalReservations : null,
  };
}

// ── Matrix „Wochentage nach Monat" ───────────────────────────────────────────

export interface Cell {
  reservations: number;
  persons: number;
}

export interface MonthWeekdayRow {
  monthKey: string; // "yyyy-MM"
  /** Zellen je Wochentag (Mo→So). */
  cells: Record<IsoWeekday, Cell>;
  /** Zeilensumme (alle Wochentage des Monats). */
  total: Cell;
}

export interface MonthWeekdayMatrix {
  /** Monate chronologisch aufsteigend. */
  months: MonthWeekdayRow[];
  /** Spaltensummen je Wochentag (über alle Monate). */
  weekdayTotals: Record<IsoWeekday, Cell>;
  /** Gesamtsumme. */
  grandTotal: Cell;
}

function emptyCellRecord(): Record<IsoWeekday, Cell> {
  return {
    1: { reservations: 0, persons: 0 },
    2: { reservations: 0, persons: 0 },
    3: { reservations: 0, persons: 0 },
    4: { reservations: 0, persons: 0 },
    5: { reservations: 0, persons: 0 },
    6: { reservations: 0, persons: 0 },
    7: { reservations: 0, persons: 0 },
  };
}

/**
 * Matrix Monat × Wochentag.  Jede Zelle enthält Reservationen + Personen; pro
 * Monat eine Zeilensumme, je Wochentag eine Spaltensumme, plus Gesamtsumme.
 * Es erscheinen nur Monate, in denen mindestens eine (gefilterte) Reservation
 * liegt — chronologisch sortiert.
 */
export function buildMonthWeekdayMatrix(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  scope: StatusScope = 'booked',
): MonthWeekdayMatrix {
  const prepared = prepareRows(rows, from, to, statusPredicate(scope));
  const byMonth = new Map<string, MonthWeekdayRow>();
  const weekdayTotals = emptyCellRecord();
  const grandTotal: Cell = { reservations: 0, persons: 0 };

  for (const p of prepared) {
    let row = byMonth.get(p.monthKey);
    if (!row) {
      row = { monthKey: p.monthKey, cells: emptyCellRecord(), total: { reservations: 0, persons: 0 } };
      byMonth.set(p.monthKey, row);
    }
    const cell = row.cells[p.weekday];
    cell.reservations += 1;
    cell.persons += p.persons;
    row.total.reservations += 1;
    row.total.persons += p.persons;
    weekdayTotals[p.weekday].reservations += 1;
    weekdayTotals[p.weekday].persons += p.persons;
    grandTotal.reservations += 1;
    grandTotal.persons += p.persons;
  }

  const months = [...byMonth.values()].sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  return { months, weekdayTotals, grandTotal };
}

// ── Monats-Wochentag-Aufschlüsselung (vereinfachte Monatsauswertung) ──────────

export interface MonthWeekdayBreakdownRow {
  monthKey: string; // "yyyy-MM"
  weekday: IsoWeekday;
  /** Vorkommen dieses Wochentags im Monat (auf den Zeitraum geklemmt). */
  occurrences: number;
  reservations: number;
  persons: number;
  /** Ø Reservationen pro Vorkommen (null wenn 0 Vorkommen). */
  avgReservationsPerDay: number | null;
  /** Ø Personen pro Vorkommen (null wenn 0 Vorkommen). */
  avgPersonsPerDay: number | null;
  /** Ø Personen pro Reservation (null wenn 0 Reservationen). */
  avgPersons: number | null;
}

/**
 * Flache Aufschlüsselung „pro Monat × Wochentag" als Ersatz für die grosse
 * Matrix.  Eine Zeile je (Monat, Wochentag) mit Vorkommen, Reservationen,
 * Personen sowie den Durchschnitten.  Es erscheinen nur Monate mit mindestens
 * einer Reservation (wie in der Matrix) und je Monat nur Wochentage, die im
 * Zeitraum tatsächlich vorkommen (`occurrences > 0`) — chronologisch, Mo→So.
 */
export function buildMonthWeekdayBreakdown(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  scope: StatusScope = 'booked',
): MonthWeekdayBreakdownRow[] {
  const matrix = buildMonthWeekdayMatrix(rows, from, to, scope);
  const out: MonthWeekdayBreakdownRow[] = [];
  for (const month of matrix.months) {
    const occ = countWeekdayOccurrencesInMonth(month.monthKey, from, to);
    for (const wd of ISO_WEEKDAYS) {
      const occurrences = occ[wd];
      if (occurrences <= 0) continue;
      const cell = month.cells[wd];
      out.push({
        monthKey: month.monthKey,
        weekday: wd,
        occurrences,
        reservations: cell.reservations,
        persons: cell.persons,
        avgReservationsPerDay: occurrences > 0 ? cell.reservations / occurrences : null,
        avgPersonsPerDay: occurrences > 0 ? cell.persons / occurrences : null,
        avgPersons: cell.reservations > 0 ? cell.persons / cell.reservations : null,
      });
    }
  }
  return out;
}

// ── Zusammenfassung ──────────────────────────────────────────────────────────

export interface WeekdayExtreme {
  weekday: IsoWeekday;
  reservations: number;
  persons: number;
  /** Ø Personen pro Reservation (null wenn keine Reservation). */
  avgPersons: number | null;
  /** Wert der gewählten Kennzahl, nach dem rangiert wurde. */
  value: number;
}

export interface MonthExtreme {
  monthKey: string;
  reservations: number;
  persons: number;
  /** Ø Personen pro Reservation (null wenn keine Reservation). */
  avgPersons: number | null;
  /** Wert der gewählten Kennzahl, nach dem rangiert wurde. */
  value: number;
}

export interface WeekdaySummary {
  /** Kennzahl, nach der die Zusammenfassung gebildet wurde. */
  metric: MetricKey;
  /** Stärkster Wochentag (höchster Kennzahl-Wert). */
  strongestWeekday: WeekdayExtreme | null;
  /** Schwächster Wochentag (niedrigster Wert, nur Tage mit >0 Reservationen). */
  weakestWeekday: WeekdayExtreme | null;
  /** Fokus-Wochentag für den Monatsvergleich. */
  focusWeekday: IsoWeekday;
  /** Bester Monat für den Fokus-Wochentag (höchster Kennzahl-Wert). */
  bestMonthForWeekday: MonthExtreme | null;
  /** Schwächster Monat für den Fokus-Wochentag (nur Monate mit >0). */
  worstMonthForWeekday: MonthExtreme | null;
}

/**
 * Leitet die Kennzahlen-Zusammenfassung für die gewählte `metric` ab
 * (`reservations` | `persons` | `avgPersons`).
 *
 * Vergleichsregel (bewusst, in den Tests fixiert): leere Eimer werden ignoriert.
 * Stärkster/schwächster Wochentag werden NUR über Wochentage mit mindestens
 * einer Reservation bestimmt; bester/schwächster Monat NUR über Monate, in denen
 * der Fokus-Wochentag mindestens eine Reservation hat.  Rangiert wird nach dem
 * `metricValue` der jeweiligen Kennzahl; bei Gleichstand gewinnt der frühere
 * Wochentag bzw. der frühere Monat (Iterationsreihenfolge Mo→So / chronologisch).
 */
export function buildWeekdaySummary(
  agg: WeekdayAggregate,
  matrix: MonthWeekdayMatrix,
  focusWeekday: IsoWeekday,
  metric: MetricKey = 'reservations',
): WeekdaySummary {
  let strongest: WeekdayExtreme | null = null;
  let weakest: WeekdayExtreme | null = null;
  for (const w of agg.weekdays) {
    if (w.reservations <= 0) continue;
    const e: WeekdayExtreme = {
      weekday: w.weekday,
      reservations: w.reservations,
      persons: w.persons,
      avgPersons: w.avgPersons,
      value: metricValue(w.reservations, w.persons, metric),
    };
    if (!strongest || e.value > strongest.value) strongest = e;
    if (!weakest || e.value < weakest.value) weakest = e;
  }

  let best: MonthExtreme | null = null;
  let worst: MonthExtreme | null = null;
  for (const row of matrix.months) {
    const cell = row.cells[focusWeekday];
    if (cell.reservations <= 0) continue;
    const e: MonthExtreme = {
      monthKey: row.monthKey,
      reservations: cell.reservations,
      persons: cell.persons,
      avgPersons: cellAverage(cell),
      value: metricValue(cell.reservations, cell.persons, metric),
    };
    if (!best || e.value > best.value) best = e;
    if (!worst || e.value < worst.value) worst = e;
  }

  return {
    metric,
    strongestWeekday: strongest,
    weakestWeekday: weakest,
    focusWeekday,
    bestMonthForWeekday: best,
    worstMonthForWeekday: worst,
  };
}

// ── Kompakte Hauptansicht je Wochentag (Karten) ──────────────────────────────
//
// Die neue Hauptauswertung zeigt je Wochentag EINE grosse Zahl — und zwar IMMER
// einen Durchschnitt, der sich auf den jeweiligen Wochentag bezieht:
//   - Modus „Reservationen"            → Ø Reservationen pro <Wochentag>
//   - Modus „Personen"                 → Ø Personen pro <Wochentag>
//   - Modus „Personen pro Reservation" → Ø Personen pro Reservation
// So ist sofort klar: „4 Montage, 47 Reservationen → Ø 11.8 pro Montag".

/** Pluralform je Wochentag (für „Anzahl Montage im Zeitraum"). */
export const WEEKDAY_PLURAL: Record<IsoWeekday, string> = {
  1: 'Montage',
  2: 'Dienstage',
  3: 'Mittwoche',
  4: 'Donnerstage',
  5: 'Freitage',
  6: 'Samstage',
  7: 'Sonntage',
};

/** „Anzahl Montage im Zeitraum" (ersetzt das technische „Vorkommen"). */
export function weekdayOccurrenceLabel(wd: IsoWeekday): string {
  return `Anzahl ${WEEKDAY_PLURAL[wd]} im Zeitraum`;
}

/** „Ø Reservationen pro Montag". */
export function avgReservationsPerWeekdayLabel(wd: IsoWeekday): string {
  return `Ø Reservationen pro ${WEEKDAY_LABEL[wd]}`;
}

/** „Ø Personen pro Montag". */
export function avgPersonsPerWeekdayLabel(wd: IsoWeekday): string {
  return `Ø Personen pro ${WEEKDAY_LABEL[wd]}`;
}

/** Festes Label für die Ø-Personen-pro-Reservation-Kennzahl (wochentagsunabhängig). */
export const AVG_PERSONS_PER_RESERVATION_LABEL = 'Ø Personen pro Reservation';

/** Label der grossen Hauptzahl je Modus + Wochentag. */
export function headlineLabel(wd: IsoWeekday, metric: MetricKey): string {
  switch (metric) {
    case 'persons':
      return avgPersonsPerWeekdayLabel(wd);
    case 'avgPersons':
      return AVG_PERSONS_PER_RESERVATION_LABEL;
    case 'reservations':
    default:
      return avgReservationsPerWeekdayLabel(wd);
  }
}

/**
 * Wert der grossen Hauptzahl je Modus — IMMER ein Durchschnitt:
 *  - `reservations` → Ø Reservationen pro Vorkommen dieses Wochentags
 *  - `persons`      → Ø Personen pro Vorkommen dieses Wochentags
 *  - `avgPersons`   → Ø Personen pro Reservation
 * `null`, wenn nicht berechenbar (keine Vorkommen bzw. keine Reservation).
 */
export function weekdayHeadlineValue(stat: WeekdayStat, metric: MetricKey): number | null {
  switch (metric) {
    case 'persons':
      return stat.avgPersonsPerDay;
    case 'avgPersons':
      return stat.avgPersons;
    case 'reservations':
    default:
      return stat.avgReservationsPerDay;
  }
}

/** Einordnung eines Wochentags relativ zum Durchschnitt der aktiven Wochentage. */
export type WeekdayRank = 'strongest' | 'weakest' | 'above' | 'below' | 'average' | 'none';

export const WEEKDAY_RANK_LABEL: Record<WeekdayRank, string> = {
  strongest: 'stärkster Wochentag',
  weakest: 'schwächster Wochentag',
  above: 'über Durchschnitt',
  below: 'unter Durchschnitt',
  average: 'im Durchschnitt',
  none: 'keine Reservationen',
};

export interface WeekdayHeadline {
  weekday: IsoWeekday;
  /** Grosse Zahl (Durchschnitt je Modus) — `null` wenn nicht berechenbar. */
  value: number | null;
  reservations: number;
  persons: number;
  occurrences: number;
  /** Ø Personen pro Reservation. */
  avgPersons: number | null;
  /** Ø Reservationen pro Vorkommen dieses Wochentags. */
  avgReservationsPerDay: number | null;
  /** Ø Personen pro Vorkommen dieses Wochentags. */
  avgPersonsPerDay: number | null;
  /** Einordnung über/unter Durchschnitt bzw. stärkster/schwächster Wochentag. */
  rank: WeekdayRank;
  /** true, wenn der Wochentag mindestens eine Reservation hat. */
  isActive: boolean;
}

export interface WeekdayHeadlineSummary {
  metric: MetricKey;
  /** Immer alle 7 Wochentage (Mo→So). */
  headlines: WeekdayHeadline[];
  /** Referenz-Durchschnitt der Hauptkennzahl über alle AKTIVEN Wochentage (für über/unter). */
  average: number | null;
  /** Stärkster aktiver Wochentag (höchster Hauptwert) oder `null`. */
  strongest: IsoWeekday | null;
  /** Schwächster aktiver Wochentag (niedrigster Hauptwert) oder `null`. */
  weakest: IsoWeekday | null;
}

/**
 * Baut die kompakte Hauptansicht je Wochentag für die gewählte Kennzahl.
 *
 * Vergleichsregel (in den Tests fixiert): leere Wochentage (0 Reservationen)
 * fliessen NICHT in Durchschnitt/Extreme ein und erhalten den Rang `none`.
 * Stärkster/schwächster Wochentag sowie der Referenz-Durchschnitt werden NUR
 * über aktive Wochentage gebildet; bei Gleichstand gewinnt der frühere
 * Wochentag (Mo→So). Der stärkste Wochentag hat Vorrang vor dem schwächsten
 * (relevant, wenn nur ein Wochentag aktiv ist).
 */
export function buildWeekdayHeadlines(
  agg: WeekdayAggregate,
  metric: MetricKey = 'reservations',
): WeekdayHeadlineSummary {
  let strongest: IsoWeekday | null = null;
  let weakest: IsoWeekday | null = null;
  let strongestVal = -Infinity;
  let weakestVal = Infinity;
  let sum = 0;
  let count = 0;
  for (const w of agg.weekdays) {
    if (w.reservations <= 0) continue;
    const v = weekdayHeadlineValue(w, metric) ?? 0;
    sum += v;
    count += 1;
    if (v > strongestVal) {
      strongestVal = v;
      strongest = w.weekday;
    }
    if (v < weakestVal) {
      weakestVal = v;
      weakest = w.weekday;
    }
  }
  const average = count > 0 ? sum / count : null;
  const eps = 1e-9;

  const headlines = agg.weekdays.map<WeekdayHeadline>((w) => {
    const value = weekdayHeadlineValue(w, metric);
    let rank: WeekdayRank;
    if (w.reservations <= 0) {
      rank = 'none';
    } else if (w.weekday === strongest) {
      rank = 'strongest';
    } else if (w.weekday === weakest) {
      rank = 'weakest';
    } else if (average !== null && (value ?? 0) > average + eps) {
      rank = 'above';
    } else if (average !== null && (value ?? 0) < average - eps) {
      rank = 'below';
    } else {
      rank = 'average';
    }
    return {
      weekday: w.weekday,
      value,
      reservations: w.reservations,
      persons: w.persons,
      occurrences: w.occurrences,
      avgPersons: w.avgPersons,
      avgReservationsPerDay: w.avgReservationsPerDay,
      avgPersonsPerDay: w.avgPersonsPerDay,
      rank,
      isActive: w.reservations > 0,
    };
  });

  return { metric, headlines, average, strongest, weakest };
}

/**
 * Standardzustand des Monatsvergleichs in der UI: eingeklappt.  Als Konstante
 * exportiert, damit „standardmässig eingeklappt" testbar an EINER Stelle
 * verankert ist und die Komponente denselben Wert als `useState`-Initialwert
 * nutzt.
 */
export const MONTH_COMPARISON_DEFAULT_OPEN = false;

// ── Monatsvergleich-Matrix (Monate × Wochentage, kompakt + interpretiert) ─────
//
// Kompakte Vergleichsansicht: Zeilen = Monate des Zeitraums, Spalten = Mo→So.
// Jede Zelle trägt EINE grosse, modusabhängige Ø-Zahl + eine kleine Sekundär-
// zeile.  Zusätzlich wird je Zelle relativ zum SPALTEN-Durchschnitt (also diesem
// Wochentag über alle Monate) eingeordnet (über/unter/ungefähr Durchschnitt) und
// der beste/schwächste Wert je Wochentag markiert (Top/Tief).  So ist sofort
// sichtbar, ob z. B. der Montag in einem Monat besser oder schlechter war als in
// den anderen Monaten.  KEINE neue Tabelle, KEINE Migration — reine Anzeige.

export type ComparisonRank = 'above' | 'below' | 'average' | 'none';

export interface ComparisonCell {
  monthKey: string; // "yyyy-MM"
  weekday: IsoWeekday;
  /** Vorkommen dieses Wochentags im Monat (auf den Zeitraum geklemmt). */
  occurrences: number;
  reservations: number;
  persons: number;
  /** Grosse, modusabhängige Ø-Zahl (null = leer / nicht berechenbar). */
  value: number | null;
  /** Einordnung relativ zum Spalten-Durchschnitt (dieser Wochentag über alle Monate). */
  rank: ComparisonRank;
  /** Bester Wert dieses Wochentags über alle Monate (nur bei echter Spreizung). */
  isTop: boolean;
  /** Schwächster Wert dieses Wochentags über alle Monate (nur bei echter Spreizung). */
  isLow: boolean;
}

export interface ComparisonMonthRow {
  monthKey: string; // "yyyy-MM"
  /** Zellen je Wochentag (Mo→So), immer alle 7. */
  cells: Record<IsoWeekday, ComparisonCell>;
  /** Monatszusammenfassung (für Zeilenkopf / Tooltip). */
  totalReservations: number;
  totalPersons: number;
  avgPersons: number | null;
  /** Stärkster/schwächster Wochentag DIESES Monats (nach Modus-Wert). */
  strongestWeekday: IsoWeekday | null;
  weakestWeekday: IsoWeekday | null;
}

export interface ComparisonColumn {
  weekday: IsoWeekday;
  /** Ø der Monatswerte dieses Wochentags (nur Monate mit Wert). */
  average: number | null;
  /** Bester Monat dieses Wochentags (höchster Wert; bei Gleichstand früher). */
  best: { monthKey: string; value: number } | null;
  /** Schwächster Monat dieses Wochentags (niedrigster Wert; bei Gleichstand früher). */
  worst: { monthKey: string; value: number } | null;
}

export interface MonthComparison {
  metric: MetricKey;
  /** Monate chronologisch aufsteigend (nur Monate mit mindestens einer Reservation). */
  months: ComparisonMonthRow[];
  /** Spalten-Statistik je Wochentag (über alle Monate). */
  columns: Record<IsoWeekday, ComparisonColumn>;
}

/**
 * Grosse Ø-Zahl einer Vergleichszelle je Modus:
 *  - `reservations` → Ø Reservationen pro Vorkommen dieses Wochentags (R / Vorkommen)
 *  - `persons`      → Ø Personen pro Vorkommen dieses Wochentags (P / Vorkommen)
 *  - `avgPersons`   → Ø Personen pro Reservation (P / R)
 * `null`, wenn nicht berechenbar (keine Vorkommen bzw. keine Reservation).
 */
export function comparisonCellValue(
  reservations: number,
  persons: number,
  occurrences: number,
  metric: MetricKey,
): number | null {
  switch (metric) {
    case 'persons':
      return occurrences > 0 ? persons / occurrences : null;
    case 'avgPersons':
      return reservations > 0 ? persons / reservations : null;
    case 'reservations':
    default:
      return occurrences > 0 ? reservations / occurrences : null;
  }
}

/**
 * Kleine Sekundärzeile einer Vergleichszelle je Modus:
 *  - `reservations` → „205 Res. / 5 Fr." (Reservationen total / Anzahl Wochentage)
 *  - `persons`      → „808 Pers. / 5 Fr." (Personen total / Anzahl Wochentage)
 *  - `avgPersons`   → „808 Pers. / 205 Res." (Personen total / Reservationen total)
 * Leerer String, wenn nichts anzuzeigen ist (keine Vorkommen bzw. keine Reservation).
 */
export function comparisonCellSubLabel(cell: ComparisonCell, metric: MetricKey): string {
  switch (metric) {
    case 'persons':
      return cell.occurrences > 0
        ? `${cell.persons} Pers. / ${cell.occurrences} ${WEEKDAY_SHORT[cell.weekday]}.`
        : '';
    case 'avgPersons':
      return cell.reservations > 0
        ? `${cell.persons} Pers. / ${cell.reservations} Res.`
        : '';
    case 'reservations':
    default:
      return cell.occurrences > 0
        ? `${cell.reservations} Res. / ${cell.occurrences} ${WEEKDAY_SHORT[cell.weekday]}.`
        : '';
  }
}

const COMPARISON_EPS = 1e-9;

/**
 * Baut die kompakte Vergleichsmatrix (Monate × Wochentage) für die gewählte
 * Kennzahl.  Pro Monat eine Zeile mit allen 7 Wochentagen, je Wochentag eine
 * Spalten-Statistik (Ø + bester/schwächster Monat), je Zelle eine Einordnung
 * relativ zum Spalten-Durchschnitt sowie Top/Tief-Markierung.
 *
 * Vergleichsregel (in den Tests fixiert):
 *  - Eine Zelle „zählt" (für Spalten-Ø/Extreme/Top/Tief), wenn ihr Wert ≠ null
 *    ist (Reservationen/Personen: Vorkommen > 0; Ø Personen/Res.: Reservationen > 0).
 *  - Bei Gleichstand gewinnt der frühere Monat (chronologisch) für `best`/`worst`
 *    (diese Objekte sind einwertig und speisen die Insight-Sätze).
 *  - Top/Tief werden nur gesetzt, wenn die Spalte ≥ 2 Werte UND eine echte
 *    Spreizung (best > worst) hat — sonst bliebe jede Zelle gleichzeitig Top/Tief.
 *  - Bei Gleichstand AM Extremwert werden bewusst ALLE betroffenen Monatszellen
 *    markiert (Heatmap-Logik: jede beste/schwächste Zelle einer Spalte wird
 *    hervorgehoben), auch wenn `best`/`worst` nur den früheren Monat nennen.
 */
export function buildMonthComparison(
  rows: ReservationAggRow[],
  from: string,
  to: string,
  scope: StatusScope = 'booked',
  metric: MetricKey = 'reservations',
): MonthComparison {
  const matrix = buildMonthWeekdayMatrix(rows, from, to, scope);

  // 1) Monatszeilen mit Roh-Zellen (rank/Top/Tief folgen in Schritt 3).
  const months: ComparisonMonthRow[] = matrix.months.map((m) => {
    const occ = countWeekdayOccurrencesInMonth(m.monthKey, from, to);
    const cells = {} as Record<IsoWeekday, ComparisonCell>;
    let strongest: IsoWeekday | null = null;
    let weakest: IsoWeekday | null = null;
    let strongestVal = -Infinity;
    let weakestVal = Infinity;
    for (const wd of ISO_WEEKDAYS) {
      const c = m.cells[wd];
      const value = comparisonCellValue(c.reservations, c.persons, occ[wd], metric);
      cells[wd] = {
        monthKey: m.monthKey,
        weekday: wd,
        occurrences: occ[wd],
        reservations: c.reservations,
        persons: c.persons,
        value,
        rank: 'none',
        isTop: false,
        isLow: false,
      };
      if (value !== null) {
        if (value > strongestVal + COMPARISON_EPS) { strongestVal = value; strongest = wd; }
        if (value < weakestVal - COMPARISON_EPS) { weakestVal = value; weakest = wd; }
      }
    }
    return {
      monthKey: m.monthKey,
      cells,
      totalReservations: m.total.reservations,
      totalPersons: m.total.persons,
      avgPersons: m.total.reservations > 0 ? m.total.persons / m.total.reservations : null,
      strongestWeekday: strongest,
      weakestWeekday: weakest,
    };
  });

  // 2) Spalten-Statistik je Wochentag (Ø, bester/schwächster Monat).
  const columns = {} as Record<IsoWeekday, ComparisonColumn>;
  for (const wd of ISO_WEEKDAYS) {
    const valued = months
      .map((m) => m.cells[wd])
      .filter((c): c is ComparisonCell & { value: number } => c.value !== null);
    if (valued.length === 0) {
      columns[wd] = { weekday: wd, average: null, best: null, worst: null };
      continue;
    }
    let sum = 0;
    let best = valued[0];
    let worst = valued[0];
    for (const c of valued) {
      sum += c.value;
      if (c.value > best.value + COMPARISON_EPS) best = c; // bei Gleichstand bleibt der frühere
      if (c.value < worst.value - COMPARISON_EPS) worst = c;
    }
    columns[wd] = {
      weekday: wd,
      average: sum / valued.length,
      best: { monthKey: best.monthKey, value: best.value },
      worst: { monthKey: worst.monthKey, value: worst.value },
    };
  }

  // 3) Rang (relativ zum Spalten-Ø) + Top/Tief je Zelle setzen.
  for (const m of months) {
    for (const wd of ISO_WEEKDAYS) {
      const cell = m.cells[wd];
      const col = columns[wd];
      if (cell.value === null || col.average === null) {
        cell.rank = 'none';
        continue;
      }
      if (cell.value > col.average + COMPARISON_EPS) cell.rank = 'above';
      else if (cell.value < col.average - COMPARISON_EPS) cell.rank = 'below';
      else cell.rank = 'average';

      if (col.best && col.worst && col.best.value - col.worst.value > COMPARISON_EPS) {
        // Heatmap-Logik: ALLE am Extremwert liegenden Zellen markieren (bei
        // Gleichstand also ggf. mehrere Monate), während best/worst nur den
        // früheren Monat für die Insight-Sätze festhalten.
        if (Math.abs(cell.value - col.best.value) <= COMPARISON_EPS) cell.isTop = true;
        if (Math.abs(cell.value - col.worst.value) <= COMPARISON_EPS) cell.isLow = true;
      }
    }
  }

  return { metric, months, columns };
}

// ── Insights (lesbare Interpretation über dem Monatsvergleich) ────────────────

/** Einstellige Nachkommazahl, z. B. 34 → „34.0" (de-CH Dezimaltrennzeichen „."). */
function fmt1(n: number): string {
  return n.toFixed(1);
}

/** Einheit der Hauptkennzahl im Insight-Satz, z. B. „Reservationen pro Samstag". */
export function headlineUnit(wd: IsoWeekday, metric: MetricKey): string {
  switch (metric) {
    case 'persons':
      return `Personen pro ${WEEKDAY_LABEL[wd]}`;
    case 'avgPersons':
      return 'Personen pro Reservation';
    case 'reservations':
    default:
      return `Reservationen pro ${WEEKDAY_LABEL[wd]}`;
  }
}

/** Deutsche Aufzählung: ["a"]→"a"; ["a","b"]→"a und b"; ["a","b","c"]→"a, b und c". */
function germanList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/**
 * Insight „X liegt/liegen in (fast) allen Monaten über dem Durchschnitt".
 * Referenz ist der Perioden-Durchschnitt der Hauptkennzahl (`headlines.average`).
 * Ein Wochentag qualifiziert sich, wenn er in ALLEN seiner Monate (≥ 2) über der
 * Referenz liegt („allen") oder in allen bis auf einen (≥ 3 Monate, „fast allen").
 * `null`, wenn kein Wochentag qualifiziert.
 */
function consistencyInsight(comparison: MonthComparison, reference: number | null): string | null {
  if (reference === null) return null;
  const qualifying: { weekday: IsoWeekday; all: boolean }[] = [];
  for (const wd of ISO_WEEKDAYS) {
    const valued = comparison.months
      .map((m) => m.cells[wd])
      .filter((c): c is ComparisonCell & { value: number } => c.value !== null);
    const active = valued.length;
    if (active < 2) continue;
    const above = valued.filter((c) => c.value > reference + COMPARISON_EPS).length;
    if (above === active) qualifying.push({ weekday: wd, all: true });
    else if (active >= 3 && above === active - 1) qualifying.push({ weekday: wd, all: false });
  }
  if (qualifying.length === 0) return null;
  const list = qualifying.slice(0, 3);
  const allTrue = list.every((q) => q.all);
  const names = list.map((q) => WEEKDAY_LABEL[q.weekday]);
  const verb = list.length === 1 ? 'liegt' : 'liegen';
  const phrase = allTrue ? 'allen' : 'fast allen';
  return `${germanList(names)} ${verb} in ${phrase} Monaten über dem Durchschnitt.`;
}

/**
 * Baut 3–5 kurze, modusabhängige Insight-Sätze über dem Monatsvergleich:
 *  1. Stärkster Wochentag im Zeitraum (aus `headlines`).
 *  2. Schwächster Wochentag im Zeitraum (nur falls ≠ stärkster).
 *  3. Bester Monat für den Fokus-Wochentag (nur bei ≥ 2 Monaten mit Werten).
 *  4. Schlechtester Monat für den Fokus-Wochentag (nur bei ≥ 2 Monaten + Spreizung).
 *  5. Wochentage, die in (fast) allen Monaten über dem Durchschnitt liegen.
 *
 * Die Sätze wechseln je Modus (Reservationen / Personen / Personen pro Reservation),
 * weil sowohl `headlines` als auch `comparison` modusabhängig gebildet werden.
 */
export function buildMonthComparisonInsights(
  headlines: WeekdayHeadlineSummary,
  comparison: MonthComparison,
  focusWeekday: IsoWeekday,
  metric: MetricKey = 'reservations',
): string[] {
  const out: string[] = [];

  if (headlines.strongest !== null) {
    const h = headlines.headlines.find((x) => x.weekday === headlines.strongest);
    if (h && h.value !== null) {
      out.push(
        `Stärkster Wochentag im Zeitraum: ${WEEKDAY_LABEL[headlines.strongest]} mit Ø ${fmt1(h.value)} ${headlineUnit(headlines.strongest, metric)}.`,
      );
    }
  }

  if (headlines.weakest !== null && headlines.weakest !== headlines.strongest) {
    const h = headlines.headlines.find((x) => x.weekday === headlines.weakest);
    if (h && h.value !== null) {
      out.push(
        `Schwächster Wochentag im Zeitraum: ${WEEKDAY_LABEL[headlines.weakest]} mit Ø ${fmt1(h.value)} ${headlineUnit(headlines.weakest, metric)}.`,
      );
    }
  }

  const col = comparison.columns[focusWeekday];
  const valuedMonths = comparison.months.filter((m) => m.cells[focusWeekday].value !== null).length;
  if (col.best && col.worst && valuedMonths >= 2 && col.best.monthKey !== col.worst.monthKey) {
    out.push(
      `Bester ${WEEKDAY_LABEL[focusWeekday]} war im ${monthLongLabel(col.best.monthKey)} mit Ø ${fmt1(col.best.value)} ${headlineUnit(focusWeekday, metric)}.`,
    );
    out.push(
      `Schlechtester ${WEEKDAY_LABEL[focusWeekday]} war im ${monthLongLabel(col.worst.monthKey)} mit Ø ${fmt1(col.worst.value)} ${headlineUnit(focusWeekday, metric)}.`,
    );
  }

  const consistency = consistencyInsight(comparison, headlines.average);
  if (consistency) out.push(consistency);

  // Fallback: 3–5 Sätze garantieren, solange überhaupt Daten vorhanden sind.
  // Einzelne Monate oder gleichförmige Werte liefern sonst < 3 Insights. Die
  // Zusatzsätze sind rein deskriptiv und wechseln ebenfalls mit dem Modus.
  if (comparison.months.length > 0) {
    if (out.length < 3) {
      // Fokus-Wochentag-Schnitt; hat der Fokus keine Werte, auf den stärksten
      // Wochentag ausweichen, damit immer ein aussagekräftiger Satz entsteht.
      const fbWd = valuedMonths > 0 && col.average !== null ? focusWeekday : headlines.strongest;
      const fbCol = fbWd !== null ? comparison.columns[fbWd] : null;
      const fbCount = fbWd !== null
        ? comparison.months.filter((m) => m.cells[fbWd].value !== null).length
        : 0;
      if (fbWd !== null && fbCol && fbCol.average !== null && fbCount > 0) {
        const line = `Ø ${WEEKDAY_LABEL[fbWd]} im Zeitraum: ${fmt1(fbCol.average)} ${headlineUnit(fbWd, metric)} über ${fbCount} ${fbCount === 1 ? 'Monat' : 'Monate'}.`;
        if (!out.includes(line)) out.push(line);
      }
    }
    if (out.length < 3) {
      const n = comparison.months.length;
      const first = monthLongLabel(comparison.months[0].monthKey);
      const last = monthLongLabel(comparison.months[n - 1].monthKey);
      const line = n === 1
        ? `Verglichen wird 1 Monat (${first}).`
        : `Verglichen werden ${n} Monate (${first} – ${last}).`;
      if (!out.includes(line)) out.push(line);
    }
  }

  return out.slice(0, 5);
}

// ── Schnell-Auswahl / Saison-Zeiträume ───────────────────────────────────────

export interface DateRange {
  from: string;
  to: string;
}

// ── Monatsnavigation (Pfeile vor/zurück) ─────────────────────────────────────

/**
 * Verschiebt einen Monatsschlüssel „yyyy-MM" um `delta` Monate (auch über
 * Jahresgrenzen, z. B. „2026-01" −1 → „2025-12").  Ungültiger Schlüssel wird
 * unverändert zurückgegeben.
 */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return monthKey;
  const zeroBased = y * 12 + (mo - 1) + Math.trunc(delta);
  const ny = Math.floor(zeroBased / 12);
  const nmo = ((zeroBased % 12) + 12) % 12 + 1;
  return `${ny}-${pad2(nmo)}`;
}

/**
 * Datumsbereich (erster bis letzter Tag) eines Monats „yyyy-MM".  Setzt Von/Bis
 * auf Monatsanfang/-ende.  Ungültiger Schlüssel → `{ from: '', to: '' }`.
 */
export function monthRange(monthKey: string): DateRange {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return { from: '', to: '' };
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return { from: '', to: '' };
  return { from: ymd(y, mo, 1), to: ymd(y, mo, lastDayOfMonth(y, mo)) };
}

/** Frei anpassbarer Saison-Zeitraum (Monat/Tag, jährlich wiederkehrend). */
export interface SeasonRange {
  startMonth: number; // 1..12
  startDay: number; // 1..31
  endMonth: number; // 1..12
  endDay: number; // 1..31
}

export interface SeasonSettings {
  winter: SeasonRange;
  summer: SeasonRange;
}

/** Standard-Saisons (anpassbar): Winter Okt–Mär (überschlägt), Sommer Apr–Sep. */
export const DEFAULT_SEASON_SETTINGS: SeasonSettings = {
  winter: { startMonth: 10, startDay: 1, endMonth: 3, endDay: 31 },
  summer: { startMonth: 4, startDay: 1, endMonth: 9, endDay: 30 },
};

export type PresetKey = 'thisMonth' | 'lastMonth' | 'octDec' | 'winter' | 'summer' | 'custom';

export const PRESET_LABEL: Record<PresetKey, string> = {
  thisMonth: 'Dieser Monat',
  lastMonth: 'Letzter Monat',
  octDec: 'Oktober bis Dezember',
  winter: 'Wintersaison',
  summer: 'Sommersaison',
  custom: 'Benutzerdefiniert',
};

/**
 * Löst einen Saison-Zeitraum gegen ein Referenzjahr auf.  Liegt das Ende
 * (Monat/Tag) vor dem Beginn, überschlägt die Saison ins Folgejahr
 * (z. B. Winter Nov→Feb). Tage werden an die Monatslänge geklemmt.
 */
export function seasonRange(s: SeasonRange, year: number): DateRange {
  const startMonth = clampInt(s.startMonth, 1, 12);
  const endMonth = clampInt(s.endMonth, 1, 12);
  const wraps =
    endMonth < startMonth || (endMonth === startMonth && s.endDay < s.startDay);
  const startY = year;
  const endY = wraps ? year + 1 : year;
  const startDay = clampInt(s.startDay, 1, lastDayOfMonth(startY, startMonth));
  const endDay = clampInt(s.endDay, 1, lastDayOfMonth(endY, endMonth));
  return { from: ymd(startY, startMonth, startDay), to: ymd(endY, endMonth, endDay) };
}

/**
 * Datumsbereich einer Schnell-Auswahl.  `thisMonth`/`lastMonth` beziehen sich
 * auf `today` (ISO „yyyy-MM-dd"); `octDec`/`winter`/`summer` auf das `year`.
 * `custom` liefert `null` (der Bereich bleibt frei wählbar).
 */
export function presetRange(
  key: PresetKey,
  opts: { today: string; year: number; seasons: SeasonSettings },
): DateRange | null {
  const { today, year, seasons } = opts;
  switch (key) {
    case 'thisMonth': {
      const ty = +today.slice(0, 4);
      const tm = +today.slice(5, 7);
      return { from: ymd(ty, tm, 1), to: ymd(ty, tm, lastDayOfMonth(ty, tm)) };
    }
    case 'lastMonth': {
      let ty = +today.slice(0, 4);
      let tm = +today.slice(5, 7) - 1;
      if (tm < 1) {
        tm = 12;
        ty -= 1;
      }
      return { from: ymd(ty, tm, 1), to: ymd(ty, tm, lastDayOfMonth(ty, tm)) };
    }
    case 'octDec':
      return { from: ymd(year, 10, 1), to: ymd(year, 12, 31) };
    case 'winter':
      return seasonRange(seasons.winter, year);
    case 'summer':
      return seasonRange(seasons.summer, year);
    case 'custom':
    default:
      return null;
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function isValidSeasonRange(s: unknown): s is SeasonRange {
  if (!s || typeof s !== 'object') return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.startMonth === 'number' &&
    typeof r.startDay === 'number' &&
    typeof r.endMonth === 'number' &&
    typeof r.endDay === 'number'
  );
}

/** Klemmt eine Saison-Range auf gültige Bereiche (Monat 1..12, Tag 1..31). */
export function normalizeSeasonRange(s: SeasonRange): SeasonRange {
  return {
    startMonth: clampInt(s.startMonth, 1, 12),
    startDay: clampInt(s.startDay, 1, 31),
    endMonth: clampInt(s.endMonth, 1, 12),
    endDay: clampInt(s.endDay, 1, 31),
  };
}

/**
 * Parst gespeicherte Saison-Einstellungen (z. B. aus localStorage).  Liefert bei
 * fehlendem/ungültigem Inhalt die Standard-Saisons (kein Wurf).
 */
export function parseSeasonSettings(raw: string | null | undefined): SeasonSettings {
  if (!raw) return DEFAULT_SEASON_SETTINGS;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const winter = isValidSeasonRange(obj.winter)
      ? normalizeSeasonRange(obj.winter)
      : DEFAULT_SEASON_SETTINGS.winter;
    const summer = isValidSeasonRange(obj.summer)
      ? normalizeSeasonRange(obj.summer)
      : DEFAULT_SEASON_SETTINGS.summer;
    return { winter, summer };
  } catch {
    return DEFAULT_SEASON_SETTINGS;
  }
}

export function serializeSeasonSettings(s: SeasonSettings): string {
  return JSON.stringify({
    winter: normalizeSeasonRange(s.winter),
    summer: normalizeSeasonRange(s.summer),
  });
}
