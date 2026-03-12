import { useMemo } from 'react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget, grossToNet } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { Euro, Users, Clock, Percent, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CompactKPIWidgetProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
  showPlannedData?: boolean;
}

export const CompactKPIWidget = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
  showNetRevenue = false,
  showPlannedData = true,
}: CompactKPIWidgetProps) => {
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  
  // Helper to get display revenue
  const getDisplayRevenue = (grossRevenue: number, takeawayRevenue: number = 0) => {
    return showNetRevenue ? grossToNet(grossRevenue, takeawayRevenue) : grossRevenue;
  };
  
  // Calculate weekly data
  const weekData = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const allDays = eachDayOfInterval({ start: weekStart, end: weekEnd });
    const allDayStrings = allDays.map(d => format(d, 'yyyy-MM-dd'));
    
    let weekRevenue = 0, weekPlannedRevenue = 0;
    let weekActualCost = 0, weekPlannedCost = 0;
    let weekActualHours = 0, weekPlannedHours = 0;
    
    allDayStrings.forEach(ds => {
      const budget = dailyBudgets[ds];
      if (budget) {
        weekRevenue += getDisplayRevenue(budget.actualRevenue || 0, budget.takeawayRevenue || 0);
        weekPlannedRevenue += getDisplayRevenue(budget.plannedRevenue || 0, 0);
      }
      
      const dayEntries = timeEntries.filter(e => e.date === ds);
      dayEntries.forEach(entry => {
        const emp = employees.find(e => e.id === entry.employeeId);
        if (!emp) return;
        weekActualHours += entry.actualHours || 0;
        weekPlannedHours += entry.plannedHours || 0;
        weekActualCost += (entry.actualHours || 0) * emp.hourlyWage;
        weekPlannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
      });
    });
    
    const pkq = weekRevenue > 0 ? (weekActualCost / weekRevenue) * 100 : 0;
    
    return { weekRevenue, weekPlannedRevenue, weekActualCost, weekPlannedCost, weekActualHours, weekPlannedHours, pkq };
  }, [selectedDate, dailyBudgets, timeEntries, employees, showNetRevenue]);

  // Today's data
  const todayData = useMemo(() => {
    const budget = dailyBudgets[dateString];
    const dayEntries = timeEntries.filter(e => e.date === dateString);
    
    let actualCost = 0, plannedCost = 0, actualHours = 0, plannedHours = 0;
    
    dayEntries.forEach(entry => {
      const emp = employees.find(e => e.id === entry.employeeId);
      if (!emp) return;
      actualHours += entry.actualHours || 0;
      plannedHours += entry.plannedHours || 0;
      actualCost += (entry.actualHours || 0) * emp.hourlyWage;
      plannedCost += (entry.plannedHours || 0) * emp.hourlyWage;
    });
    
    const revenue = getDisplayRevenue(budget?.actualRevenue || 0, budget?.takeawayRevenue || 0);
    const plannedRevenue = getDisplayRevenue(budget?.plannedRevenue || 0, 0);
    const pkq = revenue > 0 ? (actualCost / revenue) * 100 : 0;
    
    return { revenue, plannedRevenue, actualCost, plannedCost, actualHours, plannedHours, pkq };
  }, [dateString, dailyBudgets, timeEntries, employees, showNetRevenue]);

  const getQuoteStyle = (quote: number) => {
    if (quote <= 25) return 'text-green-600 bg-green-50 dark:bg-green-950/30';
    if (quote <= 30) return 'text-blue-600 bg-blue-50 dark:bg-blue-950/30';
    if (quote <= 35) return 'text-amber-600 bg-amber-50 dark:bg-amber-950/30';
    return 'text-destructive bg-red-50 dark:bg-red-950/30';
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {/* Today Revenue */}
      <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
          <Euro className="h-3.5 w-3.5" />
          <span>Umsatz heute</span>
        </div>
        <p className="text-lg font-bold tracking-tight">{formatCurrency(todayData.revenue)}</p>
        <div className="flex items-center gap-1 mt-0.5">
          {showPlannedData && (
            <>
              {todayData.revenue >= todayData.plannedRevenue ? (
                <TrendingUp className="h-3 w-3 text-green-600" />
              ) : (
                <TrendingDown className="h-3 w-3 text-destructive" />
              )}
              <span className="text-[10px] text-muted-foreground">
                Plan: {formatCurrency(todayData.plannedRevenue)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Today Costs */}
      <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
          <Users className="h-3.5 w-3.5" />
          <span>Kosten heute</span>
        </div>
        <p className="text-lg font-bold tracking-tight">{formatCurrency(todayData.actualCost)}</p>
        <div className="flex items-center gap-1 mt-0.5">
          {showPlannedData && (
            <>
              {todayData.actualCost <= todayData.plannedCost ? (
                <TrendingDown className="h-3 w-3 text-green-600" />
              ) : (
                <TrendingUp className="h-3 w-3 text-destructive" />
              )}
              <span className="text-[10px] text-muted-foreground">
                Plan: {formatCurrency(todayData.plannedCost)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Week Revenue */}
      <div className="p-3 rounded-lg bg-muted/40 border border-border/50">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">
          <Euro className="h-3.5 w-3.5" />
          <span>Woche</span>
        </div>
        <p className="text-lg font-bold tracking-tight">{formatCurrency(weekData.weekRevenue)}</p>
        <div className="flex items-center gap-1 mt-0.5">
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">
            {formatHours(weekData.weekActualHours)} Std.
          </span>
        </div>
      </div>

      {/* PKQ */}
      <div className={cn("p-3 rounded-lg border border-border/50", getQuoteStyle(weekData.pkq))}>
        <div className="flex items-center gap-1.5 text-xs mb-1 opacity-80">
          <Percent className="h-3.5 w-3.5" />
          <span>PKQ Woche</span>
        </div>
        <p className="text-lg font-bold tracking-tight">{weekData.pkq.toFixed(1)}%</p>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[10px] opacity-70">
            {weekData.pkq <= 30 ? '✓ Im Ziel' : '↑ Über Ziel'}
          </span>
        </div>
      </div>
    </div>
  );
};
