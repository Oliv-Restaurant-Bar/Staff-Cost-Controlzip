/**
 * ReservationCountingSettingsCard
 * ===============================
 * Zentrale, pro Tenant persistierte Einstellung, welche die Cockpit-Kennzahlen
 * «Reservierte Gäste» und «Gruppen ab N Pax» steuert:
 *   1) Zähl-Status  — welche (normalisierten) Reservations-Status zählen.
 *   2) Gruppen-Schwelle — ab wie vielen Personen eine «grosse Gruppe» zählt.
 *
 * Lädt/speichert über reservation-cockpit-settings (app_settings + tenantKey),
 * fehlertolerant (Defaults bei Lesefehler). Reine Präsentation + dünne I/O.
 */

import { useEffect, useState } from 'react';
import { Sliders } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useTenant } from '@/contexts/TenantContext';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';
import {
  loadReservationCounting, saveReservationCounting,
  COUNTABLE_STATUS_KEYS, STATUS_LABELS, DEFAULT_RESERVATION_COUNTING,
  type ReservationCountingSettings,
} from '@/lib/reservation-cockpit-settings';

export function ReservationCountingSettingsCard() {
  const { tenantKey } = useTenant();
  const [settings, setSettings] = useState<ReservationCountingSettings>(DEFAULT_RESERVATION_COUNTING);
  const [thresholdText, setThresholdText] = useState(String(DEFAULT_RESERVATION_COUNTING.groupThreshold));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadReservationCounting(tenantKey)
      .then(s => {
        if (cancelled) return;
        setSettings(s);
        setThresholdText(String(s.groupThreshold));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantKey]);

  const toggleStatus = (key: ReservationStatusNormalized, on: boolean) => {
    setSettings(prev => {
      const set = new Set(prev.countedStatuses);
      if (on) set.add(key); else set.delete(key);
      return { ...prev, countedStatuses: COUNTABLE_STATUS_KEYS.filter(k => set.has(k)) };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const threshold = Math.max(1, Math.floor(Number(thresholdText) || DEFAULT_RESERVATION_COUNTING.groupThreshold));
      const next: ReservationCountingSettings = { ...settings, groupThreshold: threshold };
      await saveReservationCounting(tenantKey, next, new Date().toISOString());
      setSettings(next);
      setThresholdText(String(threshold));
      toast.success('Zählregel gespeichert.');
    } catch (e) {
      toast.error('Speichern fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => {
    setSettings(DEFAULT_RESERVATION_COUNTING);
    setThresholdText(String(DEFAULT_RESERVATION_COUNTING.groupThreshold));
  };

  return (
    <Card data-testid="card-reservation-counting">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sliders className="h-4 w-4" /> Zählregel Cockpit-Kennzahlen
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Legt fest, welche Reservationen in «Reservierte Gäste» und «Gruppen ab N Pax»
          einfliessen. Gilt für Wochen- und Monatsübersicht im Cockpit.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium mb-2">Gezählte Status</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {COUNTABLE_STATUS_KEYS.map(key => {
              const checked = settings.countedStatuses.includes(key);
              return (
                <label key={key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={checked}
                    disabled={loading}
                    onCheckedChange={v => toggleStatus(key, v === true)}
                    data-testid={`checkbox-status-${key}`}
                  />
                  {STATUS_LABELS[key]}
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="group-threshold" className="text-sm">Gruppen-Schwelle (Personen ≥)</Label>
            <Input
              id="group-threshold" type="number" min={1} className="w-28"
              value={thresholdText} disabled={loading}
              onChange={e => setThresholdText(e.target.value)}
              data-testid="input-group-threshold"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={save} disabled={loading || saving} data-testid="button-save-counting">
            {saving ? 'Speichern …' : 'Speichern'}
          </Button>
          <Button variant="ghost" onClick={resetDefaults} disabled={loading || saving} data-testid="button-reset-counting">
            Standard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
