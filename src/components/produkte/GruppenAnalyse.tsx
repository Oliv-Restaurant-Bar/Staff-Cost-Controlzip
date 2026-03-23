import { useMemo, useState } from 'react';
import { format, parse } from 'date-fns';
import { de } from 'date-fns/locale';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, BarChart3, ChevronDown, Tag,
  Info, AlertCircle, ArrowUpDown,
} from 'lucide-react';
import {
  ProductGroup, ProductEntry, ProductCostEntry,
  computeProductPerformance, computeGroupPerformance,
  saveProductGroupsToDB, ProductPerformanceRow, GroupPerformanceRow,
} from '@/lib/produkte-store';

// ── Constants ─────────────────────────────────────────────────────────────────

const COLOR_CLASSES: Record<string, {
  dot: string; bg: string; text: string; border: string; bar: string;
}> = {
  orange:  { dot: 'bg-orange-400',  bg: 'bg-orange-50 dark:bg-orange-950/30',  text: 'text-orange-700 dark:text-orange-300',  border: 'border-orange-200 dark:border-orange-800',  bar: 'bg-orange-400' },
  yellow:  { dot: 'bg-yellow-400',  bg: 'bg-yellow-50 dark:bg-yellow-950/30',  text: 'text-yellow-700 dark:text-yellow-300',  border: 'border-yellow-200 dark:border-yellow-800',  bar: 'bg-yellow-400' },
  red:     { dot: 'bg-red-400',     bg: 'bg-red-50 dark:bg-red-950/30',        text: 'text-red-700 dark:text-red-300',        border: 'border-red-200 dark:border-red-800',        bar: 'bg-red-400' },
  blue:    { dot: 'bg-blue-400',    bg: 'bg-blue-50 dark:bg-blue-950/30',      text: 'text-blue-700 dark:text-blue-300',      border: 'border-blue-200 dark:border-blue-800',      bar: 'bg-blue-400' },
  green:   { dot: 'bg-green-400',   bg: 'bg-green-50 dark:bg-green-950/30',    text: 'text-green-700 dark:text-green-300',    border: 'border-green-200 dark:border-green-800',    bar: 'bg-green-400' },
  teal:    { dot: 'bg-teal-400',    bg: 'bg-teal-50 dark:bg-teal-950/30',      text: 'text-teal-700 dark:text-teal-300',      border: 'border-teal-200 dark:border-teal-800',      bar: 'bg-teal-400' },
  pink:    { dot: 'bg-pink-400',    bg: 'bg-pink-50 dark:bg-pink-950/30',      text: 'text-pink-700 dark:text-pink-300',      border: 'border-pink-200 dark:border-pink-800',      bar: 'bg-pink-400' },
  purple:  { dot: 'bg-purple-400',  bg: 'bg-purple-50 dark:bg-purple-950/30',  text: 'text-purple-700 dark:text-purple-300',  border: 'border-purple-200 dark:border-purple-800',  bar: 'bg-purple-400' },
  amber:   { dot: 'bg-amber-400',   bg: 'bg-amber-50 dark:bg-amber-950/30',    text: 'text-amber-700 dark:text-amber-300',    border: 'border-amber-200 dark:border-amber-800',    bar: 'bg-amber-400' },
  cyan:    { dot: 'bg-cyan-400',    bg: 'bg-cyan-50 dark:bg-cyan-950/30',      text: 'text-cyan-700 dark:text-cyan-300',      border: 'border-cyan-200 dark:border-cyan-800',      bar: 'bg-cyan-400' },
  brown:   { dot: 'bg-stone-500',   bg: 'bg-stone-50 dark:bg-stone-950/30',    text: 'text-stone-700 dark:text-stone-300',    border: 'border-stone-200 dark:border-stone-800',    bar: 'bg-stone-500' },
  grey:    { dot: 'bg-slate-400',   bg: 'bg-slate-50 dark:bg-slate-950/30',    text: 'text-slate-600 dark:text-slate-400',    border: 'border-slate-200 dark:border-slate-700',    bar: 'bg-slate-400' },
};

function gc(color: string) { return COLOR_CLASSES[color] ?? COLOR_CLASSES.grey; }

const formatCHF = (v: number) =>
  v.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });

const formatPct = (v: number) => `${v.toFixed(1)} %`;

const formatMonthLong = (ym: string) => {
  if (ym === 'alle') return 'Alle Monate';
  try { return format(parse(ym, 'yyyy-MM', new Date()), 'MMMM yyyy', { locale: de }); }
  catch { return ym; }
};

// ── Types ─────────────────────────────────────────────────────────────────────

type SortMode = 'revenue' | 'margin_pct' | 'margin_chf' | 'count';

interface Props {
  entries: ProductEntry[];
  costs: ProductCostEntry[];
  groups: ProductGroup[];
  onGroupsChange: (groups: ProductGroup[]) => void;
  month: string;
  category: 'food' | 'beverage';
  ignoredByUser: string[];
  availableMonths: string[];
  onMonthChange: (m: string) => void;
}

// ── Group badge ───────────────────────────────────────────────────────────────

function GroupBadge({ groupId, groupName, color, small }: {
  groupId: string; groupName: string; color: string; small?: boolean;
}) {
  const c = gc(color);
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border font-medium',
      small ? 'text-[9px] px-1.5 py-0 h-4' : 'text-[10px] px-2 py-0.5',
      c.bg, c.text, c.border,
    )}>
      <span className={cn('rounded-full shrink-0', small ? 'w-1.5 h-1.5' : 'w-2 h-2', c.dot)} />
      {groupName}
    </span>
  );
}

// ── Group selector ────────────────────────────────────────────────────────────

function GroupSelect({
  currentGroupId, groups, category, onSelect,
}: {
  currentGroupId: string | null;
  groups: ProductGroup[];
  category: 'food' | 'beverage';
  onSelect: (groupId: string | null) => void;
}) {
  const visible = groups.filter(g => g.category === category || g.category === 'all');
  return (
    <select
      value={currentGroupId ?? ''}
      onChange={e => onSelect(e.target.value || null)}
      onClick={e => e.stopPropagation()}
      className="h-6 text-[10px] rounded border border-border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
    >
      <option value="">– keine –</option>
      {visible.map(g => (
        <option key={g.id} value={g.id}>{g.name}</option>
      ))}
    </select>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, colorClass,
}: { label: string; value: string; sub?: string; colorClass?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('text-xl font-bold tabular-nums', colorClass ?? 'text-foreground')}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function GruppenAnalyse({
  entries, costs, groups, onGroupsChange,
  month, category, ignoredByUser, availableMonths, onMonthChange,
}: Props) {
  const [sortMode, setSortMode]         = useState<SortMode>('revenue');
  const [showProductList, setShowProd]  = useState(true);
  const [filterGroupId, setFilterGroup] = useState<string | null>(null);
  const [productSortAsc, setProdAsc]    = useState(false);

  // ── Data computation ─────────────────────────────────────────────────────
  const perf = useMemo(() =>
    computeProductPerformance(entries, costs, groups, month, category, ignoredByUser),
    [entries, costs, groups, month, category, ignoredByUser],
  );

  const groupPerf = useMemo(() =>
    computeGroupPerformance(perf, groups),
    [perf, groups],
  );

  const hasWesData     = perf.some(r => r.hasCost);
  const totalRevenue   = perf.reduce((s, r) => s + r.revenue, 0);
  const totalMarginCHF = perf.filter(r => r.hasCost).reduce((s, r) => s + r.totalMargeCHF, 0);
  const withWes        = perf.filter(r => r.hasCost);
  const avgMargePct    = withWes.length > 0
    ? withWes.reduce((s, r) => s + r.margePct, 0) / withWes.length
    : 0;

  const maxGroupRevenue = groupPerf.length > 0
    ? Math.max(...groupPerf.map(g => g.totalRevenue)) : 1;

  // ── Product list (filtered + sorted) ─────────────────────────────────────
  const productRows = useMemo(() => {
    let rows = filterGroupId
      ? perf.filter(r => r.groupId === filterGroupId || (!r.groupId && filterGroupId === '__other__'))
      : perf;
    rows = [...rows].sort((a, b) => {
      let diff = 0;
      if (sortMode === 'revenue')     diff = b.revenue     - a.revenue;
      if (sortMode === 'count')       diff = b.count       - a.count;
      if (sortMode === 'margin_pct')  diff = (b.hasCost ? b.margePct    : -Infinity) - (a.hasCost ? a.margePct    : -Infinity);
      if (sortMode === 'margin_chf')  diff = (b.hasCost ? b.totalMargeCHF : -Infinity) - (a.hasCost ? a.totalMargeCHF : -Infinity);
      return productSortAsc ? -diff : diff;
    });
    return rows;
  }, [perf, filterGroupId, sortMode, productSortAsc]);

  // ── Group assignment handler ──────────────────────────────────────────────
  const assignProductGroup = (productName: string, newGroupId: string | null) => {
    const updated = groups.map(g => {
      const pn = productName.toLowerCase();
      const without = g.productNames.filter(n => n !== pn);
      if (g.id === newGroupId) return { ...g, productNames: [...without, pn] };
      return { ...g, productNames: without };
    });
    onGroupsChange(updated);
    saveProductGroupsToDB(updated);
  };

  // ── Margin color ──────────────────────────────────────────────────────────
  const margePctColor = (pct: number) => {
    if (pct >= 70) return 'text-emerald-600 dark:text-emerald-400';
    if (pct >= 50) return 'text-green-600 dark:text-green-400';
    if (pct >= 30) return 'text-amber-600 dark:text-amber-400';
    return 'text-red-600 dark:text-red-400';
  };

  // ── Sort column button helper ─────────────────────────────────────────────
  const sortBtn = (mode: SortMode, label: string) => (
    <button
      onClick={() => { if (sortMode === mode) setProdAsc(v => !v); else { setSortMode(mode); setProdAsc(false); } }}
      className={cn(
        'flex items-center gap-0.5 text-[10px] font-semibold transition-colors',
        sortMode === mode ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <ArrowUpDown className={cn('h-2.5 w-2.5', sortMode === mode && 'text-primary')} />
    </button>
  );

  // ── No data ───────────────────────────────────────────────────────────────
  if (perf.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
        <BarChart3 className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm font-semibold text-muted-foreground">Keine Produktdaten für diesen Zeitraum</p>
        <p className="text-xs text-muted-foreground">Wähle einen anderen Monat oder importiere Daten.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Monat-Wahl + Info ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Zeitraum:</span>
          <select
            value={month}
            onChange={e => onMonthChange(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="alle">Alle Monate</option>
            {[...availableMonths].reverse().map(m => (
              <option key={m} value={m}>{formatMonthLong(m)}</option>
            ))}
          </select>
        </div>
        {!hasWesData && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded-lg px-2.5 py-1">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Keine WES-Preisdaten — Margen werden angezeigt sobald WES-Daten importiert oder eingetragen sind.
          </div>
        )}
      </div>

      {/* ── KPI row ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Umsatz gesamt"
          value={formatCHF(totalRevenue)}
          sub={`${perf.length} Produkte`}
        />
        <KpiCard
          label="Mit WES-Daten"
          value={`${perf.filter(r => r.hasCost).length}`}
          sub={`von ${perf.length} Produkten`}
          colorClass={hasWesData ? 'text-purple-600 dark:text-purple-400' : 'text-muted-foreground'}
        />
        <KpiCard
          label="Ø Marge"
          value={hasWesData ? formatPct(avgMargePct) : '–'}
          sub={hasWesData ? (avgMargePct >= 60 ? 'Gut' : avgMargePct >= 40 ? 'Mittel' : 'Tief') : 'Kein WES'}
          colorClass={hasWesData ? margePctColor(avgMargePct) : 'text-muted-foreground'}
        />
        <KpiCard
          label="Deckungsbeitrag total"
          value={hasWesData ? formatCHF(totalMarginCHF) : '–'}
          sub={hasWesData ? `${formatPct((totalMarginCHF / totalRevenue) * 100)} vom Umsatz` : 'Kein WES'}
          colorClass={hasWesData ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}
        />
      </div>

      {/* ── Kategorien-Tabelle ───────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="bg-muted/40 px-4 py-2.5 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Gruppen-Performance</span>
            <span className="text-xs text-muted-foreground">· {groupPerf.length} aktive Gruppen</span>
          </div>
          {filterGroupId && (
            <button onClick={() => setFilterGroup(null)}
              className="text-[10px] text-primary underline-offset-2 hover:underline">
              Filter zurücksetzen
            </button>
          )}
        </div>

        {/* Group rows */}
        <div className="divide-y divide-border/50">
          {groupPerf.map(g => {
            const c       = gc(g.color);
            const barPct  = maxGroupRevenue > 0 ? (g.totalRevenue / maxGroupRevenue) * 100 : 0;
            const isFiltered = filterGroupId === g.groupId;
            return (
              <div key={g.groupId}
                onClick={() => setFilterGroup(isFiltered ? null : g.groupId)}
                className={cn(
                  'px-4 py-3 cursor-pointer transition-colors',
                  isFiltered ? cn(c.bg, 'border-l-2', c.border.replace('border-', 'border-l-')) : 'hover:bg-muted/30',
                )}>
                <div className="flex items-center gap-3">
                  {/* Group name */}
                  <div className="flex items-center gap-2 min-w-[130px]">
                    <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', c.dot)} />
                    <span className="text-xs font-semibold truncate">{g.groupName}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">({g.productCount})</span>
                  </div>

                  {/* Revenue bar */}
                  <div className="flex-1 space-y-0.5 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div className={cn('h-full rounded-full transition-all', c.bar)}
                          style={{ width: `${barPct}%` }} />
                      </div>
                      <span className="text-xs font-semibold tabular-nums shrink-0 w-20 text-right">
                        {formatCHF(g.totalRevenue)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 ml-0">
                      <span className="text-[9px] text-muted-foreground tabular-nums">
                        {formatPct(g.revenueShare)} Anteil
                      </span>
                      <span className="text-[9px] text-muted-foreground">·</span>
                      <span className="text-[9px] text-muted-foreground tabular-nums">
                        {g.totalCount.toLocaleString('de-CH')} Stück
                      </span>
                    </div>
                  </div>

                  {/* Margin column */}
                  {hasWesData && (
                    <div className="text-right min-w-[80px] shrink-0">
                      {g.withCostCount > 0 ? (
                        <>
                          <p className={cn('text-xs font-bold tabular-nums', margePctColor(g.avgMargePct))}>
                            {formatPct(g.avgMargePct)}
                          </p>
                          <p className="text-[9px] text-muted-foreground tabular-nums">
                            {formatCHF(g.totalMargeCHF)} DB
                          </p>
                        </>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">kein WES</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {groupPerf.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Keine Gruppen erkannt — Produkte werden automatisch klassifiziert.
          </div>
        )}

        <div className="px-4 py-2 border-t border-border/50 bg-muted/20">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Info className="h-3 w-3" />
            Auf eine Gruppe klicken filtert die Produktliste unten. Gruppen werden automatisch erkannt — manuelle Zuweisung über das Dropdown.
          </p>
        </div>
      </div>

      {/* ── Produktliste ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border overflow-hidden">
        <button
          onClick={() => setShowProd(v => !v)}
          className="w-full flex items-center justify-between bg-muted/40 px-4 py-2.5 border-b border-border hover:bg-muted/60 transition-colors"
        >
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">
              Produkte
              {filterGroupId && groupPerf.find(g => g.groupId === filterGroupId) && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  · {groupPerf.find(g => g.groupId === filterGroupId)?.groupName}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{productRows.length} Einträge</span>
          </div>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', showProductList && 'rotate-180')} />
        </button>

        {showProductList && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-2 text-left text-[10px] font-semibold text-muted-foreground w-7">#</th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold text-muted-foreground">Produkt</th>
                  <th className="px-2 py-2 text-left text-[10px] font-semibold text-muted-foreground min-w-[110px]">Gruppe</th>
                  <th className="px-3 py-2 text-right">{sortBtn('count',       'Anzahl')}</th>
                  <th className="px-3 py-2 text-right">{sortBtn('revenue',     'Umsatz')}</th>
                  <th className="px-3 py-2 text-right text-[10px] font-semibold text-muted-foreground">Anteil</th>
                  {hasWesData && (
                    <>
                      <th className="px-3 py-2 text-right">{sortBtn('margin_pct', 'Marge %')}</th>
                      <th className="px-3 py-2 text-right">{sortBtn('margin_chf', 'DB total')}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {productRows.map((row, i) => {
                  const grp = row.groupId && row.groupName
                    ? groups.find(g => g.id === row.groupId)
                    : null;
                  return (
                    <tr key={row.name}
                      className="border-b border-border/40 hover:bg-muted/20 transition-colors group/row">
                      <td className="px-4 py-2 text-muted-foreground tabular-nums text-center">{i + 1}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium truncate block max-w-[200px]">{row.name}</span>
                        {row.bruttoPrice > 0 && (
                          <span className="text-[9px] text-muted-foreground tabular-nums">
                            VK {row.bruttoPrice.toFixed(2)} ·{' '}
                            WES {row.wes.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {grp ? (
                            <GroupBadge
                              groupId={grp.id}
                              groupName={grp.name}
                              color={grp.color}
                              small
                            />
                          ) : (
                            <span className="text-[9px] text-muted-foreground italic">auto</span>
                          )}
                          <div className="opacity-0 group-hover/row:opacity-100 transition-opacity">
                            <GroupSelect
                              currentGroupId={row.groupId}
                              groups={groups}
                              category={category}
                              onSelect={gId => assignProductGroup(row.name, gId)}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.count > 0 ? row.count.toLocaleString('de-CH') : '–'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        {row.revenue > 0 ? formatCHF(row.revenue) : '–'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {row.revenueShare > 0 ? `${row.revenueShare.toFixed(1)} %` : '–'}
                        <div className="mt-0.5 ml-auto h-1 rounded-full bg-muted overflow-hidden w-12">
                          <div className="h-full rounded-full bg-primary/30"
                            style={{ width: `${Math.min(row.revenueShare * 4, 100)}%` }} />
                        </div>
                      </td>
                      {hasWesData && (
                        <>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.hasCost ? (
                              <span className={cn('font-semibold', margePctColor(row.margePct))}>
                                {formatPct(row.margePct)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-[9px]">kein WES</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {row.hasCost ? (
                              <span className={cn('font-semibold', margePctColor(row.margePct))}>
                                {formatCHF(row.totalMargeCHF)}
                              </span>
                            ) : '–'}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Margin legend ───────────────────────────────────────────────────── */}
      {hasWesData && (
        <div className="flex items-center gap-4 flex-wrap text-[10px] text-muted-foreground px-1">
          <span className="font-semibold">Margen-Richtwerte:</span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> ≥ 70 % Sehr gut
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> 50–70 % Gut
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> 30–50 % Mittel
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> &lt; 30 % Tief
          </span>
          <span className="ml-auto text-[9px]">
            Marge % = (Verkaufspreis – WES) / Verkaufspreis × 100 · DB total = Marge × Anzahl verkauft
          </span>
        </div>
      )}
    </div>
  );
}
