/**
 * TakeAwayTab – Take-Away-WES-Analyse (Tab der konsolidierten Produktanalyse)
 * ===========================================================================
 * Vergleicht geplante vs. tatsächliche Warenkosten für den Take-Away-Kanal.
 *
 * Soll-WES  = Verkaufte Portionen × Plankosten (aus Produktkalkulation)
 * Ist-WES   = Summe aller Belege mit Kostenzuordnung «Take Away», «TA-Speisen» oder «TA-Getränke»
 *
 * Kostenpools:
 *   takeaway          → allgemein / gemischt (Legacy)
 *   takeaway_food     → nur Speisen / Food
 *   takeaway_beverages→ nur Getränke / Beverages
 *
 * Produkte: Vertriebskanal «Take Away» in der Rezeptur.
 * Farb-Ampel: grün ≤28%, amber 28–35%, rot >35% (WES-Systemschwellen).
 *
 * Periode (Jahr/Monat) kommt als Props aus der gemeinsamen Filterleiste des
 * Containers; das Rollen-Gating übernimmt der Container zentral.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ShoppingBag, TrendingUp, TrendingDown, AlertTriangle, Info,
  ChevronRight, Package, Tag, HelpCircle, BookOpen,
  BarChart2, ArrowRight, Sparkles, ShieldCheck, Utensils, Coffee,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getAllocationTotals,
  getTakeAwayDocumentsForMonth, getDocumentAllocationAmount,
} from '@/lib/supplier-documents-store';
import { type SupplierDocument } from '@/types/supplier-documents';
import {
  loadRezepturenFromDB,
  type ProductRecipe, type RezepturenMap,
} from '@/lib/rezeptur-store';
import {
  loadProdukteDataFromDB, loadProductCosts,
  type ProductEntry, type ProdukteData, type ProductCostEntry,
} from '@/lib/produkte-store';

// ─── Konstanten ───────────────────────────────────────────────────────────────

/** WES%-Ampelschwellen (systemweit einheitlich) */
const WES_GREEN  = 28;
const WES_RED    = 35;

/** Ist > Soll-Alarm-Schwelle (10%) */
const IST_SOLL_ALARM_PCT = 10;

/** Amber-Markierung Warengruppen */
const HIGH_COST_THRESHOLD = 15;

const FIBU_WARENGRUPPEN: Record<string, string> = {
  '4020': 'Wein',
  '4030': 'Bier',
  '4040': 'Spirituosen',
  '4050': 'Mineral / Softdrinks',
  '4060': 'Küche / Food',
  '4061': 'Rest Food',
  '4070': 'Kaffee & Tee',
  '4090': 'Diverses',
  '4701': 'Betriebsmaterial / Verpackung',
};

const CATEGORY_LABELS_LOCAL: Record<string, string> = {
  food:     'Speisen (Food)',
  beverage: 'Getränke',
  other:    'Sonstiges',
};

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ─── Typen ────────────────────────────────────────────────────────────────────

interface TakeAwayProductRow {
  productName: string;
  count: number;
  revenue: number;
  wes: number;         // Plankosten pro Portion (CHF)
  sollWes: number;     // count × wes
  actualShare: number; // proportionaler Ist-WES-Anteil (CHF)
  nettoPrice: number;
  wesQ: number;        // wes / nettoPrice × 100 (Soll-WES%)
  wesStatus: 'green' | 'amber' | 'red' | 'unknown';
}

interface TrendMonth {
  year: number;
  month: number;
  label: string;
  soll: number;
  ist: number;
  diff: number;
}

interface CostDriverRow {
  supplier: string;
  amount: number;
  pctOfTotal: number;
  docCount: number;
}

interface ProductGroupRow {
  key: string;
  label: string;
  amount: number;
  pctOfTotal: number;
  docCount: number;
  isHighCost: boolean;
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function chf(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number): string {
  return `${n.toFixed(1)} %`;
}

function wesStatus(q: number): 'green' | 'amber' | 'red' {
  if (q <= WES_GREEN) return 'green';
  if (q <= WES_RED)   return 'amber';
  return 'red';
}

function wesStatusColor(s: 'green' | 'amber' | 'red' | 'unknown'): string {
  if (s === 'green') return 'text-emerald-600 dark:text-emerald-400';
  if (s === 'amber') return 'text-amber-600 dark:text-amber-400';
  if (s === 'red')   return 'text-red-600 dark:text-red-400';
  return 'text-muted-foreground';
}

function getDiffLabel(diff: number): string {
  if (diff > 0) return `+ CHF ${chf(diff)} über Plan`;
  if (diff < 0) return `− CHF ${chf(Math.abs(diff))} unter Plan`;
  return 'Genau auf Plan';
}

function prevMonths(year: number, month: number, n: number): { year: number; month: number }[] {
  const result: { year: number; month: number }[] = [];
  let y = year;
  let m = month;
  for (let i = 0; i < n; i++) {
    m--;
    if (m < 1) { m = 12; y--; }
    result.unshift({ year: y, month: m });
  }
  return result;
}

/** Summe über alle TA-Pools für ein Dokument */
function getTaAmount(doc: SupplierDocument): number {
  return (
    getDocumentAllocationAmount(doc, 'takeaway') +
    getDocumentAllocationAmount(doc, 'takeaway_food') +
    getDocumentAllocationAmount(doc, 'takeaway_beverages')
  );
}

// ─── Kleine Komponenten ───────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent = false, warning = false, teal = false, green = false,
}: {
  label: string; value: string; sub?: string;
  accent?: boolean; warning?: boolean; teal?: boolean; green?: boolean;
}) {
  return (
    <div className={cn(
      'rounded-xl border p-4 space-y-1',
      warning ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/20'
      : teal   ? 'border-teal-300 bg-teal-50 dark:border-teal-700 dark:bg-teal-950/30'
      : green  ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/20'
      : accent ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
      : 'border-border bg-card',
    )}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn(
        'text-2xl font-bold tracking-tight',
        warning ? 'text-red-700 dark:text-red-400'
        : teal   ? 'text-teal-700 dark:text-teal-400'
        : green  ? 'text-emerald-700 dark:text-emerald-400'
        : accent ? 'text-violet-700 dark:text-violet-400'
        : '',
      )}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function WesAmpelDot({ status }: { status: 'green' | 'amber' | 'red' | 'unknown' }) {
  return (
    <span className={cn(
      'inline-block w-2 h-2 rounded-full flex-shrink-0',
      status === 'green' ? 'bg-emerald-500'
      : status === 'amber' ? 'bg-amber-400'
      : status === 'red'   ? 'bg-red-500'
      : 'bg-muted-foreground/40',
    )} />
  );
}

function HelpSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-dashed border-muted-foreground/30 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">So funktioniert die Take-Away-Analyse</span>
        <ChevronRight className={cn(
          'h-4 w-4 text-muted-foreground ml-auto transition-transform',
          open && 'rotate-90',
        )} />
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-dashed border-muted-foreground/20">
          <div className="pt-4 grid gap-4 md:grid-cols-2">

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <ShoppingBag className="h-3.5 w-3.5 text-teal-600" />
                1. Produkte als Take-Away markieren
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Unter <strong>Produkte → Kalkulation</strong> im Bereich <em>Vertriebskanal</em>
                {' '}<strong>«Take Away»</strong> wählen. Das Produkt erscheint dann hier als Soll-Benchmark.
                <strong> Soll-WES</strong> = verkaufte Portionen × Plankosten.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 text-violet-600" />
                2. Kostenpools – drei Pools für Take Away
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Bei Lieferantenbelegen stehen drei Take-Away-Pools zur Verfügung:
                <br />
                <strong>«Take Away – Speisen»</strong> = Food-Zutaten, Verpackung.
                <br />
                <strong>«Take Away – Getränke»</strong> = Getränke zum Mitnehmen.
                <br />
                <strong>«Take Away (allgemein)»</strong> = Legacy / gemischte Belege.
                <br />
                Alle drei fliessen in den Ist-WES dieser Analyse ein.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <ArrowRight className="h-3.5 w-3.5 text-teal-600" />
                3. Take Away vs. Lunch – was ist der Unterschied?
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Lunch</strong> = Mittagsmenus, die im Restaurant konsumiert werden.
                <br />
                <strong>Take Away</strong> = Produkte zum Mitnehmen: Sandwiches, Salate, Boxen, Coffee-to-go.
                Niedrigere Personalkosten, aber oft höhere Verpackungskosten. Analysen strikt getrennt.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5 text-teal-600" />
                4. WES-Ampel – Zielwerte
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="text-emerald-600 font-semibold">● Grün ≤ {WES_GREEN}%</span>
                {' '}– Marge gut.{'  '}
                <span className="text-amber-600 font-semibold">● Amber {WES_GREEN}–{WES_RED}%</span>
                {' '}– prüfen.{'  '}
                <span className="text-red-600 font-semibold">● Rot &gt; {WES_RED}%</span>
                {' '}– Handlungsbedarf: Preis, Rezeptur oder Einkauf überprüfen.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5 text-blue-600" />
                5. Ist &gt; Soll-Alarm
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Wenn der tatsächliche Einkauf (Ist-WES) den geplanten Bedarf (Soll-WES) um mehr als
                {' '}{IST_SOLL_ALARM_PCT}% übersteigt, erscheint ein roter Alarm.
                Mögliche Ursachen: Überbestellung, Schwund, falsche Kostenzuordnung, nicht erfasste Portionen.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                6. Automatische Zuordnungs-Vorschläge
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Das System merkt sich, welchem Pool ein Lieferant am häufigsten zugeordnet wurde.
                Ab 2 gleichen Zuordnungen wird der Pool bei neuen Belegen automatisch vorgeschlagen.
              </p>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function TakeAwayTab({ year, month }: { year: number; month: number }) {
  const [productGroupMode, setProductGroupMode] = useState<'account' | 'category'>('account');

  const [rezepturen,   setRezepturen]   = useState<RezepturenMap>({});
  const [produkteData, setProdukteData] = useState<ProdukteData>({});
  const [productCosts, setProductCosts] = useState<ProductCostEntry[]>([]);
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadRezepturenFromDB(),
      loadProdukteDataFromDB(),
      loadProductCosts(),
    ]).then(([rez, prod, costs]) => {
      setRezepturen(rez);
      setProdukteData(prod);
      setProductCosts(costs);
      setLoading(false);
    });
  }, []);

  // ── Take-Away-Produkte ──
  const takeAwayRecipes = useMemo(() =>
    Object.values(rezepturen).filter(r => r.salesChannel === 'takeaway'),
    [rezepturen],
  );
  const hasTakeAwayProducts = takeAwayRecipes.length > 0;

  // ── Allokations-Totals ──
  const allocationTotals = useMemo(() => getAllocationTotals(year, month), [year, month]);
  const istWesTotal      = allocationTotals.takeaway_total;
  const istWesFood       = allocationTotals.takeaway_food;
  const istWesBeverages  = allocationTotals.takeaway_beverages;
  const istWesGeneral    = allocationTotals.takeaway;

  // ── Produkt-Rows ──
  const productRows = useMemo((): TakeAwayProductRow[] => {
    const monthStr  = String(month).padStart(2, '0');
    const yearMonth = `${year}-${monthStr}`;

    return takeAwayRecipes.map(recipe => {
      const prodEntry: ProductEntry | undefined = produkteData[recipe.productName];
      const costEntry = productCosts.find(
        c => c.productName === recipe.productName && c.yearMonth === yearMonth,
      );

      const count    = costEntry?.portionsSold ?? 0;
      const revenue  = costEntry?.revenue      ?? 0;

      const wes = recipe.costMode === 'pauschal'
        ? recipe.manualCost
        : recipe.costMode === 'gemischt'
          ? recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0) + recipe.manualCost
          : recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);

      const sollWes    = count * wes;
      const nettoPrice = prodEntry?.nettoPrice ?? 0;
      const wesQ       = nettoPrice > 0 ? (wes / nettoPrice) * 100 : 0;
      const status     = nettoPrice > 0 ? wesStatus(wesQ) : 'unknown';

      return { productName: recipe.productName, count, revenue, wes, sollWes, actualShare: 0, nettoPrice, wesQ, wesStatus: status };
    });
  }, [takeAwayRecipes, produkteData, productCosts, year, month]);

  // ── Summen + Ist-Anteil pro Produkt ──
  const totalRevenue = useMemo(() => productRows.reduce((s, r) => s + r.revenue, 0), [productRows]);
  const totalCount   = useMemo(() => productRows.reduce((s, r) => s + r.count,   0), [productRows]);
  const sollWesTotal = useMemo(() => productRows.reduce((s, r) => s + r.sollWes, 0), [productRows]);

  // Proportionaler Ist-WES-Anteil je Produkt (basierend auf Soll-WES-Gewicht)
  const productRowsWithActual = useMemo((): TakeAwayProductRow[] => {
    return productRows.map(r => ({
      ...r,
      actualShare: sollWesTotal > 0 ? (r.sollWes / sollWesTotal) * istWesTotal : 0,
    }));
  }, [productRows, sollWesTotal, istWesTotal]);

  const diff       = istWesTotal - sollWesTotal;
  const wesPct     = totalRevenue > 0 ? (istWesTotal / totalRevenue) * 100 : 0;
  const isOverWarn = wesPct > WES_RED && istWesTotal > 0;

  // Ist > Soll Alarm (10%)
  const isIstOverSoll = useMemo(() => {
    if (sollWesTotal <= 0 || istWesTotal <= 0) return false;
    return ((istWesTotal - sollWesTotal) / sollWesTotal) * 100 > IST_SOLL_ALARM_PCT;
  }, [istWesTotal, sollWesTotal]);

  // ── 3-Monats-Trend ──
  const trend = useMemo((): TrendMonth[] => {
    const months3 = prevMonths(year, month, 3);
    return months3.map(({ year: y, month: m }) => {
      const ta  = getAllocationTotals(y, m);
      const ist = ta.takeaway_total;

      const monthStr  = String(m).padStart(2, '0');
      const yearMonth = `${y}-${monthStr}`;
      const soll = takeAwayRecipes.reduce((sum, recipe) => {
        const costEntry = productCosts.find(
          c => c.productName === recipe.productName && c.yearMonth === yearMonth,
        );
        const count = costEntry?.portionsSold ?? 0;
        const wes   = recipe.costMode === 'pauschal'
          ? recipe.manualCost
          : recipe.costMode === 'gemischt'
            ? recipe.ingredients.reduce((s2, i) => s2 + i.quantity * i.costPerUnit, 0) + recipe.manualCost
            : recipe.ingredients.reduce((s2, i) => s2 + i.quantity * i.costPerUnit, 0);
        return sum + count * wes;
      }, 0);

      return { year: y, month: m, label: `${MONTHS[m - 1]} ${y}`, soll, ist, diff: ist - soll };
    });
  }, [year, month, takeAwayRecipes, productCosts]);

  // ── Lieferanten-Kostentreiber ──
  const taDocs = useMemo(() => getTakeAwayDocumentsForMonth(year, month), [year, month]);

  const costDriverRows = useMemo((): CostDriverRow[] => {
    const bySupplier: Record<string, { amount: number; count: number }> = {};
    for (const doc of taDocs) {
      const amt = getTaAmount(doc);
      if (amt <= 0) continue;
      const s = doc.supplierName || 'Unbekannt';
      if (!bySupplier[s]) bySupplier[s] = { amount: 0, count: 0 };
      bySupplier[s].amount += amt;
      bySupplier[s].count  += 1;
    }
    const total = Object.values(bySupplier).reduce((s, v) => s + v.amount, 0);
    return Object.entries(bySupplier)
      .map(([supplier, v]) => ({
        supplier,
        amount:     v.amount,
        pctOfTotal: total > 0 ? (v.amount / total) * 100 : 0,
        docCount:   v.count,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [taDocs]);

  // ── Warengruppen-Kostentreiber ──
  const productGroupRows = useMemo((): ProductGroupRow[] => {
    const byKey: Record<string, { label: string; amount: number; count: number }> = {};

    for (const doc of taDocs) {
      const amt = getTaAmount(doc);
      if (amt <= 0) continue;

      let key: string;
      let label: string;

      if (productGroupMode === 'account') {
        const acc = (doc as SupplierDocument & { accountNumber?: string }).accountNumber;
        key   = acc || '__none__';
        label = acc ? (FIBU_WARENGRUPPEN[acc] ?? `Konto ${acc}`) : 'Kein Konto zugewiesen';
      } else {
        key   = doc.category ?? 'other';
        label = CATEGORY_LABELS_LOCAL[doc.category ?? 'other'] ?? 'Sonstiges';
      }

      if (!byKey[key]) byKey[key] = { label, amount: 0, count: 0 };
      byKey[key].amount += amt;
      byKey[key].count  += 1;
    }

    const total = Object.values(byKey).reduce((s, v) => s + v.amount, 0);
    return Object.entries(byKey)
      .map(([key, v]) => ({
        key,
        label:      v.label,
        amount:     v.amount,
        docCount:   v.count,
        pctOfTotal: total > 0 ? (v.amount / total) * 100 : 0,
        isHighCost: total > 0 && (v.amount / total) * 100 > HIGH_COST_THRESHOLD,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [taDocs, productGroupMode]);

  // ── Konsistenzwarnung ──
  const consistencyWarning = useMemo(() => {
    if (!hasTakeAwayProducts || istWesTotal === 0) return false;
    const unassignedTotal = allocationTotals.unassigned;
    return unassignedTotal / (istWesTotal + unassignedTotal) > 0.2;
  }, [hasTakeAwayProducts, istWesTotal, allocationTotals]);

  // ── Guard ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-2">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent mx-auto" />
          <p className="text-sm text-muted-foreground">Daten werden geladen…</p>
        </div>
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5" data-testid="tab-panel-takeaway">

      {/* Hilfe */}
      <HelpSection />

      {/* Ist > Soll Alarm */}
      {isIstOverSoll && (
        <Alert className="border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/20">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-700 dark:text-red-400 font-medium">
            Take Away Einkauf zu hoch im Vergleich zur Kalkulation
            <span className="ml-2 text-sm font-normal opacity-80">
              (Ist-WES überschreitet Soll-WES um mehr als {IST_SOLL_ALARM_PCT}%)
            </span>
          </AlertDescription>
        </Alert>
      )}

      {/* WES > 35% Alarm */}
      {isOverWarn && (
        <Alert className="border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/20">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-700 dark:text-red-400 font-medium">
            WES-Quote kritisch – Marge zu tief
            <span className="ml-2 text-sm font-normal opacity-80">
              (WES {pct(wesPct)} &gt; {WES_RED}% Rot-Schwelle)
            </span>
          </AlertDescription>
        </Alert>
      )}

      {/* Konsistenzwarnung */}
      {consistencyWarning && (
        <Alert className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/20">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-amber-700 dark:text-amber-400">
            <strong>Mehr als 20% der Belege sind nicht zugeordnet.</strong>{' '}
            Prüfe die Kostenzuordnung in den Lieferantenbelegen, damit der Ist-WES vollständig erfasst wird.
          </AlertDescription>
        </Alert>
      )}

      {/* KPI-Karten */}
      {hasTakeAwayProducts && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard
            label="Umsatz Take Away (netto)"
            value={totalRevenue > 0 ? `CHF ${chf(totalRevenue)}` : '–'}
            sub={`${takeAwayRecipes.length} Produkte · ${totalCount > 0 ? totalCount.toLocaleString('de-CH') : '–'} Einheiten`}
            teal
          />
          <KpiCard
            label="Soll-WES (Plan)"
            value={sollWesTotal > 0 ? `CHF ${chf(sollWesTotal)}` : '–'}
            sub="Portionen × Plankosten (aus Kalkulation)"
          />
          <KpiCard
            label="Ist-WES (Einkauf)"
            value={istWesTotal > 0 ? `CHF ${chf(istWesTotal)}` : '–'}
            sub="Alle TA-Kostenpools (Speisen + Getränke + Allg.)"
            warning={isOverWarn || isIstOverSoll}
          />
          <KpiCard
            label="WES %"
            value={wesPct > 0 ? pct(wesPct) : '–'}
            sub={`Ziel: ≤ ${WES_GREEN}%  |  Alarm: > ${WES_RED}%`}
            warning={isOverWarn}
            green={!isOverWarn && wesPct > 0 && wesPct <= WES_GREEN}
            accent={!isOverWarn && wesPct > WES_GREEN && wesPct <= WES_RED}
          />
          <KpiCard
            label="Differenz (Ist − Soll)"
            value={istWesTotal > 0 || sollWesTotal > 0 ? getDiffLabel(diff) : '–'}
            sub={isIstOverSoll ? `+${(((istWesTotal - sollWesTotal) / sollWesTotal) * 100).toFixed(1)}% über Plan` : diff > 0 ? 'Über Plan' : diff < 0 ? 'Unter Plan' : ''}
            warning={isIstOverSoll}
          />
          <KpiCard
            label="Ist-WES Speisen"
            value={istWesFood + istWesGeneral > 0 ? `CHF ${chf(istWesFood + istWesGeneral)}` : '–'}
            sub={istWesBeverages > 0 ? `Getränke: CHF ${chf(istWesBeverages)}` : 'Getränke: –'}
          />
        </div>
      )}

      {/* Pool-Split – Speisen vs. Getränke */}
      {hasTakeAwayProducts && (istWesFood > 0 || istWesBeverages > 0 || istWesGeneral > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Kostenpool-Aufteilung — {MONTHS[month - 1]} {year}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Aufschlüsselung des Ist-WES nach den drei Take-Away-Kostenpools.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Food */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Utensils className="h-3.5 w-3.5 text-teal-600" />
                  <p className="text-xs font-semibold">Speisen (TA-Food)</p>
                </div>
                <p className="text-lg font-bold font-mono">
                  {istWesFood > 0 ? `CHF ${chf(istWesFood)}` : '–'}
                </p>
                {istWesTotal > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {pct((istWesFood / istWesTotal) * 100)} des Ist-WES
                  </p>
                )}
              </div>
              {/* Beverages */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Coffee className="h-3.5 w-3.5 text-teal-600" />
                  <p className="text-xs font-semibold">Getränke (TA-Beverages)</p>
                </div>
                <p className="text-lg font-bold font-mono">
                  {istWesBeverages > 0 ? `CHF ${chf(istWesBeverages)}` : '–'}
                </p>
                {istWesTotal > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {pct((istWesBeverages / istWesTotal) * 100)} des Ist-WES
                  </p>
                )}
              </div>
              {/* General */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <ShoppingBag className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold">Allgemein / Legacy</p>
                </div>
                <p className="text-lg font-bold font-mono">
                  {istWesGeneral > 0 ? `CHF ${chf(istWesGeneral)}` : '–'}
                </p>
                {istWesTotal > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {pct((istWesGeneral / istWesTotal) * 100)} des Ist-WES
                  </p>
                )}
              </div>
            </div>
            {istWesGeneral > 0 && (
              <div className="mt-3 rounded-md border border-dashed border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
                <span>
                  <strong>Tipp:</strong> Der Pool «Allgemein» enthält ältere oder gemischte Belege.
                  Für bessere Auswertung bitte neue Belege auf «TA-Speisen» oder «TA-Getränke» aufteilen.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Produktliste mit Ist-Anteil + Ampel */}
      {hasTakeAwayProducts && productRowsWithActual.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
              Take-Away-Produkte — {MONTHS[month - 1]} {year}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ampel nach Soll-WES%: <span className="text-emerald-600 font-medium">grün ≤{WES_GREEN}%</span>,
              {' '}<span className="text-amber-600 font-medium">amber {WES_GREEN}–{WES_RED}%</span>,
              {' '}<span className="text-red-600 font-medium">rot &gt;{WES_RED}%</span>.
              Ist-Anteil CHF = proportionale Zuteilung des Ist-WES anhand des Soll-WES-Anteils.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">Produkt</TableHead>
                  <TableHead className="text-xs text-right">Einheiten</TableHead>
                  <TableHead className="text-xs text-right">Umsatz CHF</TableHead>
                  <TableHead className="text-xs text-right">Plankosten CHF/Stk.</TableHead>
                  <TableHead className="text-xs text-right">Soll-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">Ist-Anteil CHF</TableHead>
                  <TableHead className="text-xs text-right">WES %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productRowsWithActual
                  .sort((a, b) => b.wesQ - a.wesQ)
                  .map(r => (
                  <TableRow
                    key={r.productName}
                    className={
                      r.wesStatus === 'red'   ? 'bg-red-50/30 dark:bg-red-950/10'
                      : r.wesStatus === 'amber' ? 'bg-amber-50/20 dark:bg-amber-950/5'
                      : ''
                    }
                  >
                    <TableCell className="text-sm font-medium">
                      <div className="flex items-center gap-1.5">
                        <WesAmpelDot status={r.wesStatus} />
                        {r.productName}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {r.count > 0 ? r.count : '–'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {r.revenue > 0 ? chf(r.revenue) : '–'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {chf(r.wes)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {r.sollWes > 0 ? chf(r.sollWes) : '–'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {r.actualShare > 0 ? chf(r.actualShare) : '–'}
                    </TableCell>
                    <TableCell className={cn(
                      'text-right font-mono text-sm font-semibold',
                      wesStatusColor(r.wesStatus),
                    )}>
                      {r.nettoPrice > 0 ? pct(r.wesQ) : '–'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* 3-Monats-Trend */}
      {hasTakeAwayProducts && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              WES-Trend letzte 3 Monate
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Vergleich Soll-WES vs. Ist-WES der letzten 3 Monate. Amber = Ist &gt; Soll um mehr als 10%.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">Monat</TableHead>
                  <TableHead className="text-xs text-right">Soll-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">Ist-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">Differenz CHF</TableHead>
                  <TableHead className="text-xs text-right">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trend.map(t => {
                  const isOver10 = t.soll > 0 && t.diff / t.soll > 0.1;
                  return (
                    <TableRow key={t.label} className={isOver10 ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}>
                      <TableCell className="text-sm font-medium">{t.label}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {t.soll > 0 ? chf(t.soll) : '–'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {t.ist > 0 ? chf(t.ist) : '–'}
                      </TableCell>
                      <TableCell className={cn(
                        'text-right font-mono text-sm font-medium',
                        t.diff > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
                      )}>
                        {t.soll > 0 || t.ist > 0 ? (t.diff >= 0 ? `+${chf(t.diff)}` : `−${chf(Math.abs(t.diff))}`) : '–'}
                      </TableCell>
                      <TableCell className="text-right">
                        {t.ist > 0 && t.diff > 0 && (
                          <TrendingUp className="h-4 w-4 inline text-amber-500" />
                        )}
                        {t.ist > 0 && t.diff <= 0 && (
                          <TrendingDown className="h-4 w-4 inline text-emerald-500" />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Lieferanten-Kostentreiber */}
      {costDriverRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Tag className="h-4 w-4 text-muted-foreground" />
              Top-Lieferanten – Take Away — {MONTHS[month - 1]} {year}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Alle Belege aus den drei Take-Away-Pools (Speisen, Getränke, Allgemein).
              Duplikatschutz: verknüpfte Lieferscheine werden ausgeschlossen.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">#</TableHead>
                  <TableHead className="text-xs">Lieferant</TableHead>
                  <TableHead className="text-xs text-right">Belege</TableHead>
                  <TableHead className="text-xs text-right">Take-Away-Anteil CHF</TableHead>
                  <TableHead className="text-xs text-right">Anteil %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costDriverRows.map((row, idx) => (
                  <TableRow key={row.supplier}>
                    <TableCell className="text-xs text-muted-foreground w-8">{idx + 1}</TableCell>
                    <TableCell className="text-sm font-medium">{row.supplier}</TableCell>
                    <TableCell className="text-right text-sm font-mono text-muted-foreground">
                      {row.docCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {chf(row.amount)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-teal-400 dark:bg-teal-500"
                            style={{ width: `${Math.min(row.pctOfTotal, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-muted-foreground w-12 text-right">
                          {pct(row.pctOfTotal)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/10 px-3 py-2 flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-600" />
              <span>
                <strong>Duplikatschutz aktiv:</strong> Wenn ein Lieferschein mit einer Rechnung verknüpft ist,
                zählt nur die Rechnung. Kein Einkauf wird doppelt gezählt.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Warengruppen-Kostentreiber */}
      {productGroupRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between flex-wrap gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                Top-Kostenträger – Warengruppen — {MONTHS[month - 1]} {year}
              </CardTitle>
              <div className="flex rounded-lg border border-border overflow-hidden text-xs shrink-0">
                <button
                  onClick={() => setProductGroupMode('account')}
                  className={cn(
                    'px-3 py-1.5 font-medium transition-colors',
                    productGroupMode === 'account'
                      ? 'bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                  )}
                >
                  FIBU-Warengruppe
                </button>
                <button
                  onClick={() => setProductGroupMode('category')}
                  className={cn(
                    'px-3 py-1.5 font-medium transition-colors border-l border-border',
                    productGroupMode === 'category'
                      ? 'bg-foreground text-background'
                      : 'bg-background text-muted-foreground hover:bg-muted',
                  )}
                >
                  Kategorie
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {productGroupMode === 'account'
                ? 'Gruppierung nach FIBU-Konto. Tipp: Verpackungsmaterial erscheint unter 4701.'
                : 'Gruppierung nach Kategorie (Speisen / Getränke / Sonstiges).'
              }
              {' '}Einträge über {HIGH_COST_THRESHOLD}% sind amber markiert.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border border-dashed border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600" />
              <span>
                <strong>Lieferant vs. Warengruppe:</strong> Lieferant = <em>wer</em> liefert.
                Warengruppe = <em>was</em> eingekauft wird.
                Beim Take Away ist Konto 4701 (Verpackungsmaterial) oft ein wichtiger Kostentreiber.
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">#</TableHead>
                  <TableHead className="text-xs">
                    {productGroupMode === 'account' ? 'Warengruppe (FIBU-Konto)' : 'Kategorie'}
                  </TableHead>
                  <TableHead className="text-xs text-right">Belege</TableHead>
                  <TableHead className="text-xs text-right">Take-Away-Anteil CHF</TableHead>
                  <TableHead className="text-xs text-right">Anteil %</TableHead>
                  <TableHead className="text-xs" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {productGroupRows.map((row, idx) => (
                  <TableRow
                    key={row.key}
                    className={row.isHighCost ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}
                  >
                    <TableCell className="text-xs text-muted-foreground w-8">{idx + 1}</TableCell>
                    <TableCell className="text-sm font-medium">
                      {row.label}
                      {productGroupMode === 'account' && row.key !== '__none__' && (
                        <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">({row.key})</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm font-mono text-muted-foreground">
                      {row.docCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      {chf(row.amount)}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              row.isHighCost ? 'bg-amber-500' : 'bg-teal-400 dark:bg-teal-500',
                            )}
                            style={{ width: `${Math.min(row.pctOfTotal, 100)}%` }}
                          />
                        </div>
                        <span className={cn(
                          'font-mono w-12 text-right',
                          row.isHighCost ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-muted-foreground',
                        )}>
                          {pct(row.pctOfTotal)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="w-36 text-right">
                      {row.isHighCost && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-700">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Hoher Anteil – prüfen
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <p className="text-[10px] text-muted-foreground px-1">
              Amber-Markierung bei mehr als {HIGH_COST_THRESHOLD}% Anteil am gesamten Take-Away-Ist-WES.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Keine Take-Away-Produkte */}
      {!hasTakeAwayProducts && (
        <Card>
          <CardContent className="py-14 text-center">
            <ShoppingBag className="h-12 w-12 mx-auto mb-3 opacity-25" />
            <p className="text-sm font-medium text-muted-foreground">
              Noch keine Take-Away-Produkte konfiguriert
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Gehe zu{' '}
              <Link to="/produkte" className="underline text-teal-600">Produkte → Kalkulation</Link>
              {' '}und wähle im Bereich <strong>Vertriebskanal</strong> die Option{' '}
              <strong>«Take Away»</strong>.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Keine Daten */}
      {hasTakeAwayProducts && istWesTotal === 0 && sollWesTotal === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <HelpCircle className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium text-muted-foreground">
              Keine Daten für {MONTHS[month - 1]} {year}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Keine Belege mit Take-Away-Kostenzuordnung oder keine Portionen im Tagesabschluss vorhanden.
              Weise Lieferantenbelege den Pools «Take Away – Speisen» oder «Take Away – Getränke» zu.
            </p>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
