// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { monthCompleteness, isNachrichtlichAccount } from '../month-completeness';
import type { MonthlyFinancialRecord } from '@/types/reporting';

const rec = (over: Partial<MonthlyFinancialRecord>): MonthlyFinancialRecord =>
  ({ id: '2026-08', year: 2026, month: 8, expenseCategories: [], ...over } as MonthlyFinancialRecord);

describe('monthCompleteness', () => {
  it('Umsatz + importierte Kosten ⇒ vollständig', () => {
    const c = monthCompleteness(rec({
      revenueActual: 100000,
      expenseCategories: [{ categoryId: '4000', label: 'Waren', amount: 20000 }] as any,
    }));
    expect(c.complete).toBe(true);
    expect(c.partial).toBe(false);
  });

  it('Umsatz ohne Kosten (August-Fall) ⇒ unvollständig/partial', () => {
    const c = monthCompleteness(rec({ revenueActual: 100000 }));
    expect(c.hasRevenue).toBe(true);
    expect(c.hasCosts).toBe(false);
    expect(c.partial).toBe(true);
    expect(c.complete).toBe(false);
  });

  it('Kosten ohne Umsatz ⇒ partial', () => {
    const c = monthCompleteness(rec({
      expenseCategories: [{ categoryId: '5000', label: 'Löhne', amount: 50000 }] as any,
    }));
    expect(c.partial).toBe(true);
  });

  it('ganz leerer Monat ⇒ weder complete noch partial', () => {
    const c = monthCompleteness(rec({}));
    expect(c.complete).toBe(false);
    expect(c.partial).toBe(false);
  });

  it('3xxx-Konten zählen als Umsatz, nicht als Kosten', () => {
    const c = monthCompleteness(rec({
      expenseCategories: [{ categoryId: '3000', label: 'Ertrag', amount: 90000 }] as any,
    }));
    expect(c.hasRevenue).toBe(true);
    expect(c.hasCosts).toBe(false);
  });

  it('nachrichtliche Konten (5004/5005/5011) qualifizieren NICHT als Kosten', () => {
    const c = monthCompleteness(rec({
      revenueActual: 100000,
      expenseCategories: [{ categoryId: '5004', label: 'Personal Aushilfe', amount: 3000 }] as any,
    }));
    expect(c.hasCosts).toBe(false);
    expect(c.partial).toBe(true);
  });

  it('undefined record ⇒ leer', () => {
    const c = monthCompleteness(undefined);
    expect(c.complete).toBe(false);
    expect(c.partial).toBe(false);
  });
});

describe('isNachrichtlichAccount', () => {
  it('erkennt 5004/5005/5011 inkl. 5-stelliger Varianten', () => {
    expect(isNachrichtlichAccount('5004')).toBe(true);
    expect(isNachrichtlichAccount('5005')).toBe(true);
    expect(isNachrichtlichAccount('5011')).toBe(true);
    expect(isNachrichtlichAccount('50040')).toBe(true);
    expect(isNachrichtlichAccount('5000')).toBe(false);
    expect(isNachrichtlichAccount(undefined)).toBe(false);
  });
});
