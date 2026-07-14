// @vitest-environment happy-dom
/**
 * Tests für die vereinfachte Startseite (StartOverview). Der Lade-Hook wird
 * gemockt (Fetch/Gating stecken im Hook bzw. in der Route). Fixiert:
 *   - 3 Bereiche (Heute / Warnungen / Schnellaktionen)
 *   - Warnungen nur bei echtem Handlungsbedarf, sonst ruhiger Leer-Zustand
 *   - Gast-Sessions sehen keine schreib-orientierten Schnellaktionen
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

const READY_WARN: StartOverviewResult = {
  cards: [
    { ...READY_OK.cards[0], status: 'action', statusLabel: 'Handlungsbedarf', detail: 'Überfällig – Ist-Daten nur bis 03.07.2026' },
    READY_OK.cards[1],
    READY_OK.cards[2],
    READY_OK.cards[3],
  ],
  warnings: [
    { id: 'umsatz', text: 'Umsatzimport: Überfällig – Ist-Daten nur bis 03.07.2026', route: '/gastronovi-import' },
  ],
};

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
  it('zeigt die drei Bereiche Heute / Warnungen / Schnellaktionen', () => {
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    expect(screen.getByRole('heading', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Warnungen' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Schnellaktionen' })).toBeTruthy();
  });

  it('rendert 4 Statuskarten mit deutschen Labels und Detailtext', () => {
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    for (const id of ['umsatz', 'reservationen', 'dienstplan', 'tagesabschluss']) {
      expect(screen.getByTestId(`start-card-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('start-card-dienstplan').textContent).toContain('Geplant bis 20.07.2026');
  });

  it('verlinkt auf das ausführliche Dashboard (/dashboard)', () => {
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    const link = screen.getByRole('link', { name: /Ausführliches Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

describe('StartOverview — Warnungen', () => {
  it('ohne Handlungsbedarf → ruhiger Leer-Zustand, keine Warnliste', () => {
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    expect(screen.getByTestId('start-no-warnings').textContent).toContain('Keine offenen Handlungsbedarfe');
    expect(screen.queryByTestId('start-warnings')).toBeNull();
  });

  it('mit Handlungsbedarf → Warnung mit Text und Link zur Detailseite', () => {
    mockState.value = { status: 'ready', data: READY_WARN, loadedAt: new Date() };
    renderPage();
    const list = screen.getByTestId('start-warnings');
    expect(list.textContent).toContain('Umsatzimport: Überfällig');
    expect(screen.queryByTestId('start-no-warnings')).toBeNull();
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
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    const actions = screen.getByTestId('start-actions');
    expect(actions.textContent).toContain('Umsatz importieren');
    expect(actions.textContent).toContain('Tagesabschluss erfassen');
    expect(actions.textContent).toContain('Reservationen ansehen');
    expect(actions.textContent).toContain('Dienstplan öffnen');
  });

  it('Gast-Session sieht NUR den Dienstplan-Link (keine Schreib-/PII-Aktionen)', () => {
    mockGuest.isGuest = true;
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    const actions = screen.getByTestId('start-actions');
    expect(actions.textContent).not.toContain('Umsatz importieren');
    expect(actions.textContent).not.toContain('Tagesabschluss erfassen');
    expect(actions.textContent).not.toContain('Reservationen ansehen');
    expect(actions.textContent).toContain('Dienstplan öffnen');
  });

  it('Gast-Session: kein „Öffnen"-Link auf Import-Karten (Umsatz/Reservationen), wohl aber auf Dienstplan', () => {
    mockGuest.isGuest = true;
    mockState.value = { status: 'ready', data: READY_OK, loadedAt: new Date() };
    renderPage();
    expect(screen.getByTestId('start-card-umsatz').textContent).not.toContain('Öffnen');
    expect(screen.getByTestId('start-card-reservationen').textContent).not.toContain('Öffnen');
    expect(screen.getByTestId('start-card-dienstplan').textContent).toContain('Öffnen');
  });
});
