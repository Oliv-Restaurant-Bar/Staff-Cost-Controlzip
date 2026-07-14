/**
 * GastronoviZBerichtPage — Z-Bericht, Personen & Durchschnittsbon CSV Import
 *
 * Drei Importtypen:
 *   Z-Bericht        — Tagesumsatz, Kostenstellen, Kellner, Bezahlarten, etc.
 *   Personen         — Gäste / Umsatz pro Person (Analyse → Verkäufe → Personen)
 *   Durchschnittsbon — Durchschnittsbon pro Tag (offizielle Gastronovi-Kennzahl)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2,
  Trash2, ChevronDown, ChevronUp, RefreshCw,
  Info, AlertCircle, Database, Users, Copy, Receipt,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { ImportTaskPrefillHint } from '@/components/ImportTaskPrefillHint';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';

import { parseGnZBericht } from '@/lib/gn-zbericht-parser';
import type { GnParsedZBericht } from '@/lib/gn-zbericht-parser';
import {
  saveGnImport, loadGnImports, deleteGnImport,
  checkOverlappingImports, importTypeLabel,
  fetchBatchOverlaps, saveGnZBerichtBatch,
  loadGnDayClosingsForMonth,
} from '@/lib/gn-zbericht-db';
import type { GnImportRow, OverlapInfo, BatchSaveItem, BatchSaveResult } from '@/lib/gn-zbericht-db';
import {
  parseZBerichtBatch, planBatchImport,
} from '@/lib/gn-zbericht-multi';
import type {
  BatchParseResult, FileImportPlan, ConflictAction, ErrorPolicy,
} from '@/lib/gn-zbericht-multi';

import { parseGnPersonReport } from '@/lib/gn-personen-parser';
import type { GnParsedPersonReport, PersonCsvType } from '@/lib/gn-personen-parser';
import {
  savePersonImport, loadPersonImports, deletePersonImport,
  checkPersonDuplicate,
} from '@/lib/gn-personen-db';
import type { GnPersonImportRow } from '@/lib/gn-personen-db';

import { parseGnAverageCheck } from '@/lib/gn-average-check-parser';
import type { GnParsedAverageCheck, GnAverageCheckDebug } from '@/lib/gn-average-check-parser';
import {
  saveAverageCheckImport, loadAverageCheckImports, deleteAverageCheckImport,
  getOverlappingAverageCheckDates,
} from '@/lib/gn-average-check-db';
import type { GnAverageCheckImportGroup } from '@/lib/gn-average-check-db';

import { runGnDiagnostic } from '@/lib/gn-diagnostic';
import type { GnDiagnosticResult } from '@/lib/gn-diagnostic';

import type { GnDayClosing } from '@/lib/tagesabschluss';
import {
  applyImportConflictResolutions,
  detectTagesabschlussImportConflicts,
} from '@/lib/tagesabschluss';
import type {
  TagesabschlussImportConflict,
  TagesabschlussImportConflictResolution,
} from '@/lib/tagesabschluss';
import { loadTagesabschluss, saveTagesabschluss } from '@/lib/tagesabschluss-db';
import { TagesabschlussImportConflictDialog } from '@/components/umsatzabstimmung/TagesabschlussImportConflictDialog';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM  = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function fc(v: number) { return v > 0 ? `CHF ${NUM.format(v)}` : '—'; }
function fdate(iso: string | null | undefined) {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

// ── Typen ─────────────────────────────────────────────────────────────────────

type ImportType  = 'zbericht' | 'personen' | 'durchschnittsbon_bericht';
type WizardStep  = 'upload' | 'preview' | 'saving' | 'done';
type Tab         = 'import' | 'history';

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GastronoviZBerichtPage() {
  const { tenantId } = useTenant();
  const { isAdmin }  = usePermissions();

  if (!isAdmin) return <Navigate to="/" replace />;

  // ── Gemeinsamer State ──────────────────────────────────────────────────────
  const [importType, setImportType] = useState<ImportType>('zbericht');
  const [tab,        setTab]        = useState<Tab>('import');
  const [step,       setStep]       = useState<WizardStep>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [tablesOk,    setTablesOk]    = useState<boolean | null>(null);
  const [diagnostic,  setDiagnostic]  = useState<GnDiagnosticResult | null>(null);

  // Z-Bericht State
  const [parsed,           setParsed]           = useState<GnParsedZBericht | null>(null);
  const [overlapInfo,      setOverlapInfo]       = useState<OverlapInfo[]>([]);
  const [manualPeriodFrom, setManualPeriodFrom]  = useState('');
  const [manualPeriodTo,   setManualPeriodTo]    = useState('');
  const [zHistory,         setZHistory]          = useState<GnImportRow[]>([]);

  // Z-Bericht Multi-Datei (Batch) State
  const [batchResult,      setBatchResult]      = useState<BatchParseResult | null>(null);
  const [batchOverlaps,    setBatchOverlaps]    = useState<Record<string, OverlapInfo[]>>({});
  const [batchConflict,    setBatchConflict]    = useState<ConflictAction>('replace');
  const [batchErrorPolicy, setBatchErrorPolicy] = useState<ErrorPolicy>('only_valid');
  const [batchPlans,       setBatchPlans]       = useState<FileImportPlan[] | null>(null);
  const [batchSaveResults, setBatchSaveResults] = useState<BatchSaveResult[] | null>(null);
  const [batchExpanded,    setBatchExpanded]    = useState<Set<string>>(new Set());

  // Personen State
  const [parsedPerson,    setParsedPerson]    = useState<GnParsedPersonReport | null>(null);
  const [dupPersonInfo,   setDupPersonInfo]   = useState<{ existingId: string; importedAt: string } | null>(null);
  const [personHistory,   setPersonHistory]   = useState<GnPersonImportRow[]>([]);
  const [csvTypeOverride, setCsvTypeOverride] = useState<PersonCsvType | null>(null);

  // Durchschnittsbon State
  const [parsedAvg,       setParsedAvg]       = useState<GnParsedAverageCheck | null>(null);
  const [avgHistory,      setAvgHistory]      = useState<GnAverageCheckImportGroup[]>([]);
  const [avgOverlapDates, setAvgOverlapDates] = useState<string[]>([]);
  const [avgDebug,        setAvgDebug]        = useState<GnAverageCheckDebug | null>(null);
  const [avgImportYear,   setAvgImportYear]   = useState<number>(new Date().getFullYear());
  const [avgRawText,      setAvgRawText]      = useState<string | null>(null);

  // History
  const [histLoading, setHistLoading] = useState(false);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [deleting,    setDeleting]    = useState<string | null>(null);
  const [showDebug,    setShowDebug]    = useState(false);
  const [showAvgDebug, setShowAvgDebug] = useState(false);

  const csvRef = useRef<HTMLInputElement>(null);

  // ── Setup prüfen ────────────────────────────────────────────────────────────

  useEffect(() => {
    runGnDiagnostic().then(result => {
      setDiagnostic(result);
      setTablesOk(result.allOk);
    });
  }, []);

  // ── History laden ─────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const [z, p, a] = await Promise.all([
      loadGnImports(tenantId),
      loadPersonImports(tenantId),
      loadAverageCheckImports(tenantId),
    ]);
    setZHistory(z);
    setPersonHistory(p);
    setAvgHistory(a);
    setHistLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  // ── Typ wechseln → Reset ──────────────────────────────────────────────────

  const resetWizard = useCallback(() => {
    setParsed(null);
    setOverlapInfo([]); setManualPeriodFrom(''); setManualPeriodTo('');
    setBatchResult(null); setBatchOverlaps({}); setBatchPlans(null);
    setBatchSaveResults(null); setBatchExpanded(new Set());
    setBatchConflict('replace'); setBatchErrorPolicy('only_valid');
    setParsedPerson(null); setDupPersonInfo(null);
    setCsvTypeOverride(null);
    setParsedAvg(null); setAvgOverlapDates([]); setAvgDebug(null);
    setAvgRawText(null); setAvgImportYear(new Date().getFullYear());
    setParseError(null); setStep('upload');
  }, []);

  const handleTypeChange = (t: ImportType) => {
    setImportType(t);
    resetWizard();
  };

  // ── CSV verarbeiten ──────────────────────────────────────────────────────

  // Durchschnittsbon parsen (auch erneut bei manueller Jahreswahl aufrufbar).
  const runAvgParse = useCallback(async (text: string, fileName: string, year: number): Promise<boolean> => {
    const result = parseGnAverageCheck(text, fileName, year);
    setAvgDebug(result.debug);
    if (result.rows.length === 0) {
      setShowAvgDebug(true);
      setParsedAvg(null);
      setAvgOverlapDates([]);
      setParseError(
        'Datei konnte nicht als Gastronovi Durchschnittsbon-Bericht erkannt werden. '
        + 'Es wurden keine Tageswerte gefunden. Siehe Parser-Diagnose unten.',
      );
      return false;
    }
    setParseError(null);
    if (result.periodFrom && result.periodTo) {
      const existing = await getOverlappingAverageCheckDates(tenantId, result.periodFrom, result.periodTo);
      const dates = new Set(result.rows.map(r => r.date));
      setAvgOverlapDates(existing.filter(d => dates.has(d)));
    } else {
      setAvgOverlapDates([]);
    }
    setParsedAvg(result);
    return true;
  }, [tenantId]);

  const processCSV = useCallback(async (file: File) => {
    setParseError(null); setParsed(null); setParsedPerson(null);
    setOverlapInfo([]); setManualPeriodFrom(''); setManualPeriodTo('');
    setDupPersonInfo(null);
    setParsedAvg(null); setAvgOverlapDates([]); setAvgDebug(null); setAvgRawText(null);

    try {
      const text = await file.text();

      if (importType === 'zbericht') {
        const result = parseGnZBericht(text, file.name);
        if (result.revenue.totalGross === 0 && result.taxes.length === 0) {
          setParseError('Datei konnte nicht als Gastronovi Z-Bericht erkannt werden. Bitte prüfe das Format.');
          return;
        }
        if (result.periodFrom && result.periodTo) {
          const overlaps = await checkOverlappingImports(tenantId, result.periodFrom, result.periodTo);
          setOverlapInfo(overlaps);
        }
        setParsed(result);
      } else if (importType === 'personen') {
        const result = parseGnPersonReport(text, file.name);
        if (result.rowCount === 0 && result.totalGuests === 0) {
          setParseError('Datei konnte nicht als Gastronovi Personen-Bericht erkannt werden. Bitte prüfe das Format.');
          return;
        }
        const dup = await checkPersonDuplicate(tenantId, result.checksum, result.periodFrom, result.periodTo);
        if (dup.isDuplicate && dup.existingId) {
          setDupPersonInfo({ existingId: dup.existingId, importedAt: dup.existingImportedAt ?? '' });
        }
        setParsedPerson(result);
      } else {
        // Erst-Parse mit aktuellem Jahr als Benutzerwahl-Standard; Rohtext für
        // späteres erneutes Parsen bei manueller Jahreswahl merken.
        const yr = new Date().getFullYear();
        setAvgImportYear(yr);
        setAvgRawText(text);
        const ok = await runAvgParse(text, file.name, yr);
        if (!ok) return;
      }
      setStep('preview');
    } catch (e) {
      setParseError('Fehler: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [importType, tenantId, runAvgParse]);

  // Manuelle Jahreswahl (nur relevant, wenn das Jahr per Benutzerwahl bestimmt wurde):
  // Rohtext mit dem neuen Jahr erneut parsen.
  const handleAvgYearChange = async (year: number) => {
    setAvgImportYear(year);
    if (avgRawText && parsedAvg) {
      await runAvgParse(avgRawText, parsedAvg.fileName, year);
    }
  };

  const handleFileSelect = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    processCSV(file);
  };

  // Mehrere Z-Berichte gleichzeitig parsen, klassifizieren und Überschneidungen prüfen.
  const processBatch = useCallback(async (files: File[]) => {
    setParseError(null);
    setParsed(null); setParsedPerson(null); setParsedAvg(null);
    setOverlapInfo([]); setManualPeriodFrom(''); setManualPeriodTo('');
    setBatchResult(null); setBatchOverlaps({}); setBatchPlans(null); setBatchSaveResults(null);
    setBatchExpanded(new Set());

    try {
      const inputs = await Promise.all(
        files.map(async f => ({ name: f.name, text: await f.text() })),
      );
      const result = parseZBerichtBatch(inputs);
      setBatchResult(result);

      // Überschneidungen nur für erkennbare Dateien mit Zeitraum prüfen.
      const items = result.files
        .filter(f => f.status !== 'error' && f.periodFrom)
        .map(f => ({ id: f.id, periodFrom: f.periodFrom, periodTo: f.periodTo, costCenter: f.costCenter }));
      const overlaps = await fetchBatchOverlaps(tenantId, items);
      setBatchOverlaps(overlaps);
      setStep('preview');
    } catch (e) {
      setParseError('Fehler: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId]);

  // Routing: bei Z-Bericht mit mehreren Dateien → Batch, sonst Einzeldatei-Pfad.
  const handleFilesSelected = (files: File[]) => {
    const csvs = files.filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (csvs.length === 0) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    if (importType === 'zbericht' && csvs.length > 1) {
      processBatch(csvs);
    } else {
      handleFileSelect(csvs[0]);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    handleFilesSelected(Array.from(e.dataTransfer.files));
  };

  // ── Import-Abgleich Tagesabschluss (manuelle Korrekturen vs. Import) ───────

  const [importConflicts, setImportConflicts] = useState<TagesabschlussImportConflict[] | null>(null);
  const [conflictSaving, setConflictSaving] = useState(false);

  /**
   * Nach erfolgreichem TAGES-Import (period_from === period_to) prüfen, ob
   * für die importierten Tage manuelle Korrekturen im Tagesabschluss
   * existieren, die vom neuen Importwert abweichen → Abgleich-Dialog.
   * Best-effort: der Import selbst ist zu diesem Zeitpunkt bereits gespeichert.
   */
  const checkTagesabschlussConflicts = useCallback(async (dayDates: string[]) => {
    const dates = Array.from(new Set(dayDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))));
    if (dates.length === 0) return;
    try {
      const blob = await loadTagesabschluss(tenantId);
      if (Object.keys(blob.overrides).length === 0) return;
      // Nur die tatsächlich importierten Tage abgleichen — Auto-Werte anderer
      // Tage haben sich durch diesen Import nicht geändert.
      const closings: Record<string, GnDayClosing> = {};
      const months = Array.from(new Set(dates.map(d => d.slice(0, 7))));
      for (const m of months) {
        const [y, mm] = m.split('-').map(Number);
        const monthClosings = await loadGnDayClosingsForMonth(tenantId, y, mm);
        for (const d of dates) {
          if (monthClosings[d]) closings[d] = monthClosings[d];
        }
      }
      const conflicts = detectTagesabschlussImportConflicts(closings, blob);
      if (conflicts.length > 0) setImportConflicts(conflicts);
    } catch {
      // Abgleich ist best-effort — nie den bereits erfolgreichen Import stören.
    }
  }, [tenantId]);

  const handleConflictCancel = useCallback(() => {
    if (!conflictSaving) setImportConflicts(null);
  }, [conflictSaving]);

  const handleConflictConfirm = useCallback(async (resolutions: TagesabschlussImportConflictResolution[]) => {
    setConflictSaving(true);
    try {
      const takeN = resolutions.filter(r => r.action === 'uebernehmen').length;
      if (takeN > 0) {
        // Frisch laden → reine Mutation → speichern (merge-on-save):
        // der Dialog kann länger offen stehen, andere Flächen können den
        // Blob zwischenzeitlich verändert haben.
        const blob = await loadTagesabschluss(tenantId);
        const next = applyImportConflictResolutions(blob, resolutions, new Date().toISOString());
        if (next !== blob) await saveTagesabschluss(tenantId, next);
        toast.success(`${takeN} Korrektur${takeN === 1 ? '' : 'en'} entfernt — Importwert gilt wieder`);
      }
      setImportConflicts(null);
    } catch (e) {
      toast.error('Abgleich fehlgeschlagen: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setConflictSaving(false);
    }
  }, [tenantId]);

  // ── Bestätigen ─────────────────────────────────────────────────────────────

  // Manuelles Zeitraum-Update → Überschneidungen neu prüfen
  useEffect(() => {
    if (!parsed || importType !== 'zbericht') return;
    if (parsed.periodFrom && parsed.periodTo) return; // bereits in processCSV gecheckt
    if (!manualPeriodFrom || !manualPeriodTo) return;
    checkOverlappingImports(tenantId, manualPeriodFrom, manualPeriodTo).then(setOverlapInfo);
  }, [manualPeriodFrom, manualPeriodTo, tenantId, parsed, importType]);

  const handleConfirm = async (replacePersonDup = false) => {
    setStep('saving');
    let importedDays: string[] = [];
    if (importType === 'zbericht' && parsed) {
      const pFrom  = parsed.periodFrom || manualPeriodFrom || undefined;
      const pTo    = parsed.periodTo   || manualPeriodTo   || undefined;
      const ids    = overlapInfo.map(o => o.id);
      const { error } = await saveGnImport(tenantId, parsed, undefined, ids, pFrom, pTo);
      if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
      // Nur echte TAGES-Importe für den Tagesabschluss-Abgleich vormerken.
      if (pFrom && pTo && pFrom === pTo) importedDays = [pFrom];
    } else if (importType === 'personen' && parsedPerson) {
      const { error } = await savePersonImport(
        tenantId, parsedPerson,
        replacePersonDup && dupPersonInfo ? dupPersonInfo.existingId : undefined,
        csvTypeOverride ?? undefined,
      );
      if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
    } else if (importType === 'durchschnittsbon_bericht' && parsedAvg) {
      const { error } = await saveAverageCheckImport(tenantId, parsedAvg);
      if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
    }
    toast.success('Import erfolgreich gespeichert');
    setStep('done');
    setTab('history');
    loadHistory();
    if (importedDays.length > 0) void checkTagesabschlussConflicts(importedDays);
  };

  // Multi-Datei-Import bestätigen: Plan berechnen, pro Datei atomar speichern.
  const handleBatchConfirm = async () => {
    if (!batchResult) return;
    const plan = planBatchImport(batchResult.files, batchOverlaps, {
      conflictAction: batchConflict,
      errorPolicy:    batchErrorPolicy,
    });
    setBatchPlans(plan.plans);
    if (!plan.canProceed) {
      toast.error(plan.abortReason || 'Import nicht möglich.');
      return;
    }

    setStep('saving');
    const byId = new Map(batchResult.files.map(f => [f.id, f]));
    const items: BatchSaveItem[] = plan.plans.map(p => {
      const f = byId.get(p.id);
      return {
        id:         p.id,
        fileName:   p.fileName,
        parsed:     f?.parsed ?? null,
        action:     p.action,
        overlapIds: p.overlapIds,
        periodFrom: f?.periodFrom || undefined,
        periodTo:   f?.periodTo   || undefined,
      };
    });

    const results = await saveGnZBerichtBatch(tenantId, items);
    setBatchSaveResults(results);

    const okN   = results.filter(r => r.ok).length;
    const failN = results.filter(r => !r.ok && !r.skipped).length;
    if (failN > 0) toast.error(`${okN} importiert, ${failN} fehlgeschlagen`);
    else           toast.success(`${okN} Bericht${okN === 1 ? '' : 'e'} importiert`);

    setStep('done');
    loadHistory();

    // Tagesabschluss-Abgleich für erfolgreich importierte TAGES-Berichte.
    const importedDays = results
      .filter(r => r.ok && !r.skipped)
      .map(r => byId.get(r.id))
      .filter((f): f is NonNullable<typeof f> =>
        !!f && !!f.periodFrom && f.periodFrom === f.periodTo)
      .map(f => f.periodFrom as string);
    if (importedDays.length > 0) void checkTagesabschlussConflicts(importedDays);
  };

  // ── Löschen ────────────────────────────────────────────────────────────────

  const handleDeleteZ = async (id: string) => {
    if (!confirm('Diesen Import wirklich löschen?')) return;
    setDeleting(id);
    const { error } = await deleteGnImport(id);
    if (error) toast.error('Löschen fehlgeschlagen');
    else { toast.success('Import gelöscht'); loadHistory(); }
    setDeleting(null);
  };

  const handleDeleteP = async (id: string) => {
    if (!confirm('Diesen Import wirklich löschen?')) return;
    setDeleting(id);
    const { error } = await deletePersonImport(id);
    if (error) toast.error('Löschen fehlgeschlagen');
    else { toast.success('Import gelöscht'); loadHistory(); }
    setDeleting(null);
  };

  const handleDeleteAvg = async (id: string) => {
    if (!confirm('Diesen Import wirklich löschen?')) return;
    setDeleting(id);
    const { error } = await deleteAverageCheckImport(id);
    if (error) toast.error('Löschen fehlgeschlagen');
    else { toast.success('Import gelöscht'); loadHistory(); }
    setDeleting(null);
  };

  // ── Precompute (kein Division in JSX) ─────────────────────────────────────

  const grossTotal         = parsed ? parsed.revenue.totalGross : 0;
  const taxNetTotal        = parsed ? parsed.taxNetTotal : 0;
  const warnCount          = parsed ? parsed.warnings.length : 0;
  const ccCount            = parsed ? parsed.costCenters.length : 0;
  const waiterCount        = parsed ? parsed.waiters.length : 0;
  const pmCount            = parsed ? parsed.paymentMethods.length : 0;
  const pgCount            = parsed ? parsed.productGroups.length : 0;
  const discCount          = parsed ? parsed.discounts.length : 0;
  const cancelCount        = parsed ? parsed.cancellations.length : 0;
  const acctCount          = parsed ? parsed.accountingLines.length : 0;

  const pTotalGuests       = parsedPerson ? parsedPerson.totalGuests : 0;
  const pAvgRev            = parsedPerson ? parsedPerson.avgRevPerPerson : 0;
  const pTotalRev          = parsedPerson ? (parsedPerson.totalRevenue ?? 0) : 0;
  const pRowCount          = parsedPerson ? parsedPerson.rowCount : 0;
  const pWarnCount         = parsedPerson ? parsedPerson.warnings.length : 0;
  const pDurchschnBon      = parsedPerson ? parsedPerson.avgReceiptMonthly : 0;

  const avgRows            = parsedAvg ? parsedAvg.rows : [];
  const avgDayCount        = avgRows.length;
  const avgMean            = parsedAvg ? parsedAvg.averageMean : 0;
  const avgMin             = parsedAvg ? parsedAvg.averageMin : 0;
  const avgMax             = parsedAvg ? parsedAvg.averageMax : 0;
  const avgWarnCount       = parsedAvg ? parsedAvg.warnings.length : 0;

  const isBatch            = importType === 'zbericht' && !!batchResult;
  const activeDupInfo      = importType === 'personen' ? dupPersonInfo : null;
  const activeWarnCount    = importType === 'zbericht' ? warnCount
    : importType === 'personen' ? pWarnCount : avgWarnCount;
  const activeWarnings     = importType === 'zbericht' ? (parsed?.warnings ?? [])
    : importType === 'personen' ? (parsedPerson?.warnings ?? []) : (parsedAvg?.warnings ?? []);
  const hasOverlap         = importType === 'zbericht' && overlapInfo.length > 0;
  const avgHasOverlap      = importType === 'durchschnittsbon_bericht' && avgOverlapDates.length > 0;
  const showReplaceCta     = hasOverlap || avgHasOverlap;

  // Effektiver Zeitraum (Parser-Ergebnis hat Vorrang, dann manuell)
  const effectivePeriodFrom = parsed?.periodFrom || manualPeriodFrom || '';
  const effectivePeriodTo   = parsed?.periodTo   || manualPeriodTo   || '';
  const needsManualPeriod   = importType === 'zbericht' && parsed && !parsed.periodFrom;
  const importDayCount      = effectivePeriodFrom && effectivePeriodTo
    ? Math.round((new Date(effectivePeriodTo).getTime() - new Date(effectivePeriodFrom).getTime()) / 86400000) + 1
    : 0;

  const historyCount = zHistory.length + personHistory.length + avgHistory.length;

  // ── Diagnose kopieren ─────────────────────────────────────────────────────
  const copyDiagnostic = () => {
    if (!parsed) return;
    const db = parsed.debug;
    const lines: string[] = [
      '=== Gastronovi Parser-Diagnose ===',
      `Datei: ${parsed.fileName}`,
      `Trennzeichen: ${db.delimiter} (;=${db.delimCounts.semicolon} ,=${db.delimCounts.comma} Tab=${db.delimCounts.tab})`,
      '',
      `Zeitraum: ${parsed.periodFrom
        ? `${parsed.periodFrom} – ${parsed.periodTo}`
        : `NICHT ERKANNT (raw: "${db.periodRaw || '—'}")`}`,
      `Z-Zähler: ${parsed.zCounter || 'NICHT ERKANNT'}`,
      `Kostenstelle: ${parsed.costCenter || '—'}`,
      '',
      `Gefundene Sektionen (${db.foundSections.length}): ${db.foundSections.join(', ') || 'keine'}`,
      `Fehlende Sektionen (${db.missingSections.length}): ${db.missingSections.join(', ') || 'keine'}`,
    ];
    if (db.periodCandidates.length > 0) {
      lines.push('', 'Zeitraum-Kandidaten:');
      db.periodCandidates.forEach(c => lines.push(`  Zeile ${c.lineNumber}: "${c.rawText}"`));
    }
    if (db.zCounterCandidates.length > 0) {
      lines.push('', 'Z-Zähler-Kandidaten:');
      db.zCounterCandidates.forEach(c => lines.push(`  Zeile ${c.lineNumber}: "${c.rawText}"`));
    }
    for (const sec of db.missingSections) {
      const cands = db.sectionCandidates[sec];
      if (cands && cands.length > 0) {
        lines.push('', `Kandidaten für "${sec}":`);
        cands.forEach(c => lines.push(`  Zeile ${c.lineNumber}: "${c.rawText}"`));
      }
    }
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => toast.success('Diagnose in Zwischenablage kopiert'))
      .catch(() => toast.error('Kopieren fehlgeschlagen'));
  };

  const copyAvgDiagnostic = () => {
    if (!avgDebug) return;
    const d = avgDebug;
    const lines: string[] = [
      '=== Gastronovi Durchschnittsbon Parser-Diagnose ===',
      `Datei: ${d.fileName || '—'}`,
      `Trennzeichen: ${d.delimiter} (;=${d.delimCounts.semicolon} ,=${d.delimCounts.comma} Tab=${d.delimCounts.tab})`,
      `Zeilen: ${d.rawLineCount} gesamt, ${d.nonEmptyLineCount} nicht leer`,
      `Datumsartige Zellen gesamt: ${d.dateCellCount} · Geldwert-Zellen gesamt: ${d.moneyCellCount}`,
      '',
      `Layout: ${d.detectedFormat === 'wide' ? 'Wide (Datums-Spalten)' : d.detectedFormat === 'vertical' ? 'Langformat (eine Zeile pro Tag)' : 'NICHT ERKANNT'}`,
      `Verwendetes Jahr: ${d.usedYear ?? '—'} (Quelle: ${d.usedYearSource})`,
      `Erkannter Zeitraum: ${d.detectedPeriod || '—'}`,
      `Datums-Kopfzeile: ${d.headerRowIdx ? `Zeile ${d.headerRowIdx}` : (d.detectedFormat === 'vertical' ? '— (Langformat)' : 'NICHT ERKANNT')}`,
      `Datums-Spalten/-Zeilen (${d.dateColumns.length}): ${d.dateColumns.map(c => `${c.raw}→${c.iso}`).join(', ') || '—'}`,
      `Durchschnitt-/Wertezeile: ${d.averageRowIdx ? `Zeile ${d.averageRowIdx} (Label: "${d.averageRowLabel}")` : (d.averageRowLabel || 'NICHT ERKANNT')}`,
      `Übersprungene leere Tage: ${d.skippedEmptyColumns}`,
      `Tageswerte extrahiert: ${parsedAvg?.rows.length ?? 0}`,
      `Grund (falls keine): ${d.failureReason ?? '—'}`,
    ];
    if (d.averageCandidates.length > 0) {
      lines.push('', '"Durchschnitt"-Kandidaten:');
      d.averageCandidates.forEach(c => lines.push(`  Zeile ${c.lineNumber}: "${c.rawText}"`));
    }
    lines.push('', `Erste ${d.firstRawLines.length} Rohzeilen:`);
    d.firstRawLines.forEach((l, i) => lines.push(`  Z${String(i + 1).padStart(2)}: ${l || '(leer)'}`));
    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => toast.success('Diagnose in Zwischenablage kopiert'))
      .catch(() => toast.error('Kopieren fehlgeschlagen'));
  };

// ── Typ-Konstanten ─────────────────────────────────────────────────────────────

const CSV_TYPE_LABELS: Record<PersonCsvType, string> = {
  personen:          'Personen (kombiniert)',
  anzahl_personen:   'Anzahl Personen',
  umsatz_pro_person: 'Umsatz pro Person',
  durchschnittsbon:  'Durchschnittsbon',
};
const CSV_TYPE_OPTIONS: { value: PersonCsvType; label: string }[] = [
  { value: 'anzahl_personen',   label: 'Anzahl Personen' },
  { value: 'umsatz_pro_person', label: 'Umsatz pro Person' },
  { value: 'durchschnittsbon',  label: 'Durchschnittsbon' },
  { value: 'personen',          label: 'Personen (kombiniert)' },
];

  // ── Setup-Banner ─────────────────────────────────────────────────────────────

  if (tablesOk === false) {
    const checks    = diagnostic?.checks ?? [];
    const failures  = checks.filter(c => !c.ok);
    const isPerm    = failures.some(f => f.errorCode === '42501');
    const isMissing = failures.some(f => f.errorCode === '42P01' || f.errorCode === 'PGRST205');
    const isSchema  = diagnostic?.schemaHint ?? false;

    // Group checks by migration file for display
    const byMigration: Record<string, typeof checks> = {};
    for (const c of checks) {
      const key = c.migration ?? 'Unbekannt';
      if (!byMigration[key]) byMigration[key] = [];
      byMigration[key].push(c);
    }

    // Deduplicate: if a table appears multiple times (table check + column checks),
    // show the table once, then its columns
    const migrationOrder = [
      '20260617_gn_zbericht.sql',
      '20260617_gn_personen.sql',
      '20260617_gn_analysis.sql',
      '20260617_gn_analysis_create_missing_tables.sql',
      '20260617_gn_grants.sql',
      '20260618_gn_zbericht_v2.sql',
      '20260619_gn_rls_fix.sql',
      '20260620_gn_average_checks.sql',
    ];

    const recheck = () => {
      setTablesOk(null);
      setDiagnostic(null);
      runGnDiagnostic().then(result => {
        setDiagnostic(result);
        setTablesOk(result.allOk);
      });
    };

    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">
        <h1 className="text-base font-bold flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          Gastronovi Import
        </h1>

        {/* Hauptfehler-Box */}
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-red-800 dark:text-red-300 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {isPerm
                ? 'Fehlende DB-Zugriffsrechte (permission denied 42501)'
                : isMissing
                ? 'Tabellen fehlen — Migration nicht ausgeführt (42P01)'
                : 'Datenbank-Setup unvollständig'}
            </p>
            <button onClick={recheck}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700">
              <RefreshCw className="h-3 w-3" />
              Prüfen
            </button>
          </div>

          {/* Vollständige Prüfliste gruppiert nach Migration */}
          {checks.length > 0 && (
            <div className="space-y-3">
              {migrationOrder.filter(m => byMigration[m]).map(migration => (
                <div key={migration} className="rounded border border-red-200 bg-white dark:bg-black/20 overflow-hidden">
                  <div className="px-3 py-1.5 bg-red-100 dark:bg-red-900/20 border-b border-red-200 flex items-center justify-between">
                    <code className="text-xs font-mono font-semibold text-red-700 dark:text-red-400">
                      supabase/migrations/{migration}
                    </code>
                    <span className="text-xs text-red-500">
                      {byMigration[migration].filter(c => !c.ok).length}/{byMigration[migration].length} Fehler
                    </span>
                  </div>
                  <div className="divide-y divide-red-100 dark:divide-red-900/20">
                    {byMigration[migration].map((c, i) => (
                      <div key={i} className="px-3 py-1.5 flex items-start gap-2 text-xs">
                        <span className={c.ok ? 'text-green-500' : 'text-red-500'}>
                          {c.ok ? '✓' : '✗'}
                        </span>
                        <span className={`font-mono ${c.ok ? 'text-green-700 dark:text-green-400' : 'text-red-800 dark:text-red-300'}`}>
                          {c.table}{c.column && c.column !== 'id' ? `.${c.column}` : ''}
                        </span>
                        {!c.ok && (
                          <span className="text-red-500 dark:text-red-400 ml-1">
                            [{c.errorCode}]&nbsp;
                            {c.errorCode === '42501' ? 'permission denied' :
                             c.errorCode === '42P01' ? 'Tabelle fehlt' :
                             c.errorCode === '42703' ? 'Spalte fehlt' :
                             c.errorMessage ?? ''}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Lösung */}
          {isPerm && (
            <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                Lösung: eine einzige Migration im Supabase SQL-Editor ausführen:
              </p>
              <code className="block text-sm font-mono font-bold text-amber-900 dark:text-amber-200">
                supabase/migrations/20260617_gn_grants.sql
              </code>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Die Tabellen existieren. Dem <code>authenticated</code>-Role fehlen nur die
                {' '}<code>GRANT SELECT, INSERT, UPDATE, DELETE</code>-Rechte.
              </p>
            </div>
          )}
          {isMissing && (
            <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-1.5">
              <p className="text-xs font-semibold text-amber-800">In dieser Reihenfolge ausführen:</p>
              {['20260617_gn_zbericht.sql', '20260617_gn_personen.sql', '20260617_gn_analysis.sql', '20260617_gn_grants.sql'].map(f => (
                <code key={f} className="block text-xs font-mono">supabase/migrations/{f}</code>
              ))}
            </div>
          )}
          {!isPerm && !isMissing && failures.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-1">
              <p className="text-xs font-semibold text-amber-800">In dieser Reihenfolge ausführen:</p>
              {['20260617_gn_zbericht.sql', '20260617_gn_personen.sql', '20260617_gn_analysis.sql', '20260617_gn_grants.sql'].map(f => (
                <code key={f} className="block text-xs font-mono mt-0.5">supabase/migrations/{f}</code>
              ))}
            </div>
          )}

          {isSchema && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <Info className="h-3 w-3 shrink-0" />
              Supabase Schema Cache könnte veraltet sein — App neu laden oder Cache aktualisieren.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (tablesOk === null) {
    return (
      <div className="flex items-center justify-center py-24 gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Prüfe Datenbank…
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-bold">Gastronovi Import</h1>
          <p className="text-xs text-muted-foreground mt-0.5">CSV-Berichte importieren und strukturiert speichern</p>
        </div>
        <div className="ml-auto flex items-center gap-0.5 bg-muted rounded-md p-0.5">
          {(['import', 'history'] as Tab[]).map(t => (
            <button key={t}
              onClick={() => { setTab(t); if (t === 'import') resetWizard(); }}
              className={cn('px-3 py-1.5 rounded text-xs font-medium transition-colors',
                tab === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {t === 'import' ? 'Neuer Import' : `Importverlauf${historyCount > 0 ? ` (${historyCount})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {/* Hinweis aus der Import-Checkliste (advisory, schränkt nichts ein) */}
      <ImportTaskPrefillHint />

      {/* ── Import Tab ──────────────────────────────────────────────────────── */}
      {tab === 'import' && <>

        {/* Import-Typ Auswahl */}
        <div className="flex gap-2 flex-wrap">
          <TypeBtn active={importType === 'zbericht'} onClick={() => handleTypeChange('zbericht')}
            icon={<FileText className="h-4 w-4" />} label="Z-Bericht" desc="Tagesumsatz, Kostenstellen, Kellner, Bezahlarten" />
          <TypeBtn active={importType === 'personen'} onClick={() => handleTypeChange('personen')}
            icon={<Users className="h-4 w-4" />} label="Personen Bericht" desc="Gäste / Umsatz pro Person" />
          <TypeBtn active={importType === 'durchschnittsbon_bericht'} onClick={() => handleTypeChange('durchschnittsbon_bericht')}
            icon={<Receipt className="h-4 w-4" />} label="Durchschnittsbon Bericht" desc="Durchschnittsbon pro Tag" />
        </div>

        {/* Wizard-Schritte */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {(['upload', 'preview', 'done'] as WizardStep[]).map((s, i) => {
            const labels: Record<WizardStep, string> = { upload: 'Hochladen', preview: 'Vorschau', saving: 'Speichern', done: 'Fertig' };
            const done   = step === 'done' || (step !== 'upload' && s === 'upload') || (step === 'done' && s === 'preview');
            const active = step === s;
            return <>
              {i > 0 && <span key={'sep' + i} className="text-border">›</span>}
              <span key={s} className={cn('font-medium', active && 'text-primary', done && 'text-emerald-600 dark:text-emerald-400')}>
                {labels[s]}
              </span>
            </>;
          })}
        </div>

        {/* ── Step: Upload ──────────────────────────────────────────────────── */}
        {step === 'upload' && <>
          <DropZone
            isDragging={isDragging}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => csvRef.current?.click()}
            label={importType === 'zbericht' ? 'Gastronovi Z-Bericht CSV hier ablegen'
              : importType === 'personen' ? 'Gastronovi Personen-Bericht CSV hier ablegen'
              : 'Gastronovi Durchschnittsbon CSV hier ablegen'}
            hint={importType === 'zbericht' ? 'Eine oder mehrere Tagesberichte gleichzeitig auswählbar'
              : importType === 'personen' ? 'Analyse → Verkäufe → Personen / Umsatz pro Person'
              : importType === 'durchschnittsbon_bericht' ? 'Analyse → Verkäufe → Durchschnittsbon (Tageswerte als Spalten)'
              : undefined}
          />
          <input ref={csvRef} type="file" accept=".csv" className="hidden"
            multiple={importType === 'zbericht'}
            onChange={e => {
              if (e.target.files && e.target.files.length) handleFilesSelected(Array.from(e.target.files));
              e.target.value = '';
            }} />

          {parseError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-400">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {parseError}
            </div>
          )}

          {/* Parser-Diagnose bei fehlgeschlagenem Durchschnittsbon-Import */}
          {importType === 'durchschnittsbon_bericht' && avgDebug && (
            <AvgDiagnostic
              debug={avgDebug}
              open={showAvgDebug}
              onToggle={() => setShowAvgDebug(v => !v)}
              onCopy={copyAvgDiagnostic}
            />
          )}
        </>}

        {/* ── Step: Preview ─────────────────────────────────────────────────── */}
        {(step === 'preview' || step === 'saving') && <>

          {/* Duplikat-Warnung */}
          {activeDupInfo && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
              <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Dieser Bericht wurde bereits importiert
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Importiert am: {fdate(activeDupInfo.importedAt)}
              </p>
              <div className="flex gap-2 mt-2">
                <button onClick={resetWizard}
                  className="px-3 py-1.5 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-100">
                  Abbrechen
                </button>
                <button onClick={() => handleConfirm(true)} disabled={step === 'saving'}
                  className="px-3 py-1.5 text-xs rounded bg-amber-600 text-white hover:bg-amber-700 flex items-center gap-1.5 disabled:opacity-50">
                  {step === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
                  Bestehenden Import ersetzen
                </button>
              </div>
            </div>
          )}

          {/* Warnungen */}
          {activeWarnCount > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-1">
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                {activeWarnCount} Hinweis{activeWarnCount > 1 ? 'e' : ''}
              </p>
              {activeWarnings.map((w, i) => (
                <p key={i} className="text-xs text-blue-600 dark:text-blue-400 ml-5">{w}</p>
              ))}
            </div>
          )}

          {/* ── Z-Bericht Multi-Datei Vorschau (Batch) ─────────────────────── */}
          {isBatch && batchResult && <>
            {/* Aggregat-Kacheln */}
            <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetaCell label="Dateien"      value={String(batchResult.aggregate.fileCount)} />
              <MetaCell label="Tagesberichte" value={String(batchResult.aggregate.dailyReportCount)} />
              <MetaCell label="Zeitraum-Berichte" value={String(batchResult.aggregate.periodReportCount)} />
              <MetaCell label="Fehlerhaft"   value={String(batchResult.aggregate.errorCount)} />
              <MetaCell label="Zeitraum"     value={`${fdate(batchResult.aggregate.dayFrom)} – ${fdate(batchResult.aggregate.dayTo)}`} />
              <MetaCell label="Brutto Σ"     value={fc(batchResult.aggregate.totalGross)} />
              <MetaCell label="Netto Σ"      value={fc(batchResult.aggregate.totalNet)} />
              <MetaCell label="Getränke Σ"   value={fc(batchResult.aggregate.totalBev)} />
            </div>

            {/* Steuerung: Fehler-Richtlinie & Konfliktaktion */}
            <div className="rounded-lg border border-border bg-muted/10 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="space-y-1.5">
                <span className="text-xs font-semibold text-muted-foreground">Bei fehlerhaften Dateien</span>
                <select value={batchErrorPolicy} disabled={step === 'saving'}
                  onChange={e => setBatchErrorPolicy(e.target.value as ErrorPolicy)}
                  className="w-full text-sm rounded-md border border-border bg-background px-3 py-2">
                  <option value="only_valid">Nur gültige importieren</option>
                  <option value="abort_on_error">Bei Fehlern abbrechen</option>
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-semibold text-muted-foreground">Bei bestehenden Daten (Konflikt)</span>
                <select value={batchConflict} disabled={step === 'saving'}
                  onChange={e => setBatchConflict(e.target.value as ConflictAction)}
                  className="w-full text-sm rounded-md border border-border bg-background px-3 py-2">
                  <option value="replace">Ersetzen</option>
                  <option value="skip">Überspringen</option>
                  <option value="abort">Abbrechen</option>
                </select>
              </label>
            </div>

            {/* Datei-Liste */}
            <div className="space-y-2">
              {batchResult.files.map((f, i) => {
                const hasOv = (batchOverlaps[f.id]?.length ?? 0) > 0;
                const open = batchExpanded.has(f.id);
                const tone =
                  f.status === 'error'   ? 'border-red-300 bg-red-50 dark:bg-red-950/20'
                  : f.status === 'warning' ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'
                  : 'border-border bg-card';
                return (
                  <div key={`${f.fileName}-${i}`} className={cn('rounded-lg border', tone)}>
                    <button type="button"
                      onClick={() => setBatchExpanded(prev => {
                        const n = new Set(prev); open ? n.delete(f.id) : n.add(f.id); return n;
                      })}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left">
                      {f.status === 'error'   ? <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                       : f.status === 'warning' ? <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                       : <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{f.fileName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {f.periodFrom ? `${fdate(f.periodFrom)}${f.isMultiDay ? ` – ${fdate(f.periodTo)}` : ''}` : 'Kein Zeitraum'}
                          {' · '}{f.importKindLabel}
                          {f.costCenter ? ` · ${f.costCenter}` : ''}
                          {f.zCounter ? ` · Z-Nr. ${f.zCounter}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {hasOv && (
                          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            Bestehende Daten
                          </span>
                        )}
                        <span className="text-sm font-semibold tabular-nums">{fc(f.grossRevenue ?? 0)}</span>
                        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>
                    {open && (
                      <div className="border-t border-border px-4 py-3 space-y-3">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <MetaCell label="Brutto"   value={fc(f.grossRevenue ?? 0)} />
                          <MetaCell label="Netto"    value={fc(f.netRevenue ?? 0)} />
                          <MetaCell label="Food"     value={fc(f.foodRevenue ?? 0)} />
                          <MetaCell label="Getränke" value={fc(f.bevRevenue ?? 0)} />
                        </div>
                        {f.errorReason && (
                          <p className="text-xs text-red-600 dark:text-red-400">{f.errorReason}</p>
                        )}
                        {f.warnings.length > 0 && (
                          <div className="space-y-1">
                            {f.warnings.map((w, wi) => (
                              <p key={wi} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                                <Info className="h-3 w-3 mt-0.5 shrink-0" />{w}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Aktionen */}
            <div className="flex gap-3 pt-2 flex-wrap">
              <button onClick={resetWizard} disabled={step === 'saving'}
                className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                Abbrechen
              </button>
              <button onClick={handleBatchConfirm} disabled={step === 'saving'}
                className="px-5 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2 transition-colors">
                {step === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <CheckCircle2 className="h-3.5 w-3.5" />
                {batchConflict === 'replace' ? 'Importieren / Ersetzen' : 'Import bestätigen'}
              </button>
            </div>
          </>}

          {/* ── Z-Bericht Vorschau ─────────────────────────────────────────── */}
          {importType === 'zbericht' && parsed && <>
            <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetaCell label="Zeitraum"     value={`${fdate(effectivePeriodFrom || parsed.periodFrom)} – ${fdate(effectivePeriodTo || parsed.periodTo)}`} />
              <MetaCell label="Z-Zähler"     value={parsed.zCounter || '—'} />
              <MetaCell label="Kostenstelle" value={parsed.costCenter || '—'} />
            </div>

            {/* Manueller Zeitraum (nur wenn Parser keinen Zeitraum erkennt) */}
            {needsManualPeriod && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-3">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  Zeitraum nicht erkannt — bitte manuell eingeben
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Von</label>
                    <input type="date" value={manualPeriodFrom}
                      onChange={e => setManualPeriodFrom(e.target.value)}
                      className="text-xs border border-border rounded px-2 py-1.5 bg-background" />
                  </div>
                  <span className="text-muted-foreground mt-4">–</span>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Bis</label>
                    <input type="date" value={manualPeriodTo}
                      onChange={e => setManualPeriodTo(e.target.value)}
                      className="text-xs border border-border rounded px-2 py-1.5 bg-background" />
                  </div>
                  {importDayCount > 0 && (
                    <span className="text-xs text-muted-foreground mt-4">{importDayCount} Tag{importDayCount !== 1 ? 'e' : ''}</span>
                  )}
                </div>
              </div>
            )}

            {/* Import-Vorschau: Importart + Überschneidungen */}
            {(effectivePeriodFrom || hasOverlap) && (
              <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Importart</div>
                    <div className="font-semibold">
                      {importDayCount === 1 ? 'Tagesimport'
                        : importDayCount <= 7 && importDayCount > 1 ? 'Wochenimport'
                        : importDayCount >= 28 && importDayCount <= 32 ? 'Monatsimport'
                        : importDayCount > 0 ? 'Zeitraumimport' : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Anzahl Tage</div>
                    <div className="font-semibold">{importDayCount > 0 ? importDayCount : '—'}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Zeitraum</div>
                    <div className="font-semibold text-[11px]">
                      {effectivePeriodFrom ? `${fdate(effectivePeriodFrom)} – ${fdate(effectivePeriodTo)}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Überschneidungen</div>
                    <div className={`font-semibold ${overlapInfo.length > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                      {overlapInfo.length > 0 ? `${overlapInfo.length} Import${overlapInfo.length > 1 ? 'e' : ''}` : 'Keine'}
                    </div>
                  </div>
                </div>

                {/* Überschneidende Importe auflisten */}
                {overlapInfo.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Folgende Importe werden beim Bestätigen ersetzt:
                    </p>
                    {overlapInfo.map(o => (
                      <div key={o.id} className="flex items-center justify-between gap-3 text-xs rounded bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40 px-3 py-1.5">
                        <span className="font-medium truncate flex-1 min-w-0">{o.file_name}</span>
                        <span className="text-muted-foreground shrink-0">{fdate(o.period_from)} – {fdate(o.period_to)}</span>
                        <span className="font-mono shrink-0 text-right">{o.gross_revenue !== null && o.gross_revenue > 0 ? `CHF ${NUM.format(o.gross_revenue)}` : '—'}</span>
                        {o.import_type && o.import_type !== 'period' && (
                          <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded shrink-0">{importTypeLabel(o.import_type)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <KpiMini label="Brutto Umsatz" value={fc(grossTotal)} />
              <KpiMini label="Netto Umsatz"  value={fc(taxNetTotal)} bold />
              <KpiMini label="Food"          value={fc(parsed.foodAmount)} />
              <KpiMini label="Beverage"      value={fc(parsed.bevAmount)} />
              <KpiMini label="Bar"           value={fc(parsed.barAmount)} />
              <KpiMini label="Take Away"     value={fc(parsed.takeAwayAmount)} />
              <KpiMini label="Rabatte"       value={fc(parsed.discountTotal)} neg />
              <KpiMini label="Storno"        value={fc(parsed.stornoTotal)} neg />
              <KpiMini label="Marketing"     value={fc(parsed.marketingAmount)} neg />
              <KpiMini label="Maison"        value={fc(parsed.maisonAmount)} neg />
              <KpiMini label="Anzahl Bons"   value={parsed.bonCount > 0 ? NUM0.format(parsed.bonCount) : '—'} />
              <KpiMini label="Ø Bon"         value={fc(parsed.avgBon)} />
            </div>

            <SectionTable title={`Kostenstellen (${ccCount})`} rows={parsed.costCenters} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />
            <SectionTable title={`Kellner (${waiterCount})`} rows={parsed.waiters} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />
            <SectionTable title={`Bezahlarten (${pmCount})`} rows={parsed.paymentMethods} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />
            <SectionTable title={`Hauptwarengruppen (${pgCount})`} rows={parsed.productGroups} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />
            <SectionTable title={`Rabatte & Positionsrabatte (${discCount})`} rows={parsed.discounts} cols={['Typ', 'Name', 'Betrag']}
              render={r => [r.type, r.name, fc(r.amount)]} />
            <SectionTable title={`Stornierte Artikel (${cancelCount})`} rows={parsed.cancellations} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />
            <SectionTable title={`Buchungskonten (${acctCount})`} rows={parsed.accountingLines} cols={['Name', 'Konto', 'MwSt', 'Brutto']}
              render={r => [r.name, r.account, r.taxRate, fc(r.grossAmount)]} />

            {parsed.taxes.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/40 border-b text-xs font-semibold">Steuerbericht</div>
                <table className="w-full text-xs">
                  <thead><tr className="border-b bg-muted/20 text-right">
                    <th className="px-3 py-1.5 text-left font-medium">Satz</th>
                    <th className="px-3 py-1.5 font-medium">Netto</th>
                    <th className="px-3 py-1.5 font-medium">MwSt</th>
                    <th className="px-3 py-1.5 font-medium">Brutto</th>
                  </tr></thead>
                  <tbody>
                    {parsed.taxes.map((t, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-1.5">{t.taxRate}</td>
                        <td className="px-3 py-1.5 text-right">{fc(t.netAmount)}</td>
                        <td className="px-3 py-1.5 text-right">{fc(t.taxAmount)}</td>
                        <td className="px-3 py-1.5 text-right">{fc(t.grossAmount)}</td>
                      </tr>
                    ))}
                    <tr className="bg-muted/30 font-semibold">
                      <td className="px-3 py-1.5">Total Netto</td>
                      <td className="px-3 py-1.5 text-right" colSpan={3}>{fc(taxNetTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}


            {/* ── Parser-Diagnose ─────────────────────────────────────────── */}
            {parsed.debug && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                <button
                  onClick={() => setShowDebug(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <span className="flex items-center gap-2">
                    <Info className="h-3.5 w-3.5" />
                    Parser-Diagnose
                    {parsed.debug.missingSections.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">
                        {parsed.debug.missingSections.length} Sektionen fehlen
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <button
                      onClick={e => { e.stopPropagation(); copyDiagnostic(); }}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 text-[10px] font-medium">
                      <Copy className="h-2.5 w-2.5" />
                      Diagnose kopieren
                    </button>
                    {showDebug ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </span>
                </button>

                {showDebug && (
                  <div className="p-4 space-y-4 text-xs">

                    {/* Trennzeichen + Metadaten */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
                        <div className="text-muted-foreground mb-0.5">Trennzeichen</div>
                        <div className="font-mono font-bold">{parsed.debug.delimiter}</div>
                        <div className="text-muted-foreground mt-1">
                          ;={parsed.debug.delimCounts.semicolon} ,={parsed.debug.delimCounts.comma} ⇥={parsed.debug.delimCounts.tab}
                        </div>
                      </div>
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
                        <div className="text-muted-foreground mb-0.5">
                          Zeitraum {parsed.debug.periodLine ? `(Zeile ${parsed.debug.periodLine})` : ''}
                        </div>
                        <div className={`font-mono font-bold ${!parsed.debug.periodRaw ? 'text-red-500' : ''}`}>
                          {parsed.debug.periodRaw || '(nicht gefunden)'}
                        </div>
                        {parsed.periodFrom && (
                          <div className="text-muted-foreground mt-1">
                            → {parsed.periodFrom} – {parsed.periodTo}
                          </div>
                        )}
                      </div>
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
                        <div className="text-muted-foreground mb-0.5">
                          Z-Zähler {parsed.debug.zCounterLine ? `(Zeile ${parsed.debug.zCounterLine})` : ''}
                        </div>
                        <div className={`font-mono font-bold ${!parsed.debug.zCounterRaw ? 'text-red-500' : ''}`}>
                          {parsed.debug.zCounterRaw || '(nicht gefunden)'}
                        </div>
                      </div>
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
                        <div className="text-muted-foreground mb-0.5">Kostenstelle</div>
                        <div className={`font-mono font-bold ${!parsed.debug.costCenterRaw ? 'text-amber-500' : ''}`}>
                          {parsed.debug.costCenterRaw || '(nicht gefunden)'}
                        </div>
                      </div>
                    </div>

                    {/* Zeitraum-Kandidaten */}
                    {!parsed.periodFrom && parsed.debug.periodCandidates.length > 0 && (
                      <CandidateBlock
                        title="Mögliche Zeitraum-Treffer"
                        color="blue"
                        candidates={parsed.debug.periodCandidates}
                      />
                    )}

                    {/* Z-Zähler-Kandidaten */}
                    {!parsed.zCounter && parsed.debug.zCounterCandidates.length > 0 && (
                      <CandidateBlock
                        title="Mögliche Z-Zähler-Treffer"
                        color="violet"
                        candidates={parsed.debug.zCounterCandidates}
                      />
                    )}

                    {/* Sektionen */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-3 space-y-1">
                        <div className="font-semibold mb-2 text-slate-700 dark:text-slate-300">
                          Erkannte Sektionen ({parsed.debug.foundSections.length})
                        </div>
                        {parsed.debug.foundSections.length === 0
                          ? <div className="text-muted-foreground italic">keine</div>
                          : parsed.debug.foundSections.map(s => (
                            <div key={s} className="flex items-center gap-1.5">
                              <span className="text-green-500 shrink-0">✓</span>
                              <span className="font-mono">{s}</span>
                              {parsed.debug.rawSectionNames.find(x => x.canonical === s)?.raw !== s && (
                                <span className="text-muted-foreground ml-1">
                                  (CSV: &ldquo;{parsed.debug.rawSectionNames.find(x => x.canonical === s)?.raw}&rdquo;)
                                </span>
                              )}
                            </div>
                          ))
                        }
                      </div>
                      <div className="rounded border border-slate-200 dark:border-slate-700 p-3 space-y-1">
                        <div className="font-semibold mb-2 text-slate-700 dark:text-slate-300">
                          Fehlende Sektionen ({parsed.debug.missingSections.length})
                        </div>
                        {parsed.debug.missingSections.length === 0
                          ? <div className="text-green-600 dark:text-green-400">Alle Pflicht-Sektionen gefunden ✓</div>
                          : parsed.debug.missingSections.map(s => {
                            const cands = parsed.debug.sectionCandidates[s];
                            return (
                              <div key={s} className="space-y-0.5">
                                <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                                  <span className="shrink-0">✗</span>
                                  <span className="font-mono">{s}</span>
                                  {cands && cands.length > 0 && (
                                    <span className="text-[9px] text-slate-400 ml-1">{cands.length} Kandidat{cands.length !== 1 ? 'en' : ''}</span>
                                  )}
                                </div>
                                {cands && cands.map((c, ci) => (
                                  <div key={ci} className="ml-4 flex gap-1.5 text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                                    <span className="text-slate-400 shrink-0">Z{c.lineNumber}:</span>
                                    <span className="truncate">{c.rawText}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          })
                        }
                      </div>
                    </div>

                    {/* Rohdaten anzeigen */}
                    <details className="rounded border border-slate-200 dark:border-slate-700">
                      <summary className="px-3 py-2 cursor-pointer font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2">
                        <span>Rohdaten anzeigen</span>
                        <span className="text-[10px] font-normal text-muted-foreground">(erste 30 CSV-Zeilen)</span>
                      </summary>
                      <div className="overflow-x-auto max-h-72 overflow-y-auto">
                        <table className="w-full font-mono text-[10px] border-collapse">
                          <thead>
                            <tr className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                              <th className="px-2 py-1 text-right border-r border-slate-200 dark:border-slate-700 text-slate-400 w-8">#</th>
                              <th className="px-2 py-1 text-left text-slate-500">Zeile</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parsed.debug.firstRawLines.slice(0, 30).map((line, i) => (
                              <tr key={i} className={`border-t border-slate-100 dark:border-slate-800 ${
                                parsed.debug.rawSectionNames.some(x =>
                                  line.startsWith(x.raw)
                                ) ? 'bg-blue-50 dark:bg-blue-950/20 font-bold' : ''
                              }`}>
                                <td className="px-2 py-0.5 text-right border-r border-slate-200 dark:border-slate-700 text-slate-400">
                                  {i + 1}
                                </td>
                                <td className="px-2 py-0.5 text-slate-700 dark:text-slate-300 whitespace-pre max-w-0 overflow-hidden">
                                  {line || <span className="text-slate-300">(leer)</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>

                  </div>
                )}
              </div>
            )}
          </>}

          {/* ── Personen Vorschau ─────────────────────────────────────────── */}
          {importType === 'personen' && parsedPerson && <>
            <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetaCell label="Zeitraum"    value={`${fdate(parsedPerson.periodFrom)} – ${fdate(parsedPerson.periodTo)}`} />
              <MetaCell label="Datenzeilen" value={String(pRowCount)} />
              <MetaCell label="Datei"       value={parsedPerson.fileName} />
            </div>

            {/* Erkannter Typ + Override */}
            <div className="flex items-center gap-3 flex-wrap rounded-lg border border-border bg-muted/20 px-4 py-3">
              <span className="text-xs text-muted-foreground">Erkannter Analysetyp:</span>
              <span className={cn('px-2 py-0.5 rounded text-[11px] font-semibold',
                (csvTypeOverride ?? parsedPerson.detectedCsvType) === 'durchschnittsbon'
                  ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                  : (csvTypeOverride ?? parsedPerson.detectedCsvType) === 'umsatz_pro_person'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
              )}>
                {CSV_TYPE_LABELS[csvTypeOverride ?? parsedPerson.detectedCsvType]}
              </span>
              <span className="text-[11px] text-muted-foreground ml-auto">Typ ändern:</span>
              <select
                value={csvTypeOverride ?? parsedPerson.detectedCsvType}
                onChange={e => setCsvTypeOverride(e.target.value as PersonCsvType)}
                className="text-xs rounded border border-border bg-background px-2 py-1">
                {CSV_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>

            {/* KPIs je nach Typ */}
            {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'durchschnittsbon' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiMini label="Ø Durchschnittsbon"  value={pDurchschnBon > 0 ? fc(pDurchschnBon) : '—'} bold />
                <KpiMini label="Tageswerte erkannt"  value={pRowCount > 0 ? 'Ja' : 'Nein'} />
                <KpiMini label="Erkannte Zeilen"     value={String(pRowCount)} />
                <KpiMini label="Zeitraum"            value={`${fdate(parsedPerson.periodFrom)} – ${fdate(parsedPerson.periodTo)}`} />
              </div>
            )}
            {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'umsatz_pro_person' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiMini label="Ø Umsatz pro Person" value={pAvgRev > 0 ? fc(pAvgRev) : '—'} bold />
                <KpiMini label="Umsatz Total"        value={pTotalRev > 0 ? fc(pTotalRev) : '—'} />
                <KpiMini label="Erkannte Zeilen"     value={String(pRowCount)} />
              </div>
            )}
            {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'anzahl_personen' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiMini label="Gäste Total"         value={pTotalGuests > 0 ? NUM0.format(pTotalGuests) : '—'} bold />
                <KpiMini label="Erkannte Zeilen"     value={String(pRowCount)} />
              </div>
            )}
            {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'personen' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiMini label="Gäste Total"         value={pTotalGuests > 0 ? NUM0.format(pTotalGuests) : '—'} bold />
                <KpiMini label="Ø Umsatz pro Gast"   value={pAvgRev > 0 ? fc(pAvgRev) : '—'} />
                <KpiMini label="Umsatz Total"        value={pTotalRev > 0 ? fc(pTotalRev) : '—'} />
                <KpiMini label="Erkannte Zeilen"     value={String(pRowCount)} />
              </div>
            )}

            {parsedPerson.rows.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/40 border-b text-xs font-semibold">
                  Vorschau (erste {Math.min(parsedPerson.rows.length, 20)} Zeilen)
                </div>
                <table className="w-full text-xs">
                  <thead><tr className="border-b bg-muted/20 text-right">
                    <th className="px-3 py-1.5 text-left font-medium">Datum / Periode</th>
                    {(csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'durchschnittsbon' &&
                      <th className="px-3 py-1.5 font-medium">Personen</th>}
                    {(csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'anzahl_personen' &&
                     (csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'durchschnittsbon' &&
                      <th className="px-3 py-1.5 font-medium">Umsatz / Person</th>}
                    {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'durchschnittsbon' &&
                      <th className="px-3 py-1.5 font-medium">Durchschnittsbon</th>}
                    <th className="px-3 py-1.5 font-medium">Umsatz Total</th>
                  </tr></thead>
                  <tbody>
                    {parsedPerson.rows.slice(0, 20).map((r, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-1.5">{r.date ? fdate(r.date) : (r.periodLabel ?? '—')}</td>
                        {(csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'durchschnittsbon' &&
                          <td className="px-3 py-1.5 text-right">{r.guestsCount > 0 ? NUM0.format(r.guestsCount) : '—'}</td>}
                        {(csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'anzahl_personen' &&
                         (csvTypeOverride ?? parsedPerson.detectedCsvType) !== 'durchschnittsbon' &&
                          <td className="px-3 py-1.5 text-right">{r.revPerPerson > 0 ? fc(r.revPerPerson) : '—'}</td>}
                        {(csvTypeOverride ?? parsedPerson.detectedCsvType) === 'durchschnittsbon' &&
                          <td className="px-3 py-1.5 text-right">{r.averageReceipt ? fc(r.averageReceipt) : '—'}</td>}
                        <td className="px-3 py-1.5 text-right">{r.revTotal ? fc(r.revTotal) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>}

          {/* ── Durchschnittsbon Vorschau ─────────────────────────────────── */}
          {importType === 'durchschnittsbon_bericht' && parsedAvg && <>
            <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetaCell label="Zeitraum"    value={`${fdate(parsedAvg.periodFrom)} – ${fdate(parsedAvg.periodTo)}`} />
              <MetaCell label="Anzahl Tage" value={String(avgDayCount)} />
              <MetaCell label="Datei"       value={parsedAvg.fileName} />
            </div>

            {/* Importjahr-Wahl — nur wenn im Bericht kein Jahr gefunden wurde */}
            {parsedAvg.debug.usedYearSource === 'Benutzerwahl' && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Importjahr prüfen
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Bitte Importjahr prüfen, da im Bericht kein Jahr enthalten ist
                  (weder in Datumsspalten, Zeitraum noch Dateiname). Die Tageswerte
                  werden dem gewählten Jahr zugeordnet.
                </p>
                <div className="flex items-center gap-2">
                  <label htmlFor="avg-import-year" className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    Importjahr:
                  </label>
                  <select
                    id="avg-import-year"
                    value={avgImportYear}
                    onChange={e => handleAvgYearChange(Number(e.target.value))}
                    disabled={step === 'saving'}
                    className="px-2 py-1 text-sm rounded border border-amber-400 bg-white dark:bg-slate-900 text-foreground disabled:opacity-50">
                    {Array.from({ length: 8 }, (_, i) => new Date().getFullYear() + 1 - i).map(y => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <KpiMini label="Ø Durchschnittsbon" value={avgMean > 0 ? fc(avgMean) : '—'} bold />
              <KpiMini label="Minimum"            value={avgMin > 0 ? fc(avgMin) : '—'} />
              <KpiMini label="Maximum"            value={avgMax > 0 ? fc(avgMax) : '—'} />
              <KpiMini label="Tageswerte"         value={avgDayCount > 0 ? `${avgDayCount} Tage` : '—'} />
            </div>

            {avgOverlapDates.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {avgOverlapDates.length === 1
                  ? '1 bereits importierter Tag wird beim Bestätigen ersetzt.'
                  : `${avgOverlapDates.length} bereits importierte Tage werden beim Bestätigen ersetzt.`}
              </div>
            )}

            {avgRows.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/40 border-b text-xs font-semibold">
                  Tageswerte ({avgRows.length})
                </div>
                <div className="max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b bg-muted/20 text-right sticky top-0 bg-card">
                      <th className="px-3 py-1.5 text-left font-medium">Datum</th>
                      <th className="px-3 py-1.5 font-medium">Durchschnittsbon</th>
                    </tr></thead>
                    <tbody>
                      {avgRows.map((r, i) => (
                        <tr key={i} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-1.5">{fdate(r.date)}</td>
                          <td className="px-3 py-1.5 text-right">{r.averageCheck > 0 ? fc(r.averageCheck) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {avgDebug && (
              <AvgDiagnostic
                debug={avgDebug}
                open={showAvgDebug}
                onToggle={() => setShowAvgDebug(v => !v)}
                onCopy={copyAvgDiagnostic}
              />
            )}
          </>}

          {/* Bestätigen-Buttons (Einzeldatei) */}
          {!activeDupInfo && !isBatch && (
            <div className="flex gap-3 pt-2 flex-wrap">
              <button onClick={resetWizard}
                className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                Abbrechen
              </button>
              <button onClick={() => handleConfirm(false)} disabled={step === 'saving'}
                className={cn(
                  'px-5 py-2 text-sm rounded-md disabled:opacity-50 flex items-center gap-2 transition-colors',
                  showReplaceCta
                    ? 'bg-amber-600 text-white hover:bg-amber-700'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}>
                {step === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <CheckCircle2 className="h-3.5 w-3.5" />
                {showReplaceCta ? 'Importieren und Daten ersetzen' : 'Import bestätigen'}
              </button>
            </div>
          )}
        </>}

        {/* ── Step: Done (Einzeldatei) ──────────────────────────────────────── */}
        {step === 'done' && !batchSaveResults && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-8 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-semibold text-emerald-800 dark:text-emerald-300">Import erfolgreich</p>
            <button onClick={resetWizard}
              className="mt-2 px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
              Weiteren Import starten
            </button>
          </div>
        )}

        {/* ── Step: Done (Multi-Datei Ergebnis) ─────────────────────────────── */}
        {step === 'done' && batchSaveResults && (() => {
          const okN   = batchSaveResults.filter(r => r.ok).length;
          const skipN = batchSaveResults.filter(r => r.skipped).length;
          const failN = batchSaveResults.filter(r => !r.ok && !r.skipped).length;
          const reasonFor = (id: string) =>
            batchPlans?.find(p => p.id === id)?.reason ?? '';
          return (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-card p-5 flex flex-wrap items-center gap-4">
                <CheckCircle2 className={cn('h-8 w-8', failN > 0 ? 'text-amber-500' : 'text-emerald-500')} />
                <div className="text-sm">
                  <p className="font-semibold">
                    {okN} importiert{skipN > 0 ? ` · ${skipN} übersprungen` : ''}{failN > 0 ? ` · ${failN} fehlgeschlagen` : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">{batchSaveResults.length} Datei{batchSaveResults.length === 1 ? '' : 'en'} verarbeitet</p>
                </div>
              </div>

              <div className="space-y-2">
                {batchSaveResults.map((r, i) => {
                  const tone = r.ok ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20'
                    : r.skipped ? 'border-border bg-muted/20'
                    : 'border-red-300 bg-red-50 dark:bg-red-950/20';
                  return (
                    <div key={`${r.fileName}-${i}`} className={cn('rounded-lg border px-4 py-3 flex items-center gap-3', tone)}>
                      {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        : r.skipped ? <Info className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{r.fileName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.ok ? 'Importiert' : r.skipped ? `Übersprungen${reasonFor(r.id) ? ` — ${reasonFor(r.id)}` : ''}` : `Fehler: ${r.error ?? 'Unbekannt'}`}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button onClick={resetWizard}
                className="px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
                Weiteren Import starten
              </button>
            </div>
          );
        })()}
      </>}

      {/* ── Importverlauf Tab ─────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{historyCount} Import{historyCount !== 1 ? 'e' : ''}</p>
            <button onClick={loadHistory} disabled={histLoading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <RefreshCw className={cn('h-3 w-3', histLoading && 'animate-spin')} />
              Aktualisieren
            </button>
          </div>

          {histLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Lade Verlauf…
            </div>
          )}

          {!histLoading && historyCount === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">Noch keine Importe vorhanden.</div>
          )}

          {/* Z-Bericht History */}
          {!histLoading && zHistory.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-1">Z-Berichte ({zHistory.length})</p>
              {zHistory.map(row => {
                const raw = row.raw_csv_json as GnParsedZBericht | null;
                const isOpen = expanded.has(row.id);
                const gross = raw?.revenue?.totalGross ?? 0;
                const net   = raw?.taxNetTotal ?? 0;
                return (
                  <HistoryRow key={row.id} id={row.id} fileName={row.file_name}
                    subLine={`${fdate(row.period_from)} – ${fdate(row.period_to)}${row.cost_center ? ` · ${row.cost_center}` : ''}${row.z_counter ? ` · Z-Nr. ${row.z_counter}` : ''}`}
                    badge={`Z-Bericht${row.import_type && row.import_type !== 'period' ? ' · ' + importTypeLabel(row.import_type) : ''}`}
                    mainValue={fc(gross)} subValue={net > 0 ? `Netto ${fc(net)}` : undefined}
                    importedAt={fdate(row.imported_at?.slice(0, 10))}
                    isOpen={isOpen} deleting={deleting === row.id}
                    onToggle={() => setExpanded(prev => { const n = new Set(prev); isOpen ? n.delete(row.id) : n.add(row.id); return n; })}
                    onDelete={() => handleDeleteZ(row.id)}
                  >
                    {raw && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 bg-muted/10 border-t border-border">
                        <MetaCell label="Brutto"       value={fc(raw.revenue?.totalGross ?? 0)} />
                        <MetaCell label="Netto"        value={fc(raw.taxNetTotal ?? 0)} />
                        <MetaCell label="Food"         value={fc(raw.foodAmount ?? 0)} />
                        <MetaCell label="Bar"          value={fc(raw.barAmount ?? 0)} />
                        <MetaCell label="Take Away"    value={fc(raw.takeAwayAmount ?? 0)} />
                        <MetaCell label="Rabatte"      value={fc(raw.discountTotal ?? 0)} />
                        <MetaCell label="Storno"       value={fc(raw.stornoTotal ?? 0)} />
                        <MetaCell label="Ø Bon"        value={fc(raw.avgBon ?? 0)} />
                      </div>
                    )}
                  </HistoryRow>
                );
              })}
            </div>
          )}

          {/* Personen History */}
          {!histLoading && personHistory.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-1">Personen-Berichte ({personHistory.length})</p>
              {personHistory.map(row => {
                const raw = row.raw_csv_json as GnParsedPersonReport | null;
                const isOpen = expanded.has(row.id);
                const guests = raw?.totalGuests ?? 0;
                const avgRev = raw?.avgRevPerPerson ?? 0;
                return (
                  <HistoryRow key={row.id} id={row.id} fileName={row.file_name}
                    subLine={`${fdate(row.period_from)} – ${fdate(row.period_to)}`}
                    badge="Personen"
                    mainValue={guests > 0 ? `${NUM0.format(guests)} Gäste` : '—'}
                    subValue={avgRev > 0 ? `Ø ${fc(avgRev)} / Gast` : undefined}
                    importedAt={fdate(row.imported_at?.slice(0, 10))}
                    isOpen={isOpen} deleting={deleting === row.id}
                    onToggle={() => setExpanded(prev => { const n = new Set(prev); isOpen ? n.delete(row.id) : n.add(row.id); return n; })}
                    onDelete={() => handleDeleteP(row.id)}
                  >
                    {raw && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 bg-muted/10 border-t border-border">
                        <MetaCell label="Gäste"        value={guests > 0 ? NUM0.format(guests) : '—'} />
                        <MetaCell label="Ø Rev/Gast"   value={avgRev > 0 ? fc(avgRev) : '—'} />
                        <MetaCell label="Total"        value={raw.totalRevenue ? fc(raw.totalRevenue) : '—'} />
                        <MetaCell label="Zeilen"       value={String(raw.rowCount ?? '—')} />
                      </div>
                    )}
                  </HistoryRow>
                );
              })}
            </div>
          )}

          {/* Durchschnittsbon History */}
          {!histLoading && avgHistory.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-1">Durchschnittsbon-Berichte ({avgHistory.length})</p>
              {avgHistory.map(group => {
                const isOpen = expanded.has(group.importId);
                return (
                  <HistoryRow key={group.importId} id={group.importId} fileName={group.fileName}
                    subLine={`${fdate(group.periodFrom)} – ${fdate(group.periodTo)}`}
                    badge="Durchschnittsbon"
                    mainValue={group.mean > 0 ? `Ø ${fc(group.mean)}` : '—'}
                    subValue={group.dayCount > 0 ? `${group.dayCount} Tag${group.dayCount === 1 ? '' : 'e'}` : undefined}
                    importedAt={fdate(group.importedAt?.slice(0, 10))}
                    isOpen={isOpen} deleting={deleting === group.importId}
                    onToggle={() => setExpanded(prev => { const n = new Set(prev); isOpen ? n.delete(group.importId) : n.add(group.importId); return n; })}
                    onDelete={() => handleDeleteAvg(group.importId)}
                  >
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 py-3 bg-muted/10 border-t border-border">
                      <MetaCell label="Mittelwert"  value={group.mean > 0 ? fc(group.mean) : '—'} />
                      <MetaCell label="Minimum"     value={group.min > 0 ? fc(group.min) : '—'} />
                      <MetaCell label="Maximum"     value={group.max > 0 ? fc(group.max) : '—'} />
                      <MetaCell label="Anzahl Tage" value={String(group.dayCount)} />
                    </div>
                  </HistoryRow>
                );
              })}
            </div>
          )}
        </div>
      )}

      <TagesabschlussImportConflictDialog
        conflicts={importConflicts}
        onCancel={handleConflictCancel}
        onConfirm={resolutions => { void handleConflictConfirm(resolutions); }}
        saving={conflictSaving}
      />
    </div>
  );
}

// ── Sub-Komponenten ───────────────────────────────────────────────────────────

function TypeBtn({ active, onClick, icon, label, desc }: {
  active: boolean; onClick: () => void;
  icon: React.ReactNode; label: string; desc: string;
}) {
  return (
    <button onClick={onClick}
      className={cn(
        'flex-1 flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
      )}>
      <span className={cn('mt-0.5', active ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
      <div>
        <p className={cn('text-sm font-semibold', active && 'text-primary')}>{label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{desc}</p>
      </div>
    </button>
  );
}

function DropZone({ isDragging, onDragOver, onDragLeave, onDrop, onClick, label, hint }: {
  isDragging: boolean;
  onDragOver: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={onClick}
      className={cn(
        'rounded-xl border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center py-14 gap-3',
        isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:bg-muted/40',
      )}>
      <Upload className={cn('h-8 w-8', isDragging ? 'text-primary' : 'text-muted-foreground')} />
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
        <p className="text-xs text-muted-foreground mt-1">oder klicken zum Auswählen</p>
      </div>
      <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">.csv</span>
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium mt-0.5 truncate">{value}</p>
    </div>
  );
}

function KpiMini({ label, value, bold, neg }: { label: string; value: string; bold?: boolean; neg?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn('text-sm mt-0.5', bold && 'font-bold', neg && 'text-red-600 dark:text-red-400')}>{value}</p>
    </div>
  );
}

function SectionTable<T>({ title, rows, cols, render }: {
  title: string; rows: T[]; cols: string[]; render: (r: T) => string[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2 bg-muted/40 border-b text-xs font-semibold">{title}</div>
      <table className="w-full text-xs">
        <thead><tr className="border-b bg-muted/20">
          {cols.map((c, i) => <th key={i} className={cn('px-3 py-1.5 font-medium', i === 0 ? 'text-left' : 'text-right')}>{c}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((row, i) => {
            const cells = render(row);
            return (
              <tr key={i} className="border-b border-border/40 last:border-0">
                {cells.map((c, j) => <td key={j} className={cn('px-3 py-1.5', j === 0 ? 'text-left' : 'text-right')}>{c}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CandidateBlock({ title, color = 'blue', candidates }: {
  title: string;
  color?: 'blue' | 'violet' | 'amber';
  candidates: Array<{ lineNumber: number; rawText: string }>;
}) {
  const colors = {
    blue:   { border: 'border-blue-200 dark:border-blue-900', bg: 'bg-blue-50 dark:bg-blue-950/30', head: 'text-blue-700 dark:text-blue-400', line: 'text-blue-400 dark:text-blue-600', text: 'text-blue-800 dark:text-blue-300' },
    violet: { border: 'border-violet-200 dark:border-violet-900', bg: 'bg-violet-50 dark:bg-violet-950/30', head: 'text-violet-700 dark:text-violet-400', line: 'text-violet-400 dark:text-violet-600', text: 'text-violet-800 dark:text-violet-300' },
    amber:  { border: 'border-amber-200 dark:border-amber-900', bg: 'bg-amber-50 dark:bg-amber-950/30', head: 'text-amber-700 dark:text-amber-400', line: 'text-amber-400 dark:text-amber-600', text: 'text-amber-800 dark:text-amber-300' },
  }[color];
  return (
    <div className={`rounded border ${colors.border} ${colors.bg} p-3 space-y-1.5`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${colors.head}`}>{title}</div>
      {candidates.map((c, i) => (
        <div key={i} className="flex gap-2 font-mono text-[10px]">
          <span className={`${colors.line} shrink-0 w-10 text-right`}>Z{c.lineNumber}:</span>
          <span className={`${colors.text} break-all`}>{c.rawText}</span>
        </div>
      ))}
    </div>
  );
}

function AvgDiagnostic({ debug, open, onToggle, onCopy }: {
  debug: GnAverageCheckDebug;
  open: boolean;
  onToggle: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className="w-full cursor-pointer flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
        <span className="flex items-center gap-2">
          <Info className="h-3.5 w-3.5" />
          Parser-Diagnose (Durchschnittsbon)
          {debug.failureReason && (
            <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">
              keine Tageswerte
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onCopy(); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 text-[10px] font-medium">
            <Copy className="h-2.5 w-2.5" />
            Diagnose kopieren
          </button>
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </div>

      {open && (
        <div className="p-4 space-y-4 text-xs">

          {/* Grund (falls Erkennung fehlgeschlagen) */}
          {debug.failureReason && (
            <div className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3 text-amber-800 dark:text-amber-300">
              <span className="font-semibold">Grund: </span>{debug.failureReason}
            </div>
          )}

          {/* Trennzeichen + Metadaten */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Trennzeichen</div>
              <div className="font-mono font-bold">{debug.delimiter}</div>
              <div className="text-muted-foreground mt-1">
                ;={debug.delimCounts.semicolon} ,={debug.delimCounts.comma} ⇥={debug.delimCounts.tab}
              </div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Zeilen</div>
              <div className="font-mono font-bold">{debug.rawLineCount}</div>
              <div className="text-muted-foreground mt-1">{debug.nonEmptyLineCount} nicht leer</div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">
                Datums-Kopfzeile
              </div>
              <div className={`font-mono font-bold ${debug.detectedFormat === 'wide' && !debug.headerRowIdx ? 'text-red-500' : ''}`}>
                {debug.headerRowIdx ? `Zeile ${debug.headerRowIdx}` : (debug.detectedFormat === 'vertical' ? '(Langformat)' : '(nicht erkannt)')}
              </div>
              <div className="text-muted-foreground mt-1">{debug.dateColumns.length} Datums-Spalten/-Zeilen</div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Durchschnitt-/Wertezeile</div>
              <div className={`font-mono font-bold ${!debug.averageRowIdx && !debug.averageRowLabel ? 'text-red-500' : ''}`}>
                {debug.averageRowIdx ? `Zeile ${debug.averageRowIdx}` : (debug.averageRowLabel ? '(Langformat)' : '(nicht erkannt)')}
              </div>
              {debug.averageRowLabel && (
                <div className="text-muted-foreground mt-1 truncate">&ldquo;{debug.averageRowLabel}&rdquo;</div>
              )}
            </div>
          </div>

          {/* Layout / Jahr / übersprungene Tage */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Layout</div>
              <div className={`font-mono font-bold ${!debug.detectedFormat ? 'text-red-500' : ''}`}>
                {debug.detectedFormat === 'wide'
                  ? 'Wide (Spalten)'
                  : debug.detectedFormat === 'vertical'
                    ? 'Langformat'
                    : '(nicht erkannt)'}
              </div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Verwendetes Jahr</div>
              <div className={`font-mono font-bold ${debug.usedYearSource === 'Benutzerwahl' ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                {debug.usedYear ?? '—'}
              </div>
              <div className="text-muted-foreground mt-1">Quelle: {debug.usedYearSource}</div>
            </div>
            <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-muted-foreground mb-0.5">Leere Tage übersprungen</div>
              <div className="font-mono font-bold">{debug.skippedEmptyColumns}</div>
            </div>
          </div>

          {/* Erkannter Zeitraum */}
          <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5 text-muted-foreground">
            Erkannter Zeitraum: <span className="font-mono font-bold text-foreground">{debug.detectedPeriod || '—'}</span>
          </div>

          {/* Zellzähler-Hinweis (Wide vs. Long) */}
          <div className="rounded border border-slate-200 dark:border-slate-700 p-2.5 text-muted-foreground">
            Datumsartige Zellen gesamt: <span className="font-mono font-bold text-foreground">{debug.dateCellCount}</span>
            {' · '}Geldwert-Zellen gesamt: <span className="font-mono font-bold text-foreground">{debug.moneyCellCount}</span>
          </div>

          {/* Erkannte Datums-Spalten */}
          {debug.dateColumns.length > 0 && (
            <div className="rounded border border-slate-200 dark:border-slate-700 p-3 space-y-1">
              <div className="font-semibold mb-2 text-slate-700 dark:text-slate-300">
                {debug.detectedFormat === 'vertical' ? 'Erkannte Datums-Zeilen' : 'Erkannte Datums-Spalten'} ({debug.dateColumns.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {debug.dateColumns.map((c, i) => (
                  <span key={i} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                    {c.raw} → {c.iso}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* "Durchschnitt"-Kandidaten */}
          {debug.averageCandidates.length > 0 && (
            <CandidateBlock
              title="Zeilen mit &ldquo;Durchschnitt&rdquo;"
              color="violet"
              candidates={debug.averageCandidates}
            />
          )}

          {/* Rohdaten anzeigen */}
          <details className="rounded border border-slate-200 dark:border-slate-700" open={!!debug.failureReason}>
            <summary className="px-3 py-2 cursor-pointer font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2">
              <span>Rohdaten anzeigen</span>
              <span className="text-[10px] font-normal text-muted-foreground">(erste {debug.firstRawLines.length} CSV-Zeilen)</span>
            </summary>
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full font-mono text-[10px] border-collapse">
                <thead>
                  <tr className="bg-slate-100 dark:bg-slate-800 sticky top-0">
                    <th className="px-2 py-1 text-right border-r border-slate-200 dark:border-slate-700 text-slate-400 w-8">#</th>
                    <th className="px-2 py-1 text-left text-slate-500">Zeile</th>
                  </tr>
                </thead>
                <tbody>
                  {debug.firstRawLines.map((line, i) => (
                    <tr key={i} className={`border-t border-slate-100 dark:border-slate-800 ${
                      debug.averageRowIdx === i + 1 ? 'bg-violet-50 dark:bg-violet-950/20 font-bold'
                        : debug.headerRowIdx === i + 1 ? 'bg-blue-50 dark:bg-blue-950/20 font-bold' : ''
                    }`}>
                      <td className="px-2 py-0.5 text-right border-r border-slate-200 dark:border-slate-700 text-slate-400">
                        {i + 1}
                      </td>
                      <td className="px-2 py-0.5 text-slate-700 dark:text-slate-300 whitespace-pre max-w-0 overflow-hidden">
                        {line || <span className="text-slate-300">(leer)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

        </div>
      )}
    </div>
  );
}

function HistoryRow({ id, fileName, subLine, badge, mainValue, subValue, importedAt, isOpen, deleting, onToggle, onDelete, children }: {
  id: string; fileName: string; subLine: string; badge: string;
  mainValue: string; subValue?: string; importedAt: string;
  isOpen: boolean; deleting: boolean;
  onToggle: () => void; onDelete: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors" onClick={onToggle}>
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{fileName}</p>
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium text-muted-foreground shrink-0">{badge}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{subLine}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold">{mainValue}</p>
          {subValue && <p className="text-xs text-muted-foreground">{subValue}</p>}
        </div>
        <div className="flex items-center gap-2 ml-2">
          <p className="text-[10px] text-muted-foreground whitespace-nowrap">{importedAt}</p>
          <button onClick={e => { e.stopPropagation(); onDelete(); }} disabled={deleting}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors">
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
          {isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      </div>
      {isOpen && children}
    </div>
  );
}
