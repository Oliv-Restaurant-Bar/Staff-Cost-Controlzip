/**
 * SalesUpload – CSV Verkaufsdaten Import
 * ========================================
 * Flow:
 *   1. CSV-Datei auswählen
 *   2. Datei parsen (papaparse)
 *   3. Vorschau anzeigen + Spalten-Mapping prüfen
 *   4. Validierung (Pflichtfelder, Datentypen)
 *   5. Import starten → product_sales schreiben
 *   6. Erfolgsmeldung + Import-Historie aktualisieren
 *
 * Import-Pflichtfelder:
 *   product_name, quantity, revenue, sale_date
 *
 * Zusätzliche Felder:
 *   source, import_batch, notes
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import {
  Upload, FileText, Check, AlertTriangle, X, RefreshCw,
  ChevronDown, History, CircleAlert,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { insertProductSales, fetchImportBatches, type ImportBatch } from '@/lib/sales-db';

// ─── Typen ────────────────────────────────────────────────────────────────────

type RawRow = Record<string, string>;

interface MappedRow {
  product_name: string;
  quantity:     number;
  revenue:      number;
  sale_date:    string;
  source?:      string;
  import_batch?: string;
  notes?:       string;
}

interface ValidationError {
  row:     number;
  field:   string;
  message: string;
}

type ImportStep = 'idle' | 'preview' | 'importing' | 'done' | 'error';

const REQUIRED_FIELDS = ['product_name', 'quantity', 'revenue', 'sale_date'] as const;

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtChf(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(v);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH').format(v);
}

function fmtDate(iso: string): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('de-CH');
}

function parseNumber(raw: string): number | null {
  if (!raw?.trim()) return null;
  const cleaned = raw.trim().replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDate(raw: string): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  // ISO: 2024-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // DE: 15.03.2024 or 15.3.2024
  const de = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`;
  // Try general parse
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

// Versuche automatisch Spalten zu mappen
function autoDetectMapping(headers: string[]): Record<string, string> {
  const lower = headers.map(h => h.toLowerCase().trim());
  const mapping: Record<string, string> = {};

  const patterns: Record<string, RegExp[]> = {
    product_name: [/product.?name|produkt.?name|name|artikel/i],
    quantity:     [/qty|quantity|menge|anzahl|stück/i],
    revenue:      [/revenue|umsatz|betrag|amount|erlo[eö]s/i],
    sale_date:    [/sale.?date|datum|date|verkauf.?datum/i],
    source:       [/source|quelle/i],
    import_batch: [/batch|import.?batch|charge/i],
    notes:        [/notes|notiz|kommentar|bemerkung/i],
  };

  for (const [field, pats] of Object.entries(patterns)) {
    for (const pat of pats) {
      const idx = lower.findIndex(h => pat.test(h));
      if (idx !== -1 && !Object.values(mapping).includes(headers[idx])) {
        mapping[field] = headers[idx];
        break;
      }
    }
  }
  return mapping;
}

// ─── Import-Historie ──────────────────────────────────────────────────────────

function ImportHistory({ batches, loading }: { batches: ImportBatch[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
        ))}
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
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {['Batch', 'Quelle', 'Datei', 'Datum', 'Zeilen', 'Absatz', 'Umsatz CHF'].map(h => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {batches.map((b, i) => (
            <tr key={`${b.import_batch}-${i}`} className="hover:bg-muted/30 transition-colors">
              <td className="px-3 py-2 font-medium text-xs">{b.import_batch || '–'}</td>
              <td className="px-3 py-2 text-muted-foreground text-xs">{b.source || '–'}</td>
              <td className="px-3 py-2 text-muted-foreground text-xs truncate max-w-[120px]" title={b.file_name}>
                {b.file_name || '–'}
              </td>
              <td className="px-3 py-2 text-muted-foreground text-xs">{fmtDate(b.sales_date)}</td>
              <td className="px-3 py-2 tabular-nums text-xs">{fmtNum(b.rows_imported)}</td>
              <td className="px-3 py-2 tabular-nums text-xs">{fmtNum(b.total_qty)}</td>
              <td className="px-3 py-2 tabular-nums font-semibold text-xs">{fmtChf(b.total_revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function SalesUpload() {
  const fileRef = useRef<HTMLInputElement>(null);

  // Zustand
  const [step, setStep]               = useState<ImportStep>('idle');
  const [fileName, setFileName]       = useState('');
  const [headers, setHeaders]         = useState<string[]>([]);
  const [rawRows, setRawRows]         = useState<RawRow[]>([]);
  const [mapping, setMapping]         = useState<Record<string, string>>({});
  const [errors, setErrors]           = useState<ValidationError[]>([]);
  const [mappedRows, setMappedRows]   = useState<MappedRow[]>([]);
  const [importCount, setImportCount] = useState(0);
  const [importError, setImportError] = useState('');

  // Formularfelder für Metadaten
  const [metaSource, setMetaSource]         = useState('');
  const [metaBatch, setMetaBatch]           = useState('');
  const [metaNotes, setMetaNotes]           = useState('');

  // Import-Historie
  const [batches, setBatches]       = useState<ImportBatch[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);

  const loadBatches = useCallback(async () => {
    setBatchLoading(true);
    const data = await fetchImportBatches();
    setBatches(data);
    setBatchLoading(false);
  }, []);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  // ── CSV parsen ──────────────────────────────────────────────────────────────

  function handleFile(file: File) {
    setFileName(file.name);
    setStep('idle');
    setErrors([]);

    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: result => {
        const hdrs = result.meta.fields ?? [];
        const rows = result.data as RawRow[];
        setHeaders(hdrs);
        setRawRows(rows);
        setMapping(autoDetectMapping(hdrs));
        setStep('preview');
      },
      error: err => {
        setImportError(`CSV-Fehler: ${err.message}`);
        setStep('error');
      },
    });
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith('.csv')) handleFile(file);
  }

  // ── Validieren ─────────────────────────────────────────────────────────────

  function validate(): { rows: MappedRow[]; errors: ValidationError[] } {
    const errs: ValidationError[] = [];
    const rows: MappedRow[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const rowNum = i + 2; // +1 für Header, +1 für 1-based

      const productName = raw[mapping.product_name]?.trim() ?? '';
      const quantityRaw = raw[mapping.quantity] ?? '';
      const revenueRaw  = raw[mapping.revenue] ?? '';
      const dateRaw     = raw[mapping.sale_date] ?? '';

      if (!productName) errs.push({ row: rowNum, field: 'product_name', message: 'Produktname ist leer' });
      const qty = parseNumber(quantityRaw);
      if (qty === null) errs.push({ row: rowNum, field: 'quantity', message: `Ungültige Menge: "${quantityRaw}"` });
      const rev = parseNumber(revenueRaw);
      if (rev === null) errs.push({ row: rowNum, field: 'revenue', message: `Ungültiger Umsatz: "${revenueRaw}"` });
      const dt = parseDate(dateRaw);
      if (!dt) errs.push({ row: rowNum, field: 'sale_date', message: `Ungültiges Datum: "${dateRaw}"` });

      if (productName && qty !== null && rev !== null && dt) {
        rows.push({
          product_name: productName,
          quantity:     qty,
          revenue:      rev,
          sale_date:    dt,
          source:       metaSource || (mapping.source ? raw[mapping.source]?.trim() : undefined),
          import_batch: metaBatch  || (mapping.import_batch ? raw[mapping.import_batch]?.trim() : undefined),
          notes:        metaNotes  || (mapping.notes ? raw[mapping.notes]?.trim() : undefined),
          ...(fileName ? { file_name: fileName } : {}),
        });
      }
    }

    return { rows, errors: errs };
  }

  function onValidate() {
    const result = validate();
    setErrors(result.errors);
    setMappedRows(result.rows);
  }

  useEffect(() => {
    if (step === 'preview' && mapping.product_name) {
      onValidate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, metaSource, metaBatch, metaNotes]);

  // ── Importieren ────────────────────────────────────────────────────────────

  async function doImport() {
    if (mappedRows.length === 0) return;
    setStep('importing');
    setImportError('');

    // Dateiname zu rows hinzufügen
    const rows = mappedRows.map(r => ({ ...r, file_name: fileName }));
    const { count, error } = await insertProductSales(rows);

    if (error) {
      setImportError(error);
      setStep('error');
    } else {
      setImportCount(count);
      setStep('done');
      await loadBatches();
    }
  }

  function reset() {
    setStep('idle');
    setFileName('');
    setHeaders([]);
    setRawRows([]);
    setMapping({});
    setErrors([]);
    setMappedRows([]);
    setImportCount(0);
    setImportError('');
    if (fileRef.current) fileRef.current.value = '';
  }

  // ── Mapping-Selektor ───────────────────────────────────────────────────────

  function MappingSelect({
    field,
    label,
    required = false,
  }: { field: string; label: string; required?: boolean }) {
    return (
      <div className="space-y-1">
        <Label className="text-xs flex items-center gap-1">
          {label}
          {required && <span className="text-red-500">*</span>}
        </Label>
        <Select
          value={mapping[field] ?? '__none__'}
          onValueChange={v => setMapping(m => ({ ...m, [field]: v === '__none__' ? '' : v }))}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="– Spalte wählen –" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">– Keine –</SelectItem>
            {headers.map(h => (
              <SelectItem key={h} value={h}>{h}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  const canImport = step === 'preview' && errors.length === 0 && mappedRows.length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-indigo-100 dark:bg-indigo-950/40 p-2">
          <Upload className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Verkaufsdaten Upload</h1>
          <p className="text-sm text-muted-foreground">CSV-Datei importieren → product_sales</p>
        </div>
      </div>

      {/* ── Erfolg ────────────────────────────────────────────────────────── */}
      {step === 'done' && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/10 p-4 flex items-start gap-3">
          <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">
              Import erfolgreich — {fmtNum(importCount)} Zeilen importiert
            </p>
            <p className="text-sm text-emerald-600 dark:text-emerald-500 mt-0.5">
              Datei: {fileName}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={reset}>Neuer Import</Button>
        </div>
      )}

      {/* ── Fehler ────────────────────────────────────────────────────────── */}
      {step === 'error' && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/40 dark:bg-red-950/10 p-4 flex items-start gap-3">
          <CircleAlert className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-red-700 dark:text-red-400">Import fehlgeschlagen</p>
            <p className="text-sm text-red-600 dark:text-red-500 mt-0.5">{importError}</p>
          </div>
          <Button variant="outline" size="sm" onClick={reset}>Zurücksetzen</Button>
        </div>
      )}

      {/* ── Datei-Upload ──────────────────────────────────────────────────── */}
      {(step === 'idle' || step === 'preview') && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              1. CSV-Datei auswählen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary hover:bg-muted/20 transition-colors"
              onDragOver={e => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              {fileName ? (
                <div>
                  <p className="font-medium text-sm">{fileName}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{rawRows.length} Zeilen erkannt</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium">CSV hierher ziehen oder klicken</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Unterstützt: .csv (UTF-8 oder ANSI)</p>
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                onChange={onFileChange}
                className="hidden"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Metadaten + Spaltenmapping ────────────────────────────────────── */}
      {step === 'preview' && (
        <>
          <div className="grid md:grid-cols-2 gap-4">

            {/* Metadaten */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">2. Import-Metadaten (optional)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Quelle (source)</Label>
                  <Input
                    value={metaSource}
                    onChange={e => setMetaSource(e.target.value)}
                    placeholder="z.B. gastronovi, manuell"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Import-Batch</Label>
                  <Input
                    value={metaBatch}
                    onChange={e => setMetaBatch(e.target.value)}
                    placeholder="z.B. 2024-03, März-Import"
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Notiz</Label>
                  <Input
                    value={metaNotes}
                    onChange={e => setMetaNotes(e.target.value)}
                    placeholder="Optionale Bemerkung"
                    className="h-8 text-sm"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Spaltenmapping */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">3. Spaltenzuordnung</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <MappingSelect field="product_name"  label="Produktname"       required />
                <MappingSelect field="quantity"      label="Menge (quantity)"  required />
                <MappingSelect field="revenue"       label="Umsatz (revenue)"  required />
                <MappingSelect field="sale_date"     label="Datum (sale_date)" required />
                <MappingSelect field="source"        label="Quelle (source)" />
                <MappingSelect field="import_batch"  label="Batch" />
                <MappingSelect field="notes"         label="Notiz" />
              </CardContent>
            </Card>
          </div>

          {/* Validierungsfehler */}
          {errors.length > 0 && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/10 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                  {errors.length} Validierungsfehler – Import noch nicht möglich
                </p>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {errors.slice(0, 20).map((e, i) => (
                  <p key={i} className="text-[11px] text-amber-700 dark:text-amber-500">
                    Zeile {e.row}, Feld «{e.field}»: {e.message}
                  </p>
                ))}
                {errors.length > 20 && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-500">… und {errors.length - 20} weitere</p>
                )}
              </div>
            </div>
          )}

          {/* Validierung OK */}
          {errors.length === 0 && mappedRows.length > 0 && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/10 p-3 flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                <strong>{fmtNum(mappedRows.length)} Zeilen</strong> validiert und bereit für den Import
              </p>
            </div>
          )}

          {/* Vorschau-Tabelle */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between gap-3 flex-wrap">
                <span>4. Vorschau (erste 10 Zeilen)</span>
                <Badge variant="outline" className="font-normal text-xs">
                  {rawRows.length} Zeilen gesamt
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">#</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Produkt</th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Menge</th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Datum</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {rawRows.slice(0, 10).map((row, i) => {
                      const rowErrors = errors.filter(e => e.row === i + 2);
                      const productName = row[mapping.product_name]?.trim() ?? '';
                      const quantityRaw = row[mapping.quantity] ?? '';
                      const revenueRaw  = row[mapping.revenue] ?? '';
                      const dateRaw     = row[mapping.sale_date] ?? '';
                      const qty = parseNumber(quantityRaw);
                      const rev = parseNumber(revenueRaw);
                      const dt  = parseDate(dateRaw);
                      const ok  = !!productName && qty !== null && rev !== null && !!dt;
                      return (
                        <tr key={i} className={`transition-colors ${rowErrors.length > 0 ? 'bg-red-50/30 dark:bg-red-950/10' : 'hover:bg-muted/30'}`}>
                          <td className="px-3 py-2 text-muted-foreground">{i + 2}</td>
                          <td className="px-3 py-2 font-medium truncate max-w-[160px]">{productName || '–'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{qty != null ? fmtNum(qty) : <span className="text-red-500">{quantityRaw || '–'}</span>}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{rev != null ? fmtChf(rev) : <span className="text-red-500">{revenueRaw || '–'}</span>}</td>
                          <td className="px-3 py-2">{dt || <span className="text-red-500">{dateRaw || '–'}</span>}</td>
                          <td className="px-3 py-2">
                            {ok
                              ? <Check className="h-3.5 w-3.5 text-emerald-500" />
                              : <X className="h-3.5 w-3.5 text-red-500" />
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Import-Button */}
          <div className="flex gap-3">
            <Button
              onClick={doImport}
              disabled={!canImport || step === 'importing'}
              className="gap-2"
            >
              {step === 'importing' ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {step === 'importing' ? 'Importiere…' : `${fmtNum(mappedRows.length)} Zeilen importieren`}
            </Button>
            <Button variant="outline" onClick={reset}>
              <X className="h-4 w-4 mr-1.5" />
              Abbrechen
            </Button>
          </div>
        </>
      )}

      {/* ── Import-Historie ────────────────────────────────────────────────── */}
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
