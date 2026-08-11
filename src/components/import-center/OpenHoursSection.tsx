/**
 * OpenHoursSection — «Offene Stunden» im Import-Center (/import)
 * ===============================================================
 * Listet alle GEPARKTEN MIRUS-Einträge des Mandanten (Name, Zeitraum, Stunden,
 * Quelle) und erlaubt die nachträgliche Zuweisung an einen Mitarbeiter — ohne
 * erneuten Datei-Upload. Die Zuweisung läuft durch DIESELBE Logik wie der
 * Import: Drei-Weg-Vergleich (MIRUS / Dienstplan-PLAN / gespeicherte Ist),
 * Muster 1–5, stille Rundung, Vorschau, Backup (dienstplan_ist_backup),
 * erst dann Schreiben. Der MIRUS-Name wird als dauerhafter Alias gespeichert.
 *
 * «Neu erstellen & zuordnen»: Mitarbeiter werden ausschliesslich im
 * Personalstamm angelegt (sanktionierter Schreibpfad) — hier gibt es dafür
 * einen direkten Link; danach den Eintrag zuweisen.
 *
 * Verwerfen: nur mit expliziter Bestätigung, Eintrag wird als 'discarded'
 * markiert (nicht gelöscht).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { Inbox, Loader2, UserPlus, Check, X, AlertTriangle, ShieldCheck, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

import { useTenant } from '@/contexts/TenantContext';
import { Employee, DaySchedule } from '@/types/personnel';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import {
  fetchOpenParkedEntries, markParkedResolved, discardParkedEntry, ParkedHoursEntry,
} from '@/lib/mirus-open-hours-store';
import { saveRemoteAliases, saveNameMappingsBatch } from '@/lib/mirus-name-mapping-store';
import {
  buildMirusReconcilePlan, resolvePlanToWrites, groupPlanCells, patternOf, canonicalAbsence,
  formatDayRanges, MIRUS_ROUNDING_THRESHOLD_H,
  MirusReconcilePlan, MirusResolvedEntry, MirusCellPlan, MirusPlanInfo,
} from '@/lib/mirus-import-engine';
import {
  loadEmployees, loadScheduleForMonth, loadActualHoursForMonth,
  saveDienstplanIstBackup, saveActualHourEntry, updateEmployeeErfassungsart,
  DienstplanIstBackupRow, ActualHourEntry,
} from '@/lib/supabase-db';
import { loadIstDayLocksStrict } from '@/lib/ist-day-locks';

const PATTERN_SHORT: Record<1 | 2 | 3 | 4 | 5, { label: string; mirusLabel: string; keepLabel: string }> = {
  1: { label: 'M1 — wird übernommen', mirusLabel: 'Übernehmen', keepLabel: 'Nicht übernehmen' },
  2: { label: 'M2 — MIRUS 0 vs. Stunden', mirusLabel: 'MIRUS (leeren)', keepLabel: 'Stunden behalten' },
  3: { label: 'M3 — Absenz behalten', mirusLabel: 'MIRUS (Code weg)', keepLabel: 'Absenz bestätigen' },
  4: { label: 'M4 — Absenz vs. MIRUS-Stunden', mirusLabel: 'MIRUS-Stunden', keepLabel: 'Absenz behalten' },
  5: { label: 'M5 — Abweichung über Schwelle', mirusLabel: 'MIRUS', keepLabel: 'Ist behalten' },
};

function fmtEntry(e: { hours?: number; absenceType?: string | null } | null): string {
  if (!e) return 'leer';
  const h = (e.hours ?? 0) > 0 ? `${(e.hours ?? 0).toFixed(2)} h` : '';
  const a = e.absenceType ? `${e.absenceType}` : '';
  return [h, a].filter(Boolean).join(' + ') || '0';
}

function fmtPlan(p: MirusPlanInfo): string {
  if (p.absence) return p.absence;
  return p.hours > 0 ? `${p.hours.toFixed(2)} h` : '—';
}

interface AssignState {
  entry: ParkedHoursEntry;
  employee: Employee;
  plan: MirusReconcilePlan;
}

export function OpenHoursSection() {
  const { tenantId } = useTenant();

  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [loadError, setLoadError] = useState('');
  const [entries, setEntries] = useState<ParkedHoursEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({}); // entryId → employeeId
  const [busyId, setBusyId] = useState<string | null>(null);

  const [assign, setAssign] = useState<AssignState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<ParkedHoursEntry | null>(null);

  const reload = useCallback(async () => {
    setLoadState('loading');
    try {
      const [list, emps] = await Promise.all([
        fetchOpenParkedEntries(tenantId),
        loadEmployees(tenantId),
      ]);
      setEntries(list.sort((a, b) => b.importedAt.localeCompare(a.importedAt)));
      setEmployees((emps ?? []).filter(e => e.isActive !== false));
      setLoadState('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }, [tenantId]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Zuweisung Schritt 1: Plan bauen (gleiche Pipeline wie der Import) ─────
  const startAssign = async (entry: ParkedHoursEntry) => {
    const empId = selection[entry.id];
    const employee = employees.find(e => e.id === empId);
    if (!employee) { toast.error('Bitte zuerst einen Mitarbeiter auswählen.'); return; }
    setBusyId(entry.id);
    try {
      const monthDate = new Date(`${entry.month}-01T12:00:00`);
      // Tagessperren STRIKT lesen (fail-closed) — wirft bei Lesefehler.
      const [schedule, actuals, lockedDates] = await Promise.all([
        loadScheduleForMonth(monthDate, tenantId),
        loadActualHoursForMonth(monthDate, tenantId),
        loadIstDayLocksStrict(tenantId, entry.month),
      ]);
      if (actuals === null) {
        toast.error('Gespeicherte Ist-Werte konnten nicht geladen werden — Zuweisung abgebrochen (nichts geschrieben).');
        return;
      }
      const dates = Object.keys(entry.days).sort();
      const resolved: MirusResolvedEntry[] = dates.map(date => ({
        employeeId: employee.id, employeeName: employee.name, date, hours: entry.days[date],
      }));
      const planned: Record<string, MirusPlanInfo> = {};
      for (const date of dates) {
        const ds: DaySchedule | undefined = schedule?.[`${employee.id}-${date}`];
        if (!ds) continue;
        planned[`${employee.id}-${date}`] = {
          hours: calculateDayNetHours(ds),
          absence: canonicalAbsence(ds.frühAbsence) ?? canonicalAbsence(ds.spätAbsence),
        };
      }
      // Ziel-MA wird für diese Zuweisung als MIRUS behandelt (sonst würde die
      // Engine ihn überspringen und nichts schreiben). Gespeichert wird die
      // Erfassungsart nur, wenn sie noch leer ist.
      const plan = buildMirusReconcilePlan({
        entries: resolved,
        existing: actuals,
        planned,
        erfassungsart: { [employee.id]: 'MIRUS' },
        month: entry.month,
        dates,
        roundingThreshold: MIRUS_ROUNDING_THRESHOLD_H,
        lockedDates,
        // Austritts-Sperre: keine Ist-Stunden nach dem Austrittsdatum
        ...(employee.employmentEndDate ? { exitDates: { [employee.id]: employee.employmentEndDate } } : {}),
      });
      setAssign({ entry, employee, plan });
    } catch (e) {
      toast.error(`Vorschau fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const setResolution = (cell: MirusCellPlan, resolution: 'mirus' | 'keep') => {
    setAssign(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        plan: {
          ...prev.plan,
          employees: prev.plan.employees.map(emp => ({
            ...emp,
            cells: emp.cells.map(c =>
              (patternOf(c.decision) && c.employeeId === cell.employeeId && c.date === cell.date)
                ? { ...c, resolution } : c),
          })),
        },
      };
    });
  };

  // ── Zuweisung Schritt 2: Bestätigen → Backup → Schreiben → Auflösen ───────
  const confirmAssign = async () => {
    if (!assign) return;
    const { entry, employee, plan } = assign;
    setConfirmBusy(true);
    try {
      // 1) Backup des betroffenen Ist-Stands (MA × Tage) — wie beim Import.
      const monthDate = new Date(`${entry.month}-01T12:00:00`);
      const actuals = await loadActualHoursForMonth(monthDate, tenantId);
      if (actuals === null) {
        toast.error('Ist-Werte konnten nicht geladen werden — abgebrochen, nichts geschrieben.');
        return;
      }
      const backupRows: DienstplanIstBackupRow[] = [];
      for (const date of plan.dates) {
        const e = actuals[`${employee.id}-${date}`];
        if (e) {
          backupRows.push({
            employee_id: employee.id, date, hours: e.hours,
            start_time: e.start ?? null, end_time: e.end ?? null,
            absence_type: e.absenceType ?? null,
            is_additional_cost_ist: e.isAdditionalCost ?? false,
            source: e.source ?? null,
          });
        }
      }
      const backupId = await saveDienstplanIstBackup(
        tenantId, plan.month, `Offene Stunden zugewiesen: ${entry.name} → ${employee.name} (${entry.sourceFile})`,
        { employeeIds: [employee.id], dates: plan.dates }, backupRows,
      );
      if (!backupId) {
        toast.error('Backup konnte nicht gespeichert werden — Zuweisung abgebrochen, es wurde nichts geschrieben.');
        return;
      }

      // 2) Schreiben — awaited + geprüft, Abbruch-Meldung bei Fehlern.
      // Tagessperren UNMITTELBAR vor dem Commit strikt neu prüfen (zwischen
      // Vorschau und Bestätigung kann gesperrt worden sein); fail-closed.
      const commitLocks = await loadIstDayLocksStrict(tenantId, plan.month);
      const allWrites = resolvePlanToWrites(plan);
      const writes = allWrites.filter(op => !commitLocks.has(op.date));
      if (allWrites.length - writes.length > 0) {
        toast.info(`${allWrites.length - writes.length} Tag(e) inzwischen gesperrt — nicht überschrieben.`);
      }
      const failed: string[] = [];
      let written = 0;
      for (const op of writes) {
        const e: ActualHourEntry | null = op.entry ? {
          hours: op.entry.hours,
          ...(op.entry.absenceType ? { absenceType: op.entry.absenceType } : {}),
          source: 'import',
        } : null;
        const res = await saveActualHourEntry(op.employeeId, op.date, e);
        if (res.ok) written++;
        else failed.push(op.date);
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} von ${writes.length} Tagen konnten nicht gespeichert werden (${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}). Backup bleibt erhalten, der Eintrag bleibt OFFEN — bitte erneut zuweisen.`);
        return;
      }

      // 3) Alias dauerhaft speichern (künftige Importe treffen automatisch).
      saveNameMappingsBatch([{ importedName: entry.name, employeeId: employee.id }]);
      await saveRemoteAliases(tenantId, [{ importedName: entry.name, employeeId: employee.id }]);

      // 4) Erfassungsart nur setzen, wenn noch leer (Default: MIRUS).
      if (!employee.erfassungsart) {
        await updateEmployeeErfassungsart(employee.id, 'MIRUS');
      }

      // 5) Nur auflösen, wenn ALLE geparkten Tageswerte tatsächlich
      // berücksichtigt sind: Zellen mit fileHours>0, bei denen «behalten»
      // gewählt wurde, lassen die geparkten Stunden ungeschrieben — der
      // Eintrag bleibt dann OFFEN (kein stilles Verschwinden).
      const keptDays = assign.plan.employees
        .flatMap(emp => emp.cells)
        .filter(c => patternOf(c.decision) !== null && c.resolution === 'keep' && c.fileHours > 0)
        .map(c => c.date);
      if (keptDays.length > 0) {
        toast.warning(`${written} Tage geschrieben, aber ${keptDays.length} Tag(e) mit geparkten Stunden wurden auf «behalten» gesetzt (${formatDayRanges(keptDays)}). Der Eintrag bleibt OFFEN — später erneut zuweisen oder bewusst verwerfen.`);
        setAssign(null);
        await reload();
        return;
      }
      await markParkedResolved(tenantId, entry.id, employee.id, `Manuell zugewiesen (${written} Tage geschrieben)`);
      toast.success(`«${entry.name}» (${entry.totalHours.toFixed(2)} h) wurde ${employee.name} zugewiesen — ${written} Tage geschrieben, Alias gespeichert, Backup angelegt.`);
      setAssign(null);
      await reload();
    } catch (e) {
      toast.error(`Zuweisung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmDiscard = async () => {
    if (!discardTarget) return;
    setBusyId(discardTarget.id);
    try {
      await discardParkedEntry(tenantId, discardTarget.id);
      toast.success(`Eintrag «${discardTarget.name}» (${discardTarget.totalHours.toFixed(2)} h) verworfen.`);
      setDiscardTarget(null);
      await reload();
    } catch (e) {
      toast.error(`Verwerfen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const groups = useMemo(() => (assign ? groupPlanCells(assign.plan) : null), [assign]);
  const questionCount = groups ? groups[2].length + groups[3].length + groups[4].length + groups[5].length : 0;

  if (loadState === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-3" data-testid="open-hours-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Offene Stunden werden geladen …
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <Alert variant="destructive" data-testid="open-hours-error">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>Offene Stunden konnten nicht geladen werden: {loadError}</span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void reload()}>Erneut versuchen</Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3" data-testid="open-hours-section">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-1" data-testid="open-hours-empty">
          Keine offenen Einträge — alle importierten MIRUS-Stunden sind zugeordnet.
        </p>
      ) : (
        <>
          <Alert className="border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/30">
            <Inbox className="h-4 w-4 text-sky-700" />
            <AlertDescription className="text-sm">
              Diese Stunden wurden beim MIRUS-Import geparkt und sind <strong>noch nicht in den Ist-Werten</strong>.
              Mitarbeiter auswählen und «Zuordnen» — die Zuweisung läuft mit Vorschau und Backup durch dieselbe
              Prüfung wie der Import. Fehlt der Mitarbeiter noch, zuerst im{' '}
              <Link to="/personal-stamm" className="underline font-medium">Personalstamm anlegen</Link>, dann hier zuweisen.
            </AlertDescription>
          </Alert>
          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted">
                  <TableHead>Name (MIRUS)</TableHead>
                  <TableHead>Zeitraum</TableHead>
                  <TableHead className="text-right">Stunden</TableHead>
                  <TableHead>Quelle</TableHead>
                  <TableHead>Zuordnung</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => {
                  const dates = Object.keys(entry.days).sort();
                  return (
                    <TableRow key={entry.id} data-testid={`row-open-hours-${entry.id}`}>
                      <TableCell className="py-2 font-medium whitespace-nowrap">
                        {entry.name}
                        <Badge variant="outline" className="ml-2 text-[10px] text-sky-700 border-sky-300">offen</Badge>
                      </TableCell>
                      <TableCell className="py-2 whitespace-nowrap text-sm">
                        {format(new Date(`${entry.month}-01`), 'MMM yyyy', { locale: de })} · {formatDayRanges(dates)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums">{entry.totalHours.toFixed(2)} h</TableCell>
                      <TableCell className="py-2 text-xs text-muted-foreground max-w-[180px]">
                        <span className="block truncate" title={entry.sourceFile}>{entry.sourceFile}</span>
                        {format(new Date(entry.importedAt), 'dd.MM.yyyy HH:mm', { locale: de })}
                      </TableCell>
                      <TableCell className="py-2 min-w-[200px]">
                        <Select
                          value={selection[entry.id] ?? ''}
                          onValueChange={v => setSelection(s => ({ ...s, [entry.id]: v }))}
                        >
                          <SelectTrigger className="h-8 text-sm" data-testid={`select-open-hours-emp-${entry.id}`}>
                            <SelectValue placeholder="Mitarbeiter wählen…" />
                          </SelectTrigger>
                          <SelectContent>
                            {employees.map(emp => (
                              <SelectItem key={emp.id} value={emp.id}>{emp.name} ({emp.department})</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex gap-1.5">
                          <Button
                            size="sm" className="h-8 gap-1 text-xs"
                            disabled={!selection[entry.id] || busyId === entry.id}
                            onClick={() => void startAssign(entry)}
                            data-testid={`button-assign-${entry.id}`}
                          >
                            {busyId === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                            Zuordnen
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-8 gap-1 text-xs text-muted-foreground hover:text-red-600"
                            disabled={busyId === entry.id}
                            onClick={() => setDiscardTarget(entry)}
                            data-testid={`button-discard-${entry.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Verwerfen
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* ── Vorschau-Dialog der Zuweisung (Muster 1–5, wie beim Import) ───── */}
      <Dialog open={!!assign} onOpenChange={o => { if (!o) setAssign(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Inbox className="h-5 w-5 text-sky-700" />
              Offene Stunden zuweisen — Vorschau
            </DialogTitle>
            <DialogDescription>
              «{assign?.entry.name}» → <strong>{assign?.employee.name}</strong> ({assign?.entry.month}).
              Es wird erst geschrieben, wenn du unten bestätigst. Vorher wird ein Backup angelegt.
              Rundungsdifferenzen ≤ {MIRUS_ROUNDING_THRESHOLD_H.toFixed(2)} h werden still übernommen.
            </DialogDescription>
          </DialogHeader>

          {assign && groups && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">{assign.entry.totalHours.toFixed(2)} h aus Datei</Badge>
                <Badge variant="outline">{assign.plan.dates.length} Tage</Badge>
                <Badge variant="outline" className="text-green-700">{groups[1].length}× wird übernommen</Badge>
                <Badge variant="outline" className={questionCount ? 'text-orange-700 border-orange-300' : ''}>{questionCount} Rückfragen</Badge>
                {assign.plan.silentRounds.length > 0 && <Badge variant="outline" className="text-muted-foreground">{assign.plan.silentRounds.length} still gerundet</Badge>}
              </div>

              {(assign.plan.lockedSkipped.length > 0 || assign.plan.lockedDates.length > 0) && (
                <Alert>
                  <ShieldCheck className="h-4 w-4" />
                  <AlertDescription data-testid="alert-assign-locked">
                    <strong>Gesperrt — nicht überschrieben:</strong>{' '}
                    {assign.plan.lockedDates.map(d => `${d.slice(8)}.${d.slice(5, 7)}.`).join(', ')}
                    {assign.plan.lockedSkipped.length > 0 && (
                      <> — geparkte Stunden auf gesperrten Tagen bleiben unberücksichtigt:{' '}
                      {assign.plan.lockedSkipped.map(r => `${r.date.slice(8)}.${r.date.slice(5, 7)}. (${r.hours.toFixed(1)} h)`).join(', ')}</>
                    )}
                    {' '}— zum Übernehmen die Tage im Dienstplan (Ist) entsperren.
                  </AlertDescription>
                </Alert>
              )}

              {assign.plan.rejectedExited.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription data-testid="alert-assign-exited">
                    <strong>Ausgetreten — nicht übernommen:</strong>{' '}
                    {assign.plan.rejectedExited.map(r => `${r.date.slice(8)}.${r.date.slice(5, 7)}. (${r.hours.toFixed(1)} h)`).join(', ')}
                    {' '}— {assign.employee.name} ist seit {assign.plan.rejectedExited[0].exitDate.slice(8)}.{assign.plan.rejectedExited[0].exitDate.slice(5, 7)}.{assign.plan.rejectedExited[0].exitDate.slice(0, 4)} ausgetreten; nach dem Austritt werden keine Ist-Stunden geschrieben.
                  </AlertDescription>
                </Alert>
              )}

              {assign.employee.erfassungsart === 'MANUELL' && (
                <Alert>
                  <ShieldCheck className="h-4 w-4" />
                  <AlertDescription>
                    {assign.employee.name} ist als «Manuell» gekennzeichnet. Diese Zuweisung schreibt die geparkten
                    MIRUS-Stunden trotzdem — die Erfassungsart bleibt unverändert «Manuell».
                  </AlertDescription>
                </Alert>
              )}

              {([1, 2, 3, 4, 5] as const).map(p => {
                const cells = groups[p];
                if (cells.length === 0) return null;
                const meta = PATTERN_SHORT[p];
                return (
                  <div key={p} className="rounded-lg border overflow-hidden">
                    <div className="px-3 py-1.5 bg-muted/60 text-sm font-medium">{meta.label} <Badge variant="secondary" className="ml-1">{cells.length}</Badge></div>
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted">
                          <TableHead>Tag</TableHead>
                          <TableHead>Plan</TableHead>
                          <TableHead>Alte Ist</TableHead>
                          <TableHead>Neu (MIRUS)</TableHead>
                          <TableHead>Aktion</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cells.map((c, i) => (
                          <TableRow key={c.date} data-testid={`row-assign-p${p}-${i}`}>
                            <TableCell className="py-1.5">{format(new Date(c.date), 'EEE dd.MM.', { locale: de })}</TableCell>
                            <TableCell className="py-1.5">{fmtPlan(c.plan)}</TableCell>
                            <TableCell className="py-1.5">{fmtEntry(c.before)}</TableCell>
                            <TableCell className="py-1.5">{c.fileHours > 0 ? `${c.fileHours.toFixed(2)} h` : '0'}</TableCell>
                            <TableCell className="py-1.5">
                              <div className="flex gap-1">
                                <Button size="sm" variant={c.resolution === 'mirus' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                  onClick={() => setResolution(c, 'mirus')}>
                                  <Check className="h-3 w-3 mr-1" /> {meta.mirusLabel}
                                </Button>
                                <Button size="sm" variant={c.resolution === 'keep' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                  onClick={() => setResolution(c, 'keep')}>
                                  <X className="h-3 w-3 mr-1" /> {meta.keepLabel}
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAssign(null)} data-testid="button-assign-cancel">Abbrechen</Button>
            <Button onClick={() => void confirmAssign()} disabled={confirmBusy} className="bg-green-600 hover:bg-green-700" data-testid="button-assign-confirm">
              {confirmBusy ? 'Schreibe…' : 'Zuweisung bestätigen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Verwerfen nur mit expliziter Bestätigung ──────────────────────── */}
      <Dialog open={!!discardTarget} onOpenChange={o => { if (!o) setDiscardTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-5 w-5" /> Offene Stunden verwerfen?
            </DialogTitle>
            <DialogDescription>
              «{discardTarget?.name}» — {discardTarget?.totalHours.toFixed(2)} h aus {discardTarget?.sourceFile} ({discardTarget?.month}).
              Die Stunden werden dauerhaft NICHT in die Ist-Werte übernommen. Diese Aktion lässt sich nur durch
              erneuten Datei-Import rückgängig machen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardTarget(null)}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => void confirmDiscard()} disabled={busyId === discardTarget?.id} data-testid="button-discard-confirm">
              Endgültig verwerfen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Badge-Zähler «X offene Einträge» für die Section-Überschrift. */
export function useOpenParkedCount(): number {
  const { tenantId } = useTenant();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchOpenParkedEntries(tenantId)
      .then(list => { if (alive) setCount(list.length); })
      .catch(() => { /* best-effort */ });
    return () => { alive = false; };
  }, [tenantId]);
  return count;
}
