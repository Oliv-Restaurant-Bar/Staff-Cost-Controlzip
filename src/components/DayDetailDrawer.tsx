import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  Clock, AlertTriangle, CheckCircle2, LogIn, LogOut, RefreshCw, Database,
} from 'lucide-react';
import {
  loadActualHourEntriesForDay,
  type HourStampEntry,
} from '@/lib/supabase-db';
import type { DayComparisonEntry } from '@/lib/timesheet-store';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DayDetailDrawerProps {
  open:           boolean;
  onClose:        () => void;
  employeeId:     string;
  employeeName:   string;
  date:           string;         // YYYY-MM-DD
  dayEntry:       DayComparisonEntry | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function fmtDateLong(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAY_DE[d.getDay()]}, ${d.getDate()}. ${MONTH_NAMES_DE[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '–';
  return t.slice(0, 5);
}

/** Konvertiert HH:MM-String in Minuten seit Mitternacht */
function toMinutes(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/** Formatiert Minuten als "Xh Ym" */
function fmtMinutes(m: number): string {
  if (m <= 0) return '–';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h ${String(min).padStart(2, '0')}m`;
}

function fmtHours(h: number | null): string {
  if (h == null) return '–';
  return h.toFixed(1) + ' h';
}

// ─── Tageszusammenfassung berechnen ───────────────────────────────────────────

interface DaySummary {
  workBlocks:    Array<{ from: string; to: string; durationMin: number }>;
  nettoMin:      number;   // Summe aller Arbeitsblöcke
  bruttoMin:     number;   // Letzter Out − Erster In
  pauseMin:      number;   // Pausenzeit zwischen Blöcken
  isIncomplete:  boolean;  // Ungerade Anzahl / fehlendes Gehen
}

function calcSummary(stamps: HourStampEntry[]): DaySummary {
  // Sortiert nach Zeit
  const sorted = [...stamps].sort((a, b) => a.time.localeCompare(b.time));
  const workBlocks: DaySummary['workBlocks'] = [];
  let pauseMin = 0;
  let lastOutMin: number | null = null;
  let openInTime: string | null = null;

  for (const s of sorted) {
    if (s.entry_type === 'in') {
      if (lastOutMin !== null) {
        pauseMin += toMinutes(s.time) - lastOutMin;
      }
      openInTime = s.time;
    } else {
      // 'out'
      if (openInTime) {
        const durationMin = toMinutes(s.time) - toMinutes(openInTime);
        workBlocks.push({ from: openInTime, to: s.time, durationMin: Math.max(0, durationMin) });
        lastOutMin = toMinutes(s.time);
        openInTime = null;
      }
    }
  }

  const nettoMin   = workBlocks.reduce((s, b) => s + b.durationMin, 0);
  const firstIn    = sorted.find(s => s.entry_type === 'in');
  const lastOut    = [...sorted].reverse().find(s => s.entry_type === 'out');
  const bruttoMin  = firstIn && lastOut
    ? toMinutes(lastOut.time) - toMinutes(firstIn.time)
    : nettoMin;

  return {
    workBlocks,
    nettoMin,
    bruttoMin,
    pauseMin:     Math.max(0, pauseMin),
    isIncomplete: openInTime !== null,
  };
}

// ─── Timeline-Zeile ───────────────────────────────────────────────────────────

function TimelineRow({
  stamp,
  prev,
  idx,
}: {
  stamp: HourStampEntry;
  prev:  HourStampEntry | null;
  idx:   number;
}) {
  const isIn    = stamp.entry_type === 'in';
  const durMin  = prev ? toMinutes(stamp.time) - toMinutes(prev.time) : null;
  const durLabel = durMin != null && durMin >= 0 ? fmtMinutes(durMin) : '–';
  const isBreak = isIn && prev?.entry_type === 'out';

  return (
    <tr className={cn(
      'border-b border-border/30 text-sm',
      idx % 2 === 0 ? 'bg-card' : 'bg-muted/20',
    )}>
      <td className="px-4 py-2.5 font-mono font-semibold tabular-nums text-sm">
        {fmtTime(stamp.time)}
      </td>
      <td className="px-3 py-2.5">
        <span className={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold',
          isIn
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
            : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
        )}>
          {isIn ? <LogIn className="h-3 w-3" /> : <LogOut className="h-3 w-3" />}
          {isIn ? 'Kommen' : 'Gehen'}
        </span>
      </td>
      <td className="px-3 py-2.5 tabular-nums text-right">
        {durMin != null && (
          <span className={cn(
            'text-xs',
            isBreak
              ? 'text-blue-500 dark:text-blue-400'   // Pause
              : !isIn
                ? 'text-foreground font-medium'        // Arbeitsdauer
                : 'text-muted-foreground',
          )}>
            {isBreak ? `Pause: ${durLabel}` : durLabel}
          </span>
        )}
      </td>
    </tr>
  );
}

// ─── Zusammenfassungs-Karte ────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 min-w-0">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
      <p className={cn('text-sm font-bold tabular-nums', color ?? 'text-foreground')}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function DayDetailDrawer({
  open, onClose, employeeId, employeeName, date, dayEntry,
}: DayDetailDrawerProps) {
  const [stamps, setStamps]   = useState<HourStampEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [noTable, setNoTable] = useState(false);

  useEffect(() => {
    if (!open || !date) return;
    let cancelled = false;
    setLoading(true);
    setStamps([]);
    setNoTable(false);

    loadActualHourEntriesForDay(employeeId, date)
      .then(data => { if (!cancelled) { setStamps(data); setLoading(false); } })
      .catch(err => {
        if (cancelled) return;
        setLoading(false);
        // Tabelle existiert noch nicht → Migration ausstehend
        if (String(err?.message ?? err).includes('does not exist') ||
            String(err?.code ?? '').includes('42P01')) {
          setNoTable(true);
        }
      });

    return () => { cancelled = true; };
  }, [open, employeeId, date]);

  const sortedStamps = [...stamps].sort((a, b) => a.time.localeCompare(b.time));
  const summary      = calcSummary(stamps);

  // Dienstplan-Info aus dayEntry
  const planH        = dayEntry?.plan_hours ?? null;
  const azbH         = dayEntry?.azb_hours  ?? null;
  const diffH        = azbH != null && planH != null ? azbH - planH : null;

  const hasFrüh = !!(dayEntry?.frueh_start && dayEntry?.frueh_end);
  const hasSpät = !!(dayEntry?.spaet_start && dayEntry?.spaet_end);

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0 gap-0">

        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 bg-card">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">Arbeitszeit Details</span>
          </SheetTitle>
          <div className="mt-0.5">
            <p className="text-sm font-semibold text-foreground">{employeeName}</p>
            <p className="text-xs text-muted-foreground">{fmtDateLong(date)}</p>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto">

          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              <p className="text-sm">Lade Stempelzeiten…</p>
            </div>
          ) : noTable ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4 px-6 text-center">
              <Database className="h-10 w-10 text-muted-foreground/40" />
              <div>
                <p className="text-sm font-medium text-foreground mb-1">Tabelle noch nicht migriert</p>
                <p className="text-xs text-muted-foreground">
                  Bitte die SQL-Migration{' '}
                  <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                    20260528_actual_hour_entries.sql
                  </code>{' '}
                  im Supabase SQL-Editor ausführen.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* ── Warnung bei unvollständigen Stempeln ── */}
              {summary.isIncomplete && (
                <div className="mx-4 mt-4 flex items-start gap-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Unvollständige Zeitbuchung — fehlendes «Gehen»</span>
                </div>
              )}

              {/* ── Stempel-Timeline ── */}
              <div className="px-4 pt-4 pb-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Stempelzeiten
                </p>
              </div>

              {sortedStamps.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <p>Keine Stempelzeiten vorhanden.</p>
                  <p className="text-xs mt-1 text-muted-foreground/70">
                    Beim nächsten Mirus-Import werden die Einzelzeiten gespeichert.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto mx-4 rounded-lg border border-border overflow-hidden mb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 text-left font-semibold">Zeit</th>
                        <th className="px-3 py-2 text-left font-semibold">Typ</th>
                        <th className="px-3 py-2 text-right font-semibold">Dauer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedStamps.map((s, i) => (
                        <TimelineRow
                          key={s.id}
                          stamp={s}
                          prev={i > 0 ? sortedStamps[i - 1] : null}
                          idx={i}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* ── Tageszusammenfassung ── */}
              <div className="px-4 pb-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Tageszusammenfassung
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <SummaryCard
                    label="Bruttozeit"
                    value={summary.bruttoMin > 0 ? fmtMinutes(summary.bruttoMin) : '–'}
                    sub="Erster Kommen → Letzter Gehen"
                  />
                  <SummaryCard
                    label="Pause"
                    value={summary.pauseMin > 0 ? fmtMinutes(summary.pauseMin) : '–'}
                    sub="Zwischen Blöcken"
                  />
                  <SummaryCard
                    label="Nettozeit (AZB)"
                    value={fmtHours(azbH)}
                    sub={summary.nettoMin > 0 ? `Stempel: ${fmtMinutes(summary.nettoMin)}` : undefined}
                    color={azbH != null ? 'text-foreground' : 'text-muted-foreground'}
                  />
                  <SummaryCard
                    label="Dienstplan"
                    value={fmtHours(planH)}
                    color={planH != null ? 'text-foreground' : 'text-muted-foreground'}
                  />
                  <SummaryCard
                    label="Differenz (AZB − Plan)"
                    value={diffH != null
                      ? (diffH > 0 ? '+' : '') + diffH.toFixed(1) + ' h'
                      : '–'}
                    color={diffH == null
                      ? 'text-muted-foreground'
                      : Math.abs(diffH) > 0.5
                        ? diffH < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400'
                        : 'text-emerald-600 dark:text-emerald-400'}
                  />
                  <SummaryCard
                    label="Status"
                    value={summary.isIncomplete ? 'Unvollständig' : stamps.length === 0 ? 'Keine Stempel' : 'OK'}
                    color={summary.isIncomplete
                      ? 'text-amber-600 dark:text-amber-400'
                      : stamps.length === 0
                        ? 'text-muted-foreground'
                        : 'text-emerald-600 dark:text-emerald-400'}
                  />
                </div>
              </div>

              {/* ── Dienstplan-Info ── */}
              {(hasFrüh || hasSpät) && (
                <div className="px-4 pb-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 mt-2">
                    Dienstplan
                  </p>
                  <div className="rounded-lg border border-border bg-card divide-y divide-border/50">
                    {hasFrüh && (
                      <div className="px-3 py-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-medium">Frühschicht</span>
                        <span className="font-mono font-semibold">
                          {fmtTime(dayEntry?.frueh_start)}–{fmtTime(dayEntry?.frueh_end)}
                        </span>
                      </div>
                    )}
                    {hasSpät && (
                      <div className="px-3 py-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-medium">Spätschicht</span>
                        <span className="font-mono font-semibold">
                          {fmtTime(dayEntry?.spaet_start)}–{fmtTime(dayEntry?.spaet_end)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── Arbeitsblöcke (falls mehrere) ── */}
              {summary.workBlocks.length > 1 && (
                <div className="px-4 pb-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Arbeitsblöcke ({summary.workBlocks.length})
                  </p>
                  <div className="rounded-lg border border-border bg-card divide-y divide-border/50">
                    {summary.workBlocks.map((b, i) => (
                      <div key={i} className="px-3 py-2 flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold">
                          {fmtTime(b.from)}–{fmtTime(b.to)}
                        </span>
                        <span className="text-muted-foreground">{fmtMinutes(b.durationMin)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Hinweis ── */}
              <div className="px-4 pb-4 text-[10px] text-muted-foreground/60">
                Quelle: actual_hour_entries · {stamps.length} Stempel gespeichert
                {/* Zukünftig: manuelle Korrekturen, Kommentare, Freigaben, Payroll-Export */}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
