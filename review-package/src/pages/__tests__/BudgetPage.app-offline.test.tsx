// @vitest-environment happy-dom
/**
 * Stabilisierungsrunde 2.5 — App-Level-Test: Budget-Seite OFFLINE/RECONNECT
 * =========================================================================
 * Deckt den Kernbefund ab: «verfügbar» war dauerhaft gecacht — ein Netzwerk-
 * ausfall nach dem ersten Erfolg wurde nie erkannt. Jetzt:
 *   1. Offline-Save: Wert bleibt LOKAL gespeichert, dezenter Info-Hinweis
 *      (kein Fehler-Toast), KEIN Remote-Write, Zustand «unavailable».
 *   2. Verbindung wieder da + 30s-Fenster abgelaufen: der NÄCHSTE Save
 *      schreibt den AKTUELLEN lokalen Stand (beide Änderungen) nach Supabase.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writeCount: 0,
  writtenKeys: [] as string[],
  offline: false,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) => {
          if (state.offline) throw new Error('TypeError: Failed to fetch');
          return { data: [], error: null };
        },
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            if (state.offline) throw new Error('TypeError: Failed to fetch');
            return {
              data: state.rows[key] !== undefined ? { value: state.rows[key] } : null,
              error: null,
            };
          },
        }),
      }),
      upsert: async (row: { key: string; value: unknown }) => {
        if (state.offline) throw new Error('TypeError: Failed to fetch');
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

vi.mock('@/components/ImportTaskPrefillHint', () => ({
  ImportTaskPrefillHint: () => null,
}));

vi.stubGlobal('ResizeObserver', class {
  observe() {} unobserve() {} disconnect() {}
});

import { toast } from 'sonner';
import BudgetPage from '@/pages/Budget';
import { TenantProvider } from '@/contexts/TenantContext';
import { loadBudgetWithPL, flushBudgetKVBackups, STORAGE_KEY } from '@/lib/budget-store';
import { resetKVAvailabilityCache, getKVAvailabilityState } from '@/lib/supabase-kv';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

const OLD = '2025-01-01T00:00:00.000Z';
const BASE = new Date('2026-07-14T12:00:00.000Z').getTime();

type StoredBudgetYear = BudgetYear & { deleted?: boolean; viewDefault?: boolean };

function realYear(y: number, updatedAt: string, marker: number): StoredBudgetYear {
  return {
    year: y,
    positions: [],
    rules: [],
    wasAutoCalculated: false,
    createdAt: updatedAt,
    updatedAt,
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

function seedLocal(year: number, marker: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ [year]: realYear(year, OLD, marker) }));
  loadBudgetWithPL(year, STORAGE_KEY);
  loadBudgetWithPL(year, STORAGE_KEY);
  loadBudgetWithPL(year, STORAGE_KEY);
}

function renderBudget(year: number) {
  return render(
    <MemoryRouter initialEntries={[`/budget?year=${year}`]}>
      <TenantProvider>
        <BudgetPage />
      </TenantProvider>
    </MemoryRouter>,
  );
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

async function commitMonthCell(month: number, value: string) {
  const row = screen.getByText('Ertrag à la carte').closest('tr')!;
  const tds = row.querySelectorAll('td');
  fireEvent.click(tds[3 + month]);
  const input = await screen.findByRole('spinbutton');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await settle();
}

function localAll(): Record<string, StoredBudgetYear> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

beforeEach(() => {
  localStorage.clear();
  state.rows = {};
  state.writeCount = 0;
  state.writtenKeys = [];
  state.offline = false;
  resetKVAvailabilityCache();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('BudgetPage — Offline-Save und Wiederverbindung (Runde 2.5)', () => {
  it('offline: Wert lokal gespeichert, Info-Hinweis statt Fehler, kein Remote-Write; nach Reconnect + Fenster schreibt der nächste Save den aktuellen Stand', async () => {
    seedLocal(2027, 111);

    renderBudget(2027);
    await settle();

    // ── Phase 1: Netzwerk fällt aus ──────────────────────────────────────────
    state.offline = true;
    await commitMonthCell(0, '222');
    await flushBudgetKVBackups();

    // Lokal gespeichert, kein Remote-Write
    expect(localAll()[2027].plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues[0]).toBe(222);
    expect(state.writeCount).toBe(0);

    // Dezenter Hinweis, kein Fehler-Toast; Verfügbarkeit korrekt invalidiert
    expect(vi.mocked(toast.info)).toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    expect(getKVAvailabilityState()).toBe('unavailable');

    // ── Phase 2: Verbindung wieder da, 30s-Negativ-Fenster abgelaufen ───────
    state.offline = false;
    vi.setSystemTime(BASE + 31_000);

    await commitMonthCell(1, '333');
    await flushBudgetKVBackups();

    // Der nächste Save schreibt den AKTUELLEN lokalen Stand: BEIDE Änderungen
    expect(state.writeCount).toBeGreaterThanOrEqual(1);
    expect(state.writtenKeys.every(k => k === STORAGE_KEY)).toBe(true);
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    const remoteVals = remote[2027].plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues;
    expect(remoteVals[0]).toBe(222);
    expect(remoteVals[1]).toBe(333);
    expect(getKVAvailabilityState()).toBe('available');
  });
});
