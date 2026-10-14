import { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Employee, TimeEntry, DailyBudget } from '@/types/personnel';
import { AlertTriangle, TrendingDown, TrendingUp, Target, Settings, FileDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { exportLaborCostQuoteReport, exportLaborCostQuoteMonthlyReport } from '@/lib/pdf-export';
import { useEmployerRateMap } from '@/hooks/useEmployerRateMap';
interface LaborCostQuoteDisplayProps {
  employees: Employee[];
  timeEntries: TimeEntry[];
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
}

export const LaborCostQuoteDisplay = ({
  employees,
  timeEntries,
  dailyBudgets,
  selectedDate,
}: LaborCostQuoteDisplayProps) => {
  const [thresholdService, setThresholdService] = useState(40);
  const [thresholdKueche, setThresholdKueche] = useState(35);
  // Kosten = Total Arbeitgeberkosten (Bruttolohn + AG-Sozialkosten), nie roher hourlyWage.
  const { rateById, rates } = useEmployerRateMap(employees);
  const dateString = format(selectedDate, 'yyyy-MM-dd');

  // Use average threshold for general display
  const threshold = Math.round((thresholdService + thresholdKueche) / 2);

  // Calculate costs for a specific date
  const getCostsForDate = (date: string, mode: 'planned' | 'actual') => {
    const dayEntries = timeEntries.filter((te) => te.date === date);
    return dayEntries.reduce((sum, entry) => {
      const employee = employees.find((e) => e.id === entry.employeeId);
      if (!employee) return sum;
      const hours = mode === 'planned' ? (entry.plannedHours || 0) : (entry.actualHours || 0);
      return sum + hours * (rateById.get(employee.id) ?? 0);
    }, 0);
  };

  const getRevenueForDate = (date: string, mode: 'planned' | 'actual') => {
    const budget = dailyBudgets[date];
    if (!budget) return 0;
    return mode === 'planned' ? (budget.plannedRevenue || 0) : (budget.actualRevenue || 0);
  };

  // Daily calculations
  const dailyActualCosts = getCostsForDate(dateString, 'actual');
  const dailyPlannedCosts = getCostsForDate(dateString, 'planned');
  const dailyActualRevenue = getRevenueForDate(dateString, 'actual');
  const dailyPlannedRevenue = getRevenueForDate(dateString, 'planned');
  
  const dailyActualQuote = dailyActualRevenue > 0 ? (dailyActualCosts / dailyActualRevenue) * 100 : 0;
  const dailyPlannedQuote = dailyPlannedRevenue > 0 ? (dailyPlannedCosts / dailyPlannedRevenue) * 100 : 0;

  // Weekly calculations
  const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const weeklyData = useMemo(() => {
    let actualCosts = 0;
    let plannedCosts = 0;
    let actualRevenue = 0;
    let plannedRevenue = 0;

    weekDays.forEach((day) => {
      const ds = format(day, 'yyyy-MM-dd');
      actualCosts += getCostsForDate(ds, 'actual');
      plannedCosts += getCostsForDate(ds, 'planned');
      actualRevenue += getRevenueForDate(ds, 'actual');
      plannedRevenue += getRevenueForDate(ds, 'planned');
    });

    return {
      actualCosts,
      plannedCosts,
      actualRevenue,
      plannedRevenue,
      actualQuote: actualRevenue > 0 ? (actualCosts / actualRevenue) * 100 : 0,
      plannedQuote: plannedRevenue > 0 ? (plannedCosts / plannedRevenue) * 100 : 0,
    };
  }, [weekDays, timeEntries, dailyBudgets, employees]);

  // Monthly calculations
  const monthStart = startOfMonth(selectedDate);
  const monthEnd = endOfMonth(selectedDate);
  const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

  const monthlyData = useMemo(() => {
    let actualCosts = 0;
    let plannedCosts = 0;
    let actualRevenue = 0;
    let plannedRevenue = 0;

    monthDays.forEach((day) => {
      const ds = format(day, 'yyyy-MM-dd');
      actualCosts += getCostsForDate(ds, 'actual');
      plannedCosts += getCostsForDate(ds, 'planned');
      actualRevenue += getRevenueForDate(ds, 'actual');
      plannedRevenue += getRevenueForDate(ds, 'planned');
    });

    return {
      actualCosts,
      plannedCosts,
      actualRevenue,
      plannedRevenue,
      actualQuote: actualRevenue > 0 ? (actualCosts / actualRevenue) * 100 : 0,
      plannedQuote: plannedRevenue > 0 ? (plannedCosts / plannedRevenue) * 100 : 0,
    };
  }, [monthDays, timeEntries, dailyBudgets, employees]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('de-CH', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return value.toFixed(1).replace('.', ',');
  };

  const QuoteBar = ({ 
    quote, 
    label, 
    isPlanned = false 
  }: { 
    quote: number; 
    label: string;
    isPlanned?: boolean;
  }) => {
    const isOverThreshold = quote > threshold;
    const percentage = Math.min(quote, 100);
    
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{label}</span>
          <div className="flex items-center gap-1">
            {isOverThreshold && (
              <AlertTriangle className="h-4 w-4 text-destructive animate-pulse" />
            )}
            <span className={cn(
              "text-lg font-bold",
              isOverThreshold ? "text-destructive" : "text-green-600",
              isPlanned && "text-blue-600"
            )}>
              {formatPercent(quote)}%
            </span>
          </div>
        </div>
        <div className="h-3 bg-muted rounded-full overflow-hidden relative">
          {/* Threshold line */}
          <div 
            className="absolute top-0 bottom-0 w-0.5 bg-destructive z-10"
            style={{ left: `${Math.min(threshold, 100)}%` }}
          />
          {/* Quote bar */}
          <div 
            className={cn(
              "h-full rounded-full transition-all duration-500",
              isOverThreshold 
                ? "bg-gradient-to-r from-red-400 to-destructive" 
                : isPlanned 
                  ? "bg-gradient-to-r from-blue-400 to-blue-600"
                  : "bg-gradient-to-r from-green-400 to-green-600"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    );
  };

  const QuoteCard = ({
    title,
    actualQuote,
    plannedQuote,
    actualCosts,
    plannedCosts,
    actualRevenue,
    plannedRevenue,
  }: {
    title: string;
    actualQuote: number;
    plannedQuote: number;
    actualCosts: number;
    plannedCosts: number;
    actualRevenue: number;
    plannedRevenue: number;
  }) => {
    const isActualOverThreshold = actualQuote > threshold;
    const isPlannedOverThreshold = plannedQuote > threshold;

    return (
      <div className={cn(
        "p-4 rounded-lg border space-y-3",
        isActualOverThreshold && "border-destructive/50 bg-destructive/5"
      )}>
        <div className="flex items-center justify-between">
          <h4 className="font-semibold">{title}</h4>
          {isActualOverThreshold && (
            <div className="flex items-center gap-1 text-destructive text-xs font-medium animate-pulse">
              <AlertTriangle className="h-3 w-3" />
              Über {threshold}%
            </div>
          )}
        </div>
        
        <QuoteBar quote={actualQuote} label="Ist-Quote" />
        <QuoteBar quote={plannedQuote} label="Plan-Quote" isPlanned />
        
        <div className="grid grid-cols-2 gap-2 pt-2 border-t text-xs">
          <div>
            <div className="text-muted-foreground">Ist-Kosten</div>
            <div className="font-medium">CHF {formatCurrency(actualCosts)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Ist-Umsatz</div>
            <div className="font-medium">CHF {formatCurrency(actualRevenue)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Plan-Kosten</div>
            <div className="font-medium text-blue-600">CHF {formatCurrency(plannedCosts)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Plan-Umsatz</div>
            <div className="font-medium text-blue-600">CHF {formatCurrency(plannedRevenue)}</div>
          </div>
        </div>
      </div>
    );
  };

  const handleExportWeeklyPDF = () => {
    exportLaborCostQuoteReport(selectedDate, employees, timeEntries, dailyBudgets, { service: thresholdService, küche: thresholdKueche }, rates);
  };

  const handleExportMonthlyPDF = () => {
    exportLaborCostQuoteMonthlyReport(selectedDate, employees, timeEntries, dailyBudgets, { service: thresholdService, küche: thresholdKueche }, rates);
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <TrendingDown className="h-5 w-5" />
            Personalkostenquote
          </CardTitle>
          
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExportWeeklyPDF} className="gap-1">
              <FileDown className="h-3 w-3" />
              Woche PDF
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportMonthlyPDF} className="gap-1">
              <FileDown className="h-3 w-3" />
              Monat PDF
            </Button>
            
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1">
                  <Settings className="h-3 w-3" />
                  Schwellwerte
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="threshold-service">Service Schwellwert (%)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="threshold-service"
                        type="number"
                        value={thresholdService}
                        onChange={(e) => setThresholdService(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))}
                        min={0}
                        max={100}
                        step={1}
                        className="w-20"
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="threshold-kueche">Küche Schwellwert (%)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="threshold-kueche"
                        type="number"
                        value={thresholdKueche}
                        onChange={(e) => setThresholdKueche(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)))}
                        min={0}
                        max={100}
                        step={1}
                        className="w-20"
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Separate Schwellwerte für Service und Küche
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        
        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-gradient-to-r from-green-400 to-green-600" />
            <span>Unter Schwellwert</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-gradient-to-r from-red-400 to-destructive" />
            <span>Über Schwellwert</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-0.5 h-3 bg-destructive" />
            <span>{threshold}% Grenze</span>
          </div>
        </div>
      </CardHeader>
      
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <QuoteCard
            title={format(selectedDate, 'EEEE, d. MMM', { locale: de })}
            actualQuote={dailyActualQuote}
            plannedQuote={dailyPlannedQuote}
            actualCosts={dailyActualCosts}
            plannedCosts={dailyPlannedCosts}
            actualRevenue={dailyActualRevenue}
            plannedRevenue={dailyPlannedRevenue}
          />
          
          <QuoteCard
            title={`KW ${format(selectedDate, 'w', { locale: de })}`}
            actualQuote={weeklyData.actualQuote}
            plannedQuote={weeklyData.plannedQuote}
            actualCosts={weeklyData.actualCosts}
            plannedCosts={weeklyData.plannedCosts}
            actualRevenue={weeklyData.actualRevenue}
            plannedRevenue={weeklyData.plannedRevenue}
          />
          
          <QuoteCard
            title={format(selectedDate, 'MMMM yyyy', { locale: de })}
            actualQuote={monthlyData.actualQuote}
            plannedQuote={monthlyData.plannedQuote}
            actualCosts={monthlyData.actualCosts}
            plannedCosts={monthlyData.plannedCosts}
            actualRevenue={monthlyData.actualRevenue}
            plannedRevenue={monthlyData.plannedRevenue}
          />
        </div>
      </CardContent>
    </Card>
  );
};
