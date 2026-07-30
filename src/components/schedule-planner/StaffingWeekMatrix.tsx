/**
 * «Ganze Woche»-Ansicht des Personalbedarfs: Matrix Mo–So (Spalten, je Tag
 * Mittag/Abend), Zeilen = Positionen gruppiert nach Abteilung/Bereich,
 * Zelle = Soll-Anzahl; unten Tages-Summen (Einsätze, Netto-Stunden,
 * Umsatzbudget). Reine Anzeige — bearbeitet wird in der Tagesansicht.
 */
import { Fragment } from 'react';

import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import type { StaffingProfilesConfig } from '@/lib/staffing-profiles-utils';
import { buildWeekOverview, isEveningShift, type WeekCell } from '@/lib/staffing-week-utils';
import { WEEKDAYS } from '@/lib/staffing-requirements-utils';
import { DEPT_LABEL } from '@/lib/station-config';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function CellValue({ cell, part }: { cell: WeekCell | undefined; part: 'mittag' | 'abend' }) {
  const v = cell?.[part] ?? 0;
  if (v === 0) return <span className="text-muted-foreground/40">–</span>;
  const title = cell?.shifts
    .filter((s) => (part === 'abend') === isEveningShift(s.shiftStart))
    .map((s) => `${s.shiftStart}–${s.shiftEnd} × ${s.requiredCount}`)
    .join(', ');
  return (
    <span title={title} className="font-medium tabular-nums">
      {v}
    </span>
  );
}

export function StaffingWeekMatrix({
  positions,
  requirements,
  config,
  season,
  onSelectWeekday,
}: {
  positions: Position[];
  requirements: StaffingRequirement[];
  config: StaffingProfilesConfig;
  season: StaffingSeason;
  /** Klick auf eine Tagesspalte → in die Tagesansicht dieses Wochentags. */
  onSelectWeekday?: (weekday: number) => void;
}) {
  const overview = buildWeekOverview({ positions, requirements, config, season });

  if (!overview.hasAny) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          Für dieses Profil ist noch kein Bedarf hinterlegt.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="staffing-week-matrix">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm">Soll-Wochenübersicht (Mo–So · M = Mittag, A = Abend)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium">Position</th>
              {WEEKDAYS.map((w) => (
                <th key={w.value} colSpan={2} className="py-1 px-1 text-center font-medium">
                  {onSelectWeekday ? (
                    <button
                      type="button"
                      onClick={() => onSelectWeekday(w.value)}
                      className="rounded px-1 hover:bg-muted hover:text-foreground"
                      title={`${w.label}: Tagesansicht öffnen`}
                      data-testid={`week-col-${w.value}`}
                    >
                      {w.short}
                    </button>
                  ) : (
                    w.short
                  )}
                </th>
              ))}
            </tr>
            <tr className="text-[10px] text-muted-foreground border-b">
              <th />
              {WEEKDAYS.map((w) => (
                <Fragment key={w.value}>
                  <th className="pb-1 px-1 text-center font-normal">M</th>
                  <th className="pb-1 px-1 text-center font-normal border-r border-border/40 last:border-r-0">A</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.groups.map((dep) => (
              <Fragment key={dep.department}>
                <tr className="bg-muted/40">
                  <td colSpan={15} className="py-1 pr-2 text-xs font-semibold">
                    {DEPT_LABEL[dep.department]}
                  </td>
                </tr>
                {dep.areas.map((area) => (
                  <Fragment key={`${dep.department}-${area.area?.key ?? 'none'}`}>
                    {area.area && dep.areas.length > 1 && (
                      <tr>
                        <td colSpan={15} className="pt-1 pr-2 text-[11px] text-muted-foreground">
                          {area.area.name}
                        </td>
                      </tr>
                    )}
                    {area.positions.map((row) => (
                      <tr key={row.positionKey} className="border-t border-border/50">
                        <td className="py-1 pr-2 whitespace-nowrap">{row.positionName}</td>
                        {WEEKDAYS.map((w) => (
                          <Fragment key={w.value}>
                            <td className="py-1 px-1 text-center" data-testid={`week-cell-${row.positionKey}-${w.value}-m`}>
                              <CellValue cell={row.cells[w.value]} part="mittag" />
                            </td>
                            <td className="py-1 px-1 text-center border-r border-border/40 last:border-r-0">
                              <CellValue cell={row.cells[w.value]} part="abend" />
                            </td>
                          </Fragment>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot className="border-t-2">
            <tr className="text-xs">
              <td className="py-1 pr-2 font-medium">Einsätze total</td>
              {WEEKDAYS.map((w) => (
                <td key={w.value} colSpan={2} className={cn('py-1 px-1 text-center tabular-nums font-medium border-r border-border/40 last:border-r-0')} data-testid={`week-total-persons-${w.value}`}>
                  {overview.totals[w.value]?.persons ?? 0}
                </td>
              ))}
            </tr>
            <tr className="text-xs text-muted-foreground">
              <td className="py-1 pr-2">Netto-Stunden</td>
              {WEEKDAYS.map((w) => (
                <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0">
                  {(overview.totals[w.value]?.nettoHours ?? 0).toLocaleString('de-CH')}
                </td>
              ))}
            </tr>
            <tr className="text-xs text-muted-foreground">
              <td className="py-1 pr-2">Umsatzbudget (CHF)</td>
              {WEEKDAYS.map((w) => {
                const b = overview.totals[w.value]?.budget;
                return (
                  <td key={w.value} colSpan={2} className="py-1 px-1 text-center tabular-nums border-r border-border/40 last:border-r-0">
                    {b != null ? b.toLocaleString('de-CH') : '–'}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Mittag = Schichtbeginn vor 16:00, Abend = ab 16:00. Zahlen = benötigte
          Personen; Zeiten im Tooltip. Bearbeiten in der Tagesansicht (Klick auf
          einen Wochentag).
        </p>
        {season !== 'standard' && (
          <p className="text-[11px] text-muted-foreground">
            UG-Zuschlag ist an seinen Regeltagen eingerechnet; tagesbezogene
            «UG/Event offen»-Flags erscheinen hier nicht.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
