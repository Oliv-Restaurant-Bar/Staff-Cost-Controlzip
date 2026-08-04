// @vitest-environment node
/**
 * FIX/FLEX nach aktiver Vertragsphase des MONATS (Fallback-Bug).
 * Testet getMonthWageResolutionBatch / applyEffectiveWagesForMonth:
 *  - Voll-Stundenlohn-Monat → Monatslohn verdrängt (FLEX)
 *  - Backfill: früheste Phase beginnt mitten im Monat → gilt ab Monatsbeginn
 *  - Voll-Monatslohn-Monat → FIX
 *  - Phasenwechsel im Monat → Split mit Tage-Anteilen
 *  - Ohne Historie → Stammsatz-Fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rowsRef: { rows: Record<string, unknown>[] } = { rows: [] };

vi.mock('@/integrations/supabase/client', () => {
  const makeBuilder = () => {
    const b: any = {};
    for (const m of ['select', 'eq', 'in', 'order']) b[m] = vi.fn(() => b);
    b.lte = vi.fn((_col: string, value: string) => {
      b._lte = value;
      return b;
    });
    b.then = (resolve: (v: unknown) => void) =>
      resolve({
        data: rowsRef.rows
          .filter(r => String(r.valid_from) <= String(b._lte ?? '9999-12-31'))
          .sort((a, b2) => String(a.valid_from).localeCompare(String(b2.valid_from))),
        error: null,
      });
    return b;
  };
  return { supabase: { from: vi.fn(() => makeBuilder()) } };
});

import { getMonthWageResolutionBatch, applyEffectiveWagesForMonth } from '../wage-history';
import type { Employee } from '@/types/personnel';

const row = (empId: string, validFrom: string, hourly: number, monthly: number) => ({
  id: `${empId}-${validFrom}`, employee_id: empId, restaurant_id: 'oliv',
  valid_from: validFrom, hourly_wage: hourly, monthly_salary: monthly,
  monthly_salary_with_13th: monthly ? Math.round(monthly * (13 / 12)) : 0,
  salary_13: true, notes: '', created_at: '2026-05-01',
});

const emp = (id: string): Employee => ({
  id, name: `MA ${id}`, department: 'service', employmentType: 'vollzeit',
  contractType: 'monthly', hourlyWage: 0, monthlySalary: 5700, monthlySalaryWith13th: 6175,
} as unknown as Employee);

beforeEach(() => { rowsRef.rows = []; });

describe('getMonthWageResolutionBatch (Ibrahim-Konstellation)', () => {
  beforeEach(() => {
    rowsRef.rows = [
      row('105', '2026-05-11', 31.32, 0),    // Stundenlohn-Phase (Erfassungsbeginn)
      row('105', '2026-08-01', 0, 5700),     // Monatslohn ab 01.08.
    ];
  });

  it('Mai: Backfill — Stundenlohn-Phase gilt ab Monatsbeginn (kein Split, kein Fallback)', async () => {
    const res = await getMonthWageResolutionBatch(['105'], 2026, 5, 'oliv');
    expect(res['105'].wage.wageType).toBe('hourly');
    expect(res['105'].split).toBeUndefined();
  });

  it('Juni/Juli: Stundenlohn (Phase aktiv am Monatsersten)', async () => {
    for (const m of [6, 7]) {
      const res = await getMonthWageResolutionBatch(['105'], 2026, m, 'oliv');
      expect(res['105'].wage.wageType).toBe('hourly');
      expect(res['105'].wage.hourlyWage).toBe(31.32);
      expect(res['105'].split).toBeUndefined();
    }
  });

  it('August: Monatslohn (Wechsel exakt am 01. → kein Split)', async () => {
    const res = await getMonthWageResolutionBatch(['105'], 2026, 8, 'oliv');
    expect(res['105'].wage.wageType).toBe('monthly');
    expect(res['105'].wage.monthlySalary).toBe(5700);
    expect(res['105'].split).toBeUndefined();
  });
});

describe('applyEffectiveWagesForMonth', () => {
  it('Stundenlohn-Monat verdrängt Stammsatz-Monatslohn → FLEX-Klassifikation', async () => {
    rowsRef.rows = [row('105', '2026-05-11', 31.32, 0), row('105', '2026-08-01', 0, 5700)];
    const { employees, splits } = await applyEffectiveWagesForMonth([emp('105')], 2026, 7, 'oliv');
    expect(employees[0].monthlySalary).toBe(0);
    expect(employees[0].hourlyWage).toBe(31.32);
    expect(employees[0].contractType).toBe('hourly');
    expect(splits).toEqual({});
  });

  it('Monatslohn-Monat → FIX-Werte, keine Verdrängung', async () => {
    rowsRef.rows = [row('105', '2026-05-11', 31.32, 0), row('105', '2026-08-01', 0, 5700)];
    const { employees } = await applyEffectiveWagesForMonth([emp('105')], 2026, 8, 'oliv');
    expect(employees[0].monthlySalary).toBe(5700);
    expect(employees[0].contractType).toBe('monthly');
  });

  it('Ohne Historie → Stammsatz unverändert (Fallback)', async () => {
    rowsRef.rows = [];
    const { employees, splits } = await applyEffectiveWagesForMonth([emp('99')], 2026, 8, 'oliv');
    expect(employees[0].monthlySalary).toBe(5700);
    expect(splits).toEqual({});
  });

  it('Phasenwechsel MITTEN im Monat → Split mit Tage-Anteilen, Employee = FIX-Seite', async () => {
    // Stundenlohn bis 15.08., Monatslohn ab 16.08. → 15/31 flex, 16/31 fix
    rowsRef.rows = [row('7', '2026-05-01', 30, 0), row('7', '2026-08-16', 0, 6000)];
    const { employees, splits } = await applyEffectiveWagesForMonth([emp('7')], 2026, 8, 'oliv');
    const s = splits['7'];
    expect(s).toBeDefined();
    expect(s.hourlyFrom).toBe('2026-08-01');
    expect(s.hourlyTo).toBe('2026-08-15');
    expect(s.monthlyFrom).toBe('2026-08-16');
    expect(s.hourlyFraction).toBeCloseTo(15 / 31);
    expect(s.monthlyFraction).toBeCloseTo(16 / 31);
    // Employee trägt die Monatslohn-Werte (FIX-Liste); Flex-Anteil via splits
    expect(employees[0].monthlySalary).toBe(6000);
  });
});
