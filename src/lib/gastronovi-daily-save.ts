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
import { upsertVjDailyBatch, type VjDayRecord } from '@/lib/vj-daily-supabase';
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
    updates[r.date] = { [field]: r.total, [foodKey]: r.food, [bevKey]: r.beverage };
    // Take-Away-Anteil (brutto) nur für Ist-Umsätze — Basis der Netto-Berechnung (2.6 % MwSt).
    if (target === 'actual') updates[r.date].takeawayRevenue = r.takeAway;
    count++;
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
      const rec: VjDayRecord = {
        date:          r.date,
        year:          parseInt(r.date.slice(0, 4), 10),
        actualRevenue: r.total,
        source:        'vorjahr_import',
      };
      if (r.food > 0)     rec.foodRevenue     = r.food;
      if (r.beverage > 0) rec.beverageRevenue = r.beverage;
      // Take-Away-Anteil (brutto) auch fürs Vorjahr übernehmen — Quelle der
      // Vorjahr-Spalte «Take Away Anteil» im Monatsreport. Nur setzen wenn >0
      // (rückwärtskompatibel: alte Records ohne Feld bleiben gültig).
      if (r.takeAway > 0) rec.takeawayRevenue = r.takeAway;
      return rec;
    });
    const { upserted } = await upsertVjDailyBatch(records, opts.tenantId);
    vjUpserted = upserted;
  }

  return { blocked: false, count, from: dates[0] ?? null, to: dates.at(-1) ?? null, vjUpserted };
}
