/**
 * GastronoviZBerichtPage — Z-Bericht CSV Import
 *
 * Workflow:
 *   1. CSV hochladen (+ optionales PDF)
 *   2. Vorschau der erkannten Daten
 *   3. Bestätigen / Duplikat ersetzen
 *   4. Importverlauf anzeigen & verwalten
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, FileText, CheckCircle2, AlertTriangle, Loader2,
  Trash2, ChevronDown, ChevronUp, RefreshCw, FileUp,
  X, Info, AlertCircle, Database,
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

// ── Formatting ────────────────────────────────────────────────────────────────

const NUM = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function fc(v: number) { return v > 0 ? `CHF ${NUM.format(v)}` : '—'; }
function fp(v: number) { return v > 0 ? NUM.format(v) + ' %' : '—'; }
function fdate(iso: string | null) {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

type WizardStep = 'upload' | 'preview' | 'saving' | 'done';
type Tab = 'import' | 'history';

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GastronoviZBerichtPage() {
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();

  if (!isAdmin) return <Navigate to="/" replace />;

  const [tab, setTab]               = useState<Tab>('import');
  const [step, setStep]             = useState<WizardStep>('upload');
  const [parsed, setParsed]         = useState<GnParsedZBericht | null>(null);
  const [pdfName, setPdfName]       = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dupInfo, setDupInfo]       = useState<{ existingId: string; importedAt: string } | null>(null);
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [history, setHistory]       = useState<GnImportRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [tablesOk, setTablesOk]     = useState<boolean | null>(null);
  const [deleting, setDeleting]     = useState<string | null>(null);

  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  // ── Tabellen prüfen ─────────────────────────────────────────────────────────

  useEffect(() => {
    checkGnTablesExist().then(ok => setTablesOk(ok));
  }, []);

  // ── History laden ────────────────────────────────────────────────────────────

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    const rows = await loadGnImports(tenantId);
    setHistory(rows);
    setHistLoading(false);
  }, [tenantId]);

  useEffect(() => {
    if (tab === 'history') loadHistory();
  }, [tab, loadHistory]);

  // ── CSV verarbeiten ──────────────────────────────────────────────────────────

  const processCSV = useCallback(async (file: File) => {
    setParseError(null);
    setParsed(null);
    setDupInfo(null);

    try {
      const text = await file.text();
      const result = parseGnZBericht(text, file.name);

      if (result.revenue.totalGross === 0 && result.taxes.length === 0) {
        setParseError('Die CSV konnte nicht als Gastronovi Z-Bericht erkannt werden. Bitte prüfe das Dateiformat.');
        return;
      }

      // Duplikat-Prüfung
      const dup = await checkDuplicate(
        tenantId,
        result.checksum,
        result.zCounter,
        result.periodFrom,
        result.periodTo,
      );

      if (dup.isDuplicate && dup.existingId) {
        setDupInfo({ existingId: dup.existingId, importedAt: dup.existingImportedAt ?? '' });
      }

      setParsed(result);
      setStep('preview');
    } catch (e) {
      setParseError('Fehler beim Lesen der Datei: ' + (e instanceof Error ? e.message : String(e)));
    }
  }, [tenantId]);

  const handleCSVFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setParseError('Bitte eine CSV-Datei auswählen.');
      return;
    }
    processCSV(file);
  };

  const handlePDFFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) return;
    setPdfName(file.name);
  };

  // ── Drag & Drop ──────────────────────────────────────────────────────────────

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const csv = files.find(f => f.name.toLowerCase().endsWith('.csv'));
    const pdf = files.find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (csv) handleCSVFile(csv);
    if (pdf) handlePDFFile(pdf);
  };

  // ── Bestätigen ───────────────────────────────────────────────────────────────

  const handleConfirm = async (replace = false) => {
    if (!parsed) return;
    setStep('saving');
    const { error } = await saveGnImport(
      tenantId,
      parsed,
      pdfName ?? undefined,
      replace && dupInfo ? dupInfo.existingId : undefined,
    );
    if (error) {
      toast.error('Import fehlgeschlagen: ' + error);
      setStep('preview');
      return;
    }
    toast.success('Z-Bericht erfolgreich importiert');
    setStep('done');
    setTab('history');
    loadHistory();
  };

  // ── Löschen ──────────────────────────────────────────────────────────────────

  const handleDelete = async (id: string) => {
    if (!confirm('Diesen Import wirklich löschen?')) return;
    setDeleting(id);
    const { error } = await deleteGnImport(id);
    if (error) { toast.error('Löschen fehlgeschlagen'); }
    else { toast.success('Import gelöscht'); loadHistory(); }
    setDeleting(null);
  };

  const reset = () => {
    setParsed(null); setPdfName(null); setParseError(null);
    setDupInfo(null); setStep('upload');
  };

  // ── Precompute (kein Division in JSX) ─────────────────────────────────────

  const taxNetTotalParsed = parsed ? parsed.taxNetTotal : 0;
  const grossTotal        = parsed ? parsed.revenue.totalGross : 0;
  const warnCount         = parsed ? parsed.warnings.length : 0;
  const ccCount           = parsed ? parsed.costCenters.length : 0;
  const waiterCount       = parsed ? parsed.waiters.length : 0;
  const pmCount           = parsed ? parsed.paymentMethods.length : 0;
  const pgCount           = parsed ? parsed.productGroups.length : 0;
  const discCount         = parsed ? parsed.discounts.length : 0;
  const cancelCount       = parsed ? parsed.cancellations.length : 0;
  const acctCount         = parsed ? parsed.accountingLines.length : 0;

  // ── Setup-Banner ─────────────────────────────────────────────────────────────

  if (tablesOk === false) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-4">
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          Gastronovi Z-Bericht Import
        </h1>
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 p-5 space-y-3">
          <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Datenbank-Setup erforderlich
          </div>
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Die Gastronovi-Tabellen wurden noch nicht erstellt. Bitte führe das SQL-Script
            im Supabase SQL-Editor aus:
          </p>
          <code className="block bg-white dark:bg-black/20 border border-amber-200 rounded p-3 text-xs font-mono text-amber-900 dark:text-amber-300">
            supabase/migrations/20260617_gn_zbericht.sql
          </code>
          <ol className="text-sm text-amber-700 dark:text-amber-400 list-decimal ml-4 space-y-1">
            <li>Supabase Dashboard öffnen → SQL-Editor</li>
            <li>Inhalt der Datei <strong>20260617_gn_zbericht.sql</strong> einfügen</li>
            <li>Ausführen (Run)</li>
            <li>Diese Seite neu laden</li>
          </ol>
          <button
            onClick={() => checkGnTablesExist().then(setTablesOk)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 text-white text-sm hover:bg-amber-700"
          >
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
          <h1 className="text-base font-bold">Gastronovi Z-Bericht Import</h1>
          <p className="text-xs text-muted-foreground mt-0.5">CSV-Datei hochladen · Daten prüfen · Importieren</p>
        </div>
        <div className="ml-auto flex items-center gap-0.5 bg-muted rounded-md p-0.5">
          {(['import', 'history'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); if (t === 'import') reset(); }}
              className={cn(
                'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                tab === t ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'import' ? 'Neuer Import' : `Importverlauf${history.length > 0 ? ` (${history.length})` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Import Tab ─────────────────────────────────────────────────────────── */}
      {tab === 'import' && <>

        {/* Schritt-Anzeige */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {(['upload', 'preview', 'done'] as WizardStep[]).map((s, i) => {
            const labels: Record<WizardStep, string> = { upload: 'Hochladen', preview: 'Vorschau', saving: 'Speichern', done: 'Fertig' };
            const done = step === 'done' || (step === 'preview' && s === 'upload') || (step === 'saving' && (s === 'upload' || s === 'preview'));
            const active = step === s;
            return <>
              {i > 0 && <span key={'sep'+i} className="text-border">›</span>}
              <span key={s} className={cn('font-medium', active && 'text-primary', done && 'text-emerald-600 dark:text-emerald-400')}>
                {labels[s]}
              </span>
            </>;
          })}
        </div>

        {/* ── Schritt 1: Upload ─────────────────────────────────────────────── */}
        {step === 'upload' && <>
          {/* CSV-Drop-Zone */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => csvRef.current?.click()}
            className={cn(
              'rounded-xl border-2 border-dashed cursor-pointer transition-colors flex flex-col items-center justify-center py-14 gap-3',
              isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:bg-muted/40',
            )}
          >
            <Upload className={cn('h-8 w-8', isDragging ? 'text-primary' : 'text-muted-foreground')} />
            <div className="text-center">
              <p className="text-sm font-medium">Gastronovi Z-Bericht CSV hier ablegen</p>
              <p className="text-xs text-muted-foreground mt-0.5">oder klicken zum Auswählen</p>
            </div>
            <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">.csv</span>
          </div>
          <input ref={csvRef} type="file" accept=".csv" className="hidden"
            onChange={e => e.target.files?.[0] && handleCSVFile(e.target.files[0])} />

          {/* PDF-Upload (optional) */}
          <div className="flex items-center gap-3 rounded-lg border border-border p-3 bg-muted/20">
            <FileUp className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">PDF-Originalbeleg (optional)</p>
              {pdfName
                ? <p className="text-xs text-emerald-600 mt-0.5">{pdfName}</p>
                : <p className="text-xs text-muted-foreground mt-0.5">Zur Archivierung</p>
              }
            </div>
            <button onClick={() => pdfRef.current?.click()}
              className="text-xs px-2.5 py-1 rounded border border-border bg-background hover:bg-muted transition-colors">
              {pdfName ? 'Ändern' : 'PDF wählen'}
            </button>
            {pdfName && <button onClick={() => setPdfName(null)}><X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" /></button>}
          </div>
          <input ref={pdfRef} type="file" accept=".pdf" className="hidden"
            onChange={e => e.target.files?.[0] && handlePDFFile(e.target.files[0])} />

          {parseError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-400">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {parseError}
            </div>
          )}
        </>}

        {/* ── Schritt 2: Vorschau ───────────────────────────────────────────── */}
        {(step === 'preview' || step === 'saving') && parsed && <>

          {/* Duplikat-Warnung */}
          {dupInfo && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300 text-sm">
                <AlertTriangle className="h-4 w-4" />
                Dieser Z-Bericht wurde bereits importiert
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Importiert am: {fdate(dupInfo.importedAt)}
              </p>
              <div className="flex gap-2 mt-2">
                <button onClick={reset}
                  className="px-3 py-1.5 text-xs rounded border border-amber-400 text-amber-700 hover:bg-amber-100">
                  Abbrechen
                </button>
                <button onClick={() => handleConfirm(true)}
                  className="px-3 py-1.5 text-xs rounded bg-amber-600 text-white hover:bg-amber-700 flex items-center gap-1.5">
                  {step === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
                  Bestehenden Import ersetzen
                </button>
              </div>
            </div>
          )}

          {/* Warnungen */}
          {warnCount > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-1">
              <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                {warnCount} Hinweis{warnCount > 1 ? 'e' : ''}
              </p>
              {parsed.warnings.map((w, i) => (
                <p key={i} className="text-xs text-blue-600 dark:text-blue-400 ml-5">{w}</p>
              ))}
            </div>
          )}

          {/* Metadaten-Karte */}
          <div className="rounded-lg border border-border bg-card p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetaCell label="Zeitraum"     value={`${fdate(parsed.periodFrom)} – ${fdate(parsed.periodTo)}`} />
            <MetaCell label="Z-Zähler"     value={parsed.zCounter || '—'} />
            <MetaCell label="Kostenstelle" value={parsed.costCenter || '—'} />
            <MetaCell label="PDF-Beleg"    value={pdfName ?? '—'} />
          </div>

          {/* Kennzahlen-Übersicht */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <KpiMini label="Brutto Umsatz"  value={fc(grossTotal)} />
            <KpiMini label="Netto Umsatz"   value={fc(taxNetTotalParsed)} bold />
            <KpiMini label="Food Umsatz"    value={fc(parsed.foodAmount)} />
            <KpiMini label="Beverage"       value={fc(parsed.bevAmount)} />
            <KpiMini label="Bar Umsatz"     value={fc(parsed.barAmount)} />
            <KpiMini label="Take Away"      value={fc(parsed.takeAwayAmount)} />
            <KpiMini label="Rabatte"        value={fc(parsed.discountTotal)} neg />
            <KpiMini label="Storno"         value={fc(parsed.stornoTotal)} neg />
            <KpiMini label="Marketing"      value={fc(parsed.marketingAmount)} neg />
            <KpiMini label="Maison"         value={fc(parsed.maisonAmount)} neg />
            <KpiMini label="Anzahl Bons"    value={parsed.bonCount > 0 ? NUM0.format(parsed.bonCount) : '—'} />
            <KpiMini label="Ø Bon"          value={fc(parsed.avgBon)} />
          </div>

          {/* Detailtabellen */}
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

          {/* Steuerbericht */}
          {parsed.taxes.length > 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="px-4 py-2 bg-muted/40 border-b border-border text-xs font-semibold">
                Steuerbericht ({parsed.taxes.length} Sätze)
              </div>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border bg-muted/20 text-right">
                  <th className="px-3 py-1.5 text-left font-medium">Steuersatz</th>
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
                    <td className="px-3 py-1.5 text-right" colSpan={3}>{fc(taxNetTotalParsed)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Bestätigen-Button (nur wenn kein Duplikat oder nicht ersetzt werden soll) */}
          {!dupInfo && (
            <div className="flex gap-3 pt-2">
              <button onClick={reset}
                className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                Abbrechen
              </button>
              <button
                onClick={() => handleConfirm(false)}
                disabled={step === 'saving'}
                className="px-5 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2 transition-colors"
              >
                {step === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <CheckCircle2 className="h-3.5 w-3.5" />
                Import bestätigen
              </button>
            </div>
          )}
        </>}

        {/* ── Schritt: Done ────────────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-8 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="font-semibold text-emerald-800 dark:text-emerald-300">Import erfolgreich</p>
            <p className="text-sm text-emerald-700 dark:text-emerald-400">Der Z-Bericht wurde gespeichert.</p>
            <button onClick={reset}
              className="mt-2 px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700">
              Weiteren Import starten
            </button>
          </div>
        )}
      </>}

      {/* ── Importverlauf Tab ──────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{history.length} Import{history.length !== 1 ? 'e' : ''}</p>
            <button onClick={loadHistory} disabled={histLoading}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <RefreshCw className={cn('h-3 w-3', histLoading && 'animate-spin')} />
              Aktualisieren
            </button>
          </div>

          {histLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Lade Importverlauf…
            </div>
          )}

          {!histLoading && history.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              Noch keine Importe vorhanden.
            </div>
          )}

          {!histLoading && history.map(row => {
            const raw = row.raw_csv_json as GnParsedZBericht | null;
            const isOpen = expanded.has(row.id);
            const gross = raw?.revenue?.totalGross ?? 0;
            const net   = raw?.taxNetTotal ?? 0;

            return (
              <div key={row.id} className="rounded-lg border border-border overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpanded(prev => {
                    const n = new Set(prev);
                    isOpen ? n.delete(row.id) : n.add(row.id);
                    return n;
                  })}
                >
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{row.file_name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {fdate(row.period_from)} – {fdate(row.period_to)}
                      {row.cost_center && ` · ${row.cost_center}`}
                      {row.z_counter && ` · Z-Nr. ${row.z_counter}`}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold">{fc(gross)}</p>
                    {net > 0 && <p className="text-xs text-muted-foreground">Netto {fc(net)}</p>}
                  </div>
                  <div className="flex items-center gap-2 ml-2">
                    <p className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {fdate(row.imported_at?.slice(0, 10))}
                    </p>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(row.id); }}
                      disabled={deleting === row.id}
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      {deleting === row.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                    {isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                </div>

                {isOpen && raw && (
                  <div className="border-t border-border px-4 py-3 bg-muted/10 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <MetaCell label="Brutto"       value={fc(raw.revenue?.totalGross ?? 0)} />
                    <MetaCell label="Netto"        value={fc(raw.taxNetTotal ?? 0)} />
                    <MetaCell label="Food"         value={fc(raw.foodAmount ?? 0)} />
                    <MetaCell label="Beverage"     value={fc(raw.bevAmount ?? 0)} />
                    <MetaCell label="Bar"          value={fc(raw.barAmount ?? 0)} />
                    <MetaCell label="Take Away"    value={fc(raw.takeAwayAmount ?? 0)} />
                    <MetaCell label="Rabatte"      value={fc(raw.discountTotal ?? 0)} />
                    <MetaCell label="Storno"       value={fc(raw.stornoTotal ?? 0)} />
                    <MetaCell label="Kellner"      value={String(raw.waiters?.length ?? '—')} />
                    <MetaCell label="Kostenstellen" value={String(raw.costCenters?.length ?? '—')} />
                    <MetaCell label="Anz. Bons"    value={raw.bonCount > 0 ? NUM0.format(raw.bonCount) : '—'} />
                    <MetaCell label="Ø Bon"        value={fc(raw.avgBon ?? 0)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Sub-Komponenten ───────────────────────────────────────────────────────────

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
      <p className={cn('text-sm mt-0.5', bold && 'font-bold', neg && 'text-red-600 dark:text-red-400')}>
        {value}
      </p>
    </div>
  );
}

function SectionTable<T>({
  title, rows, cols, render,
}: {
  title: string;
  rows: T[];
  cols: string[];
  render: (row: T) => string[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="px-4 py-2 bg-muted/40 border-b border-border text-xs font-semibold">{title}</div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/20">
            {cols.map((c, i) => (
              <th key={i} className={cn('px-3 py-1.5 font-medium', i === 0 ? 'text-left' : 'text-right')}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const cells = render(row);
            return (
              <tr key={i} className="border-b border-border/40 last:border-0">
                {cells.map((c, j) => (
                  <td key={j} className={cn('px-3 py-1.5', j === 0 ? 'text-left' : 'text-right')}>{c}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
