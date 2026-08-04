// @vitest-environment node
/**
 * Tests für die MIRUS-Import-Engine («MIRUS überschreibt mit Rückfragen»),
 * inkl. Muster 1–5 und stiller Rundungs-Übernahme (Spec-Abnahme).
 */
import { describe, it, expect } from 'vitest';
import {
  checkMirusScope, buildMirusReconcilePlan, resolvePlanToWrites, expectedAfterTotals,
  groupPlanCells, canonicalAbsence, computeIstCoverage, formatDayRanges, daysInMonthOf,
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

describe('Monats-Abdeckung («Ist-Abdeckung: X/N Tage»)', () => {
  it('daysInMonthOf kennt Monatslängen inkl. Schaltjahr', () => {
    expect(daysInMonthOf('2026-07')).toBe(31);
    expect(daysInMonthOf('2026-02')).toBe(28);
    expect(daysInMonthOf('2028-02')).toBe(29);
  });

  it('computeIstCoverage: Juli 28/31, es fehlen 29.–31.07.', () => {
    const keys: string[] = [];
    for (let d = 1; d <= 28; d++) {
      keys.push(`emp1-2026-07-${String(d).padStart(2, '0')}`);
    }
    keys.push('emp1-2026-08-01'); // anderer Monat zählt nicht
    const cov = computeIstCoverage('2026-07', keys);
    expect(cov.covered).toBe(28);
    expect(cov.total).toBe(31);
    expect(cov.missingDates).toEqual(['2026-07-29', '2026-07-30', '2026-07-31']);
    expect(formatDayRanges(cov.missingDates)).toBe('29.–31.07.');
  });

  it('formatDayRanges: Einzeltage und Bereiche gemischt', () => {
    expect(formatDayRanges(['2026-07-05'])).toBe('05.07.');
    expect(formatDayRanges(['2026-07-01', '2026-07-02', '2026-07-04'])).toBe('01.–02.07., 04.07.');
    expect(formatDayRanges([])).toBe('');
  });

  it('Blockimport-Beispiel: Datei 29.07.–02.08. bei Juli → nur 29.–31.07. verarbeitet, August gelistet', () => {
    const julyDates = ['2026-07-29', '2026-07-30', '2026-07-31'];
    const plan = buildMirusReconcilePlan({
      entries: [
        entry('a', '2026-07-29', 8), entry('a', '2026-07-30', 8), entry('a', '2026-07-31', 8),
        entry('a', '2026-08-01', 8), entry('a', '2026-08-02', 8),
      ],
      existing: {},
      erfassungsart: { a: 'MIRUS' },
      month: '2026-07',
      dates: julyDates,
    });
    expect(plan.employees[0].fileTotal).toBe(24);
    expect(resolvePlanToWrites(plan).map(w => w.date)).toEqual(julyDates);
    expect(plan.skippedOutOfScope.map(r => r.date)).toEqual(['2026-08-01', '2026-08-02']);
  });
});

describe('canonicalAbsence', () => {
  it('mappt Plan-Codes auf FE/K/U; «F» (frei) zählt nicht', () => {
    expect(canonicalAbsence('FE')).toBe('FE');
    expect(canonicalAbsence('Ferien')).toBe('FE');
    expect(canonicalAbsence('K')).toBe('K');
    expect(canonicalAbsence('Unfall')).toBe('U');
    expect(canonicalAbsence('F')).toBeNull();
    expect(canonicalAbsence(null)).toBeNull();
  });
});

describe('buildMirusReconcilePlan — Muster-Logik', () => {
  it('Muster 1: MIRUS-Stunden, Ist leer → auto_take (Gruppe «wird übernommen»)', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8.5), entry('a', '2026-07-02', 0)],
      existing: {},
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cells = plan.employees[0].cells;
    expect(cells[0].decision).toBe('auto_take');
    expect(cells[0].resolution).toBe('mirus');
    expect(cells[1].decision).toBe('unchanged_free');
    expect(groupPlanCells(plan)[1]).toHaveLength(1);
  });

  it('Rundung ≤ 0.05 h → still übernehmen (silent_round, nicht in Gruppen), exakt gleich → kein Write', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8.04), entry('a', '2026-07-02', 8)],
      existing: {
        'a-2026-07-01': { hours: 8 },      // Diff 0.04 ≤ 0.05 → still
        'a-2026-07-02': { hours: 8 },      // identisch → kein Write
      },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cells = plan.employees[0].cells;
    expect(cells[0].decision).toBe('silent_round');
    expect(cells[1].decision).toBe('unchanged_equal');
    expect(plan.silentRounds).toHaveLength(1);
    const g = groupPlanCells(plan);
    expect(g[1].length + g[2].length + g[3].length + g[4].length + g[5].length).toBe(0);
    const writes = resolvePlanToWrites(plan);
    expect(writes).toHaveLength(1);
    expect(writes[0].entry?.hours).toBe(8.04);
  });

  it('Muster 5: beide Stunden, Diff > Schwelle → Rückfrage (kein Auto-Überschreiben mehr)', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 9.85)],
      existing: { 'a-2026-07-01': { hours: 8.43 } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('conflict_diff');
    expect(groupPlanCells(plan)[5]).toHaveLength(1);
    // Default mirus → überschreiben; keep → nichts
    expect(resolvePlanToWrites(plan)[0].entry?.hours).toBe(9.85);
    cell.resolution = 'keep';
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
    expect(expectedAfterTotals(plan).a).toBe(8.43);
  });

  it('Muster 2: MIRUS 0 vs. Ist-Stunden → Rückfrage; mirus = Zelle leeren', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: { 'a-2026-07-01': { hours: 8 } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('conflict_zero');
    expect(resolvePlanToWrites(plan)).toEqual([{ employeeId: 'a', date: '2026-07-01', entry: null }]);
    cell.resolution = 'keep';
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
    expect(expectedAfterTotals(plan).a).toBe(8);
  });

  it('Muster 2 (Plan-Variante): MIRUS 0, Ist leer, PLAN hat Stunden → Rückfrage ohne Write', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: {},
      planned: { 'a-2026-07-01': { hours: 8.5, absence: null } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('conflict_zero');
    expect(cell.plan.hours).toBe(8.5);
    // Keine gespeicherte Ist vorhanden → weder mirus noch keep schreibt etwas
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
  });

  it('Muster 3: Ist-Absenz + MIRUS 0 → absence_keep, Default keep = unangetastet', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: { 'a-2026-07-01': { hours: 8.4, absenceType: 'K' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('absence_keep');
    expect(cell.resolution).toBe('keep');
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
    expect(expectedAfterTotals(plan).a).toBe(8.4);
    // «MIRUS übernehmen» = 0 ohne Code → Zelle leeren
    cell.resolution = 'mirus';
    expect(resolvePlanToWrites(plan)).toEqual([{ employeeId: 'a', date: '2026-07-01', entry: null }]);
  });

  it('Muster 3 (Plan-Absenz, Ist leer): keep materialisiert Code mit 0 Stunden', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 0)],
      existing: {},
      planned: { 'a-2026-07-01': { hours: 0, absence: 'FE' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('absence_keep');
    const writes = resolvePlanToWrites(plan);
    expect(writes).toHaveLength(1);
    expect(writes[0].entry).toMatchObject({ hours: 0, absenceType: 'FE' });
  });

  it('Muster 4: Absenz vs. MIRUS-Stunden → Rückfrage; mirus entfernt Marke', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 9.27)],
      existing: { 'a-2026-07-01': { hours: 0, absenceType: 'F' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    const cell = plan.employees[0].cells[0];
    expect(cell.decision).toBe('conflict_absence');
    const writes = resolvePlanToWrites(plan);
    expect(writes).toHaveLength(1);
    expect(writes[0].entry?.hours).toBe(9.27);
    expect(writes[0].entry?.absenceType).toBeUndefined();
    cell.resolution = 'keep';
    expect(resolvePlanToWrites(plan)).toHaveLength(0);
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

  it('Zeilen ausserhalb des Monats werden übersprungen und gelistet', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8), entry('a', '2026-06-30', 7.5)],
      existing: {},
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    expect(plan.skippedOutOfScope).toEqual([{ employeeName: 'A', date: '2026-06-30', hours: 7.5 }]);
    expect(plan.employees[0].fileTotal).toBe(8);
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

  it('Gegenprüfung: After-Total = Datei-Total, wenn alle Muster auf MIRUS stehen', () => {
    const plan = buildMirusReconcilePlan({
      entries: [entry('a', '2026-07-01', 8.08), entry('a', '2026-07-02', 7.33), entry('a', '2026-07-03', 9.1)],
      existing: { 'a-2026-07-01': { hours: 9 }, 'a-2026-07-03': { hours: 0, absenceType: 'F' } },
      erfassungsart: { a: 'MIRUS' },
      month, dates,
    });
    // 01. Muster 5, 03. Muster 4 — Defaults mirus → alles = Datei
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

  it('Abnahme-Szenario: je ein Fall Muster 1–5 + Rundungsfall gruppiert korrekt', () => {
    const plan = buildMirusReconcilePlan({
      entries: [
        entry('m1', '2026-07-01', 8),      // Ist leer → Muster 1
        entry('m2', '2026-07-01', 0),      // Ist 8h → Muster 2
        entry('m3', '2026-07-01', 0),      // Ist FE → Muster 3
        entry('m4', '2026-07-01', 6),      // Ist FE → Muster 4
        entry('m5', '2026-07-01', 9),      // Ist 8h → Muster 5
        entry('r', '2026-07-01', 8.03),    // Ist 8h → Rundung, still
      ],
      existing: {
        'm2-2026-07-01': { hours: 8 },
        'm3-2026-07-01': { hours: 8.4, absenceType: 'FE' },
        'm4-2026-07-01': { hours: 8.4, absenceType: 'FE' },
        'm5-2026-07-01': { hours: 8 },
        'r-2026-07-01': { hours: 8 },
      },
      erfassungsart: { m1: 'MIRUS', m2: 'MIRUS', m3: 'MIRUS', m4: 'MIRUS', m5: 'MIRUS', r: 'MIRUS' },
      month, dates,
    });
    const g = groupPlanCells(plan);
    expect(g[1].map(c => c.employeeId)).toEqual(['m1']);
    expect(g[2].map(c => c.employeeId)).toEqual(['m2']);
    expect(g[3].map(c => c.employeeId)).toEqual(['m3']);
    expect(g[4].map(c => c.employeeId)).toEqual(['m4']);
    expect(g[5].map(c => c.employeeId)).toEqual(['m5']);
    expect(plan.silentRounds.map(c => c.employeeId)).toEqual(['r']);
  });
});
