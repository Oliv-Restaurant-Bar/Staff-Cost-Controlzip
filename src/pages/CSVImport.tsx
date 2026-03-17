/**
 * Buchhaltungs-Import – CSV und PDF
 * ===================================
 * Einheitlicher Import-Wizard für:
 *   - CSV-Dateien (Banana, AbaNinja, Bexio, Sage, Excel-Export)
 *   - PDF-Kontoblätter (Banana, AbaNinja, Bexio, Sage)
 *
 * Ablauf:
 *   1. Datei hochladen + Konfiguration (Jahr, Monat, Typ, Modus)
 *   2. Vorschau (gematchte / nicht gematchte Zeilen)
 *   3. Bestätigen → Speichern
 *
 * Nur für Administratoren zugänglich.
 */

import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  Upload, CheckCircle2, AlertTriangle, XCircle, FileText,
  ChevronRight, ChevronLeft, Save, RefreshCw, Info, FileType,
  Loader2, ShoppingCart,
} from 'lucide-react';
import { GastronoviImportSection } from '@/components/GastronoviImportSection';
import { cn } from '@/lib/utils';
import {
  processCSV, matchCSVRows, buildMonthRecord,
  CSVParseResult, MatchedCSVRow, ImportConfig,
} from '@/lib/csv-import-engine';
import { parsePDF, detectMonthYear } from '@/lib/pdf-import-engine';
import { saveMonth } from '@/lib/reporting-store';
import { toast } from 'sonner';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

type Step = 'upload' | 'preview' | 'done';
type FileKind = 'csv' | 'pdf';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function formatAmount(n: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(n);
}

function statusBadge(status: MatchedCSVRow['status']) {
  if (status === 'exact') return (
    <Badge className="bg-green-100 text-green-800 border-green-200">Exakt</Badge>
  );
  if (status === 'range') return (
    <Badge className="bg-blue-100 text-blue-800 border-blue-200">Bereich</Badge>
  );
  return <Badge className="bg-red-100 text-red-800 border-red-200">Unbekannt</Badge>;
}

function fileKindBadge(kind: FileKind) {
  if (kind === 'pdf') return (
    <Badge className="bg-orange-100 text-orange-800 border-orange-200 text-[10px]">PDF</Badge>
  );
  return (
    <Badge className="bg-sky-100 text-sky-800 border-sky-200 text-[10px]">CSV</Badge>
  );
}

// ─── Upload-Zone ──────────────────────────────────────────────────────────────

interface UploadZoneProps {
  onFile: (name: string, kind: FileKind, buffer: ArrayBuffer) => void;
  parsing: boolean;
}

function UploadZone({ onFile, parsing }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const ext  = file.name.split('.').pop()?.toLowerCase();
    const kind: FileKind = ext === 'pdf' ? 'pdf' : 'csv';
    const reader = new FileReader();
    reader.onload = e => {
      const buf = e.target?.result as ArrayBuffer;
      onFile(file.name, kind, buf);
    };
    reader.readAsArrayBuffer(file);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, []);

  if (parsing) {
    return (
      <div className="border-2 border-dashed rounded-xl p-12 text-center border-primary/30 bg-primary/5">
        <Loader2 className="h-10 w-10 mx-auto mb-3 text-primary animate-spin" />
        <p className="font-medium text-sm text-primary">PDF wird analysiert…</p>
        <p className="text-xs text-muted-foreground mt-1">
          Text wird extrahiert und Kontonummern werden zugeordnet
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors',
        dragging
          ? 'border-primary bg-primary/5'
          : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30',
      )}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
    >
      <div className="flex justify-center gap-3 mb-3">
        <FileText className="h-9 w-9 text-sky-400" />
        <FileType className="h-9 w-9 text-orange-400" />
      </div>
      <p className="font-medium text-sm">CSV oder PDF hier ablegen oder klicken</p>
      <p className="text-xs text-muted-foreground mt-1">
        CSV: Banana, AbaNinja, Bexio, Sage 50, Excel-Export
      </p>
      <p className="text-xs text-muted-foreground">
        PDF: Kontenblatt-Export (Text-PDF, kein Scan)
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,.pdf,application/pdf"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ─── Vorschau-Tabelle ─────────────────────────────────────────────────────────

interface PreviewTableProps {
  rows: MatchedCSVRow[];
  emptyLabel: string;
}

function PreviewTable({ rows, emptyLabel }: PreviewTableProps) {
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-sm">{emptyLabel}</div>
    );
  }
  return (
    <div className="overflow-auto max-h-96">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Konto</TableHead>
            <TableHead>Bezeichnung</TableHead>
            <TableHead className="text-right">Betrag CHF</TableHead>
            <TableHead>P&L-Kategorie</TableHead>
            <TableHead>Abschnitt</TableHead>
            <TableHead className="w-24">Treffer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i} className={row.status === 'unresolved' ? 'bg-red-50/50' : ''}>
              <TableCell className="font-mono text-xs">{row.parsed.accountNumber}</TableCell>
              <TableCell className="text-sm">{row.parsed.accountName}</TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatAmount(row.parsed.amount)}
              </TableCell>
              <TableCell className="text-sm">
                {row.status === 'unresolved'
                  ? <span className="text-muted-foreground italic">—</span>
                  : row.plCategoryLabel}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.status === 'unresolved' ? '—' : row.plSection}
              </TableCell>
              <TableCell>{statusBadge(row.status)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Haupt-Komponente ─────────────────────────────────────────────────────────

export default function CSVImportPage() {
  const navigate    = useNavigate();
  const { isAdmin } = usePermissions();

  const [step, setStep]                     = useState<Step>('upload');
  const [fileName, setFileName]             = useState('');
  const [fileKind, setFileKind]             = useState<FileKind>('csv');
  const [parsing, setParsing]               = useState(false);
  const [parseResult, setParseResult]       = useState<CSVParseResult | null>(null);
  const [warnings, setWarnings]             = useState<string[]>([]);
  const [year, setYear]                     = useState<number>(CURRENT_YEAR);
  const [month, setMonth]                   = useState<number>(new Date().getMonth() + 1);
  const [dataType, setDataType]             = useState<'actual' | 'previous_year'>('actual');
  const [importMode, setImportMode]         = useState<'replace' | 'update'>('update');
  const [savedMonth, setSavedMonth]         = useState<{ year: number; month: number } | null>(null);
  const [loading, setLoading]               = useState(false);

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Kein Zugriff</p>
      </div>
    );
  }

  // ─── Datei-Handling ──────────────────────────────────────────────────────────

  async function handleFile(name: string, kind: FileKind, buffer: ArrayBuffer) {
    setFileName(name);
    setFileKind(kind);
    setWarnings([]);
    setParseResult(null);

    if (kind === 'pdf') {
      // Asynchrone PDF-Extraktion
      setParsing(true);
      try {
        const pdfResult = await parsePDF(buffer);
        const matchResult = matchCSVRows(pdfResult.rows);
        matchResult.warnings.push(...pdfResult.warnings);

        setParseResult(matchResult);
        setWarnings(matchResult.warnings);

        // Erkannten Monat/Jahr vorbelegen
        if (pdfResult.detectedYear) setYear(pdfResult.detectedYear);
        if (pdfResult.detectedMonth) setMonth(pdfResult.detectedMonth);

        if (pdfResult.detectedMonth || pdfResult.detectedYear) {
          toast.info(
            `Zeitraum erkannt: ${pdfResult.detectedMonth ? MONTHS[pdfResult.detectedMonth - 1] : ''} ${pdfResult.detectedYear ?? ''}`.trim(),
          );
        }
      } catch (e) {
        setWarnings([`PDF-Verarbeitung fehlgeschlagen: ${String(e)}`]);
      } finally {
        setParsing(false);
      }
    } else {
      // Synchrone CSV-Verarbeitung
      const text = new TextDecoder('utf-8').decode(buffer);
      const { parseResult: result, warnings: w } = processCSV(text);
      setParseResult(result);
      setWarnings(w);
    }
  }

  function resetFile() {
    setFileName('');
    setParseResult(null);
    setWarnings([]);
    setStep('upload');
  }

  // ─── Vorschau ─────────────────────────────────────────────────────────────

  function goToPreview() {
    if (!parseResult || parseResult.totalRows === 0) {
      toast.error('Keine gültigen Zeilen gefunden – bitte Datei prüfen');
      return;
    }
    setStep('preview');
  }

  // ─── Speichern ────────────────────────────────────────────────────────────

  function handleSave() {
    if (!parseResult) return;
    setLoading(true);

    const config: ImportConfig = { year, month, dataType, mode: importMode, fileName };
    const record = buildMonthRecord(parseResult.matched, parseResult.unresolved, config);

    try {
      const source: import('@/types/reporting').ImportSource =
        fileKind === 'pdf'
          ? (dataType === 'previous_year' ? 'pdf_previous_year' : 'pdf_current')
          : (dataType === 'previous_year' ? 'csv_previous_year' : 'csv_current');

      saveMonth(
        { ...record, year, month },
        source,
        importMode,
        {
          fileName,
          note: `${fileKind.toUpperCase()}-Import: ${parseResult.matchedCount} zugeordnet, ${parseResult.unresolvedCount} unbekannt`,
        },
      );
      setSavedMonth({ year, month });
      setStep('done');
      toast.success(`Daten für ${MONTHS[month - 1]} ${year} wurden gespeichert`);
    } catch (e) {
      toast.error('Fehler beim Speichern – bitte erneut versuchen');
    } finally {
      setLoading(false);
    }
  }

  // ─── Hilfswerte ───────────────────────────────────────────────────────────

  const revenueTotal = parseResult
    ? parseResult.matched.filter(r => r.sign === 'income').reduce((s, r) => s + r.parsed.amount, 0)
    : 0;
  const expenseTotal = parseResult
    ? parseResult.matched.filter(r => r.sign !== 'income').reduce((s, r) => s + r.parsed.amount, 0)
    : 0;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Upload className="h-6 w-6" />
            Import
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Buchhaltungsdaten und Tagesumsätze importieren
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate('/reporting')}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Zurück zu Reporting
        </Button>
      </div>

      {/* Top-level tab switch */}
      <Tabs defaultValue="accounting">
        <TabsList className="mb-2">
          <TabsTrigger value="accounting" className="flex items-center gap-1.5">
            <FileType className="h-4 w-4" />
            Buchhaltung (CSV / PDF)
          </TabsTrigger>
          <TabsTrigger value="gastronovi" className="flex items-center gap-1.5">
            <ShoppingCart className="h-4 w-4" />
            Tagesumsätze (Gastronovi)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gastronovi" className="mt-0">
          <GastronoviImportSection />
        </TabsContent>

        <TabsContent value="accounting" className="mt-0">

      {/* Fortschritts-Indicator */}
      <div className="flex items-center gap-2 text-sm">
        {(['upload', 'preview', 'done'] as Step[]).map((s, i) => {
          const steps: Step[] = ['upload', 'preview', 'done'];
          const currentIdx = steps.indexOf(step);
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={cn(
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors',
                step === s
                  ? 'border-primary bg-primary text-white'
                  : i < currentIdx
                  ? 'border-green-500 bg-green-500 text-white'
                  : 'border-muted-foreground/30 text-muted-foreground',
              )}>
                {i < currentIdx ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
              </div>
              <span className={cn('hidden sm:inline', step === s ? 'font-medium' : 'text-muted-foreground')}>
                {s === 'upload' ? '1. Datei & Einstellungen' : s === 'preview' ? '2. Vorschau' : '3. Fertig'}
              </span>
              {i < 2 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          );
        })}
      </div>

      {/* ── SCHRITT 1 ── */}
      {step === 'upload' && (
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Datei hochladen</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!fileName || parsing ? (
                <UploadZone onFile={handleFile} parsing={parsing} />
              ) : (
                <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium text-sm flex items-center gap-2">
                        {fileName}
                        {fileKindBadge(fileKind)}
                      </p>
                      {parseResult && (
                        <p className="text-xs text-muted-foreground">
                          {parseResult.totalRows} Zeilen gelesen
                          · {parseResult.matchedCount} zugeordnet
                          · {parseResult.unresolvedCount} unbekannt
                          {fileKind === 'csv' && ` · Trennzeichen: ${parseResult.detectedSeparator}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={resetFile}>
                    <XCircle className="h-4 w-4 mr-1" /> Andere Datei
                  </Button>
                </div>
              )}

              {warnings.length > 0 && (
                <Alert variant={parseResult?.totalRows === 0 ? 'destructive' : 'default'} className="text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <ul className="list-disc list-inside space-y-0.5">
                      {warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {/* PDF-Hinweis */}
              {!fileName && (
                <Alert className="text-sm">
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    <strong>PDF-Hinweis:</strong> Nur Text-PDFs werden unterstützt (direkt aus dem Buchhaltungsprogramm exportiert).
                    Gescannte oder fotografierte PDFs enthalten keinen auswertbaren Text – bitte stattdessen als CSV exportieren.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {/* Konfiguration */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Import-Einstellungen</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Jahr</label>
                  <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {YEARS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monat</label>
                  <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Datenjahr</label>
                  <Select value={dataType} onValueChange={v => setDataType(v as 'actual' | 'previous_year')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="actual">Laufendes Jahr (Ist)</SelectItem>
                      <SelectItem value="previous_year">Vorjahr (VJ)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Import-Modus</label>
                  <Select value={importMode} onValueChange={v => setImportMode(v as 'replace' | 'update')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="update">Aktualisieren (empfohlen)</SelectItem>
                      <SelectItem value="replace">Ersetzen (ganzer Monat)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Alert className="mt-4 text-sm">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {importMode === 'update' ? (
                    <><strong>Aktualisieren:</strong> Bestehende Werte werden ergänzt/überschrieben. Manuell erfasste Daten bleiben erhalten.</>
                  ) : (
                    <><strong>Ersetzen:</strong> Alle bisherigen Daten für {MONTHS[month - 1]} {year} werden gelöscht und neu gesetzt.</>
                  )}
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button
              onClick={goToPreview}
              disabled={!parseResult || parseResult.totalRows === 0 || parsing}
              size="lg"
            >
              Vorschau anzeigen <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* ── SCHRITT 2: Vorschau ── */}
      {step === 'preview' && parseResult && (
        <div className="space-y-6">
          {/* Zusammenfassung */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="bg-muted/30">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Zeilen gesamt</p>
                <p className="text-2xl font-bold">{parseResult.totalRows}</p>
              </CardContent>
            </Card>
            <Card className="bg-green-50 border-green-200">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Zugeordnet</p>
                <p className="text-2xl font-bold text-green-700">{parseResult.matchedCount}</p>
              </CardContent>
            </Card>
            <Card className={cn('border', parseResult.unresolvedCount > 0 ? 'bg-red-50 border-red-200' : 'bg-muted/30')}>
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Nicht zugeordnet</p>
                <p className={cn('text-2xl font-bold', parseResult.unresolvedCount > 0 ? 'text-red-700' : '')}>
                  {parseResult.unresolvedCount}
                </p>
              </CardContent>
            </Card>
            <Card className="bg-muted/30">
              <CardContent className="pt-4 pb-4">
                <p className="text-xs text-muted-foreground">Umsatz / Aufwand</p>
                <p className="text-sm font-bold leading-tight">
                  {formatAmount(revenueTotal)}<br />
                  <span className="text-xs font-normal text-muted-foreground">{formatAmount(expenseTotal)} Aufwand</span>
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Ziel-Info */}
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex flex-wrap gap-3 text-sm items-center">
                <span className="text-muted-foreground">Ziel:</span>
                <Badge variant="outline" className="font-normal">{MONTHS[month - 1]} {year}</Badge>
                <Badge variant="outline" className="font-normal">
                  {dataType === 'actual' ? 'Ist-Daten' : 'Vorjahresdaten'}
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {importMode === 'update' ? 'Aktualisieren' : 'Ersetzen'}
                </Badge>
                {fileKindBadge(fileKind)}
                <span className="text-muted-foreground">{fileName}</span>
              </div>
            </CardContent>
          </Card>

          {parseResult.unresolvedCount > 0 && (
            <Alert variant="destructive" className="text-sm">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>{parseResult.unresolvedCount} Konto(s)</strong> konnten nicht zugeordnet werden.
                Sie werden unter «Übrige Betriebskosten» gespeichert. Bitte im Kontenplan die fehlenden Konten anlegen und danach neu importieren.
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Buchungszeilen</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Tabs defaultValue="matched">
                <TabsList className="mx-4 mt-2">
                  <TabsTrigger value="matched">Zugeordnet ({parseResult.matchedCount})</TabsTrigger>
                  <TabsTrigger
                    value="unresolved"
                    className={parseResult.unresolvedCount > 0 ? 'text-red-600' : ''}
                  >
                    Nicht zugeordnet ({parseResult.unresolvedCount})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="matched" className="mt-0">
                  <PreviewTable rows={parseResult.matched} emptyLabel="Keine zugeordneten Zeilen" />
                </TabsContent>
                <TabsContent value="unresolved" className="mt-0">
                  <PreviewTable rows={parseResult.unresolved} emptyLabel="Alle Zeilen wurden zugeordnet" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Separator />

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep('upload')}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Zurück
            </Button>
            <Button onClick={handleSave} disabled={loading} size="lg" className="min-w-40">
              {loading
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Speichern…</>
                : <><Save className="h-4 w-4 mr-2" /> Jetzt importieren</>
              }
            </Button>
          </div>
        </div>
      )}

      {/* ── SCHRITT 3: Fertig ── */}
      {step === 'done' && savedMonth && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <CheckCircle2 className="h-14 w-14 mx-auto text-green-600" />
            <div>
              <h2 className="text-xl font-bold text-green-800">Import erfolgreich</h2>
              <p className="text-green-700 text-sm mt-1">
                Die Buchhaltungsdaten für <strong>{MONTHS[savedMonth.month - 1]} {savedMonth.year}</strong> wurden gespeichert.
              </p>
              {parseResult && parseResult.unresolvedCount > 0 && (
                <p className="text-amber-700 text-xs mt-2">
                  {parseResult.unresolvedCount} Konto(s) konnten nicht zugeordnet werden.
                  Bitte im Kontenplan ergänzen und danach neu importieren.
                </p>
              )}
            </div>
            <div className="flex justify-center gap-3 pt-2 flex-wrap">
              <Button variant="outline" onClick={() => {
                setStep('upload');
                setFileName('');
                setParseResult(null);
                setWarnings([]);
                setSavedMonth(null);
              }}>
                Weiterer Import
              </Button>
              <Button onClick={() => navigate('/erfolgsrechnung')}>
                Zur Erfolgsrechnung
              </Button>
              <Button variant="outline" onClick={() => navigate('/reporting')}>
                Zum Reporting
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

        </TabsContent>
      </Tabs>
    </div>
  );
}
