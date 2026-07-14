import { useState, useEffect, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  TrendingUp,
  Target,
  History,
  Wand2,
  Users,
  CheckCircle2,
  ArrowUpCircle,
  ArrowRight,
  Calendar,
  TrendingDown,
  CalendarDays
} from 'lucide-react';
import { DailyBudget, grossToNet } from '@/types/personnel';

interface GroupReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  group_name: string | null;
  guest_count: number;
  revenue_per_person: number;
}

interface EmailReservation {
  id: string;
  date: string;
  guest_count: number;
  guest_name: string;
  is_processed: boolean;
}

interface DayOverride {
  date: string;
  dayLabel: string;
  budget: number;
  expectedRevenue: number;
  groupGuests: number;
  guestGuests: number;
  processedGuestGuests: number;
  totalGuests: number;
  excess: number;
  selected: boolean;
  hasProcessedGuests: boolean;
}

interface SimpleRevenueInputProps {
  selectedDate: Date;
  dailyBudgets: Record<string, DailyBudget>;
  onBudgetUpdate: (date: string, field: 'plannedRevenue' | 'actualRevenue', value: number) => void;
  showNetRevenue?: boolean;
}

export const SimpleRevenueInput = ({
  selectedDate,
  dailyBudgets,
  onBudgetUpdate,
  showNetRevenue = false,
}: SimpleRevenueInputProps) => {
  const dateString = format(selectedDate, 'yyyy-MM-dd');
  const budget = dailyBudgets[dateString] || { plannedRevenue: 0, actualRevenue: 0, fixedBudget: 0, previousYearRevenue: 0, takeawayRevenue: 0 };
  
  // Helper to convert revenue based on display mode
  const convertRevenue = (gross: number, takeaway: number = 0) => {
    if (!showNetRevenue) return gross;
    return grossToNet(gross, takeaway);
  };
  
  const [actualInput, setActualInput] = useState(budget.actualRevenue?.toString() || '0');
  const [budgetInput, setBudgetInput] = useState((budget.fixedBudget || budget.plannedRevenue)?.toString() || '0');
  const [previousYearInput, setPreviousYearInput] = useState(budget.previousYearRevenue?.toString() || '0');
  
  const [isOverrideDialogOpen, setIsOverrideDialogOpen] = useState(false);
  const [overrideDays, setOverrideDays] = useState<DayOverride[]>([]);
  const [allOverrideDays, setAllOverrideDays] = useState<DayOverride[]>([]);
  const [groupReservations, setGroupReservations] = useState<GroupReservation[]>([]);
  const [emailReservations, setEmailReservations] = useState<EmailReservation[]>([]);
  const [processedEmailReservations, setProcessedEmailReservations] = useState<EmailReservation[]>([]);
  const [defaultRevenuePerPerson, setDefaultRevenuePerPerson] = useState(35);
  const [isLoading, setIsLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [includeProcessed, setIncludeProcessed] = useState(false);

  useEffect(() => {
    setActualInput(budget.actualRevenue?.toString() || '0');
    setBudgetInput((budget.fixedBudget || budget.plannedRevenue)?.toString() || '0');
    setPreviousYearInput(budget.previousYearRevenue?.toString() || '0');
  }, [budget.actualRevenue, budget.plannedRevenue, budget.fixedBudget, budget.previousYearRevenue]);

  const handleActualBlur = () => {
    const value = parseFloat(actualInput) || 0;
    onBudgetUpdate(dateString, 'actualRevenue', value);
  };

  const handleBudgetBlur = () => {
    const value = parseFloat(budgetInput) || 0;
    onBudgetUpdate(dateString, 'plannedRevenue', value);
  };

  // Fetch reservations for the month to calculate override candidates
  const fetchMonthReservations = async () => {
    setIsLoading(true);
    try {
      const monthStart = startOfMonth(selectedDate);
      const monthEnd = endOfMonth(selectedDate);
      const startStr = format(monthStart, 'yyyy-MM-dd');
      const endStr = format(monthEnd, 'yyyy-MM-dd');

      const [groupResult, emailResult, processedEmailResult, settingsResult] = await Promise.all([
        supabase
          .from('group_reservations')
          .select('id, date, shift, group_name, guest_count, revenue_per_person')
          .gte('date', startStr)
          .lte('date', endStr),
        supabase
          .from('email_imported_reservations')
          .select('id, date, guest_count, guest_name, is_processed')
          .gte('date', startStr)
          .lte('date', endStr)
          .eq('is_processed', false),
        supabase
          .from('email_imported_reservations')
          .select('id, date, guest_count, guest_name, is_processed')
          .gte('date', startStr)
          .lte('date', endStr)
          .eq('is_processed', true),
        supabase
          .from('fortelable_settings')
          .select('default_revenue_per_person')
          .limit(1)
          .maybeSingle()
      ]);

      if (groupResult.data) {
        setGroupReservations(groupResult.data.map(r => ({
          ...r,
          shift: r.shift as 'mittag' | 'abend'
        })));
      }

      if (emailResult.data) {
        setEmailReservations(emailResult.data.map(r => ({ ...r, is_processed: false })));
      }

      if (processedEmailResult.data) {
        setProcessedEmailReservations(processedEmailResult.data.map(r => ({ ...r, is_processed: true })));
      }

      if (settingsResult.data) {
        setDefaultRevenuePerPerson(settingsResult.data.default_revenue_per_person || 35);
      }

      // Calculate override candidates
      const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
      const candidates: DayOverride[] = [];

      monthDays.forEach(day => {
        const ds = format(day, 'yyyy-MM-dd');
        const dayBudget = dailyBudgets[ds]?.fixedBudget || dailyBudgets[ds]?.plannedRevenue || 0;
        
        // Get group reservations for this day
        const dayGroups = (groupResult.data || []).filter(r => r.date === ds);
        const groupGuests = dayGroups.reduce((sum, r) => sum + r.guest_count, 0);
        const groupRevenue = dayGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        
        // Get unprocessed email/guest reservations for this day
        const dayEmails = (emailResult.data || []).filter(r => r.date === ds);
        const guestGuests = dayEmails.reduce((sum, r) => sum + r.guest_count, 0);
        const guestRevenue = guestGuests * (settingsResult.data?.default_revenue_per_person || 35);
        
        // Get processed email/guest reservations for this day
        const dayProcessedEmails = (processedEmailResult.data || []).filter(r => r.date === ds);
        const processedGuestGuests = dayProcessedEmails.reduce((sum, r) => sum + r.guest_count, 0);
        const processedGuestRevenue = processedGuestGuests * (settingsResult.data?.default_revenue_per_person || 35);
        
        const expectedRevenue = groupRevenue + guestRevenue;
        const expectedRevenueWithProcessed = groupRevenue + guestRevenue + processedGuestRevenue;
        const excess = expectedRevenue - dayBudget;
        const excessWithProcessed = expectedRevenueWithProcessed - dayBudget;
        
        // Include days where expected revenue exceeds budget (or would with processed)
        const hasExcess = excess > 0 && expectedRevenue > 0;
        const hasExcessWithProcessed = excessWithProcessed > 0 && expectedRevenueWithProcessed > 0;
        
        if (hasExcess || hasExcessWithProcessed) {
          candidates.push({
            date: ds,
            dayLabel: format(day, 'EEE, d. MMM', { locale: de }),
            budget: dayBudget,
            expectedRevenue: expectedRevenueWithProcessed,
            groupGuests,
            guestGuests,
            processedGuestGuests,
            totalGuests: groupGuests + guestGuests + processedGuestGuests,
            excess: excessWithProcessed,
            selected: hasExcess, // Only pre-select if has unprocessed excess
            hasProcessedGuests: processedGuestGuests > 0
          });
        }
      });

      // Sort by date
      candidates.sort((a, b) => a.date.localeCompare(b.date));
      setAllOverrideDays(candidates);
      
      // Apply initial filter based on viewMode
      filterOverrideDays(candidates, viewMode, includeProcessed);

    } catch (error) {
      console.error('Error fetching reservations:', error);
      toast.error('Fehler beim Laden der Reservierungen');
    } finally {
      setIsLoading(false);
    }
  };

  // Filter override days based on week/month view and includeProcessed setting
  const filterOverrideDays = (days: DayOverride[], mode: 'week' | 'month', showProcessed: boolean) => {
    let filtered = days;
    
    // Filter by processed status if not including processed
    if (!showProcessed) {
      filtered = days.filter(d => d.guestGuests > 0 || d.groupGuests > 0);
    }
    
    if (mode === 'week') {
      const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
      const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
      const weekStartStr = format(weekStart, 'yyyy-MM-dd');
      const weekEndStr = format(weekEnd, 'yyyy-MM-dd');
      
      filtered = filtered.filter(d => d.date >= weekStartStr && d.date <= weekEndStr);
    }
    
    setOverrideDays(filtered.map(d => ({ ...d, selected: d.selected })));
  };

  // Handle view mode change
  const handleViewModeChange = (mode: 'week' | 'month') => {
    setViewMode(mode);
    filterOverrideDays(allOverrideDays, mode, includeProcessed);
  };

  // Handle include processed toggle
  const handleIncludeProcessedChange = (checked: boolean) => {
    setIncludeProcessed(checked);
    filterOverrideDays(allOverrideDays, viewMode, checked);
  };

  const handleOpenOverrideDialog = () => {
    fetchMonthReservations();
    setIsOverrideDialogOpen(true);
  };

  const toggleDaySelection = (date: string) => {
    setOverrideDays(prev => prev.map(d => 
      d.date === date ? { ...d, selected: !d.selected } : d
    ));
  };

  const selectAll = () => {
    setOverrideDays(prev => prev.map(d => ({ ...d, selected: true })));
  };

  const deselectAll = () => {
    setOverrideDays(prev => prev.map(d => ({ ...d, selected: false })));
  };

  const applyOverrides = () => {
    const selectedDays = overrideDays.filter(d => d.selected);
    
    selectedDays.forEach(day => {
      onBudgetUpdate(day.date, 'plannedRevenue', day.expectedRevenue);
    });

    toast.success(`${selectedDays.length} Tage mit Reservierungs-Umsatz überschrieben`);
    setIsOverrideDialogOpen(false);
  };

  // Calculate period label based on view mode
  const periodInfo = useMemo(() => {
    if (viewMode === 'week') {
      const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
      const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
      const weekNumber = getISOWeek(selectedDate);
      return {
        label: `KW ${weekNumber} (${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM', { locale: de })})`,
        start: weekStart,
        end: weekEnd
      };
    } else {
      const monthStart = startOfMonth(selectedDate);
      const monthEnd = endOfMonth(selectedDate);
      return {
        label: format(monthStart, 'MMMM yyyy', { locale: de }),
        start: monthStart,
        end: monthEnd
      };
    }
  }, [selectedDate, viewMode]);

  // Calculate current period totals from dailyBudgets
  const currentPeriodTotals = useMemo(() => {
    const periodDays = eachDayOfInterval({ start: periodInfo.start, end: periodInfo.end });
    
    let totalBudget = 0;
    let totalActual = 0;
    let totalPreviousYear = 0;
    
    periodDays.forEach(day => {
      const ds = format(day, 'yyyy-MM-dd');
      const dayBudget = dailyBudgets[ds];
      totalBudget += dayBudget?.plannedRevenue || dayBudget?.fixedBudget || 0;
      totalActual += dayBudget?.actualRevenue || 0;
      totalPreviousYear += dayBudget?.previousYearRevenue || 0;
    });
    
    return {
      budget: totalBudget,
      actual: totalActual,
      previousYear: totalPreviousYear,
      label: periodInfo.label
    };
  }, [periodInfo, dailyBudgets]);

  // Calculate totals for selected days AND projected period impact
  const selectedTotals = useMemo(() => {
    const selected = overrideDays.filter(d => d.selected);
    const budgetSum = selected.reduce((sum, d) => sum + d.budget, 0);
    const revenueSum = selected.reduce((sum, d) => sum + d.expectedRevenue, 0);
    const excessSum = selected.reduce((sum, d) => sum + d.excess, 0);
    
    // Calculate new period budget after applying overrides
    const newPeriodBudget = currentPeriodTotals.budget + excessSum;
    const budgetChange = newPeriodBudget - currentPeriodTotals.budget;
    const budgetChangePercent = currentPeriodTotals.budget > 0 
      ? (budgetChange / currentPeriodTotals.budget) * 100 
      : 0;
    
    // Compare with previous year
    const vsLastYear = newPeriodBudget - currentPeriodTotals.previousYear;
    const vsLastYearPercent = currentPeriodTotals.previousYear > 0
      ? (vsLastYear / currentPeriodTotals.previousYear) * 100
      : 0;
    
    return {
      count: selected.length,
      budgetSum,
      revenueSum,
      excessSum,
      // Period projections
      currentPeriodBudget: currentPeriodTotals.budget,
      newPeriodBudget,
      budgetChange,
      budgetChangePercent,
      periodActual: currentPeriodTotals.actual,
      periodPreviousYear: currentPeriodTotals.previousYear,
      vsLastYear,
      vsLastYearPercent
    };
  }, [overrideDays, currentPeriodTotals]);

  // Calculate variance for display
  const actualValue = parseFloat(actualInput) || 0;
  const budgetValue = parseFloat(budgetInput) || 0;
  const previousYearValue = parseFloat(previousYearInput) || 0;
  
  const varianceVsBudget = actualValue - budgetValue;
  const varianceVsLastYear = actualValue - previousYearValue;

  return (
    <div className="space-y-4">
      {/* Main Revenue Inputs */}
      <div className="grid grid-cols-3 gap-3">
        {/* Ist-Umsatz */}
        <div className="p-3 rounded-lg border bg-card">
          <div className="flex items-center gap-1.5 mb-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <Label className="text-xs font-medium text-muted-foreground">Ist</Label>
          </div>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={actualInput}
            onChange={(e) => setActualInput(e.target.value)}
            onBlur={handleActualBlur}
            className="text-lg font-bold h-10"
          />
          {budgetValue > 0 && (
            <div className={cn(
              "text-xs mt-1 font-medium",
              varianceVsBudget >= 0 ? "text-green-600" : "text-destructive"
            )}>
              {varianceVsBudget >= 0 ? '+' : ''}{formatCurrency(varianceVsBudget)} vs Budget
            </div>
          )}
        </div>

        {/* Budget */}
        <div className="p-3 rounded-lg border bg-card">
          <div className="flex items-center gap-1.5 mb-2">
            <Target className="h-4 w-4 text-amber-500" />
            <Label className="text-xs font-medium text-muted-foreground">Budget</Label>
          </div>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            onBlur={handleBudgetBlur}
            className="text-lg font-bold h-10"
          />
        </div>

        {/* Vorjahr */}
        <div className="p-3 rounded-lg border bg-card">
          <div className="flex items-center gap-1.5 mb-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <Label className="text-xs font-medium text-muted-foreground">Vorjahr</Label>
          </div>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={previousYearInput}
            onChange={(e) => setPreviousYearInput(e.target.value)}
            className="text-lg font-bold h-10"
            disabled
          />
          {previousYearValue > 0 && actualValue > 0 && (
            <div className={cn(
              "text-xs mt-1 font-medium",
              varianceVsLastYear >= 0 ? "text-green-600" : "text-destructive"
            )}>
              {varianceVsLastYear >= 0 ? '+' : ''}{formatCurrency(varianceVsLastYear)} vs VJ
            </div>
          )}
        </div>
      </div>

      {/* Override Button */}
      <Dialog open={isOverrideDialogOpen} onOpenChange={setIsOverrideDialogOpen}>
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className="w-full gap-2"
            onClick={handleOpenOverrideDialog}
          >
            <Wand2 className="h-4 w-4" />
            Budget von Reservierungen überschreiben
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpCircle className="h-5 w-5 text-primary" />
              Budget überschreiben
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Tage auswählen, bei denen der erwartete Umsatz aus Reservierungen das Budget überschreitet:
            </p>

            {/* Week / Month Toggle */}
            <Tabs value={viewMode} onValueChange={(v) => handleViewModeChange(v as 'week' | 'month')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="week" className="gap-2">
                  <CalendarDays className="h-4 w-4" />
                  Woche
                  {allOverrideDays.length > 0 && (
                    <Badge variant="secondary" className="text-xs ml-1">
                      {allOverrideDays.filter(d => {
                        const weekStart = format(startOfWeek(selectedDate, { weekStartsOn: 1 }), 'yyyy-MM-dd');
                        const weekEnd = format(endOfWeek(selectedDate, { weekStartsOn: 1 }), 'yyyy-MM-dd');
                        return d.date >= weekStart && d.date <= weekEnd;
                      }).length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="month" className="gap-2">
                  <Calendar className="h-4 w-4" />
                  Monat
                  {allOverrideDays.length > 0 && (
                    <Badge variant="secondary" className="text-xs ml-1">
                      {allOverrideDays.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* Include Processed Toggle */}
            {processedEmailReservations.length > 0 && (
              <div className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2">
                  <Checkbox 
                    id="include-processed"
                    checked={includeProcessed}
                    onCheckedChange={(checked) => handleIncludeProcessedChange(checked as boolean)}
                  />
                  <Label htmlFor="include-processed" className="text-sm cursor-pointer">
                    Bereits verarbeitete Reservierungen einbeziehen
                  </Label>
                </div>
                <Badge variant="outline" className="text-xs">
                  {processedEmailReservations.length} verarbeitet
                </Badge>
              </div>
            )}

            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">
                Lade Reservierungen...
              </div>
            ) : overrideDays.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                Keine Tage mit Budget-Überschreitung in {viewMode === 'week' ? 'dieser Woche' : 'diesem Monat'} gefunden
                {processedEmailReservations.length > 0 && !includeProcessed && (
                  <p className="text-xs mt-2">
                    Tipp: Aktivieren Sie "Bereits verarbeitete einbeziehen" oben
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Quick Actions */}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {overrideDays.filter(d => d.selected).length} von {overrideDays.length} ausgewählt
                  </span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={selectAll}>
                      Alle
                    </Button>
                    <Button variant="ghost" size="sm" onClick={deselectAll}>
                      Keine
                    </Button>
                  </div>
                </div>

                {/* Days List */}
                <ScrollArea className="h-[300px] pr-4">
                  <div className="space-y-2">
                    {overrideDays.map(day => (
                      <div
                        key={day.date}
                        className={cn(
                          "p-3 rounded-lg border cursor-pointer transition-colors",
                          day.selected 
                            ? "border-primary bg-primary/5" 
                            : "border-border hover:bg-muted/50"
                        )}
                        onClick={() => toggleDaySelection(day.date)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <Checkbox 
                              checked={day.selected} 
                              onCheckedChange={() => toggleDaySelection(day.date)}
                            />
                            <div>
                              <div className="font-medium">{day.dayLabel}</div>
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <Badge variant="outline" className="text-xs gap-1">
                                  <Users className="h-3 w-3" />
                                  {day.totalGuests} Gäste
                                </Badge>
                                {day.groupGuests > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    {day.groupGuests} Gruppe
                                  </span>
                                )}
                                {day.guestGuests > 0 && (
                                  <span className="text-xs text-cyan-600">
                                    {day.guestGuests} neu
                                  </span>
                                )}
                                {day.processedGuestGuests > 0 && includeProcessed && (
                                  <span className="text-xs text-amber-600">
                                    +{day.processedGuestGuests} verarbeitet
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm text-muted-foreground line-through">
                              {formatCurrency(day.budget)}
                            </div>
                            <div className="font-bold text-primary">
                              {formatCurrency(day.expectedRevenue)}
                            </div>
                            <div className="text-xs text-green-600">
                              +{formatCurrency(day.excess)}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>

                {/* Selected Days Summary */}
                {selectedTotals.count > 0 && (
                  <div className="p-3 rounded-lg bg-muted/50 space-y-2">
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Ausgewählte Tage
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Aktuelles Budget:</span>
                      <span>{formatCurrency(selectedTotals.budgetSum)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Neuer Umsatz:</span>
                      <span className="font-bold text-primary">{formatCurrency(selectedTotals.revenueSum)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-medium">
                      <span>Zusätzlich:</span>
                      <span className="text-green-600">+{formatCurrency(selectedTotals.excessSum)}</span>
                    </div>
                  </div>
                )}

                {/* Period Impact Preview */}
                {selectedTotals.count > 0 && (
                  <div className="p-4 rounded-lg border-2 border-primary/20 bg-primary/5 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {viewMode === 'week' ? (
                        <CalendarDays className="h-4 w-4 text-primary" />
                      ) : (
                        <Calendar className="h-4 w-4 text-primary" />
                      )}
                      {viewMode === 'week' ? 'Wochen' : 'Monats'}-Vorschau: {currentPeriodTotals.label}
                    </div>
                    
                    <Separator />
                    
                    {/* Budget Before → After */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Target className="h-4 w-4 text-amber-500" />
                          <span className="text-sm text-muted-foreground">Budget</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{formatCurrency(selectedTotals.currentPeriodBudget)}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-bold text-primary">{formatCurrency(selectedTotals.newPeriodBudget)}</span>
                          <Badge variant="outline" className={cn(
                            "text-xs",
                            selectedTotals.budgetChange >= 0 ? "text-green-600 border-green-300" : "text-destructive border-destructive/30"
                          )}>
                            {selectedTotals.budgetChange >= 0 ? '+' : ''}{selectedTotals.budgetChangePercent.toFixed(1)}%
                          </Badge>
                        </div>
                      </div>
                      
                      {/* Progress bar showing new budget */}
                      <div className="relative">
                        <Progress 
                          value={Math.min((selectedTotals.currentPeriodBudget / selectedTotals.newPeriodBudget) * 100, 100)} 
                          className="h-2"
                        />
                        <div 
                          className="absolute top-0 left-0 h-2 bg-green-500/50 rounded-full transition-all"
                          style={{ 
                            width: `${Math.min((selectedTotals.excessSum / selectedTotals.newPeriodBudget) * 100, 100)}%`,
                            marginLeft: `${Math.min((selectedTotals.currentPeriodBudget / selectedTotals.newPeriodBudget) * 100, 100)}%`
                          }}
                        />
                      </div>
                    </div>

                    {/* Comparison with Previous Year */}
                    {selectedTotals.periodPreviousYear > 0 && (
                      <div className="flex items-center justify-between text-sm pt-1">
                        <div className="flex items-center gap-2">
                          <History className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">vs. Vorjahr</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{formatCurrency(selectedTotals.periodPreviousYear)}</span>
                          <Badge variant="outline" className={cn(
                            "text-xs gap-1",
                            selectedTotals.vsLastYear >= 0 ? "text-green-600 border-green-300" : "text-amber-600 border-amber-300"
                          )}>
                            {selectedTotals.vsLastYear >= 0 ? (
                              <TrendingUp className="h-3 w-3" />
                            ) : (
                              <TrendingDown className="h-3 w-3" />
                            )}
                            {selectedTotals.vsLastYear >= 0 ? '+' : ''}{selectedTotals.vsLastYearPercent.toFixed(1)}%
                          </Badge>
                        </div>
                      </div>
                    )}

                    {/* Current Actual if available */}
                    {selectedTotals.periodActual > 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-primary" />
                          <span className="text-muted-foreground">Ist bisher</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{formatCurrency(selectedTotals.periodActual)}</span>
                          <span className="text-xs text-muted-foreground">
                            ({((selectedTotals.periodActual / selectedTotals.newPeriodBudget) * 100).toFixed(0)}% des neuen Budgets)
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Summary Impact */}
                    <div className="pt-2 border-t">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Gesamt-Erhöhung:</span>
                        <span className="text-lg font-bold text-green-600">
                          +{formatCurrency(selectedTotals.excessSum)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOverrideDialogOpen(false)}>
              Abbrechen
            </Button>
            <Button 
              onClick={applyOverrides} 
              disabled={selectedTotals.count === 0}
              className="gap-2"
            >
              <Wand2 className="h-4 w-4" />
              {selectedTotals.count} Tage überschreiben
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
