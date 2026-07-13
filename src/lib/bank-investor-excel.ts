/**
 * Excel-Export „Mehrjahresanalyse <Basis>–<Aktuell>" (Banken-/Investorensicht)
 * =============================================================================
 * Zweistufig (Muster: multi-year-excel.ts):
 *   1) buildBankInvestorExcelData — REINE Aufbereitung (DOM-/exceljs-frei,
 *      node-testbar). Quelle ist AUSSCHLIESSLICH das BankInvestorAnalysis-
 *      Objekt — exakt dieselben Zahlen wie Bildschirm & PDF.
 *   2) exportBankInvestorToExcel — dünner exceljs-IO-Wrapper (dynamischer
 *      Import, Browser-Download).
 *
 * Blätter (Spez. H): Übersicht · Monatsvergleich · Erfolgsrechnung <Basisjahr>
 * · Erfolgsrechnung <Aktuelljahr> · Kennzahlen und Margen · Datenqualität.
 *
 * Zahlen als ECHTE Zahlen (nicht Text); Prozent als Excel-Prozentformat;
 * CHF im Schweizer Zahlenformat (numFmt).
 */

import type { BankInvestorAnalysis } from './bank-investor-analysis';
import { MONTH_LABELS_LONG } from './multi-year-analysis';

const SEVERITY_LABEL: Record<string, string> = {
  fehler: 'Fehler',
  warnung: 'Warnung',
  hinweis: 'Hinweis',
};

export type BankExcelCellFmt = 'chf' | 'pct';

export interface BankExcelCell {
  v: string | number | null;
  fmt?: BankExcelCellFmt;
  strong?: boolean;
}

export interface BankExcelSheet {
  name: string;
  title: string;
  subtitle: string;
  head: string[];
  rows: BankExcelCell[][];
  widths: number[];
}

export interface BankInvestorExcelData {
  sheets: BankExcelSheet[];
  fileName: string;
}

export function bankInvestorExcelFileName(baseYear: number, currentYear: number, restaurantName?: string): string {
  const slug = (restaurantName ?? 'Restaurant').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `Mehrjahresanalyse_${slug || 'Restaurant'}_${baseYear}-${currentYear}.xlsx`;
}

const t = (v: string, strong = false): BankExcelCell => ({ v, strong });
const chf = (v: number | null, strong = false): BankExcelCell => ({ v, fmt: 'chf', strong });
const pct = (v: number | null, strong = false): BankExcelCell => ({ v, fmt: 'pct', strong });

/** REINE Aufbereitung aller 6 Blätter aus dem Analysis-Objekt. */
export function buildBankInvestorExcelData(analysis: BankInvestorAnalysis): BankInvestorExcelData {
  const { baseYear, currentYear, header, kpis, comparison } = analysis;
  const subtitle = `${header.restaurantName} · ${comparison.label}`;

  // ── Blatt 1: Übersicht ──────────────────────────────────────────────────────
  const uebersichtRows: BankExcelCell[][] = [
    [t('Executive-Kennzahlen', true)],
    ...kpis.map(k => [t(k.label), t(k.value), t(k.delta)]),
    [],
    [t('Kernaussagen', true)],
    ...analysis.kernaussagen.map(s => [t(`• ${s}`)]),
  ];

  // ── Blatt 2: Monatsvergleich (Spez. H, Mindestspalten) ──────────────────────
  const monatHead = [
    'Monat',
    `Umsatz ${baseYear}`, `Umsatz ${currentYear}`, 'Umsatz Diff', 'Umsatz Diff %',
    `Warenaufwand ${baseYear}`, `Warenaufwand ${currentYear}`,
    `Warenquote ${baseYear}`, `Warenquote ${currentYear}`,
    `Personalaufwand ${baseYear}`, `Personalaufwand ${currentYear}`,
    `Personalquote ${baseYear}`, `Personalquote ${currentYear}`,
    `EBIT ${baseYear}`, `EBIT ${currentYear}`,
  ];
  const ebitBaseArr = ebitByMonth(analysis, 'base');
  const ebitCurArr = ebitByMonth(analysis, 'current');
  const monatRows: BankExcelCell[][] = analysis.revenueMonths.map((rev, i) => {
    const ware = analysis.wareMonths[i];
    const pers = analysis.personalMonths[i];
    return [
      t(MONTH_LABELS_LONG[rev.monthIdx]),
      chf(rev.base), chf(rev.current), chf(rev.diffChf), pct(rev.diffPct),
      chf(ware?.base ?? null), chf(ware?.current ?? null),
      pct(ware?.baseQuote ?? null), pct(ware?.currentQuote ?? null),
      chf(pers?.base ?? null), chf(pers?.current ?? null),
      pct(pers?.baseQuote ?? null), pct(pers?.currentQuote ?? null),
      chf(ebitBaseArr[i] ?? null), chf(ebitCurArr[i] ?? null),
    ];
  });

  // ── Blätter 3+4: Erfolgsrechnung je Jahr ────────────────────────────────────
  const erSheet = (which: 'base' | 'current', year: number): BankExcelSheet => ({
    name: `ER ${year}`,
    title: `Erfolgsrechnung ${year}`,
    subtitle,
    head: ['Position', 'CHF', 'Anteil am Umsatz'],
    rows: analysis.positionRows.map(r => [
      t(r.label, r.emphasis),
      chf(which === 'base' ? r.base : r.current, r.emphasis),
      pct(which === 'base' ? r.baseQuote : r.currentQuote, r.emphasis),
    ]),
    widths: [34, 16, 18],
  });

  // ── Blatt 5: Kennzahlen und Margen ──────────────────────────────────────────
  const kennzahlenHead = [
    'Kennzahl', `${baseYear}`, `${currentYear}`, 'Veränderung CHF', 'Veränderung %',
    `Quote ${baseYear}`, `Quote ${currentYear}`, 'Veränderung Quote (pp)',
  ];
  const kennzahlenRows: BankExcelCell[][] = analysis.totalsRows.map(r => [
    t(r.label, r.emphasis),
    chf(r.base, r.emphasis), chf(r.current, r.emphasis),
    chf(r.diffChf), pct(r.diffPct),
    pct(r.baseQuote), pct(r.currentQuote), pct(r.quotePp),
  ]);

  // ── Blatt 6: Datenqualität ──────────────────────────────────────────────────
  const dqRows: BankExcelCell[][] = analysis.dataQuality.length > 0
    ? analysis.dataQuality.map(d => [t(SEVERITY_LABEL[d.severity] ?? d.severity), t(d.text)])
    : [[t('—'), t('Keine Datenqualitätshinweise.')]];

  return {
    fileName: bankInvestorExcelFileName(baseYear, currentYear, header.restaurantName),
    sheets: [
      { name: 'Übersicht', title: header.title, subtitle, head: [], rows: uebersichtRows, widths: [36, 26, 26] },
      { name: 'Monatsvergleich', title: `Monatsvergleich ${baseYear} vs. ${currentYear}`, subtitle, head: monatHead, rows: monatRows, widths: [12, ...Array(14).fill(15)] },
      erSheet('base', baseYear),
      erSheet('current', currentYear),
      { name: 'Kennzahlen und Margen', title: 'Zwischentotale und Margen', subtitle, head: kennzahlenHead, rows: kennzahlenRows, widths: [30, 15, 15, 15, 13, 13, 13, 18] },
      { name: 'Datenqualität', title: 'Datenqualität und Importstand', subtitle, head: ['Schweregrad', 'Hinweis'], rows: dqRows, widths: [14, 90] },
    ],
  };
}

/** EBIT-Monatswerte aus dem Analysis-Objekt (positionRows sind Jahreswerte). */
function ebitByMonth(analysis: BankInvestorAnalysis, which: 'base' | 'current'): (number | null)[] {
  // Die Monatsreihen tragen nur Umsatz/Waren/Personal; EBIT je Monat steckt in
  // den Rohserien nicht im Analysis-Objekt — bewusst: der Monats-EBIT wird über
  // ebitMonths (unten) mitgeliefert, sofern vorhanden.
  const arr = which === 'base' ? analysis.ebitMonthsBase : analysis.ebitMonthsCurrent;
  if (!arr) return analysis.revenueMonths.map(() => null);
  return analysis.revenueMonths.map(p => arr[p.monthIdx] ?? null);
}

// ── IO-Wrapper (Browser) ──────────────────────────────────────────────────────

export async function exportBankInvestorToExcel(analysis: BankInvestorAnalysis): Promise<void> {
  const data = buildBankInvestorExcelData(analysis);
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Personalkostentracker';
  wb.created = new Date();

  for (const sheet of data.sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));
    sheet.widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    const titleRow = ws.addRow([sheet.title]);
    titleRow.font = { bold: true, size: 14 };
    const subRow = ws.addRow([sheet.subtitle]);
    subRow.font = { size: 10, color: { argb: 'FF666666' } };
    ws.addRow([]);

    if (sheet.head.length > 0) {
      const headRow = ws.addRow(sheet.head);
      headRow.font = { bold: true, size: 10 };
      headRow.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        c.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } };
      });
    }

    for (const row of sheet.rows) {
      const xl = ws.addRow(row.map(c => {
        if (c.v == null) return null;
        if (c.fmt === 'pct' && typeof c.v === 'number') return c.v / 100; // Excel-Prozentformat
        return c.v;
      }));
      row.forEach((c, i) => {
        const cell = xl.getCell(i + 1);
        if (c.strong) cell.font = { bold: true };
        if (c.fmt === 'chf') cell.numFmt = '#,##0.00';
        if (c.fmt === 'pct') cell.numFmt = '0.0%';
      });
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = data.fileName;
  a.click();
  URL.revokeObjectURL(url);
}
