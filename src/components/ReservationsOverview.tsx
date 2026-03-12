import { useState, useEffect, useMemo, useRef } from 'react';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, subDays, isSameDay, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatCurrency } from '@/lib/personnel-utils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Users,
  Calendar,
  Sun,
  Moon,
  TrendingUp,
  ChevronDown,
  LineChart,
  CalendarDays,
  CalendarRange,
  Euro,
  ArrowRight,
  Zap,
  Target,
  UserPlus,
  Plus,
  Edit3,
  Trash2,
  FileText,
  RefreshCw,
  Settings2,
  Link2,
  Building,
  Wine,
  Utensils,
  ClipboardCheck,
  ArrowDownToLine,
  PlusCircle,
  TrendingDown,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

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
}

interface FortelableSettings {
  id: string;
  walk_in_percentage: number;
  default_revenue_per_person: number;
  is_enabled: boolean;
  api_key: string | null;
  last_sync_at: string | null;
}

interface FortelableReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  guest_count: number;
  reservation_name: string | null;
}

interface PeriodData {
  reservationCount: number;
  guestCount: number;
  revenue: number;
  mittagReservations: number;
  mittagGuests: number;
  mittagRevenue: number;
  abendReservations: number;
  abendGuests: number;
  abendRevenue: number;
  // New: Revenue calculation with revenue_mode support
  offsetRevenue: number;      // Revenue from offset reservations (first fills budget)
  additionalRevenue: number;  // Revenue from additional reservations (direct add)
  budgetUsed: number;         // How much of the budget was "used" by offset reservations
}

interface ReservationsOverviewProps {
  selectedDate: Date;
  onApplyToPlanned?: (date: string, revenue: number) => void;
  plannedRevenue?: number;
  fixedBudget?: number; // Fixes Budget vom Monatsplan (Startbudget)
  dailyBudgets?: Record<string, { plannedRevenue: number; fixedBudget?: number }>;
  onSetFixedBudget?: (date: string, value: number) => void;
}

type ViewMode = 'day' | 'week' | 'month';
type ReservationType = 'group' | 'walkin';
type GroupType = 'alacarte' | 'laufzettel';
type RevenueMode = 'offset' | 'additional';

export const ReservationsOverview = ({
  selectedDate,
  onApplyToPlanned,
  plannedRevenue = 0,
  fixedBudget,
  dailyBudgets = {},
  onSetFixedBudget,
}: ReservationsOverviewProps) => {
  const [groupReservations, setGroupReservations] = useState<GroupReservation[]>([]);
  const [fortelableReservations, setFortelableReservations] = useState<FortelableReservation[]>([]);
  const [settings, setSettings] = useState<FortelableSettings | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [isLoading, setIsLoading] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingReservation, setEditingReservation] = useState<GroupReservation | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reservation type selection (matching EventsTab)
  const [reservationType, setReservationType] = useState<ReservationType>('group');
  const [groupType, setGroupType] = useState<GroupType>('laufzettel');
  const [revenueMode, setRevenueMode] = useState<RevenueMode>('offset');

  // New reservation form - exclude_walk_in defaults to true for group reservations
  const [newReservation, setNewReservation] = useState({
    group_name: '',
    guest_count: 10,
    revenue_per_person: 35,
    shift: 'abend' as 'mittag' | 'abend',
    notes: '',
    menu_pdf: null as File | null,
    location: 'EG Restaurant' as string,
    exclude_walk_in: true  // Default: no walk-in for group reservations
  });

  const dateString = format(selectedDate, 'yyyy-MM-dd');

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

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const startStr = format(dateRange.start, 'yyyy-MM-dd');
      const endStr = format(dateRange.end, 'yyyy-MM-dd');

      const [groupResult, fortelableResult, settingsResult] = await Promise.all([
        supabase.from('group_reservations').select('*').gte('date', startStr).lte('date', endStr).order('date').order('shift'),
        supabase.from('fortelable_reservations').select('*').gte('date', startStr).lte('date', endStr),
        supabase.from('fortelable_settings').select('*').limit(1).maybeSingle()
      ]);

      if (groupResult.data) {
        setGroupReservations(groupResult.data.map(r => ({
          ...r,
          shift: r.shift as 'mittag' | 'abend',
          location: r.location || 'EG Restaurant',
          exclude_walk_in: r.exclude_walk_in || false,
          group_type: r.group_type as 'laufzettel' | 'alacarte' | null,
          revenue_mode: (r as any).revenue_mode as 'offset' | 'additional' | null
        })));
      }

      if (fortelableResult.data) {
        setFortelableReservations(fortelableResult.data.map(r => ({
          ...r,
          shift: r.shift as 'mittag' | 'abend'
        })));
      }

      if (settingsResult.data) {
        setSettings(settingsResult.data);
      }
    } catch (error) {
      console.error('Error fetching reservation data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Calculate period data with walk-in exclusion logic and revenue_mode support
  const calculatePeriodData = (dayStrings: string[]): PeriodData => {
    const walkInPercentage = settings?.walk_in_percentage || 20;
    const defaultRevenue = settings?.default_revenue_per_person || 35;

    let mittagReservations = 0, mittagGuests = 0, mittagRevenue = 0;
    let abendReservations = 0, abendGuests = 0, abendRevenue = 0;
    
    // Track revenue by mode
    let totalOffsetRevenue = 0;     // Revenue from 'offset' reservations
    let totalAdditionalRevenue = 0; // Revenue from 'additional' reservations

    dayStrings.forEach(ds => {
      const dayGroups = groupReservations.filter(r => r.date === ds);
      const dayFortelable = fortelableReservations.filter(r => r.date === ds);

      ['mittag', 'abend'].forEach(shift => {
        const shiftGroups = dayGroups.filter(r => r.shift === shift);
        const shiftFortelable = dayFortelable.filter(r => r.shift === shift);

        // Separate by revenue_mode
        const offsetGroups = shiftGroups.filter(r => r.revenue_mode !== 'additional');
        const additionalGroups = shiftGroups.filter(r => r.revenue_mode === 'additional');

        // Calculate group guests (separate by walk-in exclusion)
        const groupsWithWalkIn = shiftGroups.filter(r => !r.exclude_walk_in);
        const groupsWithoutWalkIn = shiftGroups.filter(r => r.exclude_walk_in);

        const groupGuestsWithWalkIn = groupsWithWalkIn.reduce((sum, r) => sum + r.guest_count, 0);
        const groupGuestsWithoutWalkIn = groupsWithoutWalkIn.reduce((sum, r) => sum + r.guest_count, 0);
        const groupRevenue = shiftGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        
        // Calculate revenue by mode
        const offsetRevenue = offsetGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        const additionalRevenue = additionalGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        
        totalOffsetRevenue += offsetRevenue;
        totalAdditionalRevenue += additionalRevenue;
        
        const fortelableGuests = shiftFortelable.reduce((sum, r) => sum + r.guest_count, 0);
        const fortelableRevenue = fortelableGuests * defaultRevenue;
        
        // Fortelable reservations are treated as 'offset' (they fill budget first)
        totalOffsetRevenue += fortelableRevenue;
        
        // Walk-ins only calculated on guests that don't have exclude_walk_in
        const totalForWalkIn = groupGuestsWithWalkIn + fortelableGuests;
        const walkInGuests = Math.round(totalForWalkIn * (walkInPercentage / 100));
        const walkInRevenue = walkInGuests * defaultRevenue;
        
        // Walk-in revenue is also 'offset' type (fills budget first)
        totalOffsetRevenue += walkInRevenue;
        
        const totalGuests = groupGuestsWithWalkIn + groupGuestsWithoutWalkIn + fortelableGuests + walkInGuests;
        const totalRevenue = groupRevenue + fortelableRevenue + walkInRevenue;
        const reservationCount = shiftGroups.length + shiftFortelable.length;

        if (shift === 'mittag') {
          mittagReservations += reservationCount;
          mittagGuests += totalGuests;
          mittagRevenue += totalRevenue;
        } else {
          abendReservations += reservationCount;
          abendGuests += totalGuests;
          abendRevenue += totalRevenue;
        }
      });
    });

    // Calculate how much of the budget is "used" by offset reservations
    // This represents reserved capacity that fills the planned budget first
    const budgetUsed = totalOffsetRevenue;

    return {
      reservationCount: mittagReservations + abendReservations,
      guestCount: mittagGuests + abendGuests,
      revenue: mittagRevenue + abendRevenue,
      mittagReservations,
      mittagGuests,
      mittagRevenue,
      abendReservations,
      abendGuests,
      abendRevenue,
      offsetRevenue: totalOffsetRevenue,
      additionalRevenue: totalAdditionalRevenue,
      budgetUsed
    };
  };

  // Calculate data for different periods
  const { dayData, weekData, monthData } = useMemo(() => {
    const dayData = calculatePeriodData([dateString]);

    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).map(d => format(d, 'yyyy-MM-dd'));
    const weekData = calculatePeriodData(weekDays);

    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd }).map(d => format(d, 'yyyy-MM-dd'));
    const monthData = calculatePeriodData(monthDays);

    return { dayData, weekData, monthData };
  }, [dateString, selectedDate, groupReservations, fortelableReservations, settings]);

  // 7-day trend data
  const trendData = useMemo(() => {
    const days: { date: Date; dateString: string }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = subDays(selectedDate, i);
      days.push({ date: d, dateString: format(d, 'yyyy-MM-dd') });
    }

    return days.map(({ date, dateString: ds }) => {
      const data = calculatePeriodData([ds]);
      const isToday = ds === format(selectedDate, 'yyyy-MM-dd');

      return {
        date: ds,
        dayLabel: format(date, 'EEE', { locale: de }),
        dayNum: format(date, 'd.'),
        ...data,
        isToday
      };
    });
  }, [selectedDate, groupReservations, fortelableReservations, settings]);

  // Upload PDF file
  const uploadPdf = async (file: File): Promise<string | null> => {
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `menus/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('menu-pdfs')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('menu-pdfs')
        .getPublicUrl(filePath);

      return publicUrl;
    } catch (error) {
      console.error('Error uploading PDF:', error);
      toast.error('Fehler beim Hochladen der PDF');
      return null;
    }
  };

  // Add new group reservation
  const handleAddReservation = async () => {
    setIsUploading(true);
    try {
      let menuPdfUrl: string | null = null;

      if (newReservation.menu_pdf) {
        menuPdfUrl = await uploadPdf(newReservation.menu_pdf);
      }

      // Determine if this is a walk-in type (matching EventsTab logic)
      const isWalkIn = reservationType === 'walkin';

      const { error } = await supabase
        .from('group_reservations')
        .insert({
          date: dateString,
          shift: newReservation.shift,
          group_name: isWalkIn ? null : (newReservation.group_name || null),
          guest_count: newReservation.guest_count,
          revenue_per_person: newReservation.revenue_per_person,
          notes: newReservation.notes || null,
          menu_pdf_url: menuPdfUrl,
          location: newReservation.location,
          exclude_walk_in: !isWalkIn, // Walk-ins get walk-in calculation, groups don't
          group_type: isWalkIn ? null : groupType,
          laufzettel_done: false,
          revenue_mode: isWalkIn ? 'offset' : revenueMode // Guests always offset, groups can choose
        } as any);

      if (error) throw error;

      toast.success(isWalkIn ? 'Gäste-Reservation hinzugefügt' : 'Gruppenreservation hinzugefügt');
      setIsAddDialogOpen(false);
      resetForm();
      fetchData();
    } catch (error) {
      console.error('Error adding reservation:', error);
      toast.error('Fehler beim Hinzufügen');
    } finally {
      setIsUploading(false);
    }
  };

  // Update existing reservation
  const handleUpdateReservation = async () => {
    if (!editingReservation) return;
    setIsUploading(true);
    
    try {
      let menuPdfUrl = editingReservation.menu_pdf_url;

      if (newReservation.menu_pdf) {
        menuPdfUrl = await uploadPdf(newReservation.menu_pdf);
      }

      const { error } = await supabase
        .from('group_reservations')
        .update({
          shift: newReservation.shift,
          group_name: newReservation.group_name || null,
          guest_count: newReservation.guest_count,
          revenue_per_person: newReservation.revenue_per_person,
          notes: newReservation.notes || null,
          menu_pdf_url: menuPdfUrl,
          location: newReservation.location,
          exclude_walk_in: newReservation.exclude_walk_in
        })
        .eq('id', editingReservation.id);

      if (error) throw error;

      toast.success('Reservation aktualisiert');
      setEditingReservation(null);
      resetForm();
      fetchData();
    } catch (error) {
      console.error('Error updating reservation:', error);
      toast.error('Fehler beim Aktualisieren');
    } finally {
      setIsUploading(false);
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
      toast.success('Reservation gelöscht');
      fetchData();
    } catch (error) {
      console.error('Error deleting reservation:', error);
      toast.error('Fehler beim Löschen');
    }
  };

  // Update settings
  const handleUpdateSettings = async (updates: Partial<FortelableSettings>) => {
    if (!settings) return;
    
    try {
      const { error } = await supabase
        .from('fortelable_settings')
        .update(updates)
        .eq('id', settings.id);

      if (error) throw error;
      setSettings({ ...settings, ...updates });
      toast.success('Einstellungen gespeichert');
    } catch (error) {
      console.error('Error updating settings:', error);
      toast.error('Fehler beim Speichern');
    }
  };

  // Sync with Fortelable API
  const handleSyncFortelable = async () => {
    if (!settings?.api_key) {
      toast.error('Bitte zuerst API-Schlüssel eingeben');
      return;
    }

    setIsSyncing(true);
    try {
      const response = await supabase.functions.invoke('sync-fortelable', {
        body: { date: dateString }
      });

      if (response.error) throw response.error;

      toast.success('Synchronisation erfolgreich');
      fetchData();
    } catch (error) {
      console.error('Error syncing with Fortelable:', error);
      toast.error('Fehler bei der Synchronisation');
    } finally {
      setIsSyncing(false);
    }
  };

  const resetForm = () => {
    setReservationType('group');
    setGroupType('laufzettel');
    setRevenueMode('offset');
    setNewReservation({
      group_name: '',
      guest_count: 10,
      revenue_per_person: 35,
      shift: 'abend',
      notes: '',
      menu_pdf: null,
      location: 'EG Restaurant',
      exclude_walk_in: true  // Default: no walk-in for group reservations
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const openEditDialog = (reservation: GroupReservation) => {
    setEditingReservation(reservation);
    setNewReservation({
      group_name: reservation.group_name || '',
      guest_count: reservation.guest_count,
      revenue_per_person: reservation.revenue_per_person,
      shift: reservation.shift,
      notes: reservation.notes || '',
      menu_pdf: null,
      location: reservation.location || 'EG Restaurant',
      exclude_walk_in: reservation.exclude_walk_in || false
    });
  };

  // Period summary card
  const PeriodCard = ({ 
    title, 
    data, 
    highlight = false 
  }: { 
    title: string; 
    data: PeriodData; 
    highlight?: boolean;
  }) => {
    const avgRevenuePerGuest = data.guestCount > 0 ? data.revenue / data.guestCount : 0;
    
    return (
      <div className={cn(
        "rounded-xl border p-4 space-y-4",
        highlight ? "border-primary/50 bg-primary/5" : "border-border bg-card"
      )}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">{title}</h3>
          <Badge variant="outline" className="font-mono">
            {data.reservationCount} Res.
          </Badge>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Euro className="h-3.5 w-3.5" />
                Erwarteter Umsatz
              </span>
              <span className="font-bold text-primary">{formatCurrency(data.revenue)}</span>
            </div>
            <Progress value={Math.min((data.revenue / 10000) * 100, 100)} className="h-2" />
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1 text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              Gäste erwartet
            </span>
            <span className="font-semibold">{data.guestCount}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/50">
            <div className="text-center p-2 rounded-lg bg-amber-500/10">
              <div className="flex items-center justify-center gap-1 text-xs text-amber-600 mb-1">
                <Sun className="h-3 w-3" />
                Mittag
              </div>
              <p className="text-sm font-semibold">{data.mittagGuests} G.</p>
              <p className="text-[10px] text-muted-foreground">{formatCurrency(data.mittagRevenue)}</p>
            </div>
            <div className="text-center p-2 rounded-lg bg-indigo-500/10">
              <div className="flex items-center justify-center gap-1 text-xs text-indigo-600 mb-1">
                <Moon className="h-3 w-3" />
                Abend
              </div>
              <p className="text-sm font-semibold">{data.abendGuests} G.</p>
              <p className="text-[10px] text-muted-foreground">{formatCurrency(data.abendRevenue)}</p>
            </div>
          </div>

          <div className="text-center pt-2 border-t border-border/50">
            <p className="text-[10px] text-muted-foreground">Ø Umsatz pro Gast</p>
            <p className="text-sm font-semibold">{formatCurrency(avgRevenuePerGuest)}</p>
          </div>
        </div>
      </div>
    );
  };

  // Calculate final revenue based on revenue_mode logic
  // - 'offset' reservations: first fill the budget, only excess counts as additional
  // - 'additional' reservations: immediately add to total
  const calculateSmartRevenue = (data: PeriodData, currentPlanned: number): {
    finalRevenue: number;
    budgetCoverage: number;      // How much of budget is covered by offset reservations
    excessFromOffset: number;    // Excess revenue from offset reservations beyond budget
    additionalTotal: number;     // Direct additional revenue
  } => {
    const { offsetRevenue, additionalRevenue } = data;
    
    // Offset reservations first fill the budget
    // If offset revenue < budget: budget is partially filled
    // If offset revenue > budget: excess becomes additional revenue
    const budgetCoverage = Math.min(offsetRevenue, currentPlanned);
    const excessFromOffset = Math.max(0, offsetRevenue - currentPlanned);
    
    // Final revenue = budget that was covered + excess from offset + all additional
    // This means:
    // - If you have 5000 budget and 3000 offset reservations → 3000 (budget stays at 5000 planned)
    // - If you have 5000 budget and 7000 offset reservations → 5000 + 2000 = 7000
    // - Additional reservations always add on top
    const finalRevenue = currentPlanned + excessFromOffset + additionalRevenue;
    
    return {
      finalRevenue,
      budgetCoverage,
      excessFromOffset,
      additionalTotal: additionalRevenue
    };
  };


  // Auto-apply revenue section with smart calculation
  const AutoApplySection = () => {
    const currentData = viewMode === 'day' ? dayData : viewMode === 'week' ? weekData : monthData;
    const smartCalc = calculateSmartRevenue(currentData, plannedRevenue);
    const canApply = onApplyToPlanned && viewMode === 'day' && currentData.revenue > 0;

    // Show breakdown of how revenue is calculated
    const hasOffsetReservations = currentData.offsetRevenue > 0;
    const hasAdditionalReservations = currentData.additionalRevenue > 0;
    const budgetExceeded = currentData.offsetRevenue > plannedRevenue;

    return (
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Umsatz-Berechnung
          </h3>
        </div>

        {/* Smart Revenue Breakdown */}
        <div className="space-y-3">
          {/* Current Budget */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
            <span className="text-sm flex items-center gap-2">
              <Target className="h-4 w-4 text-muted-foreground" />
              Aktueller Plan-Umsatz
            </span>
            <span className="font-bold">{formatCurrency(plannedRevenue)}</span>
          </div>

          {/* Offset Reservations */}
          {hasOffsetReservations && (
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <ArrowDownToLine className="h-4 w-4 text-slate-600" />
                  "Vom Budget" Reservationen
                </span>
                <span className="font-medium">{formatCurrency(currentData.offsetRevenue)}</span>
              </div>
              
              <div className="text-xs text-muted-foreground space-y-1 pl-6">
                <div className="flex justify-between">
                  <span>→ Vom Budget abgedeckt:</span>
                  <span className={budgetExceeded ? "text-green-600" : ""}>
                    {formatCurrency(smartCalc.budgetCoverage)}
                  </span>
                </div>
                {budgetExceeded && (
                  <div className="flex justify-between text-green-600 font-medium">
                    <span>→ Überschuss (zusätzlich):</span>
                    <span>+{formatCurrency(smartCalc.excessFromOffset)}</span>
                  </div>
                )}
                {!budgetExceeded && (
                  <div className="flex justify-between text-amber-600">
                    <span>→ Noch offen im Budget:</span>
                    <span>{formatCurrency(plannedRevenue - currentData.offsetRevenue)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Additional Reservations */}
          {hasAdditionalReservations && (
            <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50/50">
              <div className="flex items-center justify-between">
                <span className="text-sm flex items-center gap-2">
                  <PlusCircle className="h-4 w-4 text-emerald-600" />
                  "Direkt zusätzlich" Reservationen
                </span>
                <span className="font-medium text-emerald-600">
                  +{formatCurrency(currentData.additionalRevenue)}
                </span>
              </div>
            </div>
          )}

          {/* Final Calculation */}
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/30">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-2">
                <Euro className="h-4 w-4 text-primary" />
                Berechneter Gesamt-Umsatz
              </span>
              <span className="font-bold text-lg text-primary">
                {formatCurrency(smartCalc.finalRevenue)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              = Plan ({formatCurrency(plannedRevenue)}) 
              {smartCalc.excessFromOffset > 0 && ` + Überschuss (${formatCurrency(smartCalc.excessFromOffset)})`}
              {smartCalc.additionalTotal > 0 && ` + Zusätzlich (${formatCurrency(smartCalc.additionalTotal)})`}
            </p>
          </div>
        </div>

        {/* Apply Button */}
        <Button
          onClick={() => onApplyToPlanned?.(dateString, smartCalc.finalRevenue)}
          disabled={!canApply}
          className="w-full gap-2"
        >
          <Target className="h-4 w-4" />
          {formatCurrency(smartCalc.finalRevenue)} als Plan-Umsatz übernehmen
        </Button>

        {viewMode !== 'day' && (
          <p className="text-xs text-muted-foreground text-center">
            Nur in der Tagesansicht verfügbar
          </p>
        )}
      </div>
    );
  };

  // Budget Coverage Overview Component - Shows fixed vs variable budget comparison
  const BudgetCoverageOverview = () => {
    const [showDeficitDetails, setShowDeficitDetails] = useState<'week' | 'month' | null>(null);
    const [editingDay, setEditingDay] = useState<string | null>(null);
    const [editValue, setEditValue] = useState<number>(0);
    
    // Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const getDayOfWeek = (date: Date) => date.getDay();
    
    // Check if a day is Sunday-Thursday (lower traffic days)
    const isLowerTrafficDay = (date: Date) => {
      const day = getDayOfWeek(date);
      return day === 0 || (day >= 1 && day <= 4); // Sunday (0) or Monday-Thursday (1-4)
    };

    // Deficit day detail interface
    interface DeficitDayDetail {
      date: Date;
      dateString: string;
      fixedBudget: number;
      variableBudget: number;
      difference: number;
      isLowerTraffic: boolean;
    }

    // Calculate fixed and variable budgets for a period
    const calculatePeriodBudgets = (days: Date[]) => {
      let totalFixedBudget = 0;
      let totalVariableBudget = 0;
      let totalOffsetRevenue = 0;
      let totalAdditionalRevenue = 0;
      let deficitDays = 0;
      let surplusDays = 0;
      const deficitDayDetails: DeficitDayDetail[] = [];
      const surplusDayDetails: DeficitDayDetail[] = [];

      days.forEach(day => {
        const ds = format(day, 'yyyy-MM-dd');
        const dayBudget = dailyBudgets[ds];
        
        // Fixed budget = fixedBudget if set, otherwise plannedRevenue (Startbudget)
        const dayFixedBudget = dayBudget?.fixedBudget ?? dayBudget?.plannedRevenue ?? plannedRevenue;
        totalFixedBudget += dayFixedBudget;

        // Calculate reservation revenue for this day
        const dayData = calculatePeriodData([ds]);
        totalOffsetRevenue += dayData.offsetRevenue;
        totalAdditionalRevenue += dayData.additionalRevenue;

        // Variable budget = calculated from reservations
        // For lower traffic days (So-Do): show deficit but don't adjust fixed budget
        const dayVariableBudget = dayData.offsetRevenue + dayData.additionalRevenue;
        totalVariableBudget += dayVariableBudget;

        const dayDifference = dayVariableBudget - dayFixedBudget;
        const dayIsLowerTraffic = isLowerTrafficDay(day);

        // Track deficit/surplus days with details
        if (dayVariableBudget < dayFixedBudget) {
          deficitDays++;
          deficitDayDetails.push({
            date: day,
            dateString: ds,
            fixedBudget: dayFixedBudget,
            variableBudget: dayVariableBudget,
            difference: dayDifference,
            isLowerTraffic: dayIsLowerTraffic
          });
        } else if (dayVariableBudget > dayFixedBudget) {
          surplusDays++;
          surplusDayDetails.push({
            date: day,
            dateString: ds,
            fixedBudget: dayFixedBudget,
            variableBudget: dayVariableBudget,
            difference: dayDifference,
            isLowerTraffic: dayIsLowerTraffic
          });
        }
      });

      return {
        fixedBudget: totalFixedBudget,
        variableBudget: totalVariableBudget,
        offsetRevenue: totalOffsetRevenue,
        additionalRevenue: totalAdditionalRevenue,
        difference: totalVariableBudget - totalFixedBudget,
        coveragePercent: totalFixedBudget > 0 ? (totalVariableBudget / totalFixedBudget) * 100 : 0,
        deficitDays,
        surplusDays,
        deficitDayDetails,
        surplusDayDetails,
      };
    };

    // Get week and month days
    const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });
    
    const monthStart = startOfMonth(selectedDate);
    const monthEnd = endOfMonth(selectedDate);
    const monthDays = eachDayOfInterval({ start: monthStart, end: monthEnd });

    // Calculate budgets
    const todayStats = calculatePeriodBudgets([selectedDate]);
    const weekStats = calculatePeriodBudgets(weekDays);
    const monthStats = calculatePeriodBudgets(monthDays);

    // Get today's fixed budget
    const todayFixedBudget = dailyBudgets[dateString]?.fixedBudget ?? dailyBudgets[dateString]?.plannedRevenue ?? plannedRevenue;
    const isTodayLowerTraffic = isLowerTrafficDay(selectedDate);

    // Don't show if no budget data
    if (todayFixedBudget === 0 && weekStats.fixedBudget === 0) {
      return null;
    }

    const renderBudgetCard = (
      title: string,
      icon: React.ReactNode,
      stats: ReturnType<typeof calculatePeriodBudgets>,
      showDeficitWarning: boolean = false,
      periodKey: 'week' | 'month' = 'week'
    ) => {
      const isDeficit = stats.difference < 0;
      const isSurplus = stats.difference > 0;
      const coveragePercent = Math.min(100, stats.coveragePercent);
      const isExpanded = showDeficitDetails === periodKey;

      return (
        <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {icon}
              <span className="font-medium">{title}</span>
            </div>
            <Badge 
              variant={isSurplus ? "default" : "secondary"}
              className={cn(
                "text-xs",
                isSurplus && "bg-emerald-500 hover:bg-emerald-600",
                isDeficit && showDeficitWarning && "bg-amber-500 hover:bg-amber-600"
              )}
            >
              {isSurplus ? (
                <>
                  <TrendingUp className="h-3 w-3 mr-1" />
                  +{formatCurrency(stats.difference)}
                </>
              ) : isDeficit ? (
                <>
                  <TrendingDown className="h-3 w-3 mr-1" />
                  {formatCurrency(stats.difference)}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Ausgeglichen
                </>
              )}
            </Badge>
          </div>

          {/* Fixed vs Variable Budget Comparison */}
          <div className="grid grid-cols-2 gap-2">
            {/* Fixed Budget */}
            <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Target className="h-3 w-3" />
                Fixes Budget
              </div>
              <div className="font-bold text-sm">{formatCurrency(stats.fixedBudget)}</div>
            </div>
            
            {/* Variable Budget */}
            <div className={cn(
              "p-2 rounded-lg space-y-1",
              isSurplus ? "bg-emerald-100 dark:bg-emerald-900/30" : 
              isDeficit ? "bg-amber-100 dark:bg-amber-900/30" : 
              "bg-blue-100 dark:bg-blue-900/30"
            )}>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LineChart className="h-3 w-3" />
                Variables Budget
              </div>
              <div className={cn(
                "font-bold text-sm",
                isSurplus && "text-emerald-600",
                isDeficit && "text-amber-600"
              )}>
                {formatCurrency(stats.variableBudget)}
              </div>
            </div>
          </div>

          {/* Coverage Progress Bar */}
          <div className="space-y-1">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted relative">
              {/* Fixed budget marker at 100% */}
              <div className="absolute inset-y-0 left-[100%] w-0.5 bg-slate-400 dark:bg-slate-500 z-10" style={{ left: '100%' }} />
              <div 
                className={cn(
                  "h-full transition-all duration-500",
                  stats.coveragePercent >= 100 ? "bg-emerald-500" : 
                  stats.coveragePercent >= 80 ? "bg-amber-500" : 
                  stats.coveragePercent >= 50 ? "bg-orange-500" : "bg-red-400"
                )}
                style={{ width: `${coveragePercent}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{stats.coveragePercent.toFixed(0)}% vom Fixes Budget</span>
              {stats.difference !== 0 && (
                <span className={cn(
                  isSurplus ? "text-emerald-600" : "text-amber-600"
                )}>
                  {isSurplus ? '+' : ''}{formatCurrency(stats.difference)}
                </span>
              )}
            </div>
          </div>

          {/* Breakdown */}
          <div className="space-y-1.5 text-xs border-t pt-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-muted-foreground">
                <ArrowDownToLine className="h-3 w-3" />
                Reservationen (Offset)
              </span>
              <span className="font-medium">{formatCurrency(stats.offsetRevenue)}</span>
            </div>
            {stats.additionalRevenue > 0 && (
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-emerald-600">
                  <PlusCircle className="h-3 w-3" />
                  Zusätzlich
                </span>
                <span className="font-medium text-emerald-600">+{formatCurrency(stats.additionalRevenue)}</span>
              </div>
            )}
            
            {/* Clickable Deficit Days Counter */}
            {stats.deficitDays > 0 && (
              <button 
                onClick={() => setShowDeficitDetails(isExpanded ? null : periodKey)}
                className="w-full flex items-center justify-between text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 -mx-1 px-1 py-0.5 rounded transition-colors"
              >
                <span className="flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Tage unter Budget
                  <ChevronDown className={cn("h-3 w-3 transition-transform", isExpanded && "rotate-180")} />
                </span>
                <span className="font-medium">{stats.deficitDays}</span>
              </button>
            )}
          </div>

          {/* Deficit Days Details - Expandable */}
          {isExpanded && stats.deficitDayDetails.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-amber-200 dark:border-amber-800">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  Tage mit Defizit:
                </div>
                {onSetFixedBudget && (
                  <span className="text-[9px] text-muted-foreground">
                    Klick auf Fix-Wert zum Bearbeiten
                  </span>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {stats.deficitDayDetails
                  .sort((a, b) => a.difference - b.difference) // Worst deficit first
                  .map((day) => (
                    <div 
                      key={day.dateString}
                      className={cn(
                        "flex items-center justify-between p-1.5 rounded text-xs",
                        "bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {format(day.date, 'EEE d.M.', { locale: de })}
                        </span>
                        {day.isLowerTraffic && (
                          <Badge variant="outline" className="text-[8px] px-1 py-0 h-4 border-amber-300">
                            So-Do
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-[10px]">
                          Var: {formatCurrency(day.variableBudget)}
                        </span>
                        
                        {/* Editable Fixed Budget */}
                        {editingDay === day.dateString ? (
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              value={editValue}
                              onChange={(e) => setEditValue(parseFloat(e.target.value) || 0)}
                              className="h-5 w-20 text-[10px] px-1"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  onSetFixedBudget?.(day.dateString, editValue);
                                  setEditingDay(null);
                                  toast.success(`Fixes Budget für ${format(day.date, 'd.M.', { locale: de })} aktualisiert`);
                                } else if (e.key === 'Escape') {
                                  setEditingDay(null);
                                }
                              }}
                              onBlur={() => {
                                onSetFixedBudget?.(day.dateString, editValue);
                                setEditingDay(null);
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              if (onSetFixedBudget) {
                                setEditingDay(day.dateString);
                                setEditValue(day.fixedBudget);
                              }
                            }}
                            disabled={!onSetFixedBudget}
                            className={cn(
                              "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded",
                              onSetFixedBudget 
                                ? "hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer" 
                                : "cursor-default"
                            )}
                            title={onSetFixedBudget ? "Fixes Budget bearbeiten" : undefined}
                          >
                            <Target className="h-2.5 w-2.5 text-slate-500" />
                            <span className="font-medium">{formatCurrency(day.fixedBudget)}</span>
                            {onSetFixedBudget && (
                              <Edit3 className="h-2.5 w-2.5 text-muted-foreground opacity-50" />
                            )}
                          </button>
                        )}
                        
                        <span className="font-semibold text-amber-600 dark:text-amber-400 min-w-[60px] text-right">
                          {formatCurrency(day.difference)}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Warning for lower traffic days */}
          {showDeficitWarning && isDeficit && (
            <div className="p-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <p className="text-[10px] text-amber-700 dark:text-amber-300">
                ⚠️ Reservationen decken nicht das fixe Budget. Das Budget bleibt unverändert – Defizit wird angezeigt.
              </p>
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-primary" />
            Fixes vs. Variables Budget
          </h3>
          <Badge variant="outline" className="text-[10px] gap-1">
            <Calendar className="h-3 w-3" />
            {isTodayLowerTraffic ? 'So-Do (niedriger)' : 'Fr-Sa (höher)'}
          </Badge>
        </div>

        {/* Today's Budget Status */}
        <div className="p-3 rounded-lg border-2 border-primary/30 bg-primary/5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Heute ({format(selectedDate, 'EEEE', { locale: de })})
            </span>
            <div className="flex items-center gap-2">
              {/* Editable Today's Fixed Budget */}
              {editingDay === dateString ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Fix:</span>
                  <Input
                    type="number"
                    value={editValue}
                    onChange={(e) => setEditValue(parseFloat(e.target.value) || 0)}
                    className="h-6 w-24 text-xs px-2"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onSetFixedBudget?.(dateString, editValue);
                        setEditingDay(null);
                        toast.success(`Fixes Budget für heute aktualisiert`);
                      } else if (e.key === 'Escape') {
                        setEditingDay(null);
                      }
                    }}
                    onBlur={() => {
                      onSetFixedBudget?.(dateString, editValue);
                      setEditingDay(null);
                    }}
                  />
                </div>
              ) : (
                <Badge 
                  variant="outline" 
                  className={cn(
                    "text-xs gap-1",
                    onSetFixedBudget && "cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"
                  )}
                  onClick={() => {
                    if (onSetFixedBudget) {
                      setEditingDay(dateString);
                      setEditValue(todayFixedBudget);
                    }
                  }}
                >
                  <Target className="h-3 w-3" />
                  Fix: {formatCurrency(todayFixedBudget)}
                  {onSetFixedBudget && <Edit3 className="h-3 w-3 opacity-50" />}
                </Badge>
              )}
              <Badge 
                variant={todayStats.difference >= 0 ? "default" : "secondary"}
                className={cn(
                  "text-xs",
                  todayStats.difference > 0 && "bg-emerald-500",
                  todayStats.difference < 0 && "bg-amber-500"
                )}
              >
                Var: {formatCurrency(todayStats.variableBudget)}
              </Badge>
            </div>
          </div>
          {todayStats.difference !== 0 && (
            <div className={cn(
              "text-xs p-1.5 rounded",
              todayStats.difference > 0 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" :
              "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            )}>
              {todayStats.difference > 0 ? (
                <span>✓ Reservationen bringen +{formatCurrency(todayStats.difference)} über dem fixen Budget</span>
              ) : (
                <span>⚠ Reservationen {formatCurrency(todayStats.difference)} unter dem fixen Budget{isTodayLowerTraffic ? ' (So-Do normal)' : ''}</span>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {renderBudgetCard(
            `KW ${format(selectedDate, 'w')}`,
            <CalendarDays className="h-4 w-4 text-muted-foreground" />,
            weekStats,
            true,
            'week'
          )}
          {renderBudgetCard(
            format(selectedDate, 'MMMM', { locale: de }),
            <CalendarRange className="h-4 w-4 text-muted-foreground" />,
            monthStats,
            false,
            'month'
          )}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 pt-2 text-xs text-muted-foreground border-t">
          <div className="flex items-center gap-1.5">
            <Target className="h-3 w-3" />
            <span>Fixes Budget = Monatsplan-Verteilung (Startbudget)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <LineChart className="h-3 w-3" />
            <span>Variables Budget = Reservationen + Gruppen</span>
          </div>
        </div>
      </div>
    );
  };

  // Reservation Form Dialog Content
  const ReservationFormContent = () => (
    <div className="space-y-4 pt-4">
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
              <span className="text-xs text-muted-foreground text-center">Mit +{settings?.walk_in_percentage || 20}% Walk-In</span>
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
          <Label>Schicht</Label>
          <Select
            value={newReservation.shift}
            onValueChange={(v) => setNewReservation(prev => ({ ...prev, shift: v as 'mittag' | 'abend' }))}
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
        
        <div className="space-y-2">
          <Label>Restaurant</Label>
          <Select
            value={newReservation.location}
            onValueChange={(v) => setNewReservation(prev => ({ ...prev, location: v }))}
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
      </div>

      {/* Group name - only for groups */}
      {reservationType === 'group' && (
        <div className="space-y-2">
          <Label>Gruppenname</Label>
          <Input
            value={newReservation.group_name}
            onChange={(e) => setNewReservation(prev => ({ ...prev, group_name: e.target.value }))}
            placeholder="z.B. Firmenessen"
          />
        </div>
      )}
      
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Anzahl Personen</Label>
          <Input
            type="number"
            min={1}
            value={newReservation.guest_count}
            onChange={(e) => setNewReservation(prev => ({ ...prev, guest_count: parseInt(e.target.value) || 1 }))}
          />
        </div>
        
        <div className="space-y-2">
          <Label>Umsatz/Person (CHF)</Label>
          <Input
            type="number"
            min={0}
            step={0.5}
            value={newReservation.revenue_per_person}
            onChange={(e) => setNewReservation(prev => ({ ...prev, revenue_per_person: parseFloat(e.target.value) || 0 }))}
          />
        </div>
      </div>

      <div className="flex items-center space-x-2 p-3 rounded-lg border bg-muted/30">
        <Checkbox
          id="exclude_walk_in"
          checked={newReservation.exclude_walk_in}
          onCheckedChange={(checked) => setNewReservation(prev => ({ ...prev, exclude_walk_in: checked === true }))}
        />
        <div className="flex-1">
          <Label htmlFor="exclude_walk_in" className="text-sm font-medium cursor-pointer">
            Kein Walk-In-Potenzial
          </Label>
          <p className="text-xs text-muted-foreground">
            {newReservation.exclude_walk_in 
              ? `Geschlossene Gruppe – kein +${settings?.walk_in_percentage || 20}% Walk-In wird hinzugerechnet`
              : `Offene Reservation – +${settings?.walk_in_percentage || 20}% Walk-In-Potenzial wird zum Budget addiert`
            }
          </p>
        </div>
        <Badge variant={newReservation.exclude_walk_in ? "secondary" : "default"} className="text-xs">
          {newReservation.exclude_walk_in ? `Ohne +${settings?.walk_in_percentage || 20}%` : `Mit +${settings?.walk_in_percentage || 20}%`}
        </Badge>
      </div>
      
      <div className="space-y-2">
        <Label>Bemerkungen</Label>
        <Textarea
          value={newReservation.notes}
          onChange={(e) => setNewReservation(prev => ({ ...prev, notes: e.target.value }))}
          placeholder="z.B. Menü bereits besprochen, Allergien beachten..."
          rows={2}
        />
      </div>
      
      <div className="space-y-2">
        <Label>Laufzettel / Menü (PDF)</Label>
        <div className="flex items-center gap-2">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={(e) => setNewReservation(prev => ({ 
              ...prev, 
              menu_pdf: e.target.files?.[0] || null 
            }))}
            className="flex-1"
          />
          {(newReservation.menu_pdf || editingReservation?.menu_pdf_url) && (
            <Badge variant="secondary" className="gap-1">
              <FileText className="h-3 w-3" />
              PDF
            </Badge>
          )}
        </div>
      </div>
      
      <div className="p-3 rounded-lg bg-muted text-sm">
        <div className="flex justify-between font-medium">
          <span>Erwarteter Umsatz:</span>
          <span className="text-primary">
            {(newReservation.guest_count * newReservation.revenue_per_person).toLocaleString('de-CH')} CHF
          </span>
        </div>
      </div>
      
      <Button 
        onClick={editingReservation ? handleUpdateReservation : handleAddReservation} 
        className="w-full"
        disabled={isUploading}
      >
        {isUploading ? (
          <>
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            Speichern...
          </>
        ) : editingReservation ? 'Aktualisieren' : 'Hinzufügen'}
      </Button>
    </div>
  );

  // Group Reservation Card with Edit/Delete
  const GroupReservationCard = ({ reservation }: { reservation: GroupReservation }) => (
    <div className={cn(
      "flex items-center justify-between p-3 rounded-lg border",
      reservation.exclude_walk_in 
        ? "bg-muted/30" 
        : "bg-green-500/5 border-green-500/30"
    )}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {reservation.shift === 'mittag' ? (
          <Sun className="h-4 w-4 text-amber-500 flex-shrink-0" />
        ) : (
          <Moon className="h-4 w-4 text-indigo-500 flex-shrink-0" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">
              {reservation.group_name || 'Gruppenreservation'}
            </span>
            {reservation.location && (
              <Badge variant="outline" className="text-[10px] py-0">
                {reservation.location}
              </Badge>
            )}
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
            {reservation.revenue_mode && (
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
            <Badge 
              variant={reservation.exclude_walk_in ? "secondary" : "default"} 
              className={cn(
                "text-[10px] py-0",
                !reservation.exclude_walk_in && "bg-green-500 hover:bg-green-600"
              )}
            >
              {reservation.exclude_walk_in ? `Ohne +${settings?.walk_in_percentage || 20}%` : `Mit +${settings?.walk_in_percentage || 20}% Walk-In`}
            </Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {format(parseISO(reservation.date), 'd.M.', { locale: de })} • {reservation.guest_count} Pers. × {reservation.revenue_per_person} CHF
          </div>
          {reservation.notes && (
            <div className="text-xs text-muted-foreground mt-1 truncate">
              📝 {reservation.notes}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {reservation.menu_pdf_url && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => window.open(reservation.menu_pdf_url!, '_blank')}
          >
            <FileText className="h-4 w-4 text-primary" />
          </Button>
        )}
        <span className="font-medium text-sm whitespace-nowrap mr-2">
          {(reservation.guest_count * reservation.revenue_per_person).toLocaleString('de-CH')} CHF
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => openEditDialog(reservation)}
        >
          <Edit3 className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={() => handleDeleteReservation(reservation.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  // Daily breakdown table
  const DailyBreakdownTable = () => {
    const days = eachDayOfInterval({ start: dateRange.start, end: dateRange.end });
    
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2 px-2">Tag</th>
              <th className="text-center py-2 px-2">
                <div className="flex items-center justify-center gap-1">
                  <Sun className="h-3 w-3 text-amber-500" />
                  Mittag
                </div>
              </th>
              <th className="text-center py-2 px-2">
                <div className="flex items-center justify-center gap-1">
                  <Moon className="h-3 w-3 text-indigo-500" />
                  Abend
                </div>
              </th>
              <th className="text-right py-2 px-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const ds = format(day, 'yyyy-MM-dd');
              const data = calculatePeriodData([ds]);
              const isSelected = isSameDay(day, selectedDate);
              
              return (
                <tr 
                  key={ds} 
                  className={cn(
                    "border-b hover:bg-muted/50",
                    isSelected && viewMode !== 'day' ? 'bg-primary/5' : ''
                  )}
                >
                  <td className="py-2 px-2">
                    <div className="font-medium">{format(day, 'EEE', { locale: de })}</div>
                    <div className="text-xs text-muted-foreground">{format(day, 'd.M.', { locale: de })}</div>
                  </td>
                  <td className="text-center py-2 px-2">
                    <div className="text-xs text-muted-foreground">{data.mittagReservations} Res.</div>
                    <div className="font-medium">{data.mittagGuests} G.</div>
                  </td>
                  <td className="text-center py-2 px-2">
                    <div className="text-xs text-muted-foreground">{data.abendReservations} Res.</div>
                    <div className="font-medium">{data.abendGuests} G.</div>
                  </td>
                  <td className="text-right py-2 px-2">
                    <div className="font-mono font-medium">{formatCurrency(data.revenue)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  if (isLoading) {
    return (
      <Card className="stat-card">
        <CardContent className="flex items-center justify-center py-12">
          <div className="animate-pulse text-muted-foreground">Laden...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="stat-card">
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="w-full">
          <CardHeader className="cursor-pointer group py-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Target className="h-4 w-4" />
                Reservations-Übersicht
                <Badge variant="secondary" className="ml-2">
                  {dayData.reservationCount} heute
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  {formatCurrency(dayData.revenue)}
                </Badge>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {/* View Mode Toggle & Actions */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(v) => v && setViewMode(v as ViewMode)}
                className="bg-muted/50 p-0.5 rounded-lg"
              >
                <ToggleGroupItem
                  value="day"
                  size="sm"
                  className="text-xs px-3 gap-1 data-[state=on]:bg-background data-[state=on]:shadow-sm"
                >
                  <Calendar className="h-3 w-3" />
                  Tag
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="week"
                  size="sm"
                  className="text-xs px-3 gap-1 data-[state=on]:bg-background data-[state=on]:shadow-sm"
                >
                  <CalendarDays className="h-3 w-3" />
                  Woche
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="month"
                  size="sm"
                  className="text-xs px-3 gap-1 data-[state=on]:bg-background data-[state=on]:shadow-sm"
                >
                  <CalendarRange className="h-3 w-3" />
                  Monat
                </ToggleGroupItem>
              </ToggleGroup>

              <div className="flex items-center gap-2">
                {/* Add Reservation Dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="gap-2">
                      <Plus className="h-4 w-4" />
                      Hinzufügen
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 bg-background border shadow-lg z-50">
                    <DropdownMenuItem 
                      onClick={() => {
                        setReservationType('group');
                        setGroupType('laufzettel');
                        setNewReservation(prev => ({ ...prev, exclude_walk_in: true }));
                        setIsAddDialogOpen(true);
                      }}
                      className="gap-2 cursor-pointer"
                    >
                      <Users className="h-4 w-4" />
                      Gruppe hinzufügen
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => {
                        setReservationType('walkin');
                        setNewReservation(prev => ({ ...prev, exclude_walk_in: false, group_name: '' }));
                        setIsAddDialogOpen(true);
                      }}
                      className="gap-2 cursor-pointer"
                    >
                      <UserPlus className="h-4 w-4" />
                      Normale Gäste
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Dialog for adding reservation */}
                <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
                  setIsAddDialogOpen(open);
                  if (!open) resetForm();
                }}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {reservationType === 'group' ? 'Gruppenreservation hinzufügen' : 'Normale Gäste hinzufügen'}
                      </DialogTitle>
                    </DialogHeader>
                    <ReservationFormContent />
                  </DialogContent>
                </Dialog>

                {/* Sync Button */}
                {settings?.is_enabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSyncFortelable}
                    disabled={isSyncing || !settings.api_key}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />
                    Sync
                  </Button>
                )}

                {/* Settings Button */}
                <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="ghost">
                      <Settings2 className="h-4 w-4" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Reservations-Einstellungen</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-6 pt-4">
                      <div className="space-y-4">
                        <h4 className="font-medium flex items-center gap-2">
                          <Users className="h-4 w-4" />
                          Walk-in Berechnung
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Walk-in Prozentsatz (%)</Label>
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={settings?.walk_in_percentage || 20}
                              onChange={(e) => handleUpdateSettings({ walk_in_percentage: parseFloat(e.target.value) || 0 })}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Standard Umsatz/Person</Label>
                            <Input
                              type="number"
                              min={0}
                              step={0.5}
                              value={settings?.default_revenue_per_person || 35}
                              onChange={(e) => handleUpdateSettings({ default_revenue_per_person: parseFloat(e.target.value) || 0 })}
                            />
                          </div>
                        </div>
                      </div>
                      
                      <div className="space-y-4 pt-4 border-t">
                        <div className="flex items-center justify-between">
                          <h4 className="font-medium flex items-center gap-2">
                            <Link2 className="h-4 w-4" />
                            Fortelable Integration
                          </h4>
                          <Button
                            size="sm"
                            variant={settings?.is_enabled ? 'default' : 'outline'}
                            onClick={() => handleUpdateSettings({ is_enabled: !settings?.is_enabled })}
                          >
                            {settings?.is_enabled ? 'Verbunden' : 'Verbinden'}
                          </Button>
                        </div>
                        
                        {settings?.is_enabled && (
                          <div className="space-y-2">
                            <Label>API-Schlüssel</Label>
                            <Input
                              type="password"
                              value={settings?.api_key || ''}
                              onChange={(e) => handleUpdateSettings({ api_key: e.target.value })}
                              placeholder="API-Schlüssel eingeben..."
                            />
                            {settings?.last_sync_at && (
                              <p className="text-xs text-muted-foreground">
                                Letzte Sync: {format(parseISO(settings.last_sync_at), 'dd.MM.yyyy HH:mm', { locale: de })}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            {/* Date Label */}
            <div className="text-sm text-muted-foreground">
              {format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de })}
            </div>

            {/* Period Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <PeriodCard
                title="Heute"
                data={dayData}
                highlight={viewMode === 'day'}
              />
              <PeriodCard
                title={`KW ${format(selectedDate, 'w')}`}
                data={weekData}
                highlight={viewMode === 'week'}
              />
              <PeriodCard
                title={format(selectedDate, 'MMMM', { locale: de })}
                data={monthData}
                highlight={viewMode === 'month'}
              />
            </div>

            {/* Budget Coverage Overview - Week & Month */}
            <BudgetCoverageOverview />

            {/* Auto-Apply Section */}
            {onApplyToPlanned && <AutoApplySection />}

            {/* Daily Breakdown (for week/month view) */}
            {viewMode !== 'day' && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground">Tagesübersicht</h4>
                <DailyBreakdownTable />
              </div>
            )}

            {/* Group Reservations List */}
            {groupReservations.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground">
                  Gruppenreservationen ({groupReservations.length})
                </h4>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {groupReservations.map((reservation) => (
                    <GroupReservationCard key={reservation.id} reservation={reservation} />
                  ))}
                </div>
              </div>
            )}

            {/* Fortelable Reservations */}
            {settings?.is_enabled && fortelableReservations.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  Fortelable ({fortelableReservations.length})
                </h4>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {fortelableReservations.map((reservation) => (
                    <div
                      key={reservation.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-blue-500/5 border border-blue-500/20"
                    >
                      <div className="flex items-center gap-3">
                        {reservation.shift === 'mittag' ? (
                          <Sun className="h-4 w-4 text-amber-500" />
                        ) : (
                          <Moon className="h-4 w-4 text-indigo-500" />
                        )}
                        <div>
                          <div className="font-medium">
                            {reservation.reservation_name || 'Fortelable'}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {format(parseISO(reservation.date), 'd.M.', { locale: de })} • {reservation.guest_count} Gäste
                          </div>
                        </div>
                      </div>
                      <span className="text-sm font-mono">
                        {(reservation.guest_count * (settings?.default_revenue_per_person || 35)).toLocaleString('de-CH')} CHF
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 7-Day Trend Chart */}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <LineChart className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-sm">7-Tage Reservations-Trend</h3>
              </div>

              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis
                      dataKey="dayLabel"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      className="fill-muted-foreground"
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      className="fill-muted-foreground"
                      width={50}
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      className="fill-muted-foreground"
                      width={30}
                    />
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const data = payload[0]?.payload;
                        return (
                          <div className="bg-popover border border-border rounded-lg shadow-lg p-3 text-xs">
                            <p className="font-semibold mb-2">{data?.dayLabel} {data?.dayNum}</p>
                            <div className="space-y-1">
                              <div className="flex justify-between gap-4">
                                <span className="text-primary">Umsatz:</span>
                                <span className="font-mono">{formatCurrency(data?.revenue || 0)}</span>
                              </div>
                              <div className="flex justify-between gap-4">
                                <span className="text-muted-foreground">Gäste:</span>
                                <span className="font-mono">{data?.guestCount || 0}</span>
                              </div>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Legend
                      verticalAlign="top"
                      height={30}
                      formatter={(value) => (
                        <span className="text-xs">{value}</span>
                      )}
                    />
                    <Bar
                      yAxisId="right"
                      dataKey="guestCount"
                      name="Gäste"
                      fill="hsl(var(--muted-foreground))"
                      fillOpacity={0.3}
                      radius={[2, 2, 0, 0]}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="revenue"
                      name="Umsatz"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={{ fill: 'hsl(var(--primary))', r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>

      {/* Edit Dialog */}
      <Dialog open={!!editingReservation} onOpenChange={(open) => {
        if (!open) {
          setEditingReservation(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reservation bearbeiten</DialogTitle>
          </DialogHeader>
          <ReservationFormContent />
        </DialogContent>
      </Dialog>
    </Card>
  );
};