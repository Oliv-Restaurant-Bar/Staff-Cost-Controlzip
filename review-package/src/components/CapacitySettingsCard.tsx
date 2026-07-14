import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Save, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useCapacitySettings } from '@/hooks/useCapacitySettings';

const DAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export const CapacitySettingsCard = () => {
  const { settings, loading, updateSettings } = useCapacitySettings();
  const [local, setLocal] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Sync local state once when settings finish loading
  useEffect(() => {
    if (!loading && !initialized) {
      setLocal(settings);
      setInitialized(true);
    }
  }, [loading, settings, initialized]);

  const handleSave = async () => {
    setSaving(true);
    const ok = await updateSettings(local);
    setSaving(false);
    if (ok) {
      toast.success('Kapazitäten gespeichert');
    } else {
      toast.error('Fehler beim Speichern');
    }
  };

  const toggleU1Day = (day: number) => {
    setLocal(prev => ({
      ...prev,
      u1_days: prev.u1_days.includes(day)
        ? prev.u1_days.filter(d => d !== day)
        : [...prev.u1_days, day].sort()
    }));
  };

  if (loading) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Kapazitäten
        </CardTitle>
        <CardDescription>
          Platzkapazitäten für die Auslastungsanzeige im Event-Kalender
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="mittag-cap">Mittag (Plätze)</Label>
            <Input
              id="mittag-cap"
              type="number"
              min={1}
              value={local.mittag_capacity}
              onChange={e => setLocal(prev => ({ ...prev, mittag_capacity: parseInt(e.target.value) || 0 }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="abend-cap">Abend (Plätze)</Label>
            <Input
              id="abend-cap"
              type="number"
              min={1}
              value={local.abend_capacity}
              onChange={e => setLocal(prev => ({ ...prev, abend_capacity: parseInt(e.target.value) || 0 }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="u1-cap">U1 Extra-Plätze</Label>
            <Input
              id="u1-cap"
              type="number"
              min={0}
              value={local.u1_capacity}
              onChange={e => setLocal(prev => ({ ...prev, u1_capacity: parseInt(e.target.value) || 0 }))}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>U1-Tage (zusätzliche Abend-Kapazität)</Label>
          <div className="flex flex-wrap gap-3">
            {DAY_LABELS.map((label, idx) => (
              <label key={idx} className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox
                  checked={local.u1_days.includes(idx)}
                  onCheckedChange={() => toggleU1Day(idx)}
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            An gewählten Tagen wird abends die U1-Kapazität ({local.u1_capacity} Plätze) hinzugerechnet → Gesamt: {local.abend_capacity + local.u1_capacity}
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving} className="gap-2">
          <Save className="h-4 w-4" />
          {saving ? 'Speichere...' : 'Speichern'}
        </Button>
      </CardContent>
    </Card>
  );
};

