/**
 * UgSurchargeDialog — Pop-up «UG konfigurieren» (Personalbedarf-Seite).
 * ──────────────────────────────────────────────────────────────────────────────
 * Einstellbar:
 *  - UG-Automatik EIN/AUS (Tages-Flag «UG/Event offen» bleibt davon unberührt),
 *  - Saison-Zeitraum von–bis (jährlich, MM-TT — Jahr wird ignoriert; entspricht
 *    dem Aktivierungsbereich des Profils «Winter/UG»),
 *  - Wochentage (Checkboxen Mo–So; Vorgabe Fr+Sa),
 *  - Zuschlag-Positionen (+Anzahl), z.B. Bar unten +1, Service +2.
 *
 * Speichern schreibt die Profil-Konfiguration (app_settings) — wirkt sofort
 * auf effektiven Bedarf und alle Prüfungen. Abbrechen verwirft die Eingaben.
 */
import { useEffect, useMemo, useState } from 'react';
import { Settings2, Plus, Trash2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { WEEKDAYS } from '@/lib/staffing-requirements-utils';
import {
  isValidMonthDay,
  profileByKey,
  type StaffingProfilesConfig,
  type UgSurchargeEntry,
} from '@/lib/staffing-profiles-utils';
import type { Position } from '@/types/positions';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: StaffingProfilesConfig;
  positions: Position[];
  /** Persistiert die neue Konfiguration (wirft bei Fehler). */
  onSave: (next: StaffingProfilesConfig) => Promise<void>;
}

/** 'MM-TT' → Wert für <input type="date"> (Anzeige-Jahr 2026); '' bei null. */
const mmddToDate = (v: string | null): string => (v ? `2026-${v}` : '');
/** <input type="date">-Wert → 'MM-TT' (oder null bei leer/ungültig). */
const dateToMmdd = (v: string): string | null => {
  const mmdd = v ? v.slice(5) : '';
  return mmdd && isValidMonthDay(mmdd) ? mmdd : null;
};

export function UgSurchargeDialog({ open, onOpenChange, config, positions, onSave }: Props) {
  const winter = profileByKey(config, 'winter');

  const [enabled, setEnabled] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([5, 6]);
  const [entries, setEntries] = useState<UgSurchargeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Beim Öffnen: aktuellen Stand in den Dialog-State kopieren (Abbrechen = verwerfen).
  useEffect(() => {
    if (!open) return;
    setEnabled(config.ugSurcharge.enabled !== false);
    setFrom(mmddToDate(winter?.activeFrom ?? null));
    setTo(mmddToDate(winter?.activeTo ?? null));
    setWeekdays([...config.ugSurcharge.weekdays]);
    setEntries(config.ugSurcharge.entries.map((e) => ({ ...e })));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const positionName = (key: string) =>
    positions.find((p) => p.key === key)?.name ?? key;

  const availablePositions = useMemo(
    () => positions.filter((p) => p.active),
    [positions],
  );

  const toggleWeekday = (w: number, checked: boolean) => {
    setWeekdays((prev) => {
      const set = new Set(prev);
      if (checked) set.add(w); else set.delete(w);
      return [...set].sort((a, b) => a - b);
    });
  };

  const updateEntry = (idx: number, patch: Partial<UgSurchargeEntry>) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };

  const addEntry = () => {
    const used = new Set(entries.map((e) => e.positionKey));
    const free = availablePositions.find((p) => !used.has(p.key));
    setEntries((prev) => [...prev, { positionKey: free?.key ?? '', count: 1 }]);
  };

  const handleSave = async () => {
    setError(null);
    // Validierung: Positionen gewählt, keine Doppelten, Anzahl ≥ 1.
    const keys = entries.map((e) => e.positionKey);
    if (keys.some((k) => !k)) { setError('Bitte für jeden Zuschlag-Posten eine Position wählen.'); return; }
    if (new Set(keys).size !== keys.length) { setError('Jede Position darf nur einmal als Zuschlag-Posten vorkommen.'); return; }
    if (entries.some((e) => !Number.isInteger(e.count) || e.count < 1)) {
      setError('Die Anzahl je Posten muss mindestens 1 sein.'); return;
    }
    if (enabled && weekdays.length === 0 && entries.length > 0) {
      setError('Bitte mindestens einen Wochentag wählen (oder die Automatik ausschalten).'); return;
    }

    const next: StaffingProfilesConfig = {
      ...config,
      ugSurcharge: { enabled, entries: entries.map((e) => ({ ...e })), weekdays: [...weekdays] },
      profiles: config.profiles.map((p) =>
        p.key === 'winter'
          ? { ...p, activeFrom: dateToMmdd(from), activeTo: dateToMmdd(to) }
          : p,
      ),
    };
    setBusy(true);
    try {
      await onSave(next);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" /> UG-Zuschlag konfigurieren
          </DialogTitle>
          <DialogDescription>
            Innerhalb der Saison wird der Zuschlag an den gewählten Wochentagen automatisch
            zum Standard-Bedarf addiert (Profil «Winter/UG»). Der Tages-Flag «UG/Event offen»
            bleibt zusätzlich für einmalige Events ausserhalb der Saison.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Automatik EIN/AUS */}
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <p className="text-sm font-medium">UG aktivieren</p>
              <p className="text-[11px] text-muted-foreground">
                Automatischer Zuschlag in der Saison. Aus = nur noch per Tages-Flag.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="ug-enabled" />
          </div>

          {/* Saison-Zeitraum */}
          <div className="space-y-1.5">
            <Label className="text-xs">Saison-Zeitraum (jährlich, Jahr wird ignoriert)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="h-8 w-[10.5rem] text-sm" data-testid="ug-from" />
              <span className="text-xs text-muted-foreground">bis</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="h-8 w-[10.5rem] text-sm" data-testid="ug-to" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              z.B. 01.10.–28.02. — Zeiträume über den Jahreswechsel sind erlaubt.
              Ohne Zeitraum ist die Saison nie automatisch aktiv.
            </p>
          </div>

          {/* Wochentage */}
          <div className="space-y-1.5">
            <Label className="text-xs">Wochentage mit Zuschlag (Vorgabe Fr + Sa)</Label>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((w) => (
                <label key={w.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={weekdays.includes(w.value)}
                    onCheckedChange={(c) => toggleWeekday(w.value, c === true)}
                    data-testid={`ug-weekday-${w.value}`}
                  />
                  {w.short}
                </label>
              ))}
            </div>
          </div>

          {/* Zuschlag-Positionen */}
          <div className="space-y-1.5">
            <Label className="text-xs">Zuschlag-Positionen (+Personen am Abend)</Label>
            {entries.length === 0 && (
              <p className="text-xs italic text-muted-foreground">Kein Zuschlag-Posten konfiguriert.</p>
            )}
            <div className="space-y-2">
              {entries.map((e, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Select value={e.positionKey} onValueChange={(v) => updateEntry(idx, { positionKey: v })}>
                    <SelectTrigger className="h-8 flex-1 text-sm" data-testid={`ug-entry-pos-${idx}`}>
                      <SelectValue placeholder="Position wählen">
                        {e.positionKey ? positionName(e.positionKey) : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {availablePositions.map((p) => (
                        <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-sm text-muted-foreground">+</span>
                  <Input
                    type="number" min={1} step={1}
                    value={e.count}
                    onChange={(ev) => updateEntry(idx, { count: Math.max(1, Math.floor(Number(ev.target.value) || 1)) })}
                    className="h-8 w-[4.5rem] text-sm"
                    data-testid={`ug-entry-count-${idx}`}
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600"
                    onClick={() => setEntries((prev) => prev.filter((_, i) => i !== idx))}
                    title="Posten entfernen">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={addEntry}>
              <Plus className="h-3.5 w-3.5" /> Posten hinzufügen
            </Button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Abbrechen
          </Button>
          <Button onClick={handleSave} disabled={busy} data-testid="ug-save">
            {busy ? 'Speichert…' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
