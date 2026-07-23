// @vitest-environment happy-dom
// happy-dom (statt node) weil pl-engine transitiv den Supabase-Client lädt, der
// `localStorage` beim Modul-Load braucht.
/**
 * Financial Metrics Registry — rein lesende Kennzahlen-SSoT.
 *
 * Verdrahtungs-Tests: Registry-Werte ≡ computePLForMonth-Rows (keine
 * Zweitberechnung), Quoten je Spalte aus Rohwerten (Nenner fehlt/0 ⇒ null,
 * fehlend ≠ 0), VJ-Overrides via buildPrevYearByRowForMonth (exakt die
 * PLView-Logik), VJ-Umsatz-Regel via applyVjRevenueRule.
 */
import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_METRICS,
  FINANCIAL_METRIC_IDS,
  FINANCIAL_METRIC_DEPENDENCIES,
  getFinancialMetricValues,
  getFinancialMetricDefinition,
  getFinancialMetricMissingDependencies,
  getFinancialMetricLabel,
  getGatedFinancialMetricValues,
  getAllFinancialMetricDefinitions,
  type FinancialMetricRegistryInput,
} from '@/lib/financial-metrics';
import {
  computePLForMonth,
  buildPrevYearByRowForMonth,
  PL_STRUCTURE,
} from '@/lib/pl-engine';
import { applyVjRevenueRule } from '@/lib/effective-records';
import type { MonthlyFinancialRecord } from '@/types/reporting';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mkRec = (
  year: number,
  month: number,
  over: Partial<MonthlyFinancialRecord> = {},
): MonthlyFinancialRecord => ({
  id: `${year}-${String(month).padStart(2, '0')}`,
  year,
  month,
  expenseCategories: [],
  expenseCategoriesPreviousYear: [],
  ...over,
} as MonthlyFinancialRecord);

/** Voll befüllter Monat: Umsatz 100k, Waren 30k, Personal 35k, Opex 10k, Abschr. 5k */
const fullRec = mkRec(2026, 3, {
  revenueActual: 100_000,
  personnelCostActual: 35_000,
  expenseCategories: [
    { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
    { categoryId: 'miete', amount: 10_000, label: 'Miete' },
    { categoryId: 'abschreibungen', amount: 5_000, label: 'Abschreibungen' },
  ] as never,
});

const inputOf = (pl: ReturnType<typeof computePLForMonth>): FinancialMetricRegistryInput => ({ pl });

// Injizierbarer Konto-Lookup (kein localStorage): 6000er → PLCategory 'rent'
const lookupStub = (acct: string) => {
  const n = parseInt(acct);
  if (n >= 6000 && n <= 6099) return { mapping: { plCategory: 'rent' as const } };
  return { mapping: null };
};

// ─── Registry-Struktur ────────────────────────────────────────────────────────

describe('Registry-Struktur', () => {
  it('enthält genau die 13 vorgegebenen IDs mit korrektem kind/unit', () => {
    expect(FINANCIAL_METRIC_IDS).toHaveLength(13);
    const amounts = FINANCIAL_METRIC_IDS.filter(id => FINANCIAL_METRICS[id].kind === 'amount');
    const ratios  = FINANCIAL_METRIC_IDS.filter(id => FINANCIAL_METRICS[id].kind === 'ratio');
    expect(amounts).toHaveLength(9);
    expect(ratios).toEqual(['cogs_ratio', 'personnel_ratio', 'ebitda_margin', 'ebit_margin']);
    for (const id of amounts) expect(FINANCIAL_METRICS[id].unit).toBe('CHF');
    for (const id of ratios)  expect(FINANCIAL_METRICS[id].unit).toBe('%');
    for (const id of FINANCIAL_METRIC_IDS) {
      expect(FINANCIAL_METRICS[id].actualSource).toBe('pl');
      expect(FINANCIAL_METRICS[id].budgetSource).toBe('budget');
      expect(FINANCIAL_METRICS[id].priorYearSource).toBe('prior_year_pl');
    }
  });

  it('jede Amount-ID existiert als PL_STRUCTURE-Zeile (keine Zweitstruktur)', () => {
    const plIds = new Set(PL_STRUCTURE.map(r => r.id));
    for (const id of FINANCIAL_METRIC_IDS) {
      if (FINANCIAL_METRICS[id].kind === 'amount') expect(plIds.has(id)).toBe(true);
    }
  });

  it('getFinancialMetricDefinition liefert je ID GENAU EINE Definition (Referenzgleichheit)', () => {
    for (const id of FINANCIAL_METRIC_IDS) {
      const def = getFinancialMetricDefinition(id);
      expect(def).toBe(FINANCIAL_METRICS[id]);
      expect(def.id).toBe(id);
    }
  });

  it('getAllFinancialMetricDefinitions: alle 13, stabile Reihenfolge, keine Duplikate', () => {
    const defs = getAllFinancialMetricDefinitions();
    expect(defs).toHaveLength(13);
    expect(defs.map(d => d.id)).toEqual(FINANCIAL_METRIC_IDS);
    expect(new Set(defs.map(d => d.id)).size).toBe(13);
  });
});

// ─── Beträge ≡ P&L-Engine ─────────────────────────────────────────────────────

describe('Amount-Metriken ≡ computePLForMonth-Rows', () => {
  const pl = computePLForMonth(fullRec);
  const input = inputOf(pl);

  it('liefert für jede Amount-ID exakt values.actual der gleichnamigen PL-Zeile', () => {
    for (const id of FINANCIAL_METRIC_IDS) {
      if (FINANCIAL_METRICS[id].kind !== 'amount') continue;
      const rowActual = pl.rows.find(r => r.def.id === id)?.values.actual;
      expect(getFinancialMetricValues(id, input).actual).toBe(rowActual ?? null);
    }
  });

  it('Plausibilität: net_revenue 100k, total_cogs 30k, ebitda 25k, ebit 20k', () => {
    expect(getFinancialMetricValues('net_revenue', input).actual).toBe(100_000);
    expect(getFinancialMetricValues('total_cogs', input).actual).toBe(30_000);
    expect(getFinancialMetricValues('gross_profit_1', input).actual).toBe(70_000);
    expect(getFinancialMetricValues('total_personnel', input).actual).toBe(35_000);
    expect(getFinancialMetricValues('gross_profit_2', input).actual).toBe(35_000);
    expect(getFinancialMetricValues('total_opex', input).actual).toBe(10_000);
    expect(getFinancialMetricValues('ebitda', input).actual).toBe(25_000);
    expect(getFinancialMetricValues('total_depreciation', input).actual).toBe(5_000);
    expect(getFinancialMetricValues('ebit', input).actual).toBe(20_000);
  });

  it('fehlend ≠ 0: leerer Monat ⇒ alle Werte null (nie 0)', () => {
    const empty = inputOf(computePLForMonth(mkRec(2026, 4)));
    for (const id of FINANCIAL_METRIC_IDS) {
      const v = getFinancialMetricValues(id, empty);
      expect(v.actual).toBeNull();
      expect(v.budget).toBeNull();
      expect(v.priorYear).toBeNull();
    }
  });
});

// ─── Budget-Spalte aus Overrides ──────────────────────────────────────────────

describe('Budget-Spalte (Overrides derselben P&L-Berechnung)', () => {
  it('budget stammt aus budgetByRow — auch ohne Ist-Daten (leerer Monat)', () => {
    const budgetByRow = new Map<string, number>([
      ['revenue_total', 90_000],
      ['personnel_wages', 33_000],
    ]);
    const pl = computePLForMonth(mkRec(2026, 5), { budgetByRow });
    const input = inputOf(pl);
    expect(getFinancialMetricValues('net_revenue', input).budget).toBe(90_000);
    expect(getFinancialMetricValues('total_personnel', input).budget).toBe(33_000);
    // Ist bleibt null — Budget erzeugt keine Ist-Werte
    expect(getFinancialMetricValues('net_revenue', input).actual).toBeNull();
  });
});

// ─── Quoten ───────────────────────────────────────────────────────────────────

describe('Ratio-Metriken (je Spalte aus Rohwerten)', () => {
  it('berechnet Quoten aus ungerundeten Beträgen derselben Spalte', () => {
    const pl = computePLForMonth(fullRec, {
      budgetByRow: new Map([['revenue_total', 90_000], ['personnel_wages', 36_000]]),
    });
    const input = inputOf(pl);
    expect(getFinancialMetricValues('cogs_ratio', input).actual).toBeCloseTo(30, 10);
    expect(getFinancialMetricValues('personnel_ratio', input).actual).toBeCloseTo(35, 10);
    expect(getFinancialMetricValues('ebitda_margin', input).actual).toBeCloseTo(25, 10);
    expect(getFinancialMetricValues('ebit_margin', input).actual).toBeCloseTo(20, 10);
    // Budget-Quote aus Budget-Rohwerten: 36k / 90k = 40 %
    expect(getFinancialMetricValues('personnel_ratio', input).budget).toBeCloseTo(40, 10);
  });

  it('Nenner fehlt ⇒ null (nie 0 unterstellen)', () => {
    // Nur Kosten, kein Umsatz
    const pl = computePLForMonth(mkRec(2026, 6, {
      expenseCategories: [{ categoryId: 'miete', amount: 10_000, label: 'Miete' }] as never,
    }));
    const input = inputOf(pl);
    expect(getFinancialMetricValues('personnel_ratio', input).actual).toBeNull();
    expect(getFinancialMetricValues('ebit_margin', input).actual).toBeNull();
  });

  it('Zähler fehlt ⇒ null; Spalten unabhängig (VJ-Quote trotz fehlendem Ist)', () => {
    const pl = computePLForMonth(mkRec(2026, 7), {
      prevYearByRow: new Map([['revenue_total', 80_000], ['personnel_wages', 28_000]]),
    });
    const input = inputOf(pl);
    // VJ-Quote vorhanden (28k/80k), Ist-Quote null
    expect(getFinancialMetricValues('personnel_ratio', input).priorYear).toBeCloseTo(35, 10);
    expect(getFinancialMetricValues('personnel_ratio', input).actual).toBeNull();
    // cogs im VJ nicht gesetzt ⇒ Zähler fehlt ⇒ null (trotz VJ-Umsatz)
    expect(getFinancialMetricValues('cogs_ratio', input).priorYear).toBeNull();
  });
});

// ─── VJ-Overrides: buildPrevYearByRowForMonth (PLView-Parität) ────────────────

describe('buildPrevYearByRowForMonth (extrahiert aus PLView)', () => {
  it('VJ-Umsatz: effRec.revenuePreviousYear (Tagesansicht) schlägt prevRec.revenueActual', () => {
    const prevRec = mkRec(2025, 3, { revenueActual: 77_000 });
    const effRec  = mkRec(2026, 3, { revenuePreviousYear: 81_500 });
    const m = buildPrevYearByRowForMonth(prevRec, effRec, lookupStub);
    expect(m.get('revenue_total')).toBe(81_500);
  });

  it('Fallback auf prevRec.revenueActual ohne Tagesansicht-VJ', () => {
    const prevRec = mkRec(2025, 3, { revenueActual: 77_000 });
    const m = buildPrevYearByRowForMonth(prevRec, mkRec(2026, 3), lookupStub);
    expect(m.get('revenue_total')).toBe(77_000);
  });

  it('prevRec: personnelCostActual → personnel_wages; Konto-Kategorien via Lookup summiert', () => {
    const prevRec = mkRec(2025, 3, {
      personnelCostActual: 31_000,
      expenseCategories: [
        { categoryId: '6000', amount: 9_000, label: 'Miete' },
        { categoryId: '6001', amount: 1_000, label: 'NK' },
        { categoryId: '3000', amount: 99_999, label: 'Umsatzkonto' }, // revenue_total wird NIE über Kategorien gesetzt
        { categoryId: 'miete', amount: 500, label: 'nicht-numerisch — ignoriert' },
      ] as never,
    });
    const m = buildPrevYearByRowForMonth(prevRec, undefined, lookupStub);
    expect(m.get('personnel_wages')).toBe(31_000);
    expect(m.get('rent')).toBe(10_000);
    expect(m.get('revenue_total')).toBeUndefined();
  });

  it('Fallbacks aus effRec: personnelCostPreviousYear + expenseCategoriesPreviousYear (nur ohne prevRec)', () => {
    const effRec = mkRec(2026, 3, {
      personnelCostPreviousYear: 29_000,
      expenseCategoriesPreviousYear: [
        { categoryId: '6000', amount: 8_000, label: 'Miete VJ' },
      ] as never,
    });
    const mOhne = buildPrevYearByRowForMonth(undefined, effRec, lookupStub);
    expect(mOhne.get('personnel_wages')).toBe(29_000);
    expect(mOhne.get('rent')).toBe(8_000);
    // MIT prevRec: expenseCategoriesPreviousYear-Fallback greift NICHT
    const mMit = buildPrevYearByRowForMonth(mkRec(2025, 3), effRec, lookupStub);
    expect(mMit.get('rent')).toBeUndefined();
    // personnel-Fallback greift weiterhin (prevRec ohne personnelCostActual)
    expect(mMit.get('personnel_wages')).toBe(29_000);
  });

  it('Verdrahtung: prevYearByRow → priorYear der Registry (inkl. VJ-Quote)', () => {
    const prevRec = mkRec(2025, 3, { revenueActual: 80_000, personnelCostActual: 28_000 });
    const prevYearByRow = buildPrevYearByRowForMonth(prevRec, fullRec, lookupStub);
    const pl = computePLForMonth(fullRec, { prevYearByRow });
    const input = inputOf(pl);
    expect(getFinancialMetricValues('net_revenue', input).priorYear).toBe(80_000);
    expect(getFinancialMetricValues('total_personnel', input).priorYear).toBe(28_000);
    expect(getFinancialMetricValues('personnel_ratio', input).priorYear).toBeCloseTo(35, 10);
  });
});

// ─── Dependency-Gate (Korrekturrunde: EBIT/Bruttogewinn nie aus Teildaten) ────

describe('Dependency-Gate — getGatedFinancialMetricValues', () => {
  /** Monat OHNE Abschreibungen (sonst voll): Roh-EBIT wäre ein Scheinwert. */
  const recOhneAbschr = mkRec(2026, 3, {
    revenueActual: 100_000,
    personnelCostActual: 35_000,
    expenseCategories: [
      { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
      { categoryId: 'miete', amount: 10_000, label: 'Miete' },
    ] as never,
  });
  /** Monat OHNE Warenaufwand (sonst voll): Bruttogewinn wäre ≡ Umsatz. */
  const recOhneWaren = mkRec(2026, 3, {
    revenueActual: 100_000,
    personnelCostActual: 35_000,
    expenseCategories: [
      { categoryId: 'miete', amount: 10_000, label: 'Miete' },
      { categoryId: 'abschreibungen', amount: 5_000, label: 'Abschreibungen' },
    ] as never,
  });

  it('jede Registry-ID hat einen Dependency-Eintrag; Komponenten sind ungegated', () => {
    for (const id of FINANCIAL_METRIC_IDS) {
      expect(FINANCIAL_METRIC_DEPENDENCIES[id]).toBeDefined();
    }
    // Basis-Komponenten haben keine Abhängigkeiten ⇒ Gate = Rohwert
    for (const id of ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex', 'total_depreciation'] as const) {
      expect(FINANCIAL_METRIC_DEPENDENCIES[id]).toHaveLength(0);
    }
    expect(FINANCIAL_METRIC_DEPENDENCIES.ebit).toEqual(
      ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex', 'total_depreciation'],
    );
  });

  it('EBIT bleibt «—» (null), wenn eine erforderliche Kostenposition fehlt', () => {
    const input = inputOf(computePLForMonth(recOhneAbschr));
    // Rohwert wäre vorhanden (Scheinwert ohne Abschreibungen) …
    expect(getFinancialMetricValues('ebit', input).actual).not.toBeNull();
    // … das Gate liefert null:
    expect(getGatedFinancialMetricValues('ebit', input).actual).toBeNull();
    expect(getGatedFinancialMetricValues('ebit_margin', input).actual).toBeNull();
    expect(getFinancialMetricMissingDependencies('ebit', input, 'actual')).toEqual(['total_depreciation']);
  });

  it('Bruttogewinn bleibt «—» (null), wenn der Warenaufwand fehlt', () => {
    const input = inputOf(computePLForMonth(recOhneWaren));
    expect(getGatedFinancialMetricValues('gross_profit_1', input).actual).toBeNull();
    expect(getGatedFinancialMetricValues('ebit', input).actual).toBeNull();
    expect(getFinancialMetricMissingDependencies('gross_profit_1', input, 'actual')).toEqual(['total_cogs']);
  });

  it('fehlende Kosten werden NIE als 0 interpretiert (leerer Monat komplett null)', () => {
    const input = inputOf(computePLForMonth(mkRec(2026, 4)));
    for (const id of FINANCIAL_METRIC_IDS) {
      const v = getGatedFinancialMetricValues(id, input);
      expect(v.actual).toBeNull();
      expect(v.budget).toBeNull();
      expect(v.priorYear).toBeNull();
    }
  });

  it('vollständiger Monat berechnet EBIT korrekt (Gate ändert nichts)', () => {
    const input = inputOf(computePLForMonth(fullRec));
    expect(getGatedFinancialMetricValues('ebit', input).actual).toBe(20_000);
    expect(getGatedFinancialMetricValues('gross_profit_1', input).actual).toBe(70_000);
    for (const id of FINANCIAL_METRIC_IDS) {
      expect(getGatedFinancialMetricValues(id, input)).toEqual(getFinancialMetricValues(id, input));
    }
  });

  it('Spalten unabhängig: vollständiges Budget bleibt trotz unvollständigem IST', () => {
    const budgetByRow = new Map<string, number>([
      ['revenue_total', 90_000],
      ['cogs_food', 27_000],
      ['personnel_wages', 33_000],
      ['rent', 9_000],
      ['depreciation', 4_000],
    ]);
    const input = inputOf(computePLForMonth(recOhneAbschr, { budgetByRow }));
    const ebit = getGatedFinancialMetricValues('ebit', input);
    expect(ebit.actual).toBeNull(); // IST unvollständig
    expect(ebit.budget).toBe(17_000); // Budget vollständig: 90−27−33−9−4
  });

  it('getFinancialMetricLabel liefert das Registry-Label (für Fehlt-Hinweise)', () => {
    expect(getFinancialMetricLabel('total_depreciation')).toBe(FINANCIAL_METRICS.total_depreciation.label);
  });
});

// ─── VJ-Umsatz-Regel (extrahiert aus PLView) ─────────────────────────────────

describe('applyVjRevenueRule (Tagesansicht-VJ > reporting_v1)', () => {
  const vjDeps = (over: Partial<Parameters<typeof applyVjRevenueRule>[2]> = {}) => ({
    year: 2026,
    dailyBudgets: {},
    vjDaily: {},
    ...over,
  });

  it('setzt revenuePreviousYear aus VJ-Supabase-Tageswerten (netto)', () => {
    const rec = mkRec(2026, 1, { revenuePreviousYear: 50_000 });
    const out = applyVjRevenueRule(rec, 1, vjDeps({
      vjDaily: { '2025-01-10': { actualRevenue: 1_081 } } as never,
    }));
    // 1081 brutto → netto (× 1/1.081): Tagesansicht-Wert ersetzt 50k
    expect(out.revenuePreviousYear).toBeCloseTo(1_000, 0);
  });

  it('3xxx-PY-Konten (Sage) blockieren die Regel', () => {
    const rec = mkRec(2026, 1, {
      revenuePreviousYear: 50_000,
      expenseCategoriesPreviousYear: [{ categoryId: '3000', amount: 50_000, label: 'Umsatz VJ' }] as never,
    });
    const out = applyVjRevenueRule(rec, 1, vjDeps({
      vjDaily: { '2025-01-10': { actualRevenue: 1_081 } } as never,
    }));
    expect(out.revenuePreviousYear).toBe(50_000);
  });

  it('Fallback: prevYearRecord.revenueActual nur wenn kein VJ-Wert existiert', () => {
    const out = applyVjRevenueRule(mkRec(2026, 1), 1, vjDeps({
      prevYearRecord: mkRec(2025, 1, { revenueActual: 61_000 }),
    }));
    expect(out.revenuePreviousYear).toBe(61_000);
    // Bestehender Wert wird ohne Tagesansicht-VJ NICHT überschrieben
    const keep = applyVjRevenueRule(mkRec(2026, 1, { revenuePreviousYear: 42_000 }), 1, vjDeps({
      prevYearRecord: mkRec(2025, 1, { revenueActual: 61_000 }),
    }));
    expect(keep.revenuePreviousYear).toBe(42_000);
  });
});
