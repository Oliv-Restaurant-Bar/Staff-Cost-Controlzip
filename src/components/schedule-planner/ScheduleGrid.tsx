// Schedule Grid Component - Updated to use onOpen8HoursDialog
import React, { useState, useMemo } from 'react';
import { format, isWeekend, getDay, isSunday, parseISO, isAfter } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { TimeInputCell } from './TimeInputCell';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Trash2, CalendarOff, Clock, X, AlertTriangle, Lightbulb, CheckCircle2, EyeOff, Clock3, ChevronUp, ChevronDown } from 'lucide-react';
import { computeSuggestions, CorrectionSuggestion } from './correctionSuggestions';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useShiftConfig, calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { buildAvailabilityMap } from '@/lib/availability-store';
import { PatternWarning, PatternType } from '@/lib/pattern-warnings';

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
  /** Employee ID to visually highlight (from Planungshilfe jump) */
  highlightedEmployeeId?: string | null;
  /** Pre-computed pattern warnings to show as chips in the employee name column */
  patternWarnings?: PatternWarning[];
  /** Clipboard slot for copy/paste within TimeInputCell */
  copiedShift?: TimeSlot | null;
  onCopyShift?: (slot: TimeSlot) => void;
  /**
   * When provided, ▲/▼ sort buttons appear in the employee name column.
   * Only pass this when sort mode is active in the parent.
   */
  onMoveEmployee?: (empId: string, direction: 'up' | 'down') => void;
  /**
   * Per-cell color map for manual time entries.
   * Key format: `${empId}-${yyyy-MM-dd}-früh` or `…-spät`
   */
  cellColors?: Record<string, string>;
  onCellColorChange?: (key: string, color: string | null) => void;
  /** Show a coloured dept dot next to each employee name (blue=Service, orange=Küche) */
  showDepartmentBadge?: boolean;
  /**
   * When provided, "Auch ins IST übernehmen" checkbox appears in each TimeInputCell popover.
   * Called with employeeId, date (yyyy-MM-dd), slotType, and the selected TimeSlot.
   */
  onCopyToIst?: (employeeId: string, date: string, slotType: 'früh' | 'spät', slot: TimeSlot) => void;
}

function patternShortLabel(type: PatternType): string {
  switch (type) {
    case 'consecutive-days': return 'Tage';
    case 'consecutive-late': return 'Spät';
    case 'short-recovery':   return 'Pause';
    case 'weekly-overload':  return 'Std.';
  }
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

// Short label shown on the orange suggestion strip inside a cell
const getSuggestionLabel = (s: CorrectionSuggestion): string => {
  if (s.badge === 'Aushilfe') return 'Aushilfe';
  if (s.actionType === 'remove_spat') return 'Spät';
  if (s.actionType === 'remove_frueh') return 'Früh';
  return 'Streichen';
};

// Suggestion strip rendered at the bottom of an overplanned cell — full width, clearly visible
interface SuggestionStripProps {
  s: CorrectionSuggestion;
  inlineKey: string;
  dateStr: string;
  openInlineId: string | null;
  onOpenChange: (id: string | null) => void;
  onApply: (s: CorrectionSuggestion, dateStr: string) => void;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
}

const SuggestionStrip = ({
  s, inlineKey, dateStr, openInlineId, onOpenChange, onApply, onDismiss, onSnooze,
}: SuggestionStripProps) => (
  <Popover
    open={openInlineId === inlineKey}
    onOpenChange={(open) => onOpenChange(open ? inlineKey : null)}
  >
    <PopoverTrigger asChild>
      <button
        className="w-full bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white flex items-center justify-center gap-0.5 py-[3px] border-t border-orange-600 transition-colors cursor-pointer"
        onClick={(e) => { e.stopPropagation(); }}
        title={s.description}
      >
        <span className="text-[8px] font-bold leading-none">✂</span>
        <span className="text-[8px] font-bold leading-none ml-0.5">{getSuggestionLabel(s)}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-64 p-3 space-y-2" align="end" side="bottom">
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/40 border border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-300">
            {s.badge}
          </span>
          <span className="text-xs font-semibold truncate">{s.employeeName}</span>
        </div>
        <p className="text-[10px] text-muted-foreground">{s.slotDisplay || s.description}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">−{s.savingHours.toFixed(1)} h</span>
          {s.savingCost > 0 && (
            <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">−CHF {s.savingCost.toFixed(0)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 pt-1.5 border-t border-border/40">
        <Button
          size="sm"
          className="h-7 px-2.5 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white flex-1"
          onClick={() => { onApply(s, dateStr); onOpenChange(null); }}
        >
          <CheckCircle2 className="h-3 w-3" />
          Übernehmen
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs gap-1"
          onClick={() => { onDismiss(s.id); onOpenChange(null); }}
        >
          <EyeOff className="h-3 w-3" />
          Ignorieren
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1 text-muted-foreground"
          onClick={() => { onSnooze(s.id); onOpenChange(null); }}
        >
          <Clock3 className="h-3 w-3" />
          Später
        </Button>
      </div>
    </PopoverContent>
  </Popover>
);

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
  highlightedEmployeeId,
  patternWarnings = [],
  copiedShift,
  onCopyShift,
  onMoveEmployee,
  cellColors = {},
  onCellColorChange,
  showDepartmentBadge = false,
  onCopyToIst,
}: ScheduleGridProps) => {
  const { shiftMap, absenceShifts } = useShiftConfig();
  
  // Use prop if provided (allows per-department threshold), else fall back to localStorage
  const LABOR_COST_THRESHOLD_KEY = 'labor_cost_threshold';
  const DEFAULT_LABOR_COST_THRESHOLD = 40;
  const laborCostThreshold = laborCostThresholdProp ?? parseFloat(localStorage.getItem(LABOR_COST_THRESHOLD_KEY) || String(DEFAULT_LABOR_COST_THRESHOLD));
  const sundayIndices = getSundayIndices(days);

  // Build availability map for all displayed employees × days (loaded once per render cycle)
  const availabilityMap = useMemo(() => {
    const empIds  = employees.map(e => e.id);
    const dateStrs = days.map(d => format(d, 'yyyy-MM-dd'));
    return buildAvailabilityMap(empIds, dateStrs);
  }, [employees, days]);

  // Calculate daily totals including costs and budget comparison
  const getDailyStats = (day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;
    let employeeCount = 0;

    // Slot-level cost accumulators per dept
    const slotCosts = {
      service: { früh: 0, spät: 0, frühHours: 0, spätHours: 0 },
      küche:   { früh: 0, spät: 0, frühHours: 0, spätHours: 0 },
    } as Record<string, { früh: number; spät: number; frühHours: number; spätHours: number }>;

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

        // Slot-level cost split (break deduction distributed proportionally)
        if (grossWorkHours > 0 && emp.hourlyWage) {
          const frühNetH  = frühHours  > 0 ? frühHours  - breakDeduction * (frühHours  / grossWorkHours) : 0;
          const spätNetH  = spätHours  > 0 ? spätHours  - breakDeduction * (spätHours  / grossWorkHours) : 0;
          const dept = emp.department === 'küche' ? 'küche' : 'service';
          if (!slotCosts[dept]) slotCosts[dept] = { früh: 0, spät: 0, frühHours: 0, spätHours: 0 };
          slotCosts[dept].früh      += Math.max(0, frühNetH)  * emp.hourlyWage;
          slotCosts[dept].spät      += Math.max(0, spätNetH)  * emp.hourlyWage;
          slotCosts[dept].frühHours += Math.max(0, frühNetH);
          slotCosts[dept].spätHours += Math.max(0, spätNetH);
        }
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

    // Aggregated slot totals (both depts combined)
    const totalFrühCosts  = (slotCosts.service?.früh  ?? 0) + (slotCosts.küche?.früh  ?? 0);
    const totalSpätCosts  = (slotCosts.service?.spät  ?? 0) + (slotCosts.küche?.spät  ?? 0);
    const totalFrühHours  = (slotCosts.service?.frühHours ?? 0) + (slotCosts.küche?.frühHours ?? 0);
    const totalSpätHours  = (slotCosts.service?.spätHours ?? 0) + (slotCosts.küche?.spätHours ?? 0);

    return {
      totalHours,
      totalCosts,
      employeeCount,
      plannedRevenue,
      laborCostPercentage,
      isOverBudget,
      excessHours: Math.max(0, excessHours),
      excessCosts: Math.max(0, excessCosts),
      // Slot-level breakdowns
      slotCosts,
      totalFrühCosts,
      totalSpätCosts,
      totalFrühHours,
      totalSpätHours,
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

  // Correction suggestion state
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [snoozedIds, setSnoozedIds] = useState<string[]>([]);

  // Pre-compute which cells are top correction candidates across ALL overbudget days.
  // Used to render orange suggestion rings in the grid even before the dialog is opened.
  // Stores the full CorrectionSuggestion so the inline popover can show actions.
  // NOTE: intentionally NOT gated on showCosts — overplanning markers are useful regardless.
  const gridSuggestionMap = useMemo(() => {
    const result = new Map<string, CorrectionSuggestion>();
    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const stats = getDailyStats(day);
      if (!stats.isOverBudget) return;
      const suggestions = computeSuggestions(
        dateStr, employees, scheduleData, dismissedIds, stats.excessCosts,
      );
      // Mark the TOP priority suggestions (tier 1+2: aushilfe + double-shifts first)
      const topSuggestions = suggestions.slice(0, 4);
      topSuggestions.forEach(s => {
        if (s.actionType === 'remove_all' || s.actionType === 'remove_frueh') {
          result.set(`${s.employeeId}-${dateStr}-früh`, s);
        }
        if (s.actionType === 'remove_all' || s.actionType === 'remove_spat') {
          result.set(`${s.employeeId}-${dateStr}-spät`, s);
        }
      });
    });
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, employees, scheduleData, dismissedIds, laborCostThreshold, dailyBudgets]);

  // Track which inline suggestion popover is currently open (key = cellKey-slot)
  const [openInlineId, setOpenInlineId] = useState<string | null>(null);

  const handleApplySuggestion = (s: CorrectionSuggestion, dateStr: string) => {
    if (s.actionType === 'remove_all' || s.actionType === 'remove_frueh') {
      onSlotChange(s.employeeId, dateStr, 'früh', null, null);
    }
    if (s.actionType === 'remove_all' || s.actionType === 'remove_spat') {
      onSlotChange(s.employeeId, dateStr, 'spät', null, null);
    }
    setDismissedIds(prev => [...prev, s.id]);
  };

  // Per-employee cost breakdown for a specific day (for the dialog)
  const getDayEmployeeBreakdown = (dateStr: string) => {
    return employees.map(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const daySchedule = scheduleData[cellKey] || {};
      let hours = 0;

      if (daySchedule.frühAbsence || daySchedule.spätAbsence) {
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

      // Build human-readable shift display for the dialog
      const parts: string[] = [];
      if (daySchedule.früh?.start && daySchedule.früh?.end && !daySchedule.frühAbsence) {
        parts.push(`F: ${daySchedule.früh.start}–${daySchedule.früh.end}`);
      } else if (daySchedule.frühAbsence) {
        parts.push(daySchedule.frühAbsence);
      }
      if (daySchedule.spät?.start && daySchedule.spät?.end && !daySchedule.spätAbsence) {
        parts.push(`S: ${daySchedule.spät.start}–${daySchedule.spät.end}`);
      } else if (daySchedule.spätAbsence && daySchedule.spätAbsence !== daySchedule.frühAbsence) {
        parts.push(daySchedule.spätAbsence);
      }
      const shiftDisplay = parts.join(' | ');

      return { employee: emp, hours, cost, shiftDisplay };
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
      <div className={cn("min-w-max", isWeekView && "min-w-0")}>
        <table className={cn("w-full border-collapse", isWeekView && "table-fixed")}>
          <thead className="sticky top-0 z-30 bg-card">
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
                            stats.isOverBudget
                              ? "bg-red-200 dark:bg-red-950/80 hover:bg-red-300 dark:hover:bg-red-900/80 border-b-2 border-b-red-500 dark:border-b-red-600"
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
                          title={stats.isOverBudget ? "⚠️ Ziel überschritten – Klicken für Details" : "Klicken für Tagesdetails"}
                        >
                          <div className={cn(
                            "text-muted-foreground text-[9px]",
                            isWeekendDay && !stats.isOverBudget && "text-amber-700 dark:text-amber-400 font-semibold",
                            stats.isOverBudget && "text-red-800 dark:text-red-300 font-bold"
                          )}>
                            {WEEKDAY_NAMES[day.getDay()]}
                          </div>
                          <div className={cn(
                            "font-semibold text-[10px]",
                            isWeekendDay && !stats.isOverBudget && "text-amber-700 dark:text-amber-400",
                            stats.isOverBudget && "text-red-800 dark:text-red-300"
                          )}>
                            {format(day, 'd.M.')}
                          </div>
                          {/* Always-visible planned hours indicator — red whenever overbudget */}
                          <div className={cn(
                            "text-[8px] font-medium mt-0.5",
                            stats.totalHours === 0
                              ? "text-muted-foreground/50"
                              : stats.isOverBudget
                                ? "text-red-600 dark:text-red-400 font-bold"
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
            <tr className="bg-card">
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
            {employees.map((employee, empIdx) => {
              const plannedHours = getEmployeeHours(employee.id);
              const targetHours = getTargetHours(employee);
              const percentage = Math.min((plannedHours / targetHours) * 100, 100);
              const isInRange = percentage >= 90 && percentage <= 110;
              const isUnder = percentage < 90;
              const canRemove = employee.id.startsWith('aush_');
              const empPatternWarnings = patternWarnings.filter(w => w.empId === employee.id);

              return (
                <tr key={employee.id} className={cn(
                  "group hover:bg-muted/30 transition-colors",
                  highlightedEmployeeId === employee.id && "ring-2 ring-inset ring-indigo-400 dark:ring-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20",
                )}>
                  {/* Employee name cell – explicit width prevents misalignment of sticky second column */}
                  <td className={cn(
                    "sticky left-0 z-10 bg-card group-hover:bg-muted",
                    "px-1.5 py-1 border-b border-r-2 border-border overflow-hidden",
                    "shadow-[3px_0_8px_-2px_rgba(0,0,0,0.18)] dark:shadow-[3px_0_8px_-2px_rgba(0,0,0,0.45)]",
                    isWeekView
                      ? "w-[110px] min-w-[110px] max-w-[110px]"
                      : "w-[140px] min-w-[140px] max-w-[140px]"
                  )}>
                    <div className="flex items-center justify-between gap-0.5">
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-1 font-medium text-xs truncate" title={getEmployeeDisplayName(employee)}>
                          {showDepartmentBadge && (
                            <span className={cn(
                              "w-1.5 h-1.5 rounded-full shrink-0",
                              employee.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                            )} />
                          )}
                          <span className="truncate">{getEmployeeDisplayName(employee)}</span>
                        </div>
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
                        {/* Sort order arrows — only shown when sort mode is active */}
                        {onMoveEmployee && (
                          <div className="flex flex-col shrink-0">
                            <button
                              title="Nach oben"
                              disabled={empIdx === 0}
                              onClick={() => onMoveEmployee(employee.id, 'up')}
                              className="h-3.5 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed"
                            >
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button
                              title="Nach unten"
                              disabled={empIdx === employees.length - 1}
                              onClick={() => onMoveEmployee(employee.id, 'down')}
                              className="h-3.5 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:cursor-not-allowed"
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Pattern warning chips */}
                    {empPatternWarnings.length > 0 && (
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {empPatternWarnings.slice(0, 2).map((w, wi) => (
                          <TooltipProvider key={wi}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className={cn(
                                  "inline-flex items-center gap-0.5 px-1 py-0 rounded text-[8px] font-semibold border cursor-default",
                                  w.severity === 'critical'
                                    ? "bg-red-100 border-red-300 text-red-700 dark:bg-red-950/40 dark:border-red-700 dark:text-red-300"
                                    : "bg-amber-100 border-amber-300 text-amber-700 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-300"
                                )}>
                                  <AlertTriangle className="h-2 w-2 shrink-0" />
                                  {patternShortLabel(w.type)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-[220px]">
                                <p className="font-semibold text-xs">{w.message}</p>
                                <p className="text-muted-foreground text-[10px] mt-0.5 leading-snug">{w.detail}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ))}
                        {empPatternWarnings.length > 2 && (
                          <span className="inline-flex items-center px-1 py-0 rounded text-[8px] font-semibold border bg-muted border-border text-muted-foreground">
                            +{empPatternWarnings.length - 2}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  {/* Hours summary cell - compact */}
                  <td className={cn(
                    "sticky z-10 bg-card group-hover:bg-muted",
                    "px-1 py-1 border-b border-r-2 border-border overflow-hidden",
                    "shadow-[3px_0_8px_-2px_rgba(0,0,0,0.18)] dark:shadow-[3px_0_8px_-2px_rgba(0,0,0,0.45)]",
                    isWeekView
                      ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]"
                      : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
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
                    
                    const frühSuggestion = gridSuggestionMap.get(`${employee.id}-${dateStr}-früh`);
                    const spätSuggestion = gridSuggestionMap.get(`${employee.id}-${dateStr}-spät`);
                    const isSuggestedFrüh = !!frühSuggestion;
                    const isSuggestedSpät = !!spätSuggestion;

                    // Availability overlay
                    const availStatus = availabilityMap[`${employee.id}-${dateStr}`] ?? 'normal';
                    const cellIsRequestedFree = availStatus === 'requested-free';
                    const cellIsBlocked       = availStatus === 'blocked';
                    const frühInlineKey = `${employee.id}-${dateStr}-früh`;
                    const spätInlineKey = `${employee.id}-${dateStr}-spät`;
                    const frühCellColor = cellColors[frühInlineKey] ?? null;
                    const spätCellColor = cellColors[spätInlineKey] ?? null;

                    // Block cells after the employee's employment end date
                    const exitDate = employee.employmentEndDate ? parseISO(employee.employmentEndDate) : null;
                    const isAfterExitDate = exitDate ? isAfter(day, exitDate) : false;

                    return (
                      <React.Fragment key={dateStr}>
                        {/* Früh cell */}
                        <td
                          className={cn(
                            "px-0 py-0 border-b border-r border-border/30 text-center relative align-top",
                            isWeekendDay && !isConfiguredDayOff && !isAfterExitDate && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && !isConfiguredDayOff && !isAfterExitDate && "bg-amber-200/40 dark:bg-amber-900/25",
                            isConfiguredDayOff && !isAfterExitDate && "bg-slate-300 dark:bg-slate-600",
                            isAfterExitDate && "bg-zinc-800 dark:bg-zinc-900",
                            isOverlapping && !isAfterExitDate && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && !isAfterExitDate && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset",
                            isSuggestedFrüh && !isOverlapping && !isAfterExitDate && "ring-2 ring-orange-400 dark:ring-orange-500 ring-inset"
                          )}
                          title={
                            isAfterExitDate ? `Nach Austritt gesperrt (${employee.employmentEndDate})` :
                            isOverlapping ? "⚠️ Schichten überlappen sich!" :
                            hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" :
                            isConfiguredDayOff ? "📅 Konfigurierter wöchentlicher Ruhetag" :
                            undefined
                          }
                        >
                          {isAfterExitDate ? (
                            <div className="flex items-center justify-center min-h-[28px] h-full">
                              <span className="text-zinc-500 dark:text-zinc-600 text-[10px] font-bold select-none">✕</span>
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <div className="py-0.5">
                                <TimeInputCell
                                  value={daySchedule.früh || null}
                                  absenceType={daySchedule.frühAbsence || null}
                                  onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'früh', val, absence)}
                                  slotType="früh"
                                  isWeekend={isWeekendDay}
                                  isDayOff={isConfiguredDayOff}
                                  isRequestedFree={cellIsRequestedFree}
                                  isBlocked={cellIsBlocked}
                                  activeTool={resolvedActiveTool}
                                  copiedShift={copiedShift}
                                  onCopyShift={onCopyShift}
                                  cellColor={frühCellColor}
                                  onCellColorChange={onCellColorChange ? (c) => onCellColorChange(frühInlineKey, c) : undefined}
                                  onCopyToIst={onCopyToIst ? (slot) => onCopyToIst(employee.id, dateStr, 'früh', slot) : undefined}
                                />
                              </div>
                              {isSuggestedFrüh && !isOverlapping && frühSuggestion && (
                                <SuggestionStrip
                                  s={frühSuggestion}
                                  inlineKey={frühInlineKey}
                                  dateStr={dateStr}
                                  openInlineId={openInlineId}
                                  onOpenChange={setOpenInlineId}
                                  onApply={handleApplySuggestion}
                                  onDismiss={(id) => setDismissedIds(prev => [...prev, id])}
                                  onSnooze={(id) => setSnoozedIds(prev => [...prev, id])}
                                />
                              )}
                            </div>
                          )}
                          {isOverlapping && !isAfterExitDate && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center" title="Schichten überlappen sich!">
                              <span className="text-white text-[8px] font-bold">!</span>
                            </div>
                          )}
                        </td>
                        {/* Spät cell */}
                        <td
                          className={cn(
                            "px-0 py-0 border-b text-center relative align-top",
                            "border-r-4 border-r-primary/30",
                            isWeekendDay && !isConfiguredDayOff && !isAfterExitDate && "bg-amber-100/30 dark:bg-amber-900/15",
                            isSundayDay && !isConfiguredDayOff && !isAfterExitDate && "bg-amber-200/40 dark:bg-amber-900/25 border-r-primary/50",
                            isConfiguredDayOff && !isAfterExitDate && "bg-slate-300 dark:bg-slate-600",
                            isAfterExitDate && "bg-zinc-800 dark:bg-zinc-900",
                            isOverlapping && !isAfterExitDate && "bg-red-100 dark:bg-red-900/30 ring-2 ring-red-500 ring-inset",
                            hasShortBreakWarning && !isOverlapping && !isAfterExitDate && "bg-amber-100 dark:bg-amber-900/30 ring-1 ring-amber-500 ring-inset",
                            isSuggestedSpät && !isOverlapping && !isAfterExitDate && "ring-2 ring-orange-400 dark:ring-orange-500 ring-inset"
                          )}
                          title={
                            isAfterExitDate ? `Nach Austritt gesperrt (${employee.employmentEndDate})` :
                            isOverlapping ? "⚠️ Schichten überlappen sich!" :
                            hasShortBreakWarning ? "⚠️ Kurze Pause (<30 Min.)" :
                            isConfiguredDayOff ? "📅 Konfigurierter wöchentlicher Ruhetag" :
                            undefined
                          }
                        >
                          {isAfterExitDate ? (
                            <div className="flex items-center justify-center min-h-[28px] h-full">
                              <span className="text-zinc-500 dark:text-zinc-600 text-[10px] font-bold select-none">✕</span>
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <div className="py-0.5">
                                <TimeInputCell
                                  value={daySchedule.spät || null}
                                  absenceType={daySchedule.spätAbsence || null}
                                  onChange={(val, absence) => handleCellChange(employee.id, dateStr, 'spät', val, absence)}
                                  slotType="spät"
                                  isWeekend={isWeekendDay}
                                  isDayOff={isConfiguredDayOff}
                                  isRequestedFree={cellIsRequestedFree}
                                  isBlocked={cellIsBlocked}
                                  activeTool={resolvedActiveTool}
                                  copiedShift={copiedShift}
                                  onCopyShift={onCopyShift}
                                  cellColor={spätCellColor}
                                  onCellColorChange={onCellColorChange ? (c) => onCellColorChange(spätInlineKey, c) : undefined}
                                  onCopyToIst={onCopyToIst ? (slot) => onCopyToIst(employee.id, dateStr, 'spät', slot) : undefined}
                                />
                              </div>
                              {isSuggestedSpät && !isOverlapping && spätSuggestion && (
                                <SuggestionStrip
                                  s={spätSuggestion}
                                  inlineKey={spätInlineKey}
                                  dateStr={dateStr}
                                  openInlineId={openInlineId}
                                  onOpenChange={setOpenInlineId}
                                  onApply={handleApplySuggestion}
                                  onDismiss={(id) => setDismissedIds(prev => [...prev, id])}
                                  onSnooze={(id) => setSnoozedIds(prev => [...prev, id])}
                                />
                              )}
                            </div>
                          )}
                          {isOverlapping && !isAfterExitDate && (
                            <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center" title="Schichten überlappen sich!">
                              <span className="text-white text-[8px] font-bold">!</span>
                            </div>
                          )}
                        </td>
                        {/* Weekly sum cell after Sunday - planned vs target with colour coding */}
                        {showWeekSum && (
                          <td className="px-0.5 py-0.5 border-b border-r-4 border-r-primary/30 bg-primary/5 text-center min-w-[42px]">
                            {(() => {
                              const weekHours = getWeeklyHours!(employee.id, day);
                              const weekTarget = getWeeklyTargetHours ? getWeeklyTargetHours(employee) : (employee.weeklyHours || 42);
                              const diff = weekHours - weekTarget;
                              const isOver = diff > 2;
                              const isUnder = diff < -2;
                              const isOnTarget = !isOver && !isUnder;
                              const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);

                              return (
                                <div className="flex flex-col items-center gap-0">
                                  {/* Planned hours */}
                                  <span className={cn(
                                    'text-[10px] font-bold block leading-tight',
                                    isOnTarget && 'text-emerald-600 dark:text-emerald-400',
                                    isUnder    && 'text-amber-600 dark:text-amber-400',
                                    isOver     && 'text-red-600 dark:text-red-500',
                                  )}>
                                    {weekHours.toFixed(1)}h
                                  </span>
                                  {/* Target */}
                                  <span className="text-[8px] text-muted-foreground leading-tight">
                                    / {weekTarget}h
                                  </span>
                                  {/* Deviation badge */}
                                  <span className={cn(
                                    'text-[8px] font-semibold leading-tight',
                                    isOnTarget && 'text-emerald-600 dark:text-emerald-400',
                                    isUnder    && 'text-amber-600 dark:text-amber-400',
                                    isOver     && 'text-red-600 dark:text-red-500',
                                  )}>
                                    {diffStr}
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
                <td className={cn(
                  "sticky left-0 z-10 bg-muted px-1.5 py-1.5 border-b border-r-2 border-border font-semibold text-xs",
                  "shadow-[3px_0_8px_-2px_rgba(0,0,0,0.18)] dark:shadow-[3px_0_8px_-2px_rgba(0,0,0,0.45)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}>
                  Tages-Σ
                </td>
                <td className={cn(
                  "sticky z-10 bg-muted px-1 py-1.5 border-b border-r-2 border-border text-center",
                  "shadow-[3px_0_8px_-2px_rgba(0,0,0,0.18)] dark:shadow-[3px_0_8px_-2px_rgba(0,0,0,0.45)]",
                  isWeekView
                    ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]"
                    : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
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

      // Build a map from employeeId → suggestion for this day
      const allSuggestions = computeSuggestions(openDialogDay, employees, scheduleData, dismissedIds, excessCosts);
      const suggestionByEmpId = new Map(allSuggestions.map(s => [s.employeeId, s]));
      const pendingCount = allSuggestions.filter(s => !snoozedIds.includes(s.id) && !dismissedIds.includes(s.id)).length;
      const totalSaving = allSuggestions.reduce((sum, s) => sum + s.savingCost, 0);

      // DEBUG: log what we have so we can trace issues in the console
      console.log('[DIALOG] openDialogDay:', openDialogDay);
      console.log('[DIALOG] breakdown count:', breakdown.length, breakdown.map(b => ({ id: b.employee.id, name: b.employee.name, hours: b.hours, cost: b.cost, shiftDisplay: b.shiftDisplay })));
      console.log('[DIALOG] allSuggestions count:', allSuggestions.length, allSuggestions.map(s => ({ empId: s.employeeId, name: s.employeeName, action: s.actionType, savingH: s.savingHours, savingCHF: s.savingCost })));
      console.log('[DIALOG] scheduleData keys for day:', Object.keys(scheduleData).filter(k => k.endsWith(openDialogDay)));
      console.log('[DIALOG] employees with wage:', employees.map(e => ({ id: e.id, name: e.name, wage: e.hourlyWage, type: e.employmentType })));

      // Human-readable suggestion action label
      const getSuggestionActionLabel = (s: CorrectionSuggestion) => {
        if (s.actionType === 'remove_all') return 'Einsatz streichen';
        if (s.actionType === 'remove_spat') return 'Spätschicht entfernen';
        if (s.actionType === 'remove_frueh') return 'Frühschicht entfernen';
        return 'Schicht entfernen';
      };

      return (
        <Dialog open={true} onOpenChange={() => setOpenDialogDay(null)}>
          <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
            {/* ── Inner flex wrapper owns all layout — avoids fighting DialogContent base grid/padding ── */}
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '88vh', overflow: 'hidden' }}>

              {/* ── Fixed header ───────────────────────────────────── */}
              <div style={{ flexShrink: 0, padding: '16px 20px 12px', borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                  <span className="text-base font-semibold text-red-600">Kostenwarnung — {dateLabel}</span>
                </div>
                <span className="sr-only">Überplanungsdetails und Korrekturvorschläge für diesen Tag</span>
              </div>

              {/* ── Fixed KPI strip ────────────────────────────────── */}
              <div style={{ flexShrink: 0, padding: '10px 20px', borderBottom: '1px solid var(--border)' }}
                className="bg-muted/30 space-y-2">
                {/* Row 1: overall KPIs */}
                <div className="grid grid-cols-6 gap-x-4 gap-y-1">
                  {[
                    { label: 'Umsatz budg.', value: `CHF ${stats.plannedRevenue.toFixed(0)}`, red: false },
                    { label: 'Kosten plan', value: `CHF ${stats.totalCosts.toFixed(0)}`, red: false },
                    { label: 'Stunden plan', value: `${stats.totalHours.toFixed(1)} h`, red: false },
                    {
                      label: 'PKQ aktuell',
                      value: `${stats.plannedRevenue > 0 ? (stats.totalCosts / stats.plannedRevenue * 100).toFixed(1) : '–'}% / ${laborCostThreshold}%`,
                      red: true,
                    },
                    { label: 'Zu viel CHF', value: `+CHF ${excessCosts.toFixed(0)}`, red: true },
                    { label: 'Zu viel Std.', value: `+${stats.excessHours.toFixed(1)} h`, red: true },
                  ].map(({ label, value, red }) => (
                    <div key={label} className="space-y-0.5 min-w-0">
                      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
                      <div className={cn("text-sm font-bold", red ? "text-red-600 dark:text-red-400" : "text-foreground")}>{value}</div>
                    </div>
                  ))}
                </div>
                {/* Row 2: Früh / Spät slot breakdown */}
                {(stats.totalFrühCosts > 0 || stats.totalSpätCosts > 0) && (() => {
                  const sc = stats.slotCosts;
                  const driverLabel = (() => {
                    const frühTotal = stats.totalFrühCosts;
                    const spätTotal = stats.totalSpätCosts;
                    if (frühTotal === 0 && spätTotal === 0) return null;
                    const driver = frühTotal > spätTotal ? 'Frühdienst' : 'Spätdienst';
                    const ratio = Math.max(frühTotal, spätTotal) / stats.totalCosts * 100;
                    return `${driver} verursacht ${ratio.toFixed(0)} % der Kosten`;
                  })();
                  return (
                    <div className="border-t border-border/40 pt-2">
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                        Kosten nach Schicht
                        {driverLabel && (
                          <span className="ml-2 normal-case font-normal text-amber-700 dark:text-amber-400">
                            · {driverLabel}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-4 gap-x-4 gap-y-0.5">
                        {/* Total Früh */}
                        <div className="space-y-0.5">
                          <div className="text-[9px] text-muted-foreground">☀ Früh gesamt</div>
                          <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                            CHF {stats.totalFrühCosts.toFixed(0)}
                            <span className="font-normal text-muted-foreground ml-1">({stats.totalFrühHours.toFixed(1)} h)</span>
                          </div>
                        </div>
                        {/* Total Spät */}
                        <div className="space-y-0.5">
                          <div className="text-[9px] text-muted-foreground">🌙 Spät gesamt</div>
                          <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                            CHF {stats.totalSpätCosts.toFixed(0)}
                            <span className="font-normal text-muted-foreground ml-1">({stats.totalSpätHours.toFixed(1)} h)</span>
                          </div>
                        </div>
                        {/* Service Früh/Spät */}
                        {(sc.service?.früh > 0 || sc.service?.spät > 0) && (
                          <div className="space-y-0.5">
                            <div className="text-[9px] text-muted-foreground">Service F/S</div>
                            <div className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                              {sc.service.früh.toFixed(0)} / {sc.service.spät.toFixed(0)}
                            </div>
                          </div>
                        )}
                        {/* Küche Früh/Spät */}
                        {(sc.küche?.früh > 0 || sc.küche?.spät > 0) && (
                          <div className="space-y-0.5">
                            <div className="text-[9px] text-muted-foreground">Küche F/S</div>
                            <div className="text-xs font-semibold text-orange-600 dark:text-orange-400">
                              {sc.küche.früh.toFixed(0)} / {sc.küche.spät.toFixed(0)}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* ── Section header: count + savings ────────────────── */}
              {(breakdown.length > 0 || allSuggestions.length > 0) && (
                <div style={{ flexShrink: 0, padding: '8px 20px 6px' }} className="flex items-center justify-between border-b border-border/40 bg-background">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Mitarbeiter &amp; Korrekturvorschläge
                  </span>
                  {pendingCount > 0 && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-orange-600 dark:text-orange-400">
                      <Lightbulb className="h-3.5 w-3.5" />
                      {pendingCount} Vorschlag{pendingCount !== 1 ? 'schläge' : ''} offen
                      {totalSaving > 0 && (
                        <span className="text-emerald-700 dark:text-emerald-400 ml-0.5">
                          (−CHF {totalSaving.toFixed(0)})
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}

              {/* ── Scrollable employee + suggestion list ───────────── */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px', minHeight: 0 }}>

                {/* DEBUG BANNER — remove after verification */}
                <div style={{ background: '#1e3a5f', color: '#fff', padding: '6px 10px', borderRadius: 6, marginBottom: 10, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.5 }}>
                  <div>🔍 DEBUG: breakdown={breakdown.length} | suggestions={allSuggestions.length} | map={suggestionByEmpId.size} | dismissed={dismissedIds.length}</div>
                  {allSuggestions.map(s => (
                    <div key={s.id} style={{ color: '#7dd3fc' }}>
                      ✂ {s.employeeName} → {s.actionType} | {s.savingHours.toFixed(1)}h / CHF {s.savingCost.toFixed(0)} | id: {s.employeeId}
                    </div>
                  ))}
                  {allSuggestions.length === 0 && (
                    <div style={{ color: '#fca5a5' }}>⚠ Kein konkreter Kandidat gefunden — Prüfe hourlyWage &gt; 0 und Schichtzeiten</div>
                  )}
                </div>

                <div className="space-y-2">
                  {breakdown.length === 0 && (
                    <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px', textAlign: 'center', color: '#92400e', fontSize: 13 }}>
                      ⚠ Kein konkreter Kandidat gefunden — keine Mitarbeiter mit geplanten Arbeitsstunden für diesen Tag.
                      <div style={{ fontSize: 11, marginTop: 4, color: '#a16207' }}>Prüfe ob Schichtzeiten (nicht Abwesenheiten) eingetragen sind und hourlyWage &gt; 0.</div>
                    </div>
                  )}
                  {breakdown.map(({ employee, hours, cost, shiftDisplay }) => {
                    const suggestion = suggestionByEmpId.get(employee.id);
                    const isSnoozed = suggestion ? snoozedIds.includes(suggestion.id) : false;
                    const isDismissed = suggestion ? dismissedIds.includes(suggestion.id) : false;
                    const showSuggestion = !!suggestion && !isDismissed;

                    return (
                      <div
                        key={employee.id}
                        style={{
                          borderRadius: 8,
                          overflow: 'hidden',
                          border: showSuggestion && !isSnoozed ? '2px solid #f97316' : '1px solid #e2e8f0',
                        }}
                      >
                        {/* ── Employee row ── */}
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 12px',
                          background: showSuggestion && !isSnoozed ? '#fff7ed' : '#f8fafc',
                        }}>
                          <span style={{
                            fontSize: 9,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            flexShrink: 0,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            background: employee.employmentType === 'aushilfe' ? '#ede9fe' : employee.employmentType === 'vollzeit' ? '#dbeafe' : '#f1f5f9',
                            color: employee.employmentType === 'aushilfe' ? '#7c3aed' : employee.employmentType === 'vollzeit' ? '#1d4ed8' : '#64748b',
                          }}>
                            {employee.employmentType === 'aushilfe' ? 'AH' : employee.employmentType === 'vollzeit' ? 'VZ' : employee.employmentType === 'teilzeit' ? 'TZ' : 'MJ'}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getEmployeeDisplayName(employee)}</span>
                          {shiftDisplay && (
                            <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0, fontFamily: 'monospace', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>
                              {shiftDisplay}
                            </span>
                          )}
                          <span style={{ fontSize: 11, color: '#64748b', flexShrink: 0 }}>{hours.toFixed(1)} h</span>
                          <span style={{ fontSize: 12, fontWeight: 600, flexShrink: 0, width: 72, textAlign: 'right' }}>CHF {cost.toFixed(0)}</span>
                        </div>

                        {/* ── No suggestion fallback ── */}
                        {!suggestion && (
                          <div style={{ padding: '6px 12px', fontSize: 11, color: '#94a3b8', borderTop: '1px solid #e2e8f0', background: '#f8fafc' }}>
                            Kein konkreter Kandidat — kein Vorschlag für diesen Mitarbeiter
                          </div>
                        )}

                        {/* ── KORREKTURVORSCHLAG AKTIV ── */}
                        {showSuggestion && (
                          <div style={{
                            borderTop: isSnoozed ? '1px solid #e2e8f0' : '2px solid #f97316',
                            background: isSnoozed ? '#f8fafc' : '#fff7ed',
                            padding: '10px 12px',
                            opacity: isSnoozed ? 0.7 : 1,
                          }}>
                            {/* Marker label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <span style={{ background: '#f97316', color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                KORREKTURVORSCHLAG AKTIV
                              </span>
                            </div>
                            {/* Suggestion details */}
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ flex: 1, minWidth: 200 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, color: '#c2410c', marginBottom: 2 }}>
                                  {getSuggestionActionLabel(suggestion)}
                                  {suggestion.slotDisplay && (
                                    <span style={{ fontFamily: 'monospace', fontWeight: 400, color: '#64748b', marginLeft: 8, fontSize: 11 }}>
                                      ({suggestion.slotDisplay})
                                    </span>
                                  )}
                                </div>
                                {suggestion.savingHours > 0 && (
                                  <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>
                                    Ersparnis: −{suggestion.savingHours.toFixed(1)} h
                                    {suggestion.savingCost > 0 && ` / −CHF ${suggestion.savingCost.toFixed(0)}`}
                                  </div>
                                )}
                              </div>
                              {/* Action buttons */}
                              <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                                <Button
                                  size="sm"
                                  className="h-8 px-3 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                                  onClick={() => handleApplySuggestion(suggestion, openDialogDay)}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Übernehmen
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-3 text-xs gap-1.5"
                                  onClick={() => setDismissedIds(prev => [...prev, suggestion.id])}
                                >
                                  <EyeOff className="h-3.5 w-3.5" />
                                  Ignorieren
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-3 text-xs gap-1.5 text-muted-foreground"
                                  onClick={() =>
                                    isSnoozed
                                      ? setSnoozedIds(prev => prev.filter(x => x !== suggestion.id))
                                      : setSnoozedIds(prev => [...prev, suggestion.id])
                                  }
                                >
                                  <Clock3 className="h-3.5 w-3.5" />
                                  {isSnoozed ? 'Reaktivieren' : 'Später'}
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* ── What-if revenue calculator ───────────────────── */}
                <div className="mt-4 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
                  <div className="text-[10px] font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide mb-2">
                    Umsatz-Szenario
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-xs text-muted-foreground shrink-0">
                      Nötig für {laborCostThreshold}% PKQ:{' '}
                      <span className="font-semibold text-foreground">CHF {revenueNeeded.toFixed(0)}</span>
                    </p>
                    <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                      <Label htmlFor="whatif" className="text-xs shrink-0 text-muted-foreground">Hypothetisch:</Label>
                      <div className="relative flex-1">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">CHF</span>
                        <Input
                          id="whatif"
                          type="number"
                          placeholder={revenueNeeded.toFixed(0)}
                          value={whatIfRevenue}
                          onChange={e => setWhatIfRevenue(e.target.value)}
                          className="pl-9 h-8 text-xs"
                        />
                      </div>
                      {whatIfPkq !== null && (
                        <div className={cn(
                          "text-xs font-bold px-2 py-1 rounded shrink-0",
                          whatIfPkq <= laborCostThreshold
                            ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
                            : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                        )}>
                          PKQ: {whatIfPkq.toFixed(1)}%
                          {whatIfPkq <= laborCostThreshold ? ' ✓' : ' ✗'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </DialogContent>
        </Dialog>
      );
    })()}
    </div>
  );
};
