import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_SHORT_DE, MONTH_NAMES_DE } from '@/types/reporting';

// ─── Monatsdaten-Kompakt-Export ───────────────────────────────────────────────

export interface MonatsdatenRow {
  monat: string;
  umsatzIst: number | null;
  umsatzBudget: number | null;
  umsatzVorjahr: number | null;
  abwBudgetPct: number | null;
  abwVorjahrPct: number | null;
  warenaufwand: number | null;
  warenPct: number | null;
  personalaufwand: number | null;
  personalPct: number | null;
  pkIst: number | null;
  pkPlan: number | null;
  vollstaendigkeit: number;
}

const FCHF = (v: number | null | undefined): string =>
  v != null
    ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v)
    : '–';

const FPCT = (v: number | null | undefined): string =>
  v != null ? `${v.toFixed(1)} %` : '–';

const FABW = (v: number | null | undefined): string =>
  v != null ? `${v >= 0 ? '+' : ''}${v.toFixed(1)} %` : '';

function addPortraitHeader(doc: jsPDF, restaurantName: string, title: string, sub: string, pageW: number) {
  doc.setFillColor(30, 64, 175);
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(restaurantName, 10, 9);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(title, 10, 17);
  doc.text(sub, pageW - 10, 17, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

export function exportMonatsdatenToPDF(
  rows: MonatsdatenRow[],
  year: number,
  restaurantName: string,
  threshold = 40,
  tenantId = 'oliv',
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const now = new Date().toLocaleDateString('de-CH');

  addPortraitHeader(doc, restaurantName, `Monatsdaten ${year}`, `Exportiert am ${now}`, pageW);

  // ── Tabellendaten ────────────────────────────────────────────────────────

  const dataRows = rows.filter(r => r.monat !== 'Total');

  const body: string[][] = dataRows.map(r => {
    const abwVjStr  = r.abwVorjahrPct != null ? `\n${FABW(r.abwVorjahrPct)} vs VJ`  : '';
    const abwBdgStr = r.abwBudgetPct  != null ? `\n${FABW(r.abwBudgetPct)} vs Plan` : '';
    return [
      r.monat,
      r.umsatzIst   != null ? `${FCHF(r.umsatzIst)}${abwVjStr}`    : '–',
      r.umsatzBudget != null ? `${FCHF(r.umsatzBudget)}${abwBdgStr}` : '–',
      FCHF(r.umsatzVorjahr),
      FCHF(r.warenaufwand),
      FPCT(r.warenPct),
      FCHF(r.personalaufwand),
      FPCT(r.personalPct),
      FCHF(r.pkIst),
      FCHF(r.pkPlan),
      r.vollstaendigkeit > 0 ? `${Math.round(r.vollstaendigkeit)} %` : '–',
    ];
  });

  // ── Summenzeile ──────────────────────────────────────────────────────────

  const sumField = (key: keyof MonatsdatenRow): number | null => {
    const total = dataRows.reduce((s, r) => s + ((r[key] as number | null) ?? 0), 0);
    return total > 0 ? total : null;
  };

  const totalUmsatz    = sumField('umsatzIst');
  const totalBudget    = sumField('umsatzBudget');
  const totalVorjahr   = sumField('umsatzVorjahr');
  const totalWaren     = sumField('warenaufwand');
  const totalPersonal  = sumField('personalaufwand');
  const totalPkIst     = sumField('pkIst');
  const totalPkPlan    = sumField('pkPlan');

  const safeQ = (num: number | null, denom: number | null): number | null =>
    num && denom && denom > 1000 ? parseFloat(((num / denom) * 100).toFixed(1)) : null;
  const safeAbw = (a: number | null, b: number | null): number | null =>
    a != null && b != null && b !== 0 ? parseFloat((((a - b) / Math.abs(b)) * 100).toFixed(1)) : null;

  const totAbwVj  = safeAbw(totalUmsatz, totalVorjahr);
  const totAbwBdg = safeAbw(totalUmsatz, totalBudget);

  body.push([
    'Total',
    totalUmsatz != null ? `${FCHF(totalUmsatz)}${totAbwVj != null ? `\n${FABW(totAbwVj)} vs VJ` : ''}` : '–',
    totalBudget != null ? `${FCHF(totalBudget)}${totAbwBdg != null ? `\n${FABW(totAbwBdg)} vs Plan` : ''}` : '–',
    FCHF(totalVorjahr),
    FCHF(totalWaren),
    FPCT(safeQ(totalWaren, totalUmsatz)),
    FCHF(totalPersonal),
    FPCT(safeQ(totalPersonal, totalUmsatz)),
    FCHF(totalPkIst),
    FCHF(totalPkPlan),
    '',
  ]);

  // ── AutoTable ────────────────────────────────────────────────────────────

  const allRows = [...dataRows];

  autoTable(doc, {
    startY: 27,
    margin: { left: 10, right: 10 },
    tableWidth: 190,
    head: [[
      'Monat', 'Umsatz Ist', 'Budget', 'Vorjahr',
      'Warenaufw.', 'Waren %',
      'Personalaufw.', 'Personal %',
      'PK Ist', 'PK Plan', 'Vollst.',
    ]],
    body,
    theme: 'striped',
    headStyles: {
      fillColor: [30, 64, 175],
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 7,
      halign: 'center',
      cellPadding: { top: 2.5, bottom: 2.5, left: 1.5, right: 1.5 },
    },
    bodyStyles: {
      fontSize: 7.5,
      cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
    },
    columnStyles: {
      0:  { cellWidth: 13, halign: 'left',   fontStyle: 'bold' },
      1:  { cellWidth: 23, halign: 'right' },
      2:  { cellWidth: 20, halign: 'right',  textColor: [100, 100, 100] },
      3:  { cellWidth: 20, halign: 'right',  textColor: [100, 100, 100] },
      4:  { cellWidth: 21, halign: 'right' },
      5:  { cellWidth: 11, halign: 'right' },
      6:  { cellWidth: 21, halign: 'right' },
      7:  { cellWidth: 11, halign: 'right' },
      8:  { cellWidth: 19, halign: 'right',  textColor: [100, 100, 100] },
      9:  { cellWidth: 19, halign: 'right',  textColor: [100, 100, 100] },
      10: { cellWidth: 12, halign: 'center' },
    },
    didParseCell: (data) => {
      const rowIdx  = data.row.index;
      const colIdx  = data.column.index;
      const rawVal  = String(data.cell.raw ?? '');
      const isTotal = rowIdx === body.length - 1;

      if (isTotal && data.section === 'body') {
        data.cell.styles.fontStyle  = 'bold';
        data.cell.styles.fillColor  = [226, 232, 250] as [number, number, number];
        data.cell.styles.textColor  = [20, 20, 60] as [number, number, number];
        return;
      }

      if (data.section !== 'body') return;

      const row = allRows[rowIdx];

      // Umsatz Ist — Zellfarbe nach VJ-Abweichung
      if (colIdx === 1 && row) {
        const abwVj = row.abwVorjahrPct;
        if (abwVj != null) {
          data.cell.styles.textColor = abwVj >= 0
            ? ([21, 128, 61] as [number, number, number])
            : ([153, 27, 27] as [number, number, number]);
        }
      }

      // Budget — Zellfarbe nach Plan-Abweichung
      if (colIdx === 2 && row) {
        const abwBdg = row.abwBudgetPct;
        if (abwBdg != null && abwBdg !== 0) {
          data.cell.styles.textColor = abwBdg >= 0
            ? ([21, 128, 61] as [number, number, number])
            : ([153, 27, 27] as [number, number, number]);
        }
      }

      // Waren %
      if (colIdx === 5 && rawVal !== '–') {
        const num = parseFloat(rawVal);
        if (!isNaN(num)) {
          data.cell.styles.fontStyle  = 'bold';
          data.cell.styles.textColor  = num > 33
            ? ([153, 27, 27] as [number, number, number])
            : num > 28
              ? ([146, 64, 14] as [number, number, number])
              : ([21, 128, 61] as [number, number, number]);
        }
      }

      // Personal %
      if (colIdx === 7 && rawVal !== '–') {
        const num = parseFloat(rawVal);
        if (!isNaN(num)) {
          data.cell.styles.fontStyle  = 'bold';
          data.cell.styles.textColor  = num > threshold + 5
            ? ([153, 27, 27] as [number, number, number])
            : num > threshold
              ? ([146, 64, 14] as [number, number, number])
              : ([21, 128, 61] as [number, number, number]);
        }
      }

      // Vollständigkeit
      if (colIdx === 10 && rawVal !== '–' && rawVal !== '') {
        const num = parseFloat(rawVal);
        if (!isNaN(num)) {
          data.cell.styles.textColor  = num >= 80
            ? ([21, 128, 61] as [number, number, number])
            : num >= 50
              ? ([146, 64, 14] as [number, number, number])
              : ([153, 27, 27] as [number, number, number]);
          data.cell.styles.fontStyle  = 'bold';
        }
      }
    },
    showHead: 'everyPage',
  });

  // ── Fusszeile ────────────────────────────────────────────────────────────

  const finalY = (doc as any).lastAutoTable.finalY + 7;
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text(
    `PK-Ziel: ≤ ${threshold} %  ·  Waren-Ziel: ≤ 30 %  ·  Werte in CHF, exkl. MWST`,
    10, Math.min(finalY, 285),
  );
  doc.text(restaurantName, pageW - 10, Math.min(finalY, 285), { align: 'right' });

  // ── Seitennummern ────────────────────────────────────────────────────────

  const totalPagesCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= totalPagesCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(170, 170, 170);
    doc.text(`Seite ${i} / ${totalPagesCount}`, pageW / 2, 291, { align: 'center' });
  }

  const slug = tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv';
  doc.save(`${slug}_Monatsdaten_${year}.pdf`);
}

const CHF = (v: number | undefined | null) =>
  v != null && v !== 0
    ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v)
    : '–';

const PCT = (v: number | null | undefined) =>
  v != null && v > 0 ? `${v.toFixed(1)} %` : '–';

export interface ReportingTotals {
  revenueActual: number;
  revenueBudget: number;
  revenuePreviousYear: number;
  personnelCostActual: number;
  personnelCostPlanned: number;
}

export function calcEffectiveTotals(months: MonthlyFinancialRecord[]): ReportingTotals {
  return months.reduce((acc, m) => ({
    revenueActual:       acc.revenueActual       + (m.revenueActual       ?? 0),
    revenueBudget:       acc.revenueBudget       + (m.revenueBudget       ?? 0),
    revenuePreviousYear: acc.revenuePreviousYear + (m.revenuePreviousYear ?? 0),
    personnelCostActual: acc.personnelCostActual + (m.personnelCostActual ?? 0),
    personnelCostPlanned:acc.personnelCostPlanned+ (m.personnelCostPlanned ?? 0),
  }), { revenueActual: 0, revenueBudget: 0, revenuePreviousYear: 0, personnelCostActual: 0, personnelCostPlanned: 0 });
}

function addPageHeader(doc: jsPDF, title: string, subtitle: string, pageW: number) {
  doc.setFillColor(30, 64, 175);
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('Oliv Gastro AG', 14, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(title, 14, 17);
  doc.setFontSize(9);
  doc.text(subtitle, pageW - 14, 17, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

export function exportReportingToPDF(
  months: MonthlyFinancialRecord[],
  totals: ReportingTotals,
  year: number,
  threshold = 40,
) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const now = new Date().toLocaleDateString('de-CH');

  const monthsWithData = months.filter(m =>
    m.revenueActual !== undefined || m.personnelCostActual !== undefined
  );
  const pkRatioTotal = totals.revenueActual > 0
    ? (totals.personnelCostActual / totals.revenueActual) * 100
    : 0;

  // ── SEITE 1: Jahres-KPI ────────────────────────────────────────────
  addPageHeader(doc, `Jahresbericht ${year}`, `Exportiert am ${now}`, pageW);

  // Grosse KPI-Kacheln
  const kpiData = [
    { label: 'Umsatz Ist', value: CHF(totals.revenueActual), sub: `Budget: ${CHF(totals.revenueBudget)}`, color: [219, 234, 254] as [number,number,number], textColor: [30,64,175] as [number,number,number] },
    { label: 'Umsatz Vorjahr', value: CHF(totals.revenuePreviousYear), sub: totals.revenuePreviousYear && totals.revenueActual ? `YoY: ${((totals.revenueActual / totals.revenuePreviousYear - 1) * 100).toFixed(1)} %` : '', color: [224,242,254] as [number,number,number], textColor: [2,132,199] as [number,number,number] },
    { label: 'PK Ist', value: CHF(totals.personnelCostActual), sub: `Geplant: ${CHF(totals.personnelCostPlanned)}`, color: [254,243,199] as [number,number,number], textColor: [146,64,14] as [number,number,number] },
    { label: 'PK-Quote', value: PCT(pkRatioTotal), sub: `Ziel: ≤ ${threshold} %`, color: pkRatioTotal > threshold ? [254,226,226] as [number,number,number] : [220,252,231] as [number,number,number], textColor: pkRatioTotal > threshold ? [153,27,27] as [number,number,number] : [21,128,61] as [number,number,number] },
  ];

  const kpiW = (pageW - 28 - 9) / 4;
  const kpiY = 30;
  kpiData.forEach((kpi, i) => {
    const x = 14 + i * (kpiW + 3);
    doc.setFillColor(...kpi.color);
    doc.roundedRect(x, kpiY, kpiW, 30, 2, 2, 'F');
    doc.setTextColor(...kpi.textColor);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(kpi.label, x + 4, kpiY + 8);
    doc.setFontSize(16);
    doc.text(kpi.value, x + 4, kpiY + 20);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    if (kpi.sub) doc.text(kpi.sub, x + 4, kpiY + 27);
  });

  // Monate-mit-Daten Indikator
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(8);
  doc.text(`${monthsWithData.length} von 12 Monaten mit Daten`, 14, kpiY + 38);

  // Kompakte Jahresübersicht-Tabelle
  const head1 = [['Monat', 'Umsatz Ist', 'Budget', 'Abw. Budget', 'Vorjahr', 'Abw. VJ', 'PK Ist', 'PK Geplant', 'PK-Quote']];
  const body1: (string | number)[][] = months.map(m => {
    const abwBudget = m.revenueActual != null && m.revenueBudget != null && m.revenueBudget > 0
      ? ((m.revenueActual / m.revenueBudget - 1) * 100) : null;
    const abwVJ = m.revenueActual != null && m.revenuePreviousYear != null && m.revenuePreviousYear > 0
      ? ((m.revenueActual / m.revenuePreviousYear - 1) * 100) : null;
    const pkQ = m.revenueActual && m.personnelCostActual
      ? (m.personnelCostActual / m.revenueActual) * 100 : null;
    return [
      MONTH_NAMES_SHORT_DE[m.month],
      CHF(m.revenueActual),
      CHF(m.revenueBudget),
      abwBudget != null ? `${abwBudget >= 0 ? '+' : ''}${abwBudget.toFixed(1)} %` : '–',
      CHF(m.revenuePreviousYear),
      abwVJ != null ? `${abwVJ >= 0 ? '+' : ''}${abwVJ.toFixed(1)} %` : '–',
      CHF(m.personnelCostActual),
      CHF(m.personnelCostPlanned),
      pkQ != null ? `${pkQ.toFixed(1)} %` : '–',
    ];
  });
  body1.push([
    'Total',
    CHF(totals.revenueActual),
    CHF(totals.revenueBudget),
    totals.revenueBudget > 0 ? `${((totals.revenueActual / totals.revenueBudget - 1) * 100).toFixed(1)} %` : '–',
    CHF(totals.revenuePreviousYear),
    totals.revenuePreviousYear > 0 ? `${((totals.revenueActual / totals.revenuePreviousYear - 1) * 100).toFixed(1)} %` : '–',
    CHF(totals.personnelCostActual),
    CHF(totals.personnelCostPlanned),
    pkRatioTotal > 0 ? `${pkRatioTotal.toFixed(1)} %` : '–',
  ]);

  autoTable(doc, {
    startY: kpiY + 42,
    head: head1,
    body: body1,
    theme: 'striped',
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles: { fontSize: 7.5 },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right' },
    },
    didParseCell: (data) => {
      const rowIdx = data.row.index;
      const colIdx = data.column.index;
      const isTotal = rowIdx === body1.length - 1;
      if (isTotal) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 245];
        data.cell.styles.textColor = [20, 20, 60];
      }
      if (!isTotal && data.section === 'body') {
        const rawVal = String(data.cell.raw ?? '');
        if ((colIdx === 3 || colIdx === 5) && rawVal !== '–') {
          const num = parseFloat(rawVal);
          if (!isNaN(num)) {
            if (num >= 0) {
              data.cell.styles.textColor = [21, 128, 61];
            } else {
              data.cell.styles.textColor = [153, 27, 27];
            }
          }
        }
        if (colIdx === 8 && rawVal !== '–') {
          const num = parseFloat(rawVal);
          if (!isNaN(num)) {
            if (num > threshold + 2) {
              data.cell.styles.fillColor = [254, 226, 226];
              data.cell.styles.textColor = [153, 27, 27];
              data.cell.styles.fontStyle = 'bold';
            } else if (num > threshold - 2) {
              data.cell.styles.fillColor = [254, 243, 199];
              data.cell.styles.textColor = [146, 64, 14];
            } else {
              data.cell.styles.fillColor = [220, 252, 231];
              data.cell.styles.textColor = [21, 128, 61];
            }
          }
        }
      }
    },
  });

  // ── SEITE 2: PK-Analyse ────────────────────────────────────────────
  doc.addPage();
  addPageHeader(doc, `Personalkosten-Analyse ${year}`, `Ziel: ≤ ${threshold} %`, pageW);

  // PK-Ampel Tabelle
  const head2 = [['Monat', 'Umsatz Ist', 'PK Ist', 'PK Geplant', 'PK-Quote Ist', 'PK-Quote Geplant', 'Abw. PK', 'Status']];
  const body2: (string | number)[][] = months.map(m => {
    const pkQ = m.revenueActual && m.personnelCostActual
      ? (m.personnelCostActual / m.revenueActual) * 100 : null;
    const pkQPlan = m.revenueActual && m.personnelCostPlanned
      ? (m.personnelCostPlanned / m.revenueActual) * 100 : null;
    const abwPK = m.personnelCostActual != null && m.personnelCostPlanned != null
      ? m.personnelCostActual - m.personnelCostPlanned : null;
    let status = '–';
    if (pkQ != null) {
      if (pkQ <= threshold - 2) status = '✓ Gut';
      else if (pkQ <= threshold + 2) status = '≈ OK';
      else status = '↑ Hoch';
    }
    return [
      MONTH_NAMES_DE[m.month] ?? MONTH_NAMES_SHORT_DE[m.month],
      CHF(m.revenueActual),
      CHF(m.personnelCostActual),
      CHF(m.personnelCostPlanned),
      pkQ != null ? `${pkQ.toFixed(1)} %` : '–',
      pkQPlan != null ? `${pkQPlan.toFixed(1)} %` : '–',
      abwPK != null ? CHF(abwPK) : '–',
      status,
    ];
  });

  autoTable(doc, {
    startY: 28,
    head: head2,
    body: body2,
    theme: 'grid',
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'center', fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const colIdx = data.column.index;
      const rawVal = String(data.cell.raw ?? '');
      if (colIdx === 4 && rawVal !== '–') {
        const num = parseFloat(rawVal);
        if (!isNaN(num)) {
          if (num > threshold + 2) {
            data.cell.styles.fillColor = [254, 226, 226];
            data.cell.styles.textColor = [153, 27, 27];
          } else if (num > threshold - 2) {
            data.cell.styles.fillColor = [254, 243, 199];
            data.cell.styles.textColor = [146, 64, 14];
          } else {
            data.cell.styles.fillColor = [220, 252, 231];
            data.cell.styles.textColor = [21, 128, 61];
          }
        }
      }
      if (colIdx === 7) {
        if (rawVal.startsWith('✓')) {
          data.cell.styles.fillColor = [220, 252, 231];
          data.cell.styles.textColor = [21, 128, 61];
        } else if (rawVal.startsWith('≈')) {
          data.cell.styles.fillColor = [254, 243, 199];
          data.cell.styles.textColor = [146, 64, 14];
        } else if (rawVal.startsWith('↑')) {
          data.cell.styles.fillColor = [254, 226, 226];
          data.cell.styles.textColor = [153, 27, 27];
        }
      }
      if (colIdx === 6 && rawVal !== '–') {
        const num = parseFloat(rawVal.replace(/[^0-9.-]/g, ''));
        if (!isNaN(num)) {
          data.cell.styles.textColor = num > 0 ? [153, 27, 27] : [21, 128, 61];
        }
      }
    },
  });

  // Legende
  const legendY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('Legende:', 14, legendY);
  doc.setFont('helvetica', 'normal');

  const legends = [
    { color: [220, 252, 231] as [number,number,number], text: `✓ Gut = PK-Quote ≤ ${threshold - 2} %` },
    { color: [254, 243, 199] as [number,number,number], text: `≈ OK = PK-Quote ${threshold - 2}–${threshold + 2} %` },
    { color: [254, 226, 226] as [number,number,number], text: `↑ Hoch = PK-Quote > ${threshold + 2} %` },
  ];
  legends.forEach((l, i) => {
    const lx = 14 + i * 70;
    doc.setFillColor(...l.color);
    doc.rect(lx, legendY + 3, 8, 5, 'F');
    doc.setTextColor(0);
    doc.text(l.text, lx + 10, legendY + 7);
  });

  // ── SEITE 3: Umsatz-Detail pro Monat ──────────────────────────────
  doc.addPage();
  addPageHeader(doc, `Umsatzentwicklung ${year}`, `Exportiert am ${now}`, pageW);

  const head3 = [['Monat', 'Umsatz Ist', 'Budget', 'Abw. abs.', 'Abw. %', 'Vorjahr', 'YoY abs.', 'YoY %', 'Notizen']];
  const body3: (string | number)[][] = months.map(m => {
    const abwAbs = m.revenueActual != null && m.revenueBudget != null
      ? m.revenueActual - m.revenueBudget : null;
    const abwPct = m.revenueBudget && m.revenueActual
      ? ((m.revenueActual / m.revenueBudget - 1) * 100) : null;
    const yoyAbs = m.revenueActual != null && m.revenuePreviousYear != null
      ? m.revenueActual - m.revenuePreviousYear : null;
    const yoyPct = m.revenuePreviousYear && m.revenueActual
      ? ((m.revenueActual / m.revenuePreviousYear - 1) * 100) : null;
    return [
      MONTH_NAMES_DE[m.month] ?? MONTH_NAMES_SHORT_DE[m.month],
      CHF(m.revenueActual),
      CHF(m.revenueBudget),
      abwAbs != null ? CHF(abwAbs) : '–',
      abwPct != null ? `${abwPct >= 0 ? '+' : ''}${abwPct.toFixed(1)} %` : '–',
      CHF(m.revenuePreviousYear),
      yoyAbs != null ? CHF(yoyAbs) : '–',
      yoyPct != null ? `${yoyPct >= 0 ? '+' : ''}${yoyPct.toFixed(1)} %` : '–',
      m.notes ?? '',
    ];
  });
  body3.push([
    'Total',
    CHF(totals.revenueActual),
    CHF(totals.revenueBudget),
    CHF(totals.revenueActual - totals.revenueBudget),
    totals.revenueBudget > 0 ? `${((totals.revenueActual / totals.revenueBudget - 1) * 100).toFixed(1)} %` : '–',
    CHF(totals.revenuePreviousYear),
    CHF(totals.revenueActual - totals.revenuePreviousYear),
    totals.revenuePreviousYear > 0 ? `${((totals.revenueActual / totals.revenuePreviousYear - 1) * 100).toFixed(1)} %` : '–',
    '',
  ]);

  autoTable(doc, {
    startY: 28,
    head: head3,
    body: body3,
    theme: 'striped',
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'left', cellWidth: 40 },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const rowIdx = data.row.index;
      const isTotal = rowIdx === body3.length - 1;
      if (isTotal) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 245];
        data.cell.styles.textColor = [20, 20, 60];
        return;
      }
      const colIdx = data.column.index;
      const rawVal = String(data.cell.raw ?? '');
      if ((colIdx === 4 || colIdx === 7) && rawVal !== '–') {
        const num = parseFloat(rawVal);
        if (!isNaN(num)) {
          data.cell.styles.textColor = num >= 0 ? [21, 128, 61] : [153, 27, 27];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });

  doc.save(`Reporting_${year}.pdf`);
}

export function exportReportingToExcel(
  months: MonthlyFinancialRecord[],
  totals: ReportingTotals,
  year: number,
) {
  const numFmt = '#\'##0.00" CHF"';

  const rows: (string | number | null)[][] = [
    ['Oliv Gastro AG – Reporting', year],
    [],
    ['Monat', 'Umsatz Ist', 'Budget', 'Vorjahr', 'PK Ist', 'PK Geplant', 'PK-Quote %'],
    ...months.map(m => {
      const pkQ = m.revenueActual && m.personnelCostActual
        ? Math.round((m.personnelCostActual / m.revenueActual) * 1000) / 10
        : null;
      return [
        MONTH_NAMES_SHORT_DE[m.month],
        m.revenueActual ?? null,
        m.revenueBudget ?? null,
        m.revenuePreviousYear ?? null,
        m.personnelCostActual ?? null,
        m.personnelCostPlanned ?? null,
        pkQ,
      ];
    }),
    [
      'Total',
      totals.revenueActual || null,
      totals.revenueBudget || null,
      totals.revenuePreviousYear || null,
      totals.personnelCostActual || null,
      totals.personnelCostPlanned || null,
      totals.revenueActual > 0 && totals.personnelCostActual > 0
        ? Math.round((totals.personnelCostActual / totals.revenueActual) * 1000) / 10
        : null,
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Reporting ${year}`);
  XLSX.writeFile(wb, `Reporting_${year}.xlsx`);
}
