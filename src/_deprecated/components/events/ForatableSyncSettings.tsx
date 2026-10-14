import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw, Calendar, CheckCircle2, XCircle, Clock, Users, Loader2, Settings2 } from "lucide-react";
import { format, addDays, subDays } from "date-fns";
import { de } from "date-fns/locale";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface ForatableSettings {
  id: string;
  is_enabled: boolean;
  restaurant_hash: string | null;
  default_revenue_per_person: number;
  walk_in_percentage: number;
  last_sync_at: string | null;
}

interface SyncResult {
  success: boolean;
  message: string;
  imported?: number;
  date_range?: { from: string; to: string };
}

export function ForatableSyncSettings() {
  const [settings, setSettings] = useState<ForatableSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editedSettings, setEditedSettings] = useState({
    restaurant_hash: "",
    default_revenue_per_person: 35,
    walk_in_percentage: 20
  });

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('fortelable_settings')
        .select('*')
        .single();

      if (error && error.code !== 'PGRST116') throw error;

      if (data) {
        setSettings(data as ForatableSettings);
        setEditedSettings({
          restaurant_hash: data.restaurant_hash || "",
          default_revenue_per_person: data.default_revenue_per_person || 35,
          walk_in_percentage: data.walk_in_percentage || 20
        });
      }
    } catch (error) {
      console.error('Error fetching Foratable settings:', error);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const saveSettings = async () => {
    try {
      if (settings) {
        const { error } = await supabase
          .from('fortelable_settings')
          .update({
            restaurant_hash: editedSettings.restaurant_hash || null,
            default_revenue_per_person: editedSettings.default_revenue_per_person,
            walk_in_percentage: editedSettings.walk_in_percentage
          })
          .eq('id', settings.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('fortelable_settings')
          .insert({
            restaurant_hash: editedSettings.restaurant_hash || null,
            default_revenue_per_person: editedSettings.default_revenue_per_person,
            walk_in_percentage: editedSettings.walk_in_percentage,
            is_enabled: true
          });

        if (error) throw error;
      }

      toast.success('Einstellungen gespeichert');
      setEditMode(false);
      fetchSettings();
    } catch (error) {
      console.error('Error saving settings:', error);
      toast.error('Fehler beim Speichern');
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;

    try {
      const { error } = await supabase
        .from('fortelable_settings')
        .update({ is_enabled: !settings.is_enabled })
        .eq('id', settings.id);

      if (error) throw error;

      setSettings(prev => prev ? { ...prev, is_enabled: !prev.is_enabled } : null);
      toast.success(settings.is_enabled ? 'Foratable-Sync deaktiviert' : 'Foratable-Sync aktiviert');
    } catch (error) {
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const runSync = async (daysBack: number = 0, daysForward: number = 14) => {
    setSyncing(true);
    setSyncResult(null);

    try {
      const dateFrom = format(subDays(new Date(), daysBack), 'yyyy-MM-dd');
      const dateTo = format(addDays(new Date(), daysForward), 'yyyy-MM-dd');

      const response = await supabase.functions.invoke('sync-fortelable', {
        body: { date_from: dateFrom, date_to: dateTo }
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const result = response.data;
      
      if (result.success) {
        setSyncResult({
          success: true,
          message: `${result.imported || 0} Reservierungen synchronisiert`,
          imported: result.imported || 0,
          date_range: { from: dateFrom, to: dateTo }
        });
        toast.success(`${result.imported || 0} Reservierungen von Foratable importiert`);
        fetchSettings(); // Refresh to get updated last_sync_at
      } else {
        throw new Error(result.error || 'Sync fehlgeschlagen');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
      setSyncResult({
        success: false,
        message: message
      });
      toast.error(`Sync fehlgeschlagen: ${message}`);
    }

    setSyncing(false);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Laden...
        </CardContent>
      </Card>
    );
  }

  const isConfigured = settings?.restaurant_hash;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Calendar className="h-5 w-5" />
              Foratable API-Sync
            </CardTitle>
            <CardDescription>
              Automatische Synchronisation von Reservierungen aus Foratable
            </CardDescription>
          </div>
          {settings && (
            <Switch
              checked={settings.is_enabled}
              onCheckedChange={toggleEnabled}
              disabled={!isConfigured}
            />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Configuration Status */}
        {!isConfigured && (
          <Alert>
            <Settings2 className="h-4 w-4" />
            <AlertDescription>
              Bitte konfigurieren Sie den Restaurant-Hash um die Foratable-Integration zu aktivieren.
            </AlertDescription>
          </Alert>
        )}

        {/* Settings Form */}
        {editMode ? (
          <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
            <div className="space-y-2">
              <Label htmlFor="restaurant_hash">Restaurant Hash</Label>
              <Input
                id="restaurant_hash"
                value={editedSettings.restaurant_hash}
                onChange={(e) => setEditedSettings(prev => ({ ...prev, restaurant_hash: e.target.value }))}
                placeholder="z.B. abc123..."
              />
              <p className="text-xs text-muted-foreground">
                Der eindeutige Hash Ihres Restaurants aus der Foratable-API
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="revenue_per_person">Umsatz pro Person (€)</Label>
                <Input
                  id="revenue_per_person"
                  type="number"
                  value={editedSettings.default_revenue_per_person}
                  onChange={(e) => setEditedSettings(prev => ({ 
                    ...prev, 
                    default_revenue_per_person: parseFloat(e.target.value) || 0 
                  }))}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="walk_in_percentage">Walk-in Zuschlag (%)</Label>
                <Input
                  id="walk_in_percentage"
                  type="number"
                  value={editedSettings.walk_in_percentage}
                  onChange={(e) => setEditedSettings(prev => ({ 
                    ...prev, 
                    walk_in_percentage: parseFloat(e.target.value) || 0 
                  }))}
                />
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditMode(false)}>
                Abbrechen
              </Button>
              <Button onClick={saveSettings}>
                Speichern
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Restaurant Hash:</span>
                <span className="font-mono">
                  {settings?.restaurant_hash 
                    ? `${settings.restaurant_hash.substring(0, 8)}...` 
                    : <span className="text-muted-foreground italic">Nicht konfiguriert</span>
                  }
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>€{settings?.default_revenue_per_person || 35}/Person</span>
                <span>{settings?.walk_in_percentage || 20}% Walk-in</span>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
              <Settings2 className="h-4 w-4 mr-1" />
              Bearbeiten
            </Button>
          </div>
        )}

        {/* Last Sync Info */}
        {settings?.last_sync_at && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            Letzte Synchronisation: {format(new Date(settings.last_sync_at), "dd.MM.yyyy HH:mm", { locale: de })}
          </div>
        )}

        {/* Sync Buttons */}
        {isConfigured && settings?.is_enabled && (
          <div className="flex flex-wrap gap-2">
            <Button 
              onClick={() => runSync(0, 7)} 
              disabled={syncing}
              size="sm"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Nächste 7 Tage
            </Button>
            <Button 
              onClick={() => runSync(0, 14)} 
              disabled={syncing}
              variant="outline"
              size="sm"
            >
              Nächste 14 Tage
            </Button>
            <Button 
              onClick={() => runSync(0, 30)} 
              disabled={syncing}
              variant="outline"
              size="sm"
            >
              Nächster Monat
            </Button>
          </div>
        )}

        {/* Sync Result */}
        {syncResult && (
          <Alert variant={syncResult.success ? "default" : "destructive"}>
            {syncResult.success ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            <AlertDescription className="space-y-1">
              <p className="font-medium">{syncResult.message}</p>
              {syncResult.date_range && (
                <p className="text-xs text-muted-foreground">
                  Zeitraum: {format(new Date(syncResult.date_range.from), 'dd.MM.', { locale: de })} - {format(new Date(syncResult.date_range.to), 'dd.MM.yyyy', { locale: de })}
                </p>
              )}
              {syncResult.success && syncResult.imported !== undefined && syncResult.imported > 0 && (
                <Badge variant="secondary" className="mt-1">
                  <Users className="h-3 w-3 mr-1" />
                  {syncResult.imported} Reservierungen
                </Badge>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
