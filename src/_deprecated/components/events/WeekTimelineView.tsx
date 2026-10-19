import { useMemo, useState, useEffect } from 'react';
import { format, startOfWeek, endOfWeek, eachDayOfInterval, isSameDay, isToday, parseISO, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/personnel-utils';
import { supabase } from '@/integrations/supabase/client';
import {
  Users,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Euro,
  UsersRound,
  UserCheck,
  MapPin,
  Clock,
  Briefcase,
  CheckCheck
} from 'lucide-react';

interface GroupReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  group_name: string | null;
  guest_count: number;
  revenue_per_person: number;
  notes: string | null;
  location: string | null;
  is_confirmed?: boolean;
  applied_to_budget?: boolean;
  gf_accepted?: boolean;
  gf_final_confirmed?: boolean;
}

interface EmailReservation {
  id: string;
  date: string;
  time: string;
  guest_name: string;
  guest_count: number;
  location?: string;
}

interface WeekTimelineViewProps {
  reservations: GroupReservation[];
  selectedDate: Date;
  onDateSelect: (date: Date) => void;
  onWeekChange: (date: Date) => void;
  onDayClick?: (dateString: string) => void;
}

export const WeekTimelineView = ({
  reservations,
  selectedDate,
  onDateSelect,
  onWeekChange,
  onDayClick
}: WeekTimelineViewProps) => {
  const [currentWeekStart, setCurrentWeekStart] = useState(startOfWeek(selectedDate, { weekStartsOn: 1 }));
  const [emailReservations, setEmailReservations] = useState<EmailReservation[]>([]);

  // Get all days in the week
  const weekDays = useMemo(() => {
    const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: currentWeekStart, end: weekEnd });
  }, [currentWeekStart]);

  // Fetch email reservations for current week
  useEffect(() => {
    const fetchEmailReservations = async () => {
      const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
      
      const { data, error } = await supabase
        .from('email_imported_reservations')
        .select('*')
        .gte('date', format(currentWeekStart, 'yyyy-MM-dd'))
        .lte('date', format(weekEnd, 'yyyy-MM-dd'))
        .eq('is_processed', false);
        
      if (!error && data) {
        setEmailReservations(data.map(r => ({
          id: r.id,
          date: r.date,
          time: r.time,
          guest_name: r.guest_name,
          guest_count: r.guest_count,
          location: r.location || undefined
        })));
      }
    };
    
    fetchEmailReservations();
  }, [currentWeekStart]);

  // Group data by date
  const reservationsByDate = useMemo(() => {
    const groups: Record<string, { mittag: GroupReservation[]; abend: GroupReservation[] }> = {};
    weekDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      groups[dateStr] = { mittag: [], abend: [] };
    });
    
    reservations.forEach(r => {
      if (groups[r.date]) {
        groups[r.date][r.shift].push(r);
      }
    });
    return groups;
  }, [reservations, weekDays]);

  const emailsByDate = useMemo(() => {
    const groups: Record<string, { mittag: EmailReservation[]; abend: EmailReservation[] }> = {};
    weekDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      groups[dateStr] = { mittag: [], abend: [] };
    });
    
    emailReservations.forEach(r => {
      if (groups[r.date]) {
        const hours = parseInt(r.time.split(':')[0], 10);
        const shift = hours < 15 ? 'mittag' : 'abend';
        groups[r.date][shift].push(r);
      }
    });
    return groups;
  }, [emailReservations, weekDays]);

  // Navigation
  const goToPreviousWeek = () => {
    const newWeekStart = new Date(currentWeekStart);
    newWeekStart.setDate(newWeekStart.getDate() - 7);
    setCurrentWeekStart(newWeekStart);
    onWeekChange(newWeekStart);
  };

  const goToNextWeek = () => {
    const newWeekStart = new Date(currentWeekStart);
    newWeekStart.setDate(newWeekStart.getDate() + 7);
    setCurrentWeekStart(newWeekStart);
    onWeekChange(newWeekStart);
  };

  const goToToday = () => {
    const today = new Date();
    setCurrentWeekStart(startOfWeek(today, { weekStartsOn: 1 }));
    onDateSelect(today);
    onWeekChange(today);
  };

  // Week stats
  const weekStats = useMemo(() => {
    const totalGroups = reservations.length;
    const totalGroupGuests = reservations.reduce((sum, r) => sum + r.guest_count, 0);
    const totalEmailGuests = emailReservations.reduce((sum, r) => sum + r.guest_count, 0);
    const totalRevenue = reservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    
    return { totalGroups, totalGroupGuests, totalEmailGuests, totalRevenue, emailCount: emailReservations.length };
  }, [reservations, emailReservations]);

  const weekNumber = getISOWeek(currentWeekStart);

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Wochen-Timeline
            <Badge variant="outline" className="ml-1">KW {weekNumber}</Badge>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={goToPreviousWeek} className="h-8 w-8 p-0">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={goToToday} className="h-8 px-3 text-xs">
              Heute
            </Button>
            <Button variant="ghost" size="sm" onClick={goToNextWeek} className="h-8 w-8 p-0">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {format(currentWeekStart, 'd. MMM', { locale: de })} – {format(endOfWeek(currentWeekStart, { weekStartsOn: 1 }), 'd. MMM yyyy', { locale: de })}
        </p>
      </CardHeader>
      
      <CardContent className="p-2 sm:p-4">
        {/* Week Stats Bar */}
        <div className="grid grid-cols-4 gap-2 mb-3 p-2 bg-muted/30 rounded-lg">
          <div className="text-center">
            <p className="text-lg font-bold">{weekStats.totalGroups}</p>
            <p className="text-[10px] text-muted-foreground">Gruppen</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold">{weekStats.emailCount}</p>
            <p className="text-[10px] text-muted-foreground">Gäste-Res.</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              <p className="text-lg font-bold">{weekStats.totalGroupGuests}</p>
              {weekStats.totalEmailGuests > 0 && (
                <span className="text-[10px] text-cyan-600 font-medium">+{weekStats.totalEmailGuests}</span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">Gäste</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-primary">{formatCurrency(weekStats.totalRevenue)}</p>
            <p className="text-[10px] text-muted-foreground">Umsatz</p>
          </div>
        </div>

        {/* Timeline Grid */}
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            {/* Day Headers */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              {weekDays.map((day) => {
                const isDayToday = isToday(day);
                const isSelected = isSameDay(day, selectedDate);
                
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      "text-center py-2 rounded-t-lg font-medium text-sm",
                      isDayToday && "bg-primary/10 text-primary",
                      isSelected && !isDayToday && "bg-muted"
                    )}
                  >
                    <div className="text-xs text-muted-foreground">
                      {format(day, 'EEE', { locale: de })}
                    </div>
                    <div className={cn(isDayToday && "font-bold")}>
                      {format(day, 'd')}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Mittag Row */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              <div className="col-span-7 flex items-center gap-1 mb-1 pl-1">
                <Sun className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-medium text-muted-foreground">Mittag</span>
              </div>
              {weekDays.map((day) => {
                const dateStr = format(day, 'yyyy-MM-dd');
                const mittagGroups = reservationsByDate[dateStr]?.mittag || [];
                const mittagEmails = emailsByDate[dateStr]?.mittag || [];
                const hasData = mittagGroups.length > 0 || mittagEmails.length > 0;
                
                return (
                  <TooltipProvider key={`mittag-${dateStr}`}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onDayClick?.(dateStr)}
                          className={cn(
                            "min-h-[60px] p-1 rounded-lg border transition-all",
                            "hover:ring-2 hover:ring-primary/50",
                            hasData ? "bg-amber-50/50 border-amber-200 dark:bg-amber-950/20" : "bg-muted/30 border-transparent"
                          )}
                        >
                          <div className="space-y-0.5">
                            {mittagGroups.map((r) => (
                              <div
                                key={r.id}
                                className={cn(
                                  "text-[10px] rounded px-1 py-0.5 truncate flex items-center gap-0.5",
                                  r.gf_final_confirmed 
                                    ? "bg-green-100 dark:bg-green-900/50 ring-1 ring-green-400"
                                    : r.gf_accepted
                                    ? "bg-violet-100 dark:bg-violet-900/50 ring-1 ring-violet-300"
                                    : "bg-amber-100 dark:bg-amber-900/50"
                                )}
                              >
                                {r.gf_final_confirmed && <CheckCheck className="h-2.5 w-2.5 text-green-600 shrink-0" />}
                                {r.gf_accepted && !r.gf_final_confirmed && <Briefcase className="h-2.5 w-2.5 text-violet-600 shrink-0" />}
                                <span className="font-medium">{r.guest_count}</span>
                                {r.group_name && (
                                  <span className="text-muted-foreground truncate">
                                    {r.group_name.substring(0, 8)}
                                  </span>
                                )}
                              </div>
                            ))}
                            {mittagEmails.map((r) => (
                              <div
                                key={r.id}
                                className="text-[10px] bg-cyan-100 dark:bg-cyan-900/50 rounded px-1 py-0.5 truncate text-cyan-700 dark:text-cyan-300"
                              >
                                <span className="font-medium">{r.guest_count}</span>
                                <span className="ml-0.5 truncate">{r.guest_name.split(' ')[0]}</span>
                              </div>
                            ))}
                          </div>
                        </button>
                      </TooltipTrigger>
                      {hasData && (
                        <TooltipContent>
                          <div className="space-y-1">
                            <p className="font-medium">{format(day, 'EEEE, d. MMMM', { locale: de })} - Mittag</p>
                            {mittagGroups.map(r => (
                              <div key={r.id} className="text-xs">
                                <UsersRound className="h-3 w-3 inline mr-1" />
                                {r.group_name || 'Gruppe'}: {r.guest_count} Gäste
                              </div>
                            ))}
                            {mittagEmails.map(r => (
                              <div key={r.id} className="text-xs text-cyan-600">
                                <UserCheck className="h-3 w-3 inline mr-1" />
                                {r.guest_name}: {r.guest_count} Gäste ({r.time})
                              </div>
                            ))}
                          </div>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                );
              })}
            </div>

            {/* Abend Row */}
            <div className="grid grid-cols-7 gap-1">
              <div className="col-span-7 flex items-center gap-1 mb-1 pl-1">
                <Moon className="h-3.5 w-3.5 text-indigo-500" />
                <span className="text-xs font-medium text-muted-foreground">Abend</span>
              </div>
              {weekDays.map((day) => {
                const dateStr = format(day, 'yyyy-MM-dd');
                const abendGroups = reservationsByDate[dateStr]?.abend || [];
                const abendEmails = emailsByDate[dateStr]?.abend || [];
                const hasData = abendGroups.length > 0 || abendEmails.length > 0;
                
                return (
                  <TooltipProvider key={`abend-${dateStr}`}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => onDayClick?.(dateStr)}
                          className={cn(
                            "min-h-[60px] p-1 rounded-lg border transition-all",
                            "hover:ring-2 hover:ring-primary/50",
                            hasData ? "bg-indigo-50/50 border-indigo-200 dark:bg-indigo-950/20" : "bg-muted/30 border-transparent"
                          )}
                        >
                          <div className="space-y-0.5">
                            {abendGroups.map((r) => (
                              <div
                                key={r.id}
                                className={cn(
                                  "text-[10px] rounded px-1 py-0.5 truncate flex items-center gap-0.5",
                                  r.gf_final_confirmed 
                                    ? "bg-green-100 dark:bg-green-900/50 ring-1 ring-green-400"
                                    : r.gf_accepted
                                    ? "bg-violet-100 dark:bg-violet-900/50 ring-1 ring-violet-300"
                                    : "bg-indigo-100 dark:bg-indigo-900/50"
                                )}
                              >
                                {r.gf_final_confirmed && <CheckCheck className="h-2.5 w-2.5 text-green-600 shrink-0" />}
                                {r.gf_accepted && !r.gf_final_confirmed && <Briefcase className="h-2.5 w-2.5 text-violet-600 shrink-0" />}
                                <span className="font-medium">{r.guest_count}</span>
                                {r.group_name && (
                                  <span className="text-muted-foreground truncate">
                                    {r.group_name.substring(0, 8)}
                                  </span>
                                )}
                              </div>
                            ))}
                            {abendEmails.map((r) => (
                              <div
                                key={r.id}
                                className="text-[10px] bg-cyan-100 dark:bg-cyan-900/50 rounded px-1 py-0.5 truncate text-cyan-700 dark:text-cyan-300"
                              >
                                <span className="font-medium">{r.guest_count}</span>
                                <span className="ml-0.5 truncate">{r.guest_name.split(' ')[0]}</span>
                              </div>
                            ))}
                          </div>
                        </button>
                      </TooltipTrigger>
                      {hasData && (
                        <TooltipContent>
                          <div className="space-y-1">
                            <p className="font-medium">{format(day, 'EEEE, d. MMMM', { locale: de })} - Abend</p>
                            {abendGroups.map(r => (
                              <div key={r.id} className="text-xs">
                                <UsersRound className="h-3 w-3 inline mr-1" />
                                {r.group_name || 'Gruppe'}: {r.guest_count} Gäste
                              </div>
                            ))}
                            {abendEmails.map(r => (
                              <div key={r.id} className="text-xs text-cyan-600">
                                <UserCheck className="h-3 w-3 inline mr-1" />
                                {r.guest_name}: {r.guest_count} Gäste ({r.time})
                              </div>
                            ))}
                          </div>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                );
              })}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
