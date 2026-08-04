/**
 * produkt-zeitraum.ts — Reine Zeitraum-Navigation für die konsolidierte Produktanalyse.
 * ====================================================================================
 * Schnellwahl (Heute / Diese Woche / Letzte 7 Tage / Dieser Monat / Vormonat),
 * Vergleichsperioden (Vorperiode / Vorjahr) und null-sichere Delta-Helfer.
 *
 * KEINE neue Fachlogik: hier wird ausschliesslich auf der bestehenden
 * `PeriodSelection` (product-analytics.ts) navigiert — die Aggregation der
 * Verkaufsdaten bleibt unverändert bei den bestehenden reinen Funktionen.
 *
 * DOM-/Supabase-frei — unter dem node-vitest-Environment testbar.
 * Rundung: keine (Aufrufer runden erst bei Anzeige).
 */

import {
  daysInMonth, isoWeekInfo, isoWeeksInYear, shiftIsoWeek, localISODate, periodBounds,
  type PeriodSelection,
} from './product-analytics';

// ─── kleine Datums-Helfer (lokal, UTC-stabil) ────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function parseISO(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** ISO-Datum um `delta` Tage verschieben (negativ = zurück). */
export function addDays(dateStr: string, delta: number): string {
  const d = parseISO(dateStr);
  d.setUTCDate(d.getUTCDate() + delta);
  return toISO(d);
}

/** Inklusive Tageslänge eines Bereichs (from <= to vorausgesetzt). */
function rangeLengthDays(from: string, to: string): number {
  return Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000) + 1;
}

/**
 * Datum um `deltaYears` Jahre verschieben; Tag wird auf die Monatslänge des
 * Zieljahres geklemmt (29.02. → 28.02. in Nicht-Schaltjahren).
 */
export function shiftYearClamped(dateStr: string, deltaYears: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ty = y + deltaYears;
  const td = Math.min(d, daysInMonth(ty, m));
  return `${ty}-${pad2(m)}-${pad2(td)}`;
}

// ─── Schnellwahl ─────────────────────────────────────────────────────────────

export type QuickRangeKey =
  | 'heute'
  | 'diese-woche'
  | 'letzte-7-tage'
  | 'dieser-monat'
  | 'vormonat';

export const QUICK_RANGE_LABEL: Record<QuickRangeKey, string> = {
  'heute': 'Heute',
  'diese-woche': 'Diese Woche',
  'letzte-7-tage': 'Letzte 7 Tage',
  'dieser-monat': 'Dieser Monat',
  'vormonat': 'Vormonat',
};

export const QUICK_RANGE_KEYS: QuickRangeKey[] = [
  'heute', 'diese-woche', 'letzte-7-tage', 'dieser-monat', 'vormonat',
];

/** Schnellwahl → PeriodSelection (deterministisch über `today` testbar). */
export function quickRangeSelection(key: QuickRangeKey, today: Date = new Date()): PeriodSelection {
  const iso = localISODate(today);
  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  switch (key) {
    case 'heute':
      return { kind: 'day', date: iso };
    case 'diese-woche': {
      const info = isoWeekInfo(iso);
      return { kind: 'week', year: info.year, week: info.week };
    }
    case 'letzte-7-tage':
      return { kind: 'range', from: addDays(iso, -6), to: iso };
    case 'dieser-monat':
      return { kind: 'month', year: curYear, month: curMonth };
    case 'vormonat':
      return curMonth === 1
        ? { kind: 'month', year: curYear - 1, month: 12 }
        : { kind: 'month', year: curYear, month: curMonth - 1 };
  }
}

// ─── Vergleichsperioden ──────────────────────────────────────────────────────

export type CompareMode = 'none' | 'vorperiode' | 'vorjahr';

export const COMPARE_MODE_LABEL: Record<CompareMode, string> = {
  none: 'Kein Vergleich',
  vorperiode: 'Vorperiode',
  vorjahr: 'Vorjahr',
};

/** Unmittelbar vorangehende Periode gleicher Art/Länge. */
export function prevPeriod(sel: PeriodSelection): PeriodSelection {
  switch (sel.kind) {
    case 'day':
      return { kind: 'day', date: addDays(sel.date, -1) };
    case 'week': {
      const prev = shiftIsoWeek(sel.year, sel.week, -1);
      return { kind: 'week', year: prev.year, week: prev.week };
    }
    case 'month':
      return sel.month === 1
        ? { kind: 'month', year: sel.year - 1, month: 12 }
        : { kind: 'month', year: sel.year, month: sel.month - 1 };
    case 'year':
      return { kind: 'year', year: sel.year - 1 };
    case 'range': {
      const { from, to } = periodBounds(sel);
      const len = rangeLengthDays(from, to);
      return { kind: 'range', from: addDays(from, -len), to: addDays(from, -1) };
    }
  }
}

/**
 * Gleiche Periode im Vorjahr.
 * - week: gleiche ISO-KW im Vorjahr; KW 53 wird auf die letzte KW des
 *   Vorjahres geklemmt (52 in 52-Wochen-Jahren).
 * - day/range: Kalenderdatum −1 Jahr, 29.02. → 28.02. in Nicht-Schaltjahren.
 */
export function samePeriodPrevYear(sel: PeriodSelection): PeriodSelection {
  switch (sel.kind) {
    case 'day':
      return { kind: 'day', date: shiftYearClamped(sel.date, -1) };
    case 'week': {
      const py = sel.year - 1;
      return { kind: 'week', year: py, week: Math.min(sel.week, isoWeeksInYear(py)) };
    }
    case 'month':
      return { kind: 'month', year: sel.year - 1, month: sel.month };
    case 'year':
      return { kind: 'year', year: sel.year - 1 };
    case 'range': {
      const { from, to } = periodBounds(sel);
      return { kind: 'range', from: shiftYearClamped(from, -1), to: shiftYearClamped(to, -1) };
    }
  }
}

/** Vergleichsperiode je Modus — `null` bei „Kein Vergleich". */
export function comparisonPeriod(sel: PeriodSelection, mode: CompareMode): PeriodSelection | null {
  if (mode === 'none') return null;
  return mode === 'vorperiode' ? prevPeriod(sel) : samePeriodPrevYear(sel);
}

// ─── Null-sichere Deltas ─────────────────────────────────────────────────────

/** Absolute Veränderung; `null` wenn ein Wert fehlt (fehlend ≠ 0). */
export function deltaAbs(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current == null || previous == null) return null;
  return current - previous;
}

/**
 * Prozentuale Veränderung in % (z. B. +12.5); `null` wenn ein Wert fehlt
 * oder die Basis 0 ist (Division durch 0 wird nie zu 0 % stilisiert).
 */
export function deltaPct(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}
