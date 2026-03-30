/**
 * VerkaufsDashboard – Minimal & stabil
 * =====================================
 * Nur product_sales. Keine externe Abhängigkeit.
 * Aggregation nach source (Food / Beverage / Manual).
 * Altbestand (source IS NULL) wird ignoriert.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Package, TrendingUp, DollarSign, ShoppingCart,
  AlertTriangle, RefreshCw, Filter, Archive, Star,
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

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

const SOURCE_COLORS: Record<string, string> = {
  food_csv_export:     '#6366f1',
  beverage_csv_export: '#10b981',
  manual_test:         '#f59e0b',
  __other__:           '#94a3b8',
};

function srcColor(source: string | null): string {
  if (!source) return SOURCE_COLORS.__other__;
  return SOURCE_COLORS[source] ?? SOURCE_COLORS.__other__;
}

// ─── Typen ────────────────────────────────────────────────────────────────────

type SourceRow = {
  source:    string | null;
  label:     string;
  qty:       number;
  revenue:   number;
  products:  number;
};

type TopProduct = {
  product_name: string;
  source:       string | null;
  qty:          number;
  revenue:      number;
};

// ─── Aggregation ──────────────────────────────────────────────────────────────

function aggregate(rows: ProductSalesRow[], topLimit: number) {
  let totalQty = 0;
  let totalRevenue = 0;
  const allProducts = new Set<string>();

  const srcMap   = new Map<string, SourceRow>();
  const prodMap  = new Map<string, TopProduct>();

  for (const r of rows) {
    const qty = Number(r.quantity ?? 0);
    const rev = Number(r.revenue  ?? 0);
    const src = r.source ?? null;
    const key = src ?? '__null__';

    totalQty     += qty;
    totalRevenue += rev;
    if (r.product_name) allProducts.add(r.product_name);

    // Aggregation nach Source
    if (!srcMap.has(key)) {
      srcMap.set(key, { source: src, label: sourceLabel(src), qty: 0, revenue: 0, products: 0 });
    }
    const s = srcMap.get(key)!;
    s.qty     += qty;
    s.revenue += rev;

    // Produkt-Aggregation
    const pKey = r.product_name ?? '(unbekannt)';
    if (!prodMap.has(pKey)) {
      prodMap.set(pKey, { product_name: pKey, source: src, qty: 0, revenue: 0 });
    }
    const p = prodMap.get(pKey)!;
    p.qty     += qty;
    p.revenue += rev;
  }

  // Distinct Produkte pro Source
  for (const r of rows) {
    if (!r.product_name) continue;
    const key = r.source ?? '__null__';
    const s   = srcMap.get(key);
    if (s) s.products = (s.products || 0);
  }
  // Recalculate distinct products per source properly
  const srcProducts = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.product_name) continue;
    const key = r.source ?? '__null__';
    if (!srcProducts.has(key)) srcProducts.set(key, new Set());
    srcProducts.get(key)!.add(r.product_name);
  }
  for (const [key, s] of srcMap) {
    s.products = srcProducts.get(key)?.size ?? 0;
  }

  const bySource  = Array.from(srcMap.values()).sort((a, b) => b.revenue - a.revenue);
  const topProducts = Array.from(prodMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, topLimit);

  return { totalQty, totalRevenue, totalProducts: allProducts.size, bySource, topProducts };
}

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, icon: Icon, sub, color = 'default',
}: {
  label: string;
  value: string;
  icon: React.FC<{ className?: string }>;
  sub?: string;
  color?: 'default' | 'green' | 'violet' | 'muted';
}) {
  const cls = {
    default: 'text-primary',
    green:   'text-emerald-600 dark:text-emerald-400',
    violet:  'text-violet-600 dark:text-violet-400',
    muted:   'text-muted-foreground',
  }[color];
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
            <p className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</p>
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
      const [rows, altCount] = await Promise.all([
        loadProductSalesRows(),   // paginiert, filtert source/import_batch IS NOT NULL
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

  const { totalQty, totalRevenue, totalProducts, bySource, topProducts } = useMemo(
    () => aggregate(filteredRows, 50),
    [filteredRows],
  );

  const filteredTop = useMemo(() =>
    topProducts.filter(p =>
      p.product_name.toLowerCase().includes(topSearch.toLowerCase())
    ), [topProducts, topSearch]);

  // ── Skeleton ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-7 w-48 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
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
              Produktumsatz aus Importdaten
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
              <div className="space-y-2 min-w-0">
                <p className="font-semibold text-red-700 dark:text-red-400">Datenbankfehler beim Laden</p>
                <p className="text-sm text-red-600 dark:text-red-300 font-mono break-all">{dbError}</p>
                <Button size="sm" variant="outline" onClick={load}>Nochmals versuchen</Button>
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

      {/* ── Keine Daten ──────────────────────────────────────────────────────── */}
      {!dbError && filteredRows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">
              {rawRows.length > 0
                ? 'Keine Daten für die gewählten Filter'
                : 'Noch keine Verkaufsdaten vorhanden'}
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
        <div className="grid grid-cols-3 gap-3 md:gap-4">
          <KpiCard
            label="Gesamtumsatz"
            value={fmtChf(totalRevenue)}
            icon={DollarSign}
            color="green"
          />
          <KpiCard
            label="Gesamtabsatz"
            value={fmtNum(totalQty)}
            icon={ShoppingCart}
          />
          <KpiCard
            label="Produkte (distinct)"
            value={fmtNum(totalProducts)}
            icon={Package}
            color="violet"
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

      {/* ── Umsatz + Absatz nach Source ──────────────────────────────────────── */}
      {bySource.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Umsatz nach Quelle (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={bySource} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(v: number) => [fmtChf(v), 'Umsatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
                    {bySource.map((s, i) => (
                      <Cell key={i} fill={srcColor(s.source)} />
                    ))}
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
                <BarChart data={bySource} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number) => [fmtNum(v), 'Absatz']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="qty" radius={[4, 4, 0, 0]}>
                    {bySource.map((s, i) => (
                      <Cell key={i} fill={srcColor(s.source)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Tabelle: Umsatz nach Quelle ──────────────────────────────────────── */}
      {bySource.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Übersicht nach Quelle</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Quelle</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkte</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Anteil</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {bySource.map(s => {
                  const share = totalRevenue > 0
                    ? (s.revenue / totalRevenue) * 100
                    : 0;
                  return (
                    <tr key={s.label} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: srcColor(s.source) }}
                          />
                          <span className="font-medium">{s.label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{s.products}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(s.qty)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(s.revenue)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                        {share.toFixed(1)} %
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ── Top Produkte nach Umsatz ──────────────────────────────────────────── */}
      {filteredRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                Top Produkte nach Umsatz
              </CardTitle>
              <Input
                placeholder="Produkt suchen…"
                value={topSearch}
                onChange={e => setTopSearch(e.target.value)}
                className="h-8 w-44 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {filteredTop.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                Keine Produkte gefunden
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {filteredTop.map((p, i) => (
                      <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2 text-muted-foreground tabular-nums text-xs">{i + 1}</td>
                        <td className="px-4 py-2 font-medium max-w-[220px] truncate">{p.product_name}</td>
                        <td className="px-4 py-2">
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {sourceLabel(p.source)}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{fmtNum(p.qty)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtChf(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

    </div>
  );
}
