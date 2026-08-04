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
import { Settings2, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
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
  cdsRuleForSeason,
  isValidMonthDay,
  profileByKey,
  type CdsGastgeberRule,
  type StaffingProfilesConfig,
  type UgSurchargeEntry,
} from '@/lib/staffing-profiles-utils';
import type { Position } from '@/types/positions';
import type { Employee } from '@/types/personnel';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: StaffingProfilesConfig;
  positions: Position[];
  /** Mitarbeitende für die CdS-Prioritätenliste (Auswahl per Name). */
  employees?: Employee[];
  /** Persistiert die neue Konfiguration (wirft bei Fehler). */
  onSave: (next: StaffingProfilesConfig) => Promise<void>;
}

/** Die beiden im Dialog konfigurierbaren Regel-Profile. */
const RULE_SEASONS = [
  { key: 'standard', label: 'Standard' },
  { key: 'winter', label: 'Winter/UG' },
] as const;
type RuleSeasonKey = typeof RULE_SEASONS[number]['key'];

/** 'MM-TT' → Wert für <input type="date"> (Anzeige-Jahr 2026); '' bei null. */
const mmddToDate = (v: string | null): string => (v ? `2026-${v}` : '');
/** <input type="date">-Wert → 'MM-TT' (oder null bei leer/ungültig). */
const dateToMmdd = (v: string): string | null => {
  const mmdd = v ? v.slice(5) : '';
  return mmdd && isValidMonthDay(mmdd) ? mmdd : null;
};

export function UgSurchargeDialog({ open, onOpenChange, config, positions, employees = [], onSave }: Props) {
  const winter = profileByKey(config, 'winter');

  const [enabled, setEnabled] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([5, 6]);
  const [entries, setEntries] = useState<UgSurchargeEntry[]>([]);
  // CdS-/Gastgeber-Regel — PRO Profil getrennt bearbeitbar.
  const [ruleSeason, setRuleSeason] = useState<RuleSeasonKey>('standard');
  const [rules, setRules] = useState<Record<RuleSeasonKey, CdsGastgeberRule>>({
    standard: { cdsPriority: [], gastgeberWeekdays: [4, 5, 6], gastgeberRequiresFirstPlanned: true },
    winter: { cdsPriority: [], gastgeberWeekdays: [4, 5, 6], gastgeberRequiresFirstPlanned: true },
  });
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
    setRuleSeason('standard');
    setRules({
      standard: cdsRuleForSeason(config, 'standard'),
      winter: cdsRuleForSeason(config, 'winter'),
    });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rule = rules[ruleSeason];
  const patchRule = (patch: Partial<CdsGastgeberRule>) =>
    setRules((prev) => ({ ...prev, [ruleSeason]: { ...prev[ruleSeason], ...patch } }));

  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive !== false).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [employees],
  );
  const movePriority = (idx: number, dir: -1 | 1) =>
    patchRule({
      cdsPriority: (() => {
        const next = [...rule.cdsPriority];
        const j = idx + dir;
        if (j < 0 || j >= next.length) return next;
        [next[idx], next[j]] = [next[j], next[idx]];
        return next;
      })(),
    });
  const toggleGastgeberWeekday = (w: number, checked: boolean) => {
    const set = new Set(rule.gastgeberWeekdays);
    if (checked) set.add(w); else set.delete(w);
    patchRule({ gastgeberWeekdays: [...set].sort((a, b) => a - b) });
  };

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

    if (rules.standard.cdsPriority.some((id) => !id) || rules.winter.cdsPriority.some((id) => !id)) {
      setError('Bitte für jeden Prioritäts-Platz eine Person wählen (oder den Platz entfernen).'); return;
    }
    const dedup = (ids: string[]) => [...new Set(ids)];
    const cleanRule = (r: CdsGastgeberRule): CdsGastgeberRule => ({
      cdsPriority: dedup(r.cdsPriority.filter(Boolean)),
      gastgeberWeekdays: [...r.gastgeberWeekdays].sort((a, b) => a - b),
      gastgeberRequiresFirstPlanned: r.gastgeberRequiresFirstPlanned,
    });
    const stdRule = cleanRule(rules.standard);
    const next: StaffingProfilesConfig = {
      ...config,
      ugSurcharge: { enabled, entries: entries.map((e) => ({ ...e })), weekdays: [...weekdays] },
      profiles: config.profiles.map((p) =>
        p.key === 'winter'
          ? { ...p, activeFrom: dateToMmdd(from), activeTo: dateToMmdd(to) }
          : p,
      ),
      // Regel PRO Profil speichern; globale Basis = Standard-Regel (Rückwärts-
      // Kompatibilität für alte Leser).
      cdsRuleBySeason: {
        ...config.cdsRuleBySeason,
        standard: stdRule,
        winter: cleanRule(rules.winter),
      },
      cdsPriority: [...stdRule.cdsPriority],
      gastgeberWeekdays: [...stdRule.gastgeberWeekdays],
      gastgeberRequiresFirstPlanned: stdRule.gastgeberRequiresFirstPlanned,
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
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
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

          {/* CdS-Prioritätenliste / Gastgeber-GF-Regel (pro Profil) */}
          <div className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">CdS-Prioritätenliste / Gastgeber-GF-Regel</p>
                <p className="text-[11px] text-muted-foreground">
                  Höchste geplante Priorität = Chef de Service. Regel = Standard; manuelle
                  Zellen-Einträge im Bedarf sind nur Einzel-Ausnahmen.
                </p>
              </div>
              <Select value={ruleSeason} onValueChange={(v) => setRuleSeason(v as RuleSeasonKey)}>
                <SelectTrigger className="h-8 w-[9rem] text-sm" data-testid="cds-rule-season">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_SEASONS.map((s) => (
                    <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Prioritätsreihenfolge */}
            <div className="space-y-1.5">
              <Label className="text-xs">Prioritätsreihenfolge (1 = erste Priorität)</Label>
              {rule.cdsPriority.length === 0 && (
                <p className="text-xs italic text-muted-foreground">Keine Priorität konfiguriert — Regel inaktiv.</p>
              )}
              <div className="space-y-1.5">
                {rule.cdsPriority.map((id, idx) => (
                  <div key={`${id}-${idx}`} className="flex items-center gap-1.5">
                    <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">{idx + 1}.</span>
                    <Select
                      value={id || undefined}
                      onValueChange={(v) => patchRule({ cdsPriority: rule.cdsPriority.map((x, i) => (i === idx ? v : x)) })}
                    >
                      <SelectTrigger className="h-8 flex-1 text-sm" data-testid={`cds-prio-${idx}`}>
                        <SelectValue placeholder="Person wählen">{id ? employeeName(id) : undefined}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {activeEmployees.map((e) => (
                          <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                        ))}
                        {id && !activeEmployees.some((e) => e.id === id) && (
                          <SelectItem value={id}>{employeeName(id)}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    <Button size="icon" variant="ghost" className="h-8 w-7" disabled={idx === 0}
                      onClick={() => movePriority(idx, -1)} title="Nach oben">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-7" disabled={idx === rule.cdsPriority.length - 1}
                      onClick={() => movePriority(idx, 1)} title="Nach unten">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-7 text-red-600"
                      onClick={() => patchRule({ cdsPriority: rule.cdsPriority.filter((_, i) => i !== idx) })}
                      title="Priorität entfernen">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                onClick={() => patchRule({ cdsPriority: [...rule.cdsPriority, ''] })}
                data-testid="cds-prio-add">
                <Plus className="h-3.5 w-3.5" /> Priorität hinzufügen
              </Button>
            </div>

            {/* Gastgeber-Wochentage */}
            <div className="space-y-1.5">
              <Label className="text-xs">Gastgeber/GF greift an diesen Wochentagen (Vorgabe Do–Sa)</Label>
              <div className="flex flex-wrap gap-3">
                {WEEKDAYS.map((w) => (
                  <label key={w.value} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={rule.gastgeberWeekdays.includes(w.value)}
                      onCheckedChange={(c) => toggleGastgeberWeekday(w.value, c === true)}
                      data-testid={`gastgeber-weekday-${w.value}`}
                    />
                    {w.short}
                  </label>
                ))}
              </div>
            </div>

            {/* Bedingung */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                Bedingung: Zweite Priorität wird nur Gastgeber/GF, wenn die ERSTE Priorität
                als CdS geplant ist. Aus = zweite Priorität wird Gastgeber/GF, sobald sie
                geplant und nicht selbst CdS ist.
              </p>
              <Switch
                checked={rule.gastgeberRequiresFirstPlanned}
                onCheckedChange={(c) => patchRule({ gastgeberRequiresFirstPlanned: c === true })}
                data-testid="gastgeber-require-first"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Änderungen wirken sofort über ALLE Wochen (Wochen-/Tages-Totale und
              «Plan vs. Bedarf»); Profil «{RULE_SEASONS.find((s) => s.key === ruleSeason)?.label}».
            </p>
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
