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

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
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
  Loader2, ShoppingCart, Plus, BookOpen, Scissors, ChevronDown, Eye,
} from 'lucide-react';
import { GastronoviImportSection } from '@/components/GastronoviImportSection';
import { cn } from '@/lib/utils';
import {
  processCSV, matchCSVRows, buildMonthRecord, buildExpenseCategoriesOnly,
  CSVParseResult, MatchedCSVRow, ParsedCSVRow, ImportConfig,
  PL_CATEGORY_TO_ROW_ID,
} from '@/lib/csv-import-engine';
import { parsePDF, parseAnnualSageKontoblattByMonth } from '@/lib/pdf-import-engine';
import type { SageJournalEntry } from '@/types/reporting';
import { getLockStateStrict } from '@/lib/prior-year-lock';
import {
  saveMappingCustom, PL_CATEGORIES, getCategoryLabel, getSectionLabel,
} from '@/lib/account-mapping-store';
import { PLCategory, DepartmentHint } from '@/types/account-mapping';
import { saveMonth, saveJournalEntries, loadJournalEntries, loadYear, syncJournalYearFromDB, upsertCostMonths, STORAGE_KEY as REPORTING_STORAGE_KEY } from '@/lib/reporting-store';
import { recordImportRun } from '@/lib/import-undo-store';
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

// ─── Split-Dialog ─────────────────────────────────────────────────────────────

interface SplitEntry {
  plCategory: PLCategory | '';
  amount: string;
}

interface SplitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: MatchedCSVRow | null;
  onConfirm: (row: MatchedCSVRow, splits: Array<{ plCategory: PLCategory; amount: number }>) => void;
}

function SplitDialog({ open, onOpenChange, row, onConfirm }: SplitDialogProps) {
  const [entries, setEntries] = useState<SplitEntry[]>([
    { plCategory: '', amount: '' },
    { plCategory: '', amount: '' },
  ]);

  const totalAmount = row?.parsed.amount ?? 0;

  const splitTotal = entries.reduce((s, e) => {
    const n = parseFloat(e.amount.replace(',', '.'));
    return s + (isNaN(n) ? 0 : n);
  }, 0);

  const diff = Math.abs(splitTotal - totalAmount);
  const isValid =
    entries.length >= 2 &&
    entries.every(e => e.plCategory !== '' && e.amount !== '' && !isNaN(parseFloat(e.amount.replace(',', '.')))) &&
    diff < 0.01;

  // Einträge zurücksetzen wenn Dialog geöffnet wird
  const prevOpen = useRef(false);
  if (open && !prevOpen.current) {
    prevOpen.current = true;
    setTimeout(() => setEntries([{ plCategory: '', amount: '' }, { plCategory: '', amount: '' }]), 0);
  }
  if (!open && prevOpen.current) {
    prevOpen.current = false;
  }

  function handleConfirm() {
    if (!row || !isValid) return;
    const splits = entries.map(e => ({
      plCategory: e.plCategory as PLCategory,
      amount: parseFloat(e.amount.replace(',', '.')),
    }));
    onConfirm(row, splits);
    onOpenChange(false);
    setEntries([{ plCategory: '', amount: '' }, { plCategory: '', amount: '' }]);
  }

  function updateEntry(i: number, patch: Partial<SplitEntry>) {
    setEntries(prev => prev.map((e, j) => j === i ? { ...e, ...patch } : e));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Scissors className="h-5 w-5 text-primary" />
            Betrag aufteilen
          </DialogTitle>
        </DialogHeader>

        {row && (
          <div className="space-y-4 py-1">
            {/* Konto-Info */}
            <div className="bg-muted/50 rounded-lg px-4 py-3 space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Konto</span>
                <span className="font-mono font-bold">{row.parsed.accountNumber}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Bezeichnung</span>
                <span className="truncate ml-4 text-right max-w-[260px]">{row.parsed.accountName}</span>
              </div>
              <div className="flex items-center justify-between border-t border-muted/60 pt-1.5 mt-1">
                <span className="text-xs text-muted-foreground">Gesamtbetrag</span>
                <span className="font-mono font-semibold">{formatAmount(totalAmount)}</span>
              </div>
            </div>

            {/* Split-Zeilen */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Aufteilung
              </label>
              {entries.map((entry, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <span className="text-xs text-muted-foreground w-5 shrink-0 text-right">{i + 1}.</span>
                  <PLCategorySelect
                    value={entry.plCategory}
                    onChange={v => updateEntry(i, { plCategory: v })}
                    className="flex-1 h-8"
                  />
                  <Input
                    className="w-28 h-8 text-sm font-mono text-right"
                    placeholder="0.00"
                    value={entry.amount}
                    onChange={e => updateEntry(i, { amount: e.target.value })}
                  />
                  {entries.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => setEntries(prev => prev.filter((_, j) => j !== i))}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 text-xs gap-1.5"
              onClick={() => setEntries(prev => [...prev, { plCategory: '', amount: '' }])}
            >
              <Plus className="h-3.5 w-3.5" />
              Weitere Zeile hinzufügen
            </Button>

            {/* Summen-Anzeige */}
            <div className={cn(
              'flex items-center justify-between px-3 py-2 rounded-lg text-sm border',
              diff < 0.01
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-amber-50 border-amber-200 text-amber-800',
            )}>
              <span className="text-xs font-medium">Summe der Teile</span>
              <div className="text-right">
                <span className="font-mono font-semibold">{formatAmount(splitTotal)}</span>
                {diff >= 0.01 && (
                  <span className="ml-2 text-xs font-normal opacity-80">
                    Differenz: {formatAmount(diff)}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            size="sm"
            disabled={!isValid}
            onClick={handleConfirm}
            className="gap-1.5"
          >
            <Scissors className="h-3.5 w-3.5" />
            Aufteilen & zuordnen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Nicht-zugeordnet-Tabelle mit Inline-Zuweisung ────────────────────────────

interface UnresolvedTableProps {
  rows: MatchedCSVRow[];
  onAssign: (accountNumber: string, accountName: string, plCategory: PLCategory, department?: DepartmentHint) => void;
  onSplit: (row: MatchedCSVRow) => void;
}

function UnresolvedTable({ rows, onAssign, onSplit }: UnresolvedTableProps) {
  const [selections, setSelections] = useState<Record<string, PLCategory | ''>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  function toggleExpanded(key: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

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
              <TableHead className="w-[210px] text-xs py-2">Aktion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => {
              const key      = row.parsed.accountNumber;
              const selected = selections[key] ?? '';
              const expanded = expandedRows.has(key);
              return (
                <React.Fragment key={i}>
                  <TableRow
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
                      <div>
                        {row.parsed.accountName}
                        <button
                          className="ml-1.5 text-muted-foreground hover:text-foreground transition-colors align-middle"
                          onClick={() => toggleExpanded(key)}
                          title="Originalzeile anzeigen"
                        >
                          <ChevronDown className={cn('h-3.5 w-3.5 inline transition-transform', expanded && 'rotate-180')} />
                        </button>
                      </div>
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
                      <div className="flex gap-1 flex-wrap">
                        <Button
                          size="sm"
                          className="h-8 text-xs gap-1"
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
                          className="h-8 text-xs px-2 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800 shrink-0 gap-1"
                          onClick={() => onSplit(row)}
                          title="Betrag auf mehrere P&L-Kategorien aufteilen"
                        >
                          <Scissors className="h-3 w-3" />
                          Split
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs px-2 border-amber-300 hover:bg-amber-50 hover:text-amber-800 shrink-0"
                          onClick={() => openCreateDialog(row)}
                          title="Neues Konto im Kontenplan erstellen"
                        >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>

                {/* Expandierbare Detailzeile: Originalzeile aus PDF/CSV */}
                {expanded && (
                  <TableRow key={`${i}-detail`} className="bg-slate-50/70 border-l-[3px] border-l-amber-300">
                    <TableCell colSpan={5} className="py-2 px-4">
                      <div className="flex items-start gap-2">
                        <Eye className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400" />
                        <div className="space-y-0.5">
                          <p className="font-medium text-[10px] uppercase tracking-wide text-slate-500">
                            Originalzeile aus Datei
                          </p>
                          <p className="font-mono text-[11px] text-slate-700 break-all leading-relaxed">
                            {row.parsed.rawLine || '—'}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
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
  const { tenantId, tenant, tenantKey } = useTenant();
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

  // ── Mehrmonats-Import (Jahres-/Perioden-Kontoblatt, Excel oder PDF) ─────────
  interface MultiParse {
    year: number;
    rowsByMonth: Map<number, ParsedCSVRow[]>;
    journalByMonth: Map<number, SageJournalEntry[]>;
  }
  const [multiParse, setMultiParse] = useState<MultiParse | null>(null);
  /** Bump nach jeder Konto-Zuordnung → Vorschau-Matching neu berechnen */
  const [mappingVersion, setMappingVersion] = useState(0);
  const [savedMultiInfo, setSavedMultiInfo] = useState<string | null>(null);

  // ── Split-State ──────────────────────────────────────────────────────────────
  const [splitMatchedRows, setSplitMatchedRows] = useState<MatchedCSVRow[]>([]);
  const [splitExcluded, setSplitExcluded]       = useState<Set<string>>(new Set());
  const [splitDialogOpen, setSplitDialogOpen]   = useState(false);
  const [splitDialogRow, setSplitDialogRow]     = useState<MatchedCSVRow | null>(null);

  // Beim Seitenaufruf: Sage Journal aus Supabase laden (auto-migration)
  useEffect(() => {
    syncJournalYearFromDB(year, tenantId);
  }, [year, tenantId]);

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
    setMultiParse(null);

    if (kind === 'pdf') {
      setParsing(true);
      try {
        const pdfResult = await parsePDF(buffer);

        // MANDANTEN-CHECK: Firmenname im Kontoblatt-Kopf muss zum aktiven
        // Mandanten passen — sonst STOPP (verhindert Import in den falschen Betrieb).
        if (pdfResult.detectedTenant && pdfResult.detectedTenant !== tenantId) {
          const firma = pdfResult.detectedCompany ?? pdfResult.detectedTenant;
          setWarnings([
            `Falscher Mandant: Das PDF stammt von «${firma}», aktiv ist aber «${tenant.name}». ` +
            'Bitte oben den passenden Betrieb wählen und die Datei erneut hochladen.',
          ]);
          toast.error(`Falscher Mandant: PDF gehört zu «${firma}»`);
          setParsing(false);
          return;
        }
        if (pdfResult.detectedCompany) {
          toast.info(`Erkannt: ${pdfResult.detectedCompany}`);
        }

        const matchResult = matchCSVRows(pdfResult.rows);
        matchResult.warnings.push(...pdfResult.warnings);
        matchResult.journalEntries = pdfResult.journalEntries;

        setParseResult(matchResult);
        setWarnings(matchResult.warnings);
        setSelectedMatchedIndices(new Set(matchResult.matched.map((_, i) => i)));

        if (pdfResult.detectedYear) setYear(pdfResult.detectedYear);
        if (pdfResult.detectedMonth) setMonth(pdfResult.detectedMonth);

        // Mehrmonats-PDF (Kopf-Zeitraum über Monatsgrenzen): pro Monat speichern.
        // Routing nach Journal-Monaten (nicht nur Netto≠0-Monaten), damit auch
        // Monate mit 0-Netto ersetzt werden.
        if (pdfResult.monthly && (pdfResult.monthly.journalByMonth.size > 1 || pdfResult.monthly.rowsByMonth.size > 1)) {
          setMultiParse({
            year: pdfResult.monthly.year,
            rowsByMonth: pdfResult.monthly.rowsByMonth,
            journalByMonth: pdfResult.monthly.journalByMonth,
          });
          setYear(pdfResult.monthly.year);
          toast.info(`Mehrmonats-Kontoblatt erkannt: ${pdfResult.monthly.rowsByMonth.size} Monate (${pdfResult.monthly.year}) — Import erfolgt pro Monat.`);
        } else if (pdfResult.detectedMonth || pdfResult.detectedYear) {
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
        // EIN Parser für Monats- UND Jahres-Excel: Buchungszeilen werden nach
        // Buchungsdatum den Monaten zugeordnet (Netto = Soll − Haben pro Konto).
        const excelResult = await parseAnnualSageKontoblattByMonth(buffer);

        // MANDANTEN-CHECK (wie beim PDF): Firma im Kopf muss zum aktiven Mandanten passen.
        if (excelResult.detectedTenant && excelResult.detectedTenant !== tenantId) {
          const firma = excelResult.detectedCompany ?? excelResult.detectedTenant;
          setWarnings([
            `Falscher Mandant: Die Datei stammt von «${firma}», aktiv ist aber «${tenant.name}». ` +
            'Bitte oben den passenden Betrieb wählen und die Datei erneut hochladen.',
          ]);
          toast.error(`Falscher Mandant: Datei gehört zu «${firma}»`);
          return;
        }
        if (excelResult.detectedCompany) toast.info(`Erkannt: ${excelResult.detectedCompany}`);

        if (excelResult.failureReason) {
          setWarnings([excelResult.failureReason]);
          return;
        }

        if (excelResult.detectedYear) setYear(excelResult.detectedYear);

        if (excelResult.byMonth.size > 1) {
          // Mehrmonats-/Jahresdatei → Import pro Monat
          setMultiParse({
            year: excelResult.detectedYear!,
            rowsByMonth: excelResult.byMonth,
            journalByMonth: excelResult.journalByMonth,
          });
          setWarnings(excelResult.warnings);
          toast.info(`Mehrmonats-Kontoblatt erkannt: ${excelResult.byMonth.size} Monate (${excelResult.detectedYear}) — Import erfolgt pro Monat.`);
        } else {
          // Einzelmonat → bestehender Wizard-Fluss
          const onlyMonth = excelResult.byMonth.keys().next().value as number | undefined;
          const rows = onlyMonth !== undefined ? (excelResult.byMonth.get(onlyMonth) ?? []) : [];
          const matchResult = matchCSVRows(rows);
          matchResult.warnings.push(...excelResult.warnings);
          matchResult.journalEntries = onlyMonth !== undefined
            ? (excelResult.journalByMonth.get(onlyMonth) ?? [])
            : [];

          setParseResult(matchResult);
          setWarnings(matchResult.warnings);
          setSelectedMatchedIndices(new Set(matchResult.matched.map((_, i) => i)));

          if (onlyMonth !== undefined) setMonth(onlyMonth);
          if (onlyMonth !== undefined || excelResult.detectedYear) {
            toast.info(
              `Zeitraum erkannt: ${onlyMonth !== undefined ? MONTHS[onlyMonth - 1] : ''} ${excelResult.detectedYear ?? ''}`.trim(),
            );
          }
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
    setSplitMatchedRows([]);
    setSplitExcluded(new Set());
    setMultiParse(null);
    setSavedMultiInfo(null);
  }

  // ─── Mehrmonats-Vorschau (Matching pro Monat, wie Import-Center-Jahresimport) ──

  const multiPreview = useMemo(() => {
    if (!multiParse) return null;
    const categoriesByMonth = new Map<number, import('@/types/reporting').ExpenseCategory[]>();
    const unmapped = new Map<string, { name: string; total: number }>();
    const monthTotals = new Map<number, { accounts: number; expense: number; income: number }>();
    let sumExpense = 0;
    let sumIncome = 0;

    // Bestehende Monatswerte (für den Diff «neu / aktualisiert / unverändert»):
    // Erkennung nach ZEITRAUM, nicht Dateiname — egal aus welcher Datei/Format
    // die vorhandenen Werte stammen.
    const existingByMonth = new Map<number, Map<string, number>>();
    try {
      for (const rec of loadYear(multiParse.year, tenantKey(REPORTING_STORAGE_KEY))) {
        const accMap = new Map<string, number>();
        for (const c of rec.expenseCategories ?? []) {
          if (/^\d{3,5}$/.test(c.categoryId)) accMap.set(c.categoryId, c.amount);
        }
        if (accMap.size > 0) existingByMonth.set(rec.month, accMap);
      }
    } catch { /* Vorschau-Diff ist informativ — Import bleibt möglich */ }

    // Diff pro (Konto × Monat)
    let cellsNew = 0, cellsUpdated = 0, cellsUnchanged = 0;
    const monthStatus = new Map<number, 'neu' | 'aktualisiert' | 'unverändert'>();

    for (const [m, rows] of multiParse.rowsByMonth.entries()) {
      const mr = matchCSVRows(rows);
      const cats = buildExpenseCategoriesOnly(mr.matched, mr.unresolved);
      categoriesByMonth.set(m, cats);

      const existing = existingByMonth.get(m);
      let mNew = 0, mUpd = 0, mUnch = 0;
      for (const c of cats) {
        const prev = existing?.get(c.categoryId);
        if (prev === undefined) mNew++;
        else if (Math.abs(prev - c.amount) > 0.005) mUpd++;
        else mUnch++;
      }
      // Konten, die es bisher gab, aber in der Datei fehlen → werden ersetzt (entfernt)
      if (existing) {
        const fileIds = new Set(cats.map(c => c.categoryId));
        for (const id of existing.keys()) if (!fileIds.has(id)) mUpd++;
      }
      cellsNew += mNew; cellsUpdated += mUpd; cellsUnchanged += mUnch;
      monthStatus.set(m, mUpd > 0 ? 'aktualisiert' : mNew > 0 ? 'neu' : 'unverändert');
      let expense = 0, income = 0;
      for (const r of mr.matched) {
        if (r.sign === 'income') { income += -r.parsed.amount; sumIncome += -r.parsed.amount; }
        else { expense += r.parsed.amount; sumExpense += r.parsed.amount; }
      }
      for (const u of mr.unresolved) {
        const prev = unmapped.get(u.parsed.accountNumber) ?? { name: u.parsed.accountName, total: 0 };
        unmapped.set(u.parsed.accountNumber, { name: prev.name, total: prev.total + u.parsed.amount });
      }
      monthTotals.set(m, { accounts: rows.length, expense, income });
    }
    // Nicht zugeordnete Konten als aggregierte Zeilen für die Zuordnungs-Tabelle
    const unresolvedRows: MatchedCSVRow[] = unmapped.size > 0
      ? matchCSVRows(
          [...unmapped.entries()].map(([acc, v], i) => ({
            lineIndex: i + 1,
            rawLine: `${acc} ${v.name} → ${v.total.toFixed(2)} (Jahressumme)`,
            accountNumber: acc,
            accountName: v.name,
            rawAmount: v.total.toFixed(2),
            amount: v.total,
          })),
        ).unresolved
      : [];
    return {
      categoriesByMonth, unmapped, unresolvedRows, monthTotals, sumExpense, sumIncome,
      cellsNew, cellsUpdated, cellsUnchanged, monthStatus,
    };
    // mappingVersion: nach jeder Konto-Zuordnung neu matchen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiParse, mappingVersion]);

  /** Konto-Zuordnung aus der Mehrmonats-Vorschau: Mapping speichern + neu matchen. */
  function handleAssignAccountMulti(
    accountNumber: string,
    accountName: string,
    plCategory: PLCategory,
    department?: DepartmentHint,
  ) {
    const catDef = PL_CATEGORIES.find(c => c.id === plCategory);
    saveMappingCustom({
      accountNumber,
      accountName,
      plCategory,
      plSection: catDef?.section ?? 'operating_expenses',
      department: department ?? 'general',
      sign: catDef?.sign ?? 'expense',
      canOverride: true,
      isActive: true,
      source: 'custom',
    });
    setMappingVersion(v => v + 1);
    toast.success(`Konto ${accountNumber} «${accountName}» → ${getCategoryLabel(plCategory)} gespeichert`);
  }

  /** Mehrmonats-Import speichern: Upsert je Konto+Monat + Journal pro Monat. */
  async function handleSaveMulti() {
    if (!multiParse || !multiPreview) return;
    if (multiPreview.unmapped.size > 0) {
      toast.error('Bitte zuerst alle Konten zuordnen.');
      return;
    }
    setLoading(true);
    const targetYear = multiParse.year;
    const storeKey = tenantKey(REPORTING_STORAGE_KEY);
    try {
      // JAHRES-SPERRE: frisch + fail-closed (wie Einzelmonats-Import)
      try {
        const lock = await getLockStateStrict(tenantId, targetYear);
        if (lock.locked) {
          toast.error(`Das Jahr ${targetYear} ist abgeschlossen und gesperrt. Import nicht möglich — Sperre zuerst im Import-Center aufheben.`);
          return;
        }
      } catch (err) {
        toast.error(`Jahres-Sperre konnte nicht geprüft werden — Import abgebrochen. (${err instanceof Error ? err.message : String(err)})`);
        return;
      }

      const months = [...multiParse.rowsByMonth.keys()].sort((a, b) => a - b);

      // Undo-Snapshot VOR dem Schreiben: expenseCategories + Journal aller Datei-Monate
      const undoMonths: Array<{ monthId: string; fields: Record<string, unknown | null> }> = [];
      const undoJournals: Array<{ year: number; month: number; entries: unknown[]; tenantId?: string }> = [];
      try {
        const existing = new Map(loadYear(targetYear, storeKey).map(r => [r.month, r]));
        for (const m of months) {
          const rec = existing.get(m);
          undoMonths.push({
            monthId: `${targetYear}-${String(m).padStart(2, '0')}`,
            fields: { expenseCategories: rec?.expenseCategories ? JSON.parse(JSON.stringify(rec.expenseCategories)) : null },
          });
          // Journal nur bei Ist-Daten (wie Einzelmonats-Import): VJ-Importe
          // dürfen das Lieferanten-Journal des Jahres nicht überschreiben.
          if (dataType === 'actual') {
            undoJournals.push({ year: targetYear, month: m, entries: loadJournalEntries(targetYear, m, tenantId), tenantId });
          }
        }
      } catch (err) {
        console.warn('[CSV-IMPORT] Undo-Snapshot (Mehrmonat) fehlgeschlagen (Import läuft weiter):', err);
      }

      // Upsert je Konto+Monat — unveränderte Monate: kein Write («unverändert»)
      const { monthsWritten, monthsUnchanged, kvBackup } = upsertCostMonths(
        targetYear,
        multiPreview.categoriesByMonth,
        {
          fileName,
          note: `${fileKind.toUpperCase()}-Mehrmonats-Import (${months.length} Monate)`,
          source: dataType === 'previous_year'
            ? (fileKind === 'pdf' ? 'pdf_previous_year' : 'csv_previous_year')
            : (fileKind === 'pdf' ? 'pdf_current' : 'csv_current'),
        },
        storeKey,
      );

      // Journal pro Monat ersetzen (Basis Lieferanten-FIBU-Abgleich) — nur bei
      // Ist-Daten und nur wenn geändert. VJ-Importe schreiben KEIN Journal.
      let journalMonths = 0;
      if (dataType === 'actual') {
        for (const m of months) {
          const entries = multiParse.journalByMonth.get(m) ?? [];
          const prior = loadJournalEntries(targetYear, m, tenantId);
          if (JSON.stringify(prior) === JSON.stringify(entries)) continue;
          saveJournalEntries(targetYear, m, entries, 'replace', tenantId);
          journalMonths++;
        }
      }

      // Import-Protokoll (Rückgängig) — best-effort
      void recordImportRun(tenantId, {
        source: dataType === 'previous_year' ? 'kosten-vorjahr-monat' : 'ist-kosten-buchhaltung',
        periodLabel: months.length === 12
          ? `Jahr ${targetYear}`
          : `${MONTHS[months[0] - 1]}–${MONTHS[months[months.length - 1] - 1]} ${targetYear}`,
        itemCount: months.length,
        itemLabel: 'Monate',
        fileName: fileName || undefined,
        details: `${monthsWritten} Monate geschrieben, ${monthsUnchanged} unverändert, Journal in ${journalMonths} Monat(en) ersetzt`,
        ...(undoMonths.length > 0 ? {
          snapshot: {
            kind: 'reporting-fields' as const,
            storeKey,
            months: undoMonths,
            ...(undoJournals.length > 0 ? { journals: undoJournals } : {}),
          },
        } : {}),
      }).catch(err => {
        console.error('[CSV-IMPORT] Import-Protokoll fehlgeschlagen:', err);
        toast.warning('Import-Protokoll konnte nicht gespeichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.');
      });

      const summary =
        `${monthsWritten} Monat(e) gespeichert` +
        (monthsUnchanged > 0 ? `, ${monthsUnchanged} unverändert (kein Write)` : '') +
        (journalMonths > 0 ? `, Journal in ${journalMonths} Monat(en) aktualisiert` : '');
      setSavedMultiInfo(`Jahr ${targetYear}: ${summary}`);
      setSavedMonth({ year: targetYear, month: months[0] });
      setStep('done');
      toast.success(`Import ${targetYear}: ${summary}`);

      const backup = await kvBackup;
      if (backup.failedMonths.length > 0) {
        toast.error(`Supabase-Backup unvollständig: ${backup.failedMonths.length} Monat(e) nicht gesichert — bitte Import-Center prüfen.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fehler beim Speichern – bitte erneut versuchen');
    } finally {
      setLoading(false);
    }
  }

  // ─── Split-Zuordnung ──────────────────────────────────────────────────────

  function openSplitDialog(row: MatchedCSVRow) {
    setSplitDialogRow(row);
    setSplitDialogOpen(true);
  }

  function handleSplit(
    originalRow: MatchedCSVRow,
    splits: Array<{ plCategory: PLCategory; amount: number }>,
  ) {
    const newRows: MatchedCSVRow[] = splits.map((split, i) => {
      const catDef = PL_CATEGORIES.find(c => c.id === split.plCategory);
      const synthetic: ParsedCSVRow = {
        lineIndex:     originalRow.parsed.lineIndex,
        rawLine:       `${originalRow.parsed.rawLine} [Split ${i + 1}/${splits.length}]`,
        accountNumber: `${originalRow.parsed.accountNumber}-${i + 1}`,
        accountName:   `${originalRow.parsed.accountName} – ${getCategoryLabel(split.plCategory)}`,
        rawAmount:     split.amount.toFixed(2),
        amount:        split.amount,
      };
      return {
        parsed:          synthetic,
        status:          'exact' as const,
        plCategory:      split.plCategory,
        plCategoryLabel: getCategoryLabel(split.plCategory),
        plSection:       catDef?.section ?? 'operating_expenses',
        plRowId:         PL_CATEGORY_TO_ROW_ID[split.plCategory] ?? null,
        sign:            (catDef?.sign ?? 'expense') as 'income' | 'expense',
        department:      'general',
        matchNote:       `Manuell aufgeteilt aus Konto ${originalRow.parsed.accountNumber}`,
      };
    });

    setSplitMatchedRows(prev => [...prev, ...newRows]);
    setSplitExcluded(prev => new Set([...prev, originalRow.parsed.accountNumber]));
    toast.success(
      `Konto ${originalRow.parsed.accountNumber} in ${splits.length} Teile aufgeteilt`,
    );
  }

  // ─── Vorschau ─────────────────────────────────────────────────────────────

  function goToPreview() {
    if (multiParse) {
      setStep('preview');
      return;
    }
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

  async function handleSave() {
    if (!parseResult) return;
    setLoading(true);

    // JAHRES-SPERRE: frisch prüfen (nie nur UI-State), FAIL-CLOSED — nur ein
    // erfolgreicher Read mit locked:false gibt den Import frei; abgeschlossene
    // Jahre dürfen durch keinen Import verändert werden.
    try {
      const lock = await getLockStateStrict(tenantId, year);
      if (lock.locked) {
        toast.error(`Das Jahr ${year} ist abgeschlossen und gesperrt. Import nicht möglich — Sperre zuerst im Import-Center aufheben.`);
        setLoading(false);
        return;
      }
    } catch (err) {
      toast.error(`Jahres-Sperre konnte nicht geprüft werden — Import abgebrochen. Bitte erneut versuchen. (${err instanceof Error ? err.message : String(err)})`);
      setLoading(false);
      return;
    }

    // Zeilen, die per Split aufgeteilt wurden, aus unresolved rausfiltern
    const remainingUnresolved = parseResult.unresolved.filter(
      r => !splitExcluded.has(r.parsed.accountNumber),
    );

    // Normale gematchte Zeilen + manuell aufgeteilte Split-Zeilen
    const baseMatched = parseResult.matched.filter((_, i) => selectedMatchedIndices.has(i));
    const allSelected = [...baseMatched, ...splitMatchedRows];

    const config: ImportConfig = { year, month, dataType, mode: importMode, fileName };
    const record = buildMonthRecord(allSelected, remainingUnresolved, config);

    try {
      const source: import('@/types/reporting').ImportSource =
        fileKind === 'pdf'
          ? (dataType === 'previous_year' ? 'pdf_previous_year' : 'pdf_current')
          : (dataType === 'previous_year' ? 'csv_previous_year' : 'csv_current');

      const splitNote = splitMatchedRows.length > 0
        ? `, ${splitExcluded.size} aufgeteilt (${splitMatchedRows.length} Teilzeilen)`
        : '';

      // Undo-Snapshot VOR dem Schreiben: kompletter bisheriger Monats-Record
      // (null = Monat existierte nicht) + bisheriges Journal bei Ist-Daten.
      const monthId = `${year}-${String(month).padStart(2, '0')}`;
      const storeKey = tenantKey(REPORTING_STORAGE_KEY);
      let priorRecord: import('@/types/reporting').MonthlyFinancialRecord | null = null;
      let priorJournal: import('@/types/reporting').SageJournalEntry[] | undefined;
      try {
        priorRecord = loadYear(year, storeKey).find(r => r.month === month) ?? null;
        priorRecord = priorRecord ? JSON.parse(JSON.stringify(priorRecord)) : null;
        if (dataType === 'actual') priorJournal = loadJournalEntries(year, month, tenantId);
      } catch (err) {
        console.warn('[CSV-IMPORT] Undo-Snapshot fehlgeschlagen (Import läuft weiter):', err);
      }

      saveMonth(
        { ...record, year, month },
        source,
        importMode,
        {
          fileName,
          note: `${fileKind.toUpperCase()}-Import: ${parseResult.matchedCount} zugeordnet, ${remainingUnresolved.length} unbekannt${splitNote}`,
        },
        tenantKey(REPORTING_STORAGE_KEY),
      );

      if (parseResult.journalEntries && parseResult.journalEntries.length > 0 && dataType === 'actual') {
        saveJournalEntries(year, month, parseResult.journalEntries, importMode, tenantId);
      }

      // Import-Protokoll (Import-Center «Letzter Import» + Rückgängig) — best-effort.
      void recordImportRun(tenantId, {
        source: dataType === 'previous_year' ? 'kosten-vorjahr-monat' : 'ist-kosten-buchhaltung',
        periodLabel: `${MONTHS[month - 1]} ${year}`,
        itemCount: allSelected.length,
        itemLabel: 'Positionen',
        fileName: fileName || undefined,
        details: `${parseResult.matchedCount} zugeordnet, ${remainingUnresolved.length} unbekannt${splitNote}`,
        snapshot: {
          kind: 'reporting-record',
          storeKey,
          monthId,
          record: priorRecord,
          ...(priorJournal !== undefined ? { journal: { year, month, entries: priorJournal, tenantId } } : {}),
        },
      }).catch(err => {
        console.error('[CSV-IMPORT] Import-Protokoll fehlgeschlagen:', err);
        toast.warning('Import-Protokoll konnte nicht gespeichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.');
      });

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

  // Unresolved-Zeilen ohne bereits aufgeteilte Konten
  const visibleUnresolved = useMemo(
    () => parseResult?.unresolved.filter(r => !splitExcluded.has(r.parsed.accountNumber)) ?? [],
    [parseResult, splitExcluded],
  );

  const selectedMatched = useMemo(
    () => parseResult ? parseResult.matched.filter((_, i) => selectedMatchedIndices.has(i)) : [],
    [parseResult, selectedMatchedIndices],
  );

  const revenueTotal = [...selectedMatched, ...splitMatchedRows]
    .filter(r => r.sign === 'income').reduce((s, r) => s + r.parsed.amount, 0);
  const expenseTotal = [...selectedMatched, ...splitMatchedRows]
    .filter(r => r.sign !== 'income').reduce((s, r) => s + r.parsed.amount, 0);

  const hasUnresolved   = visibleUnresolved.length > 0;
  const unresolvedCount = visibleUnresolved.length;

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

              {multiParse && (
                <Alert className="text-sm border-blue-200 bg-blue-50">
                  <Info className="h-4 w-4 text-blue-500" />
                  <AlertDescription className="text-blue-800">
                    <strong>Mehrmonats-Kontoblatt ({multiParse.year}):</strong> Die Datei umfasst{' '}
                    {multiParse.rowsByMonth.size} Monate. Der Import erfolgt automatisch pro Konto und Monat
                    (Netto = Soll − Haben nach Buchungsdatum) — die Monats-/Modus-Einstellungen oben entfallen.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={goToPreview}
                  disabled={parsing || (multiParse === null && (!parseResult || parseResult.totalRows === 0))}
                  size="lg"
                >
                  Vorschau anzeigen <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}

          {/* ── SCHRITT 2b: Mehrmonats-Vorschau (Konten × Monate) ── */}
          {step === 'preview' && multiParse && multiPreview && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="bg-muted/30">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">Jahr</p>
                    <p className="text-2xl font-bold">{multiParse.year}</p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">Monate mit Daten</p>
                    <p className="text-2xl font-bold">{multiParse.rowsByMonth.size}/12</p>
                  </CardContent>
                </Card>
                <Card className={cn('border', multiPreview.unmapped.size > 0 ? 'bg-amber-50 border-amber-300' : 'bg-green-50 border-green-200')}>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">Nicht zugeordnete Konten</p>
                    <p className={cn('text-2xl font-bold', multiPreview.unmapped.size > 0 ? 'text-amber-700' : 'text-green-700')}>
                      {multiPreview.unmapped.size}
                    </p>
                  </CardContent>
                </Card>
                <Card className="bg-muted/30">
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-muted-foreground">Aufwand / Ertrag</p>
                    <p className="text-sm font-bold leading-tight">
                      {formatAmount(multiPreview.sumExpense)}<br />
                      <span className="text-xs font-normal text-muted-foreground">{formatAmount(multiPreview.sumIncome)} Ertrag</span>
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Monatsübersicht (Upsert je Konto + Monat)</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <p className="text-xs text-muted-foreground mb-2">
                    Pro Monat werden die Konto-Werte (Netto = Soll − Haben) ersetzt — ein erneuter Import
                    desselben Zeitraums verdoppelt nichts. Buchungszeilen werden als Journal pro Monat
                    gespeichert (Basis für den Lieferanten-FIBU-Abgleich). Manuell erfasste Kategorien
                    und andere Monatsdaten bleiben unberührt.
                  </p>
                  {/* Diff gegen den Bestand: Erkennung nach Zeitraum, nicht Dateiname */}
                  <div className="flex flex-wrap gap-2 mb-3 text-xs">
                    <Badge className="bg-green-100 text-green-800 border-green-200 font-normal">
                      {multiPreview.cellsNew} Konto-Monate neu
                    </Badge>
                    <Badge className={cn('font-normal border', multiPreview.cellsUpdated > 0
                      ? 'bg-amber-100 text-amber-800 border-amber-300'
                      : 'bg-muted text-muted-foreground')}>
                      {multiPreview.cellsUpdated} aktualisiert (Wert ändert sich — wird überschrieben)
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {multiPreview.cellsUnchanged} unverändert
                    </Badge>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Monat</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Konten</TableHead>
                        <TableHead className="text-right">Aufwand (CHF)</TableHead>
                        <TableHead className="text-right">Ertrag (CHF)</TableHead>
                        <TableHead className="text-right">Buchungen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...multiParse.rowsByMonth.keys()].sort((a, b) => a - b).map(m => {
                        const t = multiPreview.monthTotals.get(m);
                        return (
                          <TableRow key={m}>
                            <TableCell className="font-medium">{MONTHS[m - 1]} {multiParse.year}</TableCell>
                            <TableCell>
                              {(() => {
                                const s = multiPreview.monthStatus.get(m);
                                if (s === 'aktualisiert') return <Badge className="bg-amber-100 text-amber-800 border-amber-300 text-[10px]">aktualisiert</Badge>;
                                if (s === 'unverändert') return <Badge variant="outline" className="text-[10px]">unverändert</Badge>;
                                return <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">neu</Badge>;
                              })()}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{t?.accounts ?? 0}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {(t?.expense ?? 0).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {(t?.income ?? 0).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {multiParse.journalByMonth.get(m)?.length ?? 0}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {multiPreview.unresolvedRows.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      Nicht zugeordnete Konten ({multiPreview.unresolvedRows.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <UnresolvedTable
                      rows={multiPreview.unresolvedRows}
                      onAssign={handleAssignAccountMulti}
                      onSplit={() => toast.info('Aufteilen ist im Mehrmonats-Import nicht verfügbar — bitte das Konto direkt zuordnen.')}
                    />
                  </CardContent>
                </Card>
              )}

              <Separator />

              <div className="flex items-center justify-between gap-4">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Zurück
                </Button>
                <div className="flex items-center gap-4">
                  {multiPreview.unmapped.size > 0 && (
                    <p className="text-sm text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {multiPreview.unmapped.size} {multiPreview.unmapped.size === 1 ? 'Konto muss' : 'Konten müssen'} noch zugeordnet werden
                    </p>
                  )}
                  <Button
                    onClick={handleSaveMulti}
                    disabled={loading || multiPreview.unmapped.size > 0}
                    size="lg"
                    className="min-w-44"
                  >
                    {loading
                      ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Speichern…</>
                      : <><Save className="h-4 w-4 mr-2" /> {multiParse.rowsByMonth.size} Monate importieren</>
                    }
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ── SCHRITT 2: Vorschau & Zuordnung ── */}
          {step === 'preview' && parseResult && !multiParse && (
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

              {/* Lieferanten-Journal (Sage-Buchungszeilen) — Basis für den FIBU-Abgleich */}
              {dataType === 'actual' && (parseResult.journalEntries?.length ?? 0) > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">
                      Lieferanten-Journal ({parseResult.journalEntries!.length} Buchungszeilen)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <p className="text-xs text-muted-foreground mb-2">
                      Wird zusätzlich zu den Kontobeträgen gespeichert und speist den
                      FIBU-Abgleich pro Lieferant (Warenrechnungen → Abgleich).
                    </p>
                    <div className="max-h-48 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground border-b">
                            <th className="text-left py-1 pr-2 font-medium">Lieferant / Text</th>
                            <th className="text-right py-1 pr-2 font-medium">Buchungen</th>
                            <th className="text-right py-1 font-medium">Soll − Haben (CHF)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(
                            parseResult.journalEntries!.reduce<Record<string, { n: number; sum: number }>>((acc, e) => {
                              const k = e.text;
                              acc[k] = { n: (acc[k]?.n ?? 0) + 1, sum: (acc[k]?.sum ?? 0) + e.soll - e.haben };
                              return acc;
                            }, {}),
                          )
                            .sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum))
                            .map(([name, v]) => (
                              <tr key={name} className="border-b last:border-0">
                                <td className="py-1 pr-2">{name}</td>
                                <td className="py-1 pr-2 text-right tabular-nums">{v.n}</td>
                                <td className="py-1 text-right tabular-nums">
                                  {v.sum.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

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
                        Ausstehend ({unresolvedCount})
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
                        rows={visibleUnresolved}
                        onAssign={handleAssignAccount}
                        onSplit={openSplitDialog}
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
                    {savedMultiInfo
                      ? savedMultiInfo
                      : <>Die Buchhaltungsdaten für <strong>{MONTHS[savedMonth.month - 1]} {savedMonth.year}</strong> wurden gespeichert.</>}
                  </p>
                </div>
                <div className="flex justify-center gap-3 pt-2 flex-wrap">
                  <Button variant="outline" onClick={() => {
                    setStep('upload');
                    setFileName('');
                    setParseResult(null);
                    setWarnings([]);
                    setSavedMonth(null);
                    setMultiParse(null);
                    setSavedMultiInfo(null);
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

      {/* ── Split-Dialog (global, ausserhalb der Tabs) ── */}
      <SplitDialog
        open={splitDialogOpen}
        onOpenChange={setSplitDialogOpen}
        row={splitDialogRow}
        onConfirm={handleSplit}
      />
    </div>
  );
}
