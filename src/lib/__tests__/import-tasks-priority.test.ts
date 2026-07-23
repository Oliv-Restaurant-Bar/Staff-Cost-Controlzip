// @vitest-environment node
/**
 * Tests import-tasks-priority.ts — Fälligkeit, Priorisierung,
 * Monatsfortschritt/Abschluss-Status und Typ-Zusammenfassung.
 * Rein synthetische Aufgaben (Engine-Format), kein DOM/Supabase.
 */
import { describe, it, expect } from 'vitest';
import type { ImportTask } from '../import-tasks-engine';
import { buildImportTasks } from '../import-tasks-engine';
import { defaultImportSettings } from '../import-settings';
import {
  getTaskDueInfo,
  prioritizeTasks,
  getTodayTasks,
  computeMonthProgress,
  summarizeTypeCompletion,
  mergeOpenRanges,
  monthKey,
  CLOSURE_LABEL,
} from '../import-tasks-priority';

const TODAY = '2026-07-09';

function task(partial: Partial<ImportTask>): ImportTask {
  return {
    id: partial.id ?? `${partial.type ?? 'zbericht'}:${partial.from ?? '2026-07-01'}`,
    type: partial.type ?? 'zbericht',
    frequency: partial.frequency ?? 'daily',
    label: partial.label ?? 'Test',
    from: partial.from ?? '2026-07-01',
    to: partial.to ?? partial.from ?? '2026-07-01',
    status: partial.status ?? 'open',
    ...partial,
  };
}

describe('getTaskDueInfo — Fälligkeits-Semantik (Tag X ab X+1 importierbar)', () => {
  it('Tagesaufgabe für gestern ist HEUTE fällig', () => {
    const due = getTaskDueInfo(task({ from: '2026-07-08', to: '2026-07-08' }), TODAY);
    expect(due.urgency).toBe('today');
    expect(due.dueLabel).toBe('Heute erledigen');
    expect(due.daysOverdue).toBe(0);
  });

  it('Tagesaufgabe für vorgestern ist 1 Tag überfällig', () => {
    const due = getTaskDueInfo(task({ from: '2026-07-07', to: '2026-07-07' }), TODAY);
    expect(due.urgency).toBe('overdue');
    expect(due.dueLabel).toBe('1 Tag überfällig');
    expect(due.daysOverdue).toBe(1);
  });

  it('ältere Tagesaufgabe zählt Mehrzahl-Tage überfällig', () => {
    const due = getTaskDueInfo(task({ from: '2026-07-04', to: '2026-07-04' }), TODAY);
    expect(due.dueLabel).toBe('4 Tage überfällig');
    expect(due.daysOverdue).toBe(4);
  });

  it('erledigte Aufgaben haben keine Fälligkeit', () => {
    const due = getTaskDueInfo(task({ from: '2026-07-01', status: 'done' }), TODAY);
    expect(due.urgency).toBe('later');
    expect(due.dueLabel).toBeNull();
  });

  it('Wochen-Aufgabe: fällig ab dem Montag nach ihrem Sonntag', () => {
    const over = getTaskDueInfo(
      task({ frequency: 'weekly', type: 'reservationen', from: '2026-06-29', to: '2026-07-05' }),
      TODAY,
    );
    expect(over.urgency).toBe('overdue');
    expect(over.dueLabel).toBe('3 Tage überfällig');
    expect(over.daysOverdue).toBe(3);

    const heute = getTaskDueInfo(
      task({ frequency: 'weekly', type: 'reservationen', from: '2026-07-02', to: '2026-07-08' }),
      TODAY,
    );
    expect(heute.urgency).toBe('today');
    expect(heute.dueLabel).toBe('Heute erledigen');
  });

  it('Monatsaufgabe: im laufenden Monat später, danach „Monatsimport noch offen"', () => {
    const laufend = getTaskDueInfo(
      task({ frequency: 'monthly', from: '2026-07-01', to: '2026-07-31', type: 'erfolgsrechnung' }),
      TODAY,
    );
    expect(laufend.urgency).toBe('later');
    const vorbei = getTaskDueInfo(
      task({ frequency: 'monthly', from: '2026-06-01', to: '2026-06-30', type: 'erfolgsrechnung' }),
      TODAY,
    );
    expect(vorbei.urgency).toBe('overdue');
    expect(vorbei.dueLabel).toBe('Monatsimport noch offen');
  });

  it('unterdrückte Aufgaben mahnen NIE (Wartet auf Basis-Quelle)', () => {
    const due = getTaskDueInfo(
      task({ type: 'tagesabschluss', from: '2026-07-02', to: '2026-07-02', suppressedBy: 'zbericht' }),
      TODAY,
    );
    expect(due.urgency).toBe('later');
    expect(due.dueLabel).toBe('Wartet auf Z-Bericht');
    expect(due.daysOverdue).toBe(0);
  });
});

describe('prioritizeTasks / getTodayTasks', () => {
  it('sortiert Fehler → überfällig (älteste zuerst) → heute → später', () => {
    const tasks = [
      task({ id: 'a', from: '2026-07-08', to: '2026-07-08' }), // heute fällig
      task({ id: 'b', from: '2026-07-05', to: '2026-07-05' }), // überfällig
      task({
        id: 'c', type: 'erfolgsrechnung', frequency: 'monthly',
        from: '2026-07-01', to: '2026-07-31',
      }), // später (Monat läuft)
      task({ id: 'err', status: 'error', from: '2026-07-01' }),
      task({ id: 'd', from: '2026-07-02', to: '2026-07-02' }), // am längsten überfällig
    ];
    const order = prioritizeTasks(tasks, TODAY).map((p) => p.task.id);
    expect(order).toEqual(['err', 'd', 'b', 'a', 'c']);
  });

  it('getTodayTasks liefert nur überfällig/heute/Fehler — keine erledigten, späteren oder unterdrückten', () => {
    const tasks = [
      task({ id: 'done', status: 'done', from: '2026-07-01' }),
      task({ id: 'later', type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }),
      task({ id: 'due', from: '2026-07-08', to: '2026-07-08' }),
      task({ id: 'over', from: '2026-07-03', to: '2026-07-03' }),
      task({ id: 'wait', type: 'tagesabschluss', from: '2026-07-03', to: '2026-07-03', suppressedBy: 'zbericht' }),
    ];
    const ids = getTodayTasks(tasks, TODAY).map((p) => p.task.id);
    expect(ids).toEqual(['over', 'due']);
  });
});

describe('computeMonthProgress — Nenner ohne „später"-Aufgaben', () => {
  it('laufender Monat kann 100 % fällige Aufgaben erreichen, ist aber nicht complete', () => {
    const tasks = [
      task({ id: '1', status: 'done', from: '2026-07-01' }),
      task({ id: '2', status: 'done', from: '2026-07-02' }),
      // Monatsaufgabe läuft noch → zählt nicht zum Nenner
      task({ frequency: 'monthly', type: 'erfolgsrechnung', from: '2026-07-01', to: '2026-07-31' }),
    ];
    const p = computeMonthProgress(tasks, { year: 2026, month: 7, today: TODAY });
    expect(p.total).toBe(2);
    expect(p.done).toBe(2);
    expect(p.percent).toBe(100);
    expect(p.laterOpen).toBe(1);
    expect(p.allDone).toBe(false);
    expect(p.closure).toBe('almost');
  });

  it('unterdrückte Aufgaben zählen nicht zum Nenner (Basis-Quelle zählt bereits)', () => {
    const tasks = [
      task({ id: '1', status: 'done', from: '2026-07-01' }),
      task({ id: 'wait', type: 'tagesabschluss', from: '2026-07-02', to: '2026-07-02', suppressedBy: 'zbericht' }),
    ];
    const p = computeMonthProgress(tasks, { year: 2026, month: 7, today: TODAY });
    expect(p.total).toBe(1);
    expect(p.laterOpen).toBe(1);
    expect(p.percent).toBe(100);
  });

  it('abgeschlossener Monat mit allem erledigt ist complete', () => {
    const tasks = [
      task({ id: '1', status: 'done', from: '2026-06-05' }),
      task({ frequency: 'monthly', type: 'erfolgsrechnung', status: 'done', from: '2026-06-01', to: '2026-06-30' }),
    ];
    const p = computeMonthProgress(tasks, { year: 2026, month: 6, today: TODAY });
    expect(p.allDone).toBe(true);
    expect(p.closure).toBe('complete');
    expect(CLOSURE_LABEL[p.closure]).toBe('Vollständig abgeschlossen');
  });

  it('Fehler zählen als fällige offene Aufgaben und verhindern complete', () => {
    const tasks = [
      task({ id: '1', status: 'done', from: '2026-06-05' }),
      task({ id: 'err', status: 'error', from: '2026-06-01', to: '2026-06-30' }),
    ];
    const p = computeMonthProgress(tasks, { year: 2026, month: 6, today: TODAY });
    expect(p.errors).toBe(1);
    expect(p.allDone).toBe(false);
    expect(p.closure).not.toBe('complete');
  });

  it('keine Aufgaben oder nichts erledigt → not_started', () => {
    expect(computeMonthProgress([], { year: 2026, month: 8, today: TODAY }).closure).toBe('not_started');
    const p = computeMonthProgress(
      [task({ id: '1', from: '2026-06-05' })],
      { year: 2026, month: 6, today: TODAY },
    );
    expect(p.closure).toBe('not_started');
    expect(p.percent).toBe(0);
  });

  it('Schwellen: ≥80 % fast abgeschlossen, darunter teilweise', () => {
    const mk = (doneCount: number, openCount: number) => {
      const tasks: ImportTask[] = [];
      for (let i = 0; i < doneCount; i++) tasks.push(task({ id: `d${i}`, status: 'done', from: '2026-06-05' }));
      for (let i = 0; i < openCount; i++) tasks.push(task({ id: `o${i}`, from: '2026-06-06' }));
      return computeMonthProgress(tasks, { year: 2026, month: 6, today: TODAY });
    };
    expect(mk(8, 2).closure).toBe('almost');
    expect(mk(4, 6).closure).toBe('partial');
  });

  it('integriert mit der Engine: voll abgedeckter Juni ist complete', () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
    const tasks = buildImportTasks(
      { year: 2026, month: 6, today: TODAY },
      {
        zbericht: { coveredDays: days },
        gaeste_bon: { coveredDays: days },
        mirus: { coveredDays: days },
        tagesabschluss: { coveredDays: days },
        reservationen: { coveredDays: days },
        erfolgsrechnung: { monthDone: true },
        warenrechnungen: { monthDone: true },
        inventur: { monthDone: true },
      },
      defaultImportSettings(),
    );
    const p = computeMonthProgress(tasks, { year: 2026, month: 6, today: TODAY });
    expect(p.allDone).toBe(true);
    expect(p.closure).toBe('complete');
    expect(p.percent).toBe(100);
  });
});

describe('summarizeTypeCompletion', () => {
  it('meldet vollständige, offene (mit gemergten Zeiträumen) und Fehler-Typen', () => {
    const tasks = [
      task({ id: 'z1', status: 'done', from: '2026-06-01' }),
      // Reservationen: zwei benachbarte offene Wochen → EIN Bereich
      task({ id: 'r1', type: 'reservationen', frequency: 'weekly', from: '2026-06-15', to: '2026-06-21' }),
      task({ id: 'r2', type: 'reservationen', frequency: 'weekly', from: '2026-06-22', to: '2026-06-28' }),
      task({ id: 'e1', type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-06-01', to: '2026-06-30' }),
      task({ id: 'm1', type: 'mirus', status: 'error', error: 'DB weg', from: '2026-06-01', to: '2026-06-30' }),
    ];
    const summary = summarizeTypeCompletion(tasks, TODAY);
    const byType = Object.fromEntries(summary.map((s) => [s.type, s]));
    expect(byType.zbericht.status).toBe('done');
    expect(byType.reservationen.status).toBe('open');
    expect(byType.reservationen.detail).toBe('15.06.–28.06.2026');
    expect(byType.reservationen.openDayCount).toBe(14);
    expect(byType.erfolgsrechnung.status).toBe('open');
    expect(byType.erfolgsrechnung.detail).toBe('fehlt');
    expect(byType.mirus.status).toBe('error');
    expect(byType.mirus.detail).toBe('DB weg');
  });

  it('laufende Monatsaufgabe erscheint als „later", nicht als offen', () => {
    const tasks = [
      task({ id: 'e1', type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }),
    ];
    const summary = summarizeTypeCompletion(tasks, TODAY);
    expect(summary[0].status).toBe('later');
  });

  it('nur unterdrückte offene Aufgaben ⇒ „later" mit Warte-Hinweis', () => {
    const tasks = [
      task({ id: 't1', type: 'tagesabschluss', from: '2026-07-02', to: '2026-07-02', suppressedBy: 'zbericht' }),
    ];
    const summary = summarizeTypeCompletion(tasks, TODAY);
    expect(summary[0].status).toBe('later');
    expect(summary[0].detail).toBe('Wartet auf Z-Bericht');
  });

  it('Typen ohne Aufgaben (bei_bedarf/deaktiviert) erscheinen nicht', () => {
    const summary = summarizeTypeCompletion([task({ id: 'z1', from: '2026-07-01' })], TODAY);
    expect(summary.map((s) => s.type)).toEqual(['zbericht']);
  });

  it('mergeOpenRanges fasst benachbarte Zeiträume zusammen', () => {
    expect(mergeOpenRanges([
      { from: '2026-07-01', to: '2026-07-03' },
      { from: '2026-07-04', to: '2026-07-05' },
      { from: '2026-07-08', to: '2026-07-08' },
    ])).toEqual([
      { from: '2026-07-01', to: '2026-07-05' },
      { from: '2026-07-08', to: '2026-07-08' },
    ]);
  });
});

describe('monthKey', () => {
  it('liefert zero-padded yyyy-MM', () => {
    expect(monthKey(2026, 7)).toBe('2026-07');
    expect(monthKey(2026, 11)).toBe('2026-11');
  });
});
