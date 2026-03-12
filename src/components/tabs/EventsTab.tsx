import { useState, useEffect, useMemo } from 'react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, eachDayOfInterval, eachWeekOfInterval, eachMonthOfInterval, parseISO, isSameDay, isSameWeek, isSameMonth, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { EventCalendar } from '@/components/events/EventCalendar';
import { WeekTimelineView } from '@/components/events/WeekTimelineView';
import { YearHeatmap } from '@/components/events/YearHeatmap';
import { EventNotificationSettings } from '@/components/events/EventNotificationSettings';
import { DepartmentEmailSettings } from '@/components/events/DepartmentEmailSettings';
import { EventDetailList } from '@/components/events/EventDetailList';
import { EmailImportNotifications } from '@/components/events/EmailImportNotifications';
import { ManualEmailTestDialog } from '@/components/events/ManualEmailTestDialog';
import { ImapEmailSettings } from '@/components/events/ImapEmailSettings';
import { ExternalApiSettings } from '@/components/events/ExternalApiSettings';
import { FileImportReservations } from '@/components/events/FileImportReservations';
import { ForatableSyncSettings } from '@/components/events/ForatableSyncSettings';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatCurrency } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { DailyBudget } from '@/types/personnel';
import { toast } from 'sonner';
import {
  Users,
  Calendar,
  Sun,
  Moon,
  TrendingUp,
  CalendarDays,
  CalendarRange,
  Euro,
  UserPlus,
  Edit3,
  Trash2,
  FileText,
  Building,
  Wine,
  Plus,
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  PartyPopper,
  List,
  LayoutGrid,
  Download,
  FileSpreadsheet,
  ClipboardList,
  PlusCircle,
  ArrowDownToLine,
  ArrowRightCircle,
  CheckCircle2,
  Undo2,
  Import,
  Settings2
} from 'lucide-react';
import { exportEventsPDF, exportEventsExcel } from '@/lib/events-export';
import { Utensils, ClipboardCheck } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

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
  applied_to_budget?: boolean;
  // GF (Geschäftsführer) workflow fields
  gf_accepted?: boolean;
  gf_accepted_at?: string | null;
  gf_final_confirmed?: boolean;
  gf_final_confirmed_at?: string | null;
}

interface EventsTabProps {
  selectedDate: Date;
  onApplyToPlannedRevenue?: (date: string, revenue: number) => void;
  dailyBudgets?: Record<string, DailyBudget>;
}

type ViewMode = 'day' | 'week' | 'month' | 'year';
type DisplayMode = 'calendar' | 'detail' | 'list' | 'year';
type ReservationType = 'group' | 'walkin';
type GroupType = 'alacarte' | 'laufzettel';
type RevenueMode = 'offset' | 'additional';

export const EventsTab = ({ selectedDate, onApplyToPlannedRevenue, dailyBudgets }: EventsTabProps) => {
  const [reservations, setReservations] = useState<GroupReservation[]>([]);
  const [yearReservations, setYearReservations] = useState<GroupReservation[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [displayMode, setDisplayMode] = useState<DisplayMode>('calendar');
  const [calendarViewMode, setCalendarViewMode] = useState<'month' | 'week'>('month');
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingReservation, setEditingReservation] = useState<GroupReservation | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const [calendarSelectedDate, setCalendarSelectedDate] = useState(selectedDate);
  const [isImportSectionOpen, setIsImportSectionOpen] = useState(false);

  // Reservation type selection
  const [reservationType, setReservationType] = useState<ReservationType>('group');
  const [groupType, setGroupType] = useState<GroupType>('laufzettel');
  const [revenueMode, setRevenueMode] = useState<RevenueMode>('offset');

  // New reservation form - exclude_walk_in defaults to true for group reservations
  const [newReservation, setNewReservation] = useState({
    date: format(selectedDate, 'yyyy-MM-dd'),
    group_name: '',
    guest_count: 10,
    revenue_per_person: 35,
    shift: 'abend' as 'mittag' | 'abend',
    notes: '',
    location: 'EG Restaurant',
    exclude_walk_in: true  // Default: no walk-in for group reservations
  });

  // Calculate date range based on view mode
  const dateRange = useMemo(() => {
    switch (viewMode) {
      case 'week':
        return {
          start: startOfWeek(selectedDate, { weekStartsOn: 1 }),
          end: endOfWeek(selectedDate, { weekStartsOn: 1 })
        };
      case 'month':
        return {
          start: startOfMonth(selectedDate),
          end: endOfMonth(selectedDate)
        };
      case 'year':
        return {
          start: startOfYear(selectedDate),
          end: endOfYear(selectedDate)
        };
      default:
        return {
          start: selectedDate,
          end: selectedDate
        };
    }
  }, [selectedDate, viewMode]);

  // Fetch data based on date range
  useEffect(() => {
    fetchData();
  }, [dateRange.start, dateRange.end]);

  // Fetch year data for heatmap
  useEffect(() => {
    fetchYearData();
  }, [selectedDate]);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const startStr = format(dateRange.start, 'yyyy-MM-dd');
      const endStr = format(dateRange.end, 'yyyy-MM-dd');

      const { data, error } = await supabase
        .from('group_reservations')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date')
        .order('shift');

      if (error) throw error;

      if (data) {
        setReservations(data.map(r => ({
          ...r,
          shift: r.shift as 'mittag' | 'abend',
          location: r.location || 'EG Restaurant',
          exclude_walk_in: r.exclude_walk_in || false,
          group_type: (r as any).group_type as 'laufzettel' | 'alacarte' | null,
          revenue_mode: (r as any).revenue_mode as 'offset' | 'additional' | null,
          is_confirmed: (r as any).is_confirmed || false,
          laufzettel_done: (r as any).laufzettel_done || false,
          dekoration_ready: (r as any).dekoration_ready || false,
          service_ready: (r as any).service_ready || false,
          bar_ready: (r as any).bar_ready || false,
          kueche_ready: (r as any).kueche_ready || false,
          applied_to_budget: (r as any).applied_to_budget || false,
          gf_accepted: (r as any).gf_accepted || false,
          gf_accepted_at: (r as any).gf_accepted_at || null,
          gf_final_confirmed: (r as any).gf_final_confirmed || false,
          gf_final_confirmed_at: (r as any).gf_final_confirmed_at || null
        })));
      }
    } catch (error) {
      console.error('Error fetching reservations:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchYearData = async () => {
    try {
      const yearStart = format(startOfYear(selectedDate), 'yyyy-MM-dd');
      const yearEnd = format(endOfYear(selectedDate), 'yyyy-MM-dd');

      const { data, error } = await supabase
        .from('group_reservations')
        .select('*')
        .gte('date', yearStart)
        .lte('date', yearEnd)
        .order('date')
        .order('shift');

      if (error) throw error;

      if (data) {
        setYearReservations(data.map(r => ({
          ...r,
          shift: r.shift as 'mittag' | 'abend',
          location: r.location || 'EG Restaurant',
          exclude_walk_in: r.exclude_walk_in || false,
          group_type: (r as any).group_type as 'laufzettel' | 'alacarte' | null,
          revenue_mode: (r as any).revenue_mode as 'offset' | 'additional' | null,
          is_confirmed: (r as any).is_confirmed || false,
          laufzettel_done: (r as any).laufzettel_done || false,
          dekoration_ready: (r as any).dekoration_ready || false,
          service_ready: (r as any).service_ready || false,
          bar_ready: (r as any).bar_ready || false,
          kueche_ready: (r as any).kueche_ready || false,
          applied_to_budget: (r as any).applied_to_budget || false,
          gf_accepted: (r as any).gf_accepted || false,
          gf_accepted_at: (r as any).gf_accepted_at || null,
          gf_final_confirmed: (r as any).gf_final_confirmed || false,
          gf_final_confirmed_at: (r as any).gf_final_confirmed_at || null
        })));
      }
    } catch (error) {
      console.error('Error fetching year reservations:', error);
    }
  };

  // Filter reservations by search query
  const filteredReservations = useMemo(() => {
    if (!searchQuery.trim()) return reservations;
    const query = searchQuery.toLowerCase();
    return reservations.filter(r =>
      r.group_name?.toLowerCase().includes(query) ||
      r.notes?.toLowerCase().includes(query) ||
      r.location?.toLowerCase().includes(query)
    );
  }, [reservations, searchQuery]);

  // Group reservations by date
  const groupedByDate = useMemo(() => {
    const groups: Record<string, GroupReservation[]> = {};
    filteredReservations.forEach(r => {
      if (!groups[r.date]) groups[r.date] = [];
      groups[r.date].push(r);
    });
    return groups;
  }, [filteredReservations]);

  // Summary statistics
  const summaryStats = useMemo(() => {
    const totalReservations = filteredReservations.length;
    const totalGuests = filteredReservations.reduce((sum, r) => sum + r.guest_count, 0);
    const totalRevenue = filteredReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
    const mittagReservations = filteredReservations.filter(r => r.shift === 'mittag');
    const abendReservations = filteredReservations.filter(r => r.shift === 'abend');
    
    return {
      totalReservations,
      totalGuests,
      totalRevenue,
      mittagCount: mittagReservations.length,
      mittagGuests: mittagReservations.reduce((sum, r) => sum + r.guest_count, 0),
      abendCount: abendReservations.length,
      abendGuests: abendReservations.reduce((sum, r) => sum + r.guest_count, 0),
      uniqueDates: Object.keys(groupedByDate).length,
      avgGuestsPerEvent: totalReservations > 0 ? Math.round(totalGuests / totalReservations) : 0
    };
  }, [filteredReservations, groupedByDate]);

  // Send department notifications for new event
  const sendDepartmentNotifications = async (eventId: string, eventData: {
    date: string;
    shift: string;
    group_name: string | null;
    guest_count: number;
    location: string | null;
    notes: string | null;
    revenue_per_person: number;
  }) => {
    try {
      const response = await supabase.functions.invoke('send-department-notification', {
        body: { eventId, eventData },
      });

      if (response.error) {
        console.error('Error sending department notifications:', response.error);
        return;
      }

      const result = response.data;
      if (result.emailsSent > 0) {
        toast.success(`${result.emailsSent} Abteilungs-Benachrichtigung(en) gesendet`);
      }
    } catch (error) {
      console.error('Error sending department notifications:', error);
    }
  };

  // Add new reservation
  const handleAddReservation = async () => {
    try {
      // Determine if this is a walk-in type (no walk-in calculation for groups)
      const isWalkIn = reservationType === 'walkin';
      const isLaufzettel = reservationType === 'group' && groupType === 'laufzettel';
      
      const { data, error } = await supabase
        .from('group_reservations')
        .insert({
          date: newReservation.date,
          shift: newReservation.shift,
          group_name: isWalkIn ? null : (newReservation.group_name || null),
          guest_count: newReservation.guest_count,
          revenue_per_person: newReservation.revenue_per_person,
          notes: newReservation.notes || null,
          location: newReservation.location,
          exclude_walk_in: !isWalkIn, // Walk-ins get walk-in calculation, groups don't
          group_type: isWalkIn ? null : groupType,
          laufzettel_done: false,
          revenue_mode: isWalkIn ? 'offset' : revenueMode // Guests always offset, groups can choose
        } as any)
        .select()
        .single();

      if (error) throw error;

      toast.success('Event hinzugefügt');
      setIsAddDialogOpen(false);
      resetForm();
      fetchData();

      // Send department notifications asynchronously
      if (data) {
        sendDepartmentNotifications(data.id, {
          date: newReservation.date,
          shift: newReservation.shift,
          group_name: newReservation.group_name || null,
          guest_count: newReservation.guest_count,
          location: newReservation.location,
          notes: newReservation.notes || null,
          revenue_per_person: newReservation.revenue_per_person,
        });
      }
    } catch (error) {
      console.error('Error adding reservation:', error);
      toast.error('Fehler beim Hinzufügen');
    }
  };

  // Update reservation
  const handleUpdateReservation = async () => {
    if (!editingReservation) return;
    
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({
          date: newReservation.date,
          shift: newReservation.shift,
          group_name: newReservation.group_name || null,
          guest_count: newReservation.guest_count,
          revenue_per_person: newReservation.revenue_per_person,
          notes: newReservation.notes || null,
          location: newReservation.location,
          exclude_walk_in: newReservation.exclude_walk_in
        })
        .eq('id', editingReservation.id);

      if (error) throw error;

      toast.success('Event aktualisiert');
      setEditingReservation(null);
      resetForm();
      fetchData();
    } catch (error) {
      console.error('Error updating reservation:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  // Delete reservation
  const handleDeleteReservation = async (id: string) => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .delete()
        .eq('id', id);

      if (error) throw error;
      toast.success('Event gelöscht');
      fetchData();
    } catch (error) {
      console.error('Error deleting reservation:', error);
      toast.error('Fehler beim Löschen');
    }
  };

  // Toggle confirmed status
  const handleToggleConfirmed = async (id: string, value: boolean) => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({ is_confirmed: value } as any)
        .eq('id', id);

      if (error) throw error;
      
      setReservations(prev => prev.map(r => 
        r.id === id ? { ...r, is_confirmed: value } : r
      ));
      toast.success(value ? 'Event bestätigt' : 'Bestätigung aufgehoben');
    } catch (error) {
      console.error('Error updating confirmation:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  // Toggle laufzettel status
  const handleToggleLaufzettel = async (id: string, value: boolean) => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({ laufzettel_done: value } as any)
        .eq('id', id);

      if (error) throw error;
      
      setReservations(prev => prev.map(r => 
        r.id === id ? { ...r, laufzettel_done: value } : r
      ));
      toast.success(value ? 'Laufzettel als erledigt markiert' : 'Laufzettel-Status zurückgesetzt');
    } catch (error) {
      console.error('Error updating laufzettel:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  // Toggle department ready status
  const handleToggleDepartmentReady = async (id: string, field: 'dekoration_ready' | 'service_ready' | 'bar_ready' | 'kueche_ready', value: boolean) => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({ [field]: value } as any)
        .eq('id', id);

      if (error) throw error;
      
      setReservations(prev => prev.map(r => 
        r.id === id ? { ...r, [field]: value } : r
      ));
      
      const labels: Record<string, string> = {
        dekoration_ready: 'Dekoration',
        service_ready: 'Service',
        bar_ready: 'Bar',
        kueche_ready: 'Küche'
      };
      toast.success(value ? `${labels[field]} bestätigt` : `${labels[field]}-Status zurückgesetzt`);
    } catch (error) {
      console.error('Error updating department status:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  // Toggle revenue mode (offset vs additional)
  const handleToggleRevenueMode = async (id: string, value: 'offset' | 'additional') => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({ revenue_mode: value } as any)
        .eq('id', id);

      if (error) throw error;
      
      setReservations(prev => prev.map(r => 
        r.id === id ? { ...r, revenue_mode: value } : r
      ));
      toast.success(value === 'additional' ? 'Auf "Direkt zusätzlich" geändert' : 'Auf "Vom Budget" geändert');
    } catch (error) {
      console.error('Error updating revenue mode:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  // Batch apply to budget - transfer all pending confirmed groups at once
  const handleBatchApplyToBudget = async (reservationIds: string[], date: string, totalRevenue: number) => {
    if (!onApplyToPlannedRevenue) return;
    
    try {
      // Update budget
      const currentPlanned = dailyBudgets?.[date]?.plannedRevenue || 0;
      const newPlanned = currentPlanned + totalRevenue;
      onApplyToPlannedRevenue(date, newPlanned);
      
      // Mark all as applied in database
      const { error } = await supabase
        .from('group_reservations')
        .update({ applied_to_budget: true } as any)
        .in('id', reservationIds);
      
      if (error) throw error;
      
      // Update local state
      setReservations(prev => prev.map(r => 
        reservationIds.includes(r.id) ? { ...r, applied_to_budget: true } : r
      ));
      
      toast.success(`${reservationIds.length} Gruppen (${formatCurrency(totalRevenue)}) zum Plan-Umsatz für ${format(parseISO(date), 'd.M.', { locale: de })} hinzugefügt`);
    } catch (error) {
      console.error('Error batch applying to budget:', error);
      toast.error('Fehler beim Übertragen');
    }
  };

  // Inline update for calendar popup
  const handleInlineUpdateReservation = async (reservation: GroupReservation): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('group_reservations')
        .update({
          date: reservation.date,
          shift: reservation.shift,
          group_name: reservation.group_name,
          guest_count: reservation.guest_count,
          revenue_per_person: reservation.revenue_per_person,
          notes: reservation.notes,
          location: reservation.location,
          exclude_walk_in: reservation.exclude_walk_in
        })
        .eq('id', reservation.id);

      if (error) throw error;

      // Update local state immediately
      setReservations(prev => prev.map(r => 
        r.id === reservation.id ? reservation : r
      ));
      
      toast.success('Event aktualisiert');
      return true;
    } catch (error) {
      console.error('Error updating reservation:', error);
      toast.error('Fehler beim Aktualisieren');
      return false;
    }
  };

  // Handle converting email import to group reservation
  const handleConvertEmailToGroup = async (emailReservation: {
    id: string;
    guest_name: string;
    guest_email: string | null;
    guest_phone: string | null;
    date: string;
    time: string;
    guest_count: number;
    comment: string | null;
    location: string | null;
  }) => {
    // Determine shift from time
    const hours = parseInt(emailReservation.time.split(':')[0], 10);
    const shift = hours < 15 ? 'mittag' : 'abend';

    // Pre-fill the form with email data
    setReservationType('group');
    setGroupType('laufzettel');
    setRevenueMode('offset');
    setNewReservation({
      date: emailReservation.date,
      group_name: emailReservation.guest_name,
      guest_count: emailReservation.guest_count,
      revenue_per_person: 35,
      shift: shift as 'mittag' | 'abend',
      notes: [
        emailReservation.comment,
        emailReservation.guest_email ? `E-Mail: ${emailReservation.guest_email}` : null,
        emailReservation.guest_phone ? `Tel: ${emailReservation.guest_phone}` : null
      ].filter(Boolean).join('\n'),
      location: emailReservation.location || 'EG Restaurant',
      exclude_walk_in: true
    });
    setIsAddDialogOpen(true);

    // Mark as processed in background
    try {
      await supabase
        .from('email_imported_reservations')
        .update({ is_processed: true })
        .eq('id', emailReservation.id);
    } catch (error) {
      console.error('Error marking email as processed:', error);
    }
  };

  const resetForm = () => {
    setReservationType('group');
    setGroupType('laufzettel');
    setRevenueMode('offset');
    setNewReservation({
      date: format(selectedDate, 'yyyy-MM-dd'),
      group_name: '',
      guest_count: 10,
      revenue_per_person: 35,
      shift: 'abend',
      notes: '',
      location: 'EG Restaurant',
      exclude_walk_in: true  // Default: no walk-in for group reservations
    });
  };

  // Export handlers
  const getExportData = () => {
    const dataToExport = displayMode === 'year' ? yearReservations : reservations;
    const periodType = displayMode === 'year' ? 'year' : viewMode;
    
    return {
      reservations: dataToExport,
      periodLabel: getPeriodLabel(),
      periodType: periodType as 'day' | 'week' | 'month' | 'year',
      startDate: dateRange.start,
      endDate: dateRange.end,
    };
  };

  const handleExportPDF = () => {
    const exportData = getExportData();
    exportEventsPDF(exportData);
    toast.success('PDF Export erstellt');
  };

  const handleExportExcel = async () => {
    const exportData = getExportData();
    await exportEventsExcel(exportData);
    toast.success('Excel Export erstellt');
  };

  const openEditDialog = (reservation: GroupReservation) => {
    setEditingReservation(reservation);
    setNewReservation({
      date: reservation.date,
      group_name: reservation.group_name || '',
      guest_count: reservation.guest_count,
      revenue_per_person: reservation.revenue_per_person,
      shift: reservation.shift,
      notes: reservation.notes || '',
      location: reservation.location || 'EG Restaurant',
      exclude_walk_in: reservation.exclude_walk_in || false
    });
  };

  const toggleDateExpanded = (date: string) => {
    const newExpanded = new Set(expandedDates);
    if (newExpanded.has(date)) {
      newExpanded.delete(date);
    } else {
      newExpanded.add(date);
    }
    setExpandedDates(newExpanded);
  };

  // Get period label based on view mode
  const getPeriodLabel = () => {
    switch (viewMode) {
      case 'day':
        return format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de });
      case 'week':
        return `KW ${getISOWeek(selectedDate)} - ${format(dateRange.start, 'd.', { locale: de })} - ${format(dateRange.end, 'd. MMMM yyyy', { locale: de })}`;
      case 'month':
        return format(selectedDate, 'MMMM yyyy', { locale: de });
      case 'year':
        return format(selectedDate, 'yyyy');
      default:
        return '';
    }
  };

  // Reservation form dialog content
  const ReservationFormContent = () => (
    <div className="space-y-4 py-4">
      {/* Reservation Type Selection - only show when adding new */}
      {!editingReservation && (
        <div className="space-y-3">
          <Label>Reservationstyp</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setReservationType('group');
                setNewReservation(prev => ({ ...prev, exclude_walk_in: true }));
              }}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                reservationType === 'group'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <Users className="h-6 w-6" />
              <span className="font-medium">Gruppe</span>
              <span className="text-xs text-muted-foreground text-center">Geschlossene Gesellschaft</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setReservationType('walkin');
                setNewReservation(prev => ({ ...prev, exclude_walk_in: false, group_name: '' }));
              }}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all",
                reservationType === 'walkin'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <UserPlus className="h-6 w-6" />
              <span className="font-medium">Normale Gäste</span>
              <span className="text-xs text-muted-foreground text-center">Mit +20% Walk-In</span>
            </button>
          </div>
        </div>
      )}

      {/* Group Type Selection - only for groups */}
      {reservationType === 'group' && !editingReservation && (
        <div className="space-y-3">
          <Label>Art der Gruppenreservation</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setGroupType('laufzettel')}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                groupType === 'laufzettel'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <ClipboardCheck className="h-5 w-5" />
              <span className="font-medium text-sm">Laufzettel</span>
              <span className="text-[10px] text-muted-foreground text-center">Vorbestelltes Menü</span>
            </button>
            <button
              type="button"
              onClick={() => setGroupType('alacarte')}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                groupType === 'alacarte'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <Utensils className="h-5 w-5" />
              <span className="font-medium text-sm">À la carte</span>
              <span className="text-[10px] text-muted-foreground text-center">Freie Bestellung</span>
            </button>
          </div>
        </div>
      )}

      {/* Revenue Mode Selection - only for groups */}
      {reservationType === 'group' && !editingReservation && (
        <div className="space-y-3">
          <Label>Umsatz-Berechnung</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRevenueMode('offset')}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                revenueMode === 'offset'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <ArrowDownToLine className="h-5 w-5" />
              <span className="font-medium text-sm">Vom Budget</span>
              <span className="text-[10px] text-muted-foreground text-center">Erst abziehen, dann zusätzlich</span>
            </button>
            <button
              type="button"
              onClick={() => setRevenueMode('additional')}
              className={cn(
                "flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all",
                revenueMode === 'additional'
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-muted-foreground/50"
              )}
            >
              <PlusCircle className="h-5 w-5" />
              <span className="font-medium text-sm">Direkt zusätzlich</span>
              <span className="text-[10px] text-muted-foreground text-center">Sofort zum Umsatz</span>
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Datum</Label>
          <Input
            type="date"
            value={newReservation.date}
            onChange={(e) => setNewReservation({ ...newReservation, date: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Schicht</Label>
          <Select
            value={newReservation.shift}
            onValueChange={(value: 'mittag' | 'abend') => setNewReservation({ ...newReservation, shift: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mittag">
                <div className="flex items-center gap-2">
                  <Sun className="h-4 w-4 text-amber-500" />
                  Mittag
                </div>
              </SelectItem>
              <SelectItem value="abend">
                <div className="flex items-center gap-2">
                  <Moon className="h-4 w-4 text-indigo-500" />
                  Abend
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Group name - only for groups */}
      {reservationType === 'group' && (
        <div className="space-y-2">
          <Label>Gruppenname</Label>
          <Input
            placeholder="z.B. Firma XY Weihnachtsessen"
            value={newReservation.group_name}
            onChange={(e) => setNewReservation({ ...newReservation, group_name: e.target.value })}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label>Standort</Label>
        <Select
          value={newReservation.location}
          onValueChange={(value) => setNewReservation({ ...newReservation, location: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="EG Restaurant">
              <div className="flex items-center gap-2">
                <Building className="h-4 w-4" />
                EG Restaurant
              </div>
            </SelectItem>
            <SelectItem value="U1 Bar">
              <div className="flex items-center gap-2">
                <Wine className="h-4 w-4" />
                U1 Bar
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Anzahl Gäste</Label>
          <Input
            type="number"
            min="1"
            value={newReservation.guest_count}
            onChange={(e) => setNewReservation({ ...newReservation, guest_count: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div className="space-y-2">
          <Label>Umsatz/Person (CHF)</Label>
          <Input
            type="number"
            min="0"
            step="5"
            value={newReservation.revenue_per_person}
            onChange={(e) => setNewReservation({ ...newReservation, revenue_per_person: parseFloat(e.target.value) || 0 })}
          />
        </div>
      </div>

      {/* Type indicator badge */}
      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
        {reservationType === 'group' ? (
          <>
            <Badge variant="secondary" className="gap-1">
              <Users className="h-3 w-3" />
              Gruppe
            </Badge>
            <Badge variant="outline" className="gap-1">
              {groupType === 'laufzettel' ? (
                <>
                  <ClipboardCheck className="h-3 w-3" />
                  Laufzettel
                </>
              ) : (
                <>
                  <Utensils className="h-3 w-3" />
                  À la carte
                </>
              )}
            </Badge>
            <span className="text-xs text-muted-foreground ml-auto">Ohne Walk-In-Berechnung</span>
          </>
        ) : (
          <>
            <Badge className="gap-1 bg-green-500">
              <UserPlus className="h-3 w-3" />
              Normale Gäste
            </Badge>
            <span className="text-xs text-muted-foreground ml-auto">Mit +20% Walk-In-Potenzial</span>
          </>
        )}
      </div>

      <div className="space-y-2">
        <Label>Notizen</Label>
        <Textarea
          placeholder={reservationType === 'group' && groupType === 'laufzettel' 
            ? "z.B. Menü-Details, spezielle Wünsche, Allergien..."
            : "z.B. spezielle Wünsche, Anlass..."
          }
          value={newReservation.notes}
          onChange={(e) => setNewReservation({ ...newReservation, notes: e.target.value })}
          rows={3}
        />
      </div>

      <div className="p-3 bg-primary/5 rounded-lg border border-primary/20">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Geschätzter Umsatz:</span>
          <span className="font-bold text-primary">
            {formatCurrency(newReservation.guest_count * newReservation.revenue_per_person)}
          </span>
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button
          onClick={editingReservation ? handleUpdateReservation : handleAddReservation}
          className="flex-1"
        >
          {editingReservation ? 'Aktualisieren' : 'Hinzufügen'}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setIsAddDialogOpen(false);
            setEditingReservation(null);
            resetForm();
          }}
        >
          Abbrechen
        </Button>
      </div>
    </div>
  );

  return (
    <TooltipProvider>
    <div className="space-y-6">
      {/* Email Import Notifications */}
      <EmailImportNotifications 
        onConvertToGroup={handleConvertEmailToGroup}
        onRefresh={fetchData}
      />

      {/* Header with view mode and add button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <PartyPopper className="h-6 w-6 text-primary" />
          <div>
            <h2 className="text-xl font-bold">Events & Gruppenreservationen</h2>
            <p className="text-sm text-muted-foreground">{getPeriodLabel()}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Display Mode Toggle */}
          <ToggleGroup type="single" value={displayMode} onValueChange={(v) => v && setDisplayMode(v as DisplayMode)} size="sm">
            <ToggleGroupItem value="calendar" className="text-xs px-3">
              <LayoutGrid className="h-3.5 w-3.5 mr-1" />
              Kalender
            </ToggleGroupItem>
            <ToggleGroupItem value="detail" className="text-xs px-3">
              <ClipboardList className="h-3.5 w-3.5 mr-1" />
              Details
            </ToggleGroupItem>
            <ToggleGroupItem value="year" className="text-xs px-3">
              <TrendingUp className="h-3.5 w-3.5 mr-1" />
              Jahr
            </ToggleGroupItem>
            <ToggleGroupItem value="list" className="text-xs px-3">
              <List className="h-3.5 w-3.5 mr-1" />
              Liste
            </ToggleGroupItem>
          </ToggleGroup>

          {displayMode === 'list' && (
            <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v as ViewMode)} size="sm">
              <ToggleGroupItem value="day" className="text-xs px-3">
                <CalendarDays className="h-3.5 w-3.5 mr-1" />
                Tag
              </ToggleGroupItem>
              <ToggleGroupItem value="week" className="text-xs px-3">
                <CalendarRange className="h-3.5 w-3.5 mr-1" />
                Woche
              </ToggleGroupItem>
              <ToggleGroupItem value="month" className="text-xs px-3">
                <Calendar className="h-3.5 w-3.5 mr-1" />
                Monat
              </ToggleGroupItem>
              <ToggleGroupItem value="year" className="text-xs px-3">
                <TrendingUp className="h-3.5 w-3.5 mr-1" />
                Jahr
              </ToggleGroupItem>
            </ToggleGroup>
          )}

          {/* Manual Email Test Dialog */}
          <ManualEmailTestDialog />

          {/* Export Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1">
                <Download className="h-4 w-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExportPDF()}>
                <FileText className="h-4 w-4 mr-2" />
                PDF Export
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExportExcel()}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Excel Export
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1">
                <Plus className="h-4 w-4" />
                Reservation
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingReservation 
                    ? 'Reservation bearbeiten' 
                    : 'Neue Reservation hinzufügen'
                  }
                </DialogTitle>
              </DialogHeader>
              <ReservationFormContent />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Calendar View */}
      {displayMode === 'calendar' && (
        <EventCalendar
          reservations={reservations}
          selectedDate={calendarSelectedDate}
          onDateSelect={(date) => {
            setCalendarSelectedDate(date);
            // Expand the selected date in the list
            const dateStr = format(date, 'yyyy-MM-dd');
            setExpandedDates(new Set([dateStr]));
          }}
          onMonthChange={(date) => {
            // Update date range for fetching
            setViewMode('month');
          }}
          onAddEvent={(dateStr) => {
            setNewReservation(prev => ({ ...prev, date: dateStr }));
            setIsAddDialogOpen(true);
          }}
          onEditEvent={(reservation) => {
            // Cast to local type since calendar uses optional menu_pdf_url
            setEditingReservation({
              ...reservation,
              menu_pdf_url: reservation.menu_pdf_url ?? null
            } as GroupReservation);
          }}
          onUpdateEvent={handleInlineUpdateReservation}
          onToggleConfirmed={handleToggleConfirmed}
          onToggleLaufzettel={handleToggleLaufzettel}
          onToggleDepartmentReady={handleToggleDepartmentReady}
          onToggleRevenueMode={handleToggleRevenueMode}
          onBatchApplyToBudget={onApplyToPlannedRevenue ? handleBatchApplyToBudget : undefined}
          dailyBudgets={dailyBudgets}
        />
      )}

      {/* Year Heatmap View */}
      {displayMode === 'year' && (
        <YearHeatmap
          reservations={yearReservations}
          selectedDate={selectedDate}
          onMonthSelect={(month) => {
            setCalendarSelectedDate(month);
            setDisplayMode('calendar');
          }}
        />
      )}

      {/* Detail List View */}
      {displayMode === 'detail' && (
        <EventDetailList
          reservations={filteredReservations}
          onEdit={(reservation) => {
            openEditDialog(reservation);
            setIsAddDialogOpen(true);
          }}
          onDelete={handleDeleteReservation}
          onToggleConfirmed={handleToggleConfirmed}
          onToggleLaufzettel={handleToggleLaufzettel}
          onToggleDepartmentReady={handleToggleDepartmentReady}
          onSendNotification={(reservation) => {
            sendDepartmentNotifications(reservation.id, {
              date: reservation.date,
              shift: reservation.shift,
              group_name: reservation.group_name,
              guest_count: reservation.guest_count,
              location: reservation.location,
              notes: reservation.notes,
              revenue_per_person: reservation.revenue_per_person,
            });
          }}
          onToggleRevenueMode={handleToggleRevenueMode}
          isLoading={isLoading}
        />
      )}

      {/* Summary Cards - show only in list mode or always */}
      {displayMode === 'list' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="stat-card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Events</p>
                  <p className="text-2xl font-bold">{summaryStats.totalReservations}</p>
                </div>
                <PartyPopper className="h-8 w-8 text-primary/20" />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                an {summaryStats.uniqueDates} Tagen
              </p>
            </CardContent>
          </Card>

          <Card className="stat-card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Gäste</p>
                  <p className="text-2xl font-bold">{summaryStats.totalGuests}</p>
                </div>
                <Users className="h-8 w-8 text-primary/20" />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Ø {summaryStats.avgGuestsPerEvent} pro Event
              </p>
            </CardContent>
          </Card>

          <Card className="stat-card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Umsatz (Plan)</p>
                  <p className="text-2xl font-bold text-primary">{formatCurrency(summaryStats.totalRevenue)}</p>
                </div>
                <Euro className="h-8 w-8 text-primary/20" />
              </div>
            </CardContent>
          </Card>

          <Card className="stat-card">
            <CardContent className="p-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Sun className="h-3.5 w-3.5 text-amber-500" />
                    <span className="text-xs">Mittag</span>
                  </div>
                  <span className="text-sm font-medium">{summaryStats.mittagCount} ({summaryStats.mittagGuests} Gäste)</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Moon className="h-3.5 w-3.5 text-indigo-500" />
                    <span className="text-xs">Abend</span>
                  </div>
                  <span className="text-sm font-medium">{summaryStats.abendCount} ({summaryStats.abendGuests} Gäste)</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Search - show in both modes */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Events durchsuchen..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Events List - show in list mode or below calendar */}
      <Card className="stat-card">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            {displayMode === 'calendar' ? 'Events im ausgewählten Zeitraum' : 'Alle Events'}
            <Badge variant="secondary" className="ml-2">{filteredReservations.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">
              Lade Events...
            </div>
          ) : filteredReservations.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <PartyPopper className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
              <p>Keine Events gefunden</p>
              <p className="text-sm mt-1">Klicken Sie auf einen Tag im Kalender, um ein Event hinzuzufügen</p>
            </div>
          ) : (
            <ScrollArea className={cn(displayMode === 'calendar' ? "max-h-[400px]" : "max-h-[600px]")}>
              <div className="divide-y divide-border">
                {Object.entries(groupedByDate)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([date, dateReservations]) => {
                    const isExpanded = expandedDates.has(date) || viewMode === 'day' || displayMode === 'calendar';
                    const dateObj = parseISO(date);
                    const dayGuests = dateReservations.reduce((sum, r) => sum + r.guest_count, 0);
                    const dayRevenue = dateReservations.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);

                    return (
                      <div key={date}>
                        {/* Date Header */}
                        <button
                          onClick={() => toggleDateExpanded(date)}
                          className={cn(
                            "w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors",
                            isExpanded && "bg-muted/30"
                          )}
                        >
                          <div className="flex items-center gap-3">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            <div className="text-left">
                              <p className="font-medium">
                                {format(dateObj, 'EEEE, d. MMMM', { locale: de })}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {dateReservations.length} Event{dateReservations.length !== 1 ? 's' : ''} · {dayGuests} Gäste
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-medium text-primary">{formatCurrency(dayRevenue)}</p>
                          </div>
                        </button>

                        {/* Reservations for this date */}
                        {isExpanded && (
                          <div className="bg-muted/20">
                            {dateReservations.map((reservation) => (
                              <div
                                key={reservation.id}
                                className="flex items-center justify-between p-3 pl-10 border-t border-border/50 hover:bg-muted/30 transition-colors"
                              >
                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                  <div className={cn(
                                    "p-1.5 rounded-full",
                                    reservation.shift === 'mittag' ? "bg-amber-500/10" : "bg-indigo-500/10"
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
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <span className="flex items-center gap-1">
                                        <Users className="h-3 w-3" />
                                        {reservation.guest_count}
                                      </span>
                                      <span>·</span>
                                      <span className="flex items-center gap-1">
                                        {reservation.location === 'U1 Bar' ? (
                                          <Wine className="h-3 w-3" />
                                        ) : (
                                          <Building className="h-3 w-3" />
                                        )}
                                        {reservation.location}
                                      </span>
                                      {reservation.exclude_walk_in && (
                                        <>
                                          <span>·</span>
                                          <Badge variant="outline" className="text-[10px] px-1 py-0">Kein Walk-In</Badge>
                                        </>
                                      )}
                                    </div>
                                    {reservation.notes && (
                                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                        {reservation.notes}
                                      </p>
                                    )}
                                  </div>
                                </div>
                                
                                <div className="flex items-center gap-2 ml-2">
                                  <span className="font-medium text-sm whitespace-nowrap">
                                    {formatCurrency(reservation.guest_count * reservation.revenue_per_person)}
                                  </span>
                                  
                                  {/* Apply to Budget Button - only for confirmed groups */}
                                  {reservation.is_confirmed && onApplyToPlannedRevenue && (
                                    reservation.applied_to_budget ? (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-emerald-600 hover:text-orange-600 hover:bg-orange-50"
                                            onClick={async () => {
                                              const revenue = reservation.guest_count * reservation.revenue_per_person;
                                              const currentPlanned = dailyBudgets?.[reservation.date]?.plannedRevenue || 0;
                                              const newPlanned = Math.max(0, currentPlanned - revenue);
                                              onApplyToPlannedRevenue(reservation.date, newPlanned);
                                              
                                              // Unmark in database
                                              try {
                                                await supabase
                                                  .from('group_reservations')
                                                  .update({ applied_to_budget: false } as any)
                                                  .eq('id', reservation.id);
                                                
                                                setReservations(prev => prev.map(r => 
                                                  r.id === reservation.id ? { ...r, applied_to_budget: false } : r
                                                ));
                                              } catch (error) {
                                                console.error('Error updating applied_to_budget:', error);
                                              }
                                              
                                              toast.success(`${formatCurrency(revenue)} vom Plan-Umsatz für ${format(parseISO(reservation.date), 'd.M.', { locale: de })} entfernt`);
                                            }}
                                          >
                                            <CheckCircle2 className="h-4 w-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p>Budget-Übertragung rückgängig machen</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    ) : (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-primary hover:text-primary hover:bg-primary/10"
                                            onClick={async () => {
                                              const revenue = reservation.guest_count * reservation.revenue_per_person;
                                              const currentPlanned = dailyBudgets?.[reservation.date]?.plannedRevenue || 0;
                                              const newPlanned = currentPlanned + revenue;
                                              onApplyToPlannedRevenue(reservation.date, newPlanned);
                                              
                                              // Mark as applied in database
                                              try {
                                                await supabase
                                                  .from('group_reservations')
                                                  .update({ applied_to_budget: true } as any)
                                                  .eq('id', reservation.id);
                                                
                                                setReservations(prev => prev.map(r => 
                                                  r.id === reservation.id ? { ...r, applied_to_budget: true } : r
                                                ));
                                              } catch (error) {
                                                console.error('Error updating applied_to_budget:', error);
                                              }
                                              
                                              toast.success(`${formatCurrency(revenue)} zum Plan-Umsatz für ${format(parseISO(reservation.date), 'd.M.', { locale: de })} hinzugefügt`);
                                            }}
                                          >
                                            <ArrowRightCircle className="h-4 w-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          <p>Zum Plan-Umsatz übertragen</p>
                                        </TooltipContent>
                                      </Tooltip>
                                    )
                                  )}
                                  
                                  {reservation.menu_pdf_url && (
                                    <a
                                      href={reservation.menu_pdf_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1.5 hover:bg-background rounded"
                                    >
                                      <FileText className="h-4 w-4 text-muted-foreground" />
                                    </a>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    onClick={() => {
                                      openEditDialog(reservation);
                                      setIsAddDialogOpen(true);
                                    }}
                                  >
                                    <Edit3 className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                    onClick={() => handleDeleteReservation(reservation.id)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Import & Settings Section - Collapsible */}
      <Collapsible open={isImportSectionOpen} onOpenChange={setIsImportSectionOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <div className="flex items-center gap-2">
              <Import className="h-4 w-4" />
              Import & Einstellungen
            </div>
            <ChevronDown className={cn("h-4 w-4 transition-transform", isImportSectionOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 mt-4">
          {/* Foratable API Sync */}
          <ForatableSyncSettings />

          {/* External API Import Settings */}
          <ExternalApiSettings />

          {/* File Import */}
          <FileImportReservations onImportComplete={fetchData} />

          {/* IMAP Email Import Settings */}
          <ImapEmailSettings />

          {/* Department Email Settings */}
          <DepartmentEmailSettings />

          {/* Email Notification Settings */}
          <EventNotificationSettings selectedDate={selectedDate} />
        </CollapsibleContent>
      </Collapsible>

      {/* Edit Dialog */}
      <Dialog open={!!editingReservation && isAddDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setEditingReservation(null);
          resetForm();
        }
        setIsAddDialogOpen(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Event bearbeiten</DialogTitle>
          </DialogHeader>
          <ReservationFormContent />
        </DialogContent>
      </Dialog>
    </div>
    </TooltipProvider>
  );
};
