// @vitest-environment node
/**
 * Tests für die reine Import-Aufgaben-Engine (import-tasks-engine.ts).
 * Deckt alle 10 geforderten Kernfälle der Import-Checkliste ab.
 */
import { describe, it, expect } from 'vitest';
import {
  buildImportTasks,
  buildImportTarget,
  buildFullMonthTask,
  checkImportConflict,
  computeOpenRanges,
  coveredDaysInRange,
  groupImportTasks,
  isOpenTask,
  summarizeImportTasks,
  addDaysIso,
  monthEndIso,
  formatIsoRange,
  type MonthCoverage,
  type TaskPeriod,
} from '../import-tasks-engine';

/** Juli 2026, „heute" = 1. August → alle 31 Tage im Juli erwartbar. */
const JULY: TaskPeriod = { year: 2026, month: 7, today: '2026-08-01' };

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
};

describe('buildImportTasks — tägliche Aufgaben', () => {
  it('erzeugt für Z-Bericht eine Aufgabe pro Kalendertag; importierte Tage sind erledigt', () => {
    const coverage: MonthCoverage = {
      zbericht: { coveredDays: ['2026-07-01', '2026-07-02'] },
    };
    const tasks = buildImportTasks(JULY, coverage).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(31);
    expect(tasks[0]).toMatchObject({ from: '2026-07-01', status: 'done', label: 'Z-Bericht 01.07.2026' });
    expect(tasks[1].status).toBe('done');
    expect(tasks[2]).toMatchObject({ from: '2026-07-03', status: 'open', label: 'Z-Bericht 03.07.2026' });
    expect(tasks.filter(t => t.status === 'open')).toHaveLength(29);
  });

  it('erzeugt für Foratable tägliche Aufgaben, die nach Import des Tages verschwinden (done)', () => {
    const before = buildImportTasks(JULY, { reservationen: { coveredDays: [] } })
      .filter(t => t.type === 'reservationen');
    expect(before.every(t => t.status === 'open')).toBe(true);

    const after = buildImportTasks(JULY, { reservationen: { coveredDays: ['2026-07-04'] } })
      .filter(t => t.type === 'reservationen');
    const day4 = after.find(t => t.from === '2026-07-04');
    expect(day4?.status).toBe('done');
    expect(after.filter(t => t.status === 'open')).toHaveLength(30);
  });

  it('deckelt tägliche Aufgaben im laufenden Monat auf gestern (keine Zukunfts-Aufgaben)', () => {
    const midMonth: TaskPeriod = { year: 2026, month: 7, today: '2026-07-10' };
    const tasks = buildImportTasks(midMonth, {}).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(9); // 01.–09.07.
    expect(tasks[tasks.length - 1].from).toBe('2026-07-09');
  });
});

describe('buildImportTasks — Zeitraum-Aufgaben (Teilzeitraum-Logik)', () => {
  it('erzeugt ohne Abdeckung EINE offene Zeitraum-Aufgabe 01.07.–31.07.', () => {
    const tasks = buildImportTasks(JULY, {}).filter(t => t.type === 'umsatz');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      from: '2026-07-01',
      to: '2026-07-31',
      status: 'open',
      label: 'Umsatz 01.07.–31.07.2026',
    });
  });

  it('Teilimport 01.07.–08.07. erzeugt Rest 09.07.–31.07. mit Status teilweise', () => {
    const coverage: MonthCoverage = { umsatz: { coveredDays: days('2026-07-01', '2026-07-08') } };
    const tasks = buildImportTasks(JULY, coverage).filter(t => t.type === 'umsatz');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      from: '2026-07-09',
      to: '2026-07-31',
      status: 'partial',
      label: 'Umsatz 09.07.–31.07.2026',
      coveredDayCount: 8,
      expectedDayCount: 31,
    });
  });

  it('mehrere Teilimporte erzeugen den korrekten Rest (16.07.–31.07.)', () => {
    const coverage: MonthCoverage = {
      verkaufsdaten: {
        coveredDays: [...days('2026-07-01', '2026-07-08'), ...days('2026-07-09', '2026-07-15')],
      },
    };
    const tasks = buildImportTasks(JULY, coverage).filter(t => t.type === 'verkaufsdaten');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ from: '2026-07-16', to: '2026-07-31', status: 'partial' });
  });

  it('nicht zusammenhängende Teilimporte erzeugen mehrere Rest-Aufgaben', () => {
    const coverage: MonthCoverage = { mirus: { coveredDays: days('2026-07-10', '2026-07-15') } };
    const tasks = buildImportTasks(JULY, coverage).filter(t => t.type === 'mirus');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ from: '2026-07-01', to: '2026-07-09', status: 'partial' });
    expect(tasks[1]).toMatchObject({ from: '2026-07-16', to: '2026-07-31', status: 'partial' });
  });

  it('Monatsimport erledigt den ganzen Monat (eine erledigte Aufgabe, nichts offen)', () => {
    const coverage: MonthCoverage = { umsatz: { coveredDays: days('2026-07-01', '2026-07-31') } };
    const tasks = buildImportTasks(JULY, coverage).filter(t => t.type === 'umsatz');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ from: '2026-07-01', to: '2026-07-31', status: 'done' });
  });
});

describe('buildImportTasks — monatliche und jährliche Aufgaben', () => {
  it('Erfolgsrechnung: eine Monatsaufgabe, erledigt nach Import', () => {
    const open = buildImportTasks(JULY, {}).find(t => t.type === 'erfolgsrechnung');
    expect(open).toMatchObject({
      status: 'open',
      label: 'Erfolgsrechnung / Kontoblätter Juli 2026',
      from: '2026-07-01',
      to: '2026-07-31',
    });
    const done = buildImportTasks(JULY, { erfolgsrechnung: { monthDone: true } })
      .find(t => t.type === 'erfolgsrechnung');
    expect(done?.status).toBe('done');
  });

  it('markiert Monatsaufgaben des laufenden Monats als noch nicht fällig', () => {
    const midMonth: TaskPeriod = { year: 2026, month: 7, today: '2026-07-10' };
    const task = buildImportTasks(midMonth, {}).find(t => t.type === 'istkosten');
    expect(task?.status).toBe('open');
    expect(task?.notYetDue).toBe(true);
    const past = buildImportTasks(JULY, {}).find(t => t.type === 'istkosten');
    expect(past?.notYetDue).toBe(false);
  });

  it('Budget: eine Jahresaufgabe, erledigt nach Jahresimport', () => {
    const open = buildImportTasks(JULY, {}).find(t => t.type === 'budget');
    expect(open).toMatchObject({ status: 'open', label: 'Budget 2026', from: '2026-01-01', to: '2026-12-31' });
    const done = buildImportTasks(JULY, { budget: { yearDone: true } }).find(t => t.type === 'budget');
    expect(done?.status).toBe('done');
  });
});

describe('Konflikt-Erkennung', () => {
  it('meldet Konflikt, wenn der Zielzeitraum bereits (teilweise) importiert wurde', () => {
    const coverage: MonthCoverage = { umsatz: { coveredDays: days('2026-07-01', '2026-07-08') } };
    const conflict = checkImportConflict(
      { type: 'umsatz', frequency: 'range', from: '2026-07-05', to: '2026-07-12' },
      coverage,
    );
    expect(conflict.hasConflict).toBe(true);
    expect(conflict.coveredDays).toEqual(days('2026-07-05', '2026-07-08'));

    const none = checkImportConflict(
      { type: 'umsatz', frequency: 'range', from: '2026-07-09', to: '2026-07-12' },
      coverage,
    );
    expect(none.hasConflict).toBe(false);
  });

  it('meldet Konflikt bei bereits importiertem Monat/Jahr (monthly/yearly)', () => {
    const coverage: MonthCoverage = { erfolgsrechnung: { monthDone: true }, budget: { yearDone: false } };
    expect(checkImportConflict(
      { type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' },
      coverage,
    ).hasConflict).toBe(true);
    expect(checkImportConflict(
      { type: 'budget', frequency: 'yearly', from: '2026-01-01', to: '2026-12-31' },
      coverage,
    ).hasConflict).toBe(false);
  });
});

describe('Offen/Erledigt-Sicht', () => {
  it('erledigte Aufgaben verschwinden aus der Offen-Ansicht (isOpenTask)', () => {
    const coverage: MonthCoverage = {
      zbericht: { coveredDays: days('2026-07-01', '2026-07-31') },
      umsatz: { coveredDays: days('2026-07-01', '2026-07-31') },
      erfolgsrechnung: { monthDone: true },
      budget: { yearDone: true },
    };
    const tasks = buildImportTasks(JULY, coverage);
    const open = tasks.filter(isOpenTask);
    expect(open.some(t => t.type === 'zbericht')).toBe(false);
    expect(open.some(t => t.type === 'umsatz')).toBe(false);
    expect(open.some(t => t.type === 'erfolgsrechnung')).toBe(false);
    expect(open.some(t => t.type === 'budget')).toBe(false);
    // Nicht abgedeckte Typen bleiben offen:
    expect(open.some(t => t.type === 'reservationen')).toBe(true);
    expect(open.some(t => t.type === 'istkosten')).toBe(true);
  });

  it('Coverage-Fehler wird als sichtbare Fehler-Aufgabe ausgewiesen (kein stilles Verschlucken)', () => {
    const tasks = buildImportTasks(JULY, { mirus: { error: 'DB nicht erreichbar' } });
    const mirus = tasks.filter(t => t.type === 'mirus');
    expect(mirus).toHaveLength(1);
    expect(mirus[0].status).toBe('error');
    expect(mirus[0].error).toBe('DB nicht erreichbar');
    expect(isOpenTask(mirus[0])).toBe(true);
  });

  it('gruppiert nach Frequenz und zählt KPIs korrekt', () => {
    const coverage: MonthCoverage = { zbericht: { coveredDays: days('2026-07-01', '2026-07-30') } };
    const tasks = buildImportTasks(JULY, coverage);
    const groups = groupImportTasks(tasks);
    expect(groups.daily.length).toBe(62);   // 31 zbericht + 31 reservationen
    expect(groups.range.length).toBe(4);    // umsatz/verkaufsdaten/mirus/marketing je 1
    expect(groups.monthly.length).toBe(2);
    expect(groups.yearly.length).toBe(1);
    const kpis = summarizeImportTasks(groups.daily);
    expect(kpis.done).toBe(30);
    expect(kpis.open).toBe(32);
  });
});

describe('buildImportTarget — Prefill-Navigation', () => {
  it('Tagesaufgabe Z-Bericht verweist mit exakt diesem Tag auf den Gastronovi-Import', () => {
    const target = buildImportTarget({
      type: 'zbericht', frequency: 'daily', from: '2026-07-04', to: '2026-07-04',
    });
    expect(target.path).toBe('/gastronovi-import');
    expect(target.params).toEqual({ from: '2026-07-04', to: '2026-07-04', scope: 'day' });
    expect(target.href).toBe('/gastronovi-import?from=2026-07-04&to=2026-07-04&scope=day');
  });

  it('Zeitraum-, Monats- und Jahresaufgaben zielen auf die richtigen Routen', () => {
    expect(buildImportTarget({ type: 'umsatz', frequency: 'range', from: '2026-07-09', to: '2026-07-31' }))
      .toMatchObject({ path: '/import', params: expect.objectContaining({ target: 'tagesumsatz', scope: 'range' }) });
    expect(buildImportTarget({ type: 'verkaufsdaten', frequency: 'range', from: '2026-07-01', to: '2026-07-31' }).path)
      .toBe('/sales-upload');
    expect(buildImportTarget({ type: 'mirus', frequency: 'range', from: '2026-07-01', to: '2026-07-31' }).params.target)
      .toBe('mirus');
    expect(buildImportTarget({ type: 'marketing', frequency: 'range', from: '2026-07-01', to: '2026-07-31' }).params.target)
      .toBe('maison');
    expect(buildImportTarget({ type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }))
      .toMatchObject({ path: '/reporting', params: { target: 'erfolgsrechnung', year: '2026', month: '7' } });
    expect(buildImportTarget({ type: 'budget', frequency: 'yearly', from: '2026-01-01', to: '2026-12-31' }))
      .toMatchObject({ path: '/budget', params: { year: '2026' } });
  });

  it('buildFullMonthTask liefert „Ganzen Monat importieren"-Kontext', () => {
    const full = buildFullMonthTask('umsatz', { year: 2026, month: 7 });
    expect(full).toMatchObject({ from: '2026-07-01', to: '2026-07-31', label: 'Umsatz Juli 2026' });
  });
});

describe('Datums-Helfer', () => {
  it('computeOpenRanges/coveredDaysInRange arbeiten korrekt an Rändern', () => {
    expect(computeOpenRanges('2026-07-01', '2026-07-05', days('2026-07-01', '2026-07-05'))).toEqual([]);
    expect(computeOpenRanges('2026-07-05', '2026-07-01', [])).toEqual([]);
    expect(computeOpenRanges('2026-07-01', '2026-07-05', ['2026-07-03']))
      .toEqual([
        { from: '2026-07-01', to: '2026-07-02' },
        { from: '2026-07-04', to: '2026-07-05' },
      ]);
    expect(coveredDaysInRange('2026-07-02', '2026-07-04', ['2026-07-01', '2026-07-04', '2026-07-05']))
      .toEqual(['2026-07-04']);
    expect(monthEndIso(2026, 2)).toBe('2026-02-28');
    expect(monthEndIso(2024, 2)).toBe('2024-02-29');
    expect(formatIsoRange('2026-07-09', '2026-07-31')).toBe('09.07.–31.07.2026');
    expect(formatIsoRange('2026-07-09', '2026-07-09')).toBe('09.07.2026');
  });
});
