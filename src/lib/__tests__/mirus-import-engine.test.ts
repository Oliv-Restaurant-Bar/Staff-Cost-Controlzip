// @vitest-environment node
/**
 * Tests für die MIRUS-Import-Engine («MIRUS überschreibt mit Rückfragen»).
 */
import { describe, it, expect } from 'vitest';
import {
  checkMirusScope, buildMirusReconcilePlan, resolvePlanToWrites, expectedAfterTotals,
  MirusResolvedEntry,
} from '@/lib/mirus-import-engine';

const month = '2026-07';
const dates = ['2026-07-01', '2026-07-02', '2026-07-03'];

const entry = (employeeId: string, date: string, hours: number): MirusResolvedEntry =>
  ({ employeeId, employeeName: employeeId.toUpperCase(), date, hours });

describe('checkMirusScope', () => {
  it('akzeptiert einen Monat', () => {
    const r = checkMirusScope(['2026-07-05', '2026-07-01']);
    expect(r.ok).toBe(true);
    expect(r.month).toBe('2026-07');
    expect(r.dates).toEqual(['2026-07-01', '2026-07-05']);
  });
  it('bricht bei monatsübergreifender Datei ab', () => {
    const r = checkMirusScope(['2026-07-31', '2026-08-01']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/monatsübergreifend/);
  });
  it('bricht ohne Datum ab', () => {
    expect(checkMirusScope([]).ok).toBe(false);
    expect(checkMirusScope(['quark']).ok).toBe(false);
  });
});

describe('buildMirusReconcilePlan — Zell-Logik', () => {
  it('leer + Datei > 0 → auto_take; leer + 0 → bleibt frei', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8.5), entry('a', '2026-07-02', 0)],
      existing: {},
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cells = plan.employees[0].cells;
    expect(cells[0].decision).toBe('auto_take');
    expect(cells[1].decision).toBe('unchanged_free');
    expect(cells[2].decision).toBe('unchanged_free'); // Tag ohne Eintrag = 0
    expect(plan.conflicts).toHaveLength(0);
  });

  it('abweichende Stunden ohne Marke + Datei > 0 → auto überschreiben; identisch → unverändert', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 9.85), entry('a', '2026-07-02', 8)],
      existing: {
        'a-2026-07-01': { hours: 8.43 },
        'a-2026-07-02': { hours: 8 },
      },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cells = plan.employees[0].cells;
    expect(cells[0].decision).toBe('auto_take');
    expect(cells[1].decision).toBe('unchanged_equal');
  });

  it('Absenz + Datei 0 → Marke inkl. Stunden bleibt vollständig', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: { 'a-2026-07-01': { hours: 8.4, absenceType: 'K' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    expect(plan.employees[0].cells[0].decision).toBe('unchanged_absence');
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
    // Stunden der Absenz-Zelle zählen im After-Total weiter
    expect(expectedAfterTotals(plan).a).toBe(8.4);
  });

  it('Konflikt A: Datei 0 vs. Stunden ohne Marke → Rückfrage, Default MIRUS = löschen', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: { 'a-2026-07-01': { hours: 8 } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].decision).toBe('conflict_a');
    const writes = resolvePlanToWrites(plan);
    expect(writes).toEqual([{ employeeId: 'a', date: '2026-07-01', entry: null }]);
    // Lösung «Dienstplan behalten» → keine Schreib-Operation
    plan.employees[0].cells[0].resolution = 'keep';
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
    expect(expectedAfterTotals(plan).a).toBe(8);
  });

  it('Konflikt B: Datei > 0 vs. Absenz → Rückfrage; MIRUS entfernt Marke', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 9.27)],
      existing: { 'a-2026-07-01': { hours: 0, absenceType: 'F' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    expect(plan.conflicts[0].decision).toBe('conflict_b');
    const writes = resolvePlanToWrites(plan);
    expect(writes).toHaveLength(1);
    expect(writes[0].entry?.hours).toBe(9.27);
    expect(writes[0].entry?.absenceType).toBeUndefined();
  });

  it('MANUELL-Mitarbeiter in der Datei werden übersprungen, nie geschrieben', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('aushilfe', '2026-07-01', 9.5), entry('a', '2026-07-01', 8)],
      existing: { 'aushilfe-2026-07-01': { hours: 5 } },
      erfassungsart: { a: 'MIRUS', aushilfe: 'MANUELL' },
      month, dates,
    });
    expect(plan.skippedManual).toEqual([
      { employeeId: 'aushilfe', employeeName: 'AUSHILFE', fileTotal: 9.5 },
    ]);
    expect(plan.employees.map(e => e.employeeId)).toEqual(['a']);
    const writes = resolvePlanToWrites(plan);
    expect(writes.every(w => w.employeeId === 'a')).toBe(true);
  });

  it('Nicht-Datei-Mitarbeiter kommen im Plan nicht vor (78-Einträge-Bug behoben)', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8)],
      existing: {
        'a-2026-07-01': { hours: 7 },
        'kawtar-2026-07-01': { hours: 5.5 },   // nicht in Datei
        'lokaj-2026-07-02': { hours: 9.5 },    // nicht in Datei
      },
      erfassungsart: { a: 'MIRUS', kawtar: 'MANUELL', lokaj: 'MIRUS' },
      month, dates,
    });
    const writes = resolvePlanToWrites(plan);
    expect(writes.map(w => w.employeeId)).toEqual(['a']);
  });

  it('Gegenprüfung: After-Total = Datei-Total bei reinem Auto-Fall', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8.08), entry('a', '2026-07-02', 7.33), entry('a', '2026-07-03', 9.1)],
      existing: { 'a-2026-07-01': { hours: 9 }, 'a-2026-07-03': { hours: 0, absenceType: 'F' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    // 03. ist Konflikt B (Default mirus) → alles = Datei
    expect(expectedAfterTotals(plan).a).toBe(24.51);
    expect(plan.employees[0].fileTotal).toBe(24.51);
  });

  it('mehrere Zeilen gleicher MA/Tag werden summiert', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 4), entry('a', '2026-07-01', 4.5)],
      existing: {},
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    expect(plan.employees[0].cells[0].fileHours).toBe(8.5);
  });
});
