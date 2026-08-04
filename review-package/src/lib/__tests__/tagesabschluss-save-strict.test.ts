// @vitest-environment node
/**
 * Schutztest: saveTagesabschluss (kvGetStrict statt kvGet)
 * ========================================================
 * Alter Fehlerfall: transienter KV-Lesefehler beim Speichern sah aus wie
 * «Remote ist leer» → der rein lokale Stand ersetzte den KV-Blob KOMPLETT und
 * löschte Tagesabschlüsse/Korrekturen, die nur auf einem anderen Gerät
 * erfasst waren.
 *
 * Szenarien:
 *   1. KRITISCH: Read-Fehler ⇒ KEIN KV-Write, sichtbare Meldung (retry), lokal gespeichert
 *   2. Bestätigt leer (strict liefert null) ⇒ normaler Write
 *   3. Merge: Daten eines zweiten Geräts bleiben erhalten (read→merge→write)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

let kvStore: Record<string, unknown> = {};
let strictReadFails = false;
const kvGetStrictMock = vi.fn(async (key: string) => {
  if (strictReadFails) throw new Error('KV-Read fehlgeschlagen (Netz-Blip)');
  return kvStore[key] ?? null;
});
const kvSetStrictMock = vi.fn(async (key: string, value: unknown) => { kvStore[key] = value; });
const notifyMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async (key: string) => kvStore[key] ?? null),
  kvSet: vi.fn(async (key: string, value: unknown) => { kvStore[key] = value; }),
  kvGetStrict: (key: string) => kvGetStrictMock(key),
  kvSetStrict: (key: string, value: unknown) => kvSetStrictMock(key, value),
  notifyKVBackupProblem: (...args: unknown[]) => notifyMock(...args),
}));

import { saveTagesabschluss } from '@/lib/tagesabschluss-db';
import { emptyTagesabschlussBlob, normalizeTagesabschlussBlob, setUmsatzDiffSchwelle } from '@/lib/tagesabschluss';

const KEY = 'tagesabschluss_v1'; // tenantKey('oliv', …) = unpräfixiert (Oliv-Legacy)

beforeEach(() => {
  kvStore = {};
  strictReadFails = false;
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  kvGetStrictMock.mockClear();
  kvSetStrictMock.mockClear();
  notifyMock.mockClear();
});

describe('saveTagesabschluss — strict read vor dem Write', () => {
  it('KRITISCH: Read-Fehler ⇒ KEIN KV-Write, notify mit retry, lokal trotzdem gespeichert', async () => {
    kvStore[KEY] = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 30, '2026-08-04T12:00:00Z');
    strictReadFails = true;

    const local = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 20, '2026-08-01T10:00:00Z');
    await saveTagesabschluss('oliv', local);

    expect(kvSetStrictMock).not.toHaveBeenCalled();
    // Remote-Stand unangetastet:
    expect((kvStore[KEY] as { umsatzDiffSchwelle?: { value: number } }).umsatzDiffSchwelle?.value).toBe(30);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const opts = notifyMock.mock.calls[0][2] as { retry?: () => Promise<void> };
    expect(typeof opts?.retry).toBe('function');
    // localStorage wurde trotzdem geschrieben (Primärspeicher):
    expect(localStorageStore[KEY]).toContain('"value":20');

    // Retry hält den Save-SNAPSHOT (nicht nur localStorage): auch wenn der
    // lokale Speicher inzwischen geleert wurde, überträgt der Retry die
    // ursprüngliche Mutation — und merged sie mit dem Remote-Stand.
    Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
    strictReadFails = false;
    await opts.retry!();
    expect(kvSetStrictMock).toHaveBeenCalledTimes(1);
    const persisted = kvStore[KEY] as { umsatzDiffSchwelle?: { value: number } };
    expect(persisted.umsatzDiffSchwelle?.value).toBe(30); // Remote jünger ⇒ gewinnt im Merge
  });

  it('bestätigt leer ⇒ normaler Write', async () => {
    const local = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 20, '2026-08-01T10:00:00Z');
    const written = await saveTagesabschluss('oliv', local);
    expect(kvSetStrictMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(written.umsatzDiffSchwelle?.value).toBe(20);
    expect((kvStore[KEY] as { umsatzDiffSchwelle?: { value: number } }).umsatzDiffSchwelle?.value).toBe(20);
  });

  it('Merge: jüngerer Stand des zweiten Geräts bleibt erhalten', async () => {
    kvStore[KEY] = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 30, '2026-08-04T12:00:00Z');
    const local = setUmsatzDiffSchwelle(emptyTagesabschlussBlob(), 20, '2026-08-01T10:00:00Z');

    const written = await saveTagesabschluss('oliv', local);

    expect(written.umsatzDiffSchwelle?.value).toBe(30); // Remote jünger ⇒ gewinnt
    const persisted = normalizeTagesabschlussBlob(kvStore[KEY]);
    expect(persisted.umsatzDiffSchwelle?.value).toBe(30);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
