import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { PenLine, Plus, Trash2, AlertTriangle, Lock } from 'lucide-react';
import { saveManualDayCorrection } from '@/lib/supabase-db';
import type { HourBlockEntry } from '@/lib/supabase-db';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface EditBlock {
  tempId:         string;
  start_time:     string;   // HH:MM
  end_time:       string;   // HH:MM
  duration_hours: number;
}

interface Props {
  open:          boolean;
  onClose:       () => void;
  employeeId:    string;
  employeeName:  string;
  date:          string;      // YYYY-MM-DD
  year:          number;
  month:         number;
  currentHours:  number | null;
  currentBlocks: HourBlockEntry[];
  changedBy:     string | null;
  onSaved:       () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_DE = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

function fmtDateLong(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAY_DE[d.getDay()]}, ${d.getDate()}. ${MONTH_NAMES_DE[d.getMonth()]} ${d.getFullYear()}`;
}

function toMinutes(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function computeDuration(start: string, end: string): number {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (e <= s) return 0;
  return Math.round((e - s) / 60 * 100) / 100;
}

function nextTempId(): string {
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isValidTime(t: string): boolean {
  return /^\d{2}:\d{2}$/.test(t);
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function ManualCorrectionSheet({
  open, onClose,
  employeeId, employeeName, date, year, month,
  currentHours, currentBlocks, changedBy,
  onSaved,
}: Props) {
  const [editBlocks, setEditBlocks] = useState<EditBlock[]>([]);
  const [totalHours, setTotalHours] = useState('');
  const [reason, setReason]         = useState('');
  const [saving, setSaving]         = useState(false);

  // Initialisieren wenn geöffnet
  useEffect(() => {
    if (!open) return;
    setEditBlocks(
      currentBlocks
        .filter(b => b.start_time && b.end_time)
        .sort((a, b) => a.start_time.localeCompare(b.start_time))
        .map(b => ({
          tempId:         nextTempId(),
          start_time:     b.start_time.slice(0, 5),
          end_time:       b.end_time.slice(0, 5),
          duration_hours: b.duration_hours,
        }))
    );
    setTotalHours(currentHours != null ? String(currentHours) : '');
    setReason('');
  }, [open, currentBlocks, currentHours]);

  // Auto-berechne Gesamtstunden aus Blöcken
  const blockSum = editBlocks.reduce((s, b) => {
    const d = isValidTime(b.start_time) && isValidTime(b.end_time)
      ? computeDuration(b.start_time, b.end_time) : 0;
    return s + d;
  }, 0);

  function updateBlock(tempId: string, field: 'start_time' | 'end_time', value: string) {
    setEditBlocks(prev => prev.map(b => {
      if (b.tempId !== tempId) return b;
      const updated = { ...b, [field]: value };
      if (isValidTime(updated.start_time) && isValidTime(updated.end_time)) {
        updated.duration_hours = computeDuration(updated.start_time, updated.end_time);
      }
      return updated;
    }));
  }

  function addBlock() {
    setEditBlocks(prev => [...prev, {
      tempId:         nextTempId(),
      start_time:     '08:00',
      end_time:       '16:00',
      duration_hours: 8,
    }]);
  }

  function removeBlock(tempId: string) {
    setEditBlocks(prev => prev.filter(b => b.tempId !== tempId));
  }

  const canSave = reason.trim().length >= 3 && !saving;

  async function handleSave() {
    if (!canSave) return;

    // Validierung
    const invalidBlock = editBlocks.find(
      b => !isValidTime(b.start_time) || !isValidTime(b.end_time) || computeDuration(b.start_time, b.end_time) <= 0
    );
    if (invalidBlock) {
      toast.error('Ungültige Zeitblöcke — bitte Start- und Endzeiten prüfen.');
      return;
    }

    const newHours = parseFloat(totalHours);
    const effectiveHours = !isNaN(newHours) ? newHours : Math.round(blockSum * 100) / 100;

    if (effectiveHours <= 0 && editBlocks.length === 0) {
      toast.error('Bitte entweder Stunden oder mindestens einen Zeitblock eingeben.');
      return;
    }

    setSaving(true);
    try {
      const result = await saveManualDayCorrection({
        employeeId,
        date,
        year,
        month,
        newHours:   effectiveHours,
        newBlocks:  editBlocks.map(b => ({
          start_time:     b.start_time,
          end_time:       b.end_time,
          duration_hours: b.duration_hours,
        })),
        reason: reason.trim(),
        changedBy,
        oldHours:  currentHours,
        oldBlocks: currentBlocks,
      });

      if (!result.ok) {
        toast.error(`Fehler beim Speichern: ${result.error}`);
        return;
      }

      toast.success('Manuelle Korrektur gespeichert und protokolliert.');
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0 gap-0">

        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 bg-card">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <PenLine className="h-4 w-4 text-primary shrink-0" />
            Manuelle Korrektur
          </SheetTitle>
          <div className="mt-1">
            <p className="text-sm font-semibold">{employeeName}</p>
            <p className="text-xs text-muted-foreground">{fmtDateLong(date)}</p>
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 rounded px-2 py-1">
            <Lock className="h-3 w-3 shrink-0" />
            Manuell geänderte Tage sind vor Re-Import geschützt.
          </div>
        </SheetHeader>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">

          {/* AZB Tagesstunden */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">
              AZB Tagesstunden
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.25"
                min="0"
                max="24"
                value={totalHours}
                onChange={e => setTotalHours(e.target.value)}
                placeholder={blockSum > 0 ? `${blockSum.toFixed(2)} (auto)` : '0.00'}
                className="w-32 border border-border rounded-md px-3 py-1.5 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary tabular-nums"
              />
              {blockSum > 0 && totalHours === '' && (
                <span className="text-xs text-muted-foreground">
                  Automatisch aus Blöcken: <strong>{blockSum.toFixed(2)} h</strong>
                </span>
              )}
              {blockSum > 0 && totalHours !== '' && Math.abs(parseFloat(totalHours) - blockSum) > 0.01 && (
                <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  Abweichung von Blocksumme ({blockSum.toFixed(2)} h)
                </span>
              )}
            </div>
          </div>

          {/* Zeitblöcke */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-foreground">Zeitblöcke</label>
              <button
                onClick={addBlock}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-medium"
              >
                <Plus className="h-3.5 w-3.5" />Block hinzufügen
              </button>
            </div>

            {editBlocks.length === 0 ? (
              <div className="border border-dashed border-border rounded-lg p-4 text-center text-xs text-muted-foreground">
                Keine Zeitblöcke — nur Tagesstunden werden gespeichert.
              </div>
            ) : (
              <div className="space-y-2">
                {editBlocks.map((b, i) => {
                  const dur = isValidTime(b.start_time) && isValidTime(b.end_time)
                    ? computeDuration(b.start_time, b.end_time) : null;
                  const invalid = dur != null && dur <= 0;
                  return (
                    <div
                      key={b.tempId}
                      className={cn(
                        'flex items-center gap-2 border rounded-lg px-3 py-2',
                        invalid ? 'border-red-300 dark:border-red-700 bg-red-50/30 dark:bg-red-950/10' : 'border-border bg-card'
                      )}
                    >
                      <span className="text-[10px] text-muted-foreground w-4 shrink-0 font-medium">{i + 1}</span>
                      <input
                        type="time"
                        value={b.start_time}
                        onChange={e => updateBlock(b.tempId, 'start_time', e.target.value)}
                        className="border border-border rounded px-2 py-1 text-xs font-mono bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-24"
                      />
                      <span className="text-muted-foreground text-xs">–</span>
                      <input
                        type="time"
                        value={b.end_time}
                        onChange={e => updateBlock(b.tempId, 'end_time', e.target.value)}
                        className="border border-border rounded px-2 py-1 text-xs font-mono bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary w-24"
                      />
                      <span className={cn('text-xs tabular-nums ml-1 min-w-[50px]', invalid ? 'text-red-500' : 'text-muted-foreground')}>
                        {dur != null ? (invalid ? '!' : `${(dur * 60).toFixed(0)} min`) : '–'}
                      </span>
                      <button
                        onClick={() => removeBlock(b.tempId)}
                        className="ml-auto text-muted-foreground hover:text-red-500 transition-colors shrink-0"
                        title="Block löschen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Korrekturgrund (Pflichtfeld) */}
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">
              Korrekturgrund <span className="text-red-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Pflichtfeld — z.B. «Zeitstempel fehlerha nach Systemausfall, manuelle Übernahme aus Papierzettel»"
              rows={3}
              className={cn(
                'w-full border rounded-lg px-3 py-2 text-sm bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 resize-none',
                reason.trim().length < 3 && reason.length > 0
                  ? 'border-red-300 dark:border-red-700 focus:ring-red-400'
                  : 'border-border focus:ring-primary',
              )}
            />
            {reason.length > 0 && reason.trim().length < 3 && (
              <p className="text-[11px] text-red-500 mt-1">Bitte einen aussagekräftigen Grund eingeben (min. 3 Zeichen).</p>
            )}
            {reason.trim().length === 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">Ohne Korrekturgrund kann nicht gespeichert werden.</p>
            )}
          </div>

          {/* Vorher/Nachher-Übersicht */}
          {(currentHours != null || currentBlocks.length > 0) && (
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs space-y-1">
              <p className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px] mb-1.5">Aktueller Stand (vor Korrektur)</p>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tagesstunden:</span>
                <span className="font-mono">{currentHours != null ? `${currentHours} h` : '–'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Zeitblöcke:</span>
                <span className="font-mono">{currentBlocks.length} Block{currentBlocks.length !== 1 ? 'e' : ''}</span>
              </div>
              {currentBlocks.map(b => (
                <div key={b.id} className="flex justify-between pl-3 text-muted-foreground/70">
                  <span>{b.start_time.slice(0, 5)}–{b.end_time.slice(0, 5)}</span>
                  <span>{(b.duration_hours * 60).toFixed(0)} min</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between gap-3 shrink-0 bg-card">
          <button
            onClick={() => { if (!saving) onClose(); }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Abbrechen
          </button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
            className="gap-1.5"
            size="sm"
          >
            <Lock className="h-3.5 w-3.5" />
            {saving ? 'Speichern…' : 'Speichern & sperren'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
