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
  importRowMatchesKpi,
  toggleImportKpiFilter,
  importRowMatchesMonth,
  toggleImportMonthFilter,
  buildMonthOverview,
  summarizeImportYear,
  monthKeyOf,
  localTodayIso,
  MONTH_SHORT_LABELS,
  importFileFormats,
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

  it('10 Datenimporte + 8 Kontrollen = 18 Quellen', () => {
    const imports = COCKPIT_SOURCES.filter((s) => s.section === 'import');
    const controls = COCKPIT_SOURCES.filter((s) => s.section === 'control');
    expect(imports).toHaveLength(10);
    expect(controls).toHaveLength(8);
  });

  it('Adyen ist ein monatlicher Datei-Upload-Import mit Route zu den Tagesabschlüssen', () => {
    const def = COCKPIT_SOURCES.find((s) => s.id === 'adyen');
    expect(def).toBeTruthy();
    expect(def!.section).toBe('import');
    expect(def!.tabCategory).toBe('umsatz');
    expect(def!.importType).toBe('file_upload');
    expect(def!.interval).toBe('monthly');
    expect(def!.detectGaps).toBeUndefined();
    expect(def!.checkable).toBe(true);
    expect(def!.route).toBe('/tagesabschluesse');
    expect(def!.actionLabel).toBe('Zu den Tagesabschlüssen');
  });

  it('Umsatzabstimmung (Quelle umsatzabstimmung) ist ein monatlicher manueller Datenimport mit Route', () => {
    const def = COCKPIT_SOURCES.find((s) => s.id === 'umsatzabstimmung');
    expect(def).toBeTruthy();
    expect(def!.section).toBe('import');
    expect(def!.tabCategory).toBe('umsatz');
    expect(def!.importType).toBe('manual_entry');
    expect(def!.interval).toBe('monthly');
    expect(def!.checkable).toBe(true);
    expect(def!.route).toBe('/umsatzabstimmung');
    expect(def!.label).toBe('Umsatzabstimmung');
    expect(def!.actionLabel).toBe('Zur Umsatzabstimmung');
    // Manuelle Eingabe: KEIN Dateiformat erfinden → keine Format-Badges (CSV/Excel/PDF).
    expect(def!.exampleFormat).toBeUndefined();
    expect(importFileFormats(def!)).toEqual([]);
  });

  it('jede Kontrolle trägt Verantwortlich / Wichtigkeit / Ablauf', () => {
    for (const s of COCKPIT_SOURCES.filter((x) => x.section === 'control')) {
      expect(s.responsible && s.responsible.length > 0).toBe(true);
      expect(s.importance && s.importance.length > 0).toBe(true);
      expect(s.procedure && s.procedure.length > 0).toBe(true);
    }
  });
});

// ─── KPI-Kachel-Filter (Datenimporte-Tab) ─────────────────────────────────────

describe('importRowMatchesKpi / toggleImportKpiFilter', () => {
  it('null (kein Kachel-Filter) matcht jede Zeile', () => {
    expect(importRowMatchesKpi(makeRow({}, { status: 'overdue' }), null)).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'current' }), null)).toBe(true);
  });

  it('Status-Kacheln filtern exakt auf den Frische-Status', () => {
    expect(importRowMatchesKpi(makeRow({}, { status: 'current' }), 'current')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'due_soon' }), 'current')).toBe(false);
    expect(importRowMatchesKpi(makeRow({}, { status: 'due_soon' }), 'due_soon')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'overdue' }), 'overdue')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'current' }), 'overdue')).toBe(false);
  });

  it('„Nie / Nicht prüfbar" bündelt never UND uncheckable (wie die Kachel)', () => {
    expect(importRowMatchesKpi(makeRow({}, { status: 'never' }), 'never_uncheckable')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'uncheckable' }), 'never_uncheckable')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'current' }), 'never_uncheckable')).toBe(false);
  });

  it('„Datenlücken" filtert auf missingDays > 0 — unabhängig vom Status', () => {
    expect(importRowMatchesKpi(makeRow({}, { status: 'current', missingDays: ['2026-07-01'] }), 'gaps')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'overdue', missingDays: ['2026-07-01'] }), 'gaps')).toBe(true);
    expect(importRowMatchesKpi(makeRow({}, { status: 'current', missingDays: [] }), 'gaps')).toBe(false);
  });

  it('Toggle: Klick setzt, erneuter Klick auf dieselbe Kachel hebt auf, andere Kachel wechselt', () => {
    expect(toggleImportKpiFilter(null, 'overdue')).toBe('overdue');
    expect(toggleImportKpiFilter('overdue', 'overdue')).toBe(null);
    expect(toggleImportKpiFilter('overdue', 'gaps')).toBe('gaps');
  });

  it('EMPTY_IMPORT_TAB_FILTER hat kpi: null; kpi wird UND-verknüpft mit den übrigen Filtern', () => {
    expect(EMPTY_IMPORT_TAB_FILTER.kpi).toBe(null);
    const row = makeRow({ tabCategory: 'umsatz' }, { status: 'overdue' });
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'overdue' })).toBe(true);
    expect(importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'current' })).toBe(false);
    // UND: Kachel passt, aber anderer Filter schliesst aus
    expect(
      importRowMatchesFilters(row, { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'overdue', interval: 'yearly' }),
    ).toBe(false);
  });
});

// ─── Dateiformate (Import-Art-Spalte) ─────────────────────────────────────────

describe('importFileFormats', () => {
  it('leitet Formate aus exampleFormat-Endungen ab (csv/xls/xlsx/pdf)', () => {
    expect(importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'export.csv' }))).toEqual(['CSV']);
    expect(importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'zeiten.xls / .xlsx' }))).toEqual([
      'Excel',
    ]);
    expect(importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'rechnung_*.pdf' }))).toEqual(['PDF']);
    expect(
      importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'z-bericht_2026-07-06.csv / .pdf' })),
    ).toEqual(['CSV', 'PDF']);
  });

  it('Reihenfolge stabil CSV → Excel → PDF (unabhängig von der Nennung)', () => {
    expect(
      importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'a.pdf / b.xlsx / c.csv' })),
    ).toEqual(['CSV', 'Excel', 'PDF']);
  });

  it('nur Datei-Uploads haben Formate — andere Import-Arten liefern []', () => {
    expect(importFileFormats(makeDef({ importType: 'manual_entry', exampleFormat: 'x.csv' }))).toEqual([]);
    expect(importFileFormats(makeDef({ importType: 'control', exampleFormat: 'x.pdf' }))).toEqual([]);
    expect(importFileFormats(makeDef({ importType: 'not_configured', exampleFormat: 'x.xlsx' }))).toEqual([]);
  });

  it('kein exampleFormat oder keine erkennbare Endung → [] (nichts erfinden)', () => {
    expect(importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: undefined }))).toEqual([]);
    expect(importFileFormats(makeDef({ importType: 'file_upload', exampleFormat: 'irgendein Text' }))).toEqual([]);
  });

  it('echte Quellen: jeder Datei-Upload hat mindestens ein ableitbares Format', () => {
    const uploads = COCKPIT_SOURCES.filter((s) => s.importType === 'file_upload');
    expect(uploads.length).toBeGreaterThan(0);
    for (const s of uploads) {
      expect(importFileFormats(s).length, `Quelle ${s.id} ohne ableitbares Dateiformat`).toBeGreaterThan(0);
    }
  });

  it('echte Quellen: Stichproben (Mirus=Excel, Z-Bericht=CSV+PDF, Rechnungen=PDF)', () => {
    const byId = new Map(COCKPIT_SOURCES.map((s) => [s.id, s]));
    expect(importFileFormats(byId.get('mirus')!)).toEqual(['Excel']);
    expect(importFileFormats(byId.get('zbericht')!)).toEqual(['CSV', 'PDF']);
    expect(importFileFormats(byId.get('warenrechnungen')!)).toEqual(['PDF']);
    expect(importFileFormats(byId.get('reservationen')!)).toEqual(['CSV']);
  });
});

// ─── Monatsübersicht (nutzt das oben deklarierte TODAY = '2026-07-06') ────────

describe('monthKeyOf / localTodayIso / MONTH_SHORT_LABELS', () => {
  it('monthKeyOf polstert einstellige Monate', () => {
    expect(monthKeyOf(2026, 7)).toBe('2026-07');
    expect(monthKeyOf(2026, 11)).toBe('2026-11');
  });
  it('localTodayIso liefert lokales yyyy-MM-dd', () => {
    expect(localTodayIso(new Date(2026, 6, 6))).toBe('2026-07-06');
    expect(localTodayIso(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
  it('12 Monatslabels Jan–Dez', () => {
    expect(MONTH_SHORT_LABELS).toHaveLength(12);
    expect(MONTH_SHORT_LABELS[0]).toBe('Jan');
    expect(MONTH_SHORT_LABELS[11]).toBe('Dez');
  });
});

describe('importRowMatchesMonth', () => {
  it('null = kein Monatsfilter (Ganzes Jahr) matcht immer', () => {
    expect(importRowMatchesMonth(makeRow(), null, TODAY)).toBe(true);
    expect(importRowMatchesMonth(makeRow({}, { status: 'never' }), null, TODAY)).toBe(true);
  });
  it('matcht über den Monat von „Ist-Daten bis"', () => {
    const row = makeRow({}, { status: 'current', latestDataDate: '2026-07-05' });
    expect(importRowMatchesMonth(row, '2026-07', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2026-06', TODAY)).toBe(false);
    expect(importRowMatchesMonth(row, '2025-07', TODAY)).toBe(false);
  });
  it('matcht über Lücken-Tage im Monat (auch wenn Ist-Daten woanders enden)', () => {
    const row = makeRow({}, { status: 'current', latestDataDate: '2026-07-05', missingDays: ['2026-06-29', '2026-06-30'] });
    expect(importRowMatchesMonth(row, '2026-06', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2026-05', TODAY)).toBe(false);
  });
  it('nie importiert matcht jeden nicht-zukünftigen Monat, aber keine Zukunftsmonate', () => {
    const row = makeRow({}, { status: 'never', latestDataDate: null });
    expect(importRowMatchesMonth(row, '2026-01', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2026-07', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2025-12', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2026-08', TODAY)).toBe(false);
  });
  it('uncheckable ohne Datum matcht keinen Monat', () => {
    const row = makeRow({}, { status: 'uncheckable', latestDataDate: null });
    expect(importRowMatchesMonth(row, '2026-07', TODAY)).toBe(false);
  });
});

describe('toggleImportMonthFilter', () => {
  it('setzt, wechselt und hebt per erneutem Klick auf', () => {
    expect(toggleImportMonthFilter(null, '2026-07')).toBe('2026-07');
    expect(toggleImportMonthFilter('2026-07', '2026-08')).toBe('2026-08');
    expect(toggleImportMonthFilter('2026-07', '2026-07')).toBeNull();
  });
});

describe('buildMonthOverview', () => {
  const rows = [
    makeRow({ id: 'zbericht' }, { status: 'current', latestDataDate: '2026-07-05' }),
    makeRow({ id: 'mirus' }, { status: 'overdue', latestDataDate: '2026-06-30' }),
    makeRow({ id: 'inventur' }, { status: 'never', latestDataDate: null }),
    makeRow({ id: 'tagesumsatz' }, { status: 'current', latestDataDate: '2026-07-04', missingDays: ['2026-06-28', '2026-07-01', '2026-07-02'] }),
  ];

  it('liefert 12 Zellen Jan–Dez mit korrekten Keys', () => {
    const cells = buildMonthOverview(rows, 2026, TODAY);
    expect(cells).toHaveLength(12);
    expect(cells[0].key).toBe('2026-01');
    expect(cells[11].key).toBe('2026-12');
  });

  it('zählt aktuell/überfällig über den Monat von „Ist-Daten bis" und Lücken-Tage je Monat', () => {
    const cells = buildMonthOverview(rows, 2026, TODAY);
    const juni = cells[5];
    const juli = cells[6];
    expect(juni.overdue).toBe(1);
    expect(juni.current).toBe(0);
    expect(juni.gapDays).toBe(1);
    expect(juli.current).toBe(2);
    expect(juli.overdue).toBe(0);
    expect(juli.gapDays).toBe(2);
  });

  it('„nie" zählt in jedem nicht-zukünftigen Monat, Zukunftsmonate 0', () => {
    const cells = buildMonthOverview(rows, 2026, TODAY);
    expect(cells[0].never).toBe(1); // Jan
    expect(cells[6].never).toBe(1); // Jul (laufender Monat)
    expect(cells[7].never).toBe(0); // Aug (Zukunft)
    expect(cells[7].isFuture).toBe(true);
    expect(cells[6].isFuture).toBe(false);
  });

  it('hasProblems bei überfällig/nie/Lücken, nicht bei rein aktuell', () => {
    const onlyCurrent = [makeRow({}, { status: 'current', latestDataDate: '2026-07-05' })];
    const cells = buildMonthOverview(onlyCurrent, 2026, TODAY);
    expect(cells[6].hasProblems).toBe(false);
    const withProblems = buildMonthOverview(rows, 2026, TODAY);
    expect(withProblems[5].hasProblems).toBe(true); // Juni: überfällig + Lücke
    expect(withProblems[0].hasProblems).toBe(true); // Jan: nie
  });

  it('Vorjahr: keine Zukunftsmonate, „nie" in allen 12 Monaten', () => {
    const cells = buildMonthOverview(rows, 2025, TODAY);
    expect(cells.every((c) => !c.isFuture)).toBe(true);
    expect(cells.every((c) => c.never === 1)).toBe(true);
    expect(cells.every((c) => c.current === 0 && c.overdue === 0 && c.gapDays === 0)).toBe(true);
  });

  it('Folgejahr: alles Zukunft, keine Nie-Zuordnung', () => {
    const cells = buildMonthOverview(rows, 2027, TODAY);
    expect(cells.every((c) => c.isFuture && c.never === 0)).toBe(true);
  });
});

describe('summarizeImportYear', () => {
  const rows = [
    makeRow({ id: 'zbericht' }, { status: 'current', latestDataDate: '2026-07-05' }),
    makeRow({ id: 'mirus' }, { status: 'overdue', latestDataDate: '2026-06-30' }),
    makeRow({ id: 'inventur' }, { status: 'never', latestDataDate: null }),
    makeRow({ id: 'tagesumsatz' }, { status: 'current', latestDataDate: '2026-07-04', missingDays: ['2025-12-31', '2026-07-01', '2026-07-02'] }),
  ];

  it('zählt Quellen (nicht Monats-Summen) und Lücken-Tage im Jahr', () => {
    const s = summarizeImportYear(rows, 2026, TODAY);
    expect(s).toEqual({ current: 2, overdue: 1, never: 1, gapDays: 2 });
  });

  it('Vorjahr: nur die dortigen Lücken-Tage; nie zählt weiter (fehlt auch dort)', () => {
    const s = summarizeImportYear(rows, 2025, TODAY);
    expect(s).toEqual({ current: 0, overdue: 0, never: 1, gapDays: 1 });
  });

  it('reines Zukunftsjahr: keine Nie-Zählung', () => {
    const s = summarizeImportYear(rows, 2027, TODAY);
    expect(s).toEqual({ current: 0, overdue: 0, never: 0, gapDays: 0 });
  });
});

describe('importRowMatchesFilters — Monatsfilter kombiniert (UND)', () => {
  const overdueJuni = makeRow({ id: 'mirus', tabCategory: 'personal' }, { status: 'overdue', latestDataDate: '2026-06-30' });
  const currentJuli = makeRow({ id: 'zbericht' }, { status: 'current', latestDataDate: '2026-07-05' });

  it('Monatsfilter allein', () => {
    expect(importRowMatchesFilters(overdueJuni, { ...EMPTY_IMPORT_TAB_FILTER, month: '2026-06' }, TODAY)).toBe(true);
    expect(importRowMatchesFilters(currentJuli, { ...EMPTY_IMPORT_TAB_FILTER, month: '2026-06' }, TODAY)).toBe(false);
  });

  it('KPI-Kachel + Monat: Überfällig UND Juni', () => {
    const f = { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'overdue' as const, month: '2026-06' };
    expect(importRowMatchesFilters(overdueJuni, f, TODAY)).toBe(true);
    expect(importRowMatchesFilters(currentJuli, f, TODAY)).toBe(false);
    // gleicher Monat, falsche Kachel
    expect(importRowMatchesFilters(overdueJuni, { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'current' as const, month: '2026-06' }, TODAY)).toBe(false);
  });

  it('month: null (Ganzes Jahr) hebt die Monats-Einschränkung auf', () => {
    const f = { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'overdue' as const, month: null };
    expect(importRowMatchesFilters(overdueJuni, f, TODAY)).toBe(true);
  });
});

// ─── Monatliche manuelle Quelle (Umsatzabstimmung) in der Monatsübersicht ──────

describe('monatliche Quelle mit latestDataDate im Format yyyy-MM (Umsatzabstimmung)', () => {
  const TODAY = '2026-07-06';

  it('zählt in der Monatszelle des gepflegten Monats', () => {
    const row = makeRow(
      { id: 'umsatzabstimmung', importType: 'manual_entry', interval: 'monthly' },
      { status: 'overdue', latestDataDate: '2026-05' },
    );
    const cells = buildMonthOverview([row], 2026, TODAY);
    expect(cells[4].overdue).toBe(1); // Mai
    expect(cells[5].overdue).toBe(0); // Juni leer
    expect(summarizeImportYear([row], 2026, TODAY).overdue).toBe(1);
  });

  it('matcht den Monatsfilter des gepflegten Monats (UND mit KPI-Kachel)', () => {
    const row = makeRow(
      { id: 'umsatzabstimmung', importType: 'manual_entry', interval: 'monthly' },
      { status: 'overdue', latestDataDate: '2026-05' },
    );
    expect(importRowMatchesMonth(row, '2026-05', TODAY)).toBe(true);
    expect(importRowMatchesMonth(row, '2026-06', TODAY)).toBe(false);
    const f = { ...EMPTY_IMPORT_TAB_FILTER, kpi: 'overdue' as const, month: '2026-05' };
    expect(importRowMatchesFilters(row, f, TODAY)).toBe(true);
  });

  it('nie gepflegt → never zählt in jedem nicht-zukünftigen Monat', () => {
    const row = makeRow(
      { id: 'umsatzabstimmung', importType: 'manual_entry', interval: 'monthly' },
      { status: 'never', latestDataDate: null },
    );
    const cells = buildMonthOverview([row], 2026, TODAY);
    expect(cells[6].never).toBe(1); // Juli (laufender Monat)
    expect(cells[7].never).toBe(0); // August (Zukunft)
  });
});
