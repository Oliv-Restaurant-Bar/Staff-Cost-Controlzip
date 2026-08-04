// @vitest-environment happy-dom
/**
 * D009 — FinancialMonthSection (Dashboard, finanzieller Bereich).
 *
 * Fixiert: (1) Finanzkarten verwenden die Financial-Metrics-Registry,
 * (2) IST kommt aus der P&L-Engine, (3) Budget-Spalte = Registry-budget,
 * (4) Vorjahres-Spalte = Registry-priorYear, (5) fehlende P&L-Werte bleiben
 * „—" (fehlend ≠ 0), (6) KEIN Fallback auf operative Tageswerte,
 * (8) eindeutige Bezeichnungen, (12) reines Rendern löst keine Writes aus.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FinancialMonthSection } from '@/components/dashboard/FinancialMonthSection';
import {
  getGatedFinancialMetricValues,
  type FinancialMetricId,
  type FinancialMetricRegistryInput,
} from '@/lib/financial-metrics';
import { computePLForMonth } from '@/lib/pl-engine';
import type { MonthlyFinancialRecord } from '@/types/reporting';

// ─── Fixtures (identisches Muster wie financial-metrics.test.ts) ─────────────

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

/** Voll befüllter Monat: Umsatz 100k, Waren 30k, Personal 35k. */
const fullRec = mkRec(2026, 7, {
  revenueActual: 100_000,
  personnelCostActual: 35_000,
  expenseCategories: [
    { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
    { categoryId: 'miete', amount: 10_000, label: 'Miete' },
    { categoryId: 'abschreibungen', amount: 5_000, label: 'Abschreibungen' },
  ] as never,
});

/** Leerer Monat: keinerlei Werte — alles muss „—" bleiben. */
const emptyRec = mkRec(2026, 7);

const inputOf = (rec: MonthlyFinancialRecord): FinancialMetricRegistryInput => ({
  pl: computePLForMonth(rec),
});

// Identische Anzeige-Formatierer wie in der Komponente (Intl deterministisch).
const fmtCHF = (v: number | null): string =>
  v === null
    ? '—'
    : new Intl.NumberFormat('de-CH', {
        style: 'currency',
        currency: 'CHF',
        maximumFractionDigits: 0,
      }).format(v);
const fmtPct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)} %`);

const TABLE_IDS: { id: FinancialMetricId; kind: 'amount' | 'ratio' }[] = [
  { id: 'net_revenue', kind: 'amount' },
  { id: 'total_cogs', kind: 'amount' },
  { id: 'cogs_ratio', kind: 'ratio' },
  { id: 'total_personnel', kind: 'amount' },
  { id: 'personnel_ratio', kind: 'ratio' },
  { id: 'ebitda', kind: 'amount' },
  { id: 'ebit', kind: 'amount' },
];

const renderSection = (input: FinancialMetricRegistryInput | null) =>
  render(
    <MemoryRouter>
      <FinancialMonthSection input={input} monthLabel="Juli 2026" personnelRatioTarget={35} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FinancialMonthSection — Registry-Verdrahtung (D009 1–4)', () => {
  it('(1)+(2) jede Tabellenzelle IST ≡ getGatedFinancialMetricValues(...).actual (keine Zweitberechnung)', () => {
    const input = inputOf(fullRec);
    renderSection(input);
    for (const { id, kind } of TABLE_IDS) {
      const v = getGatedFinancialMetricValues(id, input);
      const fmt = kind === 'ratio' ? fmtPct : fmtCHF;
      expect(screen.getByTestId(`fin-${id}-actual`).textContent).toBe(fmt(v.actual));
    }
    // Plausibilität: IST kommt aus der P&L-Engine (100k Umsatz aus revenueActual).
    expect(screen.getByTestId('fin-net_revenue-actual').textContent).toBe(fmtCHF(100_000));
  });

  it('(3) Budget-Spalte ≡ Registry-budget je Kennzahl', () => {
    const input = inputOf(fullRec);
    renderSection(input);
    for (const { id, kind } of TABLE_IDS) {
      const v = getGatedFinancialMetricValues(id, input);
      const fmt = kind === 'ratio' ? fmtPct : fmtCHF;
      expect(screen.getByTestId(`fin-${id}-budget`).textContent).toBe(fmt(v.budget));
    }
  });

  it('(4) Vorjahres-Spalte ≡ Registry-priorYear je Kennzahl', () => {
    const input = inputOf(fullRec);
    renderSection(input);
    for (const { id, kind } of TABLE_IDS) {
      const v = getGatedFinancialMetricValues(id, input);
      const fmt = kind === 'ratio' ? fmtPct : fmtCHF;
      expect(screen.getByTestId(`fin-${id}-prioryear`).textContent).toBe(fmt(v.priorYear));
    }
  });
});

describe('FinancialMonthSection — fehlend ≠ 0, kein operativer Fallback (D009 5–6)', () => {
  it('(5) leerer Monat: alle Zellen zeigen „—", nirgends 0', () => {
    renderSection(inputOf(emptyRec));
    for (const { id } of TABLE_IDS) {
      for (const col of ['actual', 'budget', 'prioryear']) {
        const text = screen.getByTestId(`fin-${id}-${col}`).textContent;
        expect(text).toBe('—');
      }
    }
  });

  it('(5b) Dependency-Gate: ohne Abschreibungen bleibt EBIT „—", Umsatz sichtbar (kein Schein-EBIT)', () => {
    const recOhneAbschr = mkRec(2026, 7, {
      revenueActual: 100_000,
      personnelCostActual: 35_000,
      expenseCategories: [
        { categoryId: 'food_cost', amount: 30_000, label: 'Wareneinsatz Küche' },
        { categoryId: 'miete', amount: 10_000, label: 'Miete' },
      ] as never,
    });
    renderSection(inputOf(recOhneAbschr));
    expect(screen.getByTestId('fin-ebit-actual').textContent).toBe('—');
    // EBITDA hängt NICHT an den Abschreibungen — bleibt sichtbar (100−30−35−10).
    expect(screen.getByTestId('fin-ebitda-actual').textContent).toBe(fmtCHF(25_000));
    expect(screen.getByTestId('fin-net_revenue-actual').textContent).toBe(fmtCHF(100_000));
    expect(screen.getByTestId('fin-total_cogs-actual').textContent).toBe(fmtCHF(30_000));
  });

  it('(6) input=null: sichtbarer Hinweis, KEINE Zahlen, kein operativer Ersatzwert', () => {
    renderSection(null);
    expect(screen.getByTestId('financial-month-section').textContent).toContain(
      'keine operativen Ersatzwerte',
    );
    expect(screen.queryByTestId('fin-net_revenue-actual')).toBeNull();
    expect(screen.queryByTestId('fin-kpi-net_revenue')).toBeNull();
    // Komponenten-API kennt operative Werte gar nicht — kein CHF-Betrag im DOM.
    expect(screen.getByTestId('financial-month-section').textContent).not.toMatch(/CHF/u);
  });
});

describe('FinancialMonthSection — Bezeichnungen + Read-only (D009 8, 12)', () => {
  it('(8) eindeutige Bezeichnungen: „… gemäss Erfolgsrechnung" auf den Finanzkarten', () => {
    renderSection(inputOf(fullRec));
    expect(screen.getByText('Umsatz gemäss Erfolgsrechnung')).toBeTruthy();
    expect(screen.getByText('Personalkosten gemäss Erfolgsrechnung')).toBeTruthy();
    // Operative Bezeichnungen kommen hier NICHT vor.
    expect(screen.queryByText(/Tagesumsatz gemäss Z-Bericht/)).toBeNull();
    expect(screen.queryByText(/gemäss Dienstplan/)).toBeNull();
  });

  it('(12) reines Rendern schreibt NIE (kein localStorage.setItem)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderSection(inputOf(fullRec));
    renderSection(null);
    expect(setItem).not.toHaveBeenCalled();
  });
});
