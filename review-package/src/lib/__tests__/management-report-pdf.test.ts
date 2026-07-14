// @vitest-environment node
/**
 * Tests für den Management-Report (reine Datenaufbereitung, kein jsPDF-Render).
 */
import { describe, it, expect } from 'vitest';
import { buildMultiYearAnalysis, type YearSeries } from '../multi-year-analysis';
import {
  buildManagementReportData,
  managementReportFileName,
  pdfSafe,
} from '../management-report-pdf';

function fullYear(year: number, base: number, step = 0): YearSeries {
  return { year, values: Array.from({ length: 12 }, (_, i) => base + i * step) };
}

function halfYear(year: number, base: number): YearSeries {
  return {
    year,
    values: Array.from({ length: 12 }, (_, i) => (i < 6 ? base : null)),
  };
}

const Y24 = fullYear(2024, 100_000);
const Y25 = fullYear(2025, 110_000);
const Y26H = halfYear(2026, 130_000);

describe('pdfSafe', () => {
  it('ersetzt U+2212 (Minus) und U+00A0 (NBSP) durch WinAnsi-sichere Zeichen', () => {
    expect(pdfSafe('\u22123.1\u00a0%')).toBe('-3.1 %');
    expect(pdfSafe('normal')).toBe('normal');
  });
});

describe('managementReportFileName', () => {
  it('slugifiziert den Restaurantnamen und nennt die Jahresspanne', () => {
    expect(managementReportFileName([2023, 2024, 2025], 'Oliv Restaurant & Bar'))
      .toBe('management-report_oliv-restaurant-bar_2023-2025.pdf');
    expect(managementReportFileName([], undefined))
      .toBe('management-report_restaurant_ohne-daten.pdf');
  });
});

describe('buildManagementReportData', () => {
  const analysis = buildMultiYearAnalysis([Y24, Y25, Y26H]);
  const data = buildManagementReportData(analysis, {
    restaurantName: 'Oliv',
    generatedAt: '2026-07-13T10:30:00',
  });

  it('setzt Titel, Spanne, Restaurant und Zeitstempel', () => {
    expect(data.titel).toContain('Mehrjahresanalyse');
    expect(data.untertitel).toBe('Vergleichszeitraum 2024–2026');
    expect(data.restaurantName).toBe('Oliv');
    expect(data.erstelltAm).toBe('13.07.2026 10:30');
    expect(data.fileName).toBe('management-report_oliv_2024-2026.pdf');
  });

  it('übernimmt Executive Summary und Hinweise 1:1 aus der Analyse', () => {
    expect(data.executiveSummary).toEqual(analysis.executiveSummary);
    expect(data.hinweise).toEqual(analysis.limitations);
  });

  it('liefert 8 Kennzahlen-Zeilen mit Wachstum und Trend', () => {
    expect(data.kpis).toHaveLength(8);
    const growth = data.kpis.find(k => k.label.startsWith('Wachstum'))!;
    expect(growth.value).toContain('%');
    const trend = data.kpis.find(k => k.label === 'Umsatztrend')!;
    expect(['Steigend', 'Rückläufig', 'Stabil', '—']).toContain(trend.value);
  });

  it('Jahresübersicht: eine Zeile pro Jahr, Basisjahr ohne Deltas, Teiljahr markiert', () => {
    expect(data.jahresUebersicht).toHaveLength(3);
    const base = data.jahresUebersicht[0];
    expect(base[0]).toBe('2024');
    expect(base[2]).toBe('—');
    expect(base[3]).toBe('—');
    const partial = data.jahresUebersicht[2];
    expect(partial[0]).toBe('2026');
    expect(partial[4]).toContain('Teiljahr');
  });

  it('Monatstabelle: 12 Monatszeilen + Total, Kopf mit allen Jahren', () => {
    expect(data.monatsTabelleHead).toEqual(['Monat', '2024', '2025', '2026', 'Δ VJ']);
    expect(data.monatsTabelle).toHaveLength(13);
    expect(data.monatsTabelle[12][0]).toBe('Total');
    // Juli 2026 ohne Daten → "—"
    expect(data.monatsTabelle[6][3]).toBe('—');
  });

  it('Jahresdetails: ein Block pro Jahr mit Top-/Flop-Monaten und Quartalen', () => {
    expect(data.jahresDetails).toHaveLength(3);
    for (const jd of data.jahresDetails) {
      expect(jd.zeilen.map(z => z.label)).toEqual(['Top-Monate', 'Schwächste Monate', 'Quartalsanteile']);
    }
    expect(data.jahresDetails[2].titel).toContain('Teiljahr');
  });
});
