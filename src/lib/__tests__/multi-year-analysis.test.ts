// @vitest-environment node
/**
 * Tests für die Mehrjahresanalyse (reine Logik).
 */
import { describe, it, expect } from 'vitest';
import {
  buildMultiYearAnalysis, buildMonthDetail, selectLastYears, nonEmptyYears,
  partialRangeLabel, fmtChf, fmtMio, fmtPct, fmtDeltaChf,
  type YearSeries,
} from '../multi-year-analysis';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Volles Jahr: Jan=base, dann +step pro Monat */
function fullYear(year: number, base: number, step = 0): YearSeries {
  return { year, netRevenue: Array.from({ length: 12 }, (_, i) => base + i * step) };
}

/** Teiljahr Januar–Juni */
function halfYear(year: number, base: number, step = 0): YearSeries {
  return {
    year,
    netRevenue: Array.from({ length: 12 }, (_, i) => (i < 6 ? base + i * step : null)),
  };
}

const Y24 = fullYear(2024, 100_000);          // Total 1.2 Mio
const Y25 = fullYear(2025, 110_000);          // Total 1.32 Mio (+10%)
const Y26H = halfYear(2026, 130_000);         // Teiljahr Jan–Jun, 780k

// ─── Jahresauswahl ────────────────────────────────────────────────────────────

describe('nonEmptyYears / selectLastYears', () => {
  it('filtert leere Jahre heraus und sortiert aufsteigend', () => {
    const empty: YearSeries = { year: 2023, netRevenue: Array(12).fill(null) };
    const out = nonEmptyYears([Y25, empty, Y24]);
    expect(out.map((s) => s.year)).toEqual([2024, 2025]);
  });

  it('selectLastYears wählt die letzten N Jahre mit Daten', () => {
    expect(selectLastYears([Y24, Y25, Y26H], 2).map((s) => s.year)).toEqual([2025, 2026]);
    expect(selectLastYears([Y24, Y25, Y26H], 5).map((s) => s.year)).toEqual([2024, 2025, 2026]);
  });

  it('normalisiert kurze Arrays auf 12 Monate', () => {
    const short: YearSeries = { year: 2024, netRevenue: [100, 200] };
    const out = nonEmptyYears([short]);
    expect(out[0].netRevenue).toHaveLength(12);
    expect(out[0].netRevenue[11]).toBeNull();
  });
});

// ─── Grundberechnung ──────────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — Tabelle & Deltas', () => {
  it('berechnet Monatszellen mit Δ Vorjahr und Δ Basisjahr (CHF und %)', () => {
    const a = buildMultiYearAnalysis([Y24, Y25, Y26H]);
    expect(a.years).toEqual([2024, 2025, 2026]);
    expect(a.baseYear).toBe(2024);
    const jan26 = a.monthRows[0].cells.find((c) => c.year === 2026)!;
    expect(jan26.value).toBe(130_000);
    expect(jan26.vsPrevYear.chf).toBe(20_000);           // 130k − 110k
    expect(jan26.vsPrevYear.pct).toBeCloseTo(18.18, 1);
    expect(jan26.vsBaseYear.chf).toBe(30_000);           // 130k − 100k
    expect(jan26.vsBaseYear.pct).toBeCloseTo(30, 5);
  });

  it('Basisjahr selbst hat kein Δ Basisjahr', () => {
    const a = buildMultiYearAnalysis([Y24, Y25]);
    const jan24 = a.monthRows[0].cells.find((c) => c.year === 2024)!;
    expect(jan24.vsBaseYear.chf).toBeNull();
    expect(jan24.vsBaseYear.pct).toBeNull();
  });

  it('Δ Vorjahr nur bei direktem Kalender-Vorjahr (Jahreslücke ⇒ null + Limitation)', () => {
    const a = buildMultiYearAnalysis([fullYear(2023, 90_000), fullYear(2025, 110_000)]);
    const jan25 = a.monthRows[0].cells.find((c) => c.year === 2025)!;
    expect(jan25.vsPrevYear.chf).toBeNull();
    expect(jan25.vsBaseYear.chf).toBe(20_000); // Basisjahr-Vergleich bleibt möglich
    expect(a.limitations.some((l) => l.includes('fehlen Jahre'))).toBe(true);
  });

  it('Jahres-Total: Teiljahr-Δ nur über gemeinsame Monate', () => {
    const a = buildMultiYearAnalysis([Y25, Y26H]);
    const t26 = a.totals.find((t) => t.year === 2026)!;
    expect(t26.isPartial).toBe(true);
    expect(t26.partialLabel).toBe('Januar–Juni');
    expect(t26.monthsWithData).toBe(6);
    expect(t26.vsPrevYearCommon.commonMonths).toBe(6);
    // Jan–Jun 2026: 780k; Jan–Jun 2025: 660k → +120k / +18.18 %
    expect(t26.vsPrevYearCommon.chf).toBe(120_000);
    expect(t26.vsPrevYearCommon.pct).toBeCloseTo(18.18, 1);
    expect(a.limitations.some((l) => l.includes('Teiljahr'))).toBe(true);
  });

  it('Rang, Anteil am Jahresumsatz und Trendton pro Zelle', () => {
    const grow = fullYear(2025, 100_000, 1_000); // Dez am höchsten
    const a = buildMultiYearAnalysis([fullYear(2024, 100_000), grow]);
    const dez = a.monthRows[11].cells.find((c) => c.year === 2025)!;
    expect(dez.rankInYear).toBe(1);
    const jan = a.monthRows[0].cells.find((c) => c.year === 2025)!;
    expect(jan.rankInYear).toBe(12);
    expect(jan.shareOfYearPct).toBeCloseTo((100_000 / 1_266_000) * 100, 3);
    expect(dez.tone).toBe('good');       // +11 % vs. VJ
    expect(jan.tone).toBe('neutral');    // 0 % vs. VJ
  });

  it('stabile Rangfolge bei Gleichstand (früherer Monat gewinnt)', () => {
    const a = buildMultiYearAnalysis([fullYear(2025, 100_000)]); // alle Monate gleich
    const cells = a.monthRows.map((r) => r.cells[0].rankInYear);
    expect(cells).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

// ─── KPIs ─────────────────────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — KPIs', () => {
  it('CAGR über vollständige Jahre', () => {
    const a = buildMultiYearAnalysis([Y24, fullYear(2026, 121_000)]);
    // 1.2 Mio → 1.452 Mio über 2 Jahre ⇒ 10 % p.a.
    expect(a.kpis.cagrPct).toBeCloseTo(10, 5);
    expect(a.kpis.cagrFromYear).toBe(2024);
    expect(a.kpis.cagrToYear).toBe(2026);
  });

  it('CAGR null bei weniger als zwei vollständigen Jahren (+ Limitation)', () => {
    const a = buildMultiYearAnalysis([Y25, Y26H]);
    expect(a.kpis.cagrPct).toBeNull();
    expect(a.limitations.some((l) => l.includes('CAGR'))).toBe(true);
  });

  it('Wachstum CHF/%, Trend steigend', () => {
    const a = buildMultiYearAnalysis([Y24, Y25]);
    expect(a.kpis.growthChf).toBe(120_000);
    expect(a.kpis.growthPct).toBeCloseTo(10, 5);
    expect(a.kpis.trend).toBe('steigend');
  });

  it('Trend stabil innerhalb ±2 %, rückläufig darunter', () => {
    const flat = buildMultiYearAnalysis([Y24, fullYear(2025, 101_000)]); // +1 %
    expect(flat.kpis.trend).toBe('stabil');
    const down = buildMultiYearAnalysis([Y24, fullYear(2025, 90_000)]); // −10 %
    expect(down.kpis.trend).toBe('ruecklaeufig');
  });

  it('bester/schwächster Monat des letzten Jahres, höchster Jahresumsatz', () => {
    const a = buildMultiYearAnalysis([Y24, fullYear(2025, 100_000, 2_000)]);
    expect(a.kpis.bestMonth?.label).toBe('Dezember');
    expect(a.kpis.worstMonth?.label).toBe('Januar');
    expect(a.kpis.highestAnnual?.year).toBe(2025);
  });

  it('Ø monatliches Vorjahres-Wachstum (gleichmässig +10 % ⇒ 10 %)', () => {
    const a = buildMultiYearAnalysis([Y24, Y25]);
    expect(a.kpis.avgMonthlyGrowthPct).toBeCloseTo(10, 5);
  });

  it('nur EIN Jahr: Wachstums-KPIs null, kein Fehler', () => {
    const a = buildMultiYearAnalysis([Y25]);
    expect(a.kpis.growthPct).toBeNull();
    expect(a.kpis.prevYear).toBeNull();
    expect(a.kpis.trend).toBeNull();
    expect(a.hasAnyData).toBe(true);
  });
});

// ─── Kanten / Robustheit ──────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — Kanten', () => {
  it('leere Eingabe: hasAnyData=false, keine NaN, Limitation gesetzt', () => {
    const a = buildMultiYearAnalysis([]);
    expect(a.hasAnyData).toBe(false);
    expect(a.monthRows).toEqual([]);
    expect(a.limitations[0]).toContain('Keine Erfolgsrechnungs-Daten');
  });

  it('Umsatz 0 im Vorjahr: Prozent-Δ null statt Infinity', () => {
    const zero: YearSeries = { year: 2024, netRevenue: [0, ...Array(11).fill(null)] };
    const next: YearSeries = { year: 2025, netRevenue: [50_000, ...Array(11).fill(null)] };
    const a = buildMultiYearAnalysis([zero, next]);
    const jan25 = a.monthRows[0].cells.find((c) => c.year === 2025)!;
    expect(jan25.vsPrevYear.pct).toBeNull();
    expect(jan25.vsPrevYear.chf).toBe(50_000);
  });

  it('keine NaN/Infinity irgendwo im Ergebnis (JSON-Scan)', () => {
    const messy: YearSeries = {
      year: 2025,
      netRevenue: [0, null, 50_000, null, 0, 80_000, null, null, null, null, null, null],
    };
    const a = buildMultiYearAnalysis([fullYear(2024, 0), messy]);
    const json = JSON.stringify(a);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('CAGR null bei 0-Basis (kein Infinity)', () => {
    const a = buildMultiYearAnalysis([fullYear(2024, 0), fullYear(2025, 100_000)]);
    expect(a.kpis.cagrPct).toBeNull();
  });

  it('partialRangeLabel: zusammenhängend, einzeln, nicht zusammenhängend, voll', () => {
    expect(partialRangeLabel([0, 1, 2, 3, 4, 5])).toBe('Januar–Juni');
    expect(partialRangeLabel([3])).toBe('April');
    expect(partialRangeLabel([0, 2, 5])).toBe('3 Monate');
    expect(partialRangeLabel(Array.from({ length: 12 }, (_, i) => i))).toBeNull();
  });
});

// ─── Jahresanalysen ───────────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — Jahresanalysen', () => {
  it('liefert Top-3/Flop-3 Monate und Quartalsprofil', () => {
    const a = buildMultiYearAnalysis([fullYear(2025, 100_000, 1_000)]);
    const y = a.yearSummaries[0];
    expect(y.bestMonths.map((m) => m.label)).toEqual(['Dezember', 'November', 'Oktober']);
    expect(y.worstMonths.map((m) => m.label)).toEqual(['Januar', 'Februar', 'März']);
    expect(y.quarters).toHaveLength(4);
    const shareSum = y.quarters.reduce((s, q) => s + (q.sharePct ?? 0), 0);
    expect(shareSum).toBeCloseTo(100, 5);
  });

  it('Teiljahr: Quartale ohne Daten haben total null (nicht 0)', () => {
    const a = buildMultiYearAnalysis([halfYear(2026, 100_000)]);
    const y = a.yearSummaries[0];
    expect(y.quarters[0].total).not.toBeNull();
    expect(y.quarters[3].total).toBeNull();
  });
});

// ─── Diagrammdaten ────────────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — Diagrammdaten', () => {
  it('Linienchart: 12 Punkte, ein Schlüssel pro Jahr, null für fehlende Monate', () => {
    const a = buildMultiYearAnalysis([Y25, Y26H]);
    expect(a.chart.line).toHaveLength(12);
    expect(a.chart.lineYearKeys).toEqual([
      { year: 2025, key: 'y2025' }, { year: 2026, key: 'y2026' },
    ]);
    expect(a.chart.line[0].y2026).toBe(130_000);
    expect(a.chart.line[11].y2026).toBeNull();
  });

  it('Wasserfall: kumulierte Monatsdeltas + Totalbalken, korrekte Sockel', () => {
    const prev: YearSeries = { year: 2025, netRevenue: [100, 100, ...Array(10).fill(null)] };
    const cur: YearSeries = { year: 2026, netRevenue: [150, 80, ...Array(10).fill(null)] };
    const a = buildMultiYearAnalysis([prev, cur]);
    const w = a.chart.waterfall;
    expect(w).toHaveLength(3); // Jan, Feb, Total
    expect(w[0]).toMatchObject({ label: 'Jan', delta: 50, cumStart: 0, cumEnd: 50, base: 0, height: 50, tone: 'good' });
    expect(w[1]).toMatchObject({ label: 'Feb', delta: -20, cumStart: 50, cumEnd: 30, base: 30, height: 20, tone: 'critical' });
    expect(w[2]).toMatchObject({ label: 'Total', delta: 30, base: 0, height: 30, isTotal: true });
    expect(a.chart.waterfallYears).toEqual({ from: 2025, to: 2026 });
  });

  it('kein Wasserfall ohne direktes Vorjahr', () => {
    const a = buildMultiYearAnalysis([fullYear(2023, 90_000), fullYear(2025, 110_000)]);
    expect(a.chart.waterfall).toEqual([]);
    expect(a.chart.waterfallYears).toBeNull();
  });
});

// ─── Executive Summary ────────────────────────────────────────────────────────

describe('buildMultiYearAnalysis — Executive Summary', () => {
  it('beschreibt Umsatzentwicklung, Wachstum und Vorjahresmonate (alle darüber)', () => {
    const a = buildMultiYearAnalysis([Y24, Y25, Y26H]);
    const text = a.executiveSummary.join(' ');
    expect(text).toContain('1.20 Mio.');
    expect(text).toContain('(2026, Januar–Juni)');
    expect(text).toContain('gegenüber 2025');
    expect(text).toContain('gegenüber 2024');
    expect(text).toContain('Sämtliche 6 vergleichbaren Monate liegen über dem Vorjahresniveau');
  });

  it('zählt Monate über Vorjahr korrekt, wenn nicht alle darüber liegen', () => {
    const mixed: YearSeries = {
      year: 2025,
      netRevenue: [120_000, 90_000, ...Array(10).fill(null)],
    };
    const a = buildMultiYearAnalysis([Y24, mixed]);
    expect(a.executiveSummary.join(' ')).toContain('1 von 2 vergleichbaren Monaten');
  });

  it('nur ein Jahr: keine Wachstumsaussagen, keine Behauptungen', () => {
    const a = buildMultiYearAnalysis([Y25]);
    const text = a.executiveSummary.join(' ');
    expect(text).not.toContain('Wachstum von');
    expect(text).toContain('ein Jahr');
  });
});

// ─── Monats-Detail ────────────────────────────────────────────────────────────

describe('buildMonthDetail', () => {
  it('liefert Werte aller Jahre, Durchschnitt und Quoten', () => {
    const withQuotes: YearSeries = {
      ...Y25,
      personnelPct: Array(12).fill(42.5),
      wesPct: Array(12).fill(28.1),
    };
    const a = buildMultiYearAnalysis([Y24, withQuotes]);
    const d = buildMonthDetail(a, 0)!;
    expect(d.label).toBe('Januar');
    expect(d.perYear).toHaveLength(2);
    expect(d.avgValue).toBe(105_000); // (100k + 110k) / 2
    expect(d.perYear.find((c) => c.year === 2025)?.personnelPct).toBe(42.5);
    expect(d.perYear.find((c) => c.year === 2025)?.wesPct).toBe(28.1);
  });

  it('ungültiger Index ⇒ null', () => {
    const a = buildMultiYearAnalysis([Y25]);
    expect(buildMonthDetail(a, -1)).toBeNull();
    expect(buildMonthDetail(a, 12)).toBeNull();
  });
});

// ─── Formatierer ──────────────────────────────────────────────────────────────

describe('Formatierer', () => {
  it('fmtChf/fmtMio/fmtPct/fmtDeltaChf: null ⇒ "—", de-CH Formate', () => {
    expect(fmtChf(null)).toBe('—');
    expect(fmtMio(1_204_567)).toContain('1.20 Mio.');
    expect(fmtPct(10.25)).toBe('+10.3 %');
    expect(fmtPct(-3.14)).toBe('-3.1 %'); // de-CH toLocaleString liefert Hyphen-Minus
    expect(fmtDeltaChf(-5000)).toBe('−5’000');
    expect(fmtDeltaChf(5000)).toBe('+5’000');
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe('—');
    expect(fmtChf(Number.NaN)).toBe('—');
  });
});
