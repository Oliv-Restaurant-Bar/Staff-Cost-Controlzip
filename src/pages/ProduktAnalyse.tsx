/**
 * ProduktAnalyse – Produkt-Rangliste nach Umsatz / Anzahl
 * =========================================================
 * Datenquelle: product_sales (Supabase)
 * Modi: Monatsansicht · Jahresansicht · Kumuliert (mehrere Monate)
 * Anzeigeoptionen: Top 10 · Top 20 · Alle
 * Sortierung: Umsatz absteigend · Anzahl absteigend
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart3, RefreshCw, TrendingUp, Hash,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { loadProductSalesRows, type ProductSalesRow } from '@/lib/sales-db';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', maximumFractionDigits: 0,
  }).format(v);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat('de-CH').format(Math.round(v));
}

function pct(part: number, total: number): string {
  if (total === 0) return '0.0 %';
  return `${((part / total) * 100).toFixed(1)} %`;
}

const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function availableYears(rows: ProductSalesRow[]): number[] {
  const years = new Set<number>();
  for (const r of rows) {
    const y = parseInt(r.sale_date.slice(0, 4), 10);
    if (!isNaN(y)) years.add(y);
  }
  return Array.from(years).sort((a, b) => b - a);
}

type RankRow = {
  product_name: string;
  total_revenue: number;
  total_qty: number;
};

type SortKey = 'revenue' | 'qty';
type LimitKey = 10 | 20 | 0;
type ModeKey = 'month' | 'year' | 'cumulative';

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function ProduktAnalyse() {
  const [allRows, setAllRows]   = useState<ProductSalesRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const [mode, setMode]           = useState<ModeKey>('month');
  const [year, setYear]           = useState(currentYear);
  const [month, setMonth]         = useState(currentMonth);
  const [yearFrom, setYearFrom]   = useState(currentYear);
  const [monthFrom, setMonthFrom] = useState(1);
  const [yearTo, setYearTo]       = useState(currentYear);
  const [monthTo, setMonthTo]     = useState(currentMonth);
  const [sortBy, setSortBy]       = useState<SortKey>('revenue');
  const [limit, setLimit]         = useState<LimitKey>(10);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadProductSalesRows();
      setAllRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const years = useMemo(() => availableYears(allRows), [allRows]);

  // ── Gefilterte + aggregierte Rangliste ───────────────────────────────────

  const ranked = useMemo<RankRow[]>(() => {
    let filtered = allRows;

    if (mode === 'month') {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      filtered = filtered.filter(r => r.sale_date.startsWith(prefix));
    } else if (mode === 'year') {
      filtered = filtered.filter(r => r.sale_date.startsWith(String(year)));
    } else {
      // cumulative
      const from = `${yearFrom}-${String(monthFrom).padStart(2, '0')}-01`;
      const toY = yearTo;
      const toM = monthTo;
      const lastDay = new Date(toY, toM, 0).getDate();
      const to = `${toY}-${String(toM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      filtered = filtered.filter(r => r.sale_date >= from && r.sale_date <= to);
    }

    const map = new Map<string, RankRow>();
    for (const r of filtered) {
      const existing = map.get(r.product_name);
      if (existing) {
        existing.total_revenue += Number(r.revenue ?? 0);
        existing.total_qty     += Number(r.quantity ?? 0);
      } else {
        map.set(r.product_name, {
          product_name:  r.product_name,
          total_revenue: Number(r.revenue ?? 0),
          total_qty:     Number(r.quantity ?? 0),
        });
      }
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) =>
      sortBy === 'revenue'
        ? b.total_revenue - a.total_revenue
        : b.total_qty - a.total_qty
    );
    return arr;
  }, [allRows, mode, year, month, yearFrom, monthFrom, yearTo, monthTo, sortBy]);

  const displayed = limit === 0 ? ranked : ranked.slice(0, limit);

  const totalRevenue = ranked.reduce((s, r) => s + r.total_revenue, 0);
  const totalQty     = ranked.reduce((s, r) => s + r.total_qty, 0);

  // ── Perioden-Label ───────────────────────────────────────────────────────

  const periodLabel = useMemo(() => {
    if (mode === 'month') return `${MONTH_NAMES[month - 1]} ${year}`;
    if (mode === 'year')  return String(year);
    return `${MONTH_NAMES[monthFrom - 1]} ${yearFrom} – ${MONTH_NAMES[monthTo - 1]} ${yearTo}`;
  }, [mode, year, month, yearFrom, monthFrom, yearTo, monthTo]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Produkt-Rangliste</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Aktualisieren
        </Button>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="pt-4 pb-3 flex flex-wrap gap-3 items-end">
          {/* Mode */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Ansicht</span>
            <Select value={mode} onValueChange={v => setMode(v as ModeKey)}>
              <SelectTrigger className="h-8 w-[155px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Monatsansicht</SelectItem>
                <SelectItem value="year">Jahresansicht</SelectItem>
                <SelectItem value="cumulative">Kumuliert</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Month controls */}
          {mode === 'month' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                  <SelectTrigger className="h-8 w-[90px] text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(years.length ? years : [currentYear]).map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Monat</span>
                <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
                  <SelectTrigger className="h-8 w-[130px] text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Year controls */}
          {mode === 'year' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Jahr</span>
              <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                <SelectTrigger className="h-8 w-[90px] text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(years.length ? years : [currentYear]).map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Cumulative controls */}
          {mode === 'cumulative' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Von Monat</span>
                <div className="flex gap-1">
                  <Select value={String(monthFrom)} onValueChange={v => setMonthFrom(Number(v))}>
                    <SelectTrigger className="h-8 w-[120px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(yearFrom)} onValueChange={v => setYearFrom(Number(v))}>
                    <SelectTrigger className="h-8 w-[80px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(years.length ? years : [currentYear]).map(y => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Bis Monat</span>
                <div className="flex gap-1">
                  <Select value={String(monthTo)} onValueChange={v => setMonthTo(Number(v))}>
                    <SelectTrigger className="h-8 w-[120px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(yearTo)} onValueChange={v => setYearTo(Number(v))}>
                    <SelectTrigger className="h-8 w-[80px] text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(years.length ? years : [currentYear]).map(y => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          {/* Sort */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Sortierung</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={sortBy === 'revenue' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => setSortBy('revenue')}
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Umsatz
              </Button>
              <Button
                size="sm"
                variant={sortBy === 'qty' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => setSortBy('qty')}
              >
                <Hash className="h-3.5 w-3.5" />
                Anzahl
              </Button>
            </div>
          </div>

          {/* Limit */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Anzeige</span>
            <div className="flex gap-1">
              {([10, 20, 0] as LimitKey[]).map(l => (
                <Button
                  key={l}
                  size="sm"
                  variant={limit === l ? 'default' : 'outline'}
                  className="h-8 text-xs px-3"
                  onClick={() => setLimit(l)}
                >
                  {l === 0 ? 'Alle' : `Top ${l}`}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      {!loading && !error && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Produkte gesamt</p>
              <p className="text-2xl font-bold tabular-nums">{fmtNum(ranked.length)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{periodLabel}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Gesamtumsatz</p>
              <p className="text-2xl font-bold tabular-nums">{fmtChf(totalRevenue)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{periodLabel}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Gesamtanzahl</p>
              <p className="text-2xl font-bold tabular-nums">{fmtNum(totalQty)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{periodLabel}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center justify-between">
            <span>
              {limit === 0 ? 'Alle Produkte' : `Top ${limit} Produkte`}
              {' '}– sortiert nach {sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}
            </span>
            <Badge variant="secondary" className="text-xs font-normal">
              {periodLabel}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2" />
              Lade Verkaufsdaten…
            </div>
          )}
          {error && (
            <div className="p-6 text-center">
              <p className="text-sm font-semibold text-destructive mb-1">Fehler beim Laden</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          )}
          {!loading && !error && displayed.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Keine Daten für diesen Zeitraum gefunden.
            </div>
          )}
          {!loading && !error && displayed.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
                      <span className={cn(sortBy === 'revenue' && 'text-primary')}>Umsatz (CHF)</span>
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
                      <span className={cn(sortBy === 'revenue' && 'text-muted-foreground')}>% Umsatz</span>
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
                      <span className={cn(sortBy === 'qty' && 'text-primary')}>Anzahl</span>
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
                      <span className={cn(sortBy === 'qty' && 'text-muted-foreground')}>% Anzahl</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((row, idx) => {
                    const rank = idx + 1;
                    const isTop3 = rank <= 3;
                    return (
                      <tr
                        key={row.product_name}
                        className={cn(
                          'border-b last:border-0 transition-colors',
                          isTop3
                            ? 'bg-primary/5 hover:bg-primary/10'
                            : 'hover:bg-muted/40'
                        )}
                      >
                        {/* Rank */}
                        <td className="px-4 py-2.5 text-center">
                          {rank === 1 && (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-400 text-white text-xs font-black">1</span>
                          )}
                          {rank === 2 && (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-300 text-slate-700 text-xs font-black">2</span>
                          )}
                          {rank === 3 && (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-600 text-white text-xs font-black">3</span>
                          )}
                          {rank > 3 && (
                            <span className="text-muted-foreground tabular-nums">{rank}</span>
                          )}
                        </td>
                        {/* Name */}
                        <td className={cn('px-4 py-2.5 font-medium', isTop3 && 'font-semibold')}>
                          {row.product_name}
                        </td>
                        {/* Revenue */}
                        <td className={cn(
                          'px-4 py-2.5 text-right tabular-nums',
                          sortBy === 'revenue' && 'font-semibold'
                        )}>
                          {fmtChf(row.total_revenue)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                          {pct(row.total_revenue, totalRevenue)}
                        </td>
                        {/* Qty */}
                        <td className={cn(
                          'px-4 py-2.5 text-right tabular-nums',
                          sortBy === 'qty' && 'font-semibold'
                        )}>
                          {fmtNum(row.total_qty)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                          {pct(row.total_qty, totalQty)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* Total footer */}
                <tfoot>
                  <tr className="border-t-2 bg-muted/50 font-semibold">
                    <td className="px-4 py-2.5" />
                    <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-muted-foreground">
                      {limit === 0 ? 'Total' : `Top ${displayed.length} von ${ranked.length}`}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {fmtChf(displayed.reduce((s, r) => s + r.total_revenue, 0))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                      {pct(displayed.reduce((s, r) => s + r.total_revenue, 0), totalRevenue)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {fmtNum(displayed.reduce((s, r) => s + r.total_qty, 0))}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                      {pct(displayed.reduce((s, r) => s + r.total_qty, 0), totalQty)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
