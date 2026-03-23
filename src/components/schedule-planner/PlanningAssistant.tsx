import { useState, useMemo, useEffect } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  CheckCircle2, XCircle, Clock3, TrendingDown, TrendingUp,
  ShieldAlert, Star, ArrowRight, Users, Lightbulb, ChevronDown, ChevronRight,
  ArrowUpRight, Trash2, Euro, Scale, Sunrise, Moon, CalendarDays,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import {
  buildHourBalances,
  fmtBalanceHours,
  EmployeeHourBalance,
} from '@/lib/hour-balance-utils';
import {
  computeShiftFairness,
  buildFairnessAlerts,
  deviationColorClass,
  deviationSign,
  FairnessAlert,
  EmployeeShiftFairness,
} from '@/lib/fairness-utils';
import {
  StaffingTarget,
  computeStaffingStatus,
  SLOT_LABEL,
  STATUS_CLASSES,
  STATUS_ICON,
} from '@/lib/staffing-targets';
import { PatternWarning } from '@/lib/pattern-warnings';
import { Department } from '@/types/personnel';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, { hours: number }>;
  displayDays: Date[];
  allMonthDays: Date[];
  personnelBudget: number;
  totalFixCost: number;
  /** Optional staffing targets for alert integration */
  staffingTargets?: StaffingTarget[];
  /** Jump to a specific day in the schedule and optionally highlight an employee */
  onJumpToDay: (day: Date, empId?: string) => void;
  /** Directly remove a specific shift slot from the schedule */
  onRemoveShift: (empId: string, dateStr: string, slot: 'früh' | 'spät') => void;
  /** Pre-computed pattern warnings (consecutive days, late streaks, short recovery, overload) */
  patternWarnings?: PatternWarning[];
}

type HintStatus = 'pending' | 'accepted' | 'ignored' | 'later';
const STORAGE_KEY = 'planning_assistant_v1';

function loadStatuses(): Record<string, HintStatus> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); }
  catch { return {}; }
}
function saveStatuses(data: Record<string, HintStatus>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ─── Slot-Berechnung ──────────────────────────────────────────────────────────

function calcSlotHours(slot: TimeSlot | null | undefined): number {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = (eh - sh) + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.max(0, h);
}

function fmtSlot(slot: TimeSlot | null | undefined): string {
  if (!slot?.start || !slot?.end) return '';
  return `${slot.start}–${slot.end}`;
}

function getMonthHours(empId: string, days: Date[], data: Record<string, DaySchedule>): number {
  return days.reduce((s, day) => {
    const ds = data[`${empId}-${format(day, 'yyyy-MM-dd')}`];
    if (!ds) return s;
    const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
    return s + Math.max(0, gross - calculateBreakDeduction(gross));
  }, 0);
}

function getActualMonthHours(empId: string, days: Date[], actual: Record<string, { hours: number }>): number {
  return days.reduce((s, day) => s + (actual[`${empId}-${format(day, 'yyyy-MM-dd')}`]?.hours ?? 0), 0);
}

// ─── Konkrete Tages-Analyse ────────────────────────────────────────────────────

interface FreeDayInfo {
  day: Date;
  dateStr: string;
  label: string;
}

interface PlannedDayInfo {
  day: Date;
  dateStr: string;
  label: string;
  hasFrüh: boolean;
  hasSpät: boolean;
  frühDisplay: string;
  spätDisplay: string;
  frühHours: number;
  spätHours: number;
  isAbsenceFrüh: boolean;
  isAbsenceSpät: boolean;
  /** Can this früh slot be safely removed (spät still present)? */
  canRemoveFrüh: boolean;
  /** Can this spät slot be safely removed (früh still present OR single shift)? */
  canRemoveSpät: boolean;
}

function dayLabel(day: Date): string {
  return format(day, 'EEE d.M.', { locale: de });
}

/** Days in period where employee has NO shifts planned (and no absence) */
function getFreeDays(empId: string, days: Date[], data: Record<string, DaySchedule>): FreeDayInfo[] {
  return days
    .filter(day => {
      const ds = data[`${empId}-${format(day, 'yyyy-MM-dd')}`];
      if (!ds) return true;
      const hasFrüh = (calcSlotHours(ds.früh) > 0 && !ds.frühAbsence) || !!ds.frühAbsence;
      const hasSpät = (calcSlotHours(ds.spät) > 0 && !ds.spätAbsence) || !!ds.spätAbsence;
      return !hasFrüh && !hasSpät;
    })
    .map(day => ({ day, dateStr: format(day, 'yyyy-MM-dd'), label: dayLabel(day) }));
}

/** Days in period where employee IS scheduled (with shift times, ignoring absences) */
function getPlannedDays(empId: string, days: Date[], data: Record<string, DaySchedule>): PlannedDayInfo[] {
  const result: PlannedDayInfo[] = [];
  for (const day of days) {
    const ds = data[`${empId}-${format(day, 'yyyy-MM-dd')}`];
    if (!ds) continue;
    const fH = calcSlotHours(ds.früh);
    const sH = calcSlotHours(ds.spät);
    const hasFrüh = fH > 0 && !ds.frühAbsence;
    const hasSpät = sH > 0 && !ds.spätAbsence;
    if (!hasFrüh && !hasSpät) continue;
    result.push({
      day,
      dateStr: format(day, 'yyyy-MM-dd'),
      label: dayLabel(day),
      hasFrüh,
      hasSpät,
      frühDisplay: ds.früh ? `F: ${fmtSlot(ds.früh)}` : '',
      spätDisplay: ds.spät ? `S: ${fmtSlot(ds.spät)}` : '',
      frühHours: fH,
      spätHours: sH,
      isAbsenceFrüh: !!ds.frühAbsence,
      isAbsenceSpät: !!ds.spätAbsence,
      // Can remove früh if spät still present (keep at least one shift)
      canRemoveFrüh: hasFrüh && hasSpät,
      // Always offer removing spät; if single spät offer as "den ganzen Tag"
      canRemoveSpät: hasSpät,
    });
  }
  return result;
}

// ─── Farben ───────────────────────────────────────────────────────────────────

function balancePillClass(b: number): string {
  if (b <= -15) return 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400';
  if (b < -8)   return 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400';
  if (b < 0)    return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  if (b === 0)  return 'bg-muted text-muted-foreground';
  if (b <= 15)  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (b <= 25)  return 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400';
  return 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400';
}

// ─── Urgency-Gruppierung ──────────────────────────────────────────────────────

function getUrgency(balance: number, tab: 'einplanen' | 'reduzieren'): 'dringend' | 'bevorzugt' | 'allgemein' {
  if (tab === 'einplanen') {
    if (balance <= -15) return 'dringend';
    if (balance < -8)   return 'bevorzugt';
    return 'allgemein';
  } else {
    if (balance > 25) return 'dringend';
    if (balance > 15) return 'bevorzugt';
    return 'allgemein';
  }
}

const urgencyLabel: Record<string, string> = {
  dringend:  'Dringend',
  bevorzugt: 'Bevorzugt',
  allgemein: 'Allgemein',
};
const urgencyClass: Record<string, string> = {
  dringend:  'border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30',
  bevorzugt: 'border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30',
  allgemein: 'border-border text-muted-foreground bg-muted/30',
};

// ─── StatusActions ─────────────────────────────────────────────────────────────

function StatusActions({
  hintId,
  status,
  onChange,
}: {
  hintId: string;
  status: HintStatus;
  onChange: (id: string, s: HintStatus) => void;
}) {
  if (status === 'accepted') {
    return (
      <button onClick={() => onChange(hintId, 'pending')} className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium" title="Zurücksetzen">
        <CheckCircle2 className="h-4 w-4" /> Übernommen
      </button>
    );
  }
  if (status === 'ignored') {
    return (
      <button onClick={() => onChange(hintId, 'pending')} className="flex items-center gap-1 text-xs text-muted-foreground" title="Zurücksetzen">
        <XCircle className="h-4 w-4" /> Ignoriert
      </button>
    );
  }
  if (status === 'later') {
    return (
      <button onClick={() => onChange(hintId, 'pending')} className="flex items-center gap-1 text-xs text-blue-500 dark:text-blue-400" title="Zurücksetzen">
        <Clock3 className="h-4 w-4" /> Später
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onChange(hintId, 'accepted')} className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-950/50 text-emerald-600 transition-colors" title="Übernehmen">
        <CheckCircle2 className="h-4 w-4" />
      </button>
      <button onClick={() => onChange(hintId, 'later')} className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-950/50 text-blue-500 transition-colors" title="Später prüfen">
        <Clock3 className="h-4 w-4" />
      </button>
      <button onClick={() => onChange(hintId, 'ignored')} className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950/50 text-muted-foreground transition-colors" title="Ignorieren">
        <XCircle className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Einplanen-Karte ──────────────────────────────────────────────────────────

function EinplanenCard({
  b,
  hintId,
  status,
  freeDays,
  onJump,
  onStatusChange,
}: {
  b: EmployeeHourBalance;
  hintId: string;
  status: HintStatus;
  freeDays: FreeDayInfo[];
  onJump: (day: Date, empId: string) => void;
  onStatusChange: (id: string, s: HintStatus) => void;
}) {
  const balance = b.cumulativeBalance;
  const dept    = b.emp.department === 'küche' ? 'Küche' : 'Service';

  return (
    <div className={cn(
      'rounded-lg border px-3 py-2.5 space-y-2',
      status === 'accepted' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 opacity-70'
      : status === 'ignored' ? 'border-border bg-muted/20 opacity-40'
      : status === 'later'   ? 'border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 opacity-80'
      : balance < -15        ? 'border-red-200 dark:border-red-800 bg-red-50/20 dark:bg-red-950/10'
      : balance < -8         ? 'border-orange-200 dark:border-orange-800 bg-orange-50/30 dark:bg-orange-950/10'
      : 'border-border bg-card',
    )}>
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TrendingDown className={cn('h-4 w-4 shrink-0', balance < -15 ? 'text-red-500' : 'text-orange-500')} />
        <span className="text-sm font-semibold">{b.emp.name}</span>
        <Badge variant="outline" className="text-[10px]">{dept}</Badge>
        {b.station && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className={cn(
                'text-[10px] cursor-help',
                b.isUniqueInStation
                  ? 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300'
                  : 'border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300',
              )}>
                {b.isUniqueInStation && <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />}
                {b.emp.positionTitle}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {b.isUniqueInStation
                ? `Einzige ${b.emp.positionTitle} in ${dept} — kein gleichwertiger Ersatz`
                : `Positionsgeeignete Alternativen: ${b.stationPeers.join(', ')}`}
            </TooltipContent>
          </Tooltip>
        )}
        {b.hasTarget && (
          <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded', balancePillClass(balance))}>
            {fmtBalanceHours(balance)}
          </span>
        )}
        <div className="ml-auto">
          <StatusActions hintId={hintId} status={status} onChange={onStatusChange} />
        </div>
      </div>

      {/* Empfehlungstext */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {balance < -15
          ? `Dringend einplanen — ${Math.abs(balance).toFixed(1)} h Minussaldo${b.station ? ` (${b.emp.positionTitle})` : ''}.`
          : `Bevorzugt einplanen — ${Math.abs(balance).toFixed(1)} h Minussaldo.`}
        {b.stationPeers.length > 0 && ` Alternativen: ${b.stationPeers.join(', ')}.`}
      </p>

      {/* Konkrete Tage */}
      {freeDays.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Freie Tage in dieser Periode
          </p>
          <div className="flex flex-wrap gap-1.5">
            {freeDays.slice(0, 5).map(fd => (
              <button
                key={fd.dateStr}
                onClick={() => onJump(fd.day, b.emp.id)}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors',
                  'bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800',
                  'text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50',
                )}
                title={`Zum ${fd.label} im Dienstplan springen`}
              >
                <ArrowUpRight className="h-3 w-3" />
                {fd.label}
              </button>
            ))}
            {freeDays.length > 5 && (
              <span className="text-[10px] text-muted-foreground self-center">
                + {freeDays.length - 5} weitere
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" />
          Alle Tage dieser Periode sind bereits eingeplant.
        </p>
      )}

      {/* Station-Hinweis */}
      {b.isUniqueInStation && b.station && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" />
          Einzige {b.emp.primaryStation ?? b.emp.positionTitle} — bei Abwesenheit kein Ersatz verfügbar
        </p>
      )}
      {b.stationPeers.length > 0 && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Users className="h-3 w-3" />
          Primäre Kolleg/-innen: <strong className="ml-0.5">{b.stationPeers.join(', ')}</strong>
        </p>
      )}
      {b.secondaryStationPeers.length > 0 && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <ArrowRight className="h-3 w-3" />
          Kann einspringen (Zweitfunktion): <strong className="ml-0.5">{b.secondaryStationPeers.join(', ')}</strong>
        </p>
      )}
      {!b.station && (
        <p className="text-[10px] text-muted-foreground italic">
          Keine Station hinterlegt — Ersatzbarkeit nicht beurteilbar
        </p>
      )}
    </div>
  );
}

// ─── Reduzieren-Karte ─────────────────────────────────────────────────────────

function ReduzierenCard({
  b,
  hintId,
  status,
  plannedDays,
  onJump,
  onRemoveShift,
  onStatusChange,
}: {
  b: EmployeeHourBalance;
  hintId: string;
  status: HintStatus;
  plannedDays: PlannedDayInfo[];
  onJump: (day: Date, empId: string) => void;
  onRemoveShift: (empId: string, dateStr: string, slot: 'früh' | 'spät') => void;
  onStatusChange: (id: string, s: HintStatus) => void;
}) {
  const balance = b.cumulativeBalance;
  const dept    = b.emp.department === 'küche' ? 'Küche' : 'Service';

  return (
    <div className={cn(
      'rounded-lg border px-3 py-2.5 space-y-2',
      status === 'accepted' ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 opacity-70'
      : status === 'ignored' ? 'border-border bg-muted/20 opacity-40'
      : status === 'later'   ? 'border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 opacity-80'
      : balance > 25         ? 'border-violet-200 dark:border-violet-800 bg-violet-50/30 dark:bg-violet-950/10'
      : 'border-blue-200 dark:border-blue-800 bg-blue-50/20 dark:bg-blue-950/10',
    )}>
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TrendingUp className={cn('h-4 w-4 shrink-0', balance > 25 ? 'text-violet-500' : 'text-blue-500')} />
        <span className="text-sm font-semibold">{b.emp.name}</span>
        <Badge variant="outline" className="text-[10px]">{dept}</Badge>
        {b.station && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className={cn(
                'text-[10px] cursor-help',
                b.isUniqueInStation
                  ? 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-300'
                  : 'border-indigo-200 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 dark:text-indigo-300',
              )}>
                {b.isUniqueInStation && <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />}
                {b.emp.positionTitle}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {b.isUniqueInStation
                ? `Einzige ${b.emp.positionTitle} in ${dept} — Reduktion mit Vorsicht`
                : `Positionsgeeignete Alternativen: ${b.stationPeers.join(', ')}`}
            </TooltipContent>
          </Tooltip>
        )}
        <span className={cn('text-xs font-mono font-semibold px-1.5 py-0.5 rounded', balancePillClass(balance))}>
          {fmtBalanceHours(balance)}
        </span>
        <div className="ml-auto">
          <StatusActions hintId={hintId} status={status} onChange={onStatusChange} />
        </div>
      </div>

      {/* Empfehlungstext */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {balance > 25
          ? `Freier Tag dringend empfohlen — ${balance.toFixed(1)} h Plussaldo.`
          : `Schichten könnten reduziert werden — ${balance.toFixed(1)} h Plussaldo.`}
        {b.isUniqueInStation && b.station
          ? ` Achtung: einzige ${b.emp.positionTitle}, Besetzung prüfen.`
          : b.stationPeers.length > 0
            ? ` Ersatz durch ${b.stationPeers.join(' oder ')} möglich.`
            : ''}
      </p>

      {/* Konkrete geplante Schichten */}
      {plannedDays.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Geplante Schichten in dieser Periode
          </p>
          <div className="space-y-1">
            {plannedDays.map(pd => (
              <div key={pd.dateStr} className="flex flex-wrap items-center gap-1.5">
                {/* Jump chip */}
                <button
                  onClick={() => onJump(pd.day, b.emp.id)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-muted/60 border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Im Dienstplan anzeigen"
                >
                  <ArrowUpRight className="h-3 w-3" />
                  {pd.label}
                </button>
                {/* Früh slot */}
                {pd.hasFrüh && (
                  <div className="flex items-center gap-0.5">
                    <span className="text-[11px] text-muted-foreground bg-muted/40 border border-border rounded px-1.5 py-0.5">
                      {pd.frühDisplay}
                    </span>
                    {pd.canRemoveFrüh && !b.isUniqueInStation && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onRemoveShift(b.emp.id, pd.dateStr, 'früh')}
                            className="p-0.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                            title="Frühschicht streichen"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Frühschicht am {pd.label} streichen</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
                {/* Spät slot */}
                {pd.hasSpät && (
                  <div className="flex items-center gap-0.5">
                    <span className="text-[11px] text-muted-foreground bg-muted/40 border border-border rounded px-1.5 py-0.5">
                      {pd.spätDisplay}
                    </span>
                    {pd.canRemoveSpät && !b.isUniqueInStation && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onRemoveShift(b.emp.id, pd.dateStr, 'spät')}
                            className="p-0.5 rounded text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                            title="Spätschicht streichen"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {pd.hasFrüh ? 'Spätschicht' : 'Schicht'} am {pd.label} streichen
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                )}
                {/* Safety block */}
                {b.isUniqueInStation && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5">
                    <ShieldAlert className="h-3 w-3" /> Kein Ersatz
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground italic">
          Keine Schichten in dieser Periode geplant — allgemeine Empfehlung für nächste Woche.
        </p>
      )}

      {/* Stations-Alternativen */}
      {!b.isUniqueInStation && b.stationPeers.length > 0 && (
        <p className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Reduktion möglich: {b.stationPeers.join(', ')} {b.stationPeers.length === 1 ? 'kann' : 'können'} übernehmen
        </p>
      )}
      {b.isUniqueInStation && b.station && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" />
          Einzige {b.emp.positionTitle} — direktes Streichen deaktiviert
        </p>
      )}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function PlanningAssistant({
  open,
  onClose,
  employees,
  scheduleData,
  actualHoursData,
  displayDays,
  allMonthDays,
  personnelBudget,
  totalFixCost,
  staffingTargets = [],
  onJumpToDay,
  onRemoveShift,
  patternWarnings = [],
}: Props) {
  const [tab, setTab]                   = useState<'einplanen' | 'reduzieren' | 'fairness'>('einplanen');
  const [statuses, setStatuses]         = useState<Record<string, HintStatus>>(loadStatuses);
  const [showIgnored, setShowIgnored]   = useState(false);
  const [fairnessFilter, setFairnessFilter] = useState<'all' | 'service' | 'küche'>('all');
  const [showPatternWarnings, setShowPatternWarnings] = useState(true);

  useEffect(() => { if (!open) setTab('einplanen'); }, [open]);

  const updateStatus = (id: string, s: HintStatus) => {
    setStatuses(prev => {
      const next = { ...prev, [id]: s };
      saveStatuses(next);
      return next;
    });
  };

  // ── Budget ────────────────────────────────────────────────────────────────

  const availableVarBudget = personnelBudget > 0 ? Math.max(0, personnelBudget - totalFixCost) : 0;

  // ── Stunden-Aggregate ────────────────────────────────────────────────────

  const planHoursMap = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const emp of employees) {
      const h = getMonthHours(emp.id, allMonthDays, scheduleData);
      if (h > 0) map[emp.id] = h;
    }
    return map;
  }, [employees, allMonthDays, scheduleData]);

  const istHoursMap = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const emp of employees) {
      const h = getActualMonthHours(emp.id, allMonthDays, actualHoursData);
      if (h > 0) map[emp.id] = h;
    }
    return map;
  }, [employees, allMonthDays, actualHoursData]);

  const balances = useMemo(() =>
    buildHourBalances(employees, planHoursMap, istHoursMap, empId => planHoursMap[empId] ?? 0),
    [employees, planHoursMap, istHoursMap],
  );

  // ── Besetzungsalarm (Staffing target alerts) ──────────────────────────────
  const staffingAlerts = useMemo(() => {
    if (!staffingTargets.length || !displayDays.length) return [];
    const alerts: Array<{
      day:    Date;
      dept:   Department;
      slot:   'früh' | 'spät';
      actual: number;
      min:    number;
      ideal:  number;
      status: 'under' | 'over';
      label:  string;
    }> = [];
    for (const day of displayDays) {
      for (const dept of ['service', 'küche'] as Department[]) {
        for (const slot of ['früh', 'spät'] as const) {
          const s = computeStaffingStatus(staffingTargets, employees, scheduleData, day, dept, slot);
          if (s.status === 'under' || s.status === 'over') {
            const dStr = format(day, 'EEE d.M.', { locale: de });
            alerts.push({ day, dept, slot, actual: s.actual, min: s.min, ideal: s.ideal, status: s.status, label: dStr });
          }
        }
      }
    }
    return alerts;
  }, [staffingTargets, employees, scheduleData, displayDays]);

  // Remaining var hours
  const avgVarWage = useMemo(() => {
    const varEmps = employees.filter(e => (e.hourlyWage ?? 0) > 0 && !e.monthlySalary);
    if (!varEmps.length) return 0;
    return varEmps.reduce((s, e) => s + e.hourlyWage, 0) / varEmps.length;
  }, [employees]);

  const remainingVarHours = useMemo(() => {
    if (availableVarBudget <= 0 || avgVarWage <= 0) return 0;
    const maxH  = availableVarBudget / avgVarWage;
    const usedH = employees.reduce((s, e) => e.monthlySalary ? s : s + (planHoursMap[e.id] ?? 0), 0);
    return Math.max(0, maxH - usedH);
  }, [employees, planHoursMap, availableVarBudget, avgVarWage]);

  // ── Per-day slot cost analysis ────────────────────────────────────────────

  const dayCostAnalysis = useMemo(() => {
    // Internal helper: hours from a TimeSlot
    const slotHours = (slot: TimeSlot | null | undefined): number => {
      if (!slot?.start || !slot?.end) return 0;
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      let h = eh - sh + (em - sm) / 60;
      if (h < 0) h += 24;
      return Math.max(0, Math.round(h * 100) / 100);
    };

    return displayDays.map(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      let frühTotal = 0, spätTotal = 0;
      const byDept: Record<string, { früh: number; spät: number }> = {
        service: { früh: 0, spät: 0 },
        küche:   { früh: 0, spät: 0 },
      };

      for (const emp of employees) {
        if (!emp.hourlyWage) continue;
        const ds = scheduleData[`${emp.id}-${dateStr}`];
        if (!ds) continue;
        const fh = slotHours(ds.früh);
        const sh = slotHours(ds.spät);
        const gross = fh + sh;
        if (gross === 0) continue;
        const br = calculateBreakDeduction(gross);
        const fNet = Math.max(0, fh - br * (fh / gross));
        const sNet = Math.max(0, sh - br * (sh / gross));
        const fCost = fNet * emp.hourlyWage;
        const sCost = sNet * emp.hourlyWage;
        frühTotal += fCost;
        spätTotal += sCost;
        const dept = emp.department === 'küche' ? 'küche' : 'service';
        byDept[dept].früh += fCost;
        byDept[dept].spät += sCost;
      }

      const total = frühTotal + spätTotal;
      const driver: 'früh' | 'spät' | null =
        total === 0 ? null : frühTotal > spätTotal ? 'früh' : 'spät';

      // Per-dept driver
      const deptDrivers = (['service', 'küche'] as const)
        .map(dept => {
          const d = byDept[dept];
          if (d.früh === 0 && d.spät === 0) return null;
          return {
            dept,
            driver: d.früh > d.spät ? 'früh' : 'spät' as 'früh' | 'spät',
            frühCost: d.früh,
            spätCost: d.spät,
          };
        })
        .filter(Boolean) as Array<{ dept: 'service' | 'küche'; driver: 'früh' | 'spät'; frühCost: number; spätCost: number }>;

      return {
        dateStr,
        day,
        dayLabel: format(day, 'EEE d.M.', { locale: de }),
        frühCost: frühTotal,
        spätCost: spätTotal,
        totalCost: total,
        driver,
        deptDrivers,
      };
    }).filter(d => d.totalCost > 0);
  }, [displayDays, employees, scheduleData]);

  // Find days where one slot costs ≥ 60% of total (clear driver)
  const costDriverAlerts = useMemo(() =>
    dayCostAnalysis.filter(d =>
      d.totalCost > 0 &&
      (d.frühCost / d.totalCost > 0.60 || d.spätCost / d.totalCost > 0.60),
    ),
  [dayCostAnalysis]);

  // ── Fairness-Daten ────────────────────────────────────────────────────────

  const fairnessData = useMemo<EmployeeShiftFairness[]>(() =>
    computeShiftFairness(employees, scheduleData, displayDays, actualHoursData),
    [employees, scheduleData, displayDays, actualHoursData],
  );

  const balanceMap = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const b of balances) m[b.emp.id] = b.cumulativeBalance;
    return m;
  }, [balances]);

  const fairnessAlerts = useMemo<FairnessAlert[]>(() =>
    buildFairnessAlerts(fairnessData, balanceMap),
    [fairnessData, balanceMap],
  );

  const fairnessPending = fairnessAlerts.filter(a => a.severity === 'high' || a.severity === 'medium').length;

  // ── Perioden-Label ────────────────────────────────────────────────────────

  const periodLabel = useMemo(() => {
    if (!displayDays.length) return '';
    if (displayDays.length === 1) return format(displayDays[0], 'EEEE, d. MMMM yyyy', { locale: de });
    return `${format(displayDays[0], 'd.M.')} – ${format(displayDays[displayDays.length - 1], 'd.M.yyyy', { locale: de })}`;
  }, [displayDays]);

  // ── Einplanen-Reihen: employees mit Minus-Saldo ───────────────────────────

  const einplanenRows = useMemo(() => {
    return balances
      .filter(b => b.cumulativeBalance < -8 && b.hasTarget)
      .map(b => ({
        b,
        hintId: `einplanen-${b.emp.id}`,
        freeDays: getFreeDays(b.emp.id, displayDays, scheduleData),
        urgency: getUrgency(b.cumulativeBalance, 'einplanen'),
      }))
      .sort((a, b_) => a.b.cumulativeBalance - b_.b.cumulativeBalance);
  }, [balances, displayDays, scheduleData]);

  // ── Reduzieren-Reihen: employees mit Plus-Saldo + geplanten Schichten ────

  const reduzierenRows = useMemo(() => {
    return balances
      .filter(b => {
        const pd = getPlannedDays(b.emp.id, displayDays, scheduleData);
        return b.cumulativeBalance >= 10 && pd.length > 0;
      })
      .map(b => ({
        b,
        hintId: `reduzieren-${b.emp.id}`,
        plannedDays: getPlannedDays(b.emp.id, displayDays, scheduleData),
        urgency: getUrgency(b.cumulativeBalance, 'reduzieren'),
      }))
      .sort((a, b_) => b_.b.cumulativeBalance - a.b.cumulativeBalance);
  }, [balances, displayDays, scheduleData]);

  const einplanenPending  = einplanenRows.filter(r => (statuses[r.hintId] ?? 'pending') === 'pending').length;
  const reduzierenPending = reduzierenRows.filter(r => (statuses[r.hintId] ?? 'pending') === 'pending').length;
  const totalPending = einplanenPending + reduzierenPending;

  // Grouped by urgency for display
  const grouped = <T extends { urgency: string; hintId: string }>(
    rows: T[],
  ): Array<{ urgency: string; rows: T[] }> => {
    const order = ['dringend', 'bevorzugt', 'allgemein'];
    return order
      .map(u => ({ urgency: u, rows: rows.filter(r => r.urgency === u) }))
      .filter(g => g.rows.length > 0);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <TooltipProvider delayDuration={250}>
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-indigo-500" />
            Planungshilfe
            {totalPending > 0 && (
              <Badge className="text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                {totalPending} offen
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {periodLabel && <span>{periodLabel} · </span>}
            Regelbasierte Empfehlungen · Klick auf einen Tag öffnet die Woche im Dienstplan
          </DialogDescription>
        </DialogHeader>

        {/* Budget-Schnellinfo */}
        {personnelBudget > 0 && (
          <div className="flex flex-wrap items-center gap-4 px-3 py-2 rounded-lg border bg-muted/30 text-xs text-muted-foreground shrink-0">
            <span>
              Variabel-Budget:
              <strong className={cn('ml-1 font-mono', availableVarBudget > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                {availableVarBudget.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 })}
              </strong>
              {' '}verfügbar
            </span>
            {remainingVarHours > 0 && (
              <span>≈ <strong className="text-foreground font-mono">{Math.round(remainingVarHours)} h</strong> noch planbar</span>
            )}
          </div>
        )}

        {/* Besetzungsalarm */}
        {staffingAlerts.length > 0 && (
          <div className="rounded-lg border bg-muted/20 divide-y divide-border shrink-0">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <ShieldAlert className="h-3.5 w-3.5 text-rose-500" />
              <span className="text-xs font-semibold">
                Besetzungsalarm — {staffingAlerts.filter(a => a.status === 'under').length > 0
                  ? `${staffingAlerts.filter(a => a.status === 'under').length} unter Mindest`
                  : ''}
                {staffingAlerts.filter(a => a.status === 'under').length > 0 &&
                 staffingAlerts.filter(a => a.status === 'over').length > 0 ? ', ' : ''}
                {staffingAlerts.filter(a => a.status === 'over').length > 0
                  ? `${staffingAlerts.filter(a => a.status === 'over').length} über Ideal`
                  : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 px-3 py-2">
              {staffingAlerts.map((a, i) => (
                <button
                  key={i}
                  onClick={() => { onJumpToDay(a.day); onClose(); }}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium transition-opacity hover:opacity-80',
                    a.status === 'under'
                      ? STATUS_CLASSES['under']
                      : STATUS_CLASSES['over'],
                  )}
                  title={`${a.label} — ${a.dept === 'service' ? 'Service' : 'Küche'} ${SLOT_LABEL[a.slot]}: ${a.actual} ${a.status === 'under' ? `(mind. ${a.min})` : `(ideal ${a.ideal})`}`}
                >
                  <span className="text-[9px]">{STATUS_ICON[a.status]}</span>
                  {a.label}
                  <span className="opacity-60 text-[9px]">{a.dept === 'service' ? 'SV' : 'KÜ'} {SLOT_LABEL[a.slot]}</span>
                  <span className="font-bold">{a.actual}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Arbeitsmuster-Warnungen */}
        {patternWarnings.length > 0 && (
          <div className="rounded-lg border bg-muted/20 divide-y divide-border shrink-0">
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors text-left"
              onClick={() => setShowPatternWarnings(v => !v)}
            >
              <ShieldAlert className="h-3.5 w-3.5 text-orange-500 shrink-0" />
              <span className="text-xs font-semibold">Arbeitsmuster-Warnungen</span>
              <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300">
                {patternWarnings.filter(w => w.severity === 'critical').length > 0
                  ? `${patternWarnings.filter(w => w.severity === 'critical').length} kritisch`
                  : `${patternWarnings.length} Hinweis${patternWarnings.length !== 1 ? 'e' : ''}`
                }
              </span>
              <span className="ml-auto text-muted-foreground">
                {showPatternWarnings
                  ? <ChevronDown className="h-3 w-3" />
                  : <ChevronRight className="h-3 w-3" />
                }
              </span>
            </button>
            {showPatternWarnings && (() => {
              const critical = patternWarnings.filter(w => w.severity === 'critical');
              const warning  = patternWarnings.filter(w => w.severity === 'warning');
              const makeJump = (w: PatternWarning) => {
                const [y, m, d] = w.firstDate.split('-').map(Number);
                onJumpToDay(new Date(y, m - 1, d), w.empId);
                onClose();
              };
              return (
                <div className="px-3 py-2 space-y-2">
                  {critical.length > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400 mb-1.5">
                        Kritisch
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {critical.map((w, i) => (
                          <button
                            key={i}
                            onClick={() => makeJump(w)}
                            className="flex flex-col items-start px-2 py-1 rounded border text-[10px] bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:opacity-80 transition-opacity"
                          >
                            <span className="font-semibold leading-snug">{w.empName}</span>
                            <span className="text-[9px] opacity-80 leading-snug">{w.message}</span>
                            <span className="text-[8px] opacity-60 leading-snug mt-0.5">{w.detail}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {warning.length > 0 && (
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400 mb-1.5">
                        Hinweise
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {warning.map((w, i) => (
                          <button
                            key={i}
                            onClick={() => makeJump(w)}
                            className="flex flex-col items-start px-2 py-1 rounded border text-[10px] bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:opacity-80 transition-opacity"
                          >
                            <span className="font-semibold leading-snug">{w.empName}</span>
                            <span className="text-[9px] opacity-80 leading-snug">{w.message}</span>
                            <span className="text-[8px] opacity-60 leading-snug mt-0.5">{w.detail}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Kostenproblem per Slot */}
        {dayCostAnalysis.length > 0 && (
          <div className="rounded-lg border bg-muted/20 divide-y divide-border shrink-0">
            <div className="flex items-center gap-2 px-3 py-1.5">
              <Euro className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-xs font-semibold">Kosten nach Schicht</span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {dayCostAnalysis.length === 1 ? '1 Tag' : `${dayCostAnalysis.length} Tage`} mit Kostendaten
              </span>
            </div>
            <div className="px-3 py-2 space-y-1">
              {/* Summary chips for the whole period */}
              <div className="flex flex-wrap gap-1.5">
                {dayCostAnalysis.map(d => {
                  const isAlert = costDriverAlerts.includes(d);
                  const driver = d.driver;
                  return (
                    <button
                      key={d.dateStr}
                      onClick={() => { onJumpToDay(d.day); onClose(); }}
                      className={cn(
                        'flex flex-col items-start gap-0 px-2 py-1 rounded border text-[10px] font-medium transition-opacity hover:opacity-80',
                        isAlert && driver === 'spät'
                          ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                          : isAlert && driver === 'früh'
                            ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                            : 'bg-muted/50 border-border text-muted-foreground',
                      )}
                      title={`${d.dayLabel}: Früh CHF ${d.frühCost.toFixed(0)}, Spät CHF ${d.spätCost.toFixed(0)}`}
                    >
                      <span className="font-semibold">{d.dayLabel}</span>
                      <span className="text-[9px] leading-tight opacity-80">
                        ☀ {d.frühCost.toFixed(0)} · 🌙 {d.spätCost.toFixed(0)}
                      </span>
                      {isAlert && (
                        <span className="text-[8px] font-bold uppercase tracking-wide opacity-90">
                          {driver === 'früh' ? '▲ Früh' : '▲ Spät'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* Dept-level insight for the period */}
              {(() => {
                const svcFrüh = dayCostAnalysis.reduce((s, d) => s + (d.deptDrivers.find(dr => dr.dept === 'service')?.frühCost ?? 0), 0);
                const svcSpät = dayCostAnalysis.reduce((s, d) => s + (d.deptDrivers.find(dr => dr.dept === 'service')?.spätCost ?? 0), 0);
                const kchFrüh = dayCostAnalysis.reduce((s, d) => s + (d.deptDrivers.find(dr => dr.dept === 'küche')?.frühCost ?? 0), 0);
                const kchSpät = dayCostAnalysis.reduce((s, d) => s + (d.deptDrivers.find(dr => dr.dept === 'küche')?.spätCost ?? 0), 0);
                const lines: string[] = [];
                if (svcFrüh > 0 || svcSpät > 0) {
                  const svcDriver = svcFrüh > svcSpät ? 'Früh' : 'Spät';
                  lines.push(`Service: ${svcDriver}dienst teurer (${svcFrüh.toFixed(0)} / ${svcSpät.toFixed(0)} CHF)`);
                }
                if (kchFrüh > 0 || kchSpät > 0) {
                  const kchDriver = kchFrüh > kchSpät ? 'Früh' : 'Spät';
                  lines.push(`Küche: ${kchDriver}dienst teurer (${kchFrüh.toFixed(0)} / ${kchSpät.toFixed(0)} CHF)`);
                }
                if (!lines.length) return null;
                return (
                  <div className="pt-1 space-y-0.5">
                    {lines.map(l => (
                      <p key={l} className="text-[10px] text-muted-foreground leading-snug">
                        {l}
                      </p>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-muted/60 rounded-lg p-0.5 shrink-0">
          {([
            { id: 'einplanen'  as const, label: 'Einplanen',  count: einplanenPending,  icon: <TrendingDown className="h-3.5 w-3.5" />, activeCount: 'bg-orange-100 text-orange-700' },
            { id: 'reduzieren' as const, label: 'Reduzieren', count: reduzierenPending, icon: <TrendingUp    className="h-3.5 w-3.5" />, activeCount: 'bg-violet-100 text-violet-700' },
            { id: 'fairness'   as const, label: 'Fairness',   count: fairnessPending,   icon: <Scale        className="h-3.5 w-3.5" />, activeCount: 'bg-teal-100 text-teal-700' },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-semibold rounded-md transition-colors',
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.icon}
              {t.label}
              {t.count > 0 && (
                <span className={cn(
                  'px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                  tab === t.id ? t.activeCount : 'bg-muted text-muted-foreground',
                )}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab-Inhalt */}
        <div className="overflow-y-auto flex-1 min-h-0 space-y-3 pr-1">

          {/* ── Einplanen ─────────────────────────────────────────────── */}
          {tab === 'einplanen' && (
            <>
              <p className="text-xs text-muted-foreground px-1">
                Mitarbeiter mit Minussaldo — klicke auf einen freien Tag, um direkt dorthin im Dienstplan zu springen und die Zeile zu markieren.
              </p>

              {einplanenRows.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Kein Mitarbeiter mit ausgeprägtem Minussaldo (unter −8 h) gefunden.
                </p>
              )}

              {grouped(einplanenRows).map(({ urgency, rows }) => (
                <div key={urgency} className="space-y-2">
                  <div className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border', urgencyClass[urgency])}>
                    {urgencyLabel[urgency]}
                  </div>
                  {rows
                    .filter(r => showIgnored || (statuses[r.hintId] ?? 'pending') !== 'ignored')
                    .map(({ b, hintId, freeDays }) => (
                      <EinplanenCard
                        key={hintId}
                        b={b}
                        hintId={hintId}
                        status={statuses[hintId] ?? 'pending'}
                        freeDays={freeDays}
                        onJump={(day, empId) => { onJumpToDay(day, empId); onClose(); }}
                        onStatusChange={updateStatus}
                      />
                    ))}
                </div>
              ))}

              {availableVarBudget > 0 && remainingVarHours > 0 && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 px-3 py-2 flex items-start gap-2">
                  <Star className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    Noch ca. <strong className="font-mono">{Math.round(remainingVarHours)} h</strong> Variabel-Budget verfügbar — bevorzugt bei Mitarbeitern im Minus einplanen.
                  </p>
                </div>
              )}
            </>
          )}

          {/* ── Reduzieren ────────────────────────────────────────────── */}
          {tab === 'reduzieren' && (
            <>
              <p className="text-xs text-muted-foreground px-1">
                Mitarbeiter mit hohem Plussaldo und Schichten in dieser Periode. Der 🗑-Button streicht eine Schicht direkt im Dienstplan — nur aktiv wenn ein gleichwertiger Ersatz verfügbar ist.
              </p>

              {reduzierenRows.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Kein Mitarbeiter mit positivem Saldo und aktiven Schichten in dieser Periode.
                </p>
              )}

              {grouped(reduzierenRows).map(({ urgency, rows }) => (
                <div key={urgency} className="space-y-2">
                  <div className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border', urgencyClass[urgency])}>
                    {urgencyLabel[urgency]}
                  </div>
                  {rows
                    .filter(r => showIgnored || (statuses[r.hintId] ?? 'pending') !== 'ignored')
                    .map(({ b, hintId, plannedDays }) => (
                      <ReduzierenCard
                        key={hintId}
                        b={b}
                        hintId={hintId}
                        status={statuses[hintId] ?? 'pending'}
                        plannedDays={plannedDays}
                        onJump={(day, empId) => { onJumpToDay(day, empId); onClose(); }}
                        onRemoveShift={onRemoveShift}
                        onStatusChange={updateStatus}
                      />
                    ))}
                </div>
              ))}
            </>
          )}

          {/* ── Fairness ──────────────────────────────────────────────── */}
          {tab === 'fairness' && (() => {
            const filtered = fairnessData.filter(f =>
              fairnessFilter === 'all' || f.dept === fairnessFilter,
            );
            const filteredAlerts = fairnessAlerts.filter(a =>
              fairnessFilter === 'all' || a.dept === fairnessFilter,
            );

            const alertIcon = (type: FairnessAlert['type']) =>
              type === 'weekend-overload' ? <CalendarDays className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
              type === 'evening-overload' ? <Moon className="h-3.5 w-3.5 shrink-0 mt-0.5" /> :
              <Scale className="h-3.5 w-3.5 shrink-0 mt-0.5" />;

            const alertColors: Record<FairnessAlert['type'], string> = {
              'weekend-overload': 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300',
              'evening-overload': 'border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 text-blue-700 dark:text-blue-300',
              'can-take-free':    'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300',
            };

            return (
              <>
                <div className="flex items-center gap-1.5 px-0.5">
                  <p className="text-xs text-muted-foreground flex-1">
                    Wöchentliche Stunden und Fairness-Belastung — Vergleich innerhalb der Abteilung.
                  </p>
                  {/* Dept filter */}
                  <div className="flex gap-1">
                    {(['all', 'service', 'küche'] as const).map(d => (
                      <button
                        key={d}
                        onClick={() => setFairnessFilter(d)}
                        className={cn(
                          'px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors',
                          fairnessFilter === d
                            ? 'bg-teal-600 text-white border-teal-600'
                            : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
                        )}
                      >
                        {d === 'all' ? 'Alle' : d === 'service' ? 'Serv.' : 'Küche'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Fairness-Alerts */}
                {filteredAlerts.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-0.5">
                      Hinweise
                    </p>
                    {filteredAlerts.map((alert, i) => (
                      <div
                        key={`${alert.empId}-${alert.type}-${i}`}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs',
                          alertColors[alert.type],
                        )}
                      >
                        {alertIcon(alert.type)}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold leading-tight">{alert.message}</p>
                          {alert.detail && (
                            <p className="text-[10px] opacity-80 leading-tight mt-0.5">{alert.detail}</p>
                          )}
                        </div>
                        {alert.severity === 'high' && (
                          <Badge className="text-[9px] shrink-0 self-center bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400 border-0">
                            Hoch
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {filteredAlerts.length === 0 && filtered.length > 0 && (
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 px-3 py-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    <p className="text-xs text-emerald-700 dark:text-emerald-300">
                      Keine auffälligen Fairness-Ungleichgewichte in dieser Periode.
                    </p>
                  </div>
                )}

                {/* Weekly breakdown per employee */}
                {filtered.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-0.5">
                      Wöchentliche Stunden (Soll / Plan{Object.keys(actualHoursData).length > 0 ? ' / Ist' : ''})
                    </p>
                    {filtered
                      .filter(f => f.weeklyBreakdown.some(w => w.targetHours > 0))
                      .map(f => {
                        const emp = employees.find(e => e.id === f.empId);
                        if (!emp) return null;
                        const hasActual = f.weeklyBreakdown.some(w => w.actualHours !== null);
                        return (
                          <div key={f.empId} className="rounded-lg border bg-card p-2.5 space-y-1.5">
                            {/* Employee header */}
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold">{f.empName}</span>
                              <Badge variant="outline" className="text-[9px]">
                                {f.dept === 'service' ? 'Service' : 'Küche'}
                              </Badge>
                              {/* Fairness indicators */}
                              {f.totalShiftsWorked > 0 && (
                                <div className="ml-auto flex items-center gap-2 text-[9px] text-muted-foreground">
                                  <span title="Wochenend-Schichten-Anteil">
                                    <CalendarDays className="h-2.5 w-2.5 inline mr-0.5" />
                                    {Math.round(f.weekendRatio * 100)}%
                                  </span>
                                  <span title="Spätschichten-Anteil">
                                    <Moon className="h-2.5 w-2.5 inline mr-0.5" />
                                    {Math.round(f.eveningRatio * 100)}%
                                  </span>
                                  <span title="Früh- und Spätschichten gesamt">
                                    <Sunrise className="h-2.5 w-2.5 inline mr-0.5" />
                                    {f.totalShiftsWorked}
                                  </span>
                                </div>
                              )}
                            </div>
                            {/* Week rows */}
                            <div className="space-y-0.5">
                              {/* Header row */}
                              <div className="grid text-[9px] text-muted-foreground font-medium px-1"
                                style={{ gridTemplateColumns: hasActual ? '1fr 2.5rem 2.5rem 2.5rem 3rem' : '1fr 2.5rem 2.5rem 3rem' }}
                              >
                                <span>Woche</span>
                                <span className="text-right">Soll</span>
                                <span className="text-right">Plan</span>
                                {hasActual && <span className="text-right">Ist</span>}
                                <span className="text-right">Abw.</span>
                              </div>
                              {f.weeklyBreakdown.map(w => {
                                const devClass = deviationColorClass(w.plannedDeviation);
                                const actDevClass = w.actualDeviation !== null ? deviationColorClass(w.actualDeviation) : '';
                                return (
                                  <div
                                    key={w.weekStart}
                                    className="grid items-center px-1 py-0.5 rounded text-[10px] hover:bg-muted/40 transition-colors"
                                    style={{ gridTemplateColumns: hasActual ? '1fr 2.5rem 2.5rem 2.5rem 3rem' : '1fr 2.5rem 2.5rem 3rem' }}
                                  >
                                    <span className="text-muted-foreground truncate pr-1" title={w.weekLabel}>
                                      {w.weekLabel}
                                      {w.isPartialWeek && <span className="opacity-60"> *</span>}
                                    </span>
                                    <span className="text-right text-muted-foreground">{w.targetHours}h</span>
                                    <span className={cn('text-right font-medium', devClass)}>
                                      {w.plannedHours.toFixed(1)}h
                                    </span>
                                    {hasActual && (
                                      <span className={cn('text-right font-medium', w.actualHours !== null ? actDevClass : 'text-muted-foreground')}>
                                        {w.actualHours !== null ? `${w.actualHours.toFixed(1)}h` : '—'}
                                      </span>
                                    )}
                                    <span className={cn('text-right font-semibold', devClass)}>
                                      {deviationSign(w.plannedDeviation)}
                                    </span>
                                  </div>
                                );
                              })}
                              {/* Partial week note */}
                              {f.weeklyBreakdown.some(w => w.isPartialWeek) && (
                                <p className="text-[8px] text-muted-foreground px-1 pt-0.5">
                                  * Randwoche — weniger als 7 Tage in dieser Periode
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    {filtered.every(f => !f.weeklyBreakdown.some(w => w.targetHours > 0)) && (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        Keine Wochenstunden-Ziele hinterlegt. Bitte Wochenstunden im Personalstamm eintragen.
                      </p>
                    )}
                  </div>
                )}

                {filtered.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Keine Mitarbeitenden für diese Abteilung gefunden.
                  </p>
                )}
              </>
            );
          })()}

          {/* Ignorierte umschalten — only for non-fairness tabs */}
          {tab !== 'fairness' && (
          <button
            onClick={() => setShowIgnored(v => !v)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showIgnored ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showIgnored ? 'Ignorierte ausblenden' : 'Ignorierte anzeigen'}
          </button>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Saldo = Vortrag + Monat-Δ · Streichen nur bei verfügbarem Ersatz aktiv
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  );
}
