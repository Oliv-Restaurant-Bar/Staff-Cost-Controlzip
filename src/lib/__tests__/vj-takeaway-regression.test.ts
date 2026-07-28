// @vitest-environment node
/**
 * Regressionstest: «Take Away Anteil» Vorjahr-Spalte bleibt leer.
 *
 *  V1  Schreibpfad: commitGastronoviDays(previous_year) MUSS takeawayRevenue in
 *      das vj_daily-Record übernehmen (nur wenn >0; rückwärtskompatibel).
 *  V2  Berechnung/Anzeige: VJ-TA-Anteil = Σ(takeawayRevenue VJ) ÷ Σ(Gesamt VJ)
 *      über denselben Zeitraum; leer («null») wenn keine VJ-TA-Daten (alte
 *      Records ohne Feld) — Regel «leer statt 0».
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GastronoviDayResult } from '../revenue-parser';
import type { VjDayRecord } from '../vj-daily-supabase';

// ── app-settings-table mocken: fängt die vj_daily-Upserts als echte Records ──
const upserted: Array<{ key: string; value: Record<string, unknown> }> = [];
vi.mock('../app-settings-table', () => ({
  appSettingsTable: () => ({
    upsert: vi.fn(async (rows: Array<{ key: string; value: Record<string, unknown> }>) => {
      upserted.push(...rows);
      return { error: null };
    }),
  }),
}));

// dailyBudgets-Schreiben (supabase-kv) neutralisieren — hier irrelevant.
vi.mock('../supabase-kv', () => ({
  safeUpsertDailyBudgets: vi.fn(async () => ({})),
}));

// Vorjahr entsperrt.
vi.mock('../prior-year-lock', () => ({
  getLockState: vi.fn(async () => ({ locked: false })),
}));

import { commitGastronoviDays } from '../gastronovi-daily-save';

function day(date: string, total: number, food: number, beverage: number, takeAway: number): GastronoviDayResult {
  return { date, total, food, beverage, takeAway, currency: 'CHF' };
}

beforeEach(() => { upserted.length = 0; });

describe('V1 — commitGastronoviDays(previous_year) schreibt takeawayRevenue ins vj_daily-Record', () => {
  it('takeawayRevenue landet je Tag im vj_daily-Record (>0)', async () => {
    const rows = [
      day('2025-07-01', 11000, 7000, 3000, 900),
      day('2025-07-02', 12000, 8000, 3500, 1100),
    ];
    const res = await commitGastronoviDays('dailyBudgets', rows, 'previous_year', { tenantId: 'oliv', year: 2025 });
    expect(res.blocked).toBe(false);
    expect(res.vjUpserted).toBe(2);

    const byDate = Object.fromEntries(upserted.map(r => [r.key, r.value as unknown as VjDayRecord]));
    expect(byDate['vj_daily:2025-07-01']).toMatchObject({
      date: '2025-07-01', year: 2025, actualRevenue: 11000, takeawayRevenue: 900, source: 'vorjahr_import',
    });
    expect(byDate['vj_daily:2025-07-02'].takeawayRevenue).toBe(1100);
  });

  it('takeAway === 0 → Feld wird NICHT gesetzt (rückwärtskompatibel)', async () => {
    await commitGastronoviDays('dailyBudgets', [day('2025-07-03', 9000, 6000, 3000, 0)], 'previous_year', { tenantId: 'oliv', year: 2025 });
    const rec = upserted[0].value as unknown as VjDayRecord;
    expect('takeawayRevenue' in rec).toBe(false);
  });
});

// Exakte Formel/Guard aus monatsreport.ts (Vorjahr-Zelle «Take Away Anteil»):
//   vj = hatVjTa && vjGross > 0 ? r2((vjTa / vjGross) * 100) : null
function vjTaShare(records: Partial<VjDayRecord>[]): number | null {
  let vjGross = 0, vjTa = 0, hatVjTa = false;
  for (const rec of records) {
    if ((rec.actualRevenue ?? 0) > 0) vjGross += rec.actualRevenue!;
    if ((rec.takeawayRevenue ?? 0) > 0) { vjTa += rec.takeawayRevenue!; hatVjTa = true; }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return hatVjTa && vjGross > 0 ? r2((vjTa / vjGross) * 100) : null;
}

describe('V2 — VJ-TA-Anteil-Berechnung (Guard/Formel wie im Report)', () => {
  it('berechnet Σ TA ÷ Σ Gesamt in Prozent', () => {
    const share = vjTaShare([
      { actualRevenue: 3268166, takeawayRevenue: 195000 },
      { actualRevenue: 207166, takeawayRevenue: 11165 },
    ]);
    // (206165 / 3475332) * 100 ≈ 5.93
    expect(share).toBeCloseTo(5.93, 2);
  });

  it('leer (null) wenn KEINE VJ-TA-Daten vorhanden (alte Records ohne Feld)', () => {
    const share = vjTaShare([
      { actualRevenue: 100000 },
      { actualRevenue: 120000 },
    ]);
    expect(share).toBeNull(); // «leer statt 0»
  });
});
