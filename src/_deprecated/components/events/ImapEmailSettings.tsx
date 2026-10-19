import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { Mail, RefreshCw, Settings, Eye, EyeOff, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface ImapSettings {
  id?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  use_tls: boolean;
  mailbox: string;
  is_enabled: boolean;
  last_sync_at: string | null;
  last_uid: number;
}

const defaultSettings: ImapSettings = {
  host: '',
  port: 993,
  username: '',
  password: '',
  use_tls: true,
  mailbox: 'INBOX',
  is_enabled: false,
  last_sync_at: null,
  last_uid: 0
};

export const ImapEmailSettings = () => {
  const [settings, setSettings] = useState<ImapSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    success: boolean;
    imported: number;
    skipped: number;
    errors: number;
  } | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const { data, error } = await supabase
        .from('imap_email_settings')
        .select('*')
        .limit(1)
        .single();

      if (data) {
        setSettings(data as ImapSettings);
      }
    } catch (error) {
      // No settings yet, use defaults
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings.host || !settings.username || !settings.password) {
      toast.error('Bitte füllen Sie alle Pflichtfelder aus');
      return;
    }

    setIsSaving(true);
    try {
      if (settings.id) {
        const { error } = await supabase
          .from('imap_email_settings')
          .update({
            host: settings.host,
            port: settings.port,
            username: settings.username,
            password: settings.password,
            use_tls: settings.use_tls,
            mailbox: settings.mailbox,
            is_enabled: settings.is_enabled
          })
          .eq('id', settings.id);

        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from('imap_email_settings')
          .insert({
            host: settings.host,
            port: settings.port,
            username: settings.username,
            password: settings.password,
            use_tls: settings.use_tls,
            mailbox: settings.mailbox,
            is_enabled: settings.is_enabled
          })
          .select()
          .single();

        if (error) throw error;
        setSettings({ ...settings, id: data.id });
      }

      toast.success('IMAP-Einstellungen gespeichert');
    } catch (error: any) {
      console.error('Error saving settings:', error);
      toast.error('Fehler beim Speichern');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSync = async () => {
    if (!settings.is_enabled) {
      toast.error('Bitte aktivieren Sie zuerst den IMAP-Import');
      return;
    }

    setIsSyncing(true);
    setSyncResult(null);

    try {
      const response = await supabase.functions.invoke('fetch-imap-emails');

      if (response.error) {
        throw new Error(response.error.message);
      }

      setSyncResult(response.data);
      
      if (response.data.success) {
        toast.success(`${response.data.imported} E-Mails importiert`);
        fetchSettings(); // Refresh to get updated last_sync_at
      } else {
        toast.error(response.data.error || 'Sync fehlgeschlagen');
      }
    } catch (error: any) {
      console.error('Error syncing:', error);
      toast.error(`Sync-Fehler: ${error.message}`);
      setSyncResult({ success: false, imported: 0, skipped: 0, errors: 1 });
    } finally {
      setIsSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" />
          IMAP E-Mail-Import
        </CardTitle>
        <CardDescription>
          Verbinden Sie ein E-Mail-Postfach, um Reservations-E-Mails automatisch zu importieren
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
          <div className="space-y-0.5">
            <Label className="text-base">IMAP-Import aktivieren</Label>
            <p className="text-sm text-muted-foreground">
              Aktiviert den automatischen Import von Reservations-E-Mails
            </p>
          </div>
          <Switch
            checked={settings.is_enabled}
            onCheckedChange={(checked) => setSettings({ ...settings, is_enabled: checked })}
          />
        </div>

        {/* Server Settings */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="host">IMAP-Server *</Label>
            <Input
              id="host"
              placeholder="imap.example.com"
              value={settings.host}
              onChange={(e) => setSettings({ ...settings, host: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              placeholder="993"
              value={settings.port}
              onChange={(e) => setSettings({ ...settings, port: parseInt(e.target.value) || 993 })}
            />
          </div>
        </div>

        {/* Credentials */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="username">Benutzername / E-Mail *</Label>
            <Input
              id="username"
              placeholder="reservationen@example.com"
              value={settings.username}
              onChange={(e) => setSettings({ ...settings, username: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Passwort *</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={settings.password}
                onChange={(e) => setSettings({ ...settings, password: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Additional Settings */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="mailbox">Postfach</Label>
            <Input
              id="mailbox"
              placeholder="INBOX"
              value={settings.mailbox}
              onChange={(e) => setSettings({ ...settings, mailbox: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2 pt-8">
            <Switch
              id="use_tls"
              checked={settings.use_tls}
              onCheckedChange={(checked) => setSettings({ ...settings, use_tls: checked })}
            />
            <Label htmlFor="use_tls">TLS/SSL verwenden</Label>
          </div>
        </div>

        {/* Status */}
        {settings.last_sync_at && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4 text-green-500" />
            Letzte Synchronisation: {new Date(settings.last_sync_at).toLocaleString('de-CH')}
          </div>
        )}

        {/* Sync Result */}
        {syncResult && (
          <div className={`p-4 rounded-lg border ${syncResult.success ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800'}`}>
            <div className="flex items-center gap-2 mb-2">
              {syncResult.success ? (
                <CheckCircle className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-red-600" />
              )}
              <span className="font-medium">
                {syncResult.success ? 'Sync erfolgreich' : 'Sync fehlgeschlagen'}
              </span>
            </div>
            <div className="flex gap-4 text-sm">
              <Badge variant="outline" className="bg-green-100 text-green-800 border-green-300">
                {syncResult.imported} importiert
              </Badge>
              <Badge variant="outline" className="bg-gray-100 text-gray-800 border-gray-300">
                {syncResult.skipped} übersprungen
              </Badge>
              {syncResult.errors > 0 && (
                <Badge variant="outline" className="bg-red-100 text-red-800 border-red-300">
                  {syncResult.errors} Fehler
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-4">
          <Button onClick={handleSave} disabled={isSaving} className="gap-2">
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Settings className="h-4 w-4" />
            )}
            Speichern
          </Button>
          <Button
            variant="outline"
            onClick={handleSync}
            disabled={isSyncing || !settings.is_enabled || !settings.id}
            className="gap-2"
          >
            {isSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Jetzt synchronisieren
          </Button>
        </div>

        {/* Help Text */}
        <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
          <p><strong>Typische IMAP-Server:</strong></p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Gmail: imap.gmail.com (Port 993)</li>
            <li>Outlook/Microsoft 365: outlook.office365.com (Port 993)</li>
            <li>GMX: imap.gmx.net (Port 993)</li>
            <li>Hostpoint: mail.hostpoint.ch (Port 993)</li>
          </ul>
          <p className="pt-2">
            <strong>Hinweis:</strong> Bei Gmail/Google benötigen Sie ein App-Passwort statt des normalen Passworts.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};
