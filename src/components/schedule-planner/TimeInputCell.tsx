import { useState, useEffect, useRef, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { useQuickTimes, QuickTimePreset, DEFAULT_QUICK_PRESETS } from '@/hooks/useQuickTimes';
import {
  Clock, Settings2, Plus, Trash2,
  ChevronUp, ChevronDown, RotateCcw, Check, X, Pencil,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimeSlot {
  start: string;
  end: string;
  secondary?: { start: string; end: string } | null;
}

interface TimeInputCellProps {
  value: TimeSlot | null;
  absenceType?: string | null;
  onChange: (value: TimeSlot | null, absenceType?: string | null) => void;
  slotType: 'früh' | 'spät';
  /** Value of the OTHER slot (früh ↔ spät) for stacked cell display */
  secondaryValue?: TimeSlot | null;
  isWeekend?: boolean;
  isDayOff?: boolean;
  isRequestedFree?: boolean;
  isBlocked?: boolean;
  department?: 'service' | 'küche' | 'all';
  activeTool?: string | null;
  copiedShift?: TimeSlot | null;
  onCopyShift?: (slot: TimeSlot) => void;
  cellColor?: string | null;
  onCellColorChange?: (color: string | null) => void;
  onCopyToIst?: (slot: TimeSlot) => void;
  /** Called when user sets a 2nd shift — writes into the OTHER slot (null = clear it) */
  onSplitTimeSelect?: (secondary: TimeSlot | null) => void;
  /** Called when the primary "Löschen" should also clear the secondary slot */
  onClearSecondary?: () => void;
  /** Fixlohn-MA (Vollzeit/Teilzeit mit Monatslohn): zeigt Zusatzkosten-Checkbox */
  isFixedEmployee?: boolean;
  isAdditionalCostPlan?: boolean;
  onAdditionalCostPlanChange?: (v: boolean) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CELL_COLORS: { hex: string; label: string }[] = [
  { hex: '#FCD34D', label: 'Gelb' },
  { hex: '#4ADE80', label: 'Grün' },
  { hex: '#60A5FA', label: 'Blau' },
  { hex: '#FB923C', label: 'Orange' },
  { hex: '#F87171', label: 'Rot' },
  { hex: '#C4B5FD', label: 'Violett' },
  { hex: '#9CA3AF', label: 'Grau' },
];

// ---------------------------------------------------------------------------
// Time utilities
// ---------------------------------------------------------------------------

function generateTimeOptions(): string[] {
  const slots: string[] = [];
  for (let h = 6; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  for (let h = 0; h <= 2; h++) {
    for (const m of [0, 15, 30, 45]) {
      if (h === 2 && m > 0) break;
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}

function timeToOrdinal(t: string): number {
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m;
  return total < 360 ? total + 1440 : total;
}

const TIME_OPTIONS = generateTimeOptions();

function parseTimeStr(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let h: number, m: number;
  if (s.includes(':')) {
    const parts = s.split(':');
    h = parseInt(parts[0], 10);
    m = parseInt(parts[1], 10);
  } else {
    h = parseInt(s, 10);
    m = 0;
  }
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function rangesOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  let a = toMin(s1), b = toMin(e1);
  let c = toMin(s2), d = toMin(e2);
  if (b <= a) b += 1440;
  if (d <= c) d += 1440;
  return a < d && c < b;
}

function formatShort(t: string): string {
  return t.replace(':00', '');
}

// ---------------------------------------------------------------------------
// QuickTimesEditorDialog
// ---------------------------------------------------------------------------

interface EditorRowState {
  label: string;
  start: string;
  end: string;
  start2: string;
  end2: string;
}

function makeRowState(p: QuickTimePreset): EditorRowState {
  return {
    label: p.label,
    start: p.start,
    end: p.end,
    start2: p.start2 || '',
    end2: p.end2 || '',
  };
}

interface QuickTimesEditorDialogProps {
  open: boolean;
  onClose: () => void;
  presets: QuickTimePreset[];
  onAdd: (preset: Omit<QuickTimePreset, 'id'>) => void;
  onUpdate: (id: string, changes: Partial<Omit<QuickTimePreset, 'id'>>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, dir: 'up' | 'down') => void;
  onReset: () => void;
}

function QuickTimesEditorDialog({
  open, onClose, presets,
  onAdd, onUpdate, onDelete, onMove, onReset,
}: QuickTimesEditorDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<EditorRowState>({ label: '', start: '10:00', end: '14:00', start2: '', end2: '' });
  const [addingNew, setAddingNew] = useState(false);
  const [newRow, setNewRow] = useState<EditorRowState>({ label: '', start: '10:00', end: '14:00', start2: '', end2: '' });
  const [editHasSecond, setEditHasSecond] = useState(false);
  const [newHasSecond, setNewHasSecond] = useState(false);

  const startEdit = (p: QuickTimePreset) => {
    setEditingId(p.id);
    setEditRow(makeRowState(p));
    setEditHasSecond(!!(p.start2 && p.end2));
    setAddingNew(false);
  };

  const commitEdit = () => {
    if (!editingId) return;
    onUpdate(editingId, {
      label: editRow.label || `${formatShort(editRow.start)}-${formatShort(editRow.end)}`,
      start: editRow.start,
      end: editRow.end,
      start2: editHasSecond && editRow.start2 ? editRow.start2 : undefined,
      end2: editHasSecond && editRow.end2 ? editRow.end2 : undefined,
      slotType: 'all',
    });
    setEditingId(null);
  };

  const commitAdd = () => {
    if (!newRow.start || !newRow.end) return;
    onAdd({
      label: newRow.label || `${formatShort(newRow.start)}-${formatShort(newRow.end)}`,
      start: newRow.start,
      end: newRow.end,
      start2: newHasSecond && newRow.start2 ? newRow.start2 : undefined,
      end2: newHasSecond && newRow.end2 ? newRow.end2 : undefined,
      slotType: 'all',
    });
    setAddingNew(false);
    setNewRow({ label: '', start: '10:00', end: '14:00', start2: '', end2: '' });
    setNewHasSecond(false);
  };

  const RowFields = ({
    row, onChange, hasSecond, onSecondToggle,
  }: {
    row: EditorRowState;
    onChange: (r: EditorRowState) => void;
    hasSecond: boolean;
    onSecondToggle: () => void;
  }) => (
    <div className="space-y-2 mt-2 p-2 bg-muted/40 rounded-md border text-xs">
      <div>
        <div className="text-[10px] text-muted-foreground mb-0.5">Bezeichnung</div>
        <Input value={row.label} onChange={e => onChange({ ...row, label: e.target.value })}
          placeholder={`${formatShort(row.start) || '10'}-${formatShort(row.end) || '14'}`}
          className="h-7 text-xs" />
      </div>
      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground font-semibold">1. Einsatz</div>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-0.5">Von</div>
            <Input value={row.start} onChange={e => onChange({ ...row, start: e.target.value })}
              placeholder="10:00" className="h-7 text-xs" />
          </div>
          <span className="text-muted-foreground pb-1.5">–</span>
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-0.5">Bis</div>
            <Input value={row.end} onChange={e => onChange({ ...row, end: e.target.value })}
              placeholder="14:00" className="h-7 text-xs" />
          </div>
        </div>
      </div>
      <button onClick={onSecondToggle}
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
        {hasSecond ? '✕ 2. Einsatz entfernen' : '+ 2. Einsatz hinzufügen'}
      </button>
      {hasSecond && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-semibold">2. Einsatz</div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <div className="text-[10px] text-muted-foreground mb-0.5">Von</div>
              <Input value={row.start2} onChange={e => onChange({ ...row, start2: e.target.value })}
                placeholder="17:30" className="h-7 text-xs" />
            </div>
            <span className="text-muted-foreground pb-1.5">–</span>
            <div className="flex-1">
              <div className="text-[10px] text-muted-foreground mb-0.5">Bis</div>
              <Input value={row.end2} onChange={e => onChange({ ...row, end2: e.target.value })}
                placeholder="23:00" className="h-7 text-xs" />
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Schnellwahl bearbeiten
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-1 mt-2">
          {presets.map((p, idx) => {
            const isEditing = editingId === p.id;
            const label2 = p.start2 && p.end2
              ? ` / ${formatShort(p.start2)}-${formatShort(p.end2)}`
              : '';
            return (
              <div key={p.id} className="border rounded-md">
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <div className="flex flex-col gap-0">
                    <button onClick={() => onMove(p.id, 'up')} disabled={idx === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30 leading-none">
                      <ChevronUp className="h-3 w-3" />
                    </button>
                    <button onClick={() => onMove(p.id, 'down')} disabled={idx === presets.length - 1}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30 leading-none">
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-xs truncate">{p.label}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {p.start}–{p.end}{label2}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => isEditing ? setEditingId(null) : startEdit(p)}
                      className="text-muted-foreground hover:text-foreground p-0.5 rounded">
                      {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => { onDelete(p.id); if (editingId === p.id) setEditingId(null); }}
                      className="text-muted-foreground hover:text-destructive p-0.5 rounded">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {isEditing && (
                  <div className="px-2 pb-2">
                    <RowFields row={editRow} onChange={setEditRow}
                      hasSecond={editHasSecond} onSecondToggle={() => setEditHasSecond(v => !v)} />
                    <button onClick={commitEdit}
                      className="mt-2 w-full text-xs bg-primary text-primary-foreground rounded py-1.5 hover:bg-primary/90 transition-colors flex items-center justify-center gap-1">
                      <Check className="h-3 w-3" /> Speichern
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {addingNew ? (
          <div className="border rounded-md p-2 mt-2">
            <div className="text-xs font-medium mb-1">Neue Schnellwahl</div>
            <RowFields row={newRow} onChange={setNewRow}
              hasSecond={newHasSecond} onSecondToggle={() => setNewHasSecond(v => !v)} />
            <div className="flex gap-2 mt-2">
              <button onClick={commitAdd}
                className="flex-1 text-xs bg-primary text-primary-foreground rounded py-1.5 hover:bg-primary/90 transition-colors flex items-center justify-center gap-1">
                <Check className="h-3 w-3" /> Hinzufügen
              </button>
              <button onClick={() => setAddingNew(false)}
                className="text-xs text-muted-foreground border rounded py-1.5 px-3 hover:bg-muted transition-colors">
                Abbrechen
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingNew(true)}
            className="mt-3 w-full text-xs border-dashed border-2 border-muted-foreground/30 rounded-md py-2 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors flex items-center justify-center gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Neue Schnellwahl hinzufügen
          </button>
        )}

        <div className="mt-4 pt-3 border-t flex items-center justify-between">
          <button onClick={() => { if (confirm('Auf Standardwerte zurücksetzen?')) onReset(); }}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RotateCcw className="h-3 w-3" /> Auf Standard zurücksetzen
          </button>
          <button onClick={onClose}
            className="text-xs bg-muted hover:bg-muted/80 rounded px-3 py-1.5 transition-colors">
            Schließen
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// InlineTimePicker — shown inline below a field when clock icon is clicked
// ---------------------------------------------------------------------------

type PickerTarget = 'start1' | 'end1' | 'start2' | 'end2' | null;

function InlineTimePicker({
  currentValue,
  onConfirm,
  onClose,
}: {
  currentValue: string;
  onConfirm: (time: string) => void;
  onClose: () => void;
}) {
  const parsed = parseTimeStr(currentValue);
  const initH = parsed ? parsed.split(':')[0] : '10';
  const initM = parsed ? parsed.split(':')[1] : '00';
  const safeM = ['00', '15', '30', '45'].includes(initM) ? initM : '00';

  const [selH, setSelH] = useState(initH);
  const [selM, setSelM] = useState(safeM);

  const hourRef = useRef<HTMLDivElement>(null);
  const minRef  = useRef<HTMLDivElement>(null);

  const HOURS = useMemo(() => {
    const result: string[] = [];
    for (let i = 6; i < 24; i++) result.push(String(i).padStart(2, '0'));
    for (let i = 0; i <= 3; i++) result.push(String(i).padStart(2, '0'));
    return result;
  }, []);
  const MINUTES = ['00', '15', '30', '45'];

  // Scroll active item into view on mount & when selection changes
  useEffect(() => {
    const el = hourRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selH]);
  useEffect(() => {
    const el = minRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selM]);

  const pickHour = (h: string) => {
    setSelH(h);
    onConfirm(`${h}:${selM}`);
  };
  const pickMin = (m: string) => {
    setSelM(m);
    onConfirm(`${selH}:${m}`);
  };

  return (
    <div className="mt-1 border border-border rounded-lg bg-popover shadow-md overflow-hidden z-10">
      <div className="flex divide-x divide-border">
        {/* Hours column */}
        <div
          ref={hourRef}
          className="flex-1 overflow-y-auto max-h-[140px] py-0.5 scrollbar-thin"
          style={{ scrollbarWidth: 'none' }}
        >
          {HOURS.map(h => (
            <button
              key={h}
              data-active={h === selH ? 'true' : 'false'}
              onClick={() => pickHour(h)}
              className={cn(
                "w-full text-center text-xs font-mono py-1 leading-tight transition-colors",
                h === selH
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-foreground/80 hover:bg-muted/60"
              )}
            >
              {h}
            </button>
          ))}
        </div>
        {/* Minutes column */}
        <div
          ref={minRef}
          className="flex-1 overflow-y-auto max-h-[140px] py-0.5"
          style={{ scrollbarWidth: 'none' }}
        >
          {MINUTES.map(m => (
            <button
              key={m}
              data-active={m === selM ? 'true' : 'false'}
              onClick={() => pickMin(m)}
              className={cn(
                "w-full text-center text-xs font-mono py-1 leading-tight transition-colors",
                m === selM
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-foreground/80 hover:bg-muted/60"
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimeRow — one Von/Bis row with optional clock picker
// ---------------------------------------------------------------------------

function TimeRow({
  label,
  startVal, endVal,
  onStartChange, onEndChange,
  pickerTarget, startTarget, endTarget,
  onPickerOpen, onPickerConfirm, onPickerClose,
}: {
  label: string;
  startVal: string; endVal: string;
  onStartChange: (v: string) => void; onEndChange: (v: string) => void;
  pickerTarget: PickerTarget; startTarget: PickerTarget; endTarget: PickerTarget;
  onPickerOpen: (t: PickerTarget) => void;
  onPickerConfirm: (time: string) => void;
  onPickerClose: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="w-1 h-3 rounded-full bg-primary/30 shrink-0" />
        <span className="text-[9px] font-semibold text-muted-foreground/70 uppercase tracking-widest">{label}</span>
      </div>
      <div className="flex items-start gap-1.5">
        {/* Von */}
        <div className="flex-1">
          <div className="flex items-center gap-1">
            <Input value={startVal} onChange={e => onStartChange(e.target.value)}
              placeholder="Von 10:00" className="h-7 text-xs font-mono" />
            <button type="button"
              onClick={() => onPickerOpen(pickerTarget === startTarget ? null : startTarget)}
              className={cn(
                "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                pickerTarget === startTarget
                  ? "border-primary text-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
              )}>
              <Clock className="h-3.5 w-3.5" />
            </button>
          </div>
          {pickerTarget === startTarget && (
            <InlineTimePicker currentValue={startVal}
              onConfirm={onPickerConfirm} onClose={onPickerClose} />
          )}
        </div>
        <span className="text-muted-foreground/50 text-sm mt-1.5">–</span>
        {/* Bis */}
        <div className="flex-1">
          <div className="flex items-center gap-1">
            <Input value={endVal} onChange={e => onEndChange(e.target.value)}
              placeholder="Bis 23:00" className="h-7 text-xs font-mono" />
            <button type="button"
              onClick={() => onPickerOpen(pickerTarget === endTarget ? null : endTarget)}
              className={cn(
                "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                pickerTarget === endTarget
                  ? "border-primary text-primary bg-primary/5"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
              )}>
              <Clock className="h-3.5 w-3.5" />
            </button>
          </div>
          {pickerTarget === endTarget && (
            <InlineTimePicker currentValue={endVal}
              onConfirm={onPickerConfirm} onClose={onPickerClose} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const TimeInputCell = ({
  value,
  absenceType,
  onChange,
  slotType,
  secondaryValue,
  isWeekend,
  isDayOff,
  isRequestedFree,
  isBlocked,
  department,
  activeTool,
  copiedShift,
  onCopyShift,
  cellColor,
  onCellColorChange,
  onCopyToIst,
  onSplitTimeSelect,
  onClearSecondary,
  isFixedEmployee,
  isAdditionalCostPlan,
  onAdditionalCostPlanChange,
}: TimeInputCellProps) => {
  const [blockedOverride, setBlockedOverride] = useState(false);
  const [copyToIst, setCopyToIst] = useState(false);
  const copiedInSession = useRef(false);
  const [open, setOpen] = useState(false);
  const [localAdditionalCostPlan, setLocalAdditionalCostPlan] = useState(isAdditionalCostPlan ?? false);
  const [editorOpen, setEditorOpen] = useState(false);

  // Always-visible dual time rows
  const [selStart, setSelStart]   = useState('');
  const [selEnd, setSelEnd]       = useState('');
  const [selStart2, setSelStart2] = useState('');
  const [selEnd2, setSelEnd2]     = useState('');
  const [selError, setSelError]   = useState('');

  // Track whether row 2 was pre-filled when popover opened (for smart clear)
  const secondaryWasPreFilled = useRef(false);

  // Inline clock picker
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>(null);

  const { shiftMap, absenceShifts, workShifts } = useShiftConfig();
  const { presets, addPreset, updatePreset, deletePreset, movePreset, resetToDefaults } = useQuickTimes();

  // Filter absence shifts by department
  const filteredAbsenceShifts = department && department !== 'all'
    ? absenceShifts.filter(s => {
        const cfg = shiftMap[s];
        return cfg && (cfg.department === department || !cfg.department);
      })
    : absenceShifts;

  // All presets visible (no slotType filter — concept removed from UX)
  const visiblePresets = presets;

  // Split presets from localStorage (has start2/end2) vs simple (single shift)
  const simplePresets = visiblePresets.filter(p => !(p.start2 && p.end2));
  const splitPresets  = visiblePresets.filter(p => !!(p.start2 && p.end2));

  // Sync fields when popover opens
  useEffect(() => {
    if (open) {
      setPickerTarget(null);
      setSelError('');
      setSelStart(value?.start || '');
      setSelEnd(value?.end || '');
      // 2nd row: init from secondaryValue if available
      const s2 = secondaryValue?.start || '';
      const e2 = secondaryValue?.end || '';
      setSelStart2(s2);
      setSelEnd2(e2);
      secondaryWasPreFilled.current = !!(s2 && e2);
    }
  }, [open]);

  // Sync local state when prop changes (e.g. after parent re-renders from another cell's change)
  useEffect(() => {
    setLocalAdditionalCostPlan(isAdditionalCostPlan ?? false);
  }, [isAdditionalCostPlan]);

  // Called whenever the popover is about to close — saves additional cost flag if changed.
  const flushAdditionalCostPlan = () => {
    if (isFixedEmployee && onAdditionalCostPlanChange) {
      const currentFlag = isAdditionalCostPlan ?? false;
      if (localAdditionalCostPlan !== currentFlag) {
        console.log('[ZK-PLAN] flushing on close:', localAdditionalCostPlan);
        onAdditionalCostPlanChange(localAdditionalCostPlan);
      }
    }
  };

  // Drop-in replacement for setOpen(false) that also flushes the flag.
  const closePopover = () => {
    flushAdditionalCostPlan();
    setBlockedOverride(false);
    setPickerTarget(null);
    setOpen(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      copiedInSession.current = false;
      setSelError('');
      setLocalAdditionalCostPlan(isAdditionalCostPlan ?? false);
    }
    if (!nextOpen) {
      flushAdditionalCostPlan();
      setBlockedOverride(false);
      setPickerTarget(null);
      if (copyToIst && onCopyToIst && value?.start && value?.end && !copiedInSession.current) {
        onCopyToIst({ start: value.start, end: value.end });
      }
    }
    setOpen(nextOpen);
  };

  // ---------------------------------------------------------------------------
  // Picker routing
  // ---------------------------------------------------------------------------
  const applyPicker = (time: string) => {
    if (pickerTarget === 'start1') { setSelStart(time); }
    else if (pickerTarget === 'end1') { setSelEnd(time); }
    else if (pickerTarget === 'start2') { setSelStart2(time); }
    else if (pickerTarget === 'end2') { setSelEnd2(time); }
    setPickerTarget(null);
    setSelError('');
  };

  // ---------------------------------------------------------------------------
  // Quick-select handler
  // ---------------------------------------------------------------------------
  const handlePresetSelect = (preset: { start: string; end: string; start2?: string; end2?: string }) => {
    if (preset.start2 && preset.end2) {
      // Split-Schicht: 1. Block muss immer in den früh-Slot, 2. Block in den spät-Slot.
      // Wenn slotType === 'früh' ist die Reihenfolge bereits korrekt.
      // Wenn slotType === 'spät' (leere Zelle, weil noch kein früh vorhanden),
      // müssen die Blöcke getauscht werden: secondary-Callback → früh, onChange → spät.
      if (slotType === 'früh') {
        onChange({ start: preset.start, end: preset.end }, null);
        onSplitTimeSelect?.({ start: preset.start2, end: preset.end2 });
      } else {
        // primarySlot ist 'spät' → secondary (früh) bekommt den 1. Block, primary (spät) den 2.
        onSplitTimeSelect?.({ start: preset.start, end: preset.end });
        onChange({ start: preset.start2, end: preset.end2 }, null);
      }
    } else {
      onChange({ start: preset.start, end: preset.end }, null);
    }
    if (copyToIst && onCopyToIst) {
      onCopyToIst({ start: preset.start, end: preset.end });
      copiedInSession.current = true;
    }
    closePopover();
  };

  // ---------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------
  const handleSelCommit = () => {
    // Row 1 must be filled
    const ns = parseTimeStr(selStart);
    const ne = parseTimeStr(selEnd);

    if (!selStart && !selEnd && !selStart2 && !selEnd2) {
      // All empty → clear
      onChange(null, null);
      closePopover();
      return;
    }

    if (!ns) { setSelError(`Ungültige Von-Zeit: "${selStart}"`); return; }
    if (!ne) { setSelError(`Ungültige Bis-Zeit: "${selEnd}"`); return; }
    if (toMin(ns) === toMin(ne)) { setSelError('Von und Bis dürfen nicht gleich sein'); return; }

    // Row 2: both empty → single shift. One filled, other not → error.
    const has2Start = selStart2.trim() !== '';
    const has2End   = selEnd2.trim() !== '';

    if (has2Start !== has2End) {
      setSelError('Bitte für den 2. Einsatz sowohl Von als auch Bis angeben');
      return;
    }

    if (has2Start && has2End) {
      const ns2 = parseTimeStr(selStart2);
      const ne2 = parseTimeStr(selEnd2);
      if (!ns2) { setSelError(`Ungültige Von-Zeit (2. Einsatz): "${selStart2}"`); return; }
      if (!ne2) { setSelError(`Ungültige Bis-Zeit (2. Einsatz): "${selEnd2}"`); return; }
      if (toMin(ns2) === toMin(ne2)) { setSelError('Von und Bis des 2. Einsatzes dürfen nicht gleich sein'); return; }
      if (rangesOverlap(ns, ne, ns2, ne2)) {
        setSelError('Die zwei Einsätze überschneiden sich'); return;
      }
      setSelError('');
      // Split-Schicht: 1. Zeile → früh-Slot, 2. Zeile → spät-Slot.
      // Wenn slotType === 'spät' (leere Zelle), sind primary/secondary vertauscht →
      // secondary-Callback (→ früh) bekommt Row 1, onChange (→ spät) bekommt Row 2.
      if (slotType === 'früh') {
        onChange({ start: ns, end: ne }, null);
        if (onSplitTimeSelect) onSplitTimeSelect({ start: ns2, end: ne2 });
      } else {
        if (onSplitTimeSelect) onSplitTimeSelect({ start: ns, end: ne });
        onChange({ start: ns2, end: ne2 }, null);
      }
      if (copyToIst && onCopyToIst) {
        onCopyToIst({ start: ns, end: ne });
        copiedInSession.current = true;
      }
    } else {
      // Row 2 empty — if it was pre-filled when opened, clear the secondary slot
      if (secondaryWasPreFilled.current) {
        onClearSecondary?.();
        if (onSplitTimeSelect) onSplitTimeSelect(null);
      }
      setSelError('');
      onChange({ start: ns, end: ne }, null);
      if (copyToIst && onCopyToIst) {
        onCopyToIst({ start: ns, end: ne });
        copiedInSession.current = true;
      }
    }
    closePopover();
  };

  const handleAbsenceSelect = (abbrev: string) => {
    onChange(null, abbrev);
    closePopover();
  };

  const handleClear = () => {
    onChange(null, null);
    onClearSecondary?.();
    // Clearing the shift → also clear the additional cost flag
    setLocalAdditionalCostPlan(false);
    if (isFixedEmployee && onAdditionalCostPlanChange && (isAdditionalCostPlan ?? false)) {
      onAdditionalCostPlanChange(false);
    }
    setBlockedOverride(false);
    setPickerTarget(null);
    setOpen(false);
  };

  // ---------------------------------------------------------------------------
  // Display value
  // ---------------------------------------------------------------------------
  const matchedWorkShift = value?.start && value?.end
    ? workShifts.find(s => shiftMap[s]?.start === value.start && shiftMap[s]?.end === value.end)
    : undefined;
  const matchedConfig = matchedWorkShift ? shiftMap[matchedWorkShift] : undefined;

  const displayValue = absenceType
    ? absenceType
    : value?.start && value?.end
      ? matchedConfig?.displayMode === 'code-in-cell' && matchedConfig.abbrev
        ? matchedConfig.abbrev
        : `${formatShort(value.start)}-${formatShort(value.end)}`
      : '';

  const getAbsenceConfig = (abbrev: string) => {
    const key = absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev);
    return key ? shiftMap[key] : null;
  };

  const absenceConfig = absenceType ? getAbsenceConfig(absenceType) : null;
  const hasCellColor = !absenceType && !!value?.start && !!cellColor;
  const hasSecondaryDisplay = !absenceType && !!value?.start && !!secondaryValue?.start;
  // Only the secondary slot has data (e.g. merged cell where früh is null but spät exists)
  const onlySecondaryDisplay = !absenceType && !value?.start && !!secondaryValue?.start;

  // ---------------------------------------------------------------------------
  // Paint-tool mode (unchanged)
  // ---------------------------------------------------------------------------
  if (activeTool) {
    const isShiftMode = activeTool.startsWith('shift:');

    const emptyPaintClass =
      isBlocked && !value?.start && !absenceType
        ? "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 font-semibold"
        : isRequestedFree && !value?.start && !absenceType
          ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 font-semibold"
          : isDayOff && !value?.start && !absenceType
            ? "bg-slate-300 dark:bg-slate-600 border-slate-400 dark:border-slate-500 text-slate-600 dark:text-slate-300 font-bold"
            : "bg-muted/30 border-dashed border-muted-foreground/20 text-muted-foreground hover:bg-primary/10 hover:border-primary/40";

    const emptyPaintLabel =
      isBlocked && !value?.start && !absenceType ? '⛔' :
      isRequestedFree && !value?.start && !absenceType ? 'WF' :
      isDayOff && !value?.start && !absenceType ? 'F' : '—';

    if (isShiftMode) {
      const shiftName = activeTool.slice(6);
      const config = shiftMap[shiftName];
      const alreadySet = !absenceType && !!value?.start
        && value.start === config?.start && value.end === config?.end;
      return (
        <button
          onClick={() => alreadySet
            ? onChange(null, null)
            : onChange(config ? { start: config.start, end: config.end } : null, null)
          }
          title={alreadySet ? 'Klicken zum Entfernen' : `${shiftName} eintragen`}
          className={cn(
            "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
            "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none cursor-crosshair",
            alreadySet && config?.color, alreadySet && "ring-1 ring-foreground/30",
            !alreadySet && absenceType && absenceConfig?.color,
            !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
            !alreadySet && !absenceType && !value?.start && emptyPaintClass,
          )}>
          {alreadySet
            ? (config?.displayMode === 'code-in-cell' && config.abbrev ? config.abbrev : displayValue)
            : (displayValue || emptyPaintLabel)}
        </button>
      );
    }

    const toolConfig = absenceShifts.find(s => shiftMap[s]?.abbrev === activeTool)
      ? shiftMap[absenceShifts.find(s => shiftMap[s]?.abbrev === activeTool)!]
      : null;
    const alreadySet = absenceType === activeTool;
    return (
      <button
        onClick={() => alreadySet
          ? onChange(null, null)
          : onChange(null, activeTool)
        }
        title={alreadySet ? 'Klicken zum Entfernen' : `${activeTool} eintragen`}
        className={cn(
          "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
          "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none cursor-crosshair",
          alreadySet && toolConfig?.color, alreadySet && "ring-1 ring-foreground/30",
          !alreadySet && absenceType && absenceConfig?.color,
          !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
          !alreadySet && !absenceType && !value?.start && emptyPaintClass,
        )}>
        {displayValue || emptyPaintLabel}
      </button>
    );
  }

  // ---------------------------------------------------------------------------
  // Normal popover mode
  // ---------------------------------------------------------------------------
  const isEmptyDayOff        = isDayOff && !value?.start && !absenceType;
  const isEmptyRequestedFree = isRequestedFree && !value?.start && !absenceType && !isDayOff;
  const isEmptyBlocked       = isBlocked && !value?.start && !absenceType && !isDayOff;

  return (
    <>
      <div className="relative">
        {isAdditionalCostPlan && (
          <span
            className="absolute -top-1 -right-1 z-10 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-orange-500 text-white text-[8px] font-bold leading-none pointer-events-none select-none"
            title="Zusatzkosten (Plan)"
          >+</span>
        )}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "w-full text-[11px] font-medium border rounded-lg transition-all",
              "hover:ring-1 hover:ring-ring/50 focus:outline-none focus:ring-1 focus:ring-ring",
              // Height
              hasSecondaryDisplay ? "min-h-[52px] py-1.5 px-1" : "min-h-[36px] py-1 px-1",
              onlySecondaryDisplay && "min-h-[36px] py-1 px-1",
              // Empty / default
              !absenceType && !value?.start && !onlySecondaryDisplay && !isDayOff && !isRequestedFree && !isBlocked && "bg-transparent border-dashed border-border/30 text-muted-foreground/40 hover:border-border/60 hover:bg-muted/20",
              isWeekend && !isDayOff && !isRequestedFree && !isBlocked && "bg-amber-50/30 dark:bg-amber-900/10",
              // Day off / free / blocked empty states
              isEmptyDayOff && "bg-slate-200/80 dark:bg-slate-700/60 border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-300 font-semibold",
              isDayOff && !isEmptyDayOff && "ring-1 ring-slate-300/50 dark:ring-slate-600/40",
              isEmptyRequestedFree && "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 font-medium",
              isRequestedFree && !isEmptyRequestedFree && "ring-1 ring-amber-300/60 dark:ring-amber-700/50",
              isEmptyBlocked && "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 font-medium",
              isBlocked && !isEmptyBlocked && "ring-1 ring-red-300/60 dark:ring-red-700/50",
              // Absence with semantic colors
              absenceType && absenceConfig?.color,
              // Has shift data
              !absenceType && (value?.start || onlySecondaryDisplay) && !isRequestedFree && !isBlocked && !hasCellColor && "bg-indigo-50/80 dark:bg-indigo-900/25 border-indigo-200/60 dark:border-indigo-700/40",
            )}
            style={hasCellColor ? { backgroundColor: cellColor!, borderColor: cellColor!, color: '#1e3a5f' } : undefined}
          >
            {hasSecondaryDisplay ? (
              <div className="flex flex-col items-center gap-0.5">
                <span className="font-semibold text-indigo-700 dark:text-indigo-300 tabular-nums tracking-tight">
                  {formatShort(value!.start)}–{formatShort(value!.end)}
                </span>
                <span className="font-medium text-indigo-500/80 dark:text-indigo-400/70 tabular-nums tracking-tight text-[10px]">
                  {formatShort(secondaryValue!.start)}–{formatShort(secondaryValue!.end)}
                </span>
              </div>
            ) : onlySecondaryDisplay ? (
              <span className="font-semibold text-indigo-700 dark:text-indigo-300 tabular-nums tracking-tight">
                {formatShort(secondaryValue!.start)}–{formatShort(secondaryValue!.end)}
              </span>
            ) : (value?.start && !absenceType && !hasCellColor) ? (
              <span className="font-semibold text-indigo-700 dark:text-indigo-300 tabular-nums tracking-tight">
                {displayValue}
              </span>
            ) : (
              displayValue || (isEmptyDayOff ? 'F' : isEmptyRequestedFree ? 'WF' : isEmptyBlocked ? '⛔' : '')
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-80 p-0 z-50" align="center">
          <div className="max-h-[85vh] overflow-y-auto p-3">
          <div className="space-y-2">

            {/* ── Wunschfrei warning ── */}
            {isRequestedFree && (
              <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-2 py-1.5 -mx-0.5">
                <span className="text-amber-600 font-bold text-[11px] leading-tight shrink-0 mt-0.5">WF</span>
                <span className="text-[10px] text-amber-800 dark:text-amber-300 leading-tight">
                  Wunschfrei beantragt. Einplanung möglich, aber bitte begründen.
                </span>
              </div>
            )}

            {/* ── Blocked warning ── */}
            {isBlocked && !blockedOverride && (
              <div className="space-y-2 -mx-0.5">
                <div className="flex items-start gap-1.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 px-2 py-1.5">
                  <span className="text-red-600 font-bold text-[11px] leading-tight shrink-0 mt-0.5">⛔</span>
                  <span className="text-[10px] text-red-800 dark:text-red-300 leading-tight">
                    Dieser Tag ist als gesperrt markiert.
                  </span>
                </div>
                <button onClick={() => setBlockedOverride(true)}
                  className="w-full text-xs font-medium text-red-700 dark:text-red-400 border border-red-300 dark:border-red-700 rounded py-1 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors">
                  Trotzdem eintragen ↓
                </button>
              </div>
            )}
            {isBlocked && blockedOverride && (
              <div className="flex items-center gap-1.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 px-2 py-1 -mx-0.5">
                <span className="text-[9px] text-red-700 dark:text-red-300 font-semibold uppercase tracking-wide">Override aktiv</span>
              </div>
            )}

            {(!isBlocked || blockedOverride) && (
              <>
                {/* ── Header ── */}
                <div className="flex items-center justify-between pb-1.5 border-b border-border/40">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-primary/50" />
                    <span className="text-[12px] font-semibold text-foreground/80 tracking-tight">Einsatz planen</span>
                  </div>
                  {(value?.start || absenceType) && (
                    <button onClick={handleClear}
                      className="text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-0.5 transition-colors rounded px-1.5 py-0.5 hover:bg-destructive/8">
                      <X className="h-3 w-3" /> Löschen
                    </button>
                  )}
                </div>

                {/* ════ SCHNELLWAHL — max 6 simple ════════════════════ */}
                {simplePresets.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-widest">Schnellwahl</div>
                    <div className="grid grid-cols-3 gap-1">
                      {simplePresets.slice(0, 6).map(p => (
                        <button key={p.id}
                          onClick={() => handlePresetSelect(p)}
                          title={`${p.start}–${p.end}`}
                          className={cn(
                            "px-1.5 py-2 text-[11px] rounded-lg border transition-all font-semibold text-center leading-tight tabular-nums",
                            "bg-slate-50 dark:bg-slate-800/60 border-border/40",
                            "text-foreground/75 hover:bg-primary/10 hover:border-primary/30 hover:text-primary active:scale-95"
                          )}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* ════ GETEILT — max 4 split ══════════════════════════ */}
                {splitPresets.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-widest">Geteilt</div>
                    <div className="grid grid-cols-1 gap-1">
                      {splitPresets.slice(0, 4).map(p => (
                        <button key={p.id}
                          onClick={() => handlePresetSelect(p)}
                          title={`1. Einsatz ${p.start}–${p.end} · 2. Einsatz ${p.start2}–${p.end2}`}
                          className={cn(
                            "px-2 py-1.5 text-[11px] rounded-lg border transition-all font-semibold text-left leading-tight tabular-nums",
                            "bg-indigo-50/60 dark:bg-indigo-900/20 border-indigo-200/50 dark:border-indigo-700/40",
                            "text-indigo-800 dark:text-indigo-200 hover:bg-indigo-100/80 dark:hover:bg-indigo-800/30 hover:border-indigo-300 active:scale-95"
                          )}>
                          <span className="text-indigo-600/80 dark:text-indigo-400/70 text-[10px] font-medium mr-1.5">①</span>
                          {formatShort(p.start)}–{formatShort(p.end)}
                          <span className="mx-1.5 text-indigo-400/60">·</span>
                          <span className="text-indigo-600/80 dark:text-indigo-400/70 text-[10px] font-medium mr-1.5">②</span>
                          {formatShort(p.start2!)}–{formatShort(p.end2!)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <button onClick={() => { setOpen(false); setEditorOpen(true); }}
                  className="w-full text-[10px] text-muted-foreground/60 hover:text-foreground border border-dashed border-border/40 rounded-lg py-1.5 flex items-center justify-center gap-1 hover:border-primary/30 hover:bg-muted/20 transition-colors">
                  <Settings2 className="h-3 w-3" />
                  Schnellwahl bearbeiten
                </button>

                {/* ════ EINSATZZEITEN ══════════════════════════════════ */}
                <div className="border-t pt-2.5 space-y-3">
                  <TimeRow
                    label="1. Einsatz"
                    startVal={selStart} endVal={selEnd}
                    onStartChange={v => { setSelStart(v); setSelError(''); }}
                    onEndChange={v => { setSelEnd(v); setSelError(''); }}
                    pickerTarget={pickerTarget}
                    startTarget="start1" endTarget="end1"
                    onPickerOpen={t => setPickerTarget(t)}
                    onPickerConfirm={applyPicker}
                    onPickerClose={() => setPickerTarget(null)}
                  />

                  <TimeRow
                    label="2. Einsatz (optional)"
                    startVal={selStart2} endVal={selEnd2}
                    onStartChange={v => { setSelStart2(v); setSelError(''); }}
                    onEndChange={v => { setSelEnd2(v); setSelError(''); }}
                    pickerTarget={pickerTarget}
                    startTarget="start2" endTarget="end2"
                    onPickerOpen={t => setPickerTarget(t)}
                    onPickerConfirm={applyPicker}
                    onPickerClose={() => setPickerTarget(null)}
                  />

                  {selError && (
                    <div className="text-[10px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">
                      {selError}
                    </div>
                  )}

                  {/* IST checkbox */}
                  {onCopyToIst && !absenceType && (
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" id="copy-to-ist-cb"
                        checked={copyToIst}
                        onChange={e => setCopyToIst(e.target.checked)}
                        className="h-3.5 w-3.5 accent-green-600 rounded"
                      />
                      <label htmlFor="copy-to-ist-cb"
                        className="text-[10px] text-foreground cursor-pointer select-none leading-tight">
                        Auch ins IST übernehmen
                      </label>
                    </div>
                  )}

                  <button onClick={handleSelCommit}
                    className="w-full text-sm bg-primary text-primary-foreground rounded-lg py-2 hover:bg-primary/90 active:scale-[0.99] transition-all font-semibold shadow-sm">
                    Übernehmen
                  </button>
                </div>

                {/* ── Absence shortcuts ── */}
                {filteredAbsenceShifts.length > 0 && (
                  <div className="pt-2 border-t space-y-1.5">
                    <div className="text-[9px] font-semibold text-muted-foreground/70 uppercase tracking-widest">Abwesenheit</div>
                    <div className="flex flex-wrap gap-1.5">
                      {filteredAbsenceShifts.map(shift => {
                        const cfg = shiftMap[shift];
                        if (!cfg) return null;
                        const abbrev = cfg.abbrev;
                        const semanticCls = abbrev === 'F' || abbrev === 'Frei'
                          ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-800/50 shadow-sm'
                          : abbrev === 'Urlaub' || abbrev === 'Ferien' || abbrev === 'FE'
                          ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800/50 shadow-sm'
                          : abbrev === 'K' || abbrev === 'Krank'
                          ? 'bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-800/50 shadow-sm'
                          : abbrev === 'U' || abbrev === 'Unfall'
                          ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-800/50 shadow-sm'
                          : abbrev === 'UB' || abbrev === 'Unbezahlt'
                          ? 'bg-slate-100 dark:bg-slate-800/60 border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700/60 shadow-sm'
                          : cn(cfg.color, 'hover:opacity-80 shadow-sm');
                        return (
                          <button key={shift}
                            onClick={() => handleAbsenceSelect(cfg.abbrev)}
                            className={cn("px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all active:scale-95", semanticCls)}>
                            {cfg.abbrev}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Copy / Paste ── */}
                <div className="flex gap-1.5 pt-2 border-t">
                  {value?.start && (
                    <button onClick={() => { onCopyShift?.({ ...value!, secondary: secondaryValue || null }); closePopover(); }}
                      className="flex-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 py-1.5 rounded-lg border border-blue-200/70 dark:border-blue-700/60 transition-all font-medium active:scale-95">
                      📋 Kopieren
                    </button>
                  )}
                  {copiedShift?.start && (
                    <button onClick={() => {
                        onChange({ start: copiedShift.start, end: copiedShift.end }, null);
                        if (copiedShift.secondary?.start && onSplitTimeSelect) {
                          onSplitTimeSelect({ start: copiedShift.secondary.start, end: copiedShift.secondary.end });
                        }
                        closePopover();
                      }}
                      title={`${copiedShift.start}–${copiedShift.end}${copiedShift.secondary ? ` / ${copiedShift.secondary.start}–${copiedShift.secondary.end}` : ''} einfügen`}
                      className="flex-1 text-xs text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 py-1.5 rounded-lg border border-green-200/70 dark:border-green-700/60 transition-all font-medium active:scale-95">
                      📌 {formatShort(copiedShift.start)}–{formatShort(copiedShift.end)}{copiedShift.secondary ? ` / ${formatShort(copiedShift.secondary.start)}–${formatShort(copiedShift.secondary.end)}` : ''}
                    </button>
                  )}
                </div>

                {/* ── Cell color picker ── */}
                {value?.start && onCellColorChange && (
                  <div className="pt-1.5 border-t">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-[9px] text-muted-foreground shrink-0">Farbe:</span>
                      {CELL_COLORS.map(c => {
                        const isActive = cellColor === c.hex;
                        return (
                          <button key={c.hex} title={isActive ? `${c.label} (entfernen)` : c.label}
                            onClick={() => onCellColorChange(isActive ? null : c.hex)}
                            className={cn("w-4 h-4 rounded-full transition-all shrink-0",
                              isActive ? "ring-2 ring-offset-1 ring-foreground scale-110" : "ring-1 ring-border hover:scale-110")}
                            style={{ backgroundColor: c.hex }} />
                        );
                      })}
                      {cellColor && (
                        <button onClick={() => onCellColorChange(null)}
                          className="text-[9px] text-muted-foreground hover:text-destructive ml-0.5"
                          title="Farbe zurücksetzen">✕</button>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Zusatzkosten (Plan) ── */}
                {isFixedEmployee && (
                  <div className="mt-3 flex items-start gap-2.5 rounded-md border border-orange-200 bg-orange-50 dark:border-orange-700/50 dark:bg-orange-900/20 px-3 py-2.5">
                    <input
                      id="isAdditionalCostPlan"
                      type="checkbox"
                      checked={localAdditionalCostPlan}
                      onChange={(e) => {
                        console.log('[ZK-PLAN] checkbox clicked, new value=', e.target.checked);
                        setLocalAdditionalCostPlan(e.target.checked);
                      }}
                      className="mt-0.5 h-4 w-4 rounded border-orange-400 accent-orange-500 cursor-pointer"
                    />
                    <label htmlFor="isAdditionalCostPlan" className="cursor-pointer text-sm leading-tight">
                      <span className="font-semibold text-orange-700 dark:text-orange-400">Als Zusatzkosten planen</span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        Schicht als variable Zusatzkosten im Personal FIX berücksichtigen.
                      </span>
                    </label>
                  </div>
                )}

                {/* ── Delete ── */}
                {(value?.start || absenceType) && (
                  <button onClick={handleClear}
                    className="w-full text-xs text-muted-foreground/60 hover:text-destructive py-1.5 border-t transition-colors">
                    Löschen
                  </button>
                )}
              </>
            )}
          </div>
          </div>{/* end scroll wrapper */}
        </PopoverContent>
      </Popover>

      </div>{/* end relative wrapper for badge */}

      <QuickTimesEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        presets={presets}
        onAdd={addPreset}
        onUpdate={updatePreset}
        onDelete={deletePreset}
        onMove={movePreset}
        onReset={resetToDefaults}
      />
    </>
  );
};
