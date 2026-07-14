// @vitest-environment node
/**
 * Stabilisierungsrunde 2.4 — T007: Budget-Importstatus über die ECHTEN
 * Reader-Funktionen der Seiten (Import-Checkliste: budgetCoverage,
 * Import-Cockpit: jahresbudgetSignal) — inklusive der echten Store-Schreibpfade
 * (loadBudgetWithPL / saveBudgetYear / deleteBudgetYear), nicht über
 * handgebaute Blobs allein:
 *   - Nur View-Seed geladen → Budget gilt NICHT als importiert.
 *   - Echtes Budget gespeichert → Status korrekt «vorhanden».
 *   - Jahr gelöscht (Tombstone) → Budget gilt NICHT als vorhanden.
 *   - Bewusste Neuanlage über dem Tombstone → Status aktualisiert sich.
 *   - Tenant-Wechsel → richtiger Status pro Betrieb (Oliv/Beaulieu getrennt).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writeCount: 0,
}));

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
  toast: Object.assign(() => {}, { error: () => {}, success: () => {}, warning: () => {}, info: () => {} }),
}));

import {
  loadBudgetWithPL,
  saveBudgetYear,
  deleteBudgetYear,
  flushBudgetKVBackups,
  STORAGE_KEY,
} from '../budget-store';
import { budgetCoverage } from '../import-tasks-db';
import { jahresbudgetSignal } from '../import-cockpit-db';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

const BEAULIEU_KEY = `beaulieu:${STORAGE_KEY}`;
const OLD = '2025-01-01T00:00:00.000Z';

const olivCtx = { tenantId: 'oliv', tenantKey: (k: string) => k };
const beaulieuCtx = { tenantId: 'beaulieu', tenantKey: (k: string) => `beaulieu:${k}` };

type StoredBudgetYear = BudgetYear & { deleted?: boolean; viewDefault?: boolean };

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
  } as unknown as StoredBudgetYear;
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.writeCount = 0;
});

describe('T007 — Importstatus über echte Reader + echte Store-Pfade', () => {
  it('nur View-Seed geladen → Budget gilt NICHT als importiert', async () => {
    // Echter Ladepfad der Budget-Seite: 2026-Seed als View-Default
    const seed = loadBudgetWithPL(2026, STORAGE_KEY);
    expect((seed as StoredBudgetYear).viewDefault).toBe(true);
    await flushBudgetKVBackups();

    expect(budgetCoverage(olivCtx, 2026)).toEqual({ yearDone: false });
    expect(jahresbudgetSignal(olivCtx).latestDataDate).toBeNull();
    expect(state.writeCount).toBe(0);
  });

  it('echtes Budget gespeichert → Status «vorhanden» mit Zeitstempel', async () => {
    saveBudgetYear(realYear(2027, OLD, 111), STORAGE_KEY);
    await flushBudgetKVBackups();

    const cov = budgetCoverage(olivCtx, 2027);
    expect(cov.yearDone).toBe(true);
    expect(cov.lastImportAt).toBeTruthy();
    expect(jahresbudgetSignal(olivCtx).recordCount).toBe(1);
  });

  it('Löschen (Tombstone) → nicht vorhanden; bewusste Neuanlage → Status aktualisiert', async () => {
    saveBudgetYear(realYear(2027, OLD, 111), STORAGE_KEY);
    deleteBudgetYear(2027, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Tombstone: beide Leser melden «nicht vorhanden»
    expect(budgetCoverage(olivCtx, 2027)).toEqual({ yearDone: false });
    expect(jahresbudgetSignal(olivCtx).latestDataDate).toBeNull();

    const tombstoneAt = JSON.parse(localStorageStore[STORAGE_KEY])[2027].updatedAt as string;

    // Bewusste Neuanlage über dem Tombstone (immer-speichern-Ausnahme).
    // Kurze Wartezeit: updatedAt hat ms-Auflösung — die Neuanlage muss strikt
    // neuer gestempelt sein als der Tombstone.
    await new Promise(r => setTimeout(r, 5));
    saveBudgetYear(realYear(2027, OLD, 222), STORAGE_KEY);
    await flushBudgetKVBackups();

    const cov = budgetCoverage(olivCtx, 2027);
    expect(cov.yearDone).toBe(true);
    // Neuer Zeitstempel verdrängt den Tombstone
    expect(String(cov.lastImportAt) > tombstoneAt).toBe(true);
  });

  it('Tenant-Wechsel → richtiger Status pro Betrieb (Oliv ≠ Beaulieu)', async () => {
    saveBudgetYear(realYear(2027, OLD, 111), STORAGE_KEY); // nur Oliv
    await flushBudgetKVBackups();

    expect(budgetCoverage(olivCtx, 2027).yearDone).toBe(true);
    expect(budgetCoverage(beaulieuCtx, 2027)).toEqual({ yearDone: false });

    // Umgekehrt: nur Beaulieu
    delete localStorageStore[STORAGE_KEY];
    saveBudgetYear(realYear(2028, OLD, 333), BEAULIEU_KEY);
    await flushBudgetKVBackups();

    expect(budgetCoverage(beaulieuCtx, 2028).yearDone).toBe(true);
    expect(budgetCoverage(olivCtx, 2028)).toEqual({ yearDone: false });

    // Cockpit-Signal je Tenant getrennt
    expect(jahresbudgetSignal(beaulieuCtx).recordCount).toBe(1);
    expect(jahresbudgetSignal(olivCtx).latestDataDate).toBeNull();
  });
});
