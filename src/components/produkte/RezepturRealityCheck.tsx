/**
 * RezepturRealityCheck
 * =====================
 * Vergleicht den theoretischen Verbrauch aus Rezepturen×Verkauf
 * mit den tatsächlich erfassten Einkäufen (Artikel-Tracking).
 *
 * Erkennt Muster über mehrere Monate und gibt praxisnahe Hinweise:
 *   – Rezeptur wahrscheinlich zu tief angesetzt
 *   – Rezeptur wahrscheinlich zu hoch angesetzt
 *   – Verbrauch nicht plausibel (Datengrundlage schwach)
 *
 * Thresholds (regelbasiert):
 *   ÜBER  130%:  Einkauf >> Rezeptur  → Rezeptur zu tief / Verluste
 *   UNTER  60%:  Einkauf << Rezeptur  → Rezeptur zu hoch / Überproduktion
 *   70–130%:     Plausibel            → kein Hinweis
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Info, ChevronRight, ChevronDown, CheckCircle } from 'lucide-react';
import { loadAllPurchases } from '@/lib/artikel-tracking-store';
import { useTenant } from '@/contexts/TenantContext';
import type { ProductRecipe, RezepturenMap } from '@/lib/rezeptur-store';
import type { ProductEntry } from '@/lib/produkte-store';

interface Props {
  recipes: RezepturenMap;
  products: ProductEntry[];
}

const MONTHS_TO_CHECK = 3;   // Wie viele Monate zurückschauen
const HIGH_THRESHOLD  = 1.30; // Einkauf > 130% des theo. Verbrauchs → Warnung
const LOW_THRESHOLD   = 0.60; // Einkauf < 60%  des theo. Verbrauchs → Hinweis
const MIN_PURCHASES   = 2;    // Mindestanzahl Einkäufe für valide Aussage

interface ArticleCheck {
  articleId: string;
  articleName: string;
  months: MonthResult[];
  avgRatio: number | null;   // Ø purchasedQty / theoreticalConsumption
  severity: 'high' | 'low' | 'ok' | 'insufficient';
  hint: string;
  details: string;
}

interface MonthResult {
  label: string;   // "Feb 2025"
  purchasedQty: number;
  theoreticalConsumption: number | null;
  ratio: number | null;
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString('de-CH', { month: 'short', year: 'numeric' });
}

function getRecentMonths(n: number): { year: number; month: number }[] {
  const result = [];
  const now = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  return result;
}

function computeTheoreticalForArticle(
  articleId: string,
  year: number,
  month: number,
  allRecipes: ProductRecipe[],
  products: ProductEntry[],
): number | null {
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const matching = allRecipes.filter(r =>
    r.ingredients.some(i => i.articleId === articleId),
  );
  if (matching.length === 0) return null;

  let total = 0;
  let hasAnySales = false;

  for (const recipe of matching) {
    const sold = products.find(
      p =>
        p.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase() &&
        p.month === monthKey,
    );
    if (sold && sold.count > 0) {
      const ing = recipe.ingredients.find(i => i.articleId === articleId);
      if (ing) {
        total += ing.quantity * sold.count;
        hasAnySales = true;
      }
    }
  }

  return hasAnySales ? total : null;
}

export default function RezepturRealityCheck({ recipes, products }: Props) {
  const { tenantId } = useTenant();
  const [open, setOpen] = useState(false);

  const checks = useMemo((): ArticleCheck[] => {
    const allPurchases = loadAllPurchases(tenantId);
    const recentMonths = getRecentMonths(MONTHS_TO_CHECK);
    const allRecipes   = Object.values(recipes);

    // Alle Artikel-IDs, die mindestens einen Einkauf haben
    const articleIds = [...new Set(allPurchases.map(p => p.articleId))];

    const results: ArticleCheck[] = [];

    for (const articleId of articleIds) {
      const articlePurchases = allPurchases.filter(p => p.articleId === articleId);
      if (!articlePurchases.length) continue;
      const articleName = articlePurchases[0].articleName;

      // Nur prüfen wenn Artikel in mindestens einer Rezeptur vorkommt
      const inRecipes = allRecipes.some(r => r.ingredients.some(i => i.articleId === articleId));
      if (!inRecipes) continue;

      const months: MonthResult[] = [];
      let ratioSum = 0;
      let ratioCount = 0;

      for (const { year, month } of recentMonths) {
        const monthPurchases = articlePurchases.filter(p => p.year === year && p.month === month);
        const purchasedQty   = monthPurchases.reduce((s, p) => s + p.quantity, 0);
        const theo           = computeTheoreticalForArticle(articleId, year, month, allRecipes, products);
        const ratio          = (theo !== null && theo > 0 && purchasedQty > 0)
          ? purchasedQty / theo
          : null;

        months.push({ label: monthLabel(year, month), purchasedQty, theoreticalConsumption: theo, ratio });

        if (ratio !== null) {
          ratioSum += ratio;
          ratioCount++;
        }
      }

      const totalPurchases = articlePurchases.filter(p =>
        recentMonths.some(m => m.year === p.year && m.month === p.month),
      ).length;

      if (totalPurchases < MIN_PURCHASES || ratioCount === 0) {
        // Zu wenig Daten
        results.push({
          articleId,
          articleName,
          months,
          avgRatio: null,
          severity: 'insufficient',
          hint: `Zu wenig Daten für «${articleName}»`,
          details: `Nur ${totalPurchases} Einkauf/Einkäufe im Zeitraum erfasst – mindestens ${MIN_PURCHASES} nötig.`,
        });
        continue;
      }

      const avgRatio = ratioSum / ratioCount;

      let severity: ArticleCheck['severity'];
      let hint: string;
      let details: string;

      if (avgRatio > HIGH_THRESHOLD) {
        severity = 'high';
        hint     = `«${articleName}» – Rezeptur wahrscheinlich zu tief angesetzt`;
        details  = `Ø Einkauf liegt ${Math.round((avgRatio - 1) * 100)}% über dem theoretischen Rezepturverbrauch. Mögliche Ursachen: Rezepturmenge zu niedrig, Verluste/Verschnitt nicht berücksichtigt, oder fehlerhafte Portionierung.`;
      } else if (avgRatio < LOW_THRESHOLD) {
        severity = 'low';
        hint     = `«${articleName}» – Rezeptur könnte zu hoch angesetzt sein`;
        details  = `Ø Einkauf liegt ${Math.round((1 - avgRatio) * 100)}% unter dem theoretischen Rezepturverbrauch. Mögliche Ursachen: Portionen kleiner als kalkuliert, Artikel nicht in allen relevanten Rezepturen erfasst, oder Produktverkäufe fehlen.`;
      } else {
        severity = 'ok';
        hint     = `«${articleName}» – plausibel`;
        details  = `Der Einkauf liegt im erwarteten Bereich (${Math.round(avgRatio * 100)}% des theo. Verbrauchs).`;
      }

      results.push({ articleId, articleName, months, avgRatio, severity, hint, details });
    }

    // Sortierung: Abweichungen zuerst
    return results.sort((a, b) => {
      const order = { high: 0, low: 1, insufficient: 2, ok: 3 };
      return order[a.severity] - order[b.severity];
    });
  }, [tenantId, recipes, products]);

  const warnings  = checks.filter(c => c.severity === 'high' || c.severity === 'low');
  const ok        = checks.filter(c => c.severity === 'ok');
  const insuf     = checks.filter(c => c.severity === 'insufficient');
  const hasIssues = warnings.length > 0;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`w-full flex items-center gap-2 px-4 py-3 text-sm text-left rounded-lg border border-dashed transition-colors ${
          hasIssues
            ? 'border-amber-300 dark:border-amber-700 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20'
            : 'border-border hover:border-primary/40 hover:bg-primary/5'
        }`}
      >
        <AlertTriangle className={`h-4 w-4 ${hasIssues ? 'text-amber-500' : 'text-muted-foreground'}`} />
        <span className="font-medium">Rezepturprüfung</span>
        {hasIssues ? (
          <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-400 font-medium">
            {warnings.length} Hinweis{warnings.length !== 1 ? 'e' : ''} · Verbrauch weicht von Rezeptur ab
          </span>
        ) : checks.length === 0 ? (
          <span className="text-muted-foreground text-xs ml-1">– Keine Tracking-Daten vorhanden</span>
        ) : (
          <span className="text-muted-foreground text-xs ml-1">– Alles plausibel</span>
        )}
        <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground" />
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <AlertTriangle className={`h-4 w-4 ${hasIssues ? 'text-amber-500' : 'text-emerald-500'}`} />
        <span className="text-sm font-semibold">Rezepturprüfung</span>
        <span className="text-xs text-muted-foreground">
          – letzte {MONTHS_TO_CHECK} Monate, {checks.length} Artikel analysiert
        </span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Schliessen
        </button>
      </div>

      <div className="p-4 space-y-3">

        {checks.length === 0 && (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <Info className="h-6 w-6 mx-auto mb-2 opacity-40" />
            <p>Keine Tracking-Daten vorhanden.</p>
            <p className="text-xs mt-1">
              Aktiviere «Tracking» für Artikel und erfasse Einkäufe im Artikel-Tracking.
            </p>
          </div>
        )}

        {/* Warnungen */}
        {warnings.map(c => (
          <CheckRow key={c.articleId} check={c} />
        ))}

        {/* OK-Zeilen */}
        {ok.length > 0 && (
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground py-1 hover:text-foreground list-none">
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              {ok.length} Artikel im plausiblen Bereich
              <ChevronDown className="h-3 w-3 ml-0.5 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="mt-2 space-y-2">
              {ok.map(c => <CheckRow key={c.articleId} check={c} />)}
            </div>
          </details>
        )}

        {/* Unzureichende Daten */}
        {insuf.length > 0 && (
          <details className="group">
            <summary className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground py-1 hover:text-foreground list-none">
              <Info className="h-3.5 w-3.5" />
              {insuf.length} Artikel mit unzureichender Datenlage
              <ChevronDown className="h-3 w-3 ml-0.5 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="mt-2 space-y-2">
              {insuf.map(c => <CheckRow key={c.articleId} check={c} />)}
            </div>
          </details>
        )}

        {/* Legende */}
        <div className="rounded-lg bg-muted/40 border border-border/50 px-3 py-2 text-[10px] text-muted-foreground space-y-0.5">
          <p className="font-medium text-xs mb-1">Wie funktioniert die Prüfung?</p>
          <p>Das System vergleicht <strong>tatsächlich eingekaufte Mengen</strong> (aus Artikel-Tracking) mit dem <strong>theoretischen Verbrauch</strong> aus Rezeptur × Verkaufsanzahl.</p>
          <p className="mt-1">
            <span className="text-amber-600 dark:text-amber-400 font-medium">Rot/Orange (&gt;130%):</span> Deutlich mehr eingekauft als die Rezeptur erwarten lässt – Rezeptur prüfen.{' '}
            <span className="text-sky-600 dark:text-sky-400 font-medium">Blau (&lt;60%):</span> Deutlich weniger eingekauft – Rezeptur oder Verkaufsdaten prüfen.
          </p>
        </div>

      </div>
    </div>
  );
}

// ── Einzelne Zeile ────────────────────────────────────────────────────────────

function CheckRow({ check }: { check: ArticleCheck }) {
  const [expanded, setExpanded] = useState(false);

  const iconEl = check.severity === 'high'
    ? <TrendingUp  className="h-4 w-4 text-amber-500 shrink-0" />
    : check.severity === 'low'
    ? <TrendingDown className="h-4 w-4 text-sky-500 shrink-0" />
    : check.severity === 'ok'
    ? <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
    : <Info className="h-4 w-4 text-muted-foreground shrink-0" />;

  const borderCls = check.severity === 'high'
    ? 'border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20'
    : check.severity === 'low'
    ? 'border-sky-200 dark:border-sky-800 bg-sky-50/60 dark:bg-sky-950/20'
    : check.severity === 'ok'
    ? 'border-emerald-100 dark:border-emerald-900/50 bg-emerald-50/30 dark:bg-emerald-950/10'
    : 'border-border bg-muted/20';

  return (
    <div className={`rounded-lg border px-3 py-2 ${borderCls}`}>
      <button
        className="w-full flex items-start gap-2 text-left"
        onClick={() => setExpanded(e => !e)}
      >
        {iconEl}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium leading-snug">{check.hint}</p>
          {check.avgRatio !== null && (
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Ø Verhältnis Einkauf/Rezeptur: <span className="font-mono font-medium">{Math.round(check.avgRatio * 100)}%</span>
            </p>
          )}
        </div>
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-2 pl-6 space-y-2">
          <p className="text-[11px] text-muted-foreground">{check.details}</p>
          <div className="grid grid-cols-4 gap-1 text-[10px]">
            <span className="font-medium text-muted-foreground">Monat</span>
            <span className="font-medium text-muted-foreground text-right">Einkauf</span>
            <span className="font-medium text-muted-foreground text-right">Theo.</span>
            <span className="font-medium text-muted-foreground text-right">Ratio</span>
            {check.months.map(m => (
              <>
                <span key={`${m.label}-l`} className="font-mono">{m.label}</span>
                <span key={`${m.label}-p`} className="text-right font-mono">{m.purchasedQty > 0 ? m.purchasedQty.toFixed(2) : '–'}</span>
                <span key={`${m.label}-t`} className="text-right font-mono">{m.theoreticalConsumption !== null ? m.theoreticalConsumption.toFixed(2) : '–'}</span>
                <span key={`${m.label}-r`}
                  className={`text-right font-mono font-medium ${
                    m.ratio === null ? 'text-muted-foreground/50'
                    : m.ratio > HIGH_THRESHOLD ? 'text-amber-600 dark:text-amber-400'
                    : m.ratio < LOW_THRESHOLD  ? 'text-sky-600 dark:text-sky-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                  }`}>
                  {m.ratio !== null ? `${Math.round(m.ratio * 100)}%` : '–'}
                </span>
              </>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
