// @vitest-environment happy-dom
// happy-dom (statt node), weil kpi-catalog via financial-metrics transitiv die
// P&L-Engine lädt, die den Supabase-Client (localStorage) beim Modul-Load braucht.
/**
 * KPI-Katalog — Struktur-Invarianten + reine Berechnungen + Wert-Auflösung.
 * Registry-Delegation wird über financialInput = null (⇒ alle P&L-KPIs «—»)
 * und die bestehende financial-metrics.test.ts abgedeckt (keine Zweitprüfung
 * der Registry hier).
 */
import { describe, it, expect } from 'vitest';
import {
  KPI_CATALOG,
  KPI_IDS,
  getKpiDefinition,
  getKpiIncompleteHint,
  getKpiValues,
  getKpiTone,
  computeProductivity,
  sumProductiveHoursForMonth,
  computeCashCompletion,
  bankBenchmarkTone,
  isRunningMonth,
  type KpiCatalogInput,
} from '../kpi-catalog';
import { getFinancialMetricLabel } from '@/lib/financial-metrics';
import { computePLForMonth } from '@/lib/pl-engine';
import type { MonthlyFinancialRecord } from '@/types/reporting';

/** Leerer Katalog-Input: keinerlei Daten vorhanden. */
const EMPTY: KpiCatalogInput = {
  financialInput: null,
  guests: null,
  avgReceipt: null,
  productiveHours: null,
  verkaufsWes: null,
  cash: null,
  personnelRatioTarget: null,
};

describe('KPI_CATALOG Struktur-Invarianten', () => {
  it('enthält genau 16 KPIs mit eindeutigen IDs', () => {
    expect(KPI_CATALOG.length).toBe(16);
    expect(new Set(KPI_IDS).size).toBe(16);
  });

  it('genau 4 KPIs sind Karten (istKarte) — Rest in der Tabelle', () => {
    const cards = KPI_CATALOG.filter(d => d.istKarte).map(d => d.id);
    expect(cards).toEqual(['umsatz', 'warenquote', 'personalquote', 'ebit']);
  });

  it('alle Registry-KPIs haben Budget/VJ; operative KPIs ausser Gastronovi-VJ nicht', () => {
    for (const def of KPI_CATALOG) {
      if (def.registryId) expect(def.hatBudgetVj).toBe(true);
    }
    expect(getKpiDefinition('gaeste').hatBudgetVj).toBe(false);
    expect(getKpiDefinition('produktivitaet').hatBudgetVj).toBe(false);
  });

  it('Export-Profile: GL = alle; Bank/Investoren = Teilmengen', () => {
    expect(KPI_CATALOG.every(d => d.export.geschaeftsleitung)).toBe(true);
    const bank = KPI_CATALOG.filter(d => d.export.bank).map(d => d.id);
    const inv = KPI_CATALOG.filter(d => d.export.investoren).map(d => d.id);
    expect(bank).toEqual([
      'umsatz',
      'warenkosten',
      'warenquote',
      'bruttogewinn',
      'personalkosten',
      'personalquote',
      'ebitda',
      'ebitda_marge',
      'ebit',
      'ebit_marge',
    ]);
    expect(inv).toEqual(['umsatz', 'ebitda', 'ebitda_marge', 'ebit', 'ebit_marge']);
    // Investoren ⊆ Bank (kompaktestes Profil)
    for (const id of inv) expect(bank).toContain(id);
  });

  it('jede KPI hat Pflicht-Metadaten (Formel, Quelle, Aktualisierung, Verantwortlich)', () => {
    for (const def of KPI_CATALOG) {
      expect(def.formel.length).toBeGreaterThan(0);
      expect(def.datenquelle.length).toBeGreaterThan(0);
      expect(def.aktualisierung.length).toBeGreaterThan(0);
      expect(def.verantwortlich.length).toBeGreaterThan(0);
    }
  });

  it('getKpiDefinition wirft bei unbekannter KPI', () => {
    expect(() => getKpiDefinition('gibt_es_nicht' as never)).toThrow();
  });
});

describe('computeProductivity', () => {
  it('Umsatz ÷ Stunden', () => {
    expect(computeProductivity(12000, 300)).toBeCloseTo(40);
  });
  it('fehlende Seite oder 0 Stunden ⇒ null (nie 0 erfinden)', () => {
    expect(computeProductivity(null, 300)).toBeNull();
    expect(computeProductivity(12000, null)).toBeNull();
    expect(computeProductivity(12000, 0)).toBeNull();
  });
});

describe('sumProductiveHoursForMonth', () => {
  const entries = [
    { date: '2026-07-01', hours: 8 },
    { date: '2026-07-02', hours: 0 }, // nicht produktiv
    { date: '2026-07-15', hours: 4.5 },
    { date: '2026-06-30', hours: 9 }, // anderer Monat
  ];
  it('summiert nur Stunden > 0 des Monats', () => {
    expect(sumProductiveHoursForMonth(entries, '2026-07')).toBeCloseTo(12.5);
  });
  it('keine Einträge im Monat ⇒ null, NIE 0', () => {
    expect(sumProductiveHoursForMonth(entries, '2026-01')).toBeNull();
    expect(sumProductiveHoursForMonth([], '2026-07')).toBeNull();
  });
});

describe('computeCashCompletion', () => {
  it('bestätigt ÷ erwartet × 100', () => {
    expect(computeCashCompletion(3, 4)).toBeCloseTo(75);
  });
  it('0 erwartete Tage ⇒ null (kein «100 % von nichts»)', () => {
    expect(computeCashCompletion(0, 0)).toBeNull();
  });
});

describe('bankBenchmarkTone (bestehende Bank-Benchmark-Regel)', () => {
  it('EBITDA-Marge: Ziel 15 % erreicht = good, Toleranz 1.0 pp = neutral, darunter critical', () => {
    expect(bankBenchmarkTone('ebitda_marge', 15)).toBe('good');
    expect(bankBenchmarkTone('ebitda_marge', 14.2)).toBe('neutral');
    expect(bankBenchmarkTone('ebitda_marge', 13.9)).toBe('critical');
  });
  it('EBIT-Marge: Ziel 10 %', () => {
    expect(bankBenchmarkTone('ebit_marge', 10)).toBe('good');
    expect(bankBenchmarkTone('ebit_marge', 9.5)).toBe('neutral');
    expect(bankBenchmarkTone('ebit_marge', 8.9)).toBe('critical');
  });
  it('fehlender Wert ⇒ null', () => {
    expect(bankBenchmarkTone('ebitda_marge', null)).toBeNull();
  });
});

describe('getKpiValues — fehlend = null, NIE 0', () => {
  it('ohne jegliche Daten sind ALLE 16 KPIs komplett «—»', () => {
    for (const id of KPI_IDS) {
      const v = getKpiValues(id, EMPTY);
      expect(v.actual).toBeNull();
      expect(v.budget).toBeNull();
      expect(v.priorYear).toBeNull();
    }
  });

  it('Gäste: rowCount 0 oder totalGuests 0 ⇒ null (gn-personen-db liefert 0 bei «keine Daten»)', () => {
    expect(
      getKpiValues('gaeste', { ...EMPTY, guests: { totalGuests: 0, avgRevPerGuest: 0, rowCount: 0 } })
        .actual,
    ).toBeNull();
    expect(
      getKpiValues('gaeste', { ...EMPTY, guests: { totalGuests: 0, avgRevPerGuest: 0, rowCount: 3 } })
        .actual,
    ).toBeNull();
    const v = getKpiValues('gaeste', {
      ...EMPTY,
      guests: { totalGuests: 1234, avgRevPerGuest: 52.4, rowCount: 30 },
      guestsVj: { totalGuests: 1100, avgRevPerGuest: 48.1, rowCount: 31 },
    });
    expect(v.actual).toBe(1234);
    expect(v.priorYear).toBe(1100);
    expect(v.budget).toBeNull(); // kein Gäste-Budget definiert
  });

  it('Durchschnittsbon & Umsatz pro Gast analog', () => {
    const input: KpiCatalogInput = {
      ...EMPTY,
      guests: { totalGuests: 1000, avgRevPerGuest: 55, rowCount: 30 },
      avgReceipt: { avgReceipt: 78.5, rowCount: 30 },
    };
    expect(getKpiValues('durchschnittsbon', input).actual).toBeCloseTo(78.5);
    expect(getKpiValues('umsatz_pro_gast', input).actual).toBeCloseTo(55);
  });

  it('Verkaufs-WES: braucht wesTotal > 0 UND Registry-Nettoumsatz — sonst null', () => {
    expect(
      getKpiValues('wes_quote_verkauf', { ...EMPTY, verkaufsWes: { wesTotal: 5000 } }).actual,
    ).toBeNull(); // kein financialInput ⇒ kein Nettoumsatz ⇒ keine Quote
    expect(
      getKpiValues('wes_quote_verkauf', { ...EMPTY, verkaufsWes: { wesTotal: 0 } }).actual,
    ).toBeNull();
  });

  it('Tagesabschluss-Quote aus cash-Stand', () => {
    const v = getKpiValues('tagesabschluss_quote', {
      ...EMPTY,
      cash: { confirmedDays: 9, expectedDays: 10 },
    });
    expect(v.actual).toBeCloseTo(90);
    expect(
      getKpiValues('tagesabschluss_quote', { ...EMPTY, cash: { confirmedDays: 0, expectedDays: 0 } })
        .actual,
    ).toBeNull();
  });
});

// ─── Korrekturrunde: Dependency-Gate im Katalog + laufender Monat ────────────

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

/** Monat OHNE Abschreibungen (sonst voll) ⇒ EBIT muss «—» bleiben. */
const inputOhneAbschr: KpiCatalogInput = {
  ...EMPTY,
  financialInput: {
    pl: computePLForMonth(mkRec(2026, 3, {
      revenueActual: 100_000,
      personnelCostActual: 35_000,
      expenseCategories: [
        { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
        { categoryId: 'miete', amount: 10_000, label: 'Miete' },
      ] as never,
    })),
  },
};

describe('getKpiValues — Registry-KPIs sind dependency-gegated', () => {
  it('EBIT bleibt «—», wenn Abschreibungen fehlen (Umsatz bleibt sichtbar)', () => {
    expect(getKpiValues('ebit', inputOhneAbschr).actual).toBeNull();
    expect(getKpiValues('ebit_marge', inputOhneAbschr).actual).toBeNull();
    expect(getKpiValues('umsatz', inputOhneAbschr).actual).toBe(100_000);
  });

  it('Bruttogewinn bleibt «—», wenn der Warenaufwand fehlt', () => {
    const input: KpiCatalogInput = {
      ...EMPTY,
      financialInput: {
        pl: computePLForMonth(mkRec(2026, 3, {
          revenueActual: 100_000,
          personnelCostActual: 35_000,
          expenseCategories: [
            { categoryId: 'miete', amount: 10_000, label: 'Miete' },
          ] as never,
        })),
      },
    };
    expect(getKpiValues('bruttogewinn', input).actual).toBeNull();
    expect(getKpiValues('warenquote', input).actual).toBeNull();
  });

  it('vollständiger Monat: EBIT korrekt (Gate ändert nichts)', () => {
    const input: KpiCatalogInput = {
      ...EMPTY,
      financialInput: {
        pl: computePLForMonth(mkRec(2026, 3, {
          revenueActual: 100_000,
          personnelCostActual: 35_000,
          expenseCategories: [
            { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
            { categoryId: 'miete', amount: 10_000, label: 'Miete' },
            { categoryId: 'abschreibungen', amount: 5_000, label: 'Abschreibungen' },
          ] as never,
        })),
      },
    };
    expect(getKpiValues('ebit', input).actual).toBe(20_000);
    expect(getKpiValues('bruttogewinn', input).actual).toBe(70_000);
    expect(getKpiValues('warenquote', input).actual).toBeCloseTo(30, 10);
  });
});

describe('getKpiIncompleteHint', () => {
  it('nennt die fehlende Komponente («es fehlt: …», Singular)', () => {
    const hint = getKpiIncompleteHint('ebit', inputOhneAbschr);
    expect(hint).toContain('Noch nicht vollständig');
    expect(hint).toContain('es fehlt:');
    expect(hint).toContain(getFinancialMetricLabel('total_depreciation'));
  });

  it('Plural bei mehreren fehlenden Komponenten', () => {
    const input: KpiCatalogInput = {
      ...EMPTY,
      financialInput: {
        pl: computePLForMonth(mkRec(2026, 3, { revenueActual: 100_000 })),
      },
    };
    const hint = getKpiIncompleteHint('ebit', input);
    expect(hint).toContain('es fehlen:');
  });

  it('null ohne financialInput (ganzer Monat fehlt), bei Vollständigkeit und für operative KPIs', () => {
    expect(getKpiIncompleteHint('ebit', EMPTY)).toBeNull();
    expect(getKpiIncompleteHint('umsatz', inputOhneAbschr)).toBeNull();
    expect(getKpiIncompleteHint('gaeste', inputOhneAbschr)).toBeNull();
  });
});

describe('isRunningMonth — laufender Monat wird eindeutig erkannt', () => {
  const now = new Date(2026, 6, 23); // 23.07.2026
  it('Juli 2026 ist laufend, Juni 2026 und Juli 2025 nicht', () => {
    expect(isRunningMonth(2026, 7, now)).toBe(true);
    expect(isRunningMonth(2026, 6, now)).toBe(false);
    expect(isRunningMonth(2025, 7, now)).toBe(false);
  });
});

describe('getKpiTone — nur bestehende Regeln, sonst neutral', () => {
  it('fehlender Wert ⇒ neutral (nie Ampel auf «—»)', () => {
    expect(getKpiTone('warenquote', null, EMPTY)).toBe('neutral');
  });
  it('Warenquote über warenPctTone (>33 kritisch, >28 warn)', () => {
    expect(getKpiTone('warenquote', 27, EMPTY)).toBe('good');
    expect(getKpiTone('warenquote', 29, EMPTY)).toBe('warn');
    expect(getKpiTone('warenquote', 34, EMPTY)).toBe('critical');
  });
  it('Personalquote nur mit Budget-Ziel', () => {
    expect(getKpiTone('personalquote', 40, EMPTY)).toBe('neutral'); // kein Ziel
    expect(getKpiTone('personalquote', 40, { ...EMPTY, personnelRatioTarget: 35 })).not.toBe(
      'neutral',
    );
  });
  it('Tagesabschluss-Quote über vollstaendigkeitTone (≥80 gut, ≥50 warn)', () => {
    expect(getKpiTone('tagesabschluss_quote', 95, EMPTY)).toBe('good');
    expect(getKpiTone('tagesabschluss_quote', 60, EMPTY)).toBe('warn');
    expect(getKpiTone('tagesabschluss_quote', 40, EMPTY)).toBe('critical');
  });
  it('EBITDA-Marge über Bank-Benchmark (neutral-Zone ⇒ warn-Ton)', () => {
    expect(getKpiTone('ebitda_marge', 16, EMPTY)).toBe('good');
    expect(getKpiTone('ebitda_marge', 14.5, EMPTY)).toBe('warn');
    expect(getKpiTone('ebitda_marge', 12, EMPTY)).toBe('critical');
  });
  it('KPIs ohne bestehende Schwelle bleiben neutral (nichts erfinden)', () => {
    expect(getKpiTone('umsatz', 100000, EMPTY)).toBe('neutral');
    expect(getKpiTone('gaeste', 1200, EMPTY)).toBe('neutral');
    expect(getKpiTone('produktivitaet', 85, EMPTY)).toBe('neutral');
  });
});
