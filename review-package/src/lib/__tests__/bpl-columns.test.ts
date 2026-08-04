// @vitest-environment node
/**
 * bpl-columns — E009: reine Spalten-Logik für die Budget-P&L-Tabelle.
 *
 * Regeln: Desktop = bisherige Ableitung aus dem Vergleichsmodus (unverändert);
 * mobil = reduzierte Tabelle mit genau EINER Vergleichsbasis (Budget vor
 * Vorjahr) und ohne %-Spalten. Keine Berechnung, nur Sichtbarkeit (E011).
 */
import { describe, expect, it } from 'vitest';
import { getBPLColumnVisibility, type BPLCompareMode, type BPLPctMode } from '@/lib/bpl-columns';

const COMPARE_MODES: BPLCompareMode[] = ['all', 'ist_budget', 'ist_vorjahr', 'monat_vs_monat'];
const PCT_MODES: BPLPctMode[] = ['off', 'normal', 'subtle'];

describe('getBPLColumnVisibility — Desktop (unverändert)', () => {
  it('all: Budget + Vorjahr sichtbar, pctMode unangetastet', () => {
    for (const pct of PCT_MODES) {
      expect(getBPLColumnVisibility('all', pct, false)).toEqual({
        showBudget: true, showPrevYear: true, pctMode: pct,
      });
    }
  });

  it('ist_budget: nur Budget', () => {
    expect(getBPLColumnVisibility('ist_budget', 'normal', false)).toEqual({
      showBudget: true, showPrevYear: false, pctMode: 'normal',
    });
  });

  it('ist_vorjahr: nur Vorjahr', () => {
    expect(getBPLColumnVisibility('ist_vorjahr', 'subtle', false)).toEqual({
      showBudget: false, showPrevYear: true, pctMode: 'subtle',
    });
  });

  it('monat_vs_monat: nur Vergleichsmonat (als Vorjahres-Spalte)', () => {
    expect(getBPLColumnVisibility('monat_vs_monat', 'off', false)).toEqual({
      showBudget: false, showPrevYear: true, pctMode: 'off',
    });
  });
});

describe('getBPLColumnVisibility — Mobil (reduzierte Tabelle)', () => {
  it('%-Spalten sind mobil IMMER aus, unabhängig vom pctMode', () => {
    for (const cmp of COMPARE_MODES) {
      for (const pct of PCT_MODES) {
        expect(getBPLColumnVisibility(cmp, pct, true).pctMode).toBe('off');
      }
    }
  });

  it('genau EINE Vergleichsbasis: nie Budget UND Vorjahr gleichzeitig', () => {
    for (const cmp of COMPARE_MODES) {
      const v = getBPLColumnVisibility(cmp, 'normal', true);
      expect(v.showBudget && v.showPrevYear).toBe(false);
    }
  });

  it('all: Budget hat Vorrang, Vorjahr entfällt', () => {
    expect(getBPLColumnVisibility('all', 'normal', true)).toEqual({
      showBudget: true, showPrevYear: false, pctMode: 'off',
    });
  });

  it('ist_vorjahr: Vorjahr bleibt als einzige Vergleichsbasis', () => {
    expect(getBPLColumnVisibility('ist_vorjahr', 'normal', true)).toEqual({
      showBudget: false, showPrevYear: true, pctMode: 'off',
    });
  });

  it('monat_vs_monat: Vergleichsmonat bleibt erhalten', () => {
    expect(getBPLColumnVisibility('monat_vs_monat', 'normal', true)).toEqual({
      showBudget: false, showPrevYear: true, pctMode: 'off',
    });
  });

  it('ist_budget: Budget bleibt, nichts entfällt zusätzlich', () => {
    expect(getBPLColumnVisibility('ist_budget', 'subtle', true)).toEqual({
      showBudget: true, showPrevYear: false, pctMode: 'off',
    });
  });
});
