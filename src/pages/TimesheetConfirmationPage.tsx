import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, XCircle, Clock, AlertCircle, ClipboardCheck,
  CalendarDays, User, Loader2, MessageSquare, Pencil, ShieldCheck,
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

interface EmployeeInfo {
  id: string;
  name: string;
  department: string;
  weekly_hours: number;
}

interface FullDayEntry {
  date:            string;
  hours:           number;
  start_time:      string | null;
  end_time:        string | null;
  absence_type:    string | null;
  manually_edited: boolean;
  is_locked:       boolean;
}

interface BalanceInfo {
  vacation_balance_hours:       number | null;
  public_holiday_balance_hours: number | null;
  overtime_balance_hours:       number | null;
  compensation_balance_hours:   number | null;
}

type PageState = 'loading' | 'invalid' | 'expired' | 'already_done' | 'ready' | 'submitting' | 'done';
type Mode = 'confirm' | 'question' | null;

const WEEKDAYS_DE  = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKENDS     = new Set([0, 6]);

const ABSENCE_META: Record<string, { label: string; cls: string }> = {
  vacation: { label: 'Ferien',   cls: 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800' },
  sick:     { label: 'Krank',    cls: 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800' },
  accident: { label: 'Unfall',   cls: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800' },
  holiday:  { label: 'Feiertag', cls: 'text-purple-700 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800' },
  free:     { label: 'Frei',     cls: 'text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700' },
};

const REQ_TYPE_LABEL: Record<string, string> = {
  question:           'Rückfrage',
  correction_request: 'Korrektur',
  general:            'Allgemein',
};

function fmtH(h: number) { return h.toFixed(1) + ' h'; }
function fmtTime(t: string | null) { if (!t) return '–'; return t.length > 5 ? t.slice(0, 5) : t; }
function fmtDateShort(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}
function fmtDatetime(iso: string) {
  return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function sollHoursForMonth(weeklyHours: number, year: number, month: number) {
  return Math.round((weeklyHours / 7) * new Date(year, month, 0).getDate() * 10) / 10;
}

interface DebugInfo {
  method:          'rpc' | 'direct' | 'none';
  employee_id:     string;
  tenant_id:       string;
  year:            number;
  month:           number;
  date_from:       string;
  date_to:         string;
  actual_hours_rows: number;
  emp_found:       boolean;
  rpc_error:       string | null;
  emp_error:       string | null;
  days_error:      string | null;
  bal_error:       string | null;
  raw_conf:        Record<string, unknown> | null;
}

export default function TimesheetConfirmationPage() {
  const { token } = useParams<{ token: string }>();

  const [pageState, setPageState]         = useState<PageState>('loading');
  const [confirmation, setConfirmation]   = useState<TimesheetConfirmation | null>(null);
  const [employee, setEmployee]           = useState<EmployeeInfo | null>(null);
  const [days, setDays]                   = useState<FullDayEntry[]>([]);
  const [balances, setBalances]           = useState<BalanceInfo | null>(null);
  const [requests, setRequests]           = useState<EmployeeRequest[]>([]);
  const [debugInfo, setDebugInfo]         = useState<DebugInfo | null>(null);
  const [showDebug, setShowDebug]         = useState(false);

  const [mode, setMode]                   = useState<Mode>(null);
  const [comment, setComment]             = useState('');
  const [submitError, setSubmitError]     = useState<string | null>(null);
  const [finalStatus, setFinalStatus]     = useState<string | null>(null);
  const [dayRequestDate, setDayRequestDate] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setPageState('invalid'); return; }
    loadPage(token);
  }, [token]);

  async function loadPage(tok: string) {
    setPageState('loading');
    try {
      // ── Step 1: Confirmation via Token ──────────────────────────────────────
      const conf = await getConfirmationByToken(tok);
      console.log('[TIMESHEET-DEBUG] getConfirmationByToken result:', conf);

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

      console.log('[TIMESHEET-DEBUG] Confirmation details:', {
        employee_id: conf.employee_id,
        tenant_id:   conf.tenant_id,
        year:        conf.year,
        month:       conf.month,
        status:      conf.status,
        fromDate,
        toDate,
      });

      const dbg: DebugInfo = {
        method:            'none',
        employee_id:       conf.employee_id,
        tenant_id:         conf.tenant_id,
        year:              conf.year,
        month:             conf.month,
        date_from:         fromDate,
        date_to:           toDate,
        actual_hours_rows: 0,
        emp_found:         false,
        rpc_error:         null,
        emp_error:         null,
        days_error:        null,
        bal_error:         null,
        raw_conf:          conf as unknown as Record<string, unknown>,
      };

      // ── Step 2: Try SECURITY DEFINER RPC (bypasses RLS for public page) ─────
      console.log('[TIMESHEET-DEBUG] Calling RPC get_confirmation_page_data...');
      const { data: rpcData, error: rpcErr } = await (supabase as any)
        .rpc('get_confirmation_page_data', { p_token: tok });

      console.log('[TIMESHEET-DEBUG] RPC result:', { data: rpcData, error: rpcErr });

      if (!rpcErr && rpcData) {
        // ── RPC succeeded ────────────────────────────────────────────────────
        dbg.method = 'rpc';

        const rpcDebug = rpcData._debug ?? {};
        dbg.actual_hours_rows = rpcDebug.days_count ?? (rpcData.days?.length ?? 0);
        dbg.emp_found         = rpcDebug.emp_found ?? !!rpcData.employee;

        if (rpcData.employee) {
          setEmployee(rpcData.employee as EmployeeInfo);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setDays((rpcData.days ?? []).map((d: any) => ({
          date:            d.date,
          hours:           d.hours ?? 0,
          start_time:      d.start_time ?? null,
          end_time:        d.end_time ?? null,
          absence_type:    d.absence_type ?? null,
          manually_edited: d.manually_edited ?? false,
          is_locked:       d.is_locked ?? false,
        })));

        if (rpcData.balances) {
          setBalances(rpcData.balances as BalanceInfo);
        }

        console.log('[TIMESHEET-DEBUG] RPC data loaded:', {
          employee:  rpcData.employee,
          days_count: rpcData.days?.length ?? 0,
          balances:  rpcData.balances,
          _debug:    rpcData._debug,
        });

      } else {
        // ── RPC not available (migration not yet run) — fall back to direct queries ──
        dbg.rpc_error = rpcErr ? `${rpcErr.code}: ${rpcErr.message}` : 'no data returned';
        console.warn('[TIMESHEET-DEBUG] RPC failed, falling back to direct queries. Error:', rpcErr);

        dbg.method = 'direct';

        const [empRes, daysRes, balRes] = await Promise.allSettled([
          supabase
            .from('employees')
            .select('id, name, department, weekly_hours')
            .eq('id', conf.employee_id)
            .maybeSingle(),
          supabase
            .from('actual_hours')
            .select('date, hours, start_time, end_time, absence_type, manually_edited, is_locked')
            .eq('employee_id', conf.employee_id)
            .gte('date', fromDate)
            .lte('date', toDate)
            .order('date'),
          (supabase as any)
            .from('employee_time_balances')
            .select('vacation_balance_hours, public_holiday_balance_hours, overtime_balance_hours, compensation_balance_hours')
            .eq('employee_id', conf.employee_id)
            .eq('year', conf.year)
            .eq('month', conf.month)
            .maybeSingle(),
        ]);

        console.log('[TIMESHEET-DEBUG] Direct query results:', {
          employees: empRes.status === 'fulfilled'
            ? { data: empRes.value.data, error: empRes.value.error }
            : { rejected: empRes.reason },
          actual_hours: daysRes.status === 'fulfilled'
            ? { rows: daysRes.value.data?.length ?? 0, error: daysRes.value.error }
            : { rejected: daysRes.reason },
          time_balances: balRes.status === 'fulfilled'
            ? { data: balRes.value.data, error: balRes.value.error }
            : { rejected: balRes.reason },
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
            date:            d.date,
            hours:           d.hours ?? 0,
            start_time:      d.start_time,
            end_time:        d.end_time,
            absence_type:    d.absence_type,
            manually_edited: d.manually_edited ?? false,
            is_locked:       d.is_locked ?? false,
          })));
        }

        if (balRes.status === 'fulfilled') {
          dbg.bal_error = balRes.value.error ? `${balRes.value.error.code}: ${balRes.value.error.message}` : null;
          if (balRes.value.data) setBalances(balRes.value.data as BalanceInfo);
        }
      }

      // ── Step 3: Requests (public access via token — always direct) ───────────
      const reqRes = await getRequestsForConfirmation(conf.id).catch(() => []);
      setRequests(reqRes);

      setDebugInfo(dbg);
      console.log('[TIMESHEET-DEBUG] Final debug info:', dbg);

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

  const monthLabel  = confirmation ? `${MONTH_NAMES_DE[confirmation.month - 1]} ${confirmation.year}` : '';
  const totalHours  = days.reduce((s, d) => s + (d.hours ?? 0), 0);
  const sollHours   = employee && confirmation
    ? sollHoursForMonth(employee.weekly_hours, confirmation.year, confirmation.month)
    : 0;
  const diff = totalHours - sollHours;

  const absenceCounts: Record<string, number> = {};
  for (const d of days) {
    if (d.absence_type) absenceCounts[d.absence_type] = (absenceCounts[d.absence_type] ?? 0) + 1;
  }
  const hasQuestionOpen = confirmation?.status === 'question_open';

  // ── Loading state ────────────────────────────────────────────────────────────

  if (pageState === 'loading') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Lade Arbeitszeitblatt…</p>
      </div>
    </PublicShell>
  );

  if (pageState === 'invalid') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <AlertCircle className="h-10 w-10 text-red-400" />
        <h2 className="text-lg font-bold">Ungültiger Link</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Dieser Link ist nicht gültig. Bitte wende dich an die Administration.
        </p>
      </div>
    </PublicShell>
  );

  if (pageState === 'expired') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Clock className="h-10 w-10 text-amber-400" />
        <h2 className="text-lg font-bold">Link abgelaufen</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Dieser Link ist abgelaufen. Bitte fordere einen neuen Link bei der Administration an.
        </p>
      </div>
    </PublicShell>
  );

  if (pageState === 'already_done') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        {finalStatus === 'confirmed' ? (
          <>
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <h2 className="text-lg font-bold text-emerald-700 dark:text-emerald-400">Bereits bestätigt</h2>
            <p className="text-sm text-muted-foreground">
              Du hast dein Arbeitszeitblatt für {monthLabel} bereits bestätigt.
              {confirmation?.confirmed_at && (
                <span className="block mt-1 text-xs">
                  am {new Date(confirmation.confirmed_at).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </p>
          </>
        ) : finalStatus === 'finalized' ? (
          <>
            <ShieldCheck className="h-12 w-12 text-emerald-500" />
            <h2 className="text-lg font-bold text-emerald-700 dark:text-emerald-400">Final abgeschlossen</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Dein Arbeitszeitblatt für {monthLabel} wurde von der Verwaltung final abgeschlossen.
            </p>
          </>
        ) : (
          <>
            <XCircle className="h-12 w-12 text-red-400" />
            <h2 className="text-lg font-bold text-red-700 dark:text-red-400">Rückfrage bereits gesendet</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Du hast für dieses Arbeitszeitblatt bereits eine Rückfrage gesendet.
              Die Administration wird sich bei dir melden.
            </p>
          </>
        )}
      </div>
    </PublicShell>
  );

  if (pageState === 'done') return (
    <PublicShell>
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        {finalStatus === 'confirmed' ? (
          <>
            <CheckCircle2 className="h-14 w-14 text-emerald-500" />
            <h2 className="text-xl font-bold">Vielen Dank!</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Dein Arbeitszeitblatt für <strong>{monthLabel}</strong> wurde erfolgreich bestätigt.
            </p>
          </>
        ) : (
          <>
            <MessageSquare className="h-14 w-14 text-amber-500" />
            <h2 className="text-xl font-bold">Rückfrage gesendet</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Deine Rückmeldung für <strong>{monthLabel}</strong> wurde gespeichert.
              Die Administration wird sich bei dir melden.
            </p>
          </>
        )}
      </div>
    </PublicShell>
  );

  // ── Main content (ready / submitting) ─────────────────────────────────────────

  return (
    <PublicShell>
      <div className="space-y-5">

        {/* Rückfrage-offen Banner */}
        {hasQuestionOpen && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
            <MessageSquare className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Du hast eine Rückfrage gesendet. Die Administration wird sich bei dir melden.
              Du kannst jederzeit weitere tagespezifische Rückfragen hinzufügen.
            </span>
          </div>
        )}

        {/* Employee + Monat */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-bold text-base">{employee?.name ?? '–'}</p>
              {employee?.department && <p className="text-xs text-muted-foreground">{employee.department}</p>}
            </div>
          </div>
          <div className="sm:ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="h-4 w-4" />
            <span className="font-medium text-foreground">{monthLabel}</span>
          </div>
        </div>

        {/* Stunden-Übersicht */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-muted/40 rounded-lg p-3 text-center">
            <p className="text-[11px] text-muted-foreground mb-1">Soll-Stunden</p>
            <p className="text-lg font-bold tabular-nums">{sollHours > 0 ? fmtH(sollHours) : '–'}</p>
          </div>
          <div className="bg-muted/40 rounded-lg p-3 text-center">
            <p className="text-[11px] text-muted-foreground mb-1">AZB-Stunden</p>
            <p className="text-lg font-bold tabular-nums">{totalHours > 0 ? fmtH(totalHours) : '–'}</p>
          </div>
          <div className={cn('rounded-lg p-3 text-center', diff >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-red-50 dark:bg-red-950/20')}>
            <p className="text-[11px] text-muted-foreground mb-1">Differenz</p>
            <p className={cn('text-lg font-bold tabular-nums', diff >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
              {totalHours > 0 && sollHours > 0 ? (diff > 0 ? '+' : '') + fmtH(diff) : '–'}
            </p>
          </div>
        </div>

        {/* Salden */}
        {balances && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Salden</h3>
            <div className="grid grid-cols-2 gap-2">
              {([
                { label: 'Ferien',       value: balances.vacation_balance_hours,       cls: 'text-blue-600 dark:text-blue-400' },
                { label: 'Feiertag',     value: balances.public_holiday_balance_hours, cls: 'text-purple-600 dark:text-purple-400' },
                { label: 'Überstunden',  value: balances.overtime_balance_hours,       cls: 'text-emerald-600 dark:text-emerald-400' },
                { label: 'Kompensation', value: balances.compensation_balance_hours,   cls: 'text-teal-600 dark:text-teal-400' },
              ] as { label: string; value: number | null; cls: string }[]).map(b => (
                <div key={b.label} className="bg-muted/30 rounded-lg px-3 py-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{b.label}</span>
                  <span className={cn('text-sm font-semibold tabular-nums', b.cls)}>
                    {b.value != null ? fmtH(b.value) : '–'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Abwesenheits-Zusammenfassung */}
        {Object.keys(absenceCounts).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {Object.entries(absenceCounts).map(([type, n]) => {
              const meta = ABSENCE_META[type];
              if (!meta) return null;
              return (
                <span key={type} className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border', meta.cls)}>
                  {meta.label} <span className="font-bold">{n}×</span>
                </span>
              );
            })}
          </div>
        )}

        {/* Tages-Details */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Tagesdetails — {days.length} Tage erfasst
          </h3>
          {days.length > 0 ? (
            <>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Datum</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground hidden sm:table-cell">Beginn</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground hidden sm:table-cell">Ende</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Abw.</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Std.</th>
                        <th className="px-3 py-2 w-9 text-center text-xs text-muted-foreground" title="Rückfrage zu diesem Tag">
                          <MessageSquare className="h-3 w-3 mx-auto opacity-50" />
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {days.map(day => {
                        const d          = new Date(day.date + 'T00:00:00');
                        const weekday    = WEEKDAYS_DE[d.getDay()];
                        const isWeekend  = WEEKENDS.has(d.getDay());
                        const absenceMeta = ABSENCE_META[day.absence_type ?? ''] ?? null;
                        const hasRequest  = requests.some(r => r.date === day.date);
                        return (
                          <tr key={day.date} className={cn('hover:bg-muted/20 transition-colors', isWeekend && 'bg-muted/10')}>
                            <td className="px-3 py-1.5 text-xs whitespace-nowrap">
                              <span className={cn('mr-1.5 font-medium', isWeekend ? 'text-muted-foreground/50' : 'text-muted-foreground')}>
                                {weekday}
                              </span>
                              <span className={cn(isWeekend && 'text-muted-foreground/60')}>{fmtDateShort(day.date)}</span>
                              {day.manually_edited && (
                                <Pencil className="inline h-2.5 w-2.5 ml-1 text-blue-400" title="Manuell korrigiert" />
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-xs text-muted-foreground hidden sm:table-cell">{fmtTime(day.start_time)}</td>
                            <td className="px-3 py-1.5 text-xs text-muted-foreground hidden sm:table-cell">{fmtTime(day.end_time)}</td>
                            <td className="px-3 py-1.5 text-xs">
                              {absenceMeta && (
                                <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold border', absenceMeta.cls)}>
                                  {absenceMeta.label}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-xs font-medium">
                              {day.absence_type && day.hours === 0 ? '–' : fmtH(day.hours)}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              {hasRequest ? (
                                <span
                                  title="Rückfrage bereits gestellt"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30"
                                >
                                  <MessageSquare className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
                                </span>
                              ) : (
                                <button
                                  onClick={() => setDayRequestDate(day.date)}
                                  title="Rückfrage zu diesem Tag"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/30 hover:text-primary hover:bg-primary/10 transition-colors"
                                >
                                  <MessageSquare className="h-3 w-3" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-muted/40 sticky bottom-0">
                      <tr>
                        <td colSpan={4} className="px-3 py-2 text-xs font-semibold">Total Monatsstunden</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs font-bold">{fmtH(totalHours)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                <MessageSquare className="h-2.5 w-2.5" />
                Klick auf das Symbol bei einem Tag um eine Rückfrage zu stellen.
              </p>
            </>
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 py-6 text-center text-sm text-muted-foreground">
              <Clock className="h-5 w-5 mx-auto mb-1.5 opacity-40" />
              Für diesen Monat sind noch keine Ist-Stunden erfasst.
            </div>
          )}
        </div>

        {/* Eingereichte Rückfragen */}
        {requests.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Deine Rückfragen ({requests.length})
            </h3>
            <div className="space-y-2">
              {requests.map(req => (
                <div
                  key={req.id}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 space-y-1',
                    req.status === 'resolved'
                      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/10'
                      : req.status === 'rejected'
                        ? 'border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-950/10'
                        : 'border-border bg-muted/20',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-semibold text-foreground">
                        {req.date ? fmtDateShort(req.date) : 'Allgemein'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">
                        {REQ_TYPE_LABEL[req.request_type] ?? req.request_type}
                      </span>
                      {req.category && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-border text-muted-foreground capitalize">
                          {req.category}
                        </span>
                      )}
                      {req.requested_hours != null && (
                        <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                          → {req.requested_hours.toFixed(1)} h
                        </span>
                      )}
                      {req.requested_start_time && (
                        <span className="text-[10px] text-blue-600 dark:text-blue-400">
                          {fmtTime(req.requested_start_time)}–{fmtTime(req.requested_end_time)}
                        </span>
                      )}
                    </div>
                    <span className={cn(
                      'text-[10px] font-semibold shrink-0',
                      req.status === 'resolved' ? 'text-emerald-600 dark:text-emerald-400'
                        : req.status === 'rejected' ? 'text-red-600 dark:text-red-400'
                        : 'text-amber-600 dark:text-amber-400',
                    )}>
                      {req.status === 'resolved' ? '✓ Erledigt' : req.status === 'rejected' ? '✗ Abgelehnt' : '◌ Offen'}
                    </span>
                  </div>
                  {req.message && <p className="text-xs text-muted-foreground leading-snug">{req.message}</p>}
                  {req.admin_response && (
                    <div className="text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/20 rounded px-2 py-1.5 border border-emerald-200 dark:border-emerald-800">
                      <span className="font-semibold">Antwort: </span>{req.admin_response}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">{fmtDatetime(req.created_at)}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Aktions-Sektion */}
        {mode === null && confirmation?.status !== 'confirmed' && confirmation?.status !== 'finalized' ? (
          <div className="pt-3 border-t border-border space-y-3">
            {!hasQuestionOpen && (
              <p className="text-sm text-muted-foreground">
                Prüfe deine Arbeitszeiten sorgfältig. Du kannst das Blatt bestätigen oder eine Rückfrage senden.
                Für tagespezifische Rückfragen klicke auf das{' '}
                <MessageSquare className="inline h-3 w-3 text-primary" /> Symbol in der Tabelle.
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => setMode('confirm')}
                className="flex-1 flex items-center justify-center gap-2 h-11 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm transition-colors"
              >
                <CheckCircle2 className="h-4 w-4" />
                Arbeitszeitblatt bestätigen
              </button>
              {!hasQuestionOpen && (
                <button
                  onClick={() => setMode('question')}
                  className="flex-1 flex items-center justify-center gap-2 h-11 rounded-lg border border-border hover:bg-muted text-foreground font-medium text-sm transition-colors"
                >
                  <MessageSquare className="h-4 w-4 text-amber-500" />
                  Rückfrage / nicht korrekt
                </button>
              )}
            </div>
          </div>
        ) : mode !== null ? (
          <div className="pt-3 border-t border-border space-y-3">
            {mode === 'confirm' ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />Arbeitszeitblatt bestätigen
                </div>
                <p className="text-xs text-muted-foreground">
                  Mit deiner Bestätigung erklärst du, dass die aufgeführten Arbeitszeiten korrekt sind.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                  <MessageSquare className="h-4 w-4" />Rückfrage senden
                </div>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="Was stimmt nicht? Bitte beschreibe das Problem kurz…"
                  className="w-full border border-border rounded-lg px-3 py-2.5 text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                  rows={3}
                />
              </>
            )}
            {submitError && <p className="text-xs text-red-600 dark:text-red-400">{submitError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => { setMode(null); setComment(''); setSubmitError(null); }}
                className="flex-1 h-10 rounded-lg border border-border hover:bg-muted text-sm font-medium transition-colors"
              >
                Zurück
              </button>
              <button
                onClick={handleSubmit}
                disabled={pageState === 'submitting'}
                className={cn(
                  'flex-1 h-10 rounded-lg text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 disabled:opacity-60',
                  mode === 'confirm'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-amber-600 hover:bg-amber-700',
                )}
              >
                {pageState === 'submitting' && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === 'confirm' ? 'Jetzt bestätigen' : 'Rückfrage absenden'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Debug Panel */}
      {debugInfo && (
        <div className="mt-6 border border-amber-300 dark:border-amber-700 rounded-lg overflow-hidden text-xs">
          <button
            onClick={() => setShowDebug(p => !p)}
            className="w-full flex items-center justify-between px-3 py-2 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 font-mono font-semibold hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
          >
            <span>🐛 Debug-Info (Arbeitszeitblatt)</span>
            <span className="text-[10px] opacity-60">{showDebug ? '▲ einklappen' : '▼ ausklappen'}</span>
          </button>

          {/* Status-Zeile immer sichtbar */}
          <div className="px-3 py-2 bg-amber-50/50 dark:bg-amber-950/20 border-t border-amber-200 dark:border-amber-800 flex flex-wrap gap-x-4 gap-y-1">
            <span>
              Methode: <strong className={debugInfo.method === 'rpc' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
                {debugInfo.method === 'rpc' ? '✓ RPC (SECURITY DEFINER)' : debugInfo.method === 'direct' ? '⚠ Direct (RLS aktiv!)' : '–'}
              </strong>
            </span>
            <span>actual_hours: <strong className={debugInfo.actual_hours_rows > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>{debugInfo.actual_hours_rows} Zeilen</strong></span>
            <span>Mitarbeiter: <strong className={debugInfo.emp_found ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>{debugInfo.emp_found ? '✓ gefunden' : '✗ nicht gefunden'}</strong></span>
          </div>

          {showDebug && (
            <div className="px-3 py-3 bg-white dark:bg-black/20 border-t border-amber-200 dark:border-amber-800 space-y-2 font-mono">

              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <span className="text-muted-foreground">employee_id:</span>
                <span className="break-all">{debugInfo.employee_id || '—'}</span>

                <span className="text-muted-foreground">tenant_id:</span>
                <span className="break-all">{debugInfo.tenant_id || '—'}</span>

                <span className="text-muted-foreground">year:</span>
                <span>{debugInfo.year}</span>

                <span className="text-muted-foreground">month:</span>
                <span>{debugInfo.month}</span>

                <span className="text-muted-foreground">date_from:</span>
                <span>{debugInfo.date_from}</span>

                <span className="text-muted-foreground">date_to:</span>
                <span>{debugInfo.date_to}</span>

                <span className="text-muted-foreground">actual_hours rows:</span>
                <span className={debugInfo.actual_hours_rows > 0 ? 'text-emerald-700 dark:text-emerald-400 font-bold' : 'text-red-700 dark:text-red-400 font-bold'}>
                  {debugInfo.actual_hours_rows}
                </span>
              </div>

              {(debugInfo.rpc_error || debugInfo.emp_error || debugInfo.days_error || debugInfo.bal_error) && (
                <div className="mt-2 space-y-1">
                  <p className="text-red-600 dark:text-red-400 font-semibold">Fehler:</p>
                  {debugInfo.rpc_error  && <p className="text-red-600 dark:text-red-400 break-all">RPC: {debugInfo.rpc_error}</p>}
                  {debugInfo.emp_error  && <p className="text-red-600 dark:text-red-400 break-all">employees: {debugInfo.emp_error}</p>}
                  {debugInfo.days_error && <p className="text-red-600 dark:text-red-400 break-all">actual_hours: {debugInfo.days_error}</p>}
                  {debugInfo.bal_error  && <p className="text-red-600 dark:text-red-400 break-all">time_balances: {debugInfo.bal_error}</p>}
                </div>
              )}

              {debugInfo.method === 'direct' && !debugInfo.emp_error && !debugInfo.days_error && debugInfo.actual_hours_rows === 0 && (
                <div className="mt-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 px-2 py-1.5 text-red-700 dark:text-red-400">
                  ⚠ RPC fehlt → RLS blockiert anon-Zugriff.<br />
                  <strong>Fix:</strong> Migration <code>20260529_confirmation_page_rpc.sql</code> im Supabase SQL-Editor ausführen.
                </div>
              )}

              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">raw confirmation record</summary>
                <pre className="mt-1 text-[10px] overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                  {JSON.stringify(debugInfo.raw_conf, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
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
    </PublicShell>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-4 py-3 flex items-center gap-2">
        <ClipboardCheck className="h-5 w-5 text-primary" />
        <span className="font-bold text-sm">Arbeitszeitblatt</span>
      </header>
      <main className="flex-1 flex justify-center px-4 py-6">
        <div className="w-full max-w-xl">{children}</div>
      </main>
      <footer className="border-t border-border px-4 py-3 text-center text-[11px] text-muted-foreground">
        Personalkostentracker · Vertraulich
      </footer>
    </div>
  );
}
