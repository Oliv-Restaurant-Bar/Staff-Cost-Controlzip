import { useState, useEffect, useRef } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  Upload, TrendingUp, Clock, BookOpen, ArrowLeft,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ShoppingCart, Database, RefreshCw, Lock, LockOpen, ShieldCheck,
} from 'lucide-react';
import {
  getLockState,
  lockYear,
  unlockYear,
  formatLockedAt,
  type PriorYearLockState,
} from '@/lib/prior-year-lock';
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
import { loadEmployees, saveActualHourEntry, upsertEmployee, seedBeaulieuEmployees, runBeaulieuHarteTest, seedBeaulieuBudget2026, type BeaulieuBudgetSeedResult, type BeaulieuBudgetVerifyRow } from '@/lib/supabase-db';
import type { HarteTestResult } from '@/lib/supabase-db';
import { defaultEmployeesBeaulieu } from '@/data/defaultEmployeesBeaulieu';
import { Employee, MirusDailyImportEntry, MirusImportMode, Department } from '@/types/personnel';
import { matchEmployeeByName } from '@/lib/mirus-name-mapping-store';
import { importEmployeesFromExcel, downloadEmployeeTemplate } from '@/lib/employee-excel-export-import';
import { Users, FileDown } from 'lucide-react';
import { parseAnnualRevenueXLSX, AnnualImportResult } from '@/lib/annual-revenue-import';
import {
  parseAnnualPersonnelCostXLSX,
  generatePersonnelCostTemplate,
  type AnnualPersonnelCostResult,
} from '@/lib/annual-personnel-cost-import';
import { parseAnnualSageKontoblattByMonth, AnnualKostenResult } from '@/lib/pdf-import-engine';
import { matchCSVRows, buildMonthRecord } from '@/lib/csv-import-engine';
import { saveMonth } from '@/lib/reporting-store';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { parseMaisonXlsx } from '@/lib/maison-import';
import { saveMaisonDaily, saveMaisonEnabled, getMaisonEnabledSync } from '@/lib/maison-store';

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

function readTagesumsatzDate(keyFn: (k: string) => string = k => k): string | null {
  try {
    const storageKey = keyFn('dailyBudgets');
    const db = JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, { actualRevenue?: number }>;
    const dates = Object.entries(db)
      .filter(([, v]) => (v?.actualRevenue ?? 0) > 0)
      .map(([k]) => k)
      .sort();
    const latest = dates.at(-1) ?? null;
    const isBeau = storageKey.startsWith('beaulieu:');
    if (isBeau) {
      console.log(`[REVENUE-BEAULIEU] import hub freshness: key=${storageKey}, total days=${dates.length}, latest=${latest ?? 'none'}`);
      console.log(`[REVENUE-BEAULIEU] mismatch: ${latest ? 'no – Daten vorhanden' : 'yes – keine Ist-Umsätze für Beaulieu im localStorage'}`);
    }
    return latest;
  } catch { return null; }
}

/**
 * Liest das letzte importierte Datum aus der Supabase-Tabelle actual_hours.
 * Filtert nach Mandant: Beaulieu-Mitarbeiter haben IDs mit "b-" Prefix.
 */
async function fetchIstStundenDate(tenantId: string): Promise<string | null> {
  try {
    let query = supabase
      .from('actual_hours')
      .select('date')
      .order('date', { ascending: false })
      .limit(1);
    if (tenantId === 'beaulieu') {
      query = query.like('employee_id', 'b-%');
    } else {
      query = query.not('employee_id', 'like', 'b-%');
    }
    const { data } = await query;
    return data?.[0]?.date ?? null;
  } catch { return null; }
}

function readBuchhaltungDate(keyFn: (k: string) => string = k => k): string | null {
  try {
    const rep = JSON.parse(localStorage.getItem(keyFn('reporting_v1')) || '{}') as Record<string, { expenseCategories?: unknown[] }>;
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
  const { tenantId, tenantKey } = useTenant();
  const [verkaufDate, setVerkaufDate]         = useState<string | null | 'loading'>('loading');
  const [istStundenDate, setIstStundenDate]   = useState<string | null | 'loading'>('loading');
  const [refreshKey, setRefreshKey]           = useState(0);

  const tagesumsatzDate  = readTagesumsatzDate(tenantKey);
  const buchhaltungDate  = readBuchhaltungDate(tenantKey);

  useEffect(() => {
    setVerkaufDate('loading');
    setIstStundenDate('loading');
    fetchVerkaufsdatenDate().then(d => setVerkaufDate(d));
    fetchIstStundenDate(tenantId).then(d => setIstStundenDate(d));
    console.log(`[TENANT] DatenstandCard: Mandant "${tenantId}" geladen`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, tenantId]);

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
      latestDate:  istStundenDate === 'loading' ? null : istStundenDate,
      displayDate: istStundenDate === 'loading' ? null : istStundenDate,
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
            <RefreshCw className={cn('h-3.5 w-3.5', (verkaufDate === 'loading' || istStundenDate === 'loading') && 'animate-spin')} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {entries.map(e => {
            const s = staleness(e.latestDate, e.mode);
            const dateStr = formatDatenstandDate(e.displayDate ?? e.latestDate);
            const loading = (e.label === 'Verkaufsdaten Produkte' && verkaufDate === 'loading')
                         || (e.label === 'Ist-Stunden'           && istStundenDate === 'loading');
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
  const { tenantId } = useTenant();
  const { isAdmin }  = usePermissions();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importYear, setImportYear] = useState(currentYear - 1);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<AnnualImportResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [lockState, setAnnualLockState]  = useState<PriorYearLockState>({ locked: false });
  const [lockLoading, setAnnualLockLoading] = useState(false);

  // Lock-Status laden wenn Jahr wechselt
  useEffect(() => {
    const tid = tenantId ?? 'oliv';
    getLockState(tid, importYear).then(s => setAnnualLockState(s));
  }, [importYear, tenantId]);

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
    const tid = tenantId ?? 'oliv';

    // Lock-Check: Abbruch wenn Vorjahresdaten gesperrt sind
    if (lockState.locked) {
      console.warn(`[PRIOR-YEAR] import blocked: locked | tenant: ${tid} | year: ${importYear}`);
      toast.error(`VJ ${importYear} ist gesperrt. Bitte zuerst entsperren (nur Admin).`);
      return;
    }

    setSaving(true);
    let saved = 0;
    // Vorjahresumsatz wird als revenuePreviousYear im Folgejahr gespeichert,
    // damit die P&L-Engine (pl-engine.ts) record.revenuePreviousYear korrekt liest.
    // Beispiel: Datei für 2025 → gespeichert als revenuePreviousYear in Jahr 2026.
    const saveYear = importYear + 1;
    for (const row of result.months) {
      if (row.revenue === 0) continue;
      saveMonth(
        { year: saveYear, month: row.month, revenuePreviousYear: row.revenue },
        'annual_xlsx_import',
        'update',
        { note: `Vorjahr-Import ${importYear} → erscheint in P&L ${saveYear}` },
      );
      saved++;
    }
    setSaving(false);
    setSaved(true);
    console.log(`[PRIOR-YEAR] values preserved: yes | tenant: ${tid} | year: ${importYear} | months: ${saved}`);
    toast.success(`${saved} Monate als Vorjahr ${importYear} gespeichert (sichtbar in P&L ${saveYear})`);
  };

  const handleAnnualLock = async () => {
    const tid = tenantId ?? 'oliv';
    setAnnualLockLoading(true);
    try {
      const { error } = await lockYear(tid, importYear, { source: 'annual_xlsx_import' });
      if (error) { toast.error('Sperren fehlgeschlagen: ' + error); return; }
      const newState = await getLockState(tid, importYear);
      setAnnualLockState(newState);
      toast.success(`VJ ${importYear} gesperrt — Monats-Import blockiert`);
    } finally {
      setAnnualLockLoading(false);
    }
  };

  const handleAnnualUnlock = async () => {
    const tid = tenantId ?? 'oliv';
    setAnnualLockLoading(true);
    try {
      const { error } = await unlockYear(tid, importYear);
      if (error) { toast.error('Entsperren fehlgeschlagen: ' + error); return; }
      setAnnualLockState({ locked: false });
      toast.success(`VJ ${importYear} entsperrt — Import wieder möglich`);
    } finally {
      setAnnualLockLoading(false);
    }
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
          → erscheint als Vorjahr-Spalte in P&L {importYear + 1}
        </span>
      </div>

      {/* Lock-Status ─────────────────────────────────────────────────────── */}
      {lockState.locked ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px]">
          <Lock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-amber-800 dark:text-amber-300 flex-1">
            <strong>VJ {importYear} gesperrt</strong> — Monatlicher Import blockiert.
            {lockState.lockedAt && <> Fixiert am {formatLockedAt(lockState.lockedAt)}.</>}
            {lockState.source   && <> Quelle: <span className="font-mono">{lockState.source}</span>.</>}
          </span>
          {isAdmin && (
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[10px] gap-1 border-amber-400 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-600"
              onClick={handleAnnualUnlock}
              disabled={lockLoading}
            >
              {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <LockOpen className="h-3 w-3" />}
              Entsperren
            </Button>
          )}
        </div>
      ) : saved ? (
        <div className="flex items-center gap-2 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/20 px-3 py-2 text-[11px]">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
          <span className="text-teal-700 dark:text-teal-400 flex-1">
            VJ {importYear} importiert. Jetzt fixieren um versehentliches Überschreiben zu verhindern.
          </span>
          {isAdmin && (
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[10px] gap-1 border-teal-400 text-teal-700 hover:bg-teal-100 dark:text-teal-300 dark:border-teal-600"
              onClick={handleAnnualLock}
              disabled={lockLoading}
            >
              {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
              Fixieren
            </Button>
          )}
        </div>
      ) : null}

      {!result && !parsing && !lockState.locked && (
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
          <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Gastronovi-Jahresbericht oder Monatsbericht</p>
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
              Als Vorjahr {importYear} speichern
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
          Vorjahr {importYear} gespeichert — sichtbar in P&L {importYear + 1}. Nächste Datei?{' '}
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
  const { tenantId, tenantKey } = useTenant();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const today = new Date();

  useEffect(() => {
    loadEmployees(tenantId).then(emps => {
      const list = emps ?? [];
      setEmployees(list);
      setLoading(false);
      // ─── [CONSISTENCY] Mirus Matching-Basis ──────────────────────────
      console.log(`[CONSISTENCY] tenant: ${tenantId}`);
      console.log(`[CONSISTENCY] mirus matching base: ${list.length}`);
      console.log(`[CONSISTENCY] employee names mirus: ${list.map(e => e.name).join(', ')}`);
      if (tenantId === 'beaulieu') {
        const olivNames = ['arber', 'artin', 'carlos', 'mendim', 'joana', 'husein', 'mejdi', 'miro', 'culi', 'eduard', 'nahuel', 'nina', 'stefan'];
        const leak = list.filter(e => olivNames.some(o => e.name.toLowerCase().includes(o)));
        console.log(`[CONSISTENCY] mismatch: ${leak.length > 0 ? 'yes – Oliv-Namen in Mirus-Basis: ' + leak.map(e => e.name).join(', ') : 'no'}`);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleCreateEmployee = (name: string, department: Department): Employee => {
    const newEmp: Employee = {
      id:             crypto.randomUUID(),
      name,
      department,
      employmentType: 'aushilfe',
      hourlyWage:     0,
    };
    setEmployees(prev => [...prev, newEmp]);
    upsertEmployee(newEmp, tenantId).catch(e => console.error('[ImportHub] upsertEmployee failed:', e));
    toast.success(`Mitarbeiter "${name}" neu angelegt – Stundenlohn bitte im Personalstamm ergänzen.`);
    return newEmp;
  };

  const handleMirusImport = async (entries: MirusDailyImportEntry[], mode: MirusImportMode) => {
    const affectedMonths = new Set(entries.map(e => e.date.slice(0, 7)));
    const saves: Array<{ empId: string; date: string; hours: number }> = [];

    const loadMonthData = (month: string): Record<string, { hours: number; absenceType?: string }> => {
      try { return JSON.parse(localStorage.getItem(tenantKey(`actual-hours-${month}`)) || '{}'); } catch { return {}; }
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
      localStorage.setItem(tenantKey(`actual-hours-${month}`), JSON.stringify(data));
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

// ─── Beaulieu Mitarbeiter-Import ─────────────────────────────────────────────

const BEAULIEU_REAL_EMPLOYEES = defaultEmployeesBeaulieu;

const BeaulieuMitarbeiterSection = () => {
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<{ count: number; errors: string[] } | null>(null);
  const [supabaseCount, setSupabaseCount] = useState<number | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<HarteTestResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Aktuellen Supabase-Stand laden
  useEffect(() => {
    loadEmployees('beaulieu').then(emps => {
      if (emps !== null) setSupabaseCount(emps.length);
    });
  }, [seedResult]);

  // ── Seed: echte Liste direkt in Supabase schreiben ─────────────────────────
  const handleSeedSupabase = async () => {
    setSeeding(true);
    setSeedResult(null);
    try {
      const result = await seedBeaulieuEmployees(BEAULIEU_REAL_EMPLOYEES);
      setSeedResult({ count: result.count, errors: result.errors });
      if (result.success) {
        toast.success(`${result.count} Beaulieu-Mitarbeitende in Supabase gespeichert`);
      } else {
        toast.error(`${result.errors.length} Fehler beim Import – Details im Log`);
      }
    } catch (e) {
      console.error('[BEAULIEU] seed exception:', e);
      toast.error('Unerwarteter Fehler beim Import');
    } finally {
      setSeeding(false);
    }
  };

  // ── Härtetest ──────────────────────────────────────────────────────────────
  const handleHarteTest = async () => {
    setTestRunning(true);
    setTestResult(null);
    try {
      const emps = await loadEmployees('beaulieu');
      if (!emps || emps.length === 0) {
        toast.error('Keine Beaulieu-Mitarbeitenden in Supabase – bitte zuerst importieren');
        return;
      }
      const result = await runBeaulieuHarteTest(emps);
      setTestResult(result);
      if (result.passed) {
        toast.success('Härtetest bestanden – Beaulieu ist produktionssicher');
      } else {
        toast.error('Härtetest fehlgeschlagen – Details im Ergebnis unten');
      }
    } catch (e) {
      console.error('[HÄRTETEST] exception:', e);
      toast.error('Unerwarteter Fehler beim Härtetest');
    } finally {
      setTestRunning(false);
    }
  };

  const küche = BEAULIEU_REAL_EMPLOYEES.filter(e => e.department === 'küche');
  const service = BEAULIEU_REAL_EMPLOYEES.filter(e => e.department === 'service');
  const alreadyImported = supabaseCount !== null && supabaseCount >= BEAULIEU_REAL_EMPLOYEES.length;

  return (
    <div className="space-y-4">

      {/* Status: was ist aktuell in Supabase */}
      <div className={`rounded-lg border p-3 text-xs space-y-1 ${
        alreadyImported
          ? 'border-green-200 bg-green-50 dark:bg-green-950/20'
          : 'border-amber-200 bg-amber-50 dark:bg-amber-950/20'
      }`}>
        <p className={`font-semibold ${alreadyImported ? 'text-green-800 dark:text-green-300' : 'text-amber-800 dark:text-amber-300'}`}>
          {supabaseCount === null
            ? '⏳ Supabase-Stand wird geladen…'
            : alreadyImported
              ? `✓ ${supabaseCount} Mitarbeitende bereits in Supabase (restaurant_id = 'beaulieu')`
              : `⚠ Aktuell ${supabaseCount} Mitarbeitende in Supabase – ${BEAULIEU_REAL_EMPLOYEES.length} erwartet`}
        </p>
        {!alreadyImported && supabaseCount !== null && (
          <p className="text-muted-foreground">Bitte unten „In Supabase importieren" klicken.</p>
        )}
      </div>

      {/* Vorschau der echten Mitarbeitenden */}
      <div className="rounded border border-violet-200 bg-violet-50/30 dark:bg-violet-950/10 p-3 text-xs space-y-2">
        <p className="font-medium text-violet-800 dark:text-violet-300">
          {BEAULIEU_REAL_EMPLOYEES.length} echte Beaulieu-Mitarbeitende (Quelle: Mirus)
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="font-medium text-muted-foreground mb-1">Küche ({küche.length})</p>
            {küche.map(e => <p key={e.id} className="text-muted-foreground truncate">{e.name}</p>)}
          </div>
          <div>
            <p className="font-medium text-muted-foreground mb-1">Service ({service.length})</p>
            {service.map(e => <p key={e.id} className="text-muted-foreground truncate">{e.name}</p>)}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground/70 pt-1">
          IDs: b-1 bis b-{BEAULIEU_REAL_EMPLOYEES.length} • restaurant_id = 'beaulieu' • Lohn nachpflegen im Personalstamm
        </p>
      </div>

      {/* Haupt-Aktion: in Supabase importieren */}
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          size="sm"
          className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
          onClick={handleSeedSupabase}
          disabled={seeding}
        >
          {seeding
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Importiere…</>
            : <><Users className="h-3.5 w-3.5" />In Supabase importieren ({BEAULIEU_REAL_EMPLOYEES.length} Mitarbeitende)</>}
        </Button>
        {alreadyImported && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={handleSeedSupabase}
            disabled={seeding}
          >
            Erneut synchronisieren (Upsert)
          </Button>
        )}
      </div>

      {/* Ergebnis */}
      {seedResult && (
        <div className={`rounded-md border p-3 text-xs space-y-1 ${
          seedResult.errors.length === 0
            ? 'border-green-200 bg-green-50 dark:bg-green-950/20'
            : 'border-red-200 bg-red-50 dark:bg-red-950/20'
        }`}>
          {seedResult.errors.length === 0 ? (
            <>
              <p className="font-semibold text-green-800 dark:text-green-300">
                ✓ {seedResult.count} Mitarbeitende erfolgreich in Supabase gespeichert
              </p>
              <p className="text-muted-foreground">
                Mandant: beaulieu • Upsert (keine Duplikate) • Oliv unberührt
              </p>
              <p className="text-muted-foreground mt-1">
                Bitte zum <Link to="/personal-stamm" className="underline text-green-700">Personalstamm</Link> wechseln um Löhne/Stammdaten zu ergänzen.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-red-800 dark:text-red-300">
                {seedResult.count} importiert, {seedResult.errors.length} Fehler
              </p>
              {seedResult.errors.map((err, i) => (
                <p key={i} className="text-red-600">{err}</p>
              ))}
            </>
          )}
        </div>
      )}

      {/* Härtetest */}
      <div className="border-t pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground font-medium">Produktions-Härtetest (7 Schritte)</p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 border-violet-300 text-violet-700 hover:bg-violet-50 dark:text-violet-400 dark:border-violet-700"
            onClick={handleHarteTest}
            disabled={testRunning}
          >
            {testRunning
              ? <><Loader2 className="h-3 w-3 animate-spin" />Teste…</>
              : <><Database className="h-3 w-3" />Härtetest starten</>}
          </Button>
        </div>

        {testResult && (
          <div className={`rounded-md border p-3 text-xs space-y-2 ${
            testResult.passed
              ? 'border-green-200 bg-green-50 dark:bg-green-950/20'
              : 'border-red-200 bg-red-50 dark:bg-red-950/20'
          }`}>
            <div className="flex items-center justify-between">
              <p className={`font-semibold ${testResult.passed ? 'text-green-800 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                {testResult.passed ? '✓ Alle Tests bestanden' : '✗ Test fehlgeschlagen'}
              </p>
              <span className="text-muted-foreground">{testResult.durationMs}ms</span>
            </div>
            <div className="space-y-1.5">
              {testResult.steps.map((s, i) => (
                <div key={i} className="space-y-0.5">
                  <div className="flex items-start gap-1.5">
                    {s.passed
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 mt-px" />
                      : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-px" />}
                    <div>
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted-foreground ml-1">— {s.message}</span>
                    </div>
                  </div>
                  {s.details.length > 0 && (
                    <div className="ml-5 space-y-0.5">
                      {s.details.map((d, j) => (
                        <p key={j} className="text-[10px] text-muted-foreground/80 font-mono">{d}</p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {testResult.passed && (
              <p className="text-[10px] text-green-700 dark:text-green-400 pt-1 border-t border-green-200">
                Beaulieu ist produktionssicher. Speichern, Laden, Tenant-Isolation und Mirus-Matching funktionieren korrekt.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Trennlinie + Excel-Alternativ-Import */}
      <div className="border-t pt-3">
        <p className="text-[11px] text-muted-foreground mb-2 font-medium">Alternative: Excel-Datei hochladen</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
            onClick={() => downloadEmployeeTemplate()}>
            <FileDown className="h-3.5 w-3.5" />
            Excel-Vorlage
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
            onClick={() => fileRef.current?.click()}>
            <Users className="h-3.5 w-3.5" />
            Excel hochladen
          </Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => { e.target.value = ''; }} />
        </div>
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

// ─── Beaulieu Budget 2026 Import ─────────────────────────────────────────────

const MONTH_ABBREVS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function isMonthRow(position: string) {
  return MONTH_ABBREVS.some(m => position === `Umsatz ${m}`);
}

function BudgetVerifyTable({ rows }: { rows: BeaulieuBudgetVerifyRow[] }) {
  const fmtCHF = (v: number) => `CHF ${v.toLocaleString('de-CH')}`;
  const months = rows.filter(r => isMonthRow(r.position));
  const totals = rows.filter(r => !isMonthRow(r.position));
  const hasErrors = rows.some(r => r.status === 'ERROR');

  return (
    <div className="space-y-3">
      <div className={`flex items-center gap-2 text-sm font-semibold ${hasErrors ? 'text-red-600' : 'text-emerald-600'}`}>
        {hasErrors
          ? <AlertCircle className="h-4 w-4" />
          : <CheckCircle2 className="h-4 w-4" />
        }
        {hasErrors ? 'Differenzen gefunden — bitte prüfen' : 'Alle Werte stimmen mit dem Excel überein'}
      </div>

      {/* Monatliche Umsätze */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Umsatz Monatswerte (CHF)</p>
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">Monat</th>
                <th className="text-right px-2 py-1.5 font-medium">Excel</th>
                <th className="text-right px-2 py-1.5 font-medium">Supabase</th>
                <th className="text-right px-2 py-1.5 font-medium">Diff</th>
                <th className="text-center px-2 py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {months.map(r => (
                <tr key={r.position} className={r.status === 'ERROR' ? 'bg-red-50 dark:bg-red-950/20' : ''}>
                  <td className="px-2 py-1 font-medium">{r.position.replace('Umsatz ', '')}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.excel.toLocaleString('de-CH')}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.supabase.toLocaleString('de-CH')}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${r.diff !== 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'}`}>{r.diff === 0 ? '—' : (r.diff > 0 ? '+' : '') + r.diff.toLocaleString('de-CH')}</td>
                  <td className="px-2 py-1 text-center">
                    {r.status === 'OK'
                      ? <span className="text-emerald-600">✓</span>
                      : <span className="text-red-600 font-bold">✗</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Jahrestotale */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Jahrestotale</p>
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium">Position</th>
                <th className="text-right px-2 py-1.5 font-medium">Excel</th>
                <th className="text-right px-2 py-1.5 font-medium">Supabase</th>
                <th className="text-right px-2 py-1.5 font-medium">Diff</th>
                <th className="text-center px-2 py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {totals.map(r => (
                <tr key={r.position} className={`${r.status === 'ERROR' ? 'bg-red-50 dark:bg-red-950/20' : ''} ${r.position.includes('EBITDA') || r.position.includes('Umsatz Total') ? 'font-semibold' : ''}`}>
                  <td className="px-2 py-1">{r.position}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtCHF(r.excel)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtCHF(r.supabase)}</td>
                  <td className={`px-2 py-1 text-right tabular-nums ${r.diff !== 0 ? 'text-red-600 font-semibold' : 'text-muted-foreground'}`}>{r.diff === 0 ? '—' : (r.diff > 0 ? '+' : '') + fmtCHF(r.diff)}</td>
                  <td className="px-2 py-1 text-center">
                    {r.status === 'OK'
                      ? <span className="text-emerald-600">✓</span>
                      : <span className="text-red-600 font-bold">✗</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Marketing-Umsatz Import ──────────────────────────────────────────────────

function MaisonImportSection() {
  const { tenantKey } = useTenant();
  const [year, setYear]       = useState(currentYear);
  const [file, setFile]       = useState<File | null>(null);
  const [status, setStatus]   = useState<'idle' | 'parsing' | 'done' | 'error'>('idle');
  const [result, setResult]   = useState<import('@/lib/maison-import').MaisonImportResult | null>(null);
  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File) => {
    setFile(f);
    setStatus('idle');
    setResult(null);
    setError('');
  };

  const handleParse = async () => {
    if (!file) return;
    setStatus('parsing');
    setError('');
    try {
      const r = await parseMaisonXlsx(file, year);
      setResult(r);
      setStatus('done');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setStatus('error');
    }
  };

  const handleSave = async () => {
    if (!result) return;
    setSaving(true);
    try {
      await saveMaisonDaily(tenantKey, result.daily);
      if (!getMaisonEnabledSync(tenantKey)) {
        await saveMaisonEnabled(tenantKey, true);
      }
      toast.success(`Marketing-Umsatz gespeichert: ${result.daysWithData} Tage, CHF ${result.totalGross.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`);
      setFile(null);
      setResult(null);
      setStatus('idle');
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) {
      toast.error('Fehler beim Speichern: ' + String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const fmtCHF = (n: number) => `CHF ${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/10 p-4 space-y-3">

        <p className="text-xs text-muted-foreground">
          Lade den Gastronovi-Export (Excel) hoch. Die Zeilen <span className="font-mono bg-muted px-1 rounded">marketing</span> und{' '}
          <span className="font-mono bg-muted px-1 rounded">Marketing</span> werden pro Tag summiert und in der Marketing-Spalte
          des Tages-Controllings angezeigt.
        </p>

        {/* Jahr + Datei */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Jahr</p>
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                  <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Excel-Datei</p>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              className="block w-full text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-violet-100 file:text-violet-700 dark:file:bg-violet-900/40 dark:file:text-violet-300 cursor-pointer"
            />
          </div>
        </div>

        {file && status === 'idle' && (
          <Button size="sm" className="h-8 text-xs w-full gap-1.5" onClick={handleParse}>
            <Upload className="h-3.5 w-3.5" />
            Datei analysieren
          </Button>
        )}

        {status === 'parsing' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Wird analysiert…
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 rounded bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {status === 'done' && result && (
          <div className="space-y-2">
            <div className="rounded border border-violet-200 dark:border-violet-700 bg-white dark:bg-violet-950/10 p-3 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Analyse abgeschlossen
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-1">
                <span className="text-muted-foreground">Monat erkannt:</span>
                <span className="font-medium">{result.month.toString().padStart(2, '0')}.{result.year}</span>
                <span className="text-muted-foreground">Tage mit Daten:</span>
                <span className="font-medium">{result.daysWithData}</span>
                <span className="text-muted-foreground">Gesamt (Brutto):</span>
                <span className="font-medium">{fmtCHF(result.totalGross)}</span>
                <span className="text-muted-foreground">Zeilen verarbeitet:</span>
                <span className="font-medium">{result.rowsFound.join(', ') || '–'}</span>
              </div>
            </div>
            <Button
              size="sm"
              className="h-8 text-xs w-full gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {saving ? 'Wird gespeichert…' : 'Daten übernehmen'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BeaulieuBudgetImportSection() {
  const [running, setRunning]   = useState(false);
  const [result, setResult]     = useState<BeaulieuBudgetSeedResult | null>(null);

  const handleSeed = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await seedBeaulieuBudget2026();
      setResult(res);
      const hasErrors = res.verifyRows?.some(r => r.status === 'ERROR');
      if (res.success && !hasErrors) {
        toast.success(`Budget 2026 Beaulieu gespeichert — alle Werte korrekt ✓`);
      } else if (res.success && hasErrors) {
        toast.warning('Budget gespeichert, aber Differenzen im Vergleich gefunden');
      } else {
        toast.error('Budget-Import fehlgeschlagen');
      }
    } catch (e) {
      toast.error('Fehler: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Schreibt die Budgetwerte aus <strong>Budget Beaulieu 2026.xlsx</strong> fest in Supabase
        (Schlüssel: <code className="text-xs bg-muted px-1 rounded">beaulieu:budget_v1</code>).
        Nach dem Speichern wird automatisch ein Abgleich Excel ↔ Supabase durchgeführt.
      </p>

      <Button
        onClick={handleSeed}
        disabled={running}
        className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
      >
        {running
          ? <><Loader2 className="h-4 w-4 animate-spin" />Budget wird gespeichert + verifiziert…</>
          : <><Database className="h-4 w-4" />Budget 2026 speichern + verifizieren</>
        }
      </Button>

      {result && (
        <div className="space-y-3">
          {/* Save-Zusammenfassung */}
          <div className={`rounded-lg border px-4 py-3 text-sm ${result.success ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30' : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30'}`}>
            <div className="flex items-center gap-1.5 font-semibold mb-1">
              {result.success
                ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                : <AlertCircle className="h-4 w-4 text-red-600" />
              }
              {result.message}
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>{result.updatedItems.length} Konten aktualisiert · {result.addedItems.length} ergänzt · {result.durationMs} ms</p>
              {result.totalRevenue !== undefined && (
                <p className="font-medium">
                  Jahresumsatz Beaulieu 2026: <span className="text-foreground">CHF {result.totalRevenue.toLocaleString('de-CH')}</span>
                </p>
              )}
              {result.olivLeakDetected && (
                <p className="text-red-600 font-semibold">⚠ Oliv-Leak erkannt! Jan-Umsatz = 240'000 (Oliv-Wert). Budget muss neu geseeded werden.</p>
              )}
              {result.olivLeakDetected === false && (
                <p className="text-emerald-600">✓ Kein Oliv-Leak — restaurant_id beaulieu korrekt isoliert</p>
              )}
            </div>
          </div>

          {/* Vergleichstabelle */}
          {result.verifyRows && result.verifyRows.length > 0 && (
            <div className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Kontrollabgleich: Excel ↔ Supabase
              </p>
              <BudgetVerifyTable rows={result.verifyRows} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Personalkosten Vorjahr – Monats-Upload ───────────────────────────────────

const MONTH_LABELS_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];

const AnnualPersonnelCostImportSection = () => {
  const { tenantId } = useTenant();
  const { isAdmin }  = usePermissions();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importYear, setImportYear]   = useState(currentYear - 1);
  const [parsing, setParsing]         = useState(false);
  const [result, setResult]           = useState<AnnualPersonnelCostResult | null>(null);
  const [fileName, setFileName]       = useState('');
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [error, setError]             = useState('');
  const [lockState, setLockState]     = useState<PriorYearLockState>({ locked: false });
  const [lockLoading, setLockLoading] = useState(false);

  useEffect(() => {
    getLockState(tenantId ?? 'oliv', importYear).then(s => setLockState(s));
  }, [importYear, tenantId]);

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
      const res = parseAnnualPersonnelCostXLSX(buf);
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

  const handleDownloadTemplate = () => {
    const buf = generatePersonnelCostTemplate(importYear);
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Personalkosten_Vorjahr_${importYear}_Vorlage.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSave = () => {
    if (!result) return;
    const tid = tenantId ?? 'oliv';
    if (lockState.locked) {
      toast.error(`VJ ${importYear} ist gesperrt. Bitte zuerst entsperren (nur Admin).`);
      return;
    }
    setSaving(true);
    // personnelCostPreviousYear is stored in the *following* year's record,
    // so it appears in the P&L "Vorjahr" column for that year.
    const saveYear = importYear + 1;
    let savedCount = 0;
    for (const row of result.months) {
      if (row.amount === 0) continue;
      saveMonth(
        { year: saveYear, month: row.month, personnelCostPreviousYear: row.amount },
        'csv_previous_year',
        'update',
        { fileName, note: `Personalkosten-Vorjahr-Import ${importYear} → P&L ${saveYear}` },
      );
      savedCount++;
    }
    setSaving(false);
    setSaved(true);
    console.log(`[PRIOR-YEAR-COST] saved | tenant: ${tid} | year: ${importYear} | months: ${savedCount}`);
    toast.success(`${savedCount} Monate Personalkosten VJ ${importYear} gespeichert (sichtbar in P&L ${saveYear})`);
  };

  const handleLock = async () => {
    const tid = tenantId ?? 'oliv';
    setLockLoading(true);
    try {
      const { error: lockErr } = await lockYear(tid, importYear, { source: 'personnel_cost_xlsx_import' });
      if (lockErr) { toast.error('Sperren fehlgeschlagen: ' + lockErr); return; }
      setLockState(await getLockState(tid, importYear));
      toast.success(`VJ ${importYear} gesperrt`);
    } finally {
      setLockLoading(false);
    }
  };

  const handleUnlock = async () => {
    const tid = tenantId ?? 'oliv';
    setLockLoading(true);
    try {
      const { error: lockErr } = await unlockYear(tid, importYear);
      if (lockErr) { toast.error('Entsperren fehlgeschlagen: ' + lockErr); return; }
      setLockState({ locked: false });
      toast.success(`VJ ${importYear} entsperrt`);
    } finally {
      setLockLoading(false);
    }
  };

  const fmt = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  return (
    <div className="space-y-3">

      {/* Jahresauswahl + Template-Download */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-muted-foreground whitespace-nowrap">Für Jahr:</label>
        <Select
          value={String(importYear)}
          onValueChange={v => { setImportYear(Number(v)); setResult(null); setSaved(false); }}
        >
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
          → erscheint als Vorjahr-Spalte in P&L {importYear + 1}
        </span>
        <Button
          size="sm" variant="outline"
          className="h-7 px-2 text-[10px] gap-1 ml-auto"
          onClick={handleDownloadTemplate}
        >
          <FileDown className="h-3 w-3" />
          Vorlage (.xlsx)
        </Button>
      </div>

      {/* Lock-Status */}
      {lockState.locked ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px]">
          <Lock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-amber-800 dark:text-amber-300 flex-1">
            <strong>VJ {importYear} gesperrt</strong> — Import blockiert.
            {lockState.lockedAt && <> Fixiert am {formatLockedAt(lockState.lockedAt)}.</>}
          </span>
          {isAdmin && (
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[10px] gap-1 border-amber-400 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-600"
              onClick={handleUnlock}
              disabled={lockLoading}
            >
              {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <LockOpen className="h-3 w-3" />}
              Entsperren
            </Button>
          )}
        </div>
      ) : saved ? (
        <div className="flex items-center gap-2 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/20 px-3 py-2 text-[11px]">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
          <span className="text-teal-700 dark:text-teal-400 flex-1">
            VJ {importYear} importiert. Fixieren um versehentliches Überschreiben zu verhindern.
          </span>
          {isAdmin && (
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[10px] gap-1 border-teal-400 text-teal-700 hover:bg-teal-100 dark:text-teal-300 dark:border-teal-600"
              onClick={handleLock}
              disabled={lockLoading}
            >
              {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
              Fixieren
            </Button>
          )}
        </div>
      ) : null}

      {/* Hinweis: Format */}
      {!result && !parsing && !lockState.locked && (
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Erwartet: Spalte A = Monatsname (Januar–Dezember), Spalte B = Betrag CHF.
          Alternativ: Kopfzeile mit Monats-Abkürzungen und Beträge darunter.
          Kein passendes Format? <button className="underline" onClick={handleDownloadTemplate}>Vorlage herunterladen</button>.
        </p>
      )}

      {/* Upload-Fläche */}
      {!result && !parsing && !lockState.locked && (
        <div
          className="border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg p-5 text-center cursor-pointer hover:bg-orange-50/50 dark:hover:bg-orange-950/20 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-orange-400" />
          <p className="text-xs font-medium text-orange-700 dark:text-orange-300">
            Excel-Datei hierher ziehen oder klicken
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">.xlsx · Monatsname + Betrag CHF</p>
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

      {/* Vorschau */}
      {result && !saved && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            <strong>{result.months.filter(r => r.amount > 0).length}</strong> Monate erkannt
            aus <em>{fileName}</em>
            {result.detectedYear && <> · Quell-Jahr {result.detectedYear}</>}
          </p>

          {result.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {w}
            </div>
          ))}

          <div className="rounded border text-[11px] overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/60">
                <tr>
                  {MONTH_LABELS_SHORT.map(m => (
                    <th key={m} className="text-center py-1 px-1 font-medium">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {result.months.map(r => (
                    <td key={r.month} className={cn(
                      'text-center py-1 px-1 tabular-nums',
                      r.amount === 0 && 'text-muted-foreground',
                    )}>
                      {fmt(r.amount)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Jahrestotal: <strong>{fmt(result.yearTotal)}</strong> CHF
            · wird als <strong>Personalkosten VJ {importYear}</strong> in P&L {importYear + 1} gespeichert
          </p>

          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={saving}>
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Als Personalkosten VJ {importYear} speichern
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
          Personalkosten VJ {importYear} gespeichert — sichtbar in P&L {importYear + 1}.{' '}
          <button className="underline" onClick={() => { setResult(null); setFileName(''); setSaved(false); }}>
            Erneut importieren
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Hauptseite ───────────────────────────────────────────────────────────────

const ImportHub = () => {
  const { isAdmin } = usePermissions();
  const { tenant } = useTenant();
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
              <span
                className="hidden sm:inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1"
                style={{ backgroundColor: `${tenant.color}18`, color: tenant.color, ringColor: `${tenant.color}40` }}
              >
                {tenant.shortName}
              </span>
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

        {/* ── 1b. Marketing-Umsatz ──────────────────────────────────────── */}
        <Section
          id="marketing-umsatz"
          title="Marketing-Umsatz"
          subtitle="Tägliche Marketing-Umsätze aus Gastronovi-Export importieren (Zeile «marketing»)"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-violet-400 dark:border-violet-600"
          badge="Excel .xlsx"
          badgeColor="border-violet-300 text-violet-700 bg-violet-50 dark:bg-violet-950/20"
        >
          <MaisonImportSection />
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

        {/* ── 5b. Personalkosten Vorjahr ────────────────────────────────── */}
        <Section
          id="personalkosten-vorjahr"
          title="Personalkosten Vorjahr"
          subtitle="Monatliche Personalkosten des Vorjahres hochladen — erscheinen als VJ-Spalte in der P&L"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-orange-400 dark:border-orange-600"
          badge="Excel .xlsx"
          badgeColor="border-orange-300 text-orange-700 bg-orange-50 dark:bg-orange-950/20"
        >
          <AnnualPersonnelCostImportSection />
        </Section>

        {/* ── Beaulieu: Mitarbeiter-Import ──────────────────────────────── */}
        {tenant.id === 'beaulieu' && (
          <Section
            id="beaulieu-mitarbeiter"
            title="Beaulieu Mitarbeiter"
            subtitle="Echte Mitarbeiterliste für Beaulieu importieren (Excel / CSV)"
            icon={<Users className="h-4 w-4" />}
            color="border-violet-400 dark:border-violet-600"
            badge="Beaulieu"
            badgeColor="border-violet-300 text-violet-700 bg-violet-50 dark:bg-violet-950/20"
          >
            <BeaulieuMitarbeiterSection />
          </Section>
        )}

        {/* ── Beaulieu: Budget 2026 hinterlegen ────────────────────────── */}
        {tenant.id === 'beaulieu' && (
          <Section
            id="beaulieu-budget"
            title="Budget 2026 Beaulieu"
            subtitle="Budgetwerte aus Excel fest in Supabase speichern (alle Module)"
            icon={<Database className="h-4 w-4" />}
            color="border-violet-400 dark:border-violet-600"
            badge="Beaulieu"
            badgeColor="border-violet-300 text-violet-700 bg-violet-50 dark:bg-violet-950/20"
          >
            <BeaulieuBudgetImportSection />
          </Section>
        )}

      </main>
    </div>
  );
};

export default ImportHub;
