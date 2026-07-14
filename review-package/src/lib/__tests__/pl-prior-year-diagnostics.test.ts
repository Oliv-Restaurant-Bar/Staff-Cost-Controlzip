// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computePriorYearDiagnostics } from '@/lib/pl-prior-year-diagnostics';
import { createEmptyMonth, type MonthlyFinancialRecord } from '@/types/reporting';
import type { VjDayRecord } from '@/lib/vj-daily-supabase';

const PRIOR_YEAR = 2024;

/** 12 leere Vorjahres-Monate (wie loadYear sie liefert). */
function emptyYear(year = PRIOR_YEAR): MonthlyFinancialRecord[] {
  return Array.from({ length: 12 }, (_, i) => createEmptyMonth(year, i + 1));
}

function withRevenue(month: number, amount: number, year = PRIOR_YEAR): MonthlyFinancialRecord {
  return { ...createEmptyMonth(year, month), revenueActual: amount };
}

function vjDay(date: string, revenue: number, year = PRIOR_YEAR): VjDayRecord {
  return { date, year, actualRevenue: revenue, source: 'vorjahr_import' };
}

describe('computePriorYearDiagnostics', () => {
  it('no prior-year data → status "none" with dynamic-year message', () => {
    const diag = computePriorYearDiagnostics(PRIOR_YEAR, emptyYear(), {});

    expect(diag.status).toBe('none');
    expect(diag.hasAnyData).toBe(false);
    expect(diag.hasAnyRevenue).toBe(false);
    expect(diag.hasAnyCosts).toBe(false);
    expect(diag.hasRevenue).toBe(false);
    expect(diag.hasExpenses).toBe(false);
    expect(diag.hasPersonnel).toBe(false);
    expect(diag.hasDailyRevenue).toBe(false);
    expect(diag.message).toBe(
      'Keine Vorjahresdaten für 2024 vorhanden. Bitte Vorjahres-Kontoblätter oder Vorjahreswerte importieren.',
    );
  });

  it('uses the dynamic prior year in the "none" message', () => {
    const diag = computePriorYearDiagnostics(2023, emptyYear(2023), {});
    expect(diag.message).toContain('für 2023');
  });

  it('handles null/undefined inputs as "none"', () => {
    const diag = computePriorYearDiagnostics(PRIOR_YEAR, null, null);
    expect(diag.status).toBe('none');
    expect(diag.hasAnyData).toBe(false);
  });

  it('only monthly revenue → status "revenue_only"', () => {
    const recs = emptyYear();
    recs[2] = withRevenue(3, 50_000);

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, recs, {});

    expect(diag.status).toBe('revenue_only');
    expect(diag.hasRevenue).toBe(true);
    expect(diag.hasAnyRevenue).toBe(true);
    expect(diag.hasAnyCosts).toBe(false);
    expect(diag.message).toBe(
      'Vorjahresumsatz vorhanden, aber keine Vorjahreskosten vorhanden.',
    );
  });

  it('only daily revenue (no monthly records) → status "revenue_only"', () => {
    const daily: Record<string, VjDayRecord> = {
      '2024-04-03': vjDay('2024-04-03', 1234),
    };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, emptyYear(), daily);

    expect(diag.status).toBe('revenue_only');
    expect(diag.hasRevenue).toBe(false);
    expect(diag.hasDailyRevenue).toBe(true);
    expect(diag.hasAnyRevenue).toBe(true);
    expect(diag.hasAnyCosts).toBe(false);
  });

  it('full prior-year data (revenue + expenses + personnel) → status "ok", no message', () => {
    const recs = emptyYear();
    recs[0] = {
      ...withRevenue(1, 80_000),
      personnelCostActual: 22_000,
      expenseCategories: [{ categoryId: '4000', amount: 15_000 }],
    };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, recs, {});

    expect(diag.status).toBe('ok');
    expect(diag.message).toBeNull();
    expect(diag.hasRevenue).toBe(true);
    expect(diag.hasExpenses).toBe(true);
    expect(diag.hasPersonnel).toBe(true);
    expect(diag.hasAnyData).toBe(true);
    expect(diag.hasAnyCosts).toBe(true);
  });

  it('revenue + expenses only (no personnel) is still "ok"', () => {
    const recs = emptyYear();
    recs[5] = {
      ...withRevenue(6, 60_000),
      expenseCategories: [{ categoryId: '5000', amount: 9_000 }],
    };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, recs, {});

    expect(diag.status).toBe('ok');
    expect(diag.hasExpenses).toBe(true);
    expect(diag.hasPersonnel).toBe(false);
    expect(diag.hasAnyCosts).toBe(true);
  });

  it('revenue + personnel only (no expense categories) is still "ok"', () => {
    const recs = emptyYear();
    recs[5] = { ...withRevenue(6, 60_000), personnelCostActual: 18_000 };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, recs, {});

    expect(diag.status).toBe('ok');
    expect(diag.hasPersonnel).toBe(true);
    expect(diag.hasExpenses).toBe(false);
    expect(diag.hasAnyCosts).toBe(true);
  });

  it('ignores zero-amount expense categories and zero revenue', () => {
    const recs = emptyYear();
    recs[0] = {
      ...createEmptyMonth(PRIOR_YEAR, 1),
      revenueActual: 0,
      expenseCategories: [{ categoryId: '4000', amount: 0 }],
    };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, recs, {});

    expect(diag.hasRevenue).toBe(false);
    expect(diag.hasExpenses).toBe(false);
    expect(diag.status).toBe('none');
  });

  it('ignores daily records that belong to a different year', () => {
    const daily: Record<string, VjDayRecord> = {
      // wrong year both in key and record.year → must be ignored
      '2025-04-03': vjDay('2025-04-03', 5000, 2025),
    };

    const diag = computePriorYearDiagnostics(PRIOR_YEAR, emptyYear(), daily);

    expect(diag.hasDailyRevenue).toBe(false);
    expect(diag.status).toBe('none');
  });
});
