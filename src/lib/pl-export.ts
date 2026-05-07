/**
 * pl-export.ts – Professioneller PDF-Export für die Erfolgsrechnung
 * ==================================================================
 *
 * Drei Seiten (alle Landscape A4):
 *   1. Budget P&L:       Ist | Ist% | Budget | Bud% | Abw.Bud CHF | Abw.Bud% | VJ | VJ% | Abw.VJ CHF | Abw.VJ%
 *   2. Klassisch:        Ist | Ist% | VJ | VJ% | Abw.VJ CHF | Abw.VJ%
 *   3. Jahresübersicht:  12 Monate + Total, CHF + % pro Kennzahl
 *
 * Prozentwerte = Anteil am Betriebsertrag netto (Ist / Budget / Vorjahr).
 * Farblogik:   Ertrag/Ergebnis: positiv = grün / negativ = rot.
 *              Aufwand:          positiv = rot  / negativ = grün.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PLMonthResult, PLYearResult, PLComputedRow } from '@/types/pl';
import { MONTH_NAMES_SHORT_DE } from '@/types/reporting';

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
  grayLight:  [215, 218, 225] as [number, number, number],
  amber:      [175,  95,   0] as [number, number, number],
  gold:       [200, 155,   0] as [number, number, number],
};

// ── Zahlenformate ─────────────────────────────────────────────────────────────

function swissNum(v: number): string {
  const abs  = Math.round(Math.abs(v));
  const s    = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return v < 0 ? `-${s}` : s;
}

function fmtCHF(v: number | undefined | null): string {
  if (v == null || v === 0) return '–';
  return swissNum(v);
}

function fmtPctRatio(value: number | undefined | null, base: number | undefined | null): string {
  if (!value || !base || base === 0) return '–';
  const p = (value / base) * 100;
  if (!isFinite(p)) return '–';
  return `${p.toFixed(1)} %`;
}

function fmtPctVar(v: number | undefined | null): string {
  if (v == null) return '–';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)} %`;
}

// ── Farblogik für Abweichungen ────────────────────────────────────────────────

/** Farbwert für eine Abweichungszelle (Ertrag/Ergebnis vs. Aufwand) */
function varColor(
  value: number | undefined | null,
  isExpense: boolean,
): [number, number, number] {
  if (value == null || Math.abs(value) < 0.5) return C.gray;
  const positive = value > 0;
  return (positive !== isExpense) ? C.green : C.red;
}

/** isExpense aus PLComputedRow */
function isExpenseRow(row: PLComputedRow): boolean {
  return row.def.valueRole === 'negative';
}

// ── Zeilen-Metadaten ──────────────────────────────────────────────────────────

function indent(row: PLComputedRow): string {
  return '  '.repeat(Math.max(0, row.def.indent - 1));
}

// ── Seitenkopf ────────────────────────────────────────────────────────────────

function addPageHeader(
  doc: jsPDF,
  title: string,
  sub: string,
  pageW: number,
  y = 8,
): number {
  doc.setFillColor(...C.navy);
  doc.rect(10, y, pageW - 20, 11, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...C.white);
  doc.text('Oliv Gastro AG', 14, y + 7.2);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`– ${title}`, 14 + 32, y + 7.2);

  doc.setFontSize(7);
  doc.text(sub, pageW - 12, y + 7.2, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  return y + 15;
}

// ── KPI-Tabelle ───────────────────────────────────────────────────────────────

function addKpiSection(
  doc: jsPDF,
  monthResult: PLMonthResult,
  startY: number,
  pageW: number,
): number {
  const get = (id: string) => monthResult.rows.find(r => r.def.id === id);

  const revRow    = get('net_revenue');
  const gp1Row    = get('gross_profit_1');
  const gp2Row    = get('gross_profit_2');
  const ebitdaRow = get('ebitda');
  const ebitRow   = get('ebit');
  const cogsRow   = get('total_cogs');
  const persRow   = get('total_personnel');

  const revA  = revRow?.values.actual;
  const revB  = revRow?.values.budget;
  const revPY = revRow?.values.prevYear;

  const ppDiff = (a: number | undefined, b: number | undefined, baseA: number | undefined, baseB: number | undefined): string => {
    if (!a || !b || !baseA || !baseB || baseA === 0 || baseB === 0) return '–';
    const pA = (a / baseA) * 100;
    const pB = (b / baseB) * 100;
    const diff = pA - pB;
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pp`;
  };

  type KpiRow = {
    label: string; ist: string; bud: string; vj: string;
    abwBud: string; abwVJ: string;
    budC: [number,number,number]; vjC: [number,number,number];
    isExpense: boolean;
  };

  const kpis: KpiRow[] = [
    {
      label: 'Betriebsertrag netto', isExpense: false,
      ist:    fmtCHF(revA),   bud: fmtCHF(revB),   vj: fmtCHF(revPY),
      abwBud: fmtPctVar(revRow?.values.vsBudgetPct),
      abwVJ:  fmtPctVar(revRow?.values.vsPrevYearPct),
      budC: varColor(revRow?.values.vsBudget, false),
      vjC:  varColor(revRow?.values.vsPrevYear, false),
    },
    {
      label: 'Bruttogewinn 1', isExpense: false,
      ist:    fmtCHF(gp1Row?.values.actual),   bud: fmtCHF(gp1Row?.values.budget),   vj: fmtCHF(gp1Row?.values.prevYear),
      abwBud: fmtPctVar(gp1Row?.values.vsBudgetPct),
      abwVJ:  fmtPctVar(gp1Row?.values.vsPrevYearPct),
      budC: varColor(gp1Row?.values.vsBudget, false),
      vjC:  varColor(gp1Row?.values.vsPrevYear, false),
    },
    {
      label: 'Deckungsbeitrag', isExpense: false,
      ist:    fmtCHF(gp2Row?.values.actual),   bud: fmtCHF(gp2Row?.values.budget),   vj: fmtCHF(gp2Row?.values.prevYear),
      abwBud: fmtPctVar(gp2Row?.values.vsBudgetPct),
      abwVJ:  fmtPctVar(gp2Row?.values.vsPrevYearPct),
      budC: varColor(gp2Row?.values.vsBudget, false),
      vjC:  varColor(gp2Row?.values.vsPrevYear, false),
    },
    {
      label: 'EBITDA', isExpense: false,
      ist:    fmtCHF(ebitdaRow?.values.actual), bud: fmtCHF(ebitdaRow?.values.budget), vj: fmtCHF(ebitdaRow?.values.prevYear),
      abwBud: fmtPctVar(ebitdaRow?.values.vsBudgetPct),
      abwVJ:  fmtPctVar(ebitdaRow?.values.vsPrevYearPct),
      budC: varColor(ebitdaRow?.values.vsBudget, false),
      vjC:  varColor(ebitdaRow?.values.vsPrevYear, false),
    },
    {
      label: 'EBIT', isExpense: false,
      ist:    fmtCHF(ebitRow?.values.actual),   bud: fmtCHF(ebitRow?.values.budget),   vj: fmtCHF(ebitRow?.values.prevYear),
      abwBud: fmtPctVar(ebitRow?.values.vsBudgetPct),
      abwVJ:  fmtPctVar(ebitRow?.values.vsPrevYearPct),
      budC: varColor(ebitRow?.values.vsBudget, false),
      vjC:  varColor(ebitRow?.values.vsPrevYear, false),
    },
    {
      label: 'Warenkosten %', isExpense: true,
      ist:    fmtPctRatio(cogsRow?.values.actual,   revA),
      bud:    fmtPctRatio(cogsRow?.values.budget,   revB),
      vj:     fmtPctRatio(cogsRow?.values.prevYear, revPY),
      abwBud: ppDiff(cogsRow?.values.actual, cogsRow?.values.budget, revA, revB),
      abwVJ:  ppDiff(cogsRow?.values.actual, cogsRow?.values.prevYear, revA, revPY),
      budC: C.gray, vjC: C.gray,
    },
    {
      label: 'Personalquote %', isExpense: true,
      ist:    fmtPctRatio(persRow?.values.actual,   revA),
      bud:    fmtPctRatio(persRow?.values.budget,   revB),
      vj:     fmtPctRatio(persRow?.values.prevYear, revPY),
      abwBud: ppDiff(persRow?.values.actual, persRow?.values.budget, revA, revB),
      abwVJ:  ppDiff(persRow?.values.actual, persRow?.values.prevYear, revA, revPY),
      budC: C.gray, vjC: C.gray,
    },
  ];

  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...C.navyMid);
  doc.text('KENNZAHLEN', 12, startY + 3.5);
  doc.setTextColor(0, 0, 0);

  autoTable(doc, {
    startY: startY + 5,
    head: [['KPI', 'Ist (CHF)', 'Budget (CHF)', 'Vorjahr (CHF)', 'Abw. Budget', 'Abw. Vorjahr']],
    body: kpis.map(k => [
      { content: k.label, styles: { fontStyle: 'bold' as const } },
      { content: k.ist,    styles: { halign: 'right' as const, fontStyle: 'bold' as const } },
      { content: k.bud,    styles: { halign: 'right' as const } },
      { content: k.vj,     styles: { halign: 'right' as const } },
      { content: k.abwBud, styles: { halign: 'right' as const, textColor: k.budC } },
      { content: k.abwVJ,  styles: { halign: 'right' as const, textColor: k.vjC } },
    ]),
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 7, cellPadding: { top: 1.3, bottom: 1.3, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 44 },
      1: { halign: 'right', cellWidth: 30 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 30 },
      4: { halign: 'right', cellWidth: 28 },
      5: { halign: 'right', cellWidth: 28 },
    },
  });

  return (doc as any).lastAutoTable.finalY + 5;
}

// ── Budget P&L Tabellenkörper ─────────────────────────────────────────────────

function buildBPLBody(
  rows: PLComputedRow[],
  revA:  number | undefined,
  revB:  number | undefined,
  revPY: number | undefined,
) {
  type CellDef = string | { content: string; styles: Record<string, unknown> };
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;

    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      const fill = C.navy;
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: fill, textColor: C.white, colSpan: 11 } },
        '', '', '', '', '', '', '', '', '', '',
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [235, 238, 248] as [number,number,number]
                     : undefined;
    const textColor  = isResult ? C.white : undefined;

    const pctA  = fmtPctRatio(v.actual,   revA);
    const pctB  = fmtPctRatio(v.budget,   revB);
    const pctPY = fmtPctRatio(v.prevYear, revPY);
    const abwBudC  = varColor(v.vsBudget,    isExp);
    const abwVJC   = varColor(v.vsPrevYear,  isExp);

    const cellStyle = (extra: Record<string, unknown> = {}) => ({
      fontStyle: bold,
      ...(fillColor ? { fillColor } : {}),
      ...(textColor ? { textColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;

    body.push([
      { content: label,          styles: cellStyle() },
      { content: fmtCHF(v.actual),   styles: cellStyle({ halign: 'right', fontStyle: 'bold' }) },
      { content: pctA,           styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.budget),   styles: cellStyle({ halign: 'right' }) },
      { content: pctB,           styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsBudget), styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwBudC }) },
      { content: fmtPctVar(v.vsBudgetPct), styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwBudC }) },
      { content: fmtCHF(v.prevYear),  styles: cellStyle({ halign: 'right' }) },
      { content: pctPY,           styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
      { content: fmtPctVar(v.vsPrevYearPct), styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
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
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;

    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: C.navy, textColor: C.white, colSpan: 7 } },
        '', '', '', '', '', '',
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [235, 238, 248] as [number,number,number]
                     : undefined;
    const textColor  = isResult ? C.white : undefined;

    const pctA  = fmtPctRatio(v.actual,   revA);
    const pctPY = fmtPctRatio(v.prevYear, revPY);
    const abwVJC = varColor(v.vsPrevYear, isExp);

    const cellStyle = (extra: Record<string, unknown> = {}) => ({
      fontStyle: bold,
      ...(fillColor ? { fillColor } : {}),
      ...(textColor ? { textColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;

    body.push([
      { content: label,               styles: cellStyle() },
      { content: fmtCHF(v.actual),    styles: cellStyle({ halign: 'right', fontStyle: 'bold' }) },
      { content: pctA,                styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.prevYear),  styles: cellStyle({ halign: 'right' }) },
      { content: pctPY,               styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear),      styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
      { content: fmtPctVar(v.vsPrevYearPct), styles: cellStyle({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

export function exportPLToPDF(
  monthResult: PLMonthResult,
  yearResult:  PLYearResult,
  year:        number,
  month:       number,
  mode: 'budget_pl' | 'monthly' | 'yearly' = 'budget_pl',
): void {
  const doc  = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const now  = new Date().toLocaleDateString('de-CH');
  const mLabel = MONTH_NAMES_SHORT_DE[month] + ' ' + year;
  const PAGE_W = 297;

  // Revenue bases für % Berechnungen
  const revA  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.actual;
  const revB  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.budget;
  const revPY = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.prevYear;

  // Welche Seite zuerst (aktive Ansicht)
  const pageOrder: Array<'budget_pl' | 'monthly' | 'yearly'> =
    mode === 'yearly'  ? ['yearly', 'budget_pl', 'monthly'] :
    mode === 'monthly' ? ['monthly', 'budget_pl', 'yearly'] :
                         ['budget_pl', 'monthly', 'yearly'];

  let firstPage = true;

  for (const page of pageOrder) {

    // ──── Budget P&L ─────────────────────────────────────────────────────────
    if (page === 'budget_pl') {
      if (!firstPage) doc.addPage('a4', 'landscape');
      firstPage = false;

      const yH = addPageHeader(doc, `Erfolgsrechnung – Budget P&L`, `${mLabel} · Exportiert ${now}`, PAGE_W);
      const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

      const bplBody = buildBPLBody(monthResult.rows, revA, revB, revPY);

      autoTable(doc, {
        startY: yK,
        head: [[
          'Position',
          'Ist (CHF)', 'Ist %',
          'Budget (CHF)', 'Bud %',
          'Abw. Bud CHF', 'Abw. Bud %',
          'VJ (CHF)', 'VJ %',
          'Abw. VJ CHF', 'Abw. VJ %',
        ]],
        body: bplBody as string[][],
        theme: 'plain',
        headStyles: {
          fillColor: C.navyLight, textColor: C.white,
          fontStyle: 'bold', fontSize: 7,
          cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
        },
        bodyStyles: { fontSize: 6.5, cellPadding: { top: 1.1, bottom: 1.1, left: 2, right: 1.5 } },
        alternateRowStyles: { fillColor: C.slateLight },
        columnStyles: {
          0:  { cellWidth: 55 },
          1:  { halign: 'right', cellWidth: 22 },
          2:  { halign: 'right', cellWidth: 13 },
          3:  { halign: 'right', cellWidth: 22 },
          4:  { halign: 'right', cellWidth: 13 },
          5:  { halign: 'right', cellWidth: 22 },
          6:  { halign: 'right', cellWidth: 15 },
          7:  { halign: 'right', cellWidth: 22 },
          8:  { halign: 'right', cellWidth: 13 },
          9:  { halign: 'right', cellWidth: 22 },
          10: { halign: 'right', cellWidth: 15 },
        },
        didParseCell: (data) => {
          // Spacer-Zeilen (section mit colSpan) sauber darstellen
          if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
            const first = (data.row.raw as any[])[0];
            if (first?.styles?.colSpan === 11) {
              data.cell.styles.fillColor = C.navy;
            }
          }
        },
      });
    }

    // ──── Klassisch ──────────────────────────────────────────────────────────
    else if (page === 'monthly') {
      if (!firstPage) doc.addPage('a4', 'landscape');
      firstPage = false;

      const yH = addPageHeader(doc, `Erfolgsrechnung – Monatsansicht`, `${mLabel} · Exportiert ${now}`, PAGE_W);
      const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

      const klassBody = buildKlassischBody(monthResult.rows, revA, revPY);

      autoTable(doc, {
        startY: yK,
        head: [['Position', 'Ist (CHF)', 'Ist %', 'Vorjahr (CHF)', 'VJ %', 'Abw. VJ CHF', 'Abw. VJ %']],
        body: klassBody as string[][],
        theme: 'plain',
        headStyles: {
          fillColor: C.navyLight, textColor: C.white,
          fontStyle: 'bold', fontSize: 7,
          cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
        },
        bodyStyles: { fontSize: 6.5, cellPadding: { top: 1.1, bottom: 1.1, left: 2, right: 1.5 } },
        alternateRowStyles: { fillColor: C.slateLight },
        columnStyles: {
          0: { cellWidth: 70 },
          1: { halign: 'right', cellWidth: 30 },
          2: { halign: 'right', cellWidth: 16 },
          3: { halign: 'right', cellWidth: 30 },
          4: { halign: 'right', cellWidth: 16 },
          5: { halign: 'right', cellWidth: 28 },
          6: { halign: 'right', cellWidth: 18 },
        },
      });
    }

    // ──── Jahresübersicht ────────────────────────────────────────────────────
    else if (page === 'yearly') {
      if (!firstPage) doc.addPage('a4', 'landscape');
      firstPage = false;

      const yH = addPageHeader(doc, `Jahresübersicht ${year}`, `Exportiert ${now}`, PAGE_W);

      // Key-Zeilen für die Jahresübersicht
      const KEY_ROWS: { id: string; isPct?: boolean; pctLabel?: string }[] = [
        { id: 'revenue_total' },
        { id: 'total_cogs',      isPct: true, pctLabel: 'Warenkosten %' },
        { id: 'gross_profit_1',  isPct: true, pctLabel: 'Bruttogewinn 1 %' },
        { id: 'personnel_wages', isPct: true, pctLabel: 'Personalquote %' },
        { id: 'total_personnel', isPct: true, pctLabel: 'Total Personal %' },
        { id: 'gross_profit_2',  isPct: true, pctLabel: 'Deckungsbeitrag %' },
        { id: 'total_opex' },
        { id: 'ebitda',          isPct: true, pctLabel: 'EBITDA %' },
        { id: 'ebit',            isPct: true, pctLabel: 'EBIT %' },
      ];

      const months = yearResult.months;
      const monthCols = months.map((_, i) => MONTH_NAMES_SHORT_DE[i + 1]);

      // Revenue pro Monat (für % Berechnung)
      const monthRevenues = months.map(mr =>
        mr.rows.find(r => r.def.id === 'net_revenue')?.values.actual
      );
      const totalRevenue = yearResult.total.rows.find(r => r.def.id === 'net_revenue')?.values.actual;

      type YearCell = string | { content: string; styles: Record<string, unknown> };
      const yearBody: YearCell[][] = [];

      for (const keyRow of KEY_ROWS) {
        const template = monthResult.rows.find(r => r.def.id === keyRow.id);
        if (!template) continue;

        const isResult   = template.def.type === 'result';
        const isSubtotal = template.def.type === 'subtotal';
        const isExp      = isExpenseRow(template);
        const bold       = isResult || isSubtotal ? 'bold' : 'normal';
        const fillColor  = isResult   ? C.navyMid
                         : isSubtotal ? [235, 238, 248] as [number,number,number]
                         : undefined;
        const textColor  = isResult ? C.white : undefined;

        const label = indent(template) + template.def.label;

        const cellStyle = (extra: Record<string, unknown> = {}) => ({
          fontStyle: bold,
          ...(fillColor ? { fillColor } : {}),
          ...(textColor ? { textColor } : {}),
          ...extra,
        });

        // CHF-Zeile
        const chfCells: YearCell[] = months.map((mr, i) => {
          const row = mr.rows.find(r => r.def.id === keyRow.id);
          const v   = row?.values.actual;
          const prevY = row?.values.prevYear;
          const abwVJ = (v != null && prevY != null) ? v - prevY : undefined;
          const color  = varColor(abwVJ, isExp);
          const cell = { content: fmtCHF(v), styles: cellStyle({ halign: 'right' }) };
          return cell;
        });

        const totalRow = yearResult.total.rows.find(r => r.def.id === keyRow.id);
        const totalV   = totalRow?.values.actual;

        yearBody.push([
          { content: label, styles: cellStyle() },
          ...chfCells,
          { content: fmtCHF(totalV), styles: cellStyle({ halign: 'right', fontStyle: 'bold' }) },
        ]);

        // %-Zeile (direkt darunter)
        if (keyRow.isPct) {
          const pctCells: YearCell[] = months.map((mr, i) => {
            const row   = mr.rows.find(r => r.def.id === keyRow.id);
            const v     = row?.values.actual;
            const revBase = monthRevenues[i];
            const pct   = fmtPctRatio(v, revBase);
            return {
              content: pct,
              styles: {
                halign: 'right', fontStyle: 'normal' as const,
                fontSize: 6, textColor: isResult ? C.white : C.gray,
                fillColor: isResult ? C.navyMid : [248, 249, 253] as [number,number,number],
              },
            };
          });

          const totalPct = fmtPctRatio(totalV, totalRevenue);

          yearBody.push([
            {
              content: `  ${keyRow.pctLabel ?? '% Umsatz'}`,
              styles: {
                fontStyle: 'italic' as const, fontSize: 6,
                textColor: isResult ? C.white : C.gray,
                fillColor: isResult ? C.navyMid : [248, 249, 253] as [number,number,number],
              },
            },
            ...pctCells,
            {
              content: totalPct,
              styles: {
                halign: 'right', fontStyle: 'bold' as const, fontSize: 6,
                textColor: isResult ? C.white : C.gray,
                fillColor: isResult ? C.navyMid : [248, 249, 253] as [number,number,number],
              },
            },
          ]);
        }
      }

      const labelW = 46;
      const colW   = 17;
      autoTable(doc, {
        startY: yH,
        head: [['Position', ...monthCols, 'Total']],
        body: yearBody as string[][],
        theme: 'plain',
        headStyles: {
          fillColor: C.navyLight, textColor: C.white,
          fontStyle: 'bold', fontSize: 7,
          cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
        },
        bodyStyles: { fontSize: 6.5, cellPadding: { top: 1, bottom: 1, left: 1.5, right: 1.5 } },
        columnStyles: {
          0: { cellWidth: labelW },
          ...Object.fromEntries(
            Array.from({ length: 13 }, (_, i) => [i + 1, { halign: 'right', cellWidth: colW }])
          ),
        },
      });
    }
  }

  // Seitenzahlen
  const totalPages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C.gray);
    doc.text(`Seite ${p} / ${totalPages}`, PAGE_W - 12, 205, { align: 'right' });
    doc.text(`Oliv Gastro AG · Erfolgsrechnung ${year} · ${now}`, 12, 205);
  }

  doc.save(`Erfolgsrechnung_${year}_${MONTH_NAMES_SHORT_DE[month]}.pdf`);
}
