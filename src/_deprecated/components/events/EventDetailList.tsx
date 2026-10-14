import { useMemo, useState } from 'react';
import { format, parseISO, isWithinInterval, startOfDay, endOfDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/personnel-utils';
import { exportFilteredEventsExcel } from '@/lib/events-export';
import { toast } from 'sonner';
import {
  Users,
  Sun,
  Moon,
  Edit3,
  Trash2,
  FileText,
  Building,
  Wine,
  CheckCircle2,
  XCircle,
  ClipboardList,
  AlertCircle,
  CalendarDays,
  Filter,
  CircleDashed,
  Search,
  CalendarIcon,
  X,
  Download,
  FileSpreadsheet,
  Palette,
  UtensilsCrossed,
  GlassWater,
  ChefHat,
  Mail,
  Utensils,
  ClipboardCheck,
  ArrowDownToLine,
  PlusCircle
} from 'lucide-react';

// Helper function to calculate checklist progress
const getChecklistProgress = (reservation: {
  is_confirmed?: boolean;
  laufzettel_done?: boolean;
  dekoration_ready?: boolean;
  service_ready?: boolean;
  bar_ready?: boolean;
  kueche_ready?: boolean;
}) => {
  const items = [
    reservation.is_confirmed,
    reservation.laufzettel_done,
    reservation.dekoration_ready,
    reservation.service_ready,
    reservation.bar_ready,
    reservation.kueche_ready
  ];
  const completed = items.filter(Boolean).length;
  return { completed, total: 6, percentage: (completed / 6) * 100 };
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
  menu_pdf_url: string | null;
  location: string | null;
  exclude_walk_in: boolean;
  group_type?: 'laufzettel' | 'alacarte' | null;
  revenue_mode?: 'offset' | 'additional' | null;
  is_confirmed?: boolean;
  laufzettel_done?: boolean;
  dekoration_ready?: boolean;
  service_ready?: boolean;
  bar_ready?: boolean;
  kueche_ready?: boolean;
}

interface EventDetailListProps {
  reservations: GroupReservation[];
  onEdit: (reservation: GroupReservation) => void;
  onDelete: (id: string) => void;
  onToggleConfirmed: (id: string, value: boolean) => void;
  onToggleLaufzettel: (id: string, value: boolean) => void;
  onToggleDepartmentReady?: (id: string, field: 'dekoration_ready' | 'service_ready' | 'bar_ready' | 'kueche_ready', value: boolean) => void;
  onSendNotification?: (reservation: GroupReservation) => void;
  onToggleRevenueMode?: (id: string, value: 'offset' | 'additional') => void;
  isLoading?: boolean;
}

type FilterType = 'all' | 'unconfirmed' | 'no-laufzettel';

export const EventDetailList = ({
  reservations,
  onEdit,
  onDelete,
  onToggleConfirmed,
  onToggleLaufzettel,
  onToggleDepartmentReady,
  onSendNotification,
  onToggleRevenueMode,
  isLoading
}: EventDetailListProps) => {
  const [filter, setFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined
  });

  // Filter and sort reservations
  const filteredAndSortedReservations = useMemo(() => {
    let filtered = [...reservations];
    
    // Status filter
    if (filter === 'unconfirmed') {
      filtered = filtered.filter(r => !r.is_confirmed);
    } else if (filter === 'no-laufzettel') {
      filtered = filtered.filter(r => !r.laufzettel_done);
    }
    
    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(r => 
        (r.group_name?.toLowerCase().includes(query)) ||
        (r.notes?.toLowerCase().includes(query)) ||
        (r.location?.toLowerCase().includes(query))
      );
    }
    
    // Date range filter
    if (dateRange.from || dateRange.to) {
      filtered = filtered.filter(r => {
        const reservationDate = parseISO(r.date);
        if (dateRange.from && dateRange.to) {
          return isWithinInterval(reservationDate, {
            start: startOfDay(dateRange.from),
            end: endOfDay(dateRange.to)
          });
        } else if (dateRange.from) {
          return reservationDate >= startOfDay(dateRange.from);
        } else if (dateRange.to) {
          return reservationDate <= endOfDay(dateRange.to);
        }
        return true;
      });
    }
    
    return filtered.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.shift === 'mittag' ? -1 : 1;
    });
  }, [reservations, filter, searchQuery, dateRange]);

  const hasActiveFilters = searchQuery.trim() || dateRange.from || dateRange.to || filter !== 'all';

  const clearAllFilters = () => {
    setSearchQuery('');
    setDateRange({ from: undefined, to: undefined });
    setFilter('all');
  };

  // Export filtered events to Excel
  const handleExportExcel = async () => {
    if (filteredAndSortedReservations.length === 0) {
      toast.error('Keine Events zum Exportieren vorhanden');
      return;
    }

    try {
      const filterLabel = filter === 'unconfirmed' 
        ? 'Unbestätigt' 
        : filter === 'no-laufzettel' 
          ? 'Ohne Laufzettel' 
          : 'Alle';
      
      const dateLabel = dateRange.from || dateRange.to
        ? `${dateRange.from ? format(dateRange.from, 'dd.MM.yy') : 'Beginn'} - ${dateRange.to ? format(dateRange.to, 'dd.MM.yy') : 'Ende'}`
        : 'Alle Zeiträume';

      await exportFilteredEventsExcel({
        reservations: filteredAndSortedReservations,
        filterLabel,
        dateLabel,
        searchQuery: searchQuery.trim() || undefined
      });
      
      toast.success(`${filteredAndSortedReservations.length} Events exportiert`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Export fehlgeschlagen');
    }
  };

  // Summary stats
  const stats = useMemo(() => {
    const confirmed = reservations.filter(r => r.is_confirmed).length;
    const laufzettelDone = reservations.filter(r => r.laufzettel_done).length;
    const withNotes = reservations.filter(r => r.notes && r.notes.trim()).length;
    const unconfirmed = reservations.length - confirmed;
    const noLaufzettel = reservations.length - laufzettelDone;
    return { confirmed, laufzettelDone, withNotes, total: reservations.length, unconfirmed, noLaufzettel };
  }, [reservations]);

  if (isLoading) {
    return (
      <Card className="stat-card">
        <CardContent className="p-8 text-center text-muted-foreground">
          Lade Events...
        </CardContent>
      </Card>
    );
  }

  if (reservations.length === 0) {
    return (
      <Card className="stat-card">
        <CardContent className="p-8 text-center text-muted-foreground">
          <CalendarDays className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
          <p>Keine Events gefunden</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Event-Detailübersicht
              <Badge variant="secondary" className="ml-2">
                {filteredAndSortedReservations.length}
                {filter !== 'all' && `/${reservations.length}`}
              </Badge>
            </CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                {stats.confirmed}/{stats.total} bestätigt
              </span>
              <span className="flex items-center gap-1">
                <FileText className="h-3.5 w-3.5 text-blue-500" />
                {stats.laufzettelDone}/{stats.total} Laufzettel
              </span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 ml-2"
                      onClick={handleExportExcel}
                      disabled={filteredAndSortedReservations.length === 0}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Export</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Gefilterte Liste als Excel exportieren
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
          
          {/* Search and Date Filter Row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[200px] max-w-[300px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Suche nach Gruppe, Notizen..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-sm"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                  onClick={() => setSearchQuery('')}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Date Range Picker */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-9 text-xs gap-2",
                    (dateRange.from || dateRange.to) && "border-primary text-primary"
                  )}
                >
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateRange.from ? (
                    dateRange.to ? (
                      <>
                        {format(dateRange.from, 'dd.MM.yy')} - {format(dateRange.to, 'dd.MM.yy')}
                      </>
                    ) : (
                      <>Ab {format(dateRange.from, 'dd.MM.yy')}</>
                    )
                  ) : dateRange.to ? (
                    <>Bis {format(dateRange.to, 'dd.MM.yy')}</>
                  ) : (
                    'Zeitraum wählen'
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={{ from: dateRange.from, to: dateRange.to }}
                  onSelect={(range) => setDateRange({ from: range?.from, to: range?.to })}
                  numberOfMonths={2}
                  locale={de}
                  className="p-3 pointer-events-auto"
                />
                {(dateRange.from || dateRange.to) && (
                  <div className="p-2 border-t">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs"
                      onClick={() => setDateRange({ from: undefined, to: undefined })}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Zeitraum zurücksetzen
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {/* Clear All Filters */}
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-xs text-muted-foreground hover:text-foreground"
                onClick={clearAllFilters}
              >
                <X className="h-3 w-3 mr-1" />
                Filter zurücksetzen
              </Button>
            )}
          </div>
          
          {/* Status Filter Buttons */}
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <ToggleGroup 
              type="single" 
              value={filter} 
              onValueChange={(value) => value && setFilter(value as FilterType)}
              className="justify-start"
            >
              <ToggleGroupItem 
                value="all" 
                size="sm"
                className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                Alle
              </ToggleGroupItem>
              <ToggleGroupItem 
                value="unconfirmed" 
                size="sm"
                className={cn(
                  "text-xs gap-1",
                  filter === 'unconfirmed' 
                    ? "bg-amber-500 text-white hover:bg-amber-600" 
                    : "text-amber-600 border-amber-200 hover:bg-amber-50"
                )}
              >
                <CircleDashed className="h-3 w-3" />
                Unbestätigt
                {stats.unconfirmed > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] bg-amber-100 text-amber-700">
                    {stats.unconfirmed}
                  </Badge>
                )}
              </ToggleGroupItem>
              <ToggleGroupItem 
                value="no-laufzettel" 
                size="sm"
                className={cn(
                  "text-xs gap-1",
                  filter === 'no-laufzettel' 
                    ? "bg-blue-500 text-white hover:bg-blue-600" 
                    : "text-blue-600 border-blue-200 hover:bg-blue-50"
                )}
              >
                <AlertCircle className="h-3 w-3" />
                Ohne Laufzettel
                {stats.noLaufzettel > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] bg-blue-100 text-blue-700">
                    {stats.noLaufzettel}
                  </Badge>
                )}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[600px]">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-[180px]">Gruppe / Firma</TableHead>
                <TableHead className="w-[100px]">Datum</TableHead>
                <TableHead className="w-[100px] text-center">Fortschritt</TableHead>
                <TableHead className="w-[60px] text-center">Bestätigt</TableHead>
                <TableHead className="w-[60px] text-center">Laufzettel</TableHead>
                <TableHead className="w-[160px] text-center">Abteilungen</TableHead>
                <TableHead className="w-[150px]">Sonderwünsche</TableHead>
                <TableHead className="w-[80px] text-right">Aktionen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSortedReservations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                    {hasActiveFilters ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="h-8 w-8 text-muted-foreground/30" />
                        <p>Keine Events gefunden mit diesen Filtern</p>
                        <Button variant="link" size="sm" onClick={clearAllFilters}>
                          Filter zurücksetzen
                        </Button>
                      </div>
                    ) : (
                      'Keine Events gefunden'
                    )}
                  </TableCell>
                </TableRow>
              ) : filteredAndSortedReservations.map((reservation) => {
                const dateObj = parseISO(reservation.date);
                const hasNotes = reservation.notes && reservation.notes.trim();
                
                return (
                  <TableRow 
                    key={reservation.id}
                    className={cn(
                      "transition-colors",
                      reservation.is_confirmed 
                        ? "bg-emerald-500/10 hover:bg-emerald-500/15 border-l-4 border-l-emerald-500" 
                        : "bg-amber-500/5 hover:bg-amber-500/10 border-l-4 border-l-amber-400"
                    )}
                  >
                    {/* Group Name & Guest Count */}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "p-1.5 rounded-full shrink-0",
                          reservation.shift === 'mittag' ? "bg-amber-500/10" : "bg-indigo-500/10"
                        )}>
                          {reservation.shift === 'mittag' ? (
                            <Sun className="h-3.5 w-3.5 text-amber-500" />
                          ) : (
                            <Moon className="h-3.5 w-3.5 text-indigo-500" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {reservation.group_name || 'Gruppe'}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {reservation.guest_count} Pers.
                            </span>
                            <span className="flex items-center gap-0.5">
                              {reservation.location === 'U1 Bar' ? (
                                <Wine className="h-3 w-3" />
                              ) : (
                                <Building className="h-3 w-3" />
                              )}
                              {reservation.location === 'U1 Bar' ? 'Bar' : 'Rest.'}
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
                    </TableCell>

                    {/* Date */}
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">
                          {format(dateObj, 'dd.MM.yyyy')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {format(dateObj, 'EEEE', { locale: de })}
                        </p>
                      </div>
                    </TableCell>

                    {/* Progress Bar */}
                    <TableCell>
                      {(() => {
                        const progress = getChecklistProgress(reservation);
                        return (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="space-y-1 min-w-[80px]">
                                  <div className="text-xs font-medium text-center">
                                    <span className={cn(
                                      progress.percentage === 100 ? "text-emerald-500" : 
                                      progress.percentage >= 50 ? "text-amber-500" : "text-orange-500"
                                    )}>
                                      {progress.completed}/{progress.total}
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                    <div 
                                      className={cn(
                                        "h-full transition-all duration-300",
                                        getProgressColor(progress.percentage)
                                      )}
                                      style={{ width: `${progress.percentage}%` }}
                                    />
                                  </div>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <div className="text-xs space-y-1">
                                  <p className="font-medium">{progress.completed} von {progress.total} erledigt</p>
                                  <div className="space-y-0.5 text-muted-foreground">
                                    <p className={reservation.is_confirmed ? "text-emerald-400" : ""}>
                                      {reservation.is_confirmed ? "✓" : "○"} Bestätigt
                                    </p>
                                    <p className={reservation.laufzettel_done ? "text-blue-400" : ""}>
                                      {reservation.laufzettel_done ? "✓" : "○"} Laufzettel
                                    </p>
                                    <p className={reservation.dekoration_ready ? "text-pink-400" : ""}>
                                      {reservation.dekoration_ready ? "✓" : "○"} Dekoration
                                    </p>
                                    <p className={reservation.service_ready ? "text-cyan-400" : ""}>
                                      {reservation.service_ready ? "✓" : "○"} Service
                                    </p>
                                    <p className={reservation.bar_ready ? "text-purple-400" : ""}>
                                      {reservation.bar_ready ? "✓" : "○"} Bar
                                    </p>
                                    <p className={reservation.kueche_ready ? "text-orange-400" : ""}>
                                      {reservation.kueche_ready ? "✓" : "○"} Küche
                                    </p>
                                  </div>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        );
                      })()}
                    </TableCell>

                    {/* Confirmed Status */}
                    <TableCell className="text-center">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex justify-center">
                              <Checkbox
                                checked={reservation.is_confirmed || false}
                                onCheckedChange={(checked) => 
                                  onToggleConfirmed(reservation.id, checked === true)
                                }
                                className={cn(
                                  "h-5 w-5",
                                  reservation.is_confirmed 
                                    ? "border-emerald-500 data-[state=checked]:bg-emerald-500" 
                                    : "border-amber-500"
                                )}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {reservation.is_confirmed ? 'Bestätigt' : 'Noch nicht bestätigt'}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>

                    {/* Laufzettel Status */}
                    <TableCell className="text-center">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex justify-center">
                              <Checkbox
                                checked={reservation.laufzettel_done || false}
                                onCheckedChange={(checked) => 
                                  onToggleLaufzettel(reservation.id, checked === true)
                                }
                                className={cn(
                                  "h-5 w-5",
                                  reservation.laufzettel_done 
                                    ? "border-blue-500 data-[state=checked]:bg-blue-500" 
                                    : "border-muted-foreground"
                                )}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {reservation.laufzettel_done ? 'Laufzettel erstellt' : 'Laufzettel ausstehend'}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>

                    {/* Department Checklists */}
                    <TableCell>
                      {onToggleDepartmentReady ? (
                        <div className="flex items-center justify-center gap-1">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div 
                                  className="p-1 cursor-pointer rounded hover:bg-muted/50"
                                  onClick={() => onToggleDepartmentReady(reservation.id, 'dekoration_ready', !reservation.dekoration_ready)}
                                >
                                  <Palette className={cn(
                                    "h-4 w-4 transition-colors",
                                    reservation.dekoration_ready ? "text-pink-500" : "text-muted-foreground/30"
                                  )} />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                Dekoration {reservation.dekoration_ready ? '✓' : 'ausstehend'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div 
                                  className="p-1 cursor-pointer rounded hover:bg-muted/50"
                                  onClick={() => onToggleDepartmentReady(reservation.id, 'service_ready', !reservation.service_ready)}
                                >
                                  <UtensilsCrossed className={cn(
                                    "h-4 w-4 transition-colors",
                                    reservation.service_ready ? "text-cyan-500" : "text-muted-foreground/30"
                                  )} />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                Service {reservation.service_ready ? '✓' : 'ausstehend'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div 
                                  className="p-1 cursor-pointer rounded hover:bg-muted/50"
                                  onClick={() => onToggleDepartmentReady(reservation.id, 'bar_ready', !reservation.bar_ready)}
                                >
                                  <GlassWater className={cn(
                                    "h-4 w-4 transition-colors",
                                    reservation.bar_ready ? "text-purple-500" : "text-muted-foreground/30"
                                  )} />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                Bar {reservation.bar_ready ? '✓' : 'ausstehend'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div 
                                  className="p-1 cursor-pointer rounded hover:bg-muted/50"
                                  onClick={() => onToggleDepartmentReady(reservation.id, 'kueche_ready', !reservation.kueche_ready)}
                                >
                                  <ChefHat className={cn(
                                    "h-4 w-4 transition-colors",
                                    reservation.kueche_ready ? "text-orange-500" : "text-muted-foreground/30"
                                  )} />
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                Küche {reservation.kueche_ready ? '✓' : 'ausstehend'}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </TableCell>

                    {/* Notes / Special Requests */}
                    <TableCell>
                      {hasNotes ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-sm text-muted-foreground truncate max-w-[140px] cursor-help">
                                {reservation.notes}
                              </p>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="whitespace-pre-wrap">{reservation.notes}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {reservation.menu_pdf_url && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <a
                                  href={reservation.menu_pdf_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 hover:bg-muted rounded"
                                >
                                  <FileText className="h-4 w-4 text-muted-foreground" />
                                </a>
                              </TooltipTrigger>
                              <TooltipContent>PDF öffnen</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {onSendNotification && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  onClick={() => onSendNotification(reservation)}
                                >
                                  <Mail className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Abteilungen benachrichtigen</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => onEdit(reservation)}
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => onDelete(reservation.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
