/**
 * VerkaufsDashboard – Produktumsatz & KPI Übersicht
 * ===================================================
 * Lädt Daten aus:
 *   - management_dashboard    (KPI-Karten)
 *   - dashboard_category_kpis (Kategorie-Tabelle + Diagramme)
 *   - dashboard_top_products  (Top-Produkte)
 *   - dashboard_problem_products (Problemprodukte)
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Package, TrendingUp, TrendingDown, Star,
  DollarSign, ShoppingCart, AlertTriangle, RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  fetchManagementDashboard,
  fetchCategoryKpis,
  fetchTopProducts,
  fetchProblemProducts,
  type ManagementDashboard,
  type CategoryKpi,
  type TopProduct,
  type ProblemProduct,
} from '@/lib/sales-db';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

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

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '–';
  return `${Number(v).toFixed(1)} %`;
}

const CATEGORY_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
];

const MATRIX_BADGE: Record<string, { label: string; cls: string }> = {
  star:      { label: 'Star',      cls: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800' },
  cash_cow:  { label: 'Cash Cow',  cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800' },
  puzzle:    { label: 'Puzzle',    cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800' },
  dog:       { label: 'Dog',       cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800' },
};

// ─── KPI-Karte ────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, icon: Icon, sub, color = 'default',
}: {
  label: string;
  value: string;
  icon: React.FC<{ className?: string }>;
  sub?: string;
  color?: 'default' | 'green' | 'amber' | 'red' | 'violet';
}) {
  const colorMap = {
    default: 'text-primary',
    green:   'text-emerald-600 dark:text-emerald-400',
    amber:   'text-amber-600 dark:text-amber-400',
    red:     'text-red-600 dark:text-red-400',
    violet:  'text-violet-600 dark:text-violet-400',
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

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function VerkaufsDashboard() {
  const [loading, setLoading]             = useState(true);
  const [kpis, setKpis]                   = useState<ManagementDashboard | null>(null);
  const [categories, setCategories]       = useState<CategoryKpi[]>([]);
  const [topProducts, setTopProducts]     = useState<TopProduct[]>([]);
  const [problems, setProblems]           = useState<ProblemProduct[]>([]);
  const [topSearch, setTopSearch]         = useState('');
  const [probSearch, setProbSearch]       = useState('');

  const load = async () => {
    setLoading(true);
    const [k, c, t, p] = await Promise.all([
      fetchManagementDashboard(),
      fetchCategoryKpis(),
      fetchTopProducts(20),
      fetchProblemProducts(),
    ]);
    setKpis(k);
    setCategories(c);
    setTopProducts(t);
    setProblems(p);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filteredTop = useMemo(() =>
    topProducts.filter(r =>
      r.product_name?.toLowerCase().includes(topSearch.toLowerCase()) ||
      r.category?.toLowerCase().includes(topSearch.toLowerCase())
    ), [topProducts, topSearch]);

  const filteredProb = useMemo(() =>
    problems.filter(r =>
      r.name?.toLowerCase().includes(probSearch.toLowerCase()) ||
      r.category?.toLowerCase().includes(probSearch.toLowerCase())
    ), [problems, probSearch]);

  // ── Skeleton Loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-7 w-48 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
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

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-violet-100 dark:bg-violet-950/40 p-2">
            <TrendingUp className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Verkaufs-Dashboard</h1>
            <p className="text-sm text-muted-foreground">Produktumsatz, WES & Matrix-Übersicht</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Aktualisieren
        </Button>
      </div>

      {/* Keine Daten */}
      {!kpis && categories.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">Noch keine Verkaufsdaten vorhanden</p>
            <p className="text-sm text-muted-foreground mt-1">
              Importiere Verkaufsdaten über «Verkaufsdaten Upload», um hier Auswertungen zu sehen.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── KPI-Karten ─────────────────────────────────────────────────────── */}
      {kpis && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 md:gap-4">
          <KpiCard
            label="Produkte total"
            value={fmtNum(kpis.total_products)}
            icon={Package}
          />
          <KpiCard
            label="Ø WES-Quote"
            value={fmtPct(kpis.avg_wes_percent)}
            icon={TrendingDown}
            color={
              kpis.avg_wes_percent <= 25 ? 'green'
              : kpis.avg_wes_percent <= 30 ? 'amber'
              : 'red'
            }
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
            label="Stars ⭐"
            value={String(kpis.stars ?? 0)}
            icon={Star}
            color="green"
            sub="Hoher Umsatz + WES ok"
          />
          <KpiCard
            label="Cash Cows 🐄"
            value={String(kpis.cash_cows ?? 0)}
            icon={DollarSign}
            color="amber"
            sub="Stabiler Umsatz"
          />
          <KpiCard
            label="Puzzles ❓"
            value={String(kpis.puzzles ?? 0)}
            icon={AlertTriangle}
            color="violet"
            sub="Hohes Potenzial, tiefer Absatz"
          />
          <KpiCard
            label="Dogs 🐕"
            value={String(kpis.dogs ?? 0)}
            icon={TrendingDown}
            color="red"
            sub="Tiefer Umsatz + WES hoch"
          />
        </div>
      )}

      {/* ── Kategorie-Tabelle ───────────────────────────────────────────────── */}
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
                      <td className="px-4 py-2.5 font-medium">{c.category || '–'}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{c.total_products ?? 0}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className={
                          !c.avg_wes_percent ? 'text-muted-foreground'
                          : c.avg_wes_percent <= 25 ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                          : c.avg_wes_percent <= 30 ? 'text-amber-600 dark:text-amber-400 font-semibold'
                          : 'text-red-600 dark:text-red-400 font-semibold'
                        }>
                          {fmtPct(c.avg_wes_percent)}
                        </span>
                      </td>
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

      {/* ── Diagramme ──────────────────────────────────────────────────────── */}
      {categories.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">

          {/* Umsatz-Diagramm */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Umsatz nach Kategorie (CHF)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11 }}
                    angle={-35}
                    textAnchor="end"
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
                  />
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

          {/* Absatz-Diagramm */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Absatz nach Kategorie (Stück)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={categories} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                  <XAxis
                    dataKey="category"
                    tick={{ fontSize: 11 }}
                    angle={-35}
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

      {/* ── Top Produkte ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              Top Produkte
            </CardTitle>
            <Input
              placeholder="Suchen..."
              value={topSearch}
              onChange={e => setTopSearch(e.target.value)}
              className="h-8 w-40 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filteredTop.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {topSearch ? 'Keine Produkte gefunden' : 'Noch keine Verkaufsdaten vorhanden'}
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
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filteredTop.map((p, i) => (
                    <tr key={`${p.product_name}-${i}`} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{i + 1}</td>
                      <td className="px-4 py-2.5 font-medium">{p.product_name || '–'}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant="outline" className="text-[10px] font-normal">{p.category || '–'}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(p.total_qty)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(p.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Problemprodukte ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Problemprodukte
            </CardTitle>
            <Input
              placeholder="Suchen..."
              value={probSearch}
              onChange={e => setProbSearch(e.target.value)}
              className="h-8 w-40 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filteredProb.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {probSearch ? 'Keine Produkte gefunden' : 'Keine Problemprodukte identifiziert'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produkt</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategorie</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Absatz</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Umsatz CHF</th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES %</th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Matrix</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {filteredProb.map((p, i) => {
                    const badge = MATRIX_BADGE[p.matrix_category?.toLowerCase()] ?? MATRIX_BADGE.dog;
                    return (
                      <tr key={`${p.name}-${i}`} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 font-medium">{p.name || '–'}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant="outline" className="text-[10px] font-normal">{p.category || '–'}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtNum(p.total_qty)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{fmtChf(p.total_revenue)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          <span className={
                            p.wes_percent_fixed <= 25 ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : p.wes_percent_fixed <= 30 ? 'text-amber-600 dark:text-amber-400 font-semibold'
                            : 'text-red-600 dark:text-red-400 font-semibold'
                          }>
                            {fmtPct(p.wes_percent_fixed)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
