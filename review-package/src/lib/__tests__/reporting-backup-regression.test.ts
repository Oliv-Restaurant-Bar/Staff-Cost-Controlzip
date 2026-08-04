// @vitest-environment node
/**
 * V001 — Backup-Regressionstests am ECHTEN öffentlichen Backup-/Save-Pfad
 * ========================================================================
 * Getestet wird exakt der Einstiegspfad, den ImportHub und die
 * Nachsicherungsaktion verwenden:
 *
 *   - saveMonth(…, { skipKvBackup: true })  → Mehrmonats-Schleife (VJ-Übernahme)
 *   - retryReportingMonthsBackup(ids, key)  → sequenzielle Nachsicherung
 *   - safeUpsertReportingMonth(id, rec, key) → Einzelmonats-Backup (saveMonth-Pfad)
 *   - kvGetStrict(key) + readLocalRecord(key) + computeBackupRepairCandidates()
 *     → Backup-Prüfung («Backup prüfen» in ImportHub, read-only)
 *
 * Gemockt ist AUSSCHLIESSLICH die unterste Supabase-Schicht
 * ('@/integrations/supabase/client' — appSettingsTable baut darauf auf).
 *
 * Abgedeckte Punkte 1–18 siehe describe-/it-Namen.
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
  /** Upsert-Aufrufe (1-basiert), die mit Fehler beantwortet werden. */
  failOnUpsertCall: new Set<number>(),
  /** Protokoll ALLER Upserts (Schreib-Nachweis für «kein Write»-Tests). */
  upsertCalls: [] as { key: string; value: unknown }[],
  upsertCounter: 0,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        // isAvailable(): .select('key').limit(1)
        limit: async (_n: number) => ({ data: [], error: null }),
        // kvGet()/kvGetStrict(): .select('value').eq('key', key).maybeSingle()
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
        state.upsertCounter += 1;
        if (state.failOnUpsertCall.has(state.upsertCounter)) {
          return { error: { message: 'write fail' } };
        }
        state.rows[row.key] = row.value;
        state.upsertCalls.push({ key: row.key, value: row.value });
        return { error: null };
      },
    }),
  },
}));

import {
  saveMonth,
  retryReportingMonthsBackup,
  computeBackupRepairCandidates,
} from '../reporting-store';
import {
  safeUpsertReportingMonth,
  kvGetStrict,
  resetKVAvailabilityCache,
} from '../supabase-kv';
import { asRecordBlob, readLocalRecord } from '../kv-blob-utils';

// ─── Helfer ───────────────────────────────────────────────────────────────────

const OLIV_KEY = 'reporting_v1';
const BEAULIEU_KEY = 'beaulieu:reporting_v1';

const ids12 = Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, '0')}`);
const rec = (marker: string) => ({ marker });

/** Lokalen Blob direkt setzen (frischer Import-Stand ohne Remote-Backup). */
function seedLocal(key: string, blob: Record<string, unknown>) {
  localStorageStore[key] = JSON.stringify(blob);
}

/** 12 Monate über den ECHTEN Import-Pfad (saveMonth, skipKvBackup) anlegen. */
function importYearLocally(key: string) {
  for (let m = 1; m <= 12; m++) {
    saveMonth(
      { year: 2024, month: m, grossRevenueManual: 1000 * m, revenueActual: 900 * m },
      'vj_daily_transfer',
      'update',
      { skipKvBackup: true },
      key,
    );
  }
}

/** Simulierte Backup-Prüfung — EXAKT der handleBackupCheck-Ablauf (read-only). */
async function runBackupCheck(key: string) {
  const remote = asRecordBlob(await kvGetStrict(key));
  const local = readLocalRecord(key);
  return computeBackupRepairCandidates(local, remote);
}

beforeEach(() => {
  Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]);
  state.rows = {};
  state.failRead = false;
  state.failOnUpsertCall = new Set();
  state.upsertCalls = [];
  state.upsertCounter = 0;
  resetKVAvailabilityCache();
});

// ─── 1–4: Vollsicherung + Fehlererfassung ─────────────────────────────────────

describe('V001 Nachsicherung — Vollsicherung und Fehlererfassung', () => {
  it('1. Zwölf erfolgreich importierte Monate werden vollständig remote gesichert', async () => {
    importYearLocally(OLIV_KEY);
    const res = await retryReportingMonthsBackup(ids12, OLIV_KEY);

    expect(res.failedMonths).toEqual([]);
    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    expect(Object.keys(remote).sort()).toEqual(ids12);
    // Inhalt stammt aus dem lokalen Import-Stand
    expect((remote['2024-07'] as { grossRevenueManual?: number }).grossRevenueManual).toBe(7000);
  });

  it('2.+3. Ein fehlschlagender Remote-Monat → NICHT «vollständig erfolgreich», exakter Monat wird zurückgegeben', async () => {
    importYearLocally(OLIV_KEY);
    // 5. Upsert (= 2024-05 in sequenzieller Reihenfolge) schlägt fehl
    state.failOnUpsertCall = new Set([5]);
    const res = await retryReportingMonthsBackup(ids12, OLIV_KEY);

    expect(res.failedMonths.length).toBeGreaterThan(0); // nie still «alles ok»
    expect(res.failedMonths).toEqual(['2024-05']);      // exakter Monat
    expect(res.lastError).toBeTruthy();
    // Alle anderen Monate sind trotzdem gesichert (sequenziell, kein Abbruch)
    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    expect(remote['2024-04']).toBeDefined();
    expect(remote['2024-06']).toBeDefined();
  });

  it('4. Mehrere fehlgeschlagene Monate werden vollständig gesammelt', async () => {
    importYearLocally(OLIV_KEY);
    state.failOnUpsertCall = new Set([3, 7, 11]);
    const res = await retryReportingMonthsBackup(ids12, OLIV_KEY);

    expect(res.failedMonths).toEqual(['2024-03', '2024-07', '2024-11']);
  });
});

// ─── 5–7: Retry-Verhalten ─────────────────────────────────────────────────────

describe('V001 Nachsicherung — Retry schreibt gezielt und zerstörungsfrei', () => {
  it('5. Ein Retry schreibt nur die fehlenden/bestätigten Monate (ein Write pro Monat)', async () => {
    importYearLocally(OLIV_KEY);
    state.failOnUpsertCall = new Set([3, 7, 11]);
    const first = await retryReportingMonthsBackup(ids12, OLIV_KEY);
    expect(first.failedMonths).toHaveLength(3);

    state.failOnUpsertCall = new Set();
    state.upsertCalls = [];
    const retry = await retryReportingMonthsBackup(first.failedMonths, OLIV_KEY);

    expect(retry.failedMonths).toEqual([]);
    // GENAU 3 Writes — einer pro fehlendem Monat, keine weiteren
    expect(state.upsertCalls).toHaveLength(3);
    expect(state.upsertCalls.every(c => c.key === OLIV_KEY)).toBe(true);
  });

  it('6. Bereits remote vorhandene Monate werden beim Retry nicht gelöscht', async () => {
    state.rows[OLIV_KEY] = { '2023-06': rec('remote-2023-06'), '2023-07': rec('remote-2023-07') };
    seedLocal(OLIV_KEY, { '2024-01': rec('lokal-2024-01') });

    const res = await retryReportingMonthsBackup(['2024-01'], OLIV_KEY);

    expect(res.failedMonths).toEqual([]);
    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    expect(remote['2023-06']).toEqual(rec('remote-2023-06'));
    expect(remote['2023-07']).toEqual(rec('remote-2023-07'));
    expect(remote['2024-01']).toEqual(rec('lokal-2024-01'));
  });

  it('7. Bereits remote vorhandene Monate werden nicht unnötig überschrieben (remote gewinnt pro Monat)', async () => {
    // Remote hat für 2024-02 einen NEUEREN Stand als der stale lokale Blob
    state.rows[OLIV_KEY] = { '2024-02': rec('remote-neu') };
    seedLocal(OLIV_KEY, {
      '2024-01': rec('lokal-01'),
      '2024-02': rec('lokal-ALT'),
    });

    await retryReportingMonthsBackup(['2024-01'], OLIV_KEY);

    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    // Nicht-Ziel-Monat: Remote-Wert bleibt — der stale lokale Wert gewinnt NICHT
    expect(remote['2024-02']).toEqual(rec('remote-neu'));
    expect(remote['2024-01']).toEqual(rec('lokal-01'));
  });
});

// ─── 8–10: Prüf-Logik (Kandidaten, fehlend ≠ leer, Lesefehler) ────────────────

describe('V001 Backup-Prüfung — Kandidaten und Lesefehler', () => {
  it('8. Tombstoned Monate werden nicht als Nachsicherungskandidaten angeboten', () => {
    const local = {
      '2024-01': rec('normal'),
      '2024-02': { deleted: true, updatedAt: '2026-01-01T00:00:00Z' }, // gewollte Löschung
      '2024-03': 'korrupt',                                            // kein Record
      '2024-04': rec('auch-normal'),
    };
    const diff = computeBackupRepairCandidates(local, {});

    expect(diff.missing).toEqual(['2024-01', '2024-04']); // sortiert, ohne Tombstone/Korrupt
    expect(diff.localCount).toBe(4);
    expect(diff.remoteCount).toBe(0);
  });

  it('9. Lokal fehlende Monate werden nicht als leere Daten remote geschrieben', async () => {
    state.rows[OLIV_KEY] = { '2023-12': rec('remote-bestand') };
    seedLocal(OLIV_KEY, { '2024-01': rec('lokal-01') });

    // '2024-09' existiert lokal NICHT → wird übersprungen, nie erfunden
    const res = await retryReportingMonthsBackup(['2024-09'], OLIV_KEY);

    expect(res.failedMonths).toEqual([]);
    expect(state.upsertCalls).toHaveLength(0); // kein einziger Write
    expect(state.rows[OLIV_KEY]).toEqual({ '2023-12': rec('remote-bestand') });
  });

  it('10. Ein Remote-Lesefehler wird nicht als «Remote ist leer» behandelt (kvGetStrict wirft)', async () => {
    seedLocal(OLIV_KEY, { '2024-01': rec('lokal'), '2024-02': rec('lokal') });
    state.rows[OLIV_KEY] = { '2024-01': rec('remote') };
    state.failRead = true;

    // Der Prüf-Pfad bricht sichtbar ab — er liefert NIE «alles fehlt»
    await expect(runBackupCheck(OLIV_KEY)).rejects.toBeTruthy();
    // …und löst dabei keinerlei Write aus
    expect(state.upsertCalls).toHaveLength(0);
    expect(state.rows[OLIV_KEY]).toEqual({ '2024-01': rec('remote') });
  });
});

// ─── 11–13: Kein Monatsverlust bei Folge-/Teil-Writes ─────────────────────────

describe('V001 Monats-Writes — kein Last-Writer-Wipe', () => {
  it('11. Zwei aufeinanderfolgende Monatswrites verlieren keinen zuvor geschriebenen Monat', async () => {
    seedLocal(OLIV_KEY, {});
    await safeUpsertReportingMonth('2024-01', rec('erster'), OLIV_KEY);
    await safeUpsertReportingMonth('2024-02', rec('zweiter'), OLIV_KEY);

    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    expect(remote['2024-01']).toEqual(rec('erster'));
    expect(remote['2024-02']).toEqual(rec('zweiter'));
  });

  it('12. Veraltete/parallele Blob-Basen verursachen keinen Last-Writer-Wipe (Basis-Union, remote gewinnt)', async () => {
    // Remote-Stand einer ANDEREN Session; der lokale Blob ist stale (kennt B nicht,
    // hat für A einen alten Wert) — genau die Last-Writer-Wipe-Konstellation.
    state.rows[OLIV_KEY] = {
      '2024-01': rec('remote-A-neu'),
      '2024-02': rec('remote-B'),
    };
    seedLocal(OLIV_KEY, { '2024-01': rec('lokal-A-stale') });

    await safeUpsertReportingMonth('2024-03', rec('neu-C'), OLIV_KEY);

    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    expect(remote['2024-01']).toEqual(rec('remote-A-neu')); // stale Basis gewinnt nie
    expect(remote['2024-02']).toEqual(rec('remote-B'));     // nie gewiped
    expect(remote['2024-03']).toEqual(rec('neu-C'));
  });

  it('13. Ein Teilimport schützt alle nicht enthaltenen Monate', async () => {
    state.rows[OLIV_KEY] = {
      '2023-11': rec('remote-2023-11'),
      '2024-06': rec('remote-2024-06'),
    };
    // Teilimport: nur Jan–Mär lokal neu (VJ-Übernahme einzelner Monate)
    seedLocal(OLIV_KEY, {});
    for (let m = 1; m <= 3; m++) {
      saveMonth(
        { year: 2024, month: m, grossRevenueManual: 100 * m, revenueActual: 90 * m },
        'vj_daily_transfer',
        'update',
        { skipKvBackup: true },
        OLIV_KEY,
      );
    }
    const res = await retryReportingMonthsBackup(['2024-01', '2024-02', '2024-03'], OLIV_KEY);

    expect(res.failedMonths).toEqual([]);
    const remote = state.rows[OLIV_KEY] as Record<string, unknown>;
    // Nicht enthaltene Monate: unverändert vorhanden
    expect(remote['2023-11']).toEqual(rec('remote-2023-11'));
    expect(remote['2024-06']).toEqual(rec('remote-2024-06'));
    // Teilimport-Monate: angekommen
    expect((remote['2024-02'] as { grossRevenueManual?: number }).grossRevenueManual).toBe(200);
  });
});

// ─── 14–15: Idempotenz und reine Prüfung ──────────────────────────────────────

describe('V001 Prüfung/Idempotenz — keine unnötigen Writes', () => {
  it('14. Identisches erneutes Sichern erzeugt keinen unnötigen Write (keine Kandidaten → kein Repair-Write)', async () => {
    const blob = { '2024-01': rec('a'), '2024-02': rec('b') };
    state.rows[OLIV_KEY] = blob;
    seedLocal(OLIV_KEY, blob);

    const diff = await runBackupCheck(OLIV_KEY);
    expect(diff.missing).toEqual([]); // nichts fehlt → Repair-Button deaktiviert

    // Der Repair-Pfad mit leerer Kandidatenliste schreibt nichts
    const res = await retryReportingMonthsBackup(diff.missing, OLIV_KEY);
    expect(res.failedMonths).toEqual([]);
    expect(state.upsertCalls).toHaveLength(0);
  });

  it('15. Reines Prüfen des Backup-Status löst keinen Write aus', async () => {
    state.rows[OLIV_KEY] = { '2024-01': rec('remote') };
    seedLocal(OLIV_KEY, {
      '2024-01': rec('lokal'),
      '2024-02': rec('nur-lokal'),
    });

    const diff = await runBackupCheck(OLIV_KEY);

    expect(diff.missing).toEqual(['2024-02']);
    expect(state.upsertCalls).toHaveLength(0); // Prüfung ist strikt read-only
    expect(state.rows[OLIV_KEY]).toEqual({ '2024-01': rec('remote') });
    // Auch localStorage bleibt unangetastet (kein Sync-Nebeneffekt)
    expect(JSON.parse(localStorageStore[OLIV_KEY]!)['2024-02']).toEqual(rec('nur-lokal'));
  });
});

// ─── 16–18: Tenant-Isolation ──────────────────────────────────────────────────

describe('V001 Tenant-Isolation — Oliv/Beaulieu strikt getrennt', () => {
  const seedBothTenants = () => {
    state.rows[OLIV_KEY] = { '2024-01': rec('oliv-remote') };
    state.rows[BEAULIEU_KEY] = { '2024-01': rec('beaulieu-remote') };
    seedLocal(OLIV_KEY, { '2024-01': rec('oliv-remote'), '2024-05': rec('oliv-neu') });
    seedLocal(BEAULIEU_KEY, { '2024-01': rec('beaulieu-remote'), '2024-08': rec('beaulieu-neu') });
  };

  it('16. Oliv-Nachsicherung kann Beaulieu nicht verändern', async () => {
    seedBothTenants();
    const beaulieuRemoteBefore = JSON.stringify(state.rows[BEAULIEU_KEY]);
    const beaulieuLocalBefore = localStorageStore[BEAULIEU_KEY];

    const res = await retryReportingMonthsBackup(['2024-05'], OLIV_KEY);

    expect(res.failedMonths).toEqual([]);
    expect(state.upsertCalls.every(c => c.key === OLIV_KEY)).toBe(true);
    expect(JSON.stringify(state.rows[BEAULIEU_KEY])).toBe(beaulieuRemoteBefore);
    expect(localStorageStore[BEAULIEU_KEY]).toBe(beaulieuLocalBefore);
    expect((state.rows[OLIV_KEY] as Record<string, unknown>)['2024-05']).toEqual(rec('oliv-neu'));
  });

  it('17. Beaulieu-Nachsicherung kann Oliv nicht verändern', async () => {
    seedBothTenants();
    const olivRemoteBefore = JSON.stringify(state.rows[OLIV_KEY]);
    const olivLocalBefore = localStorageStore[OLIV_KEY];

    const res = await retryReportingMonthsBackup(['2024-08'], BEAULIEU_KEY);

    expect(res.failedMonths).toEqual([]);
    expect(state.upsertCalls.every(c => c.key === BEAULIEU_KEY)).toBe(true);
    expect(JSON.stringify(state.rows[OLIV_KEY])).toBe(olivRemoteBefore);
    expect(localStorageStore[OLIV_KEY]).toBe(olivLocalBefore);
    expect((state.rows[BEAULIEU_KEY] as Record<string, unknown>)['2024-08']).toEqual(rec('beaulieu-neu'));
  });

  it('18. Tenantwechsel während der Prüfung führt nicht zu einem Save im falschen Tenant', async () => {
    seedBothTenants();

    // Prüfung läuft für OLIV und liefert Oliv-Kandidaten…
    const olivDiff = await runBackupCheck(OLIV_KEY);
    expect(olivDiff.missing).toEqual(['2024-05']);

    // …dann wechselt der Tenant. ImportHub verwirft das Prüfergebnis beim
    // Key-Wechsel (useEffect auf reportingKey). Selbst WENN die stale
    // Kandidatenliste den Repair erreichte: die Nachsicherung liest den
    // LOKALEN Stand des AKTUELLEN Tenants frisch — Oliv-Monate existieren
    // dort nicht → kein Write, nichts wird in Beaulieu erfunden.
    const beaulieuRemoteBefore = JSON.stringify(state.rows[BEAULIEU_KEY]);
    const res = await retryReportingMonthsBackup(olivDiff.missing, BEAULIEU_KEY);

    expect(res.failedMonths).toEqual([]);
    expect(state.upsertCalls).toHaveLength(0); // kein Save im falschen Tenant
    expect(JSON.stringify(state.rows[BEAULIEU_KEY])).toBe(beaulieuRemoteBefore);
  });
});
