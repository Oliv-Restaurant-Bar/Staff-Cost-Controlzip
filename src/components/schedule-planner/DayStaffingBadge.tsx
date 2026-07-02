/**
 * DayStaffingBadge — kompakte Soll/Ist-Anzeige des Personalbedarfs im
 * Dienstplan-Tageskopf (z.B. „S 5/6 +1" je Abteilung), Details per Klick.
 *
 * NUR Anzeige: ändert keine Dienstplan-/Bedarfs-Daten. Farben folgen der
 * 3-stufigen Ampel aus staffing-comparison-utils (zu wenig rot, zu viel
 * orange, exakt grün).
 */

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import type { Department } from '@/types/personnel';
import {
  formatShortStaffingDiff,
  formatStaffingDiff,
  type ComparisonStatus,
  type DayStaffingSummaryResult,
} from '@/lib/staffing-comparison-utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const DEPT_LABEL: Record<Department, string> = { service: 'Service', küche: 'Küche' };
const DEPT_SHORT: Record<Department, string> = { service: 'S', küche: 'K' };

const STATUS_PILL: Record<ComparisonStatus, string> = {
  green:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  orange:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  red:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
};

const STATUS_DOT: Record<ComparisonStatus, string> = {
  green: 'bg-emerald-500',
  orange: 'bg-amber-500',
  red: 'bg-red-500',
};

const STATUS_TEXT: Record<ComparisonStatus, string> = {
  green: 'text-emerald-700 dark:text-emerald-300',
  orange: 'text-amber-700 dark:text-amber-300',
  red: 'text-red-700 dark:text-red-300',
};

interface DayStaffingBadgeProps {
  /** Tages-Zusammenfassung (bereits rollen-gescopt berechnet). */
  summary: DayStaffingSummaryResult;
  /** Anzeigedatum (nur für den Popover-Titel), z.B. „Mo, 06.07.". */
  dateLabel: string;
}

export function DayStaffingBadge({ summary, dateLabel }: DayStaffingBadgeProps) {
  if (!summary.hasRequirements || summary.departments.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 flex flex-col items-center gap-0.5 focus:outline-none"
          title="Personalbedarf-Abgleich anzeigen"
          aria-label={`Personalbedarf-Abgleich ${dateLabel}`}
        >
          {summary.departments.map((d) => (
            <span
              key={d.department}
              className={cn(
                'inline-flex items-center gap-0.5 rounded-full border px-1 py-px text-[9px] font-semibold leading-none tabular-nums whitespace-nowrap',
                STATUS_PILL[d.status],
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[d.status])} aria-hidden />
              {DEPT_SHORT[d.department]} {d.planned}/{d.required}
              {d.diff !== 0 && <span>{formatShortStaffingDiff(d.diff)}</span>}
            </span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        align="center"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Personalbedarf · {dateLabel}
        </p>
        <div className="mt-2 space-y-2">
          {summary.departments.map((d) => (
            <div key={d.department} className="rounded-md border px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{DEPT_LABEL[d.department]}</span>
                <span className={cn('text-xs font-semibold', STATUS_TEXT[d.status])}>
                  {formatStaffingDiff(d.diff)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                Soll <span className="font-medium text-foreground">{d.required}</span>
                {' · '}Ist <span className="font-medium text-foreground">{d.planned}</span>
              </p>
              {d.unmatchedPlanned > 0 && (
                <p className="mt-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                  +{d.unmatchedPlanned} geplant ohne zugeordnete Bedarfs-Schicht — Hauptposition prüfen.
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Soll/Ist in Personen-Schichten; gezählt wird die Hauptposition mit
          Zeitüberschneidung. Details im Abgleich-Panel unter dem Dienstplan.
        </p>
        <Link
          to="/personalbedarf"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Personalbedarf bearbeiten
          <ArrowRight className="h-3 w-3" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
