// @vitest-environment node
/**
 * Schutztest: Budget-Tombstones in Read-only-Aggregatoren
 * ========================================================
 * Seit deleteBudgetYear Tombstones schreibt (deleted:true statt Hard-Delete),
 * müssen ALLE direkten budget_v1-Blob-Leser gelöschte Jahre filtern:
 *   - Import-Checkliste (budgetCoverage): Tombstone-Jahr ist NICHT «erledigt».
 *   - Import-Cockpit (jahresbudgetSignal): Tombstone-Jahre zählen nicht als
 *     Datenbestand (recordCount, dataFrom/dataUntil, lastImport).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({}) } }));

import { budgetCoverage } from '../import-tasks-db';
import { jahresbudgetSignal } from '../import-cockpit-db';

const ctx = {
  tenantId: 'oliv',
  tenantKey: (key: string) => key, // Oliv = unpräfixt
};

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
});

describe('budgetCoverage (Import-Checkliste) — Tombstone-Filter', () => {
  it('vorhandenes Jahr → yearDone=true mit lastImportAt', () => {
    localStorageStore['budget_v1'] = JSON.stringify({
      2026: { year: 2026, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
    expect(budgetCoverage(ctx, 2026)).toEqual({
      yearDone: true,
      lastImportAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('Tombstone-Jahr → yearDone=false (gelöscht zählt NICHT als erledigt)', () => {
    localStorageStore['budget_v1'] = JSON.stringify({
      2026: { year: 2026, updatedAt: '2026-07-01T00:00:00.000Z', deleted: true },
    });
    expect(budgetCoverage(ctx, 2026)).toEqual({ yearDone: false });
  });

  it('fehlendes Jahr → yearDone=false', () => {
    localStorageStore['budget_v1'] = JSON.stringify({});
    expect(budgetCoverage(ctx, 2026)).toEqual({ yearDone: false });
  });
});

describe('jahresbudgetSignal (Import-Cockpit) — Tombstone-Filter', () => {
  it('Tombstone-Jahre zählen nicht als Datenbestand', () => {
    localStorageStore['budget_v1'] = JSON.stringify({
      2025: { year: 2025, updatedAt: '2026-01-01T00:00:00.000Z' },
      2026: { year: 2026, updatedAt: '2026-07-01T00:00:00.000Z', deleted: true },
    });
    const sig = jahresbudgetSignal(ctx);
    expect(sig.recordCount).toBe(1);
    expect(sig.dataFrom).toBe('2025');
    expect(sig.dataUntil).toBe('2025');
    expect(sig.lastImport?.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('nur Tombstones → leeres Signal (kein Datenbestand)', () => {
    localStorageStore['budget_v1'] = JSON.stringify({
      2026: { year: 2026, updatedAt: '2026-07-01T00:00:00.000Z', deleted: true },
    });
    expect(jahresbudgetSignal(ctx).latestDataDate).toBeNull();
  });
});
