/**
 * ModernScheduleGrid — visual-only redesign of the classic ScheduleGrid.
 *
 * DATA LOGIC IS IDENTICAL to ScheduleGrid:
 *   - same DaySchedule / TimeSlot types (imported from ScheduleGrid)
 *   - same primarySlot / secondarySlot selection logic
 *   - same TimeInputCell for all editing
 *   - same onSlotChange callback signature
 *
 * Only presentation changes: card layout, modern day headers, cleaner chips,
 * no Excel-style borders, sticky employee column, better whitespace.
 */

import { useMemo } from 'react';
import { format, isWeekend, isSunday, isSameDay, parseISO, isAfter, getDay } from 'date-fns';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { TimeInputCell } from './TimeInputCell';
import { TimeSlot, DaySchedule } from './ScheduleGrid';
import { PatternWarning } from '@/lib/pattern-warnings';
import { buildAvailabilityMap } from '@/lib/availability-store';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';

// ── Constants ────────────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTH_SHORT   = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const WEEKDAY_MAP: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3,
  donnerstag: 4, freitag: 5, samstag: 6,
};

// ── Props ────────────────────────────────────────────────────────────────────

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
  externalActiveTool?: string | null;
  highlightedEmployeeId?: string | null;
}

// ── Component ────────────────────────────────────────────────────────────────

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
  externalActiveTool,
  highlightedEmployeeId,
}: ModernScheduleGridProps) {

  const today = useMemo(() => new Date(), []);

  const empIds   = useMemo(() => employees.map(e => e.id), [employees]);
  const dateStrs = useMemo(() => days.map(d => format(d, 'yyyy-MM-dd')), [days]);
  const availabilityMap = useMemo(
    () => buildAvailabilityMap(empIds, dateStrs),
    [empIds, dateStrs],
  );

  return (
    <div className="overflow-x-auto rounded-xl">
      <table
        className="border-separate w-full"
        style={{ borderSpacing: 0 }}
      >
        {/* ── THEAD ─────────────────────────────────────────────────────── */}
        <thead>
          <tr>
            {/* Employee column header */}
            <th
              className={cn(
                "sticky left-0 z-20 bg-card/95 backdrop-blur-sm",
                "px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground",
                "border-b border-r border-border/30",
                "shadow-[2px_0_8px_-4px_rgba(0,0,0,0.08)]",
                "min-w-[170px] w-[170px]",
              )}
            >
              Mitarbeiter
            </th>

            {/* Day headers */}
            {days.map((day, idx) => {
              const isWeekendDay = isWeekend(day);
              const isSundayDay  = isSunday(day);
              const isToday      = isSameDay(day, today);
              return (
                <th
                  key={day.toISOString()}
                  className={cn(
                    "px-1 py-2.5 border-b border-border/30",
                    "min-w-[110px] select-none",
                    isWeekendDay && !isToday && "bg-amber-50/50 dark:bg-amber-900/10",
                    isSundayDay  && !isToday && "bg-amber-100/50 dark:bg-amber-900/15",
                    isToday && "bg-blue-50/60 dark:bg-blue-950/20",
                    idx < days.length - 1 && "border-r border-border/20",
                  )}
                >
                  <div className="flex flex-col items-center gap-0.5">
                    {/* Weekday abbrev */}
                    <span className={cn(
                      "text-[9px] font-bold uppercase tracking-widest leading-none",
                      isWeekendDay && !isToday && "text-amber-500 dark:text-amber-400",
                      isToday && "text-blue-500 dark:text-blue-400",
                      !isWeekendDay && !isToday && "text-muted-foreground/60",
                    )}>
                      {WEEKDAY_SHORT[getDay(day)]}
                    </span>

                    {/* Date number with today indicator */}
                    <div className="relative flex flex-col items-center">
                      <span className={cn(
                        "text-xl font-bold leading-none",
                        isWeekendDay && !isToday && "text-amber-700 dark:text-amber-300",
                        isToday && "text-blue-700 dark:text-blue-300",
                        !isWeekendDay && !isToday && "text-foreground",
                      )}>
                        {format(day, 'd')}
                      </span>
                      {isToday && (
                        <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-blue-500" />
                      )}
                    </div>

                    {/* Month */}
                    <span className={cn(
                      "text-[9px] mt-1.5 leading-none",
                      isWeekendDay && !isToday && "text-amber-400/80 dark:text-amber-500/70",
                      isToday && "text-blue-400/80 dark:text-blue-500/70",
                      !isWeekendDay && !isToday && "text-muted-foreground/40",
                    )}>
                      {MONTH_SHORT[day.getMonth()]}
                    </span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>

        {/* ── TBODY ─────────────────────────────────────────────────────── */}
        <tbody>
          {employees.map((employee) => {
            const plannedHours = getEmployeeHours(employee.id);
            const targetHours  = getTargetHours(employee);
            const diff         = plannedHours - targetHours;
            const isInRange    = diff >= -2 && diff <= 2;
            const isOver       = diff > 2;
            const empWarnings  = patternWarnings.filter(w => w.empId === employee.id);
            const hasCritical  = empWarnings.some(w => w.severity === 'critical');
            const hasWarning   = empWarnings.length > 0;
            const isHighlighted = highlightedEmployeeId === employee.id;

            return (
              <tr
                key={employee.id}
                className={cn(
                  "group transition-colors",
                  isHighlighted
                    ? "bg-indigo-50/40 dark:bg-indigo-950/15 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-700"
                    : hasCritical
                      ? "bg-red-50/15 dark:bg-red-950/8 hover:bg-red-50/25"
                      : "hover:bg-muted/20",
                )}
              >
                {/* ── Employee name cell — sticky ───────────────────────── */}
                <td
                  className={cn(
                    "sticky left-0 z-10 bg-card group-hover:bg-muted/40 transition-colors",
                    "px-3 py-3 border-b border-r border-border/25",
                    "shadow-[2px_0_8px_-4px_rgba(0,0,0,0.07)]",
                    isHighlighted && "bg-indigo-50/60 dark:bg-indigo-950/20 group-hover:bg-indigo-50/80",
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {showDepartmentBadge && (
                      <span className={cn(
                        "w-2 h-2 rounded-full shrink-0 opacity-80",
                        employee.department === 'service' ? "bg-blue-400" : "bg-orange-400",
                      )} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          "font-semibold text-[13px] text-foreground/90 truncate leading-tight",
                          onEmployeeClick && "cursor-pointer hover:text-primary transition-colors",
                        )}
                        title={onEmployeeClick ? "Details anzeigen" : undefined}
                        onClick={onEmployeeClick ? (e) => { e.stopPropagation(); onEmployeeClick(employee); } : undefined}
                      >
                        {getEmployeeDisplayName(employee)}
                      </div>
                      <div className={cn(
                        "text-[10px] tabular-nums mt-0.5 leading-tight",
                        isOver    ? "text-red-500/70 dark:text-red-400/60"
                        : !isInRange ? "text-amber-500/70 dark:text-amber-400/60"
                        : "text-emerald-500/70 dark:text-emerald-400/60",
                      )}>
                        {plannedHours.toFixed(1)} / {targetHours.toFixed(0)} h
                      </div>
                    </div>
                    {hasWarning && (
                      <AlertTriangle className={cn(
                        "h-3 w-3 shrink-0",
                        hasCritical ? "text-red-400 dark:text-red-500" : "text-amber-400 dark:text-amber-500",
                      )} />
                    )}
                  </div>
                </td>

                {/* ── Day cells ──────────────────────────────────────────── */}
                {days.map((day, idx) => {
                  const dateStr        = format(day, 'yyyy-MM-dd');
                  const daySchedule: DaySchedule = scheduleData[`${employee.id}-${dateStr}`] || {};
                  const isWeekendDay   = isWeekend(day);
                  const isSundayDay    = isSunday(day);
                  const isDayOffCell   = (employee.daysOff ?? []).some(
                    dayName => WEEKDAY_MAP[dayName] === getDay(day),
                  );
                  const exitDate       = employee.employmentEndDate ? parseISO(employee.employmentEndDate) : null;
                  const isAfterExit    = exitDate ? isAfter(day, exitDate) : false;
                  const availStatus    = availabilityMap[`${employee.id}-${dateStr}`] ?? 'normal';
                  const isReqFree      = availStatus === 'requested-free';
                  const isBlocked      = availStatus === 'blocked';

                  // Same primarySlot logic as ScheduleGrid
                  const primarySlot: 'früh' | 'spät' =
                    daySchedule.früh || daySchedule.frühAbsence ? 'früh' : 'spät';
                  const secondarySlot: 'früh' | 'spät' =
                    primarySlot === 'früh' ? 'spät' : 'früh';
                  const primaryAbsence =
                    (primarySlot === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ||
                    (secondarySlot === 'früh' ? daySchedule.frühAbsence : daySchedule.spätAbsence) ||
                    null;

                  const frühKey       = `${employee.id}-${dateStr}-früh`;
                  const spätKey       = `${employee.id}-${dateStr}-spät`;
                  const frühColor     = cellColors[frühKey] ?? null;
                  const spätColor     = cellColors[spätKey] ?? null;

                  return (
                    <td
                      key={dateStr}
                      className={cn(
                        "px-1.5 py-1.5 border-b border-border/20 align-top",
                        idx < days.length - 1 && "border-r border-border/15",
                        isWeekendDay && !isDayOffCell && !isAfterExit && "bg-amber-50/30 dark:bg-amber-900/8",
                        isSundayDay  && !isDayOffCell && !isAfterExit && "bg-amber-50/50 dark:bg-amber-900/12",
                        isDayOffCell && !isAfterExit && "bg-slate-200/60 dark:bg-slate-700/30",
                        isAfterExit  && "bg-zinc-100/60 dark:bg-zinc-800/40",
                      )}
                    >
                      {isAfterExit ? (
                        <div className="flex items-center justify-center min-h-[40px]">
                          <span className="text-muted-foreground/25 text-xs select-none">—</span>
                        </div>
                      ) : (
                        /* ── Identical TimeInputCell usage to ScheduleGrid ── */
                        <TimeInputCell
                          value={daySchedule[primarySlot] ?? null}
                          absenceType={primaryAbsence}
                          onChange={(val, absence) =>
                            onSlotChange(employee.id, dateStr, primarySlot, val, absence)
                          }
                          slotType={primarySlot}
                          secondaryValue={daySchedule[secondarySlot] ?? null}
                          onSplitTimeSelect={(sec) =>
                            onSlotChange(employee.id, dateStr, secondarySlot, sec, null)
                          }
                          onClearSecondary={() =>
                            onSlotChange(employee.id, dateStr, secondarySlot, null, null)
                          }
                          isWeekend={isWeekendDay}
                          isDayOff={isDayOffCell}
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
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
