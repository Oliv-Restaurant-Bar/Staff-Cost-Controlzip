// @vitest-environment node
/**
 * Schutztest: budget_v1 KV-Backup (kein Voll-Replace mehr)
 * =========================================================
 * Deckt die geschlossene Lücke ab: Der frühere naive `kvSet(storeKey, data)`
 * in saveAll() ersetzte den GESAMTEN Supabase-Stand durch den localStorage-
 * Stand. War localStorage stale (frischer Login, anderer Browser), waren dort
 * gespeicherte Budgetjahre dauerhaft verloren.
 *
 * Getestet (Follow-up externe Review, Befunde 1–4):
 *   1. saveBudgetYear: nur das Zieljahr wird ersetzt — Fremdjahre, die NUR
 *      remote existieren, bleiben erhalten (stale-localStorage-Szenario).
 *   2. deleteBudgetYear: schreibt einen Jahr-Tombstone (deleted+updatedAt) —
 *      ein stales Gerät kann das Jahr nicht wiederbeleben; Leser filtern.
 *   3. Auto-Seed 2026: überschreibt NIE remote bearbeitete echte Werte;
 *      bei Remote-Lesefehler wird kein Seed geschrieben; idempotent.
 *   4. Offline vs. echter Fehler: offline → Info-Hinweis, Fehler → Fehler-Toast.
 *   5. copyBudgetYear erreicht das KV-Backup (action vorhanden).
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
  failProbe: false,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) =>
          state.failProbe ? { data: null, error: { message: 'probe fail' } } : { data: [], error: null },
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

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import {
  saveBudgetYear,
  deleteBudgetYear,
  loadBudgetYear,
  availableBudgetYears,
  copyBudgetYear,
  flushBudgetKVBackups,
  STORAGE_KEY,
} from '../budget-store';
import { resetKVAvailabilityCache } from '../supabase-kv';
import { toast } from 'sonner';
import type { BudgetYear } from '@/types/budget';

const KEY = 'test_budget_kv_guard';

type StoredBudgetYear = BudgetYear & { deleted?: boolean };

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

/** Budgetjahr mit ECHTEN P&L-Werten (Marker im Januar) */
function realYear(y: number, updatedAt: string, marker: number): BudgetYear {
  return {
    ...year(y, updatedAt),
    plLineItems: [
      {
        id: 'pli_test',
        categoryId: 'cat_test',
        label: 'Testposition',
        valueType: 'chf',
        monthlyValues: [marker, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sortOrder: 1,
        isDefault: false,
      },
    ],
  } as BudgetYear;
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.failWrite = false;
  state.failRead = false;
  state.failProbe = false;
  resetKVAvailabilityCache();
  vi.clearAllMocks();
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

  it('copyBudgetYear erreicht das KV-Backup (Zieljahr wird remote geschrieben)', async () => {
    localStorageStore[KEY] = JSON.stringify({
      2025: realYear(2025, '2026-01-01T00:00:00.000Z', 500),
    });

    copyBudgetYear(2025, 2027, false, KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, BudgetYear>;
    expect(remote['2027']).toBeDefined();
    expect(remote['2027'].year).toBe(2027);
    expect(remote['2025']).toBeDefined(); // Quelle bleibt erhalten
  });
});

describe('Jahr-Tombstones (Befund 4) — Löschen überlebt stale Geräte', () => {
  it('deleteBudgetYear schreibt einen Tombstone remote (kein Hard-Delete), Fremdjahre bleiben', async () => {
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

    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(Object.keys(remote).sort()).toEqual(['2024', '2025']);
    expect(remote['2025'].deleted).toBe(true);
    expect(remote['2024'].deleted).toBeUndefined();
  });

  it('stales Gerät B belebt ein gelöschtes Jahr NICHT wieder (Tombstone ist neuer)', async () => {
    // Gerät A hat 2025 gelöscht → Tombstone remote (neuer als die alten Daten)
    state.rows[KEY] = {
      2024: year(2024, '2026-01-01T00:00:00.000Z'),
      2025: { ...year(2025, '2026-07-01T00:00:00.000Z'), deleted: true } as StoredBudgetYear,
    };
    // Gerät B hat noch den ALTEN localStorage-Stand mit 2025-Daten
    localStorageStore[KEY] = JSON.stringify({
      2024: year(2024, '2026-01-01T00:00:00.000Z'),
      2025: year(2025, '2026-03-01T00:00:00.000Z'), // älter als Tombstone
    });

    // Gerät B speichert irgendein anderes Jahr → Backup-Merge läuft
    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2025'].deleted).toBe(true); // bleibt gelöscht
  });

  it('bewusste Neuanlage nach Löschung gewinnt gegen den älteren Tombstone', async () => {
    state.rows[KEY] = {
      2025: { ...year(2025, '2026-05-01T00:00:00.000Z'), deleted: true } as StoredBudgetYear,
    };

    saveBudgetYear(realYear(2025, '2026-07-14T00:00:00.000Z', 42), KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2025'].deleted).toBeUndefined();
    expect(remote['2025'].plLineItems?.[0].monthlyValues[0]).toBe(42);
  });

  it('Leser filtern Tombstones: availableBudgetYears + loadBudgetYear', () => {
    localStorageStore[KEY] = JSON.stringify({
      2024: realYear(2024, '2026-01-01T00:00:00.000Z', 100),
      2025: { ...year(2025, '2026-07-01T00:00:00.000Z'), deleted: true },
    });

    expect(availableBudgetYears(KEY)).toEqual([2024]);
    // Tombstone-Jahr wird wie «nicht vorhanden» behandelt (leeres Jahr, keine Daten)
    const loaded = loadBudgetYear(2025, KEY);
    expect((loaded as StoredBudgetYear).deleted).toBeUndefined();
    expect(loaded.plLineItems).toBeUndefined();
  });
});

describe('Auto-Seed 2026 (Befund 3) — Seed überschreibt nie Remote-Daten', () => {
  it('Seed verliert gegen remote bearbeitetes 2026 mit echten Werten; localStorage konvergiert', async () => {
    // Remote hat ein BEARBEITETES 2026 (Marker 777); localStorage ist leer
    state.rows[STORAGE_KEY] = {
      2026: realYear(2026, '2026-05-01T00:00:00.000Z', 777),
    };

    // Frisches Gerät: loadBudgetYear triggert den Auto-Seed
    loadBudgetYear(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[STORAGE_KEY] as Record<string, BudgetYear>;
    expect(remote['2026'].plLineItems?.[0].monthlyValues[0]).toBe(777); // remote gewinnt
    // localStorage wurde auf den Remote-Stand nachgezogen
    const local = JSON.parse(localStorageStore[STORAGE_KEY]) as Record<string, BudgetYear>;
    expect(local['2026'].plLineItems?.[0].monthlyValues[0]).toBe(777);
  });

  it('Seed wird bei leerem Remote geschrieben und ist idempotent', async () => {
    const first = loadBudgetYear(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    const remote = state.rows[STORAGE_KEY] as Record<string, BudgetYear>;
    expect(remote['2026']).toBeDefined();
    const remoteUpdatedAt = remote['2026'].updatedAt;

    // Zweiter Load: Seed hat echte Werte → KEIN erneuter Seed/Write
    const second = loadBudgetYear(2026, STORAGE_KEY);
    await flushBudgetKVBackups();
    expect(second.updatedAt).toBe(first.updatedAt);
    expect((state.rows[STORAGE_KEY] as Record<string, BudgetYear>)['2026'].updatedAt)
      .toBe(remoteUpdatedAt);
  });

  it('Remote-Lesefehler: der Seed wird NICHT nach Supabase geschrieben', async () => {
    state.rows[STORAGE_KEY] = {
      2026: realYear(2026, '2026-05-01T00:00:00.000Z', 777),
    };
    state.failRead = true;

    loadBudgetYear(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Remote unverändert — der Seed hat die bearbeiteten Werte nicht überschrieben
    const remote = state.rows[STORAGE_KEY] as Record<string, BudgetYear>;
    expect(remote['2026'].plLineItems?.[0].monthlyValues[0]).toBe(777);
  });
});

describe('Offline vs. echter Fehler (Befund 2) — Hinweis-Klassifikation', () => {
  it('Supabase nicht verfügbar: dezenter Info-Hinweis, KEIN Fehler-Toast', async () => {
    state.failProbe = true; // Verfügbarkeits-Probe scheitert → offline/nicht konfiguriert

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    // localStorage bleibt Primärspeicher
    const local = JSON.parse(localStorageStore[KEY]) as Record<string, BudgetYear>;
    expect(local['2026']).toBeDefined();
  });

  it('echter Schreibfehler trotz Verbindung: Fehler-Toast mit Retry, kein Info-Hinweis', async () => {
    state.failWrite = true;

    saveBudgetYear(year(2026, '2026-07-14T00:00:00.000Z'), KEY);
    await flushBudgetKVBackups();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
    const opts = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      action?: { label: string };
    };
    expect(opts.action?.label).toBe('Erneut versuchen');
  });
});
