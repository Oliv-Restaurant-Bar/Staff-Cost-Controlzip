// @vitest-environment node
/**
 * Tests für den «Offene Stunden»-Store: Namens-Key, Park-Dedupe,
 * Auto-Auflösung nach Re-Import. Supabase (app_settings) wird gemockt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-Memory-app_settings-Mock (Key → value)
const kv = new Map<string, unknown>();

vi.mock('@/lib/app-settings-table', () => ({
  appSettingsTable: () => ({
    select: () => ({
      eq: (_col: string, key: string) => ({
        maybeSingle: async () => ({
          data: kv.has(key) ? { value: kv.get(key) } : null,
          error: null,
        }),
      }),
    }),
    upsert: async (row: { key: string; value: unknown }) => {
      kv.set(row.key, row.value);
      return { error: null };
    },
  }),
}));

import {
  parkedNameKey, parkEntries, fetchOpenParkedEntries,
  markParkedResolved, discardParkedEntry, resolveParkedByImport,
} from '@/lib/mirus-open-hours-store';

const T = 'oliv';

beforeEach(() => kv.clear());

describe('parkedNameKey', () => {
  it('ist reihenfolge-tolerant und faltet Umlaute', () => {
    expect(parkedNameKey('Ukaj Ilir')).toBe(parkedNameKey('Ilir Ukaj'));
    expect(parkedNameKey('Müller Jörg')).toBe(parkedNameKey('Joerg Mueller'));
  });
  it('unterscheidet verschiedene Personen', () => {
    expect(parkedNameKey('Ilir Ukaj')).not.toBe(parkedNameKey('Ilir Ramadani'));
  });
});

describe('parkEntries', () => {
  const input = {
    name: 'Krishnathas Krishnavarthani',
    department: 'kueche' as never,
    month: '2026-07',
    days: { '2026-07-01': 8.2, '2026-07-02': 7.5 },
    sourceFile: 'mirus-juli.xls',
  };

  it('parkt einen Eintrag mit korrektem Total und Status open', async () => {
    expect(await parkEntries(T, [input])).toBe(1);
    const open = await fetchOpenParkedEntries(T);
    expect(open).toHaveLength(1);
    expect(open[0].totalHours).toBe(15.7);
    expect(open[0].status).toBe('open');
  });

  it('dedupliziert gleiche Quelle+Monat+Name (auch Namens-Reihenfolge)', async () => {
    await parkEntries(T, [input]);
    expect(await parkEntries(T, [input])).toBe(0);
    expect(await parkEntries(T, [{ ...input, name: 'Krishnavarthani Krishnathas' }])).toBe(0);
    expect(await fetchOpenParkedEntries(T)).toHaveLength(1);
  });

  it('erlaubt gleichen Namen in anderem Monat oder anderer Quelle', async () => {
    await parkEntries(T, [input]);
    expect(await parkEntries(T, [{ ...input, month: '2026-08', days: { '2026-08-01': 4 } }])).toBe(1);
    expect(await parkEntries(T, [{ ...input, sourceFile: 'korrektur.xls' }])).toBe(1);
  });
});

describe('Auflösen / Verwerfen', () => {
  const input = {
    name: 'Ilir Ukaj', department: 'service' as never, month: '2026-07',
    days: { '2026-07-03': 6 }, sourceFile: 'a.xls',
  };

  it('markParkedResolved entfernt aus offen, behält Eintrag mit Status', async () => {
    await parkEntries(T, [input]);
    const [e] = await fetchOpenParkedEntries(T);
    await markParkedResolved(T, e.id, 'emp-1');
    expect(await fetchOpenParkedEntries(T)).toHaveLength(0);
  });

  it('discardParkedEntry entfernt aus offen', async () => {
    await parkEntries(T, [input]);
    const [e] = await fetchOpenParkedEntries(T);
    await discardParkedEntry(T, e.id);
    expect(await fetchOpenParkedEntries(T)).toHaveLength(0);
  });

  it('resolveParkedByImport löst nur gleichen Monat + Namen MIT Tagesabdeckung auf', async () => {
    await parkEntries(T, [input, { ...input, month: '2026-08' }]);
    const n = await resolveParkedByImport(T, '2026-07', [
      { importedName: 'Ukaj Ilir', employeeId: 'emp-9', days: { '2026-07-03': 6 } },
    ]);
    expect(n).toBe(1);
    const open = await fetchOpenParkedEntries(T);
    expect(open).toHaveLength(1);
    expect(open[0].month).toBe('2026-08');
  });

  it('resolveParkedByImport ohne Treffer ändert nichts', async () => {
    await parkEntries(T, [input]);
    expect(await resolveParkedByImport(T, '2026-07', [
      { importedName: 'Andere Person', employeeId: 'x', days: { '2026-07-03': 6 } },
    ])).toBe(0);
    expect(await fetchOpenParkedEntries(T)).toHaveLength(1);
  });

  it('resolveParkedByImport löst NICHT auf, wenn Tage/Stunden nicht abgedeckt sind', async () => {
    await parkEntries(T, [{ ...input, days: { '2026-07-03': 6, '2026-07-04': 5 } }]);
    // Teil-Import: nur ein Tag, zweiter fehlt → offen lassen
    expect(await resolveParkedByImport(T, '2026-07', [
      { importedName: 'Ilir Ukaj', employeeId: 'emp-9', days: { '2026-07-03': 6 } },
    ])).toBe(0);
    // Abweichender Stundenwert → offen lassen
    expect(await resolveParkedByImport(T, '2026-07', [
      { importedName: 'Ilir Ukaj', employeeId: 'emp-9', days: { '2026-07-03': 6, '2026-07-04': 3 } },
    ])).toBe(0);
    expect(await fetchOpenParkedEntries(T)).toHaveLength(1);
    // Volle Abdeckung (innerhalb Toleranz) → aufgelöst
    expect(await resolveParkedByImport(T, '2026-07', [
      { importedName: 'Ilir Ukaj', employeeId: 'emp-9', days: { '2026-07-03': 6.02, '2026-07-04': 5 } },
    ])).toBe(1);
    expect(await fetchOpenParkedEntries(T)).toHaveLength(0);
  });
});
