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

vi.mock('../vj-daily-supabase', () => ({
  upsertVjDailyBatch: vi.fn(async (records: VjDayRecord[], tenantId?: string) => {
    const prefix = !tenantId || tenantId === 'oliv' ? 'vj_daily:' : `vj_daily:${tenantId}:`;
    for (const r of records) vjStore[`${prefix}${r.date}`] = r;
    return { upserted: records.length, error: null };
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

function day(date: string, total: number, food = 0, beverage = 0, takeAway = 0): GastronoviDayResult {
  return { date, total, food, beverage, takeAway, currency: 'CHF' };
}

beforeEach(() => {
  for (const k of Object.keys(vjStore)) delete vjStore[k];
  for (const k of Object.keys(dailyBudgetsStore)) delete dailyBudgetsStore[k];
  lockedYears.clear();
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

    // dailyBudgets: previousYear-Felder gesetzt, KEIN takeaway (nur bei actual)
    expect(dailyBudgetsStore['2025-07-01']).toMatchObject({
      previousYearRevenue: 1000, previousYearFood: 700, previousYearBeverage: 300,
    });
    expect(dailyBudgetsStore['2025-07-01'].takeawayRevenue).toBeUndefined();

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

  it('actual-Modus ignoriert die Jahres-Sperre (nur Vorjahr betroffen)', async () => {
    lockedYears.add('oliv:2026');
    const res = await commitGastronoviDays(
      'oliv:dailyBudgets', [day('2026-07-01', 1000)], 'actual', { tenantId: 'oliv', year: 2026 },
    );
    expect(res.blocked).toBe(false);
    expect(dailyBudgetsStore['2026-07-01']).toBeDefined();
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
