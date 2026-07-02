/**
 * ReservationVorjahrPage — Reservationen: Monat Ist vs. Vorjahr
 * ==============================================================
 * Admin-only Vergleichsansicht: pro Monat des gewählten Zeitraums werden
 * Reservationen und Personen dem gleichen Monat des VORJAHRES gegenübergestellt
 * (Okt 2025 ↔ Okt 2024; Okt–Dez 2025 ↔ Okt–Dez 2024).
 *
 *  1. Kompakte KPI-Kacheln: Ist/Vorjahr/Wachstum % für Reservationen + Personen.
 *  2. Tabelle mit Monaten als Zeilen: Ist, Vorjahr, Differenz absolut und in %
 *     — grün bei Wachstum, rot bei Rückgang, neutral bei 0/fehlendem Vorjahr.
 *  3. Klick auf einen Monat → Popup mit Tagesvergleich (Reservationen und
 *     Personen pro Tag), stärkste/schwächste Tage und Hinweis, wenn
 *     Vorjahresdaten fehlen.
 *
 * Liest ausschliesslich aus der bestehenden Tabelle `reservation_records`
 * (mandantengefiltert via `fetchReservationsInRange`, zwei Zeiträume: Ist und
 * Vorjahr) — KEINE neue Migration, KEINE Schreibzugriffe. Berechnung in
 * `reservation-yoy-utils.ts` (rein, getestet).
 *
 * Datenschutz: nur für Admins (nicht für Gast-Sessions) — Route-Guard UND
 * Lade-Effekte sind doppelt abgesichert.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft, CalendarRange, Database, Loader2, TrendingUp, TrendingDown,
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
  STATUS_SCOPE_LABEL, type StatusScope,
} from '@/lib/reservation-weekday-analytics';
import {
  monthKeysInRange, priorYearMonthKey, buildYoyComparison, buildYoyDayComparison,
  type YoyMetric, type YoyMonthRow, type YoyTrend, type YoyDayMetricKey,
} from '@/lib/reservation-yoy-utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
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

// ── KPI-Kachel ────────────────────────────────────────────────────────────────

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

// ── Komponente ────────────────────────────────────────────────────────────────

export default function ReservationVorjahrPage() {
  const { tenantId } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const navigate = useNavigate();

  const today = useMemo(() => new Date(), []);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // 1..12

  // Zeitraum: EIN Jahr + Von/Bis-Monat (Vorjahresvergleich ist monatsbasiert).
  const [year, setYear] = useState(currentYear);
  const [fromMonth, setFromMonth] = useState(1);
  const [toMonth, setToMonth] = useState(currentMonth);
  const [scope, setScope] = useState<StatusScope>('booked');

  // Detail-Popup: geklickter Monat oder null.
  const [detailMonthKey, setDetailMonthKey] = useState<string | null>(null);
  const [detailMetric, setDetailMetric] = useState<YoyDayMetricKey>('reservations');

  const [tablesOk, setTablesOk] = useState<boolean | null>(null);
  const [currentRows, setCurrentRows] = useState<ReservationDetailRow[]>([]);
  const [priorRows, setPriorRows] = useState<ReservationDetailRow[]>([]);
  const [loading, setLoading] = useState(true);

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
    });
    return () => { alive = false; };
  }, [tenantId, isAdmin, isGuest, tablesOk, currentRange, priorRange]);

  // ── Berechnungen ────────────────────────────────────────────────────────────

  const comparison = useMemo(
    () => buildYoyComparison({ currentRows, priorRows, monthKeys, scope }),
    [currentRows, priorRows, monthKeys, scope],
  );

  const dayComparison = useMemo(
    () => (detailMonthKey
      ? buildYoyDayComparison({
        currentRows, priorRows, monthKey: detailMonthKey, scope, metric: detailMetric,
      })
      : null),
    [detailMonthKey, currentRows, priorRows, scope, detailMetric],
  );

  const detailRow = useMemo(
    () => comparison.months.find((m) => m.monthKey === detailMonthKey) ?? null,
    [comparison, detailMonthKey],
  );

  const { totals } = comparison;
  const priorIncomplete = totals.monthsWithPrior > 0 && totals.monthsWithPrior < totals.monthCount;

  const yearOptions = useMemo(() => {
    const ys: number[] = [];
    for (let y = currentYear + 1; y >= currentYear - 5; y--) ys.push(y);
    return ys;
  }, [currentYear]);

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  return (
    <div className="container mx-auto max-w-5xl space-y-4 p-4 pb-24 md:pb-8">
      {/* Kopf */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate('/gaeste')}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Gäste CRM
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <CalendarRange className="h-5 w-5 text-primary" />
          Reservationen: Monat Ist vs. Vorjahr
        </h1>
      </div>

      {/* Zeitraum + Status-Filter */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">Jahr</div>
            <Select value={String(year)} onValueChange={(v) => setYear(+v)}>
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
            <Select value={String(fromMonth)} onValueChange={(v) => setFromMonth(+v)}>
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
            <Select value={String(toMonth)} onValueChange={(v) => setToMonth(+v)}>
              <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1">
            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { setYear(currentYear); setFromMonth(1); setToMonth(currentMonth); }}
            >
              Bis heute
            </Button>
            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { setFromMonth(1); setToMonth(12); }}
            >
              Ganzes Jahr
            </Button>
            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => { setFromMonth(10); setToMonth(12); }}
            >
              Okt–Dez
            </Button>
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
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Für den Vergleichszeitraum {year - 1} sind keine Vorjahresdaten
              vorhanden — Differenzen können nicht berechnet werden.
            </div>
          ) : priorIncomplete ? (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Vorjahresdaten sind nur für {totals.monthsWithPrior} von{' '}
              {totals.monthCount} Monaten vorhanden — die Totale vergleichen nur
              Monate mit Vorjahresdaten.
            </div>
          ) : null}

          {/* KPI-Kacheln */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <KpiTile label="Reservationen Ist" value={NUM0.format(totals.reservations.current)} />
            <KpiTile label="Reservationen Vorjahr" value={fmtPrior(totals.reservations.prior)} />
            <KpiTile
              label="Wachstum Reservationen"
              value={fmtPct(totals.reservations.diffPct)}
              trend={totals.reservations.trend}
              sub={fmtDiff(totals.reservations.diff)}
            />
            <KpiTile label="Personen Ist" value={NUM0.format(totals.persons.current)} />
            <KpiTile label="Personen Vorjahr" value={fmtPrior(totals.persons.prior)} />
            <KpiTile
              label="Wachstum Personen"
              value={fmtPct(totals.persons.diffPct)}
              trend={totals.persons.trend}
              sub={fmtDiff(totals.persons.diff)}
            />
          </div>

          {/* Monats-Tabelle */}
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Monat</th>
                      <th className="px-2 py-2 text-right font-medium">Res. Ist</th>
                      <th className="px-2 py-2 text-right font-medium">Res. VJ</th>
                      <th className="px-2 py-2 text-right font-medium">Diff.</th>
                      <th className="px-2 py-2 text-right font-medium">Diff. %</th>
                      <th className="border-l px-2 py-2 text-right font-medium">Pers. Ist</th>
                      <th className="px-2 py-2 text-right font-medium">Pers. VJ</th>
                      <th className="px-2 py-2 text-right font-medium">Diff.</th>
                      <th className="px-3 py-2 text-right font-medium">Diff. %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.months.map((m) => (
                      <MonthTableRow key={m.monthKey} row={m} onClick={() => {
                        setDetailMetric('reservations');
                        setDetailMonthKey(m.monthKey);
                      }} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-muted/40 font-medium">
                      <td className="px-3 py-2">Total</td>
                      <MetricCells metric={totals.reservations} />
                      <MetricCells metric={totals.persons} leftBorder padRight />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Tagesvergleich-Popup */}
      <Dialog open={detailMonthKey !== null} onOpenChange={(open) => { if (!open) setDetailMonthKey(null); }}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {detailMonthKey && dayComparison ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Tagesvergleich {monthLongLabel(detailMonthKey)} vs. {monthLongLabel(dayComparison.priorMonthKey)}
                </DialogTitle>
                <DialogDescription>
                  Reservationen und Personen pro Tag — Paarung über den Tag im Monat.
                </DialogDescription>
              </DialogHeader>

              {!dayComparison.hasPriorData ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  Für {monthLongLabel(dayComparison.priorMonthKey)} sind keine
                  Vorjahresdaten vorhanden — es wird nur der Ist-Monat angezeigt.
                </div>
              ) : null}

              {/* Monats-Zusammenfassung im Popup */}
              {detailRow ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <KpiTile label="Res. Ist" value={NUM0.format(detailRow.reservations.current)} />
                  <KpiTile
                    label="Res. vs. VJ" value={fmtDiff(detailRow.reservations.diff)}
                    trend={detailRow.reservations.trend} sub={fmtPct(detailRow.reservations.diffPct)}
                  />
                  <KpiTile label="Pers. Ist" value={NUM0.format(detailRow.persons.current)} />
                  <KpiTile
                    label="Pers. vs. VJ" value={fmtDiff(detailRow.persons.diff)}
                    trend={detailRow.persons.trend} sub={fmtPct(detailRow.persons.diffPct)}
                  />
                </div>
              ) : null}

              {/* Stärkste / schwächste Tage */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Kennzahl:</span>
                {(['reservations', 'persons'] as YoyDayMetricKey[]).map((k) => (
                  <Button
                    key={k}
                    variant={detailMetric === k ? 'default' : 'outline'}
                    size="sm" className="h-7"
                    onClick={() => setDetailMetric(k)}
                  >
                    {k === 'reservations' ? 'Reservationen' : 'Personen'}
                  </Button>
                ))}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <DayHighlightCard
                  title="Stärkste Tage (Ist)"
                  days={dayComparison.strongestDays}
                  metric={detailMetric}
                  tone="up"
                />
                <DayHighlightCard
                  title="Schwächste Tage (Ist)"
                  days={dayComparison.weakestDays}
                  metric={detailMetric}
                  tone="down"
                />
              </div>

              {/* Tages-Tabelle */}
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium">Tag</th>
                      <th className="px-2 py-1.5 text-right font-medium">Res. Ist</th>
                      <th className="px-2 py-1.5 text-right font-medium">Res. VJ</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff.</th>
                      <th className="border-l px-2 py-1.5 text-right font-medium">Pers. Ist</th>
                      <th className="px-2 py-1.5 text-right font-medium">Pers. VJ</th>
                      <th className="px-2 py-1.5 text-right font-medium">Diff.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayComparison.days.map((d) => {
                      const empty = d.reservations.current === 0
                        && (d.reservations.prior ?? 0) === 0;
                      return (
                        <tr key={d.day} className={cn('border-b last:border-0', empty && 'text-muted-foreground/60')}>
                          <td className="px-2 py-1 tabular-nums">
                            {d.day}.
                            {d.currentDate === null ? (
                              <span className="ml-1 text-[10px] text-muted-foreground">(nur VJ)</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{NUM0.format(d.reservations.current)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtPrior(d.reservations.prior)}</td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', TREND_TEXT[d.reservations.trend])}>
                            {fmtDiff(d.reservations.diff)}
                          </td>
                          <td className="border-l px-2 py-1 text-right tabular-nums">{NUM0.format(d.persons.current)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{fmtPrior(d.persons.prior)}</td>
                          <td className={cn('px-2 py-1 text-right tabular-nums', TREND_TEXT[d.persons.trend])}>
                            {fmtDiff(d.persons.diff)}
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
    </div>
  );
}

// ── Tabellen-Bausteine ────────────────────────────────────────────────────────

/** Ist/VJ/Diff/Diff% Zellen einer Kennzahl (4 <td>). */
function MetricCells({ metric, leftBorder, padRight }: {
  metric: YoyMetric;
  leftBorder?: boolean;
  padRight?: boolean;
}) {
  return (
    <>
      <td className={cn('px-2 py-2 text-right tabular-nums', leftBorder && 'border-l')}>
        {NUM0.format(metric.current)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {fmtPrior(metric.prior)}
      </td>
      <td className={cn('px-2 py-2 text-right tabular-nums', TREND_TEXT[metric.trend])}>
        {fmtDiff(metric.diff)}
      </td>
      <td className={cn(
        'py-2 text-right tabular-nums',
        padRight ? 'px-3' : 'px-2',
        TREND_TEXT[metric.trend],
      )}>
        {fmtPct(metric.diffPct)}
      </td>
    </>
  );
}

function MonthTableRow({ row, onClick }: { row: YoyMonthRow; onClick: () => void }) {
  // Zeilen-Einfärbung nach Reservations-Trend (Personen-Zellen färben separat).
  return (
    <tr
      className={cn(
        'cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50',
        TREND_BG[row.reservations.trend],
      )}
      onClick={onClick}
      title="Tagesvergleich öffnen"
    >
      <td className="px-3 py-2 font-medium">
        {monthLabel(row.monthKey)}
        {!row.hasPriorData ? (
          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">kein Vorjahr</span>
        ) : null}
      </td>
      <MetricCells metric={row.reservations} />
      <MetricCells metric={row.persons} leftBorder padRight />
    </tr>
  );
}

/** Karte „stärkste/schwächste Tage" im Popup. */
function DayHighlightCard({ title, days, metric, tone }: {
  title: string;
  days: { day: number; reservations: YoyMetric; persons: YoyMetric }[];
  metric: YoyDayMetricKey;
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
            {days.map((d) => (
              <li key={d.day} className="flex items-center justify-between tabular-nums">
                <span>{d.day}.</span>
                <span className="font-medium">
                  {NUM0.format(d[metric].current)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {metric === 'reservations' ? 'Res.' : 'Pers.'}
                    {d[metric].prior !== null ? ` · VJ ${NUM0.format(d[metric].prior)}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
