import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { WeeklySummary } from '@/components/WeeklySummary';
import { MonthlySummary } from '@/components/MonthlySummary';
import { Employee, TimeEntry, DailyBudget, DailySummary } from '@/types/personnel';
import { Calendar, CalendarDays, CalendarRange, FileDown, ChevronDown, ChevronRight, Users } from 'lucide-react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval, startOfMonth, endOfMonth, subYears, getDay, addDays, subDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { exportCombinedReport } from '@/lib/pdf-export';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart, Line, Area, AreaChart } from 'recharts';

type ViewMode = 'day' | 'week' | 'month';

interface CombinedSummaryProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  dailySummary: {
    totalPlannedCost: number;
    totalActualCost: number;
    totalPlannedHours: number;
    totalActualHours: number;
    laborCostPercentage: number;
    variance: number;
  };
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue' | 'previousYearRevenue', value: number) => void;
}

export const CombinedSummary = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  dailySummary,
  onBudgetUpdate,
}: CombinedSummaryProps) => {
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [employeesOpen, setEmployeesOpen] = useState(false);
  
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const budget = dailyBudgets[dateString] || { plannedRevenue: 0, actualRevenue: 0, previousYearRevenue: 0 };
  
  const dayEntries = timeEntries.filter((e) => e.date === dateString);

  // Helper function to find the matching weekday from previous year
  const getPreviousYearMatchingDate = (date: Date): Date => {
    const lastYear = subYears(date, 1);
    const targetWeekday = getDay(date);
    const lastYearWeekday = getDay(lastYear);
    
    // Adjust to find the same weekday in previous year
    const diff = targetWeekday - lastYearWeekday;
    return addDays(lastYear, diff);
  };

  // Get previous year revenue based on matching weekday
  const getPreviousYearRevenue = (date: Date): number => {
    const matchingDate = getPreviousYearMatchingDate(date);
    const matchingDateString = format(matchingDate, 'yyyy-MM-dd');
    return dailyBudgets[matchingDateString]?.previousYearRevenue || 0;
  };

  // Calculate previous year matching date for display
  const previousYearMatchingDate = useMemo(() => {
    return getPreviousYearMatchingDate(selectedDate);
  }, [selectedDate]);

  const previousYearBudget = useMemo(() => {
    const matchingDateString = format(previousYearMatchingDate, 'yyyy-MM-dd');
    return dailyBudgets[matchingDateString] || { plannedRevenue: 0, actualRevenue: 0, previousYearRevenue: 0 };
  }, [previousYearMatchingDate, dailyBudgets]);

  // Calculate week data for charts
  const weekChartData = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

    return days.map((day) => {
      const ds = format(day, 'yyyy-MM-dd');
      const dayBudget = dailyBudgets[ds] || { plannedRevenue: 0, actualRevenue: 0, previousYearRevenue: 0 };
      const dayEntries = timeEntries.filter((e) => e.date === ds);
      
      // Get matching weekday from previous year
      const vjMatchingDate = getPreviousYearMatchingDate(day);
      const vjMatchingDateString = format(vjMatchingDate, 'yyyy-MM-dd');
      const vjBudget = dailyBudgets[vjMatchingDateString];
      const vjRevenue = vjBudget?.previousYearRevenue || dayBudget.previousYearRevenue || 0;
      
      let plannedCost = 0;
      let actualCost = 0;
      
      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          plannedCost += entry.plannedHours * employee.hourlyWage;
          actualCost += (entry.actualHours || 0) * employee.hourlyWage;
        }
      });

      const laborPct = dayBudget.actualRevenue > 0 ? (actualCost / dayBudget.actualRevenue) * 100 : 0;

      const vjChange = vjRevenue > 0 
        ? ((dayBudget.actualRevenue - vjRevenue) / vjRevenue) * 100 
        : 0;

      return {
        name: format(day, 'EEE', { locale: de }),
        date: format(day, 'd.M.'),
        fullDate: format(day, 'dd.MM.yyyy'),
        vjDate: format(vjMatchingDate, 'dd.MM.yy'),
        umsatzPlan: dayBudget.plannedRevenue,
        umsatzIst: dayBudget.actualRevenue,
        umsatzVJ: vjRevenue,
        vjChange: vjChange,
        pkPlan: plannedCost,
        pkIst: actualCost,
        quote: laborPct,
      };
    });
  }, [selectedDate, dailyBudgets, timeEntries, employees]);

  // Calculate month data for charts
  const monthChartData = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

    return days.map((day) => {
      const ds = format(day, 'yyyy-MM-dd');
      const dayBudget = dailyBudgets[ds] || { plannedRevenue: 0, actualRevenue: 0, previousYearRevenue: 0 };
      const dayEntries = timeEntries.filter((e) => e.date === ds);
      
      // Get matching weekday from previous year
      const vjMatchingDate = getPreviousYearMatchingDate(day);
      const vjMatchingDateString = format(vjMatchingDate, 'yyyy-MM-dd');
      const vjBudget = dailyBudgets[vjMatchingDateString];
      const vjRevenue = vjBudget?.previousYearRevenue || dayBudget.previousYearRevenue || 0;
      
      let plannedCost = 0;
      let actualCost = 0;
      
      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (employee) {
          plannedCost += entry.plannedHours * employee.hourlyWage;
          actualCost += (entry.actualHours || 0) * employee.hourlyWage;
        }
      });

      const laborPct = dayBudget.actualRevenue > 0 ? (actualCost / dayBudget.actualRevenue) * 100 : 0;

      const vjChange = vjRevenue > 0 
        ? ((dayBudget.actualRevenue - vjRevenue) / vjRevenue) * 100 
        : 0;

      return {
        name: format(day, 'd'),
        date: format(day, 'd.M.'),
        fullDate: format(day, 'dd.MM.yyyy'),
        vjDate: format(vjMatchingDate, 'dd.MM.yy'),
        umsatzPlan: dayBudget.plannedRevenue,
        umsatzIst: dayBudget.actualRevenue,
        umsatzVJ: vjRevenue,
        vjChange: vjChange,
        pkPlan: plannedCost,
        pkIst: actualCost,
        quote: laborPct,
      };
    });
  }, [selectedDate, dailyBudgets, timeEntries, employees]);

  // Day chart data (comparison bars) - using matching weekday from previous year
  const dayChartData = useMemo(() => {
    const vjRevenue = previousYearBudget?.previousYearRevenue || budget.previousYearRevenue || 0;
    
    return [
      {
        name: 'Umsatz',
        Vorjahr: vjRevenue,
        Plan: budget.plannedRevenue,
        Ist: budget.actualRevenue,
      },
      {
        name: 'Personalkosten',
        Vorjahr: 0,
        Plan: dailySummary.totalPlannedCost,
        Ist: dailySummary.totalActualCost,
      },
    ];
  }, [budget, dailySummary, previousYearBudget]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border rounded-lg shadow-lg p-3 text-sm">
          <p className="font-medium mb-1">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }}>
              {entry.name}: {typeof entry.value === 'number' 
                ? entry.name.includes('Quote') || entry.dataKey === 'quote'
                  ? `${entry.value.toFixed(1)}%`
                  : entry.name.includes('Änderung') || entry.dataKey === 'vjChange'
                    ? `${entry.value >= 0 ? '+' : ''}${entry.value.toFixed(1)}%`
                    : formatCurrency(entry.value)
                : entry.value
              }
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="text-lg">Übersicht</CardTitle>
          
          <div className="flex items-center gap-2 flex-wrap">
            {/* Export Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCombinedReport(
                selectedDate,
                employees,
                timeEntries,
                dailyBudgets,
                dailySummary as DailySummary
              )}
              className="gap-1.5"
            >
              <FileDown className="h-4 w-4" />
              PDF Export
            </Button>
            
            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={viewMode === 'day' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('day')}
                className="gap-1.5"
              >
                <Calendar className="h-4 w-4" />
                Tag
              </Button>
              <Button
                variant={viewMode === 'week' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('week')}
                className="gap-1.5"
              >
                <CalendarRange className="h-4 w-4" />
                Woche
              </Button>
              <Button
                variant={viewMode === 'month' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('month')}
                className="gap-1.5"
              >
                <CalendarDays className="h-4 w-4" />
                Monat
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="pt-4">
        {/* Day View */}
        {viewMode === 'day' && (
          <div className="space-y-4">
            <div className="text-center pb-2 border-b">
              <h3 className="text-lg font-semibold">
                {format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de })}
              </h3>
              {(previousYearBudget?.previousYearRevenue || budget.previousYearRevenue) > 0 && (
                <p className="text-sm text-muted-foreground mt-1">
                  Vorjahresvergleich: {format(previousYearMatchingDate, 'EEEE, d. MMM yyyy', { locale: de })}
                </p>
              )}
            </div>
            
            {/* Day Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <div className="text-xs text-muted-foreground">Mitarbeiter</div>
                <div className="text-xl font-bold">{dayEntries.length}</div>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <div className="text-xs text-muted-foreground">Stunden (Plan)</div>
                <div className="text-xl font-bold">{formatHours(dailySummary.totalPlannedHours)}</div>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <div className="text-xs text-muted-foreground">Stunden (Ist)</div>
                <div className="text-xl font-bold">{formatHours(dailySummary.totalActualHours)}</div>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg text-center">
                <div className="text-xs text-muted-foreground">PK-Quote</div>
                <div className="text-xl font-bold">{dailySummary.laborCostPercentage.toFixed(1)}%</div>
              </div>
            </div>

            {/* Day Chart */}
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dayChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} />
                  <YAxis dataKey="name" type="category" width={100} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Bar dataKey="Vorjahr" fill="hsl(var(--chart-3))" name="Vorjahr" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Plan" fill="hsl(var(--muted-foreground))" name="Plan" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="Ist" fill="hsl(var(--primary))" name="Ist" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            
            {/* Revenue & Costs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 border rounded-lg">
                <h4 className="font-medium mb-3">Umsatz</h4>
                <div className="space-y-2">
                  {(() => {
                    const vjRevenue = previousYearBudget?.previousYearRevenue || budget.previousYearRevenue || 0;
                    const vjChange = vjRevenue > 0 
                      ? ((budget.actualRevenue - vjRevenue) / vjRevenue) * 100 
                      : 0;
                    
                    return (
                      <>
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">
                            Vorjahr
                            <span className="text-xs ml-1">({format(previousYearMatchingDate, 'dd.MM.yy')})</span>
                          </span>
                          <span className="font-mono text-amber-600">{formatCurrency(vjRevenue)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Plan</span>
                          <span className="font-mono">{formatCurrency(budget.plannedRevenue)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ist</span>
                          <span className="font-mono font-bold">{formatCurrency(budget.actualRevenue)}</span>
                        </div>
                        <div className="flex justify-between pt-2 border-t">
                          <span className="text-muted-foreground">Diff. Plan</span>
                          <span className={`font-mono ${budget.actualRevenue >= budget.plannedRevenue ? 'text-green-600' : 'text-red-600'}`}>
                            {formatCurrency(budget.actualRevenue - budget.plannedRevenue)}
                          </span>
                        </div>
                        {vjRevenue > 0 && (
                          <>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Diff. VJ</span>
                              <span className={`font-mono ${budget.actualRevenue >= vjRevenue ? 'text-green-600' : 'text-amber-600'}`}>
                                {formatCurrency(budget.actualRevenue - vjRevenue)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Änderung VJ</span>
                              <span className={`font-mono font-bold ${vjChange >= 0 ? 'text-green-600' : 'text-amber-600'}`}>
                                {vjChange >= 0 ? '+' : ''}{vjChange.toFixed(1)}%
                              </span>
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
              
              <div className="p-4 border rounded-lg">
                <h4 className="font-medium mb-3">Personalkosten</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Plan</span>
                    <span className="font-mono">{formatCurrency(dailySummary.totalPlannedCost)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ist</span>
                    <span className="font-mono">{formatCurrency(dailySummary.totalActualCost)}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t">
                    <span className="text-muted-foreground">Differenz</span>
                    <span className={`font-mono ${dailySummary.variance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(dailySummary.variance)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Employee List for Day - Collapsible */}
            {dayEntries.length > 0 && (
              <Collapsible open={employeesOpen} onOpenChange={setEmployeesOpen}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="w-full justify-between p-4 border rounded-lg hover:bg-muted/50">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span className="font-medium">Mitarbeiter am {format(selectedDate, 'd. MMM', { locale: de })}</span>
                      <span className="text-muted-foreground text-sm">({dayEntries.length})</span>
                    </div>
                    {employeesOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {dayEntries.map((entry) => {
                      const employee = employees.find((e) => e.id === entry.employeeId);
                      if (!employee) return null;
                      
                      const actualHours = entry.actualHours || 0;
                      const plannedHours = entry.plannedHours || 0;
                      
                      return (
                        <div key={entry.id} className="p-2 bg-muted/30 rounded text-sm flex justify-between">
                          <span className="font-medium">{employee.name}</span>
                          <span className="text-muted-foreground">
                            {formatHours(plannedHours)} → {formatHours(actualHours)} h
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
        
        {/* Week View with Charts */}
        {viewMode === 'week' && (
          <div className="space-y-6">
            {/* Revenue Chart */}
            <div>
              <h4 className="font-medium mb-3">Umsatz Plan vs. Ist vs. Vorjahr</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={weekChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" />
                    <YAxis yAxisId="left" tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`} domain={[-30, 30]} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="umsatzVJ" fill="hsl(var(--chart-3))" name="Umsatz VJ" radius={[4, 4, 0, 0]} />
                    <Bar yAxisId="left" dataKey="umsatzPlan" fill="hsl(var(--muted-foreground))" name="Umsatz Plan" radius={[4, 4, 0, 0]} />
                    <Bar yAxisId="left" dataKey="umsatzIst" fill="hsl(var(--primary))" name="Umsatz Ist" radius={[4, 4, 0, 0]} />
                    <Line yAxisId="right" type="monotone" dataKey="vjChange" stroke="hsl(var(--chart-2))" name="Änderung VJ %" strokeWidth={2} dot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Personnel Cost Chart */}
            <div>
              <h4 className="font-medium mb-3">Personalkosten & PK-Quote</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={weekChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" />
                    <YAxis yAxisId="left" tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v}%`} domain={[0, 50]} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="pkPlan" fill="hsl(var(--muted-foreground))" name="PK Plan" radius={[4, 4, 0, 0]} />
                    <Bar yAxisId="left" dataKey="pkIst" fill="hsl(var(--destructive))" name="PK Ist" radius={[4, 4, 0, 0]} />
                    <Line yAxisId="right" type="monotone" dataKey="quote" stroke="hsl(var(--chart-1))" name="PK-Quote" strokeWidth={2} dot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Weekly Summary Component */}
            <WeeklySummary
              employees={employees}
              timeEntries={timeEntries}
              dailyBudgets={dailyBudgets}
              selectedDate={selectedDate}
            />
          </div>
        )}
        
        {/* Month View with Charts */}
        {viewMode === 'month' && (
          <div className="space-y-6">
            {/* Monthly Revenue Trend */}
            <div>
              <h4 className="font-medium mb-3">Umsatz Trend - {format(selectedDate, 'MMMM yyyy', { locale: de })}</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={monthChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" interval={2} />
                    <YAxis tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Area 
                      type="monotone" 
                      dataKey="umsatzVJ" 
                      stroke="hsl(var(--chart-3))" 
                      fill="hsl(var(--chart-3) / 0.2)" 
                      name="Umsatz VJ" 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="umsatzPlan" 
                      stroke="hsl(var(--muted-foreground))" 
                      fill="hsl(var(--muted-foreground) / 0.3)" 
                      name="Umsatz Plan" 
                    />
                    <Area 
                      type="monotone" 
                      dataKey="umsatzIst" 
                      stroke="hsl(var(--primary))" 
                      fill="hsl(var(--primary) / 0.3)" 
                      name="Umsatz Ist" 
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Monthly Personnel Costs */}
            <div>
              <h4 className="font-medium mb-3">Personalkosten & PK-Quote</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={monthChartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="name" interval={2} />
                    <YAxis yAxisId="left" tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v}%`} domain={[0, 50]} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Area 
                      yAxisId="left"
                      type="monotone" 
                      dataKey="pkIst" 
                      stroke="hsl(var(--destructive))" 
                      fill="hsl(var(--destructive) / 0.3)" 
                      name="PK Ist" 
                    />
                    <Line 
                      yAxisId="right" 
                      type="monotone" 
                      dataKey="quote" 
                      stroke="hsl(var(--chart-1))" 
                      name="PK-Quote" 
                      strokeWidth={2} 
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Monthly Summary Component */}
            <MonthlySummary
              employees={employees}
              timeEntries={timeEntries}
              dailyBudgets={dailyBudgets}
              selectedDate={selectedDate}
              onBudgetUpdate={onBudgetUpdate}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
};
