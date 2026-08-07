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

describe('pl-engine: nachrichtliche Konten 5004/5005/5011', () => {
  it('werden NICHT zu personnel_wages addiert (auch nicht additiv zu personnelCostActual)', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      personnelCostActual: 40000,
      expenseCategories: [
        { categoryId: '5004', label: 'Personal Aushilfe', amount: 3000 },
        { categoryId: '5005', label: 'Personal Aushilfe 2', amount: 1000 },
      ] as any,
    }));
    expect(rowActual(res, 'personnel_wages')).toBe(40000);
  });

  it('zählen ohne personnelCostActual ebenfalls nicht in die Summen', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      expenseCategories: [
        { categoryId: '5011', label: 'Aushilfe', amount: 2000 },
      ] as any,
    }));
    expect(rowActual(res, 'personnel_wages') ?? 0).toBe(0);
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

  it('Vorjahres-5004 zählt nicht in die PY-Summe', () => {
    const res = computePLForMonth(rec({
      revenueActual: 100000,
      expenseCategoriesPreviousYear: [
        { categoryId: '5004', label: 'Personal Aushilfe', amount: 2500 },
        { categoryId: '5000', label: 'Löhne', amount: 45000 },
      ] as any,
    }));
    const row = res.rows.find(r => r.def.id === 'personnel_wages');
    expect(row?.values.prevYear).toBe(45000);
  });
});
