// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the three underlying status sources so this test never touches Supabase
// and can assert exactly WHICH sources get read for a given allowedSources set.
const mocks = vi.hoisted(() => ({
  fetchLatestImportRuns: vi.fn(),
  loadGnImports: vi.fn(),
  fetchImportBatches: vi.fn(),
}));

vi.mock('../import-runs-db', () => ({ fetchLatestImportRuns: mocks.fetchLatestImportRuns }));
vi.mock('../gn-zbericht-db', () => ({ loadGnImports: mocks.loadGnImports }));
vi.mock('../sales-db', () => ({ fetchImportBatches: mocks.fetchImportBatches }));

import { loadImportCenterStatuses } from '../import-center-db';
import type { ImportStatusSource } from '../import-center';

const set = (...s: ImportStatusSource[]) => new Set<ImportStatusSource>(s);

beforeEach(() => {
  mocks.fetchLatestImportRuns.mockReset().mockResolvedValue({ reservations: null, guest_export: null });
  mocks.loadGnImports.mockReset().mockResolvedValue([]);
  mocks.fetchImportBatches.mockReset().mockResolvedValue([]);
});

describe('loadImportCenterStatuses — only reads allowed status sources', () => {
  it('reads NOTHING when only "none" is allowed (e.g. beaulieu_viewer → Warenrechnungen only)', async () => {
    await loadImportCenterStatuses('r1', set('none'));
    expect(mocks.fetchLatestImportRuns).not.toHaveBeenCalled();
    expect(mocks.loadGnImports).not.toHaveBeenCalled();
    expect(mocks.fetchImportBatches).not.toHaveBeenCalled();
  });

  it('reads NOTHING for an empty allow-set', async () => {
    await loadImportCenterStatuses('r1', set());
    expect(mocks.fetchLatestImportRuns).not.toHaveBeenCalled();
    expect(mocks.loadGnImports).not.toHaveBeenCalled();
    expect(mocks.fetchImportBatches).not.toHaveBeenCalled();
  });

  it('reads ONLY product batches for beaulieu_manager scope (product_batches + none)', async () => {
    await loadImportCenterStatuses('r1', set('product_batches', 'none'));
    expect(mocks.fetchImportBatches).toHaveBeenCalledTimes(1);
    expect(mocks.fetchLatestImportRuns).not.toHaveBeenCalled();
    expect(mocks.loadGnImports).not.toHaveBeenCalled();
  });

  it('reads ALL sources for the admin scope', async () => {
    await loadImportCenterStatuses('r1', set('import_runs', 'gn_imports', 'product_batches', 'none'));
    expect(mocks.fetchLatestImportRuns).toHaveBeenCalledTimes(1);
    expect(mocks.loadGnImports).toHaveBeenCalledTimes(1);
    expect(mocks.fetchImportBatches).toHaveBeenCalledTimes(1);
  });

  it('passes the tenant restaurantId to the tenant-scoped sources', async () => {
    await loadImportCenterStatuses('rX', set('import_runs', 'gn_imports'));
    expect(mocks.fetchLatestImportRuns).toHaveBeenCalledWith('rX');
    expect(mocks.loadGnImports).toHaveBeenCalledWith('rX');
  });

  it('returns only the keys for the allowed sources', async () => {
    mocks.fetchImportBatches.mockResolvedValue([{ imported_at: '2026-06-20T10:00:00Z' }]);
    const out = await loadImportCenterStatuses('r1', set('product_batches', 'none'));
    expect(out.produktumsaetze).toBeDefined();
    expect(out.foratable).toBeUndefined();
    expect(out.gastronovi).toBeUndefined();
  });
});
