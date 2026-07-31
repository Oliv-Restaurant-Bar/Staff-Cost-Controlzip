import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ImportTaskPrefillHint } from '@/components/ImportTaskPrefillHint';
import { OpenHoursSection, useOpenParkedCount } from '@/components/import-center/OpenHoursSection';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useTenant } from '@/contexts/TenantContext';
import {
  Upload, TrendingUp, Clock, BookOpen, ArrowLeft,
  CheckCircle2, AlertCircle, Loader2, ChevronDown,
  ShoppingCart, Database, RefreshCw, Lock, LockOpen, ShieldCheck, XCircle, PencilLine,
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
import { VjDailyImportSection } from '@/components/VjDailyImportSection';
import { ManualEntryCard } from '@/components/GastronoviImportSection';
import { ActualHoursImportButton } from '@/components/ActualHoursImportButton';
import { LastImportPanel } from '@/components/import-center/LastImportPanel';
import { recordImportRun } from '@/lib/import-undo-store';
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
import { matchCSVRows, buildMonthRecord, buildExpenseCategoriesOnly } from '@/lib/csv-import-engine';
import {
  saveMonth,
  loadMonth,
  loadYear,
  replaceAnnualCostYear,
  removeAnnualCostYear,
  retryReportingMonthsBackup,
  computeBackupRepairCandidates,
  yearsWithData,
  STORAGE_KEY as REPORTING_STORAGE_KEY,
} from '@/lib/reporting-store';
import {
  buildAnnualCostPreview,
  applyImportMode,
  type AnnualCostImportMode,
} from '@/lib/annual-cost-preview';
import { REPORTING_DATA_CHANGED_EVENT, notifyReportingDataChanged } from '@/lib/import-events';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { notifyKVBackupProblem, kvGetStrict } from '@/lib/supabase-kv';
import { asRecordBlob, readLocalRecord } from '@/lib/kv-blob-utils';
import { HintBox } from '@/components/ui/hint-box';
import { StatusPill } from '@/components/ui/status-pill';
import { loadVjDailyYear } from '@/lib/vj-daily-supabase';
import {
  summarizeEffectiveMonth,
  type MonthActualsSummary,
  type BlobDayEntry,
} from '@/lib/daily-actuals';
import {
  loadAnnualCostImports,
  upsertAnnualCostImport,
  markAnnualCostImportDeleted,
  ANNUAL_COST_IMPORTS_KEY,
  type AnnualCostImportEntry,
} from '@/lib/annual-cost-imports-store';
import type { ExpenseCategory } from '@/types/reporting';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { parseMaisonXlsx } from '@/lib/maison-import';
import { saveMaisonDaily, saveMaisonEnabled, getMaisonEnabledSync } from '@/lib/maison-store';
import { parseGaesteXlsx, parseDurchschnittXlsx } from '@/lib/gaeste-import';
import { saveGaesteDaily, saveAvgCheck, loadGaesteDaily, loadAvgCheckDaily } from '@/lib/gaeste-store';
import { ladeUmsatzTage, summiereUmsatz, type UmsatzTag } from '@/lib/umsatz';
import { detectTagesdatenTypFromFile, readFirstSheetRows, isoFromDayMonth, formatInvalidDayMonth, type TagesdatenTyp } from '@/lib/tagesdaten-auto-import';
import { commitGastronoviDays, targetForYear } from '@/lib/gastronovi-daily-save';
import { parseGastronoviExcel, type GastronoviDayResult } from '@/lib/revenue-parser';
import { ImportCenterGrid } from '@/components/import-center/ImportCenterGrid';
import { ImportGroupCards, IMPORT_SECTION_OPEN_EVENT } from '@/components/import-center/ImportGroupCards';
import { visibleCategories } from '@/lib/import-center';

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

// ─── Jahres-Datenstand (Vorjahr) ─────────────────────────────────────────────
//
// Read-only-Übersicht je Jahr (Default 2024): Umsatz-Tagesdaten (dailyBudgets +
// vj_daily desselben Jahres, effektiv kombiniert via daily-actuals) und
// Kostenstand (Jahres-Import-Registry + reporting_v1-Monate). Reines Laden —
// kein Write, kein updatedAt-Bump. Fehlend = «—»/«Keine Daten», nie 0.

const JD_MONTH_LABELS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Sektion aufklappen + hinscrollen (gleicher Mechanismus wie die Gruppen-Karten). */
function openImportSection(anchor: string) {
  window.dispatchEvent(new CustomEvent(IMPORT_SECTION_OPEN_EVENT, { detail: anchor }));
  setTimeout(() => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

interface JahresDatenstand {
  /** Tage im vj_daily-Jahresbestand (Supabase) */
  vjDays: number;
  /** Effektive Tages-IST-Abdeckung je Monat (dailyBudgets + vj_daily) */
  monthStats: MonthActualsSummary[];
  /** ER-Monate (reporting_v1) mit gesetztem Umsatz (brutto ODER netto) */
  erRevenueMonths: number;
  /** ER-Monate mit mindestens einer numerischen Kostenkategorie */
  kostenMonths: number;
  /** Verschiedene Kostenkategorien mit numerischem Betrag im Jahr */
  kostenCategories: number;
  /** Registry-Eintrag des Jahres-Kostenimports (falls vorhanden) */
  registryEntry: AnnualCostImportEntry | null;
}

const JahresDatenstandCard = () => {
  const { tenantId, tenantKey } = useTenant();
  const yearOptions = [currentYear - 1, currentYear - 2, currentYear - 3];
  const [year, setYear] = useState(yearOptions.includes(2024) ? 2024 : yearOptions[0]);
  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [data, setData] = useState<JahresDatenstand | null>(null);

  const reportingKey = tenantKey(REPORTING_STORAGE_KEY);
  const registryKey  = tenantKey(ANNUAL_COST_IMPORTS_KEY);
  const budgetsKey   = tenantKey('dailyBudgets');

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const [vj, registry] = await Promise.all([
          loadVjDailyYear(year, tenantId),
          loadAnnualCostImports(registryKey),
        ]);
        if (stale) return;

        const blob = readLocalRecord(budgetsKey) as Record<string, BlobDayEntry>;
        const monthStats: MonthActualsSummary[] = [];
        for (let m = 1; m <= 12; m++) {
          monthStats.push(summarizeEffectiveMonth(blob, vj, year, m));
        }

        const er = loadYear(year, reportingKey);
        const erRevenueMonths = er.filter(
          r => r.grossRevenueManual !== undefined || r.revenueActual !== undefined,
        ).length;
        const categoryIds = new Set<string>();
        let kostenMonths = 0;
        for (const r of er) {
          const cats = (r.expenseCategories ?? []).filter(c => Number.isFinite(c.amount));
          if (cats.length > 0) kostenMonths += 1;
          for (const c of cats) categoryIds.add(c.categoryId);
        }

        setData({
          vjDays: Object.keys(vj).length,
          monthStats,
          erRevenueMonths,
          kostenMonths,
          kostenCategories: categoryIds.size,
          registryEntry: registry.find(e => e.year === year) ?? null,
        });
        setLoading(false);
      } catch (e) {
        console.warn('[JAHRES-DATENSTAND] Laden fehlgeschlagen', e);
        if (!stale) { setLoadError(true); setLoading(false); }
      }
    })();
    return () => { stale = true; };
  }, [year, tenantId, reportingKey, registryKey, budgetsKey, refreshKey]);

  // Nach Kostenimport-Speichern/-Löschen und VJ-Übernahme neu laden (reines Anzeige-Refresh)
  useEffect(() => {
    const onChanged = () => setRefreshKey(k => k + 1);
    window.addEventListener(REPORTING_DATA_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REPORTING_DATA_CHANGED_EVENT, onChanged);
  }, []);

  // Aggregierte Umsatz-Abdeckung (fehlende Tage zählen NIE als 0)
  const daysWithData = data ? data.monthStats.reduce((s, m) => s + m.daysWithData, 0) : 0;
  const totalDays    = data ? data.monthStats.reduce((s, m) => s + m.totalDays, 0) : 0;
  const umsatzTone   = !data || daysWithData === 0 ? 'neutral'
    : daysWithData === totalDays ? 'good' : 'warn';
  const kostenTone   = !data || data.kostenMonths === 0 ? 'neutral'
    : data.kostenMonths === 12 ? 'good' : 'warn';

  return (
    <Card className="border-border bg-card shadow-sm" data-testid="jahres-datenstand-card">
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">Datenstand Vorjahr</span>
            <span className="text-xs font-normal text-muted-foreground">– Umsatz- und Kostendaten je Jahr</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="h-7 w-[88px] text-xs" data-testid="jahres-datenstand-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map(y => (
                  <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Aktualisieren"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0 space-y-3">
        {loadError && (
          <HintBox tone="critical">
            Datenstand {year} konnte nicht geladen werden.{' '}
            <button className="underline font-medium" onClick={() => setRefreshKey(k => k + 1)}>
              Erneut versuchen
            </button>
          </HintBox>
        )}
        {!loadError && loading && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Datenstand {year} wird geladen …
          </div>
        )}
        {!loadError && !loading && data && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* ── Umsatz (Tagesdaten) ─────────────────────────────── */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2" data-testid="jd-umsatz">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                  Umsatz {year} (Tagesdaten)
                </p>
                <StatusPill tone={umsatzTone} size="xs">
                  {daysWithData === 0 ? 'Keine Daten' : `${daysWithData}/${totalDays} Tage`}
                </StatusPill>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {data.monthStats.map((m, i) => {
                  const full  = m.totalDays > 0 && m.daysWithData === m.totalDays;
                  const some  = m.daysWithData > 0 && !full;
                  return (
                    <div
                      key={i}
                      className={cn(
                        'rounded px-1 py-0.5 text-center text-[10px] tabular-nums border',
                        full && 'bg-green-50 border-green-200 text-green-700 dark:bg-green-950/20 dark:border-green-800 dark:text-green-400',
                        some && 'bg-orange-50 border-orange-200 text-orange-700 dark:bg-orange-950/20 dark:border-orange-800 dark:text-orange-400',
                        !full && !some && 'bg-muted/40 border-border/50 text-muted-foreground',
                      )}
                      title={`${JD_MONTH_LABELS[i]} ${year}: ${m.daysWithData} von ${m.totalDays} Tagen`}
                    >
                      {JD_MONTH_LABELS[i]}
                      <div className="font-medium">{m.daysWithData > 0 ? m.daysWithData : '—'}</div>
                    </div>
                  );
                })}
              </div>
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                <p>Jahres-Tagesimport (vj_daily): {data.vjDays > 0 ? `${data.vjDays} Tage` : 'keine Daten'}</p>
                <p>Erfolgsrechnung: {data.erRevenueMonths > 0 ? `${data.erRevenueMonths}/12 Monate mit Umsatz` : 'kein Umsatz übernommen'}</p>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline" size="sm" className="h-7 text-[11px]"
                  onClick={() => openImportSection('vj-tagesumsatz')}
                  data-testid="jd-link-vj-import"
                >
                  Tagesimport &amp; ER-Übernahme
                </Button>
                <Link to={`/umsatzabstimmung?year=${year}`}>
                  <Button variant="ghost" size="sm" className="h-7 text-[11px] text-muted-foreground">
                    Umsatzabstimmung {year}
                  </Button>
                </Link>
              </div>
              {data.vjDays > 0 && data.erRevenueMonths < 12 && (
                <p className="text-[11px] text-orange-700 dark:text-orange-400">
                  Tagesdaten vorhanden, aber erst {data.erRevenueMonths}/12 ER-Monate mit Umsatz —
                  Übernahme über «Tagesimport &amp; ER-Übernahme» starten.
                </p>
              )}
            </div>

            {/* ── Kosten (Buchhaltung) ────────────────────────────── */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2" data-testid="jd-kosten">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  Kosten {year} (Buchhaltung)
                </p>
                <StatusPill tone={kostenTone} size="xs">
                  {data.kostenMonths === 0 ? 'Keine Daten' : `${data.kostenMonths}/12 Monate`}
                </StatusPill>
              </div>
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                {data.registryEntry ? (
                  <>
                    <p>
                      Letzter Jahres-Import:{' '}
                      <span className="font-medium text-foreground">{data.registryEntry.fileName}</span>
                    </p>
                    <p>
                      {formatDatenstandDate(data.registryEntry.importedAt.slice(0, 10))} ·{' '}
                      {data.registryEntry.accountCount} Konten · {data.registryEntry.monthsWithData} Monate
                      {data.registryEntry.unmappedCount > 0 && (
                        <span className="text-orange-700 dark:text-orange-400"> · {data.registryEntry.unmappedCount} nicht zugeordnet</span>
                      )}
                    </p>
                  </>
                ) : (
                  <p>Kein Jahres-Kostenimport für {year} registriert.</p>
                )}
                <p>
                  Erfolgsrechnung: {data.kostenMonths > 0
                    ? `${data.kostenMonths}/12 Monate mit Kosten (${data.kostenCategories} Kategorien)`
                    : 'keine Kostendaten'}
                </p>
              </div>
              <div className="pt-1">
                <Button
                  variant="outline" size="sm" className="h-7 text-[11px]"
                  onClick={() => openImportSection('vorjahr-kosten-buchhaltung')}
                  data-testid="jd-link-sage-import"
                >
                  Zum Sage-Jahresimport
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// ─── Vollständigkeit Tagesdaten ──────────────────────────────────────────────
//
// Kompakte Kontrollkarte: prüft für einen Monat (nur vergangene Tage inkl.
// heute), wo Umsatz-, Gäste- und Durchschnittsverkauf-Tagesdaten zueinander
// fehlen. Reiner Hinweis — blockiert nichts. Grün «vollständig» wenn leer.

/** Liste von yyyy-MM-dd → «5., 12., 19.7.» (Tag mit Punkt, letzter mit Monat). */
function formatDayList(isoDates: string[]): string {
  if (isoDates.length === 0) return '';
  const sorted = [...isoDates].sort();
  return sorted
    .map((d, i) => {
      const [, m, day] = d.split('-').map(Number);
      const dayNum = Number(day);
      return i === sorted.length - 1 ? `${dayNum}.${Number(m)}.` : `${dayNum}.`;
    })
    .join(', ');
}

const VollstaendigkeitCard = () => {
  const { tenantId, tenantKey } = useTenant();
  const now = new Date();
  const [ym, setYm] = useState(() => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<{
    umsatzOhneGaeste: string[];
    gaesteOhneUmsatz: string[];
    umsatzOhneDurchschnitt: string[];
  } | null>(null);

  // Auswahl der letzten 12 Monate (aktueller Monat zuerst)
  const monthOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      opts.push({
        value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: format(d, 'MMMM yyyy', { locale: de }),
      });
    }
    return opts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      try {
        const [y, m] = ym.split('-').map(Number);
        const fromIso = `${y}-${String(m).padStart(2, '0')}-01`;
        const lastDay = endOfMonth(new Date(y, m - 1, 1)).getDate();
        const toIso = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const todayIso = format(new Date(), 'yyyy-MM-dd');

        const [umsatzMap, gaeste, avg] = await Promise.all([
          ladeUmsatzTage(tenantId, fromIso, toIso),
          loadGaesteDaily(tenantKey),
          loadAvgCheckDaily(tenantKey),
        ]);
        if (stale) return;

        // Nur vergangene Tage inkl. heute berücksichtigen.
        const inRange = (d: string) => d >= fromIso && d <= toIso && d <= todayIso;

        const umsatzTage = new Set<string>();
        for (const [d, tag] of umsatzMap) {
          if (inRange(d) && tag.gesamtBrutto > 0) umsatzTage.add(d);
        }
        const gaesteTage = new Set(
          Object.entries(gaeste).filter(([d, v]) => inRange(d) && v > 0).map(([d]) => d),
        );
        const avgTage = new Set(
          Object.entries(avg).filter(([d, v]) => inRange(d) && v > 0).map(([d]) => d),
        );

        setResult({
          umsatzOhneGaeste: [...umsatzTage].filter(d => !gaesteTage.has(d)),
          gaesteOhneUmsatz: [...gaesteTage].filter(d => !umsatzTage.has(d)),
          umsatzOhneDurchschnitt: [...umsatzTage].filter(d => !avgTage.has(d)),
        });
        setLoading(false);
      } catch (e) {
        console.warn('[VOLLSTÄNDIGKEIT] Laden fehlgeschlagen', e);
        if (!stale) { setLoadError(true); setLoading(false); }
      }
    })();
    return () => { stale = true; };
  }, [ym, tenantId, tenantKey, refreshKey]);

  const rows: { label: string; dates: string[] }[] = result ? [
    { label: 'Umsatz ohne Gäste', dates: result.umsatzOhneGaeste },
    { label: 'Gäste ohne Umsatz', dates: result.gaesteOhneUmsatz },
    { label: 'Umsatz ohne Durchschnittsverkauf', dates: result.umsatzOhneDurchschnitt },
  ] : [];
  const allComplete = result != null && rows.every(r => r.dates.length === 0);

  return (
    <Card className="border-border bg-card shadow-sm" data-testid="vollstaendigkeit-card">
      <CardHeader className="pb-2 pt-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold">Vollständigkeit Tagesdaten</span>
            <span className="text-xs font-normal text-muted-foreground">– fehlen Umsatz, Gäste oder Durchschnitt zueinander?</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={ym} onValueChange={setYm}>
              <SelectTrigger className="h-7 w-[140px] text-xs" data-testid="vollstaendigkeit-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map(o => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Aktualisieren"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-4 pt-0 space-y-2">
        {loadError && (
          <HintBox tone="critical">
            Vollständigkeit konnte nicht geladen werden.{' '}
            <button className="underline font-medium" onClick={() => setRefreshKey(k => k + 1)}>
              Erneut versuchen
            </button>
          </HintBox>
        )}
        {!loadError && loading && (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird geprüft …
          </div>
        )}
        {!loadError && !loading && result && (
          <>
            {allComplete ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-medium">Vollständig — keine fehlenden Tagesdaten in diesem Monat.</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {rows.map(r => (
                  <div
                    key={r.label}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border px-3 py-2 text-xs',
                      r.dates.length === 0
                        ? 'border-border/60 bg-muted/20'
                        : 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/10',
                    )}
                  >
                    <span className={cn('flex-none w-2 h-2 rounded-full mt-1', r.dates.length === 0 ? 'bg-emerald-500' : 'bg-amber-400')} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{r.label}</p>
                      {r.dates.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">vollständig</p>
                      ) : (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 tabular-nums">
                          {r.dates.length} {r.dates.length === 1 ? 'Tag' : 'Tage'}: {formatDayList(r.dates)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">Berücksichtigt nur vergangene Tage inkl. heute. Reiner Hinweis — blockiert nichts.</p>
          </>
        )}
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
  // UX-Vereinfachung: Sektionen sind standardmässig ZU — die 4 Gruppen-Karten
  // oben sind der Einstieg. Aufgeklappt wird per Klick, per URL-Hash (#id)
  // oder per IMPORT_SECTION_OPEN_EVENT (Gruppen-Karte „Import starten").
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' && window.location.hash === `#${id}`,
  );
  useEffect(() => {
    const onOpenEvent = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) setOpen(true);
    };
    const onHashChange = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    window.addEventListener(IMPORT_SECTION_OPEN_EVENT, onOpenEvent);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener(IMPORT_SECTION_OPEN_EVENT, onOpenEvent);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [id]);
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
  const { tenantId, tenantKey } = useTenant();
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
        tenantKey('reporting_v1'),
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
            {[currentYear - 3, currentYear - 2, currentYear - 1, currentYear].map(y => (
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
  const { tenantId, tenantKey } = useTenant();
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing]     = useState(false);
  const [result, setResult]       = useState<AnnualKostenResult | null>(null);
  const [fileName, setFileName]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState('');
  const [entries, setEntries]     = useState<AnnualCostImportEntry[]>([]);
  const [deleteYear, setDeleteYear] = useState<number | null>(null);
  const [deleting, setDeleting]   = useState(false);
  // Backup-Nachsicherung (nur auf Klick — reines Öffnen liest/schreibt nie)
  const [backupChecking, setBackupChecking] = useState(false);
  const [backupCheckError, setBackupCheckError] = useState('');
  const [backupDiff, setBackupDiff] = useState<{ missing: string[]; localCount: number; remoteCount: number } | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  // Konfliktmodus + Monatsauswahl (nur für Modus «selective»)
  const [importMode, setImportMode] = useState<AnnualCostImportMode>('replace');
  const [selectedMonths, setSelectedMonths] = useState<Set<number>>(new Set());

  const registryKey  = tenantKey(ANNUAL_COST_IMPORTS_KEY);
  const reportingKey = tenantKey(REPORTING_STORAGE_KEY);

  const refreshEntries = (key: string) => {
    loadAnnualCostImports(key).then(setEntries).catch(err => {
      console.warn('[ANNUAL-IMPORTS] Registry laden fehlgeschlagen', err);
    });
  };
  useEffect(() => { refreshEntries(registryKey); }, [registryKey]);
  // Tenant-Wechsel: Prüfergebnis verwerfen (gehört zum alten reportingKey)
  useEffect(() => { setBackupDiff(null); setBackupCheckError(''); }, [reportingKey]);

  /**
   * Vorschau-Aufbereitung: Matching gegen den Kontenplan + Kategorie-Listen
   * pro Monat + Summen (Aufwand/Ertrag) + Liste der nicht zugeordneten Konten.
   * Genau DIESE categoriesByMonth werden beim Bestätigen gespeichert.
   */
  const preview = useMemo(() => {
    if (!result || result.detectedYear === null || result.ambiguousYear) return null;
    const categoriesByMonth = new Map<number, ExpenseCategory[]>();
    const unmapped = new Map<string, { name: string; total: number }>();
    let sumExpense = 0;
    let sumIncome = 0;
    let sumUnmapped = 0;

    for (const [month, rows] of result.byMonth.entries()) {
      const mr = matchCSVRows(rows);
      categoriesByMonth.set(month, buildExpenseCategoriesOnly(mr.matched, mr.unresolved));
      for (const m of mr.matched) {
        // parsed.amount = Soll − Haben; Ertragskonten sind dort negativ
        if (m.sign === 'income') sumIncome += -m.parsed.amount;
        else sumExpense += m.parsed.amount;
      }
      for (const u of mr.unresolved) {
        sumUnmapped += u.parsed.amount;
        const prev = unmapped.get(u.parsed.accountNumber) ?? { name: u.parsed.accountName, total: 0 };
        unmapped.set(u.parsed.accountNumber, { name: prev.name, total: prev.total + u.parsed.amount });
      }
    }

    return { categoriesByMonth, unmapped, sumExpense, sumIncome, sumUnmapped };
  }, [result]);

  /**
   * Bestehende expenseCategories des Zieljahres (read-only aus localStorage) —
   * Basis für die Konto×Monat-Diff-Vorschau und die Konfliktmodi.
   * `saved` als Dependency: nach dem Speichern wäre der Bestand veraltet.
   */
  const existingByMonth = useMemo(() => {
    if (!result || result.detectedYear === null) return new Map<number, ExpenseCategory[]>();
    const map = new Map<number, ExpenseCategory[]>();
    loadYear(result.detectedYear, reportingKey).forEach((rec, i) => {
      map.set(i + 1, rec.expenseCategories ?? []);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, reportingKey, saved]);

  /** Konto×Monat-Diff (reine Logik) — Status je Zelle + deutsche Warnungen. */
  const diff = useMemo(() => {
    if (!preview) return null;
    return buildAnnualCostPreview(preview.categoriesByMonth, existingByMonth);
  }, [preview, existingByMonth]);

  /** Wirkung des gewählten Modus (Pre-Merge, geht 1:1 an den Schreib-Kern). */
  const modeResult = useMemo(() => {
    if (!preview) return null;
    return applyImportMode(importMode, preview.categoriesByMonth, existingByMonth, selectedMonths);
  }, [preview, existingByMonth, importMode, selectedMonths]);

  // Neue Datei / Tenant-Wechsel: Modus + Auswahl zurücksetzen
  useEffect(() => {
    setImportMode('replace');
    setSelectedMonths(new Set());
  }, [result, reportingKey]);

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
      if (res.failureReason) {
        // Uneindeutiges Jahr oder keine Buchungen → Import abbrechen, Grund anzeigen
        setError(res.failureReason);
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

  const handleSave = async () => {
    if (!result || !preview || !modeResult || result.detectedYear === null || result.ambiguousYear) return;
    if (importMode === 'selective' && selectedMonths.size === 0) {
      toast.error('Modus «Nur ausgewählte Monate»: Bitte mindestens einen Monat auswählen.');
      return;
    }
    setSaving(true);
    try {
      const year = result.detectedYear;
      // Undo-Snapshot VOR dem Schreiben: bisherige expenseCategories aller
      // Monate des Zieljahres, die der Import anfassen KÖNNTE (Datei-Kategorien
      // vorhanden ODER bestehende numerische Konten). null = Monat existierte nicht.
      const undoMonths: Array<{ monthId: string; fields: Record<string, unknown | null> }> = [];
      try {
        const priorYearRecords = new Map(loadYear(year, reportingKey).map(r => [r.month, r]));
        for (let m = 1; m <= 12; m++) {
          const rec = priorYearRecords.get(m);
          const newCats = modeResult.effective.get(m) ?? [];
          // gleiche Definition wie NUMERIC_ACCOUNT_RE in reporting-store.ts
          const hadNumeric = (rec?.expenseCategories ?? []).some(c => /^\d{3,5}$/.test(c.categoryId));
          if (newCats.length === 0 && !hadNumeric) continue;
          undoMonths.push({
            monthId: `${year}-${String(m).padStart(2, '0')}`,
            fields: { expenseCategories: rec?.expenseCategories ? JSON.parse(JSON.stringify(rec.expenseCategories)) : null },
          });
        }
      } catch (err) {
        console.warn('[ANNUAL-IMPORTS] Undo-Snapshot fehlgeschlagen (Import läuft weiter):', err);
      }
      const { monthsWritten, monthsCleared, monthsUnchanged, kvBackup } = replaceAnnualCostYear(
        year,
        modeResult.effective,
        { fileName },
        reportingKey,
      );
      await upsertAnnualCostImport(registryKey, {
        year,
        fileName,
        importedAt: new Date().toISOString(),
        periodFrom: result.periodFrom,
        periodTo: result.periodTo,
        accountCount: result.accountCount,
        bookingCount: result.bookingCount,
        monthsWithData: result.byMonth.size,
        unmappedCount: preview.unmapped.size,
        skippedOutOfYear: result.skippedOutOfYear,
        sumExpense: preview.sumExpense,
        sumIncome: preview.sumIncome,
        mode: importMode,
        monthsSkipped: modeResult.monthsSkipped.length,
      });
      refreshEntries(registryKey);
      notifyReportingDataChanged();
      setSaved(true);
      // Import-Protokoll (Letzter Import + Rückgängig) — best-effort.
      try {
        await recordImportRun(tenantId, {
          source: 'vorjahr-kosten-buchhaltung',
          periodLabel: `Jahr ${year}`,
          itemCount: monthsWritten + monthsCleared,
          itemLabel: 'Monate',
          fileName: fileName || undefined,
          details: `${result.accountCount} Konten, ${result.bookingCount} Buchungen`,
          ...(undoMonths.length > 0 ? { snapshot: { kind: 'reporting-fields', storeKey: reportingKey, months: undoMonths } } : {}),
        });
      } catch (err) {
        console.error('[ANNUAL-IMPORTS] Import-Protokoll fehlgeschlagen:', err);
        toast.warning('Import-Protokoll konnte nicht gespeichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.');
      }
      toast.success(
        `Jahr ${year}: ${monthsWritten} Monate gespeichert` +
        (monthsCleared > 0 ? `, ${monthsCleared} Monate von alten Kontodaten bereinigt` : '') +
        (monthsUnchanged > 0 ? `, ${monthsUnchanged} Monate unverändert (kein Write)` : '') +
        (modeResult.monthsSkipped.length > 0
          ? ` — ${modeResult.monthsSkipped.length} Datei-Monat(e) wegen Modus übersprungen`
          : ''),
      );
      const backup = await kvBackup;
      if (backup.failedMonths.length > 0) {
        const failed = backup.failedMonths;
        void notifyKVBackupProblem(backup.lastError, `Kosten-Import ${year} (${failed.length} Monat(e))`, {
          toastId: `annual-cost-backup-${year}`,
          retry: async () => {
            const res = await retryReportingMonthsBackup(failed, reportingKey);
            if (res.failedMonths.length > 0) {
              throw res.lastError ?? new Error(`${res.failedMonths.length} Monat(e) weiterhin nicht gesichert`);
            }
            toast.success(`Supabase-Backup vervollständigt (${failed.length} Monat(e) nachgesichert).`);
          },
        });
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (deleteYear === null) return;
    setDeleting(true);
    try {
      const res = removeAnnualCostYear(deleteYear, {}, reportingKey);
      await markAnnualCostImportDeleted(registryKey, deleteYear);
      refreshEntries(registryKey);
      notifyReportingDataChanged();
      toast.success(`Jahr ${deleteYear}: Kontodaten aus ${res.monthsCleared} Monaten entfernt`);
      const backup = await res.kvBackup;
      if (backup.failedMonths.length > 0) {
        const failed = backup.failedMonths;
        void notifyKVBackupProblem(backup.lastError, `Kosten-Löschung ${deleteYear} (${failed.length} Monat(e))`, {
          toastId: `annual-cost-delete-backup-${deleteYear}`,
          retry: async () => {
            const retryRes = await retryReportingMonthsBackup(failed, reportingKey);
            if (retryRes.failedMonths.length > 0) {
              throw retryRes.lastError ?? new Error(`${retryRes.failedMonths.length} Monat(e) weiterhin nicht aktualisiert`);
            }
            toast.success(`Supabase-Backup vervollständigt (${failed.length} Monat(e) aktualisiert).`);
          },
        });
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.');
    } finally {
      setDeleting(false);
      setDeleteYear(null);
    }
  };

  /**
   * Backup-Prüfung (E): NUR auf Klick — vergleicht den lokalen reporting_v1-Stand
   * mit dem Supabase-KV (strict read: Lesefehler sieht NIE wie «Remote leer» aus).
   * Reparaturkandidaten sind ausschliesslich Monate, die lokal existieren und
   * remote FEHLEN; tombstoned Monate (deleted:true) sind gewollte Löschungen und
   * werden nie gelistet. Inhaltliche Unterschiede werden bewusst NICHT angefasst
   * (kein stilles Überschreiben des Remote-Stands).
   */
  const handleBackupCheck = async () => {
    setBackupChecking(true);
    setBackupCheckError('');
    setBackupDiff(null);
    try {
      const remote = asRecordBlob(await kvGetStrict(reportingKey));
      const local = readLocalRecord(reportingKey);
      // Kandidaten-Berechnung zentral (reine Logik, identisch getestet):
      setBackupDiff(computeBackupRepairCandidates(local, remote));
    } catch (e: unknown) {
      setBackupCheckError(
        e instanceof Error && e.message
          ? `Supabase-Stand konnte nicht gelesen werden: ${e.message}`
          : 'Supabase-Stand konnte nicht gelesen werden (offline oder nicht konfiguriert).',
      );
    } finally {
      setBackupChecking(false);
    }
  };

  /** Nachsicherung: schreibt NUR die bestätigten, remote fehlenden Monate (sequenziell, read→merge→write). */
  const handleBackupRepair = async () => {
    if (!backupDiff || backupDiff.missing.length === 0) return;
    const toRepair = backupDiff.missing;
    setBackingUp(true);
    try {
      const res = await retryReportingMonthsBackup(toRepair, reportingKey);
      if (res.failedMonths.length > 0) {
        setBackupDiff({ ...backupDiff, missing: res.failedMonths });
        void notifyKVBackupProblem(res.lastError, `Nachsicherung (${res.failedMonths.length} Monat(e))`, {
          toastId: 'reporting-backup-repair',
          retry: async () => {
            const again = await retryReportingMonthsBackup(res.failedMonths, reportingKey);
            if (again.failedMonths.length > 0) {
              throw again.lastError ?? new Error(`${again.failedMonths.length} Monat(e) weiterhin nicht gesichert`);
            }
            setBackupDiff(prev => (prev ? { ...prev, missing: [] } : prev));
            toast.success('Supabase-Backup vervollständigt.');
          },
        });
      } else {
        setBackupDiff({ ...backupDiff, missing: [] });
        toast.success(`${toRepair.length} Monat(e) ins Supabase-Backup nachgesichert.`);
      }
    } finally {
      setBackingUp(false);
    }
  };

  const fmtChf = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 }).format(v);

  const unmappedList = preview ? Array.from(preview.unmapped.entries()) : [];

  return (
    <div className="space-y-3">
      {/* Letzter Import + Rückgängig + Historie (Import-Center-Spec) */}
      <LastImportPanel
        source="vorjahr-kosten-buchhaltung"
        undoHint="Zurückgesetzt werden die Konto-Kategorien (Kostenzeilen) der betroffenen Monate des Import-Jahres. Manuell erfasste Kategorien und andere Felder bleiben unberührt."
      />
      {/* Immer gerendert, damit «Ersetzen» in der Verwaltungstabelle den Dateidialog öffnen kann */}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
      />

      {!result && !parsing && (
        <div
          data-testid="annual-import-dropzone"
          className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-5 text-center cursor-pointer hover:bg-gray-50/50 dark:hover:bg-gray-900/20 transition-colors"
          onClick={() => fileRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-gray-400" />
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            Excel-Datei hierher ziehen oder klicken
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            .xlsx · Sage Kontoblatt (Jahresexport, z.B. 01.01.25 – 31.12.25)
          </p>
        </div>
      )}

      {parsing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          Datei wird analysiert…
        </div>
      )}

      {error && (
        <div data-testid="annual-import-error" className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {result && preview && !saved && (
        <div className="space-y-2" data-testid="annual-import-preview">
          {/* Jahr-Bestätigung + Zeitraum */}
          <div className="rounded border bg-muted/30 p-2 space-y-1">
            <p className="text-xs">
              <span className="font-semibold">Geschäftsjahr {result.detectedYear}</span>{' '}
              <span className="text-muted-foreground">
                ({result.yearSource === 'period'
                  ? `aus Dateizeitraum ${result.periodFrom ?? '?'} – ${result.periodTo ?? '?'}`
                  : 'aus den Buchungsdaten abgeleitet'})
              </span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              <em>{fileName}</em> · {result.byMonth.size} Monate · {result.accountCount} Konten ·{' '}
              {result.bookingCount} Buchungen
              {result.skippedOutOfYear > 0 && (
                <span className="text-orange-600 dark:text-orange-400">
                  {' '}· {result.skippedOutOfYear} Buchung(en) ausserhalb {result.detectedYear} übersprungen
                </span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              Summe Aufwand: <span className="font-medium">{fmtChf(Math.round(preview.sumExpense))} CHF</span>
              {' '}· Summe Ertrag (FIBU): <span className="font-medium">{fmtChf(Math.round(preview.sumIncome))} CHF</span>
              {preview.sumUnmapped !== 0 && (
                <> · davon unzugeordnet: <span className="font-medium">{fmtChf(Math.round(preview.sumUnmapped))} CHF</span></>
              )}
            </p>
          </div>

          {/* Nicht zugeordnete Konten */}
          {unmappedList.length > 0 && (
            <div
              data-testid="annual-import-unmapped"
              className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20 p-2 space-y-1"
            >
              <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                {unmappedList.length} Konto/Konten ohne Zuordnung im Kontenplan — werden als
                «[Unzugeordnet]» importiert und in der Erfolgsrechnung als Übriger Aufwand geführt:
              </p>
              <ul className="text-[11px] text-amber-800/90 dark:text-amber-300/90 space-y-0.5 max-h-28 overflow-auto">
                {unmappedList.map(([acc, info]) => (
                  <li key={acc} className="tabular-nums">
                    {acc} {info.name} — {fmtChf(Math.round(info.total))} CHF
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Vorschau: Gesamtkosten pro Monat */}
          <div className="rounded border text-[11px] overflow-auto">
            <table className="w-full min-w-[480px]">
              <thead className="bg-muted">
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
                        {fmtChf(Math.round(total))}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>

          {/* Validierungshinweise aus der Diff-Vorschau (reine Logik) */}
          {diff && diff.warnings.length > 0 && (
            <div data-testid="annual-import-warnings">
              <HintBox tone="warn" title="Prüfhinweise zur Datei">
                <ul className="list-disc pl-4 space-y-0.5">
                  {diff.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </HintBox>
            </div>
          )}

          {/* Konto×Monat-Diff gegen den Bestand */}
          {diff && diff.rows.length > 0 && (
            <div data-testid="annual-import-diff-table" className="rounded border text-[11px] overflow-auto max-h-96">
              <table className="w-full min-w-[900px]">
                <thead className="sticky top-0 z-10 bg-gray-100 dark:bg-gray-800">
                  <tr>
                    <th className="text-left py-1 px-2 font-medium whitespace-nowrap">Konto</th>
                    {MONTH_LABELS.map(m => (
                      <th key={m} className="text-right py-1 px-1 font-medium">{m}</th>
                    ))}
                    <th className="text-right py-1 px-2 font-medium">Total neu</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.map(row => (
                    <tr key={row.accountNumber} className="border-t">
                      <td className={cn(
                        'py-0.5 px-2 whitespace-nowrap max-w-[220px] truncate',
                        row.isRevenueAccount && 'text-orange-700 dark:text-orange-400 font-medium',
                        row.unmapped && 'text-amber-700 dark:text-amber-400',
                      )} title={`${row.accountNumber} ${row.label}`}>
                        {row.accountNumber} {row.label}
                        {row.isRevenueAccount && ' ⚠'}
                      </td>
                      {row.cells.map(cell => (
                        <td key={cell.month} className={cn(
                          'text-right py-0.5 px-1 tabular-nums whitespace-nowrap',
                          cell.status === null && 'text-muted-foreground/40',
                          cell.status === 'identisch' && 'text-muted-foreground',
                          cell.status === 'neu' && 'text-green-700 dark:text-green-400',
                          cell.status === 'ueberschreiben' && 'text-orange-700 dark:text-orange-400 font-medium',
                          cell.status === 'entfernt' && 'text-red-600 dark:text-red-400 line-through',
                        )}
                          title={
                            cell.status === 'ueberschreiben'
                              ? `Bestand ${Math.round(cell.existingAmount ?? 0)} → neu ${Math.round(cell.newAmount ?? 0)}`
                              : cell.status === 'entfernt'
                                ? `Bestand ${Math.round(cell.existingAmount ?? 0)} — nicht in der Datei`
                                : undefined
                          }
                        >
                          {cell.status === 'entfernt'
                            ? fmtChf(Math.round(cell.existingAmount ?? 0))
                            : cell.newAmount !== null ? fmtChf(Math.round(cell.newAmount)) : '—'}
                        </td>
                      ))}
                      <td className="text-right py-0.5 px-2 tabular-nums font-medium">
                        {fmtChf(Math.round(row.newTotal))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {diff && diff.rows.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              Legende: <span className="text-green-700 dark:text-green-400">neu</span> ·{' '}
              <span>identisch (grau)</span> ·{' '}
              <span className="text-orange-700 dark:text-orange-400 font-medium">überschreibt Bestand</span> ·{' '}
              <span className="text-red-600 dark:text-red-400 line-through">Bestand würde entfernt</span> — fehlend = «—», nie 0.
            </p>
          )}

          {/* Konfliktmodus */}
          {diff && (
            <div data-testid="annual-import-mode" className="rounded border p-2 space-y-2">
              <p className="text-xs font-medium">
                Umgang mit bestehenden Kontodaten
                {diff.monthsWithExistingData.length > 0 && (
                  <span className="text-muted-foreground font-normal">
                    {' '}({diff.monthsWithExistingData.length} Monat(e) mit Bestand)
                  </span>
                )}
              </p>
              <RadioGroup
                value={importMode}
                onValueChange={v => setImportMode(v as AnnualCostImportMode)}
                className="gap-1.5"
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="replace" id="acm-replace" className="mt-0.5" data-testid="annual-import-mode-replace" />
                  <Label htmlFor="acm-replace" className="text-xs font-normal cursor-pointer">
                    <span className="font-medium">Ersetzen (Standard)</span> — Datei-Stand ersetzt alle
                    Konto-Kategorien des Jahres{diff.clearedMonths.length > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        ; bestehende Kontodaten in {diff.clearedMonths.length} Monat(en) ohne Datei-Daten werden entfernt
                      </span>
                    )}.
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="keep-existing" id="acm-keep" className="mt-0.5" data-testid="annual-import-mode-keep" />
                  <Label htmlFor="acm-keep" className="text-xs font-normal cursor-pointer">
                    <span className="font-medium">Bestehende Werte behalten</span> — vorhandene Konto-Werte
                    bleiben; nur bisher fehlende Konten werden aus der Datei ergänzt.
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="fill-empty" id="acm-fill" className="mt-0.5" data-testid="annual-import-mode-fill" />
                  <Label htmlFor="acm-fill" className="text-xs font-normal cursor-pointer">
                    <span className="font-medium">Nur leere Monate füllen</span> — nur Monate ohne bestehende
                    Kontodaten erhalten Datei-Daten; Monate mit Bestand bleiben unangetastet.
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="selective" id="acm-selective" className="mt-0.5" data-testid="annual-import-mode-selective" />
                  <Label htmlFor="acm-selective" className="text-xs font-normal cursor-pointer">
                    <span className="font-medium">Nur ausgewählte Monate</span> — nur die gewählten Monate
                    werden mit dem Datei-Stand ersetzt; übrige bleiben unangetastet.
                  </Label>
                </div>
              </RadioGroup>
              {importMode === 'selective' && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 pl-6" data-testid="annual-import-month-select">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                    const inFile = diff.monthsInFile.includes(m);
                    return (
                      <label key={m} className={cn(
                        'flex items-center gap-1 text-[11px] cursor-pointer',
                        !inFile && 'text-muted-foreground/50',
                      )}>
                        <Checkbox
                          checked={selectedMonths.has(m)}
                          disabled={!inFile}
                          onCheckedChange={checked => {
                            setSelectedMonths(prev => {
                              const nextSel = new Set(prev);
                              if (checked === true) nextSel.add(m); else nextSel.delete(m);
                              return nextSel;
                            });
                          }}
                          className="h-3.5 w-3.5"
                        />
                        {MONTH_LABELS[m - 1]}
                      </label>
                    );
                  })}
                </div>
              )}
              {modeResult && modeResult.monthsSkipped.length > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="annual-import-mode-skipped">
                  Wirkung: Datei-Daten von {modeResult.monthsSkipped.length} Monat(en) werden wegen des
                  Modus nicht angewendet ({modeResult.monthsSkipped.map(m => MONTH_LABELS[m - 1]).join(', ')});
                  unangetastete Monate bleiben ohne Änderung (kein Write, kein Zeitstempel-Bump).
                </p>
              )}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">
            Beim Bestätigen werden die Konto-Kategorien des Jahres {result.detectedYear} gemäss dem
            gewählten Modus geschrieben (wiederholbarer Import, keine Duplikate; unveränderte Monate
            sind ein No-op). Gastronovi-Umsatz, Personalkosten-Direktwerte und manuelle Kategorien
            bleiben unberührt.
          </p>

          {result.detectedYear !== null && (() => {
            const otherYears = yearsWithData(reportingKey).filter(y => y !== result.detectedYear);
            return (
              <div data-testid="annual-import-year-scope-hint">
                <HintBox tone="info" title={`Schreibschutz: Nur Jahr ${result.detectedYear} wird verändert`}>
                  Es werden ausschliesslich Daten des Jahres {result.detectedYear} importiert.{' '}
                  {otherYears.length > 0
                    ? `Bereits vorhandene Daten der Jahre ${otherYears.join(', ')} bleiben unverändert.`
                    : 'Bereits vorhandene Daten anderer Jahre bleiben unverändert.'}{' '}
                  Eine automatische Integritätsprüfung bricht den Import ab, bevor etwas gespeichert
                  wird, falls Daten anderer Jahre verändert würden.
                </HintBox>
              </div>
            );
          })()}

          <div className="flex gap-2">
            <Button
              size="sm" className="h-8 text-xs"
              onClick={handleSave}
              disabled={saving || (importMode === 'selective' && selectedMonths.size === 0)}
              data-testid="annual-import-confirm"
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Import bestätigen (Jahr {result.detectedYear})
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
        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-400" data-testid="annual-import-saved">
          <CheckCircle2 className="h-4 w-4" />
          Daten gespeichert.{' '}
          <button className="underline" onClick={() => { setResult(null); setFileName(''); setSaved(false); }}>
            Weitere Datei importieren
          </button>
        </div>
      )}

      {/* ── Import-Verwaltung: importierte Geschäftsjahre ── */}
      {entries.length > 0 && (
        <div className="space-y-1 pt-1" data-testid="annual-import-registry">
          <p className="text-[11px] font-medium text-muted-foreground">Importierte Geschäftsjahre</p>
          <div className="rounded border text-[11px] overflow-auto">
            <table className="w-full min-w-[560px]">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left py-1 px-2 font-medium">Jahr</th>
                  <th className="text-left py-1 px-2 font-medium">Datei</th>
                  <th className="text-left py-1 px-2 font-medium">Importiert</th>
                  <th className="text-right py-1 px-2 font-medium">Konten</th>
                  <th className="text-right py-1 px-2 font-medium">Buchungen</th>
                  <th className="text-right py-1 px-2 font-medium">Monate</th>
                  <th className="text-left py-1 px-2 font-medium">Status</th>
                  <th className="text-right py-1 px-2 font-medium">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.year} className="border-t" data-testid={`annual-import-row-${e.year}`}>
                    <td className="py-1 px-2 font-medium tabular-nums">{e.year}</td>
                    <td className="py-1 px-2 max-w-[180px] truncate" title={e.fileName}>{e.fileName}</td>
                    <td className="py-1 px-2 whitespace-nowrap">
                      {e.importedAt ? format(parseISO(e.importedAt), 'dd.MM.yyyy HH:mm', { locale: de }) : '—'}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums">{e.accountCount}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{e.bookingCount}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{e.monthsWithData}</td>
                    <td className="py-1 px-2">
                      {e.unmappedCount > 0 ? (
                        <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20">
                          {e.unmappedCount} unzugeordnet
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] border-green-300 text-green-700 bg-green-50 dark:bg-green-950/20">
                          vollständig
                        </Badge>
                      )}
                    </td>
                    <td className="py-1 px-2 text-right whitespace-nowrap">
                      <Button
                        size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                        onClick={() => { setResult(null); setSaved(false); setError(''); fileRef.current?.click(); }}
                        data-testid={`annual-import-replace-${e.year}`}
                      >
                        <RefreshCw className="h-3 w-3 mr-1" />
                        Ersetzen
                      </Button>
                      <Button
                        size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-600 hover:text-red-700"
                        onClick={() => setDeleteYear(e.year)}
                        data-testid={`annual-import-delete-${e.year}`}
                      >
                        Löschen
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Backup-Prüfung & Nachsicherung (E): nur Admin, nie Gast, nur auf Klick ── */}
      {isAdmin && !isGuest && (
        <div className="space-y-2 pt-1" data-testid="reporting-backup-check">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-medium text-muted-foreground">Supabase-Backup der Erfolgsrechnung</p>
            <Button
              size="sm" variant="outline" className="h-7 text-[11px]"
              onClick={handleBackupCheck} disabled={backupChecking || backingUp}
              data-testid="reporting-backup-check-button"
            >
              {backupChecking
                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                : <RefreshCw className="h-3 w-3 mr-1" />}
              Backup prüfen
            </Button>
          </div>
          {backupCheckError && (
            <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400" data-testid="reporting-backup-check-error">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{backupCheckError}</span>
            </div>
          )}
          {backupDiff && backupDiff.missing.length === 0 && (
            <p className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1.5" data-testid="reporting-backup-check-ok">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Backup vollständig: alle {backupDiff.localCount} lokalen Monate sind im Supabase-KV vorhanden
              ({backupDiff.remoteCount} Monate remote).
            </p>
          )}
          {backupDiff && backupDiff.missing.length > 0 && (
            <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/20 p-2 space-y-2" data-testid="reporting-backup-diff">
              <p className="text-[11px] text-amber-800 dark:text-amber-300">
                <span className="font-medium">{backupDiff.missing.length} Monat(e) lokal vorhanden, aber nicht im Supabase-Backup:</span>{' '}
                <span className="tabular-nums">{backupDiff.missing.join(', ')}</span>
              </p>
              <p className="text-[10px] text-amber-800/80 dark:text-amber-300/80">
                Die Nachsicherung schreibt ausschliesslich diese fehlenden Monate ins Backup
                (read→merge→write pro Monat). Bereits vorhandene Remote-Monate werden nicht verändert.
              </p>
              <Button
                size="sm" className="h-7 text-[11px]"
                onClick={handleBackupRepair} disabled={backingUp}
                data-testid="reporting-backup-repair-button"
              >
                {backingUp
                  ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  : <CheckCircle2 className="h-3 w-3 mr-1" />}
                {backupDiff.missing.length} Monat(e) nachsichern
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Lösch-Bestätigung ── */}
      <AlertDialog open={deleteYear !== null} onOpenChange={open => { if (!open) setDeleteYear(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Jahres-Import {deleteYear} löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Entfernt alle importierten Konto-Kategorien des Jahres {deleteYear} aus der
              Erfolgsrechnung (alle 12 Monate). Gastronovi-Umsatz, Personalkosten-Direktwerte und
              manuell erfasste Kategorien bleiben erhalten. Die Aktion kann durch einen erneuten
              Import rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
              data-testid="annual-import-delete-confirm"
            >
              {deleting ? 'Wird gelöscht…' : 'Endgültig löschen'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

// ─── Ist-Stunden Import ───────────────────────────────────────────────────────

/**
 * «Offene Stunden» — geparkte MIRUS-Einträge ohne Mitarbeiter-Zuordnung.
 * Badge zeigt die Anzahl offener Einträge, damit sie nicht vergessen gehen.
 */
const OpenHoursSectionCard = () => {
  const openCount = useOpenParkedCount();
  return (
    <Section
      id="offene-stunden"
      title="Offene Stunden"
      subtitle="Geparkte MIRUS-Stunden ohne Mitarbeiter-Zuordnung — hier nachträglich zuweisen"
      icon={<Clock className="h-4 w-4" />}
      color="border-sky-400 dark:border-sky-600"
      badge={openCount > 0 ? `${openCount} offene Einträge` : 'keine offenen'}
      badgeColor={openCount > 0
        ? 'border-sky-300 text-sky-700 bg-sky-50 dark:bg-sky-950/20'
        : 'border-slate-300 text-slate-600 bg-slate-50 dark:bg-slate-950/20'}
    >
      <OpenHoursSection />
    </Section>
  );
};

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
      {/* Letzter MIRUS-Import (Dienstplan-Abgleich) + Rückgängig + Historie */}
      <LastImportPanel
        source="mirus-ist"
        undoHint="Zurückgesetzt werden die Ist-Stunden des Import-Monats auf den Stand vor dem Import (aus dem Backup). Zusätzlich werden die aus diesem Import geparkten «Offene Stunden»-Einträge entfernt. Namenszuordnungen (Aliasse) bleiben erhalten."
      />
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

// ─── Kombinierter Tagesdaten-Import (Auto-Typerkennung) ──────────────────────
//
// EINE Upload-Zone für alle vier Tagesdaten-Excel-Typen (Umsatz, Marketing,
// Gäste, Durchschnittsverkauf). Ablauf: Datei wählen → Auto-Erkennung + Parsen
// mit gewähltem Jahr → VORSCHAU → Nutzer bestätigt → Speichern. Vor Bestätigung
// wird NICHTS gespeichert. Nutzt die bestehenden Parser/Speicherpfade.

const TYP_LABEL: Record<TagesdatenTyp, string> = {
  umsatz:       'Umsatz (Ist / Vorjahr)',
  marketing:    'Marketing-Umsatz',
  gaeste:       'Gäste',
  durchschnitt: 'Durchschnittsverkauf',
};

const TYP_BADGE: Record<TagesdatenTyp, string> = {
  umsatz:       'border-green-300 text-green-700 bg-green-50 dark:bg-green-950/20',
  marketing:    'border-violet-300 text-violet-700 bg-violet-50 dark:bg-violet-950/20',
  gaeste:       'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20',
  durchschnitt: 'border-amber-300 text-amber-700 bg-amber-50 dark:bg-amber-950/20',
};

/** Vorschau-Datenmodell (nach Parsen, vor Speichern). */
interface TagesdatenPreview {
  typ: TagesdatenTyp;
  year: number;
  daily: Record<string, number>;   // ISO → Wert (für gaeste/durchschnitt/marketing)
  umsatzRows?: GastronoviDayResult[]; // nur für umsatz
  dates: string[];                 // sortierte ISO-Tage mit Wert
  from: string | null;
  to: string | null;
  /** Monatstotale je betroffenem Monat: 'YYYY-MM' → aufbereiteter Wert */
  monthTotals: { month: string; value: number }[];
  /** Info zur Zeitraum-Zelle (nur gaeste) */
  zeitraum?: number | null;
  tagessumme?: number;
  /** Ungültige Datumsspalten (z.B. «29.02.» im Nicht-Schaltjahr) — vom Import ausgeschlossen. */
  invalidDates?: string[];
}

function TagesdatenImportSection() {
  const { tenantId, tenantKey } = useTenant();
  const [year, setYear] = useState(currentYear);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'parsing' | 'preview' | 'saving' | 'error'>('idle');
  const [preview, setPreview] = useState<TagesdatenPreview | null>(null);
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const yearOptions: number[] = [];
  for (let y = currentYear; y >= 2023; y--) yearOptions.push(y);

  const isCHF = (t: TagesdatenTyp) => t === 'umsatz' || t === 'marketing' || t === 'durchschnitt';
  const fmtValueByTyp = (t: TagesdatenTyp, n: number) =>
    t === 'gaeste'
      ? `${n.toLocaleString('de-CH')} P.`
      : `CHF ${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const reset = () => {
    setFile(null);
    setPreview(null);
    setStatus('idle');
    setError('');
    setWarn('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return format(new Date(y, m - 1, 1), 'MMMM yyyy', { locale: de });
  };

  const handleParse = async () => {
    if (!file) return;
    setStatus('parsing');
    setError('');
    setWarn('');
    try {
      const typ = await detectTagesdatenTypFromFile(file);
      if (typ == null) {
        setError('Dateityp nicht erkannt — nichts importiert. Bitte prüfe das Format (Zeile «Gesamt»/«Food»/«marketing»/«Durchschnitt» + Datumsspalten «TT.MM.»).');
        setStatus('error');
        return;
      }

      // Datumsspalten gegen echte Kalenderdaten validieren (29.02. nur in
      // Schaltjahren, 31.04. nie, …). Ungültige Spalten werden gelistet und vom
      // Import ausgeschlossen (nicht stillschweigend verworfen).
      const rawRows = await readFirstSheetRows(file);
      const headerRow = rawRows[0] ?? [];
      const invalidDates: string[] = [];
      const validIsoSet = new Set<string>();
      for (const h of headerRow) {
        const s = String(h ?? '').trim();
        if (!/^\d{1,2}\.\d{1,2}\.?$/.test(s)) continue; // keine TT.MM.-Spalte
        const iso = isoFromDayMonth(s, year);
        if (iso == null) invalidDates.push(formatInvalidDayMonth(s));
        else validIsoSet.add(iso);
      }

      let daily: Record<string, number> = {};
      let umsatzRows: GastronoviDayResult[] | undefined;
      let zeitraum: number | null | undefined;
      let tagessumme: number | undefined;

      if (typ === 'gaeste') {
        const r = await parseGaesteXlsx(file, year);
        daily = r.daily; zeitraum = r.zeitraum; tagessumme = r.tagessumme;
        if (r.zeitraum != null && r.zeitraum !== r.tagessumme) {
          setWarn(`Zeitraum-Spalte der Datei: ${r.zeitraum.toLocaleString('de-CH')} P. — abweichend, Tageswerte sind massgeblich.`);
        }
      } else if (typ === 'durchschnitt') {
        const r = await parseDurchschnittXlsx(file, year);
        daily = r.daily; zeitraum = r.zeitraum;
      } else if (typ === 'marketing') {
        const r = await parseMaisonXlsx(file, year);
        daily = r.daily;
      } else {
        // umsatz
        const rows = await parseGastronoviExcel(file, year);
        if (!rows || rows.length === 0) {
          setError('Keine Umsatz-Tagesdaten erkannt. Bitte prüfe das Dateiformat (Spaltenköpfe «01.01.», «02.01.» usw.).');
          setStatus('error');
          return;
        }
        umsatzRows = rows.filter(r => r.total > 0);
        daily = Object.fromEntries(umsatzRows.map(r => [r.date, r.total]));
      }

      // Ungültige Datumsspalten vom Import ausschliessen: nur ISO-Tage behalten,
      // die einer gültigen «TT.MM.»-Kopfspalte im gewählten Jahr entsprechen.
      // (Fängt auch von Parsern gerollte Daten wie 29.02.→01.03. ab.)
      if (invalidDates.length > 0) {
        daily = Object.fromEntries(Object.entries(daily).filter(([iso]) => validIsoSet.has(iso)));
        if (umsatzRows) umsatzRows = umsatzRows.filter(r => validIsoSet.has(r.date));
      }

      const dates = (umsatzRows ? umsatzRows.map(r => r.date) : Object.keys(daily)).sort();
      if (dates.length === 0) {
        setError(
          invalidDates.length > 0
            ? `Keine gültigen Tage: alle Datumsspalten ungültig (${invalidDates.join(', ')}). Bitte Jahr/Datei prüfen.`
            : 'Keine Tage mit Werten in der Datei gefunden.',
        );
        setStatus('error');
        return;
      }

      if (invalidDates.length > 0) {
        const msg = `${invalidDates.length} ungültige Datumsspalte${invalidDates.length === 1 ? '' : 'n'} übersprungen: ${invalidDates.join(', ')}`;
        setWarn(w => (w ? `${w} · ${msg}` : msg));
      }

      // Monatstotale je betroffenem Monat
      const monthMap = new Map<string, number>();
      if (typ === 'umsatz' && umsatzRows) {
        // Netto gesamt pro Monat (kanonische Umsatzformel)
        const byMonth = new Map<string, UmsatzTag[]>();
        for (const r of umsatzRows) {
          const ym = r.date.slice(0, 7);
          const tag: UmsatzTag = {
            datum: r.date,
            gesamtBrutto: r.total,
            takeAwayBrutto: r.takeAway,
            foodBrutto: r.food,
            beverageBrutto: r.beverage,
            marketingNetto: 0,
          };
          if (!byMonth.has(ym)) byMonth.set(ym, []);
          byMonth.get(ym)!.push(tag);
        }
        for (const [ym, tage] of byMonth) monthMap.set(ym, summiereUmsatz(tage).netto);
      } else if (typ === 'durchschnitt') {
        // Ø je Monat (Mittelwert der Tageswerte)
        const acc = new Map<string, { sum: number; n: number }>();
        for (const d of dates) {
          const ym = d.slice(0, 7);
          const a = acc.get(ym) ?? { sum: 0, n: 0 };
          a.sum += daily[d]; a.n += 1; acc.set(ym, a);
        }
        for (const [ym, a] of acc) monthMap.set(ym, a.n > 0 ? a.sum / a.n : 0);
      } else {
        // gaeste / marketing → Summe je Monat
        for (const d of dates) {
          const ym = d.slice(0, 7);
          monthMap.set(ym, (monthMap.get(ym) ?? 0) + daily[d]);
        }
      }
      const monthTotals = [...monthMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, value]) => ({ month, value }));

      setPreview({
        typ, year, daily, umsatzRows,
        dates, from: dates[0] ?? null, to: dates.at(-1) ?? null,
        monthTotals, zeitraum, tagessumme,
        invalidDates: invalidDates.length > 0 ? invalidDates : undefined,
      });
      setStatus('preview');
    } catch (e) {
      setError('Fehler beim Lesen der Datei: ' + String(e instanceof Error ? e.message : e));
      setStatus('error');
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setStatus('saving');
    try {
      const { typ, daily, umsatzRows } = preview;
      if (typ === 'gaeste') {
        await saveGaesteDaily(tenantKey, daily);
        toast.success(`Gäste gespeichert: ${preview.dates.length} Tage, ${fmtValueByTyp('gaeste', preview.tagessumme ?? 0)} gesamt`);
      } else if (typ === 'durchschnitt') {
        const monthKey = preview.from ? preview.from.slice(0, 7) : `${preview.year}-01`;
        await saveAvgCheck(
          tenantKey,
          daily,
          preview.zeitraum != null ? { [monthKey]: preview.zeitraum } : null,
        );
        toast.success(`Durchschnittsverkauf gespeichert: ${preview.dates.length} Tage`);
      } else if (typ === 'marketing') {
        await saveMaisonDaily(tenantKey, daily);
        if (!getMaisonEnabledSync(tenantKey)) await saveMaisonEnabled(tenantKey, true);
        const total = preview.monthTotals.reduce((s, m) => s + m.value, 0);
        toast.success(`Marketing-Umsatz gespeichert: ${preview.dates.length} Tage, CHF ${total.toLocaleString('de-CH', { maximumFractionDigits: 0 })}`);
      } else {
        // umsatz — Modus anhand gewähltem Jahr (Ist vs. Vorjahr)
        const target = targetForYear(preview.year, currentYear);
        const storageKey = tenantKey('dailyBudgets');
        // commitGastronoviDays prüft im Vorjahr-Modus die Jahres-Sperre (wie
        // VjDailyImportSection) und schreibt bei Sperre nichts.
        const res = await commitGastronoviDays(storageKey, umsatzRows ?? [], target, { tenantId, year: preview.year });
        if (res.blocked) {
          setError(
            `Jahr ${res.lockedYear ?? preview.year} ist gesperrt — Import nicht ausgeführt. ` +
            `Zum Entsperren: Sektion «Vorjahres-Tagesumsatz» (nur Admin).`,
          );
          setStatus('error');
          toast.error(`Jahr ${res.lockedYear ?? preview.year} ist gesperrt — Import nicht ausgeführt.`);
          return;
        }
        window.dispatchEvent(new Event('supabase-kv-synced'));
        console.log(`[REVENUE] tenant: ${tenantId} | key: ${storageKey} | target: ${target} | ${res.count} Tage ${res.from ?? '?'}..${res.to ?? '?'} | vj_daily: ${res.vjUpserted}`);
        toast.success(
          target === 'actual'
            ? `${res.count} Tage importiert als Ist-Umsätze`
            : `${res.count} Tage importiert als Vorjahresumsätze (auch nach vj_daily für den Report)`,
        );
      }
      notifyReportingDataChanged();
      reset();
    } catch (e) {
      toast.error('Fehler beim Speichern: ' + String(e instanceof Error ? e.message : e));
      setStatus('preview');
    }
  };

  const monthTotalHeading = preview
    ? preview.typ === 'umsatz' ? 'Netto gesamt'
      : preview.typ === 'gaeste' ? 'Personen'
      : preview.typ === 'durchschnitt' ? 'Ø Verkauf'
      : 'Marketing (CHF)'
    : '';

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50/50 dark:bg-sky-950/10 p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Lade einen Gastronovi-Tagesdaten-Export (Excel) hoch. Der Dateityp wird
          <strong> automatisch erkannt</strong> (Umsatz, Marketing, Gäste oder Durchschnittsverkauf).
          Massgeblich für die Datumszuordnung ist ausschliesslich das <strong>gewählte Jahr</strong>.
          Vor dem Speichern siehst du eine <strong>Vorschau</strong>.
        </p>

        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Jahr *</p>
            <Select value={String(year)} onValueChange={v => { setYear(Number(v)); reset(); }}>
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map(y => (
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
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) { setFile(f); setStatus('idle'); setPreview(null); setError(''); setWarn(''); }
              }}
              className="block w-full text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-sky-100 file:text-sky-700 dark:file:bg-sky-900/40 dark:file:text-sky-300 cursor-pointer"
            />
          </div>
        </div>

        {file && (status === 'idle' || status === 'error') && (
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

        {(status === 'preview' || status === 'saving') && preview && (
          <div className="space-y-2">
            <div className="rounded border border-sky-200 dark:border-sky-700 bg-white dark:bg-sky-950/10 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-700 dark:text-sky-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Vorschau
                <Badge variant="outline" className={cn('text-[9px]', TYP_BADGE[preview.typ])}>
                  {TYP_LABEL[preview.typ]}
                </Badge>
                {preview.typ === 'umsatz' && (
                  <Badge variant="outline" className="text-[9px]">
                    {targetForYear(preview.year, currentYear) === 'actual' ? 'Ist-Umsatz' : 'Vorjahr'}
                  </Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">Jahr:</span>
                <span className="font-medium">{preview.year}</span>
                <span className="text-muted-foreground">Datumsbereich:</span>
                <span className="font-medium">
                  {preview.from ? format(parseISO(preview.from), 'dd.MM.') : '–'}
                  {' – '}
                  {preview.to ? format(parseISO(preview.to), 'dd.MM.yyyy') : '–'}
                </span>
                <span className="text-muted-foreground">Anzahl Tage:</span>
                <span className="font-medium">{preview.dates.length}</span>
                {preview.typ === 'gaeste' && (
                  <>
                    <span className="text-muted-foreground">Tagessumme (massgeblich):</span>
                    <span className="font-medium">{fmtValueByTyp('gaeste', preview.tagessumme ?? 0)}</span>
                  </>
                )}
              </div>

              {/* Monatstotale je betroffenem Monat */}
              <div className="rounded border border-border/60 bg-muted/20 divide-y divide-border/50">
                <div className="flex items-center justify-between px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span>Monat</span>
                  <span>{monthTotalHeading}</span>
                </div>
                {preview.monthTotals.map(mt => (
                  <div key={mt.month} className="flex items-center justify-between px-2.5 py-1 text-xs">
                    <span>{monthLabel(mt.month)}</span>
                    <span className="font-medium tabular-nums">
                      {preview.typ === 'gaeste'
                        ? `${Math.round(mt.value).toLocaleString('de-CH')} P.`
                        : `CHF ${mt.value.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </span>
                  </div>
                ))}
              </div>

              {warn && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">{warn}</p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 text-xs flex-1 gap-1.5 bg-sky-600 hover:bg-sky-700 text-white"
                onClick={handleConfirm}
                disabled={status === 'saving'}
              >
                {status === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {status === 'saving' ? 'Wird gespeichert…' : 'Importieren'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs gap-1.5"
                onClick={reset}
                disabled={status === 'saving'}
              >
                <XCircle className="h-3.5 w-3.5" />
                Abbrechen
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Manuelle Tageserfassung (aus GastronoviImportSection) — eigene Karte. */
function ManualEntrySection() {
  const { tenantId, tenantKey } = useTenant();
  return <ManualEntryCard storageKey={tenantKey('dailyBudgets')} tenantId={tenantId} />;
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
  const { tenantId, tenantKey } = useTenant();
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
    // Undo-Snapshot VOR dem Schreiben: bisheriger personnelCostPreviousYear
    // der betroffenen Monate (null = Feld war nicht gesetzt).
    const undoMonths: Array<{ monthId: string; fields: Record<string, unknown | null> }> = [];
    try {
      for (const row of result.months) {
        if (row.amount === 0) continue;
        const prior = loadMonth(saveYear, row.month, tenantKey(REPORTING_STORAGE_KEY)).personnelCostPreviousYear;
        undoMonths.push({
          monthId: `${saveYear}-${String(row.month).padStart(2, '0')}`,
          fields: { personnelCostPreviousYear: prior ?? null },
        });
      }
    } catch (err) {
      console.warn('[PRIOR-YEAR-COST] Undo-Snapshot fehlgeschlagen (Import läuft weiter):', err);
    }
    let savedCount = 0;
    for (const row of result.months) {
      if (row.amount === 0) continue;
      saveMonth(
        { year: saveYear, month: row.month, personnelCostPreviousYear: row.amount },
        'csv_previous_year',
        'update',
        { fileName, note: `Personalkosten-Vorjahr-Import ${importYear} → P&L ${saveYear}` },
        tenantKey('reporting_v1'),
      );
      savedCount++;
    }
    setSaving(false);
    setSaved(true);
    console.log(`[PRIOR-YEAR-COST] saved | tenant: ${tid} | year: ${importYear} | months: ${savedCount}`);
    toast.success(`${savedCount} Monate Personalkosten VJ ${importYear} gespeichert (sichtbar in P&L ${saveYear})`);
    // Import-Protokoll (Letzter Import + Rückgängig) — best-effort.
    void recordImportRun(tid, {
      source: 'personalkosten-vorjahr',
      periodLabel: `VJ ${importYear} → P&L ${saveYear}`,
      itemCount: savedCount,
      itemLabel: 'Monate',
      fileName: fileName || undefined,
      ...(undoMonths.length > 0 ? { snapshot: { kind: 'reporting-fields', storeKey: tenantKey(REPORTING_STORAGE_KEY), months: undoMonths } } : {}),
    }).catch(err => {
      console.error('[PRIOR-YEAR-COST] Import-Protokoll fehlgeschlagen:', err);
      toast.warning('Import-Protokoll konnte nicht gespeichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.');
    });
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
      {/* Letzter Import + Rückgängig + Historie (Import-Center-Spec) */}
      <LastImportPanel
        source="personalkosten-vorjahr"
        undoHint="Zurückgesetzt wird das Feld «Personalkosten Vorjahr» der betroffenen P&L-Monate. Alle anderen Monatswerte bleiben unberührt."
      />

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
            {[currentYear - 3, currentYear - 2, currentYear - 1, currentYear].map(y => (
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

/** Checklisten-Prefill: ?target=… → Sektions-Anker im Import-Center. */
const PREFILL_TARGET_ANCHORS: Record<string, string> = {
  tagesumsatz: 'umsatz-ist',
  mirus: 'ist-stunden',
  maison: 'umsatz-ist',
};

const ImportHub = () => {
  const { isAdmin, isBeaulieuManager, isBeaulieuViewer } = usePermissions();
  const { isGuest } = useGuestSession();
  const { tenant } = useTenant();
  const [searchParams] = useSearchParams();

  // Advisory: bei ?target=… aus der Import-Checkliste zur passenden Sektion
  // scrollen (Sektionen rendern nur für Admins — ohne Element passiert nichts).
  useEffect(() => {
    const target = searchParams.get('target');
    const anchor = target ? PREFILL_TARGET_ANCHORS[target] : undefined;
    if (!anchor) return;
    const t = setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
    return () => clearTimeout(t);
  }, [searchParams]);
  // Single source of truth: the page is reachable iff the role can see ≥1 import card
  // (same visibleCategories() the grid uses). Guests get 0 cards → redirected; Beaulieu-GF
  // gets its route cards; Beaulieu-Viewer gets Warenrechnungen only; admin gets all 9.
  if (visibleCategories({ isAdmin, isGuest, isBeaulieuManager, isBeaulieuViewer }).length === 0) {
    return <Navigate to="/personal" replace />;
  }
  // The inline import sections below the card grid are admin-only tools; non-admins
  // (Beaulieu) see ONLY the card grid — their route cards navigate to the real pages.
  const showAdminSections = isAdmin && !isGuest;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Upload className="h-5 w-5 text-muted-foreground" />
              <div>
                <h1 className="text-base font-bold leading-tight">Import-Center</h1>
                <p className="text-xs text-muted-foreground">Alle Datenimporte an einem Ort</p>
              </div>
              <span
                className="hidden sm:inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1"
                style={{ backgroundColor: `${tenant.color}18`, color: tenant.color, ringColor: `${tenant.color}40` }}
              >
                {tenant.shortName}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {showAdminSections && (
                <Link to="/import-cockpit">
                  <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground">
                    Alle Quellen &amp; Kontrollen
                  </Button>
                </Link>
              )}
              <Link to="/">
                <Button variant="outline" size="sm" className="h-8">
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                  Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 pb-24 space-y-4">

        {/* Hinweise aus der Import-Checkliste (advisory, schränken nichts ein) */}
        <ImportTaskPrefillHint forTarget="tagesumsatz" />
        <ImportTaskPrefillHint forTarget="mirus" />
        <ImportTaskPrefillHint forTarget="maison" />

        {/* ── Import-Bereiche (Karten-Übersicht) ────────────────────────── */}
        <ImportCenterGrid />

        {showAdminSections && (
        <>
        {/* ── Die 4 Importarten-Gruppen (Status + „Import starten") ─────── */}
        <ImportGroupCards />

        {/* ── 0. Datenstand ─────────────────────────────────────────────── */}
        <DatenstandCard />

        {/* ── 0b. Datenstand Vorjahr (je Jahr, Default 2024) ───────────── */}
        <JahresDatenstandCard />

        {/* ── 0c. Vollständigkeit Tagesdaten (Umsatz/Gäste/Durchschnitt) ─ */}
        <VollstaendigkeitCard />

        {/* ── 1. Tagesdaten-Import (Auto-Typerkennung) ─────────────────── */}
        <Section
          id="umsatz-ist"
          title="Tagesdaten-Import"
          subtitle="Umsatz, Marketing, Gäste oder Durchschnittsverkauf – Typ wird automatisch erkannt, Jahr per Dropdown"
          icon={<TrendingUp className="h-4 w-4" />}
          color="border-sky-400 dark:border-sky-600"
          badge="Auto-Erkennung"
          badgeColor="border-sky-300 text-sky-700 bg-sky-50 dark:bg-sky-950/20"
        >
          <TagesdatenImportSection />
        </Section>

        {/* ── 1b. Manuelle Tageserfassung ──────────────────────────────── */}
        <Section
          id="manuelle-tageserfassung"
          title="Manuelle Tageserfassung"
          subtitle="Einzelnen Tagesumsatz (Ist oder Vorjahr) von Hand erfassen"
          icon={<PencilLine className="h-4 w-4" />}
          color="border-slate-400 dark:border-slate-600"
          badge="Manuell"
          badgeColor="border-slate-300 text-slate-700 bg-slate-50 dark:bg-slate-950/20"
        >
          <ManualEntrySection />
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

        {/* ── 3b. Offene Stunden (geparkte MIRUS-Einträge) ──────────────── */}
        <OpenHoursSectionCard />

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
            {/* Letzter Import + Rückgängig (Import erfolgt auf der Buchhaltungs-Import-Seite) */}
            <LastImportPanel
              source="ist-kosten-buchhaltung"
              undoHint="Zurückgesetzt wird der komplette Monats-Record (inkl. Buchungszeilen) auf den Stand vor dem Import. Existierte der Monat vorher nicht, wird er entfernt."
            />
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

        {/* ── Foratable: Gästeexport (CRM-Anreicherung) ─────────────────── */}
        <Section
          id="foratable-gaesteexport"
          title="Foratable Gästeexport"
          subtitle="CRM-Profile bestehender Gäste aus dem Foratable-Gästeexport anreichern (nur leere Felder)"
          icon={<Users className="h-4 w-4" />}
          color="border-rose-400 dark:border-rose-600"
          badge="CSV · CRM"
          badgeColor="border-rose-300 text-rose-700 bg-rose-50 dark:bg-rose-950/20"
        >
          <div className="rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/10 p-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              Importiere den Foratable-<span className="font-medium">Gästeexport</span> (nicht den
              Reservations-Export). Bestehende Gäste werden über E-Mail, Telefon oder Name erkannt;
              VIP, Newsletter, Sperrliste, Firma, Lieblingsplatz, Geburtstag und Notizen ergänzen die
              manuellen CRM-Profile. Bereits gepflegte Werte bleiben unverändert.
            </p>
            <Link to="/foratable-import?tab=gaeste">
              <Button size="sm" className="h-8 text-xs gap-1.5 w-full">
                <Upload className="h-3.5 w-3.5" />
                Zum Gästeexport-Import
              </Button>
            </Link>
          </div>
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
        </>
        )}

      </main>
    </div>
  );
};

export default ImportHub;
