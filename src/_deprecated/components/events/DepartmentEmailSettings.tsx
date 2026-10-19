import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Palette,
  UtensilsCrossed,
  GlassWater,
  ChefHat,
  Mail,
  Save,
  Loader2,
  Briefcase
} from 'lucide-react';

interface DepartmentEmailSetting {
  id: string;
  department: string;
  email: string | null;
  is_active: boolean;
}

const departmentConfig: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  geschaeftsfuehrer: { icon: Briefcase, label: 'Geschäftsführer', color: 'text-amber-600' },
  dekoration: { icon: Palette, label: 'Dekoration', color: 'text-pink-500' },
  service: { icon: UtensilsCrossed, label: 'Service', color: 'text-cyan-500' },
  bar: { icon: GlassWater, label: 'Bar', color: 'text-purple-500' },
  kueche: { icon: ChefHat, label: 'Küche', color: 'text-orange-500' },
};

export const DepartmentEmailSettings = () => {
  const [settings, setSettings] = useState<DepartmentEmailSetting[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editedEmails, setEditedEmails] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('department_notification_emails')
        .select('*')
        .order('department');

      if (error) throw error;

      // If no data, create default entries
      if (!data || data.length === 0) {
        const departments = ['geschaeftsfuehrer', 'dekoration', 'service', 'bar', 'kueche'];
        for (const dept of departments) {
          await supabase.from('department_notification_emails').insert({
            department: dept,
            email: null,
            is_active: true,
          });
        }
        // Refetch after inserting
        const { data: newData } = await supabase
          .from('department_notification_emails')
          .select('*')
          .order('department');
        setSettings((newData || []) as DepartmentEmailSetting[]);
      } else {
        setSettings(data as DepartmentEmailSetting[]);
      }

      // Initialize edited emails
      const initialEmails: Record<string, string> = {};
      (data || []).forEach((s: any) => {
        initialEmails[s.department] = s.email || '';
      });
      setEditedEmails(initialEmails);
    } catch (error) {
      console.error('Error fetching department email settings:', error);
      toast.error('Fehler beim Laden der Einstellungen');
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleActive = async (department: string, currentValue: boolean) => {
    try {
      const { error } = await supabase
        .from('department_notification_emails')
        .update({ is_active: !currentValue })
        .eq('department', department);

      if (error) throw error;

      setSettings(settings.map(s =>
        s.department === department ? { ...s, is_active: !currentValue } : s
      ));
    } catch (error) {
      console.error('Error toggling status:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const handleEmailChange = (department: string, email: string) => {
    setEditedEmails(prev => ({ ...prev, [department]: email }));
  };

  const handleSaveEmail = async (department: string) => {
    const email = editedEmails[department]?.trim() || null;

    // Validate email if provided
    if (email && !email.includes('@')) {
      toast.error('Bitte gültige E-Mail-Adresse eingeben');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('department_notification_emails')
        .update({ email })
        .eq('department', department);

      if (error) throw error;

      setSettings(settings.map(s =>
        s.department === department ? { ...s, email } : s
      ));
      toast.success(`E-Mail für ${departmentConfig[department]?.label || department} gespeichert`);
    } catch (error) {
      console.error('Error saving email:', error);
      toast.error('Fehler beim Speichern');
    } finally {
      setIsSaving(false);
    }
  };

  const activeCount = settings.filter(s => s.is_active && s.email).length;

  if (isLoading) {
    return (
      <Card className="stat-card">
        <CardContent className="p-8 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Lade Einstellungen...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="stat-card">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Abteilungs-Benachrichtigungen
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-1">{activeCount} aktiv</Badge>
            )}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Konfigurieren Sie E-Mail-Adressen für jede Abteilung. Bei neuen Events werden automatisch Benachrichtigungen gesendet.
        </p>

        <div className="space-y-3">
          {settings.map((setting) => {
            const config = departmentConfig[setting.department];
            if (!config) return null;
            const Icon = config.icon;
            const hasChanges = (editedEmails[setting.department] || '') !== (setting.email || '');

            return (
              <div
                key={setting.id}
                className="flex items-center gap-3 p-3 border rounded-lg bg-background"
              >
                <div className={`${config.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <Label className="text-sm font-medium">{config.label}</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      type="email"
                      placeholder={`${config.label.toLowerCase()}@beispiel.ch`}
                      value={editedEmails[setting.department] || ''}
                      onChange={(e) => handleEmailChange(setting.department, e.target.value)}
                      className="h-8 text-sm"
                    />
                    <Button
                      size="sm"
                      variant={hasChanges ? "default" : "outline"}
                      className="h-8 px-2"
                      onClick={() => handleSaveEmail(setting.department)}
                      disabled={isSaving || !hasChanges}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={setting.is_active}
                    onCheckedChange={() => handleToggleActive(setting.department, setting.is_active)}
                  />
                  {setting.is_active && setting.email && (
                    <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">
                      Aktiv
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-xs text-muted-foreground pt-2 border-t">
          <p>💡 Benachrichtigungen werden automatisch gesendet, wenn ein neues Event erstellt wird.</p>
        </div>
      </CardContent>
    </Card>
  );
};
