/**
 * MwstRatesCard — Einstellungen-Card für die konfigurierbaren MwSt-Sätze.
 * Standard (dine-in, Default 8.1 %) und Take Away (Default 2.6 %); gilt
 * mandantenübergreifend (CH-Sätze). Persistenz: mwst_rates_v1 (KV, global).
 * Wirkt überall, wo Netto aus Brutto abgeleitet wird (Umsatz-SSOT, Cockpit,
 * ER-Übernahme, PKQ/WKQ) — bereits aus der Buchhaltung gebuchte Netto-Werte
 * bleiben unberührt.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Save, RotateCcw, Percent, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_MWST_RATES, getMwstRates, loadMwstRates, saveMwstRates,
} from '@/lib/mwst';
import { usePermissions } from '@/hooks/usePermissions';

export function MwstRatesCard() {
  // Globale (mandantenübergreifende) Einstellung → nur echte Admins dürfen
  // sie sehen/ändern (isAdmin ist für Gäste true → isGuest ausschliessen;
  // beaulieu_manager hat Settings-Zugriff, darf aber keine Oliv-Sätze ändern).
  const { isAdmin, isGuest } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stdPct, setStdPct] = useState('');
  const [taPct, setTaPct] = useState('');

  useEffect(() => {
    let alive = true;
    loadMwstRates().then(r => {
      if (!alive) return;
      setStdPct((r.standard * 100).toFixed(1));
      setTaPct((r.takeaway * 100).toFixed(1));
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const parsePct = (s: string): number => parseFloat(s.replace(',', '.')) / 100;

  const handleSave = async () => {
    const standard = parsePct(stdPct);
    const takeaway = parsePct(taPct);
    if (!isFinite(standard) || !isFinite(takeaway) || standard < 0 || takeaway < 0 || standard > 0.5 || takeaway > 0.5) {
      toast.error('Ungültige MwSt-Sätze — erlaubt sind 0 bis 50 %.');
      return;
    }
    setSaving(true);
    try {
      await saveMwstRates({ standard, takeaway });
      toast.success('MwSt-Sätze gespeichert — Seite wird neu geladen, damit alle Ansichten mit den neuen Sätzen rechnen.');
      // Bereits gerenderte Netto-Memos anderer Seiten rechnen sonst mit den
      // alten Sätzen weiter — Neuladen ist der ehrliche, sichere Weg.
      setTimeout(() => window.location.reload(), 1500);
    } catch (e) {
      toast.error('Speichern fehlgeschlagen: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setStdPct((DEFAULT_MWST_RATES.standard * 100).toFixed(1));
    setTaPct((DEFAULT_MWST_RATES.takeaway * 100).toFixed(1));
  };

  const current = getMwstRates();

  if (!isAdmin || isGuest) return null;

  return (
    <Card className="mb-6" data-testid="mwst-rates-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Percent className="h-4 w-4 text-muted-foreground" />
          <CardTitle>MwSt-Sätze (Umsatz netto)</CardTitle>
        </div>
        <CardDescription>
          Sätze für die Netto-Berechnung aus Brutto-Tagesumsätzen: dine-in (Standard) und Take Away.
          Gilt für beide Betriebe — Beaulieu ohne Take Away rechnet automatisch durchgehend mit dem
          Standardsatz. Bereits aus der Buchhaltung gebuchte Netto-Werte werden nicht verändert.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lade Sätze…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 max-w-md">
              <div className="space-y-1">
                <Label htmlFor="mwst-standard" className="text-xs">Standard (dine-in) %</Label>
                <Input
                  id="mwst-standard" inputMode="decimal" value={stdPct}
                  onChange={e => setStdPct(e.target.value)}
                  data-testid="mwst-standard-input"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mwst-takeaway" className="text-xs">Take Away %</Label>
                <Input
                  id="mwst-takeaway" inputMode="decimal" value={taPct}
                  onChange={e => setTaPct(e.target.value)}
                  data-testid="mwst-takeaway-input"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Aktiv: Standard {(current.standard * 100).toFixed(1)} % · Take Away {(current.takeaway * 100).toFixed(1)} %
              (Defaults {(DEFAULT_MWST_RATES.standard * 100).toFixed(1)} % / {(DEFAULT_MWST_RATES.takeaway * 100).toFixed(1)} %)
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} data-testid="mwst-save">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                Speichern
              </Button>
              <Button size="sm" variant="outline" onClick={handleReset} disabled={saving} data-testid="mwst-reset">
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Auf Defaults zurücksetzen
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
