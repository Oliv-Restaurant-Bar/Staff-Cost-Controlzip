/**
 * SalesUpload – Produktiver Gastronovi CSV Import
 * =================================================
 * Flow:
 *   1. Dateien auswählen (Anzahl Food + Umsatz Food, optional Beverage)
 *   2. Metadaten eingeben (Jahr Pflicht, Quelle + Notiz optional)
 *   3. Parsing + Matching (Anzahl ↔ Umsatz per Produktname)
 *   4. Vorschau mit Statistiken
 *   5. Import → product_sales
 *   6. Erfolg + Import-Historie aktualisieren
 *
 * Parser: src/lib/gastronovi-csv-parser.ts
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, FileText, Check, AlertTriangle, X, RefreshCw,
  History, CircleAlert, ChevronRight, Utensils, Wine,
  Info, Trash2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useTenant } from '@/contexts/TenantContext';
import { ResetProductMonthDialog } from '@/components/ResetProductMonthDialog';
import { ImportTaskPrefillHint } from '@/components/ImportTaskPrefillHint';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  parseWideFile, matchAnzahlUmsatz, generateImportBatch,
  type NormalizedSaleRow, type MatchResult, type ParseResult,
} from '@/lib/gastronovi-csv-parser';
import { insertProductSales, deleteProductSalesForPeriod, computeDeleteScope, fetchImportBatches, sourceLabel, type ImportBatch } from '@/lib/sales-db';

// ─── Typen ────────────────────────────────────────────────────────────────────

type ImportStep = 'idle' | 'parsing' | 'preview' | 'importing' | 'done' | 'error';

interface SectionFiles {
  anzahl: File | null;
  umsatz: File | null;
}

interface SectionResult {
  matchResult: MatchResult;
  anzahlParse: ParseResult;
  umsatzParse: ParseResult;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtChf(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(v);
}

function fmtNum(v: number | null | undefined, dec = 0): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH', { maximumFractionDigits: dec }).format(v);
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-CH');
}

// ─── Datei-Drop-Zone ──────────────────────────────────────────────────────────

function FileDropZone({
  label,
  hint,
  file,
  onFile,
  onClear,
  required = false,
  accent = 'default',
}: {
  label:    string;
  hint:     string;
  file:     File | null;
  onFile:   (f: File) => void;
  onClear:  () => void;
  required?: boolean;
  accent?:  'default' | 'food' | 'beverage';
}) {
  const ref = useRef<HTMLInputElement>(null);
  const borderCls = {
    default:  'border-border hover:border-primary',
    food:     'border-orange-200 hover:border-orange-400 dark:border-orange-800 dark:hover:border-orange-600',
    beverage: 'border-blue-200 hover:border-blue-400 dark:border-blue-800 dark:hover:border-blue-600',
  }[accent];
  const bgCls = {
    default:  'bg-muted/20',
    food:     'bg-orange-50/20 dark:bg-orange-950/10',
    beverage: 'bg-blue-50/20 dark:bg-blue-950/10',
  }[accent];
  const iconCls = {
    default:  'text-muted-foreground',
    food:     'text-orange-400',
    beverage: 'text-blue-400',
  }[accent];

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith('.csv')) onFile(f);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-medium">{label}</Label>
        {required && <span className="text-red-500 text-xs">*</span>}
      </div>
      {file ? (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
          accent === 'food' ? 'border-orange-200 bg-orange-50/30 dark:border-orange-800 dark:bg-orange-950/10'
          : accent === 'beverage' ? 'border-blue-200 bg-blue-50/30 dark:border-blue-800 dark:bg-blue-950/10'
          : 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/10'
        }`}>
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{file.name}</p>
            <p className="text-[10px] text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
          </div>
          <button onClick={onClear} className="shrink-0 p-0.5 rounded hover:bg-muted/40 transition-colors">
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      ) : (
        <div
          className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${borderCls} ${bgCls}`}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => ref.current?.click()}
        >
          <Upload className={`h-6 w-6 mx-auto mb-1.5 ${iconCls}`} />
          <p className="text-xs text-muted-foreground">{hint}</p>
          <input
            ref={ref}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Import-Historie ──────────────────────────────────────────────────────────

function ImportHistory({ batches, loading }: { batches: ImportBatch[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map(i => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
      </div>
    );
  }
  if (batches.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Noch keine Import-Batches vorhanden
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            {(['Batch-ID', 'Quelle', 'Importiert am', 'Frühstes Datum'] as const).map(h => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
            ))}
            {(['Datensätze', 'Absatz', 'Umsatz CHF'] as const).map(h => (
              <th key={h} className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {batches.map((b, i) => (
            <tr key={`${b.import_batch}-${i}`} className="hover:bg-muted/30 transition-colors">
              <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{b.import_batch || '–'}</td>
              <td className="px-3 py-2 font-medium">{sourceLabel(b.source)}</td>
              <td className="px-3 py-2 text-muted-foreground">{fmtDate(b.imported_at)}</td>
              <td className="px-3 py-2 text-muted-foreground">{fmtDate(b.sales_date)}</td>
              <td className="px-3 py-2 tabular-nums text-right">{fmtNum(b.rows_imported)}</td>
              <td className="px-3 py-2 tabular-nums text-right">{fmtNum(b.total_qty, 0)}</td>
              <td className="px-3 py-2 tabular-nums text-right font-semibold">{fmtChf(b.total_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Vorschau-Karte ───────────────────────────────────────────────────────────

function PreviewCard({
  title,
  result,
  rows,
  accent,
}: {
  title:  string;
  result: SectionResult;
  rows:   NormalizedSaleRow[];
  accent: 'food' | 'beverage';
}) {
  const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  const preview  = rows.slice(0, 8);
  const cls = accent === 'food'
    ? 'border-orange-200 dark:border-orange-800'
    : 'border-blue-200 dark:border-blue-800';

  return (
    <Card className={`border ${cls}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            {accent === 'food'
              ? <Utensils className="h-4 w-4 text-orange-500" />
              : <Wine className="h-4 w-4 text-blue-500" />
            }
            {title}
          </CardTitle>
          <div className="flex gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px] font-normal">
              {rows.length} Datensätze
            </Badge>
            <Badge variant="outline" className="text-[10px] font-normal">
              {fmtNum(totalQty, 0)} Stück
            </Badge>
            <Badge variant="outline" className="text-[10px] font-normal">
              {fmtChf(totalRev)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Statistiken */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div className="rounded bg-muted/40 px-2.5 py-1.5">
            <p className="text-muted-foreground">Produkte</p>
            <p className="font-semibold">{result.anzahlParse.rows.length}</p>
          </div>
          <div className="rounded bg-muted/40 px-2.5 py-1.5">
            <p className="text-muted-foreground">Tage</p>
            <p className="font-semibold">{result.matchResult.dateColumnCount}</p>
          </div>
          <div className="rounded bg-muted/40 px-2.5 py-1.5">
            <p className="text-muted-foreground">Übersprungen</p>
            <p className="font-semibold text-amber-600 dark:text-amber-400">{result.matchResult.skippedCount}</p>
          </div>
          <div className="rounded bg-muted/40 px-2.5 py-1.5">
            <p className="text-muted-foreground">Warnungen</p>
            <p className="font-semibold text-amber-600 dark:text-amber-400">{result.matchResult.warningCount}</p>
          </div>
        </div>

        {/* Ungematchte Produkte */}
        {result.matchResult.unmatchedProducts.length > 0 && (
          <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                {result.matchResult.unmatchedProducts.length} Produkt(e) ohne Gegenstück
              </p>
            </div>
            <div className="space-y-0.5 max-h-24 overflow-y-auto">
              {result.matchResult.unmatchedProducts.slice(0, 10).map((n, i) => (
                <p key={i} className="text-[10px] text-amber-600 dark:text-amber-500 truncate">• {n}</p>
              ))}
            </div>
          </div>
        )}

        {/* Mehrfach im Export vorkommende Produkte (pro Tag zusammengeführt) */}
        {result.matchResult.duplicateProducts.length > 0 && (
          <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/10 px-3 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <Info className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              <p className="text-[11px] font-semibold text-blue-700 dark:text-blue-400">
                {result.matchResult.duplicateProducts.length} Produkt(e) mehrfach im Export – Mengen &amp; Umsätze pro Tag zusammengeführt
              </p>
            </div>
            <div className="space-y-0.5 max-h-24 overflow-y-auto">
              {result.matchResult.duplicateProducts.slice(0, 10).map((n, i) => (
                <p key={i} className="text-[10px] text-blue-600 dark:text-blue-500 truncate">• {n}</p>
              ))}
            </div>
          </div>
        )}

        {/* Vorschau-Tabelle */}
        <div className="overflow-x-auto rounded border border-border/60">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="px-2.5 py-1.5 text-left text-[10px] font-semibold text-muted-foreground uppercase">Produkt</th>
                <th className="px-2.5 py-1.5 text-left text-[10px] font-semibold text-muted-foreground uppercase">Datum</th>
                <th className="px-2.5 py-1.5 text-right text-[10px] font-semibold text-muted-foreground uppercase">Menge</th>
                <th className="px-2.5 py-1.5 text-right text-[10px] font-semibold text-muted-foreground uppercase">Umsatz</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {preview.map((r, i) => (
                <tr key={i} className="hover:bg-muted/20 transition-colors">
                  <td className="px-2.5 py-1.5 max-w-[160px] truncate" title={r.product_name}>{r.product_name}</td>
                  <td className="px-2.5 py-1.5 tabular-nums">{fmtDate(r.sale_date)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(r.quantity, 1)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtChf(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 8 && (
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border/40">
              … und {rows.length - 8} weitere Datensätze
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function SalesUpload() {
  const { isAdmin, user } = useAuth();
  const { tenantId } = useTenant();
  const userEmail = user?.email ?? 'unbekannt';

  // Datei-Zustand
  const [foodFiles, setFoodFiles]       = useState<SectionFiles>({ anzahl: null, umsatz: null });
  const [beverageFiles, setBeverageFiles] = useState<SectionFiles>({ anzahl: null, umsatz: null });

  // Formular-Metadaten
  const [year, setYear]         = useState(String(new Date().getFullYear()));
  const [source, setSource]     = useState('');
  const [notes, setNotes]       = useState('');

  // Ergebnisse
  const [step, setStep]         = useState<ImportStep>('idle');
  const [parseError, setParseError] = useState('');
  const [foodResult, setFoodResult]         = useState<SectionResult | null>(null);
  const [beverageResult, setBeverageResult] = useState<SectionResult | null>(null);
  const [importCount, setImportCount]       = useState(0);
  const [deletedCount, setDeletedCount]     = useState(0);
  const [importBatchId, setImportBatchId]   = useState('');

  // Historie
  const [batches, setBatches]           = useState<ImportBatch[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);

  const loadBatches = useCallback(async () => {
    setBatchLoading(true);
    setBatches(await fetchImportBatches(tenantId));
    setBatchLoading(false);
  }, [tenantId]);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  // ── Validierung Formularzustand ─────────────────────────────────────────────

  const yearNum = parseInt(year, 10);
  const yearValid = !isNaN(yearNum) && yearNum >= 2020 && yearNum <= 2099;
  const canParse = foodFiles.anzahl && foodFiles.umsatz && yearValid;

  const hasBeverage = !!(beverageFiles.anzahl || beverageFiles.umsatz);
  const beverageReady = !hasBeverage || (!!beverageFiles.anzahl && !!beverageFiles.umsatz);

  // ── Parsen ─────────────────────────────────────────────────────────────────

  async function doParse() {
    if (!canParse || !foodFiles.anzahl || !foodFiles.umsatz) return;
    setStep('parsing');
    setParseError('');
    setFoodResult(null);
    setBeverageResult(null);

    const batchId = generateImportBatch('food');
    setImportBatchId(batchId);

    try {
      // Food parsen
      const [foodAnzahl, foodUmsatz] = await Promise.all([
        parseWideFile(foodFiles.anzahl),
        parseWideFile(foodFiles.umsatz),
      ]);

      const foodMatch = matchAnzahlUmsatz(
        foodAnzahl, foodUmsatz, yearNum, 'food',
        {
          source: source || 'food_csv_export',
          importBatch: batchId,
          anzahlFileName: foodFiles.anzahl.name,
          umsatzFileName: foodFiles.umsatz.name,
          notes,
        }
      );
      setFoodResult({ matchResult: foodMatch, anzahlParse: foodAnzahl, umsatzParse: foodUmsatz });

      // Beverage parsen (wenn vorhanden)
      if (beverageFiles.anzahl && beverageFiles.umsatz) {
        const [bevAnzahl, bevUmsatz] = await Promise.all([
          parseWideFile(beverageFiles.anzahl),
          parseWideFile(beverageFiles.umsatz),
        ]);

        const bevBatch = batchId.replace('food-', 'beverage-');
        const bevMatch = matchAnzahlUmsatz(
          bevAnzahl, bevUmsatz, yearNum, 'beverage',
          {
            source: source || 'beverage_csv_export',
            importBatch: bevBatch,
            anzahlFileName: beverageFiles.anzahl.name,
            umsatzFileName: beverageFiles.umsatz.name,
            notes,
          }
        );
        setBeverageResult({ matchResult: bevMatch, anzahlParse: bevAnzahl, umsatzParse: bevUmsatz });
      }

      setStep('preview');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setParseError(msg);
      setStep('error');
    }
  }

  // ── Importieren ─────────────────────────────────────────────────────────────

  async function doImport() {
    const allRows: NormalizedSaleRow[] = [
      ...(foodResult?.matchResult.rows ?? []),
      ...(beverageResult?.matchResult.rows ?? []),
    ];

    if (allRows.length === 0) return;
    setStep('importing');

    // ── Schritt A: Bestehende Daten TAG-GENAU ersetzen ──────────────────────
    // Nur die tatsächlich in der Datei enthaltenen Tage (pro Mandant + source)
    // werden gelöscht; Tage/Produkte ausserhalb der Datei bleiben unverändert.
    // Re-Import derselben Datei ⇒ identische Summen (idempotent).
    const scope = computeDeleteScope(allRows);

    console.log('[SalesUpload] Delete-before-insert (tag-genau, tenant=' + tenantId + '):', scope);
    const { deleted, error: delErr } = await deleteProductSalesForPeriod(tenantId, scope);
    if (delErr) {
      setParseError(`Fehler beim Löschen alter Daten: ${delErr}`);
      setStep('error');
      return;
    }
    setDeletedCount(deleted);
    console.log(`[SalesUpload] ${deleted} alte Zeilen gelöscht vor Re-Import`);

    // ── Schritt B: Neue Daten einfügen (mit aktivem Mandant) ──────────────────
    const { count, error } = await insertProductSales(tenantId, allRows);
    if (error) {
      setParseError(error);
      setStep('error');
    } else {
      setImportCount(count);
      setStep('done');
      await loadBatches();
      window.dispatchEvent(new CustomEvent('product_sales_updated'));
    }
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  function reset() {
    setStep('idle');
    setFoodFiles({ anzahl: null, umsatz: null });
    setBeverageFiles({ anzahl: null, umsatz: null });
    setFoodResult(null);
    setBeverageResult(null);
    setParseError('');
    setImportCount(0);
    setDeletedCount(0);
  }

  // ── Gesamtzahlen ────────────────────────────────────────────────────────────

  const allPreviewRows = [
    ...(foodResult?.matchResult.rows ?? []),
    ...(beverageResult?.matchResult.rows ?? []),
  ];
  const totalQty = allPreviewRows.reduce((s, r) => s + r.quantity, 0);
  const totalRev = allPreviewRows.reduce((s, r) => s + r.revenue, 0);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-indigo-100 dark:bg-indigo-950/40 p-2">
          <Upload className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Verkaufsdaten Upload</h1>
          <p className="text-sm text-muted-foreground">
            Gastronovi CSV-Export → Anzahl + Umsatz → product_sales
          </p>
        </div>
      </div>

      {/* Hinweis aus der Import-Checkliste (advisory, schränkt nichts ein) */}
      <ImportTaskPrefillHint />

      {/* ── Erfolg ──────────────────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 p-4 flex items-start gap-3">
          <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">
              Import erfolgreich — {fmtNum(importCount)} Datensätze importiert
            </p>
            <p className="text-sm text-emerald-600 dark:text-emerald-500 mt-1">
              Batch: {importBatchId} · Jahr: {year}
              {beverageResult ? ' · Food + Beverage' : ' · Food'}
            </p>
            {deletedCount > 0 && (
              <p className="text-xs text-emerald-600/80 dark:text-emerald-600 mt-1">
                ↻ {fmtNum(deletedCount)} veraltete Zeilen ersetzt (Re-Import, keine Duplikate)
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={reset}>Neuer Import</Button>
        </div>
      )}

      {/* ── Fehler ──────────────────────────────────────────────────────────── */}
      {step === 'error' && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/10 p-4 flex items-start gap-3">
          <CircleAlert className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-red-700 dark:text-red-400 mb-1">Fehler</p>
            <pre className="text-sm text-red-600 dark:text-red-500 whitespace-pre-wrap font-mono">{parseError}</pre>
          </div>
          <Button variant="outline" size="sm" onClick={() => setStep('idle')}>Zurück</Button>
        </div>
      )}

      {/* ── Schritt 1+2: Dateien & Metadaten ────────────────────────────────── */}
      {(step === 'idle' || step === 'parsing') && (
        <>
          {/* Anleitung */}
          <div className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/30 dark:bg-indigo-950/10 px-4 py-3 flex items-start gap-2.5">
            <Info className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
            <div className="text-[11px] text-indigo-700 dark:text-indigo-400 space-y-0.5">
              <p className="font-semibold">Format: Tab-getrennte CSV-Dateien (Gastronovi Export)</p>
              <p>Dateipaare: <span className="font-medium">«Anzahl Food …»</span> + <span className="font-medium">«Umsatz Food …»</span></p>
              <p>Kopfzeile Zeile 1 · Spalte A = Bezeichnung · Datum-Spalten ab Spalte C (Format: 01.03.)</p>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">

            {/* Metadaten */}
            <Card className="md:col-span-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">1. Import-Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1">
                    Jahr <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    value={year}
                    onChange={e => setYear(e.target.value)}
                    placeholder="z.B. 2026"
                    className={`h-8 text-sm ${!yearValid && year ? 'border-red-400' : ''}`}
                    maxLength={4}
                  />
                  {!yearValid && year && (
                    <p className="text-[10px] text-red-500">Bitte gültiges Jahr eingeben (z.B. 2026)</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Quelle (optional)</Label>
                  <Input
                    value={source}
                    onChange={e => setSource(e.target.value)}
                    placeholder="z.B. gastronovi"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Notiz (optional)</Label>
                  <Input
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="z.B. März-Export"
                    className="h-8 text-sm"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Food-Dateien */}
            <Card className="border-orange-200 dark:border-orange-800 md:col-span-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Utensils className="h-4 w-4 text-orange-500" />
                  2. Food CSV-Dateien
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <FileDropZone
                  label="Anzahl Food"
                  hint="«Anzahl Food …csv» hier ablegen"
                  file={foodFiles.anzahl}
                  onFile={f => setFoodFiles(p => ({ ...p, anzahl: f }))}
                  onClear={() => setFoodFiles(p => ({ ...p, anzahl: null }))}
                  required
                  accent="food"
                />
                <FileDropZone
                  label="Umsatz Food"
                  hint="«Umsatz Food …csv» hier ablegen"
                  file={foodFiles.umsatz}
                  onFile={f => setFoodFiles(p => ({ ...p, umsatz: f }))}
                  onClear={() => setFoodFiles(p => ({ ...p, umsatz: null }))}
                  required
                  accent="food"
                />
              </CardContent>
            </Card>

            {/* Beverage-Dateien */}
            <Card className="border-blue-200 dark:border-blue-800 md:col-span-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Wine className="h-4 w-4 text-blue-500" />
                  3. Beverage CSV-Dateien
                  <Badge variant="outline" className="text-[10px] font-normal ml-auto">Optional</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <FileDropZone
                  label="Anzahl Beverage"
                  hint="«Anzahl Beverage …csv» hier ablegen"
                  file={beverageFiles.anzahl}
                  onFile={f => setBeverageFiles(p => ({ ...p, anzahl: f }))}
                  onClear={() => setBeverageFiles(p => ({ ...p, anzahl: null }))}
                  accent="beverage"
                />
                <FileDropZone
                  label="Umsatz Beverage"
                  hint="«Umsatz Beverage …csv» hier ablegen"
                  file={beverageFiles.umsatz}
                  onFile={f => setBeverageFiles(p => ({ ...p, umsatz: f }))}
                  onClear={() => setBeverageFiles(p => ({ ...p, umsatz: null }))}
                  accent="beverage"
                />
                {hasBeverage && !beverageReady && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Bitte beide Beverage-Dateien hochladen
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Parsen-Button */}
          <div className="flex items-center gap-3">
            <Button
              onClick={doParse}
              disabled={!canParse || !beverageReady || step === 'parsing'}
              className="gap-2"
            >
              {step === 'parsing' ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {step === 'parsing' ? 'Wird analysiert…' : 'Dateien analysieren & Vorschau'}
            </Button>
            {!yearValid && <p className="text-sm text-muted-foreground">Jahr fehlt</p>}
            {!foodFiles.anzahl && <p className="text-sm text-muted-foreground">Anzahl Food fehlt</p>}
            {!foodFiles.umsatz && <p className="text-sm text-muted-foreground">Umsatz Food fehlt</p>}
          </div>
        </>
      )}

      {/* ── Schritt 3: Vorschau ──────────────────────────────────────────────── */}
      {step === 'preview' && (
        <>
          {/* Gesamtzusammenfassung */}
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-500 shrink-0" />
              <p className="text-sm font-semibold">
                Bereit zum Import — {fmtNum(allPreviewRows.length)} Datensätze erkannt
              </p>
            </div>
            <div className="flex gap-4 text-sm text-muted-foreground">
              <span>Absatz: <strong>{fmtNum(totalQty, 0)}</strong></span>
              <span>Umsatz: <strong>{fmtChf(totalRev)}</strong></span>
              <span>Jahr: <strong>{year}</strong></span>
            </div>
          </div>

          {/* Re-Import-Hinweis */}
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-4 py-2.5 flex items-start gap-2">
            <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-400">
              <strong>Re-Import sicher:</strong> Bestehende Zeilen für dieselben Monate und Quellen werden
              vor dem Import automatisch gelöscht — keine doppelten Produkte.
            </p>
          </div>

          {/* Food Vorschau */}
          {foodResult && foodResult.matchResult.rows.length > 0 && (
            <PreviewCard
              title="Food – Vorschau"
              result={foodResult}
              rows={foodResult.matchResult.rows}
              accent="food"
            />
          )}

          {/* Beverage Vorschau */}
          {beverageResult && beverageResult.matchResult.rows.length > 0 && (
            <PreviewCard
              title="Beverage – Vorschau"
              result={beverageResult}
              rows={beverageResult.matchResult.rows}
              accent="beverage"
            />
          )}

          {allPreviewRows.length === 0 && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/10 p-4 text-center">
              <AlertTriangle className="h-6 w-6 text-amber-500 mx-auto mb-2" />
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                Keine importierbaren Datensätze erkannt
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">
                Alle Zeilen sind entweder Summen/Strukturzeilen oder haben Werte von 0.
              </p>
            </div>
          )}

          {/* Import-Buttons */}
          <div className="flex gap-3">
            <Button
              onClick={doImport}
              disabled={allPreviewRows.length === 0}
              className="gap-2"
            >
              <Upload className="h-4 w-4" />
              {fmtNum(allPreviewRows.length)} Datensätze importieren
            </Button>
            <Button variant="outline" onClick={reset} className="gap-2">
              <X className="h-4 w-4" />
              Abbrechen
            </Button>
          </div>
        </>
      )}

      {/* ── Import läuft ────────────────────────────────────────────────────── */}
      {step === 'importing' && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground py-4">
          <RefreshCw className="h-5 w-5 animate-spin text-primary" />
          Importiere {fmtNum(allPreviewRows.length)} Datensätze in Supabase…
        </div>
      )}

      {/* ── Monat zurücksetzen (nur Admin) ───────────────────────────────────── */}
      {isAdmin && (
        <ResetProductMonthDialog
          userEmail={userEmail}
          onReset={() => loadBatches()}
        />
      )}

      {/* ── Import-Historie ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4" />
              Import-Historie
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={loadBatches} className="h-7 gap-1 text-xs">
              <RefreshCw className="h-3 w-3" />
              Neu laden
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0 pb-2">
          <ImportHistory batches={batches} loading={batchLoading} />
        </CardContent>
      </Card>

    </div>
  );
}
