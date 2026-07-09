import { useEffect, useMemo, useState } from 'react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget, grossToNet } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { useWeekSync } from '@/hooks/useWeekSync';
import { useEmployerRateMap } from '@/hooks/useEmployerRateMap';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { 
  Clock, TrendingUp, TrendingDown, 
  CalendarDays, Euro, Users, FileText, FileSpreadsheet, Calendar,
  ChevronDown, BarChart3, Percent, AlertTriangle, CheckCircle2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { kvGet } from '@/lib/supabase-kv';
import { computeMonthlyIstNet } from '@/lib/revenue-sync';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, 
  ReferenceLine, ComposedChart, Line, PieChart, Pie, Legend
} from 'recharts';
import { toast } from '@/hooks/use-toast';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

interface UnifiedDashboardProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
  showPlannedData?: boolean;
}

type ViewMode = 'day' | 'week' | 'month';

export const UnifiedDashboard = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  showNetRevenue = false,
  showPlannedData = true,
}: UnifiedDashboardProps) => {
  // Kosten = Total Arbeitgeberkosten (Bruttolohn + AG-Sozialkosten), nie roher hourlyWage.
  const { rateById } = useEmployerRateMap(employees);
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  
  // Helper to get display revenue
  const getDisplayRevenue = (grossRevenue: number, takeawayRevenue: number = 0) => {
    return showNetRevenue ? grossToNet(grossRevenue, takeawayRevenue) : grossRevenue;
  };
  
  const { tenantId, tenantKey } = useTenant();

  const { 
    currentWeekStart,
    currentMonthStart,
    weekNumber, 
    weekRange,
    monthLabel,
  } = useWeekSync('UnifiedDashboard', selectedDate);

  // ── Monatliches Take-Away (Kto. 3010 Netto) für Gesamt-Korrektur ──────────
  const [monthlyTakeaway, setMonthlyTakeaway] = useState(0);
  useEffect(() => {
    if (viewMode !== 'month') { setMonthlyTakeaway(0); return; }
    const yr = currentMonthStart.getFullYear();
    const mo = currentMonthStart.getMonth() + 1;
    const mm = String(mo).padStart(2, '0');
    kvGet(tenantKey(`takeaway-monthly-${yr}`)).then(raw => {
      const val = (raw as Record<string, number> | null)?.[`${yr}-${mm}`] ?? 0;
      setMonthlyTakeaway(val);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, currentMonthStart, tenantId]);

  // Calculate date ranges
  const dateRanges = useMemo(() => {
    const dayStart = selectedDate;
    const dayEnd = selectedDate;
    
    const weekStart = startOfWeek(currentWeekStart, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    
    const monthStart = startOfMonth(currentMonthStart);
    const monthEnd = endOfMonth(currentMonthStart);
    
    return { dayStart, dayEnd, weekStart, weekEnd, monthStart, monthEnd };
  }, [selectedDate, currentWeekStart, currentMonthStart]);

  // Get dates for current view
  const getDatesForView = () => {
    switch (viewMode) {
      case 'day':
        return { start: dateRanges.dayStart, end: dateRanges.dayEnd };
      case 'week':
        return { start: dateRanges.weekStart, end: dateRanges.weekEnd };
      case 'month':
        return { start: dateRanges.monthStart, end: dateRanges.monthEnd };
    }
  };

  // Calculate all data for current view
  const dashboardData = useMemo(() => {
    const { start, end } = getDatesForView();
    const allDays = eachDayOfInterval({ start, end });
    const allDayStrings = allDays.map(d => format(d, 'yyyy-MM-dd'));

    // Revenue data
    let totalPlannedRevenue = 0;
    let totalActualRevenue = 0;
    
    allDayStrings.forEach(dateStr => {
      const budget = dailyBudgets[dateStr];
      if (budget) {
        totalPlannedRevenue += getDisplayRevenue(budget.plannedRevenue || 0, 0);
        totalActualRevenue += getDisplayRevenue(budget.actualRevenue || 0, budget.takeawayRevenue || 0);
      }
    });

    // Monatliches Take-Away Korrektur (Kto. 3010 Netto)
    // Identisch zur Logik in TagesControllingPage / TagesansichtPage.
    if (showNetRevenue && viewMode === 'month' && monthlyTakeaway > 0) {
      const yr = currentMonthStart.getFullYear();
      const mo = currentMonthStart.getMonth() + 1;
      const corrected = computeMonthlyIstNet(yr, mo, dailyBudgets as Record<string, { actualRevenue?: number; takeawayRevenue?: number }>, undefined, undefined, monthlyTakeaway);
      if (corrected > 0) totalActualRevenue = corrected;
    }

    // Employee data by department
    const serviceEmployees = employees.filter(e => e.department === 'service');
    const kitchenEmployees = employees.filter(e => e.department === 'küche');

    // Calculate hours and costs
    const calculateEmployeeData = (emp: Employee) => {
      const entries = timeEntries.filter(
        te => te.employeeId === emp.id && allDayStrings.includes(te.date)
      );
      
      const plannedHours = entries.reduce((sum, e) => sum + (e.plannedHours || 0), 0);
      const actualHours = entries.reduce((sum, e) => sum + (e.actualHours || 0), 0);
      const rate = rateById.get(emp.id) ?? 0;
      const plannedCost = plannedHours * rate;
      const actualCost = actualHours * rate;
      
      const weeklyHours = emp.weeklyHours || 42;
      const expectedHours = viewMode === 'day' 
        ? weeklyHours / 5 
        : viewMode === 'week' 
          ? weeklyHours 
          : weeklyHours * 4.33;
      
      const overtimeHours = actualHours - expectedHours;
      const daysWorked = entries.filter(e => (e.actualHours || 0) > 0).length;

      return {
        employee: emp,
        expectedHours,
        plannedHours,
        actualHours,
        plannedCost,
        actualCost,
        overtimeHours,
        daysWorked,
      };
    };

    const employeeDataList = employees
      .filter(emp => emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
      .map(calculateEmployeeData)
      .sort((a, b) => b.overtimeHours - a.overtimeHours);

    const serviceData = serviceEmployees.map(calculateEmployeeData);
    const kitchenData = kitchenEmployees.map(calculateEmployeeData);

    // Totals
    const totals = employeeDataList.reduce(
      (acc, d) => ({
        expectedHours: acc.expectedHours + d.expectedHours,
        plannedHours: acc.plannedHours + d.plannedHours,
        actualHours: acc.actualHours + d.actualHours,
        plannedCost: acc.plannedCost + d.plannedCost,
        actualCost: acc.actualCost + d.actualCost,
        overtimeHours: acc.overtimeHours + d.overtimeHours,
      }),
      { expectedHours: 0, plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0, overtimeHours: 0 }
    );

    const serviceTotals = serviceData.reduce(
      (acc, d) => ({
        plannedHours: acc.plannedHours + d.plannedHours,
        actualHours: acc.actualHours + d.actualHours,
        plannedCost: acc.plannedCost + d.plannedCost,
        actualCost: acc.actualCost + d.actualCost,
      }),
      { plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0 }
    );

    const kitchenTotals = kitchenData.reduce(
      (acc, d) => ({
        plannedHours: acc.plannedHours + d.plannedHours,
        actualHours: acc.actualHours + d.actualHours,
        plannedCost: acc.plannedCost + d.plannedCost,
        actualCost: acc.actualCost + d.actualCost,
      }),
      { plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0 }
    );

    // Labor cost quote
    const laborQuote = totalActualRevenue > 0 
      ? (totals.actualCost / totalActualRevenue) * 100 
      : 0;

    const plannedQuote = totalPlannedRevenue > 0
      ? (totals.plannedCost / totalPlannedRevenue) * 100
      : 0;

    // Daily breakdown for charts
    const dailyBreakdown = allDays.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayEntries = timeEntries.filter(e => e.date === dateStr);
      const budget = dailyBudgets[dateStr];
      
      let plannedCost = 0, actualCost = 0, plannedHours = 0, actualHours = 0;
      
      dayEntries.forEach(entry => {
        const emp = employees.find(e => e.id === entry.employeeId);
        if (!emp) return;
        
        const rate = rateById.get(emp.id) ?? 0;
        plannedHours += entry.plannedHours || 0;
        actualHours += entry.actualHours || 0;
        plannedCost += (entry.plannedHours || 0) * rate;
        actualCost += (entry.actualHours || 0) * rate;
      });
      
      const actualRevenue = getDisplayRevenue(budget?.actualRevenue || 0, budget?.takeawayRevenue || 0);
      const dayQuote = actualRevenue > 0 
        ? (actualCost / actualRevenue) * 100 
        : 0;
      
      return {
        date: dateStr,
        dayName: format(day, 'EEE', { locale: de }),
        dayLabel: format(day, 'd.M.', { locale: de }),
        plannedCost,
        actualCost,
        plannedRevenue: getDisplayRevenue(budget?.plannedRevenue || 0, 0),
        actualRevenue,
        plannedHours,
        actualHours,
        laborQuote: dayQuote,
      };
    });

    return {
      totalPlannedRevenue,
      totalActualRevenue,
      employeeDataList,
      serviceData,
      kitchenData,
      totals,
      serviceTotals,
      kitchenTotals,
      laborQuote,
      plannedQuote,
      dailyBreakdown,
    };
  }, [employees, timeEntries, dailyBudgets, viewMode, dateRanges, showNetRevenue, monthlyTakeaway, currentMonthStart, rateById]);

  const getPeriodLabel = () => {
    switch (viewMode) {
      case 'day':
        return format(selectedDate, 'EEEE, d. MMMM', { locale: de });
      case 'week':
        return `KW ${weekNumber} (${weekRange})`;
      case 'month':
        return monthLabel;
    }
  };

  // Status evaluation
  const getQuoteStatus = (quote: number) => {
    if (quote <= 25) return { label: 'Exzellent', color: 'text-green-600', bg: 'bg-green-100' };
    if (quote <= 30) return { label: 'Gut', color: 'text-blue-600', bg: 'bg-blue-100' };
    if (quote <= 35) return { label: 'Akzeptabel', color: 'text-amber-600', bg: 'bg-amber-100' };
    return { label: 'Kritisch', color: 'text-destructive', bg: 'bg-red-100' };
  };

  const quoteStatus = getQuoteStatus(dashboardData.laborQuote);

  // Export functions
  const exportToPDF = () => {
    const doc = new jsPDF();
    const periodLabel = getPeriodLabel();
    
    doc.setFontSize(18);
    doc.text('Zentrale Übersicht', 14, 20);
    doc.setFontSize(11);
    doc.text(periodLabel, 14, 28);
    
    // KPI Summary
    doc.setFontSize(12);
    doc.text('Kennzahlen', 14, 40);
    
    const kpiData = [
      ['Umsatz Plan', formatCurrency(dashboardData.totalPlannedRevenue)],
      ['Umsatz Ist', formatCurrency(dashboardData.totalActualRevenue)],
      ['Personalkosten Plan', formatCurrency(dashboardData.totals.plannedCost)],
      ['Personalkosten Ist', formatCurrency(dashboardData.totals.actualCost)],
      ['Personalkostenquote', `${dashboardData.laborQuote.toFixed(1)}%`],
      ['Status', quoteStatus.label],
    ];
    
    autoTable(doc, {
      startY: 45,
      head: [['Kennzahl', 'Wert']],
      body: kpiData,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: { 1: { halign: 'right' } },
    });
    
    // Employee table
    const empData = dashboardData.employeeDataList.map(d => [
      d.employee.name,
      d.employee.department === 'service' ? 'Service' : 'Küche',
      formatHours(d.plannedHours),
      d.actualHours > 0 ? formatHours(d.actualHours) : '-',
      formatCurrency(d.actualCost),
      `${d.overtimeHours > 0 ? '+' : ''}${formatHours(d.overtimeHours)}`,
    ]);
    
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 10,
      head: [['Mitarbeiter', 'Abteilung', 'Plan Std.', 'Ist Std.', 'Kosten', 'Überstd.']],
      body: empData,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
    });
    
    doc.save(`Uebersicht_${format(selectedDate, 'yyyy-MM-dd')}.pdf`);
    toast({ title: 'PDF exportiert' });
  };

  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Übersicht');
    
    sheet.mergeCells('A1:F1');
    sheet.getCell('A1').value = `Zentrale Übersicht - ${getPeriodLabel()}`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    
    // KPIs
    sheet.getCell('A3').value = 'Kennzahlen';
    sheet.getCell('A3').font = { bold: true };
    
    sheet.getCell('A4').value = 'Umsatz Plan:';
    sheet.getCell('B4').value = dashboardData.totalPlannedRevenue;
    sheet.getCell('B4').numFmt = '"CHF" #,##0.00';
    
    sheet.getCell('A5').value = 'Umsatz Ist:';
    sheet.getCell('B5').value = dashboardData.totalActualRevenue;
    sheet.getCell('B5').numFmt = '"CHF" #,##0.00';
    
    sheet.getCell('A6').value = 'Personalkosten:';
    sheet.getCell('B6').value = dashboardData.totals.actualCost;
    sheet.getCell('B6').numFmt = '"CHF" #,##0.00';
    
    sheet.getCell('A7').value = 'PKQ:';
    sheet.getCell('B7').value = dashboardData.laborQuote / 100;
    sheet.getCell('B7').numFmt = '0.0%';
    
    // Headers
    const headerRow = sheet.getRow(9);
    headerRow.values = ['Mitarbeiter', 'Abteilung', 'Plan Std.', 'Ist Std.', 'Kosten', 'Überstunden'];
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    
    dashboardData.employeeDataList.forEach((d, i) => {
      const row = sheet.getRow(10 + i);
      row.values = [
        d.employee.name,
        d.employee.department === 'service' ? 'Service' : 'Küche',
        d.plannedHours,
        d.actualHours,
        d.actualCost,
        d.overtimeHours,
      ];
      row.getCell(5).numFmt = '"CHF" #,##0.00';
    });
    
    sheet.columns = [{ width: 20 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 }];
    
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Uebersicht_${format(selectedDate, 'yyyy-MM-dd')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({ title: 'Excel exportiert' });
  };

  // Department pie data
  const departmentPieData = [
    { name: 'Service', value: dashboardData.serviceTotals.actualCost, fill: 'hsl(var(--primary))' },
    { name: 'Küche', value: dashboardData.kitchenTotals.actualCost, fill: 'hsl(var(--muted-foreground))' },
  ];

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3">
          {/* Title and Export */}
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <BarChart3 className="h-5 w-5 text-primary" />
              Zentrale Übersicht
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exportToPDF}>
                <FileText className="h-4 w-4" />
                <span className="hidden sm:inline">PDF</span>
              </Button>
              <Button variant="outline" size="sm" className="h-8 gap-1" onClick={exportToExcel}>
                <FileSpreadsheet className="h-4 w-4" />
                <span className="hidden sm:inline">Excel</span>
              </Button>
            </div>
          </div>
          
          {/* View Mode and Period Display */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)} className="w-auto">
              <TabsList className="h-9">
                <TabsTrigger value="day" className="gap-1 text-xs sm:text-sm">
                  <Calendar className="h-3.5 w-3.5" />
                  Tag
                </TabsTrigger>
                <TabsTrigger value="week" className="gap-1 text-xs sm:text-sm">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Woche
                </TabsTrigger>
                <TabsTrigger value="month" className="gap-1 text-xs sm:text-sm">
                  <CalendarDays className="h-3.5 w-3.5" />
                  Monat
                </TabsTrigger>
              </TabsList>
            </Tabs>
            
            <Badge variant="secondary" className="px-3 py-1.5 font-medium text-xs sm:text-sm">
              <CalendarDays className="h-3.5 w-3.5 mr-1.5" />
              {getPeriodLabel()}
            </Badge>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-6">
        {/* Main KPI Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Revenue */}
          <div className="p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
              <Euro className="h-4 w-4" />
              Umsatz
            </div>
            <p className="text-2xl font-bold">{formatCurrency(dashboardData.totalActualRevenue)}</p>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs text-muted-foreground">Plan:</span>
              <span className="text-xs font-medium">{formatCurrency(dashboardData.totalPlannedRevenue)}</span>
              {dashboardData.totalActualRevenue >= dashboardData.totalPlannedRevenue ? (
                <TrendingUp className="h-3 w-3 text-green-600" />
              ) : (
                <TrendingDown className="h-3 w-3 text-destructive" />
              )}
            </div>
          </div>
          
          {/* Personnel Costs */}
          <div className="p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
              <Users className="h-4 w-4" />
              Personalkosten
            </div>
            <p className="text-2xl font-bold">{formatCurrency(dashboardData.totals.actualCost)}</p>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs text-muted-foreground">Plan:</span>
              <span className="text-xs font-medium">{formatCurrency(dashboardData.totals.plannedCost)}</span>
            </div>
          </div>
          
          {/* Hours */}
          <div className="p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
              <Clock className="h-4 w-4" />
              Stunden
            </div>
            <p className="text-2xl font-bold">{formatHours(dashboardData.totals.actualHours)}</p>
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs text-muted-foreground">Plan:</span>
              <span className="text-xs font-medium">{formatHours(dashboardData.totals.plannedHours)}</span>
            </div>
          </div>
          
          {/* Labor Quote */}
          <div className={cn("p-4 rounded-lg border", quoteStatus.bg)}>
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2">
              <Percent className="h-4 w-4" />
              PKQ
            </div>
            <p className={cn("text-2xl font-bold", quoteStatus.color)}>
              {dashboardData.laborQuote.toFixed(1)}%
            </p>
            <div className="flex items-center gap-1 mt-1">
              <Badge variant="outline" className={cn("text-xs", quoteStatus.color)}>
                {quoteStatus.label}
              </Badge>
            </div>
          </div>
        </div>

        {/* Department Comparison */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Service */}
          <div className="p-4 bg-primary/5 rounded-lg border border-primary/20">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                Service
              </h4>
              <Badge variant="secondary">{dashboardData.serviceData.length} MA</Badge>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stunden:</span>
                <span className="font-mono">{formatHours(dashboardData.serviceTotals.actualHours)} / {formatHours(dashboardData.serviceTotals.plannedHours)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kosten:</span>
                <span className="font-mono font-medium">{formatCurrency(dashboardData.serviceTotals.actualCost)}</span>
              </div>
              <Progress 
                value={dashboardData.serviceTotals.plannedHours > 0 ? (dashboardData.serviceTotals.actualHours / dashboardData.serviceTotals.plannedHours) * 100 : 0} 
                className="h-2"
              />
            </div>
          </div>
          
          {/* Kitchen */}
          <div className="p-4 bg-muted/30 rounded-lg border">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium flex items-center gap-2">
                <Users className="h-4 w-4" />
                Küche
              </h4>
              <Badge variant="secondary">{dashboardData.kitchenData.length} MA</Badge>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stunden:</span>
                <span className="font-mono">{formatHours(dashboardData.kitchenTotals.actualHours)} / {formatHours(dashboardData.kitchenTotals.plannedHours)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Kosten:</span>
                <span className="font-mono font-medium">{formatCurrency(dashboardData.kitchenTotals.actualCost)}</span>
              </div>
              <Progress 
                value={dashboardData.kitchenTotals.plannedHours > 0 ? (dashboardData.kitchenTotals.actualHours / dashboardData.kitchenTotals.plannedHours) * 100 : 0} 
                className="h-2"
              />
            </div>
          </div>
        </div>

        {/* Trend Chart - Week/Month only */}
        {viewMode !== 'day' && dashboardData.dailyBreakdown.length > 1 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">Tagesverlauf</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dashboardData.dailyBreakdown} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <XAxis dataKey="dayLabel" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="cost" tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="quote" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10 }} domain={[0, 50]} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-popover border border-border rounded-lg shadow-lg p-3 text-xs">
                            <p className="font-medium mb-1">{data.dayName}, {data.dayLabel}</p>
                            <p>Umsatz: {formatCurrency(data.actualRevenue)}</p>
                            <p>Kosten Plan: {formatCurrency(data.plannedCost)}</p>
                            <p>Kosten Ist: {formatCurrency(data.actualCost)}</p>
                            <p className={cn(data.laborQuote > 35 ? 'text-destructive' : 'text-green-600')}>
                              PKQ: {data.laborQuote.toFixed(1)}%
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar yAxisId="cost" dataKey="plannedCost" fill="hsl(var(--muted-foreground))" opacity={0.3} name="Plan" />
                  <Bar yAxisId="cost" dataKey="actualCost" fill="hsl(var(--primary))" name="Ist" />
                  <Line yAxisId="quote" type="monotone" dataKey="laborQuote" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 3 }} name="PKQ" />
                  <ReferenceLine yAxisId="quote" y={30} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Employee Overview - Collapsible */}
        <Collapsible defaultOpen={false}>
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg cursor-pointer group hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <h4 className="text-sm font-medium">Mitarbeiter-Details</h4>
                <Badge variant="outline" className="text-xs">
                  {dashboardData.employeeDataList.length} Mitarbeiter
                </Badge>
              </div>
              <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-3 animate-fade-in">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 px-2 font-medium">Mitarbeiter</th>
                      <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Abteilung</th>
                      <th className="text-right py-2 px-2 font-medium">Plan</th>
                      <th className="text-right py-2 px-2 font-medium">Ist</th>
                      <th className="text-right py-2 px-2 font-medium hidden md:table-cell">Kosten</th>
                      <th className="text-right py-2 px-2 font-medium">+/-</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboardData.employeeDataList.map((data) => (
                      <tr key={data.employee.id} className="border-b border-border/50">
                        <td className="py-2 px-2 font-medium">{data.employee.name}</td>
                        <td className="py-2 px-2 capitalize text-muted-foreground hidden sm:table-cell">{data.employee.department}</td>
                        <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(data.plannedHours)}</td>
                        <td className="text-right py-2 px-2 font-mono text-xs">{data.actualHours > 0 ? formatHours(data.actualHours) : '-'}</td>
                        <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{formatCurrency(data.actualCost)}</td>
                        <td className={cn(
                          "text-right py-2 px-2 font-mono text-xs",
                          data.overtimeHours > 0 ? 'text-destructive' : data.overtimeHours < 0 ? 'text-green-600' : 'text-muted-foreground'
                        )}>
                          {data.overtimeHours > 0 ? '+' : ''}{formatHours(data.overtimeHours)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {dashboardData.employeeDataList.length > 0 && (
                    <tfoot>
                      <tr className="font-semibold bg-muted/50">
                        <td className="py-2 px-2" colSpan={2}>Gesamt</td>
                        <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(dashboardData.totals.plannedHours)}</td>
                        <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(dashboardData.totals.actualHours)}</td>
                        <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{formatCurrency(dashboardData.totals.actualCost)}</td>
                        <td className={cn(
                          "text-right py-2 px-2 font-mono text-xs",
                          dashboardData.totals.overtimeHours > 0 ? 'text-destructive' : 'text-green-600'
                        )}>
                          {dashboardData.totals.overtimeHours > 0 ? '+' : ''}{formatHours(dashboardData.totals.overtimeHours)}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Overtime Chart - Collapsible */}
        {dashboardData.employeeDataList.length > 0 && (
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="w-full">
              <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg cursor-pointer group hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-medium">Überstunden-Verteilung</h4>
                  <Badge variant="outline" className="text-xs">
                    {dashboardData.employeeDataList.filter(e => e.overtimeHours > 0).length} mit Überstunden
                  </Badge>
                </div>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-3 space-y-3 animate-fade-in">
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={dashboardData.employeeDataList.map(d => ({
                        name: d.employee.name.split(' ')[0],
                        fullName: d.employee.name,
                        overtime: d.overtimeHours,
                        department: d.employee.department,
                      }))}
                      layout="vertical"
                      margin={{ top: 5, right: 30, left: 60, bottom: 5 }}
                    >
                      <XAxis 
                        type="number" 
                        tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}h`}
                        domain={['dataMin', 'dataMax']}
                        tick={{ fontSize: 10 }}
                      />
                      <YAxis type="category" dataKey="name" width={55} tick={{ fontSize: 10 }} />
                      <Tooltip 
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload;
                            return (
                              <div className="bg-popover border border-border rounded-lg shadow-lg p-2 text-xs">
                                <p className="font-medium">{data.fullName}</p>
                                <p className="text-muted-foreground capitalize">{data.department}</p>
                                <p className={cn("font-mono", data.overtime > 0 ? 'text-destructive' : 'text-green-600')}>
                                  {data.overtime > 0 ? '+' : ''}{formatHours(data.overtime)}
                                </p>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <ReferenceLine x={0} stroke="hsl(var(--border))" strokeWidth={2} />
                      <Bar dataKey="overtime" radius={[0, 4, 4, 0]}>
                        {dashboardData.employeeDataList.map((entry, index) => (
                          <Cell 
                            key={`cell-${index}`}
                            fill={entry.overtimeHours > 0 ? 'hsl(var(--destructive))' : entry.overtimeHours < 0 ? 'hsl(142 76% 36%)' : 'hsl(var(--muted-foreground))'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex items-center justify-center gap-4 text-xs">
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded bg-destructive" />
                    <span>Überstunden</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded bg-green-600" />
                    <span>Minusstunden</span>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
};
