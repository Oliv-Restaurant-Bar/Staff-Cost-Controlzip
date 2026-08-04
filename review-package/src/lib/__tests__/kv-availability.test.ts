// @vitest-environment node
/**
 * Stabilisierungsrunde 2.5 — Supabase-Verfügbarkeit ist FLÜCHTIG (T008)
 * =====================================================================
 * Deckt die geschlossene Lücke ab: `_available === true` wurde früher
 * dauerhaft gecacht — ein Netzwerkausfall NACH dem ersten Erfolg wurde nie
 * erkannt. Jetzt gilt:
 *   - Erfolg → available; Netzwerk-/Timeout-/Offline-Fehler → unavailable
 *     (30s-Negativ-Fenster), danach wird neu geprüft.
 *   - Echte DB-Fehler (RLS, Constraint, statement timeout) sind KEIN
 *     Offline-Signal — Verfügbarkeit bleibt bestehen, Fehler bleibt sichtbar.
 *   - Retry liest den aktuellsten lokalen Stand (kein eingefrorener Snapshot)
 *     und schreibt tenant-sicher auf den ursprünglichen Key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks (vor Produktions-Import, vi.mock wird gehoisted) ───────────────────

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

type Failure = { kind: 'throw' | 'error'; message: string } | null;

const state = {
  rows: {} as Record<string, unknown>,
  probeFailure: null as Failure,
  readFailure: null as Failure,
  writeFailure: null as Failure,
  probeCalls: 0,
  readCalls: 0,
  writeCalls: 0,
  writtenPayloads: [] as Array<{ key: string; value: unknown }>,
};

function applyFailure(f: Failure): { error: { message: string } } | null {
  if (!f) return null;
  if (f.kind === 'throw') throw new Error(f.message);
  return { error: { message: f.message } };
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        limit: async (_n: number) => {
          state.probeCalls++;
          const f = applyFailure(state.probeFailure);
          return f ?? { data: [], error: null };
        },
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => {
            state.readCalls++;
            const f = applyFailure(state.readFailure);
            if (f) return { data: null, ...f };
            return {
              data: state.rows[key] !== undefined ? { value: state.rows[key] } : null,
              error: null,
            };
          },
        }),
      }),
      upsert: async (row: { key: string; value: unknown }) => {
        state.writeCalls++;
        const f = applyFailure(state.writeFailure);
        if (f) return f;
        state.rows[row.key] = row.value;
        state.writtenPayloads.push({ key: row.key, value: row.value });
        return { error: null };
      },
    }),
  },
}));

const toastCalls = {
  info: [] as Array<{ msg: string; opts: Record<string, unknown> }>,
  error: [] as Array<{ msg: string; opts: Record<string, unknown> }>,
};
vi.mock('sonner', () => ({
  toast: {
    info: (msg: string, opts: Record<string, unknown>) => toastCalls.info.push({ msg, opts }),
    error: (msg: string, opts: Record<string, unknown>) => toastCalls.error.push({ msg, opts }),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import {
  kvGet,
  kvSet,
  kvGetStrict,
  kvSetStrict,
  subscribeKV,
  isKvUnavailable,
  KVUnavailableError,
  resetKVAvailabilityCache,
  getKVAvailabilityState,
  saveOvertimeDisabledIds,
} from '../supabase-kv';

const BASE = new Date('2026-07-14T12:00:00.000Z').getTime();

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.probeFailure = null;
  state.readFailure = null;
  state.writeFailure = null;
  state.probeCalls = 0;
  state.readCalls = 0;
  state.writeCalls = 0;
  state.writtenPayloads = [];
  toastCalls.info.length = 0;
  toastCalls.error.length = 0;
  resetKVAvailabilityCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('T008/1 — Startzustand unknown → erster Erfolg → available', () => {
  it('unknown vor dem ersten Zugriff; erfolgreicher Check setzt available', async () => {
    expect(getKVAvailabilityState()).toBe('unknown');
    state.rows['k1'] = { a: 1 };
    const v = await kvGet('k1');
    expect(v).toEqual({ a: 1 });
    expect(getKVAvailabilityState()).toBe('available');
  });
});

describe('T008/2 — available, danach Netzwerkfehler → unavailable + kein Remote-Write im Fenster', () => {
  it('Netzwerkfehler in kvSetStrict invalidiert den true-Cache', async () => {
    await kvGet('warmup'); // → available
    expect(getKVAvailabilityState()).toBe('available');

    state.writeFailure = { kind: 'throw', message: 'TypeError: Failed to fetch' };
    await expect(kvSetStrict('k', { v: 1 })).rejects.toThrow();
    expect(getKVAvailabilityState()).toBe('unavailable');

    // Innerhalb des Negativ-Fensters: KEIN weiterer Remote-Versuch
    const writesBefore = state.writeCalls;
    const probesBefore = state.probeCalls;
    await kvSet('k', { v: 2 }); // still (non-strict)
    await expect(kvSetStrict('k', { v: 3 })).rejects.toBeInstanceOf(KVUnavailableError);
    expect(state.writeCalls).toBe(writesBefore);
    expect(state.probeCalls).toBe(probesBefore);
  });

  it('Netzwerkfehler in kvGet (still) invalidiert den true-Cache ebenfalls', async () => {
    await kvGet('warmup');
    state.readFailure = { kind: 'throw', message: 'NetworkError when attempting to fetch resource.' };
    expect(await kvGet('k')).toBeNull();
    expect(getKVAvailabilityState()).toBe('unavailable');
  });
});

describe('T008/3 — unavailable, Fenster abgelaufen → Re-Check → available', () => {
  it('nach 30s wird neu geprüft; Erfolg setzt wieder available', async () => {
    state.probeFailure = { kind: 'throw', message: 'Failed to fetch' };
    expect(await kvGet('k')).toBeNull();
    expect(getKVAvailabilityState()).toBe('unavailable');

    // Fenster noch aktiv: kein neuer Probe-Versuch
    const probesBefore = state.probeCalls;
    await kvGet('k');
    expect(state.probeCalls).toBe(probesBefore);

    // Verbindung kommt zurück + Fenster abgelaufen
    state.probeFailure = null;
    state.rows['k'] = 'wieder-da';
    vi.setSystemTime(BASE + 31_000);
    expect(await kvGet('k')).toBe('wieder-da');
    expect(getKVAvailabilityState()).toBe('available');
  });
});

describe('T008/4 — echter DB-Fehler (RLS/Constraint) bleibt available + sichtbarer Fehler', () => {
  it('RLS-Fehler beim Schreiben: Verfügbarkeit bleibt, Fehler wird geworfen', async () => {
    await kvGet('warmup');
    state.writeFailure = { kind: 'error', message: 'permission denied for table app_settings' };
    await expect(kvSetStrict('k', { v: 1 })).rejects.toMatchObject({
      message: 'permission denied for table app_settings',
    });
    expect(getKVAvailabilityState()).toBe('available');
    expect(isKvUnavailable({ message: 'permission denied for table app_settings' })).toBe(false);
  });

  it('RLS-Fehler in der Probe gilt als erreichbar (Verbindung steht)', async () => {
    state.probeFailure = { kind: 'error', message: 'permission denied for table app_settings' };
    state.rows['k'] = 42;
    expect(await kvGet('k')).toBe(42);
    expect(getKVAvailabilityState()).toBe('available');
  });

  it('Server-seitiger statement timeout ist KEIN Offline-Signal', async () => {
    await kvGet('warmup');
    state.writeFailure = { kind: 'error', message: 'canceling statement due to statement timeout' };
    await expect(kvSetStrict('k', 1)).rejects.toBeDefined();
    expect(getKVAvailabilityState()).toBe('available');
  });
});

describe('T008/5 — Supabase nicht konfiguriert → lokal ok, dezenter Hinweis, kein Remote-Write', () => {
  it('saveOvertimeDisabledIds: localStorage gespeichert, Info-Toast, kein Fehler-Toast', async () => {
    state.probeFailure = { kind: 'throw', message: 'supabaseUrl is required.' };
    await saveOvertimeDisabledIds('oliv', ['e1', 'e2']);
    // lokal gespeichert
    expect(JSON.parse(localStorageStore['overtime-disabled'] ?? '[]')).toEqual(['e1', 'e2']);
    // kein Remote-Write
    expect(state.writeCalls).toBe(0);
    // dezenter Hinweis, kein roter Fehler
    expect(toastCalls.info.length).toBe(1);
    expect(toastCalls.error.length).toBe(0);
  });
});

describe('T008/6 — Timeout wird als unavailable klassifiziert, lokaler Stand bleibt', () => {
  it('Fetch-Timeout invalidiert den Cache', async () => {
    await kvGet('warmup');
    state.writeFailure = { kind: 'throw', message: '[publish] supabaseWrite timed out after 12000ms' };
    localStorageStore['k'] = JSON.stringify({ lokal: true });
    await expect(kvSetStrict('k', { lokal: true })).rejects.toThrow();
    expect(getKVAvailabilityState()).toBe('unavailable');
    // lokaler Stand unangetastet
    expect(JSON.parse(localStorageStore['k'])).toEqual({ lokal: true });
  });
});

describe('T008/7 — Retry verwendet den AKTUELLEN lokalen Stand, nicht den alten Snapshot', () => {
  it('Overtime-Retry liest localStorage frisch', async () => {
    await kvGet('warmup');
    // Echter DB-Fehler → Fehler-Toast MIT Retry-Aktion
    state.writeFailure = { kind: 'error', message: 'duplicate key value violates unique constraint' };
    await saveOvertimeDisabledIds('oliv', ['alt-1']);
    expect(toastCalls.error.length).toBe(1);
    const action = toastCalls.error[0].opts.action as { onClick: () => void };
    expect(action).toBeDefined();

    // Zwischenzeitlich hat ein NEUERER Save den lokalen Stand geändert
    localStorageStore['overtime-disabled'] = JSON.stringify(['neu-1', 'neu-2']);

    // Verbindung ok → Retry
    state.writeFailure = null;
    action.onClick();
    await vi.waitFor(() => {
      expect(state.writtenPayloads.length).toBe(1);
    });
    expect(state.writtenPayloads[0]).toEqual({ key: 'overtime-disabled', value: ['neu-1', 'neu-2'] });
  });
});

describe('T008/8 — Tenant-Wechsel: Retry schreibt auf den URSPRÜNGLICHEN Tenant-Key', () => {
  it('Beaulieu-Retry schreibt beaulieu:-Key, auch wenn inzwischen Oliv aktiv wäre', async () => {
    await kvGet('warmup');
    state.writeFailure = { kind: 'error', message: 'violates check constraint' };
    await saveOvertimeDisabledIds('beaulieu', ['b-9']);
    const action = toastCalls.error[0].opts.action as { onClick: () => void };

    // Simulierter Tenant-Wechsel zu Oliv: beide Keys existieren lokal
    localStorageStore['overtime-disabled'] = JSON.stringify(['oliv-x']);
    localStorageStore['beaulieu:overtime-disabled'] = JSON.stringify(['b-9', 'b-10']);

    state.writeFailure = null;
    action.onClick();
    await vi.waitFor(() => {
      expect(state.writtenPayloads.length).toBe(1);
    });
    // NUR der Beaulieu-Key wird geschrieben — mit dem frischen Beaulieu-Stand
    expect(state.writtenPayloads[0]).toEqual({
      key: 'beaulieu:overtime-disabled',
      value: ['b-9', 'b-10'],
    });
    expect(state.rows['overtime-disabled']).toBeUndefined();
  });
});

describe('T008/9 — zwei schnelle Fehler: Negativ-Cache greift, keine Toast-Flut', () => {
  it('zweiter Fehlversuch löst keinen zweiten Remote-Versuch aus; Toast-ID dedupliziert', async () => {
    state.probeFailure = { kind: 'throw', message: 'Failed to fetch' };
    await saveOvertimeDisabledIds('oliv', ['a']);
    await saveOvertimeDisabledIds('oliv', ['a', 'b']);
    // Nur EIN Probe-Versuch (Negativ-Cache), keine Remote-Writes
    expect(state.probeCalls).toBe(1);
    expect(state.writeCalls).toBe(0);
    // Beide Hinweise nutzen dieselbe Toast-ID → sonner dedupliziert (keine Flut)
    expect(toastCalls.info.length).toBe(2);
    expect(toastCalls.info[0].opts.id).toBe(toastCalls.info[1].opts.id);
    expect(toastCalls.error.length).toBe(0);
  });
});

describe('T008/10 — Verbindung wiederhergestellt: nächster Versuch bestätigt das Backup', () => {
  it('nach Ablauf des Fensters schreibt kvSetStrict und benachrichtigt Abonnenten', async () => {
    state.probeFailure = { kind: 'throw', message: 'Failed to fetch' };
    await expect(kvGetStrict('k')).rejects.toBeInstanceOf(KVUnavailableError);
    expect(getKVAvailabilityState()).toBe('unavailable');

    state.probeFailure = null;
    vi.setSystemTime(BASE + 31_000);

    let notified = 0;
    const unsub = subscribeKV('k', () => { notified++; });
    await kvSetStrict('k', { neu: true });
    unsub();

    expect(getKVAvailabilityState()).toBe('available');
    expect(state.rows['k']).toEqual({ neu: true });
    expect(notified).toBe(1);
  });
});
