import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  ChevronLeft, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Info,
  Clock, Link, AlertCircle,
} from 'lucide-react';
import {
  loadEmployeeMonthDetail,
  MONTH_NAMES_DE,
  type DayComparisonEntry,
  type TimesheetConfirmation,
  type TimesheetStatus,
} from '@/lib/timesheet-store';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EmployeeDetailProps {
  employeeId:       string;
  employeeName:     string;
  department:       string;
  sollHours:        number;
  dienstplanHours:  number;
  istHours:         number;
  vacationBalance:  number | null;
  holidayBalance:   number | null;
  confirmation:     TimesheetConfirmation | null;
  year:             number;
  month:            number;
  onBack:           () => void;
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const WEEKDAY_LONG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const STATUS_META: Record<TimesheetStatus, { label: string; cls: string }> = {
  open:         { label: 'Offen',         cls: 'text-muted-foreground bg-muted' },
  link_created: { label: 'Link erstellt', cls: 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-950/50' },
  sent:         { label: 'Gesendet',      cls: 'text-purple-700 bg-purple-100 dark:text-purple-300 dark:bg-purple-950/50' },
  confirmed:    { label: 'Bestätigt',     cls: 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/50' },
  rejected:     { label: 'Rückfrage',     cls: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-950/50' },
  expired:      { label: 'Abgelaufen',    cls: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-950/50' },
};

const ABSENCE_META: Record<string, { label: string; cls: string }> = {
  vacation: { label: 'Ferien',   cls: 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-950/60' },
  sick:     { label: 'Krank',    cls: 'text-orange-700 bg-orange-100 dark:text-orange-300 dark:bg-orange-950/60' },
  holiday:  { label: 'Feiertag', cls: 'text-purple-700 bg-purple-100 dark:text-purple-300 dark:bg-purple-950/60' },
  free:     { label: 'Frei',     cls: 'text-slate-600 bg-slate-100 dark:text-slate-400 dark:bg-slate-800' },
};

// ─── Format-Helpers ───────────────────────────────────────────────────────────

function fmtH(h: number | null | undefined, fb = '–'): string {
  if (h == null) return fb;
  return h.toFixed(1) + ' h';
}
function fmtDiff(d: number): string {
  return (d > 0 ? '+' : '') + d.toFixed(1) + ' h';
}
function fmtTime(t: string | null): string {
  if (!t) return '';
  return t.slice(0, 5);
}

/**
 * Prüft ob start/end-Zeiten die gesamte AZB-Stundenanzahl plausibel erklären.
 * Erlaubt ±1.5h Toleranz (Pausen, Rundung).
 * Verhindert Anzeige von Teilblöcken wenn hours = Tages-Total mehrerer Blöcke.
 */
function timesMatchHours(start: string | null, end: string | null, hours: number): boolean {
  if (!start || !end) return false;
  const sp = start.split(':').map(Number);
  const ep = end.split(':').map(Number);
  if (sp.length < 2 || ep.length < 2) return false;
  const durationH = (ep[0] * 60 + ep[1] - (sp[0] * 60 + sp[1])) / 60;
  if (durationH <= 0 || durationH > 16) return false;
  return Math.abs(durationH - hours) <= 1.5;
}
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}
function weekday(iso: string): string {
  return WEEKDAY_LONG[new Date(iso + 'T12:00:00').getDay()];
}
function isWeekend(iso: string): boolean {
  const dw = new Date(iso + 'T12:00:00').getDay();
  return dw === 0 || dw === 6;
}

// ─── Tages-Status ─────────────────────────────────────────────────────────────

type DayStatus = 'ok' | 'warn' | 'only_azb' | 'only_plan' | 'absence' | 'empty';

function getDayStatus(e: DayComparisonEntry): DayStatus {
  if (e.absence_type)                                  return 'absence';
  if (e.plan_hours == null && e.azb_hours == null)     return 'empty';
  if (e.plan_hours != null && e.azb_hours == null)     return 'only_plan';
  if (e.plan_hours == null && e.azb_hours != null)     return 'only_azb';
  if (Math.abs((e.azb_hours ?? 0) - (e.plan_hours ?? 0)) > 0.5) return 'warn';
  return 'ok';
}

const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  ok:        'OK',
  warn:      'Abweichung',
  only_azb:  'AZB ohne Dienstplan',
  only_plan: 'Dienstplan ohne AZB',
  absence:   '–',
  empty:     '–',
};

function DayStatusBadge({ status }: { status: DayStatus }) {
  if (status === 'empty' || status === 'absence') return null;
  const cfg = {
    ok:        'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/50',
    warn:      'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-950/50',
    only_azb:  'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-950/50',
    only_plan: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-950/50',
  }[status];
  return (
    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none', cfg)}>
      {DAY_STATUS_LABEL[status]}
    </span>
  );
}

function rowBg(s: DayStatus): string {
  if (s === 'warn')                       return 'bg-amber-50/50 dark:bg-amber-950/10';
  if (s === 'only_azb' || s === 'only_plan') return 'bg-red-50/40 dark:bg-red-950/10';
  if (s === 'absence')                    return 'bg-blue-50/25 dark:bg-blue-950/10';
  return '';
}

// ─── Dienstplan-Zelle ─────────────────────────────────────────────────────────

function PlanCell({ e }: { e: DayComparisonEntry }) {
  const hasFrüh = !!(e.frueh_start && e.frueh_end);
  const hasSpät = !!(e.spaet_start && e.spaet_end);
  if (!hasFrüh && !hasSpät) return <span className="text-muted-foreground">–</span>;
  return (
    <div className="space-y-0.5 text-[11px]">
      {hasFrüh && <div><span className="font-medium">Früh</span> {fmtTime(e.frueh_start)}–{fmtTime(e.frueh_end)}</div>}
      {hasSpät && <div><span className="font-medium">Spät</span> {fmtTime(e.spaet_start)}–{fmtTime(e.spaet_end)}</div>}
    </div>
  );
}

// ─── Zusammenfassung oben ─────────────────────────────────────────────────────

function SummaryCards({
  sollHours, dienstplanHours, istHours,
  vacationBalance, holidayBalance, confirmation,
}: Pick<EmployeeDetailProps, 'sollHours' | 'dienstplanHours' | 'istHours' | 'vacationBalance' | 'holidayBalance' | 'confirmation'>) {
  const diffSoll      = istHours > 0 && sollHours > 0 ? istHours - sollHours : null;
  const diffDienstplan = istHours > 0 && dienstplanHours > 0 ? istHours - dienstplanHours : null;
  const status        = confirmation?.status ?? 'open';
  const statusM       = STATUS_META[status];

  const cards = [
    { label: 'Soll',              value: fmtH(sollHours || null),              color: 'text-foreground' },
    { label: 'Dienstplan IST',    value: fmtH(dienstplanHours || null),         color: 'text-foreground' },
    { label: 'AZB IST',          value: fmtH(istHours || null),                color: 'text-foreground' },
    {
      label: 'Diff. AZB − Soll',
      value: diffSoll != null ? fmtDiff(diffSoll) : '–',
      color: diffSoll == null ? 'text-muted-foreground' : diffSoll >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
    },
    {
      label: 'Diff. AZB − Dienstplan',
      value: diffDienstplan != null ? fmtDiff(diffDienstplan) : '–',
      color: diffDienstplan == null ? 'text-muted-foreground' : Math.abs(diffDienstplan) > 2 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
    },
    { label: 'Ferien',       value: fmtH(vacationBalance), color: vacationBalance != null ? 'text-blue-600 dark:text-blue-400'   : 'text-muted-foreground' },
    { label: 'Feiertage',    value: fmtH(holidayBalance),  color: holidayBalance  != null ? 'text-purple-600 dark:text-purple-400' : 'text-muted-foreground' },
    {
      label: 'Status AZB',
      value: statusM.label,
      color: statusM.cls.split(' ')[0],
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 px-5 py-3 border-b border-border bg-muted/10">
      {cards.map(c => (
        <div key={c.label} className="bg-card border border-border rounded-lg px-3 py-2 min-w-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide truncate mb-0.5">{c.label}</p>
          <p className={cn('text-sm font-bold tabular-nums truncate', c.color)}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function EmployeeDetailView({
  employeeId, employeeName, department,
  sollHours, dienstplanHours, istHours,
  vacationBalance, holidayBalance, confirmation,
  year, month, onBack,
}: EmployeeDetailProps) {
  const [entries, setEntries] = useState<DayComparisonEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEntries([]);
    loadEmployeeMonthDetail(employeeId, year, month).then(data => {
      if (!cancelled) { setEntries(data); setLoading(false); }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [employeeId, year, month]);

  const warnCount = entries.filter(e => {
    const s = getDayStatus(e);
    return s === 'warn' || s === 'only_azb' || s === 'only_plan';
  }).length;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* Sub-Header */}
      <div className="px-4 py-2.5 border-b border-border bg-card shrink-0 flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />Zurück zur Übersicht
        </button>
        <div className="h-4 w-px bg-border" />
        <div className="min-w-0">
          <span className="text-sm font-semibold">{employeeName}</span>
          {department && <span className="ml-2 text-xs text-muted-foreground">{department}</span>}
          <span className="ml-2 text-xs text-muted-foreground">· {MONTH_NAMES_DE[month - 1]} {year}</span>
        </div>
        {warnCount > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
            {warnCount} Abweichungstag{warnCount !== 1 ? 'e' : ''}
          </span>
        )}
      </div>

      {/* Zusammenfassung */}
      <SummaryCards
        sollHours={sollHours}
        dienstplanHours={dienstplanHours}
        istHours={istHours}
        vacationBalance={vacationBalance}
        holidayBalance={holidayBalance}
        confirmation={confirmation}
      />

      {/* Tages-Tabelle */}
      <div className="flex flex-col flex-1 min-h-0">

        {/* Legende — fixiert, scrollt nicht mit */}
        <div className="shrink-0 flex flex-wrap gap-x-4 gap-y-1 px-5 py-2 text-[10px] text-muted-foreground border-b border-border/50 bg-muted/10">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-200 dark:bg-emerald-900" />OK (Diff ≤ 0.5 h)</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-amber-200 dark:bg-amber-900" />Abweichung (&gt; 0.5 h)</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-red-200 dark:bg-red-900" />Nur eine Seite</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm bg-blue-100 dark:bg-blue-900" />Abwesenheit</span>
          <span className="flex items-center gap-1 ml-auto text-muted-foreground/60">Wochenende = ausgegraut wenn leer</span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground flex-1">
            <RefreshCw className="h-6 w-6 animate-spin" />
            <p className="text-sm">Daten werden geladen…</p>
          </div>
        ) : (
          <TableContent entries={entries} />
        )}
      </div>
    </div>
  );
}

// ─── Tabellen-Inhalt (ausgelagert für Übersichtlichkeit) ──────────────────────

function TableContent({ entries }: { entries: DayComparisonEntry[] }) {

  // ── Totals ──────────────────────────────────────────────────────────────────
  const totalPlanHours = entries.reduce((s, e) => s + (e.plan_hours ?? 0), 0);
  const totalAzbHours  = entries.reduce((s, e) => s + (e.azb_hours  ?? 0), 0);
  const totalDiff      = totalAzbHours - totalPlanHours;

  // Gesamtpause: 30 min pro Tag mit plan_gross > 9h
  const totalPauseMin  = entries.filter(e => e.plan_gross != null && e.plan_gross > 9).length * 30;

  // Abweichungstage: |diff| > 0.5h, kein Leertag, keine Abwesenheit
  const deviationDays  = entries.filter(e => {
    if (!e.plan_hours && !e.azb_hours) return false;
    if (e.absence_type) return false;
    const diff = e.azb_hours != null && e.plan_hours != null
      ? Math.abs(e.azb_hours - e.plan_hours) : 0;
    return diff > 0.5;
  }).length;

  // Vorbereitung für spätere Totals (noch nicht implementiert):
  // const totalNightSurcharge = 0;  // Nachtzuschläge
  // const totalOvertime       = 0;  // Überstunden
  // const totalHolidayHours   = 0;  // Feiertagsstunden
  // const totalVacationHours  = 0;  // Ferienstunden

  return (
    // Einziger Scroll-Container — übernimmt X+Y, damit sticky thead/tfoot funktionieren
    <div className="flex-1 overflow-auto">
      <table className="w-full text-xs border-collapse">

        {/* ── Sticky Header ──────────────────────────────────────────────────── */}
        <thead className="sticky top-0 z-20">
          <tr className="border-b-2 border-border bg-card text-[10px] uppercase tracking-wide text-muted-foreground shadow-sm">
            <th className="px-4 py-2 text-left font-semibold whitespace-nowrap">Datum</th>
            <th className="px-2 py-2 text-left font-semibold">WT</th>
            <th className="px-3 py-2 text-left font-semibold">Dienstplan</th>
            <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Plan (h)</th>
            <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">AZB (h)</th>
            <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Differenz</th>
            <th className="px-3 py-2 text-center font-semibold">Pause</th>
            <th className="px-3 py-2 text-left font-semibold">Typ</th>
            <th className="px-3 py-2 text-left font-semibold">Status</th>
          </tr>
        </thead>

        {/* ── Datenzeilen ────────────────────────────────────────────────────── */}
        <tbody className="divide-y divide-border/40">
          {entries.map(e => {
            const status  = getDayStatus(e);
            const diff    = e.azb_hours != null && e.plan_hours != null
              ? e.azb_hours - e.plan_hours : null;
            const pause   = e.plan_gross != null && e.plan_gross > 9 ? '30 min' : null;
            const absM    = e.absence_type ? ABSENCE_META[e.absence_type] : null;
            const weekend = isWeekend(e.date);
            const wday    = weekday(e.date);

            return (
              <tr key={e.date} className={cn(
                'transition-colors',
                rowBg(status),
                weekend && status === 'empty' && 'opacity-40',
              )}>
                <td className={cn('px-4 py-1.5 font-medium whitespace-nowrap', weekend && 'text-muted-foreground')}>
                  {fmtDate(e.date)}
                </td>
                <td className={cn('px-2 py-1.5 font-medium whitespace-nowrap', weekend ? 'text-muted-foreground' : '')}>
                  {wday}
                </td>
                <td className="px-3 py-1.5">
                  <PlanCell e={e} />
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {e.plan_hours != null
                    ? <span className="font-medium">{fmtH(e.plan_hours)}</span>
                    : <span className="text-muted-foreground">–</span>}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {e.azb_hours != null ? (
                    <div>
                      <div className="font-medium">{fmtH(e.azb_hours)}</div>
                      {timesMatchHours(e.azb_start, e.azb_end, e.azb_hours) && (
                        <div className="text-[10px] text-muted-foreground">
                          {fmtTime(e.azb_start)}–{fmtTime(e.azb_end)}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {diff != null ? (
                    <span className={cn(
                      'font-medium',
                      Math.abs(diff) > 0.5
                        ? (diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400')
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}>
                      {fmtDiff(diff)}
                    </span>
                  ) : <span className="text-muted-foreground">–</span>}
                </td>
                <td className="px-3 py-1.5 text-center text-muted-foreground">
                  {pause ?? '–'}
                </td>
                <td className="px-3 py-1.5">
                  {absM ? (
                    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none', absM.cls)}>
                      {absM.label}
                    </span>
                  ) : <span className="text-muted-foreground">–</span>}
                </td>
                <td className="px-3 py-1.5">
                  <DayStatusBadge status={status} />
                </td>
              </tr>
            );
          })}
        </tbody>

        {/* ── Sticky Total-Zeile ──────────────────────────────────────────────── */}
        {entries.length > 0 && (
          <tfoot className="sticky bottom-0 z-20">
            <tr className="border-t-2 border-border bg-muted/60 backdrop-blur-sm text-xs font-bold">
              <td className="px-4 py-2 uppercase tracking-wide text-[10px] text-muted-foreground whitespace-nowrap" colSpan={3}>
                TOTAL
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {totalPlanHours > 0 ? fmtH(totalPlanHours) : <span className="font-normal text-muted-foreground">–</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {totalAzbHours > 0 ? fmtH(totalAzbHours) : <span className="font-normal text-muted-foreground">–</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {(totalPlanHours > 0 || totalAzbHours > 0) ? (
                  <span className={cn(
                    totalDiff < -0.5 ? 'text-red-600 dark:text-red-400'
                    : totalDiff > 0.5 ? 'text-amber-600 dark:text-amber-400'
                    : 'text-emerald-600 dark:text-emerald-400',
                  )}>
                    {fmtDiff(totalDiff)}
                  </span>
                ) : <span className="font-normal text-muted-foreground">–</span>}
              </td>
              <td className="px-3 py-2 text-center text-muted-foreground font-normal">
                {totalPauseMin > 0 ? `${totalPauseMin} min` : '–'}
              </td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 whitespace-nowrap">
                {deviationDays > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {deviationDays} Abw.
                  </span>
                ) : (
                  <span className="text-emerald-600 dark:text-emerald-400 font-normal">OK</span>
                )}
              </td>
            </tr>
          </tfoot>
        )}

      </table>

      {/* Footer-Notiz */}
      {entries.length > 0 && (
        <div className="px-5 py-3 border-t border-border/50 text-[10px] text-muted-foreground">
          Kommentare, Genehmigungen und PDF-Export folgen in einer nächsten Version.
        </div>
      )}
    </div>
  );
}
