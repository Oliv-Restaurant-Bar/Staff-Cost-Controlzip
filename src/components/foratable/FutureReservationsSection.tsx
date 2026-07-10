/**
 * FutureReservationsSection — Zukünftige Reservationen (Gäste & Reservationen)
 * ===========================================================================
 * Bausteine des Zukunftsbereichs der Seite „Gäste & Reservationen":
 *  - `FutureReservationsOverview`  — Zukunftsübersicht (max. 4 KPI-Karten +
 *    weitere Kennzahlen hinter „Weitere Kennzahlen"). Die Karten sind optional
 *    klickbar (Drilldown): die Summen-Karten öffnen die Detailliste des
 *    Zeitraums, die Tages-Karten öffnen das Tages-Popup.
 *  - `FutureCalendarSection`       — kompakte, standardmässig EINGEKLAPPTE
 *    Kalenderübersicht; Klick auf einen Tag meldet das Datum via `onDayClick`
 *    an die Seite (die den EINEN Tages-Dialog besitzt).
 *  - `DayReservationsDialog`       — Tages-Popup. Ohne `showPii` rein AGGREGIERT
 *    (kein PII); mit `showPii` zusätzlich die (admin-gegatete) Detailliste mit
 *    Status-Filter. „Erwartete Personen" zählt nur aktive Reservationen
 *    (Stornos sichtbar, aber nicht mitgezählt).
 *
 * Alle Zahlen stammen aus foratable-future.ts / reservation-dashboard.ts und
 * sind damit wertegleich zur restlichen CRM-Auswertung.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, Clock, DoorOpen, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import { KpiCard, KpiGrid, MoreKpis } from '@/components/ui/kpi-card';
import { HintBox } from '@/components/ui/hint-box';
import { InfoTip } from '@/components/ui/info-tip';
import { StatusPill } from '@/components/ui/status-pill';
import { ReservationDetailList } from '@/components/crm/ReservationDetailList';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { DIALOG_MD, DIALOG_LG } from '@/components/ui/dialog-size';
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
import { filterReservationDetails, type ReservationDetailRow } from '@/lib/reservation-dashboard';

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

/** Normalisierter Status-Schlüssel (klein, Fallback „unknown"). */
const normStatus = (s: string | null | undefined) => (s ?? 'unknown').trim().toLowerCase() || 'unknown';

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

// ── Tages-Popup ──────────────────────────────────────────────────────────────
//
// Ohne `showPii`: rein AGGREGIERT (keine Namen/Telefon/E-Mail/Kommentare).
// Mit `showPii` (nur für admin-gegatete Aufrufer): zusätzlich die Detailliste
// inkl. Status-Filter. „Erwartete Personen" = aktive Personen (Stornos sind in
// der Liste sichtbar, zählen aber nicht mit).

export function DayReservationsDialog({
  date,
  detailRows,
  onClose,
  showPii = false,
  onSelectGuest,
}: {
  date: string | null;
  detailRows: ReservationDetailRow[];
  onClose: () => void;
  /** Zeigt die (admin-gegatete) Detailliste mit personenbezogenen Daten. */
  showPii?: boolean;
  onSelectGuest?: (guestId: string) => void;
}) {
  const detail = useMemo(
    () => (date ? buildDayDetail(detailRows, date) : null),
    [date, detailRows],
  );

  // Alle Reservationen des Tages (alle Status), stabil sortiert — nur für die PII-Liste.
  const dayRows = useMemo(
    () => (date && showPii ? filterReservationDetails(detailRows, date.slice(0, 10), date.slice(0, 10), () => true) : []),
    [date, detailRows, showPii],
  );

  // Whitelist-Filter der Detailliste (leer = alle Status).
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  useEffect(() => { setStatusFilter(new Set()); }, [date]);

  const filteredRows = useMemo(
    () => (statusFilter.size === 0 ? dayRows : dayRows.filter((r) => statusFilter.has(normStatus(r.status)))),
    [dayRows, statusFilter],
  );
  const filteredPersons = filteredRows.reduce((s, r) => s + (r.partySize ?? 0), 0);

  const toggleStatus = (key: string) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Dialog open={!!date} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={showPii ? DIALOG_LG : DIALOG_MD} data-testid="ftr-day-dialog">
        {detail && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-primary" />
                {WEEKDAY_LABEL_LONG[detail.weekday]}, {fdate(detail.date)}
              </DialogTitle>
              <DialogDescription>
                {showPii
                  ? 'Tagesübersicht mit Aggregatwerten und der vollständigen Reservationsliste.'
                  : 'Aggregierte Tageswerte der Reservationen — ohne personenbezogene Daten.'}
              </DialogDescription>
            </DialogHeader>

            {detail.active.reservations === 0 && detail.statuses.length === 0 ? (
              <HintBox tone="neutral">Keine Reservationen an diesem Tag.</HintBox>
            ) : (
              <div className="max-h-[75vh] space-y-4 overflow-auto">
                <KpiGrid>
                  <KpiCard label="Reservationen" value={NUM0.format(detail.active.reservations)} tone="info" />
                  <KpiCard label="Erwartete Personen" value={NUM0.format(detail.active.persons)} tone="good" />
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
                      <Clock className="h-3.5 w-3.5" />
                      Status (alle Reservationen des Tages)
                      {showPii && ' — zum Filtern anklicken'}
                    </p>
                    {showPii ? (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.statuses.map((s) => {
                          const active = statusFilter.has(s.status);
                          return (
                            <button
                              key={s.status}
                              type="button"
                              data-testid={`ftr-day-status-${s.status}`}
                              onClick={() => toggleStatus(s.status)}
                              aria-pressed={active}
                              className={cn(
                                'rounded-full border px-2 py-0.5 text-xs transition-colors',
                                active
                                  ? 'border-primary bg-primary/10 text-foreground'
                                  : 'border-border text-muted-foreground hover:bg-muted/60',
                              )}
                            >
                              {STATUS_LABEL[s.status as ReservationStatusNormalized] ?? s.status}
                              {': '}
                              {NUM0.format(s.reservations)}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.statuses.map((s) => (
                          <StatusPill key={s.status} tone="neutral" showDot={false}>
                            {STATUS_LABEL[s.status as ReservationStatusNormalized] ?? s.status}
                            {': '}
                            {NUM0.format(s.reservations)}
                          </StatusPill>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {showPii && (
                  <div data-testid="ftr-day-pii-list">
                    <ReservationDetailList
                      title="Reservationen des Tages"
                      rows={filteredRows}
                      persons={filteredPersons}
                      onSelectGuest={onSelectGuest}
                      showResNr
                      showTyp
                      hideDate
                    />
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
  onOpenTotals,
  onOpenDay,
}: {
  overview: FutureOverview;
  metric: FutureMetric;
  onMetricChange: (m: FutureMetric) => void;
  /** Öffnet die Detailliste des gesamten (aktiven) Zeitraums (Summen-Karten). */
  onOpenTotals?: () => void;
  /** Öffnet das Tages-Popup für einen bestimmten Tag (Tages-Karten). */
  onOpenDay?: (date: string) => void;
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
              data-testid="ftr-kpi-persons"
              onClick={onOpenTotals}
            />
            <KpiCard
              label="Reservationen zukünftig"
              value={NUM0.format(overview.totals.reservations)}
              tone="info"
              data-testid="ftr-kpi-reservations"
              onClick={onOpenTotals}
            />
            <KpiCard
              label="Nächster starker Tag"
              value={next ? shortDay(next) : '—'}
              sub={next ? `${NUM0.format(metricOf(next, metric))} ${metricLabel(metric)}` : 'keine hohe Auslastung'}
              tone={next ? levelTone(next.level) : 'neutral'}
              data-testid="ftr-kpi-next-strong"
              onClick={onOpenDay && next ? () => onOpenDay(next.date) : undefined}
            />
            <KpiCard
              label="Stärkster Tag"
              value={strong ? shortDay(strong) : '—'}
              sub={strong ? `${NUM0.format(metricOf(strong, metric))} ${metricLabel(metric)}` : '—'}
              tone={strong ? levelTone(strong.level) : 'neutral'}
              data-testid="ftr-kpi-strongest"
              onClick={onOpenDay && strong ? () => onOpenDay(strong.date) : undefined}
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
//
// Der Tages-Dialog wird NICHT mehr hier besessen — die Seite hält EINEN Dialog
// (wiederverwendet von Kalender + KPI-Karten) und erhält Klicks via `onDayClick`.

export function FutureCalendarSection({
  overview,
  metric,
  onDayClick,
}: {
  overview: FutureOverview;
  metric: FutureMetric;
  onDayClick: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (overview.empty) return null;

  return (
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
          <FutureCalendar days={overview.days} metric={metric} onDayClick={onDayClick} />
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
  );
}
