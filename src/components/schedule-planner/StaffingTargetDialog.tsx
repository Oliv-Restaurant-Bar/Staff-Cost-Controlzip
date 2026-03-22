import { useState, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Target, Plus, Trash2, Check, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  StaffingTarget, loadTargets, upsertTarget, deleteTarget,
  WEEKDAY_SHORT, WEEKDAY_LONG, SLOT_LABEL, STATUS_CLASSES,
} from '@/lib/staffing-targets';
import { Department } from '@/types/personnel';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

// ─── Helfer ───────────────────────────────────────────────────────────────────

function NumInput({
  value, onChange, min = 0, max = 20,
}: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-1">
      <button
        className="w-5 h-5 rounded text-xs bg-muted hover:bg-muted/80 border border-border font-bold leading-none"
        onClick={() => onChange(Math.max(min, value - 1))}
      >−</button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums">{value}</span>
      <button
        className="w-5 h-5 rounded text-xs bg-muted hover:bg-muted/80 border border-border font-bold leading-none"
        onClick={() => onChange(Math.min(max, value + 1))}
      >+</button>
    </div>
  );
}

function Toggle<T extends string>({
  value, options, onChange, labelMap,
}: {
  value: T; options: T[];
  onChange: (v: T) => void;
  labelMap: Record<string, string>;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            'px-2 py-0.5 rounded border text-xs font-medium transition-colors',
            value === o
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
          )}
        >
          {labelMap[o]}
        </button>
      ))}
    </div>
  );
}

// ─── Ziel-Karte ───────────────────────────────────────────────────────────────

function TargetRow({
  target, onDelete, onUpdate,
}: {
  target: StaffingTarget;
  onDelete: () => void;
  onUpdate: (t: StaffingTarget) => void;
}) {
  const [min, setMin]     = useState(target.minStaff);
  const [ideal, setIdeal] = useState(target.idealStaff);
  const [saved, setSaved] = useState(false);

  const dirty = min !== target.minStaff || ideal !== target.idealStaff;

  const handleSave = () => {
    const updated = { ...target, minStaff: min, idealStaff: Math.max(min, ideal) };
    onUpdate(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const deptColor = target.department === 'service'
    ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300'
    : 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300';
  const slotColor = target.slot === 'früh'
    ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300'
    : 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300';

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-card">
      {/* Labels */}
      <div className="flex items-center gap-1.5 flex-1 flex-wrap min-w-0">
        <Badge variant="outline" className={cn('text-xs border shrink-0', deptColor)}>
          {target.department === 'service' ? 'Service' : 'Küche'}
        </Badge>
        <span className="text-sm font-semibold shrink-0">{WEEKDAY_LONG[target.dayOfWeek]}</span>
        <Badge variant="outline" className={cn('text-xs border shrink-0', slotColor)}>
          {SLOT_LABEL[target.slot]}
        </Badge>
      </div>

      {/* Min */}
      <div className="flex flex-col items-center gap-0.5 shrink-0">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Mind.</span>
        <NumInput value={min} onChange={v => { setMin(v); if (v > ideal) setIdeal(v); }} />
      </div>

      {/* Ideal */}
      <div className="flex flex-col items-center gap-0.5 shrink-0">
        <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Ideal</span>
        <NumInput value={ideal} onChange={v => setIdeal(Math.max(min, v))} />
      </div>

      {/* Actions */}
      {dirty ? (
        <Button size="sm" className="h-6 px-2 gap-1 text-xs shrink-0" onClick={handleSave}>
          {saved ? <Check className="h-3 w-3" /> : 'Speichern'}
        </Button>
      ) : saved ? (
        <Check className="h-4 w-4 text-emerald-500 shrink-0" />
      ) : null}
      <button
        onClick={onDelete}
        className="p-1 text-muted-foreground hover:text-red-500 transition-colors shrink-0"
        title="Ziel löschen"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── Neue-Ziel-Formular ───────────────────────────────────────────────────────

const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const ALL_SLOTS    = ['früh', 'spät'] as const;
const ALL_DEPTS    = ['service', 'küche'] as const;

function AddTargetForm({
  existing, onAdded,
}: { existing: StaffingTarget[]; onAdded: () => void }) {
  const [dept, setDept]     = useState<Department>('service');
  const [dow, setDow]       = useState<number>(1);
  const [slot, setSlot]     = useState<'früh' | 'spät'>('früh');
  const [min, setMin]       = useState(2);
  const [ideal, setIdeal]   = useState(3);
  const [error, setError]   = useState('');

  const isDuplicate = existing.some(
    t => t.department === dept && t.dayOfWeek === dow && t.slot === slot
  );

  const handleAdd = () => {
    if (isDuplicate) { setError('Diese Kombination existiert bereits.'); return; }
    upsertTarget({
      id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      department: dept, dayOfWeek: dow, slot,
      minStaff: min, idealStaff: Math.max(min, ideal),
    });
    setError('');
    onAdded();
  };

  return (
    <div className="rounded-lg border-2 border-dashed border-border bg-muted/10 p-3 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        Neues Besetzungsziel
      </p>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">Abteilung</p>
          <Toggle
            value={dept}
            options={[...ALL_DEPTS]}
            onChange={setDept}
            labelMap={{ service: 'Service', küche: 'Küche' }}
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">Wochentag</p>
          <Toggle
            value={String(dow)}
            options={ALL_WEEKDAYS.map(String)}
            onChange={v => setDow(Number(v))}
            labelMap={Object.fromEntries(ALL_WEEKDAYS.map(d => [String(d), WEEKDAY_SHORT[d]]))}
          />
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">Schicht</p>
          <Toggle
            value={slot}
            options={[...ALL_SLOTS]}
            onChange={setSlot}
            labelMap={{ früh: 'Früh', spät: 'Spät' }}
          />
        </div>
        <div className="flex gap-3 items-end">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">Mindest</p>
            <NumInput value={min} onChange={v => { setMin(v); if (v > ideal) setIdeal(v); }} />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">Ideal</p>
            <NumInput value={ideal} onChange={v => setIdeal(Math.max(min, v))} />
          </div>
          <Button size="sm" className="h-7 gap-1.5" onClick={handleAdd} disabled={isDuplicate}>
            <Plus className="h-3.5 w-3.5" />
            Hinzufügen
          </Button>
        </div>
      </div>

      {isDuplicate && (
        <p className="text-xs text-orange-600 dark:text-orange-400 flex items-center gap-1">
          <Info className="h-3 w-3" />
          Diese Kombination existiert bereits — bearbeite sie direkt in der Liste.
        </p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

// ─── Hauptdialog ──────────────────────────────────────────────────────────────

export function StaffingTargetDialog({ open, onClose }: Props) {
  const [targets, setTargets] = useState<StaffingTarget[]>([]);

  const reload = () => setTargets(loadTargets());
  useEffect(() => { if (open) reload(); }, [open]);

  const handleDelete = (id: string) => { deleteTarget(id); reload(); };
  const handleUpdate = (t: StaffingTarget) => { upsertTarget(t); reload(); };

  // Group by dept for cleaner display
  const service = targets.filter(t => t.department === 'service');
  const küche   = targets.filter(t => t.department === 'küche');

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5 text-rose-500" />
            Besetzungsziele
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Definiere Mindest- und Idealbesetzung pro Schicht, Wochentag und Abteilung.
            Der Dienstplan zeigt dir dann farbige Warnungen bei Unter- oder Überbesetzung.
          </DialogDescription>
        </DialogHeader>

        {/* Legend */}
        <div className="flex flex-wrap gap-2 shrink-0">
          {(['under', 'ok', 'over'] as const).map(s => (
            <span key={s} className={cn('px-2 py-0.5 rounded border text-xs font-medium', STATUS_CLASSES[s])}>
              {s === 'under' ? '↓ Unter Mindestbesetzung' : s === 'ok' ? '✓ Im Zielbereich' : '↑ Über Idealbesetzung'}
            </span>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 min-h-0 space-y-4 pr-0.5">
          {/* Add form */}
          <AddTargetForm existing={targets} onAdded={reload} />

          {/* Service */}
          {service.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                Service
              </p>
              {service
                .sort((a, b) => a.dayOfWeek !== b.dayOfWeek ? a.dayOfWeek - b.dayOfWeek : (a.slot === 'früh' ? -1 : 1))
                .map(t => (
                  <TargetRow key={t.id} target={t} onDelete={() => handleDelete(t.id)} onUpdate={handleUpdate} />
                ))}
            </div>
          )}

          {/* Küche */}
          {küche.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
                Küche
              </p>
              {küche
                .sort((a, b) => a.dayOfWeek !== b.dayOfWeek ? a.dayOfWeek - b.dayOfWeek : (a.slot === 'früh' ? -1 : 1))
                .map(t => (
                  <TargetRow key={t.id} target={t} onDelete={() => handleDelete(t.id)} onUpdate={handleUpdate} />
                ))}
            </div>
          )}

          {targets.length === 0 && (
            <div className="text-center py-8">
              <Target className="h-8 w-8 text-muted-foreground mx-auto opacity-30 mb-2" />
              <p className="text-sm text-muted-foreground">
                Noch keine Besetzungsziele definiert.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Füge oben das erste Ziel hinzu — z.B. Service Montag Früh: mind. 2, ideal 3.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center pt-2 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            {targets.length} Ziel{targets.length !== 1 ? 'e' : ''} gespeichert · lokal im Browser
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
