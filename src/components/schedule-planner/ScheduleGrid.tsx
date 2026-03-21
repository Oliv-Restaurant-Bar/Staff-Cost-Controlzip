// Schedule Grid Component - Updated to use onOpen8HoursDialog
import React, { useState } from 'react';
import { format, isWeekend, getDay, isSunday } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { TimeInputCell } from './TimeInputCell';
import { cn } from '@/lib/utils';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Trash2, CalendarOff, Clock, X, AlertTriangle, TrendingDown, Lightbulb } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useShiftConfig, calculateBreakDeduction } from '@/hooks/useShiftConfig';

export interface TimeSlot {
  start: string;
  end: string;
}

export interface DaySchedule {
  früh?: TimeSlot | null;
  spät?: TimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

interface ScheduleGridProps {
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  onSlotChange: (employeeId: string, date: string, slotType: 'früh' | 'spät', value: TimeSlot | null, absenceType?: string | null) => void;
  onRemoveEmployee: (employeeId: string) => void;
  onConfigureDaysOff: (employee: Employee) => void;
  onOpen8HoursDialog?: (employee: Employee) => void;
  getEmployeeHours: (employeeId: string) => number;
  getTargetHours: (employee: Employee) => number;
  getWeeklyHours?: (employeeId: string, weekEndDate: Date) => number;
  getWeeklyTargetHours?: (employee: Employee) => number;
  onDayClick?: (day: Date) => void;
  showFooter?: boolean;
  showCosts?: boolean;
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  laborCostThreshold?: number;
  /** External paint-tool controlled by parent (activates paint mode from ShiftLegend) */
  externalActiveTool?: string | null;
  /** Notifies parent when internal tool bar changes the active tool */
  onExternalToolChange?: (tool: string | null) => void;
}

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAY_MAP: Record<string, number> = {
  'sonntag': 0,
  'montag': 1,
  'dienstag': 2,
  'mittwoch': 3,
  'donnerstag': 4,
  'freitag': 5,
  'samstag': 6,
};

// Helper to check if a day is a configured day off for an employee
const isDayOff = (employee: Employee, day: Date): boolean => {
  if (!employee.daysOff || employee.daysOff.length === 0) return false;
  const dayOfWeek = getDay(day);
  return employee.daysOff.some(dayName => WEEKDAY_MAP[dayName] === dayOfWeek);
};

// Get indices of Sundays in the days array for weekly sum columns
const getSundayIndices = (days: Date[]): number[] => {
  return days.map((day, idx) => isSunday(day) ? idx : -1).filter(idx => idx !== -1);
};

// Calculate hours for a single time slot
const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Helper to parse time string to minutes since midnight
const timeToMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
};

// Check if shifts overlap (Spät starts before Früh ends)
const hasShiftOverlap = (daySchedule: DaySchedule | undefined): boolean => {
  if (!daySchedule?.früh?.end || !daySchedule?.spät?.start) return false;
  if (daySchedule.frühAbsence || daySchedule.spätAbsence) return false;
  
  const frühEnd = timeToMinutes(daySchedule.früh.end);
  const spätStart = timeToMinutes(daySchedule.spät.start);
  
  return spätStart < frühEnd;
};

// Check if break between shifts is very short (less than 30 min)
const hasShortBreak = (daySchedule: DaySchedule | undefined): boolean => {
  if (!daySchedule?.früh?.end || !daySchedule?.spät?.start) return false;
  if (daySchedule.frühAbsence || daySchedule.spätAbsence) return false;
  
  const frühEnd = timeToMinutes(daySchedule.früh.end);
  const spätStart = timeToMinutes(daySchedule.spät.start);
  
  const gap = spätStart - frühEnd;
  return gap >= 0 && gap < 30;
};

export const ScheduleGrid = ({
  employees,
  days,
  scheduleData,
  onSlotChange,
  onRemoveEmployee,
  onConfigureDaysOff,
  onOpen8HoursDialog,
  getEmployeeHours,
  getTargetHours,
  getWeeklyHours,
  getWeeklyTargetHours,
  onDayClick,
  showFooter = true,
  showCosts = false,
  dailyBudgets = {},
  laborCostThreshold: laborCostThresholdProp,
  externalActiveTool,
  onExternalToolChange,
}: ScheduleGridProps) => {
  const { shiftMap, absenceShifts } = useShiftConfig();
  
  // Use prop if provided (allows per-department threshold), else fall back to localStorage
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const DEFAULT_LABOR_COST_THRESHOLD = 40;
  const laborCostThreshold = laborCostThresholdProp ?? parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || String(DEFAULT_LABOR_COST_THRESHOLD));
  const sundayIndices = getSundayIndices(days);

  // Calculate daily totals including costs and budget comparison
  const getDailyStats = (day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;
    let employeeCount = 0;

    const getAbsenceMeta = (abbrev: string | null | undefined) => {
      if (!abbrev) return null;
      const shiftName = Object.keys(shiftMap).find((k) => shiftMap[k]?.abbrev === abbrev);
      if (!shiftName) return null;
      return {
        hours: shiftMap[shiftName].hours,
        countsToTarget: shiftMap[shiftName].countsToTarget,
        isPaid: shiftMap[shiftName].isPaid,
      };
    };

    employees.forEach((emp) => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];

      if (!daySchedule) return;

      // Work hours (with break deduction)
      const frühHours = calculateSlotHours(daySchedule.früh);
      const spätHours = calculateSlotHours(daySchedule.spät);
      const grossWorkHours = frühHours + spätHours;
      const breakDeduction = calculateBreakDeduction(grossWorkHours);
      const netWorkHours = Math.max(0, grossWorkHours - breakDeduction);

      // Absence hours (only if countsToTarget)
      let absenceCountedHours = 0;
      let absencePaidHours = 0;

      const frühAbs = getAbsenceMeta(daySchedule.frühAbsence);
      const spätAbs = getAbsenceMeta(daySchedule.spätAbsence);

      if (frühAbs?.countsToTarget) {
        absenceCountedHours += frühAbs.hours;
        if (frühAbs.isPaid) absencePaidHours += frühAbs.hours;
      }
      if (spätAbs?.countsToTarget) {
        // Avoid double counting if same code in Früh + Spät
        if (daySchedule.spätAbsence !== daySchedule.frühAbsence) {
          absenceCountedHours += spätAbs.hours;
          if (spätAbs.isPaid) absencePaidHours += spätAbs.hours;
        }
      }

      const dayTotalHours = netWorkHours + absenceCountedHours;

      if (dayTotalHours > 0 || daySchedule.frühAbsence || daySchedule.spätAbsence) {
        employeeCount++;
      }

      totalHours += dayTotalHours;

      // Calculate costs (work hours + paid absences)
      if (emp.hourlyWage) {
        totalCosts += (netWorkHours + absencePaidHours) * emp.hourlyWage;
      }
    });

    // Get planned revenue for this day
    const budget = dailyBudgets[dateStr];
    const plannedRevenue = budget?.plannedRevenue || 0;

    // Calculate labor cost percentage
    const laborCostPercentage = plannedRevenue > 0 ? (totalCosts / plannedRevenue) * 100 : 0;
    const isOverBudget = plannedRevenue > 0 && laborCostPercentage > laborCostThreshold;

    // Calculate how many hours are over budget
    const maxCostsAllowed = plannedRevenue * (laborCostThreshold / 100);
    const excessCosts = totalCosts - maxCostsAllowed;

    // Estimate excess hours based on average hourly wage
    const avgHourlyWage = employees.length > 0
      ? employees.reduce((sum, e) => sum + (e.hourlyWage || 0), 0) / employees.filter(e => e.hourlyWage).length
      : 30;
    const excessHours = avgHourlyWage > 0 ? excessCosts / avgHourlyWage : 0;

    return {
      totalHours,
      totalCosts,
      employeeCount,
      plannedRevenue,
      laborCostPercentage,
      isOverBudget,
      excessHours: Math.max(0, excessHours),
      excessCosts: Math.max(0, excessCosts),
    };
  };

  // Calculate weekly totals including costs and PKQ
  const getWeeklyStats = (weekEndDate: Date) => {
    // Get all days in this week (Monday to Sunday)
    const weekDays = days.filter(d => {
      const dayIndex = days.indexOf(d);
      const sundayIndex = days.indexOf(weekEndDate);
      // Days from 6 before Sunday up to Sunday
      return dayIndex >= sundayIndex - 6 && dayIndex <= sundayIndex;
    });

    let totalCosts = 0;
    let totalRevenue = 0;

    weekDays.forEach(day => {
      const stats = getDailyStats(day);
      totalCosts += stats.totalCosts;
      totalRevenue += stats.plannedRevenue;
    });

    const laborCostPercentage = totalRevenue > 0 ? (totalCosts / totalRevenue) * 100 : null;
    const isOverBudget = laborCostPercentage !== null && laborCostPercentage > laborCostThreshold;

    return {
      totalCosts,
      totalRevenue,
      laborCostPercentage,
      isOverBudget
    };
  };

  // Determine if this is week view (7 or fewer days) for compact styling
  const isWeekView = days.length <= 7;

  // Absence paint-tool state (internal; overridden by externalActiveTool when provided)
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Resolved tool: external takes priority when it is explicitly provided (not undefined)
  const resolvedActiveTool = externalActiveTool !== undefined ? externalActiveTool : activeTool;

  const setResolvedTool = (tool: string | null) => {
    if (externalActiveTool !== undefined) {
      onExternalToolChange?.(tool);
    } else {
      setActiveTool(tool);
    }
  };

  // Over-budget dialog state
  const [openDialogDay, setOpenDialogDay] = useState<string | null>(null);
  const [whatIfRevenue, setWhatIfRevenue] = useState<string>('');

  // Per-employee cost breakdown for a specific day (for the dialog)
  const getDayEmployeeBreakdown = (dateStr: string) => {
    return employees.map(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey] || {};
      let hours = 0;

      if (daySchedule.frühAbsence || daySchedule.spätAbsence) {
        // absences – minimal hours contribution
        hours = 0;
      } else {
        const calcSlot = (slot: TimeSlot | null | undefined) => {
          if (!slot?.start || !slot?.end) return 0;
          const [sh, sm] = slot.start.split(':').map(Number);
          const [eh, em] = slot.end.split(':').map(Number);
          let h = eh - sh + (em - sm) / 60;
          if (h < 0) h += 24;
          return h;
        };
        const gross = calcSlot(daySchedule.früh) + calcSlot(daySchedule.spät);
        const breakDeduction = calculateBreakDeduction(gross);
        hours = Math.max(0, gross - breakDeduction);
      }

      const cost = hours * (emp.hourlyWage || 0);
      return { employee: emp, hours, cost };
    }).filter(e => e.hours > 0).sort((a, b) => b.cost - a.cost);
  };

  // Apply paint-tool (absence or work shift) when active; fall through to normal edit otherwise
  const handleCellChange = (
    employeeId: string,
    dateStr: string,
    slotType: 'früh' | 'spät',
    val: TimeSlot | null,
    absence?: string | null
  ) => {
    if (resolvedActiveTool) {
      const cellKey = `${employeeId}-${dateStr}`;
      const current = scheduleData[cellKey] || {};

      if (resolvedActiveTool.startsWith('shift:')) {
        // Work-shift paint mode
        const shiftName = resolvedActiveTool.slice(6);
        const config = shiftMap[shiftName];
        if (!config) return;

        // Auto-assign to Früh (start < 16:00) or Spät (start >= 16:00)
        const startHour = config.start ? parseInt(config.start.split(':')[0], 10) : 0;
        const primarySlot: 'früh' | 'spät' = startHour >= 16 ? 'spät' : 'früh';
        const secondarySlot: 'früh' | 'spät' = primarySlot === 'früh' ? 'spät' : 'früh';

        const alreadySet =
          primarySlot === 'früh'
            ? current.früh?.start === config.start && current.früh?.end === config.end && !current.frühAbsence
            : current.spät?.start === config.start && current.spät?.end === config.end && !current.spätAbsence;

        if (alreadySet) {
          // Toggle off both slots
          onSlotChange(employeeId, dateStr, 'früh', null, null);
          onSlotChange(employeeId, dateStr, 'spät', null, null);
        } else {
          // Apply to auto-determined primary slot
          onSlotChange(employeeId, dateStr, primarySlot, { start: config.start, end: config.end }, null);
          if (config.start2 && config.end2) {
            // Split shift: fill the secondary slot with the second part
            onSlotChange(employeeId, dateStr, secondarySlot, { start: config.start2, end: config.end2 }, null);
          } else {
            // Single shift: clear the other slot
            onSlotChange(employeeId, dateStr, secondarySlot, null, null);
          }
        }
      } else {
        // Absence paint mode
        const alreadySet = current.frühAbsence === resolvedActiveTool;
        if (alreadySet) {
          // Toggle off
          onSlotChange(employeeId, dateStr, 'früh', null, null);
          onSlotChange(employeeId, dateStr, 'spät', null, null);
        } else {
          // Apply absence to both slots (full-day absence)
          onSlotChange(employeeId, dateStr, 'früh', null, resolvedActiveTool);
          onSlotChange(employeeId, dateStr, 'spät', null, resolvedActiveTool);
        }
      }
    } else {
      onSlotChange(employeeId, dateStr, slotType, val, absence);
    }
  };

  return (
    <div>
      {/* Absence paint-tool bar — only shown when no external tool controller */}
      {externalActiveTool === undefined && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 p-2 bg-muted/30 rounded-md border border-border/50">
          <span className="text-[10px] font-medium text-muted-foreground shrink-0">Abwesenheit:</span>
          {absenceShifts.map(shift => {
            const config = shiftMap[shift];
            if (!config) return null;
            const isActive = resolvedActiveTool === config.abbrev;
            return (
              <button
                key={shift}
                onClick={() => setResolvedTool(isActive ? null : config.abbrev)}
                title={`${config.abbrev} – Klicken zum Aktivieren, dann auf Mitarbeiterzellen klicken`}
                className={cn(
                  "px-2 py-0.5 text-xs rounded border transition-all font-medium",
                  config.color,
                  isActive && "ring-2 ring-offset-1 ring-foreground scale-105",
                  !isActive && "opacity-70 hover:opacity-100"
                )}
              >
                {config.abbrev}
              </button>
            );
          })}
          {resolvedActiveTool && (
            <button
              onClick={() => setResolvedTool(null)}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 transition-colors"
            >
              <X className="h-3 w-3" />
              Beenden
            </button>
          )}
          {resolvedActiveTool && (
            <span className="text-[10px] text-muted-foreground italic">
              Aktiv: <strong>{resolvedActiveTool}</strong> — auf Mitarbeiterzelle klicken zum Eintragen
            </span>
          )}
        </div>
      )}

    <div className="overflow-auto max-h-[calc(100vh-280px)]">
    <ScrollArea className={cn("w-full", isWeekView && "overflow-visible")}>
      <div className={cn("min-w-max", isWeekView && "min-w-0")}>
        <table className={cn("w-full border-collapse", isWeekView && "table-fixed")}>
          <thead className="sticky top-0 z-30">
            {/* Date row */}
            <tr className="bg-card">
              <th 
                className={cn(
                  "sticky left-0 z-20 bg-card px-2 py-1 text-left text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}
                rowSpan={2}
              >
                Mitarbeiter
              </th>
              <th 
                className={cn(
                  "sticky z-20 bg-card px-1 py-1 text-center text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                )}
                rowSpan={2}
              >
                Std.
              </th>
              {days.map((day, idx) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                const isLastDay = idx === days.length - 1;
                const showWeekSum = sundayIndices.includes(idx) && getWeeklyHours;
                return (
                  <React.Fragment key={day.toISOString()}>
                    {(() => {
                      const dateStr = format(day, 'yyyy-MM-dd');
                      const stats = getDailyStats(day);
                      const laborCostQuote = stats.plannedRevenue > 0
                        ? (stats.totalCosts / stats.plannedRevenue * 100)
                        : null;
                      return (
                        <th
                          colSpan={2}
                          className={cn(
                            "px-0.5 py-1 text-center font-medium border-b cursor-pointer transition-colors",
                            "border-r-4 border-r-primary/30",
                            stats.isOverBudget && showCosts
                              ? "bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/40"
                              : isWeekendDay
                                ? "bg-amber-100 dark:bg-amber-900/30 hover:bg-muted/50"
                                : "hover:bg-muted/50",
                            isSundayDay && !stats.isOverBudget && "bg-amber-200/70 dark:bg-amber-900/50 border-r-primary/50",
                            isWeekView ? "min-w-[120px] text-xs" : "min-w-[100px] text-[10px]"
                          )}
                          onClick={() => {
                            if (stats.isOverBudget && showCosts) {
                              setWhatIfRevenue('');
                              setOpenDialogDay(dateStr);
                            } else {
                              onDayClick?.(day);
                            }
                          }}
                          title={stats.isOverBudget && showCosts ? "⚠️ Ziel überschritten – Klicken für Details" : "Klicken für Tagesdetails"}
                        >
                          <div className={cn(
                            "text-muted-foreground text-[9px]",
                            isWeekendDay && !stats.isOverBudget && "text-amber-700 dark:text-amber-400 font-semibold",
                            stats.isOverBudget && showCosts && "text-red-700 dark:text-red-400 font-semibold"
                          )}>
                            {WEEKDAY_NAMES[day.getDay()]}
                          </div>
                          <div className={cn(
                            "font-semibold text-[10px]",
                            isWeekendDay && !stats.isOverBudget && "text-amber-700 dark:text-amber-400",
                            stats.isOverBudget && showCosts && "text-red-700 dark:text-red-400"
                          )}>
                            {format(day, 'd.M.')}
                          </div>
                          {/* Always-visible planned hours indicator */}
                          <div className={cn(
                            "text-[8px] font-medium mt-0.5",
                            stats.totalHours === 0
                              ? "text-muted-foreground/50"
                              : stats.isOverBudget && showCosts
                                ? "text-red-600 dark:text-red-400"
                                : "text-blue-600 dark:text-blue-400"
                          )}>
                            {stats.totalHours > 0 ? `${stats.totalHours.toFixed(1)}h` : '–'}
                          </div>
                          {showCosts && (
                            <div className="flex flex-col items-center mt-0.5">
                              {stats.isOverBudget ? (
                                <div className="flex items-center gap-0.5 bg-red-200 dark:bg-red-900/60 border border-red-400 dark:border-red-700 rounded px-1 py-0.5 mt-0.5">
                                  <AlertTriangle className="h-2.5 w-2.5 text-red-700 dark:text-red-400 shrink-0" />
                                  <span className="text-[8px] font-bold text-red-700 dark:text-red-400">
                                    +{stats.excessCosts.toFixed(0)} CHF
                                  </span>
                                </div>
                              ) : (
                                <>
                                  <div className={cn(
                                    "text-[8px] font-medium",
                                    stats.totalCosts > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                                  )}>
                                    {stats.totalCosts > 0 ? `CHF ${stats.totalCosts.toFixed(0)}` : '-'}
                                  </div>
                                  {laborCostQuote !== null && (
                                    <div className="text-[7px] font-medium text-emerald-600 dark:text-emerald-400">
                                      {laborCostQuote.toFixed(1)}%
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </th>
                      );
                    })()}
                    {/* Weekly sum header after Sunday */}
                    {showWeekSum && (
                      <th
                        rowSpan={2}
                        className="min-w-[50px] px-0.5 py-1 text-center text-[8px] font-semibold border-b border-r-4 border-r-primary/30 bg-primary/10 text-primary"
                      >
                        <div>ΣW</div>
                        {showCosts && (() => {
                          const weekStats = getWeeklyStats(day);
                          return (
                            <div className="flex flex-col items-center mt-0.5">
                              {weekStats.totalCosts > 0 && (
                                <div className={cn(
                                  "text-[7px] font-medium",
                                  weekStats.isOverBudget 
                                    ? "text-red-600 dark:text-red-400" 
                                    : "text-emerald-600 dark:text-emerald-400"
                                )}>
                                  {weekStats.totalCosts.toFixed(0)} CHF
                                </div>
                              )}
                              {weekStats.laborCostPercentage !== null && (
                                <div className={cn(
                                  "text-[7px] font-medium",
                                  weekStats.isOverBudget 
                                    ? "text-red-600 dark:text-red-400" 
                                    : "text-emerald-600 dark:text-emerald-400"
                                )}>
                                  {weekStats.laborCostPercentage.toFixed(1)}%
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </th>
                    )}
                  </React.Fragment>
                );
              })}
            </tr>
            {/* Früh/Spät row */}
            <tr className="bg-muted/30">
              {days.map((day, idx) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                return (
                  <React.Fragment key={`header-${day.toISOString()}`}>
                    <th className={cn(
                      "px-0.5 py-0.5 text-center text-[8px] font-medium border-b border-r border-border/30",
                      isWeekendDay && "bg-amber-100/50 dark:bg-amber-900/20",
                      isSundayDay && "bg-amber-200/40 dark:bg-amber-900/30",
                      isWeekView ? "w-[55px] min-w-[55px]" : "w-[45px] min-w-[45px]"
                    )}>
                      F
                    </th>
                    <th className={cn(
                      "px-0.5 py-0.5 text-center text-[8px] font-medium border-b border-r-4 border-r-primary/30",
                      isWeekendDay && "bg-amber-100/50 dark:bg-amber-900/20",
                      isSundayDay && "bg-amber-200/40 dark:bg-amber-900/30 border-r-primary/50",
                      isWeekView ? "w-[55px] min-w-[55px]" : "w-[45px] min-w-[45px]"
                    )}>
                      S
                    </th>
                  </React.Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map(employee => {
              const plannedHours = getEmployeeHours(employee.id);
              const targetHours = getTargetHours(employee);
              const percentage = Math.min((plannedHours / targetHours) * 100, 100);
              const isInRange = percentage >= 90 && percentage <= 110;
              const isUnder = percentage < 90;
              const canRemove = employee.id.startsWith('aush_');
              
              return (
                <tr key={employee.id} className="group hover:bg-muted/30">
                  {/* Employee name cell - compact */}
                  <td className="sticky left-0 z-10 bg-card group-hover:bg-muted px-1.5 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                    <div className="flex items-center justify-between gap-0.5">
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="font-medium text-xs truncate" title={employee.name}>{employee.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {employee.employmentType === 'vollzeit' && 'VZ'}
                          {employee.employmentType === 'teilzeit' && 'TZ'}
                          {employee.employmentType === 'minijob' && 'MJ'}
                          {employee.employmentType === 'aushilfe' && 'AH'}
                          {employee.weeklyHours && ` ${employee.weeklyHours}h`}
                          {employee.daysOff && employee.daysOff.length > 0 && (
                            <span className="text-primary/70 ml-0.5">
                              {employee.daysOff.length}T
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center shrink-0">
                        {onOpen8HoursDialog && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5 text-primary hover:text-primary/80"
                                  onClick={() => onOpen8HoursDialog(employee)}
                                >
                                  <Clock className="h-3 w-3" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>8.4h Schicht eintragen</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "h-5 w-5 opacity-0 group-hover:opacity-100",
                                  employee.daysOff && employee.daysOff.length > 0 && "opacity-50 text-primary"
                                )}
                                onClick={() => onConfigureDaysOff(employee)}
                              >
                                <CalendarOff className="h-3 w-3" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Freie Tage</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        {canRemove && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Mitarbeiter entfernen?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Möchten Sie {employee.name} wirklich aus dem Dienstplan entfernen?
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => onRemoveEmployee(employee.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Entfernen
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  </td>
                  {/* Hours summary cell - compact */}
                  <td className={cn(
                    "sticky z-10 bg-card group-hover:bg-muted px-1 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                    isWeekView ? "left-[110px]" : "left-[140px]"
                  )}>
                    <div className="space-y-0.5">
                      <div className={cn(
                        "text-[10px] font-semibold text-center",
                        isInRange && "text-success",
                        isUnder && "text-warning",
                        !isInRange && !isUnder && "text-destructive"
                      )}>
                        {plannedHours.toFixed(1)}/{targetHours.toFixed(1)}
                      </div>
                      <div className={cn(
                        "text-[9px] text-center font-medium",
                        isInRange && "text-success",
                        isUnder && "text-warning",
                        !isInRange && !isUnder && "text-destructive"
                      )}>
                        {(() => {
                          const diff = plannedHours - targetHours;
                          return diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
                        })()}h
                      </div>
                      <Progress 
                        value={percentage} 
                        className={cn(
                          "h-1",
                          isInRange && "[&>div]:bg-success",
                          isUnder && "[&>div]:bg-warning",
                          !isInRange && !isUnder && "[&>div]:bg-destructive"
                        )}
                      />
                    </div>
                  </td>
                  {/* Shift cells for each day - Früh and Spät */}
                  {days.map((day, dayIdx) => {
                    const dateStr = format(day, 'yyyy-MM-dd');
                    const cellKey = `${employee.id}-${dateStr}`;
                    const daySchedule = scheduleData[cellKey] || {};
                    const isWeekendDay = isWeekend(day);
                    const isSundayDay = isSunday(day);
                    const isConfiguredDayOff = isDayOff(employee, day);
                    const showWeekSum = sundayIndices.includes(dayIdx) && getWeeklyHours;
                    
                    // Check for shift overlap or short break
                    const isOverlapping = hasShiftOverlap(daySchedule);
                    const hasShortBreakWarning = hasShortBreak(daySchedule);
                    
                    return (
                      <React.Fragment key={dateStr}>
                        {/* Früh cell */}
                        <td
                          className={cn(
                            "px-0 py-0.5 border-b border-r border-border/30 text-center relative",
                            isWeekendDay && !isConfiguredDayOff && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && !isConfiguredDayOff && "bg-amber-200/40 dark:bg-amber-900/25",
                            isConfiguredDayOff && "bg-slate-200/80 dark:bg-slate-700/50",
                            isOverlapping && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset"
                          )}
                          title={
                            isOverlapping ? "⚠️ Schichten überlappen sich!" :
                            hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" :
                            isConfiguredDayOff ? "📅 Konfigurierter wöchentlicher Ruhetag" :
                            undefined
                          }
                        >
                          <TimeInputCell
                            value={daySchedule.früh || null}
                            absenceType={daySchedule.frühAbsence || null}
                            onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'früh', val, absence)}
                            slotType="früh"
                            isWeekend={isWeekendDay}
                            isDayOff={isConfiguredDayOff}
                            activeTool={resolvedActiveTool}
                          />
                          {isOverlapping && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center" title="Schichten überlappen sich!">
                              <span className="text-white text-[8px] font-bold">!</span>
                            </div>
                          )}
                        </td>
                        {/* Spät cell */}
                        <td
                          className={cn(
                            "px-0 py-0.5 border-b text-center relative",
                            "border-r-4 border-r-primary/30",
                            isWeekendDay && !isConfiguredDayOff && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && !isConfiguredDayOff && "bg-amber-200/40 dark:bg-amber-900/25 border-r-primary/50",
                            isConfiguredDayOff && "bg-slate-200/80 dark:bg-slate-700/50",
                            isOverlapping && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset"
                          )}
                          title={
                            isOverlapping ? "⚠️ Schichten überlappen sich!" :
                            hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" :
                            isConfiguredDayOff ? "📅 Konfigurierter wöchentlicher Ruhetag" :
                            undefined
                          }
                        >
                          <TimeInputCell
                            value={daySchedule.spät || null}
                            absenceType={daySchedule.spätAbsence || null}
                            onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'spät', val, absence)}
                            slotType="spät"
                            isWeekend={isWeekendDay}
                            isDayOff={isConfiguredDayOff}
                            activeTool={resolvedActiveTool}
                          />
                          {isOverlapping && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center" title="Schichten überlappen sich!">
                              <span className="text-white text-[8px] font-bold">!</span>
                            </div>
                          )}
                        </td>
                        {/* Weekly sum cell after Sunday - with color coding */}
                        {showWeekSum && (
                          <td className="px-0.5 py-0.5 border-b border-r-4 border-r-primary/30 bg-primary/5 text-center">
                            {(() => {
                              const weekHours = getWeeklyHours(employee.id, day);
                              const weekTarget = getWeeklyTargetHours ? getWeeklyTargetHours(employee) : (employee.weeklyHours || 42);
                              const diff = weekHours - weekTarget;
                              const isOver = diff > 2;
                              const isUnder = diff < -2;
                              const isOnTarget = !isOver && !isUnder;
                              
                              return (
                                <div className="space-y-0">
                                  <span className={cn(
                                    "text-[10px] font-semibold block",
                                    isOnTarget && "text-success",
                                    isUnder && "text-warning",
                                    isOver && "text-destructive"
                                  )}>
                                    {weekHours.toFixed(1)}h
                                  </span>
                                  <span className={cn(
                                    "text-[8px] block",
                                    isOnTarget && "text-success",
                                    isUnder && "text-warning",
                                    isOver && "text-destructive"
                                  )}>
                                    {diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)}
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          {/* Footer with daily totals */}
          {showFooter && (
            <tfoot>
              <tr className="bg-muted/50 border-t-2 border-border">
                <td className="sticky left-0 z-10 bg-muted px-1.5 py-1.5 border-b border-r border-border font-semibold text-xs shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  Tages-Σ
                </td>
                <td className={cn(
                  "sticky z-10 bg-muted px-1 py-1.5 border-b border-r border-border text-center shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px]" : "left-[140px]"
                )}>
                  <span className="text-[9px] text-muted-foreground">{employees.length} MA</span>
                </td>
                {days.map((day, dayIdx) => {
                  const isWeekendDay = isWeekend(day);
                  const isSundayDay = isSunday(day);
                  const stats = getDailyStats(day);
                  const { totalHours, totalCosts, employeeCount, isOverBudget, laborCostPercentage, excessHours, plannedRevenue } = stats;
                  const showWeekSum = sundayIndices.includes(dayIdx) && getWeeklyHours;
                  
                  return (
                    <React.Fragment key={`footer-${day.toISOString()}`}>
                      <td
                        colSpan={2}
                        className={cn(
                          "px-0.5 py-1 border-b text-center",
                          "border-r-4 border-r-primary/30",
                          isWeekendDay && "bg-amber-100/50 dark:bg-amber-900/20",
                          isSundayDay && "bg-amber-200/50 dark:bg-amber-900/30 border-r-primary/50",
                          isOverBudget && showCosts && "bg-red-100 dark:bg-red-900/30"
                        )}
                      >
                        <div className="text-[10px] font-semibold text-primary">
                          {totalHours.toFixed(1)}h
                        </div>
                        <div className="text-[8px] text-muted-foreground">
                          {employeeCount} MA
                        </div>
                        {showCosts && (
                          <>
                            <div className={cn(
                              "text-[8px] font-medium",
                              isOverBudget ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                            )}>
                              CHF {totalCosts.toFixed(0)}
                            </div>
                            {plannedRevenue > 0 && (
                              <div className={cn(
                                "text-[7px]",
                                isOverBudget ? "text-red-600 dark:text-red-400 font-semibold" : "text-muted-foreground"
                              )}>
                                {laborCostPercentage.toFixed(0)}%
                              </div>
                            )}
                            {isOverBudget && excessHours > 0 && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="text-[7px] text-red-600 dark:text-red-400 font-bold cursor-help">
                                      -{excessHours.toFixed(1)}h
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p className="text-xs">
                                      {excessHours.toFixed(1)} Stunden über dem {laborCostThreshold}%-Ziel
                                      <br />
                                      (Budget: CHF {plannedRevenue.toFixed(0)})
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </>
                        )}
                      </td>
                      {showWeekSum && (
                        <td className="px-0.5 py-1 border-b border-r-4 border-r-primary/30 bg-primary/10 text-center">
                          {showCosts && (() => {
                            const weekStats = getWeeklyStats(day);
                            return (
                              <div className="flex flex-col items-center">
                                {weekStats.totalCosts > 0 && (
                                  <div className={cn(
                                    "text-[8px] font-semibold",
                                    weekStats.isOverBudget 
                                      ? "text-red-600 dark:text-red-400" 
                                      : "text-emerald-600 dark:text-emerald-400"
                                  )}>
                                    CHF {weekStats.totalCosts.toFixed(0)}
                                  </div>
                                )}
                                {weekStats.laborCostPercentage !== null && (
                                  <div className={cn(
                                    "text-[7px] font-medium",
                                    weekStats.isOverBudget 
                                      ? "text-red-600 dark:text-red-400" 
                                      : "text-emerald-600 dark:text-emerald-400"
                                  )}>
                                    {weekStats.laborCostPercentage.toFixed(1)}%
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      )}
                    </React.Fragment>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
    </div>

    {/* ── Over-budget Plan Dialog ─────────────────────────────────────── */}
    {openDialogDay && showCosts && (() => {
      const stats = getDailyStats(new Date(openDialogDay));
      const maxAllowed = stats.plannedRevenue * (laborCostThreshold / 100);
      const excessCosts = Math.max(0, stats.totalCosts - maxAllowed);
      const breakdown = getDayEmployeeBreakdown(openDialogDay);
      const whatIfRev = parseFloat(whatIfRevenue);
      const whatIfPkq = whatIfRev > 0 ? (stats.totalCosts / whatIfRev * 100) : null;
      const revenueNeeded = stats.totalCosts / (laborCostThreshold / 100);
      const parsedDate = new Date(openDialogDay);
      const dateLabel = format(parsedDate, 'EEEE, d. MMMM yyyy', { locale: de });

      return (
        <Dialog open={true} onOpenChange={() => setOpenDialogDay(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" />
                Kostenwarnung: {dateLabel}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Overview section */}
              <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tagesübersicht</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Budgetierter Umsatz</span>
                  <span className="font-medium">CHF {stats.plannedRevenue.toFixed(0)}</span>
                  <span className="text-muted-foreground">Geplante Stunden</span>
                  <span className="font-medium">{stats.totalHours.toFixed(1)} h</span>
                  <span className="text-muted-foreground">Geplante Kosten</span>
                  <span className="font-medium">CHF {stats.totalCosts.toFixed(0)}</span>
                  <span className="text-muted-foreground">Personalkostenquote (PKQ)</span>
                  <span className="font-semibold text-red-600">
                    {stats.plannedRevenue > 0 ? (stats.totalCosts / stats.plannedRevenue * 100).toFixed(1) : '–'}%
                    <span className="text-xs font-normal text-muted-foreground ml-1">(Ziel: {laborCostThreshold}%)</span>
                  </span>
                </div>
                <div className="border-t pt-2 mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-red-600 font-medium">Zu viel geplante Kosten</span>
                  <span className="font-bold text-red-600">CHF {excessCosts.toFixed(0)}</span>
                  <span className="text-red-600 font-medium">Zu viel geplante Stunden</span>
                  <span className="font-bold text-red-600">{stats.excessHours.toFixed(1)} h</span>
                  <span className="text-muted-foreground text-xs">Umsatz für Ziel-PKQ nötig</span>
                  <span className="font-medium text-xs">CHF {revenueNeeded.toFixed(0)}</span>
                </div>
              </div>

              {/* Employee breakdown */}
              {breakdown.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Kostenverteilung Mitarbeiter</div>
                  {breakdown.slice(0, 5).map(({ employee, hours, cost }) => (
                    <div key={employee.id} className="flex items-center gap-2 text-xs">
                      <div className="flex-1 truncate">{employee.name}</div>
                      <div className="text-muted-foreground shrink-0">{hours.toFixed(1)}h × {employee.hourlyWage.toFixed(2)}</div>
                      <div className="font-semibold shrink-0 w-20 text-right">CHF {cost.toFixed(0)}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* What-if revenue calculator */}
              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 space-y-2">
                <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide">Umsatz-Szenario</div>
                <p className="text-xs text-muted-foreground">
                  Welcher Umsatz wäre nötig, damit die Kosten wieder im Zielbereich liegen?
                </p>
                <div className="flex items-center gap-2">
                  <Label htmlFor="whatif" className="text-xs shrink-0">Hypothetischer Umsatz:</Label>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">CHF</span>
                    <Input
                      id="whatif"
                      type="number"
                      placeholder={revenueNeeded.toFixed(0)}
                      value={whatIfRevenue}
                      onChange={e => setWhatIfRevenue(e.target.value)}
                      className="pl-10 h-8 text-sm"
                    />
                  </div>
                </div>
                {whatIfPkq !== null && (
                  <div className={cn(
                    "text-sm font-semibold text-center py-1.5 rounded",
                    whatIfPkq <= laborCostThreshold
                      ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                      : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                  )}>
                    PKQ bei CHF {whatIfRev.toFixed(0)}: {whatIfPkq.toFixed(1)}%
                    {whatIfPkq <= laborCostThreshold
                      ? ' ✓ Im Zielbereich'
                      : ` ✗ Noch ${(whatIfPkq - laborCostThreshold).toFixed(1)}% über Ziel`}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground italic">
                  * Dieser Wert überschreibt den budgetierten Umsatz nicht.
                </p>
              </div>

              {/* ── Rule-based optimization suggestions ────────────────── */}
              {(() => {
                const suggestions: string[] = [];
                const empCount = breakdown.length;
                const highCostEmps = breakdown.filter(e => e.cost > 120);

                if (stats.excessHours > 8) {
                  suggestions.push(`Tag ist stark überplant (+${stats.excessHours.toFixed(1)} h). Überprüfe, ob alle Schichten wirklich nötig sind.`);
                } else if (stats.excessHours > 3) {
                  suggestions.push(`${stats.excessHours.toFixed(1)} Stunden zu viel geplant. 1–2 Schichten kürzen oder streichen würde reichen.`);
                } else if (stats.excessHours > 0) {
                  suggestions.push(`Nur ${stats.excessHours.toFixed(1)} h über Ziel – kleine Anpassung (z.B. frühere Abgangszeit) genügt.`);
                }

                if (excessCosts > 800) {
                  suggestions.push(`CHF ${excessCosts.toFixed(0)} über Kostenziel. Aushilfen oder teure Spätschichten priorisiert reduzieren.`);
                } else if (excessCosts > 300) {
                  suggestions.push(`CHF ${excessCosts.toFixed(0)} über Kostenziel. Spätschichten oder Überstunden kritisch prüfen.`);
                }

                if (highCostEmps.length >= 3) {
                  suggestions.push(`${highCostEmps.length} Mitarbeitende mit hohen Einzelkosten geplant. Teurere Stunden zuerst kürzen.`);
                }

                if (empCount > 0) {
                  const avgHours = stats.totalHours / empCount;
                  if (avgHours > 9) {
                    suggestions.push(`Durchschnittlich ${avgHours.toFixed(1)} h pro Person – manche Mitarbeitende könnten früher gehen.`);
                  }
                }

                if (suggestions.length === 0) {
                  suggestions.push('Überprüfe die Schichtzusammensetzung oder erhöhe den erwarteten Umsatz für diesen Tag.');
                }

                return (
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                      <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                      Optimierungsvorschläge
                    </div>
                    {suggestions.map((s, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-300">
                        <span className="shrink-0 font-bold">•</span>
                        <span>{s}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </DialogContent>
        </Dialog>
      );
    })()}
    </div>
  );
};
