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

describe('PlanungsempfehlungenSection — Kartendarstellung', () => {
  it('zeigt Titel, Aktion, Position und Zeitfenster auf der Karte', () => {
    renderSection();
    const card = screen.getByTestId(/^reco-card-/);
    expect(card.textContent).toContain('Freitags ist der Service unterbesetzt');
    expect(card.textContent).toContain('1 Person mehr einplanen');
    expect(card.textContent).toContain('Service');
    expect(card.textContent).toContain('11:00–14:00 Uhr');
  });

  it('rendert alle sechs Filter-Chips', () => {
    renderSection();
    for (const f of ['alle', 'unterbesetzung', 'ueberbesetzung', 'schichtzeit', 'kosten', 'datenqualitaet']) {
      expect(screen.getByTestId(`reco-filter-${f}`)).toBeTruthy();
    }
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

  it('stellt Plan-, Ist- und Soll-Werte der Vergleichstage korrekt dar', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-detail-btn-/));
    const table = screen.getByTestId('reco-detail-days');
    const firstRow = within(table).getAllByRole('row')[1];
    const cells = within(firstRow).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[0]).toBe('03.07.');           // Tag
    expect(cells[1]).toBe('10.0');             // Plan h
    expect(cells[2]).toBe('12.0');             // Ist h
    expect(cells[3]).toBe('2');                // Plan Pers.
    expect(cells[4]).toBe('3');                // Ist Pers.
    expect(cells[5]).toBe('3');                // Soll
    expect(cells[6]).toContain('3');           // Umsatz CHF 3'200 (locale-Trennzeichen)
    expect(cells[6]).toContain('200');
    expect(cells[7]).toBe('45');               // Reserv. Pers.
  });

  it('zeigt „—" statt Fehler bei fehlenden Umsatz-/Reservations-/Soll-Daten', () => {
    const rec = makeRec({
      comparableDays: [
        makeDay({ date: '2026-07-03', revenue: null, persons: null, planPersons: null, istPersons: null, required: null }),
        makeDay({ date: '2026-07-10', revenue: null, persons: null, planPersons: null, istPersons: null, required: null }),
        makeDay({ date: '2026-07-17', revenue: null, persons: null, planPersons: null, istPersons: null, required: null }),
      ],
    });
    renderSection({ result: makeResult([rec]) });
    fireEvent.click(screen.getByTestId(/^reco-detail-btn-/));
    const table = screen.getByTestId('reco-detail-days');
    const firstRow = within(table).getAllByRole('row')[1];
    const cells = within(firstRow).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[3]).toBe('—');
    expect(cells[5]).toBe('—');
    expect(cells[6]).toBe('—');
    expect(cells[7]).toBe('—');
    expect(table.textContent).not.toContain('NaN');
    expect(table.textContent).not.toContain('Infinity');
  });

  it('öffnet die Details der ANGEKLICKTEN Empfehlung', () => {
    const recs = [
      makeRec({ id: 'a', title: 'Empfehlung A' }),
      makeRec({ id: 'b', title: 'Empfehlung B', type: 'kosten', tone: 'warn' }),
    ];
    renderSection({ result: makeResult(recs) });
    fireEvent.click(screen.getByTestId('reco-detail-btn-b'));
    expect(screen.getByTestId('reco-detail-dialog').textContent).toContain('Empfehlung B');
  });

  it('Escape schliesst nur den Detail-Dialog, nicht die Sektion', () => {
    const { props } = renderSection();
    fireEvent.click(screen.getByTestId(/^reco-detail-btn-/));
    const dialog = screen.getByTestId('reco-detail-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByTestId('reco-detail-dialog')).toBeNull();
    expect(screen.getByTestId('reco-section')).toBeTruthy();
    expect(screen.getAllByTestId(/^reco-card-/).length).toBeGreaterThan(0);
    expect(props.onOpenChange).not.toHaveBeenCalled();
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

  it('Stundenänderung aktualisiert Planstunden und Kosten', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    // Basis: 10 h × CHF 30/h = CHF 300; +2 h → 12 h × 30 = CHF 360
    expect(within(dialog).getByTestId('reco-sim-cost-row').textContent).toContain('300');
    fireEvent.change(within(dialog).getByTestId('reco-sim-hours'), { target: { value: '2' } });
    expect(within(dialog).getByTestId('reco-sim-hours-row').textContent).toContain('12.0 h');
    expect(within(dialog).getByTestId('reco-sim-cost-row').textContent).toContain('360');
  });

  it('Start-/Endzeit sind editierbar, wenn Soll-Zeiten vorhanden sind', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    const start = within(dialog).getByTestId('reco-sim-start') as HTMLInputElement;
    const end = within(dialog).getByTestId('reco-sim-end') as HTMLInputElement;
    expect(start.disabled).toBe(false);
    expect(end.disabled).toBe(false);
    expect(start.value).toBe('11:00');
    fireEvent.change(start, { target: { value: '12:00' } });
    expect((within(dialog).getByTestId('reco-sim-start') as HTMLInputElement).value).toBe('12:00');
    expect(dialog.textContent).not.toContain('NaN');
  });

  it('Start-/Endzeit sind deaktiviert, wenn keine Soll-Zeiten vorliegen', () => {
    const rec = makeRec({ simulationBase: makeBase({ shiftStart: null, shiftEnd: null }) });
    renderSection({ result: makeResult([rec]) });
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    expect((within(dialog).getByTestId('reco-sim-start') as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByTestId('reco-sim-end') as HTMLInputElement).disabled).toBe(true);
  });

  it('zeigt PKQ nur bei gültigem Umsatz — bei null-Umsatz „—" statt NaN/Infinity', () => {
    const rec = makeRec({ simulationBase: makeBase({ avgRevenueCHF: null }) });
    renderSection({ result: makeResult([rec]) });
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    const pkqRow = within(dialog).getByTestId('reco-sim-pkq-row');
    expect(pkqRow.textContent).toContain('—');
    expect(pkqRow.textContent).not.toContain('%');
    fireEvent.click(within(dialog).getByTestId('reco-sim-people-plus'));
    expect(dialog.textContent).not.toContain('NaN');
    expect(dialog.textContent).not.toContain('Infinity');
  });

  it('zeigt PKQ mit gültigem Umsatz (Basis 300/3000 = 10.0 %)', () => {
    renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const pkqRow = within(screen.getByTestId('reco-sim-dialog')).getByTestId('reco-sim-pkq-row');
    expect(pkqRow.textContent).toContain('10.0 %');
  });

  it('Escape schliesst nur den Simulations-Dialog, nicht die Sektion', () => {
    const { props } = renderSection();
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    fireEvent.keyDown(screen.getByTestId('reco-sim-dialog'), { key: 'Escape' });
    expect(screen.queryByTestId('reco-sim-dialog')).toBeNull();
    expect(screen.getByTestId('reco-section')).toBeTruthy();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });
});

describe('PlanungsempfehlungenSection — Accessibility', () => {
  it('rendert Sektion und beide Dialoge ohne Konsolen-Warnungen (a11y)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      renderSection();
      fireEvent.click(screen.getByTestId(/^reco-detail-btn-/));
      fireEvent.keyDown(screen.getByTestId('reco-detail-dialog'), { key: 'Escape' });
      fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
      fireEvent.keyDown(screen.getByTestId('reco-sim-dialog'), { key: 'Escape' });
      const offending = [...errSpy.mock.calls, ...warnSpy.mock.calls]
        .map((c) => String(c[0]))
        .filter((m) => m.includes('aria') || m.includes('Description') || m.includes('Warning:'));
      expect(offending).toEqual([]);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('alle Bedienelemente sind native Buttons/Inputs (Tastatur: Enter/Leertaste)', () => {
    renderSection();
    // Trigger, Filter-Chips und Karten-Aktionen sind echte <button>-Elemente,
    // Enter/Leertaste-Aktivierung ist damit Browser-Standardverhalten.
    expect(screen.getByTestId('reco-trigger').tagName).toBe('BUTTON');
    expect(screen.getByTestId('reco-filter-alle').tagName).toBe('BUTTON');
    expect(screen.getByTestId(/^reco-detail-btn-/).tagName).toBe('BUTTON');
    expect(screen.getByTestId(/^reco-sim-btn-/).tagName).toBe('BUTTON');
    fireEvent.click(screen.getByTestId(/^reco-sim-btn-/));
    const dialog = screen.getByTestId('reco-sim-dialog');
    expect(within(dialog).getByTestId('reco-sim-reset').tagName).toBe('BUTTON');
    expect(within(dialog).getByTestId('reco-sim-open-schedule').tagName).toBe('BUTTON');
    expect((within(dialog).getByTestId('reco-sim-hours') as HTMLInputElement).tagName).toBe('INPUT');
  });
});
