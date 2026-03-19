import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PLMonthResult, PLYearResult, PLComputedRow } from '@/types/pl';
import { MONTH_NAMES_SHORT_DE } from '@/types/reporting';

const CHF = (v: number | undefined | null): string => {
  if (v == null || v === 0) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
};

const PCT = (v: number | undefined | null): string =>
  v == null ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;

const SECTION_COLOR: [number, number, number] = [30, 30, 60];
const RESULT_COLOR: [number, number, number] = [60, 60, 100];
const HEADER_COLOR: [number, number, number] = [50, 50, 80];

type RowMeta = { isSection: boolean; isResult: boolean; label: string };

function getRowMeta(row: PLComputedRow): RowMeta {
  return {
    isSection: row.def.type === 'section',
    isResult:  row.def.type === 'result' || row.def.type === 'subtotal',
    label:     '  '.repeat(row.def.indent) + row.def.label,
  };
}

function addPageHeader(doc: jsPDF, title: string, sub: string, startY: number = 14): number {
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(20, 20, 60);
  doc.text(`Oliv Gastro AG – ${title}`, 10, startY);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(sub, 10, startY + 5);
  doc.setTextColor(0);
  return startY + 10;
}

export function exportPLToPDF(
  monthResult: PLMonthResult,
  yearResult: PLYearResult,
  year: number,
  month: number,
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const now = new Date().toLocaleDateString('de-CH');
  const mLabel = MONTH_NAMES_SHORT_DE[month] + ' ' + year;

  // ──── Seite 1: Budget P&L ────────────────────────────────────────────────────
  const y1 = addPageHeader(doc, 'Erfolgsrechnung – Budget P&L', `${mLabel} · Export ${now}`);

  const bplBody: (string | { content: string; styles: object })[][] = [];
  for (const row of monthResult.rows) {
    if (row.def.type === 'separator') continue;
    const { isSection, isResult, label } = getRowMeta(row);
    const v = row.values;
    if (isSection) {
      bplBody.push([
        { content: label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: SECTION_COLOR, textColor: [255, 255, 255] } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
      ]);
    } else {
      const actFmt  = CHF(v.actual);
      const budFmt  = CHF(v.budget);
      const diffAbs = v.vsBudget != null ? CHF(v.vsBudget) : '';
      const diffPct = v.vsBudgetPct != null ? PCT(v.vsBudgetPct) : '';
      bplBody.push([
        { content: label, styles: { fontStyle: isResult ? 'bold' : 'normal' } },
        { content: actFmt,  styles: { halign: 'right' as const, fontStyle: isResult ? 'bold' : 'normal' } },
        { content: budFmt,  styles: { halign: 'right' as const } },
        { content: diffAbs, styles: { halign: 'right' as const, textColor: v.vsBudget != null && v.vsBudget < 0 ? [180, 40, 40] : [40, 130, 40] } },
        { content: diffPct, styles: { halign: 'right' as const, textColor: v.vsBudgetPct != null && v.vsBudgetPct < 0 ? [180, 40, 40] : [40, 130, 40] } },
      ]);
    }
  }

  autoTable(doc, {
    startY: y1,
    head: [['Position', 'Ist', 'Budget', 'Abw. CHF', 'Abw. %']],
    body: bplBody as string[][],
    theme: 'plain',
    headStyles: { fillColor: HEADER_COLOR, textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
    columnStyles: {
      0: { cellWidth: 80 },
      1: { halign: 'right', cellWidth: 26 },
      2: { halign: 'right', cellWidth: 26 },
      3: { halign: 'right', cellWidth: 26 },
      4: { halign: 'right', cellWidth: 20 },
    },
  });

  // ──── Seite 2: Klassisch ─────────────────────────────────────────────────────
  doc.addPage('a4', 'portrait');
  const y2 = addPageHeader(doc, 'Erfolgsrechnung – Klassisch', `${mLabel} · Export ${now}`);

  const klassBody: (string | { content: string; styles: object })[][] = [];
  for (const row of monthResult.rows) {
    if (row.def.type === 'separator') continue;
    const { isSection, isResult, label } = getRowMeta(row);
    const v = row.values;
    if (isSection) {
      klassBody.push([
        { content: label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: SECTION_COLOR, textColor: [255, 255, 255] } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
        { content: '', styles: { fillColor: SECTION_COLOR } },
      ]);
    } else {
      klassBody.push([
        { content: label, styles: { fontStyle: isResult ? 'bold' : 'normal' } },
        { content: CHF(v.actual), styles: { halign: 'right' as const, fontStyle: isResult ? 'bold' : 'normal' } },
        { content: CHF(v.prevYear), styles: { halign: 'right' as const } },
        { content: v.vsPrevYearPct != null ? PCT(v.vsPrevYearPct) : '',
          styles: { halign: 'right' as const, textColor: v.vsPrevYearPct != null && v.vsPrevYearPct < 0 ? [180, 40, 40] : [40, 130, 40] } },
      ]);
    }
  }

  autoTable(doc, {
    startY: y2,
    head: [['Position', 'Ist', 'Vorjahr', 'VJ %']],
    body: klassBody as string[][],
    theme: 'plain',
    headStyles: { fillColor: HEADER_COLOR, textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
    columnStyles: {
      0: { cellWidth: 100 },
      1: { halign: 'right', cellWidth: 30 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 22 },
    },
  });

  // ──── Seite 3: Jahresübersicht (Landscape) ───────────────────────────────────
  doc.addPage('a4', 'landscape');
  const y3 = addPageHeader(doc, `Erfolgsrechnung – Jahresübersicht ${year}`, `Export ${now}`);

  const KEY_ROW_IDS = [
    'revenue_total', 'net_revenue',
    'food_cost', 'beverage_cost', 'gross_profit_1',
    'personnel_wages', 'gross_profit_2',
    'ebitda', 'ebit',
  ];

  const months = yearResult.months;
  const monthCols = months.map((_, i) => MONTH_NAMES_SHORT_DE[i + 1]);

  const yearHead = [['Position', ...monthCols, 'Total']];
  const yearBody: (string | { content: string; styles: object })[][] = [];

  for (const rowId of KEY_ROW_IDS) {
    const template = monthResult.rows.find(r => r.def.id === rowId);
    if (!template) continue;
    const isResult = template.def.type === 'result' || template.def.type === 'subtotal';
    const label = '  '.repeat(template.def.indent) + template.def.label;

    const monthVals = months.map(mr => {
      const row = mr.rows.find(r => r.def.id === rowId);
      const v = row?.values.actual;
      return { content: v != null ? CHF(v) : '–', styles: { halign: 'right' as const } };
    });

    const totalRow = yearResult.total.rows.find(r => r.def.id === rowId);
    const totalVal = totalRow?.values.actual;

    yearBody.push([
      { content: label, styles: { fontStyle: isResult ? 'bold' : 'normal' } },
      ...monthVals,
      { content: totalVal != null ? CHF(totalVal) : '–', styles: { halign: 'right' as const, fontStyle: 'bold' } },
    ]);
  }

  const colW = 18;
  autoTable(doc, {
    startY: y3,
    head: yearHead,
    body: yearBody as string[][],
    theme: 'striped',
    headStyles: { fillColor: HEADER_COLOR, textColor: 255, fontStyle: 'bold', fontSize: 7 },
    bodyStyles: { fontSize: 6.5, cellPadding: { top: 1, bottom: 1, left: 1.5, right: 1.5 } },
    columnStyles: {
      0: { cellWidth: 55 },
      ...Object.fromEntries(
        Array.from({ length: 13 }, (_, i) => [i + 1, { halign: 'right' as const, cellWidth: colW }])
      ),
    },
  });

  doc.save(`Erfolgsrechnung_${year}_${MONTH_NAMES_SHORT_DE[month]}.pdf`);
}
