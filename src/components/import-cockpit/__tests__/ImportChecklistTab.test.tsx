// @vitest-environment happy-dom
/**
 * UI-Tests ImportChecklistTab — Toolbar, Aufgabenliste, Erledigte-Toggle,
 * Import-Navigation und Konflikt-Dialog (Behalten/Ersetzen/Abbrechen).
 * Daten-Layer wird NICHT berührt: Coverage kommt als Fixture-Prop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ImportChecklistTab } from '../ImportChecklistTab';
import type { MonthCoverage } from '@/lib/import-tasks-engine';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Fixture: Juni 2026 (abgeschlossener Monat), heute = 9. Juli 2026.
const TODAY = '2026-07-09';
const JUNE_DAYS = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);

function fullCoverage(overrides: MonthCoverage = {}): MonthCoverage {
  return {
    zbericht: { coveredDays: JUNE_DAYS },
    reservationen: { coveredDays: JUNE_DAYS },
    umsatz: { coveredDays: JUNE_DAYS },
    verkaufsdaten: { coveredDays: JUNE_DAYS },
    mirus: { coveredDays: JUNE_DAYS },
    marketing: { coveredDays: JUNE_DAYS },
    erfolgsrechnung: { monthDone: true },
    istkosten: { monthDone: true },
    budget: { yearDone: true },
    ...overrides,
  };
}

function renderTab(props: Partial<Parameters<typeof ImportChecklistTab>[0]> = {}) {
  const onPeriodChange = vi.fn();
  const utils = render(
    <MemoryRouter>
      <TooltipProvider>
        <ImportChecklistTab
          year={2026}
          month={6}
          today={TODAY}
          coverage={fullCoverage()}
          loading={false}
          onPeriodChange={onPeriodChange}
          {...props}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
  return { ...utils, onPeriodChange };
}

beforeEach(() => {
  cleanup();
  navigateMock.mockReset();
});

describe('ImportChecklistTab — Toolbar', () => {
  it('zeigt Monatslabel und ruft onPeriodChange bei Vor/Zurück mit Jahres-Rollover', () => {
    const { onPeriodChange } = renderTab({ month: 1 });
    expect(screen.getByTestId('checklist-month-label').textContent).toContain('Januar 2026');
    fireEvent.click(screen.getByTestId('checklist-prev-month'));
    expect(onPeriodChange).toHaveBeenCalledWith(2025, 12);
    fireEvent.click(screen.getByTestId('checklist-next-month'));
    expect(onPeriodChange).toHaveBeenCalledWith(2026, 2);
  });

  it('„Heute" springt zum aktuellen Monat und ist dort deaktiviert', () => {
    const { onPeriodChange } = renderTab();
    fireEvent.click(screen.getByTestId('checklist-today'));
    expect(onPeriodChange).toHaveBeenCalledWith(2026, 7);
    cleanup();
    renderTab({ month: 7 });
    expect((screen.getByTestId('checklist-today') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ImportChecklistTab — Aufgaben & Status', () => {
  it('vollständig abgedeckter Monat zeigt 0 offen und keine offenen Zeilen', () => {
    renderTab();
    expect(screen.getByTestId('checklist-kpis').textContent).toContain('0 offen');
    expect(screen.queryAllByText('Importieren').length).toBe(0);
  });

  it('fehlende Z-Bericht-Tage erscheinen als offene Tagesaufgaben mit Import-Button', () => {
    const days = JUNE_DAYS.filter((d) => d !== '2026-06-15');
    renderTab({ coverage: fullCoverage({ zbericht: { coveredDays: days } }) });
    const task = screen.getByTestId('checklist-task-zbericht:2026-06-15');
    expect(task.textContent).toContain('15.06.2026');
    expect(task.textContent).toContain('Offen');
  });

  it('Erledigte sind eingeklappt und per Toggle sichtbar', () => {
    renderTab();
    // Ohne Toggle: erledigte Z-Bericht-Tage hinter Collapsible
    expect(screen.queryByTestId('checklist-task-zbericht:2026-06-01')).toBeNull();
    fireEvent.click(screen.getByTestId('checklist-show-done'));
    expect(screen.getByTestId('checklist-task-zbericht:2026-06-01')).toBeTruthy();
  });

  it('Coverage-Fehler wird sichtbar als Fehler-Aufgabe gerendert (kein stilles Verschlucken)', () => {
    renderTab({ coverage: fullCoverage({ mirus: { error: 'DB nicht erreichbar' } }) });
    const task = screen.getByTestId('checklist-task-mirus:error');
    expect(task.textContent).toContain('DB nicht erreichbar');
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

  it('„Ganzer Monat" auf abgedecktem Zeitraum öffnet den Konflikt-Dialog statt zu navigieren', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('checklist-full-month-umsatz'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('checklist-conflict-dialog')).toBeTruthy();
  });

  it('Konflikt-Dialog: „Ersetzen" navigiert, „Behalten" schliesst ohne Navigation', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('checklist-full-month-umsatz'));
    fireEvent.click(screen.getByTestId('conflict-replace'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/import?target=tagesumsatz&from=2026-06-01&to=2026-06-30&scope=range',
    );
    // Erneut öffnen → Behalten
    navigateMock.mockReset();
    fireEvent.click(screen.getByTestId('checklist-full-month-umsatz'));
    fireEvent.click(screen.getByTestId('conflict-keep'));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('checklist-conflict-dialog')).toBeNull();
  });
});
