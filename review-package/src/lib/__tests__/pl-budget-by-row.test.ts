// @vitest-environment happy-dom
// happy-dom (statt node) weil pl-engine transitiv den Supabase-Client lädt, der
// `localStorage` beim Modul-Load braucht. buildBudgetByRowForMonth selbst ist rein
// (injizierbares lookupFn) — hier wird kein DB-/Netz-Zugriff ausgeführt.
import { describe, it, expect } from 'vitest';
import { buildBudgetByRowForMonth, computePLForMonth, BPL_CAT_TO_PL_ROW } from '@/lib/pl-engine';
import type { BudgetPLLineItem, BudgetPLCategory } from '@/types/budget';
import type { MonthlyFinancialRecord } from '@/types/reporting';

// lookupFn-Stub: gibt nur für explizit gemappte Konten eine plCategory zurück,
// sonst kein Mapping (→ Kategorie-Fallback greift). So bleibt der Test rein
// (kein localStorage / kein account-mapping-store-Zustand).
function makeLookup(map: Record<string, string>) {
  return (accountNumber: string) =>
    map[accountNumber] ? { mapping: { plCategory: map[accountNumber] } } : { mapping: null };
}

function makeItem(o: Partial<BudgetPLLineItem> & { categoryId: string; monthlyValues: BudgetPLLineItem['monthlyValues'] }): BudgetPLLineItem {
  return {
    id: o.id ?? `item-${Math.random()}`,
    categoryId: o.categoryId,
    accountNumber: o.accountNumber ?? '',
    label: o.label ?? 'Position',
    valueType: o.valueType ?? 'chf',
    monthlyValues: o.monthlyValues,
    sortOrder: o.sortOrder ?? 0,
    isInternal: o.isInternal,
  };
}

const CATS: BudgetPLCategory[] = [
  { id: 'pl_wages', label: 'Löhne', type: 'items', isExpense: true, sortOrder: 1, color: 'orange' },
  { id: 'pl_social', label: 'Sozial', type: 'items', isExpense: true, sortOrder: 2, color: 'orange' },
  { id: 'pl_personnel_other', label: 'Personal übrig', type: 'items', isExpense: true, sortOrder: 3, color: 'orange' },
  { id: 'pl_revenue', label: 'Umsatz', type: 'items', isExpense: false, sortOrder: 0, color: 'green' },
];

const M = (idx: number, val: number): BudgetPLLineItem['monthlyValues'] => {
  const arr = Array(12).fill(0) as BudgetPLLineItem['monthlyValues'];
  arr[idx] = val;
  return arr;
};

function makeRecord(o: Partial<MonthlyFinancialRecord> = {}): MonthlyFinancialRecord {
  return {
    id: '2026-03',
    year: 2026,
    month: 3,
    expenseCategories: [],
    expenseCategoriesPreviousYear: [],
    imports: [],
    createdAt: '',
    updatedAt: '',
    ...o,
  };
}

describe('buildBudgetByRowForMonth', () => {
  it('mappt Kategorien per Fallback (ohne Konto-Mapping) auf PL-Zeilen', () => {
    const items = [
      makeItem({ categoryId: 'pl_wages', monthlyValues: M(2, 10000) }),
      makeItem({ categoryId: 'pl_social', monthlyValues: M(2, 2000) }),
      makeItem({ categoryId: 'pl_personnel_other', monthlyValues: M(2, 500) }),
    ];
    const map = buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 2, makeLookup({}));
    expect(map.get('personnel_wages')).toBe(10000);
    expect(map.get('personnel_social')).toBe(2000);
    expect(map.get('personnel_other')).toBe(500);
  });

  it('bevorzugt das Konto-Mapping vor dem Kategorie-Fallback', () => {
    // Konto 5010 → personnel_kitchen → personnel_wages; Kategorie wäre pl_social (personnel_social)
    const items = [
      makeItem({ categoryId: 'pl_social', accountNumber: '5010', monthlyValues: M(0, 7000) }),
    ];
    const map = buildBudgetByRowForMonth(
      { plLineItems: items, plCategories: CATS },
      0,
      makeLookup({ '5010': 'personnel_kitchen' }),
    );
    expect(map.get('personnel_wages')).toBe(7000);
    expect(map.has('personnel_social')).toBe(false);
  });

  it('summiert mehrere Positionen derselben Zeile', () => {
    const items = [
      makeItem({ categoryId: 'pl_wages', monthlyValues: M(5, 3000) }),
      makeItem({ categoryId: 'pl_wages', monthlyValues: M(5, 4500) }),
    ];
    const map = buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 5, makeLookup({}));
    expect(map.get('personnel_wages')).toBe(7500);
  });

  it('überspringt isInternal-Positionen und 0-Werte', () => {
    const items = [
      makeItem({ categoryId: 'pl_wages', monthlyValues: M(1, 9000), isInternal: true }),
      makeItem({ categoryId: 'pl_social', monthlyValues: M(1, 0) }),
    ];
    const map = buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 1, makeLookup({}));
    expect(map.size).toBe(0);
  });

  it('liest nur den angefragten Monat', () => {
    const items = [makeItem({ categoryId: 'pl_wages', monthlyValues: M(4, 12000) })];
    expect(buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 4, makeLookup({})).get('personnel_wages')).toBe(12000);
    expect(buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 3, makeLookup({})).size).toBe(0);
  });

  it('BPL_CAT_TO_PL_ROW deckt die Personal-Kategorien ab', () => {
    expect(BPL_CAT_TO_PL_ROW.pl_wages).toBe('personnel_wages');
    expect(BPL_CAT_TO_PL_ROW.pl_social).toBe('personnel_social');
    expect(BPL_CAT_TO_PL_ROW.pl_personnel_other).toBe('personnel_other');
  });
});

describe('computePLForMonth: ER-Budget aus budgetByRow (SSoT-Fix)', () => {
  it('füllt total_personnel.budget aus den Budget-Overrides — auch OHNE personnelCostActual', () => {
    const items = [
      makeItem({ categoryId: 'pl_wages', monthlyValues: M(2, 10000) }),
      makeItem({ categoryId: 'pl_social', monthlyValues: M(2, 2000) }),
      makeItem({ categoryId: 'pl_personnel_other', monthlyValues: M(2, 500) }),
      makeItem({ categoryId: 'pl_revenue', monthlyValues: M(2, 80000) }),
    ];
    const budgetByRow = buildBudgetByRowForMonth({ plLineItems: items, plCategories: CATS }, 2, makeLookup({}));
    // Record OHNE personnelCostActual → früher blieb personnel_wages.budget leer
    const rec = makeRecord({ personnelCostActual: undefined });
    const pl = computePLForMonth(rec, { budgetByRow });
    const totalPersonnel = pl.rows.find(r => r.def.id === 'total_personnel');
    expect(totalPersonnel?.values.budget).toBe(12500);
    const netRevenue = pl.rows.find(r => r.def.id === 'net_revenue');
    expect(netRevenue?.values.budget).toBe(80000);
  });

  it('ohne Overrides bleibt das Personal-Budget leer (belegt den behobenen Fehler)', () => {
    const rec = makeRecord({ personnelCostActual: undefined });
    const pl = computePLForMonth(rec);
    const totalPersonnel = pl.rows.find(r => r.def.id === 'total_personnel');
    expect(totalPersonnel?.values.budget).toBeUndefined();
  });
});
