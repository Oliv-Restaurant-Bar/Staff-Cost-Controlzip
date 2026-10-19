import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { format, addDays, startOfWeek, endOfWeek, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Mail,
  Plus,
  Trash2,
  Send,
  Bell,
  Loader2,
  Calendar,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { ManualEmailDialog } from './ManualEmailDialog';

interface NotificationSetting {
  id: string;
  email: string;
  is_active: boolean;
  notify_group_reservations: boolean;
  notify_regular_reservations: boolean;
  days_before_notification: number;
  created_at: string;
}

interface EventNotificationSettingsProps {
  selectedDate: Date;
}

export const EventNotificationSettings = ({ selectedDate }: EventNotificationSettingsProps) => {
  const [settings, setSettings] = useState<NotificationSetting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDaysBefore, setNewDaysBefore] = useState(7);
  const [notificationWeekStart, setNotificationWeekStart] = useState(() => 
    startOfWeek(selectedDate, { weekStartsOn: 1 })
  );

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('event_notification_settings')
        .select('*')
        .order('created_at');

      if (error) throw error;
      setSettings(data || []);
    } catch (error) {
      console.error('Error fetching notification settings:', error);
      toast.error('Fehler beim Laden der Einstellungen');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddEmail = async () => {
    if (!newEmail || !newEmail.includes('@')) {
      toast.error('Bitte gültige E-Mail-Adresse eingeben');
      return;
    }

    try {
      const { error } = await supabase
        .from('event_notification_settings')
        .insert({
          email: newEmail.trim(),
          days_before_notification: newDaysBefore,
          notify_group_reservations: true,
          notify_regular_reservations: true,
        });

      if (error) throw error;

      toast.success('E-Mail-Empfänger hinzugefügt');
      setNewEmail('');
      setNewDaysBefore(7);
      setIsAddDialogOpen(false);
      fetchSettings();
    } catch (error: any) {
      console.error('Error adding email:', error);
      toast.error(error.message || 'Fehler beim Hinzufügen');
    }
  };

  const handleDeleteEmail = async (id: string) => {
    try {
      const { error } = await supabase
        .from('event_notification_settings')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast.success('E-Mail-Empfänger entfernt');
      fetchSettings();
    } catch (error) {
      console.error('Error deleting email:', error);
      toast.error('Fehler beim Löschen');
    }
  };

  const handleToggleActive = async (id: string, currentValue: boolean) => {
    try {
      const { error } = await supabase
        .from('event_notification_settings')
        .update({ is_active: !currentValue })
        .eq('id', id);

      if (error) throw error;

      setSettings(settings.map(s => 
        s.id === id ? { ...s, is_active: !currentValue } : s
      ));
    } catch (error) {
      console.error('Error toggling status:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const handleToggleNotificationType = async (
    id: string, 
    field: 'notify_group_reservations' | 'notify_regular_reservations',
    currentValue: boolean
  ) => {
    try {
      const { error } = await supabase
        .from('event_notification_settings')
        .update({ [field]: !currentValue })
        .eq('id', id);

      if (error) throw error;

      setSettings(settings.map(s => 
        s.id === id ? { ...s, [field]: !currentValue } : s
      ));
    } catch (error) {
      console.error('Error toggling notification type:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const handleSendManualNotification = async () => {
    const activeEmails = settings.filter(s => s.is_active);
    if (activeEmails.length === 0) {
      toast.error('Keine aktiven E-Mail-Empfänger');
      return;
    }

    setIsSending(true);
    try {
      const response = await supabase.functions.invoke('send-event-notifications', {
        body: {
          manual: true,
          targetDate: format(notificationWeekStart, 'yyyy-MM-dd'),
          daysAhead: 7,
        },
      });

      if (response.error) throw response.error;

      const result = response.data;
      if (result.success) {
        toast.success(`${result.emailsSent} E-Mail(s) gesendet mit ${result.eventsIncluded} Events`);
      } else {
        toast.error(result.message || 'Fehler beim Senden');
      }
    } catch (error: any) {
      console.error('Error sending notifications:', error);
      toast.error(error.message || 'Fehler beim Senden der Benachrichtigungen');
    } finally {
      setIsSending(false);
    }
  };

  const goToPreviousWeek = () => {
    setNotificationWeekStart(prev => addDays(prev, -7));
  };

  const goToNextWeek = () => {
    setNotificationWeekStart(prev => addDays(prev, 7));
  };

  const goToCurrentWeek = () => {
    setNotificationWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }));
  };

  const activeCount = settings.filter(s => s.is_active).length;
  const notificationWeekEnd = endOfWeek(notificationWeekStart, { weekStartsOn: 1 });
  const weekNumber = getISOWeek(notificationWeekStart);
  const isCurrentWeek = getISOWeek(new Date()) === weekNumber && 
    new Date().getFullYear() === notificationWeekStart.getFullYear();

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4" />
            E-Mail-Benachrichtigungen
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-1">{activeCount} aktiv</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <ManualEmailDialog activeEmails={settings.filter(s => s.is_active).map(s => s.email)} />
            
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1">
                  <Plus className="h-4 w-4" />
                  Empfänger
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>E-Mail-Empfänger hinzufügen</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>E-Mail-Adresse</Label>
                    <Input
                      type="email"
                      placeholder="team@beispiel.ch"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Tage vor Event benachrichtigen</Label>
                    <Input
                      type="number"
                      min="1"
                      max="30"
                      value={newDaysBefore}
                      onChange={(e) => setNewDaysBefore(parseInt(e.target.value) || 7)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Für automatische wöchentliche Benachrichtigungen
                    </p>
                  </div>
                  <Button onClick={handleAddEmail} className="w-full">
                    Hinzufügen
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <Button
              size="sm"
              className="gap-1"
              onClick={handleSendManualNotification}
              disabled={isSending || activeCount === 0}
            >
              {isSending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Jetzt senden
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Week Navigation */}
        <div className="p-3 bg-primary/5 rounded-lg border border-primary/20">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">Benachrichtigungs-Zeitraum</span>
              <Badge variant="outline" className="text-xs">
                KW {weekNumber}
              </Badge>
              {isCurrentWeek && (
                <Badge className="text-xs bg-emerald-500">Aktuelle Woche</Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={goToPreviousWeek}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={goToCurrentWeek}
                disabled={isCurrentWeek}
              >
                Heute
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={goToNextWeek}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {format(notificationWeekStart, 'd. MMMM', { locale: de })} – {format(notificationWeekEnd, 'd. MMMM yyyy', { locale: de })}
          </p>
        </div>

        {/* Email Recipients Table */}
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">
            Lade Einstellungen...
          </div>
        ) : settings.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <Mail className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
            <p>Keine E-Mail-Empfänger konfiguriert</p>
            <p className="text-sm mt-1">Fügen Sie Empfänger hinzu, um Benachrichtigungen zu erhalten</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>E-Mail</TableHead>
                  <TableHead className="text-center">Aktiv</TableHead>
                  <TableHead className="text-center">Gruppen</TableHead>
                  <TableHead className="text-center">Walk-In</TableHead>
                  <TableHead className="text-center">Tage</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.map((setting) => (
                  <TableRow key={setting.id}>
                    <TableCell className="font-medium">{setting.email}</TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={setting.is_active}
                        onCheckedChange={() => handleToggleActive(setting.id, setting.is_active)}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={setting.notify_group_reservations}
                        onCheckedChange={() => handleToggleNotificationType(
                          setting.id, 
                          'notify_group_reservations',
                          setting.notify_group_reservations
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={setting.notify_regular_reservations}
                        onCheckedChange={() => handleToggleNotificationType(
                          setting.id, 
                          'notify_regular_reservations',
                          setting.notify_regular_reservations
                        )}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline">{setting.days_before_notification}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteEmail(setting.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground pt-2 border-t">
          <div className="flex items-center gap-1">
            <span className="font-medium">Gruppen:</span>
            <span>Gruppenreservationen mit Namen</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="font-medium">Walk-In:</span>
            <span>Reguläre Gäste (+20% automatisch)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
