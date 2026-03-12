import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, AreaChart, Area, ResponsiveContainer } from "recharts";
import { DailyBudget, grossToNet } from "@/types/personnel";
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isBefore, isToday } from "date-fns";
import { de } from "date-fns/locale";
import { TrendingUp, TrendingDown, AlertTriangle, Target, Calendar, ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

interface MonthlyRevenueComparisonProps {
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  showNetRevenue?: boolean;
}

interface DailyComparisonData {
  date: string;
  dayName: string;
  fullDate: string;
  planned: number;
  actual: number;
  previousYear: number;
  difference: number;
  differencePercent: number;
  isPast: boolean;
  isToday: boolean;
  hasActual: boolean;
}

const chartConfig = {
  planned: { label: "Budget/Plan", color: "hsl(217, 91%, 60%)" },
  actual: { label: "Ist-Umsatz", color: "hsl(142, 76%, 36%)" },
  previousYear: { label: "Vorjahr", color: "hsl(32, 95%, 44%)" },
};

export const MonthlyRevenueComparison = ({ dailyBudgets, selectedDate, showNetRevenue = false }: MonthlyRevenueComparisonProps) => {
  // Helper to convert revenue based on display mode
  const convertRevenue = (gross: number, takeaway: number = 0) => {
    if (!showNetRevenue) return gross;
    return grossToNet(gross, takeaway);
  };
  
  const comparisonData = useMemo(() => {
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const today = new Date();

    const dailyData: DailyComparisonData[] = daysInMonth.map((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const dayOfWeek = getDay(day);
      const dayNames = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
      const dayName = dayNames[dayOfWeek];
      const budget = dailyBudgets[dateStr];
      
      const plannedGross = budget?.plannedRevenue || 0;
      const actualGross = budget?.actualRevenue || 0;
      const previousYearGross = budget?.previousYearRevenue || 0;
      const takeaway = budget?.takeawayRevenue || 0;
      
      // Apply net conversion if enabled
      const planned = showNetRevenue ? grossToNet(plannedGross, takeaway) : plannedGross;
      const actual = showNetRevenue ? grossToNet(actualGross, takeaway) : actualGross;
      const previousYear = showNetRevenue ? grossToNet(previousYearGross, takeaway) : previousYearGross;
      
      const isPast = isBefore(day, today) && !isToday(day);
      const isTodayDate = isToday(day);
      const hasActual = actualGross > 0;
      
      const difference = hasActual ? actual - planned : 0;
      const differencePercent = planned > 0 && hasActual ? ((actual - planned) / planned) * 100 : 0;

      return {
        date: format(day, "dd"),
        dayName,
        fullDate: dateStr,
        planned,
        actual,
        previousYear,
        difference,
        differencePercent,
        isPast,
        isToday: isTodayDate,
        hasActual,
      };
    });

    return dailyData;
  }, [dailyBudgets, selectedDate, showNetRevenue]);

  // Cumulative YTD up to selected date
  const cumulativeYTD = useMemo(() => {
    const yearStart = new Date(selectedDate.getFullYear(), 0, 1);
    const daysUpToSelected = eachDayOfInterval({ start: yearStart, end: selectedDate });
    
    let cumulativeBudget = 0;
    let cumulativeActual = 0;
    let cumulativePreviousYear = 0;
    
    daysUpToSelected.forEach((day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      const budget = dailyBudgets[dateStr];
      if (budget) {
        cumulativeBudget += budget.plannedRevenue || 0;
        cumulativeActual += budget.actualRevenue || 0;
        cumulativePreviousYear += budget.previousYearRevenue || 0;
      }
    });
    
    return {
      budget: cumulativeBudget,
      actual: cumulativeActual,
      previousYear: cumulativePreviousYear,
      daysCount: daysUpToSelected.length,
    };
  }, [dailyBudgets, selectedDate]);

  // Cumulative YTD trend data for chart (monthly aggregated) with projections
  const cumulativeYTDTrend = useMemo(() => {
    const yearStart = new Date(selectedDate.getFullYear(), 0, 1);
    const monthsInYear = [];
    
    // Generate months from January up to selected date's month
    for (let month = 0; month <= selectedDate.getMonth(); month++) {
      const monthEnd = new Date(selectedDate.getFullYear(), month + 1, 0);
      const effectiveEnd = monthEnd > selectedDate ? selectedDate : monthEnd;
      monthsInYear.push({
        month,
        endDate: effectiveEnd,
        monthName: format(new Date(selectedDate.getFullYear(), month, 1), "MMM", { locale: de }),
      });
    }
    
    // Calculate cumulative values for each month end
    const trendData = monthsInYear.map(({ month, endDate, monthName }) => {
      const daysUpToMonth = eachDayOfInterval({ start: yearStart, end: endDate });
      
      let cumulativeBudget = 0;
      let cumulativeActual = 0;
      let cumulativePreviousYear = 0;
      
      daysUpToMonth.forEach((day) => {
        const dateStr = format(day, "yyyy-MM-dd");
        const budget = dailyBudgets[dateStr];
        if (budget) {
          cumulativeBudget += budget.plannedRevenue || 0;
          cumulativeActual += budget.actualRevenue || 0;
          cumulativePreviousYear += budget.previousYearRevenue || 0;
        }
      });
      
      return {
        month: monthName,
        monthIndex: month,
        budget: cumulativeBudget,
        actual: cumulativeActual,
        previousYear: cumulativePreviousYear,
        projection: null as number | null,
        isCurrentMonth: month === selectedDate.getMonth(),
        isProjection: false,
      };
    });
    
    // Calculate daily average from actual data for projections
    const currentMonthData = trendData.find(d => d.isCurrentMonth);
    const lastActual = currentMonthData?.actual || 0;
    const daysWithData = eachDayOfInterval({ start: yearStart, end: selectedDate }).length;
    const avgDailyActual = daysWithData > 0 ? lastActual / daysWithData : 0;
    
    // Add projection points for remaining months (current month end to December)
    const currentMonthIndex = selectedDate.getMonth();
    for (let month = currentMonthIndex; month <= 11; month++) {
      const monthEnd = new Date(selectedDate.getFullYear(), month + 1, 0);
      const monthName = format(new Date(selectedDate.getFullYear(), month, 1), "MMM", { locale: de });
      
      // Calculate days from selected date to this month's end
      const daysToMonthEnd = eachDayOfInterval({ start: selectedDate, end: monthEnd }).length - 1; // -1 to exclude selected date
      
      // Calculate cumulative budget up to this month end
      const daysUpToMonthEnd = eachDayOfInterval({ start: yearStart, end: monthEnd });
      let cumulativeBudget = 0;
      let cumulativePreviousYear = 0;
      daysUpToMonthEnd.forEach((day) => {
        const dateStr = format(day, "yyyy-MM-dd");
        const budget = dailyBudgets[dateStr];
        if (budget) {
          cumulativeBudget += budget.plannedRevenue || 0;
          cumulativePreviousYear += budget.previousYearRevenue || 0;
        }
      });
      
      const projectedActual = lastActual + (avgDailyActual * daysToMonthEnd);
      
      // For current month, update existing entry with projection
      if (month === currentMonthIndex) {
        const existingEntry = trendData.find(d => d.monthIndex === month);
        if (existingEntry) {
          existingEntry.projection = projectedActual;
        }
      } else {
        // Add new projection-only entries for future months
        trendData.push({
          month: monthName,
          monthIndex: month,
          budget: cumulativeBudget,
          actual: 0, // No actual data for future months
          previousYear: cumulativePreviousYear,
          projection: projectedActual,
          isCurrentMonth: false,
          isProjection: true,
        });
      }
    }
    
    // Sort by month index
    trendData.sort((a, b) => a.monthIndex - b.monthIndex);
    
    return trendData;
  }, [dailyBudgets, selectedDate]);

  const summary = useMemo(() => {
    const daysWithActual = comparisonData.filter(d => d.hasActual);
    
    const totalPlanned = daysWithActual.reduce((sum, d) => sum + d.planned, 0);
    const totalActual = daysWithActual.reduce((sum, d) => sum + d.actual, 0);
    const totalPreviousYear = daysWithActual.reduce((sum, d) => sum + d.previousYear, 0);
    
    const difference = totalActual - totalPlanned;
    const differencePercent = totalPlanned > 0 ? (difference / totalPlanned) * 100 : 0;
    
    const vsLastYear = totalPreviousYear > 0 ? ((totalActual - totalPreviousYear) / totalPreviousYear) * 100 : 0;
    
    const daysAhead = daysWithActual.filter(d => d.actual >= d.planned).length;
    const daysBehind = daysWithActual.filter(d => d.actual < d.planned && d.hasActual).length;
    
    const monthTotalPlanned = comparisonData.reduce((sum, d) => sum + d.planned, 0);
    const monthTotalPreviousYear = comparisonData.reduce((sum, d) => sum + d.previousYear, 0);
    
    const avgDailyActual = daysWithActual.length > 0 ? totalActual / daysWithActual.length : 0;
    const remainingDays = comparisonData.filter(d => !d.hasActual && !d.isPast && !d.isToday).length;
    const projectedTotal = totalActual + (avgDailyActual * remainingDays);
    const projectedDiff = projectedTotal - monthTotalPlanned;
    
    return {
      totalPlanned,
      totalActual,
      totalPreviousYear,
      difference,
      differencePercent,
      vsLastYear,
      daysAhead,
      daysBehind,
      daysWithActual: daysWithActual.length,
      monthTotalPlanned,
      monthTotalPreviousYear,
      projectedTotal,
      projectedDiff,
      avgDailyActual,
      remainingDays,
    };
  }, [comparisonData]);

  const getBarColor = (entry: DailyComparisonData) => {
    if (!entry.hasActual) return "hsl(var(--muted))";
    if (entry.actual >= entry.planned) return "hsl(142, 76%, 36%)";
    if (entry.actual >= entry.planned * 0.9) return "hsl(45, 93%, 47%)";
    return "hsl(346, 87%, 43%)";
  };

  const hasData = summary.daysWithActual > 0;

  return (
    <Collapsible defaultOpen>
      <Card className="border-primary/20">
        <CardHeader className="pb-2">
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center justify-between cursor-pointer group">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Target className="h-5 w-5 text-primary" />
                Umsatz: Plan vs. Ist vs. Vorjahr
              </CardTitle>
              <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </div>
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-6">
            {!hasData ? (
              <p className="text-center text-muted-foreground py-8">
                Noch keine Ist-Umsatzdaten für {format(selectedDate, "MMMM yyyy", { locale: de })} vorhanden.
              </p>
            ) : (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* Actual vs Plan - Main Card */}
                  <div className={cn(
                    "rounded-lg p-4 border-2 transition-all",
                    summary.difference >= 0 
                      ? "bg-green-50 dark:bg-green-950/30 border-green-300 dark:border-green-700" 
                      : "bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-700 shadow-lg shadow-red-100 dark:shadow-red-900/20"
                  )}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-muted-foreground">Ist vs. Budget</span>
                      {summary.difference >= 0 ? (
                        <TrendingUp className="h-5 w-5 text-green-600" />
                      ) : (
                        <TrendingDown className="h-5 w-5 text-red-600" />
                      )}
                    </div>
                    <p className={cn(
                      "text-2xl font-bold",
                      summary.difference >= 0 ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                    )}>
                      {summary.difference >= 0 ? "+" : ""}{summary.difference.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                    </p>
                    <p className={cn(
                      "text-sm font-semibold",
                      summary.difference >= 0 ? "text-green-600" : "text-red-600"
                    )}>
                      {summary.differencePercent >= 0 ? "+" : ""}{summary.differencePercent.toFixed(1)}% CHF
                    </p>
                  </div>

                  {/* Days Status */}
                  <div className="rounded-lg p-4 bg-muted/40 border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-muted-foreground">Tage Status</span>
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        <ArrowUp className="h-4 w-4 text-green-600" />
                        <span className="text-xl font-bold text-green-700 dark:text-green-400">{summary.daysAhead}</span>
                      </div>
                      <span className="text-muted-foreground font-bold">/</span>
                      <div className="flex items-center gap-1">
                        <ArrowDown className="h-4 w-4 text-red-600" />
                        <span className="text-xl font-bold text-red-700 dark:text-red-400">{summary.daysBehind}</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Über / Unter Plan</p>
                  </div>

                  {/* vs. Last Year */}
                  <div className="rounded-lg p-4 bg-muted/40 border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-muted-foreground">vs. Vorjahr</span>
                      {summary.vsLastYear >= 0 ? (
                        <TrendingUp className="h-4 w-4 text-green-600" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-amber-600" />
                      )}
                    </div>
                    <p className={cn(
                      "text-2xl font-bold",
                      summary.vsLastYear >= 0 ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"
                    )}>
                      {summary.vsLastYear >= 0 ? "+" : ""}{summary.vsLastYear.toFixed(1)}%
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(summary.totalActual - summary.totalPreviousYear).toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                    </p>
                  </div>

                  {/* Projection */}
                  <div className={cn(
                    "rounded-lg p-4 border-2",
                    summary.projectedDiff >= 0 
                      ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800" 
                      : "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700"
                  )}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-muted-foreground">Prognose Monat</span>
                      {summary.projectedDiff >= 0 ? (
                        <Target className="h-4 w-4 text-blue-600" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                      )}
                    </div>
                    <p className={cn(
                      "text-lg font-bold",
                      summary.projectedDiff >= 0 ? "text-blue-700 dark:text-blue-400" : "text-amber-700 dark:text-amber-400"
                    )}>
                      {summary.projectedTotal.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                    </p>
                    <p className={cn(
                      "text-xs font-medium",
                      summary.projectedDiff >= 0 ? "text-blue-600" : "text-amber-600"
                    )}>
                      {summary.projectedDiff >= 0 ? "+" : ""}{summary.projectedDiff.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF vs. Plan
                    </p>
                  </div>
                </div>

                {/* Cumulative YTD Display */}
                <div className="rounded-lg p-4 bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20">
                  <div className="flex items-center gap-2 mb-3">
                    <Calendar className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-semibold text-primary">
                      Kumuliert bis {format(selectedDate, "dd. MMMM yyyy", { locale: de })} (YTD)
                    </h4>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center p-3 rounded-lg bg-background/80 border">
                      <p className="text-xs text-muted-foreground mb-1">Budget YTD</p>
                      <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
                        {cumulativeYTD.budget.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                      </p>
                      <p className="text-xs text-muted-foreground">CHF</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-background/80 border">
                      <p className="text-xs text-muted-foreground mb-1">Ist YTD</p>
                      <p className={cn(
                        "text-lg font-bold",
                        cumulativeYTD.actual >= cumulativeYTD.budget 
                          ? "text-green-600 dark:text-green-400" 
                          : "text-red-600 dark:text-red-400"
                      )}>
                        {cumulativeYTD.actual.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                      </p>
                      <p className={cn(
                        "text-xs font-medium",
                        cumulativeYTD.actual >= cumulativeYTD.budget ? "text-green-600" : "text-red-600"
                      )}>
                        {cumulativeYTD.budget > 0 && (
                          <>
                            {cumulativeYTD.actual >= cumulativeYTD.budget ? "+" : ""}
                            {((cumulativeYTD.actual - cumulativeYTD.budget) / cumulativeYTD.budget * 100).toFixed(1)}%
                          </>
                        )}
                      </p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-background/80 border">
                      <p className="text-xs text-muted-foreground mb-1">Vorjahr YTD</p>
                      <p className="text-lg font-bold text-amber-600 dark:text-amber-400">
                        {cumulativeYTD.previousYear.toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                      </p>
                      <p className={cn(
                        "text-xs font-medium",
                        cumulativeYTD.actual >= cumulativeYTD.previousYear ? "text-green-600" : "text-amber-600"
                      )}>
                        {cumulativeYTD.previousYear > 0 && (
                          <>
                            {cumulativeYTD.actual >= cumulativeYTD.previousYear ? "+" : ""}
                            {((cumulativeYTD.actual - cumulativeYTD.previousYear) / cumulativeYTD.previousYear * 100).toFixed(1)}% vs. VJ
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* YTD Trend Chart */}
                  {cumulativeYTDTrend.length > 0 && (
                    <div className="mt-4">
                      <h5 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                        <TrendingUp className="h-3 w-3" />
                        Kumulierter Jahresverlauf
                      </h5>
                      <ChartContainer config={chartConfig} className="h-[220px] w-full">
                        <AreaChart data={cumulativeYTDTrend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="gradientBudget" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.05}/>
                            </linearGradient>
                            <linearGradient id="gradientActual" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.4}/>
                              <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.05}/>
                            </linearGradient>
                            <linearGradient id="gradientPreviousYear" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="hsl(32, 95%, 44%)" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="hsl(32, 95%, 44%)" stopOpacity={0.05}/>
                            </linearGradient>
                            <linearGradient id="gradientProjection" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="hsl(280, 70%, 50%)" stopOpacity={0.25}/>
                              <stop offset="95%" stopColor="hsl(280, 70%, 50%)" stopOpacity={0.02}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted/50" />
                          <XAxis 
                            dataKey="month" 
                            className="text-xs" 
                            tick={{ fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                          />
                          <YAxis 
                            className="text-xs" 
                            tickFormatter={(v) => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}k`}
                            axisLine={false}
                            tickLine={false}
                            width={45}
                          />
                          <ChartTooltip 
                            content={({ active, payload, label }) => {
                              if (!active || !payload?.length) return null;
                              const data = payload[0]?.payload;
                              const isProjectionMonth = data.isProjection || data.projection !== null;
                              
                              // Get year-end projection data (December)
                              const yearEndData = cumulativeYTDTrend.find(d => d.monthIndex === 11);
                              const yearEndProjection = yearEndData?.projection || 0;
                              const yearEndBudget = yearEndData?.budget || 0;
                              const yearEndDiff = yearEndProjection - yearEndBudget;
                              
                              return (
                                <div className="rounded-lg border bg-background p-3 shadow-lg">
                                  <p className="font-semibold mb-2">
                                    {label} {selectedDate.getFullYear()}
                                    {data.isProjection && <span className="text-purple-600 text-xs ml-2">(Prognose)</span>}
                                  </p>
                                  <div className="space-y-1.5 text-sm">
                                    <div className="flex justify-between gap-6">
                                      <span className="text-blue-600 font-medium flex items-center gap-1">
                                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                                        Budget:
                                      </span>
                                      <span className="font-mono font-medium">{data.budget.toLocaleString("de-CH")} CHF</span>
                                    </div>
                                    {data.actual > 0 && (
                                      <div className="flex justify-between gap-6">
                                        <span className="text-green-600 font-medium flex items-center gap-1">
                                          <div className="w-2 h-2 rounded-full bg-green-500" />
                                          Ist:
                                        </span>
                                        <span className="font-mono font-medium">{data.actual.toLocaleString("de-CH")} CHF</span>
                                      </div>
                                    )}
                                    {data.projection !== null && (
                                      <div className="flex justify-between gap-6">
                                        <span className="text-purple-600 font-medium flex items-center gap-1">
                                          <div className="w-2 h-2 rounded-full bg-purple-500" />
                                          Prognose:
                                        </span>
                                        <span className="font-mono font-medium">{Math.round(data.projection).toLocaleString("de-CH")} CHF</span>
                                      </div>
                                    )}
                                    <div className="flex justify-between gap-6">
                                      <span className="text-amber-600 font-medium flex items-center gap-1">
                                        <div className="w-2 h-2 rounded-full bg-amber-500" />
                                        Vorjahr:
                                      </span>
                                      <span className="font-mono">{data.previousYear.toLocaleString("de-CH")} CHF</span>
                                    </div>
                                    {data.projection !== null && data.budget > 0 && (
                                      <div className={cn(
                                        "flex justify-between gap-6 pt-2 border-t font-semibold",
                                        data.projection >= data.budget ? "text-green-600" : "text-red-600"
                                      )}>
                                        <span>Prognose vs. Budget:</span>
                                        <span className="font-mono">
                                          {data.projection >= data.budget ? "+" : ""}
                                          {((data.projection - data.budget) / data.budget * 100).toFixed(1)}%
                                        </span>
                                      </div>
                                    )}
                                    {data.actual > 0 && data.budget > 0 && !data.isProjection && (
                                      <div className={cn(
                                        "flex justify-between gap-6 pt-2 border-t font-semibold",
                                        data.actual >= data.budget ? "text-green-600" : "text-red-600"
                                      )}>
                                        <span>vs. Budget:</span>
                                        <span className="font-mono">
                                          {data.actual >= data.budget ? "+" : ""}
                                          {((data.actual - data.budget) / data.budget * 100).toFixed(1)}%
                                        </span>
                                      </div>
                                    )}
                                    {/* Cumulative YTD up to selected date */}
                                    {(cumulativeYTD.budget > 0 || cumulativeYTD.actual > 0 || cumulativeYTD.previousYear > 0) && (
                                      <div className="mt-2 pt-2 border-t border-dashed space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">
                                          Kumuliert bis {format(selectedDate, "dd.MM.yyyy", { locale: de })}
                                        </p>
                                        <div className="flex justify-between gap-6">
                                          <span className="text-blue-600 font-medium text-xs">Budget:</span>
                                          <span className="font-mono font-medium text-xs">{Math.round(cumulativeYTD.budget).toLocaleString("de-CH")} CHF</span>
                                        </div>
                                        <div className="flex justify-between gap-6">
                                          <span className="text-green-600 font-medium text-xs">Ist:</span>
                                          <span className="font-mono font-medium text-xs">{Math.round(cumulativeYTD.actual).toLocaleString("de-CH")} CHF</span>
                                        </div>
                                        <div className="flex justify-between gap-6">
                                          <span className="text-amber-600 font-medium text-xs">Vorjahr:</span>
                                          <span className="font-mono font-medium text-xs">{Math.round(cumulativeYTD.previousYear).toLocaleString("de-CH")} CHF</span>
                                        </div>
                                      </div>
                                    )}
                                    {/* Year-end projection summary */}
                                    {yearEndProjection > 0 && (
                                      <div className="mt-2 pt-2 border-t border-dashed space-y-1">
                                        <p className="text-xs font-medium text-muted-foreground">Jahresprognose Dez. {selectedDate.getFullYear()}</p>
                                        <div className="flex justify-between gap-6">
                                          <span className="text-purple-600 font-medium text-xs">Erwartetes Jahresergebnis:</span>
                                          <span className="font-mono font-medium text-xs">{Math.round(yearEndProjection).toLocaleString("de-CH")} CHF</span>
                                        </div>
                                        <div className={cn(
                                          "flex justify-between gap-6 font-semibold text-xs",
                                          yearEndDiff >= 0 ? "text-green-600" : "text-red-600"
                                        )}>
                                          <span>{yearEndDiff >= 0 ? "Überschuss" : "Rückstand"} vs. Budget:</span>
                                          <span className="font-mono">
                                            {yearEndDiff >= 0 ? "+" : ""}{Math.round(yearEndDiff).toLocaleString("de-CH")} CHF
                                          </span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey="budget"
                            name="Budget"
                            stroke="hsl(217, 91%, 60%)"
                            strokeWidth={2}
                            fill="url(#gradientBudget)"
                          />
                          <Area
                            type="monotone"
                            dataKey="previousYear"
                            name="Vorjahr"
                            stroke="hsl(32, 95%, 44%)"
                            strokeWidth={2}
                            strokeDasharray="4 4"
                            fill="url(#gradientPreviousYear)"
                          />
                          <Area
                            type="monotone"
                            dataKey="actual"
                            name="Ist"
                            stroke="hsl(142, 76%, 36%)"
                            strokeWidth={2.5}
                            fill="url(#gradientActual)"
                            connectNulls={false}
                          />
                          {/* Projection line */}
                          <Area
                            type="monotone"
                            dataKey="projection"
                            name="Prognose"
                            stroke="hsl(280, 70%, 50%)"
                            strokeWidth={2}
                            strokeDasharray="6 3"
                            fill="url(#gradientProjection)"
                            connectNulls
                          />
                          {/* Vertical marker for current/selected month */}
                          <ReferenceLine
                            x={format(selectedDate, "MMM", { locale: de })}
                            stroke="hsl(var(--primary))"
                            strokeWidth={2}
                            strokeDasharray="4 4"
                            label={{
                              value: "Heute",
                              position: "top",
                              fill: "hsl(var(--primary))",
                              fontSize: 10,
                              fontWeight: 600,
                            }}
                          />
                        </AreaChart>
                      </ChartContainer>
                      
                      {/* Chart Legend */}
                      <div className="flex flex-wrap justify-center gap-4 mt-2 text-xs">
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-0.5 bg-blue-500" />
                          <span className="text-muted-foreground">Budget kumuliert</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-0.5 bg-green-600" style={{ height: 3 }} />
                          <span className="text-muted-foreground">Ist kumuliert</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-0.5 bg-purple-500" style={{ borderTop: "2px dashed hsl(280, 70%, 50%)" }} />
                          <span className="text-muted-foreground">Prognose</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <div className="w-3 h-0.5 bg-amber-500" style={{ borderTop: "2px dashed hsl(32, 95%, 44%)" }} />
                          <span className="text-muted-foreground">Vorjahr kumuliert</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Detailed Deficit Alert */}
                {summary.difference < 0 && (
                  <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/40 border-2 border-red-300 dark:border-red-700 shadow-md">
                    <div className="flex items-start gap-3">
                      <div className="rounded-full bg-red-100 dark:bg-red-900/50 p-2">
                        <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
                      </div>
                      <div className="flex-1 space-y-3">
                        <div>
                          <h4 className="font-bold text-red-800 dark:text-red-300 text-lg">
                            Umsatz-Rückstand
                          </h4>
                          <p className="text-2xl font-bold text-red-700 dark:text-red-400">
                            {Math.abs(summary.difference).toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                          </p>
                        </div>
                        
                        <div className="grid md:grid-cols-3 gap-4 pt-2 border-t border-red-200 dark:border-red-800">
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-red-800 dark:text-red-300">Tage unter Plan</p>
                            <p className="text-xl font-bold text-red-700 dark:text-red-400">
                              {summary.daysBehind} <span className="text-sm font-normal text-red-600">von {summary.daysWithActual}</span>
                            </p>
                            <p className="text-xs text-red-600 dark:text-red-500">
                              Ø Differenz: {(summary.difference / summary.daysWithActual).toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF/Tag
                            </p>
                          </div>
                          
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-red-800 dark:text-red-300">Aufholbedarf</p>
                            <p className="text-xl font-bold text-red-700 dark:text-red-400">
                              +{Math.abs(summary.difference / Math.max(1, summary.remainingDays)).toLocaleString("de-CH", { maximumFractionDigits: 0 })}
                            </p>
                            <p className="text-xs text-red-600 dark:text-red-500">
                              CHF/Tag extra ({summary.remainingDays} Tage übrig)
                            </p>
                          </div>
                          
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-red-800 dark:text-red-300">Performance</p>
                            <p className="text-xl font-bold text-red-700 dark:text-red-400">
                              {summary.avgDailyActual.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                            </p>
                            <p className="text-xs text-red-600 dark:text-red-500">
                              Ø Ist (Ziel: {(summary.monthTotalPlanned / comparisonData.length).toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF)
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Success Alert */}
                {summary.difference > 0 && (
                  <div className="rounded-lg p-4 bg-green-50 dark:bg-green-950/30 border-2 border-green-300 dark:border-green-700">
                    <div className="flex items-start gap-3">
                      <div className="rounded-full bg-green-100 dark:bg-green-900/50 p-2">
                        <TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <h4 className="font-bold text-green-800 dark:text-green-300 text-lg">
                          Umsatz-Vorsprung: +{summary.difference.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                        </h4>
                        <p className="text-sm text-green-700 dark:text-green-400 mt-1">
                          {summary.daysAhead} von {summary.daysWithActual} Tagen über Plan.
                          {summary.remainingDays > 0 && ` Prognose: +${summary.projectedDiff.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF über Monatsplan.`}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Daily Chart */}
                <div>
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    Täglicher Vergleich - {format(selectedDate, "MMMM yyyy", { locale: de })}
                  </h4>
                  <ChartContainer config={chartConfig} className="h-[280px] w-full">
                    <ComposedChart data={comparisonData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 10 }} interval={0} />
                      <YAxis className="text-xs" tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                      <ChartTooltip 
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const data = payload[0]?.payload as DailyComparisonData;
                          return (
                            <div className="rounded-lg border bg-background p-3 shadow-lg">
                              <p className="font-semibold mb-2">{data.dayName}, {data.date}. {format(selectedDate, "MMM", { locale: de })}</p>
                              <div className="space-y-1.5 text-sm">
                                <div className="flex justify-between gap-6">
                                  <span className="text-blue-600 font-medium">Plan:</span>
                                  <span className="font-mono font-medium">{data.planned.toLocaleString("de-CH")} CHF</span>
                                </div>
                                <div className="flex justify-between gap-6">
                                  <span className="text-green-600 font-medium">Ist:</span>
                                  <span className="font-mono font-medium">{data.actual.toLocaleString("de-CH")} CHF</span>
                                </div>
                                <div className="flex justify-between gap-6">
                                  <span className="text-amber-600 font-medium">Vorjahr:</span>
                                  <span className="font-mono">{data.previousYear.toLocaleString("de-CH")} CHF</span>
                                </div>
                                {data.hasActual && (
                                  <div className={cn(
                                    "flex justify-between gap-6 pt-2 border-t font-semibold",
                                    data.difference >= 0 ? "text-green-600" : "text-red-600"
                                  )}>
                                    <span>Differenz:</span>
                                    <span className="font-mono">
                                      {data.difference >= 0 ? "+" : ""}{data.difference.toLocaleString("de-CH")} CHF
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="planned" name="Budget/Plan" fill="hsl(217, 91%, 60%)" fillOpacity={0.25} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="actual" name="Ist-Umsatz" radius={[4, 4, 0, 0]}>
                        {comparisonData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={getBarColor(entry)} />
                        ))}
                      </Bar>
                      <Line 
                        type="monotone"
                        dataKey="previousYear"
                        name="Vorjahr"
                        stroke="hsl(32, 95%, 44%)"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        activeDot={{ r: 4 }}
                      />
                    </ComposedChart>
                  </ChartContainer>
                  
                  {/* Legend */}
                  <div className="flex flex-wrap justify-center gap-4 mt-3 text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-blue-500 opacity-25 border border-blue-500" />
                      <span className="text-muted-foreground">Plan/Budget</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-green-600" />
                      <span className="text-muted-foreground">Ist (≥ Plan)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-yellow-500" />
                      <span className="text-muted-foreground">Ist (90-99%)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded bg-red-600" />
                      <span className="text-muted-foreground">Ist (&lt;90%)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-4 h-0.5 bg-amber-500" />
                      <span className="text-muted-foreground">Vorjahr</span>
                    </div>
                  </div>
                </div>

                {/* Summary Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">Kennzahl</th>
                        <th className="text-right py-2 font-medium text-blue-600">Plan</th>
                        <th className="text-right py-2 font-medium text-green-600">Ist</th>
                        <th className="text-right py-2 font-medium text-amber-600">Vorjahr</th>
                        <th className="text-right py-2 font-medium">Differenz</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">Bisheriger Umsatz ({summary.daysWithActual} Tage)</td>
                        <td className="text-right py-2 font-mono">{summary.totalPlanned.toLocaleString("de-CH")} CHF</td>
                        <td className="text-right py-2 font-mono font-medium">{summary.totalActual.toLocaleString("de-CH")} CHF</td>
                        <td className="text-right py-2 font-mono">{summary.totalPreviousYear.toLocaleString("de-CH")} CHF</td>
                        <td className={cn(
                          "text-right py-2 font-mono font-bold",
                          summary.difference >= 0 ? "text-green-600" : "text-red-600"
                        )}>
                          {summary.difference >= 0 ? "+" : ""}{summary.difference.toLocaleString("de-CH")} CHF
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">Tages-Durchschnitt</td>
                        <td className="text-right py-2 font-mono">
                          {summary.daysWithActual > 0 ? (summary.totalPlanned / summary.daysWithActual).toLocaleString("de-CH", { maximumFractionDigits: 0 }) : 0} CHF
                        </td>
                        <td className="text-right py-2 font-mono font-medium">
                          {summary.avgDailyActual.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                        </td>
                        <td className="text-right py-2 font-mono">
                          {summary.daysWithActual > 0 ? (summary.totalPreviousYear / summary.daysWithActual).toLocaleString("de-CH", { maximumFractionDigits: 0 }) : 0} CHF
                        </td>
                        <td className={cn(
                          "text-right py-2 font-mono font-bold",
                          summary.difference >= 0 ? "text-green-600" : "text-red-600"
                        )}>
                          {summary.daysWithActual > 0 ? (
                            <>
                              {summary.difference / summary.daysWithActual >= 0 ? "+" : ""}
                              {(summary.difference / summary.daysWithActual).toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                            </>
                          ) : "-"}
                        </td>
                      </tr>
                      <tr className={cn(
                        "font-medium",
                        summary.projectedDiff >= 0 ? "bg-green-50 dark:bg-green-950/20" : "bg-red-50 dark:bg-red-950/20"
                      )}>
                        <td className="py-2">Monats-Prognose</td>
                        <td className="text-right py-2 font-mono text-blue-600">
                          {summary.monthTotalPlanned.toLocaleString("de-CH")} CHF
                        </td>
                        <td className={cn(
                          "text-right py-2 font-mono font-bold",
                          summary.projectedDiff >= 0 ? "text-green-600" : "text-red-600"
                        )}>
                          ~ {summary.projectedTotal.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                        </td>
                        <td className="text-right py-2 font-mono text-amber-600">
                          {summary.monthTotalPreviousYear.toLocaleString("de-CH")} CHF
                        </td>
                        <td className={cn(
                          "text-right py-2 font-mono font-bold",
                          summary.projectedDiff >= 0 ? "text-green-600" : "text-red-600"
                        )}>
                          {summary.projectedDiff >= 0 ? "+" : ""}{summary.projectedDiff.toLocaleString("de-CH", { maximumFractionDigits: 0 })} CHF
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
