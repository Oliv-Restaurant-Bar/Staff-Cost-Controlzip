/**
 * gastronovi-daily-save.ts — Speicherlogik für den Gastronovi-Tagesumsatz-Import
 * =============================================================================
 * Ausgelagert aus GastronoviImportSection, damit die neue kombinierte
 * «Tagesdaten-Import»-Karte exakt dieselbe Speicher-Semantik nutzt:
 *   - Feld-Mapping nach Ziel (actual vs. previous_year) wie bisher.
 *   - safeUpsertDailyBudgets(storageKey, updates, false) → KV+localStorage-Merge
 *     pro Tag; ausgewählte Tage dürfen überschrieben werden (onlyIfZero=false).
 *   - Take-Away-Anteil (brutto) nur für Ist-Umsätze.
 *
 * KEINE neue Speicher-Semantik — nur wiederverwendbar gemacht. Die Modus-Wahl
 * (actual vs. previous_year) trifft der Aufrufer anhand des gewählten Jahres:
 * gewähltes Jahr == aktuelles Jahr → 'actual', sonst → 'previous_year'.
 *
 * VORJAHR-DOPPELZIEL: Der Monatsreport/das Cockpit ziehen die Vorjahres-Spalte
 * aus vj_daily (src/lib/vj-daily-supabase.ts), NICHT aus
 * dailyBudgets.previousYearRevenue. Deshalb schreibt der previous_year-Modus die
 * Tageswerte ZUSÄTZLICH per Tag-Merge nach vj_daily — exakt im Format/Key-Schema
 * von VjDailyImportSection ({ date, year, actualRevenue, foodRevenue?,
 * beverageRevenue?, source: 'vorjahr_import' }). vj_daily speichert pro Datum eine
 * eigene Zeile (upsert onConflict 'key'), daher bleiben Tage anderer Zeiträume
 * automatisch erhalten (kein Blob-Überschreiben).
 */

import type { GastronoviDayResult } from '@/lib/revenue-parser';
import { upsertVjDailyBatch, loadVjDailyYearStrict, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { getLockState } from '@/lib/prior-year-lock';

export type UmsatzImportTarget = 'actual' | 'previous_year';

/** Ist das gewählte Jahr das laufende Jahr? → Ist-Pfad, sonst Vorjahres-Pfad. */
export function targetForYear(year: number, currentYear = new Date().getFullYear()): UmsatzImportTarget {
  return year >= currentYear ? 'actual' : 'previous_year';
}

export interface CommitGastronoviOptions {
  /**
   * Mandant für die vj_daily-Schlüssel (tenantPrefix) und die Jahres-Sperre.
   * Im previous_year-Modus wird vj_daily ohne tenantId NICHT befüllt.
   */
  tenantId?: string;
  /**
   * Gewähltes Jahr — nur für die Jahres-Sperre (previous_year) nötig. Fehlt es,
   * wird das Jahr aus dem ersten Datum abgeleitet.
   */
  year?: number;
}

export interface CommitGastronoviResult {
  /** true = Import wurde wegen gesperrtem Vorjahr NICHT ausgeführt (keine Writes). */
  blocked: boolean;
  /** Gesperrtes Jahr (nur bei blocked). */
  lockedYear?: number;
  count: number;
  from: string | null;
  to: string | null;
  vjUpserted: number;
}

/**
 * Speichert die geparsten Gastronovi-Tage in dailyBudgets (tenant-präfixierter
 * storageKey). Überschreibt bestehende Tage (die Vorschau war die Bestätigung).
 *
 * Im previous_year-Modus werden die Tageswerte ZUSÄTZLICH nach vj_daily
 * geschrieben (per Tag, Merge über onConflict 'key'), damit der Monatsreport die
 * Vorjahres-Spalte automatisch aus Jahr−1 lesen kann. Bestehende vj_daily-Tage
 * anderer Zeiträume bleiben erhalten.
 *
 * JAHRES-SPERRE: Für JEDES Ziel wird VOR jedem Write die Jahres-Sperre
 * (prior-year-lock = «Jahr abgeschlossen») für das Jahr der Daten geprüft.
 * Ist das Jahr festgeschrieben, wird NICHTS geschrieben (weder dailyBudgets
 * noch vj_daily) und { blocked: true, lockedYear } zurückgegeben.
 *
 * Gibt blocked-Flag, Anzahl geschriebener Tage, Datumsbereich und (falls
 * zutreffend) die Anzahl vj_daily-Upserts zurück.
 */
export async function commitGastronoviDays(
  storageKey: string,
  rows: GastronoviDayResult[],
  target: UmsatzImportTarget,
  opts: CommitGastronoviOptions = {},
): Promise<CommitGastronoviResult> {
  // ── Jahres-Sperre prüfen (JEDES Ziel) — VOR jedem Write ──
  // Jahresbasierte Datenhaltung: ein «abgeschlossenes» Jahr ist komplett
  // schreibgeschützt — auch Ist-Importe in ein festgeschriebenes Jahr werden
  // geblockt, nicht nur der Vorjahres-Pfad.
  if (rows.length > 0) {
    const year = opts.year ?? parseInt(rows[0].date.slice(0, 4), 10);
    const lock = await getLockState(opts.tenantId ?? 'oliv', year);
    if (lock.locked) {
      console.warn(`[PRIOR-YEAR] commit blocked: locked | tenant: ${opts.tenantId ?? 'oliv'} | year: ${year}`);
      return { blocked: true, lockedYear: year, count: 0, from: null, to: null, vjUpserted: 0 };
    }
  }

  const field   = target === 'actual' ? 'actualRevenue'  : 'previousYearRevenue';
  const foodKey = target === 'actual' ? 'actualFood'      : 'previousYearFood';
  const bevKey  = target === 'actual' ? 'actualBeverage'  : 'previousYearBeverage';

  const { safeUpsertDailyBudgets } = await import('@/lib/supabase-kv');

  const updates: Record<string, Record<string, unknown>> = {};
  const dates = rows.map(r => r.date).sort();
  let count = 0;

  for (const r of rows) {
    // Food/Beverage NUR schreiben, wenn wirklich geliefert (> 0): 0 heisst hier
    // «Zeile fehlt/leer» — eine bestehende Aufteilung (z.B. aus dem
    // Verkaufsdaten-Import) darf ein Import ohne F/B-Zeilen nie nullen.
    updates[r.date] = { [field]: r.total };
    if (r.food > 0) updates[r.date][foodKey] = r.food;
    if (r.beverage > 0) updates[r.date][bevKey] = r.beverage;
    // Take-Away-Brutto pro Tag — Basis des präzisen Netto-MwSt-Splits (2.6 %/8.1 %).
    // Für BEIDE Ziele schreiben: auch vergangene Jahre brauchen den Split für
    // ihre Ist-Ansichten und fürs dynamische Vorjahr (Jahr + 1).
    // NUR wenn die Datei eine Take-Away-Zeile hat (undefined = nicht geliefert
    // → bestehende Werte nie überschreiben; explizite 0 = echter Tageswert).
    if (r.takeAway !== undefined) updates[r.date].takeawayRevenue = r.takeAway;
    // Vorjahres-Import: die Kategorie-Felder zusätzlich als actual* schreiben —
    // dailyBudgets ist nach echtem Datum organisiert, d.h. actualFood/actual-
    // Beverage eines 2025er-Tages SIND die Ist-Werte 2025 (Cockpit-Zeilen
    // Food/Beverage) und die Quelle des dynamischen Vorjahres in 2026.
    // Nur bei Wert > 0 (0 hier = Zeile fehlt/leer — bestehende Werte anderer
    // Importe, z.B. Verkaufsdaten Food/Beverage, nie mit 0 clobbern).
    // actualRevenue wird bewusst NICHT angefasst (bleibt Sache der Ist-Importe).
    if (target === 'previous_year') {
      if (r.food > 0) updates[r.date].actualFood = r.food;
      if (r.beverage > 0) updates[r.date].actualBeverage = r.beverage;
    }
    count++;
  }

  // ── Vorjahr: vj_daily-Merge-Basis STRIKT lesen — VOR dem ERSTEN Write ──────
  // upsertVjDailyBatch ersetzt den ganzen Record eines Tages. Damit ein Import
  // ohne Food/Beverage/Take-Away-Zeilen bestehende Kategorie-Werte (z.B. aus
  // dem Verkaufsdaten-Import) nicht auslöscht, wird der Bestand des Jahres
  // feldweise gemerged. Lesefehler wirft → Abbruch OHNE jegliche Writes
  // (weder dailyBudgets noch vj_daily), nie stillschweigend leer mergen.
  let vjBase: Record<string, VjDayRecord> = {};
  if (target === 'previous_year' && rows.length > 0) {
    const vjYear = opts.year ?? parseInt(rows[0].date.slice(0, 4), 10);
    vjBase = await loadVjDailyYearStrict(vjYear, opts.tenantId);
  }

  if (count > 0) {
    await safeUpsertDailyBudgets(storageKey, updates, false);
  }

  // ── Vorjahr: zusätzlich nach vj_daily (Quelle der Report-Vorjahres-Spalte) ──
  let vjUpserted = 0;
  if (target === 'previous_year' && rows.length > 0) {
    // Format/Key-Schema exakt wie VjDailyImportSection. year je Tag aus dem
    // ISO-Datum abgeleitet (die Datei deckt genau das gewählte Jahr ab).
    const records: VjDayRecord[] = rows.map(r => {
      const prev = vjBase[r.date];
      const rec: VjDayRecord = {
        ...(prev ?? {}),
        date:          r.date,
        year:          parseInt(r.date.slice(0, 4), 10),
        actualRevenue: r.total,
        source:        'vorjahr_import',
      };
      // Feldweiser Merge: nur liefern, was die Datei tatsächlich enthält —
      // fehlende Kategorien behalten den bestehenden Wert (aus ...prev).
      if (r.food > 0)     rec.foodRevenue     = r.food;
      if (r.beverage > 0) rec.beverageRevenue = r.beverage;
      // Take Away: undefined = Zeile fehlt → Bestand behalten; sonst ist der
      // Dateiwert massgeblich (auch explizite 0 ersetzt einen alten Wert).
      if (r.takeAway !== undefined) rec.takeawayRevenue = r.takeAway;
      return rec;
    });
    const { upserted } = await upsertVjDailyBatch(records, opts.tenantId);
    vjUpserted = upserted;
  }

  return { blocked: false, count, from: dates[0] ?? null, to: dates.at(-1) ?? null, vjUpserted };
}
