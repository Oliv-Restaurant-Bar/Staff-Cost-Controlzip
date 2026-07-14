import { useState, useMemo } from 'react';
import { Employee, TimeEntry, DailyBudget, grossToNet } from '@/types/personnel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  TrendingUp, 
  TrendingDown, 
  Calendar, 
  Clock, 
  Euro, 
  Percent, 
  FileSpreadsheet, 
  FileText,
  CalendarDays,
  CalendarRange,
  BarChart3
} from 'lucide-react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, eachDayOfInterval, subDays, subWeeks, subMonths, subYears } from 'date-fns';
import { de } from 'date-fns/locale';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { cn } from '@/lib/utils';
import { useEmployerRateMap } from '@/hooks/useEmployerRateMap';
import { exportActualPerformanceExcel, exportActualPerformancePDF } from '@/lib/actual-performance-export';
import { toast } from 'sonner';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';

interface ActualPerformanceKPIProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

type PeriodType = 'day' | 'week' | 'month' | 'year';

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

const formatCurrency = (value: number) => 
  new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF' }).format(value);

const formatHours = (value: number) => value.toFixed(1) + 'h';

const formatPercent = (value: number) => value.toFixed(1) + '%';

export const ActualPerformanceKPI = ({ 
  employees, 
  timeEntries, 
  dailyBudgets, 
  selectedDate 
}: ActualPerformanceKPIProps) => {
  const [activePeriod, setActivePeriod] = useState<PeriodType>('week');
  const { showNetRevenue } = useRevenueDisplay();
  // Kosten = Total Arbeitgeberkosten (Bruttolohn + AG-Sozialkosten), nie roher hourlyWage.
  const { rateById } = useEmployerRateMap(employees);

  // Calculate data for a date range
  const calculatePeriodData = (startDate: Date, endDate: Date, label: string, shortLabel: string, prevStartDate: Date, prevEndDate: Date): PeriodData => {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const prevDays = eachDayOfInterval({ start: prevStartDate, end: prevEndDate });
    
    let actualRevenue = 0;
    let actualHours = 0;
    let actualCosts = 0;
    let previousRevenue = 0;
    let previousHours = 0;
    let previousCosts = 0;
    
    const dailyData: { date: string; revenue: number; hours: number; costs: number; quota: number }[] = [];

    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const budget = dailyBudgets[dateStr];
      const dayRevenue = budget?.actualRevenue || 0;
      const takeaway = budget?.takeawayRevenue || 0;
      const displayRevenue = showNetRevenue ? grossToNet(dayRevenue, takeaway) : dayRevenue;
      
      // Calculate actual hours and costs for this day
      const dayEntries = timeEntries.filter(e => e.date === dateStr);
      let dayHours = 0;
      let dayCosts = 0;
      
      dayEntries.forEach(entry => {
        const hours = entry.actualHours || 0;
        const emp = employees.find(e => e.id === entry.employeeId);
        if (emp) {
          dayHours += hours;
          dayCosts += hours * (rateById.get(emp.id) ?? 0);
        }
      });
      
      actualRevenue += displayRevenue;
      actualHours += dayHours;
      actualCosts += dayCosts;
      
      const dayQuota = displayRevenue > 0 ? (dayCosts / displayRevenue) * 100 : 0;
      dailyData.push({ date: dateStr, revenue: displayRevenue, hours: dayHours, costs: dayCosts, quota: dayQuota });
    });

    // Previous period
    prevDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const budget = dailyBudgets[dateStr];
      const dayRevenue = budget?.actualRevenue || 0;
      const takeaway = budget?.takeawayRevenue || 0;
      const displayRevenue = showNetRevenue ? grossToNet(dayRevenue, takeaway) : dayRevenue;
      
      const dayEntries = timeEntries.filter(e => e.date === dateStr);
      let dayHours = 0;
      let dayCosts = 0;
      
      dayEntries.forEach(entry => {
        const hours = entry.actualHours || 0;
        const emp = employees.find(e => e.id === entry.employeeId);
        if (emp) {
          dayHours += hours;
          dayCosts += hours * (rateById.get(emp.id) ?? 0);
        }
      });
      
      previousRevenue += displayRevenue;
      previousHours += dayHours;
      previousCosts += dayCosts;
    });

    const laborQuota = actualRevenue > 0 ? (actualCosts / actualRevenue) * 100 : 0;
    const previousQuota = previousRevenue > 0 ? (previousCosts / previousRevenue) * 100 : 0;
    
    return {
      label,
      shortLabel,
      actualRevenue,
      actualHours,
      actualCosts,
      laborQuota,
      previousRevenue,
      previousHours,
      previousCosts,
      previousQuota,
      revenueChange: previousRevenue > 0 ? ((actualRevenue - previousRevenue) / previousRevenue) * 100 : 0,
      hoursChange: previousHours > 0 ? ((actualHours - previousHours) / previousHours) * 100 : 0,
      costsChange: previousCosts > 0 ? ((actualCosts - previousCosts) / previousCosts) * 100 : 0,
      quotaChange: laborQuota - previousQuota,
      days: dailyData,
    };
  };

  // Calculate last 7 days sparkline data
  const last7DaysData = useMemo(() => {
    const days: { date: string; revenue: number; hours: number; costs: number; quota: number }[] = [];
    
    for (let i = 6; i >= 0; i--) {
      const day = subDays(selectedDate, i);
      const dateStr = format(day, 'yyyy-MM-dd');
      const budget = dailyBudgets[dateStr];
      const dayRevenue = budget?.actualRevenue || 0;
      const takeaway = budget?.takeawayRevenue || 0;
      const displayRevenue = showNetRevenue ? grossToNet(dayRevenue, takeaway) : dayRevenue;
      
      const dayEntries = timeEntries.filter(e => e.date === dateStr);
      let dayHours = 0;
      let dayCosts = 0;
      
      dayEntries.forEach(entry => {
        const hours = entry.actualHours || 0;
        const emp = employees.find(e => e.id === entry.employeeId);
        if (emp) {
          dayHours += hours;
          dayCosts += hours * (rateById.get(emp.id) ?? 0);
        }
      });
      
      const dayQuota = displayRevenue > 0 ? (dayCosts / displayRevenue) * 100 : 0;
      days.push({ 
        date: format(day, 'EEE', { locale: de }), 
        revenue: displayRevenue, 
        hours: dayHours, 
        costs: dayCosts, 
        quota: dayQuota 
      });
    }
    
    return days;
  }, [selectedDate, employees, timeEntries, dailyBudgets, showNetRevenue, rateById]);

  const periodData = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const prevWeekStart = subWeeks(weekStart, 1);
    const prevWeekEnd = subWeeks(weekEnd, 1);
    
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const prevMonthStart = subMonths(monthStart, 1);
    const prevMonthEnd = endOfMonth(prevMonthStart);
    
    const yearStart = startOfYear(selectedDate);
    const yearEnd = endOfYear(selectedDate);
    const prevYearStart = subYears(yearStart, 1);
    const prevYearEnd = subYears(yearEnd, 1);
    
    const prevDay = subDays(selectedDate, 1);

    return {
      day: calculatePeriodData(
        selectedDate, selectedDate, 
        format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de }),
        format(selectedDate, 'd.M.'),
        prevDay, prevDay
      ),
      week: calculatePeriodData(
        weekStart, weekEnd,
        `KW ${format(selectedDate, 'w')} (${format(weekStart, 'd.M.')} - ${format(weekEnd, 'd.M.yyyy')})`,
        `KW ${format(selectedDate, 'w')}`,
        prevWeekStart, prevWeekEnd
      ),
      month: calculatePeriodData(
        monthStart, monthEnd,
        format(selectedDate, 'MMMM yyyy', { locale: de }),
        format(selectedDate, 'MMM yy', { locale: de }),
        prevMonthStart, prevMonthEnd
      ),
      year: calculatePeriodData(
        yearStart, yearEnd,
        format(selectedDate, 'yyyy'),
        format(selectedDate, 'yyyy'),
        prevYearStart, prevYearEnd
      ),
    };
  }, [selectedDate, employees, timeEntries, dailyBudgets, showNetRevenue, rateById]);

  const currentData = periodData[activePeriod];

  const handleExcelExport = async () => {
    try {
      await exportActualPerformanceExcel(periodData, selectedDate, showNetRevenue);
      toast.success('Excel-Export erstellt');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Export');
    }
  };

  const handlePDFExport = async () => {
    try {
      await exportActualPerformancePDF(periodData, selectedDate, showNetRevenue);
      toast.success('PDF-Report erstellt');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Export');
    }
  };

  const KPICard = ({ 
    title, 
    value, 
    icon: Icon, 
    change, 
    previousValue,
    format: formatFn,
    sparklineData,
    sparklineKey,
    sparklineColor,
    isQuota = false 
  }: { 
    title: string; 
    value: number; 
    icon: React.ComponentType<{ className?: string }>; 
    change: number;
    previousValue: number;
    format: (v: number) => string;
    sparklineData: { date: string; revenue: number; hours: number; costs: number; quota: number }[];
    sparklineKey: 'revenue' | 'hours' | 'costs' | 'quota';
    sparklineColor: string;
    isQuota?: boolean;
  }) => {
    const isPositive = isQuota ? change < 0 : change > 0;
    const TrendIcon = isPositive ? TrendingUp : TrendingDown;
    
    const CustomTooltip = ({ active, payload }: any) => {
      if (active && payload && payload.length) {
        return (
          <div className="bg-popover/95 backdrop-blur-sm border rounded-lg px-2 py-1 shadow-lg text-xs">
            <p className="font-medium">{payload[0]?.payload?.date}</p>
            <p className="text-muted-foreground">{formatFn(payload[0]?.value || 0)}</p>
          </div>
        );
      }
      return null;
    };
    
    return (
      <div className="relative p-4 rounded-xl bg-gradient-to-br from-card to-muted/30 border shadow-sm hover:shadow-md transition-all overflow-hidden">
        <div className="flex items-start justify-between mb-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          {change !== 0 && (
            <Badge 
              variant="outline" 
              className={cn(
                "text-xs font-medium",
                isPositive ? "border-emerald-500/50 text-emerald-600 bg-emerald-50" : "border-red-500/50 text-red-600 bg-red-50"
              )}
            >
              <TrendIcon className="h-3 w-3 mr-1" />
              {change >= 0 ? '+' : ''}{change.toFixed(1)}%
            </Badge>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold tracking-tight">{formatFn(value)}</p>
        </div>
        
        {/* Sparkline */}
        <div className="mt-3 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Tooltip content={<CustomTooltip />} />
              <Line 
                type="monotone" 
                dataKey={sparklineKey} 
                stroke={sparklineColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        
        <p className="text-[10px] text-muted-foreground mt-1 text-center">
          Letzte 7 Tage
        </p>
      </div>
    );
  };

  const getPeriodIcon = (period: PeriodType) => {
    switch (period) {
      case 'day': return Calendar;
      case 'week': return CalendarDays;
      case 'month': return CalendarRange;
      case 'year': return BarChart3;
    }
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <BarChart3 className="h-5 w-5" />
            Ist-Performance Übersicht
            <Badge variant="outline" className="ml-2 text-xs">
              {showNetRevenue ? 'Netto' : 'Brutto'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExcelExport} className="gap-1.5">
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button variant="outline" size="sm" onClick={handlePDFExport} className="gap-1.5">
              <FileText className="h-4 w-4" />
              PDF
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Period Tabs */}
        <Tabs value={activePeriod} onValueChange={(v) => setActivePeriod(v as PeriodType)}>
          <TabsList className="grid grid-cols-4 w-full max-w-md">
            <TabsTrigger value="day" className="gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Tag
            </TabsTrigger>
            <TabsTrigger value="week" className="gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" />
              Woche
            </TabsTrigger>
            <TabsTrigger value="month" className="gap-1.5">
              <CalendarRange className="h-3.5 w-3.5" />
              Monat
            </TabsTrigger>
            <TabsTrigger value="year" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" />
              Jahr
            </TabsTrigger>
          </TabsList>

          {(['day', 'week', 'month', 'year'] as PeriodType[]).map(period => (
            <TabsContent key={period} value={period} className="space-y-6 mt-4">
              {/* Period Label */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {(() => { const Icon = getPeriodIcon(period); return <Icon className="h-4 w-4" />; })()}
                {periodData[period].label}
              </div>

              {/* KPI Cards Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KPICard
                  title="Ist-Umsatz"
                  value={periodData[period].actualRevenue}
                  icon={Euro}
                  change={periodData[period].revenueChange}
                  previousValue={periodData[period].previousRevenue}
                  format={formatCurrency}
                  sparklineData={last7DaysData}
                  sparklineKey="revenue"
                  sparklineColor="#22c55e"
                />
                <KPICard
                  title="Ist-Stunden"
                  value={periodData[period].actualHours}
                  icon={Clock}
                  change={periodData[period].hoursChange}
                  previousValue={periodData[period].previousHours}
                  format={formatHours}
                  sparklineData={last7DaysData}
                  sparklineKey="hours"
                  sparklineColor="#3b82f6"
                />
                <KPICard
                  title="Personalkosten"
                  value={periodData[period].actualCosts}
                  icon={Euro}
                  change={periodData[period].costsChange}
                  previousValue={periodData[period].previousCosts}
                  format={formatCurrency}
                  sparklineData={last7DaysData}
                  sparklineKey="costs"
                  sparklineColor="#f59e0b"
                />
                <KPICard
                  title="PKQ (Quote)"
                  value={periodData[period].laborQuota}
                  icon={Percent}
                  change={periodData[period].quotaChange}
                  previousValue={periodData[period].previousQuota}
                  format={formatPercent}
                  sparklineData={last7DaysData}
                  sparklineKey="quota"
                  sparklineColor="#ef4444"
                  isQuota
                />
              </div>

              {/* Detail Table */}
              {period !== 'day' && periodData[period].days.length > 0 && (
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead>Datum</TableHead>
                        <TableHead className="text-right">Umsatz</TableHead>
                        <TableHead className="text-right">Stunden</TableHead>
                        <TableHead className="text-right">Kosten</TableHead>
                        <TableHead className="text-right">PKQ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {periodData[period].days.slice(0, period === 'year' ? 12 : undefined).map((day, idx) => {
                        // For year view, show monthly aggregates instead
                        if (period === 'year') {
                          const monthStart = startOfMonth(new Date(selectedDate.getFullYear(), idx, 1));
                          const monthEnd = endOfMonth(monthStart);
                          const monthDays = periodData[period].days.filter(d => {
                            const date = new Date(d.date);
                            return date >= monthStart && date <= monthEnd;
                          });
                          const monthRevenue = monthDays.reduce((sum, d) => sum + d.revenue, 0);
                          const monthHours = monthDays.reduce((sum, d) => sum + d.hours, 0);
                          const monthCosts = monthDays.reduce((sum, d) => sum + d.costs, 0);
                          const monthQuota = monthRevenue > 0 ? (monthCosts / monthRevenue) * 100 : 0;
                          
                          if (idx >= 12) return null;
                          
                          return (
                            <TableRow key={idx}>
                              <TableCell className="font-medium">
                                {format(new Date(selectedDate.getFullYear(), idx, 1), 'MMMM', { locale: de })}
                              </TableCell>
                              <TableCell className="text-right">{formatCurrency(monthRevenue)}</TableCell>
                              <TableCell className="text-right">{formatHours(monthHours)}</TableCell>
                              <TableCell className="text-right">{formatCurrency(monthCosts)}</TableCell>
                              <TableCell className={cn(
                                "text-right font-medium",
                                monthQuota > 35 ? "text-red-600" : monthQuota > 30 ? "text-amber-600" : "text-emerald-600"
                              )}>
                                {formatPercent(monthQuota)}
                              </TableCell>
                            </TableRow>
                          );
                        }
                        
                        return (
                          <TableRow key={day.date}>
                            <TableCell className="font-medium">
                              {format(new Date(day.date), period === 'week' ? 'EEE d.M.' : 'd.M.', { locale: de })}
                            </TableCell>
                            <TableCell className="text-right">{formatCurrency(day.revenue)}</TableCell>
                            <TableCell className="text-right">{formatHours(day.hours)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(day.costs)}</TableCell>
                            <TableCell className={cn(
                              "text-right font-medium",
                              day.quota > 35 ? "text-red-600" : day.quota > 30 ? "text-amber-600" : "text-emerald-600"
                            )}>
                              {formatPercent(day.quota)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {/* Summary Row */}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell>Gesamt</TableCell>
                        <TableCell className="text-right">{formatCurrency(periodData[period].actualRevenue)}</TableCell>
                        <TableCell className="text-right">{formatHours(periodData[period].actualHours)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(periodData[period].actualCosts)}</TableCell>
                        <TableCell className={cn(
                          "text-right",
                          periodData[period].laborQuota > 35 ? "text-red-600" : periodData[period].laborQuota > 30 ? "text-amber-600" : "text-emerald-600"
                        )}>
                          {formatPercent(periodData[period].laborQuota)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Day View - Single Day Detail */}
              {period === 'day' && (
                <div className="grid grid-cols-2 gap-4 p-4 rounded-lg bg-muted/30 border">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Umsatz pro Stunde</p>
                    <p className="text-lg font-semibold">
                      {periodData.day.actualHours > 0 
                        ? formatCurrency(periodData.day.actualRevenue / periodData.day.actualHours)
                        : '–'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Kosten pro Stunde</p>
                    <p className="text-lg font-semibold">
                      {periodData.day.actualHours > 0 
                        ? formatCurrency(periodData.day.actualCosts / periodData.day.actualHours)
                        : '–'}
                    </p>
                  </div>
                </div>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
};
