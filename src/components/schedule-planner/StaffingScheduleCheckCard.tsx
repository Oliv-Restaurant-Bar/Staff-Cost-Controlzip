/**
 * StaffingScheduleCheckCard — Ist-vs-Soll-Abgleich auf der Personalbedarf-Seite.
 *
 * Zeigt für ein wählbares Datum (Default: nächstes Vorkommen des auf der Seite
 * gewählten Wochentags), wie der GESPEICHERTE Dienstplan die hier definierte
 * SOLL-Besetzung erfüllt: je Abteilung Soll/Ist/Differenz (2-Farben-Warnung:
 * exakt = optimal/grün, jede Abweichung = rot) plus die einzelnen
 * Bedarfs-Schichten und KPI-Kacheln.
 *
 * NUR Anzeige: lädt Mitarbeitende + Dienstplan read-only und ändert nichts.
 * Verglichen wird immer mit dem ISO-Wochentag des GEWÄHLTEN Datums (nicht mit
 * dem oben ausgewählten Wochentag, falls abweichend — dann erscheint ein Hinweis).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format, getISODay, parseISO, isValid, addDays, startOfMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarCheck2, ArrowRight, AlertTriangle } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { loadEmployees, loadScheduleForMonth } from '@/lib/supabase-db';
import type { Employee } from '@/types/personnel';
import type { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';
import type { Position } from '@/types/positions';
import type { StaffingRequirement, StaffingSeason } from '@/types/staffing';
import { seasonLabel, weekdayLabel } from '@/lib/staffing-requirements-utils';
import { positionDisplayName, employeeCoverableKeys, resolvePositionKey } from '@/lib/position-utils';
import { computeDayCheck, type PlannedEmployeeDayEx } from '@/lib/staffing-check-utils';
import {
  buildEffectiveRequirements,
  defaultStaffingProfilesConfig,
  ugSurchargeApplies,
  type StaffingProfilesConfig,
} from '@/lib/staffing-profiles-utils';
import { useUgEventDays } from '@/hooks/useUgEventDays';
import { usePermissions } from '@/hooks/usePermissions';
import { Checkbox } from '@/components/ui/checkbox';
import { StaffingDayCheck } from '@/components/schedule-planner/StaffingDayCheck';
import {
  buildPlannedEmployees,
  computeStaffingComparison,
  computeDayStaffingSummary,
  summarizeStaffingKpis,
  formatStaffingDiff,
} from '@/lib/staffing-comparison-utils';
import {
  STATUS_PILL,
  STATUS_DOT,
  StaffingKpiCards,
  StaffingStatusBadge,
  StaffingDiffCell,
} from '@/components/schedule-planner/staffing-status-ui';
import { StaffingDemandContext } from '@/components/schedule-planner/StaffingDemandContext';

const DEPT_LABEL: Record<string, string> = { service: 'Service', 'küche': 'Küche' };

/** Nächstes Vorkommen des ISO-Wochentags (heute eingeschlossen). */
export function nextDateForIsoWeekday(weekday: number, from: Date = new Date()): Date {
  const todayIso = getISODay(from);
  const delta = ((weekday - todayIso) % 7 + 7) % 7;
  return addDays(from, delta);
}

interface StaffingScheduleCheckCardProps {
  positions: Position[];
  requirements: StaffingRequirement[];
  season: StaffingSeason;
  /** Auf der Seite gewählter ISO-Wochentag (1..7) — steuert das Default-Datum. */
  weekday: number;
  /** Profil-Konfiguration (CdS-Priorität etc.) für die 3-Dimensionen-Prüfung. */
  profilesConfig?: StaffingProfilesConfig | null;
}

export function StaffingScheduleCheckCard({
  positions,
  requirements,
  season,
  weekday,
  profilesConfig,
}: StaffingScheduleCheckCardProps) {
  const { tenantId } = useTenant();
  const { isGuest } = usePermissions();
  const { eventDays, toggle: toggleEventDay } = useUgEventDays();

  const [dateStr, setDateStr] = useState<string>(() =>
    format(nextDateForIsoWeekday(weekday), 'yyyy-MM-dd'),
  );
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [scheduleData, setScheduleData] = useState<Record<string, DaySchedule>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Wochentagswechsel auf der Seite → Datum auf nächstes Vorkommen setzen.
  useEffect(() => {
    setDateStr(format(nextDateForIsoWeekday(weekday), 'yyyy-MM-dd'));
  }, [weekday]);

  const selectedDate = useMemo(() => {
    const d = parseISO(dateStr);
    return isValid(d) ? d : null;
  }, [dateStr]);

  const monthKey = selectedDate ? format(startOfMonth(selectedDate), 'yyyy-MM') : null;

  // Mitarbeitende + Dienstplan-Monat read-only laden (Monat gecacht via monthKey).
  useEffect(() => {
    if (!monthKey || !selectedDate) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [emps, schedule] = await Promise.all([
          loadEmployees(tenantId),
          loadScheduleForMonth(selectedDate, tenantId),
        ]);
        if (cancelled) return;
        setEmployees(emps ?? []);
        setScheduleData(schedule ?? {});
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : 'Dienstplan konnte nicht geladen werden');
        setEmployees([]);
        setScheduleData({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // selectedDate ändert sich nur relevant, wenn der Monat wechselt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, tenantId]);

  const dateWeekday = selectedDate ? getISODay(selectedDate) : weekday;

  // Effektiver Bedarf: Winter/UG liest Standard-Zeilen; UG-Zuschlag additiv
  // (Winter Fr/Sa bzw. Tages-Flag «UG/Event offen», ganzjährig).
  const config = useMemo(
    () => profilesConfig ?? defaultStaffingProfilesConfig(tenantId),
    [profilesConfig, tenantId],
  );
  const eventOpen = eventDays.has(dateStr);
  const effectiveRequirements = useMemo(
    () => buildEffectiveRequirements({ requirements, config, season, weekday: dateWeekday, eventOpen }),
    [requirements, config, season, dateWeekday, eventOpen],
  );
  const surchargeActive = ugSurchargeApplies({ config, season, weekday: dateWeekday, eventOpen });

  const plannedEmployees = useMemo(
    () => (selectedDate
      ? buildPlannedEmployees(employees, scheduleData, positions, format(selectedDate, 'yyyy-MM-dd'))
      : []),
    [employees, scheduleData, positions, selectedDate],
  );

  const comparison = useMemo(
    () => computeStaffingComparison({
      positions, requirements: effectiveRequirements, plannedEmployees, season, weekday: dateWeekday,
    }),
    [positions, effectiveRequirements, plannedEmployees, season, dateWeekday],
  );

  const summary = useMemo(
    () => computeDayStaffingSummary({
      positions, requirements: effectiveRequirements, plannedEmployees, season, weekday: dateWeekday,
    }),
    [positions, effectiveRequirements, plannedEmployees, season, dateWeekday],
  );

  const kpis = useMemo(() => summarizeStaffingKpis(comparison.rows), [comparison.rows]);

  // 3-Dimensionen-Tagesprüfung (Stunden / Anzahl / Abdeckung + CdS-Regel).
  const dayCheck = useMemo(() => {
    const byId = new Map(employees.map((e) => [e.id, e]));
    const plannedEx: PlannedEmployeeDayEx[] = plannedEmployees.map((p) => {
      const emp = byId.get(p.id);
      const trainedKeys = emp
        ? employeeCoverableKeys(emp)
            .map((k) => resolvePositionKey(positions, k) ?? k)
            .filter((k): k is string => !!k)
        : [];
      return { ...p, trainedKeys: [...new Set(trainedKeys)] };
    });
    return computeDayCheck({
      requirements: effectiveRequirements,
      plannedEmployees: plannedEx,
      season,
      weekday: dateWeekday,
      cdsPriority: config.cdsPriority,
      kitchenCold: config.kitchenCold,
    });
  }, [employees, plannedEmployees, positions, effectiveRequirements, season, dateWeekday, config]);

  const positionName = (key: string) => positionDisplayName(positions, key) || key;
  const employeeName = (id: string) => employees.find((e) => e.id === id)?.name ?? id;

  return (
    <Card>
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarCheck2 className="h-4 w-4 text-violet-600" />
          Dienstplan-Abgleich (Ist vs. Soll)
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <p className="text-xs text-muted-foreground">
          Vergleicht den gespeicherten Dienstplan eines Datums mit der
          SOLL-Besetzung ({seasonLabel(season)}). Nur Anzeige — es wird nichts verändert.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-0.5">
            <Label className="text-[10px] text-muted-foreground">Datum</Label>
            <Input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className="h-8 w-[10.5rem] text-sm"
            />
          </div>
          {selectedDate && (
            <span className="text-xs text-muted-foreground pb-1.5">
              {format(selectedDate, 'EEEE, dd.MM.yyyy', { locale: de })}
            </span>
          )}
          {/* Tages-Flag «UG/Event offen» — aktiviert den UG-Zuschlag ganzjährig. */}
          <label className="flex items-center gap-1.5 pb-1.5 text-xs cursor-pointer select-none">
            <Checkbox
              checked={eventOpen}
              disabled={isGuest}
              onCheckedChange={() => toggleEventDay(dateStr)}
              data-testid="ug-event-toggle"
            />
            UG/Event offen
          </label>
          {surchargeActive && (
            <Badge variant="outline" className="mb-1 border-violet-400 text-violet-700 dark:text-violet-400 text-[10px]">
              UG-Zuschlag aktiv{eventOpen ? ' (Event)' : ' (Winter Fr/Sa)'}
            </Badge>
          )}
          {dateWeekday !== weekday && (
            <Badge variant="outline" className="mb-1 border-amber-400 text-amber-700 dark:text-amber-400 text-[10px]">
              Datum ist ein {weekdayLabel(dateWeekday)} — verglichen wird der Bedarf für {weekdayLabel(dateWeekday)}
            </Badge>
          )}
        </div>

        {/* Nachfrage-Kontext (Reservationen) — admin-only, rendert sonst nichts. */}
        <StaffingDemandContext date={dateStr} />

        {loadError && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {loading && <p className="text-xs text-muted-foreground">Dienstplan lädt…</p>}

        {!loading && !loadError && !comparison.hasRequirements && (
          <p className="text-xs text-muted-foreground italic">
            Für {weekdayLabel(dateWeekday)} ({seasonLabel(season)}) ist kein Personalbedarf definiert.
          </p>
        )}

        {!loading && !loadError && comparison.hasRequirements && (
          <>
            {/* KPI-Kacheln */}
            <StaffingKpiCards kpis={kpis} />

            {/* Abteilungs-Zusammenfassung */}
            <div className="flex flex-wrap gap-2">
              {summary.departments.map((d) => (
                <span
                  key={d.department}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums',
                    STATUS_PILL[d.status],
                  )}
                >
                  <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[d.status])} aria-hidden />
                  {DEPT_LABEL[d.department] ?? d.department}: Soll {d.required} / Ist {d.planned} / {formatStaffingDiff(d.diff)}
                </span>
              ))}
            </div>

            {/* Schicht-Detail */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-1 pr-3 font-medium">Position</th>
                    <th className="py-1 px-3 font-medium">Zeit</th>
                    <th className="py-1 px-3 font-medium text-center">Soll</th>
                    <th className="py-1 px-3 font-medium text-center">Ist</th>
                    <th className="py-1 px-3 font-medium text-right">Differenz</th>
                    <th className="py-1 pl-3 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.map((r, i) => (
                    <tr key={r.requirementId ?? i} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-3">{positionName(r.positionKey)}</td>
                      <td className="py-1.5 px-3 tabular-nums whitespace-nowrap">{r.shiftStart}–{r.shiftEnd}</td>
                      <td className="py-1.5 px-3 text-center tabular-nums">{r.required}</td>
                      <td className="py-1.5 px-3 text-center tabular-nums">{r.planned}</td>
                      <td className="py-1.5 px-3 text-right">
                        <StaffingDiffCell data={{ required: r.required, planned: r.planned, diff: r.diff }} />
                      </td>
                      <td className="py-1.5 pl-3 text-right">
                        <StaffingStatusBadge status={r.status} diff={r.diff} size="xs" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Tagesprüfung (3 Dimensionen mit Ampel + CdS-Regel) */}
            <div className="rounded-md border p-3">
              <StaffingDayCheck
                check={dayCheck}
                positionName={positionName}
                employeeName={employeeName}
              />
            </div>

            <Link
              to="/dienstplan"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Zum Dienstplan
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
