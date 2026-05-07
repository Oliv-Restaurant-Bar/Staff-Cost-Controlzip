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

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Upload, CheckCircle2, AlertTriangle, XCircle, FileText,
  ChevronRight, ChevronLeft, Save, Info, FileType, FileSpreadsheet,
  Loader2, ShoppingCart, Plus, BookOpen,
} from 'lucide-react';
import { GastronoviImportSection } from '@/components/GastronoviImportSection';
import { cn } from '@/lib/utils';
import {
  processCSV, matchCSVRows, buildMonthRecord,
  CSVParseResult, MatchedCSVRow, ImportConfig,
} from '@/lib/csv-import-engine';
import { parsePDF, parseSageKontoblattExcel } from '@/lib/pdf-import-engine';
import {
  saveMappingCustom, PL_CATEGORIES, getCategoryLabel, getSectionLabel,
} from '@/lib/account-mapping-store';
import { PLCategory, DepartmentHint } from '@/types/account-mapping';
import { saveMonth, saveJournalEntries, syncJournalYearFromDB, STORAGE_KEY as REPORTING_STORAGE_KEY } from '@/lib/reporting-store';
import { useTenant } from '@/contexts/TenantContext';
import { toast } from 'sonner';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

type Step = 'upload' | 'preview' | 'done';
type FileKind = 'csv' | 'pdf' | 'excel';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function formatAmount(n: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 2,
  }).format(n);
}

function statusBadge(status: MatchedCSVRow['status']) {
  if (status === 'exact') return (
    <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">Exakt</Badge>
  );
  if (status === 'range') return (
    <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-[10px]">Bereich</Badge>
  );
  return <Badge className="bg-red-100 text-red-800 border-red-200 text-[10px]">Unbekannt</Badge>;
}

function fileKindBadge(kind: FileKind) {
  if (kind === 'pdf') return (
    <Badge className="bg-orange-100 text-orange-800 border-orange-200 text-[10px]">PDF</Badge>
  );
  if (kind === 'excel') return (
    <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">Excel</Badge>
  );
  return (
    <Badge className="bg-sky-100 text-sky-800 border-sky-200 text-[10px]">CSV</Badge>
  );
}

// ─── P&L-Abschnitte für Dropdown ─────────────────────────────────────────────

const PL_SECTIONS_ORDER = [
  'net_revenue', 'cogs', 'personnel', 'operating_expenses', 'finance_section',
] as const;

const PL_SECTION_LABELS: Record<string, string> = {
  net_revenue:        'Umsatz',
  cogs:               'Warenaufwand',
  personnel:          'Personal',
  operating_expenses: 'Betriebskosten',
  finance_section:    'Finanzaufwand',
};

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
    const kind: FileKind =
      ext === 'pdf'  ? 'pdf'  :
      (ext === 'xlsx' || ext === 'xls') ? 'excel' : 'csv';
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
        <FileSpreadsheet className="h-9 w-9 text-green-500" />
      </div>
      <p className="font-medium text-sm">CSV, PDF oder Excel hier ablegen oder klicken</p>
      <p className="text-xs text-muted-foreground mt-1">
        CSV: Banana, AbaNinja, Bexio, Sage 50, Excel-Export
      </p>
      <p className="text-xs text-muted-foreground">
        PDF / Excel: Sage Kontoblatt-Export (empfohlen: Excel)
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,.pdf,application/pdf,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
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
  selectedIndices: Set<number>;
  onToggle: (index: number) => void;
  onToggleAll: (selectAll: boolean) => void;
}

function PreviewTable({ rows, emptyLabel, selectedIndices, onToggle, onToggleAll }: PreviewTableProps) {
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-sm">{emptyLabel}</div>
    );
  }
  const allSelected = selectedIndices.size === rows.length;
  const someSelected = selectedIndices.size > 0 && !allSelected;
  return (
    <div className="overflow-auto max-h-96">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                data-state={someSelected ? 'indeterminate' : undefined}
                onCheckedChange={(v) => onToggleAll(!!v)}
                aria-label="Alle auswählen"
              />
            </TableHead>
            <TableHead className="w-20 text-xs">Konto</TableHead>
            <TableHead className="text-xs">Bezeichnung</TableHead>
            <TableHead className="text-right text-xs">Betrag CHF</TableHead>
            <TableHead className="text-xs">P&L-Kategorie</TableHead>
            <TableHead className="text-xs">Abschnitt</TableHead>
            <TableHead className="w-24 text-xs">Treffer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => {
            const checked = selectedIndices.has(i);
            return (
              <TableRow
                key={i}
                className={cn(
                  row.status === 'unresolved' ? 'bg-red-50/50' : '',
                  !checked ? 'opacity-40' : '',
                )}
              >
                <TableCell>
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => onToggle(i)}
                    aria-label={`Zeile ${i + 1} auswählen`}
                  />
                </TableCell>
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
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── P&L-Kategorie-Dropdown (wiederverwendet) ─────────────────────────────────

function PLCategorySelect({
  value,
  onChange,
  className,
}: {
  value: PLCategory | '';
  onChange: (v: PLCategory) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={v => onChange(v as PLCategory)}>
      <SelectTrigger className={cn('h-8 text-xs', className)}>
        <SelectValue placeholder="Kategorie wählen…" />
      </SelectTrigger>
      <SelectContent>
        {PL_SECTIONS_ORDER.map(section => {
          const cats = PL_CATEGORIES.filter(c => c.section === section && c.id !== 'unmapped');
          if (cats.length === 0) return null;
          return (
            <div key={section}>
              <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/40">
                {PL_SECTION_LABELS[section] ?? section}
              </div>
              {cats.map(cat => (
                <SelectItem key={cat.id} value={cat.id} className="text-xs">
                  {cat.label}
                </SelectItem>
              ))}
            </div>
          );
        })}
      </SelectContent>
    </Select>
  );
}

// ─── Nicht-zugeordnet-Tabelle mit Inline-Zuweisung ────────────────────────────

interface UnresolvedTableProps {
  rows: MatchedCSVRow[];
  onAssign: (accountNumber: string, accountName: string, plCategory: PLCategory, department?: DepartmentHint) => void;
}

function UnresolvedTable({ rows, onAssign }: UnresolvedTableProps) {
  const [selections, setSelections] = useState<Record<string, PLCategory | ''>>({});

  // Dialog-State für «Neues Konto erstellen»
  const [dialogOpen, setDialogOpen]       = useState(false);
  const [dialogRow, setDialogRow]         = useState<MatchedCSVRow | null>(null);
  const [newName, setNewName]             = useState('');
  const [newCategory, setNewCategory]     = useState<PLCategory | ''>('');
  const [newDept, setNewDept]             = useState<DepartmentHint>('general');

  function openCreateDialog(row: MatchedCSVRow) {
    setDialogRow(row);
    setNewName(row.parsed.accountName);
    setNewCategory('');
    setNewDept('general');
    setDialogOpen(true);
  }

  function handleDialogSave() {
    if (!dialogRow || !newCategory) return;
    onAssign(dialogRow.parsed.accountNumber, newName.trim() || dialogRow.parsed.accountName, newCategory, newDept);
    setDialogOpen(false);
  }

  if (rows.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground text-sm flex flex-col items-center gap-3">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
        <p className="font-medium text-green-700">Alle Konten wurden zugeordnet</p>
        <p className="text-xs">Der Import kann jetzt gestartet werden.</p>
      </div>
    );
  }

  const plural = rows.length === 1;

  return (
    <>
      {/* Banner */}
      <div className="px-4 pt-3 pb-1">
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 py-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-sm">
            <strong>
              {rows.length} {plural ? 'Konto benötigt' : 'Konten benötigen'} vor dem Import eine Zuordnung.
            </strong>{' '}
            Weisen Sie pro Konto eine P&L-Kategorie zu und klicken Sie auf{' '}
            <em>Speichern</em>. Unbekannte Konten können auch direkt im Kontenplan neu angelegt werden.
          </AlertDescription>
        </Alert>
      </div>

      <div className="overflow-auto max-h-[520px]">
        <Table>
          <TableHeader>
            <TableRow className="bg-amber-50/80 border-b border-amber-200">
              <TableHead className="w-[110px] text-xs py-2">Konto</TableHead>
              <TableHead className="text-xs py-2">Bezeichnung</TableHead>
              <TableHead className="text-right w-32 text-xs py-2">Betrag CHF</TableHead>
              <TableHead className="min-w-[190px] text-xs py-2">P&L-Kategorie</TableHead>
              <TableHead className="w-[170px] text-xs py-2">Aktion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => {
              const key      = row.parsed.accountNumber;
              const selected = selections[key] ?? '';
              return (
                <TableRow
                  key={i}
                  className="border-l-[3px] border-l-amber-400 hover:bg-amber-50/40 transition-colors"
                >
                  {/* Konto */}
                  <TableCell className="py-2">
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[11px] font-bold text-amber-900 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded w-fit">
                        {key}
                      </span>
                      <Badge className="bg-amber-100 text-amber-700 border-amber-300 text-[9px] w-fit px-1.5 py-0 leading-4">
                        Ausstehend
                      </Badge>
                    </div>
                  </TableCell>

                  {/* Bezeichnung */}
                  <TableCell className="text-sm font-medium py-2">
                    {row.parsed.accountName}
                  </TableCell>

                  {/* Betrag */}
                  <TableCell className="text-right font-mono text-sm font-semibold py-2">
                    <span className={row.parsed.amount < 0 ? 'text-red-600' : ''}>
                      {formatAmount(row.parsed.amount)}
                    </span>
                  </TableCell>

                  {/* Kategorie-Dropdown */}
                  <TableCell className="py-2">
                    <PLCategorySelect
                      value={selected}
                      onChange={v => setSelections(prev => ({ ...prev, [key]: v }))}
                      className="border-amber-200 focus:border-amber-400 w-full"
                    />
                  </TableCell>

                  {/* Aktionen */}
                  <TableCell className="py-2">
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        className="h-8 text-xs flex-1 gap-1"
                        disabled={!selected}
                        onClick={() => {
                          if (!selected) return;
                          onAssign(key, row.parsed.accountName, selected as PLCategory);
                          setSelections(prev => {
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          });
                        }}
                      >
                        <Save className="h-3 w-3" />
                        Speichern
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs px-2.5 border-amber-300 hover:bg-amber-50 hover:text-amber-800 shrink-0"
                        onClick={() => openCreateDialog(row)}
                        title="Neues Konto im Kontenplan erstellen"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* ── Dialog: Neues Konto erstellen ── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-primary" />
              Neues Konto erstellen
            </DialogTitle>
          </DialogHeader>

          {dialogRow && (
            <div className="space-y-4 py-1">
              {/* Kontonummer (read-only) */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-3">
                <span className="text-xs text-muted-foreground shrink-0">Kontonummer</span>
                <span className="font-mono font-bold text-amber-900 text-base">
                  {dialogRow.parsed.accountNumber}
                </span>
              </div>

              {/* Kontobezeichnung */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Kontobezeichnung
                </label>
                <Input
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="h-9 text-sm"
                  placeholder="z.B. Speiseumsatz Restaurant"
                />
              </div>

              {/* P&L-Kategorie */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  P&L-Kategorie *
                </label>
                <PLCategorySelect
                  value={newCategory}
                  onChange={setNewCategory}
                  className="h-9 text-sm w-full"
                />
              </div>

              {/* Abteilung */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Abteilung
                </label>
                <Select
                  value={newDept ?? 'general'}
                  onValueChange={v => setNewDept(v as DepartmentHint)}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">Allgemein</SelectItem>
                    <SelectItem value="kitchen">Küche</SelectItem>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="admin">Verwaltung</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Alert className="py-2 text-xs border-blue-200 bg-blue-50">
                <Info className="h-3.5 w-3.5 text-blue-500" />
                <AlertDescription className="text-blue-800">
                  Das Konto wird dauerhaft im Kontenplan gespeichert und bei zukünftigen Importen automatisch erkannt.
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              Abbrechen
            </Button>
            <Button
              size="sm"
              disabled={!newCategory || !newName.trim()}
              onClick={handleDialogSave}
              className="gap-1.5"
            >
              <Save className="h-3.5 w-3.5" />
              Konto erstellen &amp; zuordnen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Haupt-Komponente ─────────────────────────────────────────────────────────

export default function CSVImportPage() {
  const { tenantKey } = useTenant();
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
  const [selectedMatchedIndices, setSelectedMatchedIndices] = useState<Set<number>>(new Set());

  // Beim Seitenaufruf: Sage Journal aus Supabase laden (auto-migration)
  useEffect(() => {
    syncJournalYearFromDB(year);
  }, [year]);

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
      setParsing(true);
      try {
        const pdfResult = await parsePDF(buffer);
        const matchResult = matchCSVRows(pdfResult.rows);
        matchResult.warnings.push(...pdfResult.warnings);

        setParseResult(matchResult);
        setWarnings(matchResult.warnings);
        setSelectedMatchedIndices(new Set(matchResult.matched.map((_, i) => i)));

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
    } else if (kind === 'excel') {
      setParsing(true);
      try {
        const excelResult = await parseSageKontoblattExcel(buffer);
        const matchResult = matchCSVRows(excelResult.rows);
        matchResult.warnings.push(...excelResult.warnings);
        matchResult.journalEntries = excelResult.journalEntries;

        setParseResult(matchResult);
        setWarnings(matchResult.warnings);
        setSelectedMatchedIndices(new Set(matchResult.matched.map((_, i) => i)));

        if (excelResult.detectedYear) setYear(excelResult.detectedYear);
        if (excelResult.detectedMonth) setMonth(excelResult.detectedMonth);

        if (excelResult.detectedMonth || excelResult.detectedYear) {
          toast.info(
            `Zeitraum erkannt: ${excelResult.detectedMonth ? MONTHS[excelResult.detectedMonth - 1] : ''} ${excelResult.detectedYear ?? ''}`.trim(),
          );
        }
      } catch (e) {
        setWarnings([`Excel-Verarbeitung fehlgeschlagen: ${String(e)}`]);
      } finally {
        setParsing(false);
      }
    } else {
      const text = new TextDecoder('utf-8').decode(buffer);
      const { parseResult: result, warnings: w } = processCSV(text);
      setParseResult(result);
      setWarnings(w);
      setSelectedMatchedIndices(new Set(result.matched.map((_, i) => i)));
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

  // ─── Inline-Kontozuweisung ────────────────────────────────────────────────

  function handleAssignAccount(
    accountNumber: string,
    accountName: string,
    plCategory: PLCategory,
    department?: DepartmentHint,
  ) {
    if (!parseResult) return;

    const catDef   = PL_CATEGORIES.find(c => c.id === plCategory);
    const plSection = catDef?.section ?? 'operating_expenses';
    const sign      = catDef?.sign    ?? 'expense';
    const dept: DepartmentHint = department ?? (
      plSection === 'net_revenue' ? 'general'
      : plSection === 'cogs'      ? 'kitchen'
      : plSection === 'personnel' ? 'general'
      : 'general'
    );

    saveMappingCustom({
      accountNumber,
      accountName,
      plCategory,
      plSection,
      department: dept,
      sign,
      canOverride: true,
      isActive:    true,
      source:      'custom',
    });

    const allParsed = [...parseResult.matched, ...parseResult.unresolved].map(r => r.parsed);
    const newResult = matchCSVRows(allParsed);
    setParseResult(newResult);
    setSelectedMatchedIndices(new Set(newResult.matched.map((_, i) => i)));

    toast.success(
      `Konto ${accountNumber} «${accountName}» → ${getCategoryLabel(plCategory)} gespeichert`,
    );
  }

  // ─── Zeilen-Selektion ─────────────────────────────────────────────────────

  function toggleMatchedRow(index: number) {
    setSelectedMatchedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAllMatchedRows(selectAll: boolean) {
    if (!parseResult) return;
    if (selectAll) {
      setSelectedMatchedIndices(new Set(parseResult.matched.map((_, i) => i)));
    } else {
      setSelectedMatchedIndices(new Set());
    }
  }

  // ─── Speichern ────────────────────────────────────────────────────────────

  function handleSave() {
    if (!parseResult) return;
    setLoading(true);

    const selectedMatched = parseResult.matched.filter((_, i) => selectedMatchedIndices.has(i));
    const config: ImportConfig = { year, month, dataType, mode: importMode, fileName };
    const record = buildMonthRecord(selectedMatched, parseResult.unresolved, config);

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
        tenantKey(REPORTING_STORAGE_KEY),
      );

      if (parseResult.journalEntries && parseResult.journalEntries.length > 0 && dataType === 'actual') {
        saveJournalEntries(year, month, parseResult.journalEntries, importMode);
      }

      setSavedMonth({ year, month });
      setStep('done');
      const jeCount = parseResult.journalEntries?.length ?? 0;
      const jeMsg = jeCount > 0 ? `, ${jeCount} Buchungszeilen` : '';
      toast.success(`Daten für ${MONTHS[month - 1]} ${year} wurden gespeichert${jeMsg}`);
    } catch (e) {
      toast.error('Fehler beim Speichern – bitte erneut versuchen');
    } finally {
      setLoading(false);
    }
  }

  // ─── Hilfswerte ───────────────────────────────────────────────────────────

  const selectedMatched = useMemo(
    () => parseResult ? parseResult.matched.filter((_, i) => selectedMatchedIndices.has(i)) : [],
    [parseResult, selectedMatchedIndices],
  );

  const revenueTotal = selectedMatched.filter(r => r.sign === 'income').reduce((s, r) => s + r.parsed.amount, 0);
  const expenseTotal = selectedMatched.filter(r => r.sign !== 'income').reduce((s, r) => s + r.parsed.amount, 0);

  const hasUnresolved   = (parseResult?.unresolvedCount ?? 0) > 0;
  const unresolvedCount = parseResult?.unresolvedCount ?? 0;

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
          <div className="flex items-center gap-2 text-sm mb-6">
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
                    {s === 'upload' ? '1. Datei & Einstellungen' : s === 'preview' ? '2. Vorschau & Zuordnung' : '3. Fertig'}
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

          {/* ── SCHRITT 2: Vorschau & Zuordnung ── */}
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
                <Card className={cn('border', hasUnresolved ? 'bg-amber-50 border-amber-300' : 'bg-muted/30')}>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">Ausstehend</p>
                    <p className={cn('text-2xl font-bold', hasUnresolved ? 'text-amber-700' : '')}>
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

              {/* Haupttabelle mit Tabs */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>Buchungszeilen</span>
                    {hasUnresolved && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-300 gap-1 font-normal">
                        <AlertTriangle className="h-3 w-3" />
                        {unresolvedCount} {unresolvedCount === 1 ? 'Konto' : 'Konten'} ausstehend
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Tabs defaultValue={hasUnresolved ? 'unresolved' : 'matched'}>
                    <TabsList className="mx-4 mt-2">
                      <TabsTrigger value="matched">
                        Zugeordnet ({selectedMatchedIndices.size}/{parseResult.matchedCount})
                      </TabsTrigger>
                      <TabsTrigger
                        value="unresolved"
                        className={cn(
                          hasUnresolved
                            ? 'text-amber-700 data-[state=active]:text-amber-800 data-[state=active]:bg-amber-50'
                            : '',
                        )}
                      >
                        {hasUnresolved && <AlertTriangle className="h-3.5 w-3.5 mr-1.5 text-amber-500" />}
                        Ausstehend ({parseResult.unresolvedCount})
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="matched" className="mt-0">
                      <PreviewTable
                        rows={parseResult.matched}
                        emptyLabel="Keine zugeordneten Zeilen"
                        selectedIndices={selectedMatchedIndices}
                        onToggle={toggleMatchedRow}
                        onToggleAll={toggleAllMatchedRows}
                      />
                    </TabsContent>

                    <TabsContent value="unresolved" className="mt-0">
                      <UnresolvedTable
                        rows={parseResult.unresolved}
                        onAssign={handleAssignAccount}
                      />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              <Separator />

              {/* Aktions-Zeile */}
              <div className="flex items-center justify-between gap-4">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Zurück
                </Button>

                <div className="flex items-center gap-4">
                  {hasUnresolved && (
                    <p className="text-sm text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {unresolvedCount} {unresolvedCount === 1 ? 'Konto muss' : 'Konten müssen'} noch zugeordnet werden
                    </p>
                  )}
                  <Button
                    onClick={handleSave}
                    disabled={loading || hasUnresolved}
                    size="lg"
                    className="min-w-44"
                    title={hasUnresolved ? 'Bitte zuerst alle Konten zuordnen' : ''}
                  >
                    {loading
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Speichern…</>
                      : <><Save className="h-4 w-4 mr-2" /> Jetzt importieren</>
                    }
                  </Button>
                </div>
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
