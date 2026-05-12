import { useParams } from 'react-router-dom';
import { useState, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Calendar, Clock, User, Building2, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { loadPublishedSchedule, PublicEmployee, PublicDayEntry, PublishedSchedulePayload } from '@/lib/schedule-publish-store';

// ── Absence label map ─────────────────────────────────────────────────────────
const ABSENCE_LABELS: Record<string, { label: string; bg: string; text: string; border: string }> = {
  FE:  { label: 'Ferien',    bg: 'bg-blue-100 dark:bg-blue-950/40',   text: 'text-blue-700 dark:text-blue-300',   border: 'border-blue-200 dark:border-blue-700' },
  UR:  { label: 'Urlaub',    bg: 'bg-blue-100 dark:bg-blue-950/40',   text: 'text-blue-700 dark:text-blue-300',   border: 'border-blue-200 dark:border-blue-700' },
  K:   { label: 'Krank',     bg: 'bg-red-100 dark:bg-red-950/40',     text: 'text-red-700 dark:text-red-300',     border: 'border-red-200 dark:border-red-700' },
  KR:  { label: 'Krank',     bg: 'bg-red-100 dark:bg-red-950/40',     text: 'text-red-700 dark:text-red-300',     border: 'border-red-200 dark:border-red-700' },
  F:   { label: 'Frei',      bg: 'bg-slate-100 dark:bg-slate-800/60', text: 'text-slate-600 dark:text-slate-400', border: 'border-slate-200 dark:border-slate-700' },
  UB:  { label: 'Überstunden', bg: 'bg-purple-100 dark:bg-purple-950/40', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-700' },
  AZ:  { label: 'Auszeit',   bg: 'bg-orange-100 dark:bg-orange-950/40', text: 'text-orange-700 dark:text-orange-300', border: 'border-orange-200 dark:border-orange-700' },
};

function absenceStyle(code: string) {
  return ABSENCE_LABELS[code?.toUpperCase()] ?? {
    label: code,
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    border: 'border-border',
  };
}

// ── Shift / absence chip ──────────────────────────────────────────────────────
function ShiftChip({ time, absence }: { time?: { start: string; end: string } | null; absence?: string | null }) {
  if (absence) {
    const s = absenceStyle(absence);
    return (
      <span className={cn('inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold border', s.bg, s.text, s.border)}>
        {s.label}
      </span>
    );
  }
  if (time) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700 tabular-nums whitespace-nowrap">
        <Clock className="h-3 w-3 shrink-0" />
        {time.start}–{time.end}
      </span>
    );
  }
  return null;
}

// ── Helper: does a day have any entry? ───────────────────────────────────────
function isDayOff(day: PublicDayEntry): boolean {
  return !day.früh && !day.spät && !day.frühAbsence && !day.spätAbsence;
}

function getDayShifts(day: PublicDayEntry): React.ReactNode {
  if (isDayOff(day)) {
    return <span className="text-sm text-muted-foreground/50 italic">Kein Dienst</span>;
  }
  const slots: React.ReactNode[] = [];
  if (day.früh || day.frühAbsence) {
    slots.push(<ShiftChip key="f" time={day.früh} absence={day.frühAbsence} />);
  }
  if (day.spät || day.spätAbsence) {
    slots.push(<ShiftChip key="s" time={day.spät} absence={day.spätAbsence} />);
  }
  return <div className="flex flex-wrap gap-1.5">{slots}</div>;
}

// ── Weekday names ─────────────────────────────────────────────────────────────
const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// ── Personal View — mobile-first card per day ─────────────────────────────────
function PersonalView({ payload }: { payload: PublishedSchedulePayload }) {
  const employee = payload.employees?.[0];
  if (!employee) return (
    <div className="text-center py-12 text-muted-foreground">Keine Daten für diesen Mitarbeiter.</div>
  );

  return (
    <div className="space-y-3">
      {employee.days.map((day, idx) => {
        const date = parseISO(day.date);
        const isWeekend = idx >= 5;
        const dayOff = isDayOff(day);
        return (
          <div
            key={day.date}
            className={cn(
              'rounded-xl border p-4 transition-colors',
              isWeekend ? 'bg-amber-50/60 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800' : 'bg-card border-border',
              dayOff && 'opacity-50'
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={cn(
                  'text-xs font-bold uppercase tracking-wide shrink-0',
                  isWeekend ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                )}>
                  {WEEKDAY_SHORT[idx]}
                </span>
                <span className={cn(
                  'text-base font-semibold',
                  isWeekend ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'
                )}>
                  {format(date, 'd. MMMM', { locale: de })}
                </span>
              </div>
              <div className="shrink-0 mt-0.5">
                {getDayShifts(day)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Department View ────────────────────────────────────────────────────────────
type DeptViewMode = 'byEmployee' | 'byDay';

function DepartmentView({ payload }: { payload: PublishedSchedulePayload }) {
  const [mobileMode, setMobileMode] = useState<DeptViewMode>('byEmployee');
  const employees = payload.employees ?? [];

  const serviceEmps = employees.filter(e => e.department === 'service');
  const kücheEmps = employees.filter(e => e.department === 'küche');

  const days = employees[0]?.days ?? [];
  const dates = days.map(d => parseISO(d.date));

  // ── Desktop Table ──────────────────────────────────────────────────────────
  const DesktopTable = ({ emps, label, color }: { emps: PublicEmployee[]; label: string; color: string }) => {
    if (emps.length === 0) return null;
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2 px-1">
          <span className={cn('w-2 h-2 rounded-full shrink-0', color)} />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted/40">
                <th className="text-left py-2 px-3 w-36 text-xs font-semibold text-muted-foreground border-b border-border">
                  Mitarbeiter
                </th>
                {dates.map((date, i) => {
                  const isWeekend = i >= 5;
                  return (
                    <th key={i} className={cn(
                      'text-center py-2 px-1 border-b border-border min-w-[90px]',
                      isWeekend && 'bg-amber-50/60 dark:bg-amber-950/20'
                    )}>
                      <div className={cn('text-[10px] font-bold uppercase tracking-wide', isWeekend ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                        {WEEKDAY_SHORT[i]}
                      </div>
                      <div className={cn('text-sm font-bold', isWeekend ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>
                        {format(date, 'd')}
                      </div>
                      <div className="text-[10px] text-muted-foreground/60">{format(date, 'MMM', { locale: de })}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {emps.map((emp, ei) => (
                <tr key={emp.id} className={cn('border-t border-border/40', ei % 2 === 0 ? 'bg-background' : 'bg-muted/20')}>
                  <td className="py-2.5 px-3 font-medium text-sm whitespace-nowrap">{emp.name}</td>
                  {emp.days.map((day, di) => {
                    const isWeekend = di >= 5;
                    return (
                      <td key={di} className={cn('py-2 px-1 text-center', isWeekend && 'bg-amber-50/20 dark:bg-amber-950/10')}>
                        <div className="flex flex-col items-center gap-0.5">
                          {isDayOff(day) ? (
                            <span className="text-muted-foreground/30 text-xs">–</span>
                          ) : (
                            <>
                              {(day.früh || day.frühAbsence) && <ShiftChip time={day.früh} absence={day.frühAbsence} />}
                              {(day.spät || day.spätAbsence) && <ShiftChip time={day.spät} absence={day.spätAbsence} />}
                            </>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ── Mobile: By Employee ────────────────────────────────────────────────────
  const MobileByEmployee = ({ emps, label, dotColor }: { emps: PublicEmployee[]; label: string; dotColor: string }) => {
    if (emps.length === 0) return null;
    return (
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className={cn('w-2 h-2 rounded-full', dotColor)} />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <div className="space-y-3">
          {emps.map(emp => (
            <EmployeeAccordion key={emp.id} emp={emp} />
          ))}
        </div>
      </div>
    );
  };

  // ── Mobile: By Day ─────────────────────────────────────────────────────────
  const MobileByDay = () => (
    <div className="space-y-4">
      {days.map((day, idx) => {
        const date = parseISO(day.date);
        const isWeekend = idx >= 5;
        const dayEmps = employees.filter(emp => {
          const d = emp.days[idx];
          return d && !isDayOff(d);
        });
        return (
          <div key={day.date} className={cn(
            'rounded-xl border p-4',
            isWeekend ? 'bg-amber-50/60 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800' : 'bg-card border-border'
          )}>
            <div className="flex items-baseline gap-2 mb-3">
              <span className={cn('text-xs font-bold uppercase tracking-wide', isWeekend ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                {WEEKDAY_SHORT[idx]}
              </span>
              <span className={cn('text-base font-semibold', isWeekend ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>
                {format(date, 'd. MMMM', { locale: de })}
              </span>
            </div>
            {dayEmps.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 italic">Kein Dienst</p>
            ) : (
              <div className="space-y-2">
                {dayEmps.map(emp => {
                  const d = emp.days[idx];
                  return (
                    <div key={emp.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{emp.name}</span>
                      <div className="flex flex-wrap gap-1 shrink-0">
                        {(d.früh || d.frühAbsence) && <ShiftChip time={d.früh} absence={d.frühAbsence} />}
                        {(d.spät || d.spätAbsence) && <ShiftChip time={d.spät} absence={d.spätAbsence} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const showService = payload.department === 'all' || payload.department === 'service';
  const showKüche   = payload.department === 'all' || payload.department === 'küche';

  return (
    <div>
      {/* Mobile mode toggle */}
      <div className="flex sm:hidden items-center gap-2 mb-4">
        <Button
          size="sm"
          variant={mobileMode === 'byEmployee' ? 'default' : 'outline'}
          className="flex-1 h-8 text-xs"
          onClick={() => setMobileMode('byEmployee')}
        >
          <User className="h-3.5 w-3.5 mr-1.5" />
          Nach Mitarbeiter
        </Button>
        <Button
          size="sm"
          variant={mobileMode === 'byDay' ? 'default' : 'outline'}
          className="flex-1 h-8 text-xs"
          onClick={() => setMobileMode('byDay')}
        >
          <Calendar className="h-3.5 w-3.5 mr-1.5" />
          Nach Tag
        </Button>
      </div>

      {/* Desktop: tables */}
      <div className="hidden sm:block">
        {showService && <DesktopTable emps={serviceEmps} label="Service" color="bg-blue-500" />}
        {showKüche   && <DesktopTable emps={kücheEmps}   label="Küche"   color="bg-orange-500" />}
      </div>

      {/* Mobile: by employee */}
      <div className={cn('sm:hidden', mobileMode !== 'byEmployee' && 'hidden')}>
        {showService && <MobileByEmployee emps={serviceEmps} label="Service" dotColor="bg-blue-500" />}
        {showKüche   && <MobileByEmployee emps={kücheEmps}   label="Küche"   dotColor="bg-orange-500" />}
      </div>

      {/* Mobile: by day */}
      <div className={cn('sm:hidden', mobileMode !== 'byDay' && 'hidden')}>
        <MobileByDay />
      </div>
    </div>
  );
}

// ── Accordion for employee on mobile ─────────────────────────────────────────
function EmployeeAccordion({ emp }: { emp: PublicEmployee }) {
  const [open, setOpen] = useState(true);
  const workDays = emp.days.filter(d => !isDayOff(d)).length;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-sm font-semibold">{emp.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{workDays} Tage</span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/50 px-4 pb-3 pt-2 space-y-2">
          {emp.days.map((day, idx) => {
            const date = parseISO(day.date);
            const isWeekend = idx >= 5;
            const dayOff = isDayOff(day);
            return (
              <div key={day.date} className={cn('flex items-center justify-between gap-2 py-1', dayOff && 'opacity-40')}>
                <div className="flex items-baseline gap-2">
                  <span className={cn('text-[11px] font-bold uppercase w-5 shrink-0', isWeekend ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                    {WEEKDAY_SHORT[idx]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format(date, 'd. MMM', { locale: de })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {dayOff ? (
                    <span className="text-xs text-muted-foreground/40">–</span>
                  ) : (
                    <>
                      {(day.früh || day.frühAbsence) && <ShiftChip time={day.früh} absence={day.frühAbsence} />}
                      {(day.spät || day.spätAbsence) && <ShiftChip time={day.spät} absence={day.spätAbsence} />}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-muted/30 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-full sm:w-auto">Legende</p>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700">
          <Clock className="h-2.5 w-2.5" />08:00–16:00
        </span>
        <span className="text-[11px] text-muted-foreground">Schichtzeit</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700">Ferien</span>
        <span className="text-[11px] text-muted-foreground">Ferien</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-700">Krank</span>
        <span className="text-[11px] text-muted-foreground">Krank</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">Frei</span>
        <span className="text-[11px] text-muted-foreground">Frei</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground/30 text-xs">–</span>
        <span className="text-[11px] text-muted-foreground">Kein Dienst</span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
const StaffSchedulePage = () => {
  const { token } = useParams<{ token: string }>();
  const payload = useMemo(() => loadPublishedSchedule(token ?? ''), [token]);

  // ── No data: clean error state ────────────────────────────────────────────
  if (!payload) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-bold text-foreground">Link nicht verfügbar</h1>
          <p className="text-sm text-muted-foreground">
            Dieser Dienstplan-Link ist nicht mehr verfügbar oder wurde noch nicht veröffentlicht.
          </p>
          <p className="text-xs text-muted-foreground/60">
            Bitte wenden Sie sich an Ihre Vorgesetzte Person.
          </p>
        </div>
      </div>
    );
  }

  const isPersonal = payload.type === 'personal';
  const deptLabel = payload.department === 'service' ? 'Service'
    : payload.department === 'küche' ? 'Küche'
    : 'Alle Abteilungen';

  return (
    <div className="min-h-screen bg-background">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                <p className="text-xs font-bold uppercase tracking-widest text-primary">{payload.restaurant}</p>
              </div>
              <h1 className="text-lg font-bold text-foreground leading-tight">
                {isPersonal ? payload.employeeName ?? 'Dienstplan' : 'Dienstplan'}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">{payload.weekLabel}</span>
                </div>
                {!isPersonal && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground/40">·</span>
                    <span className="text-xs text-muted-foreground">{deptLabel}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Badge variant="outline" className="text-[10px] font-semibold border-muted-foreground/30 text-muted-foreground">
                Nur Ansicht
              </Badge>
              {isPersonal && (
                <Badge variant="outline" className="text-[10px] font-semibold border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-400">
                  Persönlicher Plan
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {isPersonal ? (
          <PersonalView payload={payload} />
        ) : (
          <DepartmentView payload={payload} />
        )}

        <Legend />

      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border mt-8 px-4 py-5 text-center">
        <p className="text-[11px] text-muted-foreground/60">
          {payload.restaurant} · Dienstplan {payload.weekLabel}
        </p>
        <p className="text-[10px] text-muted-foreground/40 mt-1">
          Dieser Link ist nur zur Ansicht · Keine vertraulichen Kostendaten enthalten
        </p>
      </footer>

    </div>
  );
};

export default StaffSchedulePage;
