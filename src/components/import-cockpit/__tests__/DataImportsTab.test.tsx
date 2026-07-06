// @vitest-environment happy-dom
/**
 * DataImportsTab.test.tsx — Komponententests für den umgebauten Datenimporte-Tab.
 * (happy-dom statt jsdom: jsdom lädt das native `canvas`-Paket, das im
 * Replit-Container an fehlendem libuuid scheitert — happy-dom braucht es nicht.)
 * ==============================================================================
 * Prüft die UI-Verhalten, die reine Logik allein nicht abdecken kann:
 *   - KPI-Kacheln wirken als Toggle-Filter (aktiv markiert, erneuter Klick hebt auf)
 *   - Zeilen-Klick öffnet den Detail-Drawer (onSelect), keine „Aktion"-Spalte mehr
 *   - „Was hochladen?"-Spalte entfernt
 *   - Import-Art zeigt Dateiformat-Badges (CSV/Excel/PDF) statt „Datei-Upload"
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DataImportsTab } from '../DataImportsTab';
import type { CockpitRow, CockpitSourceDef, CockpitStatusResult } from '@/lib/import-cockpit';

function makeDef(o: Partial<CockpitSourceDef> = {}): CockpitSourceDef {
  return {
    id: 'tagesumsatz',
    label: 'Test-Quelle',
    module: 'Test-Modul',
    category: 'umsatz_gastronovi',
    section: 'import',
    tabCategory: 'umsatz',
    importType: 'file_upload',
    uploadLabel: 'Etwas hochladen',
    interval: 'daily',
    description: 'Beschreibung',
    checklistLabel: 'Aufgabe erledigen',
    checkable: true,
    ...o,
  };
}

function makeResult(o: Partial<CockpitStatusResult> = {}): CockpitStatusResult {
  return {
    status: 'current',
    latestDataDate: null,
    daysBehind: null,
    nextDue: null,
    missingDays: [],
    completeUntil: null,
    ignoredFutureDate: null,
    failed: false,
    reason: 'Grund',
    ...o,
  };
}

function makeRow(defO: Partial<CockpitSourceDef> = {}, resO: Partial<CockpitStatusResult> = {}): CockpitRow {
  return { def: makeDef(defO), signal: { latestDataDate: null }, result: makeResult(resO) };
}

/** Drei Zeilen: aktuell (CSV+PDF-Upload), überfällig (manuell), aktuell mit Datenlücke. */
function sampleRows(): CockpitRow[] {
  return [
    makeRow(
      { id: 'zbericht', label: 'Z-Bericht Quelle', importType: 'file_upload', exampleFormat: 'z.csv / .pdf' },
      { status: 'current' },
    ),
    makeRow(
      { id: 'jahresbudget', label: 'Budget Quelle', importType: 'manual_entry', exampleFormat: undefined },
      { status: 'overdue' },
    ),
    makeRow(
      { id: 'reservationen', label: 'Lücken Quelle', importType: 'file_upload', exampleFormat: 'r.csv' },
      { status: 'current', missingDays: ['2026-07-01', '2026-07-02'] },
    ),
  ];
}

function renderTab(rows: CockpitRow[] = sampleRows(), onSelect = vi.fn()) {
  render(
    <TooltipProvider>
      <DataImportsTab importRows={rows} onSelect={onSelect} />
    </TooltipProvider>,
  );
  return onSelect;
}

describe('DataImportsTab — Spalten', () => {
  it('hat KEINE „Aktion"-Spalte und keine „Details"-Buttons mehr', () => {
    renderTab();
    expect(screen.queryByText('Aktion')).toBeNull();
    expect(screen.queryByRole('button', { name: /Details/ })).toBeNull();
  });

  it('hat KEINE „Was hochladen?"-Spalte mehr (uploadLabel erscheint nicht)', () => {
    renderTab();
    expect(screen.queryByText('Was hochladen?')).toBeNull();
    expect(screen.queryByText('Etwas hochladen')).toBeNull();
  });

  it('Import-Art zeigt Dateiformat-Badges statt „Datei-Upload"', () => {
    renderTab();
    expect(screen.queryByText('Datei-Upload')).toBeNull();
    expect(screen.getAllByText('CSV').length).toBeGreaterThan(0);
    expect(screen.getByText('PDF')).toBeInTheDocument();
    // Manuelle Erfassung behält ihr Import-Art-Badge (kein Dateiformat erfinden)
    expect(screen.getByText('Manuelle Eingabe')).toBeInTheDocument();
  });
});

describe('DataImportsTab — Zeilen-Klick', () => {
  it('Klick auf die Tabellenzeile ruft onSelect mit der Quellen-ID auf (Drawer)', () => {
    const onSelect = renderTab();
    fireEvent.click(screen.getByText('Z-Bericht Quelle'));
    expect(onSelect).toHaveBeenCalledWith('zbericht');
  });

  it('Zeile ist als klickbar markiert (cursor-pointer + Hover-Hintergrund)', () => {
    renderTab();
    const rowEl = screen.getByText('Budget Quelle').closest('tr')!;
    expect(rowEl.className).toContain('cursor-pointer');
    expect(rowEl.className).toMatch(/hover:bg-/);
  });

  it('Zeile ist per Tastatur erreichbar (tabIndex) und Enter/Leertaste öffnen den Drawer', () => {
    const onSelect = renderTab();
    const rowEl = screen.getByText('Z-Bericht Quelle').closest('tr')!;
    expect(rowEl.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(rowEl, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('zbericht');
    onSelect.mockClear();
    fireEvent.keyDown(rowEl, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('zbericht');
  });
});

describe('DataImportsTab — KPI-Kacheln als Toggle-Filter', () => {
  it('Klick auf „Überfällig" zeigt nur überfällige Zeilen; erneuter Klick hebt den Filter auf', () => {
    renderTab();
    const tile = screen.getByRole('button', { name: /Überfällig/ });

    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Budget Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Z-Bericht Quelle')).toBeNull();
    expect(screen.queryByText('Lücken Quelle')).toBeNull();

    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Z-Bericht Quelle')).toBeInTheDocument();
    expect(screen.getByText('Budget Quelle')).toBeInTheDocument();
    expect(screen.getByText('Lücken Quelle')).toBeInTheDocument();
  });

  it('Klick auf „Aktuell" zeigt nur aktuelle Zeilen', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Aktuell/ }));
    expect(screen.getByText('Z-Bericht Quelle')).toBeInTheDocument();
    expect(screen.getByText('Lücken Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Budget Quelle')).toBeNull();
  });

  it('Klick auf „Datenlücken" zeigt nur Zeilen mit missingDays', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Datenlücken/ }));
    expect(screen.getByText('Lücken Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Z-Bericht Quelle')).toBeNull();
    expect(screen.queryByText('Budget Quelle')).toBeNull();
  });

  it('Kachel-Wechsel: andere Kachel übernimmt den Filter (nur eine aktiv)', () => {
    renderTab();
    const overdue = screen.getByRole('button', { name: /Überfällig/ });
    const gaps = screen.getByRole('button', { name: /Datenlücken/ });

    fireEvent.click(overdue);
    fireEvent.click(gaps);
    expect(overdue).toHaveAttribute('aria-pressed', 'false');
    expect(gaps).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Lücken Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Budget Quelle')).toBeNull();
  });

  it('aktiver Kachel-Filter aktiviert „Filter zurücksetzen" und wird dadurch gelöscht', () => {
    renderTab();
    expect(screen.queryByRole('button', { name: 'Filter zurücksetzen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Überfällig/ }));
    const reset = screen.getByRole('button', { name: 'Filter zurücksetzen' });
    fireEvent.click(reset);
    expect(screen.getByText('Z-Bericht Quelle')).toBeInTheDocument();
    expect(screen.getByText('Budget Quelle')).toBeInTheDocument();
  });

  it('leerer Filter-Treffer zeigt den Leer-Hinweis', () => {
    renderTab([makeRow({ id: 'zbericht', label: 'Nur Aktuell' }, { status: 'current' })]);
    fireEvent.click(screen.getByRole('button', { name: /Überfällig/ }));
    expect(screen.getByText('Keine Datenimporte für diesen Filter.')).toBeInTheDocument();
  });
});

// ─── Monatsübersicht ──────────────────────────────────────────────────────────

const TODAY = '2026-07-06';

/** Quellen mit Monats-Zuordnung: Juli aktuell, Juni überfällig, Juli überfällig. */
function monthRows(): CockpitRow[] {
  return [
    makeRow(
      { id: 'zbericht', label: 'Juli Quelle', exampleFormat: 'z.csv' },
      { status: 'current', latestDataDate: '2026-07-05' },
    ),
    makeRow(
      { id: 'mirus', label: 'Juni Quelle', importType: 'manual_entry', exampleFormat: undefined },
      { status: 'overdue', latestDataDate: '2026-06-30' },
    ),
    makeRow(
      { id: 'tagesumsatz', label: 'Juli Überfällig Quelle', exampleFormat: 't.csv' },
      { status: 'overdue', latestDataDate: '2026-07-03' },
    ),
  ];
}

function renderMonthTab(rows: CockpitRow[] = monthRows()) {
  render(
    <TooltipProvider>
      <DataImportsTab importRows={rows} onSelect={vi.fn()} today={TODAY} />
    </TooltipProvider>,
  );
}

describe('DataImportsTab — Monatsübersicht', () => {
  it('Jahresauswahl: Standard = aktuelles Jahr, Vor/Zurück wechselt das Jahr', () => {
    renderMonthTab();
    const yearLabel = screen.getByTestId('month-overview-year');
    expect(yearLabel.textContent).toBe('2026');

    fireEvent.click(screen.getByRole('button', { name: 'Vorjahr' }));
    expect(yearLabel.textContent).toBe('2025');

    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Jahr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nächstes Jahr' }));
    expect(yearLabel.textContent).toBe('2027');
  });

  it('zeigt die Jahreszusammenfassung mit Totalen', () => {
    renderMonthTab();
    const summary = screen.getByTestId('year-summary');
    expect(summary.textContent).toContain('1 aktuell');
    expect(summary.textContent).toContain('2 überfällig');
    expect(summary.textContent).toContain('0 nie importiert');
    expect(summary.textContent).toContain('0 Lücken-Tage');
  });

  it('Monatsklick filtert die Tabelle auf den Monat; erneuter Klick hebt auf', () => {
    renderMonthTab();
    const jun = screen.getByRole('button', { name: /^Jun 2026/ });

    fireEvent.click(jun);
    expect(jun).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Juni Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Juli Quelle')).toBeNull();
    expect(screen.queryByText('Juli Überfällig Quelle')).toBeNull();

    fireEvent.click(jun);
    expect(jun).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Juli Quelle')).toBeInTheDocument();
  });

  it('„Ganzes Jahr" hebt den Monatsfilter auf', () => {
    renderMonthTab();
    const ganzesJahr = screen.getByRole('button', { name: 'Ganzes Jahr' });
    expect(ganzesJahr).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /^Jun 2026/ }));
    expect(ganzesJahr).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Juli Quelle')).toBeNull();

    fireEvent.click(ganzesJahr);
    expect(ganzesJahr).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Juli Quelle')).toBeInTheDocument();
    expect(screen.getByText('Juni Quelle')).toBeInTheDocument();
    expect(screen.getByText('Juli Überfällig Quelle')).toBeInTheDocument();
  });

  it('KPI-Kachel + Monat kombinieren (UND): Überfällig + Juli', () => {
    renderMonthTab();
    fireEvent.click(screen.getByRole('button', { name: /Überfällig/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Jul 2026/ }));

    expect(screen.getByText('Juli Überfällig Quelle')).toBeInTheDocument();
    expect(screen.queryByText('Juni Quelle')).toBeNull(); // überfällig, aber Juni
    expect(screen.queryByText('Juli Quelle')).toBeNull(); // Juli, aber aktuell
  });

  it('„Filter zurücksetzen" löscht auch den Monatsfilter', () => {
    renderMonthTab();
    fireEvent.click(screen.getByRole('button', { name: /^Jun 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Filter zurücksetzen' }));
    expect(screen.getByText('Juli Quelle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ganzes Jahr' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Jahreswechsel überträgt einen aktiven Monatsfilter aufs neue Jahr', () => {
    renderMonthTab();
    fireEvent.click(screen.getByRole('button', { name: /^Jun 2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vorjahr' }));
    const jun2025 = screen.getByRole('button', { name: /^Jun 2025/ });
    expect(jun2025).toHaveAttribute('aria-pressed', 'true');
    // Juni 2025 enthält keine der Quellen → Leer-Hinweis
    expect(screen.getByText('Keine Datenimporte für diesen Filter.')).toBeInTheDocument();
  });
});

describe('DataImportsTab — Tagesabschlüsse (monatliche manuelle Quelle)', () => {
  function umsatzabstimmungRow(): CockpitRow {
    return makeRow(
      {
        id: 'umsatzabstimmung',
        label: 'Tagesabschlüsse',
        importType: 'manual_entry',
        interval: 'monthly',
        exampleFormat: undefined,
      },
      { status: 'overdue', latestDataDate: '2026-05' },
    );
  }

  it('zeigt „Manuelle Eingabe" statt Dateiformat-Badges (kein Format erfinden)', () => {
    renderTab([umsatzabstimmungRow()]);
    expect(screen.getByText('Tagesabschlüsse')).toBeInTheDocument();
    expect(screen.getByText('Manuelle Eingabe')).toBeInTheDocument();
    expect(screen.queryByText('CSV')).toBeNull();
    expect(screen.queryByText('Excel')).toBeNull();
    expect(screen.queryByText('PDF')).toBeNull();
  });

  it('Zeilen-Klick öffnet den Drawer mit der Quellen-ID umsatzabstimmung', () => {
    const onSelect = renderTab([umsatzabstimmungRow()]);
    fireEvent.click(screen.getByText('Tagesabschlüsse'));
    expect(onSelect).toHaveBeenCalledWith('umsatzabstimmung');
  });
});
