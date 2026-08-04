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

// ── Regression: has13thSalary aus der Historie-Phase, nie aus dem Stammsatz ──
// Fall Ibrahim: Juli-Phase Stundenlohn 25.00 OHNE 13. (salary_13=false), ab
// August Monatslohn 5'700 MIT 13. Der Stammsatz trägt has13thSalary=true —
// vor dem Fix leckte das Flag in die Stundenlohn-Phase und calcSL rechnete
// den 13. fälschlich in den AG-Stundensatz ein.
const hourlyJulyNo13 = {
  id: 'w3', employee_id: '105', restaurant_id: 'oliv', valid_from: '2026-07-01',
  hourly_wage: 25.00, monthly_salary: 0, monthly_salary_with_13th: 0,
  salary_13: false, notes: '', created_at: 'x',
};

const empWith13Flag = (): Employee => ({ ...emp(), has13thSalary: true } as unknown as Employee);

describe('applyEffectiveWages — salary13 der massgebenden Phase überschreibt Stammsatz-Flag', () => {
  it('Juli (hourly, salary13=false) → has13thSalary false, AG/h 32.66 bei 15.7% Sozial', async () => {
    mockRows = [hourlyJulyNo13, hourlyRow]; // order desc: neueste zuerst
    const [out] = await applyEffectiveWages([empWith13Flag()], '2026-07-01', 'oliv');
    expect(out.hourlyWage).toBe(25.00);
    expect(out.has13thSalary).toBe(false);
    // Kontrollwert: 25.00 × (1 + 10.65% Ferien + 2.27% Feiertag) × 1.157 = 32.66
    const { getEmployerCostRate } = await import('@/lib/employee-rate');
    const { DEFAULT_SOCIAL_COST_RATES } = await import('@/lib/social-costs');
    const rate = getEmployerCostRate(out, DEFAULT_SOCIAL_COST_RATES);
    expect(rate?.source).toBe('sl');
    expect(rate!.totalHourly).toBeCloseTo(32.66, 2);
  });

  it('August (monthly, salary13=true) → has13thSalary true (FIX mit 13.)', async () => {
    mockRows = [monthlyRow, hourlyJulyNo13, hourlyRow];
    const [out] = await applyEffectiveWages([{ ...emp(), has13thSalary: false } as unknown as Employee], '2026-08-01', 'oliv');
    expect(out.contractType).toBe('monthly');
    expect(out.has13thSalary).toBe(true);
  });

  it('frühere Stundenlohn-Phase MIT 13. bleibt unangetastet (Mai/Juni)', async () => {
    mockRows = [hourlyRow]; // 2026-05-11, salary_13=true
    const [out] = await applyEffectiveWages([empWith13Flag()], '2026-06-01', 'oliv');
    expect(out.hourlyWage).toBe(31.32);
    expect(out.has13thSalary).toBe(true);
  });
});

describe('applyEffectiveWagesForMonth — salary13 pro Monatsphase, auch bei Split', () => {
  it('Juli (hourly-Phase salary13=false) → FLEX ohne 13.', async () => {
    mockRows = [hourlyRow, hourlyJulyNo13]; // order asc
    const { applyEffectiveWagesForMonth } = await import('@/lib/wage-history');
    const { employees: [out], splits } = await applyEffectiveWagesForMonth([empWith13Flag()], 2026, 7, 'oliv');
    expect(out.contractType).toBe('hourly');
    expect(out.hourlyWage).toBe(25.00);
    expect(out.has13thSalary).toBe(false);
    expect(splits['105']).toBeUndefined();
  });

  it('Split-Monat: FIX-Seite salary13 aus Monatslohn-Phase, split.hourly behält eigenes Flag', async () => {
    // Wechsel MITTEN im August (hypothetisch 15.08.): hourly false → monthly true
    const monthlyMid = { ...monthlyRow, valid_from: '2026-08-15' };
    mockRows = [hourlyRow, hourlyJulyNo13, monthlyMid]; // order asc
    const { applyEffectiveWagesForMonth } = await import('@/lib/wage-history');
    const { employees: [out], splits } = await applyEffectiveWagesForMonth(
      [{ ...emp(), has13thSalary: false } as unknown as Employee], 2026, 8, 'oliv');
    expect(out.contractType).toBe('monthly');
    expect(out.has13thSalary).toBe(true);          // FIX-Seite: Monatslohn mit 13.
    expect(splits['105']?.hourly.salary13).toBe(false); // FLEX-Split-Seite: ohne 13.
  });
});
