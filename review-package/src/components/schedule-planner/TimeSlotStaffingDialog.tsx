import { useState, useMemo } from 'react';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Clock, Users, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, Info,
} from 'lucide-react';
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

interface PlanSeg {
  start: string;
  end: string;
  label?: string;
}

interface EmpPlan {
  employee: Employee;
  segs: PlanSeg[];
  overlapMins: number;       // overlap with selected slot
}

interface EmpActual {
  employee: Employee;
  start?: string;
  end?: string;
  hours?: number;
  hasTimings: boolean;        // true → overlap computable
  overlapMins: number;
  absenceType?: string;
}

type BucketStatus = 'ok' | 'warn' | 'bad' | 'empty';

interface BucketResult {
  from: string;
  to: string;
  planNames: string[];
  istNames: string[];
  planCount: number;
  istCount: number;
  diff: number;               // ist - plan (negative = understaffed)
  status: BucketStatus;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function toMins(t: string): number {
  if (t === '24:00') return 1440;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toTimeStr(mins: number): string {
  const mod = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(mod / 60)).padStart(2, '0')}:${String(mod % 60).padStart(2, '0')}`;
}

function overlapMins(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string,
): number {
  const as_ = toMins(aStart);
  let ae_ = toMins(aEnd);   if (ae_ === 0 || ae_ < as_) ae_ += 1440;
  const bs_ = toMins(bStart);
  let be_ = toMins(bEnd);   if (be_ === 0 || be_ < bs_) be_ += 1440;
  return Math.max(0, Math.min(ae_, be_) - Math.max(as_, bs_));
}

function overlapRange(
  aStart: string, aEnd: string,
  bStart: string, bEnd: string,
): { ok: boolean; start: string; end: string; mins: number } {
  const as_ = toMins(aStart);
  let ae_ = toMins(aEnd);   if (ae_ === 0 || ae_ < as_) ae_ += 1440;
  const bs_ = toMins(bStart);
  let be_ = toMins(bEnd);   if (be_ === 0 || be_ < bs_) be_ += 1440;
  const os = Math.max(as_, bs_);
  const oe = Math.min(ae_, be_);
  if (oe <= os) return { ok: false, start: '', end: '', mins: 0 };
  const endLabel = oe >= 1440 ? '00:00' : toTimeStr(oe);
  return { ok: true, start: toTimeStr(os), end: endLabel, mins: oe - os };
}

function minsToH(m: number): string {
  const h   = Math.floor(m / 60);
  const min = m % 60;
  return min === 0 ? `${h}h` : `${h}h ${min}min`;
}

// ── Data helpers ──────────────────────────────────────────────────────────────

function getPlanSegs(empId: string, dateStr: string, planData: Record<string, DaySchedule>): PlanSeg[] {
  const plan = planData[`${empId}-${dateStr}`];
  if (!plan) return [];
  const segs: PlanSeg[] = [];
  if (plan.früh && !plan.frühAbsence) segs.push({ start: plan.früh.start, end: plan.früh.end, label: 'Früh' });
  if (plan.spät && !plan.spätAbsence) segs.push({ start: plan.spät.start, end: plan.spät.end, label: 'Spät' });
  return segs;
}

function getActualInfo(empId: string, dateStr: string, actualData: Record<string, ActualHoursEntry>): EmpActual | null {
  const entry = actualData[`${empId}-${dateStr}`];
  if (!entry) return null;
  return {
    employee:    { id: empId } as Employee,  // filled in by caller
    start:       entry.start,
    end:         entry.end,
    hours:       entry.hours,
    hasTimings:  !!(entry.start && entry.end && !entry.absenceType),
    overlapMins: 0,  // computed by caller
    absenceType: entry.absenceType,
  };
}

// ── Breakdown bucket status ───────────────────────────────────────────────────

function bucketStatus(planCount: number, istCount: number, hasIstData: boolean): BucketStatus {
  if (planCount === 0 && istCount === 0) return 'empty';
  if (!hasIstData)                        return 'empty';   // no timing data at all → can't compare
  const diff = istCount - planCount;
  if (diff >= -1)  return 'ok';
  if (diff >= -2)  return 'warn';
  return 'bad';
}

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({
  icon, label, count, colorClass,
}: { icon: React.ReactNode; label: string; count: number; colorClass: string }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-1.5 text-xs font-semibold border-b border-border', colorClass)}>
      {icon}
      {label}
      <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0 h-4">{count}</Badge>
    </div>
  );
}

function SegDisplay({ segs }: { segs: PlanSeg[] }) {
  if (segs.length === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span>
      {segs.map((s, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {s.label && <span className="text-muted-foreground/70 text-[9px] mr-0.5">{s.label}</span>}
          {s.start}–{s.end === '00:00' ? '24:00' : s.end}
        </span>
      ))}
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TimeSlotStaffingDialog({
  open, onClose, employees, actualHoursData, scheduleData, currentMonth, daysInMonth,
}: Props) {
  const monthStart = format(startOfMonth(currentMonth), 'yyyy-MM-dd');
  const monthEnd   = format(endOfMonth(currentMonth),   'yyyy-MM-dd');

  const [selDate,       setSelDate]       = useState(format(new Date(), 'yyyy-MM-dd'));
  const [slotFrom,      setSlotFrom]      = useState('22:00');
  const [slotTo,        setSlotTo]        = useState('00:00');   // 00:00 = midnight
  const [dept,          setDept]          = useState<'all' | 'service' | 'küche'>('all');
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [showHoursOnly, setShowHoursOnly] = useState(false);

  // ── Filtered employees ───────────────────────────────────────────────────
  const filteredEmps = useMemo(() =>
    dept === 'all' ? employees : employees.filter(e => e.department === dept),
    [employees, dept]
  );

  // ── Determine if there is any actual timing data for this date ───────────
  const hasAnyIstTimings = useMemo(() => {
    if (!selDate) return false;
    return filteredEmps.some(emp => {
      const entry = actualHoursData[`${emp.id}-${selDate}`];
      return !!(entry?.start && entry?.end && !entry.absenceType);
    });
  }, [selDate, filteredEmps, actualHoursData]);

  // ── Main comparison computation ──────────────────────────────────────────
  const comparison = useMemo(() => {
    if (!selDate) return null;

    // For each employee, get plan and actual data for the slot
    const both:      { emp: Employee; plan: EmpPlan; actual: EmpActual }[] = [];
    const planOnly:  EmpPlan[]   = [];
    const istOnly:   EmpActual[] = [];
    const hoursOnly: { emp: Employee; hours: number }[] = [];

    let planMins = 0;
    let istMins  = 0;

    for (const emp of filteredEmps) {
      const planSegs   = getPlanSegs(emp.id, selDate, scheduleData);
      const actualInfo = getActualInfo(emp.id, selDate, actualHoursData);
      if (actualInfo) actualInfo.employee = emp;

      // Plan overlap
      let planOverlap = 0;
      const matchingPlanSegs: PlanSeg[] = [];
      for (const seg of planSegs) {
        const mins = overlapMins(slotFrom, slotTo, seg.start, seg.end);
        if (mins > 0) { planOverlap += mins; matchingPlanSegs.push(seg); }
      }

      // Actual overlap (only if has timings)
      let istOverlap = 0;
      if (actualInfo?.hasTimings && actualInfo.start && actualInfo.end) {
        istOverlap = overlapMins(slotFrom, slotTo, actualInfo.start, actualInfo.end);
        if (actualInfo) actualInfo.overlapMins = istOverlap;
      }

      const inPlan = planOverlap > 0;
      const inIst  = istOverlap > 0;

      if (inPlan && inIst) {
        planMins += planOverlap;
        istMins  += istOverlap;
        both.push({
          emp,
          plan:   { employee: emp, segs: matchingPlanSegs, overlapMins: planOverlap },
          actual: { ...actualInfo!, employee: emp, overlapMins: istOverlap },
        });
      } else if (inPlan && !inIst) {
        planMins += planOverlap;
        // Absent or hours-only or not in slot
        if (actualInfo?.absenceType) {
          planOnly.push({ employee: emp, segs: matchingPlanSegs, overlapMins: planOverlap });
        } else if (actualInfo && !actualInfo.hasTimings && actualInfo.hours) {
          // Has hours but no timing — list separately, don't count as confirmed absence
          hoursOnly.push({ emp, hours: actualInfo.hours });
          planOnly.push({ employee: emp, segs: matchingPlanSegs, overlapMins: planOverlap });
        } else {
          planOnly.push({ employee: emp, segs: matchingPlanSegs, overlapMins: planOverlap });
        }
      } else if (!inPlan && inIst) {
        istMins += istOverlap;
        istOnly.push({ ...actualInfo!, employee: emp, overlapMins: istOverlap });
      } else {
        // Neither in plan nor in ist for this slot — but might have hours-only
        if (actualInfo && !actualInfo.hasTimings && actualInfo.hours && !actualInfo.absenceType) {
          hoursOnly.push({ emp, hours: actualInfo.hours });
        }
      }
    }

    const planCount = both.length + planOnly.length;
    const istCount  = both.length + istOnly.length;
    const diffCount = istCount - planCount;
    const diffMins  = istMins - planMins;

    return {
      both, planOnly, istOnly, hoursOnly,
      planCount, istCount, diffCount,
      planMins, istMins, diffMins,
    };
  }, [selDate, slotFrom, slotTo, filteredEmps, actualHoursData, scheduleData]);

  // ── Daily breakdown ──────────────────────────────────────────────────────
  const breakdown = useMemo((): BucketResult[] => {
    if (!selDate) return [];
    return BREAKDOWN_BUCKETS.map(([bs, be]) => {
      const planNames: string[] = [];
      const istNames:  string[] = [];

      for (const emp of filteredEmps) {
        // Plan
        const planSegs = getPlanSegs(emp.id, selDate, scheduleData);
        for (const seg of planSegs) {
          if (overlapMins(bs, be, seg.start, seg.end) > 0) { planNames.push(emp.name); break; }
        }
        // Actual (only if has timings)
        const entry = actualHoursData[`${emp.id}-${selDate}`];
        if (entry?.start && entry?.end && !entry.absenceType) {
          if (overlapMins(bs, be, entry.start, entry.end) > 0) istNames.push(emp.name);
        }
      }

      const diff   = istNames.length - planNames.length;
      const status = bucketStatus(planNames.length, istNames.length, hasAnyIstTimings);
      return { from: bs, to: be, planNames, istNames, planCount: planNames.length, istCount: istNames.length, diff, status };
    });
  }, [selDate, filteredEmps, actualHoursData, scheduleData, hasAnyIstTimings]);

  // ── Labels ───────────────────────────────────────────────────────────────
  const dateLabel = useMemo(() => {
    if (!selDate) return '';
    const [y, m, d] = selDate.split('-').map(Number);
    return format(new Date(y, m - 1, d), 'EEEE, d. MMMM yyyy', { locale: de });
  }, [selDate]);

  const slotLabel = `${slotFrom} – ${slotTo === '00:00' ? '24:00' : slotTo}`;

  // ── Slot is highlighted in breakdown ─────────────────────────────────────
  function isSlotHighlighted(from: string, to: string) {
    const bs = toMins(from), be = toMins(to);
    const ss = toMins(slotFrom);
    let se = toMins(slotTo); if (se === 0) se = 1440;
    return bs < se && be > ss;
  }

  // ── Status colors ─────────────────────────────────────────────────────────
  const diffColor = (diff: number, hasData: boolean) => {
    if (!hasData) return 'text-muted-foreground';
    if (diff >= -1) return 'text-green-600 dark:text-green-400';
    if (diff >= -2) return 'text-orange-600 dark:text-orange-400';
    return 'text-red-600 dark:text-red-400';
  };

  const statusBg: Record<BucketStatus, string> = {
    ok:    'bg-green-50 dark:bg-green-950/30 border-l-2 border-l-green-400',
    warn:  'bg-orange-50 dark:bg-orange-950/30 border-l-2 border-l-orange-400',
    bad:   'bg-red-50 dark:bg-red-950/30 border-l-2 border-l-red-400',
    empty: '',
  };

  const maxPlan = Math.max(1, ...breakdown.map(b => b.planCount));
  const maxIst  = Math.max(1, ...breakdown.map(b => b.istCount));
  const maxBar  = Math.max(maxPlan, maxIst);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-teal-500" />
            Besetzungscheck — Plan vs. Ist
          </DialogTitle>
          <DialogDescription>
            Vergleiche geplante und tatsächliche Besetzung für ein Zeitfenster.
            Ist-Vergleich setzt Zeitangaben in den Ist-Stunden voraus.
          </DialogDescription>
        </DialogHeader>

        {/* ── Filter bar ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1 col-span-2 sm:col-span-1">
            <Label className="text-xs font-semibold">Datum</Label>
            <input
              type="date" value={selDate} min={monthStart} max={monthEnd}
              onChange={e => setSelDate(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-semibold">Von</Label>
            <input type="time" value={slotFrom} onChange={e => setSlotFrom(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-semibold">Bis (00:00 = 24:00)</Label>
            <input type="time" value={slotTo} onChange={e => setSlotTo(e.target.value)}
              className="w-full h-8 px-2 text-xs rounded border border-input bg-background" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-semibold">Abteilung</Label>
            <div className="flex gap-1 h-8">
              {(['all', 'service', 'küche'] as const).map(d => (
                <button key={d} onClick={() => setDept(d)}
                  className={cn(
                    'flex-1 text-[10px] font-semibold rounded border transition-colors',
                    dept === d
                      ? 'bg-foreground text-background border-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── No actual timing data notice ─────────────────────────────────── */}
        {!hasAnyIstTimings && (
          <div className="flex items-start gap-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Für diesen Tag sind keine Ist-Zeiten mit Zeitangabe vorhanden. Der Plan-Vergleich zeigt nur geplante
              Schichten. Ist-Stunden mit Start- und Endzeit werden aus dem Mirus-Import oder manueller Eingabe übernommen.
            </span>
          </div>
        )}

        {/* ── Summary card ─────────────────────────────────────────────────── */}
        {comparison && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted/40 px-3 py-2 border-b border-border">
              <span className="text-sm font-semibold capitalize">{dateLabel}</span>
              <span className="text-xs text-muted-foreground ml-2">· {slotLabel}</span>
            </div>

            <div className="grid grid-cols-3 divide-x divide-border">
              {/* Plan */}
              <div className="px-3 py-3 text-center space-y-0.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Plan</p>
                <p className="text-2xl font-bold text-foreground">{comparison.planCount}</p>
                <p className="text-[10px] text-muted-foreground">
                  {comparison.planCount === 1 ? 'Person' : 'Personen'}
                </p>
                {comparison.planMins > 0 && (
                  <p className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                    {minsToH(comparison.planMins)}
                  </p>
                )}
              </div>

              {/* Ist */}
              <div className="px-3 py-3 text-center space-y-0.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Ist</p>
                <p className={cn(
                  'text-2xl font-bold',
                  hasAnyIstTimings ? 'text-foreground' : 'text-muted-foreground',
                )}>
                  {hasAnyIstTimings ? comparison.istCount : '–'}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {hasAnyIstTimings ? (comparison.istCount === 1 ? 'Person' : 'Personen') : 'keine Zeitdaten'}
                </p>
                {hasAnyIstTimings && comparison.istMins > 0 && (
                  <p className="text-xs font-semibold text-green-600 dark:text-green-400">
                    {minsToH(comparison.istMins)}
                  </p>
                )}
              </div>

              {/* Diff */}
              <div className="px-3 py-3 text-center space-y-0.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Differenz</p>
                <p className={cn(
                  'text-2xl font-bold',
                  diffColor(comparison.diffCount, hasAnyIstTimings),
                )}>
                  {hasAnyIstTimings
                    ? (comparison.diffCount > 0 ? `+${comparison.diffCount}` : comparison.diffCount)
                    : '–'}
                </p>
                {hasAnyIstTimings && (
                  <>
                    <p className="text-[10px] text-muted-foreground">
                      {comparison.diffCount >= -1 ? 'planmässig' : comparison.diffCount >= -2 ? 'leicht unter Plan' : 'stark unter Plan'}
                    </p>
                    {comparison.diffMins !== 0 && (
                      <p className={cn('text-xs font-semibold', diffColor(comparison.diffMins, true))}>
                        {comparison.diffMins > 0 ? '+' : ''}{minsToH(Math.abs(comparison.diffMins))}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Employee comparison sections ──────────────────────────────────── */}
        {comparison && (
          <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">

            {/* BOTH (plan + ist) */}
            {comparison.both.length > 0 && (
              <div>
                <SectionHeader
                  icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                  label="Plan + Ist bestätigt"
                  count={comparison.both.length}
                  colorClass="bg-green-50/60 dark:bg-green-950/20 text-green-800 dark:text-green-300"
                />
                <div className="divide-y divide-border/60">
                  {comparison.both.map(({ emp, plan, actual }) => {
                    const ov = overlapRange(slotFrom, slotTo, actual.start!, actual.end!);
                    return (
                      <div key={emp.id} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate">{emp.name}</p>
                          <Badge variant="outline" className={cn('text-[9px] px-1 py-0 h-4 mt-0.5', DEPT_COLOR[emp.department])}>
                            {DEPT_LABEL[emp.department]}
                          </Badge>
                        </div>
                        <div className="hidden sm:block text-muted-foreground text-right text-[10px] min-w-[90px]">
                          <p className="text-[9px] text-muted-foreground/60">Plan</p>
                          <SegDisplay segs={plan.segs} />
                        </div>
                        <div className="text-right text-[10px] min-w-[90px]">
                          <p className="text-[9px] text-muted-foreground/60">Ist</p>
                          <p className="font-semibold">{actual.start}–{actual.end === '00:00' ? '24:00' : actual.end}</p>
                        </div>
                        <div className="text-right min-w-[70px]">
                          {ov.ok && (
                            <>
                              <p className="font-semibold text-teal-700 dark:text-teal-400">
                                {ov.start}–{ov.end === '00:00' ? '24:00' : ov.end}
                              </p>
                              <p className="text-[10px] text-muted-foreground">{minsToH(ov.mins)}</p>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* PLAN ONLY */}
            {comparison.planOnly.length > 0 && (
              <div>
                <SectionHeader
                  icon={<AlertTriangle className="h-3.5 w-3.5 text-orange-500" />}
                  label={hasAnyIstTimings ? 'Nur geplant — kein Ist' : 'Geplant (kein Ist-Vergleich möglich)'}
                  count={comparison.planOnly.length}
                  colorClass="bg-orange-50/60 dark:bg-orange-950/20 text-orange-800 dark:text-orange-300"
                />
                <div className="divide-y divide-border/60">
                  {comparison.planOnly.map(row => (
                    <div key={row.employee.id} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/20">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{row.employee.name}</p>
                        <Badge variant="outline" className={cn('text-[9px] px-1 py-0 h-4 mt-0.5', DEPT_COLOR[row.employee.department])}>
                          {DEPT_LABEL[row.employee.department]}
                        </Badge>
                      </div>
                      <div className="text-right text-[10px] min-w-[100px]">
                        <SegDisplay segs={row.segs} />
                        <p className="text-muted-foreground">{minsToH(row.overlapMins)} geplant</p>
                      </div>
                      {hasAnyIstTimings && (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-orange-50 border-orange-300 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400 shrink-0">
                          fehlend
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* IST ONLY */}
            {comparison.istOnly.length > 0 && (
              <div>
                <SectionHeader
                  icon={<Info className="h-3.5 w-3.5 text-blue-500" />}
                  label="Nur Ist — nicht eingeplant"
                  count={comparison.istOnly.length}
                  colorClass="bg-blue-50/60 dark:bg-blue-950/20 text-blue-800 dark:text-blue-300"
                />
                <div className="divide-y divide-border/60">
                  {comparison.istOnly.map(row => {
                    const ov = row.start && row.end ? overlapRange(slotFrom, slotTo, row.start, row.end) : null;
                    return (
                      <div key={row.employee.id} className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate">{row.employee.name}</p>
                          <Badge variant="outline" className={cn('text-[9px] px-1 py-0 h-4 mt-0.5', DEPT_COLOR[row.employee.department])}>
                            {DEPT_LABEL[row.employee.department]}
                          </Badge>
                        </div>
                        <div className="text-right text-[10px] min-w-[100px]">
                          <p>{row.start}–{row.end === '00:00' ? '24:00' : row.end}</p>
                          {ov?.ok && <p className="text-muted-foreground">{minsToH(ov.mins)} im Slot</p>}
                        </div>
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 shrink-0">
                          ungeplant
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* HOURS ONLY (no timing) */}
            {comparison.hoursOnly.length > 0 && (
              <div>
                <button
                  onClick={() => setShowHoursOnly(v => !v)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/20 hover:bg-muted/40 transition-colors"
                >
                  <Clock className="h-3.5 w-3.5" />
                  Eingetragen (nur Stunden, keine Zeit)
                  <Badge variant="outline" className="ml-auto text-[10px] px-1.5 py-0 h-4">{comparison.hoursOnly.length}</Badge>
                  {showHoursOnly ? <ChevronUp className="h-3.5 w-3.5 ml-1" /> : <ChevronDown className="h-3.5 w-3.5 ml-1" />}
                </button>
                {showHoursOnly && (
                  <div className="divide-y divide-border/60">
                    {comparison.hoursOnly.map(({ emp, hours }) => (
                      <div key={emp.id} className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/20">
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-foreground truncate">{emp.name}</p>
                        </div>
                        <p>{hours}h gesamt · kein Zeitfenster</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Empty state */}
            {comparison.both.length === 0 && comparison.planOnly.length === 0 && comparison.istOnly.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Niemand in diesem Zeitfenster eingetragen
              </div>
            )}
          </div>
        )}

        {/* ── Daily breakdown ──────────────────────────────────────────────── */}
        <div className="rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setShowBreakdown(v => !v)}
            className="w-full flex items-center justify-between bg-muted/40 px-3 py-2 border-b border-border hover:bg-muted/60 transition-colors"
          >
            <span className="text-sm font-semibold">
              Tagesübersicht · {dateLabel.split(',')[0]}
            </span>
            <div className="flex items-center gap-2">
              {hasAnyIstTimings && (
                <span className="text-[10px] text-muted-foreground">Plan vs. Ist</span>
              )}
              {showBreakdown
                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 text-muted-foreground" />
              }
            </div>
          </button>

          {showBreakdown && (
            <div className="p-2 space-y-1">
              {/* Column headers */}
              <div className="flex items-center gap-2 px-2 pb-1">
                <span className="text-[10px] text-muted-foreground w-11 shrink-0" />
                <span className="flex-1 text-[10px] text-muted-foreground text-center">
                  {hasAnyIstTimings ? 'Plan (blau) / Ist (grün)' : 'Geplante Schichten'}
                </span>
                <span className="w-20 text-[10px] text-muted-foreground text-right shrink-0">
                  {hasAnyIstTimings ? 'Plan / Ist / Δ' : 'MA'}
                </span>
              </div>

              {breakdown.map(b => {
                const highlighted = isSlotHighlighted(b.from, b.to);
                const planPct = Math.round((b.planCount / maxBar) * 100);
                const istPct  = Math.round((b.istCount  / maxBar) * 100);

                return (
                  <div
                    key={b.from}
                    className={cn(
                      'rounded px-2 py-1.5',
                      highlighted && hasAnyIstTimings && b.status !== 'empty' && statusBg[b.status],
                      highlighted && !hasAnyIstTimings && 'bg-teal-50 dark:bg-teal-950/30',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Time label */}
                      <span className={cn(
                        'text-[10px] font-mono w-11 shrink-0',
                        highlighted ? 'font-bold text-foreground' : 'text-muted-foreground',
                      )}>
                        {b.from}
                      </span>

                      {/* Bar(s) */}
                      <div className="flex-1 flex flex-col gap-0.5">
                        {/* Plan bar */}
                        <div className="h-2.5 rounded-sm bg-muted/50 overflow-hidden">
                          {planPct > 0 && (
                            <div
                              className="h-full rounded-sm bg-blue-300 dark:bg-blue-600 transition-all"
                              style={{ width: `${planPct}%` }}
                            />
                          )}
                        </div>
                        {/* Ist bar (only if timing data exists) */}
                        {hasAnyIstTimings && (
                          <div className="h-2.5 rounded-sm bg-muted/50 overflow-hidden">
                            {istPct > 0 && (
                              <div
                                className={cn(
                                  'h-full rounded-sm transition-all',
                                  b.status === 'ok'   ? 'bg-green-400 dark:bg-green-600'  :
                                  b.status === 'warn' ? 'bg-orange-400 dark:bg-orange-600' :
                                  b.status === 'bad'  ? 'bg-red-400 dark:bg-red-600'       :
                                                         'bg-green-400 dark:bg-green-600',
                                )}
                                style={{ width: `${istPct}%` }}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Counts */}
                      <div className="text-right shrink-0 min-w-[70px]">
                        {hasAnyIstTimings ? (
                          <p className="text-[10px] font-semibold">
                            <span className="text-blue-600 dark:text-blue-400">{b.planCount}</span>
                            {' / '}
                            <span className="text-green-600 dark:text-green-400">{b.istCount}</span>
                            {' '}
                            <span className={cn('font-bold', diffColor(b.diff, true))}>
                              {b.diff === 0 ? '' : b.diff > 0 ? `+${b.diff}` : `${b.diff}`}
                            </span>
                          </p>
                        ) : (
                          <p className={cn(
                            'text-[10px] font-semibold',
                            highlighted ? 'text-teal-700 dark:text-teal-400' : 'text-muted-foreground',
                          )}>
                            {b.planCount > 0 ? `${b.planCount} MA` : '–'}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Names row */}
                    {(b.planCount > 0 || b.istCount > 0) && (
                      <div className="pl-[52px] mt-0.5 space-y-0">
                        {b.planNames.length > 0 && (
                          <p className="text-[9px] text-blue-500 dark:text-blue-400 leading-tight">
                            {hasAnyIstTimings && <span className="mr-1">Plan:</span>}
                            {b.planNames.length <= 4
                              ? b.planNames.join(', ')
                              : `${b.planNames.slice(0, 3).join(', ')} +${b.planNames.length - 3}`}
                          </p>
                        )}
                        {hasAnyIstTimings && b.istNames.length > 0 && (
                          <p className="text-[9px] text-green-600 dark:text-green-400 leading-tight">
                            <span className="mr-1">Ist:</span>
                            {b.istNames.length <= 4
                              ? b.istNames.join(', ')
                              : `${b.istNames.slice(0, 3).join(', ')} +${b.istNames.length - 3}`}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center gap-3 px-2 pt-1 text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-blue-300 dark:bg-blue-600" /> Plan
                </span>
                {hasAnyIstTimings && (
                  <>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-green-400 dark:bg-green-600" /> Ist OK
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-orange-400" /> Leicht unter Plan
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-2 rounded-sm bg-red-400" /> Stark unter Plan
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

      </DialogContent>
    </Dialog>
  );
}
