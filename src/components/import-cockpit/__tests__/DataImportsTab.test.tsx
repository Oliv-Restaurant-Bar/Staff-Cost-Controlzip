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
