// @vitest-environment happy-dom
//
// Testet die Warenaufwand-Gruppierung in der klassischen Budget-P&L-Ansicht
// (computeBPLRows in PLView.tsx): Zeilen der Kategorie pl_goods_cost werden
// nach numerischer Range geordnet (4020–4070 direkt / 4000–4019 u. 4071–4899 übrig) und
// mit Zwischentotal-Zeilen «Direkter/Übriger Warenaufwand» versehen.
// Leere Gruppen erhalten KEIN Zwischentotal (fehlend ≠ 0).
import { describe, it, expect } from 'vitest';
import { computeBPLRows } from '@/pages/PLView';
import type { BudgetYear, BudgetPLCategory, BudgetPLLineItem } from '@/types/budget';
import type { MonthlyFinancialRecord } from '@/types/reporting';

const MONTHS_ZERO = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as BudgetPLLineItem['monthlyValues'];

function makeItem(over: Partial<BudgetPLLineItem> & { id: string; accountNumber: string }): BudgetPLLineItem {
  return {
    categoryId: 'pl_goods_cost',
    label: over.accountNumber,
    valueType: 'chf',
    monthlyValues: MONTHS_ZERO,
    sortOrder: 0,
    ...over,
  };
}

function makeBudget(items: BudgetPLLineItem[], cats?: BudgetPLCategory[]): BudgetYear {
  return {
    year: 2026,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    plCategories: cats ?? [
      { id: 'pl_goods_cost', label: 'Warenaufwand', type: 'items', isExpense: true, sortOrder: 1, color: 'orange' },
    ],
    plLineItems: items,
  };
}

function makeRecord(expenseCategories: MonthlyFinancialRecord['expenseCategories']): MonthlyFinancialRecord {
  return {
    id: '2026-01',
    year: 2026,
    month: 1,
    expenseCategories,
  } as MonthlyFinancialRecord;
}

function monthly(v: number): BudgetPLLineItem['monthlyValues'] {
  return [v, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as BudgetPLLineItem['monthlyValues'];
}

describe('computeBPLRows — Warenaufwand-Zwischentotale (klassische Ansicht)', () => {
  it('ordnet direkt-Block vor übrig-Block und setzt beide Zwischentotale', () => {
    const budget = makeBudget([
      // absichtlich «verkehrte» sortOrder: übrig-Konto zuerst
      makeItem({ id: 'i-4080', accountNumber: '4080', label: 'Verpackung', sortOrder: 1, monthlyValues: monthly(100) }),
      makeItem({ id: 'i-4060', accountNumber: '4060', label: 'Einkauf Food', sortOrder: 2, monthlyValues: monthly(500) }),
      makeItem({ id: 'i-4020', accountNumber: '4020', label: 'Einkauf Getränke', sortOrder: 3, monthlyValues: monthly(300) }),
    ]);
    const rec = makeRecord([
      { categoryId: '4060', label: 'Einkauf Food', amount: 520 },
      { categoryId: '4080', label: 'Verpackung', amount: 90 },
    ]);
    const rows = computeBPLRows(budget, rec, 0);

    const goods = rows.filter(r => r.catId === 'pl_goods_cost');
    expect(goods[0].isCategory).toBe(true); // Kategorie-Header behält Gesamt

    const ids = goods.slice(1).map(r => r.itemId);
    // direkt-Block (4020, 4060) → Subtotal direkt → übrig-Block (4080) → Subtotal übrig
    expect(ids).toEqual(['i-4060', 'i-4020', 'subtotal_direct', 'i-4080', 'subtotal_uebrig']);

    const subDirect = goods.find(r => r.itemId === 'subtotal_direct')!;
    expect(subDirect.isGroupSubtotal).toBe(true);
    expect(subDirect.itemLabel).toBe('Direkter Warenaufwand');
    expect(subDirect.values.actual).toBe(520);       // nur 4060 hat Ist
    expect(subDirect.values.budget).toBe(800);       // 500 + 300

    const subUebrig = goods.find(r => r.itemId === 'subtotal_uebrig')!;
    expect(subUebrig.itemLabel).toBe('Übriger Warenaufwand');
    expect(subUebrig.values.actual).toBe(90);
    expect(subUebrig.values.budget).toBe(100);

    // Kategorie-Header = Gesamtwert (unverändert)
    expect(goods[0].values.actual).toBe(610);
  });

  it('lässt das Zwischentotal einer leeren Gruppe weg (fehlend ≠ 0)', () => {
    const budget = makeBudget([
      makeItem({ id: 'i-4060', accountNumber: '4060', label: 'Einkauf Food', monthlyValues: monthly(500) }),
    ]);
    const rec = makeRecord([{ categoryId: '4060', label: 'Einkauf Food', amount: 480 }]);
    const rows = computeBPLRows(budget, rec, 0);

    const ids = rows.filter(r => r.catId === 'pl_goods_cost').map(r => r.itemId);
    expect(ids).toContain('subtotal_direct');
    expect(ids).not.toContain('subtotal_uebrig');
  });

  it('interne Positionen erscheinen im Block, zählen aber nicht ins Zwischentotal', () => {
    const budget = makeBudget([
      makeItem({ id: 'i-4060', accountNumber: '4060', label: 'Einkauf Food', monthlyValues: monthly(500) }),
      makeItem({ id: 'i-4050', accountNumber: '4050', label: 'Interne Verrechnung', isInternal: true, monthlyValues: monthly(999) }),
    ]);
    const rows = computeBPLRows(budget, makeRecord([]), 0);

    const goods = rows.filter(r => r.catId === 'pl_goods_cost');
    const ids = goods.map(r => r.itemId);
    expect(ids).toContain('i-4050'); // sichtbar (INTERN-Badge)
    const subDirect = goods.find(r => r.itemId === 'subtotal_direct')!;
    expect(subDirect.values.budget).toBe(500); // 999 intern ausgeschlossen
  });

  it('Ist-Konten ohne Budget-Position (actual_*) werden ebenfalls einsortiert', () => {
    const budget = makeBudget([
      makeItem({ id: 'i-4060', accountNumber: '4060', label: 'Einkauf Food', monthlyValues: monthly(500) }),
    ]);
    const rec = makeRecord([
      { categoryId: '4060', label: 'Einkauf Food', amount: 480 },
      { categoryId: '4072', label: 'Sonstiger Warenaufwand', amount: 60 }, // kein Budget-Item
    ]);
    const rows = computeBPLRows(budget, rec, 0);

    const ids = rows.filter(r => r.catId === 'pl_goods_cost').map(r => r.itemId);
    const idxUebrigRow = ids.indexOf('actual_4072');
    const idxSubDirect = ids.indexOf('subtotal_direct');
    const idxSubUebrig = ids.indexOf('subtotal_uebrig');
    expect(idxUebrigRow).toBeGreaterThan(idxSubDirect); // übrig-Block NACH Subtotal direkt
    expect(idxSubUebrig).toBeGreaterThan(idxUebrigRow);

    const subUebrig = rows.find(r => r.itemId === 'subtotal_uebrig')!;
    expect(subUebrig.values.actual).toBe(60);
  });

  it('andere Kategorien bleiben unverändert (keine Zwischentotale)', () => {
    const budget = makeBudget(
      [
        makeItem({ id: 'i-6400', accountNumber: '6400', categoryId: 'pl_energy', label: 'Strom', monthlyValues: monthly(200) }),
      ],
      [
        { id: 'pl_energy', label: 'Energie', type: 'items', isExpense: true, sortOrder: 1, color: 'gray' },
      ],
    );
    const rows = computeBPLRows(budget, makeRecord([]), 0);
    expect(rows.some(r => r.isGroupSubtotal)).toBe(false);
  });
});
