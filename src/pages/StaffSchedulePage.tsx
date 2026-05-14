import { useParams } from 'react-router-dom';
import { useState, useMemo } from 'react';
import {
  format, parseISO, getDay, isSameDay,
  startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import {
  Calendar, Clock, LayoutList, User, Building2, AlertCircle,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  loadPublishedSchedule,
  PublicEmployee,
  PublicDayEntry,
  PublishedSchedulePayload,
} from '@/lib/schedule-publish-store';

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Saturday (6) or Sunday (0). */
function isWeekendDate(dateStr: string): boolean {
  const d = getDay(parseISO(dateStr));
  return d === 0 || d === 6;
}

function isTodayDate(dateStr: string): boolean {
  return isSameDay(parseISO(dateStr), new Date());
}

function isEmptyDay(day: PublicDayEntry): boolean {
  return !day.früh && !day.spät && !day.frühAbsence && !day.spätAbsence;
}

/** Format "10:00" → "10", "10:30" → "10:30". */
function fmtHour(t: string): string {
  const [h, m] = t.split(':');
  return m === '00' ? h : `${h}:${m}`;
}

/** "10:00"–"14:00" → "10–14". */
function fmtRange(start: string, end: string): string {
  return `${fmtHour(start)}–${fmtHour(end)}`;
}

// ── Absence styling ───────────────────────────────────────────────────────────

const ABSENCE_MAP: Record<string, { label: string; short: string; cls: string }> = {
  FE:  { label: 'Ferien',      short: 'FE', cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700' },
  UR:  { label: 'Urlaub',      short: 'UR', cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700' },
  K:   { label: 'Krank',       short: 'Kr', cls: 'bg-red-100  text-red-700  border-red-200  dark:bg-red-950/40  dark:text-red-300  dark:border-red-700'  },
  KR:  { label: 'Krank',       short: 'Kr', cls: 'bg-red-100  text-red-700  border-red-200  dark:bg-red-950/40  dark:text-red-300  dark:border-red-700'  },
  F:   { label: 'Frei',        short: 'Fr', cls: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700' },
  UB:  { label: 'Überstunden', short: 'UB', cls: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-700' },
  AZ:  { label: 'Auszeit',     short: 'AZ', cls: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-700' },
};

function absenceMeta(code: string) {
  return ABSENCE_MAP[code?.toUpperCase()] ?? {
    label: code, short: code?.slice(0, 2).toUpperCase(), cls: 'bg-muted text-muted-foreground border-border',
  };
}

// ── Chips ─────────────────────────────────────────────────────────────────────

function ShiftChip({ start, end }: { start: string; end: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold tabular-nums whitespace-nowrap bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700">
      <Clock className="h-3.5 w-3.5 shrink-0" />
      {start}–{end}
    </span>
  );
}

function AbsenceChip({ code }: { code: string }) {
  const { label, cls } = absenceMeta(code);
  return (
    <span className={cn('inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-semibold border', cls)}>
      {label}
    </span>
  );
}

/** Full-size shift/absence content for list cards. */
function DayContent({ day, compact = false }: { day: PublicDayEntry; compact?: boolean }) {
  if (isEmptyDay(day)) {
    return (
      <span className={cn('text-muted-foreground/40 italic', compact ? 'text-xs' : 'text-sm')}>
        Kein Dienst
      </span>
    );
  }
  const items: React.ReactNode[] = [];
  if (day.frühAbsence) {
    items.push(<AbsenceChip key="fa" code={day.frühAbsence} />);
  } else if (day.früh) {
    items.push(<ShiftChip key="f" start={day.früh.start} end={day.früh.end} />);
  }
  if (day.spätAbsence && day.spätAbsence !== day.frühAbsence) {
    items.push(<AbsenceChip key="sa" code={day.spätAbsence} />);
  } else if (day.spät) {
    items.push(<ShiftChip key="s" start={day.spät.start} end={day.spät.end} />);
  }
  return <div className={cn('flex flex-col gap-1.5', compact && 'gap-1')}>{items}</div>;
}

// ── Calendar cell — very compact ──────────────────────────────────────────────

function CalendarCell({ day }: { day: PublicDayEntry | null; date?: Date }) {
  if (!day) {
    return <div className="rounded-md bg-muted/10 min-h-[58px]" />;
  }
  const date    = parseISO(day.date);
  const wknd    = isWeekendDate(day.date);
  const isToday = isTodayDate(day.date);
  const empty   = isEmptyDay(day);

  // Collect compact lines
  const lines: string[] = [];
  if (day.frühAbsence) {
    lines.push(absenceMeta(day.frühAbsence).short);
  } else if (day.früh) {
    lines.push(fmtRange(day.früh.start, day.früh.end));
  }
  if (day.spätAbsence && day.spätAbsence !== day.frühAbsence) {
    lines.push(absenceMeta(day.spätAbsence).short);
  } else if (day.spät) {
    lines.push(fmtRange(day.spät.start, day.spät.end));
  }

  return (
    <div className={cn(
      'rounded-md border px-1 py-1 min-h-[58px] flex flex-col',
      isToday
        ? 'bg-blue-50/90 border-blue-300 dark:bg-blue-950/40 dark:border-blue-700'
        : wknd
          ? 'bg-amber-50/50 border-amber-200/60 dark:bg-amber-950/10 dark:border-amber-800/40'
          : 'bg-card border-border/40',
      empty && !isToday && 'opacity-35',
    )}>
      {/* Day number */}
      <div className={cn(
        'text-[11px] font-bold text-center leading-none mb-1',
        isToday ? 'text-blue-600 dark:text-blue-400'
        : wknd   ? 'text-amber-500 dark:text-amber-400'
        : 'text-muted-foreground',
      )}>
        {format(date, 'd')}
      </div>

      {/* Shift / absence lines */}
      <div className="flex flex-col items-center gap-0.5 flex-1">
        {lines.map((line, i) => {
          const isAbsCode = !!ABSENCE_MAP[line.toUpperCase()];
          return (
            <span
              key={i}
              className={cn(
                'text-[9px] font-semibold leading-tight text-center w-full truncate px-0.5 rounded',
                isAbsCode
                  ? 'text-blue-700 dark:text-blue-300'
                  : 'text-emerald-700 dark:text-emerald-400',
              )}
            >
              {line}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Calendar view (personal) ──────────────────────────────────────────────────

const CAL_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function CalendarView({ employee, payload }: { employee: PublicEmployee; payload: PublishedSchedulePayload }) {
  const days = employee.days;
  if (days.length === 0) return null;

  const isMonth = payload.period === 'month';

  // Build a lookup: dateStr → PublicDayEntry
  const dayMap = new Map<string, PublicDayEntry>(days.map(d => [d.date, d]));

  // Determine the full date range to render
  const firstPayloadDate = parseISO(days[0].date);
  const lastPayloadDate  = parseISO(days[days.length - 1].date);

  // Expand to full calendar weeks so the grid aligns Mon–Sun
  const calStart = startOfWeek(isMonth ? startOfMonth(firstPayloadDate) : firstPayloadDate, { weekStartsOn: 1 });
  const calEnd   = endOfWeek(isMonth ? endOfMonth(lastPayloadDate) : lastPayloadDate, { weekStartsOn: 1 });
  const calDays  = eachDayOfInterval({ start: calStart, end: calEnd });

  // Group into weeks
  const weeks: Date[][] = [];
  for (let i = 0; i < calDays.length; i += 7) {
    weeks.push(calDays.slice(i, i + 7));
  }

  return (
    <div>
      {/* Header row */}
      <div className="grid grid-cols-7 gap-1 mb-1.5">
        {CAL_HEADERS.map(h => (
          <div key={h} className={cn(
            'text-center text-[10px] font-bold uppercase tracking-wide py-0.5',
            h === 'Sa' || h === 'So' ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground/60',
          )}>
            {h}
          </div>
        ))}
      </div>

      {/* Week rows */}
      <div className="space-y-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-1">
            {week.map((date, di) => {
              const dateStr = format(date, 'yyyy-MM-dd');
              const entry = dayMap.get(dateStr) ?? null;
              // If outside the payload range, render a blank filler
              const outOfRange = date < firstPayloadDate || date > lastPayloadDate;
              return (
                <CalendarCell key={di} day={outOfRange ? null : (entry ?? {
                  date: dateStr,
                  dayLabel: '',
                  früh: null, spät: null, frühAbsence: null, spätAbsence: null,
                })} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Personal View — list + calendar toggle
// ══════════════════════════════════════════════════════════════════════════════

type PersonalViewMode = 'list' | 'calendar';

function PersonalView({ payload }: { payload: PublishedSchedulePayload }) {
  const employee = payload.employees?.[0];
  const [viewMode, setViewMode] = useState<PersonalViewMode>('list');
  const today = useMemo(() => new Date(), []);

  if (!employee) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Keine Daten für diesen Mitarbeiter.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={viewMode === 'list' ? 'default' : 'outline'}
          className="h-8 gap-1.5 text-xs"
          onClick={() => setViewMode('list')}
        >
          <LayoutList className="h-3.5 w-3.5" />
          Liste
        </Button>
        <Button
          size="sm"
          variant={viewMode === 'calendar' ? 'default' : 'outline'}
          className="h-8 gap-1.5 text-xs"
          onClick={() => setViewMode('calendar')}
        >
          <Calendar className="h-3.5 w-3.5" />
          Kalender
        </Button>
      </div>

      {/* ── List view ── */}
      {viewMode === 'list' && (
        <div className="space-y-2.5">
          {employee.days.map((day) => {
            const wknd    = isWeekendDate(day.date);
            const isToday = isSameDay(parseISO(day.date), today);
            const empty   = isEmptyDay(day);
            const date    = parseISO(day.date);
            return (
              <div
                key={day.date}
                className={cn(
                  'rounded-xl border px-4 py-3.5',
                  isToday
                    ? 'bg-blue-50/80 border-blue-300 dark:bg-blue-950/30 dark:border-blue-700'
                    : wknd
                      ? 'bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800'
                      : 'bg-card border-border',
                  empty && !isToday && 'opacity-45',
                )}
              >
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className={cn(
                      'text-[11px] font-bold uppercase tracking-widest',
                      isToday ? 'text-blue-600 dark:text-blue-400'
                      : wknd ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground/60',
                    )}>
                      {format(date, 'EE', { locale: de })}
                    </span>
                    <span className={cn(
                      'text-[15px] font-semibold',
                      isToday ? 'text-blue-800 dark:text-blue-200'
                      : wknd ? 'text-amber-800 dark:text-amber-200'
                      : 'text-foreground',
                    )}>
                      {format(date, 'd. MMMM', { locale: de })}
                    </span>
                  </div>
                  {isToday && (
                    <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-700 rounded-full px-2 py-0.5 uppercase tracking-wide shrink-0">
                      Heute
                    </span>
                  )}
                </div>
                <DayContent day={day} />
              </div>
            );
          })}
        </div>
      )}

      {/* ── Calendar view ── */}
      {viewMode === 'calendar' && (
        <CalendarView employee={employee} payload={payload} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Employee accordion (mobile by-employee in dept view)
// ══════════════════════════════════════════════════════════════════════════════

function EmployeeAccordion({ emp }: { emp: PublicEmployee }) {
  const [open, setOpen] = useState(true);
  const workDays = emp.days.filter(d => !isEmptyDay(d)).length;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-sm font-semibold">{emp.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{workDays} Tage</span>
          {open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/50 divide-y divide-border/30">
          {emp.days.map((day) => {
            const wknd    = isWeekendDate(day.date);
            const isToday = isTodayDate(day.date);
            const empty   = isEmptyDay(day);
            const date    = parseISO(day.date);
            return (
              <div
                key={day.date}
                className={cn(
                  'flex items-start justify-between gap-3 px-4 py-2.5',
                  isToday && 'bg-blue-50/60 dark:bg-blue-950/20',
                  !isToday && wknd && 'bg-amber-50/30 dark:bg-amber-950/10',
                  empty && !isToday && 'opacity-40',
                )}
              >
                <div className="flex items-baseline gap-2 shrink-0 min-w-[80px]">
                  <span className={cn(
                    'text-[10px] font-bold uppercase tracking-widest',
                    isToday ? 'text-blue-600 dark:text-blue-400'
                    : wknd ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground/60',
                  )}>
                    {format(date, 'EE', { locale: de })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format(date, 'd. MMM', { locale: de })}
                  </span>
                </div>
                <div className="flex-1 flex flex-col items-end gap-1">
                  <DayContent day={day} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Department View
// ══════════════════════════════════════════════════════════════════════════════

type DeptViewMode = 'byEmployee' | 'byDay';

function DepartmentView({ payload }: { payload: PublishedSchedulePayload }) {
  const [mobileMode, setMobileMode] = useState<DeptViewMode>('byEmployee');
  const employees = payload.employees ?? [];

  const showService = payload.department === 'all' || payload.department === 'service';
  const showKüche   = payload.department === 'all' || payload.department === 'küche';

  const serviceEmps = employees.filter(e => e.department === 'service');
  const kücheEmps   = employees.filter(e => e.department === 'küche');

  const allDays = employees[0]?.days ?? [];

  // ── Desktop table ──────────────────────────────────────────────────────────
  const DesktopTable = ({
    emps, label, dotColor,
  }: { emps: PublicEmployee[]; label: string; dotColor: string }) => {
    if (emps.length === 0) return null;
    const dates = allDays.map(d => parseISO(d.date));
    return (
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2 px-1">
          <span className={cn('w-2 h-2 rounded-full shrink-0', dotColor)} />
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
                  const wknd    = isWeekendDate(allDays[i].date);
                  const isToday = isTodayDate(allDays[i].date);
                  return (
                    <th key={i} className={cn(
                      'text-center py-2 px-1 border-b border-border min-w-[90px]',
                      isToday ? 'bg-blue-50/60 dark:bg-blue-950/20'
                      : wknd && 'bg-amber-50/60 dark:bg-amber-950/20',
                    )}>
                      <div className={cn(
                        'text-[10px] font-bold uppercase tracking-wide',
                        isToday ? 'text-blue-600 dark:text-blue-400'
                        : wknd ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground',
                      )}>
                        {format(date, 'EE', { locale: de })}
                      </div>
                      <div className={cn(
                        'text-sm font-bold',
                        isToday ? 'text-blue-800 dark:text-blue-200'
                        : wknd ? 'text-amber-700 dark:text-amber-300'
                        : 'text-foreground',
                      )}>
                        {format(date, 'd')}
                      </div>
                      <div className="text-[10px] text-muted-foreground/60">
                        {format(date, 'MMM', { locale: de })}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {emps.map((emp, ei) => (
                <tr key={emp.id} className={cn(
                  'border-t border-border/40',
                  ei % 2 === 0 ? 'bg-background' : 'bg-muted/20',
                )}>
                  <td className="py-2.5 px-3 font-medium text-sm whitespace-nowrap">{emp.name}</td>
                  {emp.days.map((day, di) => {
                    const wknd    = isWeekendDate(day.date);
                    const isToday = isTodayDate(day.date);
                    const empty   = isEmptyDay(day);
                    return (
                      <td key={di} className={cn(
                        'py-2 px-1 text-center align-middle',
                        isToday ? 'bg-blue-50/30 dark:bg-blue-950/10'
                        : wknd && 'bg-amber-50/20 dark:bg-amber-950/10',
                      )}>
                        {empty ? (
                          <span className="text-muted-foreground/25 text-xs">–</span>
                        ) : (
                          <div className="flex flex-col items-center gap-0.5">
                            <DayContent day={day} compact />
                          </div>
                        )}
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

  // ── Mobile by-employee ─────────────────────────────────────────────────────
  const MobileByEmployee = ({
    emps, label, dotColor,
  }: { emps: PublicEmployee[]; label: string; dotColor: string }) => {
    if (emps.length === 0) return null;
    return (
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className={cn('w-2 h-2 rounded-full', dotColor)} />
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
        <div className="space-y-3">
          {emps.map(emp => <EmployeeAccordion key={emp.id} emp={emp} />)}
        </div>
      </div>
    );
  };

  // ── Mobile by-day ──────────────────────────────────────────────────────────
  const MobileByDay = () => (
    <div className="space-y-3">
      {allDays.map((refDay, idx) => {
        const date    = parseISO(refDay.date);
        const wknd    = isWeekendDate(refDay.date);
        const isToday = isTodayDate(refDay.date);
        const activeEmps = employees.filter(emp => {
          const d = emp.days[idx];
          return d && !isEmptyDay(d);
        });
        return (
          <div key={refDay.date} className={cn(
            'rounded-xl border px-4 py-3.5',
            isToday
              ? 'bg-blue-50/80 border-blue-300 dark:bg-blue-950/30 dark:border-blue-700'
              : wknd
                ? 'bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800'
                : 'bg-card border-border',
          )}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  'text-[11px] font-bold uppercase tracking-widest',
                  isToday ? 'text-blue-600 dark:text-blue-400'
                  : wknd ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground/60',
                )}>
                  {format(date, 'EE', { locale: de })}
                </span>
                <span className={cn(
                  'text-[15px] font-semibold',
                  isToday ? 'text-blue-800 dark:text-blue-200'
                  : wknd ? 'text-amber-800 dark:text-amber-200'
                  : 'text-foreground',
                )}>
                  {format(date, 'd. MMMM', { locale: de })}
                </span>
              </div>
              {isToday && (
                <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-700 rounded-full px-2 py-0.5 uppercase tracking-wide shrink-0">
                  Heute
                </span>
              )}
            </div>
            {activeEmps.length === 0 ? (
              <p className="text-xs text-muted-foreground/40 italic">Kein Dienst</p>
            ) : (
              <div className="space-y-2.5">
                {activeEmps.map(emp => {
                  const d = emp.days[idx];
                  return (
                    <div key={emp.id} className="flex items-start justify-between gap-3">
                      <span className="text-sm font-medium truncate pt-0.5">{emp.name}</span>
                      <div className="shrink-0">
                        <DayContent day={d} compact />
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

  return (
    <div>
      {/* Mobile toggle */}
      <div className="flex sm:hidden items-center gap-2 mb-5">
        <Button
          size="sm"
          variant={mobileMode === 'byEmployee' ? 'default' : 'outline'}
          className="flex-1 h-9 text-sm"
          onClick={() => setMobileMode('byEmployee')}
        >
          <User className="h-3.5 w-3.5 mr-1.5" />
          Mitarbeiter
        </Button>
        <Button
          size="sm"
          variant={mobileMode === 'byDay' ? 'default' : 'outline'}
          className="flex-1 h-9 text-sm"
          onClick={() => setMobileMode('byDay')}
        >
          <Calendar className="h-3.5 w-3.5 mr-1.5" />
          Nach Tag
        </Button>
      </div>

      {/* Desktop */}
      <div className="hidden sm:block">
        {showService && <DesktopTable emps={serviceEmps} label="Service" dotColor="bg-blue-500" />}
        {showKüche   && <DesktopTable emps={kücheEmps}   label="Küche"   dotColor="bg-orange-500" />}
      </div>

      {/* Mobile — by employee */}
      <div className={cn('sm:hidden', mobileMode !== 'byEmployee' && 'hidden')}>
        {showService && <MobileByEmployee emps={serviceEmps} label="Service" dotColor="bg-blue-500" />}
        {showKüche   && <MobileByEmployee emps={kücheEmps}   label="Küche"   dotColor="bg-orange-500" />}
      </div>

      {/* Mobile — by day */}
      <div className={cn('sm:hidden', mobileMode !== 'byDay' && 'hidden')}>
        <MobileByDay />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Legend
// ══════════════════════════════════════════════════════════════════════════════

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-muted/30 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-full sm:w-auto">
        Legende
      </p>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700 tabular-nums">
          <Clock className="h-2.5 w-2.5" />10:00–18:00
        </span>
        <span className="text-[11px] text-muted-foreground">Schicht</span>
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

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

const StaffSchedulePage = () => {
  const { token } = useParams<{ token: string }>();
  const payload = useMemo(() => loadPublishedSchedule(token ?? ''), [token]);

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
  const deptLabel  =
    payload.department === 'service' ? 'Service'
    : payload.department === 'küche' ? 'Küche'
    : 'Alle Abteilungen';

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Building2 className="h-3 w-3 text-primary shrink-0" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-primary">
                  {payload.restaurant}
                </p>
              </div>
              <h1 className="text-[17px] font-bold text-foreground leading-snug">
                {isPersonal
                  ? (payload.employeeName ?? 'Dienstplan')
                  : `Dienstplan ${deptLabel}`}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">{payload.weekLabel}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Badge variant="outline" className="text-[10px] font-semibold border-muted-foreground/30 text-muted-foreground whitespace-nowrap">
                Nur Ansicht
              </Badge>
              {isPersonal && (
                <Badge variant="outline" className="text-[10px] font-semibold border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-400 whitespace-nowrap">
                  Persönlicher Plan
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        {isPersonal
          ? <PersonalView payload={payload} />
          : <DepartmentView payload={payload} />}
        <Legend />
        <p className="text-center text-[10px] text-muted-foreground/40 pb-4">
          Veröffentlicht am {new Date(payload.publishedAt).toLocaleDateString('de-CH')} · Nur Ansicht
        </p>
      </main>
    </div>
  );
};

export default StaffSchedulePage;
