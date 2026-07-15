// @vitest-environment happy-dom
/**
 * D009 — OperationalDaySection (Dashboard, operativer Tagesstand).
 *
 * Fixiert: (7) operative Tageskennzahlen bleiben verfügbar, (8) eindeutige
 * Bezeichnungen (Z-Bericht/Dienstplan, NICHT Erfolgsrechnung), fehlend ≠ 0
 * („—" statt 0), Rollen-Gating (canSeeRevenue/canSeeCosts/overview=null),
 * Gast-Sessions ohne klickbare Schreibflächen-Links, (12) keine Writes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OperationalDaySection } from '@/components/dashboard/OperationalDaySection';
import type { StartOverviewState } from '@/hooks/useStartOverview';
import type { StartOverviewResult } from '@/lib/start-overview-utils';

const readyOverview: StartOverviewState = {
  status: 'ready',
  data: {
    cards: [
      {
        id: 'reservationen',
        title: 'Reservationen',
        status: 'ok',
        statusLabel: 'Aktuell',
        detail: 'Stand heute',
        route: '/gaeste',
      },
      {
        id: 'tagesabschluss',
        title: 'Tagesabschluss',
        status: 'action',
        statusLabel: 'Offen',
        detail: 'Gestern unbestätigt',
        route: '/tagesabschluesse',
      },
    ],
  } as unknown as StartOverviewResult,
  todayTasks: [],
  typeCompletions: [],
  coverageError: null,
  loadedAt: new Date(),
};

const baseProps = {
  dayLabel: 'Mittwoch, 15. Juli 2026',
  revenueToday: 4_250 as number | null,
  revenueBasisLabel: 'netto',
  plannedHoursToday: 42.5 as number | null,
  actualHoursToday: 38 as number | null,
  plannedCostToday: 1_900 as number | null,
  todayInLoadedMonth: true,
  canSeeRevenue: true,
  canSeeCosts: true,
  isGuest: false,
  overview: readyOverview as StartOverviewState | null,
};

const renderSection = (over: Partial<typeof baseProps> = {}) =>
  render(
    <MemoryRouter>
      <OperationalDaySection {...baseProps} {...over} />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OperationalDaySection — operative Kennzahlen (D009 7–8)', () => {
  it('(7) zeigt Tagesumsatz, Stunden, Plankosten, Status-Karten und offene Aufgaben', () => {
    renderSection();
    expect(screen.getByTestId('op-kpi-tagesumsatz').textContent).toMatch(/4.?250/);
    expect(screen.getByTestId('op-kpi-stunden').textContent).toContain('38.0 h');
    expect(screen.getByTestId('op-kpi-stunden').textContent).toContain('Plan 42.5 h');
    expect(screen.getByTestId('op-kpi-plankosten').textContent).toMatch(/1.?900/);
    expect(screen.getByTestId('op-kpi-reservationen').textContent).toContain('Aktuell');
    expect(screen.getByTestId('op-kpi-tagesabschluss').textContent).toContain('Offen');
    expect(screen.getByTestId('op-kpi-aufgaben').textContent).toContain('0');
  });

  it('(8) eindeutige operative Bezeichnungen — nie „gemäss Erfolgsrechnung"', () => {
    renderSection();
    expect(screen.getByText('Tagesumsatz gemäss Z-Bericht')).toBeTruthy();
    expect(screen.getByText('Geplante Personalkosten gemäss Dienstplan')).toBeTruthy();
    expect(
      screen.getByTestId('operational-day-section').textContent,
    ).not.toContain('gemäss Erfolgsrechnung');
  });

  it('fehlend ≠ 0: null-Werte zeigen „—", nie 0', () => {
    renderSection({
      revenueToday: null,
      plannedHoursToday: null,
      actualHoursToday: null,
      plannedCostToday: null,
    });
    expect(screen.getByTestId('op-kpi-tagesumsatz').textContent).toContain('—');
    expect(screen.getByTestId('op-kpi-stunden').textContent).toContain('—');
    expect(screen.getByTestId('op-kpi-plankosten').textContent).toContain('—');
    expect(screen.getByTestId('op-kpi-tagesumsatz').textContent).not.toMatch(/CHF\s*0/u);
  });
});

describe('OperationalDaySection — Rollen-/Gast-Gating (D010 4)', () => {
  it('canSeeRevenue=false blendet den Tagesumsatz aus, canSeeCosts=false die Plankosten', () => {
    renderSection({ canSeeRevenue: false, canSeeCosts: false });
    expect(screen.queryByTestId('op-kpi-tagesumsatz')).toBeNull();
    expect(screen.queryByTestId('op-kpi-plankosten')).toBeNull();
    // Stunden bleiben für alle Rollen sichtbar.
    expect(screen.getByTestId('op-kpi-stunden')).toBeTruthy();
  });

  it('overview=null (Nicht-Admin): keine Status-/Aufgaben-Karten, keine Import-Signale', () => {
    renderSection({ overview: null });
    expect(screen.queryByTestId('op-kpi-reservationen')).toBeNull();
    expect(screen.queryByTestId('op-kpi-tagesabschluss')).toBeNull();
    expect(screen.queryByTestId('op-kpi-aufgaben')).toBeNull();
  });

  it('Gast-Session: Status-/Aufgaben-Karten sind NICHT klickbar (kein button)', () => {
    renderSection({ isGuest: true });
    expect(screen.getByTestId('op-kpi-reservationen').tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('op-kpi-tagesabschluss').tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('op-kpi-aufgaben').tagName).not.toBe('BUTTON');
  });

  it('Nicht-Gast: dieselben Karten sind klickbare Deep-Links (button)', () => {
    renderSection();
    expect(screen.getByTestId('op-kpi-reservationen').tagName).toBe('BUTTON');
    expect(screen.getByTestId('op-kpi-tagesabschluss').tagName).toBe('BUTTON');
    expect(screen.getByTestId('op-kpi-aufgaben').tagName).toBe('BUTTON');
  });
});

describe('OperationalDaySection — Read-only (D009 12)', () => {
  it('reines Rendern schreibt NIE (kein localStorage.setItem)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderSection();
    renderSection({ overview: { status: 'loading' } });
    renderSection({ overview: { status: 'error', message: 'x' } });
    expect(setItem).not.toHaveBeenCalled();
  });
});
