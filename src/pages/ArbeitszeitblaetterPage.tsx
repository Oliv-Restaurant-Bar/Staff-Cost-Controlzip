import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  ClipboardCheck, ChevronLeft, ChevronRight, Copy, Link,
  CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw, Trash2,
  Users, Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  getConfirmationsForMonth,
  createOrGetConfirmation,
  deleteConfirmation,
  getActualHoursBatch,
  timesheetPublicUrl,
  MONTH_NAMES_DE,
  type TimesheetConfirmation,
  type TimesheetStatus,
} from '@/lib/timesheet-store';

interface Employee {
  id: string;
  name: string;
  department: string;
  weekly_hours: number;
  employment_type: string;
  // HR-Felder (via Migration ergänzt – nicht in generierten Types)
  contract_start?: string | null;      // ISO-Datum Eintrittsdatum
  employment_end_date?: string | null; // ISO-Datum Austrittsdatum
  employee_status?: string | null;     // 'active' | 'pending_review' | null
}

/**
 * Gibt zurück ob ein Mitarbeiter im gewählten Monat aktiv war:
 * 1. Kein Pending-Review-Status
 * 2. Eintrittsdatum leer ODER ≤ letzter Monatstag
 * 3. Austrittsdatum leer ODER ≥ erster Monatstag
 */
function isActiveInMonth(emp: Employee, year: number, month: number): boolean {
  if (emp.employee_status === 'pending_review') return false;

  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 0); // letzter Tag des Monats

  if (emp.contract_start) {
    const start = new Date(emp.contract_start);
    if (start > monthEnd) return false;
  }

  if (emp.employment_end_date) {
    const end = new Date(emp.employment_end_date);
    if (end < monthStart) return false;
  }

  return true;
}

interface RowData {
  employee: Employee;
  confirmation: TimesheetConfirmation | null;
  istHours: number;
  sollHours: number;
}

const STATUS_META: Record<TimesheetStatus, { label: string; color: string; icon: React.ReactNode }> = {
  open:         { label: 'Offen',          color: 'text-muted-foreground bg-muted',                                          icon: <Clock className="h-3 w-3" /> },
  link_created: { label: 'Link erstellt',  color: 'text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/40',        icon: <Link className="h-3 w-3" /> },
  sent:         { label: 'Gesendet',       color: 'text-purple-700 bg-purple-50 dark:text-purple-300 dark:bg-purple-950/40', icon: <Link className="h-3 w-3" /> },
  confirmed:    { label: 'Bestätigt',      color: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/40', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected:     { label: 'Rückfrage',      color: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-950/40',            icon: <XCircle className="h-3 w-3" /> },
  expired:      { label: 'Abgelaufen',     color: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/40',    icon: <AlertCircle className="h-3 w-3" /> },
};

function StatusBadge({ status }: { status: TimesheetStatus }) {
  const m = STATUS_META[status];
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', m.color)}>
      {m.icon}{m.label}
    </span>
  );
}

function fmtH(h: number) {
  return h.toFixed(1).replace('.', '.') + ' h';
}

function sollHoursForMonth(weeklyHours: number, year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Math.round((weeklyHours / 7) * daysInMonth * 10) / 10;
}

export default function ArbeitszeitblaetterPage() {
  const navigate = useNavigate();
  const { tenantId, tenantKey } = useTenant();
  const { isAdmin, isBeaulieuManager } = usePermissions();

  if (!isAdmin && !isBeaulieuManager) {
    navigate('/');
    return null;
  }

  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [deptFilter, setDeptFilter] = useState<string>('all');

  const [employees, setEmployees]         = useState<Employee[]>([]);
  const [confirmations, setConfirmations] = useState<TimesheetConfirmation[]>([]);
  const [istMap, setIstMap]               = useState<Record<string, number>>({});
  const [loading, setLoading]             = useState(true);
  const [generating, setGenerating]       = useState<string | null>(null);

  const isBeaulieu = tenantId === 'beaulieu';

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: empData } = await (supabase as any)
        .from('employees')
        .select('id, name, department, weekly_hours, employment_type, contract_start, employment_end_date, employee_status')
        .order('name');

      const allEmps = (empData ?? []) as Employee[];
      const filtered = allEmps.filter(e => {
        const tenantMatch = isBeaulieu ? e.id.startsWith('b-') : !e.id.startsWith('b-');
        return tenantMatch && isActiveInMonth(e, year, month);
      });
      setEmployees(filtered);

      const confs = await getConfirmationsForMonth(tenantId, year, month);
      setConfirmations(confs);

      const ids = filtered.map(e => e.id);
      const hours = await getActualHoursBatch(ids, year, month);
      setIstMap(hours);
    } catch (err) {
      console.error('[TIMESHEET] load error', err);
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
      employee: e,
      confirmation: confMap[e.id] ?? null,
      istHours: istMap[e.id] ?? 0,
      sollHours: e.weekly_hours ? sollHoursForMonth(e.weekly_hours, year, month) : 0,
    }));

  const stats = {
    total:     rows.length,
    confirmed: rows.filter(r => r.confirmation?.status === 'confirmed').length,
    rejected:  rows.filter(r => r.confirmation?.status === 'rejected').length,
    pending:   rows.filter(r => !r.confirmation || r.confirmation.status === 'open').length,
  };

  async function handleGenerateLink(emp: Employee) {
    setGenerating(emp.id);
    try {
      const conf = await createOrGetConfirmation(tenantId, emp.id, year, month);
      const url = timesheetPublicUrl(conf.token);
      await navigator.clipboard.writeText(url);
      toast.success(`Link für ${emp.name} kopiert`);
      await loadData();
    } catch (err) {
      toast.error('Fehler beim Generieren des Links');
      console.error(err);
    } finally {
      setGenerating(null);
    }
  }

  async function handleCopyLink(conf: TimesheetConfirmation) {
    const url = timesheetPublicUrl(conf.token);
    await navigator.clipboard.writeText(url);
    toast.success('Link kopiert');
  }

  async function handleDelete(conf: TimesheetConfirmation, empName: string) {
    if (!confirm(`Bestätigung für ${empName} wirklich löschen? Der Link wird ungültig.`)) return;
    try {
      await deleteConfirmation(conf.id);
      toast.success('Gelöscht');
      await loadData();
    } catch {
      toast.error('Fehler beim Löschen');
    }
  }

  function prevMonth() {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border bg-card px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-primary shrink-0" />
          <div>
            <h1 className="text-base font-bold leading-tight">Arbeitszeitblätter</h1>
            <p className="text-[11px] text-muted-foreground">Digitale Mitarbeiterbestätigungen</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Monat-Navigation */}
          <div className="flex items-center gap-1 border border-border rounded-md bg-background h-8">
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

          <Button variant="outline" size="sm" onClick={loadData} disabled={loading} className="h-8 gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Aktualisieren
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Gesamt', value: stats.total, color: 'text-foreground', Icon: Users },
            { label: 'Bestätigt', value: stats.confirmed, color: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 },
            { label: 'Rückfrage', value: stats.rejected, color: 'text-red-600 dark:text-red-400', Icon: XCircle },
            { label: 'Ausstehend', value: stats.pending, color: 'text-amber-600 dark:text-amber-400', Icon: Clock },
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
              <button
                key={d}
                onClick={() => setDeptFilter(d)}
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

        {/* Tabelle */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
              Lade Daten…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground text-sm">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Keine Mitarbeiter gefunden
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
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Letzte Aktion</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {rows.map(row => {
                    const { employee: emp, confirmation: conf, istHours, sollHours } = row;
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
                        <td className="px-4 py-2.5 font-medium">{emp.name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground text-xs hidden sm:table-cell">{emp.department || '–'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                          {sollHours > 0 ? fmtH(sollHours) : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">
                          {istHours > 0 ? fmtH(istHours) : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs hidden md:table-cell">
                          {istHours > 0 && sollHours > 0 ? (
                            <span className={diff >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                              {diff > 0 ? '+' : ''}{fmtH(diff)}
                            </span>
                          ) : <span className="text-muted-foreground">–</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={status} />
                            {status === 'rejected' && conf?.employee_comment && (
                              <p className="text-[10px] text-red-600 dark:text-red-400 max-w-[180px] truncate" title={conf.employee_comment}>
                                „{conf.employee_comment}"
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                          {lastAction
                            ? new Date(lastAction).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : '–'}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 justify-end">
                            {conf ? (
                              <>
                                <button
                                  onClick={() => handleCopyLink(conf)}
                                  title="Link kopieren"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => handleGenerateLink(emp)}
                                  disabled={generating === emp.id}
                                  title="Link neu generieren"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                  <RefreshCw className={cn('h-3.5 w-3.5', generating === emp.id && 'animate-spin')} />
                                </button>
                                <button
                                  onClick={() => handleDelete(conf, emp.name)}
                                  title="Eintrag löschen"
                                  className="h-7 w-7 flex items-center justify-center rounded border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors text-red-400 hover:text-red-600"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleGenerateLink(emp)}
                                disabled={generating === emp.id}
                                className="h-7 px-2.5 flex items-center gap-1 text-[11px] font-medium rounded border border-primary text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                              >
                                {generating === emp.id
                                  ? <RefreshCw className="h-3 w-3 animate-spin" />
                                  : <Link className="h-3 w-3" />
                                }
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
          <span className="flex items-center gap-1"><Check className="h-3 w-3 text-emerald-500" /> Soll = gerechnete Sollstunden auf Basis Wochenstunden</span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Ist = Stunden aus Supabase actual_hours / localStorage</span>
        </div>
      </div>
    </div>
  );
}
