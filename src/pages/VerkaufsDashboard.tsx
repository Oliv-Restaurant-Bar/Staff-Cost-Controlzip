/**
 * VerkaufsDashboard – Produktumsatz & KPI Übersicht
 * ===================================================
 * Lädt product_sales + products-Tabelle parallel.
 * Aggregation nach Kategorie aus products.category.
 * Quelle (source) bleibt als Filter, nicht als Hauptkategorie.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Package, TrendingUp, TrendingDown,
  Star, DollarSign, ShoppingCart,
  AlertTriangle, RefreshCw, Filter, Archive, Info, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import {
  loadProductSalesRows,
  loadAltbestandCount,
  sourceLabel,
  type ProductSalesRow,
} from '@/lib/sales-db';

// ─── Typen ────────────────────────────────────────────────────────────────────

type ProductCategoryMap = Record<string, string>;

type DashKpis = {
  total_products: number;
  total_revenue:  number;
  total_qty:      number;
};

type DashCategory = {
  category:       string;
  total_products: number;
  total_qty:      number;
  total_revenue:  number;
};

type DashProduct = {
  product_name:  string;
  category:      string;
  source:        string | null;
  total_qty:     number;
  total_revenue: number;
};

// ─── Formatierung ─────────────────────────────────────────────────────────────

function fmtChf(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '–';
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

const CATEGORY_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
];

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, icon: Icon, sub, color = 'default',
}: {
  label: string;
  value: string;
  icon: React.FC<{ className?: string }>;
  sub?: string;
  color?: 'default' | 'green' | 'amber' | 'red' | 'violet' | 'muted';
}) {
  const colorMap = {
    default: 'text-primary',
    green:   'text-emerald-600 dark:text-emerald-400',
    amber:   'text-amber-600 dark:text-amber-400',
    red:     'text-red-600 dark:text-red-400',
    violet:  'text-violet-600 dark:text-violet-400',
    muted:   'text-muted-foreground',
  };
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${colorMap[color]}`}>{value}</p>
            {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className="rounded-lg bg-muted/60 p-2.5 shrink-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregateAll(
  rows: ProductSalesRow[],
  productCategoryMap: ProductCategoryMap,
  topLimit: number,
) {
  const allProducts  = new Set<string>();
  const mappedNames  = new Set<string>();
  const unknownNames = new Set<string>();

  const catAgg     = new Map<string, DashCategory>();
  const prodMap    = new Map<string, DashProduct>();
  const prodPerCat = new Map<string, Set<string>>();

  let totalQty = 0;
  let totalRevenue = 0;

  for (const row of rows) {
    const qty = Number(row.quantity ?? 0);
    const rev = Number(row.revenue  ?? 0);

    // 3. Kategorie per Mapping ermitteln (exakter name-Lookup)
    const mappedCategory: string = productCategoryMap[row.product_name] || 'Unbekannt';

    if (row.product_name) {
      allProducts.add(row.product_name);
      if (mappedCategory !== 'Unbekannt') mappedNames.add(row.product_name);
      else                                unknownNames.add(row.product_name);
    }

    totalQty     += qty;
    totalRevenue += rev;

    // Kategorie-Aggregation
    if (!catAgg.has(mappedCategory)) {
      catAgg.set(mappedCategory, {
        category: mappedCategory, total_products: 0, total_qty: 0, total_revenue: 0,
      });
    }
    const catEntry = catAgg.get(mappedCategory)!;
    catEntry.total_qty     += qty;
    catEntry.total_revenue += rev;

    // Distinct Produkte pro Kategorie
    if (row.product_name) {
      if (!prodPerCat.has(mappedCategory)) prodPerCat.set(mappedCategory, new Set());
      prodPerCat.get(mappedCategory)!.add(row.product_name);
    }

    // Produkt-Aggregation
    const pKey = row.product_name ?? '(unbekannt)';
    if (!prodMap.has(pKey)) {
      prodMap.set(pKey, {
        product_name: pKey,
        category:     mappedCategory,
        source:       row.source,
        total_qty:    0,
        total_revenue: 0,
      });
    }
    const p = prodMap.get(pKey)!;
    p.total_qty     += qty;
    p.total_revenue += rev;
  }

  // Distinct Produktanzahl pro Kategorie
  for (const [cat, entry] of catAgg) {
    entry.total_products = prodPerCat.get(cat)?.size ?? 0;
  }

  // Bekannte Kategorien zuerst, Unbekannt ans Ende
  const categories = Array.from(catAgg.values()).sort((a, b) => {
    if (a.category === 'Unbekannt') return 1;
    if (b.category === 'Unbekannt') return -1;
    return b.total_revenue - a.total_revenue;
  });

  const topProducts = Array.from(prodMap.values())
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, topLimit);

  const kpis: DashKpis = {
    total_products: allProducts.size,
    total_revenue:  totalRevenue,
    total_qty:      totalQty,
  };

  return {
    kpis,
    categories,
    topProducts,
    mappedCount:   mappedNames.size,
    unknownCount:  unknownNames.size,
  };
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function VerkaufsDashboard() {
  const [loading,            setLoading]            = useState(true);
  const [dbError,            setDbError]            = useState<string | null>(null);
  const [rawRows,            setRawRows]            = useState<ProductSalesRow[]>([]);
  const [altbestandCount,    setAltbestandCount]    = useState<number>(0);
  const [productCategoryMap, setProductCategoryMap] = useState<ProductCategoryMap>({});
  const [productsLoaded,     setProductsLoaded]     = useState<number>(0);
  const [srcFilter,          setSrcFilter]          = useState<string>('all');
  const [batchFilter,        setBatchFilter]        = useState<string>('all');
  const [topSearch,          setTopSearch]          = useState('');

  const load = async () => {
    setLoading(true);
    setDbError(null);
    try {
      // 1. Alle drei Abfragen parallel
      const [rows, altCount, productsResult] = await Promise.all([
        loadProductSalesRows(),
        loadAltbestandCount(),
        // 1. products laden
        supabase.from('products').select('name, category'),
      ]);

      setRawRows(rows);
      setAltbestandCount(altCount);

      // 2. Mapping bauen: { [name]: category }
      const products = productsResult.data || [];
      const map = Object.fromEntries(
        products.map((p: { name: string; category: string }) => [p.name, p.category])
      );
      setProductCategoryMap(map);
      setProductsLoaded(products.length);

      if (productsResult.error) {
        console.warn('[DASHBOARD] products-Tabelle Fehler:', productsResult.error.message);
      } else {
        console.log('[DASHBOARD] products geladen:', products.length, 'Einträge');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VerkaufsDashboard] load error:', msg);
      setDbError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Filter-Optionen ─────────────────────────────────────────────────────────

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.source ?? '__null__');
    return Array.from(set).sort();
  }, [rawRows]);

  const availableBatches = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) if (r.import_batch) set.add(r.import_batch);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [rawRows]);

  // ── Gefilterte Zeilen ──────────────────────────────────────────────────────

  const filteredRows = useMemo(() => {
    let rows = rawRows;
    if (srcFilter !== 'all') {
      const matchNull = srcFilter === '__null__';
      rows = rows.filter(r => matchNull ? !r.source : r.source === srcFilter);
    }
    if (batchFilter !== 'all') {
      rows = rows.filter(r => r.import_batch === batchFilter);
    }
    return rows;
  }, [rawRows, srcFilter, batchFilter]);

  // ── Aggregation ─────────────────────────────────────────────────────────────

  const { kpis, categories, topProducts, mappedCount, unknownCount } = useMemo(
    () => aggregateAll(filteredRows, productCategoryMap, 50),
    [filteredRows, productCategoryMap],
  );

  const noData = !dbError && filteredRows.length === 0;

  // ── Suche ──────────────────────────────────────────────────────────────────

  const filteredTop = useMemo(() =>
    topProducts.filter(p =>
      p.product_name.toLowerCase().includes(topSearch.toLowerCase()) ||
      p.category.toLowerCase().includes(topSearch.toLowerCase())
    ), [topProducts, topSearch]);

  // ── Skeleton ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-7 w-48 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-64 rounded-lg bg-muted animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-violet-100 dark:bg-violet-950/40 p-2">
            <TrendingUp className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Verkaufs-Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Produktumsatz nach Kategorie
              {rawRows.length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground/70">
                  ({fmtNum(rawRows.length)} Datensätze)
                </span>
              )}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Aktualisieren
        </Button>
      </div>

      {/* ── DB-Fehler ─────────────────────────────────────────────────────────── */}
      {dbError && (
        <Card className="border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30">
          <CardContent className="py-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <div className="space-y-1 min-w-0">
                <p className="font-semibold text-red-700 dark:text-red-400">Datenbankfehler beim Laden</p>
                <p className="text-sm text-red-600 dark:text-red-300 font-mono break-all">{dbError}</p>
                <Button size="sm" variant="outline" onClick={load} className="mt-2">Nochmals versuchen</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Altbestand-Info ───────────────────────────────────────────────────── */}
      {altbestandCount > 0 && (
        <Card className="border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3">
              <Archive className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-sm text-amber-700 dark:text-amber-400 flex-1">
                <strong className="text-amber-800 dark:text-amber-300">Altbestand:</strong>{' '}
                {fmtNum(altbestandCount)} Datensätze ohne Quellangabe werden nicht angezeigt.
              </span>
              <Badge variant="outline" className="shrink-0 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400">
                {fmtNum(rawRows.length)} sauber / {fmtNum(rawRows.length + altbestandCount)} total
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Mapping-Status ────────────────────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card className="border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/40 dark:bg-emerald-950/10">
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                    {fmtNum(mappedCount)} Produkte gemappt
                  </p>
                  <p className="text-xs text-emerald-700/70 dark:text-emerald-400/70">
                    aus {fmtNum(productsLoaded)} Einträgen in products-Tabelle
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={unknownCount > 0 ? 'border-amber-200 dark:border-amber-800/50 bg-amber-50/40 dark:bg-amber-950/10' : ''}>
            <CardContent className="py-3 px-4">
              <div className="flex items-center gap-3">
                <Info className={`h-4 w-4 shrink-0 ${unknownCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`} />
                <div className="min-w-0">
                  <p className={`text-sm font-semibold ${unknownCount > 0 ? 'text-amber-800 dark:text-amber-300' : 'text-foreground'}`}>
                    {fmtNum(unknownCount)} Produkte ohne Kategorie
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {unknownCount === 0
                      ? 'Alle Produkte sind gemappt'
                      : 'Name in products-Tabelle nicht gefunden → «Unbekannt»'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Keine Daten ──────────────────────────────────────────────────────── */}
      {noData && (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">
              {rawRows.length > 0 ? 'Keine Daten für die gewählten Filter' : 'Noch keine Verkaufsdaten vorhanden'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {rawRows.length > 0
                ? 'Filter zurücksetzen.'
                : 'Importiere Verkaufsdaten über «Verkaufsdaten Upload».'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── KPI-Karten ───────────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <KpiCard label="Produkte"     value={fmtNum(kpis.total_products)} icon={Package} />
          <KpiCard label="Gesamtumsatz" value={fmtChf(kpis.total_revenue)}  icon={DollarSign}   color="green" />
          <KpiCard label="Gesamtabsatz" value={fmtNum(kpis.total_qty)}      icon={ShoppingCart} />
          <KpiCard
            label="Kategorien"
            value={String(categories.filter(c => c.category !== 'Unbekannt').length)}
            icon={TrendingDown}
            color="violet"
            sub={unknownCount > 0 ? `+ Unbekannt (${fmtNum(unknownCount)})` : 'alle gemappt'}
          />
        </div>
      )}

      {/* ── Filter-Leiste ────────────────────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">Quelle:</span>

              <Select value={srcFilter} onValueChange={setSrcFilter}>
                <SelectTrigger className="h-8 w-44 text-sm">
                  <SelectValue placeholder="Alle Quellen" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Quellen</SelectItem>
                  {availableSources.map(s => (
                    <SelectItem key={s} value={s}>
                      {sourceLabel(s === '__null__' ? null : s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-xs text-muted-foreground">Batch:</span>

              <Select value={batchFilter} onValueChange={setBatchFilter}>
                <SelectTrigger className="h-8 w-56 text-sm">
                  <SelectValue placeholder="Alle Batches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Alle Batches</SelectItem>
                  {availableBatches.map(b => (
                    <SelectItem key={b} value={b}>{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {(srcFilter !== 'all' || batchFilter !== 'all') && (
                <Button
                  variant="ghost" size="sm"
                  onClick={() => { setSrcFilter('all'); setBatchFilter('all'); }}
                  className="h-8 text-xs text-muted-foreground"
                >
                  Zurücksetzen
                </Button>
              )}

              <span className="ml-auto text-xs text-muted-foreground">
                {fmtNum(filteredRows.length)} von {fmtNum(rawRows.length)} Zeilen
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 4. Umsatz nach Kategorie (Tabelle) ──────────────────────────────── */}
      {categories.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Umsatz nach Kategorie</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategorie</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkte</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Anteil</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {categories.map(c => {
                    const share = kpis.total_revenue > 0
                      ? (c.total_revenue / kpis.total_revenue) * 100
                      : 0;
                    return (
                      <tr key={c.category} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 font-medium">
                          <span className={c.category === 'Unbekannt' ? 'text-muted-foreground italic' : ''}>
                            {c.category}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{c.total_products}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(c.total_qty)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(c.total_revenue)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                          {share.toFixed(1)} %
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 4. Diagramme: Umsatz + Absatz nach Kategorie ────────────────────── */}
      {categories.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Umsatz nach Kategorie (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 44 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11 }}
                    angle={-30}
                    textAnchor="end"
                    interval={0}
                  />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(v: number) => [fmtChf(v), 'Umsatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="total_revenue" radius={[4, 4, 0, 0]}>
                    {categories.map((_, i) => (
                      <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Absatz nach Kategorie (Stück)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 44 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11 }}
                    angle={-30}
                    textAnchor="end"
                    interval={0}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number) => [fmtNum(v), 'Absatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="total_qty" radius={[4, 4, 0, 0]}>
                    {categories.map((_, i) => (
                      <Cell key={i} fill={CATEGORY_COLORS[(i + 3) % CATEGORY_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── 4. Top Produkte mit Kategorie-Spalte ────────────────────────────── */}
      {filteredRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                Top Produkte nach Umsatz
              </CardTitle>
              <Input
                placeholder="Produkt oder Kategorie suchen…"
                value={topSearch}
                onChange={e => setTopSearch(e.target.value)}
                className="h-8 w-52 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {filteredTop.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {topSearch ? 'Keine Produkte gefunden' : 'Keine Daten'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">#</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkt</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategorie</th>
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {filteredTop.map((p, i) => (
                      <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                        <td className="px-4 py-2 font-medium max-w-[180px] truncate">{p.product_name}</td>
                        <td className="px-4 py-2">
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-normal ${
                              p.category === 'Unbekannt'
                                ? 'text-muted-foreground border-muted'
                                : ''
                            }`}
                          >
                            {p.category}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <span className="text-[10px] text-muted-foreground">
                            {sourceLabel(p.source)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(p.total_qty)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtChf(p.total_revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── WES-Hinweis ────────────────────────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardContent className="py-4 px-4">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              <span className="font-medium text-foreground">WES-Analyse & Margenberechnung</span>
              {' '}— verfügbar sobald Einkaufspreise im Artikelstamm erfasst und verknüpft sind.
            </span>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
