// @vitest-environment node
/**
 * Schutztest: budget_v1 KV-Backup (kein Voll-Replace mehr)
 * =========================================================
 * Deckt die geschlossene Lücke ab: Der frühere naive `kvSet(storeKey, data)`
 * in saveAll() ersetzte den GESAMTEN Supabase-Stand durch den localStorage-
 * Stand. War localStorage stale (frischer Login, anderer Browser), waren dort
 * gespeicherte Budgetjahre dauerhaft verloren.
 *
 * Getestet:
 *   1. saveBudgetYear: nur das Zieljahr wird ersetzt — Fremdjahre, die NUR
 *      remote existieren, bleiben erhalten (stale-localStorage-Szenario).
 *   2. deleteBudgetYear: explizites Löschen wird remote vollzogen (kein
 *      Union-Resurrect), Fremdjahre bleiben erhalten.
 *   3. Fremdjahr-Konflikt: neueres updatedAt gewinnt.
 *   4. Schreibfehler: wirft nicht in den Aufrufer, localStorage bleibt intakt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (vor Produktions-Import, vi.mock wird gehoisted) ───────────────────

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

const state = {
  rows: {} as Record<string, unknown>,
  failWrite: false,
  failRead: false,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) => ({ data: [], error: null }),
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            if (state.failRead) return { data: null, error: { message: 'read fail' } };
            return {
              data: state.rows[key] !== undefined ? { value: state.rows[key] } : null,
              error: null,
            };
          },
        }),
      }),
      upsert: async (row: { key: string; value: unknown }) => {
        if (state.failWrite) return { error: { message: 'write fail' } };
        state.rows[row.key] = row.value;
        return { error: null };
      },
    }),
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import {
  saveBudgetYear,
  deleteBudgetYear,
  flushBudgetKVBackups,
} from '../budget-store';
import type { BudgetYear } from '@/types/budget';

const KEY = 'test_budget_kv_guard';

function year(y: number, updatedAt: string, marker = ''): BudgetYear {
  return {
    year: y,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: updatedAt,
    updatedAt,
    ...(marker ? { copiedFromYear: Number(marker) } : {}),
  } as BudgetYear;
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.failWrite = false;
  state.failRead = false;
});

describe('budget_v1 KV-Backup — kein kompletter Blob-Replace', () => {
  it('saveBudgetYear ersetzt NUR das Zieljahr — remote-only Fremdjahre bleiben erhalten', async () => {
    // Remote (Supabase) kennt 2024 + 2025; localStorage ist stale (leer).
    state.rows[KEY] = {
      2024: year(2024, '2026-01-01T00:00:00.000Z'),
      2025: year(2025, '2026-01-01T00:00:00.000Z'),
    };

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(Object.keys(remote).sort()).toEqual(['2024', '2025', '2026']);
    expect(remote['2024']).toBeDefined();
    expect(remote['2025']).toBeDefined();
    expect(remote['2026'].year).toBe(2026);
  });

  it('deleteBudgetYear entfernt das Jahr remote (kein Union-Resurrect), Fremdjahre bleiben', async () => {
    state.rows[KEY] = {
      2024: year(2024, '2026-01-01T00:00:00.000Z'),
      2025: year(2025, '2026-01-01T00:00:00.000Z'),
    };
    localStorageStore[KEY] = JSON.stringify({
      2024: year(2024, '2026-01-01T00:00:00.000Z'),
      2025: year(2025, '2026-01-01T00:00:00.000Z'),
    });

    deleteBudgetYear(2025, KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(Object.keys(remote)).toEqual(['2024']);
  });

  it('Fremdjahr-Konflikt: neueres updatedAt gewinnt (lokal neuer als remote)', async () => {
    state.rows[KEY] = {
      2025: { ...year(2025, '2026-01-01T00:00:00.000Z'), wasAutoCalculated: true },
    };
    localStorageStore[KEY] = JSON.stringify({
      2025: year(2025, '2026-06-01T00:00:00.000Z'), // lokal neuer
    });

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    // lokale (neuere) 2025-Version gewinnt → wasAutoCalculated=false
    expect(remote['2025'].wasAutoCalculated).toBe(false);
  });

  it('Fremdjahr-Konflikt: remote gewinnt wenn remote neuer ist', async () => {
    state.rows[KEY] = {
      2025: { ...year(2025, '2026-06-01T00:00:00.000Z'), wasAutoCalculated: true },
    };
    localStorageStore[KEY] = JSON.stringify({
      2025: year(2025, '2026-01-01T00:00:00.000Z'), // lokal älter
    });

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(remote['2025'].wasAutoCalculated).toBe(true);
  });

  it('Lesefehler: Backup bricht ab — remote-only Jahre werden NIE durch lokalen Stand ersetzt', async () => {
    // Remote kennt 2025, aber der Read scheitert. Ein naiver Pfad würde den
    // rein lokalen Stand schreiben und 2025 remote löschen.
    state.rows[KEY] = { 2025: year(2025, '2026-01-01T00:00:00.000Z') };
    state.failRead = true;

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    // Remote unverändert — kein Write ohne verlässliche Remote-Basis
    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(Object.keys(remote)).toEqual(['2025']);
    // localStorage hat das Zieljahr trotzdem (Primärspeicher)
    const local = JSON.parse(localStorageStore[KEY]) as Record<string, BudgetYear>;
    expect(local['2026']).toBeDefined();
  });

  it('Schreibfehler: wirft nicht in den Aufrufer, localStorage bleibt intakt', async () => {
    state.rows[KEY] = { 2025: year(2025, '2026-01-01T00:00:00.000Z') };
    state.failWrite = true;

    expect(() => saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY)).not.toThrow();
    await flushBudgetKVBackups();

    // Remote unverändert (Schreiben schlug fehl), localStorage hat das Zieljahr
    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(Object.keys(remote)).toEqual(['2025']);
    const local = JSON.parse(localStorageStore[KEY]) as Record<string, BudgetYear>;
    expect(local['2026']).toBeDefined();
  });
});
