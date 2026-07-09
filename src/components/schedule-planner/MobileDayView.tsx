import React, { useState, useMemo, useEffect } from 'react';
import { format, isWeekend, isSunday } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { DaySchedule } from './ScheduleGrid';
import { cn } from '@/lib/utils';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { socialCostFactorFromRates, type SocialCostRates } from '@/lib/social-costs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Clock, Check, X, Users, Euro, TrendingUp, AlertTriangle, ChevronRight,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ActualHourEntry {
  hours: number;
  start?: string;
  end?: string;
}

interface DailyBudgetEntry {
  plannedRevenue?: number;
  actualRevenue?: number;
  isOverride?: boolean;
}

interface MobileDayViewProps {
  employees: Employee[];
  day: Date;
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, ActualHourEntry>;
  scheduleMode: 'plan' | 'ist' | 'compare';
  onSlotChange: (
    employeeId: string,
    date: string,
    slotType: 'früh' | 'spät',
    value: { start: string; end: string } | null,
    absenceType?: string | null,
  ) => void;
  onHoursChange: (employeeId: string, date: string, entry: ActualHourEntry | null) => void;
  getEmployeeHours: (employeeId: string) => number;
  getEmployeeActualHours: (employeeId: string) => number;
  getTargetHours: (employee: Employee) => number;
  showCosts?: boolean;
  dailyBudgets?: Record<string, DailyBudgetEntry>;
  daysInMonth?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_KEY = 'dayview_show_only_scheduled';
const DEPT_ORDER = ['service', 'küche', 'kueche'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function deptColor(dept: string) {
  if (dept === 'service') return 'bg-blue-500';
  if (dept === 'küche' || dept === 'kueche') return 'bg-orange-500';
  return 'bg-gray-400';
}

function deptLabel(dept: string) {
  if (dept === 'service') return 'Service';
  if (dept === 'küche' || dept === 'kueche') return 'Küche';
  return dept;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Returns "sort key" for a day's schedule: lower = earlier shift, 9999 = free */
function shiftSortKey(plan: DaySchedule | undefined): number {
  if (!plan) return 9999;
  const hasAbsence = plan.frühAbsence || plan.spätAbsence;
  if (hasAbsence && !plan.früh && !plan.spät) return 8000; // absence, no times

  const starts: number[] = [];
  if (plan.früh?.start) starts.push(timeToMin(plan.früh.start));
  if (plan.spät?.start) starts.push(timeToMin(plan.spät.start));
  if (starts.length === 0) return 8000;
  return Math.min(...starts);
}

/** Calculate daily cost (Total Arbeitgeberkosten, nie roher Lohn) for a single employee on a given day */
function calcDailyCost(
  emp: Employee,
  plan: DaySchedule | undefined,
  daysInMonth: number,
  rates: SocialCostRates,
): number {
  if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
    const agFactor = socialCostFactorFromRates(rates);
    return ((emp.monthlySalaryWith13th ?? emp.monthlySalary) * agFactor) / daysInMonth;
  }
  if (!plan) return 0;
  let hours = 0;
  if (plan.früh?.start && plan.früh?.end) {
    const diff = timeToMin(plan.früh.end) - timeToMin(plan.früh.start);
    hours += Math.max(0, diff) / 60;
  }
  if (plan.spät?.start && plan.spät?.end) {
    const diff = timeToMin(plan.spät.end) - timeToMin(plan.spät.start);
    hours += Math.max(0, diff) / 60;
  }
  return hours * (getEffectiveHourlyRate(emp, rates) ?? 0);
}

const CHF = new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

// ── Edit Dialog (Plan) ────────────────────────────────────────────────────────

interface PlanEditDialogProps {
  open: boolean;
  onClose: () => void;
  employee: Employee;
  date: string;
  plan: DaySchedule | undefined;
  onSlotChange: MobileDayViewProps['onSlotChange'];
}

function PlanEditDialog({ open, onClose, employee, date, plan, onSlotChange }: PlanEditDialogProps) {
  const { shifts, shiftMap } = useShiftConfig();
  const absItems = useMemo(() => shifts.filter(s => !s.start || !s.end), [shifts]);
  const workItems = useMemo(() => shifts.filter(s => s.start && s.end), [shifts]);

  const [frühStart, setFrühStart] = useState(plan?.früh?.start ?? '');
  const [frühEnd,   setFrühEnd]   = useState(plan?.früh?.end   ?? '');
  const [spätStart, setSpätStart] = useState(plan?.spät?.start ?? '');
  const [spätEnd,   setSpätEnd]   = useState(plan?.spät?.end   ?? '');

  const handleQuickAbsence = (abbrev: string) => {
    onSlotChange(employee.id, date, 'früh', null, abbrev);
    onSlotChange(employee.id, date, 'spät', null, null);
    onClose();
  };

  const handleQuickShift = (shiftName: string) => {
    const cfg = shiftMap[shiftName];
    if (!cfg) return;
    onSlotChange(employee.id, date, 'früh', { start: cfg.start, end: cfg.end }, null);
    if (cfg.start2 && cfg.end2) {
      onSlotChange(employee.id, date, 'spät', { start: cfg.start2, end: cfg.end2 }, null);
    } else {
      onSlotChange(employee.id, date, 'spät', null, null);
    }
    onClose();
  };

  const handleClear = () => {
    onSlotChange(employee.id, date, 'früh', null, null);
    onSlotChange(employee.id, date, 'spät', null, null);
    onClose();
  };

  const handleSaveManual = () => {
    if (frühStart && frühEnd) {
      onSlotChange(employee.id, date, 'früh', { start: frühStart, end: frühEnd }, null);
    }
    if (spätStart && spätEnd) {
      onSlotChange(employee.id, date, 'spät', { start: spätStart, end: spätEnd }, null);
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {getEmployeeDisplayName(employee)}
            <span className="block text-xs font-normal text-muted-foreground mt-0.5">{date}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {absItems.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground">Abwesenheit</Label>
              <div className="flex flex-wrap gap-2">
                {absItems.map(s => {
                  const code = shiftMap[s.name]?.abbrev ?? s.name;
                  return (
                    <button
                      key={s.name}
                      onClick={() => handleQuickAbsence(code)}
                      className={cn(
                        'px-3 py-1.5 rounded-md border text-sm font-semibold transition-all active:scale-95',
                        s.color,
                        plan?.frühAbsence === code && 'ring-2 ring-offset-1 ring-foreground',
                      )}
                    >
                      {code}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {workItems.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-muted-foreground">Schicht</Label>
              <div className="flex flex-wrap gap-2">
                {workItems.map(s => {
                  const cfg = shiftMap[s.name];
                  return (
                    <button
                      key={s.name}
                      title={`${s.start}–${s.end}`}
                      onClick={() => handleQuickShift(s.name)}
                      className={cn(
                        'px-3 py-1.5 rounded-md border text-sm font-semibold transition-all active:scale-95',
                        s.color,
                        plan?.früh?.start === cfg?.start && !plan?.frühAbsence && 'ring-2 ring-offset-1 ring-foreground',
                      )}
                    >
                      {cfg?.abbrev ?? s.name}
                      <span className="block text-[10px] font-normal">{s.start}–{s.end}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs font-semibold text-muted-foreground">Manuelle Zeiten</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px]">Früh von</Label>
                <Input type="time" step="900" value={frühStart} onChange={e => setFrühStart(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Früh bis</Label>
                <Input type="time" step="900" value={frühEnd} onChange={e => setFrühEnd(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Spät von</Label>
                <Input type="time" step="900" value={spätStart} onChange={e => setSpätStart(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Spät bis</Label>
                <Input type="time" step="900" value={spätEnd} onChange={e => setSpätEnd(e.target.value)} className="h-9 text-sm" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 flex-row justify-between">
          <Button variant="outline" size="sm" onClick={handleClear} className="text-destructive border-destructive/30">
            <X className="h-3.5 w-3.5 mr-1" />
            Löschen
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button>
            <Button size="sm" onClick={handleSaveManual}>
              <Check className="h-3.5 w-3.5 mr-1" />
              Speichern
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Dialog (Ist) ─────────────────────────────────────────────────────────

interface IstEditDialogProps {
  open: boolean;
  onClose: () => void;
  employee: Employee;
  date: string;
  entry: ActualHourEntry | undefined;
  onSave: (entry: ActualHourEntry | null) => void;
}

function IstEditDialog({ open, onClose, employee, date, entry, onSave }: IstEditDialogProps) {
  const [hoursVal, setHoursVal] = useState(entry?.hours != null ? String(entry.hours) : '');
  const [startVal, setStartVal] = useState(entry?.start ?? '');
  const [endVal,   setEndVal]   = useState(entry?.end   ?? '');

  const handleSave = () => {
    const h = parseFloat(hoursVal);
    if (isNaN(h) && !startVal && !endVal) { onSave(null); onClose(); return; }
    const computed = startVal && endVal
      ? (() => {
          const [sh, sm] = startVal.split(':').map(Number);
          const [eh, em] = endVal.split(':').map(Number);
          let diff = (eh + em / 60) - (sh + sm / 60);
          if (diff < 0) diff += 24;
          return Math.round(diff * 100) / 100;
        })()
      : NaN;
    onSave({
      hours: !isNaN(h) ? h : computed,
      start: startVal || undefined,
      end:   endVal   || undefined,
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm mx-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            Ist-Stunden: {getEmployeeDisplayName(employee)}
            <span className="block text-xs font-normal text-muted-foreground mt-0.5">{date}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs font-semibold">Stunden</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="24"
              value={hoursVal}
              onChange={e => setHoursVal(e.target.value)}
              placeholder="z.B. 8.4"
              className="h-11 text-lg font-semibold"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 border-t pt-3">
            <div className="space-y-1">
              <Label className="text-xs">Von</Label>
              <Input type="time" step="900" value={startVal} onChange={e => setStartVal(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Bis</Label>
              <Input type="time" step="900" value={endVal} onChange={e => setEndVal(e.target.value)} className="h-9 text-sm" />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 flex-row justify-between">
          <Button variant="outline" size="sm" className="text-destructive border-destructive/30" onClick={() => { onSave(null); onClose(); }}>
            <X className="h-3.5 w-3.5 mr-1" />
            Löschen
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button>
            <Button size="sm" onClick={handleSave}>
              <Check className="h-3.5 w-3.5 mr-1" />
              OK
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Plan/Ist Badges ───────────────────────────────────────────────────────────

function PlanBadge({ plan, shiftMap }: { plan: DaySchedule | undefined; shiftMap: Record<string, { abbrev?: string; color?: string; hours?: number }> }) {
  if (!plan) return <span className="text-muted-foreground text-xs italic">frei</span>;

  const lines: React.ReactNode[] = [];

  if (plan.frühAbsence) {
    const cfg = Object.values(shiftMap).find(s => s.abbrev === plan.frühAbsence);
    lines.push(
      <span key="frAbsence" className={cn('inline-flex items-center px-1.5 py-0 rounded text-xs font-bold border', cfg?.color ?? 'bg-gray-100 text-gray-700 border-gray-300')}>
        {plan.frühAbsence}
      </span>
    );
  } else if (plan.früh) {
    lines.push(
      <span key="früh" className="text-xs font-semibold tabular-nums">
        {plan.früh.start}–{plan.früh.end}
      </span>
    );
  }

  if (plan.spätAbsence && plan.spätAbsence !== plan.frühAbsence) {
    const cfg = Object.values(shiftMap).find(s => s.abbrev === plan.spätAbsence);
    lines.push(
      <span key="spAbsence" className={cn('inline-flex items-center px-1.5 py-0 rounded text-xs font-bold border', cfg?.color ?? 'bg-gray-100 text-gray-700 border-gray-300')}>
        {plan.spätAbsence}
      </span>
    );
  } else if (plan.spät) {
    lines.push(
      <span key="spät" className="text-xs tabular-nums text-muted-foreground">
        {plan.spät.start}–{plan.spät.end}
      </span>
    );
  }

  if (lines.length === 0) return <span className="text-muted-foreground text-xs italic">frei</span>;
  return <div className="flex flex-col gap-0">{lines}</div>;
}

function IstBadge({ entry }: { entry: ActualHourEntry | undefined }) {
  if (!entry) return <span className="text-muted-foreground text-xs italic">–</span>;
  return (
    <div className="flex flex-col gap-0">
      <span className="text-xs font-semibold tabular-nums">{entry.hours.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h</span>
      {entry.start && entry.end && (
        <span className="text-[10px] text-muted-foreground tabular-nums">{entry.start}–{entry.end}</span>
      )}
    </div>
  );
}

// ── Compact Employee Row ───────────────────────────────────────────────────────

interface EmployeeRowProps {
  employee: Employee;
  date: string;
  plan: DaySchedule | undefined;
  istEntry: ActualHourEntry | undefined;
  scheduleMode: MobileDayViewProps['scheduleMode'];
  onSlotChange: MobileDayViewProps['onSlotChange'];
  onHoursChange: MobileDayViewProps['onHoursChange'];
  showCosts?: boolean;
  dailyCost?: number;
}

function EmployeeRow({
  employee, date, plan, istEntry, scheduleMode,
  onSlotChange, onHoursChange, showCosts, dailyCost,
}: EmployeeRowProps) {
  const { shiftMap } = useShiftConfig();
  const [planEditOpen, setPlanEditOpen] = useState(false);
  const [istEditOpen,  setIstEditOpen]  = useState(false);

  const isFree = !plan || (!plan.früh && !plan.spät && !plan.frühAbsence && !plan.spätAbsence);

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card hover:bg-muted/40 transition-colors cursor-pointer",
          isFree && "opacity-60 border-dashed"
        )}
        onClick={() => setPlanEditOpen(true)}
      >
        {/* Dept dot */}
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', deptColor(employee.department))} />

        {/* Name */}
        <span className={cn(
          "text-sm font-medium leading-none truncate flex-1 min-w-0",
          isFree && "text-muted-foreground"
        )}>
          {getEmployeeDisplayName(employee)}
        </span>

        {/* Plan badge */}
        {(scheduleMode === 'plan' || scheduleMode === 'compare') && (
          <div
            className="shrink-0 min-w-[90px] text-right"
            onClick={e => { e.stopPropagation(); setPlanEditOpen(true); }}
          >
            <PlanBadge plan={plan} shiftMap={shiftMap} />
          </div>
        )}

        {/* Ist badge */}
        {(scheduleMode === 'ist' || scheduleMode === 'compare') && (
          <div
            className="shrink-0 min-w-[70px] text-right border-l pl-2"
            onClick={e => { e.stopPropagation(); setIstEditOpen(true); }}
          >
            <IstBadge entry={istEntry} />
          </div>
        )}

        {/* Daily cost */}
        {showCosts && dailyCost !== undefined && dailyCost > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 border-l pl-2">
            {CHF.format(dailyCost)}
          </span>
        )}

        <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
      </div>

      {planEditOpen && (
        <PlanEditDialog
          open={planEditOpen}
          onClose={() => setPlanEditOpen(false)}
          employee={employee}
          date={date}
          plan={plan}
          onSlotChange={onSlotChange}
        />
      )}

      {istEditOpen && (
        <IstEditDialog
          open={istEditOpen}
          onClose={() => setIstEditOpen(false)}
          employee={employee}
          date={date}
          entry={istEntry}
          onSave={(entry) => onHoursChange(employee.id, date, entry)}
        />
      )}
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function MobileDayView({
  employees,
  day,
  scheduleData,
  actualHoursData,
  scheduleMode,
  onSlotChange,
  onHoursChange,
  getEmployeeHours,
  getEmployeeActualHours,
  getTargetHours,
  showCosts = false,
  dailyBudgets = {},
  daysInMonth = 30,
}: MobileDayViewProps) {
  const dateStr = format(day, 'yyyy-MM-dd');
  const isWeekendDay = isWeekend(day);
  const isSun = isSunday(day);
  // Kosten = Total Arbeitgeberkosten (Brutto inkl. anteil. 13. + AG-Sozialkosten), nie roher hourlyWage.
  const { rates: socialCostRates } = useSocialCostRates();

  // ── Persist "show only scheduled" preference ──────────────────────────────
  const [showOnlyScheduled, setShowOnlyScheduled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      return saved !== null ? JSON.parse(saved) : true;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(showOnlyScheduled)); }
    catch { /* ignore */ }
  }, [showOnlyScheduled]);

  // ── Per-employee plan & cost data for this day ────────────────────────────
  const empData = useMemo(() => {
    return employees.map(emp => {
      const key = `${emp.id}-${dateStr}`;
      const plan = scheduleData[key];
      const istEntry = actualHoursData[key];
      const sortKey = shiftSortKey(plan);
      const dailyCost = calcDailyCost(emp, plan, daysInMonth, socialCostRates);
      const isScheduled = plan && (plan.früh || plan.spät || plan.frühAbsence || plan.spätAbsence);
      return { emp, plan, istEntry, sortKey, dailyCost, isScheduled };
    });
  }, [employees, dateStr, scheduleData, actualHoursData, daysInMonth, socialCostRates]);

  // ── Filter & sort ─────────────────────────────────────────────────────────
  const filteredData = useMemo(() => {
    const base = showOnlyScheduled ? empData.filter(d => d.isScheduled) : empData;
    return [...base].sort((a, b) => a.sortKey - b.sortKey);
  }, [empData, showOnlyScheduled]);

  // ── Group by department ───────────────────────────────────────────────────
  const grouped = useMemo(() => {
    const depts = [...new Set(filteredData.map(d => d.emp.department))].sort((a, b) => {
      const ai = DEPT_ORDER.indexOf(a);
      const bi = DEPT_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return depts.map(dept => ({
      dept,
      rows: filteredData.filter(d => d.emp.department === dept),
    }));
  }, [filteredData]);

  // ── Daily KPIs ────────────────────────────────────────────────────────────
  const dailyKpis = useMemo(() => {
    const scheduled = empData.filter(d => d.isScheduled);
    const scheduledCount = scheduled.length;
    const dailyCostTotal = empData.reduce((s, d) => s + d.dailyCost, 0);
    const plannedRevenue = dailyBudgets[dateStr]?.plannedRevenue ?? 0;
    const pkqForecast = plannedRevenue > 0 ? (dailyCostTotal / plannedRevenue) * 100 : null;
    // Under/over: scheduled vs total
    const totalCount = employees.length;
    const diff = scheduledCount - Math.round(totalCount * 0.7); // rough: expect ~70% scheduled
    return { scheduledCount, totalCount, dailyCostTotal, plannedRevenue, pkqForecast, diff };
  }, [empData, dailyBudgets, dateStr, employees.length]);

  return (
    <div className="space-y-3 max-w-2xl">

      {/* ── Day header ───────────────────────────────────────────────────── */}
      <div className={cn(
        'flex items-center justify-between',
        isWeekendDay && 'opacity-80',
      )}>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold">
            {format(day, 'EEEE', { locale: de })}
          </span>
          <span className={cn(
            'text-sm text-muted-foreground',
            isSun && 'text-red-500 dark:text-red-400',
          )}>
            {format(day, 'd. MMMM yyyy', { locale: de })}
          </span>
          {isWeekendDay && (
            <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">Wochenende</span>
          )}
        </div>

        {/* Toggle: Nur geplant / Alle */}
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 shrink-0">
          <button
            onClick={() => setShowOnlyScheduled(true)}
            className={cn(
              "h-6 px-2 text-[11px] font-medium rounded-md transition-colors",
              showOnlyScheduled
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Nur eingeplante Mitarbeiter anzeigen"
          >
            Nur geplant
          </button>
          <button
            onClick={() => setShowOnlyScheduled(false)}
            className={cn(
              "h-6 px-2 text-[11px] font-medium rounded-md transition-colors",
              !showOnlyScheduled
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
            title="Alle Mitarbeiter anzeigen"
          >
            Alle
          </button>
        </div>
      </div>

      {/* ── Daily KPI strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {/* Eingeplant */}
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <Users className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground leading-none">Eingeplant</p>
            <p className="text-sm font-bold tabular-nums mt-0.5">
              {dailyKpis.scheduledCount}
              <span className="text-[10px] font-normal text-muted-foreground ml-1">/ {dailyKpis.totalCount}</span>
            </p>
          </div>
        </div>

        {/* PK Kosten (nur wenn showCosts) */}
        {showCosts && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <Euro className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground leading-none">PK heute</p>
              <p className="text-sm font-bold tabular-nums mt-0.5">{CHF.format(dailyKpis.dailyCostTotal)}</p>
            </div>
          </div>
        )}

        {/* Umsatz Soll */}
        {dailyKpis.plannedRevenue > 0 && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground leading-none">Umsatz Soll</p>
              <p className="text-sm font-bold tabular-nums mt-0.5">{CHF.format(dailyKpis.plannedRevenue)}</p>
            </div>
          </div>
        )}

        {/* PKQ Forecast */}
        {showCosts && dailyKpis.pkqForecast !== null && (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
            <AlertTriangle className={cn(
              "h-4 w-4 shrink-0",
              dailyKpis.pkqForecast > 35 ? "text-red-500" :
              dailyKpis.pkqForecast > 28 ? "text-amber-500" : "text-green-500"
            )} />
            <div className="min-w-0">
              <p className="text-[10px] text-muted-foreground leading-none">PKQ Forecast</p>
              <p className={cn(
                "text-sm font-bold tabular-nums mt-0.5",
                dailyKpis.pkqForecast > 35 ? "text-red-600 dark:text-red-400" :
                dailyKpis.pkqForecast > 28 ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"
              )}>
                {dailyKpis.pkqForecast.toFixed(1)} %
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Employee groups ──────────────────────────────────────────────── */}
      {grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Clock className="h-8 w-8 opacity-30" />
          <p className="text-sm">
            {showOnlyScheduled
              ? 'Heute keine Mitarbeiter eingeplant'
              : 'Keine Mitarbeiter in diesem Bereich'}
          </p>
          {showOnlyScheduled && (
            <button
              onClick={() => setShowOnlyScheduled(false)}
              className="text-xs text-primary hover:underline"
            >
              Alle anzeigen
            </button>
          )}
        </div>
      ) : (
        grouped.map(({ dept, rows }) => (
          <div key={dept} className="space-y-1">
            {/* Dept header */}
            <div className="flex items-center gap-2 mb-1">
              <span className={cn('w-2 h-2 rounded-full shrink-0', deptColor(dept))} />
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                {deptLabel(dept)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {rows.length} {rows.length === 1 ? 'MA' : 'MA'}
              </span>
              <div className="h-px flex-1 bg-border/50" />
            </div>

            {/* Rows */}
            {rows.map(({ emp, plan, istEntry, dailyCost }) => (
              <EmployeeRow
                key={emp.id}
                employee={emp}
                date={dateStr}
                plan={plan}
                istEntry={istEntry}
                scheduleMode={scheduleMode}
                onSlotChange={onSlotChange}
                onHoursChange={onHoursChange}
                showCosts={showCosts}
                dailyCost={dailyCost}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
