import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, eachDayOfInterval, getISOWeek, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';

interface GroupReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  group_name: string | null;
  guest_count: number;
  revenue_per_person: number;
  notes: string | null;
  location: string | null;
  exclude_walk_in: boolean;
  is_confirmed?: boolean;
  laufzettel_done?: boolean;
}

interface EventExportData {
  reservations: GroupReservation[];
  periodLabel: string;
  periodType: 'day' | 'week' | 'month' | 'year';
  startDate: Date;
  endDate: Date;
}

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value) + ' CHF';
};

// Calculate summary statistics
const calculateSummary = (reservations: GroupReservation[]) => {
  const totalEvents = reservations.length;
  const totalGuests = reservations.reduce((sum, r) => sum + r.guest_count, 0);
  const totalRevenue = reservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
  
  const mittagEvents = reservations.filter(r => r.shift === 'mittag');
  const abendEvents = reservations.filter(r => r.shift === 'abend');
  
  const uniqueDates = new Set(reservations.map(r => r.date)).size;
  const avgGuestsPerEvent = totalEvents > 0 ? Math.round(totalGuests / totalEvents) : 0;
  const avgRevenuePerGuest = totalGuests > 0 ? Math.round(totalRevenue / totalGuests) : 0;

  return {
    totalEvents,
    totalGuests,
    totalRevenue,
    uniqueDates,
    avgGuestsPerEvent,
    avgRevenuePerGuest,
    mittagCount: mittagEvents.length,
    mittagGuests: mittagEvents.reduce((sum, r) => sum + r.guest_count, 0),
    mittagRevenue: mittagEvents.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0),
    abendCount: abendEvents.length,
    abendGuests: abendEvents.reduce((sum, r) => sum + r.guest_count, 0),
    abendRevenue: abendEvents.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0),
  };
};

// Group reservations by date
const groupByDate = (reservations: GroupReservation[]) => {
  const groups: Record<string, GroupReservation[]> = {};
  reservations.forEach(r => {
    if (!groups[r.date]) groups[r.date] = [];
    groups[r.date].push(r);
  });
  return groups;
};

// ============ PDF EXPORT ============

export const exportEventsPDF = (data: EventExportData): void => {
  const { reservations, periodLabel, periodType } = data;
  const doc = new jsPDF();
  const summary = calculateSummary(reservations);
  const groupedByDate = groupByDate(reservations);
  
  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Event-Übersicht', 14, 20);
  
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.text(periodLabel, 14, 28);
  
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(`Erstellt am: ${new Date().toLocaleDateString('de-CH')}`, 14, 35);
  doc.setTextColor(0, 0, 0);
  
  // Summary Box
  doc.setFillColor(240, 249, 255);
  doc.setDrawColor(59, 130, 246);
  doc.roundedRect(14, 42, 182, 35, 3, 3, 'FD');
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 64, 175);
  doc.text('Zusammenfassung', 20, 51);
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  
  const summaryCol1X = 20;
  const summaryCol2X = 75;
  const summaryCol3X = 130;
  
  doc.text(`Events: ${summary.totalEvents}`, summaryCol1X, 60);
  doc.text(`Gäste: ${summary.totalGuests}`, summaryCol2X, 60);
  doc.text(`Umsatz: ${formatCurrency(summary.totalRevenue)}`, summaryCol3X, 60);
  
  doc.text(`Tage mit Events: ${summary.uniqueDates}`, summaryCol1X, 68);
  doc.text(`Ø Gäste/Event: ${summary.avgGuestsPerEvent}`, summaryCol2X, 68);
  doc.text(`Ø Umsatz/Gast: ${formatCurrency(summary.avgRevenuePerGuest)}`, summaryCol3X, 68);
  
  // Shift breakdown
  let yPos = 85;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Schicht-Übersicht', 14, yPos);
  yPos += 8;
  
  autoTable(doc, {
    startY: yPos,
    head: [['Schicht', 'Events', 'Gäste', 'Umsatz']],
    body: [
      ['Mittag', summary.mittagCount.toString(), summary.mittagGuests.toString(), formatCurrency(summary.mittagRevenue)],
      ['Abend', summary.abendCount.toString(), summary.abendGuests.toString(), formatCurrency(summary.abendRevenue)],
      ['Gesamt', summary.totalEvents.toString(), summary.totalGuests.toString(), formatCurrency(summary.totalRevenue)],
    ],
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { fontStyle: 'bold' },
      3: { halign: 'right' },
    },
  });
  
  yPos = (doc as any).lastAutoTable.finalY + 15;
  
  // Event details table
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Event-Details', 14, yPos);
  yPos += 8;
  
  const eventRows = Object.entries(groupedByDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, dateReservations]) => {
      const dateObj = parseISO(date);
      return dateReservations.map((r, idx) => [
        idx === 0 ? format(dateObj, 'EEE, dd.MM.', { locale: de }) : '',
        r.shift === 'mittag' ? 'Mittag' : 'Abend',
        r.group_name || 'Gruppe',
        r.location || 'EG Restaurant',
        r.guest_count.toString(),
        formatCurrency(r.guest_count * r.revenue_per_person),
        r.exclude_walk_in ? 'Ja' : 'Nein',
      ]);
    });
  
  autoTable(doc, {
    startY: yPos,
    head: [['Datum', 'Schicht', 'Gruppe', 'Standort', 'Gäste', 'Umsatz', 'Kein Walk-In']],
    body: eventRows.length > 0 ? eventRows : [['Keine Events im Zeitraum', '', '', '', '', '', '']],
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    styles: { fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 18 },
      2: { cellWidth: 45 },
      3: { cellWidth: 30 },
      4: { cellWidth: 15, halign: 'center' },
      5: { cellWidth: 25, halign: 'right' },
      6: { cellWidth: 20, halign: 'center' },
    },
  });
  
  // Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(128, 128, 128);
    doc.text(
      `Seite ${i} von ${pageCount}`,
      doc.internal.pageSize.width / 2,
      doc.internal.pageSize.height - 10,
      { align: 'center' }
    );
  }
  
  // Save
  const fileName = `Events_${periodType}_${format(data.startDate, 'yyyy-MM-dd')}.pdf`;
  doc.save(fileName);
};

// ============ EXCEL EXPORT ============

export const exportEventsExcel = async (data: EventExportData): Promise<void> => {
  const { reservations, periodLabel, periodType, startDate } = data;
  const summary = calculateSummary(reservations);
  const groupedByDate = groupByDate(reservations);
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Personalkostentracker';
  workbook.created = new Date();
  
  // ============ Summary Sheet ============
  const summarySheet = workbook.addWorksheet('Zusammenfassung');
  
  // Title
  summarySheet.mergeCells('A1:F1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = `Event-Übersicht - ${periodLabel}`;
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'left' };
  
  summarySheet.getCell('A2').value = `Erstellt am: ${new Date().toLocaleDateString('de-CH')}`;
  summarySheet.getCell('A2').font = { color: { argb: 'FF666666' }, size: 10 };
  
  // Summary section
  summarySheet.getCell('A4').value = 'Gesamtübersicht';
  summarySheet.getCell('A4').font = { bold: true, size: 12 };
  
  const summaryData = [
    ['Kennzahl', 'Wert'],
    ['Events gesamt', summary.totalEvents],
    ['Gäste gesamt', summary.totalGuests],
    ['Umsatz gesamt', summary.totalRevenue],
    ['Tage mit Events', summary.uniqueDates],
    ['Ø Gäste pro Event', summary.avgGuestsPerEvent],
    ['Ø Umsatz pro Gast', summary.avgRevenuePerGuest],
  ];
  
  summaryData.forEach((row, idx) => {
    const rowNum = 5 + idx;
    summarySheet.getCell(`A${rowNum}`).value = row[0];
    summarySheet.getCell(`B${rowNum}`).value = row[1];
    
    if (idx === 0) {
      summarySheet.getCell(`A${rowNum}`).font = { bold: true };
      summarySheet.getCell(`B${rowNum}`).font = { bold: true };
      summarySheet.getCell(`A${rowNum}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      summarySheet.getCell(`B${rowNum}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      summarySheet.getCell(`A${rowNum}`).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      summarySheet.getCell(`B${rowNum}`).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
    
    if (typeof row[1] === 'number' && (row[0] as string).includes('Umsatz')) {
      summarySheet.getCell(`B${rowNum}`).numFmt = '#,##0 "CHF"';
    }
  });
  
  // Shift breakdown
  summarySheet.getCell('A14').value = 'Schicht-Übersicht';
  summarySheet.getCell('A14').font = { bold: true, size: 12 };
  
  const shiftHeaders = ['Schicht', 'Events', 'Gäste', 'Umsatz'];
  shiftHeaders.forEach((header, idx) => {
    const cell = summarySheet.getCell(15, idx + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  });
  
  const shiftData = [
    ['Mittag', summary.mittagCount, summary.mittagGuests, summary.mittagRevenue],
    ['Abend', summary.abendCount, summary.abendGuests, summary.abendRevenue],
    ['Gesamt', summary.totalEvents, summary.totalGuests, summary.totalRevenue],
  ];
  
  shiftData.forEach((row, idx) => {
    const rowNum = 16 + idx;
    row.forEach((value, colIdx) => {
      const cell = summarySheet.getCell(rowNum, colIdx + 1);
      cell.value = value;
      if (colIdx === 3) cell.numFmt = '#,##0 "CHF"';
      if (idx === 2) cell.font = { bold: true };
    });
  });
  
  summarySheet.columns = [
    { width: 25 },
    { width: 15 },
    { width: 15 },
    { width: 18 },
  ];
  
  // ============ Details Sheet ============
  const detailsSheet = workbook.addWorksheet('Event-Details');
  
  // Headers
  const headers = ['Datum', 'Wochentag', 'Schicht', 'Gruppe', 'Standort', 'Gäste', 'CHF/Gast', 'Umsatz', 'Kein Walk-In', 'Notizen'];
  headers.forEach((header, idx) => {
    const cell = detailsSheet.getCell(1, idx + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    cell.alignment = { horizontal: 'center' };
  });
  
  // Data rows
  const sortedDates = Object.keys(groupedByDate).sort();
  let rowNum = 2;
  
  sortedDates.forEach(date => {
    const dateReservations = groupedByDate[date];
    const dateObj = parseISO(date);
    
    dateReservations.forEach(r => {
      detailsSheet.getCell(rowNum, 1).value = dateObj;
      detailsSheet.getCell(rowNum, 1).numFmt = 'DD.MM.YYYY';
      detailsSheet.getCell(rowNum, 2).value = format(dateObj, 'EEEE', { locale: de });
      detailsSheet.getCell(rowNum, 3).value = r.shift === 'mittag' ? 'Mittag' : 'Abend';
      detailsSheet.getCell(rowNum, 4).value = r.group_name || 'Gruppe';
      detailsSheet.getCell(rowNum, 5).value = r.location || 'EG Restaurant';
      detailsSheet.getCell(rowNum, 6).value = r.guest_count;
      detailsSheet.getCell(rowNum, 7).value = r.revenue_per_person;
      detailsSheet.getCell(rowNum, 7).numFmt = '#,##0 "CHF"';
      detailsSheet.getCell(rowNum, 8).value = r.guest_count * r.revenue_per_person;
      detailsSheet.getCell(rowNum, 8).numFmt = '#,##0 "CHF"';
      detailsSheet.getCell(rowNum, 9).value = r.exclude_walk_in ? 'Ja' : 'Nein';
      detailsSheet.getCell(rowNum, 10).value = r.notes || '';
      
      // Alternating row colors
      if (rowNum % 2 === 0) {
        for (let col = 1; col <= 10; col++) {
          detailsSheet.getCell(rowNum, col).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3F4F6' },
          };
        }
      }
      
      // Shift color coding
      const shiftCell = detailsSheet.getCell(rowNum, 3);
      if (r.shift === 'mittag') {
        shiftCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      } else {
        shiftCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
      }
      
      rowNum++;
    });
  });
  
  // Add totals row
  if (reservations.length > 0) {
    rowNum++;
    detailsSheet.getCell(rowNum, 1).value = 'GESAMT';
    detailsSheet.getCell(rowNum, 1).font = { bold: true };
    detailsSheet.getCell(rowNum, 6).value = summary.totalGuests;
    detailsSheet.getCell(rowNum, 6).font = { bold: true };
    detailsSheet.getCell(rowNum, 8).value = summary.totalRevenue;
    detailsSheet.getCell(rowNum, 8).numFmt = '#,##0 "CHF"';
    detailsSheet.getCell(rowNum, 8).font = { bold: true };
    
    for (let col = 1; col <= 10; col++) {
      detailsSheet.getCell(rowNum, col).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDBEAFE' },
      };
    }
  }
  
  detailsSheet.columns = [
    { width: 12 },
    { width: 12 },
    { width: 10 },
    { width: 30 },
    { width: 15 },
    { width: 10 },
    { width: 12 },
    { width: 15 },
    { width: 12 },
    { width: 35 },
  ];
  
  // ============ Daily Summary Sheet (for week/month/year) ============
  if (periodType !== 'day') {
    const dailySheet = workbook.addWorksheet('Tagesübersicht');
    
    const dailyHeaders = ['Datum', 'Wochentag', 'Events', 'Gäste Mittag', 'Gäste Abend', 'Gäste Gesamt', 'Umsatz'];
    dailyHeaders.forEach((header, idx) => {
      const cell = dailySheet.getCell(1, idx + 1);
      cell.value = header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    });
    
    let dailyRowNum = 2;
    sortedDates.forEach(date => {
      const dateReservations = groupedByDate[date];
      const dateObj = parseISO(date);
      const mittagGuests = dateReservations.filter(r => r.shift === 'mittag').reduce((s, r) => s + r.guest_count, 0);
      const abendGuests = dateReservations.filter(r => r.shift === 'abend').reduce((s, r) => s + r.guest_count, 0);
      const dayRevenue = dateReservations.reduce((s, r) => s + (r.guest_count * r.revenue_per_person), 0);
      
      dailySheet.getCell(dailyRowNum, 1).value = dateObj;
      dailySheet.getCell(dailyRowNum, 1).numFmt = 'DD.MM.YYYY';
      dailySheet.getCell(dailyRowNum, 2).value = format(dateObj, 'EEEE', { locale: de });
      dailySheet.getCell(dailyRowNum, 3).value = dateReservations.length;
      dailySheet.getCell(dailyRowNum, 4).value = mittagGuests;
      dailySheet.getCell(dailyRowNum, 5).value = abendGuests;
      dailySheet.getCell(dailyRowNum, 6).value = mittagGuests + abendGuests;
      dailySheet.getCell(dailyRowNum, 7).value = dayRevenue;
      dailySheet.getCell(dailyRowNum, 7).numFmt = '#,##0 "CHF"';
      
      // Color based on guest count
      const totalGuests = mittagGuests + abendGuests;
      if (totalGuests > 50) {
        dailySheet.getCell(dailyRowNum, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      } else if (totalGuests > 30) {
        dailySheet.getCell(dailyRowNum, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      } else if (totalGuests > 0) {
        dailySheet.getCell(dailyRowNum, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      }
      
      dailyRowNum++;
    });
    
    dailySheet.columns = [
      { width: 12 },
      { width: 12 },
      { width: 10 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 15 },
    ];
  }
  
  // Save file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Events_${periodType}_${format(startDate, 'yyyy-MM-dd')}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
};

// ============ FILTERED EXCEL EXPORT ============

interface FilteredExportData {
  reservations: GroupReservation[];
  filterLabel: string;
  dateLabel: string;
  searchQuery?: string;
}

export const exportFilteredEventsExcel = async (data: FilteredExportData): Promise<void> => {
  const { reservations, filterLabel, dateLabel, searchQuery } = data;
  const summary = calculateSummary(reservations);
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Personalkostentracker';
  workbook.created = new Date();
  
  // ============ Event List Sheet ============
  const listSheet = workbook.addWorksheet('Event-Liste');
  
  // Title
  listSheet.mergeCells('A1:K1');
  const titleCell = listSheet.getCell('A1');
  titleCell.value = 'Event-Detailübersicht (Gefiltert)';
  titleCell.font = { bold: true, size: 16 };
  titleCell.alignment = { horizontal: 'left' };
  
  // Filter info
  listSheet.getCell('A2').value = `Filter: ${filterLabel}`;
  listSheet.getCell('A2').font = { size: 10 };
  listSheet.getCell('A3').value = `Zeitraum: ${dateLabel}`;
  listSheet.getCell('A3').font = { size: 10 };
  if (searchQuery) {
    listSheet.getCell('A4').value = `Suche: "${searchQuery}"`;
    listSheet.getCell('A4').font = { size: 10, italic: true };
  }
  listSheet.getCell('A5').value = `Erstellt am: ${new Date().toLocaleDateString('de-CH')} ${new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}`;
  listSheet.getCell('A5').font = { color: { argb: 'FF666666' }, size: 9 };
  
  // Summary row
  const summaryRow = 7;
  listSheet.getCell(`A${summaryRow}`).value = 'Zusammenfassung:';
  listSheet.getCell(`A${summaryRow}`).font = { bold: true };
  listSheet.getCell(`B${summaryRow}`).value = `${summary.totalEvents} Events`;
  listSheet.getCell(`C${summaryRow}`).value = `${summary.totalGuests} Gäste`;
  listSheet.getCell(`D${summaryRow}`).value = summary.totalRevenue;
  listSheet.getCell(`D${summaryRow}`).numFmt = '#,##0 "CHF"';
  listSheet.getCell(`D${summaryRow}`).font = { bold: true };
  
  // Headers
  const headerRow = 9;
  const headers = ['Datum', 'Tag', 'Schicht', 'Gruppe/Firma', 'Standort', 'Gäste', 'CHF/Pers.', 'Umsatz', 'Bestätigt', 'Laufzettel', 'Notizen'];
  headers.forEach((header, idx) => {
    const cell = listSheet.getCell(headerRow, idx + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    cell.alignment = { horizontal: 'center' };
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF1E40AF' } }
    };
  });
  
  // Data rows
  const sortedReservations = [...reservations].sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) return dateCompare;
    return a.shift === 'mittag' ? -1 : 1;
  });
  
  let rowNum = headerRow + 1;
  sortedReservations.forEach((r, idx) => {
    const dateObj = parseISO(r.date);
    
    listSheet.getCell(rowNum, 1).value = dateObj;
    listSheet.getCell(rowNum, 1).numFmt = 'DD.MM.YYYY';
    listSheet.getCell(rowNum, 2).value = format(dateObj, 'EEE', { locale: de });
    listSheet.getCell(rowNum, 3).value = r.shift === 'mittag' ? 'Mittag' : 'Abend';
    listSheet.getCell(rowNum, 4).value = r.group_name || 'Gruppe';
    listSheet.getCell(rowNum, 5).value = r.location || 'EG Restaurant';
    listSheet.getCell(rowNum, 6).value = r.guest_count;
    listSheet.getCell(rowNum, 6).alignment = { horizontal: 'center' };
    listSheet.getCell(rowNum, 7).value = r.revenue_per_person;
    listSheet.getCell(rowNum, 7).numFmt = '#,##0 "CHF"';
    listSheet.getCell(rowNum, 8).value = r.guest_count * r.revenue_per_person;
    listSheet.getCell(rowNum, 8).numFmt = '#,##0 "CHF"';
    listSheet.getCell(rowNum, 9).value = r.is_confirmed ? '✓' : '✗';
    listSheet.getCell(rowNum, 9).alignment = { horizontal: 'center' };
    listSheet.getCell(rowNum, 10).value = r.laufzettel_done ? '✓' : '✗';
    listSheet.getCell(rowNum, 10).alignment = { horizontal: 'center' };
    listSheet.getCell(rowNum, 11).value = r.notes || '';
    
    // Alternating row colors
    const bgColor = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF9FAFB';
    for (let col = 1; col <= 11; col++) {
      listSheet.getCell(rowNum, col).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: bgColor },
      };
    }
    
    // Shift color coding
    const shiftCell = listSheet.getCell(rowNum, 3);
    if (r.shift === 'mittag') {
      shiftCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    } else {
      shiftCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };
    }
    
    // Confirmed status color
    const confirmedCell = listSheet.getCell(rowNum, 9);
    if (r.is_confirmed) {
      confirmedCell.font = { color: { argb: 'FF10B981' }, bold: true };
      confirmedCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    } else {
      confirmedCell.font = { color: { argb: 'FFF59E0B' }, bold: true };
      confirmedCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
    
    // Laufzettel status color
    const laufzettelCell = listSheet.getCell(rowNum, 10);
    if (r.laufzettel_done) {
      laufzettelCell.font = { color: { argb: 'FF3B82F6' }, bold: true };
      laufzettelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    }
    
    rowNum++;
  });
  
  // Add totals row
  if (reservations.length > 0) {
    rowNum++;
    listSheet.getCell(rowNum, 1).value = 'GESAMT';
    listSheet.getCell(rowNum, 1).font = { bold: true };
    listSheet.getCell(rowNum, 6).value = summary.totalGuests;
    listSheet.getCell(rowNum, 6).font = { bold: true };
    listSheet.getCell(rowNum, 6).alignment = { horizontal: 'center' };
    listSheet.getCell(rowNum, 8).value = summary.totalRevenue;
    listSheet.getCell(rowNum, 8).numFmt = '#,##0 "CHF"';
    listSheet.getCell(rowNum, 8).font = { bold: true };
    
    // Confirmed/Laufzettel counts
    const confirmedCount = reservations.filter(r => r.is_confirmed).length;
    const laufzettelCount = reservations.filter(r => r.laufzettel_done).length;
    listSheet.getCell(rowNum, 9).value = `${confirmedCount}/${reservations.length}`;
    listSheet.getCell(rowNum, 9).font = { bold: true };
    listSheet.getCell(rowNum, 9).alignment = { horizontal: 'center' };
    listSheet.getCell(rowNum, 10).value = `${laufzettelCount}/${reservations.length}`;
    listSheet.getCell(rowNum, 10).font = { bold: true };
    listSheet.getCell(rowNum, 10).alignment = { horizontal: 'center' };
    
    for (let col = 1; col <= 11; col++) {
      listSheet.getCell(rowNum, col).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDBEAFE' },
      };
      listSheet.getCell(rowNum, col).border = {
        top: { style: 'thin', color: { argb: 'FF3B82F6' } }
      };
    }
  }
  
  // Column widths
  listSheet.columns = [
    { width: 12 },  // Datum
    { width: 8 },   // Tag
    { width: 10 },  // Schicht
    { width: 28 },  // Gruppe
    { width: 15 },  // Standort
    { width: 8 },   // Gäste
    { width: 12 },  // CHF/Pers
    { width: 14 },  // Umsatz
    { width: 10 },  // Bestätigt
    { width: 10 },  // Laufzettel
    { width: 40 },  // Notizen
  ];
  
  // Freeze header row
  listSheet.views = [{ state: 'frozen', ySplit: headerRow }];
  
  // Save file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Events_Gefiltert_${format(new Date(), 'yyyy-MM-dd_HHmm')}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
};
