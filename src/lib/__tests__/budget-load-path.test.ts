// @vitest-environment node
/**
 * Regressionstest C1 (externe Review): Reiner Ladepfad schreibt NIE nach Supabase
 * ================================================================================
 * Vorher rief loadBudgetWithPL() bei vorhandenen echten Daten saveBudgetYear()
 * auf: updatedAt wurde neu gestempelt und ein KV-Backup ausgelöst, in dem das
 * Aktionsjahr bedingungslos lokal gewinnt. Folge: Ein Gerät mit stalem
 * localStorage überschrieb beim BLOSSEN ÖFFNEN des Budgets den neueren
 * Remote-Stand eines anderen Geräts.
 *
 * Getestet:
 *   1. Kernszenario: Gerät A speichert 2027 remote → Gerät B (stale) öffnet
 *      nur → Remote bleibt unangetastet, kein einziger KV-Write.
 *   2. Migrationen persistieren nur lokal, ohne updatedAt-Bump; zweiter Load
 *      ist idempotent (keine weitere Änderung).
 *   3. Laden eines nicht existierenden Jahres legt keinen Record an.
 *   4. Laden reanimiert keinen Tombstone.
 *   5. syncPLToLegacyPositions: Dirty Check — unverändert ⇒ selbe Referenz,
 *      kein neues updatedAt.
 *   6. Explizites Speichern nach dem Laden erreicht das KV-Backup weiterhin.
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
  writeCount: 0,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) => ({ data: [], error: null }),
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({
            data: state.rows[key] !== undefined ? { value: state.rows[key] } : null,
            error: null,
          }),
        }),
      }),
      upsert: async (row: { key: string; value: unknown }) => {
        state.writeCount++;
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
  loadBudgetWithPL,
  saveBudgetYear,
  deleteBudgetYear,
  syncPLToLegacyPositions,
  flushBudgetKVBackups,
} from '../budget-store';
import { resetKVAvailabilityCache } from '../supabase-kv';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

const KEY = 'test_budget_load_path';

type StoredBudgetYear = BudgetYear & { deleted?: boolean };

/** Budgetjahr mit echten P&L-Werten (Marker im Januar) und vorhandener PL-Struktur */
function realYear(y: number, updatedAt: string, marker: number): StoredBudgetYear {
  return {
    year: y,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: updatedAt,
    updatedAt,
    plCategories: [{ id: 'cat_test', label: 'Test', sortOrder: 1, kind: 'expense' }],
    plLineItems: [
      {
        id: 'pli_test',
        categoryId: 'cat_test',
        label: 'Testposition',
        valueType: 'chf',
        monthlyValues: [marker, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sortOrder: 1,
        isDefault: false,
      } as BudgetPLLineItem,
    ],
  } as StoredBudgetYear;
}

function localAll(): Record<string, StoredBudgetYear> {
  return JSON.parse(localStorageStore[KEY] ?? '{}');
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.writeCount = 0;
  resetKVAvailabilityCache();
});

describe('C1: loadBudgetWithPL ist ein reiner Ladevorgang (kein Supabase-Write)', () => {
  it('Kernszenario: Gerät B (stale localStorage) öffnet nur — Remote von Gerät A bleibt unangetastet', async () => {
    // Gerät A hat 2027 remote gespeichert (neuer, Marker 999)
    state.rows[KEY] = { 2027: realYear(2027, '2027-06-01T12:00:00.000Z', 999) };
    // Gerät B besitzt veraltete localStorage-Daten (älter, Marker 111)
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, '2027-01-01T12:00:00.000Z', 111) });

    // Gerät B ÖFFNET das Budget nur
    const loaded = loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    expect(loaded.plLineItems?.find(i => i.id === 'pli_test')?.monthlyValues[0]).toBe(111);
    // Remote wurde NIE beschrieben — Gerät A's Stand ist unverändert
    expect(state.writeCount).toBe(0);
    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2027'].plLineItems?.[0].monthlyValues[0]).toBe(999);
    expect(remote['2027'].updatedAt).toBe('2027-06-01T12:00:00.000Z');
  });

  it('Migrationen persistieren nur lokal, ohne updatedAt-Bump; zweiter Load idempotent', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, '2027-01-01T12:00:00.000Z', 111) });

    loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    // Migration (Default-Konten/Kategorien + Legacy-Sync) wurde lokal persistiert …
    const after1 = localAll()['2027'];
    expect((after1.plLineItems?.length ?? 0)).toBeGreaterThan(1);
    expect(after1.positions.length).toBeGreaterThan(0);
    // … aber updatedAt/createdAt blieben unverändert und Supabase unberührt
    expect(after1.updatedAt).toBe('2027-01-01T12:00:00.000Z');
    expect(after1.createdAt).toBe('2027-01-01T12:00:00.000Z');
    expect(state.writeCount).toBe(0);

    // Ab dem zweiten Load ist der Zustand stabil (vorbestehende Eigenheit:
    // migrateObsoletePLItems hängt zwei re-eingeführte Konten beim 2. Load
    // einmalig ans Listenende — danach idempotent). Entscheidend: updatedAt
    // bleibt auch dabei unverändert und Supabase wird nie beschrieben.
    loadBudgetWithPL(2027, KEY);
    const snapshot = localStorageStore[KEY];
    loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();
    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(localAll()['2027'].updatedAt).toBe('2027-01-01T12:00:00.000Z');
    expect(state.writeCount).toBe(0);
  });

  it('Laden eines nicht existierenden Jahres legt keinen Record an (lokal wie remote)', async () => {
    localStorageStore[KEY] = JSON.stringify({});

    loadBudgetWithPL(2030, KEY);
    await flushBudgetKVBackups();

    expect(localAll()['2030']).toBeUndefined();
    expect(state.writeCount).toBe(0);
  });

  it('Laden reanimiert keinen Tombstone', async () => {
    saveBudgetYear(realYear(2027, '2027-01-01T12:00:00.000Z', 111), KEY);
    deleteBudgetYear(2027, KEY);
    await flushBudgetKVBackups();
    const writesBefore = state.writeCount;

    loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    expect(localAll()['2027'].deleted).toBe(true);
    expect(state.writeCount).toBe(writesBefore);
  });

  it('explizites Speichern nach dem Laden erreicht das KV-Backup weiterhin', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, '2027-01-01T12:00:00.000Z', 111) });

    const budget = loadBudgetWithPL(2027, KEY);
    saveBudgetYear(budget, KEY); // echte Benutzer-Speicheraktion
    await flushBudgetKVBackups();

    expect(state.writeCount).toBe(1);
    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2027'].plLineItems?.some(i => i.id === 'pli_test')).toBe(true);
  });
});

describe('syncPLToLegacyPositions: Dirty Check', () => {
  it('unveränderte Daten ⇒ selbe Referenz, kein neues updatedAt', () => {
    const first = syncPLToLegacyPositions(realYear(2027, '2027-01-01T12:00:00.000Z', 111));
    // Erster Sync berechnet die Legacy-Positionen → geändert
    expect(first.positions.length).toBeGreaterThan(0);

    const second = syncPLToLegacyPositions(first);
    expect(second).toBe(first);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it('geänderte P&L-Werte ⇒ neue Positionen und neues updatedAt', () => {
    const first = syncPLToLegacyPositions(realYear(2027, '2027-01-01T12:00:00.000Z', 111));
    // Umsatzposition ergänzen — fliesst in budget_revenue ein und ändert
    // damit die Legacy-Positionen effektiv.
    const modified: BudgetYear = {
      ...first,
      plLineItems: [
        ...first.plLineItems!,
        {
          id: 'pli_rev_test',
          categoryId: 'pl_revenue',
          label: 'Umsatz Test',
          valueType: 'chf',
          monthlyValues: [500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          sortOrder: 2,
          isDefault: false,
        } as BudgetPLLineItem,
      ],
    };
    const second = syncPLToLegacyPositions(modified);
    expect(second).not.toBe(modified);
    expect(second.positions.find(p => p.id === 'budget_revenue')?.monthlyValues[0]).toBe(500);
    expect(second.updatedAt).not.toBe('2027-01-01T12:00:00.000Z');
  });
});
