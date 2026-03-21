import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Trash2, Plus, Settings, ChevronDown, ChevronRight,
  Eye, Tag, Clock, Split, HelpCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ShiftConfigItem } from '@/hooks/useShiftConfig';
import { usePermissions } from '@/hooks/usePermissions';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ShiftConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shifts: ShiftConfigItem[];
  onSave: (shifts: ShiftConfigItem[]) => void;
}

const COLOR_OPTIONS = [
  { name: 'Gelb', value: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700' },
  { name: 'Blau', value: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700' },
  { name: 'Lila', value: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-700' },
  { name: 'Indigo', value: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-700' },
  { name: 'Grün', value: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-300 dark:border-green-600' },
  { name: 'Grau', value: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500' },
  { name: 'Rot', value: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700' },
  { name: 'Türkis', value: 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700' },
  { name: 'Pink', value: 'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200 border-pink-300 dark:border-pink-700' },
  { name: 'Cyan', value: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700' },
  { name: 'Orange', value: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700' },
  { name: 'Limette', value: 'bg-lime-100 dark:bg-lime-900/40 text-lime-800 dark:text-lime-200 border-lime-300 dark:border-lime-700' },
];

function parseTimeToHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + (m || 0) / 60;
}

function calculateEffectiveHours(start: string, end: string, start2?: string, end2?: string): number {
  let gross = 0;
  if (start && end) {
    let s = parseTimeToHours(start);
    let e = parseTimeToHours(end);
    if (e < s) e += 24;
    gross += e - s;
  }
  if (start2 && end2) {
    let s2 = parseTimeToHours(start2);
    let e2 = parseTimeToHours(end2);
    if (e2 < s2) e2 += 24;
    gross += e2 - s2;
  }
  // Break rule: >9h → 30min deduction, ≤9h → no deduction
  const deduction = gross > 9 ? 0.5 : 0;
  return Math.round((gross - deduction) * 100) / 100;
}

function isAbsenceType(shift: ShiftConfigItem): boolean {
  return !shift.start && !shift.end;
}

function formatHours(h: number): string {
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(2).replace(/\.?0+$/, '')}h`;
}

// Inline preview badge — shows how the item looks in the legend
const PreviewBadge = ({ shift }: { shift: ShiftConfigItem }) => {
  const formatT = (t: string) => t.replace(':00', '');
  const isSplit = shift.start2 && shift.end2;
  const label = isAbsenceType(shift)
    ? (shift.abbrev || shift.name) + ' = ' + shift.name
    : shift.displayMode === 'code-in-cell' && shift.abbrev
      ? shift.abbrev
      : isSplit
        ? `${formatT(shift.start)}–${formatT(shift.end)} / ${formatT(shift.start2!)}–${formatT(shift.end2!)}`
        : shift.name;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Vorschau:</span>
      <span className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border",
        shift.color || COLOR_OPTIONS[0].value
      )}>
        {label}
        {!isAbsenceType(shift) && (
          <span className="opacity-70">({formatHours(shift.hours)})</span>
        )}
        {isAbsenceType(shift) && shift.hours > 0 && (
          <span className="opacity-70">({formatHours(shift.hours)})</span>
        )}
      </span>
    </div>
  );
};

// ── Main Dialog ──────────────────────────────────────────────────────────────
export const ShiftConfigDialog = ({
  open,
  onOpenChange,
  shifts,
  onSave,
}: ShiftConfigDialogProps) => {
  const { role } = usePermissions();
  const [localShifts, setLocalShifts] = useState<ShiftConfigItem[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setLocalShifts(shifts.map(s => ({ ...s })));
      setExpandedIndex(null);
    }
  }, [open, shifts]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const updateShift = (index: number, updates: Partial<ShiftConfigItem>) => {
    setLocalShifts(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };

      // Auto-calculate hours when times change
      const s = next[index];
      if (
        updates.start !== undefined ||
        updates.end !== undefined ||
        updates.start2 !== undefined ||
        updates.end2 !== undefined
      ) {
        if (s.start && s.end && !s.fixedHours) {
          next[index].hours = calculateEffectiveHours(s.start, s.end, s.start2, s.end2);
        }
      }
      return next;
    });
  };

  const addWorkShift = () => {
    const newShift: ShiftConfigItem = {
      name: `Schicht ${localShifts.length + 1}`,
      start: '09:00',
      end: '17:00',
      hours: 7,
      color: COLOR_OPTIONS[localShifts.length % COLOR_OPTIONS.length].value,
      isPaid: true,
      countsToTarget: true,
      abbrev: '',
      excelColor: 'FFFFFFFF',
      textColor: 'FF000000',
    };
    setLocalShifts(prev => [...prev, newShift]);
    setExpandedIndex(localShifts.length);
  };

  const addAbsenceCode = () => {
    const newShift: ShiftConfigItem = {
      name: 'Neuer Code',
      start: '',
      end: '',
      hours: 8.4,
      color: COLOR_OPTIONS[(localShifts.length + 3) % COLOR_OPTIONS.length].value,
      isPaid: false,
      countsToTarget: true,
      abbrev: 'NC',
      excelColor: 'FFFFFFFF',
      textColor: 'FF000000',
    };
    setLocalShifts(prev => [...prev, newShift]);
    setExpandedIndex(localShifts.length);
  };

  const deleteShift = (index: number) => {
    if (localShifts.length <= 1) {
      toast.error('Mindestens ein Eintrag muss vorhanden sein');
      return;
    }
    setLocalShifts(prev => prev.filter((_, i) => i !== index));
    setExpandedIndex(null);
  };

  const handleSave = () => {
    const invalid = localShifts.find(s => !s.name.trim());
    if (invalid) {
      toast.error('Alle Einträge brauchen einen Namen');
      return;
    }
    const names = localShifts.map(s => s.name.trim().toLowerCase());
    if (names.length !== new Set(names).size) {
      toast.error('Namen müssen eindeutig sein');
      return;
    }
    const abbrevs = localShifts.map(s => s.abbrev?.trim()).filter(Boolean);
    if (abbrevs.length !== new Set(abbrevs).size) {
      toast.error('Kürzel müssen eindeutig sein');
      return;
    }

    // ── Logging: detect creates vs updates ──────────────────────────────────
    const existingNames = new Set(shifts.map(s => s.name.trim().toLowerCase()));
    const created = localShifts.filter(s => !existingNames.has(s.name.trim().toLowerCase()));
    const updated = localShifts.filter(s => existingNames.has(s.name.trim().toLowerCase()) && (() => {
      const orig = shifts.find(o => o.name.trim().toLowerCase() === s.name.trim().toLowerCase());
      return orig && JSON.stringify(orig) !== JSON.stringify(s);
    })());
    if (created.length > 0) {
      console.log(`[Schichten] ERSTELLT von ${role}:`, created.map(s => `${s.name} (${s.abbrev || '–'})`).join(', '));
    }
    if (updated.length > 0) {
      console.log(`[Schichten] AKTUALISIERT von ${role}:`, updated.map(s => `${s.name} (${s.abbrev || '–'})`).join(', '));
    }
    if (created.length === 0 && updated.length === 0) {
      console.log(`[Schichten] Gespeichert von ${role}: keine inhaltlichen Änderungen (${localShifts.length} Einträge)`);
    }
    // ────────────────────────────────────────────────────────────────────────

    onSave(localShifts);
    onOpenChange(false);
    toast.success('Legende gespeichert und synchronisiert');
  };

  // Separate work shifts and absence codes for display
  const workShiftIndices = localShifts.map((s, i) => !isAbsenceType(s) ? i : -1).filter(i => i >= 0);
  const absenceIndices = localShifts.map((s, i) => isAbsenceType(s) ? i : -1).filter(i => i >= 0);

  const renderShiftRow = (index: number) => {
    const shift = localShifts[index];
    const isExpanded = expandedIndex === index;
    const absence = isAbsenceType(shift);
    const isSplit = !absence && !!shift.start2 && !!shift.end2;

    return (
      <div
        key={index}
        className={cn(
          "border rounded-lg overflow-hidden transition-all",
          isExpanded && "ring-2 ring-primary"
        )}
      >
        {/* Header row */}
        <div className="flex items-center gap-3 p-3">
          <div className={cn("w-5 h-5 rounded-full border flex-shrink-0 flex items-center justify-center text-[9px] font-bold", shift.color)}>
            {shift.abbrev ? shift.abbrev.slice(0, 2) : '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm truncate">{shift.name || <span className="text-muted-foreground italic">Kein Name</span>}</div>
            <div className="text-[10px] text-muted-foreground truncate">
              {absence
                ? `Abwesenheitscode · ${formatHours(shift.hours)} · ${shift.isPaid ? 'Bezahlt' : 'Unbezahlt'}`
                : isSplit
                  ? `Split: ${shift.start}–${shift.end} / ${shift.start2}–${shift.end2} · ${formatHours(shift.hours)}`
                  : shift.start && shift.end
                    ? `${shift.start}–${shift.end} · ${formatHours(shift.hours)}`
                    : `Fixe Stunden: ${formatHours(shift.hours)}`}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={() => setExpandedIndex(isExpanded ? null : index)}
          >
            {isExpanded ? (
              <><ChevronDown className="h-3 w-3 mr-1" />Schließen</>
            ) : (
              <><ChevronRight className="h-3 w-3 mr-1" />Bearbeiten</>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
            onClick={() => deleteShift(index)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Expanded edit form */}
        {isExpanded && (
          <div className="px-4 pb-4 pt-3 border-t space-y-4 bg-muted/20">

            {/* Live preview */}
            <PreviewBadge shift={shift} />

            {/* Name + Abbreviation */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Name
                  <span className="text-muted-foreground ml-1">(erscheint in der Legende)</span>
                </Label>
                <Input
                  value={shift.name}
                  onChange={e => updateShift(index, { name: e.target.value })}
                  placeholder="z.B. Ferien, Anlass, Früh"
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  Kürzel / Code
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="text-xs max-w-[200px]">
                        Wird in der Zelle und der Legende angezeigt. Z.B. "A" für Anlass, "FE" für Ferien.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Input
                  value={shift.abbrev || ''}
                  onChange={e => updateShift(index, { abbrev: e.target.value.toUpperCase() })}
                  placeholder={absence ? 'z.B. A, FE, K' : 'z.B. FR, SP'}
                  maxLength={4}
                  className="h-8 text-sm font-mono"
                />
              </div>
            </div>

            {/* Times section — only for work shifts */}
            {!absence ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Arbeitszeiten</Label>
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline flex items-center gap-1"
                    onClick={() => {
                      if (isSplit) {
                        updateShift(index, { start2: '', end2: '' });
                      } else {
                        updateShift(index, { start2: '17:00', end2: '23:00' });
                      }
                    }}
                  >
                    <Split className="h-3 w-3" />
                    {isSplit ? 'Geteilte Schicht entfernen' : 'Geteilte Schicht hinzufügen'}
                  </button>
                </div>
                <div className={cn("grid gap-2", isSplit ? "grid-cols-4" : "grid-cols-2")}>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{isSplit ? '1. Beginn' : 'Beginn'}</Label>
                    <Input
                      type="time"
                      value={shift.start}
                      onChange={e => updateShift(index, { start: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{isSplit ? '1. Ende' : 'Ende'}</Label>
                    <Input
                      type="time"
                      value={shift.end}
                      onChange={e => updateShift(index, { end: e.target.value })}
                      className="h-8 text-sm"
                    />
                  </div>
                  {isSplit && (
                    <>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">2. Beginn</Label>
                        <Input
                          type="time"
                          value={shift.start2 || ''}
                          onChange={e => updateShift(index, { start2: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">2. Ende</Label>
                        <Input
                          type="time"
                          value={shift.end2 || ''}
                          onChange={e => updateShift(index, { end2: e.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {/* Hours */}
            <div className="grid grid-cols-2 gap-3 items-start">
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1">
                  Effektive Stunden
                  {!absence && (
                    <span className="text-muted-foreground">(nach Pausen)</span>
                  )}
                </Label>
                <Input
                  type="number"
                  step="0.25"
                  min="0"
                  value={shift.hours}
                  onChange={e => updateShift(index, { hours: parseFloat(e.target.value) || 0, fixedHours: true })}
                  className="h-8 text-sm"
                />
              </div>
              {!absence && (
                <div className="flex items-center gap-2 mt-6">
                  <Switch
                    checked={!!shift.fixedHours}
                    onCheckedChange={checked => {
                      if (!checked && shift.start && shift.end) {
                        updateShift(index, {
                          fixedHours: false,
                          hours: calculateEffectiveHours(shift.start, shift.end, shift.start2, shift.end2),
                        });
                      } else {
                        updateShift(index, { fixedHours: checked });
                      }
                    }}
                  />
                  <Label className="text-xs">Stunden manuell festlegen</Label>
                </div>
              )}
            </div>

            {/* Color */}
            <div className="space-y-1.5">
              <Label className="text-xs">Farbe</Label>
              <div className="flex flex-wrap gap-2">
                {COLOR_OPTIONS.map(color => (
                  <button
                    key={color.name}
                    type="button"
                    title={color.name}
                    className={cn(
                      "w-7 h-7 rounded-full border-2 transition-all",
                      color.value,
                      shift.color === color.value
                        ? "ring-2 ring-primary ring-offset-2 scale-110"
                        : "hover:scale-105"
                    )}
                    onClick={() => updateShift(index, { color: color.value })}
                  />
                ))}
              </div>
            </div>

            {/* Department */}
            <div className="space-y-1.5">
              <Label className="text-xs">Abteilung</Label>
              <div className="flex gap-2">
                {(['all', 'service', 'küche'] as const).map(dept => (
                  <button
                    key={dept}
                    type="button"
                    onClick={() => updateShift(index, { department: dept })}
                    className={cn(
                      "px-3 py-1 rounded-md border text-xs font-medium transition-all",
                      (shift.department || 'all') === dept
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border hover:bg-muted"
                    )}
                  >
                    {dept === 'all' ? 'Alle' : dept === 'service' ? 'Service' : 'Küche'}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles row */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!shift.isPaid}
                  onCheckedChange={checked => updateShift(index, { isPaid: checked })}
                />
                <Label className="text-xs">Bezahlt</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!shift.countsToTarget}
                  onCheckedChange={checked => updateShift(index, { countsToTarget: checked })}
                />
                <Label className="text-xs">Zählt zu Soll</Label>
              </div>
              {!absence && (
                <div className="flex items-center gap-2">
                  <Switch
                    checked={shift.displayMode === 'code-in-cell'}
                    onCheckedChange={checked =>
                      updateShift(index, { displayMode: checked ? 'code-in-cell' : 'default' })
                    }
                  />
                  <Label className="text-xs flex items-center gap-1">
                    Code in Zelle
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="text-xs max-w-[200px]">
                          Zeigt in der Planungszelle nur das Kürzel (z.B. "FR") statt der vollen Uhrzeit (z.B. "11–15").
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Label>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Switch
                  checked={shift.showInQuickSelect !== false}
                  onCheckedChange={checked =>
                    updateShift(index, { showInQuickSelect: checked ? undefined : false })
                  }
                />
                <Label className="text-xs flex items-center gap-1">
                  In Schnellzuweisung
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent className="text-xs max-w-[220px]">
                        Wenn deaktiviert, erscheint dieser Eintrag nicht in der Legenden-Leiste. Er bleibt im System gespeichert und kann weiterhin über Excel-Import oder manuell verwendet werden.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Legende verwalten
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Hier kannst du Schichten und Abwesenheitscodes anlegen, bearbeiten und löschen. Änderungen werden sofort in Supabase gespeichert.
          </p>
        </DialogHeader>

        <div className="space-y-6 my-2">

          {/* ── Arbeitschichten ─────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Arbeitsschichten</h3>
                <span className="text-xs text-muted-foreground">({workShiftIndices.length})</span>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={addWorkShift}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Neue Schicht
              </Button>
            </div>
            {workShiftIndices.length === 0 && (
              <p className="text-xs text-muted-foreground italic text-center py-4 border rounded-lg border-dashed">
                Noch keine Arbeitsschichten. Klicke auf «Neue Schicht».
              </p>
            )}
            {workShiftIndices.map(i => renderShiftRow(i))}
          </div>

          {/* ── Abwesenheitscodes ──────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Abwesenheitscodes</h3>
                <span className="text-xs text-muted-foreground">({absenceIndices.length})</span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="text-xs max-w-xs">
                      Abwesenheitscodes haben keine Uhrzeit. Sie werden in der Planungszelle als Kürzel angezeigt (z.B. "FE", "K", "A"). Sie werden mit dem Pinsel-Modus auf Mitarbeiter angewendet.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={addAbsenceCode}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Neuer Code
              </Button>
            </div>
            {absenceIndices.length === 0 && (
              <p className="text-xs text-muted-foreground italic text-center py-4 border rounded-lg border-dashed">
                Noch keine Abwesenheitscodes.
              </p>
            )}
            {absenceIndices.map(i => renderShiftRow(i))}
          </div>

        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleSave}>
            Speichern &amp; Synchronisieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
