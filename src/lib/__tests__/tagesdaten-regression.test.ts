// @vitest-environment node
/**
 * Regressionstests für zwei im Einheits-Import gemeldete leere Report-Zeilen
 * (Juli 2026): «Durchschnittsverkauf» und «Take Away Anteil».
 *
 *  R1  Durchschnittsverkauf: saveAvgCheck (neuer Import-Pfad) MUSS in exakt den
 *      Key/das Format schreiben, das der Report-Reader (loadAvgCheckDaily/
 *      loadAvgCheckMonthly) liest — inkl. Monats-Key «YYYY-MM».
 *  R2  Take Away Anteil: commitGastronoviDays (actual) MUSS takeawayRevenue aus
 *      den geparsten Zeilen übernehmen; die Kalender-ISO-Filterung darf das Feld
 *      NICHT verlieren.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GastronoviDayResult } from '../revenue-parser';

// Minimaler localStorage-Shim (gaeste-store nutzt localStorage; node-Env hat keinen).
const _ls: Record<string, string> = {};
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (k in _ls ? _ls[k] : null),
  setItem: (k: string, v: string) => { _ls[k] = String(v); },
  removeItem: (k: string) => { delete _ls[k]; },
  clear: () => { for (const k of Object.keys(_ls)) delete _ls[k]; },
  key: (i: number) => Object.keys(_ls)[i] ?? null,
  get length() { return Object.keys(_ls).length; },
} as Storage;

// ── In-Memory-KV (deckt localStorage-Fallback + Remote ab) ───────────────────
const kv: Record<string, unknown> = {};
vi.mock('../supabase-kv', () => ({
  kvGet:       vi.fn(async (k: string) => kv[k] ?? null),
  kvGetStrict: vi.fn(async (k: string) => kv[k] ?? null),
  kvSet:       vi.fn(async (k: string, v: unknown) => { kv[k] = v; }),
  safeUpsertDailyBudgets: vi.fn(async (
    k: string,
    updates: Record<string, Record<string, unknown>>,
  ) => {
    const base = (kv[k] as Record<string, Record<string, unknown>>) ?? {};
    const merged: Record<string, Record<string, unknown>> = { ...base };
    for (const [date, fields] of Object.entries(updates)) {
      merged[date] = { ...(merged[date] ?? {}), ...fields };
    }
    kv[k] = merged;
    return merged;
  }),
}));

// prior-year-lock (nur für den Vorjahr-Pfad — hier immer entsperrt)
vi.mock('../prior-year-lock', () => ({
  getLockState: vi.fn(async () => ({ locked: false })),
}));

// vj-daily-supabase mocken (lädt sonst den echten Supabase-Client → localStorage
// beim Modul-Load). Für den actual-Pfad ohnehin ungenutzt.
vi.mock('../vj-daily-supabase', () => ({
  upsertVjDailyBatch: vi.fn(async (recs: unknown[]) => ({ upserted: (recs as unknown[]).length, error: null })),
}));

import { saveAvgCheck, loadAvgCheckDaily, loadAvgCheckMonthly } from '../gaeste-store';
import { commitGastronoviDays } from '../gastronovi-daily-save';

const tk = (k: string) => k; // oliv: unpräfixiert (wie in Produktion)

function day(date: string, total: number, food: number, beverage: number, takeAway: number): GastronoviDayResult {
  return { date, total, food, beverage, takeAway, currency: 'CHF' };
}

beforeEach(() => {
  for (const k of Object.keys(kv)) delete kv[k];
  localStorage.clear();
});

describe('R1 — Durchschnittsverkauf: Save landet im vom Reader gelesenen Key/Format', () => {
  it('saveAvgCheck schreibt avgcheck-daily (ISO) + avgcheck-monthly (YYYY-MM), Reader findet es', async () => {
    const daily = { '2026-07-01': 70.26, '2026-07-02': 66.91, '2026-07-28': 40.5 };
    await saveAvgCheck(tk, daily, { '2026-07': 53.48 });

    // Exakt die Keys, die der Report liest:
    expect(kv['avgcheck-daily']).toMatchObject(daily);
    expect(kv['avgcheck-monthly']).toMatchObject({ '2026-07': 53.48 });

    // Round-trip über die echten Reader-Funktionen (= monatsreport-Quelle)
    const rd = await loadAvgCheckDaily(tk);
    const rm = await loadAvgCheckMonthly(tk);
    expect(rd['2026-07-01']).toBe(70.26);
    expect(rm['2026-07']).toBe(53.48); // avgMonat = avgMonthly[`${year}-${mm}`]
  });

  it('Merge erhält andere Monate (kein Blob-Überschreiben)', async () => {
    await saveAvgCheck(tk, { '2026-06-15': 60 }, { '2026-06': 60 });
    await saveAvgCheck(tk, { '2026-07-01': 70.26 }, { '2026-07': 53.48 });
    const rm = await loadAvgCheckMonthly(tk);
    expect(rm['2026-06']).toBe(60);
    expect(rm['2026-07']).toBe(53.48);
  });
});

describe('R2 — Take Away Anteil: takeawayRevenue überlebt commit + ISO-Filter', () => {
  it('commitGastronoviDays(actual) schreibt takeawayRevenue je Tag', async () => {
    const rows = [
      day('2026-07-01', 12326.37, 8587.68, 2677.15, 1061.54),
      day('2026-07-02', 13576.43, 8489.46, 3463.89, 1623.08),
    ];
    const res = await commitGastronoviDays('dailyBudgets', rows, 'actual', { tenantId: 'oliv', year: 2026 });
    expect(res.count).toBe(2);

    const stored = kv['dailyBudgets'] as Record<string, Record<string, unknown>>;
    expect(stored['2026-07-01']).toMatchObject({ actualRevenue: 12326.37, takeawayRevenue: 1061.54 });
    expect(stored['2026-07-02'].takeawayRevenue).toBe(1623.08);

    // Report-Reader-Formel: TA-Summe > 0 → Zeile «Take Away Anteil» wird befüllt
    const taSum = Object.values(stored).reduce((s, d) => s + Number(d.takeawayRevenue ?? 0), 0);
    expect(taSum).toBeCloseTo(2684.62, 2);
  });

  it('ISO-Filter (Kalender-Fix) verliert takeawayRevenue der gültigen Tage nicht', async () => {
    // Simuliert die UI-Filterung: nur gültige ISO-Tage behalten — Feld bleibt erhalten.
    const parsed = [
      day('2026-07-01', 12326.37, 8587.68, 2677.15, 1061.54),
      day('2026-07-02', 13576.43, 8489.46, 3463.89, 1623.08),
    ];
    const validIsoSet = new Set(['2026-07-01', '2026-07-02']);
    const filtered = parsed.filter(r => validIsoSet.has(r.date));

    await commitGastronoviDays('dailyBudgets', filtered, 'actual', { tenantId: 'oliv', year: 2026 });
    const stored = kv['dailyBudgets'] as Record<string, Record<string, unknown>>;
    expect(stored['2026-07-01'].takeawayRevenue).toBe(1061.54);
    expect(stored['2026-07-02'].takeawayRevenue).toBe(1623.08);
  });
});
