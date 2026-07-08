/**
 * ReservationAnalysePage — Zentrale „Reservations Analyse"
 * =========================================================
 * Konsolidiert „Monat Ist vs. Vorjahr" und „Reservationen nach Wochentag" zu
 * EINER übersichtlichen Analyse-Seite (`/gaeste/analyse`):
 *
 *  1. Globaler Kennzahl-Umschalter Personen (Default) / Reservationen —
 *     steuert KPI-Kacheln, alle Tabellen UND die Detail-Popups.
 *  2. Zeitraum-Auswahl (Jahr + Von/Bis-Monat) mit Schnellbuttons: aktueller/
 *     letzter Monat, aktuelles/letztes Jahr, Wintersaison Okt–Dez.
 *  3. Drei Sektionen als Tabs: Monat Ist vs. Vorjahr, Wochentag-Analyse,
 *     Saison/Zeitraum (Monats- + Wochentagsaufschlüsselung kombiniert).
 *  4. Klick auf Monat → Tagesvergleich-Popup; Klick auf Wochentag →
 *     Zusammensetzungs-Popup (Monatsaufschlüsselung dieses Wochentags).
 *
 * Liest ausschliesslich die bestehende Tabelle `reservation_records`
 * (mandantengefiltert via `fetchReservationsInRange`, Ist- und Vorjahres-
 * Zeitraum) — KEINE neue Migration, KEINE Schreibzugriffe. Berechnung rein in
 * `reservation-yoy-utils.ts` + `reservation-analyse-utils.ts` (getestet).
 * „Foratable Report" bleibt vollständig unberührt.
 *
 * Datenschutz: nur für Admins (nicht für Gast-Sessions) — Route-Guard UND
 * Lade-Effekte sind doppelt abgesichert.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft, BarChart3, Database, Loader2, TrendingUp, TrendingDown,
  Minus, Info,
} from 'lucide-react';
import { useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { fetchReservationsInRange } from '@/lib/reservation-crm-db';
import { checkReservationTablesExist } from '@/lib/reservation-import-db';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';
import {
  monthLabel, monthLongLabel, rangeFromMonthKeys, isoWeekdayOf,
  STATUS_SCOPE_LABEL, WEEKDAY_LABEL, WEEKDAY_SHORT, ISO_WEEKDAYS,
  type IsoWeekday, type StatusScope,
} from '@/lib/reservation-weekday-analytics';
import {
  monthKeysInRange, priorYearMonthKey, buildYoyComparison,
  buildYoyDayComparison, buildYoyWeekdayComparison,
  type YoyMetric, type YoyTrend,
} from '@/lib/reservation-yoy-utils';
import {
  DEFAULT_ANALYSE_METRIC, ANALYSE_METRICS, ANALYSE_METRIC_LABEL,
  ANALYSE_PRESETS, presetMonthRange, matchesPreset, pickMetric,
  avgPersonsPerReservation, buildWeekdayMonthBreakdown,
  buildMonthWeekdayHeatmap, heatmapValueScale, classifyHeatmapLevel,
  cellMetricValue, cellShareOfMonth, cellShareOfRange, cellVsMonthAverage,
  buildHeatmapCellTooltip, buildWeekdayDayBreakdown,
  buildMonthDetailKpis, buildMonthWeekdayComposition,
  buildWeekdayIstVorjahrChartData, monthDetailDayFlags,
  buildWeekdayMonthMatrix, weekdayMatrixExtremes,
  type AnalyseMetric, type AnalyseMonthRange, type MetricPair,
  type HeatmapLevel, type HeatmapCell, type HeatmapMonthRow,
  type MonthWeekdayHeatmap, type HeatmapScale, type HeatmapDayEntry,
  type WeekdayIstVorjahrChartPoint,
  type WeekdayMonthMatrix, type WeekdayMatrixExtremes,
} from '@/lib/reservation-analyse-utils';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Legend, Tooltip as RechartsTooltip,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PCT1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Absolute Differenz mit Vorzeichen („+12" / „−5" / „±0"); „—" wenn unbekannt. */
function fmtDiff(diff: number | null): string {
  if (diff === null) return '—';
  if (diff === 0) return '±0';
  return diff > 0 ? `+${NUM0.format(diff)}` : `−${NUM0.format(Math.abs(diff))}`;
}

/** Prozent-Differenz („+12.5 %" / „−8.0 %" / „±0 %"); „—" wenn unbekannt/VJ=0. */
function fmtPct(pct: number | null): string {
  if (pct === null) return '—';
  if (pct === 0) return '±0 %';
  return pct > 0 ? `+${PCT1.format(pct)} %` : `−${PCT1.format(Math.abs(pct))} %`;
}

/** „—" für unbekannte Vorjahreswerte, sonst Ganzzahl. */
function fmtPrior(n: number | null): string {
  return n === null ? '—' : NUM0.format(n);
}

/** Anteil in % („18.2 %"); „—" wenn kein Total (null). */
function fmtShare(pct: number | null): string {
  return pct === null ? '—' : `${PCT1.format(pct)} %`;
}

/** Ø Personen/Reservation („2.4"); „—" wenn unbekannt. */
function fmtAvg(n: number | null): string {
  return n === null ? '—' : NUM1.format(n);
}

const TREND_TEXT: Record<YoyTrend, string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-red-600 dark:text-red-400',
  neutral: 'text-muted-foreground',
};

const TREND_BG: Record<YoyTrend, string> = {
  up: 'bg-emerald-50 dark:bg-emerald-950/20',
  down: 'bg-red-50 dark:bg-red-950/20',
  neutral: '',
};

function TrendIcon({ trend, className }: { trend: YoyTrend; className?: string }) {
  const Icon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  return <Icon className={cn('h-3.5 w-3.5', className)} />;
}

// ── Konstanten ────────────────────────────────────────────────────────────────

const MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const STATUS_SCOPES: StatusScope[] = ['booked', 'active', 'all'];

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── Kleinbausteine ────────────────────────────────────────────────────────────

function KpiTile({ label, value, trend, sub }: {
  label: string;
  value: string;
  trend?: YoyTrend;
  sub?: string;
}) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col justify-between gap-1 p-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn(
          'flex items-center gap-1.5 text-xl font-semibold tabular-nums',
          trend ? TREND_TEXT[trend] : 'text-foreground',
        )}>
          {trend ? <TrendIcon trend={trend} /> : null}
          {value}
        </div>
        {/* Unterzeile immer reservieren → alle Kacheln gleich hoch. */}
        <div className="min-h-[15px] text-[11px] text-muted-foreground">{sub ?? ''}</div>
      </CardContent>
    </Card>
  );
}

/** Einheitliches Feld-/Sektions-Label der Filterleiste. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** Segmentierte Umschalt-Gruppe (Kennzahl, Status) — klarer aktiver Zustand. */
function SegmentedGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
      {children}
    </div>
  );
}

/** Ist/VJ/Diff/Diff% Zellen der AKTIVEN Kennzahl (4 <td>). */
function MetricCells({ metric, padRight }: { metric: YoyMetric; padRight?: boolean }) {
  return (
    <>
      <td className="px-2 py-2 text-right font-medium tabular-nums">
        {NUM0.format(metric.current)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {fmtPrior(metric.prior)}
      </td>
      <td className={cn('px-2 py-2 text-right tabular-nums', TREND_TEXT[metric.trend])}>
        {fmtDiff(metric.diff)}
      </td>
      <td className={cn('py-2 text-right tabular-nums', padRight ? 'px-3' : 'px-2', TREND_TEXT[metric.trend])}>
        {fmtPct(metric.diffPct)}
      </td>
    </>
  );
}

function MetricHeaderCells({ metricLabel }: { metricLabel: string }) {
  return (
    <>
      <th className="px-2 py-2 text-right font-medium">{metricLabel} Ist</th>
      <th className="px-2 py-2 text-right font-medium">Vorjahr</th>
      <th className="px-2 py-2 text-right font-medium">Diff.</th>
      <th className="px-3 py-2 text-right font-medium">Diff. %</th>
    </>
  );
}

/** Amber-Hinweis-Box. */
function AmberNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

// ── Tabellen ─────────────────────────────────────────────────────────────────

/** Monatsvergleich (aktive Kennzahl): eine Zeile pro Monat, klickbar. */
function MonthYoyTable({ months, totals, metric, onMonthClick }: {
  months: (MetricPair & { monthKey: string; hasPriorData: boolean })[];
  totals: MetricPair;
  metric: AnalyseMetric;
  onMonthClick: (monthKey: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Monat</th>
            <MetricHeaderCells metricLabel={ANALYSE_METRIC_LABEL[metric]} />
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const v = pickMetric(m, metric);
            return (
              <tr
                key={m.monthKey}
                className={cn(
                  'cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50',
                  TREND_BG[v.trend],
                )}
                onClick={() => onMonthClick(m.monthKey)}
                title="Tagesvergleich öffnen"
              >
                <td className="px-3 py-2 font-medium">
                  {monthLabel(m.monthKey)}
                  {!m.hasPriorData ? (
                    <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">kein Vorjahr</span>
                  ) : null}
                </td>
                <MetricCells metric={v} padRight />
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/40 font-medium">
            <td className="px-3 py-2">Total</td>
            <MetricCells metric={pickMetric(totals, metric)} padRight />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Wochentagsvergleich Mo–So (aktive Kennzahl), Zeilen klickbar. Mit
 * `shareByWeekday` (Monats-Popup) erscheint zusätzlich „Anteil Monat".
 */
function WeekdayYoyTable({ rows, metric, onWeekdayClick, compact, shareByWeekday }: {
  rows: (MetricPair & { weekday: IsoWeekday })[];
  metric: AnalyseMetric;
  onWeekdayClick?: (weekday: IsoWeekday) => void;
  compact?: boolean;
  shareByWeekday?: ReadonlyMap<IsoWeekday, number | null>;
}) {
  const pad = compact ? 'py-1' : 'py-1.5';
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className={cn('px-2 text-left font-medium', pad)}>Wochentag</th>
            <th className={cn('px-2 text-right font-medium', pad)}>{ANALYSE_METRIC_LABEL[metric]} Ist</th>
            <th className={cn('px-2 text-right font-medium', pad)}>Vorjahr</th>
            <th className={cn('px-2 text-right font-medium', pad)}>Diff.</th>
            <th className={cn('px-2 text-right font-medium', pad)}>Diff. %</th>
            {shareByWeekday ? (
              <th className={cn('px-2 text-right font-medium', pad)}>Anteil Monat</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = pickMetric(r, metric);
            const empty = v.current === 0 && (v.prior ?? 0) === 0;
            return (
              <tr
                key={r.weekday}
                className={cn(
                  'border-b last:border-0',
                  empty && 'text-muted-foreground/60',
                  onWeekdayClick && 'cursor-pointer transition-colors hover:bg-muted/50',
                )}
                onClick={onWeekdayClick ? () => onWeekdayClick(r.weekday) : undefined}
                title={onWeekdayClick ? 'Zusammensetzung öffnen' : undefined}
              >
                <td className={cn('px-2 font-medium', pad)}>{WEEKDAY_LABEL[r.weekday]}</td>
                <td className={cn('px-2 text-right font-medium tabular-nums', pad)}>
                  {NUM0.format(v.current)}
                </td>
                <td className={cn('px-2 text-right tabular-nums text-muted-foreground', pad)}>
                  {fmtPrior(v.prior)}
                </td>
                <td className={cn('px-2 text-right tabular-nums', pad, TREND_TEXT[v.trend])}>
                  {fmtDiff(v.diff)}
                </td>
                <td className={cn('px-2 text-right tabular-nums', pad, TREND_TEXT[v.trend])}>
                  {fmtPct(v.diffPct)}
                </td>
                {shareByWeekday ? (
                  <td className={cn('px-2 text-right tabular-nums text-muted-foreground', pad)}>
                    {fmtShare(shareByWeekday.get(r.weekday) ?? null)}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Balkendiagramm Mo–So: Ist vs. Vorjahr nebeneinander (aktive Kennzahl). */
function WeekdayIstVorjahrChart({ data, metricLabel }: {
  data: WeekdayIstVorjahrChartPoint[];
  metricLabel: string;
}) {
  return (
    <div className="h-48 w-full" data-testid="analyse-month-weekday-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11 }} width={36} allowDecimals={false} tickLine={false} axisLine={false} />
          <RechartsTooltip
            formatter={(value: number, name: string) => [NUM0.format(value), name]}
            labelFormatter={(label: string) => {
              const wd = data.find((d) => d.label === label)?.weekday;
              return wd ? WEEKDAY_LABEL[wd] : label;
            }}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="ist" name={`${metricLabel} Ist`} fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} maxBarSize={26} />
          <Bar dataKey="vorjahr" name="Vorjahr" fill="hsl(var(--muted-foreground) / 0.35)" radius={[3, 3, 0, 0]} maxBarSize={26} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Matrix Wochentag × Monat: Wochentage Mo–So als Zeilen, Ist-Monate als
 * Spalten, hinten Total + Ø pro Monat (aktive Kennzahl). Stärkster/schwächster
 * Wochentag (nach Total) ist markiert.
 */
function WeekdayMonthMatrixTable({ matrix, extremes, metric }: {
  matrix: WeekdayMonthMatrix;
  extremes: WeekdayMatrixExtremes;
  metric: AnalyseMetric;
}) {
  const monthCount = matrix.monthKeys.length;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1.5 text-left font-medium">Wochentag</th>
            {matrix.monthKeys.map((mk) => (
              <th key={mk} className="px-2 py-1.5 text-right font-medium">{monthLabel(mk)}</th>
            ))}
            <th className="border-l px-2 py-1.5 text-right font-medium">Total</th>
            <th className="px-2 py-1.5 text-right font-medium">Ø/Monat</th>
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((r) => {
            const isStrongest = extremes.strongestWeekday === r.weekday;
            const isWeakest = extremes.weakestWeekday === r.weekday;
            const empty = cellMetricValue(r.total, metric) === 0;
            return (
              <tr
                key={r.weekday}
                className={cn(
                  'border-b last:border-0',
                  empty && 'text-muted-foreground/60',
                  isStrongest && 'bg-emerald-50 dark:bg-emerald-950/20',
                  isWeakest && 'bg-red-50 dark:bg-red-950/20',
                )}
              >
                <td className="whitespace-nowrap px-2 py-1.5 font-medium">
                  {WEEKDAY_LABEL[r.weekday]}
                  {isStrongest ? (
                    <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                      Stärkster
                    </span>
                  ) : null}
                  {isWeakest ? (
                    <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                      Schwächster
                    </span>
                  ) : null}
                </td>
                {r.values.map((v, i) => (
                  <td key={matrix.monthKeys[i]} className="px-2 py-1.5 text-right tabular-nums">
                    {NUM0.format(cellMetricValue(v, metric))}
                  </td>
                ))}
                <td className="border-l px-2 py-1.5 text-right font-medium tabular-nums">
                  {NUM0.format(cellMetricValue(r.total, metric))}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.avgPerMonth
                    ? NUM1.format(cellMetricValue(r.avgPerMonth, metric))
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30 font-medium">
            <td className="px-2 py-1.5">Total</td>
            {matrix.monthTotals.map((t, i) => (
              <td key={matrix.monthKeys[i]} className="px-2 py-1.5 text-right tabular-nums">
                {NUM0.format(cellMetricValue(t, metric))}
              </td>
            ))}
            <td className="border-l px-2 py-1.5 text-right tabular-nums">
              {NUM0.format(cellMetricValue(matrix.grandTotal, metric))}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
              {monthCount > 0
                ? NUM1.format(cellMetricValue(matrix.grandTotal, metric) / monthCount)
                : '—'}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const OCCURRENCE_NOTE = 'Hinweis: Die Anzahl Vorkommen eines Wochentags kann zwischen den Jahren abweichen (z. B. 5 statt 4 Freitage im gleichen Monat) — verglichen werden absolute Summen.';

// ── Komponente ────────────────────────────────────────────────────────────────

export default function ReservationAnalysePage() {
  const { tenantId } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const navigate = useNavigate();

  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // 1..12

  // Globaler Kennzahl-Umschalter — Standard: Personen.
  const [metric, setMetric] = useState<AnalyseMetric>(DEFAULT_ANALYSE_METRIC);
  const [scope, setScope] = useState<StatusScope>('booked');

  // Zeitraum: EIN Jahr + Von/Bis-Monat. Default: Jahr bis heute.
  const [range, setRange] = useState<AnalyseMonthRange>({
    year: currentYear, fromMonth: 1, toMonth: currentMonth,
  });

  // Detail-Popups.
  const [detailMonthKey, setDetailMonthKey] = useState<string | null>(null);
  const [detailWeekday, setDetailWeekday] = useState<IsoWeekday | null>(null);
  const [detailCell, setDetailCell] = useState<{ monthKey: string; weekday: IsoWeekday } | null>(null);

  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [currentRows, setCurrentRows] = useState<ReservationDetailRow[]>([]);
  const [priorRows, setPriorRows] = useState<ReservationDetailRow[]>([]);
  const [loading, setLoading] = useState(true);

  const { year, fromMonth, toMonth } = range;
  const rangeInvalid = fromMonth > toMonth;

  // Ist-Monate + zugehörige Datumsbereiche (Ist und Vorjahr).
  const monthKeys = useMemo(
    () => (rangeInvalid ? [] : monthKeysInRange(`${year}-${pad2(fromMonth)}`, `${year}-${pad2(toMonth)}`)),
    [year, fromMonth, toMonth, rangeInvalid],
  );
  const currentRange = useMemo(
    () => (monthKeys.length ? rangeFromMonthKeys(monthKeys[0], monthKeys[monthKeys.length - 1]) : null),
    [monthKeys],
  );
  const priorRange = useMemo(
    () => (monthKeys.length
      ? rangeFromMonthKeys(
        priorYearMonthKey(monthKeys[0]),
        priorYearMonthKey(monthKeys[monthKeys.length - 1]),
      )
      : null),
    [monthKeys],
  );

  // Tabellen-Existenz EINMALIG prüfen (nur Admin, keine Gast-Session).
  useEffect(() => {
    if (!isAdmin || isGuest) return;
    let alive = true;
    void checkReservationTablesExist().then((ok) => { if (alive) setTablesOk(ok); });
    return () => { alive = false; };
  }, [isAdmin, isGuest]);

  // Ist- UND Vorjahres-Zeitraum laden (mandantengefiltert, read-only).
  useEffect(() => {
    if (!isAdmin || isGuest) { setLoading(false); return; }
    if (tablesOk === null) return;
    if (tablesOk === false || !currentRange || !priorRange) {
      setCurrentRows([]); setPriorRows([]); setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void Promise.all([
      fetchReservationsInRange(tenantId, currentRange.from, currentRange.to),
      fetchReservationsInRange(tenantId, priorRange.from, priorRange.to),
    ]).then(([cur, prior]) => {
      if (alive) { setCurrentRows(cur); setPriorRows(prior); setLoading(false); }
    }).catch((err) => {
      console.error('[ANALYSE] Laden der Reservationsdaten fehlgeschlagen:', err);
      if (alive) { setCurrentRows([]); setPriorRows([]); setLoading(false); }
    });
    return () => { alive = false; };
  }, [tenantId, isAdmin, isGuest, tablesOk, currentRange, priorRange]);

  // ── Berechnungen (rein, getestet) ──────────────────────────────────────────

  const comparison = useMemo(
    () => buildYoyComparison({ currentRows, priorRows, monthKeys, scope }),
    [currentRows, priorRows, monthKeys, scope],
  );

  const rangeWeekdays = useMemo(
    () => buildYoyWeekdayComparison({ currentRows, priorRows, monthKeys, scope }),
    [currentRows, priorRows, monthKeys, scope],
  );

  // Monats-Popup: Tagesvergleich + Wochentagsverteilung des Monats.
  const dayComparison = useMemo(
    () => (detailMonthKey
      ? buildYoyDayComparison({
        currentRows, priorRows, monthKey: detailMonthKey, scope, metric,
      })
      : null),
    [detailMonthKey, currentRows, priorRows, scope, metric],
  );
  const detailMonthWeekdays = useMemo(
    () => (detailMonthKey
      ? buildYoyWeekdayComparison({
        currentRows, priorRows, monthKeys: [detailMonthKey], scope,
      })
      : null),
    [detailMonthKey, currentRows, priorRows, scope],
  );
  const detailMonthRow = useMemo(
    () => comparison.months.find((m) => m.monthKey === detailMonthKey) ?? null,
    [comparison, detailMonthKey],
  );
  const detailMonthKpis = useMemo(
    () => (detailMonthRow ? buildMonthDetailKpis(detailMonthRow) : null),
    [detailMonthRow],
  );
  const detailMonthComposition = useMemo(
    () => (detailMonthWeekdays
      ? buildMonthWeekdayComposition(detailMonthWeekdays.rows, metric)
      : null),
    [detailMonthWeekdays, metric],
  );
  const detailMonthShares = useMemo(
    () => (detailMonthComposition
      ? new Map(detailMonthComposition.map((r) => [r.weekday, r.sharePct]))
      : null),
    [detailMonthComposition],
  );
  const detailMonthChartData = useMemo(
    () => (detailMonthWeekdays
      ? buildWeekdayIstVorjahrChartData(detailMonthWeekdays.rows, metric)
      : null),
    [detailMonthWeekdays, metric],
  );
  const detailMonthDayFlags = useMemo(
    () => (dayComparison ? monthDetailDayFlags(dayComparison) : null),
    [dayComparison],
  );

  // Wochentag-Popup: Zusammensetzung (Monatsaufschlüsselung dieses Wochentags).
  const weekdayBreakdown = useMemo(
    () => (detailWeekday
      ? buildWeekdayMonthBreakdown({
        currentRows, priorRows, monthKeys, weekday: detailWeekday, scope,
      })
      : null),
    [detailWeekday, currentRows, priorRows, monthKeys, scope],
  );
  const detailWeekdayRow = useMemo(
    () => rangeWeekdays.rows.find((r) => r.weekday === detailWeekday) ?? null,
    [rangeWeekdays, detailWeekday],
  );

  // Heatmap Monat × Wochentag (nur Ist-Zeitraum) + relative Farbskala.
  const heatmap = useMemo(
    () => buildMonthWeekdayHeatmap({ rows: currentRows, monthKeys, scope }),
    [currentRows, monthKeys, scope],
  );
  const heatmapScale = useMemo(
    () => heatmapValueScale(heatmap, metric),
    [heatmap, metric],
  );

  // Matrix Wochentag × Monat (transponierte Heatmap-Basis) + Extrem-Markierung.
  const weekdayMatrix = useMemo(
    () => buildWeekdayMonthMatrix(heatmap),
    [heatmap],
  );
  const weekdayMatrixFlags = useMemo(
    () => weekdayMatrixExtremes(weekdayMatrix, metric),
    [weekdayMatrix, metric],
  );

  // Heatmap-Zellen-Popup: Monatszeile + Zelle + Tagesaufschlüsselung.
  const detailCellMonthRow = useMemo(
    () => (detailCell
      ? heatmap.months.find((m) => m.monthKey === detailCell.monthKey) ?? null
      : null),
    [heatmap, detailCell],
  );
  const detailCellData = useMemo(
    () => (detailCell && detailCellMonthRow
      ? detailCellMonthRow.cells.find((c) => c.weekday === detailCell.weekday) ?? null
      : null),
    [detailCellMonthRow, detailCell],
  );
  const detailCellDays = useMemo(
    () => (detailCell
      ? buildWeekdayDayBreakdown({
        rows: currentRows, monthKey: detailCell.monthKey,
        weekday: detailCell.weekday, scope, metric,
      })
      : null),
    [detailCell, currentRows, scope, metric],
  );

  const { totals } = comparison;
  const activeTotals = pickMetric(totals, metric);
  const priorIncomplete = totals.monthsWithPrior > 0 && totals.monthsWithPrior < totals.monthCount;

  const avgCurrent = avgPersonsPerReservation(totals.persons.current, totals.reservations.current);
  const avgPrior = (totals.persons.prior !== null && totals.reservations.prior !== null)
    ? avgPersonsPerReservation(totals.persons.prior, totals.reservations.prior)
    : null;

  const yearOptions = useMemo(() => {
    const ys: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 5; y--) ys.push(y);
    return ys;
  }, [currentYear]);

  const rangeLabel = monthKeys.length
    ? `${monthLabel(monthKeys[0])}${monthKeys.length > 1 ? `–${monthLabel(monthKeys[monthKeys.length - 1])}` : ''}`
    : '';

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  return (
    <div className="container mx-auto max-w-5xl space-y-4 p-4 pb-24 md:pb-8">
      {/* Kopf */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/gaeste')}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Gäste CRM
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <BarChart3 className="h-5 w-5 text-primary" />
            Reservations Analyse
          </h1>
          <p className="text-xs text-muted-foreground">
            Personen, Reservationen und Vorjahrvergleiche auf einen Blick.
          </p>
        </div>
        {/* Globaler Kennzahl-Umschalter — sichtbar, aber ruhig */}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:inline">
            Kennzahl
          </span>
          <SegmentedGroup>
            {ANALYSE_METRICS.map((m) => (
              <Button
                key={m}
                variant={metric === m ? 'default' : 'ghost'}
                size="sm" className="h-7 px-3"
                onClick={() => setMetric(m)}
              >
                {ANALYSE_METRIC_LABEL[m]}
              </Button>
            ))}
          </SegmentedGroup>
        </div>
      </div>

      {/* Zeitraum + Schnellbuttons + Status-Filter */}
      <Card>
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            {/* Zeitraum: Jahr + Von/Bis-Monat gruppiert */}
            <div className="flex items-end gap-2">
              <div>
                <FieldLabel>Jahr</FieldLabel>
                <Select value={String(year)} onValueChange={(v) => setRange((r) => ({ ...r, year: +v }))}>
                  <SelectTrigger className="h-8 w-[88px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((y) => (
                      <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <FieldLabel>Von</FieldLabel>
                <Select value={String(fromMonth)} onValueChange={(v) => setRange((r) => ({ ...r, fromMonth: +v }))}>
                  <SelectTrigger className="h-8 w-[128px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <FieldLabel>Bis</FieldLabel>
                <Select value={String(toMonth)} onValueChange={(v) => setRange((r) => ({ ...r, toMonth: +v }))}>
                  <SelectTrigger className="h-8 w-[128px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Status-Filter als segmentierte Gruppe */}
            <div className="ml-auto">
              <FieldLabel>Status</FieldLabel>
              <SegmentedGroup>
                {STATUS_SCOPES.map((s) => (
                  <Button
                    key={s}
                    variant={scope === s ? 'default' : 'ghost'}
                    size="sm" className="h-7 px-3"
                    onClick={() => setScope(s)}
                  >
                    {STATUS_SCOPE_LABEL[s]}
                  </Button>
                ))}
              </SegmentedGroup>
            </div>
          </div>
          {/* Schnellwahl (Presets) — frei wählbar bleibt oben */}
          <div className="border-t pt-2.5">
            <FieldLabel>Schnellwahl</FieldLabel>
            <div className="flex flex-wrap gap-1">
              {ANALYSE_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  variant={matchesPreset(range, p.key, today) ? 'secondary' : 'outline'}
                  size="sm" className="h-7 text-xs"
                  onClick={() => setRange(presetMonthRange(p.key, today))}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {rangeInvalid ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            „Von Monat" liegt nach „Bis Monat" — bitte Zeitraum korrigieren.
          </CardContent>
        </Card>
      ) : tablesOk === false ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Database className="h-4 w-4" />
            Reservationsdaten sind noch nicht eingerichtet — bitte zuerst den
            Foratable-Import ausführen.
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Lade Reservationen …
        </div>
      ) : (
        <>
          {/* Hinweis bei (teilweise) fehlendem Vorjahr */}
          {totals.monthsWithPrior === 0 ? (
            <AmberNote>
              Für den Vergleichszeitraum {year - 1} sind keine Vorjahresdaten
              vorhanden — Differenzen können nicht berechnet werden.
            </AmberNote>
          ) : priorIncomplete ? (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Vorjahresdaten sind nur für {totals.monthsWithPrior} von{' '}
              {totals.monthCount} Monaten vorhanden — die Totale vergleichen nur
              Monate mit Vorjahresdaten.
            </div>
          ) : null}

          {/* KPI-Kacheln (aktive Kennzahl) */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <KpiTile
              label={`${ANALYSE_METRIC_LABEL[metric]} Ist`}
              value={NUM0.format(activeTotals.current)}
              sub={avgCurrent !== null ? `Ø ${NUM1.format(avgCurrent)} Pers./Reservation` : undefined}
            />
            <KpiTile
              label={`${ANALYSE_METRIC_LABEL[metric]} Vorjahr`}
              value={fmtPrior(activeTotals.prior)}
              sub={avgPrior !== null ? `Ø ${NUM1.format(avgPrior)} Pers./Reservation` : undefined}
            />
            <KpiTile
              label="Differenz"
              value={fmtDiff(activeTotals.diff)}
              trend={activeTotals.trend}
            />
            <KpiTile
              label="Differenz %"
              value={fmtPct(activeTotals.diffPct)}
              trend={activeTotals.trend}
            />
          </div>

          {/* Sektionen */}
          <Tabs defaultValue="monate">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="monate">Monate</TabsTrigger>
              <TabsTrigger value="wochentage">Wochentage</TabsTrigger>
              <TabsTrigger value="saison">Saison</TabsTrigger>
              <TabsTrigger value="matrix">Matrix</TabsTrigger>
              <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
            </TabsList>

            <TabsContent value="monate" className="mt-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Monatsvergleich {year} vs. {year - 1}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Klick auf einen Monat öffnet den Tagesvergleich
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <MonthYoyTable
                    months={comparison.months}
                    totals={totals}
                    metric={metric}
                    onMonthClick={setDetailMonthKey}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="wochentage" className="mt-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Wochentage Mo–So · {rangeLabel} vs. Vorjahr
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      Klick auf einen Wochentag zeigt die Zusammensetzung
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 p-3 pt-0">
                  <WeekdayYoyTable
                    rows={rangeWeekdays.rows}
                    metric={metric}
                    onWeekdayClick={setDetailWeekday}
                  />
                  <p className="text-[11px] text-muted-foreground">{OCCURRENCE_NOTE}</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="saison" className="mt-3 space-y-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Monatsaufschlüsselung · {rangeLabel} vs. gleicher Zeitraum Vorjahr
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <MonthYoyTable
                    months={comparison.months}
                    totals={totals}
                    metric={metric}
                    onMonthClick={setDetailMonthKey}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Wochentagsaufschlüsselung</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 p-3 pt-0">
                  <WeekdayYoyTable
                    rows={rangeWeekdays.rows}
                    metric={metric}
                    onWeekdayClick={setDetailWeekday}
                    compact
                  />
                  <p className="text-[11px] text-muted-foreground">{OCCURRENCE_NOTE}</p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="matrix" className="mt-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Wochentage nach Monat · {rangeLabel}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {ANALYSE_METRIC_LABEL[metric]} je Wochentag und Monat
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 p-3 pt-0">
                  <WeekdayMonthMatrixTable
                    matrix={weekdayMatrix}
                    extremes={weekdayMatrixFlags}
                    metric={metric}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Total = Summe über den gewählten Zeitraum, Ø/Monat = Total ÷ Anzahl Monate.
                    Stärkster/schwächster Wochentag nach Zeitraum-Total markiert.
                    {' '}{OCCURRENCE_NOTE}
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="heatmap" className="mt-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Heatmap Monat × Wochentag · {rangeLabel}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {ANALYSE_METRIC_LABEL[metric]} — Klick auf eine Zelle öffnet die Details
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 p-3 pt-0">
                  <HeatmapTable
                    heatmap={heatmap}
                    scale={heatmapScale}
                    metric={metric}
                    onCellClick={(monthKey, weekday) => setDetailCell({ monthKey, weekday })}
                  />
                  <HeatmapLegend />
                  <p className="text-[11px] text-muted-foreground">
                    Obere Zahl = {ANALYSE_METRIC_LABEL[metric]}, untere = Anteil am Monat.
                    Farbskala relativ zum aktuell gewählten Zeitraum.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}

      {/* Monats-Popup: Tagesvergleich */}
      <Dialog open={detailMonthKey !== null} onOpenChange={(open) => { if (!open) setDetailMonthKey(null); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {detailMonthKey && dayComparison ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {monthLongLabel(detailMonthKey)} vs. {monthLongLabel(dayComparison.priorMonthKey)}
                </DialogTitle>
                <DialogDescription>
                  {ANALYSE_METRIC_LABEL[metric]} pro Tag — Paarung über den Tag im Monat.
                </DialogDescription>
              </DialogHeader>

              {!dayComparison.hasPriorData ? (
                <AmberNote>
                  Für {monthLongLabel(dayComparison.priorMonthKey)} sind keine
                  Vorjahresdaten vorhanden — es wird nur der Ist-Monat angezeigt.
                </AmberNote>
              ) : null}

              {detailMonthKpis ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <KpiTile label="Reservationen Ist" value={NUM0.format(detailMonthKpis.reservations.current)} />
                  <KpiTile label="Reservationen Vorjahr" value={fmtPrior(detailMonthKpis.reservations.prior)} />
                  <KpiTile label="Personen Ist" value={NUM0.format(detailMonthKpis.persons.current)} />
                  <KpiTile label="Personen Vorjahr" value={fmtPrior(detailMonthKpis.persons.prior)} />
                  <KpiTile
                    label={`Differenz ${ANALYSE_METRIC_LABEL[metric]}`}
                    value={fmtDiff(pickMetric(detailMonthKpis, metric).diff)}
                    trend={pickMetric(detailMonthKpis, metric).trend}
                  />
                  <KpiTile
                    label="Differenz %"
                    value={fmtPct(pickMetric(detailMonthKpis, metric).diffPct)}
                    trend={pickMetric(detailMonthKpis, metric).trend}
                    sub={ANALYSE_METRIC_LABEL[metric]}
                  />
                  <KpiTile label="Ø Pers./Res. Ist" value={fmtAvg(detailMonthKpis.avgCurrent)} />
                  <KpiTile label="Ø Pers./Res. Vorjahr" value={fmtAvg(detailMonthKpis.avgPrior)} />
                </div>
              ) : null}

              {/* Stärkste / schwächste Tage (aktive Kennzahl) */}
              <div className="grid gap-2 sm:grid-cols-2">
                <DayHighlightCard
                  title="Stärkste Tage (Ist)"
                  days={dayComparison.strongestDays}
                  metric={metric}
                  tone="up"
                />
                <DayHighlightCard
                  title="Schwächste Tage (Ist)"
                  days={dayComparison.weakestDays}
                  metric={metric}
                  tone="down"
                />
              </div>

              {/* Balkendiagramm Mo–So: Ist vs. Vorjahr */}
              {detailMonthChartData ? (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Wochentage: {ANALYSE_METRIC_LABEL[metric]} Ist vs. Vorjahr
                  </div>
                  <WeekdayIstVorjahrChart
                    data={detailMonthChartData}
                    metricLabel={ANALYSE_METRIC_LABEL[metric]}
                  />
                </div>
              ) : null}

              {/* Wochentag-Zusammensetzung im Monat (inkl. Anteil des Monats) */}
              {detailMonthWeekdays ? (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Wochentag-Zusammensetzung (Mo–So)
                  </div>
                  <WeekdayYoyTable
                    rows={detailMonthWeekdays.rows}
                    metric={metric}
                    compact
                    shareByWeekday={detailMonthShares ?? undefined}
                  />
                </div>
              ) : null}

              {/* Tages-Tabelle: Wochentag + beide Kennzahlen; Vorjahr/Diff. der aktiven */}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium">Tag</th>
                      <th className="px-2 py-1.5 text-left font-medium">WT</th>
                      <th className="px-2 py-1.5 text-right font-medium">Res.</th>
                      <th className="px-2 py-1.5 text-right font-medium">Pers.</th>
                      <th className="px-2 py-1.5 text-right font-medium">Vorjahr ({ANALYSE_METRIC_LABEL[metric]})</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayComparison.days.map((d) => {
                      const v = pickMetric(d, metric);
                      const empty = v.current === 0 && (v.prior ?? 0) === 0;
                      const weekday = d.currentDate ? isoWeekdayOf(d.currentDate) : null;
                      const isStrongest = detailMonthDayFlags?.strongestDay === d.day;
                      const isWeakest = detailMonthDayFlags?.weakestDay === d.day;
                      return (
                        <tr
                          key={d.day}
                          className={cn(
                            'border-b last:border-0',
                            empty && 'text-muted-foreground/60',
                            isStrongest && 'bg-emerald-50 dark:bg-emerald-950/20',
                            isWeakest && 'bg-red-50 dark:bg-red-950/20',
                          )}
                        >
                          <td className="whitespace-nowrap px-2 py-1 tabular-nums">
                            {d.day}.
                            {d.currentDate === null ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">(nur VJ)</span>
                            ) : null}
                            {isStrongest ? (
                              <span className="ml-1.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                Stärkster
                              </span>
                            ) : null}
                            {isWeakest ? (
                              <span className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                Schwächster
                              </span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1 text-muted-foreground">
                            {weekday ? WEEKDAY_SHORT[weekday] : '—'}
                          </td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', metric === 'reservations' && 'font-medium')}>
                            {NUM0.format(d.reservations.current)}
                          </td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', metric === 'persons' && 'font-medium')}>
                            {NUM0.format(d.persons.current)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{fmtPrior(v.prior)}</td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', TREND_TEXT[v.trend])}>
                            {fmtDiff(v.diff)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Wochentag-Popup: Zusammensetzung */}
      <Dialog open={detailWeekday !== null} onOpenChange={(open) => { if (!open) setDetailWeekday(null); }}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          {detailWeekday && weekdayBreakdown ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {WEEKDAY_LABEL[detailWeekday]} — Zusammensetzung
                </DialogTitle>
                <DialogDescription>
                  {ANALYSE_METRIC_LABEL[metric]} an allen {WEEKDAY_LABEL[detailWeekday]}en
                  je Monat, verglichen mit dem Vorjahr.
                </DialogDescription>
              </DialogHeader>

              {detailWeekdayRow ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <KpiTile label="Ist" value={NUM0.format(pickMetric(detailWeekdayRow, metric).current)} />
                  <KpiTile label="Vorjahr" value={fmtPrior(pickMetric(detailWeekdayRow, metric).prior)} />
                  <KpiTile
                    label="Differenz" value={fmtDiff(pickMetric(detailWeekdayRow, metric).diff)}
                    trend={pickMetric(detailWeekdayRow, metric).trend}
                  />
                  <KpiTile
                    label="Differenz %" value={fmtPct(pickMetric(detailWeekdayRow, metric).diffPct)}
                    trend={pickMetric(detailWeekdayRow, metric).trend}
                  />
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium">Monat</th>
                      <th className="px-2 py-1.5 text-right font-medium">{ANALYSE_METRIC_LABEL[metric]} Ist</th>
                      <th className="px-2 py-1.5 text-right font-medium">Vorjahr</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff.</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff. %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekdayBreakdown.map((r) => {
                      const v = pickMetric(r, metric);
                      const empty = v.current === 0 && (v.prior ?? 0) === 0;
                      return (
                        <tr key={r.monthKey} className={cn('border-b last:border-0', empty && 'text-muted-foreground/60')}>
                          <td className="px-2 py-1 font-medium">
                            {monthLabel(r.monthKey)}
                            {!r.hasPriorData ? (
                              <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">kein Vorjahr</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{NUM0.format(v.current)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{fmtPrior(v.prior)}</td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', TREND_TEXT[v.trend])}>
                            {fmtDiff(v.diff)}
                          </td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', TREND_TEXT[v.trend])}>
                            {fmtPct(v.diffPct)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted-foreground">{OCCURRENCE_NOTE}</p>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Heatmap-Zellen-Popup: ein Wochentag in einem Monat */}
      <Dialog open={detailCell !== null} onOpenChange={(open) => { if (!open) setDetailCell(null); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {detailCell && detailCellData && detailCellMonthRow && detailCellDays ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {WEEKDAY_LABEL[detailCell.weekday]} · {monthLongLabel(detailCell.monthKey)}
                </DialogTitle>
                <DialogDescription>
                  Alle {WEEKDAY_LABEL[detailCell.weekday]}e im {monthLongLabel(detailCell.monthKey)} —
                  {' '}aktive Kennzahl: {ANALYSE_METRIC_LABEL[metric]}.
                </DialogDescription>
              </DialogHeader>

              {/* Grosse KPI-Kacheln */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <KpiTile label="Reservationen" value={NUM0.format(detailCellData.reservations)} />
                <KpiTile label="Personen" value={NUM0.format(detailCellData.persons)} />
                <KpiTile
                  label="Ø Pers./Res."
                  value={(() => {
                    const a = avgPersonsPerReservation(detailCellData.persons, detailCellData.reservations);
                    return a === null ? '—' : NUM1.format(a);
                  })()}
                />
                <KpiTile
                  label="Anteil am Monat"
                  value={(() => {
                    const s = cellShareOfMonth(detailCellData, detailCellMonthRow, metric);
                    return s === null ? '—' : `${PCT1.format(s)} %`;
                  })()}
                />
                <KpiTile
                  label="Anteil am Zeitraum"
                  value={(() => {
                    const s = cellShareOfRange(detailCellData, heatmap.grandTotal, metric);
                    return s === null ? '—' : `${PCT1.format(s)} %`;
                  })()}
                />
                <KpiTile
                  label="vs. Ø Monat"
                  value={(() => {
                    const c = cellVsMonthAverage(detailCellData, detailCellMonthRow, metric);
                    return c.diff === null ? '—' : fmtDiff1(c.diff);
                  })()}
                />
              </div>

              {/* Mini-Trend über alle Vorkommen dieses Wochentags */}
              {detailCellDays.entries.length > 0 ? (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Verlauf über alle {WEEKDAY_LABEL[detailCell.weekday]}e ({ANALYSE_METRIC_LABEL[metric]})
                  </div>
                  <WeekdayTrend entries={detailCellDays.entries} metric={metric} />
                </div>
              ) : null}

              {/* Tages-Liste */}
              <HeatmapDayList
                entries={detailCellDays.entries}
                strongestDate={detailCellDays.strongestDate}
                weakestDate={detailCellDays.weakestDate}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Absolute Differenz mit Vorzeichen + 1 Nachkommastelle („+3.5" / „−1.0" / „±0"). */
function fmtDiff1(diff: number): string {
  if (diff === 0) return '±0';
  return diff > 0 ? `+${NUM1.format(diff)}` : `−${NUM1.format(Math.abs(diff))}`;
}

// ── Heatmap-Bausteine ────────────────────────────────────────────────────────

const HEATMAP_LEVEL_CLASS: Record<HeatmapLevel, string> = {
  empty: 'bg-muted/40 text-muted-foreground',
  veryLow: 'bg-red-500 text-white dark:bg-red-600',
  low: 'bg-orange-400 text-orange-950 dark:bg-orange-500 dark:text-orange-950',
  mid: 'bg-yellow-300 text-yellow-950 dark:bg-yellow-400 dark:text-yellow-950',
  high: 'bg-green-400 text-green-950 dark:bg-green-500 dark:text-green-950',
  veryHigh: 'bg-green-600 text-white dark:bg-green-700',
};

const HEATMAP_LEVEL_LABEL: { level: HeatmapLevel; label: string }[] = [
  { level: 'veryLow', label: 'Sehr schwach' },
  { level: 'low', label: 'Schwach' },
  { level: 'mid', label: 'Durchschnitt' },
  { level: 'high', label: 'Gut' },
  { level: 'veryHigh', label: 'Sehr gut' },
];

/** Farb-Legende der 5 Intensitätsstufen. */
function HeatmapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {HEATMAP_LEVEL_LABEL.map(({ level, label }) => (
        <span key={level} className="flex items-center gap-1">
          <span className={cn('inline-block h-3 w-3 rounded-sm', HEATMAP_LEVEL_CLASS[level])} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Die Heatmap-Tabelle: Monate (Zeilen) × Wochentage Mo–So (Spalten). */
function HeatmapTable({ heatmap, scale, metric, onCellClick }: {
  heatmap: MonthWeekdayHeatmap;
  scale: HeatmapScale;
  metric: AnalyseMetric;
  onCellClick: (monthKey: string, weekday: IsoWeekday) => void;
}) {
  const hasData = heatmap.months.some((m) => cellMetricValue(m.total, metric) > 0);
  if (!hasData) {
    return (
      <div className="rounded-md border p-4 text-sm text-muted-foreground">
        Keine Reservationen im gewählten Zeitraum.
      </div>
    );
  }
  return (
    <TooltipProvider delayDuration={150}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-1 py-1 text-left font-medium">Monat</th>
              {ISO_WEEKDAYS.map((wd) => (
                <th key={wd} className="px-1 py-1 text-center font-medium">
                  {WEEKDAY_SHORT[wd]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {heatmap.months.map((m) => (
              <tr key={m.monthKey}>
                <td className="whitespace-nowrap px-1 py-1 text-left text-xs font-medium text-muted-foreground">
                  {monthLabel(m.monthKey)}
                </td>
                {m.cells.map((cell) => (
                  <HeatmapCellButton
                    key={cell.weekday}
                    cell={cell}
                    monthRow={m}
                    scale={scale}
                    metric={metric}
                    onClick={() => onCellClick(m.monthKey, cell.weekday)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}

/** Eine einzelne, klickbare Heatmap-Zelle mit Hover-Tooltip. */
function HeatmapCellButton({ cell, monthRow, scale, metric, onClick }: {
  cell: HeatmapCell;
  monthRow: HeatmapMonthRow;
  scale: HeatmapScale;
  metric: AnalyseMetric;
  onClick: () => void;
}) {
  const value = cellMetricValue(cell, metric);
  const level = classifyHeatmapLevel(value, scale);
  const share = cellShareOfMonth(cell, monthRow, metric);
  const tip = buildHeatmapCellTooltip(cell, monthRow, metric);
  const empty = value <= 0;
  return (
    <td className="p-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className={cn(
              'flex h-12 w-full min-w-[44px] flex-col items-center justify-center rounded-md px-1 leading-tight transition-transform hover:scale-[1.04] hover:ring-2 hover:ring-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              HEATMAP_LEVEL_CLASS[level],
            )}
            title={`${WEEKDAY_LABEL[cell.weekday]} · ${monthLabel(monthRow.monthKey)}`}
          >
            <span className="text-sm font-semibold tabular-nums">{NUM0.format(value)}</span>
            <span className="text-[10px] tabular-nums opacity-80">
              {empty || share === null ? '—' : `${PCT1.format(share)} %`}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px]">
          <div className="space-y-0.5 text-xs">
            <div className="font-medium">
              {WEEKDAY_LABEL[tip.weekday]} · {monthLabel(tip.monthKey)}
            </div>
            <div>Reservationen: {NUM0.format(tip.reservations)}</div>
            <div>Personen: {NUM0.format(tip.persons)}</div>
            <div>
              Anteil am Monat: {tip.shareOfMonth === null ? '—' : `${PCT1.format(tip.shareOfMonth)} %`}
            </div>
            <div>
              Ø Pers./Res.:{' '}
              {tip.avgPersonsPerReservation === null ? '—' : NUM1.format(tip.avgPersonsPerReservation)}
            </div>
            <div>
              vs. Ø Monat:{' '}
              {tip.vsMonthAverage.diff === null ? '—' : fmtDiff1(tip.vsMonthAverage.diff)}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

/** Kompakter Balken-Verlauf über die Wochentag-Vorkommen (aktive Kennzahl). */
function WeekdayTrend({ entries, metric }: {
  entries: HeatmapDayEntry[];
  metric: AnalyseMetric;
}) {
  const max = Math.max(1, ...entries.map((e) => cellMetricValue(e, metric)));
  return (
    <div className="flex items-end gap-1.5 rounded-md border p-2">
      {entries.map((e) => {
        const v = cellMetricValue(e, metric);
        const h = Math.round((v / max) * 100);
        return (
          <div key={e.date} className="flex flex-1 flex-col items-center gap-1" title={`${e.date}: ${NUM0.format(v)}`}>
            <div className="flex h-16 w-full items-end justify-center">
              <div
                className="w-full max-w-[28px] rounded-sm bg-primary/70"
                style={{ height: `${Math.max(4, h)}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{e.day}.</span>
          </div>
        );
      })}
    </div>
  );
}

/** Tages-Liste im Heatmap-Popup (stärkster Tag grün, schwächster rot). */
function HeatmapDayList({ entries, strongestDate, weakestDate }: {
  entries: HeatmapDayEntry[];
  strongestDate: string | null;
  weakestDate: string | null;
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        Keine Tage mit Reservationen für diesen Wochentag.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-1.5 text-left font-medium">Datum</th>
            <th className="px-2 py-1.5 text-right font-medium">Res.</th>
            <th className="px-2 py-1.5 text-right font-medium">Pers.</th>
            <th className="px-2 py-1.5 text-right font-medium">Ø Pers.</th>
            <th className="px-2 py-1.5 text-left font-medium">Uhrzeiten</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const avg = avgPersonsPerReservation(e.persons, e.reservations);
            const isStrong = e.date === strongestDate;
            const isWeak = e.date === weakestDate;
            return (
              <tr
                key={e.date}
                className={cn(
                  'border-b last:border-0',
                  isStrong && 'bg-emerald-50 dark:bg-emerald-950/20',
                  isWeak && !isStrong && 'bg-red-50 dark:bg-red-950/20',
                )}
              >
                <td className="px-2 py-1 tabular-nums">
                  {formatDayLabel(e.date)}
                  {isStrong ? (
                    <span className="ml-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">stärkster</span>
                  ) : isWeak ? (
                    <span className="ml-1.5 text-[10px] font-medium text-red-600 dark:text-red-400">schwächster</span>
                  ) : null}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{NUM0.format(e.reservations)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{NUM0.format(e.persons)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                  {avg === null ? '—' : NUM1.format(avg)}
                </td>
                <td className="px-2 py-1 text-xs text-muted-foreground">
                  {e.times.length === 0
                    ? '—'
                    : e.times.map((t) => `${t.hour}:00 (${NUM0.format(t.reservations)})`).join(' · ')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** „Fr 03.10." aus „yyyy-MM-dd" (kurzer Wochentag + Tag.Monat). */
function formatDayLabel(date: string): string {
  const wd = isoWeekdayOfDate(date);
  const dd = date.slice(8, 10);
  const mm = date.slice(5, 7);
  return `${wd ? `${WEEKDAY_SHORT[wd]} ` : ''}${dd}.${mm}.`;
}

/** ISO-Wochentag eines „yyyy-MM-dd" (nur für Anzeige-Labels). */
function isoWeekdayOfDate(date: string): IsoWeekday | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const js = new Date(t).getUTCDay(); // 0=So..6=Sa
  return (js === 0 ? 7 : js) as IsoWeekday;
}

/** Karte „stärkste/schwächste Tage" im Monats-Popup. */
function DayHighlightCard({ title, days, metric, tone }: {
  title: string;
  days: ({ day: number } & MetricPair)[];
  metric: AnalyseMetric;
  tone: 'up' | 'down';
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <TrendIcon trend={tone} className={TREND_TEXT[tone]} />
          {title}
        </div>
        {days.length === 0 ? (
          <div className="text-sm text-muted-foreground">Keine Tage mit Daten.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {days.map((d) => {
              const v = pickMetric(d, metric);
              return (
                <li key={d.day} className="flex items-center justify-between tabular-nums">
                  <span>{d.day}.</span>
                  <span className="font-medium">
                    {NUM0.format(v.current)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {metric === 'reservations' ? 'Res.' : 'Pers.'}
                      {v.prior !== null ? ` · VJ ${NUM0.format(v.prior)}` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
