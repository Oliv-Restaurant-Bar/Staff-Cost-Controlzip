/**
 * gn-zeitabschnitte — Zeitabschnittsanalyse (reine Logik, kein IO)
 *
 * Analyse der Stundenumsätze («Auswertungen → Zeitabschnitte») aus dem
 * Gastronovi-Z-Bericht-PDF: Umsatz und Anteil je Stunde, stärkste
 * Umsatzstunde, schwächste AKTIVE Umsatzstunde, Mittags-/Abendumsatz,
 * Umsatz vor/ab 17:00 und Peak-Zeitfenster.
 *
 * Regeln:
 * - Zeitfenster sind ZENTRAL und transparent hier definiert — UI und
 *   Exporte verwenden ausschliesslich diese Konstanten, keine eigenen
 *   Definitionen.
 * - Negative Stundenwerte (z. B. Korrekturen um 23:00) bleiben erhalten,
 *   nichts wird auf 0 begrenzt.
 * - Fehlend ≠ 0: keine Stunden im Fenster ⇒ null, nie 0.
 */

import type { GnHourlyRevenueRow } from './gn-zbericht-parser';

// ── Zentrale Zeitfenster-Definitionen ─────────────────────────────────────────

export const GN_ZEITFENSTER = {
  /** Mittag: Stunden 11–13 (11:00–13:59) */
  mittag: { fromHour: 11, toHour: 13, label: 'Mittag (11:00–14:00)' },
  /** Abend: Stunden 17–23 (17:00–23:59) */
  abend: { fromHour: 17, toHour: 23, label: 'Abend (17:00–24:00)' },
  /** Tagesgrenze für «vor 17:00» / «ab 17:00» */
  grenzeStunde: 17,
  /** Peak-Zeitfenster: stärkstes zusammenhängendes Fenster dieser Länge */
  peakFensterStunden: 3,
} as const;

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnStundenWert {
  /** Stunde 0–23 */
  hour: number;
  /** Anzeige-Label, z. B. «23:00» */
  label: string;
  /** Umsatz der Stunde (kann negativ sein) */
  totalAmount: number;
  /** Anteil am Gesamtumsatz in % (roh berechnet); null wenn Gesamt 0 */
  sharePct: number | null;
}

export interface GnPeakFenster {
  fromHour: number;
  /** Letzte enthaltene Stunde (inklusiv) */
  toHour: number;
  /** Anzeige-Label, z. B. «19:00–22:00» */
  label: string;
  totalAmount: number;
}

export interface GnZeitabschnittsAnalyse {
  /** Stundenwerte, sortiert nach Stunde; Anteil roh aus dem Gesamtumsatz. */
  hours: GnStundenWert[];
  /** Summe aller Stundenwerte (inkl. negativer). */
  total: number;
  /** Stunde mit dem höchsten Umsatz. */
  strongestHour: GnStundenWert | null;
  /** Stunde mit dem tiefsten Umsatz unter den AKTIVEN Stunden (Wert ≠ 0). */
  weakestActiveHour: GnStundenWert | null;
  /** Umsatz im Mittagsfenster; null wenn keine Stunde im Fenster vorhanden. */
  mittagRevenue: number | null;
  /** Umsatz im Abendfenster; null wenn keine Stunde im Fenster vorhanden. */
  abendRevenue: number | null;
  /** Umsatz vor 17:00; null wenn keine Stunde vor 17:00 vorhanden. */
  vor17Revenue: number | null;
  /** Umsatz ab 17:00; null wenn keine Stunde ab 17:00 vorhanden. */
  ab17Revenue: number | null;
  /** Stärkstes zusammenhängendes Zeitfenster (Länge zentral definiert). */
  peakWindow: GnPeakFenster | null;
}

// ── Helfer ────────────────────────────────────────────────────────────────────

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// ── Mehrtages-Merge ───────────────────────────────────────────────────────────

/**
 * Summiert Stundenwerte über mehrere Tage (Stunde für Stunde).
 * Zeilen ohne parsebare Stunde werden ausgelassen; sharePct wird bewusst
 * verworfen — die Analyse berechnet Anteile neu aus den Summen.
 */
export function mergeGnStundenwerte(
  rowsList: ReadonlyArray<readonly GnHourlyRevenueRow[]>,
): GnHourlyRevenueRow[] {
  const byHour = new Map<number, number>();
  for (const rows of rowsList) {
    for (const r of rows) {
      if (r.hour === null || r.hour < 0 || r.hour > 23) continue;
      if (typeof r.totalAmount !== 'number' || !Number.isFinite(r.totalAmount)) continue;
      byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.totalAmount);
    }
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, totalAmount]) => ({
      label: hourLabel(hour),
      hour,
      totalAmount,
      sharePct: null,
    }));
}

// ── Analyse ───────────────────────────────────────────────────────────────────

/**
 * Analysiert Stundenumsätze. Zeilen ohne parsebare Stunde (hour === null)
 * werden ausgelassen (nicht fensterbar). Ergebnis null, wenn keine
 * verwertbaren Stunden vorhanden sind.
 */
export function analyzeGnZeitabschnitte(
  rows: readonly GnHourlyRevenueRow[] | null | undefined,
): GnZeitabschnittsAnalyse | null {
  if (!rows || rows.length === 0) return null;

  const byHour = new Map<number, number>();
  for (const r of rows) {
    if (r.hour === null || r.hour < 0 || r.hour > 23) continue;
    if (typeof r.totalAmount !== 'number' || !Number.isFinite(r.totalAmount)) continue;
    byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.totalAmount);
  }
  if (byHour.size === 0) return null;

  const total = [...byHour.values()].reduce((s, v) => s + v, 0);

  const hours: GnStundenWert[] = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, amount]) => ({
      hour,
      label: hourLabel(hour),
      totalAmount: amount,
      sharePct: total !== 0 ? (amount / total) * 100 : null,
    }));

  // Stärkste Stunde: höchster Wert (bei Gleichstand die frühere Stunde).
  let strongestHour: GnStundenWert | null = null;
  for (const h of hours) {
    if (strongestHour === null || h.totalAmount > strongestHour.totalAmount) strongestHour = h;
  }

  // Schwächste AKTIVE Stunde: tiefster Wert unter Stunden mit Wert ≠ 0
  // (negative Korrekturen bleiben und können die schwächste Stunde sein).
  let weakestActiveHour: GnStundenWert | null = null;
  for (const h of hours) {
    if (h.totalAmount === 0) continue;
    if (weakestActiveHour === null || h.totalAmount < weakestActiveHour.totalAmount) {
      weakestActiveHour = h;
    }
  }

  // Fenster-Summen: fehlend ≠ 0 — keine Stunde im Fenster ⇒ null.
  const sumWindow = (pred: (hour: number) => boolean): number | null => {
    let sum = 0;
    let any = false;
    for (const h of hours) {
      if (!pred(h.hour)) continue;
      sum += h.totalAmount;
      any = true;
    }
    return any ? sum : null;
  };

  const { mittag, abend, grenzeStunde, peakFensterStunden } = GN_ZEITFENSTER;
  const mittagRevenue = sumWindow(h => h >= mittag.fromHour && h <= mittag.toHour);
  const abendRevenue  = sumWindow(h => h >= abend.fromHour && h <= abend.toHour);
  const vor17Revenue  = sumWindow(h => h < grenzeStunde);
  const ab17Revenue   = sumWindow(h => h >= grenzeStunde);

  // Peak-Zeitfenster: stärkstes zusammenhängendes Fenster fester Länge.
  // Nicht vorhandene Stunden zählen 0; das Fenster muss mindestens eine
  // vorhandene Stunde enthalten.
  let peakWindow: GnPeakFenster | null = null;
  const w = peakFensterStunden;
  for (let start = 0; start <= 24 - w; start++) {
    let sum = 0;
    let any = false;
    for (let h = start; h < start + w; h++) {
      if (byHour.has(h)) {
        sum += byHour.get(h)!;
        any = true;
      }
    }
    if (!any) continue;
    if (peakWindow === null || sum > peakWindow.totalAmount) {
      peakWindow = {
        fromHour: start,
        toHour: start + w - 1,
        label: `${hourLabel(start)}–${hourLabel((start + w) % 24)}`,
        totalAmount: sum,
      };
    }
  }

  return {
    hours,
    total,
    strongestHour,
    weakestActiveHour,
    mittagRevenue,
    abendRevenue,
    vor17Revenue,
    ab17Revenue,
    peakWindow,
  };
}
