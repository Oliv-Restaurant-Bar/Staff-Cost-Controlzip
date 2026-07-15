// @vitest-environment happy-dom
// happy-dom (statt node) weil financial-metrics → pl-engine transitiv den
// Supabase-Client lädt, der `localStorage` beim Modul-Load braucht.
/**
 * bpl-aggregate — Perioden-Aggregation (Quartal/Jahr) für die Budget-P&L.
 *
 * Regeln: Beträge über Monate summieren; Abweichungen/Prozente aus den
 * SUMMIERTEN Rohwerten (makeCell-Formel); Kennzahlen null-erhaltend
 * (alle Monate fehlend ⇒ null, NIE 0), Quoten aus Rohsummen — identisch
 * zur Financial-Metrics-Registry (1-Monats-Aggregat ≡ Registry).
 */
import { describe, expect, it } from 'vitest';
import { aggregateBPLRows, aggregateFinancialMetricValues } from '@/lib/bpl-aggregate';
import { getFinancialMetricValues } from '@/lib/financial-metrics';
import type { BPLRowWithValues } from '@/pages/PLView';
import type { PLMonthResult } from '@/types/pl';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** BPL-Zeile mit Rohwerten; vs*-Felder wie in makeCell (PLView) befüllt. */
function row(
  over: Partial<BPLRowWithValues> & { catId: string },
  actual: number,
  budget: number,
  prevYear: number,
): BPLRowWithValues {
  const isExpense = over.isExpense ?? false;
  const vsBudget = actual - budget;
  const vsPrevYear = actual - prevYear;
  return {
    catLabel: over.catId,
    catType: 'items',
    isCategory: false,
    ...over,
    isExpense,
    values: {
      isExpense, actual, budget, prevYear,
      vsBudget,
      vsBudgetPct: budget !== 0 ? (vsBudget / Math.abs(budget)) * 100 : undefined,
      vsPrevYear,
      vsPrevYearPct: prevYear !== 0 ? (vsPrevYear / Math.abs(prevYear)) * 100 : undefined,
    },
  } as BPLRowWithValues;
}

type RowSpec = Record<string, { actual?: number; budget?: number; prevYear?: number }>;

/** Minimales PLMonthResult-Substitut: Registry/Aggregator lesen nur pl.rows. */
function mkPL(rows: RowSpec): PLMonthResult {
  return {
    rows: Object.entries(rows).map(([id, values]) => ({ def: { id }, values })),
  } as unknown as PLMonthResult;
}

// ─── aggregateBPLRows ─────────────────────────────────────────────────────────

describe('aggregateBPLRows', () => {
  it('summiert Rohwerte und berechnet Abweichungen aus den Summen (makeCell-Formel)', () => {
    const m1 = [row({ catId: 'pl_revenue', isCategory: true }, 100_000, 110_000, 90_000)];
    const m2 = [row({ catId: 'pl_revenue', isCategory: true }, 120_000, 115_000, 95_000)];
    const m3 = [row({ catId: 'pl_revenue', isCategory: true }, 80_000, 105_000, 85_000)];

    const { rows } = aggregateBPLRows([m1, m2, m3], [true, true, true]);
    expect(rows).toHaveLength(1);
    const v = rows[0].values;
    expect(v.actual).toBe(300_000);
    expect(v.budget).toBe(330_000);
    expect(v.prevYear).toBe(270_000);
    // Abweichungen aus SUMMEN, nicht Summe der Monats-Abweichungsprozente
    expect(v.vsBudget).toBe(-30_000);
    expect(v.vsBudgetPct).toBeCloseTo((-30_000 / 330_000) * 100, 10);
    expect(v.vsPrevYear).toBe(30_000);
    expect(v.vsPrevYearPct).toBeCloseTo((30_000 / 270_000) * 100, 10);
  });

  it('Budget/VJ 0 in der Summe ⇒ Prozent undefined (kein Division-durch-0-Wert)', () => {
    const m1 = [row({ catId: 'pl_admin', itemId: 'i-6500', isExpense: true }, 500, 0, 0)];
    const m2 = [row({ catId: 'pl_admin', itemId: 'i-6500', isExpense: true }, 300, 0, 0)];
    const { rows } = aggregateBPLRows([m1, m2], [true, true]);
    expect(rows[0].values.actual).toBe(800);
    expect(rows[0].values.vsBudgetPct).toBeUndefined();
    expect(rows[0].values.vsPrevYearPct).toBeUndefined();
  });

  it('Zeilen, die nur in einzelnen Monaten vorkommen, bleiben erhalten und positionsgetreu einsortiert', () => {
    const m1 = [
      row({ catId: 'pl_goods_cost', isCategory: true, isExpense: true }, 800, 900, 0),
      row({ catId: 'pl_goods_cost', itemId: 'i-4000', isExpense: true }, 500, 600, 0),
      row({ catId: 'pl_goods_cost', itemId: 'subtotal_direct', isGroupSubtotal: true, isExpense: true }, 500, 600, 0),
      row({ catId: 'pl_goods_cost', itemId: 'i-4080', isExpense: true }, 300, 300, 0),
      row({ catId: 'pl_goods_cost', itemId: 'subtotal_uebrig', isGroupSubtotal: true, isExpense: true }, 300, 300, 0),
    ];
    const m2 = [
      row({ catId: 'pl_goods_cost', isCategory: true, isExpense: true }, 950, 900, 0),
      row({ catId: 'pl_goods_cost', itemId: 'i-4000', isExpense: true }, 550, 600, 0),
      row({ catId: 'pl_goods_cost', itemId: 'subtotal_direct', isGroupSubtotal: true, isExpense: true }, 550, 600, 0),
      row({ catId: 'pl_goods_cost', itemId: 'i-4080', isExpense: true }, 250, 300, 0),
      // Konto nur im Monat 2 vorhanden:
      row({ catId: 'pl_goods_cost', itemId: 'actual_4090', isExpense: true }, 150, 0, 0),
      row({ catId: 'pl_goods_cost', itemId: 'subtotal_uebrig', isGroupSubtotal: true, isExpense: true }, 400, 300, 0),
    ];

    const { rows } = aggregateBPLRows([m1, m2], [true, true]);
    const ids = rows.map(r => (r.isCategory ? 'CAT' : r.itemId));
    expect(ids).toEqual(['CAT', 'i-4000', 'subtotal_direct', 'i-4080', 'actual_4090', 'subtotal_uebrig']);

    // Nur-Monat-2-Zeile: Werte unverändert übernommen
    const only = rows.find(r => r.itemId === 'actual_4090')!;
    expect(only.values.actual).toBe(150);

    // Summenabstimmung: Subtotal übrig = Summe der Mitglieder (300+250+150)
    const sub = rows.find(r => r.itemId === 'subtotal_uebrig')!;
    expect(sub.values.actual).toBe(700);
    expect(sub.values.actual).toBe(
      rows.filter(r => ['i-4080', 'actual_4090'].includes(r.itemId ?? '')).reduce((s, r) => s + r.values.actual, 0),
    );
  });

  it('zählt monthsWithData aus den Flags (fehlend ≠ 0 sichtbar machen)', () => {
    const m = [row({ catId: 'pl_revenue', isCategory: true }, 0, 100, 0)];
    const res = aggregateBPLRows([m, m, m], [true, false, false]);
    expect(res.monthsWithData).toBe(1);
    expect(res.monthsTotal).toBe(3);
  });
});

// ─── aggregateFinancialMetricValues ───────────────────────────────────────────

describe('aggregateFinancialMetricValues', () => {
  it('1-Monats-Aggregat ≡ getFinancialMetricValues (keine Zweitberechnung)', () => {
    const pl = mkPL({
      net_revenue:     { actual: 100_000, budget: 110_000, prevYear: 90_000 },
      total_cogs:      { actual: 30_000, budget: 33_000, prevYear: 27_000 },
      total_personnel: { actual: 35_000, budget: 36_000, prevYear: 34_000 },
      ebitda:          { actual: 20_000, budget: 22_000, prevYear: 15_000 },
      ebit:            { actual: 15_000, budget: 17_000, prevYear: 10_000 },
    });
    for (const id of ['net_revenue', 'total_cogs', 'ebitda', 'ebit', 'cogs_ratio', 'personnel_ratio', 'ebitda_margin', 'ebit_margin'] as const) {
      expect(aggregateFinancialMetricValues(id, [pl])).toEqual(getFinancialMetricValues(id, { pl }));
    }
  });

  it('Beträge: null-erhaltende Summe — nur Monate mit Wert; alle fehlend ⇒ null, NIE 0', () => {
    const withData = mkPL({ net_revenue: { actual: 100_000, budget: 110_000 } });
    const noActual = mkPL({ net_revenue: { budget: 105_000 } });
    const empty    = mkPL({});

    const v = aggregateFinancialMetricValues('net_revenue', [withData, noActual, empty]);
    expect(v.actual).toBe(100_000);        // fehlende Monate NICHT als 0 gezählt
    expect(v.budget).toBe(215_000);
    expect(v.priorYear).toBeNull();        // nirgends vorhanden ⇒ null

    const allEmpty = aggregateFinancialMetricValues('net_revenue', [empty, empty]);
    expect(allEmpty).toEqual({ actual: null, budget: null, priorYear: null });
  });

  it('Quoten: aus Rohsummen, nicht Durchschnitt der Monatsquoten', () => {
    // Monat 1: 30% Quote (30k/100k) · Monat 2: 50% Quote (10k/20k)
    // Rohsummen: 40k/120k = 33.33% (Durchschnitt der Quoten wäre 40%)
    const m1 = mkPL({ net_revenue: { actual: 100_000 }, total_cogs: { actual: 30_000 } });
    const m2 = mkPL({ net_revenue: { actual: 20_000 }, total_cogs: { actual: 10_000 } });
    const v = aggregateFinancialMetricValues('cogs_ratio', [m1, m2]);
    expect(v.actual).toBeCloseTo((40_000 / 120_000) * 100, 10);
  });

  it('Quoten: Nenner fehlt oder 0 ⇒ null (fehlend ≠ 0)', () => {
    const noRev   = mkPL({ total_cogs: { actual: 5_000 } });
    expect(aggregateFinancialMetricValues('cogs_ratio', [noRev]).actual).toBeNull();

    const zeroRev = mkPL({ net_revenue: { actual: 0 }, total_cogs: { actual: 5_000 } });
    expect(aggregateFinancialMetricValues('cogs_ratio', [zeroRev]).actual).toBeNull();
  });
});
