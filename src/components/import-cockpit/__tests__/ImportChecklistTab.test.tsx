// @vitest-environment happy-dom
/**
 * UI-Tests ImportChecklistTab — ruhiges Cockpit in drei Bereichen:
 * «Heute» (jetzt fällig), «Diese Woche» (wöchentliche Aufgaben + Kontrollen)
 * und «Dieser Monat» (Fortschritt, Rhythmus-Gruppen, Inventur-Häkchen,
 * monatliche Kontrollen). Dazu Monatsauswahl, Import-Navigation mit
 * Konflikt-Dialog und Unterdrückung (Tagesabschluss wartet auf Z-Bericht).
 * Daten-Layer wird NICHT berührt: Coverage/Kontrollen kommen als Fixture-Props.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ImportChecklistTab } from '../ImportChecklistTab';
import { defaultImportSettings } from '@/lib/import-settings';
import type { MonthCoverage } from '@/lib/import-tasks-engine';
import type { MonthProgress } from '@/lib/import-tasks-priority';
import type { ControlRow } from '@/lib/import-cockpit-tabs';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Fixture: Juni 2026 (abgeschlossener Monat), heute = Donnerstag, 9. Juli 2026.
const TODAY = '2026-07-09';
const SETTINGS = defaultImportSettings();
const JUNE_DAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);

/** Juni komplett: alle Tages-Quellen 30 Tage, Wochen (So 07./14./21./28.06.) voll, Monats-Häkchen gesetzt. */
function fullCoverage(overrides: MonthCoverage = {}): MonthCoverage {
  return {
    zbericht: { coveredDays: JUNE_DAYS },
    gaeste_bon: { coveredDays: JUNE_DAYS },
    mirus: { coveredDays: JUNE_DAYS },
    tagesabschluss: { coveredDays: JUNE_DAYS },
    reservationen: { coveredDays: JUNE_DAYS },
    erfolgsrechnung: { monthDone: true },
    warenrechnungen: { monthDone: true },
    inventur: { monthDone: true },
    ...overrides,
  };
}

// Juli 2026 (aktueller Monat): Tages-Quellen bis gestern (08.07.) abgedeckt;
// Reservationen-Woche Mo 29.06.–So 05.07. braucht die Juni-Randtage.
const JULY_DONE_DAYS = Array.from({ length: 8 }, (_, i) => `2026-07-0${i + 1}`);
const JULY_RES_DAYS = ['2026-06-29', '2026-06-30', ...JULY_DONE_DAYS];

function julyCoverage(overrides: MonthCoverage = {}): MonthCoverage {
  return {
    zbericht: { coveredDays: JULY_DONE_DAYS },
    gaeste_bon: { coveredDays: JULY_DONE_DAYS },
    mirus: { coveredDays: JULY_DONE_DAYS },
    tagesabschluss: { coveredDays: JULY_DONE_DAYS },
    reservationen: { coveredDays: JULY_RES_DAYS },
    erfolgsrechnung: {},
    warenrechnungen: {},
    inventur: {},
    ...overrides,
  };
}

/** Minimale Kontroll-Zeile (nur die von der Liste konsumierten Felder). */
function controlRow(id: string, controlStatus: ControlRow['controlStatus'], nextDue?: string): ControlRow {
  return {
    def: { id, label: `Kontrolle ${id}`, checkable: true },
    signal: {},
    result: { status: 'ok', nextDue: nextDue ?? null },
    controlStatus,
  } as unknown as ControlRow;
}

function renderTab(props: Partial<Parameters<typeof ImportChecklistTab>[0]> = {}) {
  const onPeriodChange = vi.fn();
  const onSelectControl = vi.fn();
  const onMarkControlDone = vi.fn();
  const onToggleInventur = vi.fn();
  const utils = render(
    <MemoryRouter>
      <TooltipProvider>
        <ImportChecklistTab
          year={2026}
          month={6}
          today={TODAY}
          coverage={fullCoverage()}
          loading={false}
          settings={SETTINGS}
          onPeriodChange={onPeriodChange}
          weeklyControls={[]}
          monthlyControls={[]}
          onSelectControl={onSelectControl}
          onMarkControlDone={onMarkControlDone}
          onToggleInventur={onToggleInventur}
          {...props}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
  return { ...utils, onPeriodChange, onSelectControl, onMarkControlDone, onToggleInventur };
}

beforeEach(() => {
  cleanup();
  navigateMock.mockReset();
});

describe('ImportChecklistTab — Lade-/Leerzustand', () => {
  it('loading ohne Coverage zeigt den Ladezustand, ohne Coverage den Leerzustand', () => {
    renderTab({ coverage: null, loading: true });
    expect(screen.getByText(/Abdeckung wird ermittelt/)).toBeTruthy();
    cleanup();
    renderTab({ coverage: null, loading: false });
    expect(screen.getByText('Keine Daten')).toBeTruthy();
  });
});

describe('ImportChecklistTab — Monatsnavigation', () => {
  it('zeigt Monatslabel und ruft onPeriodChange bei Vor/Zurück mit Jahres-Rollover', () => {
    const { onPeriodChange } = renderTab({ month: 1 });
    expect(screen.getByTestId('checklist-month-label').textContent).toContain('Januar 2026');
    fireEvent.click(screen.getByTestId('checklist-prev-month'));
    expect(onPeriodChange).toHaveBeenCalledWith(2025, 12);
    fireEvent.click(screen.getByTestId('checklist-next-month'));
    expect(onPeriodChange).toHaveBeenCalledWith(2026, 2);
  });

  it('vergangener Monat: Hinweis sichtbar, «Heute»/«Diese Woche» ausgeblendet, Sprung zum aktuellen Monat', () => {
    const { onPeriodChange } = renderTab(); // Juni
    expect(screen.getByTestId('checklist-past-month-hint')).toBeTruthy();
    expect(screen.queryByTestId('cockpit-section-heute')).toBeNull();
    expect(screen.queryByTestId('cockpit-section-woche')).toBeNull();
    fireEvent.click(screen.getByTestId('checklist-today'));
    expect(onPeriodChange).toHaveBeenCalledWith(2026, 7);
  });

  it('aktueller Monat: alle drei Bereiche sichtbar, kein Vergangenheits-Hinweis', () => {
    renderTab({ month: 7, coverage: julyCoverage() });
    expect(screen.queryByTestId('checklist-past-month-hint')).toBeNull();
    expect(screen.getByTestId('cockpit-section-heute')).toBeTruthy();
    expect(screen.getByTestId('cockpit-section-woche')).toBeTruthy();
    expect(screen.getByTestId('cockpit-section-monat')).toBeTruthy();
  });
});

describe('ImportChecklistTab — Bereich «Heute»', () => {
  it('alles Fällige erledigt → positive Leermeldung', () => {
    renderTab({ month: 7, coverage: julyCoverage() });
    expect(screen.getByTestId('checklist-today-empty').textContent).toContain(
      'Für heute ist alles erledigt.',
    );
  });

  it('überfällige vor heute fälligen Aufgaben, mit Fälligkeits-Labels', () => {
    const days = JULY_DONE_DAYS.filter((d) => d !== '2026-07-08' && d !== '2026-07-05');
    renderTab({
      month: 7,
      coverage: julyCoverage({ zbericht: { coveredDays: days } }),
    });
    const card = screen.getByTestId('checklist-today-card');
    expect(screen.queryByTestId('checklist-today-empty')).toBeNull();
    // 05.07. ist 3 Tage überfällig, 08.07. heute fällig (Z-Bericht-Tag = gestern).
    expect(card.textContent).toContain('3 Tage überfällig');
    expect(card.textContent).toContain('Heute erledigen');
    const rows = Array.from(card.querySelectorAll('[data-testid^="checklist-task-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(rows.indexOf('checklist-task-zbericht:2026-07-05')).toBeLessThan(
      rows.indexOf('checklist-task-zbericht:2026-07-08'),
    );
  });

  it('Unterdrückung: Tagesabschluss ohne Z-Bericht mahnt NICHT — Hinweis statt Doppel-Warnung', () => {
    const days = JULY_DONE_DAYS.filter((d) => d !== '2026-07-08');
    renderTab({
      month: 7,
      coverage: julyCoverage({
        zbericht: { coveredDays: days },
        tagesabschluss: { coveredDays: days },
      }),
    });
    const card = screen.getByTestId('checklist-today-card');
    // Z-Bericht trägt die Warnung, der abhängige Tagesabschluss erscheint nicht.
    expect(card.querySelector('[data-testid="checklist-task-zbericht:2026-07-08"]')).toBeTruthy();
    expect(card.querySelector('[data-testid="checklist-task-tagesabschluss:2026-07-08"]')).toBeNull();
    expect(screen.getByTestId('checklist-suppressed-hint').textContent).toContain('Basis-Quelle');
    // In der Monatsgruppe steht die unterdrückte Aufgabe dezent mit «Wartet».
    expect(
      screen.getByTestId('checklist-task-tagesabschluss:2026-07-08').textContent,
    ).toContain('Wartet');
  });
});

describe('ImportChecklistTab — Bereich «Diese Woche»', () => {
  it('ohne Aufgaben und Kontrollen → Leermeldung', () => {
    renderTab({ month: 7, coverage: julyCoverage() });
    expect(screen.getByTestId('checklist-week-empty').textContent).toContain(
      'Diese Woche steht nichts weiter an.',
    );
  });

  it('wöchentliche Kontrollen: Öffnen und «Erledigt» rufen die Handler', () => {
    const { onSelectControl, onMarkControlDone } = renderTab({
      month: 7,
      coverage: julyCoverage(),
      weeklyControls: [controlRow('bankabgleich', 'due_today', '2026-07-09')],
    });
    const week = screen.getByTestId('checklist-week-card');
    expect(week.textContent).toContain('Kontrolle bankabgleich');
    expect(week.textContent).toContain('fällig 09.07.2026');
    fireEvent.click(screen.getByTestId('control-open-bankabgleich'));
    expect(onSelectControl).toHaveBeenCalledWith('bankabgleich');
    fireEvent.click(screen.getByTestId('control-done-bankabgleich'));
    expect(onMarkControlDone).toHaveBeenCalledWith(['bankabgleich']);
  });

  it('erledigte Kontrollen zeigen keinen «Erledigt»-Button', () => {
    renderTab({
      month: 7,
      coverage: julyCoverage(),
      weeklyControls: [controlRow('bankabgleich', 'done')],
    });
    expect(screen.queryByTestId('control-done-bankabgleich')).toBeNull();
  });
});

describe('ImportChecklistTab — Bereich «Dieser Monat»: Fortschritt', () => {
  it('vollständiger, abgeschlossener Monat: 100 %, «Vollständig abgeschlossen» + Abschlussmeldung', () => {
    renderTab();
    const card = screen.getByTestId('checklist-progress-card');
    expect(card.textContent).toContain('Importstatus Juni 2026');
    expect(card.textContent).toContain('100 %');
    expect(screen.getByTestId('checklist-closure-pill').textContent).toContain(
      'Vollständig abgeschlossen',
    );
    expect(screen.getByTestId('checklist-complete-message').textContent).toContain(
      'Alle Importaufgaben für Juni 2026 abgeschlossen.',
    );
  });

  it('abgelaufener Monat mit offenen Aufgaben: Abschluss-Hinweis statt Abschlussmeldung', () => {
    const days = JUNE_DAYS.filter((d) => d !== '2026-06-15');
    renderTab({ coverage: fullCoverage({ zbericht: { coveredDays: days } }) });
    expect(screen.queryByTestId('checklist-complete-message')).toBeNull();
    expect(screen.getByTestId('checklist-closure-hint').textContent).toContain(
      'Juni 2026 kann noch nicht abgeschlossen werden',
    );
    expect(screen.getByTestId('checklist-progress-label').textContent).toMatch(
      /\d+ von \d+ fälligen Aufgaben erledigt/,
    );
  });

  it('laufender Monat, alles Fällige erledigt: KEINE Abschlussmeldung, Monatsimporte folgen', () => {
    renderTab({ month: 7, coverage: julyCoverage() });
    expect(screen.queryByTestId('checklist-complete-message')).toBeNull();
    expect(screen.getByTestId('checklist-due-done-message').textContent).toContain(
      'Alle fälligen Aufgaben erledigt',
    );
    expect(screen.getByTestId('checklist-progress-label').textContent).toContain(
      'noch nicht fällig',
    );
  });

  it('Typ-Zusammenfassung zeigt offene Bereiche mit Detail', () => {
    const days = JUNE_DAYS.filter((d) => d < '2026-06-24');
    renderTab({ coverage: fullCoverage({ zbericht: { coveredDays: days } }) });
    const summary = screen.getByTestId('checklist-type-summary');
    expect(summary.textContent).toContain('Z-Bericht');
    expect(summary.textContent).toContain('24.06.–30.06.2026');
  });
});

describe('ImportChecklistTab — Aufgabenliste & Erledigte', () => {
  it('fehlender Z-Bericht-Tag erscheint als offene Zeile mit Status und Fälligkeits-Label', () => {
    const days = JUNE_DAYS.filter((d) => d !== '2026-06-15');
    renderTab({ coverage: fullCoverage({ zbericht: { coveredDays: days } }) });
    const task = screen.getByTestId('checklist-task-zbericht:2026-06-15');
    expect(task.textContent).toContain('15.06.2026');
    expect(task.textContent).toContain('Offen');
    expect(task.textContent).toContain('überfällig');
  });

  it('Erledigte sind eingeklappt und über den Schalter sichtbar', () => {
    renderTab();
    expect(screen.queryByTestId('checklist-task-zbericht:2026-06-01')).toBeNull();
    fireEvent.click(screen.getByTestId('checklist-show-done'));
    expect(screen.getByTestId('checklist-task-zbericht:2026-06-01')).toBeTruthy();
  });

  it('Coverage-Fehler wird als sichtbare Fehler-Aufgabe gerendert (kein stilles Verschlucken)', () => {
    renderTab({ coverage: fullCoverage({ mirus: { error: 'DB nicht erreichbar' } }) });
    const task = screen.getByTestId('checklist-task-mirus:error');
    expect(task.textContent).toContain('DB nicht erreichbar');
  });

  it('Inventur: manuelles Häkchen statt Import-Button, Toggle ruft den Handler', () => {
    const { onToggleInventur } = renderTab({ coverage: fullCoverage({ inventur: {} }) });
    const task = screen.getByTestId('checklist-task-inventur:2026-06');
    expect(task.querySelector('[data-testid^="checklist-import-"]')).toBeNull();
    fireEvent.click(screen.getByTestId('checklist-inventur-check'));
    expect(onToggleInventur).toHaveBeenCalledWith(true);
  });

  it('monatliche Kontrollen erscheinen nur im aktuellen Monat', () => {
    const controls = [controlRow('monatskontrolle', 'due_soon')];
    renderTab({ monthlyControls: controls }); // Juni (vergangen)
    expect(screen.queryByTestId('checklist-monthly-controls')).toBeNull();
    cleanup();
    renderTab({ month: 7, coverage: julyCoverage(), monthlyControls: controls });
    expect(screen.getByTestId('checklist-monthly-controls')).toBeTruthy();
  });
});

describe('ImportChecklistTab — Import-Navigation & Konflikt-Dialog', () => {
  it('offene Aufgabe ohne Konflikt navigiert direkt mit Prefill-Params', () => {
    const days = JUNE_DAYS.filter((d) => d !== '2026-06-15');
    renderTab({ coverage: fullCoverage({ zbericht: { coveredDays: days } }) });
    fireEvent.click(screen.getByTestId('checklist-import-zbericht:2026-06-15'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/gastronovi-import?from=2026-06-15&to=2026-06-15&scope=day',
    );
  });

  it('«Ganzer Monat» auf abgedecktem Zeitraum öffnet den Konflikt-Dialog statt zu navigieren', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('checklist-full-month-zbericht'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('checklist-conflict-dialog')).toBeTruthy();
  });

  it('Konflikt-Dialog: «Ersetzen» navigiert, «Behalten» schliesst ohne Navigation', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('checklist-full-month-zbericht'));
    fireEvent.click(screen.getByTestId('conflict-replace'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/gastronovi-import?from=2026-06-01&to=2026-06-30&scope=month',
    );
    navigateMock.mockReset();
    fireEvent.click(screen.getByTestId('checklist-full-month-zbericht'));
    fireEvent.click(screen.getByTestId('conflict-keep'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('checklist-conflict-dialog')).toBeNull();
  });

  it('Monats-Quellen haben keinen «Ganzer Monat»-Button', () => {
    renderTab();
    expect(screen.queryByTestId('checklist-full-month-erfolgsrechnung')).toBeNull();
    expect(screen.queryByTestId('checklist-full-month-inventur')).toBeNull();
  });
});

describe('ImportChecklistTab — Monatsauswahl mit Fortschritt', () => {
  const may: MonthProgress = {
    total: 40,
    done: 33,
    percent: 83,
    laterOpen: 0,
    openNow: 7,
    errors: 0,
    allDone: false,
    monthOver: true,
    closure: 'almost',
  };

  function renderWithPicker(extra: Partial<Parameters<typeof ImportChecklistTab>[0]> = {}) {
    return renderTab({
      monthProgress: { '2026-05': may, '2026-04': null },
      onLoadYearProgress: vi.fn(),
      ...extra,
    });
  }

  it('öffnet beim Klick aufs Monatslabel und lädt das Jahr lazy nach', () => {
    const onLoadYearProgress = vi.fn();
    renderWithPicker({ onLoadYearProgress });
    fireEvent.click(screen.getByTestId('checklist-month-label'));
    expect(screen.getByTestId('checklist-month-picker')).toBeTruthy();
    expect(onLoadYearProgress).toHaveBeenCalledWith(2026);
    fireEvent.click(screen.getByTestId('checklist-picker-prev-year'));
    expect(onLoadYearProgress).toHaveBeenCalledWith(2025);
  });

  it('zeigt Fortschritt, Fehler und «Noch nicht begonnen» pro Monat', () => {
    renderWithPicker();
    fireEvent.click(screen.getByTestId('checklist-month-label'));
    expect(screen.getByTestId('checklist-month-option-2026-05').textContent).toContain('83 %');
    expect(screen.getByTestId('checklist-month-option-2026-04').textContent).toContain('Fehler');
    // August 2026 liegt in der Zukunft (heute = Juli)
    expect(screen.getByTestId('checklist-month-option-2026-08').textContent).toContain(
      'Noch nicht begonnen',
    );
  });

  it('Monats-Klick wechselt die Periode', () => {
    const { onPeriodChange } = renderWithPicker();
    fireEvent.click(screen.getByTestId('checklist-month-label'));
    fireEvent.click(screen.getByTestId('checklist-month-option-2026-05'));
    expect(onPeriodChange).toHaveBeenCalledWith(2026, 5);
  });
});
