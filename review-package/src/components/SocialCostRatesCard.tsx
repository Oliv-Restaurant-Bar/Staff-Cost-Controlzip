/**
 * SocialCostRatesCard — Einstellungen-Card für die zentralen AG-Sozialkostensätze.
 * Personalaufwand = Bruttolohn + AG-Sozialkosten; hier werden die %-Sätze
 * (AHV/ALV/FAK/VK/UVG-BU/KTG/BVG/L-GAV/weitere) zentral gepflegt — NICHT pro
 * Mitarbeiter. Persistenz: socialCostRates_v1 (localStorage + KV-Backup).
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Save, RotateCcw, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import { InfoTip } from '@/components/ui/info-tip';
import {
  DEFAULT_SOCIAL_COST_RATES,
  SOCIAL_COST_RATE_FIELDS,
  normalizeSocialCostRates,
  totalSocialRatePct,
  type SocialCostRates,
} from '@/lib/social-costs';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';

type DraftState = Record<keyof SocialCostRates, string>;

const ratesToDraft = (rates: SocialCostRates): DraftState => {
  const d = {} as DraftState;
  for (const f of SOCIAL_COST_RATE_FIELDS) d[f.key] = String(rates[f.key]);
  return d;
};

const draftToRates = (draft: DraftState): SocialCostRates => {
  const raw: Record<string, number> = {};
  for (const f of SOCIAL_COST_RATE_FIELDS) {
    raw[f.key] = parseFloat(String(draft[f.key]).replace(',', '.'));
  }
  return normalizeSocialCostRates(raw);
};

export function SocialCostRatesCard() {
  const { rates, updatedAt, loading, save } = useSocialCostRates();
  const [draft, setDraft] = useState<DraftState>(() => ratesToDraft(rates));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Externe Änderungen (KV-Nachladen, anderer Tab) nur übernehmen,
  // solange der User nicht gerade editiert.
  useEffect(() => {
    if (!dirty) setDraft(ratesToDraft(rates));
  }, [rates, dirty]);

  const parsed = draftToRates(draft);
  const totalPct = totalSocialRatePct(parsed);

  const invalidKeys = SOCIAL_COST_RATE_FIELDS
    .filter(f => {
      const n = parseFloat(String(draft[f.key]).replace(',', '.'));
      return !Number.isFinite(n) || n < 0 || n > 50;
    })
    .map(f => f.key);

  const handleChange = (key: keyof SocialCostRates, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    if (invalidKeys.length > 0) {
      toast.error('Bitte gültige Sätze eingeben (0–50%)');
      return;
    }
    setSaving(true);
    try {
      await save(parsed);
      setDirty(false);
      toast.success('Sozialkostensätze gespeichert');
    } catch {
      toast.error('Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDraft(ratesToDraft(DEFAULT_SOCIAL_COST_RATES));
    setDirty(true);
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <Landmark className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <CardTitle className="flex items-center gap-1.5">
              Sozialkostensätze Arbeitgeber
              <InfoTip text="Diese Sätze gelten zentral für ALLE Mitarbeiter und Module (Personalstamm, Dienstplan-Kosten, Kennzahlen). Basis ist der Bruttolohn (bei Stundenlohn inkl. Ferien-/Feiertagsentschädigung und 13.). Arbeitnehmerabzüge sind Durchlaufposten und fliessen NICHT in den Personalaufwand ein." />
            </CardTitle>
            <CardDescription>
              Personalaufwand = Bruttolohn + AG-Sozialkosten — Sätze in % des Bruttolohns
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {SOCIAL_COST_RATE_FIELDS.map(({ key, label, info }) => (
            <div key={key} className="space-y-1">
              <Label className="text-xs flex items-center gap-1">
                {label}
                <InfoTip text={info} />
              </Label>
              <div className="relative">
                <Input
                  type="number"
                  inputMode="decimal"
                  value={draft[key]}
                  onChange={(e) => handleChange(key, e.target.value)}
                  className={`pr-8 text-right tabular-nums ${invalidKeys.includes(key) ? 'border-destructive' : ''}`}
                  step={0.1}
                  min={0}
                  max={50}
                  aria-label={label}
                  data-testid={`social-rate-${key}`}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">Total AG-Sozialkosten</span>
          <span className="text-base font-bold tabular-nums" data-testid="social-rate-total">
            {totalPct.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} %
          </span>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving || loading || invalidKeys.length > 0} data-testid="social-rate-save">
            <Save className="h-4 w-4 mr-2" />
            Speichern
          </Button>
          <Button variant="outline" onClick={handleReset} data-testid="social-rate-reset">
            <RotateCcw className="h-4 w-4 mr-2" />
            Richtwerte
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
