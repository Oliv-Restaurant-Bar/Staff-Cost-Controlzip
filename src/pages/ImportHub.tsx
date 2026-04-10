import { useState, useEffect, useRef } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import {
  Upload, TrendingUp, Clock, BookOpen, ArrowLeft,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ShoppingCart, Database, RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { format, parseISO, differenceInDays, differenceInCalendarMonths, endOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { GastronoviImportSection } from '@/components/GastronoviImportSection';
import { VjDailyImportSection } from '@/components/VjDailyImportSection';
import { ActualHoursImportButton } from '@/components/ActualHoursImportButton';
import { HoursCSVImportButton } from '@/components/HoursCSVImportButton';
import { loadEmployees, saveActualHourEntry, upsertEmployee } from '@/lib/supabase-db';
import { Employee, MirusDailyImportEntry, MirusImportMode, Department } from '@/types/personnel';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import { parseAnnualRevenueXLSX, AnnualImportResult } from '@/lib/annual-revenue-import';
import { parseAnnualSageKontoblattByMonth, AnnualKostenResult } from '@/lib/pdf-import-engine';
import { matchCSVRows, buildMonthRecord } from '@/lib/csv-import-engine';
import { saveMonth } from '@/lib/reporting-store';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

const currentYear = new Date().getFullYear();

// ─── Datenstand-Card ──────────────────────────────────────────────────────────

interface DatenstandEntry {
  label:       string;
  sublabel:    string;
  icon:        React.ReactNode;
  latestDate:  string | null;   // yyyy-MM-dd or yyyy-MM — used for staleness check
  displayDate: string | null;   // yyyy-MM-dd — always shown as dd.MM.yyyy; falls back to latestDate
  mode:        'daily' | 'monthly';
  linkTo?:     string;
}

function formatDatenstandDate(d: string | null): string {
  if (!d) return 'Keine Daten';
  try {
    // Accept both yyyy-MM-dd and yyyy-MM
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return format(parseISO(d), 'dd.MM.yyyy', { locale: de });
    const [y, m] = d.split('-').map(Number);
    return format(endOfMonth(new Date(y, m - 1, 1)), 'dd.MM.yyyy', { locale: de });
  } catch { return d; }
}

function staleness(d: string | null, mode: 'daily' | 'monthly'): 'ok' | 'warn' | 'stale' | 'none' {
  if (!d) return 'none';
  const today = new Date();
  if (mode === 'daily') {
    const diff = differenceInDays(today, parseISO(d));
    if (diff <= 3)  return 'ok';
    if (diff <= 14) return 'warn';
    return 'stale';
  } else {
    const [y, m] = d.split('-').map(Number);
    const monthDate = new Date(y, m - 1, 1);
    const diff = differenceInCalendarMonths(today, monthDate);
    if (diff <= 1)  return 'ok';
    if (diff <= 3)  return 'warn';
    return 'stale';
  }
}

const STALENESS_DOT: Record<string, string> = {
  ok:    'bg-emerald-500',
  warn:  'bg-amber-400',
  stale: 'bg-red-500',
  none:  'bg-muted-foreground/30',
};
const STALENESS_LABEL: Record<string, string> = {
  ok:    'Aktuell',
  warn:  'Veraltet',
  stale: 'Sehr veraltet',
  none:  'Keine Daten',
};
const STALENESS_TEXT: Record<string, string> = {
  ok:    'text-emerald-600 dark:text-emerald-400',
  warn:  'text-amber-600 dark:text-amber-400',
  stale: 'text-red-600 dark:text-red-400',
  none:  'text-muted-foreground',
};

function readTagesumsatzDate(): string | null {
  try {
    const db = JSON.parse(localStorage.getItem('dailyBudgets') || '{}') as Record<string, { actualRevenue?: number }>;
    const dates = Object.entries(db)
      .filter(([, v]) => (v?.actualRevenue ?? 0) > 0)
      .map(([k]) => k)
      .sort();
    return dates.at(-1) ?? null;
  } catch { return null; }
}

function readIstStundenDate(): string | null {
  try {
    const keys = Object.keys(localStorage).filter(k => /^actual-hours-\d{4}-\d{2}$/.test(k));
    let latestDate: string | null = null;
    for (const key of keys) {
      try {
        const entries = JSON.parse(localStorage.getItem(key) || '{}') as Record<string, unknown>;
        for (const entryKey of Object.keys(entries)) {
          // Key format: "{employeeId}-{yyyy-MM-dd}" — date is last 10 chars
          const dateStr = entryKey.slice(-10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && (!latestDate || dateStr > latestDate)) {
            latestDate = dateStr;
          }
        }
      } catch { /* skip */ }
    }
    return latestDate;
  } catch { return null; }
}

function readBuchhaltungDate(): string | null {
  try {
    const rep = JSON.parse(localStorage.getItem('reporting_v1') || '{}') as Record<string, { expenseCategories?: unknown[] }>;
    const months = Object.entries(rep)
      .filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Array.isArray(v?.expenseCategories) && (v.expenseCategories.length ?? 0) > 0)
      .map(([k]) => k)
      .sort();
    return months.at(-1) ?? null;   // returns "yyyy-MM"; formatDatenstandDate converts to end-of-month day
  } catch { return null; }
}

async function fetchVerkaufsdatenDate(): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('product_sales')
      .select('sale_date')
      .order('sale_date', { ascending: false })
      .limit(1);
    return data?.[0]?.sale_date ?? null;
  } catch { return null; }
}

const DatenstandCard = () => {
  const [verkaufDate, setVerkaufDate]   = useState<string | null | 'loading'>('loading');
  const [refreshKey, setRefreshKey]     = useState(0);

  const tagesumsatzDate  = readTagesumsatzDate();
  const istStundenDate   = readIstStundenDate();
  const buchhaltungDate  = readBuchhaltungDate();

  useEffect(() => {
    setVerkaufDate('loading');
    fetchVerkaufsdatenDate().then(d => setVerkaufDate(d));
  }, [refreshKey]);

  const entries: DatenstandEntry[] = [
    {
      label:       'Tagesumsatz',
      sublabel:    'Gastronovi täglich',
      icon:        <TrendingUp className="h-3.5 w-3.5" />,
      latestDate:  tagesumsatzDate,
      displayDate: tagesumsatzDate,
      mode:        'daily',
    },
    {
      label:       'Ist-Stunden',
      sublabel:    'Mirus / CSV',
      icon:        <Clock className="h-3.5 w-3.5" />,
      latestDate:  istStundenDate,
      displayDate: istStundenDate,
      mode:        'daily',
      linkTo:      '#ist-stunden',
    },
    {
      label:       'Kosten Buchhaltung',
      sublabel:    'Sage / CSV-Import',
      icon:        <BookOpen className="h-3.5 w-3.5" />,
      latestDate:  buchhaltungDate,  // "yyyy-MM" for monthly staleness
      displayDate: buchhaltungDate,  // formatDatenstandDate converts to end-of-month day
      mode:        'monthly',
      linkTo:      '#ist-kosten-buchhaltung',
    },
    {
      label:       'Verkaufsdaten Produkte',
      sublabel:    'Gastronovi CSV (Artikel)',
      icon:        <ShoppingCart className="h-3.5 w-3.5" />,
      latestDate:  verkaufDate === 'loading' ? null : verkaufDate,
      displayDate: verkaufDate === 'loading' ? null : verkaufDate,
      mode:        'daily',
      linkTo:      '/sales-upload',
    },
  ];

  return (
    <Card className="border-border bg-card shadow-sm">
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">Datenstand</span>
            <span className="text-xs font-normal text-muted-foreground">– bis wann sind Daten importiert?</span>
          </CardTitle>
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Aktualisieren"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', verkaufDate === 'loading' && 'animate-spin')} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {entries.map(e => {
            const s = staleness(e.latestDate, e.mode);
            const dateStr = formatDatenstandDate(e.displayDate ?? e.latestDate);
            const loading = e.label === 'Verkaufsdaten Produkte' && verkaufDate === 'loading';
            return (
              <div
                key={e.label}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
              >
                {/* Dot */}
                <span className={cn('flex-none w-2 h-2 rounded-full', STALENESS_DOT[s])} />

                {/* Icon + Labels */}
                <span className="flex-none text-muted-foreground">{e.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{e.label}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{e.sublabel}</p>
                </div>

                {/* Date + Status */}
                <div className="text-right flex-none">
                  {loading
                    ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    : <>
                        <p className={cn('text-xs font-medium tabular-nums', STALENESS_TEXT[s])}>
                          {dateStr}
                        </p>
                        <p className={cn('text-[10px]', STALENESS_TEXT[s])}>
                          {STALENESS_LABEL[s]}
                        </p>
                      </>
                  }
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
};

// ─── Sektion-Wrapper ─────────────────────────────────────────────────────────

interface SectionProps {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  color: string;
  badge?: string;
  badgeColor?: string;
  children: React.ReactNode;
}

const Section = ({ id, title, subtitle, icon, color, badge, badgeColor, children }: SectionProps) => {
  const [open, setOpen] = useState(true);
  return (
    <Card id={id} className={cn('border-l-4 overflow-hidden', color)}>
      <CardHeader
        className="pb-2 pt-4 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <CardTitle className="text-sm flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <span className="font-semibold">{title}</span>
          {badge && (
            <Badge variant="outline" className={cn('text-[9px] ml-1', badgeColor)}>
              {badge}
            </Badge>
          )}
          <ChevronDown className={cn(
            'h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform',
            !open && '-rotate-90',
          )} />
        </CardTitle>
        <p className="text-xs text-muted-foreground pl-6">{subtitle}</p>
      </CardHeader>
      {open && (
        <CardContent className="pb-4 pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
};

// ─── Vorjahr-Umsatz importieren ───────────────────────────────────────────────

const AnnualRevenueImportSection = () => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importYear, setImportYear] = useState(currentYear - 1);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<AnnualImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setError('Nur Excel-Dateien (.xlsx/.xls) werden unterstützt.');
      return;
    }
    setParsing(true);
    setError('');
    setResult(null);
    setSaved(false);
    setFileName(file.name);
    try {
      const res = await parseAnnualRevenueXLSX(file);
      setResult(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler beim Parsen.');
    } finally {
      setParsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleSave = () => {
    if (!result) return;
    setSaving(true);
    let saved = 0;
    for (const row of result.months) {
      if (row.revenue === 0) continue;
      saveMonth(
        { year: importYear, month: row.month, revenueActual: row.revenue },
        'annual_xlsx_import',
        'update',
        { note: `Jahres-Import ${fileName}` },
      );
      saved++;
    }
    setSaving(false);
    setSaved(true);
    toast.success(`${saved} Monate gespeichert (Vorjahr ${importYear})`);
  };

  const fmt = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Für Jahr:</label>
        <Select value={String(importYear)} onValueChange={v => { setImportYear(Number(v)); setResult(null); setSaved(false); }}>
          <SelectTrigger className="h-7 text-xs w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[currentYear - 2, currentYear - 1, currentYear].map(y => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[10px] text-muted-foreground">
          (wird als Ist-Daten für dieses Jahr gespeichert)
        </span>
      </div>

      {!result && !parsing && (
        <div
          className="border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-lg p-5 text-center cursor-pointer hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-blue-400" />
          <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
            Excel-Datei hierher ziehen oder klicken
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Gastronovi-Jahresbericht</p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </div>
      )}

      {parsing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          Datei wird analysiert…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {result && !saved && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            <strong>{result.months.filter(r => r.revenue > 0).length}</strong> Monate erkannt
            aus <em>{fileName}</em>
          </p>
          <div className="rounded border text-[11px] overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/60">
                <tr>
                  {['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'].map(m => (
                    <th key={m} className="text-center py-1 px-1 font-medium">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {result.months.map(r => (
                    <td key={r.month} className={cn(
                      'text-center py-1 px-1 tabular-nums',
                      r.revenue === 0 && 'text-muted-foreground',
                    )}>
                      {fmt(r.revenue)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Speichern ({importYear})
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { setResult(null); setFileName(''); }}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {saved && (
        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          Daten gespeichert für {importYear}. Nächste Datei?{' '}
          <button className="underline" onClick={() => { setResult(null); setFileName(''); setSaved(false); }}>
            Erneut importieren
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Jahres-Kosten-Import (Sage Kontoblatt ganzes Jahr) ───────────────────────

const MONTH_LABELS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

const AnnualCostImportSection = () => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing]     = useState(false);
  const [result, setResult]       = useState<AnnualKostenResult | null>(null);
  const [fileName, setFileName]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState('');
  const [dataType, setDataType]   = useState<'actual' | 'previous_year'>('previous_year');

  const handleFile = async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      setError('Nur Excel-Dateien (.xlsx/.xls) werden unterstützt.');
      return;
    }
    setParsing(true);
    setError('');
    setResult(null);
    setSaved(false);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const res = await parseAnnualSageKontoblattByMonth(buf);
      if (res.byMonth.size === 0) {
        setError(res.warnings.find(w => w.toLowerCase().includes('keine')) ?? 'Keine Buchungszeilen gefunden.');
      } else {
        setResult(res);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler beim Parsen.');
    } finally {
      setParsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleSave = () => {
    if (!result) return;
    setSaving(true);
    let savedCount = 0;
    const sourceYear = result.detectedYear;
    const saveYear = dataType === 'previous_year' ? sourceYear + 1 : sourceYear;

    for (const [month, rows] of result.byMonth.entries()) {
      if (rows.length === 0) continue;
      const matchResult = matchCSVRows(rows);
      const config = { year: saveYear, month, dataType, mode: 'update' as const, fileName };
      const record = buildMonthRecord(matchResult.matched, matchResult.unresolved, config);
      saveMonth(
        { ...record, year: saveYear, month },
        dataType === 'previous_year' ? 'csv_previous_year' : 'csv_current',
        'update',
        { fileName, note: `Jahresimport ${sourceYear} (${dataType === 'previous_year' ? 'Vorjahr' : 'Ist'})` },
      );
      savedCount++;
    }
    setSaving(false);
    setSaved(true);
    toast.success(
      dataType === 'previous_year'
        ? `${savedCount} Monate als Vorjahr-Kosten (${sourceYear}) gespeichert`
        : `${savedCount} Monate als Ist-Kosten ${sourceYear} gespeichert`,
    );
  };

  const fmtChf = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Speichern als:</label>
        <Select value={dataType} onValueChange={v => setDataType(v as 'actual' | 'previous_year')}>
          <SelectTrigger className="h-7 text-xs w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="previous_year">Vorjahr-Vergleich (empfohlen)</SelectItem>
            <SelectItem value="actual">Ist-Daten (für das Quellenjahr)</SelectItem>
          </SelectContent>
        </Select>
        {result && (
          <span className="text-[10px] text-muted-foreground">
            {dataType === 'previous_year'
              ? `→ Vorjahr-Kosten auf ${result.detectedYear + 1}-Datensätze`
              : `→ Ist-Kosten für Jahr ${result.detectedYear}`}
          </span>
        )}
      </div>

      {!result && !parsing && (
        <div
          className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-5 text-center cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-900/20 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-gray-400" />
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Excel-Datei hierher ziehen oder klicken
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Sage Kontoblatt (Jahresexport)</p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
          />
        </div>
      )}

      {parsing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          Datei wird analysiert…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {result && !saved && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            <strong>{result.byMonth.size}</strong> Monate erkannt aus{' '}
            <em>{fileName}</em> (Jahr {result.detectedYear})
          </p>

          {/* Vorschau: Gesamtkosten pro Monat */}
          <div className="rounded border text-[11px] overflow-auto">
            <table className="w-full min-w-[480px]">
              <thead className="bg-muted/60">
                <tr>
                  {MONTH_LABELS.map(m => (
                    <th key={m} className="text-center py-1 px-1 font-medium">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                    const rows = result.byMonth.get(m) ?? [];
                    const total = rows.reduce((s, r) => s + r.amount, 0);
                    return (
                      <td key={m} className={cn(
                        'text-center py-1 px-1 tabular-nums',
                        total === 0 && 'text-muted-foreground',
                      )}>
                        {fmtChf(total)}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Alle {result.byMonth.size} Monate speichern
            </Button>
            <Button
              size="sm" variant="outline" className="h-8 text-xs"
              onClick={() => { setResult(null); setFileName(''); setError(''); }}
            >
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {saved && (
        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          Daten gespeichert.{' '}
          <button className="underline" onClick={() => { setResult(null); setFileName(''); setSaved(false); }}>
            Weitere Datei importieren
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Ist-Stunden Import ───────────────────────────────────────────────────────

const IstStundenSection = () => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const today = new Date();

  useEffect(() => {
    loadEmployees().then(emps => {
      if (emps) setEmployees(emps);
      setLoading(false);
    });
  }, []);

  const handleCreateEmployee = (name: string, department: Department): Employee => {
    const newEmp: Employee = {
      id:             crypto.randomUUID(),
      name,
      department,
      employmentType: 'aushilfe',
      hourlyWage:     0,
    };
    setEmployees(prev => [...prev, newEmp]);
    upsertEmployee(newEmp).catch(e => console.error('[ImportHub] upsertEmployee failed:', e));
    toast.success(`Mitarbeiter "${name}" neu angelegt – Stundenlohn bitte im Personalstamm ergänzen.`);
    return newEmp;
  };

  const handleMirusImport = async (entries: MirusDailyImportEntry[], mode: MirusImportMode) => {
    const affectedMonths = new Set(entries.map(e => e.date.slice(0, 7)));
    const saves: Array<{ empId: string; date: string; hours: number }> = [];

    const loadMonthData = (month: string): Record<string, { hours: number; absenceType?: string }> => {
      try { return JSON.parse(localStorage.getItem(`actual-hours-${month}`) || '{}'); } catch { return {}; }
    };

    // Helper: returns only FE/K/F absence entries from a month's data.
    // These are NEVER sent to Supabase and must survive any import mode.
    const extractAbsenceEntries = (data: Record<string, { hours: number; absenceType?: string }>) =>
      Object.fromEntries(
        Object.entries(data).filter(([, v]) => v.absenceType && v.hours === 0)
      );

    const monthData: Record<string, Record<string, { hours: number; absenceType?: string }>> = {};
    for (const m of affectedMonths) {
      const existing = loadMonthData(m);
      // In replace mode start fresh BUT keep absence entries (FE/K/F)
      monthData[m] = mode === 'replace' ? extractAbsenceEntries(existing) : { ...existing };
    }

    let matched = 0;
    const unmatched = new Set<string>();

    const debugNames = ['sadete', 'momand'];
    for (const entry of entries) {
      const isDebug = debugNames.some(d => entry.name.toLowerCase().includes(d));
      if (isDebug) {
        console.log('[ImportHub Ist] Verarbeite:', { name: entry.name, date: entry.date, hours: entry.hours });
      }
      const { employee: emp, matchStep } = matchEmployeeByName(entry.name, employees, isDebug);
      if (!emp) {
        unmatched.add(entry.name);
        if (isDebug) console.warn('[ImportHub Ist] KEIN Match:', entry.name);
        continue;
      }
      if (isDebug) {
        console.log('[ImportHub Ist] Match:', { importName: entry.name, empName: emp.name, empId: emp.id, matchStep });
      }
      const month = entry.date.slice(0, 7);
      const key = `${emp.id}-${entry.date}`;
      const existing = monthData[month]?.[key];

      if (existing?.absenceType) {
        console.log(`[FERIEN-IST] existing entry found: ${key} absenceType=${existing.absenceType} hours=${existing.hours}`);
      }

      // Priority: real imported hours > FE absence > empty
      if (existing?.absenceType && existing.hours === 0) {
        if (entry.hours === 0) {
          console.log(`[FERIEN-IST] preserved holiday entry because import had no hours: ${entry.name} ${entry.date}`);
          continue;
        } else {
          console.log(`[FERIEN-IST] replaced holiday entry because import had working hours: ${entry.name} ${entry.date} (${existing.absenceType} → ${entry.hours}h)`);
        }
      }

      if (mode === 'replace' || !existing) {
        if (!monthData[month]) monthData[month] = {};
        monthData[month][key] = { hours: entry.hours };
        saves.push({ empId: emp.id, date: entry.date, hours: entry.hours });
        matched++;
      }
    }

    for (const [month, data] of Object.entries(monthData)) {
      localStorage.setItem(`actual-hours-${month}`, JSON.stringify(data));
    }
    window.dispatchEvent(new CustomEvent('schedule-updated'));

    if (matched > 0) toast.success(`${entries.length} Einträge importiert, ${new Set(entries.map(e => e.name)).size} Mitarbeiter`);
    if (unmatched.size > 0) toast.warning(`${unmatched.size} Mitarbeiter nicht zugeordnet: ${[...unmatched].slice(0, 3).join(', ')}`);

    if (saves.length > 0) {
      await Promise.all(saves.map(({ empId, date, hours }) => saveActualHourEntry(empId, date, { hours })));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        Mitarbeiter werden geladen…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Mirus-Export («Tägliche Stunden», XLS) oder CSV-Vorlage hochladen.
        Die Stunden werden den Mitarbeitern automatisch zugeordnet.
      </p>
      <div className="flex flex-wrap gap-2">
        <ActualHoursImportButton
          onImport={handleMirusImport}
          onCreateEmployee={handleCreateEmployee}
          employees={employees}
          existingTimeEntries={[]}
        />
        <HoursCSVImportButton
          employees={employees}
          selectedDate={today}
          onImport={entries => {
            const mirusEntries: MirusDailyImportEntry[] = entries.map(e => ({
              name: e.name,
              date: e.date,
              hours: e.hours,
            }));
            handleMirusImport(mirusEntries, 'update');
          }}
        />
      </div>
    </div>
  );
};

// ─── Platzhalter-Karte ────────────────────────────────────────────────────────

const PlaceholderSection = ({ label }: { label: string }) => (
  <div className="rounded-lg border-2 border-dashed border-muted-foreground/20 p-5 text-center space-y-2">
    <Upload className="h-6 w-6 mx-auto text-muted-foreground/40" />
    <p className="text-xs text-muted-foreground font-medium">{label}</p>
    <p className="text-[10px] text-muted-foreground/70">
      Wird in einer späteren Version unterstützt. Bitte Buchhaltungsexport als CSV/PDF vorbereiten.
    </p>
    <Button variant="outline" size="sm" className="h-7 text-xs border-dashed" disabled>
      Datei hochladen (kommt bald)
    </Button>
  </div>
);

// ─── Hauptseite ───────────────────────────────────────────────────────────────

const ImportHub = () => {
  const { isAdmin } = usePermissions();
  if (!isAdmin) return <Navigate to="/personal" replace />;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">Import-Zentrale</h1>
                <p className="text-xs text-muted-foreground">Alle Datenimporte an einem Ort</p>
              </div>
            </div>
            <Link to="/">
              <Button variant="outline" size="sm" className="h-8">
                <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 pb-24 space-y-4">

        {/* ── 0. Datenstand ─────────────────────────────────────────────── */}
        <DatenstandCard />

        {/* ── 1. Umsatz Ist ────────────────────────────────────────────── */}
        <Section
          id="umsatz-ist"
          title="Umsatz Ist"
          subtitle="Tagesumsätze aus Gastronovi importieren (laufendes Jahr)"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-green-400 dark:border-green-600"
          badge="Gastronovi"
          badgeColor="border-green-300 text-green-700 bg-green-50 dark:bg-green-950/20"
        >
          <GastronoviImportSection />
        </Section>

        {/* ── 2. Umsatz Vorjahr ─────────────────────────────────────────── */}
        <Section
          id="umsatz-vorjahr"
          title="Umsatz Vorjahr"
          subtitle="Jahres-Umsatzdaten aus dem Vorjahr importieren (Gastronovi-Jahresbericht Excel)"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-blue-400 dark:border-blue-600"
          badge="Excel .xlsx"
          badgeColor="border-blue-300 text-blue-700 bg-blue-50 dark:bg-blue-950/20"
        >
          <AnnualRevenueImportSection />
        </Section>

        {/* ── 2b. Vorjahres-Tagesumsatz ────────────────────────────────── */}
        <Section
          id="vj-tagesumsatz"
          title="Vorjahres-Tagesumsatz"
          subtitle="Tägliche Vorjahresumsätze aus Gastronovi-Excel importieren (für Tagesansicht-Vergleich)"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-teal-400 dark:border-teal-600"
          badge="Excel Tageswerte"
          badgeColor="border-teal-300 text-teal-700 bg-teal-50 dark:bg-teal-950/20"
        >
          <VjDailyImportSection />
        </Section>

        {/* ── 3. Ist-Stunden ────────────────────────────────────────────── */}
        <Section
          id="ist-stunden"
          title="Ist-Stunden"
          subtitle="Tatsächlich geleistete Stunden aus Mirus (XLS) oder CSV-Vorlage importieren"
          icon={<Clock className="h-4 w-4" />}
          color="border-orange-400 dark:border-orange-600"
          badge="Mirus / CSV"
          badgeColor="border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/20"
        >
          <IstStundenSection />
        </Section>

        {/* ── 4. Ist Kosten Buchhaltung ──────────────────────────────────── */}
        <Section
          id="ist-kosten-buchhaltung"
          title="Ist Kosten Buchhaltung"
          subtitle="Monatliche Kosten aus Buchhaltungssoftware importieren (laufendes Jahr)"
          icon={<BookOpen className="h-4 w-4" />}
          color="border-purple-400 dark:border-purple-600"
          badge="CSV / Excel"
          badgeColor="border-purple-300 text-purple-700 bg-purple-50 dark:bg-purple-950/20"
        >
          <div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/10 p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Importiere monatliche Buchhaltungskosten (laufendes Jahr) aus deinem Buchhaltungsprogramm.
              Unterstützte Formate: Excel (Sage Kontoblatt), CSV, PDF.
            </p>
            <div className="text-[11px] text-muted-foreground/80 space-y-0.5">
              <p>• Format wählen: <span className="font-medium">Excel (Sage Kontoblatt)</span> oder CSV/Text-PDF</p>
              <p>• Monat und Jahr auswählen</p>
              <p>• Datentyp <span className="font-medium">«Ist-Daten»</span> auswählen</p>
            </div>
            <Link to="/csv-import">
              <Button size="sm" className="h-8 text-xs gap-1.5 w-full">
                <Upload className="h-3.5 w-3.5" />
                Zum Buchhaltungs-Import
              </Button>
            </Link>
          </div>
        </Section>

        {/* ── 5. Vorjahr Kosten Buchhaltung ─────────────────────────────── */}
        <Section
          id="vorjahr-kosten-buchhaltung"
          title="Vorjahr Kosten Buchhaltung"
          subtitle="Sage-Jahres-Kontoblatt (.xlsx) mit einem Upload für alle 12 Monate importieren"
          icon={<BookOpen className="h-4 w-4" />}
          color="border-gray-400 dark:border-gray-600"
          badge="Excel Jahresimport"
          badgeColor="border-gray-300 text-gray-700 bg-gray-50 dark:bg-gray-950/20"
        >
          <AnnualCostImportSection />
        </Section>

      </main>
    </div>
  );
};

export default ImportHub;
