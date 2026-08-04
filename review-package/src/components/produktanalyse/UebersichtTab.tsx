/**
 * UebersichtTab – Kompakter Einstieg in die Produktanalyse
 * =========================================================
 * KPI-Leitstand über die gemeinsam gefilterte Periode (Container liefert
 * Rows + PeriodSelection + Kategorie + Vergleichsmodus).
 *
 * KEINE neue Berechnungslogik:
 *  - Zeilen-Scope: filterRows (product-analytics, SSoT)
 *  - Produkt-Aggregation: aggregateProducts (product-analytics)
 *  - WES: Stammdaten-WES pro Einheit × Menge (identisch VerkaufsDashboard)
 *  - Netto: grossToNet (types/personnel)
 *  - WES-Quote: verkaufsWesQuote (warenkosten-quote, zentral)
 *  - Vergleich/Deltas: comparisonPeriod/deltaPct (produkt-zeitraum)
 * Fehlend ≠ 0: fehlende Basis ⇒ «—», nie 0.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, TrendingUp, Layers } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { grossToNet } from '@/types/personnel';
import { verkaufsWesQuote } from '@/lib/warenkosten-quote';
import { loadProductWesMap, type ProductSalesRow } from '@/lib/sales-db';
import {
  filterRows, aggregateProducts, periodLabel as periodLabelOf, filtersToParams,
  type PeriodSelection, type CategoryFilter, type Metric,
} from '@/lib/product-analytics';
import {
  comparisonPeriod, deltaPct, COMPARE_MODE_LABEL, type CompareMode,
} from '@/lib/produkt-zeitraum';
import type { Tone } from '@/components/ui/tones';

// ─── Formatierung ────────────────────────────────────────────────────────────

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

function fmtPct1(v: number): string {
  return `${v.toFixed(1)} %`;
}

/** Δ% → Trend-Prop der KpiCard; `betterWhenUp` steuert die Bewertung. */
function pctTrend(d: number | null, betterWhenUp: boolean, suffix = '%'):
  { direction: 'up' | 'down' | 'flat'; tone: Tone; label: string } | undefined {
  if (d == null) return undefined;
  const direction = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const good = d === 0 ? true : (d > 0) === betterWhenUp;
  return {
    direction,
    tone: d === 0 ? 'neutral' : good ? 'good' : 'critical',
    label: `${d > 0 ? '+' : ''}${d.toFixed(1)} ${suffix}`.trim(),
  };
}

// ─── Perioden-Totale (Formeln identisch VerkaufsDashboard.aggregate) ─────────

interface PeriodTotals {
  totalQty: number;
  totalRevenue: number;   // brutto (Rohsumme der Rows)
  totalWes: number;       // Σ Menge × Stammdaten-WES/Einheit
  productCount: number;   // distinct Produkte mit Umsatz > 0
  withoutWes: number;     // davon ohne gepflegtes WES
}

function totalsOf(
  rows: ProductSalesRow[],
  sel: PeriodSelection,
  category: CategoryFilter,
  wesMap: Map<string, number>,
): PeriodTotals {
  const scoped = filterRows(rows, sel, category);
  let totalQty = 0, totalRevenue = 0, totalWes = 0;
  const products = new Map<string, number>(); // name → revenue
  for (const r of scoped) {
    const qty = Number(r.quantity ?? 0);
    const rev = Number(r.revenue ?? 0);
    const nameKey = (r.product_name ?? '').trim().toLowerCase();
    const wesUnit = wesMap.get(nameKey) ?? 0;
    totalQty += qty;
    totalRevenue += rev;
    totalWes += qty * wesUnit;
    if (r.product_name) {
      products.set(r.product_name, (products.get(r.product_name) ?? 0) + rev);
    }
  }
  let productCount = 0, withoutWes = 0;
  for (const [name, rev] of products) {
    if (rev <= 0) continue;
    productCount++;
    if ((wesMap.get(name.trim().toLowerCase()) ?? 0) <= 0) withoutWes++;
  }
  return { totalQty, totalRevenue, totalWes, productCount, withoutWes };
}

// ─── Komponente ──────────────────────────────────────────────────────────────

export default function UebersichtTab({
  rows,
  loading,
  error,
  selection,
  categoryFilter,
  compareMode,
  sortBy,
}: {
  rows: ProductSalesRow[];
  loading: boolean;
  error: string | null;
  selection: PeriodSelection;
  categoryFilter: CategoryFilter;
  compareMode: CompareMode;
  sortBy: Metric;
}) {
  const navigate = useNavigate();
  const [wesMap, setWesMap] = useState<Map<string, number>>(new Map());

  // Produkt-Drilldown — identischer Pfad wie im Produkte-Tab (Filter erhalten)
  const openDetail = useCallback((name: string) => {
    const params = new URLSearchParams(
      filtersToParams({ period: selection, category: categoryFilter, metric: sortBy }),
    );
    params.set('name', name);
    navigate(`/produkt-analyse/produkt?${params.toString()}`);
  }, [navigate, selection, categoryFilter, sortBy]);

  useEffect(() => {
    let cancelled = false;
    loadProductWesMap()
      .then(m => { if (!cancelled) setWesMap(m); })
      .catch(() => { /* WES optional — Karten zeigen dann «—» */ });
    return () => { cancelled = true; };
  }, []);

  const totals = useMemo(
    () => totalsOf(rows, selection, categoryFilter, wesMap),
    [rows, selection, categoryFilter, wesMap],
  );

  const cmpSelection = useMemo(
    () => comparisonPeriod(selection, compareMode),
    [selection, compareMode],
  );

  const cmpTotals = useMemo(
    () => (cmpSelection ? totalsOf(rows, cmpSelection, categoryFilter, wesMap) : null),
    [rows, cmpSelection, categoryFilter, wesMap],
  );

  // Netto + Quoten — zentrale Funktionen, nie eigene Formeln
  const netto     = grossToNet(totals.totalRevenue);
  const hasWes    = totals.totalWes > 0;
  const wesQuote  = verkaufsWesQuote(totals.totalWes, netto);
  const db        = hasWes ? netto - totals.totalWes : null;

  const cmpNetto    = cmpTotals ? grossToNet(cmpTotals.totalRevenue) : null;
  const cmpWesQuote = cmpTotals ? verkaufsWesQuote(cmpTotals.totalWes, cmpNetto ?? 0) : null;

  // Deltas (null-sicher, Basis 0 ⇒ null)
  const dRevenue = cmpTotals ? deltaPct(netto, cmpNetto) : null;
  const dQty     = cmpTotals && cmpTotals.totalQty > 0 ? deltaPct(totals.totalQty, cmpTotals.totalQty) : null;
  // Quote: Veränderung in PROZENTPUNKTEN aus ungerundeten Quoten; runter = gut
  const dQuotePp = wesQuote != null && cmpWesQuote != null ? wesQuote - cmpWesQuote : null;

  // Top-Produkte + Kategorienanteile über die SSoT-Aggregation
  const rankedProducts = useMemo(() => {
    const scoped = filterRows(rows, selection, categoryFilter);
    const arr = aggregateProducts(scoped).filter(p => p.total_revenue > 0);
    arr.sort((a, b) =>
      sortBy === 'revenue' ? b.total_revenue - a.total_revenue : b.total_qty - a.total_qty,
    );
    return arr;
  }, [rows, selection, categoryFilter, sortBy]);

  const top5 = rankedProducts.slice(0, 5);
  const strongest = rankedProducts[0] ?? null;
  const weakest = rankedProducts.length > 1 ? rankedProducts[rankedProducts.length - 1] : null;

  const categoryShares = useMemo(() => {
    const scoped = filterRows(rows, selection, categoryFilter);
    const map = new Map<string, { name: string; revenue: number; qty: number }>();
    for (const r of scoped) {
      const key = r.source || '(unbekannt)';
      if (!map.has(key)) map.set(key, { name: key, revenue: 0, qty: 0 });
      const c = map.get(key)!;
      c.revenue += Number(r.revenue ?? 0);
      c.qty     += Number(r.quantity ?? 0);
    }
    return Array.from(map.values())
      .filter(c => c.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);
  }, [rows, selection, categoryFilter]);

  const periodText = periodLabelOf(selection);
  const cmpText = cmpSelection
    ? `${COMPARE_MODE_LABEL[compareMode]}: ${periodLabelOf(cmpSelection)}`
    : null;

  // ── Zustände ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground" data-testid="tab-panel-uebersicht">
        <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
        Lade Verkaufsdaten…
      </div>
    );
  }

  if (error) {
    return (
      <Card data-testid="tab-panel-uebersicht">
        <CardContent className="p-6 text-center">
          <p className="text-sm font-semibold text-destructive mb-1">Fehler beim Laden</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </CardContent>
      </Card>
    );
  }

  const empty = totals.totalRevenue <= 0 && totals.totalQty <= 0;

  return (
    <div className="space-y-5" data-testid="tab-panel-uebersicht">

      {cmpText && (
        <p className="text-xs text-muted-foreground">{cmpText}</p>
      )}

      {empty ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Layers className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm font-medium">Keine Verkaufsdaten für {periodText}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Zeitraum oder Kategorie anpassen — oder Verkaufsdaten importieren.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Standard-KPIs (max. 4) */}
          <KpiGrid>
            <KpiCard
              label="Nettoumsatz"
              value={fmtChf(netto)}
              sub={periodText}
              tone="info"
              trend={pctTrend(dRevenue, true)}
              data-testid="kpi-uebersicht-nettoumsatz"
            />
            <KpiCard
              label="Verkaufte Menge"
              value={fmtNum(totals.totalQty)}
              sub={periodText}
              tone="neutral"
              trend={pctTrend(dQty, true)}
              data-testid="kpi-uebersicht-menge"
            />
            <KpiCard
              label="Warenkosten (WES)"
              value={hasWes ? fmtChf(totals.totalWes) : '—'}
              sub={
                totals.withoutWes > 0
                  ? `${totals.withoutWes} Produkt${totals.withoutWes === 1 ? '' : 'e'} ohne WES`
                  : hasWes ? 'aus Produkt-Stammdaten' : 'kein WES gepflegt'
              }
              tone={hasWes ? 'neutral' : 'warn'}
              data-testid="kpi-uebersicht-warenkosten"
            />
            <KpiCard
              label="WES-Quote"
              value={wesQuote != null ? fmtPct1(wesQuote) : '—'}
              sub={wesQuote != null ? 'WES ÷ Nettoumsatz' : 'keine Basis'}
              tone={wesQuote == null ? 'neutral' : wesQuote <= 25 ? 'good' : wesQuote <= 30 ? 'warn' : 'critical'}
              trend={dQuotePp != null ? pctTrend(dQuotePp, false, 'pp') : undefined}
              data-testid="kpi-uebersicht-wes-quote"
            />
          </KpiGrid>

          {/* Weitere Kennzahlen — verlagert, nie gelöscht */}
          <MoreKpis storageKey="produktanalyse-uebersicht-more">
            <KpiGrid>
              <KpiCard
                label="Ø Preis (netto)"
                value={totals.totalQty > 0 ? fmtChf(netto / totals.totalQty) : '—'}
                sub="Nettoumsatz ÷ Menge"
              />
              <KpiCard
                label="Deckungsbeitrag"
                value={db != null ? fmtChf(db) : '—'}
                sub={db != null ? 'Netto − WES' : 'kein WES gepflegt'}
              />
              <KpiCard
                label="Produkte mit Umsatz"
                value={fmtNum(totals.productCount)}
                sub={periodText}
              />
              <KpiCard
                label={sortBy === 'revenue' ? 'Stärkstes Produkt (Umsatz)' : 'Stärkstes Produkt (Anzahl)'}
                value={strongest ? (
                  <span className="text-sm leading-snug">{strongest.product_name}</span>
                ) : '—'}
                sub={strongest
                  ? (sortBy === 'revenue' ? fmtChf(strongest.total_revenue) : `${fmtNum(strongest.total_qty)} Stk.`)
                  : undefined}
              />
            </KpiGrid>
            {weakest && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Schwächstes Produkt ({sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}):{' '}
                <span className="font-medium text-foreground">{weakest.product_name}</span>{' '}
                ({sortBy === 'revenue' ? fmtChf(weakest.total_revenue) : `${fmtNum(weakest.total_qty)} Stk.`})
              </p>
            )}
          </MoreKpis>

          {/* Top 5 + Kategorienanteile */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Top 5 Produkte — {sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}
                  </span>
                  <Badge variant="secondary" className="text-xs font-normal">{periodText}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {top5.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    Keine Produkte mit Umsatz &gt; 0.
                  </p>
                ) : (
                  <ol className="divide-y">
                    {top5.map((p, i) => {
                      const denomTotal = sortBy === 'revenue' ? totals.totalRevenue : totals.totalQty;
                      const val = sortBy === 'revenue' ? p.total_revenue : p.total_qty;
                      const share = denomTotal > 0 ? (val / denomTotal) * 100 : null;
                      return (
                        <li key={p.product_name}>
                          <button
                            type="button"
                            onClick={() => openDetail(p.product_name)}
                            className="flex w-full items-center gap-3 py-1.5 text-sm text-left rounded hover:bg-muted/50 transition-colors"
                            data-testid={`uebersicht-top-${i + 1}`}
                          >
                            <span className="w-5 text-xs font-semibold text-muted-foreground tabular-nums">{i + 1}.</span>
                            <span className="flex-1 truncate" title={p.product_name}>{p.product_name}</span>
                            <span className="tabular-nums font-medium">
                              {sortBy === 'revenue' ? fmtChf(p.total_revenue) : fmtNum(p.total_qty)}
                            </span>
                            <span className="w-14 text-right text-xs text-muted-foreground tabular-nums">
                              {share != null ? fmtPct1(share) : '—'}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-primary" />
                  Kategorienanteile — Umsatz
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {categoryShares.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    Keine Kategoriedaten für diesen Zeitraum.
                  </p>
                ) : (
                  categoryShares.map(c => {
                    const share = totals.totalRevenue > 0 ? (c.revenue / totals.totalRevenue) * 100 : 0;
                    return (
                      <div key={c.name}>
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate" title={c.name}>{c.name}</span>
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {fmtChf(c.revenue)} · {fmtPct1(share)}
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted">
                          <div
                            className="h-1.5 rounded-full bg-primary/70"
                            style={{ width: `${Math.min(100, share)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
