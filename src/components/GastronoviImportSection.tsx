import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Upload, FileText, XCircle, CheckCircle2, AlertTriangle, Info,
  Loader2, PencilLine, Save,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseGastronoviExcel, GastronoviDayResult } from '@/lib/revenue-parser';
import { DailyBudget } from '@/types/personnel';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

const DAILY_BUDGETS_KEY = 'dailyBudgets';

type ImportTarget = 'actual' | 'previous_year';

function fmt(n: number) {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 2,
  }).format(n);
}

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadBudgets(): Record<string, DailyBudget> {
  try { return JSON.parse(localStorage.getItem(DAILY_BUDGETS_KEY) || '{}'); }
  catch { return {}; }
}

function saveBudgets(b: Record<string, DailyBudget>) {
  localStorage.setItem(DAILY_BUDGETS_KEY, JSON.stringify(b));
}

// ─── Manual entry sub-component ──────────────────────────────────────────────

function ManualEntryCard() {
  const [date, setDate]         = useState(todayIso());
  const [target, setTarget]     = useState<ImportTarget>('actual');
  const [total, setTotal]       = useState('');
  const [food, setFood]         = useState('');
  const [beverage, setBeverage] = useState('');
  const [splitMode, setSplitMode] = useState(false);
  const [saved, setSaved]       = useState(false);

  const existingValue = (() => {
    const b = loadBudgets();
    const e = b[date];
    if (!e) return null;
    return target === 'actual' ? e.actualRevenue : e.previousYearRevenue;
  })();

  const handleSave = () => {
    const totalNum = parseFloat(total.replace(',', '.'));
    if (!date || isNaN(totalNum) || totalNum < 0) {
      toast.error('Bitte gültiges Datum und Betrag eingeben');
      return;
    }

    let foodNum = 0;
    let bevNum  = 0;

    if (splitMode) {
      foodNum = parseFloat(food.replace(',', '.')) || 0;
      bevNum  = parseFloat(beverage.replace(',', '.')) || 0;
    } else {
      foodNum = Math.round(totalNum * 0.70 * 100) / 100;
      bevNum  = Math.round(totalNum * 0.30 * 100) / 100;
    }

    const budgets = loadBudgets();
    const prev = budgets[date] ?? {
      date,
      plannedRevenue: 0,
      actualRevenue: 0,
      previousYearRevenue: 0,
      plannedLaborCost: 0,
      actualLaborCost: 0,
    };

    if (target === 'actual') {
      budgets[date] = { ...prev, actualRevenue: totalNum, actualFood: foodNum, actualBeverage: bevNum };
    } else {
      budgets[date] = { ...prev, previousYearRevenue: totalNum, previousYearFood: foodNum, previousYearBeverage: bevNum };
    }

    saveBudgets(budgets);
    setSaved(true);
    toast.success(`Umsatz für ${format(parseLocalDate(date), 'dd. MMM yyyy', { locale: de })} gespeichert`);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PencilLine className="h-4 w-4" />
          Tagesumsatz manuell erfassen
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Date */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Datum
            </label>
            <Input
              type="date"
              value={date}
              onChange={e => { setDate(e.target.value); setSaved(false); }}
              className="h-9"
            />
          </div>

          {/* Target */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Typ
            </label>
            <Select value={target} onValueChange={v => { setTarget(v as ImportTarget); setSaved(false); }}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="actual">Ist-Umsatz</SelectItem>
                <SelectItem value="previous_year">Vorjahresumsatz</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Total */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Umsatz (CHF)
            </label>
            <Input
              type="number"
              min="0"
              step="0.05"
              placeholder="0.00"
              value={total}
              onChange={e => { setTotal(e.target.value); setSaved(false); }}
              className="h-9"
            />
          </div>

          {/* Save */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide invisible">
              &nbsp;
            </label>
            <Button
              onClick={handleSave}
              className="h-9 w-full"
              variant={saved ? 'outline' : 'default'}
            >
              {saved ? (
                <><CheckCircle2 className="h-4 w-4 mr-1.5 text-green-600" />Gespeichert</>
              ) : (
                <><Save className="h-4 w-4 mr-1.5" />Speichern</>
              )}
            </Button>
          </div>
        </div>

        {/* Existing value hint */}
        {existingValue != null && existingValue > 0 && (
          <Alert className="text-sm py-2">
            <Info className="h-4 w-4" />
            <AlertDescription>
              Bestehender Wert für diesen Tag: <strong>{fmt(existingValue)}</strong> — wird beim Speichern überschrieben.
            </AlertDescription>
          </Alert>
        )}

        {/* Optional Food/Bev split */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSplitMode(s => !s)}
            className="text-xs text-primary underline underline-offset-2 hover:opacity-70"
          >
            {splitMode ? 'Food/Beverage-Split ausblenden' : 'Food/Beverage manuell aufteilen'}
          </button>
          {!splitMode && total && (
            <span className="text-xs text-muted-foreground">
              (automatisch: 70% Food / 30% Beverage)
            </span>
          )}
        </div>

        {splitMode && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Food (CHF)
              </label>
              <Input
                type="number"
                min="0"
                step="0.05"
                placeholder="0.00"
                value={food}
                onChange={e => setFood(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Beverage (CHF)
              </label>
              <Input
                type="number"
                min="0"
                step="0.05"
                placeholder="0.00"
                value={beverage}
                onChange={e => setBeverage(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main import section ──────────────────────────────────────────────────────

export function GastronoviImportSection() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging]   = useState(false);
  const [parsing, setParsing]     = useState(false);
  const [fileName, setFileName]   = useState<string | null>(null);
  const [results, setResults]     = useState<GastronoviDayResult[] | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [year, setYear]           = useState<string>(String(new Date().getFullYear()));
  const [target, setTarget]       = useState<ImportTarget>('actual');
  const [imported, setImported]   = useState(false);

  // Overwrite dialog state
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [existingCount, setExistingCount]             = useState(0);
  const [newCount, setNewCount]                       = useState(0);

  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2];

  const resetFile = () => {
    setFileName(null);
    setResults(null);
    setError(null);
    setImported(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'xlsx' && ext !== 'xls') {
      setError('Nur Excel-Dateien (.xlsx, .xls) werden unterstützt.');
      return;
    }
    setFileName(file.name);
    setResults(null);
    setError(null);
    setImported(false);
    setParsing(true);
    try {
      const parsed = await parseGastronoviExcel(file, parseInt(year, 10));
      if (!parsed || parsed.length === 0) {
        setError(
          'Keine Tagesdaten erkannt. Bitte prüfe, ob das Dateiformat dem Gastronovi-Export entspricht (Spaltenköpfe "01.01.", "02.01." usw.).'
        );
        setFileName(null);
      } else {
        setResults(parsed);
      }
    } catch (e) {
      setError('Fehler beim Lesen der Datei: ' + (e instanceof Error ? e.message : String(e)));
      setFileName(null);
    } finally {
      setParsing(false);
    }
  }, [year]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // Called when user clicks "X Tage importieren"
  const handleImportClick = () => {
    if (!results) return;

    const budgets = loadBudgets();
    const field = target === 'actual' ? 'actualRevenue' : 'previousYearRevenue';

    let existing = 0;
    let fresh = 0;
    for (const r of results) {
      const val = budgets[r.date]?.[field];
      if (val != null && val > 0) existing++;
      else fresh++;
    }

    if (existing > 0) {
      setExistingCount(existing);
      setNewCount(fresh);
      setShowOverwriteDialog(true);
    } else {
      commitImport(results, 'all');
    }
  };

  // mode: 'all' = overwrite everything, 'new' = skip existing
  const commitImport = (rows: GastronoviDayResult[], mode: 'all' | 'new') => {
    const budgets = loadBudgets();
    const field    = target === 'actual' ? 'actualRevenue'      : 'previousYearRevenue';
    const foodKey  = target === 'actual' ? 'actualFood'         : 'previousYearFood';
    const bevKey   = target === 'actual' ? 'actualBeverage'     : 'previousYearBeverage';

    let count = 0;
    for (const r of rows) {
      const existingVal = budgets[r.date]?.[field];
      if (mode === 'new' && existingVal != null && (existingVal as number) > 0) continue;

      const prev = budgets[r.date] ?? {
        date: r.date,
        plannedRevenue: 0,
        actualRevenue: 0,
        previousYearRevenue: 0,
        plannedLaborCost: 0,
        actualLaborCost: 0,
      };

      budgets[r.date] = {
        ...prev,
        [field]:   r.total,
        [foodKey]: r.food,
        [bevKey]:  r.beverage,
      };
      count++;
    }

    saveBudgets(budgets);
    setImported(true);
    const label = target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze';
    toast.success(`${count} Tage importiert als ${label}`);
  };

  const totalFood     = results?.reduce((s, r) => s + r.food, 0)     ?? 0;
  const totalBeverage = results?.reduce((s, r) => s + r.beverage, 0) ?? 0;
  const totalRevenue  = results?.reduce((s, r) => s + r.total, 0)    ?? 0;

  return (
    <div className="space-y-6">

      {/* ── Manual entry ── */}
      <ManualEntryCard />

      {/* ── Divider ── */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">oder aus Gastronovi exportieren</span>
        </div>
      </div>

      {/* ── Import settings ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Import-Einstellungen</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Jahr der Daten
              </label>
              <Select value={year} onValueChange={v => { setYear(v); resetFile(); }}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Importieren als
              </label>
              <Select value={target} onValueChange={v => setTarget(v as ImportTarget)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="actual">Ist-Umsätze (laufendes Jahr)</SelectItem>
                  <SelectItem value="previous_year">Vorjahresumsätze</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Upload zone ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Gastronovi Export hochladen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">

          {parsing ? (
            <div className="border-2 border-dashed rounded-xl p-12 text-center border-primary/30 bg-primary/5">
              <Loader2 className="h-10 w-10 mx-auto mb-3 text-primary animate-spin" />
              <p className="font-medium text-sm text-primary">Datei wird analysiert…</p>
            </div>
          ) : fileName && results ? (
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium text-sm flex items-center gap-2">
                    {fileName}
                    <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">XLSX</Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {results.length} Tage mit Umsatzdaten erkannt · Jahr {year}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={resetFile}>
                <XCircle className="h-4 w-4 mr-1" /> Andere Datei
              </Button>
            </div>
          ) : (
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
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
              <p className="font-medium text-sm">Gastronovi Excel-Export hierher ziehen</p>
              <p className="text-xs text-muted-foreground mt-1">oder klicken zum Auswählen · .xlsx, .xls</p>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {error && (
            <Alert variant="destructive" className="text-sm">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Alert className="text-sm">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Kategorisierung:</strong> Food (Speisen) → 100% Food ·
              Beverage (Getränke) → 100% Beverage ·
              Alle anderen Positionen → 70% Food / 30% Beverage
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* ── Preview + Import ── */}
      {results && results.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Vorschau – {results.length} Tage
                <Badge className="ml-2 text-xs" variant="outline">
                  {target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze'} {year}
                </Badge>
              </CardTitle>
              {imported ? (
                <div className="flex items-center gap-1.5 text-green-600 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4" />
                  Importiert
                </div>
              ) : (
                <Button onClick={handleImportClick} size="sm">
                  <Upload className="h-4 w-4 mr-1.5" />
                  {results.length} Tage importieren
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-80 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Datum</TableHead>
                    <TableHead className="text-right">Food</TableHead>
                    <TableHead className="text-right">Beverage</TableHead>
                    <TableHead className="text-right font-semibold">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map(r => (
                    <TableRow key={r.date}>
                      <TableCell className="text-sm">
                        {format(parseLocalDate(r.date), 'EEE, dd. MMM yyyy', { locale: de })}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {fmt(r.food)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {fmt(r.beverage)}
                      </TableCell>
                      <TableCell className="text-right text-sm font-medium">
                        {fmt(r.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t px-4 py-3 bg-muted/30 flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium">
                Gesamt ({results.length} Tage)
              </span>
              <div className="flex gap-6">
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Food</p>
                  <p className="font-medium">{fmt(totalFood)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Beverage</p>
                  <p className="font-medium">{fmt(totalBeverage)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="font-semibold text-primary">{fmt(totalRevenue)}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Overwrite confirmation dialog ── */}
      <AlertDialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bestehende Werte gefunden</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Beim Import wurden <strong>{existingCount} Tage</strong> gefunden,
                  die bereits {target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze'} enthalten.
                </p>
                {newCount > 0 && (
                  <p className="text-muted-foreground">
                    {newCount} neue Tage ohne bestehende Werte werden in jedem Fall importiert.
                  </p>
                )}
                <p className="font-medium text-foreground">
                  Möchtest du die bestehenden Werte überschreiben?
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                setShowOverwriteDialog(false);
                if (results) commitImport(results, 'new');
              }}
            >
              Nur neue Tage ({newCount})
            </Button>
            <AlertDialogAction
              onClick={() => {
                setShowOverwriteDialog(false);
                if (results) commitImport(results, 'all');
              }}
            >
              Alle überschreiben ({existingCount + newCount})
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
