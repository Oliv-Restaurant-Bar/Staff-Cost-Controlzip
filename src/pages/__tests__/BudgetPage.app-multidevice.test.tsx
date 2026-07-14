// @vitest-environment happy-dom
/**
 * Stabilisierungsrunde 2.4 — App-Level-Tests: Zwei-Geräte-Szenarien (T005/T008)
 * =============================================================================
 * Simuliert zwei Geräte über die ECHTEN Sync-Pfade der App:
 *   - «Gerät B frisch» = localStorage geleert, Supabase (state.rows) bleibt —
 *     Seiten-eigener Sync-Effekt (syncBudgetFromSupabase) zieht den Stand nach.
 *   - «Gerät B veraltet» = alter lokaler Blob + globaler App-Sync
 *     (syncSupabaseToLocal, Supabase = Master) + 'supabase-kv-synced'-Event.
 * Szenarien:
 *   1. Gerät A speichert → Gerät B (frisch) sieht den Wert, ohne Re-Save.
 *   2. Gerät A löscht das Jahr über den Löschen-Dialog (Tombstone) →
 *      Gerät B (veraltet) sieht das Jahr nach dem App-Sync NICHT mehr;
 *      der Tombstone wird nicht wiederbelebt.
 *   3. Stale-Response nach Tenant-Wechsel: eine verspätete Oliv-Antwort darf
 *      NICHT im Beaulieu-UI landen (replit.md §2: veraltete Antworten nach
 *      Tenant-Wechsel verwerfen).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  writeCount: 0,
  writtenKeys: [] as string[],
  /** Keys, deren Lese-Antwort angehalten wird, bis release() gerufen wird. */
  holdKeys: new Set<string>(),
  releases: [] as Array<() => void>,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) => ({ data: [], error: null }),
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            if (state.holdKeys.has(key)) {
              await new Promise<void>(res => state.releases.push(res));
            }
            return {
              data: state.rows[key] !== undefined ? { value: state.rows[key] } : null,
              error: null,
            };
          },
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

import BudgetPage from '@/pages/Budget';
import { TenantProvider, useTenant } from '@/contexts/TenantContext';
import { loadBudgetWithPL, flushBudgetKVBackups, STORAGE_KEY } from '@/lib/budget-store';
import { resetKVAvailabilityCache, syncSupabaseToLocal } from '@/lib/supabase-kv';
import { budgetCoverage } from '@/lib/import-tasks-db';
import type { BudgetYear, BudgetPLLineItem } from '@/types/budget';

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

/** Test-Schalter für den Mandantenwechsel (die Seite selbst rendert keinen). */
function TenantSwitchButton({ target }: { target: 'oliv' | 'beaulieu' }) {
  const { setTenant } = useTenant();
  return (
    <button data-testid={`switch-to-${target}`} onClick={() => setTenant(target)}>
      Wechsel {target}
    </button>
  );
}

function renderBudget(year: number, switchTarget?: 'oliv' | 'beaulieu') {
  return render(
    <MemoryRouter initialEntries={[`/budget?year=${year}`]}>
      <TenantProvider>
        {switchTarget && <TenantSwitchButton target={switchTarget} />}
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

function seedLocal(year: number, marker: number, key = STORAGE_KEY) {
  localStorage.setItem(key, JSON.stringify({ [year]: realYear(year, OLD, marker) }));
  loadBudgetWithPL(year, key);
  loadBudgetWithPL(year, key);
  loadBudgetWithPL(year, key);
}

beforeEach(() => {
  localStorage.clear();
  state.rows = {};
  state.writeCount = 0;
  state.writtenKeys = [];
  state.holdKeys = new Set();
  state.releases = [];
  resetKVAvailabilityCache();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ─── 1. Gerät A speichert → Gerät B (frisch) sieht den Wert ───────────────────

describe('Zwei Geräte — Änderung propagiert', () => {
  it('Gerät B (leeres localStorage) lädt den von Gerät A gespeicherten Stand, ohne Re-Save', async () => {
    // Gerät A: lokales Budget, Zelle ändern, Backup nach Supabase
    seedLocal(2027, 111);
    const a = renderBudget(2027);
    await settle();
    await commitMonthCell(0, '555');
    await flushBudgetKVBackups();
    expect(state.writeCount).toBe(1);
    const deviceAUpdatedAt = (state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>)[2027].updatedAt;
    a.unmount();

    // Gerät B: frisches Gerät (localStorage leer, Supabase bleibt)
    localStorage.clear();
    renderBudget(2027);

    // Seiten-Sync-Effekt zieht den Supabase-Stand nach
    await waitFor(() => {
      expect(screen.getAllByText('555').length).toBeGreaterThan(0);
    });
    await settle();
    await flushBudgetKVBackups();

    // Kein Re-Save, kein neuer Zeitstempel auf Gerät B
    expect(state.writeCount).toBe(1);
    const localB = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, StoredBudgetYear>;
    expect(localB[2027].updatedAt).toBe(deviceAUpdatedAt);
  });
});

// ─── 2. Gerät A löscht (Tombstone) → Gerät B (veraltet) ──────────────────────

describe('Zwei Geräte — Löschung propagiert (Tombstone)', () => {
  it('Gerät B mit veraltetem lokalem Stand übernimmt den Tombstone und belebt ihn nicht wieder', async () => {
    // Gerät A: Jahr vorhanden, einmal echt gespeichert (damit remote gefüllt)
    seedLocal(2027, 111);
    const a = renderBudget(2027);
    await settle();
    await commitMonthCell(0, '555');
    await flushBudgetKVBackups();

    // Gerät A löscht über den echten Löschen-Dialog
    const trashBtn = document.querySelector('button .lucide-trash2')?.closest('button');
    expect(trashBtn).toBeTruthy();
    fireEvent.click(trashBtn!);
    const confirmBtn = await screen.findByRole('button', { name: 'Löschen' });
    fireEvent.click(confirmBtn);
    await settle();
    await flushBudgetKVBackups();

    // Remote trägt jetzt den Tombstone
    const remote = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    expect(remote[2027].deleted).toBe(true);
    const tombstoneAt = remote[2027].updatedAt;
    a.unmount();

    // Gerät B: VERALTETER lokaler Stand (Jahr noch aktiv, alter Zeitstempel)
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ 2027: realYear(2027, OLD, 111) }));
    renderBudget(2027);
    await settle();

    // Globaler App-Sync (Supabase = Master) + Sync-Event wie beim App-Start
    await syncSupabaseToLocal([STORAGE_KEY], 'oliv');
    window.dispatchEvent(new Event('supabase-kv-synced'));
    await settle();

    // Jahr ist auf Gerät B verschwunden (kein 555, kein 111 mehr sichtbar)
    expect(screen.queryAllByText('555').length).toBe(0);
    expect(screen.queryAllByText('111').length).toBe(0);

    // Lokal: Tombstone übernommen, unverändert (nicht wiederbelebt, kein Bump)
    const localB = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, StoredBudgetYear>;
    expect(localB[2027].deleted).toBe(true);
    expect(localB[2027].updatedAt).toBe(tombstoneAt);

    // Import-Status: Budget gilt als NICHT vorhanden
    expect(budgetCoverage(olivCtx, 2027)).toEqual({ yearDone: false });

    // Blosse Anzeige erzeugt keinen weiteren Write (Tombstone bleibt remote intakt)
    await flushBudgetKVBackups();
    const remoteAfter = state.rows[STORAGE_KEY] as Record<string, StoredBudgetYear>;
    expect(remoteAfter[2027].deleted).toBe(true);
  });
});

// ─── 3. Stale-Response nach Tenant-Wechsel ────────────────────────────────────

describe('Tenant-Wechsel — verspätete Supabase-Antwort', () => {
  it('eine verspätete Oliv-Antwort landet NICHT im Beaulieu-UI (§2: stale Antworten verwerfen)', async () => {
    // Remote: Oliv hat ein echtes Budget, Beaulieu nichts. Lokal: beide leer.
    state.rows[STORAGE_KEY] = { 2027: realYear(2027, OLD, 777) };
    // Oliv-Leseantwort anhalten (simuliert langsames Netz)
    state.holdKeys.add(STORAGE_KEY);

    renderBudget(2027, 'beaulieu');
    await settle();

    // Noch keine Oliv-Daten sichtbar (Antwort hängt)
    expect(screen.queryAllByText('777').length).toBe(0);

    // Tenant-Wechsel WÄHREND die Oliv-Antwort aussteht
    fireEvent.click(screen.getByTestId('switch-to-beaulieu'));
    await settle();

    // Jetzt trifft die verspätete Oliv-Antwort ein
    state.releases.forEach(res => res());
    state.releases = [];
    await settle();
    await settle();

    // Die Oliv-Daten dürfen NICHT im Beaulieu-UI erscheinen
    expect(screen.queryAllByText('777').length).toBe(0);

    // Und der Beaulieu-Blob bleibt frei von Oliv-Daten
    const beaulieuBlob = localStorage.getItem(`beaulieu:${STORAGE_KEY}`);
    if (beaulieuBlob) {
      expect(beaulieuBlob.includes('777')).toBe(false);
    }
  });

  it('umgekehrte Reihenfolge: eine verspätete Beaulieu-Antwort landet NICHT im Oliv-UI', async () => {
    // Start als Beaulieu; remote hat NUR Beaulieu ein echtes Budget
    localStorage.setItem('active_tenant', 'beaulieu');
    const BEAULIEU_KEY = `beaulieu:${STORAGE_KEY}`;
    state.rows[BEAULIEU_KEY] = { 2027: realYear(2027, OLD, 888) };
    // Beaulieu-Leseantwort anhalten (simuliert langsames Netz)
    state.holdKeys.add(BEAULIEU_KEY);

    renderBudget(2027, 'oliv');
    await settle();

    // Noch keine Beaulieu-Daten sichtbar (Antwort hängt)
    expect(screen.queryAllByText('888').length).toBe(0);

    // Tenant-Wechsel zu Oliv WÄHREND die Beaulieu-Antwort aussteht
    fireEvent.click(screen.getByTestId('switch-to-oliv'));
    await settle();

    // Jetzt trifft die verspätete Beaulieu-Antwort ein
    state.releases.forEach(res => res());
    state.releases = [];
    await settle();
    await settle();

    // Die Beaulieu-Daten dürfen NICHT im Oliv-UI erscheinen
    expect(screen.queryAllByText('888').length).toBe(0);

    // Und der Oliv-Blob bleibt frei von Beaulieu-Daten
    const olivBlob = localStorage.getItem(STORAGE_KEY);
    if (olivBlob) {
      expect(olivBlob.includes('888')).toBe(false);
    }
  });
});
