import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, XCircle, Clock, AlertCircle, ClipboardCheck,
  CalendarDays, User, Loader2, MessageSquare, Pencil, ShieldCheck, ChevronDown,
} from 'lucide-react';
import {
  getConfirmationByToken,
  confirmTimesheet,
  questionTimesheet,
  createEmployeeRequest,
  getRequestsForConfirmation,
  MONTH_NAMES_DE,
  type TimesheetConfirmation,
  type EmployeeRequest,
} from '@/lib/timesheet-store';
import DayRequestSheet from '@/components/DayRequestSheet';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmployeeInfo {
  id:           string;
  name:         string;
  department:   string;
  weekly_hours: number;
}

interface HourBlock {
  start_time:     string;  // HH:MM
  end_time:       string;  // HH:MM
  duration_hours: number;
}

interface DayData {
  date:            string;
  hours:           number;
  absence_type:    string | null;
  manually_edited: boolean;
  is_locked:       boolean;
  blocks:          HourBlock[];
}

interface BalanceInfo {
  vacation_balance_hours:       number | null;
  public_holiday_balance_hours: number | null;
  overtime_balance_hours:       number | null;
  compensation_balance_hours:   number | null;
}

interface DebugInfo {
  method:          'rpc' | 'direct' | 'none';
  employee_id:     string;
  tenant_id:       string;
  year:            number;
  month:           number;
  date_from:       string;
  date_to:         string;
  actual_hours_rows:   number;
  actual_entries_rows: number;
  emp_found:       boolean;
  rpc_error:       string | null;
  emp_error:       string | null;
  days_error:      string | null;
  bal_error:       string | null;
  raw_conf:        Record<string, unknown> | null;
}

type PageState = 'loading' | 'invalid' | 'expired' | 'already_done' | 'ready' | 'submitting' | 'done';
type Mode = 'confirm' | 'question' | null;

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKENDS    = new Set([0, 6]);

const ABSENCE_META: Record<string, { label: string; bgCls: string; textCls: string; borderCls: string }> = {
  vacation: { label: 'Ferien',   bgCls: 'bg-blue-50 dark:bg-blue-950/30',   textCls: 'text-blue-700 dark:text-blue-400',   borderCls: 'border-blue-200 dark:border-blue-800' },
  sick:     { label: 'Krank',    bgCls: 'bg-amber-50 dark:bg-amber-950/30', textCls: 'text-amber-700 dark:text-amber-400', borderCls: 'border-amber-200 dark:border-amber-800' },
  accident: { label: 'Unfall',   bgCls: 'bg-red-50 dark:bg-red-950/30',     textCls: 'text-red-700 dark:text-red-400',     borderCls: 'border-red-200 dark:border-red-800' },
  holiday:  { label: 'Feiertag', bgCls: 'bg-purple-50 dark:bg-purple-950/30', textCls: 'text-purple-700 dark:text-purple-400', borderCls: 'border-purple-200 dark:border-purple-800' },
  free:     { label: 'Frei',     bgCls: 'bg-slate-50 dark:bg-slate-900/30', textCls: 'text-slate-600 dark:text-slate-400', borderCls: 'border-slate-200 dark:border-slate-700' },
};

const REQ_TYPE_LABEL: Record<string, string> = {
  question:           'Rückfrage',
  correction_request: 'Korrektur',
  general:            'Allgemein',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function timeToMin(t: string): number {
  const parts = t.split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function breakMin(endTime: string, nextStart: string): number {
  return Math.max(0, timeToMin(nextStart) - timeToMin(endTime));
}

function fmtBreak(min: number): string {
  if (min <= 0) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h ${m} min` : `${h}h`;
}

function fmtH(h: number): string { return h.toFixed(1) + ' h'; }

function fmtTime(t: string | null): string {
  if (!t) return '–';
  return t.length > 5 ? t.slice(0, 5) : t;
}

function fmtDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

function fmtDatetime(iso: string): string {
  return new Date(iso).toLocaleString('de-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function sollHoursForMonth(weeklyHours: number, year: number, month: number): number {
  return Math.round((weeklyHours / 7) * new Date(year, month, 0).getDate() * 10) / 10;
}

function isDebugMode(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function AbsenceBadge({ type }: { type: string }) {
  const meta = ABSENCE_META[type];
  if (!meta) return null;
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border',
      meta.bgCls, meta.textCls, meta.borderCls,
    )}>
      {meta.label}
    </span>
  );
}

function DayCard({
  day,
  hasRequest,
  onRequestClick,
}: {
  day:            DayData;
  hasRequest:     boolean;
  onRequestClick: () => void;
}) {
  const d          = new Date(day.date + 'T00:00:00');
  const weekday    = WEEKDAYS_DE[d.getDay()];
  const isWeekend  = WEEKENDS.has(d.getDay());
  const absenceMeta = day.absence_type ? ABSENCE_META[day.absence_type] : null;
  const isAbsenceOnly = !!day.absence_type && day.blocks.length === 0 && day.hours === 0;

  return (
    <div className={cn(
      'rounded-xl border shadow-sm overflow-hidden',
      isWeekend ? 'border-border/50 bg-muted/20' : 'border-border bg-card',
      absenceMeta && !isWeekend ? absenceMeta.bgCls : '',
    )}>
      {/* Card Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn(
            'text-xs font-semibold w-6 shrink-0',
            isWeekend ? 'text-muted-foreground/50' : 'text-muted-foreground',
          )}>
            {weekday}
          </span>
          <span className={cn(
            'font-semibold text-sm',
            isWeekend && 'text-muted-foreground/60',
          )}>
            {fmtDateShort(day.date)}
          </span>
          {day.manually_edited && (
            <Pencil className="h-3 w-3 text-blue-400 shrink-0" title="Manuell korrigiert" />
          )}
        </div>

        <div className="flex items-center gap-2">
          {day.absence_type && <AbsenceBadge type={day.absence_type} />}
          {day.hours > 0 && (
            <span className={cn(
              'font-bold text-sm tabular-nums',
              isWeekend ? 'text-muted-foreground/60' : 'text-foreground',
            )}>
              {fmtH(day.hours)}
            </span>
          )}
        </div>
      </div>

      {/* Blocks (only when not absence-only) */}
      {day.blocks.length > 0 && (
        <div className="px-4 pb-2 space-y-0.5 border-t border-border/30">
          {day.blocks.map((block, i) => {
            const pause = i < day.blocks.length - 1
              ? breakMin(block.end_time, day.blocks[i + 1].start_time)
              : 0;
            return (
              <div key={i}>
                <div className="flex items-center justify-between py-1">
                  <span className="font-mono text-sm text-foreground">
                    {fmtTime(block.start_time)}
                    <span className="text-muted-foreground mx-1">–</span>
                    {fmtTime(block.end_time)}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmtH(block.duration_hours)}
                  </span>
                </div>
                {pause > 0 && (
                  <div className="flex items-center gap-1 pb-0.5 pl-1">
                    <span className="text-muted-foreground/50 text-[10px]">▪</span>
                    <span className="text-[11px] text-muted-foreground">
                      Pause {fmtBreak(pause)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Request button — only for non-weekend, non-absence-only days, or when there's already a request */}
      {(!isAbsenceOnly || hasRequest) && (
        <div className={cn(
          'px-4 pb-3 flex justify-end',
          day.blocks.length > 0 ? 'pt-2 border-t border-border/30' : isAbsenceOnly ? 'pt-0' : 'pt-1',
        )}>
          {hasRequest ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 font-medium">
              <MessageSquare className="h-3 w-3" />
              Rückfrage gesendet
            </span>
          ) : (
            <button
              onClick={onRequestClick}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors rounded px-2 py-1 hover:bg-primary/5"
            >
              <MessageSquare className="h-3 w-3" />
              Rückfrage
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TimesheetConfirmationPage() {
  const { token }  = useParams<{ token: string }>();
  const debugMode  = isDebugMode();

  const [pageState, setPageState]       = useState<PageState>('loading');
  const [confirmation, setConfirmation] = useState<TimesheetConfirmation | null>(null);
  const [employee, setEmployee]         = useState<EmployeeInfo | null>(null);
  const [days, setDays]                 = useState<DayData[]>([]);
  const [balances, setBalances]         = useState<BalanceInfo | null>(null);
  const [requests, setRequests]         = useState<EmployeeRequest[]>([]);
  const [debugInfo, setDebugInfo]       = useState<DebugInfo | null>(null);

  const [mode, setMode]                 = useState<Mode>(null);
  const [comment, setComment]           = useState('');
  const [submitError, setSubmitError]   = useState<string | null>(null);
  const [finalStatus, setFinalStatus]   = useState<string | null>(null);
  const [dayRequestDate, setDayRequestDate] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!token) { setPageState('invalid'); return; }
    loadPage(token);
  }, [token]);

  useEffect(() => {
    if (mode === 'question') textareaRef.current?.focus();
  }, [mode]);

  async function loadPage(tok: string) {
    setPageState('loading');
    try {
      // Step 1: Confirmation via Token
      const conf = await getConfirmationByToken(tok);
      console.log('[TIMESHEET-DEBUG] getConfirmationByToken:', conf);

      if (!conf) { setPageState('invalid'); return; }
      if (conf.expires_at && new Date(conf.expires_at) < new Date()) {
        setPageState('expired'); return;
      }
      if (conf.status === 'confirmed' || conf.status === 'finalized' || conf.status === 'rejected') {
        setConfirmation(conf); setFinalStatus(conf.status); setPageState('already_done'); return;
      }
      setConfirmation(conf);

      const pad      = (n: number) => String(n).padStart(2, '0');
      const fromDate = `${conf.year}-${pad(conf.month)}-01`;
      const lastDay  = new Date(conf.year, conf.month, 0).getDate();
      const toDate   = `${conf.year}-${pad(conf.month)}-${pad(lastDay)}`;

      console.log('[TIMESHEET-DEBUG] Confirmation:', {
        employee_id: conf.employee_id,
        tenant_id:   conf.tenant_id,
        year: conf.year, month: conf.month,
        status: conf.status, fromDate, toDate,
      });

      const dbg: DebugInfo = {
        method: 'none',
        employee_id: conf.employee_id, tenant_id: conf.tenant_id,
        year: conf.year, month: conf.month,
        date_from: fromDate, date_to: toDate,
        actual_hours_rows: 0, actual_entries_rows: 0,
        emp_found: false,
        rpc_error: null, emp_error: null, days_error: null, bal_error: null,
        raw_conf: conf as unknown as Record<string, unknown>,
      };

      // Step 2: Try SECURITY DEFINER RPC (bypasses RLS — needed for public page)
      console.log('[TIMESHEET-DEBUG] Calling RPC get_confirmation_page_data...');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rpcData, error: rpcErr } = await (supabase as any)
        .rpc('get_confirmation_page_data', { p_token: tok });

      console.log('[TIMESHEET-DEBUG] RPC result:', { data: rpcData, error: rpcErr });

      if (!rpcErr && rpcData) {
        dbg.method = 'rpc';
        const rpcDbg = rpcData._debug ?? {};
        dbg.actual_hours_rows   = rpcDbg.days_count    ?? (rpcData.days?.length    ?? 0);
        dbg.actual_entries_rows = rpcDbg.entries_count ?? (rpcData.entries?.length ?? 0);
        dbg.emp_found           = rpcDbg.emp_found     ?? !!rpcData.employee;

        if (rpcData.employee) setEmployee(rpcData.employee as EmployeeInfo);
        if (rpcData.balances) setBalances(rpcData.balances as BalanceInfo);

        // Build blocks map from flat entries array
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const blocksMap = new Map<string, HourBlock[]>();
        for (const e of (rpcData.entries ?? []) as any[]) {
          if (!blocksMap.has(e.date)) blocksMap.set(e.date, []);
          blocksMap.get(e.date)!.push({
            start_time:     e.start_time,
            end_time:       e.end_time,
            duration_hours: e.duration_hours ?? 0,
          });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setDays((rpcData.days ?? []).map((d: any) => ({
          date:            d.date,
          hours:           d.hours ?? 0,
          absence_type:    d.absence_type ?? null,
          manually_edited: d.manually_edited ?? false,
          is_locked:       d.is_locked ?? false,
          blocks:          blocksMap.get(d.date) ?? [],
        })));

        console.log('[TIMESHEET-DEBUG] RPC OK:', {
          employee:       rpcData.employee?.name,
          days_count:     rpcData.days?.length ?? 0,
          entries_count:  rpcData.entries?.length ?? 0,
          balances:       rpcData.balances,
          _debug:         rpcData._debug,
        });

      } else {
        // Fallback: direct queries (will fail silently if RLS blocks anon)
        dbg.rpc_error = rpcErr ? `${rpcErr.code}: ${rpcErr.message}` : 'null data';
        dbg.method = 'direct';
        console.warn('[TIMESHEET-DEBUG] RPC failed → falling back. Error:', rpcErr);

        const [empRes, daysRes, balRes] = await Promise.allSettled([
          supabase.from('employees')
            .select('id, name, department, weekly_hours')
            .eq('id', conf.employee_id).maybeSingle(),
          supabase.from('actual_hours')
            .select('date, hours, absence_type, manually_edited, is_locked')
            .eq('employee_id', conf.employee_id)
            .gte('date', fromDate).lte('date', toDate).order('date'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).from('employee_time_balances')
            .select('vacation_balance_hours, public_holiday_balance_hours, overtime_balance_hours, compensation_balance_hours')
            .eq('employee_id', conf.employee_id)
            .eq('year', conf.year).eq('month', conf.month).maybeSingle(),
        ]);

        console.log('[TIMESHEET-DEBUG] Direct results:', {
          emp:  empRes.status === 'fulfilled'  ? { data: empRes.value.data,  error: empRes.value.error  } : empRes.reason,
          days: daysRes.status === 'fulfilled' ? { rows: daysRes.value.data?.length, error: daysRes.value.error } : daysRes.reason,
          bal:  balRes.status === 'fulfilled'  ? { data: balRes.value.data,  error: balRes.value.error  } : balRes.reason,
        });

        if (empRes.status === 'fulfilled') {
          dbg.emp_error = empRes.value.error ? `${empRes.value.error.code}: ${empRes.value.error.message}` : null;
          dbg.emp_found = !!empRes.value.data;
          if (empRes.value.data) setEmployee(empRes.value.data as EmployeeInfo);
        }
        if (daysRes.status === 'fulfilled') {
          dbg.days_error        = daysRes.value.error ? `${daysRes.value.error.code}: ${daysRes.value.error.message}` : null;
          dbg.actual_hours_rows = daysRes.value.data?.length ?? 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setDays((daysRes.value.data ?? []).map((d: any) => ({
            date: d.date, hours: d.hours ?? 0,
            absence_type: d.absence_type ?? null,
            manually_edited: d.manually_edited ?? false,
            is_locked: d.is_locked ?? false,
            blocks: [],
          })));
        }
        if (balRes.status === 'fulfilled') {
          dbg.bal_error = balRes.value.error ? `${balRes.value.error.code}: ${balRes.value.error.message}` : null;
          if (balRes.value.data) setBalances(balRes.value.data as BalanceInfo);
        }
      }

      // Step 3: Requests
      const reqs = await getRequestsForConfirmation(conf.id).catch(() => []);
      setRequests(reqs);

      setDebugInfo(dbg);
      console.log('[TIMESHEET-DEBUG] Final:', dbg);
      setPageState('ready');
    } catch (err) {
      console.error('[TIMESHEET PUBLIC] loadPage error:', err);
      setPageState('invalid');
    }
  }

  async function reloadRequests() {
    if (!confirmation || !token) return;
    const reqs = await getRequestsForConfirmation(confirmation.id);
    setRequests(reqs);
    if (confirmation.status !== 'question_open') {
      await questionTimesheet(token).catch(() => {});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setConfirmation(prev => prev ? { ...prev, status: 'question_open' as any } : prev);
    }
  }

  async function handleSubmit() {
    if (!token || !mode) return;
    if (mode === 'question' && !comment.trim()) {
      setSubmitError('Bitte gib einen Kommentar ein.'); return;
    }
    setSubmitError(null);
    setPageState('submitting');
    try {
      if (mode === 'confirm') {
        await confirmTimesheet(token);
        setFinalStatus('confirmed');
      } else {
        if (confirmation) {
          await createEmployeeRequest({
            confirmationId: confirmation.id,
            tenantId:       confirmation.tenant_id,
            employeeId:     confirmation.employee_id,
            month:          confirmation.month,
            year:           confirmation.year,
            requestType:    'general',
            message:        comment.trim(),
          });
        }
        await questionTimesheet(token);
        setFinalStatus('question_open');
      }
      setPageState('done');
    } catch (err) {
      console.error(err);
      setPageState('ready');
      setSubmitError('Es ist ein Fehler aufgetreten. Bitte versuche es nochmals.');
    }
  }

  // ── Derived values ───────────────────────────────────────────────────────────
  const monthLabel = confirmation ? `${MONTH_NAMES_DE[confirmation.month - 1]} ${confirmation.year}` : '';
  const totalHours = days.reduce((s, d) => s + (d.hours ?? 0), 0);
  const sollHours  = employee && confirmation
    ? sollHoursForMonth(employee.weekly_hours, confirmation.year, confirmation.month)
    : 0;
  const diff           = totalHours - sollHours;
  const hasQuestionOpen = confirmation?.status === 'question_open';
  const absenceCounts: Record<string, number> = {};
  for (const d of days) {
    if (d.absence_type) absenceCounts[d.absence_type] = (absenceCounts[d.absence_type] ?? 0) + 1;
  }
  const workDays = days.filter(d => !WEEKENDS.has(new Date(d.date + 'T00:00:00').getDay())).length;

  // ── Page states ──────────────────────────────────────────────────────────────

  if (pageState === 'loading') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Lade Arbeitszeitblatt…</p>
      </div>
    </PublicShell>
  );

  if (pageState === 'invalid') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-4 py-16 text-center px-6">
        <AlertCircle className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-bold">Ungültiger Link</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Dieser Link ist nicht gültig. Bitte wende dich an die Administration.
        </p>
      </div>
    </PublicShell>
  );

  if (pageState === 'expired') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-4 py-16 text-center px-6">
        <Clock className="h-12 w-12 text-amber-400" />
        <h2 className="text-lg font-bold">Link abgelaufen</h2>
        <p className="text-sm text-muted-foreground max-w-xs">
          Dieser Link ist abgelaufen. Bitte fordere einen neuen Link bei der Administration an.
        </p>
      </div>
    </PublicShell>
  );

  if (pageState === 'already_done') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-4 py-16 text-center px-6">
        {finalStatus === 'confirmed' ? (
          <>
            <CheckCircle2 className="h-14 w-14 text-emerald-500" />
            <h2 className="text-xl font-bold text-emerald-700 dark:text-emerald-400">Bereits bestätigt</h2>
            <p className="text-sm text-muted-foreground">
              Du hast dein Arbeitszeitblatt für <strong>{monthLabel}</strong> bereits bestätigt.
              {confirmation?.confirmed_at && (
                <span className="block mt-1 text-xs">
                  am {new Date(confirmation.confirmed_at).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </p>
          </>
        ) : finalStatus === 'finalized' ? (
          <>
            <ShieldCheck className="h-14 w-14 text-emerald-500" />
            <h2 className="text-xl font-bold text-emerald-700 dark:text-emerald-400">Final abgeschlossen</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Dein Arbeitszeitblatt für <strong>{monthLabel}</strong> wurde von der Verwaltung abgeschlossen.
            </p>
          </>
        ) : (
          <>
            <XCircle className="h-12 w-12 text-red-400" />
            <h2 className="text-xl font-bold">Rückfrage gesendet</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Du hast eine Rückfrage gesendet. Die Administration meldet sich bei dir.
            </p>
          </>
        )}
      </div>
    </PublicShell>
  );

  if (pageState === 'done') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-4 py-16 text-center px-6">
        {finalStatus === 'confirmed' ? (
          <>
            <CheckCircle2 className="h-16 w-16 text-emerald-500" />
            <h2 className="text-xl font-bold">Vielen Dank!</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Dein Arbeitszeitblatt für <strong>{monthLabel}</strong> wurde erfolgreich bestätigt.
            </p>
          </>
        ) : (
          <>
            <MessageSquare className="h-16 w-16 text-amber-500" />
            <h2 className="text-xl font-bold">Rückfrage gesendet</h2>
            <p className="text-sm text-muted-foreground max-w-xs">
              Deine Rückmeldung für <strong>{monthLabel}</strong> wurde gespeichert.
              Die Administration wird sich bei dir melden.
            </p>
          </>
        )}
      </div>
    </PublicShell>
  );

  // ── Main ready state ─────────────────────────────────────────────────────────

  const isFinalized = confirmation?.status === 'confirmed' || confirmation?.status === 'finalized';

  return (
    <PublicShell stickyBarHeight={mode === 'question' ? 240 : mode === 'confirm' ? 144 : 88}>

      {/* Question-open banner */}
      {hasQuestionOpen && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <MessageSquare className="h-4 w-4 shrink-0 mt-0.5" />
          <span>Du hast eine Rückfrage gesendet. Die Administration meldet sich bei dir.</span>
        </div>
      )}

      {/* Employee + Month Header */}
      <div className="rounded-xl border border-border bg-card shadow-sm px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <User className="h-6 w-6 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-bold text-base leading-tight truncate">
              {employee?.name ?? '–'}
            </p>
            {employee?.department && (
              <p className="text-xs text-muted-foreground truncate">{employee.department}</p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
            <CalendarDays className="h-4 w-4 shrink-0" />
            <span className="font-semibold text-foreground">{monthLabel}</span>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-card border border-border rounded-xl px-3 py-3 text-center shadow-sm">
          <p className="text-[11px] text-muted-foreground mb-1 leading-tight">Soll-Stunden</p>
          <p className="text-lg font-bold tabular-nums leading-tight">
            {sollHours > 0 ? fmtH(sollHours) : '–'}
          </p>
        </div>
        <div className="bg-card border border-border rounded-xl px-3 py-3 text-center shadow-sm">
          <p className="text-[11px] text-muted-foreground mb-1 leading-tight">AZB-Stunden</p>
          <p className="text-lg font-bold tabular-nums leading-tight">
            {totalHours > 0 ? fmtH(totalHours) : '–'}
          </p>
        </div>
        <div className={cn(
          'rounded-xl px-3 py-3 text-center border shadow-sm',
          diff >= 0
            ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
            : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800',
        )}>
          <p className="text-[11px] text-muted-foreground mb-1 leading-tight">Differenz</p>
          <p className={cn(
            'text-lg font-bold tabular-nums leading-tight',
            diff >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
          )}>
            {totalHours > 0 && sollHours > 0 ? (diff > 0 ? '+' : '') + fmtH(diff) : '–'}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-muted-foreground">
          <strong className="text-foreground">{workDays}</strong> Arbeitstage
        </span>
        {Object.entries(absenceCounts).map(([type, n]) => {
          const meta = ABSENCE_META[type];
          if (!meta) return null;
          return (
            <span
              key={type}
              className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border', meta.bgCls, meta.textCls, meta.borderCls)}
            >
              {meta.label} {n}×
            </span>
          );
        })}
      </div>

      {/* Balances */}
      {balances && (
        <div className="grid grid-cols-2 gap-2">
          {([
            { label: 'Ferienrest',    value: balances.vacation_balance_hours,       cls: 'text-blue-600 dark:text-blue-400' },
            { label: 'Feiertag',      value: balances.public_holiday_balance_hours, cls: 'text-purple-600 dark:text-purple-400' },
            { label: 'Überstunden',   value: balances.overtime_balance_hours,       cls: 'text-emerald-600 dark:text-emerald-400' },
            { label: 'Kompensation',  value: balances.compensation_balance_hours,   cls: 'text-teal-600 dark:text-teal-400' },
          ] as { label: string; value: number | null; cls: string }[])
            .filter(b => b.value != null)
            .map(b => (
              <div key={b.label} className="bg-card border border-border rounded-xl px-3 py-2.5 flex items-center justify-between shadow-sm">
                <span className="text-xs text-muted-foreground">{b.label}</span>
                <span className={cn('text-sm font-bold tabular-nums', b.cls)}>
                  {fmtH(b.value!)}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Day Cards */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Tagesdetails · {days.length} Tage
        </h3>

        {days.length > 0 ? (
          <div className="space-y-2">
            {days.map(day => (
              <DayCard
                key={day.date}
                day={day}
                hasRequest={requests.some(r => r.date === day.date)}
                onRequestClick={() => setDayRequestDate(day.date)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-muted/20 py-10 text-center">
            <Clock className="h-6 w-6 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Noch keine Ist-Stunden erfasst.</p>
          </div>
        )}
      </div>

      {/* Requests list */}
      {requests.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Rückfragen ({requests.length})
          </h3>
          <div className="space-y-2">
            {requests.map(req => (
              <div
                key={req.id}
                className={cn(
                  'rounded-xl border px-4 py-3 space-y-1.5 shadow-sm',
                  req.status === 'resolved'
                    ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/30'
                    : req.status === 'rejected'
                      ? 'border-red-200 dark:border-red-800 bg-red-50/30'
                      : 'border-border bg-card',
                )}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">
                      {req.date ? fmtDateShort(req.date) : 'Allgemein'}
                    </span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">
                      {REQ_TYPE_LABEL[req.request_type] ?? req.request_type}
                    </span>
                  </div>
                  <span className={cn(
                    'text-[11px] font-bold shrink-0',
                    req.status === 'resolved' ? 'text-emerald-600 dark:text-emerald-400'
                      : req.status === 'rejected' ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400',
                  )}>
                    {req.status === 'resolved' ? '✓ Erledigt' : req.status === 'rejected' ? '✗ Abgelehnt' : '◌ Offen'}
                  </span>
                </div>
                {req.message && <p className="text-sm text-muted-foreground leading-snug">{req.message}</p>}
                {req.admin_response && (
                  <div className="text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 rounded-lg px-3 py-2 border border-emerald-200 dark:border-emerald-800">
                    <span className="font-semibold">Antwort: </span>{req.admin_response}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground/60">{fmtDatetime(req.created_at)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Debug Panel — only when ?debug=1 */}
      {debugMode && debugInfo && (
        <DebugPanel info={debugInfo} />
      )}

      {/* DayRequestSheet */}
      {dayRequestDate && confirmation && (
        <DayRequestSheet
          open={!!dayRequestDate}
          onClose={() => setDayRequestDate(null)}
          date={dayRequestDate}
          employeeId={confirmation.employee_id}
          confirmationId={confirmation.id}
          tenantId={confirmation.tenant_id}
          year={confirmation.year}
          month={confirmation.month}
          onSubmitted={reloadRequests}
        />
      )}

      {/* Sticky Bottom Action Bar */}
      {!isFinalized && (
        <StickyActionBar
          mode={mode}
          isSubmitting={pageState === 'submitting'}
          hasQuestionOpen={hasQuestionOpen}
          comment={comment}
          onCommentChange={setComment}
          submitError={submitError}
          textareaRef={textareaRef}
          onConfirm={() => setMode('confirm')}
          onQuestion={() => setMode('question')}
          onBack={() => { setMode(null); setComment(''); setSubmitError(null); }}
          onSubmit={handleSubmit}
        />
      )}
    </PublicShell>
  );
}

// ─── Sticky Action Bar ────────────────────────────────────────────────────────

function StickyActionBar({
  mode, isSubmitting, hasQuestionOpen, comment, onCommentChange,
  submitError, textareaRef, onConfirm, onQuestion, onBack, onSubmit,
}: {
  mode:             Mode;
  isSubmitting:     boolean;
  hasQuestionOpen:  boolean;
  comment:          string;
  onCommentChange:  (v: string) => void;
  submitError:      string | null;
  textareaRef:      React.RefObject<HTMLTextAreaElement>;
  onConfirm:        () => void;
  onQuestion:       () => void;
  onBack:           () => void;
  onSubmit:         () => void;
}) {
  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-card border-t border-border shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
      <div className="mx-auto max-w-xl px-4 py-3 space-y-2.5">
        {/* Confirm mode prompt */}
        {mode === 'confirm' && (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-800 dark:text-emerald-300">
              Mit Bestätigung erklärst du, dass deine Arbeitszeiten korrekt erfasst sind.
            </p>
          </div>
        )}

        {/* Question mode: textarea */}
        {mode === 'question' && (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={comment}
              onChange={e => onCommentChange(e.target.value)}
              placeholder="Was stimmt nicht? Bitte beschreibe das Problem kurz…"
              className="w-full border border-border rounded-lg px-3 py-2.5 text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
              rows={3}
            />
            {submitError && <p className="text-xs text-red-600 dark:text-red-400">{submitError}</p>}
          </div>
        )}

        {/* Buttons */}
        {mode === null ? (
          <div className="flex gap-3">
            <button
              onClick={onConfirm}
              className="flex-1 flex items-center justify-center gap-2 h-12 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-semibold text-sm transition-colors shadow-sm"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>Bestätigen</span>
            </button>
            {!hasQuestionOpen && (
              <button
                onClick={onQuestion}
                className="flex-1 flex items-center justify-center gap-2 h-12 rounded-xl border border-border hover:bg-muted active:bg-muted/80 text-foreground font-medium text-sm transition-colors"
              >
                <MessageSquare className="h-4 w-4 text-amber-500 shrink-0" />
                <span>Rückfrage</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={onBack}
              className="h-12 px-5 rounded-xl border border-border hover:bg-muted active:bg-muted/80 text-sm font-medium transition-colors"
            >
              Zurück
            </button>
            <button
              onClick={onSubmit}
              disabled={isSubmitting}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 h-12 rounded-xl text-white text-sm font-semibold transition-colors shadow-sm disabled:opacity-60',
                mode === 'confirm'
                  ? 'bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800'
                  : 'bg-amber-600 hover:bg-amber-700 active:bg-amber-800',
              )}
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'confirm' ? 'Jetzt bestätigen' : 'Rückfrage senden'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Debug Panel ──────────────────────────────────────────────────────────────

function DebugPanel({ info }: { info: DebugInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-700 overflow-hidden text-xs">
      <button
        onClick={() => setOpen(p => !p)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 font-mono font-semibold hover:bg-amber-100 transition-colors"
      >
        <span>🐛 Debug (?debug=1)</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {/* Status row — always visible */}
      <div className="px-4 py-2 bg-amber-50/40 dark:bg-amber-950/10 border-t border-amber-200 dark:border-amber-800 flex flex-wrap gap-x-4 gap-y-1 font-mono">
        <span>Methode: <strong className={info.method === 'rpc' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}>
          {info.method === 'rpc' ? '✓ RPC' : info.method === 'direct' ? '⚠ Direct (RLS!)' : '–'}
        </strong></span>
        <span>actual_hours: <strong className={info.actual_hours_rows > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}>{info.actual_hours_rows}</strong></span>
        <span>entries: <strong className={info.actual_entries_rows > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}>{info.actual_entries_rows}</strong></span>
        <span>emp: <strong className={info.emp_found ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}>{info.emp_found ? '✓' : '✗'}</strong></span>
      </div>

      {open && (
        <div className="px-4 py-3 bg-white dark:bg-black/20 border-t border-amber-200 dark:border-amber-800 space-y-2 font-mono">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {([
              ['employee_id', info.employee_id],
              ['tenant_id',   info.tenant_id],
              ['year',        info.year],
              ['month',       info.month],
              ['date_from',   info.date_from],
              ['date_to',     info.date_to],
            ] as [string, unknown][]).map(([k, v]) => (
              <>
                <span key={k + 'k'} className="text-muted-foreground">{k}:</span>
                <span key={k + 'v'} className="break-all">{String(v)}</span>
              </>
            ))}
          </div>

          {(info.rpc_error || info.emp_error || info.days_error || info.bal_error) && (
            <div className="mt-2 space-y-1 text-red-600 dark:text-red-400">
              <p className="font-semibold">Fehler:</p>
              {info.rpc_error  && <p className="break-all">RPC: {info.rpc_error}</p>}
              {info.emp_error  && <p className="break-all">employees: {info.emp_error}</p>}
              {info.days_error && <p className="break-all">actual_hours: {info.days_error}</p>}
              {info.bal_error  && <p className="break-all">time_balances: {info.bal_error}</p>}
            </div>
          )}

          {info.method === 'direct' && info.actual_hours_rows === 0 && (
            <div className="rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 px-3 py-2 text-red-700 dark:text-red-400">
              ⚠ RPC nicht verfügbar → RLS blockiert anon.<br />
              <strong>Fix:</strong> Migration <code>20260529_confirmation_page_rpc.sql</code> ausführen.
            </div>
          )}

          <details className="mt-1">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">raw confirmation</summary>
            <pre className="mt-1 text-[10px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
              {JSON.stringify(info.raw_conf, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Shell ────────────────────────────────────────────────────────────────────

function PublicShell({ children, stickyBarHeight = 88 }: { children: React.ReactNode; stickyBarHeight?: number }) {
  return (
    <div className="min-h-dvh bg-background flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur-sm px-4 py-3 flex items-center gap-2.5 shadow-sm">
        <ClipboardCheck className="h-5 w-5 text-primary shrink-0" />
        <span className="font-bold text-sm">Arbeitszeitblatt</span>
      </header>

      <main
        className="flex-1 overflow-y-auto px-4 py-5"
        style={{ paddingBottom: stickyBarHeight + 24 }}
      >
        <div className="mx-auto max-w-xl space-y-4">
          {children}
        </div>
      </main>

      <footer className="border-t border-border px-4 py-2.5 text-center text-[11px] text-muted-foreground/60">
        Personalkostentracker · Vertraulich
      </footer>
    </div>
  );
}
