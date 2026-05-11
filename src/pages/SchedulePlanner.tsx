import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { defaultEmployeesBeaulieu } from '@/data/defaultEmployeesBeaulieu';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import {
  loadEmployees,
  upsertEmployee,
  upsertAllEmployees,
  deleteEmployee as dbDeleteEmployee,
  loadScheduleForMonth,
  saveScheduleEntry,
  saveFullScheduleForMonth,
  loadActualHoursForMonth,
  saveActualHourEntry,
  seedBeaulieuEmployees,
  runBeaulieuMatchTest,
} from '@/lib/supabase-db';
import { supabase } from '@/integrations/supabase/client';
import {
  saveMonthAbsences, loadMonthAbsences,
  loadEmployeeSortOrder, saveEmployeeSortOrder,
  loadCellColors, saveCellColors,
} from '@/lib/supabase-kv';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Download, Upload, Save, ChevronLeft, ChevronRight, ChevronDown, Users, Clock, AlertTriangle, CheckCircle, Copy, Printer, Calendar, CalendarDays, Eye, EyeOff, Euro, Lock, Home, Settings, Pencil, Trash2, CalendarOff, Lightbulb, BookOpen, Target, LayoutGrid, CalendarX2, Zap, MoreVertical, ArrowUpDown, Search, X, FileBarChart2, PanelLeftClose } from 'lucide-react';
import { useRef } from 'react';
import { Employee, Department } from '@/types/personnel';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import { resolveZielwert, saveZielwert, loadZielwerte, ZielwertDepartment } from '@/lib/zielwerte-store';
import { ScheduleGrid, DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';
import { ActualHoursGrid, ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { MobileDayView } from '@/components/schedule-planner/MobileDayView';
import { PlanVsIstGrid } from '@/components/schedule-planner/PlanVsIstGrid';
import { PlanVsIstTable } from '@/components/schedule-planner/PlanVsIstTable';
import { EmployeeHoursSummary } from '@/components/schedule-planner/EmployeeHoursSummary';
import { ShiftLegend } from '@/components/schedule-planner/ShiftLegend';
import { AddAushilfeDialog } from '@/components/schedule-planner/AddAushilfeDialog';
import { CopyWeekDialog } from '@/components/schedule-planner/CopyWeekDialog';
import { PrintScheduleDialog } from '@/components/schedule-planner/PrintScheduleDialog';
import { DayDetailDialog } from '@/components/schedule-planner/DayDetailDialog';
import { IstDayDetailDialog } from '@/components/schedule-planner/IstDayDetailDialog';
import { ShiftConfigDialog } from '@/components/schedule-planner/ShiftConfigDialog';
import { DaysOffConfigDialog } from '@/components/schedule-planner/DaysOffConfigDialog';
import { Apply8HoursDialog, getPreferredWeekdaysFromDates } from '@/components/schedule-planner/Apply8HoursDialog';
import { MonthlyCostSummary } from '@/components/schedule-planner/MonthlyCostSummary';
import { ExportOptionsDialog, ExportOptions } from '@/components/schedule-planner/ExportOptionsDialog';
import { ImportMatchPreviewDialog, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { LaborCostComparison } from '@/components/schedule-planner/LaborCostComparison';
import { KüchenplanImportDialog } from '@/components/schedule-planner/KüchenplanImportDialog';
import { WeeklyReportDialog } from '@/components/schedule-planner/WeeklyReportDialog';
import { EmployeeForm } from '@/components/EmployeeForm';
import { ActualHoursImportButton } from '@/components/ActualHoursImportButton';
import { MirusDailyImportEntry, MirusImportMode } from '@/types/personnel';
import { importScheduleFromExcelV2, exportScheduleToPDF, exportScheduleTemplate, NameMatchInfo } from '@/lib/schedule-export-import';
import { toast } from 'sonner';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, startOfWeek, endOfWeek, isWithinInterval, isSameDay } from 'date-fns';
import { getMonthlyBudgetRevenue, distributeBudgetByWeekday } from '@/lib/budgetDistribution';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import PlanningAssistant from '@/components/schedule-planner/PlanningAssistant';
import { TemplateManagerDialog } from '@/components/schedule-planner/TemplateManagerDialog';
import { TemplateDept } from '@/lib/schedule-templates';
import { StaffingTargetDialog } from '@/components/schedule-planner/StaffingTargetDialog';
import { StaffingStatusBar } from '@/components/schedule-planner/StaffingStatusBar';
import { StaffingTarget, loadTargets as loadStaffingTargets } from '@/lib/staffing-targets';
import { StationMatrixDialog } from '@/components/schedule-planner/StationMatrixDialog';
import { AvailabilityDialog } from '@/components/schedule-planner/AvailabilityDialog';
import BulkActionsDialog from '@/components/schedule-planner/BulkActionsDialog';
import TimeSlotStaffingDialog from '@/components/schedule-planner/TimeSlotStaffingDialog';
import { detectPatternWarnings, PatternWarning } from '@/lib/pattern-warnings';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useShiftConfig, ShiftConfigItem } from '@/hooks/useShiftConfig';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency, getEmployeeDisplayName, isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  { id: '24', name: 'Sajed', department: 'küche', employmentType: 'vollzeit', hourlyWage: 20.36 },
  { id: '22', name: 'Aushilfe 1 Küche F', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
  { id: '23', name: 'Aushilfe 2 Küche A', department: 'küche', employmentType: 'teilzeit', hourlyWage: 30.00 },
];

type ViewMode = Department | 'all';

type CalendarView = 'month' | 'week' | 'day';

const SchedulePlanner = () => {
  // ── Mandant (Tenant) ──────────────────────────────────────────────────────
  const { tenantId, tenantKey } = useTenant();

  const { shifts, shiftMap, updateShifts } = useShiftConfig();

  // Auth: user + loading + sessionVersion needed to gate data fetches correctly.
  // sessionVersion increments on every auth event (boot, TOKEN_REFRESHED, SIGNED_IN)
  // so pages re-fetch automatically after a background token renewal.
  const { user, loading: authLoading, sessionVersion } = useAuth();

  // ── Fetch generation counter ──────────────────────────────────────────────
  // Prevents race conditions when loadMonthData() is called concurrently
  // (e.g. mount + TOKEN_REFRESHED firing at the same time).
  // Each call increments the counter; before writing state it checks whether a
  // newer call has already started.  If so, the older call's results are
  // discarded — avoiding stale-empty overwrites of good data.
  const fetchGenRef = useRef(0);
  const hasAutoSeededBeaulieu = useRef(false);
  const {
    isAdmin,
    isServiceManager,
    isKuecheManager,
    isBeaulieuManager,
    canSeeHourlyWages,
    canSeePersonnelCostTotals,
    canToggleCostView,
    canEditEmployees,
    canSwitchDepartment,
    canAccessSettings,
  } = usePermissions();
  
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [employees, setEmployees] = useState<Employee[]>(() => {
    if (tenantId === 'beaulieu') return [];
    try {
      const cached = localStorage.getItem(tenantKey('schedule-employees'));
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return defaultEmployees;
  });
  const [scheduleData, setScheduleData] = useState<{[key: string]: DaySchedule}>({});
  const [activeDepartment, setActiveDepartment] = useState<ViewMode>('all');
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [empFilterOpen, setEmpFilterOpen] = useState(false);
  const [empSearchQuery, setEmpSearchQuery] = useState('');
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [visibleWeekInMonth, setVisibleWeekInMonth] = useState(0);
  const [selectedDayOffset, setSelectedDayOffset] = useState(0);
  const [copyWeekDialogOpen, setCopyWeekDialogOpen] = useState(false);
  const [copiedShift, setCopiedShift] = useState<{ start: string; end: string } | null>(null);
  const handleCopyShift = (slot: { start: string; end: string }) => {
    setCopiedShift(slot);
    toast.success(`Schicht ${slot.start}–${slot.end} kopiert — öffne eine Zelle zum Einfügen`);
  };
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [weeklyReportOpen, setWeeklyReportOpen] = useState(false);
  const [dayDetailDialogOpen, setDayDetailDialogOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [istDayDetailDialogOpen, setIstDayDetailDialogOpen] = useState(false);
  const [selectedIstDay, setSelectedIstDay] = useState<Date | null>(null);
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
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportInitialFormat, setExportInitialFormat] = useState<'excel' | 'pdf'>('excel');
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [küchenplanImportOpen, setKüchenplanImportOpen] = useState(false);
  const [pendingImportResult, setPendingImportResult] = useState<{
    scheduleData: Record<string, DaySchedule>;
    newEmployees: Employee[];
    nameMatches: NameMatchInfo[];
  } | null>(null);
  
  // New state for Plan/Ist toggle
  const [scheduleMode, setScheduleMode] = useState<'plan' | 'ist' | 'compare'>('plan');
  const [actualHoursData, setActualHoursData] = useState<Record<string, { hours: number; start?: string; end?: string; absenceType?: 'FE' | 'K' | 'F' }>>({});
  const [paintTool, setPaintTool] = useState<string | null>(null);
  const [planningAssistantOpen, setPlanningAssistantOpen]     = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen]                 = useState(false);
  const [timeSlotStaffingOpen, setTimeSlotStaffingOpen]       = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen]           = useState(false);
  const [staffingTargetOpen, setStaffingTargetOpen]           = useState(false);
  const [staffingTargets, setStaffingTargets]                 = useState<StaffingTarget[]>([]);
  const [stationMatrixOpen, setStationMatrixOpen]             = useState(false);
  const [availabilityOpen, setAvailabilityOpen]               = useState(false);
  const [dataLoading, setDataLoading]                         = useState(false);
  const [proRataDay, setProRataDay]                           = useState<string>('');
  const [pkDetailOpen, setPkDetailOpen]                       = useState(false);
  const [zielwertEditOpen, setZielwertEditOpen]               = useState(false);
  const [zielwertDraft, setZielwertDraft]                     = useState<{ service: string; küche: string; global: string; autoGlobal: boolean }>({ service: '20.0', küche: '20.0', global: '40.0', autoGlobal: true });
  const [legendSidebarOpen, setLegendSidebarOpen]             = useState(true);
  const [empTypeFilter, setEmpTypeFilter]                     = useState<'vollzeit' | 'teilzeit' | 'stundenlohn' | null>(null);
  const [hintsCollapsed, setHintsCollapsed]                   = useState(false);

  // ── Sortierungsmodus & Zellfarben ────────────────────────────────────────
  const [sortModeActive, setSortModeActive]                   = useState(false);
  const [employeeSortOrder, setEmployeeSortOrder]             = useState<{ service: string[]; küche: string[] }>({ service: [], küche: [] });
  const [cellColors, setCellColors]                           = useState<Record<string, string>>({});

  // ── Plan → IST Übernahme ─────────────────────────────────────────────────
  // Set of "employeeId-date" keys whose IST entry was automatically copied from the plan
  const [planCopiedKeys, setPlanCopiedKeys] = useState<Set<string>>(new Set());

  // ── Save / Dirty state ────────────────────────────────────────────────────
  const [isDirty,       setIsDirty]       = useState(false);
  const [isSaving,      setIsSaving]      = useState(false);
  const [saveError,     setSaveError]     = useState<string | null>(null);
  const [lastSaveTime,  setLastSaveTime]  = useState<Date | null>(null);
  // ── Debug panel ──────────────────────────────────────────────────────────
  const [scheduleSource,    setScheduleSource]    = useState<'supabase' | 'cache' | 'loading'>('loading');
  const [loadedEntryCount,  setLoadedEntryCount]  = useState(0);

  // ── Budget-Daten (für PlanningAssistant) ─────────────────────────────────
  const { personnelBudget } = useBudgetMonth(
    currentMonth.getFullYear(),
    currentMonth.getMonth() + 1,
  );
  const paFixCost = useMemo(
    () => employees.reduce((s, e) => s + (e.monthlySalaryWith13th ?? e.monthlySalary ?? 0), 0),
    [employees],
  );

  // ── Planungshilfe: Highlight + Jump ──────────────────────────────────────
  const [highlightedEmpId, setHighlightedEmpId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Rollenbasierter Zugriff ───────────────────────────────────────────────
  // Wenn der User kein Admin ist, wird die Abteilung automatisch gesetzt
  // und kann nicht verändert werden.
  useEffect(() => {
    if (isServiceManager) setActiveDepartment('service');
    else if (isKuecheManager) setActiveDepartment('küche');
  }, [isServiceManager, isKuecheManager]);

  // Beim Abteilungswechsel Mitarbeiter-Filter zurücksetzen
  useEffect(() => {
    setSelectedEmployeeIds([]);
    setEmpSearchQuery('');
  }, [activeDepartment]);

  // ── Sortierreihenfolge laden (pro Mandant & Abteilung) ─────────────────────
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    Promise.all([
      loadEmployeeSortOrder(tenantId, 'service'),
      loadEmployeeSortOrder(tenantId, 'küche'),
    ]).then(([svc, kue]) => {
      if (cancelled) return;
      setEmployeeSortOrder({
        service: svc ?? [],
        küche:   kue ?? [],
      });
    }).catch(() => { /* silent — fallback to default order */ });
    return () => { cancelled = true; };
  }, [tenantId]);

  // Manager sehen niemals Einzellöhne – effectiveShowCosts ist für sie immer false
  const effectiveShowCosts = canSeeHourlyWages && showCosts;
  // ─────────────────────────────────────────────────────────────────────────

  // Use same password as admin/overview
  const ADMIN_PASSWORD_KEY = 'admin_password';
  const DEFAULT_ADMIN_PASSWORD = 'admin123';
  
  // ── Data loading ─────────────────────────────────────────────────────────────
  //
  // ROOT CAUSE OF THE INCOGNITO REFRESH BUG:
  //   1. getSession() reads from localStorage — returns an already-expired access
  //      token (the refresh hasn't happened yet on page load).
  //   2. setLoading(false) → SchedulePlanner mounts → queries fire with stale JWT.
  //   3. Supabase RLS silently returns 0 rows (no error, just empty data).
  //   4. scheduleData is set to {} — data disappears.
  //   5. TOKEN_REFRESHED fires later with a fresh JWT, but user?.id hasn't changed
  //      so the old useEffect([user?.id]) never re-triggers.
  //
  // FIX:
  //   • loadMonthData calls supabase.auth.getSession() at the very start to get
  //     the CURRENT, guaranteed-fresh token before every DB query.
  //   • AuthContext now increments sessionVersion on every auth event including
  //     TOKEN_REFRESHED and SIGNED_IN (same user, post-boot).
  //   • The useEffect depends on [sessionVersion, currentMonth] so a token renewal
  //     automatically re-triggers the data load with the fresh session.
  //
  const loadMonthData = useCallback(async () => {
    // ── Fetch-generation counter ─────────────────────────────────────────────
    // Increment FIRST.  Every setState call in this function is guarded by
    // `if (fetchGenRef.current !== gen) return` so that a newer concurrent
    // fetch can supersede this one.  This prevents the classic race:
    //   Gen-1 (stale JWT → RLS → 0 rows) lands after Gen-2 (fresh data)
    //   and wipes scheduleData with {}.
    const gen = ++fetchGenRef.current;
    const monthKey = format(currentMonth, 'yyyy-MM');

    setScheduleSource('loading');
    console.log('[ROUTE] loadMonthData gen=' + gen, { monthKey, sessionVersion });

    // ── Defensive getSession() ───────────────────────────────────────────────
    // Always call this first.  It awaits initializePromise + acquires the lock,
    // auto-refreshes an expired JWT if needed, and returns the current session.
    const { data: { session: freshSession }, error: sessionError } =
      await supabase.auth.getSession();

    const freshUserId = freshSession?.user?.id ?? null;
    const tokenExpiry = freshSession?.expires_at
      ? new Date(freshSession.expires_at * 1000).toISOString() : null;

    console.log('[ROUTE] getSession result', { gen, freshUserId, tokenExpiry, sessionError: sessionError?.message ?? null });

    if (sessionError || !freshUserId) {
      console.warn('[ROUTE] loadMonthData gen=' + gen + ' skipped – no valid session');
      return;
    }

    // Stale check — a newer fetch may have been started while getSession() was awaiting.
    if (fetchGenRef.current !== gen) {
      console.log('[ROUTE] gen=' + gen + ' superseded after getSession (current=' + fetchGenRef.current + ') – aborting');
      return;
    }

    setDataLoading(true);
    const roleAtLoad = isAdmin ? 'admin' : isServiceManager ? 'service_manager' : 'kueche_manager';
    console.log(`[SCHEDULE-LAUNCH] loadMonthData gen=${gen} – month=${monthKey} role=${roleAtLoad} userId=${freshUserId?.slice(0, 8)}…`);

    try {
      // ── Mitarbeiter ──────────────────────────────────────────────────────────
      if (tenantId === 'beaulieu') console.log('[BEAULIEU-TEST] employee load started for tenant: beaulieu');
      const supabaseEmployees = await loadEmployees(tenantId);
      if (fetchGenRef.current !== gen) { console.log('[ROUTE] gen=' + gen + ' superseded after employees – aborting'); return; }

      // Beaulieu: wenn Supabase leer → automatisch seeden (einmalig pro Session)
      if (tenantId === 'beaulieu' && supabaseEmployees !== null && supabaseEmployees.length === 0) {
        if (!hasAutoSeededBeaulieu.current) {
          hasAutoSeededBeaulieu.current = true;
          console.log('[BEAULIEU-STAFF] auto-seed triggered – Supabase ist leer');
          console.log(`[BEAULIEU-STAFF] active employees parsed: ${defaultEmployeesBeaulieu.length}`);
          const seedResult = await seedBeaulieuEmployees(defaultEmployeesBeaulieu);
          if (seedResult.errors.length > 0) {
            seedResult.errors.forEach(e => console.warn('[BEAULIEU-STAFF] seed error:', e));
          }
          // Nach Seed: Mitarbeitende erneut laden
          if (seedResult.count > 0) {
            const freshEmps = await loadEmployees('beaulieu');
            if (freshEmps && freshEmps.length > 0) {
              console.log(`[BEAULIEU-STAFF] visible in app: ${freshEmps.length}`);
              freshEmps.forEach(e => console.log(`[BEAULIEU-STAFF] "${e.name}" dept=${e.department} id=${e.id} wage=${e.monthlySalaryWith13th ?? e.monthlySalary ?? e.hourlyWage ?? 0}`));
              setEmployees(freshEmps);
              return;
            }
          }
        }
        console.log('[BEAULIEU-STAFF] employees loaded: 0 – Seed fehlgeschlagen oder keine Mitarbeitenden');
        setEmployees([]);
      }

      if (supabaseEmployees && supabaseEmployees.length > 0) {
        if (tenantId === 'beaulieu') {
          const bKüche   = supabaseEmployees.filter(e => e.department === 'küche');
          const bService = supabaseEmployees.filter(e => e.department === 'service');
          const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi', 'eduard', 'nahuel', 'nina'];
          const olivLeak = supabaseEmployees.filter(e => olivNames.some(o => e.name.toLowerCase().includes(o)));
          console.log(`[CHECK] ui employees beaulieu: ${supabaseEmployees.length} (Küche=${bKüche.length}, Service=${bService.length})`);
          console.log(`[CHECK] tenant isolation: ${olivLeak.length === 0 ? 'OK – keine Oliv-Daten sichtbar' : 'ERROR – Oliv-Leak: ' + olivLeak.map(e => e.name).join(', ')}`);
          console.log(`[CHECK] departments valid: ${bKüche.length > 0 && bService.length > 0 ? 'OK' : 'WARN – eine Abteilung leer'}`);
          console.log(`[BEAULIEU-STAFF] dienstplan visible count: ${supabaseEmployees.length} (Küche=${bKüche.length}, Service=${bService.length})`);
          console.log(`[BEAULIEU-STAFF] oliv leak detected: ${olivLeak.length > 0 ? 'yes – ' + olivLeak.map(e => e.name).join(', ') : 'no'}`);
          // ─── [CONSISTENCY] Standardformat für dienstplan + mirus ────────
          console.log(`[CONSISTENCY] tenant: ${tenantId}`);
          console.log(`[CONSISTENCY] dienstplan employees: ${supabaseEmployees.length}`);
          console.log(`[CONSISTENCY] employee names dienstplan: ${supabaseEmployees.map(e => e.name).join(', ')}`);
          console.log(`[CONSISTENCY] mirus matching base: ${supabaseEmployees.length}`);
          console.log(`[CONSISTENCY] employee names mirus: ${supabaseEmployees.map(e => e.name).join(', ')}`);
          console.log(`[CONSISTENCY] mismatch: ${olivLeak.length > 0 ? 'yes – Oliv-Leak: ' + olivLeak.map(e => e.name).join(', ') : 'no'}`);
          // Mirus-Name-Matching-Selbsttest
          runBeaulieuMatchTest(supabaseEmployees);
        } else {
          const beaulieuLeak = supabaseEmployees.filter(e => String(e.id).startsWith('b-'));
          console.log(`[CHECK] ui employees oliv: ${supabaseEmployees.length}`);
          console.log(`[CHECK] tenant isolation: ${beaulieuLeak.length === 0 ? 'OK – keine Beaulieu-Daten bei Oliv' : 'ERROR – Beaulieu-Leak: ' + beaulieuLeak.map(e => e.name).join(', ')}`);
          console.log(`[CONSISTENCY] tenant: ${tenantId}`);
          console.log(`[CONSISTENCY] dienstplan employees: ${supabaseEmployees.length}`);
          console.log(`[CONSISTENCY] mirus matching base: ${supabaseEmployees.length}`);
          console.log(`[CONSISTENCY] mismatch: ${beaulieuLeak.length > 0 ? 'yes – Beaulieu-Leak in Oliv' : 'no'}`);
        }
        // ID-Migration: wenn Supabase andere IDs zurückgibt als der lokale Fallback,
        // localStorage-Keys für actual-hours migrieren (verhindert Anzeige-Mismatch).
        const idMap = new Map<string, string>(); // oldId → newId
        for (const supaEmp of supabaseEmployees) {
          const localMatch = defaultEmployees.find(d => d.name === supaEmp.name);
          if (localMatch && localMatch.id !== supaEmp.id) {
            idMap.set(localMatch.id, supaEmp.id);
          }
        }
        if (idMap.size > 0) {
          console.log('[ID-Migration] Veraltete Employee-IDs in localStorage migrieren:', Object.fromEntries(idMap));
          for (let offset = 0; offset < 13; offset++) {
            const d = new Date();
            d.setMonth(d.getMonth() - offset);
            const mk = format(d, 'yyyy-MM');
            const sk = `actual-hours-${mk}`;
            const stored = localStorage.getItem(tenantKey(sk));
            if (!stored) continue;
            try {
              const data: Record<string, unknown> = JSON.parse(stored);
              const migrated: Record<string, unknown> = {};
              let changed = false;
              for (const [key, value] of Object.entries(data)) {
                const dateStr = key.slice(-10);
                const empId = key.slice(0, -11);
                const newId = idMap.get(empId);
                if (newId) {
                  migrated[`${newId}-${dateStr}`] = value;
                  changed = true;
                } else {
                  migrated[key] = value;
                }
              }
              if (changed) {
                localStorage.setItem(tenantKey(sk), JSON.stringify(migrated));
                console.log('[ID-Migration] Migriert:', sk, Object.keys(migrated).length, 'Einträge');
              }
            } catch { /* ignore */ }
          }
        }
        setEmployees(supabaseEmployees);
        // Cache aktualisieren: nächster Fallback hat immer die aktuellsten Mitarbeitenden
        try {
          localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(supabaseEmployees));
        } catch { /* ignore quota errors */ }
      } else if (supabaseEmployees === null) {
        const saved = localStorage.getItem(tenantKey('schedule-employees'));
        if (saved) { try { setEmployees(JSON.parse(saved)); } catch { /* ignore */ } }
      }

      // ── PLAN-Daten (schedule_entries) ────────────────────────────────────────
      console.log('[PLAN] fetch start', { gen, monthKey });
      const supabaseSchedule = await loadScheduleForMonth(currentMonth);
      const planKeys = supabaseSchedule !== null ? Object.keys(supabaseSchedule).length : 'error';
      console.log('[PLAN] fetch result', { gen, planKeys, isStale: fetchGenRef.current !== gen });

      if (fetchGenRef.current !== gen) {
        console.warn('[PLAN] gen=' + gen + ' superseded (current=' + fetchGenRef.current + ') – discarding plan result');
        return;
      }

      if (supabaseSchedule !== null) {
        // Safety: never silently erase an existing plan with an empty result.
        //
        // An empty Supabase result can mean:
        //   (a) genuinely no entries for the month, OR
        //   (b) RLS returned 0 rows due to an auth-timing issue
        //
        // Strategy:
        //  1. If Supabase returned 0 rows, first check localStorage for a non-empty
        //     cached version (written on every successful load / cell change).
        //     If localStorage has data, treat it as the canonical source to avoid
        //     data-loss from a transient Supabase hiccup at gen=1.
        //  2. If prevKeys > 0 and newKeys === 0 on a re-fetch (gen > 1), keep prev.
        //  3. Never overwrite localStorage with an empty result.
        setScheduleData(prev => {
          const prevKeys = Object.keys(prev).length;
          const newKeys  = Object.keys(supabaseSchedule).length;

          if (newKeys === 0) {
            // Try localStorage before accepting "empty from Supabase"
            try {
              const cached = localStorage.getItem(tenantKey(`schedule-v2-${monthKey}`));
              if (cached) {
                const localData: Record<string, unknown> = JSON.parse(cached);
                const localKeys = Object.keys(localData).length;
                if (localKeys > 0) {
                  console.warn(
                    `[PLAN] Supabase returned 0 rows but localStorage has ${localKeys} entries` +
                    ` (gen=${gen}) – using localStorage to prevent data-loss`
                  );
                  setScheduleSource('cache');
                  setLoadedEntryCount(localKeys);
                  return localData as Record<string, DaySchedule>;
                }
              }
            } catch { /* ignore parse errors */ }

            // localStorage also empty – if prev already has data (re-fetch case), keep it
            if (prevKeys > 0) {
              console.warn(
                `[PLAN] Supabase returned 0 rows and localStorage empty; keeping prev` +
                ` ${prevKeys} entries (gen=${gen})`
              );
              return prev;
            }

            // Both Supabase and localStorage empty → month has no entries yet
            console.log('[PLAN] state set – genuinely empty month', { gen, prevKeys });
            setScheduleSource('supabase');
            setLoadedEntryCount(0);
            return supabaseSchedule;
          }

          // Supabase returned real data – use it and update localStorage cache
          console.log('[PLAN] state set', { gen, newKeys, prevKeys });
          setScheduleSource('supabase');
          setLoadedEntryCount(newKeys);
          // Cache Supabase plan data to localStorage so PersonalFix can read
          // plan hours without requiring the user to click "Speichern" first.
          // Only write non-empty results to avoid nuking the cache with a stale 0-row response.
          try {
            localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(supabaseSchedule));
          } catch { /* quota exceeded – ignore */ }
          return supabaseSchedule;
        });
      } else {
        console.warn('[PLAN] Supabase error – using localStorage fallback');
        const saved = localStorage.getItem(tenantKey(`schedule-v2-${monthKey}`));
        const fallback = saved ? JSON.parse(saved) : {};
        setScheduleSource('cache');
        setLoadedEntryCount(Object.keys(fallback).length);
        setScheduleData(fallback);
      }

      // ── IST-Daten (actual_hours) ─────────────────────────────────────────────
      console.log('[IST] fetch start', { gen, monthKey });
      const [supabaseActual, kvAbsences, kvCellColors] = await Promise.all([
        loadActualHoursForMonth(currentMonth),
        loadMonthAbsences(monthKey, tenantId),
        loadCellColors(monthKey, tenantId),
      ]);
      setCellColors(kvCellColors);
      const kvAbsenceCount = Object.keys(kvAbsences).length;
      if (kvAbsenceCount > 0) {
        console.log(`[FE-STABLE] load holiday entries: ${kvAbsenceCount} entries for ${monthKey}`, Object.keys(kvAbsences));
      }
      const istKeys = supabaseActual !== null ? Object.keys(supabaseActual).length : 'error';
      console.log('[IST] fetch result', { gen, istKeys, isStale: fetchGenRef.current !== gen });

      if (fetchGenRef.current !== gen) {
        console.warn('[IST] gen=' + gen + ' superseded (current=' + fetchGenRef.current + ') – discarding ist result');
        return;
      }

      // Always read localStorage too — it may contain entries saved by the
      // EmbeddedSchedulePlanner that haven't been flushed to Supabase yet.
      const localStored = (() => {
        try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${monthKey}`)) || '{}'); }
        catch { return {}; }
      })();

      if (supabaseActual !== null) {
        // Smart merge: start from localStorage (preserves absenceType metadata),
        // then let Supabase win only when it has real hours (>0).
        // FE/K/F absences have hours=0 and are localStorage-only (Supabase has no absenceType column),
        // so we must NOT let a Supabase hours=0 overwrite a local absenceType entry.
        const merged: Record<string, ActualHoursEntry> = { ...localStored };
        for (const [key, supaVal] of Object.entries(supabaseActual as Record<string, ActualHoursEntry>)) {
          const localVal = (localStored as Record<string, ActualHoursEntry>)[key];
          if (supaVal.hours > 0) {
            // Real work hours from Supabase always win
            merged[key] = supaVal;
          } else if (!localVal?.absenceType) {
            // Supabase 0-hours only wins if localStorage has no absenceType (FE/K/F)
            merged[key] = supaVal;
          }
          // else: keep localStorage entry which has absenceType (FE/K/F)
        }

        // ── KV store restoration ─────────────────────────────────────────────
        // FE/K/F entries saved to KV store survive browser cache clears and
        // device switches. Merge them in: KV wins over 0-hour entries but
        // never over real work hours.
        let kvRestored = 0;
        for (const [key, absType] of Object.entries(kvAbsences)) {
          const existing = merged[key];
          if (!existing) {
            merged[key] = { hours: 0, absenceType: absType as ActualHoursEntry['absenceType'] };
            kvRestored++;
            console.log(`[FE-STABLE] holiday survived reload: ${key} type=${absType} (from KV – not in local/supabase)`);
          } else if (existing.hours === 0 && !existing.absenceType) {
            merged[key] = { hours: 0, absenceType: absType as ActualHoursEntry['absenceType'] };
            kvRestored++;
            console.log(`[FE-STABLE] holiday survived reload: ${key} type=${absType} (from KV – overwrote 0h entry)`);
          } else if (existing.absenceType) {
            console.log(`[FE-STABLE] merge kept existing holiday: ${key} type=${existing.absenceType} (KV has ${absType})`);
          } else {
            console.log(`[FE-STABLE] holiday replaced by working hours: ${key} hours=${existing.hours} – KV entry ignored`);
          }
        }
        if (kvRestored > 0) {
          console.log(`[FE-STABLE] ${kvRestored} holiday entries restored from KV store for ${monthKey}`);
        }

        const feCount = Object.values(merged).filter(v => v.absenceType).length;
        console.log('[IST] state set (merged)', { gen, supabase: istKeys, local: Object.keys(localStored).length, merged: Object.keys(merged).length, feEntries: feCount });
        // Log every preserved FE/K/F entry so we can confirm reload survives
        Object.entries(merged).forEach(([k, v]) => {
          if (v.absenceType) {
            console.log(`[FERIEN-IST] reload restored holiday entry: ${k} absenceType=${v.absenceType} hours=${v.hours}`);
          }
        });
        // Use a functional updater so that FE/K/F entries set by the user WHILE the
        // Supabase fetch was in-flight (they're already in `prev` but may not be in
        // `localStored` yet due to React batching) survive the merge.
        setActualHoursData(prev => {
          const result = { ...merged };
          for (const [key, val] of Object.entries(prev)) {
            if (val.absenceType && !result[key]?.absenceType) {
              // Keep FE/K/F from prev unless merged already has an absenceType entry
              // (real-hours entries in merged have hours > 0, not absenceType, so they
              // would already have overwritten via the merged computation above).
              if (!result[key] || result[key].hours === 0) {
                result[key] = val;
                console.log(`[FERIEN-IST] race-condition guard: kept prev absenceType entry ${key} type=${val.absenceType}`);
              }
            }
          }
          return result;
        });
        // Write merged back so PersonalFix and others always see the full dataset.
        // Re-read fresh localStorage here to include any FE entries written since the fetch started.
        const freshLocal: Record<string, ActualHoursEntry> = (() => {
          try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${monthKey}`)) || '{}'); } catch { return {}; }
        })();
        const finalForStorage: Record<string, ActualHoursEntry> = { ...freshLocal };
        for (const [key, val] of Object.entries(merged)) {
          // Let Supabase real-hours win in storage too
          if (val.hours > 0 || !freshLocal[key]?.absenceType) {
            finalForStorage[key] = val;
          }
        }
        localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(finalForStorage));
      } else {
        console.warn('[IST] Supabase error – using localStorage + KV absences');
        const withKvAbsences: Record<string, ActualHoursEntry> = { ...localStored };
        for (const [key, absType] of Object.entries(kvAbsences)) {
          const existing = withKvAbsences[key];
          if (!existing || (existing.hours === 0 && !existing.absenceType)) {
            withKvAbsences[key] = { hours: 0, absenceType: absType as ActualHoursEntry['absenceType'] };
            console.log(`[FE-STABLE] holiday survived reload (offline): ${key} type=${absType}`);
          }
        }
        setActualHoursData(withKvAbsences);
      }

      // ── Tagesbudgets ─────────────────────────────────────────────────────────
      const year           = currentMonth.getFullYear();
      const monthIdx       = currentMonth.getMonth();
      const monthlyRevenue = getMonthlyBudgetRevenue(year, monthIdx, tenantKey('budget_v1'));
      const allDays        = eachDayOfInterval({ start: startOfMonth(currentMonth), end: endOfMonth(currentMonth) });

      const savedBudgets    = localStorage.getItem(tenantKey('dailyBudgets'));
      const manualBudgets: Record<string, { plannedRevenue?: number; actualRevenue?: number }> =
        savedBudgets ? JSON.parse(savedBudgets) : {};
      const revenueOverrides: Record<string, number> =
        JSON.parse(localStorage.getItem(tenantKey('dailyRevenueOverrides')) || '{}');

      if (fetchGenRef.current !== gen) return;

      if (monthlyRevenue > 0) {
        const autoBudgets = distributeBudgetByWeekday(monthlyRevenue, allDays);
        const merged: Record<string, { plannedRevenue?: number; actualRevenue?: number; isOverride?: boolean }> = { ...autoBudgets };
        Object.entries(manualBudgets).forEach(([k, v]) => {
          if (v.actualRevenue !== undefined) merged[k] = { ...merged[k], actualRevenue: v.actualRevenue };
        });
        Object.entries(revenueOverrides).forEach(([k, v]) => { merged[k] = { ...merged[k], plannedRevenue: v, isOverride: true }; });
        setDailyBudgets(merged);
      } else {
        const merged: Record<string, { plannedRevenue?: number; actualRevenue?: number; isOverride?: boolean }> = { ...manualBudgets };
        Object.entries(revenueOverrides).forEach(([k, v]) => { merged[k] = { ...merged[k], plannedRevenue: v, isOverride: true }; });
        setDailyBudgets(merged);
      }

      console.log('[ROUTE] loadMonthData gen=' + gen + ' complete', { monthKey, planKeys, istKeys });
      console.log(`[SCHEDULE-LAUNCH] sync complete – gen=${gen} month=${monthKey} plan=${planKeys} ist=${istKeys} source=${scheduleSource}`);
    } catch (err) {
      console.error('[ROUTE] loadMonthData gen=' + gen + ' error', err);
    } finally {
      if (fetchGenRef.current === gen) setDataLoading(false);
    }
  // Depends on currentMonth + tenantId — sessionVersion controls re-runs via the
  // effect below, and the internal getSession() call guarantees a fresh token.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth, tenantId]);

  // ── Route enter / leave logging ──────────────────────────────────────────
  useEffect(() => {
    console.log('[ROUTE] entered dienstplanung', { sessionVersion });
    return () => { console.log('[ROUTE] left dienstplanung'); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mandantenwechsel: Mitarbeiter zurücksetzen ─────────────────────────────
  // Wenn der Mandant wechselt, sofort auf Cache-Mitarbeiter zurückfallen,
  // damit kein Mitarbeiter des anderen Mandanten kurz sichtbar ist.
  // Beaulieu: kein Placeholder-Fallback – echte Mitarbeitende kommen aus Supabase.
  useEffect(() => {
    console.log(`[TENANT] SchedulePlanner reset für ${tenantId}`);
    hasAutoSeededBeaulieu.current = false;
    if (tenantId === 'beaulieu') {
      console.log('[BEAULIEU] tenant active: beaulieu – clearing to empty until Supabase loads');
      setEmployees([]);
    } else {
      // Bevorzuge den gespeicherten Cache (enthält aktuelle Namen+Mitarbeiter) gegenüber
      // der veralteten defaultEmployees-Hardcodeliste. Fallback: defaultEmployees.
      const cached = localStorage.getItem(tenantKey('schedule-employees'));
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`[TENANT] Oliv reset: cache found (${parsed.length} MA) – using cache instead of defaultEmployees`);
            setEmployees(parsed);
          } else {
            setEmployees(defaultEmployees);
          }
        } catch {
          setEmployees(defaultEmployees);
        }
      } else {
        setEmployees(defaultEmployees);
      }
    }
    setScheduleData({});
    setActualHoursData({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // ── Trigger load when session is ready OR when the token is refreshed ───────
  // sessionVersion is 0 until boot is complete.
  // It increments on TOKEN_REFRESHED and SIGNED_IN, so a background token
  // renewal automatically re-fetches data even when user?.id stays the same.
  // currentMonth + tenantId in deps ensures re-fetch when month or tenant changes.
  useEffect(() => {
    if (sessionVersion > 0) {
      loadMonthData();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionVersion, currentMonth, tenantId]);

  // ── Auto-save absence map (FE/K/F) to KV store ───────────────────────────
  // FE/K/F entries are not persisted in Supabase actual_hours (no absence_type
  // column), so we save them to the app_settings KV store.  This ensures they
  // survive localStorage clears, browser cache wipes, and device switches.
  // We debounce by 800 ms to avoid a write on every individual hour change;
  // only the final absence map for the month is saved (small payload, ~20 entries).
  useEffect(() => {
    const monthKey = format(currentMonth, 'yyyy-MM');
    const absences: Record<string, string> = {};
    for (const [k, v] of Object.entries(actualHoursData)) {
      if (v.absenceType) absences[k] = v.absenceType;
    }
    const timer = setTimeout(() => {
      saveMonthAbsences(monthKey, absences, tenantId)
        .then(() => {
          const absenceKeys = Object.keys(absences);
          if (absenceKeys.length > 0) {
            console.log(`[FE-STABLE] save holiday entries: ${absenceKeys.length} entries for ${monthKey}`, absenceKeys);
          }
        })
        .catch(console.error);
    }, 800);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualHoursData, currentMonth]);

  // ── Re-fetch on page-visibility regain ───────────────────────────────────
  // When the user switches browser tabs away and back (or the OS suspends the
  // page), a fresh fetch is triggered.  This also covers SPA route changes if
  // the router unmounts/remounts the component (the mount effect above fires).
  useEffect(() => {
    const sessionVersionRef = { current: sessionVersion };
    sessionVersionRef.current = sessionVersion;

    const onVisible = () => {
      if (document.visibilityState === 'visible' && sessionVersionRef.current > 0) {
        console.log('[ROUTE] page became visible – re-fetching plan+ist data');
        loadMonthData();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // loadMonthData is recreated when currentMonth changes (its only dep), which
  // means this effect also re-registers when the month changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMonthData]);

  // ── Reload employees when Personalstamm signals a change ─────────────────
  // Two channels:
  //   1. storage event  — fires in OTHER tabs when 'employees-updated-at' changes
  //   2. employees-updated CustomEvent — fires in the SAME tab (SPA navigation)
  //      dispatched by Personalstamm after every save (new + update).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'employees-updated-at') {
        console.log('[PERSONAL_SYNC] employees-updated-at changed (other tab) – reloading employees');
        loadMonthData();
      }
    };
    const onEmployeesUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tenantId?: string; isNew?: boolean } | undefined;
      console.log('[PERSONAL_SYNC] employees-updated event (same tab) – reloading employees', detail);
      loadMonthData();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('employees-updated', onEmployeesUpdated);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('employees-updated', onEmployeesUpdated);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadMonthData]);

  // Re-read actual hours from localStorage when an external import fires `schedule-updated`
  useEffect(() => {
    const handleScheduleUpdated = () => {
      const monthKey = format(currentMonth, 'yyyy-MM');
      const storageKey = `actual-hours-${monthKey}`;
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          setActualHoursData(JSON.parse(saved));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('schedule-updated', handleScheduleUpdated);
    return () => window.removeEventListener('schedule-updated', handleScheduleUpdated);
  }, [currentMonth]);

  // Load plan-copied IST keys from localStorage whenever the month changes
  useEffect(() => {
    const mk = format(currentMonth, 'yyyy-MM');
    try {
      const storageKey = tenantId === 'oliv'
        ? `actual-hours-source-${mk}`
        : `${tenantId}:actual-hours-source-${mk}`;
      const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
      const keys = Object.keys(stored).filter(k => stored[k] === 'plan_auto_copy');
      setPlanCopiedKeys(new Set(keys));
    } catch {
      setPlanCopiedKeys(new Set());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth, tenantId]);

  // Get days in current month
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const daysInMonth = useMemo(
    () => eachDayOfInterval({ start: monthStart, end: monthEnd }),
    [monthStart.getTime(), monthEnd.getTime()],
  );

  // Get weeks in month — memoized so the scroll useEffect doesn't fire on every render
  const weeksInMonth = useMemo(
    () => eachWeekOfInterval({ start: monthStart, end: monthEnd }, { weekStartsOn: 1 }),
    [monthStart.getTime(), monthEnd.getTime()],
  );

  // When switching to week view (or changing month while in week view), auto-select the current week
  useEffect(() => {
    if (calendarView !== 'week') return;
    const today = new Date();
    const idx = weeksInMonth.findIndex(weekStart => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      return eachDayOfInterval({ start: weekStart, end: weekEnd })
        .filter(d => isWithinInterval(d, { start: monthStart, end: monthEnd }))
        .some(d => isSameDay(d, today));
    });
    if (idx >= 0) {
      setSelectedWeekIndex(idx);
    } else {
      // Not in this month — pick first week with at least 4 days
      const firstFull = weeksInMonth.findIndex(weekStart => {
        const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
        return eachDayOfInterval({ start: weekStart, end: weekEnd })
          .filter(d => isWithinInterval(d, { start: monthStart, end: monthEnd }))
          .length >= 4;
      });
      setSelectedWeekIndex(Math.max(0, firstFull));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarView, monthStart.getTime()]);

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

  // Keyboard navigation for week switching + ESC to cancel paint mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // ESC cancels paint mode
      if (e.key === 'Escape') {
        setPaintTool(null);
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
      } else if (calendarView === 'day') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSelectedDayOffset(prev => Math.max(0, prev - 1));
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setSelectedDayOffset(prev => Math.min(daysInMonth.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [calendarView, weeksInMonth.length, daysInMonth.length]);

  // Load staffing targets from localStorage on mount
  useEffect(() => {
    setStaffingTargets(loadStaffingTargets());
  }, []);

  // Get displayed days based on view mode
  const displayDays = useMemo(() => {
    if (calendarView === 'month') return daysInMonth;
    if (calendarView === 'day') return [daysInMonth[Math.min(selectedDayOffset, daysInMonth.length - 1)]];
    const weekStart = weeksInMonth[selectedWeekIndex] || weeksInMonth[0];
    const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: weekStart, end: weekEnd }).filter(
      d => isWithinInterval(d, { start: monthStart, end: monthEnd })
    );
  }, [calendarView, daysInMonth, selectedDayOffset, selectedWeekIndex, weeksInMonth, monthStart, monthEnd]);

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

  // Like calculateEmployeeHours, but skips Ferien (FE) and Krank (K) absences for cost calculation.
  // These are covered separately (insurance, separate budget) and should not generate hourly-wage costs.
  const ABSENCE_NO_COST = new Set(['FE', 'K']);
  const calculateCostableHours = (employeeId: string): number => {
    let totalHours = 0;
    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      if (!daySchedule) return;
      if (daySchedule.frühAbsence || daySchedule.spätAbsence) {
        const getAbsenceHours = (abbrev: string | null | undefined): number => {
          if (!abbrev) return 0;
          if (ABSENCE_NO_COST.has(abbrev)) return 0; // Ferien/Krank → keine Kosten
          const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
          if (shift && shiftMap[shift].countsToTarget) return shiftMap[shift].hours;
          return 0;
        };
        totalHours += getAbsenceHours(daySchedule.frühAbsence);
        totalHours += getAbsenceHours(daySchedule.spätAbsence);
      }
      totalHours += calculateDayHours(daySchedule);
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

    // Pre-check: will this change empty the entire cell?
    const currentEntry = scheduleData[cellKey] || {};
    const futureEntry = {
      ...currentEntry,
      ...(slotType === 'früh'
        ? { früh: value, frühAbsence: absenceType || null }
        : { spät: value, spätAbsence: absenceType || null }),
    };
    const willBeEmpty =
      !futureEntry.früh && !futureEntry.spät &&
      !futureEntry.frühAbsence && !futureEntry.spätAbsence;
    
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

        const date = cellKey.slice(-10);
        const employeeId = cellKey.slice(0, -11);
        saveScheduleEntry(employeeId, date, null).catch(err =>
          console.error('[SCHEDULE] saveScheduleEntry (delete) error:', err)
        );

        const monthKey = format(currentMonth, 'yyyy-MM');
        localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(newState));
        console.log(`[SCHEDULE] cell cleared – key=${cellKey}`);

        window.dispatchEvent(new CustomEvent('schedule-updated'));
        return newState;
      }

      const newState = { ...prev, [cellKey]: updated };

      const entryDate = cellKey.slice(-10);
      const entryEmpId = cellKey.slice(0, -11);
      saveScheduleEntry(entryEmpId, entryDate, updated).catch(err => {
        console.error('[SCHEDULE] saveScheduleEntry error:', err);
        setSaveError('Eintrag konnte nicht gespeichert werden');
      });

      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(newState));
      setLastSaveTime(new Date());
      setSaveError(null);
      console.log(`[SCHEDULE] cell saved – key=${cellKey}`);

      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return newState;
    });

    // ── Auto-Kopie Abwesenheit → Ist-Stunden ───────────────────────────────
    // Wenn Ferien (FE) im Plan gesetzt wird → Ist-Eintrag mit hours=0 + absenceType='FE'.
    // Andere Abwesenheiten (K, …) → wie bisher mit konfigurierten Stunden, aber NUR
    // wenn noch keine echten importierten Arbeitsstunden vorhanden sind.
    if (absenceType) {
      const isFE = absenceType === 'FE';
      const absShiftCfg = Object.values(shiftMap).find(s => s.abbrev === absenceType);
      const absHours = absShiftCfg?.hours ?? 0;
      const shouldCopy = isFE || (absHours > 0 && absShiftCfg?.countsToTarget !== false);

      if (shouldCopy) {
        setActualHoursData(prevActual => {
          const existing = prevActual[cellKey];
          // Echte importierte Arbeitsstunden (Uhrzeit) nicht überschreiben
          if (existing?.start && existing?.end) return prevActual;
          // Echten Ist-Import (hours > 0, kein absenceType) nicht überschreiben
          if (existing && existing.hours > 0 && !existing.absenceType) return prevActual;

          // Ferien: 0h + absenceType='FE'; andere: konfigurierte Stunden
          const newEntry: ActualHoursEntry = isFE
            ? { hours: 0, absenceType: 'FE' as const }
            : { hours: absHours };

          console.log(`[FERIEN] plan->ist übernommen: ${employeeId} ${date} absenceType=${absenceType} → Ist hours=${newEntry.hours}`);

          // FE-Einträge werden NICHT nach Supabase gespeichert — Supabase hat keine absenceType-Spalte.
          // Beim nächsten Load würde Supabase (hours:0 ohne absenceType) den localStorage-Eintrag überschreiben.
          if (!isFE) {
            saveActualHourEntry(employeeId, date, newEntry).catch(err =>
              console.error('[SCHEDULE] auto-absence actualHours error:', err)
            );
          }
          const mk = format(currentMonth, 'yyyy-MM');
          const stored: Record<string, unknown> = (() => {
            try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${mk}`)) || '{}'); }
            catch { return {}; }
          })();
          localStorage.setItem(tenantKey(`actual-hours-${mk}`), JSON.stringify({ ...stored, [cellKey]: newEntry }));
          return { ...prevActual, [cellKey]: newEntry };
        });
      }
    }
    // ── Ende Auto-Kopie ────────────────────────────────────────────────────

    // ── Angebot: IST-Eintrag löschen wenn er aus Plan übernommen wurde ──────
    if (willBeEmpty && planCopiedKeys.has(cellKey)) {
      toast('Plan-Schicht gelöscht', {
        description: 'Soll auch der automatisch übernommene IST-Eintrag gelöscht werden?',
        action: {
          label: 'IST löschen',
          onClick: () => {
            setActualHoursData(prev => {
              const next = { ...prev };
              delete next[cellKey];
              const mk = format(currentMonth, 'yyyy-MM');
              localStorage.setItem(tenantKey(`actual-hours-${mk}`), JSON.stringify(next));
              return next;
            });
            saveActualHourEntry(employeeId, date, null).catch(console.error);
            setPlanCopiedKeys(prev => {
              const next = new Set(prev);
              next.delete(cellKey);
              const mk = format(currentMonth, 'yyyy-MM');
              try {
                const stored = JSON.parse(localStorage.getItem(tenantKey(`actual-hours-source-${mk}`)) || '{}');
                delete stored[cellKey];
                localStorage.setItem(tenantKey(`actual-hours-source-${mk}`), JSON.stringify(stored));
              } catch { /* ignore */ }
              return next;
            });
            toast.success('IST-Eintrag gelöscht');
          },
        },
      });
    }
  };

  // ── Plan → IST Übernahme ─────────────────────────────────────────────────

  const doSavePlanToIst = useCallback((
    employeeId: string,
    date: string,
    cellKey: string,
    entry: ActualHoursEntry,
  ) => {
    setActualHoursData(prev => ({ ...prev, [cellKey]: entry }));
    saveActualHourEntry(employeeId, date, entry).catch(err =>
      console.error('[PLAN→IST] saveActualHourEntry error:', err)
    );
    const mk = format(currentMonth, 'yyyy-MM');
    const prefix = tenantId === 'oliv' ? '' : `${tenantId}:`;
    const sourceKey = `${prefix}actual-hours-source-${mk}`;
    const hoursKey  = `${prefix}actual-hours-${mk}`;
    try {
      const stored = JSON.parse(localStorage.getItem(sourceKey) || '{}');
      stored[cellKey] = 'plan_auto_copy';
      localStorage.setItem(sourceKey, JSON.stringify(stored));
    } catch { /* ignore */ }
    try {
      const prev = JSON.parse(localStorage.getItem(hoursKey) || '{}');
      localStorage.setItem(hoursKey, JSON.stringify({ ...prev, [cellKey]: entry }));
    } catch { /* ignore */ }
    setPlanCopiedKeys(prev => new Set([...prev, cellKey]));
    toast.success('Schicht auch im IST gespeichert');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMonth, tenantId]);

  const handleCopyPlanToIst = useCallback((
    employeeId: string,
    date: string,
    _slotType: 'früh' | 'spät',
    slot: TimeSlot,
  ) => {
    const cellKey = `${employeeId}-${date}`;
    const [sh, sm] = slot.start.split(':').map(Number);
    const [eh, em] = slot.end.split(':').map(Number);
    let h = eh - sh + (em - sm) / 60;
    if (h < 0) h += 24;
    const hours = Math.round(h * 100) / 100;
    const entry: ActualHoursEntry = { hours, start: slot.start, end: slot.end };

    const existing = actualHoursData[cellKey];
    const hasRealIst =
      existing &&
      (existing.hours > 0 || existing.absenceType) &&
      !planCopiedKeys.has(cellKey);

    if (hasRealIst) {
      toast('IST-Eintrag existiert bereits', {
        description: `${employeeId} am ${date} hat bereits einen IST-Eintrag. Überschreiben?`,
        action: {
          label: 'Überschreiben',
          onClick: () => doSavePlanToIst(employeeId, date, cellKey, entry),
        },
      });
      return;
    }

    doSavePlanToIst(employeeId, date, cellKey, entry);
  }, [actualHoursData, planCopiedKeys, doSavePlanToIst]);

  const handleAddAushilfe = (employee: Omit<Employee, 'id'>) => {
    const newEmployee: Employee = {
      ...employee,
      id: `aush_${Date.now()}`,
    };
    const updatedEmployees = [...employees, newEmployee];
    setEmployees(updatedEmployees);
    upsertEmployee(newEmployee);
    localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
    toast.success(`${employee.name} hinzugefügt`);
  };

  const handleRemoveEmployee = (employeeId: string) => {
    const emp = employees.find(e => e.id === employeeId);
    const updatedEmployees = employees.filter(e => e.id !== employeeId);
    setEmployees(updatedEmployees);
    dbDeleteEmployee(employeeId);
    localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
    if (emp) {
      toast.success(`${emp.name} entfernt`);
    }
  };

  const handleSave = async () => {
    if (isSaving) return;
    const monthKey = format(currentMonth, 'yyyy-MM');
    const entryCount = Object.keys(scheduleData).length;

    const roleLabel = isAdmin ? 'admin' : isServiceManager ? 'service_manager' : 'kueche_manager';
    console.log(`[SCHEDULE-LAUNCH] handleSave – month=${monthKey} entries=${entryCount} role=${roleLabel} dept=${activeDepartment}`);
    if (tenantId === 'beaulieu') console.log(`[BEAULIEU-TEST] schedule save started – month=${monthKey} entries=${entryCount} tenant=beaulieu`);

    if (entryCount === 0) {
      const confirmed = window.confirm(
        'Der Dienstplan ist leer. Trotzdem speichern? (Einträge in der Datenbank werden NICHT gelöscht.)'
      );
      if (!confirmed) return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      // Safe upsert-only save (no delete-all)
      await saveFullScheduleForMonth(currentMonth, scheduleData);
      await upsertAllEmployees(employees, tenantId);

      // localStorage backup
      localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(scheduleData));
      localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(employees));
      // Sicherer Partial-Upsert: nur Lohnkosten-Felder für den aktuellen Monat schreiben.
      // Kein Blob-Overwrite — Revenue-Felder anderer Monate bleiben in KV unberührt.
      {
        const laborUpdates: Record<string, Record<string, unknown>> = {};
        for (const [day, entry] of Object.entries(dailyBudgets)) {
          if (day.startsWith(monthKey)) {
            laborUpdates[day] = {
              plannedLaborCost: (entry as Record<string, unknown>).plannedLaborCost ?? 0,
              actualLaborCost:  (entry as Record<string, unknown>).actualLaborCost  ?? 0,
            };
          }
        }
        if (Object.keys(laborUpdates).length > 0) {
          import('@/lib/supabase-kv').then(({ safeUpsertDailyBudgets }) =>
            safeUpsertDailyBudgets(tenantKey('dailyBudgets'), laborUpdates, false).catch(() => {})
          );
        }
        localStorage.setItem(tenantKey('dailyBudgets'), JSON.stringify(dailyBudgets));
      }
      localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(actualHoursData));

      setLastSaveTime(new Date());
      setIsDirty(false);
      setSaveError(null);
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      toast.success(`Dienstplan für ${format(currentMonth, 'MMMM yyyy', { locale: de })} gespeichert (${entryCount} Einträge)`);
      console.log(`[SCHEDULE-LAUNCH] handleSave success – ${entryCount} entries persisted to Supabase`);
      if (tenantId === 'beaulieu') console.log(`[BEAULIEU-TEST] schedule save success – ${entryCount} entries, tenant=beaulieu isolated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      toast.error(`Speichern fehlgeschlagen: ${msg}`);
      console.error('[SCHEDULE-LAUNCH] handleSave failed:', err);
    } finally {
      setIsSaving(false);
    }
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
  const handleActualHoursChange = (employeeId: string, date: string, entry: { hours: number; start?: string; end?: string; absenceType?: 'FE' | 'K' | 'F' } | null) => {
    const cellKey = `${employeeId}-${date}`;

    setActualHoursData(prev => {
      if (entry === null) {
        const newState = { ...prev };
        const existing = prev[cellKey];
        delete newState[cellKey];

        // FE/K/F absences are localStorage-only — they were NEVER saved to Supabase,
        // so there is nothing to delete there. Calling delete would be a no-op at best;
        // at worst it could accidentally delete a real hours row for the same slot.
        if (existing?.absenceType) {
          console.log(`[FERIEN-IST] delete skipped Supabase (absence entry): ${cellKey} type=${existing.absenceType}`);
        } else {
          saveActualHourEntry(employeeId, date, null);
        }

        const monthKey = format(currentMonth, 'yyyy-MM');
        localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(newState));
        window.dispatchEvent(new CustomEvent('schedule-updated'));
        return newState;
      }

      const newState = { ...prev, [cellKey]: entry };

      // ── BUG 1 FIX ─────────────────────────────────────────────────────────
      // FE/K/F absences must NOT be persisted to Supabase.
      // Supabase has no "absenceType" column, so it would store only hours=0.
      // On the next page load from a fresh browser session (empty localStorage),
      // the merge logic would see hours=0 from Supabase with no local absenceType
      // and LOSE the FE information.  These entries live ONLY in localStorage.
      if (entry.absenceType) {
        console.log(`[FERIEN-IST] manual holiday preserved (localStorage-only, NOT sent to Supabase): ${cellKey} type=${entry.absenceType}`);
      } else {
        saveActualHourEntry(employeeId, date, entry);
      }

      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(newState));
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return newState;
    });
  };

  // Handle Mirus XLS Ist-Stunden import directly in the Dienstplan
  const handleImportMirusActualHours = async (entries: MirusDailyImportEntry[], mode: MirusImportMode) => {
    const affectedMonths = new Set(entries.map(e => e.date.slice(0, 7)));
    const supabaseSaves: Array<{ empId: string; date: string; hours: number }> = [];

    setActualHoursData(prev => {
      let updated = { ...prev };

      if (mode === 'replace') {
        const importedDates = new Set(entries.map(e => e.date));
        for (const key of Object.keys(updated)) {
          const dateFromKey = key.slice(-10);
          if (importedDates.has(dateFromKey)) {
            // BUG 1 FIX: NEVER delete FE/K/F absence entries in the replace-wipe loop.
            // The check for "existingEntry?.absenceType" below can only work if we
            // haven't already deleted the entry here.
            if (updated[key]?.absenceType) {
              console.log(`[FERIEN-IST] reload preserved holiday entry: ${key} (${updated[key].absenceType})`);
            } else {
              delete updated[key];
            }
          }
        }
      }

      let matchedCount = 0;
      const unmatched = new Set<string>();

      const debugNames = ['sadete', 'momand'];
      for (const entry of entries) {
        const isDebug = debugNames.some(d => entry.name.toLowerCase().includes(d));
        if (isDebug) {
          console.log('[Ist-Import] Verarbeite Eintrag:', { name: entry.name, date: entry.date, hours: entry.hours });
        }
        const { employee, matchStep } = matchEmployeeByName(entry.name, employees, isDebug);
        if (!employee) {
          unmatched.add(entry.name);
          if (isDebug) console.warn('[Ist-Import] KEIN Match für:', entry.name);
          continue;
        }
        if (isDebug) {
          console.log('[Ist-Import] Match gefunden:', { importName: entry.name, empName: employee.name, empId: employee.id, matchStep });
        }
        const cellKey = `${employee.id}-${entry.date}`;
        const existingEntry = updated[cellKey];  // now correctly reads preserved FE entries

        if (existingEntry?.absenceType) {
          console.log(`[FERIEN-IST] existing entry found: ${cellKey} absenceType=${existingEntry.absenceType} hours=${existingEntry.hours}`);
        }

        // Priority rule:
        // 1. Real imported hours (> 0) → highest priority, overwrites FE
        // 2. Existing FE/K/F absence → second priority, survives 0-hour imports
        // 3. Empty → lowest priority
        if (existingEntry?.absenceType && entry.hours === 0) {
          console.log(`[FERIEN-IST] preserved holiday entry because import had no hours: ${employee.name} ${entry.date}`);
          matchedCount++;
          continue;
        }
        if (existingEntry?.absenceType && entry.hours > 0) {
          console.log(`[FERIEN-IST] replaced holiday entry because import had working hours: ${employee.name} ${entry.date} (${existingEntry.absenceType} → ${entry.hours}h)`);
        }

        if (mode === 'replace' || !updated[cellKey]) {
          updated[cellKey] = { hours: entry.hours };
          supabaseSaves.push({ empId: employee.id, date: entry.date, hours: entry.hours });
        }
        matchedCount++;
      }

      for (const m of affectedMonths) {
        const sk = `actual-hours-${m}`;
        const ex = (() => { try { return JSON.parse(localStorage.getItem(tenantKey(sk)) || '{}'); } catch { return {}; } })();
        // Merge: start from existing localStorage (preserves FE entries not in `updated`),
        // then overlay with updated (which itself preserved FE via the delete loop fix above).
        const data = { ...ex };
        for (const [k, v] of Object.entries(updated)) {
          const dateFromKey = k.slice(-10);
          if (dateFromKey.slice(0, 7) === m) data[k] = v;
        }
        localStorage.setItem(tenantKey(sk), JSON.stringify(data));
      }

      window.dispatchEvent(new CustomEvent('schedule-updated'));

      const uniqueEmployees = new Set(entries.map(e => e.name));
      if (matchedCount > 0) {
        toast.success(`Mirus Ist-Stunden importiert: ${entries.length} Einträge, ${uniqueEmployees.size} Mitarbeiter`);
      }
      if (unmatched.size > 0) {
        toast.warning(`${unmatched.size} Mitarbeiter nicht gefunden: ${[...unmatched].slice(0, 3).join(', ')}`);
      }

      return updated;
    });

    // Supabase persistieren — parallel, außerhalb des setState-Callbacks
    if (supabaseSaves.length > 0) {
      await Promise.all(
        supabaseSaves.map(({ empId, date, hours }) =>
          saveActualHourEntry(empId, date, { hours }),
        ),
      );
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportPDF = () => {
    setExportInitialFormat('pdf');
    setExportDialogOpen(true);
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

      const rangeLabel = options.range === 'week'
        ? 'Woche'
        : options.range === 'custom'
          ? 'Zeitraum'
          : 'Monat';

      const restaurantName = tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv';
      if (options.format === 'pdf') {
        await exportScheduleToPDF({
          employees,
          currentMonth,
          department: options.department,
          dailyBudgets,
          scheduleData,
          showCosts: options.includeCosts,
          includeWeeklyPages: true,
          specificDays,
          employeeFriendly: options.employeeFriendly ?? false,
          restaurantName,
        });
        toast.success(`PDF (${rangeLabel}) erfolgreich exportiert`);
      } else {
        await exportScheduleTemplate({
          employees,
          currentMonth,
          department: options.department,
          dailyBudgets,
          scheduleData,
          specificDays,
          hoursType: options.hoursType,
          includeCosts: options.includeCosts,
          actualHoursData,
          restaurantName,
        });
        toast.success(`Excel (${rangeLabel}) erfolgreich exportiert`);
      }
    } catch (error) {
      toast.error('Fehler beim Export');
      console.error('Export error:', error);
    }
  };

  const handleExportTemplate = () => {
    setExportInitialFormat('excel');
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
    saveFullScheduleForMonth(currentMonth, newScheduleData);

    if (newEmployees && newEmployees.length > 0) {
      const updatedEmployees = [...employees, ...newEmployees];
      setEmployees(updatedEmployees);
      newEmployees.forEach(emp => upsertEmployee(emp, tenantId));
      localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
      toast.success(`${newEmployees.length} neue Mitarbeiter hinzugefügt: ${newEmployees.map(e => e.name).join(', ')}`);
    } else {
      toast.success('Dienstplan erfolgreich importiert');
    }
  };

  // Küchen-Plan PDF Import: delta-merge, küche-only, no full replace
  // ── Zielwert-Bearbeitung ─────────────────────────────────────────────────
  const handleOpenZielwertEdit = () => {
    const svc = resolveZielwert(_planYear, _planMonth, 'service', false).targetPercent;
    const kue = resolveZielwert(_planYear, _planMonth, 'küche',   false).targetPercent;
    const glb = resolveZielwert(_planYear, _planMonth, undefined,  false).targetPercent;
    setZielwertDraft({ service: svc.toFixed(1), küche: kue.toFixed(1), global: glb.toFixed(1), autoGlobal: false });
    setZielwertEditOpen(true);
  };

  const updateZielwertDraft = (field: 'service' | 'küche' | 'global', value: string) => {
    setZielwertDraft(prev => {
      const next = { ...prev, [field]: value };
      if (prev.autoGlobal && field !== 'global') {
        const svc = parseFloat(field === 'service' ? value : prev.service) || 0;
        const kue = parseFloat(field === 'küche'   ? value : prev.küche)   || 0;
        next.global = (svc + kue).toFixed(1);
      }
      return next;
    });
  };

  const handleSaveZielwerte = () => {
    const svcPct = parseFloat(zielwertDraft.service);
    const kuePct = parseFloat(zielwertDraft.küche);
    const glbPct = parseFloat(zielwertDraft.global);
    if (isNaN(svcPct) || isNaN(kuePct) || isNaN(glbPct)) return;
    const existingEntries = loadZielwerte();
    const findExistingId = (dept: ZielwertDepartment) =>
      existingEntries.find(e => e.year === _planYear && e.month === _planMonth && e.department === dept)?.id;
    saveZielwert({ year: _planYear, month: _planMonth, department: 'service', targetPercent: svcPct }, findExistingId('service'));
    saveZielwert({ year: _planYear, month: _planMonth, department: 'küche',   targetPercent: kuePct }, findExistingId('küche'));
    saveZielwert({ year: _planYear, month: _planMonth, department: 'all',     targetPercent: glbPct }, findExistingId('all'));
    setZielwertEditOpen(false);
    toast.success(`Zielwerte für ${format(currentMonth, 'MMMM yyyy', { locale: de })} gespeichert`);
  };

  const handleKüchenplanImport = (delta: Record<string, DaySchedule>, count: number) => {
    setScheduleData(prev => {
      const merged = { ...prev };
      for (const [key, ds] of Object.entries(delta)) {
        merged[key] = { ...(merged[key] || {}), ...ds };
        // Persist each entry to Supabase
        const date = key.slice(-10);
        const empId = key.slice(0, -11);
        saveScheduleEntry(empId, date, merged[key]);
      }
      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return merged;
    });
    toast.success(`Küchenplan importiert: ${count} Einträge übernommen`);
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

  const handleIstDayClick = (day: Date) => {
    setSelectedIstDay(day);
    setIstDayDetailDialogOpen(true);
  };

  // Manuellen Umsatz-Override für einen Tag setzen oder löschen
  const handleUpdatePlannedRevenue = (dateStr: string, value: number | null) => {
    const overrides: Record<string, number> =
      JSON.parse(localStorage.getItem(tenantKey('dailyRevenueOverrides')) || '{}');
    if (value === null) {
      delete overrides[dateStr];
    } else {
      overrides[dateStr] = value;
    }
    localStorage.setItem(tenantKey('dailyRevenueOverrides'), JSON.stringify(overrides));
    import('@/lib/supabase-kv').then(({ kvSet }) => kvSet('dailyRevenueOverrides', overrides).catch(() => {}));
    // State aktualisieren
    setDailyBudgets(prev => {
      const next = { ...prev };
      if (value === null) {
        // Zurück auf Auto-Wert — Monat neu laden
        loadMonthData();
        return prev;
      }
      next[dateStr] = { ...next[dateStr], plannedRevenue: value, isOverride: true };
      return next;
    });
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
    const updated = updatedEmployees.find(e => e.id === employeeId);
    if (updated) upsertEmployee(updated);
    localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
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
      const updated = updatedEmployees.find(e => e.id === selectedEmployeeFor8Hours.id);
      if (updated) upsertEmployee(updated);
      localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
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
      const merged = { ...employees.find(e => e.id === employeeData.id)!, ...employeeData };
      const updatedEmployees = employees.map(emp =>
        emp.id === employeeData.id ? merged : emp
      );
      setEmployees(updatedEmployees);
      upsertEmployee(merged);
      localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
      toast.success(`${employeeData.name} aktualisiert`);
    } else {
      // Add new employee
      const newEmployee: Employee = {
        ...employeeData,
        id: `emp_${Date.now()}`,
      };
      const updatedEmployees = [...employees, newEmployee];
      setEmployees(updatedEmployees);
      upsertEmployee(newEmployee);
      localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
      toast.success(`${employeeData.name} hinzugefügt`);
    }
    setSelectedEmployeeForEdit(null);
  };

  // Filter out employees who were not active in the displayed month.
  // Uses isEmployeeActiveInMonth which checks both exit date (employmentEndDate)
  // and entry date (contractStart) against the selected year/month.
  const activeEmployees = (() => {
    const yr  = currentMonth.getFullYear();
    const mon = currentMonth.getMonth() + 1;
    return employees.filter(e => {
      const active = isEmployeeActiveInMonth(e, yr, mon);
      if (!active) {
        let reason = 'unbekannt';
        if (e.employmentEndDate) {
          const exit = new Date(e.employmentEndDate + 'T00:00:00');
          if (exit.getFullYear() < yr || (exit.getFullYear() === yr && exit.getMonth() + 1 < mon)) {
            reason = `Austritt ${e.employmentEndDate} liegt vor Monat ${yr}-${String(mon).padStart(2,'0')}`;
          }
        }
        if (e.contractStart) {
          const entry = new Date(e.contractStart + 'T00:00:00');
          if (entry.getFullYear() > yr || (entry.getFullYear() === yr && entry.getMonth() + 1 > mon)) {
            reason = `Eintritt ${e.contractStart} liegt nach Monat ${yr}-${String(mon).padStart(2,'0')}`;
          }
        }
        console.warn(`[PERSONAL_SYNC] Mitarbeiter im Personalstamm vorhanden, aber im Dienstplan ausgefiltert: "${e.name}" (id=${e.id}) – Grund: ${reason}`);
      }
      return active;
    });
  })();

  // ── Sortierungsfunktion ────────────────────────────────────────────────────
  /** Sortiert eine Mitarbeiterliste anhand der gespeicherten Reihenfolge. */
  const applySort = (emps: Employee[], dept: 'service' | 'küche'): Employee[] => {
    const order = employeeSortOrder[dept];
    if (!order || order.length === 0) return emps;
    return [...emps].sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  };

  // Optionen für das Mitarbeiter-Dropdown (ohne Filter – Basis für Checkboxen)
  const dropdownEmployeeOptions: Employee[] = activeDepartment === 'all'
    ? [
        ...applySort(activeEmployees.filter(e => e.department === 'service'), 'service'),
        ...applySort(activeEmployees.filter(e => e.department === 'küche'), 'küche'),
      ]
    : applySort(activeEmployees.filter(e => e.department === activeDepartment), activeDepartment as 'service' | 'küche');

  // Gefilterte Optionen für das Suchfeld im Dropdown
  const empSearchLower = empSearchQuery.toLowerCase();
  const filteredDropdownOptions = empSearchLower
    ? dropdownEmployeeOptions.filter(e =>
        getEmployeeDisplayName(e).toLowerCase().includes(empSearchLower)
      )
    : dropdownEmployeeOptions;

  // Anzeigetext für den Trigger-Button
  const empFilterLabel = (() => {
    if (selectedEmployeeIds.length === 0) return 'Alle Mitarbeiter';
    if (selectedEmployeeIds.length <= 2) {
      return selectedEmployeeIds
        .map(id => dropdownEmployeeOptions.find(e => e.id === id))
        .filter(Boolean)
        .map(e => getEmployeeDisplayName(e!))
        .join(', ');
    }
    return `${selectedEmployeeIds.length} Mitarbeiter`;
  })();

  // Filter employees by active department (sorted by saved order) + optional multi-employee focus
  const filteredEmployees = (() => {
    let base: Employee[];
    if (activeDepartment === 'all') {
      // In Gesamtansicht: Service zuerst, dann Küche (je nach gespeicherter Reihenfolge)
      const svcEmps = applySort(activeEmployees.filter(e => e.department === 'service'), 'service');
      const kueEmps = applySort(activeEmployees.filter(e => e.department === 'küche'), 'küche');
      base = [...svcEmps, ...kueEmps];
    } else {
      base = applySort(activeEmployees.filter(e => e.department === activeDepartment), activeDepartment as 'service' | 'küche');
    }
    if (empTypeFilter === 'vollzeit') {
      base = base.filter(e => e.employmentType === 'vollzeit');
    } else if (empTypeFilter === 'teilzeit') {
      base = base.filter(e => e.employmentType === 'teilzeit' || e.employmentType === 'minijob' || e.employmentType === 'aushilfe');
    } else if (empTypeFilter === 'stundenlohn') {
      base = base.filter(e => !e.monthlySalary || e.monthlySalary === 0);
    }
    if (selectedEmployeeIds.length > 0) {
      const idSet = new Set(selectedEmployeeIds);
      base = base.filter(e => idSet.has(e.id));
    }
    return base;
  })();

  // ── Reihenfolge-Handler ────────────────────────────────────────────────────
  const handleMoveEmployee = (empId: string, dept: 'service' | 'küche', direction: 'up' | 'down') => {
    console.log(`[SORT] employee moved ${direction}: empId=${empId} dept=${dept}`);
    setEmployeeSortOrder(prev => {
      const deptEmployees = activeEmployees.filter(e => e.department === dept);
      // If no order saved yet, start from current display order
      const currentOrder = prev[dept].length > 0
        ? prev[dept]
        : deptEmployees.map(e => e.id);
      const idx = currentOrder.indexOf(empId);
      if (idx === -1) return prev;
      const next = [...currentOrder];
      if (direction === 'up' && idx > 0) {
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      } else if (direction === 'down' && idx < next.length - 1) {
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      } else {
        return prev;
      }
      // Persist asynchronously (fire-and-forget)
      saveEmployeeSortOrder(tenantId, dept, next)
        .then(() => console.log(`[SORT] order saved: dept=${dept} tenant=${tenantId}`))
        .catch(() => {});
      return { ...prev, [dept]: next };
    });
  };

  // ── Zellfarben-Handler ────────────────────────────────────────────────────
  const handleCellColorChange = (key: string, color: string | null) => {
    const monthKey = format(currentMonth, 'yyyy-MM');
    // key format: "empId-yyyy-MM-dd-früh" or "empId-yyyy-MM-dd-spät"
    const parts = key.split('-');
    const slot  = parts[parts.length - 1];           // früh | spät
    const date  = parts.slice(-4, -1).join('-');      // yyyy-MM-dd
    const empId = parts.slice(0, -4).join('-');       // employee id
    console.log(`[CELL-COLOR] employee: ${empId}`);
    console.log(`[CELL-COLOR] date: ${date}`);
    console.log(`[CELL-COLOR] slot: ${slot}`);
    console.log(`[CELL-COLOR] color: ${color ?? 'null (reset)'}`);
    console.log(`[CELL-COLOR] visual only: true`);
    setCellColors(prev => {
      const next = { ...prev };
      if (color === null) {
        delete next[key];
      } else {
        next[key] = color;
      }
      // Persist asynchronously
      saveCellColors(monthKey, next, tenantId).catch(() => {});
      return next;
    });
  };

  // Calculate summary stats only for active employees in the current month
  const employeeSummaries = activeEmployees.map(emp => {
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

  // Estimated hours for variable employees from Personal FIX page
  const varEstimatedHours: Record<string, number> = (() => {
    try { return JSON.parse(localStorage.getItem(tenantKey('personal_fix_var_hours_v1')) ?? '{}'); }
    catch { return {}; }
  })();

  // Variable employees whose planned hours exceed the estimated hours from Personal FIX
  const varHoursExceeded = employees
    .filter(e => !((e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit') && (e.monthlySalary ?? 0) > 0))
    .map(e => ({ emp: e, planned: calculateEmployeeHours(e.id), estimated: varEstimatedHours[e.id] ?? 0 }))
    .filter(r => r.estimated > 0 && r.planned > r.estimated);

  // ── Pattern warnings (consecutive days, late streaks, short recovery, overload) ──
  const patternWarnings = useMemo<PatternWarning[]>(
    () => detectPatternWarnings(employees, daysInMonth, scheduleData),
    [employees, daysInMonth, scheduleData],
  );

  // ── Feature 1: Personalkostenquote ──────────────────────────────────────
  const _planYear  = currentMonth.getFullYear();
  const _planMonth = currentMonth.getMonth() + 1;
  const _globalResolved    = resolveZielwert(_planYear, _planMonth, undefined, false);
  const laborCostThreshold = _globalResolved.targetPercent;

  // Kosten und Stunden werden auf die sichtbare Abteilung gefiltert.
  // Ein Manager sieht nur die Zahlen seiner eigenen Abteilung.
  const visibleEmployees = filteredEmployees; // enthält schon die Rollen-Filterung

  const totalPlannedLaborCost = visibleEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + emp.monthlySalary;
    }
    const hrs = calculateCostableHours(emp.id); // Ferien/Krank excluded
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const visibleEmployeeIds = new Set(visibleEmployees.map(e => e.id));

  const monthDateSet = new Set(daysInMonth.map(d => format(d, 'yyyy-MM-dd')));
  const displayDateSet = new Set(displayDays.map(d => format(d, 'yyyy-MM-dd')));

  // ── Geplanter Umsatz: Monat / Woche / Tag ─────────────────────────────────
  const monthlyPlannedRevenue = Object.entries(dailyBudgets)
    .filter(([date]) => monthDateSet.has(date))
    .reduce((sum, [, b]) => sum + (b.plannedRevenue || 0), 0);

  const weeklyPlannedRevenue = Object.entries(dailyBudgets)
    .filter(([date]) => displayDateSet.has(date))
    .reduce((sum, [, b]) => sum + (b.plannedRevenue || 0), 0);


  // ── Geplante Personalkosten: Monat / Woche / Tag ───────────────────────────
  const weeklyPlannedLaborCost = visibleEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + emp.monthlySalary * (displayDays.length / daysInMonth.length);
    }
    const hrs = displayDays.reduce((h, day) => {
      const cellKey = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
      const ds = scheduleData[cellKey];
      return h + (ds ? calculateDayHours(ds) : 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  // ── Ist-Personalkosten: aus tatsächlich erfassten Stunden ──────────────────
  const weeklyIstLaborCost = visibleEmployees.reduce((sum, emp) => {
    const hrs = displayDays.reduce((h, day) => {
      const cellKey = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
      const entry = actualHoursData[cellKey];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const monthlyIstLaborCost = visibleEmployees.reduce((sum, emp) => {
    const hrs = daysInMonth.reduce((h, day) => {
      const cellKey = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
      const entry = actualHoursData[cellKey];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  // ── Gesamt-Personalkosten (immer Küche + Service, unabhängig vom Dept-Filter) ──────
  const gesamtMonthlyPlannedLaborCost = activeEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + emp.monthlySalary;
    }
    const hrs = calculateCostableHours(emp.id);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const gesamtWeeklyPlannedLaborCost = activeEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + emp.monthlySalary * (displayDays.length / daysInMonth.length);
    }
    const hrs = displayDays.reduce((h, day) => {
      const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (ds ? calculateDayHours(ds) : 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const gesamtWeeklyIstLaborCost = activeEmployees.reduce((sum, emp) => {
    const hrs = displayDays.reduce((h, day) => {
      const entry = actualHoursData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const gesamtMonthlyIstLaborCost = activeEmployees.reduce((sum, emp) => {
    const hrs = daysInMonth.reduce((h, day) => {
      const entry = actualHoursData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * emp.hourlyWage;
  }, 0);

  const gesamtActiveLaborCost = scheduleMode === 'ist'
    ? (calendarView === 'month' ? gesamtMonthlyIstLaborCost : gesamtWeeklyIstLaborCost)
    : (calendarView === 'month' ? gesamtMonthlyPlannedLaborCost : gesamtWeeklyPlannedLaborCost);

  // ── Ist-Umsatz ─────────────────────────────────────────────────────────────
  const monthlyActualRevenue = Object.entries(dailyBudgets)
    .filter(([date]) => monthDateSet.has(date))
    .reduce((sum, [, b]) => sum + (b.actualRevenue || 0), 0);

  const weeklyActualRevenue = Object.entries(dailyBudgets)
    .filter(([date]) => displayDateSet.has(date))
    .reduce((sum, [, b]) => sum + (b.actualRevenue || 0), 0);

  // ── Aktive Werte nach gewählter Periode (calendarView als Quelle) ────────
  // Plan-Modus → Budgetwerte; Ist-Modus → Ist-Umsatz
  const activePlannedRevenue =
    calendarView === 'month' ? monthlyPlannedRevenue : weeklyPlannedRevenue;
  const activeIstRevenue =
    calendarView === 'month' ? monthlyActualRevenue : weeklyActualRevenue;
  const activeRevenue = scheduleMode === 'ist' ? activeIstRevenue : activePlannedRevenue;

  const gesamtCostRatio = activeRevenue > 0 ? (gesamtActiveLaborCost / activeRevenue) * 100 : null;
  const gesamtCostRatioStatus: 'good' | 'ok' | 'high' | 'unknown' =
    gesamtCostRatio === null ? 'unknown' :
    gesamtCostRatio <= laborCostThreshold ? 'good' :
    gesamtCostRatio <= laborCostThreshold + 5 ? 'ok' : 'high';

  // Im Ist-Modus: Kosten aus erfassten Ist-Stunden, nicht aus Planung
  const activeLaborCost = scheduleMode === 'ist'
    ? (calendarView === 'month' ? monthlyIstLaborCost : weeklyIstLaborCost)
    : (calendarView === 'month' ? totalPlannedLaborCost : weeklyPlannedLaborCost);

  // ── Effektiver Zielwert: aus Zielwerte-Store, abteilungsspezifisch ──────────
  const _serviceResolved = resolveZielwert(_planYear, _planMonth, 'service', false);
  const _kücheResolved   = resolveZielwert(_planYear, _planMonth, 'küche',   false);

  // Zielwerte direkt aus dem Store (Fallback im Store bereits dept-spezifisch: 20 % je Abt.)
  const serviceThreshold = _serviceResolved.targetPercent;
  const kücheThreshold   = _kücheResolved.targetPercent;

  const effectiveLaborCostThreshold = activeDepartment === 'service'
    ? serviceThreshold
    : activeDepartment === 'küche'
      ? kücheThreshold
      : laborCostThreshold; // global für 'all'

  // ScheduleGrid-Schwellwert: abteilungsspezifisch oder global bei Gesamtansicht
  const gridLaborCostThreshold = effectiveLaborCostThreshold;

  // ── Label für die aktive Periode ─────────────────────────────────────────
  const pkqPeriodLabel = useMemo(() => {
    if (calendarView === 'month') return format(currentMonth, 'MMMM yyyy', { locale: de });
    if (calendarView === 'day' && displayDays[0]) {
      return format(displayDays[0], 'EEEE, d.M.yyyy', { locale: de });
    }
    if (calendarView === 'week' && displayDays.length > 0) {
      const first = displayDays[0];
      const last  = displayDays[displayDays.length - 1];
      return `KW\u00a0${format(first, 'w')} · ${format(first, 'd.M.')}–${format(last, 'd.M.yyyy')}`;
    }
    return '';
  }, [calendarView, currentMonth, displayDays]);

  const pkqPeriodName =
    calendarView === 'month' ? 'Monat' :
    calendarView === 'week'  ? 'Woche' : 'Tag';

  // Kurz-Label für den Card-Header
  const periodShortLabel = useMemo(() => {
    if (calendarView === 'month') return format(currentMonth, 'MMM yyyy', { locale: de });
    if (calendarView === 'week' && displayDays.length > 0) {
      return `KW\u00a0${format(displayDays[0], 'w')}`;
    }
    if (calendarView === 'day' && displayDays[0]) {
      return format(displayDays[0], 'EEE d.M.', { locale: de });
    }
    return '';
  }, [calendarView, currentMonth, displayDays]);

  // Navigations-Handler für den Card-Header (◀ / ▶)
  const handlePrevPeriod = () => {
    if (calendarView === 'month') setCurrentMonth(prev => subMonths(prev, 1));
    else if (calendarView === 'week') setSelectedWeekIndex(prev => Math.max(0, prev - 1));
    else setSelectedDayOffset(prev => Math.max(0, prev - 1));
  };
  const handleNextPeriod = () => {
    if (calendarView === 'month') setCurrentMonth(prev => addMonths(prev, 1));
    else if (calendarView === 'week') setSelectedWeekIndex(prev => Math.min(weeksInMonth.length - 1, prev + 1));
    else setSelectedDayOffset(prev => Math.min(daysInMonth.length - 1, prev + 1));
  };
  const isPrevDisabled = calendarView === 'week' ? selectedWeekIndex === 0
    : calendarView === 'day' ? selectedDayOffset === 0 : false;
  const isNextDisabled = calendarView === 'week' ? selectedWeekIndex >= weeksInMonth.length - 1
    : calendarView === 'day' ? selectedDayOffset >= daysInMonth.length - 1 : false;

  const handleNavigateToday = () => {
    const today = new Date();
    setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedWeekIndex(0);
    setSelectedDayOffset(0);
  };

  // Für Rückwärtskompatibilität (wird noch an anderen Stellen referenziert)
  const totalPlannedRevenue = monthlyPlannedRevenue;

  const plannedCostRatio = activeRevenue > 0
    ? (activeLaborCost / activeRevenue) * 100
    : null;
  const costRatioStatus: 'good' | 'ok' | 'high' | 'unknown' =
    plannedCostRatio === null ? 'unknown' :
    plannedCostRatio <= effectiveLaborCostThreshold ? 'good' :
    plannedCostRatio <= effectiveLaborCostThreshold + 5 ? 'ok' : 'high';

  // ── Feature 3: Soll/Ist-Vergleich ────────────────────────────────────────
  // Stunden ebenfalls nur für die sichtbare Abteilung
  const totalPlannedHoursAll = departmentSummaries.reduce((sum, s) => sum + s.plannedHours, 0);
  const totalActualHoursAll = Object.entries(actualHoursData)
    .filter(([key]) => {
      const dateStr = key.slice(-10);
      const empId   = key.slice(0, key.length - 11); // format: "empId-yyyy-MM-dd"
      return monthDateSet.has(dateStr) && visibleEmployeeIds.has(empId);
    })
    .reduce((sum, [, e]) => sum + e.hours, 0);
  const hoursVariance = totalActualHoursAll - totalPlannedHoursAll;

  const totalActualRevenue = Object.entries(dailyBudgets)
    .filter(([date]) => monthDateSet.has(date))
    .reduce((sum, [, b]) => sum + (b.actualRevenue || 0), 0);
  const totalActualLaborCost = visibleEmployees.reduce((sum, emp) => {
    const actualHrs = Object.entries(actualHoursData)
      .filter(([key]) => monthDateSet.has(key.slice(-10)) && key.startsWith(`${emp.id}-`))
      .reduce((s, [, e]) => s + e.hours, 0);
    return sum + actualHrs * emp.hourlyWage;
  }, 0);
  const actualCostRatio = totalActualRevenue > 0 && totalActualLaborCost > 0
    ? (totalActualLaborCost / totalActualRevenue) * 100
    : null;
  const hasActualHours = totalActualHoursAll > 0;
  const hasActualRevenue = totalActualRevenue > 0;

  // ── Ferienabbau (FE-Einträge im Plan + Ist) ────────────────────────────────
  // Plan-FE: scheduleData[key].frühAbsence === 'FE' oder spätAbsence === 'FE'
  // Ist-FE:  actualHoursData[key].absenceType === 'FE' (hours=0)
  // Ferienabbau CHF = FE-Tage × (weeklyHours/5 oder 8.4h) × Stundenlohn
  const { ferienSollTage, ferienSollCHF, ferienIstTage, ferienabbauCHF } = useMemo(() => {
    let sollTage = 0;
    let sollChf = 0;
    let istTage = 0;
    let istChf = 0;

    for (const emp of visibleEmployees) {
      const dailyH = emp.weeklyHours ? emp.weeklyHours / 5 : 8.4;
      let empSollFe = 0;
      let empIstFe = 0;

      for (const day of daysInMonth) {
        const dateStr = format(day, 'yyyy-MM-dd');
        const key = `${emp.id}-${dateStr}`;

        // Plan-Seite
        const planEntry = scheduleData[key];
        if (planEntry?.frühAbsence === 'FE' || planEntry?.spätAbsence === 'FE') {
          empSollFe++;
        }

        // Ist-Seite
        const istEntry = actualHoursData[key];
        if (istEntry?.absenceType === 'FE') {
          empIstFe++;
          console.log(`[FERIEN] nicht in Totalstunden eingerechnet: ${emp.name} ${dateStr} (FE 0h)`);
        }
      }

      if (empSollFe > 0) {
        const chf = empSollFe * dailyH * emp.hourlyWage;
        console.log(`[FERIEN] Soll-Ferienabbau: ${emp.name} ${empSollFe} Tage × ${dailyH.toFixed(1)}h × CHF ${emp.hourlyWage} = CHF ${chf.toFixed(2)}`);
        sollTage += empSollFe;
        sollChf  += chf;
      }
      if (empIstFe > 0) {
        const chf = empIstFe * dailyH * emp.hourlyWage;
        console.log(`[FERIEN] Ist-Ferienabbau: ${emp.name} ${empIstFe} Tage × ${dailyH.toFixed(1)}h × CHF ${emp.hourlyWage} = CHF ${chf.toFixed(2)}`);
        istTage += empIstFe;
        istChf  += chf;
      }
    }

    return {
      ferienSollTage: sollTage,
      ferienSollCHF:  sollChf,
      ferienIstTage:  istTage,
      ferienabbauCHF: istChf,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleData, actualHoursData, visibleEmployees, daysInMonth]);

  // ── Planungshilfe: Jump + Remove-Handler ──────────────────────────────────

  const handleJumpToDay = useCallback((day: Date, empId?: string) => {
    // Find which week this day belongs to
    const weekIdx = weeksInMonth.findIndex(weekStart => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      return isWithinInterval(day, { start: weekStart, end: weekEnd });
    });
    if (weekIdx >= 0) {
      setCalendarView('week');
      setSelectedWeekIndex(weekIdx);
    }
    if (empId) {
      setHighlightedEmpId(empId);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedEmpId(null), 5000);
    }
  }, [weeksInMonth]);

  const handleRemoveShiftFromAssistant = useCallback((empId: string, dateStr: string, slot: 'früh' | 'spät') => {
    handleSlotChange(empId, dateStr, slot, null, null);
  }, []);

  /** Merge template delta into scheduleData, then save */
  const handleApplyTemplate = useCallback((delta: Record<string, DaySchedule>) => {
    setScheduleData(prev => ({ ...prev, ...delta }));
    setTimeout(() => handleSave(), 200);
  }, [handleSave]);

  const handleBulkApplyActual = useCallback((delta: Record<string, { hours: number; start?: string; end?: string }>) => {
    setActualHoursData(prev => {
      const next = { ...prev, ...delta };
      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(next));
      // Persist each entry to Supabase
      Object.entries(delta).forEach(([key, entry]) => {
        const date = key.slice(-10);
        const empId = key.slice(0, -11);
        saveActualHourEntry(empId, date, entry).catch(err =>
          console.error('[SCHEDULE] bulkActual save error:', err)
        );
      });
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return next;
    });
  }, [currentMonth]);

  /** Update a single employee's station data in local state */
  const handleStationEmployeeUpdated = useCallback((updated: Employee) => {
    setEmployees(prev => prev.map(e => e.id === updated.id ? updated : e));
  }, []);

  // Show a clear loading state while auth is resolving or first data fetch is running.
  // This prevents an empty grid from showing before Supabase queries complete.
  if (authLoading || (!user && !dataLoading)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm">Session wird geladen…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Kein Zugriff – bitte einloggen.</p>
      </div>
    );
  }

  return (
    <div className="bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-[1800px] mx-auto px-4">

          {/* ── Row 1: Titel + primäre Aktionen ────────────────────────────── */}
          <div className="flex items-center justify-between gap-2 py-2 border-b border-border/40">
            <div className="flex items-center gap-2 min-w-0">
              <Link to="/">
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Zur Übersicht">
                  <Home className="h-4 w-4" />
                </Button>
              </Link>
              <div className="min-w-0">
                <h1 className="text-base font-bold text-foreground leading-tight">Dienstplanung</h1>
                <p className="text-[11px] text-muted-foreground leading-tight hidden sm:block">
                  Oliv Gastro AG
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {/* ── Save-Status Pill ───────────────────────────────── */}
              {saveError && (
                <span className="hidden sm:flex items-center gap-1 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5" title={saveError}>
                  <span>⚠ Fehler</span>
                </span>
              )}
              {!saveError && lastSaveTime && (
                <span className="hidden sm:flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                  ✓ {lastSaveTime.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              {/* ── Debug Pill ─────────────────────────────────────── */}
              <span
                title={`Quelle: ${scheduleSource} | Geladen: ${loadedEntryCount} | Im State: ${Object.keys(scheduleData).length}`}
                className={`hidden lg:flex items-center gap-0.5 text-[10px] border rounded px-1 py-0.5 cursor-default select-none ${
                  scheduleSource !== 'loading' && loadedEntryCount === 0
                    ? 'text-amber-700 bg-amber-50 border-amber-300 font-medium'
                    : 'text-muted-foreground bg-muted'
                }`}
              >
                <span>{scheduleSource === 'loading' ? '⏳' : scheduleSource === 'supabase' ? '☁' : '💾'}</span>
                <span>{loadedEntryCount}</span>
              </span>
              <Button onClick={handleSave} disabled={isSaving} size="sm" className="gap-1.5 h-8">
                <Save className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{isSaving ? 'Speichert…' : 'Speichern'}</span>
              </Button>
              <Link to="/settings">
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Einstellungen">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
              {/* Mehr-Dropdown: alle selteneren Werkzeuge */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Weitere Werkzeuge">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => setPlanningAssistantOpen(true)}>
                    <Lightbulb className="h-4 w-4 mr-2 text-indigo-500" />
                    Planungshilfe
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setBulkActionsOpen(true)}>
                    <Zap className="h-4 w-4 mr-2 text-yellow-500" />
                    Schnellaktionen
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTimeSlotStaffingOpen(true)}>
                    <Clock className="h-4 w-4 mr-2 text-teal-500" />
                    Besetzungscheck
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setTemplateDialogOpen(true)}>
                    <BookOpen className="h-4 w-4 mr-2 text-emerald-500" />
                    Wochenvorlagen
                  </DropdownMenuItem>
                  {isAdmin && (
                    <DropdownMenuItem onClick={() => setStationMatrixOpen(true)}>
                      <LayoutGrid className="h-4 w-4 mr-2 text-violet-500" />
                      Stationen
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setAvailabilityOpen(true)}>
                    <CalendarX2 className="h-4 w-4 mr-2 text-teal-500" />
                    Verfügbarkeit
                  </DropdownMenuItem>
                  {isAdmin && (
                    <DropdownMenuItem onClick={() => setStaffingTargetOpen(true)}>
                      <Target className="h-4 w-4 mr-2 text-rose-500" />
                      Besetzungsziele
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setCopyWeekDialogOpen(true)}>
                    <Copy className="h-4 w-4 mr-2" />
                    Woche kopieren
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleImportClick}>
                    <Upload className="h-4 w-4 mr-2" />
                    Importieren
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setKüchenplanImportOpen(true)}>
                    <FileText className="h-4 w-4 mr-2 text-orange-500" />
                    Küchenplan PDF importieren
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportTemplate}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Export Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPDF}>
                    <FileText className="h-4 w-4 mr-2" />
                    Export PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setWeeklyReportOpen(true)}>
                    <FileBarChart2 className="h-4 w-4 mr-2 text-blue-600" />
                    Wochenreport PDF
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPrintDialogOpen(true)}>
                    <Printer className="h-4 w-4 mr-2" />
                    Drucken
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* ── Row 2: Steuerung (Zeitraum / Bereich / Modus) ─────────────────── */}
          <div className="flex items-center gap-2 py-1.5 flex-wrap">
            <input type="file" ref={fileInputRef} onChange={handleImportFile} accept=".xlsx,.xls" className="hidden" />

            {/* Zeitraum-Typ */}
            <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
              {(['month', 'week', 'day'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setCalendarView(v)}
                  className={cn(
                    "h-7 px-2.5 text-xs font-medium rounded-md transition-colors",
                    calendarView === v
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {v === 'month' ? 'Monat' : v === 'week' ? 'Woche' : 'Tag'}
                </button>
              ))}
            </div>

            {/* Zeitraum-Navigation */}
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                onClick={handlePrevPeriod} disabled={isPrevDisabled}
                title="Vorherige Periode"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold min-w-[140px] text-center select-none">
                {pkqPeriodLabel}
              </span>
              <Button
                variant="ghost" size="icon" className="h-7 w-7"
                onClick={handleNextPeriod} disabled={isNextDisabled}
                title="Nächste Periode"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground"
                onClick={handleNavigateToday}
                title="Zum aktuellen Zeitraum"
              >
                Heute
              </Button>
            </div>

            <div className="w-px h-5 bg-border shrink-0 hidden sm:block" />

            {/* Beschäftigungstyp Quick-Filter */}
            {canSwitchDepartment && (
              <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
                {([
                  { key: null,          label: 'Alle' },
                  { key: 'vollzeit',    label: 'VZ' },
                  { key: 'teilzeit',    label: 'TZ' },
                  { key: 'stundenlohn', label: 'SL' },
                ] as const).map(({ key, label }) => (
                  <button
                    key={String(key)}
                    onClick={() => setEmpTypeFilter(empTypeFilter === key ? null : key)}
                    className={cn(
                      "h-7 px-2 text-xs font-medium rounded-md transition-colors",
                      empTypeFilter === key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    title={
                      key === null        ? 'Alle Mitarbeiter' :
                      key === 'vollzeit'  ? 'Nur Vollzeit' :
                      key === 'teilzeit'  ? 'Nur Teilzeit/Aushilfen' :
                                           'Nur Stundenlohn (ohne Monatslohn)'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div className="w-px h-5 bg-border shrink-0 hidden sm:block" />

            {/* Abteilung */}
            {canSwitchDepartment ? (
              <div className="flex items-center gap-1.5 flex-wrap">
                <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
                  <button
                    onClick={() => setActiveDepartment('all' as Department)}
                    className={cn(
                      "h-7 px-2.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors",
                      activeDepartment === 'all'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Users className="h-3 w-3 shrink-0" />
                    Alle ({employees.length})
                  </button>
                  {([
                    { key: 'service', label: 'Service', dot: 'bg-blue-500' },
                    { key: 'küche',   label: 'Küche',   dot: 'bg-orange-500' },
                  ] as const).map(({ key, label, dot }) => (
                    <button
                      key={key}
                      onClick={() => setActiveDepartment(key as Department)}
                      className={cn(
                        "h-7 px-2.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors",
                        activeDepartment === key
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <span className={cn("w-2 h-2 rounded-full shrink-0", dot)} />
                      {label}
                    </button>
                  ))}
                </div>
                {/* Mitarbeiter Multi-Filter */}
                <Popover open={empFilterOpen} onOpenChange={setEmpFilterOpen}>
                  <PopoverTrigger asChild>
                    <button
                      className={cn(
                        "h-7 pl-2.5 pr-2 text-xs font-medium rounded-md border flex items-center gap-1.5 transition-colors min-w-[130px] max-w-[220px]",
                        selectedEmployeeIds.length > 0
                          ? "bg-primary/10 border-primary/40 text-primary dark:bg-primary/20"
                          : "bg-background hover:bg-muted border-input text-foreground"
                      )}
                    >
                      <Users className="h-3 w-3 shrink-0 opacity-60" />
                      <span className="truncate flex-1 text-left">{empFilterLabel}</span>
                      {selectedEmployeeIds.length > 0 ? (
                        <span
                          role="button"
                          onClick={e => { e.stopPropagation(); setSelectedEmployeeIds([]); }}
                          className="opacity-60 hover:opacity-100 shrink-0"
                          title="Auswahl löschen"
                        >
                          <X className="h-3 w-3" />
                        </span>
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="start" sideOffset={4}>
                    {/* Suchfeld */}
                    <div className="relative mb-2">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                      <Input
                        placeholder="Suchen…"
                        value={empSearchQuery}
                        onChange={e => setEmpSearchQuery(e.target.value)}
                        className="h-7 text-xs pl-6 pr-2"
                      />
                    </div>
                    {/* Schnellaktionen */}
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b">
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => setSelectedEmployeeIds(dropdownEmployeeOptions.map(e => e.id))}
                      >
                        Alle auswählen
                      </button>
                      <span className="text-muted-foreground text-xs">·</span>
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                        onClick={() => { setSelectedEmployeeIds([]); setEmpSearchQuery(''); }}
                      >
                        Auswahl löschen
                      </button>
                      {selectedEmployeeIds.length > 0 && (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {selectedEmployeeIds.length} ausgewählt
                        </span>
                      )}
                    </div>
                    {/* Mitarbeiter-Liste */}
                    <div className="max-h-52 overflow-y-auto space-y-0.5">
                      {filteredDropdownOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-3">Keine Treffer</p>
                      ) : filteredDropdownOptions.map(e => {
                        const checked = selectedEmployeeIds.includes(e.id);
                        return (
                          <label
                            key={e.id}
                            className="flex items-center gap-2 px-1.5 py-1.5 rounded-md hover:bg-muted cursor-pointer text-xs select-none"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={v => {
                                setSelectedEmployeeIds(prev =>
                                  v ? [...prev, e.id] : prev.filter(id => id !== e.id)
                                );
                              }}
                              className="h-3.5 w-3.5 shrink-0"
                            />
                            {activeDepartment === 'all' && (
                              <span className={cn(
                                "w-1.5 h-1.5 rounded-full shrink-0",
                                e.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                              )} />
                            )}
                            <span className="truncate leading-tight">{getEmployeeDisplayName(e)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            ) : (
              <div className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
                isServiceManager && "border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-700",
                isKuecheManager  && "border-orange-300 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-700"
              )}>
                <span className={cn("w-2 h-2 rounded-full", isServiceManager && "bg-blue-500", isKuecheManager && "bg-orange-500")} />
                {isServiceManager ? 'Service' : 'Küche'}
                <Lock className="h-3 w-3 opacity-60" />
              </div>
            )}

            <div className="w-px h-5 bg-border shrink-0 hidden sm:block" />

            {/* Modus (Plan / Ist / Vergleich) */}
            <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
              <button
                onClick={() => setScheduleMode('plan')}
                className={cn(
                  "h-7 px-2.5 text-xs font-medium rounded-md transition-colors",
                  scheduleMode === 'plan'
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >Plan</button>
              <button
                onClick={() => setScheduleMode('ist')}
                className={cn(
                  "h-7 px-2.5 text-xs font-medium rounded-md transition-colors",
                  scheduleMode === 'ist'
                    ? "bg-green-600 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >Ist</button>
              <button
                onClick={() => setScheduleMode('compare')}
                className={cn(
                  "h-7 px-2.5 text-xs font-medium rounded-md transition-colors",
                  scheduleMode === 'compare'
                    ? "bg-purple-600 text-white shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >Vergleich</button>
            </div>

            {/* Kosten-Toggle */}
            {canToggleCostView && (
              <>
                <div className="w-px h-5 bg-border shrink-0 hidden sm:block" />
                <Button
                  variant={showCosts ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 gap-1.5 text-xs px-2.5"
                  onClick={() => {
                    if (showCosts) {
                      setShowCosts(false);
                    } else if (isBeaulieuManager) {
                      setShowCosts(true);
                      setShowFooter(true);
                    } else {
                      setCostPasswordDialogOpen(true);
                    }
                  }}
                  title={showCosts ? 'Kosten ausblenden' : 'Kosten einblenden'}
                >
                  {showCosts ? <Euro className="h-3.5 w-3.5" /> : <Euro className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">Kosten</span>
                </Button>
              </>
            )}
          </div>

        </div>
      </header>

      <main className="max-w-[1800px] mx-auto w-full px-4 pt-2 pb-8">
        <div className="flex gap-3 items-start">

          {/* ══════════════ LEFT SIDEBAR: Legend + Quick stats ══════════════ */}
          <aside className={cn(
            "shrink-0 flex flex-col gap-2 transition-[width] duration-200",
            legendSidebarOpen ? "w-52" : "w-8"
          )}>
            <button
              onClick={() => setLegendSidebarOpen(v => !v)}
              className="flex items-center gap-1.5 px-1.5 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-[11px] w-full"
              title={legendSidebarOpen ? 'Legende einklappen' : 'Legende ausklappen'}
            >
              <PanelLeftClose className={cn("h-4 w-4 shrink-0 transition-transform duration-200", !legendSidebarOpen && "rotate-180")} />
              {legendSidebarOpen && <span className="font-medium truncate">Schichten</span>}
            </button>

            {legendSidebarOpen && (
              <>
                <ShiftLegend
                  onEditClick={() => setShiftConfigDialogOpen(true)}
                  department={activeDepartment === 'all' ? 'all' : activeDepartment as 'service' | 'küche'}
                  activeTool={paintTool}
                  onToolSelect={setPaintTool}
                  mode="sidebar"
                />

                {/* Mini sidebar KPIs */}
                <div className="rounded-lg border bg-card px-3 py-2.5 space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {pkqPeriodLabel}
                  </p>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between items-baseline">
                      <span className="text-muted-foreground">Mitarbeiter</span>
                      <span className="font-bold">{departmentEmployeeCount}</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-muted-foreground">Geplant</span>
                      <span className="font-bold tabular-nums">{departmentPlannedHours.toFixed(1)} h</span>
                    </div>
                    {gesamtCostRatio !== null && (
                      <div className="flex justify-between items-baseline">
                        <span className="text-muted-foreground">PKQ</span>
                        <button
                          onClick={() => setPkDetailOpen(true)}
                          className={cn(
                            "font-black tabular-nums hover:underline cursor-pointer text-sm",
                            gesamtCostRatioStatus === 'good'  && "text-green-600 dark:text-green-400",
                            gesamtCostRatioStatus === 'ok'    && "text-yellow-600 dark:text-yellow-400",
                            gesamtCostRatioStatus === 'high'  && "text-red-600 dark:text-red-400",
                          )}
                        >
                          {gesamtCostRatio.toFixed(1)} %
                        </button>
                      </div>
                    )}
                    <div className="flex justify-between items-baseline">
                      <span className="text-muted-foreground">Ziel</span>
                      <span className="font-semibold tabular-nums">{laborCostThreshold} %</span>
                    </div>
                    {departmentWarningCount > 0 && (
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                          Warnungen
                        </span>
                        <span className="font-bold text-amber-600 dark:text-amber-400">{departmentWarningCount}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Zielwerte */}
                <div className="rounded-lg border bg-card px-3 py-2.5 space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zielwerte</p>
                  <div className="space-y-1.5 text-xs">
                    {activeDepartment !== 'küche' && (
                      <div className="flex justify-between items-baseline">
                        <span className="text-blue-600 dark:text-blue-400 font-medium">Service</span>
                        <span className="tabular-nums font-semibold">{_serviceResolved.targetPercent.toFixed(1)} %</span>
                      </div>
                    )}
                    {activeDepartment !== 'service' && (
                      <div className="flex justify-between items-baseline">
                        <span className="text-orange-600 dark:text-orange-400 font-medium">Küche</span>
                        <span className="tabular-nums font-semibold">{_kücheResolved.targetPercent.toFixed(1)} %</span>
                      </div>
                    )}
                    {activeDepartment === 'all' && (
                      <div className="flex justify-between items-baseline">
                        <span className="text-muted-foreground">Global</span>
                        <span className="tabular-nums font-semibold">{_globalResolved.targetPercent.toFixed(1)} %</span>
                      </div>
                    )}
                    <button
                      onClick={handleOpenZielwertEdit}
                      className="text-[10px] text-muted-foreground/60 hover:text-foreground flex items-center gap-1 pt-0.5"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      bearbeiten
                    </button>
                  </div>
                </div>

                {/* Smart Hinweise */}
                {(patternWarnings.length > 0 || overhoursEmployees.length > 0 || gesamtCostRatioStatus === 'high') && (
                  <div className="rounded-lg border bg-card overflow-hidden">
                    <button
                      onClick={() => setHintsCollapsed(v => !v)}
                      className="flex items-center gap-1.5 w-full px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50 transition-colors"
                    >
                      <Lightbulb className="h-3 w-3 text-amber-500 shrink-0" />
                      <span className="flex-1 text-left">Hinweise</span>
                      {(() => {
                        const total = patternWarnings.filter(w => w.severity === 'critical').length + overhoursEmployees.length + (gesamtCostRatioStatus === 'high' ? 1 : 0);
                        return total > 0 ? <span className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 rounded-full px-1.5 py-0 font-bold">{total}</span> : null;
                      })()}
                      <ChevronDown className={cn("h-3 w-3 transition-transform", hintsCollapsed && "rotate-180")} />
                    </button>
                    {!hintsCollapsed && (
                      <div className="px-2.5 pb-2.5 space-y-1">
                        {/* PKQ over target */}
                        {gesamtCostRatioStatus === 'high' && gesamtCostRatio !== null && (
                          <div className="flex items-start gap-1.5 text-[10px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded px-1.5 py-1">
                            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                            <span>PKQ {gesamtCostRatio.toFixed(1)} % über Ziel ({laborCostThreshold} %)</span>
                          </div>
                        )}
                        {/* Overtime employees */}
                        {overhoursEmployees.slice(0, 3).map(({ employee, difference }) => (
                          <div key={employee.id} className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded px-1.5 py-1">
                            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                            <span className="truncate">{getEmployeeDisplayName(employee)} +{difference.toFixed(1)} h</span>
                          </div>
                        ))}
                        {/* Pattern warnings — show up to 4 */}
                        {patternWarnings.slice(0, 4).map((w, i) => (
                          <div
                            key={i}
                            className={cn(
                              "flex items-start gap-1.5 text-[10px] rounded px-1.5 py-1 cursor-pointer hover:opacity-80",
                              w.severity === 'critical'
                                ? "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30"
                                : "text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30"
                            )}
                            onClick={() => {
                              const d = new Date(w.firstDate);
                              handleJumpToDay(d, w.empId);
                            }}
                            title={w.detail}
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                            <span className="leading-tight">{w.empName}: {w.message}</span>
                          </div>
                        ))}
                        {patternWarnings.length > 4 && (
                          <p className="text-[10px] text-muted-foreground text-center py-0.5">
                            +{patternWarnings.length - 4} weitere Warnungen
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </aside>

          {/* ══════════════ MAIN CONTENT ══════════════ */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">

            {/* ── Compact KPI Strip ───────────────────────────────────── */}
            <div className={cn(
              "shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-xl border-2",
              gesamtCostRatioStatus === 'good'    && "border-green-400/60 bg-green-50/60 dark:bg-green-950/20",
              gesamtCostRatioStatus === 'ok'      && "border-yellow-400/60 bg-yellow-50/60 dark:bg-yellow-950/20",
              gesamtCostRatioStatus === 'high'    && "border-red-400/60 bg-red-50/60 dark:bg-red-950/20",
              gesamtCostRatioStatus === 'unknown' && "border-border bg-muted/30"
            )}>
              <span className="text-[11px] font-semibold text-muted-foreground shrink-0">{pkqPeriodLabel}</span>
              <div className="w-px h-4 bg-border/60 shrink-0" />

              {/* PKQ */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPkDetailOpen(true)}
                  className={cn(
                    "text-xl font-black tabular-nums leading-none hover:underline underline-offset-2 cursor-pointer",
                    gesamtCostRatioStatus === 'good'    && "text-green-700 dark:text-green-400",
                    gesamtCostRatioStatus === 'ok'      && "text-yellow-600 dark:text-yellow-400",
                    gesamtCostRatioStatus === 'high'    && "text-red-700 dark:text-red-400",
                    gesamtCostRatioStatus === 'unknown' && "text-muted-foreground"
                  )}
                  title="PKQ Details anzeigen"
                >
                  {gesamtCostRatio !== null ? `${gesamtCostRatio.toFixed(1)} %` : '– %'}
                </button>
                <span className="text-[10px] text-muted-foreground leading-tight">PKQ<br />Ziel {laborCostThreshold} %</span>
              </div>
              <div className="w-px h-4 bg-border/60 shrink-0" />

              {/* PK Kosten */}
              <div className="flex items-baseline gap-1 text-sm">
                <span className="font-bold tabular-nums">
                  {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(gesamtActiveLaborCost)}
                </span>
                <span className="text-[10px] text-muted-foreground">PK</span>
              </div>

              {/* Revenue */}
              {activeRevenue > 0 && (
                <>
                  <div className="w-px h-4 bg-border/60 shrink-0" />
                  <div className="flex items-baseline gap-1 text-sm">
                    <span className="font-bold tabular-nums">
                      {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(activeRevenue)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{scheduleMode === 'ist' ? 'Ist-Umsatz' : 'Budget'}</span>
                  </div>
                </>
              )}
              <div className="w-px h-4 bg-border/60 shrink-0" />

              {/* Hours */}
              <div className="flex items-baseline gap-1 text-sm">
                <span className="font-bold tabular-nums">{departmentPlannedHours.toFixed(1)} h</span>
                <span className="text-[10px] text-muted-foreground">geplant</span>
              </div>

              {/* MA Count */}
              <div className="flex items-center gap-1 text-sm">
                <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-bold tabular-nums">{departmentEmployeeCount}</span>
                <span className="text-[10px] text-muted-foreground">MA</span>
              </div>

              {/* Im Ziel */}
              {departmentOkCount > 0 && (
                <>
                  <div className="w-px h-4 bg-border/60 shrink-0 hidden sm:block" />
                  <div className="hidden sm:flex items-center gap-1 text-sm">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span className="font-bold tabular-nums text-green-600 dark:text-green-400">{departmentOkCount}</span>
                    <span className="text-[10px] text-muted-foreground">im Ziel</span>
                  </div>
                </>
              )}

              {/* Warnings */}
              {departmentWarningCount > 0 && (
                <>
                  <div className="w-px h-4 bg-border/60 shrink-0" />
                  <div className="flex items-center gap-1 text-sm">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                    <span className="font-bold tabular-nums text-amber-600 dark:text-amber-400">{departmentWarningCount}</span>
                    <span className="text-[10px] text-muted-foreground">Warn.</span>
                  </div>
                </>
              )}
            </div>

        {/* Schedule Grid with Plan/Ist Tabs */}
        <Card className="flex flex-col">
          <CardHeader className="pb-2 shrink-0">
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
                {activeDepartment === 'all' ? (
                  <div className="flex gap-1">
                    <AddAushilfeDialog department="service" onAdd={handleAddAushilfe} />
                    <AddAushilfeDialog department="küche" onAdd={handleAddAushilfe} />
                  </div>
                ) : (
                  <AddAushilfeDialog department={activeDepartment} onAdd={handleAddAushilfe} />
                )}
              </div>
              
              <div className="flex items-center gap-2">
                {/* Sortierungsmodus-Toggle — nur im Plan-Modus */}
                {scheduleMode === 'plan' && (
                  <Button
                    variant={sortModeActive ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSortModeActive(v => !v)}
                    className="h-7 gap-1"
                    title={sortModeActive ? 'Sortierungsmodus beenden' : 'Reihenfolge der Mitarbeiter anpassen'}
                  >
                    <ArrowUpDown className="h-3 w-3" />
                    <span className="hidden sm:inline text-xs">Sortierung</span>
                  </Button>
                )}
                {/* Footer-Toggle */}
                <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                  <Button
                    variant={showFooter ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setShowFooter(!showFooter)}
                    className="h-7 gap-1"
                    title={showFooter ? 'Tages-Summe ausblenden' : 'Tages-Summe einblenden'}
                  >
                    {showFooter ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    <span className="hidden sm:inline text-xs">Σ</span>
                  </Button>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {/* Beaulieu: Keine Mitarbeitenden importiert */}
            {tenantId === 'beaulieu' && employees.length === 0 && !dataLoading && (
              <div className="flex flex-col items-center justify-center py-20 gap-4 text-center px-8">
                <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center">
                  <Users className="h-8 w-8 text-violet-500" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground mb-1">Keine Beaulieu-Mitarbeitenden gefunden</h3>
                  <p className="text-sm text-muted-foreground max-w-sm">
                    Die echten Beaulieu-Mitarbeitenden sind noch nicht in Supabase importiert. Bitte zuerst die Mitarbeiterliste importieren.
                  </p>
                </div>
                <a href="/import-hub" className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors">
                  Zum Import-Hub → Beaulieu Mitarbeiter
                </a>
              </div>
            )}
            {/* ── Warnung: Schichtdaten fehlen nach dem Laden ──────────────── */}
            {scheduleSource !== 'loading' && loadedEntryCount === 0 && filteredEmployees.length > 0 && !dataLoading && (
              <div className="mx-6 mt-4 mb-2 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-amber-800 dark:text-amber-300">
                    Keine Schichtdaten für {format(currentMonth, 'MMMM yyyy', { locale: de })} geladen
                  </p>
                  <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                    Supabase hat 0 Einträge zurückgegeben (Quelle: {scheduleSource}). Mögliche Ursachen: Datenverlust durch früheren Speicher-Fehler, oder ein temporäres Auth-Problem.
                    Bitte <strong>«Erneut laden»</strong> versuchen – falls Daten weiterhin fehlen, im Supabase Dashboard prüfen.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100"
                  onClick={() => loadMonthData()}
                >
                  Erneut laden
                </Button>
              </div>
            )}
            <div ref={scheduleGridRef} className="overflow-x-auto px-6 pb-4">
              {calendarView === 'day' && displayDays[0] ? (
                // ── Mobile Tagesansicht ────────────────────────────────────
                <MobileDayView
                  employees={filteredEmployees}
                  day={displayDays[0]}
                  scheduleData={scheduleData}
                  actualHoursData={actualHoursData}
                  scheduleMode={scheduleMode}
                  onSlotChange={handleSlotChange}
                  onHoursChange={handleActualHoursChange}
                  getEmployeeHours={calculateEmployeeHours}
                  getEmployeeActualHours={calculateEmployeeActualHours}
                  getTargetHours={getMonthlyTargetHours}
                  showCosts={effectiveShowCosts}
                />
              ) : scheduleMode === 'compare' ? (
                // ── Plan/Ist-Vergleich ─────────────────────────────────────
                <>
                  <PlanVsIstGrid
                    employees={filteredEmployees}
                    days={displayDays}
                    scheduleData={scheduleData}
                    actualHoursData={actualHoursData}
                  />
                  <PlanVsIstTable
                    employees={filteredEmployees}
                    days={displayDays}
                    scheduleData={scheduleData}
                    actualHoursData={actualHoursData}
                    laborCostThreshold={gridLaborCostThreshold}
                    activeDepartment={activeDepartment === 'service' || activeDepartment === 'küche' ? activeDepartment : 'all'}
                  />
                </>
              ) : scheduleMode === 'plan' ? (
                // Plan-Dienstplan (existing schedule grid)
                <>
                  {calendarView === 'week' && activeDepartment === 'all' && (
                      <div className="space-y-1 mb-3">
                        <StaffingStatusBar
                          targets={staffingTargets}
                          employees={employees}
                          scheduleData={scheduleData}
                          displayDays={displayDays}
                          department="service"
                        />
                        <StaffingStatusBar
                          targets={staffingTargets}
                          employees={employees}
                          scheduleData={scheduleData}
                          displayDays={displayDays}
                          department="küche"
                        />
                      </div>
                    )}
                    {calendarView === 'week' && activeDepartment !== 'all' && (
                      <StaffingStatusBar
                        targets={staffingTargets}
                        employees={employees}
                        scheduleData={scheduleData}
                        displayDays={displayDays}
                        department={activeDepartment as 'service' | 'küche'}
                      />
                    )}
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
                      showCosts={effectiveShowCosts}
                      dailyBudgets={dailyBudgets}
                      laborCostThreshold={gridLaborCostThreshold}
                      scheduleMode={scheduleMode}
                      externalActiveTool={paintTool}
                      onExternalToolChange={setPaintTool}
                      highlightedEmployeeId={highlightedEmpId}
                      patternWarnings={patternWarnings}
                      copiedShift={copiedShift}
                      onCopyShift={handleCopyShift}
                      onMoveEmployee={
                        sortModeActive && activeDepartment !== 'all'
                          ? (id, dir) => handleMoveEmployee(id, activeDepartment as 'service' | 'küche', dir)
                          : undefined
                      }
                      cellColors={cellColors}
                      onCellColorChange={handleCellColorChange}
                      showDepartmentBadge={activeDepartment === 'all'}
                      onCopyToIst={handleCopyPlanToIst}
                    />
                </>
              ) : (
                // Ist-Dienstplan (actual hours grid)
                <>
                  <div className="mb-3 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                    <p className="text-sm text-green-700 dark:text-green-400">
                      <Clock className="h-4 w-4 inline mr-1" />
                      <strong>Ist-Stunden:</strong> Klicke auf eine Zelle um Ist-Stunden zu erfassen, oder importiere den Mirus «Tägliche Stunden» Export direkt.
                    </p>
                    <ActualHoursImportButton
                      onImport={handleImportMirusActualHours}
                      employees={employees}
                      existingTimeEntries={[]}
                    />
                  </div>

                  <ActualHoursGrid
                    employees={filteredEmployees}
                    days={displayDays}
                    actualHoursData={actualHoursData}
                    onHoursChange={handleActualHoursChange}
                    getEmployeeActualHours={calculateEmployeeActualHours}
                    getTargetHours={getMonthlyTargetHours}
                    showCosts={effectiveShowCosts}
                    dailyBudgets={dailyBudgets}
                    laborCostThreshold={gridLaborCostThreshold}
                    onDayClick={handleIstDayClick}
                  />
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ════════════════════════════════════════════════════════════
            FEATURE 3 – SOLL / IST VERGLEICH (unter der Dienstplan-Tabelle)
            ════════════════════════════════════════════════════════════ */}
        <Card className="border-2 border-blue-200 dark:border-blue-800">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Clock className="h-5 w-5 text-blue-600" />
                Soll / Ist – Vergleich
                <span className="text-sm font-normal text-muted-foreground ml-1">
                  {format(currentMonth, 'MMMM yyyy', { locale: de })}
                </span>
                {!hasActualHours && (
                  <span className="ml-auto text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full border border-blue-200 dark:border-blue-700">
                    Keine Ist-Stunden eingetragen
                  </span>
                )}
              </CardTitle>
              {/* Pro-Rata Eingabe */}
              <div className="flex items-center gap-2 shrink-0">
                <label className="text-xs text-muted-foreground whitespace-nowrap">Soll pro-rata bis Tag:</label>
                <input
                  type="number"
                  min="1"
                  max={daysInMonth.length}
                  value={proRataDay}
                  onChange={e => setProRataDay(e.target.value)}
                  placeholder={`1–${daysInMonth.length}`}
                  className="w-16 h-7 rounded border border-input bg-background px-2 text-xs text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {proRataDay !== '' && (
                  <button
                    onClick={() => setProRataDay('')}
                    className="text-xs text-muted-foreground hover:text-foreground px-1"
                    title="Zurücksetzen"
                  >✕</button>
                )}
                {proRataDay !== '' && (
                  <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                    ×{(Math.min(Number(proRataDay), daysInMonth.length) / daysInMonth.length).toFixed(2)}
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {/* Pro-Rata computed values */}
            {(() => {
              const day = proRataDay !== '' ? Math.max(1, Math.min(Number(proRataDay), daysInMonth.length)) : null;
              const factor = day !== null ? day / daysInMonth.length : 1;
              const sollH   = totalPlannedHoursAll * factor;
              const sollPK  = totalPlannedLaborCost * factor;
              const sollRev = totalPlannedRevenue   * factor;
              const sollPct = sollRev > 0 ? (sollPK / sollRev) * 100 : null;
              const CHF = new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });
              return (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {/* Stunden */}
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">⏱ Stunden</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">
                      Soll{day !== null && <span className="ml-1 text-blue-500 text-[10px]">(bis {day}.)</span>}
                    </span>
                    <span className="text-base font-bold tabular-nums">{sollH.toFixed(1)} h</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">Ist</span>
                    <span className="text-base font-bold tabular-nums">
                      {hasActualHours ? `${totalActualHoursAll.toFixed(1)} h` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Differenz</span>
                    {(() => {
                      const diff = totalActualHoursAll - sollH;
                      return (
                        <span className={cn(
                          "text-base font-bold tabular-nums",
                          !hasActualHours ? "text-muted-foreground" :
                          diff > 0 ? "text-red-600" :
                          diff < 0 ? "text-green-600" : "text-muted-foreground"
                        )}>
                          {hasActualHours ? (diff >= 0 ? `+${diff.toFixed(1)} h` : `${diff.toFixed(1)} h`) : '–'}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Variable Arbeitskosten */}
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">💼 Variable Arbeitskosten</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">
                      Soll{day !== null && <span className="ml-1 text-blue-500 text-[10px]">(bis {day}.)</span>}
                    </span>
                    <span className="text-base font-bold tabular-nums">
                      {CHF.format(sollPK)}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">Ist (gesch.)</span>
                    <span className="text-base font-bold tabular-nums">
                      {hasActualHours ? CHF.format(totalActualLaborCost) : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Differenz</span>
                    {(() => {
                      const diff = totalActualLaborCost - sollPK;
                      return (
                        <span className={cn(
                          "text-base font-bold tabular-nums",
                          !hasActualHours ? "text-muted-foreground" :
                          diff > 0 ? "text-red-600" : "text-green-600"
                        )}>
                          {hasActualHours
                            ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0, signDisplay: 'always' }).format(diff)
                            : '–'}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Ferienabbau CHF */}
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">🏖 Ferienabbau</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-sm text-muted-foreground shrink-0">
                      Soll{day !== null && <span className="ml-1 text-blue-500 text-[10px]">(bis {day}.)</span>}
                    </span>
                    <div className="text-right">
                      {ferienSollTage > 0 ? (
                        <>
                          <div className="text-xs text-muted-foreground">{ferienSollTage} T</div>
                          <div className="text-base font-bold tabular-nums text-blue-600">{CHF.format(ferienSollCHF)}</div>
                        </>
                      ) : <span className="text-base font-bold tabular-nums text-muted-foreground">–</span>}
                    </div>
                  </div>
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-sm text-muted-foreground shrink-0">Ist</span>
                    <div className="text-right">
                      {ferienIstTage > 0 ? (
                        <>
                          <div className="text-xs text-muted-foreground">{ferienIstTage} T</div>
                          <div className="text-base font-bold tabular-nums text-blue-600">{CHF.format(ferienabbauCHF)}</div>
                        </>
                      ) : <span className="text-base font-bold tabular-nums text-muted-foreground">–</span>}
                    </div>
                  </div>
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Differenz</span>
                    {(() => {
                      const diff = ferienabbauCHF - ferienSollCHF;
                      const hasBoth = ferienSollTage > 0 || ferienIstTage > 0;
                      return (
                        <span className={cn(
                          "text-base font-bold tabular-nums",
                          !hasBoth ? "text-muted-foreground" :
                          diff > 0 ? "text-green-600" : diff < 0 ? "text-yellow-600" : "text-muted-foreground"
                        )}>
                          {hasBoth
                            ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0, signDisplay: 'always' }).format(diff)
                            : '–'}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Umsatz */}
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">📈 Umsatz</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">
                      Soll{day !== null && <span className="ml-1 text-blue-500 text-[10px]">(bis {day}.)</span>}
                    </span>
                    <span className="text-base font-bold tabular-nums">
                      {sollRev > 0 ? CHF.format(sollRev) : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">Ist</span>
                    <span className="text-base font-bold tabular-nums">
                      {hasActualRevenue ? CHF.format(totalActualRevenue) : '–'}
                    </span>
                  </div>
                </div>
                {!totalPlannedRevenue && !hasActualRevenue && (
                  <p className="text-xs text-muted-foreground mt-3 italic">In Hauptübersicht eintragen</p>
                )}
              </div>

              {/* Kostenquote */}
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">% Kostenquote</p>
                <div className="space-y-2">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">
                      Soll{day !== null && <span className="ml-1 text-blue-500 text-[10px]">(bis {day}.)</span>}
                    </span>
                    <span className="text-base font-bold tabular-nums">
                      {sollPct !== null ? `${sollPct.toFixed(1)} %` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm text-muted-foreground">Ist</span>
                    <span className={cn(
                      "text-base font-bold tabular-nums",
                      actualCostRatio === null                                  ? "text-muted-foreground" :
                      actualCostRatio <= effectiveLaborCostThreshold            ? "text-green-600" :
                      actualCostRatio <= effectiveLaborCostThreshold + 5        ? "text-yellow-600" : "text-red-600"
                    )}>
                      {actualCostRatio !== null ? `${actualCostRatio.toFixed(1)} %` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Ziel</span>
                    <span className="text-base font-bold tabular-nums">{effectiveLaborCostThreshold} %</span>
                  </div>
                </div>
              </div>
            </div>
              );
            })()}
            {!hasActualHours && (
              <p className="text-sm text-muted-foreground mt-4 text-center">
                Wechseln Sie oben auf den Tab <strong>„Ist"</strong> und klicken Sie auf eine Zelle, um tatsächlich geleistete Stunden einzutragen.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Überstunden-Warnungen (nach Soll/Ist Vergleich) */}
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

        {varHoursExceeded.length > 0 && (
          <Card className="border-orange-400/50 bg-orange-50/50 dark:bg-orange-950/20 dark:border-orange-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Geschätzte Stunden überschritten — Variable Mitarbeiter ({varHoursExceeded.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="text-xs text-orange-600 dark:text-orange-400 mb-2">
                Die geplanten Stunden übersteigen die in Personal FIX eingetragene Schätzung.
              </p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {varHoursExceeded.map(({ emp, planned, estimated }) => (
                  <div key={emp.id} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate">{emp.name}</span>
                    <span className="text-orange-700 dark:text-orange-300 font-medium shrink-0 ml-2">
                      +{(planned - estimated).toFixed(1)}h geplant ({planned.toFixed(1)}h / {estimated.toFixed(1)}h gesch.)
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── PKQ Detail Dialog ─────────────────────────────────────────── */}
        <Dialog open={pkDetailOpen} onOpenChange={setPkDetailOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className={cn(
                  "inline-flex w-7 h-7 rounded-full items-center justify-center text-white text-sm font-black shrink-0",
                  gesamtCostRatioStatus === 'good'    && "bg-green-500",
                  gesamtCostRatioStatus === 'ok'      && "bg-yellow-400",
                  gesamtCostRatioStatus === 'high'    && "bg-red-500",
                  gesamtCostRatioStatus === 'unknown' && "bg-slate-400"
                )}>
                  {gesamtCostRatioStatus === 'good' ? '✓' : gesamtCostRatioStatus === 'ok' ? '!' : gesamtCostRatioStatus === 'high' ? '✗' : '?'}
                </span>
                Personalquote Gesamt – Details
              </DialogTitle>
              <DialogDescription>
                {pkqPeriodLabel} · Zielquote Gesamt: {laborCostThreshold}%
                {gesamtCostRatio !== null && ` · Aktuell: ${gesamtCostRatio.toFixed(1)}%`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">
              {/* Summary row */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1">PK Gesamt (Küche + Service)</p>
                  <p className="text-lg font-bold tabular-nums">
                    {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(gesamtActiveLaborCost)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1">{scheduleMode === 'ist' ? 'Ist-Umsatz' : 'Budget'}</p>
                  <p className="text-lg font-bold tabular-nums">
                    {activeRevenue > 0
                      ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(activeRevenue)
                      : '–'}
                  </p>
                </div>
                <div className={cn("rounded-lg border p-3",
                  gesamtCostRatioStatus === 'good'    && "border-green-400 bg-green-50 dark:bg-green-950/30",
                  gesamtCostRatioStatus === 'ok'      && "border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30",
                  gesamtCostRatioStatus === 'high'    && "border-red-400 bg-red-50 dark:bg-red-950/30",
                )}>
                  <p className="text-xs text-muted-foreground mb-1">Gesamt-PKQ</p>
                  <p className={cn("text-lg font-black tabular-nums",
                    gesamtCostRatioStatus === 'good'    && "text-green-700 dark:text-green-400",
                    gesamtCostRatioStatus === 'ok'      && "text-yellow-600 dark:text-yellow-400",
                    gesamtCostRatioStatus === 'high'    && "text-red-700 dark:text-red-400",
                  )}>
                    {gesamtCostRatio !== null ? `${gesamtCostRatio.toFixed(1)} %` : '–'}
                  </p>
                </div>
              </div>

              {/* Cost delta if over target */}
              {gesamtCostRatio !== null && activeRevenue > 0 && gesamtCostRatio > laborCostThreshold && (
                <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400">Mehrkosten gegenüber Ziel ({laborCostThreshold}%)</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Bei Ziel wären PK Gesamt: {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(activeRevenue * laborCostThreshold / 100)}
                    </p>
                  </div>
                  <p className="text-2xl font-black text-red-700 dark:text-red-400 tabular-nums">
                    + {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(
                      gesamtActiveLaborCost - (activeRevenue * laborCostThreshold / 100)
                    )}
                  </p>
                </div>
              )}

              {/* Per-employee breakdown */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Aufschlüsselung pro Mitarbeiter</p>
                <div className="rounded-lg border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-xs">Mitarbeiter</th>
                        <th className="text-right px-3 py-2 font-semibold text-xs">Soll-Std.</th>
                        <th className="text-right px-3 py-2 font-semibold text-xs">Ist-Std.</th>
                        <th className="text-right px-3 py-2 font-semibold text-xs">Δ Std.</th>
                        <th className="text-right px-3 py-2 font-semibold text-xs">Kosten (Soll)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEmployees.map((emp) => {
                        const empPlannedH = calculateEmployeeHours(emp.id);
                        const empActualH = daysInMonth.reduce((sum, d) => {
                          const key = `${emp.id}-${format(d, 'yyyy-MM-dd')}`;
                          return sum + (actualHoursData[key]?.hours ?? 0);
                        }, 0);
                        const diffH = empActualH - empPlannedH;
                        const hrRate = emp.hourlyWage ?? 0;
                        const plannedCost = empPlannedH * hrRate;
                        if (empPlannedH === 0 && empActualH === 0) return null;
                        return (
                          <tr key={emp.id} className="border-t hover:bg-muted/30">
                            <td className="px-3 py-2 font-medium">{emp.name}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{empPlannedH.toFixed(1)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{empActualH > 0 ? empActualH.toFixed(1) : '–'}</td>
                            <td className={cn("px-3 py-2 text-right tabular-nums font-semibold",
                              empActualH === 0 ? "text-muted-foreground" :
                              diffH > 0 ? "text-red-600" : diffH < 0 ? "text-green-600" : "text-muted-foreground"
                            )}>
                              {empActualH > 0 ? (diffH >= 0 ? `+${diffH.toFixed(1)}` : diffH.toFixed(1)) : '–'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {hrRate > 0
                                ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(plannedCost)
                                : '–'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-muted/50 font-semibold border-t">
                      <tr>
                        <td className="px-3 py-2 text-xs font-bold uppercase">Total</td>
                        <td className="px-3 py-2 text-right tabular-nums">{totalPlannedHoursAll.toFixed(1)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{hasActualHours ? totalActualHoursAll.toFixed(1) : '–'}</td>
                        <td className={cn("px-3 py-2 text-right tabular-nums",
                          !hasActualHours ? "text-muted-foreground" :
                          (totalActualHoursAll - totalPlannedHoursAll) > 0 ? "text-red-600" : "text-green-600"
                        )}>
                          {hasActualHours
                            ? ((totalActualHoursAll - totalPlannedHoursAll) >= 0 ? `+${(totalActualHoursAll - totalPlannedHoursAll).toFixed(1)}` : (totalActualHoursAll - totalPlannedHoursAll).toFixed(1))
                            : '–'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(totalPlannedLaborCost)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Overtime employees */}
              {overhoursEmployees.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Mitarbeiter mit Überstunden</p>
                  <div className="space-y-1.5">
                    {overhoursEmployees.map(({ employee, difference }) => (
                      <div key={employee.id} className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 px-3 py-2">
                        <span className="text-sm font-medium">{employee.name}</span>
                        <span className="text-sm font-bold text-red-600 dark:text-red-400 tabular-nums">+{difference.toFixed(1)} h</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Monthly Cost Summary - only shows when costs are enabled */}
        <MonthlyCostSummary
          employees={visibleEmployees}
          scheduleData={scheduleData}
          dailyBudgets={dailyBudgets}
          currentMonth={currentMonth}
          showCosts={effectiveShowCosts}
        />

        {/* Labor Cost Comparison Charts */}
        <LaborCostComparison
          employees={visibleEmployees}
          scheduleData={scheduleData}
          dailyBudgets={dailyBudgets}
          currentMonth={currentMonth}
          showCosts={effectiveShowCosts}
        />

        {/* Employee Hours Summary */}
        <EmployeeHoursSummary
          summaries={departmentSummaries}
          varEstimatedHours={varEstimatedHours}
          actualHoursPerEmp={Object.fromEntries(
            employees.map(emp => [
              emp.id,
              Object.entries(actualHoursData)
                .filter(([k]) => monthDateSet.has(k.slice(-10)) && k.startsWith(`${emp.id}-`))
                .reduce((s, [, e]) => s + e.hours, 0),
            ])
          )}
        />

        {/* Employees List - Password Protected for hourly wages */}
        {effectiveShowCosts && (
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
          </div>{/* end flex-1 content */}
        </div>{/* end flex gap-3 */}
      </main>

      {/* Copy Week Dialog */}
      <CopyWeekDialog
        open={copyWeekDialogOpen}
        onOpenChange={setCopyWeekDialogOpen}
        currentMonth={currentMonth}
        currentWeekStart={weeksInMonth[selectedWeekIndex] ?? weeksInMonth[0]}
        scheduleData={scheduleData}
        employeeIds={filteredEmployees.map(e => e.id)}
        tenantKey={tenantKey}
        onCopy={(newScheduleData) => {
          setScheduleData(newScheduleData);
          saveFullScheduleForMonth(currentMonth, newScheduleData);
          const monthKey = format(currentMonth, 'yyyy-MM');
          localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(newScheduleData));
          toast.success('Woche erfolgreich kopiert und gespeichert!');
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
        cellColors={cellColors}
      />

      {/* Day Detail Dialog (Plan view) */}
      <DayDetailDialog
        open={dayDetailDialogOpen}
        onOpenChange={setDayDetailDialogOpen}
        date={selectedDay}
        employees={employees}
        scheduleData={scheduleData}
        plannedRevenue={selectedDay ? dailyBudgets[format(selectedDay, 'yyyy-MM-dd')]?.plannedRevenue : undefined}
        isOverride={selectedDay ? !!dailyBudgets[format(selectedDay, 'yyyy-MM-dd')]?.isOverride : false}
        onUpdatePlannedRevenue={handleUpdatePlannedRevenue}
        laborCostThreshold={gridLaborCostThreshold}
        actualHoursData={actualHoursData}
        actualRevenue={selectedDay ? dailyBudgets[format(selectedDay, 'yyyy-MM-dd')]?.actualRevenue : undefined}
        activeDepartment={activeDepartment === 'service' || activeDepartment === 'küche' ? activeDepartment : 'all'}
      />

      {/* IST Day Detail Dialog */}
      <IstDayDetailDialog
        open={istDayDetailDialogOpen}
        onOpenChange={setIstDayDetailDialogOpen}
        date={selectedIstDay}
        employees={employees}
        actualHoursData={actualHoursData}
        actualRevenue={selectedIstDay ? dailyBudgets[format(selectedIstDay, 'yyyy-MM-dd')]?.actualRevenue : undefined}
        plannedRevenue={selectedIstDay ? dailyBudgets[format(selectedIstDay, 'yyyy-MM-dd')]?.plannedRevenue : undefined}
        laborCostThreshold={laborCostThreshold}
        scheduleData={scheduleData}
        activeDepartment={activeDepartment === 'service' || activeDepartment === 'küche' ? activeDepartment : 'all'}
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
        initialFormat={exportInitialFormat}
      />

      <ImportMatchPreviewDialog
        open={importPreviewOpen}
        onOpenChange={setImportPreviewOpen}
        nameMatches={pendingImportResult?.nameMatches || []}
        existingEmployees={employees}
        onConfirm={handleConfirmImport}
        onCancel={handleCancelImport}
      />


      <PlanningAssistant
        open={planningAssistantOpen}
        onClose={() => setPlanningAssistantOpen(false)}
        employees={employees}
        scheduleData={scheduleData}
        actualHoursData={actualHoursData}
        displayDays={displayDays}
        allMonthDays={daysInMonth}
        personnelBudget={personnelBudget}
        totalFixCost={paFixCost}
        staffingTargets={staffingTargets}
        onJumpToDay={handleJumpToDay}
        onRemoveShift={handleRemoveShiftFromAssistant}
        patternWarnings={patternWarnings}
      />

      <BulkActionsDialog
        open={bulkActionsOpen}
        onClose={() => setBulkActionsOpen(false)}
        employees={employees}
        scheduleData={scheduleData}
        actualHoursData={actualHoursData}
        currentMonth={currentMonth}
        onApply={handleApplyTemplate}
        onApplyActual={handleBulkApplyActual}
      />

      <TimeSlotStaffingDialog
        open={timeSlotStaffingOpen}
        onClose={() => setTimeSlotStaffingOpen(false)}
        employees={employees}
        actualHoursData={actualHoursData}
        scheduleData={scheduleData}
        currentMonth={currentMonth}
        daysInMonth={daysInMonth}
      />

      <TemplateManagerDialog
        open={templateDialogOpen}
        onClose={() => setTemplateDialogOpen(false)}
        employees={employees}
        scheduleData={scheduleData}
        displayDays={displayDays}
        activeDepartment={'all' as TemplateDept}
        onApply={handleApplyTemplate}
      />

      <StaffingTargetDialog
        open={staffingTargetOpen}
        onClose={() => {
          setStaffingTargetOpen(false);
          // Refresh targets so the status bars update immediately
          setStaffingTargets(loadStaffingTargets());
        }}
      />

      <StationMatrixDialog
        open={stationMatrixOpen}
        onClose={() => setStationMatrixOpen(false)}
        employees={employees}
        onEmployeeUpdated={handleStationEmployeeUpdated}
      />

      <AvailabilityDialog
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        employees={employees}
        initialMonth={currentMonth}
      />

      <KüchenplanImportDialog
        open={küchenplanImportOpen}
        onClose={() => setKüchenplanImportOpen(false)}
        employees={employees}
        scheduleData={scheduleData}
        onImport={handleKüchenplanImport}
      />

      {/* ── Zielwerte bearbeiten Dialog ──────────────────────────────────── */}
      <Dialog open={zielwertEditOpen} onOpenChange={setZielwertEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              Zielwerte bearbeiten
            </DialogTitle>
            <DialogDescription>
              Personalkosten-Zielquoten für {format(currentMonth, 'MMMM yyyy', { locale: de })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Service */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 w-20 shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shrink-0" />
                <label className="text-sm font-medium">Service</label>
              </div>
              <div className="flex items-center gap-1.5 flex-1">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={zielwertDraft.service}
                  onChange={e => updateZielwertDraft('service', e.target.value)}
                  className="h-8 text-sm"
                />
                <span className="text-sm text-muted-foreground w-4">%</span>
              </div>
            </div>

            {/* Küche */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 w-20 shrink-0">
                <span className="w-2.5 h-2.5 rounded-full bg-orange-500 shrink-0" />
                <label className="text-sm font-medium">Küche</label>
              </div>
              <div className="flex items-center gap-1.5 flex-1">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={zielwertDraft.küche}
                  onChange={e => updateZielwertDraft('küche', e.target.value)}
                  className="h-8 text-sm"
                />
                <span className="text-sm text-muted-foreground w-4">%</span>
              </div>
            </div>

            <div className="border-t pt-3 space-y-3">
              {/* Auto-Global-Checkbox */}
              <div className="flex items-center gap-2">
                <Checkbox
                  id="zw-auto-global"
                  checked={zielwertDraft.autoGlobal}
                  onCheckedChange={v => {
                    const isAuto = !!v;
                    setZielwertDraft(prev => {
                      const svc = parseFloat(prev.service) || 0;
                      const kue = parseFloat(prev.küche)   || 0;
                      return { ...prev, autoGlobal: isAuto, global: isAuto ? (svc + kue).toFixed(1) : prev.global };
                    });
                  }}
                  className="h-3.5 w-3.5"
                />
                <label htmlFor="zw-auto-global" className="text-xs text-muted-foreground cursor-pointer select-none">
                  Global automatisch = Service + Küche
                </label>
              </div>

              {/* Global */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-20 shrink-0">
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-400 shrink-0" />
                  <label className={cn("text-sm font-medium", zielwertDraft.autoGlobal && "text-muted-foreground")}>Global</label>
                </div>
                <div className="flex items-center gap-1.5 flex-1">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={zielwertDraft.global}
                    onChange={e => updateZielwertDraft('global', e.target.value)}
                    disabled={zielwertDraft.autoGlobal}
                    className={cn("h-8 text-sm", zielwertDraft.autoGlobal && "text-muted-foreground")}
                  />
                  <span className="text-sm text-muted-foreground w-4">%</span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Die globale Zielquote gilt für KPI-Karten und Gesamtbewertung (Küche + Service zusammen).
                Abteilungs-Zielquoten steuern die farbige Markierung pro Abteilung.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setZielwertEditOpen(false)}>Abbrechen</Button>
            <Button onClick={handleSaveZielwerte}>Speichern</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Wochenreport PDF Dialog ─────────────────────────────────────── */}
      <WeeklyReportDialog
        open={weeklyReportOpen}
        onOpenChange={setWeeklyReportOpen}
        employees={activeEmployees}
        scheduleData={scheduleData}
        actualHoursData={actualHoursData}
        dailyBudgets={dailyBudgets}
        restaurantName={tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv'}
      />
    </div>
  );
};

export default SchedulePlanner;
