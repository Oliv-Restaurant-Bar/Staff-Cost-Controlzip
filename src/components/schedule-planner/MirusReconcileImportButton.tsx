/**
 * MirusReconcileImportButton
 * ==========================
 * MIRUS-Ist-Stunden-Import — Modus «MIRUS überschreibt mit Rückfragen»,
 * mit Muster-Gruppen (1–5), Rundungsschwelle und Abgleich-Report.
 *
 * Ablauf:
 *   1. Datei parsen + Scope-Check (ein Monat, sonst Abbruch)
 *   2. Namen matchen (gespeicherte Zuordnungen + Kaskade, Dialog für offene)
 *   3. Abgleich-Plan bauen (nur erfassungsart='MIRUS'-Mitarbeiter) —
 *      Drei-Weg-Vergleich MIRUS / Dienstplan-PLAN / gespeicherte Ist,
 *      klassiert nach Muster 1–5 (siehe mirus-import-engine.ts):
 *        Rundung ≤ Schwelle (0.05 h) → still übernehmen, erscheint nirgends
 *        M1 MIRUS-Stunden ohne Gegenteil → Sammelgruppe «wird übernommen»
 *        M2 MIRUS 0 vs. Stunden → Rückfrage
 *        M3 Absenz (FE/K/U) + MIRUS 0 → Code behalten, bestätigen
 *        M4 Absenz vs. MIRUS-Stunden → Rückfrage
 *        M5 beide Stunden, Diff > Schwelle → Rückfrage mit Differenz
 *   4. Vorschau in aufklappbaren Muster-Gruppen mit Sammelaktion pro Gruppe
 *      und Einzelentscheid pro Zeile — NICHTS wird vorher geschrieben
 *   5. Bestätigen → Backup (dienstplan_ist_backup) → Schreiben → Report
 *      (pro MA: Plan vs. Ist pro Tag, Monatstotal, Absenztage, Entscheidungen)
 *   6. «Rückgängig» stellt den Stand vor dem letzten Import wieder her
 *
 * MANUELL-Mitarbeiter (Aushilfen) werden NIE angefasst — auch nicht im lokalen State.
 * Tenant-generisch: funktioniert für Oliv und Beaulieu.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

import { Employee, MirusDailyImportEntry, DaySchedule } from '@/types/personnel';
import { parseMirusDailyExcel } from '@/lib/personnel-utils';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';
import {
  matchEmployeeByName, saveNameMappingsBatch,
  fetchRemoteAliases, saveRemoteAliases, mergeAliasesIntoLocal,
} from '@/lib/mirus-name-mapping-store';
import {
  ImportMatchPreviewDialog, NameMatchInfo, NameMatchOverride,
} from '@/components/schedule-planner/ImportMatchPreviewDialog';
import {
  buildMirusReconcilePlan, resolvePlanToWrites, expectedAfterTotals,
  computeIstCoverage, formatDayRanges,
  groupPlanCells, patternOf, canonicalAbsence, MIRUS_ROUNDING_THRESHOLD_H,
  MirusReconcilePlan, MirusResolvedEntry, MirusCellPlan, MirusPlanInfo,
} from '@/lib/mirus-import-engine';
import type { ActualHourEntry } from '@/lib/supabase-db';
import {
  saveDienstplanIstBackup, loadLatestDienstplanIstBackup, deleteDienstplanIstBackup,
  updateEmployeeErfassungsart, DienstplanIstBackupRow, saveActualHourEntry,
} from '@/lib/supabase-db';
import { ActualHoursEntry } from '@/components/schedule-planner/ActualHoursGrid';
import { useTenant } from '@/contexts/TenantContext';

// ─── Abgleich-Report (nach Import, persistiert je Mandant+Monat) ─────────────

export type MirusDayDecision =
  | 'uebernommen'        // MIRUS-Wert geschrieben
  | 'still_gerundet'     // Rundungsdiff ≤ Schwelle, still übernommen
  | 'behalten'           // Bestehendes/Absenz behalten
  | 'abgelehnt'          // Muster-1-Zeile abgelehnt (nicht übernommen)
  | 'unveraendert';      // nichts zu tun (leer/identisch)

export interface MirusReportDay {
  date: string;
  planVal: string;   // Dienstplan-PLAN (Stunden oder Absenzcode)
  beforeVal: string; // gespeicherte Ist vor Import
  afterVal: string;  // gespeicherte Ist nach Import
  fileVal: string;   // MIRUS-Wert
  pattern: 1 | 2 | 3 | 4 | 5 | null;
  decision: MirusDayDecision;
}

export interface MirusImportReport {
  timestamp: string;
  month: string;
  fileName: string;
  roundingThreshold: number;
  perEmployee: Array<{
    name: string;
    fileTotal: number;
    beforeTotal: number;
    afterTotal: number;
    delta: number;
    /** Anzahl Absenztage (FE/K/U) nach dem Import */
    absenceDays: number;
    warn: boolean; // |after - file| > 0.02 × Tage → Gegenprüfung fehlgeschlagen
    days: MirusReportDay[];
  }>;
  silentRoundCount: number;
  skippedManual: Array<{ name: string; fileTotal: number }>;
  manualUntouchedCount: number;
  /** Datei-Namen ohne Zuordnung (übersprungen) */
  unmatchedNames: string[];
  /** Zeilen ausserhalb des Monats (ignoriert) */
  outOfScopeRows: Array<{ name: string; date: string; hours: number }>;
}

const reportStorageKey = (month: string) => `mirus-import-report-${month}`;

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

/** Finaler Ist-Eintrag einer Zelle nach Anwendung von Entscheidung + Auswahl. */
function finalEntryForCell(cell: MirusCellPlan): ActualHourEntry | null {
  const take = cell.resolution === 'mirus';
  switch (cell.decision) {
    case 'silent_round':     return { hours: cell.fileHours };
    case 'auto_take':        return take ? { hours: cell.fileHours } : cell.before;
    case 'conflict_zero':    return take ? null : cell.before;
    case 'absence_keep':
      if (take) return null;
      return cell.before ?? (cell.plan.absence ? { hours: 0, absenceType: cell.plan.absence } : null);
    case 'conflict_absence': return take ? { hours: cell.fileHours } : cell.before;
    case 'conflict_diff':    return take ? { hours: cell.fileHours } : cell.before;
    default:                 return cell.before;
  }
}

function decisionForCell(cell: MirusCellPlan): MirusDayDecision {
  const take = cell.resolution === 'mirus';
  switch (cell.decision) {
    case 'silent_round':     return 'still_gerundet';
    case 'auto_take':        return take ? 'uebernommen' : 'abgelehnt';
    case 'conflict_zero':
    case 'conflict_absence':
    case 'conflict_diff':    return take ? 'uebernommen' : 'behalten';
    case 'absence_keep':     return take ? 'uebernommen' : 'behalten';
    default:                 return 'unveraendert';
  }
}

const DECISION_LABEL: Record<MirusDayDecision, string> = {
  uebernommen: 'MIRUS übernommen',
  still_gerundet: 'still gerundet',
  behalten: 'behalten',
  abgelehnt: 'nicht übernommen',
  unveraendert: '—',
};

// ─── Muster-Gruppen-Metadaten für die Vorschau ───────────────────────────────

const PATTERN_META: Record<1 | 2 | 3 | 4 | 5, {
  title: string;
  hint: string;
  mirusLabel: string;
  keepLabel: string;
  tone: string;
}> = {
  1: {
    title: 'Muster 1 — wird übernommen (MIRUS-Stunden, kein Widerspruch)',
    hint: 'MIRUS hat Stunden, im Ist-Plan steht nichts Gegenteiliges. Standard: übernehmen.',
    mirusLabel: 'Übernehmen', keepLabel: 'Nicht übernehmen', tone: 'text-green-700',
  },
  2: {
    title: 'Muster 2 — MIRUS 0, aber Plan/Ist hat Stunden',
    hint: 'MIRUS meldet 0 Stunden, obwohl Stunden geplant oder erfasst sind. Bitte entscheiden.',
    mirusLabel: 'MIRUS (leeren)', keepLabel: 'Stunden behalten', tone: 'text-blue-700',
  },
  3: {
    title: 'Muster 3 — Absenz (FE/K/U) behalten',
    hint: 'Absenzcode vorhanden, MIRUS meldet 0 — Code bleibt, Ist-Stunden 0. Bitte bestätigen.',
    mirusLabel: 'MIRUS (Code weg)', keepLabel: 'Absenz bestätigen', tone: 'text-teal-700',
  },
  4: {
    title: 'Muster 4 — Absenz vs. MIRUS-Stunden',
    hint: 'Absenzcode geplant/erfasst, aber MIRUS meldet Arbeitsstunden. Bitte entscheiden.',
    mirusLabel: 'MIRUS-Stunden', keepLabel: 'Absenz behalten', tone: 'text-purple-700',
  },
  5: {
    title: 'Muster 5 — Stunden-Abweichung über Schwelle',
    hint: 'Beide Quellen haben Stunden, die Differenz liegt über der Rundungsschwelle. Bitte entscheiden.',
    mirusLabel: 'MIRUS', keepLabel: 'Ist behalten', tone: 'text-orange-700',
  },
};

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  employees: Employee[];
  actualHoursData: Record<string, ActualHoursEntry>;
  /** Dienstplan-PLAN des Monats, Key = `${employeeId}-${date}` (Drei-Weg-Vergleich). */
  scheduleData: Record<string, DaySchedule>;
  currentMonth: Date;
  /** Schreibt eine Zelle in State + localStorage + Supabase (bestehender Planner-Pfad). */
  onCellChange: (employeeId: string, date: string, entry: ActualHoursEntry | null, opts?: { skipSupabase?: boolean }) => void;
  /** Meldet persistierte erfassungsart-Defaults zurück (lokalen Employee-State aktualisieren). */
  onErfassungsartPersisted?: (updates: Record<string, 'MIRUS' | 'MANUELL'>) => void;
}

export function MirusReconcileImportButton({
  employees, actualHoursData, scheduleData, currentMonth, onCellChange, onErfassungsartPersisted,
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
  const [unmatchedNames, setUnmatchedNames] = useState<string[]>([]);

  const [plan, setPlan] = useState<MirusReconcilePlan | null>(null);
  /** MA ohne gespeicherte Erfassungsart, die in der Datei stehen → würden mit Bestätigung neu als MIRUS klassiert. */
  const [newlyMirus, setNewlyMirus] = useState<string[]>([]);
  const [planOpen, setPlanOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({});
  const [expandedReportEmp, setExpandedReportEmp] = useState<string | null>(null);

  const [report, setReport] = useState<MirusImportReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  // Undo-Verfügbarkeit hängt am DB-Backup, NICHT am localStorage-Report.
  const [hasBackup, setHasBackup] = useState(false);

  const monthKey = format(currentMonth, 'yyyy-MM');

  // «Ist-Abdeckung: X/N Tage» — Tag gilt als abgedeckt, sobald irgendein
  // Ist-Eintrag an diesem Tag existiert; Lücken bleiben sichtbar bis der
  // nächste Import-Block sie füllt.
  const coverage = useMemo(
    () => computeIstCoverage(monthKey, Object.keys(actualHoursData)),
    [monthKey, actualHoursData],
  );

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
      // Mandanten-Check über Kostenträger (Spec Punkt 4): Datei muss zum
      // aktiven Mandanten gehören, sonst stoppen — es wird nichts geschrieben.
      if (result.costCenter?.tenant && result.costCenter.tenant !== tenantId) {
        const label = (t: string) => t === 'oliv' ? 'Oliv' : t === 'beaulieu' ? 'Beaulieu' : t;
        toast.error(
          `Import gestoppt: Datei gehört zu ${label(result.costCenter.tenant)} ` +
          `(Kostenträger «${result.costCenter.label}»), aktiver Mandant ist ${label(tenantId)}. Es wurde nichts geschrieben.`,
        );
        return;
      }
      if (result.entries.length === 0) {
        toast.error('Keine Ist-Stunden gefunden. Erwartet wird der Mirus-Export «Tägliche Stunden» mit Zeitraum «von … bis …».');
        return;
      }
      // Kalendermonat als Anker: geschrieben werden NUR Tage des aktuell
      // gewählten Monats. Datei-Tage anderer Monate werden übersprungen und
      // gelistet («gehört zu <Monat> — bei ausgewähltem <Monat> importieren»).
      const allDates = [...new Set(
        (result.dateRange.length > 0 ? result.dateRange : result.entries.map(e => e.date))
          .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      )].sort();
      const inMonthDates = allDates.filter(d => d.startsWith(`${monthKey}-`));
      if (inMonthDates.length === 0) {
        const otherMonths = [...new Set(allDates.map(d => d.slice(0, 7)))].sort();
        toast.error(otherMonths.length > 0
          ? `Datei enthält keine Tage für ${monthKey} (sie gehört zu ${otherMonths.join(', ')}). Bitte den passenden Monat auswählen — es wurde nichts geschrieben.`
          : 'Kein Datumsbereich in der Datei erkannt («von DD.MM.YYYY bis DD.MM.YYYY» erwartet).');
        return;
      }
      setFileName(file.name);
      setParsedEntries(result.entries);
      setScopeDates(inMonthDates);
      setScopeMonth(monthKey);

      // Dauerhafte MIRUS-Aliasse des Mandanten vor dem Matching in den lokalen
      // Cache übernehmen (manuell bestätigte Zuordnungen früherer Importe).
      mergeAliasesIntoLocal(await fetchRemoteAliases(tenantId));

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
        })), result.entries, monthKey, inMonthDates);
      }
    } catch (err) {
      toast.error(`Fehler beim Lesen der Datei: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Schritt 3: Plan bauen (Drei-Weg: Datei / PLAN / Ist) ──────────────────

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
    // Manuell zugeordnete (vorher nicht automatisch erkannte) Namen zusätzlich
    // als dauerhaften MIRUS-Alias beim Mandanten speichern — der exakte
    // Datei-String trifft dann bei künftigen Importen direkt (best-effort).
    const manualAliases = overrides.filter(o =>
      o.selectedEmployeeId && o.selectedEmployeeId !== 'skip' && o.selectedEmployeeId !== 'new'
      && nameMatches.some(m => m.importedName === o.importedName && m.isNew),
    ).map(o => ({ importedName: o.importedName, employeeId: o.selectedEmployeeId }));
    void saveRemoteAliases(tenantId, manualAliases);
    const nameToEmp = new Map<string, Employee>();
    for (const o of overrides) {
      if (o.selectedEmployeeId && o.selectedEmployeeId !== 'skip' && o.selectedEmployeeId !== 'new') {
        const emp = employees.find(e => e.id === o.selectedEmployeeId);
        if (emp) nameToEmp.set(o.importedName, emp);
      }
    }
    const skippedNames = overrides.filter(o => o.selectedEmployeeId === 'skip' || o.selectedEmployeeId === 'new').map(o => o.importedName);
    setUnmatchedNames(skippedNames);

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
    // Erstklassierung transparent machen: diese MA werden mit der Bestätigung
    // neu als MIRUS klassiert (explizit in der Vorschau ausgewiesen).
    setNewlyMirus(employees.filter(e => !e.erfassungsart && fileEmpIds.has(e.id)).map(e => e.name));

    // Dienstplan-PLAN je MA/Tag als dritte Vergleichsgrösse.
    const planned: Record<string, MirusPlanInfo> = {};
    for (const empId of fileEmpIds) {
      for (const date of dates) {
        const ds = scheduleData[`${empId}-${date}`];
        if (!ds) continue;
        planned[`${empId}-${date}`] = {
          hours: calculateDayNetHours(ds),
          absence: canonicalAbsence(ds.frühAbsence) ?? canonicalAbsence(ds.spätAbsence),
        };
      }
    }

    const p = buildMirusReconcilePlan({
      entries: resolved, existing: actualHoursData, planned, erfassungsart, month, dates,
      roundingThreshold: MIRUS_ROUNDING_THRESHOLD_H,
    });
    setPlan(p);
    // Rückfrage-Gruppen (2,4,5) standardmässig offen, Sammelgruppen 1+3 zu.
    setOpenGroups({ 1: false, 2: true, 3: false, 4: true, 5: true });
    setPlanOpen(true);
    setMatchDialogOpen(false);
  };

  // ── Muster-Auflösung im Dialog ────────────────────────────────────────────

  const applyResolutions = (match: (c: MirusCellPlan) => boolean, resolution: 'mirus' | 'keep') => {
    setPlan(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        employees: prev.employees.map(emp => ({
          ...emp,
          cells: emp.cells.map(c => (patternOf(c.decision) && match(c)) ? { ...c, resolution } : c),
        })),
      };
    });
  };

  const setResolution = (cell: MirusCellPlan, resolution: 'mirus' | 'keep') =>
    applyResolutions(c => c.employeeId === cell.employeeId && c.date === cell.date, resolution);

  const setGroupResolution = (pattern: 1 | 2 | 3 | 4 | 5, resolution: 'mirus' | 'keep') =>
    applyResolutions(c => patternOf(c.decision) === pattern, resolution);

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

      // 4) Report bauen: pro MA Tages-Detail (Plan/Ist/Entscheidung) + Totale
      const after = expectedAfterTotals(plan);
      const manuellCount = employees.filter(e => (e.erfassungsart ?? persisted[e.id]) === 'MANUELL').length;
      const rep: MirusImportReport = {
        timestamp: new Date().toISOString(),
        month: plan.month,
        fileName,
        roundingThreshold: plan.roundingThreshold,
        perEmployee: plan.employees.map(e => {
          const a = after[e.employeeId] ?? 0;
          const days: MirusReportDay[] = e.cells.map(c => {
            const fin = finalEntryForCell(c);
            return {
              date: c.date,
              planVal: fmtPlan(c.plan),
              beforeVal: fmtEntry(c.before),
              afterVal: fmtEntry(fin),
              fileVal: c.fileHours > 0 ? `${c.fileHours.toFixed(2)} h` : '0',
              pattern: patternOf(c.decision),
              decision: decisionForCell(c),
            };
          });
          const absenceDays = e.cells.filter(c => !!finalEntryForCell(c)?.absenceType).length;
          return {
            name: e.employeeName,
            fileTotal: e.fileTotal,
            beforeTotal: e.beforeTotal,
            afterTotal: a,
            delta: Math.round((a - e.beforeTotal) * 100) / 100,
            absenceDays,
            // ±0.02 h Tagesrundung pro Tag Toleranz auf dem Monatstotal
            warn: Math.abs(a - e.fileTotal) > 0.02 * plan.dates.length + 0.005,
            days,
          };
        }),
        silentRoundCount: plan.silentRounds.length,
        skippedManual: plan.skippedManual.map(s => ({ name: s.employeeName, fileTotal: s.fileTotal })),
        manualUntouchedCount: manuellCount,
        unmatchedNames,
        outOfScopeRows: plan.skippedOutOfScope.map(r => ({ name: r.employeeName, date: r.date, hours: r.hours })),
      };
      try { localStorage.setItem(tenantKey(reportStorageKey(plan.month)), JSON.stringify(rep)); } catch { /* voll */ }
      setReport(rep);
      setPlanOpen(false);
      setPlan(null);
      setExpandedReportEmp(null);
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

  const groups = plan ? groupPlanCells(plan) : null;
  const questionCount = groups ? groups[2].length + groups[3].length + groups[4].length + groups[5].length : 0;

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
          onClick={() => { setReport(lastReport); setExpandedReportEmp(null); setReportOpen(true); }}>
          <ClipboardList className="h-4 w-4" /> Letzter Abgleich
        </Button>
      )}
      {hasBackup && (
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={handleUndo} disabled={undoBusy} data-testid="button-mirus-undo">
          <Undo2 className="h-4 w-4" /> {undoBusy ? 'Stelle wieder her…' : 'Rückgängig'}
        </Button>
      )}
      <span
        className={`text-xs ${coverage.missingDates.length > 0 ? 'text-orange-600' : 'text-muted-foreground'}`}
        data-testid="text-ist-coverage"
        title={coverage.missingDates.length > 0 ? `Es fehlen: ${formatDayRanges(coverage.missingDates)}` : 'Alle Tage haben Ist-Einträge.'}
      >
        Ist-Abdeckung: {coverage.covered}/{coverage.total} Tage
        {coverage.missingDates.length > 0 && ` — es fehlen ${formatDayRanges(coverage.missingDates)}`}
      </span>

      {/* Namens-Zuordnung für offene Namen */}
      <ImportMatchPreviewDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        nameMatches={nameMatches}
        existingEmployees={employees}
        onConfirm={(ov) => buildPlanFromMatches(ov, parsedEntries, scopeMonth, scopeDates)}
        onCancel={() => { setMatchDialogOpen(false); setParsedEntries([]); }}
      />

      {/* Vorschau nach Mustern gruppiert — erst «Import bestätigen» schreibt */}
      <Dialog open={planOpen} onOpenChange={(o) => { setPlanOpen(o); if (!o) setPlan(null); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              MIRUS-Abgleich {plan?.month} — Vorschau
            </DialogTitle>
            <DialogDescription>
              Es wird erst geschrieben, wenn du unten «Import bestätigen» klickst. Vorher wird ein Backup angelegt.
              Rundungsdifferenzen ≤ {MIRUS_ROUNDING_THRESHOLD_H.toFixed(2)} h werden still übernommen.
            </DialogDescription>
          </DialogHeader>

          {plan && groups && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">{plan.employees.length} MIRUS-Mitarbeiter</Badge>
                <Badge variant="outline">{plan.dates.length} Tage ({plan.dates[0]?.slice(8)}.–{plan.dates[plan.dates.length - 1]?.slice(8)}.)</Badge>
                <Badge variant="outline" className="text-green-700">{groups[1].length}× wird übernommen</Badge>
                <Badge variant="outline" className={questionCount ? 'text-orange-700 border-orange-300' : ''}>{questionCount} Rückfragen</Badge>
                {plan.silentRounds.length > 0 && <Badge variant="outline" className="text-muted-foreground">{plan.silentRounds.length} still gerundet</Badge>}
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

              {newlyMirus.length > 0 && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription data-testid="alert-newly-mirus">
                    <strong>Neu als MIRUS klassiert (mit Bestätigung):</strong> {newlyMirus.join(', ')} — diese Mitarbeiter haben noch keine Erfassungsart und stehen in der Datei. Nach dem Import werden ihre Ist-Stunden künftig von MIRUS-Importen abgeglichen. Soll jemand davon manuell bleiben, bitte Abbrechen und die Erfassungsart im Personalstamm auf «Manuell» setzen.
                  </AlertDescription>
                </Alert>
              )}

              {(unmatchedNames.length > 0 || plan.skippedOutOfScope.length > 0) && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="space-y-1">
                    {unmatchedNames.length > 0 && (
                      <div>Ohne Zuordnung (werden übersprungen): {unmatchedNames.join(', ')}</div>
                    )}
                    {plan.skippedOutOfScope.length > 0 && (
                      <div data-testid="text-out-of-scope">
                        {Object.entries(
                          plan.skippedOutOfScope.reduce<Record<string, string[]>>((acc, r) => {
                            const m = r.date.slice(0, 7);
                            (acc[m] = acc[m] ?? []).push(r.date);
                            return acc;
                          }, {}),
                        ).sort(([a], [b]) => a.localeCompare(b)).map(([m, ds]) => (
                          <div key={m}>
                            {ds.length} Zeile(n) übersprungen — gehört zu {format(new Date(`${m}-01`), 'MMMM yyyy', { locale: de })}: bei ausgewähltem {format(new Date(`${m}-01`), 'MMMM yyyy', { locale: de })} importieren ({formatDayRanges([...new Set(ds)])}).
                          </div>
                        ))}
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {/* Muster-Gruppen 1–5, aufklappbar, mit Sammelaktion */}
              {([1, 2, 3, 4, 5] as const).map(p => {
                const cells = groups[p];
                if (cells.length === 0) return null;
                const meta = PATTERN_META[p];
                const open = !!openGroups[p];
                return (
                  <div key={p} className="rounded-lg border overflow-hidden">
                    <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-2 bg-muted/60">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-sm font-medium"
                        onClick={() => setOpenGroups(g => ({ ...g, [p]: !g[p] }))}
                        data-testid={`button-toggle-group-${p}`}
                      >
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        <span className={meta.tone}>{meta.title}</span>
                        <Badge variant="secondary">{cells.length}</Badge>
                      </button>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setGroupResolution(p, 'mirus')} data-testid={`button-group-${p}-mirus`}>
                          Alle: {meta.mirusLabel}
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setGroupResolution(p, 'keep')} data-testid={`button-group-${p}-keep`}>
                          Alle: {meta.keepLabel}
                        </Button>
                      </div>
                    </div>
                    {open && (
                      <>
                        <p className="px-3 pt-2 text-xs text-muted-foreground">{meta.hint}</p>
                        <div className="max-h-72 overflow-y-auto">
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-muted">
                                <TableHead>Mitarbeiter</TableHead>
                                <TableHead>Tag</TableHead>
                                <TableHead>Plan</TableHead>
                                <TableHead>Alte Ist</TableHead>
                                <TableHead>Neu (MIRUS)</TableHead>
                                <TableHead className="text-right">Differenz</TableHead>
                                <TableHead>Aktion</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {cells.map((c, i) => {
                                const diff = Math.round((c.fileHours - (c.before?.hours ?? 0)) * 100) / 100;
                                return (
                                  <TableRow key={`${c.employeeId}-${c.date}`} data-testid={`row-pattern${p}-${i}`}>
                                    <TableCell className="py-1.5 font-medium">{c.employeeName}</TableCell>
                                    <TableCell className="py-1.5">{format(new Date(c.date), 'EEE dd.MM.', { locale: de })}</TableCell>
                                    <TableCell className="py-1.5">{fmtPlan(c.plan)}</TableCell>
                                    <TableCell className="py-1.5">{fmtEntry(c.before)}</TableCell>
                                    <TableCell className="py-1.5">{c.fileHours > 0 ? `${c.fileHours.toFixed(2)} h` : '0'}</TableCell>
                                    <TableCell className={`py-1.5 text-right ${Math.abs(diff) > 0.005 ? 'font-medium' : 'text-muted-foreground'}`}>
                                      {diff > 0 ? '+' : ''}{diff.toFixed(2)}
                                    </TableCell>
                                    <TableCell className="py-1.5">
                                      <div className="flex gap-1">
                                        <Button size="sm" variant={c.resolution === 'mirus' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                          onClick={() => setResolution(c, 'mirus')} data-testid={`button-p${p}-mirus-${i}`}>
                                          <Check className="h-3 w-3 mr-1" /> {meta.mirusLabel}
                                        </Button>
                                        <Button size="sm" variant={c.resolution === 'keep' ? 'default' : 'outline'} className="h-7 px-2 text-xs"
                                          onClick={() => setResolution(c, 'keep')} data-testid={`button-p${p}-keep-${i}`}>
                                          <X className="h-3 w-3 mr-1" /> {meta.keepLabel}
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
                  </div>
                );
              })}

              {/* Totale je MA */}
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead>Mitarbeiter</TableHead>
                      <TableHead className="text-right">MIRUS (Datei)</TableHead>
                      <TableHead className="text-right">Ist aktuell</TableHead>
                      <TableHead className="text-right">Änderungen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {plan.employees.map(e => {
                      const changes = e.cells.filter(c =>
                        c.decision === 'silent_round'
                        || (patternOf(c.decision) != null && c.resolution === 'mirus')).length;
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

      {/* Abgleich-Report nach dem Import — pro MA aufklappbares Tages-Detail */}
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-green-600" />
              MIRUS-Abgleich {report?.month}
            </DialogTitle>
            {report && (
              <DialogDescription>
                {report.fileName} · importiert {format(new Date(report.timestamp), 'dd.MM.yyyy HH:mm', { locale: de })}
                {report.silentRoundCount > 0 && ` · ${report.silentRoundCount} Rundungsdifferenz(en) ≤ ${report.roundingThreshold.toFixed(2)} h still übernommen`}
              </DialogDescription>
            )}
          </DialogHeader>
          {report && (
            <div className="space-y-4">
              {report.perEmployee.some(p => p.warn) && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Gegenprüfung fehlgeschlagen bei: {report.perEmployee.filter(p => p.warn).map(p => p.name).join(', ')} — gespeichertes Total weicht mehr als die Tagesrundung von der Datei ab (z. B. wegen «behalten»-Entscheidungen).
                  </AlertDescription>
                </Alert>
              )}
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted">
                      <TableHead />
                      <TableHead>Mitarbeiter</TableHead>
                      <TableHead className="text-right">MIRUS (Datei)</TableHead>
                      <TableHead className="text-right">Vorher</TableHead>
                      <TableHead className="text-right">Gespeichert</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                      <TableHead className="text-right">Absenztage</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.perEmployee.map(p => {
                      const expanded = expandedReportEmp === p.name;
                      // Nur Tage mit Substanz zeigen (Entscheidung oder Wert vorhanden)
                      const days = p.days?.filter(d => d.decision !== 'unveraendert' || d.beforeVal !== 'leer' || d.planVal !== '—') ?? [];
                      return (
                        <Fragment key={p.name}>
                          <TableRow className={p.warn ? 'bg-red-50 dark:bg-red-950/20' : ''} data-testid={`row-report-${p.name}`}>
                            <TableCell className="py-1.5 w-8">
                              {(p.days?.length ?? 0) > 0 && (
                                <button type="button" onClick={() => setExpandedReportEmp(expanded ? null : p.name)} data-testid={`button-report-expand-${p.name}`}>
                                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                </button>
                              )}
                            </TableCell>
                            <TableCell className="py-1.5 font-medium">{p.name}{p.warn && <AlertTriangle className="h-3.5 w-3.5 inline ml-1.5 text-red-600" />}</TableCell>
                            <TableCell className="py-1.5 text-right">{p.fileTotal.toFixed(2)}</TableCell>
                            <TableCell className="py-1.5 text-right">{p.beforeTotal.toFixed(2)}</TableCell>
                            <TableCell className="py-1.5 text-right font-medium">{p.afterTotal.toFixed(2)}</TableCell>
                            <TableCell className={`py-1.5 text-right ${Math.abs(p.delta) > 0.005 ? 'font-medium' : 'text-muted-foreground'}`}>
                              {p.delta > 0 ? '+' : ''}{p.delta.toFixed(2)}
                            </TableCell>
                            <TableCell className="py-1.5 text-right">{p.absenceDays ?? 0}</TableCell>
                          </TableRow>
                          {expanded && days.length > 0 && (
                            <TableRow key={`${p.name}-detail`}>
                              <TableCell colSpan={7} className="p-0 bg-muted/30">
                                <div className="max-h-64 overflow-y-auto">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className="text-xs">Tag</TableHead>
                                        <TableHead className="text-xs">Plan</TableHead>
                                        <TableHead className="text-xs">Ist vorher</TableHead>
                                        <TableHead className="text-xs">MIRUS</TableHead>
                                        <TableHead className="text-xs">Ist nachher</TableHead>
                                        <TableHead className="text-xs">Muster</TableHead>
                                        <TableHead className="text-xs">Entscheidung</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {days.map(d => (
                                        <TableRow key={d.date}>
                                          <TableCell className="py-1 text-xs">{format(new Date(d.date), 'EEE dd.MM.', { locale: de })}</TableCell>
                                          <TableCell className="py-1 text-xs">{d.planVal}</TableCell>
                                          <TableCell className="py-1 text-xs">{d.beforeVal}</TableCell>
                                          <TableCell className="py-1 text-xs">{d.fileVal}</TableCell>
                                          <TableCell className="py-1 text-xs font-medium">{d.afterVal}</TableCell>
                                          <TableCell className="py-1 text-xs">{d.pattern ? `M${d.pattern}` : d.decision === 'still_gerundet' ? 'Rundung' : '—'}</TableCell>
                                          <TableCell className="py-1 text-xs">{DECISION_LABEL[d.decision]}</TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {(report.unmatchedNames?.length > 0 || report.outOfScopeRows?.length > 0) && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="space-y-1">
                    {report.unmatchedNames?.length > 0 && (
                      <div>Nicht zugeordnet (übersprungen): {report.unmatchedNames.join(', ')}</div>
                    )}
                    {report.outOfScopeRows?.length > 0 && (
                      <div>
                        {Object.entries(
                          report.outOfScopeRows.reduce<Record<string, string[]>>((acc, r) => {
                            const m = r.date.slice(0, 7);
                            (acc[m] = acc[m] ?? []).push(r.date);
                            return acc;
                          }, {}),
                        ).sort(([a], [b]) => a.localeCompare(b)).map(([m, ds]) => (
                          <div key={m}>
                            {ds.length} Zeile(n) übersprungen — gehört zu {format(new Date(`${m}-01`), 'MMMM yyyy', { locale: de })}: bei ausgewähltem {format(new Date(`${m}-01`), 'MMMM yyyy', { locale: de })} importieren ({formatDayRanges([...new Set(ds)])}).
                          </div>
                        ))}
                      </div>
                    )}
                  </AlertDescription>
                </Alert>
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
