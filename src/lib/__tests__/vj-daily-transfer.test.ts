// @vitest-environment node
/**
 * Tests für die reine Übernahme-Logik vj_daily → Erfolgsrechnung (reporting_v1).
 * Kernregeln: fehlend ≠ 0 (Monate ohne Tage/Summe nie anlegen),
 * kein stilles Überschreiben (Konflikte nur mit expliziter Markierung),
 * Netto = grossToNet(Σ Brutto, 0) — identische Basis wie computeMonthlyVjNet.
 */
import { describe, it, expect } from 'vitest';
import {
  buildVjTransferPlan,
  buildVjTransferPayload,
  selectTransferMonths,
} from '@/lib/vj-daily-transfer';
import { grossToNet, VAT_RATES } from '@/types/personnel';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

const day = (date: string, gross: number): [string, VjDayRecord] => [
  date,
  { date, year: parseInt(date.slice(0, 4)), actualRevenue: gross, source: 'vorjahr_import' },
];

const emptyMonth = (month: number) => ({ month });

describe('buildVjTransferPlan', () => {
  it('aggregiert Tage pro Monat und rechnet Netto = grossToNet(Σ, 0)', () => {
    const vjDays = Object.fromEntries([
      day('2024-01-01', 1000),
      day('2024-01-02', 500.5),
      day('2024-02-10', 2000),
    ]);
    const plan = buildVjTransferPlan(2024, vjDays, Array.from({ length: 12 }, (_, i) => emptyMonth(i + 1)));

    expect(plan).toHaveLength(12);
    const jan = plan[0];
    expect(jan.monthId).toBe('2024-01');
    expect(jan.dayCount).toBe(2);
    expect(jan.grossTotal).toBeCloseTo(1500.5, 10);
    expect(jan.netTotal).toBeCloseTo(1500.5 / (1 + VAT_RATES.standard), 10);
    expect(jan.transferable).toBe(true);
    expect(jan.conflict).toBe(false);
  });

  it('Netto über Monatssumme ≡ Summe der Tages-Netti (Linearität, Basis computeMonthlyVjNet)', () => {
    const values = [7118.45, 1234.55, 999.99];
    const vjDays = Object.fromEntries(values.map((v, i) => day(`2024-03-0${i + 1}`, v)));
    const plan = buildVjTransferPlan(2024, vjDays, []);
    const perDaySum = values.reduce((s, v) => s + grossToNet(v, 0), 0);
    expect(plan[2].netTotal).toBeCloseTo(perDaySum, 8);
  });

  it('fehlend ≠ 0: Monate ohne Tage oder mit Summe 0 sind nicht übertragbar', () => {
    const vjDays = Object.fromEntries([day('2024-04-01', 0), day('2024-04-02', 0)]);
    const plan = buildVjTransferPlan(2024, vjDays, []);
    // April: Tage vorhanden, aber Summe 0 → nie anlegen
    expect(plan[3].dayCount).toBe(2);
    expect(plan[3].grossTotal).toBe(0);
    expect(plan[3].transferable).toBe(false);
    // Mai: keine Tage
    expect(plan[4].dayCount).toBe(0);
    expect(plan[4].transferable).toBe(false);
  });

  it('ignoriert Tage anderer Jahre und ungültige Werte', () => {
    const vjDays = Object.fromEntries([
      day('2024-06-01', 100),
      day('2023-06-01', 9999),
      ['2024-06-02', { date: '2024-06-02', year: 2024, actualRevenue: NaN, source: 'x' } as VjDayRecord],
    ]);
    const plan = buildVjTransferPlan(2024, vjDays, []);
    expect(plan[5].dayCount).toBe(2); // NaN-Tag zählt als Tag, aber mit 0 CHF
    expect(plan[5].grossTotal).toBe(100);
  });

  it('erkennt Konflikte: bestehende grossRevenueManual ODER revenueActual', () => {
    const vjDays = Object.fromEntries([day('2024-01-05', 100), day('2024-02-05', 100), day('2024-03-05', 100)]);
    const existing = [
      { month: 1, grossRevenueManual: 5000 },
      { month: 2, revenueActual: 4000 },
      { month: 3 },
    ];
    const plan = buildVjTransferPlan(2024, vjDays, existing);
    expect(plan[0].conflict).toBe(true);
    expect(plan[0].existingGross).toBe(5000);
    expect(plan[1].conflict).toBe(true);
    expect(plan[1].existingNet).toBe(4000);
    expect(plan[2].conflict).toBe(false);
    expect(plan[2].existingGross).toBeUndefined();
  });
});

describe('selectTransferMonths', () => {
  it('überträgt Konflikt-Monate nur mit expliziter Überschreiben-Markierung', () => {
    const vjDays = Object.fromEntries([day('2024-01-05', 100), day('2024-02-05', 100)]);
    const existing = [{ month: 1, grossRevenueManual: 5000 }, { month: 2 }];
    const plan = buildVjTransferPlan(2024, vjDays, existing);

    const ohne = selectTransferMonths(plan, new Set());
    expect(ohne.map(p => p.month)).toEqual([2]);

    const mit = selectTransferMonths(plan, new Set([1]));
    expect(mit.map(p => p.month)).toEqual([1, 2]);
  });

  it('nicht übertragbare Monate werden auch mit Markierung nie gewählt', () => {
    const plan = buildVjTransferPlan(2024, {}, []);
    expect(selectTransferMonths(plan, new Set([1, 2, 3]))).toEqual([]);
  });
});

describe('buildVjTransferPayload', () => {
  it('liefert nur Umsatzfelder — takeAwayGrossManual bleibt undefined', () => {
    const vjDays = Object.fromEntries([day('2024-07-01', 1081)]);
    const plan = buildVjTransferPlan(2024, vjDays, []);
    const payload = buildVjTransferPayload(2024, plan[6]);
    expect(payload).toEqual({
      year: 2024,
      month: 7,
      grossRevenueManual: 1081,
      revenueActual: 1081 / 1.081,
    });
    expect('takeAwayGrossManual' in payload).toBe(false);
    expect('expenseCategories' in payload).toBe(false);
  });
});
