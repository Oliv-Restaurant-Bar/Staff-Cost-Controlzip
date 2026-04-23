import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Upload, FileText, XCircle, CheckCircle2, AlertTriangle, Info,
  Loader2, PencilLine, Save, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseGastronoviExcel, GastronoviDayResult } from '@/lib/revenue-parser';
import { DailyBudget } from '@/types/personnel';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { kvSet } from '@/lib/supabase-kv';
import { useTenant } from '@/contexts/TenantContext';

const DAILY_BUDGETS_BASE = 'dailyBudgets';

type ImportTarget = 'actual' | 'previous_year';

interface ConflictRow {
  date: string;
  oldValue: number;
  newValue: number;
  newFood: number;
  newBeverage: number;
  replace: boolean;
}

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

function loadBudgets(storageKey: string): Record<string, DailyBudget> {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { return {}; }
}

function saveBudgets(b: Record<string, DailyBudget>, storageKey: string) {
  localStorage.setItem(storageKey, JSON.stringify(b));
}

// ─── Manual entry sub-component ──────────────────────────────────────────────

function ManualEntryCard({ storageKey }: { storageKey: string }) {
  const [date, setDate]         = useState(todayIso());
  const [target, setTarget]     = useState<ImportTarget>('actual');
  const [total, setTotal]       = useState('');
  const [food, setFood]         = useState('');
  const [beverage, setBeverage] = useState('');
  const [autoSplit, setAutoSplit] = useState(true);
  const [saved, setSaved]       = useState(false);

  const existingValue = (() => {
    const b = loadBudgets(storageKey);
    const e = b[date];
    if (!e) return null;
    return target === 'actual' ? e.actualRevenue : e.previousYearRevenue;
  })();

  const handleTotalChange = (val: string) => {
    setTotal(val);
    setSaved(false);
    if (autoSplit) {
      const num = parseFloat(val.replace(',', '.'));
      if (!isNaN(num) && num >= 0) {
        setFood(String(Math.round(num * 0.70 * 100) / 100));
        setBeverage(String(Math.round(num * 0.30 * 100) / 100));
      } else {
        setFood('');
        setBeverage('');
      }
    }
  };

  const handleFoodChange = (val: string) => {
    setFood(val);
    setAutoSplit(false);
    setSaved(false);
  };

  const handleBeverageChange = (val: string) => {
    setBeverage(val);
    setAutoSplit(false);
    setSaved(false);
  };

  const resetAutoSplit = () => {
    setAutoSplit(true);
    const num = parseFloat(total.replace(',', '.'));
    if (!isNaN(num) && num >= 0) {
      setFood(String(Math.round(num * 0.70 * 100) / 100));
      setBeverage(String(Math.round(num * 0.30 * 100) / 100));
    }
  };

  const handleSave = () => {
    const totalNum = parseFloat(total.replace(',', '.'));
    if (!date || isNaN(totalNum) || totalNum < 0) {
      toast.error('Bitte gültiges Datum und Betrag eingeben');
      return;
    }
    const foodNum = parseFloat(food.replace(',', '.')) || 0;
    const bevNum  = parseFloat(beverage.replace(',', '.')) || 0;

    const budgets = loadBudgets(storageKey);
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

    saveBudgets(budgets, storageKey);
    // Sync to Supabase KV (uses prefixed key → korrekte Mandanten-Isolation)
    console.log(`[UMSATZ] saved persistently: ${date} field=${target} total=${totalNum} key=${storageKey}`);
    kvSet(storageKey, budgets).then(() => {
      console.log(`[UMSATZ] kvSet ok: ${storageKey} now has ${Object.keys(budgets).length} Tage`);
      window.dispatchEvent(new Event('supabase-kv-synced'));
    }).catch(err => console.error('[UMSATZ] kvSet failed:', err));
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
      <CardContent className="space-y-3">

        {/* Row 1: Date + Typ */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Datum</label>
            <Input
              type="date"
              value={date}
              onChange={e => { setDate(e.target.value); setSaved(false); }}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Typ</label>
            <Select value={target} onValueChange={v => { setTarget(v as ImportTarget); setSaved(false); }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="actual">Ist-Umsatz</SelectItem>
                <SelectItem value="previous_year">Vorjahresumsatz</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Row 2: Total + Food + Beverage + Save */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total (CHF)</label>
            <Input
              type="number"
              min="0"
              step="0.05"
              placeholder="0.00"
              value={total}
              onChange={e => handleTotalChange(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Food (CHF)
              </label>
              {!autoSplit && (
                <button
                  type="button"
                  onClick={resetAutoSplit}
                  className="text-[10px] text-primary underline underline-offset-2 leading-none"
                >
                  70/30 auto
                </button>
              )}
            </div>
            <Input
              type="number"
              min="0"
              step="0.05"
              placeholder="auto"
              value={food}
              onChange={e => handleFoodChange(e.target.value)}
              className={cn('h-9', !autoSplit && food ? '' : 'text-muted-foreground')}
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
              placeholder="auto"
              value={beverage}
              onChange={e => handleBeverageChange(e.target.value)}
              className={cn('h-9', !autoSplit && beverage ? '' : 'text-muted-foreground')}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide invisible">&nbsp;</label>
            <Button onClick={handleSave} className="h-9 w-full" variant={saved ? 'outline' : 'default'}>
              {saved
                ? <><CheckCircle2 className="h-4 w-4 mr-1.5 text-green-600" />Gespeichert</>
                : <><Save className="h-4 w-4 mr-1.5" />Speichern</>}
            </Button>
          </div>
        </div>

        {/* Auto-split hint */}
        {autoSplit && (
          <p className="text-xs text-muted-foreground">
            Food und Beverage werden automatisch 70/30 aufgeteilt — du kannst sie oben manuell überschreiben.
          </p>
        )}

        {existingValue != null && existingValue > 0 && (
          <Alert className="text-sm py-2">
            <Info className="h-4 w-4" />
            <AlertDescription>
              Bestehender Wert für diesen Tag: <strong>{fmt(existingValue)}</strong> — wird beim Speichern überschrieben.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Conflict resolution dialog ───────────────────────────────────────────────

interface ConflictDialogProps {
  open: boolean;
  conflicts: ConflictRow[];
  freshCount: number;
  target: ImportTarget;
  onClose: () => void;
  onConfirm: (conflictsToReplace: string[]) => void;
}

function ConflictDialog({ open, conflicts, freshCount, target, onClose, onConfirm }: ConflictDialogProps) {
  const [rows, setRows] = useState<ConflictRow[]>([]);

  // Reset when dialog opens
  if (open && rows.length === 0 && conflicts.length > 0) {
    setRows(conflicts.map(c => ({ ...c, replace: true })));
  }
  if (!open && rows.length > 0) {
    setRows([]);
  }

  const toggle = (date: string) => {
    setRows(prev => prev.map(r => r.date === date ? { ...r, replace: !r.replace } : r));
  };

  const toggleAll = (val: boolean) => {
    setRows(prev => prev.map(r => ({ ...r, replace: val })));
  };

  const replaceCount  = rows.filter(r => r.replace).length;
  const label = target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze';

  const handleConfirm = () => {
    onConfirm(rows.filter(r => r.replace).map(r => r.date));
    setRows([]);
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { setRows([]); onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Bestehende {label} gefunden
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground space-y-1">
          {freshCount > 0 && (
            <p><strong>{freshCount} neue Tage</strong> werden direkt importiert.</p>
          )}
          <p>
            <strong>{conflicts.length} Tage</strong> haben bereits {label}. Wähle pro Tag, ob der Wert ersetzt werden soll:
          </p>
        </div>

        {/* Select all / none shortcuts */}
        <div className="flex items-center gap-3 text-xs">
          <button type="button" onClick={() => toggleAll(true)}  className="text-primary underline underline-offset-2">Alle ersetzen</button>
          <button type="button" onClick={() => toggleAll(false)} className="text-primary underline underline-offset-2">Keine ersetzen</button>
        </div>

        {/* Conflict table */}
        <div className="max-h-72 overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={replaceCount === rows.length && rows.length > 0}
                    onCheckedChange={v => toggleAll(!!v)}
                  />
                </TableHead>
                <TableHead>Datum</TableHead>
                <TableHead className="text-right">Alter Wert</TableHead>
                <TableHead className="w-6 text-center"></TableHead>
                <TableHead className="text-right">Neuer Wert</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow
                  key={r.date}
                  className={cn(
                    'cursor-pointer',
                    r.replace ? '' : 'opacity-50',
                  )}
                  onClick={() => toggle(r.date)}
                >
                  <TableCell onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={r.replace}
                      onCheckedChange={() => toggle(r.date)}
                    />
                  </TableCell>
                  <TableCell className="text-sm font-medium">
                    {format(parseLocalDate(r.date), 'EEE, dd. MMM yyyy', { locale: de })}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {fmt(r.oldValue)}
                  </TableCell>
                  <TableCell className="text-center">
                    <ArrowRight className={cn('h-3 w-3 mx-auto', r.replace ? 'text-primary' : 'text-muted-foreground/30')} />
                  </TableCell>
                  <TableCell className={cn('text-right text-sm font-semibold', r.replace ? 'text-primary' : 'text-muted-foreground/30')}>
                    {fmt(r.newValue)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2 pt-2">
          <Button variant="outline" onClick={() => { setRows([]); onClose(); }}>
            Abbrechen
          </Button>
          <Button onClick={handleConfirm} disabled={replaceCount === 0 && freshCount === 0}>
            <Upload className="h-4 w-4 mr-1.5" />
            {replaceCount > 0
              ? `${replaceCount} ersetzen${freshCount > 0 ? ` + ${freshCount} neue` : ''}`
              : freshCount > 0
              ? `${freshCount} neue importieren`
              : 'Importieren'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main import section ──────────────────────────────────────────────────────

export function GastronoviImportSection() {
  const { tenantId, tenantKey } = useTenant();
  const storageKey = tenantKey(DAILY_BUDGETS_BASE);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing]   = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [results, setResults]   = useState<GastronoviDayResult[] | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [year, setYear]         = useState<string>(String(new Date().getFullYear()));
  const [target, setTarget]     = useState<ImportTarget>('actual');
  const [imported, setImported] = useState(false);

  const [conflictOpen, setConflictOpen]     = useState(false);
  const [conflicts, setConflicts]           = useState<ConflictRow[]>([]);
  const [freshCount, setFreshCount]         = useState(0);

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
        setError('Keine Tagesdaten erkannt. Bitte prüfe das Dateiformat (Spaltenköpfe "01.01.", "02.01." usw.).');
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

  const handleImportClick = () => {
    if (!results) return;

    const budgets = loadBudgets(storageKey);
    const field = target === 'actual' ? 'actualRevenue' : 'previousYearRevenue';

    const foundConflicts: ConflictRow[] = [];
    let fresh = 0;

    for (const r of results) {
      const oldVal = (budgets[r.date]?.[field] ?? 0) as number;
      if (oldVal > 0) {
        foundConflicts.push({
          date: r.date,
          oldValue: oldVal,
          newValue: r.total,
          newFood: r.food,
          newBeverage: r.beverage,
          replace: true,
        });
      } else {
        fresh++;
      }
    }

    if (foundConflicts.length > 0) {
      setConflicts(foundConflicts);
      setFreshCount(fresh);
      setConflictOpen(true);
    } else {
      // No conflicts — import all directly
      commitImport(results, new Set(results.map(r => r.date)));
    }
  };

  const commitImport = (rows: GastronoviDayResult[], datesToReplace: Set<string>) => {
    const budgets = loadBudgets(storageKey);
    const field   = target === 'actual' ? 'actualRevenue'      : 'previousYearRevenue';
    const foodKey = target === 'actual' ? 'actualFood'         : 'previousYearFood';
    const bevKey  = target === 'actual' ? 'actualBeverage'     : 'previousYearBeverage';

    let count = 0;
    for (const r of rows) {
      const existingVal = (budgets[r.date]?.[field] ?? 0) as number;
      if (existingVal > 0 && !datesToReplace.has(r.date)) continue;

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

    saveBudgets(budgets, storageKey);

    // Sync to Supabase KV immediately — mandantenkorrekter Key
    const dates = rows.map(r => r.date).sort();
    console.log(`[REVENUE-BEAULIEU] tenant: ${tenantId}`);
    console.log(`[REVENUE-BEAULIEU] saved rows: ${count} Tage, Bereich ${dates[0] ?? '?'} bis ${dates.at(-1) ?? '?'}`);
    console.log(`[REVENUE-BEAULIEU] storage key: ${storageKey}`);
    kvSet(storageKey, budgets).then(() => {
      console.log(`[REVENUE-BEAULIEU] loaded rows: ${Object.keys(budgets).length} Tage in Supabase (key: ${storageKey})`);
      window.dispatchEvent(new Event('supabase-kv-synced'));
    }).catch(err => console.error('[UMSATZ] kvSet failed:', err));

    setImported(true);
    const label = target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze';
    toast.success(`${count} Tage importiert als ${label}`);
  };

  const handleConflictConfirm = (datesToReplace: string[]) => {
    if (!results) return;
    setConflictOpen(false);
    commitImport(results, new Set(datesToReplace));
  };

  const totalFood     = results?.reduce((s, r) => s + r.food, 0)     ?? 0;
  const totalBeverage = results?.reduce((s, r) => s + r.beverage, 0) ?? 0;
  const totalRevenue  = results?.reduce((s, r) => s + r.total, 0)    ?? 0;

  return (
    <div className="space-y-6">

      <ManualEntryCard storageKey={storageKey} />

      <div className="relative">
        <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">oder aus Gastronovi exportieren</span>
        </div>
      </div>

      {/* Settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Import-Einstellungen</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Jahr der Daten</label>
              <Select value={year} onValueChange={v => { setYear(v); resetFile(); }}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Importieren als</label>
              <Select value={target} onValueChange={v => setTarget(v as ImportTarget)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="actual">Ist-Umsätze (laufendes Jahr)</SelectItem>
                  <SelectItem value="previous_year">Vorjahresumsätze</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Upload zone */}
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
                dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/50 hover:bg-muted/30',
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
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
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
              <strong>Kategorisierung:</strong> Food → 100% Food · Beverage → 100% Beverage ·
              Alle anderen Positionen (Non-Foods, Rabatte, …) → 70% Food / 30% Beverage
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Preview */}
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
                  <CheckCircle2 className="h-4 w-4" /> Importiert
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
                      <TableCell className="text-right text-sm text-muted-foreground">{fmt(r.food)}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{fmt(r.beverage)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{fmt(r.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t px-4 py-3 bg-muted/30 flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-medium">Gesamt ({results.length} Tage)</span>
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

      {/* Per-day conflict dialog */}
      <ConflictDialog
        open={conflictOpen}
        conflicts={conflicts}
        freshCount={freshCount}
        target={target}
        onClose={() => setConflictOpen(false)}
        onConfirm={handleConflictConfirm}
      />

    </div>
  );
}
