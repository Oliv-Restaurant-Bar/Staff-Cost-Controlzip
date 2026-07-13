// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ControllingDrilldownDialog } from '../ControllingDrilldownDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DrilldownInput } from '@/lib/personal-controlling-drilldown';
import type { ErfolgsrechnungVergleich } from '@/lib/personal-fix-reconciliation';

function makeInput(): DrilldownInput {
  return {
    year: 2026,
    month: 6,
    cutoffDay: null,
    lastCompletedDay: 30,
    employees: [
      { id: 'anna', name: 'Anna', department: 'service', position: 'service-front', isFixed: false },
      { id: 'ben',  name: 'Ben',  department: 'küche',   position: null,            isFixed: false },
    ],
    planDays: [
      { empId: 'anna', date: '2026-06-01', hours: 8, cost: 200 },
      { empId: 'ben',  date: '2026-06-01', hours: 6, cost: 120 },
    ],
    istDays: [
      { empId: 'anna', date: '2026-06-01', hours: 10, cost: 250 },
      { empId: 'ben',  date: '2026-06-01', hours: 6,  cost: 120 },
    ],
    zusatzPlanDays: [],
    zusatzIstDays: [],
    absences: [],
    overtimeDayKeys: [],
    vacationCodes: ['FE'],
    sickCodes: ['K'],
    accidentCodes: ['U'],
    dailyRevenue: { '2026-06-01': 5000 },
    fixMonthCHF: 3000,
  };
}

const bridge = {
  fixCHF: 3000,
  varArbeitPlanCHF: 320,
  varArbeitIstCHF: 370,
  ferienPlanCHF: 0,
  ferienIstCHF: 0,
  planTotalCHF: 3320,
  istTotalCHF: 3370,
};

const erOk: ErfolgsrechnungVergleich = {
  status: 'ok',
  fibuCHF: 3400,
  berechnetCHF: 3370,
  diffCHF: -30,
  berechnetPct: 10,
  fibuPct: 10.1,
  diffPp: -0.1,
  tone: 'good',
  revenueMismatch: false,
};

function renderDialog(overrides: Partial<Parameters<typeof ControllingDrilldownDialog>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <TooltipProvider>
      <ControllingDrilldownDialog
        focus="ist"
        onClose={onClose}
        monthLabel="Juni 2026"
        cutoffDay={null}
        input={makeInput()}
        bridge={bridge}
        pkqIst={11.2}
        pkqBudget={11.0}
        effectiveRevenue={30000}
        revenueIsAssumed={false}
        manualVarHours={false}
        overtimeCostCHF={0}
        er={erOk}
        {...overrides}
      />
    </TooltipProvider>,
  );
  return { onClose, ...utils };
}

describe('ControllingDrilldownDialog', () => {
  it('renders KPI summary, day table and bridge footer', () => {
    renderDialog();
    expect(screen.getByTestId('pfix-dd-dialog')).toBeTruthy();
    expect(screen.getByTestId('pfix-dd-kpis')).toBeTruthy();
    // Tageszeile vorhanden (01.06. Montag)
    expect(screen.getByTestId('pfix-dd-row-2026-06-01').textContent).toContain('Mo 01.06.');
    // Brücke zeigt SSOT-Total aus bridge (nie neu gerechnet)
    expect(screen.getByTestId('pfix-dd-footer-total').textContent).toContain('3’370');
  });

  it('switches grouping to employees and shows employee rows', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('pfix-dd-group-employee'));
    expect(screen.getByTestId('pfix-dd-row-emp:anna').textContent).toContain('Anna');
    expect(screen.getByTestId('pfix-dd-row-emp:ben').textContent).toContain('Ben');
    // Zeitperioden-Umschalter nur bei Tagesgruppierung
    expect(screen.queryByTestId('pfix-dd-period-week')).toBeNull();
  });

  it('filters rows via search', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('pfix-dd-group-employee'));
    fireEvent.change(screen.getByTestId('pfix-dd-search'), { target: { value: 'Anna' } });
    expect(screen.getByTestId('pfix-dd-row-emp:anna')).toBeTruthy();
    expect(screen.queryByTestId('pfix-dd-row-emp:ben')).toBeNull();
  });

  it('shows main-cause sentence for over-plan days', () => {
    renderDialog();
    expect(screen.getByTestId('pfix-dd-sentence').textContent).toContain('Hauptsächlich verursacht durch');
  });

  it('shows manual-adjustment hint when varHours are overridden', () => {
    renderDialog({ manualVarHours: true });
    expect(screen.getByTestId('pfix-dd-hint-manual').textContent).toContain('Manuelle Anpassung aktiv');
  });

  it('renders the monthly ER bridge for focus=er (no day table)', () => {
    renderDialog({ focus: 'er' });
    expect(screen.getByTestId('pfix-dd-er-bridge')).toBeTruthy();
    expect(screen.getByTestId('pfix-dd-er-diff').textContent).toContain('−30');
    expect(screen.queryByTestId('pfix-dd-table')).toBeNull();
  });

  it('shows missing-ER hint when er.status is missing', () => {
    renderDialog({ focus: 'er', er: { status: 'missing' } });
    expect(screen.getByText(/Erfolgsrechnung fehlt/)).toBeTruthy();
  });

  it('shows overtime note when overtime cost exists', () => {
    renderDialog({ overtimeCostCHF: 480 });
    expect(screen.getByTestId('pfix-dd-overtime-note').textContent).toContain('Überstundenkosten');
  });
});
