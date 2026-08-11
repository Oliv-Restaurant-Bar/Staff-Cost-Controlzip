// @vitest-environment node
// Einheitliche WKQ-Umsatzbasis: ladeNettoUmsatzByDate liefert den kanonischen
// Netto-Umsatz (Food+Beverage netto inkl. Marketing) pro Tag — GLEICHE Basis
// wie die Cockpit-WKQ. Warenrechnungen-Modul nutzt diese Map als Nenner
// (vorher brutto actualRevenue → Quote zu tief, 16.5 % vs. 17.4 %).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvGet = vi.fn();
vi.mock('@/lib/supabase-kv', () => ({ kvGet: (k: string) => kvGet(k) }));
vi.mock('@/lib/mwst', () => ({
  mwstDivisorStandard: () => 1.081,
  mwstDivisorTakeaway: () => 1.026,
}));

import { ladeNettoUmsatzByDate, nettoUmsatzTag, foodBeverageSplit, type UmsatzTag } from '@/lib/umsatz';

describe('ladeNettoUmsatzByDate (WKQ-Umsatzbasis)', () => {
  beforeEach(() => kvGet.mockReset());

  it('liefert Netto (nicht brutto) pro Tag; Tage ohne Import fehlen (leer statt 0)', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'dailyBudgets') return {
        '2026-08-01': { actualRevenue: 2162, takeawayRevenue: 0, actualFood: 1081, actualBeverage: 1081 },
        '2026-08-02': { actualRevenue: 0 }, // kein Import → fehlt
        '2026-07-31': { actualRevenue: 999 }, // ausserhalb Range
      };
      if (k === 'maison-daily') return { '2026-08-01': 50 };
      return null;
    });
    const map = await ladeNettoUmsatzByDate('oliv', '2026-08-01', '2026-08-31');
    // 2162 / 1.081 = 2000 netto + 50 Marketing = 2050
    expect(map['2026-08-01']).toBeCloseTo(2050, 2);
    expect('2026-08-02' in map).toBe(false);
    expect('2026-07-31' in map).toBe(false);
  });

  it('Beaulieu: mandanten-präfixierte Keys', async () => {
    kvGet.mockImplementation(async (k: string) => {
      if (k === 'beaulieu:dailyBudgets') return { '2026-08-05': { actualRevenue: 1081 } };
      return null;
    });
    const map = await ladeNettoUmsatzByDate('beaulieu', '2026-08-01', '2026-08-31');
    expect(map['2026-08-05']).toBeCloseTo(1000, 2);
  });

  it('Invariante: Food + Beverage = Netto (Basis der Cockpit-WKQ = Food+Bev netto)', () => {
    const tag: UmsatzTag = {
      datum: '2026-08-01', gesamtBrutto: 3000, takeAwayBrutto: 300,
      foodBrutto: 1500, beverageBrutto: 900, marketingNetto: 40, taVollFood: true,
    };
    const split = foodBeverageSplit(tag);
    expect(split.food + split.beverage).toBeCloseTo(nettoUmsatzTag(tag), 6);
  });
});
