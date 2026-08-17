// @vitest-environment node
/**
 * Tests der gemeinsamen KPI-Box-Datenaufbereitung (Monat- + Wochen-Reihe der
 * Cockpit-Monatsübersicht): Spaltenwahl month/week, «leer statt 0»,
 * WKQ-/PKQ-Ampeln, Δ%-Referenz = Budget derselben Spalte.
 */
import { describe, it, expect } from 'vitest';
import { kpiBoxenDaten } from '@/lib/cockpit-kpi-boxen';
import type { MrRow } from '@/lib/monatsreport';

const base = {
  type: 'data' as const,
  budget: null, vj: null, vjMonth: null,
  week: null, weekBudget: null, month: null, monthBudget: null,
};

function rows(over: Partial<Record<string, Partial<MrRow>>>): MrRow[] {
  const ids = ['netto_umsatz', 'warenkosten_total', 'personalquote', 'produktivitaet', 'gaeste_in'];
  return ids.map(id => ({ ...base, id, label: id, ...(over[id] ?? {}) } as MrRow));
}

describe('kpiBoxenDaten', () => {
  it('liefert immer 5 Boxen in fester Reihenfolge', () => {
    const b = kpiBoxenDaten(rows({}), 'month');
    expect(b.map(x => x.id)).toEqual(['netto_umsatz', 'wkq', 'pkq', 'produktivitaet', 'gaeste_in']);
  });

  it('leer statt 0: fehlende Quelle ⇒ wert=null, kein Δ, keine Ampel', () => {
    const b = kpiBoxenDaten(rows({}), 'week');
    for (const x of b) {
      expect(x.wert).toBeNull();
      expect(x.delta ?? null).toBeNull();
      expect(x.ampelGut).toBeUndefined();
    }
  });

  it('Monats-Spalte liest month/monthBudget', () => {
    const b = kpiBoxenDaten(rows({
      netto_umsatz: { month: 110_000, monthBudget: 100_000, week: 999, weekBudget: 1 },
    }), 'month');
    expect(b[0].wert).toContain('110');
    expect(b[0].delta).toEqual({ text: '+10.0 %', positiv: true });
  });

  it('Wochen-Spalte liest week/weekBudget (Ist der Woche vs. Budget der Woche)', () => {
    const b = kpiBoxenDaten(rows({
      netto_umsatz: { month: 999_999, monthBudget: 1, week: 22_800, weekBudget: 24_000 },
      produktivitaet: { week: 105, weekBudget: 100 },
      gaeste_in: { week: 950, weekBudget: 1_000, fmt: 'count' },
    }), 'week');
    expect(b[0].delta).toEqual({ text: '-5.0 %', positiv: false });
    expect(b[3].delta).toEqual({ text: '+5.0 %', positiv: true });
    expect(b[4].wert).toBe('950');
    expect(b[4].delta).toEqual({ text: '-5.0 %', positiv: false });
  });

  it('WKQ-Ampel je Spalte: ≤ Ziel grün, darüber rot (Ziel 24 %)', () => {
    const r = rows({
      warenkosten_total: {
        wkqInline: {
          month: { pct: 23.9, ziel: 24, food: null, bev: null, budgetPct: null } as never,
          week: { pct: 24.1, ziel: 24, food: null, bev: null, budgetPct: null } as never,
        },
      },
    });
    expect(kpiBoxenDaten(r, 'month')[1]).toMatchObject({ wert: '23.9 %', ampelGut: true, label: 'WKQ (Ziel max. 24 %)' });
    expect(kpiBoxenDaten(r, 'week')[1]).toMatchObject({ wert: '24.1 %', ampelGut: false });
  });

  it('PKQ-Ampel: ≤ 40 % grün, darüber rot — je Spalte unabhängig', () => {
    const r = rows({ personalquote: { month: 39.5, week: 41.2, warnAbove: 40 } });
    expect(kpiBoxenDaten(r, 'month')[2]).toMatchObject({ wert: '39.5 %', ampelGut: true, label: 'PKQ (max. 40 %)' });
    expect(kpiBoxenDaten(r, 'week')[2]).toMatchObject({ wert: '41.2 %', ampelGut: false });
  });

  it('Δ nur bei Budget > 0 (nie ÷ 0), Wert bleibt sichtbar', () => {
    const b = kpiBoxenDaten(rows({ netto_umsatz: { week: 5_000, weekBudget: 0 } }), 'week');
    expect(b[0].wert).toContain('5');
    expect(b[0].delta ?? null).toBeNull();
  });

  it('reines Mapping: nur übergebene Zeilen zählen (Mandantentrennung upstream)', () => {
    const oliv = kpiBoxenDaten(rows({ netto_umsatz: { week: 1_000 } }), 'week');
    const beaulieu = kpiBoxenDaten(rows({ netto_umsatz: { week: 2_000 } }), 'week');
    expect(oliv[0].wert).not.toBe(beaulieu[0].wert);
  });
});
