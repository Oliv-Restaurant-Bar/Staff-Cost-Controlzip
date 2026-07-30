/**
 * DayStaffingBadge — Live-Hinweis «Plan vs. Bedarf» im Dienstplan-Tageskopf.
 *
 * Mit `hints` (Kopfzahl-Logik, identisch Wochenmatrix/Cockpit) zeigt die Pille
 * geplante PERSONEN vs. Soll-Kopfzahl plus Netto-Stunden-Ampel; das Popover
 * listet je Position «über Bedarf +X» / «unter Bedarf −X» / «im Bedarf»,
 * Abdeckungs-Warnungen (unbesetzte Pflicht-Blöcke, CdS/Kalte Küche) und eine
 * Kostenwarnung, wenn die geplanten Netto-Stunden über dem Bedarf liegen.
 * Ohne `hints` fällt die Anzeige auf die Abteilungs-Zusammenfassung zurück.
 *
 * NUR Anzeige, NIE sperrend: ändert keine Dienstplan-/Bedarfs-Daten.
 */

import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle } from 'lucide-react';

import type { Department } from '@/types/personnel';
import {
  formatShortStaffingDiff,
  formatStaffingDiff,
  statusLabel,
  type DayStaffingSummaryResult,
} from '@/lib/staffing-comparison-utils';
import { positionHintLabel, type DayPlanHints } from '@/lib/staffing-day-hints';
import {
  STATUS_PILL,
  STATUS_DOT,
  STATUS_TEXT,
} from '@/components/schedule-planner/staffing-status-ui';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { StaffingDemandContext } from '@/components/schedule-planner/StaffingDemandContext';

const DEPT_LABEL: Record<Department, string> = { service: 'Service', küche: 'Küche' };
const DEPT_SHORT: Record<Department, string> = { service: 'S', küche: 'K' };

interface DayStaffingBadgeProps {
  /** Tages-Zusammenfassung je Abteilung (Personen-Schichten, Fallback-Anzeige). */
  summary: DayStaffingSummaryResult;
  /** Live-Hinweis in Kopfzahl-Logik (bevorzugte Anzeige, wenn vorhanden). */
  hints?: DayPlanHints;
  /** Anzeigedatum (nur für den Popover-Titel), z.B. „Mo, 06.07.". */
  dateLabel: string;
  /**
   * ISO-Datum "yyyy-MM-dd" für den Nachfrage-Kontext (Reservationen) im
   * Popover. Optional; ohne Datum entfällt der Block. Der Fetch passiert erst
   * beim Öffnen des Popovers (PopoverContent mountet lazy) und ist im Hook
   * admin-gegated — Manager/Gäste laden und sehen nichts.
   */
  date?: string | null;
}

export function DayStaffingBadge({ summary, hints, dateLabel, date }: DayStaffingBadgeProps) {
  if (!summary.hasRequirements || summary.departments.length === 0) return null;

  const t = hints?.totals;
  const hasWarnings = (hints?.warnings.length ?? 0) > 0;
  const pillStatus = t
    ? t.personsDiff === 0 && !hasWarnings
      ? ('optimal' as const)
      : t.personsDiff > 0
        ? ('overstaffed' as const)
        : ('understaffed' as const)
    : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 flex flex-col items-center gap-0.5 focus:outline-none"
          title="Personalbedarf-Abgleich anzeigen"
          aria-label={`Personalbedarf-Abgleich ${dateLabel}`}
          data-testid={date ? `day-plan-hint-${date}` : undefined}
        >
          {t && pillStatus ? (
            <>
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full border px-1 py-px text-[9px] font-semibold leading-none tabular-nums whitespace-nowrap',
                  STATUS_PILL[pillStatus],
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[pillStatus])} aria-hidden />
                P {t.plannedPersons}/{t.sollPersons}
                {t.personsDiff !== 0 && <span>{formatShortStaffingDiff(t.personsDiff)}</span>}
                {hasWarnings && <AlertTriangle className="h-2.5 w-2.5" aria-hidden />}
              </span>
              <span
                className={cn(
                  'text-[8px] leading-none tabular-nums font-medium',
                  t.hoursOver
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground/60',
                )}
              >
                {t.plannedHours.toFixed(1)}/{t.sollHours.toFixed(1)}h
              </span>
            </>
          ) : (
            summary.departments.map((d) => (
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
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-3"
        align="center"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Plan vs. Bedarf · {dateLabel}
        </p>

        {hints && t ? (
          <>
            {/* ── Tages-Summen (Kopfzahl + Netto-Stunden) ── */}
            <div className="mt-2 rounded-md border px-2.5 py-1.5 text-xs tabular-nums">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">Personen (Kopfzahl)</span>
                <span className={cn('font-semibold', STATUS_TEXT[t.personsStatus])}>
                  {t.plannedPersons} / {t.sollPersons}
                  {t.personsDiff !== 0 ? ` · ${formatShortStaffingDiff(t.personsDiff)}` : ''}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="font-medium">Netto-Stunden</span>
                <span className={cn('font-semibold', t.hoursOver ? 'text-red-600 dark:text-red-400' : 'text-foreground')}>
                  {t.plannedHours.toFixed(1)} / {t.sollHours.toFixed(1)} h
                  {t.hoursDiff !== 0 ? ` · ${t.hoursDiff > 0 ? '+' : '−'}${Math.abs(t.hoursDiff).toFixed(1)} h` : ''}
                </span>
              </div>
              {t.hoursOver && (
                <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-red-600 dark:text-red-400">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                  Kostenwarnung: geplante Netto-Stunden liegen über dem Bedarf.
                </p>
              )}
            </div>

            {/* ── Je Position: über/unter/im Bedarf ── */}
            <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto pr-1">
              {hints.positions.map((p) => (
                <div
                  key={p.positionKey}
                  className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-xs"
                  data-testid={`plan-hint-pos-${p.positionKey}`}
                >
                  <span className="truncate">{p.positionName}</span>
                  <span className={cn('inline-flex shrink-0 items-center gap-1 font-medium tabular-nums', STATUS_TEXT[p.status])}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[p.status])} aria-hidden />
                    {p.planned}/{p.soll} · {positionHintLabel(p.diff)}
                  </span>
                </div>
              ))}
            </div>

            {/* ── Abdeckungs-Warnungen (nicht sperrend) ── */}
            {hints.warnings.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {hints.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1 text-[11px] leading-snug text-red-600 dark:text-red-400">
                    <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
                    {w}
                  </p>
                ))}
              </div>
            )}
            {hints.unmatchedPlanned > 0 && (
              <p className="mt-1 text-[11px] leading-snug text-amber-700 dark:text-amber-300">
                +{hints.unmatchedPlanned} geplant ohne zugeordneten Bedarfs-Block — Hauptposition prüfen.
              </p>
            )}
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              Kopfzahl: jede geplante Person zählt 1× je Position (Zuordnung über
              grösste Zeitüberlappung, Haupt-/Zweitposition und Regeln CdS/Kalte
              Küche). Gleiche Logik wie Wochenübersicht und Cockpit. Hinweise
              sperren nicht — Abweichen ist erlaubt.
            </p>
          </>
        ) : (
          <>
            <div className="mt-2 space-y-2">
              {summary.departments.map((d) => (
                <div key={d.department} className="rounded-md border px-2.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{DEPT_LABEL[d.department]}</span>
                    <span className={cn('text-xs font-semibold', STATUS_TEXT[d.status])}>
                      {statusLabel(d.status)}{d.diff !== 0 ? ` · ${formatStaffingDiff(d.diff)}` : ''}
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
          </>
        )}

        {/* Nachfrage-Kontext (Reservationen) — admin-only, rendert sonst nichts. */}
        <StaffingDemandContext date={date} compact className="mt-2" />
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
