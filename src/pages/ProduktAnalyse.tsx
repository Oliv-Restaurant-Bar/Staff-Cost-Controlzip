/**
 * ProduktAnalyse – Produkt-Rangliste nach Umsatz / Anzahl
 * =========================================================
 * Datenquelle: product_sales (Supabase)
 * Modi: Monatsansicht · Mehrere Monate · Jahresansicht · Kumuliert
 * Anzeigeoptionen: Top 10 · Top 20 · Alle
 * Sortierung: Umsatz absteigend · Anzahl absteigend
 * Kategorie: Alle · Food · Beverage  (via source-Feld)
 * Flop 20: umsatzschwächste / anzahlschwächste Produkte
 * Produkte ausblenden: per Klick auf Mülleimer, mit Reset-Button
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart3, RefreshCw, TrendingUp, Hash, Trash2, RotateCcw, EyeOff,
  Search, X, TrendingDown, ChevronDown, ChevronUp, Utensils, Wine, Layers,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
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

type SortKey       = 'revenue' | 'qty';
type LimitKey      = 10 | 20 | 0;
type ModeKey       = 'month' | 'multimonth' | 'year' | 'cumulative';
type CategoryFilter = 'all' | 'food' | 'beverage';
type FlopSortKey   = 'revenue' | 'qty';

// Maps source string → CategoryFilter
const SOURCE_CATEGORY: Record<string, CategoryFilter> = {
  food_csv_export:     'food',
  beverage_csv_export: 'beverage',
};

// ─── RankTable: wiederverwendbare Tabelle ─────────────────────────────────────

function RankTable({
  rows,
  totalRevenue,
  totalQty,
  sortBy,
  flop = false,
  onHide,
}: {
  rows: RankRow[];
  totalRevenue: number;
  totalQty: number;
  sortBy: SortKey;
  flop?: boolean;
  onHide?: (name: string) => void;
}) {
  return (
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
            {onHide && <th className="px-3 py-2.5 w-8" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const rank = idx + 1;
            const isTop3 = !flop && rank <= 3;
            return (
              <tr
                key={row.product_name}
                className={cn(
                  'border-b last:border-0 transition-colors group',
                  flop
                    ? 'hover:bg-red-50/40 dark:hover:bg-red-900/10'
                    : isTop3
                      ? 'bg-primary/5 hover:bg-primary/10'
                      : 'hover:bg-muted/40'
                )}
              >
                {/* Rank */}
                <td className="px-4 py-2.5 text-center">
                  {!flop && rank === 1 && (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-yellow-400 text-white text-xs font-black">1</span>
                  )}
                  {!flop && rank === 2 && (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-300 text-slate-700 text-xs font-black">2</span>
                  )}
                  {!flop && rank === 3 && (
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-600 text-white text-xs font-black">3</span>
                  )}
                  {(flop || rank > 3) && (
                    <span className={cn('tabular-nums', flop ? 'text-red-400 dark:text-red-500 font-medium' : 'text-muted-foreground')}>
                      {flop ? `–${rank}` : rank}
                    </span>
                  )}
                </td>
                {/* Name */}
                <td className={cn('px-4 py-2.5', isTop3 ? 'font-semibold' : 'font-medium')}>
                  {row.product_name}
                </td>
                {/* Revenue */}
                <td className={cn('px-4 py-2.5 text-right tabular-nums', sortBy === 'revenue' && 'font-semibold')}>
                  {fmtChf(row.total_revenue)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                  {pct(row.total_revenue, totalRevenue)}
                </td>
                {/* Qty */}
                <td className={cn('px-4 py-2.5 text-right tabular-nums', sortBy === 'qty' && 'font-semibold')}>
                  {fmtNum(row.total_qty)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                  {pct(row.total_qty, totalQty)}
                </td>
                {/* Hide */}
                {onHide && (
                  <td className="px-3 py-2.5 text-center">
                    <button
                      onClick={() => onHide(row.product_name)}
                      title={`"${row.product_name}" aus Rangliste entfernen`}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 bg-muted/50 font-semibold">
            <td className="px-4 py-2.5" />
            <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-muted-foreground">
              Total ({rows.length} Produkte)
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              {fmtChf(rows.reduce((s, r) => s + r.total_revenue, 0))}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
              {pct(rows.reduce((s, r) => s + r.total_revenue, 0), totalRevenue)}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              {fmtNum(rows.reduce((s, r) => s + r.total_qty, 0))}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
              {pct(rows.reduce((s, r) => s + r.total_qty, 0), totalQty)}
            </td>
            {onHide && <td className="px-3 py-2.5" />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

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
  const [multiYear, setMultiYear] = useState(currentYear);
  const [selectedMonths, setSelectedMonths] = useState<Set<number>>(
    new Set([currentMonth])
  );
  const [yearFrom, setYearFrom]   = useState(currentYear);
  const [monthFrom, setMonthFrom] = useState(1);
  const [yearTo, setYearTo]       = useState(currentYear);
  const [monthTo, setMonthTo]     = useState(currentMonth);
  const [sortBy, setSortBy]       = useState<SortKey>('revenue');
  const [limit, setLimit]         = useState<LimitKey>(10);

  // NEU: Kategorie-Filter
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');

  // NEU: Flop-Bereich
  const [flopOpen, setFlopOpen]       = useState(false);
  const [flopSort, setFlopSort]       = useState<FlopSortKey>('revenue');
  const FLOP_COUNT = 20;

  // Ausgeblendete Produkte
  const [hiddenProducts, setHiddenProducts] = useState<Set<string>>(new Set());

  // Produktsuche
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Monate umschalten
  const toggleMonth = (m: number) => {
    setSelectedMonths(prev => {
      const next = new Set(prev);
      if (next.has(m)) {
        if (next.size === 1) return prev;
        next.delete(m);
      } else {
        next.add(m);
      }
      return next;
    });
  };

  const selectAllMonths  = () => setSelectedMonths(new Set([1,2,3,4,5,6,7,8,9,10,11,12]));
  const selectOnlyMonth  = (m: number) => setSelectedMonths(new Set([m]));

  // ── Gefilterte + aggregierte Rangliste ────────────────────────────────────

  const ranked = useMemo<RankRow[]>(() => {
    let filtered = allRows;

    // Zeitraum-Filter
    if (mode === 'month') {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      filtered = filtered.filter(r => r.sale_date.startsWith(prefix));
    } else if (mode === 'multimonth') {
      const yearStr = String(multiYear);
      filtered = filtered.filter(r => {
        if (!r.sale_date.startsWith(yearStr)) return false;
        const m = parseInt(r.sale_date.slice(5, 7), 10);
        return selectedMonths.has(m);
      });
    } else if (mode === 'year') {
      filtered = filtered.filter(r => r.sale_date.startsWith(String(year)));
    } else {
      const from = `${yearFrom}-${String(monthFrom).padStart(2, '0')}-01`;
      const lastDay = new Date(yearTo, monthTo, 0).getDate();
      const to = `${yearTo}-${String(monthTo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      filtered = filtered.filter(r => r.sale_date >= from && r.sale_date <= to);
    }

    // NEU: Kategorie-Filter (via source-Feld)
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(r => {
        const cat = r.source ? (SOURCE_CATEGORY[r.source] ?? null) : null;
        return cat === categoryFilter;
      });
    }

    // Aggregieren
    const map = new Map<string, RankRow>();
    for (const r of filtered) {
      if (hiddenProducts.has(r.product_name)) continue;
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
  }, [allRows, mode, year, month, multiYear, selectedMonths, yearFrom, monthFrom, yearTo, monthTo, sortBy, hiddenProducts, categoryFilter]);

  // Top-Liste (mit Limit)
  const displayed = limit === 0 ? ranked : ranked.slice(0, limit);

  // Suchfilter
  const q = searchQuery.trim().toLowerCase();
  const filteredDisplayed = q
    ? displayed.filter(r => r.product_name.toLowerCase().includes(q))
    : displayed;

  const totalRevenue = ranked.reduce((s, r) => s + r.total_revenue, 0);
  const totalQty     = ranked.reduce((s, r) => s + r.total_qty, 0);

  // NEU: Flop 20 — aufsteigend sortiert nach flopSort
  const flop20 = useMemo<RankRow[]>(() => {
    const copy = [...ranked];
    copy.sort((a, b) =>
      flopSort === 'revenue'
        ? a.total_revenue - b.total_revenue
        : a.total_qty - b.total_qty
    );
    return copy.slice(0, FLOP_COUNT);
  }, [ranked, flopSort]);

  // ── Perioden-Label ────────────────────────────────────────────────────────

  const periodLabel = useMemo(() => {
    if (mode === 'month') return `${MONTH_NAMES[month - 1]} ${year}`;
    if (mode === 'year')  return String(year);
    if (mode === 'multimonth') {
      const sorted = Array.from(selectedMonths).sort((a, b) => a - b);
      if (sorted.length === 12) return `Ganzes Jahr ${multiYear}`;
      if (sorted.length === 1) return `${MONTH_NAMES[sorted[0] - 1]} ${multiYear}`;
      const names = sorted.map(m => MONTH_SHORT[m - 1]).join(', ');
      return `${names} ${multiYear}`;
    }
    return `${MONTH_NAMES[monthFrom - 1]} ${yearFrom} – ${MONTH_NAMES[monthTo - 1]} ${yearTo}`;
  }, [mode, year, month, multiYear, selectedMonths, yearFrom, monthFrom, yearTo, monthTo]);

  const hideProduct  = (name: string) => setHiddenProducts(prev => new Set([...prev, name]));
  const resetHidden  = () => setHiddenProducts(new Set());

  // Kategorie-Label für Badges
  const catLabel: Record<CategoryFilter, string> = {
    all:      'Alle',
    food:     'Food',
    beverage: 'Beverage',
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Produkt-Rangliste</h1>
        </div>
        <div className="flex items-center gap-2">
          {hiddenProducts.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={resetHidden}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {hiddenProducts.size} ausgeblendet – zurücksetzen
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Aktualisieren
          </Button>
        </div>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="pt-4 pb-3 flex flex-wrap gap-3 items-end">

          {/* Mode */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Ansicht</span>
            <Select value={mode} onValueChange={v => setMode(v as ModeKey)}>
              <SelectTrigger className="h-8 w-[175px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Einzelner Monat</SelectItem>
                <SelectItem value="multimonth">Mehrere Monate</SelectItem>
                <SelectItem value="year">Jahresansicht</SelectItem>
                <SelectItem value="cumulative">Kumuliert (Bereich)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Single month */}
          {mode === 'month' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                  <SelectTrigger className="h-8 w-[90px] text-sm"><SelectValue /></SelectTrigger>
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
                  <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Multi-month */}
          {mode === 'multimonth' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(multiYear)} onValueChange={v => setMultiYear(Number(v))}>
                  <SelectTrigger className="h-7 w-[80px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(years.length ? years : [currentYear]).map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="ghost" className="h-7 text-xs px-2 text-muted-foreground" onClick={selectAllMonths}>
                  Alle
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {MONTH_SHORT.map((short, i) => {
                  const m = i + 1;
                  const active = selectedMonths.has(m);
                  return (
                    <button
                      key={m}
                      onClick={() => toggleMonth(m)}
                      onDoubleClick={() => selectOnlyMonth(m)}
                      title={`${MONTH_NAMES[i]} – Doppelklick: nur dieser Monat`}
                      className={cn(
                        'h-7 w-10 rounded text-xs font-medium border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:bg-muted'
                      )}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Year */}
          {mode === 'year' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Jahr</span>
              <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                <SelectTrigger className="h-8 w-[90px] text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(years.length ? years : [currentYear]).map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Cumulative */}
          {mode === 'cumulative' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Von Monat</span>
                <div className="flex gap-1">
                  <Select value={String(monthFrom)} onValueChange={v => setMonthFrom(Number(v))}>
                    <SelectTrigger className="h-8 w-[120px] text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(yearFrom)} onValueChange={v => setYearFrom(Number(v))}>
                    <SelectTrigger className="h-8 w-[80px] text-sm"><SelectValue /></SelectTrigger>
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
                    <SelectTrigger className="h-8 w-[120px] text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MONTH_NAMES.map((name, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={String(yearTo)} onValueChange={v => setYearTo(Number(v))}>
                    <SelectTrigger className="h-8 w-[80px] text-sm"><SelectValue /></SelectTrigger>
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

          {/* ── NEU: Kategorie-Filter ── */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Kategorie</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={categoryFilter === 'all' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => setCategoryFilter('all')}
              >
                <Layers className="h-3.5 w-3.5" />
                Alle
              </Button>
              <Button
                size="sm"
                variant={categoryFilter === 'food' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => setCategoryFilter('food')}
              >
                <Utensils className="h-3.5 w-3.5" />
                Food
              </Button>
              <Button
                size="sm"
                variant={categoryFilter === 'beverage' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => setCategoryFilter('beverage')}
              >
                <Wine className="h-3.5 w-3.5" />
                Beverage
              </Button>
            </div>
          </div>

          {/* Suche */}
          <div className="w-full pt-1 border-t border-border/60">
            <div className="relative max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Produkt suchen…"
                className="h-8 pl-8 pr-8 text-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      {!loading && !error && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">Produkte{categoryFilter !== 'all' ? ` (${catLabel[categoryFilter]})` : ''}</p>
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

      {/* ── Top-Tabelle ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
            <span className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              {q
                ? `Suche: "${searchQuery}" – ${filteredDisplayed.length} Treffer`
                : limit === 0 ? 'Alle Produkte' : `Top ${limit} Produkte`}
              {!q && ` – sortiert nach ${sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}`}
            </span>
            <div className="flex items-center gap-2">
              {categoryFilter !== 'all' && (
                <Badge variant="secondary" className="gap-1 text-xs">
                  {categoryFilter === 'food' ? <Utensils className="h-3 w-3" /> : <Wine className="h-3 w-3" />}
                  {catLabel[categoryFilter]}
                </Badge>
              )}
              {hiddenProducts.size > 0 && (
                <button
                  onClick={resetHidden}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  title="Alle ausgeblendeten Produkte wieder anzeigen"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  {hiddenProducts.size} ausgeblendet
                </button>
              )}
              <Badge variant="secondary" className="text-xs font-normal">{periodLabel}</Badge>
            </div>
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
          {!loading && !error && filteredDisplayed.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {ranked.length === 0
                ? 'Keine Daten für diesen Zeitraum / diese Kategorie gefunden.'
                : q
                  ? `Kein Produkt enthält "${searchQuery}".`
                  : 'Alle Produkte ausgeblendet.'}
            </div>
          )}
          {!loading && !error && filteredDisplayed.length > 0 && (
            <RankTable
              rows={filteredDisplayed}
              totalRevenue={totalRevenue}
              totalQty={totalQty}
              sortBy={sortBy}
              onHide={hideProduct}
            />
          )}
        </CardContent>
      </Card>

      {/* ── NEU: Flop 20 ─────────────────────────────────────────────────── */}
      {!loading && !error && ranked.length > 0 && (
        <Card className="border-red-200 dark:border-red-900/40">
          <CardHeader className="pb-0 pt-3 px-4">
            <button
              onClick={() => setFlopOpen(p => !p)}
              className="flex w-full items-center justify-between group"
            >
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-600 dark:text-red-400">
                <TrendingDown className="h-4 w-4" />
                Flop {Math.min(FLOP_COUNT, ranked.length)} – schwächste Produkte
                {categoryFilter !== 'all' && (
                  <Badge variant="secondary" className="gap-1 text-xs ml-1">
                    {categoryFilter === 'food' ? <Utensils className="h-3 w-3" /> : <Wine className="h-3 w-3" />}
                    {catLabel[categoryFilter]}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs font-normal">{periodLabel}</Badge>
                {flopOpen
                  ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                }
              </div>
            </button>

            {/* Flop-Sort Toggle — immer sichtbar wenn offen */}
            {flopOpen && (
              <div className="flex items-center gap-2 pt-2 pb-1">
                <span className="text-xs text-muted-foreground font-medium">Sortierung:</span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={flopSort === 'revenue' ? 'default' : 'outline'}
                    className="h-7 gap-1 text-xs px-2.5"
                    onClick={() => setFlopSort('revenue')}
                  >
                    <TrendingDown className="h-3 w-3" />
                    Umsatz schwächste
                  </Button>
                  <Button
                    size="sm"
                    variant={flopSort === 'qty' ? 'default' : 'outline'}
                    className="h-7 gap-1 text-xs px-2.5"
                    onClick={() => setFlopSort('qty')}
                  >
                    <Hash className="h-3 w-3" />
                    Anzahl schwächste
                  </Button>
                </div>
              </div>
            )}
          </CardHeader>

          {flopOpen && (
            <CardContent className="p-0 mt-1">
              {flop20.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Keine Daten vorhanden.
                </p>
              ) : (
                <RankTable
                  rows={flop20}
                  totalRevenue={totalRevenue}
                  totalQty={totalQty}
                  sortBy={flopSort}
                  flop
                />
              )}
              <p className="px-4 py-2 text-[11px] text-muted-foreground border-t">
                Flop-Produkte werden {flopSort === 'revenue' ? 'nach tiefstem Umsatz' : 'nach niedrigster Verkaufsanzahl'} aufsteigend sortiert.
                {categoryFilter !== 'all' && ` Nur Kategorie: ${catLabel[categoryFilter]}.`}
              </p>
            </CardContent>
          )}
        </Card>
      )}

      {/* Ausgeblendete Produkte — Info-Leiste */}
      {hiddenProducts.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-dashed px-4 py-2.5 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <EyeOff className="h-4 w-4" />
            <span>
              <strong>{hiddenProducts.size}</strong>{' '}
              {hiddenProducts.size === 1 ? 'Produkt ausgeblendet' : 'Produkte ausgeblendet'}
              {': '}
              <span className="italic">{Array.from(hiddenProducts).join(', ')}</span>
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={resetHidden} className="gap-1.5 h-7 text-xs">
            <RotateCcw className="h-3.5 w-3.5" />
            Alle einblenden
          </Button>
        </div>
      )}
    </div>
  );
}
