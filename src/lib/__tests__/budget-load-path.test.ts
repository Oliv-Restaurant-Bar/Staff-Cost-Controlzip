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
 *
 * Runde 2.2 (Auto-Seed als reiner View-Default) — echte App-Einstiegspfade:
 *   S1. Lokal leer, Remote leer: Seedwerte sichtbar, kein Write, kein
 *       updatedAt, Importstatus bleibt «nicht vorhanden».
 *   S2. Lokal leer, Remote mit echtem 2026: Remote-Werte nach Sync, kein Seed,
 *       kein Re-Save, Remote byte-identisch.
 *   S3. Lokal stale Altstand, Remote echt: Sync-Logik gewinnt, Öffnen
 *       schreibt nichts zurück.
 *   S4. 2026-Tombstone: View-Seed reanimiert nichts; erst bewusste
 *       Benutzeraktion erzeugt ein neues Budget.
 *   S5. Erste echte Bearbeitung: genau EIN Save, korrekter Tenant-Key,
 *       Fremdjahre unverändert, transientes viewDefault nie persistiert.
 *   S6. Expliziter Reset auf Seed: echte Mutation, Remote bewusst aktualisiert.
 *   S7. Oliv/Beaulieu: getrennte View-Seeds, tenant-korrekte Persistierung,
 *       keine Cross-Tenant-Writes.
 *   S8. Mehrfaches Laden: keine Writes, keine Zeitstempel, keine Dubletten.
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
  resetBudget2026ToSeed,
  syncBudgetFromSupabase,
  syncPLToLegacyPositions,
  flushBudgetKVBackups,
  availableBudgetYears,
  STORAGE_KEY,
} from '../budget-store';
import { budgetCoverage } from '../import-tasks-db';
import { jahresbudgetSignal } from '../import-cockpit-db';
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
  } as unknown as StoredBudgetYear;
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

// ─── Runde 2.2: 2026-Seed ist reiner View-Default ─────────────────────────────

const BEAULIEU_KEY = 'beaulieu:budget_v1';
/** Import-Leser-Kontexte (echte Leser aus Checkliste/Cockpit, read-only) */
const ctxOliv = { tenantId: 'oliv', tenantKey: (k: string) => k };
const ctxBeaulieu = { tenantId: 'beaulieu', tenantKey: (k: string) => `beaulieu:${k}` };

function janRevenue(b: BudgetYear): number | undefined {
  return b.plLineItems?.find(i => i.id === 'pli_ertrag_a')?.monthlyValues[0];
}

describe('Runde 2.2: loadBudgetWithPL(2026) — View-Default statt persistiertem Seed', () => {
  it('S1: lokal leer, remote leer — Seedwerte sichtbar, kein Write, Importstatus «nicht vorhanden»', async () => {
    const loaded = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Seedwerte sichtbar (Oliv: Januar-Umsatz 240'000), als View-Default markiert
    expect(janRevenue(loaded)).toBe(240000);
    expect(loaded.viewDefault).toBe(true);
    // Kein localStorage-Record, kein Supabase-Write, kein persistiertes updatedAt
    expect(localStorageStore[STORAGE_KEY]).toBeUndefined();
    expect(state.writeCount).toBe(0);
    expect(availableBudgetYears(STORAGE_KEY)).toEqual([]);
    // Echte Import-Leser: Checkliste + Cockpit sehen KEINEN Datenbestand
    expect(budgetCoverage(ctxOliv, 2026)).toEqual({ yearDone: false });
    const signal = jahresbudgetSignal(ctxOliv);
    expect(signal.latestDataDate).toBeNull();
    expect(signal.recordCount ?? 0).toBe(0);
  });

  it('S2: lokal leer, remote echtes 2026 — Remote-Werte nach Sync, kein Seed, Remote byte-identisch', async () => {
    state.rows[STORAGE_KEY] = { 2026: realYear(2026, '2026-05-01T12:00:00.000Z', 777) };
    const remoteSnapshot = JSON.stringify(state.rows[STORAGE_KEY]);

    // Bestehende Sync-Logik (läuft in der Budget-Seite, wenn nur der View-Default da ist)
    const synced = await syncBudgetFromSupabase(2026, STORAGE_KEY);
    expect(synced).not.toBeNull();

    const loaded = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    expect(loaded.plLineItems?.find(i => i.id === 'pli_test')?.monthlyValues[0]).toBe(777);
    expect(loaded.viewDefault).toBeUndefined();
    // Kein Re-Save: Remote blieb byte-identisch, kein einziger Write
    expect(state.writeCount).toBe(0);
    expect(JSON.stringify(state.rows[STORAGE_KEY])).toBe(remoteSnapshot);
  });

  it('S3: lokal stale Altstand, remote echtes Budget — Sync gewinnt, Öffnen schreibt nichts zurück', async () => {
    localStorageStore[STORAGE_KEY] = JSON.stringify({
      2026: realYear(2026, '2026-01-01T12:00:00.000Z', 111),
    });
    state.rows[STORAGE_KEY] = { 2026: realYear(2026, '2026-06-01T12:00:00.000Z', 999) };

    await syncBudgetFromSupabase(2026, STORAGE_KEY);
    const loaded = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    expect(loaded.plLineItems?.find(i => i.id === 'pli_test')?.monthlyValues[0]).toBe(999);
    expect(state.writeCount).toBe(0);
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    expect(remote['2026'].updatedAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('S4: 2026-Tombstone — View-Seed reanimiert nichts; erst Benutzeraktion erzeugt neues Budget', async () => {
    localStorageStore[STORAGE_KEY] = JSON.stringify({
      2026: { ...realYear(2026, '2026-06-01T12:00:00.000Z', 111), deleted: true },
    });

    const loaded = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Seed sichtbar als View-Default, Tombstone bleibt unangetastet
    expect(loaded.viewDefault).toBe(true);
    const local = JSON.parse(localStorageStore[STORAGE_KEY]) as Record<string, StoredBudgetYear>;
    expect(local['2026'].deleted).toBe(true);
    expect(local['2026'].updatedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(state.writeCount).toBe(0);
    expect(budgetCoverage(ctxOliv, 2026)).toEqual({ yearDone: false });

    // Bewusste Benutzeraktion (Wert ändern) ersetzt den Tombstone
    const item = loaded.plLineItems!.find(i => i.id === 'pli_ertrag_a')!;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[0] = 250000;
    savePLLineItem(2026, { ...item, monthlyValues: vals }, STORAGE_KEY);
    await flushBudgetKVBackups();

    const after = JSON.parse(localStorageStore[STORAGE_KEY]) as Record<string, StoredBudgetYear>;
    expect(after['2026'].deleted).toBeUndefined();
    expect(after['2026'].plLineItems?.find(i => i.id === 'pli_ertrag_a')?.monthlyValues[0]).toBe(250000);
    expect(state.writeCount).toBe(1);
  });

  it('S5: erste echte Bearbeitung — genau EIN Save, Fremdjahre unverändert, viewDefault nie persistiert', async () => {
    // Fremdjahr 2025 existiert lokal + remote (darf sich nicht ändern)
    localStorageStore[STORAGE_KEY] = JSON.stringify({
      2025: realYear(2025, '2026-01-01T12:00:00.000Z', 500),
    });
    state.rows[STORAGE_KEY] = { 2025: realYear(2025, '2026-01-01T12:00:00.000Z', 500) };

    const loaded = loadBudgetWithPL(2026, STORAGE_KEY);
    expect(loaded.viewDefault).toBe(true);

    const item = loaded.plLineItems!.find(i => i.id === 'pli_ertrag_a')!;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[0] = 999999;
    savePLLineItem(2026, { ...item, monthlyValues: vals }, STORAGE_KEY);
    await flushBudgetKVBackups();

    // Genau EIN KV-Write; Record jetzt echt (updatedAt gesetzt, kein viewDefault)
    expect(state.writeCount).toBe(1);
    const local = JSON.parse(localStorageStore[STORAGE_KEY]) as Record<string, StoredBudgetYear & { viewDefault?: boolean }>;
    expect(local['2026']).toBeDefined();
    expect(local['2026'].viewDefault).toBeUndefined();
    expect(typeof local['2026'].updatedAt).toBe('string');
    expect(local['2026'].plLineItems?.find(i => i.id === 'pli_ertrag_a')?.monthlyValues[0]).toBe(999999);
    // Fremdjahr 2025 blieb lokal wie remote unverändert
    expect(local['2025'].updatedAt).toBe('2026-01-01T12:00:00.000Z');
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear & { viewDefault?: boolean }>;
    expect(remote['2025'].updatedAt).toBe('2026-01-01T12:00:00.000Z');
    expect(remote['2026'].viewDefault).toBeUndefined();
    // Import-Leser sehen das Jahr erst JETZT als vorhanden
    expect(budgetCoverage(ctxOliv, 2026).yearDone).toBe(true);
    expect(jahresbudgetSignal(ctxOliv).recordCount).toBeGreaterThan(0);
  });

  it('S6: expliziter Reset auf Seed — echte Mutation, Remote wird bewusst aktualisiert', async () => {
    const reset = resetBudget2026ToSeed(STORAGE_KEY);
    await flushBudgetKVBackups();

    expect(janRevenue(reset)).toBe(240000);
    expect(state.writeCount).toBe(1);
    const local = JSON.parse(localStorageStore[STORAGE_KEY]) as Record<string, StoredBudgetYear & { viewDefault?: boolean }>;
    expect(janRevenue(local['2026'])).toBe(240000);
    expect(local['2026'].viewDefault).toBeUndefined();
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    expect(janRevenue(remote['2026'])).toBe(240000);
  });

  it('S7: Oliv und Beaulieu — getrennte View-Seeds, tenant-korrekte erste Persistierung', async () => {
    const oliv = loadBudgetWithPL(2026, STORAGE_KEY);
    const beaulieu = loadBudgetWithPL(2026, BEAULIEU_KEY);

    // Getrennte Seeds je Mandant (Oliv 240'000, Beaulieu 120'000 im Januar)
    expect(oliv.viewDefault).toBe(true);
    expect(beaulieu.viewDefault).toBe(true);
    expect(janRevenue(oliv)).toBe(240000);
    expect(janRevenue(beaulieu)).toBe(120000);

    // Erste Persistierung nur im Beaulieu-Key — kein Cross-Tenant-Write
    const item = beaulieu.plLineItems!.find(i => i.id === 'pli_ertrag_a')!;
    const vals = [...item.monthlyValues] as BudgetPLLineItem['monthlyValues'];
    vals[0] = 121000;
    savePLLineItem(2026, { ...item, monthlyValues: vals }, BEAULIEU_KEY);
    await flushBudgetKVBackups();

    expect(localStorageStore[STORAGE_KEY]).toBeUndefined();
    expect(state.rows[STORAGE_KEY]).toBeUndefined();
    const localB = JSON.parse(localStorageStore[BEAULIEU_KEY]) as Record<string, StoredBudgetYear>;
    expect(localB['2026'].plLineItems?.find(i => i.id === 'pli_ertrag_a')?.monthlyValues[0]).toBe(121000);
    expect(state.writeCount).toBe(1);
    // Leser: Beaulieu vorhanden, Oliv weiterhin «nicht vorhanden»
    expect(budgetCoverage(ctxBeaulieu, 2026).yearDone).toBe(true);
    expect(budgetCoverage(ctxOliv, 2026)).toEqual({ yearDone: false });
  });

  it('S8: mehrfaches Laden — keine Writes, keine Zeitstempel, keine Dubletten', async () => {
    const first = loadBudgetWithPL(2026, STORAGE_KEY);
    const second = loadBudgetWithPL(2026, STORAGE_KEY);
    const third = loadBudgetWithPL(2026, STORAGE_KEY);
    await flushBudgetKVBackups();

    expect(localStorageStore[STORAGE_KEY]).toBeUndefined();
    expect(state.writeCount).toBe(0);
    // Keine Dubletten: Positionsliste bleibt über Ladevorgänge stabil
    expect(second.plLineItems?.length).toBe(first.plLineItems?.length);
    expect(third.plLineItems?.length).toBe(first.plLineItems?.length);
    const ids = third.plLineItems!.map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
