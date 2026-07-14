/**
 * ProduktAnalyse – Produkt-Rangliste nach Umsatz / Anzahl
 * =========================================================
 * Datenquelle: product_sales (Supabase, unverändert via loadProductSalesRows)
 * Periode: Tag · Woche · Monat · Jahr  (discriminated union in product-analytics.ts)
 * Anzeigeoptionen: Top 10 · Top 20 · Alle · Flop 20
 * Kategorie: Alle · Food · Beverage
 * Produkte mit Umsatz = 0 werden nie angezeigt.
 * Inline-Spaltenfilter: Produktsuche + Spalten-Sortierung (kein min/max mehr).
 * Woche: Navigation per Pfeilen + exakte Datumsspanne ("KW 26 · 22.06.–28.06.2026")
 *        + Schnellwahl; die Wochen-Rangliste zeigt Wochentag-Spalten Mo–So + Total.
 * Produkte ausblenden: per Klick auf Mülleimer, mit Reset-Button
 * Klick auf eine Zeile → Produkt-Detailseite (Drill-down) mit erhaltenen Filtern.
 * Aktive Filter werden in der URL gespiegelt, damit der Zurück-Weg den Kontext herstellt.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  BarChart3, RefreshCw, TrendingUp, Hash, Trash2, RotateCcw, EyeOff,
  Search, X, TrendingDown, Utensils, Wine, Layers, ArrowUpDown, ArrowUp, ArrowDown,
  ChevronRight, ChevronLeft, CalendarDays,
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
import {
  filterRows, aggregateProducts, aggregateProductsByWeekday, periodLabel as periodLabelOf,
  filtersToParams, filtersFromParams, isoWeekInfo, isoWeeksInYear, localISODate,
  weekRangeLabel, shiftIsoWeek, isoWeekStart,
  MONTH_NAMES, WEEKDAY_SHORT, PERIOD_KIND_LABEL,
  type PeriodKind, type PeriodSelection, type CategoryFilter, type Metric, type AnalysisFilters,
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

function availableYears(rows: ProductSalesRow[]): number[] {
  const years = new Set<number>();
  for (const r of rows) {
    const y = parseInt(r.sale_date.slice(0, 4), 10);
    if (!isNaN(y)) years.add(y);
  }
  return Array.from(years).sort((a, b) => b - a);
}

type RankRow = { product_name: string; total_revenue: number; total_qty: number };
type SortKey    = Metric;                                   // 'revenue' | 'qty'
type LimitMode  = 'top10' | 'top20' | 'all' | 'flop20';
type ColSortDir = 'asc' | 'desc';

const PERIOD_KINDS: PeriodKind[] = ['day', 'week', 'month', 'year'];

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

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export default function ProduktAnalyse() {
  const [allRows, setAllRows] = useState<ProductSalesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // Initial-Filter aus der URL lesen (einmalig, refresh-/zurück-fest)
  const seedRef = useRef<AnalysisFilters | null>(null);
  if (!seedRef.current) {
    const sp = new URLSearchParams(window.location.search);
    seedRef.current = filtersFromParams((k) => sp.get(k));
  }
  const seed = seedRef.current;
  const seedWeek = isoWeekInfo(localISODate());

  const [periodKind, setPeriodKind] = useState<PeriodKind>(seed.period.kind);
  const [year,  setYear]  = useState<number>(
    seed.period.kind === 'month' || seed.period.kind === 'year' ? seed.period.year : currentYear,
  );
  const [month, setMonth] = useState<number>(
    seed.period.kind === 'month' ? seed.period.month : currentMonth,
  );
  const [day,   setDay]   = useState<string>(
    seed.period.kind === 'day' ? seed.period.date : localISODate(),
  );
  const [weekYear, setWeekYear] = useState<number>(
    seed.period.kind === 'week' ? seed.period.year : seedWeek.year,
  );
  const [week,     setWeek]     = useState<number>(
    seed.period.kind === 'week' ? seed.period.week : seedWeek.week,
  );

  const [sortBy,         setSortBy]         = useState<SortKey>(seed.metric);
  const [limitMode,      setLimitMode]      = useState<LimitMode>(() => {
    const sp = new URLSearchParams(window.location.search);
    const l = sp.get('limit');
    return (l === 'top10' || l === 'top20' || l === 'all' || l === 'flop20') ? l : 'top10';
  });
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(seed.category);

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

  // ── Aktuelle Periode (discriminated union) ───────────────────────────────────
  const selection = useMemo<PeriodSelection>(() => {
    switch (periodKind) {
      case 'day':  return { kind: 'day',  date: day };
      // Clamp gegen 52/53-Wochen-Jahre: nie eine ungültige KW53 in Filter/URL schreiben
      case 'week': return { kind: 'week', year: weekYear, week: Math.min(week, isoWeeksInYear(weekYear)) };
      case 'year': return { kind: 'year', year };
      default:     return { kind: 'month', year, month };
    }
  }, [periodKind, day, weekYear, week, year, month]);

  // ── Filter in die URL spiegeln (für Detail-Round-Trip / Sharing) ─────────────
  useEffect(() => {
    const params = filtersToParams({ period: selection, category: categoryFilter, metric: sortBy });
    params.limit = limitMode;
    setSearchParams(params, { replace: true });
  }, [selection, categoryFilter, sortBy, limitMode, setSearchParams]);

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

  const yearOptions = years.length ? years : [currentYear];

  // ── Wochen-Navigation: exakte Datumsspanne, Schnellsprünge, Wochentag-Aggregat ─
  const weekRange = useMemo(
    () => (selection.kind === 'week' ? weekRangeLabel(selection.year, selection.week) : ''),
    [selection],
  );

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

  const stepWeek = useCallback((delta: number) => {
    if (selection.kind !== 'week') return;
    const next = shiftIsoWeek(selection.year, selection.week, delta);
    setWeekYear(next.year);
    setWeek(next.week);
  }, [selection]);

  const goCurrentWeek = useCallback(() => {
    const info = isoWeekInfo(localISODate());
    setWeekYear(info.year);
    setWeek(info.week);
  }, []);

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
            <Select value={periodKind} onValueChange={v => setPeriodKind(v as PeriodKind)}>
              <SelectTrigger className="h-8 w-[130px] text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIOD_KINDS.map(k => (
                  <SelectItem key={k} value={k}>{PERIOD_KIND_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Tag */}
          {periodKind === 'day' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Datum</span>
              <Input
                type="date"
                value={day}
                onChange={e => setDay(e.target.value || localISODate())}
                className="h-8 w-[160px] text-sm"
              />
            </div>
          )}

          {/* Woche – Navigation mit exakter Datumsspanne (kein KW-Dropdown) */}
          {periodKind === 'week' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(weekYear)} onValueChange={v => setWeekYear(Number(v))}>
                  <SelectTrigger className="h-8 w-[90px] text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {yearOptions.map(y => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Kalenderwoche</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => stepWeek(-1)}
                    title="Vorherige Woche"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="h-8 px-3 min-w-[215px] inline-flex items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-sm font-medium tabular-nums">
                    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    {weekRange}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => stepWeek(1)}
                    title="Nächste Woche"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Schnellwahl</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-8 text-xs gap-1.5" onClick={goCurrentWeek}>
                    <CalendarDays className="h-3.5 w-3.5" />
                    Heute
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={goCurrentWeek}>
                    Diese Woche
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Monat */}
          {periodKind === 'month' && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                  <SelectTrigger className="h-8 w-[90px] text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {yearOptions.map(y => (
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

          {/* Jahr */}
          {periodKind === 'year' && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground font-medium">Jahr</span>
              <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                <SelectTrigger className="h-8 w-[90px] text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
