// @vitest-environment node
/**
 * Stabilisierungsrunde 2.3: updatedAt darf NUR bei echter Datenänderung neu
 * gesetzt werden (verbindliche Regel).
 * ================================================================================
 * `updatedAt` bedeutet ausschliesslich: «Dieser fachliche Datensatz wurde
 * tatsächlich geändert.» Newer-wins-Merges zwischen Geräten stützen sich auf
 * diesen Zeitstempel — ein Bump ohne echte Änderung liesse stale Geräte oder
 * wirkungslose Klicks fälschlich gegen echte Remote-Änderungen gewinnen.
 *
 * Getestete Szenarien (T006):
 *   1.  Budget öffnen, nichts ändern → updatedAt unverändert, kein Write.
 *   2.  Mehrfaches Öffnen → localStorage byte-identisch, kein Write.
 *   3.  Speichern ohne Änderung (identischer Datensatz) → kein Bump, kein Write.
 *   4.  savePLLineItem mit unverändertem Item → kein Bump, kein Write.
 *   5.  Einen Monatswert ändern → genau EIN Write, updatedAt genau einmal neu.
 *   6.  Wert ändern und vor dem Speichern zurücksetzen → kein Bump, kein Write.
 *   7.  Migration mit effektiver Änderung → lokal angepasst, updatedAt bleibt,
 *       Ladepfad schreibt nie remote.
 *   8.  Jahr kopieren → Ziel mit neuem Zeitstempel, Quelle byte-identisch.
 *   9.  Jahr löschen → Tombstone mit neuem Zeitstempel, Fremdjahre
 *       byte-identisch; wiederholtes Löschen erzeugt keinen weiteren Bump.
 *   10. Stale-Gerät: lokal alt, remote neu — blosses Öffnen ändert keinen
 *       der beiden Zeitstempel.
 *   11. Tenants: Oliv-Änderung bumpt nur Oliv; Beaulieu-Blob byte-identisch.
 *   12. View-Seed 2026: Laden erzeugt kein persistiertes updatedAt; erst die
 *       erste echte Änderung setzt den ersten Zeitstempel (genau ein Write).
 *   13. Neuanlage über einem Tombstone speichert IMMER (neuerer Zeitstempel
 *       gewinnt bewusst gegen den älteren Tombstone).
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
  savePLLineItem,
  copyBudgetYear,
  flushBudgetKVBackups,
  STORAGE_KEY,
} from '../budget-store';
import { resetKVAvailabilityCache } from '../supabase-kv';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

const KEY = 'test_budget_dirty_check';
const BEAULIEU_KEY = 'beaulieu:budget_v1';
/** Vergangenheits-Zeitstempel — jede echte Neustempelung ist strikt neuer. */
const OLD = '2025-01-01T00:00:00.000Z';

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

function localAll(key: string = KEY): Record<string, StoredBudgetYear> {
  return JSON.parse(localStorageStore[key] ?? '{}');
}

/**
 * Lädt das Jahr bis zum stabilen Zustand (Migrationen laufen beim 1./2. Load
 * einmalig; danach idempotent) und liefert den geladenen Stand zurück.
 */
function loadStable(y: number, key: string = KEY): BudgetYear {
  loadBudgetWithPL(y, key);
  loadBudgetWithPL(y, key);
  return loadBudgetWithPL(y, key);
}

/** Ändert den Monatswert der Testposition und speichert über savePLLineItem. */
function saveMarker(y: number, budget: BudgetYear, monthIdx: number, value: number, key: string = KEY): Promise<BudgetYear> {
  const item = budget.plLineItems!.find(i => i.id === 'pli_test')!;
  const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
  vals[monthIdx] = value;
  return savePLLineItem(y, { ...item, monthlyValues: vals }, key);
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.writeCount = 0;
  resetKVAvailabilityCache();
});

describe('Runde 2.3: updatedAt nur bei echter Datenänderung', () => {
  it('1. Budget öffnen, nichts ändern → updatedAt unverändert, kein Write', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });

    loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    expect(localAll()['2027'].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });

  it('2. Mehrfaches Öffnen → localStorage stabil (byte-identisch), kein Write', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });

    loadStable(2027);
    const snapshot = localStorageStore[KEY];
    loadBudgetWithPL(2027, KEY);
    loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(localAll()['2027'].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });

  it('3. Speichern ohne Änderung (identischer Datensatz) → kein Bump, kein Write', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    const budget = loadStable(2027);
    const snapshot = localStorageStore[KEY];

    const saved = await saveBudgetYear(budget, KEY);
    await flushBudgetKVBackups();

    // Kein Bump, kein Write — der zurückgegebene Stand trägt den alten Zeitstempel
    expect(saved.updatedAt).toBe(OLD);
    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(localAll()['2027'].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });

  it('4. savePLLineItem mit unverändertem Item → kein Bump, kein Write', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    const budget = loadStable(2027);
    const snapshot = localStorageStore[KEY];

    const item = budget.plLineItems!.find(i => i.id === 'pli_test')!;
    const saved = await savePLLineItem(2027, { ...item }, KEY);
    await flushBudgetKVBackups();

    expect(saved.updatedAt).toBe(OLD);
    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(state.writeCount).toBe(0);
  });

  it('5. Einen Monatswert ändern → genau EIN Write, updatedAt genau einmal neu', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    const budget = loadStable(2027);

    const saved = await saveMarker(2027, budget, 1, 999);
    await flushBudgetKVBackups();

    const stored = localAll()['2027'];
    expect(stored.plLineItems?.find(i => i.id === 'pli_test')?.monthlyValues[1]).toBe(999);
    expect(stored.updatedAt).not.toBe(OLD);
    expect(Date.parse(stored.updatedAt)).toBeGreaterThan(Date.parse(OLD));
    expect(saved.updatedAt).toBe(stored.updatedAt);
    expect(state.writeCount).toBe(1);
  });

  it('6. Wert ändern und vor dem Speichern zurücksetzen → kein Bump, kein Write', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    const budget = loadStable(2027);
    const snapshot = localStorageStore[KEY];

    // In-memory ändern …
    const item = budget.plLineItems!.find(i => i.id === 'pli_test')!;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[0] = 555;
    // … und wieder auf den Ursprungswert zurück
    vals[0] = 111;
    savePLLineItem(2027, { ...item, monthlyValues: vals }, KEY);
    await flushBudgetKVBackups();

    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(localAll()['2027'].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });

  it('7. Migration mit effektiver Änderung → lokal angepasst, updatedAt bleibt, kein Remote-Write', async () => {
    // Jahr mit obsoleter Position (wird von der Lade-Migration entfernt)
    const y = realYear(2027, OLD, 111);
    y.plLineItems = [
      ...y.plLineItems!,
      {
        id: 'pli_ktg',
        categoryId: 'cat_test',
        label: 'Obsolete Position',
        valueType: 'chf',
        monthlyValues: [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sortOrder: 99,
        isDefault: true,
      } as BudgetPLLineItem,
    ];
    localStorageStore[KEY] = JSON.stringify({ 2027: y });

    const loaded = loadBudgetWithPL(2027, KEY);
    await flushBudgetKVBackups();

    // Migration hat effektiv geändert (obsolete Position entfernt) …
    expect(loaded.plLineItems?.some(i => i.id === 'pli_ktg')).toBe(false);
    const stored = localAll()['2027'];
    expect(stored.plLineItems?.some(i => i.id === 'pli_ktg')).toBe(false);
    // … aber updatedAt blieb stehen und remote wurde nie geschrieben
    expect(stored.updatedAt).toBe(OLD);
    expect(loaded.updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });

  it('8. Jahr kopieren → Ziel mit neuem Zeitstempel, Quelle byte-identisch', async () => {
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    loadStable(2027);
    const sourceBefore = JSON.stringify(localAll()['2027']);

    copyBudgetYear(2027, 2028, false, KEY);
    await flushBudgetKVBackups();

    const all = localAll();
    // Ziel: neuer Zeitstempel (echte Neuanlage)
    expect(all['2028']).toBeDefined();
    expect(Date.parse(all['2028'].updatedAt)).toBeGreaterThan(Date.parse(OLD));
    // Quelle: fachlich wie zeitlich unangetastet
    expect(JSON.stringify(all['2027'])).toBe(sourceBefore);
    expect(state.writeCount).toBe(1);
  });

  it('9. Jahr löschen → Tombstone neu gestempelt, Fremdjahr byte-identisch; wiederholtes Löschen ohne weiteren Bump', async () => {
    localStorageStore[KEY] = JSON.stringify({
      2026: realYear(2026, OLD, 500),
      2027: realYear(2027, OLD, 111),
    });
    const otherBefore = JSON.stringify(localAll()['2026']);

    deleteBudgetYear(2027, KEY);
    await flushBudgetKVBackups();

    const afterDelete = localAll();
    expect(afterDelete['2027'].deleted).toBe(true);
    const tombstoneStamp = afterDelete['2027'].updatedAt;
    expect(Date.parse(tombstoneStamp)).toBeGreaterThan(Date.parse(OLD));
    expect(JSON.stringify(afterDelete['2026'])).toBe(otherBefore);
    expect(state.writeCount).toBe(1);

    // Wiederholtes Löschen: kein neuer Zeitstempel, kein weiterer Write
    const snapshot = localStorageStore[KEY];
    deleteBudgetYear(2027, KEY);
    await flushBudgetKVBackups();
    expect(localStorageStore[KEY]).toBe(snapshot);
    expect(localAll()['2027'].updatedAt).toBe(tombstoneStamp);
    expect(state.writeCount).toBe(1);
  });

  it('10. Stale-Gerät: lokal alt, remote neu — blosses Öffnen ändert keinen Zeitstempel', async () => {
    state.rows[KEY] = { 2027: realYear(2027, '2025-06-01T00:00:00.000Z', 999) };
    localStorageStore[KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });

    loadStable(2027);
    await flushBudgetKVBackups();

    // Lokal: alter Zeitstempel bleibt; Remote: unangetastet, kein Write
    expect(localAll()['2027'].updatedAt).toBe(OLD);
    const remote = state.rows[KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2027'].updatedAt).toBe('2025-06-01T00:00:00.000Z');
    expect(remote['2027'].plLineItems?.[0].monthlyValues[0]).toBe(999);
    expect(state.writeCount).toBe(0);
  });

  it('11. Tenants: Oliv-Änderung bumpt nur Oliv — Beaulieu-Blob byte-identisch', async () => {
    localStorageStore[STORAGE_KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 111) });
    localStorageStore[BEAULIEU_KEY] = JSON.stringify({ 2027: realYear(2027, OLD, 222) });
    const olivBudget = loadStable(2027, STORAGE_KEY);
    loadStable(2027, BEAULIEU_KEY);
    const beaulieuSnapshot = localStorageStore[BEAULIEU_KEY];

    saveMarker(2027, olivBudget, 2, 777, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Oliv: neuer Zeitstempel; Beaulieu: byte-identisch, alter Zeitstempel
    expect(Date.parse(localAll(STORAGE_KEY)['2027'].updatedAt)).toBeGreaterThan(Date.parse(OLD));
    expect(localStorageStore[BEAULIEU_KEY]).toBe(beaulieuSnapshot);
    expect(localAll(BEAULIEU_KEY)['2027'].updatedAt).toBe(OLD);
    // Genau ein Remote-Write, nur im Oliv-Key
    expect(state.writeCount).toBe(1);
    expect(state.rows[BEAULIEU_KEY]).toBeUndefined();
  });

  it('12. View-Seed 2026: Laden ohne persistiertes updatedAt; erste echte Änderung setzt den ersten Zeitstempel', async () => {
    // Laden: nur View-Default, nichts persistiert
    const seed = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();
    expect((seed as StoredBudgetYear).viewDefault).toBe(true);
    expect(localStorageStore[STORAGE_KEY]).toBeUndefined();
    expect(state.writeCount).toBe(0);

    // Erste echte Änderung: erster Zeitstempel, genau EIN Write
    const item = seed.plLineItems!.find(i => i.id === 'pli_ertrag_a')!;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[0] = 250000;
    savePLLineItem(2026, { ...item, monthlyValues: vals }, STORAGE_KEY);
    await flushBudgetKVBackups();

    const stored = localAll(STORAGE_KEY)['2026'];
    expect(typeof stored.updatedAt).toBe('string');
    expect(stored.viewDefault).toBeUndefined();
    expect(state.writeCount).toBe(1);
  });

  it('13. Neuanlage über einem Tombstone speichert IMMER (neuer Zeitstempel gewinnt bewusst)', async () => {
    localStorageStore[KEY] = JSON.stringify({
      2027: { ...realYear(2027, OLD, 111), deleted: true },
    });

    saveBudgetYear(realYear(2027, OLD, 111), KEY);
    await flushBudgetKVBackups();

    const stored = localAll()['2027'];
    expect(stored.deleted).toBeUndefined();
    expect(Date.parse(stored.updatedAt)).toBeGreaterThan(Date.parse(OLD));
    expect(state.writeCount).toBe(1);
  });
});
