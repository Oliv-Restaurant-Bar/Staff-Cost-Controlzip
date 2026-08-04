/**
 * StartMonthOverview — Kompakte Monatsübersicht der Startseite (T503/T504).
 * =========================================================================
 * Eigene ruhige Card: Kopfzeile mit Monat/Jahr-Auswahl + Pfeilen, darunter
 * eine schlanke Zeile pro Datenquelle (Statuspunkt, Fortschritt, Lücken,
 * letzter Datenstand, Deep-Link). Alle Zeilen kommen fertig aus der reinen
 * Ableitung buildMonthOverviewRows (SSoT-Coverage) — hier NUR Darstellung.
 *
 * Interaktion identisch zu den Datenstand-Zeilen: ganze Zeile als Link,
 * Enter (nativ) + Space (onKeyDown) lösen die Navigation aus, sichtbarer
 * Fokusring, KEINE verschachtelten Interaktiva. Gast-Sessions erhalten
 * keine Links (href=null aus der Ableitung).
 */

import { Link } from 'react-router-dom';
import { ArrowRight, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useStartMonthOverview } from '@/hooks/useStartMonthOverview';
import type { MonthOverviewRow, MonthPeriod } from '@/lib/start-overview-utils';
import { MONTH_NAMES_DE } from '@/types/reporting';
import { cn } from '@/lib/utils';

/** Ton → Punktfarbe (identische Farbsemantik wie Datenstand/«Als Nächstes»). */
const TONE_DOT: Record<MonthOverviewRow['tone'], string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-400',
  neutral: 'bg-muted-foreground/40',
  critical: 'bg-red-500',
};

/** Zeilen-Navigation per Space (Enter ist bei Links nativ). */
function spaceToClick(e: React.KeyboardEvent<HTMLAnchorElement>) {
  if (e.key === ' ') {
    e.preventDefault();
    e.currentTarget.click();
  }
}

function RowContent({ row }: { row: MonthOverviewRow }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <span className={cn('h-2 w-2 rounded-full flex-shrink-0', TONE_DOT[row.tone])} />
        {row.label}
      </span>
      <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-xs">
        {row.progress && <span className="text-muted-foreground">{row.progress}</span>}
        <span
          className={cn(
            row.tone === 'warn' || row.tone === 'critical'
              ? 'text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {row.text}
        </span>
        {row.lastImport && (
          <span className="text-muted-foreground/70">Stand {row.lastImport}</span>
        )}
        {row.href && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </span>
    </>
  );
}

export function StartMonthOverview({
  enabled,
}: {
  enabled: boolean;
}) {
  const { period, setPeriod, shiftBy, state } = useStartMonthOverview(enabled);

  const currentYear = new Date().getFullYear();
  // Jahresfenster wie in der Umsatzabstimmung (aktuelles Jahr −2) — plus das
  // per Pfeil erreichte Jahr, damit die Auswahl nie „ausserhalb" steht.
  const yearOptions = Array.from(
    new Set([currentYear + 1, currentYear, currentYear - 1, currentYear - 2, period.year]),
  ).sort((a, b) => b - a);

  const rowClass =
    'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm';

  return (
    <Card data-testid="start-month-overview">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <h3 className="text-sm font-semibold">Monatsübersicht</h3>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftBy(-1)}
            aria-label="Vorheriger Monat"
            data-testid="month-overview-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Select
            value={String(period.month)}
            onValueChange={(v) => setPeriod({ ...period, month: Number(v) })}
          >
            <SelectTrigger className="h-8 w-[120px]" data-testid="month-overview-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES_DE.slice(1).map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(period.year)}
            onValueChange={(v) => setPeriod({ ...period, year: Number(v) })}
          >
            <SelectTrigger className="h-8 w-[84px]" data-testid="month-overview-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftBy(1)}
            aria-label="Nächster Monat"
            data-testid="month-overview-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Monatsübersicht wird geladen …
          </div>
        )}
        {state.status === 'error' && (
          <div
            data-testid="month-overview-error"
            className="px-4 py-4 text-sm text-red-700 dark:text-red-300"
          >
            Monatsübersicht konnte nicht geladen werden: {state.message}
          </div>
        )}
        {state.status === 'ready' && (
          <ul className="divide-y">
            {state.rows.map((row) => (
              <li key={row.type} data-testid={`month-overview-${row.type}`}>
                {row.href ? (
                  <Link
                    to={row.href}
                    onKeyDown={spaceToClick}
                    className={cn(
                      rowClass,
                      'transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    )}
                  >
                    <RowContent row={row} />
                  </Link>
                ) : (
                  <div className={rowClass}>
                    <RowContent row={row} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export type { MonthPeriod };
