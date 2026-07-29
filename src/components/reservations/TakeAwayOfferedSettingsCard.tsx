/**
 * TakeAwayOfferedSettingsCard
 * ===========================
 * Pro Tenant persistierte Einstellung «Betrieb bietet Take Away» (boolean).
 * Steuert, ob die Cockpit-Zeilen «Gäste Take Away» und «Take Away Anteil» in
 * Wochen-/Monatsübersicht (und Excel/PDF-Export) überhaupt erzeugt werden.
 *
 * Defaults: oliv = ja, beaulieu = nein. Lädt/speichert über
 * takeaway-offered-settings (app_settings + tenantKey), fehlertolerant. Der
 * Schalter persistiert SOFORT beim Umlegen (optimistisch, mit Rollback bei
 * Fehler). Reine Präsentation + dünne I/O.
 */

import { useEffect, useState } from 'react';
import { ShoppingBag } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useTenant } from '@/contexts/TenantContext';
import {
  loadTakeAwayOffered, saveTakeAwayOffered, defaultTakeAwayOffered,
} from '@/lib/takeaway-offered-settings';

export function TakeAwayOfferedSettingsCard() {
  const { tenantKey, tenantId } = useTenant();
  const [offered, setOffered] = useState<boolean>(() => defaultTakeAwayOffered(tenantId));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadTakeAwayOffered(tenantKey, tenantId)
      .then(s => { if (!cancelled) setOffered(s.offered); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantKey, tenantId]);

  const toggle = async (next: boolean) => {
    const prev = offered;
    setOffered(next); // optimistisch
    setSaving(true);
    try {
      await saveTakeAwayOffered(tenantKey, tenantId, next, new Date().toISOString());
      toast.success(next ? 'Take Away aktiviert.' : 'Take Away deaktiviert.');
    } catch (e) {
      setOffered(prev); // Rollback
      toast.error('Speichern fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="card-takeaway-offered">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShoppingBag className="h-4 w-4" /> Betrieb bietet Take Away
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Steuert, ob die Cockpit-Zeilen «Gäste Take Away» und «Take Away Anteil»
          in Wochen- und Monatsübersicht (inkl. Excel-/PDF-Export) angezeigt werden.
        </p>
      </CardHeader>
      <CardContent>
        <label className="flex items-center gap-3 cursor-pointer">
          <Switch
            checked={offered}
            disabled={loading || saving}
            onCheckedChange={v => toggle(v === true)}
            data-testid="switch-takeaway-offered"
          />
          <Label className="text-sm cursor-pointer">
            {offered ? 'Ja — Take Away wird angeboten' : 'Nein — kein Take-Away-Angebot'}
          </Label>
        </label>
      </CardContent>
    </Card>
  );
}
