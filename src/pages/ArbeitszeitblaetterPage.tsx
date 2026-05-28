import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  ClipboardCheck, ChevronLeft, ChevronRight, Copy, Link,
  CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw, Trash2,
  Users, Check, Upload, FileSpreadsheet, AlertTriangle, X, Info,
  History, UserPlus, SkipForward, Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { parseMirusExcel, type ExcelEmployee, type ExcelParseStats } from '@/lib/mirus-excel-parser';
import EmployeeDetailView from '@/components/EmployeeDetailView';
import {
  matchEmployeeByName, saveNameMappingsBatch, loadNameMappings,
} from '@/lib/mirus-name-mapping-store';
import { saveActualHourEntry, saveActualHourEntries, upsertEmployee } from '@/lib/supabase-db';
import type { Employee as PersonnelEmployee } from '@/types/personnel';
import {
  getConfirmationsForMonth,
  createOrGetConfirmation,
  deleteConfirmation,
  getActualHoursBatch,
  timesheetPublicUrl,
  MONTH_NAMES_DE,
  saveImportHistory,
  getImportHistoryForMonth,
  upsertEmployeeTimeBalance,
  getEmployeeTimeBalancesForMonth,
  loadDienstplanHoursForMonth,
  parseMirusHoursString,
  type TimesheetConfirmation,
  type TimesheetStatus,
  type ImportHistoryEntry,
  type EmployeeTimeBalance,
} from '@/lib/timesheet-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface Employee {
  id: string;
  name: string;
  department: string;
  weekly_hours: number;
  employment_type: string;
  contract_start?: string | null;
  employment_end_date?: string | null;
  employee_status?: string | null;
}

/**
 * matched      = exact / saved match (grün, kann importiert werden)
 * manual       = manuell via Dropdown zugeordnet (blau, kann importiert werden)
 * conflict     = Vorname-Match, nicht eindeutig — braucht Admin-Bestätigung (amber, BLOCKIERT)
 * unresolved   = kein Match gefunden (rot, BLOCKIERT)
 * new_employee = neuer Mitarbeiter wurde erstellt (violett, kann importiert werden)
 * skipped      = explizit ausgeschlossen (grau, wird übersprungen)
 */
type MatchStatus = 'matched' | 'manual' | 'conflict' | 'unresolved' | 'new_employee' | 'skipped';

interface ImportPreviewRow {
  mirusName: string;
  matchStatus: MatchStatus;
  employee: Employee | null;
  dayCount: number;
  totalHours: number;
  vacationHours: number | null;
  holidayHours: number | null;
  overtimeHours: number | null;
  excEmployee: ExcelEmployee;
  newEmployeeCreated?: boolean;
}

interface NewEmployeeFormData {
  name: string;
  department: 'service' | 'küche';
  employment_type: 'vollzeit' | 'teilzeit' | 'aushilfe' | 'minijob';
  weekly_hours: string;
  contract_start: string;
}

interface RowData {
  employee: Employee;
  confirmation: TimesheetConfirmation | null;
  istHours: number;
  dienstplanHours: number;
  sollHours: number;
  vacationBalance: number | null;
  holidayBalance: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isActiveInMonth(emp: Employee, year: number, month: number): boolean {
  if (emp.employee_status === 'pending_review') return false;
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0);
  if (emp.contract_start && new Date(emp.contract_start) > monthEnd) return false;
  if (emp.employment_end_date && new Date(emp.employment_end_date) < monthStart) return false;
  return true;
}

function sollHoursForMonth(weeklyHours: number, year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.round((weeklyHours / 7) * daysInMonth * 10) / 10;
}

function fmtHours(h: number | null | undefined) {
  if (h == null) return '–';
  return h.toFixed(1) + ' h';
}
function fmtDiff(diff: number) {
  return (diff > 0 ? '+' : '') + diff.toFixed(1) + ' h';
}
function fmtDatetime(iso: string) {
  return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ─── Status-Badge (Bestätigungen) ─────────────────────────────────────────────

const STATUS_META: Record<TimesheetStatus, { label: string; color: string; icon: React.ReactNode }> = {
  open:         { label: 'Offen',         color: 'text-muted-foreground bg-muted',                                           icon: <Clock className="h-3 w-3" /> },
  link_created: { label: 'Link erstellt', color: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40',         icon: <Link className="h-3 w-3" /> },
  sent:         { label: 'Gesendet',      color: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-950/40', icon: <Link className="h-3 w-3" /> },
  confirmed:    { label: 'Bestätigt',     color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected:     { label: 'Rückfrage',     color: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40',             icon: <XCircle className="h-3 w-3" /> },
  expired:      { label: 'Abgelaufen',    color: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40',     icon: <AlertCircle className="h-3 w-3" /> },
};

function StatusBadge({ status }: { status: TimesheetStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', m.color)}>
      {m.icon}{m.label}
    </span>
  );
}

// ─── Match-Badge (Import) ──────────────────────────────────────────────────────

const MATCH_META: Record<MatchStatus, { label: string; color: string }> = {
  matched:      { label: 'Automatisch',    color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40' },
  manual:       { label: 'Manuell',        color: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40' },
  conflict:     { label: 'Konflikt',       color: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40' },
  unresolved:   { label: 'Kein Match',     color: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40' },
  new_employee: { label: 'Neu erstellt',   color: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-950/40' },
  skipped:      { label: 'Ausgeschlossen', color: 'text-muted-foreground bg-muted' },
};

function MatchBadge({ status }: { status: MatchStatus }) {
  const m = MATCH_META[status];
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap', m.color)}>
      {m.label}
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function ArbeitszeitblaetterPage() {
  const navigate = useNavigate();
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const { user } = useAuth();

  const isBeaulieu = tenantId === 'beaulieu';
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [deptFilter, setDeptFilter] = useState('all');

  // ── Daten ─────────────────────────────────────────────────────────────────

  const [employees, setEmployees]           = useState<Employee[]>([]);
  const [confirmations, setConfirmations]   = useState<TimesheetConfirmation[]>([]);
  const [istMap, setIstMap]                 = useState<Record<string, number>>({});
  const [dienstplanMap, setDienstplanMap]   = useState<Record<string, number>>({});
  const [balances, setBalances]             = useState<Record<string, EmployeeTimeBalance>>({});
  const [importHistory, setImportHistory]   = useState<ImportHistoryEntry | null>(null);
  const [loading, setLoading]               = useState(true);
  const [generating, setGenerating]         = useState<string | null>(null);
  const [allEmps, setAllEmps]               = useState<PersonnelEmployee[]>([]);

  // ── Import-State ──────────────────────────────────────────────────────────

  const fileInputRef   = useRef<HTMLInputElement>(null);
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const [importParsing, setImportParsing]     = useState(false);
  const [importRunning, setImportRunning]     = useState(false);
  const [importRows, setImportRows]           = useState<ImportPreviewRow[]>([]);
  const [importFileName, setImportFileName]   = useState('');
  /** null = kein Monat erkannt oder kein Mismatch; sonst der Dateimonat */
  const [importMonthMismatch, setImportMonthMismatch] = useState<{ month: number; year: number } | null>(null);
  /** true = Admin hat Abweichung explizit bestätigt */
  const [importMonthOverride, setImportMonthOverride] = useState(false);
  /** Parser-Statistiken aus dem letzten Datei-Upload */
  const [parseStats, setParseStats] = useState<ExcelParseStats | null>(null);

  // ── Mitarbeiter-Einzelansicht ─────────────────────────────────────────────
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  // ── Create-Employee-Dialog ────────────────────────────────────────────────

  const [createDialogRowIdx, setCreateDialogRowIdx] = useState<number | null>(null);
  const [createForm, setCreateForm] = useState<NewEmployeeFormData>({
    name: '', department: 'service', employment_type: 'aushilfe', weekly_hours: '', contract_start: '',
  });
  const [createSaving, setCreateSaving] = useState(false);

  // ── Daten laden ───────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: empData } = await (supabase as any)
        .from('employees')
        .select('id, name, department, weekly_hours, employment_type, contract_start, employment_end_date, employee_status')
        .order('name');

      const all = (empData ?? []) as Employee[];
      const filtered = all.filter(e => {
        const tenantMatch = isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-');
        return tenantMatch && isActiveInMonth(e, year, month);
      });
      setEmployees(filtered);
      setAllEmps(all as unknown as PersonnelEmployee[]);

      const empIds = filtered.map(e => e.id);
      const [confs, hours, dienstplan, bals, history] = await Promise.all([
        getConfirmationsForMonth(tenantId, year, month),
        getActualHoursBatch(empIds, year, month),
        loadDienstplanHoursForMonth(empIds, year, month),
        getEmployeeTimeBalancesForMonth(tenantId, year, month),
        getImportHistoryForMonth(tenantId, year, month),
      ]);

      setConfirmations(confs);
      setIstMap(hours);
      setDienstplanMap(dienstplan);
      setBalances(bals);
      setImportHistory(history);
    } catch (err) {
      console.error('[TIMESHEET] loadData error', err);
      toast.error('Fehler beim Laden der Daten');
    } finally {
      setLoading(false);
    }
  }, [tenantId, year, month, isBeaulieu]);

  useEffect(() => { loadData(); }, [loadData]);

  // Einzelansicht zurücksetzen wenn Monat wechselt
  useEffect(() => { setSelectedEmployeeId(null); }, [year, month, tenantId]);

  if (!isAdmin) { navigate('/'); return null; }

  const confMap = Object.fromEntries(confirmations.map(c => [c.employee_id, c]));
  const departments = ['all', ...Array.from(new Set(employees.map(e => e.department).filter(Boolean)))];

  const rows: RowData[] = employees
    .filter(e => deptFilter === 'all' || e.department === deptFilter)
    .map(e => ({
      employee:        e,
      confirmation:    confMap[e.id] ?? null,
      istHours:        istMap[e.id]        ?? 0,
      dienstplanHours: dienstplanMap[e.id] ?? 0,
      sollHours:       e.weekly_hours ? sollHoursForMonth(e.weekly_hours, year, month) : 0,
      vacationBalance: balances[e.id]?.vacation_balance_hours         ?? null,
      holidayBalance:  balances[e.id]?.public_holiday_balance_hours   ?? null,
    }));

  const stats = {
    total:     rows.length,
    confirmed: rows.filter(r => r.confirmation?.status === 'confirmed').length,
    rejected:  rows.filter(r => r.confirmation?.status === 'rejected').length,
    pending:   rows.filter(r => !r.confirmation || r.confirmation.status === 'open').length,
  };

  // Einzelansicht: Daten für ausgewählten Mitarbeiter (unabhängig vom Abteilungsfilter)
  const selectedRow: RowData | null = selectedEmployeeId
    ? (() => {
        const emp = employees.find(e => e.id === selectedEmployeeId);
        if (!emp) return null;
        return {
          employee:        emp,
          confirmation:    confMap[emp.id]    ?? null,
          istHours:        istMap[emp.id]     ?? 0,
          dienstplanHours: dienstplanMap[emp.id] ?? 0,
          sollHours:       emp.weekly_hours ? sollHoursForMonth(emp.weekly_hours, year, month) : 0,
          vacationBalance: balances[emp.id]?.vacation_balance_hours         ?? null,
          holidayBalance:  balances[emp.id]?.public_holiday_balance_hours   ?? null,
        };
      })()
    : null;

  // ── Import-Berechnungen ───────────────────────────────────────────────────

  const importSummary = {
    matched:     importRows.filter(r => r.matchStatus === 'matched').length,
    manual:      importRows.filter(r => r.matchStatus === 'manual').length,
    newEmployee: importRows.filter(r => r.matchStatus === 'new_employee').length,
    skipped:     importRows.filter(r => r.matchStatus === 'skipped').length,
    conflict:    importRows.filter(r => r.matchStatus === 'conflict').length,
    unresolved:  importRows.filter(r => r.matchStatus === 'unresolved').length,
    totalDays:   importRows.filter(r => r.employee && r.matchStatus !== 'skipped')
                           .reduce((s, r) => s + r.dayCount, 0),
  };
  const isImportReady = importRows.length > 0
    && importSummary.conflict === 0
    && importSummary.unresolved === 0
    && (!importMonthMismatch || importMonthOverride);

  // ── Monat Navigation ──────────────────────────────────────────────────────

  function prevMonth() { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); }
  function nextMonth() { if (month === 12) { setYear(y => y + 1); setMonth(1); }  else setMonth(m => m + 1); }

  // ── Confirmation-Aktionen ─────────────────────────────────────────────────

  async function handleGenerateLink(emp: Employee) {
    setGenerating(emp.id);
    try {
      const conf = await createOrGetConfirmation(tenantId, emp.id, year, month);
      await navigator.clipboard.writeText(timesheetPublicUrl(conf.token));
      toast.success(`Link für ${emp.name} kopiert`);
      await loadData();
    } catch { toast.error('Fehler beim Generieren des Links'); }
    finally { setGenerating(null); }
  }

  async function handleCopyLink(conf: TimesheetConfirmation) {
    await navigator.clipboard.writeText(timesheetPublicUrl(conf.token));
    toast.success('Link kopiert');
  }

  async function handleDelete(conf: TimesheetConfirmation, empName: string) {
    if (!confirm(`Bestätigung für ${empName} löschen? Der Link wird ungültig.`)) return;
    try { await deleteConfirmation(conf.id); toast.success('Gelöscht'); await loadData(); }
    catch { toast.error('Fehler beim Löschen'); }
  }

  // ── Mirus Import: Datei parsen ────────────────────────────────────────────

  function buildImportRows(excelEmps: ExcelEmployee[]): ImportPreviewRow[] {
    loadNameMappings();
    const tenantPersonnel = (allEmps as unknown as PersonnelEmployee[]).filter(e =>
      isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-'),
    );
    return excelEmps.map(exc => {
      const mirusName = exc.name ?? '(Kein Name)';
      const result = matchEmployeeByName(mirusName, tenantPersonnel);
      const validDays = exc.days.filter(d => d.date && (d.totalHours ?? 0) > 0);
      // Eindeutige Tage zählen (mehrere Schichtblöcke pro Tag = 1 Arbeitstag)
      const uniqueDates = new Set(validDays.map(d => d.date));
      const totalHours = validDays.reduce((s, d) => s + (d.totalHours ?? 0), 0);
      const vacH = parseMirusHoursString(exc.monthlyAccounts?.vacation?.closingBalance ?? exc.totals?.ferien);
      const holH = parseMirusHoursString(exc.monthlyAccounts?.holiday?.closingBalance  ?? exc.totals?.feiertag);
      const overH = parseMirusHoursString(exc.monthlyAccounts?.overtime?.closingBalance ?? exc.totals?.ueberzeit);

      // Skip-Mapping → ausgeschlossen
      if (result.matchStep === 'skip') {
        const dc = uniqueDates.size;
      return { mirusName, matchStatus: 'skipped' as const, employee: null, dayCount: dc, totalHours, vacationHours: vacH, holidayHours: holH, overtimeHours: overH, excEmployee: exc };
      }
      // Exakter oder gespeicherter Match → automatisch
      if (result.employee && (result.matchType === 'exact' || result.matchType === 'saved')) {
        const dc = uniqueDates.size;
        return { mirusName, matchStatus: 'matched' as const, employee: result.employee as unknown as Employee, dayCount: dc, totalHours, vacationHours: vacH, holidayHours: holH, overtimeHours: overH, excEmployee: exc };
      }
      // Vorname-Match → Konflikt (Admin muss bestätigen)
      if (result.employee && result.matchType === 'firstName') {
        const dc = uniqueDates.size;
        return { mirusName, matchStatus: 'conflict' as const, employee: result.employee as unknown as Employee, dayCount: dc, totalHours, vacationHours: vacH, holidayHours: holH, overtimeHours: overH, excEmployee: exc };
      }
      // Kein Match → ungelöst
      const dc = uniqueDates.size;
      return { mirusName, matchStatus: 'unresolved' as const, employee: null, dayCount: dc, totalHours, vacationHours: vacH, holidayHours: holH, overtimeHours: overH, excEmployee: exc };
    });
  }

  async function processImportFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls'].includes(ext)) { toast.error('Nur .xlsx und .xls werden unterstützt.'); return; }
    setImportParsing(true);
    setImportFileName(file.name);
    setImportMonthMismatch(null);
    setImportMonthOverride(false);
    try {
      const parsed = await parseMirusExcel(file);
      if (!parsed.employees.length) { toast.error('Keine Mitarbeiterdaten in der Datei.'); return; }

      // Monat/Jahr: Parser-Meta hat Vorrang (aus Dateiname + Workbook-Inhalt)
      let detectedMonth: number | null = parsed.month ?? null;
      let detectedYear:  number | null = parsed.year  ?? null;

      // Fallback: erste ISO-Datumszeile aus den Mitarbeiter-Daten
      if (!detectedMonth || !detectedYear) {
        const isoDates = parsed.employees
          .flatMap(e => e.days.map(d => d.date))
          .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort();
        if (isoDates.length) {
          const parts = isoDates[0].split('-');
          const fy = parseInt(parts[0]);
          const fm = parseInt(parts[1]);
          if (!isNaN(fy) && !isNaN(fm)) { detectedYear = fy; detectedMonth = fm; }
        }
      }

      // Mismatch prüfen
      if (detectedMonth && detectedYear && (detectedYear !== year || detectedMonth !== month)) {
        setImportMonthMismatch({ month: detectedMonth, year: detectedYear });
      }

      setParseStats(parsed.parseStats);
      setImportRows(buildImportRows(parsed.employees));
    } catch (err) {
      console.error('[IMPORT] parse error', err);
      toast.error('Fehler beim Lesen der Datei.');
    } finally {
      setImportParsing(false);
    }
  }

  // ── Import: Zeilen-Aktionen ───────────────────────────────────────────────

  function assignEmployee(idx: number, empId: string) {
    setImportRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      if (empId === '__skip__') return { ...r, matchStatus: 'skipped' as const, employee: null };
      const emp = employees.find(e => e.id === empId) ?? null;
      return { ...r, matchStatus: 'manual' as const, employee: emp };
    }));
  }

  function confirmConflict(idx: number) {
    setImportRows(prev => prev.map((r, i) =>
      i !== idx ? r : { ...r, matchStatus: 'manual' as const }
    ));
  }

  function skipRow(idx: number) {
    setImportRows(prev => prev.map((r, i) =>
      i !== idx ? r : { ...r, matchStatus: 'skipped' as const, employee: null }
    ));
  }

  function undoRow(idx: number) {
    setImportRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      return { ...r, matchStatus: r.employee ? 'manual' as const : 'unresolved' as const };
    }));
  }

  function openCreateDialog(idx: number) {
    const row = importRows[idx];
    // Versuche den Mirus-Namen vorausfüllen
    const nameParts = row.mirusName.replace(/,/g, '').trim().split(/\s+/);
    const guessedName = nameParts.length >= 2
      ? `${nameParts[nameParts.length - 1]} ${nameParts[0]}` // "Nachname Vorname" → "Vorname Nachname"
      : row.mirusName;
    setCreateForm({
      name:            guessedName,
      department:      'service',
      employment_type: 'aushilfe',
      weekly_hours:    '',
      contract_start:  `${year}-${String(month).padStart(2, '0')}-01`,
    });
    setCreateDialogRowIdx(idx);
  }

  async function handleCreateEmployee() {
    if (createDialogRowIdx === null || !createForm.name.trim()) return;
    setCreateSaving(true);
    try {
      const newId = `${isBeaulieu ? 'b-' : ''}new-${Date.now()}`;
      const newEmp: PersonnelEmployee = {
        id:             newId,
        name:           createForm.name.trim(),
        department:     createForm.department as 'service' | 'küche',
        employmentType: createForm.employment_type,
        hourlyWage:     0,
        weeklyHours:    createForm.weekly_hours ? parseFloat(createForm.weekly_hours) : undefined,
        contractStart:  createForm.contract_start || undefined,
      };
      const ok = await upsertEmployee(newEmp, isBeaulieu ? 'beaulieu' : 'oliv');
      if (!ok) { toast.error('Mitarbeiter konnte nicht erstellt werden.'); return; }
      // Name-Mapping speichern
      saveNameMappingsBatch({ [importRows[createDialogRowIdx].mirusName]: newId });
      // Zeile aktualisieren
      setImportRows(prev => prev.map((r, i) => i !== createDialogRowIdx ? r : {
        ...r,
        matchStatus:        'new_employee' as const,
        employee:           newEmp as unknown as Employee,
        newEmployeeCreated: true,
      }));
      toast.success(`Mitarbeiter „${newEmp.name}" erstellt`);
      setCreateDialogRowIdx(null);
    } catch (err) {
      console.error('[CREATE-EMP]', err);
      toast.error('Fehler beim Erstellen des Mitarbeiters.');
    } finally {
      setCreateSaving(false);
    }
  }

  // ── Import ausführen ──────────────────────────────────────────────────────

  async function runImport() {
    if (!isImportReady) return;
    setImportRunning(true);
    const errors: string[] = [];
    let importedCount = 0, skippedCount = 0, createdCount = 0, manualCount = 0;

    for (const row of importRows) {
      if (row.matchStatus === 'skipped') { skippedCount++; continue; }
      if (!row.employee) continue;
      if (row.matchStatus === 'new_employee') createdCount++;
      if (row.matchStatus === 'manual') manualCount++;

      // Tagesstunden → actual_hours
      for (const day of row.excEmployee.days) {
        if (!day.date || (day.totalHours ?? 0) <= 0) continue;
        try {
          // Zeiten nur speichern wenn exakt EIN Schichtblock vorhanden — bei mehreren
          // Blöcken würde shifts[0] nur den ersten Block widerspiegeln, hours aber
          // das Tages-Total aller Blöcke. Das würde in der Anzeige verwirren.
          const singleShift =
            day.shifts?.length === 1 && day.shifts[0].from && day.shifts[0].to
              ? day.shifts[0]
              : null;
          await saveActualHourEntry(row.employee.id, day.date, {
            hours: day.totalHours!,
            start: singleShift?.from ?? undefined,
            end:   singleShift?.to   ?? undefined,
          });

          // Einzelne Stempelzeiten aus allen Schichtblöcken speichern
          const stampEntries: Array<{ entry_type: 'in' | 'out'; time: string }> = [];
          for (const shift of day.shifts ?? []) {
            if (shift.from && shift.from !== '?') stampEntries.push({ entry_type: 'in',  time: shift.from });
            if (shift.to   && shift.to   !== '?') stampEntries.push({ entry_type: 'out', time: shift.to   });
          }
          if (stampEntries.length > 0) {
            await saveActualHourEntries(row.employee.id, day.date, stampEntries);
          }
          importedCount++;
        } catch (err) {
          errors.push(`${row.employee.name}/${day.date}: ${String(err)}`);
        }
      }

      // Zeitguthaben → employee_time_balances
      if (row.vacationHours != null || row.holidayHours != null || row.overtimeHours != null) {
        await upsertEmployeeTimeBalance({ tenantId, employeeId: row.employee.id, year, month, vacationHours: row.vacationHours, holidayHours: row.holidayHours, overtimeHours: row.overtimeHours });
      }
    }

    // Manuell zugeordnete Mappings speichern (nicht neu erstellte)
    const newMappings: Record<string, string> = {};
    for (const row of importRows) {
      if (row.matchStatus === 'manual' && !row.newEmployeeCreated && row.employee) {
        newMappings[row.mirusName] = row.employee.id;
      }
    }
    if (Object.keys(newMappings).length) saveNameMappingsBatch(newMappings);

    await saveImportHistory({
      tenantId, year, month, source: 'mirus',
      fileName: importFileName,
      importedCount, skippedCount,
      createdEmployeesCount: createdCount,
      manualMatchesCount:    manualCount,
      errors,
      createdBy: user?.email ?? null,
    });

    setImportRunning(false);
    setImportSheetOpen(false);
    setImportRows([]);
    setImportMonthMismatch(null);
    setParseStats(null);

    if (errors.length === 0) toast.success(`Import abgeschlossen: ${importedCount} Einträge, ${skippedCount} übersprungen`);
    else toast.warning(`Import mit ${errors.length} Fehler(n). ${importedCount} Einträge gespeichert.`);
    await loadData();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-card px-4 py-3 shrink-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-primary shrink-0" />
            <div>
              <h1 className="text-base font-bold leading-tight">Arbeitszeitblätter</h1>
              <p className="text-[11px] text-muted-foreground">Digitale Mitarbeiterbestätigungen</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-0 border border-border rounded-md bg-background h-8">
              <button onClick={prevMonth} className="px-2 h-full hover:bg-muted rounded-l-md transition-colors"><ChevronLeft className="h-4 w-4" /></button>
              <span className="px-3 text-sm font-medium min-w-[130px] text-center">{MONTH_NAMES_DE[month - 1]} {year}</span>
              <button onClick={nextMonth} className="px-2 h-full hover:bg-muted rounded-r-md transition-colors"><ChevronRight className="h-4 w-4" /></button>
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" onClick={() => { setImportRows([]); setImportMonthMismatch(null); setImportSheetOpen(true); }} className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/5">
                <Upload className="h-3.5 w-3.5" />Mirus Import
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="h-8 gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />Aktualisieren
            </Button>
          </div>
        </div>

        {/* Import-Historie-Chip */}
        {importHistory && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 rounded-md px-2.5 py-1.5">
            <History className="h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">Letzter Import:</span>{' '}
              {fmtDatetime(importHistory.created_at)} · Quelle: {importHistory.source} · {importHistory.imported_count} Einträge
              {(importHistory as ImportHistoryEntry & { skipped_count?: number }).skipped_count
                ? ` · ${(importHistory as ImportHistoryEntry & { skipped_count?: number }).skipped_count} übersprungen` : ''}
              {importHistory.error_count > 0 && <span className="text-red-600 ml-1">· {importHistory.error_count} Fehler</span>}
              {importHistory.file_name && <span className="text-muted-foreground/70 ml-1">· {importHistory.file_name}</span>}
            </span>
          </div>
        )}
      </div>

      {selectedRow ? (
        <EmployeeDetailView
          employeeId={selectedRow.employee.id}
          employeeName={selectedRow.employee.name}
          department={selectedRow.employee.department || ''}
          sollHours={selectedRow.sollHours}
          dienstplanHours={selectedRow.dienstplanHours}
          istHours={selectedRow.istHours}
          vacationBalance={selectedRow.vacationBalance}
          holidayBalance={selectedRow.holidayBalance}
          confirmation={selectedRow.confirmation}
          year={year}
          month={month}
          onBack={() => setSelectedEmployeeId(null)}
        />
      ) : (
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Gesamt',    value: stats.total,     color: 'text-foreground',                          Icon: Users },
            { label: 'Bestätigt', value: stats.confirmed, color: 'text-emerald-600 dark:text-emerald-400',   Icon: CheckCircle2 },
            { label: 'Rückfrage', value: stats.rejected,  color: 'text-red-600 dark:text-red-400',           Icon: XCircle },
            { label: 'Ausstehend', value: stats.pending,  color: 'text-amber-600 dark:text-amber-400',       Icon: Clock },
          ].map(s => (
            <div key={s.label} className="bg-card border border-border rounded-lg p-3 flex items-center gap-3">
              <s.Icon className={cn('h-5 w-5 shrink-0', s.color)} />
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className={cn('text-xl font-bold tabular-nums', s.color)}>{s.value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Mitarbeiter-Filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <select
            value={selectedEmployeeId ?? ''}
            onChange={e => setSelectedEmployeeId(e.target.value || null)}
            className="text-xs border border-border rounded-md px-2 py-1 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary h-7 min-w-[160px]"
          >
            <option value="">Alle Mitarbeiter</option>
            {[...employees]
              .sort((a, b) => a.name.localeCompare(b.name, 'de'))
              .map(emp => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))
            }
          </select>
          {selectedEmployeeId && (
            <button
              onClick={() => setSelectedEmployeeId(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2 py-1 h-7 hover:bg-muted transition-colors"
            >
              <X className="h-3 w-3" />Alle
            </button>
          )}
        </div>

        {/* Abteilungs-Filter */}
        {departments.length > 2 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {departments.map(d => (
              <button key={d} onClick={() => setDeptFilter(d)}
                className={cn('px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                  deptFilter === d ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
                {d === 'all' ? 'Alle Abteilungen' : d}
              </button>
            ))}
          </div>
        )}

        {/* Mitarbeiter-Tabelle */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />Lade Daten…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />Keine aktiven Mitarbeiter für diesen Monat
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mitarbeiter</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Abteilung</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Soll</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell" title="Stunden aus dem internen Dienstplan">Dienstplan IST</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide" title="Importierte Stunden aus Mirus / actual_hours">AZB IST</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell" title="AZB IST minus Soll">Diff.</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Ferien</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Feiertage</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden xl:table-cell">Letzte Aktion</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map(row => {
                    const { employee: emp, confirmation: conf, istHours, dienstplanHours, sollHours, vacationBalance, holidayBalance } = row;
                    const diff = istHours - sollHours;
                    const planDeviation = dienstplanHours > 0 && istHours > 0 ? Math.abs(dienstplanHours - istHours) : 0;
                    const hasPlanWarning = planDeviation > 2;
                    const status = conf?.status ?? 'open';
                    const lastAction = conf?.confirmed_at ?? conf?.rejected_at ?? conf?.updated_at ?? null;
                    return (
                      <tr key={emp.id} className={cn('hover:bg-muted/30 transition-colors',
                        hasPlanWarning && 'bg-amber-50/40 dark:bg-amber-950/10',
                        !hasPlanWarning && status === 'confirmed' && 'bg-emerald-50/30 dark:bg-emerald-950/10',
                        !hasPlanWarning && status === 'rejected'  && 'bg-red-50/30 dark:bg-red-950/10',
                      )}>
                        <td className="px-4 py-2 font-medium text-sm">
                          <div className="flex items-center gap-1.5">
                            {hasPlanWarning && (
                              <button
                                onClick={() => setSelectedEmployeeId(emp.id)}
                                title={`Detail anzeigen — Dienstplan (${fmtHours(dienstplanHours)}) vs. AZB (${fmtHours(istHours)}): ${fmtDiff(dienstplanHours - istHours)}`}
                                className="shrink-0 hover:scale-110 transition-transform"
                              >
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              </button>
                            )}
                            {emp.name}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground hidden sm:table-cell">{emp.department || '–'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">{sollHours > 0 ? fmtHours(sollHours) : '–'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden md:table-cell">
                          <button
                            onClick={() => setSelectedEmployeeId(emp.id)}
                            className={cn('tabular-nums hover:underline underline-offset-2 cursor-pointer', dienstplanHours > 0 ? 'text-foreground' : 'text-muted-foreground')}
                            title="Tagesdetails anzeigen"
                          >
                            {dienstplanHours > 0 ? fmtHours(dienstplanHours) : '–'}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">
                          <button
                            onClick={() => setSelectedEmployeeId(emp.id)}
                            className={cn('tabular-nums hover:underline underline-offset-2 cursor-pointer', istHours > 0 ? (hasPlanWarning ? 'text-amber-700 dark:text-amber-400' : 'text-foreground') : 'text-muted-foreground')}
                            title="Tagesdetails anzeigen"
                          >
                            {istHours > 0 ? fmtHours(istHours) : '–'}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden md:table-cell">
                          {istHours > 0 && sollHours > 0 ? (
                            <button
                              onClick={() => setSelectedEmployeeId(emp.id)}
                              className={cn('tabular-nums hover:underline underline-offset-2 cursor-pointer', diff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}
                              title="Tagesdetails anzeigen"
                            >
                              {fmtDiff(diff)}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">–</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden lg:table-cell">
                          {vacationBalance != null ? <span className="text-blue-600 dark:text-blue-400">{fmtHours(vacationBalance)}</span> : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden lg:table-cell">
                          {holidayBalance != null ? <span className="text-purple-600 dark:text-purple-400">{fmtHours(holidayBalance)}</span> : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={status} />
                            {status === 'rejected' && conf?.employee_comment && (
                              <p className="text-[10px] text-red-600 dark:text-red-400 max-w-[180px] truncate" title={conf.employee_comment}>„{conf.employee_comment}"</p>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground hidden xl:table-cell">{lastAction ? fmtDatetime(lastAction) : '–'}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1 justify-end">
                            {conf ? (
                              <>
                                <button onClick={() => handleCopyLink(conf)} title="Link kopieren" className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><Copy className="h-3.5 w-3.5" /></button>
                                <button onClick={() => handleGenerateLink(emp)} disabled={generating === emp.id} title="Link neu generieren" className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"><RefreshCw className={cn('h-3.5 w-3.5', generating === emp.id && 'animate-spin')} /></button>
                                <button onClick={() => handleDelete(conf, emp.name)} title="Löschen" className="h-7 w-7 flex items-center justify-center rounded border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                              </>
                            ) : (
                              <button onClick={() => handleGenerateLink(emp)} disabled={generating === emp.id} className="h-7 px-2.5 flex items-center gap-1 text-[11px] font-medium rounded border border-primary text-primary hover:bg-primary/10 transition-colors disabled:opacity-50">
                                {generating === emp.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Link className="h-3 w-3" />}Link generieren
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Legende */}
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground pb-4">
          <span className="flex items-center gap-1"><Check className="h-3 w-3 text-emerald-500" />Soll = Wochenstunden ÷ 7 × Monatstage</span>
          <span className="flex items-center gap-1">■ Dienstplan IST = schedule_entries</span>
          <span className="flex items-center gap-1">■ AZB IST = Mirus-Import (actual_hours)</span>
          <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" />Warnung wenn |Dienstplan − AZB| &gt; 2 h</span>
          <span className="flex items-center gap-1 text-blue-500">■ Ferien/Feiertage = Mirus Abschluss-Saldo</span>
        </div>
      </div>
      )}

      {/* ── Mirus Import Sheet ──────────────────────────────────────────────── */}
      <Sheet open={importSheetOpen} onOpenChange={setImportSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-3xl flex flex-col p-0 gap-0">
          <SheetHeader className="px-5 py-4 border-b border-border shrink-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Mirus Import — {MONTH_NAMES_DE[month - 1]} {year}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-auto">
            {/* Monats-Warnung + Override */}
            {importMonthMismatch && (
              <div className="mx-5 mt-4 space-y-2">
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Die Datei enthält Daten für{' '}
                    <strong>{MONTH_NAMES_DE[importMonthMismatch.month - 1]} {importMonthMismatch.year}</strong>.
                    Ausgewählt ist <strong>{MONTH_NAMES_DE[month - 1]} {year}</strong>.
                    Der Import ist standardmässig gesperrt.
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer px-1 text-xs">
                  <input type="checkbox" checked={importMonthOverride} onChange={e => setImportMonthOverride(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-primary" />
                  <span>Ich möchte diese Datei trotzdem in <strong>{MONTH_NAMES_DE[month - 1]} {year}</strong> importieren</span>
                </label>
              </div>
            )}

            {/* ── Step 1: Upload ─────────────────────────────────────────────── */}
            {!importRows.length && !importParsing && (
              <div className="p-5 space-y-4">
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) processImportFile(f); e.target.value = ''; }} />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) processImportFile(f); }}
                  onDragOver={e => e.preventDefault()}
                  className="border-2 border-dashed border-border rounded-xl p-10 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
                >
                  <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                  <p className="font-medium text-sm">Mirus-Excel hier ablegen</p>
                  <p className="text-xs text-muted-foreground mt-1">oder klicken zum Auswählen · .xlsx / .xls</p>
                </div>

                {importHistory && (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5">
                    <p className="text-xs font-semibold flex items-center gap-1.5"><History className="h-3.5 w-3.5" />Letzter Import für {MONTH_NAMES_DE[month - 1]} {year}</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Datum:</span><span className="text-foreground">{fmtDatetime(importHistory.created_at)}</span>
                      <span>Einträge:</span><span className="text-foreground">{importHistory.imported_count} importiert{importHistory.error_count > 0 && <span className="text-red-600 ml-1">· {importHistory.error_count} Fehler</span>}</span>
                      {importHistory.file_name && <><span>Datei:</span><span className="text-foreground truncate">{importHistory.file_name}</span></>}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Nach dem Upload siehst du eine Vorschau aller Mitarbeiter mit Matching-Status. Du kannst Zuordnungen korrigieren, neue Mitarbeiter erfassen oder Einträge ausschliessen — bevor der Import startet.
                  </p>
                </div>
              </div>
            )}

            {/* Laden */}
            {importParsing && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
                <RefreshCw className="h-8 w-8 animate-spin" />
                <p className="text-sm">Datei wird analysiert…</p>
              </div>
            )}

            {/* ── Step 2: Vorschau ───────────────────────────────────────────── */}
            {importRows.length > 0 && !importParsing && (
              <div className="p-5 space-y-4">

                {/* Datei-Info */}
                <div className="flex items-center gap-3 text-xs flex-wrap">
                  <span className="font-medium">{importFileName}</span>
                  <button onClick={() => { setImportRows([]); setImportMonthMismatch(null); setImportMonthOverride(false); setParseStats(null); }} className="flex items-center gap-1 text-muted-foreground hover:text-foreground ml-auto">
                    <X className="h-3.5 w-3.5" />Neue Datei
                  </button>
                </div>

                {/* ── Parser-Analyse ───────────────────────────────────────────── */}
                {parseStats && (
                  <div className="rounded-lg border border-border bg-muted/20 text-xs">
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                      <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="font-semibold text-foreground">Parser-Analyse</span>
                      <span className="text-muted-foreground ml-auto">{importFileName}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-2.5 text-muted-foreground">
                      <span>Name/Vorname-Marker:</span>
                      <span className="text-foreground font-medium">{parseStats.markersFound}</span>

                      <span>Arbeitszeit-Tabellen:</span>
                      <span className="text-foreground font-medium">{parseStats.headerTablesFound}</span>

                      <span>Roh-Blöcke (gesamt):</span>
                      <span className="text-foreground font-medium">{parseStats.rawBlocks}</span>

                      <span>Übersprungen (leer):</span>
                      <span className={cn('font-medium', parseStats.skippedEmpty > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>
                        {parseStats.skippedEmpty}
                        {parseStats.skippedEmpty > 0 && <span className="ml-1 font-normal text-muted-foreground">(kein Name + keine Daten)</span>}
                      </span>

                      <span>Zusammengeführt (doppelt):</span>
                      <span className={cn('font-medium', parseStats.mergedDuplicates > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-foreground')}>
                        {parseStats.mergedDuplicates}
                        {parseStats.mergedDuplicates > 0 && <span className="ml-1 font-normal text-muted-foreground">(gleicher Name, mehrere Blöcke)</span>}
                      </span>

                      <span className="font-semibold text-foreground">Finale Mitarbeiter:</span>
                      <span className="font-semibold text-foreground">{parseStats.finalEmployees}</span>
                    </div>

                    {/* Warnungen wenn Blöcke übersprungen oder zusammengeführt */}
                    {(parseStats.skippedEmpty > 0 || parseStats.mergedDuplicates > 0) && (
                      <div className="border-t border-border px-3 py-2 space-y-1">
                        {parseStats.skippedEmpty > 0 && (
                          <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>
                              <strong>{parseStats.skippedEmpty}</strong> leere Block{parseStats.skippedEmpty !== 1 ? 'e' : ''} übersprungen
                              {parseStats.markersFound !== parseStats.headerTablesFound && (
                                <> — {parseStats.markersFound - parseStats.headerTablesFound} Marker ohne Arbeitszeit-Tabelle (z.B. Deckblatt-Blöcke)</>
                              )}
                            </span>
                          </div>
                        )}
                        {parseStats.mergedDuplicates > 0 && (
                          <div className="flex items-start gap-1.5 text-blue-700 dark:text-blue-400">
                            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>
                              <strong>{parseStats.mergedDuplicates}</strong> Folgeblock{parseStats.mergedDuplicates !== 1 ? 'e' : ''} mit gleichem Namen zusammengeführt (Fortsetzungsseiten)
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Status-Chips */}
                <div className="flex flex-wrap gap-2 text-xs">
                  {importSummary.matched > 0    && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />{importSummary.matched} automatisch</span>}
                  {importSummary.manual > 0     && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"><Check className="h-3 w-3" />{importSummary.manual} manuell</span>}
                  {importSummary.newEmployee > 0 && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300"><UserPlus className="h-3 w-3" />{importSummary.newEmployee} neu erstellt</span>}
                  {importSummary.skipped > 0    && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground"><SkipForward className="h-3 w-3" />{importSummary.skipped} ausgeschlossen</span>}
                  {importSummary.conflict > 0   && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"><AlertTriangle className="h-3 w-3" />{importSummary.conflict} Konflikt{importSummary.conflict > 1 ? 'e' : ''} — bitte bestätigen</span>}
                  {importSummary.unresolved > 0 && <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"><XCircle className="h-3 w-3" />{importSummary.unresolved} kein Match — bitte zuordnen</span>}
                </div>

                {/* Vorschau-Tabelle */}
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Mirus-Name</th>
                          <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Zuordnung</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">Status</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground" title="Eindeutige Arbeitstage">Tage</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Stunden</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">Ferien</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">Feiertage</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Aktionen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {importRows.map((row, idx) => (
                          <tr key={idx} className={cn('hover:bg-muted/20 transition-colors',
                            row.matchStatus === 'skipped'   && 'opacity-50',
                            row.matchStatus === 'conflict'  && 'bg-amber-50/30 dark:bg-amber-950/10',
                            row.matchStatus === 'unresolved' && 'bg-red-50/20 dark:bg-red-950/10',
                          )}>
                            {/* Mirus-Name */}
                            <td className="px-3 py-2 font-mono text-muted-foreground max-w-[110px]">
                              <span className="block truncate" title={row.mirusName}>{row.mirusName}</span>
                            </td>

                            {/* Zuordnung */}
                            <td className="px-3 py-2 min-w-[160px]">
                              {row.matchStatus === 'new_employee' ? (
                                <span className="text-purple-700 dark:text-purple-300 font-medium">
                                  🆕 {row.employee?.name}
                                </span>
                              ) : row.matchStatus === 'skipped' ? (
                                <span className="text-muted-foreground italic">Ausgeschlossen</span>
                              ) : (
                                <select
                                  value={row.employee?.id ?? ''}
                                  onChange={e => assignEmployee(idx, e.target.value)}
                                  className={cn(
                                    'text-xs border rounded px-1.5 py-0.5 bg-background w-full max-w-[190px] truncate',
                                    row.matchStatus === 'conflict'  && 'border-amber-400 dark:border-amber-600',
                                    row.matchStatus === 'unresolved' && 'border-red-400 dark:border-red-600',
                                    (row.matchStatus === 'matched' || row.matchStatus === 'manual') && 'border-border',
                                  )}
                                >
                                  <option value="">— kein Match —</option>
                                  <optgroup label="Mitarbeiter">
                                    {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                                  </optgroup>
                                </select>
                              )}
                            </td>

                            {/* Status-Badge */}
                            <td className="px-3 py-2 text-center"><MatchBadge status={row.matchStatus} /></td>

                            {/* Statistiken */}
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{row.dayCount}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtHours(row.totalHours)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-blue-600 dark:text-blue-400 hidden sm:table-cell">{row.vacationHours != null ? fmtHours(row.vacationHours) : '–'}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-purple-600 dark:text-purple-400 hidden sm:table-cell">{row.holidayHours != null ? fmtHours(row.holidayHours) : '–'}</td>

                            {/* Aktionen */}
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1 justify-end">
                                {/* Konflikt bestätigen */}
                                {row.matchStatus === 'conflict' && (
                                  <button onClick={() => confirmConflict(idx)} title="Match bestätigen"
                                    className="h-6 px-1.5 flex items-center gap-0.5 text-[10px] font-medium rounded bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 hover:bg-amber-200 dark:hover:bg-amber-800/30 transition-colors">
                                    <Check className="h-3 w-3" />OK
                                  </button>
                                )}
                                {/* Neuen Mitarbeiter erstellen */}
                                {(row.matchStatus === 'unresolved' || row.matchStatus === 'conflict') && (
                                  <button onClick={() => openCreateDialog(idx)} title="Neuen Mitarbeiter erfassen"
                                    className="h-6 w-6 flex items-center justify-center rounded border border-purple-300 dark:border-purple-700 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 transition-colors">
                                    <UserPlus className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {/* Ausschliessen */}
                                {row.matchStatus !== 'skipped' && row.matchStatus !== 'new_employee' && (
                                  <button onClick={() => skipRow(idx)} title="Vom Import ausschliessen"
                                    className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                                    <SkipForward className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {/* Rückgängig (aus Ausgeschlossen) */}
                                {(row.matchStatus === 'skipped' || row.matchStatus === 'new_employee') && (
                                  <button onClick={() => undoRow(idx)} title="Zurücksetzen"
                                    className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                                    <Undo2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Blocker-Hinweis */}
                {!isImportReady && (importSummary.conflict > 0 || importSummary.unresolved > 0) && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      {importSummary.conflict > 0 && <><strong>{importSummary.conflict} Konflikt{importSummary.conflict > 1 ? 'e' : ''}</strong> bitte über ✓ bestätigen oder manuell zuordnen. </>}
                      {importSummary.unresolved > 0 && <><strong>{importSummary.unresolved} Mitarbeiter</strong> ohne Zuordnung — bitte Dropdown nutzen, neu erfassen oder ausschliessen.</>}
                    </span>
                  </div>
                )}

                {/* Import-Zusammenfassung */}
                {isImportReady && (
                  <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/10 p-3 space-y-2">
                    <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" />Import bereit — Zusammenfassung
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      <span>Automatisch zugeordnet:</span><span className="text-foreground font-medium">{importSummary.matched}</span>
                      <span>Manuell zugeordnet:</span><span className="text-foreground font-medium">{importSummary.manual}</span>
                      <span>Neu erstellt:</span><span className="text-foreground font-medium">{importSummary.newEmployee}</span>
                      <span>Ausgeschlossen:</span><span className="text-muted-foreground">{importSummary.skipped}</span>
                      <span>Arbeitstags-Einträge:</span><span className="text-foreground font-medium">{importSummary.totalDays}</span>
                      <span>Monat (Datei):</span>
                      <span className={cn('font-medium', importMonthMismatch ? 'text-amber-600' : 'text-foreground')}>
                        {importMonthMismatch
                          ? `${MONTH_NAMES_DE[importMonthMismatch.month - 1]} ${importMonthMismatch.year}`
                          : `${MONTH_NAMES_DE[month - 1]} ${year}`}
                        {importMonthMismatch && <span className="text-amber-600 ml-1">⚠ Abweichung!</span>}
                      </span>
                      {importMonthMismatch && (
                        <>
                          <span>Ausgewählter Monat:</span>
                          <span className="text-foreground font-medium">{MONTH_NAMES_DE[month - 1]} {year}</span>
                          <span>Abweichung:</span>
                          <span className="text-amber-600 font-medium">Ja — Import trotzdem bestätigt</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          {importRows.length > 0 && !importParsing && (
            <div className="border-t border-border px-5 py-4 flex items-center justify-between shrink-0 bg-card">
              <p className="text-xs text-muted-foreground">
                {isImportReady
                  ? `${importSummary.matched + importSummary.manual + importSummary.newEmployee} MA · ${importSummary.totalDays} Tage werden importiert`
                  : `${importSummary.conflict + importSummary.unresolved} Einträge müssen zuerst aufgelöst werden`
                }
              </p>
              <Button onClick={runImport} disabled={importRunning || !isImportReady} className="gap-2">
                {importRunning ? <><RefreshCw className="h-4 w-4 animate-spin" />Importiere…</> : <><Upload className="h-4 w-4" />Import starten</>}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Create Employee Dialog ─────────────────────────────────────────── */}
      <Dialog open={createDialogRowIdx !== null} onOpenChange={open => { if (!open) setCreateDialogRowIdx(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Neuen Mitarbeiter erfassen
            </DialogTitle>
            <DialogDescription className="sr-only">Formulare zum Erfassen eines neuen Mitarbeiters direkt aus dem Mirus-Import</DialogDescription>
          </DialogHeader>

          {createDialogRowIdx !== null && (
            <div className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
              Mirus-Name: <strong className="text-foreground font-mono">{importRows[createDialogRowIdx]?.mirusName}</strong>
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium mb-1">Name <span className="text-red-500">*</span></label>
              <input
                type="text" value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Vorname Nachname"
                className="w-full text-sm border border-border rounded px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Abteilung</label>
                <select value={createForm.department} onChange={e => setCreateForm(f => ({ ...f, department: e.target.value as 'service' | 'küche' }))}
                  className="w-full text-sm border border-border rounded px-3 py-1.5 bg-background">
                  <option value="service">Service</option>
                  <option value="küche">Küche</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Anstellungsart</label>
                <select value={createForm.employment_type} onChange={e => setCreateForm(f => ({ ...f, employment_type: e.target.value as NewEmployeeFormData['employment_type'] }))}
                  className="w-full text-sm border border-border rounded px-3 py-1.5 bg-background">
                  <option value="vollzeit">Vollzeit</option>
                  <option value="teilzeit">Teilzeit</option>
                  <option value="aushilfe">Aushilfe</option>
                  <option value="minijob">Minijob</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">Wochenstunden</label>
                <input type="number" min="0" max="45" step="0.5" value={createForm.weekly_hours}
                  onChange={e => setCreateForm(f => ({ ...f, weekly_hours: e.target.value }))}
                  placeholder="z.B. 42"
                  className="w-full text-sm border border-border rounded px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Eintrittsdatum</label>
                <input type="date" value={createForm.contract_start}
                  onChange={e => setCreateForm(f => ({ ...f, contract_start: e.target.value }))}
                  className="w-full text-sm border border-border rounded px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogRowIdx(null)} disabled={createSaving}>Abbrechen</Button>
            <Button onClick={handleCreateEmployee} disabled={createSaving || !createForm.name.trim()} className="gap-2">
              {createSaving ? <><RefreshCw className="h-4 w-4 animate-spin" />Speichere…</> : <><UserPlus className="h-4 w-4" />Erstellen</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
