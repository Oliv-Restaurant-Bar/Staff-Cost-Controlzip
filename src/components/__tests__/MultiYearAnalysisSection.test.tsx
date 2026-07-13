// @vitest-environment happy-dom
/**
 * Mehrjahresanalyse-Sektion (PLView /reporting/pl, Modus „Mehrjahre"):
 * Render-/Strukturtest — Toolbar, KPI-Karten, Executive Summary, Tabelle mit
 * 12 Monaten + Total, Jahres-Karten, Monats-Detaildialog, Leerzustand.
 * recharts gestubbt (happy-dom rendert keine SVG-Masse), Exporte NICHT geklickt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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

import { MultiYearAnalysisSection } from '@/components/reporting/MultiYearAnalysisSection';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { YearSeries } from '@/lib/multi-year-analysis';

function fullYear(year: number, base: number, step = 0): YearSeries {
  return { year, netRevenue: Array.from({ length: 12 }, (_, i) => base + i * step) };
}

const SERIES: YearSeries[] = [
  fullYear(2024, 100_000),
  fullYear(2025, 110_000),
  {
    year: 2026,
    netRevenue: Array.from({ length: 12 }, (_, i) => (i < 6 ? 130_000 : null)),
  },
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Wie im echten App-Baum: TooltipProvider ist app-weit gemountet (App.tsx). */
function renderSection(series: YearSeries[] = SERIES) {
  return render(
    <TooltipProvider>
      <MultiYearAnalysisSection series={series} restaurantName="Oliv" />
    </TooltipProvider>,
  );
}

describe('MultiYearAnalysisSection', () => {
  it('rendert Toolbar mit Jahresauswahl und beiden Export-Buttons', () => {
    renderSection();
    expect(screen.getByTestId('mya-section')).toBeTruthy();
    expect(screen.getByTestId('mya-yearcount')).toBeTruthy();
    expect(screen.getByTestId('mya-export-pdf')).toBeTruthy();
    expect(screen.getByTestId('mya-export-excel')).toBeTruthy();
  });

  it('zeigt 4 sichtbare KPI-Karten + „Weitere Kennzahlen" (MoreKpis)', () => {
    renderSection();
    for (const id of ['mya-kpi-revenue', 'mya-kpi-growth', 'mya-kpi-cagr', 'mya-kpi-trend']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId('mya-kpi-more')).toBeTruthy();
  });

  it('zeigt Executive Summary und Hinweise zur Datenbasis (Teiljahr 2026)', () => {
    renderSection();
    expect(screen.getByTestId('mya-summary')).toBeTruthy();
    expect(screen.getByTestId('mya-limitations').textContent).toContain('2026');
  });

  it('zeigt seitenspezifische dataSourceHints vor den Lib-Hinweisen', () => {
    render(
      <TooltipProvider>
        <MultiYearAnalysisSection
          series={SERIES}
          restaurantName="Oliv"
          dataSourceHints={['Basis sind Roh-Monatswerte (reporting_v1).']}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('mya-limitations').textContent).toContain('Roh-Monatswerte');
  });

  it('Tabelle: 12 Monatszeilen + Total-Zeile, Jahre im Kopf', () => {
    renderSection();
    const table = screen.getByTestId('mya-table');
    expect(table.textContent).toContain('2024');
    expect(table.textContent).toContain('2025');
    expect(table.textContent).toContain('2026');
    for (let m = 0; m < 12; m++) {
      expect(screen.getByTestId(`mya-row-${m}`)).toBeTruthy();
    }
    expect(screen.getByTestId('mya-totals-row')).toBeTruthy();
  });

  it('zeigt Charts-Container und eine Jahres-Karte pro Jahr', () => {
    renderSection();
    expect(screen.getByTestId('mya-chart-line')).toBeTruthy();
    expect(screen.getByTestId('mya-chart-bars')).toBeTruthy();
    expect(screen.getByTestId('mya-chart-waterfall')).toBeTruthy();
    for (const y of [2024, 2025, 2026]) {
      expect(screen.getByTestId(`mya-year-card-${y}`)).toBeTruthy();
    }
  });

  it('Klick auf eine Monatszeile öffnet den Detaildialog mit einer Zeile pro Jahr', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('mya-row-0'));
    expect(screen.getByTestId('mya-month-dialog')).toBeTruthy();
    for (const y of [2024, 2025, 2026]) {
      expect(screen.getByTestId(`mya-month-dialog-row-${y}`)).toBeTruthy();
    }
  });

  it('Leerzustand: ohne Daten erscheint mya-empty statt der Analyse', () => {
    renderSection([{ year: 2026, netRevenue: Array(12).fill(null) }]);
    expect(screen.getByTestId('mya-empty')).toBeTruthy();
    expect(screen.queryByTestId('mya-section')).toBeNull();
  });
});
