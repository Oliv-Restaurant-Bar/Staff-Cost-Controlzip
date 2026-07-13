// @vitest-environment happy-dom
/**
 * Management Report Live-Ansicht (PLView /reporting/pl, Modus „Management Report"):
 * Render-/Strukturtest — Kopfbereich, Executive Summary, KPI-Übersicht,
 * Mehrjahres-/Monatstabellen, Diagramm-Container, Top/Flop, Datenqualität,
 * Methodik, Leerzustand. recharts gestubbt, PDF-Export NICHT geklickt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('recharts', () => {
  const Stub = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub, LineChart: Stub, BarChart: Stub,
    Line: () => null, Bar: () => null, Cell: () => null,
    XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Legend: () => null, Tooltip: () => null,
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { ManagementReportView } from '@/components/reporting/ManagementReportView';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { YearSeries } from '@/lib/multi-year-analysis';

function fullYear(year: number, base: number, step = 0): YearSeries {
  return { year, values: Array.from({ length: 12 }, (_, i) => base + i * step) };
}

const SERIES: YearSeries[] = [
  fullYear(2024, 100_000),
  fullYear(2025, 110_000),
  {
    year: 2026,
    values: Array.from({ length: 12 }, (_, i) => (i < 6 ? 130_000 : null)),
  },
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderReport(series: YearSeries[] = SERIES) {
  return render(
    <TooltipProvider>
      <ManagementReportView
        series={series}
        restaurantName="Oliv"
        dataSourceHints={['Basis sind Roh-Monatswerte (reporting_v1).']}
      />
    </TooltipProvider>,
  );
}

describe('ManagementReportView', () => {
  it('rendert Toolbar (Position, Jahre, PDF-Button) und den Bericht', () => {
    renderReport();
    expect(screen.getByTestId('mrv-report')).toBeTruthy();
    expect(screen.getByTestId('mrv-position')).toBeTruthy();
    expect(screen.getByTestId('mrv-years')).toBeTruthy();
    expect(screen.getByTestId('mrv-export-pdf').textContent).toContain('Management Report PDF');
  });

  it('Kopfbereich: Firma, Titel, Periode, Erstellungsdatum, Datenstand, YTD-Kennzeichnung', () => {
    renderReport();
    const header = screen.getByTestId('mrv-header');
    expect(header.textContent).toContain('Oliv');
    expect(header.textContent).toContain('Management Report');
    expect(header.textContent).toContain('2024–2026');
    expect(header.textContent).toContain('Erstellt am');
    expect(header.textContent).toContain('Datenstand');
    expect(header.textContent).toContain('YTD'); // 2026 ist Teiljahr
  });

  it('enthält alle Berichts-Abschnitte (Summary, KPIs, Tabellen, Charts, Top/Flop, DQ, Methodik)', () => {
    renderReport();
    for (const id of [
      'mrv-summary', 'mrv-kpis', 'mrv-years-table', 'mrv-months-table',
      'mrv-charts', 'mrv-top-flop', 'mrv-data-quality', 'mrv-methodik',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('Mehrjahrestabelle nennt alle Jahre und markiert das Basisjahr', () => {
    renderReport();
    const table = screen.getByTestId('mrv-years-table');
    expect(table.textContent).toContain('2024 (Basisjahr)');
    expect(table.textContent).toContain('2025');
    expect(table.textContent).toContain('2026');
    expect(table.textContent).toContain('Teiljahr');
  });

  it('Datenqualität zeigt Teiljahr-Hinweis, Methodik nennt die Datenquelle', () => {
    renderReport();
    expect(screen.getByTestId('mrv-data-quality').textContent).toContain('2026');
    expect(screen.getByTestId('mrv-methodik').textContent).toContain('Roh-Monatswerte');
  });

  it('Top/Flop: eine Jahres-Karte pro Jahr', () => {
    renderReport();
    for (const y of [2024, 2025, 2026]) {
      expect(screen.getByTestId(`mrv-year-detail-${y}`)).toBeTruthy();
    }
  });

  it('Umsatz (revenue): Δ-Werte in der Mehrjahrestabelle sind farblich bewertet', () => {
    // Die expense-Neutralität selbst ist in der Lib getestet (toneForDeltaPct);
    // hier wird die Ton-Verdrahtung der Tabelle über den revenue-Pfad geprüft.
    renderReport();
    const table = screen.getByTestId('mrv-years-table');
    expect(table.querySelector('.text-emerald-700, .text-red-700')).toBeTruthy();
  });

  it('Leerzustand ohne Daten', () => {
    render(
      <TooltipProvider>
        <ManagementReportView series={[]} restaurantName="Oliv" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('mrv-empty')).toBeTruthy();
  });
});
