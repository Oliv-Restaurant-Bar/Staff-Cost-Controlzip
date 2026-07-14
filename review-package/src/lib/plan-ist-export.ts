import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

export interface PlanVsIstExportRow {
  empName: string;
  department: string;
  dateLabel: string;
  planHours: number;
  istHours: number;
  diffHours: number;
  planCost: number;
  istCost: number;
  diffCost: number;
}

export interface PlanVsIstExportOptions {
  rows: PlanVsIstExportRow[];
  title: string;
  periodLabel: string;
  filterLabel: string;
  departmentLabel: string;
  fileBaseName: string;
}

const fmtH = (n: number) => n.toFixed(1);
const fmtC = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const signStr = (n: number, thr = 0.05) => (n > thr ? '+' : '');

// ── RGB helpers ──────────────────────────────────────────────────────────────
const RED_LIGHT   = [255, 220, 220] as [number, number, number];
const GREEN_LIGHT = [220, 255, 220] as [number, number, number];
const HEADER_BG   = [40, 40, 60]   as [number, number, number];
const TOTAL_BG    = [230, 230, 240] as [number, number, number];

// ── PDF ──────────────────────────────────────────────────────────────────────
export const exportPlanVsIstPDF = (opts: PlanVsIstExportOptions): void => {
  const { rows, title, periodLabel, filterLabel, departmentLabel, fileBaseName } = opts;

  console.log('[EXPORT] type: pdf');
  console.log('[EXPORT] rows:', rows.length);
  console.log('[EXPORT] filters:', filterLabel);
  console.log('[EXPORT] period:', periodLabel);
  console.log('[EXPORT] department:', departmentLabel);

  const doc = new jsPDF({ orientation: 'landscape' });

  // ── Title block ──────────────────────────────────────────────────────────
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, 18);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100);
  doc.text(
    `Zeitraum: ${periodLabel}   |   Abteilung: ${departmentLabel}   |   Filter: ${filterLabel}`,
    14, 25,
  );

  const exportedAt = new Date().toLocaleString('de-CH');
  doc.text(`Exportiert am: ${exportedAt}`, 14, 30);
  doc.setTextColor(0);

  // ── Totals ───────────────────────────────────────────────────────────────
  const totPlanH = rows.reduce((s, r) => s + r.planHours, 0);
  const totIstH  = rows.reduce((s, r) => s + r.istHours,  0);
  const totDiffH = totIstH - totPlanH;
  const totPlanC = rows.reduce((s, r) => s + r.planCost,  0);
  const totIstC  = rows.reduce((s, r) => s + r.istCost,   0);
  const totDiffC = totIstC - totPlanC;

  // ── Table ────────────────────────────────────────────────────────────────
  const head = [[
    'Mitarbeiter', 'Abteilung', 'Datum',
    'Plan Std.', 'IST Std.', 'Diff Std.',
    'Plan CHF', 'IST CHF', 'Diff CHF',
  ]];

  const body: (string | { content: string; styles: object })[][] = rows.map(r => [
    r.empName,
    r.department,
    r.dateLabel,
    fmtH(r.planHours),
    fmtH(r.istHours),
    {
      content: `${signStr(r.diffHours)}${fmtH(r.diffHours)}`,
      styles: {
        textColor: r.diffHours > 0.05 ? [180, 0, 0] : r.diffHours < -0.05 ? [0, 130, 0] : [120, 120, 120],
        fontStyle: 'bold',
      },
    },
    fmtC(r.planCost),
    fmtC(r.istCost),
    {
      content: `${signStr(r.diffCost, 5)}${fmtC(r.diffCost)}`,
      styles: {
        textColor: r.diffCost > 5 ? [180, 0, 0] : r.diffCost < -5 ? [0, 130, 0] : [120, 120, 120],
        fontStyle: 'bold',
      },
    },
  ]);

  // Total row
  body.push([
    { content: 'Total', styles: { fontStyle: 'bold' } },
    '',
    '',
    { content: fmtH(totPlanH), styles: { fontStyle: 'bold' } },
    { content: fmtH(totIstH),  styles: { fontStyle: 'bold' } },
    {
      content: `${signStr(totDiffH)}${fmtH(totDiffH)}`,
      styles: {
        fontStyle: 'bold',
        textColor: totDiffH > 0.05 ? [180, 0, 0] : totDiffH < -0.05 ? [0, 130, 0] : [80, 80, 80],
        fillColor: TOTAL_BG,
      },
    },
    { content: fmtC(totPlanC), styles: { fontStyle: 'bold' } },
    { content: fmtC(totIstC),  styles: { fontStyle: 'bold' } },
    {
      content: `${signStr(totDiffC, 5)}${fmtC(totDiffC)}`,
      styles: {
        fontStyle: 'bold',
        textColor: totDiffC > 5 ? [180, 0, 0] : totDiffC < -5 ? [0, 130, 0] : [80, 80, 80],
        fillColor: TOTAL_BG,
      },
    },
  ]);

  autoTable(doc, {
    startY: 35,
    head,
    body,
    headStyles: {
      fillColor: HEADER_BG,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      halign: 'center',
    },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: 22, halign: 'center' },
      2: { cellWidth: 20, halign: 'center' },
      3: { cellWidth: 22, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 28, halign: 'right' },
      7: { cellWidth: 28, halign: 'right' },
      8: { cellWidth: 28, halign: 'right' },
    },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 248, 252] },
    didParseCell: (data) => {
      if (data.section === 'body') {
        const rowIdx = data.row.index;
        if (rowIdx < rows.length) {
          const r = rows[rowIdx];
          if (data.column.index === 5) {
            data.cell.styles.fillColor = r.diffHours > 0.05 ? RED_LIGHT : r.diffHours < -0.05 ? GREEN_LIGHT : undefined;
          }
          if (data.column.index === 8) {
            data.cell.styles.fillColor = r.diffCost > 5 ? RED_LIGHT : r.diffCost < -5 ? GREEN_LIGHT : undefined;
          }
        }
        if (rowIdx === rows.length) {
          data.cell.styles.fillColor = TOTAL_BG;
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
    margin: { left: 14, right: 14 },
  });

  doc.save(`${fileBaseName}.pdf`);
};

// ── Excel ─────────────────────────────────────────────────────────────────────
export const exportPlanVsIstExcel = async (opts: PlanVsIstExportOptions): Promise<void> => {
  const { rows, title, periodLabel, filterLabel, departmentLabel, fileBaseName } = opts;

  console.log('[EXPORT] type: excel');
  console.log('[EXPORT] rows:', rows.length);
  console.log('[EXPORT] filters:', filterLabel);
  console.log('[EXPORT] period:', periodLabel);
  console.log('[EXPORT] department:', departmentLabel);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Personalkostentracker';
  wb.created = new Date();

  const ws = wb.addWorksheet('Plan vs IST');

  // ── Meta rows ───────────────────────────────────────────────────────────
  ws.addRow([title]);
  ws.getRow(1).font = { bold: true, size: 13 };
  ws.addRow([`Zeitraum: ${periodLabel}   |   Abteilung: ${departmentLabel}   |   Filter: ${filterLabel}`]);
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF888888' } };
  ws.addRow([`Exportiert am: ${new Date().toLocaleString('de-CH')}`]);
  ws.getRow(3).font = { size: 8, color: { argb: 'FFAAAAAA' } };
  ws.addRow([]); // spacer

  // ── Header ──────────────────────────────────────────────────────────────
  const headerRow = ws.addRow([
    'Mitarbeiter', 'Abteilung', 'Datum',
    'Plan Std.', 'IST Std.', 'Diff Std.',
    'Plan CHF', 'IST CHF', 'Diff CHF',
  ]);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28283C' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } },
    };
  });

  // ── Data rows ────────────────────────────────────────────────────────────
  const RED_FILL:   ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDBDB' } };
  const GREEN_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4F5D4' } };
  const RED_FONT    = { bold: true, color: { argb: 'FFB40000' } };
  const GREEN_FONT  = { bold: true, color: { argb: 'FF007800' } };
  const GREY_FONT   = { bold: true, color: { argb: 'FF787878' } };

  rows.forEach((r, idx) => {
    const isZebraRow = idx % 2 !== 0;
    const dataRow = ws.addRow([
      r.empName,
      r.department,
      r.dateLabel,
      r.planHours,
      r.istHours,
      r.diffHours,
      r.planCost,
      r.istCost,
      r.diffCost,
    ]);

    dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (isZebraRow) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5FA' } };
      }
      // right-align numbers
      if (colNum >= 4) cell.alignment = { horizontal: 'right' };
      // hours: 1 decimal
      if (colNum === 4 || colNum === 5 || colNum === 6) {
        cell.numFmt = '#,##0.0';
      }
      // CHF: integer
      if (colNum === 7 || colNum === 8 || colNum === 9) {
        cell.numFmt = '#,##0';
      }
    });

    // Diff Std. (col 6)
    const diffHCell = dataRow.getCell(6);
    if (r.diffHours > 0.05) { diffHCell.font = RED_FONT;   diffHCell.fill = RED_FILL; }
    else if (r.diffHours < -0.05) { diffHCell.font = GREEN_FONT; diffHCell.fill = GREEN_FILL; }
    else { diffHCell.font = GREY_FONT; }

    // Diff CHF (col 9)
    const diffCCell = dataRow.getCell(9);
    if (r.diffCost > 5) { diffCCell.font = RED_FONT;   diffCCell.fill = RED_FILL; }
    else if (r.diffCost < -5) { diffCCell.font = GREEN_FONT; diffCCell.fill = GREEN_FILL; }
    else { diffCCell.font = GREY_FONT; }
  });

  // ── Total row ────────────────────────────────────────────────────────────
  const totPlanH = rows.reduce((s, r) => s + r.planHours, 0);
  const totIstH  = rows.reduce((s, r) => s + r.istHours,  0);
  const totDiffH = totIstH - totPlanH;
  const totPlanC = rows.reduce((s, r) => s + r.planCost,  0);
  const totIstC  = rows.reduce((s, r) => s + r.istCost,   0);
  const totDiffC = totIstC - totPlanC;

  const totalRow = ws.addRow([
    'Total', '', '', totPlanH, totIstH, totDiffH, totPlanC, totIstC, totDiffC,
  ]);
  totalRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6F0' } };
    cell.border = { top: { style: 'medium' } };
    if (colNum >= 4) cell.alignment = { horizontal: 'right' };
    if (colNum === 4 || colNum === 5 || colNum === 6) cell.numFmt = '#,##0.0';
    if (colNum === 7 || colNum === 8 || colNum === 9) cell.numFmt = '#,##0';
  });
  const tDiffHCell = totalRow.getCell(6);
  tDiffHCell.font = {
    bold: true,
    color: { argb: totDiffH > 0.05 ? 'FFB40000' : totDiffH < -0.05 ? 'FF007800' : 'FF787878' },
  };
  const tDiffCCell = totalRow.getCell(9);
  tDiffCCell.font = {
    bold: true,
    color: { argb: totDiffC > 5 ? 'FFB40000' : totDiffC < -5 ? 'FF007800' : 'FF787878' },
  };

  // ── Column widths ─────────────────────────────────────────────────────────
  ws.columns = [
    { width: 24 }, // Mitarbeiter
    { width: 12 }, // Abteilung
    { width: 11 }, // Datum
    { width: 11 }, // Plan Std.
    { width: 11 }, // IST Std.
    { width: 11 }, // Diff Std.
    { width: 12 }, // Plan CHF
    { width: 12 }, // IST CHF
    { width: 12 }, // Diff CHF
  ];

  // ── Download ──────────────────────────────────────────────────────────────
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileBaseName}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};
