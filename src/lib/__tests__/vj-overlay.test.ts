// @vitest-environment node
/**
 * Dynamische Vorjahres-Überlagerung — FELDWEISER Merge (Variante 2)
 * ==================================================================
 * Spec: pro Feld (Food/Beverage/Take-Away) gewinnt das Jahr-−1-Ist nur mit
 * echtem Wert (> 0); fehlt es (0/leer), bleibt der vj_daily-Wert erhalten.
 * Ein blosser Gesamt-Tagesumsatz darf die Kategorien NIE überlagern/nullen.
 */
import { describe, it, expect } from 'vitest';
import { istAlsVjRecord } from '@/lib/vj-overlay';
import type { UmsatzTag } from '@/lib/umsatz';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

const tag = (t: Partial<UmsatzTag>): UmsatzTag => ({
  datum: '2025-03-10', gesamtBrutto: 0, takeAwayBrutto: 0,
  foodBrutto: 0, beverageBrutto: 0, marketingNetto: 0, ...t,
});

const prev: VjDayRecord = {
  date: '2025-03-10', year: 2025, actualRevenue: 8000,
  foodRevenue: 5200, beverageRevenue: 2600, takeawayRevenue: 480,
  source: 'verkaufsdaten_import',
};

describe('istAlsVjRecord — feldweiser Merge', () => {
  it('Kernfall: Jahr-−1-Ist hat NUR Gesamtumsatz → vj_daily-Food/Bev/TA bleiben erhalten', () => {
    // 2026er-Report: dailyBudgets 2025 hat nur actualRevenue, Kategorien = 0.
    const r = istAlsVjRecord('2025-03-10', tag({ gesamtBrutto: 8100 }), prev);
    expect(r.actualRevenue).toBe(8100);       // Ist überlagert den Gesamtwert
    expect(r.foodRevenue).toBe(5200);         // vj_daily NICHT genullt
    expect(r.beverageRevenue).toBe(2600);
    expect(r.takeawayRevenue).toBe(480);
    expect(r.source).toBe('ist_vorjahr_dynamisch');
  });

  it('vorhandene Ist-Kategorien überlagern; fehlende fallen einzeln auf vj_daily zurück', () => {
    const r = istAlsVjRecord('2025-03-10',
      tag({ gesamtBrutto: 8100, foodBrutto: 5500 }), prev);
    expect(r.foodRevenue).toBe(5500);         // Ist gewinnt (echter Wert)
    expect(r.beverageRevenue).toBe(2600);     // fehlt im Ist → vj_daily
    expect(r.takeawayRevenue).toBe(480);      // fehlt im Ist → vj_daily
  });

  it('ohne vj_daily-Record: nur gelieferte Ist-Felder erscheinen, keine erfundenen 0-Felder', () => {
    const r = istAlsVjRecord('2025-03-10', tag({ gesamtBrutto: 8100 }), undefined);
    expect(r.actualRevenue).toBe(8100);
    expect(r.foodRevenue).toBeUndefined();
    expect(r.beverageRevenue).toBeUndefined();
    expect(r.takeawayRevenue).toBeUndefined();
  });

  it('vj_daily ohne Kategorien + Ist ohne Kategorien → Felder bleiben leer (nie 0 erfinden)', () => {
    const bare: VjDayRecord = { date: '2025-03-10', year: 2025, actualRevenue: 7000, source: 'vorjahr_import' };
    const r = istAlsVjRecord('2025-03-10', tag({ gesamtBrutto: 8100 }), bare);
    expect(r.foodRevenue).toBeUndefined();
    expect(r.beverageRevenue).toBeUndefined();
  });
});
