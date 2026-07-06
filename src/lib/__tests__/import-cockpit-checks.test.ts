// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  type CockpitRow,
  type CockpitSourceDef,
  type CockpitStatusResult,
} from '../import-cockpit';
import { buildControlRows, buildTasks, type CockpitTask } from '../import-cockpit-tabs';
import {
  MANUAL_CHECKS_KEY,
  nextDueAfterCompletion,
  makeCompletion,
  isCompletionActive,
  pruneCompletions,
  markControlsDone,
  partitionTasksForCompletion,
  type ManualCompletionMap,
} from '../import-cockpit-checks';

const TODAY = '2026-07-06';

function makeDef(o: Partial<CockpitSourceDef> = {}): CockpitSourceDef {
  return {
    id: 'tagesumsatz',
    label: 'Test-Quelle',
    module: 'Test-Modul',
    category: 'umsatz_gastronovi',
    section: 'import',
    tabCategory: 'umsatz',
    importType: 'file_upload',
    uploadLabel: 'Etwas hochladen',
    interval: 'daily',
    description: 'Beschreibung',
    checklistLabel: 'Aufgabe erledigen',
    checkable: true,
    ...o,
  };
}

function makeResult(o: Partial<CockpitStatusResult> = {}): CockpitStatusResult {
  return {
    status: 'current',
    latestDataDate: null,
    daysBehind: null,
    nextDue: null,
    missingDays: [],
    completeUntil: null,
    ignoredFutureDate: null,
    failed: false,
    reason: 'Grund',
    ...o,
  };
}

function makeRow(defO: Partial<CockpitSourceDef> = {}, resO: Partial<CockpitStatusResult> = {}): CockpitRow {
  return { def: makeDef(defO), signal: { latestDataDate: null }, result: makeResult(resO) };
}

// ─── nextDueAfterCompletion ───────────────────────────────────────────────────

describe('nextDueAfterCompletion', () => {
  it('täglich +1 Tag', () => {
    expect(nextDueAfterCompletion('daily', TODAY)).toBe('2026-07-07');
  });
  it('wöchentlich +7 Tage', () => {
    expect(nextDueAfterCompletion('weekly', TODAY)).toBe('2026-07-13');
  });
  it('monatlich +1 Monat', () => {
    expect(nextDueAfterCompletion('monthly', TODAY)).toBe('2026-08-06');
  });
  it('jährlich +1 Jahr', () => {
    expect(nextDueAfterCompletion('yearly', TODAY)).toBe('2027-07-06');
  });
  it('Monatsende-Rollover (31.01 monatlich → Februar-Ende)', () => {
    // date-fns addMonths klemmt auf den letzten gültigen Tag des Zielmonats.
    expect(nextDueAfterCompletion('monthly', '2026-01-31')).toBe('2026-02-28');
  });
});

// ─── makeCompletion / isCompletionActive ─────────────────────────────────────

describe('makeCompletion / isCompletionActive', () => {
  it('makeCompletion setzt completedAt=heute und nextDue=heute+Rhythmus', () => {
    expect(makeCompletion('weekly', TODAY)).toEqual({ completedAt: TODAY, nextDue: '2026-07-13' });
  });

  it('aktiv, solange today < nextDue', () => {
    const c = makeCompletion('weekly', TODAY); // nextDue 2026-07-13
    expect(isCompletionActive(c, TODAY)).toBe(true);
    expect(isCompletionActive(c, '2026-07-12')).toBe(true);
  });

  it('am Tag der nächsten Fälligkeit (today === nextDue) NICHT mehr aktiv', () => {
    const c = makeCompletion('weekly', TODAY); // nextDue 2026-07-13
    expect(isCompletionActive(c, '2026-07-13')).toBe(false);
    expect(isCompletionActive(c, '2026-07-20')).toBe(false);
  });

  it('null/undefined → nie aktiv', () => {
    expect(isCompletionActive(null, TODAY)).toBe(false);
    expect(isCompletionActive(undefined, TODAY)).toBe(false);
  });

  it('tägliche Erledigung ist am Folgetag bereits abgelaufen', () => {
    const c = makeCompletion('daily', TODAY); // nextDue 2026-07-07
    expect(isCompletionActive(c, TODAY)).toBe(true);
    expect(isCompletionActive(c, '2026-07-07')).toBe(false);
  });
});

// ─── pruneCompletions ─────────────────────────────────────────────────────────

describe('pruneCompletions', () => {
  it('entfernt abgelaufene, behält aktive', () => {
    const map: ManualCompletionMap = {
      aktiv: { completedAt: '2026-07-05', nextDue: '2026-08-05' },
      abgelaufen: { completedAt: '2026-06-01', nextDue: '2026-07-01' },
      genauHeute: { completedAt: '2026-06-06', nextDue: TODAY }, // nextDue===today → abgelaufen
    };
    const pruned = pruneCompletions(map, TODAY);
    expect(Object.keys(pruned)).toEqual(['aktiv']);
  });

  it('leerer Map bleibt leer', () => {
    expect(pruneCompletions({}, TODAY)).toEqual({});
  });
});

// ─── markControlsDone ─────────────────────────────────────────────────────────

describe('markControlsDone', () => {
  it('markiert mehrere Kontrollen mit korrektem Rhythmus als heute erledigt', () => {
    const next = markControlsDone(
      {},
      [
        { id: 'dienstplanung', interval: 'weekly' },
        { id: 'monatsabschluss', interval: 'monthly' },
      ],
      TODAY,
    );
    expect(next.dienstplanung).toEqual({ completedAt: TODAY, nextDue: '2026-07-13' });
    expect(next.monatsabschluss).toEqual({ completedAt: TODAY, nextDue: '2026-08-06' });
  });

  it('gibt einen NEUEN Map zurück (keine Mutation des Originals)', () => {
    const original: ManualCompletionMap = {};
    const next = markControlsDone(original, [{ id: 'forecast', interval: 'weekly' }], TODAY);
    expect(original).toEqual({});
    expect(next).not.toBe(original);
  });

  it('entfernt beim Markieren abgelaufene Alt-Einträge', () => {
    const map: ManualCompletionMap = { alt: { completedAt: '2026-05-01', nextDue: '2026-06-01' } };
    const next = markControlsDone(map, [{ id: 'neu', interval: 'monthly' }], TODAY);
    expect(next.alt).toBeUndefined();
    expect(next.neu).toBeDefined();
  });

  it('überschreibt bestehende Erledigung derselben Kontrolle', () => {
    const map: ManualCompletionMap = { dienstplanung: { completedAt: '2026-07-01', nextDue: '2026-07-08' } };
    const next = markControlsDone(map, [{ id: 'dienstplanung', interval: 'weekly' }], TODAY);
    expect(next.dienstplanung).toEqual({ completedAt: TODAY, nextDue: '2026-07-13' });
  });
});

// ─── partitionTasksForCompletion ──────────────────────────────────────────────

describe('partitionTasksForCompletion', () => {
  const tasks: CockpitTask[] = [
    { id: 'reservationen', def: makeDef({ id: 'reservationen', section: 'import' }), section: 'import', priority: 'critical', timeframe: 'today', label: 'Reservationen', reason: 'x' },
    { id: 'monatsabschluss', def: makeDef({ id: 'monatsabschluss', section: 'control' }), section: 'control', priority: 'critical', timeframe: 'month', label: 'Monatsabschluss', reason: 'x' },
    { id: 'forecast', def: makeDef({ id: 'forecast', section: 'control' }), section: 'control', priority: 'medium', timeframe: 'week', label: 'Forecast', reason: 'x' },
  ];

  it('nur Kontroll-Aufgaben sind erledigbar, Importe werden blockiert', () => {
    const { completable, blocked } = partitionTasksForCompletion(
      tasks,
      new Set(['reservationen', 'monatsabschluss', 'forecast']),
    );
    expect(completable.map((t) => t.id).sort()).toEqual(['forecast', 'monatsabschluss']);
    expect(blocked.map((t) => t.id)).toEqual(['reservationen']);
  });

  it('nicht ausgewählte Aufgaben tauchen in keiner Liste auf', () => {
    const { completable, blocked } = partitionTasksForCompletion(tasks, new Set(['monatsabschluss']));
    expect(completable.map((t) => t.id)).toEqual(['monatsabschluss']);
    expect(blocked).toHaveLength(0);
  });

  it('leere Auswahl → beide Listen leer', () => {
    const { completable, blocked } = partitionTasksForCompletion(tasks, new Set());
    expect(completable).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });
});

// ─── Integration mit buildControlRows / buildTasks ────────────────────────────

describe('buildControlRows mit Erledigungen', () => {
  const rows: CockpitRow[] = [
    makeRow(
      { id: 'monatsabschluss', section: 'control', tabCategory: 'monatsabschluss', interval: 'monthly', checkable: true },
      { status: 'overdue', nextDue: '2026-06-01' },
    ),
    makeRow(
      { id: 'forecast', section: 'control', tabCategory: 'forecast', interval: 'weekly', checkable: true },
      { status: 'overdue', nextDue: '2026-06-01' },
    ),
  ];

  it('aktive Erledigung überschreibt Status auf done + nextDue + Marker', () => {
    const completions: ManualCompletionMap = { monatsabschluss: makeCompletion('monthly', TODAY) };
    const built = buildControlRows(rows, TODAY, completions);
    const byId = Object.fromEntries(built.map((r) => [r.def.id, r]));
    expect(byId.monatsabschluss.controlStatus).toBe('done');
    expect(byId.monatsabschluss.manuallyCompleted).toBe(true);
    expect(byId.monatsabschluss.completedAt).toBe(TODAY);
    expect(byId.monatsabschluss.result.nextDue).toBe('2026-08-06');
    // nicht markierte Kontrolle bleibt überfällig
    expect(byId.forecast.controlStatus).toBe('overdue');
    expect(byId.forecast.manuallyCompleted).toBe(false);
  });

  it('abgelaufene Erledigung wirkt nicht (Status bleibt abgeleitet)', () => {
    const completions: ManualCompletionMap = {
      monatsabschluss: { completedAt: '2026-05-01', nextDue: '2026-06-01' },
    };
    const built = buildControlRows(rows, TODAY, completions);
    const row = built.find((r) => r.def.id === 'monatsabschluss')!;
    expect(row.controlStatus).toBe('overdue');
    expect(row.manuallyCompleted).toBe(false);
  });

  it('ohne completions verhält sich buildControlRows wie bisher (Rückwärtskompat)', () => {
    const built = buildControlRows(rows, TODAY);
    expect(built.every((r) => r.manuallyCompleted === false)).toBe(true);
    expect(built.find((r) => r.def.id === 'monatsabschluss')!.controlStatus).toBe('overdue');
  });
});

describe('buildTasks mit Erledigungen', () => {
  const rows: CockpitRow[] = [
    makeRow({ id: 'reservationen', section: 'import', interval: 'daily' }, { status: 'overdue' }),
    makeRow(
      { id: 'monatsabschluss', section: 'control', tabCategory: 'monatsabschluss', interval: 'monthly', checkable: true },
      { status: 'overdue' },
    ),
  ];

  it('erledigte Kontroll-Aufgabe verschwindet, Import-Aufgabe bleibt', () => {
    const completions: ManualCompletionMap = { monatsabschluss: makeCompletion('monthly', TODAY) };
    const tasks = buildTasks(rows, TODAY, completions);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('reservationen');
    expect(ids).not.toContain('monatsabschluss');
  });

  it('eine Import-Aufgabe ist NICHT durch eine (fehlplatzierte) Completion erledigbar', () => {
    // Selbst wenn für eine Import-ID eine Completion existierte, darf sie nicht greifen.
    const completions: ManualCompletionMap = { reservationen: makeCompletion('daily', TODAY) };
    const tasks = buildTasks(rows, TODAY, completions);
    expect(tasks.map((t) => t.id)).toContain('reservationen');
  });

  it('ohne completions unverändert (Rückwärtskompat)', () => {
    const tasks = buildTasks(rows, TODAY);
    expect(tasks.map((t) => t.id).sort()).toEqual(['monatsabschluss', 'reservationen']);
  });
});

// ─── Konstanten ───────────────────────────────────────────────────────────────

describe('MANUAL_CHECKS_KEY', () => {
  it('ist stabil (Persistenz-Schlüssel darf sich nicht ändern)', () => {
    expect(MANUAL_CHECKS_KEY).toBe('importCockpitControlChecks');
  });
});
