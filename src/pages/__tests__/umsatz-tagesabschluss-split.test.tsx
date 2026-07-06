// @vitest-environment happy-dom
/**
 * Seiten-Split Umsatzabstimmung ↔ Tagesabschlüsse
 * ==============================================================================
 * Prüft die Umstrukturierung:
 *   - /umsatzabstimmung zeigt NUR die Monatsabstimmung (kein Tagesabschluss-,
 *     kein Adyen-Block), Titel „Umsatzabstimmung".
 *   - /tagesabschluesse (eigene Seite) zeigt Tagesabschluss-Übersicht + Adyen-
 *     Abgleich, Titel „Tagesabschlüsse", KEINE Monatsabstimmung.
 *   - Navigation: beide Einträge in der Gruppe „Umsatz".
 * Schwere Kinder (Sections, Stores) sind gemockt — hier geht es nur um die
 * Seitenzusammensetzung, nicht um deren Innenleben.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/components/UmsatzAbstimmung', () => ({
  UmsatzAbstimmung: () => <div data-testid="monatsabstimmung" />,
}));
vi.mock('@/components/umsatzabstimmung/TagesabschlussSection', () => ({
  TagesabschlussSection: () => <div data-testid="tagesabschluss-section" />,
}));
vi.mock('@/components/umsatzabstimmung/AdyenAbgleichSection', () => ({
  AdyenAbgleichSection: () => <div data-testid="adyen-section" />,
}));
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true, isBeaulieuManager: false, isGuest: false }),
}));
vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv', tenantKey: (k: string) => k }),
}));
vi.mock('@/lib/reporting-store', () => ({
  loadYear: () => [],
  availableYears: () => [2026],
}));
vi.mock('@/lib/gn-zbericht-db', () => ({
  loadGnRevenueForYear: async () => new Array(12).fill(0) as number[],
}));

import UmsatzAbstimmungPage from '../UmsatzAbstimmungPage';
import TagesabschluessePage from '../TagesabschluessePage';

describe('UmsatzAbstimmungPage (nur Monatsabstimmung)', () => {
  it('zeigt Titel „Umsatzabstimmung" und NUR die Monatsabstimmung', async () => {
    render(
      <MemoryRouter>
        <UmsatzAbstimmungPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Umsatzabstimmung' })).toBeInTheDocument();
    expect(screen.getByTestId('monatsabstimmung')).toBeInTheDocument();
    expect(screen.queryByTestId('tagesabschluss-section')).toBeNull();
    expect(screen.queryByTestId('adyen-section')).toBeNull();
  });
});

describe('TagesabschluessePage (eigene Seite)', () => {
  it('zeigt Titel „Tagesabschlüsse", Tagesabschluss- und Adyen-Block, keine Monatsabstimmung', async () => {
    render(
      <MemoryRouter>
        <TagesabschluessePage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Tagesabschlüsse' })).toBeInTheDocument();
    expect(
      screen.getByText(/Z-Bericht, Adyen-Abgleich, Barbestand, Barausgaben und manuelle Korrekturen/),
    ).toBeInTheDocument();
    expect(screen.getByTestId('tagesabschluss-section')).toBeInTheDocument();
    expect(screen.getByTestId('adyen-section')).toBeInTheDocument();
    expect(screen.queryByTestId('monatsabstimmung')).toBeNull();
  });
});

describe('Navigation — Gruppe „Umsatz"', () => {
  it('enthält Umsatzabstimmung (/umsatzabstimmung) UND Tagesabschlüsse (/tagesabschluesse)', async () => {
    const { NAV_GROUPS } = await import('@/components/AppNav');
    const umsatz = NAV_GROUPS.find((g: { groupLabel: string }) => g.groupLabel === 'Umsatz');
    expect(umsatz).toBeTruthy();
    const byPath = new Map(umsatz!.items.map((i: { path: string; label: string }) => [i.path, i.label]));
    expect(byPath.get('/umsatzabstimmung')).toBe('Umsatzabstimmung');
    expect(byPath.get('/tagesabschluesse')).toBe('Tagesabschlüsse');
  });
});
