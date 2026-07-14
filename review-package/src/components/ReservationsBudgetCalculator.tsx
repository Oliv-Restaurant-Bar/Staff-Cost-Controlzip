import { useState, useEffect, useMemo, useRef } from 'react';
import { format, parseISO, startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, addDays, isSameDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { 
  Users, 
  Plus, 
  Trash2, 
  Settings2, 
  RefreshCw, 
  Calendar,
  Sun,
  Moon,
  TrendingUp,
  ChevronDown,
  Link2,
  Unlink,
  Calculator,
  UserPlus,
  FileText,
  Upload,
  Download,
  Eye,
  CalendarDays,
  CalendarRange
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
}

interface FortelableSettings {
  id: string;
  api_key: string | null;
  is_enabled: boolean;
  walk_in_percentage: number;
  default_revenue_per_person: number;
  last_sync_at: string | null;
}

interface FortelableReservation {
  id: string;
  external_id: string | null;
  date: string;
  shift: 'mittag' | 'abend';
  guest_count: number;
  reservation_name: string | null;
}

interface ReservationsBudgetCalculatorProps {
  selectedDate: Date;
  onBudgetUpdate?: (date: string, additionalRevenue: number) => void;
}

type ViewMode = 'day' | 'week' | 'month';

export const ReservationsBudgetCalculator = ({
  selectedDate,
  onBudgetUpdate
}: ReservationsBudgetCalculatorProps) => {
  const [groupReservations, setGroupReservations] = useState<GroupReservation[]>([]);
  const [fortelableReservations, setFortelableReservations] = useState<FortelableReservation[]>([]);
  const [settings, setSettings] = useState<FortelableSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // New reservation form
  const [newReservation, setNewReservation] = useState({
    group_name: '',
    guest_count: 10,
    revenue_per_person: 35,
    shift: 'abend' as 'mittag' | 'abend',
    notes: '',
    menu_pdf: null as File | null
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

      // Fetch group reservations for the range
      const { data: groupData, error: groupError } = await supabase
        .from('group_reservations')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date', { ascending: true })
        .order('shift', { ascending: true });

      if (groupError) throw groupError;
      setGroupReservations((groupData || []).map(r => ({
        ...r,
        shift: r.shift as 'mittag' | 'abend',
        menu_pdf_url: r.menu_pdf_url || null
      })));

      // Fetch Fortelable reservations for the range
      const { data: fortelableData, error: fortelableError } = await supabase
        .from('fortelable_reservations')
        .select('*')
        .gte('date', startStr)
        .lte('date', endStr)
        .order('date', { ascending: true })
        .order('shift', { ascending: true });

      if (fortelableError) throw fortelableError;
      setFortelableReservations((fortelableData || []).map(r => ({
        ...r,
        shift: r.shift as 'mittag' | 'abend'
      })));

      // Fetch settings
      const { data: settingsData, error: settingsError } = await supabase
        .from('fortelable_settings')
        .select('*')
        .limit(1)
        .single();

      if (settingsError && settingsError.code !== 'PGRST116') throw settingsError;
      setSettings(settingsData);

    } catch (error) {
      console.error('Error fetching reservation data:', error);
      toast.error('Fehler beim Laden der Reservierungsdaten');
    } finally {
      setIsLoading(false);
    }
  };

  // Calculate totals for overview
  const overviewStats = useMemo(() => {
    const walkInPercentage = settings?.walk_in_percentage || 20;
    const defaultRevenue = settings?.default_revenue_per_person || 35;

    const days = eachDayOfInterval({ start: dateRange.start, end: dateRange.end });
    
    const dailyStats = days.map(day => {
      const dayStr = format(day, 'yyyy-MM-dd');
      const dayGroups = groupReservations.filter(r => r.date === dayStr);
      const dayFortelable = fortelableReservations.filter(r => r.date === dayStr);

      const calculateShift = (shift: 'mittag' | 'abend') => {
        const shiftGroups = dayGroups.filter(r => r.shift === shift);
        const shiftFortelable = dayFortelable.filter(r => r.shift === shift);

        const groupGuests = shiftGroups.reduce((sum, r) => sum + r.guest_count, 0);
        const groupRevenue = shiftGroups.reduce((sum, r) => sum + (r.guest_count * r.revenue_per_person), 0);
        const fortelableGuests = shiftFortelable.reduce((sum, r) => sum + r.guest_count, 0);
        const fortelableRevenue = fortelableGuests * defaultRevenue;
        const totalReserved = groupGuests + fortelableGuests;
        const walkInGuests = Math.round(totalReserved * (walkInPercentage / 100));
        const walkInRevenue = walkInGuests * defaultRevenue;

        return {
          guests: totalReserved + walkInGuests,
          revenue: groupRevenue + fortelableRevenue + walkInRevenue,
          reservationCount: shiftGroups.length + shiftFortelable.length
        };
      };

      const mittag = calculateShift('mittag');
      const abend = calculateShift('abend');

      return {
        date: day,
        dateStr: dayStr,
        mittag,
        abend,
        total: {
          guests: mittag.guests + abend.guests,
          revenue: mittag.revenue + abend.revenue,
          reservationCount: mittag.reservationCount + abend.reservationCount
        }
      };
    });

    const totals = dailyStats.reduce((acc, day) => ({
      mittagGuests: acc.mittagGuests + day.mittag.guests,
      mittagRevenue: acc.mittagRevenue + day.mittag.revenue,
      mittagReservations: acc.mittagReservations + day.mittag.reservationCount,
      abendGuests: acc.abendGuests + day.abend.guests,
      abendRevenue: acc.abendRevenue + day.abend.revenue,
      abendReservations: acc.abendReservations + day.abend.reservationCount,
      totalGuests: acc.totalGuests + day.total.guests,
      totalRevenue: acc.totalRevenue + day.total.revenue,
      totalReservations: acc.totalReservations + day.total.reservationCount
    }), {
      mittagGuests: 0, mittagRevenue: 0, mittagReservations: 0,
      abendGuests: 0, abendRevenue: 0, abendReservations: 0,
      totalGuests: 0, totalRevenue: 0, totalReservations: 0
    });

    return { dailyStats, totals };
  }, [groupReservations, fortelableReservations, settings, dateRange]);

  // Notify parent of budget changes (for day view)
  useEffect(() => {
    if (onBudgetUpdate && viewMode === 'day') {
      const todayStats = overviewStats.dailyStats.find(d => 
        format(d.date, 'yyyy-MM-dd') === dateString
      );
      if (todayStats) {
        onBudgetUpdate(dateString, todayStats.total.revenue);
      }
    }
  }, [overviewStats, dateString, onBudgetUpdate, viewMode]);

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

      const { error } = await supabase
        .from('group_reservations')
        .insert({
          date: dateString,
          shift: newReservation.shift,
          group_name: newReservation.group_name || null,
          guest_count: newReservation.guest_count,
          revenue_per_person: newReservation.revenue_per_person,
          notes: newReservation.notes || null,
          menu_pdf_url: menuPdfUrl
        });

      if (error) throw error;

      toast.success('Gruppenreservation hinzugefügt');
      setIsAddDialogOpen(false);
      setNewReservation({
        group_name: '',
        guest_count: 10,
        revenue_per_person: 35,
        shift: 'abend',
        notes: '',
        menu_pdf: null
      });
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      fetchData();
    } catch (error) {
      console.error('Error adding reservation:', error);
      toast.error('Fehler beim Hinzufügen');
    } finally {
      setIsUploading(false);
    }
  };

  // Delete group reservation
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

  // View label based on mode
  const getViewLabel = () => {
    switch (viewMode) {
      case 'week':
        return `KW ${format(selectedDate, 'w', { locale: de })} (${format(dateRange.start, 'd.', { locale: de })} - ${format(dateRange.end, 'd. MMM', { locale: de })})`;
      case 'month':
        return format(selectedDate, 'MMMM yyyy', { locale: de });
      default:
        return format(selectedDate, 'EEEE, d. MMMM', { locale: de });
    }
  };

  // Overview Stats Card
  const OverviewStatsCard = () => (
    <div className="grid grid-cols-3 gap-3">
      <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
        <div className="flex items-center gap-2 mb-2">
          <Sun className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Mittag</span>
        </div>
        <div className="space-y-1">
          <div className="text-lg font-bold">{overviewStats.totals.mittagReservations}</div>
          <div className="text-xs text-muted-foreground">Reservationen</div>
          <div className="text-sm font-medium text-amber-600">{overviewStats.totals.mittagGuests} Gäste</div>
          <div className="text-sm font-mono">{overviewStats.totals.mittagRevenue.toLocaleString('de-CH')} CHF</div>
        </div>
      </div>
      
      <div className="p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
        <div className="flex items-center gap-2 mb-2">
          <Moon className="h-4 w-4 text-indigo-500" />
          <span className="text-sm font-medium">Abend</span>
        </div>
        <div className="space-y-1">
          <div className="text-lg font-bold">{overviewStats.totals.abendReservations}</div>
          <div className="text-xs text-muted-foreground">Reservationen</div>
          <div className="text-sm font-medium text-indigo-600">{overviewStats.totals.abendGuests} Gäste</div>
          <div className="text-sm font-mono">{overviewStats.totals.abendRevenue.toLocaleString('de-CH')} CHF</div>
        </div>
      </div>
      
      <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Total</span>
        </div>
        <div className="space-y-1">
          <div className="text-lg font-bold">{overviewStats.totals.totalReservations}</div>
          <div className="text-xs text-muted-foreground">Reservationen</div>
          <div className="text-sm font-medium text-primary">{overviewStats.totals.totalGuests} Gäste</div>
          <div className="text-sm font-mono font-bold">{overviewStats.totals.totalRevenue.toLocaleString('de-CH')} CHF</div>
        </div>
      </div>
    </div>
  );

  // Daily breakdown table
  const DailyBreakdownTable = () => (
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
          {overviewStats.dailyStats.map((day) => (
            <tr 
              key={day.dateStr} 
              className={`border-b hover:bg-muted/50 ${isSameDay(day.date, selectedDate) && viewMode !== 'day' ? 'bg-primary/5' : ''}`}
            >
              <td className="py-2 px-2">
                <div className="font-medium">{format(day.date, 'EEE', { locale: de })}</div>
                <div className="text-xs text-muted-foreground">{format(day.date, 'd.M.', { locale: de })}</div>
              </td>
              <td className="text-center py-2 px-2">
                <div className="text-xs text-muted-foreground">{day.mittag.reservationCount} Res.</div>
                <div className="font-medium">{day.mittag.guests} G.</div>
              </td>
              <td className="text-center py-2 px-2">
                <div className="text-xs text-muted-foreground">{day.abend.reservationCount} Res.</div>
                <div className="font-medium">{day.abend.guests} G.</div>
              </td>
              <td className="text-right py-2 px-2">
                <div className="font-mono font-medium">{day.total.revenue.toLocaleString('de-CH')}</div>
                <div className="text-xs text-muted-foreground">CHF</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Group Reservation Card
  const GroupReservationCard = ({ reservation }: { reservation: GroupReservation }) => (
    <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {reservation.shift === 'mittag' ? (
          <Sun className="h-4 w-4 text-amber-500 flex-shrink-0" />
        ) : (
          <Moon className="h-4 w-4 text-indigo-500 flex-shrink-0" />
        )}
        <div className="min-w-0">
          <div className="font-medium truncate">
            {reservation.group_name || 'Gruppenreservation'}
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
      <div className="flex items-center gap-2 flex-shrink-0">
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
        <span className="font-medium text-sm whitespace-nowrap">
          {(reservation.guest_count * reservation.revenue_per_person).toLocaleString('de-CH')} CHF
        </span>
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

  if (isLoading) {
    return (
      <Card className="stat-card">
        <CardContent className="flex items-center justify-center py-8">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
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
                <Calculator className="h-4 w-4" />
                Reservations-Budget
                <Badge variant="secondary" className="ml-2">
                  {overviewStats.totals.totalReservations} Res.
                </Badge>
                <Badge variant="outline" className="ml-1">
                  {overviewStats.totals.totalGuests} Gäste
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  {overviewStats.totals.totalRevenue.toLocaleString('de-CH')} CHF
                </Badge>
                <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        
        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {/* View Mode Tabs & Actions */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)} className="w-auto">
                <TabsList className="grid grid-cols-3 w-auto">
                  <TabsTrigger value="day" className="gap-1 px-3">
                    <Calendar className="h-4 w-4" />
                    Tag
                  </TabsTrigger>
                  <TabsTrigger value="week" className="gap-1 px-3">
                    <CalendarDays className="h-4 w-4" />
                    Woche
                  </TabsTrigger>
                  <TabsTrigger value="month" className="gap-1 px-3">
                    <CalendarRange className="h-4 w-4" />
                    Monat
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              
              <div className="flex items-center gap-2">
                <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-2">
                      <UserPlus className="h-4 w-4" />
                      Gruppe
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>Gruppenreservation hinzufügen</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 pt-4">
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
                          <Label>Gruppenname</Label>
                          <Input
                            value={newReservation.group_name}
                            onChange={(e) => setNewReservation(prev => ({ ...prev, group_name: e.target.value }))}
                            placeholder="z.B. Firmenessen"
                          />
                        </div>
                      </div>
                      
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
                          {newReservation.menu_pdf && (
                            <Badge variant="secondary" className="gap-1">
                              <FileText className="h-3 w-3" />
                              PDF
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Optional: PDF-Datei mit Menü oder Laufzettel hochladen
                        </p>
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
                        onClick={handleAddReservation} 
                        className="w-full"
                        disabled={isUploading}
                      >
                        {isUploading ? (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                            Hochladen...
                          </>
                        ) : (
                          'Hinzufügen'
                        )}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
                
                {settings?.is_enabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSyncFortelable}
                    disabled={isSyncing || !settings.api_key}
                    className="gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    Sync
                  </Button>
                )}
                
                <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="gap-2">
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
            
            {/* Date/Period Header */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              {getViewLabel()}
            </div>
            
            {/* Overview Stats */}
            <OverviewStatsCard />
            
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
            
            {/* Fortelable Reservations List */}
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
                            {format(parseISO(reservation.date), 'd.M.', { locale: de })} • {reservation.guest_count} Personen
                          </div>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-blue-600">
                        Fortelable
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Empty State */}
            {groupReservations.length === 0 && fortelableReservations.length === 0 && (
              <div className="text-center py-6 text-muted-foreground">
                <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>Keine Reservationen für {viewMode === 'day' ? 'diesen Tag' : viewMode === 'week' ? 'diese Woche' : 'diesen Monat'}</p>
                <p className="text-sm">Fügen Sie Gruppenreservationen hinzu</p>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
};
