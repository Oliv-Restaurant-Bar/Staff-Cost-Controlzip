// @vitest-environment happy-dom
//
// Gleichheits-Absicherung: aggregateBPLRows repliziert die makeCell-Formel
// aus PLView exakt — das 1-Monats-Aggregat der echten computeBPLRows-Zeilen
// muss zellgenau identisch mit den Original-Zeilen sein, und Mehrmonats-
// Aggregate müssen den makeCell-Ergebnissen auf den Rohsummen entsprechen.
import { describe, it, expect } from 'vitest';
import { computeBPLRows } from '@/pages/PLView';
import { aggregateBPLRows } from '@/lib/bpl-aggregate';
import type { BudgetYear, BudgetPLCategory, BudgetPLLineItem } from '@/types/budget';
import type { MonthlyFinancialRecord } from '@/types/reporting';

const MONTHS_ZERO = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as BudgetPLLineItem['monthlyValues'];

function makeItem(over: Partial<BudgetPLLineItem> & { id: string; accountNumber: string; categoryId: string }): BudgetPLLineItem {
  return {
    label: over.accountNumber,
    valueType: 'chf',
    monthlyValues: MONTHS_ZERO,
    sortOrder: 0,
    ...over,
  };
}

function makeBudget(items: BudgetPLLineItem[], cats: BudgetPLCategory[]): BudgetYear {
  return {
    year: 2026,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    plCategories: cats,
    plLineItems: items,
  };
}

function makeRecord(month: number, revenueActual: number, expenseCategories: MonthlyFinancialRecord['expenseCategories']): MonthlyFinancialRecord {
  return {
    id: `2026-${String(month).padStart(2, '0')}`,
    year: 2026,
    month,
    revenueActual,
    expenseCategories,
  } as MonthlyFinancialRecord;
}

const CATS: BudgetPLCategory[] = [
  { id: 'pl_revenue',    label: 'Betriebsertrag', type: 'items', isExpense: false, sortOrder: 1, color: 'green' },
  { id: 'pl_goods_cost', label: 'Warenaufwand',   type: 'items', isExpense: true,  sortOrder: 2, color: 'orange' },
  {
    id: 'pl_gross_1', label: 'Bruttogewinn 1', type: 'result', isExpense: false, sortOrder: 3, color: 'blue',
    resultFormula: [
      { categoryId: 'pl_revenue', sign: 1 },
      { categoryId: 'pl_goods_cost', sign: -1 },
    ],
  },
];

const monthly = (vals: Partial<Record<number, number>>): BudgetPLLineItem['monthlyValues'] => {
  const a = [...MONTHS_ZERO] as number[];
  for (const [k, v] of Object.entries(vals)) a[Number(k)] = v ?? 0;
  return a as BudgetPLLineItem['monthlyValues'];
};

const ITEMS: BudgetPLLineItem[] = [
  makeItem({ id: 'i-3000', accountNumber: '3000', categoryId: 'pl_revenue',    label: 'Umsatz Küche',  sortOrder: 1, monthlyValues: monthly({ 0: 110_000, 1: 115_000, 2: 105_000 }) }),
  makeItem({ id: 'i-4000', accountNumber: '4000', categoryId: 'pl_goods_cost', label: 'Einkauf Food',  sortOrder: 1, monthlyValues: monthly({ 0: 30_000, 1: 31_000, 2: 29_000 }) }),
  makeItem({ id: 'i-4080', accountNumber: '4080', categoryId: 'pl_goods_cost', label: 'Verpackung',    sortOrder: 2, monthlyValues: monthly({ 0: 2_000, 1: 2_000, 2: 2_000 }) }),
];

const RECS: MonthlyFinancialRecord[] = [
  makeRecord(1, 100_000, [
    { categoryId: '4000', label: 'Einkauf Food', amount: 28_000 },
    { categoryId: '4080', label: 'Verpackung', amount: 1_800 },
  ]),
  makeRecord(2, 120_000, [
    { categoryId: '4000', label: 'Einkauf Food', amount: 33_000 },
  ]),
  makeRecord(3, 90_000, [
    { categoryId: '4000', label: 'Einkauf Food', amount: 26_000 },
    { categoryId: '4090', label: 'Sonstiger Aufwand', amount: 900 },
  ]),
];

describe('aggregateBPLRows ≡ computeBPLRows (makeCell-Formel-Gleichheit)', () => {
  const budget = makeBudget(ITEMS, CATS);

  it('1-Monats-Aggregat ist zellgenau identisch mit den Original-Zeilen', () => {
    const rows = computeBPLRows(budget, RECS[0], 0);
    const { rows: agg } = aggregateBPLRows([rows], [true]);
    expect(agg).toHaveLength(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(agg[i].itemId).toBe(rows[i].itemId);
      expect(agg[i].catId).toBe(rows[i].catId);
      expect(agg[i].values).toEqual(rows[i].values);
    }
  });

  it('Quartals-Aggregat: Beträge = Summe der Monatszeilen, Abweichungen aus Rohsummen', () => {
    const perMonth = [0, 1, 2].map(mIdx => computeBPLRows(budget, RECS[mIdx], mIdx));
    const { rows: agg, monthsWithData, monthsTotal } = aggregateBPLRows(perMonth, [true, true, true]);
    expect(monthsWithData).toBe(3);
    expect(monthsTotal).toBe(3);

    // Umsatz-Kategorie: 100k+120k+90k Ist, 110k+115k+105k Budget
    const rev = agg.find(r => r.catId === 'pl_revenue' && r.isCategory)!;
    expect(rev.values.actual).toBe(310_000);
    expect(rev.values.budget).toBe(330_000);
    expect(rev.values.vsBudget).toBe(-20_000);
    expect(rev.values.vsBudgetPct).toBeCloseTo((-20_000 / 330_000) * 100, 10);

    // Ergebniszeile bleibt konsistent: BG1 = Umsatz − Warenaufwand (aggregiert)
    const goods = agg.find(r => r.catId === 'pl_goods_cost' && r.isCategory)!;
    const bg1   = agg.find(r => r.catId === 'pl_gross_1' && r.isCategory)!;
    expect(bg1.values.actual).toBeCloseTo(rev.values.actual - goods.values.actual, 6);
    expect(bg1.values.budget).toBeCloseTo(rev.values.budget - goods.values.budget, 6);

    // Konto 4090 existiert nur im März → bleibt erhalten, Werte unverändert
    const only = agg.find(r => r.itemId === 'actual_4090');
    expect(only).toBeDefined();
    expect(only!.values.actual).toBe(900);

    // Konto 4080: Ist nur Jan (1'800), Budget alle 3 Monate (6'000)
    const packRow = agg.find(r => r.itemId === 'i-4080')!;
    expect(packRow.values.actual).toBe(1_800);
    expect(packRow.values.budget).toBe(6_000);

    // Warenaufwand-Zwischentotale: Summe der Mitglieder stimmt ab
    const subDirect = agg.find(r => r.itemId === 'subtotal_direct')!;
    expect(subDirect.values.actual).toBe(28_000 + 33_000 + 26_000);
  });
});
