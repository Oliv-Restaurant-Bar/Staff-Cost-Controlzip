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
  monthLabel, monthLongLabel, rangeFromMonthKeys,
  STATUS_SCOPE_LABEL, WEEKDAY_LABEL, type IsoWeekday, type StatusScope,
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
  type AnalyseMetric, type AnalyseMonthRange, type MetricPair,
} from '@/lib/reservation-analyse-utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cn(
          'mt-0.5 flex items-center gap-1.5 text-xl font-semibold tabular-nums',
          trend ? TREND_TEXT[trend] : 'text-foreground',
        )}>
          {trend ? <TrendIcon trend={trend} /> : null}
          {value}
        </div>
        {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
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
          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
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

/** Wochentagsvergleich Mo–So (aktive Kennzahl), Zeilen klickbar. */
function WeekdayYoyTable({ rows, metric, onWeekdayClick, compact }: {
  rows: (MetricPair & { weekday: IsoWeekday })[];
  metric: AnalyseMetric;
  onWeekdayClick?: (weekday: IsoWeekday) => void;
  compact?: boolean;
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
              </tr>
            );
          })}
        </tbody>
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
        {/* Globaler Kennzahl-Umschalter */}
        <div className="ml-auto flex gap-1">
          {ANALYSE_METRICS.map((m) => (
            <Button
              key={m}
              variant={metric === m ? 'default' : 'outline'}
              size="sm" className="h-8"
              onClick={() => setMetric(m)}
            >
              {ANALYSE_METRIC_LABEL[m]}
            </Button>
          ))}
        </div>
      </div>

      {/* Zeitraum + Schnellbuttons + Status-Filter */}
      <Card>
        <CardContent className="space-y-2 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Jahr</div>
              <Select value={String(year)} onValueChange={(v) => setRange((r) => ({ ...r, year: +v }))}>
                <SelectTrigger className="h-8 w-[90px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Von Monat</div>
              <Select value={String(fromMonth)} onValueChange={(v) => setRange((r) => ({ ...r, fromMonth: +v }))}>
                <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Bis Monat</div>
              <Select value={String(toMonth)} onValueChange={(v) => setRange((r) => ({ ...r, toMonth: +v }))}>
                <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Status</div>
              <div className="flex gap-1">
                {STATUS_SCOPES.map((s) => (
                  <Button
                    key={s}
                    variant={scope === s ? 'default' : 'outline'}
                    size="sm" className="h-8"
                    onClick={() => setScope(s)}
                  >
                    {STATUS_SCOPE_LABEL[s]}
                  </Button>
                ))}
              </div>
            </div>
          </div>
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
            <span className="ml-1 self-center text-[11px] text-muted-foreground">
              … oder oben frei wählen
            </span>
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
            <TabsList>
              <TabsTrigger value="monate">Monat Ist vs. Vorjahr</TabsTrigger>
              <TabsTrigger value="wochentage">Wochentag-Analyse</TabsTrigger>
              <TabsTrigger value="saison">Saison / Zeitraum</TabsTrigger>
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

              {detailMonthRow ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <KpiTile label="Ist" value={NUM0.format(pickMetric(detailMonthRow, metric).current)} />
                  <KpiTile label="Vorjahr" value={fmtPrior(pickMetric(detailMonthRow, metric).prior)} />
                  <KpiTile
                    label="Differenz" value={fmtDiff(pickMetric(detailMonthRow, metric).diff)}
                    trend={pickMetric(detailMonthRow, metric).trend}
                  />
                  <KpiTile
                    label="Differenz %" value={fmtPct(pickMetric(detailMonthRow, metric).diffPct)}
                    trend={pickMetric(detailMonthRow, metric).trend}
                  />
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

              {/* Wochentagsverteilung im Monat */}
              {detailMonthWeekdays ? (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    Wochentagsverteilung (Mo–So)
                  </div>
                  <WeekdayYoyTable rows={detailMonthWeekdays.rows} metric={metric} compact />
                </div>
              ) : null}

              {/* Tages-Tabelle (aktive Kennzahl) */}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium">Tag</th>
                      <th className="px-2 py-1.5 text-right font-medium">{ANALYSE_METRIC_LABEL[metric]} Ist</th>
                      <th className="px-2 py-1.5 text-right font-medium">Vorjahr</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayComparison.days.map((d) => {
                      const v = pickMetric(d, metric);
                      const empty = v.current === 0 && (v.prior ?? 0) === 0;
                      return (
                        <tr key={d.day} className={cn('border-b last:border-0', empty && 'text-muted-foreground/60')}>
                          <td className="px-2 py-1 tabular-nums">
                            {d.day}.
                            {d.currentDate === null ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">(nur VJ)</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{NUM0.format(v.current)}</td>
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
    </div>
  );
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
