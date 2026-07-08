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
import type { DayDemandContext as DayDemandContextData } from '@/lib/staffing-demand-context';

const NUM = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const AVG = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 });

/** "+20 %" / "−12 %" mit typografischem Minus (U+2212). */
function formatPct(pct: number): string {
  const rounded = Math.round(pct);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '±';
  return `${sign}${NUM.format(Math.abs(rounded))} %`;
}

function DemandLine({ context }: { context: DayDemandContextData }) {
  const weekdayName = WEEKDAY_LABEL[context.weekday];
  const label = context.kind === 'past' ? 'Gebucht waren:' : 'Erwartet:';
  const pct = context.pctDiffPersons;
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
        {pct !== null && (
          <span
            className={cn(
              'rounded-full border border-border/60 bg-background px-2 py-0.5 text-xs font-medium tabular-nums',
            )}
          >
            {formatPct(pct)} {Math.round(pct) === 0 ? 'zum' : Math.round(pct) > 0 ? 'über' : 'unter'} Ø {weekdayName}
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

interface StaffingDemandContextProps {
  /** Geprüfter Tag "yyyy-MM-dd". */
  date: string | null | undefined;
  className?: string;
}

export function StaffingDemandContext({ date, className }: StaffingDemandContextProps) {
  const state = useDayDemandContext(date);

  if (state.status === 'hidden' || state.status === 'unavailable') return null;

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
