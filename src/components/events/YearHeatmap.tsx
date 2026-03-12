import { useMemo, useState, useEffect } from 'react';
import { format, startOfYear, endOfYear, eachMonthOfInterval, eachDayOfInterval, startOfMonth, endOfMonth, getDay, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/personnel-utils';
import { supabase } from '@/integrations/supabase/client';
import { exportYearHeatmapPDF, exportYearHeatmapExcel } from '@/lib/year-heatmap-export';
import { toast } from 'sonner';
import {
  Calendar,
  Users,
  Euro,
  TrendingUp,
  PartyPopper,
  UsersRound,
  UserCheck,
  Filter,
  Download,
  FileText,
  FileSpreadsheet
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
  exclude_walk_in: boolean;
}

interface EmailReservation {
  id: string;
  date: string;
  time: string;
  guest_name: string;
  guest_count: number;
  is_processed: boolean;
}

interface YearHeatmapProps {
  reservations: GroupReservation[];
  selectedDate: Date;
  onMonthSelect?: (month: Date) => void;
}

type FilterMode = 'all' | 'groups' | 'guests';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export const YearHeatmap = ({ reservations, selectedDate, onMonthSelect }: YearHeatmapProps) => {
  const year = selectedDate.getFullYear();
  const yearStart = startOfYear(selectedDate);
  const yearEnd = endOfYear(selectedDate);
  
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [emailReservations, setEmailReservations] = useState<EmailReservation[]>([]);

  // Fetch email reservations for the year
  useEffect(() => {
    const fetchEmailReservations = async () => {
      const { data, error } = await supabase
        .from('email_imported_reservations')
        .select('id, date, time, guest_name, guest_count, is_processed')
        .gte('date', format(yearStart, 'yyyy-MM-dd'))
        .lte('date', format(yearEnd, 'yyyy-MM-dd'))
        .order('time');
        
      if (!error && data) {
        setEmailReservations(data.map(r => ({
          id: r.id,
          date: r.date,
          time: r.time,
          guest_name: r.guest_name,
          guest_count: r.guest_count,
          is_processed: r.is_processed
        })));
      }
    };
    
    fetchEmailReservations();
  }, [yearStart, yearEnd]);

  // Group reservations by date
  const reservationsByDate = useMemo(() => {
    const groups: Record<string, GroupReservation[]> = {};
    reservations.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });
    return groups;
  }, [reservations]);

  // Group email reservations by date
  const emailReservationsByDate = useMemo(() => {
    const groups: Record<string, EmailReservation[]> = {};
    emailReservations.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });
    return groups;
  }, [emailReservations]);

  // Calculate monthly stats
  const monthlyStats = useMemo(() => {
    const months = eachMonthOfInterval({ start: yearStart, end: yearEnd });
    const showGroups = filterMode === 'all' || filterMode === 'groups';
    const showGuests = filterMode === 'all' || filterMode === 'guests';
    
    return months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });
      
      let totalEvents = 0;
      let totalGuests = 0;
      let totalRevenue = 0;
      let daysWithEvents = 0;
      let groupCount = 0;
      let guestCount = 0;
      let groupGuests = 0;
      let emailGuests = 0;

      monthDays.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const dayReservations = reservationsByDate[dateStr] || [];
        const dayEmailReservations = emailReservationsByDate[dateStr] || [];
        
        const hasGroupEvents = showGroups && dayReservations.length > 0;
        const hasEmailEvents = showGuests && dayEmailReservations.length > 0;
        
        if (hasGroupEvents || hasEmailEvents) {
          daysWithEvents++;
        }
        
        if (showGroups) {
          groupCount += dayReservations.length;
          groupGuests += dayReservations.reduce((sum, r) => sum + r.guest_count, 0);
          totalRevenue += dayReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        }
        
        if (showGuests) {
          guestCount += dayEmailReservations.length;
          emailGuests += dayEmailReservations.reduce((sum, r) => sum + r.guest_count, 0);
        }
      });

      totalEvents = groupCount + guestCount;
      totalGuests = groupGuests + emailGuests;

      return {
        month,
        monthName: format(month, 'MMMM', { locale: de }),
        shortName: format(month, 'MMM', { locale: de }),
        totalEvents,
        totalGuests,
        totalRevenue,
        daysWithEvents,
        totalDays: monthDays.length,
        groupCount,
        guestCount,
        groupGuests,
        emailGuests
      };
    });
  }, [yearStart, yearEnd, reservationsByDate, emailReservationsByDate, filterMode]);

  // Find max values for color scaling
  const maxEvents = Math.max(...monthlyStats.map(m => m.totalEvents), 1);
  const maxGuests = Math.max(...monthlyStats.map(m => m.totalGuests), 1);

  // Year totals
  const yearTotals = useMemo(() => {
    return monthlyStats.reduce(
      (acc, m) => ({
        events: acc.events + m.totalEvents,
        guests: acc.guests + m.totalGuests,
        revenue: acc.revenue + m.totalRevenue,
        daysWithEvents: acc.daysWithEvents + m.daysWithEvents,
        groupCount: acc.groupCount + m.groupCount,
        guestCount: acc.guestCount + m.guestCount,
        groupGuests: acc.groupGuests + m.groupGuests,
        emailGuests: acc.emailGuests + m.emailGuests
      }),
      { events: 0, guests: 0, revenue: 0, daysWithEvents: 0, groupCount: 0, guestCount: 0, groupGuests: 0, emailGuests: 0 }
    );
  }, [monthlyStats]);

  // Daily heatmap for the full year
  const dailyHeatmapData = useMemo(() => {
    const months = eachMonthOfInterval({ start: yearStart, end: yearEnd });
    const showGroups = filterMode === 'all' || filterMode === 'groups';
    const showGuests = filterMode === 'all' || filterMode === 'guests';
    
    return months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
      
      // Create a grid with weeks as rows
      const weeks: { date: Date; guests: number; events: number; groupGuests: number; emailGuests: number; groupCount: number; emailCount: number }[][] = [];
      let currentWeek: { date: Date; guests: number; events: number; groupGuests: number; emailGuests: number; groupCount: number; emailCount: number }[] = [];
      
      // Pad the first week
      const firstDayOfWeek = getDay(monthStart);
      const paddingDays = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
      for (let i = 0; i < paddingDays; i++) {
        currentWeek.push({ date: new Date(0), guests: -1, events: -1, groupGuests: 0, emailGuests: 0, groupCount: 0, emailCount: 0 });
      }
      
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const dayReservations = reservationsByDate[dateStr] || [];
        const dayEmailReservations = emailReservationsByDate[dateStr] || [];
        
        const groupGuests = showGroups ? dayReservations.reduce((sum, r) => sum + r.guest_count, 0) : 0;
        const emailGuests = showGuests ? dayEmailReservations.reduce((sum, r) => sum + r.guest_count, 0) : 0;
        const groupCount = showGroups ? dayReservations.length : 0;
        const emailCount = showGuests ? dayEmailReservations.length : 0;
        
        currentWeek.push({ 
          date: day, 
          guests: groupGuests + emailGuests, 
          events: groupCount + emailCount,
          groupGuests,
          emailGuests,
          groupCount,
          emailCount
        });
        
        if (currentWeek.length === 7) {
          weeks.push(currentWeek);
          currentWeek = [];
        }
      });
      
      // Pad the last week
      if (currentWeek.length > 0) {
        while (currentWeek.length < 7) {
          currentWeek.push({ date: new Date(0), guests: -1, events: -1, groupGuests: 0, emailGuests: 0, groupCount: 0, emailCount: 0 });
        }
        weeks.push(currentWeek);
      }
      
      return {
        month,
        monthName: format(month, 'MMM', { locale: de }),
        weeks
      };
    });
  }, [yearStart, yearEnd, reservationsByDate, emailReservationsByDate, filterMode]);

  // Find max daily guests for scaling
  const maxDailyGuests = useMemo(() => {
    let max = 1;
    const showGroups = filterMode === 'all' || filterMode === 'groups';
    const showGuests = filterMode === 'all' || filterMode === 'guests';
    
    const allDates = new Set([...Object.keys(reservationsByDate), ...Object.keys(emailReservationsByDate)]);
    allDates.forEach(dateStr => {
      const dayRes = reservationsByDate[dateStr] || [];
      const dayEmail = emailReservationsByDate[dateStr] || [];
      const groupGuests = showGroups ? dayRes.reduce((sum, r) => sum + r.guest_count, 0) : 0;
      const emailGuests = showGuests ? dayEmail.reduce((sum, r) => sum + r.guest_count, 0) : 0;
      const total = groupGuests + emailGuests;
      if (total > max) max = total;
    });
    return max;
  }, [reservationsByDate, emailReservationsByDate, filterMode]);

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Jahresübersicht {year}
          </CardTitle>
          
          {/* Filter Toggle */}
          <ToggleGroup 
            type="single" 
            value={filterMode} 
            onValueChange={(value) => value && setFilterMode(value as FilterMode)}
            className="justify-start"
          >
            <ToggleGroupItem value="all" aria-label="Alle anzeigen" className="text-xs px-2 h-7 gap-1">
              <Filter className="h-3 w-3" />
              <span className="hidden sm:inline">Alle</span>
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                {yearTotals.groupCount + yearTotals.guestCount}
              </Badge>
            </ToggleGroupItem>
            <ToggleGroupItem value="groups" aria-label="Nur Gruppen" className="text-xs px-2 h-7 gap-1">
              <UsersRound className="h-3 w-3" />
              <span className="hidden sm:inline">Gruppen</span>
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                {yearTotals.groupCount}
              </Badge>
            </ToggleGroupItem>
            <ToggleGroupItem value="guests" aria-label="Nur Gäste" className="text-xs px-2 h-7 gap-1">
              <UserCheck className="h-3 w-3" />
              <span className="hidden sm:inline">Gäste</span>
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                {yearTotals.guestCount}
              </Badge>
            </ToggleGroupItem>
          </ToggleGroup>
          
          {/* Export Button */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                <Download className="h-3 w-3" />
                <span className="hidden sm:inline">Export</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => {
                try {
                  exportYearHeatmapPDF({
                    groupReservations: reservations,
                    emailReservations,
                    year,
                    filterMode
                  });
                  toast.success('PDF Export gestartet');
                } catch (error) {
                  toast.error('Export fehlgeschlagen');
                }
              }}>
                <FileText className="h-4 w-4 mr-2" />
                Als PDF exportieren
              </DropdownMenuItem>
              <DropdownMenuItem onClick={async () => {
                try {
                  await exportYearHeatmapExcel({
                    groupReservations: reservations,
                    emailReservations,
                    year,
                    filterMode
                  });
                  toast.success('Excel Export gestartet');
                } catch (error) {
                  toast.error('Export fehlgeschlagen');
                }
              }}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Als Excel exportieren
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Year Summary */}
        <div className="grid grid-cols-4 gap-4 p-3 bg-muted/30 rounded-lg">
          <div className="text-center">
            <p className="text-2xl font-bold">{yearTotals.events}</p>
            <p className="text-xs text-muted-foreground">
              {filterMode === 'groups' ? 'Gruppen' : filterMode === 'guests' ? 'Gäste-Res.' : 'Reserv.'}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold">{yearTotals.daysWithEvents}</p>
            <p className="text-xs text-muted-foreground">Tage</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              <p className="text-2xl font-bold">{yearTotals.guests.toLocaleString('de-CH')}</p>
            </div>
            {filterMode === 'all' && yearTotals.groupGuests > 0 && yearTotals.emailGuests > 0 && (
              <p className="text-[10px] text-muted-foreground">
                {yearTotals.groupGuests} Gruppen + {yearTotals.emailGuests} Gäste
              </p>
            )}
            {(filterMode !== 'all' || yearTotals.groupGuests === 0 || yearTotals.emailGuests === 0) && (
              <p className="text-xs text-muted-foreground">Gäste</p>
            )}
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-primary">{formatCurrency(yearTotals.revenue)}</p>
            <p className="text-xs text-muted-foreground">Umsatz</p>
          </div>
        </div>

        {/* Monthly Bar Chart */}
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Monatliche Auslastung
          </h4>
          <div className="space-y-2">
            {monthlyStats.map((month, idx) => {
              const guestPercentage = (month.totalGuests / maxGuests) * 100;
              
              return (
                <TooltipProvider key={idx}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => onMonthSelect?.(month.month)}
                        className="w-full group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="w-8 text-xs text-muted-foreground text-right">
                            {month.shortName}
                          </span>
                          <div className="flex-1 h-6 bg-muted/30 rounded overflow-hidden relative">
                            {/* Guest bar with gradient for mixed data */}
                            <div
                              className={cn(
                                "absolute inset-y-0 left-0 transition-all duration-300",
                                filterMode === 'guests' ? "bg-cyan-500/60 group-hover:bg-cyan-500/80" :
                                filterMode === 'groups' ? "bg-primary/60 group-hover:bg-primary/80" :
                                "bg-gradient-to-r from-primary/60 to-cyan-500/60 group-hover:from-primary/80 group-hover:to-cyan-500/80"
                              )}
                              style={{ width: `${guestPercentage}%` }}
                            />
                            {/* Event count */}
                            {month.totalEvents > 0 && (
                              <div className="absolute inset-y-0 right-2 flex items-center gap-1">
                                <span className="text-xs font-medium text-foreground">
                                  {month.totalEvents} {filterMode === 'guests' ? 'Res.' : filterMode === 'groups' ? 'Gruppen' : 'Events'}
                                </span>
                              </div>
                            )}
                          </div>
                          <span className="w-16 text-xs font-medium text-right">
                            {month.totalGuests} Gäste
                          </span>
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <div className="space-y-1">
                        <p className="font-medium">{month.monthName} {year}</p>
                        <div className="text-sm space-y-0.5">
                          {(filterMode === 'all' || filterMode === 'groups') && month.groupCount > 0 && (
                            <p className="flex items-center gap-2">
                              <UsersRound className="h-3 w-3" />
                              {month.groupCount} Gruppen ({month.groupGuests} Gäste)
                            </p>
                          )}
                          {(filterMode === 'all' || filterMode === 'guests') && month.guestCount > 0 && (
                            <p className="flex items-center gap-2 text-cyan-600">
                              <UserCheck className="h-3 w-3" />
                              {month.guestCount} Gast-Res. ({month.emailGuests} Gäste)
                            </p>
                          )}
                          <p className="flex items-center gap-2">
                            <PartyPopper className="h-3 w-3" />
                            {month.daysWithEvents} Tage mit Events
                          </p>
                          {month.totalRevenue > 0 && (
                            <p className="flex items-center gap-2 text-primary font-medium">
                              <Euro className="h-3 w-3" />
                              {formatCurrency(month.totalRevenue)}
                            </p>
                          )}
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </div>
        </div>

        {/* Daily Heatmap Grid */}
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Tägliche Heatmap
          </h4>
          
          <div className="overflow-x-auto">
            <div className="flex gap-1 min-w-max">
              {/* Weekday labels */}
              <div className="flex flex-col gap-[2px] pt-5">
                {WEEKDAYS.map((day, i) => (
                  <div key={day} className="h-3 text-[9px] text-muted-foreground flex items-center pr-1">
                    {i % 2 === 0 ? day : ''}
                  </div>
                ))}
              </div>
              
              {/* Month columns */}
              <TooltipProvider>
                {dailyHeatmapData.map((monthData, monthIdx) => (
                  <div key={monthIdx} className="flex flex-col gap-[2px]">
                    {/* Month label */}
                    <div className="text-[10px] text-muted-foreground text-center h-4 mb-1">
                      {monthData.monthName}
                    </div>
                    
                    {/* Week rows */}
                    <div className="flex gap-[2px]">
                      {monthData.weeks.map((week, weekIdx) => (
                        <div key={weekIdx} className="flex flex-col gap-[2px]">
                          {week.map((day, dayIdx) => {
                            if (day.guests < 0) {
                              return <div key={dayIdx} className="w-3 h-3" />;
                            }
                            
                            const intensity = day.guests / maxDailyGuests;
                            let bgClass = 'bg-muted/20';
                            if (day.guests > 0) {
                              // Color based on filter mode
                              if (filterMode === 'guests') {
                                if (intensity < 0.2) bgClass = 'bg-cyan-400/30';
                                else if (intensity < 0.4) bgClass = 'bg-cyan-500/50';
                                else if (intensity < 0.6) bgClass = 'bg-cyan-500/60';
                                else if (intensity < 0.8) bgClass = 'bg-cyan-600/70';
                                else bgClass = 'bg-cyan-700/80';
                              } else if (filterMode === 'groups') {
                                if (intensity < 0.2) bgClass = 'bg-emerald-500/30';
                                else if (intensity < 0.4) bgClass = 'bg-emerald-500/50';
                                else if (intensity < 0.6) bgClass = 'bg-amber-500/50';
                                else if (intensity < 0.8) bgClass = 'bg-orange-500/60';
                                else bgClass = 'bg-red-500/70';
                              } else {
                                // Mixed colors for "all"
                                if (intensity < 0.2) bgClass = 'bg-emerald-500/30';
                                else if (intensity < 0.4) bgClass = 'bg-emerald-500/50';
                                else if (intensity < 0.6) bgClass = 'bg-amber-500/50';
                                else if (intensity < 0.8) bgClass = 'bg-orange-500/60';
                                else bgClass = 'bg-red-500/70';
                              }
                            }
                            
                            return (
                              <Tooltip key={dayIdx}>
                                <TooltipTrigger asChild>
                                  <div
                                    className={cn(
                                      "w-3 h-3 rounded-sm cursor-pointer transition-all hover:ring-1 hover:ring-primary",
                                      bgClass
                                    )}
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                  <div className="text-xs space-y-1">
                                    <p className="font-medium">
                                      {format(day.date, 'EEEE, d. MMMM', { locale: de })}
                                    </p>
                                    {day.events > 0 ? (
                                      <div className="space-y-0.5">
                                        {day.groupCount > 0 && (
                                          <p className="flex items-center gap-1">
                                            <UsersRound className="h-3 w-3" />
                                            {day.groupCount} Gruppe{day.groupCount !== 1 ? 'n' : ''} · {day.groupGuests} Gäste
                                          </p>
                                        )}
                                        {day.emailCount > 0 && (
                                          <p className="flex items-center gap-1 text-cyan-600">
                                            <UserCheck className="h-3 w-3" />
                                            {day.emailCount} Gast-Res. · {day.emailGuests} Gäste
                                          </p>
                                        )}
                                        <p className="font-medium pt-0.5 border-t border-border/50">
                                          Total: {day.guests} Gäste
                                        </p>
                                      </div>
                                    ) : (
                                      <p className="text-muted-foreground">Keine Reservierungen</p>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </TooltipProvider>
            </div>
          </div>
          
          {/* Legend */}
          <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
            <span>Weniger</span>
            <div className="flex gap-[2px]">
              <div className="w-3 h-3 rounded-sm bg-muted/20" />
              <div className={cn(
                "w-3 h-3 rounded-sm",
                filterMode === 'guests' ? "bg-cyan-400/30" : "bg-emerald-500/30"
              )} />
              <div className={cn(
                "w-3 h-3 rounded-sm",
                filterMode === 'guests' ? "bg-cyan-500/50" : "bg-emerald-500/50"
              )} />
              <div className={cn(
                "w-3 h-3 rounded-sm",
                filterMode === 'guests' ? "bg-cyan-500/60" : "bg-amber-500/50"
              )} />
              <div className={cn(
                "w-3 h-3 rounded-sm",
                filterMode === 'guests' ? "bg-cyan-600/70" : "bg-orange-500/60"
              )} />
              <div className={cn(
                "w-3 h-3 rounded-sm",
                filterMode === 'guests' ? "bg-cyan-700/80" : "bg-red-500/70"
              )} />
            </div>
            <span>Mehr Gäste</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
