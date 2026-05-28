import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Clock, AlertTriangle, Database, RefreshCw } from 'lucide-react';
import {
  loadActualHourEntriesForDay,
  type HourBlockEntry,
} from '@/lib/supabase-db';
import type { DayComparisonEntry } from '@/lib/timesheet-store';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DayDetailDrawerProps {
  open:         boolean;
  onClose:      () => void;
  employeeId:   string;
  employeeName: string;
  date:         string;         // YYYY-MM-DD
  dayEntry:     DayComparisonEntry | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WEEKDAY_DE = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];

function fmtDateLong(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAY_DE[d.getDay()]}, ${d.getDate()}. ${MONTH_NAMES_DE[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '–';
  return t.slice(0, 5);
}

/** Konvertiert HH:MM in Minuten seit Mitternacht */
function toMinutes(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/** Minuten → "Xh Ym" */
function fmtMinutes(m: number): string {
  if (m <= 0) return '–';
  const h   = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h ${String(min).padStart(2, '0')}m`;
}

function fmtHours(h: number | null | undefined): string {
  if (h == null) return '–';
  return h.toFixed(1) + ' h';
}

/** Prüft ob Startzeit vor Endzeit liegt (kein Nacht-Überlauf) */
function isValidBlock(b: HourBlockEntry): boolean {
  return toMinutes(b.start_time) < toMinutes(b.end_time);
}

// ─── Pause zwischen zwei Blöcken ─────────────────────────────────────────────

function pauseMinutesBetween(prev: HourBlockEntry, next: HourBlockEntry): number {
  return Math.max(0, toMinutes(next.start_time) - toMinutes(prev.end_time));
}

// ─── Karte ────────────────────────────────────────────────────────────────────

function Card({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 min-w-0">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5 truncate">{label}</p>
      <p className={cn('text-sm font-bold tabular-nums', color ?? 'text-foreground')}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function DayDetailDrawer({
  open, onClose, employeeId, employeeName, date, dayEntry,
}: DayDetailDrawerProps) {
  const [blocks, setBlocks]   = useState<HourBlockEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [noTable, setNoTable] = useState(false);

  useEffect(() => {
    if (!open || !date) return;
    let cancelled = false;
    setLoading(true);
    setBlocks([]);
    setNoTable(false);

    loadActualHourEntriesForDay(employeeId, date)
      .then(data => { if (!cancelled) { setBlocks(data); setLoading(false); } })
      .catch(err => {
        if (cancelled) return;
        setLoading(false);
        const msg = String(err?.message ?? err);
        if (msg.includes('does not exist') || String(err?.code ?? '').includes('42P01')) {
          setNoTable(true);
        }
      });

    return () => { cancelled = true; };
  }, [open, employeeId, date]);

  // ── Berechnungen ──────────────────────────────────────────────────────────
  const validBlocks   = blocks.filter(isValidBlock).sort((a, b) => a.start_time.localeCompare(b.start_time));
  const nettoMin      = validBlocks.reduce((s, b) => s + Math.round(b.duration_hours * 60), 0);
  const pauseSegments = validBlocks.slice(1).map((b, i) => ({
    afterBlock: i,
    minutes:    pauseMinutesBetween(validBlocks[i], b),
  })).filter(p => p.minutes > 0);
  const totalPauseMin = pauseSegments.reduce((s, p) => s + p.minutes, 0);

  // Plan + AZB aus dayEntry
  const planH = dayEntry?.plan_hours ?? null;
  const azbH  = dayEntry?.azb_hours  ?? null;
  const diffH = azbH != null && planH != null ? azbH - planH : null;

  // Dienstplan-Schichten
  const hasFrüh = !!(dayEntry?.frueh_start && dayEntry?.frueh_end);
  const hasSpät = !!(dayEntry?.spaet_start && dayEntry?.spaet_end);

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0 gap-0">

        {/* ── Header ── */}
        <SheetHeader className="px-5 py-4 border-b border-border shrink-0 bg-card">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-primary shrink-0" />
            Arbeitszeit Details
          </SheetTitle>
          <div className="mt-1">
            <p className="text-sm font-semibold text-foreground">{employeeName}</p>
            <p className="text-xs text-muted-foreground">{date ? fmtDateLong(date) : ''}</p>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-auto">

          {/* ── Loading ── */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              <p className="text-sm">Lade Zeitblöcke…</p>
            </div>
          )}

          {/* ── Tabelle nicht migriert ── */}
          {!loading && noTable && (
            <div className="flex flex-col items-center justify-center py-16 gap-4 px-6 text-center">
              <Database className="h-10 w-10 text-muted-foreground/30" />
              <div>
                <p className="text-sm font-medium mb-1">Tabelle noch nicht migriert</p>
                <p className="text-xs text-muted-foreground">
                  Bitte{' '}
                  <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                    20260528_actual_hour_entries.sql
                  </code>{' '}
                  im Supabase SQL-Editor ausführen.
                </p>
              </div>
            </div>
          )}

          {/* ── Inhalt ── */}
          {!loading && !noTable && (
            <>
              {/* ── Dienstplan oben ── */}
              {(hasFrüh || hasSpät || dayEntry?.frueh_absence) && (
                <div className="px-4 pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Dienstplan (Soll)
                  </p>
                  <div className="rounded-lg border border-border bg-card divide-y divide-border/50 mb-4">
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
                    {dayEntry?.frueh_absence && (
                      <div className="px-3 py-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground font-medium">Abwesenheit</span>
                        <span className="font-semibold text-blue-600 dark:text-blue-400">
                          {dayEntry.frueh_absence}
                        </span>
                      </div>
                    )}
                    <div className="px-3 py-2 flex items-center justify-between text-xs bg-muted/20">
                      <span className="text-muted-foreground font-medium">Plan Total</span>
                      <span className="font-semibold">{fmtHours(planH)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── IST Zeitblöcke-Tabelle ── */}
              <div className="px-4 pt-2 pb-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  IST Zeitstempel (Mirus)
                </p>
              </div>

              {validBlocks.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-muted-foreground">Keine Zeitblöcke vorhanden.</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Beim nächsten Mirus-Import werden die Blöcke gespeichert.
                  </p>
                </div>
              ) : (
                <div className="mx-4 mb-4 rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/40 border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 text-left font-semibold w-8">#</th>
                        <th className="px-3 py-2 text-left font-semibold">Start</th>
                        <th className="px-3 py-2 text-left font-semibold">Ende</th>
                        <th className="px-3 py-2 text-right font-semibold">Dauer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validBlocks.map((b, i) => {
                        const blockMin  = Math.round(b.duration_hours * 60);
                        const pauseSeg  = pauseSegments.find(p => p.afterBlock === i);
                        return (
                          <>
                            <tr key={b.id} className={cn(
                              'border-b border-border/30',
                              i % 2 === 0 ? 'bg-card' : 'bg-muted/20',
                            )}>
                              <td className="px-3 py-2.5 text-muted-foreground font-medium">{i + 1}</td>
                              <td className="px-3 py-2.5 font-mono font-semibold tabular-nums">
                                {fmtTime(b.start_time)}
                              </td>
                              <td className="px-3 py-2.5 font-mono font-semibold tabular-nums">
                                {fmtTime(b.end_time)}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                                {fmtMinutes(blockMin)}
                              </td>
                            </tr>
                            {pauseSeg && (
                              <tr key={`pause-${i}`} className="bg-blue-50 dark:bg-blue-950/20 border-b border-border/20">
                                <td colSpan={4} className="px-3 py-1.5 text-[10px] text-blue-600 dark:text-blue-400 text-center font-medium tracking-wide">
                                  Pause: {fmtMinutes(pauseSeg.minutes)}
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
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
                  <Card
                    label="Nettozeit (Blöcke)"
                    value={nettoMin > 0 ? fmtMinutes(nettoMin) : '–'}
                    sub={`${validBlocks.length} Block${validBlocks.length !== 1 ? 'e' : ''}`}
                  />
                  <Card
                    label="Pause (zwischen Blöcken)"
                    value={totalPauseMin > 0 ? fmtMinutes(totalPauseMin) : '–'}
                  />
                  <Card
                    label="AZB Total"
                    value={fmtHours(azbH)}
                    sub="Aus actual_hours"
                    color={azbH != null ? 'text-foreground' : 'text-muted-foreground'}
                  />
                  <Card
                    label="Dienstplan Total"
                    value={fmtHours(planH)}
                    sub="Aus schedule_entries"
                    color={planH != null ? 'text-foreground' : 'text-muted-foreground'}
                  />
                  <Card
                    label="Differenz (AZB − Plan)"
                    value={diffH != null
                      ? (diffH > 0 ? '+' : '') + diffH.toFixed(1) + ' h'
                      : '–'}
                    color={
                      diffH == null       ? 'text-muted-foreground'
                      : Math.abs(diffH) <= 0.5 ? 'text-emerald-600 dark:text-emerald-400'
                      : diffH < 0         ? 'text-red-600 dark:text-red-400'
                                          : 'text-amber-600 dark:text-amber-400'
                    }
                  />
                  <Card
                    label="Status"
                    value={
                      validBlocks.length === 0 ? 'Keine Daten'
                      : Math.abs(diffH ?? 0) <= 0.5 ? 'OK'
                      : 'Abweichung'
                    }
                    color={
                      validBlocks.length === 0    ? 'text-muted-foreground'
                      : Math.abs(diffH ?? 0) <= 0.5 ? 'text-emerald-600 dark:text-emerald-400'
                                                    : 'text-amber-600 dark:text-amber-400'
                    }
                  />
                </div>
              </div>


              {/* ── Hinweis ── */}
              <div className="px-4 pb-5 text-[10px] text-muted-foreground/50">
                Quelle: actual_hour_entries ·{' '}
                {validBlocks.length} Block{validBlocks.length !== 1 ? 'e' : ''} ·{' '}
                mirus_import
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
