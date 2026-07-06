import { useMemo, useState } from 'react';
import { format, getISODay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Link } from 'react-router-dom';
import { ClipboardList, ArrowRight, CalendarDays } from 'lucide-react';

import type { Department, Employee } from '@/types/personnel';
import type { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import type { StaffingSeason } from '@/types/staffing';

import { usePositions } from '@/hooks/usePositions';
import { useStaffingRequirements } from '@/hooks/useStaffingRequirements';
import {
  SEASONS,
  DEFAULT_SEASON,
  weekdayLabel,
} from '@/lib/staffing-requirements-utils';
import {
  buildPlannedEmployees,
  computeStaffingComparison,
  summarizeStaffingKpis,
  formatStaffingDiff,
  type ShiftComparisonRow,
} from '@/lib/staffing-comparison-utils';
import {
  StaffingKpiCards,
  StaffingStatusBadge,
  StaffingDiffCell,
} from '@/components/schedule-planner/staffing-status-ui';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface StaffingComparisonPanelProps {
  /** Bereits rollen-gescopte Mitarbeiterliste des Dienstplans. */
  employees: Employee[];
  /** Dienstplan-Daten `${employeeId}-${yyyy-MM-dd}` → DaySchedule. */
  scheduleData: Record<string, DaySchedule>;
  /** Startdatum (z.B. der angezeigte Dienstplan-Tag). Default = heute. */
  initialDate?: Date | null;
  /** Optionale Abteilungs-Beschränkung (Rollen-Scoping, z.B. Küchen-Manager). */
  departments?: Department[];
  /**
   * Optional kontrollierte Saison (geteilt mit den Tages-Badges im Dienstplan).
   * Ohne diese Props verwaltet das Panel die Saison intern wie bisher.
   */
  season?: StaffingSeason;
  onSeasonChange?: (season: StaffingSeason) => void;
}

const DEPARTMENT_LABEL: Record<Department, string> = {
  service: 'Service',
  küche: 'Küche',
};

function ShiftRows({ shifts }: { shifts: ShiftComparisonRow[] }) {
  return (
    <>
      {shifts.map((s, i) => (
        <tr key={s.requirementId ?? `${s.positionKey}-${s.shiftStart}-${i}`} className="border-t border-border/60">
          <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap text-sm">
            {s.shiftStart}–{s.shiftEnd}
          </td>
          <td className="py-1.5 px-3 text-center tabular-nums text-sm">{s.required}</td>
          <td className="py-1.5 px-3 text-center tabular-nums text-sm">{s.planned}</td>
          <td className="py-1.5 px-3 text-right text-sm">
            <StaffingDiffCell data={{ required: s.required, planned: s.planned, diff: s.diff }} />
          </td>
          <td className="py-1.5 pl-3 text-right">
            <StaffingStatusBadge status={s.status} diff={s.diff} />
          </td>
        </tr>
      ))}
    </>
  );
}

export function StaffingComparisonPanel({
  employees,
  scheduleData,
  initialDate,
  departments,
  season: seasonProp,
  onSeasonChange,
}: StaffingComparisonPanelProps) {
  const { positions, loading: posLoading } = usePositions();
  const { requirements, loading: reqLoading } = useStaffingRequirements();

  const [selectedDate, setSelectedDate] = useState<Date>(initialDate ?? new Date());
  const [internalSeason, setInternalSeason] = useState<StaffingSeason>(DEFAULT_SEASON);
  // Kontrolliert (geteilt mit den Dienstplan-Badges), sonst interner State.
  const season = seasonProp ?? internalSeason;
  const setSeason = onSeasonChange ?? setInternalSeason;

  const dateStr = format(selectedDate, 'yyyy-MM-dd');
  const weekday = getISODay(selectedDate); // 1..7 (Mo..So)

  const plannedEmployees = useMemo(
    () => buildPlannedEmployees(employees, scheduleData, positions, dateStr),
    [employees, scheduleData, positions, dateStr],
  );

  const result = useMemo(
    () =>
      computeStaffingComparison({
        positions,
        requirements,
        plannedEmployees,
        season,
        weekday,
        departments,
      }),
    [positions, requirements, plannedEmployees, season, weekday, departments],
  );

  const kpis = useMemo(() => summarizeStaffingKpis(result.rows), [result.rows]);

  const loading = posLoading || reqLoading;

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Personalbedarf-Abgleich</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                SOLL-Besetzung vs. eingeplante Mitarbeitende ·{' '}
                {weekdayLabel(weekday)}, {format(selectedDate, 'dd.MM.yyyy', { locale: de })}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="date"
                value={dateStr}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const d = new Date(`${v}T00:00:00`);
                  if (!Number.isNaN(d.getTime())) setSelectedDate(d);
                }}
                className="h-9 w-[150px] pl-8"
              />
            </div>
            <Select value={season} onValueChange={(v) => setSeason(v as StaffingSeason)}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEASONS.map((s) => (
                  <SelectItem key={s.key} value={s.key} disabled={!s.available}>
                    {s.label}
                    {!s.available ? ' (bald)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => setSelectedDate(new Date())}
            >
              Heute
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {loading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Lädt …</p>
        ) : !result.hasRequirements ? (
          <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              Für diesen Tag ist noch kein Personalbedarf definiert.
            </p>
            <Link
              to="/personalbedarf"
              className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Personalbedarf definieren
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : result.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Für deinen Bereich ist an diesem Tag kein Personalbedarf hinterlegt.
          </p>
        ) : (
          <div className="space-y-5">
            {/* KPI-Kacheln */}
            <StaffingKpiCards kpis={kpis} />

            {/* Tages-Summe */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Tages-Summe</span>
              <span className="ml-auto">
                Benötigt <span className="font-medium text-foreground tabular-nums">{result.totals.required}</span>
                {' · '}Geplant <span className="font-medium text-foreground tabular-nums">{result.totals.planned}</span>
                {' · '}<span className={cn('font-medium', result.totals.diff === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{formatStaffingDiff(result.totals.diff)}</span>
              </span>
            </div>

            {/* Hierarchie Abteilung → Bereich → Position */}
            {result.groups.map((group) => (
              <div key={group.department} className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">
                  {DEPARTMENT_LABEL[group.department]}
                </h3>
                {group.areas.map((areaGroup, ai) => (
                  <div key={areaGroup.area?.key ?? `area-${ai}`} className="space-y-2 pl-1">
                    {areaGroup.area && (
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {areaGroup.area.name}
                      </p>
                    )}
                    {areaGroup.positions.map((pc) => (
                      <div
                        key={pc.position.key}
                        className="rounded-lg border bg-card px-3 py-2"
                      >
                        <div className="flex items-center gap-2">
                          {pc.position.color && (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: pc.position.color }}
                              aria-hidden
                            />
                          )}
                          <span className="text-sm font-medium">{pc.position.name}</span>
                        </div>
                        <table className="mt-1 w-full">
                          <thead>
                            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              <th className="py-1 pr-3 text-left font-medium">Zeitraum</th>
                              <th className="py-1 px-3 text-center font-medium">Benötigt</th>
                              <th className="py-1 px-3 text-center font-medium">Geplant</th>
                              <th className="py-1 px-3 text-right font-medium">Differenz</th>
                              <th className="py-1 pl-3 text-right font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            <ShiftRows shifts={pc.shifts} />
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}

            {/* Orphan-Bedarfe (inaktive/unbekannte Positionen) */}
            {result.orphanPositions.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground">
                  Inaktive / unbekannte Positionen
                </h3>
                {result.orphanPositions.map((op) => (
                  <div key={op.positionKey} className="rounded-lg border border-dashed bg-muted/20 px-3 py-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      {op.positionName}{' '}
                      <span className="text-xs font-normal">(nicht aktiv)</span>
                    </span>
                    <table className="mt-1 w-full">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="py-1 pr-3 text-left font-medium">Zeitraum</th>
                          <th className="py-1 px-3 text-center font-medium">Benötigt</th>
                          <th className="py-1 px-3 text-center font-medium">Geplant</th>
                          <th className="py-1 px-3 text-right font-medium">Differenz</th>
                          <th className="py-1 pl-3 text-right font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        <ShiftRows shifts={op.shifts} />
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* Fußnote: Zählregel + Link */}
            <div className="flex flex-col gap-1.5 border-t pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                Gezählt werden aktive Mitarbeitende mit dieser Position als Hauptposition,
                deren Schicht den Zeitraum überschneidet.
              </span>
              <Link
                to="/personalbedarf"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                Personalbedarf bearbeiten
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
