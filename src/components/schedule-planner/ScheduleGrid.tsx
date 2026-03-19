// Schedule Grid Component - Updated to use onOpen8HoursDialog
import React, { useState } from 'react';
import { format, isWeekend, getDay, isSunday } from 'date-fns';
import { Employee } from '@/types/personnel';
import { TimeInputCell } from './TimeInputCell';
import { cn } from '@/lib/utils';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Trash2, CalendarOff, Clock, X } from 'lucide-react';
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
}: ScheduleGridProps) => {
  const { shiftMap, absenceShifts } = useShiftConfig();
  
  // Load labor cost threshold from settings
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const DEFAULT_LABOR_COST_THRESHOLD = 40;
  const laborCostThreshold = parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || String(DEFAULT_LABOR_COST_THRESHOLD));
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

  // Absence paint-tool state
  const [activeTool, setActiveTool] = useState<string | null>(null);

  // Apply absence to both früh and spät when paint-tool is active
  const handleCellChange = (
    employeeId: string,
    dateStr: string,
    slotType: 'früh' | 'spät',
    val: TimeSlot | null,
    absence?: string | null
  ) => {
    if (activeTool) {
      // Apply to both slots at once
      onSlotChange(employeeId, dateStr, 'früh', null, activeTool);
      onSlotChange(employeeId, dateStr, 'spät', null, activeTool);
    } else {
      onSlotChange(employeeId, dateStr, slotType, val, absence);
    }
  };

  return (
    <div>
      {/* Absence paint-tool bar */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2 p-2 bg-muted/30 rounded-md border border-border/50">
        <span className="text-[10px] font-medium text-muted-foreground shrink-0">Abwesenheit:</span>
        {absenceShifts.map(shift => {
          const config = shiftMap[shift];
          if (!config) return null;
          const isActive = activeTool === config.abbrev;
          return (
            <button
              key={shift}
              onClick={() => setActiveTool(isActive ? null : config.abbrev)}
              title={`${config.label ?? config.abbrev} – Klicken zum Aktivieren, dann auf Mitarbeiterzellen klicken`}
              className={cn(
                "px-2 py-0.5 text-xs rounded border transition-all font-medium",
                config.color,
                isActive && "ring-2 ring-offset-1 ring-foreground scale-105",
                !isActive && "opacity-70 hover:opacity-100"
              )}
            >
              {config.abbrev}
              {config.label && config.label !== config.abbrev && (
                <span className="ml-1 text-[9px] opacity-75">{config.label}</span>
              )}
            </button>
          );
        })}
        {activeTool && (
          <button
            onClick={() => setActiveTool(null)}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-destructive/50 text-destructive hover:bg-destructive/10 transition-colors"
          >
            <X className="h-3 w-3" />
            Beenden
          </button>
        )}
        {activeTool && (
          <span className="text-[10px] text-muted-foreground italic">
            Aktiv: <strong>{activeTool}</strong> — auf Mitarbeiterzelle klicken zum Eintragen
          </span>
        )}
      </div>

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
                    <th
                      colSpan={2}
                      className={cn(
                        "px-0.5 py-1 text-center font-medium border-b cursor-pointer hover:bg-muted/50 transition-colors",
                        "border-r-4 border-r-primary/30",
                        isWeekendDay && "bg-amber-100 dark:bg-amber-900/30",
                        isSundayDay && "bg-amber-200/70 dark:bg-amber-900/50 border-r-primary/50",
                        isWeekView ? "min-w-[120px] text-xs" : "min-w-[100px] text-[10px]"
                      )}
                      onClick={() => onDayClick?.(day)}
                      title="Klicken für Tagesdetails"
                    >
                      <div className={cn(
                        "text-muted-foreground text-[9px]",
                        isWeekendDay && "text-amber-700 dark:text-amber-400 font-semibold"
                      )}>
                        {WEEKDAY_NAMES[day.getDay()]}
                      </div>
                      <div className={cn(
                        "font-semibold text-[10px]",
                        isWeekendDay && "text-amber-700 dark:text-amber-400"
                      )}>
                        {format(day, 'd.M.')}
                      </div>
                      {showCosts && (() => {
                        const stats = getDailyStats(day);
                        const laborCostQuote = stats.plannedRevenue > 0 
                          ? (stats.totalCosts / stats.plannedRevenue * 100) 
                          : null;
                        return (
                          <div className="flex flex-col items-center">
                            <div className={cn(
                              "text-[8px] font-medium mt-0.5",
                              stats.isOverBudget 
                                ? "text-red-600 dark:text-red-400" 
                                : stats.totalCosts > 0 
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-muted-foreground"
                            )}>
                              {stats.totalCosts > 0 ? `CHF ${stats.totalCosts.toFixed(0)}` : '-'}
                            </div>
                            {laborCostQuote !== null && (
                              <div className={cn(
                                "text-[7px] font-medium",
                                laborCostQuote > laborCostThreshold 
                                  ? "text-red-600 dark:text-red-400" 
                                  : "text-emerald-600 dark:text-emerald-400"
                              )}>
                                {laborCostQuote.toFixed(1)}%
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </th>
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
                  <td className="sticky left-0 z-10 bg-card group-hover:bg-muted/30 px-1.5 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
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
                    "sticky z-10 bg-card group-hover:bg-muted/30 px-1 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
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
                            isWeekendDay && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && "bg-amber-200/40 dark:bg-amber-900/25",
                            isConfiguredDayOff && "bg-muted/50",
                            isOverlapping && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset"
                          )}
                          title={isOverlapping ? "⚠️ Schichten überlappen sich!" : hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" : undefined}
                        >
                          <TimeInputCell
                            value={daySchedule.früh || null}
                            absenceType={daySchedule.frühAbsence || null}
                            onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'früh', val, absence)}
                            slotType="früh"
                            isWeekend={isWeekendDay}
                            isDayOff={isConfiguredDayOff}
                            activeTool={activeTool}
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
                            isWeekendDay && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && "bg-amber-200/40 dark:bg-amber-900/25 border-r-primary/50",
                            isConfiguredDayOff && "bg-muted/50",
                            isOverlapping && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset"
                          )}
                          title={isOverlapping ? "⚠️ Schichten überlappen sich!" : hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" : undefined}
                        >
                          <TimeInputCell
                            value={daySchedule.spät || null}
                            absenceType={daySchedule.spätAbsence || null}
                            onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'spät', val, absence)}
                            slotType="spät"
                            isWeekend={isWeekendDay}
                            isDayOff={isConfiguredDayOff}
                            activeTool={activeTool}
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
                <td className="sticky left-0 z-10 bg-muted/80 px-1.5 py-1.5 border-b border-r border-border font-semibold text-xs shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  Tages-Σ
                </td>
                <td className={cn(
                  "sticky z-10 bg-muted/80 px-1 py-1.5 border-b border-r border-border text-center shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
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
    </div>
  );
};
