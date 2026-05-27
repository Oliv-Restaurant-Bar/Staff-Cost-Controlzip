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
  History,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { parseMirusExcel, type ExcelEmployee } from '@/lib/mirus-excel-parser';
import {
  matchEmployeeByName, saveNameMappingsBatch, loadNameMappings,
} from '@/lib/mirus-name-mapping-store';
import { saveActualHourEntry } from '@/lib/supabase-db';
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
  parseMirusHoursString,
  type TimesheetConfirmation,
  type TimesheetStatus,
  type ImportHistoryEntry,
  type EmployeeTimeBalance,
} from '@/lib/timesheet-store';
import type { Employee as PersonnelEmployee } from '@/types/personnel';

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

type MatchStatus = 'exact' | 'saved' | 'firstName' | 'unresolved' | 'skipped' | 'manual';

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
  manualId?: string;
}

interface RowData {
  employee: Employee;
  confirmation: TimesheetConfirmation | null;
  istHours: number;
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

function fmtH(h: number | null | undefined, dash = '–') {
  if (h == null || h === 0) return dash;
  return (h > 0 ? '+' === dash ? '+' : '' : '') + h.toFixed(1) + ' h';
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

// ─── Status-Badge ─────────────────────────────────────────────────────────────

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

const MATCH_META: Record<MatchStatus, { label: string; color: string }> = {
  exact:      { label: 'Exakt',     color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40' },
  saved:      { label: 'Gespeichert', color: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40' },
  firstName:  { label: 'Vorname',   color: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40' },
  manual:     { label: 'Manuell',   color: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-950/40' },
  unresolved: { label: 'Kein Match', color: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40' },
  skipped:    { label: 'Überspringen', color: 'text-muted-foreground bg-muted' },
};

function MatchBadge({ status }: { status: MatchStatus }) {
  const m = MATCH_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', m.color)}>
      {m.label}
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function ArbeitszeitblaetterPage() {
  const navigate = useNavigate();
  const { tenantId } = useTenant();
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { user } = useAuth();

  if (!isAdmin && !isBeaulieuManager) { navigate('/'); return null; }

  const isBeaulieu = tenantId === 'beaulieu';
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [deptFilter, setDeptFilter] = useState('all');

  // ── Daten ─────────────────────────────────────────────────────────────────

  const [employees, setEmployees]         = useState<Employee[]>([]);
  const [confirmations, setConfirmations] = useState<TimesheetConfirmation[]>([]);
  const [istMap, setIstMap]               = useState<Record<string, number>>({});
  const [balances, setBalances]           = useState<Record<string, EmployeeTimeBalance>>({});
  const [importHistory, setImportHistory] = useState<ImportHistoryEntry | null>(null);
  const [loading, setLoading]             = useState(true);
  const [generating, setGenerating]       = useState<string | null>(null);

  // ── Import-State ──────────────────────────────────────────────────────────

  const fileInputRef   = useRef<HTMLInputElement>(null);
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const [importParsing, setImportParsing]     = useState(false);
  const [importRunning, setImportRunning]     = useState(false);
  const [importRows, setImportRows]           = useState<ImportPreviewRow[]>([]);
  const [importFileName, setImportFileName]   = useState('');
  const [importMonthMismatch, setImportMonthMismatch] = useState<string | null>(null);
  const [allEmps, setAllEmps]                 = useState<PersonnelEmployee[]>([]);

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

      const [confs, hours, bals, history] = await Promise.all([
        getConfirmationsForMonth(tenantId, year, month),
        getActualHoursBatch(filtered.map(e => e.id), year, month),
        getEmployeeTimeBalancesForMonth(tenantId, year, month),
        getImportHistoryForMonth(tenantId, year, month),
      ]);

      setConfirmations(confs);
      setIstMap(hours);
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

  const confMap = Object.fromEntries(confirmations.map(c => [c.employee_id, c]));
  const departments = ['all', ...Array.from(new Set(employees.map(e => e.department).filter(Boolean)))];

  const rows: RowData[] = employees
    .filter(e => deptFilter === 'all' || e.department === deptFilter)
    .map(e => ({
      employee:       e,
      confirmation:   confMap[e.id] ?? null,
      istHours:       istMap[e.id] ?? 0,
      sollHours:      e.weekly_hours ? sollHoursForMonth(e.weekly_hours, year, month) : 0,
      vacationBalance: balances[e.id]?.vacation_balance_hours ?? null,
      holidayBalance:  balances[e.id]?.public_holiday_balance_hours ?? null,
    }));

  const stats = {
    total:     rows.length,
    confirmed: rows.filter(r => r.confirmation?.status === 'confirmed').length,
    rejected:  rows.filter(r => r.confirmation?.status === 'rejected').length,
    pending:   rows.filter(r => !r.confirmation || r.confirmation.status === 'open').length,
  };

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

  // ── Mirus Import ──────────────────────────────────────────────────────────

  function buildImportRows(excelEmps: ExcelEmployee[], tenantEmps: PersonnelEmployee[]): ImportPreviewRow[] {
    loadNameMappings();
    return excelEmps.map(exc => {
      const mirusName = exc.name ?? '(Kein Name)';
      const result = matchEmployeeByName(mirusName, tenantEmps);
      const validDays = exc.days.filter(d => d.date && (d.totalHours ?? 0) > 0);
      const totalHours = validDays.reduce((s, d) => s + (d.totalHours ?? 0), 0);

      // Ferien/Feiertag: erst monthlyAccounts.closingBalance, dann totals
      const vacH = parseMirusHoursString(
        exc.monthlyAccounts?.vacation?.closingBalance ?? exc.totals?.ferien,
      );
      const holH = parseMirusHoursString(
        exc.monthlyAccounts?.holiday?.closingBalance ?? exc.totals?.feiertag,
      );
      const overH = parseMirusHoursString(
        exc.monthlyAccounts?.overtime?.closingBalance ?? exc.totals?.ueberzeit,
      );

      let matchStatus: MatchStatus = result.employee ? (result.matchType as MatchStatus) : 'unresolved';

      return {
        mirusName,
        matchStatus,
        employee: result.employee as unknown as Employee | null,
        dayCount:     validDays.length,
        totalHours,
        vacationHours: vacH,
        holidayHours:  holH,
        overtimeHours: overH,
        excEmployee:   exc,
      };
    });
  }

  async function processImportFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!ext || !['xlsx', 'xls'].includes(ext)) {
      toast.error('Nur .xlsx und .xls Dateien werden unterstützt.');
      return;
    }
    setImportParsing(true);
    setImportFileName(file.name);
    setImportMonthMismatch(null);
    try {
      const parsed = await parseMirusExcel(file);
      if (!parsed.employees.length) {
        toast.error('Keine Mitarbeiterdaten in der Datei gefunden.');
        return;
      }

      // Monatsprüfung
      const allDates = parsed.employees.flatMap(e => e.days.map(d => d.date)).filter(Boolean) as string[];
      if (allDates.length) {
        const firstDate = allDates.sort()[0];
        const [fy, fm] = firstDate.split('-').map(Number);
        if (fy !== year || fm !== month) {
          setImportMonthMismatch(`${MONTH_NAMES_DE[fm - 1]} ${fy}`);
        }
      }

      const tenantPersonnel = (allEmps as unknown as PersonnelEmployee[]).filter(e =>
        isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-'),
      );
      const previewRows = buildImportRows(parsed.employees, tenantPersonnel);
      setImportRows(previewRows);
    } catch (err) {
      console.error('[STUNDENIMPORT] parse error', err);
      toast.error('Fehler beim Lesen der Datei. Bitte Format prüfen.');
    } finally {
      setImportParsing(false);
    }
  }

  function setManualMatch(idx: number, empId: string) {
    setImportRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      if (empId === '__skip__') return { ...r, manualId: undefined, matchStatus: 'skipped', employee: null };
      const emp = employees.find(e => e.id === empId) ?? null;
      return { ...r, manualId: empId, matchStatus: emp ? 'manual' : 'unresolved', employee: emp };
    }));
  }

  async function runImport() {
    setImportRunning(true);
    const errors: string[] = [];
    let importedCount = 0;
    const newMappings: Record<string, string> = {};

    for (const row of importRows) {
      if (!row.employee || row.matchStatus === 'skipped') continue;
      if (row.matchStatus === 'manual' || row.matchStatus === 'skipped') {
        newMappings[row.mirusName] = row.employee?.id ?? 'skip';
      }

      // Tagesstunden in actual_hours speichern
      for (const day of row.excEmployee.days) {
        if (!day.date || (day.totalHours ?? 0) <= 0) continue;
        try {
          await saveActualHourEntry(row.employee.id, day.date, {
            hours: day.totalHours!,
            start: day.shifts?.[0]?.from ?? undefined,
            end:   day.shifts?.[0]?.to   ?? undefined,
          });
          importedCount++;
        } catch (err) {
          errors.push(`${row.employee.name}/${day.date}: ${String(err)}`);
        }
      }

      // Zeitguthaben speichern
      if (row.vacationHours != null || row.holidayHours != null || row.overtimeHours != null) {
        await upsertEmployeeTimeBalance({
          tenantId,
          employeeId:    row.employee.id,
          year,
          month,
          vacationHours: row.vacationHours,
          holidayHours:  row.holidayHours,
          overtimeHours: row.overtimeHours,
        });
      }
    }

    // Mappings + Import-Historie speichern
    if (Object.keys(newMappings).length) saveNameMappingsBatch(newMappings);
    await saveImportHistory({
      tenantId, year, month,
      source:        'mirus',
      fileName:      importFileName,
      importedCount,
      errors,
      createdBy:     user?.email ?? null,
    });

    setImportRunning(false);
    setImportSheetOpen(false);
    setImportRows([]);

    if (errors.length === 0) {
      toast.success(`Import abgeschlossen: ${importedCount} Einträge gespeichert`);
    } else {
      toast.warning(`Import mit ${errors.length} Fehler(n): ${importedCount} Einträge gespeichert`);
    }
    await loadData();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const matched   = importRows.filter(r => r.employee && r.matchStatus !== 'skipped').length;
  const unmatched = importRows.filter(r => !r.employee && r.matchStatus !== 'skipped').length;
  const totalImportDays = importRows.reduce((s, r) => s + (r.employee && r.matchStatus !== 'skipped' ? r.dayCount : 0), 0);

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
            {/* Monat-Navigation */}
            <div className="flex items-center gap-0 border border-border rounded-md bg-background h-8">
              <button onClick={prevMonth} className="px-2 h-full hover:bg-muted rounded-l-md transition-colors">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-3 text-sm font-medium min-w-[130px] text-center">
                {MONTH_NAMES_DE[month - 1]} {year}
              </span>
              <button onClick={nextMonth} className="px-2 h-full hover:bg-muted rounded-r-md transition-colors">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {isAdmin && (
              <Button
                variant="outline" size="sm"
                onClick={() => { setImportRows([]); setImportSheetOpen(true); }}
                className="h-8 gap-1.5 border-primary/30 text-primary hover:bg-primary/5"
              >
                <Upload className="h-3.5 w-3.5" />
                Mirus Import
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="h-8 gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Aktualisieren
            </Button>
          </div>
        </div>

        {/* Import-Historie-Chip */}
        {importHistory && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/40 rounded-md px-2.5 py-1.5">
            <History className="h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">Letzter Import:</span>{' '}
              {fmtDatetime(importHistory.created_at)}{' '}
              · Quelle: {importHistory.source}{' '}
              · {importHistory.imported_count} Einträge
              {importHistory.error_count > 0 && (
                <span className="text-red-600 dark:text-red-400 ml-1">· {importHistory.error_count} Fehler</span>
              )}
              {importHistory.file_name && (
                <span className="text-muted-foreground/70 ml-1">· {importHistory.file_name}</span>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Gesamt',    value: stats.total,     color: 'text-foreground',                                Icon: Users },
            { label: 'Bestätigt', value: stats.confirmed, color: 'text-emerald-600 dark:text-emerald-400',        Icon: CheckCircle2 },
            { label: 'Rückfrage', value: stats.rejected,  color: 'text-red-600 dark:text-red-400',                Icon: XCircle },
            { label: 'Ausstehend', value: stats.pending,  color: 'text-amber-600 dark:text-amber-400',            Icon: Clock },
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

        {/* Abteilungs-Filter */}
        {departments.length > 2 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {departments.map(d => (
              <button key={d} onClick={() => setDeptFilter(d)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                  deptFilter === d
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {d === 'all' ? 'Alle Abteilungen' : d}
              </button>
            ))}
          </div>
        )}

        {/* Mitarbeiter-Tabelle */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
              Lade Daten…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Keine aktiven Mitarbeiter für diesen Monat
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mitarbeiter</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Abteilung</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Soll</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ist</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden md:table-cell">Diff.</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Ferien</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Feiertage</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden xl:table-cell">Letzte Aktion</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map(row => {
                    const { employee: emp, confirmation: conf, istHours, sollHours, vacationBalance, holidayBalance } = row;
                    const diff = istHours - sollHours;
                    const status = conf?.status ?? 'open';
                    const lastAction = conf?.confirmed_at ?? conf?.rejected_at ?? conf?.updated_at ?? null;

                    return (
                      <tr
                        key={emp.id}
                        className={cn(
                          'hover:bg-muted/30 transition-colors',
                          status === 'confirmed' && 'bg-emerald-50/30 dark:bg-emerald-950/10',
                          status === 'rejected'  && 'bg-red-50/30 dark:bg-red-950/10',
                        )}
                      >
                        <td className="px-4 py-2 font-medium text-sm">{emp.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground hidden sm:table-cell">{emp.department || '–'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          {sollHours > 0 ? fmtHours(sollHours) : '–'}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">
                          {istHours > 0 ? fmtHours(istHours) : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden md:table-cell">
                          {istHours > 0 && sollHours > 0
                            ? <span className={diff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{fmtDiff(diff)}</span>
                            : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden lg:table-cell">
                          {vacationBalance != null
                            ? <span className="text-blue-600 dark:text-blue-400">{fmtHours(vacationBalance)}</span>
                            : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-xs hidden lg:table-cell">
                          {holidayBalance != null
                            ? <span className="text-purple-600 dark:text-purple-400">{fmtHours(holidayBalance)}</span>
                            : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={status} />
                            {status === 'rejected' && conf?.employee_comment && (
                              <p className="text-[10px] text-red-600 dark:text-red-400 max-w-[180px] truncate" title={conf.employee_comment}>
                                „{conf.employee_comment}"
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground hidden xl:table-cell">
                          {lastAction ? fmtDatetime(lastAction) : '–'}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1 justify-end">
                            {conf ? (
                              <>
                                <button onClick={() => handleCopyLink(conf)} title="Link kopieren"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                <button onClick={() => handleGenerateLink(emp)} disabled={generating === emp.id} title="Link neu generieren"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50">
                                  <RefreshCw className={cn('h-3.5 w-3.5', generating === emp.id && 'animate-spin')} />
                                </button>
                                <button onClick={() => handleDelete(conf, emp.name)} title="Löschen"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-red-400 hover:text-red-600">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <button onClick={() => handleGenerateLink(emp)} disabled={generating === emp.id}
                                className="h-7 px-2.5 flex items-center gap-1 text-[11px] font-medium rounded border border-primary text-primary hover:bg-primary/10 transition-colors disabled:opacity-50">
                                {generating === emp.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Link className="h-3 w-3" />}
                                Link generieren
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
          <span className="flex items-center gap-1 text-blue-500">■ Ferien/Feiertage = Mirus Abschluss-Saldo (letzte Importe)</span>
        </div>
      </div>

      {/* ── Mirus Import Sheet ──────────────────────────────────────────────── */}
      <Sheet open={importSheetOpen} onOpenChange={setImportSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0 gap-0">
          <SheetHeader className="px-5 py-4 border-b border-border shrink-0">
            <SheetTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Mirus Import — {MONTH_NAMES_DE[month - 1]} {year}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-auto">
            {/* Monat-Warnung */}
            {importMonthMismatch && (
              <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Die Datei enthält Daten für <strong>{importMonthMismatch}</strong>.
                  Ausgewählt ist <strong>{MONTH_NAMES_DE[month - 1]} {year}</strong>.
                  Bitte prüfe ob dies korrekt ist.
                </span>
              </div>
            )}

            {/* Upload-Bereich (wenn noch keine Datei) */}
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

                {/* Import-Historie */}
                {importHistory && (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1.5">
                    <p className="text-xs font-semibold flex items-center gap-1.5"><History className="h-3.5 w-3.5" />Letzter Import für {MONTH_NAMES_DE[month - 1]} {year}</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>Datum:</span><span className="text-foreground">{fmtDatetime(importHistory.created_at)}</span>
                      <span>Quelle:</span><span className="text-foreground">{importHistory.source}</span>
                      <span>Einträge:</span><span className="text-foreground">{importHistory.imported_count} importiert</span>
                      {importHistory.error_count > 0 && <><span>Fehler:</span><span className="text-red-600">{importHistory.error_count}</span></>}
                      {importHistory.file_name && <><span>Datei:</span><span className="text-foreground truncate" title={importHistory.file_name}>{importHistory.file_name}</span></>}
                    </div>
                  </div>
                )}

                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Importiert wird in <code className="bg-muted px-1 rounded">actual_hours</code>. Ferien-/Feiertagsguthaben in <code className="bg-muted px-1 rounded">employee_time_balances</code>. Bestehende Einträge werden aktualisiert.
                  </p>
                </div>
              </div>
            )}

            {/* Laden */}
            {importParsing && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
                <RefreshCw className="h-8 w-8 animate-spin" />
                <p className="text-sm">Datei wird verarbeitet…</p>
              </div>
            )}

            {/* Matching-Vorschau */}
            {importRows.length > 0 && !importParsing && (
              <div className="p-5 space-y-4">
                {/* Summary */}
                <div className="flex items-center gap-3 text-xs flex-wrap">
                  <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />{matched} zugeordnet
                  </span>
                  {unmatched > 0 && (
                    <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                      <XCircle className="h-3.5 w-3.5" />{unmatched} ohne Match
                    </span>
                  )}
                  <span className="text-muted-foreground">{totalImportDays} Tageseinträge</span>
                  <span className="text-muted-foreground">Datei: {importFileName}</span>
                  <button onClick={() => { setImportRows([]); setImportMonthMismatch(null); }}
                    className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />Neue Datei
                  </button>
                </div>

                {/* Tabelle */}
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Mirus-Name</th>
                          <th className="px-3 py-2 text-left font-semibold text-muted-foreground">Zuordnung</th>
                          <th className="px-3 py-2 text-center font-semibold text-muted-foreground">Status</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Tage</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground">Stunden</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">Ferien</th>
                          <th className="px-3 py-2 text-right font-semibold text-muted-foreground hidden sm:table-cell">Feiertage</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {importRows.map((row, idx) => (
                          <tr key={idx} className={cn('hover:bg-muted/30', row.matchStatus === 'skipped' && 'opacity-50')}>
                            <td className="px-3 py-1.5 font-mono text-muted-foreground max-w-[120px] truncate" title={row.mirusName}>{row.mirusName}</td>
                            <td className="px-3 py-1.5">
                              <select
                                value={row.employee?.id ?? (row.matchStatus === 'skipped' ? '__skip__' : '')}
                                onChange={e => setManualMatch(idx, e.target.value)}
                                className="text-xs border border-border rounded px-1.5 py-0.5 bg-background max-w-[160px] truncate"
                              >
                                <option value="">— kein Match —</option>
                                <option value="__skip__">↷ Überspringen</option>
                                <optgroup label="Mitarbeiter">
                                  {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                                </optgroup>
                              </select>
                            </td>
                            <td className="px-3 py-1.5 text-center"><MatchBadge status={row.matchStatus} /></td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{row.dayCount}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmtHours(row.totalHours)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-blue-600 dark:text-blue-400 hidden sm:table-cell">
                              {row.vacationHours != null ? fmtHours(row.vacationHours) : '–'}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-purple-600 dark:text-purple-400 hidden sm:table-cell">
                              {row.holidayHours != null ? fmtHours(row.holidayHours) : '–'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {unmatched > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {unmatched} Mitarbeiter ohne Zuordnung werden nicht importiert.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Footer mit Import-Button */}
          {importRows.length > 0 && !importParsing && (
            <div className="border-t border-border px-5 py-4 flex items-center justify-between shrink-0 bg-card">
              <p className="text-xs text-muted-foreground">{matched} MA · {totalImportDays} Tage werden importiert</p>
              <Button
                onClick={runImport}
                disabled={importRunning || matched === 0}
                className="gap-2"
              >
                {importRunning
                  ? <><RefreshCw className="h-4 w-4 animate-spin" />Importiere…</>
                  : <><Upload className="h-4 w-4" />Import starten</>
                }
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
