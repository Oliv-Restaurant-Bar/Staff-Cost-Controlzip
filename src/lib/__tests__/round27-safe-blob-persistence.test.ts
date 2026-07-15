// @vitest-environment node
/**
 * Stabilisierungsrunde 2.7 — T206: Regressionstests der drei KV-Blob-Flows
 * =========================================================================
 * Testet die 20 Pflichtfälle der Aufgabenstellung an den REALEN öffentlichen
 * Einstiegspfaden (keine internen Helfer):
 *   - Budget:        loadBudgetYear/loadBudgetWithPL, saveBudgetYear, deleteBudgetYear
 *   - Tagesumsätze:  safeUpsertDailyBudgets (der einzige Schreibpfad aller Aufrufer)
 *   - Reporting:     loadMonth/loadYear, saveMonth, deleteMonth
 *
 * Zusätzlich (Architect-Befunde Runde 2.7):
 *   Z1 Delete-Wipe-Regression: fehlgeschlagener Remote-Read beim Monats-Löschen
 *      darf NIE einen leeren Blob schreiben (lokale Basis-Union — Bugfix 2.7).
 *   Z2 Reihenfolge-Invariante: notifyKV feuert erst NACH localStorage.setItem.
 *   Z3 Availability-Recovery für Daily UND Reporting (Budget bereits abgedeckt
 *      in budget-store-kv-backup.test.ts).
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
vi.stubGlobal('window', { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} });

const state = {
  rows: {} as Record<string, unknown>,
  failWrite: false,
  failRead: false,
  failProbe: false,
  upserts: [] as string[],
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) =>
          state.failProbe ? { data: null, error: { message: 'Failed to fetch' } } : { data: [], error: null },
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
        state.rows[row.key] = JSON.parse(JSON.stringify(row.value));
        state.upserts.push(row.key);
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
  loadBudgetWithPL,
  flushBudgetKVBackups,
} from '../budget-store';
import { saveMonth, deleteMonth, loadMonth, loadYear } from '../reporting-store';
import {
  safeUpsertDailyBudgets,
  subscribeKV,
  resetKVAvailabilityCache,
} from '../supabase-kv';
import { toast } from 'sonner';
import type { BudgetYear } from '@/types/budget';

// Reale Schlüssel beider Tenants (Tenant = Schlüssel-Präfix)
const B_KEY  = 'budget_v1';
const B_KEY2 = 'beaulieu:budget_v1';
const D_KEY  = 'dailyBudgets';
const D_KEY2 = 'beaulieu:dailyBudgets';
const R_KEY  = 'reporting_v1';
const R_KEY2 = 'beaulieu:reporting_v1';

type StoredBudgetYear = BudgetYear & { deleted?: boolean };

function budgetYear(y: number, updatedAt: string, marker = 0): StoredBudgetYear {
  return {
    year: y,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: updatedAt,
    updatedAt,
    plLineItems: [{
      id: 'pli_test', categoryId: 'cat_test', label: 'Test', valueType: 'chf',
      monthlyValues: [marker, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], sortOrder: 1, isDefault: false,
    }],
  } as StoredBudgetYear;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Wartet auf Budget-Queue UND fire-and-forget-Reporting-Writes */
async function flush(): Promise<void> {
  await flushBudgetKVBackups();
  await sleep(0); await sleep(0); await sleep(0);
}

function upsertCount(key: string): number {
  return state.upserts.filter(k => k === key).length;
}

beforeEach(async () => {
  await flush(); // Reste aus vorherigen Tests abwarten, bevor Zustand geleert wird
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.failWrite = false;
  state.failRead = false;
  state.failProbe = false;
  state.upserts = [];
  resetKVAvailabilityCache();
  vi.clearAllMocks();
});

// ─── Fälle 1–6: Laden schreibt nie / Dirty-Check / updatedAt ─────────────────

describe('F01–F03: Reines Laden löst keinen Upsert aus', () => {
  it('F01 Budget + Reporting: Laden erzeugt weder KV-Write noch localStorage-Record', async () => {
    loadBudgetYear(2025, B_KEY);
    loadMonth(2025, 3, R_KEY);
    loadYear(2025, R_KEY);
    await flush();
    expect(state.upserts).toEqual([]);
    expect(localStorageStore[B_KEY]).toBeUndefined();
    expect(localStorageStore[R_KEY]).toBeUndefined();
  });

  it('F03 Auto-Seed 2026 (View-Default): blosses Laden persistiert NICHTS', async () => {
    const b = loadBudgetWithPL(2026, B_KEY);
    expect(b.viewDefault).toBe(true);
    await flush();
    expect(state.upserts).toEqual([]);
    expect(localStorageStore[B_KEY]).toBeUndefined();
    expect(state.rows[B_KEY]).toBeUndefined();
  });
});

describe('F02/F04–F06/F19: Dirty-Check und updatedAt (Budget-Einstiegspfad)', () => {
  it('F02+F05 identischer Save: kein weiterer Upsert, updatedAt unverändert', async () => {
    const saved = saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 100), B_KEY);
    await flush();
    const n = upsertCount(B_KEY);
    expect(n).toBe(1);

    await sleep(5);
    const again = saveBudgetYear({ ...saved }, B_KEY);
    await flush();
    expect(upsertCount(B_KEY)).toBe(n);          // kein zweiter Write
    expect(again.updatedAt).toBe(saved.updatedAt); // Zeitstempel identisch
  });

  it('F04+F06 echte Änderung: genau EIN weiterer Upsert, updatedAt neu', async () => {
    const first = saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 100), B_KEY);
    await flush();
    const n = upsertCount(B_KEY);

    await sleep(5);
    const changed: BudgetYear = { ...first, plLineItems: first.plLineItems!.map(i => ({
      ...i, monthlyValues: [999, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    })) };
    const second = saveBudgetYear(changed, B_KEY);
    await flush();
    expect(upsertCount(B_KEY)).toBe(n + 1);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('F19 Mehrfaches Speichern derselben Änderung erzeugt keinen weiteren Write', async () => {
    const saved = saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 7), B_KEY);
    await flush();
    const n = upsertCount(B_KEY);
    for (let i = 0; i < 3; i++) {
      saveBudgetYear({ ...saved }, B_KEY);
      await flush();
    }
    expect(upsertCount(B_KEY)).toBe(n);
  });
});

// ─── Fälle 7–8: Netzwerkfehler kontrolliert + Recovery ───────────────────────

describe('F07/F08/Z3: Netzwerkfehler und Wiederverwendbarkeit', () => {
  it('F07 Daily: Remote-Lesefehler → KV-Write übersprungen, localStorage aktuell, Ergebnis kontrolliert', async () => {
    localStorageStore[D_KEY] = JSON.stringify({ '2026-07-01': { plannedRevenue: 500 } });
    state.failRead = true;
    const merged = await safeUpsertDailyBudgets(D_KEY, { '2026-07-02': { plannedRevenue: 800 } });
    expect(merged['2026-07-02'].plannedRevenue).toBe(800);
    expect(JSON.parse(localStorageStore[D_KEY])['2026-07-02'].plannedRevenue).toBe(800);
    expect(state.rows[D_KEY]).toBeUndefined();   // NIE ohne Remote-Basis schreiben
    expect(toast.error).toHaveBeenCalled();       // echter Fehler → sichtbar
  });

  it('F07 Reporting: Schreibfehler → Remote unverändert, lokal bleibt gespeichert (kein stiller Erfolg)', async () => {
    state.rows[R_KEY] = { '2025-01': { id: '2025-01', year: 2025, month: 1 } };
    state.failWrite = true;
    saveMonth({ year: 2025, month: 2, revenueActual: 111 }, 'manual', 'update', undefined, R_KEY);
    await flush();
    expect(state.rows[R_KEY]).toEqual({ '2025-01': { id: '2025-01', year: 2025, month: 1 } });
    expect(JSON.parse(localStorageStore[R_KEY])['2025-02'].revenueActual).toBe(111);
  });

  it('F08+Z3 Daily: nach Offline-Fehler funktioniert der nächste Versuch wieder', async () => {
    state.failProbe = true;
    await safeUpsertDailyBudgets(D_KEY, { '2026-07-01': { plannedRevenue: 100 } });
    expect(state.rows[D_KEY]).toBeUndefined();

    state.failProbe = false;
    resetKVAvailabilityCache();
    const merged = await safeUpsertDailyBudgets(D_KEY, { '2026-07-01': { plannedRevenue: 100 } });
    expect((state.rows[D_KEY] as Record<string, Record<string, unknown>>)['2026-07-01'].plannedRevenue).toBe(100);
    expect(merged['2026-07-01'].plannedRevenue).toBe(100);
  });

  it('F08+Z3 Reporting: nach Offline-Fehler erreicht der nächste Save Supabase wieder', async () => {
    state.failProbe = true;
    saveMonth({ year: 2025, month: 3, revenueActual: 50 }, 'manual', 'update', undefined, R_KEY);
    await flush();
    expect(state.rows[R_KEY]).toBeUndefined();

    state.failProbe = false;
    resetKVAvailabilityCache();
    saveMonth({ year: 2025, month: 3, revenueActual: 60 }, 'manual', 'update', undefined, R_KEY);
    await flush();
    expect((state.rows[R_KEY] as Record<string, { revenueActual?: number }>)['2025-03'].revenueActual).toBe(60);
  });
});

// ─── Fälle 9–11, 15: Stale localStorage / Zwei-Geräte (Budget-Merge-Regel) ────

describe('F09–F11/F15: Zwei-Geräte-Szenarien, Budget-Merge-Regel unverändert', () => {
  it('F09 staler localStorage überschreibt keine remote-only Jahre', async () => {
    state.rows[B_KEY] = { 2030: budgetYear(2030, '2026-06-01T00:00:00.000Z', 42) };
    saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 1), B_KEY);
    await flush();
    const remote = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2030'].plLineItems![0].monthlyValues[0]).toBe(42); // blieb erhalten
    expect(remote['2025']).toBeDefined();
  });

  it('F10+F15 Nicht-Aktionsjahr: neuerer Remote-Stand gewinnt (newer-updatedAt-wins)', async () => {
    localStorageStore[B_KEY] = JSON.stringify({ 2028: budgetYear(2028, '2026-01-01T00:00:00.000Z', 1) });
    state.rows[B_KEY] = { 2028: budgetYear(2028, '2026-06-01T00:00:00.000Z', 2) };
    saveBudgetYear(budgetYear(2025, '2026-02-01T00:00:00.000Z', 5), B_KEY);
    await flush();
    const remote = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2028'].plLineItems![0].monthlyValues[0]).toBe(2); // Remote (neuer) gewinnt
  });

  it('F11+F15 Aktionsjahr: echte lokale Änderung gewinnt auch gegen neueren Remote-Stand', async () => {
    state.rows[B_KEY] = { 2025: budgetYear(2025, '2099-01-01T00:00:00.000Z', 2) };
    saveBudgetYear(budgetYear(2025, '2026-02-01T00:00:00.000Z', 77), B_KEY);
    await flush();
    const remote = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2025'].plLineItems![0].monthlyValues[0]).toBe(77); // Aktion gewinnt
  });
});

// ─── Fall 12: Tenant-Isolation ────────────────────────────────────────────────

describe('F12: Tenant A liest/überschreibt Tenant B niemals', () => {
  it('Budget, Daily und Reporting: Schreiben auf beaulieu:* lässt Oliv-Schlüssel unberührt (und umgekehrt)', async () => {
    state.rows[B_KEY] = { 2025: budgetYear(2025, '2026-01-01T00:00:00.000Z', 11) };
    state.rows[D_KEY] = { '2026-07-01': { plannedRevenue: 111 } };
    state.rows[R_KEY] = { '2025-01': { id: '2025-01', year: 2025, month: 1, revenueActual: 1 } };

    saveBudgetYear(budgetYear(2025, '2026-02-01T00:00:00.000Z', 22), B_KEY2);
    await safeUpsertDailyBudgets(D_KEY2, { '2026-07-01': { plannedRevenue: 222 } });
    saveMonth({ year: 2025, month: 1, revenueActual: 2 }, 'manual', 'update', undefined, R_KEY2);
    await flush();

    // Oliv-Bestände bitgenau unverändert
    expect((state.rows[B_KEY] as Record<string, StoredBudgetYear>)['2025'].plLineItems![0].monthlyValues[0]).toBe(11);
    expect((state.rows[D_KEY] as Record<string, Record<string, unknown>>)['2026-07-01'].plannedRevenue).toBe(111);
    expect((state.rows[R_KEY] as Record<string, { revenueActual?: number }>)['2025-01'].revenueActual).toBe(1);
    // Beaulieu-Bestände geschrieben
    expect(state.rows[B_KEY2]).toBeDefined();
    expect((state.rows[D_KEY2] as Record<string, Record<string, unknown>>)['2026-07-01'].plannedRevenue).toBe(222);
    expect((state.rows[R_KEY2] as Record<string, { revenueActual?: number }>)['2025-01'].revenueActual).toBe(2);
    // Kein Upsert auf Oliv-Schlüsseln
    expect(upsertCount(B_KEY)).toBe(0);
    expect(upsertCount(D_KEY)).toBe(0);
    expect(upsertCount(R_KEY)).toBe(0);
  });
});

// ─── Fälle 13–14: Tombstones ─────────────────────────────────────────────────

describe('F13/F14: Tombstones bleiben erhalten, Gelöschtes wird nicht reaktiviert', () => {
  it('F13 deleteBudgetYear schreibt einen Jahres-Tombstone ins KV', async () => {
    saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 1), B_KEY);
    await flush();
    deleteBudgetYear(2025, B_KEY);
    await flush();
    const remote = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2025'].deleted).toBe(true);
    expect(loadBudgetYear(2025, B_KEY).plLineItems?.[0]?.monthlyValues[0] ?? 0).toBe(0); // Leser filtert
  });

  it('F14 stale lokale Daten reaktivieren keinen neueren Remote-Tombstone (Nicht-Aktionsjahr)', async () => {
    localStorageStore[B_KEY] = JSON.stringify({ 2027: budgetYear(2027, '2026-01-01T00:00:00.000Z', 9) });
    state.rows[B_KEY] = { 2027: { ...budgetYear(2027, '2026-06-01T00:00:00.000Z', 0), deleted: true } };
    saveBudgetYear(budgetYear(2025, '2026-02-01T00:00:00.000Z', 5), B_KEY);
    await flush();
    const remote = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2027'].deleted).toBe(true); // Tombstone (neuer) überlebt
  });

  it('F14 Reporting: gelöschter Monat bleibt gelöscht (kein Resurrect durch alten localStorage)', async () => {
    state.rows[R_KEY] = {
      '2025-01': { id: '2025-01', year: 2025, month: 1 },
      '2025-02': { id: '2025-02', year: 2025, month: 2 },
    };
    localStorageStore[R_KEY] = JSON.stringify(state.rows[R_KEY]);
    deleteMonth(2025, 2, R_KEY);
    await flush();
    const remote = state.rows[R_KEY] as Record<string, unknown>;
    expect(remote['2025-02']).toBeUndefined();
    expect(remote['2025-01']).toBeDefined();
  });
});

// ─── Fälle 16–17: Merge-Regeln Daily + Reporting unverändert ─────────────────

describe('F16/F17: Domänen-Merge-Regeln unverändert', () => {
  it('F16 Daily: Remote (>0) gewinnt, local füllt Lücken, onlyIfZero schützt Bestehendes', async () => {
    localStorageStore[D_KEY] = JSON.stringify({
      '2026-07-01': { plannedRevenue: 5 },     // stale — Remote hat 100
      '2026-07-02': { plannedRevenue: 7 },     // nur lokal
    });
    state.rows[D_KEY] = { '2026-07-01': { plannedRevenue: 100 } };

    const merged = await safeUpsertDailyBudgets(D_KEY, { '2026-07-03': { plannedRevenue: 300 } });
    expect(merged['2026-07-01'].plannedRevenue).toBe(100); // Remote-Master gewinnt
    expect(merged['2026-07-02'].plannedRevenue).toBe(7);   // local füllt Lücke
    expect(merged['2026-07-03'].plannedRevenue).toBe(300); // Update angewendet

    const merged2 = await safeUpsertDailyBudgets(D_KEY, { '2026-07-01': { plannedRevenue: 999 } }, true);
    expect(merged2['2026-07-01'].plannedRevenue).toBe(100); // onlyIfZero: >0 bleibt
  });

  it('F17 Reporting: nur der Ziel-Monat wird ersetzt, alle anderen Monate bleiben', async () => {
    state.rows[R_KEY] = {
      '2024-04': { id: '2024-04', year: 2024, month: 4, revenueActual: 400 },
      '2024-05': { id: '2024-05', year: 2024, month: 5, revenueActual: 500 },
    };
    saveMonth({ year: 2024, month: 7, revenueActual: 700 }, 'manual', 'update', undefined, R_KEY);
    await flush();
    const remote = state.rows[R_KEY] as Record<string, { revenueActual?: number }>;
    expect(remote['2024-04'].revenueActual).toBe(400);
    expect(remote['2024-05'].revenueActual).toBe(500);
    expect(remote['2024-07'].revenueActual).toBe(700);
  });
});

// ─── Fall 18: Keine Teilpersistenz ───────────────────────────────────────────

describe('F18: Fehler nach Read, vor/beim Upsert → keine Teilpersistenz remote', () => {
  it('Budget: Schreibfehler → Remote unverändert, Fehler sichtbar (Toast), localStorage intakt', async () => {
    state.rows[B_KEY] = { 2030: budgetYear(2030, '2026-06-01T00:00:00.000Z', 42) };
    state.failWrite = true;
    saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 1), B_KEY);
    await flush();
    expect(Object.keys(state.rows[B_KEY] as object)).toEqual(['2030']); // nichts Halbes geschrieben
    expect(toast.error).toHaveBeenCalled();
    expect(JSON.parse(localStorageStore[B_KEY])['2025']).toBeDefined(); // lokal bleibt gespeichert
  });
});

// ─── Fall 20: Datenformate unverändert ───────────────────────────────────────

describe('F20: Die Refactorings verändern keine gespeicherten Datenformate', () => {
  it('Budget-Blob = Record<Jahr, BudgetYear>, Daily = Record<Datum, Felder>, Reporting = Record<MonatsId, Monats-Record>', async () => {
    saveBudgetYear(budgetYear(2025, '2026-01-01T00:00:00.000Z', 1), B_KEY);
    await safeUpsertDailyBudgets(D_KEY, { '2026-07-01': { plannedRevenue: 100, actualRevenue: 90 } });
    saveMonth({ year: 2025, month: 1, revenueActual: 10 }, 'manual', 'update', undefined, R_KEY);
    await flush();

    const b = state.rows[B_KEY] as Record<string, StoredBudgetYear>;
    expect(Object.keys(b)).toEqual(['2025']);
    expect(b['2025']).toMatchObject({ year: 2025, wasAutoCalculated: false });
    expect(typeof b['2025'].updatedAt).toBe('string');
    expect(Array.isArray(b['2025'].positions)).toBe(true);

    const d = state.rows[D_KEY] as Record<string, Record<string, unknown>>;
    expect(d['2026-07-01']).toEqual({ plannedRevenue: 100, actualRevenue: 90 });

    const r = state.rows[R_KEY] as Record<string, Record<string, unknown>>;
    expect(r['2025-01']).toMatchObject({ id: '2025-01', year: 2025, month: 1, revenueActual: 10 });
    expect(Array.isArray(r['2025-01'].imports)).toBe(true);
    // localStorage spiegelt dieselben Formate
    expect(JSON.parse(localStorageStore[R_KEY])['2025-01'].revenueActual).toBe(10);
    expect(JSON.parse(localStorageStore[D_KEY])['2026-07-01'].plannedRevenue).toBe(100);
  });
});

// ─── Zusatz (Architect-Befunde 2.7) ──────────────────────────────────────────

describe('Z1: Delete-Wipe-Regression (Bugfix Runde 2.7)', () => {
  it('Monats-Löschen bei still fehlgeschlagenem Remote-Read: andere Monate überleben (lokale Basis-Union)', async () => {
    state.rows[R_KEY] = {
      '2025-01': { id: '2025-01', year: 2025, month: 1, revenueActual: 100 },
      '2025-02': { id: '2025-02', year: 2025, month: 2, revenueActual: 200 },
      '2025-03': { id: '2025-03', year: 2025, month: 3, revenueActual: 300 },
    };
    localStorageStore[R_KEY] = JSON.stringify(state.rows[R_KEY]);
    state.failRead = true; // kvGet liefert null — vor dem Fix wurde dann {} geschrieben

    deleteMonth(2025, 2, R_KEY);
    await flush();

    const remote = state.rows[R_KEY] as Record<string, unknown>;
    expect(remote['2025-01']).toBeDefined();   // ← vor dem Fix: weg (leerer Blob)
    expect(remote['2025-03']).toBeDefined();
    expect(remote['2025-02']).toBeUndefined(); // Ziel-Monat bleibt gelöscht
  });
});

describe('Z2: Reihenfolge-Invariante notifyKV nach localStorage', () => {
  it('Reporting: Subscriber sehen beim Notify bereits den neuen localStorage-Stand', async () => {
    let seenAtNotify: unknown = null;
    const unsub = subscribeKV(R_KEY, () => {
      seenAtNotify = JSON.parse(localStorageStore[R_KEY] ?? '{}');
    });
    try {
      saveMonth({ year: 2025, month: 6, revenueActual: 66 }, 'manual', 'update', undefined, R_KEY);
      await flush();
      expect(seenAtNotify).not.toBeNull();
      expect((seenAtNotify as Record<string, { revenueActual?: number }>)['2025-06'].revenueActual).toBe(66);
    } finally {
      unsub();
    }
  });
});
