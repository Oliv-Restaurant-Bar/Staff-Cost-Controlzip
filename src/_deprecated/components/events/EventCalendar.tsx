import { useMemo, useState, useEffect } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, startOfWeek, endOfWeek, isToday, parseISO, getDay, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/personnel-utils';
import { supabase } from '@/integrations/supabase/client';
import { WeekTimelineView } from './WeekTimelineView';
import { MonthlyAvailabilityList } from './MonthlyAvailabilityList';
import { useWeekSync } from '@/hooks/useWeekSync';
import { useCapacitySettings } from '@/hooks/useCapacitySettings';
import {
  Users,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Euro,
  PartyPopper,
  MapPin,
  FileText,
  CheckCircle2,
  ClipboardList,
  Edit3,
  Plus,
  Building,
  Wine,
  Save,
  X,
  CalendarIcon,
  ArrowRight,
  Palette,
  UtensilsCrossed,
  GlassWater,
  ChefHat,
  Utensils,
  ClipboardCheck,
  ArrowDownToLine,
  PlusCircle,
  UserCheck,
  UsersRound,
  Filter,
  ArrowRightLeft,
  Loader2,
  RefreshCw,
  Calendar as CalendarViewIcon,
  LayoutList
} from 'lucide-react';
import { toast } from 'sonner';

// Helper function to calculate checklist progress (now 8 items with GF workflow)
const getChecklistProgress = (reservation: {
  gf_accepted?: boolean;
  is_confirmed?: boolean;
  laufzettel_done?: boolean;
  dekoration_ready?: boolean;
  service_ready?: boolean;
  bar_ready?: boolean;
  kueche_ready?: boolean;
  gf_final_confirmed?: boolean;
}) => {
  const items = [
    reservation.gf_accepted,       // Step 1: GF accepts/acknowledges
    reservation.is_confirmed,      // Step 2: Event confirmed  
    reservation.laufzettel_done,   // Step 3: Laufzettel done
    reservation.dekoration_ready,  // Step 4: Dekoration ready
    reservation.service_ready,     // Step 5: Service ready
    reservation.bar_ready,         // Step 6: Bar ready
    reservation.kueche_ready,      // Step 7: Küche ready
    reservation.gf_final_confirmed // Step 8: GF final confirmation
  ];
  const completed = items.filter(Boolean).length;
  return { completed, total: 8, percentage: (completed / 8) * 100 };
};

// Progress bar color based on completion
const getProgressColor = (percentage: number) => {
  if (percentage === 100) return 'bg-emerald-500';
  if (percentage >= 66) return 'bg-amber-500';
  if (percentage >= 33) return 'bg-orange-500';
  return 'bg-red-500';
};

interface GroupReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  group_name: string | null;
  guest_count: number;
  revenue_per_person: number;
  notes: string | null;
  location: string | null;
  exclude_walk_in: boolean;
  menu_pdf_url?: string | null;
  group_type?: 'laufzettel' | 'alacarte' | null;
  revenue_mode?: 'offset' | 'additional' | null;
  is_confirmed?: boolean;
  laufzettel_done?: boolean;
  dekoration_ready?: boolean;
  service_ready?: boolean;
  bar_ready?: boolean;
  kueche_ready?: boolean;
  applied_to_budget?: boolean;
  // GF (Geschäftsführer) workflow fields
  gf_accepted?: boolean;
  gf_accepted_at?: string | null;
  gf_final_confirmed?: boolean;
  gf_final_confirmed_at?: string | null;
}

interface EmailReservation {
  id: string;
  date: string;
  time: string;
  guest_name: string;
  guest_count: number;
  guest_email?: string;
  guest_phone?: string;
  location?: string;
  comment?: string;
  is_processed: boolean;
  needs_review: boolean;
}

interface EventCalendarProps {
  reservations: GroupReservation[];
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  onMonthChange: (date: Date) => void;
  onAddEvent?: (date: string) => void;
  onEditEvent?: (reservation: GroupReservation) => void;
  onUpdateEvent?: (reservation: GroupReservation) => Promise<boolean>;
  onToggleConfirmed?: (id: string, value: boolean) => void;
  onToggleLaufzettel?: (id: string, value: boolean) => void;
  onToggleDepartmentReady?: (id: string, field: 'dekoration_ready' | 'service_ready' | 'bar_ready' | 'kueche_ready', value: boolean) => void;
  onToggleRevenueMode?: (id: string, value: 'offset' | 'additional') => void;
  onBatchApplyToBudget?: (reservationIds: string[], date: string, totalRevenue: number) => Promise<void>;
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number; fixedBudget?: number }>;
  maxCapacity?: number;
}

type FilterMode = 'all' | 'groups' | 'guests';
type ViewMode = 'month' | 'week';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export const EventCalendar = ({
  reservations,
  selectedDate,
  onDateSelect,
  onMonthChange,
  onAddEvent,
  onEditEvent,
  onUpdateEvent,
  onToggleConfirmed,
  onToggleLaufzettel,
  onToggleDepartmentReady,
  onToggleRevenueMode,
  onBatchApplyToBudget,
  dailyBudgets,
  maxCapacity = 100
}: EventCalendarProps) => {
  // Use global week sync for consistent navigation across all components
  const {
    currentWeekStart,
    currentMonthStart,
    weekNumber,
    setWeek,
    setMonth,
    navigateWeek,
    navigateMonth
  } = useWeekSync('EventCalendar', selectedDate);

  const [currentMonth, setCurrentMonth] = useState(startOfMonth(selectedDate));
  const [dayDetailOpen, setDayDetailOpen] = useState(false);
  const [selectedDayDate, setSelectedDayDate] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [emailReservations, setEmailReservations] = useState<EmailReservation[]>([]);

  // Sync local currentMonth with global currentMonthStart
  useEffect(() => {
    if (currentMonthStart.getTime() !== currentMonth.getTime()) {
      setCurrentMonth(currentMonthStart);
      onMonthChange(currentMonthStart);
    }
  }, [currentMonthStart]);

  // Fetch email reservations for current month (both processed and unprocessed)
  useEffect(() => {
    const fetchEmailReservations = async () => {
      const monthStart = startOfMonth(currentMonth);
      const monthEnd = endOfMonth(currentMonth);
      
      // Fetch ALL email reservations, not just unprocessed ones
      const { data, error } = await supabase
        .from('email_imported_reservations')
        .select('*')
        .gte('date', format(monthStart, 'yyyy-MM-dd'))
        .lte('date', format(monthEnd, 'yyyy-MM-dd'))
        .order('time');
        
      if (!error && data) {
        setEmailReservations(data.map(r => ({
          id: r.id,
          date: r.date,
          time: r.time,
          guest_name: r.guest_name,
          guest_count: r.guest_count,
          guest_email: r.guest_email || undefined,
          guest_phone: r.guest_phone || undefined,
          location: r.location || undefined,
          comment: r.comment || undefined,
          is_processed: r.is_processed,
          needs_review: r.needs_review
        })));
      }
    };
    
    fetchEmailReservations();
  }, [currentMonth]);

  // Group email reservations by date
  const emailReservationsByDate = useMemo(() => {
    const groups: Record<string, EmailReservation[]> = {};
    emailReservations.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });
    return groups;
  }, [emailReservations]);

  // Get all days in the calendar grid (including padding days from prev/next month)
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
    
    return eachDayOfInterval({ start: calendarStart, end: calendarEnd });
  }, [currentMonth]);

  // Group reservations by date
  const reservationsByDate = useMemo(() => {
    const groups: Record<string, GroupReservation[]> = {};
    reservations.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });
    return groups;
  }, [reservations]);

  // Navigate months - uses global sync
  const goToPreviousMonth = () => {
    navigateMonth('prev');
  };

  const goToNextMonth = () => {
    navigateMonth('next');
  };

  // Navigate weeks - uses global sync
  const goToPreviousWeek = () => {
    navigateWeek('prev');
  };

  const goToNextWeek = () => {
    navigateWeek('next');
  };

  const goToToday = () => {
    const today = new Date();
    setWeek(today);
    onDateSelect(today);
  };

  // Get week end for display
  const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });

  // Dynamic capacity settings from database
  const { settings: capacitySettings, getAbendCapacity } = useCapacitySettings();
  const MITTAG_CAPACITY = capacitySettings.mittag_capacity;

  const getCapacityPercent = (booked: number, capacity: number) => Math.min(Math.round((booked / capacity) * 100), 100);

  const getCapacityColor = (percent: number) => {
    if (percent === 0) return 'bg-muted/40';
    if (percent < 40) return 'bg-emerald-500';
    if (percent < 70) return 'bg-amber-500';
    if (percent < 90) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const getCapacityBg = (percent: number) => {
    if (percent === 0) return '';
    if (percent < 40) return 'bg-emerald-500/10';
    if (percent < 70) return 'bg-amber-500/10';
    if (percent < 90) return 'bg-orange-500/10';
    return 'bg-red-500/10';
  };

  // Month summary stats
  const monthStats = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    
    const monthReservations = reservations.filter(r => {
      const date = parseISO(r.date);
      return date >= monthStart && date <= monthEnd;
    });

    const monthEmailReservations = emailReservations.filter(r => {
      const date = parseISO(r.date);
      return date >= monthStart && date <= monthEnd;
    });

    const totalEvents = monthReservations.length;
    const totalGuests = monthReservations.reduce((sum, r) => sum + r.guest_count, 0);
    const totalRevenue = monthReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    const daysWithEvents = new Set(monthReservations.map(r => r.date)).size;

    // Email reservation stats
    const emailGuestCount = monthEmailReservations.reduce((sum, r) => sum + r.guest_count, 0);
    const emailReservationCount = monthEmailReservations.length;
    
    // Budget transfer stats
    const appliedReservations = monthReservations.filter(r => r.applied_to_budget);
    const appliedRevenue = appliedReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    const pendingConfirmed = monthReservations.filter(r => r.is_confirmed && !r.applied_to_budget);
    const pendingRevenue = pendingConfirmed.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    
    // Calculate total planned budget for the month
    let plannedMonthlyBudget = 0;
    if (dailyBudgets) {
      const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const dayBudget = dailyBudgets[dateStr];
        if (dayBudget?.plannedRevenue) {
          plannedMonthlyBudget += dayBudget.plannedRevenue;
        }
      });
    }

    return { 
      totalEvents, totalGuests, totalRevenue, daysWithEvents, 
      appliedRevenue, pendingRevenue, appliedCount: appliedReservations.length, pendingCount: pendingConfirmed.length,
      plannedMonthlyBudget,
      emailGuestCount, emailReservationCount
    };
  }, [currentMonth, reservations, dailyBudgets, emailReservations]);

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              Event-Kalender
            </CardTitle>
            {/* View Mode Toggle */}
            <ToggleGroup 
              type="single" 
              value={viewMode} 
              onValueChange={(value) => value && setViewMode(value as ViewMode)}
              className="ml-2"
            >
              <ToggleGroupItem value="month" aria-label="Monatsansicht" className="text-xs px-2 h-7 gap-1">
                <CalendarViewIcon className="h-3 w-3" />
                <span className="hidden sm:inline">Monat</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="week" aria-label="Wochenansicht" className="text-xs px-2 h-7 gap-1">
                <LayoutList className="h-3 w-3" />
                <span className="hidden sm:inline">Woche</span>
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-1">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={viewMode === 'month' ? goToPreviousMonth : goToPreviousWeek} 
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={goToToday} className="h-8 px-3 text-xs">
              Heute
            </Button>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={viewMode === 'month' ? goToNextMonth : goToNextWeek} 
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-lg font-semibold mt-1">
          {viewMode === 'month' 
            ? format(currentMonth, 'MMMM yyyy', { locale: de })
            : `KW ${weekNumber} · ${format(currentWeekStart, 'd. MMM', { locale: de })} – ${format(weekEnd, 'd. MMM yyyy', { locale: de })}`
          }
        </p>
      </CardHeader>
      <CardContent className="p-2 sm:p-4">
        {/* Filter Toggle */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <ToggleGroup 
            type="single" 
            value={filterMode} 
            onValueChange={(value) => value && setFilterMode(value as FilterMode)}
            className="justify-start"
          >
            <ToggleGroupItem value="all" aria-label="Alle anzeigen" className="text-xs px-2.5 h-7 gap-1">
              <Filter className="h-3 w-3" />
              <span className="hidden sm:inline">Alle</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="groups" aria-label="Nur Gruppen" className="text-xs px-2.5 h-7 gap-1">
              <UsersRound className="h-3 w-3" />
              <span className="hidden sm:inline">Gruppen</span>
              {monthStats.totalEvents > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{monthStats.totalEvents}</Badge>
              )}
            </ToggleGroupItem>
            <ToggleGroupItem value="guests" aria-label="Nur Gäste" className="text-xs px-2.5 h-7 gap-1">
              <UserCheck className="h-3 w-3" />
              <span className="hidden sm:inline">Gäste</span>
              {monthStats.emailReservationCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{monthStats.emailReservationCount}</Badge>
              )}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Conditional View Rendering */}
        {viewMode === 'week' ? (
          <WeekTimelineView
            reservations={filterMode === 'guests' ? [] : reservations}
            selectedDate={selectedDate}
            onDateSelect={onDateSelect}
            onWeekChange={(date) => {
              setWeek(date);
            }}
            onDayClick={(dateString) => {
              setSelectedDayDate(dateString);
              setDayDetailOpen(true);
            }}
          />
        ) : (
          <>
            {/* Month Stats Bar */}
            <div className="grid grid-cols-4 gap-2 mb-3 p-2 bg-muted/30 rounded-lg">
              <div className="text-center">
                <p className="text-lg font-bold">{monthStats.totalEvents + monthStats.emailReservationCount}</p>
                <p className="text-[10px] text-muted-foreground">Reserv.</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold">{monthStats.daysWithEvents}</p>
                <p className="text-[10px] text-muted-foreground">Tage</p>
              </div>
              <div className="text-center">
                <div className="flex items-center justify-center gap-1">
                  <p className="text-lg font-bold">{monthStats.totalGuests}</p>
                  {monthStats.emailGuestCount > 0 && (
                    <span className="text-[10px] text-cyan-600 font-medium">+{monthStats.emailGuestCount}</span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">Gäste</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-primary">{formatCurrency(monthStats.totalRevenue)}</p>
                <p className="text-[10px] text-muted-foreground">Umsatz</p>
              </div>
            </div>
        
        {/* Budget Transfer Summary with Progress Bar */}
        {(monthStats.appliedRevenue > 0 || monthStats.pendingRevenue > 0 || monthStats.plannedMonthlyBudget > 0) && (
          <div className="mb-3 p-2 bg-muted/20 rounded-lg space-y-2">
            {/* Progress Bar */}
            {(() => {
              const confirmedTotal = monthStats.appliedRevenue + monthStats.pendingRevenue;
              const transferPercentage = confirmedTotal > 0 
                ? Math.round((monthStats.appliedRevenue / confirmedTotal) * 100) 
                : 0;
              
              // Comparison with planned budget
              const budgetCoverage = monthStats.plannedMonthlyBudget > 0
                ? Math.round((monthStats.appliedRevenue / monthStats.plannedMonthlyBudget) * 100)
                : 0;
              
              return (
                <div className="space-y-2">
                  {/* Transfer Progress */}
                  {confirmedTotal > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">Übertragungsfortschritt</span>
                        <span className="font-medium text-emerald-600">{transferPercentage}%</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div 
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            transferPercentage === 100 ? "bg-emerald-500" :
                            transferPercentage >= 75 ? "bg-emerald-400" :
                            transferPercentage >= 50 ? "bg-amber-500" :
                            transferPercentage >= 25 ? "bg-orange-500" :
                            "bg-red-500"
                          )}
                          style={{ width: `${transferPercentage}%` }}
                        />
                      </div>
                    </div>
                  )}
                  
                  {/* Budget Coverage Comparison */}
                  {monthStats.plannedMonthlyBudget > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-muted-foreground">
                          Plan-Budget: {formatCurrency(monthStats.plannedMonthlyBudget)}
                        </span>
                        <span className={cn(
                          "font-medium",
                          budgetCoverage >= 100 ? "text-emerald-600" :
                          budgetCoverage >= 50 ? "text-amber-600" :
                          "text-muted-foreground"
                        )}>
                          {budgetCoverage}% gedeckt
                        </span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div 
                          className={cn(
                            "h-full rounded-full transition-all duration-500",
                            budgetCoverage >= 100 ? "bg-emerald-500" :
                            budgetCoverage >= 75 ? "bg-blue-400" :
                            budgetCoverage >= 50 ? "bg-blue-300" :
                            "bg-blue-200"
                          )}
                          style={{ width: `${Math.min(budgetCoverage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            
            {/* Stats Row */}
            <div className="flex items-center justify-center gap-3 text-xs pt-1 border-t border-border/50">
              {monthStats.appliedRevenue > 0 && (
                <div className="flex items-center gap-1.5 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span className="font-medium">{formatCurrency(monthStats.appliedRevenue)}</span>
                  <span className="text-muted-foreground">({monthStats.appliedCount})</span>
                </div>
              )}
              {monthStats.appliedRevenue > 0 && monthStats.pendingRevenue > 0 && (
                <span className="text-muted-foreground">·</span>
              )}
              {monthStats.pendingRevenue > 0 && (
                <div className="flex items-center gap-1.5 text-amber-600">
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  <span className="font-medium">{formatCurrency(monthStats.pendingRevenue)}</span>
                  <span className="text-muted-foreground">({monthStats.pendingCount})</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Weekday Headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {WEEKDAYS.map((day, index) => (
            <div
              key={day}
              className={cn(
                "text-center text-xs font-medium py-1",
                index >= 5 ? "text-muted-foreground" : "text-foreground"
              )}
            >
              {day}
            </div>
          ))}
        </div>

        {/* Calendar Grid */}
        <TooltipProvider>
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((day) => {
              const dateString = format(day, 'yyyy-MM-dd');
              const dayReservations = reservationsByDate[dateString] || [];
              const dayEmailReservations = emailReservationsByDate[dateString] || [];
              
              // Apply filter
              const showGroups = filterMode === 'all' || filterMode === 'groups';
              const showGuests = filterMode === 'all' || filterMode === 'guests';
              
              const filteredGroupCount = showGroups ? dayReservations.length : 0;
              const filteredEmailCount = showGuests ? dayEmailReservations.length : 0;
              const filteredGroupGuests = showGroups ? dayReservations.reduce((sum, r) => sum + r.guest_count, 0) : 0;
              const filteredEmailGuests = showGuests ? dayEmailReservations.reduce((sum, r) => sum + r.guest_count, 0) : 0;
              
              const totalGuests = filteredGroupGuests + filteredEmailGuests;
              const totalRevenue = showGroups ? dayReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0) : 0;
              const hasEvents = filteredGroupCount > 0 || filteredEmailCount > 0;
              const isCurrentMonth = isSameMonth(day, currentMonth);
              const isSelected = isSameDay(day, selectedDate);
              const isDayToday = isToday(day);
              const isWeekend = getDay(day) === 0 || getDay(day) === 6;
              
              const mittagEvents = showGroups ? dayReservations.filter(r => r.shift === 'mittag') : [];
              const abendEvents = showGroups ? dayReservations.filter(r => r.shift === 'abend') : [];

              // Shift-based capacity calculation
              const mittagGuests = mittagEvents.reduce((s, r) => s + r.guest_count, 0)
                + (showGuests ? dayEmailReservations.filter(r => parseInt(r.time.split(':')[0], 10) < 15).reduce((s, r) => s + r.guest_count, 0) : 0);
              const abendGuests = abendEvents.reduce((s, r) => s + r.guest_count, 0)
                + (showGuests ? dayEmailReservations.filter(r => parseInt(r.time.split(':')[0], 10) >= 15).reduce((s, r) => s + r.guest_count, 0) : 0);
              const abendCap = getAbendCapacity(day);
              const mittagPercent = getCapacityPercent(mittagGuests, MITTAG_CAPACITY);
              const abendPercent = getCapacityPercent(abendGuests, abendCap);
              const totalPercent = Math.max(mittagPercent, abendPercent);
              
              // Calculate applied budget revenue
              const appliedReservations = dayReservations.filter(r => r.applied_to_budget);
              const appliedRevenue = appliedReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);

              return (
                <Tooltip key={dateString}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        onDateSelect(day);
                        if (hasEvents || dayReservations.length > 0 || dayEmailReservations.length > 0) {
                          setSelectedDayDate(dateString);
                          setDayDetailOpen(true);
                        } else if (onAddEvent) {
                          onAddEvent(dateString);
                        }
                      }}
                      className={cn(
                        "relative aspect-square p-1 rounded-lg transition-all duration-200 border",
                        "hover:ring-2 hover:ring-primary/50 hover:scale-105",
                        "focus:outline-none focus:ring-2 focus:ring-primary",
                        !isCurrentMonth && "opacity-30",
                        isCurrentMonth && !hasEvents && "hover:bg-muted/50 border-transparent",
                        isCurrentMonth && hasEvents && getCapacityBg(totalPercent),
                        isCurrentMonth && hasEvents && "border-border/50",
                        isSelected && "ring-2 ring-primary shadow-lg",
                        isDayToday && !isSelected && "ring-1 ring-primary/50",
                        isWeekend && !hasEvents && "bg-muted/20 border-transparent"
                      )}
                    >
                      {/* Day Number with Guest Badge */}
                      <div className="flex items-start justify-between gap-0.5">
                        <div className={cn(
                          "text-sm font-medium",
                          isDayToday && "text-primary font-bold",
                          !isCurrentMonth && "text-muted-foreground"
                        )}>
                          {format(day, 'd')}
                        </div>
                        
                        {totalGuests > 0 && isCurrentMonth && (
                          <Badge 
                            variant="secondary" 
                            className={cn(
                              "h-4 px-1 text-[9px] font-bold leading-none",
                              filteredEmailGuests > 0 && filteredGroupGuests === 0 && "bg-cyan-100 text-cyan-700 hover:bg-cyan-100",
                              filteredGroupGuests > 0 && filteredEmailGuests === 0 && "bg-primary/20 text-primary hover:bg-primary/20",
                              filteredGroupGuests > 0 && filteredEmailGuests > 0 && "bg-gradient-to-r from-primary/20 to-cyan-100 text-foreground"
                            )}
                          >
                            {totalGuests}
                          </Badge>
                        )}
                      </div>

                      {/* Capacity Fill Bars - Mittag & Abend */}
                      {isCurrentMonth && (
                        <div className="mt-0.5 space-y-0.5">
                          {/* Mittag bar */}
                          <div className="flex items-center gap-0.5">
                            <Sun className="h-2 w-2 text-amber-500 shrink-0" />
                            <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                              <div
                                className={cn("h-full rounded-full transition-all duration-500", getCapacityColor(mittagPercent))}
                                style={{ width: `${mittagPercent}%` }}
                              />
                            </div>
                          </div>
                          {/* Abend bar */}
                          <div className="flex items-center gap-0.5">
                            <Moon className="h-2 w-2 text-indigo-500 shrink-0" />
                            <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                              <div
                                className={cn("h-full rounded-full transition-all duration-500", getCapacityColor(abendPercent))}
                                style={{ width: `${abendPercent}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-2">
                      <p className="font-medium">
                        {format(day, 'EEEE, d. MMMM', { locale: de })}
                      </p>
                      {hasEvents ? (
                        <>
                          <div className="flex items-center gap-4 text-sm">
                            {filteredGroupCount > 0 && (
                              <span className="flex items-center gap-1">
                                <UsersRound className="h-3 w-3" />
                                {filteredGroupCount} Gruppe{filteredGroupCount !== 1 ? 'n' : ''}
                              </span>
                            )}
                            {filteredEmailCount > 0 && (
                              <span className="flex items-center gap-1 text-cyan-600">
                                <UserCheck className="h-3 w-3" />
                                {filteredEmailCount} Gast-Res.
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {totalGuests} Gäste
                            </span>
                          </div>
                          {/* Capacity info in tooltip */}
                          <div className="space-y-1 border-t pt-1 mt-1">
                            <div className="text-xs font-medium">Auslastung:</div>
                            <div className="flex items-center gap-2 text-xs">
                              <Sun className="h-3 w-3 text-amber-500" />
                              <span>Mittag: {mittagGuests}/{MITTAG_CAPACITY} ({mittagPercent}%)</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <Moon className="h-3 w-3 text-indigo-500" />
                              <span>Abend: {abendGuests}/{abendCap} ({abendPercent}%)</span>
                              {(getDay(day) === 5 || getDay(day) === 6) && (
                                <Badge variant="outline" className="text-[9px] h-3.5 px-1">+U1</Badge>
                              )}
                            </div>
                          </div>
                          {showGuests && dayEmailReservations.length > 0 && (
                            <div className="space-y-1 border-t pt-1 mt-1">
                              <div className="text-xs text-cyan-600 font-medium">Gäste-Reservierungen:</div>
                              {dayEmailReservations.slice(0, 2).map(r => (
                                <div key={r.id} className="text-xs truncate">
                                  • {r.guest_name} ({r.guest_count}) - {r.time}
                                </div>
                              ))}
                              {dayEmailReservations.length > 2 && (
                                <div className="text-xs text-muted-foreground">
                                  +{dayEmailReservations.length - 2} weitere...
                                </div>
                              )}
                            </div>
                          )}
                          {showGroups && totalRevenue > 0 && (
                            <div className="flex items-center gap-1 text-sm font-medium text-primary">
                              <Euro className="h-3 w-3" />
                              {formatCurrency(totalRevenue)}
                            </div>
                          )}
                          {/* Budget transfer status */}
                          {showGroups && (() => {
                            const confirmedGroups = dayReservations.filter(r => r.is_confirmed);
                            const appliedGroups = confirmedGroups.filter(r => r.applied_to_budget);
                            const pendingGroups = confirmedGroups.filter(r => !r.applied_to_budget);
                            
                            if (confirmedGroups.length === 0) return null;
                            
                            return (
                              <div className="space-y-1 border-t pt-1 mt-1">
                                {appliedRevenue > 0 && (
                                  <div className="flex items-center gap-1 text-xs text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
                                    <CheckCircle2 className="h-3 w-3" />
                                    <span>{appliedGroups.length} übertragen ({formatCurrency(appliedRevenue)})</span>
                                  </div>
                                )}
                                {pendingGroups.length > 0 && (
                                  <div className="flex items-center gap-1 text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                                    <ArrowDownToLine className="h-3 w-3" />
                                    <span>{pendingGroups.length} ausstehend ({formatCurrency(pendingGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0))})</span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {showGroups && dayReservations.length > 0 && (
                            <div className="text-xs text-muted-foreground border-t pt-1 mt-1">
                              {dayReservations.slice(0, 3).map(r => (
                                <div key={r.id} className="truncate">
                                  • {r.group_name || 'Gruppe'} ({r.guest_count})
                                </div>
                              ))}
                              {dayReservations.length > 3 && (
                                <div className="text-muted-foreground">
                                  +{dayReservations.length - 3} weitere...
                                </div>
                              )}
                            </div>
                          )}
                          {/* Quick Add Button */}
                          {onAddEvent && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onAddEvent(dateString);
                              }}
                              className="mt-2 w-full flex items-center justify-center gap-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded py-1 px-2 transition-colors"
                            >
                              <Plus className="h-3 w-3" />
                              Neue Reservierung
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">Keine Reservierungen</p>
                          {/* Quick Add Button for empty days */}
                          {onAddEvent && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onAddEvent(dateString);
                              }}
                              className="w-full flex items-center justify-center gap-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded py-1 px-2 transition-colors"
                            >
                              <Plus className="h-3 w-3" />
                              Neue Reservierung
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>

        {/* Legend */}
        <div className="mt-4 pt-3 border-t space-y-2">
          {/* Main indicators row */}
          <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground flex-wrap">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <span>Mittag</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
              <span>Abend</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-cyan-500" />
              <span>Gäste</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 ring-1 ring-emerald-300" />
              <span>Budget</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-violet-500 ring-1 ring-violet-300" />
              <span>GF angenommen</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-green-500 ring-2 ring-green-300" />
              <span>GF final</span>
            </div>
          </div>
          {/* Capacity legend */}
          <div className="hidden sm:flex items-center justify-center gap-3 text-xs text-muted-foreground">
            <span className="font-medium">Auslastung:</span>
            <div className="flex items-center gap-1">
              <div className="w-4 h-1.5 rounded-full bg-emerald-500" />
              <span>&lt;40%</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-1.5 rounded-full bg-amber-500" />
              <span>40-70%</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-1.5 rounded-full bg-orange-500" />
              <span>70-90%</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-4 h-1.5 rounded-full bg-red-500" />
              <span>&gt;90%</span>
            </div>
            <span className="text-[10px] ml-1">({capacitySettings.mittag_capacity} Mittag, {capacitySettings.abend_capacity} Abend{capacitySettings.u1_days.length > 0 ? ` +${capacitySettings.u1_capacity} U1` : ''})</span>
          </div>
        </div>

        {/* Monthly Availability List */}
        <MonthlyAvailabilityList
          currentMonth={currentMonth}
          reservations={reservations}
          emailReservations={emailReservations}
          capacitySettings={capacitySettings}
        />
          </>
        )}
      </CardContent>

      {/* Day Detail Dialog */}
      <DayDetailDialog
        open={dayDetailOpen}
        onOpenChange={setDayDetailOpen}
        date={selectedDayDate}
        reservations={selectedDayDate ? (reservationsByDate[selectedDayDate] || []) : []}
        emailReservations={selectedDayDate ? (emailReservationsByDate[selectedDayDate] || []) : []}
        allReservations={reservations}
        onEdit={onEditEvent}
        onUpdateEvent={onUpdateEvent}
        onAddEvent={onAddEvent}
        onToggleConfirmed={onToggleConfirmed}
        onToggleLaufzettel={onToggleLaufzettel}
        onToggleDepartmentReady={onToggleDepartmentReady}
        onToggleRevenueMode={onToggleRevenueMode}
        onBatchApplyToBudget={onBatchApplyToBudget}
        onEmailReservationUpdate={() => {
          // Refresh email reservations
          const fetchEmailReservations = async () => {
            const monthStart = startOfMonth(currentMonth);
            const monthEnd = endOfMonth(currentMonth);
            
            const { data, error } = await supabase
              .from('email_imported_reservations')
              .select('*')
              .gte('date', format(monthStart, 'yyyy-MM-dd'))
              .lte('date', format(monthEnd, 'yyyy-MM-dd'))
              .eq('is_processed', false);
              
            if (!error && data) {
              setEmailReservations(data.map(r => ({
                id: r.id,
                date: r.date,
                time: r.time,
                guest_name: r.guest_name,
                guest_count: r.guest_count,
                guest_email: r.guest_email || undefined,
                guest_phone: r.guest_phone || undefined,
                location: r.location || undefined,
                comment: r.comment || undefined,
                is_processed: r.is_processed,
                needs_review: r.needs_review
              })));
            }
          };
          fetchEmailReservations();
        }}
      />
    </Card>
  );
};

// Day Detail Dialog Component
interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string | null;
  reservations: GroupReservation[];
  emailReservations: EmailReservation[];
  allReservations: GroupReservation[];
  onEdit?: (reservation: GroupReservation) => void;
  onUpdateEvent?: (reservation: GroupReservation) => Promise<boolean>;
  onAddEvent?: (date: string) => void;
  onToggleConfirmed?: (id: string, value: boolean) => void;
  onToggleLaufzettel?: (id: string, value: boolean) => void;
  onToggleDepartmentReady?: (id: string, field: 'dekoration_ready' | 'service_ready' | 'bar_ready' | 'kueche_ready', value: boolean) => void;
  onToggleRevenueMode?: (id: string, value: 'offset' | 'additional') => void;
  onBatchApplyToBudget?: (reservationIds: string[], date: string, totalRevenue: number) => Promise<void>;
  onEmailReservationUpdate?: () => void;
}

interface EditFormState {
  date: string;
  group_name: string;
  guest_count: number;
  revenue_per_person: number;
  shift: 'mittag' | 'abend';
  location: string;
  notes: string;
}

const DayDetailDialog = ({
  open,
  onOpenChange,
  date,
  reservations,
  emailReservations,
  allReservations,
  onEdit,
  onUpdateEvent,
  onAddEvent,
  onToggleConfirmed,
  onToggleLaufzettel,
  onToggleDepartmentReady,
  onToggleRevenueMode,
  onBatchApplyToBudget,
  onEmailReservationUpdate
}: DayDetailDialogProps) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isBatchApplying, setIsBatchApplying] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [reImportingId, setReImportingId] = useState<string | null>(null);

  if (!date) return null;

  const dateObj = parseISO(date);
  const totalGroupGuests = reservations.reduce((sum, r) => sum + r.guest_count, 0);
  const totalEmailGuests = emailReservations.reduce((sum, r) => sum + r.guest_count, 0);
  const totalGuests = totalGroupGuests + totalEmailGuests;
  const totalRevenue = reservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
  const mittagEvents = reservations.filter(r => r.shift === 'mittag');
  const abendEvents = reservations.filter(r => r.shift === 'abend');
  
  // Calculate pending budget transfers
  const pendingTransfers = reservations.filter(r => r.is_confirmed && !r.applied_to_budget);
  const pendingRevenue = pendingTransfers.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
  const appliedCount = reservations.filter(r => r.applied_to_budget).length;

  // Handle email reservation actions
  const handleMarkProcessed = async (id: string) => {
    const { error } = await supabase
      .from('email_imported_reservations')
      .update({ is_processed: true })
      .eq('id', id);
    
    if (!error) {
      onEmailReservationUpdate?.();
    }
  };

  const handleDeleteEmailReservation = async (id: string) => {
    const { error } = await supabase
      .from('email_imported_reservations')
      .delete()
      .eq('id', id);
    
    if (!error) {
      onEmailReservationUpdate?.();
    }
  };

  // Convert email reservation to group reservation
  const handleConvertToGroup = async (emailRes: EmailReservation) => {
    setConvertingId(emailRes.id);
    try {
      // Determine shift based on time (before 15:00 = mittag, after = abend)
      const timeHour = parseInt(emailRes.time.split(':')[0], 10);
      const shift = timeHour < 15 ? 'mittag' : 'abend';
      
      // Create new group reservation with pre-filled data
      const { data: newGroup, error: insertError } = await supabase
        .from('group_reservations')
        .insert({
          date: emailRes.date,
          shift,
          group_name: emailRes.guest_name,
          guest_count: emailRes.guest_count,
          revenue_per_person: 35,
          notes: [
            emailRes.comment,
            emailRes.guest_phone ? `Tel: ${emailRes.guest_phone}` : null,
            emailRes.guest_email ? `E-Mail: ${emailRes.guest_email}` : null,
            `Uhrzeit: ${emailRes.time}`
          ].filter(Boolean).join('\n'),
          location: emailRes.location || 'EG Restaurant',
          exclude_walk_in: true,
          group_type: emailRes.guest_count >= 10 ? 'laufzettel' : 'alacarte',
          revenue_mode: 'offset',
          is_confirmed: false,
          laufzettel_done: false
        })
        .select()
        .single();
      
      if (insertError) throw insertError;
      
      // Mark email reservation as processed and link to group
      const { error: updateError } = await supabase
        .from('email_imported_reservations')
        .update({ 
          is_processed: true,
          converted_to_group_id: newGroup.id 
        })
        .eq('id', emailRes.id);
      
      if (updateError) throw updateError;
      
      toast.success(`${emailRes.guest_name} als Gruppe erstellt`);
      onEmailReservationUpdate?.();
      
    } catch (error) {
      console.error('Error converting to group:', error);
      toast.error('Fehler bei der Konvertierung');
    } finally {
      setConvertingId(null);
    }
  };

  // Re-import/re-parse an email reservation
  const handleReImport = async (emailRes: EmailReservation) => {
    setReImportingId(emailRes.id);
    try {
      // Fetch the full reservation with raw_email_content
      const { data: fullReservation, error: fetchError } = await supabase
        .from('email_imported_reservations')
        .select('*')
        .eq('id', emailRes.id)
        .single();
      
      if (fetchError || !fullReservation) {
        throw new Error('Reservierung nicht gefunden');
      }
      
      if (!fullReservation.raw_email_content) {
        toast.error('Kein E-Mail-Inhalt zum erneuten Parsen vorhanden');
        return;
      }
      
      // Call the parse function with the stored email content
      const { data: parseResult, error: parseError } = await supabase.functions.invoke('parse-reservation-email', {
        body: {
          'body-plain': fullReservation.raw_email_content,
          subject: 'Re-Import',
          from: 'reimport@internal'
        }
      });
      
      if (parseError) throw parseError;
      
      // The function might return "already imported" with the existing id
      // In that case, we need to manually update with the parsed data
      if (parseResult?.parsed) {
        const parsed = parseResult.parsed;
        
        // Update the existing reservation with newly parsed data
        const { error: updateError } = await supabase
          .from('email_imported_reservations')
          .update({
            guest_name: parsed.guest_name,
            guest_count: parsed.guest_count,
            guest_email: parsed.guest_email,
            guest_phone: parsed.guest_phone,
            date: parsed.date,
            time: parsed.time,
            comment: parsed.comment,
            location: parsed.location,
            needs_review: parsed.guest_count >= 10,
            is_processed: false // Reset to unprocessed so it appears in lists
          })
          .eq('id', emailRes.id);
        
        if (updateError) throw updateError;
        
        toast.success(`Reservierung aktualisiert: ${parsed.guest_count} Gäste`);
        onEmailReservationUpdate?.();
      } else {
        // Function returned error or no parsed data
        toast.error('E-Mail konnte nicht erneut geparst werden');
      }
      
    } catch (error) {
      console.error('Error re-importing:', error);
      toast.error('Fehler beim erneuten Import');
    } finally {
      setReImportingId(null);
    }
  };

  const handleBatchApply = async () => {
    if (!onBatchApplyToBudget || pendingTransfers.length === 0) return;
    setIsBatchApplying(true);
    try {
      await onBatchApplyToBudget(
        pendingTransfers.map(r => r.id),
        date,
        pendingRevenue
      );
    } finally {
      setIsBatchApplying(false);
    }
  };

  const startEditing = (reservation: GroupReservation) => {
    setEditingId(reservation.id);
    setEditForm({
      date: reservation.date,
      group_name: reservation.group_name || '',
      guest_count: reservation.guest_count,
      revenue_per_person: reservation.revenue_per_person,
      shift: reservation.shift,
      location: reservation.location || 'EG Restaurant',
      notes: reservation.notes || ''
    });
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditForm(null);
  };

  const saveChanges = async (reservation: GroupReservation) => {
    if (!editForm || !onUpdateEvent) return;
    
    setIsSaving(true);
    try {
      const updatedReservation: GroupReservation = {
        ...reservation,
        date: editForm.date,
        group_name: editForm.group_name || null,
        guest_count: editForm.guest_count,
        revenue_per_person: editForm.revenue_per_person,
        shift: editForm.shift,
        location: editForm.location,
        notes: editForm.notes || null
      };
      
      const success = await onUpdateEvent(updatedReservation);
      if (success) {
        cancelEditing();
        // If date changed, close dialog since the event moved to another day
        if (editForm.date !== reservation.date) {
          onOpenChange(false);
        }
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) cancelEditing();
      onOpenChange(isOpen);
    }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5" />
            {format(dateObj, 'EEEE, d. MMMM yyyy', { locale: de })}
          </DialogTitle>
        </DialogHeader>

        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 p-3 bg-muted/30 rounded-lg">
          <div className="text-center">
            <p className="text-xl font-bold">{reservations.length}</p>
            <p className="text-[10px] text-muted-foreground">Gruppen</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-cyan-600">{emailReservations.length}</p>
            <p className="text-[10px] text-muted-foreground">Gäste-Res.</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              <p className="text-xl font-bold">{totalGroupGuests}</p>
              {totalEmailGuests > 0 && (
                <span className="text-sm text-cyan-600">+{totalEmailGuests}</span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">Gäste</p>
          </div>
          <div className="text-center">
            <p className="text-xl font-bold text-primary">{formatCurrency(totalRevenue)}</p>
            <p className="text-[10px] text-muted-foreground">Umsatz</p>
          </div>
        </div>

        {/* Shift Breakdown */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm flex-wrap">
            {mittagEvents.length > 0 && (
              <div className="flex items-center gap-2">
                <Sun className="h-4 w-4 text-amber-500" />
                <span>{mittagEvents.length} Mittag ({mittagEvents.reduce((s, r) => s + r.guest_count, 0)} Gäste)</span>
              </div>
            )}
            {abendEvents.length > 0 && (
              <div className="flex items-center gap-2">
                <Moon className="h-4 w-4 text-indigo-500" />
                <span>{abendEvents.length} Abend ({abendEvents.reduce((s, r) => s + r.guest_count, 0)} Gäste)</span>
              </div>
            )}
            {emailReservations.length > 0 && (
              <div className="flex items-center gap-2 text-cyan-600">
                <UserCheck className="h-4 w-4" />
                <span>{emailReservations.length} Gäste ({totalEmailGuests} Pers.)</span>
              </div>
            )}
          </div>
        </div>

        {/* Batch Apply to Budget */}
        {onBatchApplyToBudget && (
          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border">
            <div className="flex items-center gap-2 text-sm">
              {appliedCount > 0 && (
                <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  {appliedCount} übertragen
                </Badge>
              )}
              {pendingTransfers.length > 0 && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                  <ArrowDownToLine className="h-3 w-3 mr-1" />
                  {pendingTransfers.length} ausstehend
                </Badge>
              )}
            </div>
            {pendingTransfers.length > 0 && (
              <Button
                size="sm"
                onClick={handleBatchApply}
                disabled={isBatchApplying}
                className="gap-1"
              >
                {isBatchApplying ? (
                  <>Übertrage...</>
                ) : (
                  <>
                    <PlusCircle className="h-3.5 w-3.5" />
                    Alle übertragen ({formatCurrency(pendingRevenue)})
                  </>
                )}
              </Button>
            )}
          </div>
        )}

        {/* Reservations List */}
        <ScrollArea className="max-h-[400px]">
          <div className="space-y-3">
            {reservations.length === 0 && emailReservations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <PartyPopper className="h-12 w-12 mx-auto mb-2 opacity-30" />
                <p>Keine Reservierungen an diesem Tag</p>
              </div>
            ) : (
              <>
                {/* Email Reservations Section */}
                {emailReservations.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-cyan-600">
                      <UserCheck className="h-4 w-4" />
                      <span>Gäste-Reservierungen ({emailReservations.length})</span>
                      <span className="text-xs text-muted-foreground font-normal">
                        ({emailReservations.filter(r => !r.is_processed).length} offen, {emailReservations.filter(r => r.is_processed).length} bearbeitet)
                      </span>
                    </div>
                    {emailReservations.map((emailRes) => (
                      <div
                        key={emailRes.id}
                        className={cn(
                          "p-3 rounded-lg border",
                          emailRes.is_processed 
                            ? "bg-gray-50/50 border-gray-200 opacity-70"
                            : "bg-cyan-50/50 border-cyan-200"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2 min-w-0 flex-1">
                            <div className={cn(
                              "p-1.5 rounded-full shrink-0 mt-0.5",
                              emailRes.is_processed ? "bg-gray-100" : "bg-cyan-100"
                            )}>
                              <UserCheck className={cn(
                                "h-4 w-4",
                                emailRes.is_processed ? "text-gray-500" : "text-cyan-600"
                              )} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-medium truncate">{emailRes.guest_name}</p>
                                {emailRes.is_processed && (
                                  <Badge variant="secondary" className="text-[10px] py-0 px-1.5 bg-gray-200 text-gray-600">
                                    ✓ Bearbeitet
                                  </Badge>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {emailRes.guest_count} {emailRes.guest_count === 1 ? 'Person' : 'Personen'}
                                </span>
                                <span className="flex items-center gap-1">
                                  <Moon className="h-3 w-3" />
                                  {emailRes.time} Uhr
                                </span>
                                {emailRes.location && (
                                  <span className="flex items-center gap-1">
                                    <MapPin className="h-3 w-3" />
                                    {emailRes.location}
                                  </span>
                                )}
                                {emailRes.needs_review && (
                                  <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-300 text-amber-600 bg-amber-50">
                                    Prüfen
                                  </Badge>
                                )}
                              </div>
                              {emailRes.guest_phone && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  📞 {emailRes.guest_phone}
                                </p>
                              )}
                              {emailRes.guest_email && (
                                <p className="text-xs text-muted-foreground">
                                  ✉️ {emailRes.guest_email}
                                </p>
                              )}
                              {emailRes.comment && (
                                <p className="text-xs text-muted-foreground mt-1 italic">
                                  "{emailRes.comment}"
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1.5 shrink-0">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-blue-500 hover:text-blue-600 hover:bg-blue-100"
                                onClick={() => handleReImport(emailRes)}
                                title="Erneut parsen"
                                disabled={convertingId === emailRes.id || reImportingId === emailRes.id}
                              >
                                {reImportingId === emailRes.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4" />
                                )}
                              </Button>
                              {!emailRes.is_processed && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-100"
                                  onClick={() => handleMarkProcessed(emailRes.id)}
                                  title="Als bearbeitet markieren"
                                  disabled={convertingId === emailRes.id || reImportingId === emailRes.id}
                                >
                                  <CheckCircle2 className="h-4 w-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-100"
                                onClick={() => handleDeleteEmailReservation(emailRes.id)}
                                title="Löschen"
                                disabled={convertingId === emailRes.id || reImportingId === emailRes.id}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                            {!emailRes.is_processed && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs gap-1 border-primary/50 text-primary hover:bg-primary/10"
                                onClick={() => handleConvertToGroup(emailRes)}
                                disabled={convertingId === emailRes.id || reImportingId === emailRes.id}
                                title="Zu Gruppe konvertieren"
                              >
                                {convertingId === emailRes.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <ArrowRightLeft className="h-3 w-3" />
                                )}
                                <span className="hidden sm:inline">→ Gruppe</span>
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Group Reservations Section */}
                {reservations.length > 0 && (
                  <div className="space-y-2">
                    {emailReservations.length > 0 && (
                      <div className="flex items-center gap-2 text-sm font-medium mt-4">
                        <UsersRound className="h-4 w-4" />
                        <span>Gruppen-Reservierungen ({reservations.length})</span>
                      </div>
                    )}
                    {reservations.map((reservation) => {
                const isEditing = editingId === reservation.id;
                
                if (isEditing && editForm) {
                  // Inline Edit Mode
                  return (
                    <div
                      key={reservation.id}
                      className="p-3 rounded-lg border-2 border-primary bg-primary/5"
                    >
                      <div className="space-y-3">
                        {/* Date Picker with Target Day Preview */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Datum</label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                className={cn(
                                  "w-full h-8 mt-1 justify-start text-left font-normal",
                                  editForm.date !== reservation.date && "border-primary bg-primary/10"
                                )}
                              >
                                <CalendarIcon className="mr-2 h-3 w-3" />
                                {format(parseISO(editForm.date), 'EEEE, d. MMM yyyy', { locale: de })}
                                {editForm.date !== reservation.date && (
                                  <Badge variant="secondary" className="ml-auto text-xs">
                                    <ArrowRight className="h-3 w-3 mr-1" />
                                    Verschoben
                                  </Badge>
                                )}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-auto p-0" align="start">
                              <Calendar
                                mode="single"
                                selected={parseISO(editForm.date)}
                                onSelect={(newDate) => {
                                  if (newDate) {
                                    setEditForm({ ...editForm, date: format(newDate, 'yyyy-MM-dd') });
                                  }
                                }}
                                initialFocus
                                className={cn("p-3 pointer-events-auto")}
                                locale={de}
                              />
                            </PopoverContent>
                          </Popover>
                          
                          {/* Target Day Preview - Show existing events on selected date */}
                          {editForm.date !== reservation.date && (() => {
                            const targetDateEvents = allReservations.filter(r => 
                              r.date === editForm.date && r.id !== reservation.id
                            );
                            const mittagCount = targetDateEvents.filter(r => r.shift === 'mittag').length;
                            const abendCount = targetDateEvents.filter(r => r.shift === 'abend').length;
                            const totalGuests = targetDateEvents.reduce((sum, r) => sum + r.guest_count, 0);
                            
                            return (
                              <div className="mt-2 p-2 rounded-md bg-muted/50 border border-dashed">
                                <div className="flex items-center gap-2 text-xs">
                                  <CalendarIcon className="h-3 w-3 text-muted-foreground" />
                                  <span className="font-medium">Ziel-Tag:</span>
                                  {targetDateEvents.length === 0 ? (
                                    <span className="text-emerald-600">Keine Events</span>
                                  ) : (
                                    <span className="text-amber-600">
                                      {targetDateEvents.length} Event{targetDateEvents.length !== 1 ? 's' : ''}
                                    </span>
                                  )}
                                </div>
                                {targetDateEvents.length > 0 && (
                                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                    {mittagCount > 0 && (
                                      <span className="flex items-center gap-1">
                                        <Sun className="h-3 w-3 text-amber-500" />
                                        {mittagCount} Mittag
                                      </span>
                                    )}
                                    {abendCount > 0 && (
                                      <span className="flex items-center gap-1">
                                        <Moon className="h-3 w-3 text-indigo-500" />
                                        {abendCount} Abend
                                      </span>
                                    )}
                                    <span className="flex items-center gap-1">
                                      <Users className="h-3 w-3" />
                                      {totalGuests} Gäste
                                    </span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>

                        {/* Group Name */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Gruppenname</label>
                          <Input
                            value={editForm.group_name}
                            onChange={(e) => setEditForm({ ...editForm, group_name: e.target.value })}
                            placeholder="Name der Gruppe"
                            className="h-8 mt-1"
                          />
                        </div>

                        {/* Guest Count & Revenue */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Gäste</label>
                            <Input
                              type="number"
                              value={editForm.guest_count}
                              onChange={(e) => setEditForm({ ...editForm, guest_count: parseInt(e.target.value) || 0 })}
                              min={1}
                              className="h-8 mt-1"
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">€ pro Person</label>
                            <Input
                              type="number"
                              value={editForm.revenue_per_person}
                              onChange={(e) => setEditForm({ ...editForm, revenue_per_person: parseFloat(e.target.value) || 0 })}
                              step="0.50"
                              min={0}
                              className="h-8 mt-1"
                            />
                          </div>
                        </div>

                        {/* Shift & Location */}
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Schicht</label>
                            <Select
                              value={editForm.shift}
                              onValueChange={(v) => setEditForm({ ...editForm, shift: v as 'mittag' | 'abend' })}
                            >
                              <SelectTrigger className="h-8 mt-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="mittag">
                                  <span className="flex items-center gap-2">
                                    <Sun className="h-3 w-3 text-amber-500" />
                                    Mittag
                                  </span>
                                </SelectItem>
                                <SelectItem value="abend">
                                  <span className="flex items-center gap-2">
                                    <Moon className="h-3 w-3 text-indigo-500" />
                                    Abend
                                  </span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-muted-foreground">Standort</label>
                            <Select
                              value={editForm.location}
                              onValueChange={(v) => setEditForm({ ...editForm, location: v })}
                            >
                              <SelectTrigger className="h-8 mt-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="EG Restaurant">
                                  <span className="flex items-center gap-2">
                                    <Building className="h-3 w-3" />
                                    EG Restaurant
                                  </span>
                                </SelectItem>
                                <SelectItem value="U1 Bar">
                                  <span className="flex items-center gap-2">
                                    <Wine className="h-3 w-3" />
                                    U1 Bar
                                  </span>
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Notes */}
                        <div>
                          <label className="text-xs font-medium text-muted-foreground">Notizen</label>
                          <Textarea
                            value={editForm.notes}
                            onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                            placeholder="Besondere Wünsche, Allergien, etc."
                            className="h-16 mt-1 resize-none"
                          />
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-end gap-2 pt-2 border-t">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={cancelEditing}
                            disabled={isSaving}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Abbrechen
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => saveChanges(reservation)}
                            disabled={isSaving}
                          >
                            <Save className="h-4 w-4 mr-1" />
                            {isSaving ? 'Speichern...' : 'Speichern'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                }

                // Normal Display Mode
                return (
                  <div
                    key={reservation.id}
                    className={cn(
                      "p-3 rounded-lg border transition-colors",
                      reservation.is_confirmed 
                        ? "bg-emerald-500/10 border-emerald-500/30" 
                        : "bg-amber-500/5 border-amber-500/30"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <div className={cn(
                          "p-1.5 rounded-full shrink-0 mt-0.5",
                          reservation.shift === 'mittag' ? "bg-amber-500/20" : "bg-indigo-500/20"
                        )}>
                          {reservation.shift === 'mittag' ? (
                            <Sun className="h-4 w-4 text-amber-500" />
                          ) : (
                            <Moon className="h-4 w-4 text-indigo-500" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">
                            {reservation.group_name || 'Gruppe'}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {reservation.guest_count} Personen
                            </span>
                            <span className="flex items-center gap-1">
                              {reservation.location === 'U1 Bar' ? (
                                <Wine className="h-3 w-3" />
                              ) : (
                                <Building className="h-3 w-3" />
                              )}
                              {reservation.location || 'EG Restaurant'}
                            </span>
                            <span className="flex items-center gap-1">
                              <Euro className="h-3 w-3" />
                              {formatCurrency(reservation.guest_count * reservation.revenue_per_person)}
                            </span>
                            {reservation.group_type && (
                              <Badge 
                                variant="outline" 
                                className={cn(
                                  "text-[10px] py-0 px-1.5 gap-0.5",
                                  reservation.group_type === 'laufzettel' 
                                    ? "border-blue-300 text-blue-600 bg-blue-50" 
                                    : "border-orange-300 text-orange-600 bg-orange-50"
                                )}
                              >
                                {reservation.group_type === 'laufzettel' ? (
                                  <>
                                    <ClipboardCheck className="h-2.5 w-2.5" />
                                    Laufzettel
                                  </>
                                ) : (
                                  <>
                                    <Utensils className="h-2.5 w-2.5" />
                                    À la carte
                                  </>
                                )}
                              </Badge>
                            )}
                            {reservation.revenue_mode && onToggleRevenueMode && (
                              <Badge 
                                variant="outline" 
                                className={cn(
                                  "text-[10px] py-0 px-1.5 gap-0.5 cursor-pointer hover:opacity-80 transition-opacity",
                                  reservation.revenue_mode === 'additional' 
                                    ? "border-emerald-300 text-emerald-600 bg-emerald-50 hover:bg-emerald-100" 
                                    : "border-slate-300 text-slate-600 bg-slate-50 hover:bg-slate-100"
                                )}
                                onClick={() => onToggleRevenueMode(
                                  reservation.id, 
                                  reservation.revenue_mode === 'additional' ? 'offset' : 'additional'
                                )}
                              >
                                {reservation.revenue_mode === 'additional' ? (
                                  <>
                                    <PlusCircle className="h-2.5 w-2.5" />
                                    Zusätzlich
                                  </>
                                ) : (
                                  <>
                                    <ArrowDownToLine className="h-2.5 w-2.5" />
                                    Vom Budget
                                  </>
                                )}
                              </Badge>
                            )}
                            {reservation.revenue_mode && !onToggleRevenueMode && (
                              <Badge 
                                variant="outline" 
                                className={cn(
                                  "text-[10px] py-0 px-1.5 gap-0.5",
                                  reservation.revenue_mode === 'additional' 
                                    ? "border-emerald-300 text-emerald-600 bg-emerald-50" 
                                    : "border-slate-300 text-slate-600 bg-slate-50"
                                )}
                              >
                                {reservation.revenue_mode === 'additional' ? (
                                  <>
                                    <PlusCircle className="h-2.5 w-2.5" />
                                    Zusätzlich
                                  </>
                                ) : (
                                  <>
                                    <ArrowDownToLine className="h-2.5 w-2.5" />
                                    Vom Budget
                                  </>
                                )}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      {onUpdateEvent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 shrink-0"
                          onClick={() => startEditing(reservation)}
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>

                    {/* Status Checkboxes - Main */}
                    <div className="flex flex-wrap items-center gap-3 mt-3 pt-2 border-t border-border/50">
                      {onToggleConfirmed && (
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={reservation.is_confirmed || false}
                            onCheckedChange={(checked) => 
                              onToggleConfirmed(reservation.id, checked === true)
                            }
                            className={cn(
                              "h-4 w-4",
                              reservation.is_confirmed 
                                ? "border-emerald-500 data-[state=checked]:bg-emerald-500" 
                                : "border-amber-500"
                            )}
                          />
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            Bestätigt
                          </span>
                        </label>
                      )}
                      {onToggleLaufzettel && (
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <Checkbox
                            checked={reservation.laufzettel_done || false}
                            onCheckedChange={(checked) => 
                              onToggleLaufzettel(reservation.id, checked === true)
                            }
                            className={cn(
                              "h-4 w-4",
                              reservation.laufzettel_done 
                                ? "border-blue-500 data-[state=checked]:bg-blue-500" 
                                : ""
                            )}
                          />
                          <span className="flex items-center gap-1">
                            <ClipboardList className="h-3 w-3" />
                            Laufzettel
                          </span>
                        </label>
                      )}
                      {reservation.menu_pdf_url && (
                        <a
                          href={reservation.menu_pdf_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs text-blue-500 hover:underline ml-auto"
                        >
                          <FileText className="h-3 w-3" />
                          PDF
                        </a>
                      )}
                    </div>

                    {/* Checklist Progress Bar */}
                    <div className="mt-3 pt-2 border-t border-border/50">
                      {(() => {
                        const progress = getChecklistProgress(reservation);
                        return (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-muted-foreground">Checkliste</span>
                              <span className={cn(
                                "font-medium",
                                progress.percentage === 100 ? "text-emerald-500" : 
                                progress.percentage >= 50 ? "text-amber-500" : "text-orange-500"
                              )}>
                                {progress.completed}/{progress.total}
                              </span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                              <div 
                                className={cn(
                                  "h-full transition-all duration-300",
                                  getProgressColor(progress.percentage)
                                )}
                                style={{ width: `${progress.percentage}%` }}
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Department Checklists */}
                    {onToggleDepartmentReady && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <p className="text-xs font-medium text-muted-foreground mb-2">Abteilungen bereit:</p>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="flex items-center gap-2 text-xs cursor-pointer p-1.5 rounded hover:bg-muted/50 transition-colors">
                            <Checkbox
                              checked={reservation.dekoration_ready || false}
                              onCheckedChange={(checked) => 
                                onToggleDepartmentReady(reservation.id, 'dekoration_ready', checked === true)
                              }
                              className={cn(
                                "h-4 w-4",
                                reservation.dekoration_ready 
                                  ? "border-pink-500 data-[state=checked]:bg-pink-500" 
                                  : ""
                              )}
                            />
                            <span className="flex items-center gap-1">
                              <Palette className="h-3 w-3 text-pink-500" />
                              Dekoration
                            </span>
                          </label>
                          <label className="flex items-center gap-2 text-xs cursor-pointer p-1.5 rounded hover:bg-muted/50 transition-colors">
                            <Checkbox
                              checked={reservation.service_ready || false}
                              onCheckedChange={(checked) => 
                                onToggleDepartmentReady(reservation.id, 'service_ready', checked === true)
                              }
                              className={cn(
                                "h-4 w-4",
                                reservation.service_ready 
                                  ? "border-cyan-500 data-[state=checked]:bg-cyan-500" 
                                  : ""
                              )}
                            />
                            <span className="flex items-center gap-1">
                              <UtensilsCrossed className="h-3 w-3 text-cyan-500" />
                              Service
                            </span>
                          </label>
                          <label className="flex items-center gap-2 text-xs cursor-pointer p-1.5 rounded hover:bg-muted/50 transition-colors">
                            <Checkbox
                              checked={reservation.bar_ready || false}
                              onCheckedChange={(checked) => 
                                onToggleDepartmentReady(reservation.id, 'bar_ready', checked === true)
                              }
                              className={cn(
                                "h-4 w-4",
                                reservation.bar_ready 
                                  ? "border-purple-500 data-[state=checked]:bg-purple-500" 
                                  : ""
                              )}
                            />
                            <span className="flex items-center gap-1">
                              <GlassWater className="h-3 w-3 text-purple-500" />
                              Bar
                            </span>
                          </label>
                          <label className="flex items-center gap-2 text-xs cursor-pointer p-1.5 rounded hover:bg-muted/50 transition-colors">
                            <Checkbox
                              checked={reservation.kueche_ready || false}
                              onCheckedChange={(checked) => 
                                onToggleDepartmentReady(reservation.id, 'kueche_ready', checked === true)
                              }
                              className={cn(
                                "h-4 w-4",
                                reservation.kueche_ready 
                                  ? "border-orange-500 data-[state=checked]:bg-orange-500" 
                                  : ""
                              )}
                            />
                            <span className="flex items-center gap-1">
                              <ChefHat className="h-3 w-3 text-orange-500" />
                              Küche
                            </span>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* Notes */}
                    {reservation.notes && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium">Notizen:</span> {reservation.notes}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        {/* Add Event Button */}
        {onAddEvent && (
          <Button
            variant="outline"
            className="w-full mt-2"
            onClick={() => {
              onOpenChange(false);
              onAddEvent(date);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Event hinzufügen
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};