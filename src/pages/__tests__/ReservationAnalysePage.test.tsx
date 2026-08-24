// @vitest-environment happy-dom
/**
 * UX Phase 3.2: ReservationAnalysePage nutzt die Design-System-Bausteine
 * (PageShell/PageHeader sticky, 1-Zeilen-Toolbar, KpiGrid mit 4 KPIs,
 * LoadingState/EmptyState/HintBox, table-style-Konstanten).
 * Daten-Layer vollständig gemockt — reiner Render-/Struktur-Test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv' }),
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true, canManageGuests: true }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Navigate: () => null,
}));

vi.mock('@/lib/reservation-crm-db', () => ({
  fetchReservationsInRange: vi.fn(async () => []),
}));

vi.mock('@/lib/reservation-import-db', () => ({
  checkReservationTablesExist: vi.fn(async () => true),
}));

vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub, BarChart: Stub,
    Bar: () => null, XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Legend: () => null, Tooltip: () => null,
  };
});

import ReservationAnalysePage from '@/pages/ReservationAnalysePage';
import { TooltipProvider } from '@/components/ui/tooltip';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Wie im echten App-Baum: TooltipProvider ist app-weit gemountet (App.tsx). */
function renderPage() {
  return render(
    <TooltipProvider>
      <ReservationAnalysePage />
    </TooltipProvider>,
  );
}

describe('ReservationAnalysePage (Design-System Phase 3.2)', () => {
  it('rendert sticky PageHeader mit Titel, Info-Tip, Kennzahl-Umschalter und Gäste-CRM-Aktion', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { name: 'Reservations Analyse' })).toBeTruthy();
    expect(screen.getByLabelText('Info')).toBeTruthy();
    expect(screen.getByText('Gäste CRM')).toBeTruthy();
    expect(screen.getByText('Personen')).toBeTruthy();
    expect(screen.getByText('Reservationen')).toBeTruthy();

    const header = container.querySelector('header');
    expect(header?.className).toContain('sticky');

    await waitFor(() => expect(screen.queryByText('Lade Reservationen …')).toBeNull());
  });

  it('zeigt 1-Zeilen-Toolbar (Jahr/Von/Bis, Presets, Status) und 4 KPI-Karten', async () => {
    renderPage();
    expect(screen.getByLabelText('Jahr')).toBeTruthy();
    expect(screen.getByLabelText('Von Monat')).toBeTruthy();
    expect(screen.getByLabelText('Bis Monat')).toBeTruthy();
    for (const label of ['Aktueller Monat', 'Letzter Monat', 'Aktuelles Jahr', 'Wintersaison Okt–Dez']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Ohne Storno / No-Show')).toBeTruthy();

    await waitFor(() => {
      // „Personen Ist" erscheint auch als Spaltenkopf der Monats-Tabelle → getAllByText.
      expect(screen.getAllByText('Personen Ist').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Personen Vorjahr').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Differenz').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Differenz %').length).toBeGreaterThan(0);
    });
  });

  it('zeigt die 5 Analyse-Tabs nach dem Laden', async () => {
    renderPage();
    await waitFor(() => {
      for (const tab of ['Monate', 'Wochentage', 'Saison', 'Matrix', 'Heatmap']) {
        expect(screen.getByRole('tab', { name: tab })).toBeTruthy();
      }
    });
  });
});
