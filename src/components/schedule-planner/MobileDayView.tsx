import React, { useState, useMemo } from 'react';
import { format, isWeekend, isSunday } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { DaySchedule } from './ScheduleGrid';
import { cn } from '@/lib/utils';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Clock, ChevronRight, Minus, Check, X,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ActualHourEntry {
  hours: number;
  start?: string;
  end?: string;
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
}

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
          {/* Quick absences */}
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

          {/* Quick shifts */}
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

          {/* Manual time entry */}
          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs font-semibold text-muted-foreground">Manuelle Zeiten</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px]">Früh von</Label>
                <Input type="time" value={frühStart} onChange={e => setFrühStart(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Früh bis</Label>
                <Input type="time" value={frühEnd} onChange={e => setFrühEnd(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Spät von</Label>
                <Input type="time" value={spätStart} onChange={e => setSpätStart(e.target.value)} className="h-9 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Spät bis</Label>
                <Input type="time" value={spätEnd} onChange={e => setSpätEnd(e.target.value)} className="h-9 text-sm" />
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
              <Input type="time" value={startVal} onChange={e => setStartVal(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Bis</Label>
              <Input type="time" value={endVal} onChange={e => setEndVal(e.target.value)} className="h-9 text-sm" />
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

// ── Employee Card ─────────────────────────────────────────────────────────────

interface EmployeeCardProps {
  employee: Employee;
  date: string;
  plan: DaySchedule | undefined;
  istEntry: ActualHourEntry | undefined;
  scheduleMode: MobileDayViewProps['scheduleMode'];
  actualMonthHours: number;
  plannedMonthHours: number;
  targetHours: number;
  onSlotChange: MobileDayViewProps['onSlotChange'];
  onHoursChange: MobileDayViewProps['onHoursChange'];
}

function PlanBadge({ plan, shiftMap }: { plan: DaySchedule | undefined; shiftMap: Record<string, { abbrev?: string; color?: string; hours?: number }> }) {
  if (!plan) return <span className="text-muted-foreground text-sm">—</span>;

  const lines: React.ReactNode[] = [];

  if (plan.frühAbsence) {
    const cfg = Object.values(shiftMap).find(s => s.abbrev === plan.frühAbsence);
    lines.push(
      <span key="frAbsence" className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border', cfg?.color ?? 'bg-gray-100 text-gray-700 border-gray-300')}>
        {plan.frühAbsence}
      </span>
    );
  } else if (plan.früh) {
    lines.push(
      <span key="früh" className="text-sm font-medium tabular-nums">
        {plan.früh.start}–{plan.früh.end}
      </span>
    );
  }

  if (plan.spätAbsence && plan.spätAbsence !== plan.frühAbsence) {
    const cfg = Object.values(shiftMap).find(s => s.abbrev === plan.spätAbsence);
    lines.push(
      <span key="spAbsence" className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border', cfg?.color ?? 'bg-gray-100 text-gray-700 border-gray-300')}>
        {plan.spätAbsence}
      </span>
    );
  } else if (plan.spät) {
    lines.push(
      <span key="spät" className="text-sm font-medium tabular-nums text-muted-foreground">
        +{plan.spät.start}–{plan.spät.end}
      </span>
    );
  }

  if (lines.length === 0) return <span className="text-muted-foreground text-sm">—</span>;

  return <div className="flex flex-col gap-0.5">{lines}</div>;
}

function IstBadge({ entry }: { entry: ActualHourEntry | undefined }) {
  if (!entry) return <span className="text-muted-foreground text-sm">—</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-semibold tabular-nums">{entry.hours.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h</span>
      {entry.start && entry.end && (
        <span className="text-[11px] text-muted-foreground tabular-nums">{entry.start}–{entry.end}</span>
      )}
    </div>
  );
}

function EmployeeCard({
  employee, date, plan, istEntry, scheduleMode,
  actualMonthHours, plannedMonthHours, targetHours,
  onSlotChange, onHoursChange,
}: EmployeeCardProps) {
  const { shiftMap } = useShiftConfig();
  const [planEditOpen, setPlanEditOpen] = useState(false);
  const [istEditOpen,  setIstEditOpen]  = useState(false);

  const progress = scheduleMode === 'ist'
    ? Math.min(100, targetHours > 0 ? (actualMonthHours / targetHours) * 100 : 0)
    : Math.min(100, targetHours > 0 ? (plannedMonthHours / targetHours) * 100 : 0);

  const currentHours = scheduleMode === 'ist' ? actualMonthHours : plannedMonthHours;

  return (
    <>
      <div className="bg-card border rounded-xl overflow-hidden shadow-sm active:bg-muted/30 transition-colors">
        {/* Top row: name + plan/ist */}
        <div className="flex items-stretch">
          {/* Left: name + meta */}
          <div
            className="flex-1 min-w-0 p-3 cursor-pointer"
            onClick={() => scheduleMode !== 'ist' ? setPlanEditOpen(true) : setPlanEditOpen(true)}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className={cn('w-2 h-2 rounded-full shrink-0', deptColor(employee.department))} />
              <span className="font-semibold text-sm leading-tight truncate">{getEmployeeDisplayName(employee)}</span>
            </div>
            <span className="text-[11px] text-muted-foreground leading-tight">
              {employee.employmentType === 'vollzeit' ? 'Vollzeit' : employee.employmentType === 'teilzeit' ? 'Teilzeit' : employee.employmentType}
              {targetHours > 0 && ` · Σ ${currentHours.toFixed(1)}/${targetHours.toFixed(0)}h`}
            </span>
            <div className="mt-2">
              <Progress value={progress} className="h-1.5" />
            </div>
          </div>

          {/* Right: plan column */}
          {(scheduleMode === 'plan' || scheduleMode === 'compare') && (
            <div
              className="border-l px-3 flex flex-col justify-center min-w-[110px] cursor-pointer hover:bg-muted/40 transition-colors"
              onClick={() => setPlanEditOpen(true)}
            >
              <span className="text-[10px] text-muted-foreground font-semibold mb-1">PLAN</span>
              <PlanBadge plan={plan} shiftMap={shiftMap} />
              <ChevronRight className="h-3 w-3 text-muted-foreground/50 mt-1 self-end" />
            </div>
          )}

          {/* Right: ist column */}
          {(scheduleMode === 'ist' || scheduleMode === 'compare') && (
            <div
              className="border-l px-3 flex flex-col justify-center min-w-[90px] cursor-pointer hover:bg-muted/40 transition-colors"
              onClick={() => setIstEditOpen(true)}
            >
              <span className="text-[10px] text-muted-foreground font-semibold mb-1">IST</span>
              <IstBadge entry={istEntry} />
              <ChevronRight className="h-3 w-3 text-muted-foreground/50 mt-1 self-end" />
            </div>
          )}
        </div>
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

const DEPT_ORDER = ['service', 'küche', 'kueche'];

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
}: MobileDayViewProps) {
  const dateStr = format(day, 'yyyy-MM-dd');
  const isWeekendDay = isWeekend(day);
  const isSun = isSunday(day);

  // Group employees by department, preserving order
  const grouped = useMemo(() => {
    const depts = [...new Set(employees.map(e => e.department))].sort((a, b) => {
      const ai = DEPT_ORDER.indexOf(a);
      const bi = DEPT_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return depts.map(dept => ({
      dept,
      emps: employees.filter(e => e.department === dept),
    }));
  }, [employees]);

  return (
    <div className="space-y-1">
      {/* Day header */}
      <div className={cn(
        'flex items-center justify-between px-1 py-2 mb-3',
        isWeekendDay && 'opacity-80',
      )}>
        <div>
          <span className="text-lg font-bold">
            {format(day, 'EEEE', { locale: de })}
          </span>
          <span className={cn(
            'ml-2 text-base text-muted-foreground',
            isSun && 'text-red-500 dark:text-red-400',
          )}>
            {format(day, 'd. MMMM yyyy', { locale: de })}
          </span>
        </div>
        {isWeekendDay && (
          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">Wochenende</span>
        )}
      </div>

      {/* Departments */}
      {grouped.map(({ dept, emps }) => (
        <div key={dept} className="space-y-2 mb-5">
          {/* Dept label */}
          <div className="flex items-center gap-2">
            <span className={cn('w-2.5 h-2.5 rounded-full', deptColor(dept))} />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {deptLabel(dept)} · {emps.length} MA
            </span>
          </div>

          {/* Cards */}
          {emps.map(emp => {
            const key = `${emp.id}-${dateStr}`;
            return (
              <EmployeeCard
                key={emp.id}
                employee={emp}
                date={dateStr}
                plan={scheduleData[key]}
                istEntry={actualHoursData[key]}
                scheduleMode={scheduleMode}
                plannedMonthHours={getEmployeeHours(emp.id)}
                actualMonthHours={getEmployeeActualHours(emp.id)}
                targetHours={getTargetHours(emp)}
                onSlotChange={onSlotChange}
                onHoursChange={onHoursChange}
              />
            );
          })}
        </div>
      ))}

      {employees.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Clock className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">Keine Mitarbeiter in diesem Bereich</p>
        </div>
      )}
    </div>
  );
}
