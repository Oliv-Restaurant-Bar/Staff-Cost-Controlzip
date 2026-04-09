import { useState, useMemo } from 'react';
import { format, eachDayOfInterval, isWeekend, getDay, addDays, startOfMonth, endOfMonth } from 'date-fns';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Zap, CalendarX2, CalendarDays, Copy, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { toast } from 'sonner';

// ── Types ─────────────────────────────────────────────────────────────────────

type ActualHourEntry = { hours: number; start?: string; end?: string };

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, ActualHourEntry>;
  currentMonth: Date;
  onApply: (delta: Record<string, DaySchedule>) => void;
  onApplyActual: (delta: Record<string, ActualHourEntry>) => void;
}

type Tab = 'absence' | 'shift' | 'copy' | 'autofrei';
type AutoFreiTarget = 'plan' | 'ist' | 'beide';
type AbsenceSlot = 'früh' | 'spät' | 'beide';
type CopyMode = 'overwrite' | 'merge';

const WEEKDAYS = [
  { label: 'Mo', value: 1 },
  { label: 'Di', value: 2 },
  { label: 'Mi', value: 3 },
  { label: 'Do', value: 4 },
  { label: 'Fr', value: 5 },
  { label: 'Sa', value: 6 },
  { label: 'So', value: 0 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseLocalDate(str: string): Date {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toMonday(d: Date): Date {
  const day = getDay(d);
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BulkActionsDialog({
  open, onClose, employees, scheduleData, actualHoursData, currentMonth, onApply, onApplyActual,
}: Props) {
  const { shiftMap, shifts } = useShiftConfig();

  const workItems  = useMemo(() => shifts.filter(s => s.start && s.end), [shifts]);
  const absItems   = useMemo(() => shifts.filter(s => !s.start || !s.end), [shifts]);

  const monthStart = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
  const monthEnd   = format(endOfMonth(currentMonth),   'yyyy-MM-dd');

  const todayMonday = format(toMonday(new Date()), 'yyyy-MM-dd');

  const [tab, setTab] = useState<Tab>('absence');

  // ── Absence tab state ────────────────────────────────────────────────────
  const [absEmpId,       setAbsEmpId]       = useState('');
  const [absCode,        setAbsCode]        = useState('');    // abbreviation
  const [absSlot,        setAbsSlot]        = useState<AbsenceSlot>('beide');
  const [absStart,       setAbsStart]       = useState(monthStart);
  const [absEnd,         setAbsEnd]         = useState(monthEnd);
  const [absSkipWeekend, setAbsSkipWeekend] = useState(true);

  // ── Shift-fill tab state ─────────────────────────────────────────────────
  const [sfEmpId,    setSfEmpId]    = useState('');
  const [sfShift,    setSfShift]    = useState('');             // shift name
  const [sfSlot,     setSfSlot]     = useState<'auto' | 'früh' | 'spät'>('auto');
  const [sfStart,    setSfStart]    = useState(monthStart);
  const [sfEnd,      setSfEnd]      = useState(monthEnd);
  const [sfDays,     setSfDays]     = useState<number[]>([1, 2, 3, 4, 5]); // Mon–Fri
  const [sfOverwrite, setSfOverwrite] = useState(false);

  // ── Copy-week tab state ──────────────────────────────────────────────────
  const [cpSrcEmp,  setCpSrcEmp]  = useState('');
  const [cpSrcWeek, setCpSrcWeek] = useState(todayMonday);
  const [cpTgtEmp,  setCpTgtEmp]  = useState('');
  const [cpTgtWeek, setCpTgtWeek] = useState(todayMonday);
  const [cpMode,    setCpMode]    = useState<CopyMode>('overwrite');

  // ── Auto-Frei tab state ──────────────────────────────────────────────────
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const [afCutoff,      setAfCutoff]      = useState(todayStr);
  const [afEmpId,       setAfEmpId]       = useState('__alle__');
  const [afSkipWeekend, setAfSkipWeekend] = useState(true);
  const [afTarget,      setAfTarget]      = useState<AutoFreiTarget>('beide');

  // ── Previews ─────────────────────────────────────────────────────────────

  const absPreview = useMemo(() => {
    if (!absEmpId || !absCode) return null;
    try {
      const days    = eachDayOfInterval({ start: parseLocalDate(absStart), end: parseLocalDate(absEnd) });
      const active  = days.filter(d => !absSkipWeekend || !isWeekend(d));
      const slots   = absSlot === 'beide' ? 2 : 1;
      return { days: active.length, slots: active.length * slots };
    } catch { return null; }
  }, [absEmpId, absCode, absStart, absEnd, absSkipWeekend, absSlot]);

  const sfPreview = useMemo(() => {
    if (!sfEmpId || !sfShift) return null;
    try {
      const days   = eachDayOfInterval({ start: parseLocalDate(sfStart), end: parseLocalDate(sfEnd) });
      const active = days.filter(d => sfDays.includes(getDay(d)));
      return { days: active.length };
    } catch { return null; }
  }, [sfEmpId, sfShift, sfStart, sfEnd, sfDays]);

  const cpPreview = useMemo(() => {
    if (!cpSrcEmp || !cpTgtEmp) return null;
    let found = 0;
    for (let i = 0; i < 7; i++) {
      const ds = format(addDays(parseLocalDate(cpSrcWeek), i), 'yyyy-MM-dd');
      if (scheduleData[`${cpSrcEmp}-${ds}`]) found++;
    }
    return { shifts: found };
  }, [cpSrcEmp, cpTgtEmp, cpSrcWeek, scheduleData]);

  const afPreview = useMemo(() => {
    try {
      const start = startOfMonth(currentMonth);
      const end   = parseLocalDate(afCutoff < monthStart ? monthStart : afCutoff > monthEnd ? monthEnd : afCutoff);
      if (end < start) return { planCount: 0, istCount: 0 };
      const days = eachDayOfInterval({ start, end });
      const activeDays = days.filter(d => !afSkipWeekend || !isWeekend(d));
      const targetEmps = afEmpId === '__alle__' ? employees : employees.filter(e => e.id === afEmpId);

      let planCount = 0;
      let istCount  = 0;
      for (const emp of targetEmps) {
        for (const day of activeDays) {
          const dateStr = format(day, 'yyyy-MM-dd');
          const key     = `${emp.id}-${dateStr}`;
          const plan    = scheduleData[key];
          const isEmpty = !plan || (!plan.früh && !plan.spät && !plan.frühAbsence && !plan.spätAbsence);
          if (isEmpty) planCount++;
          if (!actualHoursData[key]) istCount++;
        }
      }
      return { planCount, istCount };
    } catch { return null; }
  }, [afCutoff, afEmpId, afSkipWeekend, employees, scheduleData, actualHoursData, currentMonth, monthStart, monthEnd]);

  // ── Apply handlers ────────────────────────────────────────────────────────

  const applyAbsence = () => {
    if (!absEmpId)  { toast.error('Bitte Mitarbeiter auswählen'); return; }
    if (!absCode)   { toast.error('Bitte Abwesenheitsart auswählen'); return; }
    try {
      const days    = eachDayOfInterval({ start: parseLocalDate(absStart), end: parseLocalDate(absEnd) });
      const active  = days.filter(d => !absSkipWeekend || !isWeekend(d));
      const delta: Record<string, DaySchedule> = {};

      for (const day of active) {
        const dateStr = format(day, 'yyyy-MM-dd');
        const key     = `${absEmpId}-${dateStr}`;
        const entry: DaySchedule = { ...(scheduleData[key] ?? {}) };
        if (absSlot === 'früh'  || absSlot === 'beide') { entry.früh = null; entry.frühAbsence = absCode; }
        if (absSlot === 'spät'  || absSlot === 'beide') { entry.spät = null; entry.spätAbsence = absCode; }
        delta[key] = entry;
      }

      onApply(delta);
      const emp = employees.find(e => e.id === absEmpId);
      toast.success(`${active.length} Tag(e) als „${absCode}" eingetragen für ${emp?.name ?? absEmpId}`);
      onClose();
    } catch { toast.error('Fehler beim Anwenden der Abwesenheit'); }
  };

  const applyShiftFill = () => {
    if (!sfEmpId) { toast.error('Bitte Mitarbeiter auswählen'); return; }
    if (!sfShift) { toast.error('Bitte Schicht auswählen'); return; }
    const cfg = shiftMap[sfShift];
    if (!cfg)    { toast.error('Schicht nicht gefunden'); return; }

    try {
      const days   = eachDayOfInterval({ start: parseLocalDate(sfStart), end: parseLocalDate(sfEnd) });
      const active = days.filter(d => sfDays.includes(getDay(d)));
      const delta: Record<string, DaySchedule> = {};

      for (const day of active) {
        const dateStr = format(day, 'yyyy-MM-dd');
        const key     = `${sfEmpId}-${dateStr}`;
        const existing: DaySchedule = scheduleData[key] ?? {};

        // Determine target slot
        let targetSlot: 'früh' | 'spät';
        if (sfSlot === 'auto') {
          targetSlot = parseInt(cfg.start.split(':')[0], 10) < 16 ? 'früh' : 'spät';
        } else {
          targetSlot = sfSlot;
        }

        // Skip if occupied and not overwriting
        if (!sfOverwrite) {
          if (targetSlot === 'früh' && (existing.früh || existing.frühAbsence)) continue;
          if (targetSlot === 'spät' && (existing.spät || existing.spätAbsence)) continue;
        }

        const entry: DaySchedule = { ...existing };
        const slot: TimeSlot     = { start: cfg.start, end: cfg.end };

        if (cfg.start2 && cfg.end2) {
          // Split shift → fill both
          entry.früh        = slot;
          entry.frühAbsence = null;
          entry.spät        = { start: cfg.start2, end: cfg.end2 };
          entry.spätAbsence = null;
        } else {
          entry[targetSlot]                                                    = slot;
          entry[`${targetSlot}Absence` as 'frühAbsence' | 'spätAbsence']     = null;
        }

        delta[key] = entry;
      }

      const count = Object.keys(delta).length;
      if (count === 0) {
        toast.info('Keine freien Slots gefunden – „Überschreiben" aktivieren?');
        return;
      }
      onApply(delta);
      const emp = employees.find(e => e.id === sfEmpId);
      toast.success(`${count} Tag(e) mit „${sfShift}" eingetragen für ${emp?.name ?? sfEmpId}`);
      onClose();
    } catch { toast.error('Fehler beim Füllen der Schichten'); }
  };

  const applyCopyWeek = () => {
    if (!cpSrcEmp) { toast.error('Bitte Quell-Mitarbeiter auswählen'); return; }
    if (!cpTgtEmp) { toast.error('Bitte Ziel-Mitarbeiter auswählen'); return; }
    try {
      const delta: Record<string, DaySchedule> = {};
      let count = 0;

      for (let i = 0; i < 7; i++) {
        const srcDate = format(addDays(parseLocalDate(cpSrcWeek), i), 'yyyy-MM-dd');
        const tgtDate = format(addDays(parseLocalDate(cpTgtWeek), i), 'yyyy-MM-dd');
        const srcKey  = `${cpSrcEmp}-${srcDate}`;
        const tgtKey  = `${cpTgtEmp}-${tgtDate}`;
        const src     = scheduleData[srcKey];
        if (!src) continue;

        if (cpMode === 'overwrite') {
          delta[tgtKey] = { ...src };
        } else {
          const tgt = scheduleData[tgtKey] ?? {};
          delta[tgtKey] = {
            früh:        tgt.früh        ?? src.früh,
            spät:        tgt.spät        ?? src.spät,
            frühAbsence: tgt.frühAbsence ?? src.frühAbsence,
            spätAbsence: tgt.spätAbsence ?? src.spätAbsence,
          };
        }
        count++;
      }

      if (count === 0) { toast.info('Quellwoche enthält keine Schichten'); return; }
      onApply(delta);
      const src = employees.find(e => e.id === cpSrcEmp);
      const tgt = employees.find(e => e.id === cpTgtEmp);
      toast.success(`${count} Tag(e) von ${src?.name ?? 'Quelle'} nach ${tgt?.name ?? 'Ziel'} kopiert`);
      onClose();
    } catch { toast.error('Fehler beim Kopieren der Woche'); }
  };

  const applyAutoFrei = () => {
    try {
      const start      = startOfMonth(currentMonth);
      const cutoff     = afCutoff < monthStart ? monthStart : afCutoff > monthEnd ? monthEnd : afCutoff;
      const end        = parseLocalDate(cutoff);
      if (end < start) { toast.info('Stichtag liegt vor Monatsbeginn'); return; }
      const days       = eachDayOfInterval({ start, end });
      const activeDays = days.filter(d => !afSkipWeekend || !isWeekend(d));
      const targetEmps = afEmpId === '__alle__' ? employees : employees.filter(e => e.id === afEmpId);

      const planDelta: Record<string, DaySchedule>     = {};
      const istDelta:  Record<string, ActualHourEntry>  = {};

      for (const emp of targetEmps) {
        for (const day of activeDays) {
          const dateStr = format(day, 'yyyy-MM-dd');
          const key     = `${emp.id}-${dateStr}`;

          if (afTarget === 'plan' || afTarget === 'beide') {
            const plan    = scheduleData[key];
            const isEmpty = !plan || (!plan.früh && !plan.spät && !plan.frühAbsence && !plan.spätAbsence);
            if (isEmpty) planDelta[key] = { früh: null, spät: null, frühAbsence: 'F', spätAbsence: null };
          }

          if (afTarget === 'ist' || afTarget === 'beide') {
            if (!actualHoursData[key]) istDelta[key] = { hours: 0 };
          }
        }
      }

      const planCount = Object.keys(planDelta).length;
      const istCount  = Object.keys(istDelta).length;

      if (planCount === 0 && istCount === 0) {
        toast.info('Alle Felder sind bereits gefüllt – nichts zu tun.');
        return;
      }
      if (planCount > 0) onApply(planDelta);
      if (istCount  > 0) onApplyActual(istDelta);

      const parts: string[] = [];
      if (planCount > 0) parts.push(`${planCount} Plan-Zelle(n) → F`);
      if (istCount  > 0) parts.push(`${istCount} Ist-Zelle(n) → 0h`);
      toast.success(`Auto-Frei: ${parts.join(', ')}`);
      onClose();
    } catch { toast.error('Fehler beim Auto-Frei-Auffüllen'); }
  };

  // ── Shared UI fragments ───────────────────────────────────────────────────

  const empSelect = (value: string, onChange: (v: string) => void, placeholder: string) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {employees.map(e => (
          <SelectItem key={e.id} value={e.id} className="text-xs">{e.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const toggleBtn = (
    active: boolean,
    onClick: () => void,
    label: string,
    className?: string,
  ) => (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 py-1 text-xs rounded border transition-colors',
        active
          ? 'bg-foreground text-background border-foreground'
          : 'border-border text-muted-foreground hover:bg-muted',
        className,
      )}
    >
      {label}
    </button>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-500" />
            Schnellaktionen
          </DialogTitle>
          <DialogDescription>
            Schichten und Abwesenheiten schnell über mehrere Tage einplanen
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 bg-muted/60 rounded-lg p-0.5 shrink-0">
          {([
            { id: 'absence'  as Tab, label: 'Abwesenheit',   icon: <CalendarX2   className="h-3.5 w-3.5" /> },
            { id: 'shift'    as Tab, label: 'Schicht',        icon: <CalendarDays className="h-3.5 w-3.5" /> },
            { id: 'copy'     as Tab, label: 'Kopieren',       icon: <Copy         className="h-3.5 w-3.5" /> },
            { id: 'autofrei' as Tab, label: 'Auto-Frei',      icon: <Wand2        className="h-3.5 w-3.5" /> },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors',
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* ── ABWESENHEIT ──────────────────────────────────────────────────── */}
        {tab === 'absence' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Trägt Urlaub, Krankheit oder eine andere Abwesenheit für einen Mitarbeiter über einen Zeitraum ein.
            </p>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Mitarbeiter</Label>
              {empSelect(absEmpId, setAbsEmpId, 'Mitarbeiter wählen…')}
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold">Abwesenheitsart</Label>
              <div className="flex flex-wrap gap-1.5">
                {absItems.length === 0 && (
                  <p className="text-xs text-muted-foreground">Keine Abwesenheitsarten konfiguriert</p>
                )}
                {absItems.map(s => {
                  const code = shiftMap[s.name]?.abbrev ?? s.name;
                  return (
                    <button
                      key={s.name}
                      onClick={() => setAbsCode(code)}
                      className={cn(
                        'px-2.5 py-1 rounded border text-xs font-semibold transition-all',
                        s.color,
                        absCode === code && 'ring-2 ring-offset-1 ring-foreground scale-105',
                      )}
                    >
                      {code} — {s.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Schicht-Slot</Label>
              <div className="flex gap-1.5">
                {toggleBtn(absSlot === 'früh',  () => setAbsSlot('früh'),  'Früh')}
                {toggleBtn(absSlot === 'spät',  () => setAbsSlot('spät'),  'Spät')}
                {toggleBtn(absSlot === 'beide', () => setAbsSlot('beide'), 'Beide')}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Von</Label>
                <input
                  type="date" value={absStart} min={monthStart} max={monthEnd}
                  onChange={e => setAbsStart(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Bis</Label>
                <input
                  type="date" value={absEnd} min={absStart || monthStart} max={monthEnd}
                  onChange={e => setAbsEnd(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox id="abs-skip" checked={absSkipWeekend} onCheckedChange={v => setAbsSkipWeekend(!!v)} />
              <Label htmlFor="abs-skip" className="text-xs cursor-pointer">Wochenenden überspringen</Label>
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {absPreview
                  ? `${absPreview.days} Tag(e) · ${absPreview.slots} Slot(s) werden belegt`
                  : 'Bitte alle Felder ausfüllen'}
              </span>
              <Button size="sm" onClick={applyAbsence} disabled={!absPreview || absPreview.days === 0}>
                Anwenden
              </Button>
            </div>
          </div>
        )}

        {/* ── SCHICHT FÜLLEN ────────────────────────────────────────────────── */}
        {tab === 'shift' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Füllt einen Datumsbereich für einen Mitarbeiter mit derselben Schicht. Für bestimmte Wochentage auswählbar.
            </p>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Mitarbeiter</Label>
              {empSelect(sfEmpId, setSfEmpId, 'Mitarbeiter wählen…')}
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-semibold">Schicht</Label>
              <div className="flex flex-wrap gap-1.5">
                {workItems.map(s => (
                  <button
                    key={s.name}
                    onClick={() => setSfShift(s.name)}
                    title={`${s.name} · ${s.start}–${s.end}`}
                    className={cn(
                      'px-2 py-1 rounded border text-xs font-semibold transition-all',
                      s.color,
                      sfShift === s.name && 'ring-2 ring-offset-1 ring-foreground scale-105',
                    )}
                  >
                    {s.abbrev}
                  </button>
                ))}
              </div>
              {sfShift && shiftMap[sfShift] && (
                <p className="text-[10px] text-muted-foreground">
                  {sfShift} · {shiftMap[sfShift].start}–{shiftMap[sfShift].end}
                  {shiftMap[sfShift].start2 ? ` / ${shiftMap[sfShift].start2}–${shiftMap[sfShift].end2}` : ''}
                  · {shiftMap[sfShift].hours}h
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Slot-Zuweisung</Label>
              <div className="flex gap-1.5">
                {toggleBtn(sfSlot === 'auto', () => setSfSlot('auto'), 'Automatisch')}
                {toggleBtn(sfSlot === 'früh', () => setSfSlot('früh'), 'Immer Früh')}
                {toggleBtn(sfSlot === 'spät', () => setSfSlot('spät'), 'Immer Spät')}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Automatisch: Schicht vor 16:00 Uhr → Früh-Slot, ab 16:00 → Spät-Slot.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Von</Label>
                <input
                  type="date" value={sfStart} min={monthStart} max={monthEnd}
                  onChange={e => setSfStart(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Bis</Label>
                <input
                  type="date" value={sfEnd} min={sfStart || monthStart} max={monthEnd}
                  onChange={e => setSfEnd(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Wochentage</Label>
              <div className="flex gap-1">
                {WEEKDAYS.map(wd => {
                  const active = sfDays.includes(wd.value);
                  return (
                    <button
                      key={wd.value}
                      onClick={() => setSfDays(prev =>
                        active ? prev.filter(d => d !== wd.value) : [...prev, wd.value]
                      )}
                      className={cn(
                        'flex-1 py-1 text-[10px] font-semibold rounded border transition-colors',
                        active
                          ? 'bg-foreground text-background border-foreground'
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {wd.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox id="sf-overwrite" checked={sfOverwrite} onCheckedChange={v => setSfOverwrite(!!v)} />
              <Label htmlFor="sf-overwrite" className="text-xs cursor-pointer">
                Bestehende Einträge überschreiben
              </Label>
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {sfPreview
                  ? `${sfPreview.days} Tag(e) im Bereich`
                  : 'Bitte alle Felder ausfüllen'}
              </span>
              <Button size="sm" onClick={applyShiftFill} disabled={!sfPreview || sfPreview.days === 0}>
                Anwenden
              </Button>
            </div>
          </div>
        )}

        {/* ── WOCHE KOPIEREN ───────────────────────────────────────────────── */}
        {tab === 'copy' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Kopiert alle Schichten einer Mitarbeiterwoche (Mo–So) auf einen anderen Mitarbeiter oder eine andere Woche.
            </p>

            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Quelle</p>
              <div className="space-y-1">
                <Label className="text-xs">Mitarbeiter</Label>
                {empSelect(cpSrcEmp, setCpSrcEmp, 'Quell-Mitarbeiter…')}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Wochenbeginn</Label>
                <input
                  type="date" value={cpSrcWeek}
                  onChange={e => setCpSrcWeek(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
                <p className="text-[10px] text-muted-foreground">Beliebigen Tag der Woche wählen — wird auf Montag gerundet.</p>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Ziel</p>
              <div className="space-y-1">
                <Label className="text-xs">Mitarbeiter</Label>
                {empSelect(cpTgtEmp, setCpTgtEmp, 'Ziel-Mitarbeiter…')}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Wochenbeginn</Label>
                <input
                  type="date" value={cpTgtWeek}
                  onChange={e => setCpTgtWeek(e.target.value)}
                  className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Modus</Label>
              <div className="flex gap-1.5">
                {toggleBtn(cpMode === 'overwrite', () => setCpMode('overwrite'), 'Überschreiben')}
                {toggleBtn(cpMode === 'merge',     () => setCpMode('merge'),     'Zusammenführen')}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {cpMode === 'overwrite'
                  ? 'Alle bestehenden Einträge im Ziel werden ersetzt.'
                  : 'Nur leere Slots im Ziel werden gefüllt.'}
              </p>
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {cpPreview
                  ? `${cpPreview.shifts} Tag(e) in der Quellwoche gefunden`
                  : 'Bitte Quelle und Ziel auswählen'}
              </span>
              <Button
                size="sm"
                onClick={applyCopyWeek}
                disabled={!cpPreview || cpPreview.shifts === 0}
              >
                Kopieren
              </Button>
            </div>
          </div>
        )}

        {/* ── AUTO-FREI ────────────────────────────────────────────────────── */}
        {tab === 'autofrei' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Füllt alle leeren Felder bis zum Stichtag automatisch mit <strong>Frei (F)</strong> auf.
              Bereits eingetragene Schichten, Abwesenheiten und Ist-Stunden werden <em>nicht</em> überschrieben.
            </p>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Stichtag (inklusive)</Label>
              <input
                type="date"
                value={afCutoff}
                min={monthStart}
                max={monthEnd}
                onChange={e => setAfCutoff(e.target.value)}
                className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
              />
              <p className="text-[10px] text-muted-foreground">
                Alle Tage vom Monatsanfang bis zu diesem Datum werden geprüft.
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Mitarbeiter</Label>
              <Select value={afEmpId} onValueChange={setAfEmpId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Mitarbeiter wählen…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__alle__" className="text-xs font-semibold">— Alle Mitarbeiter —</SelectItem>
                  {employees.map(e => (
                    <SelectItem key={e.id} value={e.id} className="text-xs">{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Anwenden auf</Label>
              <div className="flex gap-1.5">
                {toggleBtn(afTarget === 'plan',  () => setAfTarget('plan'),  'Plan')}
                {toggleBtn(afTarget === 'ist',   () => setAfTarget('ist'),   'Ist')}
                {toggleBtn(afTarget === 'beide', () => setAfTarget('beide'), 'Plan + Ist')}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Plan: setzt Frei (F) im Dienstplan · Ist: setzt 0 h in den Ist-Stunden
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="af-skip"
                checked={afSkipWeekend}
                onCheckedChange={v => setAfSkipWeekend(!!v)}
              />
              <Label htmlFor="af-skip" className="text-xs cursor-pointer">Wochenenden überspringen</Label>
            </div>

            <div className="flex items-center justify-between border-t pt-3">
              <span className="text-xs text-muted-foreground">
                {afPreview
                  ? (() => {
                      const parts: string[] = [];
                      if (afTarget !== 'ist')   parts.push(`${afPreview.planCount} Plan`);
                      if (afTarget !== 'plan')  parts.push(`${afPreview.istCount} Ist`);
                      return `${parts.join(' · ')} leere Zelle(n) werden gefüllt`;
                    })()
                  : 'Berechnung…'}
              </span>
              <Button
                size="sm"
                onClick={applyAutoFrei}
                disabled={!afPreview || (afPreview.planCount === 0 && afPreview.istCount === 0)}
              >
                Füllen
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
