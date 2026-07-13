/**
 * multi-year-excel — Excel-Export der Mehrjahresanalyse (5 Blätter)
 * =============================================================================
 * Zweistufig (Muster: warenkosten-export.ts):
 *   1) buildMultiYearExcelData — REINE Aufbereitung (DOM-/exceljs-frei,
 *      node-testbar): alle 5 Blätter als Zellen-Matrizen mit Format-Hints.
 *   2) exportMultiYearToExcel — dünner exceljs-IO-Wrapper (dynamischer Import,
 *      Download via Blob). Quelle ist AUSSCHLIESSLICH das MultiYearAnalysis-
 *      Objekt — keine Zweitberechnungen.
 *
 * Blätter: Übersicht (KPIs + Executive Summary + Hinweise) · Monatsvergleich ·
 * Jahresanalyse · Wachstum (Wasserfall-Daten) · Rohdaten.
 *
 * Zahlenformate: Schweizer Darstellung über exceljs-numFmt
 * (CHF `#,##0.00`, Prozent `0.0"%"`). Die reine Lib rundet NICHT.
 */

import {
  MONTH_LABELS_LONG,
  fmtPct,
  type MultiYearAnalysis,
} from './multi-year-analysis';

// ─── Aufbereitete Daten (rein) ────────────────────────────────────────────────

export type ExcelCellFmt = 'chf' | 'pct';

export interface ExcelCell {
  v: string | number | null;
  fmt?: ExcelCellFmt;
  /** fett (z. B. Total-Zeile, Abschnittstitel im Übersicht-Blatt) */
  strong?: boolean;
}

export interface ExcelSheetData {
  /** Blattname (Excel-Tab, max. 31 Zeichen, keine Sonderzeichen) */
  name: string;
  title: string;
  subtitle: string;
  /** Kopfzeile; leer = Blatt ohne Tabellenkopf (Übersicht) */
  head: string[];
  rows: ExcelCell[][];
  widths: number[];
}

export interface MultiYearExcelData {
  sheets: ExcelSheetData[];
  fileName: string;
}

export function multiYearExcelFileName(years: number[], restaurantName?: string): string {
  const slug = (restaurantName ?? 'Restaurant').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const span = years.length > 0 ? `${years[0]}-${years[years.length - 1]}` : 'ohne-Daten';
  return `Mehrjahresanalyse_${slug || 'Restaurant'}_${span}.xlsx`;
}

const t = (v: string, strong = false): ExcelCell => ({ v, strong });
const chf = (v: number | null, strong = false): ExcelCell => ({ v, fmt: 'chf', strong });
const pct = (v: number | null, strong = false): ExcelCell => ({ v, fmt: 'pct', strong });

/** REINE Aufbereitung aller 5 Blätter aus dem Analysis-Objekt. */
export function buildMultiYearExcelData(
  analysis: MultiYearAnalysis,
  opts: { restaurantName?: string } = {},
): MultiYearExcelData {
  const { years, baseYear, kpis, totals, monthRows, yearSummaries, chart } = analysis;
  const restaurantName = opts.restaurantName ?? 'Restaurant';
  const span = years.length > 0 ? `${years[0]}–${years[years.length - 1]}` : '—';
  const subtitle = `${restaurantName} · Vergleichszeitraum ${span}`;

  // ── Blatt 1: Übersicht ──────────────────────────────────────────────────────
  const uebersichtRows: ExcelCell[][] = [
    [t('Kennzahlen', true)],
    [t(`Umsatz ${kpis.latestYear ?? '—'}${kpis.latestYearPartialLabel ? ` (${kpis.latestYearPartialLabel})` : ''}`), chf(kpis.latestYearRevenue)],
    [t(`Wachstum vs. ${kpis.prevYear ?? 'Vorjahr'}`), pct(kpis.growthPct)],
    [t('Wachstum CHF (gemeinsame Monate)'), chf(kpis.growthChf)],
    [t(kpis.cagrFromYear != null ? `CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear} (volle Jahre)` : 'CAGR'), pct(kpis.cagrPct)],
    [t('Ø monatliches Wachstum'), pct(kpis.avgMonthlyGrowthPct)],
    [t(`Bester Monat ${kpis.latestYear ?? ''}`.trim()), t(kpis.bestMonth ? kpis.bestMonth.label : '—'), chf(kpis.bestMonth?.value ?? null)],
    [t(`Schwächster Monat ${kpis.latestYear ?? ''}`.trim()), t(kpis.worstMonth ? kpis.worstMonth.label : '—'), chf(kpis.worstMonth?.value ?? null)],
    [t('Bestes Jahresergebnis'), t(kpis.highestAnnual ? `${kpis.highestAnnual.year}${kpis.highestAnnual.isPartial ? ' (Teiljahr)' : ''}` : '—'), chf(kpis.highestAnnual?.total ?? null)],
    [t('Umsatztrend'), t(kpis.trend === 'steigend' ? 'Steigend' : kpis.trend === 'ruecklaeufig' ? 'Rückläufig' : kpis.trend === 'stabil' ? 'Stabil' : '—')],
    [],
    [t('Executive Summary', true)],
    ...analysis.executiveSummary.map(s => [t(`• ${s}`)]),
    [],
    [t('Hinweise zur Datenbasis', true)],
    ...analysis.limitations.map(s => [t(`• ${s}`)]),
  ];

  // ── Blatt 2: Monatsvergleich ────────────────────────────────────────────────
  const lastIdx = years.length - 1;
  const monatsHead = [
    'Monat',
    ...years.map(y => `${y} CHF`),
    'Δ VJ CHF',
    'Δ VJ %',
    `Δ Basisjahr ${baseYear ?? ''} %`.replace('  ', ' '),
  ];
  const monatsRows: ExcelCell[][] = monthRows.map(row => {
    const last = row.cells[lastIdx];
    return [
      t(row.label),
      ...row.cells.map(c => chf(c.value)),
      chf(last?.vsPrevYear.chf ?? null),
      pct(last?.vsPrevYear.pct ?? null),
      pct(last?.vsBaseYear.pct ?? null),
    ];
  });
  const lastTotal = totals[totals.length - 1];
  monatsRows.push([
    t('Total', true),
    ...totals.map(tc => chf(tc.total, true)),
    chf(lastTotal?.vsPrevYearCommon.chf ?? null, true),
    pct(lastTotal?.vsPrevYearCommon.pct ?? null, true),
    pct(lastTotal?.vsBaseYearCommon.pct ?? null, true),
  ]);

  // ── Blatt 3: Jahresanalyse ──────────────────────────────────────────────────
  const jahresHead = [
    'Jahr', 'Nettoumsatz CHF', 'Datenmonate', 'Teiljahr',
    'Δ VJ % (gemeinsame Monate)', `Δ Basisjahr ${baseYear ?? ''} %`.replace('  ', ' '),
    'Top-Monate', 'Schwächste Monate', 'Q1 %', 'Q2 %', 'Q3 %', 'Q4 %',
  ];
  const bySummaryYear = new Map(yearSummaries.map(ys => [ys.year, ys]));
  const jahresRows: ExcelCell[][] = totals.map(tc => {
    const ys = bySummaryYear.get(tc.year);
    const q = (i: number) => ys?.quarters[i]?.sharePct ?? null;
    return [
      t(String(tc.year)),
      chf(tc.total),
      { v: tc.monthsWithData },
      t(tc.isPartial ? (tc.partialLabel ? `Ja (${tc.partialLabel})` : 'Ja') : 'Nein'),
      pct(tc.year === baseYear ? null : tc.vsPrevYearCommon.pct),
      pct(tc.year === baseYear ? null : tc.vsBaseYearCommon.pct),
      t(ys && ys.bestMonths.length > 0 ? ys.bestMonths.map(m => m.label).join(', ') : '—'),
      t(ys && ys.worstMonths.length > 0 ? ys.worstMonths.map(m => m.label).join(', ') : '—'),
      pct(q(0)), pct(q(1)), pct(q(2)), pct(q(3)),
    ];
  });

  // ── Blatt 4: Wachstum (Wasserfall) ──────────────────────────────────────────
  const wfYears = chart.waterfallYears;
  const wachstumHead = ['Position', 'Δ CHF', 'Kumuliert Start CHF', 'Kumuliert Ende CHF'];
  const wachstumRows: ExcelCell[][] = chart.waterfall.map(w => [
    t(w.label, w.isTotal),
    chf(w.delta, w.isTotal),
    chf(w.cumStart, w.isTotal),
    chf(w.cumEnd, w.isTotal),
  ]);

  // ── Blatt 5: Rohdaten ───────────────────────────────────────────────────────
  const rohHead = ['Jahr', 'Monat', 'Nettoumsatz CHF', 'Personalkosten %', 'Warenkosten %', 'Rang im Jahr', 'Anteil am Jahr %'];
  const rohRows: ExcelCell[][] = [];
  for (const y of years) {
    for (const row of monthRows) {
      const cell = row.cells.find(c => c.year === y);
      rohRows.push([
        t(String(y)),
        t(MONTH_LABELS_LONG[row.monthIdx] ?? row.label),
        chf(cell?.value ?? null),
        pct(cell?.personnelPct ?? null),
        pct(cell?.wesPct ?? null),
        { v: cell?.rankInYear ?? null },
        pct(cell?.shareOfYearPct ?? null),
      ]);
    }
  }

  const sheets: ExcelSheetData[] = [
    {
      name: 'Übersicht',
      title: 'Mehrjahresanalyse — Übersicht',
      subtitle,
      head: [],
      rows: uebersichtRows,
      widths: [46, 26, 18],
    },
    {
      name: 'Monatsvergleich',
      title: 'Monatsumsätze im Vergleich (CHF netto)',
      subtitle,
      head: monatsHead,
      rows: monatsRows,
      widths: [12, ...years.map(() => 16), 16, 12, 18],
    },
    {
      name: 'Jahresanalyse',
      title: 'Jahresanalyse',
      subtitle,
      head: jahresHead,
      rows: jahresRows,
      widths: [8, 18, 12, 16, 22, 18, 28, 28, 9, 9, 9, 9],
    },
    {
      name: 'Wachstum',
      title: wfYears
        ? `Wachstums-Wasserfall ${wfYears.from} → ${wfYears.to} (Δ pro Monat, ${fmtPct(lastTotal?.vsPrevYearCommon.pct ?? null)} gesamt)`
        : 'Wachstums-Wasserfall (keine Vergleichsbasis)',
      subtitle,
      head: wachstumHead,
      rows: wachstumRows,
      widths: [16, 16, 20, 20],
    },
    {
      name: 'Rohdaten',
      title: 'Rohdaten (alle Jahre und Monate)',
      subtitle,
      head: rohHead,
      rows: rohRows,
      widths: [8, 12, 18, 16, 16, 12, 16],
    },
  ];

  return {
    sheets,
    fileName: multiYearExcelFileName(years, opts.restaurantName),
  };
}

// ─── Excel-Builder (IO) ───────────────────────────────────────────────────────

const HEADER_BG = '1E293B';
const HEADER_FG = 'FFFFFF';
const MUTED_FG = '64748B';
const ALT_BG = 'FAFBFC';

const CHF_FMT = '#,##0.00';
const PCT_FMT = '0.0"%"';

/**
 * Baut die Excel-Datei (5 Blätter) und stösst den Download an.
 * Header eingefroren, Autofilter auf Tabellenblättern, Schweizer numFmt.
 */
export async function exportMultiYearToExcel(
  analysis: MultiYearAnalysis,
  opts: { restaurantName?: string } = {},
): Promise<void> {
  const data = buildMultiYearExcelData(analysis, opts);
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Personalkostentracker · Mehrjahresanalyse';
  wb.created = new Date();

  for (const sheet of data.sheets) {
    const hasHead = sheet.head.length > 0;
    const frozen = hasHead ? 3 : 2;
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: frozen }] });

    ws.addRow([sheet.title]);
    const titleRow = ws.getRow(1);
    titleRow.height = 22;
    titleRow.font = { bold: true, size: 13, color: { argb: 'FF' + HEADER_BG } };

    ws.addRow([sheet.subtitle]);
    ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF' + MUTED_FG } };

    let headerRowNumber: number | null = null;
    if (hasHead) {
      const hdr = ws.addRow(sheet.head);
      hdr.height = 16;
      hdr.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + HEADER_BG } };
        cell.font = { bold: true, color: { argb: 'FF' + HEADER_FG }, size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      });
      headerRowNumber = hdr.number;
    }

    sheet.rows.forEach((cells, idx) => {
      const row = ws.addRow(cells.map(c => (c.v === null ? '—' : c.v)));
      if (hasHead && idx % 2 === 0) {
        row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
      }
      cells.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (typeof c.v === 'number') {
          cell.alignment = { horizontal: 'right' };
          if (c.fmt === 'chf') cell.numFmt = CHF_FMT;
          if (c.fmt === 'pct') cell.numFmt = PCT_FMT;
        } else if (c.fmt) {
          // Platzhalter „—" für fehlende Zahl: rechtsbündig lassen
          cell.alignment = { horizontal: 'right' };
        }
        if (c.strong) cell.font = { ...(cell.font ?? {}), bold: true };
      });
    });

    if (hasHead && headerRowNumber != null) {
      ws.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber + sheet.rows.length, column: sheet.head.length },
      };
    }

    ws.columns = sheet.widths.map(w => ({ width: w }));
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
