/**
 * KategorienAnalyse – Kategorie KPI Übersicht
 * =============================================
 * Datenquelle: dashboard_category_kpis View
 * Zeigt pro Kategorie: Umsatz, Absatz, WES %, Produkte
 * WES-Ampel: ≤25% = grün, 25–30% = gelb, >30% = rot
 */

import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Layers, RefreshCw, TrendingDown, ShoppingCart, DollarSign, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fetchCategoryKpis, type CategoryKpi } from '@/lib/sales-db';

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

function wesStatus(pct: number | null | undefined): {
  label: string;
  cls: string;
  barColor: string;
  cardBorder: string;
} {
  if (pct == null) return {
    label: 'Kein WES',
    cls: 'text-muted-foreground',
    barColor: '#94a3b8',
    cardBorder: 'border-border',
  };
  if (pct <= 25) return {
    label: 'Gut',
    cls: 'text-emerald-600 dark:text-emerald-400',
    barColor: '#10b981',
    cardBorder: 'border-emerald-200 dark:border-emerald-800',
  };
  if (pct <= 30) return {
    label: 'Prüfen',
    cls: 'text-amber-600 dark:text-amber-400',
    barColor: '#f59e0b',
    cardBorder: 'border-amber-200 dark:border-amber-800',
  };
  return {
    label: 'Kritisch',
    cls: 'text-red-600 dark:text-red-400',
    barColor: '#ef4444',
    cardBorder: 'border-red-200 dark:border-red-800',
  };
}

// ─── Kategorie-Karte ──────────────────────────────────────────────────────────

function CategoryCard({ cat }: { cat: CategoryKpi }) {
  const status = wesStatus(cat.avg_wes_percent);

  return (
    <Card className={`border ${status.cardBorder} transition-shadow hover:shadow-md`}>
      <CardContent className="pt-4 pb-4">
        {/* Kategorie-Name + WES-Status */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <h3 className="font-semibold text-base leading-tight">{cat.category || 'Unbekannt'}</h3>
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
            status.label === 'Gut'
              ? 'bg-emerald-100 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
              : status.label === 'Prüfen'
              ? 'bg-amber-100 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800 text-amber-700 dark:text-amber-400'
              : status.label === 'Kritisch'
              ? 'bg-red-100 border-red-200 dark:bg-red-950/30 dark:border-red-800 text-red-700 dark:text-red-400'
              : 'bg-muted border-border text-muted-foreground'
          }`}>
            {status.label}
          </span>
        </div>

        {/* KPI-Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <Package className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Produkte</p>
            </div>
            <p className="text-lg font-bold tabular-nums">{cat.total_products ?? 0}</p>
          </div>
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <TrendingDown className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Ø WES</p>
            </div>
            <p className={`text-lg font-bold tabular-nums ${status.cls}`}>
              {fmtPct(cat.avg_wes_percent)}
            </p>
          </div>
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <ShoppingCart className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Absatz</p>
            </div>
            <p className="text-lg font-bold tabular-nums">{fmtNum(cat.total_qty)}</p>
          </div>
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <DollarSign className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Umsatz</p>
            </div>
            <p className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {fmtChf(cat.total_revenue)}
            </p>
          </div>
        </div>

        {/* WES Fortschrittsbalken */}
        {cat.avg_wes_percent != null && (
          <div className="mt-3">
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, cat.avg_wes_percent * 2)}%`,
                  backgroundColor: status.barColor,
                }}
              />
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-[9px] text-muted-foreground">0%</span>
              <span className="text-[9px] text-muted-foreground">25%</span>
              <span className="text-[9px] text-muted-foreground">50%</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function KategorienAnalyse() {
  const [loading, setLoading]   = useState(true);
  const [categories, setCategories] = useState<CategoryKpi[]>([]);

  const load = async () => {
    setLoading(true);
    const data = await fetchCategoryKpis();
    setCategories(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="p-6 space-y-5 max-w-7xl mx-auto">
        <div className="h-8 w-48 rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-48 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const sorted = [...categories].sort((a, b) => (b.total_revenue ?? 0) - (a.total_revenue ?? 0));

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-emerald-100 dark:bg-emerald-950/40 p-2">
            <Layers className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Kategorien</h1>
            <p className="text-sm text-muted-foreground">WES-Ampel und KPI pro Produktkategorie</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />
          Aktualisieren
        </Button>
      </div>

      {/* Legende */}
      <div className="flex flex-wrap gap-3 text-[11px]">
        {[
          { label: '≤ 25 % → Gut', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800' },
          { label: '25–30 % → Prüfen', cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800' },
          { label: '> 30 % → Kritisch', cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800' },
        ].map(l => (
          <span key={l.label} className={`px-2 py-0.5 rounded-full border font-medium ${l.cls}`}>
            {l.label}
          </span>
        ))}
      </div>

      {/* Keine Daten */}
      {categories.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">Noch keine Kategoriedaten vorhanden</p>
            <p className="text-sm text-muted-foreground mt-1">
              Importiere Verkaufsdaten, damit hier Kategorie-Auswertungen erscheinen.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Kategorie-Karten */}
      {categories.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map(cat => (
            <CategoryCard key={cat.category} cat={cat} />
          ))}
        </div>
      )}

      {/* WES Vergleich Balkendiagramm */}
      {categories.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">WES % nach Kategorie – Vergleich</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={sorted} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
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
                  tickFormatter={v => `${v}%`}
                  domain={[0, 'auto']}
                />
                {/* Referenzlinien als separate Bars würden Breakpoints anzeigen */}
                <Tooltip
                  formatter={(v: number) => [`${Number(v).toFixed(1)} %`, 'Ø WES']}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Bar dataKey="avg_wes_percent" radius={[4, 4, 0, 0]}>
                  {sorted.map((c, i) => {
                    const s = wesStatus(c.avg_wes_percent);
                    return <Cell key={i} fill={s.barColor} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center justify-center gap-4 mt-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-4 rounded-full bg-emerald-500" />
                ≤ 25 % (Gut)
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-4 rounded-full bg-amber-500" />
                25–30 % (Prüfen)
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-4 rounded-full bg-red-500" />
                {'>'} 30 % (Kritisch)
              </div>
            </div>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
