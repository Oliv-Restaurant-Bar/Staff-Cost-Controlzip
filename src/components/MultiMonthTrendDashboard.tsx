import { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, subMonths } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { TrendingUp, TrendingDown, Minus, BarChart3, Calendar, Euro, Clock, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  Legend,
} from 'recharts';

interface MultiMonthTrendDashboardProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

interface MonthData {
  month: string;
  monthShort: string;
  date: Date;
  actualCosts: number;
  plannedCosts: number;
  actualHours: number;
  plannedHours: number;
  revenue: number;
  plannedRevenue: number;
  laborQuote: number;
  avgHourlyCost: number;
  daysWithData: number;
}

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('de-CH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

const formatHours = (value: number) => {
  return value.toFixed(1).replace('.', ',');
};

export const MultiMonthTrendDashboard = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
}: MultiMonthTrendDashboardProps) => {
  // Calculate data for the last 6 months
  const monthlyData = useMemo(() => {
    const data: MonthData[] = [];
    
    for (let i = 5; i >= 0; i--) {
      const monthDate = subMonths(selectedDate, i);
      const monthStart = startOfMonth(monthDate);
      const monthEnd = endOfMonth(monthDate);
      const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
      
      let actualCosts = 0;
      let plannedCosts = 0;
      let actualHours = 0;
      let plannedHours = 0;
      let revenue = 0;
      let plannedRevenue = 0;
      let daysWithData = 0;
      
      days.forEach(day => {
        const dateString = format(day, 'yyyy-MM-dd');
        const budget = dailyBudgets[dateString];
        const dayEntries = timeEntries.filter(te => te.date === dateString);
        
        if (budget?.actualRevenue) {
          revenue += budget.actualRevenue;
          daysWithData++;
        }
        if (budget?.plannedRevenue) {
          plannedRevenue += budget.plannedRevenue;
        }
        
        dayEntries.forEach(entry => {
          const employee = employees.find(e => e.id === entry.employeeId);
          if (!employee) return;
          
          const aHours = entry.actualHours || 0;
          const pHours = entry.plannedHours || 0;
          
          actualHours += aHours;
          plannedHours += pHours;
          actualCosts += aHours * employee.hourlyWage;
          plannedCosts += pHours * employee.hourlyWage;
        });
      });
      
      const laborQuote = revenue > 0 ? (actualCosts / revenue) * 100 : 0;
      const avgHourlyCost = actualHours > 0 ? actualCosts / actualHours : 0;
      
      data.push({
        month: format(monthDate, 'MMMM yyyy', { locale: de }),
        monthShort: format(monthDate, 'MMM', { locale: de }),
        date: monthDate,
        actualCosts,
        plannedCosts,
        actualHours,
        plannedHours,
        revenue,
        plannedRevenue,
        laborQuote,
        avgHourlyCost,
        daysWithData,
      });
    }
    
    return data;
  }, [employees, timeEntries, dailyBudgets, selectedDate]);
  
  // Calculate trends
  const trends = useMemo(() => {
    if (monthlyData.length < 2) return null;
    
    const current = monthlyData[monthlyData.length - 1];
    const previous = monthlyData[monthlyData.length - 2];
    const threeMonthsAgo = monthlyData[monthlyData.length - 3] || previous;
    
    // Cost trend
    const costChange = previous.actualCosts > 0 
      ? ((current.actualCosts - previous.actualCosts) / previous.actualCosts) * 100 
      : 0;
    
    // Quote trend
    const quoteChange = current.laborQuote - previous.laborQuote;
    
    // Hourly cost trend
    const hourlyChange = previous.avgHourlyCost > 0
      ? ((current.avgHourlyCost - previous.avgHourlyCost) / previous.avgHourlyCost) * 100
      : 0;
    
    // 3-month moving average
    const lastThreeMonths = monthlyData.slice(-3);
    const avgCosts3M = lastThreeMonths.reduce((s, m) => s + m.actualCosts, 0) / lastThreeMonths.length;
    const avgQuote3M = lastThreeMonths.reduce((s, m) => s + m.laborQuote, 0) / lastThreeMonths.length;
    
    // Overall trend direction
    const costTrend = costChange < -5 ? 'improving' : costChange > 5 ? 'worsening' : 'stable';
    const quoteTrend = quoteChange < -2 ? 'improving' : quoteChange > 2 ? 'worsening' : 'stable';
    
    // YoY if we have enough data
    const sixMonthsAgo = monthlyData[0];
    const sixMonthChange = sixMonthsAgo.actualCosts > 0
      ? ((current.actualCosts - sixMonthsAgo.actualCosts) / sixMonthsAgo.actualCosts) * 100
      : 0;
    
    return {
      costChange,
      quoteChange,
      hourlyChange,
      avgCosts3M,
      avgQuote3M,
      costTrend,
      quoteTrend,
      sixMonthChange,
      current,
      previous,
    };
  }, [monthlyData]);
  
  // Chart data for costs
  const chartData = monthlyData.map(m => ({
    name: m.monthShort,
    fullName: m.month,
    'Ist-Kosten': m.actualCosts,
    'Plan-Kosten': m.plannedCosts,
    'Differenz': m.actualCosts - m.plannedCosts,
    'Quote': m.laborQuote,
    'Ø CHF/Std': m.avgHourlyCost,
    'Umsatz': m.revenue,
    'Stunden': m.actualHours,
  }));
  
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    
    const data = payload[0]?.payload;
    
    return (
      <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
        <div className="font-semibold mb-2">{data?.fullName}</div>
        {payload.map((entry: any, index: number) => (
          <div key={index} className="flex justify-between gap-4">
            <span style={{ color: entry.color }}>{entry.name}:</span>
            <span className="font-medium">
              {entry.name === 'Quote' ? `${entry.value.toFixed(1)}%` :
               entry.name === 'Ø CHF/Std' ? `CHF ${entry.value.toFixed(2)}` :
               entry.name === 'Stunden' ? `${formatHours(entry.value)} Std` :
               `CHF ${formatCurrency(entry.value)}`}
            </span>
          </div>
        ))}
      </div>
    );
  };
  
  if (monthlyData.length === 0 || !trends) {
    return null;
  }
  
  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <BarChart3 className="h-5 w-5 text-primary" />
          Kosten-Trend Dashboard
          <span className="text-sm font-normal text-muted-foreground ml-auto">
            Letzte 6 Monate
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Trend Indicators */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Monthly Cost Change */}
          <div className={cn(
            "rounded-lg p-3 space-y-1",
            trends.costTrend === 'improving' ? "bg-green-50 dark:bg-green-950/30" :
            trends.costTrend === 'worsening' ? "bg-red-50 dark:bg-red-950/30" :
            "bg-yellow-50 dark:bg-yellow-950/30"
          )}>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              vs. Vormonat
            </div>
            <div className={cn(
              "text-xl font-bold flex items-center gap-1",
              trends.costTrend === 'improving' ? "text-green-600" :
              trends.costTrend === 'worsening' ? "text-red-600" :
              "text-yellow-600"
            )}>
              {trends.costTrend === 'improving' ? <TrendingDown className="h-5 w-5" /> :
               trends.costTrend === 'worsening' ? <TrendingUp className="h-5 w-5" /> :
               <Minus className="h-5 w-5" />}
              {trends.costChange >= 0 ? '+' : ''}{trends.costChange.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              Kostenveränderung
            </div>
          </div>
          
          {/* Quote Change */}
          <div className={cn(
            "rounded-lg p-3 space-y-1",
            trends.quoteTrend === 'improving' ? "bg-green-50 dark:bg-green-950/30" :
            trends.quoteTrend === 'worsening' ? "bg-red-50 dark:bg-red-950/30" :
            "bg-yellow-50 dark:bg-yellow-950/30"
          )}>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Euro className="h-3 w-3" />
              PK-Quote
            </div>
            <div className={cn(
              "text-xl font-bold",
              trends.quoteTrend === 'improving' ? "text-green-600" :
              trends.quoteTrend === 'worsening' ? "text-red-600" :
              "text-yellow-600"
            )}>
              {trends.current.laborQuote.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              {trends.quoteChange >= 0 ? '+' : ''}{trends.quoteChange.toFixed(1)} Pkt.
            </div>
          </div>
          
          {/* 3-Month Average */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Ø 3 Monate
            </div>
            <div className="text-xl font-bold text-blue-600">
              CHF {formatCurrency(trends.avgCosts3M)}
            </div>
            <div className="text-xs text-muted-foreground">
              Quote: {trends.avgQuote3M.toFixed(1)}%
            </div>
          </div>
          
          {/* 6-Month Change */}
          <div className={cn(
            "rounded-lg p-3 space-y-1",
            trends.sixMonthChange < 0 ? "bg-green-50 dark:bg-green-950/30" :
            trends.sixMonthChange > 0 ? "bg-orange-50 dark:bg-orange-950/30" :
            "bg-muted/50"
          )}>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowRight className="h-3 w-3" />
              6-Monats-Trend
            </div>
            <div className={cn(
              "text-xl font-bold",
              trends.sixMonthChange < 0 ? "text-green-600" :
              trends.sixMonthChange > 0 ? "text-orange-600" :
              "text-foreground"
            )}>
              {trends.sixMonthChange >= 0 ? '+' : ''}{trends.sixMonthChange.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              Gesamtentwicklung
            </div>
          </div>
        </div>
        
        {/* Cost Trend Chart */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Kostenentwicklung</h4>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  className="text-muted-foreground"
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar 
                  dataKey="Ist-Kosten" 
                  fill="hsl(var(--primary))" 
                  radius={[4, 4, 0, 0]}
                  opacity={0.8}
                />
                <Line 
                  type="monotone" 
                  dataKey="Plan-Kosten" 
                  stroke="hsl(var(--muted-foreground))" 
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={{ fill: 'hsl(var(--muted-foreground))', r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        {/* Quote Trend Chart */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Personalkostenquote im Zeitverlauf</h4>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="quoteGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  domain={[0, 50]}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => `${v}%`}
                  className="text-muted-foreground"
                />
                <Tooltip content={<CustomTooltip />} />
                {/* Target line at 32% */}
                <Line 
                  type="monotone" 
                  dataKey={() => 32} 
                  stroke="#ef4444" 
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  name="Ziel"
                  dot={false}
                />
                <Area 
                  type="monotone" 
                  dataKey="Quote" 
                  stroke="hsl(var(--primary))" 
                  fill="url(#quoteGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <div className="w-8 h-0.5 bg-red-500" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #ef4444, #ef4444 3px, transparent 3px, transparent 6px)' }} />
              <span>Ziel-Quote (32%)</span>
            </div>
          </div>
        </div>
        
        {/* Monthly Summary Table */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Monatsübersicht</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Monat</th>
                  <th className="text-right py-2 font-medium">Umsatz</th>
                  <th className="text-right py-2 font-medium">Ist-Kosten</th>
                  <th className="text-right py-2 font-medium">Plan-Kosten</th>
                  <th className="text-right py-2 font-medium">Diff</th>
                  <th className="text-right py-2 font-medium">Quote</th>
                  <th className="text-right py-2 font-medium">Ø CHF/Std</th>
                </tr>
              </thead>
              <tbody>
                {monthlyData.map((m, idx) => {
                  const diff = m.actualCosts - m.plannedCosts;
                  const isLast = idx === monthlyData.length - 1;
                  return (
                    <tr 
                      key={m.month} 
                      className={cn(
                        "border-b border-dashed",
                        isLast && "bg-primary/5 font-medium"
                      )}
                    >
                      <td className="py-2">{m.monthShort}</td>
                      <td className="text-right py-2">CHF {formatCurrency(m.revenue)}</td>
                      <td className="text-right py-2 font-semibold">CHF {formatCurrency(m.actualCosts)}</td>
                      <td className="text-right py-2 text-muted-foreground">CHF {formatCurrency(m.plannedCosts)}</td>
                      <td className={cn(
                        "text-right py-2 font-medium",
                        diff > 0 ? "text-red-600" : diff < 0 ? "text-green-600" : ""
                      )}>
                        {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
                      </td>
                      <td className={cn(
                        "text-right py-2",
                        m.laborQuote > 35 ? "text-red-600" : m.laborQuote > 32 ? "text-yellow-600" : "text-green-600"
                      )}>
                        {m.laborQuote.toFixed(1)}%
                      </td>
                      <td className="text-right py-2">{m.avgHourlyCost.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        
        {/* Insights */}
        {trends && (
          <div className="space-y-2">
            {trends.costTrend === 'improving' && (
              <div className="p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-400">
                ✓ <strong>Positive Entwicklung:</strong> Die Kosten sind im Vergleich zum Vormonat um {Math.abs(trends.costChange).toFixed(1)}% gesunken. Behalten Sie diesen Trend bei.
              </div>
            )}
            {trends.costTrend === 'worsening' && (
              <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
                ⚠️ <strong>Achtung:</strong> Die Kosten sind im Vergleich zum Vormonat um {trends.costChange.toFixed(1)}% gestiegen. Prüfen Sie die Ursachen.
              </div>
            )}
            {trends.current.laborQuote > 35 && (
              <div className="p-3 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 rounded-lg text-sm text-orange-700 dark:text-orange-400">
                📊 <strong>Quote über Ziel:</strong> Mit {trends.current.laborQuote.toFixed(1)}% liegt die aktuelle PK-Quote über dem Zielwert von 32%.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
