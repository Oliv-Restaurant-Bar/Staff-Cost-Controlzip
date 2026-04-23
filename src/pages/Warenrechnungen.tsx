/**
 * Warenrechnungen – Modul zur Erfassung und Kontrolle von Lieferantenrechnungen
 * ==============================================================================
 * Erfassung per Tag und Lieferant mit MWST-Logik.
 * Vergleich Warenkosten vs. Tagesumsatz (% und CHF).
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  ShoppingCart, Plus, Pencil, Trash2, Settings2, ChevronLeft, ChevronRight,
  TrendingUp, AlertCircle, CheckCircle2, Package,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmtChf(val: number): string {
  return val.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(val: number): string {
  return val.toFixed(1) + '%';
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

// ─── KPI-Box ──────────────────────────────────────────────────────────────────

const KpiBox = ({
  label, value, sub, icon: Icon, variant = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.FC<{ className?: string }>;
  variant?: 'default' | 'warn' | 'ok' | 'muted';
}) => {
  const colors = {
    default: 'bg-card border-border',
    warn:    'bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800',
    ok:      'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800',
    muted:   'bg-muted/40 border-border',
  };
  const valColors = {
    default: 'text-foreground',
    warn:    'text-orange-700 dark:text-orange-400',
    ok:      'text-emerald-700 dark:text-emerald-400',
    muted:   'text-muted-foreground',
  };
  return (
    <div className={cn('rounded-xl border p-4 space-y-1', colors[variant])}>
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
      </div>
      <p className={cn('text-2xl font-bold tabular-nums', valColors[variant])}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
};

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function WarenrechnungenPage() {
  const { tenantId, tenant } = useTenant();

  // Monat
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  // Daten
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [entries, setEntries] = useState<InvoiceEntry[]>([]);
  const [revenueByDate, setRevenueByDate] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  // UI-State
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editEntry, setEditEntry] = useState<InvoiceEntry | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showSupplierDialog, setShowSupplierDialog] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Daten laden
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

  // Monat wechseln
  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

  // Statistik
  const stats = useMemo(
    () => computeMonthStats(entries, revenueByDate),
    [entries, revenueByDate],
  );

  const totalRevenue = useMemo(
    () => Object.values(revenueByDate).reduce((s, v) => s + v, 0),
    [revenueByDate],
  );

  const monthPct = totalRevenue > 0 ? (stats.totalNet / totalRevenue) * 100 : null;

  // Heute-Werte
  const todayStr = today.toISOString().split('T')[0];
  const todayNet = useMemo(
    () => entries.filter(e => e.date === todayStr).reduce((s, e) => s + e.amountNet, 0),
    [entries, todayStr],
  );
  const todayRevenue = revenueByDate[todayStr] ?? 0;
  const todayPct = todayRevenue > 0 ? (todayNet / todayRevenue) * 100 : null;

  // Tage im Monat mit Einträgen
  const datesWithEntries = useMemo(() => {
    const ds = new Set(entries.map(e => e.date));
    return Array.from(ds).sort();
  }, [entries]);

  // Tage mit Einträgen oder Umsatz für Tabelle (max. 15 letzte Tage)
  const tableDates = useMemo(() => {
    const all = getDaysInMonth(year, month);
    const today2 = new Date().toISOString().split('T')[0];
    const past = all.filter(d => d <= today2);
    return past.slice(-15); // max. 15 Tage
  }, [year, month]);

  // Betrag live berechnen
  const liveAmounts = useMemo(() => {
    if (!form.amount || isNaN(Number(form.amount))) return null;
    return calcAmounts(Number(form.amount), form.vatIncluded, Number(form.vatRate));
  }, [form.amount, form.vatIncluded, form.vatRate]);

  // ─── Eintrag speichern ──────────────────────────────────────────────────

  async function handleSave() {
    if (!form.supplierName) { toast.error('Bitte Lieferant wählen.'); return; }
    if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) {
      toast.error('Bitte gültigen Betrag eingeben.'); return;
    }
    const amounts = calcAmounts(Number(form.amount), form.vatIncluded, Number(form.vatRate));
    setSaving(true);
    const entry: InvoiceEntry = {
      id: generateId(),
      date: form.date,
      supplierName: form.supplierName,
      amountGross: amounts.amountGross,
      amountNet: amounts.amountNet,
      vatIncluded: form.vatIncluded,
      vatRate: Number(form.vatRate),
      reference: form.reference || undefined,
      note: form.note || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveInvoiceEntry(tenantId, entry);
    await loadData();
    setForm(f => ({ ...EMPTY_FORM, date: f.date, supplierName: f.supplierName, vatRate: f.vatRate, vatIncluded: f.vatIncluded }));
    toast.success(`Eintrag gespeichert: ${form.supplierName} · CHF ${fmtChf(amounts.amountNet)} netto`);
    setSaving(false);
  }

  // ─── Eintrag bearbeiten ─────────────────────────────────────────────────

  function openEdit(entry: InvoiceEntry) {
    setEditEntry(entry);
    setShowEditDialog(true);
  }

  async function handleEditSave() {
    if (!editEntry) return;
    setSaving(true);
    await saveInvoiceEntry(tenantId, { ...editEntry, updatedAt: new Date().toISOString() });
    await loadData();
    setShowEditDialog(false);
    setEditEntry(null);
    toast.success('Eintrag aktualisiert.');
    setSaving(false);
  }

  // ─── Eintrag löschen ────────────────────────────────────────────────────

  async function handleDelete(entry: InvoiceEntry) {
    await deleteInvoiceEntry(tenantId, entry.id, entry.date);
    await loadData();
    setDeleteConfirm(null);
    toast.success('Eintrag gelöscht.');
  }

  // ─── Lieferant hinzufügen ───────────────────────────────────────────────

  async function handleAddSupplier() {
    const name = newSupplierName.trim();
    if (!name) return;
    if (suppliers.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      toast.error('Lieferant existiert bereits.'); return;
    }
    const updated: Supplier[] = [
      ...suppliers,
      { id: `sup-${Date.now()}`, name, active: true, createdAt: new Date().toISOString() },
    ];
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
    setNewSupplierName('');
    toast.success(`Lieferant "${name}" hinzugefügt.`);
  }

  async function handleToggleSupplier(sup: Supplier) {
    const updated = suppliers.map(s =>
      s.id === sup.id ? { ...s, active: !s.active } : s,
    );
    await saveSuppliers(tenantId, updated);
    setSuppliers(updated);
  }

  const activeSuppliers = suppliers.filter(s => s.active);
  const suppliersWithEntries = stats.supplierTotals.length;

  // ─── Kumulierungslogik ──────────────────────────────────────────────────

  function getCumulative(upToDate: string) {
    const relevant = entries.filter(e => e.date <= upToDate);
    const cumNet = relevant.reduce((s, e) => s + e.amountNet, 0);
    const cumRev = Object.entries(revenueByDate)
      .filter(([d]) => d <= upToDate)
      .reduce((s, [, v]) => s + v, 0);
    const pct = cumRev > 0 ? (cumNet / cumRev) * 100 : null;
    return { cumNet, cumRev, pct };
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-full">

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg" style={{ backgroundColor: tenant.color + '18' }}>
            <ShoppingCart className="h-5 w-5" style={{ color: tenant.color }} />
          </div>
          <div>
            <h1 className="text-xl font-bold">Warenrechnungen</h1>
            <p className="text-xs text-muted-foreground">{tenant.name}</p>
          </div>
        </div>

        {/* Monatswechsel */}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold min-w-[140px] text-center">{monthLabel}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={nextMonth} disabled={isCurrentMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowSupplierDialog(true)} className="h-8 gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            Lieferanten
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          Wird geladen…
        </div>
      ) : (
        <>
          {/* ── KPI-Boxen ───────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiBox
              label="Warenkosten heute"
              value={`CHF ${fmtChf(todayNet)}`}
              sub={isCurrentMonth && todayRevenue === 0 ? 'Kein Umsatz' : undefined}
              icon={ShoppingCart}
              variant={todayPct !== null && todayPct > 35 ? 'warn' : todayNet > 0 ? 'ok' : 'muted'}
            />
            <KpiBox
              label="Warenkosten heute %"
              value={todayPct !== null ? fmtPct(todayPct) : '–'}
              sub={todayRevenue > 0 ? `Umsatz CHF ${fmtChf(todayRevenue)}` : 'Kein Umsatz'}
              icon={TrendingUp}
              variant={todayPct !== null ? (todayPct > 35 ? 'warn' : 'ok') : 'muted'}
            />
            <KpiBox
              label="Warenkosten Monat"
              value={`CHF ${fmtChf(stats.totalNet)}`}
              sub={`${stats.entryCount} Einträge · exkl. MWST`}
              icon={Package}
              variant={stats.totalNet > 0 ? 'default' : 'muted'}
            />
            <KpiBox
              label="Warenkosten Monat %"
              value={monthPct !== null ? fmtPct(monthPct) : '–'}
              sub={monthPct !== null ? `Ziel ≤ 30%` : 'Kein Umsatz'}
              icon={TrendingUp}
              variant={monthPct !== null ? (monthPct > 35 ? 'warn' : monthPct > 30 ? 'default' : 'ok') : 'muted'}
            />
            <KpiBox
              label="Kum. Umsatz Monat"
              value={totalRevenue > 0 ? `CHF ${fmtChf(totalRevenue)}` : '–'}
              sub={totalRevenue === 0 ? 'Keine Umsatzdaten' : undefined}
              icon={TrendingUp}
              variant={totalRevenue > 0 ? 'default' : 'muted'}
            />
            <KpiBox
              label="Lieferanten aktiv"
              value={String(suppliersWithEntries)}
              sub={`von ${activeSuppliers.length} verfügbar`}
              icon={CheckCircle2}
              variant={suppliersWithEntries > 0 ? 'default' : 'muted'}
            />
          </div>

          {/* ── Schnellerfassung ─────────────────────────────────────────── */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4" style={{ color: tenant.color }} />
              Neue Rechnung erfassen
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 items-end">

              {/* Datum */}
              <div className="space-y-1">
                <Label className="text-xs">Datum</Label>
                <Input
                  type="date"
                  value={form.date}
                  max={today.toISOString().split('T')[0]}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>

              {/* Lieferant */}
              <div className="space-y-1 md:col-span-1 lg:col-span-2">
                <Label className="text-xs">Lieferant</Label>
                <Select
                  value={form.supplierName}
                  onValueChange={v => setForm(f => ({ ...f, supplierName: v }))}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Lieferant wählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeSuppliers.map(s => (
                      <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Betrag */}
              <div className="space-y-1">
                <Label className="text-xs">Betrag (CHF)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>

              {/* MWST Toggle */}
              <div className="space-y-1">
                <Label className="text-xs">MWST</Label>
                <div className="flex rounded-md overflow-hidden border border-border h-9 text-xs">
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, vatIncluded: true }))}
                    className={cn(
                      'flex-1 px-2 font-medium transition-colors',
                      form.vatIncluded ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    inkl.
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, vatIncluded: false }))}
                    className={cn(
                      'flex-1 px-2 font-medium transition-colors',
                      !form.vatIncluded ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    exkl.
                  </button>
                </div>
              </div>

              {/* MwSt-Satz */}
              <div className="space-y-1">
                <Label className="text-xs">Satz</Label>
                <Select
                  value={form.vatRate}
                  onValueChange={v => setForm(f => ({ ...f, vatRate: v }))}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAT_RATES.map(r => (
                      <SelectItem key={r} value={r}>{r === '0' ? '0% (befreit)' : `${r}%`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Speichern */}
              <div className="space-y-1">
                <Label className="text-xs">&nbsp;</Label>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-9 w-full gap-1.5"
                  style={{ backgroundColor: tenant.color }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Speichern
                </Button>
              </div>
            </div>

            {/* Live-Berechnung */}
            {liveAmounts && (
              <div className="mt-2.5 flex gap-4 text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-1.5">
                <span>Netto: <strong className="text-foreground">CHF {fmtChf(liveAmounts.amountNet)}</strong></span>
                <span>Brutto: <strong className="text-foreground">CHF {fmtChf(liveAmounts.amountGross)}</strong></span>
                <span className="text-muted-foreground/60">MWST {form.vatRate}%</span>
              </div>
            )}

            {/* Optionale Felder */}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Rechnungs-/Lieferscheinnummer (optional)</Label>
                <Input
                  placeholder="z.B. LS-2025-0412"
                  value={form.reference}
                  onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Bemerkung (optional)</Label>
                <Input
                  placeholder="z.B. Wochenlieferung"
                  value={form.note}
                  onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          {/* ── Übersichtstabelle ─────────────────────────────────────────── */}
          {entries.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center">
              <ShoppingCart className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">Noch keine Einträge für {monthLabel}</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Erfasse oben deine erste Warenrechnung.</p>
            </div>
          ) : (
            <div className="space-y-4">

              {/* Lieferanten-Übersicht */}
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <h2 className="text-sm font-semibold">Monatstotale nach Lieferant</h2>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[180px]">Lieferant</TableHead>
                        <TableHead className="text-right">Total Netto</TableHead>
                        <TableHead className="text-right">Total Brutto</TableHead>
                        <TableHead className="text-right">Anteil %</TableHead>
                        {tableDates.map(d => (
                          <TableHead key={d} className="text-right text-[11px] min-w-[64px]">
                            {formatDateShort(d)}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {stats.supplierTotals.map(st => {
                        const pct = stats.totalNet > 0 ? (st.totalNet / stats.totalNet) * 100 : 0;
                        return (
                          <TableRow key={st.supplierName}>
                            <TableCell className="font-medium text-sm">{st.supplierName}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm font-semibold">
                              CHF {fmtChf(st.totalNet)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                              {fmtChf(st.totalGross)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Badge variant="secondary" className="text-xs font-mono">{fmtPct(pct)}</Badge>
                            </TableCell>
                            {tableDates.map(d => {
                              const val = st.byDate[d];
                              return (
                                <TableCell key={d} className="text-right tabular-nums text-xs">
                                  {val ? (
                                    <span className="font-medium">{fmtChf(val)}</span>
                                  ) : (
                                    <span className="text-muted-foreground/30">–</span>
                                  )}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        );
                      })}

                      {/* Umsatz-Zeile */}
                      <TableRow className="bg-muted/20 border-t-2">
                        <TableCell className="font-semibold text-xs text-muted-foreground uppercase tracking-wide">
                          Umsatz (Basis)
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground" colSpan={3}>
                          CHF {fmtChf(totalRevenue)}
                        </TableCell>
                        {tableDates.map(d => {
                          const rev = revenueByDate[d];
                          return (
                            <TableCell key={d} className="text-right tabular-nums text-xs text-muted-foreground">
                              {rev ? fmtChf(rev) : <span className="opacity-30">–</span>}
                            </TableCell>
                          );
                        })}
                      </TableRow>

                      {/* Total-Zeile */}
                      <TableRow className="bg-muted/30 font-bold">
                        <TableCell className="font-bold text-sm">Total Warenkosten</TableCell>
                        <TableCell className="text-right tabular-nums text-sm font-bold">
                          CHF {fmtChf(stats.totalNet)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                          {fmtChf(stats.totalGross)}
                        </TableCell>
                        <TableCell className="text-right">
                          {monthPct !== null ? (
                            <Badge
                              variant="secondary"
                              className={cn(
                                'text-xs font-mono font-bold',
                                monthPct > 35 ? 'bg-orange-100 text-orange-700' : monthPct > 30 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700',
                              )}
                            >
                              {fmtPct(monthPct)}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">–</span>
                          )}
                        </TableCell>
                        {tableDates.map(d => {
                          const dayEntries = entries.filter(e => e.date === d);
                          const dayNet = dayEntries.reduce((s, e) => s + e.amountNet, 0);
                          const dayRev = revenueByDate[d] ?? 0;
                          const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
                          return (
                            <TableCell key={d} className="text-right tabular-nums text-xs">
                              {dayNet > 0 ? (
                                <div>
                                  <div className="font-semibold">{fmtChf(dayNet)}</div>
                                  {dayPct !== null && (
                                    <div className={cn(
                                      'text-[10px]',
                                      dayPct > 35 ? 'text-orange-600' : 'text-muted-foreground',
                                    )}>
                                      {fmtPct(dayPct)}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground/30">–</span>
                              )}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Kumulierungsansicht */}
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <h2 className="text-sm font-semibold">Kumulierter Verlauf</h2>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[100px]">Datum</TableHead>
                        <TableHead className="text-right">Tageswaren</TableHead>
                        <TableHead className="text-right">Tagesumsatz</TableHead>
                        <TableHead className="text-right">Tages %</TableHead>
                        <TableHead className="text-right">Kum. Waren</TableHead>
                        <TableHead className="text-right">Kum. Umsatz</TableHead>
                        <TableHead className="text-right">Kum. %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datesWithEntries.map(d => {
                        const dayNet = entries.filter(e => e.date === d).reduce((s, e) => s + e.amountNet, 0);
                        const dayRev = revenueByDate[d] ?? 0;
                        const dayPct = dayRev > 0 ? (dayNet / dayRev) * 100 : null;
                        const { cumNet, cumRev, pct: cumPct } = getCumulative(d);
                        return (
                          <TableRow key={d}>
                            <TableCell className="text-sm font-medium">{formatDateShort(d)}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">CHF {fmtChf(dayNet)}</TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                              {dayRev > 0 ? fmtChf(dayRev) : <span className="opacity-40">–</span>}
                            </TableCell>
                            <TableCell className="text-right">
                              {dayPct !== null ? (
                                <Badge variant="secondary" className={cn(
                                  'text-xs',
                                  dayPct > 35 ? 'bg-orange-100 text-orange-700' : 'bg-muted',
                                )}>
                                  {fmtPct(dayPct)}
                                </Badge>
                              ) : <span className="text-xs text-muted-foreground/40">–</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-sm font-semibold">
                              CHF {fmtChf(cumNet)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                              {cumRev > 0 ? fmtChf(cumRev) : <span className="opacity-40">–</span>}
                            </TableCell>
                            <TableCell className="text-right">
                              {cumPct !== null ? (
                                <Badge variant="secondary" className={cn(
                                  'text-xs font-mono',
                                  cumPct > 35 ? 'bg-orange-100 text-orange-700' : cumPct > 30 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700',
                                )}>
                                  {fmtPct(cumPct)}
                                </Badge>
                              ) : <span className="text-xs text-muted-foreground/40">–</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Einzeleinträge */}
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <h2 className="text-sm font-semibold">Alle Einträge ({entries.length})</h2>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Datum</TableHead>
                        <TableHead>Lieferant</TableHead>
                        <TableHead className="text-right">Netto CHF</TableHead>
                        <TableHead className="text-right">Brutto CHF</TableHead>
                        <TableHead>MWST</TableHead>
                        <TableHead>Referenz</TableHead>
                        <TableHead>Bemerkung</TableHead>
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...entries].sort((a, b) => b.date.localeCompare(a.date)).map(e => (
                        <TableRow key={e.id}>
                          <TableCell className="text-sm">{formatDateShort(e.date)}</TableCell>
                          <TableCell className="text-sm font-medium">{e.supplierName}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm font-semibold">
                            {fmtChf(e.amountNet)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                            {fmtChf(e.amountGross)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {e.vatRate}%
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {e.reference ?? '–'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
                            {e.note ?? '–'}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => openEdit(e)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              {deleteConfirm === e.id ? (
                                <Button
                                  variant="destructive"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => handleDelete(e)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive/60 hover:text-destructive"
                                  onClick={() => setDeleteConfirm(e.id)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Hinweis wenn kein Umsatz */}
              {totalRevenue === 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                  Kein Tagesumsatz für {monthLabel} vorhanden. %-Berechnungen sind nicht möglich. Bitte Umsatzdaten importieren.
                </div>
              )}
            </div>
          )}
        </>
      )}

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
                  <Input
                    type="date"
                    value={editEntry.date}
                    onChange={e => setEditEntry(v => v ? { ...v, date: e.target.value } : v)}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Lieferant</Label>
                  <Select
                    value={editEntry.supplierName}
                    onValueChange={v => setEditEntry(x => x ? { ...x, supplierName: v } : x)}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {activeSuppliers.map(s => (
                        <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1 col-span-1">
                  <Label className="text-xs">Netto CHF</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={editEntry.amountNet.toFixed(2)}
                    onChange={e => {
                      const net = Number(e.target.value);
                      const gross = net * (1 + editEntry.vatRate / 100);
                      setEditEntry(x => x ? { ...x, amountNet: net, amountGross: gross } : x);
                    }}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1 col-span-1">
                  <Label className="text-xs">Brutto CHF</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={editEntry.amountGross.toFixed(2)}
                    readOnly
                    className="h-9 text-sm bg-muted"
                  />
                </div>
                <div className="space-y-1 col-span-1">
                  <Label className="text-xs">MWST %</Label>
                  <Select
                    value={String(editEntry.vatRate)}
                    onValueChange={v => {
                      const rate = Number(v);
                      const gross = editEntry.amountNet * (1 + rate / 100);
                      setEditEntry(x => x ? { ...x, vatRate: rate, amountGross: gross } : x);
                    }}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VAT_RATES.map(r => (
                        <SelectItem key={r} value={r}>{r}%</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Referenz (optional)</Label>
                <Input
                  value={editEntry.reference ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, reference: e.target.value || undefined } : x)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Bemerkung (optional)</Label>
                <Input
                  value={editEntry.note ?? ''}
                  onChange={e => setEditEntry(x => x ? { ...x, note: e.target.value || undefined } : x)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Abbrechen</Button>
            <Button onClick={handleEditSave} disabled={saving}>Speichern</Button>
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
            {/* Neuen Lieferanten hinzufügen */}
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
            <div className="text-xs text-muted-foreground px-0.5">
              {suppliers.length} Lieferanten · {activeSuppliers.length} aktiv
            </div>
            {/* Liste */}
            <div className="space-y-1 max-h-[340px] overflow-y-auto pr-1">
              {suppliers.map(s => (
                <div
                  key={s.id}
                  className={cn(
                    'flex items-center justify-between rounded-md px-3 py-2 text-sm border transition-colors',
                    s.active ? 'bg-card border-border' : 'bg-muted/30 border-border/40 opacity-50',
                  )}
                >
                  <span className={s.active ? 'font-medium' : 'text-muted-foreground line-through'}>
                    {s.name}
                  </span>
                  <button
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-md border transition-colors',
                      s.active
                        ? 'text-muted-foreground border-border hover:bg-muted'
                        : 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100',
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
