import { useMemo } from 'react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval, isSameDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Calendar, Users, Euro, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WeeklySummaryProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

interface DaySummary {
  date: Date;
  dateString: string;
  dayName: string;
  plannedHours: number;
  actualHours: number;
  plannedCost: number;
  actualCost: number;
  plannedRevenue: number;
  actualRevenue: number;
  employeeCount: number;
}

export const WeeklySummary = ({ 
  employees, 
  timeEntries, 
  dailyBudgets, 
  selectedDate 
}: WeeklySummaryProps) => {
  const weekData = useMemo(() => {
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

    const daySummaries: DaySummary[] = days.map((day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      const dayEntries = timeEntries.filter((e) => e.date === dateString);
      const budget = dailyBudgets[dateString];

      let plannedHours = 0;
      let actualHours = 0;
      let plannedCost = 0;
      let actualCost = 0;

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (!employee) return;

        plannedHours += entry.plannedHours;
        plannedCost += entry.plannedHours * employee.hourlyWage;

        if (entry.actualHours !== undefined) {
          actualHours += entry.actualHours;
          actualCost += entry.actualHours * employee.hourlyWage;
        }
      });

      return {
        date: day,
        dateString,
        dayName: format(day, 'EEE', { locale: de }),
        plannedHours,
        actualHours,
        plannedCost,
        actualCost,
        plannedRevenue: budget?.plannedRevenue || 0,
        actualRevenue: budget?.actualRevenue || 0,
        employeeCount: dayEntries.length,
      };
    });

    // Calculate weekly totals
    const totals = daySummaries.reduce(
      (acc, day) => ({
        plannedHours: acc.plannedHours + day.plannedHours,
        actualHours: acc.actualHours + day.actualHours,
        plannedCost: acc.plannedCost + day.plannedCost,
        actualCost: acc.actualCost + day.actualCost,
        plannedRevenue: acc.plannedRevenue + day.plannedRevenue,
        actualRevenue: acc.actualRevenue + day.actualRevenue,
      }),
      {
        plannedHours: 0,
        actualHours: 0,
        plannedCost: 0,
        actualCost: 0,
        plannedRevenue: 0,
        actualRevenue: 0,
      }
    );

    const costVariance = totals.plannedCost - totals.actualCost;
    const revenueVariance = totals.actualRevenue - totals.plannedRevenue;
    const laborCostPercentage = totals.actualRevenue > 0 
      ? (totals.actualCost / totals.actualRevenue) * 100 
      : 0;

    return {
      weekStart,
      weekEnd,
      days: daySummaries,
      totals,
      costVariance,
      revenueVariance,
      laborCostPercentage,
    };
  }, [employees, timeEntries, dailyBudgets, selectedDate]);

  const isToday = (date: Date) => isSameDay(date, new Date());
  const isSelected = (date: Date) => isSameDay(date, selectedDate);

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Calendar className="h-5 w-5" />
          Wochenübersicht
          <span className="text-sm font-normal text-muted-foreground ml-2">
            {format(weekData.weekStart, 'd. MMM', { locale: de })} - {format(weekData.weekEnd, 'd. MMM yyyy', { locale: de })}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Weekly Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Euro className="h-3 w-3" />
              Umsatz (Woche)
            </div>
            <div className="text-lg font-bold">{formatCurrency(weekData.totals.actualRevenue)}</div>
            <div className={cn(
              "text-xs flex items-center gap-1",
              weekData.revenueVariance >= 0 ? "text-green-600" : "text-red-500"
            )}>
              {weekData.revenueVariance >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {formatCurrency(Math.abs(weekData.revenueVariance))} vs. Budget
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Users className="h-3 w-3" />
              Personalkosten
            </div>
            <div className="text-lg font-bold">{formatCurrency(weekData.totals.actualCost)}</div>
            <div className={cn(
              "text-xs flex items-center gap-1",
              weekData.costVariance >= 0 ? "text-green-600" : "text-red-500"
            )}>
              {weekData.costVariance >= 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              {formatCurrency(Math.abs(weekData.costVariance))} vs. Plan
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3" />
              Arbeitsstunden
            </div>
            <div className="text-lg font-bold">{formatHours(weekData.totals.actualHours)}</div>
            <div className="text-xs text-muted-foreground">
              Plan: {formatHours(weekData.totals.plannedHours)}
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              Personalkostenquote
            </div>
            <div className={cn(
              "text-lg font-bold",
              weekData.laborCostPercentage > 35 ? "text-red-500" : 
              weekData.laborCostPercentage > 30 ? "text-yellow-500" : "text-green-600"
            )}>
              {weekData.laborCostPercentage.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              vom Umsatz
            </div>
          </div>
        </div>

        {/* Daily Breakdown Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-left py-2 px-2 font-medium">Tag</th>
                <th className="text-right py-2 px-2 font-medium">Umsatz</th>
                <th className="text-right py-2 px-2 font-medium">Personalkosten</th>
                <th className="text-right py-2 px-2 font-medium">Stunden</th>
                <th className="text-right py-2 px-2 font-medium">Quote</th>
              </tr>
            </thead>
            <tbody>
              {weekData.days.map((day) => {
                const quote = day.actualRevenue > 0 
                  ? (day.actualCost / day.actualRevenue) * 100 
                  : 0;
                
                return (
                  <tr 
                    key={day.dateString} 
                    className={cn(
                      "border-b border-border/50 transition-colors",
                      isSelected(day.date) && "bg-primary/10",
                      isToday(day.date) && !isSelected(day.date) && "bg-muted/30"
                    )}
                  >
                    <td className="py-2 px-2">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium",
                          isToday(day.date) ? "bg-primary text-primary-foreground" : "bg-muted"
                        )}>
                          {format(day.date, 'd')}
                        </span>
                        <span className="font-medium capitalize">{day.dayName}</span>
                      </div>
                    </td>
                    <td className="text-right py-2 px-2 font-mono">
                      {day.actualRevenue > 0 ? formatCurrency(day.actualRevenue) : '-'}
                    </td>
                    <td className="text-right py-2 px-2 font-mono">
                      {day.actualCost > 0 ? formatCurrency(day.actualCost) : '-'}
                    </td>
                    <td className="text-right py-2 px-2 font-mono">
                      {day.actualHours > 0 ? formatHours(day.actualHours) : '-'}
                    </td>
                    <td className={cn(
                      "text-right py-2 px-2 font-mono",
                      quote > 35 ? "text-red-500" : 
                      quote > 30 ? "text-yellow-500" : 
                      quote > 0 ? "text-green-600" : ""
                    )}>
                      {quote > 0 ? `${quote.toFixed(1)}%` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold bg-muted/50">
                <td className="py-2 px-2">Gesamt</td>
                <td className="text-right py-2 px-2 font-mono">
                  {formatCurrency(weekData.totals.actualRevenue)}
                </td>
                <td className="text-right py-2 px-2 font-mono">
                  {formatCurrency(weekData.totals.actualCost)}
                </td>
                <td className="text-right py-2 px-2 font-mono">
                  {formatHours(weekData.totals.actualHours)}
                </td>
                <td className={cn(
                  "text-right py-2 px-2 font-mono",
                  weekData.laborCostPercentage > 35 ? "text-red-500" : 
                  weekData.laborCostPercentage > 30 ? "text-yellow-500" : "text-green-600"
                )}>
                  {weekData.laborCostPercentage.toFixed(1)}%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};
