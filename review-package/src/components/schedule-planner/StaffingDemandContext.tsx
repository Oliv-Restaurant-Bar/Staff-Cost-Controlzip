/**
 * StaffingDemandContext — Reservationszahlen als Nachfrage-Kontext für den
 * geprüften Tag im SOLL/Ist-Abgleich (NUR Anzeige).
 *
 * Zeigt „Erwartet: N Personen (M Res.)" (Vergangenheit: „Gebucht waren:") plus
 * die Einordnung gegen den Ø der letzten LOOKBACK_OCCURRENCES Vorkommen
 * desselben Wochentags. Gating (admin-only, keine Gast-Session) und Laden
 * stecken im Hook — für andere Rollen rendert der Baustein schlicht nichts.
 */

import { CalendarClock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDayDemandContext } from '@/hooks/useDayDemandContext';
import { WEEKDAY_LABEL } from '@/lib/reservation-weekday-analytics';
import {
  demandComparisonLabel,
  demandHeadlineLabel,
  type DayDemandContext as DayDemandContextData,
} from '@/lib/staffing-demand-context';

const NUM = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const AVG = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 });

function DemandLine({ context }: { context: DayDemandContextData }) {
  const weekdayName = WEEKDAY_LABEL[context.weekday];
  const label = demandHeadlineLabel(context.kind);
  const pct = context.pctDiffPersons;
  const comparison = demandComparisonLabel(pct, context.weekday);
  const fewData = context.occurrencesWithData > 0 && context.occurrencesWithData < 3;

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm"
      data-testid="staffing-demand-context"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {label}{' '}
          <span className="font-semibold tabular-nums">
            {NUM.format(context.dayPersons)} Personen
          </span>{' '}
          <span className="text-muted-foreground tabular-nums">
            ({NUM.format(context.dayReservations)} Res.)
          </span>
        </span>
        {comparison !== null && (
          <span
            className={cn(
              'rounded-full border border-border/60 bg-background px-2 py-0.5 text-xs font-medium tabular-nums',
            )}
          >
            {comparison}
          </span>
        )}
      </div>
      <p className="mt-1 pl-6 text-xs text-muted-foreground">
        {context.avgPersons !== null && context.occurrencesWithData > 0 ? (
          <>
            Ø der letzten {context.occurrences} {weekdayName}e:{' '}
            <span className="tabular-nums">{AVG.format(context.avgPersons)} Personen</span>{' '}
            <span className="tabular-nums">
              ({AVG.format(context.avgReservations ?? 0)} Res.)
            </span>
            {fewData && (
              <> · wenig Vergleichsdaten ({context.occurrencesWithData} von {context.occurrences} Tagen mit Reservationen)</>
            )}
          </>
        ) : (
          <>Keine Reservationen an den letzten {context.occurrences} {weekdayName}en — kein Ø-Vergleich möglich.</>
        )}
      </p>
    </div>
  );
}

/**
 * Kompakte Ein-Zeilen-Darstellung fürs DayStaffingBadge-Popover:
 * „Erwartet: 85 Pers. (23 Res.) · +20 % über Ø Montag". Nur aggregierte Werte.
 */
function CompactDemandLine({ context }: { context: DayDemandContextData }) {
  const comparison = demandComparisonLabel(context.pctDiffPersons, context.weekday);
  return (
    <p
      className="flex flex-wrap items-center gap-x-1 text-xs leading-snug"
      data-testid="staffing-demand-compact"
    >
      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span>
        {demandHeadlineLabel(context.kind)}{' '}
        <span className="font-semibold tabular-nums">{NUM.format(context.dayPersons)} Pers.</span>{' '}
        <span className="text-muted-foreground tabular-nums">
          ({NUM.format(context.dayReservations)} Res.)
        </span>
        {comparison !== null && (
          <span className="text-muted-foreground tabular-nums"> · {comparison}</span>
        )}
      </span>
    </p>
  );
}

interface StaffingDemandContextProps {
  /** Geprüfter Tag "yyyy-MM-dd". */
  date: string | null | undefined;
  className?: string;
  /** Kompakte Ein-Zeilen-Variante (DayStaffingBadge-Popover). */
  compact?: boolean;
}

export function StaffingDemandContext({ date, className, compact = false }: StaffingDemandContextProps) {
  const state = useDayDemandContext(date);

  if (state.status === 'hidden' || state.status === 'unavailable') return null;

  if (compact) {
    return (
      <div className={className}>
        {state.status === 'loading' && (
          <p className="text-[11px] text-muted-foreground animate-pulse" data-testid="staffing-demand-loading">
            Reservationszahlen werden geladen …
          </p>
        )}
        {state.status === 'error' && (
          <p
            className="text-[11px] leading-snug text-amber-700 dark:text-amber-300"
            data-testid="staffing-demand-error"
          >
            Reservationsdaten konnten nicht geladen werden.
          </p>
        )}
        {state.status === 'ready' && <CompactDemandLine context={state.context} />}
      </div>
    );
  }

  return (
    <div className={className}>
      {state.status === 'loading' && (
        <div
          className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground animate-pulse"
          data-testid="staffing-demand-loading"
        >
          Reservationszahlen werden geladen …
        </div>
      )}
      {state.status === 'error' && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300"
          data-testid="staffing-demand-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          Reservationsdaten konnten nicht geladen werden — Nachfrage-Kontext nicht verfügbar.
        </div>
      )}
      {state.status === 'ready' && <DemandLine context={state.context} />}
    </div>
  );
}
