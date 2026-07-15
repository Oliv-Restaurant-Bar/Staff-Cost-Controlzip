// @vitest-environment happy-dom
/**
 * Pilot-Test Phase 3.1: KennzahlenBerichtPage nutzt die Design-System-
 * Bausteine (PageHeader sticky, KpiGrid mit 4 KPIs, LoadingState/EmptyState).
 * Daten-Layer vollständig gemockt — reiner Render-/Struktur-Test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'oliv' }),
}));

vi.mock('@/lib/waren-db', () => ({
  loadMonthInvoices: vi.fn(async () => []),
}));

vi.mock('@/lib/gn-personen-db', () => ({
  getGuestsForPeriod: vi.fn(async () => ({ totalGuests: 0, avgRevPerGuest: 0, rowCount: 0 })),
  getAvgReceiptForPeriod: vi.fn(async () => ({ avgReceipt: 0, rowCount: 0 })),
}));

vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ComposedChart: Stub, ResponsiveContainer: Stub,
    Bar: () => null, Line: () => null, XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
  };
});

import KennzahlenBerichtPage from '@/pages/KennzahlenBerichtPage';
import { TooltipProvider } from '@/components/ui/tooltip';

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

/** Wie im echten App-Baum: TooltipProvider ist app-weit gemountet (App.tsx). */
function renderPage() {
  return render(
    <TooltipProvider>
      <KennzahlenBerichtPage />
    </TooltipProvider>,
  );
}

describe('KennzahlenBerichtPage (Design-System-Pilot)', () => {
  it('rendert sticky PageHeader mit Titel, Info-Tip und Export-Aktion', async () => {
    const { container } = renderPage();
    expect(screen.getByRole('heading', { name: 'Kennzahlen Bericht' })).toBeTruthy();
    expect(screen.getByLabelText('Info')).toBeTruthy();
    // Einheitlicher Export-Einstieg (UnifiedExportButton) statt Einzelbutton «PDF exportieren».
    expect(screen.getByTestId('kb-export')).toBeTruthy();
    expect(screen.getByText('Exportieren')).toBeTruthy();

    const header = container.querySelector('header');
    expect(header?.className).toContain('sticky');

    await waitFor(() => expect(screen.queryByText('Lade Berichtsdaten…')).toBeNull());
  });

  it('zeigt Perioden-Toolbar und die 4 Standard-KPI-Karten', async () => {
    renderPage();
    for (const label of ['Heute', 'Gestern', 'Woche', 'Monat', 'Vormonat', 'Jahr']) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    await waitFor(() => {
      expect(screen.getByText('Nettoumsatz')).toBeTruthy();
      expect(screen.getByText('Personalkosten')).toBeTruthy();
      expect(screen.getByText('WES Total')).toBeTruthy();
      expect(screen.getByText('Abw. Budget')).toBeTruthy();
    });
  });

  it('Ansicht-Umschalter Dashboard/Excel ist im Header vorhanden', () => {
    renderPage();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Excel Vorlage')).toBeTruthy();
  });
});
