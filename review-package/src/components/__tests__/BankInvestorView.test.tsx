// @vitest-environment happy-dom
/**
 * Banken & Investoren Live-Ansicht (PLView /reporting, Modus „Banken & Investoren"):
 * Render-/Strukturtest — Toolbar (Jahre, „bis gleicher Monat", Exporte),
 * Datenqualität, KPIs, Sektionen, Zwischentotale, Positionstabelle,
 * Kostenstruktur, Kernaussagen, Leerzustand. recharts gestubbt,
 * Export-Buttons NICHT geklickt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub, LineChart: Stub, BarChart: Stub, ComposedChart: Stub,
    Line: () => null, Bar: () => null, Cell: () => null, Area: () => null,
    XAxis: () => null, YAxis: () => null, ReferenceLine: () => null,
    CartesianGrid: () => null, Legend: () => null, Tooltip: () => null,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BankInvestorView } from '@/components/reporting/BankInvestorView';
import { BANK_ROW_IDS } from '@/lib/bank-investor-analysis';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { YearSeries } from '@/lib/multi-year-analysis';

function makeYear(year: number, perMonth: Partial<Record<string, number>>, months = 12): YearSeries {
  const byPosition: Record<string, (number | null)[]> = {};
  for (const id of BANK_ROW_IDS) {
    const v = perMonth[id];
    byPosition[id] = Array.from({ length: 12 }, (_, m) => (m < months ? (v ?? null) : null));
  }
  return { year, values: byPosition['net_revenue'], byPosition };
}

const SERIES: YearSeries[] = [
  makeYear(2024, {
    revenue_total: 100_000, net_revenue: 100_000,
    total_cogs_direct: 28_000, total_cogs: 30_000,
    gross_profit_1: 70_000, total_personnel: 40_000, gross_profit_2: 30_000,
    total_opex: 15_000, ebitda: 15_000, total_depreciation: 5_000, ebit: 10_000,
  }),
  makeYear(2025, {
    revenue_total: 110_000, net_revenue: 110_000,
    total_cogs_direct: 29_000, total_cogs: 31_900,
    gross_profit_1: 78_100, total_personnel: 45_100, gross_profit_2: 33_000,
    total_opex: 16_000, ebitda: 17_000, total_depreciation: 5_000, ebit: 12_000,
  }, 8),
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView(series: YearSeries[] = SERIES, extra: { unmappedAccounts?: number; importStand?: string | null } = {}) {
  return render(
    <TooltipProvider>
      <BankInvestorView series={series} restaurantName="Oliv" {...extra} />
    </TooltipProvider>,
  );
}

describe('BankInvestorView', () => {
  it('rendert Toolbar mit Jahresauswahl, „bis gleicher Monat" (default AN) und Export-Buttons', () => {
    renderView();
    expect(screen.getByTestId('bank-investor-view')).toBeTruthy();
    expect(screen.getByTestId('bank-base-year').textContent).toContain('2024');
    expect(screen.getByTestId('bank-current-year').textContent).toContain('2025');
    expect(screen.getByTestId('bank-same-month').getAttribute('data-state')).toBe('checked');
    expect(screen.getByTestId('bank-export')).toBeTruthy();
  });

  it('zeigt KPIs, alle Sektionen, Zwischentotale, Positionstabelle, Kostenstruktur und Kernaussagen', () => {
    renderView();
    expect(screen.getByTestId('bank-kpis')).toBeTruthy();
    expect(screen.getByTestId('bank-kpi-umsatz')).toBeTruthy();
    expect(screen.getByTestId('bank-revenue-section')).toBeTruthy();
    expect(screen.getByTestId('bank-totals-table')).toBeTruthy();
    expect(screen.getByTestId('bank-total-ebit')).toBeTruthy();
    expect(screen.getByTestId('bank-position-table')).toBeTruthy();
    expect(screen.getByTestId('bank-pos-total_personnel')).toBeTruthy();
    expect(screen.getByTestId('bank-cost-structure')).toBeTruthy();
    expect(screen.getByTestId('bank-kernaussagen')).toBeTruthy();
  });

  it('Teiljahr erzeugt Datenqualitätshinweis; nicht gemappte Konten werden ausgewiesen', () => {
    renderView(SERIES, { unmappedAccounts: 3, importStand: '13.07.2026' });
    const dq = screen.getByTestId('bank-data-quality');
    expect(dq.textContent).toContain('2025');
    expect(dq.textContent).toContain('3 Konten');
    expect(screen.getByTestId('bank-investor-view').textContent).toContain('13.07.2026');
  });

  it('nur ein Jahr mit Daten → EmptyState statt erfundener Zahlen', () => {
    const { container } = renderView([SERIES[1]]); // Basisjahr fehlt
    expect(screen.queryByTestId('bank-kpis')).toBeNull();
    expect(container.textContent).toContain('Mindestens zwei Geschäftsjahre benötigt');
  });

  it('Leerzustand ohne Daten → EmptyState, keine KPIs/Tabellen', () => {
    const { container } = renderView([]);
    expect(screen.queryByTestId('bank-kpis')).toBeNull();
    expect(screen.queryByTestId('bank-totals-table')).toBeNull();
    expect(container.textContent).toContain('Mindestens zwei Geschäftsjahre benötigt');
  });
});
