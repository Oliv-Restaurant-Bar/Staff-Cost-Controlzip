import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Download, Upload, Save, ChevronLeft, ChevronRight, Users, Clock, AlertTriangle, CheckCircle, Copy, Printer, Calendar, CalendarDays, Eye, EyeOff, Euro, Lock, Home, Settings, Pencil, Trash2, CalendarOff } from 'lucide-react';
import { useRef } from 'react';
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
import { LaborCostComparison } from '@/components/schedule-planner/LaborCostComparison';
import { EmployeeForm } from '@/components/EmployeeForm';
import { importScheduleFromExcelV2, exportScheduleToPDF, exportScheduleTemplate, NameMatchInfo } from '@/lib/schedule-export-import';
import { toast } from 'sonner';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, startOfWeek, endOfWeek, isWithinInterval } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useShiftConfig, ShiftConfigItem } from '@/hooks/useShiftConfig';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/personnel-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FileSpreadsheet, FileText } from 'lucide-react';
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

// Re-export types for backward compatibility
export type ShiftType = string;

export interface CustomShift {
  start: string;
  end: string;
  hours: number;
  start2?: string;
  end2?: string;
  isFixedHours?: boolean;
}

// Dynamic SHIFT_CONFIG - will be loaded from hook
export { getShiftConfigMap as getShiftConfig } from '@/hooks/useShiftConfig';

// Mitarbeiter aus Übersicht_Personal_01.2025-2.xlsx
// ML = Vollzeit (100% Arbeitspensum), SL = Teilzeit (max 40% Arbeitspensum)
const defaultEmployees: Employee[] = [
  // === SERVICE (Zeilen 1-13 in Excel) ===
  { id: '1', name: 'Mendim', department: 'service', employmentType: 'vollzeit', hourlyWage: 36.92, weeklyHours: 42, monthlySalary: 5538.45, monthlySalaryWith13th: 6203.06 },
  { id: '2', name: 'Artin', department: 'service', employmentType: 'vollzeit', hourlyWage: 33.85, weeklyHours: 42, monthlySalary: 5076.95, monthlySalaryWith13th: 5686.18 },
  { id: '3', name: 'Joana', department: 'service', employmentType: 'teilzeit', hourlyWage: 28.00 },
  { id: '4', name: 'Husein', department: 'service', employmentType: 'vollzeit', hourlyWage: 31.33, weeklyHours: 42, monthlySalary: 5000.00, monthlySalaryWith13th: 5264.00 },
  { id: '5', name: 'Eduard', department: 'service', employmentType: 'vollzeit', hourlyWage: 34.46, weeklyHours: 42, monthlySalary: 5169.25, monthlySalaryWith13th: 5789.56 },
  { id: '6', name: 'Nahuel', department: 'service', employmentType: 'vollzeit', hourlyWage: 28.31, weeklyHours: 42, monthlySalary: 4246.50, monthlySalaryWith13th: 4756.08 },
  { id: '7', name: 'Carlos', department: 'service', employmentType: 'teilzeit', hourlyWage: 24.70 },
  { id: '8', name: 'Arber', department: 'service', employmentType: 'vollzeit', hourlyWage: 30.77, weeklyHours: 42, monthlySalary: 4615.40, monthlySalaryWith13th: 5169.25 },
  { id: '9', name: 'Marion', department: 'service', employmentType: 'vollzeit', hourlyWage: 28.67, weeklyHours: 42, monthlySalary: 4576.95, monthlySalaryWith13th: 4816.00 },
  { id: '10', name: 'Isabel', department: 'service', employmentType: 'teilzeit', hourlyWage: 26.37 },
  { id: '11', name: 'David', department: 'service', employmentType: 'vollzeit', hourlyWage: 31.33, weeklyHours: 42, monthlySalary: 4700.00, monthlySalaryWith13th: 5264.00 },
  { id: '12', name: 'Saad', department: 'service', employmentType: 'vollzeit', hourlyWage: 26.00, weeklyHours: 42, monthlySalary: 3900.00, monthlySalaryWith13th: 4368.00 },
  { id: '13', name: 'Aushilfe Service', department: 'service', employmentType: 'teilzeit', hourlyWage: 20.50 },
  
  // === KÜCHE (Zeilen 14-23 in Excel) ===
  { id: '14', name: 'Mejdi', department: 'küche', employmentType: 'vollzeit', hourlyWage: 49.33, weeklyHours: 42, monthlySalary: 7400.00, monthlySalaryWith13th: 8288.00 },
  { id: '15', name: 'Miro', department: 'küche', employmentType: 'vollzeit', hourlyWage: 34.46, weeklyHours: 42, monthlySalary: 5169.00, monthlySalaryWith13th: 5789.28 },
  { id: '16', name: 'Culi', department: 'küche', employmentType: 'vollzeit', hourlyWage: 47.33, weeklyHours: 42, monthlySalary: 7100.00, monthlySalaryWith13th: 7952.00 },
  { id: '17', name: 'Karel', department: 'küche', employmentType: 'vollzeit', hourlyWage: 30.67, weeklyHours: 42, monthlySalary: 4600.00, monthlySalaryWith13th: 5152.00 },
  { id: '18', name: 'Micky', department: 'küche', employmentType: 'vollzeit', hourlyWage: 27.69, weeklyHours: 42, monthlySalary: 4153.85, monthlySalaryWith13th: 4652.31 },
  { id: '19', name: 'Asim', department: 'küche', employmentType: 'vollzeit', hourlyWage: 28.92, weeklyHours: 42, monthlySalary: 4338.45, monthlySalaryWith13th: 4859.06 },
  { id: '20', name: 'Ali', department: 'küche', employmentType: 'teilzeit', hourlyWage: 20.36 },
  { id: '21', name: 'Sadete', department: 'küche', employmentType: 'teilzeit', hourlyWage: 20.36 },
  { id: '22', name: 'Aushilfe 1 Küche F', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
  { id: '23', name: 'Aushilfe 2 Küche A', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
];

type ViewMode = Department | 'all';

type CalendarView = 'month' | 'week';

const SchedulePlanner = () => {
  const { shifts, shiftMap, updateShifts } = useShiftConfig();
  
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [employees, setEmployees] = useState<Employee[]>(defaultEmployees);
  const [scheduleData, setScheduleData] = useState<{[key: string]: DaySchedule}>({});
  const [activeDepartment, setActiveDepartment] = useState<ViewMode>('service');
  const [calendarView, setCalendarView] = useState<CalendarView>('month');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [visibleWeekInMonth, setVisibleWeekInMonth] = useState(0);
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
  const [dailyBudgets, setDailyBudgets] = useState<{[key: string]: { plannedRevenue?: number; actualRevenue?: number }}>({});
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [pendingImportResult, setPendingImportResult] = useState<{
    scheduleData: Record<string, DaySchedule>;
    newEmployees: Employee[];
    nameMatches: NameMatchInfo[];
  } | null>(null);
  
  // New state for Plan/Ist toggle
  const [scheduleMode, setScheduleMode] = useState<'plan' | 'ist'>('plan');
  const [actualHoursData, setActualHoursData] = useState<Record<string, { hours: number; start?: string; end?: string }>>({});
  
  // Use same password as admin/overview
  const ADMIN_PASSWORD_KEY = 'admin_password';
  const DEFAULT_ADMIN_PASSWORD = 'admin123';
  
  // Load schedule data and daily budgets from localStorage
  useEffect(() => {
    const monthKey = format(currentMonth, 'yyyy-MM');
    const savedSchedule = localStorage.getItem(`schedule-v2-${monthKey}`);
    const savedEmployees = localStorage.getItem('schedule-employees');
    const savedBudgets = localStorage.getItem('dailyBudgets');
    const savedActualHours = localStorage.getItem(`actual-hours-${monthKey}`);
    
    if (savedSchedule) {
      setScheduleData(JSON.parse(savedSchedule));
    } else {
      setScheduleData({});
    }
    
    if (savedActualHours) {
      setActualHoursData(JSON.parse(savedActualHours));
    } else {
      setActualHoursData({});
    }
    
    if (savedEmployees) {
      let loadedEmployees: Employee[] = JSON.parse(savedEmployees);
      
      // One-time cleanup: Remove imported duplicates with 25 CHF hourly wage
      // These are employees that were incorrectly imported
      const duplicateNames = ['mendim', 'artin', 'joana', 'husein', 'edi', 'nahuel', 'carlos', 'arber', 'marion', 'isabella', 'david', 'saad'];
      const cleanedEmployees = loadedEmployees.filter(emp => {
        // Keep if not a 25 CHF import duplicate
        const nameLower = emp.name.toLowerCase();
        const isImportedDuplicate = emp.hourlyWage === 25 && 
          emp.id.startsWith('imported-') &&
          duplicateNames.some(dup => nameLower.includes(dup));
        return !isImportedDuplicate;
      });
      
      // Save cleaned list if we removed any
      if (cleanedEmployees.length < loadedEmployees.length) {
        localStorage.setItem('schedule-employees', JSON.stringify(cleanedEmployees));
        console.log(`Bereinigt: ${loadedEmployees.length - cleanedEmployees.length} doppelte Mitarbeiter entfernt`);
      }
      
      setEmployees(cleanedEmployees);
    }
    
    if (savedBudgets) {
      setDailyBudgets(JSON.parse(savedBudgets));
    }
  }, [currentMonth]);

  // Get days in current month
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Get weeks in month
  const weeksInMonth = eachWeekOfInterval(
    { start: monthStart, end: monthEnd },
    { weekStartsOn: 1 }
  );

  // Ref for scrolling to week
  const scheduleGridRef = useRef<HTMLDivElement>(null);

  // Scroll to selected week when visibleWeekInMonth changes
  useEffect(() => {
    if (calendarView === 'month' && scheduleGridRef.current) {
      const weekStartDay = weeksInMonth[visibleWeekInMonth];
      if (weekStartDay) {
        // Calculate approximate scroll position based on week index
        // Each day has ~100px width (2 columns * 50px), so each week = ~700px
        const scrollPosition = visibleWeekInMonth * 700;
        const scrollArea = scheduleGridRef.current.querySelector('[data-radix-scroll-area-viewport]');
        if (scrollArea) {
          scrollArea.scrollTo({ left: scrollPosition, behavior: 'smooth' });
        }
      }
    }
  }, [visibleWeekInMonth, calendarView, weeksInMonth]);

  // Keyboard navigation for week switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      if (calendarView === 'month') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setVisibleWeekInMonth(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setVisibleWeekInMonth(prev => Math.min(weeksInMonth.length - 1, prev + 1));
        }
      } else if (calendarView === 'week') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSelectedWeekIndex(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setSelectedWeekIndex(prev => Math.min(weeksInMonth.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [calendarView, weeksInMonth.length]);

  // Get displayed days based on view mode
  const displayDays = calendarView === 'month' 
    ? daysInMonth 
    : (() => {
        const weekStart = weeksInMonth[selectedWeekIndex] || weeksInMonth[0];
        const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
        return eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
          d => isWithinInterval(d, { start: monthStart, end: monthEnd })
        );
      })();

  // Calculate hours from a time slot
  const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
    if (!slot?.start || !slot?.end) return 0;
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24;
    return Math.round(hours * 100) / 100;
  };

  // Calculate total hours for a day (früh + spät) with break deduction
  const calculateDayHours = (daySchedule: DaySchedule): number => {
    const frühHours = calculateSlotHours(daySchedule.früh);
    const spätHours = calculateSlotHours(daySchedule.spät);
    const totalGross = frühHours + spätHours;
    
    // Apply break deduction based on total hours
    const breakDeduction = calculateBreakDeduction(totalGross);
    return Math.round((totalGross - breakDeduction) * 100) / 100;
  };

  // Calculate hours per employee
  const calculateEmployeeHours = (employeeId: string): number => {
    let totalHours = 0;
    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      
      if (daySchedule) {
        // Check for absence types that count towards target
        if (daySchedule.frühAbsence || daySchedule.spätAbsence) {
          // Get absence hours from config
          const getAbsenceHours = (abbrev: string | null | undefined): number => {
            if (!abbrev) return 0;
            const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
            if (shift && shiftMap[shift].countsToTarget) {
              return shiftMap[shift].hours;
            }
            return 0;
          };
          
          if (daySchedule.frühAbsence) {
            totalHours += getAbsenceHours(daySchedule.frühAbsence);
          }
          if (daySchedule.spätAbsence) {
            totalHours += getAbsenceHours(daySchedule.spätAbsence);
          }
        }
        
        // Add regular work hours
        totalHours += calculateDayHours(daySchedule);
      }
    });
    return totalHours;
  };

  // Calculate weekly hours for an employee up to a specific week end date (Sunday)
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
        // Add absence hours that count towards target
        const getAbsenceHours = (abbrev: string | null | undefined): number => {
          if (!abbrev) return 0;
          const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
          if (shift && shiftMap[shift].countsToTarget) {
            return shiftMap[shift].hours;
          }
          return 0;
        };
        
        if (daySchedule.frühAbsence) {
          totalHours += getAbsenceHours(daySchedule.frühAbsence);
        }
        if (daySchedule.spätAbsence) {
          totalHours += getAbsenceHours(daySchedule.spätAbsence);
        }
        
        // Add work hours
        totalHours += calculateDayHours(daySchedule);
      }
    });
    
    return totalHours;
  };

  // Get monthly target hours (weeklyHours * ~4.33 weeks)
  const getMonthlyTargetHours = (employee: Employee): number => {
    if (employee.weeklyHours) {
      return employee.weeklyHours * 4.33;
    }
    switch (employee.employmentType) {
      case 'vollzeit': return 42 * 4.33;
      case 'teilzeit': return 25 * 4.33;
      case 'minijob': return 10 * 4.33;
      case 'aushilfe': return 15 * 4.33;
      default: return 40 * 4.33;
    }
  };

  // Get weekly target hours for an employee
  const getWeeklyTargetHours = (employee: Employee): number => {
    if (employee.weeklyHours) {
      return employee.weeklyHours;
    }
    switch (employee.employmentType) {
      case 'vollzeit': return 42;
      case 'teilzeit': return 25;
      case 'minijob': return 10;
      case 'aushilfe': return 15;
      default: return 40;
    }
  };

  // Helper to parse time string to minutes since midnight
  const timeToMinutes = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  // Validate that Spät shift starts after Früh shift ends
  const validateShiftTimes = (früh: TimeSlot | null | undefined, spät: TimeSlot | null | undefined): { valid: boolean; message?: string } => {
    // Both shifts must exist for validation to apply
    if (!früh?.end || !spät?.start) return { valid: true };
    
    const frühEnd = timeToMinutes(früh.end);
    const spätStart = timeToMinutes(spät.start);
    
    // Spät must start after Früh ends (with at least 30 min gap recommended)
    if (spätStart < frühEnd) {
      return { 
        valid: false, 
        message: `Spät-Schicht (${spät.start}) muss nach Früh-Schicht (${früh.end}) beginnen` 
      };
    }
    
    // Warning if gap is too small (less than 30 min)
    if (spätStart - frühEnd < 30 && spätStart >= frühEnd) {
      return { 
        valid: true, 
        message: `Hinweis: Nur ${spätStart - frühEnd} Min. Pause zwischen Früh und Spät` 
      };
    }
    
    return { valid: true };
  };

  const handleSlotChange = (
    employeeId: string, 
    date: string, 
    slotType: 'früh' | 'spät', 
    value: TimeSlot | null, 
    absenceType?: string | null
  ) => {
    const cellKey = `${employeeId}-${date}`;
    
    setScheduleData(prev => {
      const current = prev[cellKey] || {};
      const updated = { ...current };
      
      if (slotType === 'früh') {
        updated.früh = value;
        updated.frühAbsence = absenceType || null;
      } else {
        updated.spät = value;
        updated.spätAbsence = absenceType || null;
      }
      
      // Validate shift times only when both are time slots (not absences)
      if (updated.früh && updated.spät && !updated.frühAbsence && !updated.spätAbsence) {
        const validation = validateShiftTimes(updated.früh, updated.spät);
        if (!validation.valid) {
          toast.error(validation.message);
          // Don't update - return previous state
          return prev;
        }
        if (validation.message) {
          // Show warning but allow the change
          toast.warning(validation.message);
        }
      }
      
      // Remove entry if completely empty
      if (!updated.früh && !updated.spät && !updated.frühAbsence && !updated.spätAbsence) {
        const newState = { ...prev };
        delete newState[cellKey];
        
        // Auto-save to localStorage
        const monthKey = format(currentMonth, 'yyyy-MM');
        localStorage.setItem(`schedule-v2-${monthKey}`, JSON.stringify(newState));
        
        // Dispatch custom event for immediate sync
        window.dispatchEvent(new CustomEvent('schedule-updated'));
        
        return newState;
      }
      
      const newState = { ...prev, [cellKey]: updated };
      
      // Auto-save to localStorage for immediate sync with overview
      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(`schedule-v2-${monthKey}`, JSON.stringify(newState));
      
      // Dispatch custom event for immediate sync
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      
      return newState;
    });
  };

  const handleAddAushilfe = (employee: Omit<Employee, 'id'>) => {
    const newEmployee: Employee = {
      ...employee,
      id: `aush_${Date.now()}`,
    };
    const updatedEmployees = [...employees, newEmployee];
    setEmployees(updatedEmployees);
    localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
    toast.success(`${employee.name} hinzugefügt`);
  };

  const handleRemoveEmployee = (employeeId: string) => {
    const emp = employees.find(e => e.id === employeeId);
    const updatedEmployees = employees.filter(e => e.id !== employeeId);
    setEmployees(updatedEmployees);
    localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
    if (emp) {
      toast.success(`${emp.name} entfernt`);
    }
  };

  const handleSave = () => {
    const monthKey = format(currentMonth, 'yyyy-MM');
    localStorage.setItem(`schedule-v2-${monthKey}`, JSON.stringify(scheduleData));
    localStorage.setItem('schedule-employees', JSON.stringify(employees));
    localStorage.setItem('dailyBudgets', JSON.stringify(dailyBudgets));
    localStorage.setItem(`actual-hours-${monthKey}`, JSON.stringify(actualHoursData));
    
    // Dispatch custom event for immediate sync with overview
    window.dispatchEvent(new CustomEvent('schedule-updated'));
    
    toast.success(`Dienstplan für ${format(currentMonth, 'MMMM yyyy', { locale: de })} gespeichert`);
  };

  // Calculate actual hours for an employee (monthly total)
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
  const handleActualHoursChange = (employeeId: string, date: string, entry: { hours: number; start?: string; end?: string } | null) => {
    const cellKey = `${employeeId}-${date}`;
    
    setActualHoursData(prev => {
      if (entry === null) {
        const newState = { ...prev };
        delete newState[cellKey];
        
        // Auto-save
        const monthKey = format(currentMonth, 'yyyy-MM');
        localStorage.setItem(`actual-hours-${monthKey}`, JSON.stringify(newState));
        window.dispatchEvent(new CustomEvent('schedule-updated'));
        
        return newState;
      }
      
      const newState = { ...prev, [cellKey]: entry };
      
      // Auto-save
      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(`actual-hours-${monthKey}`, JSON.stringify(newState));
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      
      return newState;
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportPDF = async () => {
    try {
      await exportScheduleToPDF({
        employees,
        scheduleData,
        currentMonth,
        department: activeDepartment === 'all' ? 'all' : activeDepartment,
        dailyBudgets,
        showCosts
      });
      toast.success('PDF erfolgreich exportiert');
    } catch (error) {
      toast.error('Fehler beim PDF-Export');
      console.error('PDF export error:', error);
    }
  };

  const handleExportWithRange = async (options: ExportOptions) => {
    try {
      let specificDays: Date[] | undefined;
      
      if (options.range === 'week') {
        const weekStart = weeksInMonth[selectedWeekIndex] || weeksInMonth[0];
        const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
        specificDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
          d => isWithinInterval(d, { start: monthStart, end: monthEnd })
        );
      } else if (options.range === 'custom' && options.customStartDate && options.customEndDate) {
        specificDays = eachDayOfInterval({ start: options.customStartDate, end: options.customEndDate });
      }
      
      // Always export both departments
      await exportScheduleTemplate({
        employees,
        currentMonth,
        department: 'all',
        dailyBudgets,
        scheduleData,
        specificDays
      });
      
      const successMsg = options.range === 'week' 
        ? 'Woche erfolgreich exportiert' 
        : options.range === 'custom'
          ? 'Benutzerdefinierter Zeitraum erfolgreich exportiert'
          : 'Dienstplan erfolgreich exportiert';
      toast.success(successMsg);
    } catch (error) {
      toast.error('Fehler beim Export');
      console.error('Template export error:', error);
    }
  };

  const handleExportTemplate = () => {
    setExportDialogOpen(true);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const result = await importScheduleFromExcelV2(
        file,
        employees,
        currentMonth,
        scheduleData
      );

      // Show preview dialog with name matches
      if (result.nameMatches.length > 0) {
        setPendingImportResult({
          scheduleData: result.scheduleData,
          newEmployees: result.newEmployees,
          nameMatches: result.nameMatches
        });
        setImportPreviewOpen(true);
      } else {
        // No matches to show, apply directly
        applyImportResult(result.scheduleData, result.newEmployees);
      }
    } catch (error) {
      toast.error('Fehler beim Importieren der Datei');
      console.error('Import error:', error);
    }

    event.target.value = '';
  };

  const applyImportResult = (newScheduleData: Record<string, DaySchedule>, newEmployees: Employee[]) => {
    setScheduleData(newScheduleData);

    if (newEmployees && newEmployees.length > 0) {
      const updatedEmployees = [...employees, ...newEmployees];
      setEmployees(updatedEmployees);
      localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
      toast.success(`${newEmployees.length} neue Mitarbeiter hinzugefügt: ${newEmployees.map(e => e.name).join(', ')}`);
    } else {
      toast.success('Dienstplan erfolgreich importiert');
    }
  };

  const handleConfirmImport = (overrides: NameMatchOverride[]) => {
    if (!pendingImportResult) return;
    
    // Build mapping from imported names to selected employee IDs
    const nameToEmployeeMap = new Map<string, string>();
    const skippedNames = new Set<string>();
    const newEmployeeNames = new Set<string>();
    
    overrides.forEach(override => {
      if (override.selectedEmployeeId === 'skip') {
        skippedNames.add(override.importedName.toLowerCase());
      } else if (override.selectedEmployeeId === 'new') {
        newEmployeeNames.add(override.importedName.toLowerCase());
      } else {
        nameToEmployeeMap.set(override.importedName.toLowerCase(), override.selectedEmployeeId);
      }
    });
    
    // Filter schedule data based on overrides
    const filteredScheduleData: Record<string, DaySchedule> = {};
    const employeesToAdd: Employee[] = [];
    
    // Find which new employees to actually add
    pendingImportResult.newEmployees.forEach(emp => {
      const nameLower = emp.name.toLowerCase();
      if (newEmployeeNames.has(nameLower)) {
        employeesToAdd.push(emp);
      }
    });
    
    // Process schedule data - remap employee IDs based on overrides
    Object.entries(pendingImportResult.scheduleData).forEach(([key, value]) => {
      const [empId, dateStr] = key.split('-').length > 5 
        ? [key.substring(0, key.lastIndexOf('-')), key.substring(key.lastIndexOf('-') + 1)]
        : key.split('-', 2).length === 2 ? [key.split('-')[0], key.substring(key.indexOf('-') + 1)] : [key, ''];
      
      // Check if this employee was skipped
      const matchInfo = pendingImportResult.nameMatches.find(m => {
        const matchedId = m.matchedEmployee?.id || pendingImportResult.newEmployees.find(e => e.name.toLowerCase() === m.importedName.toLowerCase())?.id;
        return matchedId === empId;
      });
      
      if (matchInfo && skippedNames.has(matchInfo.importedName.toLowerCase())) {
        return; // Skip this entry
      }
      
      // Check if we need to remap the employee ID
      if (matchInfo) {
        const override = nameToEmployeeMap.get(matchInfo.importedName.toLowerCase());
        if (override && override !== empId) {
          // Remap to different employee
          const newKey = `${override}-${dateStr}`;
          filteredScheduleData[newKey] = value;
          return;
        }
      }
      
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

  const handleSaveShiftConfig = (newShifts: ShiftConfigItem[]) => {
    updateShifts(newShifts);
    toast.success('Schichtkonfiguration gespeichert!');
  };

  const handleConfigureDaysOff = (employee: Employee) => {
    setSelectedEmployeeForDaysOff(employee);
    setDaysOffDialogOpen(true);
  };

  type DayOfWeek = 'montag' | 'dienstag' | 'mittwoch' | 'donnerstag' | 'freitag' | 'samstag' | 'sonntag';

  const handleSaveDaysOff = (employeeId: string, daysOff: DayOfWeek[]) => {
    const updatedEmployees = employees.map(emp =>
      emp.id === employeeId ? { ...emp, daysOff } : emp
    );
    setEmployees(updatedEmployees);
    localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
    toast.success('Freie Tage gespeichert');
  };

  const handleOpen8HoursDialog = (employee: Employee) => {
    setSelectedEmployeeFor8Hours(employee);
    setApply8HoursDialogOpen(true);
  };

  const handleConfirm8Hours = (selectedDays: Date[], saveAsPreferred: boolean) => {
    if (!selectedEmployeeFor8Hours) return;
    
    selectedDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      handleSlotChange(selectedEmployeeFor8Hours.id, dateStr, 'früh', null, '8.5');
      handleSlotChange(selectedEmployeeFor8Hours.id, dateStr, 'spät', null, null);
    });
    
    // Save preferred days if requested
    if (saveAsPreferred) {
      const preferredWorkDays = getPreferredWeekdaysFromDates(selectedDays);
      const updatedEmployees = employees.map(emp =>
        emp.id === selectedEmployeeFor8Hours.id 
          ? { ...emp, preferredWorkDays } 
          : emp
      );
      setEmployees(updatedEmployees);
      localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
      toast.success(`8.5h für ${selectedEmployeeFor8Hours.name} eingetragen (${selectedDays.length} Tage) - Bevorzugte Tage gespeichert`);
    } else {
      toast.success(`8.5h für ${selectedEmployeeFor8Hours.name} eingetragen (${selectedDays.length} Tage)`);
    }
    
    setSelectedEmployeeFor8Hours(null);
  };

  const handleEditEmployee = (employee: Employee) => {
    setSelectedEmployeeForEdit(employee);
    setEmployeeFormOpen(true);
  };

  const handleEmployeeFormSubmit = (employeeData: Omit<Employee, 'id'> | Employee) => {
    if ('id' in employeeData) {
      // Update existing employee
      const updatedEmployees = employees.map(emp =>
        emp.id === employeeData.id ? { ...emp, ...employeeData } : emp
      );
      setEmployees(updatedEmployees);
      localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
      toast.success(`${employeeData.name} aktualisiert`);
    } else {
      // Add new employee
      const newEmployee: Employee = {
        ...employeeData,
        id: `emp_${Date.now()}`,
      };
      const updatedEmployees = [...employees, newEmployee];
      setEmployees(updatedEmployees);
      localStorage.setItem('schedule-employees', JSON.stringify(updatedEmployees));
      toast.success(`${employeeData.name} hinzugefügt`);
    }
    setSelectedEmployeeForEdit(null);
  };

  // Filter employees by active department
  const filteredEmployees = activeDepartment === 'all' 
    ? employees 
    : employees.filter(e => e.department === activeDepartment);

  // Calculate summary stats for all employees
  const employeeSummaries = employees.map(emp => {
    const plannedHours = calculateEmployeeHours(emp.id);
    const targetHours = getMonthlyTargetHours(emp);
    const difference = plannedHours - targetHours;
    const percentage = (plannedHours / targetHours) * 100;
    
    let status: 'ok' | 'under' | 'over' | 'warning';
    if (difference > 5) {
      status = 'over';
    } else if (difference >= -5) {
      status = 'ok';
    } else if (difference >= -10) {
      status = 'warning';
    } else {
      status = 'under';
    }
    
    return {
      employee: emp,
      plannedHours,
      targetHours,
      difference,
      percentage,
      status
    };
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
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-[1800px] mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/">
                <Button variant="ghost" size="sm">
                  <Home className="h-4 w-4 mr-2" />
                  Übersicht
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-foreground">Personal</h1>
                <p className="text-sm text-muted-foreground">Dienstplan, Mitarbeiter und Kostenübersicht</p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleImportFile}
                accept=".xlsx,.xls"
                className="hidden"
              />
              <Button variant="outline" size="sm" onClick={() => setPrintDialogOpen(true)}>
                <Printer className="h-4 w-4 mr-2" />
                Drucken
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCopyWeekDialogOpen(true)}>
                <Copy className="h-4 w-4 mr-2" />
                Woche kopieren
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportClick}>
                <Upload className="h-4 w-4 mr-2" />
                Importieren
              </Button>
<DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Download className="h-4 w-4 mr-2" />
                    Exportieren
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExportTemplate}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Excel (.xlsx) – mit Formeln (Früh/Spät)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPDF}>
                    <FileText className="h-4 w-4 mr-2" />
                    PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={handleSave}>
                <Save className="h-4 w-4 mr-2" />
                Speichern
              </Button>
              <Link to="/settings">
                <Button variant="ghost" size="icon" title="Einstellungen">
                  <Settings className="h-5 w-5" />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-4 py-6 space-y-6">
        {/* Month/Week Navigation */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Cost Button - Password Protected */}
            <Button
              variant={showCosts ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (showCosts) {
                  setShowCosts(false);
                } else {
                  setCostPasswordDialogOpen(true);
                }
              }}
              className="gap-1"
              title={showCosts ? 'Kosten ausblenden' : 'Kosten einblenden (Passwort erforderlich)'}
            >
              {showCosts ? <Euro className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              <span className="hidden sm:inline">{showCosts ? 'Kosten' : 'Kosten'}</span>
            </Button>
            
            <div className="w-px h-6 bg-border mx-1" />
            
            {/* Calendar View Toggle */}
            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
              <Button
                variant={calendarView === 'month' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setCalendarView('month')}
                className="h-7 gap-1"
              >
                <CalendarDays className="h-3 w-3" />
                <span className="hidden sm:inline">Monat</span>
              </Button>
              <Button
                variant={calendarView === 'week' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setCalendarView('week')}
                className="h-7 gap-1"
              >
                <Calendar className="h-3 w-3" />
                <span className="hidden sm:inline">Woche</span>
              </Button>
            </div>
            
            <div className="w-px h-6 bg-border mx-1" />
            
            <Button variant="outline" size="sm" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
              <ChevronLeft className="h-4 w-4 mr-1" />
              {format(subMonths(currentMonth, 1), 'MMM', { locale: de })}
            </Button>
            
            {calendarView === 'week' && (
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setSelectedWeekIndex(Math.max(0, selectedWeekIndex - 1))}
                disabled={selectedWeekIndex === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
          </div>
          
          <div className="text-center flex-1">
            <h2 className="text-xl font-semibold">
              {format(currentMonth, 'MMMM yyyy', { locale: de })}
            </h2>
            {calendarView === 'week' && weeksInMonth[selectedWeekIndex] && (
              <p className="text-sm text-muted-foreground">
                KW {format(weeksInMonth[selectedWeekIndex], 'w')} ({format(weeksInMonth[selectedWeekIndex], 'd.MM.')} - {format(endOfWeek(weeksInMonth[selectedWeekIndex], { weekStartsOn: 1 }), 'd.MM.')})
              </p>
            )}
            {calendarView === 'month' && (
              <div className="flex items-center justify-center gap-1 mt-1">
                <Button 
                  variant="ghost" 
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setVisibleWeekInMonth(Math.max(0, visibleWeekInMonth - 1))}
                  disabled={visibleWeekInMonth === 0}
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                {weeksInMonth.map((week, idx) => (
                  <Button
                    key={idx}
                    variant={visibleWeekInMonth === idx ? 'default' : 'ghost'}
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setVisibleWeekInMonth(idx)}
                  >
                    KW{format(week, 'w')}
                  </Button>
                ))}
                <Button 
                  variant="ghost" 
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setVisibleWeekInMonth(Math.min(weeksInMonth.length - 1, visibleWeekInMonth + 1))}
                  disabled={visibleWeekInMonth >= weeksInMonth.length - 1}
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {calendarView === 'week' && (
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setSelectedWeekIndex(Math.min(weeksInMonth.length - 1, selectedWeekIndex + 1))}
                disabled={selectedWeekIndex >= weeksInMonth.length - 1}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
              {format(addMonths(currentMonth, 1), 'MMM', { locale: de })}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>

        {/* Department Toggle */}
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <Button
            variant={activeDepartment === 'service' ? 'default' : 'outline'}
            onClick={() => setActiveDepartment('service')}
            className="min-w-[100px]"
            size="sm"
          >
            <span className={cn(
              "w-2 h-2 rounded-full mr-2",
              activeDepartment === 'service' ? "bg-white" : "bg-blue-500"
            )} />
            Service
          </Button>
          <Button
            variant={activeDepartment === 'küche' ? 'default' : 'outline'}
            onClick={() => setActiveDepartment('küche')}
            className="min-w-[100px]"
            size="sm"
          >
            <span className={cn(
              "w-2 h-2 rounded-full mr-2",
              activeDepartment === 'küche' ? "bg-white" : "bg-orange-500"
            )} />
            Küche
          </Button>
          <Button
            variant={activeDepartment === 'all' ? 'default' : 'outline'}
            onClick={() => setActiveDepartment('all' as Department)}
            className="min-w-[120px]"
            size="sm"
          >
            <Users className="h-4 w-4 mr-2" />
            Alle ({employees.length})
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <Users className="h-6 w-6 text-primary" />
                <div>
                  <p className="text-xl font-bold">{departmentEmployeeCount}</p>
                  <p className="text-xs text-muted-foreground">Mitarbeiter</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <Clock className="h-6 w-6 text-blue-500" />
                <div>
                  <p className="text-xl font-bold">{departmentPlannedHours.toFixed(1)}h</p>
                  <p className="text-xs text-muted-foreground">Geplant</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-6 w-6 text-success" />
                <div>
                  <p className="text-xl font-bold">{departmentOkCount}</p>
                  <p className="text-xs text-muted-foreground">Im Ziel</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-6 w-6 text-warning" />
                <div>
                  <p className="text-xl font-bold">{departmentWarningCount}</p>
                  <p className="text-xs text-muted-foreground">Warnung</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Overhours Warning */}
        {overhoursEmployees.length > 0 && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Überstunden ({overhoursEmployees.length} Mitarbeiter)
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {overhoursEmployees.map(({ employee, plannedHours, targetHours, difference }) => (
                  <div key={employee.id} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate">{employee.name}</span>
                    <span className="text-destructive font-medium shrink-0 ml-2">
                      +{difference.toFixed(1)}h ({plannedHours.toFixed(1)}h / {targetHours.toFixed(1)}h)
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Shift Legend */}
        <ShiftLegend 
          onEditClick={() => setShiftConfigDialogOpen(true)} 
          department={activeDepartment === 'all' ? 'all' : activeDepartment as 'service' | 'küche'}
        />

        {/* Schedule Grid with Plan/Ist Tabs */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-4">
                <CardTitle className="flex items-center gap-2">
                  {activeDepartment === 'all' ? (
                    <>
                      <Users className="h-4 w-4" />
                      Alle Abteilungen ({departmentEmployeeCount} Mitarbeiter)
                    </>
                  ) : (
                    <>
                      <span className={cn(
                        "w-3 h-3 rounded-full",
                        activeDepartment === 'service' ? "bg-blue-500" : "bg-orange-500"
                      )} />
                      {activeDepartment === 'service' ? 'Service' : 'Küche'} ({departmentEmployeeCount} Mitarbeiter)
                    </>
                  )}
                </CardTitle>
                {activeDepartment !== 'all' && (
                  <AddAushilfeDialog department={activeDepartment} onAdd={handleAddAushilfe} />
                )}
              </div>
              
              {/* Plan/Ist Toggle and Footer Toggle */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                  <Button
                    variant={scheduleMode === 'plan' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setScheduleMode('plan')}
                    className="h-7 gap-1"
                    title="Plan-Dienstplan anzeigen"
                  >
                    <Calendar className="h-3 w-3" />
                    <span className="hidden sm:inline">Plan</span>
                  </Button>
                  <Button
                    variant={scheduleMode === 'ist' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setScheduleMode('ist')}
                    className={cn(
                      "h-7 gap-1",
                      scheduleMode === 'ist' && "bg-green-600 hover:bg-green-700"
                    )}
                    title="Ist-Dienstplan anzeigen"
                  >
                    <Clock className="h-3 w-3" />
                    <span className="hidden sm:inline">Ist</span>
                  </Button>
                </div>
                <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                  <Button
                    variant={showFooter ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setShowFooter(!showFooter)}
                    className="h-7 gap-1"
                    title={showFooter ? 'Tages-Summe ausblenden' : 'Tages-Summe einblenden'}
                  >
                    {showFooter ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    <span className="hidden sm:inline">Σ</span>
                  </Button>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div ref={scheduleGridRef}>
              {scheduleMode === 'plan' ? (
                // Plan-Dienstplan (existing schedule grid)
                <>
                  {activeDepartment === 'all' ? (
                    <div className="space-y-8">
                      {/* Service Section */}
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <span className="w-3 h-3 rounded-full bg-blue-500" />
                          <h3 className="font-semibold">Service ({employees.filter(e => e.department === 'service').length} Mitarbeiter)</h3>
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
                      
                      {/* Küche Section */}
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <span className="w-3 h-3 rounded-full bg-orange-500" />
                          <h3 className="font-semibold">Küche ({employees.filter(e => e.department === 'küche').length} Mitarbeiter)</h3>
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
                  )}
                </>
              ) : (
                // Ist-Dienstplan (actual hours grid)
                <>
                  <div className="mb-3 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                    <p className="text-sm text-green-700 dark:text-green-400">
                      <Clock className="h-4 w-4 inline mr-1" />
                      <strong>Ist-Stunden:</strong> Klicke auf eine Zelle um Ist-Stunden zu erfassen (direkte Stundenzahl oder Start/Ende).
                    </p>
                  </div>
                  {activeDepartment === 'all' ? (
                    <div className="space-y-8">
                      {/* Service Section */}
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <span className="w-3 h-3 rounded-full bg-blue-500" />
                          <h3 className="font-semibold">Service ({employees.filter(e => e.department === 'service').length} Mitarbeiter)</h3>
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
                      
                      {/* Küche Section */}
                      <div>
                        <div className="flex items-center gap-2 mb-3 pb-2 border-b">
                          <span className="w-3 h-3 rounded-full bg-orange-500" />
                          <h3 className="font-semibold">Küche ({employees.filter(e => e.department === 'küche').length} Mitarbeiter)</h3>
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
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Monthly Cost Summary - only shows when costs are enabled */}
        <MonthlyCostSummary
          employees={employees}
          scheduleData={scheduleData}
          dailyBudgets={dailyBudgets}
          currentMonth={currentMonth}
          showCosts={showCosts}
        />

        {/* Labor Cost Comparison Charts */}
        <LaborCostComparison
          employees={employees}
          scheduleData={scheduleData}
          dailyBudgets={dailyBudgets}
          currentMonth={currentMonth}
          showCosts={showCosts}
        />

        {/* Employee Hours Summary */}
        <EmployeeHoursSummary summaries={departmentSummaries} />

        {/* Employees List - Password Protected for hourly wages */}
        {showCosts && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Mitarbeiter ({employees.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-2">Name</th>
                      <th className="text-left py-2 px-2">Abteilung</th>
                      <th className="text-left py-2 px-2">Anstellung</th>
                      <th className="text-right py-2 px-2">Stundenlohn</th>
                      <th className="text-right py-2 px-2">Wochenstunden</th>
                      <th className="text-right py-2 px-2">Aktionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id} className="border-b hover:bg-muted/50">
                        <td className="py-2 px-2 font-medium">{employee.name}</td>
                        <td className="py-2 px-2">
                          <span className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs",
                            employee.department === 'service' 
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                              : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                          )}>
                            <span className={cn(
                              "w-2 h-2 rounded-full",
                              employee.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                            )} />
                            {employee.department === 'service' ? 'Service' : 'Küche'}
                          </span>
                        </td>
                        <td className="py-2 px-2 capitalize">{employee.employmentType}</td>
                        <td className="py-2 px-2 text-right font-mono">
                          {formatCurrency(employee.hourlyWage)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {employee.weeklyHours || '-'}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => handleEditEmployee(employee)}
                              title="Bearbeiten"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => handleConfigureDaysOff(employee)}
                              title="Freie Tage konfigurieren"
                            >
                              <CalendarOff className="h-4 w-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button 
                                  variant="ghost" 
                                  size="icon"
                                  className="text-destructive hover:text-destructive"
                                  title="Löschen"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Mitarbeiter löschen?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Möchten Sie "{employee.name}" wirklich löschen?
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                                  <AlertDialogAction 
                                    onClick={() => handleRemoveEmployee(employee.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    Löschen
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Copy Week Dialog */}
      <CopyWeekDialog
        open={copyWeekDialogOpen}
        onOpenChange={setCopyWeekDialogOpen}
        currentMonth={currentMonth}
        scheduleData={scheduleData}
        employeeIds={filteredEmployees.map(e => e.id)}
        onCopy={(newScheduleData) => {
          setScheduleData(newScheduleData);
          toast.success('Woche erfolgreich kopiert!');
        }}
      />

      {/* Print Dialog */}
      <PrintScheduleDialog
        open={printDialogOpen}
        onOpenChange={setPrintDialogOpen}
        employees={filteredEmployees}
        days={daysInMonth}
        scheduleData={scheduleData}
        currentMonth={currentMonth}
        department={activeDepartment}
      />

      {/* Day Detail Dialog */}
      <DayDetailDialog
        open={dayDetailDialogOpen}
        onOpenChange={setDayDetailDialogOpen}
        date={selectedDay}
        employees={employees}
        scheduleData={scheduleData}
      />

      {/* Shift Config Dialog */}
      <ShiftConfigDialog
        open={shiftConfigDialogOpen}
        onOpenChange={setShiftConfigDialogOpen}
        shifts={shifts}
        onSave={handleSaveShiftConfig}
      />

      {/* Days Off Config Dialog */}
      {selectedEmployeeForDaysOff && (
        <DaysOffConfigDialog
          open={daysOffDialogOpen}
          onOpenChange={setDaysOffDialogOpen}
          employee={selectedEmployeeForDaysOff}
          onSave={handleSaveDaysOff}
        />
      )}

      {/* 8.5h Apply Dialog */}
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

      {/* Employee Edit Form */}
      <EmployeeForm
        isOpen={employeeFormOpen}
        onClose={() => {
          setEmployeeFormOpen(false);
          setSelectedEmployeeForEdit(null);
        }}
        onSubmit={handleEmployeeFormSubmit}
        employee={selectedEmployeeForEdit}
      />

      {/* Cost Password Dialog */}
      <Dialog open={costPasswordDialogOpen} onOpenChange={setCostPasswordDialogOpen}>
        <DialogContent className="sm:max-w-[350px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Kosten anzeigen
            </DialogTitle>
            <DialogDescription>
              Die Kostenanzeige ist passwortgeschützt. Verwenden Sie das Admin-Passwort.
            </DialogDescription>
          </DialogHeader>
          <form 
            onSubmit={(e) => {
              e.preventDefault();
              const configuredPassword = localStorage.getItem(ADMIN_PASSWORD_KEY) || DEFAULT_ADMIN_PASSWORD;
              if (costPassword === configuredPassword) {
                setShowCosts(true);
                setShowFooter(true);
                setCostPasswordDialogOpen(false);
                setCostPassword('');
                toast.success('Kostenanzeige aktiviert');
              } else {
                toast.error('Falsches Passwort');
                setCostPassword('');
              }
            }}
            className="space-y-4"
          >
            <Input
              type="password"
              placeholder="Admin-Passwort eingeben"
              value={costPassword}
              onChange={(e) => setCostPassword(e.target.value)}
              autoFocus
            />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={() => {
                setCostPasswordDialogOpen(false);
                setCostPassword('');
              }}>
                Abbrechen
              </Button>
              <Button type="submit">
                <Euro className="h-4 w-4 mr-2" />
                Entsperren
              </Button>
            </DialogFooter>
          </form>
          <p className="text-xs text-muted-foreground text-center">
            Das Passwort kann in den Einstellungen geändert werden.
          </p>
        </DialogContent>
      </Dialog>

      <ExportOptionsDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        currentMonth={currentMonth}
        currentWeekStart={weeksInMonth[selectedWeekIndex] || weeksInMonth[0]}
        currentWeekEnd={endOfWeek(weeksInMonth[selectedWeekIndex] || weeksInMonth[0], { weekStartsOn: 1 })}
        onExport={handleExportWithRange}
      />

      <ImportMatchPreviewDialog
        open={importPreviewOpen}
        onOpenChange={setImportPreviewOpen}
        nameMatches={pendingImportResult?.nameMatches || []}
        existingEmployees={employees}
        onConfirm={handleConfirmImport}
        onCancel={handleCancelImport}
      />
    </div>
  );
};

export default SchedulePlanner;
