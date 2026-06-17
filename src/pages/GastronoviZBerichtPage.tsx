/**
 * GastronoviZBerichtPage — Z-Bericht & Personen CSV Import
 *
 * Zwei Importtypen:
 *   Z-Bericht    — Tagesumsatz, Kostenstellen, Kellner, Bezahlarten, etc.
 *   Personen     — Gäste / Umsatz pro Person (Analyse → Verkäufe → Personen)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2,
  Trash2, ChevronDown, ChevronUp, RefreshCw,
  Info, AlertCircle, Database, Users,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';

import { parseGnZBericht } from '@/lib/gn-zbericht-parser';
import type { GnParsedZBericht } from '@/lib/gn-zbericht-parser';
import {
  saveGnImport, loadGnImports, deleteGnImport, checkDuplicate, checkGnTablesExist,
} from '@/lib/gn-zbericht-db';
import type { GnImportRow } from '@/lib/gn-zbericht-db';

import { parseGnPersonReport } from '@/lib/gn-personen-parser';
import type { GnParsedPersonReport, PersonCsvType } from '@/lib/gn-personen-parser';
import {
  savePersonImport, loadPersonImports, deletePersonImport,
  checkPersonDuplicate, checkPersonTablesExist,
} from '@/lib/gn-personen-db';
import type { GnPersonImportRow } from '@/lib/gn-personen-db';

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

type ImportType  = 'zbericht' | 'personen';
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
  const [tablesOk,   setTablesOk]   = useState<boolean | null>(null);

  // Z-Bericht State
  const [parsed,    setParsed]    = useState<GnParsedZBericht | null>(null);
  const [dupInfo,   setDupInfo]   = useState<{ existingId: string; importedAt: string } | null>(null);
  const [zHistory,  setZHistory]  = useState<GnImportRow[]>([]);

  // Personen State
  const [parsedPerson,    setParsedPerson]    = useState<GnParsedPersonReport | null>(null);
  const [dupPersonInfo,   setDupPersonInfo]   = useState<{ existingId: string; importedAt: string } | null>(null);
  const [personHistory,   setPersonHistory]   = useState<GnPersonImportRow[]>([]);
  const [csvTypeOverride, setCsvTypeOverride] = useState<PersonCsvType | null>(null);

  // History
  const [histLoading, setHistLoading] = useState(false);
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set());
  const [deleting,    setDeleting]    = useState<string | null>(null);

  const csvRef = useRef<HTMLInputElement>(null);

  // ── Setup prüfen ────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([checkGnTablesExist(), checkPersonTablesExist()])
      .then(([z, p]) => setTablesOk(z && p));
  }, []);

  // ── History laden ─────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const [z, p] = await Promise.all([
      loadGnImports(tenantId),
      loadPersonImports(tenantId),
    ]);
    setZHistory(z);
    setPersonHistory(p);
    setHistLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  // ── Typ wechseln → Reset ──────────────────────────────────────────────────

  const resetWizard = useCallback(() => {
    setParsed(null); setDupInfo(null);
    setParsedPerson(null); setDupPersonInfo(null);
    setCsvTypeOverride(null);
    setParseError(null); setStep('upload');
  }, []);

  const handleTypeChange = (t: ImportType) => {
    setImportType(t);
    resetWizard();
  };

  // ── CSV verarbeiten ──────────────────────────────────────────────────────

  const processCSV = useCallback(async (file: File) => {
    setParseError(null); setParsed(null); setParsedPerson(null);
    setDupInfo(null); setDupPersonInfo(null);

    try {
      const text = await file.text();

      if (importType === 'zbericht') {
        const result = parseGnZBericht(text, file.name);
        if (result.revenue.totalGross === 0 && result.taxes.length === 0) {
          setParseError('Datei konnte nicht als Gastronovi Z-Bericht erkannt werden. Bitte prüfe das Format.');
          return;
        }
        const dup = await checkDuplicate(tenantId, result.checksum, result.zCounter, result.periodFrom, result.periodTo);
        if (dup.isDuplicate && dup.existingId) {
          setDupInfo({ existingId: dup.existingId, importedAt: dup.existingImportedAt ?? '' });
        }
        setParsed(result);
      } else {
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
      }
      setStep('preview');
    } catch (e) {
      setParseError('Fehler: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [importType, tenantId]);

  const handleFileSelect = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    processCSV(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = Array.from(e.dataTransfer.files).find(f => f.name.toLowerCase().endsWith('.csv'));
    if (file) handleFileSelect(file);
  };

  // ── Bestätigen ─────────────────────────────────────────────────────────────

  const handleConfirm = async (replace = false) => {
    setStep('saving');
    if (importType === 'zbericht' && parsed) {
      const { error } = await saveGnImport(tenantId, parsed, undefined, replace && dupInfo ? dupInfo.existingId : undefined);
      if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
    } else if (importType === 'personen' && parsedPerson) {
      const { error } = await savePersonImport(
        tenantId, parsedPerson,
        replace && dupPersonInfo ? dupPersonInfo.existingId : undefined,
        csvTypeOverride ?? undefined,
      );
      if (error) { toast.error('Import fehlgeschlagen: ' + error); setStep('preview'); return; }
    }
    toast.success('Import erfolgreich gespeichert');
    setStep('done');
    setTab('history');
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
  const activeDupInfo      = importType === 'zbericht' ? dupInfo : dupPersonInfo;
  const activeWarnCount    = importType === 'zbericht' ? warnCount : pWarnCount;
  const activeWarnings     = importType === 'zbericht' ? (parsed?.warnings ?? []) : (parsedPerson?.warnings ?? []);

  const historyCount = zHistory.length + personHistory.length;

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
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">
        <h1 className="text-base font-bold flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          Gastronovi Import
        </h1>
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-5 space-y-3">
          <p className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Datenbank-Setup erforderlich
          </p>
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Bitte führe beide SQL-Migrations-Scripts im Supabase SQL-Editor aus:
          </p>
          <div className="space-y-1.5">
            <code className="block bg-white dark:bg-black/20 border border-amber-200 rounded p-2.5 text-xs font-mono">
              supabase/migrations/20260617_gn_zbericht.sql
            </code>
            <code className="block bg-white dark:bg-black/20 border border-amber-200 rounded p-2.5 text-xs font-mono">
              supabase/migrations/20260617_gn_personen.sql
            </code>
            <code className="block bg-white dark:bg-black/20 border border-amber-200 rounded p-2.5 text-xs font-mono">
              supabase/migrations/20260617_gn_analysis.sql
            </code>
          </div>
          <button onClick={() => Promise.all([checkGnTablesExist(), checkPersonTablesExist()]).then(([z, p]) => setTablesOk(z && p))}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 text-white text-sm hover:bg-amber-700">
            <RefreshCw className="h-3.5 w-3.5" />
            Erneut prüfen
          </button>
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

      {/* ── Import Tab ──────────────────────────────────────────────────────── */}
      {tab === 'import' && <>

        {/* Import-Typ Auswahl */}
        <div className="flex gap-2">
          <TypeBtn active={importType === 'zbericht'} onClick={() => handleTypeChange('zbericht')}
            icon={<FileText className="h-4 w-4" />} label="Z-Bericht" desc="Tagesumsatz, Kostenstellen, Kellner, Bezahlarten" />
          <TypeBtn active={importType === 'personen'} onClick={() => handleTypeChange('personen')}
            icon={<Users className="h-4 w-4" />} label="Personen Bericht" desc="Gäste / Umsatz pro Person" />
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
            label={importType === 'zbericht' ? 'Gastronovi Z-Bericht CSV hier ablegen' : 'Gastronovi Personen-Bericht CSV hier ablegen'}
            hint={importType === 'personen' ? 'Analyse → Verkäufe → Personen / Umsatz pro Person' : undefined}
          />
          <input ref={csvRef} type="file" accept=".csv" className="hidden"
            onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])} />

          {parseError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-400">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {parseError}
            </div>
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

          {/* ── Z-Bericht Vorschau ─────────────────────────────────────────── */}
          {importType === 'zbericht' && parsed && <>
            <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetaCell label="Zeitraum"     value={`${fdate(parsed.periodFrom)} – ${fdate(parsed.periodTo)}`} />
              <MetaCell label="Z-Zähler"     value={parsed.zCounter || '—'} />
              <MetaCell label="Kostenstelle" value={parsed.costCenter || '—'} />
            </div>

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

          {/* Bestätigen-Buttons */}
          {!activeDupInfo && (
            <div className="flex gap-3 pt-2">
              <button onClick={resetWizard}
                className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                Abbrechen
              </button>
              <button onClick={() => handleConfirm(false)} disabled={step === 'saving'}
                className="px-5 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2 transition-colors">
                {step === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <CheckCircle2 className="h-3.5 w-3.5" />
                Import bestätigen
              </button>
            </div>
          )}
        </>}

        {/* ── Step: Done ────────────────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-8 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-semibold text-emerald-800 dark:text-emerald-300">Import erfolgreich</p>
            <button onClick={resetWizard}
              className="mt-2 px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
              Weiteren Import starten
            </button>
          </div>
        )}
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
                    badge="Z-Bericht"
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
        </div>
      )}
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
