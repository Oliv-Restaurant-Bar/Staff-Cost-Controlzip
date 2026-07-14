import { useParams } from 'react-router-dom';
import {
  useState, useEffect, useCallback, useMemo, memo,
} from 'react';
import {
  format, parseISO, getDay, isSameDay,
  startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import {
  Calendar, Clock, LayoutList, User, Building2, AlertCircle,
  ChevronDown, ChevronUp, Check, Home, X, RefreshCw,
  History, ArrowRightLeft, Send, MessageCircle, Loader2,
  ChevronLeft, ChevronRight, Grid3x3, Zap, Printer, Share2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PublicEmployee,
  PublicDayEntry,
  PublishedSchedulePayload,
  ChangeHistoryEntry,
} from '@/lib/schedule-publish-store';
import {
  StaffPortalSettings,
  DEFAULT_STAFF_PORTAL_SETTINGS,
} from '@/lib/staff-portal-settings';
import { supabase } from '@/integrations/supabase/client';

// ── Date helpers ──────────────────────────────────────────────────────────────

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
function fmtHour(t: string): string {
  const [h, m] = t.split(':');
  return m === '00' ? h : `${h}:${m}`;
}
function fmtRange(start: string, end: string): string {
  return `${fmtHour(start)}–${fmtHour(end)}`;
}

function formatRelativeTime(iso: string): string {
  try {
    const d       = new Date(iso);
    const diffMs  = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH   = Math.floor(diffMin / 60);
    const diffD   = Math.floor(diffH / 24);
    if (diffMin < 1)  return 'gerade eben';
    if (diffMin < 60) return `vor ${diffMin} Min.`;
    if (diffH < 24)   return `vor ${diffH} Std.`;
    if (diffD === 1)  return `gestern`;
    if (diffD < 7)    return `vor ${diffD} Tagen`;
    return format(d, 'd. MMM', { locale: de });
  } catch { return ''; }
}

function formatAbsoluteTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('de-CH', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }) + ' Uhr';
  } catch { return ''; }
}

// ── Absence styling ───────────────────────────────────────────────────────────

const ABSENCE_MAP: Record<string, { label: string; short: string; cls: string; chipCls: string }> = {
  FE: { label: 'Ferien',      short: 'FE', cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700',   chipCls: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' },
  UR: { label: 'Urlaub',      short: 'UR', cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700',   chipCls: 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300' },
  K:  { label: 'Krank',       short: 'Kr', cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-700',         chipCls: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'   },
  KR: { label: 'Krank',       short: 'Kr', cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-700',         chipCls: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'   },
  F:  { label: 'Frei',        short: 'Fr', cls: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700', chipCls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
  UB: { label: 'Überstunden', short: 'UB', cls: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-700', chipCls: 'bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300' },
  AZ: { label: 'Auszeit',     short: 'AZ', cls: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-700', chipCls: 'bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300' },
};

function absenceMeta(code: string) {
  return ABSENCE_MAP[code?.toUpperCase()] ?? {
    label: code, short: code?.slice(0, 2).toUpperCase(),
    cls: 'bg-muted text-muted-foreground border-border',
    chipCls: 'bg-muted/60 text-muted-foreground',
  };
}

// ── Pausenmatrix ──────────────────────────────────────────────────────────────
// NUR für die Mitarbeiteransicht — hat keinerlei Einfluss auf Stundenberechnungen,
// AZB, Dienstplan-Editor oder Admin-Ansichten.

const BREAK_MATRIX: Record<string, string> = {
  'S1':  '11:00–11:30',
  'S2':  '21:30–22:00',
  'S3':  '14:30–15:00 + 17:30–18:00',
  'S4':  'keine Pause',
  'S5':  'keine Pause',
  'S6':  '11:30–12:00',
  'S7':  '16:00–17:15',
  'S8':  '17:30–18:00',
  'S9':  '17:30–18:00',
  'S10': '14:30–15:00 + 17:00–17:30 + 15 Min um 21:00',
  'S11': '15 Min ab 21:30',
  'S12': '21:45–22:15',
  'S13': 'keine Pause',
  'S14': '15 Min ab 21:30',
};

/**
 * Gibt Pausenhinweis-Zeilen zurück (eine pro bekanntem Schichtcode).
 * Gibt leeres Array zurück wenn kein Code bekannt — dann wird kein Hinweis angezeigt.
 */
function getBreakHints(frühCode?: string | null, spätCode?: string | null): string[] {
  const hints: string[] = [];
  if (frühCode && frühCode in BREAK_MATRIX) {
    hints.push(BREAK_MATRIX[frühCode]);
  }
  if (spätCode && spätCode !== frühCode && spätCode in BREAK_MATRIX) {
    hints.push(BREAK_MATRIX[spätCode]);
  }
  return hints;
}

/** Dezenter Pausenhinweis unter den Schichtzeiten — nur in der Mitarbeiteransicht. */
function BreakHint({ frühCode, spätCode, compact = false }: {
  frühCode?: string | null;
  spätCode?: string | null;
  compact?: boolean;
}) {
  const hints = getBreakHints(frühCode, spätCode);
  if (hints.length === 0) return null;
  return (
    <div className={cn('flex flex-col gap-0.5', compact ? 'mt-1' : 'mt-1.5')}>
      {hints.map((hint, i) => (
        <span key={i} className={cn(
          'text-muted-foreground/55 tabular-nums',
          compact ? 'text-[9px]' : 'text-[11px]',
        )}>
          Pause: {hint}
        </span>
      ))}
    </div>
  );
}

// ── Shift chips ───────────────────────────────────────────────────────────────

function ShiftChip({ start, end, large = false }: { start: string; end: string; large?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-xl font-bold tabular-nums whitespace-nowrap',
      'bg-emerald-50 text-emerald-800 border border-emerald-200',
      'dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-700',
      large ? 'px-4 py-2 text-base' : 'px-3 py-1.5 text-sm',
    )}>
      <Clock className={cn('shrink-0', large ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
      {start}–{end}
    </span>
  );
}

function AbsenceChip({ code, large = false }: { code: string; large?: boolean }) {
  const { label, cls } = absenceMeta(code);
  return (
    <span className={cn(
      'inline-flex items-center rounded-xl font-semibold border',
      cls,
      large ? 'px-4 py-2 text-base' : 'px-3 py-1.5 text-sm',
    )}>
      {label}
    </span>
  );
}

/** Compact content for list/accordion rows */
function DayContent({
  day, compact = false, showHours = true,
}: {
  day: PublicDayEntry; compact?: boolean; showHours?: boolean;
}) {
  if (isEmptyDay(day)) {
    return (
      <span className={cn('text-muted-foreground/35 italic', compact ? 'text-xs' : 'text-sm')}>
        Kein Dienst
      </span>
    );
  }
  const items: React.ReactNode[] = [];
  if (day.frühAbsence) {
    items.push(<AbsenceChip key="fa" code={day.frühAbsence} />);
  } else if (day.früh && showHours) {
    items.push(<ShiftChip key="f" start={day.früh.start} end={day.früh.end} />);
  }
  if (day.spätAbsence && day.spätAbsence !== day.frühAbsence) {
    items.push(<AbsenceChip key="sa" code={day.spätAbsence} />);
  } else if (day.spät && showHours) {
    items.push(<ShiftChip key="s" start={day.spät.start} end={day.spät.end} />);
  }
  return <div className={cn('flex flex-col gap-1.5', compact && 'gap-1')}>{items}</div>;
}

/** Ultra-compact cell for week grid */
function GridCell({ day }: { day: PublicDayEntry }) {
  const parts: Array<{ text: string; isShift: boolean }> = [];
  if (day.frühAbsence) {
    parts.push({ text: absenceMeta(day.frühAbsence).short, isShift: false });
  } else if (day.früh) {
    parts.push({ text: fmtRange(day.früh.start, day.früh.end), isShift: true });
  }
  if (day.spätAbsence && day.spätAbsence !== day.frühAbsence) {
    parts.push({ text: absenceMeta(day.spätAbsence).short, isShift: false });
  } else if (day.spät) {
    parts.push({ text: fmtRange(day.spät.start, day.spät.end), isShift: true });
  }
  if (parts.length === 0) return <span className="text-muted-foreground/20 text-xs">–</span>;
  return (
    <div className="flex flex-col items-center gap-0.5 py-0.5">
      {parts.map((p, i) => (
        <span key={i} className={cn(
          'text-[10px] font-bold leading-tight tabular-nums px-1.5 py-0.5 rounded-md',
          p.isShift
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
        )}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

// ── Calendar cell ─────────────────────────────────────────────────────────────

function CalendarCell({ day }: { day: PublicDayEntry | null }) {
  if (!day) return <div className="rounded-xl bg-muted/10 min-h-[60px]" />;
  const date      = parseISO(day.date);
  const wknd      = isWeekendDate(day.date);
  const isToday   = isTodayDate(day.date);
  const empty     = isEmptyDay(day);
  const hasChange = !!day.changed;
  const lines: string[] = [];
  if (day.frühAbsence) lines.push(absenceMeta(day.frühAbsence).short);
  else if (day.früh) lines.push(fmtRange(day.früh.start, day.früh.end));
  if (day.spätAbsence && day.spätAbsence !== day.frühAbsence) lines.push(absenceMeta(day.spätAbsence).short);
  else if (day.spät) lines.push(fmtRange(day.spät.start, day.spät.end));

  return (
    <div className={cn(
      'rounded-xl border px-1 py-1.5 min-h-[60px] flex flex-col relative transition-colors',
      isToday   ? 'bg-blue-50 border-blue-300 shadow-sm dark:bg-blue-950/40 dark:border-blue-700'
      : hasChange ? 'bg-amber-50/60 border-amber-400 dark:bg-amber-950/20 dark:border-amber-600'
      : wknd    ? 'bg-amber-50/40 border-amber-200/60 dark:bg-amber-950/10 dark:border-amber-800/40'
      : 'bg-card border-border/30',
      empty && !isToday && !hasChange && 'opacity-30',
    )}>
      {hasChange && <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />}
      <div className={cn(
        'text-[11px] font-bold text-center leading-none mb-1',
        isToday ? 'text-blue-600 dark:text-blue-400'
        : wknd  ? 'text-amber-500 dark:text-amber-400'
        : 'text-muted-foreground/60',
      )}>
        {format(date, 'd')}
      </div>
      <div className="flex flex-col items-center gap-0.5 flex-1">
        {lines.map((line, i) => {
          const isAbs = !!ABSENCE_MAP[line.toUpperCase()];
          return (
            <span key={i} className={cn(
              'text-[9px] font-bold leading-tight text-center w-full truncate px-0.5 rounded',
              isAbs ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-400',
            )}>
              {line}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Calendar (personal) ───────────────────────────────────────────────────────

const CAL_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function CalendarView({ employee, payload }: { employee: PublicEmployee; payload: PublishedSchedulePayload }) {
  const days = employee.days;
  if (days.length === 0) return null;
  const isMonth = payload.period === 'month';
  const dayMap  = new Map<string, PublicDayEntry>(days.map(d => [d.date, d]));
  const first   = parseISO(days[0].date);
  const last    = parseISO(days[days.length - 1].date);
  const calStart = startOfWeek(isMonth ? startOfMonth(first) : first, { weekStartsOn: 1 });
  const calEnd   = endOfWeek(isMonth ? endOfMonth(last) : last, { weekStartsOn: 1 });
  const allDates = eachDayOfInterval({ start: calStart, end: calEnd });
  const weeks: Date[][] = [];
  for (let i = 0; i < allDates.length; i += 7) weeks.push(allDates.slice(i, i + 7));

  return (
    <div className="rounded-2xl border border-border/40 bg-card p-3 shadow-sm">
      <div className="grid grid-cols-7 gap-1 mb-1.5">
        {CAL_HEADERS.map(h => (
          <div key={h} className={cn(
            'text-center text-[10px] font-bold uppercase tracking-wide py-0.5',
            h === 'Sa' || h === 'So' ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground/50',
          )}>{h}</div>
        ))}
      </div>
      <div className="space-y-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-1">
            {week.map((date, di) => {
              const dateStr    = format(date, 'yyyy-MM-dd');
              const entry      = dayMap.get(dateStr) ?? null;
              const outOfRange = date < first || date > last;
              return (
                <CalendarCell key={di} day={outOfRange ? null : (entry ?? {
                  date: dateStr, dayLabel: '',
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

// ── Week grid view (memo'd for performance) ───────────────────────────────────

const WeekGridView = memo(function WeekGridView({
  emps, refDays,
}: { emps: PublicEmployee[]; refDays: PublicDayEntry[] }) {
  if (refDays.length === 0) return (
    <p className="text-sm text-muted-foreground italic text-center py-8">Keine Tage vorhanden.</p>
  );
  const COL_W = 88; // px per day column
  const NAME_W = 140; // px for name column
  return (
    <div className="overflow-x-auto rounded-2xl border border-border/50 shadow-sm bg-card">
      <table
        className="border-collapse text-sm"
        style={{ minWidth: `${NAME_W + refDays.length * COL_W}px`, tableLayout: 'fixed', width: `${NAME_W + refDays.length * COL_W}px` }}
      >
        <colgroup>
          <col style={{ width: NAME_W }} />
          {refDays.map(d => <col key={d.date} style={{ width: COL_W }} />)}
        </colgroup>
        <thead>
          <tr className="border-b border-border/40">
            {/* Sticky name header */}
            <th className="sticky left-0 z-20 bg-muted text-left py-3 px-3 text-[11px] font-bold text-muted-foreground border-r-2 border-border/50 whitespace-nowrap">
              Mitarbeiter
            </th>
            {refDays.map((refDay) => {
              const date    = parseISO(refDay.date);
              const wknd    = isWeekendDate(refDay.date);
              const isToday = isTodayDate(refDay.date);
              return (
                <th key={refDay.date} className={cn(
                  'text-center py-2 px-1 border-l border-border/20',
                  isToday ? 'bg-blue-50/90 dark:bg-blue-950/40'
                  : wknd  ? 'bg-amber-50/60 dark:bg-amber-950/20'
                  : 'bg-muted/30',
                )}>
                  <div className={cn(
                    'text-[10px] font-bold uppercase tracking-wider',
                    isToday ? 'text-blue-600 dark:text-blue-400'
                    : wknd  ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground/60',
                  )}>
                    {format(date, 'EE', { locale: de })}
                  </div>
                  <div className={cn(
                    'text-sm font-bold mt-0.5',
                    isToday ? 'text-blue-800 dark:text-blue-200'
                    : wknd  ? 'text-amber-700 dark:text-amber-300'
                    : 'text-foreground',
                  )}>
                    {format(date, 'd')}
                  </div>
                  <div className="text-[9px] text-muted-foreground/50">
                    {format(date, 'MMM', { locale: de })}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {emps.length === 0 ? (
            <tr>
              <td colSpan={refDays.length + 1} className="py-10 text-center text-sm text-muted-foreground italic">
                Keine Mitarbeitenden gefunden.
              </td>
            </tr>
          ) : emps.map((emp, ei) => {
            const rowBg = ei % 2 === 0 ? 'bg-background' : 'bg-muted/20';
            return (
              <tr key={emp.id} className={cn('border-t border-border/20', rowBg)}>
                <td className={cn(
                  'sticky left-0 z-10 py-2.5 px-3 font-semibold text-sm whitespace-nowrap border-r-2 border-border/40 text-foreground',
                  rowBg,
                )}>
                  {emp.name}
                </td>
                {refDays.map((refDay) => {
                  const day     = emp.days.find(d => d.date === refDay.date);
                  const wknd    = isWeekendDate(refDay.date);
                  const isToday = isTodayDate(refDay.date);
                  return (
                    <td key={refDay.date} className={cn(
                      'py-2 px-1.5 text-center align-middle border-l border-border/10',
                      isToday && 'bg-blue-50/30 dark:bg-blue-950/15',
                      !isToday && wknd && 'bg-amber-50/20 dark:bg-amber-950/10',
                    )}>
                      {!day || isEmptyDay(day)
                        ? <span className="text-muted-foreground/20 text-xs font-bold">–</span>
                        : <GridCell day={day} />
                      }
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

// ── Employee dropdown ──────────────────────────────────────────────────────────

function EmpDropdown({
  employees, value, onChange,
}: { employees: PublicEmployee[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <div className="relative mb-4">
      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none z-10" />
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value || null)}
        className="w-full h-12 pl-9 pr-9 rounded-xl border border-border bg-background text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 shadow-sm appearance-none cursor-pointer"
      >
        <option value="">Alle Mitarbeiter</option>
        {employees.map(e => (
          <option key={e.id} value={e.id}>{e.name}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/40 pointer-events-none" />
    </div>
  );
}

// ── Manager note ──────────────────────────────────────────────────────────────

function ManagerNoteCard({ note }: { note: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-blue-200 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/20 px-4 py-3 shadow-sm">
      <MessageCircle className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-[10px] font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wide mb-0.5">Hinweis der Leitung</p>
        <p className="text-sm text-blue-800 dark:text-blue-300 leading-snug">{note}</p>
      </div>
    </div>
  );
}

// ── Change history modal ──────────────────────────────────────────────────────

function ChangeHistoryModal({ entries, onClose }: { entries: ChangeHistoryEntry[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-card w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border p-5 max-h-[70vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-bold text-foreground">Änderungs-Verlauf</h2>
          </div>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted/60 text-muted-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div>
          {entries.map((entry, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center mt-1.5">
                <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                {i < entries.length - 1 && <div className="flex-1 w-px bg-border/60 mt-1" />}
              </div>
              <div className={cn('pb-4', i === entries.length - 1 && 'pb-0')}>
                <p className="text-xs text-muted-foreground">{formatRelativeTime(entry.timestamp)}</p>
                <p className="text-sm font-medium text-foreground mt-0.5">{entry.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Swap dialog (placeholder) ─────────────────────────────────────────────────

function SwapRequestDialog({ dayLabel, onClose }: { dayLabel: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-card w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl border border-border p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="text-center space-y-3">
          <div className="h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center mx-auto">
            <ArrowRightLeft className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-base font-bold text-foreground">Schichttausch anfragen</h2>
          <p className="text-sm text-muted-foreground">{dayLabel}</p>
          <div className="rounded-xl bg-muted/50 border border-border px-4 py-3">
            <p className="text-sm text-muted-foreground">Diese Funktion ist in Vorbereitung und wird bald verfügbar sein.</p>
          </div>
          <button onClick={onClose} className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold">Verstanden</button>
        </div>
      </div>
    </div>
  );
}

// ── Wunsch & Hinweis ──────────────────────────────────────────────────────────

const FEEDBACK_REASONS = [
  'Möchte frei haben',
  'Kann nicht arbeiten',
  'Will Schicht tauschen',
  'Komme später',
  'Muss früher gehen',
  'Frage zur Schicht',
  'Sonstiges',
] as const;

type FeedbackReason = typeof FEEDBACK_REASONS[number];

function SelectField({
  label, value, onChange, children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wide mb-1.5 block">{label}</label>
      <div className="relative">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full h-11 pl-3 pr-9 rounded-xl border border-border bg-background text-sm font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 appearance-none cursor-pointer"
        >
          {children}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/40 pointer-events-none" />
      </div>
    </div>
  );
}

function WunschHinweisSection({
  employees = [],
  scheduleToken = '',
}: {
  employees?: PublicEmployee[];
  scheduleToken?: string;
}) {
  const [open, setOpen]           = useState(false);
  const [selectedName, setSelectedName] = useState('');
  const [selectedDay, setSelectedDay]   = useState('');
  const [selectedReason, setSelectedReason] = useState<FeedbackReason | ''>('');
  const [message, setMessage]     = useState('');
  const [sending, setSending]     = useState(false);
  const [sent, setSent]           = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Derive the list of days from the first employee's schedule (all emps share the same dates)
  const days = employees[0]?.days ?? [];

  const needsName    = employees.length > 0;
  const isSonstiges  = selectedReason === 'Sonstiges';
  const canSend      =
    (!needsName || selectedName !== '') &&
    selectedReason !== '' &&
    (!isSonstiges || message.trim().length > 0);

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    try {
      const now = Date.now();
      const key = `staff-feedback:${scheduleToken}:${now}`;
      const value = {
        id:            key,
        scheduleToken,
        employeeName:  selectedName || 'Anonym',
        date:          selectedDay || 'Allgemein',
        reason:        selectedReason,
        message:       message.trim(),
        createdAt:     new Date(now).toISOString(),
        status:        'new',
      };
      console.log('[FEEDBACK] key:', key);
      console.log('[FEEDBACK] payload:', JSON.stringify(value));
      const { data, error } = await supabase.from('app_settings').upsert(
        { key, value },
        { onConflict: 'key' },
      );
      console.log('[FEEDBACK] response data:', data);
      console.log('[FEEDBACK] response error:', JSON.stringify(error));
      if (error) {
        console.error('[FEEDBACK] code:', error.code, '| message:', error.message, '| details:', error.details);
        throw error;
      }
      setSent(true);
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: string };
      const msg = [e.code, e.message, e.details].filter(Boolean).join(' · ');
      console.error('[FEEDBACK] caught:', msg);
      setSendError(`Fehler: ${msg || 'Unbekannter Fehler — Supabase RLS prüfen'}`);
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20 px-4 py-3 flex items-center gap-2.5 shadow-sm">
        <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">Danke, deine Rückmeldung wurde gesendet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3.5 text-left">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="text-sm font-semibold text-foreground">Wunsch oder Hinweis senden</span>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground/60" /> : <ChevronDown className="h-4 w-4 text-muted-foreground/60" />}
      </button>

      {open && (
        <div className="border-t border-border/40 px-4 pb-4 pt-3 space-y-3">

          {/* 1. Name */}
          {needsName && (
            <SelectField label="Dein Name" value={selectedName} onChange={setSelectedName}>
              <option value="">Bitte auswählen…</option>
              {employees.map(e => (
                <option key={e.id} value={e.name}>{e.name}</option>
              ))}
            </SelectField>
          )}

          {/* 2. Betroffener Tag */}
          <SelectField label="Betroffener Tag" value={selectedDay} onChange={setSelectedDay}>
            <option value="">Allgemein / ganze Woche</option>
            {days.map(d => (
              <option key={d.date} value={d.date}>{d.dayLabel}</option>
            ))}
          </SelectField>

          {/* 3. Grund */}
          <SelectField label="Grund" value={selectedReason} onChange={v => setSelectedReason(v as FeedbackReason | '')}>
            <option value="">Bitte auswählen…</option>
            {FEEDBACK_REASONS.map(r => (
              <option key={r} value={r}>{r}</option>
            ))}
          </SelectField>

          {/* 4. Nachricht */}
          <div>
            <label className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wide mb-1.5 block">
              Nachricht
              {!isSonstiges && <span className="normal-case font-normal ml-1">(optional)</span>}
            </label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={
                isSonstiges
                  ? 'Bitte beschreibe dein Anliegen…'
                  : 'Zusätzliche Infos (optional)…'
              }
              rows={3}
              className="w-full rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/35"
            />
          </div>

          {sendError && (
            <p className="text-xs text-red-600 dark:text-red-400">{sendError}</p>
          )}

          <button
            onClick={handleSend}
            disabled={!canSend || sending}
            className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {sending
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird gesendet…</>
              : <><Send className="h-3.5 w-3.5" />Absenden</>
            }
          </button>
        </div>
      )}
    </div>
  );
}

// ── Next-shift card (personal focus mode) ─────────────────────────────────────

function NextShiftCard({ employee }: { employee: PublicEmployee }) {
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const now      = Date.now();

  const upcoming = useMemo(() => {
    return employee.days.find(d => {
      if (d.date < todayStr) return false;
      return !!d.früh || !!d.spät;
    });
  }, [employee.days, todayStr]);

  if (!upcoming) return null;

  const date    = parseISO(upcoming.date);
  const isToday = upcoming.date === todayStr;
  const shift   = upcoming.früh ?? upcoming.spät;

  // Countdown only if today and shift hasn't started yet
  let countdown: string | null = null;
  if (isToday && shift) {
    const [h, m]    = shift.start.split(':').map(Number);
    const shiftMs   = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m).getTime();
    const diffMs    = shiftMs - now;
    if (diffMs > 0) {
      const diffH = Math.floor(diffMs / 3600000);
      const diffM = Math.floor((diffMs % 3600000) / 60000);
      countdown = diffH >= 1 ? `In ${diffH} Std. ${diffM > 0 ? diffM + ' Min.' : ''}`.trim() : `In ${diffM} Min.`;
    }
  }

  const dayLabel = isToday
    ? 'Heute'
    : format(date, 'EEEE', { locale: de });

  return (
    <div className="rounded-2xl bg-gradient-to-br from-emerald-50 via-emerald-50/80 to-white dark:from-emerald-950/30 dark:via-emerald-950/20 dark:to-transparent border border-emerald-200 dark:border-emerald-800 px-5 py-4 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700/70 dark:text-emerald-400/70 mb-3">
        {isToday ? 'Deine heutige Schicht' : 'Deine nächste Schicht'}
      </p>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-2xl font-bold text-foreground leading-none">{dayLabel}</p>
          <p className="text-sm text-muted-foreground mt-0.5">{format(date, 'd. MMMM', { locale: de })}</p>
          {shift && (
            <div className="flex items-center gap-2 mt-3">
              <Clock className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {shift.start} – {shift.end}
              </span>
            </div>
          )}
          {/* Pausenhinweis — nur Mitarbeiteransicht */}
          <BreakHint frühCode={upcoming.frühCode} spätCode={upcoming.spätCode} />
        </div>
        {countdown && (
          <div className="text-right shrink-0 pb-0.5">
            <div className="flex items-center gap-1 justify-end mb-0.5">
              <Zap className="h-3 w-3 text-emerald-500" />
              <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 font-semibold uppercase tracking-wide">Beginn</p>
            </div>
            <p className="text-base font-bold text-emerald-700 dark:text-emerald-300 tabular-nums">{countdown}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Personal View
// ══════════════════════════════════════════════════════════════════════════════

type PersonalViewMode = 'list' | 'calendar';
type FeedbackState    = 'none' | 'seen' | 'confirmed' | 'cannot' | 'question';

function PersonalView({
  payload, settings, scheduleToken,
}: {
  payload: PublishedSchedulePayload;
  settings: StaffPortalSettings;
  scheduleToken: string;
}) {
  const employee = payload.employees?.[0];
  const [viewMode, setViewMode]         = useState<PersonalViewMode>('list');
  const [showHistory, setShowHistory]   = useState(false);
  const [swapDay, setSwapDay]           = useState<string | null>(null);
  const [feedback, setFeedback]         = useState<FeedbackState>('none');
  const [cannotReason, setCannotReason] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [feedbackSent, setFeedbackSent] = useState(false);
  const today = useMemo(() => new Date(), []);

  if (!employee) {
    return <div className="text-center py-12 text-muted-foreground">Keine Daten für diesen Mitarbeiter.</div>;
  }

  const com = settings.communication;
  const vis = settings.visibility;
  const historyEntries: ChangeHistoryEntry[] = payload.changeHistory ?? [];
  const changedDayCount = employee.days.filter(d => d.changed).length;

  const handleFeedbackSend = () => {
    setFeedbackSent(true);
  };

  return (
    <div className="space-y-3">
      {/* Next shift card */}
      <NextShiftCard employee={employee} />

      {/* Changed notice */}
      {payload.status === 'changed' && (() => {
        const allEmps       = payload.employees ?? [];
        const affectedEmps  = allEmps.filter(e => e.days.some(d => d.changed));
        const totalDays     = allEmps.reduce((n, e) => n + e.days.filter(d => d.changed).length, 0);
        const myChangedDays = employee.days.filter(d => d.changed).length;
        return (
          <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-3 shadow-sm">
            <RefreshCw className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Plan wurde aktualisiert</p>
              {affectedEmps.length > 0 && totalDays > 0 ? (
                <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">
                  {affectedEmps.length} {affectedEmps.length === 1 ? 'Mitarbeiter' : 'Mitarbeitende'} betroffen
                  {' · '}
                  {totalDays} {totalDays === 1 ? 'Tag' : 'Tage'} geändert
                  {myChangedDays > 0 && ` · ${myChangedDays} davon dein${myChangedDays === 1 ? 'er' : 'e'}`}
                </p>
              ) : (
                <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-0.5">Bitte prüfe deine aktualisierten Schichten.</p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Manager note */}
      {payload.managerNote && <ManagerNoteCard note={payload.managerNote} />}

      {/* View toggle + history */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-0.5 bg-muted/40 rounded-xl p-1">
          <Button size="sm" variant={viewMode === 'list' ? 'default' : 'ghost'} className="h-8 gap-1.5 text-xs px-3 rounded-lg" onClick={() => setViewMode('list')}>
            <LayoutList className="h-3.5 w-3.5" />Liste
          </Button>
          <Button size="sm" variant={viewMode === 'calendar' ? 'default' : 'ghost'} className="h-8 gap-1.5 text-xs px-3 rounded-lg" onClick={() => setViewMode('calendar')}>
            <Calendar className="h-3.5 w-3.5" />Kalender
          </Button>
        </div>
        {historyEntries.length > 0 && (
          <button
            onClick={() => setShowHistory(true)}
            className="h-8 px-2.5 rounded-lg border border-border text-xs flex items-center gap-1.5 hover:bg-muted/60 transition-colors text-muted-foreground"
          >
            <History className="h-3 w-3" />
            Änderungen
            {changedDayCount > 0 && (
              <span className="h-4 w-4 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                {changedDayCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* List view */}
      {viewMode === 'list' && (
        <div className="space-y-2.5">
          {employee.days.filter(d => vis.showFreeDays || !isEmptyDay(d)).map((day) => {
            const wknd       = isWeekendDate(day.date);
            const isToday    = isSameDay(parseISO(day.date), today);
            const empty      = isEmptyDay(day);
            const date       = parseISO(day.date);
            const rawChange  = !!day.changed;
            const hasChange  = rawChange && com.showChangeHighlights;
            const hasPrev    = !!(day.previousFrüh || day.previousSpät);
            return (
              <div key={day.date} className={cn(
                'rounded-2xl border px-4 py-4 shadow-sm transition-colors',
                isToday   ? 'bg-blue-50/80 border-blue-300 dark:bg-blue-950/30 dark:border-blue-700'
                : hasChange ? 'bg-amber-50/50 border-amber-300 dark:bg-amber-950/20 dark:border-amber-700'
                : wknd    ? 'bg-amber-50/40 border-amber-200 dark:bg-amber-950/10 dark:border-amber-800'
                : 'bg-card border-border/50',
                empty && !isToday && !hasChange && 'opacity-40',
              )}>
                {/* Day header */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-baseline gap-2">
                    <span className={cn(
                      'text-[10px] font-bold uppercase tracking-widest',
                      isToday   ? 'text-blue-600 dark:text-blue-400'
                      : hasChange ? 'text-amber-600 dark:text-amber-400'
                      : wknd    ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground/50',
                    )}>
                      {format(date, 'EE', { locale: de })}
                    </span>
                    <span className={cn(
                      'text-base font-semibold',
                      isToday   ? 'text-blue-800 dark:text-blue-200'
                      : hasChange ? 'text-amber-800 dark:text-amber-200'
                      : wknd    ? 'text-amber-800 dark:text-amber-200'
                      : 'text-foreground',
                    )}>
                      {format(date, 'd. MMMM', { locale: de })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isToday && (
                      <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-700 rounded-full px-2 py-0.5 uppercase tracking-wide">
                        Heute
                      </span>
                    )}
                    {hasChange && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950/60 dark:text-amber-400 dark:border-amber-600">
                        {day.changeType === 'new' ? 'Neu' : 'Geändert'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Previous times (strikethrough) — only if change highlights enabled */}
                {hasChange && hasPrev && com.showChangeHighlights && (
                  <div className="mb-2 flex flex-col gap-0.5">
                    {day.previousFrüh && (
                      <span className="text-xs text-muted-foreground/40 tabular-nums line-through">
                        {day.previousFrüh.start}–{day.previousFrüh.end}
                      </span>
                    )}
                    {day.previousSpät && (
                      <span className="text-xs text-muted-foreground/40 tabular-nums line-through">
                        {day.previousSpät.start}–{day.previousSpät.end}
                      </span>
                    )}
                  </div>
                )}

                <DayContent day={day} showHours={vis.showHours} />

                {/* Pausenhinweis — nur Mitarbeiteransicht, kein Einfluss auf Berechnungen */}
                {!empty && (day.frühCode || day.spätCode) && (
                  <BreakHint frühCode={day.frühCode} spätCode={day.spätCode} />
                )}

                {!empty && (
                  <div className="mt-3 pt-2.5 border-t border-border/20">
                    <button
                      onClick={() => setSwapDay(day.date)}
                      className="text-[11px] text-muted-foreground/35 flex items-center gap-1 hover:text-muted-foreground/60 transition-colors"
                    >
                      <ArrowRightLeft className="h-3 w-3" />
                      Tausch anfragen
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Calendar view */}
      {viewMode === 'calendar' && (
        <CalendarView employee={employee} payload={payload} />
      )}

      {/* Rückmeldung — shown only when any feedback option is enabled */}
      {(com.enableSeenStatus || com.requireConfirmation || com.allowQuestions) && (
        <div className="rounded-2xl border border-border bg-card px-4 py-4 space-y-3 shadow-sm">
          <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-wide">Rückmeldung</p>
          {feedbackSent ? (
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 py-1">
              <Check className="h-4 w-4" />
              <span className="text-sm font-medium">Danke für deine Rückmeldung!</span>
            </div>
          ) : (
            <>
              <div className={cn('grid gap-2', (com.enableSeenStatus && com.requireConfirmation) || com.allowQuestions ? 'grid-cols-2' : 'grid-cols-1')}>
                {com.enableSeenStatus && (
                  <button
                    onClick={() => setFeedback(f => (f === 'seen' || f === 'confirmed') ? 'none' : 'seen')}
                    className={cn(
                      'h-10 rounded-xl text-sm font-semibold border transition-all flex items-center justify-center gap-1.5',
                      (feedback === 'seen' || feedback === 'confirmed')
                        ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
                        : 'border-border bg-background hover:bg-muted/50 text-foreground',
                    )}
                  >
                    {(feedback === 'seen' || feedback === 'confirmed') && <Check className="h-3.5 w-3.5" />}
                    Gesehen
                  </button>
                )}
                {com.requireConfirmation && (
                  <button
                    onClick={() => { setFeedback('confirmed'); handleFeedbackSend(); }}
                    className={cn(
                      'h-10 rounded-xl text-sm font-semibold border transition-all flex items-center justify-center gap-1.5',
                      feedback === 'confirmed'
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'border-border bg-background hover:bg-muted/50 text-foreground',
                    )}
                  >
                    {feedback === 'confirmed' && <Check className="h-3.5 w-3.5" />}
                    Bestätigt
                  </button>
                )}
                <button
                  onClick={() => setFeedback(f => f === 'cannot' ? 'none' : 'cannot')}
                  className={cn(
                    'h-10 rounded-xl text-sm font-semibold border transition-all',
                    feedback === 'cannot'
                      ? 'bg-red-50 border-red-300 text-red-700 dark:bg-red-950/30 dark:border-red-700 dark:text-red-400'
                      : 'border-border bg-background hover:bg-muted/50 text-foreground',
                  )}
                >
                  Kann nicht
                </button>
                {com.allowQuestions && (
                  <button
                    onClick={() => setFeedback(f => f === 'question' ? 'none' : 'question')}
                    className={cn(
                      'h-10 rounded-xl text-sm font-semibold border transition-all',
                      feedback === 'question'
                        ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/30 dark:border-blue-700 dark:text-blue-400'
                        : 'border-border bg-background hover:bg-muted/50 text-foreground',
                    )}
                  >
                    Rückfrage
                  </button>
                )}
              </div>
              {feedback === 'cannot' && (
                <div className="space-y-2">
                  <textarea
                    value={cannotReason}
                    onChange={e => setCannotReason(e.target.value)}
                    placeholder="Grund (optional) …"
                    rows={3}
                    className="w-full rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button onClick={handleFeedbackSend} className="w-full h-9 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5">
                    <Send className="h-3.5 w-3.5" />Senden
                  </button>
                </div>
              )}
              {com.allowQuestions && feedback === 'question' && (
                <div className="space-y-2">
                  <textarea
                    value={questionText}
                    onChange={e => setQuestionText(e.target.value)}
                    placeholder="Deine Frage an die Leitung …"
                    rows={3}
                    className="w-full rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <button
                    onClick={handleFeedbackSend}
                    disabled={!questionText.trim()}
                    className="w-full h-9 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
                  >
                    <Send className="h-3.5 w-3.5" />Senden
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Wunsch & Hinweis */}
      {com.allowRequests && (
        <WunschHinweisSection
          employees={employee ? [employee] : []}
          scheduleToken={scheduleToken}
        />
      )}

      {/* Modals */}
      {showHistory && <ChangeHistoryModal entries={historyEntries} onClose={() => setShowHistory(false)} />}
      {swapDay && (
        <SwapRequestDialog
          dayLabel={employee.days.find(d => d.date === swapDay)?.dayLabel ?? swapDay}
          onClose={() => setSwapDay(null)}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Employee accordion
// ══════════════════════════════════════════════════════════════════════════════

function EmployeeAccordion({ emp }: { emp: PublicEmployee }) {
  const [open, setOpen] = useState(true);
  const workDays = emp.days.filter(d => !isEmptyDay(d)).length;

  return (
    <div className="rounded-2xl border border-border/60 bg-card overflow-hidden shadow-sm">
      <button className="w-full flex items-center justify-between px-4 py-3.5 text-left" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center shrink-0">
            <User className="h-4 w-4 text-muted-foreground/60" />
          </div>
          <span className="text-sm font-semibold text-foreground">{emp.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground/60">{workDays} Tage</span>
          {open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground/50" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground/50" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/30 divide-y divide-border/20">
          {emp.days.map((day) => {
            const wknd    = isWeekendDate(day.date);
            const isToday = isTodayDate(day.date);
            const empty   = isEmptyDay(day);
            const date    = parseISO(day.date);
            return (
              <div key={day.date} className={cn(
                'flex items-start justify-between gap-3 px-4 py-2.5',
                isToday && 'bg-blue-50/60 dark:bg-blue-950/20',
                !isToday && wknd && 'bg-amber-50/30 dark:bg-amber-950/10',
                empty && !isToday && 'opacity-35',
              )}>
                <div className="flex items-baseline gap-2 shrink-0 min-w-[90px]">
                  <span className={cn(
                    'text-[10px] font-bold uppercase tracking-widest',
                    isToday ? 'text-blue-600 dark:text-blue-400'
                    : wknd  ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground/50',
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
// Department View — 3 tabs: Mitarbeiter | Nach Tag | Woche
// ══════════════════════════════════════════════════════════════════════════════

type DeptViewMode = 'byEmployee' | 'byDay' | 'week';

function DepartmentView({
  payload, activeTab, onTabChange, settings, scheduleToken,
}: {
  payload: PublishedSchedulePayload;
  activeTab: DeptViewMode;
  onTabChange: (t: DeptViewMode) => void;
  settings: StaffPortalSettings;
  scheduleToken: string;
}) {
  const vis = settings.visibility;
  const [selectedEmpId, setSelectedEmpId] = useState<string | null>(null);

  const allEmployees = payload.employees ?? [];
  const showService  = payload.department === 'all' || payload.department === 'service';
  const showKüche    = payload.department === 'all' || payload.department === 'küche';
  const refDays      = allEmployees[0]?.days ?? [];

  // When a specific employee is selected, restrict all views to that person only
  const displayEmps = useMemo(() =>
    selectedEmpId ? allEmployees.filter(e => e.id === selectedEmpId) : allEmployees,
  [allEmployees, selectedEmpId]);

  const displayService = useMemo(() => displayEmps.filter(e => e.department === 'service'), [displayEmps]);
  const displayKüche   = useMemo(() => displayEmps.filter(e => e.department === 'küche'),   [displayEmps]);

  // By-day view — shows entries for the currently selected employee(s)
  const ByDayView = useCallback(() => (
    <div className="space-y-3">
      {refDays.map((refDay, idx) => {
        const date       = parseISO(refDay.date);
        const wknd       = isWeekendDate(refDay.date);
        const isToday    = isTodayDate(refDay.date);
        const activeEmps = displayEmps.filter(emp => {
          const d = emp.days[idx];
          return d && !isEmptyDay(d);
        });
        return (
          <div key={refDay.date} className={cn(
            'rounded-2xl border px-4 py-4 shadow-sm',
            isToday ? 'bg-blue-50/80 border-blue-300 dark:bg-blue-950/30 dark:border-blue-700'
            : wknd  ? 'bg-amber-50/40 border-amber-200 dark:bg-amber-950/10 dark:border-amber-800'
            : 'bg-card border-border/50',
          )}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-baseline gap-2">
                <span className={cn(
                  'text-[10px] font-bold uppercase tracking-widest',
                  isToday ? 'text-blue-600 dark:text-blue-400'
                  : wknd  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground/50',
                )}>
                  {format(date, 'EE', { locale: de })}
                </span>
                <span className={cn(
                  'text-base font-semibold',
                  isToday ? 'text-blue-800 dark:text-blue-200'
                  : wknd  ? 'text-amber-800 dark:text-amber-200'
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
                      {!selectedEmpId && (
                        <span className="text-sm font-medium truncate pt-0.5">{emp.name}</span>
                      )}
                      <div className="shrink-0"><DayContent day={d} compact /></div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  ), [refDays, displayEmps, selectedEmpId]);

  function DeptSection({ emps, label, dotColor }: { emps: PublicEmployee[]; label: string; dotColor: string }) {
    if (emps.length === 0) return null;
    return (
      <div className="mb-5">
        {vis.showDepartments && !selectedEmpId && (
          <div className="flex items-center gap-2 mb-3">
            <span className={cn('w-2 h-2 rounded-full shrink-0', dotColor)} />
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground/60">{label}</span>
          </div>
        )}
        <div className="space-y-3">
          {emps.map(emp => <EmployeeAccordion key={emp.id} emp={emp} />)}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Employee dropdown — always visible so staff can filter to themselves */}
      <EmpDropdown employees={allEmployees} value={selectedEmpId} onChange={setSelectedEmpId} />

      {/* Mitarbeiter view */}
      {activeTab === 'byEmployee' && (
        <>
          {showService && <DeptSection emps={displayService} label="Service" dotColor="bg-blue-500" />}
          {showKüche   && <DeptSection emps={displayKüche}   label="Küche"   dotColor="bg-orange-500" />}
          {!showService && !showKüche && (
            <div className="space-y-3">
              {displayEmps.map(emp => <EmployeeAccordion key={emp.id} emp={emp} />)}
            </div>
          )}
        </>
      )}

      {/* Nach Tag view */}
      {activeTab === 'byDay' && <ByDayView />}

      {/* Woche view */}
      {activeTab === 'week' && (
        <>
          {showService && displayService.length > 0 && (
            <div className="mb-5">
              {vis.showDepartments && !selectedEmpId && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground/60">Service</span>
                </div>
              )}
              <WeekGridView emps={displayService} refDays={refDays} />
            </div>
          )}
          {showKüche && displayKüche.length > 0 && (
            <div className="mb-5">
              {vis.showDepartments && !selectedEmpId && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground/60">Küche</span>
                </div>
              )}
              <WeekGridView emps={displayKüche} refDays={refDays} />
            </div>
          )}
          {!showService && !showKüche && <WeekGridView emps={displayEmps} refDays={refDays} />}
        </>
      )}

      {/* Feedback / Wunsch-Hinweis — always at bottom of dept view */}
      <div className="mt-4">
        <WunschHinweisSection employees={allEmployees} scheduleToken={scheduleToken} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Legend
// ══════════════════════════════════════════════════════════════════════════════

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/40 bg-muted/20 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/50 w-full sm:w-auto">Legende</p>
      {[
        { cls: 'bg-emerald-50 text-emerald-800 border border-emerald-200', label: 'Schicht', icon: <Clock className="h-2.5 w-2.5" />, text: '10:00–18:00' },
      ].map(({ cls, label, icon, text }) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold', cls)}>
            {icon}{text}
          </span>
          <span className="text-[11px] text-muted-foreground/60">{label}</span>
        </div>
      ))}
      {[
        { cls: 'bg-blue-100 text-blue-700 border border-blue-200', text: 'Ferien', label: 'Ferien' },
        { cls: 'bg-red-100 text-red-700 border border-red-200', text: 'Krank', label: 'Krank' },
        { cls: 'bg-slate-100 text-slate-500 border border-slate-200', text: 'Frei', label: 'Frei' },
      ].map(({ cls, text, label }) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-lg text-[11px] font-semibold', cls)}>{text}</span>
          <span className="text-[11px] text-muted-foreground/60">{label}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground/20 text-xs font-bold">–</span>
        <span className="text-[11px] text-muted-foreground/60">Kein Dienst</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════════

const StaffSchedulePage = () => {
  const { token } = useParams<{ token: string }>();

  const [payload, setPayload]   = useState<PublishedSchedulePayload | null>(null);
  const [loading, setLoading]   = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);
  const [deptTab, setDeptTab]   = useState<DeptViewMode>('byEmployee');

  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmed, setConfirmed]       = useState(false);
  const [homescreenDismissed, setHomescreenDismissed] = useState(() => {
    try { return !!localStorage.getItem(`hs-hint-${token ?? ''}`); } catch { return false; }
  });

  const fetchPayload = useCallback(async () => {
    if (!token) { setLoading(false); setNotFound(true); return; }
    setLoading(true);
    setNotFound(false);
    const kvKey = `published-schedule:${token}`;
    try {
      const { data, error } = await (supabase as any)
        .from('app_settings')
        .select('key, value')
        .eq('key', kvKey)
        .maybeSingle();
      if (error || !data?.value) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setPayload(data.value as PublishedSchedulePayload);
      setLoading(false);
    } catch (e) {
      console.error('[staff-page] fetch threw:', e);
      setNotFound(true);
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void fetchPayload(); }, [fetchPayload, refetchKey]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary/50" />
          <p className="text-sm text-muted-foreground">Dienstplan wird geladen…</p>
        </div>
      </div>
    );
  }

  if (notFound || !payload) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-5">
          <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center mx-auto">
            <AlertCircle className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-foreground">Link nicht verfügbar</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Dieser Dienstplan-Link konnte nicht geladen werden.<br />
              Der Plan wird möglicherweise gerade veröffentlicht.
            </p>
          </div>
          <Button onClick={() => setRefetchKey(k => k + 1)} className="w-full gap-2">
            <RefreshCw className="h-4 w-4" />Erneut versuchen
          </Button>
        </div>
      </div>
    );
  }

  const isPersonal = payload.type === 'personal';
  const isChanged  = payload.status === 'changed';
  const deptLabel  =
    payload.department === 'service' ? 'Service'
    : payload.department === 'küche' ? 'Küche'
    : 'Alle Abteilungen';

  const relativeTime = formatRelativeTime(payload.publishedAt);

  // Resolved settings — use embedded snapshot, fall back to all-features-on defaults
  const settings = payload.settings ?? DEFAULT_STAFF_PORTAL_SETTINGS;
  const com = settings.communication;
  const vis = settings.visibility;
  const ntf = settings.notifications;

  // Determine which dept tabs are available based on settings
  const availableDeptTabs = ([
    { id: 'byEmployee' as DeptViewMode, always: true },
    { id: 'byDay'      as DeptViewMode, enabled: vis.enableDayView },
    { id: 'week'       as DeptViewMode, enabled: vis.enableWeekView },
  ] as const).filter(t => ('always' in t) || t.enabled);

  const dismissHomescreen = () => {
    setHomescreenDismissed(true);
    try { localStorage.setItem(`hs-hint-${token ?? ''}`, '1'); } catch {}
  };

  return (
    <div className={cn('min-h-screen bg-background', isPersonal && 'pb-24')}>

      {/* ═══ Sticky header (title + week nav + dept tabs) ═════════════════ */}
      <header className="bg-card/95 backdrop-blur-sm border-b border-border/60 sticky top-0 z-20 shadow-sm">
        <div className="max-w-3xl mx-auto">

          {/* Row 1: restaurant · title · badge */}
          <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Building2 className="h-3 w-3 text-primary/80 shrink-0" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-primary/80 leading-none">
                  {payload.restaurant}
                </p>
              </div>
              <h1 className="text-lg font-bold text-foreground leading-tight truncate">
                {isPersonal
                  ? (payload.employeeName ?? 'Dienstplan')
                  : `Dienstplan · ${deptLabel}`}
              </h1>
              <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                <RefreshCw className="h-2.5 w-2.5 text-muted-foreground/40 shrink-0" />
                <span className="text-[10px] text-muted-foreground/50">
                  Aktualisiert {relativeTime}
                  <span className="text-muted-foreground/30"> · </span>
                  {formatAbsoluteTime(payload.publishedAt)}
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {isChanged && ntf.showUpdateBadges ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-700 whitespace-nowrap">
                  Aktualisiert
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground/40 whitespace-nowrap">Nur Ansicht</span>
              )}
              {confirmed && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-700 whitespace-nowrap flex items-center gap-1">
                  <Check className="h-2.5 w-2.5" />Bestätigt
                </span>
              )}
              {isPersonal && !confirmed && (
                <Badge variant="outline" className="text-[10px] font-semibold border-blue-300/50 text-blue-600/70 dark:border-blue-700 dark:text-blue-400 whitespace-nowrap">
                  Persönlich
                </Badge>
              )}
            </div>
          </div>

          {/* Row 2: week nav */}
          <div className="flex items-center justify-center gap-3 px-4 py-1.5 border-t border-border/20">
            <button
              disabled
              title="Kein älterer Dienstplan verfügbar"
              className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground/25 cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground">{payload.weekLabel}</span>
              {payload.kw && payload.period === 'week' && (
                <span className="text-[10px] text-muted-foreground/50 bg-muted/50 px-1.5 py-0.5 rounded-md font-medium">
                  KW {payload.kw}
                </span>
              )}
            </div>
            <button
              disabled
              title="Kein neuerer Dienstplan verfügbar"
              className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground/25 cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Row 3: dept tabs (dept view only, filtered by settings) */}
          {!isPersonal && availableDeptTabs.length > 1 && (
            <div className="flex items-center gap-1 px-4 pb-2.5 pt-1">
              {([
                { id: 'byEmployee' as DeptViewMode, icon: <User className="h-3.5 w-3.5" />, label: 'Mitarbeiter', always: true },
                { id: 'byDay'      as DeptViewMode, icon: <Calendar className="h-3.5 w-3.5" />, label: 'Nach Tag', enabled: vis.enableDayView },
                { id: 'week'       as DeptViewMode, icon: <Grid3x3 className="h-3.5 w-3.5" />, label: 'Woche', enabled: vis.enableWeekView },
              ] as const)
                .filter(t => ('always' in t) || t.enabled)
                .map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setDeptTab(tab.id)}
                    className={cn(
                      'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-semibold transition-all',
                      deptTab === tab.id
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                    )}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </header>

      {/* Homescreen hint — only when admin enabled it */}
      {com.showHomeScreenHint && !homescreenDismissed && (
        <div className="bg-amber-50/90 dark:bg-amber-950/40 border-b border-amber-200/80 dark:border-amber-800 px-4 py-2.5 flex items-center gap-2.5">
          <Home className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-xs text-amber-700 dark:text-amber-300 flex-1 leading-snug">
            Zum Startbildschirm hinzufügen · bei Änderungen erneut über diesen Link öffnen.
          </span>
          <button
            onClick={dismissHomescreen}
            className="h-5 w-5 flex items-center justify-center rounded text-amber-500 hover:text-amber-700 shrink-0"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Content */}
      <main className="max-w-3xl mx-auto px-4 py-5 space-y-4">
        {isPersonal
          ? <PersonalView payload={payload} settings={settings} scheduleToken={token ?? ''} />
          : <DepartmentView payload={payload} activeTab={deptTab} onTabChange={setDeptTab} settings={settings} scheduleToken={token ?? ''} />
        }
        <Legend />

        {/* ── Export / Teilen ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 justify-center pb-2 flex-wrap">
          {/* Native share (iOS/Android) — always shown, falls back to clipboard */}
          <button
            onClick={() => {
              const shareData = {
                title: `Dienstplan · ${payload.weekLabel}`,
                text: `${payload.restaurant} – Dienstplan ${payload.weekLabel}`,
                url: window.location.href,
              };
              if (typeof navigator !== 'undefined' && 'share' in navigator) {
                navigator.share(shareData).catch(() => {});
              } else {
                navigator.clipboard?.writeText(window.location.href).catch(() => {});
              }
            }}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <Share2 className="h-3.5 w-3.5" />Teilen
          </button>

          {/* WhatsApp — always visible */}
          <button
            onClick={() => {
              const url  = window.location.href;
              const text = payload.status === 'changed'
                ? `Der Dienstplan wurde aktualisiert. Bitte prüft den aktuellen Plan hier:\n${url}`
                : `Hier ist der aktuelle Dienstplan:\n${url}`;
              window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
            }}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-xl border border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/20 text-xs font-semibold text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-950/40 transition-colors"
          >
            <MessageCircle className="h-3.5 w-3.5" />WhatsApp
          </button>

          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 h-8 px-3.5 rounded-xl border border-border text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition-colors"
          >
            <Printer className="h-3.5 w-3.5" />Drucken / PDF
          </button>
        </div>

        <p className="text-center text-[10px] text-muted-foreground/30 pb-2">
          {payload.restaurant} · {payload.weekLabel} · Nur Ansicht
        </p>
      </main>

      {/* Sticky bottom bar (personal only) */}
      {isPersonal && (
        <div className="fixed bottom-0 left-0 right-0 bg-card/95 backdrop-blur-sm border-t border-border/60 px-4 z-20 shadow-[0_-2px_20px_rgba(0,0,0,0.06)]"
          style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3 pt-3 pb-1">
            <div className="flex-1 min-w-0">
              {confirmed ? (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">Plan bestätigt</span>
                </div>
              ) : acknowledged ? (
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                  <span className="text-xs font-semibold text-blue-700 dark:text-blue-400">Plan gesehen</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground/60">Hast du deinen Plan gesehen?</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setAcknowledged(a => !a)}
                className={cn(
                  'h-9 px-3.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all border',
                  acknowledged
                    ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
                    : 'bg-background border-border text-foreground hover:bg-muted/50',
                )}
              >
                {acknowledged && <Check className="h-4 w-4" />}
                Gesehen
              </button>
              <button
                onClick={() => { setAcknowledged(true); setConfirmed(c => !c); }}
                className={cn(
                  'h-9 px-3.5 rounded-xl text-sm font-semibold flex items-center gap-1.5 transition-all border',
                  confirmed
                    ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-background border-border text-foreground hover:bg-muted/50',
                )}
              >
                {confirmed && <Check className="h-4 w-4" />}
                Bestätigt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StaffSchedulePage;
