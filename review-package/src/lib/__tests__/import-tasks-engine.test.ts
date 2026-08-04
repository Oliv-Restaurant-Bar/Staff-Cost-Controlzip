// @vitest-environment node
/**
 * Tests für die reine Import-Aufgaben-Engine (import-tasks-engine.ts) —
 * neue Import-Strategie: Aufgaben entstehen aus den effektiven Einstellungen
 * (Frequenz/Karenz/Ruhetage), Abhängigkeits-Unterdrückung (tagesabschluss ←
 * zbericht) und Tages-/Monats-Abdeckung.
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
  isoWeekday,
  type ImportTaskType,
  type MonthCoverage,
  type TaskPeriod,
} from '../import-tasks-engine';
import {
  defaultImportSettings,
  type EffectiveImportSettings,
  type ImportFrequencySetting,
} from '../import-settings';

/** Juli 2026, „heute" = 1. August → alle 31 Tage im Juli erwartbar. */
const JULY: TaskPeriod = { year: 2026, month: 7, today: '2026-08-01' };

const DEFAULTS = defaultImportSettings();

/** Default-Einstellungen mit einer Typ-Abweichung (rein, ohne Blob-Umweg). */
const withType = (
  type: ImportTaskType,
  frequency: ImportFrequencySetting,
  delayDays = 0,
): EffectiveImportSettings => ({
  ...DEFAULTS,
  types: { ...DEFAULTS.types, [type]: { frequency, delayDays } },
});

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
    const tasks = buildImportTasks(JULY, coverage, DEFAULTS).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(31);
    expect(tasks[0]).toMatchObject({ from: '2026-07-01', status: 'done', label: 'Z-Bericht 01.07.2026' });
    expect(tasks[1].status).toBe('done');
    expect(tasks[2]).toMatchObject({ from: '2026-07-03', status: 'open', label: 'Z-Bericht 03.07.2026' });
    expect(tasks.filter(t => t.status === 'open')).toHaveLength(29);
  });

  it('deckelt tägliche Aufgaben im laufenden Monat auf gestern (keine Zukunfts-Aufgaben)', () => {
    const midMonth: TaskPeriod = { year: 2026, month: 7, today: '2026-07-10' };
    const tasks = buildImportTasks(midMonth, {}, DEFAULTS).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(9); // 01.–09.07.
    expect(tasks[tasks.length - 1].from).toBe('2026-07-09');
  });

  it('Karenztage verschieben die Fälligkeit (Mirus-Default: 2 Tage)', () => {
    const tasks = buildImportTasks(JULY, {}, DEFAULTS).filter(t => t.type === 'mirus');
    // heute 01.08. − 1 − 2 Karenztage ⇒ letzte erwartete Aufgabe 29.07.
    expect(tasks).toHaveLength(29);
    expect(tasks[tasks.length - 1].from).toBe('2026-07-29');
  });

  it('Ruhetage erzeugen NIE erwartete Tagesaufgaben', () => {
    const settings: EffectiveImportSettings = { ...DEFAULTS, restWeekdays: [1] }; // Montag
    const tasks = buildImportTasks(JULY, {}, settings).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(27); // 31 − 4 Montage (6./13./20./27.07.)
    expect(tasks.every(t => isoWeekday(t.from) !== 1)).toBe(true);
  });
});

describe('buildImportTasks — wöchentliche Aufgaben (Foratable-Default)', () => {
  it('erzeugt eine Aufgabe pro abgeschlossener ISO-Woche (Sonntag im Monat)', () => {
    const tasks = buildImportTasks(JULY, {}, DEFAULTS).filter(t => t.type === 'reservationen');
    // Sonntage im Juli 2026: 05./12./19./26.07.
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatchObject({
      frequency: 'weekly',
      from: '2026-06-29',
      to: '2026-07-05',
      status: 'open',
      expectedDayCount: 7,
    });
    expect(tasks[0].label).toContain('KW');
  });

  it('teilweise/ganz abgedeckte Wochen werden partial/done (inkl. Vormonatstage)', () => {
    const coverage: MonthCoverage = {
      reservationen: { coveredDays: days('2026-06-29', '2026-07-05') },
    };
    const tasks = buildImportTasks(JULY, coverage, DEFAULTS).filter(t => t.type === 'reservationen');
    expect(tasks[0].status).toBe('done');
    expect(tasks[1].status).toBe('open');

    const partial = buildImportTasks(
      JULY,
      { reservationen: { coveredDays: ['2026-07-01', '2026-07-02'] } },
      DEFAULTS,
    ).filter(t => t.type === 'reservationen');
    expect(partial[0]).toMatchObject({ status: 'partial', coveredDayCount: 2 });
  });

  it('laufende Wochen erzeugen KEINE Aufgabe (erst nach dem Sonntag)', () => {
    const midMonth: TaskPeriod = { year: 2026, month: 7, today: '2026-07-10' };
    const tasks = buildImportTasks(midMonth, {}, DEFAULTS).filter(t => t.type === 'reservationen');
    expect(tasks).toHaveLength(1); // nur KW mit Sonntag 05.07. (≤ gestern)
    expect(tasks[0].to).toBe('2026-07-05');
  });
});

describe('buildImportTasks — monatliche Aufgaben', () => {
  it('Tages-Quelle mit Frequenz monatlich: EINE Monatsaufgabe mit Tages-Fortschritt', () => {
    const settings = withType('zbericht', 'monatlich');
    const coverage: MonthCoverage = { zbericht: { coveredDays: days('2026-07-01', '2026-07-08') } };
    const tasks = buildImportTasks(JULY, coverage, settings).filter(t => t.type === 'zbericht');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      frequency: 'monthly',
      from: '2026-07-01',
      to: '2026-07-31',
      status: 'partial',
      coveredDayCount: 8,
      expectedDayCount: 31,
      label: 'Z-Bericht Juli 2026',
    });
  });

  it('Monats-Quelle Erfolgsrechnung: offen → erledigt über monthDone', () => {
    const open = buildImportTasks(JULY, {}, DEFAULTS).find(t => t.type === 'erfolgsrechnung');
    expect(open).toMatchObject({
      status: 'open',
      frequency: 'monthly',
      from: '2026-07-01',
      to: '2026-07-31',
      notYetDue: false,
    });
    const done = buildImportTasks(JULY, { erfolgsrechnung: { monthDone: true } }, DEFAULTS)
      .find(t => t.type === 'erfolgsrechnung');
    expect(done?.status).toBe('done');
  });

  it('markiert Monatsaufgaben des laufenden Monats als noch nicht fällig', () => {
    const midMonth: TaskPeriod = { year: 2026, month: 7, today: '2026-07-10' };
    const task = buildImportTasks(midMonth, {}, DEFAULTS).find(t => t.type === 'warenrechnungen');
    expect(task?.status).toBe('open');
    expect(task?.notYetDue).toBe(true);
    const past = buildImportTasks(JULY, {}, DEFAULTS).find(t => t.type === 'warenrechnungen');
    expect(past?.notYetDue).toBe(false);
  });

  it('Inventur ist eine Monats-Quelle (manuelles Häkchen = monthDone)', () => {
    const open = buildImportTasks(JULY, {}, DEFAULTS).find(t => t.type === 'inventur');
    expect(open?.status).toBe('open');
    const done = buildImportTasks(JULY, { inventur: { monthDone: true } }, DEFAULTS)
      .find(t => t.type === 'inventur');
    expect(done?.status).toBe('done');
  });
});

describe('buildImportTasks — Frequenzen bei_bedarf/deaktiviert', () => {
  it('marketing (Default bei_bedarf) erzeugt NIE Aufgaben', () => {
    expect(buildImportTasks(JULY, {}, DEFAULTS).some(t => t.type === 'marketing')).toBe(false);
  });

  it('deaktivierte Typen erzeugen keine Aufgaben (auch ohne Abdeckung)', () => {
    const settings = withType('zbericht', 'deaktiviert');
    expect(buildImportTasks(JULY, {}, settings).some(t => t.type === 'zbericht')).toBe(false);
  });
});

describe('Abhängigkeits-Unterdrückung (tagesabschluss ← zbericht)', () => {
  it('offene Tagesabschluss-Aufgaben ohne Z-Bericht sind unterdrückt und zählen nicht als offen', () => {
    const coverage: MonthCoverage = { zbericht: { coveredDays: ['2026-07-01'] } };
    const tasks = buildImportTasks(JULY, coverage, DEFAULTS).filter(t => t.type === 'tagesabschluss');
    const day1 = tasks.find(t => t.from === '2026-07-01');
    const day2 = tasks.find(t => t.from === '2026-07-02');
    expect(day1?.suppressedBy).toBeUndefined(); // Z-Bericht vorhanden → Aufgabe aktiv
    expect(day2?.suppressedBy).toBe('zbericht');
    expect(isOpenTask(day1!)).toBe(true);
    expect(isOpenTask(day2!)).toBe(false);
  });

  it('keine Unterdrückung, wenn die Basis-Quelle keine Aufgaben erzeugt (bei_bedarf)', () => {
    const settings = withType('zbericht', 'bei_bedarf');
    const tasks = buildImportTasks(JULY, {}, settings).filter(t => t.type === 'tagesabschluss');
    expect(tasks.every(t => t.suppressedBy === undefined)).toBe(true);
  });
});

describe('Offen/Erledigt-Sicht', () => {
  it('erledigte Aufgaben verschwinden aus der Offen-Ansicht (isOpenTask)', () => {
    const coverage: MonthCoverage = {
      zbericht: { coveredDays: days('2026-07-01', '2026-07-31') },
      tagesabschluss: { coveredDays: days('2026-07-01', '2026-07-31') },
      erfolgsrechnung: { monthDone: true },
    };
    const open = buildImportTasks(JULY, coverage, DEFAULTS).filter(isOpenTask);
    expect(open.some(t => t.type === 'zbericht')).toBe(false);
    expect(open.some(t => t.type === 'tagesabschluss')).toBe(false);
    expect(open.some(t => t.type === 'erfolgsrechnung')).toBe(false);
    // Nicht abgedeckte Typen bleiben offen:
    expect(open.some(t => t.type === 'gaeste_bon')).toBe(true);
    expect(open.some(t => t.type === 'warenrechnungen')).toBe(true);
  });

  it('Coverage-Fehler wird als sichtbare Fehler-Aufgabe ausgewiesen (kein stilles Verschlucken)', () => {
    const tasks = buildImportTasks(JULY, { mirus: { error: 'DB nicht erreichbar' } }, DEFAULTS);
    const mirus = tasks.filter(t => t.type === 'mirus');
    expect(mirus).toHaveLength(1);
    expect(mirus[0].status).toBe('error');
    expect(mirus[0].error).toBe('DB nicht erreichbar');
    expect(isOpenTask(mirus[0])).toBe(true);
  });

  it('gruppiert nach Frequenz und zählt KPIs korrekt', () => {
    const coverage: MonthCoverage = { zbericht: { coveredDays: days('2026-07-01', '2026-07-30') } };
    const tasks = buildImportTasks(JULY, coverage, DEFAULTS);
    const groups = groupImportTasks(tasks);
    // daily: 31 zbericht + 31 gaeste_bon + 29 mirus (Karenz 2) + 31 tagesabschluss
    expect(groups.daily.length).toBe(122);
    expect(groups.weekly.length).toBe(4); // reservationen
    expect(groups.monthly.length).toBe(3); // erfolgsrechnung/warenrechnungen/inventur
    const kpis = summarizeImportTasks(groups.daily.filter(t => t.type === 'zbericht'));
    expect(kpis.done).toBe(30);
    expect(kpis.open).toBe(1);
  });
});

describe('Konflikt-Erkennung', () => {
  it('meldet Konflikt, wenn der Zielzeitraum bereits (teilweise) importiert wurde', () => {
    const coverage: MonthCoverage = { zbericht: { coveredDays: days('2026-07-01', '2026-07-08') } };
    const conflict = checkImportConflict(
      { type: 'zbericht', from: '2026-07-05', to: '2026-07-12' },
      coverage,
    );
    expect(conflict.hasConflict).toBe(true);
    expect(conflict.coveredDays).toEqual(days('2026-07-05', '2026-07-08'));

    const none = checkImportConflict(
      { type: 'zbericht', from: '2026-07-09', to: '2026-07-12' },
      coverage,
    );
    expect(none.hasConflict).toBe(false);
  });

  it('meldet Konflikt bei bereits importiertem Monat (Monats-Quellen)', () => {
    const coverage: MonthCoverage = {
      erfolgsrechnung: { monthDone: true },
      warenrechnungen: { monthDone: false },
    };
    expect(checkImportConflict(
      { type: 'erfolgsrechnung', from: '2026-07-01', to: '2026-07-31' },
      coverage,
    ).hasConflict).toBe(true);
    expect(checkImportConflict(
      { type: 'warenrechnungen', from: '2026-07-01', to: '2026-07-31' },
      coverage,
    ).hasConflict).toBe(false);
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

  it('alle Typen zielen auf die richtigen Routen', () => {
    expect(buildImportTarget({ type: 'gaeste_bon', frequency: 'daily', from: '2026-07-04', to: '2026-07-04' }))
      .toMatchObject({ path: '/gastronovi-import', params: expect.objectContaining({ target: 'kpi' }) });
    expect(buildImportTarget({ type: 'mirus', frequency: 'weekly', from: '2026-06-29', to: '2026-07-05' }).params.target)
      .toBe('mirus');
    expect(buildImportTarget({ type: 'tagesabschluss', frequency: 'daily', from: '2026-07-04', to: '2026-07-04' }))
      .toMatchObject({ path: '/tagesabschluesse', params: { monat: '2026-07' } });
    expect(buildImportTarget({ type: 'marketing', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }).params.target)
      .toBe('maison');
    expect(buildImportTarget({ type: 'reservationen', frequency: 'weekly', from: '2026-06-29', to: '2026-07-05' }).path)
      .toBe('/foratable-import');
    expect(buildImportTarget({ type: 'erfolgsrechnung', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }))
      .toMatchObject({ path: '/reporting', params: { target: 'erfolgsrechnung', year: '2026', month: '7' } });
    expect(buildImportTarget({ type: 'warenrechnungen', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }))
      .toMatchObject({ path: '/warenrechnungen', params: { monat: '2026-07' } });
    expect(buildImportTarget({ type: 'inventur', frequency: 'monthly', from: '2026-07-01', to: '2026-07-31' }))
      .toMatchObject({ path: '/import-cockpit', href: '/import-cockpit' });
  });

  it('buildFullMonthTask liefert „Ganzen Monat importieren"-Kontext', () => {
    const full = buildFullMonthTask('zbericht', { year: 2026, month: 7 });
    expect(full).toMatchObject({ from: '2026-07-01', to: '2026-07-31', label: 'Z-Bericht Juli 2026' });
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
