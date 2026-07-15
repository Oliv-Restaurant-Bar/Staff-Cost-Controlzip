// @vitest-environment happy-dom
/**
 * Tests für das kompakte „Heute wichtig"-Banner im Dashboard. Der Lade-Hook
 * wird gemockt (identisches Muster wie StartOverview.test.tsx). Fixiert:
 *   - Nur echte Handlungsbedarfe (warnings) werden gelistet, sonst grüner
 *     Ein-Zeilen-Zustand
 *   - 4 Schnellaktionen für Admins, Gast-Sessions nur Dienstplan
 *   - Nicht-Admins (Manager) sehen das Banner gar nicht
 *   - sichtbarer Fehlerzustand statt stiller Anzeige
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { StartOverviewState } from '@/hooks/useStartOverview';
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

import { HeuteWichtigBanner } from '@/components/HeuteWichtigBanner';

const READY_OK: StartOverviewResult = {
  cards: [
    { id: 'umsatz', title: 'Umsatzimport', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 07.07.2026', route: '/gastronovi-import' },
    { id: 'reservationen', title: 'Reservationen', status: 'ok', statusLabel: 'Aktuell', detail: 'Aktuell – Ist-Daten bis 08.07.2026', route: '/foratable-import' },
    { id: 'dienstplan', title: 'Dienstplan', status: 'ok', statusLabel: 'Aktuell', detail: 'Geplant bis 20.07.2026', route: '/personal' },
    { id: 'tagesabschluss', title: 'Tagesabschluss', status: 'ok', statusLabel: 'Aktuell', detail: 'Gestern (07.07.2026) bestätigt', route: '/tagesabschluesse' },
  ],
  warnings: [],
};

const READY_WARN: StartOverviewResult = {
  cards: READY_OK.cards,
  warnings: [
    { id: 'umsatz', text: 'Umsatzimport: Überfällig – Ist-Daten nur bis 03.07.2026', route: '/gastronovi-import' },
    { id: 'tagesabschluss', text: 'Tagesabschluss: Gestern (07.07.2026) noch nicht bestätigt', route: '/tagesabschluesse' },
  ],
};

function renderBanner() {
  return render(
    <MemoryRouter>
      <HeuteWichtigBanner />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockGuest.isGuest = false;
  mockPerms.isAdmin = true;
  mockState.value = { status: 'loading' };
});

describe('HeuteWichtigBanner — Sichtbarkeit', () => {
  it('Nicht-Admin (Manager) sieht das Banner nicht', () => {
    mockPerms.isAdmin = false;
    renderBanner();
    expect(screen.queryByTestId('heute-wichtig')).toBeNull();
  });

  it('Admin sieht Titel „Heute wichtig"', () => {
    mockState.value = { status: 'ready', data: READY_OK, todayTasks: [], typeCompletions: [], coverageError: null, loadedAt: new Date() };
    renderBanner();
    expect(screen.getByTestId('heute-wichtig').textContent).toContain('Heute wichtig');
  });
});

describe('HeuteWichtigBanner — Warnungen', () => {
  it('ohne Handlungsbedarf → grüne Ein-Zeilen-Bestätigung, keine Warnliste', () => {
    mockState.value = { status: 'ready', data: READY_OK, todayTasks: [], typeCompletions: [], coverageError: null, loadedAt: new Date() };
    renderBanner();
    expect(screen.getByTestId('heute-wichtig-ok').textContent).toContain('Keine offenen Handlungsbedarfe');
    expect(screen.queryByTestId('heute-wichtig-warnings')).toBeNull();
  });

  it('mit Handlungsbedarf → NUR die action-Warnungen mit Link zur Detailseite', () => {
    mockState.value = { status: 'ready', data: READY_WARN, todayTasks: [], typeCompletions: [], coverageError: null, loadedAt: new Date() };
    renderBanner();
    const list = screen.getByTestId('heute-wichtig-warnings');
    expect(list.textContent).toContain('Umsatzimport: Überfällig');
    expect(list.textContent).toContain('Tagesabschluss: Gestern');
    expect(list.querySelectorAll('li').length).toBe(2);
    expect(screen.queryByTestId('heute-wichtig-ok')).toBeNull();
    const links = Array.from(list.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('/gastronovi-import');
    expect(links).toContain('/tagesabschluesse');
  });
});

describe('HeuteWichtigBanner — Zustände', () => {
  it('loading → sichtbarer Ladezustand', () => {
    mockState.value = { status: 'loading' };
    renderBanner();
    expect(screen.getByTestId('heute-wichtig-loading')).toBeTruthy();
  });

  it('error → sichtbare Fehlermeldung (kein stiller Fallback)', () => {
    mockState.value = { status: 'error', message: 'Netzwerkfehler' };
    renderBanner();
    expect(screen.getByTestId('heute-wichtig-error').textContent).toContain('Netzwerkfehler');
  });
});

describe('HeuteWichtigBanner — Schnellaktionen & Gast-Gating', () => {
  it('Admin sieht alle 4 Schnellaktionen mit korrekten Routen', () => {
    mockState.value = { status: 'ready', data: READY_OK, todayTasks: [], typeCompletions: [], coverageError: null, loadedAt: new Date() };
    renderBanner();
    const actions = screen.getByTestId('heute-wichtig-actions');
    const links = Array.from(actions.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/import', '/tagesabschluesse', '/personal', '/gaeste']);
  });

  it('Gast-Session sieht NUR den Dienstplan-Link (keine Schreib-/PII-Aktionen)', () => {
    mockGuest.isGuest = true;
    mockState.value = { status: 'ready', data: READY_OK, todayTasks: [], typeCompletions: [], coverageError: null, loadedAt: new Date() };
    renderBanner();
    const actions = screen.getByTestId('heute-wichtig-actions');
    const links = Array.from(actions.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/personal']);
  });
});
