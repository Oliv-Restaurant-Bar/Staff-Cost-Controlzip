// @vitest-environment node
/**
 * MIRUS ↔ App Ist-Abgleich: Rohwerte-Store (ersetzen statt addieren,
 * Mandantentrennung) + pure Vergleichslogik (Schwelle, Ausnahmen, leer statt 0).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('../app-settings-table', () => ({
  appSettingsTable: () => ({
    select: () => ({
      eq: (_c: string, key: string) => ({
        maybeSingle: async () => ({ data: kv.has(key) ? { value: kv.get(key) } : null, error: null }),
      }),
    }),
    upsert: async (row: { key: string; value: unknown }) => { kv.set(row.key, row.value); return { error: null }; },
  }),
}));

import {
  mergeMirusIstWerte, loadMirusIstWerteStrict, loadMirusIstWerteForMonths, mirusWertKey,
} from '../mirus-ist-werte';
import { buildMirusAbgleich } from '../mirus-abgleich';

beforeEach(() => { kv.clear(); });

describe('mirus-ist-werte Store', () => {
  it('ersetzt pro Schlüssel statt zu addieren (Mehrfach-Import dublettensicher)', async () => {
    await mergeMirusIstWerte('oliv', '2026-08', { [mirusWertKey('21', '2026-08-12')]: 3.55 });
    await mergeMirusIstWerte('oliv', '2026-08', { [mirusWertKey('21', '2026-08-12')]: 3.55 });
    const werte = await loadMirusIstWerteStrict('oliv', '2026-08');
    expect(werte['21|2026-08-12']).toBe(3.55); // nicht 7.10
  });

  it('MIRUS 0 löscht den Key (leer statt 0); andere Keys bleiben', async () => {
    await mergeMirusIstWerte('oliv', '2026-08', { '21|2026-08-12': 3.55, '15|2026-08-12': 8.5 });
    await mergeMirusIstWerte('oliv', '2026-08', { '21|2026-08-12': 0 });
    const werte = await loadMirusIstWerteStrict('oliv', '2026-08');
    expect(werte['21|2026-08-12']).toBeUndefined();
    expect(werte['15|2026-08-12']).toBe(8.5);
  });

  it('mandantengetrennt: oliv- und beaulieu-Blobs sind separate Keys', async () => {
    await mergeMirusIstWerte('oliv', '2026-08', { '21|2026-08-12': 3.55 });
    await mergeMirusIstWerte('beaulieu', '2026-08', { 'b-62|2026-08-12': 9 });
    expect(await loadMirusIstWerteStrict('oliv', '2026-08')).toEqual({ '21|2026-08-12': 3.55 });
    expect(await loadMirusIstWerteStrict('beaulieu', '2026-08')).toEqual({ 'b-62|2026-08-12': 9 });
  });

  it('Mehrmonats-Laden vereinigt die Blobs', async () => {
    await mergeMirusIstWerte('oliv', '2026-07', { '21|2026-07-30': 4 });
    await mergeMirusIstWerte('oliv', '2026-08', { '21|2026-08-12': 3.55 });
    const werte = await loadMirusIstWerteForMonths('oliv', ['2026-07', '2026-08']);
    expect(Object.keys(werte).sort()).toEqual(['21|2026-07-30', '21|2026-08-12']);
  });
});

describe('buildMirusAbgleich', () => {
  const namen = { '21': 'Domi Sadete', '15': 'Kolev Miroslav', '103': 'Lokaj Mendim' };

  it('gearbeitet ohne geplante Schicht: fehlende App-Zelle = volle Differenz', () => {
    const r = buildMirusAbgleich({
      mirusWerte: { '21|2026-08-12': 3.55, '21|2026-08-13': 3.55 },
      appIst: {}, namen, ausnahmen: new Set(),
      von: '2026-08-10', bis: '2026-08-16',
    });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].appStd).toBeNull(); // leer, nicht 0
    expect(r.fehlendeStunden).toBeCloseTo(7.1, 2);
  });

  it('|Δ| ≤ 0.05 h wird unterdrückt', () => {
    const r = buildMirusAbgleich({
      mirusWerte: { '15|2026-08-14': 8.78 },
      appIst: { '15-2026-08-14': { hours: 8.75 } }, namen, ausnahmen: new Set(),
      von: '2026-08-10', bis: '2026-08-16',
    });
    expect(r.rows).toHaveLength(0);
    expect(r.fehlendeStunden).toBe(0);
  });

  it('Ausnahme-MA werden markiert und zählen nicht zu den fehlenden Stunden', () => {
    const r = buildMirusAbgleich({
      mirusWerte: { '103|2026-08-12': 8.42, '21|2026-08-12': 3.55 },
      appIst: { '103-2026-08-12': { hours: 0 } }, namen, ausnahmen: new Set(['103']),
      von: '2026-08-10', bis: '2026-08-16',
    });
    const lokaj = r.rows.find(x => x.employeeId === '103')!;
    expect(lokaj.ausnahme).toBe(true);
    expect(r.fehlendeStunden).toBeCloseTo(3.55, 2); // nur Domi
    expect(r.rows[r.rows.length - 1].employeeId).toBe('103'); // Ausnahmen zuletzt
  });

  it('Zeitraum-Filter: Werte ausserhalb von/bis erscheinen nicht', () => {
    const r = buildMirusAbgleich({
      mirusWerte: { '21|2026-08-09': 5, '21|2026-08-12': 3.55 },
      appIst: {}, namen, ausnahmen: new Set(),
      von: '2026-08-10', bis: '2026-08-16',
    });
    expect(r.rows.map(x => x.date)).toEqual(['2026-08-12']);
  });

  it('Sortierung: grösste positive Δ zuerst', () => {
    const r = buildMirusAbgleich({
      mirusWerte: { '21|2026-08-12': 3.55, '15|2026-08-12': 8.5 },
      appIst: {}, namen, ausnahmen: new Set(),
      von: '2026-08-10', bis: '2026-08-16',
    });
    expect(r.rows.map(x => x.employeeId)).toEqual(['15', '21']);
  });
});
