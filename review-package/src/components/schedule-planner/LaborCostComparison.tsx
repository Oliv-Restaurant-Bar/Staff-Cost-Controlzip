import { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, eachWeekOfInterval, startOfWeek, endOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart, Line, Area, AreaChart } from 'recharts';
import { TrendingUp, TrendingDown, BarChart3, FileDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { exportLaborCostComparisonPDF } from '@/lib/labor-cost-export';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { EMPLOYER_COST_LABELS_SHORT } from '@/lib/social-costs';
import { EmployerCostInfoTip } from '@/components/ui/employer-cost-info';

interface LaborCostComparisonProps {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  dailyBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  currentMonth: Date;
  showCosts: boolean;
}

// Calculate hours from a time slot
const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat('de-CH', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};

export const LaborCostComparison = ({
  employees,
  scheduleData,
  dailyBudgets,
  currentMonth,
  showCosts,
}: LaborCostComparisonProps) => {
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const weeksInMonth = eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 });

  // Load threshold from settings
  const laborCostThreshold = parseFloat(localStorage.getItem('labor_cost_threshold') || '40');

  // Zentrale AG-Sozialkostensätze — Kostenbasis = Total Arbeitgeberkosten
  // (Bruttolohn + Arbeitgeber-Sozialkosten), nie roher hourlyWage.
  const { rates: socialCostRates } = useSocialCostRates();
  const rateById = useMemo(() => {
    const m = new Map<string, number>();
    employees.forEach(emp => {
      const r = getEffectiveHourlyRate(emp, socialCostRates);
      if (r != null && r > 0) m.set(emp.id, r);
    });
    return m;
  }, [employees, socialCostRates]);

  // Calculate daily data for charts
  const dailyData = useMemo(() => {
    return daysInMonth.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      let plannedCosts = 0;
      let actualHours = 0;

      employees.forEach(emp => {
        const cellKey = `${emp.id}-${dateStr}`;
        const daySchedule = scheduleData[cellKey];
        
        if (daySchedule) {
          // Netto via SSoT (Pause pro Einsatz abgezogen)
          const netHours = calculateDayNetHours(daySchedule);
          
          actualHours += netHours;
          const rate = rateById.get(emp.id);
          if (rate) {
            plannedCosts += netHours * rate;
          }
        }
      });

      const revenue = dailyBudgets[dateStr]?.plannedRevenue || 0;
      const targetCosts = revenue * (laborCostThreshold / 100);
      const laborPercentage = revenue > 0 ? (plannedCosts / revenue) * 100 : 0;

      return {
        date: format(day, 'dd'),
        dayName: format(day, 'EEE', { locale: de }),
        fullDate: format(day, 'd.MM.', { locale: de }),
        geplant: Math.round(plannedCosts),
        ziel: Math.round(targetCosts),
        umsatz: Math.round(revenue),
        quote: Math.round(laborPercentage),
        stunden: Math.round(actualHours * 10) / 10,
        isOverBudget: laborPercentage > laborCostThreshold,
      };
    });
  }, [daysInMonth, employees, scheduleData, dailyBudgets, laborCostThreshold, rateById]);

  // Calculate weekly data
  const weeklyData = useMemo(() => {
    return weeksInMonth.map((weekStart, idx) => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
        d => d >= monthStart && d <= monthEnd
      );

      let weekPlanned = 0;
      let weekTarget = 0;
      let weekRevenue = 0;
      let weekHours = 0;

      weekDays.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const dayRevenue = dailyBudgets[dateStr]?.plannedRevenue || 0;
        weekRevenue += dayRevenue;
        weekTarget += dayRevenue * (laborCostThreshold / 100);

        employees.forEach(emp => {
          const cellKey = `${emp.id}-${dateStr}`;
          const daySchedule = scheduleData[cellKey];
          
          if (daySchedule) {
            // Netto via SSoT (Pause pro Einsatz abgezogen)
            const netHours = calculateDayNetHours(daySchedule);
            
            weekHours += netHours;
            const rate = rateById.get(emp.id);
            if (rate) {
              weekPlanned += netHours * rate;
            }
          }
        });
      });

      const weekPercentage = weekRevenue > 0 ? (weekPlanned / weekRevenue) * 100 : 0;

      return {
        name: `KW ${format(weekStart, 'w')}`,
        geplant: Math.round(weekPlanned),
        ziel: Math.round(weekTarget),
        umsatz: Math.round(weekRevenue),
        quote: Math.round(weekPercentage),
        stunden: Math.round(weekHours * 10) / 10,
        differenz: Math.round(weekTarget - weekPlanned),
      };
    });
  }, [weeksInMonth, employees, scheduleData, dailyBudgets, laborCostThreshold, monthStart, monthEnd, rateById]);

  // Monthly summary
  const monthlySummary = useMemo(() => {
    const totalPlanned = dailyData.reduce((sum, d) => sum + d.geplant, 0);
    const totalTarget = dailyData.reduce((sum, d) => sum + d.ziel, 0);
    const totalRevenue = dailyData.reduce((sum, d) => sum + d.umsatz, 0);
    const totalHours = dailyData.reduce((sum, d) => sum + d.stunden, 0);
    const avgPercentage = totalRevenue > 0 ? (totalPlanned / totalRevenue) * 100 : 0;
    const difference = totalTarget - totalPlanned;

    return {
      totalPlanned,
      totalTarget,
      totalRevenue,
      totalHours,
      avgPercentage,
      difference,
      isUnderBudget: difference >= 0,
    };
  }, [dailyData]);

  const handleExportPDF = () => {
    exportLaborCostComparisonPDF({
      monthLabel: format(currentMonth, 'MMMM yyyy', { locale: de }),
      summary: monthlySummary,
      weeklyData,
      dailyData,
      laborCostThreshold,
    });
  };

  if (!showCosts) return null;

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-popover border border-border p-3 rounded-lg shadow-lg text-sm">
          <p className="font-semibold mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }} className="flex justify-between gap-4">
              <span>{entry.name}:</span>
              <span className="font-mono">
                {entry.name === 'Quote' ? `${entry.value}%` : `CHF ${formatCurrency(entry.value)}`}
              </span>
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            Plan vs. Ziel - {format(currentMonth, 'MMMM yyyy', { locale: de })}
            <EmployerCostInfoTip rates={socialCostRates} />
          </CardTitle>
          <Button onClick={handleExportPDF} variant="outline" size="sm" className="gap-2">
            <FileDown className="h-4 w-4" />
            PDF Export
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 bg-muted/50 rounded-lg text-center">
            <div className="text-sm text-muted-foreground mb-1">Geplant ({EMPLOYER_COST_LABELS_SHORT.total})</div>
            <div className="text-2xl font-bold text-primary">
              CHF {formatCurrency(monthlySummary.totalPlanned)}
            </div>
            <div className="text-xs text-muted-foreground">
              {monthlySummary.totalHours.toFixed(1)} Stunden
            </div>
          </div>
          
          <div className="p-4 bg-muted/50 rounded-lg text-center">
            <div className="text-sm text-muted-foreground mb-1">Zielkosten ({laborCostThreshold}%)</div>
            <div className="text-2xl font-bold">
              CHF {formatCurrency(monthlySummary.totalTarget)}
            </div>
            <div className="text-xs text-muted-foreground">
              max. {laborCostThreshold}% vom Umsatz
            </div>
          </div>
          
          <div className={cn(
            "p-4 rounded-lg text-center",
            monthlySummary.isUnderBudget 
              ? "bg-green-50 dark:bg-green-950/30" 
              : "bg-red-50 dark:bg-red-950/30"
          )}>
            <div className="text-sm text-muted-foreground mb-1">Differenz</div>
            <div className={cn(
              "text-2xl font-bold flex items-center justify-center gap-1",
              monthlySummary.isUnderBudget ? "text-green-600" : "text-red-600"
            )}>
              {monthlySummary.isUnderBudget ? (
                <TrendingDown className="h-5 w-5" />
              ) : (
                <TrendingUp className="h-5 w-5" />
              )}
              CHF {formatCurrency(Math.abs(monthlySummary.difference))}
            </div>
            <div className="text-xs text-muted-foreground">
              {monthlySummary.isUnderBudget ? 'unter Budget' : 'über Budget'}
            </div>
          </div>
          
          <div className={cn(
            "p-4 rounded-lg text-center",
            monthlySummary.avgPercentage <= laborCostThreshold 
              ? "bg-green-50 dark:bg-green-950/30" 
              : "bg-red-50 dark:bg-red-950/30"
          )}>
            <div className="text-sm text-muted-foreground mb-1">Ø Personalkostenquote</div>
            <div className={cn(
              "text-2xl font-bold",
              monthlySummary.avgPercentage <= laborCostThreshold ? "text-green-600" : "text-red-600"
            )}>
              {monthlySummary.avgPercentage.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              Ziel: {laborCostThreshold}%
            </div>
          </div>
        </div>

        {/* Weekly Bar Chart */}
        <div>
          <h4 className="font-semibold mb-3">Wochenvergleich</h4>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={weeklyData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" className="text-xs" />
                <YAxis yAxisId="left" className="text-xs" tickFormatter={(v) => `${v / 1000}k`} />
                <YAxis yAxisId="right" orientation="right" className="text-xs" tickFormatter={(v) => `${v}%`} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Bar yAxisId="left" dataKey="geplant" name="Geplant" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar yAxisId="left" dataKey="ziel" name="Ziel" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} opacity={0.5} />
                <Line yAxisId="right" type="monotone" dataKey="quote" name="Quote" stroke="hsl(var(--destructive))" strokeWidth={2} dot={{ r: 4 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily Area Chart */}
        <div>
          <h4 className="font-semibold mb-3">Tagesverlauf</h4>
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="fullDate" className="text-xs" interval={2} />
                <YAxis className="text-xs" tickFormatter={(v) => `${v / 1000}k`} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Area 
                  type="monotone" 
                  dataKey="ziel" 
                  name="Zielkosten" 
                  stroke="hsl(var(--muted-foreground))" 
                  fill="hsl(var(--muted))" 
                  fillOpacity={0.3}
                />
                <Area 
                  type="monotone" 
                  dataKey="geplant" 
                  name="Geplante Kosten" 
                  stroke="hsl(var(--primary))" 
                  fill="hsl(var(--primary))" 
                  fillOpacity={0.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Labor Cost Percentage Chart */}
        <div>
          <h4 className="font-semibold mb-3">Personalkostenquote pro Tag</h4>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="fullDate" className="text-xs" interval={2} />
                <YAxis className="text-xs" domain={[0, 60]} tickFormatter={(v) => `${v}%`} />
                <Tooltip 
                  formatter={(value: number) => [`${value}%`, 'Quote']}
                  labelFormatter={(label) => label}
                />
                <Bar 
                  dataKey="quote" 
                  name="Quote"
                  fill="hsl(var(--primary))"
                  radius={[2, 2, 0, 0]}
                >
                  {dailyData.map((entry, index) => (
                    <rect
                      key={`bar-${index}`}
                      fill={entry.isOverBudget ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'}
                    />
                  ))}
                </Bar>
                {/* Threshold line */}
                <Line
                  type="monotone"
                  dataKey={() => laborCostThreshold}
                  stroke="hsl(var(--destructive))"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  dot={false}
                  name={`Schwellenwert (${laborCostThreshold}%)`}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
