// @vitest-environment happy-dom
// happy-dom (statt node) weil pl-engine transitiv den Supabase-Client lädt, der
// `localStorage` beim Modul-Load braucht. Getestet wird die numerische
// Range-SSoT der Warenaufwand-Zwischentotale (4000–4070 direkt / 4071–4900 übrig)
// in computePLForMonth/computePLForYear + buildCogsBudgetSplitForMonth.
import { describe, it, expect } from 'vitest';
import { computePLForMonth, computePLForYear, buildCogsBudgetSplitForMonth } from '@/lib/pl-engine';
import { saveMappingCustom, deleteMappingCustom } from '@/lib/account-mapping-store';
import type { PLMonthResult } from '@/types/pl';
import type { BudgetPLLineItem, BudgetPLCategory } from '@/types/budget';
import type { MonthlyFinancialRecord } from '@/types/reporting';

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

function rowValue(res: PLMonthResult, rowId: string) {
  return res.rows.find(r => r.def.id === rowId)?.values;
}

// Default-Kontenplan (account-mapping-store):
//   4000 → cogs_food      (Kontenzuordnung direkt,  Range direkt  → konsistent)
//   4090 → cogs_other     (Kontenzuordnung übrig,   Range übrig   → konsistent)
//   4085 → Range-Regel 4000–4099 → cogs_food (direkt), numerisch aber 4071–4900 → übrig  → KONFLIKT
//   4950 → Fallback 4000–4999 → cogs_other (übrig), numerisch ausserhalb 4000–4900       → WARNUNG (bleibt übrig)

describe('computePLForMonth — Warenaufwand-Zwischentotale (numerische Range-SSoT)', () => {
  it('konsistente Konten: direkt/übrig nach Range, keine Warnungen', () => {
    const rec = makeRecord({
      expenseCategories: [
        { categoryId: '4000', label: 'Lebensmittel', amount: 1000 },
        { categoryId: '4090', label: 'Übriger Handelswarenaufwand', amount: 200 },
      ],
    });
    const res = computePLForMonth(rec);
    expect(rowValue(res, 'total_cogs_direct')?.actual).toBe(1000);
    expect(rowValue(res, 'total_cogs_uebrig')?.actual).toBe(200);
    expect(rowValue(res, 'total_cogs')?.actual).toBe(1200);
    expect(res.dataQualityWarnings).toBeUndefined();
  });

  it('Konflikt Kontenzuordnung↔Range: Range gewinnt, Gesamttotal/GP1 bleiben unverändert, Warnung sichtbar', () => {
    const rec = makeRecord({
      revenueActual: 10000,
      expenseCategories: [
        { categoryId: '4000', label: 'Lebensmittel', amount: 1000 },
        // 4085 mappt per Default-Range-Regel auf cogs_food (direkt),
        // numerisch liegt es aber in 4071–4900 (übrig) → Range gewinnt.
        { categoryId: '4085', label: 'Konfliktkonto', amount: 300 },
      ],
    });
    const res = computePLForMonth(rec);
    expect(rowValue(res, 'total_cogs_direct')?.actual).toBe(1000);
    expect(rowValue(res, 'total_cogs_uebrig')?.actual).toBe(300);
    expect(rowValue(res, 'total_cogs')?.actual).toBe(1300);
    // GP1 = Nettoumsatz − Gesamtwarenaufwand, unbeeinflusst von der Verschiebung
    const netRevenue = rowValue(res, 'net_revenue')?.actual ?? 0;
    expect(rowValue(res, 'gross_profit_1')?.actual).toBeCloseTo(netRevenue - 1300, 5);
    expect(res.dataQualityWarnings?.some(w => w.includes('4085'))).toBe(true);
  });

  it('Konto ausserhalb 4000–4899: Kategorie-Fallback (kein Ummappen) + Warnung', () => {
    // 3950 ist per Custom-Mapping dem Warenaufwand (cogs_other) zugeordnet,
    // liegt aber numerisch ausserhalb 4000–4899 → Kategorie-Fallback + Warnung.
    saveMappingCustom({
      accountNumber: '3950', accountName: 'Testkonto ausserhalb Range',
      plCategory: 'cogs_other', plSection: 'cogs', department: 'general',
      sign: 'expense', canOverride: true, isActive: true, source: 'custom',
    });
    try {
      const rec = makeRecord({
        expenseCategories: [
          { categoryId: '3950', label: 'Ausserhalb Range', amount: 150 },
        ],
      });
      const res = computePLForMonth(rec);
      expect(rowValue(res, 'total_cogs_direct')?.actual ?? 0).toBe(0);
      expect(rowValue(res, 'total_cogs_uebrig')?.actual).toBe(150);
      expect(res.dataQualityWarnings?.some(w => w.includes('3950') && w.includes('4000–4899'))).toBe(true);
    } finally {
      deleteMappingCustom('3950');
    }
  });

  it('Vorjahreswerte werden ebenfalls nach Range verschoben (Actual+PY-Match und PY-only)', () => {
    const rec = makeRecord({
      expenseCategories: [
        { categoryId: '4085', label: 'Konfliktkonto', amount: 300 },
      ],
      expenseCategoriesPreviousYear: [
        { categoryId: '4085', label: 'Konfliktkonto', amount: 250 },   // PY-Match
        { categoryId: '4000', label: 'Lebensmittel', amount: 900 },    // PY-only, konsistent
      ],
    });
    const res = computePLForMonth(rec);
    expect(rowValue(res, 'total_cogs_uebrig')?.actual).toBe(300);
    expect(rowValue(res, 'total_cogs_direct')?.prevYear).toBe(900);
    expect(rowValue(res, 'total_cogs_uebrig')?.prevYear).toBe(250);
    expect(rowValue(res, 'total_cogs')?.prevYear).toBe(1150);
  });

  it('cogsBudgetSplit-Override ersetzt die Budget-Aufteilung der Zwischentotale, Summe bleibt', () => {
    const rec = makeRecord({
      expenseCategories: [{ categoryId: '4000', label: 'Lebensmittel', amount: 1000 }],
    });
    const budgetByRow = new Map<string, number>([
      ['cogs_food', 800],
      ['cogs_other', 400],
    ]);
    const res = computePLForMonth(rec, {
      budgetByRow,
      cogsBudgetSplit: { direct: 900, uebrig: 300 },
    });
    expect(rowValue(res, 'total_cogs_direct')?.budget).toBe(900);
    expect(rowValue(res, 'total_cogs_uebrig')?.budget).toBe(300);
    // Gesamtwarenaufwand-Budget = Summe der (ersetzten) Zwischentotale
    expect(rowValue(res, 'total_cogs')?.budget).toBe(1200);
  });

  it('ohne cogsBudgetSplit bleibt die kategoriebasierte Budget-Aufteilung bestehen', () => {
    const rec = makeRecord({});
    const budgetByRow = new Map<string, number>([
      ['cogs_food', 800],
      ['cogs_other', 400],
    ]);
    const res = computePLForMonth(rec, { budgetByRow });
    expect(rowValue(res, 'total_cogs_direct')?.budget).toBe(800);
    expect(rowValue(res, 'total_cogs_uebrig')?.budget).toBe(400);
  });
});

describe('computePLForYear — Warnungs-Aggregation', () => {
  it('dedupliziert identische Warnungen über Monate in der Jahressumme', () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      makeRecord({
        id: `2026-${String(i + 1).padStart(2, '0')}`,
        month: i + 1,
        expenseCategories: i < 2 ? [{ categoryId: '4085', label: 'Konflikt', amount: 100 }] : [],
      }),
    );
    const year = computePLForYear(recs);
    const warnings = year.total.dataQualityWarnings ?? [];
    expect(warnings.filter(w => w.includes('4085'))).toHaveLength(1);
    // Monatsergebnisse tragen ihre eigenen Warnungen
    expect(year.months[0].dataQualityWarnings?.some(w => w.includes('4085'))).toBe(true);
    expect(year.months[5].dataQualityWarnings).toBeUndefined();
  });

  it('Jahressumme der Zwischentotale = Summe der (Range-korrigierten) Monatswerte', () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      makeRecord({
        id: `2026-${String(i + 1).padStart(2, '0')}`,
        month: i + 1,
        expenseCategories: i === 0
          ? [{ categoryId: '4000', label: 'LM', amount: 500 }, { categoryId: '4085', label: 'K', amount: 100 }]
          : i === 1
            ? [{ categoryId: '4090', label: 'Übrig', amount: 200 }]
            : [],
      }),
    );
    const year = computePLForYear(recs);
    expect(rowValue(year.total, 'total_cogs_direct')?.actual).toBe(500);
    expect(rowValue(year.total, 'total_cogs_uebrig')?.actual).toBe(300);
    expect(rowValue(year.total, 'total_cogs')?.actual).toBe(800);
  });
});

describe('buildCogsBudgetSplitForMonth', () => {
  function makeItem(o: Partial<BudgetPLLineItem> & { monthlyValues: BudgetPLLineItem['monthlyValues'] }): BudgetPLLineItem {
    return {
      id: o.id ?? `item-${Math.random()}`,
      categoryId: o.categoryId ?? 'pl_goods_cost',
      accountNumber: o.accountNumber ?? '',
      label: o.label ?? 'Position',
      valueType: o.valueType ?? 'chf',
      monthlyValues: o.monthlyValues,
      sortOrder: o.sortOrder ?? 0,
      isInternal: o.isInternal,
    };
  }
  const M = (idx: number, val: number): BudgetPLLineItem['monthlyValues'] => {
    const arr = Array(12).fill(0) as BudgetPLLineItem['monthlyValues'];
    arr[idx] = val;
    return arr;
  };
  const CATS: BudgetPLCategory[] = [
    { id: 'pl_goods_cost', label: 'Warenaufwand', type: 'items', isExpense: true, sortOrder: 1, color: 'red' },
  ];
  const lookup = (map: Record<string, string>) =>
    (accountNumber: string) =>
      map[accountNumber] ? { mapping: { plCategory: map[accountNumber] } } : { mapping: null };

  it('teilt Budget-Positionen nach numerischer Range (Range gewinnt über Kategorie)', () => {
    const budget = {
      plCategories: CATS,
      plLineItems: [
        makeItem({ accountNumber: '4000', monthlyValues: M(2, 800) }),
        // 4085 → plCategory cogs_food (direkt laut Zuordnung), Range → übrig
        makeItem({ accountNumber: '4085', monthlyValues: M(2, 300) }),
      ],
    };
    const split = buildCogsBudgetSplitForMonth(
      budget, 2,
      lookup({ '4000': 'cogs_food', '4085': 'cogs_food' }),
    );
    expect(split).toEqual({ direct: 800, uebrig: 300 });
  });

  it('Konto ausserhalb Range fällt auf die Kontenzuordnungs-Gruppe zurück', () => {
    const budget = {
      plCategories: CATS,
      plLineItems: [
        makeItem({ accountNumber: '4950', monthlyValues: M(0, 150) }),
      ],
    };
    const split = buildCogsBudgetSplitForMonth(budget, 0, lookup({ '4950': 'cogs_other' }));
    expect(split).toEqual({ direct: 0, uebrig: 150 });
  });

  it('spiegelt die Mitgliedschaft von buildBudgetByRowForMonth: ohne Kontonummer/Mapping/Warenaufwand-Zeile → ignoriert', () => {
    const budget = {
      plCategories: CATS,
      plLineItems: [
        makeItem({ accountNumber: '', monthlyValues: M(0, 500) }),               // keine Kontonummer
        makeItem({ accountNumber: '6000', monthlyValues: M(0, 500) }),           // kein Warenaufwand
        makeItem({ accountNumber: '4000', monthlyValues: M(0, 0) }),             // 0-Wert
        makeItem({ accountNumber: '4000', monthlyValues: M(0, 700), isInternal: true }), // intern
      ],
    };
    const split = buildCogsBudgetSplitForMonth(
      budget, 0,
      lookup({ '6000': 'other_operating', '4000': 'cogs_food' }),
    );
    expect(split).toBeUndefined();
  });

  it('gibt undefined zurück, wenn gar kein Budget existiert (kein erfundenes 0)', () => {
    expect(buildCogsBudgetSplitForMonth({ plLineItems: [] }, 0, lookup({}))).toBeUndefined();
  });
});
