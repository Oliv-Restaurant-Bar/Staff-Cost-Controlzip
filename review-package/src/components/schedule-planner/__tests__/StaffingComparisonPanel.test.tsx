// @vitest-environment happy-dom
/**
 * Tests für StaffingComparisonPanel — Fokus auf das Auf-/Zu-Verhalten
 * (Standard geschlossen, kompakte Kopfzeile, Inhalt/Reservationen nur geöffnet,
 * localStorage-Persistenz). Die reine Abgleichslogik ist separat im Node-Test
 * abgedeckt; hier werden die Daten-Hooks gemockt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

import type { Position } from '@/types/positions';
import type { StaffingRequirement } from '@/types/staffing';
import type { DayDemandState } from '@/hooks/useDayDemandContext';
import type { DayDemandContext as DayDemandContextData } from '@/lib/staffing-demand-context';

const posState: { value: { positions: Position[]; loading: boolean } } = {
  value: { positions: [], loading: false },
};
const reqState: { value: { requirements: StaffingRequirement[]; loading: boolean } } = {
  value: { requirements: [], loading: false },
};
const demandState: { value: DayDemandState } = { value: { status: 'hidden' } };

vi.mock('@/hooks/usePositions', () => ({ usePositions: () => posState.value }));
vi.mock('@/hooks/useStaffingRequirements', () => ({
  useStaffingRequirements: () => reqState.value,
}));
vi.mock('@/hooks/useDayDemandContext', () => ({
  useDayDemandContext: () => demandState.value,
}));

import { StaffingComparisonPanel } from '@/components/schedule-planner/StaffingComparisonPanel';

// Montag → getISODay = 1 (passt zur Standard-Saison + weekday 1 der Fixtures).
const MONDAY = new Date('2026-07-06T00:00:00');

const SERVICE_POS: Position = {
  id: 'service',
  restaurantId: 'b-1',
  key: 'service',
  name: 'Service',
  department: 'service',
  departmentGroup: 'restaurant',
  color: undefined,
  icon: undefined,
  sortOrder: 1,
  active: true,
};

const SERVICE_REQ: StaffingRequirement = {
  id: 'service-10-14',
  restaurantId: 'b-1',
  scopeType: 'weekly',
  season: 'standard',
  weekday: 1,
  scopeRef: null,
  positionKey: 'service',
  shiftStart: '10:00',
  shiftEnd: '14:00',
  requiredCount: 2,
  sortOrder: 0,
  meta: {},
};

const DEMAND_READY: DayDemandContextData = {
  date: '2026-07-06',
  weekday: 1,
  kind: 'expected',
  dayReservations: 23,
  dayPersons: 85,
  avgReservations: 18,
  avgPersons: 71,
  pctDiffReservations: 27.8,
  pctDiffPersons: 19.7,
  occurrences: 8,
  occurrencesWithData: 7,
};

function renderPanel() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <StaffingComparisonPanel employees={[]} scheduleData={{}} initialDate={MONDAY} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  posState.value = { positions: [], loading: false };
  reqState.value = { requirements: [], loading: false };
  demandState.value = { status: 'hidden' };
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});
afterEach(cleanup);

describe('StaffingComparisonPanel — Auf/Zu', () => {
  it('Standard geschlossen: nur kompakte Kopfzeile, kein Inhalt/keine Reservationen', () => {
    demandState.value = { status: 'ready', context: DEMAND_READY }; // wäre sichtbar, wenn offen
    renderPanel();

    const toggle = screen.getByTestId('staffing-panel-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Kein Inhalt, keine Leer-Box, keine Reservationszeile im geschlossenen Zustand.
    expect(screen.queryByTestId('staffing-content')).toBeNull();
    expect(screen.queryByTestId('staffing-empty')).toBeNull();
    expect(screen.queryByTestId('staffing-demand-context')).toBeNull();
  });

  it('kein Bedarf → Kurzstatus „Kein Bedarf definiert" bereits geschlossen sichtbar', () => {
    renderPanel();
    expect(screen.getByTestId('staffing-panel-status').textContent).toBe('Kein Bedarf definiert');
  });

  it('Unterbesetzung → Kurzstatus mit Personenzahl im geschlossenen Zustand', () => {
    posState.value = { positions: [SERVICE_POS], loading: false };
    reqState.value = { requirements: [SERVICE_REQ], loading: false }; // required 2, geplant 0
    renderPanel();
    expect(screen.getByTestId('staffing-panel-status').textContent).toBe(
      '2 Personen unterbesetzt',
    );
    // geschlossen: KPI-Inhalt noch nicht gerendert.
    expect(screen.queryByTestId('staffing-content')).toBeNull();
  });

  it('Klick öffnet: Leer-Zeile + Reservationskontext erscheinen, aria-expanded=true', () => {
    demandState.value = { status: 'ready', context: DEMAND_READY };
    renderPanel();

    fireEvent.click(screen.getByTestId('staffing-panel-toggle'));

    expect(screen.getByTestId('staffing-panel-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('staffing-empty')).toBeTruthy();
    expect(screen.getByTestId('staffing-demand-context')).toBeTruthy();
  });

  it('Klick öffnet mit Bedarf: Inhalt (KPI/Tabelle) wird gerendert', () => {
    posState.value = { positions: [SERVICE_POS], loading: false };
    reqState.value = { requirements: [SERVICE_REQ], loading: false };
    renderPanel();

    fireEvent.click(screen.getByTestId('staffing-panel-toggle'));
    expect(screen.getByTestId('staffing-content')).toBeTruthy();
  });

  it('Auf-/Zu-Status wird in localStorage gemerkt', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('staffing-panel-toggle'));
    expect(localStorage.getItem('staffing-comparison-open')).toBe('1');
    fireEvent.click(screen.getByTestId('staffing-panel-toggle'));
    expect(localStorage.getItem('staffing-comparison-open')).toBe('0');
  });

  it('gespeicherter „offen"-Status öffnet das Panel initial', () => {
    localStorage.setItem('staffing-comparison-open', '1');
    renderPanel();
    expect(screen.getByTestId('staffing-panel-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('staffing-empty')).toBeTruthy();
  });
});
