/**
 * KategorienTab – Kategorie-KPIs über die gemeinsam gefilterte Periode
 * =====================================================================
 * Portiert aus der bisherigen Seite KategorienAnalyse (Karten + Ampel +
 * Vergleichsdiagramm) — neu perioden-/kategorie-gefiltert über die
 * gemeinsame Filterleiste des Containers.
 *
 * KEINE neue Berechnungslogik:
 *  - Scope: filterRows (product-analytics, SSoT)
 *  - Kategorie-Aggregation: aggregateCategoryKpis (sales-db, SSoT)
 *  - WES-Quote je Kategorie: Stammdaten-WES × Menge ÷ Umsatz über die
 *    zentrale verkaufsWesQuote (identisch VerkaufsDashboard, bySource) —
 *    die frühere Seite zeigte hier mangels Datenbasis immer 0 %.
 *  - Vergleich/Deltas: comparisonPeriod/deltaPct (produkt-zeitraum)
 * Fehlend ≠ 0: keine WES-Basis ⇒ «Kein WES», nie 0 %.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Layers, RefreshCw, TrendingDown, ShoppingCart, DollarSign, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { verkaufsWesQuote } from '@/lib/warenkosten-quote';
import {
  loadProductWesMap, aggregateCategoryKpis,
  type ProductSalesRow, type CategoryKpi,
} from '@/lib/sales-db';
import {
  filterRows, categoryOf, periodLabel as periodLabelOf,
  type PeriodSelection, type CategoryFilter,
} from '@/lib/product-analytics';
import {
  comparisonPeriod, deltaPct, COMPARE_MODE_LABEL, type CompareMode,
} from '@/lib/produkt-zeitraum';

// ─── Hilfsfunktionen (portiert aus KategorienAnalyse) ────────────────────────

function fmtChf(v: number | null | undefined): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
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

/** Kategorie-KPI + verkaufsbasierte WES-Quote + optionales Umsatz-Delta. */
interface CategoryView extends CategoryKpi {
  wesQuote: number | null;
  dRevenuePct: number | null;
}

/** Σ Menge × Stammdaten-WES je Kategorie (Formel identisch VerkaufsDashboard). */
function wesByCategory(scoped: ProductSalesRow[], wesMap: Map<string, number>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of scoped) {
    const key = r.source || '(unbekannt)';
    const nameKey = (r.product_name ?? '').trim().toLowerCase();
    const wesUnit = wesMap.get(nameKey) ?? 0;
    map.set(key, (map.get(key) ?? 0) + Number(r.quantity ?? 0) * wesUnit);
  }
  return map;
}

// ─── Kategorie-Karte (portiert, + WES-Quote statt leerem Ø WES) ──────────────

function CategoryCard({
  cat,
  compareLabel,
  onOpen,
}: {
  cat: CategoryView;
  compareLabel: string | null;
  onOpen?: () => void;
}) {
  const status = wesStatus(cat.wesQuote);

  return (
    <Card className={cn('border transition-shadow hover:shadow-md', status.cardBorder)}>
      <CardContent className="pt-4 pb-4">
        {/* Kategorie-Name + WES-Status */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <h3 className="font-semibold text-base leading-tight">{cat.category || 'Unbekannt'}</h3>
          <span className={cn(
            'text-[11px] font-semibold px-2 py-0.5 rounded-full border',
            status.label === 'Gut'
              ? 'bg-emerald-100 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
              : status.label === 'Prüfen'
              ? 'bg-amber-100 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800 text-amber-700 dark:text-amber-400'
              : status.label === 'Kritisch'
              ? 'bg-red-100 border-red-200 dark:bg-red-950/30 dark:border-red-800 text-red-700 dark:text-red-400'
              : 'bg-muted border-border text-muted-foreground',
          )}>
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
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">WES-Quote</p>
            </div>
            <p className={cn('text-lg font-bold tabular-nums', status.cls)}>
              {fmtPct(cat.wesQuote)}
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

        {/* Vergleich (nur wenn Vergleichsmodus aktiv und Basis vorhanden) */}
        {compareLabel && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {cat.dRevenuePct != null ? (
              <span className={cn(
                'font-medium tabular-nums',
                cat.dRevenuePct > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : cat.dRevenuePct < 0 ? 'text-red-600 dark:text-red-400' : '',
              )}>
                {cat.dRevenuePct > 0 ? '↑ +' : cat.dRevenuePct < 0 ? '↓ ' : '→ '}
                {cat.dRevenuePct.toFixed(1)} %
              </span>
            ) : (
              <span>Vergleich nicht möglich</span>
            )}{' '}
            Umsatz vs. {compareLabel}
          </p>
        )}

        {/* WES-Quote Fortschrittsbalken */}
        {cat.wesQuote != null && (
          <div className="mt-3">
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, cat.wesQuote * 2)}%`,
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

        {/* Drilldown: enthaltene Produkte im Produkte-Tab (gleiche Periode) */}
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="mt-3 text-xs font-medium text-primary hover:underline"
            data-testid={`kategorie-drilldown-${(cat.category || 'unbekannt').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          >
            Produkte anzeigen →
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────

export default function KategorienTab({
  rows,
  loading,
  error,
  selection,
  categoryFilter,
  compareMode,
  onOpenCategory,
}: {
  rows: ProductSalesRow[];
  loading: boolean;
  error: string | null;
  selection: PeriodSelection;
  categoryFilter: CategoryFilter;
  compareMode: CompareMode;
  /** Drilldown: wechselt zum Produkte-Tab mit gesetztem Kategorie-Filter. */
  onOpenCategory?: (cat: CategoryFilter) => void;
}) {
  const [wesMap, setWesMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    loadProductWesMap()
      .then(m => { if (!cancelled) setWesMap(m); })
      .catch(() => { /* WES optional — Karten zeigen dann «Kein WES» */ });
    return () => { cancelled = true; };
  }, []);

  const cmpSelection = useMemo(
    () => comparisonPeriod(selection, compareMode),
    [selection, compareMode],
  );

  const categories = useMemo<CategoryView[]>(() => {
    const scoped = filterRows(rows, selection, categoryFilter);
    const kpis = aggregateCategoryKpis(scoped);
    const wesPerCat = wesByCategory(scoped, wesMap);

    let cmpRevenue = new Map<string, number>();
    if (cmpSelection) {
      const cmpScoped = filterRows(rows, cmpSelection, categoryFilter);
      cmpRevenue = new Map(
        aggregateCategoryKpis(cmpScoped).map(c => [c.category, c.total_revenue]),
      );
    }

    return kpis.map(c => {
      const wes = wesPerCat.get(c.category) ?? 0;
      const prev = cmpRevenue.get(c.category);
      return {
        ...c,
        wesQuote: verkaufsWesQuote(wes, c.total_revenue),
        dRevenuePct: cmpSelection ? deltaPct(c.total_revenue, prev ?? null) : null,
      };
    });
  }, [rows, selection, categoryFilter, wesMap, cmpSelection]);

  const withQuote = categories.filter(c => c.wesQuote != null);
  const periodText = periodLabelOf(selection);
  const compareLabel = cmpSelection
    ? `${COMPARE_MODE_LABEL[compareMode]} (${periodLabelOf(cmpSelection)})`
    : null;

  // ── Zustände ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground" data-testid="tab-panel-kategorien">
        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
        Lade Verkaufsdaten…
      </div>
    );
  }

  if (error) {
    return (
      <Card data-testid="tab-panel-kategorien">
        <CardContent className="p-6 text-center">
          <p className="text-sm font-semibold text-destructive mb-1">Fehler beim Laden</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="tab-panel-kategorien">

      {/* Legende + Periode */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3 text-[11px]">
          {[
            { label: '≤ 25 % → Gut', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800' },
            { label: '25–30 % → Prüfen', cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800' },
            { label: '> 30 % → Kritisch', cls: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800' },
          ].map(l => (
            <span key={l.label} className={cn('px-2 py-0.5 rounded-full border font-medium', l.cls)}>
              {l.label}
            </span>
          ))}
        </div>
        <Badge variant="secondary" className="text-xs font-normal">{periodText}</Badge>
      </div>

      {/* Keine Daten */}
      {categories.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <Layers className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">Keine Kategoriedaten für {periodText}</p>
            <p className="text-sm text-muted-foreground mt-1">
              Zeitraum oder Kategorie anpassen — oder Verkaufsdaten importieren.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Kategorie-Karten */}
      {categories.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {categories.map(cat => {
            const mapped = categoryOf(cat.category);
            return (
              <CategoryCard
                key={cat.category}
                cat={cat}
                compareLabel={compareLabel}
                onOpen={
                  onOpenCategory && mapped != null
                    ? () => onOpenCategory(mapped)
                    : undefined
                }
              />
            );
          })}
        </div>
      )}

      {/* WES-Quoten-Vergleich (nur wenn mindestens eine Kategorie WES hat) */}
      {withQuote.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">WES-Quote nach Kategorie – Vergleich</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={withQuote} margin={{ top: 4, right: 8, left: 4, bottom: 40 }}>
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
                <Tooltip
                  formatter={(v: number) => [`${Number(v).toFixed(1)} %`, 'WES-Quote']}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Bar dataKey="wesQuote" radius={[4, 4, 0, 0]}>
                  {withQuote.map((c, i) => {
                    const s = wesStatus(c.wesQuote);
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
