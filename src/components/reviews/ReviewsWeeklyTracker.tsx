/**
 * Wochentracking der Einzelrezensionen nach Sternen — fürs Meeting-Cockpit
 * und die Rezensionen-Seite. Rein lesend; Erfassung auf /rezensionen.
 *
 * Spalten = Kalenderwochen (ISO), Zeilen = 5/4/3/2/1 Sterne + Total/Woche.
 * Zeitraum umschaltbar (4/8/12 Wochen oder aktueller Monat), Plattform-Filter.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addWeeks, endOfMonth, startOfISOWeek, startOfMonth, subWeeks } from 'date-fns';
import { Star } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { useTenant } from '@/contexts/TenantContext';
import {
  fetchReviewsData, computeWeeklyStarColumns, summarizeStarColumns, isoWeekKeyOf,
  STAR_VALUES, type SingleReview, type StarValue,
} from '@/lib/reviews-store';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type Period = 'w4' | 'w8' | 'w12' | 'month';

export const PERIOD_LABELS: Record<Period, string> = {
  w4: 'Letzte 4 Wochen', w8: 'Letzte 8 Wochen', w12: 'Letzte 12 Wochen', month: 'Aktueller Monat',
};

/** ISO-Wochen-Keys für den gewählten Zeitraum, aufsteigend (heute-basiert). */
export function weekKeysForPeriod(period: Period, today: Date): string[] {
  if (period === 'month') {
    const keys: string[] = [];
    let cur = startOfISOWeek(startOfMonth(today));
    const end = endOfMonth(today);
    while (cur <= end) {
      keys.push(isoWeekKeyOf(cur));
      cur = addWeeks(cur, 1);
    }
    return keys;
  }
  const n = period === 'w4' ? 4 : period === 'w8' ? 8 : 12;
  const start = startOfISOWeek(subWeeks(today, n - 1));
  return Array.from({ length: n }, (_, i) => isoWeekKeyOf(addWeeks(start, i)));
}

export function ReviewsWeeklyTracker({
  reviews: reviewsProp,
  showCockpitLink = false,
  period: periodProp,
  onPeriodChange,
  platform: platformProp,
  onPlatformChange,
}: {
  /** Optional bereits geladene Einzelrezensionen (Rezensionen-Seite); sonst lädt die Komponente selbst. */
  reviews?: SingleReview[];
  /** Im Cockpit: Link zur Erfassung anzeigen. */
  showCockpitLink?: boolean;
  /** Optional kontrolliert (Cockpit teilt Zeitraum/Plattform mit dem KPI-Block oben). */
  period?: Period;
  onPeriodChange?: (p: Period) => void;
  platform?: string;
  onPlatformChange?: (p: string) => void;
}) {
  const { tenantId } = useTenant();
  const [loaded, setLoaded] = useState<SingleReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodState, setPeriodState] = useState<Period>('w8');
  const [platformState, setPlatformState] = useState<string>('__all__');
  const period = periodProp ?? periodState;
  const platform = platformProp ?? platformState;
  const setPeriod = onPeriodChange ?? setPeriodState;
  const setPlatform = onPlatformChange ?? setPlatformState;

  const selfLoad = reviewsProp === undefined;
  useEffect(() => {
    if (!selfLoad) return;
    let alive = true;
    setLoaded(null); setError(null); // State-Reset bei Tenant-Wechsel
    fetchReviewsData(tenantId)
      .then(d => { if (alive) setLoaded(d.singleReviews); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [selfLoad, tenantId]);

  const reviews = reviewsProp ?? loaded ?? [];
  const platforms = useMemo(
    () => Array.from(new Set(reviews.map(r => r.platform))).sort((a, b) => a.localeCompare(b, 'de')),
    [reviews],
  );
  const platformFilter = platform === '__all__' ? null : platform;
  const weekKeys = useMemo(() => weekKeysForPeriod(period, new Date()), [period]);
  const cols = useMemo(
    () => computeWeeklyStarColumns(reviews, weekKeys, platformFilter),
    [reviews, weekKeys, platformFilter],
  );
  const summary = useMemo(() => summarizeStarColumns(cols), [cols]);
  const trendData = useMemo(() => cols.map(c => ({ label: c.label, total: c.total })), [cols]);

  if (selfLoad && error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-testid="reviews-week-error">
        Rezensionen konnten nicht geladen werden: {error}
      </div>
    );
  }
  if (selfLoad && loaded === null && !error) {
    return <p className="text-sm text-muted-foreground" data-testid="reviews-week-loading">Lade Rezensionen …</p>;
  }

  return (
    <div className="space-y-3" data-testid="reviews-week-tracker">
      {/* Kopf + Filter */}
      <div className="flex flex-wrap items-center gap-2">
        <Star className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-semibold">Rezensionen pro Woche nach Sternen</h3>
        <div className="ml-auto flex items-center gap-2">
          <Select value={period} onValueChange={v => setPeriod(v as Period)}>
            <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="reviews-week-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERIOD_LABELS) as Period[]).map(p => (
                <SelectItem key={p} value={p} className="text-xs">{PERIOD_LABELS[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={platform} onValueChange={setPlatform}>
            <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="reviews-week-platform">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__" className="text-xs">Alle Plattformen</SelectItem>
              {platforms.map(p => <SelectItem key={p} value={p} className="text-xs">{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_240px]">
        {/* Wochen-Matrix */}
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm" data-testid="reviews-week-table">
            <thead>
              <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">Sterne</th>
                {cols.map(c => (
                  <th key={c.weekKey} className="px-2 py-2 text-right font-semibold whitespace-nowrap">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STAR_VALUES.map(star => (
                <tr key={star} className="border-b hover:bg-muted/30" data-testid={`reviews-week-row-${star}`}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={cn('inline-flex items-center gap-1',
                      star === 5 && 'text-emerald-700 font-medium',
                      star <= 2 && 'text-red-700 font-medium')}>
                      {star} <Star className="h-3 w-3 fill-current" />
                    </span>
                  </td>
                  {cols.map(c => (
                    <td key={c.weekKey} className="px-2 py-1.5 text-right tabular-nums">
                      {c.counts[star as StarValue] === 0
                        ? <span className="text-muted-foreground/50">·</span>
                        : c.counts[star as StarValue]}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="font-semibold bg-muted/30" data-testid="reviews-week-row-total">
                <td className="px-3 py-1.5">Total/Woche</td>
                {cols.map(c => (
                  <td key={c.weekKey} className="px-2 py-1.5 text-right tabular-nums">
                    {c.total === 0 ? <span className="text-muted-foreground/50">·</span> : c.total}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Kennzahlen + Trend */}
        <div className="rounded-xl border bg-card shadow-sm p-3 space-y-2 text-sm" data-testid="reviews-week-summary">
          <p className="text-xs text-muted-foreground">{PERIOD_LABELS[period]}{platformFilter ? ` · ${platformFilter}` : ''}</p>
          <p><span className="text-2xl font-bold tabular-nums">{summary.total}</span>{' '}
            <span className="text-xs text-muted-foreground">neue Rezensionen</span></p>
          <div className="space-y-0.5 text-xs">
            {STAR_VALUES.map(s => (
              <div key={s} className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1">{s} <Star className="h-3 w-3 fill-amber-400 text-amber-400" /></span>
                <span className="tabular-nums font-medium">{summary.counts[s]}</span>
              </div>
            ))}
          </div>
          <div className="h-14">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <XAxis dataKey="label" hide />
                <YAxis hide allowDecimals={false} />
                <Tooltip formatter={(v: number) => [v, 'Rezensionen']} labelClassName="text-xs" />
                <Line type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {showCockpitLink && (
            <Link to="/rezensionen" className="block text-xs text-primary hover:underline" data-testid="reviews-week-link">
              Rezensionen erfassen →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
