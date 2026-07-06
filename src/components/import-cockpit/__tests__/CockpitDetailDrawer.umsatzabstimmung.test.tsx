// @vitest-environment happy-dom
/**
 * CockpitDetailDrawer — Tagesabschlüsse-spezifische Drawer-Inhalte (Quelle 'umsatzabstimmung').
 * (happy-dom statt jsdom: jsdom lädt das native `canvas`-Paket, das im
 * Replit-Container an fehlendem libuuid scheitert — happy-dom braucht es nicht.)
 * ==============================================================================
 * Prüft, dass der Drawer für die manuelle Monats-Quelle
 *   - den Pflege-Hinweis (COMPLETENESS_NOTE) zeigt,
 *   - den Button „Zu den Tagesabschlüssen" mit Ziel /umsatzabstimmung rendert.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CockpitDetailDrawer } from '../CockpitDetailDrawer';
import { COCKPIT_SOURCES, type CockpitRow } from '@/lib/import-cockpit';

function umsatzabstimmungRow(): CockpitRow {
  const def = COCKPIT_SOURCES.find((s) => s.id === 'umsatzabstimmung')!;
  return {
    def,
    signal: { latestDataDate: '2026-06' },
    result: {
      status: 'current',
      latestDataDate: '2026-06',
      daysBehind: 0,
      nextDue: '2026-07-31',
      missingDays: [],
      completeUntil: null,
      ignoredFutureDate: null,
      failed: false,
      reason: 'Letzter gepflegter Monat: Juni 2026',
    },
  };
}

describe('CockpitDetailDrawer — Tagesabschlüsse', () => {
  it('zeigt Pflege-Hinweis und Button „Zu den Tagesabschlüssen" → /umsatzabstimmung', () => {
    render(
      <MemoryRouter>
        <CockpitDetailDrawer row={umsatzabstimmungRow()} today="2026-07-06" onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Diese Daten werden manuell in den Tagesabschlüssen geprüft und bestätigt/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Zu den Tagesabschlüssen/ });
    expect(link).toHaveAttribute('href', '/umsatzabstimmung');
  });
});
