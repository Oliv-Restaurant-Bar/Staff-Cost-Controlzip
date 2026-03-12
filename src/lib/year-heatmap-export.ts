import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { format, startOfYear, endOfYear, eachMonthOfInterval, eachDayOfInterval, startOfMonth, endOfMonth, parseISO, getDay } from 'date-fns';
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
}

interface EmailReservation {
  id: string;
  date: string;
  time: string;
  guest_name: string;
  guest_count: number;
  is_processed: boolean;
}

interface YearExportData {
  groupReservations: GroupReservation[];
  emailReservations: EmailReservation[];
  year: number;
  filterMode: 'all' | 'groups' | 'guests';
}

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value) + ' CHF';
};

// Group data by date
const groupByDate = <T extends { date: string }>(items: T[]): Record<string, T[]> => {
  const groups: Record<string, T[]> = {};
  items.forEach(item => {
    if (!groups[item.date]) groups[item.date] = [];
    groups[item.date].push(item);
  });
  return groups;
};

// Calculate monthly stats
const calculateMonthlyStats = (
  year: number,
  groupsByDate: Record<string, GroupReservation[]>,
  emailsByDate: Record<string, EmailReservation[]>,
  filterMode: 'all' | 'groups' | 'guests'
) => {
  const yearStart = startOfYear(new Date(year, 0, 1));
  const yearEnd = endOfYear(yearStart);
  const months = eachMonthOfInterval({ start: yearStart, end: yearEnd });
  
  const showGroups = filterMode === 'all' || filterMode === 'groups';
  const showGuests = filterMode === 'all' || filterMode === 'guests';
  
  return months.map(month => {
    const monthStart = startOfMonth(month);
    const monthEnd = endOfMonth(month);
    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
    
    let groupCount = 0;
    let guestCount = 0;
    let groupGuests = 0;
    let emailGuests = 0;
    let totalRevenue = 0;
    let daysWithEvents = 0;

    monthDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayGroups = groupsByDate[dateStr] || [];
      const dayEmails = emailsByDate[dateStr] || [];
      
      const hasGroupEvents = showGroups && dayGroups.length > 0;
      const hasEmailEvents = showGuests && dayEmails.length > 0;
      
      if (hasGroupEvents || hasEmailEvents) {
        daysWithEvents++;
      }
      
      if (showGroups) {
        groupCount += dayGroups.length;
        groupGuests += dayGroups.reduce((sum, r) => sum + r.guest_count, 0);
        totalRevenue += dayGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
      }
      
      if (showGuests) {
        guestCount += dayEmails.length;
        emailGuests += dayEmails.reduce((sum, r) => sum + r.guest_count, 0);
      }
    });

    return {
      month,
      monthName: format(month, 'MMMM', { locale: de }),
      shortName: format(month, 'MMM', { locale: de }),
      groupCount,
      guestCount,
      totalEvents: groupCount + guestCount,
      groupGuests,
      emailGuests,
      totalGuests: groupGuests + emailGuests,
      totalRevenue,
      daysWithEvents,
      totalDays: monthDays.length
    };
  });
};

// Calculate daily stats for the year
const calculateDailyStats = (
  year: number,
  groupsByDate: Record<string, GroupReservation[]>,
  emailsByDate: Record<string, EmailReservation[]>,
  filterMode: 'all' | 'groups' | 'guests'
) => {
  const yearStart = startOfYear(new Date(year, 0, 1));
  const yearEnd = endOfYear(yearStart);
  const allDays = eachDayOfInterval({ start: yearStart, end: yearEnd });
  
  const showGroups = filterMode === 'all' || filterMode === 'groups';
  const showGuests = filterMode === 'all' || filterMode === 'guests';
  
  return allDays.map(day => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const dayGroups = groupsByDate[dateStr] || [];
    const dayEmails = emailsByDate[dateStr] || [];
    
    const groupGuests = showGroups ? dayGroups.reduce((sum, r) => sum + r.guest_count, 0) : 0;
    const emailGuests = showGuests ? dayEmails.reduce((sum, r) => sum + r.guest_count, 0) : 0;
    const groupCount = showGroups ? dayGroups.length : 0;
    const emailCount = showGuests ? dayEmails.length : 0;
    const revenue = showGroups ? dayGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0) : 0;
    
    return {
      date: day,
      dateStr,
      weekday: format(day, 'EEEE', { locale: de }),
      groupCount,
      emailCount,
      totalEvents: groupCount + emailCount,
      groupGuests,
      emailGuests,
      totalGuests: groupGuests + emailGuests,
      revenue
    };
  }).filter(d => d.totalEvents > 0); // Only include days with events
};

// ============ PDF EXPORT ============

export const exportYearHeatmapPDF = (data: YearExportData): void => {
  const { groupReservations, emailReservations, year, filterMode } = data;
  const groupsByDate = groupByDate(groupReservations);
  const emailsByDate = groupByDate(emailReservations);
  
  const monthlyStats = calculateMonthlyStats(year, groupsByDate, emailsByDate, filterMode);
  const dailyStats = calculateDailyStats(year, groupsByDate, emailsByDate, filterMode);
  
  const doc = new jsPDF();
  
  // Year totals
  const yearTotals = monthlyStats.reduce((acc, m) => ({
    events: acc.events + m.totalEvents,
    guests: acc.guests + m.totalGuests,
    revenue: acc.revenue + m.totalRevenue,
    days: acc.days + m.daysWithEvents,
    groupCount: acc.groupCount + m.groupCount,
    guestCount: acc.guestCount + m.guestCount,
    groupGuests: acc.groupGuests + m.groupGuests,
    emailGuests: acc.emailGuests + m.emailGuests
  }), { events: 0, guests: 0, revenue: 0, days: 0, groupCount: 0, guestCount: 0, groupGuests: 0, emailGuests: 0 });
  
  const filterLabel = filterMode === 'all' ? 'Alle Reservierungen' : 
                      filterMode === 'groups' ? 'Nur Gruppen' : 'Nur Gäste';
  
  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text(`Jahresübersicht ${year}`, 14, 20);
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(`Filter: ${filterLabel}`, 14, 28);
  
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(`Erstellt am: ${new Date().toLocaleDateString('de-CH')}`, 14, 35);
  doc.setTextColor(0, 0, 0);
  
  // Year Summary Box
  doc.setFillColor(240, 249, 255);
  doc.setDrawColor(59, 130, 246);
  doc.roundedRect(14, 42, 182, 28, 3, 3, 'FD');
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 64, 175);
  doc.text('Jahresübersicht', 20, 51);
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  
  const col1X = 20;
  const col2X = 70;
  const col3X = 120;
  const col4X = 160;
  
  doc.text(`Reservierungen: ${yearTotals.events}`, col1X, 60);
  doc.text(`Tage: ${yearTotals.days}`, col2X, 60);
  doc.text(`Gäste: ${yearTotals.guests}`, col3X, 60);
  doc.text(`${formatCurrency(yearTotals.revenue)}`, col4X, 60);
  
  // Monthly Stats Table
  let yPos = 78;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Monatliche Statistik', 14, yPos);
  yPos += 8;
  
  const monthHeaders = filterMode === 'all' 
    ? ['Monat', 'Gruppen', 'Gäste-Res.', 'Gruppen-Gäste', 'Email-Gäste', 'Gesamt', 'Umsatz']
    : filterMode === 'groups'
    ? ['Monat', 'Gruppen', 'Gäste', 'Umsatz', 'Tage']
    : ['Monat', 'Reservierungen', 'Gäste', 'Tage'];
  
  const monthRows = monthlyStats.map(m => {
    if (filterMode === 'all') {
      return [m.monthName, m.groupCount.toString(), m.guestCount.toString(), m.groupGuests.toString(), m.emailGuests.toString(), m.totalGuests.toString(), formatCurrency(m.totalRevenue)];
    } else if (filterMode === 'groups') {
      return [m.monthName, m.groupCount.toString(), m.groupGuests.toString(), formatCurrency(m.totalRevenue), m.daysWithEvents.toString()];
    } else {
      return [m.monthName, m.guestCount.toString(), m.emailGuests.toString(), m.daysWithEvents.toString()];
    }
  });
  
  // Add totals row
  if (filterMode === 'all') {
    monthRows.push(['GESAMT', yearTotals.groupCount.toString(), yearTotals.guestCount.toString(), yearTotals.groupGuests.toString(), yearTotals.emailGuests.toString(), yearTotals.guests.toString(), formatCurrency(yearTotals.revenue)]);
  } else if (filterMode === 'groups') {
    monthRows.push(['GESAMT', yearTotals.groupCount.toString(), yearTotals.groupGuests.toString(), formatCurrency(yearTotals.revenue), yearTotals.days.toString()]);
  } else {
    monthRows.push(['GESAMT', yearTotals.guestCount.toString(), yearTotals.emailGuests.toString(), yearTotals.days.toString()]);
  }
  
  autoTable(doc, {
    startY: yPos,
    head: [monthHeaders],
    body: monthRows,
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    styles: { fontSize: 8 },
    columnStyles: filterMode === 'all' ? {
      0: { fontStyle: 'bold' },
      6: { halign: 'right' },
    } : {
      0: { fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.row.index === monthRows.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [219, 234, 254];
      }
    }
  });
  
  yPos = (doc as any).lastAutoTable.finalY + 15;
  
  // Daily Stats Table (new page if needed)
  if (yPos > 200) {
    doc.addPage();
    yPos = 20;
  }
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Tagesdetails (Tage mit Events)', 14, yPos);
  yPos += 8;
  
  const dailyHeaders = filterMode === 'all'
    ? ['Datum', 'Tag', 'Gruppen', 'Gäste-Res.', 'Gr.-Gäste', 'Em.-Gäste', 'Gesamt', 'Umsatz']
    : filterMode === 'groups'
    ? ['Datum', 'Tag', 'Gruppen', 'Gäste', 'Umsatz']
    : ['Datum', 'Tag', 'Reservierungen', 'Gäste'];
  
  const dailyRows = dailyStats.map(d => {
    const dateStr = format(d.date, 'dd.MM.yyyy');
    const shortWeekday = format(d.date, 'EEE', { locale: de });
    
    if (filterMode === 'all') {
      return [dateStr, shortWeekday, d.groupCount.toString(), d.emailCount.toString(), d.groupGuests.toString(), d.emailGuests.toString(), d.totalGuests.toString(), formatCurrency(d.revenue)];
    } else if (filterMode === 'groups') {
      return [dateStr, shortWeekday, d.groupCount.toString(), d.groupGuests.toString(), formatCurrency(d.revenue)];
    } else {
      return [dateStr, shortWeekday, d.emailCount.toString(), d.emailGuests.toString()];
    }
  });
  
  autoTable(doc, {
    startY: yPos,
    head: [dailyHeaders],
    body: dailyRows.length > 0 ? dailyRows : [['Keine Events im Jahr', '', '', '', '', '', '', '']],
    theme: 'striped',
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold', fontSize: 7 },
    styles: { fontSize: 7 },
    columnStyles: filterMode === 'all' ? {
      7: { halign: 'right' },
    } : filterMode === 'groups' ? {
      4: { halign: 'right' },
    } : {},
  });
  
  // Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(128, 128, 128);
    doc.text(
      `Seite ${i} von ${pageCount} · Jahresübersicht ${year}`,
      doc.internal.pageSize.width / 2,
      doc.internal.pageSize.height - 10,
      { align: 'center' }
    );
  }
  
  // Save
  const fileName = `Jahresuebersicht_${year}_${filterMode}.pdf`;
  doc.save(fileName);
};

// ============ EXCEL EXPORT ============

export const exportYearHeatmapExcel = async (data: YearExportData): Promise<void> => {
  const { groupReservations, emailReservations, year, filterMode } = data;
  const groupsByDate = groupByDate(groupReservations);
  const emailsByDate = groupByDate(emailReservations);
  
  const monthlyStats = calculateMonthlyStats(year, groupsByDate, emailsByDate, filterMode);
  const dailyStats = calculateDailyStats(year, groupsByDate, emailsByDate, filterMode);
  
  const yearTotals = monthlyStats.reduce((acc, m) => ({
    events: acc.events + m.totalEvents,
    guests: acc.guests + m.totalGuests,
    revenue: acc.revenue + m.totalRevenue,
    days: acc.days + m.daysWithEvents,
    groupCount: acc.groupCount + m.groupCount,
    guestCount: acc.guestCount + m.guestCount,
    groupGuests: acc.groupGuests + m.groupGuests,
    emailGuests: acc.emailGuests + m.emailGuests
  }), { events: 0, guests: 0, revenue: 0, days: 0, groupCount: 0, guestCount: 0, groupGuests: 0, emailGuests: 0 });
  
  const filterLabel = filterMode === 'all' ? 'Alle Reservierungen' : 
                      filterMode === 'groups' ? 'Nur Gruppen' : 'Nur Gäste';
  
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Personalkostentracker';
  workbook.created = new Date();
  
  // ============ Summary Sheet ============
  const summarySheet = workbook.addWorksheet('Jahresübersicht');
  
  // Title
  summarySheet.mergeCells('A1:G1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = `Jahresübersicht ${year}`;
  titleCell.font = { bold: true, size: 18 };
  titleCell.alignment = { horizontal: 'left' };
  
  summarySheet.getCell('A2').value = `Filter: ${filterLabel}`;
  summarySheet.getCell('A2').font = { size: 11 };
  
  summarySheet.getCell('A3').value = `Erstellt am: ${new Date().toLocaleDateString('de-CH')}`;
  summarySheet.getCell('A3').font = { color: { argb: 'FF666666' }, size: 10 };
  
  // Year Summary
  summarySheet.getCell('A5').value = 'Jahresübersicht';
  summarySheet.getCell('A5').font = { bold: true, size: 14 };
  
  const summaryHeaders = ['Kennzahl', 'Wert'];
  summaryHeaders.forEach((h, i) => {
    const cell = summarySheet.getCell(6, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  });
  
  const summaryData = [
    ['Reservierungen gesamt', yearTotals.events],
    ['Tage mit Events', yearTotals.days],
    ['Gäste gesamt', yearTotals.guests],
    ['Umsatz gesamt', yearTotals.revenue],
  ];
  
  if (filterMode === 'all') {
    summaryData.push(
      ['Gruppen-Reservierungen', yearTotals.groupCount],
      ['Gäste-Reservierungen', yearTotals.guestCount],
      ['Gruppen-Gäste', yearTotals.groupGuests],
      ['Email-Gäste', yearTotals.emailGuests]
    );
  }
  
  summaryData.forEach((row, idx) => {
    summarySheet.getCell(7 + idx, 1).value = row[0];
    summarySheet.getCell(7 + idx, 2).value = row[1];
    if ((row[0] as string).includes('Umsatz')) {
      summarySheet.getCell(7 + idx, 2).numFmt = '#,##0 "CHF"';
    }
  });
  
  summarySheet.columns = [{ width: 25 }, { width: 18 }];
  
  // ============ Monthly Sheet ============
  const monthlySheet = workbook.addWorksheet('Monatliche Statistik');
  
  const monthHeaders = filterMode === 'all'
    ? ['Monat', 'Gruppen', 'Gäste-Res.', 'Gruppen-Gäste', 'Email-Gäste', 'Gäste Gesamt', 'Umsatz', 'Tage']
    : filterMode === 'groups'
    ? ['Monat', 'Gruppen', 'Gäste', 'Umsatz', 'Tage']
    : ['Monat', 'Reservierungen', 'Gäste', 'Tage'];
  
  monthHeaders.forEach((h, i) => {
    const cell = monthlySheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  });
  
  monthlyStats.forEach((m, idx) => {
    const row = idx + 2;
    if (filterMode === 'all') {
      monthlySheet.getCell(row, 1).value = m.monthName;
      monthlySheet.getCell(row, 2).value = m.groupCount;
      monthlySheet.getCell(row, 3).value = m.guestCount;
      monthlySheet.getCell(row, 4).value = m.groupGuests;
      monthlySheet.getCell(row, 5).value = m.emailGuests;
      monthlySheet.getCell(row, 6).value = m.totalGuests;
      monthlySheet.getCell(row, 7).value = m.totalRevenue;
      monthlySheet.getCell(row, 7).numFmt = '#,##0 "CHF"';
      monthlySheet.getCell(row, 8).value = m.daysWithEvents;
    } else if (filterMode === 'groups') {
      monthlySheet.getCell(row, 1).value = m.monthName;
      monthlySheet.getCell(row, 2).value = m.groupCount;
      monthlySheet.getCell(row, 3).value = m.groupGuests;
      monthlySheet.getCell(row, 4).value = m.totalRevenue;
      monthlySheet.getCell(row, 4).numFmt = '#,##0 "CHF"';
      monthlySheet.getCell(row, 5).value = m.daysWithEvents;
    } else {
      monthlySheet.getCell(row, 1).value = m.monthName;
      monthlySheet.getCell(row, 2).value = m.guestCount;
      monthlySheet.getCell(row, 3).value = m.emailGuests;
      monthlySheet.getCell(row, 4).value = m.daysWithEvents;
    }
    
    // Alternating colors
    if (idx % 2 === 1) {
      for (let col = 1; col <= monthHeaders.length; col++) {
        monthlySheet.getCell(row, col).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF3F4F6' }
        };
      }
    }
  });
  
  // Totals row
  const totalsRow = monthlyStats.length + 2;
  if (filterMode === 'all') {
    monthlySheet.getCell(totalsRow, 1).value = 'GESAMT';
    monthlySheet.getCell(totalsRow, 2).value = yearTotals.groupCount;
    monthlySheet.getCell(totalsRow, 3).value = yearTotals.guestCount;
    monthlySheet.getCell(totalsRow, 4).value = yearTotals.groupGuests;
    monthlySheet.getCell(totalsRow, 5).value = yearTotals.emailGuests;
    monthlySheet.getCell(totalsRow, 6).value = yearTotals.guests;
    monthlySheet.getCell(totalsRow, 7).value = yearTotals.revenue;
    monthlySheet.getCell(totalsRow, 7).numFmt = '#,##0 "CHF"';
    monthlySheet.getCell(totalsRow, 8).value = yearTotals.days;
  } else if (filterMode === 'groups') {
    monthlySheet.getCell(totalsRow, 1).value = 'GESAMT';
    monthlySheet.getCell(totalsRow, 2).value = yearTotals.groupCount;
    monthlySheet.getCell(totalsRow, 3).value = yearTotals.groupGuests;
    monthlySheet.getCell(totalsRow, 4).value = yearTotals.revenue;
    monthlySheet.getCell(totalsRow, 4).numFmt = '#,##0 "CHF"';
    monthlySheet.getCell(totalsRow, 5).value = yearTotals.days;
  } else {
    monthlySheet.getCell(totalsRow, 1).value = 'GESAMT';
    monthlySheet.getCell(totalsRow, 2).value = yearTotals.guestCount;
    monthlySheet.getCell(totalsRow, 3).value = yearTotals.emailGuests;
    monthlySheet.getCell(totalsRow, 4).value = yearTotals.days;
  }
  
  for (let col = 1; col <= monthHeaders.length; col++) {
    monthlySheet.getCell(totalsRow, col).font = { bold: true };
    monthlySheet.getCell(totalsRow, col).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDBEAFE' }
    };
  }
  
  monthlySheet.columns = filterMode === 'all'
    ? [{ width: 14 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 8 }]
    : filterMode === 'groups'
    ? [{ width: 14 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 8 }]
    : [{ width: 14 }, { width: 14 }, { width: 10 }, { width: 8 }];
  
  // ============ Daily Sheet ============
  const dailySheet = workbook.addWorksheet('Tagesdetails');
  
  const dailyHeaders = filterMode === 'all'
    ? ['Datum', 'Wochentag', 'Gruppen', 'Gäste-Res.', 'Gr.-Gäste', 'Em.-Gäste', 'Gesamt', 'Umsatz']
    : filterMode === 'groups'
    ? ['Datum', 'Wochentag', 'Gruppen', 'Gäste', 'Umsatz']
    : ['Datum', 'Wochentag', 'Reservierungen', 'Gäste'];
  
  dailyHeaders.forEach((h, i) => {
    const cell = dailySheet.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  });
  
  dailyStats.forEach((d, idx) => {
    const row = idx + 2;
    if (filterMode === 'all') {
      dailySheet.getCell(row, 1).value = d.date;
      dailySheet.getCell(row, 1).numFmt = 'DD.MM.YYYY';
      dailySheet.getCell(row, 2).value = d.weekday;
      dailySheet.getCell(row, 3).value = d.groupCount;
      dailySheet.getCell(row, 4).value = d.emailCount;
      dailySheet.getCell(row, 5).value = d.groupGuests;
      dailySheet.getCell(row, 6).value = d.emailGuests;
      dailySheet.getCell(row, 7).value = d.totalGuests;
      dailySheet.getCell(row, 8).value = d.revenue;
      dailySheet.getCell(row, 8).numFmt = '#,##0 "CHF"';
    } else if (filterMode === 'groups') {
      dailySheet.getCell(row, 1).value = d.date;
      dailySheet.getCell(row, 1).numFmt = 'DD.MM.YYYY';
      dailySheet.getCell(row, 2).value = d.weekday;
      dailySheet.getCell(row, 3).value = d.groupCount;
      dailySheet.getCell(row, 4).value = d.groupGuests;
      dailySheet.getCell(row, 5).value = d.revenue;
      dailySheet.getCell(row, 5).numFmt = '#,##0 "CHF"';
    } else {
      dailySheet.getCell(row, 1).value = d.date;
      dailySheet.getCell(row, 1).numFmt = 'DD.MM.YYYY';
      dailySheet.getCell(row, 2).value = d.weekday;
      dailySheet.getCell(row, 3).value = d.emailCount;
      dailySheet.getCell(row, 4).value = d.emailGuests;
    }
    
    // Color based on guest count
    const guestCol = filterMode === 'all' ? 7 : filterMode === 'groups' ? 4 : 4;
    const guests = filterMode === 'all' ? d.totalGuests : filterMode === 'groups' ? d.groupGuests : d.emailGuests;
    if (guests > 50) {
      dailySheet.getCell(row, guestCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    } else if (guests > 30) {
      dailySheet.getCell(row, guestCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    } else if (guests > 0) {
      dailySheet.getCell(row, guestCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    }
  });
  
  dailySheet.columns = filterMode === 'all'
    ? [{ width: 12 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 14 }]
    : filterMode === 'groups'
    ? [{ width: 12 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 14 }]
    : [{ width: 12 }, { width: 12 }, { width: 14 }, { width: 10 }];
  
  // Freeze headers
  dailySheet.views = [{ state: 'frozen', ySplit: 1 }];
  monthlySheet.views = [{ state: 'frozen', ySplit: 1 }];
  
  // ============ DASHBOARD SHEET (Compact Overview with Sparklines) ============
  const dashboardSheet = workbook.addWorksheet('Dashboard');
  dashboardSheet.properties.tabColor = { argb: 'FF10B981' };
  
  // Dashboard Title
  dashboardSheet.mergeCells('A1:N1');
  const dashboardTitleCell = dashboardSheet.getCell('A1');
  dashboardTitleCell.value = `📊 Dashboard ${year} - Kompakte Übersicht`;
  dashboardTitleCell.font = { bold: true, size: 18 };
  dashboardTitleCell.alignment = { horizontal: 'left', vertical: 'middle' };
  dashboardSheet.getRow(1).height = 30;
  
  // Subtitle
  dashboardSheet.getCell('A2').value = `Filter: ${filterLabel} | Stand: ${new Date().toLocaleDateString('de-CH')}`;
  dashboardSheet.getCell('A2').font = { size: 10, color: { argb: 'FF666666' } };
  
  // ============ KPI CARDS ROW ============
  const kpiStartRow = 4;
  
  // KPI Card 1: Total Reservations
  dashboardSheet.mergeCells(`A${kpiStartRow}:C${kpiStartRow + 2}`);
  const kpiCell1 = dashboardSheet.getCell(`A${kpiStartRow}`);
  kpiCell1.value = `📅 ${yearTotals.events}\nReservierungen`;
  kpiCell1.font = { bold: true, size: 14 };
  kpiCell1.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  kpiCell1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
  kpiCell1.border = { 
    top: { style: 'medium', color: { argb: 'FF3B82F6' } },
    bottom: { style: 'medium', color: { argb: 'FF3B82F6' } },
    left: { style: 'medium', color: { argb: 'FF3B82F6' } },
    right: { style: 'medium', color: { argb: 'FF3B82F6' } }
  };
  
  // KPI Card 2: Total Guests
  dashboardSheet.mergeCells(`D${kpiStartRow}:F${kpiStartRow + 2}`);
  const kpiCell2 = dashboardSheet.getCell(`D${kpiStartRow}`);
  kpiCell2.value = `👥 ${yearTotals.guests.toLocaleString('de-CH')}\nGäste`;
  kpiCell2.font = { bold: true, size: 14 };
  kpiCell2.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  kpiCell2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  kpiCell2.border = { 
    top: { style: 'medium', color: { argb: 'FF10B981' } },
    bottom: { style: 'medium', color: { argb: 'FF10B981' } },
    left: { style: 'medium', color: { argb: 'FF10B981' } },
    right: { style: 'medium', color: { argb: 'FF10B981' } }
  };
  
  // KPI Card 3: Total Revenue
  dashboardSheet.mergeCells(`G${kpiStartRow}:I${kpiStartRow + 2}`);
  const kpiCell3 = dashboardSheet.getCell(`G${kpiStartRow}`);
  kpiCell3.value = `💰 ${formatCurrency(yearTotals.revenue)}\nUmsatz`;
  kpiCell3.font = { bold: true, size: 14 };
  kpiCell3.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  kpiCell3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  kpiCell3.border = { 
    top: { style: 'medium', color: { argb: 'FFF59E0B' } },
    bottom: { style: 'medium', color: { argb: 'FFF59E0B' } },
    left: { style: 'medium', color: { argb: 'FFF59E0B' } },
    right: { style: 'medium', color: { argb: 'FFF59E0B' } }
  };
  
  // KPI Card 4: Active Days
  dashboardSheet.mergeCells(`J${kpiStartRow}:L${kpiStartRow + 2}`);
  const kpiCell4 = dashboardSheet.getCell(`J${kpiStartRow}`);
  const avgGuestsPerDay = yearTotals.days > 0 ? Math.round(yearTotals.guests / yearTotals.days) : 0;
  kpiCell4.value = `📆 ${yearTotals.days} Tage\nØ ${avgGuestsPerDay} Gäste/Tag`;
  kpiCell4.font = { bold: true, size: 14 };
  kpiCell4.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  kpiCell4.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9D5FF' } };
  kpiCell4.border = { 
    top: { style: 'medium', color: { argb: 'FF8B5CF6' } },
    bottom: { style: 'medium', color: { argb: 'FF8B5CF6' } },
    left: { style: 'medium', color: { argb: 'FF8B5CF6' } },
    right: { style: 'medium', color: { argb: 'FF8B5CF6' } }
  };
  
  // ============ SPARKLINE MONTHLY TRENDS ============
  const sparklineStartRow = kpiStartRow + 5;
  dashboardSheet.getCell(`A${sparklineStartRow}`).value = '📈 Monatstrends (Sparklines)';
  dashboardSheet.getCell(`A${sparklineStartRow}`).font = { bold: true, size: 12 };
  
  // Sparkline headers
  const sparkHeaders = ['Monat', 'Gäste', 'Trend', '', '', '', '', '', '', '', '', '', 'Umsatz', 'Trend'];
  sparkHeaders.forEach((h, i) => {
    const cell = dashboardSheet.getCell(sparklineStartRow + 1, i + 1);
    if (h && (h !== 'Trend')) {
      cell.value = h;
      cell.font = { bold: true, size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    }
  });
  
  // Calculate max values for sparkline scaling
  const maxGuests = Math.max(...monthlyStats.map(m => m.totalGuests), 1);
  const maxRevenue = Math.max(...monthlyStats.map(m => m.totalRevenue), 1);
  
  // Create Unicode sparklines for each month
  monthlyStats.forEach((m, idx) => {
    const row = sparklineStartRow + 2 + idx;
    
    // Month name
    dashboardSheet.getCell(row, 1).value = m.shortName;
    dashboardSheet.getCell(row, 1).font = { bold: true, size: 9 };
    
    // Guest value
    dashboardSheet.getCell(row, 2).value = m.totalGuests;
    dashboardSheet.getCell(row, 2).alignment = { horizontal: 'right' };
    dashboardSheet.getCell(row, 2).font = { size: 9 };
    
    // Guest sparkline (using bars spread across cells)
    const guestBarLength = Math.round((m.totalGuests / maxGuests) * 10);
    for (let i = 0; i < 10; i++) {
      const cell = dashboardSheet.getCell(row, 3 + i);
      if (i < guestBarLength) {
        // Gradient effect
        const blueIntensity = 180 + Math.round((i / 10) * 75);
        cell.fill = { 
          type: 'pattern', 
          pattern: 'solid', 
          fgColor: { argb: `FF3B82${blueIntensity.toString(16).toUpperCase()}` } 
        };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      }
    }
    
    // Revenue value
    dashboardSheet.getCell(row, 13).value = m.totalRevenue;
    dashboardSheet.getCell(row, 13).numFmt = '#,##0';
    dashboardSheet.getCell(row, 13).alignment = { horizontal: 'right' };
    dashboardSheet.getCell(row, 13).font = { size: 9 };
    
    // Revenue sparkline indicator (simple bar)
    const revenuePct = m.totalRevenue / maxRevenue;
    const revenueBar = '▓'.repeat(Math.round(revenuePct * 8)) + '░'.repeat(8 - Math.round(revenuePct * 8));
    dashboardSheet.getCell(row, 14).value = revenueBar;
    dashboardSheet.getCell(row, 14).font = { 
      size: 9, 
      color: { argb: revenuePct > 0.15 ? 'FF10B981' : revenuePct > 0.05 ? 'FFF59E0B' : 'FFEF4444' }
    };
    
    // Alternating row colors
    if (idx % 2 === 1) {
      dashboardSheet.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      dashboardSheet.getCell(row, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
      dashboardSheet.getCell(row, 13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }
  });
  
  // ============ MINI QUARTERLY COMPARISON ============
  const quarterRow = sparklineStartRow + 16;
  dashboardSheet.getCell(`A${quarterRow}`).value = '📊 Quartals-Vergleich';
  dashboardSheet.getCell(`A${quarterRow}`).font = { bold: true, size: 12 };
  
  const quarterColors = ['FF3B82F6', 'FF10B981', 'FFF59E0B', 'FF8B5CF6'];
  const dashboardQuarters = [
    { name: 'Q1', months: [0, 1, 2] },
    { name: 'Q2', months: [3, 4, 5] },
    { name: 'Q3', months: [6, 7, 8] },
    { name: 'Q4', months: [9, 10, 11] }
  ];
  
  dashboardQuarters.forEach((q, idx) => {
    const col = 1 + (idx * 3);
    const quarterData = q.months.reduce((acc, monthIdx) => {
      const m = monthlyStats[monthIdx];
      return {
        events: acc.events + m.totalEvents,
        guests: acc.guests + m.totalGuests,
        revenue: acc.revenue + m.totalRevenue
      };
    }, { events: 0, guests: 0, revenue: 0 });
    
    // Quarter header
    dashboardSheet.mergeCells(quarterRow + 1, col, quarterRow + 1, col + 2);
    const qHeader = dashboardSheet.getCell(quarterRow + 1, col);
    qHeader.value = q.name;
    qHeader.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    qHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: quarterColors[idx] } };
    qHeader.alignment = { horizontal: 'center' };
    
    // Quarter values
    dashboardSheet.getCell(quarterRow + 2, col).value = '📅 Events:';
    dashboardSheet.getCell(quarterRow + 2, col).font = { size: 9 };
    dashboardSheet.getCell(quarterRow + 2, col + 1).value = quarterData.events;
    dashboardSheet.getCell(quarterRow + 2, col + 1).font = { bold: true, size: 10 };
    
    dashboardSheet.getCell(quarterRow + 3, col).value = '👥 Gäste:';
    dashboardSheet.getCell(quarterRow + 3, col).font = { size: 9 };
    dashboardSheet.getCell(quarterRow + 3, col + 1).value = quarterData.guests;
    dashboardSheet.getCell(quarterRow + 3, col + 1).font = { bold: true, size: 10 };
    
    dashboardSheet.getCell(quarterRow + 4, col).value = '💰 Umsatz:';
    dashboardSheet.getCell(quarterRow + 4, col).font = { size: 9 };
    dashboardSheet.getCell(quarterRow + 4, col + 1).value = quarterData.revenue;
    dashboardSheet.getCell(quarterRow + 4, col + 1).numFmt = '#,##0';
    dashboardSheet.getCell(quarterRow + 4, col + 1).font = { bold: true, size: 10 };
    
    // Percentage bar
    const pct = yearTotals.revenue > 0 ? quarterData.revenue / yearTotals.revenue : 0;
    dashboardSheet.getCell(quarterRow + 5, col).value = `${Math.round(pct * 100)}%`;
    dashboardSheet.getCell(quarterRow + 5, col).font = { bold: true, size: 11, color: { argb: quarterColors[idx] } };
    
    // Visual bar
    const barFill = Math.round(pct * 10);
    dashboardSheet.getCell(quarterRow + 5, col + 1).value = '█'.repeat(barFill) + '░'.repeat(10 - barFill);
    dashboardSheet.getCell(quarterRow + 5, col + 1).font = { size: 8, color: { argb: quarterColors[idx] } };
  });
  
  // ============ TOP 5 DAYS (Mini Table) ============
  const topDaysRow = quarterRow + 8;
  dashboardSheet.getCell(`A${topDaysRow}`).value = '🏆 Top 5 Tage (nach Gästen)';
  dashboardSheet.getCell(`A${topDaysRow}`).font = { bold: true, size: 12 };
  
  const topDaysHeaders = ['#', 'Datum', 'Tag', 'Gäste', 'Umsatz', 'Sparkline'];
  topDaysHeaders.forEach((h, i) => {
    const cell = dashboardSheet.getCell(topDaysRow + 1, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
  });
  
  const sortedDays = [...dailyStats].sort((a, b) => b.totalGuests - a.totalGuests).slice(0, 5);
  const topMaxGuests = sortedDays.length > 0 ? sortedDays[0].totalGuests : 1;
  
  sortedDays.forEach((d, idx) => {
    const row = topDaysRow + 2 + idx;
    
    // Medal emoji for top 3
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
    dashboardSheet.getCell(row, 1).value = medal;
    dashboardSheet.getCell(row, 1).alignment = { horizontal: 'center' };
    
    dashboardSheet.getCell(row, 2).value = format(d.date, 'dd.MM.yyyy');
    dashboardSheet.getCell(row, 2).font = { size: 9 };
    
    dashboardSheet.getCell(row, 3).value = format(d.date, 'EEE', { locale: de });
    dashboardSheet.getCell(row, 3).font = { size: 9 };
    
    dashboardSheet.getCell(row, 4).value = d.totalGuests;
    dashboardSheet.getCell(row, 4).font = { bold: true, size: 10 };
    dashboardSheet.getCell(row, 4).fill = { 
      type: 'pattern', 
      pattern: 'solid', 
      fgColor: { argb: idx === 0 ? 'FFFEF3C7' : 'FFFFFFFF' } 
    };
    
    dashboardSheet.getCell(row, 5).value = d.revenue;
    dashboardSheet.getCell(row, 5).numFmt = '#,##0 "CHF"';
    dashboardSheet.getCell(row, 5).font = { size: 9 };
    
    // Mini sparkline
    const pct = d.totalGuests / topMaxGuests;
    dashboardSheet.getCell(row, 6).value = '▓'.repeat(Math.round(pct * 6)) + '░'.repeat(6 - Math.round(pct * 6));
    dashboardSheet.getCell(row, 6).font = { size: 9, color: { argb: 'FF6366F1' } };
  });
  
  // ============ WEEKDAY HEATMAP (Mini) ============
  const heatmapRow = topDaysRow;
  const heatmapCol = 8;
  dashboardSheet.getCell(heatmapRow, heatmapCol).value = '🗓️ Wochentags-Heatmap';
  dashboardSheet.getCell(heatmapRow, heatmapCol).font = { bold: true, size: 12 };
  
  const dashboardWeekdays = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const weekdayData = dashboardWeekdays.map((name, idx) => {
    const dayNum = idx + 1;
    const matchingDays = dailyStats.filter(d => {
      const dayOfWeek = getDay(d.date);
      return dayOfWeek === (dayNum % 7);
    });
    
    const guests = matchingDays.reduce((sum, d) => sum + d.totalGuests, 0);
    return { name: name.substring(0, 2), fullName: name, guests };
  });
  
  const maxWeekdayGuests = Math.max(...weekdayData.map(w => w.guests), 1);
  
  // Weekday headers
  weekdayData.forEach((w, idx) => {
    const cell = dashboardSheet.getCell(heatmapRow + 1, heatmapCol + idx);
    cell.value = w.name;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { horizontal: 'center' };
  });
  
  // Heatmap cells
  weekdayData.forEach((w, idx) => {
    const cell = dashboardSheet.getCell(heatmapRow + 2, heatmapCol + idx);
    cell.value = w.guests;
    cell.alignment = { horizontal: 'center' };
    cell.font = { size: 9, bold: true };
    
    // Color based on intensity
    const intensity = w.guests / maxWeekdayGuests;
    let bgColor: string;
    if (intensity > 0.75) {
      bgColor = 'FF10B981'; // Green - high
    } else if (intensity > 0.5) {
      bgColor = 'FF34D399'; // Light green
    } else if (intensity > 0.25) {
      bgColor = 'FFFBBF24'; // Yellow
    } else if (intensity > 0) {
      bgColor = 'FFFEF3C7'; // Light yellow
    } else {
      bgColor = 'FFF3F4F6'; // Gray
    }
    
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
    cell.font = { 
      size: 9, 
      bold: true, 
      color: { argb: intensity > 0.5 ? 'FFFFFFFF' : 'FF374151' }
    };
  });
  
  // Heatmap legend
  dashboardSheet.getCell(heatmapRow + 4, heatmapCol).value = 'Legende:';
  dashboardSheet.getCell(heatmapRow + 4, heatmapCol).font = { size: 8 };
  
  const legendColors = [
    { label: 'Hoch', color: 'FF10B981' },
    { label: 'Mittel', color: 'FFFBBF24' },
    { label: 'Niedrig', color: 'FFF3F4F6' }
  ];
  
  legendColors.forEach((l, idx) => {
    const cell = dashboardSheet.getCell(heatmapRow + 4, heatmapCol + 1 + idx);
    cell.value = l.label;
    cell.font = { size: 7 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: l.color } };
    cell.alignment = { horizontal: 'center' };
  });
  
  // Set Dashboard column widths
  dashboardSheet.columns = [
    { width: 10 }, { width: 8 }, { width: 3 }, { width: 3 }, { width: 3 },
    { width: 3 }, { width: 3 }, { width: 3 }, { width: 3 }, { width: 3 },
    { width: 3 }, { width: 3 }, { width: 10 }, { width: 12 }, { width: 12 }
  ];
  
  // ============ Visual Charts Sheet ============
  const chartsSheet = workbook.addWorksheet('Diagramme');
  
  // Title
  chartsSheet.mergeCells('A1:L1');
  const chartsTitleCell = chartsSheet.getCell('A1');
  chartsTitleCell.value = `📊 Jahresübersicht ${year} - Visuelle Auswertung`;
  chartsTitleCell.font = { bold: true, size: 16 };
  chartsTitleCell.alignment = { horizontal: 'left' };
  
  // ============ Monthly Guest Bar Chart ============
  chartsSheet.getCell('A3').value = 'Monatliche Gästeverteilung';
  chartsSheet.getCell('A3').font = { bold: true, size: 12 };
  
  // Chart headers
  const chartHeaders = ['Monat', 'Gäste', 'Visualisierung', '', '', '', '', '', '', '', 'Max'];
  chartHeaders.forEach((h, i) => {
    const cell = chartsSheet.getCell(4, i + 1);
    if (h) {
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
    }
  });
  
  // Find max guests for scaling
  const maxMonthlyGuests = Math.max(...monthlyStats.map(m => m.totalGuests), 1);
  
  // Create visual bar chart rows
  monthlyStats.forEach((m, idx) => {
    const row = 5 + idx;
    chartsSheet.getCell(row, 1).value = m.shortName;
    chartsSheet.getCell(row, 1).font = { bold: true };
    chartsSheet.getCell(row, 2).value = m.totalGuests;
    chartsSheet.getCell(row, 2).alignment = { horizontal: 'right' };
    
    // Create visual bar using filled cells
    const barLength = Math.round((m.totalGuests / maxMonthlyGuests) * 8);
    for (let i = 0; i < 8; i++) {
      const cell = chartsSheet.getCell(row, 3 + i);
      if (i < barLength) {
        // Gradient color from blue to cyan
        const intensity = Math.round(59 + (i / 8) * 100);
        cell.fill = { 
          type: 'pattern', 
          pattern: 'solid', 
          fgColor: { argb: `FF${intensity.toString(16).padStart(2, '0')}${(130 + i * 10).toString(16).padStart(2, '0')}F6` } 
        };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: i === 0 ? { style: 'thin', color: { argb: 'FFE5E7EB' } } : undefined,
        right: i === 7 ? { style: 'thin', color: { argb: 'FFE5E7EB' } } : undefined,
      };
    }
    
    chartsSheet.getCell(row, 11).value = idx === 0 ? maxMonthlyGuests : '';
    chartsSheet.getCell(row, 11).font = { size: 9, color: { argb: 'FF666666' } };
  });
  
  // ============ Monthly Revenue Bar Chart ============
  const revenueChartStartRow = 19;
  chartsSheet.getCell(`A${revenueChartStartRow}`).value = 'Monatliche Umsatzentwicklung';
  chartsSheet.getCell(`A${revenueChartStartRow}`).font = { bold: true, size: 12 };
  
  const revenueHeaders = ['Monat', 'Umsatz', 'Visualisierung', '', '', '', '', '', '', '', 'Max'];
  revenueHeaders.forEach((h, i) => {
    const cell = chartsSheet.getCell(revenueChartStartRow + 1, i + 1);
    if (h) {
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };
    }
  });
  
  const maxMonthlyRevenue = Math.max(...monthlyStats.map(m => m.totalRevenue), 1);
  
  monthlyStats.forEach((m, idx) => {
    const row = revenueChartStartRow + 2 + idx;
    chartsSheet.getCell(row, 1).value = m.shortName;
    chartsSheet.getCell(row, 1).font = { bold: true };
    chartsSheet.getCell(row, 2).value = m.totalRevenue;
    chartsSheet.getCell(row, 2).numFmt = '#,##0 "CHF"';
    chartsSheet.getCell(row, 2).alignment = { horizontal: 'right' };
    
    const barLength = Math.round((m.totalRevenue / maxMonthlyRevenue) * 8);
    for (let i = 0; i < 8; i++) {
      const cell = chartsSheet.getCell(row, 3 + i);
      if (i < barLength) {
        const greenIntensity = Math.round(16 + (i / 8) * 60);
        cell.fill = { 
          type: 'pattern', 
          pattern: 'solid', 
          fgColor: { argb: `FF${greenIntensity.toString(16).padStart(2, '0')}B981` } 
        };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        left: i === 0 ? { style: 'thin', color: { argb: 'FFE5E7EB' } } : undefined,
        right: i === 7 ? { style: 'thin', color: { argb: 'FFE5E7EB' } } : undefined,
      };
    }
    
    chartsSheet.getCell(row, 11).value = idx === 0 ? formatCurrency(maxMonthlyRevenue) : '';
    chartsSheet.getCell(row, 11).font = { size: 9, color: { argb: 'FF666666' } };
  });
  
  // ============ Events Distribution Comparison ============
  if (filterMode === 'all') {
    const compChartStartRow = 35;
    chartsSheet.getCell(`A${compChartStartRow}`).value = 'Gruppen vs. Gäste-Reservierungen pro Monat';
    chartsSheet.getCell(`A${compChartStartRow}`).font = { bold: true, size: 12 };
    
    const compHeaders = ['Monat', 'Gruppen', '', '', '', 'Gäste', '', '', '', 'Legende'];
    compHeaders.forEach((h, i) => {
      const cell = chartsSheet.getCell(compChartStartRow + 1, i + 1);
      if (h) {
        cell.value = h;
        cell.font = { bold: true };
        if (h === 'Gruppen') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        } else if (h === 'Gäste') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF06B6D4' } };
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        }
      }
    });
    
    // Legend
    chartsSheet.getCell(compChartStartRow + 1, 10).value = '■ Gruppen';
    chartsSheet.getCell(compChartStartRow + 1, 10).font = { color: { argb: 'FF3B82F6' } };
    chartsSheet.getCell(compChartStartRow + 2, 10).value = '■ Gäste-Res.';
    chartsSheet.getCell(compChartStartRow + 2, 10).font = { color: { argb: 'FF06B6D4' } };
    
    const maxCompare = Math.max(
      ...monthlyStats.map(m => m.groupCount),
      ...monthlyStats.map(m => m.guestCount),
      1
    );
    
    monthlyStats.forEach((m, idx) => {
      const row = compChartStartRow + 2 + idx;
      chartsSheet.getCell(row, 1).value = m.shortName;
      chartsSheet.getCell(row, 1).font = { bold: true };
      
      // Groups bar
      const groupBarLength = Math.round((m.groupCount / maxCompare) * 4);
      for (let i = 0; i < 4; i++) {
        const cell = chartsSheet.getCell(row, 2 + i);
        cell.fill = { 
          type: 'pattern', 
          pattern: 'solid', 
          fgColor: { argb: i < groupBarLength ? 'FF3B82F6' : 'FFF3F4F6' } 
        };
      }
      
      // Guests bar
      const guestBarLength = Math.round((m.guestCount / maxCompare) * 4);
      for (let i = 0; i < 4; i++) {
        const cell = chartsSheet.getCell(row, 6 + i);
        cell.fill = { 
          type: 'pattern', 
          pattern: 'solid', 
          fgColor: { argb: i < guestBarLength ? 'FF06B6D4' : 'FFF3F4F6' } 
        };
      }
    });
  }
  
  // ============ Quarterly Summary ============
  const quarterlyStartRow = filterMode === 'all' ? 50 : 35;
  chartsSheet.getCell(`A${quarterlyStartRow}`).value = 'Quartalsübersicht';
  chartsSheet.getCell(`A${quarterlyStartRow}`).font = { bold: true, size: 12 };
  
  const quarterHeaders = ['Quartal', 'Events', 'Gäste', 'Umsatz', 'Anteil'];
  quarterHeaders.forEach((h, i) => {
    const cell = chartsSheet.getCell(quarterlyStartRow + 1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B5CF6' } };
  });
  
  const chartsQuarters = [
    { name: 'Q1', months: [0, 1, 2] },
    { name: 'Q2', months: [3, 4, 5] },
    { name: 'Q3', months: [6, 7, 8] },
    { name: 'Q4', months: [9, 10, 11] }
  ];
  
  chartsQuarters.forEach((q, idx) => {
    const row = quarterlyStartRow + 2 + idx;
    const quarterData = q.months.reduce((acc, monthIdx) => {
      const m = monthlyStats[monthIdx];
      return {
        events: acc.events + m.totalEvents,
        guests: acc.guests + m.totalGuests,
        revenue: acc.revenue + m.totalRevenue
      };
    }, { events: 0, guests: 0, revenue: 0 });
    
    chartsSheet.getCell(row, 1).value = q.name;
    chartsSheet.getCell(row, 1).font = { bold: true };
    chartsSheet.getCell(row, 2).value = quarterData.events;
    chartsSheet.getCell(row, 3).value = quarterData.guests;
    chartsSheet.getCell(row, 4).value = quarterData.revenue;
    chartsSheet.getCell(row, 4).numFmt = '#,##0 "CHF"';
    chartsSheet.getCell(row, 5).value = yearTotals.revenue > 0 ? quarterData.revenue / yearTotals.revenue : 0;
    chartsSheet.getCell(row, 5).numFmt = '0%';
    
    // Color by percentage
    const pct = yearTotals.revenue > 0 ? quarterData.revenue / yearTotals.revenue : 0;
    if (pct >= 0.3) {
      chartsSheet.getCell(row, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    } else if (pct >= 0.2) {
      chartsSheet.getCell(row, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    } else {
      chartsSheet.getCell(row, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    }
  });
  
  // ============ Weekday Analysis ============
  const weekdayStartRow = quarterlyStartRow + 8;
  chartsSheet.getCell(`A${weekdayStartRow}`).value = 'Wochentagsanalyse';
  chartsSheet.getCell(`A${weekdayStartRow}`).font = { bold: true, size: 12 };
  
  const weekdayHeaders = ['Wochentag', 'Events', 'Gäste', 'Ø Gäste/Event', 'Visualisierung'];
  weekdayHeaders.forEach((h, i) => {
    const cell = chartsSheet.getCell(weekdayStartRow + 1, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF59E0B' } };
  });
  
  const chartsWeekdays = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const weekdayStats = chartsWeekdays.map((name, idx) => {
    const dayNum = idx + 1; // Monday = 1, Sunday = 7
    const matchingDays = dailyStats.filter(d => {
      const dayOfWeek = getDay(d.date);
      return dayOfWeek === (dayNum % 7); // Convert to JS day (0 = Sunday)
    });
    
    const events = matchingDays.reduce((sum, d) => sum + d.totalEvents, 0);
    const guests = matchingDays.reduce((sum, d) => sum + d.totalGuests, 0);
    
    return { name, events, guests, avgGuests: events > 0 ? Math.round(guests / events) : 0 };
  });
  
  const maxWeekdayEvents = Math.max(...weekdayStats.map(w => w.events), 1);
  
  weekdayStats.forEach((w, idx) => {
    const row = weekdayStartRow + 2 + idx;
    chartsSheet.getCell(row, 1).value = w.name;
    chartsSheet.getCell(row, 2).value = w.events;
    chartsSheet.getCell(row, 3).value = w.guests;
    chartsSheet.getCell(row, 4).value = w.avgGuests;
    
    // Mini bar
    const barWidth = Math.round((w.events / maxWeekdayEvents) * 10);
    chartsSheet.getCell(row, 5).value = '█'.repeat(barWidth) + '░'.repeat(10 - barWidth);
    chartsSheet.getCell(row, 5).font = { color: { argb: 'FFF59E0B' } };
    
    // Weekend highlighting
    if (idx >= 5) {
      chartsSheet.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
  });
  
  // Set column widths
  chartsSheet.columns = [
    { width: 12 }, { width: 12 }, { width: 5 }, { width: 5 }, { width: 5 }, 
    { width: 5 }, { width: 5 }, { width: 5 }, { width: 5 }, { width: 5 },
    { width: 14 }, { width: 14 }
  ];
  
  // Save file
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Jahresuebersicht_${year}_${filterMode}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
};
