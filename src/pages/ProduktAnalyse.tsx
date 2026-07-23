/**
 * ProduktAnalyse – Konsolidierte Produktanalyse (Container mit Tabs)
 * ====================================================================
 * EINE zentrale Arbeitsfläche für alle Produkt-Auswertungen:
 *   Übersicht · Produkte · Kategorien · Lunch · Take-away
 *
 * Der Container hält die GEMEINSAME Filterleiste (Ansicht Tag/Woche/Monat/
 * Jahr/Von–Bis, Schnellwahl, Vergleich, Kategorie) und lädt die
 * product_sales-Zeilen EINMAL; die Tabs Übersicht/Produkte/Kategorien
 * konsumieren dieselben Rows + Periode (keine Zweitladung, keine
 * Filter-Doppelung). Lunch/Take-away behalten ihre eigene fachliche
 * Datenladung (Zeitfenster- bzw. Take-away-Filter) und erhalten nur
 * Jahr/Monat aus der Filterleiste.
 *
 * Filter + aktiver Tab werden in die URL gespiegelt (Back/Forward,
 * Bookmarks, Redirects der alten Routen /lunch-analyse, /takeaway-analyse,
 * /kategorien, /produkte).
 *
 * KEINE neue Berechnungslogik — alle Aggregationen kommen unverändert aus
 * product-analytics / produkt-zeitraum / sales-db (SSoT).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3, RefreshCw, ChevronRight, ChevronLeft, CalendarDays,
  Layers, Utensils, Wine,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { loadProductSalesRows, type ProductSalesRow } from '@/lib/sales-db';
import { fetchExtendedPositions, type GnExtendedPositionRow } from '@/lib/gn-zbericht-db';
import {
  buildSalesCategoryMap, mergeProduktQuellen, produktQuellenLabel,
} from '@/lib/produkt-quellen';
import {
  filtersToParams, filtersFromParams, isoWeekInfo, isoWeeksInYear, localISODate,
  weekRangeLabel, shiftIsoWeek, periodBounds, categoryOf, formatDayLabel,
  MONTH_NAMES, PERIOD_KIND_LABEL,
  type PeriodKind, type PeriodSelection, type CategoryFilter, type Metric,
  type AnalysisFilters,
} from '@/lib/product-analytics';
import {
  addDays, quickRangeSelection, comparisonPeriod, QUICK_RANGE_KEYS, QUICK_RANGE_LABEL,
  COMPARE_MODE_LABEL, type QuickRangeKey, type CompareMode,
} from '@/lib/produkt-zeitraum';
import ProdukteTab, { isLimitMode, type LimitMode } from '@/components/produktanalyse/ProdukteTab';
import UebersichtTab from '@/components/produktanalyse/UebersichtTab';
import KategorienTab from '@/components/produktanalyse/KategorienTab';
import LunchTab from '@/components/produktanalyse/LunchTab';
import TakeAwayTab from '@/components/produktanalyse/TakeAwayTab';

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type TabKey = 'uebersicht' | 'produkte' | 'kategorien' | 'lunch' | 'takeaway';

const TAB_LABEL: Record<TabKey, string> = {
  uebersicht: 'Übersicht',
  produkte:   'Produkte',
  kategorien: 'Kategorien',
  lunch:      'Lunch',
  takeaway:   'Take-away',
};

function isTabKey(v: string | null): v is TabKey {
  return v === 'uebersicht' || v === 'produkte' || v === 'kategorien' || v === 'lunch' || v === 'takeaway';
}

function isCompareMode(v: string | null): v is CompareMode {
  return v === 'none' || v === 'vorperiode' || v === 'vorjahr';
}

const PERIOD_KINDS: PeriodKind[] = ['day', 'week', 'month', 'year', 'range'];

/** Tabs, für die die gemeinsame Perioden-Filterleiste gilt. */
const SHARED_FILTER_TABS: TabKey[] = ['uebersicht', 'produkte', 'kategorien'];

function availableYears(rows: ProductSalesRow[]): number[] {
  const years = new Set<number>();
  for (const r of rows) {
    const y = parseInt(r.sale_date.slice(0, 4), 10);
    if (!isNaN(y)) years.add(y);
  }
  return Array.from(years).sort((a, b) => b - a);
}

// ─── Container ────────────────────────────────────────────────────────────────

export default function ProduktAnalyse() {
  const { canAccessModule } = usePermissions();
  const { tenantId } = useTenant();
  const canSeeLunch = canAccessModule('dashboard');

  const [allRows, setAllRows] = useState<ProductSalesRow[]>([]);
  const [extRows, setExtRows] = useState<GnExtendedPositionRow[]>([]);
  const [extError, setExtError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const [, setSearchParams] = useSearchParams();

  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  // ── Initial-Zustand aus der URL lesen (einmalig, refresh-/zurück-fest) ───────
  const seedRef = useRef<{
    filters: AnalysisFilters;
    tab: TabKey;
    limit: LimitMode;
    cmp: CompareMode;
  } | null>(null);
  if (!seedRef.current) {
    const sp = new URLSearchParams(window.location.search);
    const filters = filtersFromParams((k) => sp.get(k));
    const tabRaw = sp.get('tab');
    // Default-Tab: explizit per ?tab=…; sonst Produkte, wenn Ranking-Parameter
    // in der URL stehen (z. B. Rückweg von der Produkt-Detailseite), sonst Übersicht.
    const hasRankingParams = sp.has('period') || sp.has('metric') || sp.has('limit') || sp.has('cat');
    const tab: TabKey = isTabKey(tabRaw) ? tabRaw : (hasRankingParams ? 'produkte' : 'uebersicht');
    const limitRaw = sp.get('limit');
    const cmpRaw = sp.get('cmp');
    seedRef.current = {
      filters,
      tab,
      limit: isLimitMode(limitRaw) ? limitRaw : 'top10',
      cmp: isCompareMode(cmpRaw) ? cmpRaw : 'none',
    };
  }
  const seed = seedRef.current;
  const seedWeek = isoWeekInfo(localISODate());

  // ── Tab-State (Lunch-Gate zentral hier, nicht in den Tabs) ───────────────────
  const [tab, setTab] = useState<TabKey>(
    seed.tab === 'lunch' && !canSeeLunch ? 'uebersicht' : seed.tab,
  );

  // ── Perioden-State (gemeinsame Filterleiste) ─────────────────────────────────
  const [periodKind, setPeriodKind] = useState<PeriodKind>(seed.filters.period.kind);
  const [year,  setYear]  = useState<number>(
    seed.filters.period.kind === 'month' || seed.filters.period.kind === 'year'
      ? seed.filters.period.year : currentYear,
  );
  const [month, setMonth] = useState<number>(
    seed.filters.period.kind === 'month' ? seed.filters.period.month : currentMonth,
  );
  const [day,   setDay]   = useState<string>(
    seed.filters.period.kind === 'day' ? seed.filters.period.date : localISODate(),
  );
  const [weekYear, setWeekYear] = useState<number>(
    seed.filters.period.kind === 'week' ? seed.filters.period.year : seedWeek.year,
  );
  const [week,     setWeek]     = useState<number>(
    seed.filters.period.kind === 'week' ? seed.filters.period.week : seedWeek.week,
  );
  const [rangeFrom, setRangeFrom] = useState<string>(
    seed.filters.period.kind === 'range' ? seed.filters.period.from : addDays(localISODate(), -6),
  );
  const [rangeTo,   setRangeTo]   = useState<string>(
    seed.filters.period.kind === 'range' ? seed.filters.period.to : localISODate(),
  );

  const [sortBy,         setSortBy]         = useState<Metric>(seed.filters.metric);
  const [limitMode,      setLimitMode]      = useState<LimitMode>(seed.limit);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(seed.filters.category);
  const [compareMode,    setCompareMode]    = useState<CompareMode>(seed.cmp);

  // ── Daten EINMAL laden (Übersicht/Produkte/Kategorien teilen sich die Rows) ──
  // Zusätzlich: Detailpositionen aktiver erweiterter Z-Berichte des aktuellen
  // Tenants (bevorzugte Quelle für aggregierte Produktanalysen, strikt read-only).
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExtError(null);
    try {
      const [data, ext] = await Promise.all([
        loadProductSalesRows(),
        fetchExtendedPositions(tenantId),
      ]);
      setAllRows(data);
      setExtRows(ext.rows);
      setExtError(ext.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const years = useMemo(() => {
    const ys = new Set(availableYears(allRows));
    for (const r of extRows) {
      const y = parseInt((r.periodTo ?? r.periodFrom ?? '').slice(0, 4), 10);
      if (!isNaN(y)) ys.add(y);
    }
    return Array.from(ys).sort((a, b) => b - a);
  }, [allRows, extRows]);
  const yearOptions = years.length ? years : [currentYear];

  // ── Aktuelle Periode (discriminated union) ───────────────────────────────────
  const selection = useMemo<PeriodSelection>(() => {
    switch (periodKind) {
      case 'day':  return { kind: 'day',  date: day };
      // Clamp gegen 52/53-Wochen-Jahre: nie eine ungültige KW53 in Filter/URL schreiben
      case 'week': return { kind: 'week', year: weekYear, week: Math.min(week, isoWeeksInYear(weekYear)) };
      case 'year': return { kind: 'year', year };
      case 'range':
        return rangeFrom <= rangeTo
          ? { kind: 'range', from: rangeFrom, to: rangeTo }
          : { kind: 'range', from: rangeTo,   to: rangeFrom };
      default:     return { kind: 'month', year, month };
    }
  }, [periodKind, day, weekYear, week, year, month, rangeFrom, rangeTo]);

  // ── Quellenpriorität: erweiterter Z-Bericht > Verkaufsdatenimport ────────────
  // Reine Logik (produkt-quellen): verwendete erweiterte Berichte verdrängen
  // die Verkaufsdaten derselben Tage (keine Doppelzählung); Mehrtagesberichte
  // werden NIE auf Tage verteilt. Vergleichsperioden erhalten dieselbe
  // Quellenpriorität (eigener Merge über die Vergleichs-Bounds).
  const categoryByProduct = useMemo(
    () => buildSalesCategoryMap(allRows, categoryOf),
    [allRows],
  );
  const extPositions = useMemo(
    () => extRows.filter(r => r.section === 'positions'),
    [extRows],
  );
  const quellen = useMemo(
    () => mergeProduktQuellen({
      salesRows: allRows,
      extendedPositions: extPositions,
      bounds: periodBounds(selection),
      categoryByProduct,
    }),
    [allRows, extPositions, selection, categoryByProduct],
  );
  const cmpSelection = useMemo(
    () => comparisonPeriod(selection, compareMode),
    [selection, compareMode],
  );
  const cmpQuellen = useMemo(
    () => (cmpSelection
      ? mergeProduktQuellen({
          salesRows: allRows,
          extendedPositions: extPositions,
          bounds: periodBounds(cmpSelection),
          categoryByProduct,
        })
      : null),
    [allRows, extPositions, cmpSelection, categoryByProduct],
  );
  /** Zeilen für Übersicht/Produkte/Kategorien: Auswahl- + Vergleichszeitraum. */
  const sharedRows = useMemo(
    () => (cmpQuellen ? [...quellen.rows, ...cmpQuellen.rows] : quellen.rows),
    [quellen, cmpQuellen],
  );
  const quellenBadge = produktQuellenLabel(quellen.source);

  // ── Tab + Filter in die URL spiegeln (EINE Stelle) ───────────────────────────
  useEffect(() => {
    const params = filtersToParams({ period: selection, category: categoryFilter, metric: sortBy });
    params.tab = tab;
    params.limit = limitMode;
    if (compareMode !== 'none') params.cmp = compareMode;
    setSearchParams(params, { replace: true });
  }, [tab, selection, categoryFilter, sortBy, limitMode, compareMode, setSearchParams]);

  // ── Schnellwahl: PeriodSelection in die Einzel-States übertragen ─────────────
  const applySelection = useCallback((sel: PeriodSelection) => {
    setPeriodKind(sel.kind);
    switch (sel.kind) {
      case 'day':   setDay(sel.date); break;
      case 'week':  setWeekYear(sel.year); setWeek(sel.week); break;
      case 'month': setYear(sel.year); setMonth(sel.month); break;
      case 'year':  setYear(sel.year); break;
      case 'range': setRangeFrom(sel.from); setRangeTo(sel.to); break;
    }
  }, []);

  const applyQuickRange = useCallback((key: QuickRangeKey) => {
    applySelection(quickRangeSelection(key));
  }, [applySelection]);

  // ── Wochen-Navigation ────────────────────────────────────────────────────────
  const weekRange = useMemo(
    () => (selection.kind === 'week' ? weekRangeLabel(selection.year, selection.week) : ''),
    [selection],
  );

  const stepWeek = useCallback((delta: number) => {
    if (selection.kind !== 'week') return;
    const next = shiftIsoWeek(selection.year, selection.week, delta);
    setWeekYear(next.year);
    setWeek(next.week);
  }, [selection]);

  // ── Jahr/Monat für Lunch/Take-away (aus derselben Filterleiste) ──────────────
  const lunchTaYear  = year;
  const lunchTaMonth = month;

  const visibleTabs = useMemo<TabKey[]>(
    () => (Object.keys(TAB_LABEL) as TabKey[]).filter(t => t !== 'lunch' || canSeeLunch),
    [canSeeLunch],
  );

  const isSharedFilterTab = SHARED_FILTER_TABS.includes(tab);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Produktanalyse</h1>
        </div>
        {isSharedFilterTab && (
          <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Aktualisieren
          </Button>
        )}
      </div>

      {/* Tab-Leiste */}
      <div className="flex flex-wrap gap-1 border-b pb-px" role="tablist" aria-label="Produktanalyse-Bereiche">
        {visibleTabs.map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-t-md border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {/* Gemeinsame Filterleiste */}
      <Card>
        <CardContent className="pt-4 pb-3 flex flex-wrap gap-3 items-end">

          {isSharedFilterTab ? (
            <>
              {/* Ansicht */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Ansicht</span>
                <Select value={periodKind} onValueChange={v => setPeriodKind(v as PeriodKind)}>
                  <SelectTrigger className="h-8 w-[130px] text-sm" data-testid="select-ansicht"><SelectValue /></SelectTrigger>
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

              {/* Woche – Navigation mit exakter Datumsspanne */}
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

              {/* Von–Bis */}
              {periodKind === 'range' && (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground font-medium">Von</span>
                    <Input
                      type="date"
                      value={rangeFrom}
                      onChange={e => setRangeFrom(e.target.value || rangeFrom)}
                      className="h-8 w-[160px] text-sm"
                      data-testid="input-range-von"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground font-medium">Bis</span>
                    <Input
                      type="date"
                      value={rangeTo}
                      onChange={e => setRangeTo(e.target.value || rangeTo)}
                      className="h-8 w-[160px] text-sm"
                      data-testid="input-range-bis"
                    />
                  </div>
                </>
              )}

              {/* Schnellwahl */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Schnellwahl</span>
                <Select value="" onValueChange={v => applyQuickRange(v as QuickRangeKey)}>
                  <SelectTrigger className="h-8 w-[150px] text-sm" data-testid="select-schnellwahl">
                    <SelectValue placeholder="Zeitraum wählen…" />
                  </SelectTrigger>
                  <SelectContent>
                    {QUICK_RANGE_KEYS.map(k => (
                      <SelectItem key={k} value={k}>{QUICK_RANGE_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Vergleich */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Vergleich</span>
                <Select value={compareMode} onValueChange={v => setCompareMode(v as CompareMode)}>
                  <SelectTrigger className="h-8 w-[150px] text-sm" data-testid="select-vergleich"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(COMPARE_MODE_LABEL) as CompareMode[]).map(m => (
                      <SelectItem key={m} value={m}>{COMPARE_MODE_LABEL[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            </>
          ) : (
            <>
              {/* Lunch / Take-away: nur Jahr + Monat (fachliche Filter bleiben im Tab) */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground font-medium">Jahr</span>
                <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                  <SelectTrigger className="h-8 w-[90px] text-sm" data-testid="select-lunch-ta-jahr"><SelectValue /></SelectTrigger>
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
                  <SelectTrigger className="h-8 w-[130px] text-sm" data-testid="select-lunch-ta-monat"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((name, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

        </CardContent>
      </Card>

      {/* Datenquellen-Hinweis (Quellenpriorität: erweiterter Z-Bericht zuerst) */}
      {isSharedFilterTab && !loading && (quellenBadge || quellen.periodSumOnlyReports.length > 0 || extError) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {quellenBadge && (
            <Badge variant="outline" className="font-normal" data-testid="badge-datenquelle">
              {quellenBadge}
            </Badge>
          )}
          {quellen.periodSumOnlyReports.map(r => (
            <span key={r.importId} data-testid={`hint-periodensumme-${r.importId}`}>
              Erweiterter Z-Bericht {formatDayLabel(r.periodFrom)}–{formatDayLabel(r.periodTo)}:
              {' '}nur als Periodensumme verfügbar — in dieser Ansicht nicht enthalten.
            </span>
          ))}
          {extError && (
            <span className="text-destructive" data-testid="hint-ext-fehler">
              Detailpositionen konnten nicht geladen werden: {extError}
            </span>
          )}
        </div>
      )}

      {/* Tab-Inhalte */}
      {tab === 'uebersicht' && (
        <UebersichtTab
          rows={sharedRows}
          loading={loading}
          error={error}
          selection={selection}
          categoryFilter={categoryFilter}
          compareMode={compareMode}
          sortBy={sortBy}
        />
      )}

      {tab === 'produkte' && (
        <ProdukteTab
          rows={sharedRows}
          loading={loading}
          error={error}
          selection={selection}
          categoryFilter={categoryFilter}
          sortBy={sortBy}
          onSortByChange={setSortBy}
          limitMode={limitMode}
          onLimitModeChange={setLimitMode}
        />
      )}

      {tab === 'kategorien' && (
        <KategorienTab
          rows={sharedRows}
          loading={loading}
          error={error}
          selection={selection}
          categoryFilter={categoryFilter}
          compareMode={compareMode}
          onOpenCategory={(cat) => {
            setCategoryFilter(cat);
            setTab('produkte');
          }}
        />
      )}

      {tab === 'lunch' && canSeeLunch && (
        <LunchTab year={lunchTaYear} month={lunchTaMonth} />
      )}

      {tab === 'takeaway' && (
        <TakeAwayTab year={lunchTaYear} month={lunchTaMonth} />
      )}

    </div>
  );
}
