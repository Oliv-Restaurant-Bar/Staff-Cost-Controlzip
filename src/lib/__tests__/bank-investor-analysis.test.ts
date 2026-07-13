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
  it('liefert die 6 Blätter der Spezifikation', () => {
    expect(x.sheets.map(s => s.name)).toEqual([
      'Übersicht', 'Monatsvergleich', 'ER 2024', 'ER 2025', 'Kennzahlen und Margen', 'Datenqualität',
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
