// @vitest-environment happy-dom
/**
 * Tests für die Foratable-Zukunftsbausteine (FutureReservationsOverview +
 * FutureCalendarSection).  Schwerpunkte:
 *  - KPI-Werte stammen aus buildFutureOverview (zentrale Logik).
 *  - Kalender lässt sich aufklappen und ein Tag öffnet das Aggregat-Popup.
 *  - Das Popup enthält KEINE personenbezogenen Daten (Name/Telefon/E-Mail).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  FutureReservationsOverview, FutureCalendarSection,
} from '@/components/foratable/FutureReservationsSection';
import { buildFutureOverview, type FutureRange } from '@/lib/foratable-future';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';

const TODAY = '2026-07-10'; // Freitag

// Sentinel-PII, die im Popup NIE erscheinen darf.
const PII = { name: 'Maxine-Geheim Mustermann', phone: '079-000-GEHEIM', email: 'geheim@example.test' };

function row(over: Partial<ReservationDetailRow> & { date: string; partySize: number; status: string }): ReservationDetailRow {
  return {
    id: `r-${Math.random()}`,
    guestId: null,
    displayName: PII.name,
    time: '19:00',
    room: 'Terrasse',
    area: 'Aussen',
    phone: PII.phone,
    email: PII.email,
    comment: null,
    note: null,
    ...over,
  };
}

// 2026-07-11 (Sa): 2 aktive Reservationen → 6 Personen; 1 Storno (zählt nicht).
// 2026-07-18 (Sa): 1 aktive Reservation → 2 Personen.
const ROWS: ReservationDetailRow[] = [
  row({ date: '2026-07-11', partySize: 4, status: 'confirmed', room: 'Terrasse' }),
  row({ date: '2026-07-11', partySize: 2, status: 'completed', room: 'Saal' }),
  row({ date: '2026-07-11', partySize: 8, status: 'cancelled' }),
  row({ date: '2026-07-18', partySize: 2, status: 'confirmed' }),
];

const RANGE: FutureRange = { kind: 'custom', from: '2026-07-10', to: '2026-07-31' };

function renderOverview(metric: 'persons' | 'reservations' = 'persons') {
  const overview = buildFutureOverview(ROWS, RANGE, TODAY, metric);
  return {
    overview,
    ...render(
      <TooltipProvider>
        <FutureReservationsOverview overview={overview} metric={metric} onMetricChange={() => {}} />
      </TooltipProvider>,
    ),
  };
}

function renderCalendar(metric: 'persons' | 'reservations' = 'persons') {
  const overview = buildFutureOverview(ROWS, RANGE, TODAY, metric);
  return {
    overview,
    ...render(
      <TooltipProvider>
        <FutureCalendarSection overview={overview} metric={metric} detailRows={ROWS} />
      </TooltipProvider>,
    ),
  };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe('FutureReservationsOverview', () => {
  it('zeigt Summen-KPIs aus buildFutureOverview', () => {
    const { overview } = renderOverview('persons');
    // 6 (11.7.) + 2 (18.7.) = 8 Personen, 3 aktive Reservationen.
    expect(overview.totals.persons).toBe(8);
    expect(overview.totals.reservations).toBe(3);
    expect(screen.getByText('Personen zukünftig')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText('Reservationen zukünftig')).toBeTruthy();
  });

  it('weist den stärksten Tag aus (11.07.)', () => {
    renderOverview('persons');
    // 11.07. ist stärkster UND nächster starker Tag → in ≥1 Karte sichtbar.
    expect(screen.getAllByText(/Sa 11\.07/).length).toBeGreaterThanOrEqual(1);
  });

  it('zeigt bei rein vergangenem Zeitraum einen Hinweis statt Nullwerten', () => {
    const past: FutureRange = { kind: 'custom', from: '2026-06-01', to: '2026-06-30' };
    const overview = buildFutureOverview(ROWS, past, TODAY, 'persons');
    render(
      <TooltipProvider>
        <FutureReservationsOverview overview={overview} metric="persons" onMetricChange={() => {}} />
      </TooltipProvider>,
    );
    expect(overview.empty).toBe(true);
    expect(screen.getByTestId('ftr-empty')).toBeTruthy();
  });
});

describe('FutureCalendarSection', () => {
  it('klappt den Kalender auf und zeigt Tageskacheln', () => {
    renderCalendar('persons');
    // Kalender ist standardmässig eingeklappt.
    expect(screen.queryByTestId('ftr-day-2026-07-11')).toBeNull();
    fireEvent.click(screen.getByTestId('ftr-calendar-toggle'));
    const cell = screen.getByTestId('ftr-day-2026-07-11');
    expect(cell).toBeTruthy();
    // Personen-Wert des Tages (6) sichtbar.
    expect(within(cell).getByTestId('ftr-day-persons-2026-07-11').textContent).toContain('6');
  });

  it('öffnet das Aggregat-Popup OHNE personenbezogene Daten', () => {
    renderCalendar('persons');
    fireEvent.click(screen.getByTestId('ftr-calendar-toggle'));
    fireEvent.click(screen.getByTestId('ftr-day-2026-07-11'));

    const dialog = screen.getByTestId('ftr-day-dialog');
    const text = dialog.textContent ?? '';
    // Aggregatwerte vorhanden …
    expect(text).toContain('Reservationen');
    expect(text).toContain('Personen');
    expect(text).toContain('Terrasse');
    // … aber KEINE PII.
    expect(text).not.toContain(PII.name);
    expect(text).not.toContain(PII.phone);
    expect(text).not.toContain(PII.email);
    expect(dialog.querySelector('*')?.innerHTML ?? '').not.toContain('geheim@example.test');
  });
});
