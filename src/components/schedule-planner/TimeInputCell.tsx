import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
}

interface TimeInputCellProps {
  value: TimeSlot | null;
  absenceType?: string | null;
  onChange: (value: TimeSlot | null, absenceType?: string | null) => void;
  slotType: 'früh' | 'spät';
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
  /** Called when user selects a split shift — should set the OTHER slot */
  onSplitTimeSelect?: (secondary: TimeSlot) => void;
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

/** Generate 15-min time slots from 06:00 to 02:00 (next day) */
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

/** Normalize HH:MM to minutes-since-06:00 for ordering (handles overnight wrap) */
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

interface ParsedBlocks {
  primary: TimeSlot;
  secondary?: TimeSlot;
}

function parseFreeText(text: string): ParsedBlocks | string {
  const raw = text.trim();
  if (!raw) return 'Bitte eine Zeit eingeben';

  const blocks = raw.split('/').map(b => b.trim());
  if (blocks.length > 2) return 'Maximal zwei Zeitblöcke (getrennt durch /) möglich';

  const parseBlock = (block: string): TimeSlot | string => {
    const dashIdx = block.lastIndexOf('-');
    if (dashIdx <= 0) return `Ungültiges Format: "${block}" (Beispiel: 10-14 oder 10:30-14)`;
    const startRaw = block.slice(0, dashIdx).trim();
    const endRaw = block.slice(dashIdx + 1).trim();
    const start = parseTimeStr(startRaw);
    const end = parseTimeStr(endRaw);
    if (!start) return `Ungültige Startzeit: "${startRaw}"`;
    if (!end) return `Ungültige Endzeit: "${endRaw}"`;
    if (toMin(start) === toMin(end)) return 'Start- und Endzeit dürfen nicht gleich sein';
    return { start, end };
  };

  const b1 = parseBlock(blocks[0]);
  if (typeof b1 === 'string') return b1;
  if (blocks.length === 1) return { primary: b1 };

  const b2 = parseBlock(blocks[1]);
  if (typeof b2 === 'string') return b2;

  if (rangesOverlap(b1.start, b1.end, b2.start, b2.end)) {
    return 'Die zwei Zeitblöcke überschneiden sich';
  }

  return { primary: b1, secondary: b2 };
}

function formatShort(t: string): string {
  return t.replace(':00', '');
}

// ---------------------------------------------------------------------------
// QuickTimesEditorDialog — manage Schnellwahl presets
// ---------------------------------------------------------------------------

interface EditorRowState {
  label: string;
  start: string;
  end: string;
  start2: string;
  end2: string;
  slotType: 'früh' | 'spät' | 'all';
}

function makeRowState(p: QuickTimePreset): EditorRowState {
  return {
    label: p.label,
    start: p.start,
    end: p.end,
    start2: p.start2 || '',
    end2: p.end2 || '',
    slotType: p.slotType,
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
  const [editRow, setEditRow] = useState<EditorRowState>({ label: '', start: '10:00', end: '14:00', start2: '', end2: '', slotType: 'früh' });
  const [addingNew, setAddingNew] = useState(false);
  const [newRow, setNewRow] = useState<EditorRowState>({ label: '', start: '10:00', end: '14:00', start2: '', end2: '', slotType: 'früh' });
  const [splitSecond, setSplitSecond] = useState(false);
  const [newSplitSecond, setNewSplitSecond] = useState(false);

  const startEdit = (p: QuickTimePreset) => {
    setEditingId(p.id);
    setEditRow(makeRowState(p));
    setSplitSecond(!!(p.start2 && p.end2));
    setAddingNew(false);
  };

  const commitEdit = () => {
    if (!editingId) return;
    onUpdate(editingId, {
      label: editRow.label || `${formatShort(editRow.start)}-${formatShort(editRow.end)}`,
      start: editRow.start,
      end: editRow.end,
      start2: splitSecond && editRow.start2 ? editRow.start2 : undefined,
      end2: splitSecond && editRow.end2 ? editRow.end2 : undefined,
      slotType: editRow.slotType,
    });
    setEditingId(null);
  };

  const commitAdd = () => {
    if (!newRow.start || !newRow.end) return;
    onAdd({
      label: newRow.label || `${formatShort(newRow.start)}-${formatShort(newRow.end)}`,
      start: newRow.start,
      end: newRow.end,
      start2: newSplitSecond && newRow.start2 ? newRow.start2 : undefined,
      end2: newSplitSecond && newRow.end2 ? newRow.end2 : undefined,
      slotType: newRow.slotType,
    });
    setAddingNew(false);
    setNewRow({ label: '', start: '10:00', end: '14:00', start2: '', end2: '', slotType: 'früh' });
    setNewSplitSecond(false);
  };

  const slotLabel = (s: 'früh' | 'spät' | 'all') =>
    s === 'früh' ? 'Früh' : s === 'spät' ? 'Spät' : 'Alle';

  const RowFields = ({
    row, onChange, splitOn, onSplitToggle,
  }: {
    row: EditorRowState;
    onChange: (r: EditorRowState) => void;
    splitOn: boolean;
    onSplitToggle: () => void;
  }) => (
    <div className="space-y-2 mt-2 p-2 bg-muted/40 rounded-md border text-xs">
      <div className="flex gap-2">
        <div className="flex-1">
          <div className="text-[10px] text-muted-foreground mb-0.5">Bezeichnung</div>
          <Input value={row.label} onChange={e => onChange({ ...row, label: e.target.value })}
            placeholder="z.B. 10-14" className="h-7 text-xs" />
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground mb-0.5">Slot</div>
          <Select value={row.slotType} onValueChange={v => onChange({ ...row, slotType: v as 'früh' | 'spät' | 'all' })}>
            <SelectTrigger className="h-7 text-xs w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="früh">Früh</SelectItem>
              <SelectItem value="spät">Spät</SelectItem>
              <SelectItem value="all">Alle</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          <div className="text-[10px] text-muted-foreground mb-0.5">Start</div>
          <Input value={row.start} onChange={e => onChange({ ...row, start: e.target.value })}
            placeholder="10:00" className="h-7 text-xs" />
        </div>
        <span className="text-muted-foreground pb-1.5">–</span>
        <div className="flex-1">
          <div className="text-[10px] text-muted-foreground mb-0.5">Ende</div>
          <Input value={row.end} onChange={e => onChange({ ...row, end: e.target.value })}
            placeholder="14:00" className="h-7 text-xs" />
        </div>
      </div>
      <button
        onClick={onSplitToggle}
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
      >
        {splitOn ? '✕ Zweite Schicht entfernen' : '+ Zweite Schicht'}
      </button>
      {splitOn && (
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-0.5">Start 2</div>
            <Input value={row.start2} onChange={e => onChange({ ...row, start2: e.target.value })}
              placeholder="17:30" className="h-7 text-xs" />
          </div>
          <span className="text-muted-foreground pb-1.5">–</span>
          <div className="flex-1">
            <div className="text-[10px] text-muted-foreground mb-0.5">Ende 2</div>
            <Input value={row.end2} onChange={e => onChange({ ...row, end2: e.target.value })}
              placeholder="23:00" className="h-7 text-xs" />
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
                      {p.start}–{p.end}{label2} · {slotLabel(p.slotType)}
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
                      splitOn={splitSecond} onSplitToggle={() => setSplitSecond(v => !v)} />
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

        {/* Add new */}
        {addingNew ? (
          <div className="border rounded-md p-2 mt-2">
            <div className="text-xs font-medium mb-1">Neue Schnellwahl</div>
            <RowFields row={newRow} onChange={setNewRow}
              splitOn={newSplitSecond} onSplitToggle={() => setNewSplitSecond(v => !v)} />
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
// InlineTimePicker — shown below a field when clock icon is clicked
// ---------------------------------------------------------------------------

type PickerTarget = 'start1' | 'end1' | 'start2' | 'end2' | null;

interface InlineTimePickerProps {
  currentValue: string;
  onConfirm: (time: string) => void;
  onClose: () => void;
}

function InlineTimePicker({ currentValue, onConfirm, onClose }: InlineTimePickerProps) {
  const parsed = parseTimeStr(currentValue);
  const initH = parsed ? parsed.split(':')[0] : '10';
  const initM = parsed ? parsed.split(':')[1] : '00';
  const safeM = ['00', '15', '30', '45'].includes(initM) ? initM : '00';

  const [ph, setPh] = useState(initH);
  const [pm, setPm] = useState(safeM);

  const HOURS = useMemo(() => {
    const result: string[] = [];
    for (let i = 6; i < 24; i++) result.push(String(i).padStart(2, '0'));
    for (let i = 0; i <= 3; i++) result.push(String(i).padStart(2, '0'));
    return result;
  }, []);

  return (
    <div className="flex items-center gap-1.5 bg-muted/60 border border-border rounded-md px-2 py-1.5 mt-1">
      <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
      <select
        value={ph}
        onChange={e => setPh(e.target.value)}
        className="text-xs border border-border rounded px-1 py-0.5 bg-background w-12"
      >
        {HOURS.map(h => <option key={h} value={h}>{h}</option>)}
      </select>
      <span className="text-muted-foreground text-xs font-bold">:</span>
      <select
        value={pm}
        onChange={e => setPm(e.target.value)}
        className="text-xs border border-border rounded px-1 py-0.5 bg-background w-12"
      >
        {['00', '15', '30', '45'].map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <button
        onClick={() => onConfirm(`${ph}:${pm}`)}
        className="text-[10px] bg-primary text-primary-foreground rounded px-2 py-0.5 hover:bg-primary/90 transition-colors font-medium"
      >
        OK
      </button>
      <button
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
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
}: TimeInputCellProps) => {
  const [blockedOverride, setBlockedOverride] = useState(false);
  const [copyToIst, setCopyToIst] = useState(false);
  const copiedInSession = useRef(false);
  const [open, setOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  // Unified time input state (replaces all 3 tabs)
  const defaultStart = slotType === 'früh' ? '10:00' : '17:00';
  const defaultEnd   = slotType === 'früh' ? '14:00' : '23:00';
  const [selStart, setSelStart]   = useState(defaultStart);
  const [selEnd, setSelEnd]       = useState(defaultEnd);
  const [selStart2, setSelStart2] = useState('17:30');
  const [selEnd2, setSelEnd2]     = useState('23:00');
  const [showSecond, setShowSecond] = useState(false);
  const [selError, setSelError]   = useState('');

  // Inline clock picker state
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

  // Schnellwahl presets filtered by current slot type
  const filteredPresets = presets.filter(p =>
    p.slotType === 'all' || p.slotType === slotType
  );

  // Split shifts from shiftConfig (multi-block configured shifts)
  const splitShifts = workShifts.filter(shift => {
    const cfg = shiftMap[shift];
    if (!cfg || !cfg.start2 || !cfg.end2) return false;
    if (department && department !== 'all') {
      return cfg.department === department || !cfg.department;
    }
    return true;
  });

  // Sync fields to current value when popover opens
  useEffect(() => {
    if (open) {
      setPickerTarget(null);
      setSelError('');
      if (value?.start) {
        setSelStart(value.start);
        setSelEnd(value.end || defaultEnd);
      } else {
        setSelStart(defaultStart);
        setSelEnd(defaultEnd);
      }
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      copiedInSession.current = false;
      setSelError('');
    }
    if (!nextOpen) {
      setBlockedOverride(false);
      setPickerTarget(null);
      if (copyToIst && onCopyToIst && value?.start && value?.end && !copiedInSession.current) {
        onCopyToIst({ start: value.start, end: value.end });
      }
    }
    setOpen(nextOpen);
  };

  // ---------------------------------------------------------------------------
  // Quick-select handler (preset with optional split)
  // ---------------------------------------------------------------------------
  const handlePresetSelect = (preset: { start: string; end: string; start2?: string; end2?: string }) => {
    onChange({ start: preset.start, end: preset.end }, null);
    if (preset.start2 && preset.end2 && onSplitTimeSelect) {
      onSplitTimeSelect({ start: preset.start2, end: preset.end2 });
    }
    if (copyToIst && onCopyToIst) {
      onCopyToIst({ start: preset.start, end: preset.end });
      copiedInSession.current = true;
    }
    setOpen(false);
  };

  // ---------------------------------------------------------------------------
  // Unified time commit
  // ---------------------------------------------------------------------------
  const handleSelCommit = () => {
    const ns = parseTimeStr(selStart);
    const ne = parseTimeStr(selEnd);
    if (!ns) { setSelError(`Ungültige Startzeit: "${selStart}"`); return; }
    if (!ne) { setSelError(`Ungültige Endzeit: "${selEnd}"`); return; }
    if (toMin(ns) === toMin(ne)) { setSelError('Start- und Endzeit dürfen nicht gleich sein'); return; }

    if (showSecond) {
      const ns2 = parseTimeStr(selStart2);
      const ne2 = parseTimeStr(selEnd2);
      if (!ns2) { setSelError(`Ungültige Startzeit 2: "${selStart2}"`); return; }
      if (!ne2) { setSelError(`Ungültige Endzeit 2: "${selEnd2}"`); return; }
      if (toMin(ns2) === toMin(ne2)) { setSelError('Start und Ende der 2. Schicht dürfen nicht gleich sein'); return; }
      if (rangesOverlap(ns, ne, ns2, ne2)) {
        setSelError('Die zwei Zeitblöcke überschneiden sich'); return;
      }
      setSelError('');
      onChange({ start: ns, end: ne }, null);
      if (onSplitTimeSelect) onSplitTimeSelect({ start: ns2, end: ne2 });
      if (copyToIst && onCopyToIst) {
        onCopyToIst({ start: ns, end: ne });
        copiedInSession.current = true;
      }
    } else {
      setSelError('');
      onChange({ start: ns, end: ne }, null);
      if (copyToIst && onCopyToIst) {
        onCopyToIst({ start: ns, end: ne });
        copiedInSession.current = true;
      }
    }
    setOpen(false);
  };

  const handleAbsenceSelect = (abbrev: string) => {
    onChange(null, abbrev);
    setOpen(false);
  };

  const handleClear = () => {
    onChange(null, null);
    setOpen(false);
  };

  // ---------------------------------------------------------------------------
  // Display value computation
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
      const alreadySet =
        !absenceType &&
        !!value?.start &&
        value.start === config?.start &&
        value.end === config?.end;

      return (
        <button
          onClick={() => onChange(null, null)}
          title={alreadySet ? 'Klicken zum Entfernen' : `${shiftName} eintragen`}
          className={cn(
            "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
            "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none",
            "cursor-crosshair",
            alreadySet && config?.color,
            alreadySet && "ring-1 ring-foreground/30",
            !alreadySet && absenceType && absenceConfig?.color,
            !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
            !alreadySet && !absenceType && !value?.start && emptyPaintClass,
          )}
        >
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
        onClick={() => onChange(null, null)}
        title={alreadySet ? 'Klicken zum Entfernen' : `${activeTool} eintragen`}
        className={cn(
          "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
          "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none",
          "cursor-crosshair",
          alreadySet && toolConfig?.color,
          alreadySet && "ring-1 ring-foreground/30",
          !alreadySet && absenceType && absenceConfig?.color,
          !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
          !alreadySet && !absenceType && !value?.start && emptyPaintClass,
        )}
      >
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

  // Helper: open clock picker for a target field
  const openPicker = (target: PickerTarget, currentVal: string) => {
    setPickerTarget(prev => prev === target ? null : target);
  };

  const applyPicker = (time: string) => {
    if (pickerTarget === 'start1') setSelStart(time);
    else if (pickerTarget === 'end1') setSelEnd(time);
    else if (pickerTarget === 'start2') setSelStart2(time);
    else if (pickerTarget === 'end2') setSelEnd2(time);
    setPickerTarget(null);
    setSelError('');
  };

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
              "hover:ring-1 hover:ring-ring focus:outline-none focus:ring-1 focus:ring-ring",
              !absenceType && !value?.start && !isDayOff && !isRequestedFree && !isBlocked && "bg-muted/30 border-dashed border-muted-foreground/20 text-muted-foreground",
              isWeekend && !isDayOff && !isRequestedFree && !isBlocked && "bg-primary/5",
              isEmptyDayOff && "bg-slate-300 dark:bg-slate-600 border-slate-400 dark:border-slate-500 text-slate-600 dark:text-slate-300 font-bold",
              isDayOff && !isEmptyDayOff && "ring-1 ring-slate-400/40 dark:ring-slate-500/40",
              isEmptyRequestedFree && "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 font-semibold",
              isRequestedFree && !isEmptyRequestedFree && "ring-1 ring-amber-400/60 dark:ring-amber-600/60",
              isEmptyBlocked && "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 font-semibold",
              isBlocked && !isEmptyBlocked && "ring-1 ring-red-400/60 dark:ring-red-600/60",
              absenceType && absenceConfig?.color,
              !absenceType && value?.start && !isRequestedFree && !isBlocked && !hasCellColor && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
            )}
            style={hasCellColor ? { backgroundColor: cellColor!, borderColor: cellColor!, color: '#1e3a5f' } : undefined}
          >
            {displayValue || (isEmptyDayOff ? 'F' : isEmptyRequestedFree ? 'WF' : isEmptyBlocked ? '⛔' : '—')}
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-72 p-2 z-50" align="center">
          <div className="space-y-2.5">

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
                <button
                  onClick={() => setBlockedOverride(true)}
                  className="w-full text-xs font-medium text-red-700 dark:text-red-400 border border-red-300 dark:border-red-700 rounded py-1 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                >
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
                {/* ── Header: slot label + clear ── */}
                <div className="flex items-center justify-between -mb-0.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    {slotType === 'früh' ? 'Frühschicht' : 'Spätschicht'}
                  </span>
                  {(value?.start || absenceType) && (
                    <button
                      onClick={handleClear}
                      className="text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-0.5 transition-colors"
                    >
                      <X className="h-3 w-3" /> Löschen
                    </button>
                  )}
                </div>

                {/* ════ SCHNELLWAHL ════════════════════════════════════ */}
                {filteredPresets.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Schnellwahl</div>
                    <div className="grid grid-cols-3 gap-1">
                      {filteredPresets.map(p => {
                        const hasSecond = !!(p.start2 && p.end2);
                        const lbl = hasSecond
                          ? `${formatShort(p.start)}-${formatShort(p.end)} +`
                          : p.label;
                        return (
                          <button
                            key={p.id}
                            onClick={() => handlePresetSelect(p)}
                            title={hasSecond
                              ? `${p.start}–${p.end} + ${p.start2}–${p.end2}`
                              : `${p.start}–${p.end}`}
                            className={cn(
                              "px-1 py-1.5 text-[10px] rounded border transition-colors font-medium text-center leading-tight",
                              "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700",
                              "text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800/50"
                            )}
                          >
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Split shifts from ShiftConfig */}
                {splitShifts.length > 0 && slotType === 'früh' && (
                  <div className="space-y-1">
                    <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Geteilt</div>
                    <div className="flex flex-wrap gap-1">
                      {splitShifts.map(shift => {
                        const cfg = shiftMap[shift];
                        if (!cfg) return null;
                        const lbl = `${formatShort(cfg.start)}-${formatShort(cfg.end)} / ${formatShort(cfg.start2!)}`;
                        return (
                          <button
                            key={shift}
                            onClick={() => handlePresetSelect(cfg as { start: string; end: string; start2?: string; end2?: string })}
                            title={`${cfg.start}-${cfg.end} + ${cfg.start2}-${cfg.end2} = ${cfg.hours}h`}
                            className={cn(
                              "px-2 py-1 text-[10px] rounded border transition-colors font-medium",
                              cfg.color, "hover:opacity-80"
                            )}
                          >
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Schnellwahl bearbeiten */}
                <button
                  onClick={() => { setOpen(false); setEditorOpen(true); }}
                  className="w-full text-[10px] text-muted-foreground hover:text-foreground border border-dashed rounded py-1 flex items-center justify-center gap-1 hover:border-primary/40 hover:bg-muted/30 transition-colors"
                >
                  <Settings2 className="h-3 w-3" />
                  Schnellwahl bearbeiten
                </button>

                {/* ════ MANUELLE ZEITEINGABE ════════════════════════════ */}
                <div className="border-t pt-2 space-y-2">
                  {/* 1. Schicht */}
                  <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">1. Schicht</div>
                  <div className="flex items-center gap-1.5">
                    {/* Von */}
                    <div className="flex-1">
                      <div className="text-[9px] text-muted-foreground mb-0.5">Von</div>
                      <div className="flex items-center gap-1">
                        <Input
                          value={selStart}
                          onChange={e => { setSelStart(e.target.value); setSelError(''); }}
                          onKeyDown={e => { if (e.key === 'Enter') handleSelCommit(); }}
                          placeholder="10:00"
                          className="h-7 text-xs font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => openPicker('start1', selStart)}
                          className={cn(
                            "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                            pickerTarget === 'start1'
                              ? "border-primary text-primary bg-primary/5"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                          )}
                        >
                          <Clock className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {pickerTarget === 'start1' && (
                        <InlineTimePicker
                          currentValue={selStart}
                          onConfirm={applyPicker}
                          onClose={() => setPickerTarget(null)}
                        />
                      )}
                    </div>
                    <span className="text-muted-foreground text-sm mt-3">–</span>
                    {/* Bis */}
                    <div className="flex-1">
                      <div className="text-[9px] text-muted-foreground mb-0.5">Bis</div>
                      <div className="flex items-center gap-1">
                        <Input
                          value={selEnd}
                          onChange={e => { setSelEnd(e.target.value); setSelError(''); }}
                          onKeyDown={e => { if (e.key === 'Enter') handleSelCommit(); }}
                          placeholder="14:00"
                          className="h-7 text-xs font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => openPicker('end1', selEnd)}
                          className={cn(
                            "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                            pickerTarget === 'end1'
                              ? "border-primary text-primary bg-primary/5"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                          )}
                        >
                          <Clock className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {pickerTarget === 'end1' && (
                        <InlineTimePicker
                          currentValue={selEnd}
                          onConfirm={applyPicker}
                          onClose={() => setPickerTarget(null)}
                        />
                      )}
                    </div>
                  </div>

                  {/* + Zweite Schicht toggle */}
                  <button
                    onClick={() => { setShowSecond(v => !v); setSelError(''); setPickerTarget(null); }}
                    className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                  >
                    {showSecond ? (
                      <><X className="h-3 w-3" /> Zweite Schicht entfernen</>
                    ) : (
                      <><span className="font-bold">+</span> Zweite Schicht</>
                    )}
                  </button>

                  {/* 2. Schicht */}
                  {showSecond && (
                    <div className="pl-2 border-l-2 border-blue-200 dark:border-blue-800 space-y-1.5">
                      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">2. Schicht</div>
                      <div className="flex items-center gap-1.5">
                        {/* Von 2 */}
                        <div className="flex-1">
                          <div className="text-[9px] text-muted-foreground mb-0.5">Von</div>
                          <div className="flex items-center gap-1">
                            <Input
                              value={selStart2}
                              onChange={e => { setSelStart2(e.target.value); setSelError(''); }}
                              onKeyDown={e => { if (e.key === 'Enter') handleSelCommit(); }}
                              placeholder="17:30"
                              className="h-7 text-xs font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => openPicker('start2', selStart2)}
                              className={cn(
                                "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                                pickerTarget === 'start2'
                                  ? "border-primary text-primary bg-primary/5"
                                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                              )}
                            >
                              <Clock className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {pickerTarget === 'start2' && (
                            <InlineTimePicker
                              currentValue={selStart2}
                              onConfirm={applyPicker}
                              onClose={() => setPickerTarget(null)}
                            />
                          )}
                        </div>
                        <span className="text-muted-foreground text-sm mt-3">–</span>
                        {/* Bis 2 */}
                        <div className="flex-1">
                          <div className="text-[9px] text-muted-foreground mb-0.5">Bis</div>
                          <div className="flex items-center gap-1">
                            <Input
                              value={selEnd2}
                              onChange={e => { setSelEnd2(e.target.value); setSelError(''); }}
                              onKeyDown={e => { if (e.key === 'Enter') handleSelCommit(); }}
                              placeholder="23:00"
                              className="h-7 text-xs font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => openPicker('end2', selEnd2)}
                              className={cn(
                                "h-7 w-7 shrink-0 flex items-center justify-center rounded border transition-colors",
                                pickerTarget === 'end2'
                                  ? "border-primary text-primary bg-primary/5"
                                  : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                              )}
                            >
                              <Clock className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {pickerTarget === 'end2' && (
                            <InlineTimePicker
                              currentValue={selEnd2}
                              onConfirm={applyPicker}
                              onClose={() => setPickerTarget(null)}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {selError && (
                    <div className="text-[10px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded px-2 py-1">
                      {selError}
                    </div>
                  )}

                  {/* IST checkbox — shown here before Übernehmen */}
                  {onCopyToIst && !absenceType && (
                    <div
                      className="flex items-center gap-2"
                      onClick={e => e.stopPropagation()}
                    >
                      <Checkbox
                        id="copy-to-ist-cb"
                        checked={copyToIst}
                        onCheckedChange={checked => setCopyToIst(!!checked)}
                        className="h-3.5 w-3.5 data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
                      />
                      <label
                        htmlFor="copy-to-ist-cb"
                        className="text-[10px] text-foreground cursor-pointer select-none leading-tight"
                      >
                        Auch ins IST übernehmen
                      </label>
                    </div>
                  )}

                  {/* Übernehmen */}
                  <button
                    onClick={handleSelCommit}
                    className="w-full text-xs bg-primary text-primary-foreground rounded py-1.5 hover:bg-primary/90 transition-colors font-medium"
                  >
                    Übernehmen
                  </button>
                </div>

                {/* ── Absence shortcuts ── */}
                {filteredAbsenceShifts.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1.5 border-t">
                    {filteredAbsenceShifts.map(shift => {
                      const cfg = shiftMap[shift];
                      if (!cfg) return null;
                      return (
                        <button
                          key={shift}
                          onClick={() => handleAbsenceSelect(cfg.abbrev)}
                          className={cn(
                            "px-2 py-0.5 text-xs rounded border transition-colors",
                            cfg.color, "hover:opacity-80"
                          )}
                        >
                          {cfg.abbrev}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* ── Copy / Paste ── */}
                <div className="flex gap-1 pt-1 border-t">
                  {value?.start && (
                    <button
                      onClick={() => { onCopyShift?.(value); setOpen(false); }}
                      title="Schichtzeit kopieren"
                      className="flex-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 py-1 rounded border border-blue-200 dark:border-blue-700 transition-colors"
                    >
                      📋 Kopieren
                    </button>
                  )}
                  {copiedShift?.start && (
                    <button
                      onClick={() => { onChange(copiedShift, null); setOpen(false); }}
                      title={`${copiedShift.start}–${copiedShift.end} einfügen`}
                      className="flex-1 text-xs text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 py-1 rounded border border-green-200 dark:border-green-700 transition-colors"
                    >
                      📌 {formatShort(copiedShift.start)}-{formatShort(copiedShift.end)}
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
                          <button
                            key={c.hex}
                            title={isActive ? `${c.label} (entfernen)` : c.label}
                            onClick={() => onCellColorChange(isActive ? null : c.hex)}
                            className={cn(
                              "w-4 h-4 rounded-full transition-all shrink-0",
                              isActive ? "ring-2 ring-offset-1 ring-foreground scale-110" : "ring-1 ring-border hover:scale-110"
                            )}
                            style={{ backgroundColor: c.hex }}
                          />
                        );
                      })}
                      {cellColor && (
                        <button
                          onClick={() => onCellColorChange(null)}
                          className="text-[9px] text-muted-foreground hover:text-destructive ml-0.5"
                          title="Farbe zurücksetzen"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Delete (fallback, shown when value already set) ── */}
                {(value?.start || absenceType) && (
                  <button
                    onClick={handleClear}
                    className="w-full text-xs text-muted-foreground hover:text-foreground py-1 border-t"
                  >
                    Löschen
                  </button>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Schnellwahl editor dialog (outside popover to avoid z-index issues) */}
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
