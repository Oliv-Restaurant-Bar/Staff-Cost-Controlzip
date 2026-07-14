import ExcelJS from 'exceljs';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

interface PeriodData {
  label: string;
  shortLabel: string;
  actualRevenue: number;
  actualHours: number;
  actualCosts: number;
  laborQuota: number;
  previousRevenue: number;
  previousHours: number;
  previousCosts: number;
  previousQuota: number;
  revenueChange: number;
  hoursChange: number;
  costsChange: number;
  quotaChange: number;
  days: { date: string; revenue: number; hours: number; costs: number; quota: number }[];
}

interface AllPeriodData {
  day: PeriodData;
  week: PeriodData;
  month: PeriodData;
  year: PeriodData;
}

const formatCurrency = (value: number): string => 
  new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const formatHours = (value: number): string => value.toFixed(1);

const formatPercent = (value: number): string => value.toFixed(1);

export const exportActualPerformanceExcel = async (
  periodData: AllPeriodData,
  selectedDate: Date,
  showNetRevenue: boolean
): Promise<void> => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Personalkostentracker';
  workbook.created = new Date();

  const modeLabel = showNetRevenue ? 'Netto' : 'Brutto';

  // === Summary Sheet ===
  const summarySheet = workbook.addWorksheet('Zusammenfassung');
  
  // Header
  const titleRow = summarySheet.addRow([`Ist-Performance Übersicht (${modeLabel})`]);
  titleRow.font = { bold: true, size: 16 };
  summarySheet.mergeCells('A1:E1');
  
  const dateRow = summarySheet.addRow([`Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`]);
  dateRow.font = { size: 10, color: { argb: 'FF666666' } };
  
  summarySheet.addRow([]);
  
  // Summary Table
  const headerRow = summarySheet.addRow(['Periode', 'Ist-Umsatz (CHF)', 'Ist-Stunden', 'Personalkosten (CHF)', 'PKQ (%)']);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    cell.alignment = { horizontal: 'center' };
  });

  const periods: (keyof AllPeriodData)[] = ['day', 'week', 'month', 'year'];
  const periodLabels = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' };

  periods.forEach(period => {
    const data = periodData[period];
    const row = summarySheet.addRow([
      `${periodLabels[period]}: ${data.shortLabel}`,
      formatCurrency(data.actualRevenue),
      formatHours(data.actualHours),
      formatCurrency(data.actualCosts),
      formatPercent(data.laborQuota),
    ]);
    
    // Color code PKQ
    const pkqCell = row.getCell(5);
    if (data.laborQuota > 35) {
      pkqCell.font = { color: { argb: 'FFDC2626' } };
    } else if (data.laborQuota > 30) {
      pkqCell.font = { color: { argb: 'FFD97706' } };
    } else {
      pkqCell.font = { color: { argb: 'FF16A34A' } };
    }
    
    row.eachCell((cell, colNumber) => {
      if (colNumber >= 2) cell.alignment = { horizontal: 'right' };
    });
  });

  summarySheet.addRow([]);
  
  // Change comparison
  const changeHeaderRow = summarySheet.addRow(['Veränderung zur Vorperiode', 'Umsatz %', 'Stunden %', 'Kosten %', 'PKQ Δ']);
  changeHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  changeHeaderRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
    cell.alignment = { horizontal: 'center' };
  });

  periods.forEach(period => {
    const data = periodData[period];
    const row = summarySheet.addRow([
      periodLabels[period],
      `${data.revenueChange >= 0 ? '+' : ''}${formatPercent(data.revenueChange)}%`,
      `${data.hoursChange >= 0 ? '+' : ''}${formatPercent(data.hoursChange)}%`,
      `${data.costsChange >= 0 ? '+' : ''}${formatPercent(data.costsChange)}%`,
      `${data.quotaChange >= 0 ? '+' : ''}${formatPercent(data.quotaChange)}`,
    ]);
    
    // Color code changes
    [2, 3, 4].forEach(col => {
      const val = col === 2 ? data.revenueChange : col === 3 ? data.hoursChange : data.costsChange;
      const isPositive = col === 2 ? val > 0 : val < 0;
      row.getCell(col).font = { color: { argb: isPositive ? 'FF16A34A' : 'FFDC2626' } };
    });
    row.getCell(5).font = { color: { argb: data.quotaChange < 0 ? 'FF16A34A' : 'FFDC2626' } };
    
    row.eachCell((cell, colNumber) => {
      if (colNumber >= 2) cell.alignment = { horizontal: 'right' };
    });
  });

  summarySheet.columns = [
    { width: 25 },
    { width: 18 },
    { width: 15 },
    { width: 18 },
    { width: 12 },
  ];

  // === Weekly Detail Sheet ===
  const weekSheet = workbook.addWorksheet('Wochendetails');
  
  weekSheet.addRow([`Woche: ${periodData.week.label}`]).font = { bold: true, size: 14 };
  weekSheet.addRow([]);
  
  const weekHeader = weekSheet.addRow(['Datum', 'Umsatz (CHF)', 'Stunden', 'Kosten (CHF)', 'PKQ (%)']);
  weekHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  weekHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    cell.alignment = { horizontal: 'center' };
  });

  periodData.week.days.forEach(day => {
    const row = weekSheet.addRow([
      format(new Date(day.date), 'EEE dd.MM.', { locale: de }),
      formatCurrency(day.revenue),
      formatHours(day.hours),
      formatCurrency(day.costs),
      formatPercent(day.quota),
    ]);
    
    const pkqCell = row.getCell(5);
    if (day.quota > 35) {
      pkqCell.font = { color: { argb: 'FFDC2626' } };
    } else if (day.quota > 30) {
      pkqCell.font = { color: { argb: 'FFD97706' } };
    } else {
      pkqCell.font = { color: { argb: 'FF16A34A' } };
    }
    
    row.eachCell((cell, colNumber) => {
      if (colNumber >= 2) cell.alignment = { horizontal: 'right' };
    });
  });

  const weekTotalRow = weekSheet.addRow([
    'Gesamt',
    formatCurrency(periodData.week.actualRevenue),
    formatHours(periodData.week.actualHours),
    formatCurrency(periodData.week.actualCosts),
    formatPercent(periodData.week.laborQuota),
  ]);
  weekTotalRow.font = { bold: true };
  weekTotalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  });

  weekSheet.columns = [
    { width: 15 },
    { width: 18 },
    { width: 12 },
    { width: 18 },
    { width: 12 },
  ];

  // === Monthly Detail Sheet ===
  const monthSheet = workbook.addWorksheet('Monatsdetails');
  
  monthSheet.addRow([`Monat: ${periodData.month.label}`]).font = { bold: true, size: 14 };
  monthSheet.addRow([]);
  
  const monthHeader = monthSheet.addRow(['Datum', 'Umsatz (CHF)', 'Stunden', 'Kosten (CHF)', 'PKQ (%)']);
  monthHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  monthHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22C55E' } };
    cell.alignment = { horizontal: 'center' };
  });

  periodData.month.days.forEach(day => {
    const row = monthSheet.addRow([
      format(new Date(day.date), 'dd.MM.', { locale: de }),
      formatCurrency(day.revenue),
      formatHours(day.hours),
      formatCurrency(day.costs),
      formatPercent(day.quota),
    ]);
    
    const pkqCell = row.getCell(5);
    if (day.quota > 35) {
      pkqCell.font = { color: { argb: 'FFDC2626' } };
    } else if (day.quota > 30) {
      pkqCell.font = { color: { argb: 'FFD97706' } };
    } else {
      pkqCell.font = { color: { argb: 'FF16A34A' } };
    }
    
    row.eachCell((cell, colNumber) => {
      if (colNumber >= 2) cell.alignment = { horizontal: 'right' };
    });
  });

  const monthTotalRow = monthSheet.addRow([
    'Gesamt',
    formatCurrency(periodData.month.actualRevenue),
    formatHours(periodData.month.actualHours),
    formatCurrency(periodData.month.actualCosts),
    formatPercent(periodData.month.laborQuota),
  ]);
  monthTotalRow.font = { bold: true };
  monthTotalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
  });

  monthSheet.columns = [
    { width: 12 },
    { width: 18 },
    { width: 12 },
    { width: 18 },
    { width: 12 },
  ];

  // Generate file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = `Ist-Performance_${modeLabel}_${format(selectedDate, 'yyyy-MM-dd')}.xlsx`;
  link.click();
  
  URL.revokeObjectURL(url);
};

export const exportActualPerformancePDF = async (
  periodData: AllPeriodData,
  selectedDate: Date,
  showNetRevenue: boolean
): Promise<void> => {
  const doc = new jsPDF();
  const modeLabel = showNetRevenue ? 'Netto' : 'Brutto';
  
  // Title
  doc.setFontSize(18);
  doc.setTextColor(51, 51, 51);
  doc.text(`Ist-Performance Übersicht (${modeLabel})`, 14, 20);
  
  doc.setFontSize(10);
  doc.setTextColor(100, 100, 100);
  doc.text(`Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm')}`, 14, 28);
  
  // Summary Table
  doc.setFontSize(12);
  doc.setTextColor(51, 51, 51);
  doc.text('Periodenübersicht', 14, 40);
  
  const periods: (keyof AllPeriodData)[] = ['day', 'week', 'month', 'year'];
  const periodLabels = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' };
  
  const summaryData = periods.map(period => {
    const data = periodData[period];
    return [
      `${periodLabels[period]}: ${data.shortLabel}`,
      `${formatCurrency(data.actualRevenue)} CHF`,
      `${formatHours(data.actualHours)}h`,
      `${formatCurrency(data.actualCosts)} CHF`,
      `${formatPercent(data.laborQuota)}%`,
    ];
  });

  autoTable(doc, {
    startY: 45,
    head: [['Periode', 'Ist-Umsatz', 'Ist-Stunden', 'Personalkosten', 'PKQ']],
    body: summaryData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      0: { cellWidth: 45 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
  });

  // Change comparison
  const changeY = (doc as any).lastAutoTable.finalY + 15;
  doc.text('Veränderung zur Vorperiode', 14, changeY);

  const changeData = periods.map(period => {
    const data = periodData[period];
    return [
      periodLabels[period],
      `${data.revenueChange >= 0 ? '+' : ''}${formatPercent(data.revenueChange)}%`,
      `${data.hoursChange >= 0 ? '+' : ''}${formatPercent(data.hoursChange)}%`,
      `${data.costsChange >= 0 ? '+' : ''}${formatPercent(data.costsChange)}%`,
      `${data.quotaChange >= 0 ? '+' : ''}${formatPercent(data.quotaChange)}`,
    ];
  });

  autoTable(doc, {
    startY: changeY + 5,
    head: [['Periode', 'Umsatz Δ', 'Stunden Δ', 'Kosten Δ', 'PKQ Δ']],
    body: changeData,
    theme: 'striped',
    headStyles: { fillColor: [99, 102, 241] },
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
  });

  // Weekly Detail on new page
  doc.addPage();
  doc.setFontSize(14);
  doc.text(`Wochendetails: ${periodData.week.label}`, 14, 20);

  const weekData = periodData.week.days.map(day => [
    format(new Date(day.date), 'EEE dd.MM.', { locale: de }),
    `${formatCurrency(day.revenue)} CHF`,
    `${formatHours(day.hours)}h`,
    `${formatCurrency(day.costs)} CHF`,
    `${formatPercent(day.quota)}%`,
  ]);

  weekData.push([
    'Gesamt',
    `${formatCurrency(periodData.week.actualRevenue)} CHF`,
    `${formatHours(periodData.week.actualHours)}h`,
    `${formatCurrency(periodData.week.actualCosts)} CHF`,
    `${formatPercent(periodData.week.laborQuota)}%`,
  ]);

  autoTable(doc, {
    startY: 25,
    head: [['Datum', 'Umsatz', 'Stunden', 'Kosten', 'PKQ']],
    body: weekData,
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246] },
    styles: { fontSize: 9, cellPadding: 3 },
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === weekData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [243, 244, 246];
      }
    },
  });

  // Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Seite ${i} von ${pageCount}`, doc.internal.pageSize.width / 2, doc.internal.pageSize.height - 10, { align: 'center' });
  }

  doc.save(`Ist-Performance_${modeLabel}_${format(selectedDate, 'yyyy-MM-dd')}.pdf`);
};
