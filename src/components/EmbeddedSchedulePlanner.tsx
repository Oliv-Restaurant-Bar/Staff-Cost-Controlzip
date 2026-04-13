import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Download, Upload, Save, Users, Clock, 
  AlertTriangle, CheckCircle, Copy, Printer, Calendar, CalendarDays, 
  Eye, EyeOff, Euro, Lock, Pencil, Trash2, CalendarOff, FileSpreadsheet,
  ChevronDown, ChevronLeft, ChevronRight, Settings, Loader2, RefreshCw
} from 'lucide-react';
import { Employee, Department } from '@/types/personnel';
import { ScheduleGrid, DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';
import { ActualHoursGrid, ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { EmployeeHoursSummary } from '@/components/schedule-planner/EmployeeHoursSummary';
import { ShiftLegend } from '@/components/schedule-planner/ShiftLegend';
import { AddAushilfeDialog } from '@/components/schedule-planner/AddAushilfeDialog';
import { CopyWeekDialog } from '@/components/schedule-planner/CopyWeekDialog';
import { PrintScheduleDialog } from '@/components/schedule-planner/PrintScheduleDialog';
import { DayDetailDialog } from '@/components/schedule-planner/DayDetailDialog';
import { ShiftConfigDialog } from '@/components/schedule-planner/ShiftConfigDialog';
import { DaysOffConfigDialog } from '@/components/schedule-planner/DaysOffConfigDialog';
import { Apply8HoursDialog, getPreferredWeekdaysFromDates } from '@/components/schedule-planner/Apply8HoursDialog';
import { MonthlyCostSummary } from '@/components/schedule-planner/MonthlyCostSummary';
import { ExportOptionsDialog, ExportOptions } from '@/components/schedule-planner/ExportOptionsDialog';
import { ImportMatchPreviewDialog, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { SimpleKüchenplanImportDialog } from '@/components/schedule-planner/SimpleKüchenplanImportDialog';
import { LaborCostComparison } from '@/components/schedule-planner/LaborCostComparison';
import { EmployeeForm } from '@/components/EmployeeForm';
import { importScheduleFromExcelV2, NameMatchInfo } from '@/lib/schedule-export-import';
import { exportScheduleToExcelPrint, exportScheduleToPDFPrint, PrintExportOptions } from '@/lib/schedule-print-export';
import { toast } from 'sonner';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, startOfWeek, endOfWeek, isWithinInterval, getISOWeek, isSameMonth } from 'date-fns';
import { getMonthlyBudgetRevenue, distributeBudgetByWeekday } from '@/lib/budgetDistribution';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useShiftConfig, ShiftConfigItem, calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { useWeekSync } from '@/hooks/useWeekSync';
import { useSupabaseSchedule, Employee as SupabaseEmployee } from '@/hooks/useSupabaseSchedule';
import { saveActualHourEntry } from '@/lib/supabase-db';
import { Input } from '@/components/ui/input';
import { formatCurrency } from '@/lib/personnel-utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
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

type ViewMode = Department | 'all';
type CalendarView = 'month' | 'week';

interface EmbeddedSchedulePlannerProps {
  selectedDate: Date;
}

// Convert Supabase employee to local Employee type
const toLocalEmployee = (emp: SupabaseEmployee): Employee => ({
  id: emp.id,
  name: emp.name,
  department: emp.department,
  employmentType: emp.employmentType,
  hourlyWage: emp.hourlyWage,
  weeklyHours: emp.weeklyHours,
  monthlySalary: emp.monthlySalary,
  monthlySalaryWith13th: emp.monthlySalaryWith13th,
  daysOff: emp.daysOff as any,
  preferredWorkDays: emp.preferredWorkDays as any,
});

export const EmbeddedSchedulePlanner = ({ selectedDate }: EmbeddedSchedulePlannerProps) => {
  const { shifts, shiftMap, updateShifts } = useShiftConfig();
  const { currentWeekStart, currentMonthStart, weekNumber, monthLabel, navigateWeek, navigateMonth } = useWeekSync('EmbeddedSchedulePlanner', selectedDate);
  
  // Use Supabase hook for employees and schedule
  const {
    employees: supabaseEmployees,
    scheduleData,
    isLoading,
    error,
    isAdmin,
    canEdit,
    addEmployee: addSupabaseEmployee,
    updateEmployee: updateSupabaseEmployee,
    deleteEmployee: deleteSupabaseEmployee,
    updateScheduleEntry,
    saveSchedule,
    refresh,
  } = useSupabaseSchedule({
    currentMonth: currentMonthStart,
  });

  // Convert to local Employee type
  const employees = useMemo(() => 
    supabaseEmployees.map(toLocalEmployee),
    [supabaseEmployees]
  );
  
  const [activeDepartment, setActiveDepartment] = useState<ViewMode>('service');
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  const [copyWeekDialogOpen, setCopyWeekDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [dayDetailDialogOpen, setDayDetailDialogOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [shiftConfigDialogOpen, setShiftConfigDialogOpen] = useState(false);
  const [daysOffDialogOpen, setDaysOffDialogOpen] = useState(false);
  const [selectedEmployeeForDaysOff, setSelectedEmployeeForDaysOff] = useState<Employee | null>(null);
  const [apply8HoursDialogOpen, setApply8HoursDialogOpen] = useState(false);
  const [selectedEmployeeFor8Hours, setSelectedEmployeeFor8Hours] = useState<Employee | null>(null);
  const [employeeFormOpen, setEmployeeFormOpen] = useState(false);
  const [selectedEmployeeForEdit, setSelectedEmployeeForEdit] = useState<Employee | null>(null);
  const [showFooter, setShowFooter] = useState(true);
  const [showCosts, setShowCosts] = useState(false);
  const [costPasswordDialogOpen, setCostPasswordDialogOpen] = useState(false);
  const [costPassword, setCostPassword] = useState('');
  const [dailyBudgets, setDailyBudgets] = useState<{[key: string]: { plannedRevenue?: number; actualRevenue?: number; isOverride?: boolean }}>({});
  const [isExpanded, setIsExpanded] = useState(true);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [simpleKüchenImportOpen, setSimpleKüchenImportOpen] = useState(false);
  const [pendingImportResult, setPendingImportResult] = useState<{
    scheduleData: Record<string, DaySchedule>;
    newEmployees: Employee[];
    nameMatches: NameMatchInfo[];
  } | null>(null);
  
  // Plan/Ist Toggle State
  const [scheduleMode, setScheduleMode] = useState<'plan' | 'ist'>('plan');
  const [actualHoursData, setActualHoursData] = useState<Record<string, ActualHoursEntry>>({});
  
  const ADMIN_PASSWORD_KEY = 'admin_password';
  const DEFAULT_ADMIN_PASSWORD = 'admin123';

  // Load daily budgets (aus Monatsbudget + localStorage-Overrides) und actual hours
  useEffect(() => {
    const year         = currentMonthStart.getFullYear();
    const monthIdx     = currentMonthStart.getMonth();
    const monthlyRev   = getMonthlyBudgetRevenue(year, monthIdx);
    const allDays      = eachDayOfInterval({
      start: startOfMonth(currentMonthStart),
      end:   endOfMonth(currentMonthStart),
    });
    const savedBudgets = localStorage.getItem('dailyBudgets');
    const manualBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }> =
      savedBudgets ? JSON.parse(savedBudgets) : {};

    const revenueOverrides: Record<string, number> =
      JSON.parse(localStorage.getItem('dailyRevenueOverrides') || '{}');

    if (monthlyRev > 0) {
      const auto = distributeBudgetByWeekday(monthlyRev, allDays);
      const merged: Record<string, { plannedRevenue?: number; actualRevenue?: number; isOverride?: boolean }> = { ...auto };
      Object.entries(manualBudgets).forEach(([k, v]) => {
        if (v.actualRevenue !== undefined) merged[k] = { ...merged[k], actualRevenue: v.actualRevenue };
      });
      Object.entries(revenueOverrides).forEach(([k, v]) => {
        merged[k] = { ...merged[k], plannedRevenue: v, isOverride: true };
      });
      setDailyBudgets(merged);
    } else {
      const merged: Record<string, { plannedRevenue?: number; actualRevenue?: number; isOverride?: boolean }> = savedBudgets ? { ...manualBudgets } : {};
      Object.entries(revenueOverrides).forEach(([k, v]) => {
        merged[k] = { ...merged[k], plannedRevenue: v, isOverride: true };
      });
      setDailyBudgets(merged);
    }
    
    // Load actual hours for current month AND adjacent months (for week views spanning month boundaries)
    const currentMonthKey = format(currentMonthStart, 'yyyy-MM');
    const prevMonthKey = format(subMonths(currentMonthStart, 1), 'yyyy-MM');
    const nextMonthKey = format(addMonths(currentMonthStart, 1), 'yyyy-MM');
    
    const allActualHours: Record<string, ActualHoursEntry> = {};
    
    // Load previous month
    try {
      const prevData = localStorage.getItem(`actual-hours-${prevMonthKey}`);
      if (prevData) Object.assign(allActualHours, JSON.parse(prevData));
    } catch (e) { /* ignore */ }
    
    // Load current month
    try {
      const currentData = localStorage.getItem(`actual-hours-${currentMonthKey}`);
      if (currentData) Object.assign(allActualHours, JSON.parse(currentData));
    } catch (e) { /* ignore */ }
    
    // Load next month
    try {
      const nextData = localStorage.getItem(`actual-hours-${nextMonthKey}`);
      if (nextData) Object.assign(allActualHours, JSON.parse(nextData));
    } catch (e) { /* ignore */ }
    
    setActualHoursData(allActualHours);
  }, [currentMonthStart]);

  const monthStart = startOfMonth(currentMonthStart);
  const monthEnd = endOfMonth(currentMonthStart);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const weeksInMonth = eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 });

  // Calculate selectedWeekIndex from currentWeekStart synced via hook
  const selectedWeekIndex = useMemo(() => {
    const idx = weeksInMonth.findIndex(weekStart => 
      weekStart.getTime() === currentWeekStart.getTime()
    );
    return idx >= 0 ? idx : 0;
  }, [weeksInMonth, currentWeekStart]);

  const displayDays = calendarView === 'month' 
    ? daysInMonth 
    : (() => {
        const weekStart = weeksInMonth[selectedWeekIndex] || weeksInMonth[0];
        const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
        // Show all 7 days of the week including Sunday, even if it's in the next/previous month
        return eachDayOfInterval({ start: weekStart, end: weekEnd });
      })();

  const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
    if (!slot?.start || !slot?.end) return 0;
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24;
    return Math.round(hours * 100) / 100;
  };

  const calculateDayHours = (daySchedule: DaySchedule): number => {
    const frühHours = calculateSlotHours(daySchedule.früh);
    const spätHours = calculateSlotHours(daySchedule.spät);
    const totalGross = frühHours + spätHours;
    const breakDeduction = calculateBreakDeduction(totalGross);
    return Math.round((totalGross - breakDeduction) * 100) / 100;
  };

  const calculateEmployeeHours = (employeeId: string): number => {
    let totalHours = 0;
    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        const getAbsenceHours = (abbrev: string | null | undefined): number => {
          if (!abbrev) return 0;
          const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
          if (shift && shiftMap[shift].countsToTarget) return shiftMap[shift].hours;
          return 0;
        };
        
        if (daySchedule.frühAbsence) totalHours += getAbsenceHours(daySchedule.frühAbsence);
        if (daySchedule.spätAbsence) totalHours += getAbsenceHours(daySchedule.spätAbsence);
        totalHours += calculateDayHours(daySchedule);
      }
    });
    return totalHours;
  };

  const calculateWeeklyHours = (employeeId: string, weekEndDate: Date): number => {
    const weekStart = startOfWeek(weekEndDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(weekEndDate, { weekStartsOn: 1 });
    const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });
    
    let totalHours = 0;
    weekDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        const getAbsenceHours = (abbrev: string | null | undefined): number => {
          if (!abbrev) return 0;
          const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
          if (shift && shiftMap[shift].countsToTarget) return shiftMap[shift].hours;
          return 0;
        };
        
        if (daySchedule.frühAbsence) totalHours += getAbsenceHours(daySchedule.frühAbsence);
        if (daySchedule.spätAbsence) totalHours += getAbsenceHours(daySchedule.spätAbsence);
        totalHours += calculateDayHours(daySchedule);
      }
    });
    return totalHours;
  };

  const getMonthlyTargetHours = (employee: Employee): number => {
    if (employee.weeklyHours) return employee.weeklyHours * 4.33;
    switch (employee.employmentType) {
      case 'vollzeit': return 42 * 4.33;
      case 'teilzeit': return 25 * 4.33;
      case 'minijob': return 10 * 4.33;
      case 'aushilfe': return 15 * 4.33;
      default: return 40 * 4.33;
    }
  };

  const getWeeklyTargetHours = (employee: Employee): number => {
    if (employee.weeklyHours) return employee.weeklyHours;
    switch (employee.employmentType) {
      case 'vollzeit': return 42;
      case 'teilzeit': return 25;
      case 'minijob': return 10;
      case 'aushilfe': return 15;
      default: return 40;
    }
  };

  // Calculate actual hours for an employee (from actualHoursData)
  const calculateEmployeeActualHours = (employeeId: string): number => {
    let totalHours = 0;
    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const entry = actualHoursData[cellKey];
      if (entry?.hours) {
        totalHours += entry.hours;
      }
    });
    return totalHours;
  };

  // Handle actual hours change
  const handleActualHoursChange = (employeeId: string, date: string, entry: ActualHoursEntry | null) => {
    const cellKey = `${employeeId}-${date}`;

    // FIX: derive the month key from the *entry date*, not from currentMonthStart.
    // In week view a week can span month boundaries, so currentMonthStart can be
    // a different month than the day being edited.  Saving to the wrong key is what
    // caused Ist-Stunden to disappear in PersonalFix.
    const entryMonthKey = date.slice(0, 7); // "YYYY-MM" from "YYYY-MM-DD"

    setActualHoursData(prev => {
      const newState = { ...prev };
      if (entry === null) {
        delete newState[cellKey];
      } else {
        newState[cellKey] = entry;
      }

      // FIX: save ONLY entries that belong to entryMonthKey to that month's key.
      // The old code wrote the entire merged state (prev + current + next month)
      // to one key, polluting it with other months' data and causing PersonalFix
      // to over- or under-count hours.
      const monthEntries: Record<string, ActualHoursEntry> = {};
      for (const [k, v] of Object.entries(newState)) {
        // key format: "{employeeId}-YYYY-MM-DD" → last 10 chars are the date
        if (k.slice(-10, -3) === entryMonthKey) {
          monthEntries[k] = v;
        }
      }
      localStorage.setItem(`actual-hours-${entryMonthKey}`, JSON.stringify(monthEntries));

      // FE/K/F absences are localStorage-only — Supabase has no absenceType column.
      // Sending hours=0 to Supabase would lose the absenceType on reload from a fresh
      // session (different device / cleared localStorage), wiping the vacation entry.
      if (entry && entry.absenceType) {
        console.log(`[FERIEN-IST] EmbeddedSchedulePlanner: skipped Supabase for absence entry ${employeeId} ${date} type=${entry.absenceType}`);
      } else {
        saveActualHourEntry(employeeId, date, entry).catch(err =>
          console.error('[IST] Supabase saveActualHourEntry failed:', err)
        );
      }

      console.log(
        `[IST] saved entry: empId=${employeeId} date=${date} monthKey=${entryMonthKey}`,
        `entries in month: ${Object.keys(monthEntries).length}`,
        entry ? `hours=${entry.hours}` : 'deleted',
      );

      // Dispatch event for sync
      window.dispatchEvent(new CustomEvent('schedule-updated'));

      return newState;
    });
  };

  const handleSlotChange = async (
    employeeId: string, 
    date: string, 
    slotType: 'früh' | 'spät', 
    value: TimeSlot | null, 
    absenceType?: string | null
  ) => {
    // Use Supabase to update the schedule entry
    await updateScheduleEntry(employeeId, date, slotType, value, absenceType);
  };

  const handleAddAushilfe = async (employee: Omit<Employee, 'id'>) => {
    await addSupabaseEmployee(employee);
  };

  const handleRemoveEmployee = async (employeeId: string) => {
    await deleteSupabaseEmployee(employeeId);
  };

  const handleSave = async () => {
    await saveSchedule();
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Prepare export days based on range option
  const getExportDays = (options: ExportOptions): Date[] => {
    if (options.range === 'week') {
      const weekStart = weeksInMonth[selectedWeekIndex] || weeksInMonth[0];
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      return eachDayOfInterval({ start: weekStart, end: weekEnd });
    } else if (options.range === 'custom' && options.customStartDate && options.customEndDate) {
      return eachDayOfInterval({ start: options.customStartDate, end: options.customEndDate });
    }
    return daysInMonth;
  };

  const handleExportWithRange = async (options: ExportOptions) => {
    try {
      const exportDays = getExportDays(options);
      const isWeekExport = options.range === 'week';
      
      const printOptions: PrintExportOptions = {
        employees,
        scheduleData,
        actualHoursData,
        currentMonth: currentMonthStart,
        days: exportDays,
        hoursType: options.hoursType || 'plan',
        includeCosts: options.includeCosts ?? true,
        isWeekExport
      };

      // Export Excel with new print-optimized format
      await exportScheduleToExcelPrint(printOptions);
      
      const hoursLabel = options.hoursType === 'ist' ? 'Ist-Stunden' 
        : options.hoursType === 'both' ? 'Plan + Ist' 
        : 'Plan-Stunden';
      const successMsg = options.range === 'week' 
        ? `Woche (${hoursLabel}) erfolgreich exportiert` 
        : options.range === 'custom'
          ? `Zeitraum (${hoursLabel}) erfolgreich exportiert`
          : `Dienstplan (${hoursLabel}) erfolgreich exportiert`;
      toast.success(successMsg);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Fehler beim Export');
    }
  };

  const handleExportPDF = async (options?: ExportOptions) => {
    try {
      const exportDays = options ? getExportDays(options) : daysInMonth;
      const isWeekExport = options?.range === 'week';
      
      const printOptions: PrintExportOptions = {
        employees,
        scheduleData,
        actualHoursData,
        currentMonth: currentMonthStart,
        days: exportDays,
        hoursType: options?.hoursType || 'plan',
        includeCosts: options?.includeCosts ?? showCosts,
        isWeekExport
      };

      await exportScheduleToPDFPrint(printOptions);
      toast.success('PDF erfolgreich exportiert');
    } catch (error) {
      console.error('PDF Export error:', error);
      toast.error('Fehler beim PDF-Export');
    }
  };

  const handleExportTemplate = () => {
    setExportDialogOpen(true);
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = await importScheduleFromExcelV2(file, employees, currentMonthStart, scheduleData);
      
      // Show preview dialog with name matches
      if (result.nameMatches.length > 0) {
        setPendingImportResult({
          scheduleData: result.scheduleData,
          newEmployees: result.newEmployees,
          nameMatches: result.nameMatches
        });
        setImportPreviewOpen(true);
      } else {
        applyImportResult(result.scheduleData, result.newEmployees);
      }
    } catch (error) {
      toast.error('Fehler beim Importieren');
    }
    event.target.value = '';
  };

  const applyImportResult = async (newScheduleData: Record<string, DaySchedule>, newEmployees: Employee[]) => {
    // Add new employees to Supabase
    if (newEmployees?.length) {
      for (const emp of newEmployees) {
        await addSupabaseEmployee(emp);
      }
      toast.success(`${newEmployees.length} neue Mitarbeiter hinzugefügt`);
    }
    
    // Update schedule entries in Supabase
    for (const [key, schedule] of Object.entries(newScheduleData)) {
      const parts = key.split('-');
      const employeeId = parts[0];
      const date = parts.slice(1).join('-');
      
      if (schedule.früh || schedule.frühAbsence) {
        await updateScheduleEntry(employeeId, date, 'früh', schedule.früh || null, schedule.frühAbsence);
      }
      if (schedule.spät || schedule.spätAbsence) {
        await updateScheduleEntry(employeeId, date, 'spät', schedule.spät || null, schedule.spätAbsence);
      }
    }
    
    toast.success('Dienstplan erfolgreich importiert');
    await refresh();
  };

  // ── Einfacher Küchenplan PDF-Import ─────────────────────────────────────────
  const handleSimpleKüchenImport = async (delta: Record<string, DaySchedule>, count: number) => {
    for (const [key, ds] of Object.entries(delta)) {
      const parts = key.split('-');
      const employeeId = parts[0];
      const date = parts.slice(1).join('-');
      if (ds.früh) {
        await updateScheduleEntry(employeeId, date, 'früh', ds.früh, ds.frühAbsence ?? null);
      }
      if (ds.spät) {
        await updateScheduleEntry(employeeId, date, 'spät', ds.spät, ds.spätAbsence ?? null);
      }
    }
    toast.success(`Küchenplan importiert: ${count} Einträge übernommen`);
    await refresh();
  };

  const handleConfirmImport = (overrides: NameMatchOverride[]) => {
    if (!pendingImportResult) return;
    
    const skippedNames = new Set<string>();
    const newEmployeeNames = new Set<string>();
    const nameToEmployeeMap = new Map<string, string>();
    
    overrides.forEach(override => {
      if (override.selectedEmployeeId === 'skip') {
        skippedNames.add(override.importedName.toLowerCase());
      } else if (override.selectedEmployeeId === 'new') {
        newEmployeeNames.add(override.importedName.toLowerCase());
      } else {
        nameToEmployeeMap.set(override.importedName.toLowerCase(), override.selectedEmployeeId);
      }
    });
    
    const employeesToAdd = pendingImportResult.newEmployees.filter(emp => 
      newEmployeeNames.has(emp.name.toLowerCase())
    );
    
    const filteredScheduleData: Record<string, DaySchedule> = {};
    Object.entries(pendingImportResult.scheduleData).forEach(([key, value]) => {
      const matchInfo = pendingImportResult.nameMatches.find(m => {
        const matchedId = m.matchedEmployee?.id || pendingImportResult.newEmployees.find(e => e.name.toLowerCase() === m.importedName.toLowerCase())?.id;
        return key.startsWith(matchedId + '-');
      });
      
      if (matchInfo && skippedNames.has(matchInfo.importedName.toLowerCase())) return;
      filteredScheduleData[key] = value;
    });
    
    applyImportResult({ ...scheduleData, ...filteredScheduleData }, employeesToAdd);
    setImportPreviewOpen(false);
    setPendingImportResult(null);
  };

  const handleCancelImport = () => {
    setImportPreviewOpen(false);
    setPendingImportResult(null);
    toast.info('Import abgebrochen');
  };

  const handleDayClick = (day: Date) => {
    setSelectedDay(day);
    setDayDetailDialogOpen(true);
  };

  const handleUpdatePlannedRevenue = (dateStr: string, value: number | null) => {
    const overrides: Record<string, number> =
      JSON.parse(localStorage.getItem('dailyRevenueOverrides') || '{}');
    if (value === null) {
      delete overrides[dateStr];
      localStorage.setItem('dailyRevenueOverrides', JSON.stringify(overrides));
      // Zurück auf Auto-Wert: Monats-Distribution neu berechnen
      const [y, m, d] = dateStr.split('-').map(Number);
      const day = new Date(y, m - 1, d);
      const monthlyRev = getMonthlyBudgetRevenue(y, m - 1);
      if (monthlyRev > 0) {
        const allDays = eachDayOfInterval({ start: startOfMonth(day), end: endOfMonth(day) });
        const auto = distributeBudgetByWeekday(monthlyRev, allDays);
        setDailyBudgets(prev => ({
          ...prev,
          [dateStr]: { ...prev[dateStr], plannedRevenue: auto[dateStr]?.plannedRevenue, isOverride: false },
        }));
      } else {
        setDailyBudgets(prev => {
          const next = { ...prev };
          delete next[dateStr];
          return next;
        });
      }
    } else {
      overrides[dateStr] = value;
      localStorage.setItem('dailyRevenueOverrides', JSON.stringify(overrides));
      setDailyBudgets(prev => ({
        ...prev,
        [dateStr]: { ...prev[dateStr], plannedRevenue: value, isOverride: true },
      }));
    }
  };

  const handleConfigureDaysOff = (employee: Employee) => {
    setSelectedEmployeeForDaysOff(employee);
    setDaysOffDialogOpen(true);
  };

  type DayOfWeek = 'montag' | 'dienstag' | 'mittwoch' | 'donnerstag' | 'freitag' | 'samstag' | 'sonntag';

  const handleSaveDaysOff = async (employeeId: string, daysOff: DayOfWeek[]) => {
    const emp = employees.find(e => e.id === employeeId);
    if (emp) {
      await updateSupabaseEmployee({ ...emp, daysOff } as any);
    }
  };

  const handleOpen8HoursDialog = (employee: Employee) => {
    setSelectedEmployeeFor8Hours(employee);
    setApply8HoursDialogOpen(true);
  };

  const handleConfirm8Hours = async (selectedDays: Date[], saveAsPreferred: boolean, hoursValue: string = '8.5') => {
    if (!selectedEmployeeFor8Hours) return;
    
    for (const day of selectedDays) {
      const dateStr = format(day, 'yyyy-MM-dd');
      await handleSlotChange(selectedEmployeeFor8Hours.id, dateStr, 'früh', null, hoursValue);
      await handleSlotChange(selectedEmployeeFor8Hours.id, dateStr, 'spät', null, null);
    }
    
    // Save preferred days if requested
    if (saveAsPreferred) {
      const preferredWorkDays = getPreferredWeekdaysFromDates(selectedDays);
      await updateSupabaseEmployee({ 
        ...selectedEmployeeFor8Hours, 
        preferredWorkDays 
      } as any);
      toast.success(`${hoursValue}h für ${selectedEmployeeFor8Hours.name} eingetragen (${selectedDays.length} Tage) - Bevorzugte Tage gespeichert`);
    } else {
      toast.success(`${hoursValue}h für ${selectedEmployeeFor8Hours.name} eingetragen (${selectedDays.length} Tage)`);
    }
    
    setSelectedEmployeeFor8Hours(null);
  };

  const handleEditEmployee = (employee: Employee) => {
    setSelectedEmployeeForEdit(employee);
    setEmployeeFormOpen(true);
  };

  const handleEmployeeFormSubmit = async (employeeData: Omit<Employee, 'id'> | Employee) => {
    if ('id' in employeeData) {
      await updateSupabaseEmployee(employeeData as any);
    } else {
      await addSupabaseEmployee(employeeData);
    }
    setSelectedEmployeeForEdit(null);
  };

  const filteredEmployees = activeDepartment === 'all' 
    ? employees 
    : employees.filter(e => e.department === activeDepartment);

  const employeeSummaries = employees.map(emp => {
    const plannedHours = calculateEmployeeHours(emp.id);
    const targetHours = getMonthlyTargetHours(emp);
    const difference = plannedHours - targetHours;
    
    let status: 'ok' | 'under' | 'over' | 'warning';
    if (difference > 5) status = 'over';
    else if (difference >= -5) status = 'ok';
    else if (difference >= -10) status = 'warning';
    else status = 'under';
    
    return { employee: emp, plannedHours, targetHours, difference, percentage: (plannedHours / targetHours) * 100, status };
  });

  const departmentSummaries = activeDepartment === 'all' 
    ? employeeSummaries 
    : employeeSummaries.filter(s => s.employee.department === activeDepartment);

  const departmentEmployeeCount = filteredEmployees.length;
  const departmentPlannedHours = departmentSummaries.reduce((sum, s) => sum + s.plannedHours, 0);
  const departmentOkCount = departmentSummaries.filter(s => s.status === 'ok').length;
  const departmentWarningCount = departmentSummaries.filter(s => s.status !== 'ok').length;
  const overhoursEmployees = employeeSummaries.filter(s => s.status === 'over');

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <Card className="border-primary/20">
        <CardHeader className="py-3">
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center justify-between cursor-pointer group">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5 text-primary" />
                Dienstplan - {format(currentMonthStart, 'MMMM yyyy', { locale: de })}
              </CardTitle>
              <ChevronDown className={cn(
                "h-5 w-5 text-muted-foreground transition-transform",
                isExpanded && "rotate-180"
              )} />
            </div>
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            {/* Loading State */}
            {isLoading && (
              <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Lade Dienstplan...</span>
              </div>
            )}
            
            {/* Error State */}
            {error && (
              <div className="flex items-center justify-center py-4 gap-2 text-destructive bg-destructive/10 rounded-lg p-3">
                <AlertTriangle className="h-5 w-5" />
                <span>{error}</span>
                <Button variant="outline" size="sm" onClick={() => refresh()}>
                  Erneut versuchen
                </Button>
              </div>
            )}
            
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {/* Plan/Ist Toggle */}
                <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
                  <Button
                    variant={scheduleMode === 'plan' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setScheduleMode('plan')}
                    className="h-7 px-2 text-xs"
                  >
                    Plan
                  </Button>
                  <Button
                    variant={scheduleMode === 'ist' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setScheduleMode('ist')}
                    className={cn(
                      "h-7 px-2 text-xs",
                      scheduleMode === 'ist' && "bg-green-600 hover:bg-green-700"
                    )}
                  >
                    Ist
                  </Button>
                </div>
                
                <Button
                  variant={showCosts ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => showCosts ? setShowCosts(false) : setCostPasswordDialogOpen(true)}
                  className="h-8 gap-1"
                >
                  {showCosts ? <Euro className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">Kosten</span>
                </Button>
                
                <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
                  <Button
                    variant={calendarView === 'week' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setCalendarView('week')}
                    className="h-7 px-2 gap-1 text-xs"
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    <span>Woche</span>
                  </Button>
                  <Button
                    variant={calendarView === 'month' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setCalendarView('month')}
                    className="h-7 px-2 gap-1 text-xs"
                  >
                    <CalendarDays className="h-3.5 w-3.5" />
                    <span>Monat</span>
                  </Button>
                </div>
              </div>

              {/* Period Navigator */}
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => calendarView === 'week' ? navigateWeek('prev') : navigateMonth('prev')}
                  title={calendarView === 'week' ? 'Vorherige Woche' : 'Vorheriger Monat'}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div className="flex flex-col items-center min-w-[120px]">
                  <span className="text-sm font-medium leading-tight">
                    {calendarView === 'week' ? `KW ${weekNumber}` : monthLabel}
                  </span>
                  <span className="text-xs text-muted-foreground leading-tight">
                    {calendarView === 'week'
                      ? `${format(displayDays[0], 'd. MMM', { locale: de })} – ${format(displayDays[displayDays.length - 1], 'd. MMM yy', { locale: de })}`
                      : `${format(startOfMonth(currentMonthStart), 'd.', { locale: de })} – ${format(endOfMonth(currentMonthStart), 'd. MMM yyyy', { locale: de })}`
                    }
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => calendarView === 'week' ? navigateWeek('next') : navigateMonth('next')}
                  title={calendarView === 'week' ? 'Nächste Woche' : 'Nächster Monat'}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => refresh()} 
                  disabled={isLoading}
                  className="h-8"
                  title="Daten aktualisieren"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                </Button>
                <input type="file" ref={fileInputRef} onChange={handleImportFile} accept=".xlsx,.xls" className="hidden" />
                <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} className="h-8 gap-1" title="Excel importieren">
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSimpleKüchenImportOpen(true)}
                  className="h-8 gap-1 text-orange-600 hover:text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                  title="Küchenplan PDF importieren"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline text-xs">Küchenplan</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={handleExportTemplate} className="h-8 gap-1" title="Exportieren">
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPrintDialogOpen(true)} className="h-8">
                  <Printer className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCopyWeekDialogOpen(true)} className="h-8">
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" onClick={handleSave} className="h-8 gap-1">
                  <Save className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Speichern</span>
                </Button>
              </div>
            </div>

            {/* Department Toggle */}
            <div className="flex items-center justify-center gap-2">
              <Button
                variant={activeDepartment === 'service' ? 'default' : 'outline'}
                onClick={() => setActiveDepartment('service')}
                size="sm"
              >
                <span className={cn("w-2 h-2 rounded-full mr-1.5", activeDepartment === 'service' ? "bg-white" : "bg-blue-500")} />
                Service
              </Button>
              <Button
                variant={activeDepartment === 'küche' ? 'default' : 'outline'}
                onClick={() => setActiveDepartment('küche')}
                size="sm"
              >
                <span className={cn("w-2 h-2 rounded-full mr-1.5", activeDepartment === 'küche' ? "bg-white" : "bg-orange-500")} />
                Küche
              </Button>
              <Button
                variant={activeDepartment === 'all' ? 'default' : 'outline'}
                onClick={() => setActiveDepartment('all' as Department)}
                size="sm"
              >
                <Users className="h-3.5 w-3.5 mr-1.5" />
                Alle
              </Button>
              {activeDepartment !== 'all' && (
                <AddAushilfeDialog department={activeDepartment} onAdd={handleAddAushilfe} />
              )}
            </div>

            {/* Summary Stats */}
            <div className="grid grid-cols-4 gap-2">
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
                <Users className="h-4 w-4 text-primary" />
                <div>
                  <p className="text-lg font-bold">{departmentEmployeeCount}</p>
                  <p className="text-xs text-muted-foreground">MA</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
                <Clock className="h-4 w-4 text-blue-500" />
                <div>
                  <p className="text-lg font-bold">{departmentPlannedHours.toFixed(0)}h</p>
                  <p className="text-xs text-muted-foreground">Geplant</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <div>
                  <p className="text-lg font-bold">{departmentOkCount}</p>
                  <p className="text-xs text-muted-foreground">OK</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <div>
                  <p className="text-lg font-bold">{departmentWarningCount}</p>
                  <p className="text-xs text-muted-foreground">Warnung</p>
                </div>
              </div>
            </div>

            {/* Overhours Warning */}
            {overhoursEmployees.length > 0 && (
              <div className="rounded-lg p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                <div className="flex items-center gap-2 text-red-700 dark:text-red-400 text-sm font-medium mb-1">
                  <AlertTriangle className="h-4 w-4" />
                  Überstunden ({overhoursEmployees.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {overhoursEmployees.slice(0, 3).map(({ employee, difference }) => (
                    <span key={employee.id} className="text-xs bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 px-2 py-0.5 rounded">
                      {employee.name}: +{difference.toFixed(1)}h
                    </span>
                  ))}
                  {overhoursEmployees.length > 3 && (
                    <span className="text-xs text-red-600">+{overhoursEmployees.length - 3} weitere</span>
                  )}
                </div>
              </div>
            )}

            {/* Shift Legend - only show in Plan mode */}
            {scheduleMode === 'plan' && (
              <ShiftLegend 
                onEditClick={() => setShiftConfigDialogOpen(true)} 
                department={activeDepartment === 'all' ? 'all' : activeDepartment as 'service' | 'küche'}
              />
            )}

            {/* Schedule Grid - Plan or Ist mode */}
            <div className="border rounded-lg overflow-hidden">
              {scheduleMode === 'plan' ? (
                // Plan Grid
                activeDepartment === 'all' ? (
                  <div className="space-y-4 p-2">
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-2">
                        <span className="w-2 h-2 rounded-full bg-blue-500" />
                        <span className="text-sm font-medium">Service</span>
                      </div>
                      <ScheduleGrid
                        employees={employees.filter(e => e.department === 'service')}
                        days={displayDays}
                        scheduleData={scheduleData}
                        onSlotChange={handleSlotChange}
                        onRemoveEmployee={handleRemoveEmployee}
                        onConfigureDaysOff={handleConfigureDaysOff}
                        onOpen8HoursDialog={handleOpen8HoursDialog}
                        getEmployeeHours={calculateEmployeeHours}
                        getTargetHours={getMonthlyTargetHours}
                        getWeeklyHours={calculateWeeklyHours}
                        getWeeklyTargetHours={getWeeklyTargetHours}
                        onDayClick={handleDayClick}
                        showFooter={showFooter}
                        showCosts={showCosts}
                        dailyBudgets={dailyBudgets}
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-2">
                        <span className="w-2 h-2 rounded-full bg-orange-500" />
                        <span className="text-sm font-medium">Küche</span>
                      </div>
                      <ScheduleGrid
                        employees={employees.filter(e => e.department === 'küche')}
                        days={displayDays}
                        scheduleData={scheduleData}
                        onSlotChange={handleSlotChange}
                        onRemoveEmployee={handleRemoveEmployee}
                        onConfigureDaysOff={handleConfigureDaysOff}
                        onOpen8HoursDialog={handleOpen8HoursDialog}
                        getEmployeeHours={calculateEmployeeHours}
                        getTargetHours={getMonthlyTargetHours}
                        getWeeklyHours={calculateWeeklyHours}
                        getWeeklyTargetHours={getWeeklyTargetHours}
                        onDayClick={handleDayClick}
                        showFooter={showFooter}
                        showCosts={showCosts}
                        dailyBudgets={dailyBudgets}
                      />
                    </div>
                  </div>
                ) : (
                  <ScheduleGrid
                    employees={filteredEmployees}
                    days={displayDays}
                    scheduleData={scheduleData}
                    onSlotChange={handleSlotChange}
                    onRemoveEmployee={handleRemoveEmployee}
                    onConfigureDaysOff={handleConfigureDaysOff}
                    onOpen8HoursDialog={handleOpen8HoursDialog}
                    getEmployeeHours={calculateEmployeeHours}
                    getTargetHours={getMonthlyTargetHours}
                    getWeeklyHours={calculateWeeklyHours}
                    getWeeklyTargetHours={getWeeklyTargetHours}
                    onDayClick={handleDayClick}
                    showFooter={showFooter}
                    showCosts={showCosts}
                    dailyBudgets={dailyBudgets}
                  />
                )
              ) : (
                // Ist Grid
                activeDepartment === 'all' ? (
                  <div className="space-y-4 p-2">
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-2">
                        <span className="w-2 h-2 rounded-full bg-blue-500" />
                        <span className="text-sm font-medium">Service - Ist</span>
                      </div>
                      <ActualHoursGrid
                        employees={employees.filter(e => e.department === 'service')}
                        days={displayDays}
                        actualHoursData={actualHoursData}
                        onHoursChange={handleActualHoursChange}
                        getEmployeeActualHours={calculateEmployeeActualHours}
                        getTargetHours={getMonthlyTargetHours}
                        showCosts={showCosts}
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-2 px-2">
                        <span className="w-2 h-2 rounded-full bg-orange-500" />
                        <span className="text-sm font-medium">Küche - Ist</span>
                      </div>
                      <ActualHoursGrid
                        employees={employees.filter(e => e.department === 'küche')}
                        days={displayDays}
                        actualHoursData={actualHoursData}
                        onHoursChange={handleActualHoursChange}
                        getEmployeeActualHours={calculateEmployeeActualHours}
                        getTargetHours={getMonthlyTargetHours}
                        showCosts={showCosts}
                      />
                    </div>
                  </div>
                ) : (
                  <ActualHoursGrid
                    employees={filteredEmployees}
                    days={displayDays}
                    actualHoursData={actualHoursData}
                    onHoursChange={handleActualHoursChange}
                    getEmployeeActualHours={calculateEmployeeActualHours}
                    getTargetHours={getMonthlyTargetHours}
                    showCosts={showCosts}
                  />
                )
              )}
            </div>

            {/* Employee Hours Summary */}
            <EmployeeHoursSummary summaries={departmentSummaries} />

            {/* Cost Summary (if enabled) */}
            <MonthlyCostSummary
              employees={employees}
              scheduleData={scheduleData}
              dailyBudgets={dailyBudgets}
              currentMonth={currentMonthStart}
              showCosts={showCosts}
            />
          </CardContent>
        </CollapsibleContent>
      </Card>

      {/* Dialogs */}
      <CopyWeekDialog
        open={copyWeekDialogOpen}
        onOpenChange={setCopyWeekDialogOpen}
        currentMonth={currentMonthStart}
        scheduleData={scheduleData}
        employeeIds={filteredEmployees.map(e => e.id)}
        onCopy={async (newScheduleData) => {
          // Apply copied schedule data to Supabase
          for (const [key, schedule] of Object.entries(newScheduleData)) {
            const parts = key.split('-');
            const employeeId = parts[0];
            const date = parts.slice(1).join('-');
            
            if (schedule.früh || schedule.frühAbsence) {
              await updateScheduleEntry(employeeId, date, 'früh', schedule.früh || null, schedule.frühAbsence);
            }
            if (schedule.spät || schedule.spätAbsence) {
              await updateScheduleEntry(employeeId, date, 'spät', schedule.spät || null, schedule.spätAbsence);
            }
          }
          toast.success('Woche kopiert!');
          await refresh();
        }}
      />

      <PrintScheduleDialog
        open={printDialogOpen}
        onOpenChange={setPrintDialogOpen}
        employees={filteredEmployees}
        days={daysInMonth}
        scheduleData={scheduleData}
        currentMonth={currentMonthStart}
        department={activeDepartment}
      />

      <DayDetailDialog
        open={dayDetailDialogOpen}
        onOpenChange={setDayDetailDialogOpen}
        date={selectedDay}
        employees={employees}
        scheduleData={scheduleData}
        plannedRevenue={selectedDay ? dailyBudgets[format(selectedDay, 'yyyy-MM-dd')]?.plannedRevenue : undefined}
        isOverride={selectedDay ? !!dailyBudgets[format(selectedDay, 'yyyy-MM-dd')]?.isOverride : false}
        onUpdatePlannedRevenue={handleUpdatePlannedRevenue}
      />

      <ShiftConfigDialog
        open={shiftConfigDialogOpen}
        onOpenChange={setShiftConfigDialogOpen}
        shifts={shifts}
        onSave={(newShifts: ShiftConfigItem[]) => {
          updateShifts(newShifts);
          toast.success('Schichtkonfiguration gespeichert!');
        }}
      />

      {selectedEmployeeForDaysOff && (
        <DaysOffConfigDialog
          open={daysOffDialogOpen}
          onOpenChange={setDaysOffDialogOpen}
          employee={selectedEmployeeForDaysOff}
          onSave={handleSaveDaysOff}
        />
      )}

      {selectedEmployeeFor8Hours && (
        <Apply8HoursDialog
          open={apply8HoursDialogOpen}
          onOpenChange={setApply8HoursDialogOpen}
          employeeName={selectedEmployeeFor8Hours.name}
          employeeId={selectedEmployeeFor8Hours.id}
          days={displayDays}
          preferredWorkDays={selectedEmployeeFor8Hours.preferredWorkDays}
          onConfirm={handleConfirm8Hours}
        />
      )}

      <EmployeeForm
        isOpen={employeeFormOpen}
        onClose={() => {
          setEmployeeFormOpen(false);
          setSelectedEmployeeForEdit(null);
        }}
        onSubmit={handleEmployeeFormSubmit}
        employee={selectedEmployeeForEdit}
      />

      <Dialog open={costPasswordDialogOpen} onOpenChange={setCostPasswordDialogOpen}>
        <DialogContent className="sm:max-w-[350px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />Kosten anzeigen
            </DialogTitle>
            <DialogDescription>Admin-Passwort eingeben</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => {
            e.preventDefault();
            const configuredPassword = localStorage.getItem(ADMIN_PASSWORD_KEY) || DEFAULT_ADMIN_PASSWORD;
            if (costPassword === configuredPassword) {
              setShowCosts(true);
              setCostPasswordDialogOpen(false);
              setCostPassword('');
              toast.success('Kostenanzeige aktiviert');
            } else {
              toast.error('Falsches Passwort');
              setCostPassword('');
            }
          }} className="space-y-4">
            <Input
              type="password"
              placeholder="Passwort"
              value={costPassword}
              onChange={(e) => setCostPassword(e.target.value)}
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => { setCostPasswordDialogOpen(false); setCostPassword(''); }}>
                Abbrechen
              </Button>
              <Button type="submit"><Euro className="h-4 w-4 mr-2" />Entsperren</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ExportOptionsDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        currentMonth={currentMonthStart}
        currentWeekStart={weeksInMonth[selectedWeekIndex] || weeksInMonth[0]}
        currentWeekEnd={endOfWeek(weeksInMonth[selectedWeekIndex] || weeksInMonth[0], { weekStartsOn: 1 })}
        onExport={handleExportWithRange}
        onExportPDF={handleExportPDF}
      />

      <ImportMatchPreviewDialog
        open={importPreviewOpen}
        onOpenChange={setImportPreviewOpen}
        nameMatches={pendingImportResult?.nameMatches || []}
        existingEmployees={employees}
        onConfirm={handleConfirmImport}
        onCancel={handleCancelImport}
      />

      <SimpleKüchenplanImportDialog
        open={simpleKüchenImportOpen}
        onClose={() => setSimpleKüchenImportOpen(false)}
        employees={employees}
        scheduleData={scheduleData}
        onImport={handleSimpleKüchenImport}
      />
    </Collapsible>
  );
};
