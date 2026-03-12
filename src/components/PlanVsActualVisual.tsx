import { useMemo, useState } from 'react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval, startOfMonth, endOfMonth, subDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget, grossToNet } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { Clock, Euro, TrendingUp, TrendingDown, Minus, Target, AlertTriangle, CheckCircle2, LineChart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, Line, ComposedChart } from 'recharts';

interface PlanVsActualVisualProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
}

interface PeriodData {
  plannedHours: number;
  actualHours: number;
  plannedCost: number;
  actualCost: number;
  plannedRevenue: number;
  actualRevenue: number;
}

type ViewMode = 'both' | 'hours' | 'costs';

export const PlanVsActualVisual = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  showNetRevenue = false,
}: PlanVsActualVisualProps) => {
  const [viewMode, setViewMode] = useState<ViewMode>('both');
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  
  // Helper to get display revenue
  const getDisplayRevenue = (grossRevenue: number, takeawayRevenue: number = 0) => {
    return showNetRevenue ? grossToNet(grossRevenue, takeawayRevenue) : grossRevenue;
  };

  // Calculate data for different periods
  const { dayData, weekData, monthData } = useMemo(() => {
    const calculatePeriodData = (dayStrings: string[]): PeriodData => {
      let plannedHours = 0, actualHours = 0, plannedCost = 0, actualCost = 0;
      let plannedRevenue = 0, actualRevenue = 0;

      dayStrings.forEach(ds => {
        const budget = dailyBudgets[ds];
        if (budget) {
          plannedRevenue += getDisplayRevenue(budget.plannedRevenue || 0, 0);
          actualRevenue += getDisplayRevenue(budget.actualRevenue || 0, budget.takeawayRevenue || 0);
        }

        const dayEntries = timeEntries.filter(e => e.date === ds);
        dayEntries.forEach(entry => {
          const emp = employees.find(e => e.id === entry.employeeId);
          if (!emp) return;
          plannedHours += entry.plannedHours || 0;
          actualHours += entry.actualHours || 0;
          plannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
          actualCost += (entry.actualHours || 0) * emp.hourlyWage;
        });
      });

      return { plannedHours, actualHours, plannedCost, actualCost, plannedRevenue, actualRevenue };
    };

    // Today
    const dayData = calculatePeriodData([dateString]);

    // This week
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).map(d => format(d, 'yyyy-MM-dd'));
    const weekData = calculatePeriodData(weekDays);

    // This month
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd }).map(d => format(d, 'yyyy-MM-dd'));
    const monthData = calculatePeriodData(monthDays);

    return { dayData, weekData, monthData };
  }, [selectedDate, dateString, dailyBudgets, timeEntries, employees, showNetRevenue]);

  // Calculate 7-day trend data
  const trendData = useMemo(() => {
    const days: { date: Date; dateString: string }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = subDays(selectedDate, i);
      days.push({ date: d, dateString: format(d, 'yyyy-MM-dd') });
    }

    return days.map(({ date, dateString: ds }) => {
      const dayEntries = timeEntries.filter(e => e.date === ds);
      
      let plannedHours = 0, actualHours = 0, plannedCost = 0, actualCost = 0;
      
      dayEntries.forEach(entry => {
        const emp = employees.find(e => e.id === entry.employeeId);
        if (!emp) return;
        plannedHours += entry.plannedHours || 0;
        actualHours += entry.actualHours || 0;
        plannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
        actualCost += (entry.actualHours || 0) * emp.hourlyWage;
      });

      const isToday = ds === format(selectedDate, 'yyyy-MM-dd');

      return {
        date: ds,
        dayLabel: format(date, 'EEE', { locale: de }),
        dayNum: format(date, 'd.'),
        plannedHours,
        actualHours,
        plannedCost,
        actualCost,
        hoursDiff: actualHours - plannedHours,
        costDiff: actualCost - plannedCost,
        isToday,
      };
    });
  }, [selectedDate, timeEntries, employees]);

  // Visual comparison bar component
  const ComparisonBar = ({ 
    label, 
    planned, 
    actual, 
    formatFn, 
    icon: Icon,
    type = 'cost' // 'cost' or 'hours' - for cost, less is better; for hours, neutral
  }: { 
    label: string; 
    planned: number; 
    actual: number; 
    formatFn: (v: number) => string;
    icon: React.ElementType;
    type?: 'cost' | 'hours';
  }) => {
    const diff = actual - planned;
    const diffPercent = planned > 0 ? ((actual - planned) / planned) * 100 : 0;
    const progressValue = planned > 0 ? Math.min((actual / planned) * 100, 150) : 0;
    
    // For costs: under plan is good (green), over plan is bad (red)
    // For hours: slight variation is neutral, big deviation shows trend
    const isOverPlan = actual > planned;
    const isUnderPlan = actual < planned;
    const isOnTarget = Math.abs(diffPercent) < 5;

    const getStatusColor = () => {
      if (type === 'cost') {
        if (isOnTarget) return 'text-muted-foreground';
        return isOverPlan ? 'text-destructive' : 'text-success';
      }
      // For hours
      if (isOnTarget) return 'text-muted-foreground';
      return isOverPlan ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400';
    };

    const getProgressColor = () => {
      if (type === 'cost') {
        if (progressValue > 100) return 'bg-destructive';
        if (progressValue > 90) return 'bg-amber-500';
        return 'bg-success';
      }
      // For hours
      if (progressValue > 110) return 'bg-amber-500';
      if (progressValue < 80) return 'bg-blue-500';
      return 'bg-primary';
    };

    const getStatusIcon = () => {
      if (isOnTarget) return <CheckCircle2 className="h-4 w-4 text-success" />;
      if (type === 'cost') {
        return isOverPlan 
          ? <AlertTriangle className="h-4 w-4 text-destructive" />
          : <CheckCircle2 className="h-4 w-4 text-success" />;
      }
      return isOverPlan 
        ? <TrendingUp className="h-4 w-4 text-amber-500" />
        : <TrendingDown className="h-4 w-4 text-blue-500" />;
    };

    return (
      <TooltipProvider>
        <div className="space-y-2">
          {/* Header with label and status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{label}</span>
            </div>
            <div className="flex items-center gap-2">
              {getStatusIcon()}
              <span className={cn("text-sm font-semibold", getStatusColor())}>
                {diff >= 0 ? '+' : ''}{formatFn(diff)}
                <span className="text-xs ml-1 opacity-70">
                  ({diffPercent >= 0 ? '+' : ''}{diffPercent.toFixed(0)}%)
                </span>
              </span>
            </div>
          </div>

          {/* Visual progress bar */}
          <div className="relative">
            <div className="h-8 bg-muted rounded-lg overflow-hidden relative">
              {/* Plan marker at 100% */}
              <div 
                className="absolute top-0 bottom-0 w-0.5 bg-foreground/30 z-10"
                style={{ left: `${Math.min(100, (100 / Math.max(progressValue, 100)) * 100)}%` }}
              />
              
              {/* Actual fill */}
              <div 
                className={cn("h-full transition-all duration-500", getProgressColor())}
                style={{ width: `${Math.min(progressValue, 100)}%` }}
              />
              
              {/* Overflow indicator if over 100% */}
              {progressValue > 100 && (
                <div 
                  className="absolute top-0 bottom-0 right-0 bg-destructive/20 border-l-2 border-destructive"
                  style={{ width: `${Math.min(progressValue - 100, 50)}%` }}
                />
              )}
            </div>

            {/* Values overlay */}
            <div className="absolute inset-0 flex items-center justify-between px-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs font-mono font-bold text-white drop-shadow-md cursor-help">
                    Ist: {formatFn(actual)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Tatsächlicher Wert</p>
                </TooltipContent>
              </Tooltip>
              
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs font-mono text-foreground/70 cursor-help">
                    Plan: {formatFn(planned)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Geplanter Wert (Ziel)</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </TooltipProvider>
    );
  };

  // Period summary card
  const PeriodCard = ({ 
    title, 
    data, 
    highlight = false 
  }: { 
    title: string; 
    data: PeriodData; 
    highlight?: boolean;
  }) => {
    const pkq = data.actualRevenue > 0 ? (data.actualCost / data.actualRevenue) * 100 : 0;
    const pkqPlanned = data.plannedRevenue > 0 ? (data.plannedCost / data.plannedRevenue) * 100 : 0;

    const getPkqStatus = (value: number) => {
      if (value <= 25) return { color: 'text-success bg-success/10', label: 'Sehr gut' };
      if (value <= 30) return { color: 'text-primary bg-primary/10', label: 'Gut' };
      if (value <= 35) return { color: 'text-amber-600 bg-amber-500/10', label: 'Achtung' };
      return { color: 'text-destructive bg-destructive/10', label: 'Kritisch' };
    };

    const pkqStatus = getPkqStatus(pkq);

    return (
      <div className={cn(
        "rounded-xl border p-4 space-y-4",
        highlight ? "border-primary/50 bg-primary/5" : "border-border bg-card"
      )}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">{title}</h3>
          {data.actualRevenue > 0 && (
            <div className={cn("px-2.5 py-1 rounded-full text-xs font-semibold", pkqStatus.color)}>
              PKQ: {pkq.toFixed(1)}%
            </div>
          )}
        </div>

        <div className="space-y-4">
          {(viewMode === 'both' || viewMode === 'hours') && (
            <ComparisonBar
              label="Stunden"
              planned={data.plannedHours}
              actual={data.actualHours}
              formatFn={(v) => formatHours(Math.abs(v))}
              icon={Clock}
              type="hours"
            />
          )}
          
          {(viewMode === 'both' || viewMode === 'costs') && (
            <ComparisonBar
              label="Personalkosten"
              planned={data.plannedCost}
              actual={data.actualCost}
              formatFn={(v) => formatCurrency(Math.abs(v))}
              icon={Euro}
              type="cost"
            />
          )}
        </div>

        {/* Quick stats row */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/50">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Umsatz</p>
            <p className="text-sm font-semibold">{formatCurrency(data.actualRevenue)}</p>
            <p className="text-[10px] text-muted-foreground">Plan: {formatCurrency(data.plannedRevenue)}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Effizienz</p>
            <p className="text-sm font-semibold">
              {data.actualHours > 0 ? formatCurrency(data.actualRevenue / data.actualHours) : '–'}/Std
            </p>
            <p className="text-[10px] text-muted-foreground">
              Plan: {data.plannedHours > 0 ? formatCurrency(data.plannedRevenue / data.plannedHours) : '–'}/Std
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Plan vs. Ist Übersicht
        </h2>
        
        <div className="flex items-center gap-3">
          <ToggleGroup 
            type="single" 
            value={viewMode} 
            onValueChange={(value) => value && setViewMode(value as ViewMode)}
            className="bg-muted/50 p-0.5 rounded-lg"
          >
            <ToggleGroupItem 
              value="both" 
              size="sm"
              className="text-xs px-3 data-[state=on]:bg-background data-[state=on]:shadow-sm"
            >
              Beides
            </ToggleGroupItem>
            <ToggleGroupItem 
              value="hours" 
              size="sm"
              className="text-xs px-3 data-[state=on]:bg-background data-[state=on]:shadow-sm gap-1"
            >
              <Clock className="h-3 w-3" />
              Stunden
            </ToggleGroupItem>
            <ToggleGroupItem 
              value="costs" 
              size="sm"
              className="text-xs px-3 data-[state=on]:bg-background data-[state=on]:shadow-sm gap-1"
            >
              <Euro className="h-3 w-3" />
              Kosten
            </ToggleGroupItem>
          </ToggleGroup>
          
          <span className="text-sm text-muted-foreground hidden sm:inline">
            {format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de })}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <PeriodCard 
          title="Heute" 
          data={dayData} 
          highlight={true}
        />
        <PeriodCard 
          title={`KW ${format(selectedDate, 'w')}`} 
          data={weekData} 
        />
        <PeriodCard 
          title={format(selectedDate, 'MMMM', { locale: de })} 
          data={monthData} 
        />
      </div>

      {/* 7-Day Trend Chart */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <LineChart className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-sm">7-Tage Trend</h3>
          <span className="text-xs text-muted-foreground ml-auto">
            {viewMode === 'hours' ? 'Stunden' : viewMode === 'costs' ? 'Kosten' : 'Stunden & Kosten'}
          </span>
        </div>
        
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis 
                dataKey="dayLabel" 
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                className="fill-muted-foreground"
              />
              <YAxis 
                yAxisId="left"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                className="fill-muted-foreground"
                width={40}
                tickFormatter={(v) => viewMode === 'costs' ? `${(v/1000).toFixed(0)}k` : v.toFixed(0)}
                hide={viewMode === 'hours'}
              />
              <YAxis 
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                className="fill-muted-foreground"
                width={30}
                hide={viewMode === 'costs'}
              />
              <RechartsTooltip 
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const data = payload[0]?.payload;
                  return (
                    <div className="bg-popover border border-border rounded-lg shadow-lg p-3 text-xs">
                      <p className="font-semibold mb-2">{data?.dayLabel} {data?.dayNum}</p>
                      {(viewMode === 'both' || viewMode === 'hours') && (
                        <div className="space-y-1">
                          <div className="flex justify-between gap-4">
                            <span className="text-blue-500">Plan-Std:</span>
                            <span className="font-mono">{formatHours(data?.plannedHours || 0)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-emerald-500">Ist-Std:</span>
                            <span className="font-mono">{formatHours(data?.actualHours || 0)}</span>
                          </div>
                        </div>
                      )}
                      {(viewMode === 'both' || viewMode === 'costs') && (
                        <div className={cn("space-y-1", viewMode === 'both' && "mt-2 pt-2 border-t border-border")}>
                          <div className="flex justify-between gap-4">
                            <span className="text-orange-400">Plan-Kosten:</span>
                            <span className="font-mono">{formatCurrency(data?.plannedCost || 0)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-rose-400">Ist-Kosten:</span>
                            <span className="font-mono">{formatCurrency(data?.actualCost || 0)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              
              {/* Hours lines */}
              {(viewMode === 'both' || viewMode === 'hours') && (
                <>
                  <Line 
                    yAxisId="right"
                    type="monotone" 
                    dataKey="plannedHours" 
                    stroke="hsl(217, 91%, 60%)" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    name="Plan-Std"
                  />
                  <Line 
                    yAxisId="right"
                    type="monotone" 
                    dataKey="actualHours" 
                    stroke="hsl(142, 71%, 45%)" 
                    strokeWidth={2}
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      if (payload?.isToday) {
                        return <circle cx={cx} cy={cy} r={5} fill="hsl(142, 71%, 45%)" stroke="white" strokeWidth={2} />;
                      }
                      return <circle cx={cx} cy={cy} r={3} fill="hsl(142, 71%, 45%)" />;
                    }}
                    name="Ist-Std"
                  />
                </>
              )}
              
              {/* Cost areas */}
              {(viewMode === 'both' || viewMode === 'costs') && (
                <>
                  <Area 
                    yAxisId="left"
                    type="monotone" 
                    dataKey="plannedCost" 
                    stroke="hsl(25, 95%, 53%)" 
                    fill="hsl(25, 95%, 53%)"
                    fillOpacity={0.1}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    name="Plan-Kosten"
                  />
                  <Area 
                    yAxisId="left"
                    type="monotone" 
                    dataKey="actualCost" 
                    stroke="hsl(350, 89%, 60%)" 
                    fill="hsl(350, 89%, 60%)"
                    fillOpacity={0.2}
                    strokeWidth={2}
                    name="Ist-Kosten"
                  />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Chart legend */}
        <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground mt-2 pt-2 border-t border-border/50">
          {(viewMode === 'both' || viewMode === 'hours') && (
            <>
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-blue-500 border-dashed border-b-2 border-blue-500" />
                <span>Plan-Stunden</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 bg-emerald-500" />
                <span>Ist-Stunden</span>
              </div>
            </>
          )}
          {(viewMode === 'both' || viewMode === 'costs') && (
            <>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-orange-400/30 border border-orange-400" />
                <span>Plan-Kosten</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-sm bg-rose-400/30 border border-rose-400" />
                <span>Ist-Kosten</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground pt-2">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-success" />
          <span>Unter Plan (gut)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-primary" />
          <span>Im Ziel</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-amber-500" />
          <span>Leicht über Plan</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-destructive" />
          <span>Über Plan (kritisch)</span>
        </div>
      </div>
    </div>
  );
};
