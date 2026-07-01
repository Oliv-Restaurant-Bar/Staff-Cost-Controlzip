/**
 * SeasonManagerDialog — CRUD für frei definierte, datumsfixe Saisons
 * ==================================================================
 * Verwaltet die pro Mandant gespeicherten Saisons (Name + from/to + Farbe +
 * aktiv) für den Saisonvergleich der Wochentags-Analyse. Bearbeitet eine LOKALE
 * Arbeitskopie; erst „Speichern" reicht die vollständige Liste an `onSave`
 * (Persistenz übernimmt der Aufrufer via KV). Reine Anzeige/Bearbeitung — KEINE
 * Berechnung, KEINE Migration.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, AlertTriangle, Check, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  validateSeasonDefinition,
  findOverlappingSeasons,
  type SeasonDefinition,
} from '@/lib/reservation-weekday-analytics';

/** Farbvorschläge für neue Saisons (durchrotiert). */
const SEASON_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
];

function newSeason(index: number): SeasonDefinition {
  const y = new Date().getFullYear();
  return {
    id: crypto.randomUUID(),
    name: '',
    from: `${y}-01-01`,
    to: `${y}-12-31`,
    color: SEASON_COLORS[index % SEASON_COLORS.length],
    active: true,
  };
}

export interface SeasonManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seasons: SeasonDefinition[];
  /** Persistiert die vollständige neue Liste (Aufrufer schreibt in KV). */
  onSave: (next: SeasonDefinition[]) => void | Promise<void>;
  /** true → letzter Speicherversuch konnte nicht bestätigt werden (Hinweis). */
  saveError?: boolean;
}

export function SeasonManagerDialog({
  open,
  onOpenChange,
  seasons,
  onSave,
  saveError,
}: SeasonManagerDialogProps) {
  const [working, setWorking] = useState<SeasonDefinition[]>(seasons);
  const [saving, setSaving] = useState(false);

  // Arbeitskopie beim Öffnen aus den echten Saisons neu aufbauen.
  useEffect(() => {
    if (open) setWorking(seasons.map((s) => ({ ...s })));
  }, [open, seasons]);

  const validations = useMemo(
    () => working.map((s) => validateSeasonDefinition(s)),
    [working],
  );
  const allValid = validations.every((v) => v.valid);
  const overlaps = useMemo(() => findOverlappingSeasons(working), [working]);
  const overlapIds = useMemo(() => {
    const set = new Set<string>();
    for (const o of overlaps) { set.add(o.a); set.add(o.b); }
    return set;
  }, [overlaps]);

  const update = (id: string, patch: Partial<SeasonDefinition>) =>
    setWorking((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const addSeason = () => setWorking((prev) => [...prev, newSeason(prev.length)]);
  const removeSeason = (id: string) =>
    setWorking((prev) => prev.filter((s) => s.id !== id));

  const handleSave = async () => {
    if (!allValid) return;
    setSaving(true);
    try {
      const cleaned = working.map((s) => ({ ...s, name: s.name.trim() }));
      await onSave(cleaned);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Saisons verwalten</DialogTitle>
          <DialogDescription>
            Frei benannte Zeiträume mit festen Kalenderdaten (z. B. „Herbst 2026" =
            01.10.2026–31.12.2026). Werden pro Mandant gespeichert und im
            Saisonvergleich zur Auswahl angeboten.
          </DialogDescription>
        </DialogHeader>

        {saveError && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Die letzte Speicherung konnte nicht bestätigt werden. Bitte
              Verbindung prüfen und erneut speichern.
            </span>
          </div>
        )}

        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {working.length === 0 && (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Noch keine Saison definiert. Mit „Saison hinzufügen" die erste anlegen.
            </p>
          )}

          {working.map((s, i) => {
            const v = validations[i];
            const overlapping = overlapIds.has(s.id);
            return (
              <div
                key={s.id}
                className={cn(
                  'rounded-md border p-3 space-y-3',
                  v.valid ? 'border-border' : 'border-red-300 dark:border-red-800',
                )}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[10rem] flex-1">
                    <Label className="mb-1 block text-xs text-muted-foreground">Name</Label>
                    <Input
                      value={s.name}
                      placeholder="z. B. Herbst 2026"
                      onChange={(e) => update(s.id, { name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">Von</Label>
                    <Input
                      type="date"
                      value={s.from}
                      onChange={(e) => update(s.id, { from: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">Bis</Label>
                    <Input
                      type="date"
                      value={s.to}
                      onChange={(e) => update(s.id, { to: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">Farbe</Label>
                    <Input
                      type="color"
                      value={s.color ?? '#2563eb'}
                      onChange={(e) => update(s.id, { color: e.target.value })}
                      className="h-9 w-14 cursor-pointer p-1"
                    />
                  </div>
                  <div className="flex items-center gap-2 pb-2">
                    <Switch
                      checked={s.active}
                      onCheckedChange={(checked) => update(s.id, { active: checked })}
                      id={`active-${s.id}`}
                    />
                    <Label htmlFor={`active-${s.id}`} className="text-xs text-muted-foreground">
                      aktiv
                    </Label>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSeason(s.id)}
                    aria-label="Saison entfernen"
                    className="mb-1 text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                {!v.valid && (
                  <ul className="list-inside list-disc text-xs text-red-600 dark:text-red-400">
                    {v.errors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                )}
                {v.valid && overlapping && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Überschneidet sich mit einer anderen Saison (erlaubt — nur ein Hinweis).
                  </p>
                )}
              </div>
            );
          })}

          <Button type="button" variant="outline" size="sm" onClick={addSeason}>
            <Plus className="mr-1.5 h-4 w-4" />
            Saison hinzufügen
          </Button>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setWorking(seasons.map((s) => ({ ...s })))}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Zurücksetzen
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button type="button" onClick={handleSave} disabled={!allValid || saving}>
              <Check className="mr-1.5 h-4 w-4" />
              Speichern
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
