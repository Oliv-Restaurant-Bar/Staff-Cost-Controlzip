/**
 * ModernScheduleGrid — Phase 2 visual redesign.
 *
 * DATA LOGIC IS IDENTICAL to ScheduleGrid:
 *   - same DaySchedule / TimeSlot types
 *   - same primarySlot / secondarySlot selection logic
 *   - same TimeInputCell for all editing
 *   - same onSlotChange callback signature
 *   - same availability map, pattern warnings, copy/color tools
 *
 * ONLY presentation changed (Phase 2):
 *   - compact row height (more employees visible)
 *   - sticky header + sticky employee column
 *   - refined chips via tighter cell containers
 *   - weekly summary column on the right
 *   - weekend / today column tints
 *   - refined employee column (name + hours + warning)
 *   - laptop-optimised column widths
 */

import { useMemo, useState, useRef, useCallback } from 'react';
import {
  format, isWeekend, isSunday, isSameDay,
  parseISO, isAfter, getDay,
} from 'date-fns';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { TimeInputCell } from './TimeInputCell';
import { TimeSlot, DaySchedule } from './ScheduleGrid';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { PatternWarning } from '@/lib/pattern-warnings';
import { buildAvailabilityMap } from '@/lib/availability-store';
import { cn } from '@/lib/utils';
import { dailyTotalsVisibility, type DailyTotalsDisplay } from '@/lib/schedule-daily-totals';
import type { DayStaffingSummaryResult } from '@/lib/staffing-comparison-utils';
import { DayStaffingBadge } from './DayStaffingBadge';
import type { DayPlanHints } from '@/lib/staffing-day-hints';
import { AlertTriangle, CalendarOff, Copy, ClipboardPaste, X } from 'lucide-react';

// ── Shared cell-clipboard type (also used by SchedulePlanner) ─────────────────
export interface CopiedCell {
  primary: { start: string; end: string } | null;
  secondary: { start: string; end: string } | null;
  absence: string | null;
  /** Manuelle Pause der Früh-Schicht in Minuten (null = Automatik) — wird mitkopiert */
  fruehBreakMinutes?: number | null;
  /** Manuelle Pause der Spät-Schicht in Minuten (null = Automatik) — wird mitkopiert */
  spaetBreakMinutes?: number | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const WEEKDAY_MAP: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3,
  donnerstag: 4, freitag: 5, samstag: 6,
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ModernScheduleGridProps {
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  onSlotChange: (
    employeeId: string,
    date: string,
    slotType: 'früh' | 'spät',
    value: TimeSlot | null,
    absenceType?: string | null,
    breakMinutes?: number | null,
  ) => void;
  getEmployeeHours: (employeeId: string) => number;
  getTargetHours: (employee: Employee) => number;
  getWeeklyHours?: (employeeId: string, weekEndDate: Date) => number;
  getWeeklyTargetHours?: (employee: Employee) => number;
  patternWarnings?: PatternWarning[];
  copiedShift?: TimeSlot | null;
  onCopyShift?: (slot: TimeSlot) => void;
  cellColors?: Record<string, string>;
  onCellColorChange?: (key: string, color: string | null) => void;
  showDepartmentBadge?: boolean;
  onCopyToIst?: (
    employeeId: string,
    date: string,
    slotType: 'früh' | 'spät',
    slot: TimeSlot,
  ) => void;
  onEmployeeClick?: (employee: Employee) => void;
  onConfigureDaysOff?: (employee: Employee) => void;
  externalActiveTool?: string | null;
  highlightedEmployeeId?: string | null;
  // ── Phase 1B: quick copy/paste/clear ──────────────────────────────────────
  copiedCell?: CopiedCell | null;
  onCopyCell?: (empId: string, dateStr: string) => void;
  onPasteCell?: (empId: string, dateStr: string) => void;
  onClearCell?: (empId: string, dateStr: string) => void;
  // ── Phase 1B: employee-week copy ──────────────────────────────────────────
  onCopyWeek?: (empId: string) => void;
  onPasteWeek?: (empId: string) => void;
  hasCopiedWeek?: boolean;
  // ── Phase 1B: multi-plan stamp mode ───────────────────────────────────────
  multiPlanMode?: boolean;
  multiPlanPreset?: { label: string; start: string; end: string; start2?: string; end2?: string; absenceCode?: string } | null;
  onMultiPlanCell?: (empId: string, dateStr: string) => void;
  stickyHeader?: boolean;
  onAdditionalCostPlanChange?: (empId: string, date: string, v: boolean) => void;
  // ── Kueche-Manager: per-day manager-safe header totals ────────────────────
  // When true, the day header shows planned hours + expected revenue + a
  // personnel-cost ratio (%) + an over-target indicator — but NEVER any CHF
  // cost or individual wages. Only set for the kitchen manager; admin/service
  // leave it false so the header is exactly as before.
  managerSafeTotals?: boolean;
  dailyManagerTotals?: Record<string, DailyTotalsDisplay>;
  // ── Personalbedarf-Abgleich: kompakte Soll/Ist-Badges im Tageskopf ─────────
  // `${yyyy-MM-dd}` → Tages-Zusammenfassung (bereits rollen-gescopt berechnet).
  // Nur Anzeige; Tage ohne Bedarf haben keinen Eintrag/kein Badge.
  dayStaffingSummaries?: Record<string, DayStaffingSummaryResult>;
  // ── Live-Hinweis «Plan vs. Bedarf» (Kopfzahl-Logik, identisch Wochenmatrix):
  // `${yyyy-MM-dd}` → Tages-Hinweise (je Position + Summen + Warnungen).
  dayPlanHints?: Record<string, DayPlanHints>;
}

// ── Small helper: format a numeric diff as +x.x / −x.x ───────────────────────

function fmtDiff(diff: number): string {
  const abs = Math.abs(diff).toFixed(1);
  return diff >= 0 ? `+${abs}` : `−${abs}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ModernScheduleGrid({
  employees,
  days,
  scheduleData,
  onSlotChange,
  getEmployeeHours,
  getTargetHours,
  patternWarnings = [],
  copiedShift,
  onCopyShift,
  cellColors = {},
  onCellColorChange,
  showDepartmentBadge,
  onCopyToIst,
  onEmployeeClick,
  onConfigureDaysOff,
  externalActiveTool,
  highlightedEmployeeId,
  copiedCell,
  onCopyCell,
  onPasteCell,
  onClearCell,
  onCopyWeek,
  onPasteWeek,
  hasCopiedWeek = false,
  multiPlanMode = false,
  multiPlanPreset,
  onMultiPlanCell,
  stickyHeader = true,
  onAdditionalCostPlanChange,
  managerSafeTotals = false,
  dailyManagerTotals,
  dayStaffingSummaries,
  dayPlanHints,
}: ModernScheduleGridProps) {

  const today = useMemo(() => new Date(), []);

  // Visibility matrix for the per-day header totals (manager vs full).
  const totalsVis = dailyTotalsVisibility(managerSafeTotals ? 'manager' : 'full');

  const empIds   = useMemo(() => employees.map(e => e.id), [employees]);
  const dateStrs = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);

  const availabilityMap = useMemo(
    () => buildAvailabilityMap(empIds, dateStrs),
    [empIds, dateStrs],
  );

  // Pre-compute per-day metadata for headers (weekend / today)
  const dayMeta = useMemo(() => days.map(day => ({
    day,
    dateStr:    format(day, 'yyyy-MM-dd'),
    isWknd:     isWeekend(day),
    isSun:      isSunday(day),
    isToday:    isSameDay(day, today),
    weekdayIdx: getDay(day),
  })), [days, today]);

  // Pre-compute total planned NET hours per day for header display
  // (SSoT calculateDayNetHours — Pause pro Einsatz abgezogen, nie Brutto).
  const dayTotals = useMemo(() => {
    return dayMeta.reduce<Record<string, number>>((acc, { dateStr }) => {
      acc[dateStr] = employees.reduce((sum, emp) => {
        const ds: DaySchedule = scheduleData[`${emp.id}-${dateStr}`] || {};
        return sum + calculateDayNetHours(ds);
      }, 0);
      return acc;
    }, {});
  }, [dayMeta, employees, scheduleData]);

  // ── Resizable employee column ────────────────────────────────────────────────
  const LS_COL_KEY = 'schedule_emp_col_width';
  const MIN_COL    = 100;
  const MAX_COL    = 320;
  const DEFAULT_COL = 148;

  const [colWidth, setColWidth] = useState<number>(() => {
    const saved = localStorage.getItem(LS_COL_KEY);
    const n = saved ? parseInt(saved, 10) : NaN;
    return isNaN(n) ? DEFAULT_COL : Math.min(MAX_COL, Math.max(MIN_COL, n));
  });

  const dragState = useRef<{ startX: number; startW: number } | null>(null);

  const onDragPointerMove = useCallback((e: PointerEvent) => {
    if (!dragState.current) return;
    const delta = e.clientX - dragState.current.startX;
    const next  = Math.min(MAX_COL, Math.max(MIN_COL, dragState.current.startW + delta));
    setColWidth(next);
  }, []);

  const onDragPointerUp = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    document.removeEventListener('pointermove', onDragPointerMove);
    document.removeEventListener('pointerup',   onDragPointerUp);
    document.body.style.userSelect = '';
    document.body.style.cursor     = '';
    setColWidth(w => { localStorage.setItem(LS_COL_KEY, String(w)); return w; });
  }, [onDragPointerMove]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: colWidth };
    document.addEventListener('pointermove', onDragPointerMove);
    document.addEventListener('pointerup',   onDragPointerUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor     = 'col-resize';
  }, [colWidth, onDragPointerMove, onDragPointerUp]);

  const empColStyle = { width: colWidth, minWidth: colWidth, maxWidth: colWidth } as const;

  return (
    <table
      className="border-separate min-w-max w-full"
      style={{ borderSpacing: 0 }}
    >

      {/* ══════════════════════════════════════════════════════════════════
          THEAD — sticky so it stays visible while scrolling vertically
      ══════════════════════════════════════════════════════════════════ */}
      <thead className={stickyHeader ? "sticky top-0 z-30" : ""}>
          <tr>

            {/* ── Employee column header ─────────────────────────────────── */}
            <th
              className={cn(
                "sticky left-0 z-40 bg-card",
                "px-3 py-2 text-left relative overflow-visible",
                "border-b-2 border-r border-border/40",
                "shadow-[2px_0_6px_-3px_rgba(0,0,0,0.1)]",
              )}
              style={empColStyle}
            >
              <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                Mitarbeiter
              </span>

              {/* ── Drag handle ── */}
              <div
                onPointerDown={startDrag}
                title="Spaltenbreite anpassen"
                className={cn(
                  "absolute top-0 right-0 h-full w-1.5 cursor-col-resize z-50",
                  "flex items-center justify-center group/handle",
                  "hover:bg-primary/20 transition-colors",
                )}
              >
                <div className="w-px h-4 bg-border/60 group-hover/handle:bg-primary/60 transition-colors rounded-full" />
              </div>
            </th>

            {/* ── Day headers ───────────────────────────────────────────── */}
            {dayMeta.map(({ day, dateStr, isWknd, isSun, isToday, weekdayIdx }, idx) => (
              <th
                key={day.toISOString()}
                className={cn(
                  "px-0.5 py-1.5 border-b-2 border-border/40 select-none",
                  "min-w-[96px]",
                  idx < days.length - 1 && "border-r border-border/15",
                  isToday
                    ? "bg-blue-50/70 dark:bg-blue-950/25 border-b-blue-300 dark:border-b-blue-700"
                    : isSun
                      ? "bg-amber-50/60 dark:bg-amber-950/15"
                      : isWknd
                        ? "bg-amber-50/40 dark:bg-amber-950/10"
                        : "bg-card",
                )}
              >
                <div className="flex flex-col items-center gap-0">

                  {/* Weekday label */}
                  <span className={cn(
                    "text-[9px] font-bold uppercase tracking-widest leading-none",
                    isToday  && "text-blue-500 dark:text-blue-400",
                    !isToday && isWknd && "text-amber-500 dark:text-amber-400",
                    !isToday && !isWknd && "text-muted-foreground/50",
                  )}>
                    {WEEKDAY_SHORT[weekdayIdx]}
                  </span>

                  {/* Date number */}
                  <div className="relative mt-0.5">
                    <span className={cn(
                      "text-[18px] font-bold leading-none",
                      isToday  && "text-blue-700 dark:text-blue-300",
                      !isToday && isWknd && "text-amber-700 dark:text-amber-300",
                      !isToday && !isWknd && "text-foreground/85",
                    )}>
                      {format(day, 'd')}
                    </span>
                    {isToday && (
                      <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-0.5 rounded-full bg-blue-500/70" />
                    )}
                  </div>

                  {/* Month abbrev */}
                  <span className={cn(
                    "text-[8px] mt-1.5 leading-none",
                    isToday  && "text-blue-400/70 dark:text-blue-500/60",
                    !isToday && isWknd && "text-amber-400/70 dark:text-amber-500/60",
                    !isToday && !isWknd && "text-muted-foreground/35",
                  )}>
                    {format(day, 'MMM')}
                  </span>

                  {/* Per-day totals: manager-safe block for the kitchen manager,
                      otherwise the unchanged gross planned-hours line. */}
                  {(() => {
                    const ds = format(day, 'yyyy-MM-dd');

                    // ── Kueche-Manager: net hours + revenue + cost ratio ──────
                    if (managerSafeTotals) {
                      const t = dailyManagerTotals?.[ds];
                      if (!t) return null;
                      return (
                        <div className="flex flex-col items-center gap-0.5 mt-1 leading-none">
                          {totalsVis.showHours && t.plannedHours > 0 && (
                            <span className="text-[8px] tabular-nums font-medium text-muted-foreground/40">
                              {t.plannedHours.toFixed(1)}h
                            </span>
                          )}
                          {totalsVis.showRevenue && t.revenue > 0 && (
                            <span className="text-[8px] tabular-nums text-muted-foreground/55">
                              CHF {Math.round(t.revenue).toLocaleString('de-CH')}
                            </span>
                          )}
                          {totalsVis.showRatio && (
                            t.laborCostRatio != null ? (
                              <span className={cn(
                                "inline-flex items-center gap-0.5 text-[9px] tabular-nums font-semibold",
                                t.isOverTarget
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-emerald-600 dark:text-emerald-400",
                              )}>
                                {totalsVis.showTargetIndicator && t.isOverTarget && (
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                )}
                                {Math.round(t.laborCostRatio)}%
                              </span>
                            ) : (
                              <span className="text-[9px] tabular-nums text-muted-foreground/30">–</span>
                            )
                          )}
                        </div>
                      );
                    }

                    // ── Admin / service ('full' mode): unchanged hours line ───
                    const tot = dayTotals[ds] ?? 0;
                    return tot > 0 ? (
                      <span className={cn(
                        "text-[8px] mt-1 leading-none tabular-nums font-medium",
                        isToday  && "text-blue-500/60 dark:text-blue-400/50",
                        !isToday && isWknd && "text-amber-500/50 dark:text-amber-400/40",
                        !isToday && !isWknd && "text-muted-foreground/30",
                      )}>
                        {tot.toFixed(1)}h
                      </span>
                    ) : null;
                  })()}

                  {/* ── Personalbedarf Soll/Ist-Badge (nur Anzeige) ──────── */}
                  {dayStaffingSummaries?.[dateStr] && (
                    <DayStaffingBadge
                      summary={dayStaffingSummaries[dateStr]}
                      hints={dayPlanHints?.[dateStr]}
                      dateLabel={`${WEEKDAY_SHORT[weekdayIdx]}, ${format(day, 'dd.MM.')}`}
                      date={dateStr}
                    />
                  )}
                </div>
              </th>
            ))}

            {/* ── Summary column header ──────────────────────────────────── */}
            <th
              className={cn(
                "px-2 py-2 border-b-2 border-l border-border/40 bg-card",
                "min-w-[72px] w-[72px] text-right",
              )}
            >
              <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                Std
              </span>
            </th>
          </tr>
        </thead>

        {/* ══════════════════════════════════════════════════════════════════
            TBODY
        ══════════════════════════════════════════════════════════════════ */}
        <tbody>
          {employees.map((employee) => {
            const plannedHours  = getEmployeeHours(employee.id);
            const targetHours   = getTargetHours(employee);
            const diff          = plannedHours - targetHours;
            const isOver        = diff > 2;
            const isUnder       = diff < -2;
            const isBalanced    = !isOver && !isUnder;
            const empWarnings   = patternWarnings.filter(w => w.empId === employee.id);
            const hasCritical   = empWarnings.some(w => w.severity === 'critical');
            const hasWarning    = empWarnings.length > 0;
            const isHighlighted = highlightedEmployeeId === employee.id;

            return (
              <tr
                key={employee.id}
                className={cn(
                  "group transition-colors duration-100",
                  isHighlighted
                    ? "bg-indigo-50/50 dark:bg-indigo-950/20"
                    : hasCritical
                      ? "bg-red-50/10 dark:bg-red-950/5 hover:bg-red-50/20"
                      : "hover:bg-muted/15",
                )}
              >
                {/* ── Employee name cell (sticky left) ───────────────────── */}
                <td
                  className={cn(
                    "sticky left-0 z-10 bg-card group-hover:bg-muted/30 transition-colors",
                    "px-2.5 py-1 border-b border-r border-border/25",
                    "shadow-[2px_0_6px_-3px_rgba(0,0,0,0.07)]",
                    isHighlighted && "bg-indigo-50/50 dark:bg-indigo-950/20 group-hover:bg-indigo-50/70",
                    hasCritical   && !isHighlighted && "bg-red-50/10 dark:bg-red-950/5 group-hover:bg-red-50/20",
                  )}
                  style={empColStyle}
                >
                  <div className="flex items-center gap-1.5 min-w-0">

                    {/* Department dot */}
                    {showDepartmentBadge && (
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full shrink-0",
                        employee.department === 'service'
                          ? "bg-blue-400/80"
                          : "bg-orange-400/80",
                      )} />
                    )}

                    {/* Name + hours */}
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          "font-semibold text-[13px] text-foreground/90 truncate leading-snug",
                          onEmployeeClick && "cursor-pointer hover:text-primary transition-colors",
                        )}
                        title={onEmployeeClick ? 'Details anzeigen' : undefined}
                        onClick={onEmployeeClick
                          ? (e) => { e.stopPropagation(); onEmployeeClick(employee); }
                          : undefined}
                      >
                        {getEmployeeDisplayName(employee)}
                      </div>
                      <div className={cn(
                        "text-[10px] tabular-nums leading-none mt-0.5",
                        isOver     && "text-red-500/80 dark:text-red-400/70",
                        isUnder    && "text-amber-500/80 dark:text-amber-400/70",
                        isBalanced && "text-emerald-500/70 dark:text-emerald-400/60",
                      )}>
                        {plannedHours.toFixed(1)}&thinsp;/&thinsp;{targetHours.toFixed(0)}&thinsp;h
                      </div>
                    </div>

                    {/* Days-off config button — matches classic view behaviour */}
                    {onConfigureDaysOff && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onConfigureDaysOff(employee); }}
                        title={
                          employee.daysOff?.length
                            ? `${employee.daysOff.length} Ruhetag${employee.daysOff.length !== 1 ? 'e' : ''}/Wo. – klicken zum Bearbeiten`
                            : 'Ruhetage konfigurieren'
                        }
                        className={cn(
                          "shrink-0 h-5 w-5 flex items-center justify-center rounded transition-colors",
                          "hover:bg-muted/60",
                          employee.daysOff?.length
                            ? "opacity-60 text-primary"
                            : "opacity-0 group-hover:opacity-40 text-muted-foreground",
                        )}
                      >
                        <CalendarOff className="h-3 w-3" />
                      </button>
                    )}

                    {/* Copy-week button */}
                    {onCopyWeek && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onCopyWeek(employee.id); }}
                        title="Woche kopieren"
                        className={cn(
                          "shrink-0 h-5 w-5 flex items-center justify-center rounded transition-all",
                          "opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:bg-muted/60 text-muted-foreground",
                        )}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    )}

                    {/* Paste-week button — only visible when clipboard has a week */}
                    {onPasteWeek && hasCopiedWeek && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onPasteWeek(employee.id); }}
                        title="Kopiierte Woche hier einfügen"
                        className="shrink-0 h-5 w-5 flex items-center justify-center rounded transition-colors text-primary opacity-70 hover:opacity-100 hover:bg-primary/10"
                      >
                        <ClipboardPaste className="h-3 w-3" />
                      </button>
                    )}

                    {/* Warning icon */}
                    {hasWarning && (
                      <AlertTriangle className={cn(
                        "h-3 w-3 shrink-0",
                        hasCritical
                          ? "text-red-400/90 dark:text-red-500/80"
                          : "text-amber-400/80 dark:text-amber-500/70",
                      )} />
                    )}
                  </div>
                </td>

                {/* ── Day cells ─────────────────────────────────────────── */}
                {dayMeta.map(({ day, dateStr, isWknd, isSun, isToday }, idx) => {
                  const daySchedule: DaySchedule = scheduleData[`${employee.id}-${dateStr}`] || {};

                  const isDayOff = (employee.daysOff ?? []).some(
                    d => WEEKDAY_MAP[d] === getDay(day),
                  );
                  const exitDate     = employee.employmentEndDate
                    ? parseISO(employee.employmentEndDate) : null;
                  const isAfterExit  = exitDate ? isAfter(day, exitDate) : false;

                  const availKey  = `${employee.id}-${dateStr}`;
                  const avail     = availabilityMap[availKey] ?? 'normal';
                  const isReqFree = avail === 'requested-free';
                  const isBlocked = avail === 'blocked';

                  // Same slot-selection logic as ScheduleGrid
                  const primarySlot: 'früh' | 'spät' =
                    daySchedule.früh || daySchedule.frühAbsence ? 'früh' : 'spät';
                  const secondarySlot: 'früh' | 'spät' =
                    primarySlot === 'früh' ? 'spät' : 'früh';
                  const primaryAbsence =
                    (primarySlot   === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ||
                    (secondarySlot === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ||
                    null;

                  const frühKey   = `${employee.id}-${dateStr}-früh`;
                  const spätKey   = `${employee.id}-${dateStr}-spät`;
                  const frühColor = cellColors[frühKey] ?? null;
                  const spätColor = cellColors[spätKey] ?? null;

                  const cellHasData = !!(
                    daySchedule.früh || daySchedule.spät ||
                    daySchedule.frühAbsence || daySchedule.spätAbsence
                  );

                  return (
                    <td
                      key={dateStr}
                      className={cn(
                        "px-1 py-0.5 border-b border-border/20 align-middle transition-colors relative group/cell",
                        idx < days.length - 1 && "border-r border-border/10",
                        // Column tints
                        !isDayOff && !isAfterExit && isToday
                          && "bg-blue-50/40 dark:bg-blue-950/15",
                        !isDayOff && !isAfterExit && !isToday && isSun
                          && "bg-amber-50/40 dark:bg-amber-900/10",
                        !isDayOff && !isAfterExit && !isToday && !isSun && isWknd
                          && "bg-amber-50/25 dark:bg-amber-900/6",
                        isDayOff   && !isAfterExit && "bg-slate-100/70 dark:bg-slate-700/25",
                        isAfterExit && "bg-zinc-100/50 dark:bg-zinc-800/30",
                        // Multi-plan cursor
                        multiPlanMode && multiPlanPreset && !isAfterExit && "cursor-crosshair",
                      )}
                    >
                      {isAfterExit ? (
                        <div className="flex items-center justify-center h-9">
                          <span className="text-muted-foreground/20 text-sm select-none">—</span>
                        </div>
                      ) : (
                        <div className="relative">
                          {/* ── Multi-plan stamp overlay ── */}
                          {multiPlanMode && multiPlanPreset && (
                            <div
                              className="absolute inset-0 z-20 rounded-lg"
                              onClick={(e) => {
                                e.stopPropagation();
                                onMultiPlanCell?.(employee.id, dateStr);
                              }}
                            />
                          )}

                          <TimeInputCell
                            value={daySchedule[primarySlot] ?? null}
                            absenceType={primaryAbsence}
                            onChange={(val, absence, breakMin) =>
                              onSlotChange(employee.id, dateStr, primarySlot, val, absence, breakMin)
                            }
                            slotType={primarySlot}
                            secondaryValue={daySchedule[secondarySlot] ?? null}
                            breakMinutes={
                              (primarySlot === 'früh'
                                ? daySchedule.fruehBreakMinutes ?? daySchedule.breakMinutes
                                : daySchedule.spaetBreakMinutes) ?? null
                            }
                            onBreakMinutesChange={(v) =>
                              onSlotChange(
                                employee.id, dateStr, primarySlot,
                                daySchedule[primarySlot] ?? null,
                                (primarySlot === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ?? null,
                                v,
                              )
                            }
                            secondaryBreakMinutes={
                              (secondarySlot === 'früh'
                                ? daySchedule.fruehBreakMinutes ?? daySchedule.breakMinutes
                                : daySchedule.spaetBreakMinutes) ?? null
                            }
                            onSecondaryBreakMinutesChange={(v) =>
                              onSlotChange(
                                employee.id, dateStr, secondarySlot,
                                daySchedule[secondarySlot] ?? null,
                                (secondarySlot === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ?? null,
                                v,
                              )
                            }
                            onSplitTimeSelect={(sec, breakMin) =>
                              onSlotChange(employee.id, dateStr, secondarySlot, sec, null, breakMin)
                            }
                            onClearSecondary={() =>
                              onSlotChange(employee.id, dateStr, secondarySlot, null, null)
                            }
                            isWeekend={isWknd}
                            isDayOff={isDayOff}
                            isRequestedFree={isReqFree}
                            isBlocked={isBlocked}
                            activeTool={externalActiveTool}
                            copiedShift={copiedShift}
                            onCopyShift={onCopyShift}
                            cellColor={frühColor || spätColor}
                            onCellColorChange={
                              onCellColorChange
                                ? (c) => onCellColorChange(frühKey, c)
                                : undefined
                            }
                            onCopyToIst={
                              onCopyToIst
                                ? (slot) => onCopyToIst(employee.id, dateStr, primarySlot, slot)
                                : undefined
                            }
                            isFixedEmployee={
                              ((employee.employmentType === 'vollzeit' || employee.employmentType === 'teilzeit' ||
                                employee.employmentType === 'Vollzeit' || employee.employmentType === 'Teilzeit' ||
                                employee.employmentType === 'full_time' || employee.employmentType === 'part_time')
                               || (employee.monthlySalary ?? 0) > 0)
                              && (employee.monthlySalary ?? 0) > 0
                            }
                            isAdditionalCostPlan={daySchedule.isAdditionalCostPlan ?? false}
                            onAdditionalCostPlanChange={
                              onAdditionalCostPlanChange
                                ? (v) => onAdditionalCostPlanChange(employee.id, dateStr, v)
                                : undefined
                            }
                          />

                          {/* ── Hover quick-action tray ── */}
                          {!multiPlanMode && (onCopyCell || onPasteCell || onClearCell) && (
                            <div className={cn(
                              "absolute -top-px right-0 hidden group-hover/cell:flex items-center z-30",
                              "bg-background/95 backdrop-blur-sm border border-border/60 rounded shadow-sm",
                            )}>
                              {onCopyCell && (
                                <button
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); onCopyCell(employee.id, dateStr); }}
                                  title="Zelle kopieren"
                                  className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                                >
                                  <Copy className="h-2.5 w-2.5" />
                                </button>
                              )}
                              {onPasteCell && copiedCell && (
                                <button
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); onPasteCell(employee.id, dateStr); }}
                                  title="Zelle einfügen"
                                  className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                                >
                                  <ClipboardPaste className="h-2.5 w-2.5" />
                                </button>
                              )}
                              {onClearCell && cellHasData && (
                                <button
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => { e.stopPropagation(); onClearCell(employee.id, dateStr); }}
                                  title="Zelle leeren"
                                  className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                  <X className="h-2.5 w-2.5" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}

                {/* ── Summary cell (right) ───────────────────────────────── */}
                <td
                  className={cn(
                    "px-2 py-1 border-b border-l border-border/25 text-right align-middle",
                    "bg-card group-hover:bg-muted/15 transition-colors",
                    isHighlighted && "bg-indigo-50/30 dark:bg-indigo-950/10",
                  )}
                >
                  <div className="flex flex-col items-end gap-0">
                    <span className="text-[11px] font-semibold tabular-nums text-foreground/80 leading-snug">
                      {plannedHours.toFixed(1)}
                    </span>
                    <span className={cn(
                      "text-[9px] tabular-nums font-medium leading-none",
                      isOver     && "text-red-500/80 dark:text-red-400/70",
                      isUnder    && "text-amber-500/80 dark:text-amber-400/70",
                      isBalanced && "text-muted-foreground/40",
                    )}>
                      {fmtDiff(diff)}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>

        {/* ── Footer totals row ───────────────────────────────────────────── */}
        {employees.length > 0 && (
          <tfoot className="sticky bottom-0 z-20">
            <tr>
              <td
                className={cn(
                  "sticky left-0 z-30 bg-card/95 backdrop-blur-sm",
                  "px-2.5 py-1.5 border-t-2 border-r border-border/40",
                  "shadow-[2px_0_6px_-3px_rgba(0,0,0,0.07)]",
                )}
              >
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
                  Total
                </span>
              </td>

              {/* Day totals */}
              {dayMeta.map(({ day, dateStr, isWknd, isSun, isToday }, idx) => {
                // Netto-Tagestotal (SSoT calculateDayNetHours) — identisch zum Header
                const dayTotal = dayTotals[dateStr] ?? 0;

                return (
                  <td
                    key={dateStr}
                    className={cn(
                      "px-1 py-1.5 border-t-2 border-border/40 text-center",
                      idx < days.length - 1 && "border-r border-border/10",
                      isToday && "bg-blue-50/40 dark:bg-blue-950/15",
                      !isToday && isSun  && "bg-amber-50/50 dark:bg-amber-950/12",
                      !isToday && !isSun && isWknd && "bg-amber-50/30 dark:bg-amber-950/8",
                      !isToday && !isWknd && "bg-card/95",
                    )}
                    style={{ backdropFilter: 'blur(4px)' }}
                  >
                    {dayTotal > 0 ? (
                      <span className="text-[10px] font-semibold tabular-nums text-foreground/60">
                        {dayTotal.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/20 text-[10px]">—</span>
                    )}
                  </td>
                );
              })}

              {/* Grand total */}
              <td
                className={cn(
                  "px-2 py-1.5 border-t-2 border-l border-border/40 text-right",
                  "bg-card/95 backdrop-blur-sm",
                )}
              >
                <span className="text-[11px] font-bold tabular-nums text-foreground/70">
                  {employees.reduce((s, e) => s + getEmployeeHours(e.id), 0).toFixed(1)}
                </span>
              </td>
            </tr>
          </tfoot>
        )}

    </table>
  );
}
