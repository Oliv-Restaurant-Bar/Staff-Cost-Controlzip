// @vitest-environment happy-dom
/**
 * BuchhaltungsExportSection.test.tsx — Komponententest des Export-Assistenten.
 * Prüft das Export-Gate per Checkliste (§2), die Monatsprüfung (§3), die
 * Buchungsvorschau (§4), den CSV-Export mit Protokoll/Versionierung (§6–§8),
 * die „Export veraltet"-Warnung (§10) sowie readOnly (Gäste) und den
 * Mapping-Fehlerpfad mit Absprung in den Konto-Mapping-Dialog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  addExportRecord,
  createExportRecord,
} from '@/lib/buchhaltungs-export';
import {
  buildTagesabschlussRows,
  closeDay,
  closeMonth,
  defaultExportSettings,
  emptyTagesabschlussBlob,
  setExportSettings,
  upsertExpense,
  upsertManualDay,
  type GnDayClosing,
  type TagesabschlussBlob,
} from '@/lib/tagesabschluss';
import { BuchhaltungsExportSection } from '../BuchhaltungsExportSection';

const downloadCsvMock = vi.fn();
vi.mock('@/lib/table-export', () => ({
  downloadCsv: (...args: unknown[]) => downloadCsvMock(...args),
}));

const loadLocalMock = vi.fn();
vi.mock('@/lib/tagesabschluss-db', () => ({
  loadTagesabschlussLocal: (...args: unknown[]) => loadLocalMock(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  cleanup();
  downloadCsvMock.mockReset();
  loadLocalMock.mockReset();
});

const NOW = '2026-07-05T10:00:00.000Z';
const MONTH_KEY = '2026-07';

const closing = (date: string): GnDayClosing => ({
  date,
  grossRevenue: 1000,
  netRevenue: 925.07,
  tip: null,
  taxes: [{ rate: '8.1%', net: 925.07, tax: 74.93, gross: 1000 }],
  payments: [
    { name: 'Bar', amount: 300, count: 1 },
    { name: 'Mastercard', amount: 500, count: 1 },
    { name: 'TWINT', amount: 200, count: 1 },
  ],
  accountingLines: [],
  paymentAccounts: [],
});

/** Gültige, geprüfte Export-Einstellungen für den Fixture-Monat (Brutto-Modell). */
const validSettings = () => ({
  ...defaultExportSettings(NOW),
  reviewed: true,
  updatedAt: NOW,
});

/**
 * Basis-Fixture: EIN Z-Bericht-Tag (01.07.) mit 2 Barausgaben, Cash Ist exakt
 * (Diff 0 grün), Tagesbestätigung + Barbestand. Optional Tag + Monat
 * abgeschlossen (vollständiger Monat) und Mapping gespeichert.
 */
function makeFixture(opts: { closed?: boolean; settings?: boolean } = {}) {
  let blob = emptyTagesabschlussBlob();
  // Bargeld Soll = 300 (Bar) − 52.50 (Ausgaben) = 247.50 → Ist exakt.
  blob = upsertManualDay(blob, '2026-07-01', { bestandKasse: 247.5 }, NOW);
  blob = upsertExpense(blob, { id: 'e1', date: '2026-07-01', amount: 40, konto: '6000', text: 'Blumen', updatedAt: NOW });
  blob = upsertExpense(blob, { id: 'e2', date: '2026-07-01', amount: 12.5, konto: '6001', text: 'Briefmarken', updatedAt: NOW });
  if (opts.settings !== false) blob = setExportSettings(blob, validSettings());

  const closings = { '2026-07-01': closing('2026-07-01') };
  const confirmations = {
    '2026-07-01': { confirmed: true, cashCounted: true, confirmedAt: NOW },
  };
  const build = (b: TagesabschlussBlob) =>
    buildTagesabschlussRows(2026, 7, closings, b, confirmations, null, 0);

  if (opts.closed) {
    const row = build(blob).rows.find(r => r.date === '2026-07-01')!;
    blob = closeDay(blob, row, 'admin@oliv.ch', NOW);
    blob = closeMonth(blob, MONTH_KEY, build(blob), 'admin@oliv.ch', NOW);
  }
  return { blob, closings, confirmations, monthData: build(blob) };
}

function renderSection(
  f: ReturnType<typeof makeFixture>,
  over: Partial<Parameters<typeof BuchhaltungsExportSection>[0]> = {},
) {
  const persist = vi.fn(async (_next: TagesabschlussBlob) => {});
  const onOpenMapping = vi.fn();
  loadLocalMock.mockReturnValue(f.blob);
  render(
    <BuchhaltungsExportSection
      tenantId="oliv"
      year={2026}
      month={7}
      monthKey={MONTH_KEY}
      monthData={f.monthData}
      closings={f.closings}
      blob={f.blob}
      readOnly={false}
      currentUser="admin@oliv.ch"
      persist={persist}
      onOpenMapping={onOpenMapping}
      {...over}
    />,
  );
  return { persist, onOpenMapping };
}

describe('BuchhaltungsExportSection — Export-Gate (§2)', () => {
  it('unvollständiger Monat: Checkliste mit offenen Punkten, Export-Button gesperrt, Status Offen', () => {
    renderSection(makeFixture({ closed: false }));
    expect(screen.getByText('Folgende Punkte müssen vor dem Export erledigt werden')).toBeTruthy();
    expect(screen.getByTestId('bx-status').textContent).toBe('Offen');
    // Tag nicht abgeschlossen + Monatsabschluss fehlt → rote Items.
    expect(screen.getByTestId('bx-check-alle_tage_abgeschlossen').textContent).toContain('1 Tag(e) noch nicht abgeschlossen');
    expect(screen.getByTestId('bx-check-monatsabschluss').textContent).toContain('noch nicht abgeschlossen');
    const btn = screen.getByTestId('bx-export-csv') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('vollständiger Monat + geprüftes Mapping: alle Punkte grün, Status Bereit, Export aktiv', () => {
    renderSection(makeFixture({ closed: true }));
    expect(screen.getByText('Alle Export-Voraussetzungen erfüllt')).toBeTruthy();
    expect(screen.getByTestId('bx-status').textContent).toBe('Bereit für Export');
    const btn = screen.getByTestId('bx-export-csv') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});

describe('BuchhaltungsExportSection — Monatsprüfung (§3) + Vorschau (§4)', () => {
  it('zeigt alle 9 Totale und die Buchungsvorschau mit Gruppen + Gesamtzeile', () => {
    renderSection(makeFixture({ closed: true }));
    expect(screen.getByTestId('bx-pruefung').querySelectorAll('[data-testid^="bx-pruefung-"]')).toHaveLength(9);
    expect(screen.getByTestId('bx-pruefung-umsatz').textContent).toContain('Umsatz Total');
    // Barausgaben erscheinen EINZELN als 2 Buchungen in der Vorschau (§5).
    expect(screen.getByTestId('bx-vorschau-barausgabe').textContent).toContain('2');
    expect(screen.getByTestId('bx-vorschau-total').textContent).toContain('Gesamt Buchungszeilen:');
    // Keine Datei bei blosser Anzeige erzeugt.
    expect(downloadCsvMock).not.toHaveBeenCalled();
  });

  it('unvollständiges Mapping blockiert die Vorschau und verlinkt in den Mapping-Dialog', () => {
    const { onOpenMapping } = renderSection(makeFixture({ closed: true, settings: false }));
    expect(screen.getByTestId('bx-mapping-errors').textContent).toContain('Konto-Mapping unvollständig');
    expect((screen.getByTestId('bx-export-csv') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('bx-open-mapping'));
    expect(onOpenMapping).toHaveBeenCalledTimes(1);
  });
});

describe('BuchhaltungsExportSection — Export, Historie, Protokoll (§6–§8)', () => {
  it('CSV-Export lädt die Datei herunter und persistiert ein Protokoll (Version 1)', () => {
    const f = makeFixture({ closed: true });
    const { persist } = renderSection(f);
    fireEvent.click(screen.getByTestId('bx-export-csv'));
    expect(downloadCsvMock).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    const saved = persist.mock.calls[0][0] as TagesabschlussBlob;
    const recs = Object.values(saved.exportProtokolle);
    expect(recs).toHaveLength(1);
    expect(recs[0].monat).toBe(MONTH_KEY);
    expect(recs[0].version).toBe(1);
    expect(recs[0].exportedBy).toBe('admin@oliv.ch');
    expect(recs[0].anzahlBuchungen).toBeGreaterThan(0);
  });

  it('Historie zeigt Versionen (jüngste zuerst) mit Benutzer, Buchungen und Export-ID', () => {
    const f = makeFixture({ closed: true });
    let blob = addExportRecord(f.blob, createExportRecord({
      blob: f.blob, monthKey: MONTH_KEY, user: 'a@oliv.ch',
      now: '2026-07-06T08:00:00.000Z', anzahlBuchungen: 9, kassensaldoEnde: 247.5,
    }));
    blob = addExportRecord(blob, createExportRecord({
      blob, monthKey: MONTH_KEY, user: 'b@oliv.ch',
      now: '2026-07-07T08:00:00.000Z', anzahlBuchungen: 9, kassensaldoEnde: 247.5,
    }));
    renderSection({ ...f, blob });
    const v2 = screen.getByTestId('bx-export-v2');
    expect(v2.textContent).toContain('Export 2');
    expect(v2.textContent).toContain('b@oliv.ch');
    expect(v2.textContent).toContain('aktuell');
    expect(screen.getByTestId('bx-export-v1').textContent).toContain('a@oliv.ch');
    expect(screen.getByTestId('bx-status').textContent).toBe('Exportiert');
  });
});

describe('BuchhaltungsExportSection — Export veraltet (§10) + readOnly', () => {
  it('Änderung nach dem Export zeigt Status + deutlichen Hinweis „Export veraltet"', () => {
    const f = makeFixture({ closed: true });
    let blob = addExportRecord(f.blob, createExportRecord({
      blob: f.blob, monthKey: MONTH_KEY, user: 'a@oliv.ch',
      now: '2026-07-06T08:00:00.000Z', anzahlBuchungen: 9, kassensaldoEnde: 247.5,
    }));
    // Nachträgliche Änderung im Monat → Fingerprint-Mismatch.
    blob = upsertExpense(blob, { id: 'e9', date: '2026-07-01', amount: 5, konto: '6002', text: 'Nachtrag', updatedAt: '2026-07-08T08:00:00.000Z' });
    renderSection({ ...f, blob });
    expect(screen.getByTestId('bx-status').textContent).toBe('Export veraltet');
    expect(screen.getByTestId('bx-veraltet-banner').textContent).toContain(
      'Der Monat wurde nach dem letzten Export geändert. Bitte neuen Export erstellen.',
    );
    expect(screen.getByTestId('bx-export-v1').textContent).toContain('veraltet');
  });

  it('Gäste (readOnly) sehen weder Export- noch PDF- noch Mapping-Buttons', () => {
    renderSection(makeFixture({ closed: true }), { readOnly: true });
    expect(screen.queryByTestId('bx-export-csv')).toBeNull();
    expect(screen.queryByTestId('bx-export-pdf')).toBeNull();
    expect(screen.queryByTestId('bx-mapping')).toBeNull();
    // Checkliste/Prüfung/Historie bleiben sichtbar.
    expect(screen.getByTestId('bx-checklist')).toBeTruthy();
    expect(screen.getByTestId('bx-pruefung')).toBeTruthy();
    expect(screen.getByTestId('bx-historie')).toBeTruthy();
  });
});
