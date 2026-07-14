// @vitest-environment node
/**
 * Export = UI (§10/§12 der 2024-Spec): Mehrjahres-Excel und Management-Report-PDF
 * konsumieren DASSELBE cmp-Objekt (buildYearKpiComparison) wie die UI —
 * keine separate Exportberechnung.
 *
 * Geprüft: Blatt „Jahresvergleich" (Werte = cmp-Rohwerte, pp-Spalten,
 * Teiljahr-Kennzeichnung, EBIT-Hinweis wörtlich identisch, Insights),
 * PDF-Aufbereitung (Zellen über dieselben zentralen Formatierer wie die UI),
 * fehlend ≠ 0 („—" statt 0), ohne cmp keine Sektion.
 */
import { describe, expect, it } from 'vitest';

import {
  buildMultiYearAnalysis,
  buildYearKpiComparison,
  buildPersonnelInsights,
  fmtChf, fmtPct, fmtDeltaChf, fmtPpSigned, fmtQuotePct,
  type YearSeries,
} from '@/lib/multi-year-analysis';
import { buildMultiYearExcelData, type ExcelCell } from '@/lib/multi-year-excel';
import { buildManagementReportData } from '@/lib/management-report-pdf';
import { EBIT_REPORT_NOTE } from '@/lib/bank-investor-analysis';

// ─── Fixtures (wie year-kpi-comparison.test.ts) ───────────────────────────────

function mkSeries(year: number, months: number, r: number, p: number): YearSeries {
  const val = (v: number): (number | null)[] =>
    Array.from({ length: 12 }, (_, m) => (m < months ? v : null));
  return {
    year,
    values: val(r),
    byPosition: {
      net_revenue: val(r),
      total_cogs: val(r * 0.3),
      gross_profit_1: val(r * 0.7),
      total_personnel: val(p),
      personnel_wages: val(p * 0.8),
      personnel_social: val(p * 0.15),
      personnel_other: val(p * 0.05),
      ebitda: val(r * 0.2),
      ebit: val(r * 0.15),
    },
  };
}

const S2024 = mkSeries(2024, 12, 100_000, 36_000);
const S2025 = mkSeries(2025, 12, 110_000, 37_800);
const S2026H1 = mkSeries(2026, 6, 120_000, 40_000);
const SERIES = [S2024, S2025, S2026H1];
const YEARS = [2024, 2025, 2026];

const cmp = buildYearKpiComparison(SERIES, YEARS);
const insights = buildPersonnelInsights(cmp);
const analysis = buildMultiYearAnalysis(SERIES);

const cellNum = (c: ExcelCell): number | null => (typeof c.v === 'number' ? c.v : null);

// ─── Excel ────────────────────────────────────────────────────────────────────

describe('Mehrjahres-Excel — Blatt „Jahresvergleich" = cmp-Objekt', () => {
  const data = buildMultiYearExcelData(analysis, {
    restaurantName: 'Oliv',
    yearComparison: cmp,
    personnelInsights: insights,
  });
  const sheet = data.sheets.find(s => s.name === 'Jahresvergleich');

  it('Blatt existiert direkt nach der Übersicht', () => {
    expect(sheet).toBeDefined();
    expect(data.sheets.indexOf(sheet!)).toBe(1);
  });

  it('Jahreswerte in den Zeilen sind exakt die cmp-Rohwerte (keine Zweitberechnung)', () => {
    for (const r of cmp.rows) {
      const excelRow = sheet!.rows.find(cells => cells[0]?.v === r.def.label);
      expect(excelRow, r.def.label).toBeDefined();
      r.valueByYear.forEach((v, i) => {
        expect(cellNum(excelRow![1 + i]), `${r.def.label} ${cmp.years[i]}`).toBe(v);
      });
    }
  });

  it('Δ-Spalten tragen cmp-Deltas: CHF/% bei CHF-Zeilen, pp bei Quoten-Zeilen', () => {
    const nYears = cmp.years.length;
    for (const r of cmp.rows) {
      const excelRow = sheet!.rows.find(cells => cells[0]?.v === r.def.label)!;
      r.deltas.forEach((d, i) => {
        const base = 1 + nYears + i * 2;
        if (r.def.kind === 'quote') {
          expect(cellNum(excelRow[base])).toBeNull();
          expect(cellNum(excelRow[base + 1])).toBe(d.pp);
          expect(excelRow[base + 1].fmt).toBe('pp');
        } else {
          expect(cellNum(excelRow[base])).toBe(d.chf);
          expect(cellNum(excelRow[base + 1])).toBe(d.pct);
        }
      });
    }
  });

  it('Teiljahr 2026 ist im Kopf markiert, Hinweise enthalten Common-Month + EBIT-Note wörtlich', () => {
    expect(sheet!.head[3]).toBe('2026 *');
    const hintTexts = sheet!.rows.map(cells => String(cells[0]?.v ?? ''));
    expect(hintTexts.some(t => t.includes('Teiljahr') && t.includes('keine Hochrechnung'))).toBe(true);
    expect(hintTexts.some(t => t.includes(EBIT_REPORT_NOTE))).toBe(true);
  });

  it('Personalkosten-Aussagen (identisch zur UI-HintBox) sind enthalten', () => {
    const hintTexts = sheet!.rows.map(cells => String(cells[0]?.v ?? ''));
    for (const s of insights) {
      expect(hintTexts.some(t => t.includes(s)), s).toBe(true);
    }
  });

  it('Autofilter deckt nur die Kennzahlen-Zeilen ab (filterRows)', () => {
    expect(sheet!.filterRows).toBe(cmp.rows.length);
    expect(sheet!.rows.length).toBeGreaterThan(cmp.rows.length);
  });

  it('ohne cmp entsteht KEIN Jahresvergleichs-Blatt', () => {
    const plain = buildMultiYearExcelData(analysis, { restaurantName: 'Oliv' });
    expect(plain.sheets.find(s => s.name === 'Jahresvergleich')).toBeUndefined();
  });
});

// ─── PDF ──────────────────────────────────────────────────────────────────────

describe('Management-Report-PDF — Jahresvergleich = cmp-Objekt (zentrale Formatierer)', () => {
  const data = buildManagementReportData(analysis, {
    restaurantName: 'Oliv',
    yearComparison: cmp,
    personnelInsights: insights,
  });

  it('Zeilen sind exakt die cmp-Werte durch dieselben Formatierer wie die UI', () => {
    const nYears = cmp.years.length;
    for (const r of cmp.rows) {
      const pdfRow = data.jahresvergleich.find(cells => cells[0] === r.def.label);
      expect(pdfRow, r.def.label).toBeDefined();
      r.valueByYear.forEach((v, i) => {
        const expected = r.def.kind === 'quote' ? fmtQuotePct(v) : fmtChf(v);
        expect(pdfRow![1 + i]).toBe(expected);
      });
      r.deltas.forEach((d, i) => {
        const expected = r.def.kind === 'quote'
          ? fmtPpSigned(d.pp)
          : d.chf == null ? '—' : `${fmtDeltaChf(d.chf)} (${fmtPct(d.pct)})`;
        expect(pdfRow![1 + nYears + i]).toBe(expected);
      });
    }
  });

  it('Kopf markiert das Teiljahr; Hinweise enthalten EBIT-Note wörtlich + Teiljahr-Hinweis', () => {
    expect(data.jahresvergleichHead).toContain('2026 *');
    expect(data.jahresvergleichHinweise).toContain(EBIT_REPORT_NOTE);
    expect(data.jahresvergleichHinweise.some(h => h.includes('keine Hochrechnung'))).toBe(true);
  });

  it('keine Jahresgewinn-Zeile — der Vergleich endet bei EBIT/EBIT-Marge', () => {
    const labels = data.jahresvergleich.map(r => r[0]);
    expect(labels.some(l => /Jahresgewinn/i.test(String(l)))).toBe(false);
    expect(labels.some(l => /EBIT/.test(String(l)))).toBe(true);
  });

  it('Personalkosten-Aussagen identisch zur UI', () => {
    expect(data.personalEntwicklung).toEqual(insights);
  });

  it('ohne cmp bleiben Sektion und Hinweise leer', () => {
    const plain = buildManagementReportData(analysis, { restaurantName: 'Oliv' });
    expect(plain.jahresvergleich).toHaveLength(0);
    expect(plain.jahresvergleichHead).toHaveLength(0);
    expect(plain.jahresvergleichHinweise).toHaveLength(0);
    expect(plain.personalEntwicklung).toHaveLength(0);
  });

  it('fehlende Werte erscheinen als „—", nie als 0 (fehlend ≠ 0)', () => {
    const sparse = [mkSeries(2024, 12, 100_000, 36_000), {
      ...mkSeries(2025, 12, 110_000, 37_800),
      byPosition: {
        ...mkSeries(2025, 12, 110_000, 37_800).byPosition,
        ebitda: Array.from({ length: 12 }, () => null),
      },
    }];
    const cmp2 = buildYearKpiComparison(sparse, [2024, 2025]);
    const d2 = buildManagementReportData(buildMultiYearAnalysis(sparse), { yearComparison: cmp2 });
    const ebitdaRow = d2.jahresvergleich.find(r => r[0] === 'EBITDA');
    if (ebitdaRow) {
      expect(ebitdaRow[2]).toBe('—');
      expect(ebitdaRow[2]).not.toBe(fmtChf(0));
    }
  });
});
