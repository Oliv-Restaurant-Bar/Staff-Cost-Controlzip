// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { Employee } from '@/types/personnel';
import {
  computeOvertimeAnalysis,
  computeOvertimeTotals,
  isFixedSalaryEmployee,
  DAILY_OVERTIME_THRESHOLD,
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
  it('Schwellen sind 8.4h/Tag und 42h/Woche', () => {
    expect(DAILY_OVERTIME_THRESHOLD).toBe(8.4);
    expect(WEEKLY_OVERTIME_THRESHOLD).toBe(42);
  });

  it('isFixedSalaryEmployee: vollzeit/teilzeit = fest, minijob/aushilfe = stündlich', () => {
    expect(isFixedSalaryEmployee(makeEmp({ id: 'a', employmentType: 'vollzeit' }))).toBe(true);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'b', employmentType: 'teilzeit' }))).toBe(true);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'c', employmentType: 'aushilfe' }))).toBe(false);
    expect(isFixedSalaryEmployee(makeEmp({ id: 'd', employmentType: 'minijob' }))).toBe(false);
  });
});

describe('overtime-analysis: computeOvertimeAnalysis', () => {
  // 1) Tages-Überstunden: 9.4h an einem Tag → 1.0h Überstunden
  it('zählt Tages-Überstunden über 8.4h (9.4h → 1.0h, Kosten = 1 × Satz)', () => {
    const emp = makeEmp({ id: 'e1', name: 'Anna' });
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [entry('e1', '2026-06-22', 9.4)],
    });
    expect(res.affectedEmployeeCount).toBe(1);
    expect(res.totalOvertimeHours).toBe(1);
    const r = res.employees[0];
    expect(r.overtimeHours).toBe(1);
    expect(r.rateAvailable).toBe(true);
    expect(r.overtimeCost).toBe(RATE);
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].dailyOvertimeSum).toBe(1);
    expect(r.weeks[0].weeklyOvertime).toBe(0);
    expect(r.weeks[0].effectiveOvertime).toBe(1);
    expect(r.days).toHaveLength(1);
    expect(r.days[0].dailyOvertime).toBe(1);
  });

  // 2) Wochen-Überstunden: 43h/Woche ohne Tages-Überschreitung → 1.0h
  it('zählt Wochen-Überstunden über 42h (43h ohne Tagesüberschreitung → 1.0h)', () => {
    const emp = makeEmp({ id: 'e2' });
    // Mo–So derselben ISO-Woche (2026-W26): 7+7+7+7+7+7+1 = 43h, jeder Tag ≤ 8.4
    const days = ['22', '23', '24', '25', '26', '27', '28'];
    const hrs = [7, 7, 7, 7, 7, 7, 1];
    const entries = days.map((d, i) => entry('e2', `2026-06-${d}`, hrs[i]));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1);
    expect(r.weeks[0].weekHours).toBe(43);
    expect(r.weeks[0].dailyOvertimeSum).toBe(0);
    expect(r.weeks[0].weeklyOvertime).toBe(1);
    expect(r.weeks[0].effectiveOvertime).toBe(1);
    expect(r.overtimeHours).toBe(1);
    expect(r.overtimeCost).toBe(RATE);
  });

  // 3) Tages + Wochen Überlappung → KEINE Doppelzählung (max, nicht Summe)
  it('zählt Überschneidung von Tages- und Wochen-Überstunden NICHT doppelt', () => {
    const emp = makeEmp({ id: 'e3' });
    // 4 Tage × 11h = 44h, alle in 2026-W26
    const entries = ['22', '23', '24', '25'].map((d) => entry('e3', `2026-06-${d}`, 11));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    const w = res.employees[0].weeks[0];
    expect(w.weekHours).toBe(44);
    expect(w.dailyOvertimeSum).toBe(10.4); // 4 × 2.6
    expect(w.weeklyOvertime).toBe(2); // 44 - 42
    // effektiv = max(10.4, 2) = 10.4 — NICHT 12.4
    expect(w.effectiveOvertime).toBe(10.4);
    expect(res.employees[0].overtimeHours).toBe(10.4);
    expect(res.employees[0].overtimeHours).not.toBe(12.4);
  });

  // 4) Stündliche Mitarbeiter werden ausgeschlossen
  it('schliesst stündliche Mitarbeiter (aushilfe/minijob) aus', () => {
    const aush = makeEmp({ id: 'h1', employmentType: 'aushilfe', hourlyWage: 30, monthlySalary: 0 });
    const mini = makeEmp({ id: 'h2', employmentType: 'minijob', hourlyWage: 25, monthlySalary: 0 });
    const res = computeOvertimeAnalysis({
      employees: [aush, mini],
      entries: [entry('h1', '2026-06-22', 12), entry('h2', '2026-06-22', 12)],
    });
    expect(res.employees).toHaveLength(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeCost).toBe(0);
  });

  // 4b) Abwesenheiten (FE/K/U) zählen NICHT als Überstunden, auch nicht über die Wochenschwelle
  it('ignoriert Abwesenheitseinträge (Ferien/Krankheit) bei Tages- UND Wochen-Überstunden', () => {
    const emp = makeEmp({ id: 'e4b', name: 'Felix' });
    // 5 produktive Tage à 8h = 40h (keine ÜS) + 2 Ferientage à 8.4h.
    // Würden die Ferientage mitzählen: Woche = 56.8h → 14.8h Wochen-ÜS (falsch).
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [
        entry('e4b', '2026-06-22', 8),
        entry('e4b', '2026-06-23', 8),
        entry('e4b', '2026-06-24', 8),
        entry('e4b', '2026-06-25', 8),
        entry('e4b', '2026-06-26', 8),
        absence('e4b', '2026-06-27', 8.4, 'FE'),
        absence('e4b', '2026-06-28', 8.4, 'K'),
      ],
    });
    expect(res.affectedEmployeeCount).toBe(0);
    expect(res.totalOvertimeHours).toBe(0);

    // Gegenprobe: ein einzelner Ferientag mit 12h erzeugt KEINE Tages-Überstunden
    const single = computeOvertimeAnalysis({
      employees: [emp],
      entries: [absence('e4b', '2026-06-22', 12, 'FE')],
    });
    expect(single.affectedEmployeeCount).toBe(0);
    expect(single.totalOvertimeHours).toBe(0);
  });

  // 5) Fehlender Stundensatz → Stunden ausgewiesen, Kosten nicht verfügbar
  it('weist Überstunden ohne Satz aus, markiert Kosten als nicht verfügbar', () => {
    const emp = makeEmp({ id: 'e5', hourlyWage: 0, monthlySalary: 0 });
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [entry('e5', '2026-06-22', 10)], // 1.6h Überstunden
    });
    const r = res.employees[0];
    expect(r.overtimeHours).toBe(1.6);
    expect(r.rateAvailable).toBe(false);
    expect(r.hourlyRate).toBeNull();
    expect(r.overtimeCost).toBeNull();
    expect(r.weeks[0].cost).toBeNull();
    expect(res.hasUnavailableRates).toBe(true);
    expect(res.totalOvertimeHours).toBe(1.6);
    expect(res.totalOvertimeCost).toBe(0); // nur verfügbare Kosten summiert
    expect(res.affectedEmployeeCount).toBe(1);
  });

  // 8) Abteilungsfilter
  it('respektiert den Abteilungsfilter', () => {
    const svc = makeEmp({ id: 's', name: 'Service-Sven', department: 'service' });
    const kue = makeEmp({ id: 'k', name: 'Küchen-Kim', department: 'küche' });
    const entries = [entry('s', '2026-06-22', 9.4), entry('k', '2026-06-22', 9.4)];

    const all = computeOvertimeAnalysis({ employees: [svc, kue], entries, departmentFilter: 'all' });
    expect(all.affectedEmployeeCount).toBe(2);

    const onlyKueche = computeOvertimeAnalysis({ employees: [svc, kue], entries, departmentFilter: 'küche' });
    expect(onlyKueche.affectedEmployeeCount).toBe(1);
    expect(onlyKueche.employees[0].department).toBe('küche');
  });

  // 9) Festangestellter ohne Überstunden → nicht betroffen
  it('listet Festangestellte ohne Überstunden nicht auf', () => {
    const emp = makeEmp({ id: 'e9' });
    // 5 Tage × 8h = 40h, jeder Tag < 8.4, Woche < 42
    const entries = ['22', '23', '24', '25', '26'].map((d) => entry('e9', `2026-06-${d}`, 8));
    const res = computeOvertimeAnalysis({ employees: [emp], entries });
    expect(res.employees).toHaveLength(0);
    expect(res.totalOvertimeHours).toBe(0);
    expect(res.affectedEmployeeCount).toBe(0);
  });

  // ISO-Woche über den Jahreswechsel: 31.12.2025 + 02.01.2026 = dieselbe ISO-Woche 2026-W01
  it('gruppiert über den Jahreswechsel korrekt nach ISO-Woche', () => {
    const emp = makeEmp({ id: 'x' });
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [entry('x', '2025-12-31', 9.4), entry('x', '2026-01-02', 9.4)],
    });
    const r = res.employees[0];
    expect(r.weeks).toHaveLength(1); // eine gemeinsame ISO-Woche
    expect(r.weeks[0].weekKey).toBe('2026-W01');
    expect(r.weeks[0].dailyOvertimeSum).toBe(2);
    expect(r.weeks[0].effectiveOvertime).toBe(2);
    expect(r.overtimeHours).toBe(2);
  });

  // Mehrere Einträge am selben Tag werden summiert (Rundung)
  it('summiert mehrere Einträge am selben Tag und rundet sauber', () => {
    const emp = makeEmp({ id: 'm' });
    const res = computeOvertimeAnalysis({
      employees: [emp],
      entries: [entry('m', '2026-06-22', 5), entry('m', '2026-06-22', 4.4)], // 9.4h total
    });
    const r = res.employees[0];
    expect(r.weeks[0].days[0].actualHours).toBe(9.4);
    expect(r.overtimeHours).toBe(1); // 9.4 - 8.4, ohne Float-Rauschen
  });
});

describe('overtime-analysis: computeOvertimeTotals (Toggle)', () => {
  // 6) Toggle EIN → Überstunden fliessen in Total + PKQ
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

  // 7) Toggle AUS → Überstunden NICHT im Total/PKQ, aber weiterhin ausgewiesen
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
