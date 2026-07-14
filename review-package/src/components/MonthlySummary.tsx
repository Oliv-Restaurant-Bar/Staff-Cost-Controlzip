import { useMemo, useState } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { formatCurrency, formatHours } from '@/lib/personnel-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useWeekSync } from '@/hooks/useWeekSync';
import { useEmployerRateMap } from '@/hooks/useEmployerRateMap';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
  Area,
  AreaChart,
  ComposedChart
} from 'recharts';
import { CalendarDays, TrendingUp, TrendingDown, ChevronLeft, ChevronRight, Save } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface MonthlySummaryProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue', value: number) => void;
}

export const MonthlySummary = ({ 
  employees, 
  timeEntries, 
  dailyBudgets,
  selectedDate,
  onBudgetUpdate
}: MonthlySummaryProps) => {
  // Kosten = Total Arbeitgeberkosten (Bruttolohn + AG-Sozialkosten), nie roher hourlyWage.
  const { rateById } = useEmployerRateMap(employees);
  const { currentMonthStart, navigateMonth } = useWeekSync('MonthlySummary', selectedDate);
  const [editingBudgets, setEditingBudgets] = useState<Record<string, { planned: string; actual: string }>>({});
  const [showBudgetEditor, setShowBudgetEditor] = useState(false);

  const monthData = useMemo(() => {
    const monthStart = startOfMonth(currentMonthStart);
    const monthEnd = endOfMonth(currentMonthStart);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

    let totalPlannedRevenue = 0;
    let totalActualRevenue = 0;
    let totalPlannedCost = 0;
    let totalActualCost = 0;
    let totalPlannedHours = 0;
    let totalActualHours = 0;

    const dailyData = days.map((day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      const dayEntries = timeEntries.filter((e) => e.date === dateString);
      const budget = dailyBudgets[dateString];

      let plannedCost = 0;
      let actualCost = 0;
      let plannedHours = 0;
      let actualHours = 0;

      dayEntries.forEach((entry) => {
        const employee = employees.find((e) => e.id === entry.employeeId);
        if (!employee) return;

        const rate = rateById.get(employee.id) ?? 0;

        plannedHours += entry.plannedHours;
        plannedCost += entry.plannedHours * rate;

        if (entry.actualHours !== undefined) {
          actualHours += entry.actualHours;
          actualCost += entry.actualHours * rate;
        }
      });

      const plannedRevenue = budget?.plannedRevenue || 0;
      const actualRevenue = budget?.actualRevenue || 0;
      const laborPercentage = actualRevenue > 0 ? (actualCost / actualRevenue) * 100 : 0;

      totalPlannedRevenue += plannedRevenue;
      totalActualRevenue += actualRevenue;
      totalPlannedCost += plannedCost;
      totalActualCost += actualCost;
      totalPlannedHours += plannedHours;
      totalActualHours += actualHours;

      return {
        date: day,
        dateString,
        dayLabel: format(day, 'd'),
        dayName: format(day, 'EEE', { locale: de }),
        plannedRevenue,
        actualRevenue,
        plannedCost,
        actualCost,
        plannedHours,
        actualHours,
        laborPercentage,
        employeeCount: dayEntries.length,
      };
    });

    const avgLaborPercentage = totalActualRevenue > 0 
      ? (totalActualCost / totalActualRevenue) * 100 
      : 0;

    // Calculate trend (compare to previous period)
    const revenueVariance = totalActualRevenue - totalPlannedRevenue;
    const costVariance = totalPlannedCost - totalActualCost;

    return {
      monthStart,
      monthEnd,
      days: dailyData,
      totals: {
        plannedRevenue: totalPlannedRevenue,
        actualRevenue: totalActualRevenue,
        plannedCost: totalPlannedCost,
        actualCost: totalActualCost,
        plannedHours: totalPlannedHours,
        actualHours: totalActualHours,
      },
      avgLaborPercentage,
      revenueVariance,
      costVariance,
    };
  }, [employees, timeEntries, dailyBudgets, currentMonthStart, rateById]);

  // Chart data for Recharts
  const chartData = monthData.days.map((day) => ({
    name: day.dayLabel,
    umsatz: day.actualRevenue,
    umsatzBudget: day.plannedRevenue,
    personalkosten: day.actualCost,
    quote: day.laborPercentage,
  }));

  // navigateMonth is now provided by useWeekSync hook

  const handleBudgetChange = (dateString: string, field: 'planned' | 'actual', value: string) => {
    setEditingBudgets((prev) => ({
      ...prev,
      [dateString]: {
        ...prev[dateString],
        [field]: value,
      },
    }));
  };

  const saveBudgets = () => {
    Object.entries(editingBudgets).forEach(([dateString, values]) => {
      if (values.planned !== undefined) {
        const numValue = parseFloat(values.planned) || 0;
        onBudgetUpdate(dateString, 'plannedRevenue', numValue);
      }
      if (values.actual !== undefined) {
        const numValue = parseFloat(values.actual) || 0;
        onBudgetUpdate(dateString, 'actualRevenue', numValue);
      }
    });
    setEditingBudgets({});
    toast.success('Budgets gespeichert');
  };

  const getBudgetValue = (dateString: string, field: 'planned' | 'actual'): string => {
    if (editingBudgets[dateString]?.[field] !== undefined) {
      return editingBudgets[dateString][field];
    }
    const budget = dailyBudgets[dateString];
    if (field === 'planned') {
      return budget?.plannedRevenue?.toString() || '';
    }
    return budget?.actualRevenue?.toString() || '';
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <CalendarDays className="h-5 w-5" />
            Monatsübersicht
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => navigateMonth('prev')}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="font-medium min-w-[140px] text-center">
              {format(currentMonthStart, 'MMMM yyyy', { locale: de })}
            </span>
            <Button variant="ghost" size="icon" onClick={() => navigateMonth('next')}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Monthly Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-muted-foreground text-xs mb-1">Umsatz (Monat)</div>
            <div className="text-lg font-bold">{formatCurrency(monthData.totals.actualRevenue)}</div>
            <div className={cn(
              "text-xs flex items-center gap-1",
              monthData.revenueVariance >= 0 ? "text-green-600" : "text-red-500"
            )}>
              {monthData.revenueVariance >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {formatCurrency(Math.abs(monthData.revenueVariance))} vs. Budget
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-muted-foreground text-xs mb-1">Personalkosten</div>
            <div className="text-lg font-bold">{formatCurrency(monthData.totals.actualCost)}</div>
            <div className={cn(
              "text-xs flex items-center gap-1",
              monthData.costVariance >= 0 ? "text-green-600" : "text-red-500"
            )}>
              {monthData.costVariance >= 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              {formatCurrency(Math.abs(monthData.costVariance))} vs. Plan
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-muted-foreground text-xs mb-1">Arbeitsstunden</div>
            <div className="text-lg font-bold">{formatHours(monthData.totals.actualHours)}</div>
            <div className="text-xs text-muted-foreground">
              Plan: {formatHours(monthData.totals.plannedHours)}
            </div>
          </div>
          
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="text-muted-foreground text-xs mb-1">Ø Personalkostenquote</div>
            <div className={cn(
              "text-lg font-bold",
              monthData.avgLaborPercentage > 35 ? "text-red-500" : 
              monthData.avgLaborPercentage > 30 ? "text-yellow-500" : "text-green-600"
            )}>
              {monthData.avgLaborPercentage.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">vom Umsatz</div>
          </div>
        </div>

        {/* Revenue & Cost Chart */}
        <div>
          <h4 className="text-sm font-medium mb-3">Umsatz & Personalkosten Trend</h4>
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 10 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  yAxisId="left"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                  className="text-muted-foreground"
                />
                <YAxis 
                  yAxisId="right" 
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${value}%`}
                  domain={[0, 50]}
                  className="text-muted-foreground"
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === 'quote') return [`${value.toFixed(1)}%`, 'Personalkostenquote'];
                    return [formatCurrency(value), name === 'umsatz' ? 'Umsatz (Ist)' : name === 'umsatzBudget' ? 'Umsatz (Budget)' : 'Personalkosten'];
                  }}
                />
                <Legend />
                <Bar yAxisId="left" dataKey="umsatz" name="Umsatz" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
                <Line yAxisId="left" type="monotone" dataKey="umsatzBudget" name="Budget" stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="quote" name="PK-Quote %" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Personnel Costs Chart */}
        <div>
          <h4 className="text-sm font-medium mb-3">Tägliche Personalkosten</h4>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 10 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `${value}`}
                  className="text-muted-foreground"
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number) => [formatCurrency(value), 'Personalkosten']}
                />
                <Area 
                  type="monotone" 
                  dataKey="personalkosten" 
                  stroke="hsl(var(--primary))" 
                  fill="hsl(var(--primary) / 0.2)" 
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Budget Editor Toggle */}
        <div className="border-t pt-4">
          <Button 
            variant="outline" 
            onClick={() => setShowBudgetEditor(!showBudgetEditor)}
            className="mb-4"
          >
            {showBudgetEditor ? 'Budget-Editor ausblenden' : 'Tägliche Budgets bearbeiten'}
          </Button>

          {showBudgetEditor && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Tägliche Budget-Eingabe</h4>
                {Object.keys(editingBudgets).length > 0 && (
                  <Button size="sm" onClick={saveBudgets} className="gap-2">
                    <Save className="h-4 w-4" />
                    Speichern
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-xs text-muted-foreground mb-2">
                {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((day) => (
                  <div key={day} className="font-medium">{day}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {/* Add empty cells for days before month start */}
                {Array.from({ length: (monthData.monthStart.getDay() + 6) % 7 }).map((_, i) => (
                  <div key={`empty-${i}`} />
                ))}
                {monthData.days.map((day) => (
                  <div 
                    key={day.dateString} 
                    className={cn(
                      "p-2 rounded-lg border text-xs space-y-1",
                      isSameDay(day.date, new Date()) && "border-primary",
                      isSameDay(day.date, selectedDate) && "bg-primary/10"
                    )}
                  >
                    <div className="font-medium text-center">{day.dayLabel}</div>
                    <Input
                      type="number"
                      placeholder="Budget"
                      value={getBudgetValue(day.dateString, 'planned')}
                      onChange={(e) => handleBudgetChange(day.dateString, 'planned', e.target.value)}
                      className="h-7 text-xs px-1 text-center"
                    />
                    <Input
                      type="number"
                      placeholder="Ist"
                      value={getBudgetValue(day.dateString, 'actual')}
                      onChange={(e) => handleBudgetChange(day.dateString, 'actual', e.target.value)}
                      className="h-7 text-xs px-1 text-center"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
