import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTenant } from '@/contexts/TenantContext';
// defaultEmployeesBeaulieu wurde entfernt – auto-seed ist dauerhaft deaktiviert.
// Mitarbeiter werden ausschliesslich über den Personalstamm erfasst.
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import {
  loadEmployees,
  upsertEmployee,
  // upsertAllEmployees: BLOCKIERT — employees werden ausschliesslich via Personalstamm geschrieben
  archiveEmployee as dbArchiveEmployee,
  loadScheduleForMonth,
  saveScheduleEntry,
  saveFullScheduleForMonth,
  loadActualHoursForMonth,
  saveActualHourEntry,
  // seedBeaulieuEmployees: DAUERHAFT DEAKTIVIERT — kein auto-seed in Produktion
  runBeaulieuMatchTest,
  insertScheduleChangeLogs,
  insertSchedulePublicationSnapshot,
  type ScheduleChangeLogEntry,
} from '@/lib/supabase-db';
import {
  ScheduleSaveQueue, planSaveKey, istSaveKey, parseSaveKey,
  type SaveQueueSnapshot,
} from '@/lib/schedule-save-queue';
import { supabase } from '@/integrations/supabase/client';
import { appSettingsTable } from '@/lib/app-settings-table';
import {
  saveMonthAbsences, loadMonthAbsences,
  loadEmployeeSortOrder, saveEmployeeSortOrder,
  loadCellColors, saveCellColors,
} from '@/lib/supabase-kv';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Download, Upload, Save, ChevronLeft, ChevronRight, ChevronDown, Users, Clock, AlertTriangle, CheckCircle, Copy, Printer, Calendar, CalendarDays, Eye, EyeOff, Euro, Lock, Home, Settings, Pencil, Trash2, CalendarOff, Lightbulb, BookOpen, Target, LayoutGrid, CalendarX2, Zap, MoreVertical, ArrowUpDown, Search, X, FileBarChart2, PanelLeftClose, Menu, UserPlus, Info, CalendarClock, TriangleAlert, LogOut, Share2, Globe, Send, CheckCircle2, User, Building2, MessageCircle, ClipboardPaste, Wand2, QrCode, Smartphone, Loader2, Bell, RefreshCw, Pin, PinOff, ShieldCheck } from 'lucide-react';
import { StaffFeedbackEntry, loadStaffFeedback, updateFeedbackStatus } from '@/lib/staff-feedback-store';
import { getPublicBaseUrl } from '@/lib/public-url';
import { useRef } from 'react';
import { Employee, Department } from '@/types/personnel';
import { resolveZielwert, saveZielwert, loadZielwerte, ZielwertDepartment } from '@/lib/zielwerte-store';
import {
  stablePublishToken,
  PublishType, PublishDept, PublicEmployee, ChangeHistoryEntry,
  PublishedSchedulePayload,
} from '@/lib/schedule-publish-store';
import { getStaffPortalSettingsSync } from '@/lib/staff-portal-settings';
import { DaySchedule, TimeSlot } from '@/components/schedule-planner/ScheduleGrid';
import { ModernScheduleGrid, CopiedCell } from '@/components/schedule-planner/ModernScheduleGrid';
import { ActualHoursGrid, ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { MobileDayView } from '@/components/schedule-planner/MobileDayView';
import { PlanVsIstGrid } from '@/components/schedule-planner/PlanVsIstGrid';
import { PlanVsIstTable } from '@/components/schedule-planner/PlanVsIstTable';
import { EmployeeHoursSummary } from '@/components/schedule-planner/EmployeeHoursSummary';
import { ShiftLegend } from '@/components/schedule-planner/ShiftLegend';
import { CopyWeekDialog } from '@/components/schedule-planner/CopyWeekDialog';
import { PrintScheduleDialog } from '@/components/schedule-planner/PrintScheduleDialog';
import { StaffingComparisonPanel } from '@/components/schedule-planner/StaffingComparisonPanel';
import { DayDetailDialog } from '@/components/schedule-planner/DayDetailDialog';
import { IstDayDetailDialog } from '@/components/schedule-planner/IstDayDetailDialog';
import { ShiftConfigDialog } from '@/components/schedule-planner/ShiftConfigDialog';
import { DaysOffConfigDialog } from '@/components/schedule-planner/DaysOffConfigDialog';
import { Apply8HoursDialog, getPreferredWeekdaysFromDates } from '@/components/schedule-planner/Apply8HoursDialog';
import { MonthlyCostSummary } from '@/components/schedule-planner/MonthlyCostSummary';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SICK_CODES, ACCIDENT_CODES, VACATION_CODES } from '@/lib/absence-utils';
import { ExportOptionsDialog, ExportOptions } from '@/components/schedule-planner/ExportOptionsDialog';
import { ImportMatchPreviewDialog, NameMatchOverride } from '@/components/schedule-planner/ImportMatchPreviewDialog';
import { LaborCostComparison } from '@/components/schedule-planner/LaborCostComparison';
import { KüchenplanImportDialog } from '@/components/schedule-planner/KüchenplanImportDialog';
import { WeeklyReportDialog } from '@/components/schedule-planner/WeeklyReportDialog';
import { EmployeeForm } from '@/components/EmployeeForm';
import { MirusReconcileImportButton } from '@/components/schedule-planner/MirusReconcileImportButton';
import { importScheduleFromExcelV2, exportScheduleToPDF, exportScheduleTemplate, NameMatchInfo } from '@/lib/schedule-export-import';
import { getVisibleEmployeesForRole, effectiveEmployeeDepartmentScope } from '@/lib/employee-visibility';
import { computeDailyKitchenTotals, toDailyTotalsDisplay, type EmployeeDayInput, type DailyTotalsDisplay } from '@/lib/schedule-daily-totals';
import { toast } from 'sonner';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, eachWeekOfInterval, startOfWeek, endOfWeek, isWithinInterval, isSameDay, getISOWeek, getISODay } from 'date-fns';
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
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useStichtag } from '@/contexts/StichtagContext';
import { detectPatternWarnings, PatternWarning } from '@/lib/pattern-warnings';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useShiftConfig, ShiftConfigItem } from '@/hooks/useShiftConfig';
import { usePositions } from '@/hooks/usePositions';
import { useStaffingRequirements } from '@/hooks/useStaffingRequirements';
import { buildPlannedEmployees, computeDayStaffingSummary, type DayStaffingSummaryResult } from '@/lib/staffing-comparison-utils';
import { DEFAULT_SEASON, type StaffingSeason } from '@/lib/staffing-requirements-utils';
import { useQuickTimes } from '@/hooks/useQuickTimes';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency, getEmployeeDisplayName, isEmployeeActiveInMonth } from '@/lib/personnel-utils';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import { socialCostFactorFromRates, EMPLOYER_COST_INFO } from '@/lib/social-costs';
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

// ── Feature flag — set true for localStorage-only publish (no Supabase/QR/WA) ─
const SAFE_PUBLISH_MODE = true;

const SchedulePlanner = () => {
  // ── Mandant (Tenant) ──────────────────────────────────────────────────────
  const { tenantId, tenantKey } = useTenant();

  const { shifts, shiftMap, updateShifts } = useShiftConfig();
  const { presets: quickPresets } = useQuickTimes();

  // Auth: user + loading + sessionVersion needed to gate data fetches correctly.
  // sessionVersion increments on every auth event (boot, TOKEN_REFRESHED, SIGNED_IN)
  // so pages re-fetch automatically after a background token renewal.
  const { user, loading: authLoading, sessionVersion, signOut } = useAuth();

  // ── Fetch generation counter ──────────────────────────────────────────────
  // Prevents race conditions when loadMonthData() is called concurrently
  // (e.g. mount + TOKEN_REFRESHED firing at the same time).
  // Each call increments the counter; before writing state it checks whether a
  // newer call has already started.  If so, the older call's results are
  // discarded — avoiding stale-empty overwrites of good data.
  const fetchGenRef = useRef(0);
  // hasAutoSeededBeaulieu entfernt – auto-seed dauerhaft deaktiviert
  const {
    role,
    isAdmin,
    isServiceManager,
    isKuecheManager,
    isBeaulieuManager,
    allowedDepartment,
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
  // Rollen-Sichtbarkeit: zentrale Quelle der Wahrheit für sichtbare Mitarbeiter.
  // Admin/Beaulieu → alle; Küchen-/Service-Manager → nur ihre Abteilung.
  // Wird überall verwendet, wo Mitarbeiter angezeigt, ausgewählt, gezählt oder
  // exportiert werden (die rohe `employees`-Liste bleibt nur für Laden/Speichern).
  const roleScopedEmployees = useMemo(
    () => getVisibleEmployeesForRole(role, allowedDepartment, employees),
    [role, allowedDepartment, employees],
  );
  // Personalbedarf-Abgleich: respektiert die Rollen-Abteilungssicht ALLER
  // eingeschränkten Rollen (service_manager + kueche_manager); 'all' = kein Filter.
  const comparisonDepartments = useMemo(() => {
    const scope = effectiveEmployeeDepartmentScope(role, allowedDepartment);
    return scope === 'all' ? undefined : [scope];
  }, [role, allowedDepartment]);
  // Personalbedarf: Saison geteilt zwischen Tages-Badges (Grid) und Abgleich-Panel.
  const [staffingSeason, setStaffingSeason] = useState<StaffingSeason>(DEFAULT_SEASON);
  const { positions: staffingPositions } = usePositions();
  const { requirements: staffingRequirements } = useStaffingRequirements();
  const [scheduleData, setScheduleData] = useState<{[key: string]: DaySchedule}>({});
  const [activeDepartment, setActiveDepartment] = useState<ViewMode>(
    () => effectiveEmployeeDepartmentScope(role, allowedDepartment),
  );
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [empFilterOpen, setEmpFilterOpen] = useState(false);
  const [empSearchQuery, setEmpSearchQuery] = useState('');
  const [sidebarEmpSearch, setSidebarEmpSearch] = useState('');
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(0);
  const [visibleWeekInMonth, setVisibleWeekInMonth] = useState(0);
  const [selectedDayOffset, setSelectedDayOffset] = useState(0);
  const [copyWeekDialogOpen, setCopyWeekDialogOpen] = useState(false);
  const [copiedShift, setCopiedShift] = useState<{ start: string; end: string; secondary?: { start: string; end: string } | null } | null>(null);
  const handleCopyShift = (slot: { start: string; end: string; secondary?: { start: string; end: string } | null }) => {
    setCopiedShift(slot);
    const label = slot.secondary
      ? `${slot.start}–${slot.end} / ${slot.secondary.start}–${slot.secondary.end}`
      : `${slot.start}–${slot.end}`;
    toast.success(`Schicht ${label} kopiert — öffne eine Zelle zum Einfügen`);
  };

  // ── Phase 1B: cell clipboard ───────────────────────────────────────────────
  const [copiedCell, setCopiedCell] = useState<CopiedCell | null>(null);
  const [copiedWeek, setCopiedWeek] = useState<{
    empId: string;
    data: Record<string, { früh: TimeSlot | null; frühAbsence: string | null; spät: TimeSlot | null; spätAbsence: string | null; fruehBreakMinutes: number | null; spaetBreakMinutes: number | null }>;
  } | null>(null);

  // ── Phase 1B: multi-plan stamp mode ───────────────────────────────────────
  const [multiPlanMode, setMultiPlanMode] = useState(false);
  const [multiPlanPreset, setMultiPlanPreset] = useState<{
    id: string; label: string; start: string; end: string;
    start2?: string; end2?: string; absenceCode?: string;
  } | null>(null);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [weeklyReportOpen, setWeeklyReportOpen] = useState(false);
  const [dayDetailDialogOpen, setDayDetailDialogOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [istDayDetailDialogOpen, setIstDayDetailDialogOpen] = useState(false);
  const [selectedIstDay, setSelectedIstDay] = useState<Date | null>(null);
  const [shiftConfigDialogOpen, setShiftConfigDialogOpen] = useState(false);
  const [daysOffDialogOpen, setDaysOffDialogOpen] = useState(false);
  const [selectedEmployeeForDaysOff, setSelectedEmployeeForDaysOff] = useState<Employee | null>(null);
  const [employeeDetailEmp, setEmployeeDetailEmp] = useState<Employee | null>(null);
  const [apply8HoursDialogOpen, setApply8HoursDialogOpen] = useState(false);
  const [selectedEmployeeFor8Hours, setSelectedEmployeeFor8Hours] = useState<Employee | null>(null);
  const [employeeFormOpen, setEmployeeFormOpen] = useState(false);
  const [selectedEmployeeForEdit, setSelectedEmployeeForEdit] = useState<Employee | null>(null);
  const [showFooter, setShowFooter] = useState(true);
  const [stickyHeader, setStickyHeader] = useState<boolean>(() => {
    const saved = localStorage.getItem('schedule-sticky-header');
    return saved === null ? true : saved === 'true';
  });
  const [showCosts, setShowCosts] = useState(false);
  const [showInsuranceCosts, setShowInsuranceCosts] = useState(false);
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
  const [actualHoursData, setActualHoursData] = useState<Record<string, ActualHoursEntry>>({});
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
  const [publishDialogOpen, setPublishDialogOpen]             = useState(false);
  const [publishStatus, setPublishStatus]                     = useState<'draft' | 'published' | 'changed'>('draft');
  const [publishToken, setPublishToken]                       = useState<string | null>(null);
  const [isPublishing, setIsPublishing]                       = useState(false);
  const [publishCopied, setPublishCopied]                     = useState(false);
  const [publishType, setPublishType]                         = useState<PublishType>('department');
  const [publishDept, setPublishDept]                         = useState<PublishDept>('all');
  const [publishEmpId, setPublishEmpId]                       = useState<string | null>(null);
  const [mobilePreviewUrl, setMobilePreviewUrl]               = useState<string | null>(null);
  const [showQr, setShowQr]                                   = useState(false);
  const [managerNote, setManagerNote]                         = useState('');
  const [publishHistory, setPublishHistory]                   = useState<ChangeHistoryEntry[]>([]);
  const [publishRevision, setPublishRevision]                 = useState<number>(0);
  const [publishUpdatedAt, setPublishUpdatedAt]               = useState<string | null>(null);
  const [existingPublishedPayload, setExistingPublishedPayload] = useState<PublishedSchedulePayload | null>(null);
  const [diffLoading, setDiffLoading]                         = useState(false);
  const [diffFilter, setDiffFilter]                           = useState<'all' | 'service' | 'küche'>('all');
  const [notifyChannels, setNotifyChannels]                   = useState({ whatsapp: false, sms: false, push: false, email: false });
  // ── Feedback Inbox ────────────────────────────────────────────────────────
  const [feedbackInboxOpen, setFeedbackInboxOpen]             = useState(false);
  const [feedbackItems, setFeedbackItems]                     = useState<StaffFeedbackEntry[]>([]);
  const [feedbackKeys, setFeedbackKeys]                       = useState<Record<string, string>>({});
  const [feedbackLoading, setFeedbackLoading]                 = useState(false);
  const [feedbackError, setFeedbackError]                     = useState<string | null>(null);
  const [feedbackStatusFilter, setFeedbackStatusFilter]       = useState<'all' | 'new' | 'in_progress' | 'done'>('all');
  const [lastGlobalError, setLastGlobalError]                 = useState<string | null>(null);

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

  // ── Tages-atomarer Schreibpfad: Save-Queue + synchroner Daten-Ref ─────────
  // scheduleDataRef spiegelt scheduleData SYNCHRON für alle Schreibpfade —
  // zwei schnell aufeinanderfolgende Zell-Updates (Split-Schicht!) sehen so
  // immer den jeweils neuesten Stand, nie einen stale React-State.
  const scheduleDataRef = useRef<{[key: string]: DaySchedule}>({});
  useEffect(() => { scheduleDataRef.current = scheduleData; }, [scheduleData]);
  const actualHoursRef = useRef<typeof actualHoursData>({});
  useEffect(() => { actualHoursRef.current = actualHoursData; }, [actualHoursData]);

  // Queue: pro Zelle läuft höchstens EIN Save; neuere Payloads ersetzen
  // wartende (last-writer-wins). Speicherstatus erst nach Backend-Ack.
  type QueuedSave =
    | { kind: 'plan'; entry: DaySchedule | null }
    | { kind: 'ist';  entry: ActualHoursEntry | null };
  const [queueSnap, setQueueSnap] = useState<SaveQueueSnapshot | null>(null);
  const saveQueueRef = useRef<ScheduleSaveQueue<QueuedSave> | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = new ScheduleSaveQueue<QueuedSave>(async (key, payload) => {
      const parsed = parseSaveKey(key);
      if (!parsed) throw new Error(`Ungültiger Save-Key: ${key}`);
      if (payload.kind === 'plan') {
        await saveScheduleEntry(parsed.employeeId, parsed.date, payload.entry);
      } else {
        const res = await saveActualHourEntry(parsed.employeeId, parsed.date, payload.entry);
        if (!res.ok) throw new Error(res.error || 'Ist-Eintrag konnte nicht gespeichert werden');
      }
    });
  }
  useEffect(() => {
    const q = saveQueueRef.current!;
    const unsub = q.subscribe(snap => setQueueSnap(snap));
    setQueueSnap(q.getSnapshot());
    return unsub;
  }, []);
  // Dirty-Flag zurücksetzen sobald alle Saves erfolgreich bestätigt sind
  useEffect(() => {
    if (queueSnap && !queueSnap.isSaving && queueSnap.errorCount === 0 && queueSnap.lastSavedAt) {
      setIsDirty(false);
    }
  }, [queueSnap]);
  // Wechsel-Warnung: Seite nicht verlassen solange Saves laufen oder fehlschlugen
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const q = saveQueueRef.current!;
      if (q.hasPending() || q.hasErrors()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  // ── Debug panel ──────────────────────────────────────────────────────────
  const [scheduleSource,    setScheduleSource]    = useState<'supabase' | 'cache' | 'loading'>('loading');
  const [loadedEntryCount,  setLoadedEntryCount]  = useState(0);

  // ── Budget-Daten (für PlanningAssistant) ─────────────────────────────────
  const { personnelBudget } = useBudgetMonth(
    currentMonth.getFullYear(),
    currentMonth.getMonth() + 1,
  );
  // ── Zentrale AG-Sozialkostensätze: alle Kosten = Total Arbeitgeberkosten ──
  // (Bruttolohn inkl. anteil. 13. + AG-Sozialkosten) — nie roher hourlyWage.
  const { rates: socialCostRates } = useSocialCostRates();
  const agFactor = socialCostFactorFromRates(socialCostRates);
  const agRate = useCallback(
    (emp: Employee) => getEffectiveHourlyRate(emp, socialCostRates) ?? 0,
    [socialCostRates],
  );
  const agMonthly = useCallback(
    (emp: Employee) => (emp.monthlySalaryWith13th ?? emp.monthlySalary ?? 0) * agFactor,
    [agFactor],
  );
  const paFixCost = useMemo(
    () => roleScopedEmployees.reduce((s, e) => s + agMonthly(e), 0),
    [roleScopedEmployees, agMonthly],
  );

  // ── Planungshilfe: Highlight + Jump ──────────────────────────────────────
  const [highlightedEmpId, setHighlightedEmpId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [onlyWithWarnings, setOnlyWithWarnings] = useState(false);

  const { showNetRevenue, setShowNetRevenue } = useRevenueDisplay();
  const { stichtag, isActive: stichtagActive, setStichtag, clearStichtag, formatted: stichtagFormatted } = useStichtag();

  // ── Rollenbasierter Zugriff ───────────────────────────────────────────────
  // Wenn der User kein Admin ist, wird die Abteilung automatisch gesetzt
  // und kann nicht verändert werden.
  useEffect(() => {
    const scope = effectiveEmployeeDepartmentScope(role, allowedDepartment);
    if (scope !== 'all') setActiveDepartment(scope);
  }, [role, allowedDepartment]);

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

      // AUTO-SEED DAUERHAFT DEAKTIVIERT.
      // Mitarbeiter werden ausschliesslich über den Personalstamm erfasst.
      // Kein automatisches Seeden bei leerer Datenbank.
      if (tenantId === 'beaulieu' && supabaseEmployees !== null && supabaseEmployees.length === 0) {
        console.warn('[BEAULIEU-STAFF] Keine Mitarbeiter in Supabase gefunden. Bitte im Personalstamm erfassen.');
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
        // Cache: nur normale Mitarbeiter cachen (extra cost people direkt aus Supabase)
        try {
          localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(supabaseEmployees));
        } catch { /* ignore quota errors */ }
      } else if (supabaseEmployees === null) {
        const saved = localStorage.getItem(tenantKey('schedule-employees'));
        if (saved) { try { setEmployees(JSON.parse(saved)); } catch { /* ignore */ } }
      }

      // ── PLAN-Daten (schedule_entries) ────────────────────────────────────────
      console.log('[PLAN] fetch start', { gen, monthKey });
      const supabaseSchedule = await loadScheduleForMonth(currentMonth, tenantId);
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
          // IMPORTANT: Merge existing isAdditionalCostPlan flags from localStorage —
          // these are stored locally only and must survive a Supabase reload.
          try {
            const existingRaw = localStorage.getItem(tenantKey(`schedule-v2-${monthKey}`));
            const existing: Record<string, Record<string, unknown>> = existingRaw ? JSON.parse(existingRaw) : {};
            const merged: Record<string, DaySchedule> = { ...supabaseSchedule };
            for (const [cellKey, val] of Object.entries(existing)) {
              if (val?.isAdditionalCostPlan) {
                // Merge flag even if cell has no Supabase entry (localStorage-only cell)
                merged[cellKey] = { ...(merged[cellKey] ?? {}), isAdditionalCostPlan: true };
              }
              if (val?.isAdditionalCost) {
                merged[cellKey] = { ...(merged[cellKey] ?? {}), isAdditionalCost: true };
              }
              // breakMinutes: solange Migration 20260714 nicht gelaufen ist, lebt die
              // manuelle Pause nur in localStorage — beim Supabase-Reload erhalten.
              // Hat Supabase bereits einen Wert, gewinnt Supabase.
              if (typeof val?.breakMinutes === 'number' && merged[cellKey]?.breakMinutes == null) {
                merged[cellKey] = { ...(merged[cellKey] ?? {}), breakMinutes: val.breakMinutes as number };
              }
            }
            localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(merged));
            return merged;
          } catch {
            // Quota exceeded oder Parse-Fehler: Supabase-Daten ohne Merge schreiben,
            // aber localStorage NICHT mit unfullständigen Daten überschreiben.
          }
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
        loadActualHoursForMonth(currentMonth, tenantId),
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
            // KV store has explicit user-set absence for this key → absence wins over import hours.
            // FE/K/F is the admin's authoritative override (e.g. Ferien the whole week but Mirus
            // still shows hours due to stale/wrong data). The KV absence is only present when the
            // user deliberately set FE/K/F on this IST cell.
            const kvAbsType = kvAbsences[key];
            if (kvAbsType) {
              // K/U sind bezahlte Abwesenheiten → Supabase-Stunden behalten + absenceType anfügen
              // FE/FT/F → immer hours=0 (keine Arbeitsstunden)
              const keepHours = (kvAbsType === 'K' || kvAbsType === 'U') && supaVal.hours > 0;
              merged[key] = keepHours
                ? { ...supaVal, absenceType: kvAbsType as ActualHoursEntry['absenceType'] }
                : { hours: 0, absenceType: kvAbsType as ActualHoursEntry['absenceType'] };
              console.log(`[FE-STABLE] KV absence overrides Supabase hours: ${key} type=${kvAbsType} keepHours=${keepHours} (supabase had ${supaVal.hours}h)`);
            } else if (localVal?.absenceType) {
              // localStorage also has an explicit absence — keep it
              console.log(`[FE-STABLE] localStorage absence overrides Supabase hours: ${key} type=${localVal.absenceType} (supabase had ${supaVal.hours}h)`);
              // merged[key] already = localVal via spread — no action needed
            } else {
              // No absence override → Supabase real hours win, preserve localStorage-only flags
              merged[key] = localVal?.isAdditionalCost
                ? { ...supaVal, isAdditionalCost: true }
                : supaVal;
            }
          } else if (!localVal?.absenceType) {
            // Supabase 0-hours only wins if localStorage has no absenceType (FE/K/F)
            merged[key] = supaVal;
          }
          // else: keep localStorage entry which has absenceType (FE/K/F)
        }

        // ── KV store restoration ─────────────────────────────────────────────
        // FE/K/F entries saved to KV store survive browser cache clears and
        // device switches. At this point any KV absence that conflicted with
        // Supabase hours has already been applied in the loop above. Here we
        // only need to restore KV absences for keys that weren't in Supabase.
        let kvRestored = 0;
        for (const [key, absType] of Object.entries(kvAbsences)) {
          const existing = merged[key];
          const isKUType = absType === 'K' || absType === 'U';
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
          } else if (isKUType && existing.hours > 0) {
            // K/U: vorhandene Stunden behalten + absenceType anfügen (bezahlte Abwesenheit)
            merged[key] = { ...existing, absenceType: absType as ActualHoursEntry['absenceType'] };
            kvRestored++;
            console.log(`[FE-STABLE] K/U absence merged with hours: ${key} type=${absType} hours=${existing.hours}`);
          } else {
            // existing has real hours but no absence; KV absence is the authoritative admin
            // override (e.g. Ferien entered after a wrong Mirus import). FE wins.
            console.log(`[FE-STABLE] KV absence overrides working hours: ${key} type=${absType} hours=${existing.hours}`);
            merged[key] = { hours: 0, absenceType: absType as ActualHoursEntry['absenceType'] };
            kvRestored++;
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
              // Keep FE/K/F from prev — absence always wins, even over Supabase hours.
              // Admin FE override is authoritative over Mirus import data.
              result[key] = val;
              console.log(`[FERIEN-IST] race-condition guard: kept prev absenceType entry ${key} type=${val.absenceType}`);
            }
            // Preserve isAdditionalCost from prev if the merged entry lost it
            if (val.isAdditionalCost && result[key] && !result[key].isAdditionalCost) {
              result[key] = { ...result[key], isAdditionalCost: true };
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
          // Never overwrite a localStorage entry that has absenceType (FE/K/F) with
          // a non-absence value — admin FE override is authoritative over Mirus data.
          if (freshLocal[key]?.absenceType && !val.absenceType) continue;
          if (val.hours > 0 || !freshLocal[key]?.absenceType) {
            finalForStorage[key] = freshLocal[key]?.isAdditionalCost
              ? { ...val, isAdditionalCost: true }
              : val;
          }
        }
        localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(finalForStorage));
      } else {
        console.warn('[IST] Supabase error – using localStorage + KV absences');
        const withKvAbsences: Record<string, ActualHoursEntry> = { ...localStored };
        for (const [key, absType] of Object.entries(kvAbsences)) {
          const existing = withKvAbsences[key];
          const isKUType = absType === 'K' || absType === 'U';
          if (!existing || (existing.hours === 0 && !existing.absenceType)) {
            withKvAbsences[key] = { hours: 0, absenceType: absType as ActualHoursEntry['absenceType'] };
            console.log(`[FE-STABLE] holiday survived reload (offline): ${key} type=${absType}`);
          } else if (isKUType && existing.hours > 0 && !existing.absenceType) {
            // K/U: Stunden behalten + absenceType anfügen
            withKvAbsences[key] = { ...existing, absenceType: absType as ActualHoursEntry['absenceType'] };
            console.log(`[FE-STABLE] K/U absence merged with hours (offline): ${key} type=${absType} hours=${existing.hours}`);
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

  // ── Global error capture — catches crashes & unhandled rejections ────────────
  useEffect(() => {
    const handleError = (e: ErrorEvent) => {
      const msg = `[error] ${e.message} (${e.filename?.split('/').pop() ?? '?'}:${e.lineno})`;
      console.error('[GlobalCrashCapture]', msg, e.error);
      setLastGlobalError(msg);
    };
    const handleRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'unknown');
      const msg = `[unhandledrejection] ${reason}`;
      console.error('[GlobalCrashCapture]', msg, e.reason);
      setLastGlobalError(msg);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  // Re-read actual hours from localStorage when an external import fires `schedule-updated`
  useEffect(() => {
    const handleScheduleUpdated = () => {
      const monthKey = format(currentMonth, 'yyyy-MM');
      const storageKey = tenantKey(`actual-hours-${monthKey}`);
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          setActualHoursData(JSON.parse(saved));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('schedule-updated', handleScheduleUpdated);
    return () => window.removeEventListener('schedule-updated', handleScheduleUpdated);
  }, [currentMonth, tenantKey]);

  // Load plan-copied IST keys from localStorage whenever the month changes
  useEffect(() => {
    const mk = format(currentMonth, 'yyyy-MM');
    try {
      const storageKey = tenantId === 'oliv'
        ? `actual-hours-source-${mk}`
        : `${tenantId}:actual-hours-source-${mk}`;
      const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
      // 'plan_auto_copy' = Alt-Marker vor der plan_sync-Umstellung — weiter anerkennen
      const keys = Object.keys(stored).filter(k => stored[k] === 'plan_sync' || stored[k] === 'plan_auto_copy');
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
  const scrollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startScroll = (dir: 'left' | 'right') => {
    if (scrollIntervalRef.current) return;
    const step = () => {
      if (scheduleGridRef.current) {
        scheduleGridRef.current.scrollBy({ left: dir === 'right' ? 120 : -120, behavior: 'smooth' });
      }
    };
    step();
    scrollIntervalRef.current = setInterval(step, 300);
  };

  const stopScroll = () => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  };

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

      // ESC cancels paint mode and multi-plan mode
      if (e.key === 'Escape') {
        setPaintTool(null);
        if (multiPlanMode) { setMultiPlanMode(false); setMultiPlanPreset(null); }
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
    // No month filter — show all 7 days even when the week spans two months
    return eachDayOfInterval({ start: weekStart, end: weekEnd });
  }, [calendarView, daysInMonth, selectedDayOffset, selectedWeekIndex, weeksInMonth]);

  // Personalbedarf Soll/Ist je angezeigtem Tag (kompakte Badges im Grid-Kopf).
  // Nur Anzeige: nutzt dieselbe rollen-gescopte Sicht wie das Abgleich-Panel;
  // Tage ohne Bedarf (oder ohne Bedarf im Rollen-Scope) erhalten KEINEN Eintrag.
  const dayStaffingSummaries = useMemo(() => {
    const map: Record<string, DayStaffingSummaryResult> = {};
    if (staffingRequirements.length === 0 || staffingPositions.length === 0) return map;
    for (const day of displayDays) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const planned = buildPlannedEmployees(
        roleScopedEmployees, scheduleData, staffingPositions, dateStr,
      );
      const summary = computeDayStaffingSummary({
        positions: staffingPositions,
        requirements: staffingRequirements,
        plannedEmployees: planned,
        season: staffingSeason,
        weekday: getISODay(day), // ISO 1..7 (Mo..So)
        departments: comparisonDepartments,
      });
      if (summary.hasRequirements && summary.departments.length > 0) {
        map[dateStr] = summary;
      }
    }
    return map;
  }, [displayDays, roleScopedEmployees, scheduleData, staffingPositions, staffingRequirements, staffingSeason, comparisonDepartments]);

  // Calculate hours from a time slot
  const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
    if (!slot?.start || !slot?.end) return 0;
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24;
    return Math.round(hours * 100) / 100;
  };

  // Calculate total NET hours for a day (früh + spät) — SSoT calculateDayNetHours
  // (Pause pro Einsatz abgezogen und je Einsatz auf 0 geclampt, sonst Legacy/Automatik).
  const calculateDayHours = (daySchedule: DaySchedule): number =>
    calculateDayNetHours(daySchedule);

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

  // ── Absence cost sets ───────────────────────────────────────────────────────
  //
  // DAILY_ABSENCE_NO_COST: used for the operative Tages-PKQ (column totals).
  //   K (Krank) and U (Unfall) are excluded — they don't count against the
  //   daily revenue-based PKQ (only actual worked hours).
  //
  // FORECAST_ABSENCE_NO_COST: used for monthly/weekly plan totals and Forecast.
  //   Only FE (Ferien) is excluded. K and U generate real wage costs for
  //   hourly workers and must appear in Forecast / PersonalFIX / Monatsübersicht.
  //   Monthly-salary employees are already covered by their fixed salary —
  //   no double-counting possible (their cost path uses monthlySalary directly).
  const DAILY_ABSENCE_NO_COST    = new Set(['FE', 'K', 'U']);
  const FORECAST_ABSENCE_NO_COST = new Set(['FE']);

  // Returns the K/U absence hours for a single day for forecast purposes.
  // Returns 0 for FE (vacation) and for employees on monthly salary (no extra cost).
  const getDayAbsenceHoursForForecast = (ds: { frühAbsence?: string | null; spätAbsence?: string | null } | null | undefined): number => {
    if (!ds) return 0;
    const getH = (abbrev: string | null | undefined): number => {
      if (!abbrev) return 0;
      if (FORECAST_ABSENCE_NO_COST.has(abbrev)) return 0;
      const shift = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
      return shift && shiftMap[shift].hours > 0 ? shiftMap[shift].hours : 0;
    };
    return getH(ds.frühAbsence) + getH(ds.spätAbsence);
  };

  // Like calculateEmployeeHours, but used for the DAILY PKQ display.
  // Excludes FE, K and U → only actually-worked shift hours count against daily revenue.
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
          if (DAILY_ABSENCE_NO_COST.has(abbrev)) return 0; // FE/K/U → no cost in daily PKQ
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

  // Used for Forecast / PersonalFIX / monthly plan totals.
  // Includes K and U hours for HOURLY workers (they are paid absences).
  // Monthly-salary employees never call this — their path uses monthlySalary directly.
  const calculateCostableHoursForForecast = (employeeId: string): number => {
    let totalHours = 0;
    daysInMonth.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const cellKey = `${employeeId}-${dateStr}`;
      const daySchedule = scheduleData[cellKey];
      if (!daySchedule) return;
      totalHours += getDayAbsenceHoursForForecast(daySchedule);
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

  // ── Tages-atomarer Schreibpfad (SSoT für ALLE Plan-Zelländerungen) ────────
  // Liest den aktuellen Tag SYNCHRON aus scheduleDataRef (nie stale State),
  // merged den Patch, schreibt State + Ref + localStorage und reiht GENAU
  // EINEN Save für den ganzen Tag in die Queue ein (last-writer-wins).
  // Rückgabe: neuer Tageswert (null = Zelle geleert), undefined = Validierung
  // abgebrochen. Speicherstatus (✓/Fehler) kommt erst mit dem Backend-Ack.
  const applyDayPatch = (
    employeeId: string,
    date: string,
    patch: Partial<DaySchedule>,
    opts?: { replace?: boolean },
  ): DaySchedule | null | undefined => {
    const cellKey = `${employeeId}-${date}`;
    const current = opts?.replace ? {} : (scheduleDataRef.current[cellKey] || {});
    const updated: DaySchedule = { ...current, ...patch };

    // Schichtzeiten nur validieren wenn beide Slots echte Zeiten sind
    if (updated.früh && updated.spät && !updated.frühAbsence && !updated.spätAbsence) {
      const validation = validateShiftTimes(updated.früh, updated.spät);
      if (!validation.valid) {
        toast.error(validation.message);
        return undefined;
      }
      if (validation.message) toast.warning(validation.message);
    }

    const isEmpty = !updated.früh && !updated.spät && !updated.frühAbsence && !updated.spätAbsence;
    const newState = { ...scheduleDataRef.current };
    if (isEmpty) delete newState[cellKey];
    else newState[cellKey] = updated;

    // Ref SYNCHRON aktualisieren — der nächste Patch (z. B. 2. Slot einer
    // Split-Schicht) sieht diesen Stand sofort, kein Race mehr.
    scheduleDataRef.current = newState;
    setScheduleData(prev => {
      const next = { ...prev };
      if (isEmpty) delete next[cellKey];
      else next[cellKey] = updated;
      return next;
    });
    setIsDirty(true);

    const monthKey = format(currentMonth, 'yyyy-MM');
    localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(newState));

    saveQueueRef.current!.enqueue(
      planSaveKey(employeeId, date),
      { kind: 'plan', entry: isEmpty ? null : updated },
    );
    console.log(`[SCHEDULE] day ${isEmpty ? 'cleared' : 'queued'} – key=${cellKey}`);
    window.dispatchEvent(new CustomEvent('schedule-updated'));
    return isEmpty ? null : updated;
  };

  // ── Plan→Ist-Absenz-Sync (idempotent, day-atomar) ─────────────────────────
  // Leitet die effektive Plan-Absenz aus dem FINALEN Tageszustand ab (nie aus
  // einem einzelnen Slot-Argument) und spiegelt sie in die Ist-Stunden:
  //  - Absenz gesetzt  → Ist-Eintrag mit source:'plan_sync' (Upsert, idempotent)
  //  - Absenz entfernt → nur den plan-synchronisierten Ist-Eintrag löschen
  //  - Konflikt mit echten Ist-Daten → sichtbarer Dialog, nie stilles Skippen
  const syncPlanAbsenceToIst = (employeeId: string, date: string, day: DaySchedule | null) => {
    const cellKey = `${employeeId}-${date}`;
    const absenceType = day?.frühAbsence || day?.spätAbsence || null;

    // Normalisierung: alle Sick/Accident/Vacation-Codes → kanonischer Wert
    const canonicalAbsence = !absenceType ? null
      : SICK_CODES.has(absenceType)     ? 'K'
      : ACCIDENT_CODES.has(absenceType) ? 'U'
      : VACATION_CODES.has(absenceType) ? 'FE'
      : absenceType === 'F'             ? 'F'
      : absenceType;

    const writeIstEntry = (newEntry: ActualHoursEntry) => {
      setActualHoursData(prevActual => ({ ...prevActual, [cellKey]: newEntry }));
      actualHoursRef.current = { ...actualHoursRef.current, [cellKey]: newEntry };
      saveQueueRef.current!.enqueue(istSaveKey(employeeId, date), { kind: 'ist', entry: newEntry });
      const mk = format(currentMonth, 'yyyy-MM');
      const stored: Record<string, unknown> = (() => {
        try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${mk}`)) || '{}'); }
        catch { return {}; }
      })();
      localStorage.setItem(tenantKey(`actual-hours-${mk}`), JSON.stringify({ ...stored, [cellKey]: newEntry }));
      setPlanCopiedKeys(prev => new Set([...prev, cellKey]));
      try {
        const srcKey = tenantKey(`actual-hours-source-${format(currentMonth, 'yyyy-MM')}`);
        const src = JSON.parse(localStorage.getItem(srcKey) || '{}');
        src[cellKey] = 'plan_sync';
        localStorage.setItem(srcKey, JSON.stringify(src));
      } catch { /* ignore */ }
    };

    if (canonicalAbsence) {
      const isFE = canonicalAbsence === 'FE';
      const isKU = canonicalAbsence === 'K' || canonicalAbsence === 'U';
      const isF  = canonicalAbsence === 'F';
      const absShiftCfg = Object.values(shiftMap).find(s => s.abbrev === absenceType);
      const absHours = absShiftCfg?.hours ?? 0;
      // FE/K/U/F immer kopieren; andere Abwesenheiten nur wenn konfigurierte Stunden > 0
      const shouldCopy = isFE || isKU || isF || (absHours > 0 && absShiftCfg?.countsToTarget !== false);
      if (!shouldCopy) return;

      // FE/F: 0h + absenceType; K/U: konfigurierte Stunden + absenceType; andere: nur Stunden
      const newEntry: ActualHoursEntry = (isFE || isF)
        ? { hours: 0, absenceType: canonicalAbsence as 'FE' | 'F', source: 'plan_sync' }
        : isKU
        ? { hours: absHours, absenceType: canonicalAbsence as 'K' | 'U', source: 'plan_sync' }
        : { hours: absHours, source: 'plan_sync' };

      const existing = actualHoursRef.current[cellKey];
      const isPlanSynced = existing &&
        (existing.source === 'plan_sync' || planCopiedKeys.has(cellKey));

      // Idempotenz: identischer plan-synchronisierter Eintrag → nichts tun
      if (existing && isPlanSynced &&
          existing.hours === newEntry.hours &&
          (existing.absenceType ?? null) === (newEntry.absenceType ?? null)) {
        return;
      }

      // Konflikt: echte Ist-Daten (Import/manuell) vorhanden → sichtbarer Dialog
      const hasRealIst = existing && !isPlanSynced &&
        ((existing.start && existing.end) || existing.hours > 0 || existing.absenceType);
      if (hasRealIst) {
        toast('Ist-Eintrag existiert bereits', {
          description: `Für diesen Tag gibt es bereits echte Ist-Stunden (${existing.hours} h). Mit der Plan-Absenz «${canonicalAbsence}» überschreiben?`,
          duration: 10000,
          action: {
            label: 'Überschreiben',
            onClick: () => writeIstEntry(newEntry),
          },
        });
        return;
      }

      if (absenceType !== canonicalAbsence) {
        console.log(`[PLAN-IST] normalisiert: ${absenceType} → ${canonicalAbsence}`);
      }
      console.log(`[PLAN-IST] plan->ist übernommen: ${employeeId} ${date} absenceType=${canonicalAbsence} → Ist hours=${newEntry.hours} (source=plan_sync)`);
      writeIstEntry(newEntry);
    } else {
      // Keine Plan-Absenz (mehr) → nur den plan-synchronisierten Ist-Eintrag entfernen
      const existing = actualHoursRef.current[cellKey];
      if (!existing) return;
      const isPlanSynced = existing.source === 'plan_sync' || planCopiedKeys.has(cellKey)
        || (!!existing.absenceType && existing.hours === 0);
      if (!isPlanSynced || (!existing.absenceType && existing.hours > 0)) return;

      const nextActual = { ...actualHoursRef.current };
      delete nextActual[cellKey];
      actualHoursRef.current = nextActual;
      setActualHoursData(prevActual => {
        const next = { ...prevActual };
        delete next[cellKey];
        return next;
      });
      saveQueueRef.current!.enqueue(istSaveKey(employeeId, date), { kind: 'ist', entry: null });
      const mk = format(currentMonth, 'yyyy-MM');
      const stored: Record<string, unknown> = (() => {
        try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${mk}`)) || '{}'); }
        catch { return {}; }
      })();
      delete stored[cellKey];
      localStorage.setItem(tenantKey(`actual-hours-${mk}`), JSON.stringify(stored));
      setPlanCopiedKeys(prev => {
        const next = new Set(prev);
        next.delete(cellKey);
        return next;
      });
      console.log(`[PLAN-IST] plan absence entfernt → plan-synchronisierten Ist-Eintrag gelöscht: ${cellKey}`);
    }
  };

  const handleSlotChange = (
    employeeId: string, 
    date: string, 
    slotType: 'früh' | 'spät', 
    value: TimeSlot | null, 
    absenceType?: string | null,
    // Pause pro EINSATZ: undefined = unverändert, number = manuell, null = keine Angabe
    breakMinutes?: number | null
  ) => {
    const cellKey = `${employeeId}-${date}`;
    const hadAbsence = !!(scheduleDataRef.current[cellKey]?.frühAbsence
      || scheduleDataRef.current[cellKey]?.spätAbsence);

    const patch: Partial<DaySchedule> = slotType === 'früh'
      ? { früh: value, frühAbsence: absenceType || null }
      : { spät: value, spätAbsence: absenceType || null };
    if (breakMinutes !== undefined) {
      if (slotType === 'früh') patch.fruehBreakMinutes = breakMinutes;
      else patch.spaetBreakMinutes = breakMinutes;
    }

    const result = applyDayPatch(employeeId, date, patch);
    if (result === undefined) return; // Validierung abgebrochen

    // Plan→Ist-Absenz-Sync auf Basis des FINALEN Tageszustands (nie pro Slot).
    // Nur wenn sich am Absenz-Zustand etwas geändert haben kann — sonst würde
    // jeder reine Zeit-Edit den Sync (inkl. Konflikt-Dialogen) neu anstossen.
    const hasAbsenceNow = !!(result?.frühAbsence || result?.spätAbsence);
    if (absenceType || hasAbsenceNow || hadAbsence) {
      syncPlanAbsenceToIst(employeeId, date, result);
    }

    // ── Angebot: IST-Eintrag löschen wenn er aus Plan übernommen wurde ──────
    _offerDeleteIst(result === null, cellKey);
  };

  // ── Zusatzkosten-Plan: toggle isAdditionalCostPlan auf einem DaySchedule ─
  const handleAdditionalCostPlanChange = (empId: string, date: string, v: boolean) => {
    console.log('[ZK-PLAN] handleAdditionalCostPlanChange called', { empId, date, v });
    const cellKey = `${empId}-${date}`;
    setScheduleData(prev => {
      const current = prev[cellKey] || {};
      const updated: DaySchedule = { ...current };
      if (v) {
        updated.isAdditionalCostPlan = true;
      } else {
        delete updated.isAdditionalCostPlan;
      }
      const newState = { ...prev, [cellKey]: updated };
      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`schedule-v2-${monthKey}`), JSON.stringify(newState));
      saveScheduleEntry(empId, date, updated).catch(err =>
        console.error('[SCHEDULE] saveScheduleEntry (additionalCostPlan) error:', err)
      );
      // Notify PersonalFix to re-read plan hours
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return newState;
    });
  };

  // ── handleSlotChange continued: IST-Eintrag löschen Angebot ─────────────
  // NOTE: this is called implicitly inside handleSlotChange via hoisting; 
  // keep the closure vars (willBeEmpty, planCopiedKeys, cellKey) in scope.
  function _offerDeleteIst(willBeEmpty: boolean, cellKey: string) {
    if (!willBeEmpty || !planCopiedKeys.has(cellKey)) return;
    const employeeId2 = cellKey.slice(0, -11);
    const date2       = cellKey.slice(-10);
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
          saveActualHourEntry(employeeId2, date2, null).catch(console.error);
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

  // ── Phase 1B: Cell + Week clipboard handlers ────────────────────────────

  // Tages-atomarer Ersatz einer Zelle (Paste/Stempel/Leeren): EIN Save für den
  // ganzen Tag statt zwei racender Slot-Saves — die 2. Schicht geht nie verloren.
  const applyDayReplace = (empId: string, dateStr: string, day: Partial<DaySchedule> | null) => {
    const result = applyDayPatch(empId, dateStr, day ?? {}, { replace: true });
    if (result === undefined) return;
    syncPlanAbsenceToIst(empId, dateStr, result);
    _offerDeleteIst(result === null, `${empId}-${dateStr}`);
  };

  const handleCopyCell = (empId: string, dateStr: string) => {
    const ds = scheduleData[`${empId}-${dateStr}`] || {};
    if (!ds.früh && !ds.frühAbsence && !ds.spät && !ds.spätAbsence) { toast('Zelle ist leer'); return; }
    setCopiedCell({
      primary: ds.früh || null,
      secondary: ds.spät || null,
      absence: ds.frühAbsence || ds.spätAbsence || null,
      fruehBreakMinutes: ds.fruehBreakMinutes ?? ds.breakMinutes ?? null,
      spaetBreakMinutes: ds.spaetBreakMinutes ?? null,
    });
    toast.success('Zelle kopiert');
  };

  const handlePasteCell = (empId: string, dateStr: string) => {
    if (!copiedCell) return;
    if (copiedCell.absence) {
      applyDayReplace(empId, dateStr, { früh: null, frühAbsence: copiedCell.absence, spät: null, spätAbsence: null });
    } else {
      applyDayReplace(empId, dateStr, {
        früh: copiedCell.primary, frühAbsence: null,
        spät: copiedCell.secondary, spätAbsence: null,
        fruehBreakMinutes: copiedCell.fruehBreakMinutes ?? null,
        spaetBreakMinutes: copiedCell.spaetBreakMinutes ?? null,
      });
    }
  };

  const handleClearCell = (empId: string, dateStr: string) => {
    const ds = scheduleData[`${empId}-${dateStr}`] || {};
    if (!ds.früh && !ds.frühAbsence && !ds.spät && !ds.spätAbsence) return;
    toast('Zelle leeren?', {
      action: {
        label: 'Leeren',
        onClick: () => applyDayReplace(empId, dateStr, null),
      },
    });
  };

  const handleCopyWeek = (empId: string) => {
    const data: Record<string, { früh: TimeSlot | null; frühAbsence: string | null; spät: TimeSlot | null; spätAbsence: string | null; fruehBreakMinutes: number | null; spaetBreakMinutes: number | null }> = {};
    displayDays.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const ds = scheduleData[`${empId}-${dateStr}`] || {};
      data[dateStr] = {
        früh: ds.früh || null, frühAbsence: ds.frühAbsence || null,
        spät: ds.spät || null, spätAbsence: ds.spätAbsence || null,
        fruehBreakMinutes: ds.fruehBreakMinutes ?? ds.breakMinutes ?? null,
        spaetBreakMinutes: ds.spaetBreakMinutes ?? null,
      };
    });
    const empName = employees.find(e => e.id === empId)?.name || empId;
    setCopiedWeek({ empId, data });
    toast.success(`Woche von ${empName} kopiert`);
  };

  const handlePasteWeek = (empId: string) => {
    if (!copiedWeek) return;
    // Paste by day-index (Mo=0, Di=1, …) so it works across different weeks
    const srcDates = Object.keys(copiedWeek.data).sort();
    displayDays.forEach((day, idx) => {
      const dateStr = format(day, 'yyyy-MM-dd');
      const srcDate = srcDates[idx];
      const src = srcDate ? copiedWeek.data[srcDate] : null;
      if (!src) return;
      applyDayReplace(empId, dateStr, {
        früh: src.früh, frühAbsence: src.frühAbsence,
        spät: src.spät, spätAbsence: src.spätAbsence,
        fruehBreakMinutes: src.fruehBreakMinutes ?? null,
        spaetBreakMinutes: src.spaetBreakMinutes ?? null,
      });
    });
    toast.success('Woche eingefügt');
  };

  const handleMultiPlanCell = (empId: string, dateStr: string) => {
    if (!multiPlanPreset) return;
    if (multiPlanPreset.absenceCode) {
      applyDayReplace(empId, dateStr, { früh: null, frühAbsence: multiPlanPreset.absenceCode, spät: null, spätAbsence: null });
    } else {
      applyDayReplace(empId, dateStr, {
        früh: { start: multiPlanPreset.start, end: multiPlanPreset.end },
        frühAbsence: null,
        spät: (multiPlanPreset.start2 && multiPlanPreset.end2)
          ? { start: multiPlanPreset.start2, end: multiPlanPreset.end2 }
          : null,
        spätAbsence: null,
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
    const entryWithSource: ActualHoursEntry = { ...entry, source: 'plan_sync' };
    setActualHoursData(prev => ({ ...prev, [cellKey]: entryWithSource }));
    actualHoursRef.current = { ...actualHoursRef.current, [cellKey]: entryWithSource };
    saveQueueRef.current!.enqueue(istSaveKey(employeeId, date), { kind: 'ist', entry: entryWithSource });
    const mk = format(currentMonth, 'yyyy-MM');
    const prefix = tenantId === 'oliv' ? '' : `${tenantId}:`;
    const sourceKey = `${prefix}actual-hours-source-${mk}`;
    const hoursKey  = `${prefix}actual-hours-${mk}`;
    try {
      const stored = JSON.parse(localStorage.getItem(sourceKey) || '{}');
      stored[cellKey] = 'plan_sync';
      localStorage.setItem(sourceKey, JSON.stringify(stored));
    } catch { /* ignore */ }
    try {
      const prev = JSON.parse(localStorage.getItem(hoursKey) || '{}');
      localStorage.setItem(hoursKey, JSON.stringify({ ...prev, [cellKey]: entryWithSource }));
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

    // Use the full day schedule so that split shifts (früh + spät) are correctly summed
    const daySchedule = scheduleData[cellKey];
    let hours: number;
    let start: string | undefined;
    let end: string | undefined;
    let start2: string | undefined;
    let end2: string | undefined;

    if (daySchedule && (daySchedule.früh || daySchedule.spät)) {
      // calculateDayHours sums both blocks and applies a single break deduction
      hours = calculateDayHours(daySchedule);
      if (daySchedule.früh) {
        start = daySchedule.früh.start;
        end   = daySchedule.früh.end;
        if (daySchedule.spät) {
          start2 = daySchedule.spät.start;
          end2   = daySchedule.spät.end;
        }
      } else if (daySchedule.spät) {
        start = daySchedule.spät.start;
        end   = daySchedule.spät.end;
      }
    } else {
      // Fallback: only the passed slot is available (should rarely happen).
      // Netto via SSoT (Automatik-Pausenregel, keine manuellen Pausen bekannt).
      hours = calculateDayNetHours({ früh: slot });
      start = slot.start;
      end   = slot.end;
    }

    const entry: ActualHoursEntry = { hours, start, end, start2, end2 };

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualHoursData, planCopiedKeys, doSavePlanToIst, scheduleData]);


  const handleRemoveEmployee = (employeeId: string) => {
    const emp = employees.find(e => e.id === employeeId);
    // Soft-Delete: Mitarbeiter aus lokaler Ansicht entfernen, in Supabase archivieren (employment_end_date = heute).
    // Physisches Löschen ist verboten — historische Dienstpläne müssen weiterhin auf diesen Mitarbeiter zeigen.
    const updatedEmployees = employees.filter(e => e.id !== employeeId);
    setEmployees(updatedEmployees);
    dbArchiveEmployee(employeeId);
    localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
    if (emp) {
      toast.success(`${emp.name} archiviert (Austrittsdatum gesetzt)`);
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
      // upsertAllEmployees BLOCKIERT: employees-Schreibpfad ausschliesslich via Personalstamm.
      // await upsertAllEmployees(employees, tenantId);

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
        // Kein Full-Blob-Write nach localStorage: der KV-Write oben übernimmt
        // die Lohnkosten-Felder. Ein Full-Overwrite würde stale Revenue-Daten
        // aus dem React-State über einen frisch aus KV geladenen Wert schreiben.
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
  // opts.skipSupabase: Aufrufer hat bereits selbst (awaited) in Supabase geschrieben
  // — z.B. der MIRUS-Import, der Schreibfehler pro Zelle prüfen muss.
  const handleActualHoursChange = (employeeId: string, date: string, entry: ActualHoursEntry | null, opts?: { skipSupabase?: boolean }) => {
    const cellKey = `${employeeId}-${date}`;

    setActualHoursData(prev => {
      if (entry === null) {
        const newState = { ...prev };
        delete newState[cellKey];

        // Always delete from Supabase — absence_type column exists and loadActualHoursForMonth now reads it back.
        if (!opts?.skipSupabase) saveActualHourEntry(employeeId, date, null);

        const monthKey = format(currentMonth, 'yyyy-MM');
        localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(newState));
        window.dispatchEvent(new CustomEvent('schedule-updated'));
        return newState;
      }

      const newState = { ...prev, [cellKey]: entry };

      // Always persist to Supabase — including FE/FT/K/U/F absence entries.
      // loadActualHoursForMonth now maps absence_type back, so absences survive
      // browser cache clears and device switches without depending on localStorage.
      if (entry.absenceType) {
        console.log(`[FERIEN-IST] saving absence to Supabase: ${cellKey} type=${entry.absenceType}`);
      }
      if (!opts?.skipSupabase) saveActualHourEntry(employeeId, date, entry);

      const monthKey = format(currentMonth, 'yyyy-MM');
      localStorage.setItem(tenantKey(`actual-hours-${monthKey}`), JSON.stringify(newState));
      window.dispatchEvent(new CustomEvent('schedule-updated'));
      return newState;
    });
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
          employees: roleScopedEmployees,
          currentMonth,
          department: options.department,
          dailyBudgets,
          scheduleData,
          showCosts: options.includeCosts,
          includeWeeklyPages: true,
          specificDays,
          exportType: options.exportType ?? 'aushang',
          restaurantName,
          showEmpHours:  options.showEmpHours,
          showDayTotals: options.showDayTotals,
          rates: socialCostRates,
        });
        toast.success(`PDF (${rangeLabel}) erfolgreich exportiert`);
      } else {
        await exportScheduleTemplate({
          employees: roleScopedEmployees,
          currentMonth,
          department: options.department,
          dailyBudgets,
          scheduleData,
          specificDays,
          hoursType: options.hoursType,
          includeCosts: options.includeCosts,
          actualHoursData,
          restaurantName,
          rates: socialCostRates,
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
      // Deduplicate: never create an employee whose name already exists (case-insensitive).
      const existingNames = new Set(employees.map(e => e.name.toLowerCase().trim()));
      const trulyNew = newEmployees.filter(emp => !existingNames.has(emp.name.toLowerCase().trim()));
      const skipped  = newEmployees.filter(emp =>  existingNames.has(emp.name.toLowerCase().trim()));

      if (skipped.length > 0) {
        console.warn(`[IMPORT] Duplikat übersprungen (Name bereits vorhanden): ${skipped.map(e => e.name).join(', ')}`);
        toast.warning(`${skipped.map(e => e.name).join(', ')} bereits vorhanden – kein Duplikat erstellt`);
      }

      if (trulyNew.length > 0) {
        // Sicherheitscheck: Employees mit auto-generierten Import-IDs dürfen NICHT ohne
        // explizite Benutzerbestätigung in Supabase geschrieben werden.
        // Diese entstehen nur wenn der Preview-Dialog umgangen wurde.
        const safeToSave = trulyNew.filter(emp => !emp.id.startsWith('imported-'));
        const blocked    = trulyNew.filter(emp =>  emp.id.startsWith('imported-'));

        if (blocked.length > 0) {
          console.error(`[IMPORT] Auto-Import BLOCKIERT für ${blocked.length} Mitarbeiter ohne explizite Bestätigung: ${blocked.map(e => e.name).join(', ')}`);
          toast.error(`Import blockiert: ${blocked.map(e => e.name).join(', ')} müssen im Vorschau-Dialog bestätigt werden`);
        }

        if (safeToSave.length > 0) {
          const updatedEmployees = [...employees, ...safeToSave];
          setEmployees(updatedEmployees);
          // upsertEmployee BLOCKIERT: Neue Mitarbeiter nur über Personalstamm erfassen.
          // safeToSave.forEach(emp => upsertEmployee(emp, tenantId));
          localStorage.setItem(tenantKey('schedule-employees'), JSON.stringify(updatedEmployees));
          toast.success(`${safeToSave.length} Mitarbeiter lokal hinzugefügt (nur diese Sitzung). Für dauerhafte Erfassung → Personalstamm`);
        } else {
          toast.success('Dienstplan erfolgreich importiert');
        }
      } else {
        toast.success('Dienstplan erfolgreich importiert');
      }
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
      applyDayReplace(selectedEmployeeFor8Hours.id, dateStr, { früh: null, frühAbsence: '8.5', spät: null, spätAbsence: null });
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
      // Add new employee — guard against duplicates by name
      const existing = employees.find(e => e.name.toLowerCase().trim() === (employeeData.name ?? '').toLowerCase().trim());
      if (existing) {
        toast.warning(`"${employeeData.name}" existiert bereits — kein Duplikat erstellt`);
        setSelectedEmployeeForEdit(null);
        return;
      }
      // Neuer Mitarbeiter über SchedulePlanner BLOCKIERT.
      // Neue Mitarbeiter ausschliesslich über den Personalstamm erfassen.
      toast.error(`"${employeeData.name}" kann hier nicht erfasst werden. Bitte im Personalstamm neu anlegen.`);
      setSelectedEmployeeForEdit(null);
      return;
    }
    setSelectedEmployeeForEdit(null);
  };

  // Filter out employees who were not active in the displayed month.
  // Uses isEmployeeActiveInMonth which checks both exit date (employmentEndDate)
  // and entry date (contractStart) against the selected year/month.
  const activeEmployees = (() => {
    const yr  = currentMonth.getFullYear();
    const mon = currentMonth.getMonth() + 1;
    return roleScopedEmployees.filter(e => {
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
  const varHoursExceeded = roleScopedEmployees
    .filter(e => !((e.employmentType === 'vollzeit' || e.employmentType === 'teilzeit') && (e.monthlySalary ?? 0) > 0))
    .map(e => ({ emp: e, planned: calculateEmployeeHours(e.id), estimated: varEstimatedHours[e.id] ?? 0 }))
    .filter(r => r.estimated > 0 && r.planned > r.estimated);

  // ── Pattern warnings (consecutive days, late streaks, short recovery, overload) ──
  const patternWarnings = useMemo<PatternWarning[]>(
    () => detectPatternWarnings(roleScopedEmployees, daysInMonth, scheduleData),
    [roleScopedEmployees, daysInMonth, scheduleData],
  );

  // ── Display employees: apply "Nur mit Warnungen" filter as a post-pass ────
  const displayEmployees = onlyWithWarnings
    ? filteredEmployees.filter(e => patternWarnings.some(w => w.empId === e.id))
    : filteredEmployees;

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
      return sum + agMonthly(emp);
    }
    // K + U included for hourly workers (paid absences in monthly forecast)
    const hrs = calculateCostableHoursForForecast(emp.id);
    return sum + hrs * agRate(emp);
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


  // ── Geplante Personalkosten (Total AG): Monat / Woche / Tag ────────────────
  const weeklyPlannedLaborCost = visibleEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + agMonthly(emp) * (displayDays.length / daysInMonth.length);
    }
    // K + U absence hours included for hourly workers (paid absences in weekly forecast)
    const hrs = displayDays.reduce((h, day) => {
      const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (ds ? calculateDayHours(ds) + getDayAbsenceHoursForForecast(ds) : 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  // ── Kueche-Manager: per-day manager-safe header totals (Plan-PKQ) ──────────
  // Computed ONLY for the kitchen manager; admin/service get an empty map so the
  // ModernScheduleGrid day header behaves exactly as before for them. Uses the
  // same kitchen-scoped basis as the week/month PKQ cards (visibleEmployees) so
  // the per-day ratio is consistent with those totals and is NOT distorted by
  // the "nur mit Warnungen" row filter. The CHF cost is stripped before it ever
  // reaches the grid (toDailyTotalsDisplay) — the manager never sees wages.
  const dailyManagerTotals = useMemo<Record<string, DailyTotalsDisplay>>(() => {
    if (!isKuecheManager) return {};
    const monthDays = daysInMonth.length;
    const out: Record<string, DailyTotalsDisplay> = {};
    for (const day of displayDays) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const inputs: EmployeeDayInput[] = visibleEmployees.map(emp => {
        const ds = scheduleData[`${emp.id}-${dateStr}`];
        // AG-Basis: Lohnfelder tragen Total Arbeitgeberkosten (Monat bzw. /h),
        // damit die Manager-PKQ dieselbe Basis hat wie die Wochen-/Monats-Karten.
        // CHF bleibt intern — toDailyTotalsDisplay strippt personnelCost weiterhin.
        return {
          employmentType: emp.employmentType,
          monthlySalary: (emp.monthlySalary ?? 0) > 0 ? agMonthly(emp) : emp.monthlySalary,
          hourlyWage: agRate(emp),
          dayHours: ds ? calculateDayHours(ds) : 0,
          dayAbsenceHours: ds ? getDayAbsenceHoursForForecast(ds) : 0,
        };
      });
      const revenue = dailyBudgets[dateStr]?.plannedRevenue ?? 0;
      out[dateStr] = toDailyTotalsDisplay(
        computeDailyKitchenTotals(inputs, revenue, laborCostThreshold, monthDays),
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKuecheManager, visibleEmployees, displayDays, scheduleData, dailyBudgets, laborCostThreshold, daysInMonth, agMonthly, agRate]);

  // ── Ist-Personalkosten (Total AG): aus tatsächlich erfassten Stunden ───────
  const weeklyIstLaborCost = visibleEmployees.reduce((sum, emp) => {
    const hrs = displayDays.reduce((h, day) => {
      const cellKey = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
      const entry = actualHoursData[cellKey];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  const monthlyIstLaborCost = visibleEmployees.reduce((sum, emp) => {
    const hrs = daysInMonth.reduce((h, day) => {
      const cellKey = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
      const entry = actualHoursData[cellKey];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  // ── Gesamt-Personalkosten Total AG (immer Küche + Service, unabhängig vom Dept-Filter) ──────
  const gesamtMonthlyPlannedLaborCost = activeEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + agMonthly(emp);
    }
    // K + U included for hourly workers in the monthly forecast total
    const hrs = calculateCostableHoursForForecast(emp.id);
    return sum + hrs * agRate(emp);
  }, 0);

  const gesamtWeeklyPlannedLaborCost = activeEmployees.reduce((sum, emp) => {
    if ((emp.employmentType === 'vollzeit' || emp.employmentType === 'teilzeit') && emp.monthlySalary) {
      return sum + agMonthly(emp) * (displayDays.length / daysInMonth.length);
    }
    // K + U absence hours included for hourly workers in the weekly forecast total
    const hrs = displayDays.reduce((h, day) => {
      const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (ds ? calculateDayHours(ds) + getDayAbsenceHoursForForecast(ds) : 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  const gesamtWeeklyIstLaborCost = activeEmployees.reduce((sum, emp) => {
    const hrs = displayDays.reduce((h, day) => {
      const entry = actualHoursData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  const gesamtMonthlyIstLaborCost = activeEmployees.reduce((sum, emp) => {
    const hrs = daysInMonth.reduce((h, day) => {
      const entry = actualHoursData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
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

  // ── Zeitkonsistente Ist-PKQ (SSOT-Prinzip) ───────────────────────────────
  // Antipattern vermeiden: aufgelaufene Ist-Kosten des GANZEN Monats dürfen
  // NICHT gegen einen Teil-/fehlenden Ist-Umsatz gerechnet werden (früher bis
  // >100 %). Zähler und Nenner müssen dieselbe Periode abdecken → wir zählen
  // NUR Tage, die tatsächlich Ist-Umsatz haben (dieselbe Logik wie der
  // Personalkosten-Kern: Ist ÷ Ist über deckungsgleiche Tage).
  const revenueDateSet = new Set(
    Object.entries(dailyBudgets)
      .filter(([date, b]) => (b.actualRevenue || 0) > 0 &&
        (calendarView === 'month' ? monthDateSet.has(date) : displayDateSet.has(date)))
      .map(([date]) => date),
  );
  const istLaborCostOnRevenueDays = activeEmployees.reduce((sum, emp) => {
    const hrs = Array.from(revenueDateSet).reduce((h, date) => {
      const entry = actualHoursData[`${emp.id}-${date}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);

  // Ist-Modus: zeitkonsistente Quote (Kosten der Umsatz-Tage ÷ Umsatz dieser
  // Tage). Plan-Modus: unverändert (Plan ÷ Plan-Budget, per Definition
  // deckungsgleich). Ohne Ist-Umsatz-Tag → null → Anzeige „—".
  const gesamtCostRatio = scheduleMode === 'ist'
    ? (activeRevenue > 0 ? (istLaborCostOnRevenueDays / activeRevenue) * 100 : null)
    : (activeRevenue > 0 ? (gesamtActiveLaborCost / activeRevenue) * 100 : null);
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

  // Abteilungs-Einzelziele nur noch für info, nicht für die Kostenziel-Anzeige verwendet.
  // Das Gesamtkostenziel (Küche + Service kombiniert) ist immer laborCostThreshold (z.B. 40%).
  const serviceThreshold = _serviceResolved.targetPercent;
  const kücheThreshold   = _kücheResolved.targetPercent;

  // Immer das globale Gesamtziel verwenden — niemals 20 % je Abteilung.
  // (settings.laborCostTargetPercent via zielwerte-store, Fallback: 40 %)
  const gridLaborCostThreshold = laborCostThreshold;

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

  // ── PUBLISH DIFF ─────────────────────────────────────────────────────────
  // Load the existing published payload when the dialog opens so we can show
  // a change preview before the admin clicks "Veröffentlichen".
  useEffect(() => {
    if (!publishDialogOpen) {
      setExistingPublishedPayload(null);
      setDiffFilter('all');
      return;
    }
    const token = stablePublishToken(tenantId, publishDept);
    const key   = `published-schedule:${token}`;
    setDiffLoading(true);
    appSettingsTable().select('value').eq('key', key).maybeSingle()
      .then(({ data }) => {
        setExistingPublishedPayload(
          data?.value && typeof data.value === 'object'
            ? data.value as PublishedSchedulePayload
            : null,
        );
      })
      .catch(() => setExistingPublishedPayload(null))
      .finally(() => setDiffLoading(false));
  }, [publishDialogOpen, publishDept, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  type PublishDiffEntry = {
    empId: string; empName: string; department: 'service' | 'küche';
    date: string; dayLabel: string;
    prevFrüh: { start: string; end: string } | null;
    prevSpät: { start: string; end: string } | null;
    prevFrühAbsence: string | null; prevSpätAbsence: string | null;
    newFrüh:  { start: string; end: string } | null;
    newSpät:  { start: string; end: string } | null;
    newFrühAbsence:  string | null; newSpätAbsence:  string | null;
  };

  // Compute day-by-day diff between current scheduleData and existing payload.
  // Only runs when existing payload covers the same week as the current view.
  const publishDiffAll = useMemo((): PublishDiffEntry[] => {
    if (!existingPublishedPayload?.employees) return [];
    const days = displayDays.length > 0 ? displayDays : [currentMonth];
    // Different week → nothing to compare (all days would appear "new")
    if (existingPublishedPayload.weekStart !== format(days[0], 'yyyy-MM-dd')) return [];

    let targetEmps = roleScopedEmployees.filter(e => isEmployeeActiveInMonth(e, days[0]));
    if (publishDept !== 'all') targetEmps = targetEmps.filter(e => e.department === publishDept);

    const entries: PublishDiffEntry[] = [];
    for (const emp of targetEmps) {
      const existingEmp = existingPublishedPayload.employees!.find(e => e.id === emp.id);
      for (const day of days) {
        const dateStr = format(day, 'yyyy-MM-dd');
        const slot    = scheduleData[`${emp.id}-${dateStr}`] ?? {};
        const nFrüh   = slot.früh        ?? null;
        const nSpät   = slot.spät        ?? null;
        const nFrühA  = slot.frühAbsence ?? null;
        const nSpätA  = slot.spätAbsence ?? null;
        const prev    = existingEmp?.days.find(d => d.date === dateStr);
        const pFrüh   = prev?.früh         ?? null;
        const pSpät   = prev?.spät         ?? null;
        const pFrühA  = prev?.frühAbsence  ?? null;
        const pSpätA  = prev?.spätAbsence  ?? null;
        const changed =
          JSON.stringify(nFrüh) !== JSON.stringify(pFrüh) ||
          JSON.stringify(nSpät) !== JSON.stringify(pSpät) ||
          nFrühA !== pFrühA || nSpätA !== pSpätA;
        if (changed) {
          entries.push({
            empId: emp.id, empName: getEmployeeDisplayName(emp),
            department: emp.department as 'service' | 'küche',
            date: dateStr, dayLabel: format(day, 'EEE d.MMM', { locale: de }),
            prevFrüh: pFrüh, prevSpät: pSpät, prevFrühAbsence: pFrühA, prevSpätAbsence: pSpätA,
            newFrüh:  nFrüh, newSpät:  nSpät, newFrühAbsence:  nFrühA, newSpätAbsence:  nSpätA,
          });
        }
      }
    }
    return entries;
  }, [existingPublishedPayload, roleScopedEmployees, displayDays, scheduleData, publishDept, currentMonth]);

  const publishDiffFiltered = useMemo(() =>
    diffFilter === 'all' ? publishDiffAll : publishDiffAll.filter(e => e.department === diffFilter),
  [publishDiffAll, diffFilter]);

  const publishDiffAffectedEmps = useMemo(() =>
    new Set(publishDiffAll.map(e => e.empId)).size, [publishDiffAll]);

  // ── Feedback Inbox — load + computed ────────────────────────────────────
  const loadFeedbackItems = useCallback(async () => {
    if (!tenantId) return;
    setFeedbackLoading(true);
    setFeedbackError(null);
    try {
      const { entries, keys } = await loadStaffFeedback(tenantId);
      setFeedbackItems(entries);
      setFeedbackKeys(keys);
    } catch {
      setFeedbackError('Rückmeldungen konnten nicht geladen werden.');
    } finally {
      setFeedbackLoading(false);
    }
  }, [tenantId]);

  // Initial load on mount
  useEffect(() => { void loadFeedbackItems(); }, [loadFeedbackItems]);

  // Refresh every time the inbox opens
  useEffect(() => {
    if (feedbackInboxOpen) void loadFeedbackItems();
  }, [feedbackInboxOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const feedbackNewCount = useMemo(
    () => feedbackItems.filter(f => f.status === 'new').length,
    [feedbackItems],
  );

  const feedbackFiltered = useMemo(() => {
    if (feedbackStatusFilter === 'all') return feedbackItems;
    return feedbackItems.filter(f => f.status === feedbackStatusFilter);
  }, [feedbackItems, feedbackStatusFilter]);

  /** Map from employeeName → StaffFeedbackEntry[] for cell indicators */
  const feedbackByEmpName = useMemo(() => {
    const map = new Map<string, StaffFeedbackEntry[]>();
    for (const f of feedbackItems) {
      if (f.date === 'Allgemein') continue;
      const list = map.get(f.employeeName) ?? [];
      list.push(f);
      map.set(f.employeeName, list);
    }
    return map;
  }, [feedbackItems]);

  const handleFeedbackStatusChange = async (
    entry: StaffFeedbackEntry,
    newStatus: StaffFeedbackEntry['status'],
  ) => {
    const key = feedbackKeys[entry.id];
    if (!key) return;
    try {
      await updateFeedbackStatus(key, entry, newStatus);
      setFeedbackItems(prev =>
        prev.map(f => f.id === entry.id ? { ...f, status: newStatus } : f),
      );
    } catch { /* silently ignore — user sees no change */ }
  };

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

  // ── Wechsel-Warnung: Monat erst wechseln wenn alle Saves bestätigt sind ──
  // (Monatswechsel lädt scheduleData neu — laufende/fehlgeschlagene Saves des
  //  alten Monats würden sonst kommentarlos verloren gehen.)
  const guardUnsavedThen = (proceed: () => void) => {
    const q = saveQueueRef.current!;
    if (q.hasErrors()) {
      toast.error('Es gibt nicht gespeicherte Änderungen', {
        description: 'Einige Einträge konnten nicht gespeichert werden. Erneut versuchen oder trotzdem wechseln?',
        duration: 10000,
        action: { label: 'Trotzdem wechseln', onClick: proceed },
      });
      return;
    }
    if (q.hasPending()) {
      toast.info('Speichert noch … Wechsel folgt automatisch nach Abschluss');
      void q.flush(8000).then(ok => {
        if (ok && !q.hasErrors()) proceed();
        else toast.error('Speichern nicht abgeschlossen — bitte erneut wechseln');
      });
      return;
    }
    proceed();
  };

  // Navigations-Handler für den Card-Header (◀ / ▶)
  const handlePrevPeriod = () => {
    if (calendarView === 'month') {
      guardUnsavedThen(() => setCurrentMonth(prev => subMonths(prev, 1)));
    } else if (calendarView === 'week') {
      if (selectedWeekIndex > 0) {
        setSelectedWeekIndex(prev => prev - 1);
      } else {
        // Monatsübergreifend: springe zur letzten Woche des Vormonats
        const prevMonth = subMonths(currentMonth, 1);
        const prevWeeks = eachWeekOfInterval(
          { start: startOfMonth(prevMonth), end: endOfMonth(prevMonth) },
          { weekStartsOn: 1 },
        );
        guardUnsavedThen(() => {
          setCurrentMonth(prevMonth);
          setSelectedWeekIndex(prevWeeks.length - 1);
        });
      }
    } else {
      setSelectedDayOffset(prev => Math.max(0, prev - 1));
    }
  };
  const handleNextPeriod = () => {
    if (calendarView === 'month') {
      guardUnsavedThen(() => setCurrentMonth(prev => addMonths(prev, 1)));
    } else if (calendarView === 'week') {
      if (selectedWeekIndex < weeksInMonth.length - 1) {
        setSelectedWeekIndex(prev => prev + 1);
      } else {
        // Monatsübergreifend: springe zur ersten Woche des Folgemonats
        guardUnsavedThen(() => {
          setCurrentMonth(prev => addMonths(prev, 1));
          setSelectedWeekIndex(0);
        });
      }
    } else {
      setSelectedDayOffset(prev => Math.min(daysInMonth.length - 1, prev + 1));
    }
  };
  const isPrevDisabled = calendarView === 'day' ? selectedDayOffset === 0 : false;
  const isNextDisabled = calendarView === 'day' ? selectedDayOffset >= daysInMonth.length - 1 : false;

  const handleNavigateToday = () => {
    guardUnsavedThen(() => {
      const today = new Date();
      setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
      setSelectedWeekIndex(0);
      setSelectedDayOffset(0);
    });
  };

  // Für Rückwärtskompatibilität (wird noch an anderen Stellen referenziert)
  const totalPlannedRevenue = monthlyPlannedRevenue;

  const plannedCostRatio = activeRevenue > 0
    ? (activeLaborCost / activeRevenue) * 100
    : null;
  const costRatioStatus: 'good' | 'ok' | 'high' | 'unknown' =
    plannedCostRatio === null ? 'unknown' :
    plannedCostRatio <= laborCostThreshold ? 'good' :
    plannedCostRatio <= laborCostThreshold + 5 ? 'ok' : 'high';

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
    return sum + actualHrs * agRate(emp);
  }, 0);

  // ── Lohnkosten Versicherung: K/U-Abwesenheiten zu 80% ─────────────────────
  // Krank (K) und Unfall (U) in IST → Arbeitgeber wird durch Versicherung entlastet.
  // Effektive Kosten = 80% der Total Arbeitgeberkosten/h für diese Tage.
  const totalKrankUnfallLaborCost = useMemo(() => visibleEmployees.reduce((sum, emp) => {
    const kuHrs = Object.entries(actualHoursData)
      .filter(([key]) => monthDateSet.has(key.slice(-10)) && key.startsWith(`${emp.id}-`))
      .filter(([, e]) => e.absenceType === 'K' || e.absenceType === 'U')
      .reduce((s, [, e]) => s + e.hours, 0);
    return sum + kuHrs * agRate(emp);
  }, 0), [actualHoursData, visibleEmployees, monthDateSet, agRate]);

  // 20% Versicherungsersatz (der Anteil den die Versicherung übernimmt)
  const insuranceCostOffset = totalKrankUnfallLaborCost * 0.20;
  // Effektive Kosten nach Versicherungsabzug (K/U zu 80%)
  const totalActualLaborCostWithInsurance = totalActualLaborCost - insuranceCostOffset;
  // Zeitkonsistente Ist-Quote für den Soll/Ist-Vergleich: Ist-Kosten NUR der
  // Tage mit Ist-Umsatz ÷ Ist-Umsatz dieser Tage (deckungsgleiche Periode).
  // Verhindert das „volle Monatskosten ÷ Teilumsatz"-Antipattern (>100 %).
  const monthRevenueDateSet = new Set(
    Object.entries(dailyBudgets)
      .filter(([date, b]) => (b.actualRevenue || 0) > 0 && monthDateSet.has(date))
      .map(([date]) => date),
  );
  const actualLaborCostOnRevenueDays = visibleEmployees.reduce((sum, emp) => {
    const hrs = Array.from(monthRevenueDateSet).reduce((h, date) => {
      const entry = actualHoursData[`${emp.id}-${date}`];
      return h + (entry?.hours || 0);
    }, 0);
    return sum + hrs * agRate(emp);
  }, 0);
  const actualCostRatio = totalActualRevenue > 0 && actualLaborCostOnRevenueDays > 0
    ? (actualLaborCostOnRevenueDays / totalActualRevenue) * 100
    : null;
  const hasActualHours = totalActualHoursAll > 0;
  const hasActualRevenue = totalActualRevenue > 0;

  // ── Ferienabbau (FE-Einträge im Plan + Ist) ────────────────────────────────
  // Plan-FE: scheduleData[key].frühAbsence === 'FE' oder spätAbsence === 'FE'
  // Ist-FE:  actualHoursData[key].absenceType === 'FE' (hours=0)
  // Ferienabbau CHF = FE-Tage × (weeklyHours/5 oder 8.4h) × Total Arbeitgeberkosten/h
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

      const empAgRate = agRate(emp);
      if (empSollFe > 0) {
        const chf = empSollFe * dailyH * empAgRate;
        console.log(`[FERIEN] Soll-Ferienabbau: ${emp.name} ${empSollFe} Tage × ${dailyH.toFixed(1)}h × CHF ${empAgRate.toFixed(2)} (Total AG/h) = CHF ${chf.toFixed(2)}`);
        sollTage += empSollFe;
        sollChf  += chf;
      }
      if (empIstFe > 0) {
        const chf = empIstFe * dailyH * empAgRate;
        console.log(`[FERIEN] Ist-Ferienabbau: ${emp.name} ${empIstFe} Tage × ${dailyH.toFixed(1)}h × CHF ${empAgRate.toFixed(2)} (Total AG/h) = CHF ${chf.toFixed(2)}`);
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
  }, [scheduleData, actualHoursData, visibleEmployees, daysInMonth, agRate]);

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

  // ── PUBLISH SCHEDULE ──────────────────────────────────────────────────────
  const publishSchedule = async () => {
    console.log('[publishSchedule] start — type:', publishType, 'dept:', publishDept);
    setIsPublishing(true);
    try {
      // ── Stable token (deterministic, never changes per tenant+dept) ────────
      const token  = stablePublishToken(tenantId, publishDept);
      const kvKey  = `published-schedule:${token}`;

      const days      = displayDays.length > 0 ? displayDays : [currentMonth];
      const weekStart = days[0];
      const weekEnd   = days[days.length - 1];
      const period: import('@/lib/schedule-publish-store').PublishPeriod = days.length <= 7 ? 'week' : 'month';
      const kw        = getISOWeek(weekStart);
      const weekLabel = period === 'month'
        ? format(weekStart, 'MMMM yyyy', { locale: de })
        : `KW ${kw} · ${format(weekStart, 'd. MMM', { locale: de })} – ${format(weekEnd, 'd. MMM yyyy', { locale: de })}`;

      console.log('[publishSchedule] stable token:', token, '| key:', kvKey);

      // ── 0. Read existing payload for change detection + revision ───────────
      let existingPayload: PublishedSchedulePayload | null = null;
      try {
        const { data: exData } = await appSettingsTable()
          .select('value')
          .eq('key', kvKey)
          .maybeSingle();
        if (exData?.value && typeof exData.value === 'object') {
          existingPayload = exData.value as PublishedSchedulePayload;
          console.log('[publishSchedule] existing payload found, revision:', existingPayload.revision ?? 0);
        } else {
          console.log('[publishSchedule] no existing payload — first publish');
        }
      } catch (e) {
        console.warn('[publishSchedule] could not read existing payload (non-fatal):', e);
      }

      // ── 1. Build employee list ─────────────────────────────────────────────
      let targetEmps = roleScopedEmployees.filter(e => isEmployeeActiveInMonth(e, weekStart));
      if (publishType === 'personal' && publishEmpId) {
        targetEmps = targetEmps.filter(e => e.id === publishEmpId);
      } else if (publishType === 'department' && publishDept !== 'all') {
        targetEmps = targetEmps.filter(e => e.department === publishDept);
      }

      // ── 2. Build public employees with per-day change detection ────────────
      const publicEmployees: PublicEmployee[] = targetEmps.map(emp => {
        const existingEmp = existingPayload?.employees?.find(e => e.id === emp.id);
        return {
          id:         emp.id,
          name:       getEmployeeDisplayName(emp),
          department: emp.department as 'service' | 'küche',
          days: days.map(day => {
            const dateStr  = format(day, 'yyyy-MM-dd');
            const slot     = scheduleData[`${emp.id}-${dateStr}`] ?? {};
            const frühSlot = slot.früh ?? null;
            const spätSlot = slot.spät ?? null;

            // Shift-Code-Lookup aus ShiftConfig (reverse: start+end → name).
            // Wird in der Mitarbeiteransicht für Pausenhinweise genutzt.
            // Keine Auswirkung auf Berechnungen.
            let frühCode: string | undefined;
            let spätCode: string | undefined;
            if (frühSlot && spätSlot) {
              // Versuche zuerst Split-Schicht (ein Code deckt beide Slots ab)
              const splitKey = Object.keys(shiftMap).find(k => {
                const s = shiftMap[k];
                return s.start === frühSlot.start && s.end === frühSlot.end
                    && s.start2 === spätSlot.start && s.end2 === spätSlot.end;
              });
              if (splitKey) {
                frühCode = splitKey; // ein Code für die ganze Schicht
              } else {
                // Zwei unabhängige Schichten
                frühCode = Object.keys(shiftMap).find(k => shiftMap[k].start === frühSlot.start && shiftMap[k].end === frühSlot.end);
                spätCode = Object.keys(shiftMap).find(k => shiftMap[k].start === spätSlot.start && shiftMap[k].end === spätSlot.end);
              }
            } else if (frühSlot) {
              frühCode = Object.keys(shiftMap).find(k => shiftMap[k].start === frühSlot.start && shiftMap[k].end === frühSlot.end);
            } else if (spätSlot) {
              spätCode = Object.keys(shiftMap).find(k => shiftMap[k].start === spätSlot.start && shiftMap[k].end === spätSlot.end);
            }

            const newDay: import('@/lib/schedule-publish-store').PublicDayEntry = {
              date:        dateStr,
              dayLabel:    format(day, 'EEEE, d. MMMM', { locale: de }),
              früh:        frühSlot,
              spät:        spätSlot,
              frühAbsence: slot.frühAbsence ?? null,
              spätAbsence: slot.spätAbsence ?? null,
              ...(frühCode ? { frühCode } : {}),
              ...(spätCode ? { spätCode } : {}),
            };

            // Change detection against previous publish
            if (existingEmp) {
              const oldDay = existingEmp.days.find(d => d.date === dateStr);
              if (oldDay) {
                const changed =
                  JSON.stringify(newDay.früh)  !== JSON.stringify(oldDay.früh)  ||
                  JSON.stringify(newDay.spät)  !== JSON.stringify(oldDay.spät)  ||
                  newDay.frühAbsence           !== oldDay.frühAbsence           ||
                  newDay.spätAbsence           !== oldDay.spätAbsence;
                if (changed) {
                  newDay.changed       = true;
                  newDay.changeType    = 'changed';
                  newDay.previousFrüh  = oldDay.früh  ?? null;
                  newDay.previousSpät  = oldDay.spät  ?? null;
                }
              }
            }

            return newDay;
          }),
        };
      });

      // ── 3. Compute revision + status ───────────────────────────────────────
      const hasChanges = existingPayload !== null &&
        publicEmployees.some(e => e.days.some(d => d.changed));
      const revision   = (existingPayload?.revision ?? 0) + 1;
      const now        = new Date().toISOString();

      const changeHistory: ChangeHistoryEntry[] = [
        ...(existingPayload?.changeHistory ?? []),
        revision === 1
          ? { timestamp: now, description: 'Erstveröffentlichung' }
          : hasChanges
            ? { timestamp: now, description: `Aktualisiert (Revision ${revision})` }
            : { timestamp: now, description: `Erneut veröffentlicht – keine Änderungen (Revision ${revision})` },
      ];

      const selectedEmp = employees.find(e => e.id === publishEmpId);
      const payload: PublishedSchedulePayload = {
        version:      2,
        revision,
        type:         publishType,
        period,
        restaurant:   tenantId === 'beaulieu' ? 'Beaulieu' : 'Oliv',
        kw,
        weekLabel,
        weekStart:    format(weekStart, 'yyyy-MM-dd'),
        weekEnd:      format(weekEnd,   'yyyy-MM-dd'),
        publishedAt:  existingPayload?.publishedAt ?? now,   // first-publish date preserved
        updatedAt:    now,
        status:       hasChanges ? 'changed' : 'published',
        department:   publishDept,
        employees:    publicEmployees,
        employeeId:   publishType === 'personal' ? (publishEmpId ?? undefined) : undefined,
        employeeName: publishType === 'personal' && selectedEmp
          ? getEmployeeDisplayName(selectedEmp) : undefined,
        managerNote:  managerNote || undefined,
        changeHistory,
        settings:     getStaffPortalSettingsSync(),
      };

      console.log('[publishSchedule] revision:', revision, '| hasChanges:', hasChanges,
        '| employees:', publicEmployees.length, '| status:', payload.status);

      // ── 4. Write ───────────────────────────────────────────────────────────
      const { error: writeError } = await appSettingsTable()
        .upsert({ key: kvKey, value: payload }, { onConflict: 'key' });

      if (writeError) {
        console.error('[publishSchedule] write FAILED:', writeError.message, writeError.code);
        toast.error(`Speichern fehlgeschlagen: ${writeError.message}`, { duration: 8000 });
        return;
      }

      // Also cache to localStorage for instant same-device load
      try { localStorage.setItem(`schedule-publish:${token}`, JSON.stringify(payload)); } catch { /* ignore */ }
      console.log('[publishSchedule] write OK ✓');

      // ── 5. Verify (read-back) ──────────────────────────────────────────────
      const { data: rbData, error: rbError } = await appSettingsTable()
        .select('key, value')
        .eq('key', kvKey)
        .maybeSingle();

      if (rbError || !rbData?.value) {
        console.error('[publishSchedule] verify FAILED:', rbError?.message ?? 'row missing');
        toast.error('Veröffentlichung konnte nicht geprüft werden', { duration: 8000 });
        return;
      }
      const verifiedEmpCount = (rbData.value as any)?.employees?.length ?? 0;
      console.log('[publishSchedule] verify OK ✓  employees in DB:', verifiedEmpCount, '| revision:', revision);

      setPublishToken(token);
      setPublishStatus('published');
      setPublishRevision(revision);
      setPublishUpdatedAt(now);

      // ── Fire-and-forget: Snapshot + Change-Log ──────────────────────────
      // Kein await — UX blockiert nicht, Fehler werden nur geloggt.
      const publisherEmail = user?.email ?? 'unknown';
      const pubYear  = currentMonth.getFullYear();
      const pubMonth = currentMonth.getMonth() + 1;

      // 1. Publikations-Snapshot speichern
      insertSchedulePublicationSnapshot({
        tenant_id:     tenantId,
        year:          pubYear,
        month:         pubMonth,
        department:    publishDept,
        published_by:  publisherEmail,
        revision,
        snapshot_json: payload as unknown as Record<string, unknown>,
      }).catch(() => {});

      // 2. Änderungseinträge für changed-Tage schreiben
      const changeType: ScheduleChangeLogEntry['change_type'] =
        revision === 1 ? 'first_publish' : 'update_after_publish';
      const logEntries: ScheduleChangeLogEntry[] = publishDiffAll.flatMap(diff => {
        const rows: ScheduleChangeLogEntry[] = [];
        const base = {
          tenant_id:   tenantId,
          employee_id: diff.empId,
          date:        diff.date,
          department:  diff.department,
          changed_by:  publisherEmail,
          change_type: changeType,
          revision,
        } as const;
        // frueh shift
        if (JSON.stringify(diff.prevFrüh) !== JSON.stringify(diff.newFrüh)) {
          rows.push({
            ...base,
            field_name: 'frueh_shift',
            old_value:  diff.prevFrüh ? `${diff.prevFrüh.start}–${diff.prevFrüh.end}` : null,
            new_value:  diff.newFrüh  ? `${diff.newFrüh.start}–${diff.newFrüh.end}`   : null,
          });
        }
        // spaet shift
        if (JSON.stringify(diff.prevSpät) !== JSON.stringify(diff.newSpät)) {
          rows.push({
            ...base,
            field_name: 'spaet_shift',
            old_value:  diff.prevSpät ? `${diff.prevSpät.start}–${diff.prevSpät.end}` : null,
            new_value:  diff.newSpät  ? `${diff.newSpät.start}–${diff.newSpät.end}`   : null,
          });
        }
        // frueh absence
        if (diff.prevFrühAbsence !== diff.newFrühAbsence) {
          rows.push({ ...base, field_name: 'frueh_absence', old_value: diff.prevFrühAbsence, new_value: diff.newFrühAbsence });
        }
        // spaet absence
        if (diff.prevSpätAbsence !== diff.newSpätAbsence) {
          rows.push({ ...base, field_name: 'spaet_absence', old_value: diff.prevSpätAbsence, new_value: diff.newSpätAbsence });
        }
        return rows;
      });
      if (logEntries.length > 0) {
        insertScheduleChangeLogs(logEntries).catch(() => {});
        console.log(`[publishSchedule] change-log: ${logEntries.length} rows queued`);
      }
      // ─────────────────────────────────────────────────────────────────────

      if (hasChanges) {
        toast.success(`Dienstplan aktualisiert ✓ – Revision ${revision} · ${publicEmployees.length} Mitarbeitende`, { duration: 5000 });
      } else if (revision === 1) {
        toast.success(`Dienstplan veröffentlicht ✓ – ${publicEmployees.length} Mitarbeitende`);
      } else {
        toast.success(`Dienstplan erneut veröffentlicht ✓ – Revision ${revision}`);
      }
    } catch (err) {
      console.error('[publishSchedule] failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Veröffentlichen fehlgeschlagen: ${msg}`, { duration: 8000 });
    } finally {
      setIsPublishing(false);
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="bg-background h-full flex flex-col">
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
              <button
                onClick={() => setLegendSidebarOpen(v => !v)}
                className="flex items-center justify-center h-7 w-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground shrink-0"
                title="Panel öffnen / schliessen"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="text-base font-bold text-foreground leading-tight">Dienstplanung</h1>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {/* ── Save-Status Pill (Queue-basiert: ✓ erst nach Backend-Ack) ── */}
              {(() => {
                const queueErrors = queueSnap?.errorCount ?? 0;
                const queueSaving = queueSnap?.isSaving ?? false;
                const errText = saveError
                  || (queueErrors > 0
                    ? `${queueErrors} ${queueErrors === 1 ? 'Eintrag' : 'Einträge'} nicht gespeichert — klicken zum Wiederholen`
                    : null);
                if (errText) {
                  return (
                    <button
                      type="button"
                      onClick={() => saveQueueRef.current!.retryFailed()}
                      className="hidden sm:flex items-center gap-1 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 hover:bg-red-100"
                      title={errText}
                    >
                      <span>⚠ Nicht gespeichert{queueErrors > 0 ? ` (${queueErrors})` : ''} — erneut versuchen</span>
                    </button>
                  );
                }
                if (queueSaving || isSaving) {
                  return (
                    <span className="hidden sm:flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Speichert…</span>
                    </span>
                  );
                }
                const savedAt = [queueSnap?.lastSavedAt ?? null, lastSaveTime]
                  .filter((d): d is Date => !!d)
                  .sort((a, b) => a.getTime() - b.getTime())
                  .pop();
                if (savedAt) {
                  return (
                    <span className="hidden sm:flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5" title="Vom Server bestätigt">
                      ✓ {savedAt.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  );
                }
                return null;
              })()}
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
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "gap-1.5 h-8",
                  publishStatus === 'published' && "border-emerald-400 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-600 dark:text-emerald-400 dark:hover:bg-emerald-950/20",
                  publishStatus === 'changed' && "border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-600 dark:text-amber-400 dark:hover:bg-amber-950/20"
                )}
                onClick={() => setPublishDialogOpen(true)}
                title="Dienstplan veröffentlichen"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">
                  {publishStatus === 'published' ? 'Veröffentlicht' : publishStatus === 'changed' ? 'Geändert' : 'Teilen'}
                </span>
              </Button>
              {/* ── WhatsApp Toolbar Button ─────────────────────── */}
              {(() => {
                const isLive = publishStatus === 'published' || publishStatus === 'changed';
                const _days  = displayDays.length > 0 ? displayDays : [currentMonth];
                const _kw    = getISOWeek(_days[0]);
                const _period = _days.length <= 7 ? 'week' : 'month';
                const _kwLabel = _period === 'week'
                  ? `KW ${_kw}`
                  : format(_days[0], 'MMMM yyyy', { locale: de });
                const _url   = `${getPublicBaseUrl()}/staff-schedule/${stablePublishToken(tenantId, publishDept)}`;
                const _waText = publishRevision > 1
                  ? `Hallo zusammen,\nder Dienstplan wurde aktualisiert. Bitte prüft die Änderungen nochmals:\n${_url}`
                  : `Hallo zusammen,\nhier ist der Dienstplan für ${_kwLabel}:\n${_url}`;
                return (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!isLive}
                    title={isLive ? 'Per WhatsApp teilen' : 'Zuerst Dienstplan veröffentlichen'}
                    className={cn(
                      "gap-1.5 h-8",
                      isLive
                        ? "border-green-400 text-green-700 hover:bg-green-50 dark:border-green-600 dark:text-green-400 dark:hover:bg-green-950/20"
                        : "opacity-50 cursor-not-allowed"
                    )}
                    onClick={() => {
                      if (!isLive) return;
                      window.open(`https://wa.me/?text=${encodeURIComponent(_waText)}`, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">WhatsApp</span>
                  </Button>
                );
              })()}
              {/* ── Feedback Inbox Button ───────────────────────── */}
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "gap-1.5 h-8 relative",
                  feedbackNewCount > 0 && "border-blue-400 text-blue-700 hover:bg-blue-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-950/20",
                )}
                onClick={() => setFeedbackInboxOpen(true)}
                title="Mitarbeiter-Rückmeldungen"
              >
                <Bell className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Rückmeldungen</span>
                {feedbackNewCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-4 min-w-[16px] px-0.5 rounded-full bg-blue-500 text-white text-[9px] font-bold flex items-center justify-center">
                    {feedbackNewCount > 9 ? '9+' : feedbackNewCount}
                  </span>
                )}
              </Button>
              <Link to="/settings">
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Einstellungen">
                  <Settings className="h-4 w-4" />
                </Button>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                title="Abmelden"
                onClick={() => signOut()}
              >
                <LogOut className="h-4 w-4" />
              </Button>
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
                  <DropdownMenuItem onClick={() => { setMultiPlanMode(true); }}>
                    <Wand2 className="h-4 w-4 mr-2 text-violet-500" />
                    Mehrfach planen
                  </DropdownMenuItem>
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
                    Alle ({roleScopedEmployees.length})
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
                      setShowInsuranceCosts(false);
                    } else if (isBeaulieuManager) {
                      setShowCosts(true);
                      setShowFooter(true);
                    } else {
                      setCostPasswordDialogOpen(true);
                    }
                  }}
                  title={showCosts ? 'Kosten ausblenden' : 'Kosten einblenden'}
                >
                  <Euro className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Kosten</span>
                </Button>
                {effectiveShowCosts && (
                  <Button
                    variant={showInsuranceCosts ? 'default' : 'outline'}
                    size="sm"
                    className={showInsuranceCosts
                      ? "h-7 gap-1.5 text-xs px-2.5 bg-amber-600 hover:bg-amber-700 border-amber-600"
                      : "h-7 gap-1.5 text-xs px-2.5 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/30"}
                    onClick={() => setShowInsuranceCosts(v => !v)}
                    title="Lohnkosten Versicherung: Krank/Unfall zu 80% berechnen"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Versicherung</span>
                  </Button>
                )}
              </>
            )}
          </div>

        </div>
      </header>

      {/* ══════════════ BODY: inline sidebar + scrollable main ══════════════ */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

      {/* LEFT SIDEBAR: inline panel, no overlay */}
      {legendSidebarOpen && (
      <aside className="w-[240px] min-w-[240px] shrink-0 flex flex-col bg-card border-r border-border">
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
          <span className="font-semibold text-sm">Schichtplanung</span>
          <button
            onClick={() => setLegendSidebarOpen(false)}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="Schliessen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable sections */}
        <div className="flex-1 overflow-y-auto p-2 space-y-2">

          {/* ── Schichten + Abwesenheiten ──────────────────────── */}
          <ShiftLegend
            onEditClick={() => setShiftConfigDialogOpen(true)}
            department={activeDepartment === 'all' ? 'all' : activeDepartment as 'service' | 'küche'}
            activeTool={paintTool}
            onToolSelect={setPaintTool}
            mode="sidebar"
          />

          {/* ── Filter ─────────────────────────────────────────── */}
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="px-2.5 py-1.5 border-b border-border/50 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Filter</p>
              {(selectedEmployeeIds.length > 0 || empTypeFilter !== null || onlyWithWarnings) && (
                <button
                  onClick={() => { setSelectedEmployeeIds([]); setEmpTypeFilter(null); setSidebarEmpSearch(''); setOnlyWithWarnings(false); }}
                  className="text-[10px] text-primary hover:underline"
                  title="Alle Filter zurücksetzen"
                >
                  zurücksetzen
                </button>
              )}
            </div>
            <div className="px-2 py-2 space-y-2">
              {/* Department — only for admins who can switch */}
              {canSwitchDepartment && (
                <div className="flex items-center gap-1 flex-wrap">
                  {([
                    { key: 'all' as const,     label: 'Alle',    dot: null },
                    { key: 'service' as const, label: 'Service', dot: 'bg-blue-500' },
                    { key: 'küche' as const,   label: 'Küche',   dot: 'bg-orange-500' },
                  ]).map(({ key, label, dot }) => (
                    <button
                      key={key}
                      onClick={() => setActiveDepartment(key as Department)}
                      className={cn(
                        "h-6 px-2 text-[11px] font-medium rounded-md flex items-center gap-1 transition-colors border",
                        activeDepartment === key
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                      )}
                    >
                      {dot && <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />}
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Employment type */}
              <div className="flex items-center gap-1 flex-wrap">
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
                      "h-6 px-2 text-[11px] font-medium rounded-md transition-colors border",
                      empTypeFilter === key
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Nur mit Warnungen */}
              <button
                onClick={() => setOnlyWithWarnings(v => !v)}
                className={cn(
                  "w-full flex items-center gap-1.5 h-6 px-2 text-[11px] font-medium rounded-md transition-colors border",
                  onlyWithWarnings
                    ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-950/40 dark:text-red-400 dark:border-red-700"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <TriangleAlert className="h-3 w-3 shrink-0" />
                Nur mit Warnungen
                {onlyWithWarnings && patternWarnings.length > 0 && (
                  <span className="ml-auto text-[10px] font-bold">
                    {filteredEmployees.filter(e => patternWarnings.some(w => w.empId === e.id)).length}
                  </span>
                )}
              </button>

              {/* Employee multi-select — inline search + checklist */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-medium text-muted-foreground">Mitarbeiter</p>
                  {selectedEmployeeIds.length > 0 ? (
                    <button
                      className="text-[10px] text-primary hover:underline"
                      onClick={() => { setSelectedEmployeeIds([]); setSidebarEmpSearch(''); }}
                    >
                      Alle anzeigen
                    </button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground/60">alle</span>
                  )}
                </div>
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                  <Input
                    placeholder="Suchen…"
                    value={sidebarEmpSearch}
                    onChange={e => setSidebarEmpSearch(e.target.value)}
                    className="h-6 text-[11px] pl-6 pr-2 rounded"
                  />
                </div>
                {/* Employee list */}
                <div className="max-h-44 overflow-y-auto space-y-0.5 rounded border border-border/50 bg-background p-1">
                  {(() => {
                    const searchLower = sidebarEmpSearch.toLowerCase();
                    const opts = dropdownEmployeeOptions.filter(e =>
                      !searchLower || getEmployeeDisplayName(e).toLowerCase().includes(searchLower)
                    );
                    if (opts.length === 0) {
                      return <p className="text-[11px] text-muted-foreground text-center py-2">Keine Treffer</p>;
                    }
                    return opts.map(e => {
                      const checked = selectedEmployeeIds.includes(e.id);
                      return (
                        <label
                          key={e.id}
                          className="flex items-center gap-1.5 px-1 py-1 rounded hover:bg-muted cursor-pointer select-none"
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
                          <span className="text-[11px] truncate leading-tight">{getEmployeeDisplayName(e)}</span>
                        </label>
                      );
                    });
                  })()}
                </div>
                {selectedEmployeeIds.length > 0 && (
                  <p className="text-[10px] text-primary font-medium text-center">
                    {selectedEmployeeIds.length} ausgewählt
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* ── Controlling — KPIs ─────────────────────────────── */}
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

          {/* ── Zielwerte ──────────────────────────────────────── */}
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

          {/* ── Smart Hinweise ─────────────────────────────────── */}
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
                  {gesamtCostRatioStatus === 'high' && gesamtCostRatio !== null && (
                    <div className="flex items-start gap-1.5 text-[10px] text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded px-1.5 py-1">
                      <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span>PKQ {gesamtCostRatio.toFixed(1)} % über Ziel ({laborCostThreshold} %)</span>
                    </div>
                  )}
                  {overhoursEmployees.slice(0, 3).map(({ employee, difference }) => (
                    <div key={employee.id} className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded px-1.5 py-1">
                      <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="truncate">{getEmployeeDisplayName(employee)} +{difference.toFixed(1)} h</span>
                    </div>
                  ))}
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

        </div>

      </aside>
      )} {/* end legendSidebarOpen */}

      {/* MAIN CONTENT: scrollable, fills remaining width */}
      <div className="flex-1 min-w-0 overflow-auto">
      <main className="max-w-[1800px] mx-auto w-full px-4 pt-2 pb-8">
        <div className="flex flex-col gap-2">

          {/* ══════════════ MAIN CONTENT ══════════════ */}
          <div className="flex flex-col gap-2">

            {/* ── Active employee-filter banner ───────────────────────── */}
          {selectedEmployeeIds.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/5 text-xs">
              <Users className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="flex-1 font-medium text-primary">
                {selectedEmployeeIds.length === 1
                  ? `1 Mitarbeiter ausgewählt`
                  : `${selectedEmployeeIds.length} Mitarbeiter ausgewählt`}
              </span>
              <button
                onClick={() => { setSelectedEmployeeIds([]); setSidebarEmpSearch(''); }}
                className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 shrink-0"
                title="Filter zurücksetzen"
              >
                <X className="h-3.5 w-3.5" />
                <span className="hidden sm:inline text-[11px]">zurücksetzen</span>
              </button>
            </div>
          )}

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
                {/* Sticky-Header-Toggle — Datum/Wochentag-Zeile fixieren */}
                {scheduleMode === 'plan' && (
                  <Button
                    variant={stickyHeader ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      const next = !stickyHeader;
                      setStickyHeader(next);
                      localStorage.setItem('schedule-sticky-header', String(next));
                    }}
                    className="h-7 gap-1"
                    title={stickyHeader ? 'Datum-Zeile lösen (scrollt mit)' : 'Datum-Zeile fixieren (bleibt beim Scrollen sichtbar)'}
                  >
                    {stickyHeader ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
                    <span className="hidden sm:inline text-xs">{stickyHeader ? 'Fixiert' : 'Fixieren'}</span>
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
            {scheduleSource !== 'loading' && loadedEntryCount === 0 && displayEmployees.length > 0 && !dataLoading && (
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
            <div className="relative group/scrollwrap">
              {/* ── Scroll-Pfeile links / rechts ───────────────────────────── */}
              <button
                aria-label="Links scrollen"
                onMouseDown={() => startScroll('left')}
                onMouseUp={stopScroll}
                onMouseLeave={stopScroll}
                className={[
                  "absolute left-1 top-1/2 -translate-y-1/2 z-30",
                  "h-10 w-10 flex items-center justify-center",
                  "rounded-full bg-background/90 border border-border shadow-md",
                  "text-foreground opacity-0 group-hover/scrollwrap:opacity-100",
                  "transition-opacity duration-200 hover:bg-muted cursor-pointer",
                  "select-none",
                ].join(' ')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <button
                aria-label="Rechts scrollen"
                onMouseDown={() => startScroll('right')}
                onMouseUp={stopScroll}
                onMouseLeave={stopScroll}
                className={[
                  "absolute right-1 top-1/2 -translate-y-1/2 z-30",
                  "h-10 w-10 flex items-center justify-center",
                  "rounded-full bg-background/90 border border-border shadow-md",
                  "text-foreground opacity-0 group-hover/scrollwrap:opacity-100",
                  "transition-opacity duration-200 hover:bg-muted cursor-pointer",
                  "select-none",
                ].join(' ')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              </button>

            <div ref={scheduleGridRef} className="overflow-x-auto px-6 pb-4">
              {calendarView === 'day' && displayDays[0] ? (
                // ── Mobile Tagesansicht ────────────────────────────────────
                <MobileDayView
                  employees={displayEmployees}
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
                  dailyBudgets={dailyBudgets}
                  daysInMonth={daysInMonth.length}
                />
              ) : scheduleMode === 'compare' ? (
                // ── Plan/Ist-Vergleich ─────────────────────────────────────
                <>
                  <PlanVsIstGrid
                    employees={displayEmployees}
                    days={displayDays}
                    scheduleData={scheduleData}
                    actualHoursData={actualHoursData}
                  />
                  <PlanVsIstTable
                    employees={displayEmployees}
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
                          employees={roleScopedEmployees}
                          scheduleData={scheduleData}
                          displayDays={displayDays}
                          department="service"
                        />
                        <StaffingStatusBar
                          targets={staffingTargets}
                          employees={roleScopedEmployees}
                          scheduleData={scheduleData}
                          displayDays={displayDays}
                          department="küche"
                        />
                      </div>
                    )}
                    {calendarView === 'week' && activeDepartment !== 'all' && (
                      <StaffingStatusBar
                        targets={staffingTargets}
                        employees={roleScopedEmployees}
                        scheduleData={scheduleData}
                        displayDays={displayDays}
                        department={activeDepartment as 'service' | 'küche'}
                      />
                    )}
                    {/* ── Multi-plan active bar ────────────────────── */}
                    {multiPlanMode && (
                      <div className="mb-2 flex items-center gap-2 flex-wrap rounded-lg border-2 border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-900/20 px-3 py-1.5">
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Wand2 className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                          <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">Mehrfach planen</span>
                          {multiPlanPreset ? (
                            <span className="ml-1 px-1.5 py-0.5 rounded text-[11px] bg-violet-600 text-white font-medium">{multiPlanPreset.label}</span>
                          ) : (
                            <span className="text-[11px] text-violet-500 italic">— Schicht wählen ↓</span>
                          )}
                        </div>
                        <div className="flex-1 flex flex-wrap gap-1">
                          {quickPresets.map(p => (
                            <button
                              key={p.id}
                              onClick={() => setMultiPlanPreset({ id: p.id, label: p.label, start: p.start, end: p.end, start2: p.start2, end2: p.end2 })}
                              className={cn(
                                "px-2 py-0.5 text-[11px] rounded border font-medium transition-all",
                                multiPlanPreset?.id === p.id
                                  ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                                  : "bg-background border-border text-foreground hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30",
                              )}
                            >{p.label}</button>
                          ))}
                          <div className="w-px h-4 bg-border/60 self-center mx-0.5" />
                          {([
                            { id: 'abs-F', label: 'Frei', absenceCode: 'F' },
                            { id: 'abs-FE', label: 'Ferien', absenceCode: 'FE' },
                            { id: 'abs-K', label: 'Krank', absenceCode: 'K' },
                            { id: 'abs-U', label: 'Unfall', absenceCode: 'U' },
                          ] as const).map(a => (
                            <button
                              key={a.id}
                              onClick={() => setMultiPlanPreset({ id: a.id, label: a.label, start: '', end: '', absenceCode: a.absenceCode })}
                              className={cn(
                                "px-2 py-0.5 text-[11px] rounded border font-medium transition-all",
                                multiPlanPreset?.id === a.id
                                  ? "bg-violet-600 text-white border-violet-600 shadow-sm"
                                  : "bg-background border-border text-foreground hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30",
                              )}
                            >{a.label}</button>
                          ))}
                        </div>
                        <button
                          onClick={() => { setMultiPlanMode(false); setMultiPlanPreset(null); }}
                          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 transition-colors"
                        >
                          <X className="h-3 w-3" />Fertig
                        </button>
                      </div>
                    )}

                    <ModernScheduleGrid
                        employees={displayEmployees}
                        days={displayDays}
                        scheduleData={scheduleData}
                        onSlotChange={handleSlotChange}
                        getEmployeeHours={calculateEmployeeHours}
                        getTargetHours={getMonthlyTargetHours}
                        getWeeklyHours={calculateWeeklyHours}
                        getWeeklyTargetHours={getWeeklyTargetHours}
                        patternWarnings={patternWarnings}
                        copiedShift={copiedShift}
                        onCopyShift={handleCopyShift}
                        cellColors={cellColors}
                        onCellColorChange={handleCellColorChange}
                        showDepartmentBadge={activeDepartment === 'all'}
                        onCopyToIst={handleCopyPlanToIst}
                        onEmployeeClick={setEmployeeDetailEmp}
                        onConfigureDaysOff={handleConfigureDaysOff}
                        externalActiveTool={paintTool}
                        highlightedEmployeeId={highlightedEmpId}
                        copiedCell={copiedCell}
                        onCopyCell={handleCopyCell}
                        onPasteCell={handlePasteCell}
                        onClearCell={handleClearCell}
                        onCopyWeek={handleCopyWeek}
                        onPasteWeek={handlePasteWeek}
                        hasCopiedWeek={!!copiedWeek}
                        multiPlanMode={multiPlanMode}
                        multiPlanPreset={multiPlanPreset ?? undefined}
                        onMultiPlanCell={handleMultiPlanCell}
                        stickyHeader={stickyHeader}
                        onAdditionalCostPlanChange={handleAdditionalCostPlanChange}
                        managerSafeTotals={isKuecheManager}
                        dailyManagerTotals={dailyManagerTotals}
                        dayStaffingSummaries={dayStaffingSummaries}
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
                    <MirusReconcileImportButton
                      employees={roleScopedEmployees}
                      actualHoursData={actualHoursData}
                      currentMonth={currentMonth}
                      onCellChange={handleActualHoursChange}
                      onErfassungsartPersisted={(updates) => {
                        setEmployees(prev => prev.map(e =>
                          updates[e.id] ? { ...e, erfassungsart: updates[e.id] } : e));
                      }}
                    />
                  </div>

                  <ActualHoursGrid
                    employees={displayEmployees}
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
            </div> {/* end relative group/scrollwrap */}
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
                      {hasActualHours ? CHF.format(showInsuranceCosts ? totalActualLaborCostWithInsurance : totalActualLaborCost) : '–'}
                    </span>
                  </div>
                  {showInsuranceCosts && hasActualHours && insuranceCostOffset > 0 && (
                    <div className="flex justify-between items-baseline text-amber-700 dark:text-amber-400">
                      <span className="text-xs">K/U Versicherung −20%</span>
                      <span className="text-xs font-medium tabular-nums">
                        {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0, signDisplay: 'always' }).format(-insuranceCostOffset)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Differenz</span>
                    {(() => {
                      const effCost = showInsuranceCosts ? totalActualLaborCostWithInsurance : totalActualLaborCost;
                      const diff = effCost - sollPK;
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

              {/* Lohnkosten Versicherung (K/U zu 80%) – nur sichtbar wenn Toggle aktiv */}
              {showInsuranceCosts && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-4">
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-3">🛡 Lohnkosten Versicherung</p>
                  <div className="space-y-2">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-muted-foreground">K/U Lohnkosten (100%)</span>
                      <span className="text-sm font-medium tabular-nums">
                        {hasActualHours && totalKrankUnfallLaborCost > 0 ? CHF.format(totalKrankUnfallLaborCost) : '–'}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline text-amber-700 dark:text-amber-400">
                      <span className="text-sm">Versicherungsersatz (20%)</span>
                      <span className="text-sm font-medium tabular-nums">
                        {hasActualHours && insuranceCostOffset > 0
                          ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0, signDisplay: 'always' }).format(-insuranceCostOffset)
                          : '–'}
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline border-t border-amber-200 dark:border-amber-800 pt-2 mt-1">
                      <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">Effektiv (80%)</span>
                      <span className="text-base font-bold tabular-nums text-amber-800 dark:text-amber-300">
                        {hasActualHours && totalKrankUnfallLaborCost > 0 ? CHF.format(totalKrankUnfallLaborCost * 0.8) : '–'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

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
                    <span className="text-sm text-muted-foreground">
                      Ist<span className="ml-1 text-muted-foreground text-[10px]">(nur Tage mit Ist-Umsatz)</span>
                    </span>
                    <span className={cn(
                      "text-base font-bold tabular-nums",
                      actualCostRatio === null                                  ? "text-muted-foreground" :
                      actualCostRatio <= laborCostThreshold            ? "text-green-600" :
                      actualCostRatio <= laborCostThreshold + 5        ? "text-yellow-600" : "text-red-600"
                    )}>
                      {actualCostRatio !== null ? `${actualCostRatio.toFixed(1)} %` : '–'}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline border-t pt-2 mt-1">
                    <span className="text-sm text-muted-foreground">Ziel</span>
                    <span className="text-base font-bold tabular-nums">{laborCostThreshold} %</span>
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
                        <th className="text-right px-3 py-2 font-semibold text-xs" title={EMPLOYER_COST_INFO.total}>Kosten Soll (Total AG)</th>
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
                        const hrRate = agRate(emp);
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
            roleScopedEmployees.map(emp => [
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
                Mitarbeiter ({roleScopedEmployees.length})
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
                    {roleScopedEmployees.map((employee) => (
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
      </div> {/* end overflow-auto */}
      </div> {/* end flex body row */}

      {/* Copy Week Dialog */}
      <CopyWeekDialog
        open={copyWeekDialogOpen}
        onOpenChange={setCopyWeekDialogOpen}
        currentMonth={currentMonth}
        currentWeekStart={weeksInMonth[selectedWeekIndex] ?? weeksInMonth[0]}
        scheduleData={scheduleData}
        employeeIds={displayEmployees.map(e => e.id)}
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
        employees={displayEmployees}
        days={daysInMonth}
        scheduleData={scheduleData}
        currentMonth={currentMonth}
        department={activeDepartment}
        cellColors={cellColors}
      />

      {/* Personalbedarf-Abgleich (SOLL-Besetzung vs. eingeplante Mitarbeitende) */}
      <StaffingComparisonPanel
        employees={roleScopedEmployees}
        scheduleData={scheduleData}
        initialDate={displayDays[0] ?? selectedDay ?? new Date()}
        departments={comparisonDepartments}
        season={staffingSeason}
        onSeasonChange={setStaffingSeason}
      />

      {/* Day Detail Dialog (Plan view) */}
      <DayDetailDialog
        open={dayDetailDialogOpen}
        onOpenChange={setDayDetailDialogOpen}
        date={selectedDay}
        employees={roleScopedEmployees}
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
        employees={roleScopedEmployees}
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
        activeDepartment={activeDepartment}
        lockDepartment={!canSwitchDepartment}
      />

      <ImportMatchPreviewDialog
        open={importPreviewOpen}
        onOpenChange={setImportPreviewOpen}
        nameMatches={pendingImportResult?.nameMatches || []}
        existingEmployees={roleScopedEmployees}
        onConfirm={handleConfirmImport}
        onCancel={handleCancelImport}
      />


      <PlanningAssistant
        open={planningAssistantOpen}
        onClose={() => setPlanningAssistantOpen(false)}
        employees={roleScopedEmployees}
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
        employees={roleScopedEmployees}
        scheduleData={scheduleData}
        actualHoursData={actualHoursData}
        currentMonth={currentMonth}
        onApply={handleApplyTemplate}
        onApplyActual={handleBulkApplyActual}
      />

      <TimeSlotStaffingDialog
        open={timeSlotStaffingOpen}
        onClose={() => setTimeSlotStaffingOpen(false)}
        employees={roleScopedEmployees}
        actualHoursData={actualHoursData}
        scheduleData={scheduleData}
        currentMonth={currentMonth}
        daysInMonth={daysInMonth}
      />

      <TemplateManagerDialog
        open={templateDialogOpen}
        onClose={() => setTemplateDialogOpen(false)}
        employees={roleScopedEmployees}
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
        employees={roleScopedEmployees}
        onEmployeeUpdated={handleStationEmployeeUpdated}
      />

      <AvailabilityDialog
        open={availabilityOpen}
        onClose={() => setAvailabilityOpen(false)}
        employees={roleScopedEmployees}
        initialMonth={currentMonth}
      />

      <KüchenplanImportDialog
        open={küchenplanImportOpen}
        onClose={() => setKüchenplanImportOpen(false)}
        employees={roleScopedEmployees}
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

      {/* ── Dienstplan Veröffentlichen Dialog ───────────────────────────── */}
      <ErrorBoundary
        label="Teilen-Dialog"
        fallback={
          <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
            <DialogContent className="sm:max-w-[420px]">
              <div className="p-6 space-y-4 text-center">
                <div className="text-4xl">⚠️</div>
                <p className="text-sm font-semibold text-destructive">Teilen konnte nicht geladen werden</p>
                <p className="text-xs text-muted-foreground">Ein Fehler ist aufgetreten. Bitte schliessen oder neu laden.</p>
                <div className="flex justify-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPublishDialogOpen(false)}>Schliessen</Button>
                  <Button size="sm" onClick={() => window.location.reload()}>Neu laden</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        }
      >
      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-emerald-600" />
              Dienstplan teilen
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-1">

            {/* ── Safe Mode notice + global error banner ───────────────── */}
            {SAFE_PUBLISH_MODE && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>Safe Mode aktiv – nur lokaler Link, kein Supabase.</span>
              </div>
            )}
            {lastGlobalError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold mb-0.5">Letzter Fehler (Crash-Log):</p>
                  <p className="font-mono break-all leading-snug">{lastGlobalError}</p>
                </div>
                <button className="shrink-0 text-destructive/60 hover:text-destructive text-base leading-none" onClick={() => setLastGlobalError(null)}>×</button>
              </div>
            )}

            {/* ── Status ──────────────────────────────────────────────── */}
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center shrink-0",
                publishStatus === 'published' ? "bg-emerald-100 dark:bg-emerald-950/40" :
                publishStatus === 'changed'   ? "bg-amber-100 dark:bg-amber-950/40" :
                "bg-muted"
              )}>
                {publishStatus === 'published' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                ) : publishStatus === 'changed' ? (
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Share2 className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {publishStatus === 'published' ? 'Veröffentlicht' :
                   publishStatus === 'changed'   ? 'Nicht aktuell – Änderungen vorhanden' :
                   'Noch nicht veröffentlicht'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {publishStatus === 'published'
                    ? `Link aktiv · ${pkqPeriodLabel}${publishRevision > 0 ? ` · Revision ${publishRevision}` : ''}`
                    : publishStatus === 'changed'
                    ? 'Bitte erneut veröffentlichen um den Link zu aktualisieren'
                    : 'Erstelle einen Link damit Mitarbeitende den Plan einsehen können'}
                </p>
                {publishUpdatedAt && (
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    Zuletzt aktualisiert: {format(new Date(publishUpdatedAt), 'd. MMM yyyy · HH:mm', { locale: de })} Uhr
                  </p>
                )}
              </div>
            </div>

            {/* ── Veröffentlichungsart ─────────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Veröffentlichungsart</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setPublishType('department')}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                    publishType === 'department'
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border bg-background hover:bg-muted/40 text-foreground"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <span className="text-sm font-semibold">Abteilungsplan</span>
                  </div>
                  <span className="text-xs text-muted-foreground leading-snug">
                    Alle Mitarbeitenden einer Abteilung
                  </span>
                </button>
                <div
                  className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left opacity-45 cursor-not-allowed border-border bg-background text-muted-foreground select-none"
                  title="Persönliche Links sind in Vorbereitung"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <User className="h-4 w-4" />
                    <span className="text-sm font-semibold">Persönlicher Plan</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-muted border border-border/60 text-muted-foreground leading-none">Kommt später</span>
                  </div>
                  <span className="text-xs text-muted-foreground leading-snug">
                    Nur ein Mitarbeiter sieht seinen Plan
                  </span>
                </div>
              </div>
            </div>

            {/* ── Abteilungsauswahl ────────────────────────────────────── */}
            {publishType === 'department' && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Abteilung</p>
                <div className="flex gap-2">
                  {(['all', 'service', 'küche'] as const).map(d => (
                    <Button
                      key={d}
                      size="sm"
                      variant={publishDept === d ? 'default' : 'outline'}
                      className="flex-1 h-8 text-xs"
                      onClick={() => setPublishDept(d)}
                    >
                      {d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche'}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Mitarbeiterauswahl ───────────────────────────────────── */}
            {publishType === 'personal' && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mitarbeiter</p>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border/50">
                  {roleScopedEmployees.filter(e => isEmployeeActiveInMonth(e, currentMonth)).map(emp => {
                    const name = getEmployeeDisplayName(emp);
                    const sel = publishEmpId === emp.id;
                    return (
                      <button
                        key={emp.id}
                        type="button"
                        onClick={() => setPublishEmpId(emp.id)}
                        className={cn(
                          "w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors text-sm",
                          sel ? "bg-primary/8 text-primary font-semibold" : "bg-background hover:bg-muted/40"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <div className={cn(
                            "w-2 h-2 rounded-full shrink-0",
                            emp.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                          )} />
                          <span>{name}</span>
                        </div>
                        {sel && <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Änderungsübersicht ───────────────────────────────────── */}
            {publishType === 'department' && (() => {
              const days = displayDays.length > 0 ? displayDays : [currentMonth];
              const isSameWeek = existingPublishedPayload?.weekStart === format(days[0], 'yyyy-MM-dd');

              const fmtSlot = (s: { start: string; end: string } | null) =>
                s ? `${s.start}–${s.end}` : null;
              const fmtSide = (
                früh: { start: string; end: string } | null,
                spät: { start: string; end: string } | null,
                frühA: string | null,
                spätA: string | null,
              ) => {
                const parts: string[] = [];
                if (frühA) parts.push(frühA); else if (früh) parts.push(fmtSlot(früh)!);
                if (spätA) parts.push(spätA); else if (spät) parts.push(fmtSlot(spät)!);
                return parts.length > 0 ? parts.join(' / ') : 'Kein Dienst';
              };

              // Group filtered entries by employee for display
              const byEmp = publishDiffFiltered.reduce<
                Record<string, { name: string; dept: string; rows: typeof publishDiffFiltered }>
              >((acc, e) => {
                if (!acc[e.empId]) acc[e.empId] = { name: e.empName, dept: e.department, rows: [] };
                acc[e.empId].rows.push(e);
                return acc;
              }, {});

              return (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex-1">
                      Änderungen seit letzter Veröffentlichung
                    </p>
                    {diffLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
                  </div>

                  {/* No existing publish yet */}
                  {!existingPublishedPayload && !diffLoading && (
                    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                      Noch kein veröffentlichter Plan für diesen Teamlink.
                    </div>
                  )}

                  {/* Different week — just note it, no line-by-line diff */}
                  {existingPublishedPayload && !isSameWeek && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20 px-3 py-2.5 text-xs text-blue-700 dark:text-blue-400 flex items-center gap-2">
                      <Info className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        Letzte Veröffentlichung: <strong>{existingPublishedPayload.weekLabel}</strong>.
                        Veröffentlichen ersetzt diesen Plan.
                      </span>
                    </div>
                  )}

                  {/* Same week — show full diff */}
                  {existingPublishedPayload && isSameWeek && (
                    <>
                      {publishDiffAll.length === 0 ? (
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          Keine Änderungen seit letzter Veröffentlichung.
                        </div>
                      ) : (
                        <>
                          {/* Summary row + dept filter */}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 rounded-full shrink-0">
                              {publishDiffAffectedEmps} {publishDiffAffectedEmps === 1 ? 'Person' : 'Personen'}
                              {' · '}
                              {publishDiffAll.length} {publishDiffAll.length === 1 ? 'Tag' : 'Tage'}
                            </span>
                            <div className="flex items-center gap-1">
                              {(['all', 'service', 'küche'] as const).map(f => (
                                <button
                                  key={f}
                                  onClick={() => setDiffFilter(f)}
                                  className={cn(
                                    'px-2 py-0.5 rounded text-[10px] font-semibold transition-colors',
                                    diffFilter === f
                                      ? 'bg-primary text-primary-foreground'
                                      : 'bg-muted text-muted-foreground hover:bg-muted/70',
                                  )}
                                >
                                  {f === 'all' ? 'Alle' : f === 'service' ? 'Service' : 'Küche'}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Grouped change list */}
                          <div className="rounded-lg border border-amber-200 dark:border-amber-800 divide-y divide-amber-100 dark:divide-amber-900/40 max-h-52 overflow-y-auto bg-amber-50/30 dark:bg-amber-950/10">
                            {Object.entries(byEmp).map(([empId, { name, dept, rows }]) => (
                              <div key={empId} className="px-3 py-2">
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className={cn(
                                    'w-1.5 h-1.5 rounded-full shrink-0',
                                    dept === 'service' ? 'bg-blue-500' : 'bg-orange-500',
                                  )} />
                                  <p className="text-[11px] font-semibold text-foreground">{name}</p>
                                </div>
                                <div className="space-y-0.5 pl-3">
                                  {rows.map((row, i) => (
                                    <p key={i} className="text-[10px] leading-snug">
                                      <span className="font-medium text-muted-foreground">{row.dayLabel}: </span>
                                      <span className="line-through text-muted-foreground/55">
                                        {fmtSide(row.prevFrüh, row.prevSpät, row.prevFrühAbsence, row.prevSpätAbsence)}
                                      </span>
                                      <span className="mx-1 text-amber-600 font-bold">→</span>
                                      <span className="font-semibold text-foreground">
                                        {fmtSide(row.newFrüh, row.newSpät, row.newFrühAbsence, row.newSpätAbsence)}
                                      </span>
                                    </p>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* ── Hinweis an Mitarbeiter ───────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Hinweis an Mitarbeiter <span className="normal-case font-normal">(optional)</span>
              </p>
              <textarea
                value={managerNote}
                onChange={e => setManagerNote(e.target.value)}
                placeholder="z.B. Terrasse bei schönem Wetter · Freitag Event im Saal · Bitte 15 Min früher kommen"
                rows={2}
                className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {/* ── Benachrichtigen via ───────────────────────────────────── */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Benachrichtigen via</p>
              <div className="flex flex-wrap gap-2">
                {(['whatsapp', 'sms', 'push', 'email'] as const).map(ch => {
                  const labels: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', push: 'Push', email: 'E-Mail' };
                  const activeColors: Record<string, string> = {
                    whatsapp: 'border-green-400 text-green-700 bg-green-50 dark:border-green-600 dark:text-green-400 dark:bg-green-950/30',
                    sms:      'border-blue-400 text-blue-700 bg-blue-50 dark:border-blue-600 dark:text-blue-400 dark:bg-blue-950/30',
                    push:     'border-violet-400 text-violet-700 bg-violet-50 dark:border-violet-600 dark:text-violet-400 dark:bg-violet-950/30',
                    email:    'border-slate-400 text-slate-700 bg-slate-50 dark:border-slate-500 dark:text-slate-300 dark:bg-slate-800/40',
                  };
                  return (
                    <button
                      key={ch}
                      onClick={() => setNotifyChannels(c => ({ ...c, [ch]: !c[ch] }))}
                      className={cn(
                        'h-7 px-3 rounded-full text-xs font-semibold border transition-all',
                        notifyChannels[ch] ? activeColors[ch] : 'border-border text-muted-foreground hover:bg-muted/50',
                      )}
                    >
                      {labels[ch]}
                    </button>
                  );
                })}
              </div>
              {Object.values(notifyChannels).some(Boolean) && (
                <p className="text-[11px] text-muted-foreground/60">Benachrichtigung-Integration folgt in Kürze.</p>
              )}
            </div>

            {/* ── Stabiler Teamlink ────────────────────────────────────── */}
            {(() => {
              const previewToken = stablePublishToken(tenantId, publishDept);
              const previewUrl   = `${getPublicBaseUrl()}/staff-schedule/${previewToken}`;
              const isLive       = publishStatus === 'published' || publishStatus === 'changed';

              const _days        = displayDays.length > 0 ? displayDays : [currentMonth];
              const _period      = _days.length <= 7 ? 'week' : 'month';
              const _kw          = getISOWeek(_days[0]);
              const _periodLabel = _period === 'month'
                ? format(_days[0], 'MMMM yyyy', { locale: de })
                : `KW ${_kw}`;

              // WhatsApp: update message for re-publishes, intro message for first publish
              const _kwLabel     = _period === 'week' ? `KW ${_kw}` : _periodLabel;
              const waUpdateText = `Hallo zusammen,\nder Dienstplan wurde aktualisiert. Bitte prüft die Änderungen nochmals:\n${previewUrl}`;
              const waFirstText  = `Hallo zusammen,\nhier ist der Dienstplan für ${_kwLabel}:\n${previewUrl}`;
              const waText       = publishRevision > 1 ? waUpdateText : waFirstText;

              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Stabiler Teamlink</p>
                    {isLive && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                        Live
                      </span>
                    )}
                  </div>

                  {/* URL row */}
                  <div className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
                    isLive
                      ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20"
                      : "border-border bg-muted/30 opacity-60"
                  )}>
                    <span className="flex-1 min-w-0 text-xs font-mono truncate text-foreground select-all">
                      {previewUrl}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 shrink-0"
                      disabled={!isLive}
                      onClick={() => {
                        navigator.clipboard.writeText(previewUrl);
                        setPublishCopied(true);
                        setTimeout(() => setPublishCopied(false), 2000);
                      }}
                    >
                      {publishCopied
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                    </Button>
                  </div>

                  {/* Hint: save to home screen */}
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Dieser Link bleibt immer gleich. Mitarbeitende speichern ihn einmal auf dem Homebildschirm — er zeigt stets den aktuell veröffentlichten Plan.
                  </p>

                  {/* Action buttons — only when live */}
                  {isLive && (
                    <div className="flex flex-wrap items-center gap-2">
                      {/* WhatsApp — primary CTA for re-publishes */}
                      <Button
                        size="sm"
                        variant="outline"
                        className={cn(
                          "h-7 gap-1.5 text-xs",
                          publishRevision > 1
                            ? "border-green-500 text-green-700 bg-green-50 hover:bg-green-100 dark:border-green-600 dark:text-green-400 dark:bg-green-950/30 font-semibold"
                            : "border-green-400 text-green-700 hover:bg-green-50 dark:border-green-700 dark:text-green-400"
                        )}
                        onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(waText)}`, '_blank')}
                      >
                        <MessageCircle className="h-3 w-3" />
                        {publishRevision > 1 ? 'Änderungsmitteilung teilen' : 'WhatsApp'}
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 text-xs text-muted-foreground"
                        onClick={() => window.open(previewUrl, '_blank')}
                      >
                        <Eye className="h-3 w-3" />
                        Vorschau
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 text-xs border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400"
                        onClick={() => setMobilePreviewUrl(previewUrl)}
                      >
                        <Smartphone className="h-3 w-3" />
                        Handy
                      </Button>

                      {!SAFE_PUBLISH_MODE && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-xs"
                          onClick={() => setShowQr(v => !v)}
                        >
                          <QrCode className="h-3 w-3" />
                          QR
                        </Button>
                      )}
                    </div>
                  )}

                  {/* QR Code */}
                  {isLive && !SAFE_PUBLISH_MODE && showQr && (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(previewUrl)}`}
                        alt="QR-Code"
                        width={160}
                        height={160}
                        className="rounded border border-border/50 shadow-sm bg-white"
                      />
                      <p className="text-[11px] text-muted-foreground text-center">
                        {publishDept === 'all' ? 'Team' : publishDept === 'service' ? 'Service' : 'Küche'} · {_periodLabel}
                      </p>
                    </div>
                  )}

                  {/* WhatsApp text preview — always shown when live */}
                  {isLive && (
                    <div className="rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-3 py-2 text-xs text-green-800 dark:text-green-300">
                      <p className="font-semibold mb-0.5">
                        {publishRevision > 1 ? 'Änderungsmitteilung:' : 'WhatsApp-Text:'}
                      </p>
                      <p className="leading-snug whitespace-pre-line">{waText}</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── Info note ────────────────────────────────────────────── */}
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2.5 text-xs text-blue-700 dark:text-blue-400 flex items-start gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Der Link gibt den Dienstplan <strong>ohne Lohnangaben</strong> frei. Mitarbeitende sehen nur Namen und Schichtzeiten.
              </span>
            </div>

          </div>

          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Button variant="outline" onClick={() => setPublishDialogOpen(false)} className="sm:mr-auto">
              Schliessen
            </Button>
            <Button
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
              disabled={isPublishing}
              onClick={publishSchedule}
            >
              {isPublishing
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird veröffentlicht…</>
                : publishDiffAll.length > 0
                  ? <><Globe className="h-3.5 w-3.5" /> Änderungen veröffentlichen ({publishDiffAll.length})</>
                  : publishStatus === 'published' || publishStatus === 'changed'
                    ? <><Globe className="h-3.5 w-3.5" /> Erneut veröffentlichen</>
                    : <><Globe className="h-3.5 w-3.5" /> Veröffentlichen</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </ErrorBoundary>

      {/* ── Feedback Inbox Dialog ────────────────────────────────────── */}
      <Dialog open={feedbackInboxOpen} onOpenChange={setFeedbackInboxOpen}>
        <DialogContent className="sm:max-w-[560px] max-h-[85vh] flex flex-col p-0 gap-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-border/60 shrink-0">
            <div className="flex items-center gap-2.5">
              <Bell className="h-4 w-4 text-primary" />
              <div>
                <h2 className="text-base font-bold text-foreground leading-tight">
                  Rückmeldungen
                  {feedbackNewCount > 0 && (
                    <span className="ml-2 text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">
                      {feedbackNewCount} neu
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-muted-foreground">Wünsche und Hinweise vom Mitarbeiterportal</p>
              </div>
            </div>
            <Button
              variant="ghost" size="sm"
              onClick={() => void loadFeedbackItems()}
              disabled={feedbackLoading}
              className="h-7 gap-1.5 text-xs"
            >
              {feedbackLoading
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <RefreshCw className="h-3 w-3" />}
              Aktualisieren
            </Button>
          </div>

          {/* Filter pills */}
          <div className="px-5 py-2.5 border-b border-border/40 flex items-center gap-1.5 shrink-0 flex-wrap">
            {([
              { id: 'all',         label: `Alle (${feedbackItems.length})` },
              { id: 'new',         label: `Neu (${feedbackItems.filter(f => f.status === 'new').length})` },
              { id: 'in_progress', label: 'In Bearbeitung' },
              { id: 'done',        label: 'Erledigt' },
            ] as const).map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setFeedbackStatusFilter(id)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors',
                  feedbackStatusFilter === id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2.5 min-h-0">
            {feedbackError && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive flex items-center justify-between gap-3">
                <span>{feedbackError}</span>
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => void loadFeedbackItems()}>
                  Erneut versuchen
                </Button>
              </div>
            )}
            {!feedbackLoading && !feedbackError && feedbackFiltered.length === 0 && (
              <div className="text-center py-10 space-y-2">
                <MessageCircle className="h-8 w-8 text-muted-foreground/25 mx-auto" />
                <p className="text-sm text-muted-foreground/60">
                  {feedbackStatusFilter === 'all'
                    ? 'Noch keine Rückmeldungen.'
                    : 'Keine Einträge in dieser Kategorie.'}
                </p>
              </div>
            )}
            {feedbackFiltered.map(entry => {
              const statusLabel =
                entry.status === 'new'           ? 'Neu'
                : entry.status === 'in_progress' ? 'In Bearbeitung'
                : 'Erledigt';
              const statusCls =
                entry.status === 'new'           ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300'
                : entry.status === 'in_progress' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400';
              return (
                <div
                  key={entry.id}
                  className={cn(
                    'rounded-xl border p-3.5 space-y-2 transition-colors',
                    entry.status === 'new'
                      ? 'border-blue-200 bg-blue-50/40 dark:border-blue-800 dark:bg-blue-950/10'
                      : entry.status === 'in_progress'
                        ? 'border-amber-200 bg-amber-50/30 dark:border-amber-800 dark:bg-amber-950/10'
                        : 'border-border/40 bg-muted/20 opacity-70',
                  )}
                >
                  {/* Top: name + status badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-7 w-7 rounded-full bg-muted/80 flex items-center justify-center shrink-0">
                        <User className="h-3.5 w-3.5 text-muted-foreground/60" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground leading-tight truncate">{entry.employeeName}</p>
                        <p className="text-[10px] text-muted-foreground/60 leading-tight">
                          {entry.date === 'Allgemein' ? 'Ganze Woche' : entry.date}
                        </p>
                      </div>
                    </div>
                    <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0', statusCls)}>
                      {statusLabel}
                    </span>
                  </div>

                  {/* Reason + message */}
                  <div className="pl-9 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <MessageCircle className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                      <p className="text-xs font-semibold text-foreground">{entry.reason}</p>
                    </div>
                    {entry.message && (
                      <p className="text-xs text-muted-foreground leading-relaxed pl-[18px]">{entry.message}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground/50 pl-[18px]">
                      {new Date(entry.createdAt).toLocaleString('de-CH', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </p>
                  </div>

                  {/* Status action buttons */}
                  {entry.status !== 'done' ? (
                    <div className="pl-9 flex items-center gap-1.5 pt-1">
                      {entry.status === 'new' && (
                        <button
                          onClick={() => void handleFeedbackStatusChange(entry, 'in_progress')}
                          className="h-7 px-2.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400 text-[11px] font-semibold hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                        >
                          In Bearbeitung
                        </button>
                      )}
                      <button
                        onClick={() => void handleFeedbackStatusChange(entry, 'done')}
                        className="h-7 px-2.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400 text-[11px] font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors flex items-center gap-1"
                      >
                        <CheckCircle2 className="h-3 w-3" />Erledigt
                      </button>
                    </div>
                  ) : (
                    <div className="pl-9 pt-0.5">
                      <button
                        onClick={() => void handleFeedbackStatusChange(entry, 'new')}
                        className="h-6 px-2 rounded text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        Zurücksetzen
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border/40 shrink-0 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground/50">
              {feedbackItems.length} {feedbackItems.length === 1 ? 'Eintrag' : 'Einträge'} total
              {feedbackByEmpName.size > 0 && ` · ${feedbackByEmpName.size} Mitarbeitende mit Terminwunsch`}
            </p>
            <Button variant="outline" size="sm" onClick={() => setFeedbackInboxOpen(false)}>
              Schliessen
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Mobile preview Dialog ─────────────────────────────────────── */}
      {mobilePreviewUrl && (
        <Dialog open={!!mobilePreviewUrl} onOpenChange={() => setMobilePreviewUrl(null)}>
          <DialogContent className="max-w-[430px] w-full p-0 overflow-hidden bg-background rounded-2xl">
            {/* Title bar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-foreground">Handy-Vorschau</span>
              </div>
              <span className="text-[10px] text-muted-foreground/60 tabular-nums">390 × 844 px</span>
            </div>
            {/* Phone frame */}
            <div className="flex justify-center items-start bg-slate-100 dark:bg-slate-900 py-4 px-3">
              <div className="relative bg-black rounded-[2.4rem] p-[3px] shadow-2xl shadow-black/40" style={{ width: 315 }}>
                {/* Notch */}
                <div className="absolute top-[10px] left-1/2 -translate-x-1/2 w-20 h-5 bg-black rounded-full z-10" />
                {/* Screen */}
                <div className="rounded-[2.1rem] overflow-hidden bg-white" style={{ height: 560 }}>
                  <iframe
                    src={mobilePreviewUrl}
                    title="Handy-Vorschau"
                    className="w-full h-full border-0"
                    style={{ transform: 'scale(0.81)', transformOrigin: 'top left', width: '390px', height: '690px' }}
                  />
                </div>
                {/* Home bar */}
                <div className="flex justify-center pt-1.5 pb-0.5">
                  <div className="w-20 h-1 bg-white/30 rounded-full" />
                </div>
              </div>
            </div>
            <div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground truncate">{mobilePreviewUrl}</span>
              <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={() => setMobilePreviewUrl(null)}>
                Schliessen
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Mitarbeiter Detail Dialog ─────────────────────────────────── */}
      {employeeDetailEmp && (() => {
        const emp = employeeDetailEmp;
        const plannedHrs = calculateEmployeeHours(emp.id);
        const targetHrs = getMonthlyTargetHours(emp);
        const actualHrs = calculateEmployeeActualHours(emp.id);
        const balance = plannedHrs - targetHrs;
        const empWarnings = patternWarnings.filter(w => w.empId === emp.id);
        const lateShifts = daysInMonth.filter(day => {
          const k = `${emp.id}-${format(day, 'yyyy-MM-dd')}`;
          return !!(scheduleData[k]?.spät?.start);
        }).length;
        const absenceDays = { FE: 0, K: 0, U: 0, F: 0 };
        daysInMonth.forEach(day => {
          const entry = actualHoursData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
          if (entry?.absenceType && entry.absenceType in absenceDays) {
            absenceDays[entry.absenceType as keyof typeof absenceDays]++;
          }
        });
        const hourlyRate = agRate(emp);
        const monthlyRate = (emp.monthlySalary ?? 0) > 0 ? agMonthly(emp) : 0;
        const planCost = monthlyRate > 0
          ? monthlyRate
          : plannedHrs * hourlyRate;
        const actualCost = monthlyRate > 0
          ? monthlyRate
          : actualHrs * hourlyRate;
        return (
          <Dialog open={!!employeeDetailEmp} onOpenChange={open => { if (!open) setEmployeeDetailEmp(null); }}>
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className={cn(
                    "w-2.5 h-2.5 rounded-full shrink-0",
                    emp.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                  )} />
                  {getEmployeeDisplayName(emp)}
                </DialogTitle>
                <DialogDescription>
                  {emp.department === 'service' ? 'Service' : 'Küche'} · {emp.employmentType === 'vollzeit' ? 'Vollzeit' : emp.employmentType === 'teilzeit' ? 'Teilzeit' : emp.employmentType === 'aushilfe' ? 'Aushilfe' : emp.employmentType}
                  {emp.weeklyHours ? ` · ${emp.weeklyHours}h/Woche` : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-1">
                {/* Hours */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground mb-0.5">Soll</div>
                    <div className="text-base font-bold tabular-nums">{targetHrs.toFixed(1)}h</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground mb-0.5">Plan</div>
                    <div className="text-base font-bold tabular-nums">{plannedHrs.toFixed(1)}h</div>
                  </div>
                  <div className={cn(
                    "rounded-lg px-3 py-2",
                    balance >= 0 ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-red-50 dark:bg-red-950/30"
                  )}>
                    <div className="text-[11px] text-muted-foreground mb-0.5">Balance</div>
                    <div className={cn(
                      "text-base font-bold tabular-nums",
                      balance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
                    )}>
                      {balance >= 0 ? '+' : ''}{balance.toFixed(1)}h
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Schedule details */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <div className="text-muted-foreground">Ist-Stunden</div>
                  <div className="font-medium tabular-nums text-right">{actualHrs.toFixed(1)}h</div>
                  <div className="text-muted-foreground">Spätdienste</div>
                  <div className="font-medium tabular-nums text-right">{lateShifts}×</div>
                  {absenceDays.FE > 0 && (
                    <>
                      <div className="text-muted-foreground">Ferientage</div>
                      <div className="font-medium tabular-nums text-right">{absenceDays.FE} Tage</div>
                    </>
                  )}
                  {absenceDays.K > 0 && (
                    <>
                      <div className="text-muted-foreground text-red-700 dark:text-red-400">Krankheitstage</div>
                      <div className="font-medium tabular-nums text-right text-red-700 dark:text-red-400">{absenceDays.K} Tage</div>
                    </>
                  )}
                  {absenceDays.U > 0 && (
                    <>
                      <div className="text-muted-foreground text-amber-700 dark:text-amber-400">Unfalltage</div>
                      <div className="font-medium tabular-nums text-right text-amber-700 dark:text-amber-400">{absenceDays.U} Tage</div>
                    </>
                  )}
                  {absenceDays.F > 0 && (
                    <>
                      <div className="text-muted-foreground">Frei-Tage</div>
                      <div className="font-medium tabular-nums text-right">{absenceDays.F} Tage</div>
                    </>
                  )}
                  {effectiveShowCosts && planCost > 0 && (
                    <>
                      <div className="text-muted-foreground">Kosten Plan</div>
                      <div className="font-medium tabular-nums text-right">{formatCurrency(planCost)}</div>
                      <div className="text-muted-foreground">Kosten Ist</div>
                      <div className="font-medium tabular-nums text-right">{formatCurrency(actualCost)}</div>
                    </>
                  )}
                </div>

                {/* Warnings */}
                {empWarnings.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                        <AlertTriangle className="h-3 w-3" />
                        Muster-Warnungen
                      </div>
                      {empWarnings.map((w, i) => (
                        <div key={i} className={cn(
                          "text-xs rounded px-2 py-1.5 leading-snug",
                          w.severity === 'critical'
                            ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400"
                            : "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400"
                        )}>
                          {w.message}
                          {w.detail && <span className="block text-[11px] opacity-70 mt-0.5">{w.detail}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

    </div>
  );
};

export default SchedulePlanner;
