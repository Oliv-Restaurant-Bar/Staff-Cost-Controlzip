// @vitest-environment node
/**
 * Tests für den Mehrjahres-Excel-Export (reine Aufbereitung, kein exceljs-IO).
 */
import { describe, it, expect } from 'vitest';
import { buildMultiYearAnalysis, type YearSeries } from '../multi-year-analysis';
import {
  buildMultiYearExcelData,
  multiYearExcelFileName,
} from '../multi-year-excel';

function fullYear(year: number, base: number, step = 0): YearSeries {
  return { year, values: Array.from({ length: 12 }, (_, i) => base + i * step) };
}

const Y24 = fullYear(2024, 100_000);
const Y25 = fullYear(2025, 110_000);

describe('multiYearExcelFileName', () => {
  it('nennt Restaurant und Jahresspanne', () => {
    expect(multiYearExcelFileName([2024, 2025], 'Oliv')).toBe('Mehrjahresanalyse_Oliv_2024-2025.xlsx');
    expect(multiYearExcelFileName([], undefined)).toBe('Mehrjahresanalyse_Restaurant_ohne-Daten.xlsx');
  });
});

describe('buildMultiYearExcelData', () => {
  const analysis = buildMultiYearAnalysis([Y24, Y25]);
  const data = buildMultiYearExcelData(analysis, { restaurantName: 'Oliv' });

  it('liefert genau 7 Blätter in fester Reihenfolge', () => {
    expect(data.sheets.map(s => s.name)).toEqual([
      'Übersicht', 'Monatsvergleich', 'Jahresanalyse', 'Wachstum', 'Rohdaten',
      'ER-Positionen', 'Datenqualität',
    ]);
    expect(data.fileName).toBe('Mehrjahresanalyse_Oliv_2024-2025.xlsx');
  });

  it('Übersicht: kein Tabellenkopf, enthält Kennzahlen/Summary/Hinweise-Abschnitte', () => {
    const s = data.sheets[0];
    expect(s.head).toEqual([]);
    const labels = s.rows.map(r => (r[0]?.v ?? '') as string);
    expect(labels).toContain('Kennzahlen');
    expect(labels).toContain('Executive Summary');
    expect(labels).toContain('Hinweise zur Datenbasis');
  });

  it('Monatsvergleich: 12 Monate + Total, CHF-Zellen numerisch formatiert', () => {
    const s = data.sheets[1];
    expect(s.head).toEqual(['Monat', '2024 CHF', '2025 CHF', 'Δ VJ CHF', 'Δ VJ %', 'Δ Basisjahr 2024 %']);
    expect(s.rows).toHaveLength(13);
    const jan = s.rows[0];
    expect(jan[1]).toMatchObject({ v: 100_000, fmt: 'chf' });
    expect(jan[2]).toMatchObject({ v: 110_000, fmt: 'chf' });
    expect(jan[3]).toMatchObject({ v: 10_000, fmt: 'chf' });
    expect(jan[4]).toMatchObject({ v: 10, fmt: 'pct' });
    const total = s.rows[12];
    expect(total[0]).toMatchObject({ v: 'Total', strong: true });
    expect(total[1]).toMatchObject({ v: 1_200_000, fmt: 'chf' });
    expect(total[2]).toMatchObject({ v: 1_320_000, fmt: 'chf' });
  });

  it('Jahresanalyse: eine Zeile pro Jahr, Basisjahr ohne Deltas', () => {
    const s = data.sheets[2];
    expect(s.rows).toHaveLength(2);
    expect(s.rows[0][0].v).toBe('2024');
    expect(s.rows[0][4].v).toBeNull(); // Δ VJ des Basisjahrs
    expect(s.rows[1][4]).toMatchObject({ v: 10, fmt: 'pct' });
    // Quartalsanteile vorhanden (Q1–Q4)
    expect(s.head.slice(8)).toEqual(['Q1 %', 'Q2 %', 'Q3 %', 'Q4 %']);
  });

  it('Wachstum: Zeilen entsprechen den Wasserfall-Einträgen inkl. Total', () => {
    const s = data.sheets[3];
    expect(s.rows).toHaveLength(analysis.chart.waterfall.length);
    const last = s.rows[s.rows.length - 1];
    expect(last[0].strong).toBe(true);
  });

  it('ER-Positionen: Zeilen aus positionsOverview, analysierte Position fett', () => {
    const withOverview = buildMultiYearExcelData(analysis, {
      restaurantName: 'Oliv',
      positionsOverview: [
        {
          position: { id: 'net_revenue', label: 'Umsatz (netto)', summarySubject: 'Der Umsatz', semantics: 'revenue' },
          totals: buildMultiYearAnalysis([Y24, Y25]).totals,
        },
      ],
    });
    const s = withOverview.sheets[5];
    expect(s.name).toBe('ER-Positionen');
    expect(s.head[0]).toBe('Position');
    expect(s.head).toContain('2024 CHF');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0][0]).toMatchObject({ v: 'Umsatz (netto)', strong: true });
    // Ohne positionsOverview bleibt das Blatt vorhanden, aber leer
    expect(data.sheets[5].rows).toHaveLength(0);
  });

  it('Datenqualität: Schweregrad-Zeilen, ohne Auffälligkeiten Platzhalter', () => {
    const s = data.sheets[6];
    expect(s.name).toBe('Datenqualität');
    expect(s.head).toEqual(['Schweregrad', 'Hinweis']);
    // Y24/Y25 sind vollständige Jahre → keine DQ-Einträge → Platzhalterzeile
    expect(s.rows).toHaveLength(1);
    expect(String(s.rows[0][1].v)).toContain('Keine Auffälligkeiten');

    // Teiljahr erzeugt mindestens einen Hinweis mit Schweregrad-Label
    const partial: YearSeries = {
      year: 2026,
      values: Array.from({ length: 12 }, (_, i) => (i < 6 ? 120_000 : null)),
    };
    const dq = buildMultiYearExcelData(buildMultiYearAnalysis([Y24, Y25, partial]), {}).sheets[6];
    expect(dq.rows.length).toBeGreaterThan(0);
    const severities = dq.rows.map(r => String(r[0].v));
    expect(severities.some(x => ['Hinweis', 'Warnung', 'Fehler'].includes(x))).toBe(true);
  });

  it('Rohdaten: Jahre × 12 Monate mit Rang und Jahresanteil', () => {
    const s = data.sheets[4];
    expect(s.rows).toHaveLength(24);
    expect(s.rows[0][0].v).toBe('2024');
    expect(s.rows[0][1].v).toBe('Januar');
    expect(s.rows[0][2]).toMatchObject({ v: 100_000, fmt: 'chf' });
    expect(s.rows[23][0].v).toBe('2025');
    expect(s.rows[23][1].v).toBe('Dezember');
  });
});
