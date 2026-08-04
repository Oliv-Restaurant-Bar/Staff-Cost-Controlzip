import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Lock, LockOpen, Flag, Clock,
  FileText, Loader2, AlertTriangle, Archive,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { MONTH_NAMES_DE, type EmployeeTimeBalance } from '@/lib/timesheet-store';
import {
  upsertMonthStatus, saveMonthSnapshot,
  type MonthStatusRecord,
  type MonthSnapshotData,
} from '@/lib/timesheet-month-status-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface EmployeeLookup {
  id:           string;
  name:         string;
  department:   string;
  weekly_hours: number;
}

interface Props {
  tenantId:            string;
  year:                number;
  month:               number;
  employees:           EmployeeLookup[];
  monthStatuses:       Record<string, MonthStatusRecord>;
  istMap:              Record<string, number>;
  balances:            Record<string, EmployeeTimeBalance>;
  userEmail:           string | null;
  onChanged:           () => void;
  excludedEmployeeIds: Set<string>;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function sollHoursForMonth(weeklyHours: number, year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.round(weeklyHours / 7 * daysInMonth * 10) / 10;
}

function fmtDatetime(iso: string) {
  return new Date(iso).toLocaleString('de-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── Statusberechnung ─────────────────────────────────────────────────────────

interface StatusCounts {
  draft:         number;
  finalized:     number;
  archived:      number;
}

function computeStatusCounts(
  employees:     EmployeeLookup[],
  monthStatuses: Record<string, MonthStatusRecord>,
): StatusCounts {
  const counts: StatusCounts = { draft: 0, finalized: 0, archived: 0 };

  for (const emp of employees) {
    const ms = monthStatuses[emp.id];

    if (ms?.status === 'finalized') { counts.finalized++; continue; }
    if (ms?.status === 'archived')  { counts.archived++;  continue; }
    counts.draft++;
  }

  return counts;
}

// ─── Komponente ───────────────────────────────────────────────────────────────

export default function MonthAbschlussHeader({
  tenantId, year, month, employees,
  monthStatuses, istMap, balances, userEmail, onChanged, excludedEmployeeIds,
}: Props) {
  const [showDialog, setShowDialog]               = useState(false);
  const [finalizing, setFinalizing]               = useState(false);
  const [unlocking, setUnlocking]                 = useState(false);

  if (employees.length === 0) return null;

  // Ausgeschlossene herausfiltern — sie zählen weder für Finalisierung noch für Status
  const activeEmps    = employees.filter(e => !excludedEmployeeIds.has(e.id));
  const excludedCount = excludedEmployeeIds.size;

  // Berechnungen (nur aktive Mitarbeiter)
  const counts    = computeStatusCounts(activeEmps, monthStatuses);

  const isAllFinalized    = activeEmps.length > 0 && counts.finalized === activeEmps.length;
  const latestFinalizedAt = isAllFinalized
    ? Object.values(monthStatuses)
        .filter(s => s.status === 'finalized' && s.finalized_at)
        .sort((a, b) => (b.finalized_at ?? '').localeCompare(a.finalized_at ?? ''))
        [0]?.finalized_at ?? null
    : null;
  const finalizedBy = isAllFinalized
    ? Object.values(monthStatuses).find(s => s.status === 'finalized')?.finalized_by ?? null
    : null;

  // Snapshot zusammenstellen (nur aktive Mitarbeiter)
  function buildSnapshot(): MonthSnapshotData {
    const now = new Date().toISOString();
    return {
      tenant_id:          tenantId,
      year,
      month,
      finalized_at:       now,
      finalized_by:       userEmail,
      employee_count:     activeEmps.length,
      confirmed_count:    0,
      total_ist_hours:    Math.round(activeEmps.reduce((s, e) => s + (istMap[e.id] ?? 0), 0) * 10) / 10,
      open_request_count: 0,
      employees: activeEmps.map(e => {
        const soll = sollHoursForMonth(e.weekly_hours, year, month);
        const ist  = istMap[e.id] ?? 0;
        return {
          id:                  e.id,
          name:                e.name,
          department:          e.department,
          soll_hours:          soll,
          ist_hours:           ist,
          diff_hours:          Math.round((ist - soll) * 10) / 10,
          vacation_balance:    balances[e.id]?.vacation_balance_hours        ?? null,
          holiday_balance:     balances[e.id]?.public_holiday_balance_hours  ?? null,
          confirmation_status: null,
          confirmed_at:        null,
          employee_comment:    null,
        };
      }),
    };
  }

  // Finalisierungs-Handler (nur aktive Mitarbeiter werden finalisiert)
  async function handleFinalize() {
    setFinalizing(true);
    try {
      const snapshot = buildSnapshot();
      await saveMonthSnapshot(tenantId, year, month, snapshot, userEmail);
      await Promise.all(
        activeEmps.map(e => upsertMonthStatus(tenantId, e.id, year, month, 'finalized', userEmail)),
      );
      toast.success(`${MONTH_NAMES_DE[month - 1]} ${year} finalisiert und gesperrt`);
      setShowDialog(false);
      onChanged();
    } catch (err) {
      console.error('[MonthAbschlussHeader] finalize:', err);
      toast.error('Fehler beim Finalisieren');
    } finally {
      setFinalizing(false);
    }
  }

  // Entsperrungs-Handler (Admin-Override)
  async function handleUnlock() {
    if (!confirm(
      `Monat ${MONTH_NAMES_DE[month - 1]} ${year} entsperren?\n\n` +
      `${activeEmps.length} Mitarbeiter werden auf "bestätigt" zurückgesetzt. ` +
      `Der Snapshot bleibt erhalten.`,
    )) return;

    setUnlocking(true);
    try {
      await Promise.all(
        activeEmps.map(e => upsertMonthStatus(tenantId, e.id, year, month, 'draft', userEmail)),
      );
      toast.success('Monat entsperrt');
      onChanged();
    } catch (err) {
      console.error('[MonthAbschlussHeader] unlock:', err);
      toast.error('Fehler beim Entsperren');
    } finally {
      setUnlocking(false);
    }
  }

  const canFinalize = true;

  // ── Render ──────────────────────────────────────────────────────────────────

  // Finalisierter Monat: Lock-Banner
  if (isAllFinalized) {
    return (
      <div className="rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50/60 dark:bg-teal-950/20 px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-8 w-8 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center">
            <Lock className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-teal-800 dark:text-teal-300">
              Monat finalisiert und gesperrt
            </p>
            {latestFinalizedAt && (
              <p className="text-[11px] text-teal-600 dark:text-teal-400/80">
                {fmtDatetime(latestFinalizedAt)}
                {finalizedBy && ` · ${finalizedBy}`}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <span className="text-[11px] text-teal-600 dark:text-teal-500 hidden sm:block">
            Import, manuelle Bearbeitungen und neue Freigaben sind gesperrt.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleUnlock}
            disabled={unlocking}
            className="h-7 gap-1.5 border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-950/40"
          >
            {unlocking
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <LockOpen className="h-3.5 w-3.5" />}
            Entsperren
          </Button>
        </div>
      </div>
    );
  }

  // Status-Pill Konfiguration
  const PILLS = [
    { key: 'draft',         label: 'Entwurf',     count: counts.draft,         color: 'text-muted-foreground bg-muted border-border',                                                         icon: <FileText     className="h-3 w-3" /> },
    { key: 'finalized',     label: 'Finalisiert', count: counts.finalized,     color: 'text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/20 border-teal-200 dark:border-teal-800', icon: <Lock         className="h-3 w-3" /> },
  ] as const;
  const excludedPillColor = 'text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/40 border-zinc-200 dark:border-zinc-700';

  return (
    <>
      <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap justify-between">
        {/* Status-Pills */}
        <div className="flex items-center gap-2 flex-wrap">
          <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
          {PILLS.map(p => (
            p.count > 0 ? (
              <span
                key={p.key}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
                  p.color,
                )}
              >
                {p.icon}{p.label}: <strong>{p.count}</strong>
              </span>
            ) : null
          ))}
          {excludedCount > 0 && (
            <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border', excludedPillColor)}>
              <AlertTriangle className="h-3 w-3" />Ausgeschlossen: <strong>{excludedCount}</strong>
            </span>
          )}
          {PILLS.every(p => p.count === 0) && excludedCount === 0 && (
            <span className="text-xs text-muted-foreground">Keine Daten für diesen Monat</span>
          )}
        </div>

        {/* Finalisieren-Button */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDialog(true)}
          className={cn(
            'h-8 gap-1.5 shrink-0',
            'border-teal-300 dark:border-teal-700 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/20',
          )}
        >
          <Flag className="h-3.5 w-3.5" />Monat finalisieren
        </Button>
      </div>

      {/* Finalisierungs-Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flag className="h-4 w-4 text-teal-600" />
              Monat finalisieren
            </DialogTitle>
            <DialogDescription>
              {MONTH_NAMES_DE[month - 1]} {year} abschliessen und sperren.
              Danach sind Import, manuelle Bearbeitungen und neue Freigaben gesperrt.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {/* Zusammenfassung */}
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mitarbeiter aktiv</span>
                <strong>{activeEmps.length}</strong>
              </div>
              {excludedCount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ausgeschlossen (werden ignoriert)</span>
                  <strong className="text-zinc-400">{excludedCount}</strong>
                </div>
              )}
            </div>

            {/* Snapshot-Hinweis */}
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Archive className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Beim Finalisieren wird ein vollständiger Snapshot (Stunden, Salden,
                Änderungsverlauf) für die PDF-Archivierung gespeichert.
              </span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={finalizing}>
              Abbrechen
            </Button>
            <Button
              onClick={handleFinalize}
              disabled={!canFinalize || finalizing}
              className={cn(
                'gap-1.5',
                canFinalize
                  ? 'bg-teal-600 hover:bg-teal-700 text-white border-teal-600'
                  : '',
              )}
            >
              {finalizing
                ? <><Loader2 className="h-4 w-4 animate-spin" />Finalisiere…</>
                : <><Flag className="h-4 w-4" />Finalisieren</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
