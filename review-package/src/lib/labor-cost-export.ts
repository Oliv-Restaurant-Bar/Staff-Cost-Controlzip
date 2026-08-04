import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface DailyDataItem {
  date: string;
  dayName: string;
  fullDate: string;
  geplant: number;
  ziel: number;
  umsatz: number;
  quote: number;
  stunden: number;
  isOverBudget: boolean;
}

interface WeeklyDataItem {
  name: string;
  geplant: number;
  ziel: number;
  umsatz: number;
  quote: number;
  /** Ungerundete Wochenquote — Ampelschwellen entscheiden auf dem Rohwert (T007). */
  quoteRaw: number;
  stunden: number;
  differenz: number;
  /** Ungerundete Differenz Ziel−Geplant — Vorzeichenfarbe auf dem Rohwert. */
  differenzRaw: number;
}

interface MonthlySummary {
  totalPlanned: number;
  totalTarget: number;
  totalRevenue: number;
  totalHours: number;
  avgPercentage: number;
  difference: number;
  isUnderBudget: boolean;
}

interface LaborCostExportData {
  monthLabel: string;
  summary: MonthlySummary;
  weeklyData: WeeklyDataItem[];
  dailyData: DailyDataItem[];
  laborCostThreshold: number;
}

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

export const exportLaborCostComparisonPDF = (data: LaborCostExportData): void => {
  const { monthLabel, summary, weeklyData, dailyData, laborCostThreshold } = data;
  const doc = new jsPDF();
  
  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkostenanalyse', 14, 20);
  
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text(`${monthLabel}`, 14, 28);
  
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(`Erstellt am: ${new Date().toLocaleDateString('de-CH')}`, 14, 35);
  doc.setTextColor(0, 0, 0);
  
  // Summary Box
  doc.setFillColor(240, 249, 255);
  doc.setDrawColor(59, 130, 246);
  doc.roundedRect(14, 42, 182, 40, 3, 3, 'FD');
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 64, 175);
  doc.text('Monatszusammenfassung', 20, 51);
  
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  
  // Summary Grid
  doc.text(`Geplante Kosten:`, 20, 60);
  doc.setFont('helvetica', 'bold');
  doc.text(`CHF ${formatCurrency(summary.totalPlanned)}`, 60, 60);
  
  doc.setFont('helvetica', 'normal');
  doc.text(`Zielkosten (${laborCostThreshold}%):`, 100, 60);
  doc.setFont('helvetica', 'bold');
  doc.text(`CHF ${formatCurrency(summary.totalTarget)}`, 150, 60);
  
  doc.setFont('helvetica', 'normal');
  doc.text(`Geplanter Umsatz:`, 20, 68);
  doc.setFont('helvetica', 'bold');
  doc.text(`CHF ${formatCurrency(summary.totalRevenue)}`, 60, 68);
  
  doc.setFont('helvetica', 'normal');
  doc.text(`Geplante Stunden:`, 100, 68);
  doc.setFont('helvetica', 'bold');
  doc.text(`${summary.totalHours.toFixed(0)} Std.`, 150, 68);
  
  doc.setFont('helvetica', 'normal');
  doc.text(`Ø Personalkostenquote:`, 20, 76);
  const quoteColor = summary.avgPercentage <= laborCostThreshold ? [34, 139, 34] : [220, 53, 69];
  doc.setTextColor(quoteColor[0], quoteColor[1], quoteColor[2]);
  doc.setFont('helvetica', 'bold');
  doc.text(`${summary.avgPercentage.toFixed(1)}%`, 60, 76);
  
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'normal');
  doc.text(`Differenz zum Ziel:`, 100, 76);
  const diffColor = summary.isUnderBudget ? [34, 139, 34] : [220, 53, 69];
  doc.setTextColor(diffColor[0], diffColor[1], diffColor[2]);
  doc.setFont('helvetica', 'bold');
  doc.text(`${summary.isUnderBudget ? '-' : '+'}CHF ${formatCurrency(Math.abs(summary.difference))}`, 150, 76);
  
  doc.setTextColor(0, 0, 0);
  
  // Weekly Table
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Wochenübersicht', 14, 95);
  
  autoTable(doc, {
    startY: 100,
    head: [['Woche', 'Geplant', 'Ziel', 'Umsatz', 'Quote', 'Stunden', 'Differenz']],
    body: weeklyData.map(week => [
      week.name,
      `CHF ${formatCurrency(week.geplant)}`,
      `CHF ${formatCurrency(week.ziel)}`,
      `CHF ${formatCurrency(week.umsatz)}`,
      `${week.quote}%`,
      `${week.stunden} Std.`,
      `${week.differenz >= 0 ? '+' : ''}CHF ${formatCurrency(week.differenz)}`,
    ]),
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51], fontSize: 8 },
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 28, halign: 'right' },
      2: { cellWidth: 28, halign: 'right' },
      3: { cellWidth: 28, halign: 'right' },
      4: { cellWidth: 18, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 28, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const week = weeklyData[data.row.index];
      // Ampel auf dem ROHWERT — nie auf dem gerundeten Anzeigestring
      if (data.column.index === 4 && week) {
        if (week.quoteRaw > laborCostThreshold) {
          data.cell.styles.textColor = [220, 53, 69];
          data.cell.styles.fontStyle = 'bold';
        }
      }
      if (data.column.index === 6 && week) {
        data.cell.styles.textColor = week.differenzRaw < 0 ? [220, 53, 69] : [34, 139, 34];
      }
    },
  });
  
  // Daily Table on new page
  doc.addPage();
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Tagesübersicht', 14, 20);
  
  autoTable(doc, {
    startY: 25,
    head: [['Tag', 'Datum', 'Geplant', 'Ziel', 'Umsatz', 'Quote', 'Stunden', 'Status']],
    body: dailyData.map(day => [
      day.dayName,
      day.fullDate,
      `CHF ${formatCurrency(day.geplant)}`,
      `CHF ${formatCurrency(day.ziel)}`,
      `CHF ${formatCurrency(day.umsatz)}`,
      `${day.quote}%`,
      `${day.stunden} Std.`,
      day.isOverBudget ? '⚠ Über Ziel' : '✓ OK',
    ]),
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51], fontSize: 8 },
    styles: { fontSize: 7, cellPadding: 1.5 },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { cellWidth: 18 },
      2: { cellWidth: 25, halign: 'right' },
      3: { cellWidth: 25, halign: 'right' },
      4: { cellWidth: 25, halign: 'right' },
      5: { cellWidth: 18, halign: 'right' },
      6: { cellWidth: 20, halign: 'right' },
      7: { cellWidth: 25 },
    },
    didParseCell: (data) => {
      if (data.section === 'body') {
        const rowIndex = data.row.index;
        const dayData = dailyData[rowIndex];
        
        if (dayData?.isOverBudget) {
          if (data.column.index === 5 || data.column.index === 7) {
            data.cell.styles.textColor = [220, 53, 69];
            data.cell.styles.fontStyle = 'bold';
          }
        }
      }
    },
  });
  
  // Summary Statistics at bottom
  const tableEndY = (doc as any).lastAutoTable.finalY + 10;
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Statistik', 14, tableEndY);
  
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  
  const overBudgetDays = dailyData.filter(d => d.isOverBudget).length;
  const underBudgetDays = dailyData.filter(d => !d.isOverBudget).length;
  const avgDailyPlanned = dailyData.length > 0 ? summary.totalPlanned / dailyData.length : 0;
  const avgDailyHours = dailyData.length > 0 ? summary.totalHours / dailyData.length : 0;
  
  doc.text(`Tage über Ziel: ${overBudgetDays}`, 14, tableEndY + 8);
  doc.text(`Tage im Ziel: ${underBudgetDays}`, 70, tableEndY + 8);
  doc.text(`Ø Kosten/Tag: CHF ${formatCurrency(avgDailyPlanned)}`, 130, tableEndY + 8);
  doc.text(`Ø Stunden/Tag: ${avgDailyHours.toFixed(1)} Std.`, 14, tableEndY + 16);
  doc.text(`Schwellenwert: ${laborCostThreshold}%`, 70, tableEndY + 16);
  
  // Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(128, 128, 128);
    doc.text(`Personalkostenanalyse - ${monthLabel} | Seite ${i} von ${pageCount}`, 14, 287);
    doc.text(`Generiert: ${new Date().toLocaleString('de-CH')}`, 150, 287);
  }
  
  // Save
  const fileName = `Personalkostenanalyse_${monthLabel.replace(' ', '_')}.pdf`;
  doc.save(fileName);
};
