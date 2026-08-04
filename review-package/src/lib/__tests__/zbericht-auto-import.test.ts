// @vitest-environment node
// Auto-Import Z-Bericht-Inbox: ein fehlerhaftes PDF blockiert nie den Rest,
// Duplikate nie doppelt, nur Tagesimporte, Überschneidung ⇒ manuelle Prüfung,
// Download-Fehler ⇒ pending bleibt (skipped).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bewusst untypisiert (as any): die Mocks werden mit variabler Signatur
// aufgerufen (Spread aus den Wrapper-Factories) — strict:false, TS2556-frei.
/* eslint-disable @typescript-eslint/no-explicit-any */
const marks = { imported: vi.fn() as any, error: vi.fn() as any };
const dl = vi.fn() as any;
const dup = vi.fn() as any;
const overlaps = vi.fn() as any;
const save = vi.fn() as any;
const parse = vi.fn() as any;
const claim = vi.fn() as any;
const release = vi.fn() as any;

vi.mock('../zbericht-inbox-db', () => ({
  downloadZberichtInboxPdf: (...a: any[]) => dl(...a),
  markZberichtInboxImported: (...a: any[]) => marks.imported(...a),
  markZberichtInboxError: (...a: any[]) => marks.error(...a),
  claimZberichtInboxRow: (...a: any[]) => claim(...a),
  releaseZberichtInboxClaim: (...a: any[]) => release(...a),
  ZBERICHT_CLAIM_STALE_MINUTES: 10,
}));
vi.mock('../gn-zbericht-db', () => ({
  saveGnImport: (...a: any[]) => save(...a),
  checkGnChecksumDuplicate: (...a: any[]) => dup(...a),
  checkOverlappingImports: (...a: any[]) => overlaps(...a),
}));
vi.mock('../gn-pdf-text', () => ({
  extractGnPdfTextItems: vi.fn(async () => ({ hasTextLayer: true, pages: [] })),
}));
vi.mock('../gn-pdf-lines', () => ({
  reconstructGnPdfLines: vi.fn(() => []),
  detectGnPdfReportKind: vi.fn(() => ({ kind: 'zbericht', titleLine: null })),
}));
vi.mock('../gn-zbericht-pdf-parser', () => ({
  parseGnZBerichtPdf: (...a: any[]) => parse(...a),
}));
vi.mock('../gn-kpi-pdf-parser', () => ({ GN_KPI_KIND_LABELS: {} }));

import { runZberichtAutoImport, autoImportSummary, isZberichtRowClaimable } from '../zbericht-auto-import';
import type { ZberichtInboxRow } from '../zbericht-inbox-db';

// File-Polyfill für node
if (typeof File === 'undefined') {
  (globalThis as Record<string, unknown>).File = class { constructor(public parts: unknown[], public name: string) {} };
}

function row(id: string, receivedAt: string, status: ZberichtInboxRow['status'] = 'pending'): ZberichtInboxRow {
  return {
    id, restaurant_id: 'beaulieu', file_name: `${id}.pdf`, storage_path: `beaulieu/${id}.pdf`,
    file_hash: id, status, gn_import_id: null, received_at: receivedAt, imported_at: null,
  };
}

const goodParse = (day: string, checksum = 'c1') => ({
  checksum, periodFrom: day, periodTo: day,
  revenue: { totalGross: 100 }, taxes: [{}], debug: { missingSections: [] },
});

beforeEach(() => {
  vi.resetAllMocks(); // auch mockReturnValueOnce-Queues leeren (clear lässt sie stehen!)
  marks.imported.mockResolvedValue({ error: null });
  marks.error.mockResolvedValue({ error: null });
  claim.mockResolvedValue({ claimed: true, error: null });
  release.mockResolvedValue({ error: null });
  dl.mockResolvedValue({ blob: new Blob(['x']), error: null });
  dup.mockResolvedValue({ isDuplicate: false, existingId: null, existingFileName: null, existingImportedAt: null });
  overlaps.mockResolvedValue([]);
  save.mockResolvedValue({ importId: 'imp-1', error: null });
});

describe('runZberichtAutoImport', () => {
  it('importiert pending-Zeilen chronologisch, nur eigener Mandant, error-Zeilen nie', async () => {
    parse.mockReturnValue(goodParse('2026-08-01'));
    const rows = [
      row('b', '2026-08-02T02:00:00Z'),
      row('a', '2026-08-01T02:00:00Z'),
      row('e', '2026-07-30T02:00:00Z', 'error'), // kein Auto-Retry
      { ...row('x', '2026-07-29T02:00:00Z'), restaurant_id: 'oliv' }, // fremder Mandant
    ];
    const r = await runZberichtAutoImport('beaulieu', rows);
    expect(r.items.map(i => i.rowId)).toEqual(['a', 'b']); // älteste zuerst
    expect(r.importedCount).toBe(2);
    expect(marks.imported).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('ein Fehler blockiert den Rest nicht; Duplikat nie doppelt; Überschneidung ⇒ error; Download-Fehler ⇒ skipped', async () => {
    const rows = [row('ok', '1'), row('leer', '2'), row('dupl', '3'), row('overlap', '4'), row('dl', '5'), row('range', '6')];
    // WICHTIG: Reihenfolge = tatsächliche parse-Aufrufe. Die dl-Fehler-Zeile
    // erreicht parse NIE (Download bricht vorher ab) — kein Once-Wert für sie.
    parse
      .mockReturnValueOnce(goodParse('2026-08-01'))                                 // ok
      .mockReturnValueOnce({ ...goodParse('2026-08-02'), revenue: { totalGross: 0 }, taxes: [] }) // leer ⇒ error
      .mockReturnValueOnce(goodParse('2026-08-03', 'cDup'))                          // Duplikat
      .mockReturnValueOnce(goodParse('2026-08-04'))                                 // Überschneidung
      .mockReturnValueOnce({ ...goodParse('2026-08-05'), periodTo: '2026-08-06' }); // kein Tagesimport
    dup.mockImplementation(async (_t: unknown, checksum: unknown) =>
      checksum === 'cDup'
        ? { isDuplicate: true, existingId: 'existing-1', existingFileName: 'alt.pdf', existingImportedAt: null }
        : { isDuplicate: false, existingId: null, existingFileName: null, existingImportedAt: null });
    overlaps.mockImplementation(async (_t: unknown, from: unknown) => (from === '2026-08-04' ? [{ id: 'o1' }] : []));
    dl.mockImplementation(async (path: unknown) =>
      String(path).includes('dl') ? { blob: null, error: 'HTTP 500' } : { blob: new Blob(['x']), error: null });

    const r = await runZberichtAutoImport('beaulieu', rows);
    const by = Object.fromEntries(r.items.map(i => [i.rowId, i]));
    expect(by.ok.outcome).toBe('imported');
    expect(by.ok.day).toBe('2026-08-01');
    expect(by.leer.outcome).toBe('error');
    expect(by.dupl.outcome).toBe('duplicate');
    expect(by.overlap.outcome).toBe('error');
    expect(by.overlap.reason).toMatch(/überschneidet/);
    expect(by.dl.outcome).toBe('skipped'); // bleibt pending
    expect(release).toHaveBeenCalledWith('dl'); // Claim zurückgegeben
    expect(by.range.outcome).toBe('error');
    expect(by.range.reason).toMatch(/Kein Tagesimport/);
    // gespeichert wurde NUR das eine gute PDF; Duplikat als imported markiert (existing-1)
    expect(save).toHaveBeenCalledTimes(1);
    expect(marks.imported).toHaveBeenCalledWith('dupl', 'existing-1');
    expect(marks.error).toHaveBeenCalledTimes(3);
    expect(r.importedDays).toEqual(['2026-08-01']);
    expect(autoImportSummary(r)).toBe('1 importiert · 1 bereits vorhanden (übersprungen) · 3 brauchen manuelle Prüfung · 1 zurückgestellt (Download-Fehler)');
  });

  it('Cross-Tab: nur der Claim-Gewinner speichert — zwei Läufe auf derselben Zeile ⇒ genau 1 saveGnImport', async () => {
    parse.mockReturnValue(goodParse('2026-08-01'));
    // Simulierter DB-Claim: die erste Umstellung pending→processing gewinnt.
    const claimedIds = new Set<string>();
    claim.mockImplementation(async (id: string) => {
      if (claimedIds.has(id)) return { claimed: false, error: null };
      claimedIds.add(id);
      return { claimed: true, error: null };
    });
    const theRow = row('same', '2026-08-01T02:00:00Z');
    const [r1, r2] = await Promise.all([
      runZberichtAutoImport('beaulieu', [theRow]),
      runZberichtAutoImport('beaulieu', [theRow]),
    ]);
    const outcomes = [r1.items[0].outcome, r2.items[0].outcome].sort();
    expect(outcomes).toEqual(['imported', 'skipped']);
    expect(save).toHaveBeenCalledTimes(1); // NIE doppelt gespeichert
    expect(marks.imported).toHaveBeenCalledTimes(1);
  });

  it('verwaister processing-Claim ist claimbar, frischer nicht', async () => {
    parse.mockReturnValue(goodParse('2026-08-01'));
    // relative zur echten Uhr — der Runner nutzt intern Date.now()
    const now = Date.now();
    const stale = { ...row('st', '1'), status: 'processing' as const, claimed_at: new Date(now - 30 * 60_000).toISOString() };
    const fresh = { ...row('fr', '2'), status: 'processing' as const, claimed_at: new Date(now - 2 * 60_000).toISOString() };
    expect(isZberichtRowClaimable(stale, now)).toBe(true);
    expect(isZberichtRowClaimable(fresh, now)).toBe(false);
    const r = await runZberichtAutoImport('beaulieu', [stale, fresh]);
    expect(r.items.map(i => i.rowId)).toEqual(['st']); // frischer Claim nie angefasst
  });

  it('Save-Fehler ⇒ error-Status mit Grund, kein imported-Mark', async () => {
    parse.mockReturnValue(goodParse('2026-08-01'));
    save.mockResolvedValue({ importId: '', error: 'RLS verweigert' });
    const r = await runZberichtAutoImport('beaulieu', [row('a', '1')]);
    expect(r.items[0].outcome).toBe('error');
    expect(r.items[0].reason).toMatch(/RLS verweigert/);
    expect(marks.imported).not.toHaveBeenCalled();
  });
});
