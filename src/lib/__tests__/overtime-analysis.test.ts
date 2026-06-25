// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Employee } from '@/types/personnel';
import {
  computeOvertimeAnalysis,
  computeOvertimeTotals,
  isFixedSalaryEmployee,
  monthlyTargetHours,
  workloadPercent,
  weeklyTargetHours,
  WEEKLY_FULLTIME_TARGET,
  DAILY_OVERTIME_THRESHOLD,
  type OvertimeHoursEntry,
} from '@/lib/overtime-analysis';

// ── Test-Helfer ──────────────────────────────────────────────────────────────
function emp(partial: Partial<Employee> & { id: string }): Employee {
  return {
    name: partial.id,
    department: 'service',
    employmentType: 'vollzeit',
    isActive: true,
    ...partial,
  } as Employee;
}

/** Erzeugt `count` Tageseinträge ab 2026-06-01 mit `hours` pro Tag. */
function days(
  employeeId: string,
  count: number,
  hours: number,
  opts: { absenceType?: string; isAdditionalCost?: boolean; startDay?: number } = {},
): OvertimeHoursEntry[] {
  const out: OvertimeHoursEntry[] = [];
  const start = opts.startDay ?? 1;
  for (let i = 0; i < count; i++) {
    const day = String(start + i).padStart(2, '0');
    out.push({
      employeeId,
      date: `2026-06-${day}`,
      hours,
      absenceType: opts.absenceType,
      isAdditionalCost: opts.isAdditionalCost,
    });
  }
  return out;
}

const JUNE_DAYS = 30; // Monatssoll 100 % = 6 × 30 = 180 h

// ── Konstanten / Hilfsfunktionen ─────────────────────────────────────────────
describe('Konstanten und Helfer', () => {
  it('WEEKLY_FULLTIME_TARGET = 42, DAILY_OVERTIME_THRESHOLD = 8.4', () => {
    expect(WEEKLY_FULLTIME_TARGET).toBe(42);
    expect(DAILY_OVERTIME_THRESHOLD).toBe(8.4);
  });

  it('weeklyTargetHours: 42×Pensum bzw. 42 als Default', () => {
    expect(weeklyTargetHours(emp({ id: 'a', weeklyHours: 42 }))).toBe(42);
    expect(weeklyTargetHours(emp({ id: 'b', weeklyHours: 33.6 }))).toBe(33.6);
    expect(weeklyTargetHours(emp({ id: 'c', weeklyHours: 21 }))).toBe(21);
    expect(weeklyTargetHours(emp({ id: 'd' }))).toBe(42);
  });

  it('workloadPercent: 100/80/50, Default 100', () => {
    expect(workloadPercent(emp({ id: 'a', weeklyHours: 42 }))).toBe(100);
    expect(workloadPercent(emp({ id: 'b', weeklyHours: 33.6 }))).toBe(80);
    expect(workloadPercent(emp({ id: 'c', weeklyHours: 21 }))).toBe(50);
    expect(workloadPercent(emp({ id: 'd' }))).toBe(100);
  });

  it('monthlyTargetHours = 42 × (Tage/7) × Pensum', () => {
    const full = emp({ id: 'a', weeklyHours: 42 });
    expect(monthlyTargetHours(full, 30)).toBe(180);
    expect(monthlyTargetHours(full, 31)).toBe(186);
    expect(monthlyTargetHours(full, 28)).toBe(168);
    expect(monthlyTargetHours(emp({ id: 'b', weeklyHours: 33.6 }), 30)).toBe(144);
    expect(monthlyTargetHours(emp({ id: 'c', weeklyHours: 21 }), 30)).toBe(90);
    expect(monthlyTargetHours(emp({ id: 'd' }), 30)).toBe(180); // Default 100 %
  });

  it('isFixedSalaryEmployee: vollzeit/teilzeit MIT Monatslohn', () => {
    expect(isFixedSalaryEmployee(emp({ id: 'a', employmentType: 'vollzeit', monthlySalary: 6000 }))).toBe(true);
    expect(isFixedSalaryEmployee(emp({ id: 'b', employmentType: 'teilzeit', monthlySalary: 4000 }))).toBe(true);
    expect(isFixedSalaryEmployee(emp({ id: 'c', employmentType: 'minijob', hourlyWage: 30 }))).toBe(false);
    expect(isFixedSalaryEmployee(emp({ id: 'd', employmentType: 'aushilfe', hourlyWage: 28 }))).toBe(false);
    // vollzeit OHNE Monatslohn (fälschlich erfasste Aushilfe) → ausgeschlossen
    expect(isFixedSalaryEmployee(emp({ id: 'e', employmentType: 'vollzeit', monthlySalary: 0 }))).toBe(false);
  });
});

// ── Pflicht-Testfall 1: unter Monatssoll → keine Überstunden ──────────────────
describe('unter Monatssoll → 0 Überstunden', () => {
  it('160 h bei Soll 180 h → 0 Überstunden, Differenz −20', () => {
    const e = emp({ id: 'A', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: days('A', 16, 10), // 160 h
      daysInMonth: JUNE_DAYS,
    });
    expect(res.employees).toHaveLength(1);
    const r = res.employees[0];
    expect(r.monthlyTargetHours).toBe(180);
    expect(r.productiveHours).toBe(160);
    expect(r.difference).toBe(-20);
    expect(r.overtimeHours).toBe(0);
    expect(r.overtimeCost).toBe(0);
    expect(r.workloadPercent).toBe(100);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });
});

// ── Pflicht-Testfall 2: über Monatssoll → Überstunden = Ist − Soll ────────────
describe('über Monatssoll → Überstunden = Ist − Soll', () => {
  it('190 h bei Soll 180 h → 10 h Überstunden, Kosten 10 × Satz', () => {
    const e = emp({ id: 'B', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: days('B', 19, 10), // 190 h
      daysInMonth: JUNE_DAYS,
    });
    const r = res.employees[0];
    expect(r.productiveHours).toBe(190);
    expect(r.difference).toBe(10);
    expect(r.overtimeHours).toBe(10);
    expect(r.overtimeCost).toBe(500); // 10 × 50
    expect(res.totalOvertimeHours).toBe(10);
    expect(res.totalOvertimeCost).toBe(500);
    expect(res.affectedEmployeeCount).toBe(1);
  });

  it('80 % Pensum (Soll 144): 150 h → 6 h Überstunden', () => {
    const e = emp({ id: 'P80', employmentType: 'teilzeit', monthlySalary: 4800, hourlyWage: 40, weeklyHours: 33.6 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: days('P80', 15, 10), // 150 h
      daysInMonth: JUNE_DAYS,
    });
    const r = res.employees[0];
    expect(r.monthlyTargetHours).toBe(144);
    expect(r.workloadPercent).toBe(80);
    expect(r.overtimeHours).toBe(6);
    expect(r.overtimeCost).toBe(240); // 6 × 40
  });
});

// ── Pflicht-Testfall 3: stündliche/flexible MA ausgeschlossen ─────────────────
describe('stündliche/flexible Mitarbeiter ausgeschlossen', () => {
  it('minijob + vollzeit-ohne-Monatslohn werden ignoriert, Festangestellter bleibt', () => {
    const fixed = emp({ id: 'FIX', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const mini = emp({ id: 'MINI', employmentType: 'minijob', hourlyWage: 30 });
    const fakeFix = emp({ id: 'FAKE', employmentType: 'vollzeit', monthlySalary: 0, hourlyWage: 35 });
    const res = computeOvertimeAnalysis({
      employees: [fixed, mini, fakeFix],
      entries: [
        ...days('FIX', 19, 10),  // 190 h
        ...days('MINI', 25, 12), // viele Stunden, muss ignoriert werden
        ...days('FAKE', 25, 12),
      ],
      daysInMonth: JUNE_DAYS,
    });
    expect(res.employees.map((r) => r.employeeId)).toEqual(['FIX']);
  });
});

// ── Pflicht-Testfall 4: Abwesenheiten (FE/K/U) ausgeschlossen ─────────────────
describe('Abwesenheiten ausgeschlossen', () => {
  it('Ferientage drücken NICHT über das Monatssoll', () => {
    const e = emp({ id: 'E', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: [
        ...days('E', 17, 10),                               // 170 h produktiv
        ...days('E', 5, 8.4, { absenceType: 'FE', startDay: 18 }), // 42 h Ferien (ignoriert)
      ],
      daysInMonth: JUNE_DAYS,
    });
    const r = res.employees[0];
    expect(r.productiveHours).toBe(170);
    expect(r.overtimeHours).toBe(0); // 170 < 180, Ferien zählen nicht
  });
});

// ── Pflicht-Testfall 5: pro Mitarbeiter deaktiviert → 0 Überstundenkosten ─────
describe('Überstunden pro Mitarbeiter deaktivierbar', () => {
  it('deaktivierter MA: 0 Überstunden/Kosten, Differenz bleibt erhalten', () => {
    const e = emp({ id: 'F', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: days('F', 19, 10), // 190 h → wäre 10 h ÜS
      daysInMonth: JUNE_DAYS,
      disabledEmployeeIds: ['F'],
    });
    const r = res.employees[0];
    expect(r.overtimeDisabled).toBe(true);
    expect(r.overtimeHours).toBe(0);
    expect(r.overtimeCost).toBe(0);
    expect(r.difference).toBe(10); // Transparenz: Differenz bleibt
    expect(r.productiveHours).toBe(190);
    expect(res.totalOvertimeCost).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });
});

// ── Pflicht-Testfall 6: manuelle Zusatzkosten NICHT als Überstunden ───────────
describe('manuelle Zusatzkosten (isAdditionalCost)', () => {
  it('Zusatzkosten-Tage zählen nicht als Überstunden, werden separat ausgewiesen', () => {
    const e = emp({ id: 'G', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: [
        ...days('G', 17, 10),                                  // 170 h produktiv (unter Soll)
        ...days('G', 4, 10, { isAdditionalCost: true, startDay: 18 }), // 40 h Zusatzkosten
      ],
      daysInMonth: JUNE_DAYS,
    });
    const r = res.employees[0];
    expect(r.productiveHours).toBe(170);       // Zusatz NICHT enthalten
    expect(r.overtimeHours).toBe(0);           // 170 < 180 → keine ÜS
    expect(r.additionalCostHours).toBe(40);
    expect(r.additionalCostDays).toBe(4);
    expect(r.additionalCost).toBe(2000);       // 4 × (10 × 50)
  });

  it('Mitarbeiter mit NUR Zusatzkosten erscheint trotzdem in der Tabelle', () => {
    const e = emp({ id: 'H', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: days('H', 3, 8, { isAdditionalCost: true }), // nur Zusatz, kein produktiv
      daysInMonth: JUNE_DAYS,
    });
    expect(res.employees).toHaveLength(1);
    const r = res.employees[0];
    expect(r.productiveHours).toBe(0);
    expect(r.additionalCostHours).toBe(24);
    expect(r.overtimeHours).toBe(0);
    expect(r.difference).toBe(-180);
  });
});

// ── Tages-Info (über 8.4 h) ───────────────────────────────────────────────────
describe('Tage über 8.4 h (nur Info)', () => {
  it('zählt Tage über 8.4 h, erzeugt aber keine Überstunden unter Monatssoll', () => {
    const e = emp({ id: 'I', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [e],
      entries: [
        ...days('I', 10, 9),  // 10 Tage à 9 h (>8.4) = 90 h
        ...days('I', 5, 8, { startDay: 11 }), // 5 Tage à 8 h = 40 h
      ],
      daysInMonth: JUNE_DAYS,
    });
    const r = res.employees[0];
    expect(r.productiveHours).toBe(130);
    expect(r.daysOver84Count).toBe(10);
    expect(r.overtimeHours).toBe(0); // 130 < 180
  });
});

// ── Abteilungsfilter ──────────────────────────────────────────────────────────
describe('Abteilungsfilter', () => {
  it('filtert auf eine Abteilung', () => {
    const kueche = emp({ id: 'K', department: 'küche', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const service = emp({ id: 'S', department: 'service', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeOvertimeAnalysis({
      employees: [kueche, service],
      entries: [...days('K', 19, 10), ...days('S', 19, 10)],
      daysInMonth: JUNE_DAYS,
      departmentFilter: 'küche',
    });
    expect(res.employees.map((r) => r.employeeId)).toEqual(['K']);
  });
});

// ── computeOvertimeTotals (Toggle + PKQ) ─────────────────────────────────────
describe('computeOvertimeTotals', () => {
  it('inkl./exkl. Überstunden + PKQ', () => {
    const incl = computeOvertimeTotals(10000, 500, 50000, true);
    expect(incl.totalExclOvertime).toBe(10000);
    expect(incl.totalInclOvertime).toBe(10500);
    expect(incl.pkqExclOvertime).toBe(20);
    expect(incl.pkqInclOvertime).toBe(21);
    expect(incl.effectiveTotal).toBe(10500);
    expect(incl.effectivePkq).toBe(21);

    const excl = computeOvertimeTotals(10000, 500, 50000, false);
    expect(excl.effectiveTotal).toBe(10000);
    expect(excl.effectivePkq).toBe(20);
  });

  it('PKQ null bei Umsatz ≤ 0', () => {
    const t = computeOvertimeTotals(10000, 500, 0, true);
    expect(t.pkqExclOvertime).toBeNull();
    expect(t.pkqInclOvertime).toBeNull();
    expect(t.effectivePkq).toBeNull();
  });
});
