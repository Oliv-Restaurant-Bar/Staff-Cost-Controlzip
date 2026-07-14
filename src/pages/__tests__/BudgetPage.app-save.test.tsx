// @vitest-environment happy-dom
/**
 * Stabilisierungsrunde 2.4 — App-Level-Tests: Budget-Seite SPEICHERN (T003–T006)
 * ==============================================================================
 * Die Budget-Seite hat KEINEN globalen Save-Button: jeder Zell-Commit speichert
 * sofort über savePLLineItem (T004-Äquivalent «Speichern ohne Änderung» =
 * identischer Zell-Commit; T006 «Reload nach Speichern» = Commit + Remount).
 *   1. Identischer Zell-Commit → kein Write, kein updatedAt-Bump, byte-identisch.
 *   2. Echte Änderung → sofort persistiert, genau EIN KV-Write auf den
 *      Tenant-Key, updatedAt genau einmal neu, Wert nach Remount sichtbar.
 *   3. Zwei schnelle Commits nacheinander → beide Werte lokal UND remote.
 *   4. Beaulieu-Tenant → Write NUR auf «beaulieu:budget_v1», Oliv unberührt.
 *   5. Regeln anwenden: keine Regeln bzw. No-op-Regeln → Info-Toast, kein Write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
import { resetKVAvailabilityCache } from '@/lib/supabase-kv';
import type { BudgetYear, BudgetPLLineItem, BudgetRule } from '@/types/budget';

const OLD = '2025-01-01T00:00:00.000Z';
const BEAULIEU_KEY = `beaulieu:${STORAGE_KEY}`;

type StoredBudgetYear = BudgetYear & { deleted?: boolean; viewDefault?: boolean };

function realYear(y: number, updatedAt: string, marker: number, rules: BudgetRule[] = []): StoredBudgetYear {
  return {
    year: y,
    positions: [],
    rules,
    // applyRulesToBudget setzt wasAutoCalculated = (rules.length > 0) — für den
    // No-op-Test muss die Fixture das bereits tragen, sonst wäre der Flag-Wechsel
    // eine echte fachliche Änderung.
    wasAutoCalculated: rules.length > 0,
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

/** Lokales Blob stabilisieren (Lade-Migrationen einmalig, danach idempotent). */
function seedLocal(year: number, marker: number, key = STORAGE_KEY, rules: BudgetRule[] = []) {
  localStorage.setItem(key, JSON.stringify({ [year]: realYear(year, OLD, marker, rules) }));
  loadBudgetWithPL(year, key);
  loadBudgetWithPL(year, key);
  loadBudgetWithPL(year, key);
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

/**
 * Öffnet den Inline-Editor einer Monatszelle der Position «Ertrag à la carte»
 * und committet einen Wert per Enter. Zellstruktur der Positionszeile:
 * td[0]=Konto/Bezeichnung, td[1]=Kumuliert, td[2]=%, td[3..14]=Jan..Dez.
 */
async function commitMonthCell(month: number, value: string) {
  const row = screen.getByText('Ertrag à la carte').closest('tr')!;
  const tds = row.querySelectorAll('td');
  fireEvent.click(tds[3 + month]);
  const input = await screen.findByRole('spinbutton');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await settle();
}

function localAll(key = STORAGE_KEY): Record<string, StoredBudgetYear> {
  return JSON.parse(localStorage.getItem(key) ?? '{}');
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

// ─── 1. Identischer Zell-Commit (Speichern ohne Änderung) ─────────────────────

describe('BudgetPage — Zell-Commit ohne Änderung', () => {
  it('identischer Wert → kein Write, kein updatedAt-Bump, byte-identisch', async () => {
    seedLocal(2027, 111);
    const snapshot = localStorage.getItem(STORAGE_KEY)!;

    renderBudget(2027);
    await settle();
    await commitMonthCell(0, '111');
    await flushBudgetKVBackups();

    expect(localStorage.getItem(STORAGE_KEY)).toBe(snapshot);
    expect(localAll()[2027].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });
});

// ─── 2. Echte Änderung: sofortiges Speichern, genau EIN Write ─────────────────

describe('BudgetPage — echte Zelländerung', () => {
  it('persistiert sofort, genau EIN KV-Write auf den Oliv-Key, Wert nach Remount sichtbar', async () => {
    seedLocal(2027, 111);

    const r = renderBudget(2027);
    await settle();
    await commitMonthCell(0, '222');
    await flushBudgetKVBackups();

    // Lokal: Wert + genau ein neuer Zeitstempel
    const y = localAll()[2027];
    expect(y.plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues[0]).toBe(222);
    expect(y.updatedAt).not.toBe(OLD);

    // Remote: genau EIN Write, richtiger Tenant-Key (Oliv = unpräfixt)
    expect(state.writeCount).toBe(1);
    expect(state.writtenKeys).toEqual([STORAGE_KEY]);

    // T006: «Reload» (Remount) zeigt den gespeicherten Wert
    r.unmount();
    renderBudget(2027);
    await settle();
    expect(screen.getAllByText('222').length).toBeGreaterThan(0);
    // Remount erzeugt keinen weiteren Write
    await flushBudgetKVBackups();
    expect(state.writeCount).toBe(1);
  });

  it('zwei schnelle Commits nacheinander → beide Werte lokal und remote konsistent', async () => {
    seedLocal(2027, 111);

    renderBudget(2027);
    await settle();
    await commitMonthCell(0, '222');
    await commitMonthCell(1, '333');
    await flushBudgetKVBackups();

    const vals = localAll()[2027].plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues;
    expect(vals[0]).toBe(222);
    expect(vals[1]).toBe(333);

    // Remote-Endstand ≡ lokaler Endstand (letzter Write gewinnt, nichts verloren)
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    const remoteVals = remote[2027].plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues;
    expect(remoteVals[0]).toBe(222);
    expect(remoteVals[1]).toBe(333);
  });
});

// ─── 3. Tenant-Isolation beim Speichern ───────────────────────────────────────

describe('BudgetPage — Speichern unter Beaulieu', () => {
  it('schreibt NUR auf «beaulieu:budget_v1»; Oliv-Blob bleibt unberührt', async () => {
    localStorage.setItem('active_tenant', 'beaulieu');
    seedLocal(2027, 111, BEAULIEU_KEY);

    renderBudget(2027);
    await settle();
    await commitMonthCell(0, '444');
    await flushBudgetKVBackups();

    expect(state.writeCount).toBe(1);
    expect(state.writtenKeys).toEqual([BEAULIEU_KEY]);

    // Beaulieu lokal aktualisiert, Oliv-Key existiert weiterhin nicht
    expect(localAll(BEAULIEU_KEY)[2027].plLineItems!.find(i => i.id === 'pli_ertrag_a')!.monthlyValues[0]).toBe(444);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

// ─── 4. Regeln anwenden: leere und wirkungslose Regeln ────────────────────────

describe('BudgetPage — «Regeln anwenden»', () => {
  it('ohne definierte Regeln → Info-Toast, kein Write', async () => {
    seedLocal(2027, 111);
    const snapshot = localStorage.getItem(STORAGE_KEY)!;

    renderBudget(2027);
    await settle();
    fireEvent.click(screen.getAllByText('Regeln anwenden')[0]);
    await flushBudgetKVBackups();

    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Keine Regeln definiert.');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(snapshot);
    expect(state.writeCount).toBe(0);
  });

  it('No-op-Regel (Position existiert nicht) → «Keine Änderungen»-Toast, kein Write, kein Bump', async () => {
    const noopRule: BudgetRule = {
      id: 'r1',
      type: 'reduce_cost_by_pct',
      positionId: 'nonexistent',
      value: 5,
    } as BudgetRule;
    seedLocal(2027, 111, STORAGE_KEY, [noopRule]);
    const snapshot = localStorage.getItem(STORAGE_KEY)!;

    renderBudget(2027);
    await settle();
    fireEvent.click(screen.getAllByText('Regeln anwenden')[0]);
    await flushBudgetKVBackups();

    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Keine Änderungen — Regeln ergaben dieselben Werte.');
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(snapshot);
    expect(localAll()[2027].updatedAt).toBe(OLD);
    expect(state.writeCount).toBe(0);
  });
});
