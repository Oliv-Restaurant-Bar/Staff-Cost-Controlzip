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
}

export interface WeekdayAggregate {
  /** Immer alle 7 Wochentage Mo→So (auch leere). */
  weekdays: WeekdayStat[];
  totalReservations: number;
  totalPersons: number;
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
  }));
  return { weekdays, totalReservations, totalPersons };
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

// ── Zusammenfassung ──────────────────────────────────────────────────────────

export interface WeekdayExtreme {
  weekday: IsoWeekday;
  reservations: number;
  persons: number;
}

export interface MonthExtreme {
  monthKey: string;
  reservations: number;
  persons: number;
}

export interface WeekdaySummary {
  /** Stärkster Wochentag (meiste Reservationen). */
  strongestWeekday: WeekdayExtreme | null;
  /** Schwächster Wochentag (wenigste Reservationen, nur Tage mit >0). */
  weakestWeekday: WeekdayExtreme | null;
  /** Fokus-Wochentag für den Monatsvergleich. */
  focusWeekday: IsoWeekday;
  /** Bester Monat für den Fokus-Wochentag. */
  bestMonthForWeekday: MonthExtreme | null;
  /** Schwächster Monat für den Fokus-Wochentag (nur Monate mit >0). */
  worstMonthForWeekday: MonthExtreme | null;
}

/**
 * Leitet die Kennzahlen-Zusammenfassung ab.
 *
 * Vergleichsregel (bewusst, in den Tests fixiert): leere Eimer werden ignoriert.
 * Stärkster/schwächster Wochentag werden NUR über Wochentage mit mindestens
 * einer Reservation bestimmt; bester/schwächster Monat NUR über Monate, in denen
 * der Fokus-Wochentag mindestens eine Reservation hat.  Bei Gleichstand gewinnt
 * der frühere Wochentag bzw. der frühere Monat.
 */
export function buildWeekdaySummary(
  agg: WeekdayAggregate,
  matrix: MonthWeekdayMatrix,
  focusWeekday: IsoWeekday,
): WeekdaySummary {
  let strongest: WeekdayExtreme | null = null;
  let weakest: WeekdayExtreme | null = null;
  for (const w of agg.weekdays) {
    if (w.reservations <= 0) continue;
    const e: WeekdayExtreme = { weekday: w.weekday, reservations: w.reservations, persons: w.persons };
    if (!strongest || e.reservations > strongest.reservations) strongest = e;
    if (!weakest || e.reservations < weakest.reservations) weakest = e;
  }

  let best: MonthExtreme | null = null;
  let worst: MonthExtreme | null = null;
  for (const row of matrix.months) {
    const cell = row.cells[focusWeekday];
    if (cell.reservations <= 0) continue;
    const e: MonthExtreme = { monthKey: row.monthKey, reservations: cell.reservations, persons: cell.persons };
    if (!best || e.reservations > best.reservations) best = e;
    if (!worst || e.reservations < worst.reservations) worst = e;
  }

  return {
    strongestWeekday: strongest,
    weakestWeekday: weakest,
    focusWeekday,
    bestMonthForWeekday: best,
    worstMonthForWeekday: worst,
  };
}

// ── Schnell-Auswahl / Saison-Zeiträume ───────────────────────────────────────

export interface DateRange {
  from: string;
  to: string;
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
