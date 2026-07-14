// @vitest-environment happy-dom
/**
 * Tests für die Zukunftsbausteine der Seite „Gäste & Reservationen"
 * (FutureReservationsOverview + FutureCalendarSection + DayReservationsDialog).
 * Schwerpunkte:
 *  - KPI-Werte stammen aus buildFutureOverview (zentrale Logik).
 *  - Summen-Karten (klickbar) rufen onOpenTotals, Tages-Karten onOpenDay.
 *  - Kalender lässt sich aufklappen und meldet einen Tagesklick via onDayClick.
 *  - Der Tages-Dialog OHNE showPii enthält KEINE personenbezogenen Daten.
 *  - Der Tages-Dialog MIT showPii zeigt die Detailliste + Status-Filter,
 *    „Erwartete Personen" zählt nur aktive Reservationen (Storno sichtbar).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import {
  FutureReservationsOverview, FutureCalendarSection, DayReservationsDialog,
} from '@/components/foratable/FutureReservationsSection';
import { buildFutureOverview, type FutureRange } from '@/lib/foratable-future';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';

const TODAY = '2026-07-10'; // Freitag

// Sentinel-PII, die im PII-freien Popup NIE erscheinen darf.
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
    externalReservationId: 'FT-123',
    selection: 'Menü',
    ...over,
  };
}

// 2026-07-11 (Sa): 2 aktive Reservationen → 6 Personen; 1 Storno (8 Pers., zählt nicht).
// 2026-07-18 (Sa): 1 aktive Reservation → 2 Personen.
const ROWS: ReservationDetailRow[] = [
  row({ date: '2026-07-11', partySize: 4, status: 'confirmed', room: 'Terrasse' }),
  row({ date: '2026-07-11', partySize: 2, status: 'completed', room: 'Saal' }),
  row({ date: '2026-07-11', partySize: 8, status: 'cancelled' }),
  row({ date: '2026-07-18', partySize: 2, status: 'confirmed' }),
];

const RANGE: FutureRange = { kind: 'custom', from: '2026-07-10', to: '2026-07-31' };

function renderOverview(
  metric: 'persons' | 'reservations' = 'persons',
  handlers: { onOpenTotals?: () => void; onOpenDay?: (d: string) => void } = {},
) {
  const overview = buildFutureOverview(ROWS, RANGE, TODAY, metric);
  return {
    overview,
    ...render(
      <TooltipProvider>
        <FutureReservationsOverview
          overview={overview}
          metric={metric}
          onMetricChange={() => {}}
          onOpenTotals={handlers.onOpenTotals}
          onOpenDay={handlers.onOpenDay}
        />
      </TooltipProvider>,
    ),
  };
}

function renderCalendar(onDayClick: (d: string) => void, metric: 'persons' | 'reservations' = 'persons') {
  const overview = buildFutureOverview(ROWS, RANGE, TODAY, metric);
  return {
    overview,
    ...render(
      <TooltipProvider>
        <FutureCalendarSection overview={overview} metric={metric} onDayClick={onDayClick} />
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

  it('ruft onOpenTotals bei Klick auf die Summen-Karten', () => {
    const onOpenTotals = vi.fn();
    renderOverview('persons', { onOpenTotals });
    fireEvent.click(screen.getByTestId('ftr-kpi-persons'));
    fireEvent.click(screen.getByTestId('ftr-kpi-reservations'));
    expect(onOpenTotals).toHaveBeenCalledTimes(2);
  });

  it('ruft onOpenDay mit dem Datum bei Klick auf die Tages-Karten', () => {
    const onOpenDay = vi.fn();
    renderOverview('persons', { onOpenDay });
    fireEvent.click(screen.getByTestId('ftr-kpi-strongest'));
    expect(onOpenDay).toHaveBeenCalledWith('2026-07-11');
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
    renderCalendar(() => {});
    // Kalender ist standardmässig eingeklappt.
    expect(screen.queryByTestId('ftr-day-2026-07-11')).toBeNull();
    fireEvent.click(screen.getByTestId('ftr-calendar-toggle'));
    const cell = screen.getByTestId('ftr-day-2026-07-11');
    expect(cell).toBeTruthy();
    // Personen-Wert des Tages (6) sichtbar.
    expect(within(cell).getByTestId('ftr-day-persons-2026-07-11').textContent).toContain('6');
  });

  it('meldet einen Tagesklick via onDayClick (Dialog liegt bei der Seite)', () => {
    const onDayClick = vi.fn();
    renderCalendar(onDayClick);
    fireEvent.click(screen.getByTestId('ftr-calendar-toggle'));
    fireEvent.click(screen.getByTestId('ftr-day-2026-07-11'));
    expect(onDayClick).toHaveBeenCalledWith('2026-07-11');
  });
});

describe('DayReservationsDialog (PII-frei)', () => {
  it('zeigt Aggregate OHNE personenbezogene Daten', () => {
    render(
      <TooltipProvider>
        <DayReservationsDialog date="2026-07-11" detailRows={ROWS} onClose={() => {}} />
      </TooltipProvider>,
    );
    const dialog = screen.getByTestId('ftr-day-dialog');
    const text = dialog.textContent ?? '';
    expect(text).toContain('Reservationen');
    expect(text).toContain('Erwartete Personen');
    expect(text).toContain('Terrasse');
    // KEINE PII.
    expect(text).not.toContain(PII.name);
    expect(text).not.toContain(PII.phone);
    expect(dialog.querySelector('*')?.innerHTML ?? '').not.toContain('geheim@example.test');
    // KEINE Detailliste.
    expect(screen.queryByTestId('ftr-day-pii-list')).toBeNull();
  });
});

describe('DayReservationsDialog (showPii)', () => {
  it('zeigt die Detailliste inkl. PII und „Erwartete Personen" nur aktiv', () => {
    render(
      <TooltipProvider>
        <DayReservationsDialog date="2026-07-11" detailRows={ROWS} onClose={() => {}} showPii />
      </TooltipProvider>,
    );
    const dialog = screen.getByTestId('ftr-day-dialog');
    // Erwartete Personen = 6 (aktiv; Storno mit 8 zählt nicht).
    expect(dialog.textContent).toContain('Erwartete Personen');
    expect(within(dialog).getByText('6')).toBeTruthy();
    // Detailliste mit PII vorhanden.
    const list = screen.getByTestId('ftr-day-pii-list');
    expect(list.textContent).toContain(PII.name);
    // Alle 3 Tageszeilen (inkl. Storno) sind gelistet → 14 Personen.
    expect(list.textContent).toContain('3 Reservationen');
    expect(list.textContent).toContain('14 Personen');
  });

  it('filtert die Detailliste über die Status-Chips', () => {
    render(
      <TooltipProvider>
        <DayReservationsDialog date="2026-07-11" detailRows={ROWS} onClose={() => {}} showPii />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('ftr-day-status-cancelled'));
    const list = screen.getByTestId('ftr-day-pii-list');
    // Nur die Storno-Zeile bleibt (1 Reservation, 8 Personen).
    expect(list.textContent).toContain('1 Reservation');
    expect(list.textContent).toContain('8 Personen');
  });
});
