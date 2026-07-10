// @vitest-environment happy-dom
/**
 * Tests für den OP-Listen-Import-Dialog. Der PDF-Motor (pdfjs) und der DB-Layer
 * werden gemockt; der reine Parser läuft echt. Fixiert:
 *   - Gesamtsaldo erkannt → Wert sichtbar, Import freigegeben
 *   - Gesamtsaldo NICHT erkannt → „nicht erkannt", Import gesperrt bis Override
 *   - fehlende DB-Tabellen (tableMissing) sperren den Import hart
 *   - vorhandener Stichtag → Ersetzen-Hinweis + Ersetzen-Beschriftung
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import type { OpImportRecord } from '@/types/op-liste';
import type { OpPdfLine } from '@/lib/op-liste-parser';

const mockEngine = { extractPdfTextLines: vi.fn() };
const mockDb = { findActiveImport: vi.fn(), saveOpImport: vi.fn() };

vi.mock('@/lib/pdf-import-engine', () => ({
  extractPdfTextLines: (...args: unknown[]) => mockEngine.extractPdfTextLines(...args),
}));
vi.mock('@/lib/op-liste-db', () => ({
  findActiveImport: (...args: unknown[]) => mockDb.findActiveImport(...args),
  saveOpImport: (...args: unknown[]) => mockDb.saveOpImport(...args),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } },
}));

import { OpImportDialog } from '@/components/op-liste/OpImportDialog';

// ── Synthetische PDF-Zeilen (Struktur wie extractPdfTextLines liefert) ────────

function line(...parts: [number, string][]): OpPdfLine {
  const items = parts.map(([x, text]) => ({ x, text }));
  return { text: items.map(i => i.text).join(' ').replace(/\s{2,}/g, '  ').trim(), items };
}

/** Gültige OP-Liste mit erkanntem Gesamtsaldo (1 Posten, 1'250.00). */
function linesWithTotal(): OpPdfLine[] {
  return [
    line([40, 'Offene Posten mit Fälligkeiten Kreditoren']),
    line([40, 'OP-Stichdatum: 09.06.2026 / 11:57']),
    line([40, '2000 Saviva AG']),
    line([40, '01.05.2026'], [120, '12345'], [180, 'RG 4711'], [334, "1'250.00"]),
    line([40, 'Gesamt Saldo von 1 Posten:'], [340, "CHF 1'250.00"]),
  ];
}

/** Gleiche Liste, aber OHNE erkennbare Total-Zeile → Gesamtsaldo bleibt null. */
function linesWithoutTotal(): OpPdfLine[] {
  return linesWithTotal().filter(l => !l.text.startsWith('Gesamt Saldo'));
}

const existingImport: OpImportRecord = {
  id: 'existing-1',
  restaurantId: 'oliv',
  snapshotDate: '2026-06-09',
  importedAt: null,
  sourceFilename: 'op-alt.pdf',
  totalOpenAmount: 999,
  totalItems: 1,
  supplierCount: 1,
  status: 'active',
  rawTotals: null,
};

function renderDialog(props: Partial<React.ComponentProps<typeof OpImportDialog>> = {}) {
  return render(
    <OpImportDialog
      open
      onOpenChange={() => {}}
      tenantId="oliv"
      onImported={() => {}}
      {...props}
    />,
  );
}

function uploadPdf() {
  // Radix rendert den Dialog-Inhalt in einen Portal (document.body), nicht in
  // den render-Container — daher im Dokument suchen.
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['%PDF-1.4'], 'op.pdf', { type: 'application/pdf' });
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OpImportDialog — Gesamtsaldo-Gating', () => {
  it('zeigt den erkannten Gesamtsaldo und gibt den Import frei', async () => {
    mockEngine.extractPdfTextLines.mockResolvedValue({ lines: linesWithTotal(), warnings: [] });
    mockDb.findActiveImport.mockResolvedValue(null);
    renderDialog();
    uploadPdf();

    const total = await screen.findByTestId('op-preview-total');
    expect(total.textContent).toContain('1');
    expect(screen.queryByTestId('op-preview-total-missing')).toBeNull();
    const confirm = screen.getByTestId('op-import-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('sperrt den Import bei nicht erkanntem Gesamtsaldo und gibt ihn per Override frei', async () => {
    mockEngine.extractPdfTextLines.mockResolvedValue({ lines: linesWithoutTotal(), warnings: [] });
    mockDb.findActiveImport.mockResolvedValue(null);
    renderDialog();
    uploadPdf();

    await screen.findByTestId('op-preview-total-missing');
    expect(screen.getByTestId('op-total-missing-notice')).toBeTruthy();
    const confirm = screen.getByTestId('op-import-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('op-override-total'));
    expect((screen.getByTestId('op-import-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('OpImportDialog — Tabellen fehlen', () => {
  it('sperrt den Import trotz erkanntem Total, wenn die DB-Tabellen fehlen', async () => {
    mockEngine.extractPdfTextLines.mockResolvedValue({ lines: linesWithTotal(), warnings: [] });
    mockDb.findActiveImport.mockResolvedValue(null);
    renderDialog({ tableMissing: true });
    uploadPdf();

    await screen.findByTestId('op-preview-total');
    expect(screen.getByTestId('op-dialog-table-missing')).toBeTruthy();
    expect((screen.getByTestId('op-import-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('OpImportDialog — Ersetzen-Fluss', () => {
  it('zeigt den Ersetzen-Hinweis und speichert mit replaceImportId', async () => {
    mockEngine.extractPdfTextLines.mockResolvedValue({ lines: linesWithTotal(), warnings: [] });
    mockDb.findActiveImport.mockResolvedValue(existingImport);
    mockDb.saveOpImport.mockResolvedValue({ error: null });
    renderDialog();
    uploadPdf();

    await screen.findByTestId('op-preview-replace-hint');
    const confirm = screen.getByTestId('op-import-confirm') as HTMLButtonElement;
    expect(confirm.textContent).toContain('Ersetzen');
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    await vi.waitFor(() => expect(mockDb.saveOpImport).toHaveBeenCalled());
    expect(mockDb.saveOpImport.mock.calls[0][0]).toMatchObject({ replaceImportId: 'existing-1' });
  });
});
