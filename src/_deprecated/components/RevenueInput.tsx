import { useState, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCurrency } from '@/lib/personnel-utils';
import { TrendingUp, TrendingDown, Target, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, subDays, eachDayOfInterval, startOfWeek, endOfWeek, subWeeks, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { de } from 'date-fns/locale';
import { DailyBudget } from '@/types/personnel';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface RevenueInputProps {
  plannedRevenue: number;
  actualRevenue: number;
  onPlannedChange: (value: number) => void;
  onActualChange: (value: number) => void;
  dailyBudgets?: Record<string, DailyBudget>;
  selectedDate?: Date;
}

interface SparklineData {
  value: number;
  date: Date;
  label: string;
}

// Mini Sparkline Component with Tooltip
const MiniSparkline = ({ data, height = 24 }: { data: SparklineData[]; height?: number }) => {
  if (!data.length || data.every(d => d.value === 0)) {
    return (
      <div className="flex items-center justify-center text-[8px] text-muted-foreground h-6">
        Keine Daten
      </div>
    );
  }

  const values = data.map(d => d.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const total = values.reduce((a, b) => a + b, 0);
  
  const points = data.map((d, index) => {
    const x = (index / (data.length - 1)) * 60;
    const y = height - ((d.value - min) / range) * (height - 4);
    return `${x},${y}`;
  }).join(' ');

  const lastValue = data[data.length - 1]?.value || 0;
  const prevValue = data[data.length - 2]?.value || lastValue;
  const trend = lastValue >= prevValue;

  const tooltipContent = (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold border-b pb-1 mb-1">Letzte 7 Tage</div>
      {data.map((d, i) => (
        <div key={i} className="flex justify-between gap-3 text-[10px]">
          <span className="text-muted-foreground">{d.label}</span>
          <span className="font-medium">{formatCurrency(d.value)}</span>
        </div>
      ))}
      <div className="border-t pt-1 mt-1 flex justify-between gap-3 text-[10px] font-semibold">
        <span>Gesamt</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <svg width="60" height={height} className="overflow-visible cursor-pointer">
          <polyline
            points={points}
            fill="none"
            stroke={trend ? 'hsl(var(--chart-2))' : 'hsl(var(--destructive))'}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Data points */}
          {data.map((d, index) => {
            const x = (index / (data.length - 1)) * 60;
            const y = height - ((d.value - min) / range) * (height - 4);
            return (
              <circle
                key={index}
                cx={x}
                cy={y}
                r={index === data.length - 1 ? 2.5 : 1.5}
                fill={trend ? 'hsl(var(--chart-2))' : 'hsl(var(--destructive))'}
                className="transition-all"
              />
            );
          })}
        </svg>
      </TooltipTrigger>
      <TooltipContent side="top" className="p-2">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
};

export const RevenueInput = ({
  plannedRevenue,
  actualRevenue,
  onPlannedChange,
  onActualChange,
  dailyBudgets,
  selectedDate,
}: RevenueInputProps) => {
  const [plannedInput, setPlannedInput] = useState(plannedRevenue.toString());
  const [actualInput, setActualInput] = useState(actualRevenue.toString());

  useEffect(() => {
    setPlannedInput(plannedRevenue.toString());
  }, [plannedRevenue]);

  useEffect(() => {
    setActualInput(actualRevenue.toString());
  }, [actualRevenue]);

  const handlePlannedBlur = () => {
    const value = parseFloat(plannedInput) || 0;
    onPlannedChange(value);
  };

  const handleActualBlur = () => {
    const value = parseFloat(actualInput) || 0;
    onActualChange(value);
  };

  const variance = actualRevenue - plannedRevenue;
  const variancePercent = plannedRevenue > 0 ? (variance / plannedRevenue) * 100 : 0;
  const isPositive = variance > 0;
  const isNegative = variance < 0;

  // Calculate last 7 days data for sparkline
  const sparklineData = useMemo((): SparklineData[] => {
    if (!dailyBudgets || !selectedDate) return [];
    
    const days = eachDayOfInterval({
      start: subDays(selectedDate, 6),
      end: selectedDate
    });
    
    return days.map(day => ({
      value: dailyBudgets[format(day, 'yyyy-MM-dd')]?.actualRevenue || 0,
      date: day,
      label: format(day, 'EEE dd.MM', { locale: de })
    }));
  }, [dailyBudgets, selectedDate]);

  // Calculate week comparison data
  const weekComparison = useMemo(() => {
    if (!dailyBudgets || !selectedDate) return null;
    
    const currentWeekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const currentWeekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const prevWeekStart = subWeeks(currentWeekStart, 1);
    const prevWeekEnd = subWeeks(currentWeekEnd, 1);
    
    const currentWeekDays = eachDayOfInterval({ start: currentWeekStart, end: currentWeekEnd });
    const prevWeekDays = eachDayOfInterval({ start: prevWeekStart, end: prevWeekEnd });
    
    let currentTotal = 0, prevTotal = 0;
    let currentPlan = 0, prevPlan = 0;
    
    currentWeekDays.forEach(day => {
      const budget = dailyBudgets[format(day, 'yyyy-MM-dd')];
      currentTotal += budget?.actualRevenue || 0;
      currentPlan += budget?.plannedRevenue || 0;
    });
    
    prevWeekDays.forEach(day => {
      const budget = dailyBudgets[format(day, 'yyyy-MM-dd')];
      prevTotal += budget?.actualRevenue || 0;
      prevPlan += budget?.plannedRevenue || 0;
    });
    
    const diff = currentTotal - prevTotal;
    const diffPercent = prevTotal > 0 ? (diff / prevTotal) * 100 : 0;
    
    return {
      currentTotal,
      prevTotal,
      currentPlan,
      diff,
      diffPercent,
      currentWeekLabel: `KW ${format(currentWeekStart, 'w')}`,
      prevWeekLabel: `KW ${format(prevWeekStart, 'w')}`
    };
  }, [dailyBudgets, selectedDate]);

  // Calculate month comparison data
  const monthComparison = useMemo(() => {
    if (!dailyBudgets || !selectedDate) return null;
    
    const currentMonthStart = startOfMonth(selectedDate);
    const currentMonthEnd = endOfMonth(selectedDate);
    const prevMonthStart = startOfMonth(subMonths(selectedDate, 1));
    const prevMonthEnd = endOfMonth(subMonths(selectedDate, 1));
    
    const currentMonthDays = eachDayOfInterval({ start: currentMonthStart, end: currentMonthEnd });
    const prevMonthDays = eachDayOfInterval({ start: prevMonthStart, end: prevMonthEnd });
    
    let currentTotal = 0, prevTotal = 0;
    let currentPlan = 0, prevPlan = 0;
    
    currentMonthDays.forEach(day => {
      const budget = dailyBudgets[format(day, 'yyyy-MM-dd')];
      currentTotal += budget?.actualRevenue || 0;
      currentPlan += budget?.plannedRevenue || 0;
    });
    
    prevMonthDays.forEach(day => {
      const budget = dailyBudgets[format(day, 'yyyy-MM-dd')];
      prevTotal += budget?.actualRevenue || 0;
      prevPlan += budget?.plannedRevenue || 0;
    });
    
    const diff = currentTotal - prevTotal;
    const diffPercent = prevTotal > 0 ? (diff / prevTotal) * 100 : 0;
    
    return {
      currentTotal,
      prevTotal,
      currentPlan,
      diff,
      diffPercent,
      currentMonthLabel: format(currentMonthStart, 'MMMM yyyy', { locale: de }),
      prevMonthLabel: format(prevMonthStart, 'MMMM yyyy', { locale: de })
    };
  }, [dailyBudgets, selectedDate]);

  return (
    <div className="flex items-center gap-2">
      {/* Plan-Umsatz */}
      <div className="flex-1 p-2 rounded-md border bg-muted/30">
        <div className="flex items-center gap-1.5 mb-1">
          <Target className="h-3 w-3 text-muted-foreground" />
          <Label htmlFor="planned" className="text-[10px] font-medium text-muted-foreground">
            Plan-Umsatz
          </Label>
        </div>
        <Input
          id="planned"
          type="number"
          step="0.01"
          min="0"
          value={plannedInput}
          onChange={(e) => setPlannedInput(e.target.value)}
          onBlur={handlePlannedBlur}
          className="input-currency text-base font-semibold h-8 px-2"
        />
      </div>

      {/* Variance Indicator with Sparkline */}
      <div className={cn(
        "flex flex-col items-center justify-center px-2 py-1 rounded-md min-w-[90px]",
        isPositive && "bg-green-50 dark:bg-green-950/30",
        isNegative && "bg-red-50 dark:bg-red-950/30",
        !isPositive && !isNegative && "bg-muted/30"
      )}>
        {/* Sparkline */}
        {dailyBudgets && selectedDate && (
          <div className="mb-0.5">
            <MiniSparkline data={sparklineData} height={20} />
          </div>
        )}
        
        {/* Variance values */}
        <div className="flex items-center gap-0.5">
          {isPositive && <TrendingUp className="h-2.5 w-2.5 text-green-600" />}
          {isNegative && <TrendingDown className="h-2.5 w-2.5 text-destructive" />}
          {!isPositive && !isNegative && <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
          <span className={cn(
            "text-[10px] font-bold",
            isPositive && "text-green-600",
            isNegative && "text-destructive",
            !isPositive && !isNegative && "text-muted-foreground"
          )}>
            {variance >= 0 ? '+' : ''}{formatCurrency(variance)}
          </span>
        </div>
        <span className={cn(
          "text-[8px] font-medium",
          isPositive && "text-green-600/80",
          isNegative && "text-destructive/80",
          !isPositive && !isNegative && "text-muted-foreground"
        )}>
          {variancePercent >= 0 ? '+' : ''}{variancePercent.toFixed(1)}%
        </span>
      </div>

      {/* Ist-Umsatz */}
      <div className="flex-1 p-2 rounded-md border bg-muted/30">
        <div className="flex items-center gap-1.5 mb-1">
          <TrendingUp className="h-3 w-3 text-primary" />
          <Label htmlFor="actual" className="text-[10px] font-medium text-muted-foreground">
            Ist-Umsatz
          </Label>
        </div>
        <Input
          id="actual"
          type="number"
          step="0.01"
          min="0"
          value={actualInput}
          onChange={(e) => setActualInput(e.target.value)}
          onBlur={handleActualBlur}
          className="input-currency text-base font-semibold h-8 px-2"
        />
      </div>

      {/* Week Comparison */}
      {weekComparison && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn(
              "flex flex-col items-center justify-center px-2 py-1 rounded-md min-w-[75px] cursor-pointer",
              weekComparison.diff > 0 && "bg-green-50 dark:bg-green-950/30",
              weekComparison.diff < 0 && "bg-red-50 dark:bg-red-950/30",
              weekComparison.diff === 0 && "bg-muted/30"
            )}>
              <span className="text-[8px] text-muted-foreground font-medium">vs. Vorwoche</span>
              <div className="flex items-center gap-0.5">
                {weekComparison.diff > 0 && <TrendingUp className="h-2.5 w-2.5 text-green-600" />}
                {weekComparison.diff < 0 && <TrendingDown className="h-2.5 w-2.5 text-destructive" />}
                {weekComparison.diff === 0 && <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
                <span className={cn(
                  "text-[10px] font-bold",
                  weekComparison.diff > 0 && "text-green-600",
                  weekComparison.diff < 0 && "text-destructive",
                  weekComparison.diff === 0 && "text-muted-foreground"
                )}>
                  {weekComparison.diffPercent >= 0 ? '+' : ''}{weekComparison.diffPercent.toFixed(1)}%
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="p-2">
            <div className="space-y-1.5 text-[10px]">
              <div className="font-semibold border-b pb-1">Wochenvergleich</div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{weekComparison.currentWeekLabel} (aktuell)</span>
                <span className="font-medium">{formatCurrency(weekComparison.currentTotal)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{weekComparison.prevWeekLabel} (Vorwoche)</span>
                <span className="font-medium">{formatCurrency(weekComparison.prevTotal)}</span>
              </div>
              <div className="border-t pt-1 flex justify-between gap-4 font-semibold">
                <span>Differenz</span>
                <span className={cn(
                  weekComparison.diff > 0 && "text-green-600",
                  weekComparison.diff < 0 && "text-destructive"
                )}>
                  {weekComparison.diff >= 0 ? '+' : ''}{formatCurrency(weekComparison.diff)}
                </span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {/* Month Comparison */}
      {monthComparison && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={cn(
              "flex flex-col items-center justify-center px-2 py-1 rounded-md min-w-[75px] cursor-pointer",
              monthComparison.diff > 0 && "bg-green-50 dark:bg-green-950/30",
              monthComparison.diff < 0 && "bg-red-50 dark:bg-red-950/30",
              monthComparison.diff === 0 && "bg-muted/30"
            )}>
              <span className="text-[8px] text-muted-foreground font-medium">vs. Vormonat</span>
              <div className="flex items-center gap-0.5">
                {monthComparison.diff > 0 && <TrendingUp className="h-2.5 w-2.5 text-green-600" />}
                {monthComparison.diff < 0 && <TrendingDown className="h-2.5 w-2.5 text-destructive" />}
                {monthComparison.diff === 0 && <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
                <span className={cn(
                  "text-[10px] font-bold",
                  monthComparison.diff > 0 && "text-green-600",
                  monthComparison.diff < 0 && "text-destructive",
                  monthComparison.diff === 0 && "text-muted-foreground"
                )}>
                  {monthComparison.diffPercent >= 0 ? '+' : ''}{monthComparison.diffPercent.toFixed(1)}%
                </span>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="p-2">
            <div className="space-y-1.5 text-[10px]">
              <div className="font-semibold border-b pb-1">Monatsvergleich</div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{monthComparison.currentMonthLabel}</span>
                <span className="font-medium">{formatCurrency(monthComparison.currentTotal)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{monthComparison.prevMonthLabel}</span>
                <span className="font-medium">{formatCurrency(monthComparison.prevTotal)}</span>
              </div>
              <div className="border-t pt-1 flex justify-between gap-4 font-semibold">
                <span>Differenz</span>
                <span className={cn(
                  monthComparison.diff > 0 && "text-green-600",
                  monthComparison.diff < 0 && "text-destructive"
                )}>
                  {monthComparison.diff >= 0 ? '+' : ''}{formatCurrency(monthComparison.diff)}
                </span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
