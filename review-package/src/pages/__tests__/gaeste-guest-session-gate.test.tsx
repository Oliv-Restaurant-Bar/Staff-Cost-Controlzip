// @vitest-environment happy-dom
/**
 * Gast-Session-Gating Gäste-CRM (PII-Schutz)
 * ==============================================================================
 * Regressionstest für zwei Schutzschichten:
 *   1. Navigation: ALLE Foratable-Einträge (Gäste CRM, Gäste & Reservationen,
 *      Analyse, Duplikate) tragen `hideForGuest` — Gast-Sessions sehen die
 *      Menüpunkte gar nicht (usePermissions().isAdmin schliesst Gäste ein!).
 *   2. Seiten: Gast-Session (isAdmin=true, isGuest=true) wird auf `/`
 *      umgeleitet, und es feuert KEIN einziger Gäste-PII-Fetch.
 * Schwere DB-Layer sind gemockt; die Spies stellen sicher, dass die
 * Lade-Effekte für Gäste gar nicht erst loslaufen (Effekt feuert vor Navigate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// — Gast-Session: isAdmin=true (Gast zählt als Admin), isGuest=true —
vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({
    isAdmin: true,
    isGuest: true,
    isBeaulieuManager: false,
    isBeaulieuViewer: false,
  }),
}));
vi.mock('@/contexts/GuestSessionContext', () => ({
  useGuestSession: () => ({ isGuest: true, guestMinutesLeft: 60 }),
}));
vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv', tenantKey: (k: string) => k }),
}));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// — DB-Layer: Spies, dürfen für Gäste NIE aufgerufen werden —
const fetchGuestProfiles = vi.fn(async () => []);
const fetchCompletedVisitAggregates = vi.fn(async () => new Map());
const fetchNoShowCountsByGuest = vi.fn(async () => new Map());
const fetchActiveVisitsByGuest = vi.fn(async () => new Map());
const fetchGuestById = vi.fn(async () => null);
const fetchGuestReservations = vi.fn(async () => []);
vi.mock('@/lib/reservation-crm-db', () => ({
  fetchGuestProfiles: (...a: unknown[]) => fetchGuestProfiles(...(a as [])),
  fetchCompletedVisitAggregates: (...a: unknown[]) => fetchCompletedVisitAggregates(...(a as [])),
  fetchNoShowCountsByGuest: (...a: unknown[]) => fetchNoShowCountsByGuest(...(a as [])),
  fetchActiveVisitsByGuest: (...a: unknown[]) => fetchActiveVisitsByGuest(...(a as [])),
  fetchGuestById: (...a: unknown[]) => fetchGuestById(...(a as [])),
  fetchGuestReservations: (...a: unknown[]) => fetchGuestReservations(...(a as [])),
}));
const fetchGuestCrmProfilesByIds = vi.fn(async () => new Map());
const fetchGuestCrmProfile = vi.fn(async () => null);
vi.mock('@/lib/guest-crm-profile-db', () => ({
  fetchGuestCrmProfilesByIds: (...a: unknown[]) => fetchGuestCrmProfilesByIds(...(a as [])),
  fetchGuestCrmProfile: (...a: unknown[]) => fetchGuestCrmProfile(...(a as [])),
  upsertGuestCrmProfile: vi.fn(async () => undefined),
}));
const checkReservationTablesExist = vi.fn(async () => true);
vi.mock('@/lib/reservation-import-db', () => ({
  checkReservationTablesExist: (...a: unknown[]) => checkReservationTablesExist(...(a as [])),
}));
vi.mock('@/lib/crm-activities-db', () => ({
  checkCrmActivitiesTableExist: vi.fn(async () => true),
}));
vi.mock('@/lib/table-export', () => ({
  downloadCsv: vi.fn(),
  downloadXlsx: vi.fn(),
}));

import GaesteCrmPage from '../GaesteCrmPage';
import GaesteDetailPage from '../GaesteDetailPage';
import { NAV_GROUPS } from '@/components/AppNav';

function renderAt(path: string, routePath: string, page: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={page} />
        <Route path="/" element={<div data-testid="home-redirect" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Navigation — Foratable-Gruppe für Gast-Sessions unsichtbar', () => {
  it('ALLE Foratable-Items tragen hideForGuest', () => {
    const foratable = NAV_GROUPS.find(g => g.groupLabel === 'Foratable');
    expect(foratable).toBeTruthy();
    expect(foratable!.items.length).toBeGreaterThanOrEqual(4);
    for (const item of foratable!.items) {
      expect(item.hideForGuest, `${item.path} muss hideForGuest tragen`).toBe(true);
    }
  });
});

describe('GaesteCrmPage — Gast-Session', () => {
  it('leitet auf / um und lädt KEINE Gäste-PII', async () => {
    renderAt('/gaeste', '/gaeste', <GaesteCrmPage />);
    expect(await screen.findByTestId('home-redirect')).toBeInTheDocument();
    expect(fetchGuestProfiles).not.toHaveBeenCalled();
    expect(fetchCompletedVisitAggregates).not.toHaveBeenCalled();
    expect(fetchGuestCrmProfilesByIds).not.toHaveBeenCalled();
    expect(checkReservationTablesExist).not.toHaveBeenCalled();
  });
});

describe('GaesteDetailPage — Gast-Session', () => {
  it('leitet auf / um und lädt KEINE Gäste-PII', async () => {
    renderAt('/gaeste/g-123', '/gaeste/:guestId', <GaesteDetailPage />);
    expect(await screen.findByTestId('home-redirect')).toBeInTheDocument();
    expect(fetchGuestById).not.toHaveBeenCalled();
    expect(fetchGuestReservations).not.toHaveBeenCalled();
    expect(fetchGuestCrmProfile).not.toHaveBeenCalled();
  });
});
