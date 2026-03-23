import { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Clock, Users, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { DaySchedule } from './ScheduleGrid';
import { ActualHoursEntry } from './ActualHoursGrid';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  actualHoursData: Record<string, ActualHoursEntry>;
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  daysInMonth: Date[];
}

interface ShiftSegment {
  start: string;    // "HH:MM"
  end: string;      // "HH:MM" – "00:00" means midnight
  source: 'ist' | 'plan';
  label?: string;   // "Früh" / "Spät"
}

interface MatchRow {
  employee: Employee;
  segments: ShiftSegment[];
  overlapStart: string;
  overlapEnd: string;
  overlapMins: number;
  source: 'ist' | 'plan';
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function toMins(t: string): number {
  if (t === '24:00') return 1440;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toTimeStr(mins: number): string {
  const mod = ((mins % 1440) + 1440) % 1440;
  const h   = Math.floor(mod / 60);
  const m   = mod % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Returns overlap of [aS, aE) and [bS, bE).  Supports overnight (end < start). */
function overlapInterval(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string,
): { ok: boolean; start: string; end: string; mins: number } {
  const as_ = toMins(aStart);
  let   ae_ = toMins(aEnd);   if (ae_ === 0 || ae_ < as_) ae_ += 1440;
  const bs_ = toMins(bStart);
  let   be_ = toMins(bEnd);   if (be_ === 0 || be_ < bs_) be_ += 1440;

  const os = Math.max(as_, bs_);
  const oe = Math.min(ae_, be_);
  if (oe <= os) return { ok: false, start: '', end: '', mins: 0 };

  const endLabel = oe >= 1440 ? '00:00' : toTimeStr(oe);
  return { ok: true, start: toTimeStr(os), end: endLabel, mins: oe - os };
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function getSegments(
  empId: string,
  dateStr: string,
  actualData: Record<string, ActualHoursEntry>,
  planData:   Record<string, DaySchedule>,
): ShiftSegment[] {
  const key    = `${empId}-${dateStr}`;
  const actual = actualData[key];
  const plan   = planData[key];

  // If actual data has explicit start/end and is not absence → use it
  if (actual?.start && actual?.end && !actual.absenceType) {
    return [{ start: actual.start, end: actual.end, source: 'ist' }];
  }

  // If absent today → no segments
  if (actual?.absenceType) return [];

  // Fallback to planned schedule
  const segs: ShiftSegment[] = [];
  if (plan?.früh && !plan.frühAbsence) {
    segs.push({ start: plan.früh.start, end: plan.früh.end, source: 'plan', label: 'Früh' });
  }
  if (plan?.spät && !plan.spätAbsence) {
    segs.push({ start: plan.spät.start, end: plan.spät.end, source: 'plan', label: 'Spät' });
  }
  return segs;
}

// ── Constant: daily breakdown buckets (06:00–24:00 in 2-h steps) ──────────────

const BREAKDOWN_BUCKETS: [string, string][] = [
  ['06:00', '08:00'], ['08:00', '10:00'], ['10:00', '12:00'],
  ['12:00', '14:00'], ['14:00', '16:00'], ['16:00', '18:00'],
  ['18:00', '20:00'], ['20:00', '22:00'], ['22:00', '24:00'],
];

const DEPT_LABEL: Record<string, string> = { service: 'Service', küche: 'Küche' };
const DEPT_COLOR: Record<string, string> = {
  service: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  küche:   'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function TimeSlotStaffingDialog({
  open, onClose, employees, actualHoursData, scheduleData, currentMonth, daysInMonth,
}: Props) {
  const monthStart = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
  const monthEnd   = format(endOfMonth(currentMonth),   'yyyy-MM-dd');

  const [selDate,  setSelDate]  = useState(format(new Date(), 'yyyy-MM-dd'));
  const [slotFrom, setSlotFrom] = useState('22:00');
  const [slotTo,   setSlotTo]   = useState('00:00');  // 00:00 = midnight
  const [dept,     setDept]     = useState<'all' | 'service' | 'küche'>('all');
  const [showBreakdown, setShowBreakdown] = useState(true);

  // ── Filtered employees ───────────────────────────────────────────────────
  const filteredEmps = useMemo(() =>
    dept === 'all' ? employees : employees.filter(e => e.department === dept),
    [employees, dept]
  );

  // ── Compute matches for selected date + slot ─────────────────────────────
  const matches = useMemo((): MatchRow[] => {
    if (!selDate) return [];
    const result: MatchRow[] = [];

    for (const emp of filteredEmps) {
      const segs = getSegments(emp.id, selDate, actualHoursData, scheduleData);
      if (segs.length === 0) continue;

      // Find best overlap across all segments
      let bestOverlap: { start: string; end: string; mins: number } | null = null;
      let bestSource: 'ist' | 'plan' = 'plan';

      for (const seg of segs) {
        const ov = overlapInterval(slotFrom, slotTo, seg.start, seg.end);
        if (ov.ok && (!bestOverlap || ov.mins > bestOverlap.mins)) {
          bestOverlap = { start: ov.start, end: ov.end, mins: ov.mins };
          bestSource  = seg.source;
        }
      }

      if (bestOverlap) {
        result.push({
          employee: emp,
          segments: segs,
          overlapStart: bestOverlap.start,
          overlapEnd:   bestOverlap.end,
          overlapMins:  bestOverlap.mins,
          source:       bestSource,
        });
      }
    }

    return result.sort((a, b) => toMins(a.overlapStart) - toMins(b.overlapStart));
  }, [selDate, slotFrom, slotTo, filteredEmps, actualHoursData, scheduleData]);

  // ── Daily breakdown ─────────────────────────────────────────────────────
  const breakdown = useMemo(() => {
    if (!selDate) return [];
    return BREAKDOWN_BUCKETS.map(([bs, be]) => {
      const working: string[] = [];
      for (const emp of filteredEmps) {
        const segs = getSegments(emp.id, selDate, actualHoursData, scheduleData);
        for (const seg of segs) {
          const ov = overlapInterval(bs, be, seg.start, seg.end);
          if (ov.ok) { working.push(emp.name); break; }
        }
      }
      return { from: bs, to: be, working };
    });
  }, [selDate, filteredEmps, actualHoursData, scheduleData]);

  const maxBreakdown = useMemo(() =>
    Math.max(1, ...breakdown.map(b => b.working.length)),
    [breakdown]
  );

  // ── Date label ───────────────────────────────────────────────────────────
  const dateLabel = useMemo(() => {
    if (!selDate) return '';
    const [y, m, d] = selDate.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return format(dateObj, 'EEEE, d. MMMM yyyy', { locale: de });
  }, [selDate]);

  const slotLabel = useMemo(() => {
    const endLabel = slotTo === '00:00' ? '24:00' : slotTo;
    return `${slotFrom} – ${endLabel}`;
  }, [slotFrom, slotTo]);

  const minsToH = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return min === 0 ? `${h}h` : `${h}h ${min}min`;
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-teal-500" />
            Besetzungscheck — Zeitfenster-Analyse
          </DialogTitle>
          <DialogDescription>
            Wer war in einem bestimmten Zeitfenster im Einsatz? Nutzt Ist-Zeiten wenn vorhanden, sonst Planzeiten.
          </DialogDescription>
        </DialogHeader>

        {/* ── Filter bar ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs font-semibold">Datum</Label>
            <input
              type="date"
              value={selDate}
              min={monthStart}
              max={monthEnd}
              onChange={e => setSelDate(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-semibold">Von</Label>
            <input
              type="time"
              value={slotFrom}
              onChange={e => setSlotFrom(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-semibold">Bis (00:00 = Mitternacht)</Label>
            <input
              type="time"
              value={slotTo}
              onChange={e => setSlotTo(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs font-semibold">Abteilung</Label>
            <div className="flex gap-1 h-8">
              {([
                { id: 'all',     label: 'Alle' },
                { id: 'service', label: 'Service' },
                { id: 'küche',   label: 'Küche' },
              ] as const).map(d => (
                <button
                  key={d.id}
                  onClick={() => setDept(d.id)}
                  className={cn(
                    'flex-1 text-[10px] font-semibold rounded border transition-colors',
                    dept === d.id
                      ? 'bg-foreground text-background border-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Results ─────────────────────────────────────────────────────── */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between bg-muted/40 px-3 py-2 border-b border-border">
            <div>
              <span className="text-sm font-semibold capitalize">{dateLabel}</span>
              <span className="text-xs text-muted-foreground ml-2">· {slotLabel}</span>
            </div>
            <Badge variant="outline" className="gap-1 text-xs">
              <Users className="h-3 w-3" />
              {matches.length} MA
            </Badge>
          </div>

          {matches.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Niemand in diesem Zeitfenster eingetragen
              {dept !== 'all' && <span> ({DEPT_LABEL[dept]})</span>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {matches.map(row => (
                <div
                  key={row.employee.id}
                  className="flex items-center gap-3 px-3 py-2 text-xs hover:bg-muted/30 transition-colors"
                >
                  {/* Name + dept */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{row.employee.name}</p>
                    <Badge
                      variant="outline"
                      className={cn('text-[9px] px-1 py-0 h-4 mt-0.5', DEPT_COLOR[row.employee.department])}
                    >
                      {DEPT_LABEL[row.employee.department]}
                    </Badge>
                  </div>

                  {/* Full shift(s) */}
                  <div className="hidden sm:block text-muted-foreground text-right min-w-[110px]">
                    {row.segments.map((seg, i) => (
                      <div key={i} className="flex items-center justify-end gap-1">
                        {seg.label && <span className="text-[9px] text-muted-foreground/70">{seg.label}</span>}
                        <span>{seg.start}–{seg.end === '00:00' ? '24:00' : seg.end}</span>
                      </div>
                    ))}
                  </div>

                  {/* Overlap highlight */}
                  <div className="text-right min-w-[100px]">
                    <span className="font-semibold text-teal-700 dark:text-teal-400">
                      {row.overlapStart}–{row.overlapEnd === '00:00' ? '24:00' : row.overlapEnd}
                    </span>
                    <p className="text-[10px] text-muted-foreground">{minsToH(row.overlapMins)}</p>
                  </div>

                  {/* Source badge */}
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[9px] px-1.5 py-0 h-4 shrink-0',
                      row.source === 'ist'
                        ? 'bg-green-50 border-green-300 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                        : 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
                    )}
                  >
                    {row.source === 'ist' ? 'Ist' : 'Plan'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Daily breakdown ──────────────────────────────────────────────── */}
        <div className="rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setShowBreakdown(v => !v)}
            className="w-full flex items-center justify-between bg-muted/40 px-3 py-2 border-b border-border hover:bg-muted/60 transition-colors"
          >
            <span className="text-sm font-semibold">
              Tagesübersicht · {dateLabel.split(',')[0]}
            </span>
            {showBreakdown
              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
              : <ChevronDown className="h-4 w-4 text-muted-foreground" />
            }
          </button>

          {showBreakdown && (
            <div className="p-2 space-y-1.5">
              {breakdown.map(({ from, to, working }) => {
                const pct = Math.round((working.length / maxBreakdown) * 100);
                const isSelected = (() => {
                  const bs = toMins(from);
                  const be = toMins(to);
                  const ss = toMins(slotFrom);
                  let se  = toMins(slotTo); if (se === 0) se = 1440;
                  return bs < se && be > ss;
                })();

                return (
                  <div key={from} className={cn('rounded px-2 py-1.5', isSelected && 'bg-teal-50 dark:bg-teal-950/30')}>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'text-[10px] font-mono w-11 shrink-0',
                        isSelected ? 'text-teal-700 dark:text-teal-400 font-bold' : 'text-muted-foreground',
                      )}>
                        {from}
                      </span>

                      {/* Bar */}
                      <div className="flex-1 h-4 rounded bg-muted/60 overflow-hidden">
                        {pct > 0 && (
                          <div
                            className={cn(
                              'h-full rounded transition-all',
                              isSelected
                                ? 'bg-teal-400 dark:bg-teal-600'
                                : 'bg-slate-300 dark:bg-slate-600',
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        )}
                      </div>

                      {/* Count */}
                      <span className={cn(
                        'text-[10px] font-semibold w-8 text-right shrink-0',
                        isSelected ? 'text-teal-700 dark:text-teal-400' : 'text-muted-foreground',
                      )}>
                        {working.length > 0 ? `${working.length} MA` : '–'}
                      </span>
                    </div>

                    {/* Names (show when ≤4, summarize otherwise) */}
                    {working.length > 0 && (
                      <p className="text-[9px] text-muted-foreground ml-13 pl-[52px] mt-0.5 leading-tight">
                        {working.length <= 5
                          ? working.join(', ')
                          : `${working.slice(0, 4).join(', ')} +${working.length - 4}`
                        }
                      </p>
                    )}
                  </div>
                );
              })}
              <p className="text-[9px] text-muted-foreground px-2 pt-1">
                Grün hervorgehobene Slots überschneiden sich mit dem gewählten Zeitfenster.
                Quelle: Ist-Zeiten wenn eingetragen, sonst Planzeiten.
              </p>
            </div>
          )}
        </div>

      </DialogContent>
    </Dialog>
  );
}
