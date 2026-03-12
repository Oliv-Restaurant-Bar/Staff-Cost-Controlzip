import { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, startOfWeek, endOfWeek, isSameMonth, addWeeks, getISOWeek } from 'date-fns';
import { useWeekSync } from '@/hooks/useWeekSync';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { DailyBudget, RevenueImportEntry } from '@/types/personnel';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Save, Copy, Calendar, CalendarDays, Target, TrendingUp, History, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { RevenueImportButton } from '@/components/RevenueImportButton';

interface PlannedRevenueEditorProps {
  dailyBudgets: Record<string, DailyBudget>;
  selectedDate: Date;
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue' | 'previousYearRevenue', value: number) => void;
  onImportRevenue?: (entries: RevenueImportEntry[]) => void;
  onSetFixedBudget?: (date: string, value: number) => void;
  showNetRevenue?: boolean;
}

const WEEKDAYS = [
  { key: 1, label: 'Montag', short: 'Mo' },
  { key: 2, label: 'Dienstag', short: 'Di' },
  { key: 3, label: 'Mittwoch', short: 'Mi' },
  { key: 4, label: 'Donnerstag', short: 'Do' },
  { key: 5, label: 'Freitag', short: 'Fr' },
  { key: 6, label: 'Samstag', short: 'Sa' },
  { key: 0, label: 'Sonntag', short: 'So' },
];

const STEP = 500;

type ViewMode = 'weekdays' | 'week' | 'month';
type RevenueMode = 'planned' | 'actual' | 'previousYear';

export const PlannedRevenueEditor = ({
  dailyBudgets,
  selectedDate,
  onBudgetUpdate,
  onImportRevenue,
  onSetFixedBudget,
  showNetRevenue = false,
}: PlannedRevenueEditorProps) => {
  const { currentWeekStart, currentMonthStart, navigateWeek, navigateMonth, weekNumber } = useWeekSync('PlannedRevenueEditor', selectedDate);
  const [viewMode, setViewMode] = useState<ViewMode>('weekdays');
  const [revenueMode, setRevenueMode] = useState<RevenueMode>('planned');
  const [weekdayBudgets, setWeekdayBudgets] = useState<Record<number, number>>({
    1: 4000, // Monday
    2: 4000, // Tuesday
    3: 5000, // Wednesday
    4: 5000, // Thursday
    5: 8000, // Friday
    6: 10000, // Saturday
    0: 0, // Sunday (closed)
  });
  const [monthlyRevenueInput, setMonthlyRevenueInput] = useState<string>('');

  // Load weekday percentages from localStorage or use defaults
  const WEEKDAY_PERCENTAGES_KEY = 'revenue_weekday_percentages';
  const DEFAULT_WEEKDAY_PERCENTAGES: Record<number, number> = {
    0: 10, // Sunday
    1: 10, // Monday
    2: 10, // Tuesday
    3: 10, // Wednesday
    4: 10, // Thursday
    5: 25, // Friday
    6: 25, // Saturday
  };
  
  const savedPercentages = useMemo(() => {
    const saved = localStorage.getItem(WEEKDAY_PERCENTAGES_KEY);
    return saved ? JSON.parse(saved) : DEFAULT_WEEKDAY_PERCENTAGES;
  }, []);
  
  // Convert percentages to decimal (stored as whole numbers, used as decimals)
  const WEEKDAY_PERCENTAGES: Record<number, number> = useMemo(() => {
    const result: Record<number, number> = {};
    Object.entries(savedPercentages).forEach(([key, value]) => {
      result[parseInt(key)] = (value as number) / 100;
    });
    return result;
  }, [savedPercentages]);

  const monthDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonthStart);
    const monthEnd = endOfMonth(currentMonthStart);
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  }, [currentMonthStart]);

  const weekDays = useMemo(() => {
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: currentWeekStart, end: weekEnd });
  }, [currentWeekStart]);

  // Calculate number of each weekday in the month
  const weekdayCounts = useMemo(() => {
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    monthDays.forEach((day) => {
      const weekday = getDay(day);
      counts[weekday]++;
    });
    return counts;
  }, [monthDays]);

  // Calculate weighted total for the month (sum of weekday counts * percentages)
  const monthlyWeightedTotal = useMemo(() => {
    return Object.entries(weekdayCounts).reduce((sum, [weekday, count]) => {
      return sum + count * WEEKDAY_PERCENTAGES[parseInt(weekday)];
    }, 0);
  }, [weekdayCounts]);

  // navigateMonth and navigateWeek are now provided by useWeekSync hook

  const handleWeekdayChange = (weekday: number, value: number) => {
    setWeekdayBudgets((prev) => ({
      ...prev,
      [weekday]: Math.max(0, value),
    }));
  };

  const incrementWeekday = (weekday: number) => {
    handleWeekdayChange(weekday, (weekdayBudgets[weekday] || 0) + STEP);
  };

  const decrementWeekday = (weekday: number) => {
    handleWeekdayChange(weekday, (weekdayBudgets[weekday] || 0) - STEP);
  };

  const getRevenueField = (): 'plannedRevenue' | 'actualRevenue' | 'previousYearRevenue' => {
    if (revenueMode === 'planned') return 'plannedRevenue';
    if (revenueMode === 'actual') return 'actualRevenue';
    return 'previousYearRevenue';
  };

  const getRevenueValue = (dateString: string): number => {
    const budget = dailyBudgets[dateString];
    if (revenueMode === 'planned') return budget?.plannedRevenue || 0;
    if (revenueMode === 'actual') return budget?.actualRevenue || 0;
    return budget?.previousYearRevenue || 0;
  };

  const handleDayBudgetChange = (dateString: string, value: number) => {
    onBudgetUpdate(dateString, getRevenueField(), Math.max(0, value));
  };

  const incrementDay = (dateString: string) => {
    const current = getRevenueValue(dateString);
    handleDayBudgetChange(dateString, current + STEP);
  };

  const decrementDay = (dateString: string) => {
    const current = getRevenueValue(dateString);
    handleDayBudgetChange(dateString, current - STEP);
  };

  const applyWeekdayBudgets = () => {
    let updatedCount = 0;
    
    monthDays.forEach((day) => {
      const weekday = getDay(day);
      const dateString = format(day, 'yyyy-MM-dd');
      const value = weekdayBudgets[weekday] || 0;
      
      onBudgetUpdate(dateString, getRevenueField(), value);
      updatedCount++;
    });
    
    const label = revenueMode === 'planned' ? 'Plan-Umsatz' : revenueMode === 'actual' ? 'Ist-Umsatz' : 'Vorjahres-Umsatz';
    toast.success(`${label} für ${updatedCount} Tage im ${format(currentMonthStart, 'MMMM yyyy', { locale: de })} gesetzt`);
  };

  const copyToNextMonth = () => {
    const nextMonth = new Date(currentMonthStart);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthStart = startOfMonth(nextMonth);
    const nextMonthEnd = endOfMonth(nextMonth);
    const nextMonthDays = eachDayOfInterval({ start: nextMonthStart, end: nextMonthEnd });
    
    let updatedCount = 0;
    nextMonthDays.forEach((day) => {
      const weekday = getDay(day);
      const dateString = format(day, 'yyyy-MM-dd');
      const value = weekdayBudgets[weekday] || 0;
      
      onBudgetUpdate(dateString, getRevenueField(), value);
      updatedCount++;
    });
    
    const label = revenueMode === 'planned' ? 'Plan-Umsatz' : revenueMode === 'actual' ? 'Ist-Umsatz' : 'Vorjahres-Umsatz';
    toast.success(`${label} für ${updatedCount} Tage im ${format(nextMonth, 'MMMM yyyy', { locale: de })} kopiert`);
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('de-CH', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const distributeMonthlyRevenue = () => {
    const monthlyRevenue = parseFloat(monthlyRevenueInput) || 0;
    if (monthlyRevenue <= 0) {
      toast.error('Bitte geben Sie einen gültigen Monatsumsatz ein');
      return;
    }

    // Calculate the base amount per percentage point
    const basePerPercentage = monthlyRevenue / monthlyWeightedTotal;

    let updatedCount = 0;
    monthDays.forEach((day) => {
      const weekday = getDay(day);
      const dateString = format(day, 'yyyy-MM-dd');
      const dailyValue = Math.round(basePerPercentage * WEEKDAY_PERCENTAGES[weekday]);
      
      onBudgetUpdate(dateString, getRevenueField(), dailyValue);
      
      // When distributing planned revenue, also set it as the fixed budget (Startbudget)
      if (revenueMode === 'planned' && onSetFixedBudget) {
        onSetFixedBudget(dateString, dailyValue);
      }
      
      updatedCount++;
    });

    // Also update the weekday template values to match
    const weeklyRevenue = monthlyRevenue / (monthDays.length / 7);
    const newWeekdayBudgets: Record<number, number> = {};
    Object.entries(WEEKDAY_PERCENTAGES).forEach(([weekday, percentage]) => {
      newWeekdayBudgets[parseInt(weekday)] = Math.round(weeklyRevenue * percentage);
    });
    setWeekdayBudgets(newWeekdayBudgets);

    const label = revenueMode === 'planned' ? 'Plan-Umsatz' : revenueMode === 'actual' ? 'Ist-Umsatz' : 'Vorjahres-Umsatz';
    const fixedBudgetNote = revenueMode === 'planned' ? ' (als fixes Startbudget gespeichert)' : '';
    toast.success(`${label} CHF ${formatCurrency(monthlyRevenue)} auf ${updatedCount} Tage im ${format(currentMonthStart, 'MMMM yyyy', { locale: de })} verteilt${fixedBudgetNote}`);
    setMonthlyRevenueInput('');
  };

  const totalWeeklyBudget = Object.values(weekdayBudgets).reduce((sum, val) => sum + val, 0);
  const estimatedMonthlyBudget = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const weekday = getDay(day);
      return sum + (weekdayBudgets[weekday] || 0);
    }, 0);
  }, [monthDays, weekdayBudgets]);

  // Calculate current values from dailyBudgets
  const currentMonthPlanned = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.plannedRevenue || 0);
    }, 0);
  }, [monthDays, dailyBudgets]);

  const currentMonthActual = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.actualRevenue || 0);
    }, 0);
  }, [monthDays, dailyBudgets]);

  const currentMonthPreviousYear = useMemo(() => {
    return monthDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.previousYearRevenue || 0);
    }, 0);
  }, [monthDays, dailyBudgets]);

  const currentWeekPlanned = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.plannedRevenue || 0);
    }, 0);
  }, [weekDays, dailyBudgets]);

  const currentWeekActual = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.actualRevenue || 0);
    }, 0);
  }, [weekDays, dailyBudgets]);

  const currentWeekPreviousYear = useMemo(() => {
    return weekDays.reduce((sum, day) => {
      const dateString = format(day, 'yyyy-MM-dd');
      return sum + (dailyBudgets[dateString]?.previousYearRevenue || 0);
    }, 0);
  }, [weekDays, dailyBudgets]);

  // Render day input with date
  const renderDayInput = (day: Date) => {
    const dateString = format(day, 'yyyy-MM-dd');
    const budget = dailyBudgets[dateString];
    const value = getRevenueValue(dateString);
    const planned = budget?.plannedRevenue || 0;
    const actual = budget?.actualRevenue || 0;
    const previousYear = budget?.previousYearRevenue || 0;
    const weekday = getDay(day);
    const expectedFromWeekday = weekdayBudgets[weekday] || 0;
    const isDifferent = revenueMode === 'planned' && value !== expectedFromWeekday && value > 0;
    const isOtherMonth = !isSameMonth(day, currentMonthStart);

    return (
      <div 
        key={dateString}
        className={cn(
          "p-2 rounded-lg border text-center space-y-1",
          isDifferent && "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20",
          isOtherMonth && viewMode === 'month' && "opacity-50",
          revenueMode === 'actual' && "border-primary/30 bg-primary/5",
          revenueMode === 'previousYear' && "border-amber-500/30 bg-amber-50 dark:bg-amber-950/20"
        )}
      >
        <div className="text-xs font-medium text-muted-foreground">
          {format(day, 'EEE', { locale: de })}
        </div>
        <div className="font-bold text-base">
          {format(day, 'd. MMM', { locale: de })}
        </div>
        <div className="flex flex-col items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => incrementDay(dateString)}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Input
            type="number"
            value={value}
            onChange={(e) => handleDayBudgetChange(dateString, parseInt(e.target.value) || 0)}
            className={cn(
              "h-8 text-xs text-center px-1 w-full",
              revenueMode === 'actual' && "border-primary/50",
              revenueMode === 'previousYear' && "border-amber-500/50"
            )}
            step={STEP}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => decrementDay(dateString)}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          CHF {formatCurrency(value)}
        </div>
        {/* Show comparison */}
        {revenueMode === 'actual' && (
          <div className="space-y-0.5">
            {planned > 0 && (
              <div className={cn(
                "text-[10px]",
                actual >= planned ? "text-green-600" : "text-red-600"
              )}>
                Plan: {formatCurrency(planned)}
              </div>
            )}
            {previousYear > 0 && (
              <div className={cn(
                "text-[10px]",
                actual >= previousYear ? "text-green-600" : "text-amber-600"
              )}>
                VJ: {formatCurrency(previousYear)}
              </div>
            )}
          </div>
        )}
        {revenueMode === 'planned' && (
          <div className="space-y-0.5">
            {actual > 0 && (
              <div className={cn(
                "text-[10px]",
                actual >= planned ? "text-green-600" : "text-red-600"
              )}>
                Ist: {formatCurrency(actual)}
              </div>
            )}
            {previousYear > 0 && (
              <div className="text-[10px] text-amber-600">
                VJ: {formatCurrency(previousYear)}
              </div>
            )}
          </div>
        )}
        {revenueMode === 'previousYear' && (
          <div className="space-y-0.5">
            {actual > 0 && (
              <div className={cn(
                "text-[10px]",
                actual >= previousYear ? "text-green-600" : "text-amber-600"
              )}>
                Ist: {formatCurrency(actual)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card className="stat-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            Umsatz Editor
          </CardTitle>
          
          <div className="flex items-center gap-2 flex-wrap">
            {/* Import Button */}
            {onImportRevenue && (
              <RevenueImportButton onImport={onImportRevenue} />
            )}
            
            {/* Revenue Mode Toggle (Plan vs Ist vs Vorjahr) */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={revenueMode === 'planned' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setRevenueMode('planned')}
                className="gap-1 text-xs"
              >
                <Target className="h-3 w-3" />
                Plan
              </Button>
              <Button
                variant={revenueMode === 'actual' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setRevenueMode('actual')}
                className="gap-1 text-xs"
              >
                <TrendingUp className="h-3 w-3" />
                Ist
              </Button>
              <Button
                variant={revenueMode === 'previousYear' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setRevenueMode('previousYear')}
                className="gap-1 text-xs"
              >
                <History className="h-3 w-3" />
                Vorjahr
              </Button>
            </div>
            
            {/* View Mode Toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={viewMode === 'weekdays' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('weekdays')}
                className="gap-1 text-xs"
              >
                Wochentage
              </Button>
              <Button
                variant={viewMode === 'week' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('week')}
                className="gap-1 text-xs"
              >
                <Calendar className="h-3 w-3" />
                Woche
              </Button>
              <Button
                variant={viewMode === 'month' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('month')}
                className="gap-1 text-xs"
              >
                <CalendarDays className="h-3 w-3" />
                Monat
              </Button>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => viewMode === 'week' ? navigateWeek('prev') : navigateMonth('prev')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="font-medium min-w-[180px] text-center">
            {viewMode === 'week' 
              ? `${format(currentWeekStart, 'd. MMM', { locale: de })} - ${format(endOfWeek(currentWeekStart, { weekStartsOn: 1 }), 'd. MMM yyyy', { locale: de })}`
              : format(currentMonthStart, 'MMMM yyyy', { locale: de })
            }
          </span>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => viewMode === 'week' ? navigateWeek('next') : navigateMonth('next')}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 p-3 bg-muted/50 rounded-lg">
          <div>
            <div className="text-xs text-muted-foreground">
              {viewMode === 'week' ? 'Woche Plan' : 'Monat Plan'}
            </div>
            <div className={cn(
              "text-lg font-bold",
              revenueMode === 'planned' && "text-primary"
            )}>
              CHF {formatCurrency(viewMode === 'week' ? currentWeekPlanned : currentMonthPlanned)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {viewMode === 'week' ? 'Woche Ist' : 'Monat Ist'}
            </div>
            <div className={cn(
              "text-lg font-bold",
              revenueMode === 'actual' && "text-primary"
            )}>
              CHF {formatCurrency(viewMode === 'week' ? currentWeekActual : currentMonthActual)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              {viewMode === 'week' ? 'Woche VJ' : 'Monat VJ'}
            </div>
            <div className={cn(
              "text-lg font-bold text-amber-600",
              revenueMode === 'previousYear' && "text-primary"
            )}>
              CHF {formatCurrency(viewMode === 'week' ? currentWeekPreviousYear : currentMonthPreviousYear)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Diff. Plan</div>
            <div className={cn(
              "text-lg font-bold",
              (viewMode === 'week' ? currentWeekActual - currentWeekPlanned : currentMonthActual - currentMonthPlanned) >= 0 
                ? "text-green-600" 
                : "text-red-600"
            )}>
              CHF {formatCurrency(viewMode === 'week' 
                ? currentWeekActual - currentWeekPlanned 
                : currentMonthActual - currentMonthPlanned
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Diff. VJ</div>
            <div className={cn(
              "text-lg font-bold",
              (viewMode === 'week' ? currentWeekActual - currentWeekPreviousYear : currentMonthActual - currentMonthPreviousYear) >= 0 
                ? "text-green-600" 
                : "text-amber-600"
            )}>
              CHF {formatCurrency(viewMode === 'week' 
                ? currentWeekActual - currentWeekPreviousYear 
                : currentMonthActual - currentMonthPreviousYear
              )}
            </div>
          </div>
        </div>

        {/* Monthly Revenue Auto-Distribution */}
        <div className="p-3 bg-muted/50 rounded-lg border border-dashed space-y-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <div className="flex-1 w-full">
              <Label className="text-xs text-muted-foreground mb-1 block">
                Monatsumsatz eingeben (automatische Verteilung nach Einstellungen)
              </Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={monthlyRevenueInput}
                  onChange={(e) => setMonthlyRevenueInput(e.target.value)}
                  placeholder={`z.B. ${formatCurrency(estimatedMonthlyBudget)}`}
                  className="h-9 flex-1"
                  step={1000}
                />
                <Button onClick={distributeMonthlyRevenue} className="gap-2 shrink-0">
                  <Wand2 className="h-4 w-4" />
                  Verteilen
                </Button>
              </div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Verteilung:</span>{' '}
            {WEEKDAYS.map((day, idx) => (
              <span key={day.key}>
                {day.short}: {(WEEKDAY_PERCENTAGES[day.key] * 100).toFixed(0)}%
                {idx < WEEKDAYS.length - 1 ? ' | ' : ''}
              </span>
            ))}
          </div>
        </div>

        {/* Weekday Template View */}
        {viewMode === 'weekdays' && (
          <>
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAYS.map((day) => (
                <div key={day.key} className="space-y-1">
                  <Label className="text-xs font-medium text-center block">
                    {day.short}
                    <span className="block text-[10px] text-muted-foreground">
                      ({Math.round(WEEKDAY_PERCENTAGES[day.key] * 100)}%)
                    </span>
                  </Label>
                  <div className="flex flex-col items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => incrementWeekday(day.key)}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </Button>
                    <Input
                      type="number"
                      value={weekdayBudgets[day.key] || 0}
                      onChange={(e) => handleWeekdayChange(day.key, parseInt(e.target.value) || 0)}
                      className="h-8 text-xs text-center px-1 w-full"
                      step={STEP}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => decrementWeekday(day.key)}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="text-xs text-muted-foreground text-center">
              Wochensumme: CHF {formatCurrency(totalWeeklyBudget)} | Schritte: ±{STEP} CHF
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-2 justify-center pt-2 border-t">
              <Button onClick={applyWeekdayBudgets} className="gap-2">
                <Save className="h-4 w-4" />
                {revenueMode === 'planned' ? 'Plan' : 'Ist'} für {format(currentMonthStart, 'MMMM', { locale: de })} übernehmen
              </Button>
              <Button variant="outline" onClick={copyToNextMonth} className="gap-2">
                <Copy className="h-4 w-4" />
                Auch für nächsten Monat
              </Button>
            </div>
          </>
        )}

        {/* Week View */}
        {viewMode === 'week' && (
          <div className="grid grid-cols-7 gap-2">
            {weekDays.map((day) => renderDayInput(day))}
          </div>
        )}

        {/* Month View */}
        {viewMode === 'month' && (
          <div className="space-y-2">
            {/* Week Headers */}
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground font-medium">
              {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            
            {/* Calendar Grid */}
            <div className="grid grid-cols-7 gap-1">
              {/* Empty cells for alignment */}
              {Array.from({ length: (getDay(monthDays[0]) + 6) % 7 }).map((_, i) => (
                <div key={`empty-${i}`} />
              ))}
              {monthDays.map((day) => {
                const dateString = format(day, 'yyyy-MM-dd');
                const budget = dailyBudgets[dateString];
                const value = getRevenueValue(dateString);
                const planned = budget?.plannedRevenue || 0;
                const actual = budget?.actualRevenue || 0;
                const weekday = getDay(day);
                const expectedFromWeekday = weekdayBudgets[weekday] || 0;
                const isDifferent = revenueMode === 'planned' && value !== expectedFromWeekday && value > 0;
                
                return (
                  <div 
                    key={dateString}
                    className={cn(
                      "p-1.5 rounded border text-xs text-center space-y-0.5",
                      isDifferent && "border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20",
                      revenueMode === 'actual' && "border-primary/30 bg-primary/5"
                    )}
                  >
                    <div className="flex items-center justify-between px-1">
                      <span className="text-muted-foreground text-[10px]">
                        {format(day, 'EEE', { locale: de })}
                      </span>
                      <span className="font-bold">{format(day, 'd')}</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0"
                        onClick={() => decrementDay(dateString)}
                      >
                        <ChevronDown className="h-2.5 w-2.5" />
                      </Button>
                      <Input
                        type="number"
                        value={value}
                        onChange={(e) => handleDayBudgetChange(dateString, parseInt(e.target.value) || 0)}
                        className={cn(
                          "h-6 text-[10px] text-center px-0.5 w-full min-w-0",
                          revenueMode === 'actual' && "border-primary/50"
                        )}
                        step={STEP}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0"
                        onClick={() => incrementDay(dateString)}
                      >
                        <ChevronUp className="h-2.5 w-2.5" />
                      </Button>
                    </div>
                    {/* Comparison row */}
                    {revenueMode === 'actual' && planned > 0 && (
                      <div className={cn(
                        "text-[9px]",
                        actual >= planned ? "text-green-600" : "text-red-600"
                      )}>
                        P: {formatCurrency(planned)}
                      </div>
                    )}
                    {revenueMode === 'planned' && actual > 0 && (
                      <div className={cn(
                        "text-[9px]",
                        actual >= planned ? "text-green-600" : "text-red-600"
                      )}>
                        I: {formatCurrency(actual)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            
            {/* Quick apply from template */}
            <div className="flex justify-center pt-2 border-t">
              <Button variant="outline" size="sm" onClick={applyWeekdayBudgets} className="gap-2">
                <Save className="h-3 w-3" />
                Wochentag-Vorlage für {revenueMode === 'planned' ? 'Plan' : 'Ist'} anwenden
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
