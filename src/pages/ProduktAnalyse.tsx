/**
 * ProduktAnalyse – Produkt-Rangliste nach Umsatz / Anzahl
 * =========================================================
 * Datenquelle: product_sales (Supabase)
 * Modi: Monatsansicht · Mehrere Monate · Jahresansicht · Kumuliert
 * Anzeigeoptionen: Top 10 · Top 20 · Alle · Flop 20
 * Kategorie: Alle · Food · Beverage
 * Produkte mit Umsatz = 0 werden nie angezeigt.
 * Inline-Spaltenfilter: Suche, min/max Umsatz, min/max Anzahl, Spalten-Sortierung
 * Produkte ausblenden: per Klick auf Mülleimer, mit Reset-Button
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart3, RefreshCw, TrendingUp, Hash, Trash2, RotateCcw, EyeOff,
  Search, X, TrendingDown, Utensils, Wine, Layers, ArrowUpDown, ArrowUp, ArrowDown,
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

type RankRow = { product_name: string; total_revenue: number; total_qty: number };
type SortKey        = 'revenue' | 'qty';
type LimitMode      = 'top10' | 'top20' | 'all' | 'flop20';
type ModeKey        = 'month' | 'multimonth' | 'year' | 'cumulative';
type CategoryFilter = 'all' | 'food' | 'beverage';
type ColSortDir     = 'asc' | 'desc';

const SOURCE_CATEGORY: Record<string, CategoryFilter> = {
  food_csv_export:     'food',
  beverage_csv_export: 'beverage',
};

// ─── RankTable mit Inline-Spaltenfiltern ──────────────────────────────────────

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
  const [colSearch, setColSearch]     = useState('');
  const [minRev,    setMinRev]        = useState('');
  const [maxRev,    setMaxRev]        = useState('');
  const [minQty,    setMinQty]        = useState('');
  const [maxQty,    setMaxQty]        = useState('');
  const [colSortKey, setColSortKey]   = useState<SortKey | null>(null);
  const [colSortDir, setColSortDir]   = useState<ColSortDir>('asc');

  const hasColFilter = !!(colSearch || minRev || maxRev || minQty || maxQty);

  function clearColFilters() {
    setColSearch(''); setMinRev(''); setMaxRev('');
    setMinQty(''); setMaxQty(''); setColSortKey(null);
  }

  function toggleColSort(key: SortKey) {
    if (colSortKey !== key) { setColSortKey(key); setColSortDir('asc'); }
    else if (colSortDir === 'asc') setColSortDir('desc');
    else setColSortKey(null);
  }

  const filteredRows = useMemo(() => {
    let result = [...rows];
    const q = colSearch.trim().toLowerCase();
    if (q) result = result.filter(r => r.product_name.toLowerCase().includes(q));
    const minRevN = parseFloat(minRev);
    const maxRevN = parseFloat(maxRev);
    const minQtyN = parseFloat(minQty);
    const maxQtyN = parseFloat(maxQty);
    if (!isNaN(minRevN)) result = result.filter(r => r.total_revenue >= minRevN);
    if (!isNaN(maxRevN)) result = result.filter(r => r.total_revenue <= maxRevN);
    if (!isNaN(minQtyN)) result = result.filter(r => r.total_qty >= minQtyN);
    if (!isNaN(maxQtyN)) result = result.filter(r => r.total_qty <= maxQtyN);
    if (colSortKey) {
      result.sort((a, b) => {
        const diff = colSortKey === 'revenue'
          ? a.total_revenue - b.total_revenue
          : a.total_qty - b.total_qty;
        return colSortDir === 'asc' ? diff : -diff;
      });
    }
    return result;
  }, [rows, colSearch, minRev, maxRev, minQty, maxQty, colSortKey, colSortDir]);

  function SortIcon({ colKey }: { colKey: SortKey }) {
    if (colSortKey !== colKey)
      return <ArrowUpDown className="h-3 w-3 text-muted-foreground/40 shrink-0" />;
    return colSortDir === 'asc'
      ? <ArrowUp   className="h-3 w-3 text-primary shrink-0" />
      : <ArrowDown className="h-3 w-3 text-primary shrink-0" />;
  }

  const colCount = onHide ? 7 : 6;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          {/* ── Spalten-Header ───────────────────────────────────────── */}
          <tr className="border-b bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
              <button className="flex items-center gap-1 ml-auto" onClick={() => toggleColSort('revenue')}>
                <span className={cn(sortBy === 'revenue' && !colSortKey ? 'text-primary' : '')}>
                  Umsatz (CHF)
                </span>
                <SortIcon colKey="revenue" />
              </button>
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">% Umsatz</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">
              <button className="flex items-center gap-1 ml-auto" onClick={() => toggleColSort('qty')}>
                <span className={cn(sortBy === 'qty' && !colSortKey ? 'text-primary' : '')}>
                  Anzahl
                </span>
                <SortIcon colKey="qty" />
              </button>
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-muted-foreground">% Anzahl</th>
            {onHide && <th className="px-3 py-2.5 w-8" />}
          </tr>

          {/* ── Inline Spaltenfilter ──────────────────────────────────── */}
          <tr className="border-b bg-slate-50/60 dark:bg-muted/20">
            {/* # leer */}
            <td className="px-2 py-1.5" />

            {/* Produktsuche */}
            <td className="px-2 py-1.5">
              <div className="relative">
                <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
                <Input
                  value={colSearch}
                  onChange={e => setColSearch(e.target.value)}
                  placeholder="Produkt suchen…"
                  className="h-6 pl-5 pr-5 text-xs"
                />
                {colSearch && (
                  <button
                    onClick={() => setColSearch('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </td>

            {/* Umsatz min / max */}
            <td className="px-2 py-1.5">
              <div className="flex gap-1 justify-end items-center">
                <Input
                  value={minRev}
                  onChange={e => setMinRev(e.target.value)}
                  placeholder="min"
                  type="number"
                  className="h-6 text-xs w-[60px] text-right"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  value={maxRev}
                  onChange={e => setMaxRev(e.target.value)}
                  placeholder="max"
                  type="number"
                  className="h-6 text-xs w-[60px] text-right"
                />
              </div>
            </td>

            {/* % Umsatz leer */}
            <td className="px-2 py-1.5" />

            {/* Anzahl min / max */}
            <td className="px-2 py-1.5">
              <div className="flex gap-1 justify-end items-center">
                <Input
                  value={minQty}
                  onChange={e => setMinQty(e.target.value)}
                  placeholder="min"
                  type="number"
                  className="h-6 text-xs w-[60px] text-right"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  value={maxQty}
                  onChange={e => setMaxQty(e.target.value)}
                  placeholder="max"
                  type="number"
                  className="h-6 text-xs w-[60px] text-right"
                />
              </div>
            </td>

            {/* % Anzahl leer */}
            <td className="px-2 py-1.5" />

            {/* Filter zurücksetzen */}
            {onHide && (
              <td className="px-2 py-1.5 text-center">
                {(hasColFilter || colSortKey) && (
                  <button
                    onClick={clearColFilters}
                    title="Spaltenfilter zurücksetzen"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            )}
          </tr>
        </thead>

        <tbody>
          {filteredRows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-6 text-center text-xs text-muted-foreground">
                Keine Produkte entsprechen den Filterkriterien.
              </td>
            </tr>
          ) : (
            filteredRows.map((row, idx) => {
              const rank   = idx + 1;
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
                        : 'hover:bg-muted/40',
                  )}
                >
                  {/* Rang */}
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
                  {/* Umsatz */}
                  <td className={cn('px-4 py-2.5 text-right tabular-nums', sortBy === 'revenue' && !colSortKey && 'font-semibold')}>
                    {fmtChf(row.total_revenue)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                    {pct(row.total_revenue, totalRevenue)}
                  </td>
                  {/* Anzahl */}
                  <td className={cn('px-4 py-2.5 text-right tabular-nums', sortBy === 'qty' && !colSortKey && 'font-semibold')}>
                    {fmtNum(row.total_qty)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
                    {pct(row.total_qty, totalQty)}
                  </td>
                  {/* Ausblenden */}
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
            })
          )}
        </tbody>

        <tfoot>
          <tr className="border-t-2 bg-muted/50 font-semibold">
            <td className="px-4 py-2.5" />
            <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-muted-foreground">
              Total ({filteredRows.length}{filteredRows.length !== rows.length ? ` von ${rows.length}` : ''} Produkte)
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              {fmtChf(filteredRows.reduce((s, r) => s + r.total_revenue, 0))}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
              {pct(filteredRows.reduce((s, r) => s + r.total_revenue, 0), totalRevenue)}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums">
              {fmtNum(filteredRows.reduce((s, r) => s + r.total_qty, 0))}
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
              {pct(filteredRows.reduce((s, r) => s + r.total_qty, 0), totalQty)}
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
  const [allRows, setAllRows] = useState<ProductSalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const [mode,           setMode]           = useState<ModeKey>('month');
  const [year,           setYear]           = useState(currentYear);
  const [month,          setMonth]          = useState(currentMonth);
  const [multiYear,      setMultiYear]      = useState(currentYear);
  const [selectedMonths, setSelectedMonths] = useState<Set<number>>(new Set([currentMonth]));
  const [yearFrom,       setYearFrom]       = useState(currentYear);
  const [monthFrom,      setMonthFrom]      = useState(1);
  const [yearTo,         setYearTo]         = useState(currentYear);
  const [monthTo,        setMonthTo]        = useState(currentMonth);
  const [sortBy,         setSortBy]         = useState<SortKey>('revenue');
  const [limitMode,      setLimitMode]      = useState<LimitMode>('top10');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');

  // Ausgeblendete Produkte (nur diese Session)
  const [hiddenProducts, setHiddenProducts] = useState<Set<string>>(new Set());

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

  const toggleMonth    = (m: number) => {
    setSelectedMonths(prev => {
      const next = new Set(prev);
      if (next.has(m)) { if (next.size === 1) return prev; next.delete(m); }
      else next.add(m);
      return next;
    });
  };
  const selectAllMonths  = () => setSelectedMonths(new Set([1,2,3,4,5,6,7,8,9,10,11,12]));
  const selectOnlyMonth  = (m: number) => setSelectedMonths(new Set([m]));

  // ── Aggregierte Rangliste (nur Umsatz > 0, ausgeblendete Produkte raus) ──────

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
      const from    = `${yearFrom}-${String(monthFrom).padStart(2, '0')}-01`;
      const lastDay = new Date(yearTo, monthTo, 0).getDate();
      const to      = `${yearTo}-${String(monthTo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      filtered = filtered.filter(r => r.sale_date >= from && r.sale_date <= to);
    }

    // Kategorie-Filter (via source-Feld)
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(r => {
        const cat = r.source ? (SOURCE_CATEGORY[r.source] ?? null) : null;
        return cat === categoryFilter;
      });
    }

    // Aggregieren (ohne ausgeblendete Produkte)
    const map = new Map<string, RankRow>();
    for (const r of filtered) {
      if (hiddenProducts.has(r.product_name)) continue;
      const existing = map.get(r.product_name);
      if (existing) {
        existing.total_revenue += Number(r.revenue  ?? 0);
        existing.total_qty     += Number(r.quantity ?? 0);
      } else {
        map.set(r.product_name, {
          product_name:  r.product_name,
          total_revenue: Number(r.revenue  ?? 0),
          total_qty:     Number(r.quantity ?? 0),
        });
      }
    }

    // Produkte mit Umsatz = 0 ausblenden (immer, in allen Ansichten)
    const arr = Array.from(map.values()).filter(r => r.total_revenue > 0);

    // Standard-Sortierung (absteigende Rangliste)
    arr.sort((a, b) =>
      sortBy === 'revenue'
        ? b.total_revenue - a.total_revenue
        : b.total_qty    - a.total_qty,
    );
    return arr;
  }, [allRows, mode, year, month, multiYear, selectedMonths, yearFrom, monthFrom, yearTo, monthTo, sortBy, hiddenProducts, categoryFilter]);

  // ── Angezeigte Zeilen (je nach Modus) ────────────────────────────────────────

  const displayed = useMemo<RankRow[]>(() => {
    if (limitMode === 'top10') return ranked.slice(0, 10);
    if (limitMode === 'top20') return ranked.slice(0, 20);
    if (limitMode === 'flop20') {
      // Aufsteigend nach sortBy → schwächste zuerst (nur Umsatz > 0 bereits garantiert)
      const copy = [...ranked];
      copy.sort((a, b) =>
        sortBy === 'revenue'
          ? a.total_revenue - b.total_revenue
          : a.total_qty    - b.total_qty,
      );
      return copy.slice(0, Math.min(20, copy.length));
    }
    return ranked; // 'all'
  }, [ranked, limitMode, sortBy]);

  const isFlop = limitMode === 'flop20';

  const totalRevenue = ranked.reduce((s, r) => s + r.total_revenue, 0);
  const totalQty     = ranked.reduce((s, r) => s + r.total_qty,     0);

  // ── Perioden-Label ────────────────────────────────────────────────────────────

  const periodLabel = useMemo(() => {
    if (mode === 'month') return `${MONTH_NAMES[month - 1]} ${year}`;
    if (mode === 'year')  return String(year);
    if (mode === 'multimonth') {
      const sorted = Array.from(selectedMonths).sort((a, b) => a - b);
      if (sorted.length === 12) return `Ganzes Jahr ${multiYear}`;
      if (sorted.length === 1)  return `${MONTH_NAMES[sorted[0] - 1]} ${multiYear}`;
      return `${sorted.map(m => MONTH_SHORT[m - 1]).join(', ')} ${multiYear}`;
    }
    return `${MONTH_NAMES[monthFrom - 1]} ${yearFrom} – ${MONTH_NAMES[monthTo - 1]} ${yearTo}`;
  }, [mode, year, month, multiYear, selectedMonths, yearFrom, monthFrom, yearTo, monthTo]);

  const hideProduct = (name: string) => setHiddenProducts(prev => new Set([...prev, name]));
  const resetHidden = () => setHiddenProducts(new Set());

  const catLabel: Record<CategoryFilter, string> = { all: 'Alle', food: 'Food', beverage: 'Beverage' };

  // Titel der Ranglisten-Karte
  const tableTitle = useMemo(() => {
    if (isFlop) return `Flop ${Math.min(20, ranked.length)} – schwächste nach ${sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}`;
    const prefix = limitMode === 'all' ? 'Alle Produkte' : `Top ${limitMode === 'top10' ? 10 : 20} Produkte`;
    return `${prefix} – sortiert nach ${sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}`;
  }, [isFlop, limitMode, sortBy, ranked.length]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Produkt-Rangliste</h1>
        </div>
        <div className="flex items-center gap-2">
          {hiddenProducts.size > 0 && (
            <Button variant="outline" size="sm" onClick={resetHidden} className="gap-1.5 text-xs text-muted-foreground">
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

          {/* Ansicht */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Ansicht</span>
            <Select value={mode} onValueChange={v => setMode(v as ModeKey)}>
              <SelectTrigger className="h-8 w-[175px] text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="month">Einzelner Monat</SelectItem>
                <SelectItem value="multimonth">Mehrere Monate</SelectItem>
                <SelectItem value="year">Jahresansicht</SelectItem>
                <SelectItem value="cumulative">Kumuliert (Bereich)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Einzelner Monat */}
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

          {/* Mehrere Monate */}
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
                          : 'bg-background text-muted-foreground border-border hover:bg-muted',
                      )}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Jahresansicht */}
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

          {/* Kumuliert */}
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

          {/* Sortierung */}
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

          {/* Anzeige: Top 10 / Top 20 / Alle / Flop 20 */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Anzeige</span>
            <div className="flex gap-1">
              {(['top10', 'top20', 'all'] as LimitMode[]).map(lm => (
                <Button
                  key={lm}
                  size="sm"
                  variant={limitMode === lm ? 'default' : 'outline'}
                  className="h-8 text-xs px-3"
                  onClick={() => setLimitMode(lm)}
                >
                  {lm === 'all' ? 'Alle' : lm === 'top10' ? 'Top 10' : 'Top 20'}
                </Button>
              ))}
              <Button
                size="sm"
                variant={limitMode === 'flop20' ? 'default' : 'outline'}
                className={cn(
                  'h-8 gap-1 text-xs px-3',
                  limitMode === 'flop20'
                    ? 'bg-red-600 hover:bg-red-700 text-white border-red-600'
                    : 'text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-900/20',
                )}
                onClick={() => setLimitMode('flop20')}
              >
                <TrendingDown className="h-3.5 w-3.5" />
                Flop 20
              </Button>
            </div>
          </div>

          {/* Kategorie */}
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

        </CardContent>
      </Card>

      {/* KPI-Karten (Gesamtwerte der Periode, Umsatz > 0) */}
      {!loading && !error && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3 text-center">
              <p className="text-xs text-muted-foreground mb-1">
                Produkte{categoryFilter !== 'all' ? ` (${catLabel[categoryFilter]})` : ''}
              </p>
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

      {/* Ranglisten-Tabelle */}
      <Card className={cn(isFlop && 'border-red-200 dark:border-red-900/40')}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center justify-between flex-wrap gap-2">
            <span className={cn('flex items-center gap-2', isFlop ? 'text-red-600 dark:text-red-400' : '')}>
              {isFlop
                ? <TrendingDown className="h-4 w-4" />
                : <TrendingUp   className="h-4 w-4 text-primary" />}
              {tableTitle}
            </span>
            <div className="flex items-center gap-2">
              {categoryFilter !== 'all' && (
                <Badge variant="secondary" className="gap-1 text-xs">
                  {categoryFilter === 'food'
                    ? <Utensils className="h-3 w-3" />
                    : <Wine     className="h-3 w-3" />}
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
          {!loading && !error && displayed.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {ranked.length === 0
                ? 'Keine Produkte mit Umsatz > 0 für diesen Zeitraum / diese Kategorie gefunden.'
                : 'Alle Produkte ausgeblendet.'}
            </div>
          )}
          {!loading && !error && displayed.length > 0 && (
            <RankTable
              rows={displayed}
              totalRevenue={totalRevenue}
              totalQty={totalQty}
              sortBy={sortBy}
              flop={isFlop}
              onHide={hideProduct}
            />
          )}
        </CardContent>

        {isFlop && !loading && !error && displayed.length > 0 && (
          <div className="px-4 py-2 text-[11px] text-muted-foreground border-t">
            Flop-Produkte werden nach tiefstem {sortBy === 'revenue' ? 'Umsatz' : 'Verkaufsanzahl'} aufsteigend sortiert.
            Produkte mit Umsatz = CHF 0 werden nie angezeigt.
            {categoryFilter !== 'all' && ` Nur Kategorie: ${catLabel[categoryFilter]}.`}
          </div>
        )}
      </Card>

      {/* Info-Leiste ausgeblendete Produkte */}
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
