// @vitest-environment node
/**
 * daily-actuals.test.ts — Effektive Tages-IST-Umsätze (reine Logik)
 * Kernregeln: dailyBudgets(>0) > vj_daily(inkl. echter 0) > null («—», nie 0).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDailyActual,
  buildMonthActuals,
  summarizeMonthActuals,
  summarizeEffectiveMonth,
} from '../daily-actuals';

describe('resolveDailyActual', () => {
  it('dailyBudgets-Eintrag mit actualRevenue > 0 gewinnt (inkl. takeaway)', () => {
    const r = resolveDailyActual(
      { actualRevenue: 5400.5, takeawayRevenue: 120 },
      { actualRevenue: 9999 },
    );
    expect(r).toEqual({ gross: 5400.5, takeaway: 120, source: 'dailyBudgets' });
  });

  it('ohne Blob-Eintrag greift vj_daily desselben Jahres', () => {
    const r = resolveDailyActual(undefined, { actualRevenue: 9917.8 });
    expect(r).toEqual({ gross: 9917.8, takeaway: 0, source: 'vj_daily' });
  });

  it('echte 0 aus vj_daily bleibt 0 (Schliessungstag), zählt als vorhanden', () => {
    const r = resolveDailyActual(undefined, { actualRevenue: 0 });
    expect(r.gross).toBe(0);
    expect(r.source).toBe('vj_daily');
  });

  it('Blob-0 (Legacy-Füllwert) gilt als «kein IST» — vj_daily-Record gewinnt', () => {
    const r = resolveDailyActual({ actualRevenue: 0 }, { actualRevenue: 812.4 });
    expect(r).toEqual({ gross: 812.4, takeaway: 0, source: 'vj_daily' });
  });

  it('Blob-0 ohne vj_daily-Record ⇒ null (fehlt), NIE 0', () => {
    const r = resolveDailyActual({ actualRevenue: 0 }, undefined);
    expect(r).toEqual({ gross: null, takeaway: 0, source: null });
  });

  it('kein Import ⇒ null (fehlt), NIE 0', () => {
    const r = resolveDailyActual(undefined, undefined);
    expect(r).toEqual({ gross: null, takeaway: 0, source: null });
  });

  it('nicht-numerische/NaN-Werte werden ignoriert', () => {
    const r = resolveDailyActual(
      { actualRevenue: NaN },
      { actualRevenue: 'x' as unknown as number },
    );
    expect(r.gross).toBeNull();
  });

  it('beide Quellen vorhanden mit identischen Werten (2025-Fall) → deterministisch Blob', () => {
    const r = resolveDailyActual({ actualRevenue: 7118.5 }, { actualRevenue: 7118.5 });
    expect(r.source).toBe('dailyBudgets');
    expect(r.gross).toBe(7118.5);
  });
});

describe('buildMonthActuals + summarizeMonthActuals', () => {
  const days = ['2024-12-01', '2024-12-02', '2024-12-03', '2024-12-04'];

  it('Dez-2024-Szenario Oliv: Blob leer, vj_daily voll ⇒ alle Tage aus vj_daily', () => {
    const vj = {
      '2024-12-01': { actualRevenue: 1000 },
      '2024-12-02': { actualRevenue: 0 },      // Schliessungstag
      '2024-12-03': { actualRevenue: 2500.75 },
      // 2024-12-04 fehlt bewusst
    };
    const actuals = buildMonthActuals(days, {}, vj);
    expect(actuals['2024-12-01'].gross).toBe(1000);
    expect(actuals['2024-12-02'].gross).toBe(0);
    expect(actuals['2024-12-03'].gross).toBe(2500.75);
    expect(actuals['2024-12-04'].gross).toBeNull();

    const sum = summarizeMonthActuals(actuals);
    expect(sum.daysWithData).toBe(3);   // echte 0 zählt als vorhanden
    expect(sum.totalDays).toBe(4);
    expect(sum.grossSum).toBeCloseTo(3500.75, 2);
    expect(sum.usesVjDaily).toBe(true);
  });

  it('Beaulieu-Szenario: beide Quellen leer ⇒ alles null, Summe 0 Tage', () => {
    const actuals = buildMonthActuals(days, {}, {});
    for (const d of days) expect(actuals[d].gross).toBeNull();
    const sum = summarizeMonthActuals(actuals);
    expect(sum.daysWithData).toBe(0);
    expect(sum.grossSum).toBe(0);
    expect(sum.usesVjDaily).toBe(false);
  });

  it('Misch-Szenario: Blob gewinnt an Tagen mit >0, vj_daily füllt Lücken', () => {
    const blob = { '2024-12-01': { actualRevenue: 900 }, '2024-12-02': { actualRevenue: 0 } };
    const vj   = { '2024-12-02': { actualRevenue: 450 } };
    const actuals = buildMonthActuals(days, blob, vj);
    expect(actuals['2024-12-01'].source).toBe('dailyBudgets');
    expect(actuals['2024-12-02']).toMatchObject({ gross: 450, source: 'vj_daily' });
    expect(actuals['2024-12-03'].gross).toBeNull();
    const sum = summarizeMonthActuals(actuals);
    expect(sum.daysWithData).toBe(2);
    expect(sum.grossSum).toBe(1350);
  });
});

describe('summarizeEffectiveMonth (Umsatzabstimmung «Summe Tage»)', () => {
  it('baut die Tages-Keys des Monats selbst auf (Dez 2024 = 31 Tage)', () => {
    const vj = {
      '2024-12-01': { actualRevenue: 1000 },
      '2024-12-31': { actualRevenue: 2000 },
      '2024-11-30': { actualRevenue: 9999 }, // anderer Monat — zählt nicht
    };
    const sum = summarizeEffectiveMonth({}, vj, 2024, 12);
    expect(sum.totalDays).toBe(31);
    expect(sum.daysWithData).toBe(2);
    expect(sum.grossSum).toBe(3000);
    expect(sum.usesVjDaily).toBe(true);
  });

  it('Schaltjahr-Februar 2024 hat 29 Tage; leere Quellen ⇒ 0 Datentage', () => {
    const sum = summarizeEffectiveMonth({}, {}, 2024, 2);
    expect(sum.totalDays).toBe(29);
    expect(sum.daysWithData).toBe(0);
    expect(sum.grossSum).toBe(0);
    expect(sum.usesVjDaily).toBe(false);
  });

  it('Blob (>0) und vj_daily kombiniert; Blob-0 fällt auf vj_daily zurück', () => {
    const blob = { '2025-01-05': { actualRevenue: 800 }, '2025-01-06': { actualRevenue: 0 } };
    const vj   = { '2025-01-06': { actualRevenue: 300 }, '2025-01-07': { actualRevenue: 0 } };
    const sum = summarizeEffectiveMonth(blob, vj, 2025, 1);
    expect(sum.daysWithData).toBe(3); // 05 Blob, 06 vj-Fallback, 07 echte 0
    expect(sum.grossSum).toBe(1100);
    expect(sum.usesVjDaily).toBe(true);
  });
});
