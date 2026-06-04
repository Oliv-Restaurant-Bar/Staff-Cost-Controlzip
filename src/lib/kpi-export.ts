import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getWeek, subMonths, subYears } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget, HourlyRevenue } from '@/types/personnel';
import { formatCurrency, formatHours } from './personnel-utils';
import { analyzeHourlyRevenue, HourlyRevenueParseResult } from './revenue-parser';

// ==================== oLÍV Brand Color Palette ====================
const OLIV_COLORS = {
  // Primary colors
  black: [0, 0, 0] as [number, number, number],
  sage: [127, 148, 131] as [number, number, number],        // Main brand green
  sageDark: [95, 115, 100] as [number, number, number],     // Darker sage for text
  sageLight: [180, 195, 183] as [number, number, number],   // Light sage for backgrounds
  sagePale: [235, 240, 236] as [number, number, number],    // Very light sage
  
  // Neutral tones
  charcoal: [30, 30, 30] as [number, number, number],       // Near black
  slate: [60, 60, 60] as [number, number, number],          // Dark gray
  gray: [100, 100, 100] as [number, number, number],        // Medium gray
  silver: [156, 163, 165] as [number, number, number],      // Light gray
  offWhite: [248, 249, 248] as [number, number, number],    // Background
  white: [255, 255, 255] as [number, number, number],
  
  // Status colors (adapted to brand)
  success: [76, 128, 90] as [number, number, number],       // Sage-tinted green
  successLight: [220, 235, 225] as [number, number, number],
  warning: [180, 150, 80] as [number, number, number],      // Muted gold
  warningLight: [250, 245, 220] as [number, number, number],
  danger: [180, 80, 80] as [number, number, number],        // Muted red
  dangerLight: [250, 230, 230] as [number, number, number],
  
  // Table headers
  tableHeader: [40, 45, 42] as [number, number, number],    // Dark with sage tint
};

interface KPIData {
  // Revenue
  plannedRevenue: number;
  actualRevenue: number;
  revenueVariance: number;
  revenueVariancePercent: number;
  
  // Labor Costs
  plannedLaborCost: number;
  actualLaborCost: number;
  laborCostVariance: number;
  laborCostVariancePercent: number;
  
  // Hours
  plannedHours: number;
  actualHours: number;
  hoursVariance: number;
  
  // Ratios
  laborCostQuotePlanned: number;
  laborCostQuoteActual: number;
  
  // Department specific
  serviceData: DepartmentKPI;
  kücheData: DepartmentKPI;
  
  // Daily breakdown
  dailyStats: DailyKPI[];
  
  // Employee performance
  employeeStats: EmployeeKPI[];
  
  // Weekly breakdown
  weeklyStats: WeeklyKPI[];
}

interface DepartmentKPI {
  plannedHours: number;
  actualHours: number;
  plannedCost: number;
  actualCost: number;
  employeeCount: number;
  avgHourlyRate: number;
}

interface DailyKPI {
  date: string;
  dayName: string;
  revenue: number;
  laborCost: number;
  laborQuote: number;
  employeeCount: number;
  hourlyRevenue?: HourlyRevenue[];
}

interface WeeklyKPI {
  week: string;
  weekNum: number;
  revenue: number;
  laborCost: number;
  laborQuote: number;
  hours: number;
  days: number;
}

interface EmployeeKPI {
  name: string;
  department: string;
  plannedHours: number;
  actualHours: number;
  hoursVariance: number;
  plannedCost: number;
  actualCost: number;
}

interface ActionItem {
  priority: 'high' | 'medium' | 'low';
  area: string;
  issue: string;
  recommendation: string;
  potentialSaving?: number;
  icon: string;
}

interface SituationSummary {
  status: 'excellent' | 'good' | 'warning' | 'critical';
  headline: string;
  summary: string;
  keyInsights: string[];
}

const calculateKPIData = (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  startDate: Date,
  endDate: Date
): KPIData => {
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  
  let plannedRevenue = 0;
  let actualRevenue = 0;
  let plannedLaborCost = 0;
  let actualLaborCost = 0;
  let plannedHours = 0;
  let actualHours = 0;
  
  const serviceData: DepartmentKPI = { plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0, employeeCount: 0, avgHourlyRate: 0 };
  const kücheData: DepartmentKPI = { plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0, employeeCount: 0, avgHourlyRate: 0 };
  
  const dailyStats: DailyKPI[] = [];
  const employeeMap = new Map<string, EmployeeKPI>();
  const weekMap = new Map<number, { revenue: number; laborCost: number; hours: number; days: number }>();
  
  const serviceEmployeeIds = new Set<string>();
  const kücheEmployeeIds = new Set<string>();
  
  days.forEach(day => {
    const dateString = format(day, 'yyyy-MM-dd');
    const budget = dailyBudgets[dateString];
    const dayEntries = timeEntries.filter(e => e.date === dateString);
    const weekNum = getWeek(day, { weekStartsOn: 1, locale: de });
    
    plannedRevenue += budget?.plannedRevenue || 0;
    actualRevenue += budget?.actualRevenue || 0;
    
    let dayLaborCost = 0;
    let dayHours = 0;
    let dayEmployeeCount = 0;
    
    dayEntries.forEach(entry => {
      const employee = employees.find(e => e.id === entry.employeeId);
      if (!employee) return;
      
      const pHours = entry.plannedHours || 0;
      const aHours = entry.actualHours || 0;
      const pCost = pHours * employee.hourlyWage;
      const aCost = aHours * employee.hourlyWage;
      
      plannedHours += pHours;
      actualHours += aHours;
      plannedLaborCost += pCost;
      actualLaborCost += aCost;
      dayLaborCost += aCost;
      dayHours += aHours;
      dayEmployeeCount++;
      
      // Department stats
      if (employee.department === 'service') {
        serviceData.plannedHours += pHours;
        serviceData.actualHours += aHours;
        serviceData.plannedCost += pCost;
        serviceData.actualCost += aCost;
        serviceEmployeeIds.add(employee.id);
      } else {
        kücheData.plannedHours += pHours;
        kücheData.actualHours += aHours;
        kücheData.plannedCost += pCost;
        kücheData.actualCost += aCost;
        kücheEmployeeIds.add(employee.id);
      }
      
      // Employee stats
      if (!employeeMap.has(employee.id)) {
        employeeMap.set(employee.id, {
          name: employee.name,
          department: employee.department,
          plannedHours: 0,
          actualHours: 0,
          hoursVariance: 0,
          plannedCost: 0,
          actualCost: 0,
        });
      }
      const empStats = employeeMap.get(employee.id)!;
      empStats.plannedHours += pHours;
      empStats.actualHours += aHours;
      empStats.hoursVariance = empStats.actualHours - empStats.plannedHours;
      empStats.plannedCost += pCost;
      empStats.actualCost += aCost;
    });
    
    const dayRevenue = budget?.actualRevenue || 0;
    dailyStats.push({
      date: format(day, 'dd.MM.', { locale: de }),
      dayName: format(day, 'EEE', { locale: de }),
      revenue: dayRevenue,
      laborCost: dayLaborCost,
      laborQuote: dayRevenue > 0 ? (dayLaborCost / dayRevenue) * 100 : 0,
      employeeCount: dayEmployeeCount,
      hourlyRevenue: budget?.hourlyRevenue,
    });
    
    // Weekly aggregation
    if (!weekMap.has(weekNum)) {
      weekMap.set(weekNum, { revenue: 0, laborCost: 0, hours: 0, days: 0 });
    }
    const weekData = weekMap.get(weekNum)!;
    weekData.revenue += dayRevenue;
    weekData.laborCost += dayLaborCost;
    weekData.hours += dayHours;
    weekData.days++;
  });
  
  serviceData.employeeCount = serviceEmployeeIds.size;
  kücheData.employeeCount = kücheEmployeeIds.size;
  serviceData.avgHourlyRate = serviceData.actualHours > 0 ? serviceData.actualCost / serviceData.actualHours : 0;
  kücheData.avgHourlyRate = kücheData.actualHours > 0 ? kücheData.actualCost / kücheData.actualHours : 0;
  
  // Build weekly stats
  const weeklyStats: WeeklyKPI[] = [];
  weekMap.forEach((data, weekNum) => {
    weeklyStats.push({
      week: `KW ${weekNum}`,
      weekNum,
      revenue: data.revenue,
      laborCost: data.laborCost,
      laborQuote: data.revenue > 0 ? (data.laborCost / data.revenue) * 100 : 0,
      hours: data.hours,
      days: data.days,
    });
  });
  weeklyStats.sort((a, b) => a.weekNum - b.weekNum);
  
  return {
    plannedRevenue,
    actualRevenue,
    revenueVariance: actualRevenue - plannedRevenue,
    revenueVariancePercent: plannedRevenue > 0 ? ((actualRevenue - plannedRevenue) / plannedRevenue) * 100 : 0,
    plannedLaborCost,
    actualLaborCost,
    laborCostVariance: plannedLaborCost - actualLaborCost,
    laborCostVariancePercent: plannedLaborCost > 0 ? ((plannedLaborCost - actualLaborCost) / plannedLaborCost) * 100 : 0,
    plannedHours,
    actualHours,
    hoursVariance: actualHours - plannedHours,
    laborCostQuotePlanned: plannedRevenue > 0 ? (plannedLaborCost / plannedRevenue) * 100 : 0,
    laborCostQuoteActual: actualRevenue > 0 ? (actualLaborCost / actualRevenue) * 100 : 0,
    serviceData,
    kücheData,
    dailyStats,
    weeklyStats,
    employeeStats: Array.from(employeeMap.values()),
  };
};

const analyzeSituation = (kpi: KPIData): SituationSummary => {
  const quote = kpi.laborCostQuoteActual;
  const revenueVar = kpi.revenueVariancePercent;
  const costVar = kpi.laborCostVariancePercent;
  
  let status: SituationSummary['status'];
  let headline: string;
  let summary: string;
  const keyInsights: string[] = [];
  
  // Determine overall status
  if (quote <= 28 && revenueVar >= 0) {
    status = 'excellent';
    headline = 'Ausgezeichnete Performance';
    summary = 'Die Personalkosten sind optimal im Griff und der Umsatz entwickelt sich positiv.';
  } else if (quote <= 32 && revenueVar >= -5) {
    status = 'good';
    headline = 'Gute Entwicklung';
    summary = 'Die Kennzahlen liegen im grünen Bereich, kleinere Optimierungen sind möglich.';
  } else if (quote <= 38 || revenueVar >= -10) {
    status = 'warning';
    headline = 'Handlungsbedarf erkannt';
    summary = 'Einige Kennzahlen erfordern Aufmerksamkeit. Gezielte Massnahmen empfohlen.';
  } else {
    status = 'critical';
    headline = 'Sofortiges Handeln erforderlich';
    summary = 'Kritische Abweichungen festgestellt. Dringende Massnahmen notwendig.';
  }
  
  // Generate key insights
  if (quote > 35) {
    keyInsights.push(`Personalkostenquote bei ${quote.toFixed(1)}% - über dem Zielwert von 35%`);
  } else if (quote <= 28) {
    keyInsights.push(`Personalkostenquote bei nur ${quote.toFixed(1)}% - sehr effizient`);
  }
  
  if (revenueVar < -5) {
    keyInsights.push(`Umsatz ${Math.abs(revenueVar).toFixed(1)}% unter Plan`);
  } else if (revenueVar > 5) {
    keyInsights.push(`Umsatz ${revenueVar.toFixed(1)}% über Plan - gute Nachfrage`);
  }
  
  if (kpi.hoursVariance > 20) {
    keyInsights.push(`${kpi.hoursVariance.toFixed(0)} Überstunden angefallen`);
  }
  
  const highOvertimeCount = kpi.employeeStats.filter(e => e.hoursVariance > 8).length;
  if (highOvertimeCount > 0) {
    keyInsights.push(`${highOvertimeCount} Mitarbeiter mit >8 Std. Mehrarbeit`);
  }
  
  const criticalDays = kpi.dailyStats.filter(d => d.laborQuote > 40 && d.revenue > 0).length;
  if (criticalDays > 3) {
    keyInsights.push(`${criticalDays} Tage mit Quote über 40%`);
  }
  
  return { status, headline, summary, keyInsights };
};

const generateActionItems = (kpi: KPIData): ActionItem[] => {
  const actions: ActionItem[] = [];
  
  // Labor cost quote analysis
  if (kpi.laborCostQuoteActual > 38) {
    actions.push({
      priority: 'high',
      area: 'Personalkostenquote',
      issue: `Quote bei ${kpi.laborCostQuoteActual.toFixed(1)}% - deutlich über Zielwert`,
      recommendation: 'Personalbesetzung an umsatzschwachen Tagen reduzieren. Schichtlängen überprüfen.',
      potentialSaving: kpi.actualRevenue * ((kpi.laborCostQuoteActual - 32) / 100),
      icon: '⚠️',
    });
  } else if (kpi.laborCostQuoteActual > 35) {
    actions.push({
      priority: 'medium',
      area: 'Personalkostenquote',
      issue: `Quote bei ${kpi.laborCostQuoteActual.toFixed(1)}% - leicht erhöht`,
      recommendation: 'Schichtplanung an Tagesgeschäft anpassen. Pausenzeiten optimieren.',
      icon: '📊',
    });
  }
  
  // Revenue variance
  if (kpi.revenueVariancePercent < -10) {
    actions.push({
      priority: 'high',
      area: 'Umsatzentwicklung',
      issue: `Umsatz ${Math.abs(kpi.revenueVariancePercent).toFixed(1)}% unter Plan`,
      recommendation: 'Marketingaktionen starten. Personalplanung sofort anpassen.',
      icon: '📉',
    });
  } else if (kpi.revenueVariancePercent < -5) {
    actions.push({
      priority: 'medium',
      area: 'Umsatzentwicklung',
      issue: `Umsatz ${Math.abs(kpi.revenueVariancePercent).toFixed(1)}% unter Plan`,
      recommendation: 'Ursachen analysieren. Mittagsangebote oder Events prüfen.',
      icon: '📈',
    });
  }
  
  // Labor cost overrun
  if (kpi.laborCostVariance < -500) {
    const overrun = Math.abs(kpi.laborCostVariance);
    actions.push({
      priority: overrun > 1500 ? 'high' : 'medium',
      area: 'Kostenüberschreitung',
      issue: `${formatCurrency(overrun)} CHF über Budget`,
      recommendation: 'Überstunden abbauen. Aushilfen flexibler einsetzen.',
      potentialSaving: overrun,
      icon: '💰',
    });
  }
  
  // Department imbalance
  const totalCost = kpi.serviceData.actualCost + kpi.kücheData.actualCost;
  if (totalCost > 0) {
    const küchePct = (kpi.kücheData.actualCost / totalCost) * 100;
    if (küchePct > 55) {
      actions.push({
        priority: 'medium',
        area: 'Abteilung Küche',
        issue: `Küche: ${küchePct.toFixed(0)}% der Personalkosten`,
        recommendation: 'Mise en place optimieren. Rezepturen vereinfachen.',
        icon: '👨‍🍳',
      });
    }
  }
  
  // High overtime employees
  const overtimeEmployees = kpi.employeeStats.filter(e => e.hoursVariance > 8);
  if (overtimeEmployees.length > 0) {
    actions.push({
      priority: 'medium',
      area: 'Überstunden',
      issue: `${overtimeEmployees.length} Mitarbeiter mit Überstunden`,
      recommendation: `Zeitkonto prüfen: ${overtimeEmployees.slice(0, 2).map(e => e.name).join(', ')}`,
      icon: '⏰',
    });
  }
  
  // Critical days
  const criticalDays = kpi.dailyStats.filter(d => d.laborQuote > 45 && d.revenue > 0);
  if (criticalDays.length >= 2) {
    actions.push({
      priority: 'high',
      area: 'Tagesbesetzung',
      issue: `${criticalDays.length} Tage mit Quote >45%`,
      recommendation: `Besetzung reduzieren: ${criticalDays.slice(0, 2).map(d => d.dayName).join(', ')}`,
      icon: '📅',
    });
  }
  
  // Analyze hourly revenue data for shift optimization
  const daysWithHourlyData = kpi.dailyStats.filter(d => d.hourlyRevenue && d.hourlyRevenue.length > 0);
  if (daysWithHourlyData.length > 0) {
    // Aggregate hourly patterns
    const hourlyTotals: Record<number, { revenue: number; count: number }> = {};
    
    daysWithHourlyData.forEach(day => {
      day.hourlyRevenue?.forEach(h => {
        if (!hourlyTotals[h.hour]) {
          hourlyTotals[h.hour] = { revenue: 0, count: 0 };
        }
        hourlyTotals[h.hour].revenue += h.revenue;
        hourlyTotals[h.hour].count++;
      });
    });
    
    // Find average peak hour and last significant hour
    const hourlyAvg = Object.entries(hourlyTotals).map(([hour, data]) => ({
      hour: parseInt(hour),
      avgRevenue: data.revenue / data.count,
    })).sort((a, b) => b.avgRevenue - a.avgRevenue);
    
    if (hourlyAvg.length > 0) {
      const peakHour = hourlyAvg[0].hour;
      const totalAvgRevenue = hourlyAvg.reduce((sum, h) => sum + h.avgRevenue, 0);
      const significantThreshold = totalAvgRevenue * 0.03;
      
      // Find last significant hour
      const lastSignificantHour = hourlyAvg
        .filter(h => h.avgRevenue >= significantThreshold)
        .reduce((max, h) => Math.max(max, h.hour), 0);
      
      // Check for late hours with minimal revenue
      const lateHours = hourlyAvg.filter(h => h.hour >= 21 && h.avgRevenue < significantThreshold);
      if (lateHours.length >= 2) {
        const potentialSaving = lateHours.reduce((sum, h) => sum + h.avgRevenue, 0) * daysWithHourlyData.length * 0.3; // Assume 30% labor cost
        actions.push({
          priority: 'medium',
          area: 'Schichtende',
          issue: `Umsatz ab ${lastSignificantHour + 1}:00 Uhr minimal`,
          recommendation: `Aushilfen früher entlassen. Letzte relevante Stunde: ${lastSignificantHour}:00`,
          potentialSaving,
          icon: '🌙',
        });
      }
      
      // Check for slow afternoon periods
      const afternoonHours = hourlyAvg.filter(h => h.hour >= 14 && h.hour <= 17 && h.avgRevenue < significantThreshold);
      if (afternoonHours.length >= 2) {
        actions.push({
          priority: 'low',
          area: 'Nachmittag',
          issue: `Schwaches Geschäft 14:00-17:00`,
          recommendation: 'Kernbesetzung zwischen Mittag und Abend. Pause für Aushilfen einplanen.',
          icon: '☀️',
        });
      }
    }
  }
  
  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  
  return actions.slice(0, 6);
};

// Helper to draw a simple bar chart
const drawBarChart = (
  doc: jsPDF,
  x: number,
  y: number,
  width: number,
  height: number,
  data: { label: string; value: number; color: [number, number, number] }[],
  title: string
) => {
  const maxValue = Math.max(...data.map(d => d.value), 1);
  const barWidth = (width - 20) / data.length - 4;
  const chartBottom = y + height - 15;
  const chartHeight = height - 35;
  
  // Title
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text(title, x + width / 2, y + 10, { align: 'center' });
  
  // Draw bars
  data.forEach((item, index) => {
    const barHeight = (item.value / maxValue) * chartHeight;
    const barX = x + 10 + index * (barWidth + 4);
    const barY = chartBottom - barHeight;
    
    // Bar
    doc.setFillColor(item.color[0], item.color[1], item.color[2]);
    doc.roundedRect(barX, barY, barWidth, barHeight, 2, 2, 'F');
    
    // Value on top
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(item.color[0], item.color[1], item.color[2]);
    doc.text(item.value > 1000 ? `${(item.value / 1000).toFixed(1)}k` : item.value.toFixed(0), barX + barWidth / 2, barY - 3, { align: 'center' });
    
    // Label
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(item.label, barX + barWidth / 2, chartBottom + 8, { align: 'center' });
  });
};

// Helper to draw a gauge chart with oLÍV colors
const drawGaugeChart = (
  doc: jsPDF,
  centerX: number,
  centerY: number,
  radius: number,
  value: number,
  maxValue: number,
  label: string,
  thresholds: { good: number; warning: number }
) => {
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const valueAngle = startAngle + (value / maxValue) * (endAngle - startAngle);
  
  // Background arc
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(6);
  
  // Draw arc segments with oLÍV themed colors
  const segments = 20;
  for (let i = 0; i < segments; i++) {
    const segStart = startAngle + (i / segments) * Math.PI;
    const segEnd = startAngle + ((i + 1) / segments) * Math.PI;
    const segValue = (i / segments) * maxValue;
    
    if (segValue < thresholds.good) {
      doc.setDrawColor(...OLIV_COLORS.success);
    } else if (segValue < thresholds.warning) {
      doc.setDrawColor(...OLIV_COLORS.warning);
    } else {
      doc.setDrawColor(...OLIV_COLORS.danger);
    }
    
    const x1 = centerX + Math.cos(segStart) * radius;
    const y1 = centerY + Math.sin(segStart) * radius;
    const x2 = centerX + Math.cos(segEnd) * radius;
    const y2 = centerY + Math.sin(segEnd) * radius;
    
    doc.line(x1, y1, x2, y2);
  }
  
  // Needle
  doc.setDrawColor(...OLIV_COLORS.charcoal);
  doc.setLineWidth(2);
  const needleX = centerX + Math.cos(valueAngle) * (radius - 8);
  const needleY = centerY + Math.sin(valueAngle) * (radius - 8);
  doc.line(centerX, centerY, needleX, needleY);
  
  // Center dot
  doc.setFillColor(...OLIV_COLORS.charcoal);
  doc.circle(centerX, centerY, 3, 'F');
  
  // Value text
  const color = value < thresholds.good ? OLIV_COLORS.success : value < thresholds.warning ? OLIV_COLORS.warning : OLIV_COLORS.danger;
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(color[0], color[1], color[2]);
  doc.text(`${value.toFixed(1)}%`, centerX, centerY + 12, { align: 'center' });
  
  // Label
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text(label, centerX, centerY + 20, { align: 'center' });
};

// Helper to draw a mini trend arrow with oLÍV colors
const drawTrendArrow = (doc: jsPDF, x: number, y: number, trend: 'up' | 'down' | 'neutral', size: number = 4) => {
  if (trend === 'up') {
    doc.setFillColor(...OLIV_COLORS.success);
    doc.triangle(x, y + size, x + size, y + size, x + size / 2, y, 'F');
  } else if (trend === 'down') {
    doc.setFillColor(...OLIV_COLORS.danger);
    doc.triangle(x, y, x + size, y, x + size / 2, y + size, 'F');
  } else {
    doc.setFillColor(...OLIV_COLORS.silver);
    doc.rect(x, y + size / 3, size, size / 3, 'F');
  }
};

// Helper function to load image as base64
const loadImageAsBase64 = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

// Helper to add page footer with watermark logo
const addPageFooter = (
  doc: jsPDF,
  pageNumber: number,
  totalPages: number,
  logoBase64: string | null,
  periodLabel: string
) => {
  const pageWidth = 210;
  const pageHeight = 297;
  
  // Footer background line
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.5);
  doc.line(15, pageHeight - 18, pageWidth - 15, pageHeight - 18);
  
  // Watermark logo on the left
  if (logoBase64) {
    try {
      // Small logo watermark (reduced opacity simulated by lighter rendering)
      doc.addImage(logoBase64, 'PNG', 15, pageHeight - 16, 25, 12);
    } catch (e) {
      // Fallback text
      doc.setFontSize(7);
      doc.setTextColor(...OLIV_COLORS.silver);
      doc.text('oLÍV', 15, pageHeight - 10);
    }
  } else {
    doc.setFontSize(7);
    doc.setTextColor(...OLIV_COLORS.silver);
    doc.text('oLÍV Restaurant & Bar', 15, pageHeight - 10);
  }
  
  // Center: Period and timestamp
  doc.setFontSize(7);
  doc.setTextColor(...OLIV_COLORS.silver);
  doc.text(`${periodLabel} | Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
  
  // Right: Page number
  doc.setFontSize(8);
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text(`Seite ${pageNumber} von ${totalPages}`, pageWidth - 15, pageHeight - 10, { align: 'right' });
};

// Helper to add page header with small logo
const addPageHeader = (
  doc: jsPDF,
  title: string,
  logoBase64: string | null
) => {
  // Small header logo on the right
  if (logoBase64) {
    try {
      doc.addImage(logoBase64, 'PNG', 175, 8, 20, 9);
    } catch (e) {
      // Fallback - no logo
    }
  }
  
  // Header accent line
  doc.setFillColor(...OLIV_COLORS.sage);
  doc.rect(0, 0, 210, 3, 'F');
  
  // Title
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text(title, 14, 18);
};

export const exportKPIReportPDF = async (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  selectedDate: Date,
  customEndDate?: Date,
  periodLabel?: string,
  companyName?: string,
  logoUrl?: string,
  showNetRevenue: boolean = false
) => {
  // A4 optimized document with print-friendly margins
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });
  
  // Print-optimized margins (15mm on all sides for binding)
  const margin = {
    left: 15,
    right: 15,
    top: 15,
    bottom: 20,
  };
  const contentWidth = 210 - margin.left - margin.right; // 180mm
  
  // Use custom date range if provided, otherwise default to month
  const startDate = customEndDate ? selectedDate : startOfMonth(selectedDate);
  const endDate = customEndDate || endOfMonth(selectedDate);
  
  // Generate period label if not provided
  const revenueMode = showNetRevenue ? 'Netto' : 'Brutto';
  const displayPeriod = periodLabel || format(selectedDate, 'MMMM yyyy', { locale: de });
  const displayPeriodWithMode = `${displayPeriod} (${revenueMode})`;

  const kpi = calculateKPIData(employees, timeEntries, dailyBudgets, startDate, endDate);
  const actions = generateActionItems(kpi);
  const situation = analyzeSituation(kpi);
  
  // Calculate year-over-year comparison data
  const prevYearStart = subYears(startDate, 1);
  const prevYearEnd = subYears(endDate, 1);
  const prevYearKpi = calculateKPIData(employees, timeEntries, dailyBudgets, prevYearStart, prevYearEnd);
  
  const yoyComparison = {
    revenueChange: prevYearKpi.actualRevenue > 0 
      ? ((kpi.actualRevenue - prevYearKpi.actualRevenue) / prevYearKpi.actualRevenue) * 100 
      : 0,
    laborCostChange: prevYearKpi.actualLaborCost > 0 
      ? ((kpi.actualLaborCost - prevYearKpi.actualLaborCost) / prevYearKpi.actualLaborCost) * 100 
      : 0,
    quoteDiff: kpi.laborCostQuoteActual - prevYearKpi.laborCostQuoteActual,
    hoursChange: prevYearKpi.actualHours > 0 
      ? ((kpi.actualHours - prevYearKpi.actualHours) / prevYearKpi.actualHours) * 100 
      : 0,
    prevYear: {
      revenue: prevYearKpi.actualRevenue,
      laborCost: prevYearKpi.actualLaborCost,
      quote: prevYearKpi.laborCostQuoteActual,
      hours: prevYearKpi.actualHours,
    },
  };
  
  // Load company logo if URL provided, otherwise use default
  const defaultLogoUrl = '/images/company-logo.png';
  const logoBase64 = await loadImageAsBase64(logoUrl || defaultLogoUrl);
  
  // Calculate total pages (approximate)
  const hasHourlyData = kpi.dailyStats.some(d => d.hourlyRevenue && d.hourlyRevenue.length > 0);
  const totalPages = hasHourlyData ? 6 : 5; // Add 1 for YoY page
  
  // ==================== COVER PAGE (Page 1) ====================
  
  // Clean, minimal header with sage accent line at top
  doc.setFillColor(...OLIV_COLORS.sage);
  doc.rect(0, 0, 210, 4, 'F');
  
  // Small logo area on the left (dezent)
  if (logoBase64) {
    try {
      doc.addImage(logoBase64, 'PNG', margin.left, 12, 40, 20);
    } catch (e) {
      // Fallback to text if image fails
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...OLIV_COLORS.charcoal);
      doc.text('oLÍV', margin.left, 24);
    }
  } else {
    // Fallback text logo
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text('oLÍV', margin.left, 24);
  }
  
  // Report title - larger and prominent
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Controlling Report', margin.left, 55);
  
  doc.setFontSize(14);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.sage);
  doc.text('Personal-Kostenanalyse', margin.left, 66);
  
  // Subtle line separator
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.5);
  doc.line(margin.left, 75, margin.left + contentWidth, 75);
  
  // Period badge with revenue mode indicator - more subtle
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.roundedRect(margin.left, 82, contentWidth, 18, 3, 3, 'F');
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text(`Zeitraum: ${displayPeriodWithMode}`, 105, 94, { align: 'center' });
  
  // Executive Summary Section
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Executive Summary', margin.left, 115);
  
  // Status indicator with oLÍV themed colors
  const statusColors = {
    excellent: OLIV_COLORS.success,
    good: OLIV_COLORS.sage,
    warning: OLIV_COLORS.warning,
    critical: OLIV_COLORS.danger,
  };
  const statusColor = statusColors[situation.status];
  const statusText = { excellent: 'EXZELLENT', good: 'GUT', warning: 'ACHTUNG', critical: 'KRITISCH' };
  
  doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.roundedRect(155, 107, 40, 12, 3, 3, 'F');
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  doc.text(statusText[situation.status], 175, 115, { align: 'center' });
  
  // Main summary box
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.5);
  doc.roundedRect(margin.left, 122, contentWidth, 42, 3, 3, 'FD');
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.text(situation.headline, margin.left + 6, 134);
  
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.slate);
  const summaryLines = doc.splitTextToSize(situation.summary, contentWidth - 12);
  doc.text(summaryLines, margin.left + 6, 144);
  
  // Key insights
  if (situation.keyInsights.length > 0) {
    doc.setFontSize(8);
    doc.setTextColor(...OLIV_COLORS.gray);
    situation.keyInsights.slice(0, 2).forEach((insight, i) => {
      doc.text(`• ${insight}`, margin.left + 6, 154 + i * 6);
    });
  }
  
  // Key KPIs on cover page - larger cards for print
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Wichtigste Kennzahlen', margin.left, 178);
  
  const coverKPIs = [
    { label: 'Umsatz', value: formatCurrency(kpi.actualRevenue), trend: kpi.revenueVariancePercent, unit: '%' },
    { label: 'Personalkosten', value: formatCurrency(kpi.actualLaborCost), trend: -kpi.laborCostVariancePercent, unit: '%' },
    { label: 'PK-Quote', value: `${kpi.laborCostQuoteActual.toFixed(1)}%`, trend: 32 - kpi.laborCostQuoteActual, unit: ' PP' },
    { label: 'Arbeitsstunden', value: formatHours(kpi.actualHours), trend: kpi.hoursVariance, unit: ' Std' },
  ];
  
  const kpiCardWidth = (contentWidth - 15) / 4;
  coverKPIs.forEach((metric, i) => {
    const x = margin.left + i * (kpiCardWidth + 5);
    doc.setFillColor(...OLIV_COLORS.white);
    doc.setDrawColor(...OLIV_COLORS.sageLight);
    doc.roundedRect(x, 184, kpiCardWidth, 36, 3, 3, 'FD');
    
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(metric.label, x + 4, 194);
    
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(metric.value, x + 4, 205);
    
    const trendColor = metric.trend >= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(trendColor[0], trendColor[1], trendColor[2]);
    doc.text(`${metric.trend >= 0 ? '+' : ''}${metric.trend.toFixed(1)}${metric.unit}`, x + 4, 215);
  });
  
  // Top action items on cover
  if (actions.length > 0) {
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text('Prioritäre Massnahmen', margin.left, 232);
    
    actions.slice(0, 3).forEach((action, i) => {
      const y = 242 + i * 10;
      const priorityColor = action.priority === 'high' ? OLIV_COLORS.danger : OLIV_COLORS.warning;
      
      doc.setFillColor(priorityColor[0], priorityColor[1], priorityColor[2]);
      doc.circle(margin.left + 3, y - 2, 2, 'F');
      
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...OLIV_COLORS.charcoal);
      doc.text(action.area, margin.left + 8, y);
      
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...OLIV_COLORS.slate);
      doc.text(action.issue.substring(0, 55), margin.left + 48, y);
    });
  }
  
  // Cover page footer with watermark
  addPageFooter(doc, 1, totalPages, logoBase64, displayPeriod);
  
  // ==================== PAGE 2: Executive Overview ====================
  doc.addPage();
  
  // Add header with small logo
  addPageHeader(doc, 'Detailanalyse', logoBase64);
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text(`Zeitraum: ${displayPeriod}`, margin.left, 26);
  
  // Status badge (top right, under header)
  doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.roundedRect(160, 12, 35, 10, 3, 3, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  doc.text(statusText[situation.status], 177.5, 19, { align: 'center' });
  
  // Situation Summary Box
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.5);
  doc.roundedRect(margin.left, 34, contentWidth, 38, 3, 3, 'FD');
  
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.text(situation.headline, margin.left + 6, 46);
  
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.slate);
  doc.text(situation.summary, margin.left + 6, 55);
  
  // Key insights as bullet points
  if (situation.keyInsights.length > 0) {
    doc.setFontSize(8);
    doc.setTextColor(...OLIV_COLORS.gray);
    situation.keyInsights.slice(0, 2).forEach((insight, i) => {
      doc.text(`• ${insight}`, margin.left + 6, 63 + i * 5);
    });
  }
  
  // ==================== Key Metrics with Visual Charts ====================
  
  // Gauge chart for labor cost quote
  drawGaugeChart(doc, 55, 98, 25, kpi.laborCostQuoteActual, 50, 'Personalkostenquote', { good: 30, warning: 35 });
  
  // Revenue & Cost comparison bars with oLÍV colors
  drawBarChart(doc, 100, 75, 95, 50, [
    { label: 'Umsatz', value: kpi.actualRevenue, color: OLIV_COLORS.sage },
    { label: 'Plan', value: kpi.plannedRevenue, color: OLIV_COLORS.silver },
    { label: 'PK Ist', value: kpi.actualLaborCost, color: kpi.actualLaborCost > kpi.plannedLaborCost ? OLIV_COLORS.danger : OLIV_COLORS.success },
    { label: 'PK Plan', value: kpi.plannedLaborCost, color: OLIV_COLORS.silver },
  ], 'Umsatz vs. Personalkosten (CHF)');
  
  // Key metrics cards - optimized for print
  const metricsY = 132;
  const metricWidth = (contentWidth - 12) / 4;
  const metrics = [
    { label: 'Umsatz', value: formatCurrency(kpi.actualRevenue), trend: kpi.revenueVariancePercent >= 0 ? 'up' : 'down', trendValue: `${kpi.revenueVariancePercent >= 0 ? '+' : ''}${kpi.revenueVariancePercent.toFixed(1)}%` },
    { label: 'Personalkosten', value: formatCurrency(kpi.actualLaborCost), trend: kpi.laborCostVariance >= 0 ? 'up' : 'down', trendValue: `${kpi.laborCostVariance >= 0 ? '' : '+'}${formatCurrency(Math.abs(kpi.laborCostVariance))}` },
    { label: 'Arbeitsstunden', value: formatHours(kpi.actualHours), trend: kpi.hoursVariance <= 0 ? 'up' : 'down', trendValue: `${kpi.hoursVariance >= 0 ? '+' : ''}${formatHours(kpi.hoursVariance)}` },
    { label: 'PK-Quote', value: `${kpi.laborCostQuoteActual.toFixed(1)}%`, trend: kpi.laborCostQuoteActual <= 32 ? 'up' : 'down', trendValue: `Ziel: 32%` },
  ];
  
  metrics.forEach((metric, i) => {
    const x = margin.left + i * (metricWidth + 4);
    doc.setFillColor(...OLIV_COLORS.white);
    doc.setDrawColor(...OLIV_COLORS.sageLight);
    doc.roundedRect(x, metricsY, metricWidth, 30, 2, 2, 'FD');
    
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(metric.label, x + 4, metricsY + 9);
    
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(metric.value, x + 4, metricsY + 19);
    
    drawTrendArrow(doc, x + metricWidth - 12, metricsY + 6, metric.trend as 'up' | 'down' | 'neutral', 5);
    
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(metric.trendValue, x + 4, metricsY + 26);
  });
  
  // Average Hourly Cost Analysis Box
  const avgHourly = kpi.actualHours > 0 ? kpi.actualLaborCost / kpi.actualHours : 0;
  const serviceAvg = kpi.serviceData.avgHourlyRate;
  const kücheAvg = kpi.kücheData.avgHourlyRate;
  const costPerDay = kpi.dailyStats.length > 0 ? kpi.actualLaborCost / kpi.dailyStats.length : 0;
  
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.roundedRect(margin.left, 168, contentWidth, 18, 2, 2, 'FD');
  
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Stundenkosten-Analyse:', margin.left + 4, 177);
  
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Ø Gesamt: CHF ${avgHourly.toFixed(2)}/Std`, 62, 177);
  doc.setTextColor(...OLIV_COLORS.sage);
  doc.text(`Service: CHF ${serviceAvg.toFixed(2)}`, 105, 177);
  doc.setTextColor(...OLIV_COLORS.sageDark);
  doc.text(`Küche: CHF ${kücheAvg.toFixed(2)}`, 140, 177);
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text(`Ø/Tag: ${formatCurrency(costPerDay)}`, 210 - margin.right - 5, 177, { align: 'right' });
  
  // ==================== Action Items Section ====================
  
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Massnahmen', margin.left, 195);
  
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text('Priorisierte Handlungsempfehlungen basierend auf Ihrer Datenanalyse', margin.left, 202);
  
  if (actions.length === 0) {
    doc.setFillColor(...OLIV_COLORS.successLight);
    doc.roundedRect(margin.left, 207, contentWidth, 20, 3, 3, 'F');
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.success);
    doc.text('✓ Keine dringenden Massnahmen erforderlich', margin.left + 6, 219);
  } else {
    actions.slice(0, 4).forEach((action, i) => {
      const actionY = 207 + i * 16;
      const bgColor = action.priority === 'high' ? OLIV_COLORS.dangerLight : OLIV_COLORS.warningLight;
      const borderColor = action.priority === 'high' ? OLIV_COLORS.danger : OLIV_COLORS.warning;
      
      doc.setFillColor(bgColor[0], bgColor[1], bgColor[2]);
      doc.setDrawColor(borderColor[0], borderColor[1], borderColor[2]);
      doc.roundedRect(margin.left, actionY, contentWidth, 14, 2, 2, 'FD');
      
      // Icon & Priority
      doc.setFontSize(10);
      doc.text(action.icon, margin.left + 4, actionY + 9);
      
      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      const priorityTextColor = action.priority === 'high' ? OLIV_COLORS.danger : OLIV_COLORS.warning;
      doc.setTextColor(priorityTextColor[0], priorityTextColor[1], priorityTextColor[2]);
      doc.text(action.priority === 'high' ? 'HOCH' : 'MITTEL', margin.left + 14, actionY + 5);
      
      // Issue
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...OLIV_COLORS.charcoal);
      doc.text(action.issue.substring(0, 50), margin.left + 34, actionY + 5);
      
      // Recommendation
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...OLIV_COLORS.slate);
      doc.text(action.recommendation.substring(0, 60), margin.left + 34, actionY + 11);
      
      // Potential saving
      if (action.potentialSaving) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(...OLIV_COLORS.success);
        doc.text(`${formatCurrency(action.potentialSaving)}`, margin.left + contentWidth - 25, actionY + 8);
      }
    });
  }
  
  // Page 2 footer with watermark
  addPageFooter(doc, 2, totalPages, logoBase64, displayPeriod);
  
  // ==================== PAGE 3: Cost & Department Analysis ====================
  doc.addPage();
  
  // Page header with logo
  addPageHeader(doc, 'Kostenanalyse & Abteilungen', logoBase64);
  
  // Detailed Cost Breakdown Box with oLÍV styling
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.5);
  doc.roundedRect(margin.left, 28, contentWidth, 50, 3, 3, 'FD');
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.sageDark);
  doc.text('Detaillierte Kostenübersicht', margin.left + 6, 38);
  
  // Cost metrics in grid - adjusted for print margins
  const costMetrics = [
    { label: 'Gesamtkosten', value: formatCurrency(kpi.actualLaborCost), x: margin.left + 6 },
    { label: 'Plan-Kosten', value: formatCurrency(kpi.plannedLaborCost), x: margin.left + 52 },
    { label: 'Differenz', value: `${kpi.laborCostVariance >= 0 ? '-' : '+'}${formatCurrency(Math.abs(kpi.laborCostVariance))}`, x: margin.left + 98 },
    { label: 'Ø pro Stunde', value: `CHF ${avgHourly.toFixed(2)}`, x: margin.left + 144 },
  ];
  
  doc.setFontSize(8);
  costMetrics.forEach(metric => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(metric.label, metric.x, 46);
    
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.setFontSize(10);
    doc.text(metric.value, metric.x, 54);
    doc.setFontSize(8);
  });
  
  // Second row - per day/employee
  const daysWithData = kpi.dailyStats.filter(d => d.revenue > 0).length;
  const uniqueEmployees = kpi.employeeStats.length;
  const avgPerEmployee = uniqueEmployees > 0 ? kpi.actualLaborCost / uniqueEmployees : 0;
  const avgHoursPerEmployee = uniqueEmployees > 0 ? kpi.actualHours / uniqueEmployees : 0;
  
  const secondRowMetrics = [
    { label: 'Ø pro Tag', value: `${formatCurrency(costPerDay)}`, x: margin.left + 6 },
    { label: 'Ø pro MA', value: `${formatCurrency(avgPerEmployee)}`, x: margin.left + 52 },
    { label: 'Ø Std/MA', value: `${formatHours(avgHoursPerEmployee)} Std`, x: margin.left + 98 },
    { label: 'Arbeitstage', value: `${daysWithData}`, x: margin.left + 144 },
  ];
  
  secondRowMetrics.forEach(metric => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(metric.label, metric.x, 64);
    
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.setFontSize(9);
    doc.text(metric.value, metric.x, 72);
    doc.setFontSize(8);
  });
  
  // Department Comparison
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Abteilungsvergleich', margin.left, 90);
  
  // Department pie chart visual with oLÍV colors
  const totalCost = kpi.serviceData.actualCost + kpi.kücheData.actualCost;
  const servicePct = totalCost > 0 ? (kpi.serviceData.actualCost / totalCost) * 100 : 50;
  
  // Simple visual bar for department split using brand colors
  doc.setFillColor(...OLIV_COLORS.sage);
  doc.roundedRect(margin.left, 96, contentWidth * (servicePct / 100), 8, 0, 0, 'F');
  doc.setFillColor(...OLIV_COLORS.charcoal);
  doc.roundedRect(margin.left + contentWidth * (servicePct / 100), 96, contentWidth * ((100 - servicePct) / 100), 8, 0, 0, 'F');
  
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  if (servicePct > 15) doc.text(`Service ${servicePct.toFixed(0)}%`, margin.left + 6, 102);
  if ((100 - servicePct) > 15) doc.text(`Küche ${(100 - servicePct).toFixed(0)}%`, margin.left + contentWidth - 30, 102);

  // Enhanced department table with more metrics
  autoTable(doc, {
    startY: 110,
    margin: { left: margin.left, right: margin.right },
    head: [['Abteilung', 'MA', 'Std Plan', 'Std Ist', 'Diff', 'Kosten Plan', 'Kosten Ist', 'Diff CHF', '∅ CHF/Std']],
    body: [
      [
        'Service',
        kpi.serviceData.employeeCount.toString(),
        formatHours(kpi.serviceData.plannedHours),
        formatHours(kpi.serviceData.actualHours),
        `${kpi.serviceData.actualHours - kpi.serviceData.plannedHours >= 0 ? '+' : ''}${formatHours(kpi.serviceData.actualHours - kpi.serviceData.plannedHours)}`,
        formatCurrency(kpi.serviceData.plannedCost),
        formatCurrency(kpi.serviceData.actualCost),
        `${kpi.serviceData.actualCost - kpi.serviceData.plannedCost >= 0 ? '+' : ''}${formatCurrency(kpi.serviceData.actualCost - kpi.serviceData.plannedCost)}`,
        formatCurrency(kpi.serviceData.avgHourlyRate),
      ],
      [
        'Küche',
        kpi.kücheData.employeeCount.toString(),
        formatHours(kpi.kücheData.plannedHours),
        formatHours(kpi.kücheData.actualHours),
        `${kpi.kücheData.actualHours - kpi.kücheData.plannedHours >= 0 ? '+' : ''}${formatHours(kpi.kücheData.actualHours - kpi.kücheData.plannedHours)}`,
        formatCurrency(kpi.kücheData.plannedCost),
        formatCurrency(kpi.kücheData.actualCost),
        `${kpi.kücheData.actualCost - kpi.kücheData.plannedCost >= 0 ? '+' : ''}${formatCurrency(kpi.kücheData.actualCost - kpi.kücheData.plannedCost)}`,
        formatCurrency(kpi.kücheData.avgHourlyRate),
      ],
      [
        'GESAMT',
        (kpi.serviceData.employeeCount + kpi.kücheData.employeeCount).toString(),
        formatHours(kpi.plannedHours),
        formatHours(kpi.actualHours),
        `${kpi.hoursVariance >= 0 ? '+' : ''}${formatHours(kpi.hoursVariance)}`,
        formatCurrency(kpi.plannedLaborCost),
        formatCurrency(kpi.actualLaborCost),
        `${kpi.laborCostVariance <= 0 ? '+' : ''}${formatCurrency(Math.abs(kpi.laborCostVariance))}`,
        formatCurrency(avgHourly),
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [40, 45, 42], fontSize: 7, cellPadding: 2 },
    styles: { fontSize: 7, cellPadding: 2 },
    columnStyles: {
      0: { fontStyle: 'bold' },
      4: { halign: 'right' },
      7: { halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === 2 && data.section === 'body') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [235, 240, 236];
      }
      if ((data.column.index === 4 || data.column.index === 7) && data.section === 'body') {
        const text = data.cell.text[0] || '';
        if (text.startsWith('+')) {
          data.cell.styles.textColor = [180, 80, 80];
        } else if (text.startsWith('-')) {
          data.cell.styles.textColor = [76, 128, 90];
        }
      }
    },
  });
  
  // Weekly Performance
  const weekTableY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Wochenperformance', margin.left, weekTableY);
  
  // Weekly bar chart
  const weeklyChartData = kpi.weeklyStats.slice(0, 5).map(w => ({
    label: w.week,
    value: w.laborQuote,
    color: w.laborQuote <= 30 ? OLIV_COLORS.success : w.laborQuote <= 35 ? OLIV_COLORS.warning : OLIV_COLORS.danger,
  }));
  
  drawBarChart(doc, margin.left, weekTableY + 5, contentWidth, 45, weeklyChartData, 'Personalkostenquote nach Kalenderwoche (%)');
  
  autoTable(doc, {
    startY: weekTableY + 55,
    margin: { left: margin.left, right: margin.right },
    head: [['Woche', 'Umsatz', 'PK', 'Quote', 'Stunden', 'Ø CHF/Std', 'Ø/Tag', 'Bewertung']],
    body: kpi.weeklyStats.map(w => {
      const avgHourlyWeek = w.hours > 0 ? w.laborCost / w.hours : 0;
      const avgPerDay = w.days > 0 ? w.laborCost / w.days : 0;
      return [
        w.week,
        formatCurrency(w.revenue),
        formatCurrency(w.laborCost),
        `${w.laborQuote.toFixed(1)}%`,
        formatHours(w.hours),
        `${avgHourlyWeek.toFixed(2)}`,
        formatCurrency(avgPerDay),
        w.laborQuote <= 30 ? '✓ Optimal' : w.laborQuote <= 35 ? '○ OK' : '✗ Kritisch',
      ];
    }),
    theme: 'striped',
    headStyles: { fillColor: [40, 45, 42], fontSize: 7 },
    styles: { fontSize: 7 },
    columnStyles: {
      7: { fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.column.index === 7 && data.section === 'body') {
        const quote = kpi.weeklyStats[data.row.index]?.laborQuote || 0;
        data.cell.styles.textColor = quote <= 30 ? [76, 128, 90] : quote <= 35 ? [180, 150, 80] : [180, 80, 80];
      }
      if (data.column.index === 3 && data.section === 'body') {
        const quote = kpi.weeklyStats[data.row.index]?.laborQuote || 0;
        if (quote <= 30) {
          data.cell.styles.fillColor = [220, 235, 225];
        } else if (quote <= 35) {
          data.cell.styles.fillColor = [250, 245, 220];
        } else {
          data.cell.styles.fillColor = [250, 230, 230];
        }
        data.cell.styles.fontStyle = 'bold';
      }
    },
  });
  
  // Page 3 footer with watermark
  addPageFooter(doc, 3, totalPages, logoBase64, displayPeriod);
  
  // ==================== PAGE 4: Employee & Daily Details ====================
  doc.addPage();
  
  // Page header with logo
  addPageHeader(doc, 'Mitarbeiter-Übersicht', logoBase64);
  
  const sortedEmployees = [...kpi.employeeStats].sort((a, b) => b.actualCost - a.actualCost);
  
  autoTable(doc, {
    startY: 28,
    margin: { left: margin.left, right: margin.right },
    head: [['Name', 'Abteilung', 'Plan Std', 'Ist Std', 'Diff.', 'CHF/Std', 'Kosten Ist', 'Status']],
    body: sortedEmployees.slice(0, 12).map(emp => {
      const hourlyRate = emp.actualHours > 0 ? emp.actualCost / emp.actualHours : 0;
      return [
        emp.name,
        emp.department === 'küche' ? 'Küche' : 'Service',
        formatHours(emp.plannedHours),
        formatHours(emp.actualHours),
        `${emp.hoursVariance >= 0 ? '+' : ''}${formatHours(emp.hoursVariance)}`,
        `${hourlyRate.toFixed(2)}`,
        formatCurrency(emp.actualCost),
        emp.hoursVariance > 8 ? '⚠️ Überstunden' : emp.hoursVariance < -5 ? '📉 Unterplan' : '✓ OK',
      ];
    }),
    theme: 'striped',
    headStyles: { fillColor: [51, 65, 85], fontSize: 7 },
    styles: { fontSize: 7 },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { fontStyle: 'bold' },
    },
    didParseCell: (data) => {
      if (data.column.index === 4 && data.section === 'body') {
        const variance = sortedEmployees[data.row.index]?.hoursVariance || 0;
        data.cell.styles.textColor = variance > 5 ? [239, 68, 68] : variance < -2 ? [59, 130, 246] : [34, 197, 94];
      }
      if (data.column.index === 7 && data.section === 'body') {
        const emp = sortedEmployees[data.row.index];
        if (emp?.hoursVariance > 8) {
          data.cell.styles.textColor = [239, 68, 68];
        } else if (emp?.hoursVariance < -5) {
          data.cell.styles.textColor = [59, 130, 246];
        } else {
          data.cell.styles.textColor = [34, 197, 94];
        }
      }
    },
  });
  
  // Daily performance heatmap style
  const empTableY = (doc as any).lastAutoTable.finalY + 15;
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Tagesübersicht', margin.left, empTableY);
  
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.gray);
  doc.text('Farbcodierung: Grün = Quote ≤30% | Gelb = 30-35% | Rot = >35%', margin.left, empTableY + 8);
  
  autoTable(doc, {
    startY: empTableY + 12,
    margin: { left: margin.left, right: margin.right },
    head: [['Tag', 'Datum', 'Umsatz', 'PK', 'Quote', 'MA']],
    body: kpi.dailyStats.filter(d => d.revenue > 0).map(day => [
      day.dayName,
      day.date,
      formatCurrency(day.revenue),
      formatCurrency(day.laborCost),
      `${day.laborQuote.toFixed(1)}%`,
      day.employeeCount.toString(),
    ]),
    theme: 'striped',
    headStyles: { fillColor: [40, 45, 42], fontSize: 8 },
    styles: { fontSize: 7, cellPadding: 2 },
    didParseCell: (data) => {
      if (data.column.index === 4 && data.section === 'body') {
        const dayData = kpi.dailyStats.filter(d => d.revenue > 0)[data.row.index];
        if (dayData) {
          const quote = dayData.laborQuote;
          if (quote <= 30) {
            data.cell.styles.fillColor = [220, 252, 231];
            data.cell.styles.textColor = [22, 101, 52];
          } else if (quote <= 35) {
            data.cell.styles.fillColor = [254, 249, 195];
            data.cell.styles.textColor = [133, 77, 14];
          } else {
            data.cell.styles.fillColor = [254, 226, 226];
            data.cell.styles.textColor = [153, 27, 27];
          }
          data.cell.styles.fontStyle = 'bold';
        }
      }
    },
  });
  
  // Page 4 footer with watermark
  addPageFooter(doc, 4, totalPages, logoBase64, displayPeriod);
  
  // ==================== PAGE 5: Hourly Staffing Analysis ====================
  // Check if we have any hourly revenue data
  const daysWithHourlyData = kpi.dailyStats.filter(d => d.hourlyRevenue && d.hourlyRevenue.length > 0);
  
  if (daysWithHourlyData.length > 0) {
    doc.addPage();
    
    // Page header with logo
    addPageHeader(doc, 'Schicht-Umsatz Analyse', logoBase64);
    
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text('Stündliche Umsatzverteilung und Personalbesetzung - Basis für Optimierungen', margin.left, 28);
    
    // Aggregate hourly data across all days with data
    const hourlyAggregates: Record<number, { revenue: number; count: number }> = {};
    
    daysWithHourlyData.forEach(day => {
      day.hourlyRevenue?.forEach(h => {
        if (!hourlyAggregates[h.hour]) {
          hourlyAggregates[h.hour] = { revenue: 0, count: 0 };
        }
        hourlyAggregates[h.hour].revenue += h.revenue;
        hourlyAggregates[h.hour].count++;
      });
    });
    
    // Convert to array and calculate averages
    const hourlyAvgData = Object.entries(hourlyAggregates)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        avgRevenue: data.revenue / data.count,
        totalRevenue: data.revenue,
      }))
      .filter(h => h.hour >= 10 && h.hour <= 23)
      .sort((a, b) => a.hour - b.hour);
    
    const totalAvgRevenue = hourlyAvgData.reduce((sum, h) => sum + h.avgRevenue, 0);
    const significantThreshold = totalAvgRevenue * 0.03;
    
    // Find peak and last significant hour
    const peakHour = hourlyAvgData.reduce((max, h) => h.avgRevenue > max.avgRevenue ? h : max, hourlyAvgData[0]);
    const lastSignificantHour = hourlyAvgData
      .filter(h => h.avgRevenue >= significantThreshold)
      .reduce((max, h) => Math.max(max, h.hour), 0);
    
    // Summary box
    doc.setFillColor(...OLIV_COLORS.successLight);
    doc.setDrawColor(...OLIV_COLORS.success);
    doc.setLineWidth(0.5);
    doc.roundedRect(margin.left, 35, contentWidth, 25, 3, 3, 'FD');
    
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.success);
    doc.text('Erkenntnisse aus der Stundenanalyse', margin.left + 6, 44);
    
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...OLIV_COLORS.success);
    doc.text(`Peak: ${peakHour?.hour || 0}:00 Uhr (${formatCurrency(peakHour?.avgRevenue || 0)}/Tag) | Letzter relevanter Umsatz: ${lastSignificantHour}:00 Uhr | Empf. Schichtende Aushilfen: ${lastSignificantHour + 1}:00`, margin.left + 6, 52);
    
    // Hourly breakdown table
    autoTable(doc, {
      startY: 65,
      margin: { left: margin.left, right: margin.right },
      head: [['Stunde', 'Ø Umsatz', 'Anteil', 'Bewertung', 'Empfehlung']],
      body: hourlyAvgData.map(h => {
        const percent = totalAvgRevenue > 0 ? (h.avgRevenue / totalAvgRevenue) * 100 : 0;
        let recommendation = '';
        let evaluation = '';
        
        if (percent < 2) {
          evaluation = '○ Minimal';
          recommendation = 'Kernbesetzung ausreichend';
        } else if (percent < 5) {
          evaluation = '△ Niedrig';
          recommendation = 'Aushilfen optional';
        } else if (percent < 10) {
          evaluation = '◆ Mittel';
          recommendation = 'Normale Besetzung';
        } else if (percent < 15) {
          evaluation = '● Hoch';
          recommendation = 'Volle Besetzung nötig';
        } else {
          evaluation = '★ Peak';
          recommendation = 'Maximale Kapazität sichern';
        }
        
        return [
          `${h.hour}:00`,
          formatCurrency(h.avgRevenue),
          `${percent.toFixed(1)}%`,
          evaluation,
          recommendation,
        ];
      }),
      theme: 'striped',
      headStyles: { fillColor: [51, 65, 85], fontSize: 8 },
      styles: { fontSize: 7 },
      columnStyles: {
        0: { fontStyle: 'bold' },
        2: { halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.column.index === 2 && data.section === 'body') {
          const hourData = hourlyAvgData[data.row.index];
          if (hourData) {
            const percent = totalAvgRevenue > 0 ? (hourData.avgRevenue / totalAvgRevenue) * 100 : 0;
            if (percent >= 15) {
              data.cell.styles.fillColor = [220, 252, 231];
              data.cell.styles.textColor = [22, 101, 52];
            } else if (percent >= 10) {
              data.cell.styles.fillColor = [219, 234, 254];
              data.cell.styles.textColor = [30, 64, 175];
            } else if (percent < 3) {
              data.cell.styles.fillColor = [254, 226, 226];
              data.cell.styles.textColor = [153, 27, 27];
            }
          }
        }
      },
    });
    
    // Optimization recommendations based on hourly data
    const hourlyTableY = (doc as any).lastAutoTable.finalY + 15;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text('Konkrete Massnahmen für Schichtplanung', margin.left, hourlyTableY);
    
    const massnahmen: string[] = [];
    
    // Find slow hours
    const slowHours = hourlyAvgData.filter(h => {
      const percent = (h.avgRevenue / totalAvgRevenue) * 100;
      return percent < 3 && h.hour >= 14;
    });
    
    if (slowHours.length > 0) {
      massnahmen.push(`• Stunden mit minimalem Umsatz: ${slowHours.map(h => `${h.hour}:00`).join(', ')} - Aushilfen hier nicht einplanen`);
    }
    
    // Peak preparation
    if (peakHour) {
      massnahmen.push(`• Peak-Vorbereitung: Ab ${Math.max(10, peakHour.hour - 1)}:00 Uhr volle Besetzung sicherstellen`);
    }
    
    // Late hours
    if (lastSignificantHour < 22) {
      massnahmen.push(`• Schichtende Aushilfen: ${lastSignificantHour + 1}:00 Uhr empfohlen (Umsatz danach < 3%)`);
    }
    
    // Afternoon gap
    const afternoonHours = hourlyAvgData.filter(h => h.hour >= 14 && h.hour <= 17);
    const avgAfternoon = afternoonHours.reduce((sum, h) => sum + h.avgRevenue, 0) / (afternoonHours.length || 1);
    if (avgAfternoon < totalAvgRevenue * 0.05) {
      massnahmen.push('• Nachmittags-Tief: 14:00-17:00 Uhr nur Kernbesetzung, geteilte Schichten nutzen');
    }
    
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.slate);
    massnahmen.forEach((m, i) => {
      doc.text(m, margin.left, hourlyTableY + 8 + (i * 6));
    });
    
    // Page 5 footer with watermark
    addPageFooter(doc, 5, totalPages, logoBase64, displayPeriod);
  }
  
  // ==================== FINAL PAGE: Visual Summary ====================
  doc.addPage();
  
  // Page header with logo
  addPageHeader(doc, 'Zusammenfassung auf einen Blick', logoBase64);
  
  // --- Section 1: Key Metrics Grid (like CompactKPIWidget) ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Zentrale Kennzahlen', margin.left, 28);
  
  const kpiCards = [
    { 
      label: 'Gesamtumsatz', 
      value: formatCurrency(kpi.actualRevenue), 
      plan: formatCurrency(kpi.plannedRevenue),
      diff: kpi.revenueVariancePercent,
      isPositive: kpi.revenueVariancePercent >= 0 
    },
    { 
      label: 'Personalkosten', 
      value: formatCurrency(kpi.actualLaborCost), 
      plan: formatCurrency(kpi.plannedLaborCost),
      diff: -kpi.laborCostVariancePercent,
      isPositive: kpi.laborCostVariance >= 0 
    },
    { 
      label: 'Personalkostenquote', 
      value: `${kpi.laborCostQuoteActual.toFixed(1)}%`, 
      plan: `Ziel: 32%`,
      diff: 32 - kpi.laborCostQuoteActual,
      isPositive: kpi.laborCostQuoteActual <= 32 
    },
    { 
      label: 'Arbeitsstunden', 
      value: formatHours(kpi.actualHours), 
      plan: formatHours(kpi.plannedHours),
      diff: kpi.hoursVariance,
      isPositive: kpi.hoursVariance <= 0 
    },
  ];
  
  const summaryKpiCardWidth = (contentWidth - 12) / 4;
  kpiCards.forEach((kpiItem, i) => {
    const x = margin.left + i * (summaryKpiCardWidth + 4);
    const y = 33;
    
    // Card background
    doc.setFillColor(...OLIV_COLORS.sagePale);
    doc.setDrawColor(...OLIV_COLORS.sage);
    doc.setLineWidth(0.5);
    doc.roundedRect(x, y, summaryKpiCardWidth, 32, 3, 3, 'FD');
    
    // Label
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(kpiItem.label, x + 4, y + 8);
    
    // Value
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(kpiItem.value, x + 4, y + 18);
    
    // Plan and trend
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(kpiItem.plan, x + 4, y + 25);
    
    // Trend indicator
    const trendColor = kpiItem.isPositive ? OLIV_COLORS.success : OLIV_COLORS.danger;
    doc.setFillColor(trendColor[0], trendColor[1], trendColor[2]);
    doc.circle(x + summaryKpiCardWidth - 8, y + 8, 3, 'F');
    doc.setTextColor(...OLIV_COLORS.white);
    doc.setFontSize(6);
    doc.text(kpiItem.isPositive ? '✓' : '!', x + summaryKpiCardWidth - 8, y + 9.5, { align: 'center' });
  });
  
  // --- Section 2: Plan vs Actual Progress Bars ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Plan vs. Ist Vergleich', margin.left, 75);
  
  const progressItems = [
    { label: 'Umsatz', plan: kpi.plannedRevenue, actual: kpi.actualRevenue, isGoodIfOver: true },
    { label: 'Kosten', plan: kpi.plannedLaborCost, actual: kpi.actualLaborCost, isGoodIfOver: false },
    { label: 'Stunden', plan: kpi.plannedHours, actual: kpi.actualHours, isGoodIfOver: false },
  ];
  
  progressItems.forEach((item, i) => {
    const y = 82 + i * 14;
    const barWidth = contentWidth - 50;
    const progress = item.plan > 0 ? Math.min((item.actual / item.plan) * 100, 150) : 0;
    const isGood = item.isGoodIfOver ? item.actual >= item.plan : item.actual <= item.plan;
    
    // Label
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(item.label, margin.left, y + 5);
    
    // Background bar
    doc.setFillColor(...OLIV_COLORS.offWhite);
    doc.roundedRect(margin.left + 25, y, barWidth, 8, 2, 2, 'F');
    
    // Progress bar
    const progressColor = isGood ? OLIV_COLORS.success : OLIV_COLORS.danger;
    doc.setFillColor(progressColor[0], progressColor[1], progressColor[2]);
    doc.roundedRect(margin.left + 25, y, barWidth * Math.min(progress / 100, 1), 8, 2, 2, 'F');
    
    // 100% marker
    const markerX = margin.left + 25 + barWidth * (100 / Math.max(progress, 100));
    doc.setDrawColor(...OLIV_COLORS.charcoal);
    doc.setLineWidth(0.5);
    doc.line(markerX, y, markerX, y + 8);
    
    // Percentage
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(progressColor[0], progressColor[1], progressColor[2]);
    doc.text(`${progress.toFixed(0)}%`, margin.left + contentWidth - 5, y + 5, { align: 'right' });
  });
  
  // --- Section 3: Department Distribution ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Abteilungsverteilung', margin.left, 128);
  
  const totalDeptCost = kpi.serviceData.actualCost + kpi.kücheData.actualCost;
  const servicePctSummary = totalDeptCost > 0 ? (kpi.serviceData.actualCost / totalDeptCost) * 100 : 50;
  const küchePctSummary = 100 - servicePctSummary;
  
  // Horizontal stacked bar
  const deptBarY = 135;
  const deptBarHeight = 20;
  
  // Service segment
  doc.setFillColor(...OLIV_COLORS.sage);
  doc.roundedRect(margin.left, deptBarY, contentWidth * (servicePctSummary / 100), deptBarHeight, 0, 0, 'F');
  
  // Küche segment
  doc.setFillColor(...OLIV_COLORS.charcoal);
  doc.roundedRect(margin.left + contentWidth * (servicePctSummary / 100), deptBarY, contentWidth * (küchePctSummary / 100), deptBarHeight, 0, 0, 'F');
  
  // Labels inside bar
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  if (servicePctSummary > 20) {
    doc.text(`Service ${servicePctSummary.toFixed(0)}%`, margin.left + 10, deptBarY + 13);
  }
  if (küchePctSummary > 20) {
    doc.text(`Küche ${küchePctSummary.toFixed(0)}%`, margin.left + contentWidth - 30, deptBarY + 13);
  }
  
  // Department details below
  const deptDetails = [
    { label: 'Service', hours: formatHours(kpi.serviceData.actualHours), cost: formatCurrency(kpi.serviceData.actualCost), count: kpi.serviceData.employeeCount },
    { label: 'Küche', hours: formatHours(kpi.kücheData.actualHours), cost: formatCurrency(kpi.kücheData.actualCost), count: kpi.kücheData.employeeCount },
  ];
  
  deptDetails.forEach((dept, i) => {
    const x = margin.left + i * (contentWidth / 2);
    const y = deptBarY + deptBarHeight + 8;
    
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(dept.label, x, y);
    
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.setFontSize(7);
    doc.text(`${dept.count} MA | ${dept.hours} Std | ${dept.cost}`, x, y + 6);
  });
  
  // --- Section 4: Year-over-Year Comparison ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Jahresvergleich (Vorjahr)', margin.left, 176);
  
  const prevYearLabel = format(subYears(startDate, 1), 'yyyy', { locale: de });
  const currentYearLabel = format(startDate, 'yyyy', { locale: de });
  
  // Year comparison cards
  const yoyCardWidth = (contentWidth - 12) / 4;
  const yoyY = 182;
  
  const yoyCards = [
    { 
      label: 'Umsatz', 
      current: formatCurrency(kpi.actualRevenue),
      prev: formatCurrency(yoyComparison.prevYear.revenue),
      change: yoyComparison.revenueChange,
      isPositive: yoyComparison.revenueChange >= 0 
    },
    { 
      label: 'Personalkosten', 
      current: formatCurrency(kpi.actualLaborCost),
      prev: formatCurrency(yoyComparison.prevYear.laborCost),
      change: yoyComparison.laborCostChange,
      isPositive: yoyComparison.laborCostChange <= 0 
    },
    { 
      label: 'PK-Quote', 
      current: `${kpi.laborCostQuoteActual.toFixed(1)}%`,
      prev: `${yoyComparison.prevYear.quote.toFixed(1)}%`,
      change: yoyComparison.quoteDiff,
      isPositive: yoyComparison.quoteDiff <= 0,
      isPercent: true
    },
    { 
      label: 'Arbeitsstunden', 
      current: formatHours(kpi.actualHours),
      prev: formatHours(yoyComparison.prevYear.hours),
      change: yoyComparison.hoursChange,
      isPositive: yoyComparison.hoursChange <= 0 
    },
  ];
  
  yoyCards.forEach((card, i) => {
    const x = margin.left + i * (yoyCardWidth + 4);
    
    // Card background
    doc.setFillColor(...OLIV_COLORS.white);
    doc.setDrawColor(...OLIV_COLORS.sageLight);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, yoyY, yoyCardWidth, 28, 2, 2, 'FD');
    
    // Label
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(card.label, x + 3, yoyY + 6);
    
    // Current value
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(card.current, x + 3, yoyY + 14);
    
    // Change indicator
    const changeColor = card.isPositive ? OLIV_COLORS.success : OLIV_COLORS.danger;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(changeColor[0], changeColor[1], changeColor[2]);
    const changeText = card.isPercent 
      ? `${card.change >= 0 ? '+' : ''}${card.change.toFixed(1)} PP`
      : `${card.change >= 0 ? '+' : ''}${card.change.toFixed(1)}%`;
    doc.text(changeText, x + 3, yoyY + 21);
    
    // Previous year value (small)
    doc.setFontSize(5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.silver);
    doc.text(`${prevYearLabel}: ${card.prev}`, x + 3, yoyY + 26);
  });
  
  // --- Section 5: Weekly Performance Chart (compact) ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Wochentrend (PKQ)', margin.left, 220);
  
  // Draw weekly bars (compact)
  const weeklyBarWidth = (contentWidth - (kpi.weeklyStats.length - 1) * 3) / Math.max(kpi.weeklyStats.length, 1);
  const maxWeeklyQuote = Math.max(...kpi.weeklyStats.map(w => w.laborQuote), 40);
  const chartHeight = 25;
  const chartY = 226;
  
  kpi.weeklyStats.forEach((week, i) => {
    const x = margin.left + i * (weeklyBarWidth + 3);
    const barHeight = (week.laborQuote / maxWeeklyQuote) * chartHeight;
    const barColor = week.laborQuote <= 30 ? OLIV_COLORS.success : week.laborQuote <= 35 ? OLIV_COLORS.warning : OLIV_COLORS.danger;
    
    // Bar
    doc.setFillColor(barColor[0], barColor[1], barColor[2]);
    doc.roundedRect(x, chartY + chartHeight - barHeight, weeklyBarWidth, barHeight, 2, 2, 'F');
    
    // Week label
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(week.week, x + weeklyBarWidth / 2, chartY + chartHeight + 5, { align: 'center' });
    
    // Value
    doc.setFontSize(6);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(barColor[0], barColor[1], barColor[2]);
    doc.text(`${week.laborQuote.toFixed(0)}%`, x + weeklyBarWidth / 2, chartY + chartHeight - barHeight - 2, { align: 'center' });
  });
  
  // Target line at 32%
  const targetLineY = chartY + chartHeight - (32 / maxWeeklyQuote) * chartHeight;
  doc.setDrawColor(...OLIV_COLORS.sage);
  doc.setLineDashPattern([2, 2], 0);
  doc.setLineWidth(0.5);
  doc.line(margin.left, targetLineY, margin.left + contentWidth, targetLineY);
  doc.setLineDashPattern([], 0);
  doc.setFontSize(6);
  doc.setTextColor(...OLIV_COLORS.sage);
  doc.text('Ziel 32%', margin.left + contentWidth + 2, targetLineY + 2);
  
  // --- Section 6: Action Summary Box ---
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('Fazit & Massnahmen', margin.left, 265);
  
  // Status box
  const conclusionY = 270;
  doc.setFillColor(statusColor[0], statusColor[1], statusColor[2]);
  doc.roundedRect(margin.left, conclusionY, contentWidth, 18, 3, 3, 'F');
  
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  doc.text(situation.headline, margin.left + 6, conclusionY + 12);
  
  // Final page footer
  addPageFooter(doc, totalPages, totalPages, logoBase64, displayPeriod);
  
  // Save with sanitized period label
  const sanitizedPeriod = periodLabel 
    ? periodLabel.replace(/[^a-zA-Z0-9äöüÄÖÜß\-\s]/g, '').replace(/\s+/g, '_')
    : format(selectedDate, 'yyyy-MM', { locale: de });
  doc.save(`Controlling_Report_${sanitizedPeriod}.pdf`);
};

export const exportKPIReportExcel = async (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: Record<string, DailyBudget>,
  selectedDate: Date,
  customEndDate?: Date,
  periodLabel?: string,
  showNetRevenue: boolean = false
) => {
  const workbook = new ExcelJS.Workbook();
  
  // Use custom date range if provided, otherwise default to month
  const startDate = customEndDate ? selectedDate : startOfMonth(selectedDate);
  const endDate = customEndDate || endOfMonth(selectedDate);
  
  // Generate period label if not provided
  const revenueMode = showNetRevenue ? 'Netto' : 'Brutto';
  const displayPeriod = periodLabel || format(selectedDate, 'MMMM yyyy', { locale: de });
  const displayPeriodWithMode = `${displayPeriod} (${revenueMode})`;
  
  const kpi = calculateKPIData(employees, timeEntries, dailyBudgets, startDate, endDate);
  const actions = generateActionItems(kpi);
  const situation = analyzeSituation(kpi);
  
  // === Sheet 1: Executive Summary ===
  const summarySheet = workbook.addWorksheet('Übersicht');
  
  // Title
  summarySheet.mergeCells('A1:G1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = `Personal-Controlling Report - Zeitraum: ${displayPeriodWithMode}`;
  titleCell.font = { size: 20, bold: true, color: { argb: 'FF1E293B' } };
  titleCell.alignment = { horizontal: 'left' };
  
  // Status
  summarySheet.getCell('A3').value = 'Status:';
  summarySheet.getCell('A3').font = { bold: true };
  const statusCell = summarySheet.getCell('B3');
  statusCell.value = situation.headline;
  const statusColors = { excellent: 'FF22C55E', good: 'FF3B82F6', warning: 'FFEAB308', critical: 'FFEF4444' };
  statusCell.font = { bold: true, color: { argb: statusColors[situation.status] } };
  
  summarySheet.mergeCells('A4:G4');
  summarySheet.getCell('A4').value = situation.summary;
  summarySheet.getCell('A4').font = { italic: true, color: { argb: 'FF64748B' } };
  
  // Key Insights
  summarySheet.getCell('A6').value = 'Wichtige Erkenntnisse:';
  summarySheet.getCell('A6').font = { bold: true };
  situation.keyInsights.forEach((insight, i) => {
    summarySheet.getCell(`A${7 + i}`).value = `• ${insight}`;
  });
  
  // Key Metrics Table
  const metricsStartRow = 7 + situation.keyInsights.length + 2;
  summarySheet.getCell(`A${metricsStartRow}`).value = 'Kennzahlen';
  summarySheet.getCell(`A${metricsStartRow}`).font = { size: 14, bold: true };
  
  const metricsData = [
    ['', 'Plan', 'Ist', 'Differenz', 'Trend'],
    ['Umsatz', formatCurrency(kpi.plannedRevenue), formatCurrency(kpi.actualRevenue), `${kpi.revenueVariancePercent >= 0 ? '+' : ''}${kpi.revenueVariancePercent.toFixed(1)}%`, kpi.revenueVariancePercent >= 0 ? '↑' : '↓'],
    ['Personalkosten', formatCurrency(kpi.plannedLaborCost), formatCurrency(kpi.actualLaborCost), `${kpi.laborCostVariance >= 0 ? '+' : ''}${formatCurrency(kpi.laborCostVariance)}`, kpi.laborCostVariance >= 0 ? '↑' : '↓'],
    ['Arbeitsstunden', formatHours(kpi.plannedHours), formatHours(kpi.actualHours), `${kpi.hoursVariance >= 0 ? '+' : ''}${formatHours(kpi.hoursVariance)}`, kpi.hoursVariance <= 0 ? '↑' : '↓'],
    ['PK-Quote', `${kpi.laborCostQuotePlanned.toFixed(1)}%`, `${kpi.laborCostQuoteActual.toFixed(1)}%`, '', kpi.laborCostQuoteActual <= kpi.laborCostQuotePlanned ? '↑' : '↓'],
  ];
  
  metricsData.forEach((row, i) => {
    const rowNum = metricsStartRow + 2 + i;
    row.forEach((value, j) => {
      const cell = summarySheet.getCell(rowNum, j + 1);
      cell.value = value;
      if (i === 0) {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      }
      if (j === 0 && i > 0) cell.font = { bold: true };
      if (j === 4 && i > 0) {
        cell.font = { bold: true, color: { argb: value === '↑' ? 'FF22C55E' : 'FFEF4444' } };
      }
    });
  });
  
  // Column widths
  summarySheet.getColumn('A').width = 20;
  summarySheet.getColumn('B').width = 18;
  summarySheet.getColumn('C').width = 18;
  summarySheet.getColumn('D').width = 18;
  summarySheet.getColumn('E').width = 10;
  
  // === Sheet 2: Massnahmen ===
  const actionsSheet = workbook.addWorksheet('Massnahmen');
  
  actionsSheet.mergeCells('A1:F1');
  actionsSheet.getCell('A1').value = 'Priorisierte Handlungsempfehlungen';
  actionsSheet.getCell('A1').font = { size: 16, bold: true };
  
  actionsSheet.getRow(3).values = ['Priorität', 'Bereich', 'Problem', 'Empfehlung', 'Einspar-Potenzial'];
  actionsSheet.getRow(3).font = { bold: true };
  actionsSheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  actionsSheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  
  if (actions.length === 0) {
    actionsSheet.getCell('A4').value = '✓ Keine dringenden Massnahmen erforderlich - weiter so!';
    actionsSheet.getCell('A4').font = { bold: true, color: { argb: 'FF22C55E' } };
  } else {
    actions.forEach((action, index) => {
      const rowNum = 4 + index;
      actionsSheet.getCell(`A${rowNum}`).value = action.priority === 'high' ? '🔴 Hoch' : action.priority === 'medium' ? '🟡 Mittel' : '🟢 Niedrig';
      actionsSheet.getCell(`B${rowNum}`).value = action.area;
      actionsSheet.getCell(`C${rowNum}`).value = action.issue;
      actionsSheet.getCell(`D${rowNum}`).value = action.recommendation;
      actionsSheet.getCell(`E${rowNum}`).value = action.potentialSaving ? formatCurrency(action.potentialSaving) : '-';
      
      const priorityColor = action.priority === 'high' ? 'FFFEE2E2' : action.priority === 'medium' ? 'FFFEF3C7' : 'FFD1FAE5';
      actionsSheet.getRow(rowNum).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: priorityColor } };
    });
  }
  
  actionsSheet.getColumn('A').width = 15;
  actionsSheet.getColumn('B').width = 20;
  actionsSheet.getColumn('C').width = 45;
  actionsSheet.getColumn('D').width = 55;
  actionsSheet.getColumn('E').width = 18;
  
  // === Sheet 3: Abteilungen ===
  const deptSheet = workbook.addWorksheet('Abteilungen');
  
  deptSheet.mergeCells('A1:G1');
  deptSheet.getCell('A1').value = 'Abteilungsvergleich';
  deptSheet.getCell('A1').font = { size: 16, bold: true };
  
  deptSheet.getRow(3).values = ['Abteilung', 'Mitarbeiter', 'Stunden Plan', 'Stunden Ist', 'Kosten Plan', 'Kosten Ist', '∅ CHF/Std'];
  deptSheet.getRow(3).font = { bold: true };
  deptSheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  deptSheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  
  const deptData = [
    ['Service', kpi.serviceData.employeeCount, formatHours(kpi.serviceData.plannedHours), formatHours(kpi.serviceData.actualHours), formatCurrency(kpi.serviceData.plannedCost), formatCurrency(kpi.serviceData.actualCost), formatCurrency(kpi.serviceData.avgHourlyRate)],
    ['Küche', kpi.kücheData.employeeCount, formatHours(kpi.kücheData.plannedHours), formatHours(kpi.kücheData.actualHours), formatCurrency(kpi.kücheData.plannedCost), formatCurrency(kpi.kücheData.actualCost), formatCurrency(kpi.kücheData.avgHourlyRate)],
    ['GESAMT', kpi.serviceData.employeeCount + kpi.kücheData.employeeCount, formatHours(kpi.plannedHours), formatHours(kpi.actualHours), formatCurrency(kpi.plannedLaborCost), formatCurrency(kpi.actualLaborCost), formatCurrency(kpi.actualHours > 0 ? kpi.actualLaborCost / kpi.actualHours : 0)],
  ];
  
  deptData.forEach((row, index) => {
    deptSheet.getRow(4 + index).values = row;
    if (index === 2) {
      deptSheet.getRow(4 + index).font = { bold: true };
      deptSheet.getRow(4 + index).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E5E5' } };
    }
  });
  
  deptSheet.columns.forEach(col => col.width = 16);
  deptSheet.getColumn('A').width = 12;
  
  // === Sheet 4: Wochen ===
  const weekSheet = workbook.addWorksheet('Wochen');
  
  weekSheet.mergeCells('A1:F1');
  weekSheet.getCell('A1').value = 'Wochenperformance';
  weekSheet.getCell('A1').font = { size: 16, bold: true };
  
  weekSheet.getRow(3).values = ['Woche', 'Umsatz', 'Personalkosten', 'Quote', 'Stunden', 'Bewertung'];
  weekSheet.getRow(3).font = { bold: true };
  weekSheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  weekSheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  
  kpi.weeklyStats.forEach((week, index) => {
    const rowNum = 4 + index;
    weekSheet.getRow(rowNum).values = [
      week.week,
      formatCurrency(week.revenue),
      formatCurrency(week.laborCost),
      `${week.laborQuote.toFixed(1)}%`,
      formatHours(week.hours),
      week.laborQuote <= 30 ? '✓ Optimal' : week.laborQuote <= 35 ? '○ OK' : '✗ Kritisch',
    ];
    
    // Color code the quote column
    const quoteColor = week.laborQuote <= 30 ? 'FFD1FAE5' : week.laborQuote <= 35 ? 'FFFEF3C7' : 'FFFEE2E2';
    weekSheet.getCell(`D${rowNum}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: quoteColor } };
    weekSheet.getCell(`D${rowNum}`).font = { bold: true };
  });
  
  weekSheet.columns.forEach(col => col.width = 16);
  
  // === Sheet 5: Mitarbeiter ===
  const empSheet = workbook.addWorksheet('Mitarbeiter');
  
  empSheet.mergeCells('A1:H1');
  empSheet.getCell('A1').value = 'Mitarbeiter-Performance';
  empSheet.getCell('A1').font = { size: 16, bold: true };
  
  empSheet.getRow(3).values = ['Name', 'Abteilung', 'Plan Std', 'Ist Std', 'Differenz', 'Plan CHF', 'Ist CHF', 'Status'];
  empSheet.getRow(3).font = { bold: true };
  empSheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  empSheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  
  kpi.employeeStats
    .sort((a, b) => b.actualCost - a.actualCost)
    .forEach((emp, index) => {
      const rowNum = 4 + index;
      empSheet.getRow(rowNum).values = [
        emp.name,
        emp.department === 'küche' ? 'Küche' : 'Service',
        formatHours(emp.plannedHours),
        formatHours(emp.actualHours),
        `${emp.hoursVariance >= 0 ? '+' : ''}${formatHours(emp.hoursVariance)}`,
        formatCurrency(emp.plannedCost),
        formatCurrency(emp.actualCost),
        emp.hoursVariance > 8 ? '⚠️ Überstunden' : emp.hoursVariance < -5 ? '📉 Unterplan' : '✓ OK',
      ];
      
      // Highlight overtime
      if (emp.hoursVariance > 8) {
        empSheet.getRow(rowNum).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      } else if (emp.hoursVariance < -5) {
        empSheet.getRow(rowNum).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
      }
    });
  
  empSheet.getColumn('A').width = 25;
  empSheet.getColumn('B').width = 12;
  empSheet.columns.slice(2).forEach(col => col.width = 14);
  empSheet.getColumn('H').width = 16;
  
  // === Sheet 6: Tageswerte ===
  const dailySheet = workbook.addWorksheet('Tageswerte');
  
  dailySheet.mergeCells('A1:F1');
  dailySheet.getCell('A1').value = 'Tägliche Übersicht';
  dailySheet.getCell('A1').font = { size: 16, bold: true };
  
  dailySheet.getRow(3).values = ['Tag', 'Datum', 'Umsatz', 'Personalkosten', 'Quote', 'Mitarbeiter'];
  dailySheet.getRow(3).font = { bold: true };
  dailySheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  dailySheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  
  kpi.dailyStats.forEach((day, index) => {
    const rowNum = 4 + index;
    dailySheet.getRow(rowNum).values = [
      day.dayName,
      day.date,
      formatCurrency(day.revenue),
      formatCurrency(day.laborCost),
      `${day.laborQuote.toFixed(1)}%`,
      day.employeeCount,
    ];
    
    // Color code based on quote
    if (day.revenue > 0) {
      const quoteColor = day.laborQuote <= 30 ? 'FFD1FAE5' : day.laborQuote <= 35 ? 'FFFEF3C7' : 'FFFEE2E2';
      dailySheet.getCell(`E${rowNum}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: quoteColor } };
      dailySheet.getCell(`E${rowNum}`).font = { bold: true };
    }
  });
  
  dailySheet.columns.forEach(col => col.width = 15);
  dailySheet.getColumn('A').width = 10;
  dailySheet.getColumn('B').width = 12;
  
  // Save
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Use sanitized period label for filename if available
  const sanitizedPeriod = periodLabel 
    ? periodLabel.replace(/[^a-zA-Z0-9äöüÄÖÜß\-\s]/g, '').replace(/\s+/g, '_')
    : format(selectedDate, 'yyyy-MM', { locale: de });
  a.download = `KPI_Report_${sanitizedPeriod}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};

// ==================== Dashboard PDF Export ====================

interface HistoricalPeriodData {
  label: string;
  revenue: number;
  laborCost: number;
  laborCostQuote: number;
  hours: number;
}

const calculatePeriodStats = (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: DailyBudget[],
  targetDate: Date
): HistoricalPeriodData => {
  const monthStart = startOfMonth(targetDate);
  const monthEnd = endOfMonth(targetDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  let totalRevenue = 0;
  let totalLaborCost = 0;
  let totalHours = 0;

  daysInMonth.forEach((day) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
    const dayBudget = dailyBudgets.find((b) => b.date === dateStr);

    dayEntries.forEach((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (employee) {
        const hours = entry.actualHours || 0;
        totalHours += hours;
        totalLaborCost += hours * employee.hourlyWage * 1.22;
      }
    });

    totalRevenue += dayBudget?.actualRevenue || dayBudget?.plannedRevenue || 0;
  });

  const laborCostQuote = totalRevenue > 0 ? (totalLaborCost / totalRevenue) * 100 : 0;

  return {
    label: format(targetDate, 'MMMM yyyy', { locale: de }),
    revenue: totalRevenue,
    laborCost: totalLaborCost,
    laborCostQuote: Math.round(laborCostQuote * 10) / 10,
    hours: totalHours,
  };
};

export const exportDashboardPDF = (
  employees: Employee[],
  timeEntries: TimeEntry[],
  dailyBudgets: DailyBudget[],
  selectedDate: Date
) => {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ml = 14;
  const mr = 14;
  const cw = 210 - ml - mr; // 182 mm content width

  // Calculate data for all periods
  const currentMonth = calculatePeriodStats(employees, timeEntries, dailyBudgets, selectedDate);
  const prevMonth = calculatePeriodStats(employees, timeEntries, dailyBudgets, subMonths(selectedDate, 1));
  const prevYear = calculatePeriodStats(employees, timeEntries, dailyBudgets, subYears(selectedDate, 1));

  // Calculate department data
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const departments = {
    Service: { plannedHours: 0, actualHours: 0, laborCost: 0 },
    Küche: { plannedHours: 0, actualHours: 0, laborCost: 0 },
  };

  daysInMonth.forEach((day) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    const dayEntries = timeEntries.filter((entry) => entry.date === dateStr);
    dayEntries.forEach((entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (employee) {
        const deptName = employee.department === 'service' ? 'Service' : 'Küche';
        departments[deptName].plannedHours += entry.plannedHours;
        departments[deptName].actualHours += entry.actualHours || 0;
        departments[deptName].laborCost += (entry.actualHours || 0) * employee.hourlyWage * 1.22;
      }
    });
  });

  // Helper: signed percent change string + color
  const changeInfo = (current: number, previous: number): { text: string; color: [number, number, number] } => {
    if (previous === 0) {
      const t = current > 0 ? '+100%' : '—';
      return { text: t, color: OLIV_COLORS.gray };
    }
    const pct = ((current - previous) / previous) * 100;
    const text = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    const color = pct >= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger;
    return { text, color };
  };

  // Quote color (good ≤30, warning ≤35, danger >35)
  const quoteColor = (q: number): [number, number, number] =>
    q <= 30 ? OLIV_COLORS.success : q <= 35 ? OLIV_COLORS.warning : OLIV_COLORS.danger;

  // ── TOP ACCENT BAR ──────────────────────────────────────────────────
  doc.setFillColor(...OLIV_COLORS.sage);
  doc.rect(0, 0, 210, 3, 'F');

  // ── HEADER ──────────────────────────────────────────────────────────
  const periodLabel = format(selectedDate, 'MMMM yyyy', { locale: de });
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.charcoal);
  doc.text('KPI Dashboard', ml, 16);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.sage);
  doc.text(periodLabel, ml, 23);

  doc.setFontSize(7);
  doc.setTextColor(...OLIV_COLORS.silver);
  doc.text(
    `Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`,
    210 - mr, 16, { align: 'right' }
  );

  // Separator line
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.4);
  doc.line(ml, 27, 210 - mr, 27);

  // ── SECTION LABEL HELPER ────────────────────────────────────────────
  const sectionLabel = (text: string, y: number) => {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.sageDark);
    doc.text(text.toUpperCase(), ml, y);
    doc.setDrawColor(...OLIV_COLORS.sageLight);
    doc.setLineWidth(0.3);
    doc.line(ml + doc.getTextWidth(text.toUpperCase()) + 2, y - 1, 210 - mr, y - 1);
  };

  // ── KPI CARDS ROW ───────────────────────────────────────────────────
  sectionLabel('Kennzahlen', 33);

  const cardGap = 3;
  const cardW = (cw - cardGap * 3) / 4;
  const cardH = 38;
  const cardY = 36;

  const kpiCards = [
    {
      label: 'Umsatz',
      value: `CHF ${currentMonth.revenue.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      changeM: changeInfo(currentMonth.revenue, prevMonth.revenue),
      changeY: changeInfo(currentMonth.revenue, prevYear.revenue),
      valueColor: OLIV_COLORS.charcoal as [number, number, number],
    },
    {
      label: 'Personalkosten',
      value: `CHF ${currentMonth.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      changeM: changeInfo(currentMonth.laborCost, prevMonth.laborCost),
      changeY: changeInfo(currentMonth.laborCost, prevYear.laborCost),
      valueColor: OLIV_COLORS.charcoal as [number, number, number],
    },
    {
      label: 'PK-Quote',
      value: `${currentMonth.laborCostQuote.toFixed(1)}%`,
      changeM: (() => {
        const diff = currentMonth.laborCostQuote - prevMonth.laborCostQuote;
        return { text: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} PP`, color: diff <= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger } as { text: string; color: [number, number, number] };
      })(),
      changeY: (() => {
        const diff = currentMonth.laborCostQuote - prevYear.laborCostQuote;
        return { text: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} PP`, color: diff <= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger } as { text: string; color: [number, number, number] };
      })(),
      valueColor: quoteColor(currentMonth.laborCostQuote),
    },
    {
      label: 'Arbeitsstunden',
      value: `${currentMonth.hours.toFixed(1)} h`,
      changeM: changeInfo(currentMonth.hours, prevMonth.hours),
      changeY: changeInfo(currentMonth.hours, prevYear.hours),
      valueColor: OLIV_COLORS.charcoal as [number, number, number],
    },
  ];

  kpiCards.forEach((card, i) => {
    const x = ml + i * (cardW + cardGap);
    // Card background
    doc.setFillColor(...OLIV_COLORS.white);
    doc.setDrawColor(...OLIV_COLORS.sageLight);
    doc.setLineWidth(0.4);
    doc.roundedRect(x, cardY, cardW, cardH, 2, 2, 'FD');
    // Top accent
    doc.setFillColor(...OLIV_COLORS.sage);
    doc.roundedRect(x, cardY, cardW, 2, 1, 1, 'F');

    // Label
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.gray);
    doc.text(card.label, x + 4, cardY + 9);

    // Main value
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...card.valueColor);
    const valLines = doc.splitTextToSize(card.value, cardW - 6);
    doc.text(valLines[0], x + 4, cardY + 19);

    // vs Vormonat
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.silver);
    doc.text('vs. Vormonat', x + 4, cardY + 27);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...card.changeM.color);
    doc.text(card.changeM.text, x + cardW - 4, cardY + 27, { align: 'right' });

    // vs Vorjahr
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.silver);
    doc.text('vs. Vorjahr', x + 4, cardY + 33);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...card.changeY.color);
    doc.text(card.changeY.text, x + cardW - 4, cardY + 33, { align: 'right' });
  });

  // ── PERIODENVERGLEICH TABLE ─────────────────────────────────────────
  const compY = cardY + cardH + 8;
  sectionLabel('Periodenvergleich', compY);

  const compBoxY = compY + 3;
  const compBoxH = 52;
  doc.setFillColor(...OLIV_COLORS.sagePale);
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.3);
  doc.roundedRect(ml, compBoxY, cw, compBoxH, 2, 2, 'FD');

  // Table header row
  const colW = [50, 42, 42, 42];
  const colX = [ml + 4, ml + 54, ml + 96, ml + 138];
  const rowH = 10;

  doc.setFillColor(...OLIV_COLORS.tableHeader);
  doc.roundedRect(ml, compBoxY, cw, rowH, 2, 2, 'F');

  const headers = ['Kennzahl', periodLabel, format(subMonths(selectedDate, 1), 'MMM yyyy', { locale: de }), format(subYears(selectedDate, 1), 'MMM yyyy', { locale: de })];
  headers.forEach((h, i) => {
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.white);
    doc.text(h, colX[i], compBoxY + 6.5);
  });

  // Table rows
  const compRows = [
    {
      label: 'Umsatz',
      current: `CHF ${currentMonth.revenue.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevM: `CHF ${prevMonth.revenue.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevY: `CHF ${prevYear.revenue.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevMChange: changeInfo(currentMonth.revenue, prevMonth.revenue),
      prevYChange: changeInfo(currentMonth.revenue, prevYear.revenue),
    },
    {
      label: 'Personalkosten',
      current: `CHF ${currentMonth.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevM: `CHF ${prevMonth.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevY: `CHF ${prevYear.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
      prevMChange: changeInfo(currentMonth.laborCost, prevMonth.laborCost),
      prevYChange: changeInfo(currentMonth.laborCost, prevYear.laborCost),
    },
    {
      label: 'PK-Quote',
      current: `${currentMonth.laborCostQuote.toFixed(1)}%`,
      prevM: `${prevMonth.laborCostQuote.toFixed(1)}%`,
      prevY: `${prevYear.laborCostQuote.toFixed(1)}%`,
      prevMChange: (() => { const d = currentMonth.laborCostQuote - prevMonth.laborCostQuote; return { text: `${d >= 0 ? '+' : ''}${d.toFixed(1)} PP`, color: d <= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger } as { text: string; color: [number, number, number] }; })(),
      prevYChange: (() => { const d = currentMonth.laborCostQuote - prevYear.laborCostQuote; return { text: `${d >= 0 ? '+' : ''}${d.toFixed(1)} PP`, color: d <= 0 ? OLIV_COLORS.success : OLIV_COLORS.danger } as { text: string; color: [number, number, number] }; })(),
    },
    {
      label: 'Stunden',
      current: `${currentMonth.hours.toFixed(1)} h`,
      prevM: `${prevMonth.hours.toFixed(1)} h`,
      prevY: `${prevYear.hours.toFixed(1)} h`,
      prevMChange: changeInfo(currentMonth.hours, prevMonth.hours),
      prevYChange: changeInfo(currentMonth.hours, prevYear.hours),
    },
  ];

  compRows.forEach((row, ri) => {
    const ry = compBoxY + rowH + ri * rowH + 1;
    if (ri % 2 === 1) {
      doc.setFillColor(...OLIV_COLORS.white);
      doc.rect(ml, ry - 1, cw, rowH, 'F');
    }

    // Label
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(row.label, colX[0], ry + 6);

    // Current value
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...OLIV_COLORS.charcoal);
    doc.text(row.current, colX[1], ry + 6);

    // Prev month: value + change
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.slate);
    doc.text(row.prevM, colX[2], ry + 4.5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...row.prevMChange.color);
    doc.text(`(${row.prevMChange.text})`, colX[2], ry + 9);

    // Prev year: value + change
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...OLIV_COLORS.slate);
    doc.text(row.prevY, colX[3], ry + 4.5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...row.prevYChange.color);
    doc.text(`(${row.prevYChange.text})`, colX[3], ry + 9);
  });

  // ── ABTEILUNGEN ─────────────────────────────────────────────────────
  const deptY = compBoxY + compBoxH + 8;
  sectionLabel('Abteilungen', deptY);

  // Split bar
  const barY = deptY + 3;
  const totalCost = departments.Service.laborCost + departments.Küche.laborCost;
  const servicePct = totalCost > 0 ? (departments.Service.laborCost / totalCost) * 100 : 50;
  const serviceBarW = cw * (servicePct / 100);

  doc.setFillColor(...OLIV_COLORS.sage);
  doc.roundedRect(ml, barY, serviceBarW, 7, 0, 0, 'F');
  doc.setFillColor(...OLIV_COLORS.charcoal);
  doc.roundedRect(ml + serviceBarW, barY, cw - serviceBarW, 7, 0, 0, 'F');

  doc.setFontSize(6.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...OLIV_COLORS.white);
  if (servicePct > 12) doc.text(`Service ${servicePct.toFixed(0)}%`, ml + 3, barY + 5);
  if ((100 - servicePct) > 12) doc.text(`Küche ${(100 - servicePct).toFixed(0)}%`, ml + cw - 3, barY + 5, { align: 'right' });

  autoTable(doc, {
    startY: barY + 10,
    margin: { left: ml, right: mr },
    head: [['Abteilung', 'MA', 'Plan Std', 'Ist Std', 'Kosten Ist', 'Anteil']],
    body: [
      [
        'Service',
        employees.filter(e => e.department === 'service').length.toString(),
        `${departments.Service.plannedHours.toFixed(1)} h`,
        `${departments.Service.actualHours.toFixed(1)} h`,
        `CHF ${departments.Service.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
        `${totalCost > 0 ? ((departments.Service.laborCost / totalCost) * 100).toFixed(0) : '—'}%`,
      ],
      [
        'Küche',
        employees.filter(e => e.department !== 'service').length.toString(),
        `${departments.Küche.plannedHours.toFixed(1)} h`,
        `${departments.Küche.actualHours.toFixed(1)} h`,
        `CHF ${departments.Küche.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
        `${totalCost > 0 ? ((departments.Küche.laborCost / totalCost) * 100).toFixed(0) : '—'}%`,
      ],
      [
        'GESAMT',
        employees.length.toString(),
        `${(departments.Service.plannedHours + departments.Küche.plannedHours).toFixed(1)} h`,
        `${currentMonth.hours.toFixed(1)} h`,
        `CHF ${currentMonth.laborCost.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`,
        '100%',
      ],
    ],
    theme: 'grid',
    headStyles: { fillColor: [40, 45, 42], fontSize: 7.5, cellPadding: 2.5, textColor: [255, 255, 255] },
    styles: { fontSize: 7.5, cellPadding: 2.5 },
    columnStyles: { 0: { fontStyle: 'bold' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: (data) => {
      if (data.row.index === 2 && data.section === 'body') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [235, 240, 236];
      }
    },
  });

  // ── FOOTER ──────────────────────────────────────────────────────────
  const pageH = 297;
  doc.setDrawColor(...OLIV_COLORS.sageLight);
  doc.setLineWidth(0.4);
  doc.line(ml, pageH - 14, 210 - mr, pageH - 14);

  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...OLIV_COLORS.silver);
  doc.text('oLÍV Restaurant & Bar', ml, pageH - 9);
  doc.text(
    `${periodLabel} | Erstellt: ${format(new Date(), 'dd.MM.yyyy HH:mm', { locale: de })}`,
    105, pageH - 9, { align: 'center' }
  );
  doc.text('Seite 1 von 1', 210 - mr, pageH - 9, { align: 'right' });

  // ── SAVE ────────────────────────────────────────────────────────────
  doc.save(`Dashboard_${format(selectedDate, 'yyyy-MM-dd', { locale: de })}.pdf`);
};
