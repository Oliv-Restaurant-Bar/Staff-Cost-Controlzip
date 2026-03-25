/**
 * Take-Away-WES-Analyse
 * ======================
 * Vergleicht geplante vs. tatsächliche Warenkosten für den Take-Away-Kanal.
 *
 * Soll-WES  = Verkaufte Portionen × Plankosten pro Portion (aus Produktkalkulation)
 * Ist-WES   = Summe der Lieferantenbelege mit Kostenzuordnung «Take Away»
 *
 * Produkte werden über den Vertriebskanal «Take Away» in der Rezeptur zugeordnet.
 * Einkäufe werden über die Kostenzuordnung «Take Away» im Lieferantenbeleg erfasst.
 *
 * WICHTIG: Take Away ist vom Restaurant- und Lunch-Betrieb strikt getrennt.
 * Keine Überschneidungen mit Lunch oder À la carte.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ShoppingBag, TrendingUp, TrendingDown, AlertTriangle, Info,
  ChevronRight, Package, Tag, HelpCircle, BookOpen,
  BarChart2, ArrowRight, Sparkles, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import {
  getAllocationTotals, availableYears,
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

/** WES%-Warnschwelle für Take Away. Über 30% → Marge zu tief. */
const TAKEAWAY_WES_WARN_THRESHOLD = 30;

/** Amber-Markierung für Warengruppen über diesem Anteil */
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
  '4701': 'Betriebsmaterial',
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
  wes: number;       // Plankosten pro Portion (aus Rezeptur/Kalkulation)
  sollWes: number;   // count × wes
  nettoPrice: number;
  wesQ: number;      // wes / nettoPrice × 100
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

// ─── Kleine Komponenten ───────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent = false, warning = false, teal = false,
}: { label: string; value: string; sub?: string; accent?: boolean; warning?: boolean; teal?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl border p-4 space-y-1',
      warning ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
      : teal   ? 'border-teal-300 bg-teal-50 dark:border-teal-700 dark:bg-teal-950/30'
      : accent ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
      : 'border-border bg-card',
    )}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn(
        'text-2xl font-bold tracking-tight',
        warning ? 'text-amber-700 dark:text-amber-400'
        : teal   ? 'text-teal-700 dark:text-teal-400'
        : accent ? 'text-violet-700 dark:text-violet-400'
        : '',
      )}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
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

            {/* Grundprinzip */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <ShoppingBag className="h-3.5 w-3.5 text-teal-600" />
                1. Produkte als Take-Away-Produkt markieren
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Gehe zu <strong>Produkte → Kalkulation</strong> und öffne z.B. «Sandwich To Go» oder «Salat Box».
                Im Bereich <em>Vertriebskanal</em> wähle <strong>«Take Away»</strong> → das Produkt erscheint
                in dieser Analyse als Soll-Benchmark.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Soll-WES</strong> = Verkaufte Portionen × Plankosten (aus Kalkulation).
                Je mehr Einheiten verkauft wurden, desto höher der erlaubte Einkauf.
              </p>
            </div>

            {/* Einkäufe zuordnen */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 text-violet-600" />
                2. Einkäufe dem Take-Away zuordnen
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Bei jedem Lieferantenbeleg (Lieferschein oder Rechnung) gibt es das Feld
                <em> Kostenzuordnung</em>. Wähle <strong>«Take Away»</strong> für Verpackungen,
                Zutaten und Rohwaren, die ausschliesslich für den Take-Away-Betrieb eingekauft werden.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Für gemischte Lieferungen (z.B. Fleisch für Restaurant <em>und</em> Take Away):
                klicke «% Aufteilung» und verteile den Betrag prozentual.
              </p>
            </div>

            {/* Take Away vs. Lunch */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <ArrowRight className="h-3.5 w-3.5 text-teal-600" />
                3. Take Away vs. Lunch – was ist der Unterschied?
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Lunch</strong> sind Mittagsmenus, die im Restaurant konsumiert werden (Menu 1, Menu 2).
                Der Gast sitzt am Tisch, der Deckungsbeitrag beinhaltet Servierpersonal und Infrastruktur.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Take Away</strong> sind Produkte zum Mitnehmen: Sandwiches, Salate, Boxen, Kaffee-to-go.
                Niedrigere Personalkosten, aber oft höhere Verpackungskosten.
                Die Analysen sind daher strikt getrennt – kein Durchmischen.
              </p>
            </div>

            {/* WES-Zielwerte Take Away */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5 text-teal-600" />
                4. Gute WES-Werte für Take Away
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Ziel-WES für Take Away: 25–30%</strong> des Umsatzes.
                Da weniger Personalaufwand entsteht, können die Warenkosten etwas höher liegen als
                im Restaurant (WES-Ziel dort typisch 28–35%).
                Über <strong>30%</strong> → Warnung: Marge zu tief, Preise oder Einkauf prüfen.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Typische Hebel: Verpackungskosten reduzieren (Grossbestellung),
                Rezeptur optimieren (günstigere Zutaten ohne Qualitätsverlust),
                Verkaufspreis leicht erhöhen (Take Away-Kunden sind weniger preissensibel als erwartet).
              </p>
            </div>

            {/* Kostenanalyse Lieferant vs. Warengruppe */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5 text-blue-600" />
                5. Kostenanalyse: Lieferant vs. Warengruppe
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Lieferanten-Ansicht:</strong> Zeigt, <em>wer</em> die Ware liefert.
                Gut für Preisvergleiche und Lieferantenkonditionen.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Warengruppen-Ansicht:</strong> Zeigt, <em>was</em> eingekauft wird
                (z.B. Küche/Food = 4060, Verpackungsmaterial = 4701).
                Einträge über {HIGH_COST_THRESHOLD}% sind amber markiert.
                Tipp: Verpackungsmaterial (4701) ist bei Take Away oft ein wichtiger Kostentreiber.
              </p>
            </div>

            {/* Automatische Vorschläge */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                6. Automatische Zuordnungs-Vorschläge
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Das System merkt sich, welchem Pool du einen Lieferanten am häufigsten zugeordnet hast.
                Nach mindestens 2 gleichen Zuordnungen wird die Kostenzuordnung bei neuen Belegen
                desselben Lieferanten automatisch vorbelegt.
              </p>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function TakeAwayAnalysePage() {
  const { isAdmin } = usePermissions();

  // ── Datumswahl ──
  const now        = new Date();
  const thisYear   = now.getFullYear();
  const thisMonth  = now.getMonth() + 1;
  const years      = availableYears();

  const [year,  setYear]  = useState(thisYear);
  const [month, setMonth] = useState(thisMonth);

  // ── Gruppierung Warengruppen-Ansicht ──
  const [productGroupMode, setProductGroupMode] = useState<'account' | 'category'>('account');

  // ── Daten ──
  const [rezepturen,    setRezepturen]    = useState<RezepturenMap>({});
  const [produkteData,  setProdukteData]  = useState<ProdukteData>({});
  const [productCosts,  setProductCosts]  = useState<ProductCostEntry[]>([]);
  const [loading,       setLoading]       = useState(true);

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

  // ── Take-Away-Produkte filtern ──
  const takeAwayRecipes = useMemo(() => {
    return Object.values(rezepturen).filter(r => r.salesChannel === 'takeaway');
  }, [rezepturen]);

  const hasTakeAwayProducts = takeAwayRecipes.length > 0;

  // ── Allokations-Totals (Ist-WES) ──
  const allocationTotals = useMemo(() => getAllocationTotals(year, month), [year, month]);
  const istWesTotal = allocationTotals.takeaway;

  // ── Produkt-Rows für den gewählten Monat ──
  const productRows = useMemo((): TakeAwayProductRow[] => {
    const monthStr  = String(month).padStart(2, '0');
    const yearMonth = `${year}-${monthStr}`;

    return takeAwayRecipes.map(recipe => {
      // Produktdaten aus produksteData
      const prodEntry: ProductEntry | undefined = produkteData[recipe.productName];
      const costEntry = productCosts.find(
        c => c.productName === recipe.productName && c.yearMonth === yearMonth,
      );

      const count    = costEntry?.portionsSold ?? 0;
      const revenue  = costEntry?.revenue      ?? 0;

      // Plankosten pro Portion aus Rezeptur
      const wes = recipe.costMode === 'pauschal'
        ? recipe.manualCost
        : recipe.costMode === 'gemischt'
          ? recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0) + recipe.manualCost
          : recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);

      const sollWes   = count * wes;
      const nettoPrice = prodEntry?.nettoPrice ?? 0;
      const wesQ      = nettoPrice > 0 ? (wes / nettoPrice) * 100 : 0;

      return {
        productName: recipe.productName,
        count,
        revenue,
        wes,
        sollWes,
        nettoPrice,
        wesQ,
      };
    });
  }, [takeAwayRecipes, produkteData, productCosts, year, month]);

  // ── Summen ──
  const totalRevenue = useMemo(() => productRows.reduce((s, r) => s + r.revenue, 0), [productRows]);
  const totalCount   = useMemo(() => productRows.reduce((s, r) => s + r.count, 0),   [productRows]);
  const sollWesTotal = useMemo(() => productRows.reduce((s, r) => s + r.sollWes, 0), [productRows]);

  const diff      = istWesTotal - sollWesTotal;
  const wesPct    = totalRevenue > 0 ? (istWesTotal / totalRevenue) * 100 : 0;
  const isOverWarn = wesPct > TAKEAWAY_WES_WARN_THRESHOLD && istWesTotal > 0;

  // ── 3-Monats-Trend ──
  const trend = useMemo((): TrendMonth[] => {
    const months3 = prevMonths(year, month, 3);
    return months3.map(({ year: y, month: m }) => {
      const ta  = getAllocationTotals(y, m);
      const ist = ta.takeaway;

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
      const amt = getDocumentAllocationAmount(doc, 'takeaway');
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
      const amt = getDocumentAllocationAmount(doc, 'takeaway');
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

  // ── Guards ──
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
    <div className="space-y-6 p-4 md:p-6 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingBag className="h-6 w-6 text-teal-600" />
            Take-Away-Analyse
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Warenkosten-Vergleich (Soll / Ist) für den Take-Away-Kanal.
            Strikt getrennt von Restaurant und Lunch.
          </p>
        </div>

        {/* Monat/Jahr-Picker */}
        <div className="flex items-center gap-2 shrink-0">
          <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)} className="text-xs">{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="w-[80px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map(y => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Hilfe */}
      <HelpSection />

      {/* WES-Warnung > 30% */}
      {isOverWarn && (
        <Alert className="border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/20">
          <AlertTriangle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-700 dark:text-red-400 font-medium">
            Take Away Marge zu tief – Preise oder Einkauf prüfen
            <span className="ml-2 text-sm font-normal opacity-80">
              (WES {pct(wesPct)} &gt; {TAKEAWAY_WES_WARN_THRESHOLD}% Schwelle)
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
            label="Umsatz (netto)"
            value={totalRevenue > 0 ? `CHF ${chf(totalRevenue)}` : '–'}
            sub="Take Away Produkte"
            teal
          />
          <KpiCard
            label="Verkaufte Einheiten"
            value={totalCount > 0 ? totalCount.toLocaleString('de-CH') : '–'}
            sub={`${takeAwayRecipes.length} Produkte konfiguriert`}
          />
          <KpiCard
            label="Soll-WES (Plan)"
            value={sollWesTotal > 0 ? `CHF ${chf(sollWesTotal)}` : '–'}
            sub="Portionen × Plankosten"
          />
          <KpiCard
            label="Ist-WES (Einkauf)"
            value={istWesTotal > 0 ? `CHF ${chf(istWesTotal)}` : '–'}
            sub="Belege Take-Away-Pool"
            warning={isOverWarn}
          />
          <KpiCard
            label="WES %"
            value={wesPct > 0 ? pct(wesPct) : '–'}
            sub={`Ziel: < ${TAKEAWAY_WES_WARN_THRESHOLD}%`}
            warning={isOverWarn}
            accent={!isOverWarn && wesPct > 0}
          />
          <KpiCard
            label="Differenz (Ist − Soll)"
            value={istWesTotal > 0 || sollWesTotal > 0 ? getDiffLabel(diff) : '–'}
            sub={diff > 0 ? 'Über Plan' : diff < 0 ? 'Unter Plan' : ''}
            warning={diff > 0 && Math.abs(diff) > 50}
          />
        </div>
      )}

      {/* Produktliste */}
      {hasTakeAwayProducts && productRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
              Take-Away-Produkte — {MONTHS[month - 1]} {year}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Alle Produkte mit Vertriebskanal «Take Away» und deren geplante Warenkosten.
            </p>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">Produkt</TableHead>
                  <TableHead className="text-xs text-right">Einheiten</TableHead>
                  <TableHead className="text-xs text-right">Umsatz CHF</TableHead>
                  <TableHead className="text-xs text-right">Plan CHF/Stk.</TableHead>
                  <TableHead className="text-xs text-right">Soll-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">WES %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productRows.map(r => (
                  <TableRow key={r.productName}>
                    <TableCell className="text-sm font-medium">{r.productName}</TableCell>
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
                    <TableCell className={cn(
                      'text-right font-mono text-sm',
                      r.wesQ > TAKEAWAY_WES_WARN_THRESHOLD ? 'text-amber-600 font-semibold' : 'text-muted-foreground',
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
              Vergleich Soll-WES vs. Ist-WES der letzten 3 Monate vor dem gewählten Monat.
              Amber = über 10% über Plan.
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
                        t.diff > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400',
                      )}>
                        {t.soll > 0 || t.ist > 0 ? (t.diff >= 0 ? `+${chf(t.diff)}` : `−${chf(Math.abs(t.diff))}`) : '–'}
                      </TableCell>
                      <TableCell className="text-right">
                        {t.ist > 0 && t.diff > 0 && (
                          <TrendingUp className="h-4 w-4 inline text-amber-500" />
                        )}
                        {t.ist > 0 && t.diff <= 0 && (
                          <TrendingDown className="h-4 w-4 inline text-green-500" />
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
              Welche Lieferanten haben den grössten Anteil am Take-Away-Ist-WES?
              Grundlage: alle Belege mit Kostenzuordnung «Take Away».
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
              <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-600" />
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
                <strong>Lieferant vs. Warengruppe:</strong> Lieferanten = <em>wer</em> liefert.
                Warengruppe = <em>was</em> eingekauft wird.
                Beim Take Away ist Konto 4701 (Betriebsmaterial / Verpackung) oft ein wichtiger Kostenblock.
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

      {/* Keine Daten, aber Produkte konfiguriert */}
      {hasTakeAwayProducts && istWesTotal === 0 && sollWesTotal === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center">
            <HelpCircle className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium text-muted-foreground">
              Keine Daten für {MONTHS[month - 1]} {year}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Noch keine Belege mit Kostenzuordnung «Take Away» erfasst oder keine Portionen
              im Tagesabschluss für diesen Monat vorhanden.
            </p>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
