// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  COCKPIT_SOURCES,
  type CockpitRow,
  type CockpitSourceDef,
  type CockpitStatusResult,
} from '../import-cockpit';
import {
  computeControlStatus,
  buildControlRows,
  buildImportRows,
  buildTasks,
  groupTasksByTimeframe,
  summarizeControls,
  summarizeTasks,
  importTaskPriority,
  controlTaskPriority,
  importRowMatchesFilters,
  controlRowMatchesFilters,
  taskMatchesFilters,
  EMPTY_IMPORT_TAB_FILTER,
  EMPTY_CONTROL_TAB_FILTER,
  EMPTY_TASK_TAB_FILTER,
  IMPORT_CATEGORY_ORDER,
  CONTROL_CATEGORY_ORDER,
  TAB_CATEGORY_LABEL,
  CONTROL_STATUS_LABEL,
  CONTROL_STATUS_ORDER,
  CONTROL_STATUS_BADGE_CLASS,
  CONTROL_STATUS_DOT_CLASS,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_ORDER,
  TASK_PRIORITY_BADGE_CLASS,
  TASK_PRIORITY_DOT_CLASS,
  TASK_TIMEFRAME_LABEL,
  TASK_TIMEFRAME_ORDER,
  SECTION_LABEL,
  type ControlRow,
  type CockpitTask,
} from '../import-cockpit-tabs';

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

// ─── computeControlStatus ─────────────────────────────────────────────────────

describe('computeControlStatus', () => {
  it('nicht prüfbare Kontrolle (checkable:false) → not_configured (unabhängig vom Status)', () => {
    expect(computeControlStatus({ checkable: false }, { status: 'overdue', nextDue: null }, TODAY)).toBe(
      'not_configured',
    );
    expect(computeControlStatus({ checkable: false }, { status: 'current', nextDue: TODAY }, TODAY)).toBe(
      'not_configured',
    );
  });

  it('prüfbar, aber never/uncheckable → not_configured (keine Fabrikation)', () => {
    expect(computeControlStatus({ checkable: true }, { status: 'never', nextDue: null }, TODAY)).toBe('not_configured');
    expect(computeControlStatus({ checkable: true }, { status: 'uncheckable', nextDue: null }, TODAY)).toBe(
      'not_configured',
    );
  });

  it('overdue → overdue', () => {
    expect(computeControlStatus({ checkable: true }, { status: 'overdue', nextDue: '2026-06-01' }, TODAY)).toBe(
      'overdue',
    );
  });

  it('current: nächste Fälligkeit heute → due_today, sonst done', () => {
    expect(computeControlStatus({ checkable: true }, { status: 'current', nextDue: TODAY }, TODAY)).toBe('due_today');
    expect(computeControlStatus({ checkable: true }, { status: 'current', nextDue: '2026-08-01' }, TODAY)).toBe('done');
    expect(computeControlStatus({ checkable: true }, { status: 'current', nextDue: null }, TODAY)).toBe('done');
  });

  it('due_soon: nächste Fälligkeit heute → due_today, sonst due_soon', () => {
    expect(computeControlStatus({ checkable: true }, { status: 'due_soon', nextDue: TODAY }, TODAY)).toBe('due_today');
    expect(computeControlStatus({ checkable: true }, { status: 'due_soon', nextDue: '2026-07-09' }, TODAY)).toBe(
      'due_soon',
    );
  });
});

// ─── Sektions-Aufteilung ──────────────────────────────────────────────────────

describe('buildImportRows / buildControlRows', () => {
  const rows: CockpitRow[] = [
    makeRow({ id: 'tagesumsatz', section: 'import' }),
    makeRow({ id: 'mirus', section: 'import' }),
    makeRow({ id: 'dienstplanung', section: 'control', tabCategory: 'dienstplanung', checkable: true }, { status: 'current', nextDue: TODAY }),
    makeRow({ id: 'forecast', section: 'control', tabCategory: 'forecast', checkable: false }, { status: 'uncheckable' }),
  ];

  it('buildImportRows behält nur section==="import"', () => {
    const imp = buildImportRows(rows);
    expect(imp).toHaveLength(2);
    expect(imp.every((r) => r.def.section === 'import')).toBe(true);
  });

  it('buildControlRows behält nur Kontrollen und hängt controlStatus an', () => {
    const ctrl = buildControlRows(rows, TODAY);
    expect(ctrl).toHaveLength(2);
    const byId = Object.fromEntries(ctrl.map((r) => [r.def.id, r.controlStatus]));
    expect(byId.dienstplanung).toBe('due_today');
    expect(byId.forecast).toBe('not_configured');
  });
});

// ─── Prioritäten ──────────────────────────────────────────────────────────────

describe('importTaskPriority / controlTaskPriority', () => {
  it('Import: overdue→critical, never/due_soon→medium, current/uncheckable→null', () => {
    expect(importTaskPriority('overdue')).toBe('critical');
    expect(importTaskPriority('never')).toBe('medium');
    expect(importTaskPriority('due_soon')).toBe('medium');
    expect(importTaskPriority('current')).toBeNull();
    expect(importTaskPriority('uncheckable')).toBeNull();
  });

  it('Kontrolle: overdue/due_today→critical, due_soon→medium, done/not_configured→null', () => {
    expect(controlTaskPriority('overdue')).toBe('critical');
    expect(controlTaskPriority('due_today')).toBe('critical');
    expect(controlTaskPriority('due_soon')).toBe('medium');
    expect(controlTaskPriority('done')).toBeNull();
    expect(controlTaskPriority('not_configured')).toBeNull();
  });
});

// ─── buildTasks ───────────────────────────────────────────────────────────────

describe('buildTasks', () => {
  const rows: CockpitRow[] = [
    makeRow({ id: 'tagesumsatz', section: 'import', interval: 'daily' }, { status: 'current' }), // kein Task
    makeRow({ id: 'reservationen', section: 'import', interval: 'daily' }, { status: 'overdue' }), // critical
    makeRow({ id: 'jahresbudget', section: 'import', interval: 'yearly' }, { status: 'due_soon' }), // medium
    makeRow(
      { id: 'monatsabschluss', section: 'control', tabCategory: 'monatsabschluss', interval: 'monthly', checkable: true },
      { status: 'overdue' },
    ), // critical
    makeRow(
      { id: 'forecast', section: 'control', tabCategory: 'forecast', interval: 'weekly', checkable: false },
      { status: 'uncheckable' },
    ), // kein Task (not_configured)
  ];

  it('erzeugt nur offene Punkte (neutrale werden übersprungen)', () => {
    const tasks = buildTasks(rows, TODAY);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('reservationen');
    expect(ids).toContain('jahresbudget');
    expect(ids).toContain('monatsabschluss');
    expect(ids).not.toContain('tagesumsatz');
    expect(ids).not.toContain('forecast');
    expect(tasks).toHaveLength(3);
  });

  it('sortiert kritische Aufgaben vor mittlere', () => {
    const tasks = buildTasks(rows, TODAY);
    const firstMedium = tasks.findIndex((t) => t.priority === 'medium');
    const lastCritical = tasks.map((t) => t.priority).lastIndexOf('critical');
    expect(lastCritical).toBeLessThan(firstMedium);
  });

  it('leitet timeframe aus dem Intervall ab', () => {
    const tasks = buildTasks(rows, TODAY);
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t.timeframe]));
    expect(byId.reservationen).toBe('today');
    expect(byId.jahresbudget).toBe('year');
    expect(byId.monatsabschluss).toBe('month');
  });

  it('übernimmt die ehrliche Begründung aus dem Status (nie erfunden)', () => {
    const tasks = buildTasks([makeRow({ id: 'reservationen', section: 'import' }, { status: 'overdue', reason: 'Überfällig – Ist-Daten nur bis 30.06.2026' })], TODAY);
    expect(tasks[0].reason).toBe('Überfällig – Ist-Daten nur bis 30.06.2026');
  });
});

// ─── Gruppierung + KPIs ───────────────────────────────────────────────────────

describe('groupTasksByTimeframe / summarizeTasks', () => {
  const tasks: Array<Pick<CockpitTask, 'timeframe' | 'priority'>> = [
    { timeframe: 'today', priority: 'critical' },
    { timeframe: 'today', priority: 'medium' },
    { timeframe: 'week', priority: 'medium' },
    { timeframe: 'month', priority: 'critical' },
    { timeframe: 'year', priority: 'medium' },
  ];

  it('summarizeTasks zählt je Zeithorizont + kritisch + gesamt', () => {
    const s = summarizeTasks(tasks);
    expect(s).toEqual({ todayOpen: 2, weekOpen: 1, monthOpen: 1, yearOpen: 1, critical: 2, total: 5 });
  });

  it('groupTasksByTimeframe verteilt in vier Buckets', () => {
    const full: CockpitTask[] = tasks.map((t, i) => ({
      id: 'reservationen',
      def: makeDef({ id: 'reservationen' }),
      section: 'import',
      label: `Aufgabe ${i}`,
      reason: 'Grund',
      ...t,
    }));
    const g = groupTasksByTimeframe(full);
    expect(g.today).toHaveLength(2);
    expect(g.week).toHaveLength(1);
    expect(g.month).toHaveLength(1);
    expect(g.year).toHaveLength(1);
  });
});

describe('summarizeControls', () => {
  it('zählt die Kontroll-Status-Verteilung', () => {
    const rows: Array<Pick<ControlRow, 'controlStatus'>> = [
      { controlStatus: 'done' },
      { controlStatus: 'done' },
      { controlStatus: 'due_today' },
      { controlStatus: 'due_soon' },
      { controlStatus: 'overdue' },
      { controlStatus: 'not_configured' },
    ];
    expect(summarizeControls(rows)).toEqual({ done: 2, dueToday: 1, dueSoon: 1, overdue: 1, notConfigured: 1 });
  });
});

// ─── Filter ───────────────────────────────────────────────────────────────────

describe('importRowMatchesFilters', () => {
  const row = makeRow({ tabCategory: 'umsatz', importType: 'file_upload', interval: 'daily', label: 'Tagesumsatz' }, { status: 'overdue' });

  it('leerer Filter matcht alles', () => {
    expect(importRowMatchesFilters(row, EMPTY_IMPORT_TAB_FILTER)).toBe(true);
  });
  it('Kategorie über tabCategory', () => {
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, category: 'umsatz' })).toBe(true);
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, category: 'personal' })).toBe(false);
  });
  it('Status + Import-Art + Intervall (UND)', () => {
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, status: 'overdue', importType: 'file_upload', interval: 'daily' })).toBe(true);
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, status: 'current' })).toBe(false);
  });
  it('Suche über Label', () => {
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, search: 'tagesum' })).toBe(true);
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, search: 'zzz' })).toBe(false);
  });
});

describe('controlRowMatchesFilters', () => {
  const ctrl: ControlRow = {
    def: makeDef({ section: 'control', tabCategory: 'dienstplanung', interval: 'weekly', label: 'Dienstplan' }),
    signal: { latestDataDate: null },
    result: makeResult({ status: 'due_soon' }),
    controlStatus: 'due_soon',
  };

  it('filtert über Kategorie / Intervall / controlStatus / Suche', () => {
    expect(controlRowMatchesFilters(ctrl, EMPTY_CONTROL_TAB_FILTER)).toBe(true);
    expect(controlRowMatchesFilters(ctrl, { ...EMPTY_CONTROL_TAB_FILTER, status: 'due_soon' })).toBe(true);
    expect(controlRowMatchesFilters(ctrl, { ...EMPTY_CONTROL_TAB_FILTER, status: 'overdue' })).toBe(false);
    expect(controlRowMatchesFilters(ctrl, { ...EMPTY_CONTROL_TAB_FILTER, interval: 'weekly' })).toBe(true);
    expect(controlRowMatchesFilters(ctrl, { ...EMPTY_CONTROL_TAB_FILTER, category: 'forecast' })).toBe(false);
    expect(controlRowMatchesFilters(ctrl, { ...EMPTY_CONTROL_TAB_FILTER, search: 'dienst' })).toBe(true);
  });
});

describe('taskMatchesFilters', () => {
  const task: CockpitTask = {
    id: 'reservationen',
    def: makeDef({ section: 'import', label: 'Reservationen' }),
    section: 'import',
    priority: 'critical',
    timeframe: 'today',
    label: 'Reservationen importieren',
    reason: 'Überfällig',
  };

  it('filtert über Sektion / Priorität / Zeithorizont / Suche', () => {
    expect(taskMatchesFilters(task, EMPTY_TASK_TAB_FILTER)).toBe(true);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, section: 'import' })).toBe(true);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, section: 'control' })).toBe(false);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, priority: 'critical' })).toBe(true);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, priority: 'medium' })).toBe(false);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, timeframe: 'today' })).toBe(true);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, timeframe: 'week' })).toBe(false);
    expect(taskMatchesFilters(task, { ...EMPTY_TASK_TAB_FILTER, search: 'reserv' })).toBe(true);
  });
});

// ─── Anzeige-Maps Vollständigkeit ─────────────────────────────────────────────

describe('Anzeige-Maps sind vollständig', () => {
  it('CONTROL_STATUS-Maps decken alle Status ab', () => {
    for (const s of CONTROL_STATUS_ORDER) {
      expect(CONTROL_STATUS_LABEL[s]).toBeTruthy();
      expect(CONTROL_STATUS_BADGE_CLASS[s]).toBeTruthy();
      expect(CONTROL_STATUS_DOT_CLASS[s]).toBeTruthy();
    }
    expect(CONTROL_STATUS_ORDER).toHaveLength(5);
  });

  it('TASK_PRIORITY-Maps decken alle Prioritäten ab', () => {
    for (const p of TASK_PRIORITY_ORDER) {
      expect(TASK_PRIORITY_LABEL[p]).toBeTruthy();
      expect(TASK_PRIORITY_BADGE_CLASS[p]).toBeTruthy();
      expect(TASK_PRIORITY_DOT_CLASS[p]).toBeTruthy();
    }
  });

  it('TASK_TIMEFRAME + SECTION Labels vollständig', () => {
    for (const t of TASK_TIMEFRAME_ORDER) expect(TASK_TIMEFRAME_LABEL[t]).toBeTruthy();
    expect(SECTION_LABEL.import).toBeTruthy();
    expect(SECTION_LABEL.control).toBeTruthy();
  });
});

// ─── Integration mit den echten COCKPIT_SOURCES ───────────────────────────────

describe('COCKPIT_SOURCES 3-Tab-Konsistenz', () => {
  it('jede Quelle hat section + tabCategory', () => {
    for (const s of COCKPIT_SOURCES) {
      expect(s.section === 'import' || s.section === 'control').toBe(true);
      expect(s.tabCategory).toBeTruthy();
    }
  });

  it('Import-Quellen liegen in IMPORT_CATEGORY_ORDER, Kontrollen in CONTROL_CATEGORY_ORDER', () => {
    for (const s of COCKPIT_SOURCES) {
      if (s.section === 'import') expect(IMPORT_CATEGORY_ORDER).toContain(s.tabCategory);
      else expect(CONTROL_CATEGORY_ORDER).toContain(s.tabCategory);
    }
  });

  it('alle vorkommenden tabCategories haben ein Label', () => {
    for (const s of COCKPIT_SOURCES) expect(TAB_CATEGORY_LABEL[s.tabCategory]).toBeTruthy();
  });

  it('8 Datenimporte + 7 Kontrollen = 15 Quellen', () => {
    const imports = COCKPIT_SOURCES.filter((s) => s.section === 'import');
    const controls = COCKPIT_SOURCES.filter((s) => s.section === 'control');
    expect(imports).toHaveLength(8);
    expect(controls).toHaveLength(7);
  });

  it('jede Kontrolle trägt Verantwortlich / Wichtigkeit / Ablauf', () => {
    for (const s of COCKPIT_SOURCES.filter((x) => x.section === 'control')) {
      expect(s.responsible && s.responsible.length > 0).toBe(true);
      expect(s.importance && s.importance.length > 0).toBe(true);
      expect(s.procedure && s.procedure.length > 0).toBe(true);
    }
  });
});
