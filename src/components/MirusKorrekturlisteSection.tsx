import { Fragment, useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  ClipboardList, CheckCircle2, AlertTriangle, Download,
  ChevronDown, ChevronRight, Loader2, RotateCcw, X, Clock,
} from 'lucide-react';
import { MONTH_NAMES_DE } from '@/lib/timesheet-store';
import {
  getMirusCorrections,
  getMirusAdjustmentStatuses,
  markMirusAdjustmentDone,
  resetMirusAdjustment,
  type MirusChangeEntry,
  type MirusAdjustmentStatus,
} from '@/lib/mirus-korrekturen-store';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface EmployeeLookup { id: string; name: string; }

interface Props {
  tenantId:  string;
  year:      number;
  month:     number;
  employees: EmployeeLookup[];
  userEmail: string | null;
}

interface EmployeeSummary {
  employeeId:       string;
  employeeName:     string;
  correctedDays:    number;
  oldHoursTotal:    number;
  newHoursTotal:    number;
  diffHours:        number;
  timeBlockChanges: number;
  status:           'open' | 'done';
  statusRecord:     MirusAdjustmentStatus | null;
  entries:          MirusChangeEntry[];
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const CHANGE_TYPE_LABEL: Record<string, string> = {
  update_daily_hours:           'Tagesstunden geändert',
  update_time_block:            'Zeitblock geändert',
  add_time_block:               'Zeitblock hinzugefügt',
  delete_time_block:            'Zeitblock gelöscht',
  reimport_overwrite_manual:    'Re-Import überschrieben',
  approved_employee_request:    'Antrag genehmigt',
  admin_apply_employee_request: 'Antrag übernommen',
};

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function calcDiff(entry: MirusChangeEntry): string {
  if (entry.field_name === 'hours') {
    const oldV = parseFloat(entry.old_value ?? '');
    const newV = parseFloat(entry.new_value ?? '');
    if (!isNaN(oldV) && !isNaN(newV)) {
      const d = Math.round((newV - oldV) * 10) / 10;
      return (d > 0 ? '+' : '') + d.toFixed(1) + ' h';
    }
  }
  return '–';
}

function fmtH(h: number) { return h === 0 ? '–' : h.toFixed(1) + ' h'; }

function fmtDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtDatetime(iso: string) {
  return new Date(iso).toLocaleString('de-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function computeSummaries(
  entries:  MirusChangeEntry[],
  statuses: MirusAdjustmentStatus[],
  emps:     EmployeeLookup[],
): EmployeeSummary[] {
  const byEmp    = new Map<string, MirusChangeEntry[]>();
  const statusMap = new Map(statuses.map(s => [s.employee_id, s]));
  const empMap   = new Map(emps.map(e => [e.id, e.name]));

  for (const e of entries) {
    if (!byEmp.has(e.employee_id)) byEmp.set(e.employee_id, []);
    byEmp.get(e.employee_id)!.push(e);
  }

  return [...byEmp.entries()]
    .map(([empId, empEntries]) => {
      const dates       = new Set(empEntries.map(e => e.date));
      const hourEntries = empEntries.filter(
        e => e.field_name === 'hours' && e.change_type === 'update_daily_hours',
      );
      const oldH = hourEntries.reduce((s, e) => s + (parseFloat(e.old_value ?? '0') || 0), 0);
      const newH = hourEntries.reduce((s, e) => s + (parseFloat(e.new_value ?? '0') || 0), 0);
      const blockChanges = empEntries.filter(e => e.change_type.includes('time_block')).length;
      const statusRec    = statusMap.get(empId) ?? null;
      return {
        employeeId:       empId,
        employeeName:     empMap.get(empId) ?? empId,
        correctedDays:    dates.size,
        oldHoursTotal:    Math.round(oldH * 10) / 10,
        newHoursTotal:    Math.round(newH * 10) / 10,
        diffHours:        Math.round((newH - oldH) * 10) / 10,
        timeBlockChanges: blockChanges,
        status:           statusRec?.status ?? 'open',
        statusRecord:     statusRec,
        entries:          empEntries,
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'de'));
}

function exportCSV(
  entries:  MirusChangeEntry[],
  emps:     EmployeeLookup[],
  year:     number,
  month:    number,
) {
  const empMap = new Map(emps.map(e => [e.id, e.name]));
  const header = [
    'Mitarbeiter', 'Datum', 'Änderungstyp',
    'Alter Wert', 'Neuer Wert', 'Differenz',
    'Bemerkung', 'Geändert durch', 'Geändert am',
  ];
  const rows = entries.map(e => [
    empMap.get(e.employee_id) ?? e.employee_id,
    fmtDate(e.date),
    CHANGE_TYPE_LABEL[e.change_type] ?? e.change_type,
    e.old_value ?? '',
    e.new_value ?? '',
    calcDiff(e),
    e.reason ?? '',
    e.changed_by ?? '',
    fmtDatetime(e.changed_at),
  ]);
  const csv = [header, ...rows]
    .map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `Mirus-Korrekturliste_${year}-${String(month).padStart(2, '0')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Komponente ───────────────────────────────────────────────────────────────

export default function MirusKorrekturlisteSection({
  tenantId, year, month, employees, userEmail,
}: Props) {
  const [loading, setLoading]     = useState(true);
  const [entries, setEntries]     = useState<MirusChangeEntry[]>([]);
  const [statuses, setStatuses]   = useState<MirusAdjustmentStatus[]>([]);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [filterEmp, setFilterEmp] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'done'>('open');
  const [marking, setMarking]     = useState<string | null>(null);
  const [markNote, setMarkNote]   = useState('');
  const [savingId, setSavingId]   = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [e, s] = await Promise.all([
        getMirusCorrections(tenantId, year, month),
        getMirusAdjustmentStatuses(tenantId, year, month),
      ]);
      setEntries(e);
      setStatuses(s);
    } catch (err) {
      console.error('[MirusKorrekturliste] loadData:', err);
    } finally {
      setLoading(false);
    }
  }, [tenantId, year, month]);

  useEffect(() => { loadData(); }, [loadData]);

  // Reset filters when month/year changes
  useEffect(() => {
    setExpanded(new Set());
    setMarking(null);
    setMarkNote('');
  }, [tenantId, year, month]);

  const summaries = computeSummaries(entries, statuses, employees);

  const filteredSummaries = summaries.filter(s => {
    if (filterEmp !== 'all' && s.employeeId !== filterEmp) return false;
    if (filterStatus !== 'all' && s.status !== filterStatus) return false;
    return true;
  });

  const openCount = summaries.filter(s => s.status === 'open').length;

  function toggleExpand(empId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  }

  async function handleMarkDone(empId: string) {
    setSavingId(empId);
    try {
      await markMirusAdjustmentDone(empId, year, month, markNote.trim() || null, userEmail);
      toast.success('Als in Mirus angepasst markiert');
      setMarking(null);
      setMarkNote('');
      await loadData();
    } catch {
      toast.error('Fehler beim Speichern');
    } finally {
      setSavingId(null);
    }
  }

  async function handleReset(empId: string) {
    if (!confirm('Mirus-Status zurücksetzen auf "offen"?')) return;
    try {
      await resetMirusAdjustment(empId, year, month);
      toast.success('Status zurückgesetzt');
      await loadData();
    } catch {
      toast.error('Fehler beim Zurücksetzen');
    }
  }

  const exportEntries = filterEmp !== 'all'
    ? entries.filter(e => e.employee_id === filterEmp)
    : entries;

  // Abschnitt ausblenden wenn keine Korrekturen vorhanden
  if (!loading && entries.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">

      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-primary shrink-0" />
          <h3 className="text-sm font-semibold">Mirus-Korrekturliste</h3>
          {!loading && summaries.length > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted border border-border text-muted-foreground">
              {summaries.length} {summaries.length === 1 ? 'Mitarbeiter' : 'Mitarbeiter'} · {entries.length} {entries.length === 1 ? 'Eintrag' : 'Einträge'}
            </span>
          )}
        </div>
        <button
          onClick={() => exportCSV(exportEntries, employees, year, month)}
          disabled={loading || entries.length === 0}
          className="h-7 px-3 text-[11px] font-medium rounded-md border border-border hover:bg-muted transition-colors flex items-center gap-1.5 disabled:opacity-40"
        >
          <Download className="h-3 w-3" />Export CSV
        </button>
      </div>

      {/* Banner: offene Korrekturen */}
      {!loading && openCount > 0 && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Für <strong>{MONTH_NAMES_DE[month - 1]} {year}</strong> gibt es Korrekturen bei{' '}
            <strong>{openCount} {openCount === 1 ? 'Mitarbeiter' : 'Mitarbeitern'}</strong>,
            die noch nicht in Mirus nachgetragen wurden.
          </span>
        </div>
      )}

      {/* Filter */}
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap">
        <select
          value={filterEmp}
          onChange={e => setFilterEmp(e.target.value)}
          className="text-xs border border-border rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary h-7 min-w-[160px]"
        >
          <option value="all">Alle Mitarbeiter</option>
          {summaries.map(s => (
            <option key={s.employeeId} value={s.employeeId}>{s.employeeName}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as 'all' | 'open' | 'done')}
          className="text-xs border border-border rounded-md px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary h-7"
        >
          <option value="open">Offen</option>
          <option value="done">Erledigt</option>
          <option value="all">Alle</option>
        </select>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />Lade Korrekturen…
        </div>
      ) : filteredSummaries.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-emerald-500 opacity-60" />
          {filterStatus === 'open'
            ? 'Keine offenen Korrekturen — alles in Mirus nachgetragen.'
            : 'Keine Einträge für diesen Filter.'}
        </div>
      ) : (
        <div className="pb-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground">Mitarbeiter</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Tage</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground hidden md:table-cell">Alte h</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground hidden md:table-cell">Neue h</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Diff</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground hidden lg:table-cell">Zeitbl.</th>
                  <th className="px-3 py-2 text-center text-xs font-semibold text-muted-foreground">Mirus</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {filteredSummaries.map(s => {
                  const isExpanded = expanded.has(s.employeeId);
                  const isMarking  = marking === s.employeeId;
                  const diff       = s.diffHours;
                  return (
                    <Fragment key={s.employeeId}>
                      {/* Summary row */}
                      <tr className="hover:bg-muted/10 transition-colors">
                        <td className="px-4 py-2.5">
                          <button
                            onClick={() => toggleExpand(s.employeeId)}
                            className="flex items-center gap-1.5 text-left hover:text-primary transition-colors"
                          >
                            {isExpanded
                              ? <ChevronDown  className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                            <span className="font-medium text-sm">{s.employeeName}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs font-medium">
                          {s.correctedDays}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-muted-foreground hidden md:table-cell">
                          {fmtH(s.oldHoursTotal)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-muted-foreground hidden md:table-cell">
                          {fmtH(s.newHoursTotal)}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs font-semibold">
                          <span className={cn(
                            diff === 0 ? 'text-muted-foreground'
                              : diff > 0 ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400',
                          )}>
                            {diff === 0 ? '–' : (diff > 0 ? '+' : '') + diff.toFixed(1) + ' h'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-xs text-muted-foreground hidden lg:table-cell">
                          {s.timeBlockChanges > 0 ? s.timeBlockChanges : '–'}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {s.status === 'done' ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                              <CheckCircle2 className="h-2.5 w-2.5" />Erledigt
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                              <Clock className="h-2.5 w-2.5" />Offen
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {s.status === 'open' ? (
                              <button
                                onClick={() => { setMarking(s.employeeId); setMarkNote(''); }}
                                className="h-6 px-2.5 text-[11px] font-medium rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 transition-colors whitespace-nowrap"
                              >
                                Markieren
                              </button>
                            ) : (
                              <button
                                onClick={() => handleReset(s.employeeId)}
                                title="Zurücksetzen auf offen"
                                className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              >
                                <RotateCcw className="h-3 w-3" />
                              </button>
                            )}
                            <button
                              onClick={() => toggleExpand(s.employeeId)}
                              title={isExpanded ? 'Einklappen' : 'Details anzeigen'}
                              className="h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            >
                              {isExpanded
                                ? <ChevronDown  className="h-3 w-3" />
                                : <ChevronRight className="h-3 w-3" />}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Inline mark-done form */}
                      {isMarking && (
                        <tr className="bg-emerald-50/50 dark:bg-emerald-950/10">
                          <td colSpan={8} className="px-4 py-2.5 border-b border-emerald-100 dark:border-emerald-900/50">
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                                Als in Mirus angepasst markieren
                              </span>
                              <input
                                type="text"
                                value={markNote}
                                onChange={e => setMarkNote(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleMarkDone(s.employeeId); }}
                                placeholder="Optionale Notiz (z.B. Buchungsdatum)…"
                                className="flex-1 min-w-[180px] text-xs border border-border rounded px-2.5 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary h-7"
                              />
                              <div className="flex gap-1.5 shrink-0">
                                <button
                                  onClick={() => handleMarkDone(s.employeeId)}
                                  disabled={savingId === s.employeeId}
                                  className="h-7 px-3 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 disabled:opacity-60"
                                >
                                  {savingId === s.employeeId && <Loader2 className="h-3 w-3 animate-spin" />}
                                  Bestätigen
                                </button>
                                <button
                                  onClick={() => setMarking(null)}
                                  className="h-7 w-7 flex items-center justify-center rounded border border-border hover:bg-muted text-muted-foreground transition-colors"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}

                      {/* Detail rows */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className="p-0">
                            <div className="border-t border-border/40 bg-muted/5">
                              {/* Done-info */}
                              {s.status === 'done' && s.statusRecord && (
                                <div className="px-4 py-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/10 border-b border-emerald-100 dark:border-emerald-900/40 flex items-center gap-1.5 flex-wrap">
                                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                                  <span>
                                    In Mirus eingetragen am {fmtDatetime(s.statusRecord.marked_done_at!)}
                                    {s.statusRecord.marked_done_by && (
                                      <span> von <strong>{s.statusRecord.marked_done_by}</strong></span>
                                    )}
                                    {s.statusRecord.note && (
                                      <span> · <em>{s.statusRecord.note}</em></span>
                                    )}
                                  </span>
                                </div>
                              )}
                              {/* Detail-Tabelle */}
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="bg-muted/30">
                                      <th className="px-4 py-1.5 text-left font-semibold text-muted-foreground">Datum</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Änderungstyp</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground hidden sm:table-cell">Alter Wert</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground hidden sm:table-cell">Neuer Wert</th>
                                      <th className="px-3 py-1.5 text-right font-semibold text-muted-foreground">Diff</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground hidden lg:table-cell">Bemerkung</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground hidden xl:table-cell">Geändert durch</th>
                                      <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground hidden xl:table-cell">Geändert am</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-border/30">
                                    {s.entries.map(entry => {
                                      const d = calcDiff(entry);
                                      return (
                                        <tr key={entry.id} className="hover:bg-muted/10">
                                          <td className="px-4 py-1.5 whitespace-nowrap font-medium">
                                            {fmtDate(entry.date)}
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground">
                                            {CHANGE_TYPE_LABEL[entry.change_type] ?? entry.change_type}
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">
                                            {entry.old_value ? (
                                              entry.change_type === 'delete_time_block'
                                                ? <span className="text-red-500 line-through">{entry.old_value}</span>
                                                : entry.old_value
                                            ) : '–'}
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">
                                            {entry.new_value
                                              ? entry.change_type === 'add_time_block'
                                                ? <span className="text-emerald-600 dark:text-emerald-400">{entry.new_value}</span>
                                                : entry.new_value
                                              : <span className="text-red-500 italic">gelöscht</span>}
                                          </td>
                                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                                            <span className={cn(
                                              d.startsWith('+') ? 'text-emerald-600 dark:text-emerald-400'
                                                : d.startsWith('-') ? 'text-red-600 dark:text-red-400'
                                                : 'text-muted-foreground',
                                            )}>
                                              {d}
                                            </span>
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground hidden lg:table-cell max-w-[200px] truncate" title={entry.reason ?? ''}>
                                            {entry.reason ?? '–'}
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground hidden xl:table-cell">
                                            {entry.changed_by ?? '–'}
                                          </td>
                                          <td className="px-3 py-1.5 text-muted-foreground hidden xl:table-cell whitespace-nowrap">
                                            {fmtDatetime(entry.changed_at)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
