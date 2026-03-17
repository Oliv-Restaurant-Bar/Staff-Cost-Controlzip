import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Upload, FileText, XCircle, CheckCircle2, AlertTriangle, Info, Loader2,
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

  const handleImport = () => {
    if (!results) return;

    const existing: Record<string, DailyBudget> = (() => {
      try { return JSON.parse(localStorage.getItem(DAILY_BUDGETS_KEY) || '{}'); }
      catch { return {}; }
    })();

    const updated = { ...existing };

    for (const r of results) {
      const prev = updated[r.date] ?? {
        date: r.date,
        plannedRevenue: 0,
        actualRevenue: 0,
        previousYearRevenue: 0,
        plannedLaborCost: 0,
        actualLaborCost: 0,
      };

      if (target === 'actual') {
        updated[r.date] = {
          ...prev,
          actualRevenue: r.total,
          actualFood:    r.food,
          actualBeverage: r.beverage,
        };
      } else {
        updated[r.date] = {
          ...prev,
          previousYearRevenue: r.total,
          previousYearFood:    r.food,
          previousYearBeverage: r.beverage,
        };
      }
    }

    localStorage.setItem(DAILY_BUDGETS_KEY, JSON.stringify(updated));
    setImported(true);
    toast.success(
      `${results.length} Tage importiert als ${target === 'actual' ? 'Ist-Umsätze' : 'Vorjahresumsätze'}`
    );
  };

  const totalFood     = results?.reduce((s, r) => s + r.food, 0)     ?? 0;
  const totalBeverage = results?.reduce((s, r) => s + r.beverage, 0) ?? 0;
  const totalRevenue  = results?.reduce((s, r) => s + r.total, 0)    ?? 0;

  return (
    <div className="space-y-6">

      {/* Settings row */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Einstellungen</CardTitle>
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
                    <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px]">
                      XLSX
                    </Badge>
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
              <p className="font-medium text-sm">
                Gastronovi Excel-Export hierher ziehen
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                oder klicken zum Auswählen · .xlsx, .xls
              </p>
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
              Alle anderen Positionen (Non-Foods, Trinkgeld, Rabatte, …) → 70% Food / 30% Beverage
            </AlertDescription>
          </Alert>

        </CardContent>
      </Card>

      {/* Preview + Import */}
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
                <Button onClick={handleImport} size="sm">
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

            {/* Totals footer */}
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
    </div>
  );
}
