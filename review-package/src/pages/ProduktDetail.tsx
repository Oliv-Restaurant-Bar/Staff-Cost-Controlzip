/**
 * ProduktDetail – Drill-down einer einzelnen Produkt-Position
 * ============================================================
 * Aufruf: /produkt-analyse/produkt?name=…&period=…&… (Filter via searchParams, refresh-fest)
 * Datenquelle: product_sales (unverändert via loadProductSalesRows)
 *
 * Aufbau:
 *  - Kopf: Zurück-Button (→ Rangliste mit erhaltenen Filtern), Produktname, Perioden-/Kategorie-Badges
 *  - KPI-Karten: Gesamtumsatz · Gesamtanzahl · Ø Umsatz/Verkauf
 *  - Umsatz/Anzahl-Umschalter (steuert die %-Spalte)
 *  - Aufschlüsselungs-Tabelle:
 *      Monat → eine Zeile pro Tag · Woche → Mo–So · Jahr → Jan–Dez · Tag → Quellen-Einträge
 *    Spalten: Datum/Periode · Anzahl · Umsatz · % vom Produkt-Total · Ø Preis
 *
 * Hinweis: product_sales kennt keine Uhrzeiten — die Tagesansicht zeigt daher die
 * Quellen-Einträge des Tages (gruppierte Zusammenfassung), keine Stunden.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, TrendingUp, Hash, Utensils, Wine, Layers, Calendar, Package,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { loadProductSalesRows, sourceLabel, type ProductSalesRow } from '@/lib/sales-db';
import { useTenant } from '@/contexts/TenantContext';
import {
  buildBreakdown, filtersFromParams, filtersToParams,
  PERIOD_KIND_LABEL,
  type CategoryFilter, type Metric, type BreakdownRow, type PeriodKind,
} from '@/lib/product-analytics';

// ─── Formatter ────────────────────────────────────────────────────────────────

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}
function fmtChf2(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(v);
}
function fmtNum(v: number): string {
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}
function pctStr(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

const CAT_LABEL: Record<CategoryFilter, string> = { all: 'Alle', food: 'Food', beverage: 'Beverage' };

/** Spaltentitel der ersten Spalte je nach Periode. */
const FIRST_COL_LABEL: Record<PeriodKind, string> = {
  day: 'Eintrag / Quelle',
  week: 'Wochentag',
  month: 'Tag',
  year: 'Monat',
  range: 'Tag', // Von–Bis: eine Zeile pro Tag (rangeDayBuckets)
};

// ─── Komponente ─────────────────────────────────────────────────────────────────

export default function ProduktDetail() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { tenantId } = useTenant();

  const productName = searchParams.get('name') ?? '';
  const baseFilters = useMemo(
    () => filtersFromParams((k) => searchParams.get(k)),
    [searchParams],
  );

  // Metrik lokal (Umsatz/Anzahl-Umschalter), initial aus URL
  const [metric, setMetric] = useState<Metric>(baseFilters.metric);

  const [allRows, setAllRows] = useState<ProductSalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadProductSalesRows(tenantId);
      setAllRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const breakdown = useMemo(
    () => buildBreakdown(allRows, productName, baseFilters.period, baseFilters.category, metric),
    [allRows, productName, baseFilters.period, baseFilters.category, metric],
  );

  const periodKind = baseFilters.period.kind;
  const category = baseFilters.category;

  // Zurück zur Rangliste, Filter (inkl. aktueller Metrik) erhalten
  const goBack = useCallback(() => {
    const params = new URLSearchParams(
      filtersToParams({ period: baseFilters.period, category, metric }),
    );
    navigate(`/produkt-analyse?${params.toString()}`);
  }, [navigate, baseFilters.period, category, metric]);

  // Tabellen-Total
  const totalRevenue = breakdown.totalRevenue;
  const totalQty = breakdown.totalQty;

  function rowLabel(r: BreakdownRow): { main: string; sub?: string } {
    if (periodKind === 'day') {
      return { main: sourceLabel(r.source), sub: undefined };
    }
    return { main: r.label, sub: r.subLabel };
  }

  const noName = !productName;
  const showEmpty = !loading && !error && (breakdown.salesCount === 0);

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">

      {/* Kopf */}
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5 -ml-2 text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          Zurück zur Rangliste
        </Button>

        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Package className="h-5 w-5 text-primary shrink-0" />
            <h1 className="text-xl font-bold truncate">
              {noName ? 'Kein Produkt gewählt' : productName}
            </h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="gap-1 text-xs">
              <Calendar className="h-3 w-3" />
              {PERIOD_KIND_LABEL[periodKind]}: {breakdown.periodLabel}
            </Badge>
            {category !== 'all' && (
              <Badge variant="secondary" className="gap-1 text-xs">
                {category === 'food' ? <Utensils className="h-3 w-3" /> : <Wine className="h-3 w-3" />}
                {CAT_LABEL[category]}
              </Badge>
            )}
            {category === 'all' && (
              <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                <Layers className="h-3 w-3" />
                Alle Kategorien
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Ladezustand / Fehler */}
      {loading && (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
            Lade Verkaufsdaten…
          </CardContent>
        </Card>
      )}
      {error && (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm font-semibold text-destructive mb-1">Fehler beim Laden</p>
            <p className="text-xs text-muted-foreground mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              Erneut versuchen
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && (
        <>
          {/* KPI-Karten */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Card>
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Gesamtumsatz</p>
                <p className="text-2xl font-bold tabular-nums">{fmtChf(totalRevenue)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Gesamtanzahl</p>
                <p className="text-2xl font-bold tabular-nums">{fmtNum(totalQty)}</p>
              </CardContent>
            </Card>
            <Card className="col-span-2 sm:col-span-1">
              <CardContent className="pt-4 pb-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Ø Umsatz / Verkauf</p>
                <p className="text-2xl font-bold tabular-nums">
                  {breakdown.salesCount > 0 ? fmtChf2(breakdown.avgRevenuePerSale) : '–'}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {fmtNum(breakdown.salesCount)} {breakdown.salesCount === 1 ? 'Eintrag' : 'Einträge'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Aufschlüsselung */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
                <span>Aufschlüsselung · {breakdown.periodLabel}</span>
                {/* Metrik-Umschalter steuert die %-Spalte */}
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={metric === 'revenue' ? 'default' : 'outline'}
                    className="h-7 gap-1 text-xs px-2.5"
                    onClick={() => setMetric('revenue')}
                  >
                    <TrendingUp className="h-3.5 w-3.5" />
                    Umsatz
                  </Button>
                  <Button
                    size="sm"
                    variant={metric === 'qty' ? 'default' : 'outline'}
                    className="h-7 gap-1 text-xs px-2.5"
                    onClick={() => setMetric('qty')}
                  >
                    <Hash className="h-3.5 w-3.5" />
                    Anzahl
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>

            <CardContent className="p-0">
              {noName ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Kein Produkt angegeben. Bitte über die Rangliste ein Produkt auswählen.
                </div>
              ) : showEmpty ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Keine Verkäufe für „{productName}" in diesem Zeitraum
                  {category !== 'all' ? ` (Kategorie ${CAT_LABEL[category]})` : ''}.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">
                          {FIRST_COL_LABEL[periodKind]}
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Anzahl</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Umsatz</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
                          % vom Produkt-Total
                          <span className="block font-normal text-[10px] normal-case">
                            ({metric === 'revenue' ? 'Umsatz' : 'Anzahl'})
                          </span>
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">Ø Preis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.rows.map((r) => {
                        const { main, sub } = rowLabel(r);
                        const empty = r.quantity === 0 && r.revenue === 0;
                        return (
                          <tr
                            key={r.key}
                            className={cn('border-b last:border-0', empty ? 'text-muted-foreground/50' : 'hover:bg-muted/30')}
                          >
                            <td className="px-4 py-2 whitespace-nowrap">
                              <span className="font-medium">{main}</span>
                              {sub && <span className="ml-1.5 text-xs text-muted-foreground">{sub}</span>}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.quantity)}</td>
                            <td className={cn('px-4 py-2 text-right tabular-nums', metric === 'revenue' && !empty && 'font-medium')}>
                              {fmtChf(r.revenue)}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              <div className="flex items-center justify-end gap-2">
                                <span className="hidden sm:block w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                  <span
                                    className="block h-full bg-primary/70"
                                    style={{ width: `${Math.min(100, r.share * 100)}%` }}
                                  />
                                </span>
                                <span className={cn('w-14 inline-block', empty ? '' : 'text-foreground')}>
                                  {pctStr(r.share)}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                              {r.avgPrice != null ? fmtChf2(r.avgPrice) : '–'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 bg-muted/50 font-semibold">
                        <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-muted-foreground">Total</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(totalQty)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{fmtChf(totalRevenue)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">100.0 %</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                          {totalQty > 0 ? fmtChf2(totalRevenue / totalQty) : '–'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </CardContent>

            {periodKind === 'day' && !noName && !showEmpty && (
              <div className="px-4 py-2 text-[11px] text-muted-foreground border-t">
                Hinweis: Es liegen keine Uhrzeiten vor — die Tagesansicht zeigt die Einträge pro Quelle.
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
