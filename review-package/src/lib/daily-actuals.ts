/**
 * daily-actuals.ts — Effektive Tages-IST-Umsätze (reine Logik, Supabase-frei)
 * ===========================================================================
 * Single Source of Truth für die Frage «Welcher IST-Bruttoumsatz gilt an
 * Tag X des angezeigten Jahres?» — genutzt von Tagesflächen (Tagesansicht,
 * Umsatzabstimmung), NICHT von Monatsflächen (die lesen reporting_v1).
 *
 * Quellen-Priorität je Tag:
 *   1. dailyBudgets-Blob-Eintrag mit actualRevenue > 0  (operative Quelle)
 *   2. vj_daily-Tagesrecord DESSELBEN Jahres            (Jahres-Tagesimport;
 *      auch 0 ist dort ein echter importierter Wert, z. B. Schliessungstag)
 *   3. null = kein Import vorhanden («—», NIE 0)
 *
 * Hinweise:
 * - Blob-Einträge mit actualRevenue === 0 gelten als «kein IST erfasst»
 *   (Legacy-Füllwert aus Planungs-/Budget-Flows); ein echter 0-Wert ist nur
 *   über einen vj_daily-Record desselben Tages darstellbar. Bewusste Grenze.
 * - Keine «Monat hat Daten ⇒ fehlender Tag = 0»-Inferenz: fehlend bleibt null.
 * - Diese Logik liest nur; sie schreibt nie und legt keine Daten an.
 */

export interface BlobDayEntry {
  actualRevenue?:   number;
  takeawayRevenue?: number;
}

export interface VjDayLike {
  actualRevenue: number;
}

export type DailyActualSource = 'dailyBudgets' | 'vj_daily';

export interface EffectiveDailyActual {
  /** Brutto-IST des Tages; null = kein Import vorhanden */
  gross:    number | null;
  /** Takeaway-Anteil (nur aus dailyBudgets bekannt, sonst 0) */
  takeaway: number;
  /** Herkunft des Werts; null wenn gross === null */
  source:   DailyActualSource | null;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Ermittelt den effektiven Tages-IST aus Blob-Eintrag und vj_daily-Record
 * desselben Kalendertags. Reine Funktion, deterministisch.
 */
export function resolveDailyActual(
  blobEntry: BlobDayEntry | undefined,
  vjRecord:  VjDayLike | undefined,
): EffectiveDailyActual {
  const blobGross = blobEntry?.actualRevenue;
  if (isFiniteNumber(blobGross) && blobGross > 0) {
    return {
      gross:    blobGross,
      takeaway: isFiniteNumber(blobEntry?.takeawayRevenue) ? blobEntry!.takeawayRevenue! : 0,
      source:   'dailyBudgets',
    };
  }
  const vjGross = vjRecord?.actualRevenue;
  if (isFiniteNumber(vjGross)) {
    // Auch 0 ist hier ein echter importierter Wert (z. B. Schliessungstag)
    return { gross: vjGross, takeaway: 0, source: 'vj_daily' };
  }
  return { gross: null, takeaway: 0, source: null };
}

/**
 * Baut die effektiven Tages-IST-Werte für eine Liste von ISO-Tagen
 * (z. B. alle Tage eines Monats) auf.
 *
 * @param dayKeys     ISO-Datumsliste 'YYYY-MM-DD' (angezeigter Monat)
 * @param blob        dailyBudgets-Blob (bereits tenant-aufgelöst)
 * @param vjSameYear  vj_daily-Records DESSELBEN Jahres, Key = 'YYYY-MM-DD'
 */
export function buildMonthActuals(
  dayKeys:    readonly string[],
  blob:       Record<string, BlobDayEntry>,
  vjSameYear: Record<string, VjDayLike>,
): Record<string, EffectiveDailyActual> {
  const out: Record<string, EffectiveDailyActual> = {};
  for (const d of dayKeys) {
    out[d] = resolveDailyActual(blob[d], vjSameYear[d]);
  }
  return out;
}

export interface MonthActualsSummary {
  /** Tage mit vorhandenem IST-Wert (inkl. echter 0) */
  daysWithData: number;
  /** Gesamtzahl der übergebenen Tage */
  totalDays:    number;
  /** Summe der vorhandenen Brutto-IST-Werte (fehlende Tage NICHT als 0 gezählt) */
  grossSum:     number;
  /** true, wenn mindestens ein Tag aus vj_daily stammt */
  usesVjDaily:  boolean;
}

/** Zusammenfassung für Status-Anzeigen («N von M Tagen vorhanden»). */
export function summarizeMonthActuals(
  actuals: Record<string, EffectiveDailyActual>,
): MonthActualsSummary {
  let daysWithData = 0, grossSum = 0, usesVjDaily = false;
  const values = Object.values(actuals);
  for (const a of values) {
    if (a.gross !== null) {
      daysWithData += 1;
      grossSum     += a.gross;
      if (a.source === 'vj_daily') usesVjDaily = true;
    }
  }
  return { daysWithData, totalDays: values.length, grossSum, usesVjDaily };
}

/**
 * Effektive Monats-Zusammenfassung direkt aus Blob + vj_daily desselben
 * Jahres (baut die Tages-Keys des Monats selbst auf). Genutzt von der
 * Umsatzabstimmung («Summe Tage» inkl. Jahres-Tagesimport-Fallback).
 * Reine Funktion; grossSum zählt fehlende Tage NICHT als 0.
 */
export function summarizeEffectiveMonth(
  blob:       Record<string, BlobDayEntry>,
  vjSameYear: Record<string, VjDayLike>,
  year:       number,
  month:      number,
): MonthActualsSummary {
  const daysInMonth = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  const dayKeys: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dayKeys.push(`${year}-${mm}-${String(d).padStart(2, '0')}`);
  }
  return summarizeMonthActuals(buildMonthActuals(dayKeys, blob, vjSameYear));
}
