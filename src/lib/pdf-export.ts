import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, startOfWeek, endOfWeek, eachDayOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget, DailySummary } from '@/types/personnel';
import { formatCurrency, formatHours } from './personnel-utils';
import { getEffectiveHourlyRate } from './employee-rate';
import type { SocialCostRates } from './social-costs';

interface DayData {
  date: Date;
  dateString: string;
  entries: TimeEntry[];
  budget: DailyBudget | undefined;
  employees: Employee[];
}

// Kosten = Total Arbeitgeberkosten (Brutto inkl. anteil. 13. + AG-Sozialkosten), nie roher hourlyWage.
const calculateDayStats = (dayData: DayData, rates: SocialCostRates) => {
  let plannedHours = 0;
  let actualHours = 0;
  let plannedCost = 0;
  let actualCost = 0;

  dayData.entries.forEach((entry) => {
    const employee = dayData.employees.find((e) => e.id === entry.employeeId);
    if (!employee) return;

    const agRate = getEffectiveHourlyRate(employee, rates) ?? 0;
    plannedHours += entry.plannedHours;
    plannedCost += entry.plannedHours * agRate;

    if (entry.actualHours !== undefined) {
      actualHours += entry.actualHours;
      actualCost += entry.actualHours * agRate;
    }
  });

  const plannedRevenue = dayData.budget?.plannedRevenue || 0;
  const actualRevenue = dayData.budget?.actualRevenue || 0;
  const laborCostPercentage = actualRevenue > 0 ? (actualCost / actualRevenue) * 100 : 0;

  return {
    plannedHours,
    actualHours,
    plannedCost,
    actualCost,
    plannedRevenue,
    actualRevenue,
    laborCostPercentage,
  };
};

export const exportDailyReport = (
  date: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  summary: DailySummary,
  rates: SocialCostRates,
  showNetRevenue: boolean = false
) => {
  const doc = new jsPDF();
  const dateString = format(date, 'yyyy-MM-dd');
  const formattedDate = format(date, 'EEEE, d. MMMM yyyy', { locale: de });
  const revenueMode = showNetRevenue ? 'Netto' : 'Brutto';

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkosten Tagesbericht', 14, 20);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(`${formattedDate} | Umsatz: ${revenueMode}`, 14, 30);

  // Summary Box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 38, 182, 35, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Zusammenfassung', 18, 46);

  doc.setFont('helvetica', 'normal');
  const budget = dailyBudgets[dateString];

  const summaryData = [
    ['Umsatz (Budget)', formatCurrency(budget?.plannedRevenue || 0)],
    ['Umsatz (Ist)', formatCurrency(budget?.actualRevenue || 0)],
    ['Personalkosten (Plan)', formatCurrency(summary.totalPlannedCost)],
    ['Personalkosten (Ist)', formatCurrency(summary.totalActualCost)],
    ['Personalkostenquote', `${summary.laborCostPercentage.toFixed(1)}%`],
  ];

  let xPos = 18;
  summaryData.forEach(([label, value], index) => {
    if (index === 2) xPos = 18; // New row
    if (index < 2) {
      doc.text(label + ':', xPos, 54 + (index * 6));
      doc.text(value, xPos + 50, 54 + (index * 6));
    } else {
      doc.text(label + ':', xPos + 100, 54 + ((index - 2) * 6));
      doc.text(value, xPos + 155, 54 + ((index - 2) * 6));
    }
  });

  // Employee Table
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Arbeitszeiten pro Mitarbeiter', 14, 85);

  const dayEntries = timeEntries.filter((e) => e.date === dateString);
  const tableData = dayEntries.map((entry) => {
    const employee = employees.find((e) => e.id === entry.employeeId);
    if (!employee) return ['', '', '', '', '', '', ''];

    const agRate = getEffectiveHourlyRate(employee, rates) ?? 0;
    return [
      employee.name,
      employee.department === 'küche' ? 'Küche' : 'Service',
      `${entry.plannedStart} - ${entry.plannedEnd}`,
      formatHours(entry.plannedHours),
      entry.actualHours !== undefined ? formatHours(entry.actualHours) : '-',
      formatCurrency(entry.plannedHours * agRate),
      entry.actualHours !== undefined 
        ? formatCurrency(entry.actualHours * agRate) 
        : '-',
    ];
  });

  autoTable(doc, {
    startY: 90,
    head: [['Name', 'Abteilung', 'Geplant', 'Std (Plan)', 'Std (Ist)', 'Kosten (Plan)', 'Kosten (Ist)']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 35 },
      1: { cellWidth: 20 },
      2: { cellWidth: 30 },
      3: { cellWidth: 22, halign: 'right' },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 28, halign: 'right' },
      6: { cellWidth: 28, halign: 'right' },
    },
  });

  // Footer
  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  doc.save(`Personalkosten_${format(date, 'yyyy-MM-dd')}.pdf`);
};

export const exportWeeklyReport = (
  selectedDate: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  rates: SocialCostRates,
  showNetRevenue: boolean = false
) => {
  const doc = new jsPDF();
  const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });
  const revenueMode = showNetRevenue ? 'Netto' : 'Brutto';

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkosten Wochenbericht', 14, 20);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `${format(weekStart, 'd. MMMM', { locale: de })} - ${format(weekEnd, 'd. MMMM yyyy', { locale: de })} | Umsatz: ${revenueMode}`,
    14,
    30
  );

  // Calculate weekly totals
  let totalPlannedHours = 0;
  let totalActualHours = 0;
  let totalPlannedCost = 0;
  let totalActualCost = 0;
  let totalPlannedRevenue = 0;
  let totalActualRevenue = 0;

  const dailyData = days.map((day) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter((e) => e.date === dateString);
    const budget = dailyBudgets[dateString];

    const stats = calculateDayStats({
      date: day,
      dateString,
      entries: dayEntries,
      budget,
      employees,
    }, rates);

    totalPlannedHours += stats.plannedHours;
    totalActualHours += stats.actualHours;
    totalPlannedCost += stats.plannedCost;
    totalActualCost += stats.actualCost;
    totalPlannedRevenue += stats.plannedRevenue;
    totalActualRevenue += stats.actualRevenue;

    return {
      day: format(day, 'EEE', { locale: de }),
      date: format(day, 'dd.MM.', { locale: de }),
      ...stats,
      employeeCount: dayEntries.length,
    };
  });

  const weeklyLaborPercentage = totalActualRevenue > 0 
    ? (totalActualCost / totalActualRevenue) * 100 
    : 0;

  // Summary Box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 38, 182, 28, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Wochenzusammenfassung', 18, 46);

  doc.setFont('helvetica', 'normal');
  const summaryItems = [
    { label: 'Umsatz (Ist)', value: formatCurrency(totalActualRevenue), x: 18, y: 54 },
    { label: 'Personalkosten (Ist)', value: formatCurrency(totalActualCost), x: 75, y: 54 },
    { label: 'Arbeitsstunden', value: formatHours(totalActualHours), x: 135, y: 54 },
    { label: 'Personalkostenquote', value: `${weeklyLaborPercentage.toFixed(1)}%`, x: 18, y: 62 },
    { label: 'Differenz Plan/Ist', value: formatCurrency(totalPlannedCost - totalActualCost), x: 75, y: 62 },
  ];

  summaryItems.forEach((item) => {
    doc.text(`${item.label}: ${item.value}`, item.x, item.y);
  });

  // Daily Table
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Tagesübersicht', 14, 78);

  const tableData = dailyData.map((day) => [
    `${day.day} ${day.date}`,
    formatCurrency(day.actualRevenue),
    formatCurrency(day.actualCost),
    formatHours(day.actualHours),
    `${day.laborCostPercentage.toFixed(1)}%`,
    day.employeeCount.toString(),
  ]);

  // Add totals row
  tableData.push([
    'GESAMT',
    formatCurrency(totalActualRevenue),
    formatCurrency(totalActualCost),
    formatHours(totalActualHours),
    `${weeklyLaborPercentage.toFixed(1)}%`,
    '',
  ]);

  autoTable(doc, {
    startY: 83,
    head: [['Tag', 'Umsatz', 'Personalkosten', 'Stunden', 'Quote', 'MA']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 35, halign: 'right' },
      2: { cellWidth: 35, halign: 'right' },
      3: { cellWidth: 25, halign: 'right' },
      4: { cellWidth: 25, halign: 'right' },
      5: { cellWidth: 20, halign: 'center' },
    },
    didParseCell: (data) => {
      // Style the totals row
      if (data.row.index === tableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Department Breakdown
  const finalTableY = (doc as any).lastAutoTable.finalY + 15;
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Aufteilung nach Abteilung', 14, finalTableY);

  // Calculate department totals
  const departmentTotals = { küche: { hours: 0, cost: 0 }, service: { hours: 0, cost: 0 } };
  
  timeEntries.forEach((entry) => {
    const dateString = entry.date;
    if (!days.some((d) => format(d, 'yyyy-MM-dd') === dateString)) return;
    
    const employee = employees.find((e) => e.id === entry.employeeId);
    if (!employee) return;

    const hours = entry.actualHours || 0;
    const cost = hours * (getEffectiveHourlyRate(employee, rates) ?? 0);

    departmentTotals[employee.department].hours += hours;
    departmentTotals[employee.department].cost += cost;
  });

  autoTable(doc, {
    startY: finalTableY + 5,
    head: [['Abteilung', 'Stunden', 'Personalkosten', 'Anteil']],
    body: [
      [
        'Küche',
        formatHours(departmentTotals.küche.hours),
        formatCurrency(departmentTotals.küche.cost),
        totalActualCost > 0 
          ? `${((departmentTotals.küche.cost / totalActualCost) * 100).toFixed(1)}%` 
          : '-',
      ],
      [
        'Service',
        formatHours(departmentTotals.service.hours),
        formatCurrency(departmentTotals.service.cost),
        totalActualCost > 0 
          ? `${((departmentTotals.service.cost / totalActualCost) * 100).toFixed(1)}%` 
          : '-',
      ],
    ],
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: 40, halign: 'right' },
      2: { cellWidth: 45, halign: 'right' },
      3: { cellWidth: 30, halign: 'right' },
    },
  });

  // Footer
  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  const weekNumber = format(weekStart, 'ww', { locale: de });
  doc.save(`Personalkosten_KW${weekNumber}_${format(weekStart, 'yyyy')}.pdf`);
};

export const exportMonthlyReport = (
  selectedDate: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  rates: SocialCostRates
) => {
  const doc = new jsPDF();
  const { startOfMonth, endOfMonth, eachDayOfInterval, getWeek } = require('date-fns');
  
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkosten Monatsbericht', 14, 20);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(format(selectedDate, 'MMMM yyyy', { locale: de }), 14, 30);

  // Calculate monthly totals
  let totalPlannedHours = 0;
  let totalActualHours = 0;
  let totalPlannedCost = 0;
  let totalActualCost = 0;
  let totalPlannedRevenue = 0;
  let totalActualRevenue = 0;

  const dailyData = days.map((day: Date) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter((e) => e.date === dateString);
    const budget = dailyBudgets[dateString];

    const stats = calculateDayStats({
      date: day,
      dateString,
      entries: dayEntries,
      budget,
      employees,
    }, rates);

    totalPlannedHours += stats.plannedHours;
    totalActualHours += stats.actualHours;
    totalPlannedCost += stats.plannedCost;
    totalActualCost += stats.actualCost;
    totalPlannedRevenue += stats.plannedRevenue;
    totalActualRevenue += stats.actualRevenue;

    return {
      day: format(day, 'EEE', { locale: de }),
      date: format(day, 'dd.MM.', { locale: de }),
      week: getWeek(day, { weekStartsOn: 1, locale: de }),
      ...stats,
      employeeCount: dayEntries.length,
    };
  });

  const monthlyLaborPercentage = totalActualRevenue > 0 
    ? (totalActualCost / totalActualRevenue) * 100 
    : 0;

  // Summary Box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 38, 182, 35, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Monatszusammenfassung', 18, 46);

  doc.setFont('helvetica', 'normal');
  const summaryItems = [
    { label: 'Umsatz (Plan)', value: formatCurrency(totalPlannedRevenue), x: 18, y: 54 },
    { label: 'Umsatz (Ist)', value: formatCurrency(totalActualRevenue), x: 75, y: 54 },
    { label: 'Differenz', value: formatCurrency(totalActualRevenue - totalPlannedRevenue), x: 135, y: 54 },
    { label: 'Personalkosten (Plan)', value: formatCurrency(totalPlannedCost), x: 18, y: 62 },
    { label: 'Personalkosten (Ist)', value: formatCurrency(totalActualCost), x: 75, y: 62 },
    { label: 'PK-Quote', value: `${monthlyLaborPercentage.toFixed(1)}%`, x: 135, y: 62 },
    { label: 'Stunden (Plan)', value: formatHours(totalPlannedHours), x: 18, y: 70 },
    { label: 'Stunden (Ist)', value: formatHours(totalActualHours), x: 75, y: 70 },
  ];

  summaryItems.forEach((item) => {
    doc.text(`${item.label}: ${item.value}`, item.x, item.y);
  });

  // Weekly breakdown
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Wochenübersicht', 14, 85);

  // Group by week
  const weeklyData: Record<number, { 
    plannedRevenue: number; actualRevenue: number; 
    plannedCost: number; actualCost: number;
    plannedHours: number; actualHours: number;
    days: number;
  }> = {};

  dailyData.forEach((day: any) => {
    if (!weeklyData[day.week]) {
      weeklyData[day.week] = {
        plannedRevenue: 0, actualRevenue: 0,
        plannedCost: 0, actualCost: 0,
        plannedHours: 0, actualHours: 0,
        days: 0,
      };
    }
    weeklyData[day.week].plannedRevenue += day.plannedRevenue;
    weeklyData[day.week].actualRevenue += day.actualRevenue;
    weeklyData[day.week].plannedCost += day.plannedCost;
    weeklyData[day.week].actualCost += day.actualCost;
    weeklyData[day.week].plannedHours += day.plannedHours;
    weeklyData[day.week].actualHours += day.actualHours;
    weeklyData[day.week].days++;
  });

  const weekTableData = Object.entries(weeklyData).map(([week, data]) => {
    const laborPct = data.actualRevenue > 0 ? (data.actualCost / data.actualRevenue) * 100 : 0;
    return [
      `KW ${week}`,
      formatCurrency(data.plannedRevenue),
      formatCurrency(data.actualRevenue),
      formatCurrency(data.plannedCost),
      formatCurrency(data.actualCost),
      `${laborPct.toFixed(1)}%`,
    ];
  });

  // Add totals row
  weekTableData.push([
    'GESAMT',
    formatCurrency(totalPlannedRevenue),
    formatCurrency(totalActualRevenue),
    formatCurrency(totalPlannedCost),
    formatCurrency(totalActualCost),
    `${monthlyLaborPercentage.toFixed(1)}%`,
  ]);

  autoTable(doc, {
    startY: 90,
    head: [['Woche', 'Umsatz Plan', 'Umsatz Ist', 'PK Plan', 'PK Ist', 'Quote']],
    body: weekTableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 25 },
      1: { cellWidth: 32, halign: 'right' },
      2: { cellWidth: 32, halign: 'right' },
      3: { cellWidth: 32, halign: 'right' },
      4: { cellWidth: 32, halign: 'right' },
      5: { cellWidth: 25, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === weekTableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Department Breakdown
  const finalTableY = (doc as any).lastAutoTable.finalY + 15;
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Aufteilung nach Abteilung', 14, finalTableY);

  const departmentTotals = { küche: { hours: 0, cost: 0 }, service: { hours: 0, cost: 0 } };
  
  timeEntries.forEach((entry) => {
    const dateString = entry.date;
    if (!days.some((d: Date) => format(d, 'yyyy-MM-dd') === dateString)) return;
    
    const employee = employees.find((e) => e.id === entry.employeeId);
    if (!employee) return;

    const hours = entry.actualHours || 0;
    const cost = hours * (getEffectiveHourlyRate(employee, rates) ?? 0);

    departmentTotals[employee.department].hours += hours;
    departmentTotals[employee.department].cost += cost;
  });

  autoTable(doc, {
    startY: finalTableY + 5,
    head: [['Abteilung', 'Stunden', 'Personalkosten', 'Anteil']],
    body: [
      [
        'Küche',
        formatHours(departmentTotals.küche.hours),
        formatCurrency(departmentTotals.küche.cost),
        totalActualCost > 0 
          ? `${((departmentTotals.küche.cost / totalActualCost) * 100).toFixed(1)}%` 
          : '-',
      ],
      [
        'Service',
        formatHours(departmentTotals.service.hours),
        formatCurrency(departmentTotals.service.cost),
        totalActualCost > 0 
          ? `${((departmentTotals.service.cost / totalActualCost) * 100).toFixed(1)}%` 
          : '-',
      ],
    ],
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: 40, halign: 'right' },
      2: { cellWidth: 45, halign: 'right' },
      3: { cellWidth: 30, halign: 'right' },
    },
  });

  // Footer
  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  doc.save(`Personalkosten_${format(selectedDate, 'yyyy-MM', { locale: de })}.pdf`);
};

export const exportCombinedReport = (
  selectedDate: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  dailySummary: DailySummary,
  rates: SocialCostRates
) => {
  const doc = new jsPDF();
  const { startOfMonth, endOfMonth, eachDayOfInterval, getWeek } = require('date-fns');
  
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkosten Gesamtübersicht', 14, 20);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, 28);

  // ====== PAGE 1: Day Overview ======
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`Tagesübersicht: ${format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de })}`, 14, 42);

  const budget = dailyBudgets[dateString] || { plannedRevenue: 0, actualRevenue: 0 };
  const dayEntries = timeEntries.filter((e) => e.date === dateString);

  // Day summary box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 48, 182, 25, 'F');

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const daySummaryItems = [
    { label: 'Mitarbeiter', value: dayEntries.length.toString(), x: 18, y: 56 },
    { label: 'Umsatz Plan', value: formatCurrency(budget.plannedRevenue), x: 55, y: 56 },
    { label: 'Umsatz Ist', value: formatCurrency(budget.actualRevenue), x: 100, y: 56 },
    { label: 'PK-Quote', value: `${dailySummary.laborCostPercentage.toFixed(1)}%`, x: 145, y: 56 },
    { label: 'PK Plan', value: formatCurrency(dailySummary.totalPlannedCost), x: 18, y: 64 },
    { label: 'PK Ist', value: formatCurrency(dailySummary.totalActualCost), x: 55, y: 64 },
    { label: 'Std Plan', value: formatHours(dailySummary.totalPlannedHours), x: 100, y: 64 },
    { label: 'Std Ist', value: formatHours(dailySummary.totalActualHours), x: 145, y: 64 },
  ];

  daySummaryItems.forEach((item) => {
    doc.text(`${item.label}: ${item.value}`, item.x, item.y);
  });

  // Day employee table
  if (dayEntries.length > 0) {
    const dayTableData = dayEntries.map((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (!employee) return ['', '', '', '', ''];
      return [
        employee.name,
        employee.department === 'küche' ? 'Küche' : 'Service',
        `${entry.plannedStart} - ${entry.plannedEnd}`,
        formatHours(entry.plannedHours),
        entry.actualHours !== undefined ? formatHours(entry.actualHours) : '-',
      ];
    });

    autoTable(doc, {
      startY: 78,
      head: [['Name', 'Abteilung', 'Arbeitszeit', 'Std Plan', 'Std Ist']],
      body: dayTableData,
      theme: 'striped',
      headStyles: { fillColor: [51, 51, 51] },
      styles: { fontSize: 8 },
    });
  }

  // ====== PAGE 2: Week Overview ======
  doc.addPage();
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`Wochenübersicht: ${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM yyyy', { locale: de })}`, 14, 20);

  // Calculate week totals
  let weekPlannedHours = 0, weekActualHours = 0, weekPlannedCost = 0, weekActualCost = 0;
  let weekPlannedRevenue = 0, weekActualRevenue = 0;

  const weekData = weekDays.map((day: Date) => {
    const ds = format(day, 'yyyy-MM-dd');
    const entries = timeEntries.filter((e) => e.date === ds);
    const b = dailyBudgets[ds];
    const stats = calculateDayStats({ date: day, dateString: ds, entries, budget: b, employees }, rates);
    
    weekPlannedHours += stats.plannedHours;
    weekActualHours += stats.actualHours;
    weekPlannedCost += stats.plannedCost;
    weekActualCost += stats.actualCost;
    weekPlannedRevenue += stats.plannedRevenue;
    weekActualRevenue += stats.actualRevenue;

    return {
      day: format(day, 'EEE dd.MM.', { locale: de }),
      ...stats,
      employeeCount: entries.length,
    };
  });

  const weekLaborPct = weekActualRevenue > 0 ? (weekActualCost / weekActualRevenue) * 100 : 0;

  // Week summary
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 26, 182, 20, 'F');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Umsatz: ${formatCurrency(weekActualRevenue)} | PK: ${formatCurrency(weekActualCost)} | Quote: ${weekLaborPct.toFixed(1)}% | Stunden: ${formatHours(weekActualHours)}`, 18, 38);

  const weekTableData = weekData.map((d: any) => [
    d.day,
    formatCurrency(d.actualRevenue),
    formatCurrency(d.actualCost),
    formatHours(d.actualHours),
    `${d.laborCostPercentage.toFixed(1)}%`,
    d.employeeCount.toString(),
  ]);

  autoTable(doc, {
    startY: 50,
    head: [['Tag', 'Umsatz', 'PK', 'Stunden', 'Quote', 'MA']],
    body: weekTableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
  });

  // ====== PAGE 3: Month Overview ======
  doc.addPage();
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`Monatsübersicht: ${format(selectedDate, 'MMMM yyyy', { locale: de })}`, 14, 20);

  // Calculate month totals
  let monthPlannedHours = 0, monthActualHours = 0, monthPlannedCost = 0, monthActualCost = 0;
  let monthPlannedRevenue = 0, monthActualRevenue = 0;

  const monthData = monthDays.map((day: Date) => {
    const ds = format(day, 'yyyy-MM-dd');
    const entries = timeEntries.filter((e) => e.date === ds);
    const b = dailyBudgets[ds];
    const stats = calculateDayStats({ date: day, dateString: ds, entries, budget: b, employees }, rates);
    
    monthPlannedHours += stats.plannedHours;
    monthActualHours += stats.actualHours;
    monthPlannedCost += stats.plannedCost;
    monthActualCost += stats.actualCost;
    monthPlannedRevenue += stats.plannedRevenue;
    monthActualRevenue += stats.actualRevenue;

    return {
      day: format(day, 'EEE', { locale: de }),
      date: format(day, 'dd.MM.', { locale: de }),
      week: getWeek(day, { weekStartsOn: 1 }),
      ...stats,
    };
  });

  const monthLaborPct = monthActualRevenue > 0 ? (monthActualCost / monthActualRevenue) * 100 : 0;

  // Month summary
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 26, 182, 25, 'F');
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Umsatz Plan: ${formatCurrency(monthPlannedRevenue)} | Umsatz Ist: ${formatCurrency(monthActualRevenue)}`, 18, 36);
  doc.text(`PK Plan: ${formatCurrency(monthPlannedCost)} | PK Ist: ${formatCurrency(monthActualCost)} | Quote: ${monthLaborPct.toFixed(1)}%`, 18, 44);

  // Group by week for table
  const weeklyTotals: Record<number, any> = {};
  monthData.forEach((d: any) => {
    if (!weeklyTotals[d.week]) {
      weeklyTotals[d.week] = { plannedRevenue: 0, actualRevenue: 0, plannedCost: 0, actualCost: 0, hours: 0 };
    }
    weeklyTotals[d.week].plannedRevenue += d.plannedRevenue;
    weeklyTotals[d.week].actualRevenue += d.actualRevenue;
    weeklyTotals[d.week].plannedCost += d.plannedCost;
    weeklyTotals[d.week].actualCost += d.actualCost;
    weeklyTotals[d.week].hours += d.actualHours;
  });

  const monthTableData = Object.entries(weeklyTotals).map(([week, data]: [string, any]) => {
    const pct = data.actualRevenue > 0 ? (data.actualCost / data.actualRevenue) * 100 : 0;
    return [
      `KW ${week}`,
      formatCurrency(data.plannedRevenue),
      formatCurrency(data.actualRevenue),
      formatCurrency(data.actualCost),
      formatHours(data.hours),
      `${pct.toFixed(1)}%`,
    ];
  });

  monthTableData.push([
    'GESAMT',
    formatCurrency(monthPlannedRevenue),
    formatCurrency(monthActualRevenue),
    formatCurrency(monthActualCost),
    formatHours(monthActualHours),
    `${monthLaborPct.toFixed(1)}%`,
  ]);

  autoTable(doc, {
    startY: 55,
    head: [['Woche', 'Umsatz Plan', 'Umsatz Ist', 'PK Ist', 'Stunden', 'Quote']],
    body: monthTableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    didParseCell: (data) => {
      if (data.row.index === monthTableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Footer on last page
  const finalY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Personalkosten Gesamtübersicht - Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  doc.save(`Personalkosten_Gesamt_${format(selectedDate, 'yyyy-MM-dd')}.pdf`);
};

export const exportLaborCostQuoteReport = (
  selectedDate: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  thresholds: { service: number; küche: number },
  rates: SocialCostRates
) => {
  const doc = new jsPDF();
  const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkostenquote Wochenbericht', 14, 20);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `${format(weekStart, 'd. MMMM', { locale: de })} - ${format(weekEnd, 'd. MMMM yyyy', { locale: de })}`,
    14,
    30
  );

  // Calculate weekly totals by department
  let totalActualRevenue = 0;
  let totalPlannedRevenue = 0;
  let serviceActualCosts = 0;
  let serviceActualHours = 0;
  let kuecheActualCosts = 0;
  let kuecheActualHours = 0;

  const dailyData = days.map((day) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter((e) => e.date === dateString);
    const budget = dailyBudgets[dateString];

    let dayServiceCost = 0;
    let dayServiceHours = 0;
    let dayKuecheCost = 0;
    let dayKuecheHours = 0;

    dayEntries.forEach((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (!employee) return;
      const hours = entry.actualHours || 0;
      const cost = hours * (getEffectiveHourlyRate(employee, rates) ?? 0);

      if (employee.department === 'service') {
        dayServiceCost += cost;
        dayServiceHours += hours;
        serviceActualCosts += cost;
        serviceActualHours += hours;
      } else {
        dayKuecheCost += cost;
        dayKuecheHours += hours;
        kuecheActualCosts += cost;
        kuecheActualHours += hours;
      }
    });

    const dayRevenue = budget?.actualRevenue || 0;
    totalActualRevenue += dayRevenue;
    totalPlannedRevenue += budget?.plannedRevenue || 0;

    const dayTotalCost = dayServiceCost + dayKuecheCost;
    const dayQuote = dayRevenue > 0 ? (dayTotalCost / dayRevenue) * 100 : 0;
    const dayServiceQuote = dayRevenue > 0 ? (dayServiceCost / dayRevenue) * 100 : 0;
    const dayKuecheQuote = dayRevenue > 0 ? (dayKuecheCost / dayRevenue) * 100 : 0;

    return {
      day: format(day, 'EEE', { locale: de }),
      date: format(day, 'dd.MM.', { locale: de }),
      revenue: dayRevenue,
      totalCost: dayTotalCost,
      totalHours: dayServiceHours + dayKuecheHours,
      quote: dayQuote,
      serviceCost: dayServiceCost,
      serviceQuote: dayServiceQuote,
      kuecheCost: dayKuecheCost,
      kuecheQuote: dayKuecheQuote,
      employeeCount: dayEntries.length,
    };
  });

  const totalActualCost = serviceActualCosts + kuecheActualCosts;
  const totalActualHours = serviceActualHours + kuecheActualHours;
  const weeklyQuote = totalActualRevenue > 0 ? (totalActualCost / totalActualRevenue) * 100 : 0;
  const serviceQuote = totalActualRevenue > 0 ? (serviceActualCosts / totalActualRevenue) * 100 : 0;
  const kuecheQuote = totalActualRevenue > 0 ? (kuecheActualCosts / totalActualRevenue) * 100 : 0;

  // Summary Box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 38, 182, 35, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Wochenzusammenfassung', 18, 46);

  doc.setFont('helvetica', 'normal');
  doc.text(`Umsatz (Ist): ${formatCurrency(totalActualRevenue)}`, 18, 54);
  doc.text(`Personalkosten Total: ${formatCurrency(totalActualCost)}`, 75, 54);
  doc.text(`Quote Total: ${weeklyQuote.toFixed(1)}%`, 145, 54);

  doc.text(`Service: ${formatCurrency(serviceActualCosts)} (${serviceQuote.toFixed(1)}%)`, 18, 62);
  if (serviceQuote > thresholds.service) {
    doc.setTextColor(200, 0, 0);
    doc.text(`⚠ > ${thresholds.service}%`, 85, 62);
    doc.setTextColor(0, 0, 0);
  }

  doc.text(`Küche: ${formatCurrency(kuecheActualCosts)} (${kuecheQuote.toFixed(1)}%)`, 100, 62);
  if (kuecheQuote > thresholds.küche) {
    doc.setTextColor(200, 0, 0);
    doc.text(`⚠ > ${thresholds.küche}%`, 165, 62);
    doc.setTextColor(0, 0, 0);
  }

  doc.text(`Arbeitsstunden: ${formatHours(totalActualHours)}`, 18, 70);

  // Daily Table with department breakdown
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Tagesübersicht', 14, 85);

  const tableData = dailyData.map((day) => [
    `${day.day} ${day.date}`,
    formatCurrency(day.revenue),
    formatCurrency(day.totalCost),
    `${day.quote.toFixed(1)}%`,
    `${formatCurrency(day.serviceCost)} (${day.serviceQuote.toFixed(1)}%)`,
    `${formatCurrency(day.kuecheCost)} (${day.kuecheQuote.toFixed(1)}%)`,
  ]);

  // Add totals row
  tableData.push([
    'GESAMT',
    formatCurrency(totalActualRevenue),
    formatCurrency(totalActualCost),
    `${weeklyQuote.toFixed(1)}%`,
    `${formatCurrency(serviceActualCosts)} (${serviceQuote.toFixed(1)}%)`,
    `${formatCurrency(kuecheActualCosts)} (${kuecheQuote.toFixed(1)}%)`,
  ]);

  autoTable(doc, {
    startY: 90,
    head: [['Tag', 'Umsatz', 'PK Total', 'Quote', 'Service (Quote)', 'Küche (Quote)']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 25 },
      1: { cellWidth: 28, halign: 'right' },
      2: { cellWidth: 28, halign: 'right' },
      3: { cellWidth: 22, halign: 'right' },
      4: { cellWidth: 40, halign: 'right' },
      5: { cellWidth: 40, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === tableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Department Summary Table
  const finalTableY = (doc as any).lastAutoTable.finalY + 15;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Aufteilung nach Abteilung', 14, finalTableY);

  const isServiceOver = serviceQuote > thresholds.service;
  const isKuecheOver = kuecheQuote > thresholds.küche;

  autoTable(doc, {
    startY: finalTableY + 5,
    head: [['Abteilung', 'Stunden', 'Personalkosten', 'Quote', 'Schwellwert', 'Status']],
    body: [
      [
        'Service',
        formatHours(serviceActualHours),
        formatCurrency(serviceActualCosts),
        `${serviceQuote.toFixed(1)}%`,
        `${thresholds.service}%`,
        isServiceOver ? '⚠ Überschritten' : '✓ OK',
      ],
      [
        'Küche',
        formatHours(kuecheActualHours),
        formatCurrency(kuecheActualCosts),
        `${kuecheQuote.toFixed(1)}%`,
        `${thresholds.küche}%`,
        isKuecheOver ? '⚠ Überschritten' : '✓ OK',
      ],
      [
        'TOTAL',
        formatHours(totalActualHours),
        formatCurrency(totalActualCost),
        `${weeklyQuote.toFixed(1)}%`,
        '-',
        '',
      ],
    ],
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 25, halign: 'right' },
      2: { cellWidth: 35, halign: 'right' },
      3: { cellWidth: 25, halign: 'right' },
      4: { cellWidth: 28, halign: 'right' },
      5: { cellWidth: 35 },
    },
    didParseCell: (data) => {
      if (data.column.index === 5) {
        if (String(data.cell.raw).includes('⚠')) {
          data.cell.styles.textColor = [200, 0, 0];
          data.cell.styles.fontStyle = 'bold';
        } else if (String(data.cell.raw).includes('✓')) {
          data.cell.styles.textColor = [0, 150, 0];
        }
      }
      if (data.row.index === 2) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Footer
  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  const weekNumber = format(weekStart, 'ww', { locale: de });
  doc.save(`Personalkostenquote_KW${weekNumber}_${format(weekStart, 'yyyy')}.pdf`);
};

export const exportLaborCostQuoteMonthlyReport = (
  selectedDate: Date,
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  thresholds: { service: number; küche: number },
  rates: SocialCostRates
) => {
  const doc = new jsPDF();
  const { startOfMonth, endOfMonth, eachDayOfInterval, getWeek } = require('date-fns');
  
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Header
  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('Personalkostenquote Monatsbericht', 14, 20);

  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(format(selectedDate, 'MMMM yyyy', { locale: de }), 14, 30);

  // Calculate monthly totals by department
  let totalActualRevenue = 0;
  let totalPlannedRevenue = 0;
  let serviceActualCosts = 0;
  let serviceActualHours = 0;
  let kuecheActualCosts = 0;
  let kuecheActualHours = 0;

  // Group by week
  const weeklyData: Record<number, {
    revenue: number;
    serviceCost: number;
    serviceHours: number;
    kuecheCost: number;
    kuecheHours: number;
  }> = {};

  days.forEach((day: Date) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const week = getWeek(day, { weekStartsOn: 1 });
    const dayEntries = timeEntries.filter((e) => e.date === dateString);
    const budget = dailyBudgets[dateString];

    if (!weeklyData[week]) {
      weeklyData[week] = { revenue: 0, serviceCost: 0, serviceHours: 0, kuecheCost: 0, kuecheHours: 0 };
    }

    dayEntries.forEach((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (!employee) return;
      const hours = entry.actualHours || 0;
      const cost = hours * (getEffectiveHourlyRate(employee, rates) ?? 0);

      if (employee.department === 'service') {
        weeklyData[week].serviceCost += cost;
        weeklyData[week].serviceHours += hours;
        serviceActualCosts += cost;
        serviceActualHours += hours;
      } else {
        weeklyData[week].kuecheCost += cost;
        weeklyData[week].kuecheHours += hours;
        kuecheActualCosts += cost;
        kuecheActualHours += hours;
      }
    });

    const dayRevenue = budget?.actualRevenue || 0;
    weeklyData[week].revenue += dayRevenue;
    totalActualRevenue += dayRevenue;
    totalPlannedRevenue += budget?.plannedRevenue || 0;
  });

  const totalActualCost = serviceActualCosts + kuecheActualCosts;
  const totalActualHours = serviceActualHours + kuecheActualHours;
  const monthlyQuote = totalActualRevenue > 0 ? (totalActualCost / totalActualRevenue) * 100 : 0;
  const serviceQuote = totalActualRevenue > 0 ? (serviceActualCosts / totalActualRevenue) * 100 : 0;
  const kuecheQuote = totalActualRevenue > 0 ? (kuecheActualCosts / totalActualRevenue) * 100 : 0;

  // Summary Box
  doc.setFillColor(245, 245, 245);
  doc.rect(14, 38, 182, 35, 'F');

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('Monatszusammenfassung', 18, 46);

  doc.setFont('helvetica', 'normal');
  doc.text(`Umsatz (Ist): ${formatCurrency(totalActualRevenue)}`, 18, 54);
  doc.text(`Personalkosten Total: ${formatCurrency(totalActualCost)}`, 75, 54);
  doc.text(`Quote Total: ${monthlyQuote.toFixed(1)}%`, 145, 54);

  doc.text(`Service: ${formatCurrency(serviceActualCosts)} (${serviceQuote.toFixed(1)}%)`, 18, 62);
  if (serviceQuote > thresholds.service) {
    doc.setTextColor(200, 0, 0);
    doc.text(`⚠ > ${thresholds.service}%`, 85, 62);
    doc.setTextColor(0, 0, 0);
  }

  doc.text(`Küche: ${formatCurrency(kuecheActualCosts)} (${kuecheQuote.toFixed(1)}%)`, 100, 62);
  if (kuecheQuote > thresholds.küche) {
    doc.setTextColor(200, 0, 0);
    doc.text(`⚠ > ${thresholds.küche}%`, 165, 62);
    doc.setTextColor(0, 0, 0);
  }

  doc.text(`Arbeitsstunden: ${formatHours(totalActualHours)}`, 18, 70);

  // Weekly Table with department breakdown
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Wochenübersicht', 14, 85);

  const tableData = Object.entries(weeklyData).map(([week, data]) => {
    const weekTotalCost = data.serviceCost + data.kuecheCost;
    const weekQuote = data.revenue > 0 ? (weekTotalCost / data.revenue) * 100 : 0;
    const weekServiceQuote = data.revenue > 0 ? (data.serviceCost / data.revenue) * 100 : 0;
    const weekKuecheQuote = data.revenue > 0 ? (data.kuecheCost / data.revenue) * 100 : 0;

    return [
      `KW ${week}`,
      formatCurrency(data.revenue),
      formatCurrency(weekTotalCost),
      `${weekQuote.toFixed(1)}%`,
      `${formatCurrency(data.serviceCost)} (${weekServiceQuote.toFixed(1)}%)`,
      `${formatCurrency(data.kuecheCost)} (${weekKuecheQuote.toFixed(1)}%)`,
    ];
  });

  // Add totals row
  tableData.push([
    'GESAMT',
    formatCurrency(totalActualRevenue),
    formatCurrency(totalActualCost),
    `${monthlyQuote.toFixed(1)}%`,
    `${formatCurrency(serviceActualCosts)} (${serviceQuote.toFixed(1)}%)`,
    `${formatCurrency(kuecheActualCosts)} (${kuecheQuote.toFixed(1)}%)`,
  ]);

  autoTable(doc, {
    startY: 90,
    head: [['Woche', 'Umsatz', 'PK Total', 'Quote', 'Service (Quote)', 'Küche (Quote)']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 28, halign: 'right' },
      2: { cellWidth: 28, halign: 'right' },
      3: { cellWidth: 22, halign: 'right' },
      4: { cellWidth: 42, halign: 'right' },
      5: { cellWidth: 42, halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === tableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Department Summary Table
  const finalTableY = (doc as any).lastAutoTable.finalY + 15;

  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Aufteilung nach Abteilung', 14, finalTableY);

  const isServiceOver = serviceQuote > thresholds.service;
  const isKuecheOver = kuecheQuote > thresholds.küche;

  autoTable(doc, {
    startY: finalTableY + 5,
    head: [['Abteilung', 'Stunden', 'Personalkosten', 'Quote', 'Schwellwert', 'Status']],
    body: [
      [
        'Service',
        formatHours(serviceActualHours),
        formatCurrency(serviceActualCosts),
        `${serviceQuote.toFixed(1)}%`,
        `${thresholds.service}%`,
        isServiceOver ? '⚠ Überschritten' : '✓ OK',
      ],
      [
        'Küche',
        formatHours(kuecheActualHours),
        formatCurrency(kuecheActualCosts),
        `${kuecheQuote.toFixed(1)}%`,
        `${thresholds.küche}%`,
        isKuecheOver ? '⚠ Überschritten' : '✓ OK',
      ],
      [
        'TOTAL',
        formatHours(totalActualHours),
        formatCurrency(totalActualCost),
        `${monthlyQuote.toFixed(1)}%`,
        '-',
        '',
      ],
    ],
    theme: 'striped',
    headStyles: { fillColor: [51, 51, 51] },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 25, halign: 'right' },
      2: { cellWidth: 35, halign: 'right' },
      3: { cellWidth: 25, halign: 'right' },
      4: { cellWidth: 28, halign: 'right' },
      5: { cellWidth: 35 },
    },
    didParseCell: (data) => {
      if (data.column.index === 5) {
        if (String(data.cell.raw).includes('⚠')) {
          data.cell.styles.textColor = [200, 0, 0];
          data.cell.styles.fontStyle = 'bold';
        } else if (String(data.cell.raw).includes('✓')) {
          data.cell.styles.textColor = [0, 150, 0];
        }
      }
      if (data.row.index === 2) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 230];
      }
    },
  });

  // Footer
  const finalY = (doc as any).lastAutoTable.finalY + 10;
  doc.setFontSize(8);
  doc.setTextColor(128, 128, 128);
  doc.text(`Erstellt am ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, finalY);

  // Save
  doc.save(`Personalkostenquote_${format(selectedDate, 'yyyy-MM')}.pdf`);
};
