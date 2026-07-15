// @vitest-environment happy-dom
/**
 * Tests für die Startübersicht als Tagesleitstand (StartOverview). Der
 * Lade-Hook wird gemockt (Fetch/Gating stecken im Hook bzw. in der Route).
 * Fixiert:
 *   - 4 Bereiche in fester Reihenfolge (Heute / Als Nächstes / Datenstand /
 *     Schnellaktionen) — die frühere „Warnungen"-Sektion existiert nicht mehr
 *   - «Als Nächstes»: max. 3 Aufgaben mit Deep-Link, positiver Leer-Zustand
 *   - Datenstand kompakt mit fehlenden Tagen; Teilfehler sichtbar, Karten bleiben
 *   - Gast-Sessions sehen keine schreib-orientierten Aktionen/Checklisten-Links
 *   - sichtbarer Fehlerzustand statt stiller Anzeige
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { StartOverviewState } from '@/hooks/useStartOverview';
import type { PrioritizedTask, TypeCompletion } from '@/lib/import-tasks-priority';
import type { StartOverviewResult } from '@/lib/start-overview-utils';

const mockState: { value: StartOverviewState } = { value: { status: 'loading' } };
const mockPerms = { isAdmin: true };
const mockGuest = { isGuest: false };

vi.mock('@/hooks/useStartOverview', () => ({
  useStartOverview: () => ({ state: mockState.value, refresh: vi.fn() }),
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => mockPerms,
}));
vi.mock('@/contexts/GuestSessionContext', () => ({
  useGuestSession: () => mockGuest,
}));

import StartOverviewPage from '@/pages/StartOverview';

const READY_OK: StartOverviewResult = {
  cards: [
    { id: 'umsatz', title: 'Umsatzimport', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 07.07.2026', route: '/gastronovi-import' },
    { id: 'reservationen', title: 'Reservationen', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 08.07.2026', route: '/foratable-import' },
    { id: 'dienstplan', title: 'Dienstplan', status: 'ok', statusLabel: 'Aktuell', detail: 'Geplant bis 20.07.2026', route: '/personal' },
    { id: 'tagesabschluss', title: 'Tagesabschluss', status: 'ok', statusLabel: 'Aktuell', detail: 'Gestern (07.07.2026) bestätigt', route: '/tagesabschluesse' },
  ],
  warnings: [],
};

const DONE_COMPLETIONS: TypeCompletion[] = [
  { type: 'zbericht', label: 'Z-Bericht', status: 'done', detail: null },
  { type: 'reservationen', label: 'Foratable / Reservationen', status: 'done', detail: null },
  { type: 'erfolgsrechnung', label: 'Erfolgsrechnung / Kontoblätter', status: 'later', detail: null },
];

const OPEN_TASK: PrioritizedTask = {
  task: {
    id: 'zbericht:2026-07-10',
    type: 'zbericht',
    frequency: 'daily',
    label: 'Z-Bericht 10.07.2026',
    from: '2026-07-10',
    to: '2026-07-10',
    status: 'open',
  },
  due: { urgency: 'overdue', dueLabel: '4 Tage überfällig', daysOverdue: 4 },
};

const OPEN_COMPLETIONS: TypeCompletion[] = [
  {
    type: 'zbericht',
    label: 'Z-Bericht',
    status: 'open',
    detail: '10.07.–12.07.2026',
    openRanges: [{ from: '2026-07-10', to: '2026-07-12' }],
    openDayCount: 3,
  },
  { type: 'reservationen', label: 'Foratable / Reservationen', status: 'done', detail: null },
];

function ready(over: Partial<Extract<StartOverviewState, { status: 'ready' }>> = {}): StartOverviewState {
  return {
    status: 'ready',
    data: READY_OK,
    todayTasks: [],
    typeCompletions: DONE_COMPLETIONS,
    coverageError: null,
    loadedAt: new Date(),
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <StartOverviewPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockGuest.isGuest = false;
  mockState.value = { status: 'loading' };
});

describe('StartOverview — Struktur', () => {
  it('zeigt die vier Bereiche Heute / Als Nächstes / Datenstand / Schnellaktionen', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Als Nächstes' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Datenstand' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Schnellaktionen' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Warnungen' })).toBeNull();
  });

  it('rendert 4 Statuskarten mit deutschen Labels und Detailtext', () => {
    mockState.value = ready();
    renderPage();
    for (const id of ['umsatz', 'reservationen', 'dienstplan', 'tagesabschluss']) {
      expect(screen.getByTestId(`start-card-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('start-card-dienstplan').textContent).toContain('Geplant bis 20.07.2026');
  });

  it('verlinkt auf das ausführliche Dashboard (/dashboard)', () => {
    mockState.value = ready();
    renderPage();
    const link = screen.getByRole('link', { name: /Ausführliches Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

describe('StartOverview — Als Nächstes', () => {
  it('(4) keine fälligen Aufgaben → positiver Leer-Zustand', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('start-next-empty').textContent).toContain('keine dringenden Aufgaben');
    expect(screen.queryByTestId('start-next-actions')).toBeNull();
  });

  it('(5) offene Aufgabe → Zeile mit Titel, Begründung, Urgenz-Badge und Deep-Link', () => {
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    const row = screen.getByTestId('start-next-task-zbericht');
    expect(row.textContent).toContain('Z-Bericht importieren');
    expect(row.textContent).toContain('Fehlend: 10.–12.07.');
    expect(row.textContent).toContain('4 Tage überfällig');
    const link = row.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/gastronovi-import?from=2026-07-10&to=2026-07-10&scope=day');
    expect(screen.queryByTestId('start-next-empty')).toBeNull();
  });

  it('(16) Gast-Session: Import-Aktion wird nicht angezeigt (read-only, keine Bearbeitung)', () => {
    mockGuest.isGuest = true;
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    expect(screen.queryByTestId('start-next-task-zbericht')).toBeNull();
    expect(screen.getByTestId('start-next-empty')).toBeTruthy();
  });
});

describe('StartOverview — Datenstand', () => {
  it('zeigt kompakte Zeilen pro Importtyp inkl. fehlender Tage', () => {
    mockState.value = ready({ todayTasks: [OPEN_TASK], typeCompletions: OPEN_COMPLETIONS });
    renderPage();
    expect(screen.getByTestId('start-datenstand-zbericht').textContent).toContain('Fehlend: 10.–12.07.');
    expect(screen.getByTestId('start-datenstand-reservationen').textContent).toContain('Vollständig');
  });

  it('(13) monatlicher Typ im laufenden Monat → „Noch nicht fällig" (Monatsstatus)', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('start-datenstand-erfolgsrechnung').textContent).toContain('Noch nicht fällig');
  });

  it('Admin sieht den Link zur Import-Checkliste, Gast NICHT (gesperrte Fläche)', () => {
    mockState.value = ready();
    renderPage();
    expect(screen.getByRole('link', { name: /Import-Checkliste öffnen/ })).toBeTruthy();
    cleanup();
    mockGuest.isGuest = true;
    renderPage();
    expect(screen.queryByRole('link', { name: /Import-Checkliste öffnen/ })).toBeNull();
  });

  it('(14) Teilfehler: coverageError → sichtbarer Hinweis mit Retry, Karten bleiben', () => {
    mockState.value = ready({ todayTasks: null, typeCompletions: null, coverageError: 'Netzwerkfehler' });
    renderPage();
    expect(screen.getByTestId('start-coverage-error').textContent).toContain('konnten nicht geladen werden');
    expect(screen.getByTestId('start-card-umsatz')).toBeTruthy();
    expect(screen.queryByTestId('start-datenstand')).toBeNull();
    expect(screen.queryByTestId('start-next-empty')).toBeNull();
  });
});

describe('StartOverview — Zustände', () => {
  it('loading → sichtbarer Ladezustand', () => {
    mockState.value = { status: 'loading' };
    renderPage();
    expect(screen.getByTestId('start-loading')).toBeTruthy();
  });

  it('error → sichtbare Fehlermeldung mit Retry (kein stiller Fallback)', () => {
    mockState.value = { status: 'error', message: 'Netzwerkfehler' };
    renderPage();
    expect(screen.getByTestId('start-error').textContent).toContain('Netzwerkfehler');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy();
  });
});

describe('StartOverview — Schnellaktionen & Gast-Gating', () => {
  it('Admin sieht alle 4 Schnellaktionen', () => {
    mockState.value = ready();
    renderPage();
    const actions = screen.getByTestId('start-actions');
    expect(actions.textContent).toContain('Umsatz importieren');
    expect(actions.textContent).toContain('Tagesabschluss erfassen');
    expect(actions.textContent).toContain('Reservationen ansehen');
    expect(actions.textContent).toContain('Dienstplan öffnen');
  });

  it('Gast-Session sieht NUR den Dienstplan-Link (keine Schreib-/PII-Aktionen)', () => {
    mockGuest.isGuest = true;
    mockState.value = ready();
    renderPage();
    const actions = screen.getByTestId('start-actions');
    expect(actions.textContent).not.toContain('Umsatz importieren');
    expect(actions.textContent).not.toContain('Tagesabschluss erfassen');
    expect(actions.textContent).not.toContain('Reservationen ansehen');
    expect(actions.textContent).toContain('Dienstplan öffnen');
  });

  it('Gast-Session: kein „Öffnen"-Link auf Import-Karten (Umsatz/Reservationen), wohl aber auf Dienstplan', () => {
    mockGuest.isGuest = true;
    mockState.value = ready();
    renderPage();
    expect(screen.getByTestId('start-card-umsatz').textContent).not.toContain('Öffnen');
    expect(screen.getByTestId('start-card-reservationen').textContent).not.toContain('Öffnen');
    expect(screen.getByTestId('start-card-dienstplan').textContent).toContain('Öffnen');
  });
});
