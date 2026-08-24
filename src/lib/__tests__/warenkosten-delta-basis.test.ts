// @vitest-environment happy-dom
/**
 * Cockpit Warenkosten-Zeilen: Δ% = (Ist − Soll) ÷ Ist-Netto-Umsatz (PP-Abweichung
 * der WKQ zum Ziel), NICHT ÷ Soll — via MrRow.deltaPctBasis in mapRowForExport
 * (gleiche Formel wie die Bildschirmtabelle). Kontrollwerte aus dem Build-Befehl.
 */
import { describe, it, expect } from 'vitest';
import { mapRowForExport } from '@/lib/monatsreport-export';
import type { MrRow } from '@/lib/monatsreport';

const row = (p: Partial<MrRow>): MrRow => ({
  type: 'data', id: 'warenkosten_total', label: 'Warenkosten total',
  month: null, week: null, budget: null, vj: null,
  ...p,
} as MrRow);

describe('Warenkosten Δ% auf Ist-Netto-Umsatz (deltaPctBasis)', () => {
  it('Total: Soll 24 % × Ist-Netto; Δ −5\'249.61 → −6.6 % (24.0 − 17.4)', () => {
    const basis = 79_674.95;             // Ist-Netto-Umsatz Monat
    const soll = 19_121.99;              // 24 % × Basis (= Food + Beverage)
    const ist = 13_872.38;               // Ist-WKQ 17.4 %
    const c = mapRowForExport(row({
      month: ist, monthBudget: soll, deltaInverted: true,
      deltaPctBasis: { month: basis, week: null },
    }), 'monat');
    expect(c.devAbs).toBeCloseTo(-5_249.61, 2);
    expect(c.dev!).toBeCloseTo(-6.6, 1);
    expect(c.devGut).toBe(true);         // unter Soll = gut (deltaInverted)
  });

  it('Food: Δ −4\'733.78 → −8.4 %; Beverage: Δ −515.83 → −2.2 %', () => {
    const food = mapRowForExport(row({
      id: 'warenkosten_food', month: 8_821.23, monthBudget: 13_555.01,
      deltaInverted: true, deltaPctBasis: { month: 13_555.01 / 0.24, week: null },
    }), 'monat');
    expect(food.devAbs).toBeCloseTo(-4_733.78, 2);
    expect(food.dev!).toBeCloseTo(-8.4, 1);
    const bev = mapRowForExport(row({
      id: 'warenkosten_beverage', month: 5_051.15, monthBudget: 5_566.98,
      deltaInverted: true, deltaPctBasis: { month: 5_566.98 / 0.24, week: null },
    }), 'monat');
    expect(bev.devAbs).toBeCloseTo(-515.83, 2);
    expect(bev.dev!).toBeCloseTo(-2.2, 1);
  });

  it('Summe stimmt: Total-Soll = Food-Soll + Beverage-Soll (gleiche Ist-Netto-Logik)', () => {
    expect(13_555.01 + 5_566.98).toBeCloseTo(19_121.99, 2);
  });

  it('leer statt 0: ohne Basis oder ohne Ist bleibt Δ% null (nie ÷ 0)', () => {
    expect(mapRowForExport(row({
      month: 100, monthBudget: 120, deltaPctBasis: { month: null, week: null },
    }), 'monat').dev).toBeNull();
    expect(mapRowForExport(row({
      month: 100, monthBudget: 120, deltaPctBasis: { month: 0, week: null },
    }), 'monat').dev).toBeNull();
    expect(mapRowForExport(row({
      month: null, monthBudget: 120, deltaPctBasis: { month: 5000, week: null },
    }), 'monat').dev).toBeNull();
  });

  it('Woche nutzt die Wochen-Basis', () => {
    const c = mapRowForExport(row({
      week: 3_000, weekBudget: 2_400, deltaPctBasis: { month: null, week: 10_000 },
    }), 'woche');
    expect(c.dev!).toBeCloseTo(6.0, 2);  // (3000−2400)÷10000
  });
});
