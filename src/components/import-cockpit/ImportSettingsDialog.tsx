/**
 * ImportSettingsDialog — Einstellungen des Import-Cockpits.
 * =========================================================
 * Pro Importtyp: Frequenz (nur erlaubte Frequenzen des Typs) + Karenztage
 * (0–14, «Tag X gilt erst ab X+1+Karenz als fällig»). Zusätzlich tenant-weite
 * Ruhetage (ISO-Wochentage), an denen KEINE Tagesaufgaben erwartet werden.
 *
 * Der Dialog ist rein lokal (Draft-State); erst «Speichern» wendet die
 * Änderungen über die reinen apply*-Funktionen (Dirty-Check, Tombstones)
 * auf den Blob an und reicht ihn an die Page zur Persistenz weiter.
 * Keine Änderung ⇒ No-op (es wird NICHT geschrieben).
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InfoTip } from '@/components/ui/info-tip';
import { cn } from '@/lib/utils';
import { getTaskTypeDef } from '@/lib/import-tasks-engine';
import {
  CONFIGURABLE_IMPORT_TYPES,
  FREQUENCY_SETTING_LABEL,
  MAX_DELAY_DAYS,
  allowedFrequencies,
  applyImportTypeSetting,
  applyRestWeekdays,
  resolveImportSettings,
  type ConfigurableImportType,
  type ImportFrequencySetting,
  type ImportSettingsBlob,
} from '@/lib/import-settings';

const WEEKDAYS: Array<{ iso: number; label: string }> = [
  { iso: 1, label: 'Mo' },
  { iso: 2, label: 'Di' },
  { iso: 3, label: 'Mi' },
  { iso: 4, label: 'Do' },
  { iso: 5, label: 'Fr' },
  { iso: 6, label: 'Sa' },
  { iso: 7, label: 'So' },
];

interface DraftTypeSetting {
  frequency: ImportFrequencySetting;
  /** Als String, damit das Eingabefeld leer sein darf (Validierung beim Speichern). */
  delayDays: string;
}

export function ImportSettingsDialog({
  open,
  onOpenChange,
  blob,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Aktueller Einstellungs-Blob (Quelle des Draft-States beim Öffnen). */
  blob: ImportSettingsBlob;
  saving?: boolean;
  /** Erhält den NEUEN Blob; nur aufgerufen, wenn sich etwas geändert hat. */
  onSave: (next: ImportSettingsBlob) => void;
}) {
  const effective = useMemo(() => resolveImportSettings(blob), [blob]);

  const [draft, setDraft] = useState<Record<ConfigurableImportType, DraftTypeSetting>>(() => initDraft());
  const [restDays, setRestDays] = useState<Set<number>>(() => new Set(effective.restWeekdays));

  function initDraft(): Record<ConfigurableImportType, DraftTypeSetting> {
    const out = {} as Record<ConfigurableImportType, DraftTypeSetting>;
    for (const type of CONFIGURABLE_IMPORT_TYPES) {
      const s = effective.types[type];
      out[type] = { frequency: s.frequency, delayDays: String(s.delayDays) };
    }
    return out;
  }

  // Beim Öffnen den Draft aus dem aktuellen Blob neu aufbauen.
  useEffect(() => {
    if (!open) return;
    const next = {} as Record<ConfigurableImportType, DraftTypeSetting>;
    for (const type of CONFIGURABLE_IMPORT_TYPES) {
      const s = effective.types[type];
      next[type] = { frequency: s.frequency, delayDays: String(s.delayDays) };
    }
    setDraft(next);
    setRestDays(new Set(effective.restWeekdays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleRestDay = (iso: number) => {
    setRestDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  };

  const handleSave = () => {
    const nowIso = new Date().toISOString();
    let current = blob;
    let changed = false;
    for (const type of CONFIGURABLE_IMPORT_TYPES) {
      const d = draft[type];
      const parsed = Number.parseInt(d.delayDays, 10);
      const delayDays = Number.isFinite(parsed) ? Math.min(MAX_DELAY_DAYS, Math.max(0, parsed)) : 0;
      const res = applyImportTypeSetting(current, type, { frequency: d.frequency, delayDays }, nowIso);
      current = res.blob;
      changed = changed || res.changed;
    }
    const restRes = applyRestWeekdays(current, [...restDays], nowIso);
    current = restRes.blob;
    changed = changed || restRes.changed;

    if (!changed) {
      onOpenChange(false);
      return;
    }
    onSave(current);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl" data-testid="import-settings-dialog">
        <DialogHeader>
          <DialogTitle>Import-Einstellungen</DialogTitle>
          <DialogDescription>
            Rhythmus und Karenz pro Importtyp sowie Ruhetage des Betriebs. Die Einstellungen
            gelten für den ganzen Betrieb und steuern, wann Aufgaben als fällig erscheinen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Ruhetage */}
          <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 flex items-center gap-1.5">
              <span className="text-sm font-medium">Ruhetage</span>
              <InfoTip text="An Ruhetagen werden keine Tagesdaten erwartet — für diese Wochentage entstehen keine offenen Tagesaufgaben (z. B. Z-Bericht, Gäste & Bonanalyse)." />
            </div>
            <div className="flex flex-wrap gap-1.5" data-testid="settings-rest-days">
              {WEEKDAYS.map((d) => {
                const active = restDays.has(d.iso);
                return (
                  <button
                    key={d.iso}
                    type="button"
                    onClick={() => toggleRestDay(d.iso)}
                    aria-pressed={active}
                    className={cn(
                      'h-8 w-10 rounded-md border text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border/60 bg-card text-muted-foreground hover:bg-accent',
                    )}
                    data-testid={`settings-rest-day-${d.iso}`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Frequenz + Karenz pro Typ */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_10rem_5.5rem] items-center gap-2 px-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Importtyp</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rhythmus</span>
              <span className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Karenz
                <InfoTip text="Bereitstellungs-Verzögerung in Tagen: Der Tag X gilt erst ab X+1+Karenz als fällig (z. B. Mirus-Stunden liegen erst 2 Tage später vor). Maximal 14 Tage." />
              </span>
            </div>
            {CONFIGURABLE_IMPORT_TYPES.map((type) => {
              const def = getTaskTypeDef(type);
              const d = draft[type];
              const freqs = allowedFrequencies(type);
              return (
                <div
                  key={type}
                  className="grid grid-cols-[1fr_10rem_5.5rem] items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                  data-testid={`settings-row-${type}`}
                >
                  <span className="truncate text-sm">{def.label}</span>
                  <Select
                    value={d.frequency}
                    onValueChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        [type]: { ...prev[type], frequency: v as ImportFrequencySetting },
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs" data-testid={`settings-frequency-${type}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {freqs.map((f) => (
                        <SelectItem key={f} value={f} className="text-xs">
                          {FREQUENCY_SETTING_LABEL[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_DELAY_DAYS}
                    value={d.delayDays}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        [type]: { ...prev[type], delayDays: e.target.value },
                      }))
                    }
                    className="h-8 text-right text-xs tabular-nums"
                    aria-label={`Karenztage ${def.label}`}
                    data-testid={`settings-delay-${type}`}
                  />
                </div>
              );
            })}
          </div>

          <div>
            <Label className="sr-only">Hinweis</Label>
            <p className="text-xs text-muted-foreground">
              «Bei Bedarf» und «Deaktiviert» erzeugen keine Aufgaben — der Datenstand bleibt
              trotzdem sichtbar. Die Inventur ist ein manuelles Monats-Häkchen ohne Importpfad.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Abbrechen
          </Button>
          <Button onClick={handleSave} disabled={saving} data-testid="settings-save">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
