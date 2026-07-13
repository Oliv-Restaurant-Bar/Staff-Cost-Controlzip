// @vitest-environment happy-dom
/**
 * PlanungsempfehlungenSection.test.tsx — Komponententests für die
 * Planungsempfehlungen im Personalcontrolling (Personal FIX).
 * ==============================================================================
 * Prüft die UI-Verhalten, die die reine Logik (staffing-recommendations.test.ts)
 * nicht abdecken kann:
 *   - Sichtbarkeitsgrenze (max. 6 Karten) + „Alle anzeigen"
 *   - Typ-Filter-Chips
 *   - Detail-Dialog mit Vergleichstagen + Einschränkungen
 *   - Simulations-Dialog: Kennzeichnung „noch nicht übernommen", ± Personen,
 *     Zurücksetzen, „Im Dienstplan öffnen" (Callback, kein Schreibpfad)
 *   - Leer-/Hinweiszustände (keine Daten, kein SOLL)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlanungsempfehlungenSection } from '../PlanungsempfehlungenSection';
import type {
  StaffingRecoResult,
  StaffingRecommendation,
  ComparableDayDetail,
  SimulationBase,
  RecommendationType,
} from '@/lib/staffing-recommendations';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeDay(o: Partial<ComparableDayDetail> = {}): ComparableDayDetail {
  return {
    date: '2026-07-03',
    planH: 10,
    istH: 12,
    planCHF: 300,
    istCHF: 360,
    planPersons: 2,
    istPersons: 3,
    required: 3,
    unplanned: 0,
    absences: 0,
    revenue: 3200,
    persons: 45,
    hit: true,
    ...o,
  };
}

function makeBase(o: Partial<SimulationBase> = {}): SimulationBase {
  return {
    weekdayLabel: 'Freitag',
    positionLabel: 'Service',
    avgPlanHoursPerDay: 10,
    avgPlanHeadcount: 2,
    avgHourlyCostCHF: 30,
    avgRevenueCHF: 3000,
    requiredPersons: 3,
    shiftStart: '11:00',
    shiftEnd: '14:00',
    avgHoursPerPerson: 5,
    ...o,
  };
}

let recSeq = 0;
function makeRec(o: Partial<StaffingRecommendation> = {}): StaffingRecommendation {
  recSeq += 1;
  return {
    id: o.id ?? `unterbesetzung|5|service|v${recSeq}`,
    type: 'unterbesetzung',
    tone: 'critical',
    title: 'Freitags ist der Service unterbesetzt',
    action: 'Freitags im Service 1 Person mehr einplanen (11:00–14:00).',
    weekday: 5,
    weekdayLabel: 'Freitag',
    positionKey: 'service',
    positionLabel: 'Service',
    timeWindow: { start: '11:00', end: '14:00' },
    expectedChange: 'ca. +CHF 150 Personalkosten pro Freitag',
    reasoning: 'An 3 von 4 Freitagen lag die geplante Besetzung unter dem SOLL.',
    dataBasis: 'mittel',
    comparableDayCount: 4,
    hitDayCount: 3,
    recurrenceShare: 0.75,
    costImpactCHF: 150,
    keyMetrics: [{ label: 'Ø Plan', value: '10.0 h' }],
    comparableDays: [
      makeDay({ date: '2026-07-03' }),
      makeDay({ date: '2026-07-10', hit: false }),
      makeDay({ date: '2026-07-17' }),
      makeDay({ date: '2026-07-24' }),
    ],
    limitations: ['Keine Reservationsdaten verfügbar.'],
    simulationBase: makeBase(),
    ...o,
  };
}

function makeResult(recs: StaffingRecommendation[], o: Partial<StaffingRecoResult> = {}): StaffingRecoResult {
  return {
    recommendations: recs,
    facts: [],
    evaluatedGroups: 2,
    skippedGroups: 1,
    hasAnyData: true,
    reservationsAvailable: false,
    revenueAvailable: true,
    ...o,
  };
}

function renderSection(over: Partial<Parameters<typeof PlanungsempfehlungenSection>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    result: makeResult([makeRec()]),
    loading: false,
    season: 'standard' as const,
    onSeasonChange: vi.fn(),
    hasRequirements: true,
    monthLabel: 'Juli 2026',
    onOpenSchedule: vi.fn(),
    ...over,
  };
  const utils = render(
    <TooltipProvider>
      <PlanungsempfehlungenSection {...props} />
    </TooltipProvider>,
  );
  return { ...utils, props };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PlanungsempfehlungenSection — Grundzustände', () => {
  it('zeigt Ladezustand', () => {
    renderSection({ result: null, loading: true });
    expect(screen.getByTestId('reco-loading')).toBeTruthy();
  });

  it('zeigt Leerzustand ohne Daten', () => {
    renderSection({ result: makeResult([], { hasAnyData: false }) });
    expect(screen.getByTestId('reco-empty').textContent).toContain('Keine abgeschlossenen Tage');
  });

  it('zeigt Hinweis, wenn kein SOLL definiert ist', () => {
    renderSection({ hasRequirements: false });
    expect(screen.getByText(/keine Personalbedarf-Definitionen/i)).toBeTruthy();
  });

  it('meldet zu wenig Vergleichstage inkl. übersprungener Gruppen', () => {
    renderSection({ result: makeResult([], { skippedGroups: 3 }) });
    expect(screen.getByTestId('reco-empty').textContent).toContain('3 Gruppe(n) übersprungen');
  });

  it('Trigger meldet onOpenChange (Auf-/Zuklappen liegt beim Parent)', () => {
    const { props } = renderSection({ open: false });
    fireEvent.click(screen.getByTestId('reco-trigger'));
    expect(props.onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe('PlanungsempfehlungenSection — Karten, Limit, Filter', () => {
  it('rendert Karten mit Typ-Pill und Datenbasis', () => {
    renderSection();
    const card = screen.getByTestId(/^reco-card-/);
    expect(card.textContent).toContain('Unterbesetzung');
    expect(card.textContent).toContain('3 / 4 Tage');
    expect(card.textContent).toContain('11:00–14:00');
  });

  it('zeigt höchstens 6 Karten + „Alle anzeigen"', () => {
    const recs = Array.from({ length: 8 }, (_, i) =>
      makeRec({ id: `kosten|1|kueche|v${i}`, type: 'kosten', tone: 'warn' }),
    );
    renderSection({ result: makeResult(recs) });
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(6);
    const btn = screen.getByTestId('reco-show-all');
    expect(btn.textContent).toContain('2 weitere');
    fireEvent.click(btn);
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(8);
    expect(screen.queryByTestId('reco-show-all')).toBeNull();
  });

  it('filtert nach Typ und zeigt Zähler auf den Chips', () => {
    const recs = [
      makeRec({ id: 'a', type: 'unterbesetzung' }),
      makeRec({ id: 'b', type: 'kosten', tone: 'warn' }),
      makeRec({ id: 'c', type: 'kosten', tone: 'warn' }),
    ];
    renderSection({ result: makeResult(recs) });
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(3);
    const chip = screen.getByTestId('reco-filter-kosten');
    expect(chip.textContent).toContain('(2)');
    fireEvent.click(chip);
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(2);
    fireEvent.click(screen.getByTestId('reco-filter-unterbesetzung'));
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('reco-filter-alle'));
    expect(screen.getAllByTestId(/^reco-card-/)).toHaveLength(3);
  });

  it('zeigt Leertext, wenn der Filter nichts trifft', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('reco-filter-schichtzeit'));
    expect(screen.getByTestId('reco-empty').textContent).toContain('Keine Empfehlungen für diesen Typ');
  });
});

describe('PlanungsempfehlungenSection — Detail-Dialog', () => {
  it('öffnet Details mit Begründung, Vergleichstagen und Einschränkungen', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-detail-btn-/));
    const dialog = screen.getByTestId('reco-detail-dialog');
    expect(within(dialog).getByTestId('reco-detail-reasoning').textContent)
      .toContain('3 von 4 Freitagen');
    const table = within(dialog).getByTestId('reco-detail-days');
    // 4 Vergleichstage als Zeilen, betroffene Tage markiert
    expect(within(table).getAllByRole('row')).toHaveLength(5); // 1 Kopf + 4 Tage
    expect(within(table).getAllByText('betroffen')).toHaveLength(3);
    expect(within(dialog).getByTestId('reco-detail-limitations').textContent)
      .toContain('Keine Reservationsdaten');
  });
});

describe('PlanungsempfehlungenSection — Simulations-Dialog', () => {
  it('ist klar als Simulation gekennzeichnet und rechnet ± Personen lokal', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    expect(dialog.textContent).toContain('Simulation – noch nicht übernommen');

    // Basis: 10 h/Tag, 2 Personen à 5 h, CHF 30/h → +1 Person = 15 h
    expect(within(dialog).getByTestId('reco-sim-hours-row').textContent).toContain('10.0 h');
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-plus'));
    expect(within(dialog).getByTestId('reco-sim-people-value').textContent).toBe('+1');
    expect(within(dialog).getByTestId('reco-sim-hours-row').textContent).toContain('15.0 h');
    // Besetzung: 3 Personen vs. SOLL 3 → Diff 0.0
    expect(within(dialog).getByTestId('reco-sim-staffing-row').textContent).toContain('0.0 Pers.');
  });

  it('Zurücksetzen stellt die Basis wieder her', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-plus'));
    expect(within(dialog).getByTestId('reco-sim-people-value').textContent).toBe('+1');
    fireEvent.click(within(dialog).getByTestId('reco-sim-reset'));
    expect(within(dialog).getByTestId('reco-sim-people-value').textContent).toBe('0');
    expect(within(dialog).getByTestId('reco-sim-hours-row').textContent).toContain('10.0 h');
  });

  it('„Im Dienstplan öffnen" ruft den Callback (Navigation, kein Schreibpfad)', () => {
    const { props } = renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    fireEvent.click(screen.getByTestId('reco-sim-open-schedule'));
    expect(props.onOpenSchedule).toHaveBeenCalledTimes(1);
  });

  it('meldet unplausible Eingaben aus applySimulation (Personen unter 0)', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-minus'));
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-minus'));
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-minus'));
    expect(within(dialog).getByTestId('reco-sim-issues').textContent?.length).toBeGreaterThan(0);
  });
});
