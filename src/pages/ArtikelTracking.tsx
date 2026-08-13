/**
 * Artikel-Tracking – Einkaufs- & Verbrauchsanalyse
 * ==================================================
 *
 * Zeigt pro getracktem Artikel:
 *   – Eingekaufte Menge & Kosten im gewählten Monat
 *   – Anzahl Bestellungen & Ø Tage zwischen Bestellungen
 *   – Theoretischer Verbrauch aus Rezeptur × Verkauf (wenn vorhanden)
 *   – Differenz Einkauf vs. theo. Verbrauch
 *
 * Dateneingabe: Einkauf manuell erfassen (Menge + Preis + Lieferant)
 */

import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  Activity, ChevronDown, ChevronUp, Plus, Trash2,
  Package, Wine, Info, Archive, TrendingUp, ShoppingCart, Clock, ArrowLeftRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { loadArtikelFromDB, type Artikel } from '@/lib/artikel-store';
import {
  addPurchase, deletePurchase, loadPurchasesForMonth,
  getArtikelMonthStats, availablePurchaseYears,
  type ArtikelPurchase,
} from '@/lib/artikel-tracking-store';
import { loadRezepturenFromDB, type ProductRecipe } from '@/lib/rezeptur-store';
import { loadProdukteData, type ProductEntry } from '@/lib/produkte-store';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const MONTHS = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

const CURRENT_YEAR  = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('de-CH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtQty(n: number) {
  if (n === Math.floor(n)) return n.toLocaleString('de-CH');
  return n.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
}

// ── Einkauf-Formular ──────────────────────────────────────────────────────────

interface PurchaseDialogProps {
  open: boolean;
  artikel: Artikel | null;
  year: number;
  month: number;
  onSave: () => void;
  onClose: () => void;
}

function PurchaseDialog({ open, artikel, year, month, onSave, onClose }: PurchaseDialogProps) {
  const { tenantId } = useTenant();
  const defaultDate = `${year}-${String(month).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;

  const [form, setForm] = useState({
    date:         defaultDate,
    quantity:     '',
    pricePerUnit: '',
    supplier:     '',
    note:         '',
  });
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open) {
      setForm({
        date:         defaultDate,
        quantity:     '',
        pricePerUnit: artikel?.defaultCostPerUnit ? String(artikel.defaultCostPerUnit) : '',
        supplier:     artikel?.standardSupplier   ?? '',
        note:         '',
      });
      setErr('');
    }
  }, [open, artikel, defaultDate]);

  function handleSave() {
    if (!artikel) return;
    const qty   = parseFloat(form.quantity.replace(',', '.'));
    const price = parseFloat(form.pricePerUnit.replace(',', '.'));
    if (!form.date)               { setErr('Datum ist erforderlich');            return; }
    if (isNaN(qty)   || qty <= 0) { setErr('Menge muss eine positive Zahl sein'); return; }
    if (isNaN(price) || price < 0){ setErr('Preis muss eine Zahl ≥ 0 sein');     return; }
    if (!form.supplier.trim())    { setErr('Lieferant ist erforderlich');          return; }

    addPurchase(tenantId, {
      articleId:    artikel.id,
      articleName:  artikel.name,
      date:         form.date,
      quantity:     qty,
      pricePerUnit: price,
      supplier:     form.supplier.trim(),
      note:         form.note.trim() || undefined,
    });
    toast.success(`Einkauf für «${artikel.name}» erfasst`);
    onSave();
    onClose();
  }

  const totalPreview = (() => {
    const q = parseFloat(form.quantity.replace(',', '.'));
    const p = parseFloat(form.pricePerUnit.replace(',', '.'));
    if (!isNaN(q) && !isNaN(p) && q > 0 && p >= 0) return q * p;
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-violet-600" />
            Einkauf erfassen
          </DialogTitle>
        </DialogHeader>
        {artikel && (
          <p className="text-sm text-muted-foreground -mt-2">
            Artikel: <span className="font-medium text-foreground">{artikel.name}</span>
            <span className="ml-1 text-xs bg-muted px-1.5 py-px rounded">{artikel.unit}</span>
          </p>
        )}
        <div className="space-y-3">
          {err && <p className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1">{err}</p>}

          <div className="space-y-1">
            <Label>Datum</Label>
            <Input
              type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Menge ({artikel?.unit ?? '—'})</Label>
              <Input
                placeholder="z.B. 5"
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Preis/Einheit (CHF NET)</Label>
              <Input
                placeholder="z.B. 12.50"
                value={form.pricePerUnit}
                onChange={e => setForm(f => ({ ...f, pricePerUnit: e.target.value }))}
              />
            </div>
          </div>

          {totalPreview !== null && (
            <div className="flex items-center justify-between text-sm rounded bg-muted/60 px-3 py-2">
              <span className="text-muted-foreground">Gesamtbetrag NET</span>
              <span className="font-bold text-foreground">CHF {fmt(totalPreview)}</span>
            </div>
          )}

          <div className="space-y-1">
            <Label>Lieferant</Label>
            <Input
              placeholder="z.B. Pistor AG"
              value={form.supplier}
              onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))}
            />
          </div>

          <div className="space-y-1">
            <Label>Notiz <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              placeholder="z.B. Aktionsware, Teillieferung"
              value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={handleSave} className="bg-violet-600 hover:bg-violet-700 text-white">
            Einkauf speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Artikel-Karte ─────────────────────────────────────────────────────────────

interface ArtikelCardProps {
  artikel: Artikel;
  year: number;
  month: number;
  rezepturen: ProductRecipe[];
  products: ProductEntry[];
  onAddPurchase: (a: Artikel) => void;
  onDeletePurchase: (id: string) => void;
}

function ArtikelCard({
  artikel, year, month, rezepturen, products,
  onAddPurchase, onDeletePurchase,
}: ArtikelCardProps) {
  const { tenantId } = useTenant();
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(
    () => getArtikelMonthStats(tenantId, artikel.id, year, month, rezepturen, products),
    [tenantId, artikel.id, year, month, rezepturen, products],
  );

  const isFood = artikel.inventoryType === 'food';

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden transition-shadow hover:shadow-sm',
      isFood
        ? 'border-emerald-200 dark:border-emerald-900'
        : 'border-blue-200 dark:border-blue-900',
    )}>
      {/* Card Header */}
      <div className={cn(
        'px-4 py-3 flex items-start justify-between gap-2',
        isFood
          ? 'bg-emerald-50/60 dark:bg-emerald-950/10'
          : 'bg-blue-50/60 dark:bg-blue-950/10',
      )}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isFood
              ? <Package className="h-4 w-4 text-emerald-600 shrink-0" />
              : <Wine    className="h-4 w-4 text-blue-600 shrink-0" />
            }
            <span className="font-semibold text-sm truncate">{artikel.name}</span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-px">{artikel.unit}</Badge>
            <Activity className="h-3.5 w-3.5 text-violet-500 shrink-0" title="Tracking aktiv" />
          </div>
          {artikel.standardSupplier && (
            <p className="text-xs text-muted-foreground mt-0.5">{artikel.standardSupplier}</p>
          )}
        </div>
        <Button size="sm" variant="outline" className="shrink-0 h-7 text-xs gap-1 text-violet-700 border-violet-300 hover:bg-violet-50" onClick={() => onAddPurchase(artikel)}>
          <Plus className="h-3 w-3" /> Einkauf
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border">
        <StatCell
          label="Eingekauft"
          value={stats.purchasedQty > 0 ? `${fmtQty(stats.purchasedQty)} ${artikel.unit}` : '—'}
          sub={stats.purchasedCHF > 0 ? `CHF ${fmt(stats.purchasedCHF)}` : undefined}
          icon={<ShoppingCart className="h-3.5 w-3.5" />}
          active={stats.purchasedQty > 0}
        />
        <StatCell
          label="Bestellungen"
          value={stats.orderCount > 0 ? String(stats.orderCount) : '—'}
          sub={stats.avgDaysBetweenOrders !== null ? `Ø ${fmt(stats.avgDaysBetweenOrders, 1)} Tage` : undefined}
          icon={<Clock className="h-3.5 w-3.5" />}
          active={stats.orderCount > 0}
        />
        <StatCell
          label="Theo. Verbrauch"
          value={stats.theoreticalConsumption !== null
            ? `${fmtQty(stats.theoreticalConsumption)} ${artikel.unit}`
            : stats.hasRecipes ? 'Keine Daten' : 'Kein Rezept'
          }
          sub={stats.theoreticalConsumption !== null && stats.avgPricePerUnit !== null
            ? `≈ CHF ${fmt(stats.theoreticalConsumption * stats.avgPricePerUnit)}`
            : undefined
          }
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          muted={stats.theoreticalConsumption === null}
        />
        <StatCell
          label="Differenz"
          value={stats.diffQty !== null
            ? `${stats.diffQty >= 0 ? '+' : ''}${fmtQty(stats.diffQty)} ${artikel.unit}`
            : '—'
          }
          sub={stats.diffQty !== null
            ? (Math.abs(stats.diffQty) < 0.01 ? 'Ausgeglichen' :
               stats.diffQty > 0 ? 'Mehr eingekauft als verbraucht' :
               'Mehr verbraucht als eingekauft')
            : undefined
          }
          icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
          highlight={stats.diffQty !== null ? (
            Math.abs(stats.diffQty) < 0.01 ? 'neutral' :
            stats.diffQty > 0 ? 'over' : 'under'
          ) : undefined}
        />
      </div>

      {/* Purchases list (expandable) */}
      {stats.orderCount > 0 && (
        <div>
          <button
            className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
            onClick={() => setExpanded(v => !v)}
          >
            <span>{stats.orderCount} Einkauf{stats.orderCount !== 1 ? 'sbeleg' : 'sbeleg'} in diesem Monat</span>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expanded && (
            <div className="border-t divide-y">
              {stats.purchases.map(p => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-muted/20">
                  <span className="text-muted-foreground shrink-0">{p.date}</span>
                  <span className="font-medium">{fmtQty(p.quantity)} {artikel.unit}</span>
                  <span className="text-muted-foreground">@ CHF {fmt(p.pricePerUnit)}</span>
                  <span className="font-semibold">= CHF {fmt(p.totalCost)}</span>
                  <span className="text-muted-foreground truncate">{p.supplier}</span>
                  {p.note && <span className="text-muted-foreground italic truncate">{p.note}</span>}
                  <button
                    className="ml-auto shrink-0 text-destructive/60 hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Einkauf vom ${p.date} löschen?`)) onDeletePurchase(p.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {stats.orderCount === 0 && (
        <p className="px-4 py-2 text-xs text-muted-foreground italic">
          Noch keine Einkäufe in {MONTHS[month - 1]} {year} erfasst.
        </p>
      )}
    </div>
  );
}

// ── Stat-Zelle ────────────────────────────────────────────────────────────────

interface StatCellProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  active?: boolean;
  muted?: boolean;
  highlight?: 'over' | 'under' | 'neutral';
}

function StatCell({ label, value, sub, icon, active, muted, highlight }: StatCellProps) {
  return (
    <div className="bg-background px-3 py-2.5">
      <div className={cn(
        'flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium mb-1',
        muted ? 'text-muted-foreground/60' : 'text-muted-foreground',
      )}>
        {icon} {label}
      </div>
      <p className={cn(
        'text-sm font-semibold',
        highlight === 'over'    && 'text-amber-600 dark:text-amber-400',
        highlight === 'under'   && 'text-red-600 dark:text-red-400',
        highlight === 'neutral' && 'text-emerald-600 dark:text-emerald-400',
        muted && 'text-muted-foreground',
        !highlight && !muted && active && 'text-foreground',
        !highlight && !muted && !active && 'text-muted-foreground',
      )}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function ArtikelTrackingPage() {
  const { isAdmin } = usePermissions();
  const { tenantId } = useTenant();

  const [year,  setYear]  = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(CURRENT_MONTH);

  const years = useMemo(() => {
    const base = availablePurchaseYears(tenantId);
    if (!base.includes(CURRENT_YEAR)) base.push(CURRENT_YEAR);
    return base.sort((a, b) => b - a);
  }, [tenantId]);

  // Daten laden (async)
  const [articles,   setArticles]   = useState<Artikel[]>([]);
  const [rezepturen, setRezepturen] = useState<ProductRecipe[]>([]);
  const [products,   setProducts]   = useState<ProductEntry[]>([]);
  const [ready,      setReady]      = useState(false);

  // Refresh-Counter, um nach Einkauf-CRUD neu zu rendern
  const [rev, setRev] = useState(0);
  function refresh() { setRev(v => v + 1); }

  useEffect(() => {
    Promise.all([
      loadArtikelFromDB(),
      loadRezepturenFromDB(),
    ]).then(([store, rez]) => {
      const tracked = store.articles.filter(
        a => a.active && (a as Record<string, unknown>).trackingAktiv === true,
      );
      setArticles(tracked.sort((a, b) => a.name.localeCompare(b.name, 'de')));
      setRezepturen(Object.values(rez));
      const raw = loadProdukteData();
      setProducts(raw?.entries ?? []);
      setReady(true);
    }).catch(() => setReady(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter-State
  const [typeFilter, setTypeFilter] = useState<'all' | 'food' | 'beverage'>('all');

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return articles;
    return articles.filter(a => a.inventoryType === typeFilter);
  }, [articles, typeFilter]);

  // Monatliche Zusammenfassung (alle getrackten Artikel)
  const monthlySummary = useMemo(() => {
    const purchases = loadPurchasesForMonth(tenantId, year, month);
    const totalCHF  = purchases.reduce((s, p) => s + p.totalCost, 0);
    const totalOrders = purchases.length;
    const uniqueArticles = new Set(purchases.map(p => p.articleId)).size;
    return { totalCHF, totalOrders, uniqueArticles };
  // rev is used to force recalculation after CRUD
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, year, month, rev]);

  // Purchase Dialog
  const [showAdd, setShowAdd]       = useState(false);
  const [addTarget, setAddTarget]   = useState<Artikel | null>(null);

  function openAdd(a: Artikel) { setAddTarget(a); setShowAdd(true); }
  function handlePurchaseSaved()  { refresh(); }
  function handleDeletePurchase(id: string) {
    deletePurchase(tenantId, id);
    toast.success('Einkauf gelöscht');
    refresh();
  }

  // Erklärung-Panel
  const [showExplanation, setShowExplanation] = useState(false);

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Kein Zugriff</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-violet-600" />
            Artikel-Tracking
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Einkauf & Verbrauch pro getracktem Artikel
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link to="/artikel">
            <Button variant="outline" size="sm" className="gap-1 text-xs">
              <Archive className="h-3.5 w-3.5" /> Artikelstamm
            </Button>
          </Link>
          <button
            onClick={() => setShowExplanation(v => !v)}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:bg-accent transition-colors"
          >
            <Info className="h-3.5 w-3.5" />
            Was bedeutet Tracking?
          </button>
        </div>
      </div>

      {/* Erklärung */}
      {showExplanation && (
        <div className="rounded-lg border border-violet-200 bg-violet-50 dark:bg-violet-950/20 dark:border-violet-800 p-4 space-y-3 text-sm">
          <h3 className="font-semibold text-violet-800 dark:text-violet-200 flex items-center gap-2">
            <Activity className="h-4 w-4" /> Was bedeutet «Tracking aktiv»?
          </h3>
          <div className="text-muted-foreground space-y-2 text-xs">
            <p>
              <strong className="text-foreground">Einkauf erfassen:</strong>{' '}
              Für jeden Einkauf eines getrackten Artikels erfasst du manuell: Menge, Preis/Einheit und Lieferant.
              So siehst du im Monat genau, wie viel du wo eingekauft hast.
            </p>
            <p>
              <strong className="text-foreground">Was wird berechnet?</strong>{' '}
              Pro Monat: Gesamtmenge, Gesamtkosten (NET CHF), Anzahl Bestellungen und Ø Tage zwischen Bestellungen.
              Wenn der Artikel in Rezepturen verwendet wird, wird zusätzlich der theoretische Verbrauch
              (Rezept-Menge × Verkaufsanzahl) berechnet.
            </p>
            <p>
              <strong className="text-foreground">Typische Fragen, die du beantworten kannst:</strong>
            </p>
            <ul className="list-disc list-inside space-y-1 pl-1">
              <li>Wie viel Rahm haben wir im März eingekauft?</li>
              <li>Wie oft bestellen wir Butter pro Monat?</li>
              <li>Was haben uns unsere Käse-Einkäufe im Januar gekostet?</li>
              <li>Kaufen wir mehr ein als wir laut Rezept verbrauchen?</li>
            </ul>
            <p>
              <strong className="text-foreground">Was sollte ich später testen?</strong>{' '}
              Wenn der theoretische Verbrauch deutlich unter dem Einkauf liegt, prüfe ob
              Überproduktion, Schwund oder nicht erfasste Eigenproduktion vorliegen.
              Wenn der Verbrauch höher als der Einkauf ist, könnte Lagerbestand verbraucht worden sein.
            </p>
            <p>
              <strong className="text-foreground">Kein Lagerbestand:</strong>{' '}
              Das Tool verwaltet keinen Lagerstand. Es zeigt nur Analyse – kein Soll/Ist-Lager.
            </p>
          </div>
        </div>
      )}

      {/* Monat-Selektor */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
          <SelectTrigger className="w-24 h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
          <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MONTHS.map((m, i) => <SelectItem key={i+1} value={String(i+1)}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">{MONTHS[month - 1]} {year}</span>
      </div>

      {/* Monats-Zusammenfassung */}
      {monthlySummary.totalOrders > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <SummaryCard label="Gesamtkosten" value={`CHF ${fmt(monthlySummary.totalCHF)}`} sub="NET · alle getrackten Artikel" />
          <SummaryCard label="Einkäufe" value={String(monthlySummary.totalOrders)} sub="Belege erfasst" />
          <SummaryCard label="Artikel gebucht" value={String(monthlySummary.uniqueArticles)} sub={`von ${articles.length} getrackten Artikeln`} />
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium">Anzeigen:</span>
        {(['all', 'food', 'beverage'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={cn(
              'text-xs px-2.5 py-1 rounded border transition-colors',
              typeFilter === t
                ? 'bg-foreground text-background border-foreground'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            {t === 'all' ? `Alle (${articles.length})` : t === 'food' ? `🥬 Food (${articles.filter(a => a.inventoryType === 'food').length})` : `🍷 Beverage (${articles.filter(a => a.inventoryType === 'beverage').length})`}
          </button>
        ))}
      </div>

      {/* Inhalt */}
      {!ready ? (
        <p className="text-muted-foreground text-sm">Laden…</p>
      ) : articles.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center space-y-3">
          <Activity className="h-8 w-8 text-muted-foreground/40 mx-auto" />
          <div>
            <p className="font-medium">Noch keine getrackten Artikel</p>
            <p className="text-sm text-muted-foreground mt-1">
              Öffne den Artikelstamm, bearbeite einen Artikel und aktiviere «Tracking aktiv».
            </p>
          </div>
          <Link to="/artikel">
            <Button variant="outline" size="sm" className="gap-1">
              <Archive className="h-3.5 w-3.5" /> Artikelstamm öffnen
            </Button>
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">Keine Artikel für diesen Filter.</p>
      ) : (
        <div className="space-y-3">
          {filtered.map(a => (
            <ArtikelCard
              key={a.id}
              artikel={a}
              year={year}
              month={month}
              rezepturen={rezepturen}
              products={products}
              onAddPurchase={openAdd}
              onDeletePurchase={handleDeletePurchase}
            />
          ))}
        </div>
      )}

      {/* Einkauf-Dialog */}
      <PurchaseDialog
        open={showAdd}
        artikel={addTarget}
        year={year}
        month={month}
        onSave={handlePurchaseSaved}
        onClose={() => setShowAdd(false)}
      />
    </div>
  );
}

// ── Zusammenfassungs-Karte ────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  );
}
