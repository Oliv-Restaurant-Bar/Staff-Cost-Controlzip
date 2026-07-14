/**
 * Lunch-WES-Analyse – Mittagsmenu Kostenvergleich
 * =================================================
 * Vergleicht geplante vs. tatsächliche Warenkosten für Lunch/Mittagsmenu.
 *
 * Soll-WES  = Verkaufte Portionen × Pauschalkosten (aus Produktkalkulation)
 * Ist-WES   = Summe der Lieferantenbelege mit Kostenzuordnung zu Lunch-Pools
 *
 * Produkte werden über den Lunch-Pool in der Rezeptur zugeordnet.
 * Einkäufe werden über die Kostenzuordnung im Lieferantenbeleg zugeordnet.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Utensils, TrendingUp, TrendingDown, AlertTriangle, Info,
  ChevronRight, Package, Tag, HelpCircle, BookOpen,
  BarChart2, ArrowRight, Sparkles, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import {
  getAllocationTotals, availableYears,
  getLunchDocumentsForMonth, getDocumentAllocationAmount,
  type AllocationTotals,
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

// ─── Typen ────────────────────────────────────────────────────────────────────

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
  isHighCost: boolean;   // > HIGH_COST_THRESHOLD % of total
}

const HIGH_COST_THRESHOLD = 15; // %

// FIBU Warengruppe labels — maps account number → friendly label
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

interface TrendMonth {
  year: number;
  month: number;
  label: string;
  soll: number;
  ist: number;
  diff: number;
}

interface LunchProductRow {
  productName: string;
  pool: 'lunch_basic' | 'lunch_premium' | 'lunch_allgemein';
  count: number;
  revenue: number;
  wes: number;           // Plankosten pro Portion (aus Rezeptur/Kalkulation)
  sollWes: number;       // count × wes
  nettoPrice: number;
  wesQ: number;          // wes / nettoPrice × 100
}

interface LunchPoolSummary {
  poolLabel: string;
  products: LunchProductRow[];
  totalRevenue: number;
  totalSollWes: number;
  totalIstWes: number;
  diff: number;          // Ist − Soll
  diffPct: number;       // diff / Soll × 100
  wesRevenuePct: number; // Ist / Revenue × 100
  alert: 'over' | 'ok' | 'no_data';
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const POOL_LABELS: Record<string, string> = {
  lunch_basic:      'Lunch Basic (Menu 1)',
  lunch_premium:    'Lunch Premium (Menu 2)',
  lunch_allgemein:  'Lunch Allgemein',
};

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

// ─── Komponenten ──────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, accent = false, warning = false,
}: { label: string; value: string; sub?: string; accent?: boolean; warning?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl border p-4 space-y-1',
      warning ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30'
      : accent ? 'border-violet-300 bg-violet-50 dark:border-violet-700 dark:bg-violet-950/30'
      : 'border-border bg-card',
    )}>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn(
        'text-2xl font-bold tracking-tight',
        warning ? 'text-amber-700 dark:text-amber-400'
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
        <span className="text-sm font-medium">So funktioniert die Lunch-Analyse</span>
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
                <Utensils className="h-3.5 w-3.5 text-orange-600" />
                1. Produkte als Lunch-Produkt markieren
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Gehe zu <strong>Produkte → Kalkulation</strong> und öffne z.B. «Tagesmenu 1».
                Ganz unten im Dialog findest du den Bereich <em>Lunch-Pool</em>.
                Wähle dort «Lunch Basic» → dieses Produkt fliesst als Soll-Benchmark in diese Analyse ein.
                Tagesmenu 2 → Lunch Premium, ohne Unterscheidung → Lunch Allgemein.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Soll-WES</strong> = Portionen (aus Tagesabschluss) × Plan-WES (aus Kalkulation).
                Je mehr Portionen verkauft wurden, desto höher der erlaubte Einkauf.
              </p>
            </div>

            {/* Einkäufe zuordnen */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 text-violet-600" />
                2. Einkäufe korrekt zuordnen
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Bei jedem Lieferantenbeleg (Lieferschein oder Rechnung) gibt es das Feld
                <em> Kostenzuordnung</em>. Wähle den passenden Pool.
                Für gemischte Lieferungen (z.B. Fleisch für Lunch <em>und</em> À la carte)
                klicke «% Aufteilung» und verteile den Betrag prozentual: z.B. 60% Lunch Basic,
                40% À la carte. Die Summe muss 100% ergeben.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Ist-WES</strong> = Summe aller Belege, die einem Lunch-Pool zugeordnet sind.
              </p>
            </div>

            {/* Automatische Vorschläge */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                3. Automatische Zuordnungs-Vorschläge
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Das System merkt sich, welchem Pool du einen Lieferanten <em>am häufigsten</em> zugeordnet hast.
                Wenn du denselben Lieferanten ein drittes Mal erfasst, wird die Kostenzuordnung
                automatisch vorbelegt – du siehst darunter den Hinweis
                <em> «Vorschlag basierend auf früheren Belegen»</em>.
                Du kannst die Zuordnung jederzeit manuell ändern, der Vorschlag ist nur ein Startpunkt.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Vorschläge werden erst nach mind. 2 gleichen Zuordnungen aktiviert,
                um falsche Vorschläge bei neuen Lieferanten zu vermeiden.
              </p>
            </div>

            {/* Duplikatschutz */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
                4. Duplikatschutz (Lieferschein + Rechnung)
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Wenn du einen <strong>Lieferschein</strong> erfasst und danach die zugehörige
                <strong> Rechnung</strong> verknüpfst (via «Verknüpfen»-Button in den Belegvorschlägen),
                wird der Lieferschein automatisch aus der Ist-WES-Berechnung <em>ausgeschlossen</em>.
                Nur die Rechnung zählt. So wird kein Einkauf doppelt gezählt.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Im Belegtisch siehst du ausgeschlossene Lieferscheine
                mit dem Badge «Fakturiert (ausgeschlossen)» und durchgestrichenem Betrag.
              </p>
            </div>

            {/* Produktabweichungen lesen */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <BarChart2 className="h-3.5 w-3.5 text-blue-600" />
                5. Kostenanalyse: Lieferant vs. Warengruppe
              </h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Lieferanten-Analyse</strong> (1. Tabelle): Zeigt, <em>wer</em> die Ware liefert.
                Gut für Preisvergleiche: «Pistor AG macht 60% meiner Lunch-Einkäufe aus – gibt es günstigere Alternativen?»
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong>Warengruppen-Analyse</strong> (2. Tabelle): Zeigt, <em>was</em> eingekauft wird –
                nach FIBU-Konto (z.B. 4060 = Küche/Food, 4020 = Wein) oder nach Kategorie (Speisen/Getränke).
                Gut für Kostentreiber: «Fleisch / Küche-Food macht 45% aus – dort ansetzen!»
                Einträge über {HIGH_COST_THRESHOLD}% sind amber markiert als «Hoher Kostenanteil – prüfen».
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Der <em>Trend der letzten 3 Monate</em> zeigt, ob Soll und Ist sich angleichen
                oder ob die Abweichung wächst. Grün = unter Plan, Amber = über 10% Überschreitung.
              </p>
            </div>

            {/* Was testen */}
            <div className="space-y-1.5">
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                6. Was soll ich zuerst testen?
              </h4>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal ml-4">
                <li>Tagesmenu 1 → <strong>Produkte → Kalkulation</strong> → Lunch-Pool = «Lunch Basic» setzen.</li>
                <li>Einen Lieferschein von Pistor AG erfassen → Kostenzuordnung «Lunch Basic».</li>
                <li>Denselben Lieferanten nochmals erfassen → System schlägt «Lunch Basic» automatisch vor.</li>
                <li>Eine Rechnung für denselben Lieferschein erfassen und verknüpfen → Lieferschein wird ausgeschlossen.</li>
                <li>Hier prüfen: Ist der Ist-WES höher als der Soll-WES? Falls ja, Kalkulation anpassen.</li>
              </ol>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function LunchAnalysePage() {
  const { canAccessModule } = usePermissions();

  const currentDate = new Date();
  const [year,  setYear]  = useState(currentDate.getFullYear());
  const [month, setMonth] = useState(currentDate.getMonth() + 1);

  const [recipes,   setRecipes]   = useState<RezepturenMap>({});
  const [prodData,  setProdData]  = useState<ProdukteData | null>(null);
  const [costs,     setCosts]     = useState<ProductCostEntry[]>([]);
  const [alloc,     setAlloc]     = useState<AllocationTotals | null>(null);
  const [lunchDocs, setLunchDocs] = useState<SupplierDocument[]>([]);
  const [loading,   setLoading]   = useState(true);

  const years = availableYears();

  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadRezepturenFromDB(),
      loadProdukteDataFromDB(),
    ]).then(([r, p]) => {
      setRecipes(r);
      setProdData(p);
      setCosts(loadProductCosts());
      setAlloc(getAllocationTotals(year, month));
      setLunchDocs(getLunchDocumentsForMonth(year, month));
      setLoading(false);
    }).catch(() => {
      setCosts(loadProductCosts());
      setAlloc(getAllocationTotals(year, month));
      setLunchDocs(getLunchDocumentsForMonth(year, month));
      setLoading(false);
    });
  }, [year, month]);

  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  // ── Lunch-Produkte aus Rezepturen ──────────────────────────────────────────
  const lunchRecipes: ProductRecipe[] = useMemo(
    () => Object.values(recipes).filter(r => r.lunchPool != null),
    [recipes],
  );

  // ── Produktdaten für diesen Monat ─────────────────────────────────────────
  const monthEntries: ProductEntry[] = useMemo(() => {
    if (!prodData) return [];
    return prodData.entries.filter(e => e.month === monthKey);
  }, [prodData, monthKey]);

  // ── Berechnung: Produkt-Zeilen ─────────────────────────────────────────────
  const productRows: LunchProductRow[] = useMemo(() => {
    return lunchRecipes.map(recipe => {
      const pool = recipe.lunchPool!;
      const entry = monthEntries.find(
        e => e.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase(),
      );
      const costEntry = costs.find(
        c => c.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase(),
      );

      const count   = entry?.count   ?? 0;
      const revenue = entry?.revenue ?? 0;
      const wes     = costEntry?.wes ?? recipe.manualCost ?? 0;
      const nettoPrice = costEntry?.nettoPrice ?? (costEntry?.bruttoPrice ?? 0) * 0.923;

      return {
        productName: recipe.productName,
        pool,
        count,
        revenue,
        wes,
        sollWes: count * wes,
        nettoPrice,
        wesQ: nettoPrice > 0 ? (wes / nettoPrice) * 100 : 0,
      };
    });
  }, [lunchRecipes, monthEntries, costs]);

  // ── Pool-Summaries ─────────────────────────────────────────────────────────
  const poolSummaries: LunchPoolSummary[] = useMemo(() => {
    if (!alloc) return [];
    const pools: ('lunch_basic' | 'lunch_premium' | 'lunch_allgemein')[] = [
      'lunch_basic', 'lunch_premium', 'lunch_allgemein',
    ];
    return pools.map(pool => {
      const products = productRows.filter(r => r.pool === pool);
      if (products.length === 0) return null;

      const totalRevenue  = products.reduce((s, r) => s + r.revenue,  0);
      const totalSollWes  = products.reduce((s, r) => s + r.sollWes,  0);
      const totalIstWes   = pool === 'lunch_allgemein'
        ? alloc.lunch_basic + alloc.lunch_premium  // grouped
        : alloc[pool as keyof AllocationTotals] as number;

      const diff          = totalIstWes - totalSollWes;
      const diffPct       = totalSollWes > 0 ? (diff / totalSollWes) * 100 : 0;
      const wesRevenuePct = totalRevenue > 0 ? (totalIstWes / totalRevenue) * 100 : 0;

      const alert = totalIstWes === 0 && totalSollWes === 0 ? 'no_data'
        : diff > 0 && diffPct > 10 ? 'over'
        : 'ok';

      return {
        poolLabel: POOL_LABELS[pool],
        products,
        totalRevenue,
        totalSollWes,
        totalIstWes,
        diff,
        diffPct,
        wesRevenuePct,
        alert,
      } satisfies LunchPoolSummary;
    }).filter((s): s is LunchPoolSummary => s !== null);
  }, [productRows, alloc]);

  // ── Gesamtübersicht ───────────────────────────────────────────────────────
  const totalRevenue  = productRows.reduce((s, r) => s + r.revenue,  0);
  const totalSollWes  = productRows.reduce((s, r) => s + r.sollWes,  0);
  const totalIstWes   = alloc ? alloc.lunch_total : 0;
  const totalDiff     = totalIstWes - totalSollWes;
  const totalDiffPct  = totalSollWes > 0 ? (totalDiff / totalSollWes) * 100 : 0;
  const totalWesRevPct = totalRevenue > 0 ? (totalIstWes / totalRevenue) * 100 : 0;

  const hasOverrun = poolSummaries.some(p => p.alert === 'over');
  const hasLunchProducts = lunchRecipes.length > 0;
  const hasIstData = totalIstWes > 0;

  // ── Top-Kostenträger (Lieferanten mit Lunch-Belegen) ─────────────────────
  const costDriverRows: CostDriverRow[] = useMemo(() => {
    if (lunchDocs.length === 0) return [];

    const bySupplier: Record<string, { amount: number; count: number }> = {};
    for (const doc of lunchDocs) {
      const lunchAmt = (
        getDocumentAllocationAmount(doc, 'lunch_basic') +
        getDocumentAllocationAmount(doc, 'lunch_premium')
      );
      if (lunchAmt === 0) continue;
      if (!bySupplier[doc.supplier]) bySupplier[doc.supplier] = { amount: 0, count: 0 };
      bySupplier[doc.supplier].amount += lunchAmt;
      bySupplier[doc.supplier].count  += 1;
    }

    const total = Object.values(bySupplier).reduce((s, v) => s + v.amount, 0);
    return Object.entries(bySupplier)
      .map(([supplier, { amount, count }]) => ({
        supplier,
        amount,
        pctOfTotal: total > 0 ? (amount / total) * 100 : 0,
        docCount: count,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
  }, [lunchDocs]);

  // ── Produkt-Gruppen (nach Warengruppe / Kategorie) ───────────────────────
  const [productGroupMode, setProductGroupMode] = useState<'account' | 'category'>('account');

  const productGroupRows: ProductGroupRow[] = useMemo(() => {
    if (lunchDocs.length === 0) return [];

    const byKey: Record<string, { label: string; amount: number; count: number }> = {};

    for (const doc of lunchDocs) {
      const lunchAmt = (
        getDocumentAllocationAmount(doc, 'lunch_basic') +
        getDocumentAllocationAmount(doc, 'lunch_premium')
      );
      if (lunchAmt === 0) continue;

      let key: string;
      let label: string;

      if (productGroupMode === 'account') {
        key   = doc.accountNumber ?? '__none__';
        label = doc.accountNumber
          ? (FIBU_WARENGRUPPEN[doc.accountNumber] ?? `Konto ${doc.accountNumber}`)
          : 'Kein Konto zugewiesen';
      } else {
        key   = doc.category;
        label = CATEGORY_LABELS_LOCAL[doc.category] ?? doc.category;
      }

      if (!byKey[key]) byKey[key] = { label, amount: 0, count: 0 };
      byKey[key].amount += lunchAmt;
      byKey[key].count  += 1;
    }

    const total = Object.values(byKey).reduce((s, v) => s + v.amount, 0);
    return Object.entries(byKey)
      .map(([key, { label, amount, count }]) => ({
        key,
        label,
        amount,
        pctOfTotal: total > 0 ? (amount / total) * 100 : 0,
        docCount: count,
        isHighCost: total > 0 ? (amount / total) * 100 > HIGH_COST_THRESHOLD : false,
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [lunchDocs, productGroupMode]);

  // ── 3-Monats-Trend ────────────────────────────────────────────────────────
  const trend3: TrendMonth[] = useMemo(() => {
    const result: TrendMonth[] = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(year, month - 1 - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const a = getAllocationTotals(y, m);
      const entries = prodData?.entries.filter(e => e.month === key) ?? [];
      const soll = lunchRecipes.reduce((s, recipe) => {
        const entry = entries.find(e => e.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase());
        const cost  = costs.find(c  => c.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase());
        return s + (entry?.count ?? 0) * (cost?.wes ?? recipe.manualCost ?? 0);
      }, 0);
      result.push({ year: y, month: m, label: `${MONTHS[m - 1]} ${y}`, soll, ist: a.lunch_total, diff: a.lunch_total - soll });
    }
    return result;
  }, [year, month, prodData, lunchRecipes, costs]);

  // ── Konsistenz-Warnung: zu viele nicht zugeordnete Belege ────────────────
  const consistencyWarning = useMemo(() => {
    if (!alloc) return false;
    const allocatable = (
      alloc.lunch_basic + alloc.lunch_premium + alloc.a_la_carte +
      alloc.pizza + alloc.dessert + alloc.kinder +
      alloc.kueche_allgemein + alloc.beverage + alloc.unassigned
    );
    return allocatable > 0 && (alloc.unassigned / allocatable) > 0.20;
  }, [alloc]);

  if (!canAccessModule('dashboard')) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground text-sm">Kein Zugriff auf diese Seite.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Utensils className="h-6 w-6 text-orange-600" />
            Lunch-WES-Analyse
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Geplanter vs. tatsächlicher Wareneinsatz Mittagsmenu
          </p>
        </div>

        {/* Monats-Wähler */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="w-24 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Hilfe */}
      <HelpSection />

      {/* Setup-Hinweise wenn noch nichts konfiguriert */}
      {!hasLunchProducts && (
        <Alert className="border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/30">
          <Info className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-sm text-blue-800 dark:text-blue-300">
            <strong>Noch kein Lunch-Produkt konfiguriert.</strong>{' '}
            Gehe zu{' '}
            <Link to="/produkte" className="underline font-medium">Produkte → Kalkulation</Link>
            {' '}und setze bei Tagesmenu 1 / Tagesmenu 2 den <strong>Lunch-Pool</strong>.
          </AlertDescription>
        </Alert>
      )}

      {hasLunchProducts && !hasIstData && (
        <Alert className="border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertDescription className="text-sm text-amber-800 dark:text-amber-300">
            <strong>Noch keine Einkäufe dem Lunch zugeordnet.</strong>{' '}
            Bei der Erfassung von Lieferantenbelegen unter{' '}
            <Link to="/lieferanten" className="underline font-medium">Lieferanten</Link>
            {' '}die <strong>Kostenzuordnung</strong> auf «Lunch Basic» oder «Lunch Premium» setzen.
          </AlertDescription>
        </Alert>
      )}

      {/* Überlauf-Warnung */}
      {hasOverrun && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-3 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Mittagsmenu-Einkauf liegt über der Kalkulation
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Tatsächlicher WES &gt; 10% über dem geplanten Soll-WES.
              Mögliche Ursachen: Pauschale zu tief kalkuliert, Portionsgrössen zu gross,
              Einkaufspreise gestiegen oder zu viele Einkäufe dem Lunch zugeordnet.
            </p>
            <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc ml-4 space-y-0.5">
              <li>Menu Pauschale vermutlich zu tief → in Produkte anpassen</li>
              <li>Portionen / Einkauf prüfen → Tagesabschlüsse kontrollieren</li>
              <li>Einkauf korrekt zugeordnet? → Lieferantenbelege prüfen</li>
            </ul>
          </div>
        </div>
      )}

      {/* Konsistenz-Warnung: zu viele nicht zugeordnete Einkäufe */}
      {consistencyWarning && (
        <div className="rounded-xl border border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/30 px-4 py-3 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-800 dark:text-red-300">
              Viele Einkäufe sind nicht korrekt zugeordnet
            </p>
            <p className="text-xs text-red-700 dark:text-red-400">
              Mehr als 20% der erfassten Einkäufe sind dem Pool «Nicht zugeordnet» zugewiesen.
              Die Lunch-Auswertung könnte verfälscht sein, weil effektive Lunch-Kosten fehlen.
            </p>
            <p className="text-xs text-red-700 dark:text-red-400">
              <strong>Was tun?</strong> Gehe zu{' '}
              <Link to="/lieferanten" className="underline font-medium">Lieferanten</Link>
              {' '}und weise jedem Beleg eine Kostenzuordnung (z.B. «Lunch Basic») zu.
            </p>
          </div>
        </div>
      )}

      {/* KPI-Übersicht */}
      {hasLunchProducts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Lunch-Umsatz"
            value={`CHF ${chf(totalRevenue)}`}
            sub={`${MONTHS[month - 1]} ${year}`}
          />
          <KpiCard
            label="Soll-WES"
            value={`CHF ${chf(totalSollWes)}`}
            sub={totalRevenue > 0 ? `${pct((totalSollWes / totalRevenue) * 100)} vom Umsatz` : 'Keine Umsatzdaten'}
          />
          <KpiCard
            label="Ist-WES"
            value={`CHF ${chf(totalIstWes)}`}
            sub={totalRevenue > 0 ? `${pct(totalWesRevPct)} vom Umsatz` : 'Aus Lieferantenbelegen'}
            accent={!hasOverrun}
            warning={hasOverrun}
          />
          <KpiCard
            label="Abweichung"
            value={totalDiff === 0 ? '–' : `${totalDiff > 0 ? '+' : ''}CHF ${chf(totalDiff)}`}
            sub={totalSollWes > 0 ? `${totalDiff > 0 ? '+' : ''}${pct(totalDiffPct)} vs. Soll` : ''}
            warning={totalDiff > 0 && totalDiffPct > 10}
          />
        </div>
      )}

      {/* 3-Monats-Trend */}
      {hasLunchProducts && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" />
              Trend der letzten 3 Monate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">Monat</TableHead>
                  <TableHead className="text-xs text-right">Soll-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">Ist-WES CHF</TableHead>
                  <TableHead className="text-xs text-right">Abweichung CHF</TableHead>
                  <TableHead className="text-xs text-right">Abw. %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trend3.map(t => {
                  const diffPct = t.soll > 0 ? (t.diff / t.soll) * 100 : null;
                  const isCurrentMonth = t.year === year && t.month === month;
                  const isOver = t.diff > 0 && (diffPct ?? 0) > 10;
                  return (
                    <TableRow key={t.label} className={isCurrentMonth ? 'bg-orange-50/40 dark:bg-orange-950/10 font-semibold' : ''}>
                      <TableCell className="text-sm flex items-center gap-1.5">
                        {t.label}
                        {isCurrentMonth && (
                          <span className="text-[9px] bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border border-orange-200 dark:border-orange-800 px-1 py-0.5 rounded font-medium">aktuell</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {t.soll === 0 ? <span className="text-muted-foreground">—</span> : chf(t.soll)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {t.ist === 0 ? <span className="text-muted-foreground">—</span> : chf(t.ist)}
                      </TableCell>
                      <TableCell className={cn('text-right font-mono text-sm', isOver ? 'text-amber-700 dark:text-amber-400' : t.diff < 0 ? 'text-green-700 dark:text-green-400' : '')}>
                        {t.diff === 0 ? '—' : `${t.diff > 0 ? '+' : ''}${chf(Math.abs(t.diff))}`}
                      </TableCell>
                      <TableCell className={cn('text-right text-sm', isOver ? 'text-amber-700 dark:text-amber-400' : t.diff < 0 ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground')}>
                        {diffPct == null ? '—' : `${t.diff > 0 ? '+' : ''}${pct(diffPct)}`}
                        {isOver && <AlertTriangle className="inline h-3 w-3 ml-1 text-amber-500" />}
                        {t.diff < 0 && <TrendingDown className="inline h-3 w-3 ml-1 text-green-600" />}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="text-[10px] text-muted-foreground mt-2 px-1">
              Grün = Ist unter Soll (gut) · Amber = Ist mehr als 10% über Soll (Achtung) · — = keine Daten
            </p>
          </CardContent>
        </Card>
      )}

      {/* Pool-Detailansicht */}
      {poolSummaries.map(summary => (
        <Card key={summary.poolLabel} className={cn(
          summary.alert === 'over' && 'border-amber-300 dark:border-amber-700',
        )}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Utensils className="h-4 w-4 text-orange-600" />
                {summary.poolLabel}
              </CardTitle>
              {summary.alert === 'over' && (
                <Badge className="bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Über Kalkulation
                </Badge>
              )}
              {summary.alert === 'ok' && summary.totalIstWes > 0 && (
                <Badge className="bg-green-100 text-green-800 border border-green-300 dark:bg-green-900/30 dark:text-green-400">
                  Im Plan
                </Badge>
              )}
              {summary.alert === 'no_data' && (
                <Badge variant="outline" className="text-muted-foreground">
                  Keine Daten
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Pool-KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg bg-muted/30 border px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Umsatz</p>
                <p className="text-lg font-bold">CHF {chf(summary.totalRevenue)}</p>
              </div>
              <div className="rounded-lg bg-muted/30 border px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Soll-WES</p>
                <p className="text-lg font-bold">CHF {chf(summary.totalSollWes)}</p>
                {summary.totalRevenue > 0 && (
                  <p className="text-[10px] text-muted-foreground">{pct((summary.totalSollWes / summary.totalRevenue) * 100)} vom Umsatz</p>
                )}
              </div>
              <div className={cn(
                'rounded-lg border px-3 py-2',
                summary.alert === 'over'
                  ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-700'
                  : 'bg-muted/30',
              )}>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Ist-WES</p>
                <p className="text-lg font-bold">CHF {chf(summary.totalIstWes)}</p>
                {summary.totalRevenue > 0 && (
                  <p className="text-[10px] text-muted-foreground">{pct(summary.wesRevenuePct)} vom Umsatz</p>
                )}
              </div>
              <div className={cn(
                'rounded-lg border px-3 py-2',
                summary.diff > 0 && summary.diffPct > 10
                  ? 'bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-700'
                  : summary.diff < 0 ? 'bg-green-50 border-green-300 dark:bg-green-950/30 dark:border-green-700'
                  : 'bg-muted/30',
              )}>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Abweichung</p>
                <p className={cn(
                  'text-lg font-bold',
                  summary.diff > 0 ? 'text-amber-700 dark:text-amber-400'
                  : summary.diff < 0 ? 'text-green-700 dark:text-green-400'
                  : '',
                )}>
                  {summary.diff === 0 ? '–' : `${summary.diff > 0 ? '+' : ''}CHF ${chf(Math.abs(summary.diff))}`}
                </p>
                {summary.totalSollWes > 0 && summary.diff !== 0 && (
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    {summary.diff > 0
                      ? <TrendingUp className="h-2.5 w-2.5 text-amber-600" />
                      : <TrendingDown className="h-2.5 w-2.5 text-green-600" />
                    }
                    {summary.diff > 0 ? '+' : ''}{pct(summary.diffPct)} vs. Soll
                  </p>
                )}
              </div>
            </div>

            {/* Produkt-Tabelle */}
            {summary.products.length > 0 && (
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="text-xs">Produkt</TableHead>
                      <TableHead className="text-xs text-right">Portionen</TableHead>
                      <TableHead className="text-xs text-right">Umsatz CHF</TableHead>
                      <TableHead className="text-xs text-right">Plan-WES/St.</TableHead>
                      <TableHead className="text-xs text-right">Soll-WES CHF</TableHead>
                      <TableHead className="text-xs text-right">WES-Q %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.products.map(row => (
                      <TableRow key={row.productName}>
                        <TableCell className="text-sm font-medium">
                          {row.productName}
                          {row.count === 0 && (
                            <span className="ml-2 text-[10px] text-muted-foreground italic">keine Verkaufsdaten</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.count === 0 ? '—' : row.count.toLocaleString('de-CH')}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.revenue === 0 ? '—' : chf(row.revenue)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.wes === 0 ? '—' : chf(row.wes)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono font-semibold">
                          {row.sollWes === 0 ? '—' : chf(row.sollWes)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-mono">
                          {row.wesQ === 0 ? '—' : pct(row.wesQ)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Ist-WES Herkunft */}
            <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/10 px-3 py-2 flex items-start gap-2 text-xs text-muted-foreground">
              <Tag className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                <strong>Ist-WES CHF {chf(summary.totalIstWes)}</strong>
                {' '}= Summe aller Lieferantenbelege für «{summary.poolLabel}» im {MONTHS[month - 1]} {year}.
                {summary.totalIstWes === 0 && (
                  <> Noch keine Belege diesem Pool zugeordnet. Belege erfassen unter{' '}
                    <Link to="/lieferanten" className="underline">Lieferanten</Link>.
                  </>
                )}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Top-Kostenträger */}
      {costDriverRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              Top-Kostenträger Lunch — {MONTHS[month - 1]} {year}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Welche Lieferanten verursachen die höchsten Lunch-Einkaufskosten?
              Belege die einem Lunch-Pool zugeordnet sind, nach Lieferant summiert.
              Verknüpfte Lieferscheine (fakturiert) werden nicht doppelt gezählt.
            </p>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30">
                  <TableHead className="text-xs">#</TableHead>
                  <TableHead className="text-xs">Lieferant</TableHead>
                  <TableHead className="text-xs text-right">Belege</TableHead>
                  <TableHead className="text-xs text-right">Lunch-Anteil CHF</TableHead>
                  <TableHead className="text-xs text-right">Anteil %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costDriverRows.map((row, idx) => (
                  <TableRow key={row.supplier}>
                    <TableCell className="text-xs text-muted-foreground w-8">{idx + 1}</TableCell>
                    <TableCell className="text-sm font-medium">{row.supplier}</TableCell>
                    <TableCell className="text-right text-sm font-mono text-muted-foreground">{row.docCount}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">{chf(row.amount)}</TableCell>
                    <TableCell className="text-right text-sm">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-orange-400 dark:bg-orange-500 rounded-full"
                            style={{ width: `${Math.min(row.pctOfTotal, 100)}%` }}
                          />
                        </div>
                        <span className="font-mono text-muted-foreground w-10 text-right">{pct(row.pctOfTotal)}</span>
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

      {/* Top-Kostenträger – Warengruppen (Produkt-Ebene) */}
      {productGroupRows.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between flex-wrap gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                Top-Kostenträger – Warengruppen — {MONTHS[month - 1]} {year}
              </CardTitle>
              {/* Gruppierung umschalten */}
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
                ? 'Gruppierung nach FIBU-Konto (Warengruppe). Belege ohne Kontovergabe erscheinen unter «Kein Konto zugewiesen».'
                : 'Gruppierung nach Belegkategorie (Speisen / Getränke / Sonstiges).'
              }
              {' '}Einträge über {HIGH_COST_THRESHOLD}% Anteil sind amber markiert – hier lohnt es sich nachzuschauen.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">

            {/* Erklärung Unterschied Lieferant vs. Warengruppe */}
            <div className="rounded-lg border border-dashed border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/10 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600" />
              <span>
                <strong>Lieferant vs. Warengruppe:</strong> Die Lieferanten-Ansicht zeigt,
                <em> wer</em> die Ware liefert. Diese Ansicht zeigt,{' '}
                <em>was</em> eingekauft wird (z.B. Küche/Food = 4060).
                Wenn ein einzelner Lieferant viele verschiedene Produkte liefert,
                siehst du hier trotzdem die Warengruppe getrennt.
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
                  <TableHead className="text-xs text-right">Lunch-Anteil CHF</TableHead>
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
                              row.isHighCost ? 'bg-amber-500' : 'bg-orange-400 dark:bg-orange-500',
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
                          Hoher Kostenanteil – prüfen
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <p className="text-[10px] text-muted-foreground px-1">
              Amber-Markierung bei mehr als {HIGH_COST_THRESHOLD}% Anteil.
              {' '}Um eine detailliertere Produktuntergliederung zu erhalten (z.B. Fleisch, Gemüse, Fisch),
              trage im Feld <em>Notiz</em> eines Lieferantenbelegs den Produktnamen ein und
              weise dem Beleg das spezifische FIBU-Konto zu.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Wenn keine Lunch-Produkte konfiguriert */}
      {!hasLunchProducts && !loading && (
        <Card>
          <CardContent className="py-14 text-center">
            <Package className="h-12 w-12 mx-auto mb-3 opacity-25" />
            <p className="text-sm font-medium text-muted-foreground">
              Noch keine Lunch-Produkte konfiguriert
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Gehe zu{' '}
              <Link to="/produkte" className="underline text-violet-600">Produkte → Kalkulation</Link>
              {' '}und weise Tagesmenu-Produkten einen <strong>Lunch-Pool</strong> zu.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tabelle: Alle Kostenpools auf einen Blick */}
      {alloc && hasIstData && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Kostenpools Übersicht – {MONTHS[month - 1]} {year}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kostenpool</TableHead>
                  <TableHead className="text-right">Ist-WES CHF</TableHead>
                  <TableHead className="text-right">Anteil %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {([
                  ['Lunch Basic (Menu 1)',      alloc.lunch_basic],
                  ['Lunch Premium (Menu 2)',    alloc.lunch_premium],
                  ['À la carte',               alloc.a_la_carte],
                  ['Pizza',                    alloc.pizza],
                  ['Dessert',                  alloc.dessert],
                  ['Kindermenu',               alloc.kinder],
                  ['Allg. Küche / Mise en place', alloc.kueche_allgemein],
                  ['Getränke',                 alloc.beverage],
                  ['Nicht zugeordnet',         alloc.unassigned],
                ] as [string, number][]).filter(([, v]) => v > 0).map(([label, value]) => {
                  const grandTotal = Object.values(alloc).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) - alloc.lunch_total;
                  const correctedTotal = grandTotal + alloc.lunch_total;
                  const isLunch = label.startsWith('Lunch');
                  return (
                    <TableRow key={label} className={isLunch ? 'bg-orange-50/50 dark:bg-orange-950/10' : ''}>
                      <TableCell className="text-sm flex items-center gap-2">
                        {isLunch && <Utensils className="h-3.5 w-3.5 text-orange-600" />}
                        {label}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{chf(value)}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {correctedTotal > 0 ? pct((value / correctedTotal) * 100) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
