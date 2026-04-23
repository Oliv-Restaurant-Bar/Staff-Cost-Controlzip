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
import {
  loadSuppliers,
  saveSuppliers,
  loadMonthInvoices,
  saveInvoiceEntry,
  deleteInvoiceEntry,
  loadDailyRevenueFromLocalStorage,
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
  TrendingUp, AlertCircle, CheckCircle2, Package, BarChart3, ClipboardList,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Dot,
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

type Tab = 'erfassung' | 'analyse';

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

  async function handleSave() {
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

          {/* Lieferanten */}
          <Button variant="outline" size="sm" onClick={() => setShowSupplierDialog(true)} className="h-8 gap-1.5 text-xs">
            <Settings2 className="h-3.5 w-3.5" />
            Lieferanten
          </Button>
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

                {/* Schnellerfassung */}
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
                                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={() => { setEditEntry(e); setShowEditDialog(true); }}>
                                    <Pencil className="h-3 w-3" />
                                    Edit
                                  </Button>
                                  {deleteConfirm === e.id ? (
                                    <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => handleDelete(e)}>
                                      Löschen?
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive/50 hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteConfirm(e.id)}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
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

                {/* ── Verlaufsgrafik ──────────────────────────────────────── */}
                <section className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">Verlauf Warenkosten {monthLabel}</h2>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Ziel</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={targetPct}
                        onChange={e => setTargetPct(Number(e.target.value))}
                        className="w-14 h-7 rounded-md border border-border bg-background px-2 text-center text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <span>%</span>
                    </div>
                  </div>

                  {chartData.filter(p => p.hasEntry || p.dayRev > 0).length < 2 ? (
                    <div className="flex flex-col items-center justify-center h-52 gap-2 text-muted-foreground">
                      <BarChart3 className="h-8 w-8 opacity-20" />
                      <p className="text-sm">Noch zu wenig Daten für {monthLabel}</p>
                      <p className="text-xs opacity-60">Mindestens 2 Tage mit Umsatzdaten erforderlich.</p>
                    </div>
                  ) : (
                    <div className="px-2 pt-4 pb-3">
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 4 }}>
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

                          {/* Zielwert-Linie */}
                          <ReferenceLine
                            y={targetPct}
                            stroke="hsl(var(--muted-foreground))"
                            strokeDasharray="6 4"
                            strokeWidth={1.5}
                            strokeOpacity={0.6}
                            label={{ value: `Ziel ${targetPct}%`, position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          />

                          {/* Tageswert — dünne Linie, Punkte nur bei Einträgen */}
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

                          {/* Kumuliert — dicke Hauptlinie */}
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

                      {/* Legende */}
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
                </section>

                {entries.length === 0 ? (
                  <div className="bg-card border border-dashed border-border rounded-xl p-10 text-center">
                    <BarChart3 className="h-10 w-10 text-muted-foreground/20 mx-auto mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">Keine Daten für {monthLabel}</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">Wechsle zur Erfassung und trage Warenrechnungen ein.</p>
                  </div>
                ) : (
                  <>
                    {/* Lieferanten-Rangliste */}
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between flex-wrap gap-2">
                        <h2 className="text-sm font-semibold">Lieferanten · {monthLabel}</h2>
                        <span className="text-xs text-muted-foreground">
                          Total CHF {fmtChf(stats.totalNet)} · {suppliersWithEntries} Lieferanten
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-[200px]">Lieferant</th>
                              <th className="px-4 py-2.5 text-right font-medium">Total Netto</th>
                              <th className="px-4 py-2.5 text-right font-medium">Anteil</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Brutto</th>
                              {tableDates.map(d => (
                                <th key={d} className="px-3 py-2.5 text-right font-medium min-w-[72px]">{formatDateShort(d)}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[...stats.supplierTotals]
                              .sort((a, b) => b.totalNet - a.totalNet)
                              .map((st, i) => {
                                const pct = stats.totalNet > 0 ? (st.totalNet / stats.totalNet) * 100 : 0;
                                return (
                                  <tr key={st.supplierName} className={cn('border-b border-border/40 hover:bg-muted/20 transition-colors', i % 2 === 1 && 'bg-muted/10')}>
                                    <td className="px-4 py-2.5 font-medium">{st.supplierName}</td>
                                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">CHF {fmtChf(st.totalNet)}</td>
                                    <td className="px-4 py-2.5 text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                          <div className="h-full rounded-full bg-foreground/30" style={{ width: `${Math.min(pct, 100)}%` }} />
                                        </div>
                                        <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">{pct.toFixed(0)} %</span>
                                      </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(st.totalGross)}</td>
                                    {tableDates.map(d => {
                                      const val = st.byDate[d];
                                      return (
                                        <td key={d} className="px-3 py-2.5 text-right tabular-nums text-xs">
                                          {val ? <span className="font-medium">{fmtChf(val)}</span> : <span className="text-muted-foreground/20">–</span>}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-border/50 bg-muted/10 text-xs text-muted-foreground">
                              <td className="px-4 py-2 font-medium text-muted-foreground/70">Umsatz (Basis)</td>
                              <td className="px-4 py-2 text-right tabular-nums" colSpan={3}>CHF {fmtChf(totalRevenue)}</td>
                              {tableDates.map(d => {
                                const rev = revenueByDate[d];
                                return (
                                  <td key={d} className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground/70">
                                    {rev ? fmtChf(rev) : <span className="opacity-30">–</span>}
                                  </td>
                                );
                              })}
                            </tr>
                            <tr className="border-t-2 border-border bg-muted/20 font-bold">
                              <td className="px-4 py-3 font-bold">Total Warenkosten</td>
                              <td className="px-4 py-3 text-right tabular-nums font-bold">CHF {fmtChf(stats.totalNet)}</td>
                              <td className="px-4 py-3 text-right">
                                <PctBadge pct={monthPct} />
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(stats.totalGross)}</td>
                              {tableDates.map(d => {
                                const dayNet = entries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
                                const dayRev = revenueByDate[d] ?? 0;
                                const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
                                return (
                                  <td key={d} className="px-3 py-3 text-right tabular-nums text-xs">
                                    {dayNet > 0 ? (
                                      <div className="space-y-0.5">
                                        <div className="font-semibold">{fmtChf(dayNet)}</div>
                                        {dayPct !== null && <div className={cn('text-[10px]', dayPct > 35 ? 'text-red-600' : dayPct > 30 ? 'text-amber-600' : 'text-emerald-600')}>{fmtPct(dayPct)}</div>}
                                      </div>
                                    ) : <span className="text-muted-foreground/20">–</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </section>

                    {/* Kumulierter Verlauf */}
                    <section className="bg-card border border-border rounded-xl overflow-hidden">
                      <div className="px-5 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Kumulierter Verlauf</h2>
                        <span className="text-xs text-muted-foreground">{datesWithEntries.length} Tage mit Einträgen</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border bg-muted/10 text-xs text-muted-foreground">
                              <th className="px-4 py-2.5 text-left font-medium w-[110px]">Datum</th>
                              <th className="px-4 py-2.5 text-right font-medium">Tageswaren</th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Tagesumsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">Tages %</th>
                              <th className="px-4 py-2.5 text-right font-medium border-l border-border/50">
                                <span className="text-foreground/80">Kum. Waren</span>
                              </th>
                              <th className="px-4 py-2.5 text-right font-medium text-muted-foreground/70">Kum. Umsatz</th>
                              <th className="px-4 py-2.5 text-right font-medium">
                                <span className="text-foreground/80">Kum. %</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {datesWithEntries.map((d, i) => {
                              const dayNet = entries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
                              const dayRev = revenueByDate[d] ?? 0;
                              const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
                              const { cumNet, cumRev, pct: cumPct } = getCumulative(d);
                              const isToday = d === todayStr;
                              return (
                                <tr key={d} className={cn(
                                  'border-b border-border/40 hover:bg-muted/20 transition-colors',
                                  i % 2 === 1 && 'bg-muted/10',
                                  isToday && 'ring-1 ring-inset ring-blue-200 dark:ring-blue-800',
                                )}>
                                  <td className="px-4 py-2.5 font-medium text-sm">
                                    {formatDateLong(d)}
                                    {isToday && <span className="ml-1.5 text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded px-1 py-0.5">heute</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">CHF {fmtChf(dayNet)}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                                    {dayRev > 0 ? fmtChf(dayRev) : <span className="opacity-30">–</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right"><PctBadge pct={dayPct} /></td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-bold border-l border-border/50 text-foreground/80">
                                    CHF {fmtChf(cumNet)}
                                  </td>
                                  <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                                    {cumRev > 0 ? fmtChf(cumRev) : <span className="opacity-30">–</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-right">
                                    <PctBadge pct={cumPct} />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          {datesWithEntries.length > 0 && (() => {
                            const last = datesWithEntries[datesWithEntries.length - 1];
                            const { cumNet, cumRev, pct: cumPct } = getCumulative(last);
                            return (
                              <tfoot>
                                <tr className="border-t-2 border-border bg-muted/20 font-bold">
                                  <td className="px-4 py-3 text-xs text-muted-foreground uppercase tracking-wide">Stand {formatDateShort(last)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums">CHF {fmtChf(stats.totalNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{fmtChf(totalRevenue)}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={monthPct} /></td>
                                  <td className="px-4 py-3 text-right tabular-nums font-bold border-l border-border/50">CHF {fmtChf(cumNet)}</td>
                                  <td className="px-4 py-3 text-right tabular-nums text-xs text-muted-foreground">{cumRev > 0 ? fmtChf(cumRev) : '–'}</td>
                                  <td className="px-4 py-3 text-right"><PctBadge pct={cumPct} /></td>
                                </tr>
                              </tfoot>
                            );
                          })()}
                        </table>
                      </div>
                    </section>

                    {/* Fehlende Umsatzbasis */}
                    {totalRevenue === 0 && (
                      <div className="flex items-center gap-2.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 dark:bg-amber-950/20 dark:border-amber-800 dark:text-amber-400 rounded-lg px-4 py-3">
                        <AlertCircle className="h-4 w-4 flex-shrink-0" />
                        Kein Tagesumsatz für {monthLabel} vorhanden. %-Berechnungen sind nicht möglich. Bitte Umsatzdaten importieren.
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
