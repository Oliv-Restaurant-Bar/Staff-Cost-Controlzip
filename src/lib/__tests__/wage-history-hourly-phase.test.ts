// @vitest-environment node
/**
 * Regression: Stundenlohn-Phase in der Lohnhistorie muss den Monatslohn
 * des Employee-Stammsatzes VERDRÄNGEN (auf 0 setzen).
 * ===================================================================
 * Fall Ibrahim: bis 31.07.2026 Stundenlohn (31.32), ab 01.08.2026 Monatslohn
 * (5'700). Der Stammsatz trägt bereits den (neuen) Monatslohn. Vor dem Fix
 * behielt applyEffectiveWages bei einer hourly-only-Phase (monthly_salary=0)
 * den Stammsatz-Monatslohn via `?? emp.monthlySalary` → der MA zählte auch in
 * Vormonaten fälschlich als Fix-MA.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Employee } from '@/types/personnel';

// Supabase-Client mocken: employee_wages-Abfrage liefert kontrollierte Zeilen.
let mockRows: Record<string, unknown>[] = [];
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            lte: () => ({
              order: () => Promise.resolve({ data: mockRows, error: null }),
            }),
          }),
        }),
      }),
    }),
  },
}));

import { applyEffectiveWages } from '@/lib/wage-history';

const emp = (): Employee => ({
  id: '105',
  name: 'Ibrahim',
  employmentType: 'vollzeit',
  contractType: 'monthly',
  hourlyWage: 0,
  monthlySalary: 5700,
  monthlySalaryWith13th: 6175,
} as unknown as Employee);

const hourlyRow = {
  id: 'w1', employee_id: '105', restaurant_id: 'oliv', valid_from: '2026-05-11',
  hourly_wage: 31.32, monthly_salary: 0, monthly_salary_with_13th: 0,
  salary_13: true, notes: '', created_at: 'x',
};
const monthlyRow = {
  id: 'w2', employee_id: '105', restaurant_id: 'oliv', valid_from: '2026-08-01',
  hourly_wage: 0, monthly_salary: 5700, monthly_salary_with_13th: 6175,
  salary_13: true, notes: '', created_at: 'x',
};

describe('applyEffectiveWages — Stundenlohn-Phase verdrängt Stammsatz-Monatslohn', () => {
  it('Juli (nur hourly-Eintrag gültig) → monthlySalary 0, hourlyWage 31.32, contractType hourly', async () => {
    mockRows = [hourlyRow]; // Abfrage lte('2026-07-01') liefert nur die hourly-Phase
    const [out] = await applyEffectiveWages([emp()], '2026-07-01', 'oliv');
    expect(out.hourlyWage).toBe(31.32);
    expect(out.monthlySalary).toBe(0);
    expect(out.monthlySalaryWith13th).toBe(0);
    expect(out.contractType).toBe('hourly');
  });

  it('August (monthly-Eintrag neuester) → Monatslohn gilt', async () => {
    mockRows = [monthlyRow, hourlyRow]; // order desc: neuester zuerst
    const [out] = await applyEffectiveWages([emp()], '2026-08-01', 'oliv');
    expect(out.monthlySalary).toBe(5700);
    expect(out.monthlySalaryWith13th).toBe(6175);
    expect(out.contractType).toBe('monthly');
  });

  it('keine Historie → Stammsatz unverändert (Fallback)', async () => {
    mockRows = [];
    const [out] = await applyEffectiveWages([emp()], '2026-04-01', 'oliv');
    expect(out.monthlySalary).toBe(5700);
    expect(out.contractType).toBe('monthly');
  });
});
