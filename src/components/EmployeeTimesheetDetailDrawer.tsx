import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { resolveBreakHours } from '@/hooks/useShiftConfig';
import { RefreshCw, AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';
import {
  loadEmployeeMonthDetail,
  MONTH_NAMES_DE,
  type DayComparisonEntry,
} from '@/lib/timesheet-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface DetailDrawerEmployee {
  id:           string;
  name:         string;
  department?:  string;
  planHours:    number;
  istHours:     number;
}

interface Props {
  open:          boolean;
  onClose:       () => void;
  employee:      DetailDrawerEmployee | null;
  year:          number;
  month:         number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function fmtDate(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00');
  return `${WEEKDAY_SHORT[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

function fmtH(h: number | null | undefined, fallback = '–'): string {
  if (h == null) return fallback;
  return h.toFixed(1) + ' h';
}

function fmtDiff(diff: number): string {
  return (diff > 0 ? '+' : '') + diff.toFixed(1) + ' h';
}

function fmtTime(t: string | null): string {
  if (!t) return '';
  return t.slice(0, 5);
}

// ─── Abwesenheits-Badge ────────────────────────────────────────────────────────

const ABSENCE_LABEL: Record<string, { label: string; cls: string }> = {
  vacation: { label: 'Ferien',    cls: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300' },
  sick:     { label: 'Krank',     cls: 'bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300' },
  holiday:  { label: 'Feiertag',  cls: 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300' },
  free:     { label: 'Frei',      cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
};

function AbsenceBadge({ type, code }: { type: DayComparisonEntry['absence_type']; code: string | null }) {
  if (!type) return null;
  const m = ABSENCE_LABEL[type];
  const label = m?.label ?? (code ?? type);
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none', m?.cls ?? 'bg-muted text-muted-foreground')}>
      {label}
    </span>
  );
}

// ─── Dienstplan-Zelle ─────────────────────────────────────────────────────────

function PlanCell({ entry }: { entry: DayComparisonEntry }) {
  const hasFrüh  = !!(entry.frueh_start && entry.frueh_end);
  const hasSpät  = !!(entry.spaet_start && entry.spaet_end);
  const hasAbs   = !!entry.absence_type;

  if (!hasFrüh && !hasSpät && !hasAbs) {
    return <span className="text-muted-foreground">–</span>;
  }

  return (
    <div className="space-y-0.5">
      {hasAbs && <AbsenceBadge type={entry.absence_type} code={entry.absence_code} />}
      {hasFrüh && (
        <div className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Früh</span>{' '}
          {fmtTime(entry.frueh_start)}–{fmtTime(entry.frueh_end)}
        </div>
      )}
      {hasSpät && (
        <div className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Spät</span>{' '}
          {fmtTime(entry.spaet_start)}–{fmtTime(entry.spaet_end)}
        </div>
      )}
      {entry.plan_hours != null && (
        <div className="text-[11px] font-semibold tabular-nums">{fmtH(entry.plan_hours)}</div>
      )}
      {(() => {
        // Pause aus zentraler Auflösung (manuelle Tages-Pause hat Vorrang vor Automatik);
        // nur bei geplanter Arbeitszeit — Pause nie auf reine Absenztage
        const pauseMin = entry.plan_gross != null && entry.plan_gross > 0
          ? Math.round(resolveBreakHours(entry.plan_gross, entry.break_minutes) * 60) : 0;
        return pauseMin > 0 ? (
          <div className="text-[10px] text-muted-foreground">{pauseMin} min Pause</div>
        ) : null;
      })()}
    </div>
  );
}

// ─── Status-Icon ──────────────────────────────────────────────────────────────

type DayStatus = 'ok' | 'warn' | 'only_azb' | 'only_plan' | 'absence' | 'empty';

function getDayStatus(entry: DayComparisonEntry): DayStatus {
  if (entry.absence_type)                                return 'absence';
  if (entry.plan_hours == null && entry.azb_hours == null) return 'empty';
  if (entry.plan_hours != null && entry.azb_hours == null) return 'only_plan';
  if (entry.plan_hours == null && entry.azb_hours != null) return 'only_azb';
  const diff = (entry.azb_hours ?? 0) - (entry.plan_hours ?? 0);
  if (Math.abs(diff) > 0.5) return 'warn';
  return 'ok';
}

function StatusIcon({ status }: { status: DayStatus }) {
  if (status === 'ok')       return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (status === 'warn')     return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
  if (status === 'only_azb') return <XCircle className="h-3.5 w-3.5 text-red-500" title="AZB vorhanden, kein Dienstplan" />;
  if (status === 'only_plan') return <XCircle className="h-3.5 w-3.5 text-red-500" title="Dienstplan vorhanden, keine AZB" />;
  if (status === 'absence')  return <Info className="h-3.5 w-3.5 text-blue-400" />;
  return null;
}

function rowBg(status: DayStatus): string {
  if (status === 'warn')      return 'bg-amber-50/60 dark:bg-amber-950/15';
  if (status === 'only_azb' || status === 'only_plan') return 'bg-red-50/50 dark:bg-red-950/15';
  if (status === 'absence')   return 'bg-blue-50/30 dark:bg-blue-950/10';
  return '';
}

// ─── Monatszusammenfassung ────────────────────────────────────────────────────

function MonthSummary({ entries, planTotal, istTotal }: {
  entries:   DayComparisonEntry[];
  planTotal: number;
  istTotal:  number;
}) {
  const diff         = istTotal - planTotal;
  const warnDays     = entries.filter(e => {
    const s = getDayStatus(e);
    return s === 'warn' || s === 'only_azb' || s === 'only_plan';
  }).length;
  const absenceDays  = entries.filter(e => e.absence_type).length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-5 pt-4 pb-3">
      {[
        {
          label: 'Dienstplan IST',
          value: fmtH(planTotal, '– h'),
          color: 'text-foreground',
        },
        {
          label: 'AZB IST',
          value: fmtH(istTotal, '– h'),
          color: 'text-foreground',
        },
        {
          label: 'Gesamtdifferenz',
          value: (planTotal > 0 || istTotal > 0) ? fmtDiff(diff) : '–',
          color: diff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
        },
        {
          label: 'Abweichungstage',
          value: warnDays > 0 ? `${warnDays} Tag${warnDays !== 1 ? 'e' : ''}` : '–',
          color: warnDays > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
        },
      ].map(s => (
        <div key={s.label} className="bg-muted/40 rounded-lg p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{s.label}</p>
          <p className={cn('text-lg font-bold tabular-nums', s.color)}>{s.value}</p>
        </div>
      ))}
      {absenceDays > 0 && (
        <div className="col-span-2 sm:col-span-4 flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400 -mt-1">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {absenceDays} Tag{absenceDays !== 1 ? 'e' : ''} mit Abwesenheits-Eintrag (Ferien/Krank/Feiertag/Frei)
        </div>
      )}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function EmployeeTimesheetDetailDrawer({ open, onClose, employee, year, month }: Props) {
  const [entries, setEntries] = useState<DayComparisonEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !employee) return;
    let cancelled = false;
    setLoading(true);
    setEntries([]);
    loadEmployeeMonthDetail(employee.id, year, month).then(data => {
      if (!cancelled) { setEntries(data); setLoading(false); }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, employee?.id, year, month]);

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0 gap-0">

        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0">
          <SheetTitle className="text-base">
            Arbeitszeitvergleich — {employee?.name ?? '…'} — {MONTH_NAMES_DE[month - 1]} {year}
          </SheetTitle>
          {employee?.department && (
            <p className="text-xs text-muted-foreground">{employee.department}</p>
          )}
        </SheetHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center flex-1 gap-3 text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin" />
            <p className="text-sm">Daten werden geladen…</p>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">

            {/* Monatszusammenfassung */}
            {entries.length > 0 && (
              <MonthSummary
                entries={entries}
                planTotal={employee?.planHours ?? 0}
                istTotal={employee?.istHours ?? 0}
              />
            )}

            {/* Trennlinie */}
            {entries.length > 0 && <div className="border-b border-border mx-5" />}

            {/* Legende */}
            {entries.length > 0 && (
              <div className="flex flex-wrap gap-3 px-5 py-2 text-[10px] text-muted-foreground border-b border-border/50">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" />Differenz ≤ 0.5 h</span>
                <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" />Differenz &gt; 0.5 h</span>
                <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-500" />Nur eine Seite vorhanden</span>
                <span className="flex items-center gap-1"><Info className="h-3 w-3 text-blue-400" />Abwesenheit</span>
              </div>
            )}

            {/* Tages-Tabelle */}
            {entries.length === 0 && !loading ? (
              <div className="py-16 text-center text-muted-foreground text-sm">
                Keine Daten für diesen Monat gefunden
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-4 py-2 text-left font-semibold">Datum</th>
                      <th className="px-3 py-2 text-left font-semibold">Dienstplan</th>
                      <th className="px-3 py-2 text-right font-semibold">AZB</th>
                      <th className="px-3 py-2 text-right font-semibold">Differenz</th>
                      <th className="px-3 py-2 text-center font-semibold w-8">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {entries.map(entry => {
                      const status = getDayStatus(entry);
                      const diff   = entry.azb_hours != null && entry.plan_hours != null
                        ? entry.azb_hours - entry.plan_hours
                        : null;
                      const isWeekend = (() => {
                        const dw = new Date(entry.date + 'T12:00:00').getDay();
                        return dw === 0 || dw === 6;
                      })();

                      return (
                        <tr
                          key={entry.date}
                          className={cn(
                            'transition-colors',
                            rowBg(status),
                            isWeekend && status === 'empty' && 'opacity-40',
                          )}
                        >
                          {/* Datum */}
                          <td className={cn('px-4 py-2 font-medium whitespace-nowrap', isWeekend && 'text-muted-foreground')}>
                            {fmtDate(entry.date)}
                          </td>

                          {/* Dienstplan */}
                          <td className="px-3 py-2">
                            <PlanCell entry={entry} />
                          </td>

                          {/* AZB */}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {entry.azb_hours != null ? (
                              <div>
                                <div className="font-medium">{fmtH(entry.azb_hours)}</div>
                                {(entry.azb_start || entry.azb_end) && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {fmtTime(entry.azb_start)}{entry.azb_start && entry.azb_end ? '–' : ''}{fmtTime(entry.azb_end)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">–</span>
                            )}
                          </td>

                          {/* Differenz */}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {diff != null ? (
                              <span className={cn(
                                'font-medium',
                                Math.abs(diff) > 0.5
                                  ? (diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')
                                  : 'text-emerald-600 dark:text-emerald-400',
                              )}>
                                {fmtDiff(diff)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">–</span>
                            )}
                          </td>

                          {/* Status */}
                          <td className="px-3 py-2 text-center">
                            <StatusIcon status={status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Hinweis: Kommentare / Genehmigung (vorbereitet) */}
            {entries.length > 0 && (
              <div className="px-5 py-3 border-t border-border/50 text-[10px] text-muted-foreground">
                Kommentare, Genehmigungen und PDF-Export folgen in einer nächsten Version.
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
