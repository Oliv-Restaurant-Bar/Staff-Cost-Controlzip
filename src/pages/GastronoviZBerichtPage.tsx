/**
 * GastronoviZBerichtPage — Gastronovi-Import (nur PDF)
 *
 * Zwei Importbereiche:
 *   Z-Bericht (PDF)            — Standard & Erweitert: Tagesumsatz, Zahlarten,
 *                                Zeitabschnitte, Kundenkarten, Produktpositionen
 *   Gäste & Bonanalyse (PDF)   — Anzahl Personen, Umsatz pro Person,
 *                                Durchschnittsbon (bis zu 3 PDFs gleichzeitig)
 *
 * CSV-Import ist Legacy: bestehende CSV-Importe bleiben in Historie und
 * Auswertungen erhalten, neue Importe laufen ausschliesslich über PDF.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2,
  Trash2, ChevronDown, ChevronUp, RefreshCw,
  Info, AlertCircle, Database, Users, Copy,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { ImportTaskPrefillHint } from '@/components/ImportTaskPrefillHint';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';

import type { GnParsedZBericht, GnValidationStatus } from '@/lib/gn-zbericht-parser';
import {
  saveGnImport, loadGnImports, deleteGnImport,
  checkOverlappingImports, importTypeLabel,
  checkGnChecksumDuplicate,
  loadGnDayClosingsForMonth,
} from '@/lib/gn-zbericht-db';
import type { GnImportRow, OverlapInfo } from '@/lib/gn-zbericht-db';

import { extractGnPdfTextItems } from '@/lib/gn-pdf-text';
import { reconstructGnPdfLines, detectGnPdfReportKind } from '@/lib/gn-pdf-lines';
import type { GnPdfPageItems } from '@/lib/gn-pdf-lines';
import { parseGnZBerichtPdf } from '@/lib/gn-zbericht-pdf-parser';
import {
  parseGnKpiPdf, kpiPdfToAverageCheck, kpiPdfToPersonReport, GN_KPI_KIND_LABELS,
} from '@/lib/gn-kpi-pdf-parser';
import type { GnParsedKpiPdf } from '@/lib/gn-kpi-pdf-parser';

import {
  savePersonImport, loadPersonImports, deletePersonImport,
  checkPersonDuplicate,
} from '@/lib/gn-personen-db';
import type { GnPersonImportRow } from '@/lib/gn-personen-db';
import type { GnParsedPersonReport } from '@/lib/gn-personen-parser';

import {
  saveAverageCheckImport, loadAverageCheckImports, deleteAverageCheckImport,
  getOverlappingAverageCheckDates,
} from '@/lib/gn-average-check-db';
import type { GnAverageCheckImportGroup } from '@/lib/gn-average-check-db';

import { runGnDiagnostic } from '@/lib/gn-diagnostic';
import type { GnDiagnosticResult } from '@/lib/gn-diagnostic';

import {
  mergeGnTagesQuellen, summarizeGnPeriode, BONS_BERECHNET_TOOLTIP,
} from '@/lib/gn-tagesanalyse';
import { analyzeGnZeitabschnitte, GN_ZEITFENSTER } from '@/lib/gn-zeitabschnitte';
import { InfoTip } from '@/components/ui/info-tip';

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
/** Vorzeichenbehaftete Beträge (Zeitabschnitte/Validierung): 0 und negativ bleiben sichtbar. */
function fcs(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : `CHF ${NUM.format(v)}`;
}
/** Anzeige-Label der Verzehrart aus dem erweiterten Z-Bericht. */
function consumptionLabel(ct: 'in_house' | 'takeaway' | null) {
  return ct === 'in_house' ? 'Inner Haus' : ct === 'takeaway' ? 'Außer Haus' : '—';
}
function fdate(iso: string | null | undefined) {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

// ── Typen ─────────────────────────────────────────────────────────────────────

type ImportType  = 'zbericht' | 'kpi';
type WizardStep  = 'upload' | 'preview' | 'saving' | 'done';
type Tab         = 'import' | 'history';

/** Eine hochgeladene Gäste-/Bonanalyse-PDF inkl. Duplikat-Infos. */
interface KpiFileEntry {
  id: string;
  fileName: string;
  /** Text-Items für erneutes Parsen bei manueller Jahreswahl. */
  pages: GnPdfPageItems[] | null;
  parsed: GnParsedKpiPdf | null;
  /** Erkennungs-/Konfliktfehler — Eintrag ist dann nicht importierbar. */
  error: string | null;
  /** Identischer Inhalt bereits importiert ⇒ beim Bestätigen No-op. */
  dupNoop: boolean;
  /** Gleicher Zeitraum + Berichtstyp bereits importiert ⇒ wird ersetzt. */
  replaceId: string | null;
  /** Bereits importierte Tage (nur Durchschnittsbon). */
  avgOverlapDates: string[];
  /** Manuell gewähltes Importjahr (Pflicht, wenn das PDF kein Jahr enthält). */
  chosenYear: number | null;
}

interface KpiSaveResult {
  fileName: string;
  kindLabel: string;
  status: 'ok' | 'noop' | 'error';
  message?: string;
}

const GN_SCAN_ERROR =
  'Dieses PDF enthält keinen auslesbaren Text. Bitte exportiere den Bericht '
  + 'direkt aus Gastronovi und lade nicht einen Scan oder ein Foto hoch.';

const VALIDATION_LABELS: Record<GnValidationStatus, string> = {
  plausibel:         'Plausibel',
  rundungsdifferenz: 'Rundungsdifferenz',
  unvollstaendig:    'Unvollständig',
  abweichung:        'Abweichung',
};
const VALIDATION_TONES: Record<GnValidationStatus, string> = {
  plausibel:         'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  rundungsdifferenz: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  unvollstaendig:    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  abweichung:        'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

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

  // Z-Bericht State (PDF)
  const [parsed,           setParsed]           = useState<GnParsedZBericht | null>(null);
  const [overlapInfo,      setOverlapInfo]       = useState<OverlapInfo[]>([]);
  const [manualPeriodFrom, setManualPeriodFrom]  = useState('');
  const [manualPeriodTo,   setManualPeriodTo]    = useState('');
  const [zDupInfo,         setZDupInfo]          = useState<{ fileName: string | null; importedAt: string | null } | null>(null);
  const [zHistory,         setZHistory]          = useState<GnImportRow[]>([]);

  // Gäste & Bonanalyse State (bis zu 3 KPI-PDFs gleichzeitig)
  const [kpiFiles,       setKpiFiles]       = useState<KpiFileEntry[]>([]);
  const [kpiSaveResults, setKpiSaveResults] = useState<KpiSaveResult[] | null>(null);
  const [kpiProcessing,  setKpiProcessing]  = useState(false);

  // History
  const [personHistory, setPersonHistory] = useState<GnPersonImportRow[]>([]);
  const [avgHistory,    setAvgHistory]    = useState<GnAverageCheckImportGroup[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [deleting,    setDeleting]    = useState<string | null>(null);
  const [showDebug,    setShowDebug]    = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
      // Historie zeigt Details aus raw_csv_json (+ report_type-Badge) → volle Zeilen.
      loadGnImports(tenantId, { includeRaw: true }),
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
    setZDupInfo(null);
    setKpiFiles([]); setKpiSaveResults(null); setKpiProcessing(false);
    setParseError(null); setStep('upload');
  }, []);

  const handleTypeChange = (t: ImportType) => {
    setImportType(t);
    resetWizard();
  };

  // ── PDF verarbeiten ──────────────────────────────────────────────────────

  /** Z-Bericht-PDF (Standard oder Erweitert) einlesen und prüfen. */
  const processZPdf = useCallback(async (file: File) => {
    setParseError(null); setParsed(null); setZDupInfo(null);
    setOverlapInfo([]); setManualPeriodFrom(''); setManualPeriodTo('');
    try {
      const extract = await extractGnPdfTextItems(file);
      if (!extract.hasTextLayer) {
        setParseError(GN_SCAN_ERROR);
        return;
      }
      const detection = detectGnPdfReportKind(reconstructGnPdfLines(extract.pages));
      if (detection.kind !== 'zbericht' && detection.kind !== 'unbekannt') {
        setParseError(
          `Diese Datei ist ein «${GN_KPI_KIND_LABELS[detection.kind]}»-Bericht. `
          + 'Bitte importiere sie im Bereich «Gäste & Bonanalyse (PDF)».',
        );
        return;
      }
      const result = parseGnZBerichtPdf(extract.pages, file.name);
      if (result.revenue.totalGross === 0 && result.taxes.length === 0) {
        const missing = result.debug.missingSections.length > 0
          ? ` Fehlende Sektionen: ${result.debug.missingSections.join(', ')}.` : '';
        const title = detection.titleLine ? ` Erkannte Titelzeile: «${detection.titleLine}».` : '';
        setParseError(
          'Das PDF konnte nicht als Gastronovi Z-Bericht gelesen werden — '
          + `es wurden weder Umsatz- noch Steuerdaten gefunden.${missing}${title}`,
        );
        return;
      }
      // Idempotenz: identischer Bericht (Checksumme) bereits importiert?
      const dup = await checkGnChecksumDuplicate(tenantId, result.checksum);
      if (dup.isDuplicate) {
        setZDupInfo({ fileName: dup.existingFileName, importedAt: dup.existingImportedAt });
      }
      if (result.periodFrom && result.periodTo) {
        setOverlapInfo(await checkOverlappingImports(tenantId, result.periodFrom, result.periodTo));
      }
      setParsed(result);
      setStep('preview');
    } catch (e) {
      setParseError('Fehler beim Lesen des PDFs: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId]);

  /** Duplikat-/Überschneidungs-Infos für eine KPI-PDF ermitteln (read-only). */
  const enrichKpiEntry = useCallback(async (
    parsedKpi: GnParsedKpiPdf,
  ): Promise<Pick<KpiFileEntry, 'dupNoop' | 'replaceId' | 'avgOverlapDates'>> => {
    const none = { dupNoop: false, replaceId: null as string | null, avgOverlapDates: [] as string[] };
    if (!parsedKpi.kind || parsedKpi.yearMissing) return none;
    if (parsedKpi.kind === 'durchschnittsbon') {
      // Speichern läuft über gn_average_checks: Tage werden ersetzt, identischer
      // Inhalt wird dort per Checksumme übersprungen — hier nur Overlap anzeigen.
      if (!parsedKpi.periodFrom || !parsedKpi.periodTo) return none;
      const existing = await getOverlappingAverageCheckDates(tenantId, parsedKpi.periodFrom, parsedKpi.periodTo);
      const dates = new Set(parsedKpi.days.filter(d => d.date && d.value !== null).map(d => d.date));
      return { ...none, avgOverlapDates: existing.filter(d => dates.has(d)) };
    }
    // Personen-Berichte: identischer Inhalt (Checksumme) ⇒ No-op;
    // gleicher Zeitraum + gleicher Berichtstyp ⇒ bestehenden Import ersetzen.
    const byChecksum = await checkPersonDuplicate(tenantId, parsedKpi.checksum, '', '');
    if (byChecksum.isDuplicate) return { ...none, dupNoop: true };
    if (parsedKpi.periodFrom && parsedKpi.periodTo) {
      const byPeriod = await checkPersonDuplicate(
        tenantId, '', parsedKpi.periodFrom, parsedKpi.periodTo, parsedKpi.kind,
      );
      if (byPeriod.isDuplicate && byPeriod.existingId) {
        return { ...none, replaceId: byPeriod.existingId };
      }
    }
    return none;
  }, [tenantId]);

  /** Bis zu 3 Gäste-/Bonanalyse-PDFs einlesen; Typ wird pro Datei erkannt. */
  const processKpiFiles = useCallback(async (files: File[]) => {
    setParseError(null);
    setKpiSaveResults(null);
    const room = 3 - kpiFiles.length;
    if (room <= 0) {
      setParseError('Es sind bereits 3 PDFs in der Auswahl — bitte zuerst eine Datei entfernen.');
      return;
    }
    if (files.length > room) {
      setParseError(
        `Maximal 3 PDFs pro Import — es ${room === 1 ? 'wird nur die erste Datei' : `werden nur die ersten ${room} Dateien`} übernommen.`,
      );
    }
    setKpiProcessing(true);
    const additions: KpiFileEntry[] = [];
    const kindsInUse = new Set(
      kpiFiles.filter(e => !e.error && e.parsed?.kind).map(e => e.parsed!.kind),
    );
    for (const file of files.slice(0, room)) {
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const errEntry = (error: string, pages: GnPdfPageItems[] | null = null, parsedKpi: GnParsedKpiPdf | null = null): KpiFileEntry =>
        ({ id, fileName: file.name, pages, parsed: parsedKpi, error, dupNoop: false, replaceId: null, avgOverlapDates: [], chosenYear: null });
      try {
        const extract = await extractGnPdfTextItems(file);
        if (!extract.hasTextLayer) {
          additions.push(errEntry(GN_SCAN_ERROR));
          continue;
        }
        const parsedKpi = parseGnKpiPdf(extract.pages, file.name);
        if (parsedKpi.debug.detectedKindRaw === 'zbericht') {
          additions.push(errEntry(
            'Diese Datei ist ein Z-Bericht. Bitte importiere sie im Bereich «Z-Bericht (PDF)».',
            extract.pages, parsedKpi,
          ));
          continue;
        }
        if (!parsedKpi.kind) {
          additions.push(errEntry(
            parsedKpi.debug.failureReason
              ?? 'Das PDF konnte keinem Berichtstyp (Anzahl Personen, Umsatz pro Person, Durchschnittsbon) zugeordnet werden.',
            extract.pages, parsedKpi,
          ));
          continue;
        }
        if (kindsInUse.has(parsedKpi.kind)) {
          additions.push(errEntry(
            `Berichtstyp «${parsedKpi.kindLabel}» ist bereits in der Auswahl — pro Import nur ein PDF je Berichtsart.`,
            extract.pages, parsedKpi,
          ));
          continue;
        }
        kindsInUse.add(parsedKpi.kind);
        const info = await enrichKpiEntry(parsedKpi);
        additions.push({
          id, fileName: file.name, pages: extract.pages, parsed: parsedKpi,
          error: null, chosenYear: null, ...info,
        });
      } catch (e) {
        additions.push(errEntry('Fehler beim Lesen des PDFs: ' + (e instanceof Error ? e.message : String(e))));
      }
    }
    setKpiProcessing(false);
    const next = [...kpiFiles, ...additions];
    setKpiFiles(next);
    if (next.length > 0) setStep('preview');
  }, [kpiFiles, tenantId, enrichKpiEntry]);

  /** Pflicht-Jahreswahl: PDF ohne erkennbares Jahr mit Benutzerjahr neu parsen. */
  const handleKpiYearChange = async (entryId: string, year: number) => {
    const entry = kpiFiles.find(e => e.id === entryId);
    if (!entry || entry.error || !entry.pages) return;
    const reparsed = parseGnKpiPdf(entry.pages, entry.fileName, year);
    const info = await enrichKpiEntry(reparsed);
    setKpiFiles(prev => prev.map(e =>
      e.id === entryId ? { ...e, chosenYear: year, parsed: reparsed, ...info } : e,
    ));
  };

  const removeKpiFile = (entryId: string) => {
    setKpiFiles(prev => {
      const next = prev.filter(e => e.id !== entryId);
      if (next.length === 0) setStep('upload');
      return next;
    });
  };

  const handleFilesSelected = (files: File[]) => {
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) {
      setParseError(
        'Bitte eine PDF-Datei auswählen. Der Import unterstützt nur direkt aus '
        + 'Gastronovi exportierte PDF-Berichte (CSV-Import ist nicht mehr verfügbar).',
      );
      return;
    }
    if (importType === 'zbericht') void processZPdf(pdfs[0]);
    else void processKpiFiles(pdfs);
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
    if (parsed.periodFrom && parsed.periodTo) return; // bereits in processZPdf gecheckt
    if (!manualPeriodFrom || !manualPeriodTo) return;
    checkOverlappingImports(tenantId, manualPeriodFrom, manualPeriodTo).then(setOverlapInfo);
  }, [manualPeriodFrom, manualPeriodTo, tenantId, parsed, importType]);

  const handleConfirm = async () => {
    if (importType === 'kpi') { await handleKpiConfirm(); return; }
    if (!parsed) return;
    // Idempotenz: identischer Bericht bereits importiert ⇒ KEINE Schreiboperation.
    if (zDupInfo) {
      toast.info('Dieser Bericht wurde bereits importiert — es wurde nichts erneut gespeichert.');
      return;
    }
    setStep('saving');
    let importedDays: string[] = [];
    const pFrom  = parsed.periodFrom || manualPeriodFrom || undefined;
    const pTo    = parsed.periodTo   || manualPeriodTo   || undefined;
    const ids    = overlapInfo.map(o => o.id);
    const { error } = await saveGnImport(tenantId, parsed, undefined, ids, pFrom, pTo);
    if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
    // Nur echte TAGES-Importe für den Tagesabschluss-Abgleich vormerken.
    if (pFrom && pTo && pFrom === pTo) importedDays = [pFrom];
    if (parsed.reportType === 'extended') {
      toast.success('Umsatz-, Zahlungs- und Produktdaten wurden übernommen.');
    } else {
      toast.success('Import erfolgreich gespeichert');
    }
    setStep('done');
    setTab('history');
    loadHistory();
    if (importedDays.length > 0) void checkTagesabschlussConflicts(importedDays);
  };

  /** Gäste & Bonanalyse: alle gültigen PDFs der Auswahl nacheinander speichern. */
  const handleKpiConfirm = async () => {
    const entries = kpiFiles.filter(e => !e.error && e.parsed?.kind);
    if (entries.length === 0) {
      toast.error('Keine importierbaren PDFs in der Auswahl.');
      return;
    }
    if (entries.some(e => e.parsed!.yearMissing)) {
      toast.error('Bitte zuerst für alle Berichte ohne erkennbares Jahr das Importjahr wählen.');
      return;
    }
    setStep('saving');
    const results: KpiSaveResult[] = [];
    for (const e of entries) {
      const p = e.parsed!;
      const base = { fileName: e.fileName, kindLabel: p.kindLabel };
      if (e.dupNoop) {
        results.push({ ...base, status: 'noop', message: 'Identischer Inhalt bereits importiert — keine Schreiboperation.' });
        continue;
      }
      try {
        if (p.kind === 'durchschnittsbon') {
          const r = await saveAverageCheckImport(tenantId, kpiPdfToAverageCheck(p));
          if (r.error) results.push({ ...base, status: 'error', message: r.error });
          else if (r.noop) results.push({ ...base, status: 'noop', message: 'Identischer Inhalt bereits importiert — keine Schreiboperation.' });
          else results.push({ ...base, status: 'ok' });
        } else {
          const r = await savePersonImport(tenantId, kpiPdfToPersonReport(p), e.replaceId ?? undefined, p.kind);
          if (r.error) results.push({ ...base, status: 'error', message: r.error });
          else results.push({
            ...base, status: 'ok',
            message: e.replaceId ? 'Bestehender Import für denselben Zeitraum wurde ersetzt.' : undefined,
          });
        }
      } catch (err) {
        results.push({ ...base, status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
    setKpiSaveResults(results);
    const okN   = results.filter(r => r.status === 'ok').length;
    const noopN = results.filter(r => r.status === 'noop').length;
    const failN = results.filter(r => r.status === 'error').length;
    if (failN > 0)     toast.error(`${okN} importiert, ${failN} fehlgeschlagen`);
    else if (okN > 0)  toast.success(`${okN} Bericht${okN === 1 ? '' : 'e'} importiert${noopN > 0 ? `, ${noopN} unverändert übersprungen` : ''}`);
    else               toast.info(`Keine Änderungen — ${noopN} Bericht${noopN === 1 ? '' : 'e'} bereits vorhanden.`);
    setStep('done');
    loadHistory();
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

  const activeWarnings     = importType === 'zbericht' ? (parsed?.warnings ?? []) : [];
  const activeWarnCount    = activeWarnings.length;
  const hasOverlap         = importType === 'zbericht' && overlapInfo.length > 0;
  const showReplaceCta     = hasOverlap;

  // Gäste & Bonanalyse: Zustand der Auswahl
  const kpiValidEntries    = kpiFiles.filter(e => !e.error && e.parsed?.kind);
  const kpiValidCount      = kpiValidEntries.length;
  const kpiYearPending     = kpiValidEntries.some(e => e.parsed!.yearMissing);

  // Kompakte Tagesanalyse-Vorschau über die geladenen KPI-PDFs (reine Logik,
  // nur Werte aus den aktuell geladenen Berichten — kein DB-Zugriff).
  const kpiTagesVorschau = useMemo(() => {
    const entries = kpiFiles.filter(e => !e.error && e.parsed?.kind && !e.parsed.yearMissing);
    const kinds = new Set(entries.map(e => e.parsed!.kind));
    if (kinds.size < 2) return null;
    const personsByDate      = new Map<string, number>();
    const revPerPersonByDate = new Map<string, number>();
    const avgReceiptByDate   = new Map<string, number>();
    for (const e of entries) {
      const p = e.parsed!;
      for (const d of p.days) {
        if (d.value === null || !d.date) continue;
        if (p.kind === 'anzahl_personen')       personsByDate.set(d.date, d.value);
        else if (p.kind === 'umsatz_pro_person') revPerPersonByDate.set(d.date, d.value);
        else if (p.kind === 'durchschnittsbon')  avgReceiptByDate.set(d.date, d.value);
      }
    }
    const analysen = mergeGnTagesQuellen({
      personsByDate,
      revenuePerPersonByDate: revPerPersonByDate,
      averageReceiptByDate:   avgReceiptByDate,
    });
    const periode = summarizeGnPeriode(analysen);
    return periode.dayCount > 0 ? periode : null;
  }, [kpiFiles]);

  // Zeitabschnittsanalyse-Vorschau für den geladenen Z-Bericht (reine Logik).
  const zeitVorschau = useMemo(
    () => analyzeGnZeitabschnitte(parsed?.hourlyRevenue ?? null),
    [parsed],
  );

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
          <p className="text-xs text-muted-foreground mt-0.5">PDF-Berichte direkt aus Gastronovi importieren</p>
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
            icon={<FileText className="h-4 w-4" />} label="Z-Bericht (PDF)"
            desc="Standard & Erweitert: Tagesumsatz, Zahlarten, Zeitabschnitte, Produktpositionen" />
          <TypeBtn active={importType === 'kpi'} onClick={() => handleTypeChange('kpi')}
            icon={<Users className="h-4 w-4" />} label="Gäste & Bonanalyse (PDF)"
            desc="Anzahl Personen, Umsatz pro Person, Durchschnittsbon — bis zu 3 PDFs gleichzeitig" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Neue Importe laufen ausschliesslich über PDF-Berichte aus Gastronovi.
          Bestehende CSV-Importe bleiben in Historie und Auswertungen erhalten.
        </p>

        {/* Wizard-Schritte */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {(['upload', 'preview', 'done'] as WizardStep[]).map((s, i) => {
            const labels: Record<WizardStep, string> = { upload: 'Hochladen', preview: 'Vorschau', saving: 'Speichern', done: 'Fertig' };
            const done   = step === 'done' || (step !== 'upload' && s === 'upload');
            const active = step === s;
            return <>
              {i > 0 && <span key={'sep' + i} className="text-border">›</span>}
              <span key={s} className={cn('font-medium', active && 'text-primary', done && 'text-emerald-600 dark:text-emerald-400')}>
                {labels[s]}
              </span>
            </>;
          })}
        </div>

        {/* Datei-Input: auch im Preview-Schritt verfügbar («Weitere PDF hinzufügen») */}
        <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" className="hidden"
          multiple={importType === 'kpi'}
          onChange={e => {
            if (e.target.files && e.target.files.length) handleFilesSelected(Array.from(e.target.files));
            e.target.value = '';
          }} />

        {/* ── Step: Upload ──────────────────────────────────────────────────── */}
        {step === 'upload' && <>
          <DropZone
            isDragging={isDragging}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            label={importType === 'zbericht'
              ? 'Gastronovi Z-Bericht (PDF) hier ablegen'
              : 'Gäste- & Bonanalyse-PDFs hier ablegen'}
            hint={importType === 'zbericht'
              ? 'Standard- oder erweiterter Z-Bericht — direkt aus Gastronovi als PDF exportiert'
              : 'Anzahl Personen, Umsatz pro Person, Durchschnittsbon — bis zu 3 PDFs gleichzeitig'}
          />

          {kpiProcessing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              PDFs werden gelesen…
            </div>
          )}

          {parseError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-400" data-testid="text-parse-error">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {parseError}
            </div>
          )}
        </>}

        {/* ── Step: Preview ─────────────────────────────────────────────────── */}
        {(step === 'preview' || step === 'saving') && <>

          {/* Fehler beim Nachladen weiterer PDFs (Gäste & Bonanalyse) */}
          {parseError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-400" data-testid="text-parse-error-preview">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {parseError}
            </div>
          )}

          {/* Duplikat: identischer Z-Bericht bereits importiert ⇒ Import blockiert */}
          {importType === 'zbericht' && zDupInfo && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2" data-testid="banner-duplikat">
              <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Dieser Bericht wurde bereits importiert
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Identischer Inhalt{zDupInfo.fileName ? ` («${zDupInfo.fileName}»)` : ''} — importiert am {fdate(zDupInfo.importedAt)}.
                Es wird nichts erneut gespeichert.
              </p>
              <div className="flex gap-2 mt-2">
                <button onClick={resetWizard}
                  className="px-3 py-1.5 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-100">
                  Abbrechen
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

          {/* ── Z-Bericht Vorschau ─────────────────────────────────────────── */}
          {importType === 'zbericht' && parsed && <>
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <MetaCell label="Zeitraum"     value={`${fdate(effectivePeriodFrom || parsed.periodFrom)} – ${fdate(effectivePeriodTo || parsed.periodTo)}`} />
                <MetaCell label="Z-Zähler"     value={parsed.zCounter || '—'} />
                <MetaCell label="Kostenstelle" value={parsed.costCenter || '—'} />
              </div>
              <div className="flex items-center gap-2 flex-wrap" data-testid="badge-berichtstyp">
                {parsed.reportType === 'extended' ? (
                  <>
                    <span className="text-[11px] font-semibold rounded-full px-2.5 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
                      Erweiterter Z-Bericht
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Erweiterter Z-Bericht: Produktanalyse wird aktualisiert.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-[11px] font-semibold rounded-full px-2.5 py-0.5 bg-muted text-muted-foreground">
                      Standard-Z-Bericht
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Standard-Z-Bericht: keine Produktdetailpositionen enthalten.
                    </span>
                  </>
                )}
              </div>
              {parsed.businessDay && (parsed.periodFromTime || parsed.periodToTime) && (
                <p className="text-xs text-muted-foreground flex items-start gap-1.5" data-testid="text-geschaeftstag">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Bericht über Mitternacht ({parsed.periodFromTime ?? '—'}–{parsed.periodToTime ?? '—'} Uhr) —
                  wird als Geschäftstag {fdate(parsed.businessDay)} gespeichert.
                </p>
              )}
            </div>

            {/* Plausibilitätsprüfung (nur PDF) */}
            {parsed.validation && parsed.validation.checks.length > 0 && (
              <div className="rounded-lg border border-border overflow-hidden" data-testid="card-plausibilitaet">
                <div className="px-4 py-2 bg-muted/40 border-b text-xs font-semibold flex items-center gap-2">
                  Plausibilitätsprüfung
                  <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold', VALIDATION_TONES[parsed.validation.status])}>
                    {VALIDATION_LABELS[parsed.validation.status]}
                  </span>
                </div>
                <table className="w-full text-xs">
                  <thead><tr className="border-b bg-muted/20 text-right">
                    <th className="px-3 py-1.5 text-left font-medium">Prüfung</th>
                    <th className="px-3 py-1.5 font-medium">Erwartet</th>
                    <th className="px-3 py-1.5 font-medium">Ist</th>
                    <th className="px-3 py-1.5 font-medium">Differenz</th>
                    <th className="px-3 py-1.5 text-left font-medium">Status</th>
                  </tr></thead>
                  <tbody>
                    {parsed.validation.checks.map(c => (
                      <tr key={c.id} className="border-b border-border/40 last:border-0">
                        <td className="px-3 py-1.5">
                          {c.label}
                          {c.note && <span className="block text-muted-foreground">{c.note}</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fcs(c.expected)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fcs(c.actual)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fcs(c.diff)}</td>
                        <td className="px-3 py-1.5">
                          <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold', VALIDATION_TONES[c.status])}>
                            {VALIDATION_LABELS[c.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

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
            {parsed.paymentMethodProviders && parsed.paymentMethodProviders.length > 0 && (
              <SectionTable
                title={`Zahlungsanbieter — informativ, nicht doppelt gezählt (${parsed.paymentMethodProviders.length})`}
                rows={parsed.paymentMethodProviders}
                cols={['Zahlart', 'Anbieter', 'Anzahl', 'Betrag']}
                render={r => [r.parent, r.name, NUM0.format(r.count), fcs(r.amount)]} />
            )}
            {parsed.hourlyRevenue && parsed.hourlyRevenue.length > 0 && (
              <SectionTable
                title={`Zeitabschnitte (${parsed.hourlyRevenue.length})${parsed.hourlyRevenueTotal !== null && parsed.hourlyRevenueTotal !== undefined ? ` — Gesamt ${fcs(parsed.hourlyRevenueTotal)}` : ''}`}
                rows={parsed.hourlyRevenue}
                cols={['Zeitabschnitt', 'Betrag', 'Anteil']}
                render={r => [r.label, fcs(r.totalAmount), r.sharePct !== null ? `${NUM.format(r.sharePct)} %` : '—']} />
            )}
            {zeitVorschau && (
              <div className="rounded-lg border border-border bg-card p-4" data-testid="zeitabschnitts-vorschau">
                <div className="text-sm font-semibold mb-2">Zeitabschnittsanalyse (Vorschau)</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm">
                  <MetaCell label={GN_ZEITFENSTER.mittag.label}
                    value={zeitVorschau.mittagRevenue !== null ? fcs(zeitVorschau.mittagRevenue) : '—'} />
                  <MetaCell label={GN_ZEITFENSTER.abend.label}
                    value={zeitVorschau.abendRevenue !== null ? fcs(zeitVorschau.abendRevenue) : '—'} />
                  <MetaCell label="Umsatz vor 17:00"
                    value={zeitVorschau.vor17Revenue !== null ? fcs(zeitVorschau.vor17Revenue) : '—'} />
                  <MetaCell label="Umsatz ab 17:00"
                    value={zeitVorschau.ab17Revenue !== null ? fcs(zeitVorschau.ab17Revenue) : '—'} />
                  <MetaCell label="Stärkste Stunde"
                    value={zeitVorschau.strongestHour
                      ? `${zeitVorschau.strongestHour.label} · ${fcs(zeitVorschau.strongestHour.totalAmount)}` : '—'} />
                  <MetaCell label="Schwächste aktive Stunde"
                    value={zeitVorschau.weakestActiveHour
                      ? `${zeitVorschau.weakestActiveHour.label} · ${fcs(zeitVorschau.weakestActiveHour.totalAmount)}` : '—'} />
                  <MetaCell label={`Peak-Zeitfenster (${GN_ZEITFENSTER.peakFensterStunden} Std.)`}
                    value={zeitVorschau.peakWindow
                      ? `${zeitVorschau.peakWindow.label} · ${fcs(zeitVorschau.peakWindow.totalAmount)}` : '—'} />
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Zeitfenster zentral definiert; negative Stundenwerte bleiben erhalten.
                </p>
              </div>
            )}
            {parsed.customerCardTopups && parsed.customerCardTopups.length > 0 && (
              <SectionTable
                title={`Aufladungen Kundenkarten (${parsed.customerCardTopups.length})${parsed.customerCardTopupTotal !== null && parsed.customerCardTopupTotal !== undefined ? ` — Total ${fcs(parsed.customerCardTopupTotal)}` : ''}`}
                rows={parsed.customerCardTopups}
                cols={['Karte', 'Anzahl', 'Betrag']}
                render={r => [r.name, NUM0.format(r.count), fcs(r.amount)]} />
            )}
            <SectionTable title={`Hauptwarengruppen (${pgCount})`} rows={parsed.productGroups} cols={['Name', 'Anzahl', 'Betrag']}
              render={r => [r.name, NUM0.format(r.count), fc(r.amount)]} />

            {/* Detailbericht des erweiterten Z-Berichts */}
            {parsed.extendedData && (
              <>
                <SectionTable
                  title={`Detailbericht — Hauptwarengruppen inner/außer Haus (${parsed.extendedData.mainCategoriesByConsumptionType.length})`}
                  rows={parsed.extendedData.mainCategoriesByConsumptionType}
                  cols={['Name', 'Verzehr', 'Anzahl', 'Betrag']}
                  render={r => [r.name, consumptionLabel(r.consumptionType), NUM0.format(r.quantity), fc(r.grossAmount)]} />
                <SectionTable
                  title={`Detailbericht — Warengruppen (${parsed.extendedData.categories.length})`}
                  rows={parsed.extendedData.categories}
                  cols={['Name', 'Anzahl', 'Betrag']}
                  render={r => [r.name, NUM0.format(r.quantity), fc(r.grossAmount)]} />
                <SectionTable
                  title={`Detailbericht — Warengruppen inner/außer Haus (${parsed.extendedData.categoriesByConsumptionType.length})`}
                  rows={parsed.extendedData.categoriesByConsumptionType}
                  cols={['Name', 'Verzehr', 'Anzahl', 'Betrag']}
                  render={r => [r.name, consumptionLabel(r.consumptionType), NUM0.format(r.quantity), fc(r.grossAmount)]} />
                <SectionTable
                  title={`Detailbericht — Positionen (${parsed.extendedData.positions.length})`}
                  rows={parsed.extendedData.positions}
                  cols={['Name', 'Verzehr', 'Anzahl', 'Betrag']}
                  render={r => [r.name, consumptionLabel(r.consumptionType), NUM0.format(r.quantity), fc(r.grossAmount)]} />
              </>
            )}
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
                        <span className="text-[10px] font-normal text-muted-foreground">(erste 30 Zeilen)</span>
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

          {/* ── Gäste & Bonanalyse Vorschau (bis zu 3 PDFs) ────────────────── */}
          {importType === 'kpi' && kpiFiles.length > 0 && <>
            {kpiFiles.map(entry => {
              const p = entry.parsed;
              const fmtVal = (v: number | null) =>
                v === null ? '—'
                : p?.kind === 'anzahl_personen' ? NUM0.format(v)
                : `CHF ${NUM.format(v)}`;
              return (
                <div key={entry.id}
                  className={cn('rounded-lg border',
                    entry.error ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : 'border-border bg-card')}
                  data-testid={`card-kpi-${entry.fileName}`}>
                  <div className="flex items-center gap-3 px-4 py-3 border-b border-border/60">
                    <FileText className={cn('h-4 w-4 shrink-0', entry.error ? 'text-red-500' : 'text-muted-foreground')} />
                    <p className="text-sm font-medium truncate flex-1 min-w-0">{entry.fileName}</p>
                    <span className={cn('text-[11px] font-semibold rounded-full px-2.5 py-0.5 shrink-0',
                      entry.error
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                        : 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300')}>
                      {p?.kindLabel ?? 'Unbekannter Bericht'}
                    </span>
                    <button onClick={() => removeKpiFile(entry.id)} disabled={step === 'saving'}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-600 disabled:opacity-50"
                      title="PDF entfernen" data-testid={`button-remove-${entry.fileName}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {entry.error ? (
                    <p className="px-4 py-3 text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap">{entry.error}</p>
                  ) : p && (
                    <div className="px-4 py-3 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <MetaCell label="Zeitraum"
                          value={p.periodFrom ? `${fdate(p.periodFrom)} – ${fdate(p.periodTo)}` : (p.periodRaw || '—')} />
                        <MetaCell label="Tageswerte" value={String(p.filledDayCount)} />
                        <MetaCell label="Leere Felder" value={String(p.emptyDayCount)} />
                        <MetaCell label={p.summaryLabel ?? 'Gesamt'} value={fmtVal(p.summaryValue)} />
                      </div>

                      <p className="text-xs text-muted-foreground">{p.diagnosis}</p>

                      {p.warnings.length > 0 && (
                        <div className="space-y-1">
                          {p.warnings.map((w, wi) => (
                            <p key={wi} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                              <Info className="h-3 w-3 mt-0.5 shrink-0" />{w}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Pflicht-Jahreswahl: Bericht ohne erkennbares Jahr */}
                      {(p.yearMissing || entry.chosenYear !== null) && (
                        <div className={cn('rounded-lg border p-3 space-y-2',
                          p.yearMissing
                            ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20'
                            : 'border-border bg-muted/20')}>
                          {p.yearMissing ? (
                            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              Kein Jahr im Bericht erkennbar — bitte Importjahr wählen (Pflicht).
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Importjahr manuell gewählt (Quelle: {p.debug.usedYearSource}).
                            </p>
                          )}
                          <select
                            value={entry.chosenYear ?? ''}
                            onChange={e => { const y = Number(e.target.value); if (y) void handleKpiYearChange(entry.id, y); }}
                            disabled={step === 'saving'}
                            className="px-2 py-1 text-sm rounded border border-border bg-background disabled:opacity-50"
                            data-testid={`select-jahr-${entry.fileName}`}>
                            <option value="" disabled>Jahr wählen…</option>
                            {Array.from({ length: 8 }, (_, i) => new Date().getFullYear() + 1 - i).map(y => (
                              <option key={y} value={y}>{y}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Idempotenz / Ersetzen-Hinweise */}
                      {entry.dupNoop && (
                        <p className="text-xs text-muted-foreground flex items-start gap-1.5 rounded border border-border bg-muted/20 px-3 py-2">
                          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          Identischer Inhalt bereits importiert — wird beim Bestätigen übersprungen (keine Schreiboperation).
                        </p>
                      )}
                      {!entry.dupNoop && entry.replaceId && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5 rounded border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          Für denselben Zeitraum existiert bereits ein Import — er wird beim Bestätigen ersetzt.
                        </p>
                      )}
                      {!entry.dupNoop && entry.avgOverlapDates.length > 0 && (
                        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5 rounded border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          {entry.avgOverlapDates.length === 1
                            ? '1 bereits importierter Tag wird beim Bestätigen ersetzt.'
                            : `${entry.avgOverlapDates.length} bereits importierte Tage werden beim Bestätigen ersetzt.`}
                        </p>
                      )}

                      {p.days.length > 0 && (
                        <details className="rounded border border-border">
                          <summary className="px-3 py-2 cursor-pointer text-xs font-semibold text-muted-foreground hover:bg-muted/40">
                            Tageswerte anzeigen ({p.filledDayCount})
                          </summary>
                          <div className="max-h-72 overflow-y-auto">
                            <table className="w-full text-xs">
                              <thead><tr className="border-b bg-muted/20 text-right sticky top-0 bg-card">
                                <th className="px-3 py-1.5 text-left font-medium">Datum</th>
                                <th className="px-3 py-1.5 font-medium">Wert</th>
                              </tr></thead>
                              <tbody>
                                {p.days.map((d, di) => (
                                  <tr key={di} className="border-b border-border/40 last:border-0">
                                    <td className="px-3 py-1.5">{fdate(d.date)}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">
                                      {d.value === null ? <span className="text-muted-foreground">leer</span> : fmtVal(d.value)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {kpiFiles.length < 3 && (
              <button onClick={() => fileInputRef.current?.click()} disabled={step === 'saving' || kpiProcessing}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                data-testid="button-weitere-pdf">
                {kpiProcessing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Weitere PDF hinzufügen
              </button>
            )}

            {kpiTagesVorschau && (
              <div className="rounded-lg border border-border bg-card p-4" data-testid="kpi-tagesanalyse-vorschau">
                <div className="text-sm font-semibold mb-1">Tagesanalyse (Vorschau)</div>
                <p className="text-xs text-muted-foreground mb-3">
                  Zusammenführung der geladenen Berichte über das Kalenderdatum — berechnete Werte,
                  gewichtet über {kpiTagesVorschau.dayCount} Tag{kpiTagesVorschau.dayCount === 1 ? '' : 'e'}.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Personen</div>
                    <div className="text-sm font-medium tabular-nums">
                      {kpiTagesVorschau.persons !== null ? NUM0.format(Math.round(kpiTagesVorschau.persons)) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Umsatz, berechnet</div>
                    <div className="text-sm font-medium tabular-nums">
                      {kpiTagesVorschau.primaryRevenue !== null ? `CHF ${NUM.format(kpiTagesVorschau.primaryRevenue)}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Bons, berechnet
                      <InfoTip text={BONS_BERECHNET_TOOLTIP} />
                    </div>
                    <div className="text-sm font-medium tabular-nums">
                      {kpiTagesVorschau.derivedReceiptCount !== null ? NUM0.format(Math.round(kpiTagesVorschau.derivedReceiptCount)) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Personen pro Bon</div>
                    <div className="text-sm font-medium tabular-nums">
                      {kpiTagesVorschau.personsPerReceipt !== null ? kpiTagesVorschau.personsPerReceipt.toFixed(1) : '—'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>}

          {/* Bestätigen-Buttons */}
          {((importType === 'zbericht' && parsed && !zDupInfo) || (importType === 'kpi' && kpiFiles.length > 0)) && (
            <div className="flex gap-3 pt-2 flex-wrap">
              <button onClick={resetWizard} disabled={step === 'saving'}
                className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                Abbrechen
              </button>
              <button onClick={() => void handleConfirm()}
                disabled={step === 'saving' || (importType === 'kpi' && (kpiValidCount === 0 || kpiYearPending))}
                data-testid="button-import-bestaetigen"
                className={cn(
                  'px-5 py-2 text-sm rounded-md disabled:opacity-50 flex items-center gap-2 transition-colors',
                  showReplaceCta
                    ? 'bg-amber-600 text-white hover:bg-amber-700'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90',
                )}>
                {step === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <CheckCircle2 className="h-3.5 w-3.5" />
                {showReplaceCta ? 'Importieren und Daten ersetzen'
                  : importType === 'kpi' && kpiValidCount > 0
                    ? `${kpiValidCount} Bericht${kpiValidCount === 1 ? '' : 'e'} importieren`
                    : 'Import bestätigen'}
              </button>
              {importType === 'kpi' && kpiYearPending && (
                <p className="text-xs text-amber-700 dark:text-amber-400 self-center">
                  Bitte zuerst für alle Berichte ohne erkennbares Jahr das Importjahr wählen.
                </p>
              )}
            </div>
          )}
        </>}

        {/* ── Step: Done (Z-Bericht) ────────────────────────────────────────── */}
        {step === 'done' && !kpiSaveResults && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-8 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-semibold text-emerald-800 dark:text-emerald-300">Import erfolgreich</p>
            <button onClick={resetWizard}
              className="mt-2 px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
              Weiteren Import starten
            </button>
          </div>
        )}

        {/* ── Step: Done (Gäste & Bonanalyse Ergebnis) ──────────────────────── */}
        {step === 'done' && kpiSaveResults && (() => {
          const okN   = kpiSaveResults.filter(r => r.status === 'ok').length;
          const noopN = kpiSaveResults.filter(r => r.status === 'noop').length;
          const failN = kpiSaveResults.filter(r => r.status === 'error').length;
          return (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-card p-5 flex flex-wrap items-center gap-4">
                <CheckCircle2 className={cn('h-8 w-8', failN > 0 ? 'text-amber-500' : 'text-emerald-500')} />
                <div className="text-sm">
                  <p className="font-semibold">
                    {okN} importiert{noopN > 0 ? ` · ${noopN} unverändert` : ''}{failN > 0 ? ` · ${failN} fehlgeschlagen` : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">{kpiSaveResults.length} Bericht{kpiSaveResults.length === 1 ? '' : 'e'} verarbeitet</p>
                </div>
              </div>

              <div className="space-y-2">
                {kpiSaveResults.map((r, i) => {
                  const tone = r.status === 'ok' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20'
                    : r.status === 'noop' ? 'border-border bg-muted/20'
                    : 'border-red-300 bg-red-50 dark:bg-red-950/20';
                  return (
                    <div key={`${r.fileName}-${i}`} className={cn('rounded-lg border px-4 py-3 flex items-center gap-3', tone)}
                      data-testid={`result-${r.fileName}`}>
                      {r.status === 'ok' ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                        : r.status === 'noop' ? <Info className="h-4 w-4 text-muted-foreground shrink-0" />
                        : <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{r.fileName} <span className="text-muted-foreground font-normal">· {r.kindLabel}</span></p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.status === 'ok' ? (r.message ?? 'Importiert')
                            : r.status === 'noop' ? (r.message ?? 'Unverändert übersprungen')
                            : `Fehler: ${r.message ?? 'Unbekannt'}`}
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
      <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">.pdf</span>
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
