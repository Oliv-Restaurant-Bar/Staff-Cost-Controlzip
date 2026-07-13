// @vitest-environment node
/**
 * Tests J1–J18: Banken-/Investorenanalyse (Spez. 2)
 * ==================================================
 * Reine Logik (node): Rechenhelfer, Analyse-Objekt, Ampellogik,
 * Kernaussagen, Datenqualität sowie BEIDE Export-Aufbereitungen
 * (Excel + PDF), die exakt dasselbe Analysis-Objekt konsumieren.
 */
import { describe, it, expect } from 'vitest';
import {
  absChange, pctChange, quotePct, ppChange,
  lastMonthWithData, isYearComplete, comparisonMonthIndices, sumRow,
  toneForResultDelta, toneForQuoteDelta, toneForCostDelta,
  fmtPp, fmtPctChange,
  buildBankInvestorAnalysis,
  BANK_ROW_IDS, BANK_POSITION_ROWS, BANK_TOTALS_ROW_IDS,
  BANK_NEUTRAL_PCT, BANK_NEUTRAL_PP,
  selectBankYears, EBIT_REPORT_NOTE, BANK_SCORECARD_ROW_IDS,
  BANK_BENCHMARKS, BANK_BENCHMARK_TOLERANCE_PP,
} from '../bank-investor-analysis';
import { buildBankInvestorExcelData, bankInvestorExcelFileName } from '../bank-investor-excel';
import { buildBankInvestorPdfData, bankInvestorPdfFileName, pdfSafe } from '../bank-investor-pdf';
import type { YearSeries } from '../multi-year-analysis';

// ── Synthetische Serien ──────────────────────────────────────────────────────

/** Volles Jahr mit konstanten Monatswerten je Zeile. */
function makeYear(year: number, perMonth: Partial<Record<string, number | null>>, months = 12): YearSeries {
  const byPosition: Record<string, (number | null)[]> = {};
  for (const id of BANK_ROW_IDS) {
    const v = perMonth[id];
    byPosition[id] = Array.from({ length: 12 }, (_, m) => (m < months ? (v ?? null) : null));
  }
  return {
    year,
    values: byPosition['net_revenue'],
    byPosition,
  };
}

// 2024: Umsatz 100k/Monat, Ware 30k (30 %), Personal 40k (40 %), EBIT 10k
const BASE_2024 = makeYear(2024, {
  revenue_total: 100_000, net_revenue: 100_000,
  total_cogs_direct: 28_000, total_cogs: 30_000,
  gross_profit_1: 70_000, total_personnel: 40_000, gross_profit_2: 30_000,
  total_opex: 15_000, ebitda: 15_000, total_depreciation: 5_000, ebit: 10_000,
});

// 2025: nur Jan–Aug; Umsatz 110k (+10 %), Ware 31.9k (29 %), Personal 45.1k (41 %), EBIT 12k
const CURRENT_2025 = makeYear(2025, {
  revenue_total: 110_000, net_revenue: 110_000,
  total_cogs_direct: 29_000, total_cogs: 31_900,
  gross_profit_1: 78_100, total_personnel: 45_100, gross_profit_2: 33_000,
  total_opex: 16_000, ebitda: 17_000, total_depreciation: 5_000, ebit: 12_000,
}, 8);

const buildDefault = (untilSameMonth = true) =>
  buildBankInvestorAnalysis([BASE_2024, CURRENT_2025], {
    baseYear: 2024, currentYear: 2025, untilSameMonth, restaurantName: 'Oliv',
  });

// ── J1–J7: Rechenhelfer ──────────────────────────────────────────────────────

describe('J1 absChange/pctChange', () => {
  it('berechnet Differenzen und behandelt fehlende Werte als null', () => {
    expect(absChange(110, 100)).toBe(10);
    expect(absChange(null, 100)).toBeNull();
    expect(absChange(110, null)).toBeNull();
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(90, 100)).toBeCloseTo(-10);
  });
  it('Basis 0 → null (nicht vergleichbar), negative Basis über |Basis|', () => {
    expect(pctChange(50, 0)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
    // EBIT −10k → +5k: Verbesserung um 150 % von |−10k|
    expect(pctChange(5_000, -10_000)).toBeCloseTo(150);
  });
});

describe('J2 quotePct', () => {
  it('Quote nur mit echtem Umsatz — nie 0 erfinden', () => {
    expect(quotePct(30, 100)).toBeCloseTo(30);
    expect(quotePct(30, 0)).toBeNull();
    expect(quotePct(30, null)).toBeNull();
    expect(quotePct(null, 100)).toBeNull();
  });
});

describe('J3 ppChange', () => {
  it('Prozentpunkte = aktuelle Quote − Basisquote', () => {
    expect(ppChange(29, 30)).toBeCloseTo(-1);
    expect(ppChange(null, 30)).toBeNull();
    expect(ppChange(29, null)).toBeNull();
  });
});

describe('J4 lastMonthWithData/isYearComplete', () => {
  it('erkennt Teiljahre', () => {
    expect(lastMonthWithData(BASE_2024)).toBe(11);
    expect(lastMonthWithData(CURRENT_2025)).toBe(7);
    expect(lastMonthWithData(undefined)).toBe(-1);
    expect(isYearComplete(BASE_2024)).toBe(true);
    expect(isYearComplete(CURRENT_2025)).toBe(false);
  });
});

describe('J5 comparisonMonthIndices', () => {
  it('Gesamtjahr = 12 Monate, „bis gleicher Monat" = Datenstand des aktuellen Jahres', () => {
    expect(comparisonMonthIndices(CURRENT_2025, false)).toHaveLength(12);
    expect(comparisonMonthIndices(CURRENT_2025, true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(comparisonMonthIndices(undefined, true)).toEqual([]);
  });
});

describe('J6 sumRow', () => {
  it('summiert nur vorhandene Monate; komplett leer → null (nie 0)', () => {
    expect(sumRow(BASE_2024, 'net_revenue', [0, 1, 2])).toBe(300_000);
    expect(sumRow(CURRENT_2025, 'net_revenue', [8, 9, 10, 11])).toBeNull();
    expect(sumRow(BASE_2024, 'gibt_es_nicht', [0])).toBeNull();
    expect(sumRow(undefined, 'net_revenue', [0])).toBeNull();
  });
});

describe('J7 Ampellogik nach Geschäftswirkung', () => {
  it('Ergebnisgrössen: steigt = gut, sinkt = kritisch, Mini-Bewegung neutral', () => {
    expect(toneForResultDelta(5, null)).toBe('good');
    expect(toneForResultDelta(-5, null)).toBe('critical');
    expect(toneForResultDelta(BANK_NEUTRAL_PCT / 2, null)).toBe('neutral');
    // Ohne % (Basis 0): CHF-Vorzeichen entscheidet
    expect(toneForResultDelta(null, 1_000)).toBe('good');
    expect(toneForResultDelta(null, -1_000)).toBe('critical');
    expect(toneForResultDelta(null, null)).toBe('neutral');
  });
  it('Quoten: sinkt = gut, steigt = kritisch', () => {
    expect(toneForQuoteDelta(-1)).toBe('good');
    expect(toneForQuoteDelta(1)).toBe('critical');
    expect(toneForQuoteDelta(BANK_NEUTRAL_PP / 2)).toBe('neutral');
    expect(toneForQuoteDelta(null)).toBe('neutral');
  });
  it('absolute Kosten NICHT pauschal rot: langsamer als Umsatz = gut', () => {
    expect(toneForCostDelta(5, 10)).toBe('good');      // Kosten +5 % bei Umsatz +10 %
    expect(toneForCostDelta(15, 10)).toBe('critical'); // Kosten wachsen schneller
    expect(toneForCostDelta(10, 10)).toBe('neutral');
    expect(toneForCostDelta(5, null)).toBe('neutral'); // Umsatz nicht vergleichbar
  });
});

// ── J8–J13: Analyse-Objekt ───────────────────────────────────────────────────

describe('J8 Vergleichszeitraum „bis gleicher Monat"', () => {
  it('vergleicht Januar–August beider Jahre und benennt das im Label', () => {
    const a = buildDefault(true);
    expect(a.comparison.monthIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(a.comparison.isPartial).toBe(true);
    expect(a.comparison.label).toBe('Vergleich Januar–August 2025 mit Januar–August 2024');
    // Umsatz-KPI: 8×110k vs 8×100k → +10 %
    const umsatz = a.kpis.find(k => k.id === 'umsatz')!;
    expect(umsatz.raw.current).toBe(880_000);
    expect(umsatz.raw.base).toBe(800_000);
    expect(umsatz.raw.diffPct).toBeCloseTo(10);
  });
  it('Gesamtjahr-Modus vergleicht alle 12 Monate', () => {
    const a = buildDefault(false);
    expect(a.comparison.monthIndices).toHaveLength(12);
    const umsatz = a.kpis.find(k => k.id === 'umsatz')!;
    expect(umsatz.raw.base).toBe(1_200_000);   // volles Basisjahr
    expect(umsatz.raw.current).toBe(880_000);  // Teiljahr — Warnung folgt (J13)
  });
});

describe('J9 Executive-KPIs mit Wirkungs-Ampel', () => {
  const a = buildDefault(true);
  it('liefert die erwarteten KPIs mit korrekten Tönen', () => {
    const byId = new Map(a.kpis.map(k => [k.id, k]));
    expect(byId.get('umsatz')!.tone).toBe('good');            // +10 %
    expect(byId.get('ware_quote')!.tone).toBe('good');        // 30 % → 29 %
    expect(byId.get('ware_quote')!.raw.diffPp).toBeCloseTo(-1);
    expect(byId.get('personal_quote')!.tone).toBe('critical');// 40 % → 41 %
    expect(byId.get('personal_quote')!.raw.diffPp).toBeCloseTo(1);
    expect(byId.get('ebit')!.tone).toBe('good');              // +20 %
    // Personal absolut: +12.75 % > Umsatz +10 % (+ Schwelle) → kritisch
    expect(byId.get('personal')!.tone).toBe('critical');
    // Ware absolut: +6.33 % < Umsatz +10 % − Schwelle → positiv trotz Anstieg
    expect(byId.get('ware')!.tone).toBe('good');
  });
  it('kein KPI erfindet CHF 0 für fehlende Werte', () => {
    const leer = buildBankInvestorAnalysis([BASE_2024], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    for (const k of leer.kpis) expect(k.value).not.toMatch(/CHF 0(\D|$)/);
  });
});

describe('J10 Umsatz-Erkenntnisse', () => {
  it('bestimmt stärkste/schwächste Monate und Zuwachs deterministisch', () => {
    // Variation: Juli stark, Februar schwach
    const cur = makeYear(2025, { net_revenue: 110_000 }, 8);
    cur.byPosition!['net_revenue'][6] = 150_000;
    cur.byPosition!['net_revenue'][1] = 80_000;
    cur.values = cur.byPosition!['net_revenue'];
    const a = buildBankInvestorAnalysis([BASE_2024, cur], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    expect(a.revenueInsights.strongestMonth).toEqual({ label: 'Juli', value: 150_000 });
    expect(a.revenueInsights.weakestMonth).toEqual({ label: 'Februar', value: 80_000 });
    expect(a.revenueInsights.largestGain).toEqual({ label: 'Juli', diffChf: 50_000 });
    expect(a.revenueInsights.largestDecline).toEqual({ label: 'Februar', diffChf: -20_000 });
  });
});

describe('J11 Positionstabelle & Zwischentotale', () => {
  const a = buildDefault(true);
  it('enthält alle Positionen und markiert Zwischentotale', () => {
    expect(a.positionRows.map(r => r.id)).toEqual(BANK_POSITION_ROWS.map(r => r.id));
    expect(a.totalsRows.map(r => r.id)).toEqual(BANK_TOTALS_ROW_IDS);
    const ebit = a.positionRows.find(r => r.id === 'ebit')!;
    expect(ebit.emphasis).toBe(true);
    expect(ebit.current).toBe(96_000);
    expect(ebit.currentQuote).toBeCloseTo((96_000 / 880_000) * 100);
  });
  it('ohne Umsatz keine Quote (null statt 0)', () => {
    const ohneUmsatz = makeYear(2025, { total_personnel: 45_000 }, 8);
    const a2 = buildBankInvestorAnalysis([BASE_2024, ohneUmsatz], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    const pers = a2.positionRows.find(r => r.id === 'total_personnel')!;
    expect(pers.current).toBe(360_000);
    expect(pers.currentQuote).toBeNull();
  });
});

describe('J12 Kernaussagen (max. 5, regelbasiert)', () => {
  it('formuliert Umsatz/Quoten/EBIT-Aussagen und begrenzt auf 5', () => {
    const a = buildDefault(true);
    expect(a.kernaussagen.length).toBeLessThanOrEqual(5);
    expect(a.kernaussagen.some(s => s.includes('Umsatz') && s.includes('gestiegen'))).toBe(true);
    expect(a.kernaussagen.some(s => s.includes('Warenquote') && s.includes('verbessert'))).toBe(true);
    expect(a.kernaussagen.some(s => s.includes('Personalquote') && s.includes('über dem Vorjahr'))).toBe(true);
    expect(a.kernaussagen.some(s => s.includes('Betriebsergebnis') && s.includes('verbessert'))).toBe(true);
    expect(a.kernaussagen.some(s => s.includes('Personalkosten wachsen schneller'))).toBe(true);
  });
  it('ohne Datenbasis keine erfundenen Aussagen', () => {
    const a = buildBankInvestorAnalysis([], { baseYear: 2024, currentYear: 2025, untilSameMonth: true });
    expect(a.kernaussagen).toEqual([]);
    expect(a.hasData).toBe(false);
  });
});

describe('J13 Datenqualität', () => {
  it('Teiljahr → Hinweis; Gesamtjahresvergleich mit Teiljahr → Warnung', () => {
    const partial = buildDefault(true);
    expect(partial.dataQuality.some(d => d.severity === 'hinweis' && d.text === '2025 enthält Daten bis August.')).toBe(true);
    expect(partial.dataQuality.some(d => d.severity === 'warnung')).toBe(false);
    const full = buildDefault(false);
    expect(full.dataQuality.some(d => d.severity === 'warnung' && d.text.includes('Gesamtjahresvergleich'))).toBe(true);
  });
  it('fehlendes Jahr → Fehler; nicht gemappte Konten → Hinweis', () => {
    const a = buildBankInvestorAnalysis([CURRENT_2025], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true, unmappedAccounts: 3,
    });
    expect(a.dataQuality.some(d => d.severity === 'fehler' && d.text.startsWith('2024'))).toBe(true);
    expect(a.dataQuality.some(d => d.text.includes('3 Konten'))).toBe(true);
    expect(a.hasData).toBe(false);
  });
  it('zentrale Position fehlt trotz Umsatz → Warnung', () => {
    const base = makeYear(2024, { net_revenue: 100_000 }); // kein Personal/Ware
    const a = buildBankInvestorAnalysis([base, CURRENT_2025], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    expect(a.dataQuality.some(d => d.severity === 'warnung' && d.text.includes('Personalaufwand 2024'))).toBe(true);
    expect(a.dataQuality.some(d => d.severity === 'warnung' && d.text.includes('Warenaufwand 2024'))).toBe(true);
  });
});

// ── J14 Formatierung ─────────────────────────────────────────────────────────

describe('J14 fmtPp/fmtPctChange', () => {
  it('formatiert Prozentpunkte mit Vorzeichen und „nicht vergleichbar"', () => {
    expect(fmtPp(1.234)).toBe('+1.2 pp');
    expect(fmtPp(-0.5)).toBe('-0.5 pp');
    expect(fmtPp(null)).toBe('—');
    expect(fmtPctChange(10)).toBe('+10.0 %');
    expect(fmtPctChange(-3.25)).toBe('-3.3 %');
    expect(fmtPctChange(null)).toBe('nicht vergleichbar');
  });
});

// ── J15–J16: Excel-Aufbereitung (gleiche Quelle wie Bildschirm) ──────────────

describe('J15 Excel-Aufbereitung', () => {
  const a = buildDefault(true);
  const x = buildBankInvestorExcelData(a);
  it('liefert die 7 Blätter der Spezifikation (Phase 2: + Mehrjahresanalyse)', () => {
    expect(x.sheets.map(s => s.name)).toEqual([
      'Übersicht', 'Monatsvergleich', 'ER 2024', 'ER 2025', 'Kennzahlen und Margen', 'Mehrjahresanalyse', 'Datenqualität',
    ]);
    expect(x.fileName).toBe('Mehrjahresanalyse_Oliv_2024-2025.xlsx');
    expect(bankInvestorExcelFileName(2024, 2025)).toBe('Mehrjahresanalyse_Restaurant_2024-2025.xlsx');
  });
  it('Jahressumme = Summe der Monatswerte (Vorschau ≡ Export)', () => {
    const monat = x.sheets[1];
    const umsatzCur = monat.rows.reduce((s, r) => s + (typeof r[2].v === 'number' ? r[2].v : 0), 0);
    const kpiUmsatz = a.kpis.find(k => k.id === 'umsatz')!;
    expect(umsatzCur).toBe(kpiUmsatz.raw.current);
    // Kennzahlen-Blatt trägt dieselben Jahreswerte wie das Analysis-Objekt
    const kennzahlen = x.sheets[4];
    const revRow = kennzahlen.rows[0]; // net_revenue
    expect(revRow[2].v).toBe(kpiUmsatz.raw.current);
  });
  it('Prozente als Zahl mit pct-Format, fehlende Werte bleiben null', () => {
    const er2025 = x.sheets[3];
    const persRow = er2025.rows[BANK_POSITION_ROWS.findIndex(r => r.id === 'total_personnel')];
    expect(persRow[2].fmt).toBe('pct');
    expect(persRow[2].v).toBeCloseTo(41);
    const leer = buildBankInvestorExcelData(buildBankInvestorAnalysis([BASE_2024], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    }));
    const er = leer.sheets[3];
    expect(er.rows.every(r => r[1].v == null)).toBe(true); // nie 0 erfinden
  });
});

describe('J16 Excel-Monatsvergleich enthält EBIT je Monat', () => {
  it('EBIT-Spalten stammen aus den Roh-Monatsreihen', () => {
    const a = buildDefault(true);
    const monat = buildBankInvestorExcelData(a).sheets[1];
    expect(monat.head[13]).toBe('EBIT 2024');
    expect(monat.rows[0][13].v).toBe(10_000);
    expect(monat.rows[0][14].v).toBe(12_000);
  });
});

// ── J17–J18: PDF-Aufbereitung (gleiche Quelle wie Bildschirm) ────────────────

describe('J17 PDF-Aufbereitung', () => {
  const a = buildDefault(true);
  const p = buildBankInvestorPdfData(a, { generatedAt: '2026-07-13T10:30:00' });
  it('trägt Kopf, Vergleichslabel und Dateiname', () => {
    expect(p.titel).toBe('Geschäftsentwicklung 2024–2025');
    expect(p.restaurantName).toBe('Oliv');
    expect(p.vergleichsLabel).toBe('Vergleich Januar–August 2025 mit Januar–August 2024');
    expect(p.erstelltAm).toBe('13.07.2026 10:30');
    expect(p.fileName).toBe('banken-investorenbericht_oliv_2024-2025.pdf');
    expect(bankInvestorPdfFileName(2024, 2025)).toBe('banken-investorenbericht_restaurant_2024-2025.pdf');
  });
  it('KPIs/Kernaussagen/Zwischentotale sind identisch mit dem Analysis-Objekt', () => {
    expect(p.kpis.map(k => k.label)).toEqual(a.kpis.map(k => k.label));
    expect(p.kernaussagen).toEqual(a.kernaussagen);
    expect(p.zwischentotale.rows).toHaveLength(a.totalsRows.length);
    // Umsatzzeile des PDF = KPI-Rohwert (Vorschau ≡ Export)
    expect(p.zwischentotale.rows[0][2]).toBe((880_000).toLocaleString('de-CH'));
    expect(p.zwischentotale.strongRows).toContain(a.totalsRows.findIndex(r => r.id === 'ebit'));
  });
  it('Basis 0 wird als „nicht vergleichbar" ausgewiesen, fehlende Werte als —', () => {
    const base0 = makeYear(2024, { net_revenue: 0, total_cogs: 0 });
    const a2 = buildBankInvestorAnalysis([base0, CURRENT_2025], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    const p2 = buildBankInvestorPdfData(a2);
    expect(p2.umsatzTabelle.rows[0][4]).toBe('nicht vergleichbar');
  });
});

describe('J18 pdfSafe & Datenhinweise', () => {
  it('ersetzt PDF-unsichere Zeichen und listet Datenqualität', () => {
    expect(pdfSafe('−5\u00a0%')).toBe('-5 %');
    const a = buildDefault(false);
    const p = buildBankInvestorPdfData(a);
    expect(p.datenhinweise.some(d => d.label === 'Warnung')).toBe(true);
    const ohne = buildBankInvestorPdfData(buildDefault(true));
    expect(ohne.datenhinweise.length).toBeGreaterThan(0); // Teiljahr-Hinweis
  });
});

// ═══ P1–P12: Phase 2 Management-Reporting (N Jahre, additiv) ═════════════════

// 2023: Umsatz 90k/Monat, Ware 29.7k (33 %), Personal 39.6k (44 %), EBIT 1.7k
const YEAR_2023 = makeYear(2023, {
  revenue_total: 90_000, net_revenue: 90_000,
  total_cogs_direct: 27_000, total_cogs: 29_700,
  gross_profit_1: 60_300, total_personnel: 39_600, gross_profit_2: 20_700,
  total_opex: 14_000, ebitda: 6_700, total_depreciation: 5_000, ebit: 1_700,
});

const buildThreeYears = () =>
  buildBankInvestorAnalysis([YEAR_2023, BASE_2024, CURRENT_2025], {
    baseYear: 2024, currentYear: 2025, untilSameMonth: true, restaurantName: 'Oliv',
    years: [2023, 2024, 2025],
    importInfoByYear: {
      2025: { importedAt: '2026-07-01T10:00:00.000Z', fileName: 'konto_2025.xlsx' },
    },
  });

describe('P1 selectBankYears', () => {
  it('wählt chronologisch letzte 2/3/alle, robust bei Lücken und Duplikaten', () => {
    expect(selectBankYears([2025, 2022, 2024], 'two')).toEqual([2024, 2025]);
    expect(selectBankYears([2025, 2022, 2024], 'three')).toEqual([2022, 2024, 2025]);
    expect(selectBankYears([2025, 2022, 2024, 2022], 'all')).toEqual([2022, 2024, 2025]);
    expect(selectBankYears([2025], 'three')).toEqual([2025]);
  });
});

describe('P2 years-Fallback & Rückwärtskompatibilität', () => {
  it('ohne opts.years → [baseYear, currentYear]; Legacy-Felder unverändert', () => {
    const a = buildDefault(true);
    expect(a.years).toEqual([2024, 2025]);
    expect(a.multiYear.years).toEqual([2024, 2025]);
    expect(a.baseYear).toBe(2024);
    expect(a.kernaussagen.length).toBeGreaterThan(0); // Legacy bleibt
    expect(a.ebitNote).toBe(EBIT_REPORT_NOTE);
  });
});

describe('P3 Mehrjahres-Tabelle & Scorecard', () => {
  it('Werte je Jahr über den Vergleichszeitraum (Jan–Aug), Diff = neuestes vs. Vorjahr', () => {
    const a = buildThreeYears();
    const rev = a.multiYear.rows.find(r => r.id === 'net_revenue')!;
    expect(rev.values).toEqual([720_000, 800_000, 880_000]);
    expect(rev.diffChf).toBe(80_000);
    expect(rev.diffPct).toBeCloseTo(10);
    expect(rev.trend).toBe('steigend');
    expect(rev.quotes).toEqual([null, null, null]); // revenue-Zeile ohne Quote
    const ware = a.multiYear.rows.find(r => r.id === 'total_cogs')!;
    expect(ware.quotes[2]).toBeCloseTo(29);
    expect(ware.quotes[0]).toBeCloseTo(33);
  });
  it('Scorecard endet bei EBIT — kein Jahresgewinn (USER-ENTSCHEID)', () => {
    const a = buildThreeYears();
    expect(a.scorecard.rows.map(r => r.id)).toEqual(BANK_SCORECARD_ROW_IDS);
    expect(a.scorecard.rows.map(r => r.id)).not.toContain('jahresgewinn');
    const ebit = a.scorecard.rows.find(r => r.id === 'ebit')!;
    expect(ebit.values).toEqual([13_600, 80_000, 96_000]);
    expect(ebit.trend).toBe('steigend');
    expect(ebit.tone).toBe('good');
  });
  it('fehlendes Jahr in der Auswahl → null-Werte, kein Absturz', () => {
    const a = buildBankInvestorAnalysis([BASE_2024, CURRENT_2025], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
      years: [2023, 2024, 2025],
    });
    const rev = a.multiYear.rows.find(r => r.id === 'net_revenue')!;
    expect(rev.values[0]).toBeNull();
    expect(rev.values[2]).toBe(880_000);
    expect(a.dataQuality.some(d => d.text.includes('2023'))).toBe(true);
  });
});

describe('P4 Executive Summary', () => {
  it('liefert 9 KPIs in Spez.-Reihenfolge, Vergleich neuestes vs. Vorjahr', () => {
    const a = buildThreeYears();
    expect(a.executive.kpis.map(k => k.id)).toEqual([
      'umsatz', 'umsatz_wachstum', 'bruttogewinn', 'bruttomarge',
      'warenquote', 'personalquote', 'ebitda', 'ebit', 'ebit_marge',
    ]);
    const wachstum = a.executive.kpis[1];
    expect(wachstum.raw.diffPct).toBeCloseTo(10);
    expect(wachstum.tone).toBe('good');
    const warenquote = a.executive.kpis[4];
    expect(warenquote.raw.diffPp).toBeCloseTo(-1);
    expect(warenquote.tone).toBe('good');
    const persquote = a.executive.kpis[5];
    expect(persquote.raw.diffPp).toBeCloseTo(1);
    expect(persquote.tone).toBe('critical');
  });
  it('Gesamttrend score-basiert: 4 gute + 1 kritisches Signal → positiv', () => {
    const a = buildThreeYears();
    expect(a.executive.gesamtTrend.label).toBe('positiv');
    expect(a.executive.gesamtTrend.tone).toBe('good');
    expect(a.executive.gesamtTrend.reasons.length).toBeGreaterThan(0);
  });
  it('umgekehrte Entwicklung → kritisch', () => {
    // 2025 schlechter als 2024: Umsatz −10 %, Quoten rauf, EBIT runter
    const bad2025 = makeYear(2025, {
      revenue_total: 90_000, net_revenue: 90_000,
      total_cogs_direct: 27_000, total_cogs: 29_700,
      gross_profit_1: 60_300, total_personnel: 39_600, gross_profit_2: 20_700,
      total_opex: 14_000, ebitda: 6_700, total_depreciation: 5_000, ebit: 1_700,
    }, 8);
    const a = buildBankInvestorAnalysis([BASE_2024, bad2025], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    expect(a.executive.gesamtTrend.label).toBe('kritisch');
  });
});

describe('P5 Waterfall Umsatz→EBIT', () => {
  it('9 Stufen, Subtotale = Engine-Werte, Kette rechnerisch konsistent', () => {
    const a = buildThreeYears();
    expect(a.waterfall.year).toBe(2025);
    expect(a.waterfall.note).toBe(EBIT_REPORT_NOTE);
    expect(a.waterfall.complete).toBe(true);
    const ids = a.waterfall.steps.map(s => s.id);
    expect(ids).toEqual([
      'net_revenue', 'total_cogs', 'gross_profit_1', 'total_personnel',
      'gross_profit_2', 'total_opex', 'ebitda', 'total_depreciation', 'ebit',
    ]);
    const byId = new Map(a.waterfall.steps.map(s => [s.id, s]));
    expect(byId.get('net_revenue')!.cumulative).toBe(880_000);
    // Kosten-Stufe: Zwischenstand = vorheriger Stand − Kosten
    expect(byId.get('total_cogs')!.cumulative).toBe(880_000 - 255_200);
    // Subtotal übernimmt Engine-Wert und stimmt mit der Kette überein
    expect(byId.get('gross_profit_1')!.cumulative).toBe(624_800);
    expect(byId.get('ebit')!.cumulative).toBe(96_000);
    // Letzte Stufe ist EBIT — kein Jahresgewinn
    expect(a.waterfall.steps[a.waterfall.steps.length - 1].id).toBe('ebit');
  });
  it('fehlende Stufe → complete=false, Werte bleiben null (nie 0 erfinden)', () => {
    const noDepr = makeYear(2025, {
      revenue_total: 110_000, net_revenue: 110_000, total_cogs: 31_900,
      gross_profit_1: 78_100, total_personnel: 45_100, gross_profit_2: 33_000,
      total_opex: 16_000, ebitda: 17_000, ebit: 12_000,
    }, 8);
    const a = buildBankInvestorAnalysis([BASE_2024, noDepr], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    const depr = a.waterfall.steps.find(s => s.id === 'total_depreciation')!;
    expect(depr.value).toBeNull();
    expect(a.waterfall.complete).toBe(false);
  });
});

describe('P6 EBIT-Treiberanalyse', () => {
  it('Beiträge summieren sich exakt zur EBIT-Veränderung (Residual 0)', () => {
    const a = buildThreeYears();
    const d = a.ebitDrivers;
    expect(d.baseYear).toBe(2024);
    expect(d.currentYear).toBe(2025);
    expect(d.ebitDelta).toBe(16_000);
    const byId = new Map(d.drivers.map(x => [x.id, x]));
    expect(byId.get('umsatz')!.contribution).toBe(80_000);
    expect(byId.get('waren')!.contribution).toBe(-15_200);
    expect(byId.get('personal')!.contribution).toBe(-40_800);
    expect(byId.get('uebrig')!.contribution).toBe(-8_000);
    expect(byId.get('abschreibungen')!.contribution).toBeCloseTo(0);
    expect(d.residual).toBeCloseTo(0);
    expect(d.complete).toBe(true);
    // %-Wirkung relativ zu |Basis-EBIT|
    expect(byId.get('umsatz')!.pctOfBaseEbit).toBeCloseTo(100);
  });
});

describe('P7 Kennzahlenhistorie', () => {
  it('volle Jahressummen, Teiljahre mit complete=false markiert (nie geschätzt)', () => {
    const a = buildThreeYears();
    expect(a.historie.map(h => h.id)).toEqual([
      'umsatz', 'warenquote', 'personalquote', 'bruttomarge', 'ebit', 'ebit_marge',
    ]);
    const umsatz = a.historie.find(h => h.id === 'umsatz')!;
    expect(umsatz.points).toEqual([
      { year: 2023, value: 1_080_000, complete: true },
      { year: 2024, value: 1_200_000, complete: true },
      { year: 2025, value: 880_000, complete: false },
    ]);
    const marge = a.historie.find(h => h.id === 'ebit_marge')!;
    expect(marge.points[2].value).toBeCloseTo((96_000 / 880_000) * 100);
  });
});

describe('P8 Benchmark', () => {
  it('Vorzeichen: positiv = besser als Ziel; Ampel mit Toleranzband', () => {
    const a = buildThreeYears();
    const byId = new Map(a.benchmarks.map(b => [b.id, b]));
    expect(a.benchmarks.map(b => b.id)).toEqual(BANK_BENCHMARKS.map(b => b.id));
    const ware = byId.get('warenquote')!;   // 29 % < Ziel 30 % → +1 pp besser
    expect(ware.ist).toBeCloseTo(29);
    expect(ware.abweichungPp).toBeCloseTo(1);
    expect(ware.tone).toBe('good');
    const pers = byId.get('personalquote')!; // 41 % > Ziel 35 % → −6 pp
    expect(pers.abweichungPp).toBeCloseTo(-6);
    expect(pers.tone).toBe('critical');
    const ebitda = byId.get('ebitda_marge')!; // 15.45 % > 15 %
    expect(ebitda.tone).toBe('good');
  });
  it('knapp verfehlt (innerhalb Toleranz) → neutral; fehlende Daten → null/neutral', () => {
    // Warenquote 30.5 % → −0.5 pp, innerhalb BANK_BENCHMARK_TOLERANCE_PP
    const knapp = makeYear(2025, {
      revenue_total: 100_000, net_revenue: 100_000, total_cogs: 30_500,
      gross_profit_1: 69_500, total_personnel: 40_000, gross_profit_2: 29_500,
      total_opex: 15_000, ebitda: 14_500, total_depreciation: 5_000, ebit: 9_500,
    }, 8);
    const a = buildBankInvestorAnalysis([BASE_2024, knapp], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    const ware = a.benchmarks.find(b => b.id === 'warenquote')!;
    expect(ware.abweichungPp).toBeCloseTo(-0.5);
    expect(Math.abs(ware.abweichungPp!)).toBeLessThanOrEqual(BANK_BENCHMARK_TOLERANCE_PP);
    expect(ware.tone).toBe('neutral');
    const leer = buildBankInvestorAnalysis([makeYear(2024, {}), makeYear(2025, {}, 8)], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    expect(leer.benchmarks.every(b => b.ist == null && b.tone === 'neutral')).toBe(true);
  });
});

describe('P9 Heatmap', () => {
  it('Ø über alle Zellen, Buckets beschreibend, fehlende Monate = null', () => {
    const a = buildThreeYears();
    const umsatz = a.heatmaps.umsatz;
    // Ø = (12×90k + 12×100k + 8×110k) / 32 = 98'750
    expect(umsatz.average).toBeCloseTo(98_750);
    expect(umsatz.rows.map(r => r.year)).toEqual([2023, 2024, 2025]);
    const r2025 = umsatz.rows[2];
    expect(r2025.cells[0].value).toBe(110_000);
    expect(r2025.cells[0].bucket).toBe('deutlich_ueber'); // +11.4 % > 10 %
    expect(r2025.cells[8].value).toBeNull();              // Sep fehlt
    expect(r2025.cells[8].bucket).toBeNull();
    const r2023 = umsatz.rows[0];
    expect(r2023.cells[0].bucket).toBe('unter'); // −8.9 %
    // Quoten-Heatmap in pp: 2025 29 % vs. Ø
    const ware = a.heatmaps.warenquote;
    expect(ware.unit).toBe('pct');
    expect(ware.rows[2].cells[0].value).toBeCloseTo(29);
  });
});

describe('P10 Investor Timeline', () => {
  it('Status/Vollständigkeit je Jahr + Importdatum aus Registry (null = unbekannt)', () => {
    const a = buildThreeYears();
    expect(a.timeline.map(t => t.year)).toEqual([2023, 2024, 2025]);
    const t2025 = a.timeline[2];
    expect(t2025.monthsWithData).toBe(8);
    expect(t2025.status).toBe('teilweise');
    expect(t2025.umsatz).toBe(880_000);
    expect(t2025.importedAt).toBe('2026-07-01T10:00:00.000Z');
    const t2024 = a.timeline[1];
    expect(t2024.status).toBe('vollständig');
    expect(t2024.importedAt).toBeNull();
  });
});

describe('P11 Kernaussagen 5+5', () => {
  it('trennt positive Punkte und Potenziale, je max. 5, rein regelbasiert', () => {
    const a = buildThreeYears();
    expect(a.kernaussagenPlus.positive.length).toBeLessThanOrEqual(5);
    expect(a.kernaussagenPlus.potenziale.length).toBeLessThanOrEqual(5);
    expect(a.kernaussagenPlus.positive.some(s => s.includes('Umsatz'))).toBe(true);
    expect(a.kernaussagenPlus.positive.some(s => s.includes('Warenquote'))).toBe(true);
    expect(a.kernaussagenPlus.potenziale.some(s => s.includes('Personalquote'))).toBe(true);
    expect(a.kernaussagenPlus.potenziale.some(s => s.includes('Personalkosten wachsen schneller'))).toBe(true);
  });
});

describe('P12 EBIT-Hinweis', () => {
  it('identischer Hinweistext an allen Stellen (USER-ENTSCHEID: Ende bei EBIT)', () => {
    const a = buildThreeYears();
    expect(a.ebitNote).toBe(EBIT_REPORT_NOTE);
    expect(a.waterfall.note).toBe(EBIT_REPORT_NOTE);
    expect(EBIT_REPORT_NOTE).toContain('EBIT');
    expect(EBIT_REPORT_NOTE).toContain('Steuern');
  });
});

// ── P13–P14: Export-Aufbereitung Phase 2 (PDF + Excel, gleiche Quelle) ───────

describe('P13 PDF-Aufbereitung Phase 2', () => {
  const a = buildThreeYears();
  const p = buildBankInvestorPdfData(a, { generatedAt: '2026-07-13T10:30:00' });
  it('Gesamttrend + Scorecard stammen 1:1 aus dem Analysis-Objekt', () => {
    expect(p.gesamtTrend.label).toBe('Gesamttrend');
    expect(p.gesamtTrend.value).toContain(a.executive.gesamtTrend.label);
    expect(p.gesamtTrend.tone).toBe(a.executive.gesamtTrend.tone);
    expect(p.scorecardTabelle.head).toEqual([
      'Kennzahl', '2023', '2024', '2025', 'Quote 2023', 'Quote 2024', 'Quote 2025', 'Δ CHF', 'Δ %', 'Trend',
    ]);
    expect(p.scorecardTabelle.rows).toHaveLength(a.scorecard.rows.length);
    // Umsatzzeile: Jahreswerte im de-CH-Format
    expect(p.scorecardTabelle.rows[0][3]).toBe((880_000).toLocaleString('de-CH'));
    expect(p.scorecardTabelle.strongRows).toContain(
      a.scorecard.rows.findIndex(r => r.id === 'ebit'),
    );
  });
  it('Waterfall: Kosten mit Minuszeichen, Subtotale fett, EBIT-Hinweis identisch', () => {
    expect(p.waterfallTabelle.titel).toContain('2025');
    const kostenIdx = a.waterfall.steps.findIndex(s => s.kind === 'cost');
    expect(p.waterfallTabelle.rows[kostenIdx][1].startsWith('−')).toBe(true);
    const subtotalIdx = a.waterfall.steps.findIndex(s => s.kind === 'subtotal');
    expect(p.waterfallTabelle.strongRows).toContain(subtotalIdx);
    expect(p.ebitHinweis).toBe(EBIT_REPORT_NOTE);
  });
  it('EBIT-Treiber, Historie (Teiljahr *), Benchmark, Timeline, Kernaussagen 5+5', () => {
    expect(p.ebitTreiberTabelle.rows).toHaveLength(a.ebitDrivers.drivers.length);
    expect(p.ebitTreiberZusammenfassung[0].label).toBe('EBIT 2024');
    // Historie: Spalten = Jahre; Teiljahr 2025 mit Stern markiert
    expect(p.historieTabelle.head).toEqual(['Kennzahl', '2023', '2024', '2025']);
    const umsatzHist = p.historieTabelle.rows[0];
    expect(umsatzHist[3].endsWith('*')).toBe(true);
    expect(umsatzHist[2].endsWith('*')).toBe(false);
    // Benchmark: eine Zeile je Definition, Bewertungstext gesetzt
    expect(p.benchmarkTabelle.rows).toHaveLength(BANK_BENCHMARKS.length);
    expect(p.benchmarkTabelle.rows.every(r => ['erfüllt', 'verfehlt', 'im Toleranzband', 'keine Daten'].includes(r[4]))).toBe(true);
    // Timeline: 3 Jahre, Importdatum formatiert, unbekannt = —
    expect(p.timelineTabelle.rows).toHaveLength(3);
    expect(p.timelineTabelle.rows[2][5]).toBe('01.07.2026');
    expect(p.timelineTabelle.rows[1][5]).toBe('—');
    // Kernaussagen 5+5
    expect(p.kernaussagenPositive).toEqual(a.kernaussagenPlus.positive);
    expect(p.kernaussagenPotenziale).toEqual(a.kernaussagenPlus.potenziale);
  });
  it('fehlende Werte bleiben — (nie 0 erfinden)', () => {
    const leer = buildBankInvestorAnalysis([BASE_2024], {
      baseYear: 2024, currentYear: 2025, untilSameMonth: true,
    });
    const p2 = buildBankInvestorPdfData(leer);
    // Neustes Jahr (2025) hat keine Daten → alle Waterfall-Stufen bleiben —
    expect(p2.waterfallTabelle.rows.every(r => r[1] === '—' && r[2] === '—')).toBe(true);
    expect(p2.timelineTabelle.rows.some(r => r[3] === '—')).toBe(true);
  });
});

describe('P14 Excel-Aufbereitung Phase 2', () => {
  const a = buildThreeYears();
  const x = buildBankInvestorExcelData(a);
  it('Übersicht trägt Gesamttrend, 9 Executive-KPIs, Kernaussagen 5+5 und EBIT-Hinweis', () => {
    const ueb = x.sheets[0];
    const flat = ueb.rows.map(r => r.map(c => c.v));
    expect(flat[0][0]).toBe('Gesamttrend');
    expect(flat[0][1]).toBe(a.executive.gesamtTrend.label);
    expect(flat.some(r => r[0] === 'Positive Entwicklungen')).toBe(true);
    expect(flat.some(r => r[0] === 'Verbesserungspotenziale')).toBe(true);
    expect(flat.some(r => r[0] === 'Hinweis' && r[1] === EBIT_REPORT_NOTE)).toBe(true);
    // 9 Executive-KPIs zwischen Titel und erster Leerzeile
    const kpiTitleIdx = flat.findIndex(r => r[0] === 'Executive-Kennzahlen');
    expect(flat.slice(kpiTitleIdx + 1, kpiTitleIdx + 1 + a.executive.kpis.length)).toHaveLength(a.executive.kpis.length);
  });
  it('Blatt Mehrjahresanalyse: Scorecard-Werte als echte Zahlen, Waterfall-Kosten negativ', () => {
    const mj = x.sheets[5];
    expect(mj.name).toBe('Mehrjahresanalyse');
    const flat = mj.rows.map(r => r.map(c => c?.v));
    // Scorecard-Kopfzeile mit allen Jahren
    const scHead = mj.rows[1].map(c => c.v);
    expect(scHead).toContain('2023');
    expect(scHead).toContain('2025');
    // Umsatzzeile = Zeile 2: 2025-Wert als echte Zahl
    expect(mj.rows[2][3].v).toBe(880_000);
    expect(mj.rows[2][3].fmt).toBe('chf');
    // Waterfall: Kostenstufe negativ als Zahl
    const wfHeadIdx = flat.findIndex(r => typeof r[0] === 'string' && (r[0] as string).startsWith('Vom Umsatz zum EBIT'));
    const kostenOffset = a.waterfall.steps.findIndex(s => s.kind === 'cost');
    const kostenRow = mj.rows[wfHeadIdx + 2 + kostenOffset];
    expect(typeof kostenRow[1].v).toBe('number');
    expect((kostenRow[1].v as number)).toBeLessThan(0);
    // Benchmark + Timeline-Blöcke vorhanden
    expect(flat.some(r => typeof r[0] === 'string' && (r[0] as string).startsWith('Benchmark-Vergleich'))).toBe(true);
    expect(flat.some(r => r[0] === 'Datenbasis je Geschäftsjahr')).toBe(true);
    expect(flat.some(r => r[0] === 'Hinweis' && r[1] === EBIT_REPORT_NOTE)).toBe(true);
    // Timeline: Importdatum formatiert
    expect(flat.some(r => r[5] === '01.07.2026')).toBe(true);
  });
  it('Historie im Excel: Teiljahr als Text mit Stern, volle Jahre als Zahl', () => {
    const mj = x.sheets[5];
    const flat = mj.rows.map(r => r.map(c => c?.v));
    const histIdx = flat.findIndex(r => typeof r[0] === 'string' && (r[0] as string).startsWith('Kennzahlenhistorie'));
    const umsatzRow = mj.rows[histIdx + 2]; // Kopf + 1. Serie (Umsatz)
    expect(umsatzRow[2].v).toBe(1_200_000);          // 2024 voll → Zahl
    expect(String(umsatzRow[3].v).endsWith('*')).toBe(true); // 2025 Teiljahr → Text mit *
  });
});
