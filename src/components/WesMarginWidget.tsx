/**
 * WesMarginWidget – Margenkontrolle Dashboard-Widget
 * ====================================================
 * Zeigt auf dem Dashboard:
 * 1. Top 10 Produkte mit schlechtester WES (höchster WES%)
 * 2. Durchschnittliche WES pro Vertriebskategorie
 * 3. Alarm wenn >30% der Produkte einer Kategorie ROT sind
 * 4. Smarte Vorschläge für rote Produkte
 *
 * Streng read-only – ändert keine Daten.
 */

import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, TrendingDown, Package, ChevronRight, CircleDot } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  loadRezepturenFromDB,
  computeRecipeCosts,
  type ProductRecipe,
} from '@/lib/rezeptur-store';
import {
  loadProductCosts,
  type ProductCostEntry,
} from '@/lib/produkte-store';
import {
  getWesStatus,
  getWesBadgeClasses,
  getWesDotClass,
  getWesStatusLabel,
  getWesStatusFullLabel,
  getProductSalesCategory,
  getSmartSuggestions,
  ALL_SALES_CATEGORIES,
  WES_GREEN_MAX,
  WES_AMBER_MAX,
  WES_CATEGORY_ALARM_PCT,
  type WesStatus,
  type ProductSalesCategory,
} from '@/lib/wes-status';

// ─── Typen ────────────────────────────────────────────────────────────────────

interface ProductWesRow {
  productName: string;
  category: ProductSalesCategory;
  wesPct: number;
  status: WesStatus;
  costCHF: number;           // Plankosten pro Portion
  sellPriceCHF: number;      // Netto-Verkaufspreis
  suggestions: string[];
}

interface CategorySummary {
  category: ProductSalesCategory;
  count: number;
  avgWesPct: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  isAlarm: boolean;          // > 30% ROT
}

// ─── Farb-Hilfsfunktionen ─────────────────────────────────────────────────────

function fmtChf(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function categoryColor(category: ProductSalesCategory): string {
  switch (category) {
    case 'Lunch':      return 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800';
    case 'Take Away':  return 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-950/30 dark:text-teal-400 dark:border-teal-800';
    case 'Getränke':   return 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800';
    default:           return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700';
  }
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

export function WesMarginWidget() {
  const [loading, setLoading]           = useState(true);
  const [topRows,  setTopRows]          = useState<ProductWesRow[]>([]);
  const [catRows,  setCatRows]          = useState<CategorySummary[]>([]);
  const [hasAlarm, setHasAlarm]         = useState(false);
  const [expanded, setExpanded]         = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadRezepturenFromDB(), loadProductCosts()]).then(([rez, costs]) => {
      if (!alive) return;

      const costMap = new Map<string, ProductCostEntry>();
      for (const c of costs) {
        if (c.productName) costMap.set(c.productName.toLowerCase(), c);
      }

      // Alle Produkte mit WES berechnen
      const rows: ProductWesRow[] = [];
      for (const recipe of Object.values(rez)) {
        if (!recipe.productName) continue;
        if (!Array.isArray(recipe.ingredients)) continue;
        const costEntry = costMap.get(recipe.productName.toLowerCase());
        if (!costEntry) continue;

        const refPrice = costEntry.nettoPrice > 0 ? costEntry.nettoPrice : costEntry.bruttoPrice;
        if (refPrice <= 0) continue; // Kein VKP → WES unberechenbar

        const kpis    = computeRecipeCosts(recipe, costEntry.nettoPrice, costEntry.bruttoPrice);
        const status  = getWesStatus(kpis.wesQ);
        const category = getProductSalesCategory(recipe);

        rows.push({
          productName:   recipe.productName,
          category,
          wesPct:        kpis.wesQ,
          status,
          costCHF:       kpis.totalCost,
          sellPriceCHF:  refPrice,
          suggestions:   getSmartSuggestions(kpis.wesQ),
        });
      }

      // Top 10 nach WES% absteigend
      const sorted = [...rows].sort((a, b) => b.wesPct - a.wesPct).slice(0, 10);

      // Kategorie-Zusammenfassung
      const byCategory: Record<ProductSalesCategory, ProductWesRow[]> = {
        Restaurant: [], Lunch: [], 'Take Away': [], Getränke: [],
      };
      for (const row of rows) byCategory[row.category].push(row);

      const catSummary: CategorySummary[] = ALL_SALES_CATEGORIES
        .map(cat => {
          const items = byCategory[cat];
          if (items.length === 0) return null;
          const avgWes     = items.reduce((s, r) => s + r.wesPct, 0) / items.length;
          const greenCount = items.filter(r => r.status === 'green').length;
          const amberCount = items.filter(r => r.status === 'amber').length;
          const redCount   = items.filter(r => r.status === 'red').length;
          return {
            category:   cat,
            count:      items.length,
            avgWesPct:  avgWes,
            greenCount, amberCount, redCount,
            isAlarm:    items.length > 0 && (redCount / items.length) * 100 > WES_CATEGORY_ALARM_PCT,
          } satisfies CategorySummary;
        })
        .filter(Boolean) as CategorySummary[];

      setTopRows(sorted);
      setCatRows(catSummary);
      setHasAlarm(catSummary.some(c => c.isAlarm));
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  if (loading) return null;
  if (topRows.length === 0) return null;

  const redCount   = topRows.filter(r => r.status === 'red').length;
  const amberCount = topRows.filter(r => r.status === 'amber').length;

  return (
    <Card className={cn(
      'border-l-4',
      hasAlarm
        ? 'border-l-red-500 bg-red-50/20 dark:bg-red-950/10'
        : redCount > 0
          ? 'border-l-amber-500'
          : 'border-l-green-500',
    )}>
      <CardHeader className="pb-2 pt-4">
        {/* Alarm-Banner oben */}
        {hasAlarm && (
          <div className="rounded-md bg-red-100 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 mb-3 flex items-center gap-2 text-sm text-red-700 dark:text-red-400 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Viele Produkte mit schlechter Marge – Kalkulation überprüfen
          </div>
        )}

        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-muted-foreground" />
            Margenkontrolle – Produkte nach WES
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] font-medium">
            {redCount > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full border bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800">
                <CircleDot className="h-2.5 w-2.5" />
                {redCount} Kritisch
              </span>
            )}
            {amberCount > 0 && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full border bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">
                <CircleDot className="h-2.5 w-2.5" />
                {amberCount} Prüfen
              </span>
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Top-Produkte mit der höchsten Wareneinsatzquote. Grün ≤ {WES_GREEN_MAX}% · Amber ≤ {WES_AMBER_MAX}% · Rot &gt; {WES_AMBER_MAX}%.
        </p>
      </CardHeader>

      <CardContent className="pb-4 space-y-4">

        {/* ── Top 10 Problem-Produkte ────────────────────────────────────────── */}
        <div className="space-y-1.5">
          {topRows.map((row, idx) => (
            <div
              key={row.productName}
              className={cn(
                'rounded-lg border px-3 py-2 flex items-center gap-3',
                row.status === 'red'
                  ? 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/10'
                  : row.status === 'amber'
                    ? 'border-amber-200/60 bg-amber-50/30 dark:border-amber-800/60 dark:bg-amber-950/5'
                    : 'border-border bg-card',
              )}
            >
              {/* Rang */}
              <span className="text-[10px] font-mono text-muted-foreground w-4 shrink-0 text-center">
                {idx + 1}
              </span>

              {/* Status-Dot */}
              <span className={cn(
                'h-2 w-2 rounded-full shrink-0',
                getWesDotClass(row.status),
              )} />

              {/* Name + Kategorie */}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{row.productName}</p>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={cn(
                    'text-[9px] font-semibold px-1 py-0 rounded border',
                    categoryColor(row.category),
                  )}>
                    {row.category}
                  </span>
                  {/* Verbesserungshinweise für rote Produkte */}
                  {row.suggestions.map(s => (
                    <span key={s} className="text-[9px] px-1 py-0 rounded border bg-red-50 text-red-600 border-red-200 dark:bg-red-950/20 dark:text-red-400 dark:border-red-800">
                      {s}
                    </span>
                  ))}
                </div>
              </div>

              {/* WES % */}
              <div className="text-right shrink-0">
                <span className={cn(
                  'text-sm font-bold font-mono',
                  row.status === 'red'   ? 'text-red-600 dark:text-red-400'
                  : row.status === 'amber' ? 'text-amber-600 dark:text-amber-400'
                  : 'text-green-600 dark:text-green-400',
                )}>
                  {fmtPct(row.wesPct)}
                </span>
              </div>

              {/* Kosten / VKP */}
              <div className="hidden sm:block text-right shrink-0 min-w-[80px]">
                <p className="text-[10px] font-mono text-muted-foreground">
                  Kosten: CHF {fmtChf(row.costCHF)}
                </p>
                <p className="text-[10px] font-mono text-muted-foreground">
                  VKP: CHF {fmtChf(row.sellPriceCHF)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Kategorie-Vergleich (aufklappbar) ────────────────────────────── */}
        {catRows.length > 0 && (
          <div>
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-full flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <Package className="h-3.5 w-3.5" />
              <span className="font-medium">Ø WES nach Vertriebskategorie</span>
              <ChevronRight className={cn(
                'h-3.5 w-3.5 ml-auto transition-transform',
                expanded && 'rotate-90',
              )} />
            </button>

            {expanded && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {catRows.map(cat => (
                  <div
                    key={cat.category}
                    className={cn(
                      'rounded-lg border p-3 space-y-2',
                      cat.isAlarm
                        ? 'border-red-300 bg-red-50/40 dark:border-red-700 dark:bg-red-950/10'
                        : 'border-border bg-card',
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className={cn(
                        'text-[9px] font-semibold px-1.5 py-0.5 rounded border',
                        categoryColor(cat.category),
                      )}>
                        {cat.category}
                      </span>
                      {cat.isAlarm && (
                        <AlertTriangle className="h-3 w-3 text-red-500 shrink-0 mt-0.5" />
                      )}
                    </div>

                    <div>
                      <p className={cn(
                        'text-xl font-bold font-mono',
                        getWesStatus(cat.avgWesPct) === 'red'   ? 'text-red-600 dark:text-red-400'
                        : getWesStatus(cat.avgWesPct) === 'amber' ? 'text-amber-600 dark:text-amber-400'
                        : 'text-green-600 dark:text-green-400',
                      )}>
                        {fmtPct(cat.avgWesPct)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Ø WES · {cat.count} Produkte
                      </p>
                    </div>

                    {/* Mini-Ampel-Balken */}
                    <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden">
                      {cat.greenCount > 0 && (
                        <div
                          className="bg-green-400 h-full"
                          style={{ width: `${(cat.greenCount / cat.count) * 100}%` }}
                        />
                      )}
                      {cat.amberCount > 0 && (
                        <div
                          className="bg-amber-400 h-full"
                          style={{ width: `${(cat.amberCount / cat.count) * 100}%` }}
                        />
                      )}
                      {cat.redCount > 0 && (
                        <div
                          className="bg-red-400 h-full"
                          style={{ width: `${(cat.redCount / cat.count) * 100}%` }}
                        />
                      )}
                    </div>

                    <p className="text-[9px] text-muted-foreground">
                      {cat.greenCount > 0 && <span className="text-green-600">{cat.greenCount} Gut</span>}
                      {cat.amberCount > 0 && <span className="text-amber-600"> · {cat.amberCount} Prüfen</span>}
                      {cat.redCount > 0 && <span className="text-red-600"> · {cat.redCount} Kritisch</span>}
                    </p>

                    {cat.isAlarm && (
                      <p className="text-[9px] text-red-600 dark:text-red-400 font-medium leading-tight">
                        Viele Produkte mit schlechter Marge – Kalkulation überprüfen
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Link zu Produkte */}
        <div className="text-right pt-1">
          <Link
            to="/produkte"
            className="text-xs text-primary hover:underline flex items-center justify-end gap-1"
          >
            Alle Produktkalkulationen ansehen
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
