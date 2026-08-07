// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { computePLForMonth } from '../pl-engine';
import type { MonthlyFinancialRecord } from '@/types/reporting';

const rec = (over: Partial<MonthlyFinancialRecord>): MonthlyFinancialRecord =>
  ({
    id: '2026-05', year: 2026, month: 5,
    expenseCategories: [], expenseCategoriesPreviousYear: [],
    ...over,
  } as MonthlyFinancialRecord);

const rowActual = (res: ReturnType<typeof computePLForMonth>, id: string) =>
  res.rows.find(r => r.def.id === id)?.values.actual;

// Befehl 08/2026 (v2): Personal Aushilfe 5004/5005/5011 sind normale
// Personalaufwand-Zeilen — IMMER voll eingerechnet, additiv auch wenn
// personnelCostActual gesetzt ist (Konten sind nicht im Infoniqa-Export,
// daher keine Doppelzählung).
describe('pl-engine: Personal Aushilfe 5004/5005/5011 (immer eingerechnet)', () => {
  it('werden ADDITIV zu personnel_wages gezählt (auch bei gesetztem personnelCostActual)', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      personnelCostActual: 40000,
      expenseCategories: [
        { categoryId: '5004', label: 'Personal Aushilfe', amount: 3000 },
        { categoryId: '5005', label: 'Personal Aushilfe 2', amount: 1000 },
      ] as any,
    }));
    expect(rowActual(res, 'personnel_wages')).toBe(44000);
  });

  it('zählen auch ohne personnelCostActual voll in die Summen', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      expenseCategories: [
        { categoryId: '5011', label: 'Aushilfe', amount: 2000 },
      ] as any,
    }));
    expect(rowActual(res, 'personnel_wages') ?? 0).toBe(2000);
  });

  it('normale 5xxx-Konten (z.B. 5000) zählen weiterhin', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      expenseCategories: [
        { categoryId: '5000', label: 'Löhne', amount: 50000 },
      ] as any,
    }));
    expect(rowActual(res, 'personnel_wages')).toBe(50000);
  });

  it('Vorjahres-5004 zählt additiv in die PY-Summe', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      expenseCategoriesPreviousYear: [
        { categoryId: '5004', label: 'Personal Aushilfe', amount: 2500 },
        { categoryId: '5000', label: 'Löhne', amount: 45000 },
      ] as any,
    }));
    const row = res.rows.find(r => r.def.id === 'personnel_wages');
    expect(row?.values.prevYear).toBe(47500);
  });

  it('Ergebnis (EBITDA-Kette) sinkt um den Aushilfe-Betrag', () => {
    const base = computePLForMonth(rec({ revenueActual: 100000, personnelCostActual: 40000 }));
    const withAush = computePLForMonth(rec({
      revenueActual: 100000,
      personnelCostActual: 40000,
      expenseCategories: [{ categoryId: '5004', label: 'Personal Aushilfe', amount: 10028 }] as any,
    }));
    const g = (res: typeof base, id: string) => res.rows.find(r => r.def.id === id)?.values.actual ?? 0;
    for (const id of ['gross_profit_2', 'ebitda', 'ebit']) {
      const b = g(base, id); const w = g(withAush, id);
      if (b !== 0 || w !== 0) expect(Math.round(b - w)).toBe(10028);
    }
  });
});
