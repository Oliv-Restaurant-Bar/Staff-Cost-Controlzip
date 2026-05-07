/**
 * pl-export.ts – Professioneller PDF-Export für die Erfolgsrechnung
 * ==================================================================
 *
 * Exportiert NUR die aktive Ansicht (eine Seite):
 *   budget_pl: Budget P&L  – Ist | Ist% | Budget | Bud% | Abw.Bud CHF | VJ | VJ% | Abw.VJ CHF
 *   monthly:   Klassisch   – Ist | Ist% | VJ | VJ% | Abw.VJ CHF
 *   yearly:    Jahresübersicht – 12 Monate + Total, CHF + % pro Kennzahl
 *
 * Farblogik:  Ertrag/Ergebnis: positiv = grün, negativ = rot.
 *             Aufwand-Abweichung: günstiger = grün, teurer = rot.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PLMonthResult, PLYearResult, PLComputedRow } from '@/types/pl';
import { MONTH_NAMES_SHORT_DE, MONTH_NAMES_DE } from '@/types/reporting';

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

/** Farbe für Abweichungszellen */
function varColor(
  value: number | undefined | null,
  isExpense: boolean,
): [number, number, number] {
  if (value == null || Math.abs(value) < 0.5) return C.gray;
  const positive = value > 0;
  return (positive !== isExpense) ? C.green : C.red;
}

/**
 * Farbe für Ist-Wert in Ergebnis- / Totalzeilen.
 * Nur für result/subtotal: positiv = grün, negativ = rot.
 */
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

// ── Seitenkopf ────────────────────────────────────────────────────────────────

/**
 * Prominenter Header: dunkler Navy-Block mit großem Monat/Jahr.
 * Returns y-position after the header.
 */
function addPageHeader(
  doc: jsPDF,
  title: string,
  subtitle: string,
  month: number,
  year: number,
  pageW: number,
  y = 8,
): number {
  const blockH = 24;
  doc.setFillColor(...C.navy);
  doc.rect(10, y, pageW - 20, blockH, 'F');

  // Kleine Kategorie-Zeile oben
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...C.navyHeader);
  doc.text(title.toUpperCase(), 15, y + 7);

  // Monat + Jahr – groß und fett
  const mFull = (MONTH_NAMES_DE[month] ?? MONTH_NAMES_SHORT_DE[month] ?? '').toUpperCase();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...C.white);
  doc.text(`${mFull} ${year}`, 15, y + 17);

  // Untertitel rechts (Firma + Datum)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...C.navyHeader);
  doc.text(subtitle, pageW - 12, y + 10, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  return y + blockH + 5;
}

// ── KPI-Sektion ───────────────────────────────────────────────────────────────

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
    label:    string;
    istCHF:   string;  istPct:  string;
    budCHF:   string;  budPct:  string;
    vjCHF:    string;  vjPct:   string;
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
      istCHF:  fmtCHF(a),
      istPct:  showPct ? fmtPctRatio(a,  revA) : '–',
      budCHF:  fmtCHF(b),
      budPct:  showPct ? fmtPctRatio(b,  revB) : '–',
      vjCHF:   fmtCHF(py),
      vjPct:   showPct ? fmtPctRatio(py, revPY) : '–',
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
    head: [[
      'Kennzahl',
      'Ist CHF', 'Ist %',
      'Budget CHF', 'Bud %',
      'Vorjahr CHF', 'VJ %',
    ]],
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
      1: { halign: 'right', cellWidth: 28 },
      2: { halign: 'right', cellWidth: 18 },
      3: { halign: 'right', cellWidth: 28 },
      4: { halign: 'right', cellWidth: 18 },
      5: { halign: 'right', cellWidth: 28 },
      6: { halign: 'right', cellWidth: 18 },
    },
  });

  return (doc as any).lastAutoTable.finalY + 6;
}

// ── Budget P&L Tabellenkörper (9 Spalten: ohne Abw.% Spalten) ─────────────────

function buildBPLBody(
  rows: PLComputedRow[],
  revA:  number | undefined,
  revB:  number | undefined,
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

    const istValColor = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor    = istValColor ?? baseTxtColor;
    const abwBudC     = varColor(v.vsBudget,   isExp);
    const abwVJC      = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor     ? { fillColor }               : {}),
      ...(baseTxtColor  ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    const pctA  = fmtPctRatio(v.actual,   revA);
    const pctB  = fmtPctRatio(v.budget,   revB);
    const pctPY = fmtPctRatio(v.prevYear, revPY);

    body.push([
      { content: label,              styles: cs() },
      { content: fmtCHF(v.actual),   styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: pctA,               styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.budget),   styles: cs({ halign: 'right' }) },
      { content: pctB,               styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsBudget), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwBudC }) },
      { content: fmtCHF(v.prevYear), styles: cs({ halign: 'right' }) },
      { content: pctPY,              styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Klassisch Tabellenkörper (6 Spalten: ohne Abw.VJ%) ───────────────────────

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

    const istValColor = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor    = istValColor ?? baseTxtColor;
    const abwVJC      = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    const pctA  = fmtPctRatio(v.actual,   revA);
    const pctPY = fmtPctRatio(v.prevYear, revPY);

    body.push([
      { content: label,                styles: cs() },
      { content: fmtCHF(v.actual),     styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: pctA,                 styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.prevYear),   styles: cs({ halign: 'right' }) },
      { content: pctPY,                styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
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
  const doc      = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const now      = new Date().toLocaleDateString('de-CH');
  const subtitle = `Oliv Gastro AG · Exportiert am ${now}`;
  const PAGE_W   = 297;

  const revA  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.actual;
  const revB  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.budget;
  const revPY = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.prevYear;

  // ──── Budget P&L ─────────────────────────────────────────────────────────
  if (mode === 'budget_pl') {
    const yH = addPageHeader(doc, 'Erfolgsrechnung – Budget P&L', subtitle, month, year, PAGE_W);
    const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

    const body = buildBPLBody(monthResult.rows, revA, revB, revPY);

    autoTable(doc, {
      startY: yK,
      head: [[
        'Position',
        'Ist CHF', 'Ist %',
        'Budget CHF', 'Bud %',
        'Abw. Budget',
        'Vorjahr CHF', 'VJ %',
        'Abw. VJ',
      ]],
      body: body as string[][],
      theme: 'plain',
      headStyles: {
        fillColor: C.navyLight, textColor: C.white,
        fontStyle: 'bold', fontSize: 7,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
      },
      bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
      alternateRowStyles: { fillColor: C.slateLight },
      columnStyles: {
        0: { cellWidth: 62 },
        1: { halign: 'right', cellWidth: 24 },
        2: { halign: 'right', cellWidth: 14 },
        3: { halign: 'right', cellWidth: 24 },
        4: { halign: 'right', cellWidth: 14 },
        5: { halign: 'right', cellWidth: 24 },
        6: { halign: 'right', cellWidth: 24 },
        7: { halign: 'right', cellWidth: 14 },
        8: { halign: 'right', cellWidth: 24 },
      },
      didParseCell: (data) => {
        if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
          const first = (data.row.raw as any[])[0];
          if (first?.styles?.colSpan === 9) data.cell.styles.fillColor = C.navy;
        }
      },
    });
  }

  // ──── Klassisch ──────────────────────────────────────────────────────────
  else if (mode === 'monthly') {
    const yH = addPageHeader(doc, 'Erfolgsrechnung – Monatsansicht', subtitle, month, year, PAGE_W);
    const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

    const body = buildKlassischBody(monthResult.rows, revA, revPY);

    autoTable(doc, {
      startY: yK,
      head: [['Position', 'Ist CHF', 'Ist %', 'Vorjahr CHF', 'VJ %', 'Abw. VJ']],
      body: body as string[][],
      theme: 'plain',
      headStyles: {
        fillColor: C.navyLight, textColor: C.white,
        fontStyle: 'bold', fontSize: 7,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
      },
      bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
      alternateRowStyles: { fillColor: C.slateLight },
      columnStyles: {
        0: { cellWidth: 90 },
        1: { halign: 'right', cellWidth: 34 },
        2: { halign: 'right', cellWidth: 18 },
        3: { halign: 'right', cellWidth: 34 },
        4: { halign: 'right', cellWidth: 18 },
        5: { halign: 'right', cellWidth: 34 },
      },
      didParseCell: (data) => {
        if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
          const first = (data.row.raw as any[])[0];
          if (first?.styles?.colSpan === 6) data.cell.styles.fillColor = C.navy;
        }
      },
    });
  }

  // ──── Jahresübersicht ────────────────────────────────────────────────────
  else if (mode === 'yearly') {
    const blockH = 24;
    doc.setFillColor(...C.navy);
    doc.rect(10, 8, PAGE_W - 20, blockH, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...C.navyHeader);
    doc.text('JAHRESÜBERSICHT', 15, 15);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(...C.white);
    doc.text(String(year), 15, 24);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...C.navyHeader);
    doc.text(subtitle, PAGE_W - 12, 18, { align: 'right' });
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
          const r   = mr.rows.find(row => row.def.id === keyRow.id);
          const v   = r?.values.actual;
          return { content: fmtPctRatio(v, monthRevs[i]), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'normal' as const } };
        });
        yearBody.push([
          { content: `  ${keyRow.pctLabel ?? '% Umsatz'}`, styles: pctRowStyle },
          ...pctCells,
          { content: fmtPctRatio(totalV, totalRevenue), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'bold' as const } },
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
