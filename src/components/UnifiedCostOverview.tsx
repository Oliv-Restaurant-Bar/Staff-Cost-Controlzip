import { useMemo, useState } from 'react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { useWeekSync } from '@/hooks/useWeekSync';
import { useTenant } from '@/contexts/TenantContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { 
  ChevronLeft, ChevronRight, Clock, TrendingUp, TrendingDown, Minus, 
  CalendarDays, Euro, Users, FileText, FileSpreadsheet, Calendar, ChevronDown, BarChart3
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getMonthlyBudgetPersonnel, getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, ComposedChart, Line, Area } from 'recharts';
import { toast } from '@/hooks/use-toast';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

interface UnifiedCostOverviewProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

type ViewMode = 'day' | 'week' | 'month';

interface EmployeeData {
  employee: Employee;
  expectedHours: number;
  plannedHours: number;
  actualHours: number;
  plannedCost: number;
  actualCost: number;
  overtimeHours: number;
  overtimeCost: number;
  daysWorked: number;
}

interface DailyCostData {
  date: string;
  dayName: string;
  plannedCost: number;
  actualCost: number;
  plannedRevenue: number;
  actualRevenue: number;
  plannedHours: number;
  actualHours: number;
  laborQuote: number;
}

export const UnifiedCostOverview = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
}: UnifiedCostOverviewProps) => {
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const { tenantKey } = useTenant();
  
  const { 
    currentWeekStart,
    currentMonthStart,
    weekNumber, 
    weekRange,
    monthLabel,
    navigateWeek,
    navigateMonth,
    setWeek,
  } = useWeekSync('UnifiedCostOverview', selectedDate);

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

  // Calculate employee data for current view
  const employeeData = useMemo(() => {
    let startDate: Date, endDate: Date;
    
    switch (viewMode) {
      case 'day':
        startDate = dateRanges.dayStart;
        endDate = dateRanges.dayEnd;
        break;
      case 'week':
        startDate = dateRanges.weekStart;
        endDate = dateRanges.weekEnd;
        break;
      case 'month':
        startDate = dateRanges.monthStart;
        endDate = dateRanges.monthEnd;
        break;
    }
    
    const allDays = eachDayOfInterval({ start: startDate, end: endDate });
    const allDayStrings = allDays.map(d => format(d, 'yyyy-MM-dd'));
    const workingDaysInPeriod = viewMode === 'day' ? 1 : viewMode === 'week' ? 5 : 4.33 * 5;

    const data: EmployeeData[] = employees
      .filter(emp => emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit')
      .map(employee => {
        const employeeEntries = timeEntries.filter(
          te => te.employeeId === employee.id && allDayStrings.includes(te.date)
        );

        const plannedHours = employeeEntries.reduce((sum, e) => sum + (e.plannedHours || 0), 0);
        const actualHours = employeeEntries.reduce((sum, e) => sum + (e.actualHours || 0), 0);
        
        const plannedCost = plannedHours * employee.hourlyWage;
        const actualCost = actualHours * employee.hourlyWage;

        const weeklyHours = employee.weeklyHours || 42;
        const expectedHours = viewMode === 'day' 
          ? weeklyHours / 5 
          : viewMode === 'week' 
            ? weeklyHours 
            : weeklyHours * 4.33;

        const overtimeHours = actualHours - expectedHours;
        const overtimeCost = overtimeHours * employee.hourlyWage;
        const daysWorked = employeeEntries.filter(e => (e.actualHours || 0) > 0).length;

        return {
          employee,
          expectedHours,
          plannedHours,
          actualHours,
          plannedCost,
          actualCost,
          overtimeHours,
          overtimeCost,
          daysWorked,
        };
      })
      .sort((a, b) => b.overtimeHours - a.overtimeHours);

    return data;
  }, [employees, timeEntries, viewMode, dateRanges]);

  // Calculate daily breakdown for charts
  const dailyBreakdown = useMemo(() => {
    let startDate: Date, endDate: Date;
    
    switch (viewMode) {
      case 'day':
        startDate = dateRanges.dayStart;
        endDate = dateRanges.dayEnd;
        break;
      case 'week':
        startDate = dateRanges.weekStart;
        endDate = dateRanges.weekEnd;
        break;
      case 'month':
        startDate = dateRanges.monthStart;
        endDate = dateRanges.monthEnd;
        break;
    }
    
    const allDays = eachDayOfInterval({ start: startDate, end: endDate });
    
    return allDays.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayEntries = timeEntries.filter(e => e.date === dateStr);
      const budget = dailyBudgets[dateStr];
      
      let plannedCost = 0, actualCost = 0, plannedHours = 0, actualHours = 0;
      
      dayEntries.forEach(entry => {
        const emp = employees.find(e => e.id === entry.employeeId);
        if (!emp) return;
        
        plannedHours += entry.plannedHours || 0;
        actualHours += entry.actualHours || 0;
        plannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
        actualCost += (entry.actualHours || 0) * emp.hourlyWage;
      });
      
      const laborQuote = (budget?.actualRevenue || 0) > 0 
        ? (actualCost / budget.actualRevenue) * 100 
        : 0;
      
      return {
        date: dateStr,
        dayName: format(day, 'EEE', { locale: de }),
        dayLabel: format(day, 'd.', { locale: de }),
        plannedCost,
        actualCost,
        plannedRevenue: budget?.plannedRevenue || 0,
        actualRevenue: budget?.actualRevenue || 0,
        plannedHours,
        actualHours,
        laborQuote,
      };
    });
  }, [timeEntries, dailyBudgets, employees, viewMode, dateRanges]);

  // Calculate totals
  const totals = useMemo(() => {
    const empTotals = employeeData.reduce(
      (acc, data) => ({
        expectedHours: acc.expectedHours + data.expectedHours,
        plannedHours: acc.plannedHours + data.plannedHours,
        actualHours: acc.actualHours + data.actualHours,
        plannedCost: acc.plannedCost + data.plannedCost,
        actualCost: acc.actualCost + data.actualCost,
        overtimeHours: acc.overtimeHours + data.overtimeHours,
        overtimeCost: acc.overtimeCost + data.overtimeCost,
      }),
      { expectedHours: 0, plannedHours: 0, actualHours: 0, plannedCost: 0, actualCost: 0, overtimeHours: 0, overtimeCost: 0 }
    );
    
    const revTotals = dailyBreakdown.reduce(
      (acc, day) => ({
        plannedRevenue: acc.plannedRevenue + day.plannedRevenue,
        actualRevenue: acc.actualRevenue + day.actualRevenue,
      }),
      { plannedRevenue: 0, actualRevenue: 0 }
    );
    
    const laborQuote = revTotals.actualRevenue > 0 
      ? (empTotals.actualCost / revTotals.actualRevenue) * 100 
      : 0;
    
    return { ...empTotals, ...revTotals, laborQuote };
  }, [employeeData, dailyBreakdown]);

  // Navigation handlers
  const handleNavigate = (direction: 'prev' | 'next') => {
    if (viewMode === 'day') {
      const newDate = new Date(selectedDate);
      newDate.setDate(newDate.getDate() + (direction === 'prev' ? -1 : 1));
      setWeek(newDate);
    } else if (viewMode === 'week') {
      navigateWeek(direction);
    } else {
      navigateMonth(direction);
    }
  };

  const getPeriodLabel = () => {
    switch (viewMode) {
      case 'day':
        return format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de });
      case 'week':
        return `KW ${weekNumber} (${weekRange})`;
      case 'month':
        return monthLabel;
    }
  };

  // Export functions
  const exportToPDF = () => {
    const doc = new jsPDF();
    const periodLabel = getPeriodLabel();
    const viewLabel = viewMode === 'day' ? 'Tagesübersicht' : viewMode === 'week' ? 'Wochenübersicht' : 'Monatsübersicht';
    
    doc.setFontSize(16);
    doc.text(`Kostenübersicht - ${viewLabel}`, 14, 20);
    doc.setFontSize(11);
    doc.text(periodLabel, 14, 28);
    
    // Summary
    doc.setFontSize(10);
    doc.text(`Soll-Stunden: ${formatHours(totals.expectedHours)}`, 14, 40);
    doc.text(`Plan-Stunden: ${formatHours(totals.plannedHours)}`, 70, 40);
    doc.text(`Ist-Stunden: ${formatHours(totals.actualHours)}`, 126, 40);
    doc.text(`Plan-Kosten: ${formatCurrency(totals.plannedCost)}`, 14, 48);
    doc.text(`Ist-Kosten: ${formatCurrency(totals.actualCost)}`, 70, 48);
    doc.text(`Personalkostenquote: ${totals.laborQuote.toFixed(1)}%`, 126, 48);
    
    // Employee table
    const tableData = employeeData.map(d => [
      d.employee.name,
      d.employee.department === 'service' ? 'Service' : 'Küche',
      formatHours(d.expectedHours),
      formatHours(d.plannedHours),
      d.actualHours > 0 ? formatHours(d.actualHours) : '-',
      formatCurrency(d.plannedCost),
      d.actualCost > 0 ? formatCurrency(d.actualCost) : '-',
      `${d.overtimeHours > 0 ? '+' : ''}${formatHours(d.overtimeHours)}`,
    ]);
    
    tableData.push([
      'Gesamt', '',
      formatHours(totals.expectedHours),
      formatHours(totals.plannedHours),
      formatHours(totals.actualHours),
      formatCurrency(totals.plannedCost),
      formatCurrency(totals.actualCost),
      `${totals.overtimeHours > 0 ? '+' : ''}${formatHours(totals.overtimeHours)}`,
    ]);
    
    autoTable(doc, {
      startY: 55,
      head: [['Mitarbeiter', 'Abteilung', 'Soll', 'Plan', 'Ist', 'Plan-Kosten', 'Ist-Kosten', 'Überstd.']],
      body: tableData,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [59, 130, 246] },
    });
    
    const filename = `Kostenuebersicht_${viewMode}_${format(selectedDate, 'yyyy-MM-dd')}.pdf`;
    doc.save(filename);
    toast({ title: 'PDF exportiert', description: `${viewLabel} als PDF gespeichert` });
  };

  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const viewLabel = viewMode === 'day' ? 'Tag' : viewMode === 'week' ? `KW${weekNumber}` : monthLabel;
    const sheet = workbook.addWorksheet(viewLabel);
    
    // Title
    sheet.mergeCells('A1:H1');
    sheet.getCell('A1').value = `Kostenübersicht - ${getPeriodLabel()}`;
    sheet.getCell('A1').font = { bold: true, size: 14 };
    
    // Summary
    sheet.getCell('A3').value = 'Zusammenfassung';
    sheet.getCell('A3').font = { bold: true };
    
    sheet.getCell('A4').value = 'Soll-Stunden:';
    sheet.getCell('B4').value = totals.expectedHours;
    sheet.getCell('C4').value = 'Plan-Stunden:';
    sheet.getCell('D4').value = totals.plannedHours;
    sheet.getCell('E4').value = 'Ist-Stunden:';
    sheet.getCell('F4').value = totals.actualHours;
    
    sheet.getCell('A5').value = 'Plan-Kosten:';
    sheet.getCell('B5').value = totals.plannedCost;
    sheet.getCell('B5').numFmt = '"CHF" #,##0.00';
    sheet.getCell('C5').value = 'Ist-Kosten:';
    sheet.getCell('D5').value = totals.actualCost;
    sheet.getCell('D5').numFmt = '"CHF" #,##0.00';
    sheet.getCell('E5').value = 'Quote:';
    sheet.getCell('F5').value = totals.laborQuote / 100;
    sheet.getCell('F5').numFmt = '0.0%';
    
    // Headers
    const headerRow = sheet.getRow(7);
    headerRow.values = ['Mitarbeiter', 'Abteilung', 'Soll-Std.', 'Plan-Std.', 'Ist-Std.', 'Plan-Kosten', 'Ist-Kosten', 'Überstunden'];
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    });
    
    // Data
    employeeData.forEach((d, i) => {
      const row = sheet.getRow(8 + i);
      row.values = [
        d.employee.name,
        d.employee.department === 'service' ? 'Service' : 'Küche',
        d.expectedHours, d.plannedHours, d.actualHours || 0,
        d.plannedCost, d.actualCost || 0, d.overtimeHours,
      ];
      row.getCell(6).numFmt = '"CHF" #,##0.00';
      row.getCell(7).numFmt = '"CHF" #,##0.00';
      row.getCell(8).numFmt = '+0.00;-0.00;0.00';
    });
    
    // Totals
    const totalsRow = sheet.getRow(8 + employeeData.length);
    totalsRow.values = ['Gesamt', '', totals.expectedHours, totals.plannedHours, totals.actualHours, totals.plannedCost, totals.actualCost, totals.overtimeHours];
    totalsRow.font = { bold: true };
    
    sheet.columns = [{ width: 20 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }];
    
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Kostenuebersicht_${viewMode}_${format(selectedDate, 'yyyy-MM-dd')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({ title: 'Excel exportiert', description: `Kostenübersicht als Excel gespeichert` });
  };

  const getOvertimeColor = (hours: number) => {
    if (hours > 0) return 'text-destructive';
    if (hours < 0) return 'text-green-600';
    return 'text-muted-foreground';
  };

  // HINWEIS (Etappe 2b): Diese Komponente wird aktuell NIRGENDS gerendert
  // (kein Import im aktiven src/-Baum). Zielquote LIVE aus dem Budget-Modul
  // (PK-Budget ÷ Umsatz-Budget des Monats, Default-Store 'budget_v1') — KEIN
  // fixes 35.5 % mehr. Fehlt ein Budget → nur die harte Obergrenze (40 %).
  // Eine vollständige Umstellung auf ladePersonalkostenDaten/personalkosten
  // (AG-Total-Kostenbasis, Netto-Umsatz-Nenner, Tenant-Async-Load) bleibt
  // zurückgestellt, solange die Komponente nicht eingebunden ist.
  const TARGET_QUOTE_PCT = useMemo(() => {
    const y = selectedDate.getFullYear();
    const mi = selectedDate.getMonth();
    const storeKey = tenantKey('budget_v1');
    const pk = getMonthlyBudgetPersonnel(y, mi, storeKey)?.total ?? null;
    const rev = getMonthlyBudgetRevenue(y, mi, storeKey);
    return pk != null && rev > 0 ? (pk / rev) * 100 : 40;
  }, [selectedDate, tenantKey]);
  const getQuoteColor = (quote: number) => {
    if (quote > TARGET_QUOTE_PCT) return 'text-destructive';
    if (quote > TARGET_QUOTE_PCT - 5) return 'text-amber-500';
    return 'text-green-600';
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3">
          {/* Title and Export */}
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Euro className="h-5 w-5" />
              Kostenübersicht
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
          
          {/* View Mode Tabs and Navigation */}
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
            
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handleNavigate('prev')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Badge variant="secondary" className="px-3 py-1 font-normal text-xs sm:text-sm">
                {getPeriodLabel()}
              </Badge>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handleNavigate('next')}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-1 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3" />
              Soll-Stunden
            </div>
            <p className="text-lg font-bold">{formatHours(totals.expectedHours)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-1 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3" />
              Plan-Stunden
            </div>
            <p className="text-lg font-bold">{formatHours(totals.plannedHours)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-1 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3" />
              Ist-Stunden
            </div>
            <p className="text-lg font-bold">{formatHours(totals.actualHours)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-1 text-muted-foreground text-xs mb-1">
              <Euro className="h-3 w-3" />
              Plan-Kosten
            </div>
            <p className="text-lg font-bold">{formatCurrency(totals.plannedCost)}</p>
          </div>
          <div className="p-3 bg-muted/30 rounded-lg">
            <div className="flex items-center gap-1 text-muted-foreground text-xs mb-1">
              <Euro className="h-3 w-3" />
              Ist-Kosten
            </div>
            <p className="text-lg font-bold">{formatCurrency(totals.actualCost)}</p>
          </div>
          <div className={cn("p-3 rounded-lg", totals.laborQuote > TARGET_QUOTE_PCT ? 'bg-destructive/10' : 'bg-green-500/10')}>
            <div className="text-muted-foreground text-xs mb-1">Personalkostenquote</div>
            <p className={cn("text-lg font-bold", getQuoteColor(totals.laborQuote))}>
              {totals.laborQuote.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Cost Trend Chart */}
        {viewMode !== 'day' && dailyBreakdown.length > 1 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">Kostenverlauf</h4>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={dailyBreakdown} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <XAxis 
                    dataKey={viewMode === 'week' ? 'dayName' : 'dayLabel'} 
                    tick={{ fontSize: 10 }} 
                  />
                  <YAxis 
                    yAxisId="cost" 
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} 
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis 
                    yAxisId="quote" 
                    orientation="right" 
                    domain={[0, 50]} 
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-popover border border-border rounded-lg shadow-lg p-2 text-xs">
                            <p className="font-medium">{data.dayName} {data.dayLabel}</p>
                            <p>Plan: {formatCurrency(data.plannedCost)}</p>
                            <p>Ist: {formatCurrency(data.actualCost)}</p>
                            <p className={getQuoteColor(data.laborQuote)}>Quote: {data.laborQuote.toFixed(1)}%</p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar yAxisId="cost" dataKey="plannedCost" fill="hsl(var(--muted-foreground))" opacity={0.3} name="Plan" />
                  <Bar yAxisId="cost" dataKey="actualCost" fill="hsl(var(--primary))" name="Ist" />
                  <Line yAxisId="quote" type="monotone" dataKey="laborQuote" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 3 }} name="Quote" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Overtime Distribution Chart - Collapsible */}
        {employeeData.length > 0 && (
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="w-full">
              <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg cursor-pointer group hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  <h4 className="text-sm font-medium">Überstunden-Verteilung</h4>
                  <Badge variant="outline" className="text-xs">
                    {employeeData.filter(e => e.overtimeHours > 0).length} mit Überstunden
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
                      data={employeeData.map(d => ({
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
                        {employeeData.map((entry, index) => (
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

        {/* Employee Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-2 px-2 font-medium">Mitarbeiter</th>
                <th className="text-left py-2 px-2 font-medium hidden sm:table-cell">Abteilung</th>
                <th className="text-right py-2 px-2 font-medium">Soll</th>
                <th className="text-right py-2 px-2 font-medium">Plan</th>
                <th className="text-right py-2 px-2 font-medium">Ist</th>
                <th className="text-right py-2 px-2 font-medium hidden md:table-cell">Plan-Kosten</th>
                <th className="text-right py-2 px-2 font-medium hidden md:table-cell">Ist-Kosten</th>
                <th className="text-right py-2 px-2 font-medium">Überstd.</th>
              </tr>
            </thead>
            <tbody>
              {employeeData.map((data) => (
                <tr key={data.employee.id} className="border-b border-border/50">
                  <td className="py-2 px-2 font-medium">{data.employee.name}</td>
                  <td className="py-2 px-2 capitalize text-muted-foreground hidden sm:table-cell">{data.employee.department}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(data.expectedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(data.plannedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs">{data.actualHours > 0 ? formatHours(data.actualHours) : '-'}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{formatCurrency(data.plannedCost)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{data.actualCost > 0 ? formatCurrency(data.actualCost) : '-'}</td>
                  <td className={cn("text-right py-2 px-2 font-mono text-xs", getOvertimeColor(data.overtimeHours))}>
                    {data.overtimeHours > 0 ? '+' : ''}{formatHours(data.overtimeHours)}
                  </td>
                </tr>
              ))}
              {employeeData.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground py-8">
                    Keine Vollzeit/Teilzeit-Mitarbeiter vorhanden
                  </td>
                </tr>
              )}
            </tbody>
            {employeeData.length > 0 && (
              <tfoot>
                <tr className="font-semibold bg-muted/50">
                  <td className="py-2 px-2" colSpan={2}>Gesamt</td>
                  <td className="text-right py-2 px-2 font-mono text-xs hidden sm:table-cell">{formatHours(totals.expectedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(totals.plannedHours)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs">{formatHours(totals.actualHours)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{formatCurrency(totals.plannedCost)}</td>
                  <td className="text-right py-2 px-2 font-mono text-xs hidden md:table-cell">{formatCurrency(totals.actualCost)}</td>
                  <td className={cn("text-right py-2 px-2 font-mono text-xs", getOvertimeColor(totals.overtimeHours))}>
                    {totals.overtimeHours > 0 ? '+' : ''}{formatHours(totals.overtimeHours)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          * Überstunden = Ist-Stunden − Soll-Stunden ({viewMode === 'day' ? 'Tagesbasis' : viewMode === 'week' ? 'Wochenbasis' : 'Monatsbasis'}). 
          Positive Werte = Überstunden, negative = Minusstunden.
        </p>
      </CardContent>
    </Card>
  );
};
