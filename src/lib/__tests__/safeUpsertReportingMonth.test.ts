// @vitest-environment node
/**
 * Schutztest: safeUpsertReportingMonth (Jahresimport-Schreibschutz auf KV-Ebene)
 * ==============================================================================
 * Deckt exakt die geschlossene Lücke ab: Der frühere catch-Fallback
 * `kvSet(storeKey, { [monthId]: monthRecord })` hätte den GESAMTEN
 * Supabase-Blob durch EINEN Monat ersetzt — alle anderen Monate/Jahre wären
 * verloren gewesen.
 *
 * Getestet:
 *   1. Normalfall: bestehende Monate anderer Jahre bleiben im KV erhalten,
 *      nur der Ziel-Monat wird ersetzt.
 *   2. Remote-Read schlägt fehl (kvGet → null): lokale Monate werden als
 *      Basis-Union übernommen — es wird NIE ein Ein-Monats-Blob geschrieben.
 *   3. Upsert-Fehler (Supabase liefert error): Funktion wirft, der bestehende
 *      KV-Blob bleibt unverändert, localStorage wird nicht angefasst.
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
  failRead: false,
  failWrite: false,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        // isAvailable(): .select('key').limit(1)
        limit: async (_n: number) => ({ data: [], error: null }),
        // kvGet(): .select('value').eq('key', key).maybeSingle()
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

import { safeUpsertReportingMonth } from '../supabase-kv';

const KEY = 'test_reporting_kv_guard';
const rec = (marker: string) => ({ marker });

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.failRead = false;
  state.failWrite = false;
});

describe('safeUpsertReportingMonth — kein kompletter Blob-Replace', () => {
  it('ersetzt NUR den Ziel-Monat — Monate anderer Jahre bleiben im KV erhalten', async () => {
    state.rows[KEY] = {
      '2025-03': rec('2025-03'),
      '2026-01': rec('2026-01'),
    };

    await safeUpsertReportingMonth('2024-07', rec('2024-07-neu'), KEY);

    const blob = state.rows[KEY] as Record<string, unknown>;
    expect(Object.keys(blob).sort()).toEqual(['2024-07', '2025-03', '2026-01']);
    expect(blob['2025-03']).toEqual(rec('2025-03'));
    expect(blob['2026-01']).toEqual(rec('2026-01'));
    expect(blob['2024-07']).toEqual(rec('2024-07-neu'));
  });

  it('Remote-Read fehlgeschlagen → lokale Monate als Basis, NIE Ein-Monats-Blob', async () => {
    // KV hat Daten, aber der Read scheitert (kvGet → null, nicht unterscheidbar
    // von «leer»). localStorage kennt die Monate — sie dürfen nicht verloren gehen.
    localStorageStore[KEY] = JSON.stringify({
      '2025-03': rec('2025-03'),
      '2026-01': rec('2026-01'),
    });
    state.failRead = true;

    await safeUpsertReportingMonth('2024-07', rec('2024-07-neu'), KEY);

    const blob = state.rows[KEY] as Record<string, unknown>;
    expect(Object.keys(blob).sort()).toEqual(['2024-07', '2025-03', '2026-01']);
  });

  it('Upsert-Fehler → wirft sichtbar, KV-Blob und localStorage bleiben unverändert', async () => {
    state.rows[KEY] = { '2025-03': rec('2025-03') };
    localStorageStore[KEY] = JSON.stringify({ '2025-03': rec('2025-03') });
    state.failWrite = true;

    await expect(
      safeUpsertReportingMonth('2024-07', rec('2024-07-neu'), KEY),
    ).rejects.toBeTruthy();

    // Kein destruktiver Fallback-Write: Blob unverändert
    expect(state.rows[KEY]).toEqual({ '2025-03': rec('2025-03') });
    // localStorage nicht mit unvollständigem Stand überschrieben
    expect(JSON.parse(localStorageStore[KEY]!)).toEqual({ '2025-03': rec('2025-03') });
  });
});
