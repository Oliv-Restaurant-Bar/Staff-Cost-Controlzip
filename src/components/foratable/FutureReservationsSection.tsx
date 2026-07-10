/**
 * FutureReservationsSection — Zukünftige Reservationen (Foratable Report)
 * ======================================================================
 * Zwei Bausteine für den Kopfbereich des Foratable Reports:
 *  - `FutureReservationsOverview`  — Zukunftsübersicht (max. 4 KPI-Karten +
 *    weitere Kennzahlen hinter „Weitere Kennzahlen").
 *  - `FutureCalendarSection`       — kompakte, standardmässig EINGEKLAPPTE
 *    Kalenderübersicht; Klick auf einen Tag öffnet ein Popup mit AGGREGIERTEN
 *    Tageswerten — bewusst OHNE personenbezogene Daten.
 *
 * Beide teilen sich `overview` (buildFutureOverview) und die Kennzahl (metric).
 * Alle Zahlen stammen aus foratable-future.ts und sind damit wertegleich zur
 * CRM-Auswertung.
 */

import { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, Clock, DoorOpen, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { DIALOG_MD } from '@/components/ui/dialog-size';
import { NUM0, NUM1, fdate, STATUS_LABEL } from '@/components/reservations/ReservationSummary';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';
import {
  buildDayDetail,
  levelTone,
  WEEKDAY_LABEL_LONG,
  WEEKDAY_LABEL_SHORT,
  type CalendarDay,
  type FutureLevelColor,
  type FutureMetric,
  type FutureOverview,
} from '@/lib/foratable-future';
import type { ReservationDetailRow } from '@/lib/reservation-dashboard';

// ── Farb-Flächen der Kalenderzellen (aus levelColor abgeleitet) ──────────────

const CELL_BG: Record<FutureLevelColor, string> = {
  grau: 'bg-muted/50 text-muted-foreground hover:bg-muted',
  gruen: 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-900/50',
  orange: 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-900/50',
  rot: 'bg-red-100 text-red-900 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-100 dark:hover:bg-red-900/50',
};

const WEEKDAY_COLS = [1, 2, 3, 4, 5, 6, 7];

const metricLabel = (m: FutureMetric) => (m === 'persons' ? 'Personen' : 'Reservationen');
const metricOf = (d: CalendarDay, m: FutureMetric) => (m === 'persons' ? d.persons : d.reservations);

/** Formatiert einen Tag als „Fr 18.07." (kurz, ohne Jahr). */
function shortDay(day: CalendarDay): string {
  return `${WEEKDAY_LABEL_SHORT[day.weekday]} ${fdate(day.date).slice(0, 6)}`;
}

// ── Kalender (nach Monat gruppiert, Mo–So-Raster) ────────────────────────────

function FutureCalendar({
  days,
  metric,
  onDayClick,
}: {
  days: CalendarDay[];
  metric: FutureMetric;
  onDayClick: (date: string) => void;
}) {
  const months = useMemo(() => {
    const map = new Map<string, CalendarDay[]>();
    for (const d of days) {
      const key = d.date.slice(0, 7); // yyyy-MM
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [days]);

  return (
    <div className="space-y-4" data-testid="ftr-calendar">
      {months.map(([key, monthDays]) => {
        const first = monthDays[0];
        const monthLabel = fdate(`${key}-01`).slice(3); // „MM.yyyy"
        const leadBlanks = first.weekday - 1; // Mo = 1 → 0 Blindzellen
        return (
          <div key={key} className="space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground">{monthLabel}</p>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAY_COLS.map((wd) => (
                <div key={wd} className="pb-0.5 text-center text-[10px] font-medium text-muted-foreground">
                  {WEEKDAY_LABEL_SHORT[wd]}
                </div>
              ))}
              {Array.from({ length: leadBlanks }).map((_, i) => (
                <div key={`blank-${i}`} aria-hidden />
              ))}
              {monthDays.map((d) => {
                const val = metricOf(d, metric);
                const dayNum = Number(d.date.slice(8, 10));
                return (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() => onDayClick(d.date)}
                    data-testid={`ftr-day-${d.date}`}
                    title={`${fdate(d.date)} · ${NUM0.format(d.persons)} Personen · ${NUM0.format(d.reservations)} Reservationen`}
                    className={cn(
                      'flex min-h-[46px] flex-col rounded-md border border-border/50 p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      CELL_BG[d.color],
                    )}
                  >
                    <span className="text-[10px] font-medium leading-none opacity-70">{dayNum}</span>
                    <span
                      className="mt-auto text-sm font-bold leading-none tabular-nums"
                      data-testid={`ftr-day-persons-${d.date}`}
                    >
                      {val > 0 ? NUM0.format(val) : '—'}
                    </span>
                    <span
                      className="text-[10px] leading-tight tabular-nums opacity-70"
                      data-testid={`ftr-day-res-${d.date}`}
                    >
                      {d.reservations > 0 ? `${NUM0.format(d.reservations)} Res.` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tages-Popup (nur Aggregate, KEINE PII) ───────────────────────────────────

function DayDetailDialog({
  date,
  detailRows,
  onClose,
}: {
  date: string | null;
  detailRows: ReservationDetailRow[];
  onClose: () => void;
}) {
  const detail = useMemo(
    () => (date ? buildDayDetail(detailRows, date) : null),
    [date, detailRows],
  );

  return (
    <Dialog open={!!date} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_MD} data-testid="ftr-day-dialog">
        {detail && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-primary" />
                {WEEKDAY_LABEL_LONG[detail.weekday]}, {fdate(detail.date)}
              </DialogTitle>
              <DialogDescription>
                Aggregierte Tageswerte der Reservationen — ohne personenbezogene Daten.
              </DialogDescription>
            </DialogHeader>

            {detail.active.reservations === 0 ? (
              <HintBox tone="neutral">Keine aktiven Reservationen an diesem Tag.</HintBox>
            ) : (
              <div className="space-y-4">
                <KpiGrid>
                  <KpiCard label="Reservationen" value={NUM0.format(detail.active.reservations)} tone="info" />
                  <KpiCard label="Personen" value={NUM0.format(detail.active.persons)} tone="good" />
                  <KpiCard
                    label="Ø Gruppe"
                    value={detail.avgPartySize !== null ? NUM1.format(detail.avgPartySize) : '—'}
                  />
                  <KpiCard
                    label="Zeitfenster"
                    value={detail.timeFrom ? `${detail.timeFrom}–${detail.timeTo}` : '—'}
                  />
                </KpiGrid>

                {detail.rooms.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                      <DoorOpen className="h-3.5 w-3.5" /> Räume
                    </p>
                    <ul className="space-y-1">
                      {detail.rooms.map((r) => (
                        <li key={r.room} className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate">{r.room}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {NUM0.format(r.persons)} Pers. · {NUM0.format(r.reservations)} Res.
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.statuses.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" /> Status (alle Reservationen des Tages)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.statuses.map((s) => (
                        <StatusPill key={s.status} tone="neutral" showDot={false}>
                          {STATUS_LABEL[s.status as ReservationStatusNormalized] ?? s.status}
                          {': '}
                          {NUM0.format(s.reservations)}
                        </StatusPill>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Kennzahl-Umschalter ──────────────────────────────────────────────────────

function MetricToggle({
  metric,
  onChange,
}: {
  metric: FutureMetric;
  onChange: (m: FutureMetric) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs print:hidden">
      <button
        type="button"
        onClick={() => onChange('persons')}
        aria-pressed={metric === 'persons'}
        data-testid="ftr-metric-persons"
        className={cn('px-2.5 py-1 transition-colors', metric === 'persons' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60')}
      >
        Personen
      </button>
      <button
        type="button"
        onClick={() => onChange('reservations')}
        aria-pressed={metric === 'reservations'}
        data-testid="ftr-metric-reservations"
        className={cn('border-l border-border px-2.5 py-1 transition-colors', metric === 'reservations' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60')}
      >
        Reservationen
      </button>
    </div>
  );
}

// ── (B) Zukunftsübersicht — KPI-Karten ───────────────────────────────────────

export function FutureReservationsOverview({
  overview,
  metric,
  onMetricChange,
}: {
  overview: FutureOverview;
  metric: FutureMetric;
  onMetricChange: (m: FutureMetric) => void;
}) {
  const strong = overview.strongestDay;
  const next = overview.nextStrongDay;

  const infoText = (
    <span>
      Ausblick ab heute (Vergangenheit wird abgeschnitten). „Nächste 7/14/30 Tage"
      sind feste Fenster ab heute (7/14/30 Kalendertage) und können daher leicht
      von der CRM-Auswertung abweichen (dort umfasst „Nächste 30 Tage" 31 Tage).
    </span>
  );

  return (
    <section className="space-y-3" data-testid="foratable-future">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <CalendarDays className="h-5 w-5 text-primary" />
          Zukünftige Reservationen
          <InfoTip text={infoText} />
        </h2>
        <MetricToggle metric={metric} onChange={onMetricChange} />
      </div>

      {overview.empty ? (
        <div data-testid="ftr-empty">
          <HintBox tone="info">
            Der gewählte Zeitraum liegt vollständig in der Vergangenheit — keine
            zukünftigen Reservationen anzuzeigen. Wähle einen Zeitraum ab heute.
          </HintBox>
        </div>
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Personen zukünftig"
              value={NUM0.format(overview.totals.persons)}
              sub={`${NUM0.format(overview.daysWithReservations)} Tage belegt`}
              tone="good"
            />
            <KpiCard
              label="Reservationen zukünftig"
              value={NUM0.format(overview.totals.reservations)}
              tone="info"
            />
            <KpiCard
              label="Nächster starker Tag"
              value={next ? shortDay(next) : '—'}
              sub={next ? `${NUM0.format(metricOf(next, metric))} ${metricLabel(metric)}` : 'keine hohe Auslastung'}
              tone={next ? levelTone(next.level) : 'neutral'}
            />
            <KpiCard
              label="Stärkster Tag"
              value={strong ? shortDay(strong) : '—'}
              sub={strong ? `${NUM0.format(metricOf(strong, metric))} ${metricLabel(metric)}` : '—'}
              tone={strong ? levelTone(strong.level) : 'neutral'}
            />
          </KpiGrid>

          <MoreKpis storageKey="ftr-more-kpis">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                label="Ø Gruppengrösse"
                value={overview.avgPartySize !== null ? NUM1.format(overview.avgPartySize) : '—'}
              />
              <KpiCard
                label="Nächste 7 Tage"
                value={NUM0.format(overview.next7.persons)}
                sub={`${NUM0.format(overview.next7.reservations)} Reservationen`}
              />
              <KpiCard
                label="Nächste 14 Tage"
                value={NUM0.format(overview.next14.persons)}
                sub={`${NUM0.format(overview.next14.reservations)} Reservationen`}
              />
              <KpiCard
                label="Nächste 30 Tage"
                value={NUM0.format(overview.next30.persons)}
                sub={`${NUM0.format(overview.next30.reservations)} Reservationen`}
              />
            </div>
          </MoreKpis>
        </>
      )}
    </section>
  );
}

// ── (D) Kalenderübersicht — einklappbar (default zu) ─────────────────────────

export function FutureCalendarSection({
  overview,
  metric,
  detailRows,
}: {
  overview: FutureOverview;
  metric: FutureMetric;
  detailRows: ReservationDetailRow[];
}) {
  const [open, setOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  if (overview.empty) return null;

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="ftr-calendar-toggle"
            className="flex w-full items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/60 print:hidden"
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            Kalenderübersicht
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {fdate(overview.effectiveFrom)} – {fdate(overview.effectiveTo)}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <FutureCalendar days={overview.days} metric={metric} onDayClick={setSelectedDate} />
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <Users className="h-3 w-3" />
              Farbe = relative Auslastung ({metricLabel(metric)}):
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-muted" /> keine</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-200 dark:bg-emerald-900" /> normal</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-200 dark:bg-amber-900" /> hoch</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-red-200 dark:bg-red-900" /> sehr hoch</span>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <DayDetailDialog
        date={selectedDate}
        detailRows={detailRows}
        onClose={() => setSelectedDate(null)}
      />
    </>
  );
}
