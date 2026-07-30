/**
 * MirusReconcileImportButton
 * ==========================
 * Neuer MIRUS-Ist-Stunden-Import — Modus «MIRUS überschreibt mit Rückfragen».
 *
 * Ablauf:
 *   1. Datei parsen + Scope-Check (ein Monat, sonst Abbruch)
 *   2. Namen matchen (gespeicherte Zuordnungen + Kaskade, Dialog für offene)
 *   3. Abgleich-Plan bauen (nur erfassungsart='MIRUS'-Mitarbeiter)
 *   4. Rückfrage-Liste bei Konflikten (Typ A: MIRUS 0 vs. Stunden,
 *      Typ B: MIRUS Stunden vs. Absenz) — NICHTS wird vorher geschrieben
 *   5. Bestätigen → Backup (dienstplan_ist_backup) → Schreiben → Abgleich-Übersicht
 *   6. «Rückgängig» stellt den Stand vor dem letzten Import wieder her
 *
 * MANUELL-Mitarbeiter (Aushilfen) werden NIE angefasst — auch nicht im lokalen State.
 * Tenant-generisch: funktioniert für Oliv und Beaulieu.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Upload, FileSpreadsheet, AlertTriangle, Undo2, ClipboardList, ShieldCheck, Check, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

import { Employee, MirusDailyImportEntry } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import { matchEmployeeByName, saveNameMappingsBatch } from '@/lib/mirus-name-mapping-store';
import {
  ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride,
} from '@/components/schedule-planner/ImportMatchPreviewDialog';
import {
  checkMirusScope, buildMirusReconcilePlan, resolvePlanToWrites, expectedAfterTotals,
  MirusReconcilePlan, MirusResolvedEntry, MirusCellPlan,
} from '@/lib/mirus-import-engine';
import {
  saveDienstplanIstBackup, loadLatestDienstplanIstBackup, deleteDienstplanIstBackup,
  updateEmployeeErfassungsart, DienstplanIstBackupRow, saveActualHourEntry,
} from '@/lib/supabase-db';
import { ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { useTenant } from '@/contexts/TenantContext';

// ─── Abgleich-Report (nach Import, persistiert je Mandant+Monat) ─────────────

export interface MirusImportReport {
  timestamp: string;
  month: string;
  fileName: string;
  perEmployee: Array<{
    name: string;
    fileTotal: number;
    beforeTotal: number;
    afterTotal: number;
    delta: number;
    warn: boolean; // |after - file| > 0.02 × Tage → Gegenprüfung fehlgeschlagen
  }>;
  autoChanges: Array<{ name: string; date: string; oldVal: string; newVal: string }>;
  conflictDecisions: Array<{ name: string; date: string; type: 'A' | 'B'; planVal: string; mirusVal: string; chosen: 'mirus' | 'dienstplan' }>;
  skippedManual: Array<{ name: string; fileTotal: number }>;
  manualUntouchedCount: number;
}

const reportStorageKey = (month: string) => `mirus-import-report-${month}`;

function fmtEntry(e: { hours?: number; absenceType?: string | null } | null): string {
  if (!e) return 'leer';
  const h = (e.hours ?? 0) > 0 ? `${(e.hours ?? 0).toFixed(2)} h` : '';
  const a = e.absenceType ? `${e.absenceType}` : '';
  return [h, a].filter(Boolean).join(' + ') || '0';
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  employees: Employee[];
  actualHoursData: Record<string, ActualHoursEntry>;
  currentMonth: Date;
  /** Schreibt eine Zelle in State + localStorage + Supabase (bestehender Planner-Pfad). */
  onCellChange: (employeeId: string, date: string, entry: ActualHoursEntry | null, opts?: { skipSupabase?: boolean }) => void;
  /** Meldet persistierte erfassungsart-Defaults zurück (lokalen Employee-State aktualisieren). */
  onErfassungsartPersisted?: (updates: Record<string, 'MIRUS' | 'MANUELL'>) => void;
}

export function MirusReconcileImportButton({
  employees, actualHoursData, currentMonth, onCellChange, onErfassungsartPersisted,
}: Props) {
  const { tenantId, tenantKey } = useTenant();
  const inputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [parsedEntries, setParsedEntries] = useState<MirusDailyImportEntry[]>([]);
  const [scopeDates, setScopeDates] = useState<string[]>([]);
  const [scopeMonth, setScopeMonth] = useState('');

  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [nameMatches, setNameMatches] = useState<NameMatchInfo[]>([]);

  const [plan, setPlan] = useState<MirusReconcilePlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [showAutoList, setShowAutoList] = useState(false);

  const [report, setReport] = useState<MirusImportReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  // Undo-Verfügbarkeit hängt am DB-Backup, NICHT am localStorage-Report.
  const [hasBackup, setHasBackup] = useState(false);

  const monthKey = format(currentMonth, 'yyyy-MM');

  useEffect(() => {
    let alive = true;
    loadLatestDienstplanIstBackup(tenantId, monthKey)
      .then(b => { if (alive) setHasBackup(!!b); })
      .catch(() => { if (alive) setHasBackup(false); });
    return () => { alive = false; };
  }, [tenantId, monthKey, report]);

  const lastReport: MirusImportReport | null = useMemo(() => {
    try {
      const raw = localStorage.getItem(tenantKey(reportStorageKey(monthKey)));
      return raw ? JSON.parse(raw) as MirusImportReport : null;
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, tenantKey, report]);

  // ── Schritt 1+2: Datei parsen, Scope prüfen, Namen matchen ────────────────

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (inputRef.current) inputRef.current.value = '';
    setBusy(true);
    try {
      const result = await parseMirusDailyExcel(file);
      if (result.failureReason) {
        toast.error(`Import gestoppt: ${result.failureReason}`);
        return;
      }
      if (result.entries.length === 0) {
        toast.error('Keine Ist-Stunden gefunden. Erwartet wird der Mirus-Export «Tägliche Stunden» mit Zeitraum «von … bis …».');
        return;
      }
      const scope = checkMirusScope(result.dateRange.length > 0 ? result.dateRange : result.entries.map(e => e.date));
      if (!scope.ok || !scope.month || !scope.dates) {
        toast.error(scope.error ?? 'Scope-Prüfung fehlgeschlagen.');
        return;
      }
      if (scope.month !== monthKey) {
        toast.error(`Datei betrifft ${scope.month}, angezeigt ist aber ${monthKey}. Bitte zuerst zum richtigen Monat wechseln — es wurde nichts geschrieben.`);
        return;
      }
      setFileName(file.name);
      setParsedEntries(result.entries);
      setScopeDates(scope.dates);
      setScopeMonth(scope.month);

      const uniqueNames = [...new Set(result.entries.map(e => e.name))];
      const matches: NameMatchInfo[] = uniqueNames.map(name => {
        const m = matchEmployeeByName(name, employees, false);
        const unresolved = !m.employee || m.matchType === 'conflict';
        return {
          importedName: name,
          matchedEmployee: unresolved ? null : m.employee,
          matchType: unresolved ? 'new' : (m.matchType === 'saved' ? 'exact' : m.matchType) as NameMatchInfo['matchType'],
          isNew: unresolved,
        };
      });
      const unresolved = matches.filter(m => m.isNew);
      if (unresolved.length > 0) {
        setNameMatches(matches);
        setMatchDialogOpen(true);
      } else {
        buildPlanFromMatches(matches.map(m => ({
          importedName: m.importedName,
          selectedEmployeeId: m.matchedEmployee?.id ?? 'skip',
        })), result.entries, scope.month, scope.dates);
      }
    } catch (err) {
      toast.error(`Fehler beim Lesen der Datei: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Schritt 3: Plan bauen ─────────────────────────────────────────────────

  const buildPlanFromMatches = (
    overrides: NameMatchOverride[],
    entries: MirusDailyImportEntry[],
    month: string,
    dates: string[],
  ) => {
    saveNameMappingsBatch(
      overrides.filter(o => o.selectedEmployeeId !== 'new')
        .map(o => ({ importedName: o.importedName, employeeId: o.selectedEmployeeId || 'skip' })),
    );
    const nameToEmp = new Map<string, Employee>();
    for (const o of overrides) {
      if (o.selectedEmployeeId && o.selectedEmployeeId !== 'skip' && o.selectedEmployeeId !== 'new') {
        const emp = employees.find(e => e.id === o.selectedEmployeeId);
        if (emp) nameToEmp.set(o.importedName, emp);
      }
    }
    const skippedNames = overrides.filter(o => o.selectedEmployeeId === 'skip' || o.selectedEmployeeId === 'new').map(o => o.importedName);
    if (skippedNames.length > 0) {
      toast.warning(`Ohne Zuordnung (werden übersprungen): ${skippedNames.join(', ')}`);
    }

    const resolved: MirusResolvedEntry[] = [];
    for (const e of entries) {
      const emp = nameToEmp.get(e.name);
      if (!emp) continue;
      resolved.push({ employeeId: emp.id, employeeName: emp.name, date: e.date, hours: e.hours });
    }

    // Effektive Erfassungsart: expliziter Wert gewinnt; Default: in Datei = MIRUS.
    const erfassungsart: Record<string, 'MIRUS' | 'MANUELL'> = {};
    const fileEmpIds = new Set(resolved.map(r => r.employeeId));
    for (const emp of employees) {
      erfassungsart[emp.id] = emp.erfassungsart ?? (fileEmpIds.has(emp.id) ? 'MIRUS' : 'MANUELL');
    }

    const p = buildMirusReconcilePlan({ entries: resolved, existing: actualHoursData, erfassungsart, month, dates });
    setPlan(p);
    setPlanOpen(true);
    setMatchDialogOpen(false);
  };

  // ── Konflikt-Auflösung im Dialog ──────────────────────────────────────────

  const setResolution = (cell: MirusCellPlan, resolution: 'mirus' | 'keep') => {
    setPlan(prev => {
      if (!prev) return prev;
      const clone: MirusReconcilePlan = {
        ...prev,
        employees: prev.employees.map(emp => ({
          ...emp,
          cells: emp.cells.map(c =>
            c.employeeId === cell.employeeId && c.date === cell.date ? { ...c, resolution } : c),
        })),
      };
      clone.conflicts = clone.employees.flatMap(e => e.cells.filter(c => c.decision === 'conflict_a' || c.decision === 'conflict_b'));
      clone.autoChanges = clone.employees.flatMap(e => e.cells.filter(c => c.decision === 'auto_take'));
      return clone;
    });
  };

  const setAllResolutions = (resolution: 'mirus' | 'keep') => {
    setPlan(prev => {
      if (!prev) return prev;
      const clone: MirusReconcilePlan = {
        ...prev,
        employees: prev.employees.map(emp => ({
          ...emp,
          cells: emp.cells.map(c =>
            (c.decision === 'conflict_a' || c.decision === 'conflict_b') ? { ...c, resolution } : c),
        })),
      };
      clone.conflicts = clone.employees.flatMap(e => e.cells.filter(c => c.decision === 'conflict_a' || c.decision === 'conflict_b'));
      clone.autoChanges = clone.employees.flatMap(e => e.cells.filter(c => c.decision === 'auto_take'));
      return clone;
    });
  };

  // ── Schritt 5: Bestätigen → Backup → Schreiben → Report ──────────────────

  const handleConfirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      // 1) Backup: kompletter Ist-Stand aller Plan-MA × Datei-Tage (vor dem Schreiben)
      const empIds = plan.employees.map(e => e.employeeId);
      const backupRows: DienstplanIstBackupRow[] = [];
      for (const empId of empIds) {
        for (const date of plan.dates) {
          const entry = actualHoursData[`${empId}-${date}`];
          if (entry) {
            backupRows.push({
              employee_id: empId, date, hours: entry.hours,
              start_time: entry.start ?? null, end_time: entry.end ?? null,
              absence_type: entry.absenceType ?? null,
              is_additional_cost_ist: entry.isAdditionalCost ?? false,
              source: entry.source ?? null,
            });
          }
        }
      }
      const backupId = await saveDienstplanIstBackup(
        tenantId, plan.month, `MIRUS-Import ${fileName}`,
        { employeeIds: empIds, dates: plan.dates }, backupRows,
      );
      if (!backupId) {
        toast.error('Backup konnte nicht gespeichert werden — Import abgebrochen, es wurde nichts geschrieben.');
        return;
      }

      // 2) Schreiben (nur effektive Änderungen; MANUELL-MA werden nie berührt).
      // Supabase-Write pro Zelle awaited + geprüft; State/localStorage erst nach Erfolg.
      const writes = resolvePlanToWrites(plan);
      const failed: string[] = [];
      let written = 0;
      for (const op of writes) {
        const entry: ActualHoursEntry | null = op.entry ? {
          hours: op.entry.hours,
          ...(op.entry.absenceType ? { absenceType: op.entry.absenceType as ActualHoursEntry['absenceType'] } : {}),
          source: 'import',
        } : null;
        const res = await saveActualHourEntry(op.employeeId, op.date, entry);
        if (res.ok) {
          onCellChange(op.employeeId, op.date, entry, { skipSupabase: true });
          written++;
        } else {
          failed.push(`${op.employeeId} ${op.date}`);
        }
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} von ${writes.length} Zellen konnten nicht gespeichert werden. Backup bleibt erhalten — bitte «Rückgängig» nutzen oder erneut importieren. (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''})`);
        setPlanOpen(false);
        setPlan(null);
        return;
      }

      // 3) Erfassungsart-Defaults persistieren (nur wo noch NULL)
      const updates: Record<string, 'MIRUS' | 'MANUELL'> = {};
      const fileEmpIds = new Set(plan.employees.map(e => e.employeeId));
      for (const emp of employees) {
        if (emp.erfassungsart) continue;
        updates[emp.id] = fileEmpIds.has(emp.id) ? 'MIRUS' : 'MANUELL';
      }
      const results = await Promise.all(
        Object.entries(updates).map(async ([id, v]) => [id, await updateEmployeeErfassungsart(id, v)] as const),
      );
      const persisted: Record<string, 'MIRUS' | 'MANUELL'> = {};
      for (const [id, ok] of results) if (ok) persisted[id] = updates[id];
      if (Object.keys(persisted).length > 0) onErfassungsartPersisted?.(persisted);

      // 4) Abgleich-Übersicht bauen
      const after = expectedAfterTotals(plan);
      const manuellCount = employees.filter(e => (e.erfassungsart ?? persisted[e.id]) === 'MANUELL').length;
      const rep: MirusImportReport = {
        timestamp: new Date().toISOString(),
        month: plan.month,
        fileName,
        perEmployee: plan.employees.map(e => {
          const a = after[e.employeeId] ?? 0;
          return {
            name: e.employeeName,
            fileTotal: e.fileTotal,
            beforeTotal: e.beforeTotal,
            afterTotal: a,
            delta: Math.round((a - e.beforeTotal) * 100) / 100,
            // ±0.02 h Tagesrundung pro Tag Toleranz auf dem Monatstotal
            warn: Math.abs(a - e.fileTotal) > 0.02 * plan.dates.length + 0.005,
          };
        }),
        autoChanges: plan.autoChanges.map(c => ({
          name: c.employeeName, date: c.date, oldVal: fmtEntry(c.before), newVal: `${c.fileHours.toFixed(2)} h`,
        })),
        conflictDecisions: plan.conflicts.map(c => ({
          name: c.employeeName, date: c.date,
          type: c.decision === 'conflict_a' ? 'A' as const : 'B' as const,
          planVal: fmtEntry(c.before),
          mirusVal: c.fileHours > 0 ? `${c.fileHours.toFixed(2)} h` : 'frei (0)',
          chosen: c.resolution === 'mirus' ? 'mirus' as const : 'dienstplan' as const,
        })),
        skippedManual: plan.skippedManual.map(s => ({ name: s.employeeName, fileTotal: s.fileTotal })),
        manualUntouchedCount: manuellCount,
      };
      try { localStorage.setItem(tenantKey(reportStorageKey(plan.month)), JSON.stringify(rep)); } catch { /* voll */ }
      setReport(rep);
      setPlanOpen(false);
      setPlan(null);
      setReportOpen(true);
      const warnCount = rep.perEmployee.filter(p => p.warn).length;
      toast.success(`MIRUS-Import gespeichert: ${written} Zellen geschrieben, Backup angelegt.${warnCount ? ` ${warnCount} Warnung(en) in der Gegenprüfung!` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Undo ──────────────────────────────────────────────────────────────────

  const handleUndo = async () => {
    setUndoBusy(true);
    try {
      const backup = await loadLatestDienstplanIstBackup(tenantId, monthKey);
      if (!backup) {
        toast.error(`Kein Backup für ${monthKey} gefunden.`);
        return;
      }
      const rowMap = new Map(backup.rows.map(r => [`${r.employee_id}-${r.date}`, r]));
      let restored = 0;
      const failed: string[] = [];
      for (const empId of backup.scope.employeeIds) {
        for (const date of backup.scope.dates) {
          const row = rowMap.get(`${empId}-${date}`);
          const current = actualHoursData[`${empId}-${date}`];
          const target: ActualHoursEntry | null = row ? {
            hours: Number(row.hours),
            ...(row.start_time ? { start: row.start_time } : {}),
            ...(row.end_time ? { end: row.end_time } : {}),
            ...(row.absence_type ? { absenceType: row.absence_type as ActualHoursEntry['absenceType'] } : {}),
            ...(row.is_additional_cost_ist ? { isAdditionalCost: true } : {}),
            ...(row.source ? { source: row.source as ActualHoursEntry['source'] } : {}),
          } : null;
          const changed = JSON.stringify(current ?? null) !== JSON.stringify(target);
          if (!changed) continue;
          // Supabase-Write awaited + geprüft; State erst nach Erfolg.
          const res = await saveActualHourEntry(empId, date, target);
          if (res.ok) {
            onCellChange(empId, date, target, { skipSupabase: true });
            restored++;
          } else {
            failed.push(`${empId} ${date}`);
          }
        }
      }
      if (failed.length > 0) {
        // Backup NICHT löschen — Wiederherstellung war unvollständig.
        toast.error(`Rückgängig unvollständig: ${failed.length} Zellen konnten nicht zurückgesetzt werden. Backup bleibt erhalten — bitte erneut versuchen. (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''})`);
        return;
      }
      await deleteDienstplanIstBackup(backup.id);
      setHasBackup(false);
      try { localStorage.removeItem(tenantKey(reportStorageKey(monthKey))); } catch { /* noop */ }
      setReport(null);
      toast.success(`Rückgängig: ${restored} Zellen auf den Stand vor dem Import (${format(new Date(backup.created_at), 'dd.MM.yyyy HH:mm', { locale: de })}) zurückgesetzt.`);
    } finally {
      setUndoBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const conflictsA = plan?.conflicts.filter(c => c.decision === 'conflict_a') ?? [];
  const conflictsB = plan?.conflicts.filter(c => c.decision === 'conflict_b') ?? [];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input ref={inputRef} type="file" accept=".xls,.xlsx" onChange={handleFile} className="hidden" data-testid="input-mirus-file" />
      <Button
        variant="outline" size="sm"
        className="gap-2 border-green-500 text-green-600 hover:bg-green-50"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        data-testid="button-mirus-import"
      >
        <Upload className="h-4 w-4" />
        {busy ? 'Verarbeite…' : 'MIRUS importieren'}
      </Button>
      {lastReport && (
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" data-testid="button-mirus-report"
          onClick={() => { setReport(lastReport); setReportOpen(true); }}>
          <ClipboardList className="h-4 w-4" /> Letzter Abgleich
        </Button>
      )}
      {hasBackup && (
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={handleUndo} disabled={undoBusy} data-testid="button-mirus-undo">
          <Undo2 className="h-4 w-4" /> {undoBusy ? 'Stelle wieder her…' : 'Rückgängig'}
        </Button>
      )}

      {/* Namens-Zuordnung für offene Namen */}
      <ImportMatchPreviewDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        nameMatches={nameMatches}
        existingEmployees={employees}
        onConfirm={(ov) => buildPlanFromMatches(ov, parsedEntries, scopeMonth, scopeDates)}
        onCancel={() => { setMatchDialogOpen(false); setParsedEntries([]); }}
      />

      {/* Rückfrage-/Vorschau-Dialog — erst «Import bestätigen» schreibt */}
      <Dialog open={planOpen} onOpenChange={(o) => { setPlanOpen(o); if (!o) setPlan(null); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              MIRUS-Abgleich {plan?.month} — Vorschau
            </DialogTitle>
            <DialogDescription>
              Es wird erst geschrieben, wenn du unten «Import bestätigen» klickst. Vorher wird ein Backup angelegt.
            </DialogDescription>
          </DialogHeader>

          {plan && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">{plan.employees.length} MIRUS-Mitarbeiter</Badge>
                <Badge variant="outline">{plan.dates.length} Tage ({plan.dates[0]?.slice(8)}.–{plan.dates[plan.dates.length - 1]?.slice(8)}.)</Badge>
                <Badge variant="outline" className="text-green-700">{plan.autoChanges.length} automatische Übernahmen</Badge>
                <Badge variant="outline" className={plan.conflicts.length ? 'text-orange-700 border-orange-300' : ''}>{plan.conflicts.length} Rückfragen</Badge>
                {plan.skippedManual.length > 0 && <Badge variant="outline" className="text-muted-foreground">{plan.skippedManual.length} MANUELL übersprungen</Badge>}
              </div>

              {plan.skippedManual.length > 0 && (
                <Alert>
                  <ShieldCheck className="h-4 w-4" />
                  <AlertDescription>
                    Als «Manuell» gekennzeichnet, werden nicht angefasst:{' '}
                    {plan.skippedManual.map(s => `${s.employeeName} (${s.fileTotal.toFixed(2)} h in Datei)`).join(', ')}
                  </AlertDescription>
                </Alert>
              )}

              {/* Konflikte */}
              {plan.conflicts.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-orange-600" />
                      Rückfragen ({conflictsA.length}× MIRUS 0 vs. Stunden, {conflictsB.length}× MIRUS Stunden vs. Absenz)
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setAllResolutions('mirus')} data-testid="button-all-mirus">Alle MIRUS übernehmen</Button>
                      <Button variant="outline" size="sm" onClick={() => setAllResolutions('keep')} data-testid="button-all-keep">Alle Dienstplan behalten</Button>
                    </div>
                  </div>
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted">
                          <TableHead>Mitarbeiter</TableHead>
                          <TableHead>Datum</TableHead>
                          <TableHead>Typ</TableHead>
                          <TableHead>Dienstplan</TableHead>
                          <TableHead>MIRUS</TableHead>
                          <TableHead>Auswahl</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {plan.conflicts.map((c, i) => (
                          <TableRow key={`${c.employeeId}-${c.date}`} data-testid={`row-conflict-${i}`}>
                            <TableCell className="py-1.5 font-medium">{c.employeeName}</TableCell>
                            <TableCell className="py-1.5">{format(new Date(c.date), 'dd.MM.', { locale: de })}</TableCell>
                            <TableCell className="py-1.5">
                              <Badge variant="outline" className={c.decision === 'conflict_a' ? 'text-blue-700' : 'text-purple-700'}>
                                {c.decision === 'conflict_a' ? 'A: 0 vs. Std.' : 'B: Std. vs. Absenz'}
                              </Badge>
                            </TableCell>
                            <TableCell className="py-1.5">{fmtEntry(c.before)}</TableCell>
                            <TableCell className="py-1.5">{c.fileHours > 0 ? `${c.fileHours.toFixed(2)} h` : 'frei (0)'}</TableCell>
                            <TableCell className="py-1.5">
                              <div className="flex gap-1">
                                <Button size="sm" variant={c.resolution === 'mirus' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                  onClick={() => setResolution(c, 'mirus')} data-testid={`button-take-mirus-${i}`}>
                                  <Check className="h-3 w-3 mr-1" /> MIRUS
                                </Button>
                                <Button size="sm" variant={c.resolution === 'keep' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                  onClick={() => setResolution(c, 'keep')} data-testid={`button-keep-plan-${i}`}>
                                  <X className="h-3 w-3 mr-1" /> Dienstplan
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {/* Totale je MA */}
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead>Mitarbeiter</TableHead>
                      <TableHead className="text-right">MIRUS (Datei)</TableHead>
                      <TableHead className="text-right">Dienstplan aktuell</TableHead>
                      <TableHead className="text-right">Änderungen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.employees.map(e => {
                      const changes = e.cells.filter(c => c.decision === 'auto_take'
                        || ((c.decision === 'conflict_a' || c.decision === 'conflict_b') && c.resolution === 'mirus')).length;
                      return (
                        <TableRow key={e.employeeId}>
                          <TableCell className="py-1.5 font-medium">{e.employeeName}</TableCell>
                          <TableCell className="py-1.5 text-right">{e.fileTotal.toFixed(2)}</TableCell>
                          <TableCell className="py-1.5 text-right">{e.beforeTotal.toFixed(2)}</TableCell>
                          <TableCell className="py-1.5 text-right">{changes > 0 ? `${changes} Zellen` : '—'}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Automatische Übernahmen (einklappbar) */}
              {plan.autoChanges.length > 0 && (
                <div>
                  <Button variant="ghost" size="sm" onClick={() => setShowAutoList(s => !s)} data-testid="button-toggle-autolist">
                    {showAutoList ? 'Automatische Übernahmen ausblenden' : `${plan.autoChanges.length} automatische Übernahmen anzeigen`}
                  </Button>
                  {showAutoList && (
                    <div className="rounded-lg border overflow-hidden mt-2 max-h-64 overflow-y-auto">
                      <Table>
                        <TableBody>
                          {plan.autoChanges.map(c => (
                            <TableRow key={`${c.employeeId}-${c.date}`}>
                              <TableCell className="py-1">{c.employeeName}</TableCell>
                              <TableCell className="py-1">{format(new Date(c.date), 'dd.MM.', { locale: de })}</TableCell>
                              <TableCell className="py-1 text-muted-foreground">{fmtEntry(c.before)} → {c.fileHours.toFixed(2)} h</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setPlanOpen(false); setPlan(null); }} data-testid="button-cancel-import">Abbrechen</Button>
            <Button onClick={handleConfirm} disabled={busy} className="bg-green-600 hover:bg-green-700" data-testid="button-confirm-import">
              {busy ? 'Importiere…' : 'Import bestätigen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Abgleich-Übersicht nach dem Import */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-green-600" />
              MIRUS-Abgleich {report?.month}
            </DialogTitle>
            {report && (
              <DialogDescription>
                {report.fileName} · importiert {format(new Date(report.timestamp), 'dd.MM.yyyy HH:mm', { locale: de })}
              </DialogDescription>
            )}
          </DialogHeader>
          {report && (
            <div className="space-y-4">
              {report.perEmployee.some(p => p.warn) && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Gegenprüfung fehlgeschlagen bei: {report.perEmployee.filter(p => p.warn).map(p => p.name).join(', ')} — gespeichertes Total weicht mehr als die Tagesrundung von der Datei ab (z. B. wegen «Dienstplan behalten»-Entscheidungen).
                  </AlertDescription>
                </Alert>
              )}
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead>Mitarbeiter</TableHead>
                      <TableHead className="text-right">MIRUS (Datei)</TableHead>
                      <TableHead className="text-right">Vorher</TableHead>
                      <TableHead className="text-right">Gespeichert</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.perEmployee.map(p => (
                      <TableRow key={p.name} className={p.warn ? 'bg-red-50 dark:bg-red-950/20' : ''} data-testid={`row-report-${p.name}`}>
                        <TableCell className="py-1.5 font-medium">{p.name}{p.warn && <AlertTriangle className="h-3.5 w-3.5 inline ml-1.5 text-red-600" />}</TableCell>
                        <TableCell className="py-1.5 text-right">{p.fileTotal.toFixed(2)}</TableCell>
                        <TableCell className="py-1.5 text-right">{p.beforeTotal.toFixed(2)}</TableCell>
                        <TableCell className="py-1.5 text-right font-medium">{p.afterTotal.toFixed(2)}</TableCell>
                        <TableCell className={`py-1.5 text-right ${Math.abs(p.delta) > 0.005 ? 'font-medium' : 'text-muted-foreground'}`}>
                          {p.delta > 0 ? '+' : ''}{p.delta.toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {report.conflictDecisions.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-1.5">Konflikt-Entscheidungen</p>
                  <div className="rounded-lg border overflow-hidden max-h-56 overflow-y-auto">
                    <Table>
                      <TableBody>
                        {report.conflictDecisions.map((c, i) => (
                          <TableRow key={i}>
                            <TableCell className="py-1">{c.name}</TableCell>
                            <TableCell className="py-1">{format(new Date(c.date), 'dd.MM.', { locale: de })}</TableCell>
                            <TableCell className="py-1"><Badge variant="outline">Typ {c.type}</Badge></TableCell>
                            <TableCell className="py-1 text-muted-foreground">Dienstplan {c.planVal} vs. MIRUS {c.mirusVal}</TableCell>
                            <TableCell className="py-1 font-medium">{c.chosen === 'mirus' ? 'MIRUS übernommen' : 'Dienstplan behalten'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {report.autoChanges.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-1.5">Automatisch überschriebene Zellen ({report.autoChanges.length})</p>
                  <div className="rounded-lg border overflow-hidden max-h-56 overflow-y-auto">
                    <Table>
                      <TableBody>
                        {report.autoChanges.map((c, i) => (
                          <TableRow key={i}>
                            <TableCell className="py-1">{c.name}</TableCell>
                            <TableCell className="py-1">{format(new Date(c.date), 'dd.MM.', { locale: de })}</TableCell>
                            <TableCell className="py-1 text-muted-foreground">{c.oldVal} → {c.newVal}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <Alert>
                <ShieldCheck className="h-4 w-4" />
                <AlertDescription>
                  {report.manualUntouchedCount} MANUELL-Mitarbeiter blieben unberührt.
                  {report.skippedManual.length > 0 && ` In der Datei enthalten, aber übersprungen: ${report.skippedManual.map(s => s.name).join(', ')}.`}
                </AlertDescription>
              </Alert>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportOpen(false)}>Schliessen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
