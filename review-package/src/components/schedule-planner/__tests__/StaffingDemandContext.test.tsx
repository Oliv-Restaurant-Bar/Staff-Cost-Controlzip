// @vitest-environment happy-dom
/**
 * Tests für StaffingDemandContext (Kompakt-Variante fürs DayStaffingBadge-
 * Popover). Der Hook wird gemockt — Gating/Fetch stecken im Hook selbst und
 * sind über den 'hidden'-Status abgedeckt: hidden/unavailable dürfen NICHTS
 * rendern (Manager/Gäste sehen keinen Nachfrage-Kontext).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { DayDemandState } from '@/hooks/useDayDemandContext';
import type { DayDemandContext as DayDemandContextData } from '@/lib/staffing-demand-context';

const mockState: { value: DayDemandState } = { value: { status: 'hidden' } };

vi.mock('@/hooks/useDayDemandContext', () => ({
  useDayDemandContext: () => mockState.value,
}));

import { StaffingDemandContext } from '@/components/schedule-planner/StaffingDemandContext';

const CONTEXT: DayDemandContextData = {
  date: '2026-10-05',
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

afterEach(cleanup);

describe('StaffingDemandContext (compact)', () => {
  it('hidden → rendert NICHTS (Gating für Manager/Gäste)', () => {
    mockState.value = { status: 'hidden' };
    const { container } = render(<StaffingDemandContext date="2026-10-05" compact />);
    expect(container.innerHTML).toBe('');
  });

  it('unavailable → rendert NICHTS (Tabellen nicht eingerichtet)', () => {
    mockState.value = { status: 'unavailable' };
    const { container } = render(<StaffingDemandContext date="2026-10-05" compact />);
    expect(container.innerHTML).toBe('');
  });

  it('ready → kompakte Zeile mit Personen, Res. und Ø-Vergleich (keine PII)', () => {
    mockState.value = { status: 'ready', context: CONTEXT };
    render(<StaffingDemandContext date="2026-10-05" compact />);
    const line = screen.getByTestId('staffing-demand-compact');
    expect(line.textContent).toContain('Erwartet:');
    expect(line.textContent).toContain('85 Pers.');
    expect(line.textContent).toContain('(23 Res.)');
    expect(line.textContent).toContain('+20 % über Ø Montag');
  });

  it('ready (Vergangenheit) → „Gebucht waren:"', () => {
    mockState.value = {
      status: 'ready',
      context: { ...CONTEXT, kind: 'past', pctDiffPersons: null },
    };
    render(<StaffingDemandContext date="2026-10-05" compact />);
    const line = screen.getByTestId('staffing-demand-compact');
    expect(line.textContent).toContain('Gebucht waren:');
    expect(line.textContent).not.toContain('Ø Montag'); // pct null → kein Vergleich
  });

  it('error → sichtbarer Hinweis statt stiller 0', () => {
    mockState.value = { status: 'error' };
    render(<StaffingDemandContext date="2026-10-05" compact />);
    expect(screen.getByTestId('staffing-demand-error').textContent).toContain(
      'Reservationsdaten konnten nicht geladen werden',
    );
  });

  it('loading → gedämpfter Lade-Hinweis', () => {
    mockState.value = { status: 'loading' };
    render(<StaffingDemandContext date="2026-10-05" compact />);
    expect(screen.getByTestId('staffing-demand-loading')).toBeTruthy();
  });
});
