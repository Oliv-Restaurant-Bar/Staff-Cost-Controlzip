/**
 * TagesansichtPage – Tages-Umsatzvergleich (standalone)
 * =======================================================
 * Route:   /tagesansicht   |   Nav: Verkauf → Tagesansicht (adminOnly)
 *
 * Gruppen:
 *   Tagesvergleich : Datum · WT · Ist · Umsatz VJ · Abw. VJ CHF
 *   Kumulierter Verlauf : Kum.Ist · Kum.VJ · Kum.Abw.CHF · Kum.Abw.%
 *   Optional: Budget-Spalten
 *
 * VJ-Logik:  gleicher Kalendertag, Jahr-1
 *   2026-03-15 → 2025-03-15
 *   1. dailyBudgets[currentDate].previousYearRevenue (Import)
 *   2. dailyBudgets[prevYearDate].actualRevenue (Fallback)
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  startOfMonth, endOfMonth, eachDayOfInterval, format,
  addMonths, subMonths, isSameMonth,
} from 'date-fns';
import { de } from 'date-fns/locale';
import {
  ChevronLeft, ChevronRight, Table2, TrendingUp, TrendingDown,
  Pencil, CheckCircle2, X, AlertTriangle, CheckCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useRevenueDisplay } from '@/contexts/RevenueDisplayContext';
import { useTenant } from '@/contexts/TenantContext';
import { useBudgetMonth } from '@/hooks/useBudgetMonth';
import { grossToNet } from '@/types/personnel';
import { loadMonth } from '@/lib/reporting-store';
import { useVj2025Import } from '@/hooks/useVj2025Import';
import { loadVjDailyMonth, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { getDailyBudgetMap } from '@/lib/budget-day';

// ── Typen ─────────────────────────────────────────────────────────────────────

interface DailyEntry {
  actualRevenue?:       number;
  takeawayRevenue?:     number;
  previousYearRevenue?: number;
  plannedRevenue?:      number;
}

type ViewMode = 'alles' | 'vs-budget' | 'vs-vorjahr' | 'nur-umsaetze';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const WT_ABBR = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const wtOf    = (d: Date) => WT_ABBR[d.getDay()];
const isWE    = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

const NUM     = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1    = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtN    = (v: number) => NUM.format(Math.round(v));
const fmtDev  = (v: number) => (v >= 0 ? '+' : '') + NUM.format(Math.round(v));
const fmtPct  = (v: number) => (v >= 0 ? '+' : '') + NUM1.format(v) + ' %';
const devCls  = (v: number, active = true) =>
  !active       ? 'text-muted-foreground'
  : v > 0       ? 'text-emerald-600 dark:text-emerald-400 font-medium'
  : v < 0       ? 'text-red-600    dark:text-red-400    font-medium'
  :               'text-muted-foreground';

function readDailyBudgets(keyFn: (k: string) => string = k => k): Record<string, DailyEntry> {
  try { return JSON.parse(localStorage.getItem(keyFn('dailyBudgets')) || '{}'); }
  catch { return {}; }
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────

export default function TagesansichtPage() {
  const { showNetRevenue } = useRevenueDisplay();
  const { tenantId, tenantKey } = useTenant();
  const today = useMemo(() => new Date(), []);

  // Einmaliger Import der VJ-2025-Tagesdaten (löst 'supabase-kv-synced' aus wenn fertig)
  useVj2025Import(tenantId);

  // Monat-Selektor
  const [refDate, setRefDate] = useState(() =>
    new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const year  = refDate.getFullYear();
  const month = refDate.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  // Vergleichs-Modus
  const [mode, setMode] = useState<ViewMode>('vs-vorjahr');

  // dailyBudgets: localStorage sofort + KV nachladen (mandantenfähig)
  const [dailyBudgets, setDailyBudgets] = useState<Record<string, DailyEntry>>(() => readDailyBudgets(tenantKey));

  // vjSupabaseData: VJ-Tagesumsätze aus Supabase (primäre Quelle)
  const [vjSupabaseData, setVjSupabaseData] = useState<Record<string, VjDayRecord>>({});

  // reportingTick: hochzählen bei Sync, damit rows-useMemo loadMonth() neu liest
  const [reportingTick, setReportingTick] = useState(0);

  // Manuelle Ist-Eingabe
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editValue,   setEditValue]   = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // VJ-Supabase-Daten für den angezeigten VJ-Monat laden
  useEffect(() => {
    const vjYear  = year - 1;
    const vjMonth = month;
    loadVjDailyMonth(vjYear, vjMonth, tenantId).then(data => {
      setVjSupabaseData(data);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, tenantId]);

  useEffect(() => {
    const local = readDailyBudgets(tenantKey);
    const localKeys = Object.keys(local).filter(k => (local[k]?.actualRevenue ?? 0) > 0).sort();
    console.log(`[UMSATZ][${tenantId}] TagesansichtPage localStorage: ${localKeys.length} Tage, latest=${localKeys.at(-1) ?? '–'}`);
    if (tenantId === 'beaulieu') {
      console.log(`[REVENUE-CHECK] tenant: ${tenantId}`);
      console.log(`[REVENUE-CHECK] rows loaded: ${localKeys.length}`);
      console.log(`[REVENUE-CHECK] visible in tagesansicht: ${localKeys.length > 0 ? 'yes' : 'no'}`);
      console.log(`[REVENUE-CHECK] mismatch: ${localKeys.length === 0 ? 'yes – keine Ist-Umsätze' : 'no – Daten vorhanden'}`);
    }
    setDailyBudgets(local);
    import('@/lib/supabase-kv').then(({ kvGet }) =>
      kvGet(tenantKey('dailyBudgets'))
        .then(r => {
          if (r && typeof r === 'object') {
            const kvKeys = Object.keys(r as object).filter(k => ((r as Record<string, { actualRevenue?: number }>)[k]?.actualRevenue ?? 0) > 0).sort();
            const latestLocal = localKeys.at(-1) ?? '–';
            const latestKV    = kvKeys.at(-1) ?? '–';
            if (latestKV < latestLocal) {
              console.warn(`[UMSATZ][${tenantId}] TagesansichtPage: KV stale (${latestKV}) < local (${latestLocal}) — keeping localStorage`);
              return;
            }
            console.log(`[UMSATZ][${tenantId}] TagesansichtPage KV: ${kvKeys.length} Tage, latest=${latestKV}`);
            setDailyBudgets(r as Record<string, DailyEntry>);
          }
        })
        .catch(() => {}),
    );
    const onSync = () => {
      setDailyBudgets(readDailyBudgets(tenantKey));
      setReportingTick(t => t + 1);
      loadVjDailyMonth(year - 1, month, tenantId).then(setVjSupabaseData);
    };
    window.addEventListener('supabase-kv-synced', onSync);
    return () => window.removeEventListener('supabase-kv-synced', onSync);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, tenantId]);

  // Budget
  const budgetData = useBudgetMonth(year, month);
  const hasBud     = budgetData.revenueBudget > 0;

  // Monatstage
  const monthDays = useMemo(() =>
    eachDayOfInterval({ start: startOfMonth(refDate), end: endOfMonth(refDate) }),
  [refDate]);

  // Weekday-gewichtete Tagesbudgets (Single Source of Truth: getDailyBudgetMap)
  // NICHT mehr: revenueBudget / daysInMonth (flache Verteilung)
  const dailyBudgetMap = useMemo(
    () => hasBud ? getDailyBudgetMap(budgetData.revenueBudget, year, month) : {},
    [hasBud, budgetData.revenueBudget, year, month],
  );

  // ── Zeilenberechnung ──────────────────────────────────────────────────────
  const rows = useMemo(() => {
    let cumIst = 0, cumVj = 0, cumBud = 0;

    // VJ-Monat aus reporting_v1 (gleiche Quelle wie Dashboard-KPI)
    // Priorität: revenuePreviousYear des aktuellen Monats > revenueActual des VJ-Monats
    const currentRec = loadMonth(year, month);
    const vjRec      = loadMonth(year - 1, month);
    const vjMonthlyGross =
      (currentRec.revenuePreviousYear && currentRec.revenuePreviousYear > 0)
        ? currentRec.revenuePreviousYear
        : (vjRec.revenueActual ?? 0);
    const vjMonthlyBase = showNetRevenue ? grossToNet(vjMonthlyGross) : vjMonthlyGross;

    // Pro-rata Tageswert aus Monatssumme (Anzahl Tage im VJ-Monat)
    const daysInVJMonth = endOfMonth(new Date(year - 1, month - 1, 1)).getDate();
    const vjProRata     = vjMonthlyBase > 0 ? vjMonthlyBase / daysInVJMonth : 0;

    return monthDays.map(day => {
      const d = format(day, 'yyyy-MM-dd');

      // Ist
      const gross    = dailyBudgets[d]?.actualRevenue   ?? 0;
      const takeaway = dailyBudgets[d]?.takeawayRevenue ?? 0;
      const ist      = showNetRevenue ? grossToNet(gross, takeaway) : gross;

      // VJ: 1. Supabase (vj_daily:YYYY-MM-DD) → 2. dailyBudgets-Blob → 3. Pro-rata aus reporting_v1
      const vjKey      = `${year - 1}-${d.slice(5)}`;
      const vjSupabase = vjSupabaseData[vjKey]?.actualRevenue ?? 0;
      const vjDirect   = dailyBudgets[d]?.previousYearRevenue ?? 0;
      const vjBlob     = vjDirect > 0 ? vjDirect : (dailyBudgets[vjKey]?.actualRevenue ?? 0);
      const vjDailyRaw = vjSupabase > 0 ? vjSupabase : vjBlob; // Supabase hat Priorität
      const vjIsExact  = vjDailyRaw > 0;
      const vjBase     = vjIsExact
        ? (showNetRevenue ? grossToNet(vjDailyRaw) : vjDailyRaw)
        : vjProRata; // Fallback: pro-rata aus reporting_v1
      const vjDate     = new Date(vjKey + 'T00:00:00');

      // Diagnose-Log (nur Tag 1-5)
      if (day.getDate() <= 5) {
        const src = vjSupabase > 0 ? 'supabase' : vjBlob > 0 ? 'blob' : 'proRata';
        console.log(
          `[TAGESANSICHT] ${d} → VJ ${vjKey}:` +
          ` supabase=${vjSupabase} | blob=${vjBlob} | proRata=${vjProRata.toFixed(0)}` +
          ` | vjMonthly=${vjMonthlyGross} | using=${src}`,
        );
      }

      // Weekday-gewichtetes Tagesbudget (aus Map, nicht mehr flache Verteilung)
      const budGross   = dailyBudgetMap[d] ?? 0;
      const budBase    = showNetRevenue ? grossToNet(budGross) : budGross;

      cumIst += ist;
      cumVj  += vjBase;
      cumBud += budBase;

      // Kumulierte Abweichung VJ in %
      const cumDevVj    = cumIst - cumVj;
      const cumDevVjPct = cumVj > 0 ? (cumDevVj / cumVj) * 100 : 0;
      const cumDevBud   = cumIst - cumBud;

      return {
        day, vjDate,
        ist,
        vj:         vjBase,
        vjIsExact,              // true = Tages-Exaktwert, false = pro-rata aus reporting_v1
        bud:        budBase,
        devVj:      ist - vjBase,
        devBud:     ist - budBase,
        cumIst, cumVj, cumBud,
        cumDevVj,
        cumDevVjPct,
        cumDevBud,
        cumDevBudPct: cumBud > 0 ? (cumDevBud / cumBud) * 100 : 0,
        hasIst:  gross > 0,
        hasVj:   vjBase > 0,           // pro-rata zählt auch als VJ-Wert vorhanden
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthDays, dailyBudgets, vjSupabaseData, showNetRevenue, dailyBudgetMap, year, month, reportingTick]);

  const lastRow = rows[rows.length - 1];

  // ── KPI: kumulierter Stand bis heute (letzter Tag mit Ist-Daten) ───────────
  const isCurrentMonth = isSameMonth(refDate, today);
  const lastDataRow = useMemo(() => {
    if (!isCurrentMonth) return lastRow; // zurückliegender Monat: ganzer Monat
    // aktueller Monat: letzter Tag mit Ist > 0
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].hasIst) return rows[i];
    }
    return null;
  }, [rows, isCurrentMonth, lastRow]);

  // ── Spalten-Sichtbarkeit ──────────────────────────────────────────────────
  const showVjCols   = ['alles', 'vs-vorjahr', 'nur-umsaetze'].includes(mode);
  const showBudCol   = ['alles', 'vs-budget',  'nur-umsaetze'].includes(mode);
  const showDevVj    = ['alles', 'vs-vorjahr'].includes(mode);
  const showDevBud   = ['alles', 'vs-budget'].includes(mode);
  const showKum      = mode !== 'nur-umsaetze';
  const showKumVj    = showKum && ['alles', 'vs-vorjahr'].includes(mode);
  const showKumBud   = showKum && ['alles', 'vs-budget'].includes(mode);
  const showKumDevVj = showKum && ['alles', 'vs-vorjahr'].includes(mode);
  const showKumDevBud= showKum && ['alles', 'vs-budget'].includes(mode);

  // ── CSS-Kürzel ────────────────────────────────────────────────────────────
  const thL = 'text-left  px-2 py-1.5 font-medium text-[11px] whitespace-nowrap';
  const thR = 'text-right px-2 py-1.5 font-medium text-[11px] whitespace-nowrap';
  const thRK= 'text-right px-2 py-1.5 font-medium text-[11px] whitespace-nowrap border-l border-border/40';
  const tdL = 'px-2 py-[4px] text-left  whitespace-nowrap text-xs';
  const tdR = 'px-2 py-[4px] text-right tabular-nums whitespace-nowrap text-xs';
  const tdRK= 'px-2 py-[4px] text-right tabular-nums whitespace-nowrap text-xs border-l border-border/40';

  const MODES: { id: ViewMode; label: string }[] = [
    { id: 'alles',        label: 'Alles' },
    { id: 'vs-budget',    label: 'vs. Budget' },
    { id: 'vs-vorjahr',   label: 'vs. Vorjahr' },
    { id: 'nur-umsaetze', label: 'Nur Umsätze' },
  ];

  const hasPrevYearData = rows.some(r => r.hasVj);

  // ── VJ-Status: Prüfung ob Vorjahres-Monatsdaten vorhanden ────────────────
  const vjStatus = useMemo(() => {
    const vjMonthRec     = loadMonth(year - 1, month);
    const currentRec     = loadMonth(year, month);
    const hasMonthly     = (vjMonthRec.revenueActual ?? 0) > 0 ||
                           (currentRec.revenuePreviousYear ?? 0) > 0;
    const vjMonthLabel   = format(new Date(year - 1, month - 1, 1), 'MMMM yyyy', { locale: de });
    // Exakte Tages-Einträge im VJ-Monat (aus dailyBudgets)
    const vjMonthDays    = eachDayOfInterval({
      start: startOfMonth(new Date(year - 1, month - 1, 1)),
      end:   endOfMonth(new Date(year - 1, month - 1, 1)),
    });
    const exactDays = vjMonthDays.filter(d => {
      const key = format(d, 'yyyy-MM-dd');
      return (dailyBudgets[key]?.actualRevenue ?? 0) > 0;
    }).length;

    console.log(
      `[TAGESANSICHT VJ] Monat: ${format(refDate, 'MMMM yyyy', { locale: de })}` +
      ` | Vergleich: ${vjMonthLabel}` +
      ` | VJ-Monatssumme (reporting_v1): ${vjMonthRec.revenueActual ?? 0}` +
      ` | Exakte Tagesdaten: ${exactDays} von ${vjMonthDays.length} Tagen`,
    );

    return { hasMonthly, vjMonthLabel, exactDays, totalDays: vjMonthDays.length };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, dailyBudgets, reportingTick]);

  // ── Manuelle Ist-Eingabe speichern ────────────────────────────────────────
  const saveManualIst = useCallback(async (dateKey: string, rawInput: string) => {
    const parsed = parseFloat(rawInput.replace(/['''\s]/g, '').replace(',', '.'));
    if (isNaN(parsed) || parsed < 0) { setEditingDate(null); return; }
    // Immer als Brutto speichern (gleich wie Import)
    const grossValue = parsed;
    const updated = { ...readDailyBudgets(tenantKey), [dateKey]: { ...readDailyBudgets(tenantKey)[dateKey], actualRevenue: grossValue } };
    localStorage.setItem(tenantKey('dailyBudgets'), JSON.stringify(updated));
    setDailyBudgets(updated);
    setEditingDate(null);
    try {
      const { kvSet } = await import('@/lib/supabase-kv');
      await kvSet(tenantKey('dailyBudgets'), updated);
    } catch { /* lokaler Stand bleibt */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const openEdit = useCallback((dateKey: string, currentGross: number) => {
    setEditingDate(dateKey);
    setEditValue(currentGross > 0 ? String(Math.round(currentGross)) : '');
    setTimeout(() => inputRef.current?.select(), 30);
  }, []);

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">

          <div className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Tagesansicht</h1>
          </div>

          {/* Monat-Navigator */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setRefDate(d => subMonths(d, 1))}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-sm font-medium min-w-[110px] text-center">
              {format(refDate, 'MMMM yyyy', { locale: de })}
            </span>
            <button
              onClick={() => setRefDate(d => addMonths(d, 1))}
              className="h-7 w-7 rounded flex items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <span className="text-[11px] text-muted-foreground">
            {showNetRevenue ? 'Netto' : 'Brutto'}
            {!hasBud && ' · kein Budget'}
          </span>

          {/* Vergleichs-Buttons */}
          <div className="ml-auto flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
            {MODES.map(m => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-medium rounded-md transition-all whitespace-nowrap',
                  mode === m.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 space-y-3">

        {/* ── VJ-Status-Bar ────────────────────────────────────────────────── */}
        {showVjCols && (
          <div className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-lg border text-xs flex-wrap',
            vjStatus.hasMonthly
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-amber-50  dark:bg-amber-950/30  border-amber-200  dark:border-amber-800  text-amber-800  dark:text-amber-300',
          )}>
            {vjStatus.hasMonthly
              ? <CheckCircle className="h-3.5 w-3.5 shrink-0" />
              : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            <span className="font-medium">
              {vjStatus.hasMonthly
                ? 'Vorjahresdaten verfügbar'
                : 'Keine Vorjahresdaten importiert'}
            </span>
            <span className="text-current/70">
              Vergleichsmonat: {vjStatus.vjMonthLabel}
            </span>
            {vjStatus.exactDays > 0 && (
              <span className="text-current/70">
                · {vjStatus.exactDays} von {vjStatus.totalDays} Tagen mit Tageswerten
              </span>
            )}
            {vjStatus.hasMonthly && vjStatus.exactDays === 0 && (
              <span className="text-current/70">
                · Monatssumme aus Sage/Buchhaltung, pro-rata auf Tage aufgeteilt
              </span>
            )}
          </div>
        )}

        {/* ── KPI-Banner ───────────────────────────────────────────────────── */}
        {lastDataRow && (showKumDevVj || showKumDevBud) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">

            {/* Kum. Ist bis heute */}
            <Card className="px-3 py-2.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                Kumuliert Ist{isCurrentMonth ? ' bis heute' : ''}
              </p>
              <p className="text-base font-bold mt-0.5">
                {fmtN(lastDataRow.cumIst)}
              </p>
            </Card>

            {/* Kum. VJ */}
            {showKumVj && (
              <Card className="px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Kumuliert VJ
                </p>
                <p className="text-base font-bold mt-0.5 text-muted-foreground">
                  {hasPrevYearData ? fmtN(lastDataRow.cumVj) : '—'}
                </p>
              </Card>
            )}

            {/* Kum. Abw. VJ CHF */}
            {showKumDevVj && hasPrevYearData && (
              <Card className="px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Abw. vs. Vorjahr
                </p>
                <p className={cn('text-base font-bold mt-0.5', devCls(lastDataRow.cumDevVj))}>
                  {fmtDev(lastDataRow.cumDevVj)}
                </p>
              </Card>
            )}

            {/* Kum. Abw. VJ % */}
            {showKumDevVj && hasPrevYearData && lastDataRow.cumVj > 0 && (
              <Card className="px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Abw. vs. Vorjahr %
                </p>
                <p className={cn('text-base font-bold mt-0.5 flex items-center gap-1', devCls(lastDataRow.cumDevVjPct))}>
                  {lastDataRow.cumDevVjPct >= 0
                    ? <TrendingUp className="h-3.5 w-3.5" />
                    : <TrendingDown className="h-3.5 w-3.5" />}
                  {fmtPct(lastDataRow.cumDevVjPct)}
                </p>
              </Card>
            )}

            {/* Kum. Abw. Budget CHF */}
            {showKumDevBud && hasBud && (
              <Card className="px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Abw. vs. Budget
                </p>
                <p className={cn('text-base font-bold mt-0.5', devCls(lastDataRow.cumDevBud))}>
                  {fmtDev(lastDataRow.cumDevBud)}
                </p>
              </Card>
            )}

            {/* Kum. Abw. Budget % */}
            {showKumDevBud && hasBud && lastDataRow.cumBud > 0 && (
              <Card className="px-3 py-2.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Abw. vs. Budget %
                </p>
                <p className={cn('text-base font-bold mt-0.5 flex items-center gap-1', devCls(lastDataRow.cumDevBudPct))}>
                  {lastDataRow.cumDevBudPct >= 0
                    ? <TrendingUp className="h-3.5 w-3.5" />
                    : <TrendingDown className="h-3.5 w-3.5" />}
                  {fmtPct(lastDataRow.cumDevBudPct)}
                </p>
              </Card>
            )}
          </div>
        )}

        {/* ── Tabelle ──────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="py-2 px-4 border-b border-border/60">
            <CardTitle className="text-xs font-normal text-muted-foreground">
              {format(refDate, 'MMMM yyyy', { locale: de })} · {daysInMonth} Tage
              {!hasPrevYearData && showVjCols && (
                <span className="ml-2 text-amber-600 dark:text-amber-400">
                  Keine Vorjahresdaten für diesen Monat importiert
                </span>
              )}
            </CardTitle>
          </CardHeader>

          <CardContent className="p-0 pb-1">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">

                {/* ── Gruppen-Header ─────────────────────────────────────── */}
                <thead>
                  <tr className="bg-muted/30 border-b border-border/40 text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">
                    <th colSpan={2 + (showVjCols ? 1 : 0) + (showVjCols ? 1 : 0) + (showDevVj ? 1 : 0) + (showBudCol ? 1 : 0) + (showDevBud ? 1 : 0) + 1}
                      className="text-left px-3 py-1">
                      Tagesvergleich
                    </th>
                    {showKum && (
                      <th
                        colSpan={1 + (showKumVj ? 1 : 0) + (showKumBud ? 1 : 0) + (showKumDevVj ? 2 : 0) + (showKumDevBud ? 2 : 0)}
                        className="text-left px-3 py-1 border-l border-border/40"
                      >
                        Kumulierter Verlauf
                      </th>
                    )}
                  </tr>

                  {/* ── Spalten-Titel ─────────────────────────────────────── */}
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                    {/* Tagesvergleich */}
                    <th className={thL}>Datum</th>
                    <th className={thL}>WT</th>
                    <th className={thR}>Ist</th>
                    {showVjCols && <th className={thR}>Umsatz VJ</th>}
                    {showVjCols && <th className={thL}>WT VJ</th>}
                    {showDevVj  && <th className={thR}>Abw. VJ</th>}
                    {showBudCol && <th className={thR}>Budget</th>}
                    {showDevBud && <th className={thR}>Abw. Bud.</th>}
                    {/* Kumul. Verlauf */}
                    {showKum    && <th className={thRK}>Kum. Ist</th>}
                    {showKumVj  && <th className={thR}>Kum. VJ</th>}
                    {showKumDevVj  && <th className={thR}>Kum. Abw. CHF</th>}
                    {showKumDevVj  && <th className={thR}>Kum. Abw. %</th>}
                    {showKumBud    && <th className={thR}>Kum. Bud.</th>}
                    {showKumDevBud && <th className={thR}>Kum. Abw. Bud. CHF</th>}
                    {showKumDevBud && <th className={thR}>Kum. Abw. Bud. %</th>}
                  </tr>
                </thead>

                {/* ── Datenzeilen ───────────────────────────────────────── */}
                <tbody>
                  {rows.map((row, i) => {
                    const we = isWE(row.day);
                    const isToday = isCurrentMonth &&
                      row.day.getDate() === today.getDate() &&
                      isSameMonth(row.day, today);
                    return (
                      <tr
                        key={i}
                        className={cn(
                          'border-b border-border/20 transition-colors',
                          isToday  ? 'bg-primary/5 dark:bg-primary/10 ring-1 ring-inset ring-primary/20'
                          : we     ? 'bg-slate-50/70 dark:bg-slate-900/30'
                          : i % 2 === 0 ? 'bg-background' : 'bg-muted/10',
                        )}
                      >
                        {/* Datum */}
                        <td className={cn(tdL, 'font-mono text-[11px]', we ? 'text-slate-500' : 'text-muted-foreground')}>
                          {format(row.day, 'dd.MM.yyyy')}
                        </td>
                        {/* WT */}
                        <td className={cn(tdL, 'font-medium text-[11px]', we ? 'text-slate-600 dark:text-slate-300' : '')}>
                          {wtOf(row.day)}
                        </td>
                        {/* Ist — klickbar für manuelle Eingabe */}
                        <td className={cn(tdR, 'group relative', row.hasIst ? 'font-semibold' : 'text-muted-foreground')}>
                          {editingDate === format(row.day, 'yyyy-MM-dd') ? (
                            <div className="flex items-center gap-1 justify-end">
                              <input
                                ref={inputRef}
                                type="text"
                                inputMode="numeric"
                                value={editValue}
                                onChange={e => setEditValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveManualIst(format(row.day, 'yyyy-MM-dd'), editValue);
                                  if (e.key === 'Escape') setEditingDate(null);
                                }}
                                onBlur={() => saveManualIst(format(row.day, 'yyyy-MM-dd'), editValue)}
                                autoFocus
                                className="w-20 text-right border border-primary rounded px-1 py-0 text-xs bg-background tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                                placeholder="Brutto"
                              />
                              <button onMouseDown={() => saveManualIst(format(row.day, 'yyyy-MM-dd'), editValue)} className="text-emerald-600 hover:text-emerald-700">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              </button>
                              <button onMouseDown={() => setEditingDate(null)} className="text-muted-foreground hover:text-foreground">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div
                              className="flex items-center gap-1 justify-end cursor-pointer"
                              onClick={() => openEdit(format(row.day, 'yyyy-MM-dd'), dailyBudgets[format(row.day, 'yyyy-MM-dd')]?.actualRevenue ?? 0)}
                              title="Klicken zum manuellen Eintragen"
                            >
                              <span>{row.hasIst ? fmtN(row.ist) : '–'}</span>
                              <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-40 transition-opacity" />
                            </div>
                          )}
                        </td>
                        {/* Umsatz VJ — exakt oder pro-rata (~) */}
                        {showVjCols && (
                          <td className={cn(tdR, row.vjIsExact ? 'text-muted-foreground' : 'text-muted-foreground/60 italic')}>
                            {row.hasVj ? (row.vjIsExact ? '' : '~') + fmtN(row.vj) : '0'}
                          </td>
                        )}
                        {/* WT VJ */}
                        {showVjCols && (
                          <td className={cn(tdL, 'text-[11px]', isWE(row.vjDate) ? 'text-slate-500' : 'text-muted-foreground')}>
                            {wtOf(row.vjDate)}
                          </td>
                        )}
                        {/* Abw. VJ */}
                        {showDevVj && (
                          <td className={cn(tdR, devCls(row.devVj, row.hasIst))}>
                            {row.hasIst ? fmtDev(row.devVj) : '–'}
                          </td>
                        )}
                        {/* Budget */}
                        {showBudCol && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.bud) : '–'}
                          </td>
                        )}
                        {/* Abw. Budget */}
                        {showDevBud && (
                          <td className={cn(tdR, devCls(row.devBud, row.hasIst && hasBud))}>
                            {row.hasIst && hasBud ? fmtDev(row.devBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Ist */}
                        {showKum && (
                          <td className={cn(tdRK, 'font-medium')}>
                            {fmtN(row.cumIst)}
                          </td>
                        )}
                        {/* Kum. VJ */}
                        {showKumVj && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {fmtN(row.cumVj)}
                          </td>
                        )}
                        {/* Kum. Abw. VJ CHF */}
                        {showKumDevVj && (
                          <td className={cn(tdR, devCls(row.cumDevVj, row.cumIst > 0))}>
                            {fmtDev(row.cumDevVj)}
                          </td>
                        )}
                        {/* Kum. Abw. VJ % */}
                        {showKumDevVj && (
                          <td className={cn(tdR, devCls(row.cumDevVjPct, row.cumIst > 0))}>
                            {row.cumVj > 0 ? fmtPct(row.cumDevVjPct) : '–'}
                          </td>
                        )}
                        {/* Kum. Budget */}
                        {showKumBud && (
                          <td className={cn(tdR, 'text-muted-foreground')}>
                            {hasBud ? fmtN(row.cumBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Abw. Budget CHF */}
                        {showKumDevBud && (
                          <td className={cn(tdR, devCls(row.cumDevBud, hasBud))}>
                            {hasBud ? fmtDev(row.cumDevBud) : '–'}
                          </td>
                        )}
                        {/* Kum. Abw. Budget % */}
                        {showKumDevBud && (
                          <td className={cn(tdR, devCls(row.cumDevBudPct, hasBud && row.cumBud > 0))}>
                            {hasBud && row.cumBud > 0 ? fmtPct(row.cumDevBudPct) : '–'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>

                {/* ── Gesamt-Zeile ────────────────────────────────────────── */}
                {lastRow && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/50 font-semibold text-xs">
                      <td className={cn(tdL, 'text-muted-foreground text-[11px]')} colSpan={2}>Gesamt</td>
                      <td className={tdR}>{fmtN(lastRow.cumIst)}</td>
                      {showVjCols && <td className={cn(tdR, 'text-muted-foreground')}>{fmtN(lastRow.cumVj)}</td>}
                      {showVjCols && <td className={tdL} />}
                      {showDevVj  && <td className={cn(tdR, devCls(lastRow.cumDevVj, lastRow.cumIst > 0))}>{fmtDev(lastRow.cumDevVj)}</td>}
                      {showBudCol && <td className={cn(tdR, 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showDevBud && <td className={cn(tdR, devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
                      {showKum    && <td className={cn(tdRK)}>{fmtN(lastRow.cumIst)}</td>}
                      {showKumVj  && <td className={cn(tdR, 'text-muted-foreground')}>{fmtN(lastRow.cumVj)}</td>}
                      {showKumDevVj  && <td className={cn(tdR, devCls(lastRow.cumDevVj, lastRow.cumIst > 0))}>{fmtDev(lastRow.cumDevVj)}</td>}
                      {showKumDevVj  && <td className={cn(tdR, devCls(lastRow.cumDevVjPct, lastRow.cumVj > 0))}>{lastRow.cumVj > 0 ? fmtPct(lastRow.cumDevVjPct) : '–'}</td>}
                      {showKumBud    && <td className={cn(tdR, 'text-muted-foreground')}>{hasBud ? fmtN(lastRow.cumBud) : '–'}</td>}
                      {showKumDevBud && <td className={cn(tdR, devCls(lastRow.cumDevBud, hasBud))}>{hasBud ? fmtDev(lastRow.cumDevBud) : '–'}</td>}
                      {showKumDevBud && <td className={cn(tdR, devCls(lastRow.cumDevBudPct, hasBud && lastRow.cumBud > 0))}>{hasBud && lastRow.cumBud > 0 ? fmtPct(lastRow.cumDevBudPct) : '–'}</td>}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
