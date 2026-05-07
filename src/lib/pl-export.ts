/**
 * pl-export.ts – Professioneller PDF-Export für die Erfolgsrechnung
 * ==================================================================
 *
 * Modi:
 *   budget_pl: Budget P&L  – Ist | Ist% | Budget | Bud% | Abw.Bud CHF | VJ | VJ% | Abw.VJ CHF
 *   monthly:   Klassisch   – Ist | Ist% | VJ | VJ% | Abw.VJ CHF
 *   yearly:    Jahresübersicht – 12 Monate + Total
 *
 * Optionale Blöcke (PLExportOptions):
 *   1. Monatsreport – vollständige Erfolgsrechnung für den gewählten Monat
 *   2. Vormonatsvergleich – Kennzahlen aktueller Monat vs. Vormonat
 *   3. Kumulierte Übersicht – Jan bis gewählter Monat
 *   4. Ausgewählte Monate – Summe über benutzerdefinierte Monatsauswahl
 *
 * Format: A4 Hochformat (210 × 297 mm)
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PLMonthResult, PLYearResult, PLComputedRow } from '@/types/pl';
import { MONTH_NAMES_SHORT_DE, MONTH_NAMES_DE } from '@/types/reporting';

// ── Export-Optionen ───────────────────────────────────────────────────────────

export interface PLExportOptions {
  includeMonthReport:    boolean;
  includePrevMonth:      boolean;
  includeCumulative:     boolean;
  includeSelectedMonths: boolean;
  selectedMonths:        number[];  // 1-basiert (1 = Jan … 12 = Dez)
}

// ── Farb-Palette ──────────────────────────────────────────────────────────────

const C = {
  navy:       [15,  30,  75]  as [number, number, number],
  navyMid:    [30,  60, 120]  as [number, number, number],
  navyLight:  [55,  90, 155]  as [number, number, number],
  slateLight: [242, 245, 252] as [number, number, number],
  white:      [255, 255, 255] as [number, number, number],
  green:      [22,  115,  60] as [number, number, number],
  red:        [185,  35,  35] as [number, number, number],
  gray:       [140, 145, 155] as [number, number, number],
  navyHeader: [200, 210, 230] as [number, number, number],
};

// ── Zahlenformate ─────────────────────────────────────────────────────────────

function swissNum(v: number): string {
  const abs = Math.round(Math.abs(v));
  const s   = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return v < 0 ? `-${s}` : s;
}
function fmtCHF(v: number | undefined | null): string {
  if (v == null || v === 0) return '–';
  return swissNum(v);
}
function fmtPctRatio(value: number | undefined | null, base: number | undefined | null): string {
  if (value == null || !base || base === 0) return '–';
  const p = (value / base) * 100;
  if (!isFinite(p)) return '–';
  return `${p.toFixed(1)} %`;
}

// ── Farblogik ─────────────────────────────────────────────────────────────────

function varColor(value: number | undefined | null, isExpense: boolean): [number, number, number] {
  if (value == null || Math.abs(value) < 0.5) return C.gray;
  const positive = value > 0;
  return (positive !== isExpense) ? C.green : C.red;
}

function resultActualColor(
  actual: number | undefined | null,
  isResult: boolean,
  isSubtotal: boolean,
): [number, number, number] | undefined {
  if ((!isResult && !isSubtotal) || actual == null || Math.abs(actual) < 0.5) return undefined;
  return actual >= 0 ? C.green : C.red;
}

function isExpenseRow(row: PLComputedRow): boolean {
  return row.def.valueRole === 'negative';
}
function indent(row: PLComputedRow): string {
  return '  '.repeat(Math.max(0, row.def.indent - 1));
}

// ── Hilfsfunktion: neue Seite wenn nötig ─────────────────────────────────────

function ensureSpace(doc: jsPDF, afterY: number, neededH: number, gap = 10): number {
  const PAGE_H = 297;
  const MARGIN = 15;
  const y = afterY + gap;
  if (y + neededH > PAGE_H - MARGIN) {
    doc.addPage();
    return 10;
  }
  return y;
}

// ── Seitenkopf ────────────────────────────────────────────────────────────────

/**
 * Haupt-Seitenkopf: Restaurant prominent · Monat/Jahr gross · Typ klein · Datum diskret
 *
 * Hierarchie:
 *   1. RESTAURANTNAME  – 14pt bold white      ← wichtigste Info
 *   2. MONAT JAHR      – 12pt bold white      ← zweitwichtigste Info
 *   3. Berichtstyp     – 8pt normal slate     ← Kontext
 *   4. Exportiert am … – 6.5pt right slate    ← Metadaten
 */
function addPageHeader(
  doc: jsPDF,
  reportType: string,      // z.B. "Erfolgsrechnung – Budget P&L"
  restaurantName: string,  // z.B. "Oliv Restaurant & Bar"
  exportDate: string,      // z.B. "07.05.2026"
  month: number,
  year: number,
  pageW: number,
  y = 8,
): number {
  const blockH = 34;
  doc.setFillColor(...C.navy);
  doc.rect(10, y, pageW - 20, blockH, 'F');

  // Exportdatum – oben rechts, diskret
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...C.navyHeader);
  doc.text(`Exportiert am ${exportDate}`, pageW - 13, y + 7, { align: 'right' });

  // 1. Restaurantname – gross, prominent
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...C.white);
  doc.text(restaurantName.toUpperCase(), 15, y + 12);

  // 2. Monat / Jahr – gross, prominent
  const mFull = (MONTH_NAMES_DE[month] ?? MONTH_NAMES_SHORT_DE[month] ?? '').toUpperCase();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...C.white);
  doc.text(`${mFull} ${year}`, 15, y + 21);

  // 3. Berichtstyp – kleiner, diskret unter Monat
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.navyHeader);
  doc.text(reportType, 15, y + 29);

  doc.setTextColor(0, 0, 0);
  return y + blockH + 5;
}

/** Kleiner Abschnitts-Header (navy-Block, kein großes Datum) */
function addSectionHeader(
  doc: jsPDF,
  category: string,   // z.B. "VORMONATSVERGLEICH"
  title: string,      // z.B. "April vs. März 2026"
  y: number,
  pageW: number,
): number {
  const blockH = 16;
  doc.setFillColor(...C.navy);
  doc.rect(10, y, pageW - 20, blockH, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...C.navyHeader);
  doc.text(category.toUpperCase(), 15, y + 5.5);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...C.white);
  doc.text(title, 15, y + 12.5);
  doc.setTextColor(0, 0, 0);
  return y + blockH + 2;
}

// ── KPI-Sektion (Monatskennzahlen oben) ──────────────────────────────────────

function addKpiSection(
  doc: jsPDF,
  monthResult: PLMonthResult,
  startY: number,
  pageW: number,
): number {
  const get = (id: string) => monthResult.rows.find(r => r.def.id === id);

  const revRow    = get('net_revenue');
  const ebitdaRow = get('ebitda');
  const ebitRow   = get('ebit');
  const cogsRow   = get('total_cogs');
  const persRow   = get('total_personnel');

  const revA  = revRow?.values.actual;
  const revB  = revRow?.values.budget;
  const revPY = revRow?.values.prevYear;

  type KpiEntry = {
    label: string;
    istCHF: string; istPct: string;
    budCHF: string; budPct: string;
    vjCHF:  string; vjPct:  string;
    istColor: [number, number, number];
  };

  const makeEntry = (
    label: string,
    row: PLComputedRow | undefined,
    isExpense: boolean,
    showPct: boolean,
  ): KpiEntry => {
    const v  = row?.values;
    const a  = v?.actual;
    const b  = v?.budget;
    const py = v?.prevYear;
    const istColor: [number, number, number] = isExpense
      ? C.gray
      : (a == null || Math.abs(a) < 0.5 ? C.gray : a >= 0 ? C.green : C.red);
    return {
      label,
      istCHF: fmtCHF(a),
      istPct: showPct ? fmtPctRatio(a, revA) : '–',
      budCHF: fmtCHF(b),
      budPct: showPct ? fmtPctRatio(b, revB) : '–',
      vjCHF:  fmtCHF(py),
      vjPct:  showPct ? fmtPctRatio(py, revPY) : '–',
      istColor,
    };
  };

  const kpis: KpiEntry[] = [
    makeEntry('Betriebsertrag netto',  revRow,    false, false),
    makeEntry('Warenaufwand total',    cogsRow,   true,  true),
    makeEntry('Personalaufwand total', persRow,   true,  true),
    makeEntry('EBITDA',                ebitdaRow, false, true),
    makeEntry('EBIT',                  ebitRow,   false, true),
  ];

  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...C.navyMid);
  doc.text('KENNZAHLEN', 12, startY + 3.5);
  doc.setTextColor(0, 0, 0);

  autoTable(doc, {
    startY: startY + 5,
    head: [['Kennzahl', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'Vorjahr CHF', 'VJ %']],
    body: kpis.map(k => [
      { content: k.label,   styles: { fontStyle: 'bold' as const } },
      { content: k.istCHF,  styles: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: k.istColor } },
      { content: k.istPct,  styles: { halign: 'right' as const, textColor: C.gray } },
      { content: k.budCHF,  styles: { halign: 'right' as const } },
      { content: k.budPct,  styles: { halign: 'right' as const, textColor: C.gray } },
      { content: k.vjCHF,   styles: { halign: 'right' as const } },
      { content: k.vjPct,   styles: { halign: 'right' as const, textColor: C.gray } },
    ]),
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 7,
      cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 7.5, cellPadding: { top: 1.6, bottom: 1.6, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 14 },
      3: { halign: 'right', cellWidth: 22 },
      4: { halign: 'right', cellWidth: 14 },
      5: { halign: 'right', cellWidth: 22 },
      6: { halign: 'right', cellWidth: 14 },
    },
  });

  return (doc as any).lastAutoTable.finalY + 6;
}

// ── Budget P&L Tabellenkörper ─────────────────────────────────────────────────

function buildBPLBody(
  rows: PLComputedRow[],
  revA: number | undefined,
  revB: number | undefined,
  revPY: number | undefined,
) {
  type CellDef = string | { content: string; styles: Record<string, unknown> };
  const NCOLS = 9;
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;
    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: C.navy, textColor: C.white, colSpan: NCOLS } },
        ...Array(NCOLS - 1).fill(''),
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [235, 238, 248] as [number, number, number]
                     : undefined;
    const baseTxtColor = isResult ? C.white : undefined;
    const istValColor  = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor     = istValColor ?? baseTxtColor;
    const abwBudC      = varColor(v.vsBudget,   isExp);
    const abwVJC       = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    body.push([
      { content: label,               styles: cs() },
      { content: fmtCHF(v.actual),    styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(v.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.budget),    styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.budget,   revB),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsBudget),  styles: cs({ halign: 'right', textColor: isResult ? C.white : abwBudC }) },
      { content: fmtCHF(v.prevYear),  styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Klassisch Tabellenkörper ──────────────────────────────────────────────────

function buildKlassischBody(
  rows: PLComputedRow[],
  revA:  number | undefined,
  revPY: number | undefined,
) {
  type CellDef = string | { content: string; styles: Record<string, unknown> };
  const NCOLS = 6;
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;
    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: C.navy, textColor: C.white, colSpan: NCOLS } },
        ...Array(NCOLS - 1).fill(''),
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [235, 238, 248] as [number, number, number]
                     : undefined;
    const baseTxtColor = isResult ? C.white : undefined;
    const istValColor  = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor     = istValColor ?? baseTxtColor;
    const abwVJC       = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    body.push([
      { content: label,                styles: cs() },
      { content: fmtCHF(v.actual),     styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(v.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.prevYear),   styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Block 2: Vormonatsvergleich ───────────────────────────────────────────────

function addPrevMonthComparison(
  doc: jsPDF,
  yearResult: PLYearResult,
  month: number,   // 1-basiert, aktueller Monat
  year: number,
  afterY: number,
  pageW: number,
): void {
  if (month < 2) return;
  const curIdx  = month - 1;   // 0-basiert
  const prevIdx = month - 2;

  const curResult  = yearResult.months[curIdx];
  const prevResult = yearResult.months[prevIdx];
  if (!curResult || !prevResult) return;

  const y = ensureSpace(doc, afterY, 75);

  const curName  = MONTH_NAMES_DE[month]      ?? '';
  const prevName = MONTH_NAMES_DE[month - 1]  ?? '';

  const tableStartY = addSectionHeader(
    doc,
    'VORMONATSVERGLEICH',
    `${curName} vs. ${prevName} ${year}`,
    y,
    pageW,
  );

  // KPI-Daten holen
  const getKpi = (result: PLMonthResult, id: string) =>
    result.rows.find(r => r.def.id === id)?.values.actual ?? 0;

  const curRev  = getKpi(curResult,  'net_revenue');
  const prevRev = getKpi(prevResult, 'net_revenue');

  interface VmRow { label: string; curV: number; prevV: number; isResult: boolean; isExpense: boolean; }

  const rows: VmRow[] = [
    { label: 'Betriebsertrag netto',  curV: curRev,                              prevV: prevRev,                              isResult: false, isExpense: false },
    { label: 'Warenaufwand total',    curV: getKpi(curResult, 'total_cogs'),      prevV: getKpi(prevResult, 'total_cogs'),      isResult: false, isExpense: true },
    { label: 'Personalaufwand total', curV: getKpi(curResult, 'total_personnel'), prevV: getKpi(prevResult, 'total_personnel'), isResult: false, isExpense: true },
    { label: 'EBITDA',                curV: getKpi(curResult, 'ebitda'),          prevV: getKpi(prevResult, 'ebitda'),          isResult: true,  isExpense: false },
    { label: 'EBIT',                  curV: getKpi(curResult, 'ebit'),            prevV: getKpi(prevResult, 'ebit'),            isResult: true,  isExpense: false },
  ];

  type CellDef = string | { content: string; styles: Record<string, unknown> };

  const body: CellDef[][] = rows.map(({ label, curV, prevV, isResult, isExpense }) => {
    const abwCHF = curV - prevV;
    const abwPct = prevV !== 0 ? (abwCHF / Math.abs(prevV)) * 100 : 0;
    const abwPctStr = prevV !== 0 ? `${abwPct > 0 ? '+' : ''}${abwPct.toFixed(1)} %` : '–';

    const fillColor    = isResult ? C.navyMid : undefined;
    const baseTxt      = isResult ? C.white   : undefined;
    const istColor     = isResult ? (curV >= 0 ? C.green : C.red) : undefined;
    const abwColor     = isResult ? C.white : varColor(abwCHF, isExpense);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: 'bold' as const,
      ...(fillColor ? { fillColor }           : {}),
      ...(baseTxt   ? { textColor: baseTxt }  : {}),
      ...extra,
    });

    return [
      { content: label,               styles: cs() },
      { content: fmtCHF(curV),        styles: cs({ halign: 'right', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(curV,  curRev),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(prevV),       styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(prevV, prevRev), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(abwCHF),      styles: cs({ halign: 'right', textColor: abwColor, fontStyle: 'normal' }) },
      { content: abwPctStr,            styles: cs({ halign: 'right', textColor: abwColor, fontStyle: 'normal' }) },
    ];
  });

  autoTable(doc, {
    startY: tableStartY,
    head: [[
      'Kennzahl',
      `${MONTH_NAMES_SHORT_DE[month]} CHF`,    `${MONTH_NAMES_SHORT_DE[month]} %`,
      `${MONTH_NAMES_SHORT_DE[month - 1]} CHF`, `${MONTH_NAMES_SHORT_DE[month - 1]} %`,
      'Abw. CHF', 'Abw. %',
    ]],
    body: body as string[][],
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 7,
      cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 7.5, cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 20 },
      2: { halign: 'right', cellWidth: 13 },
      3: { halign: 'right', cellWidth: 20 },
      4: { halign: 'right', cellWidth: 13 },
      5: { halign: 'right', cellWidth: 20 },
      6: { halign: 'right', cellWidth: 20 },
    },
  });
}

// ── Block 3 + 4: Kumulierte / Ausgewählte Monate ─────────────────────────────

/**
 * Summiert Kennzahlen über beliebige Monate aus yearResult und rendert einen Block.
 * @param monthIndices  0-basierte Indizes in yearResult.months
 * @param category      Kopfzeile (z.B. "KUMULIERTE ÜBERSICHT")
 * @param title         Untertitel (z.B. "Januar bis April 2026")
 */
function addKpiSummaryBlock(
  doc: jsPDF,
  yearResult: PLYearResult,
  monthIndices: number[],
  category: string,
  title: string,
  afterY: number,
  pageW: number,
): void {
  if (monthIndices.length === 0) return;

  const y = ensureSpace(doc, afterY, 80);
  const tableStartY = addSectionHeader(doc, category, title, y, pageW);

  const sumKpi = (id: string) => {
    let actual = 0, budget = 0, prevYear = 0;
    for (const idx of monthIndices) {
      const mr = yearResult.months[idx];
      if (!mr) continue;
      const r = mr.rows.find(row => row.def.id === id);
      actual   += r?.values.actual   ?? 0;
      budget   += r?.values.budget   ?? 0;
      prevYear += r?.values.prevYear ?? 0;
    }
    return { actual, budget, prevYear };
  };

  const rev    = sumKpi('net_revenue');
  const cogs   = sumKpi('total_cogs');
  const pers   = sumKpi('total_personnel');
  const ebitda = sumKpi('ebitda');
  const ebit   = sumKpi('ebit');

  type CellDef = string | { content: string; styles: Record<string, unknown> };

  const makeRow = (
    label: string,
    vals: { actual: number; budget: number; prevYear: number },
    isResult: boolean,
    isExpense: boolean,
  ): CellDef[] => {
    const revA  = rev.actual;
    const revB  = rev.budget;
    const revPY = rev.prevYear;

    const abwBudRaw = vals.actual - vals.budget;
    const abwVJRaw  = vals.actual - vals.prevYear;

    const fillColor    = isResult ? C.navyMid : undefined;
    const baseTxtColor = isResult ? C.white   : undefined;
    const istColor     = isResult ? (vals.actual >= 0 ? C.green : C.red)
                       : isExpense ? undefined
                       : (vals.actual >= 0 ? C.green : C.red);
    const abwBudColor  = isResult ? C.white : varColor(abwBudRaw, isExpense);
    const abwVJColor   = isResult ? C.white : varColor(abwVJRaw,  isExpense);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: 'bold',
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    return [
      { content: label,                      styles: cs() },
      { content: fmtCHF(vals.actual),        styles: cs({ halign: 'right', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(vals.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(vals.budget),        styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(vals.budget,   revB),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(vals.prevYear),      styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(vals.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(abwBudRaw),          styles: cs({ halign: 'right', textColor: abwBudColor, fontStyle: 'normal' }) },
      { content: fmtCHF(abwVJRaw),           styles: cs({ halign: 'right', textColor: abwVJColor,  fontStyle: 'normal' }) },
    ];
  };

  const body: CellDef[][] = [
    makeRow('Betriebsertrag netto',  rev,    false, false),
    makeRow('Warenaufwand total',    cogs,   false, true),
    makeRow('Personalaufwand total', pers,   false, true),
    makeRow('EBITDA',                ebitda, true,  false),
    makeRow('EBIT',                  ebit,   true,  false),
  ];

  autoTable(doc, {
    startY: tableStartY,
    head: [['Kennzahl', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'VJ CHF', 'VJ %', 'Abw. Budget', 'Abw. VJ']],
    body: body as string[][],
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 7,
      cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 7.5, cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 17 },
      2: { halign: 'right', cellWidth: 13 },
      3: { halign: 'right', cellWidth: 17 },
      4: { halign: 'right', cellWidth: 13 },
      5: { halign: 'right', cellWidth: 17 },
      6: { halign: 'right', cellWidth: 13 },
      7: { halign: 'right', cellWidth: 18 },
      8: { halign: 'right', cellWidth: 18 },
    },
  });
}

// ── Block 4: Monatsvergleich (Monate als Spalten) ─────────────────────────────

/**
 * Zeigt ausgewählte Monate nebeneinander als Spalten.
 * Keine kumulierte Summe – jeder Monat ist ein einzelner Wert.
 * Max. 6 Monate pro Tabelle; bei mehr wird eine zweite Tabelle angehängt.
 *
 * @param selectedMonths  1-basiert, sortiert (z.B. [1,2,3,4])
 */
function addMonthComparisonBlock(
  doc: jsPDF,
  yearResult: PLYearResult,
  selectedMonths: number[],
  year: number,
  afterY: number,
  pageW: number,
): void {
  if (selectedMonths.length === 0) return;

  const CHUNK_SIZE = 6;
  const indices = selectedMonths.map(m => m - 1); // 0-basiert

  // Titel
  const isConsecutive = selectedMonths.every((m, i) => i === 0 || m === selectedMonths[i - 1] + 1);
  const title = isConsecutive && selectedMonths.length > 1
    ? `${MONTH_NAMES_DE[selectedMonths[0]]} bis ${MONTH_NAMES_DE[selectedMonths[selectedMonths.length - 1]]} ${year}`
    : `${selectedMonths.map(m => MONTH_NAMES_SHORT_DE[m]).filter(Boolean).join(', ')} ${year}`;

  const y = ensureSpace(doc, afterY, 90);
  const headerEndY = addSectionHeader(doc, 'MONATSVERGLEICH', title, y, pageW);

  // Kennzahlen-Definitionen
  interface RowDef {
    id:        string;
    label:     string;
    isExpense: boolean;
    isPctRow:  boolean;
    isResult:  boolean;
  }
  const ROW_DEFS: RowDef[] = [
    { id: 'net_revenue',     label: 'Betriebsertrag netto',  isExpense: false, isPctRow: false, isResult: false },
    { id: 'total_cogs',      label: 'Warenaufwand total',    isExpense: true,  isPctRow: false, isResult: false },
    { id: 'total_cogs',      label: 'Warenaufwand %',        isExpense: true,  isPctRow: true,  isResult: false },
    { id: 'total_personnel', label: 'Personalaufwand total', isExpense: true,  isPctRow: false, isResult: false },
    { id: 'total_personnel', label: 'Personalaufwand %',     isExpense: true,  isPctRow: true,  isResult: false },
    { id: 'ebitda',          label: 'EBITDA',                isExpense: false, isPctRow: false, isResult: true  },
    { id: 'ebitda',          label: 'EBITDA %',              isExpense: false, isPctRow: true,  isResult: true  },
    { id: 'ebit',            label: 'EBIT',                  isExpense: false, isPctRow: false, isResult: true  },
    { id: 'ebit',            label: 'EBIT %',                isExpense: false, isPctRow: true,  isResult: true  },
  ];

  const getVal = (monthIdx: number, id: string): number =>
    yearResult.months[monthIdx]?.rows.find(r => r.def.id === id)?.values.actual ?? 0;
  const getRevVal = (monthIdx: number): number => getVal(monthIdx, 'net_revenue');

  // Trend-Referenz: letzter vs. erster ausgewählter Monat
  const firstIdx = indices[0];
  const lastIdx  = indices[indices.length - 1];

  // Chunks bilden (max. 6 Monate pro Tabelle)
  const chunks: number[][] = [];
  for (let i = 0; i < indices.length; i += CHUNK_SIZE) {
    chunks.push(indices.slice(i, i + CHUNK_SIZE));
  }

  let currentY = headerEndY;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const n     = chunk.length;

    // Spaltenbreiten: Label (42) + n×Monate + Trend (24) ≤ 190mm
    const LABEL_W = 42;
    const TREND_W = 24;
    const perMonthW = Math.floor((pageW - 20 - LABEL_W - TREND_W) / n);

    const head = [
      'Kennzahl',
      ...chunk.map(idx => MONTH_NAMES_SHORT_DE[idx + 1] ?? ''),
      'Trend',
    ];

    type CellDef = string | { content: string; styles: Record<string, unknown> };
    const body: CellDef[][] = [];

    for (const rowDef of ROW_DEFS) {
      const { id, label, isExpense, isPctRow, isResult } = rowDef;
      const fillColor    = isResult ? C.navyMid : undefined;
      const baseTxtColor = isResult ? C.white   : undefined;

      const labelStyle: Record<string, unknown> = {
        fontStyle: isResult ? 'bold' : isPctRow ? 'italic' : 'normal',
        fontSize:  isPctRow ? 6.5 : 7.5,
        ...(fillColor    ? { fillColor }               : {}),
        ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      };

      // Monatsspalten
      const monthCells: CellDef[] = chunk.map(monthIdx => {
        const revV = getRevVal(monthIdx);
        const v    = getVal(monthIdx, id);
        let content: string;
        let textColor: [number, number, number] | undefined;

        if (isPctRow) {
          content   = fmtPctRatio(v, revV);
          textColor = isResult ? C.white : C.gray;
        } else {
          content   = fmtCHF(v);
          textColor = isResult ? (v >= 0 ? C.green : C.red) : undefined;
        }

        return {
          content,
          styles: {
            halign:    'right',
            fontStyle: isPctRow ? 'normal' : isResult ? 'bold' : 'normal',
            fontSize:  isPctRow ? 6.5 : 7.5,
            ...(fillColor    ? { fillColor }               : {}),
            ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
            ...(textColor    ? { textColor }               : {}),
          },
        };
      });

      // Trendspalte (letzter vs. erster Monat der Gesamtauswahl)
      const firstV    = getVal(firstIdx,  id);
      const lastV     = getVal(lastIdx,   id);
      const firstRevV = getRevVal(firstIdx);
      const lastRevV  = getRevVal(lastIdx);

      let trendContent: string;
      let trendColor:   [number, number, number];

      if (isPctRow) {
        const firstPct = firstRevV !== 0 ? (firstV / firstRevV) * 100 : 0;
        const lastPct  = lastRevV  !== 0 ? (lastV  / lastRevV)  * 100 : 0;
        const diff     = lastPct - firstPct;
        trendContent   = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pp`;
        trendColor     = isExpense ? (diff <= 0 ? C.green : C.red) : (diff >= 0 ? C.green : C.red);
      } else {
        const diff    = lastV - firstV;
        const diffPct = firstV !== 0 ? (diff / Math.abs(firstV)) * 100 : 0;
        trendContent  = `${diff >= 0 ? '+' : ''}${swissNum(diff)}`;
        if (Math.abs(firstV) > 0.5) {
          trendContent += `  ${diff >= 0 ? '+' : ''}${diffPct.toFixed(1)} %`;
        }
        trendColor = isExpense ? (diff <= 0 ? C.green : C.red) : (diff >= 0 ? C.green : C.red);
      }

      body.push([
        { content: label, styles: labelStyle },
        ...monthCells,
        {
          content: trendContent,
          styles: {
            halign:    'right',
            fontStyle: 'bold',
            fontSize:  isPctRow ? 6.5 : 7,
            textColor: isResult ? C.white : trendColor,
            ...(fillColor ? { fillColor } : {}),
          },
        },
      ]);
    }

    // Spaltenbreiten für autoTable
    const colStyles: Record<number, Record<string, unknown>> = {
      0: { cellWidth: LABEL_W },
    };
    for (let i = 0; i < n; i++) {
      colStyles[i + 1] = { halign: 'right', cellWidth: perMonthW };
    }
    colStyles[n + 1] = { halign: 'right', cellWidth: TREND_W };

    // Bei Chunk 2+ sicherstellen, dass genug Platz ist
    if (chunkIdx > 0) {
      currentY = ensureSpace(doc, (doc as any).lastAutoTable?.finalY ?? currentY, 80);
    }

    autoTable(doc, {
      startY: currentY,
      head:   [head],
      body:   body as string[][],
      theme:  'plain',
      headStyles: {
        fillColor: C.navyLight, textColor: C.white,
        fontStyle: 'bold', fontSize: 7,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
      },
      bodyStyles: { fontSize: 7.5, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 } },
      alternateRowStyles: { fillColor: C.slateLight },
      columnStyles: colStyles,
    });

    currentY = (doc as any).lastAutoTable?.finalY ?? currentY;
  }
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

export function exportPLToPDF(
  monthResult: PLMonthResult,
  yearResult:  PLYearResult,
  year:        number,
  month:       number,
  mode: 'budget_pl' | 'monthly' | 'yearly' = 'budget_pl',
  options?: PLExportOptions,
  restaurantName = 'Oliv Restaurant & Bar',
): void {
  // Defaults: alles eingeschlossen (Rückwärtskompatibilität)
  const opts: PLExportOptions = options ?? {
    includeMonthReport:    true,
    includePrevMonth:      month > 1,
    includeCumulative:     month > 1,
    includeSelectedMonths: false,
    selectedMonths:        Array.from({ length: month }, (_, i) => i + 1),
  };

  const doc    = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const now    = new Date().toLocaleDateString('de-CH');
  const PAGE_W = 210;

  const revA  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.actual;
  const revB  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.budget;
  const revPY = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.prevYear;

  // ──── Budget P&L ─────────────────────────────────────────────────────────
  if (mode === 'budget_pl' || mode === 'monthly') {
    const isBPL = mode === 'budget_pl';

    if (opts.includeMonthReport) {
      const reportType = isBPL ? 'Erfolgsrechnung – Budget P&L' : 'Erfolgsrechnung – Monatsansicht';
      const yH = addPageHeader(doc, reportType, restaurantName, now, month, year, PAGE_W);
      const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

      if (isBPL) {
        const body = buildBPLBody(monthResult.rows, revA, revB, revPY);
        autoTable(doc, {
          startY: yK,
          head: [['Position', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'Abw. Budget', 'Vorjahr CHF', 'VJ %', 'Abw. VJ']],
          body: body as string[][],
          theme: 'plain',
          headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 } },
          bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
          alternateRowStyles: { fillColor: C.slateLight },
          columnStyles: {
            0: { cellWidth: 52 },
            1: { halign: 'right', cellWidth: 18 },
            2: { halign: 'right', cellWidth: 11 },
            3: { halign: 'right', cellWidth: 18 },
            4: { halign: 'right', cellWidth: 11 },
            5: { halign: 'right', cellWidth: 18 },
            6: { halign: 'right', cellWidth: 18 },
            7: { halign: 'right', cellWidth: 11 },
            8: { halign: 'right', cellWidth: 18 },
          },
          didParseCell: (data) => {
            if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
              const first = (data.row.raw as any[])[0];
              if (first?.styles?.colSpan === 9) data.cell.styles.fillColor = C.navy;
            }
          },
        });
      } else {
        const body = buildKlassischBody(monthResult.rows, revA, revPY);
        autoTable(doc, {
          startY: yK,
          head: [['Position', 'Ist CHF', 'Ist %', 'Vorjahr CHF', 'VJ %', 'Abw. VJ']],
          body: body as string[][],
          theme: 'plain',
          headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 } },
          bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
          alternateRowStyles: { fillColor: C.slateLight },
          columnStyles: {
            0: { cellWidth: 75 },
            1: { halign: 'right', cellWidth: 26 },
            2: { halign: 'right', cellWidth: 15 },
            3: { halign: 'right', cellWidth: 26 },
            4: { halign: 'right', cellWidth: 15 },
            5: { halign: 'right', cellWidth: 26 },
          },
          didParseCell: (data) => {
            if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
              const first = (data.row.raw as any[])[0];
              if (first?.styles?.colSpan === 6) data.cell.styles.fillColor = C.navy;
            }
          },
        });
      }
    }

    // ── Block 2: Vormonatsvergleich ──────────────────────────────────────
    if (opts.includePrevMonth && month > 1) {
      const prevAfterY = (doc as any).lastAutoTable?.finalY ?? 10;
      addPrevMonthComparison(doc, yearResult, month, year, prevAfterY, PAGE_W);
    }

    // ── Block 3: Kumulierte Übersicht Jan bis aktueller Monat ───────────
    if (opts.includeCumulative && month > 1) {
      const cumAfterY  = (doc as any).lastAutoTable?.finalY ?? 10;
      const cumIndices = Array.from({ length: month }, (_, i) => i);
      const monthName  = MONTH_NAMES_DE[month] ?? '';
      addKpiSummaryBlock(
        doc, yearResult, cumIndices,
        'KUMULIERTE ÜBERSICHT',
        `Januar bis ${monthName} ${year}`,
        cumAfterY, PAGE_W,
      );
    }

    // ── Block 4: Monatsvergleich (Monate als Spalten) ───────────────────
    if (opts.includeSelectedMonths && opts.selectedMonths.length > 0) {
      const selAfterY = (doc as any).lastAutoTable?.finalY ?? 10;
      const validMonths = opts.selectedMonths.filter(m => m >= 1 && m <= 12);
      addMonthComparisonBlock(doc, yearResult, validMonths, year, selAfterY, PAGE_W);
    }
  }

  // ──── Jahresübersicht ────────────────────────────────────────────────────
  else if (mode === 'yearly') {
    const blockH = 34;
    doc.setFillColor(...C.navy);
    doc.rect(10, 8, PAGE_W - 20, blockH, 'F');

    // Exportdatum – oben rechts, diskret
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...C.navyHeader);
    doc.text(`Exportiert am ${now}`, PAGE_W - 13, 15, { align: 'right' });

    // 1. Restaurantname – gross
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...C.white);
    doc.text(restaurantName.toUpperCase(), 15, 20);

    // 2. Jahr – gross
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...C.white);
    doc.text(String(year), 15, 29);

    // 3. Berichtstyp – klein
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...C.navyHeader);
    doc.text('Jahresübersicht', 15, 37);

    doc.setTextColor(0, 0, 0);
    const yH = 8 + blockH + 5;

    const KEY_ROWS: { id: string; isPct?: boolean; pctLabel?: string }[] = [
      { id: 'revenue_total' },
      { id: 'total_cogs',      isPct: true, pctLabel: 'Warenkosten %' },
      { id: 'total_personnel', isPct: true, pctLabel: 'Personalquote %' },
      { id: 'total_opex' },
      { id: 'ebitda',          isPct: true, pctLabel: 'EBITDA %' },
      { id: 'ebit',            isPct: true, pctLabel: 'EBIT %' },
    ];

    const months       = yearResult.months;
    const monthCols    = months.map((_, i) => MONTH_NAMES_SHORT_DE[i + 1]);
    const monthRevs    = months.map(mr => mr.rows.find(r => r.def.id === 'net_revenue')?.values.actual);
    const totalRevenue = yearResult.total.rows.find(r => r.def.id === 'net_revenue')?.values.actual;

    type YearCell = string | { content: string; styles: Record<string, unknown> };
    const yearBody: YearCell[][] = [];

    for (const keyRow of KEY_ROWS) {
      const template = monthResult.rows.find(r => r.def.id === keyRow.id);
      if (!template) continue;

      const isResult   = template.def.type === 'result';
      const isSubtotal = template.def.type === 'subtotal';
      const bold       = isResult || isSubtotal ? 'bold' : 'normal';
      const fillColor  = isResult   ? C.navyMid
                       : isSubtotal ? [235, 238, 248] as [number, number, number]
                       : undefined;
      const baseTxtColor = isResult ? C.white : undefined;
      const label = indent(template) + template.def.label;

      const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        fontStyle: bold,
        ...(fillColor    ? { fillColor }               : {}),
        ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
        ...extra,
      });

      const totalRow   = yearResult.total.rows.find(r => r.def.id === keyRow.id);
      const totalV     = totalRow?.values.actual;
      const totalColor = resultActualColor(totalV, isResult, isSubtotal);

      const chfCells: YearCell[] = months.map((mr) => {
        const r    = mr.rows.find(row => row.def.id === keyRow.id);
        const v    = r?.values.actual;
        const vCol = resultActualColor(v, isResult, isSubtotal);
        return { content: fmtCHF(v), styles: cs({ halign: 'right', ...(vCol ? { textColor: vCol } : {}) }) };
      });

      yearBody.push([
        { content: label, styles: cs() },
        ...chfCells,
        { content: fmtCHF(totalV), styles: cs({ halign: 'right', fontStyle: 'bold', ...(totalColor ? { textColor: totalColor } : {}) }) },
      ]);

      if (keyRow.isPct) {
        const pctRowStyle: Record<string, unknown> = {
          fontStyle: 'italic' as const, fontSize: 6,
          textColor: isResult ? C.white : C.gray,
          fillColor: isResult ? C.navyMid : [248, 249, 253] as [number, number, number],
        };
        const pctCells: YearCell[] = months.map((mr, i) => {
          const r = mr.rows.find(row => row.def.id === keyRow.id);
          const v = r?.values.actual;
          return { content: fmtPctRatio(v, monthRevs[i]), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'normal' as const } };
        });
        yearBody.push([
          { content: `  ${keyRow.pctLabel ?? '% Umsatz'}`, styles: pctRowStyle },
          ...pctCells,
          { content: fmtPctRatio(totalV, totalRevenue), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'bold' as const } },
        ]);
      }
    }

    const labelW = 34;
    const colW   = 12;
    autoTable(doc, {
      startY: yH,
      head: [['Position', ...monthCols, 'Total']],
      body: yearBody as string[][],
      theme: 'plain',
      headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 6, cellPadding: { top: 2, bottom: 2, left: 1, right: 1 } },
      bodyStyles: { fontSize: 6, cellPadding: { top: 1, bottom: 1, left: 1, right: 1 } },
      columnStyles: {
        0: { cellWidth: labelW },
        ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { halign: 'right', cellWidth: colW }])),
      },
    });
  }

  // ── Seitenzahlen ──────────────────────────────────────────────────────────
  const totalPages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C.gray);
    doc.text(`Seite ${p} / ${totalPages}`, PAGE_W - 12, 290, { align: 'right' });
    doc.text(`Oliv Gastro AG · Erfolgsrechnung ${year} · ${now}`, 12, 290);
  }

  doc.save(`Erfolgsrechnung_${year}_${MONTH_NAMES_SHORT_DE[month]}.pdf`);
}
