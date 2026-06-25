// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Employee } from '@/types/personnel';
import {
  computeOvertimeAnalysis,
  computeOvertimeTotals,
  isFixedSalaryEmployee,
  weeklyTargetHours,
  DAILY_OVERTIME_THRESHOLD,
  WEEKLY_FULLTIME_TARGET,
  WEEKLY_OVERTIME_THRESHOLD,
  type OvertimeHoursEntry,
} from '@/lib/overtime-analysis';

// ── Test-Fixtures ────────────────────────────────────────────────────────────
// Festangestellter mit Monatslohn 7280 → L-GAV interner Stundensatz
//   7280 * 1.13 / 182 = 45.2 CHF/h  (round2 → 45.2)
const RATE = 45.2;

function makeEmp(p: Partial<Employee> & { id: string }): Employee {
  return {
    name: p.id,
    department: 'service',
    employmentType: 'vollzeit',
    hourlyWage: 0,
    monthlySalary: 7280,
    ...p,
  } as Employee;
}

function entry(employeeId: string, date: string, hours: number): OvertimeHoursEntry {
  return { employeeId, date, hours };
}

function absence(employeeId: string, date: string, hours: number, absenceType: string): OvertimeHoursEntry {
  return { employeeId, date, hours, absenceType };
}

describe('overtime-analysis: Konstanten & Prädikat', () => {
  it('Konstanten: Tagesgrenze 8.4h (nur Info) und Vollzeit-Wochensoll 42h', () => {
    expect(DAILY_OVERTIME_THRESHOLD).toBe(8.4);
    expect(WEEKLY_FULLTIME_TARGET).toBe(42);
    // Rückwärtskompatibler Alias
    expect(WEEKLY_OVERTIME_THRESHOLD).toBe(42);
  });

  it('weeklyTargetHours: 42h × Pensum (weeklyHours), Default Vollzeit 42h', () => {
    expect(weeklyTargetHours(makeEmp({ id: '100a' }))).toBe(42); // weeklyHours undefined → 100 %
    expect(weeklyTargetHours(makeEmp({ id: '100b', weeklyHours: 42 }))).toBe(42); // 100 %
    expect(weeklyTargetHours(makeEmp({ id: '80', weeklyHours: 33.6 }))).toBe(33.6); // 80 %
    expect(weeklyTargetHours(makeEmp({ id: '50', weeklyHours: 21 }))).toBe(21); // 50 %
    expect(weeklyTargetHours(makeEmp({ id: 'zero', weeklyHours: 0 }))).toBe(42); // 0/ungültig → Vollzeit
  });

  it('isFixedSalaryEmployee: nur vollzeit/teilzeit MIT fixem Monatslohn = fest', () => {
    // Festangestellt: vollzeit/teilzeit mit monthlySalary > 0
    expect(isFixedSalaryEmployee(makeEmp({ id: 'a', employmentType: 'vollzeit' }))).toBe(true);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'b', employmentType: 'teilzeit' }))).toBe(true);
    // Stündlich: minijob/aushilfe immer ausgeschlossen
    expect(isFixedSalaryEmployee(makeEmp({ id: 'c', employmentType: 'aushilfe', monthlySalary: 0 }))).toBe(false);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'd', employmentType: 'minijob', monthlySalary: 0 }))).toBe(false);
    // Zweite Sicherheitsschicht: vollzeit/teilzeit OHNE fixen Monatslohn = ausgeschlossen
    expect(isFixedSalaryEmployee(makeEmp({ id: 'e', employmentType: 'vollzeit', monthlySalary: 0 }))).toBe(false);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'f', employmentType: 'teilzeit', monthlySalary: undefined }))).toBe(false);
    // Auch wenn flexibel via hourlyWage bezahlt, aber ohne fixen Monatslohn → ausgeschlossen
    expect(isFixedSalaryEmployee(makeEmp({ id: 'g', employmentType: 'teilzeit', hourlyWage: 30, monthlySalary: 0 }))).toBe(false);
  });
});

describe('overtime-analysis: computeOvertimeAnalysis (nur Wochensoll)', () => {
  // 1) KERN-KORREKTUR: Tage über 8.4h erzeugen KEINE Überstunden, solange das
  //    Wochensoll (42h) nicht überschritten wird. Beispiel KW24/2026 mit 33.07h.
  it('33.07h-Woche mit Tagen über 8.4h ergibt 0.00h Überstunden (Wochensoll nicht überschritten)', () => {
    const emp = makeEmp({ id: 'kw24', name: 'Anna' });
    // Mo–Mi 2026-06-08/09/10 (gleiche ISO-Woche): 11.07 + 11 + 11 = 33.07h
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [
        entry('kw24', '2026-06-08', 11.07),
        entry('kw24', '2026-06-09', 11),
        entry('kw24', '2026-06-10', 11),
      ],
    });
    // 33.07h < 42h Wochensoll → keine Überstunden, MA nicht betroffen
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.totalOvertimeCost).toBe(0);
  });

  // 2) Wochen-Überstunden: 43h/Woche → 1.0h (Vollzeit-Soll 42h)
  it('zählt Wochen-Überstunden über dem Vollzeit-Soll (43h → 1.0h)', () => {
    const emp = makeEmp({ id: 'e2' });
    // Mo–So derselben ISO-Woche (2026-W26): 7+7+7+7+7+7+1 = 43h, jeder Tag ≤ 8.4
    const days = ['22', '23', '24', '25', '26', '27', '28'];
    const hrs = [7, 7, 7, 7, 7, 7, 1];
    const entries = days.map((d, i) => entry('e2', `2026-06-${d}`, hrs[i]));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].weekHours).toBe(43);
    expect(r.weeks[0].targetHours).toBe(42);
    expect(r.weeks[0].dailyOvertimeSum).toBe(0);
    expect(r.weeks[0].weeklyOvertime).toBe(1);
    expect(r.weeks[0].effectiveOvertime).toBe(1);
    expect(r.overtimeHours).toBe(1);
    expect(r.overtimeCost).toBe(RATE);
  });

  // 3) Regression: 100 % mit 46.64h-Woche → 4.64h Überstunden
  it('100 % mit 46.64h-Woche → 4.64h Überstunden', () => {
    const emp = makeEmp({ id: 'e3', name: 'Vollzeit' });
    // Mo–Sa 2026-06-08…13 (gleiche ISO-Woche): 8+8+8+8+8+6.64 = 46.64h
    const entries = [
      entry('e3', '2026-06-08', 8),
      entry('e3', '2026-06-09', 8),
      entry('e3', '2026-06-10', 8),
      entry('e3', '2026-06-11', 8),
      entry('e3', '2026-06-12', 8),
      entry('e3', '2026-06-13', 6.64),
    ];
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].weekHours).toBe(46.64);
    expect(r.weeks[0].targetHours).toBe(42);
    expect(r.weeks[0].weeklyOvertime).toBe(4.64);
    expect(r.weeks[0].effectiveOvertime).toBe(4.64);
    expect(r.overtimeHours).toBe(4.64);
  });

  // 4) Regression: 80 % (Wochensoll 33.6h) mit 35h-Woche → 1.4h Überstunden
  it('80 % (Wochensoll 33.6h) mit 35h-Woche → 1.4h Überstunden', () => {
    const emp = makeEmp({ id: 'e4', name: 'Teilzeit80', weeklyHours: 33.6 });
    // Mo–Fr 2026-06-08…12: 7+7+7+7+7 = 35h, jeder Tag < 8.4
    const entries = ['08', '09', '10', '11', '12'].map((d) => entry('e4', `2026-06-${d}`, 7));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const r = res.employees[0];
    expect(r.weeks[0].weekHours).toBe(35);
    expect(r.weeks[0].targetHours).toBe(33.6);
    expect(r.weeks[0].weeklyOvertime).toBe(1.4);
    expect(r.weeks[0].effectiveOvertime).toBe(1.4);
    expect(r.overtimeHours).toBe(1.4);
  });

  // 5) Tages-Überstunden fliessen NICHT ein: 44h-Woche → effektiv = Wochen-ÜS (2h)
  it('Tages-Überstunden sind nur Info: 44h-Woche → effektiv 2h (nicht 10.4h)', () => {
    const emp = makeEmp({ id: 'e5' });
    // 4 Tage × 11h = 44h, alle in 2026-W24 (Mo–Do 2026-06-08…11)
    const entries = ['08', '09', '10', '11'].map((d) => entry('e5', `2026-06-${d}`, 11));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const w = res.employees[0].weeks[0];
    expect(w.weekHours).toBe(44);
    expect(w.targetHours).toBe(42);
    expect(w.dailyOvertimeSum).toBe(10.4); // 4 × 2.6 — nur informativ
    expect(w.weeklyOvertime).toBe(2); // 44 - 42
    expect(w.effectiveOvertime).toBe(2); // = Wochen-ÜS, NICHT 10.4
    expect(res.employees[0].overtimeHours).toBe(2);
    expect(res.employees[0].overtimeHours).not.toBe(10.4);
  });

  // 6) Stündliche Mitarbeiter werden ausgeschlossen
  it('schliesst stündliche Mitarbeiter (aushilfe/minijob) aus', () => {
    const aush = makeEmp({ id: 'h1', employmentType: 'aushilfe', hourlyWage: 30, monthlySalary: 0 });
    const mini = makeEmp({ id: 'h2', employmentType: 'minijob', hourlyWage: 25, monthlySalary: 0 });
    const res = computeOvertimeAnalysis({
      employees: [aush, mini],
      // klar über dem Wochensoll, würden ohne Filter Überstunden erzeugen
      entries: [
        ...['08', '09', '10', '11', '12', '13'].map((d) => entry('h1', `2026-06-${d}`, 12)),
        ...['08', '09', '10', '11', '12', '13'].map((d) => entry('h2', `2026-06-${d}`, 12)),
      ],
    });
    expect(res.employees).toHaveLength(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeCost).toBe(0);
  });

  // 7) Abwesenheiten (FE/K/U) zählen NICHT als produktive Stunden → keine Überstunden
  it('ignoriert Abwesenheitseinträge (Ferien/Krankheit) bei der Wochenberechnung', () => {
    const emp = makeEmp({ id: 'e7', name: 'Felix' });
    // 5 produktive Tage à 8h = 40h (< 42h Soll) + 2 Ferien-/Kranktage à 8.4h.
    // Würden die Abwesenheiten mitzählen: 56.8h → 14.8h Wochen-ÜS (falsch).
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [
        entry('e7', '2026-06-22', 8),
        entry('e7', '2026-06-23', 8),
        entry('e7', '2026-06-24', 8),
        entry('e7', '2026-06-25', 8),
        entry('e7', '2026-06-26', 8),
        absence('e7', '2026-06-27', 8.4, 'FE'),
        absence('e7', '2026-06-28', 8.4, 'K'),
      ],
    });
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeHours).toBe(0);
  });

  // 8) Festangestellten-Typ OHNE fixen Monatslohn → komplett ausgeschlossen
  it('schliesst vollzeit/teilzeit OHNE fixen Monatslohn aus (kein Überstundeneintrag)', () => {
    const noSalary = makeEmp({ id: 'n1', employmentType: 'vollzeit', hourlyWage: 0, monthlySalary: 0 });
    const flexHourly = makeEmp({ id: 'n2', employmentType: 'teilzeit', hourlyWage: 32, monthlySalary: 0 });
    const res = computeOvertimeAnalysis({
      employees: [noSalary, flexHourly],
      entries: [
        ...['08', '09', '10', '11', '12', '13'].map((d) => entry('n1', `2026-06-${d}`, 12)),
        ...['08', '09', '10', '11', '12', '13'].map((d) => entry('n2', `2026-06-${d}`, 12)),
      ],
    });
    expect(res.employees).toHaveLength(0);
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.totalOvertimeCost).toBe(0);
    expect(res.hasUnavailableRates).toBe(false);
  });

  // 9) Regression (Bug): flexible/stündliche MA tauchten in der Überstunden-
  //    tabelle auf (Ibrahim, Aushilfe Service, Isabel Goi). Nur echte
  //    Festangestellte (vollzeit/teilzeit MIT fixem Monatslohn) dürfen erscheinen.
  it('Regression: schliesst flex/stündliche/aushilfe komplett aus, behält Festangestellte', () => {
    const fest = makeEmp({ id: 'fix', name: 'Festangestellt', employmentType: 'vollzeit', monthlySalary: 7280 });
    const aushilfe = makeEmp({ id: 'aush', name: 'Aushilfe Service', employmentType: 'aushilfe', hourlyWage: 28, monthlySalary: 0 });
    const minijob = makeEmp({ id: 'mini', name: 'Ibrahim', employmentType: 'minijob', hourlyWage: 26, monthlySalary: 0 });
    // flexibel, aber fälschlich als teilzeit erfasst und ohne fixen Monatslohn
    const flexMisTyped = makeEmp({ id: 'flex', name: 'Isabel Goi', employmentType: 'teilzeit', hourlyWage: 30, monthlySalary: 0 });

    // alle klar über dem Wochensoll (12h/Tag × 6 Tage = 72h/Woche)
    const days = ['08', '09', '10', '11', '12', '13'];
    const entries: OvertimeHoursEntry[] = [];
    for (const id of ['fix', 'aush', 'mini', 'flex']) {
      for (const d of days) entries.push(entry(id, `2026-06-${d}`, 12));
    }

    const res = computeOvertimeAnalysis({
      employees: [fest, aushilfe, minijob, flexMisTyped],
      entries,
    });

    expect(res.affectedEmployeeCount).toBe(1);
    const names = res.employees.map((r) => r.name);
    expect(names).toEqual(['Festangestellt']);
    expect(names).not.toContain('Aushilfe Service');
    expect(names).not.toContain('Ibrahim');
    expect(names).not.toContain('Isabel Goi');
  });

  // 10) Abteilungsfilter
  it('respektiert den Abteilungsfilter', () => {
    const svc = makeEmp({ id: 's', name: 'Service-Sven', department: 'service' });
    const kue = makeEmp({ id: 'k', name: 'Küchen-Kim', department: 'küche' });
    // 6 Tage × 8h = 48h/Woche (> 42) je MA
    const days = ['08', '09', '10', '11', '12', '13'];
    const entries = [
      ...days.map((d) => entry('s', `2026-06-${d}`, 8)),
      ...days.map((d) => entry('k', `2026-06-${d}`, 8)),
    ];

    const all = computeOvertimeAnalysis({ employees: [svc, kue], entries, departmentFilter: 'all' });
    expect(all.affectedEmployeeCount).toBe(2);

    const onlyKueche = computeOvertimeAnalysis({ employees: [svc, kue], entries, departmentFilter: 'küche' });
    expect(onlyKueche.affectedEmployeeCount).toBe(1);
    expect(onlyKueche.employees[0].department).toBe('küche');
  });

  // 11) Festangestellter ohne Überstunden → nicht betroffen
  it('listet Festangestellte ohne Überstunden nicht auf', () => {
    const emp = makeEmp({ id: 'e11' });
    // 5 Tage × 8h = 40h < 42h Soll
    const entries = ['22', '23', '24', '25', '26'].map((d) => entry('e11', `2026-06-${d}`, 8));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    expect(res.employees).toHaveLength(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });

  // 12) ISO-Woche über den Jahreswechsel: Mo 2025-12-29 … Sa 2026-01-03 = 2026-W01
  it('gruppiert über den Jahreswechsel korrekt nach ISO-Woche', () => {
    const emp = makeEmp({ id: 'x' });
    // 6 Tage × 8h = 48h, alle in ISO-Woche 2026-W01 → 6h Überstunden
    const dates = ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03'];
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: dates.map((d) => entry('x', d, 8)),
    });
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1); // eine gemeinsame ISO-Woche
    expect(r.weeks[0].weekKey).toBe('2026-W01');
    expect(r.weeks[0].weekHours).toBe(48);
    expect(r.weeks[0].effectiveOvertime).toBe(6);
    expect(r.overtimeHours).toBe(6);
  });

  // 13) Mehrere Einträge am selben Tag werden summiert (Rundung)
  it('summiert mehrere Einträge am selben Tag und rundet sauber', () => {
    const emp = makeEmp({ id: 'm' });
    // Mo 2026-06-08: 5 + 4.4 = 9.4h; Di–Fr je 8.4h → Woche = 43h → 1h Überstunden
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [
        entry('m', '2026-06-08', 5),
        entry('m', '2026-06-08', 4.4),
        entry('m', '2026-06-09', 8.4),
        entry('m', '2026-06-10', 8.4),
        entry('m', '2026-06-11', 8.4),
        entry('m', '2026-06-12', 8.4),
      ],
    });
    const r = res.employees[0];
    expect(r.weeks[0].days[0].actualHours).toBe(9.4); // Tages-Summe
    expect(r.weeks[0].weekHours).toBe(43);
    expect(r.overtimeHours).toBe(1); // 43 - 42, ohne Float-Rauschen
  });
});

describe('overtime-analysis: computeOvertimeTotals (Toggle)', () => {
  // Toggle EIN → Überstunden fliessen in Total + PKQ
  it('bezieht Überstunden bei aktivem Toggle in Total und PKQ ein', () => {
    const t = computeOvertimeTotals(10000, 500, 25000, true);
    expect(t.regularCost).toBe(10000);
    expect(t.overtimeCost).toBe(500);
    expect(t.totalExclOvertime).toBe(10000);
    expect(t.totalInclOvertime).toBe(10500);
    expect(t.pkqExclOvertime).toBe(40); // 10000/25000
    expect(t.pkqInclOvertime).toBe(42); // 10500/25000
    expect(t.effectiveTotal).toBe(10500);
    expect(t.effectivePkq).toBe(42);
  });

  // Toggle AUS → Überstunden NICHT im Total/PKQ, aber weiterhin ausgewiesen
  it('schliesst Überstunden bei inaktivem Toggle aus Total/PKQ aus, weist sie aber weiter aus', () => {
    const t = computeOvertimeTotals(10000, 500, 25000, false);
    expect(t.effectiveTotal).toBe(10000);
    expect(t.effectivePkq).toBe(40);
    // Überstunden bleiben sichtbar (separat ausgewiesen):
    expect(t.overtimeCost).toBe(500);
    expect(t.totalInclOvertime).toBe(10500);
    expect(t.pkqInclOvertime).toBe(42);
  });

  it('liefert null-PKQ bei Umsatz ≤ 0', () => {
    const t = computeOvertimeTotals(10000, 500, 0, true);
    expect(t.pkqExclOvertime).toBeNull();
    expect(t.pkqInclOvertime).toBeNull();
    expect(t.effectivePkq).toBeNull();
  });
});
