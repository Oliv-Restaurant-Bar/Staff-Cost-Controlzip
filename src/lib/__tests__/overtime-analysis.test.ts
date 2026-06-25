// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Employee } from '@/types/personnel';
import {
  computeOvertimeAnalysis,
  computeWeeklyOvertimeAnalysis,
  computeWeekCumulativeBalances,
  defaultSelectedWeekKey,
  computeOvertimeTotals,
  isFixedSalaryEmployee,
  monthlyTargetHours,
  workloadPercent,
  weeklyTargetHours,
  proratedWeeklyTargetHours,
  weeksInMonth,
  buildWeekDayRows,
  computeDailyOvertimeInfo,
  WEEKLY_FULLTIME_TARGET,
  DAILY_OVERTIME_THRESHOLD,
  type OvertimeHoursEntry,
  type DayDetailEntry,
  type WeekOvertimeRow,
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

// ─────────────────────────────────────────────────────────────────────────────
// Wochenauswertung (computeWeeklyOvertimeAnalysis)
// ─────────────────────────────────────────────────────────────────────────────
// Juni 2026 beginnt an einem MONTAG (01.06. = Mo). ISO-Wochen im Monat:
//   KW23 01.–07.06. (7 Tage) · KW24 08.–14.06. (7) · KW25 15.–21.06. (7)
//   KW26 22.–28.06. (7) · KW27 29.–30.06. (2 Tage, Randwoche)
// Volle Woche (7 Tage) → volles pensum-abhängiges Wochensoll; Randwoche anteilig.

describe('weeksInMonth (ISO-Wochen im Monat)', () => {
  it('Juni 2026: KW23–KW27 mit korrekten Tageszahlen', () => {
    const weeks = weeksInMonth(2026, 6);
    expect(weeks.map((w) => w.isoWeek)).toEqual([23, 24, 25, 26, 27]);
    expect(weeks.map((w) => w.daysInMonth)).toEqual([7, 7, 7, 7, 2]);
    expect(weeks[0].weekLabel).toBe('KW 23');
    expect(weeks[0].rangeLabel).toBe('01.06.–07.06.2026');
    expect(weeks[4].weekLabel).toBe('KW 27');
    expect(weeks[4].rangeLabel).toBe('29.06.–30.06.2026');
  });

  it('Jahreswechsel: Dezember 2025 → Randtage in KW1/2026 (isoYear 2026)', () => {
    // Dez 2025 beginnt MO 01.12. KW49–KW52/2025 (je 7 Tage) + 29.–31.12. = KW1/2026.
    const weeks = weeksInMonth(2025, 12);
    expect(weeks.map((w) => `${w.isoYear}-${w.isoWeek}`)).toEqual([
      '2025-49', '2025-50', '2025-51', '2025-52', '2026-1',
    ]);
    expect(weeks.map((w) => w.daysInMonth)).toEqual([7, 7, 7, 7, 3]);
    const last = weeks[weeks.length - 1];
    expect(last.weekLabel).toBe('KW 1');           // ISO-Woche, nicht Kalenderjahr-Woche
    expect(last.rangeLabel).toBe('29.12.–31.12.2025');
  });
});

describe('proratedWeeklyTargetHours', () => {
  it('volle Woche = volles Wochensoll, Randwoche anteilig', () => {
    const full = emp({ id: 'a', weeklyHours: 42 });
    expect(proratedWeeklyTargetHours(full, 7)).toBe(42);
    expect(proratedWeeklyTargetHours(full, 2)).toBe(12);          // 42 × 2/7
    expect(proratedWeeklyTargetHours(emp({ id: 'b', weeklyHours: 33.6 }), 7)).toBe(33.6); // 80 %
    expect(proratedWeeklyTargetHours(full, 0)).toBe(0);
  });
});

describe('Wochenansicht: 100 % über Wochensoll → Überstunden', () => {
  it('50 h in voller Woche (Soll 42) → 8 h Überstunden, Kosten 8 × Satz', () => {
    const e = emp({ id: 'W1', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: days('W1', 5, 10, { startDay: 8 }), // KW24, 50 h
      year: 2026,
      month: 6,
    });
    expect(res.employees).toHaveLength(1);
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1);
    const w = r.weeks[0];
    expect(w.isoWeek).toBe(24);
    expect(w.weeklyTargetHours).toBe(42);
    expect(w.productiveHours).toBe(50);
    expect(w.difference).toBe(8);
    expect(w.overtimeHours).toBe(8);
    expect(w.overtimeCost).toBe(400); // 8 × 50
    expect(res.totalOvertimeHours).toBe(8);
    expect(res.totalOvertimeCost).toBe(400);
    expect(res.affectedEmployeeCount).toBe(1);
  });
});

describe('Wochenansicht: 100 % unter Wochensoll → 0 Überstunden', () => {
  it('30 h in voller Woche (Soll 42) → 0 Überstunden, Differenz −12', () => {
    const e = emp({ id: 'W2', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: days('W2', 3, 10, { startDay: 8 }), // KW24, 30 h
      year: 2026,
      month: 6,
    });
    const w = res.employees[0].weeks[0];
    expect(w.weeklyTargetHours).toBe(42);
    expect(w.productiveHours).toBe(30);
    expect(w.difference).toBe(-12);
    expect(w.overtimeHours).toBe(0);
    expect(w.overtimeCost).toBe(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });
});

describe('Wochenansicht: 80 % Pensum → Soll skaliert', () => {
  it('40 h in voller Woche (Soll 33.6) → 6.4 h Überstunden', () => {
    const e = emp({ id: 'W80', employmentType: 'teilzeit', monthlySalary: 4800, hourlyWage: 40, weeklyHours: 33.6 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: days('W80', 5, 8, { startDay: 8 }), // KW24, 40 h
      year: 2026,
      month: 6,
    });
    const r = res.employees[0];
    expect(r.workloadPercent).toBe(80);
    const w = r.weeks[0];
    expect(w.weeklyTargetHours).toBe(33.6);
    expect(w.overtimeHours).toBe(6.4);
    expect(w.overtimeCost).toBe(256); // 6.4 × 40
  });
});

describe('Wochenansicht: Randwoche am Monatsrand anteilig', () => {
  it('KW27 (2 Tage im Monat): 14 h bei Soll 12 → 2 h Überstunden', () => {
    const e = emp({ id: 'WR', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: days('WR', 2, 7, { startDay: 29 }), // 29.+30.06. = KW27, 14 h
      year: 2026,
      month: 6,
    });
    const w = res.employees[0].weeks[0];
    expect(w.isoWeek).toBe(27);
    expect(w.daysInMonth).toBe(2);
    expect(w.weeklyTargetHours).toBe(12); // 42 × 2/7
    expect(w.productiveHours).toBe(14);
    expect(w.overtimeHours).toBe(2);
    expect(w.overtimeCost).toBe(100); // 2 × 50
  });
});

describe('Wochenansicht: pro Mitarbeiter deaktiviert → 0 Kosten', () => {
  it('deaktiviert: Stunden/Differenz bleiben, Überstunden + Kosten = 0', () => {
    const e = emp({ id: 'WD', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: days('WD', 5, 10, { startDay: 8 }), // KW24, 50 h → wäre 8 h ÜS
      year: 2026,
      month: 6,
      disabledEmployeeIds: ['WD'],
    });
    const r = res.employees[0];
    expect(r.overtimeDisabled).toBe(true);
    const w = r.weeks[0];
    expect(w.productiveHours).toBe(50);
    expect(w.difference).toBe(8);      // Transparenz bleibt
    expect(w.overtimeHours).toBe(0);
    expect(w.overtimeCost).toBe(0);
    expect(r.totalOvertimeCost).toBe(0);
    expect(res.totalOvertimeCost).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });
});

describe('Wochenansicht: stündliche/flexible Mitarbeiter ausgeschlossen', () => {
  it('minijob + vollzeit-ohne-Monatslohn ignoriert, Festangestellter bleibt', () => {
    const fixed = emp({ id: 'WFIX', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const mini = emp({ id: 'WMINI', employmentType: 'minijob', hourlyWage: 30 });
    const fakeFix = emp({ id: 'WFAKE', employmentType: 'vollzeit', monthlySalary: 0, hourlyWage: 35 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [fixed, mini, fakeFix],
      entries: [
        ...days('WFIX', 5, 10, { startDay: 8 }),
        ...days('WMINI', 6, 12, { startDay: 8 }),
        ...days('WFAKE', 6, 12, { startDay: 8 }),
      ],
      year: 2026,
      month: 6,
    });
    expect(res.employees.map((r) => r.employeeId)).toEqual(['WFIX']);
  });
});

describe('Wochenansicht: Abwesenheiten ausgeschlossen', () => {
  it('Ferientage drücken NICHT über das Wochensoll', () => {
    const e = emp({ id: 'WA', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: [
        ...days('WA', 3, 10, { startDay: 8 }),                         // 30 h produktiv (KW24)
        ...days('WA', 2, 8.4, { absenceType: 'FE', startDay: 11 }),    // 16.8 h Ferien (ignoriert)
      ],
      year: 2026,
      month: 6,
    });
    const w = res.employees[0].weeks[0];
    expect(w.productiveHours).toBe(30); // Ferien zählen nicht
    expect(w.overtimeHours).toBe(0);    // 30 < 42
  });
});

describe('Wochenansicht: manuelle Zusatzkosten separat (keine Überstunden)', () => {
  it('Zusatzkosten-Tage zählen nicht als Überstunden, separat ausgewiesen', () => {
    const e = emp({ id: 'WZ', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const res = computeWeeklyOvertimeAnalysis({
      employees: [e],
      entries: [
        ...days('WZ', 3, 10, { startDay: 8 }),                              // 30 h produktiv (KW24)
        ...days('WZ', 2, 10, { isAdditionalCost: true, startDay: 11 }),     // 20 h Zusatzkosten
      ],
      year: 2026,
      month: 6,
    });
    const w = res.employees[0].weeks[0];
    expect(w.productiveHours).toBe(30);          // Zusatz NICHT enthalten
    expect(w.overtimeHours).toBe(0);             // 30 < 42
    expect(w.additionalCostHours).toBe(20);
    expect(w.additionalCostDays).toBe(2);
    expect(w.additionalCost).toBe(1000);         // 2 × (10 × 50)
  });
});

describe('Wochenansicht erfasst, was die Monatsansicht verfehlt', () => {
  it('eine Woche über Soll trotz Monat unter Soll → wöchentliche Überstunden', () => {
    const e = emp({ id: 'WX', employmentType: 'vollzeit', monthlySalary: 6000, hourlyWage: 50, weeklyHours: 42 });
    const entries = [
      ...days('WX', 5, 10, { startDay: 1 }),  // KW23: 50 h → 8 h ÜS
      ...days('WX', 3, 10, { startDay: 8 }),  // KW24: 30 h → 0 h ÜS
    ];
    // Monatsansicht: 80 h gesamt, Monatssoll 180 → keine Überstunden
    const monthly = computeOvertimeAnalysis({ employees: [e], entries, daysInMonth: 30 });
    expect(monthly.employees[0].overtimeHours).toBe(0);
    // Wochenansicht: KW23 erzeugt 8 h Überstunden
    const weekly = computeWeeklyOvertimeAnalysis({ employees: [e], entries, year: 2026, month: 6 });
    const r = weekly.employees[0];
    expect(r.weeks.map((w) => w.isoWeek)).toEqual([23, 24]);
    expect(r.weeks[0].overtimeHours).toBe(8);
    expect(r.weeks[1].overtimeHours).toBe(0);
    expect(r.totalOvertimeHours).toBe(8);
    expect(weekly.totalOvertimeCost).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tagesdetail (buildWeekDayRows) — reine Anzeige, KEINE Berechnung
// ─────────────────────────────────────────────────────────────────────────────
describe('buildWeekDayRows (Tagesdetail Ebene 3)', () => {
  // KW 23 (2026) = 01.06.–07.06.2026 (Mo–So)
  const KW23 = { isoYear: 2026, isoWeek: 23 };

  it('liefert nur die Tage der angefragten ISO-Woche des Mitarbeiters, chronologisch', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-03', hours: 8 },
      { employeeId: 'A', date: '2026-06-01', hours: 8 },
      { employeeId: 'A', date: '2026-06-08', hours: 8 }, // KW24 → raus
      { employeeId: 'B', date: '2026-06-02', hours: 8 }, // anderer MA → raus
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows.map((r) => r.date)).toEqual(['2026-06-01', '2026-06-03']);
  });

  it('mappt deutsche Wochentage + Tageslabel korrekt', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-01', hours: 8 }, // Montag
      { employeeId: 'A', date: '2026-06-07', hours: 6 }, // Sonntag
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows[0]).toMatchObject({ weekday: 'Montag', dayLabel: '01.06.' });
    expect(rows[1]).toMatchObject({ weekday: 'Sonntag', dayLabel: '07.06.' });
  });

  it('formatiert geteilte Schichten als Arbeitszeit-Bereich', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-02', hours: 8, start: '09:00', end: '15:00', start2: '17:00', end2: '23:00' },
      { employeeId: 'A', date: '2026-06-03', hours: 4, start: '08:00', end: '12:00' },
      { employeeId: 'A', date: '2026-06-04', hours: 4 }, // keine Zeiten
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows[0].timeRange).toBe('09:00–15:00 / 17:00–23:00');
    expect(rows[1].timeRange).toBe('08:00–12:00');
    expect(rows[2].timeRange).toBe('');
  });

  it('Abwesenheitstage erscheinen mit 0 produktiven Stunden + absenceType', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-01', hours: 8 },
      { employeeId: 'A', date: '2026-06-02', hours: 0, absenceType: 'FE' },
      { employeeId: 'A', date: '2026-06-03', hours: 8, absenceType: 'K' }, // Abwesenheit gewinnt
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows[0]).toMatchObject({ productiveHours: 8, absenceType: null });
    expect(rows[1]).toMatchObject({ productiveHours: 0, absenceType: 'FE' });
    expect(rows[2]).toMatchObject({ productiveHours: 0, absenceType: 'K' });
  });

  it('Zusatzkosten-Tage sind nicht produktiv, aber als isAdditionalCost markiert', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-05', hours: 5, isAdditionalCost: true },
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows[0]).toMatchObject({ productiveHours: 0, isAdditionalCost: true, absenceType: null });
  });

  it('über 8.4h wird informativ markiert (kein Einfluss auf Berechnung)', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-01', hours: 8.4 },
      { employeeId: 'A', date: '2026-06-02', hours: 9 },
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows[0].over84).toBe(false); // exakt 8.4 ist NICHT darüber
    expect(rows[1].over84).toBe(true);
  });

  it('fasst mehrere produktive Einträge desselben Tages zusammen', () => {
    const entries: DayDetailEntry[] = [
      { employeeId: 'A', date: '2026-06-02', hours: 4, start: '08:00', end: '12:00' },
      { employeeId: 'A', date: '2026-06-02', hours: 5, start: '14:00', end: '19:00' },
    ];
    const rows = buildWeekDayRows(entries, 'A', KW23.isoYear, KW23.isoWeek);
    expect(rows).toHaveLength(1);
    expect(rows[0].productiveHours).toBe(9);
    expect(rows[0].over84).toBe(true);
    expect(rows[0].timeRange).toBe('08:00–12:00 / 14:00–19:00');
  });

  it('leere Eingabe → leeres Ergebnis', () => {
    expect(buildWeekDayRows([], 'A', KW23.isoYear, KW23.isoWeek)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Laufende Wochen-Salden (computeWeekCumulativeBalances) — reine Aggregation
// + Default-Wochenauswahl (defaultSelectedWeekKey) für die "aktuelle Woche"
// ─────────────────────────────────────────────────────────────────────────────
function wrow(p: {
  isoYear?: number; isoWeek: number; overtimeHours: number; overtimeCost: number | null;
}): WeekOvertimeRow {
  const isoYear = p.isoYear ?? 2026;
  return {
    isoYear,
    isoWeek: p.isoWeek,
    weekLabel: `KW ${p.isoWeek}`,
    rangeLabel: '',
    daysInMonth: 7,
    weeklyTargetHours: 42,
    productiveHours: 0,
    difference: 0,
    overtimeHours: p.overtimeHours,
    overtimeCost: p.overtimeCost,
    additionalCostHours: 0,
    additionalCostDays: 0,
    additionalCost: null,
    daysOver84Count: 0,
  };
}

describe('computeWeekCumulativeBalances (verrechneter Saldo bis Woche)', () => {
  it('bildet laufende Summen von Stunden + Kosten je Woche', () => {
    const bals = computeWeekCumulativeBalances([
      wrow({ isoWeek: 23, overtimeHours: 8, overtimeCost: 400 }),
      wrow({ isoWeek: 24, overtimeHours: 2, overtimeCost: 100 }),
      wrow({ isoWeek: 25, overtimeHours: 5, overtimeCost: 250 }),
    ]);
    expect(bals.map((b) => b.cumulativeOvertimeHours)).toEqual([8, 10, 15]);
    expect(bals.map((b) => b.cumulativeOvertimeCost)).toEqual([400, 500, 750]);
    // Wochenwerte selbst bleiben erhalten (Ebene-2-Anzeige)
    expect(bals.map((b) => b.overtimeHours)).toEqual([8, 2, 5]);
  });

  it('sortiert unsortierte Eingabe chronologisch (isoYear, dann isoWeek)', () => {
    const bals = computeWeekCumulativeBalances([
      wrow({ isoWeek: 25, overtimeHours: 5, overtimeCost: 250 }),
      wrow({ isoWeek: 23, overtimeHours: 8, overtimeCost: 400 }),
      wrow({ isoWeek: 24, overtimeHours: 2, overtimeCost: 100 }),
    ]);
    expect(bals.map((b) => b.isoWeek)).toEqual([23, 24, 25]);
    expect(bals.map((b) => b.cumulativeOvertimeHours)).toEqual([8, 10, 15]);
  });

  it('ordnet Jahreswechsel korrekt (KW53/2026 vor KW1/2027)', () => {
    const bals = computeWeekCumulativeBalances([
      wrow({ isoYear: 2027, isoWeek: 1, overtimeHours: 3, overtimeCost: 150 }),
      wrow({ isoYear: 2026, isoWeek: 53, overtimeHours: 4, overtimeCost: 200 }),
    ]);
    expect(bals.map((b) => `${b.isoYear}-${b.isoWeek}`)).toEqual(['2026-53', '2027-1']);
    expect(bals.map((b) => b.cumulativeOvertimeHours)).toEqual([4, 7]);
    expect(bals.map((b) => b.cumulativeOvertimeCost)).toEqual([200, 350]);
  });

  it('Kosten-Saldo wird null, sobald eine Woche keinen Satz hat (Stunden laufen weiter)', () => {
    const bals = computeWeekCumulativeBalances([
      wrow({ isoWeek: 23, overtimeHours: 8, overtimeCost: null }),
      wrow({ isoWeek: 24, overtimeHours: 2, overtimeCost: null }),
    ]);
    expect(bals.map((b) => b.cumulativeOvertimeHours)).toEqual([8, 10]);
    expect(bals.map((b) => b.cumulativeOvertimeCost)).toEqual([null, null]);
  });

  it('deaktivierter Mitarbeiter: Stunden + Kosten je Woche 0 → Saldo 0', () => {
    // Spiegelt das Lib-Verhalten: overtimeHours=0 UND overtimeCost=0 bei Deaktivierung.
    const bals = computeWeekCumulativeBalances([
      wrow({ isoWeek: 23, overtimeHours: 0, overtimeCost: 0 }),
      wrow({ isoWeek: 24, overtimeHours: 0, overtimeCost: 0 }),
    ]);
    expect(bals.map((b) => b.cumulativeOvertimeHours)).toEqual([0, 0]);
    expect(bals.map((b) => b.cumulativeOvertimeCost)).toEqual([0, 0]);
  });

  it('Auswahl einer Woche liefert deren Saldo (Default vs. spätere Woche unterscheiden sich)', () => {
    const bals = computeWeekCumulativeBalances([
      wrow({ isoWeek: 23, overtimeHours: 8, overtimeCost: 400 }),
      wrow({ isoWeek: 24, overtimeHours: 2, overtimeCost: 100 }),
      wrow({ isoWeek: 25, overtimeHours: 5, overtimeCost: 250 }),
    ]);
    const byKey = new Map(bals.map((b) => [`${b.isoYear}-${b.isoWeek}`, b]));
    expect(byKey.get('2026-23')?.cumulativeOvertimeCost).toBe(400);
    expect(byKey.get('2026-25')?.cumulativeOvertimeCost).toBe(750);
  });

  it('mutiert die Eingabe nicht', () => {
    const input = [
      wrow({ isoWeek: 24, overtimeHours: 2, overtimeCost: 100 }),
      wrow({ isoWeek: 23, overtimeHours: 8, overtimeCost: 400 }),
    ];
    const snapshot = input.map((w) => w.isoWeek);
    computeWeekCumulativeBalances(input);
    expect(input.map((w) => w.isoWeek)).toEqual(snapshot);
  });

  it('leere Eingabe → leeres Ergebnis', () => {
    expect(computeWeekCumulativeBalances([])).toEqual([]);
  });
});

describe('defaultSelectedWeekKey (aktuelle Woche im Monat)', () => {
  const juneWeeks = weeksInMonth(2026, 6); // KW23..KW27

  it('today innerhalb des Monats → enthaltende ISO-Woche', () => {
    // 10.06.2026 (Mi) liegt in KW24
    const k = defaultSelectedWeekKey(juneWeeks, new Date(2026, 5, 10));
    expect(k).toEqual({ isoYear: 2026, isoWeek: 24 });
  });

  it('today vor dem Monat → erste Woche', () => {
    const k = defaultSelectedWeekKey(juneWeeks, new Date(2026, 4, 1)); // 01.05.2026
    expect(k).toEqual({ isoYear: 2026, isoWeek: 23 });
  });

  it('today nach dem Monat → letzte Woche', () => {
    const k = defaultSelectedWeekKey(juneWeeks, new Date(2026, 6, 15)); // 15.07.2026
    expect(k).toEqual({ isoYear: 2026, isoWeek: juneWeeks[juneWeeks.length - 1].isoWeek });
  });

  it('keine Wochen → null', () => {
    expect(defaultSelectedWeekKey([], new Date(2026, 5, 10))).toBeNull();
  });
});

// ── computeDailyOvertimeInfo (Tages-Info über 8.4 h, REINE ANZEIGE) ───────────
describe('computeDailyOvertimeInfo', () => {
  it('Mehrstunden + Mehrkosten korrekt (über 8.4 h)', () => {
    // 10 h − 8.4 h = 1.6 h Mehrstunden × 50 CHF = 80 CHF
    expect(computeDailyOvertimeInfo(10, 50, false)).toEqual({ overtimeHours: 1.6, overtimeCost: 80 });
  });

  it('genau 8.4 h → 0 Mehrstunden / 0 Kosten (Schwelle, nicht darüber)', () => {
    expect(computeDailyOvertimeInfo(8.4, 50, false)).toEqual({ overtimeHours: 0, overtimeCost: 0 });
  });

  it('unter 8.4 h → 0 Mehrstunden / 0 Kosten', () => {
    expect(computeDailyOvertimeInfo(6, 50, false)).toEqual({ overtimeHours: 0, overtimeCost: 0 });
  });

  it('deaktiviert → Kosten 0, Stunden bleiben sichtbar', () => {
    expect(computeDailyOvertimeInfo(11, 40, true)).toEqual({ overtimeHours: 2.6, overtimeCost: 0 });
  });

  it('kein Satz (rate null) → Kosten null, Stunden bleiben', () => {
    expect(computeDailyOvertimeInfo(12, null, false)).toEqual({ overtimeHours: 3.6, overtimeCost: null });
  });

  it('Satz enthält bereits die Sozialkosten (kein zusätzlicher ×1.13)', () => {
    // 9.4 h − 8.4 h = 1 h × 56.50 CHF (interner Satz inkl. 13 %) = 56.50 CHF
    expect(computeDailyOvertimeInfo(9.4, 56.5, false)).toEqual({ overtimeHours: 1, overtimeCost: 56.5 });
  });

  it('rundet Mehrstunden und Mehrkosten auf 2 Dezimalstellen', () => {
    // 9.123 → 0.723 → round2 0.72; 0.72 × 33.33 = 23.9976 → round2 24.00
    expect(computeDailyOvertimeInfo(9.123, 33.33, false)).toEqual({ overtimeHours: 0.72, overtimeCost: 24 });
  });

  it('konsistent mit buildWeekDayRows.over84 (KW 23, 2026: 10 h am 01.06.)', () => {
    const entries: DayDetailEntry[] = [{ employeeId: 'x', date: '2026-06-01', hours: 10 }];
    const [row] = buildWeekDayRows(entries, 'x', 2026, 23);
    expect(row.over84).toBe(true);
    const info = computeDailyOvertimeInfo(row.productiveHours, 50, false);
    expect(info.overtimeHours).toBeCloseTo(1.6, 5);
    expect(info.overtimeCost).toBe(80);
  });
});
