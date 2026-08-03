// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-Memory-KV statt Supabase
const kv = new Map<string, unknown>();
vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => kv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { kv.set(key, value); }),
}));
vi.mock('./supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => kv.get(key) ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { kv.set(key, value); }),
}));

import {
  erstelleWarenImportSnapshot, saveWarenImportUndo, loadWarenImportUndo, undoWarenImport,
  type InvoiceEntry,
} from '@/lib/waren-db';

const inv = (id: string, net: number): InvoiceEntry => ({
  id, date: '2026-07-15', supplierName: 'Transgourmet', amountGross: net * 1.081, amountNet: net,
  vatIncluded: false, vatRate: 8.1, warenkonto: '4060', kategorie: 'food',
  createdAt: '2026-07-15T00:00:00Z', updatedAt: '2026-07-15T00:00:00Z',
} as unknown as InvoiceEntry);

beforeEach(() => kv.clear());

describe('Warenrechnungs-Import-Undo', () => {
  it('stellt exakt den Stand vor dem Import wieder her (inkl. Preis-Historie)', async () => {
    kv.set('supplier_invoices_2026-07', [inv('alt', 100)]);
    kv.set('waren_preishistorie_v1', { 'transgourmet|nr:1': { preis: 5 } });
    const vorher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    // «Import» überschreibt
    kv.set('supplier_invoices_2026-07', [inv('alt', 100), inv('neu', 40)]);
    kv.set('waren_positionen_2026-07_v1', { neu: [] });
    kv.set('waren_preishistorie_v1', { 'transgourmet|nr:1': { preis: 6 } });
    const nachher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    await saveWarenImportUndo('oliv', { typ: 'csv', zeitpunkt: '2026-07-15T10:00:00Z', label: 'CSV', anzahlRechnungen: 1, vorher, nachher });

    const rec = await undoWarenImport('oliv', 'csv');
    expect(rec.anzahlRechnungen).toBe(1);
    expect(kv.get('supplier_invoices_2026-07')).toEqual([inv('alt', 100)]);
    expect(kv.get('waren_preishistorie_v1')).toEqual({ 'transgourmet|nr:1': { preis: 5 } });
    // Slot geleert — kein zweites Undo
    expect(await loadWarenImportUndo('oliv', 'csv')).toBeNull();
    await expect(undoWarenImport('oliv', 'csv')).rejects.toThrow(/Kein rückgängig/);
  });

  it('verweigert Undo nach zwischenzeitlicher manueller Änderung', async () => {
    kv.set('supplier_invoices_2026-07', []);
    const vorher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    kv.set('supplier_invoices_2026-07', [inv('neu', 40)]);
    const nachher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    await saveWarenImportUndo('oliv', { typ: 'csv', zeitpunkt: '2026-07-15T10:00:00Z', label: 'CSV', anzahlRechnungen: 1, vorher, nachher });
    // manuelle Änderung NACH dem Import
    kv.set('supplier_invoices_2026-07', [{ ...inv('neu', 40), amountNet: 99 }]);
    await expect(undoWarenImport('oliv', 'csv')).rejects.toThrow(/manuell geändert/);
    // Bestand unangetastet
    expect((kv.get('supplier_invoices_2026-07') as InvoiceEntry[])[0].amountNet).toBe(99);
  });

  it('Property-Reihenfolge zählt nicht als Änderung (stabiler Vergleich)', async () => {
    kv.set('supplier_invoices_2026-07', []);
    const vorher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    kv.set('waren_positionen_2026-07_v1', { a: 1, b: 2 });
    const nachher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    await saveWarenImportUndo('oliv', { typ: 'csv', zeitpunkt: 'z', label: 'CSV', anzahlRechnungen: 1, vorher, nachher });
    kv.set('waren_positionen_2026-07_v1', { b: 2, a: 1 }); // gleiche Daten, andere Reihenfolge
    await expect(undoWarenImport('oliv', 'csv')).resolves.toBeTruthy();
  });

  it('Historien-Undo respektiert Jahr-Sperre und Mandanten-Trennung', async () => {
    kv.set('fs_historie_2025_v1', { alt: { datum: '2025-06-30' } });
    const vorher = await erstelleWarenImportSnapshot('oliv', { monate: [], jahre: ['2025'] });
    kv.set('fs_historie_2025_v1', { alt: { datum: '2025-06-30' }, neu: { datum: '2025-07-31' } });
    const nachher = await erstelleWarenImportSnapshot('oliv', { monate: [], jahre: ['2025'] });
    await saveWarenImportUndo('oliv', { typ: 'fs_historie', zeitpunkt: 'z', label: 'ZIP', anzahlRechnungen: 2, vorher, nachher });
    // gesperrt → verweigert
    kv.set('fs_historie_lock_v1', { '2025': true });
    await expect(undoWarenImport('oliv', 'fs_historie')).rejects.toThrow(/gesperrt/);
    // beaulieu hat KEINEN Undo-Slot (Mandanten-Trennung)
    expect(await loadWarenImportUndo('beaulieu', 'fs_historie')).toBeNull();
    // entsperrt → Undo stellt alten Stand her
    kv.set('fs_historie_lock_v1', {});
    await undoWarenImport('oliv', 'fs_historie');
    expect(kv.get('fs_historie_2025_v1')).toEqual({ alt: { datum: '2025-06-30' } });
  });
});

describe('Doppel-Undo-Wache', () => {
  it('bricht ab, wenn der Slot zwischenzeitlich ersetzt/geleert wurde', async () => {
    kv.set('supplier_invoices_2026-07', []);
    const vorher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    kv.set('supplier_invoices_2026-07', [inv('neu', 40)]);
    const nachher = await erstelleWarenImportSnapshot('oliv', { monate: ['2026-07'], mitPreisHistorie: true });
    await saveWarenImportUndo('oliv', { typ: 'csv', zeitpunkt: 'T1', label: 'CSV', anzahlRechnungen: 1, vorher, nachher });
    // «anderer Tab» ersetzt den Slot NACH dem Laden, VOR dem Restore:
    const { kvGet } = await import('@/lib/supabase-kv');
    const orig = (kvGet as ReturnType<typeof vi.fn>).getMockImplementation()!;
    let einmal = false;
    (kvGet as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      const wert = await orig(key);
      if (!einmal && key === 'waren_import_undo_csv_v1') {
        einmal = true; // erster Load liefert T1, danach ersetzt der «andere Tab» den Slot
        kv.set('waren_import_undo_csv_v1', { typ: 'csv', zeitpunkt: 'T2', label: 'CSV', anzahlRechnungen: 9, vorher, nachher });
      }
      return wert;
    });
    await expect(undoWarenImport('oliv', 'csv')).rejects.toThrow(/ersetzt oder bereits verwendet/);
    (kvGet as ReturnType<typeof vi.fn>).mockImplementation(orig);
    // Bestand unangetastet
    expect(kv.get('supplier_invoices_2026-07')).toEqual([inv('neu', 40)]);
  });
});
