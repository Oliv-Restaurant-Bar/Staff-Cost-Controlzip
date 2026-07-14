// @vitest-environment happy-dom
/**
 * Stabilisierungsrunde 2.4 — App-Level-Tests: Budget-Seite LADEN (T002.1–3, T006-Teil)
 * ====================================================================================
 * Testet über den ECHTEN App-Einstieg (BudgetPage + TenantProvider + Router),
 * nicht über isolierte Store-Funktionen:
 *   1. Lokal+remote leer (2026): View-Seed sichtbar, Hinweis «noch nicht
 *      gespeichert», KEIN localStorage-Write, KEIN Supabase-Write, Importstatus
 *      (Checkliste + Cockpit) meldet «nicht vorhanden».
 *   2. Remote echtes Budget: Werte sichtbar, kein Seed-Hinweis, kein Re-Save,
 *      updatedAt unverändert.
 *   3. Mehrfaches Mounten (Tab-Wechsel-Äquivalent): keine Writes, keine
 *      Zeitstempeländerung, keine Dubletten.
 *   4. View-Seed ohne Bearbeitung erzeugt über Remounts keinen Dirty-State.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── Mocks (vi.hoisted: Supabase-Zustand steuerbar) ───────────────────────────

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writeCount: 0,
  writtenKeys: [] as string[],
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
        state.writtenKeys.push(row.key);
        state.rows[row.key] = row.value;
        return { error: null };
      },
    }),
  },
}));

vi.mock('sonner', () => {
  const toast = Object.assign(vi.fn(), {
    error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(),
  });
  return { toast };
});

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ isAdmin: true }),
}));

// Advisory-Hinweis der Import-Checkliste: eigener Kontext, hier irrelevant.
vi.mock('@/components/ImportTaskPrefillHint', () => ({
  ImportTaskPrefillHint: () => null,
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {} unobserve() {} disconnect() {}
});

import BudgetPage from '@/pages/Budget';
import { TenantProvider } from '@/contexts/TenantContext';
import { loadBudgetWithPL, STORAGE_KEY } from '@/lib/budget-store';
import { resetKVAvailabilityCache } from '@/lib/supabase-kv';
import { budgetCoverage } from '@/lib/import-tasks-db';
import { jahresbudgetSignal } from '@/lib/import-cockpit-db';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

// ─── Fixtures / Helfer ────────────────────────────────────────────────────────

const OLD = '2025-01-01T00:00:00.000Z';
const CHF = (n: number) =>
  new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

type StoredBudgetYear = BudgetYear & { deleted?: boolean; viewDefault?: boolean };

function realYear(y: number, updatedAt: string, marker: number): StoredBudgetYear {
  return {
    year: y,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: updatedAt,
    updatedAt,
    // WICHTIG: Default-Struktur-IDs verwenden — die Lade-Migration der Seite
    // ersetzt unbekannte Custom-Kategorien durch die fixe PL-Struktur; nur
    // Positionen auf Default-IDs bleiben sichtbar (App-Level-Erkenntnis 2.4).
    plCategories: [{ id: 'pl_revenue', label: 'Ertrag', sortOrder: 1, kind: 'revenue', type: 'items' }],
    plLineItems: [
      {
        id: 'pli_ertrag_a',
        categoryId: 'pl_revenue',
        label: 'Ertrag à la carte',
        valueType: 'chf',
        monthlyValues: [marker, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        sortOrder: 1,
        isDefault: true,
      } as BudgetPLLineItem,
    ],
  } as unknown as StoredBudgetYear;
}

const olivCtx = { tenantId: 'oliv', tenantKey: (k: string) => k };

function renderBudget(year: number) {
  return render(
    <MemoryRouter initialEntries={[`/budget?year=${year}`]}>
      <TenantProvider>
        <BudgetPage />
      </TenantProvider>
    </MemoryRouter>,
  );
}

/** Mikrotask-/Timer-Queue leeren (Supabase-Sync-Effekt abwarten). */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  localStorage.clear();
  state.rows = {};
  state.writeCount = 0;
  state.writtenKeys = [];
  resetKVAvailabilityCache();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ─── 1. Lokal + remote leer: View-Seed ────────────────────────────────────────

describe('BudgetPage — lokal und remote leer (2026-Seed)', () => {
  it('zeigt den View-Seed mit «noch nicht gespeichert»-Hinweis, ohne jeden Write', async () => {
    renderBudget(2026);
    await settle();

    // Hinweis sichtbar
    expect(screen.getByTestId('hint-budget-view-default').textContent)
      .toContain('Budgetvorschlag (noch nicht gespeichert)');

    // Kein localStorage-Write (Seed ist rein transient)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Kein Supabase-Write
    expect(state.writeCount).toBe(0);

    // Importstatus: Checkliste UND Cockpit melden «nicht vorhanden»
    expect(budgetCoverage(olivCtx, 2026)).toEqual({ yearDone: false });
    expect(jahresbudgetSignal(olivCtx).latestDataDate).toBeNull();
  });

  it('View-Seed erzeugt über Unmount/Remount keinen Dirty-State und keinen Write (T006)', async () => {
    const r1 = renderBudget(2026);
    await settle();
    r1.unmount();

    const r2 = renderBudget(2026);
    await settle();

    expect(screen.getByTestId('hint-budget-view-default')).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(state.writeCount).toBe(0);
    r2.unmount();
  });
});

// ─── 2. Remote echtes Budget vorhanden ────────────────────────────────────────

describe('BudgetPage — remote echtes Budget, lokal leer', () => {
  it('zeigt Remote-Werte, keinen Seed, keinen Re-Save, updatedAt unverändert', async () => {
    state.rows[STORAGE_KEY] = { 2027: realYear(2027, OLD, 4242) };
    const remoteSnapshot = JSON.stringify(state.rows[STORAGE_KEY]);

    renderBudget(2027);

    // Supabase→localStorage-Sync greift, Remote-Wert wird sichtbar
    await waitFor(() => {
      expect(screen.getAllByText(CHF(4242)).length).toBeGreaterThan(0);
    });
    await settle();

    // Kein Seed-Hinweis (echtes Budget, kein View-Default)
    expect(screen.queryByTestId('hint-budget-view-default')).toBeNull();

    // Kein Re-Save: Remote byte-identisch, kein einziger Write
    expect(state.writeCount).toBe(0);
    expect(JSON.stringify(state.rows[STORAGE_KEY])).toBe(remoteSnapshot);

    // updatedAt lokal unverändert übernommen (Ladepfad stempelt nie)
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(local[2027].updatedAt).toBe(OLD);

    // Importstatus jetzt korrekt «vorhanden»
    expect(budgetCoverage(olivCtx, 2027)).toEqual({ yearDone: true, lastImportAt: OLD });
  });
});

// ─── 3. Mehrfaches Mounten (Tab-Wechsel-Äquivalent) ───────────────────────────

describe('BudgetPage — mehrfaches Mounten', () => {
  it('erzeugt keine Writes, keine Zeitstempeländerung, keine Dubletten', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 2027: realYear(2027, OLD, 111) }));
    // Migrationen einmalig stabilisieren (identischer Ladepfad wie die Seite;
    // Lade-Migrationen persistieren nur lokal, nie remote — Runde 2.2/2.3).
    loadBudgetWithPL(2027, STORAGE_KEY);
    loadBudgetWithPL(2027, STORAGE_KEY);
    loadBudgetWithPL(2027, STORAGE_KEY);
    const snapshot = localStorage.getItem(STORAGE_KEY)!;

    for (let i = 0; i < 3; i++) {
      const r = renderBudget(2027);
      await settle();
      expect(screen.getAllByText(CHF(111)).length).toBeGreaterThan(0);
      r.unmount();
    }

    // Byte-identisch, kein Write, keine Dubletten
    expect(localStorage.getItem(STORAGE_KEY)).toBe(snapshot);
    expect(state.writeCount).toBe(0);
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(Object.keys(all)).toEqual(['2027']);
    expect(all[2027].updatedAt).toBe(OLD);
  });
});
