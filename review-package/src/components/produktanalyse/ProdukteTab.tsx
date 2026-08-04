/**
 * ProdukteTab – Produkt-Rangliste (Tab der konsolidierten Produktanalyse)
 * ========================================================================
 * Extrahiert aus der früheren Einzelseite ProduktAnalyse: Rangliste nach
 * Umsatz/Anzahl mit Top/Flop-Auswahl, Inline-Suche, Spalten-Sortierung,
 * Produkte-Ausblenden und Klick-Drilldown auf die Produkt-Detailseite.
 *
 * Periode + Kategorie kommen als Props aus der gemeinsamen Filterleiste
 * des Containers (KEINE eigene Filter-Doppelung); Sortierung und
 * Anzeige-Modus (Top 10/20/Alle/Flop 20) sind tab-spezifische Controls,
 * deren State der Container hält (eine URL-Sync-Stelle).
 *
 * Datenquelle: product_sales-Zeilen als Props (einmal im Container geladen);
 * Aggregation unverändert über die bestehenden reinen Funktionen.
 */

import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw, TrendingUp, Hash, Trash2, RotateCcw, EyeOff,
  Search, X, TrendingDown, Utensils, Wine, ArrowUpDown, ArrowUp, ArrowDown,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ProductSalesRow } from '@/lib/sales-db';
import {
  filterRows, aggregateProducts, aggregateProductsByWeekday, periodLabel as periodLabelOf,
  filtersToParams, isoWeekStart, WEEKDAY_SHORT,
  type PeriodSelection, type CategoryFilter, type Metric,
  type ProductWeekAggregate, type WeekdayBucket,
} from '@/lib/product-analytics';

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

/** 'YYYY-MM-DD' → 'DD.MM.' für kompakte Wochentag-Header. */
function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

type RankRow = { product_name: string; total_revenue: number; total_qty: number };
type SortKey = Metric; // 'revenue' | 'qty'
export type LimitMode = 'top10' | 'top20' | 'all' | 'flop20';
type ColSortDir = 'asc' | 'desc';

export function isLimitMode(v: string | null | undefined): v is LimitMode {
  return v === 'top10' || v === 'top20' || v === 'all' || v === 'flop20';
}

// ─── RankTable mit Inline-Spaltenfiltern ──────────────────────────────────────

function RankTable({
  rows,
  totalRevenue,
  totalQty,
  sortBy,
  flop = false,
  onHide,
  onRowClick,
}: {
  rows: RankRow[];
  totalRevenue: number;
  totalQty: number;
  sortBy: SortKey;
  flop?: boolean;
  onHide?: (name: string) => void;
  onRowClick?: (name: string) => void;
}) {
  const [colSearch, setColSearch]     = useState('');
  const [colSortKey, setColSortKey]   = useState<SortKey | null>(null);
  const [colSortDir, setColSortDir]   = useState<ColSortDir>('asc');

  const hasColFilter = !!colSearch;

  function clearColFilters() {
    setColSearch(''); setColSortKey(null);
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
    if (colSortKey) {
      result.sort((a, b) => {
        const diff = colSortKey === 'revenue'
          ? a.total_revenue - b.total_revenue
          : a.total_qty - b.total_qty;
        return colSortDir === 'asc' ? diff : -diff;
      });
    }
    return result;
  }, [rows, colSearch, colSortKey, colSortDir]);

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
      <table className="w-full text-sm min-w-[480px]">
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

            {/* Umsatz (kein min/max-Filter mehr) */}
            <td className="px-2 py-1.5" />

            {/* % Umsatz leer */}
            <td className="px-2 py-1.5" />

            {/* Anzahl (kein min/max-Filter mehr) */}
            <td className="px-2 py-1.5" />

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
                  onClick={onRowClick ? () => onRowClick(row.product_name) : undefined}
                  title={onRowClick ? `Details zu „${row.product_name}" anzeigen` : undefined}
                  className={cn(
                    'border-b last:border-0 transition-colors group',
                    onRowClick && 'cursor-pointer',
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
                    <span className="inline-flex items-center gap-1">
                      <span className={cn(onRowClick && 'group-hover:underline')}>{row.product_name}</span>
                      {onRowClick && (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </span>
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
                        onClick={(e) => { e.stopPropagation(); onHide(row.product_name); }}
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

// ─── Wochen-Tabelle: kompakte Zelle (Umsatz oben, Anzahl darunter) ────────────

function WeekCell({
  revenue, qty, emphasizeQty, strong = false,
}: {
  revenue: number;
  qty: number;
  emphasizeQty: boolean;
  strong?: boolean;
}) {
  if (revenue === 0 && qty === 0) {
    return <span className="text-muted-foreground/25">–</span>;
  }
  return (
    <div className="leading-tight">
      <div
        className={cn(
          'tabular-nums',
          emphasizeQty
            ? 'text-[10px] text-muted-foreground'
            : cn('text-xs', strong ? 'font-bold' : 'font-medium'),
        )}
      >
        {fmtChf(revenue)}
      </div>
      <div
        className={cn(
          'tabular-nums',
          emphasizeQty
            ? cn('text-xs text-primary', strong ? 'font-bold' : 'font-semibold')
            : 'text-[10px] text-muted-foreground',
        )}
      >
        {fmtNum(qty)} Stk.
      </div>
    </div>
  );
}

// ─── Wochen-Rangliste: Wochentag-Spalten Mo–So + Total ────────────────────────

function WeekRankTable({
  rows,
  weekAgg,
  dayDates,
  sortBy,
  flop = false,
  onHide,
  onRowClick,
}: {
  rows: RankRow[];
  weekAgg: Map<string, ProductWeekAggregate>;
  dayDates: string[]; // 7 ISO-Daten Mo→So
  sortBy: SortKey;
  flop?: boolean;
  onHide?: (name: string) => void;
  onRowClick?: (name: string) => void;
}) {
  const [colSearch, setColSearch] = useState('');
  const emphasizeQty = sortBy === 'qty';

  const filteredRows = useMemo(() => {
    const q = colSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => r.product_name.toLowerCase().includes(q));
  }, [rows, colSearch]);

  const zeroDays: WeekdayBucket[] = useMemo(
    () => dayDates.map((d, i) => ({ date: d, weekdayIndex: i, quantity: 0, revenue: 0 })),
    [dayDates],
  );

  // Spalten-Summen über die gefilterten Zeilen (Wochentag-Totale + Wochen-Total).
  const colTotals = useMemo(() => {
    const days = dayDates.map(() => ({ rev: 0, qty: 0 }));
    let totRev = 0, totQty = 0;
    for (const r of filteredRows) {
      const agg = weekAgg.get(r.product_name);
      if (!agg) continue;
      agg.days.forEach((b, i) => { days[i].rev += b.revenue; days[i].qty += b.quantity; });
      totRev += agg.total_revenue; totQty += agg.total_qty;
    }
    return { days, totRev, totQty };
  }, [filteredRows, weekAgg, dayDates]);

  const colCount = 2 + dayDates.length + 1 + (onHide ? 1 : 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[820px]">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
            <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">Produkt</th>
            {dayDates.map((d, i) => (
              <th key={d} className="px-2 py-2 text-right text-xs font-semibold text-muted-foreground">
                <div>{WEEKDAY_SHORT[i]}</div>
                <div className="text-[10px] font-normal text-muted-foreground/70">{ddmm(d)}</div>
              </th>
            ))}
            <th className="px-3 py-2 text-right text-xs font-semibold border-l">
              <div className={cn(!emphasizeQty && 'text-primary')}>Total</div>
              <div className="text-[10px] font-normal text-muted-foreground/70">
                {emphasizeQty ? 'Anzahl' : 'Umsatz'}
              </div>
            </th>
            {onHide && <th className="px-2 py-2.5 w-8" />}
          </tr>

          {/* Inline Produktsuche (kein min/max-Filter) */}
          <tr className="border-b bg-slate-50/60 dark:bg-muted/20">
            <td className="px-2 py-1.5" />
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
            <td className="px-2 py-1.5" colSpan={dayDates.length + 1} />
            {onHide && <td className="px-2 py-1.5" />}
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
              const days   = weekAgg.get(row.product_name)?.days ?? zeroDays;
              return (
                <tr
                  key={row.product_name}
                  onClick={onRowClick ? () => onRowClick(row.product_name) : undefined}
                  title={onRowClick ? `Details zu „${row.product_name}" anzeigen` : undefined}
                  className={cn(
                    'border-b last:border-0 transition-colors group',
                    onRowClick && 'cursor-pointer',
                    flop
                      ? 'hover:bg-red-50/40 dark:hover:bg-red-900/10'
                      : isTop3
                        ? 'bg-primary/5 hover:bg-primary/10'
                        : 'hover:bg-muted/40',
                  )}
                >
                  {/* Rang */}
                  <td className="px-3 py-2 text-center align-top">
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
                  <td className={cn('px-3 py-2 align-top', isTop3 ? 'font-semibold' : 'font-medium')}>
                    <span className="inline-flex items-center gap-1">
                      <span className={cn(onRowClick && 'group-hover:underline')}>{row.product_name}</span>
                      {onRowClick && (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </span>
                  </td>
                  {/* Wochentage Mo–So */}
                  {days.map((b) => (
                    <td key={b.date} className="px-2 py-2 text-right align-top">
                      <WeekCell revenue={b.revenue} qty={b.quantity} emphasizeQty={emphasizeQty} />
                    </td>
                  ))}
                  {/* Total */}
                  <td className="px-3 py-2 text-right align-top border-l">
                    <WeekCell revenue={row.total_revenue} qty={row.total_qty} emphasizeQty={emphasizeQty} strong />
                  </td>
                  {/* Ausblenden */}
                  {onHide && (
                    <td className="px-2 py-2 text-center align-top">
                      <button
                        onClick={(e) => { e.stopPropagation(); onHide(row.product_name); }}
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
            <td className="px-3 py-2" />
            <td className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground align-top">
              Total ({filteredRows.length}{filteredRows.length !== rows.length ? ` von ${rows.length}` : ''} Produkte)
            </td>
            {colTotals.days.map((t, i) => (
              <td key={dayDates[i]} className="px-2 py-2 text-right align-top">
                <WeekCell revenue={t.rev} qty={t.qty} emphasizeQty={emphasizeQty} />
              </td>
            ))}
            <td className="px-3 py-2 text-right align-top border-l">
              <WeekCell revenue={colTotals.totRev} qty={colTotals.totQty} emphasizeQty={emphasizeQty} strong />
            </td>
            {onHide && <td className="px-2 py-2" />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Tab-Komponente ───────────────────────────────────────────────────────────

export default function ProdukteTab({
  rows: allRows,
  loading,
  error,
  selection,
  categoryFilter,
  sortBy,
  onSortByChange,
  limitMode,
  onLimitModeChange,
}: {
  rows: ProductSalesRow[];
  loading: boolean;
  error: string | null;
  selection: PeriodSelection;
  categoryFilter: CategoryFilter;
  sortBy: Metric;
  onSortByChange: (m: Metric) => void;
  limitMode: LimitMode;
  onLimitModeChange: (m: LimitMode) => void;
}) {
  const navigate = useNavigate();

  // Ausgeblendete Produkte (nur diese Session)
  const [hiddenProducts, setHiddenProducts] = useState<Set<string>>(new Set());

  // ── Aggregierte Rangliste (nur Umsatz > 0, ausgeblendete Produkte raus) ──────
  const ranked = useMemo<RankRow[]>(() => {
    const scoped = filterRows(allRows, selection, categoryFilter);
    const arr = aggregateProducts(scoped)
      .filter(r => r.total_revenue > 0 && !hiddenProducts.has(r.product_name));
    arr.sort((a, b) =>
      sortBy === 'revenue'
        ? b.total_revenue - a.total_revenue
        : b.total_qty    - a.total_qty,
    );
    return arr;
  }, [allRows, selection, categoryFilter, hiddenProducts, sortBy]);

  // ── Angezeigte Zeilen (je nach Modus) ────────────────────────────────────────
  const displayed = useMemo<RankRow[]>(() => {
    if (limitMode === 'top10') return ranked.slice(0, 10);
    if (limitMode === 'top20') return ranked.slice(0, 20);
    if (limitMode === 'flop20') {
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

  const periodLabel = useMemo(() => periodLabelOf(selection), [selection]);

  const hideProduct = (name: string) => setHiddenProducts(prev => new Set([...prev, name]));
  const resetHidden = () => setHiddenProducts(new Set());

  // ── Navigation zur Detailseite (Filter erhalten) ─────────────────────────────
  const openDetail = useCallback((name: string) => {
    const params = new URLSearchParams(
      filtersToParams({ period: selection, category: categoryFilter, metric: sortBy }),
    );
    params.set('name', name);
    navigate(`/produkt-analyse/produkt?${params.toString()}`);
  }, [navigate, selection, categoryFilter, sortBy]);

  const catLabel: Record<CategoryFilter, string> = { all: 'Alle', food: 'Food', beverage: 'Beverage' };

  // Titel der Ranglisten-Karte
  const tableTitle = useMemo(() => {
    if (isFlop) return `Flop ${Math.min(20, ranked.length)} – schwächste nach ${sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}`;
    const prefix = limitMode === 'all' ? 'Alle Produkte' : `Top ${limitMode === 'top10' ? 10 : 20} Produkte`;
    return `${prefix} – sortiert nach ${sortBy === 'revenue' ? 'Umsatz' : 'Anzahl'}`;
  }, [isFlop, limitMode, sortBy, ranked.length]);

  // 7 ISO-Tage (Mo→So) der gewählten Woche — Spaltenköpfe der Wochen-Rangliste.
  const weekDayDates = useMemo<string[]>(() => {
    if (selection.kind !== 'week') return [];
    const monday = isoWeekStart(selection.year, selection.week);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday.getTime());
      d.setUTCDate(monday.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
  }, [selection]);

  // Pro-Produkt-Wochentag-Aggregat (Mo–So) über DENSELBEN Scope wie die Rangliste.
  const weekAgg = useMemo(() => {
    const map = new Map<string, ProductWeekAggregate>();
    if (selection.kind !== 'week') return map;
    const scoped = filterRows(allRows, selection, categoryFilter);
    for (const agg of aggregateProductsByWeekday(scoped, selection.year, selection.week)) {
      map.set(agg.product_name, agg);
    }
    return map;
  }, [allRows, selection, categoryFilter]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5" data-testid="tab-panel-produkte">

      {/* Tab-spezifische Controls: Sortierung + Anzeige + Ausblenden-Reset */}
      <div className="flex flex-wrap gap-3 items-end justify-between">
        <div className="flex flex-wrap gap-3 items-end">
          {/* Sortierung */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground font-medium">Sortierung</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={sortBy === 'revenue' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => onSortByChange('revenue')}
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Umsatz
              </Button>
              <Button
                size="sm"
                variant={sortBy === 'qty' ? 'default' : 'outline'}
                className="h-8 gap-1 text-xs px-3"
                onClick={() => onSortByChange('qty')}
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
                  onClick={() => onLimitModeChange(lm)}
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
                onClick={() => onLimitModeChange('flop20')}
              >
                <TrendingDown className="h-3.5 w-3.5" />
                Flop 20
              </Button>
            </div>
          </div>
        </div>

        {hiddenProducts.size > 0 && (
          <Button variant="outline" size="sm" onClick={resetHidden} className="gap-1.5 text-xs text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
            {hiddenProducts.size} ausgeblendet – zurücksetzen
          </Button>
        )}
      </div>

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
            selection.kind === 'week' ? (
              <WeekRankTable
                rows={displayed}
                weekAgg={weekAgg}
                dayDates={weekDayDates}
                sortBy={sortBy}
                flop={isFlop}
                onHide={hideProduct}
                onRowClick={openDetail}
              />
            ) : (
              <RankTable
                rows={displayed}
                totalRevenue={totalRevenue}
                totalQty={totalQty}
                sortBy={sortBy}
                flop={isFlop}
                onHide={hideProduct}
                onRowClick={openDetail}
              />
            )
          )}
        </CardContent>

        {!loading && !error && displayed.length > 0 && (
          <div className="px-4 py-2 text-[11px] text-muted-foreground border-t">
            {isFlop && (
              <>Flop-Produkte werden nach tiefstem {sortBy === 'revenue' ? 'Umsatz' : 'Verkaufsanzahl'} aufsteigend sortiert. </>
            )}
            Klick auf eine Zeile öffnet die Produkt-Detailansicht.
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
