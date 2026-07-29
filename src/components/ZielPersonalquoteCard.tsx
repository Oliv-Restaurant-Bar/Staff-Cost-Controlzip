/**
 * ZielPersonalquoteCard — Einstellungen-Card für die zentrale Ziel-Personalquote.
 * Aus dieser Quote skaliert das Personalkosten-BUDGET mit dem Umsatz:
 *   PK-Budget(Monat) = Ziel-Personalquote × Netto-Umsatz-Budget(Monat).
 * Die harte Obergrenze (40 %) bleibt separat/fix. Persistenz:
 * ziel_personalquote_v1 (localStorage + KV-Backup).
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Save, RotateCcw, Target } from 'lucide-react';
import { toast } from 'sonner';
import { InfoTip } from '@/components/ui/info-tip';
import { DEFAULT_ZIEL_PERSONALQUOTE_PCT } from '@/lib/ziel-personalquote';
import { useZielPersonalquote } from '@/hooks/useZielPersonalquote';

export function ZielPersonalquoteCard() {
  const { pct, updatedAt, loading, save } = useZielPersonalquote();
  const [draft, setDraft] = useState<string>(() => String(pct));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Externe Änderungen (KV-Nachladen, anderer Tab) nur übernehmen,
  // solange der User nicht gerade editiert.
  useEffect(() => {
    if (!dirty) setDraft(String(pct));
  }, [pct, dirty]);

  const parsed = parseFloat(String(draft).replace(',', '.'));
  const invalid = !Number.isFinite(parsed) || parsed < 0 || parsed > 100;

  const handleSave = async () => {
    if (invalid) {
      toast.error('Bitte eine gültige Quote eingeben (0–100 %)');
      return;
    }
    setSaving(true);
    try {
      await save(parsed);
      setDirty(false);
      toast.success('Ziel-Personalquote gespeichert');
    } catch {
      toast.error('Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(String(DEFAULT_ZIEL_PERSONALQUOTE_PCT));
    setDirty(true);
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center">
            <Target className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <CardTitle className="flex items-center gap-1.5">
              Ziel-Personalquote
              <InfoTip text="Zentraler Zielwert für den Personalaufwand in % des Netto-Umsatzes. Daraus skaliert das Personalkosten-Budget mit dem Umsatz: PK-Budget = Ziel-Personalquote × Netto-Umsatz-Budget des Monats. Die harte Obergrenze (40 %) ist separat/fix." />
            </CardTitle>
            <CardDescription>
              PK-Budget = Ziel-Personalquote × Netto-Umsatz-Budget des Monats
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-[220px] space-y-1">
          <Label className="text-xs">Ziel-Personalquote</Label>
          <div className="relative">
            <Input
              type="number"
              inputMode="decimal"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
              className={`pr-8 text-right tabular-nums ${invalid ? 'border-destructive' : ''}`}
              step={0.1}
              min={0}
              max={100}
              aria-label="Ziel-Personalquote in Prozent"
              data-testid="ziel-personalquote-input"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || loading || invalid} data-testid="ziel-personalquote-save">
            <Save className="h-4 w-4 mr-2" />
            Speichern
          </Button>
          <Button variant="outline" onClick={handleReset} data-testid="ziel-personalquote-reset">
            <RotateCcw className="h-4 w-4 mr-2" />
            Standard ({DEFAULT_ZIEL_PERSONALQUOTE_PCT} %)
          </Button>
          {updatedAt && (
            <span className="ml-auto text-xs text-muted-foreground">
              Zuletzt gespeichert: {new Date(updatedAt).toLocaleDateString('de-CH')}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
