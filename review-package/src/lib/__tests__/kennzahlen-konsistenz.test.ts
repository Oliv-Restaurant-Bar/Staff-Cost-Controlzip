// @vitest-environment node
/**
 * Kennzahlen-Konsistenz (SSoT-Regression, Stabilisierungsrunde 2)
 * ===============================================================
 * Sichert die Vereinheitlichungen dieser Runde ab:
 *
 * 1. verkaufsWesQuote (warenkosten-quote.ts) ist die EINZIGE Formel der
 *    verkaufsbasierten WES-Quote (Verkaufs-Dashboard: KPI-Karte, Quellen-
 *    Tabelle, Top-Produkte-Tabelle, Excel-/PDF-Export nutzen dieselbe
 *    Funktion). Fehlende Basis ⇒ null, NIE 0 (fehlend ≠ 0).
 *
 * 2. calcAnnualSummary (reporting-store.ts) ist die EINZIGE Jahresaggregation
 *    für Umsatz Ist/Vorjahr — das Dashboard (Vorjahresumsatz, period='year')
 *    konsumiert sie statt einer eigenen reduce-Zweitberechnung. Der Test
 *    fixiert die Semantik: Summe über alle 12 Monate, fehlende Werte = 0.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// localStorage-Stub (reporting-store liest localStorage)
const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

// Supabase-Client stubben (reporting-store importiert supabase-kv)
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        limit: async () => ({ data: [], error: null }),
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

import { warenkostenQuote, verkaufsWesQuote } from '../warenkosten-quote';
import { calcAnnualSummary, loadYear, STORAGE_KEY } from '../reporting-store';
import { monthId, createEmptyMonth } from '@/types/reporting';

// ─── 1) Verkaufsbasierte WES-Quote ───────────────────────────────────────────

describe('verkaufsWesQuote (SSoT der verkaufsbasierten WES-Quote)', () => {
  it('berechnet die Quote unrundiert (WES ÷ Umsatz × 100)', () => {
    expect(verkaufsWesQuote(250, 1000)).toBeCloseTo(25, 10);
    expect(verkaufsWesQuote(1, 3)).toBeCloseTo(33.333333333, 6);
  });

  it('liefert null (nie 0) bei fehlender Umsatzbasis', () => {
    expect(verkaufsWesQuote(250, 0)).toBeNull();
    expect(verkaufsWesQuote(250, -5)).toBeNull();
    expect(verkaufsWesQuote(250, null)).toBeNull();
    expect(verkaufsWesQuote(250, undefined)).toBeNull();
    expect(verkaufsWesQuote(250, NaN)).toBeNull();
  });

  it('liefert null (nie 0) bei fehlendem WES', () => {
    expect(verkaufsWesQuote(0, 1000)).toBeNull();
    expect(verkaufsWesQuote(-1, 1000)).toBeNull();
    expect(verkaufsWesQuote(null, 1000)).toBeNull();
    expect(verkaufsWesQuote(undefined, 1000)).toBeNull();
    expect(verkaufsWesQuote(NaN, 1000)).toBeNull();
  });

  it('bleibt fachlich getrennt von der operativen warenkostenQuote (andere Kennzahl, gleiche Null-Semantik)', () => {
    // Beide Quoten: fehlender Umsatz ⇒ null
    expect(warenkostenQuote(500, 0)).toBeNull();
    expect(verkaufsWesQuote(500, 0)).toBeNull();
    // Unterschied: operative Quote erlaubt 0-Kosten (0 %), Verkaufs-Quote
    // wertet WES ≤ 0 als fehlende Basis (Stammdaten-WES nicht gepflegt).
    expect(warenkostenQuote(0, 1000)).toBe(0);
    expect(verkaufsWesQuote(0, 1000)).toBeNull();
  });
});

// ─── 2) Jahresaggregation Umsatz (Dashboard = calcAnnualSummary) ─────────────

describe('calcAnnualSummary als einzige Jahresaggregation (Dashboard-Regression)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function seedMonth(year: number, month: number, patch: Record<string, unknown>) {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    all[monthId(year, month)] = { ...createEmptyMonth(year, month), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  it('totalRevenueActual = Summe der Monats-revenueActual (fehlende Monate zählen 0)', () => {
    seedMonth(2025, 1, { revenueActual: 100_000 });
    seedMonth(2025, 2, { revenueActual: 120_500.5 });
    seedMonth(2025, 7, { revenueActual: 98_765 });
    // Monate 3–6, 8–12 fehlen bewusst

    const summary = calcAnnualSummary(2025);
    const manual = loadYear(2025).reduce((s, m) => s + (m.revenueActual ?? 0), 0);

    expect(summary.totalRevenueActual).toBeCloseTo(manual, 8);
    expect(summary.totalRevenueActual).toBeCloseTo(319_265.5, 8);
  });

  it('totalRevenuePreviousYear = Summe der Monats-revenuePreviousYear (Dashboard-Vorjahrespfad)', () => {
    seedMonth(2026, 1, { revenueActual: 90_000, revenuePreviousYear: 85_000 });
    seedMonth(2026, 3, { revenuePreviousYear: 70_000 });

    const summary = calcAnnualSummary(2026);
    const manual = loadYear(2026).reduce((s, m) => s + (m.revenuePreviousYear ?? 0), 0);

    expect(summary.totalRevenuePreviousYear).toBeCloseTo(manual, 8);
    expect(summary.totalRevenuePreviousYear).toBeCloseTo(155_000, 8);
  });

  it('leeres Jahr ⇒ Totale 0 und monthsWithData 0 (kein Erfinden von Werten)', () => {
    const summary = calcAnnualSummary(2019);
    expect(summary.totalRevenueActual).toBe(0);
    expect(summary.totalRevenuePreviousYear).toBe(0);
    expect(summary.monthsWithData).toBe(0);
  });
});
