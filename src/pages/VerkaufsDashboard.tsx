/**
 * VerkaufsDashboard – Produktumsatz & KPI Übersicht
 * ===================================================
 * Lädt product_sales + Produkt-Kategorie-Mapping parallel.
 * Aggregation nach Kategorie (aus products-Tabelle / app_settings Fallback).
 * Filter (Quelle, Batch) laufen in JavaScript.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Package, TrendingUp, TrendingDown,
  Star, DollarSign, ShoppingCart,
  AlertTriangle, RefreshCw, Filter, Archive, Info,
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
import {
  loadProductSalesRows,
  loadAltbestandCount,
  loadProductCategoryMap,
  sourceLabel,
  normalizeProductName,
  type ProductSalesRow,
} from '@/lib/sales-db';

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

// ─── Typen ────────────────────────────────────────────────────────────────────

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

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregateAll(
  rows: ProductSalesRow[],
  catMap: Map<string, string>,
  topLimit: number,
) {
  const products    = new Set<string>();
  const catAgg      = new Map<string, DashCategory>();
  const prodMap     = new Map<string, DashProduct>();
  const prodPerCat  = new Map<string, Set<string>>();
  let totalQty = 0, totalRevenue = 0;

  for (const r of rows) {
    const qty  = Number(r.quantity ?? 0);
    const rev  = Number(r.revenue  ?? 0);
    const key  = normalizeProductName(r.product_name);
    const cat  = catMap.get(key) ?? 'Unbekannt';

    if (r.product_name) products.add(r.product_name);
    totalQty     += qty;
    totalRevenue += rev;

    // Kategorie-Aggregation
    if (!catAgg.has(cat)) {
      catAgg.set(cat, { category: cat, total_products: 0, total_qty: 0, total_revenue: 0 });
    }
    const catEntry = catAgg.get(cat)!;
    catEntry.total_qty     += qty;
    catEntry.total_revenue += rev;

    // Distinct Produkte pro Kategorie
    if (r.product_name) {
      if (!prodPerCat.has(cat)) prodPerCat.set(cat, new Set());
      prodPerCat.get(cat)!.add(r.product_name);
    }

    // Produkt-Aggregation
    const pKey = r.product_name ?? '(unbekannt)';
    if (!prodMap.has(pKey)) {
      prodMap.set(pKey, { product_name: pKey, category: cat, source: r.source, total_qty: 0, total_revenue: 0 });
    }
    const p = prodMap.get(pKey)!;
    p.total_qty     += qty;
    p.total_revenue += rev;
  }

  for (const [cat, entry] of catAgg) {
    entry.total_products = prodPerCat.get(cat)?.size ?? 0;
  }

  const categories  = Array.from(catAgg.values()).sort((a, b) => b.total_revenue - a.total_revenue);
  const topProducts = Array.from(prodMap.values()).sort((a, b) => b.total_revenue - a.total_revenue).slice(0, topLimit);
  const kpis: DashKpis = { total_products: products.size, total_revenue: totalRevenue, total_qty: totalQty };

  return { kpis, categories, topProducts };
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function VerkaufsDashboard() {
  const [loading,         setLoading]         = useState(true);
  const [dbError,         setDbError]         = useState<string | null>(null);
  const [rawRows,         setRawRows]         = useState<ProductSalesRow[]>([]);
  const [altbestandCount, setAltbestandCount] = useState<number>(0);
  const [categoryMap,     setCategoryMap]     = useState<Map<string, string>>(new Map());
  const [mappedCount,     setMappedCount]     = useState<number>(0);
  const [srcFilter,       setSrcFilter]       = useState<string>('all');
  const [batchFilter,     setBatchFilter]     = useState<string>('all');
  const [topSearch,       setTopSearch]       = useState('');

  const load = async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [rows, altCount, catMap] = await Promise.all([
        loadProductSalesRows(),
        loadAltbestandCount(),
        loadProductCategoryMap(),
      ]);
      setRawRows(rows);
      setAltbestandCount(altCount);
      setCategoryMap(catMap);
      // Zähle wie viele sales-Zeilen gemappt wurden
      const mapped = rows.filter(r => catMap.has(normalizeProductName(r.product_name))).length;
      setMappedCount(mapped);
      console.log(`[DASHBOARD] Mapping: ${mapped}/${rows.length} rows haben eine Kategorie`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VerkaufsDashboard] load error:', msg);
      setDbError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Filter-Optionen ────────────────────────────────────────────────────────

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

  const { kpis, categories, topProducts } = useMemo(
    () => aggregateAll(filteredRows, categoryMap, 50),
    [filteredRows, categoryMap],
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

  const unmappedCount = filteredRows.length - mappedCount;

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

      {/* ── DB-Fehler ────────────────────────────────────────────────────────── */}
      {dbError && (
        <Card className="border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30">
          <CardContent className="py-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <div className="space-y-1 min-w-0">
                <p className="font-semibold text-red-700 dark:text-red-400">Datenbankfehler beim Laden</p>
                <p className="text-sm text-red-600 dark:text-red-300 font-mono break-all">{dbError}</p>
                <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">
{`CREATE POLICY "authenticated_can_select"
  ON public.product_sales FOR SELECT
  TO authenticated USING (true);`}
                </pre>
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
                {fmtNum(altbestandCount)} Datensätze ohne Quellangabe werden nicht berücksichtigt.
              </span>
              <Badge variant="outline" className="shrink-0 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400">
                {fmtNum(rawRows.length)} sauber / {fmtNum(rawRows.length + altbestandCount)} total
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Mapping-Hinweis wenn viele Produkte nicht gemappt ─────────────────── */}
      {rawRows.length > 0 && unmappedCount > rawRows.length * 0.5 && (
        <Card className="border-muted">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 text-muted-foreground">
              <Info className="h-4 w-4 shrink-0" />
              <span className="text-sm">
                <strong className="text-foreground">{fmtNum(unmappedCount)}</strong> von {fmtNum(rawRows.length)} Verkaufszeilen konnten keiner Produktkategorie zugeordnet werden
                (erscheinen als «Unbekannt»). Produkte im <strong>Artikelstamm</strong> erfassen um das Mapping zu verbessern.
              </span>
            </div>
          </CardContent>
        </Card>
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
              {rawRows.length > 0 ? 'Filter zurücksetzen.' : 'Importiere Verkaufsdaten über «Verkaufsdaten Upload».'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── KPI-Karten ───────────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <KpiCard label="Produkte"      value={fmtNum(kpis.total_products)} icon={Package} />
          <KpiCard label="Gesamtumsatz"  value={fmtChf(kpis.total_revenue)}  icon={DollarSign} color="green" />
          <KpiCard label="Gesamtabsatz"  value={fmtNum(kpis.total_qty)}      icon={ShoppingCart} />
          <KpiCard label="Ø WES-Quote"   value="–" icon={TrendingDown} color="muted" sub="Noch kein WES-Feld" />
        </div>
      )}

      {/* ── Filter-Leiste ────────────────────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

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
                  Filter zurücksetzen
                </Button>
              )}

              <span className="ml-auto text-xs text-muted-foreground">
                {fmtNum(filteredRows.length)} von {fmtNum(rawRows.length)} Zeilen
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Umsatz nach Kategorie ────────────────────────────────────────────── */}
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
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Ø WES %</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {categories.map(c => (
                    <tr key={c.category} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 font-medium">{c.category}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{c.total_products}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">–</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(c.total_qty)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(c.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Diagramme ────────────────────────────────────────────────────────── */}
      {categories.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Umsatz nach Kategorie (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => [fmtChf(v), 'Umsatz']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="total_revenue" radius={[4, 4, 0, 0]}>
                    {categories.map((_, i) => <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />)}
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
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => [fmtNum(v), 'Absatz']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  <Bar dataKey="total_qty" radius={[4, 4, 0, 0]}>
                    {categories.map((_, i) => <Cell key={i} fill={CATEGORY_COLORS[(i + 3) % CATEGORY_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Top Produkte ─────────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                Top Produkte nach Umsatz
              </CardTitle>
              <Input
                placeholder="Suchen…"
                value={topSearch}
                onChange={e => setTopSearch(e.target.value)}
                className="h-8 w-44 text-sm"
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
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Ø WES %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {filteredTop.map((p, i) => (
                      <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                        <td className="px-4 py-2 font-medium max-w-[200px] truncate">{p.product_name}</td>
                        <td className="px-4 py-2">
                          <Badge
                            variant="outline"
                            className={`text-[10px] font-normal ${p.category === 'Unbekannt' ? 'text-muted-foreground' : ''}`}
                          >
                            {p.category}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(p.total_qty)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtChf(p.total_revenue)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground text-xs">–</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── WES-Analyse Platzhalter ───────────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardContent className="py-4 px-4">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              <span className="font-medium text-foreground">WES-Analyse & Produktmatrix</span>
              {' '}— verfügbar sobald Einkaufspreise im Artikelstamm erfasst und mit Verkaufsdaten verknüpft sind.
            </span>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
