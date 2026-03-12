import ExcelJS from 'exceljs';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, startOfQuarter, endOfQuarter, getQuarter } from 'date-fns';
import { de } from 'date-fns/locale';
import { DailyBudget, grossToNet, VAT_RATES } from '@/types/personnel';

export type RevenueExportMode = 'brutto' | 'netto';
export type RevenueExportPeriod = 'week' | 'month' | 'quarter';

interface RevenueExportOptions {
  mode: RevenueExportMode;
  period: RevenueExportPeriod;
  selectedDate: Date;
  dailyBudgets: Record<string, DailyBudget>;
}

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const getDisplayValue = (grossValue: number, takeawayRevenue: number, mode: RevenueExportMode): number => {
  if (mode === 'netto') {
    return grossToNet(grossValue, takeawayRevenue);
  }
  return grossValue;
};

export const exportRevenueData = async (options: RevenueExportOptions): Promise<void> => {
  const { mode, period, selectedDate, dailyBudgets } = options;
  
  // Determine date range
  let startDate: Date;
  let endDate: Date;
  let periodLabel: string;
  
  if (period === 'week') {
    startDate = startOfWeek(selectedDate, { weekStartsOn: 1 });
    endDate = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekNum = format(selectedDate, 'w');
    periodLabel = `KW${weekNum}_${format(selectedDate, 'yyyy')}`;
  } else if (period === 'quarter') {
    startDate = startOfQuarter(selectedDate);
    endDate = endOfQuarter(selectedDate);
    const quarterNum = getQuarter(selectedDate);
    periodLabel = `Q${quarterNum}_${format(selectedDate, 'yyyy')}`;
  } else {
    startDate = startOfMonth(selectedDate);
    endDate = endOfMonth(selectedDate);
    periodLabel = format(selectedDate, 'MMMM_yyyy', { locale: de });
  }
  
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  
  // Create workbook
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Personalkostentracker';
  workbook.created = new Date();
  
  // === Sheet 1: Daily Revenue ===
  const dailySheet = workbook.addWorksheet('Tagesumsätze');
  
  // Header styling
  const modeLabel = mode === 'brutto' ? 'Brutto (inkl. MwSt.)' : 'Netto (exkl. MwSt.)';
  const headerRow = dailySheet.addRow([`Umsatzübersicht - ${modeLabel}`]);
  headerRow.font = { bold: true, size: 14 };
  dailySheet.mergeCells('A1:G1');
  
  const periodRow = dailySheet.addRow([`Zeitraum: ${format(startDate, 'd.MM.yyyy')} - ${format(endDate, 'd.MM.yyyy')}`]);
  periodRow.font = { size: 11, color: { argb: 'FF666666' } };
  dailySheet.mergeCells('A2:G2');
  
  if (mode === 'netto') {
    const vatRow = dailySheet.addRow([`MwSt.-Sätze: Standard ${(VAT_RATES.standard * 100).toFixed(1)}%, Take Away ${(VAT_RATES.takeaway * 100).toFixed(1)}%`]);
    vatRow.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
    dailySheet.mergeCells('A3:G3');
  }
  
  dailySheet.addRow([]);
  
  // Column headers
  const columnHeaders = ['Datum', 'Wochentag', 'Ist-Umsatz', 'Plan-Umsatz', 'Vorjahr', 'Differenz Plan', 'Take Away'];
  const headerDataRow = dailySheet.addRow(columnHeaders);
  headerDataRow.font = { bold: true };
  headerDataRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF333333' }
    };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
  });
  
  // Set column widths
  dailySheet.columns = [
    { width: 12 },
    { width: 12 },
    { width: 15 },
    { width: 15 },
    { width: 15 },
    { width: 15 },
    { width: 12 },
  ];
  
  // Totals for summary
  let totalActual = 0;
  let totalPlanned = 0;
  let totalPrevYear = 0;
  let totalTakeaway = 0;
  
  // Add data rows
  days.forEach(day => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const budget = dailyBudgets[dateStr] || { plannedRevenue: 0, actualRevenue: 0, previousYearRevenue: 0, takeawayRevenue: 0 };
    
    const takeaway = budget.takeawayRevenue || 0;
    const actualDisplay = getDisplayValue(budget.actualRevenue || 0, takeaway, mode);
    const plannedDisplay = getDisplayValue(budget.plannedRevenue || 0, 0, mode);
    const prevYearDisplay = getDisplayValue(budget.previousYearRevenue || 0, 0, mode);
    const takeawayDisplay = mode === 'netto' ? takeaway / (1 + VAT_RATES.takeaway) : takeaway;
    
    totalActual += actualDisplay;
    totalPlanned += plannedDisplay;
    totalPrevYear += prevYearDisplay;
    totalTakeaway += takeawayDisplay;
    
    const diff = actualDisplay - plannedDisplay;
    
    const row = dailySheet.addRow([
      format(day, 'dd.MM.yyyy'),
      format(day, 'EEEE', { locale: de }),
      actualDisplay,
      plannedDisplay,
      prevYearDisplay,
      diff,
      takeawayDisplay,
    ]);
    
    // Format currency cells
    for (let i = 3; i <= 7; i++) {
      row.getCell(i).numFmt = '#,##0.00 "CHF"';
      row.getCell(i).alignment = { horizontal: 'right' };
    }
    
    // Color difference cell
    const diffCell = row.getCell(6);
    if (diff < 0) {
      diffCell.font = { color: { argb: 'FFDC3545' } };
    } else if (diff > 0) {
      diffCell.font = { color: { argb: 'FF22C55E' } };
    }
  });
  
  // Summary row
  dailySheet.addRow([]);
  const summaryRow = dailySheet.addRow([
    'GESAMT',
    '',
    totalActual,
    totalPlanned,
    totalPrevYear,
    totalActual - totalPlanned,
    totalTakeaway,
  ]);
  summaryRow.font = { bold: true };
  summaryRow.eachCell((cell, colNumber) => {
    if (colNumber >= 3) {
      cell.numFmt = '#,##0.00 "CHF"';
      cell.alignment = { horizontal: 'right' };
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF0F0F0' }
    };
  });
  
  // === Sheet 2: Summary Statistics ===
  const summarySheet = workbook.addWorksheet('Zusammenfassung');
  
  summarySheet.addRow(['Umsatz-Zusammenfassung']).font = { bold: true, size: 14 };
  summarySheet.addRow([`Modus: ${modeLabel}`]).font = { size: 11 };
  summarySheet.addRow([]);
  
  const statsHeaders = summarySheet.addRow(['Kennzahl', 'Wert']);
  statsHeaders.font = { bold: true };
  statsHeaders.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF333333' }
    };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  
  summarySheet.columns = [
    { width: 25 },
    { width: 20 },
  ];
  
  const avgDaily = days.length > 0 ? totalActual / days.length : 0;
  const planFulfillment = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
  const yoyChange = totalPrevYear > 0 ? ((totalActual - totalPrevYear) / totalPrevYear) * 100 : 0;
  const takeawayShare = totalActual > 0 ? (totalTakeaway / totalActual) * 100 : 0;
  
  const statsData = [
    ['Gesamtumsatz', `${formatCurrency(totalActual)} CHF`],
    ['Plan-Umsatz', `${formatCurrency(totalPlanned)} CHF`],
    ['Vorjahresumsatz', `${formatCurrency(totalPrevYear)} CHF`],
    ['Differenz zum Plan', `${formatCurrency(totalActual - totalPlanned)} CHF`],
    ['Planerfüllung', `${planFulfillment.toFixed(1)}%`],
    ['Veränderung zum Vorjahr', `${yoyChange >= 0 ? '+' : ''}${yoyChange.toFixed(1)}%`],
    ['Ø Tagesumsatz', `${formatCurrency(avgDaily)} CHF`],
    ['Take Away Anteil', `${takeawayShare.toFixed(1)}%`],
    ['Take Away Umsatz', `${formatCurrency(totalTakeaway)} CHF`],
  ];
  
  statsData.forEach(([label, value]) => {
    const row = summarySheet.addRow([label, value]);
    row.getCell(2).alignment = { horizontal: 'right' };
  });
  
  // Generate file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  const modeFileName = mode === 'brutto' ? 'Brutto' : 'Netto';
  link.download = `Umsatz_${modeFileName}_${periodLabel}.xlsx`;
  link.click();
  
  URL.revokeObjectURL(url);
};
