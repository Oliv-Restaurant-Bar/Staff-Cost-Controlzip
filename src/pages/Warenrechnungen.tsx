/**
 * Warenrechnungen – Modul zur Erfassung und Kontrolle von Lieferantenrechnungen
 * ==============================================================================
 * Tab A: Erfassung  → KPI-Boxen + Schnellerfassung + letzte Einträge
 * Tab B: Analyse    → Lieferanten-Übersicht + kumulierter Verlauf
 * Mandantenfähig (Oliv / Beaulieu) via TenantContext.
 *
 * Debug-Logs: [WAREN]
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import {
  loadSuppliers,
  saveSuppliers,
  loadMonthInvoices,
  saveInvoiceEntry,
  deleteInvoiceEntry,
  loadDailyRevenueFromLocalStorage,
  loadWarenMonthlyRevenue,
  seedMonthlyRevenueIfMissing,
  computeDailyBudgetRevenue,
  computeMonthStats,
  calcAmounts,
  type Supplier,
  type InvoiceEntry,
} from '@/lib/waren-db';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  ShoppingCart, Plus, Pencil, Trash2, Settings2, ChevronLeft, ChevronRight,
  TrendingUp, AlertCircle, CheckCircle2, Package, BarChart3, ClipboardList, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Dot, Cell,
} from 'recharts';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface EntryForm {
  date: string;
  supplierName: string;
  amount: string;
  vatIncluded: boolean;
  vatRate: string;
  reference: string;
  note: string;
}

const EMPTY_FORM: EntryForm = {
  date: new Date().toISOString().split('T')[0],
  supplierName: '',
  amount: '',
  vatIncluded: true,
  vatRate: '8.1',
  reference: '',
  note: '',
};

const VAT_RATES = ['8.1', '2.6', '3.8', '0'];

const MONTHS     = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const MONTHS_LONG = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

type Tab         = 'erfassung' | 'analyse';
type AnalyseMode = 'week' | 'month' | 'multi_month' | 'year' | 'ytd';

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmtChf(val: number): string {
  return val.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(val: number): string {
  return val.toFixed(1) + ' %';
}
function generateId(): string {
  return `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function getDaysInMonth(year: number, month: number): string[] {
  const days: string[] = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    days.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return days;
}
function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}
function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

// ISO-Kalenderwoche (Mo–So) + Wochenjahr
function getIsoWeek(dateStr: string): { week: number; isoYear: number; weekLabel: string } {
  const d = new Date(dateStr + 'T12:00:00');
  const tmp = new Date(d);
  tmp.setHours(0, 0, 0, 0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const jan4 = new Date(tmp.getFullYear(), 0, 4);
  const week = 1 + Math.round(((tmp.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return { week, isoYear: tmp.getFullYear(), weekLabel: `KW ${String(week).padStart(2, '0')}` };
}

// Montag und Sonntag einer ISO-Woche als Datumsstring
function isoWeekRange(isoYear: number, week: number): { from: string; to: string } {
  const jan4 = new Date(isoYear, 0, 4);
  const dayOfWeek = (jan4.getDay() + 6) % 7; // 0 = Mon
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return { from: fmt(monday), to: fmt(sunday) };
}

// ─── KPI-Box ──────────────────────────────────────────────────────────────────

const KpiBox = ({
  label, value, sub, sub2, icon: Icon, variant = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  sub2?: string;
  icon?: React.FC<{ className?: string }>;
  variant?: 'default' | 'warn' | 'alert' | 'ok' | 'muted';
}) => {
  const bg: Record<string, string> = {
    default: 'bg-card border-border',
    warn:    'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800',
    alert:   'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800',
    ok:      'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800',
    muted:   'bg-muted/30 border-border',
  };
  const vc: Record<string, string> = {
    default: 'text-foreground',
    warn:    'text-amber-700 dark:text-amber-400',
    alert:   'text-red-700 dark:text-red-400',
    ok:      'text-emerald-700 dark:text-emerald-400',
    muted:   'text-muted-foreground',
  };
  const dot: Record<string, string> = {
    default: 'bg-blue-400',
    warn:    'bg-amber-400',
    alert:   'bg-red-500',
    ok:      'bg-emerald-500',
    muted:   'bg-muted-foreground/30',
  };
  return (
    <div className={cn('rounded-xl border p-4 flex flex-col gap-1 min-h-[96px]', bg[variant])}>
      <div className="flex items-center gap-1.5">
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dot[variant])} />
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <p className="text-xs text-muted-foreground font-medium leading-tight">{label}</p>
      </div>
      <p className={cn('text-2xl font-bold tabular-nums leading-none mt-0.5', vc[variant])}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground leading-tight">{sub}</p>}
      {sub2 && <p className="text-[11px] text-muted-foreground/60 leading-tight">{sub2}</p>}
    </div>
  );
};

// ─── Pct-Badge ────────────────────────────────────────────────────────────────

function PctBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-muted-foreground/40">–</span>;
  const cls = pct > 35
    ? 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400'
    : pct > 30
    ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400';
  return (
    <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-mono font-semibold tabular-nums', cls)}>
      {fmtPct(pct)}
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function WarenrechnungenPage() {
  const { tenantId, tenant } = useTenant();
  const { role, warenrechnungenPerms } = usePermissions();
  const { canView, canCreate, canEdit, canDelete, canExport } = warenrechnungenPerms;

  // ─── Permissions Debug-Logs ──────────────────────────────────────────────
  useEffect(() => {
    console.log(`[PERMISSIONS] role: ${role}`);
    console.log(`[PERMISSIONS] module: warenrechnungen`);
    console.log(`[PERMISSIONS] view: ${canView}`);
    console.log(`[PERMISSIONS] create: ${canCreate}`);
    console.log(`[PERMISSIONS] edit: ${canEdit}`);
    console.log(`[PERMISSIONS] delete: ${canDelete}`);
    console.log(`[PERMISSIONS] export: ${canExport}`);
  }, [role, canView, canCreate, canEdit, canDelete, canExport]);

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  const [suppliers,      setSuppliers]      = useState<Supplier[]>([]);
  const [entries,        setEntries]        = useState<InvoiceEntry[]>([]);
  const [revenueByDate,  setRevenueByDate]  = useState<Record<string, number>>({});
  const [loading,        setLoading]        = useState(true);
  const [tab,            setTab]            = useState<Tab>('erfassung');

  const [form,              setForm]              = useState<EntryForm>(EMPTY_FORM);
  const [saving,            setSaving]            = useState(false);
  const [editEntry,         setEditEntry]         = useState<InvoiceEntry | null>(null);
  const [showEditDialog,    setShowEditDialog]    = useState(false);
  const [showSupplierDialog,setShowSupplierDialog]= useState(false);
  const [newSupplierName,   setNewSupplierName]   = useState('');
  const [deleteConfirm,     setDeleteConfirm]     = useState<string | null>(null);
  const [targetPct,         setTargetPct]         = useState<number>(30);

  // ─── Analyse: Zeitraum-Steuerung ──────────────────────────────────────────
  const [analyseMode, setAnalyseMode] = useState<AnalyseMode>('month');
  const [aYear,       setAYear]       = useState(today.getFullYear());
  const [aMonth,      setAMonth]      = useState(today.getMonth() + 1);
  const [aWeekNum,    setAWeekNum]    = useState(() => getIsoWeek(new Date().toISOString().split('T')[0]).week);
  const [aFromYear,   setAFromYear]   = useState(today.getFullYear());
  const [aFromMonth,  setAFromMonth]  = useState(() => { const m = today.getMonth(); return m < 1 ? 12 : m; });
  const [aToYear,     setAToYear]     = useState(today.getFullYear());
  const [aToMonth,    setAToMonth]    = useState(today.getMonth() + 1);
  const [aRangeYear,  setARangeYear]  = useState(today.getFullYear());
  const [rangeEntries, setRangeEntries] = useState<InvoiceEntry[]>([]);
  const [rangeRevenue, setRangeRevenue] = useState<Record<string, number>>({});
  const [monthlyRevBudget, setMonthlyRevBudget] = useState<Record<string, number>>({}); // YYYY-MM → CHF
  const [rangeLoading, setRangeLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    console.log(`[WAREN] tenant: ${tenantId} · month: ${monthKey}`);
    const [sups, invs] = await Promise.all([
      loadSuppliers(tenantId),
      loadMonthInvoices(tenantId, monthKey),
    ]);
    const rev = loadDailyRevenueFromLocalStorage(tenantId, monthKey);
    setSuppliers(sups);
    setEntries(invs);
    setRevenueByDate(rev);
    setLoading(false);
  }, [tenantId, monthKey]);

  useEffect(() => { loadData(); }, [loadData]);

  const loadAnalyseRange = useCallback(async () => {
    setRangeLoading(true);
    let monthKeys: string[] = [];
    if (analyseMode === 'week') {
      const { from, to } = isoWeekRange(aYear, aWeekNum);
      const seen = new Set<string>();
      let d = new Date(from + 'T12:00:00');
      const toD = new Date(to + 'T12:00:00');
      while (d <= toD) {
        seen.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
        d.setDate(d.getDate() + 1);
      }
      monthKeys = Array.from(seen);
    } else if (analyseMode === 'month') {
      monthKeys = [`${aYear}-${String(aMonth).padStart(2,'0')}`];
    } else if (analyseMode === 'multi_month') {
      let y = aFromYear, m = aFromMonth;
      const endKey = `${aToYear}-${String(aToMonth).padStart(2,'0')}`;
      for (let i = 0; i < 25; i++) {
        const k = `${y}-${String(m).padStart(2,'0')}`;
        monthKeys.push(k);
        if (k === endKey) break;
        m++; if (m > 12) { m = 1; y++; }
      }
    } else {
      for (let m2 = 1; m2 <= 12; m2++) {
        monthKeys.push(`${aRangeYear}-${String(m2).padStart(2,'0')}`);
      }
    }
    const results = await Promise.all(monthKeys.map(mk => loadMonthInvoices(tenantId, mk)));
    const allEntries: InvoiceEntry[] = results.flat();
    const allRevenue: Record<string, number> = {};
    for (const mk of monthKeys) {
      Object.assign(allRevenue, loadDailyRevenueFromLocalStorage(tenantId, mk));
    }
    // Monatliches Umsatz-Budget laden (als Fallback wenn kein tagesgenauer Umsatz vorhanden)
    // Seed-Daten werden beim ersten Aufruf automatisch eingetragen (einmalig, authentifiziert)
    const years = Array.from(new Set(monthKeys.map(mk => Number(mk.slice(0, 4)))));
    await Promise.all(years.map(y => seedMonthlyRevenueIfMissing(tenantId, y)));
    const budgetResults = await Promise.all(years.map(y => loadWarenMonthlyRevenue(tenantId, y)));
    const allBudget: Record<string, number> = {};
    budgetResults.forEach(b => Object.assign(allBudget, b));

    // Tagesverteilung: für Monate ohne tagesgenauem Umsatz → Budget verteilen
    // Gewichtung: Mo–Fr = 15, Sa = 10, So = 0 (geschlossen)
    for (const mk of monthKeys) {
      const monthBudget = allBudget[mk];
      if (!monthBudget || monthBudget <= 0) continue;
      const [y2, m2] = mk.split('-').map(Number);
      const daysInMk = getDaysInMonth(y2, m2);
      const hasActual = daysInMk.some(d => (allRevenue[d] ?? 0) > 0);
      if (!hasActual) {
        for (const d of daysInMk) {
          const daily = computeDailyBudgetRevenue(monthBudget, d, daysInMk);
          if (daily > 0) allRevenue[d] = daily;
        }
        console.log(`[WAREN] budget distributed for ${mk}: ${daysInMk.filter(d => (allRevenue[d] ?? 0) > 0).length} Tage mit Umsatz`);
      }
    }

    setRangeEntries(allEntries);
    setRangeRevenue(allRevenue);
    setMonthlyRevBudget(allBudget);
    setRangeLoading(false);
  }, [analyseMode, aYear, aMonth, aWeekNum, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, tenantId]);

  useEffect(() => { void loadAnalyseRange(); }, [loadAnalyseRange]);

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

  const stats = useMemo(() => computeMonthStats(entries, revenueByDate), [entries, revenueByDate]);

  const totalRevenue = useMemo(
    () => Object.values(revenueByDate).reduce((s, v) => s + v, 0),
    [revenueByDate],
  );
  const monthPct     = totalRevenue > 0 ? (stats.totalNet / totalRevenue) * 100 : null;
  const todayNet     = useMemo(() => entries.filter(e => e.date === todayStr).reduce((s, e) => s + e.amountNet, 0), [entries, todayStr]);
  const todayRevenue = revenueByDate[todayStr] ?? 0;
  const todayPct     = todayRevenue > 0 ? (todayNet / todayRevenue) * 100 : null;

  const datesWithEntries = useMemo(() => Array.from(new Set(entries.map(e => e.date))).sort(), [entries]);

  const tableDates = useMemo(() => {
    const all  = getDaysInMonth(year, month);
    const past = all.filter(d => d <= todayStr);
    return past.slice(-14);
  }, [year, month, todayStr]);

  const liveAmounts = useMemo(() => {
    if (!form.amount || isNaN(Number(form.amount))) return null;
    return calcAmounts(Number(form.amount), form.vatIncluded, Number(form.vatRate));
  }, [form.amount, form.vatIncluded, form.vatRate]);

  const activeSuppliers    = suppliers.filter(s => s.active);
  const suppliersWithEntries = stats.supplierTotals.length;

  function getCumulative(upToDate: string) {
    const cumNet = entries.filter(e => e.date <= upToDate).reduce((s, e) => s + e.amountNet, 0);
    const cumRev = Object.entries(revenueByDate).filter(([d]) => d <= upToDate).reduce((s, [, v]) => s + v, 0);
    return { cumNet, cumRev, pct: cumRev > 0 ? (cumNet / cumRev) * 100 : null };
  }

  // ─── Chart-Daten ────────────────────────────────────────────────────────────

  interface ChartPoint {
    date:    string;
    label:   string;
    dayNet:  number;
    dayRev:  number;
    dayPct:  number | null;
    cumNet:  number;
    cumRev:  number;
    cumPct:  number | null;
    hasEntry: boolean;
  }

  // ─── Wochen-Daten ───────────────────────────────────────────────────────────

  type WeekStatus = 'green' | 'yellow' | 'red' | 'nodata';

  interface WeekData {
    weekKey:   string;   // "2026-W14"
    weekLabel: string;   // "KW 14"
    from:      string;   // "2026-04-01"
    to:        string;   // "2026-04-07"
    revenue:   number;
    costNet:   number;
    pct:       number | null;
    cumNet:    number;
    cumRev:    number;
    cumPct:    number | null;
    status:    WeekStatus;
    isCurrent: boolean;
    isComplete: boolean; // Sonntag der Woche liegt in der Vergangenheit
  }

  const weeklyData = useMemo((): WeekData[] => {
    const allDays = getDaysInMonth(year, month);
    // Nur vergangene oder heutige Tage
    const pastDays = allDays.filter(d => d <= todayStr);

    // Alle vorkommenden Wochen sammeln
    const weekKeys = new Set<string>();
    for (const d of pastDays) {
      const { week, isoYear } = getIsoWeek(d);
      weekKeys.add(`${isoYear}-W${String(week).padStart(2, '0')}`);
    }

    // Kumulierte Werte über den ganzen Monat
    let runCumNet = 0;
    let runCumRev = 0;
    const cumByDate: Record<string, { cumNet: number; cumRev: number }> = {};
    for (const d of allDays.filter(d2 => d2 <= todayStr)) {
      runCumNet += entries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
      runCumRev += revenueByDate[d] ?? 0;
      cumByDate[d] = { cumNet: runCumNet, cumRev: runCumRev };
    }

    const currentWeekKey = (() => { const { week, isoYear } = getIsoWeek(todayStr); return `${isoYear}-W${String(week).padStart(2, '0')}`; })();

    const result: WeekData[] = [];
    for (const wk of Array.from(weekKeys).sort()) {
      const [isoYStr, wStr] = wk.split('-W');
      const isoYear = Number(isoYStr);
      const week    = Number(wStr);
      const { from, to } = isoWeekRange(isoYear, week);

      // Tage dieser Woche die im Monat und Vergangenheit liegen
      const weekDays = pastDays.filter(d => d >= from && d <= to);

      const revenue = weekDays.reduce((s, d) => s + (revenueByDate[d] ?? 0), 0);
      const costNet = weekDays.reduce((s, d) => s + entries.filter(e => e.date === d).reduce((s2, e) => s2 + e.amountNet, 0), 0);
      const pct     = revenue > 0 ? (costNet / revenue) * 100 : null;

      // Kumuliert bis Ende der Woche (letzter bekannter Tag)
      const lastDay    = weekDays[weekDays.length - 1] ?? to;
      const cum        = cumByDate[lastDay] ?? { cumNet: 0, cumRev: 0 };
      const cumPct     = cum.cumRev > 0 ? (cum.cumNet / cum.cumRev) * 100 : null;
      const isComplete = to <= todayStr;
      const isCurrent  = wk === currentWeekKey;

      const status: WeekStatus = (() => {
        if (pct === null) return 'nodata';
        if (pct <= targetPct)            return 'green';
        if (pct <= targetPct + 2)        return 'yellow';
        return 'red';
      })();

      console.log(`[WAREN-WEEK] tenant: ${tenantId}`);
      console.log(`[WAREN-WEEK] week: ${wk} (${from}–${to})`);
      console.log(`[WAREN-WEEK] revenue: CHF ${revenue.toFixed(0)}`);
      console.log(`[WAREN-WEEK] cost chf: CHF ${costNet.toFixed(0)}`);
      console.log(`[WAREN-WEEK] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
      console.log(`[WAREN-WEEK] status: ${status}`);

      result.push({
        weekKey: wk, weekLabel: `KW ${String(week).padStart(2, '0')}`,
        from, to, revenue, costNet, pct, cumNet: cum.cumNet, cumRev: cum.cumRev,
        cumPct, status, isCurrent, isComplete,
      });
    }

    // Aktuelle Woche oben, dann nach Status (rot zuerst), dann nach Wochennummer absteigend
    return result.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return  1;
      const order: Record<WeekStatus, number> = { red: 0, yellow: 1, green: 2, nodata: 3 };
      return order[a.status] - order[b.status];
    });
  }, [entries, revenueByDate, year, month, todayStr, targetPct, tenantId]);

  const chartData = useMemo((): ChartPoint[] => {
    const allDays = getDaysInMonth(year, month);
    const past = allDays.filter(d => d <= todayStr);
    let cumNet = 0;
    let cumRev = 0;
    const points = past.map(d => {
      const dayNet = entries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
      const dayRev = revenueByDate[d] ?? 0;
      cumNet += dayNet;
      cumRev += dayRev;
      const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
      const cumPct = cumRev > 0 ? (cumNet / cumRev) * 100 : null;
      return { date: d, label: formatDateShort(d), dayNet, dayRev, dayPct, cumNet, cumRev, cumPct, hasEntry: dayNet > 0 };
    });
    const daysLoaded = points.filter(p => p.hasEntry).length;
    const lastCum = points.length > 0 ? points[points.length - 1].cumPct : null;
    console.log(`[WAREN-CHART] tenant: ${tenantId}`);
    console.log(`[WAREN-CHART] days loaded: ${daysLoaded}`);
    console.log(`[WAREN-CHART] cumulative pct: ${lastCum !== null ? lastCum.toFixed(1) + '%' : '–'}`);
    console.log(`[WAREN-CHART] daily pct: ${points.filter(p => p.dayPct !== null).map(p => p.dayPct!.toFixed(1) + '%').join(', ') || '–'}`);
    return points;
  }, [entries, revenueByDate, year, month, todayStr, tenantId]);

  // ─── Analyse: abgeleitete Daten ──────────────────────────────────────────

  const analyseDates = useMemo((): { from: string; to: string } => {
    if (analyseMode === 'week') {
      return isoWeekRange(aYear, aWeekNum);
    } else if (analyseMode === 'month') {
      const days = getDaysInMonth(aYear, aMonth);
      return { from: days[0], to: days[days.length - 1] };
    } else if (analyseMode === 'multi_month') {
      const fromDays = getDaysInMonth(aFromYear, aFromMonth);
      const toDays   = getDaysInMonth(aToYear, aToMonth);
      return { from: fromDays[0], to: toDays[toDays.length - 1] };
    } else if (analyseMode === 'ytd') {
      return { from: `${aRangeYear}-01-01`, to: todayStr };
    } else {
      return { from: `${aRangeYear}-01-01`, to: `${aRangeYear}-12-31` };
    }
  }, [analyseMode, aYear, aMonth, aWeekNum, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, todayStr]);

  const analysisEntries = useMemo(
    () => rangeEntries.filter(e => e.date >= analyseDates.from && e.date <= analyseDates.to),
    [rangeEntries, analyseDates],
  );

  const analysisRevenue = useMemo(() => {
    const rv: Record<string, number> = {};
    for (const [k, v] of Object.entries(rangeRevenue)) {
      if (k >= analyseDates.from && k <= analyseDates.to) rv[k] = v;
    }
    return rv;
  }, [rangeRevenue, analyseDates]);

  const analyseKPIs = useMemo(() => {
    const effectiveTo = analyseDates.to > todayStr ? todayStr : analyseDates.to;
    const totalRev  = Object.entries(analysisRevenue).filter(([k]) => k <= effectiveTo).reduce((s, [, v]) => s + v, 0);
    const totalCost = analysisEntries.filter(e => e.date <= effectiveTo).reduce((s, e) => s + e.amountNet, 0);
    const pct = totalRev > 0 ? (totalCost / totalRev) * 100 : null;
    console.log(`[WAREN-ANALYSE] mode: ${analyseMode}`);
    console.log(`[WAREN-ANALYSE] range: ${analyseDates.from} – ${effectiveTo}`);
    console.log(`[WAREN-ANALYSE] revenue total: CHF ${totalRev.toFixed(0)}`);
    console.log(`[WAREN-ANALYSE] cost total: CHF ${totalCost.toFixed(0)}`);
    console.log(`[WAREN-ANALYSE] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
    return { totalRev, totalCost, pct };
  }, [analysisEntries, analysisRevenue, analyseDates, analyseMode, todayStr]);

  const analyseSuppliers = useMemo(() => {
    const effectiveTo = analyseDates.to > todayStr ? todayStr : analyseDates.to;
    const map: Record<string, { net: number; gross: number }> = {};
    for (const e of analysisEntries.filter(x => x.date <= effectiveTo)) {
      if (!map[e.supplierName]) map[e.supplierName] = { net: 0, gross: 0 };
      map[e.supplierName].net   += e.amountNet;
      map[e.supplierName].gross += e.amountGross;
    }
    return Object.entries(map)
      .map(([name, v]) => ({ name, net: v.net, gross: v.gross }))
      .sort((a, b) => b.net - a.net);
  }, [analysisEntries, analyseDates, todayStr]);

  // Tages-Chart (Woche / Monat)
  interface AChartPoint { date: string; label: string; dayNet: number; dayRev: number; dayPct: number | null; cumNet: number; cumRev: number; cumPct: number | null; hasEntry: boolean; }
  const analyseChartPoints = useMemo((): AChartPoint[] => {
    if (analyseMode !== 'week' && analyseMode !== 'month') return [];
    const allDays = (() => {
      if (analyseMode === 'week') {
        const days: string[] = [];
        const d = new Date(analyseDates.from + 'T12:00:00');
        while (d.toISOString().split('T')[0] <= analyseDates.to) {
          days.push(d.toISOString().split('T')[0]);
          d.setDate(d.getDate() + 1);
        }
        return days;
      }
      return getDaysInMonth(aYear, aMonth);
    })();
    const past = allDays.filter(d => d <= todayStr);
    let cumNet = 0, cumRev = 0;
    return past.map(d => {
      const dayNet = analysisEntries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
      const dayRev = analysisRevenue[d] ?? 0;
      cumNet += dayNet; cumRev += dayRev;
      const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
      const cumPct = cumRev > 0 ? (cumNet / cumRev) * 100 : null;
      return { date: d, label: formatDateShort(d), dayNet, dayRev, dayPct, cumNet, cumRev, cumPct, hasEntry: dayNet > 0 };
    });
  }, [analyseMode, analysisEntries, analysisRevenue, analyseDates, aYear, aMonth, todayStr]);

  // Monats-Chart (Mehrere Monate / Jahr / YTD)
  interface AMonthPoint { monthKey: string; label: string; revenue: number; costNet: number; pct: number | null; cumNet: number; cumRev: number; cumPct: number | null; }
  const analyseMonthPoints = useMemo((): AMonthPoint[] => {
    if (analyseMode === 'week' || analyseMode === 'month') return [];
    const monthList: string[] = [];
    if (analyseMode === 'multi_month') {
      let y = aFromYear, m = aFromMonth;
      const endKey = `${aToYear}-${String(aToMonth).padStart(2,'0')}`;
      for (let i = 0; i < 25; i++) {
        const k = `${y}-${String(m).padStart(2,'0')}`;
        monthList.push(k);
        if (k === endKey) break;
        m++; if (m > 12) { m = 1; y++; }
      }
    } else {
      for (let m2 = 1; m2 <= 12; m2++) {
        monthList.push(`${aRangeYear}-${String(m2).padStart(2,'0')}`);
      }
    }
    let cumNet = 0, cumRev = 0;
    return monthList.map(mk => {
      const [y, m] = mk.split('-').map(Number);
      const days   = getDaysInMonth(y, m);
      const pastDs = days.filter(d => d <= todayStr && d <= analyseDates.to);
      const revenue = pastDs.reduce((s, d) => s + (rangeRevenue[d] ?? 0), 0);
      const costNet = rangeEntries.filter(e => e.date >= days[0] && e.date <= days[days.length-1] && e.date <= todayStr).reduce((s, e) => s + e.amountNet, 0);
      cumNet += costNet; cumRev += revenue;
      const pct    = revenue > 0 ? (costNet / revenue) * 100 : null;
      const cumPct = cumRev > 0 ? (cumNet / cumRev) * 100 : null;
      // Debug-Logs
      console.log(`[WAREN-YEAR] month: ${mk}`);
      console.log(`[WAREN-YEAR] revenue: CHF ${revenue.toFixed(0)}`);
      console.log(`[WAREN-YEAR] cost chf: CHF ${costNet.toFixed(0)}`);
      console.log(`[WAREN-YEAR] cost pct: ${pct !== null ? pct.toFixed(1) + '%' : '–'}`);
      console.log(`[WAREN-YEAR] status: ${pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red'}`);
      return { monthKey: mk, label: `${MONTHS[m-1]} ${y !== aRangeYear ? y : ''}`.trim(), revenue, costNet, pct, cumNet, cumRev, cumPct };
    });
  }, [analyseMode, aFromYear, aFromMonth, aToYear, aToMonth, aRangeYear, rangeEntries, rangeRevenue, analyseDates, todayStr, targetPct]);

  // Wochen-Alerts (innerhalb des gewählten Analyse-Zeitraums, nur Monat-Modus sinnvoll)
  const analyseWeeklyData = useMemo((): WeekData[] => {
    if (analyseMode !== 'month') return [];
    const allDays = getDaysInMonth(aYear, aMonth);
    const pastDays = allDays.filter(d => d <= todayStr);
    const weekKeys = new Set<string>();
    for (const d of pastDays) {
      const { week, isoYear } = getIsoWeek(d);
      weekKeys.add(`${isoYear}-W${String(week).padStart(2,'0')}`);
    }
    let runCumNet = 0, runCumRev = 0;
    const cumByDate: Record<string, { cumNet: number; cumRev: number }> = {};
    for (const d of pastDays) {
      runCumNet += analysisEntries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
      runCumRev += analysisRevenue[d] ?? 0;
      cumByDate[d] = { cumNet: runCumNet, cumRev: runCumRev };
    }
    const currentWeekKey = (() => { const { week, isoYear } = getIsoWeek(todayStr); return `${isoYear}-W${String(week).padStart(2,'0')}`; })();
    const result: WeekData[] = [];
    for (const wk of Array.from(weekKeys).sort()) {
      const [isoYStr, wStr] = wk.split('-W');
      const isoYear2 = Number(isoYStr); const week2 = Number(wStr);
      const { from, to } = isoWeekRange(isoYear2, week2);
      const weekDays = pastDays.filter(d => d >= from && d <= to);
      const revenue = weekDays.reduce((s, d) => s + (analysisRevenue[d] ?? 0), 0);
      const costNet = weekDays.reduce((s, d) => s + analysisEntries.filter(e => e.date === d).reduce((s2, e) => s2 + e.amountNet, 0), 0);
      const pct = revenue > 0 ? (costNet / revenue) * 100 : null;
      const lastDay = weekDays[weekDays.length - 1] ?? to;
      const cum = cumByDate[lastDay] ?? { cumNet: 0, cumRev: 0 };
      const cumPct = cum.cumRev > 0 ? (cum.cumNet / cum.cumRev) * 100 : null;
      const isComplete = to <= todayStr; const isCurrent = wk === currentWeekKey;
      const status: WeekStatus = pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
      result.push({ weekKey: wk, weekLabel: `KW ${String(week2).padStart(2,'0')}`, from, to, revenue, costNet, pct, cumNet: cum.cumNet, cumRev: cum.cumRev, cumPct, status, isCurrent, isComplete });
    }
    return result.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1; if (!a.isCurrent && b.isCurrent) return 1;
      const o: Record<WeekStatus, number> = { red: 0, yellow: 1, green: 2, nodata: 3 };
      return o[a.status] - o[b.status];
    });
  }, [analyseMode, analysisEntries, analysisRevenue, aYear, aMonth, targetPct, todayStr]);

  // Navigation-Helfer für Analyse
  const prevAWeek = () => { let w = aWeekNum - 1, y = aYear; if (w < 1) { y--; w = getIsoWeek(`${y}-12-28`).week; } setAWeekNum(w); setAYear(y); };
  const nextAWeek = () => { const maxW = getIsoWeek(`${aYear}-12-28`).week; let w = aWeekNum + 1, y = aYear; if (w > maxW) { w = 1; y++; } setAWeekNum(w); setAYear(y); };
  const isCurrentAWeek = aYear === today.getFullYear() && aWeekNum === getIsoWeek(todayStr).week;
  const prevAMonth = () => { if (aMonth === 1) { setAYear(y => y - 1); setAMonth(12); } else setAMonth(m => m - 1); };
  const nextAMonth = () => { if (aMonth === 12) { setAYear(y => y + 1); setAMonth(1); } else setAMonth(m => m + 1); };
  const isCurrentAMonth = aYear === today.getFullYear() && aMonth === today.getMonth() + 1;
  const analyseRangeLabel = (() => {
    if (analyseMode === 'week')        return `KW ${String(aWeekNum).padStart(2,'0')} · ${aYear}`;
    if (analyseMode === 'month')       return `${MONTHS_LONG[aMonth-1]} ${aYear}`;
    if (analyseMode === 'multi_month') return `${MONTHS[aFromMonth-1]} ${aFromYear} – ${MONTHS[aToMonth-1]} ${aToYear}`;
    if (analyseMode === 'ytd')         return `YTD ${aRangeYear} (Jan – heute)`;
    return `Jahr ${aRangeYear}`;
  })();

  async function handleSave() {
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    if (!form.supplierName) { toast.error('Bitte Lieferant wählen.'); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) {
      toast.error('Bitte gültigen Betrag eingeben.'); return;
    }
    const amounts = calcAmounts(Number(form.amount), form.vatIncluded, Number(form.vatRate));
    setSaving(true);
    const entry: InvoiceEntry = {
      id: generateId(), date: form.date, supplierName: form.supplierName,
      amountGross: amounts.amountGross, amountNet: amounts.amountNet,
      vatIncluded: form.vatIncluded, vatRate: Number(form.vatRate),
      reference: form.reference || undefined, note: form.note || undefined,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await saveInvoiceEntry(tenantId, entry);
    console.log(`[WAREN] entry saved: ${entry.supplierName} · ${entry.date} · net CHF ${entry.amountNet.toFixed(2)}`);
    await loadData();
    setForm(f => ({ ...EMPTY_FORM, date: f.date, supplierName: f.supplierName, vatRate: f.vatRate, vatIncluded: f.vatIncluded }));
    toast.success(`${form.supplierName} · CHF ${fmtChf(amounts.amountNet)} netto gespeichert`);
    setSaving(false);
  }

  async function handleEditSave() {
    if (!canEdit) { toast.error('Keine Berechtigung zum Bearbeiten von Einträgen.'); return; }
    if (!editEntry) return;
    setSaving(true);
    await saveInvoiceEntry(tenantId, { ...editEntry, updatedAt: new Date().toISOString() });
    console.log(`[WAREN] entry updated: ${editEntry.id}`);
    await loadData();
    setShowEditDialog(false);
    setEditEntry(null);
    toast.success('Eintrag aktualisiert.');
    setSaving(false);
  }

  async function handleDelete(entry: InvoiceEntry) {
    if (!canDelete) { toast.error('Keine Berechtigung zum Löschen von Einträgen.'); return; }
    await deleteInvoiceEntry(tenantId, entry.id, entry.date);
    console.log(`[WAREN] entry deleted: ${entry.id}`);
    await loadData();
    setDeleteConfirm(null);
    toast.success('Eintrag gelöscht.');
  }

  async function handleAddSupplier() {
    const name = newSupplierName.trim();
    if (!name) return;
    if (suppliers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      toast.error('Lieferant existiert bereits.'); return;
    }
    const updated: Supplier[] = [...suppliers, { id: `sup-${Date.now()}`, name, active: true, createdAt: new Date().toISOString() }];
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
    setNewSupplierName('');
    toast.success(`"${name}" hinzugefügt.`);
  }

  async function handleToggleSupplier(sup: Supplier) {
    const updated = suppliers.map(s => s.id === sup.id ? { ...s, active: !s.active } : s);
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
  const kpiVariant = (pct: number | null): 'ok' | 'warn' | 'alert' | 'muted' => {
    if (pct === null) return 'muted';
    if (pct > 35) return 'alert';
    if (pct > 30) return 'warn';
    return 'ok';
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">

      {/* ── Sticky Header ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap">

          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="p-1.5 rounded-lg flex-shrink-0" style={{ backgroundColor: tenant.color + '18' }}>
              <ShoppingCart className="h-4 w-4" style={{ color: tenant.color }} />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-none">Warenrechnungen</h1>
              <p className="text-xs text-muted-foreground mt-0.5">{tenant.name}</p>
            </div>
          </div>

          {/* Monat */}
          <div className="flex items-center gap-1.5">
            <button onClick={prevMonth} className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold tabular-nums min-w-[148px] text-center">{monthLabel}</span>
            <button onClick={nextMonth} disabled={isCurrentMonth} className="h-8 w-8 rounded-md border border-border flex items-center justify-center hover:bg-muted transition-colors disabled:opacity-40">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Lieferanten – nur für Benutzer mit Schreibrecht */}
          {canCreate && (
          <Button variant="outline" size="sm" onClick={() => setShowSupplierDialog(true)} className="h-8 gap-1.5 text-xs">
            <Settings2 className="h-3.5 w-3.5" />
            Lieferanten
          </Button>
          )}
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 flex gap-0 border-t border-border/50">
          {([
            { id: 'erfassung', label: 'Erfassung',  Icon: ClipboardList },
            { id: 'analyse',   label: 'Analyse',    Icon: BarChart3     },
          ] as { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              <t.Icon className="h-3.5 w-3.5" />
              {t.label}
              {t.id === 'erfassung' && entries.length > 0 && (
                <span className="ml-1 text-[10px] bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 font-mono">
                  {entries.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── Inhalt ──────────────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm gap-2">
            <span className="animate-spin rounded-full h-4 w-4 border-2 border-border border-t-foreground" />
            Wird geladen…
          </div>
        ) : (
          <>
            {/* ── KPI-Block (immer sichtbar) ──────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
              <KpiBox
                label="Warenkosten heute"
                value={`CHF ${fmtChf(todayNet)}`}
                sub={todayPct !== null ? `${fmtPct(todayPct)} vom Umsatz` : 'Kein Umsatz'}
                sub2={isCurrentMonth ? undefined : undefined}
                icon={ShoppingCart}
                variant={todayNet === 0 ? 'muted' : kpiVariant(todayPct)}
              />
              <KpiBox
                label="Warenkosten heute %"
                value={todayPct !== null ? fmtPct(todayPct) : '–'}
                sub={todayRevenue > 0 ? `Umsatz CHF ${fmtChf(todayRevenue)}` : 'Kein Umsatz'}
                icon={TrendingUp}
                variant={kpiVariant(todayPct)}
              />
              <KpiBox
                label="Warenkosten Monat"
                value={`CHF ${fmtChf(stats.totalNet)}`}
                sub={`${stats.entryCount} Einträge (exkl. MWST)`}
                icon={Package}
                variant={stats.totalNet > 0 ? 'default' : 'muted'}
              />
              <KpiBox
                label="Warenkosten Monat %"
                value={monthPct !== null ? fmtPct(monthPct) : '–'}
                sub={monthPct !== null ? `Ziel ≤ 30 %` : 'Kein Umsatz'}
                sub2={monthPct !== null && monthPct <= 30 ? '✓ Im Zielbereich' : monthPct !== null ? '↑ Über Ziel' : undefined}
                icon={TrendingUp}
                variant={kpiVariant(monthPct)}
              />
              <KpiBox
                label="Kum. Umsatz Monat"
                value={totalRevenue > 0 ? `CHF ${fmtChf(totalRevenue)}` : '–'}
                sub={totalRevenue === 0 ? 'Keine Umsatzdaten' : `${Object.keys(revenueByDate).length} Tage`}
                icon={TrendingUp}
                variant={totalRevenue > 0 ? 'default' : 'muted'}
              />
              <KpiBox
                label="Lieferanten aktiv"
                value={String(suppliersWithEntries)}
                sub={`von ${activeSuppliers.length} verfügbar`}
                icon={CheckCircle2}
                variant={suppliersWithEntries > 0 ? 'ok' : 'muted'}
              />
            </div>

            {/* ── Tab: Erfassung ────────────────────────────────────────── */}
            {tab === 'erfassung' && (
              <div className="space-y-5">

                {/* Schnellerfassung – nur für Benutzer mit Erfassungsrecht */}
                {!canCreate && (
                  <div className="flex items-center gap-2.5 text-xs text-muted-foreground bg-muted/30 border border-border rounded-lg px-4 py-3">
                    <ShieldCheck className="h-4 w-4 flex-shrink-0" />
                    <span>Lesezugriff – Erfassen, Bearbeiten und Löschen ist für diese Rolle nicht erlaubt.</span>
                  </div>
                )}
                {canCreate && (
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
                    <Plus className="h-4 w-4" style={{ color: tenant.color }} />
                    <h2 className="text-sm font-semibold">Neue Rechnung erfassen</h2>
                  </div>
                  <div className="px-5 py-4 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end">

                      {/* Datum */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Datum</Label>
                        <Input
                          type="date"
                          value={form.date}
                          max={today.toISOString().split('T')[0]}
                          onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                          className="h-9 text-sm"
                        />
                      </div>

                      {/* Lieferant */}
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs text-muted-foreground">Lieferant</Label>
                        <Select value={form.supplierName} onValueChange={v => setForm(f => ({ ...f, supplierName: v }))}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder="Lieferant wählen…" />
                          </SelectTrigger>
                          <SelectContent>
                            {activeSuppliers.map(s => (
                              <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Betrag */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Betrag (CHF)</Label>
                        <Input
                          type="number" step="0.01" min="0" placeholder="0.00"
                          value={form.amount}
                          onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                          className="h-9 text-sm"
                          onKeyDown={e => e.key === 'Enter' && handleSave()}
                        />
                      </div>

                      {/* MWST Toggle */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">MWST</Label>
                        <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs font-medium">
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, vatIncluded: true }))}
                            className={cn(
                              'flex-1 transition-colors',
                              form.vatIncluded ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >inkl.</button>
                          <button
                            type="button"
                            onClick={() => setForm(f => ({ ...f, vatIncluded: false }))}
                            className={cn(
                              'flex-1 transition-colors border-l border-border',
                              !form.vatIncluded ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
                            )}
                          >exkl.</button>
                        </div>
                      </div>

                      {/* Satz */}
                      <div className="space-y-1 col-span-1">
                        <Label className="text-xs text-muted-foreground">Satz</Label>
                        <Select value={form.vatRate} onValueChange={v => setForm(f => ({ ...f, vatRate: v }))}>
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VAT_RATES.map(r => (
                              <SelectItem key={r} value={r}>{r === '0' ? '0 % (befreit)' : `${r} %`}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Speichern */}
                      <div className="space-y-1 col-span-2">
                        <Label className="text-xs">&nbsp;</Label>
                        <Button
                          onClick={handleSave}
                          disabled={saving || !form.supplierName || !form.amount}
                          className="h-9 w-full gap-1.5 font-semibold"
                          style={{ backgroundColor: tenant.color }}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {saving ? 'Speichern…' : 'Speichern'}
                        </Button>
                      </div>
                    </div>

                    {/* Live-Berechnung */}
                    {liveAmounts && (
                      <div className="flex items-center gap-5 text-xs bg-muted/40 rounded-lg px-4 py-2 border border-border/50">
                        <span className="text-muted-foreground">Netto:</span>
                        <strong className="text-foreground tabular-nums">CHF {fmtChf(liveAmounts.amountNet)}</strong>
                        <span className="text-muted-foreground/40">|</span>
                        <span className="text-muted-foreground">Brutto:</span>
                        <strong className="text-foreground tabular-nums">CHF {fmtChf(liveAmounts.amountGross)}</strong>
                        <span className="text-muted-foreground/50 ml-auto">MWST {form.vatRate} %</span>
                      </div>
                    )}

                    {/* Optionale Felder */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Rechnungs-/Lieferscheinnummer</Label>
                        <Input
                          placeholder="z.B. LS-2025-0412"
                          value={form.reference}
                          onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Bemerkung</Label>
                        <Input
                          placeholder="z.B. Wochenlieferung"
                          value={form.note}
                          onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                </section>
                )} {/* end canCreate */}

                {/* Letzte Einträge */}
                {entries.length === 0 ? (
                  <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center">
                    <ShoppingCart className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">Noch keine Einträge für {monthLabel}</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">Erfasse oben deine erste Warenrechnung.</p>
                  </div>
                ) : (
                  <section className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                      <h2 className="text-sm font-semibold">Einträge {monthLabel}</h2>
                      <span className="text-xs text-muted-foreground">{entries.length} Einträge · CHF {fmtChf(stats.totalNet)} netto</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                            <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                            <th className="px-4 py-2.5 text-left font-medium">Lieferant</th>
                            <th className="px-4 py-2.5 text-right font-medium">Netto CHF</th>
                            <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto CHF</th>
                            <th className="px-4 py-2.5 text-center font-medium w-[70px]">MWST</th>
                            <th className="px-4 py-2.5 text-left font-medium">Referenz</th>
                            <th className="px-4 py-2.5 text-left font-medium">Bemerkung</th>
                            <th className="px-4 py-2.5 w-[88px]"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...entries].sort((a, b) => b.date.localeCompare(a.date)).map((e, i) => (
                            <tr key={e.id} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10')}>
                              <td className="px-4 py-2.5 text-sm text-muted-foreground">{formatDateLong(e.date)}</td>
                              <td className="px-4 py-2.5 font-medium">{e.supplierName}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(e.amountNet)}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(e.amountGross)}</td>
                              <td className="px-4 py-2.5 text-center text-xs text-muted-foreground">{e.vatRate} %</td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground">{e.reference ?? <span className="opacity-30">–</span>}</td>
                              <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[140px] truncate">{e.note ?? <span className="opacity-30">–</span>}</td>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-1">
                                  {canEdit && (
                                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => { setEditEntry(e); setShowEditDialog(true); }}>
                                    <Pencil className="h-3 w-3" />
                                    Edit
                                  </Button>
                                  )}
                                  {canDelete && (deleteConfirm === e.id ? (
                                    <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => handleDelete(e)}>
                                      Löschen?
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive/50 hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteConfirm(e.id)}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  ))}
                                  {!canEdit && !canDelete && (
                                    <span className="text-[10px] text-muted-foreground/40 px-1">Lesezugriff</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-border bg-muted/20 font-bold">
                            <td className="px-4 py-2.5 text-xs text-muted-foreground uppercase tracking-wide" colSpan={2}>Total</td>
                            <td className="px-4 py-2.5 text-right tabular-nums font-bold">CHF {fmtChf(stats.totalNet)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(stats.totalGross)}</td>
                            <td colSpan={4} className="px-4 py-2.5 text-right">
                              {monthPct !== null && <PctBadge pct={monthPct} />}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* ── Tab: Analyse ──────────────────────────────────────────── */}
            {tab === 'analyse' && (
              <div className="space-y-5">

                {/* ── Zeitraum-Auswahl ─────────────────────────────────────── */}
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="flex flex-wrap gap-1 p-2 border-b border-border bg-muted/20">
                    {([
                      ['week',        'Woche'],
                      ['month',       'Monat'],
                      ['multi_month', 'Mehrere Monate'],
                      ['year',        'Jahr'],
                      ['ytd',         'YTD'],
                    ] as [AnalyseMode, string][]).map(([m, label]) => (
                      <button
                        key={m}
                        onClick={() => setAnalyseMode(m)}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                          analyseMode === m
                            ? 'bg-foreground text-background shadow-sm'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground pr-1">
                      <span>Ziel</span>
                      <input
                        type="number" min={0} max={100} step={1} value={targetPct}
                        onChange={e => setTargetPct(Number(e.target.value))}
                        className="w-14 h-7 rounded-md border border-border bg-background px-2 text-center text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <span>%</span>
                    </div>
                  </div>

                  {/* Range Picker */}
                  <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                    {analyseMode === 'week' && (
                      <>
                        <button onClick={prevAWeek} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="font-semibold text-sm min-w-[140px] text-center">{analyseRangeLabel}</span>
                        <button onClick={nextAWeek} disabled={isCurrentAWeek} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                      </>
                    )}
                    {analyseMode === 'month' && (
                      <>
                        <button onClick={prevAMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                        <span className="font-semibold text-sm min-w-[140px] text-center">{analyseRangeLabel}</span>
                        <button onClick={nextAMonth} disabled={isCurrentAMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                      </>
                    )}
                    {analyseMode === 'multi_month' && (
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="text-muted-foreground text-xs">Von</span>
                        <select value={aFromMonth} onChange={e => setAFromMonth(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          {MONTHS_LONG.map((ml, i) => <option key={i+1} value={i+1}>{ml}</option>)}
                        </select>
                        <select value={aFromYear} onChange={e => setAFromYear(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm w-[80px] focus:outline-none focus:ring-1 focus:ring-ring">
                          {[today.getFullYear()-2, today.getFullYear()-1, today.getFullYear()].map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                        <span className="text-muted-foreground text-xs">Bis</span>
                        <select value={aToMonth} onChange={e => setAToMonth(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                          {MONTHS_LONG.map((ml, i) => <option key={i+1} value={i+1}>{ml}</option>)}
                        </select>
                        <select value={aToYear} onChange={e => setAToYear(Number(e.target.value))} className="h-8 rounded-md border border-border bg-background px-2 text-sm w-[80px] focus:outline-none focus:ring-1 focus:ring-ring">
                          {[today.getFullYear()-2, today.getFullYear()-1, today.getFullYear()].map(y => <option key={y} value={y}>{y}</option>)}
                        </select>
                      </div>
                    )}
                    {(analyseMode === 'year' || analyseMode === 'ytd') && (
                      <>
                        {analyseMode === 'year' && (
                          <>
                            <button onClick={() => setARangeYear(y => y - 1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                            <span className="font-semibold text-sm min-w-[80px] text-center">{aRangeYear}</span>
                            <button onClick={() => setARangeYear(y => y + 1)} disabled={aRangeYear >= today.getFullYear()} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                          </>
                        )}
                        {analyseMode === 'ytd' && (
                          <>
                            <button onClick={() => setARangeYear(y => y - 1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="h-4 w-4" /></button>
                            <span className="font-semibold text-sm min-w-[80px] text-center">{analyseRangeLabel}</span>
                            <button onClick={() => setARangeYear(y => y + 1)} disabled={aRangeYear >= today.getFullYear()} className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* ── KPI-Karten ──────────────────────────────────────────── */}
                {!rangeLoading && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    <KpiBox
                      label="Umsatz (Zeitraum)" Icon={TrendingUp}
                      value={analyseKPIs.totalRev > 0 ? `CHF ${fmtChf(analyseKPIs.totalRev)}` : '–'}
                      variant="default"
                    />
                    <KpiBox
                      label="Warenkosten netto" Icon={ShoppingCart}
                      value={analyseKPIs.totalCost > 0 ? `CHF ${fmtChf(analyseKPIs.totalCost)}` : '–'}
                      variant="default"
                    />
                    <KpiBox
                      label="Warenkosten %" Icon={BarChart3}
                      value={analyseKPIs.pct !== null ? fmtPct(analyseKPIs.pct) : '–'}
                      variant={analyseKPIs.pct === null ? 'muted' : analyseKPIs.pct > targetPct + 2 ? 'alert' : analyseKPIs.pct > targetPct ? 'warn' : 'ok'}
                      sub={analyseKPIs.pct !== null ? `Ziel: ${targetPct} %` : 'Kein Umsatz'}
                    />
                    <KpiBox
                      label="Lieferanten aktiv" Icon={Package}
                      value={String(analyseSuppliers.length)}
                      sub={analyseSuppliers.length > 0 ? analyseSuppliers[0].name : '–'}
                      variant="default"
                    />
                  </div>
                )}

                {rangeLoading ? (
                  <div className="flex items-center justify-center h-40 gap-3 text-muted-foreground">
                    <div className="h-5 w-5 rounded-full border-2 border-foreground/20 border-t-foreground/60 animate-spin" />
                    <span className="text-sm">Lade Daten…</span>
                  </div>
                ) : (
                  <>
                {/* ── Verlaufsgrafik ──────────────────────────────────────── */}
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">Verlauf Warenkosten · {analyseRangeLabel}</h2>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="text-foreground/50">Ziel {targetPct} %</span>
                    </div>
                  </div>

                  {/* ── Woche / Monat: zu wenig Daten ──────────────────── */}
                  {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).length < 2 && (
                    <div className="flex flex-col items-center justify-center h-52 gap-2 text-muted-foreground">
                      <BarChart3 className="h-8 w-8 opacity-20" />
                      <p className="text-sm">Noch zu wenig Daten für {analyseRangeLabel}</p>
                      <p className="text-xs opacity-60">Mindestens 2 Tage mit Umsatzdaten erforderlich.</p>
                    </div>
                  )}

                  {/* ── Woche / Monat: Tages-Chart ──────────────────────── */}
                  {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).length >= 2 && (
                    <div className="px-2 pt-4 pb-3">
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={analyseChartPoints} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                            tickLine={false}
                            axisLine={{ stroke: 'hsl(var(--border))' }}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tickFormatter={v => `${v}%`}
                            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                            tickLine={false}
                            axisLine={false}
                            width={42}
                            domain={[0, (max: number) => Math.max(Math.ceil(max / 5) * 5 + 5, targetPct + 5)]}
                          />
                          <Tooltip
                            content={({ active, payload, label }) => {
                              if (!active || !payload?.length) return null;
                              const d = payload[0]?.payload as ChartPoint;
                              return (
                                <div className="rounded-lg border border-border bg-card shadow-lg px-3.5 py-3 text-xs space-y-1.5 min-w-[180px]">
                                  <p className="font-semibold text-foreground text-sm">{label}</p>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-muted-foreground">Umsatz</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.dayRev)}</span>
                                  </div>
                                  <div className="flex justify-between gap-4">
                                    <span className="text-muted-foreground">Warenkosten</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.dayNet)}</span>
                                  </div>
                                  {d.dayPct !== null && (
                                    <div className="flex justify-between gap-4">
                                      <span className="text-muted-foreground">Tages %</span>
                                      <span className={cn('tabular-nums font-semibold', d.dayPct > 35 ? 'text-red-600' : d.dayPct > 30 ? 'text-amber-600' : 'text-emerald-600')}>
                                        {fmtPct(d.dayPct)}
                                      </span>
                                    </div>
                                  )}
                                  <div className="border-t border-border/50 pt-1.5 flex justify-between gap-4">
                                    <span className="text-muted-foreground">Kum. Waren</span>
                                    <span className="tabular-nums font-medium">CHF {fmtChf(d.cumNet)}</span>
                                  </div>
                                  {d.cumPct !== null && (
                                    <div className="flex justify-between gap-4">
                                      <span className="text-muted-foreground font-medium">Kum. %</span>
                                      <span className={cn('tabular-nums font-bold', d.cumPct > 35 ? 'text-red-600' : d.cumPct > 30 ? 'text-amber-600' : 'text-emerald-600')}>
                                        {fmtPct(d.cumPct)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            }}
                          />
                          <ReferenceLine
                            y={targetPct}
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="6 4"
                            strokeWidth={1.5}
                            strokeOpacity={0.6}
                            label={{ value: `Ziel ${targetPct}%`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          />
                          <Line
                            type="monotone"
                            dataKey="dayPct"
                            name="Tages %"
                            stroke="hsl(var(--muted-foreground))"
                            strokeWidth={1.5}
                            strokeOpacity={0.55}
                            dot={(props) => {
                              const { cx, cy, payload } = props;
                              if (!payload.hasEntry || payload.dayPct === null) return <g key={props.key} />;
                              return (
                                <Dot
                                  key={props.key}
                                  cx={cx} cy={cy} r={3}
                                  fill={payload.dayPct > 35 ? '#ef4444' : payload.dayPct > 30 ? '#f59e0b' : '#10b981'}
                                  stroke="white"
                                  strokeWidth={1}
                                />
                              );
                            }}
                            activeDot={{ r: 4, strokeWidth: 1.5, stroke: 'white' }}
                            connectNulls={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="cumPct"
                            name="Kum. %"
                            stroke="#3b82f6"
                            strokeWidth={2.5}
                            dot={false}
                            activeDot={{ r: 5, fill: '#3b82f6', stroke: 'white', strokeWidth: 2 }}
                            connectNulls
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div className="flex items-center gap-5 justify-end px-3 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-6 h-0.5 bg-muted-foreground/50" />
                          <span>Tages %</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-6 h-[3px] bg-blue-500 rounded" />
                          <span className="font-medium text-foreground/80">Kumuliert %</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block w-5 border-t border-dashed border-muted-foreground/60" style={{ borderSpacing: '4px' }} />
                          <span>Ziel {targetPct} %</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Multi / Jahr / YTD: zu wenig Daten ─────────────── */}
                  {analyseMode !== 'week' && analyseMode !== 'month' && analyseMonthPoints.length < 2 && (
                    <div className="flex flex-col items-center justify-center h-52 gap-2 text-muted-foreground">
                      <BarChart3 className="h-8 w-8 opacity-20" />
                      <p className="text-sm">Noch zu wenig Daten für {analyseRangeLabel}</p>
                      <p className="text-xs opacity-60">Mindestens 2 Monate mit Daten erforderlich.</p>
                    </div>
                  )}

                  {/* ── Multi / Jahr / YTD: Monats-Chart ───────────────── */}
                  {analyseMode !== 'week' && analyseMode !== 'month' && analyseMonthPoints.length >= 2 && (
                    <div className="px-2 pt-4 pb-3">
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={analyseMonthPoints} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
                          <YAxis yAxisId="chf" orientation="left" tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={44} />
                          <YAxis yAxisId="pct" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={38} domain={[0, (mx: number) => Math.max(Math.ceil(mx / 5) * 5 + 5, targetPct + 5)]} />
                          <Tooltip content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0]?.payload as AMonthPoint;
                            return (
                              <div className="rounded-lg border border-border bg-card shadow-lg px-3.5 py-3 text-xs space-y-1.5 min-w-[180px]">
                                <p className="font-semibold text-foreground text-sm">{label}</p>
                                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Umsatz</span><span className="tabular-nums font-medium">CHF {fmtChf(d.revenue)}</span></div>
                                <div className="flex justify-between gap-4"><span className="text-muted-foreground">Warenkosten</span><span className="tabular-nums font-medium">CHF {fmtChf(d.costNet)}</span></div>
                                {d.pct !== null && <div className="flex justify-between gap-4"><span className="text-muted-foreground">Monats %</span><span className={cn('tabular-nums font-semibold', d.pct > targetPct + 2 ? 'text-red-600' : d.pct > targetPct ? 'text-amber-600' : 'text-emerald-600')}>{fmtPct(d.pct)}</span></div>}
                                {d.cumPct !== null && <div className="border-t border-border/50 pt-1.5 flex justify-between gap-4"><span className="text-muted-foreground font-medium">Kum. %</span><span className={cn('tabular-nums font-bold', d.cumPct > targetPct + 2 ? 'text-red-600' : d.cumPct > targetPct ? 'text-amber-600' : 'text-emerald-600')}>{fmtPct(d.cumPct)}</span></div>}
                              </div>
                            );
                          }} />
                          <ReferenceLine yAxisId="pct" y={targetPct} stroke="hsl(var(--muted-foreground))" strokeDasharray="6 4" strokeWidth={1.5} strokeOpacity={0.6} label={{ value: `Ziel ${targetPct}%`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                          <Bar yAxisId="chf" dataKey="revenue" name="Umsatz" fill="hsl(var(--muted-foreground))" fillOpacity={0.15} radius={[3,3,0,0]} maxBarSize={40}>
                            {analyseMonthPoints.map((_, i) => <Cell key={i} fill="hsl(var(--muted-foreground))" fillOpacity={0.15} />)}
                          </Bar>
                          <Bar yAxisId="chf" dataKey="costNet" name="Warenkosten" fill="#3b82f6" fillOpacity={0.7} radius={[3,3,0,0]} maxBarSize={40}>
                            {analyseMonthPoints.map((p, i) => <Cell key={i} fill={p.pct !== null && p.pct > targetPct + 2 ? '#ef4444' : p.pct !== null && p.pct > targetPct ? '#f59e0b' : '#3b82f6'} fillOpacity={0.7} />)}
                          </Bar>
                          <Line yAxisId="pct" type="monotone" dataKey="pct" name="Monats %" stroke="#f97316" strokeWidth={2} dot={{ r: 4, fill: '#f97316', stroke: 'white', strokeWidth: 1.5 }} activeDot={{ r: 5 }} connectNulls />
                          <Line yAxisId="pct" type="monotone" dataKey="cumPct" name="Kum. %" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{ r: 5, fill: '#3b82f6', stroke: 'white', strokeWidth: 2 }} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div className="flex items-center gap-5 justify-end px-3 pt-2 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-sm bg-muted-foreground/20" /><span>Umsatz</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-4 h-3 rounded-sm bg-blue-500/70" /><span>Warenkosten CHF</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-6 h-[2.5px] rounded bg-orange-500" /><span>Monats %</span></div>
                        <div className="flex items-center gap-1.5"><span className="inline-block w-6 h-[3px] rounded bg-blue-500" /><span className="font-medium text-foreground/80">Kum. %</span></div>
                      </div>
                    </div>
                  )}
                </section>

                    {/* ── Wochen-Alerts (nur Monat-Modus) ─────────────────── */}
                    {analyseWeeklyData.length > 0 && (
                      <section className="bg-card border border-border rounded-xl overflow-hidden">
                        <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">Wochen-Alerts</span>
                            <span className="text-xs text-muted-foreground">Ziel {targetPct} %  ·  +2 % = Warnung  ·  &gt;+2 % = Kritisch</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            {analyseWeeklyData.some(w => w.status === 'red') && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400 px-2 py-0.5 font-medium">
                                {analyseWeeklyData.filter(w => w.status === 'red').length}× kritisch
                              </span>
                            )}
                            {analyseWeeklyData.some(w => w.status === 'yellow') && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 px-2 py-0.5 font-medium">
                                {analyseWeeklyData.filter(w => w.status === 'yellow').length}× Warnung
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
                          {analyseWeeklyData.map(w => {
                            const statusCfg: Record<WeekStatus, {
                              bg: string; border: string; dot: string; label: string; badge: string;
                            }> = {
                              green:  { bg: 'bg-emerald-50 dark:bg-emerald-950/20',  border: 'border-emerald-200 dark:border-emerald-800', dot: 'bg-emerald-500', label: 'Im Ziel', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
                              yellow: { bg: 'bg-amber-50 dark:bg-amber-950/20',     border: 'border-amber-200 dark:border-amber-800',     dot: 'bg-amber-400',   label: 'Über Ziel', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
                              red:    { bg: 'bg-red-50 dark:bg-red-950/20',         border: 'border-red-200 dark:border-red-800',         dot: 'bg-red-500',     label: 'Kritisch', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
                              nodata: { bg: 'bg-muted/30',                           border: 'border-border',                              dot: 'bg-muted-foreground/30', label: 'Kein Umsatz', badge: 'bg-muted text-muted-foreground' },
                            };
                            const cfg = statusCfg[w.status];
                            return (
                              <div
                                key={w.weekKey}
                                className={cn(
                                  'rounded-xl border p-4 space-y-2.5 relative',
                                  cfg.bg, cfg.border,
                                  w.isCurrent && 'ring-2 ring-offset-1 ring-blue-400 dark:ring-blue-600',
                                )}
                              >
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0', cfg.dot)} />
                                    <span className="font-bold text-sm tabular-nums">{w.weekLabel}</span>
                                    {w.isCurrent && (
                                      <span className="text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded px-1.5 py-0.5 font-medium">laufend</span>
                                    )}
                                    {!w.isCurrent && w.isComplete && (
                                      <span className="text-[10px] text-muted-foreground/60">abgeschlossen</span>
                                    )}
                                  </div>
                                  <span className={cn('text-xs font-semibold rounded-md px-2 py-0.5', cfg.badge)}>
                                    {cfg.label}
                                  </span>
                                </div>

                                {/* Datum-Range */}
                                <p className="text-[11px] text-muted-foreground">
                                  {formatDateShort(w.from)} – {formatDateShort(w.to)}
                                </p>

                                {/* Zahlen */}
                                <div className="space-y-1.5 pt-0.5">
                                  <div className="flex justify-between items-baseline gap-2">
                                    <span className="text-xs text-muted-foreground">Umsatz</span>
                                    <span className="text-xs tabular-nums font-medium">
                                      {w.revenue > 0 ? `CHF ${fmtChf(w.revenue)}` : <span className="opacity-40">–</span>}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-baseline gap-2">
                                    <span className="text-xs text-muted-foreground">Warenkosten</span>
                                    <span className="text-xs tabular-nums font-semibold">
                                      {w.costNet > 0 ? `CHF ${fmtChf(w.costNet)}` : <span className="opacity-40">–</span>}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-baseline gap-2 pt-0.5 border-t border-current/10">
                                    <span className="text-xs text-muted-foreground font-medium">Wochen %</span>
                                    <span className={cn(
                                      'text-sm tabular-nums font-bold',
                                      w.status === 'red' ? 'text-red-700 dark:text-red-400' :
                                      w.status === 'yellow' ? 'text-amber-700 dark:text-amber-400' :
                                      w.status === 'green' ? 'text-emerald-700 dark:text-emerald-400' :
                                      'text-muted-foreground',
                                    )}>
                                      {w.pct !== null ? fmtPct(w.pct) : '–'}
                                    </span>
                                  </div>
                                  {w.cumPct !== null && (
                                    <div className="flex justify-between items-baseline gap-2">
                                      <span className="text-[11px] text-muted-foreground/70">Kum. bis hier</span>
                                      <span className="text-[11px] tabular-nums text-muted-foreground/80 font-medium">
                                        {fmtPct(w.cumPct)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    {/* ── Lieferanten-Rangliste ────────────────────────── */}
                    {analyseSuppliers.length > 0 && (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                        <h2 className="text-sm font-semibold">Lieferanten · {analyseRangeLabel}</h2>
                        <span className="text-xs text-muted-foreground">
                          Total CHF {fmtChf(analyseKPIs.totalCost)} · {analyseSuppliers.length} Lieferanten
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium">Lieferant</th>
                              <th className="px-4 py-2.5 text-right font-medium">Total Netto</th>
                              <th className="px-4 py-2.5 text-right font-medium">Anteil</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseSuppliers.map((s, i) => {
                              const pct = analyseKPIs.totalCost > 0 ? (s.net / analyseKPIs.totalCost) * 100 : 0;
                              return (
                                <tr key={s.name} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10')}>
                                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">CHF {fmtChf(s.net)}</td>
                                  <td className="px-4 py-2.5 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                        <div className="h-full rounded-full bg-foreground/30" style={{ width: `${Math.min(pct, 100)}%` }} />
                                      </div>
                                      <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">{pct.toFixed(0)} %</span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(s.gross)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-border bg-muted/20 font-bold">
                              <td className="px-4 py-3 font-bold">Total</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(analyseKPIs.totalCost)}</td>
                              <td className="px-4 py-3 text-right"><PctBadge pct={analyseKPIs.pct} /></td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(analyseSuppliers.reduce((s, x) => s + x.gross, 0))}</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>
                    )}

                    {/* ── Tages-Detail-Tabelle (nur Woche / Monat) ─────────── */}
                    {(analyseMode === 'week' || analyseMode === 'month') && analyseChartPoints.filter(p => p.hasEntry).length > 0 && (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Tagesverlauf · {analyseRangeLabel}</h2>
                        <span className="text-xs text-muted-foreground">{analyseChartPoints.filter(p => p.hasEntry).length} Tage mit Einträgen</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                              <th className="px-4 py-2.5 text-right font-medium">Warenkosten</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">Tages %</th>
                              <th className="px-4 py-2.5 text-right font-medium border-l border-border/50"><span className="text-foreground/80">Kum. Waren</span></th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Kum. Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium"><span className="text-foreground/80">Kum. %</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseChartPoints.filter(p => p.hasEntry || p.dayRev > 0).map((p, i) => {
                              const isToday = p.date === todayStr;
                              return (
                                <tr key={p.date} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10', isToday && 'ring-1 ring-inset ring-blue-200 dark:ring-blue-800')}>
                                  <td className="px-4 py-2.5 font-medium text-sm">
                                    {formatDateLong(p.date)}
                                    {isToday && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded px-1 py-0.5">heute</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{p.dayNet > 0 ? `CHF ${fmtChf(p.dayNet)}` : <span className="text-muted-foreground/30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.dayRev > 0 ? fmtChf(p.dayRev) : <span className="opacity-30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right"><PctBadge pct={p.dayPct} /></td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-bold border-l border-border/50 text-foreground/80">CHF {fmtChf(p.cumNet)}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.cumRev > 0 ? fmtChf(p.cumRev) : <span className="opacity-30">–</span>}</td>
                                  <td className="px-4 py-2.5 text-right"><PctBadge pct={p.cumPct} /></td>
                                </tr>
                              );
                            })}
                          </tbody>
                          {(() => {
                            const last = analyseChartPoints[analyseChartPoints.length - 1];
                            if (!last) return null;
                            return (
                              <tfoot>
                                <tr className="border-t-2 border-border bg-muted/20 font-bold">
                                  <td className="px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Stand {formatDateShort(last.date)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums">CHF {fmtChf(last.cumNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(last.cumRev)}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={analyseKPIs.pct} /></td>
                                  <td className="px-4 py-3 text-right tabular-nums font-bold border-l border-border/50">CHF {fmtChf(last.cumNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{last.cumRev > 0 ? fmtChf(last.cumRev) : '–'}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={last.cumPct} /></td>
                                </tr>
                              </tfoot>
                            );
                          })()}
                        </table>
                      </div>
                    </section>
                    )}

                    {/* ── Monats-Ampel-Karten (nur Jahr / YTD) ─────────────── */}
                    {(analyseMode === 'year' || analyseMode === 'ytd') && analyseMonthPoints.length > 0 && (() => {
                      const getStatus = (pct: number | null) =>
                        pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
                      const statusCfg = {
                        green:  { bg: 'bg-green-50 dark:bg-green-950/30',  border: 'border-green-200 dark:border-green-800',  dot: 'bg-green-500',  label: 'Im Ziel',       txt: 'text-green-700 dark:text-green-400'  },
                        yellow: { bg: 'bg-amber-50 dark:bg-amber-950/30',  border: 'border-amber-200 dark:border-amber-800',  dot: 'bg-amber-400',  label: 'Leicht über',   txt: 'text-amber-700 dark:text-amber-400'  },
                        red:    { bg: 'bg-red-50 dark:bg-red-950/30',      border: 'border-red-200 dark:border-red-800',      dot: 'bg-red-500',    label: 'Über Ziel',     txt: 'text-red-700 dark:text-red-400'      },
                        nodata: { bg: 'bg-muted/20',                       border: 'border-border',                           dot: 'bg-muted-foreground/30', label: 'Keine Daten', txt: 'text-muted-foreground' },
                      };
                      return (
                      <section className="bg-card border border-border rounded-xl overflow-hidden">
                        <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                          <h2 className="text-sm font-semibold">Monatsvergleich · {analyseRangeLabel}</h2>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" />≤ {targetPct.toFixed(0)}%</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" />≤ {(targetPct + 2).toFixed(0)}%</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" />&gt; {(targetPct + 2).toFixed(0)}%</span>
                          </div>
                        </div>
                        <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                          {analyseMonthPoints.map(p => {
                            const st = getStatus(p.pct);
                            const cfg = statusCfg[st];
                            return (
                              <div key={p.monthKey} className={cn('rounded-lg border p-3 flex flex-col gap-1', cfg.bg, cfg.border)}>
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-semibold text-foreground/80">{p.label}</span>
                                  <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full', cfg.txt)}>
                                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', cfg.dot)} />
                                    {cfg.label}
                                  </span>
                                </div>
                                <div className="tabular-nums text-sm font-bold text-foreground">
                                  {p.pct !== null ? `${p.pct.toFixed(1)} %` : <span className="text-muted-foreground/40 font-normal text-xs">–</span>}
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                                  <span>{p.costNet > 0 ? `CHF ${fmtChf(p.costNet)}` : '–'}</span>
                                  <span className="opacity-70">{p.revenue > 0 ? `/ ${fmtChf(p.revenue)}` : ''}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* Jahres-Zusammenfassung */}
                        <div className="px-5 py-3 border-t border-border bg-muted/10 flex items-center gap-6 flex-wrap text-sm">
                          <span className="text-muted-foreground text-xs uppercase tracking-wide font-medium">Jahres-Total</span>
                          <span className="tabular-nums font-semibold">Umsatz <span className="text-muted-foreground font-normal">CHF {fmtChf(analyseKPIs.totalRev)}</span></span>
                          <span className="tabular-nums font-semibold">Waren <span className="text-muted-foreground font-normal">CHF {fmtChf(analyseKPIs.totalCost)}</span></span>
                          <span className="font-semibold">Quote <PctBadge pct={analyseKPIs.pct} /></span>
                          <span className="ml-auto flex gap-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'green').length}× Im Ziel</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'yellow').length}× Leicht</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" />{analyseMonthPoints.filter(p => getStatus(p.pct) === 'red').length}× Über Ziel</span>
                          </span>
                        </div>
                      </section>
                      );
                    })()}

                    {/* ── Monats-Übersicht Tabelle (nur multi_month / Jahr / YTD) ─── */}
                    {(analyseMode === 'multi_month' || analyseMode === 'year' || analyseMode === 'ytd') && analyseMonthPoints.length > 0 && (() => {
                      const getStatus = (pct: number | null) =>
                        pct === null ? 'nodata' : pct <= targetPct ? 'green' : pct <= targetPct + 2 ? 'yellow' : 'red';
                      const rowBg: Record<string, string> = {
                        green:  'border-l-2 border-l-green-400',
                        yellow: 'border-l-2 border-l-amber-400',
                        red:    'border-l-2 border-l-red-500',
                        nodata: '',
                      };
                      const dotColor: Record<string, string> = {
                        green: 'bg-green-500', yellow: 'bg-amber-400', red: 'bg-red-500', nodata: 'bg-muted-foreground/30',
                      };
                      return (
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Monatsdetail · {analyseRangeLabel}</h2>
                        <span className="text-xs text-muted-foreground">{analyseMonthPoints.length} Monate · Ziel {targetPct.toFixed(0)} %</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-6"></th>
                              <th className="px-4 py-2.5 text-left font-medium">Monat</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">Warenkosten</th>
                              <th className="px-4 py-2.5 text-right font-medium">Monats %</th>
                              <th className="px-4 py-2.5 text-right font-medium">Status</th>
                              <th className="px-4 py-2.5 text-right font-medium border-l border-border/50"><span className="text-foreground/80">Kum. %</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {analyseMonthPoints.map((p, i) => {
                              const st = getStatus(p.pct);
                              return (
                              <tr key={p.monthKey} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10', rowBg[st])}>
                                <td className="pl-3 pr-1 py-2.5 w-6">
                                  <span className={cn('inline-block w-2 h-2 rounded-full', dotColor[st])} />
                                </td>
                                <td className="px-4 py-2.5 font-medium">{p.label}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{p.revenue > 0 ? `CHF ${fmtChf(p.revenue)}` : <span className="opacity-30">–</span>}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{p.costNet > 0 ? `CHF ${fmtChf(p.costNet)}` : <span className="text-muted-foreground/30">–</span>}</td>
                                <td className="px-4 py-2.5 text-right"><PctBadge pct={p.pct} /></td>
                                <td className="px-4 py-2.5 text-right text-xs">
                                  {st === 'green'  && <span className="text-green-600 dark:text-green-400 font-medium">Im Ziel</span>}
                                  {st === 'yellow' && <span className="text-amber-600 dark:text-amber-400 font-medium">Leicht über</span>}
                                  {st === 'red'    && <span className="text-red-600 dark:text-red-400 font-semibold">Über Ziel</span>}
                                  {st === 'nodata' && <span className="text-muted-foreground/40">–</span>}
                                </td>
                                <td className="px-4 py-2.5 text-right border-l border-border/50"><PctBadge pct={p.cumPct} /></td>
                              </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t-2 border-border bg-muted/20 font-bold">
                              <td className="px-4 py-3" colSpan={2}>Total</td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">CHF {fmtChf(analyseKPIs.totalRev)}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(analyseKPIs.totalCost)}</td>
                              <td className="px-4 py-3 text-right" colSpan={3}><PctBadge pct={analyseKPIs.pct} /></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>
                      );
                    })()}

                    {/* Umsatzbasis fehlt */}
                    {analyseKPIs.totalRev === 0 && analysisEntries.length > 0 && (
                      <div className="flex items-center gap-2.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-400 rounded-lg px-4 py-3">
                        <AlertCircle className="h-4 w-4 flex-shrink-0" />
                        Kein Tagesumsatz für {analyseRangeLabel} vorhanden. %-Berechnungen nicht möglich. Bitte Umsatzdaten importieren.
                      </div>
                    )}
                    {analysisEntries.length === 0 && (
                      <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center">
                        <BarChart3 className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                        <p className="text-sm font-medium text-muted-foreground">Keine Warenrechnungen für {analyseRangeLabel}</p>
                        <p className="text-xs text-muted-foreground/50 mt-1">Wechsle zur Erfassung und trage Warenrechnungen ein.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Legende ───────────────────────────────────────────────── */}
            <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-muted-foreground border-t border-border/50 pt-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-emerald-500" />
                <span>≤ 30 % – im Ziel</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-amber-400" />
                <span>30–35 % – erhöht</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-red-500" />
                <span>&gt; 35 % – kritisch</span>
              </div>
              <span className="ml-auto">Alle Beträge exkl. MWST (Netto)</span>
            </div>
          </>
        )}
      </main>

      {/* ── Dialog: Eintrag bearbeiten ──────────────────────────────────────── */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Eintrag bearbeiten</DialogTitle>
          </DialogHeader>
          {editEntry && (
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Datum</Label>
                  <Input type="date" value={editEntry.date}
                    onChange={e => setEditEntry(v => v ? { ...v, date: e.target.value } : v)}
                    className="h-9 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Lieferant</Label>
                  <Select value={editEntry.supplierName} onValueChange={v => setEditEntry(x => x ? { ...x, supplierName: v } : x)}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {activeSuppliers.map(s => <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Netto CHF</Label>
                  <Input type="number" step="0.01" value={editEntry.amountNet.toFixed(2)}
                    onChange={e => {
                      const net = Number(e.target.value);
                      setEditEntry(x => x ? { ...x, amountNet: net, amountGross: net * (1 + x.vatRate / 100) } : x);
                    }}
                    className="h-9 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Brutto CHF</Label>
                  <Input type="number" step="0.01" value={editEntry.amountGross.toFixed(2)} readOnly className="h-9 text-sm bg-muted" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">MWST %</Label>
                  <Select value={String(editEntry.vatRate)} onValueChange={v => {
                    const rate = Number(v);
                    setEditEntry(x => x ? { ...x, vatRate: rate, amountGross: x.amountNet * (1 + rate / 100) } : x);
                  }}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VAT_RATES.map(r => <SelectItem key={r} value={r}>{r} %</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Referenz (optional)</Label>
                <Input value={editEntry.reference ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, reference: e.target.value || undefined } : x)}
                  className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bemerkung (optional)</Label>
                <Input value={editEntry.note ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, note: e.target.value || undefined } : x)}
                  className="h-8 text-sm" />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Abbrechen</Button>
            <Button onClick={handleEditSave} disabled={saving}>{saving ? 'Speichern…' : 'Speichern'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Lieferantenstamm ────────────────────────────────────────── */}
      <Dialog open={showSupplierDialog} onOpenChange={setShowSupplierDialog}>
        <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              Lieferantenstamm
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex gap-2">
              <Input
                placeholder="Neuer Lieferant…"
                value={newSupplierName}
                onChange={e => setNewSupplierName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddSupplier()}
                className="h-9 text-sm"
              />
              <Button onClick={handleAddSupplier} size="sm" className="h-9 px-3" disabled={!newSupplierName.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{suppliers.length} Lieferanten · {activeSuppliers.length} aktiv</p>
            <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
              {suppliers.map(s => (
                <div key={s.id} className={cn(
                  'flex items-center justify-between rounded-lg px-3 py-2 text-sm border transition-colors',
                  s.active ? 'bg-card border-border' : 'bg-muted/30 border-border/40',
                )}>
                  <span className={s.active ? 'font-medium' : 'text-muted-foreground/50 line-through text-xs'}>{s.name}</span>
                  <button
                    className={cn(
                      'text-xs px-2.5 py-1 rounded-md border transition-colors',
                      s.active ? 'text-muted-foreground border-border hover:bg-muted' : 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100',
                    )}
                    onClick={() => handleToggleSupplier(s)}
                  >
                    {s.active ? 'Deaktivieren' : 'Aktivieren'}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSupplierDialog(false)}>Schliessen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
