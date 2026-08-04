// @vitest-environment node
/**
 * Tests für die «Als Nächstes»- und Datenstand-Logik der Startübersicht.
 * ======================================================================
 * Die Fixtures laufen bewusst durch die ECHTE SSoT-Kette
 * (buildImportTasks → getTodayTasks / summarizeTypeCompletion), damit die
 * Tests brechen, sobald die Startseite eine eigene Statusberechnung erfände.
 * Nummerierte Fälle (1)–(17) = Testkatalog aus dem UX-Auftrag; (7) und (18)
 * liegen im Hook-Test (useStartOverview.test.tsx).
 *
 * Default-Einstellungen der neuen Import-Strategie: zbericht/gaeste_bon/
 * tagesabschluss täglich, mirus täglich mit 2 Karenztagen, reservationen
 * wöchentlich (Woche Mo–So, fällig nach dem Sonntag), marketing bei_bedarf
 * (erzeugt NIE Aufgaben), erfolgsrechnung/warenrechnungen/inventur monatlich.
 */

import { describe, it, expect } from 'vitest';
import {
  addDaysIso,
  buildImportTasks,
  type ImportTask,
  type MonthCoverage,
} from '@/lib/import-tasks-engine';
import { defaultImportSettings } from '@/lib/import-settings';
import {
  getTodayTasks,
  summarizeTypeCompletion,
  type PrioritizedTask,
} from '@/lib/import-tasks-priority';
import {
  buildDatenstandRows,
  buildNextActions,
  formatMissingDays,
  formatShortRange,
  MAX_NEXT_ACTIONS,
  type NextActionsInput,
  type StartCard,
} from '@/lib/start-overview-utils';

// Heute = 15.07.2026 → Engine deckelt Aufgaben auf gestern (14.07.).
const TODAY = '2026-07-15';
const PERIOD = { year: 2026, month: 7, today: TODAY };
const SETTINGS = defaultImportSettings();

/** Alle Julitage from..to als yyyy-MM-dd. */
function julyDays(from: number, to: number): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d++) out.push(`2026-07-${String(d).padStart(2, '0')}`);
  return out;
}

/**
 * Volle Abdeckung bis gestern. Reservationen (wöchentlich) brauchen zusätzlich
 * die Vormonatstage der ersten ISO-Woche (29./30.06.) — Loader-Vertrag.
 */
function coverage(overrides: MonthCoverage = {}): MonthCoverage {
  const allDays = julyDays(1, 14);
  return {
    zbericht: { coveredDays: allDays },
    gaeste_bon: { coveredDays: allDays },
    mirus: { coveredDays: allDays },
    tagesabschluss: { coveredDays: allDays },
    reservationen: { coveredDays: ['2026-06-29', '2026-06-30', ...allDays] },
    erfolgsrechnung: { monthDone: true },
    warenrechnungen: { monthDone: true },
    inventur: { monthDone: true },
    ...overrides,
  };
}

function daysExcept(missing: readonly number[]): string[] {
  const gone = new Set(missing.map((d) => `2026-07-${String(d).padStart(2, '0')}`));
  return julyDays(1, 14).filter((d) => !gone.has(d));
}

const OK_CARDS: StartCard[] = [
  { id: 'umsatz', title: 'Umsatzimport', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell', route: '/gastronovi-import' },
  { id: 'reservationen', title: 'Reservationen', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell', route: '/foratable-import' },
  { id: 'dienstplan', title: 'Dienstplan', status: 'ok', statusLabel: 'Aktuell', detail: 'Geplant bis 25.07.2026', route: '/personal' },
  { id: 'tagesabschluss', title: 'Tagesabschluss', status: 'ok', statusLabel: 'Aktuell', detail: 'Gestern bestätigt', route: '/tagesabschluesse' },
];

/** SSoT-Kette einmal ausführen und Input für buildNextActions bauen. */
function derive(cov: MonthCoverage, cards: StartCard[] = OK_CARDS): {
  input: NextActionsInput;
  todayTasks: PrioritizedTask[];
} {
  const tasks = buildImportTasks(PERIOD, cov, SETTINGS);
  const todayTasks = getTodayTasks(tasks, TODAY);
  const typeCompletions = summarizeTypeCompletion(tasks, TODAY);
  return { input: { todayTasks, typeCompletions, cards }, todayTasks };
}

// ─── Formatierung fehlender Tage ─────────────────────────────────────────────

describe('formatShortRange / formatMissingDays', () => {
  it('(8) einzelner fehlender Tag → „08.07."', () => {
    expect(formatShortRange({ from: '2026-07-08', to: '2026-07-08' })).toBe('08.07.');
  });

  it('(9) zusammenhängende Tage als EIN Bereich „03.–05.07."', () => {
    expect(formatShortRange({ from: '2026-07-03', to: '2026-07-05' })).toBe('03.–05.07.');
  });

  it('monatsübergreifender Bereich → „28.06.–02.07."', () => {
    expect(formatShortRange({ from: '2026-06-28', to: '2026-07-02' })).toBe('28.06.–02.07.');
  });

  it('(10) viele Bereiche werden gekürzt: „+ N weitere" zählt TAGE, nicht Bereiche', () => {
    const ranges = [
      { from: '2026-07-01', to: '2026-07-03' },
      { from: '2026-07-05', to: '2026-07-05' },
      { from: '2026-07-07', to: '2026-07-09' },
      { from: '2026-07-11', to: '2026-07-11' },
    ];
    // Weggekürzt: 07.–09.07. (3 Tage) + 11.07. (1 Tag) = 4 weitere
    expect(formatMissingDays(ranges)).toBe('01.–03.07., 05.07. + 4 weitere');
  });

  it('Singular: genau 1 weggekürzter Tag → „+ 1 weiterer"', () => {
    const ranges = [
      { from: '2026-07-01', to: '2026-07-01' },
      { from: '2026-07-03', to: '2026-07-03' },
      { from: '2026-07-05', to: '2026-07-05' },
    ];
    expect(formatMissingDays(ranges)).toBe('01.07., 03.07. + 1 weiterer');
  });

  it('(15) fehlend ≠ 0: leere Bereichsliste → leerer String, nie „0 Tage"', () => {
    expect(formatMissingDays([])).toBe('');
  });
});

// ─── «Als Nächstes» ──────────────────────────────────────────────────────────

describe('buildNextActions — über die echte Engine-Kette', () => {
  it('(1) höchste Priorität zuerst: überfälliger Typ vor heute-fälligem', () => {
    // zbericht fehlt 10.–12.07. (überfällig), gaeste_bon fehlt nur 14.07. (heute fällig)
    const { input } = derive(
      coverage({
        zbericht: { coveredDays: daysExcept([10, 11, 12]) },
        gaeste_bon: { coveredDays: daysExcept([14]) },
      }),
    );
    const actions = buildNextActions(input);
    expect(actions[0].id).toBe('task-zbericht');
    expect(actions[0].urgency).toBe('overdue');
    expect(actions[1].id).toBe('task-gaeste_bon');
    expect(actions[1].urgency).toBe('today');
  });

  it('(2) höchstens 3 Aktionen, auch wenn mehr Typen offen sind', () => {
    const { input } = derive(
      coverage({
        zbericht: { coveredDays: daysExcept([2, 3]) },
        gaeste_bon: { coveredDays: daysExcept([2]) },
        mirus: { coveredDays: daysExcept([5]) },
        reservationen: { coveredDays: [] },
      }),
    );
    const actions = buildNextActions(input);
    expect(actions).toHaveLength(MAX_NEXT_ACTIONS);
  });

  it('(3) erledigte Aufgaben erscheinen nicht und verdrängen keine offenen', () => {
    const { input } = derive(coverage({ mirus: { coveredDays: daysExcept([6, 7]) } }));
    const actions = buildNextActions(input);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe('task-mirus');
    expect(actions[0].title).toBe('Arbeitszeiten importieren');
  });

  it('(4) keine fälligen Aufgaben → leere Liste (positiver Zustand in der UI)', () => {
    const { input } = derive(coverage());
    expect(buildNextActions(input)).toEqual([]);
  });

  it('(5) Deep-Link führt auf die bestehende Import-Route mit advisory Prefill', () => {
    const { input } = derive(coverage({ zbericht: { coveredDays: daysExcept([10]) } }));
    const [action] = buildNextActions(input);
    expect(action.href).toBe('/gastronovi-import?from=2026-07-10&to=2026-07-10&scope=day');
    expect(action.reason).toBe('Fehlend: 10.07.');
  });

  it('Begründung nutzt die GEMERGTEN offenen Zeiträume mit Kürzung', () => {
    const { input } = derive(
      coverage({ zbericht: { coveredDays: daysExcept([3, 4, 5, 8, 10, 11, 12, 14]) } }),
    );
    const [action] = buildNextActions(input);
    // Bereiche: 03.–05.07., 08.07., 10.–12.07., 14.07. → gekürzt + 4 weitere
    expect(action.reason).toBe('Fehlend: 03.–05.07., 08.07. + 4 weitere');
  });

  it('(14) Teilfehler: Fehler-Typ verweist auf die Checkliste, andere Typen bleiben sichtbar', () => {
    const { input } = derive(
      coverage({
        zbericht: { error: 'Supabase nicht erreichbar' },
        gaeste_bon: { coveredDays: daysExcept([12]) },
      }),
    );
    const actions = buildNextActions(input);
    expect(actions[0].id).toBe('task-zbericht');
    expect(actions[0].urgency).toBe('error');
    expect(actions[0].href).toBe('/import-cockpit');
    expect(actions[0].reason).not.toContain('Supabase'); // kein Technik-Jargon
    expect(actions.some((a) => a.id === 'task-gaeste_bon')).toBe(true);
  });

  it('(17) Reihenfolge kommt 1:1 aus getTodayTasks — keine Zweitsortierung', () => {
    // Bewusst „falsch" geordnete Eingabe: heute-fällig VOR überfällig.
    const mkTask = (type: ImportTask['type'], day: string): ImportTask => ({
      id: `${type}:${day}`,
      type,
      frequency: 'daily',
      label: `${type} ${day}`,
      from: day,
      to: day,
      status: 'open',
    });
    const todayTasks: PrioritizedTask[] = [
      { task: mkTask('gaeste_bon', '2026-07-14'), due: { urgency: 'today', dueLabel: 'Heute erledigen', daysOverdue: 0 } },
      { task: mkTask('zbericht', '2026-07-10'), due: { urgency: 'overdue', dueLabel: '4 Tage überfällig', daysOverdue: 4 } },
    ];
    const actions = buildNextActions({ todayTasks, typeCompletions: [], cards: OK_CARDS });
    expect(actions.map((a) => a.id)).toEqual(['task-gaeste_bon', 'task-zbericht']);
  });

  it('Karten-Prüfaktionen (Tagesabschluss/Dienstplan) folgen NACH den Import-Aufgaben', () => {
    const cards: StartCard[] = OK_CARDS.map((c) =>
      c.id === 'tagesabschluss'
        ? { ...c, status: 'action' as const, statusLabel: 'Handlungsbedarf', detail: 'Gestern (14.07.2026) noch nicht bestätigt' }
        : c,
    );
    const { input } = derive(coverage({ zbericht: { coveredDays: daysExcept([10]) } }), cards);
    const actions = buildNextActions(input);
    expect(actions.map((a) => a.id)).toEqual(['task-zbericht', 'card-tagesabschluss']);
    expect(actions[1].urgency).toBe('check');
    expect(actions[1].href).toBe('/tagesabschluesse');
  });

  it('Umsatz-/Reservations-Karten erzeugen KEINE eigene Aktion (Dopplung mit Import-Aufgaben)', () => {
    const cards: StartCard[] = OK_CARDS.map((c) =>
      c.id === 'umsatz' || c.id === 'reservationen'
        ? { ...c, status: 'action' as const, statusLabel: 'Handlungsbedarf', detail: 'Überfällig' }
        : c,
    );
    const { input } = derive(coverage(), cards);
    expect(buildNextActions(input)).toEqual([]);
  });

  it('Dienstplan „bald fällig" erscheint nur, wenn Plätze frei sind', () => {
    const dueSoonCards: StartCard[] = OK_CARDS.map((c) =>
      c.id === 'dienstplan'
        ? { ...c, status: 'due_soon' as const, statusLabel: 'Bald fällig', detail: 'Geplant bis 18.07.2026' }
        : c,
    );
    const relaxed = derive(coverage(), dueSoonCards);
    expect(buildNextActions(relaxed.input).map((a) => a.id)).toEqual(['card-dienstplan']);
    expect(buildNextActions(relaxed.input)[0].urgency).toBe('due_soon');

    const busy = derive(
      coverage({
        zbericht: { coveredDays: daysExcept([2]) },
        gaeste_bon: { coveredDays: daysExcept([2]) },
        mirus: { coveredDays: daysExcept([5]) },
      }),
      dueSoonCards,
    );
    expect(buildNextActions(busy.input).some((a) => a.id === 'card-dienstplan')).toBe(false);
  });
});

// ─── Datenstand ──────────────────────────────────────────────────────────────

describe('buildDatenstandRows — über die echte Engine-Kette', () => {
  function rows(cov: MonthCoverage, period = PERIOD, today = TODAY) {
    return buildDatenstandRows(summarizeTypeCompletion(buildImportTasks(period, cov, SETTINGS), today));
  }

  it('volle Abdeckung → alle aktiven Typen „Vollständig" (marketing = bei_bedarf erscheint nicht)', () => {
    const all = rows(coverage());
    expect(all).toHaveLength(8); // 9 Typen − marketing (bei_bedarf erzeugt keine Aufgaben)
    expect(all.some((r) => r.type === 'marketing')).toBe(false);
    expect(all.every((r) => r.status === 'done' && r.text === 'Vollständig')).toBe(true);
  });

  it('(9) fehlende Tage kompakt als Bereich („Fehlend: 10.–12.07.")', () => {
    const all = rows(coverage({ zbericht: { coveredDays: daysExcept([10, 11, 12]) } }));
    const z = all.find((r) => r.type === 'zbericht')!;
    expect(z.status).toBe('open');
    expect(z.text).toBe('Fehlend: 10.–12.07.');
  });

  it('(11) zukünftige Tage zählen NIE als fehlend (Engine deckelt auf gestern)', () => {
    // Abdeckung nur bis 14.07. (gestern) — 15.07.+ darf keine Lücke erzeugen.
    const all = rows(coverage());
    expect(all.find((r) => r.type === 'zbericht')!.text).toBe('Vollständig');
    const tasks = buildImportTasks(PERIOD, coverage({ zbericht: { coveredDays: [] } }), SETTINGS);
    const lastOpen = tasks.filter((t) => t.type === 'zbericht').map((t) => t.to).sort().at(-1)!;
    expect(lastOpen).toBe(addDaysIso(TODAY, -1));
  });

  it('(12) durch Importlauf abgedeckte Tage (z. B. Ruhetage) gelten nicht als Lücke', () => {
    // 06.07. ist abgedeckt (Ruhetag im Importlauf enthalten) — nur 05. und 07. fehlen.
    const all = rows(coverage({ gaeste_bon: { coveredDays: daysExcept([5, 7]) } }));
    const r = all.find((x) => x.type === 'gaeste_bon')!;
    expect(r.text).toBe('Fehlend: 05.07., 07.07.');
    expect(r.text).not.toContain('06.07.');
  });

  it('wöchentliche Reservationen: offene Woche erscheint als ganzer Wochenbereich', () => {
    // Sonntag 12.07. fehlt → Woche 06.–12.07. offen (fällig seit Montag 13.07.).
    const all = rows(coverage({ reservationen: { coveredDays: ['2026-06-29', '2026-06-30', ...daysExcept([12])] } }));
    const r = all.find((x) => x.type === 'reservationen')!;
    expect(r.status).toBe('open');
    expect(r.text).toBe('Fehlend: 06.–12.07.');
  });

  it('(13) monatliche Daten → Monatsstatus, NIE eine künstliche Tagesliste', () => {
    // Laufender Monat: noch nicht fällig.
    const running = rows(coverage({ erfolgsrechnung: { monthDone: false } }));
    expect(running.find((r) => r.type === 'erfolgsrechnung')!.text).toBe('Noch nicht fällig');
    // Abgeschlossener Monat (Juni, heute Juli): fehlt als MONATS-Status.
    const juneRows = rows(
      { erfolgsrechnung: { monthDone: false } },
      { year: 2026, month: 6, today: TODAY },
    );
    const er = juneRows.find((r) => r.type === 'erfolgsrechnung')!;
    expect(er.status).toBe('open');
    expect(er.text).toBe('Fehlt noch');
    expect(er.text).not.toMatch(/\d{2}\.\d{2}\./);
  });

  it('(14)/(15) Fehler-Typ → sichtbarer Status statt stiller 0; andere Typen unbeeinflusst', () => {
    const all = rows(coverage({ mirus: { error: 'timeout' } }));
    const m = all.find((r) => r.type === 'mirus')!;
    expect(m.status).toBe('error');
    expect(m.text).toBe('Status konnte nicht ermittelt werden');
    expect(m.text).not.toContain('0');
    expect(all.filter((r) => r.status === 'done')).toHaveLength(7);
  });
});
