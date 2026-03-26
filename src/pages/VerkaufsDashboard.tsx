/**
 * VerkaufsDashboard – Produktumsatz & KPI Übersicht
 * ===================================================
 * Ein einziger DB-Aufruf (loadProductSalesRows) lädt saubere Zeilen
 * (source + import_batch gesetzt). Altbestand (null-Zeilen) wird separat
 * gezählt und als Info-KPI angezeigt.
 * Alle Filter (Quelle, Batch) laufen rein in JavaScript.
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
  sourceLabel,
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

// ─── Aggregation (rein JS, kein DB-Aufruf) ───────────────────────────────────

type DashKpis = {
  total_products: number;
  total_revenue:  number;
  total_qty:      number;
};

type DashCategory = {
  category:       string;   // lesbarer Label (Food / Beverage / …)
  sourceKey:      string;   // Rohwert aus DB für Filtervergleich
  total_products: number;
  total_qty:      number;
  total_revenue:  number;
};

type DashProduct = {
  product_name:  string;
  sourceKey:     string;
  total_qty:     number;
  total_revenue: number;
};

function aggregateAll(rows: ProductSalesRow[], topLimit: number) {
  const products    = new Set<string>();
  const catMap      = new Map<string, DashCategory>();
  const prodMap     = new Map<string, DashProduct>();
  const prodPerCat  = new Map<string, Set<string>>();
  let totalQty = 0, totalRevenue = 0;

  for (const r of rows) {
    const qty    = Number(r.quantity ?? 0);
    const rev    = Number(r.revenue  ?? 0);
    const srcKey = r.source ?? '__null__';
    const label  = sourceLabel(r.source);

    if (r.product_name) products.add(r.product_name);
    totalQty     += qty;
    totalRevenue += rev;

    // Kategorie-Aggregation (gruppiert nach Quelle)
    if (!catMap.has(srcKey)) {
      catMap.set(srcKey, { category: label, sourceKey: srcKey, total_products: 0, total_qty: 0, total_revenue: 0 });
    }
    const cat = catMap.get(srcKey)!;
    cat.total_qty     += qty;
    cat.total_revenue += rev;

    // Distinct-Produkte pro Kategorie tracken
    if (r.product_name) {
      if (!prodPerCat.has(srcKey)) prodPerCat.set(srcKey, new Set());
      prodPerCat.get(srcKey)!.add(r.product_name);
    }

    // Produkt-Aggregation
    const pKey = r.product_name ?? '(unbekannt)';
    if (!prodMap.has(pKey)) {
      prodMap.set(pKey, { product_name: pKey, sourceKey: srcKey, total_qty: 0, total_revenue: 0 });
    }
    const p = prodMap.get(pKey)!;
    p.total_qty     += qty;
    p.total_revenue += rev;
  }

  // Distinct-Produktanzahl pro Kategorie eintragen
  for (const [key, cat] of catMap) {
    cat.total_products = prodPerCat.get(key)?.size ?? 0;
  }

  const categories  = Array.from(catMap.values()).sort((a, b) => b.total_revenue - a.total_revenue);
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
  const [srcFilter,       setSrcFilter]       = useState<string>('all');
  const [batchFilter,     setBatchFilter]     = useState<string>('all');
  const [topSearch,       setTopSearch]       = useState('');

  const load = async () => {
    setLoading(true);
    setDbError(null);
    try {
      // Beide Abfragen parallel — loadAltbestandCount schlägt still fehl
      const [rows, altCount] = await Promise.all([
        loadProductSalesRows(),
        loadAltbestandCount(),
      ]);
      setRawRows(rows);
      setAltbestandCount(altCount);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[VerkaufsDashboard] load error:', msg);
      setDbError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Verfügbare Filter-Optionen ─────────────────────────────────────────────

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) set.add(r.source ?? '__null__');
    return Array.from(set).sort();
  }, [rawRows]);

  const availableBatches = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) if (r.import_batch) set.add(r.import_batch);
    // Neueste zuerst — Batch-IDs enthalten Timestamp (food-YYYYMMDD-HHMM)
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
    () => aggregateAll(filteredRows, 50),
    [filteredRows],
  );

  const noData = !dbError && filteredRows.length === 0;

  // ── Top-Produkt Suche ──────────────────────────────────────────────────────

  const filteredTop = useMemo(() =>
    topProducts.filter(p =>
      p.product_name.toLowerCase().includes(topSearch.toLowerCase())
    ), [topProducts, topSearch]);

  // ── Skeleton Loading ────────────────────────────────────────────────────────

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
          <div className="h-72 rounded-lg bg-muted animate-pulse" />
          <div className="h-72 rounded-lg bg-muted animate-pulse" />
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
              Produktumsatz &amp; Absatz
              {rawRows.length > 0 && (
                <span className="ml-2 text-xs text-muted-foreground/70">
                  ({fmtNum(rawRows.length)} saubere Datensätze)
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
                <p className="text-xs text-muted-foreground mt-2">
                  Falls Code <code>42501</code>: SELECT-Policy fehlt für <code>product_sales</code>.
                </p>
                <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">
{`CREATE POLICY "authenticated_can_select"
  ON public.product_sales FOR SELECT
  TO authenticated USING (true);`}
                </pre>
                <Button size="sm" variant="outline" onClick={load} className="mt-2">
                  Nochmals versuchen
                </Button>
              </div>
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
              {rawRows.length > 0
                ? 'Wähle andere Filter oder setze sie zurück.'
                : 'Importiere Verkaufsdaten über «Verkaufsdaten Upload».'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── KPI-Karten ───────────────────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <KpiCard
            label="Produkte"
            value={fmtNum(kpis.total_products)}
            icon={Package}
          />
          <KpiCard
            label="Gesamtumsatz"
            value={fmtChf(kpis.total_revenue)}
            icon={DollarSign}
            color="green"
          />
          <KpiCard
            label="Gesamtabsatz"
            value={fmtNum(kpis.total_qty)}
            icon={ShoppingCart}
          />
          <KpiCard
            label="Ø WES-Quote"
            value="–"
            icon={TrendingDown}
            color="muted"
            sub="Kein WES-Feld vorhanden"
          />
        </div>
      )}

      {/* ── Altbestand-Info (wenn vorhanden) ─────────────────────────────────── */}
      {altbestandCount > 0 && (
        <Card className="border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/10">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3">
              <Archive className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Altbestand:
                </span>
                <span className="text-sm text-amber-700 dark:text-amber-400 ml-1.5">
                  {fmtNum(altbestandCount)} Datensätze ohne Quellangabe — werden nicht in der Analyse berücksichtigt.
                </span>
              </div>
              <Badge
                variant="outline"
                className="shrink-0 text-xs border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400"
              >
                {fmtNum(rawRows.length)} sauber / {fmtNum(rawRows.length + altbestandCount)} total
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Filter-Leiste ────────────────────────────────────────────────────── */}
      {rawRows.length > 0 && (
        <Card className="bg-muted/30">
          <CardContent className="py-3 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

              {/* Quelle */}
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

              {/* Import-Batch */}
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

              {/* Reset */}
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

      {/* ── Umsatz nach Quelle ───────────────────────────────────────────────── */}
      {categories.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Umsatz nach Quelle</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkte</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Ø WES %</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {categories.map(c => (
                    <tr key={c.sourceKey} className="hover:bg-muted/30 transition-colors">
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
              <CardTitle className="text-base">Umsatz nach Quelle (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} />
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
              <CardTitle className="text-base">Absatz nach Quelle (Stück)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} />
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
                placeholder="Suchen..."
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
                      <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Ø WES %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {filteredTop.map((p, i) => (
                      <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                        <td className="px-4 py-2 font-medium">{p.product_name}</td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {sourceLabel(p.sourceKey === '__null__' ? null : p.sourceKey)}
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
            <div>
              <span className="text-sm font-medium text-foreground">WES-Analyse & Produktmatrix</span>
              <span className="text-sm text-muted-foreground ml-2">
                Wird verfügbar sobald Produkte im Artikelstamm mit Einkaufspreisen erfasst und
                via <code className="text-xs">product_name</code> mit Verkaufsdaten verknüpft sind.
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
