import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getWeek, getDay, addWeeks, startOfWeek, endOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { formatCurrency, formatHours } from './personnel-utils';

interface WeekTrendData {
  weekNum: number;
  startDate: Date;
  endDate: Date;
  costs: number;
  hours: number;
  avgPerDay: number;
  daysWithData: number;
  change: number;
  changePercent: number;
}

interface WeekdayStats {
  label: string;
  short: string;
  avgHours: number;
  avgCosts: number;
  avgHourly: number;
  totalDays: number;
}

interface ForecastData {
  actualCostsToDate: number;
  actualHoursToDate: number;
  projectedFutureCosts: number;
  projectedFutureHours: number;
  projectedTotalCosts: number;
  projectedTotalHours: number;
  monthlyPlannedCostsTotal: number;
  monthlyPlannedHoursTotal: number;
  costVariance: number;
  costVariancePercent: number;
  progressPercent: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  daysWithData: number;
  avgDailyCost: number;
  avgDailyHours: number;
  remainingDays: number;
}

interface DepartmentData {
  name: string;
  hours: number;
  costs: number;
  employees: number;
  avgHourlyRate: number;
  plannedHours: number;
  plannedCosts: number;
}

const WEEKDAYS = [
  { key: 1, label: 'Montag', short: 'Mo' },
  { key: 2, label: 'Dienstag', short: 'Di' },
  { key: 3, label: 'Mittwoch', short: 'Mi' },
  { key: 4, label: 'Donnerstag', short: 'Do' },
  { key: 5, label: 'Freitag', short: 'Fr' },
  { key: 6, label: 'Samstag', short: 'Sa' },
  { key: 0, label: 'Sonntag', short: 'So' },
];

// Calculate cost trend data
const calculateTrendData = (
  monthDays: Date[],
  getHoursForDate: (date: string) => number,
  getCostsForDate: (date: string) => number,
  displayMonth: Date
): WeekTrendData[] => {
  const weeks: WeekTrendData[] = [];
  const today = new Date();
  const monthEnd = endOfMonth(displayMonth);
  
  let weekNum = 1;
  let currentWeekStart = startOfMonth(displayMonth);
  
  while (currentWeekStart <= monthEnd) {
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    const actualWeekEnd = weekEnd > monthEnd ? monthEnd : weekEnd;
    const daysInWeek = eachDayOfInterval({ start: currentWeekStart, end: actualWeekEnd });
    
    let weekCosts = 0;
    let weekHours = 0;
    let daysWithData = 0;
    
    daysInWeek.forEach(day => {
      if (day <= today) {
        const dateString = format(day, 'yyyy-MM-dd');
        const dayCosts = getCostsForDate(dateString);
        const dayHours = getHoursForDate(dateString);
        
        if (dayHours > 0) {
          weekCosts += dayCosts;
          weekHours += dayHours;
          daysWithData += 1;
        }
      }
    });
    
    if (daysWithData > 0) {
      weeks.push({
        weekNum,
        startDate: currentWeekStart,
        endDate: actualWeekEnd,
        costs: weekCosts,
        hours: weekHours,
        avgPerDay: weekCosts / daysWithData,
        daysWithData,
        change: 0,
        changePercent: 0
      });
    }
    
    weekNum++;
    currentWeekStart = addWeeks(currentWeekStart, 1);
    if (currentWeekStart.getMonth() !== displayMonth.getMonth()) break;
  }
  
  // Calculate week-over-week changes
  return weeks.map((week, idx) => {
    if (idx === 0) return week;
    const prevWeek = weeks[idx - 1];
    const change = week.avgPerDay - prevWeek.avgPerDay;
    const changePercent = prevWeek.avgPerDay > 0 ? (change / prevWeek.avgPerDay) * 100 : 0;
    return { ...week, change, changePercent };
  });
};

// Calculate weekday statistics
const calculateWeekdayStats = (
  monthDays: Date[],
  getHoursForDate: (date: string) => number,
  getCostsForDate: (date: string) => number
): WeekdayStats[] => {
  const stats: Record<number, { hours: number; costs: number; days: number }> = {};
  WEEKDAYS.forEach(wd => {
    stats[wd.key] = { hours: 0, costs: 0, days: 0 };
  });

  monthDays.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayOfWeek = getDay(day);
    const dayHours = getHoursForDate(dateString);
    const dayCosts = getCostsForDate(dateString);
    
    if (dayHours > 0) {
      stats[dayOfWeek].hours += dayHours;
      stats[dayOfWeek].costs += dayCosts;
      stats[dayOfWeek].days += 1;
    }
  });

  return WEEKDAYS.map(wd => {
    const s = stats[wd.key];
    return {
      label: wd.label,
      short: wd.short,
      avgHours: s.days > 0 ? s.hours / s.days : 0,
      avgCosts: s.days > 0 ? s.costs / s.days : 0,
      avgHourly: s.hours > 0 ? s.costs / s.hours : 0,
      totalDays: s.days,
    };
  }).filter(s => s.totalDays > 0);
};

// Calculate forecast data
const calculateForecast = (
  monthDays: Date[],
  getHoursForDate: (date: string, mode: 'planned' | 'actual') => number,
  getCostsForDate: (date: string, mode: 'planned' | 'actual') => number,
  displayMonth: Date
): ForecastData => {
  const today = new Date();
  const isCurrentMonth = today.getMonth() === displayMonth.getMonth() && today.getFullYear() === displayMonth.getFullYear();
  
  const pastDays = monthDays.filter(day => day <= today);
  const futureDays = monthDays.filter(day => day > today);
  
  let actualCostsToDate = 0;
  let actualHoursToDate = 0;
  let daysWithData = 0;
  
  pastDays.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayCosts = getCostsForDate(dateString, 'actual');
    const dayHours = getHoursForDate(dateString, 'actual');
    actualCostsToDate += dayCosts;
    actualHoursToDate += dayHours;
    if (dayHours > 0) daysWithData++;
  });
  
  let monthlyPlannedCostsTotal = 0;
  let monthlyPlannedHoursTotal = 0;
  monthDays.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    monthlyPlannedCostsTotal += getCostsForDate(dateString, 'planned');
    monthlyPlannedHoursTotal += getHoursForDate(dateString, 'planned');
  });
  
  const avgDailyCost = daysWithData > 0 ? actualCostsToDate / daysWithData : 0;
  const avgDailyHours = daysWithData > 0 ? actualHoursToDate / daysWithData : 0;
  
  let projectedFutureCosts = 0;
  let projectedFutureHours = 0;
  
  if (isCurrentMonth) {
    futureDays.forEach(day => {
      const dateString = format(day, 'yyyy-MM-dd');
      const plannedCosts = getCostsForDate(dateString, 'planned');
      const plannedHours = getHoursForDate(dateString, 'planned');
      projectedFutureCosts += plannedCosts > 0 ? plannedCosts : avgDailyCost;
      projectedFutureHours += plannedHours > 0 ? plannedHours : avgDailyHours;
    });
  }
  
  const projectedTotalCosts = actualCostsToDate + projectedFutureCosts;
  const projectedTotalHours = actualHoursToDate + projectedFutureHours;
  const costVariance = projectedTotalCosts - monthlyPlannedCostsTotal;
  const costVariancePercent = monthlyPlannedCostsTotal > 0 ? (costVariance / monthlyPlannedCostsTotal) * 100 : 0;
  const progressPercent = (pastDays.length / monthDays.length) * 100;
  
  let confidenceLevel: 'high' | 'medium' | 'low' = 'low';
  if (daysWithData >= 15) confidenceLevel = 'high';
  else if (daysWithData >= 7) confidenceLevel = 'medium';
  
  return {
    actualCostsToDate,
    actualHoursToDate,
    projectedFutureCosts,
    projectedFutureHours,
    projectedTotalCosts,
    projectedTotalHours,
    monthlyPlannedCostsTotal,
    monthlyPlannedHoursTotal,
    costVariance,
    costVariancePercent,
    progressPercent,
    confidenceLevel,
    daysWithData,
    avgDailyCost,
    avgDailyHours,
    remainingDays: futureDays.length,
  };
};

// Draw a simple bar chart
const drawBarChart = (
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  height: number,
  data: { label: string; value: number; color: [number, number, number] }[],
  title?: string
) => {
  if (title) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(100, 116, 139);
    doc.text(title, x, y - 3);
  }
  
  const maxValue = Math.max(...data.map(d => d.value), 1);
  const barWidth = (width - (data.length - 1) * 3) / data.length;
  
  data.forEach((d, i) => {
    const barX = x + i * (barWidth + 3);
    const barHeight = (d.value / maxValue) * (height - 15);
    const barY = y + height - barHeight - 12;
    
    doc.setFillColor(d.color[0], d.color[1], d.color[2]);
    doc.roundedRect(barX, barY, barWidth, barHeight, 2, 2, 'F');
    
    doc.setFontSize(7);
    doc.setTextColor(d.color[0], d.color[1], d.color[2]);
    doc.text(d.label, barX + barWidth / 2, y + height - 5, { align: 'center' });
    
    doc.setTextColor(30, 41, 59);
    doc.text(formatCurrency(d.value), barX + barWidth / 2, barY - 2, { align: 'center' });
  });
};

// Draw trend arrow
const drawTrendIndicator = (doc: jsPDF, x: number, y: number, isPositive: boolean, isNeutral: boolean) => {
  doc.setFontSize(12);
  if (isNeutral) {
    doc.setTextColor(234, 179, 8);
    doc.text('→', x, y);
  } else if (isPositive) {
    doc.setTextColor(34, 197, 94);
    doc.text('↓', x, y);
  } else {
    doc.setTextColor(239, 68, 68);
    doc.text('↑', x, y);
  }
};

export const exportComprehensiveReport = (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  selectedDate: Date
) => {
  const doc = new jsPDF();
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const today = new Date();
  
  // Helper functions
  const getHoursForDate = (dateString: string, mode: 'planned' | 'actual' = 'actual') => {
    const dayEntries = timeEntries.filter(te => te.date === dateString);
    if (mode === 'planned') {
      return dayEntries.reduce((sum, entry) => sum + (entry.plannedHours || 0), 0);
    }
    return dayEntries.reduce((sum, entry) => sum + (entry.actualHours || 0), 0);
  };
  
  const getCostsForDate = (dateString: string, mode: 'planned' | 'actual' = 'actual') => {
    const dayEntries = timeEntries.filter(te => te.date === dateString);
    return dayEntries.reduce((sum, entry) => {
      const employee = employees.find(e => e.id === entry.employeeId);
      if (!employee) return sum;
      const hours = mode === 'planned' ? (entry.plannedHours || 0) : (entry.actualHours || 0);
      return sum + hours * employee.hourlyWage;
    }, 0);
  };
  
  // Calculate all data
  const trendData = calculateTrendData(monthDays, 
    (d) => getHoursForDate(d, 'actual'), 
    (d) => getCostsForDate(d, 'actual'), 
    selectedDate
  );
  const weekdayStats = calculateWeekdayStats(monthDays, 
    (d) => getHoursForDate(d, 'actual'), 
    (d) => getCostsForDate(d, 'actual')
  );
  const forecast = calculateForecast(monthDays, getHoursForDate, getCostsForDate, selectedDate);
  
  // Calculate department data
  const serviceDept: DepartmentData = { name: 'Service', hours: 0, costs: 0, employees: 0, avgHourlyRate: 0, plannedHours: 0, plannedCosts: 0 };
  const kitchenDept: DepartmentData = { name: 'Küche', hours: 0, costs: 0, employees: 0, avgHourlyRate: 0, plannedHours: 0, plannedCosts: 0 };
  const serviceEmployeeIds = new Set<string>();
  const kitchenEmployeeIds = new Set<string>();
  
  monthDays.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter(te => te.date === dateString);
    
    dayEntries.forEach(entry => {
      const employee = employees.find(e => e.id === entry.employeeId);
      if (!employee) return;
      
      const actualHours = entry.actualHours || 0;
      const plannedHours = entry.plannedHours || 0;
      const actualCost = actualHours * employee.hourlyWage;
      const plannedCost = plannedHours * employee.hourlyWage;
      
      if (employee.department === 'service') {
        serviceDept.hours += actualHours;
        serviceDept.costs += actualCost;
        serviceDept.plannedHours += plannedHours;
        serviceDept.plannedCosts += plannedCost;
        serviceEmployeeIds.add(employee.id);
      } else {
        kitchenDept.hours += actualHours;
        kitchenDept.costs += actualCost;
        kitchenDept.plannedHours += plannedHours;
        kitchenDept.plannedCosts += plannedCost;
        kitchenEmployeeIds.add(employee.id);
      }
    });
  });
  
  serviceDept.employees = serviceEmployeeIds.size;
  kitchenDept.employees = kitchenEmployeeIds.size;
  serviceDept.avgHourlyRate = serviceDept.hours > 0 ? serviceDept.costs / serviceDept.hours : 0;
  kitchenDept.avgHourlyRate = kitchenDept.hours > 0 ? kitchenDept.costs / kitchenDept.hours : 0;
  
  const totalActualCosts = serviceDept.costs + kitchenDept.costs;
  const totalActualHours = serviceDept.hours + kitchenDept.hours;
  const totalPlannedCosts = serviceDept.plannedCosts + kitchenDept.plannedCosts;
  const totalPlannedHours = serviceDept.plannedHours + kitchenDept.plannedHours;
  const avgHourlyRate = totalActualHours > 0 ? totalActualCosts / totalActualHours : 0;
  
  // Calculate revenue
  let totalRevenue = 0;
  let totalPlannedRevenue = 0;
  monthDays.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    const budget = dailyBudgets[dateString];
    totalRevenue += budget?.actualRevenue || 0;
    totalPlannedRevenue += budget?.plannedRevenue || 0;
  });
  
  const laborQuote = totalRevenue > 0 ? (totalActualCosts / totalRevenue) * 100 : 0;
  const laborQuotePlanned = totalPlannedRevenue > 0 ? (totalPlannedCosts / totalPlannedRevenue) * 100 : 0;
  
  // ==================== PAGE 1: Executive Summary ====================
  
  // Header
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Umfassender Kosten-Report', 14, 22);
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(format(selectedDate, 'MMMM yyyy', { locale: de }), 14, 30);
  
  // Status Badge
  const isOverBudget = totalActualCosts > totalPlannedCosts;
  const overBudgetPercent = totalPlannedCosts > 0 ? ((totalActualCosts - totalPlannedCosts) / totalPlannedCosts) * 100 : 0;
  
  doc.setFillColor(isOverBudget ? 239 : 34, isOverBudget ? 68 : 197, isOverBudget ? 68 : 94);
  doc.roundedRect(150, 15, 45, 12, 3, 3, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(isOverBudget ? 'ÜBER BUDGET' : 'IM BUDGET', 172.5, 23, { align: 'center' });
  
  // Key Metrics Summary Box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(14, 38, 182, 40, 3, 3, 'FD');
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Monatsübersicht', 20, 50);
  
  // Key metrics in grid
  const summaryMetrics = [
    { label: 'Ist-Kosten', value: `CHF ${formatCurrency(totalActualCosts)}`, x: 20 },
    { label: 'Plan-Kosten', value: `CHF ${formatCurrency(totalPlannedCosts)}`, x: 70 },
    { label: 'Differenz', value: `${isOverBudget ? '+' : '-'}CHF ${formatCurrency(Math.abs(totalActualCosts - totalPlannedCosts))}`, x: 120, color: isOverBudget ? [239, 68, 68] : [34, 197, 94] },
    { label: 'PK-Quote', value: `${laborQuote.toFixed(1)}%`, x: 160 },
  ];
  
  doc.setFontSize(8);
  summaryMetrics.forEach(m => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(m.label, m.x, 58);
    
    doc.setFont('helvetica', 'bold');
    if (m.color) {
      doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    } else {
      doc.setTextColor(30, 41, 59);
    }
    doc.setFontSize(11);
    doc.text(m.value, m.x, 67);
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
  });
  
  // Second row metrics
  const secondRowMetrics = [
    { label: 'Umsatz', value: `CHF ${formatCurrency(totalRevenue)}`, x: 20 },
    { label: 'Stunden Ist', value: formatHours(totalActualHours), x: 70 },
    { label: 'Ø CHF/Std', value: `CHF ${avgHourlyRate.toFixed(2)}`, x: 120 },
    { label: 'Mitarbeiter', value: `${serviceDept.employees + kitchenDept.employees}`, x: 160 },
  ];
  
  secondRowMetrics.forEach(m => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(m.label, m.x, 72);
    doc.text(m.value, m.x, 78);
  });
  
  // ==================== Trend Analysis Section ====================
  if (trendData.length >= 2) {
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Kosten-Trend Analyse', 14, 95);
    
    const firstWeekAvg = trendData[0].avgPerDay;
    const lastWeekAvg = trendData[trendData.length - 1].avgPerDay;
    const overallChange = lastWeekAvg - firstWeekAvg;
    const overallChangePercent = firstWeekAvg > 0 ? (overallChange / firstWeekAvg) * 100 : 0;
    const isImproving = overallChange < 0;
    const isStable = Math.abs(overallChangePercent) < 5;
    
    // Trend indicator box
    doc.setFillColor(isImproving ? 220 : isStable ? 254 : 254, isImproving ? 252 : isStable ? 249 : 226, isImproving ? 231 : isStable ? 195 : 226);
    doc.setDrawColor(isImproving ? 187 : isStable ? 253 : 252, isImproving ? 247 : isStable ? 224 : 165, isImproving ? 208 : isStable ? 71 : 165);
    doc.roundedRect(14, 100, 90, 35, 3, 3, 'FD');
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(isImproving ? 22 : isStable ? 133 : 153, isImproving ? 101 : isStable ? 77 : 27, isImproving ? 52 : isStable ? 14 : 27);
    doc.text(isImproving ? '↓ Kosten verbessern sich' : isStable ? '→ Kosten stabil' : '↑ Kosten steigen', 20, 112);
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(`Gesamtveränderung: ${overallChangePercent >= 0 ? '+' : ''}${overallChangePercent.toFixed(1)}%`, 20, 120);
    doc.text(`Woche 1: CHF ${formatCurrency(firstWeekAvg)}/Tag`, 20, 127);
    doc.text(`Woche ${trendData.length}: CHF ${formatCurrency(lastWeekAvg)}/Tag`, 20, 134);
    
    // Weekly trend chart
    drawBarChart(doc, 110, 102, 86, 33, trendData.map((w, i) => ({
      label: `KW${w.weekNum}`,
      value: w.avgPerDay,
      color: i === trendData.length - 1 ? [16, 185, 129] : w.changePercent > 5 ? [239, 68, 68] : w.changePercent < -5 ? [34, 197, 94] : [59, 130, 246]
    })), 'Ø Kosten/Tag pro Woche');
  }
  
  // ==================== Weekday Analysis Section ====================
  if (weekdayStats.length > 0) {
    const weekdayY = trendData.length >= 2 ? 145 : 95;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Wochentags-Kostenanalyse', 14, weekdayY);
    
    const maxCost = Math.max(...weekdayStats.map(w => w.avgCosts));
    const minCost = Math.min(...weekdayStats.map(w => w.avgCosts));
    const avgCost = weekdayStats.reduce((s, w) => s + w.avgCosts, 0) / weekdayStats.length;
    
    autoTable(doc, {
      startY: weekdayY + 5,
      head: [['Tag', 'Ø Stunden', 'Ø Kosten', 'Ø CHF/Std', 'vs. Ø', 'Bewertung']],
      body: weekdayStats.map(w => {
        const diff = avgCost > 0 ? ((w.avgCosts - avgCost) / avgCost) * 100 : 0;
        const isExpensive = w.avgCosts === maxCost;
        const isCheap = w.avgCosts === minCost && weekdayStats.length > 1;
        return [
          w.label,
          w.avgHours.toFixed(1),
          `CHF ${formatCurrency(w.avgCosts)}`,
          `CHF ${w.avgHourly.toFixed(2)}`,
          `${diff >= 0 ? '+' : ''}${diff.toFixed(0)}%`,
          isExpensive ? '🔴 Teuerster' : isCheap ? '🟢 Günstigster' : diff > 10 ? '🟠 Über Ø' : '🔵 Normal'
        ];
      }),
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], fontSize: 7 },
      styles: { fontSize: 7 },
      columnStyles: {
        0: { fontStyle: 'bold' },
        4: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.column.index === 4 && data.section === 'body') {
          const w = weekdayStats[data.row.index];
          const diff = avgCost > 0 ? ((w.avgCosts - avgCost) / avgCost) * 100 : 0;
          data.cell.styles.textColor = diff > 5 ? [239, 68, 68] : diff < -5 ? [34, 197, 94] : [100, 116, 139];
        }
      }
    });
  }
  
  // ==================== PAGE 2: Forecast & Department Analysis ====================
  doc.addPage();
  
  // Forecast Section
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Monatsend-Prognose', 14, 20);
  
  const confLabels = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' };
  const confColors = { high: [34, 197, 94], medium: [234, 179, 8], low: [239, 68, 68] };
  
  doc.setFillColor(239, 246, 255);
  doc.setDrawColor(147, 197, 253);
  doc.roundedRect(14, 28, 182, 55, 3, 3, 'FD');
  
  // Progress bar
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Monatsfortschritt: ${forecast.progressPercent.toFixed(0)}% (${forecast.daysWithData} Tage mit Daten)`, 20, 38);
  
  doc.setFillColor(226, 232, 240);
  doc.roundedRect(20, 42, 170, 6, 2, 2, 'F');
  doc.setFillColor(59, 130, 246);
  doc.roundedRect(20, 42, 170 * (forecast.progressPercent / 100), 6, 2, 2, 'F');
  
  // Forecast metrics
  const forecastMetrics = [
    { label: 'Ist bis heute', value: `CHF ${formatCurrency(forecast.actualCostsToDate)}`, sub: `${formatHours(forecast.actualHoursToDate)} Std`, x: 20 },
    { label: 'Prognose Rest', value: `CHF ${formatCurrency(forecast.projectedFutureCosts)}`, sub: `${formatHours(forecast.projectedFutureHours)} Std`, x: 65 },
    { label: 'Prognose Gesamt', value: `CHF ${formatCurrency(forecast.projectedTotalCosts)}`, sub: `${formatHours(forecast.projectedTotalHours)} Std`, x: 110 },
    { label: 'vs. Plan', value: `${forecast.costVariance >= 0 ? '+' : ''}CHF ${formatCurrency(forecast.costVariance)}`, sub: `${forecast.costVariancePercent >= 0 ? '+' : ''}${forecast.costVariancePercent.toFixed(1)}%`, x: 155, color: forecast.costVariance > 0 ? [239, 68, 68] : [34, 197, 94] },
  ];
  
  forecastMetrics.forEach(m => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(7);
    doc.text(m.label, m.x, 56);
    
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    if (m.color) {
      doc.setTextColor(m.color[0], m.color[1], m.color[2]);
    } else {
      doc.setTextColor(30, 41, 59);
    }
    doc.text(m.value, m.x, 64);
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(m.sub, m.x, 70);
  });
  
  // Confidence badge
  const cc = confColors[forecast.confidenceLevel];
  doc.setFillColor(cc[0], cc[1], cc[2]);
  doc.roundedRect(20, 74, 35, 6, 2, 2, 'F');
  doc.setFontSize(6);
  doc.setTextColor(255, 255, 255);
  doc.text(`Konfidenz: ${confLabels[forecast.confidenceLevel]}`, 22, 78);
  
  // Department Analysis
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Abteilungsanalyse', 14, 100);
  
  // Department split bar
  const totalCosts = serviceDept.costs + kitchenDept.costs;
  const servicePct = totalCosts > 0 ? (serviceDept.costs / totalCosts) * 100 : 50;
  
  doc.setFillColor(59, 130, 246);
  doc.roundedRect(14, 106, 182 * (servicePct / 100), 10, 0, 0, 'F');
  doc.setFillColor(234, 179, 8);
  doc.roundedRect(14 + 182 * (servicePct / 100), 106, 182 * ((100 - servicePct) / 100), 10, 0, 0, 'F');
  
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  if (servicePct > 20) doc.text(`Service ${servicePct.toFixed(0)}%`, 25, 113);
  if ((100 - servicePct) > 20) doc.text(`Küche ${(100 - servicePct).toFixed(0)}%`, 165, 113);
  
  autoTable(doc, {
    startY: 122,
    head: [['Abteilung', 'MA', 'Stunden Ist', 'Stunden Plan', 'Kosten Ist', 'Kosten Plan', 'Diff', 'Ø CHF/Std']],
    body: [
      ['Service', serviceDept.employees.toString(), formatHours(serviceDept.hours), formatHours(serviceDept.plannedHours), 
       `CHF ${formatCurrency(serviceDept.costs)}`, `CHF ${formatCurrency(serviceDept.plannedCosts)}`,
       `${serviceDept.costs - serviceDept.plannedCosts >= 0 ? '+' : ''}${formatCurrency(serviceDept.costs - serviceDept.plannedCosts)}`,
       `CHF ${serviceDept.avgHourlyRate.toFixed(2)}`],
      ['Küche', kitchenDept.employees.toString(), formatHours(kitchenDept.hours), formatHours(kitchenDept.plannedHours),
       `CHF ${formatCurrency(kitchenDept.costs)}`, `CHF ${formatCurrency(kitchenDept.plannedCosts)}`,
       `${kitchenDept.costs - kitchenDept.plannedCosts >= 0 ? '+' : ''}${formatCurrency(kitchenDept.costs - kitchenDept.plannedCosts)}`,
       `CHF ${kitchenDept.avgHourlyRate.toFixed(2)}`],
      ['GESAMT', (serviceDept.employees + kitchenDept.employees).toString(), formatHours(totalActualHours), formatHours(totalPlannedHours),
       `CHF ${formatCurrency(totalActualCosts)}`, `CHF ${formatCurrency(totalPlannedCosts)}`,
       `${totalActualCosts - totalPlannedCosts >= 0 ? '+' : ''}${formatCurrency(totalActualCosts - totalPlannedCosts)}`,
       `CHF ${avgHourlyRate.toFixed(2)}`],
    ],
    theme: 'grid',
    headStyles: { fillColor: [51, 65, 85], fontSize: 7, cellPadding: 2 },
    styles: { fontSize: 7, cellPadding: 2 },
    columnStyles: { 0: { fontStyle: 'bold' } },
    didParseCell: (data) => {
      if (data.row.index === 2 && data.section === 'body') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [241, 245, 249];
      }
      if (data.column.index === 6 && data.section === 'body') {
        const text = data.cell.text[0] || '';
        if (text.startsWith('+')) {
          data.cell.styles.textColor = [239, 68, 68];
        } else if (text.startsWith('-')) {
          data.cell.styles.textColor = [34, 197, 94];
        }
      }
    },
  });
  
  // Weekly Trend Table
  if (trendData.length >= 2) {
    const tableY = (doc as any).lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Wochenperformance & Trend', 14, tableY);
    
    autoTable(doc, {
      startY: tableY + 5,
      head: [['Woche', 'Zeitraum', 'Tage', 'Stunden', 'Kosten', 'Ø/Tag', 'CHF/Std', 'Trend vs. Vorwoche']],
      body: trendData.map((w, i) => [
        `KW ${w.weekNum}`,
        `${format(w.startDate, 'd.M.', { locale: de })} - ${format(w.endDate, 'd.M.', { locale: de })}`,
        w.daysWithData.toString(),
        formatHours(w.hours),
        `CHF ${formatCurrency(w.costs)}`,
        `CHF ${formatCurrency(w.avgPerDay)}`,
        w.hours > 0 ? (w.costs / w.hours).toFixed(2) : '-',
        i === 0 ? '-' : `${w.changePercent >= 0 ? '+' : ''}${w.changePercent.toFixed(1)}%`
      ]),
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], fontSize: 7 },
      styles: { fontSize: 7 },
      didParseCell: (data) => {
        if (data.column.index === 7 && data.section === 'body' && data.row.index > 0) {
          const w = trendData[data.row.index];
          if (w.changePercent < -5) {
            data.cell.styles.textColor = [34, 197, 94];
            data.cell.styles.fontStyle = 'bold';
          } else if (w.changePercent > 5) {
            data.cell.styles.textColor = [239, 68, 68];
            data.cell.styles.fontStyle = 'bold';
          }
        }
      }
    });
  }
  
  // ==================== PAGE 3: Insights & Recommendations ====================
  doc.addPage();
  
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Erkenntnisse & Empfehlungen', 14, 20);
  
  // Summary insights box
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(187, 247, 208);
  doc.roundedRect(14, 28, 182, 50, 3, 3, 'FD');
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(22, 101, 52);
  doc.text('Zusammenfassung', 20, 40);
  
  const insights: string[] = [];
  
  // Trend insight
  if (trendData.length >= 2) {
    const firstWeekAvg = trendData[0].avgPerDay;
    const lastWeekAvg = trendData[trendData.length - 1].avgPerDay;
    const change = ((lastWeekAvg - firstWeekAvg) / firstWeekAvg) * 100;
    if (change < -5) {
      insights.push(`✓ Kostentrend positiv: Tageskosten um ${Math.abs(change).toFixed(0)}% gesunken`);
    } else if (change > 5) {
      insights.push(`⚠ Kostentrend negativ: Tageskosten um ${change.toFixed(0)}% gestiegen`);
    } else {
      insights.push(`→ Kosten stabil über den Monat (±${Math.abs(change).toFixed(0)}%)`);
    }
  }
  
  // Weekday insight
  if (weekdayStats.length > 0) {
    const maxDay = weekdayStats.reduce((a, b) => a.avgCosts > b.avgCosts ? a : b);
    const minDay = weekdayStats.reduce((a, b) => a.avgCosts < b.avgCosts ? a : b);
    insights.push(`📅 Teuerster Tag: ${maxDay.label} (CHF ${formatCurrency(maxDay.avgCosts)}/Tag)`);
    insights.push(`💰 Günstigster Tag: ${minDay.label} (CHF ${formatCurrency(minDay.avgCosts)}/Tag)`);
  }
  
  // Budget insight
  if (isOverBudget) {
    insights.push(`⚠ Budget überschritten um CHF ${formatCurrency(totalActualCosts - totalPlannedCosts)} (+${overBudgetPercent.toFixed(1)}%)`);
  } else {
    insights.push(`✓ Im Budget: CHF ${formatCurrency(totalPlannedCosts - totalActualCosts)} unter Plan`);
  }
  
  // Forecast insight
  if (forecast.costVariance > 0) {
    insights.push(`📈 Prognose: Monatsende ca. CHF ${formatCurrency(forecast.costVariance)} über Plan`);
  } else {
    insights.push(`📉 Prognose: Monatsende ca. CHF ${formatCurrency(Math.abs(forecast.costVariance))} unter Plan`);
  }
  
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(22, 101, 52);
  insights.forEach((insight, i) => {
    doc.text(insight, 20, 50 + i * 7);
  });
  
  // Recommendations
  const recommendations: { title: string; description: string; priority: 'high' | 'medium' | 'low' }[] = [];
  
  if (trendData.length >= 2) {
    const lastWeeks = trendData.slice(-2);
    if (lastWeeks.length === 2 && lastWeeks[1].changePercent > 5) {
      recommendations.push({
        title: 'Kostensteigerung stoppen',
        description: `Die letzte Woche zeigt +${lastWeeks[1].changePercent.toFixed(0)}% Kostensteigerung. Prüfen Sie die Personalplanung.`,
        priority: 'high'
      });
    }
  }
  
  if (weekdayStats.length > 0) {
    const avgCost = weekdayStats.reduce((s, w) => s + w.avgCosts, 0) / weekdayStats.length;
    const expensiveDays = weekdayStats.filter(w => w.avgCosts > avgCost * 1.15);
    if (expensiveDays.length > 0) {
      recommendations.push({
        title: 'Teure Wochentage optimieren',
        description: `${expensiveDays.map(d => d.label).join(', ')} liegen >15% über Durchschnitt. Besetzung prüfen.`,
        priority: 'medium'
      });
    }
  }
  
  if (serviceDept.avgHourlyRate > kitchenDept.avgHourlyRate * 1.2) {
    recommendations.push({
      title: 'Service-Kosten prüfen',
      description: `Ø ${serviceDept.avgHourlyRate.toFixed(2)} CHF/Std im Service vs. ${kitchenDept.avgHourlyRate.toFixed(2)} in Küche. Mix überprüfen.`,
      priority: 'low'
    });
  }
  
  if (forecast.costVariance > 500) {
    recommendations.push({
      title: 'Restmonat anpassen',
      description: `Prognose zeigt +CHF ${formatCurrency(forecast.costVariance)} Überschreitung. ${forecast.remainingDays} Tage optimal planen.`,
      priority: 'high'
    });
  }
  
  if (recommendations.length > 0) {
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Handlungsempfehlungen', 14, 95);
    
    recommendations.forEach((rec, i) => {
      const y = 105 + i * 20;
      const bgColor = rec.priority === 'high' ? [254, 242, 242] : rec.priority === 'medium' ? [254, 249, 231] : [240, 253, 244];
      const borderColor = rec.priority === 'high' ? [252, 165, 165] : rec.priority === 'medium' ? [253, 224, 71] : [187, 247, 208];
      const textColor = rec.priority === 'high' ? [153, 27, 27] : rec.priority === 'medium' ? [133, 77, 14] : [22, 101, 52];
      
      doc.setFillColor(bgColor[0], bgColor[1], bgColor[2]);
      doc.setDrawColor(borderColor[0], borderColor[1], borderColor[2]);
      doc.roundedRect(14, y, 182, 16, 2, 2, 'FD');
      
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(textColor[0], textColor[1], textColor[2]);
      doc.text(rec.title, 20, y + 7);
      
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(rec.description, 20, y + 13);
    });
  }
  
  // Footer
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  doc.text(`Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, 14, 280);
  doc.text('Umfassender Kosten-Report', 196, 280, { align: 'right' });
  
  // Save
  doc.save(`Kosten_Report_${format(selectedDate, 'yyyy-MM', { locale: de })}.pdf`);
};
