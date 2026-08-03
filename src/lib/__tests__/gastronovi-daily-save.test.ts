// @vitest-environment node
/**
 * Tests für commitGastronoviDays (src/lib/gastronovi-daily-save.ts)
 * ================================================================
 * Fokus: der previous_year-Modus muss BEIDE Ziele befüllen —
 *   1) dailyBudgets (previousYearRevenue-Feld) via safeUpsertDailyBudgets
 *   2) vj_daily (Quelle der Report-Vorjahres-Spalte) via upsertVjDailyBatch
 * und ein bestehender vj_daily-Tag ausserhalb des Import-Zeitraums bleibt
 * erhalten (per-Tag-Upsert, kein Blob-Überschreiben).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GastronoviDayResult } from '../revenue-parser';
import type { VjDayRecord } from '../vj-daily-supabase';

// ── Mock: vj_daily-Store als In-Memory-Tabelle (per-Tag-Upsert) ──────────────
const vjStore: Record<string, VjDayRecord> = {};

let vjReadFails = false;

vi.mock('../vj-daily-supabase', () => ({
  upsertVjDailyBatch: vi.fn(async (records: VjDayRecord[], tenantId?: string) => {
    const prefix = !tenantId || tenantId === 'oliv' ? 'vj_daily:' : `vj_daily:${tenantId}:`;
    for (const r of records) vjStore[`${prefix}${r.date}`] = r;
    return { upserted: records.length, error: null };
  }),
  loadVjDailyYearStrict: vi.fn(async (year: number, tenantId?: string) => {
    if (vjReadFails) throw new Error(`vj_daily-Bestand ${year} nicht lesbar: mock`);
    const prefix = !tenantId || tenantId === 'oliv' ? 'vj_daily:' : `vj_daily:${tenantId}:`;
    const out: Record<string, VjDayRecord> = {};
    for (const [k, v] of Object.entries(vjStore)) {
      if (k.startsWith(prefix) && k.slice(prefix.length).startsWith(`${year}-`)) {
        out[k.slice(prefix.length)] = v;
      }
    }
    return out;
  }),
}));

// ── Mock: Jahres-Sperre (prior-year-lock) — standardmässig entsperrt ─────────
const lockedYears = new Set<string>(); // `${tenantId}:${year}`

vi.mock('../prior-year-lock', () => ({
  getLockState: vi.fn(async (tenantId: string, year: number) => ({
    locked: lockedYears.has(`${tenantId}:${year}`),
  })),
}));

// ── Mock: dailyBudgets-Speicherung (dynamischer Import in der Funktion) ───────
const dailyBudgetsStore: Record<string, Record<string, unknown>> = {};

vi.mock('../supabase-kv', () => ({
  safeUpsertDailyBudgets: vi.fn(async (
    _key: string,
    updates: Record<string, Record<string, unknown>>,
  ) => {
    for (const [date, fields] of Object.entries(updates)) {
      dailyBudgetsStore[date] = { ...(dailyBudgetsStore[date] ?? {}), ...fields };
    }
    return { ...dailyBudgetsStore };
  }),
}));

import { commitGastronoviDays, targetForYear } from '../gastronovi-daily-save';

function day(date: string, total: number, food = 0, beverage = 0, takeAway?: number): GastronoviDayResult {
  // takeAway 0 = Take-Away-Zeile vorhanden, Tageswert explizit null.
  // undefined/weggelassen = Datei OHNE Take-Away-Zeile (Feld weggelassen).
  return { date, total, food, beverage, ...(takeAway !== undefined ? { takeAway } : {}), currency: 'CHF' };
}

beforeEach(() => {
  for (const k of Object.keys(vjStore)) delete vjStore[k];
  for (const k of Object.keys(dailyBudgetsStore)) delete dailyBudgetsStore[k];
  lockedYears.clear();
  vjReadFails = false;
});

describe('targetForYear', () => {
  it('laufendes/zukünftiges Jahr → actual, früheres Jahr → previous_year', () => {
    expect(targetForYear(2026, 2026)).toBe('actual');
    expect(targetForYear(2027, 2026)).toBe('actual');
    expect(targetForYear(2025, 2026)).toBe('previous_year');
    expect(targetForYear(2023, 2026)).toBe('previous_year');
  });
});

describe('commitGastronoviDays — previous_year befüllt beide Ziele', () => {
  it('schreibt nach dailyBudgets (previousYearRevenue) UND vj_daily', async () => {
    const rows = [
      day('2025-07-01', 1000, 700, 300, 100),
      day('2025-07-02', 1200, 800, 400, 0),
    ];
    const res = await commitGastronoviDays('oliv:dailyBudgets', rows, 'previous_year', { tenantId: 'oliv' });

    // dailyBudgets: previousYear-Felder + Kategorien zusätzlich als actual*
    // (Ist-Ansichten des vergangenen Jahres + dynamisches Vorjahr in Jahr+1)
    // + takeawayRevenue für den präzisen Netto-MwSt-Split. actualRevenue
    // bleibt unangetastet (Sache der Ist-Importe).
    expect(dailyBudgetsStore['2025-07-01']).toMatchObject({
      previousYearRevenue: 1000, previousYearFood: 700, previousYearBeverage: 300,
      actualFood: 700, actualBeverage: 300, takeawayRevenue: 100,
    });
    expect(dailyBudgetsStore['2025-07-01'].actualRevenue).toBeUndefined();
    // Tag ohne Take Away: explizite 0 (Beaulieu-Fall → Netto rein 8.1 %)
    expect(dailyBudgetsStore['2025-07-02'].takeawayRevenue).toBe(0);

    // vj_daily: pro Tag ein Record im richtigen Format/Key-Schema
    expect(res.vjUpserted).toBe(2);
    expect(vjStore['vj_daily:2025-07-01']).toMatchObject({
      date: '2025-07-01', year: 2025, actualRevenue: 1000,
      foodRevenue: 700, beverageRevenue: 300, source: 'vorjahr_import',
    });
    // Tag ohne Beverage/Food-Werte: optionale Felder weggelassen
    expect(vjStore['vj_daily:2025-07-02'].beverageRevenue).toBe(400);
    expect(res.count).toBe(2);
    expect(res.from).toBe('2025-07-01');
    expect(res.to).toBe('2025-07-02');
  });

  it('erhält bestehende vj_daily-Tage ausserhalb des Import-Zeitraums', async () => {
    // Vorbestehender Tag im März 2025
    vjStore['vj_daily:2025-03-15'] = {
      date: '2025-03-15', year: 2025, actualRevenue: 555, source: 'vorjahr_import',
    };

    await commitGastronoviDays('oliv:dailyBudgets', [day('2025-07-01', 1000)], 'previous_year', { tenantId: 'oliv' });

    // Import-Tag da …
    expect(vjStore['vj_daily:2025-07-01']).toBeDefined();
    // … und der März-Tag unverändert erhalten (kein Blob-Überschreiben)
    expect(vjStore['vj_daily:2025-03-15']).toMatchObject({ actualRevenue: 555 });
    expect(Object.keys(vjStore)).toContain('vj_daily:2025-03-15');
  });

  it('gesperrtes Jahr → blockiert, KEINE Writes (dailyBudgets & vj_daily)', async () => {
    lockedYears.add('oliv:2025');
    // Vorbestehender vj_daily-Tag darf ebenfalls nicht verändert werden
    vjStore['vj_daily:2025-03-15'] = {
      date: '2025-03-15', year: 2025, actualRevenue: 555, source: 'vorjahr_import',
    };

    const res = await commitGastronoviDays(
      'oliv:dailyBudgets',
      [day('2025-07-01', 1000, 700, 300)],
      'previous_year',
      { tenantId: 'oliv', year: 2025 },
    );

    expect(res.blocked).toBe(true);
    expect(res.lockedYear).toBe(2025);
    expect(res.count).toBe(0);
    expect(res.vjUpserted).toBe(0);
    // Keinerlei Writes
    expect(dailyBudgetsStore['2025-07-01']).toBeUndefined();
    expect(vjStore['vj_daily:2025-07-01']).toBeUndefined();
    // Bestehender Tag unverändert
    expect(vjStore['vj_daily:2025-03-15']).toMatchObject({ actualRevenue: 555 });
  });

  it('merged bestehende vj_daily-Kategorien am SELBEN Tag (kein Record-Clobber)', async () => {
    vjStore['vj_daily:2025-07-01'] = {
      date: '2025-07-01', year: 2025, actualRevenue: 900,
      foodRevenue: 600, beverageRevenue: 280, takeawayRevenue: 40,
      source: 'verkaufsdaten_import',
    };
    // Datei ohne Food/Beverage-Werte und OHNE Take-Away-Zeile (undefined)
    await commitGastronoviDays(
      'oliv:dailyBudgets', [day('2025-07-01', 1000, 0, 0, undefined)], 'previous_year', { tenantId: 'oliv' },
    );
    expect(vjStore['vj_daily:2025-07-01']).toMatchObject({
      actualRevenue: 1000,           // Gesamt aus der Datei ist massgeblich
      foodRevenue: 600,              // Bestand erhalten
      beverageRevenue: 280,
      takeawayRevenue: 40,           // TA-Zeile fehlt → Bestand erhalten
      source: 'vorjahr_import',
    });
    // dailyBudgets: takeawayRevenue NICHT geschrieben (Zeile fehlt)
    expect(dailyBudgetsStore['2025-07-01'].takeawayRevenue).toBeUndefined();
  });

  it('explizite Take-Away-0 ersetzt einen alten vj_daily-Wert', async () => {
    vjStore['vj_daily:2025-07-01'] = {
      date: '2025-07-01', year: 2025, actualRevenue: 900, takeawayRevenue: 40,
      source: 'vorjahr_import',
    };
    await commitGastronoviDays(
      'oliv:dailyBudgets', [day('2025-07-01', 1000, 0, 0, 0)], 'previous_year', { tenantId: 'oliv' },
    );
    expect(vjStore['vj_daily:2025-07-01'].takeawayRevenue).toBe(0);
    expect(dailyBudgetsStore['2025-07-01'].takeawayRevenue).toBe(0);
  });

  it('vj_daily-Lesefehler bricht VOR jeglichen Writes ab (auch dailyBudgets)', async () => {
    vjReadFails = true;
    await expect(commitGastronoviDays(
      'oliv:dailyBudgets', [day('2025-07-01', 1000, 700, 300)], 'previous_year', { tenantId: 'oliv' },
    )).rejects.toThrow('nicht lesbar');
    expect(dailyBudgetsStore['2025-07-01']).toBeUndefined();
    expect(vjStore['vj_daily:2025-07-01']).toBeUndefined();
  });

  it('Jahres-Sperre blockiert AUCH den actual-Modus (Lock gilt für alle Importe)', async () => {
    lockedYears.add('oliv:2026');
    const res = await commitGastronoviDays(
      'oliv:dailyBudgets', [day('2026-07-01', 1000)], 'actual', { tenantId: 'oliv', year: 2026 },
    );
    expect(res.blocked).toBe(true);
    expect(dailyBudgetsStore['2026-07-01']).toBeUndefined();
  });

  it('actual-Modus schreibt takeawayRevenue + Kategorien (nur actual*-Felder)', async () => {
    const res = await commitGastronoviDays(
      'oliv:dailyBudgets', [day('2026-07-01', 1000, 700, 250, 50)], 'actual', { tenantId: 'oliv', year: 2026 },
    );
    expect(res.blocked).toBe(false);
    expect(dailyBudgetsStore['2026-07-01']).toMatchObject({
      actualRevenue: 1000, actualFood: 700, actualBeverage: 250, takeawayRevenue: 50,
    });
    expect(dailyBudgetsStore['2026-07-01'].previousYearFood).toBeUndefined();
  });

  it('verwendet den Tenant-Prefix für Beaulieu', async () => {
    await commitGastronoviDays('beaulieu:dailyBudgets', [day('2025-07-01', 900)], 'previous_year', { tenantId: 'beaulieu' });
    expect(vjStore['vj_daily:beaulieu:2025-07-01']).toBeDefined();
    expect(vjStore['vj_daily:2025-07-01']).toBeUndefined();
  });
});

describe('commitGastronoviDays — actual befüllt NUR dailyBudgets', () => {
  it('schreibt takeawayRevenue und NICHT nach vj_daily', async () => {
    const res = await commitGastronoviDays('oliv:dailyBudgets', [day('2026-07-01', 1000, 700, 300, 150)], 'actual', { tenantId: 'oliv' });

    expect(dailyBudgetsStore['2026-07-01']).toMatchObject({
      actualRevenue: 1000, actualFood: 700, actualBeverage: 300, takeawayRevenue: 150,
    });
    expect(res.vjUpserted).toBe(0);
    expect(Object.keys(vjStore)).toHaveLength(0);
  });
});
