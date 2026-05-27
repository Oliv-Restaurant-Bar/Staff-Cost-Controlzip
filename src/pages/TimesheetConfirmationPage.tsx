import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, XCircle, Clock, AlertCircle, ClipboardCheck,
  CalendarDays, User, Loader2,
} from 'lucide-react';
import {
  getConfirmationByToken,
  getActualHoursForMonth,
  confirmTimesheet,
  rejectTimesheet,
  MONTH_NAMES_DE,
  type TimesheetConfirmation,
  type DailyHourEntry,
} from '@/lib/timesheet-store';

interface EmployeeInfo {
  id: string;
  name: string;
  department: string;
  weekly_hours: number;
}

type PageState = 'loading' | 'invalid' | 'expired' | 'already_done' | 'ready' | 'submitting' | 'done';

function sollHoursForMonth(weeklyHours: number, year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.round((weeklyHours / 7) * daysInMonth * 10) / 10;
}

function fmtH(h: number) { return h.toFixed(1) + ' h'; }

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

const WEEKDAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export default function TimesheetConfirmationPage() {
  const { token } = useParams<{ token: string }>();

  const [pageState, setPageState] = useState<PageState>('loading');
  const [confirmation, setConfirmation] = useState<TimesheetConfirmation | null>(null);
  const [employee, setEmployee] = useState<EmployeeInfo | null>(null);
  const [hours, setHours] = useState<{ total: number; days: DailyHourEntry[] }>({ total: 0, days: [] });

  const [mode, setMode] = useState<'confirm' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [finalStatus, setFinalStatus] = useState<'confirmed' | 'rejected' | null>(null);

  useEffect(() => {
    if (!token) { setPageState('invalid'); return; }
    loadPage(token);
  }, [token]);

  async function loadPage(tok: string) {
    setPageState('loading');
    try {
      const conf = await getConfirmationByToken(tok);
      if (!conf) { setPageState('invalid'); return; }
      if (conf.expires_at && new Date(conf.expires_at) < new Date()) {
        setPageState('expired'); return;
      }
      if (conf.status === 'confirmed' || conf.status === 'rejected') {
        setConfirmation(conf);
        setFinalStatus(conf.status as 'confirmed' | 'rejected');
        setPageState('already_done'); return;
      }

      setConfirmation(conf);

      const { data: empData } = await supabase
        .from('employees')
        .select('id, name, department, weekly_hours')
        .eq('id', conf.employee_id)
        .maybeSingle();
      setEmployee((empData as EmployeeInfo | null) ?? null);

      const h = await getActualHoursForMonth(conf.employee_id, conf.year, conf.month);
      setHours(h);

      setPageState('ready');
    } catch (err) {
      console.error('[TIMESHEET PUBLIC]', err);
      setPageState('invalid');
    }
  }

  async function handleSubmit() {
    if (!token || !mode) return;
    if (mode === 'reject' && !comment.trim()) {
      setSubmitError('Bitte gib einen Kommentar ein.');
      return;
    }
    setSubmitError(null);
    setPageState('submitting');
    try {
      if (mode === 'confirm') {
        await confirmTimesheet(token);
        setFinalStatus('confirmed');
      } else {
        await rejectTimesheet(token, comment.trim());
        setFinalStatus('rejected');
      }
      setPageState('done');
    } catch (err) {
      console.error(err);
      setPageState('ready');
      setSubmitError('Es ist ein Fehler aufgetreten. Bitte versuche es nochmals.');
    }
  }

  const monthLabel = confirmation
    ? `${MONTH_NAMES_DE[confirmation.month - 1]} ${confirmation.year}`
    : '';

  const sollHours = employee && confirmation
    ? sollHoursForMonth(employee.weekly_hours, confirmation.year, confirmation.month)
    : 0;
  const diff = hours.total - sollHours;

  if (pageState === 'loading') {
    return (
      <PublicShell>
        <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Lade Arbeitszeitblatt…</p>
        </div>
      </PublicShell>
    );
  }

  if (pageState === 'invalid') {
    return (
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
  }

  if (pageState === 'expired') {
    return (
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
  }

  if (pageState === 'already_done') {
    return (
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
                    am {new Date(confirmation.confirmed_at).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
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
  }

  if (pageState === 'done') {
    return (
      <PublicShell>
        <div className="flex flex-col items-center gap-4 py-12 text-center">
          {finalStatus === 'confirmed' ? (
            <>
              <CheckCircle2 className="h-14 w-14 text-emerald-500" />
              <h2 className="text-xl font-bold">Vielen Dank!</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Dein Arbeitszeitblatt für <strong>{monthLabel}</strong> wurde erfolgreich bestätigt.
                Deine Rückmeldung wurde gespeichert.
              </p>
            </>
          ) : (
            <>
              <XCircle className="h-14 w-14 text-amber-500" />
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
  }

  return (
    <PublicShell>
      <div className="space-y-5">
        {/* Employee + Monat Info */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="font-bold text-base">{employee?.name ?? '–'}</p>
              {employee?.department && (
                <p className="text-xs text-muted-foreground">{employee.department}</p>
              )}
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
            <p className="text-[11px] text-muted-foreground mb-1">Ist-Stunden</p>
            <p className="text-lg font-bold tabular-nums">{hours.total > 0 ? fmtH(hours.total) : '–'}</p>
          </div>
          <div className={cn('rounded-lg p-3 text-center', diff >= 0 ? 'bg-emerald-50 dark:bg-emerald-950/20' : 'bg-red-50 dark:bg-red-950/20')}>
            <p className="text-[11px] text-muted-foreground mb-1">Differenz</p>
            <p className={cn('text-lg font-bold tabular-nums', diff >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
              {hours.total > 0 && sollHours > 0 ? (diff > 0 ? '+' : '') + fmtH(diff) : '–'}
            </p>
          </div>
        </div>

        {/* Tages-Details */}
        {hours.days.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Tagesdetails
            </h3>
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60 backdrop-blur-sm">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Datum</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground hidden sm:table-cell">Beginn</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground hidden sm:table-cell">Ende</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Stunden</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {hours.days.map(day => {
                      const weekday = WEEKDAYS_DE[new Date(day.date + 'T00:00:00').getDay()];
                      return (
                        <tr key={day.date} className="hover:bg-muted/30">
                          <td className="px-3 py-1.5 text-xs">
                            <span className="text-muted-foreground mr-1.5">{weekday}</span>
                            {fmtDate(day.date)}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-muted-foreground hidden sm:table-cell">
                            {day.start_time ?? '–'}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-muted-foreground hidden sm:table-cell">
                            {day.end_time ?? '–'}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-xs font-medium">
                            {fmtH(day.hours)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/40">
                    <tr>
                      <td colSpan={3} className="px-3 py-2 text-xs font-semibold">Total</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs font-bold">{fmtH(hours.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        )}

        {hours.days.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/20 py-6 text-center text-sm text-muted-foreground">
            <Clock className="h-5 w-5 mx-auto mb-1.5 opacity-40" />
            Für diesen Monat sind noch keine Ist-Stunden erfasst.
          </div>
        )}

        {/* Aktions-Sektion */}
        {mode === null ? (
          <div className="pt-2 border-t border-border">
            <p className="text-sm text-muted-foreground mb-3">
              Bitte prüfe deine Arbeitszeiten und bestätige das Arbeitszeitblatt oder sende eine Rückfrage.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => setMode('confirm')}
                className="flex-1 flex items-center justify-center gap-2 h-11 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm transition-colors"
              >
                <CheckCircle2 className="h-4 w-4" />
                Arbeitszeitblatt bestätigen
              </button>
              <button
                onClick={() => setMode('reject')}
                className="flex-1 flex items-center justify-center gap-2 h-11 rounded-lg border border-border hover:bg-muted text-foreground font-medium text-sm transition-colors"
              >
                <XCircle className="h-4 w-4 text-red-500" />
                Rückfrage / nicht korrekt
              </button>
            </div>
          </div>
        ) : (
          <div className="pt-2 border-t border-border space-y-3">
            {mode === 'confirm' ? (
              <>
                <div className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Arbeitszeitblatt bestätigen
                </div>
                <p className="text-xs text-muted-foreground">
                  Mit deiner Bestätigung erklärst du, dass die aufgeführten Arbeitszeiten korrekt sind.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                  <XCircle className="h-4 w-4" />
                  Rückfrage senden
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
            {submitError && (
              <p className="text-xs text-red-600 dark:text-red-400">{submitError}</p>
            )}
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
                    : 'bg-red-600 hover:bg-red-700',
                )}
              >
                {pageState === 'submitting' && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === 'confirm' ? 'Jetzt bestätigen' : 'Rückfrage absenden'}
              </button>
            </div>
          </div>
        )}
      </div>
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
        <div className="w-full max-w-xl">
          {children}
        </div>
      </main>
      <footer className="border-t border-border px-4 py-3 text-center text-[11px] text-muted-foreground">
        Personalkostentracker · Vertraulich
      </footer>
    </div>
  );
}
