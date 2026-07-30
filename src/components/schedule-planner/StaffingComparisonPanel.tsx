import { useMemo, useState, useCallback } from 'react';
import { format, getISODay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Link } from 'react-router-dom';
import { ClipboardList, ArrowRight, CalendarDays, ChevronDown, UserCheck } from 'lucide-react';

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
  staffingHeadline,
  type ShiftComparisonRow,
  type StaffingHeadline,
} from '@/lib/staffing-comparison-utils';
import { computeCdsCheck } from '@/lib/staffing-check-utils';
import { buildEffectiveRequirements, ugSurchargeApplies } from '@/lib/staffing-profiles-utils';
import { useStaffingProfiles } from '@/hooks/useStaffingProfiles';
import { useUgEventDays } from '@/hooks/useUgEventDays';
import { usePermissions } from '@/hooks/usePermissions';
import { Checkbox } from '@/components/ui/checkbox';
import {
  StaffingKpiCards,
  StaffingStatusBadge,
  StaffingDiffCell,
} from '@/components/schedule-planner/staffing-status-ui';
import { StaffingDemandContext } from '@/components/schedule-planner/StaffingDemandContext';

import { Card, CardContent } from '@/components/ui/card';
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
  /** Dynamische Profil-Liste (aus der Profil-Konfiguration); ohne = SEASONS. */
  profiles?: { key: string; label: string }[];
  /** CdS-Prioritätsliste (Mitarbeiter-IDs) für die Chef-de-Service-Warnung. */
  cdsPriority?: string[];
}

const DEPARTMENT_LABEL: Record<Department, string> = {
  service: 'Service',
  küche: 'Küche',
};

/**
 * Merkt den Auf-/Zu-Status lokal pro Browser. Standard ist geschlossen — der
 * Dienstplan bleibt die dominante Arbeitsfläche; der Personalbedarf ist nur
 * ergänzend. Ist noch nichts gespeichert, bleibt das Panel zu.
 */
const OPEN_STORAGE_KEY = 'staffing-comparison-open';

function readInitialOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* localStorage nicht verfügbar → Status wird nur pro Sitzung gehalten. */
  }
}

const HEADLINE_PILL: Record<StaffingHeadline['tone'], string> = {
  green:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  neutral: 'bg-muted text-muted-foreground border-border',
};

/** Kompakte Status-Pille für die eingeklappte Kopfzeile. */
function HeadlinePill({ headline }: { headline: StaffingHeadline }) {
  return (
    <span
      data-testid="staffing-panel-status"
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        HEADLINE_PILL[headline.tone],
      )}
    >
      {headline.label}
    </span>
  );
}

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
  profiles,
  cdsPriority,
}: StaffingComparisonPanelProps) {
  const { positions, loading: posLoading } = usePositions();
  const { requirements, loading: reqLoading } = useStaffingRequirements();
  const { config: profilesConfig } = useStaffingProfiles();
  const { eventDays, toggle: toggleEventDay } = useUgEventDays();
  const { isGuest } = usePermissions();

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

  // Effektiver Bedarf: Winter/UG = Standard-Zeilen + UG-Zuschlag (Fr/Sa bzw.
  // Tages-Flag «UG/Event offen», ganzjährig).
  const eventOpen = eventDays.has(dateStr);
  const effectiveRequirements = useMemo(
    () => buildEffectiveRequirements({ requirements, config: profilesConfig, season, weekday, eventOpen }),
    [requirements, profilesConfig, season, weekday, eventOpen],
  );
  const surchargeActive = ugSurchargeApplies({ config: profilesConfig, season, weekday, eventOpen });

  const result = useMemo(
    () =>
      computeStaffingComparison({
        positions,
        requirements: effectiveRequirements,
        plannedEmployees,
        season,
        weekday,
        departments,
      }),
    [positions, effectiveRequirements, plannedEmployees, season, weekday, departments],
  );

  const kpis = useMemo(() => summarizeStaffingKpis(result.rows), [result.rows]);
  const headline = useMemo(() => staffingHeadline(result), [result]);

  // Chef-de-Service-Regel (nur wenn eine Prioritätsliste konfiguriert ist).
  const cdsCheck = useMemo(
    () => computeCdsCheck(plannedEmployees.map((p) => p.id), cdsPriority ?? []),
    [plannedEmployees, cdsPriority],
  );
  const employeeName = useCallback(
    (id: string) => employees.find((e) => e.id === id)?.name ?? id,
    [employees],
  );

  const loading = posLoading || reqLoading;

  const [open, setOpen] = useState<boolean>(readInitialOpen);
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      persistOpen(next);
      return next;
    });
  }, []);

  return (
    <Card className="mt-6" data-testid="staffing-comparison-panel">
      {/*
       * Kompakte, immer sichtbare Kopfzeile. Standard = geschlossen, damit der
       * Dienstplan die dominante Arbeitsfläche bleibt. Zeigt nur Titel, Datum,
       * Kurzstatus + Chevron (keine feste/min. Höhe, kein Overlay über dem Grid).
       */}
      <button
        type="button"
        data-testid="staffing-panel-toggle"
        aria-expanded={open}
        aria-controls="staffing-panel-content"
        onClick={toggleOpen}
        className="flex w-full items-center gap-2 rounded-t-lg px-4 py-2.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ClipboardList className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-base font-semibold">Personalbedarf-Abgleich</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {format(selectedDate, 'dd.MM.yyyy', { locale: de })}
        </span>
        {!loading && <HeadlinePill headline={headline} />}
        <ChevronDown
          className={cn(
            'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <CardContent id="staffing-panel-content" className="pt-0">
          {/* Steuerung (Datum / Saison / Heute) — nur im geöffneten Zustand. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              SOLL-Besetzung vs. eingeplante Mitarbeitende ·{' '}
              {weekdayLabel(weekday)}, {format(selectedDate, 'dd.MM.yyyy', { locale: de })}
            </p>
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
                {profiles && profiles.length > 0
                  ? profiles.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))
                  : SEASONS.map((s) => (
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
            {/* Tages-Flag «UG/Event offen» — UG-Zuschlag ganzjährig aktivieren. */}
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <Checkbox
                checked={eventOpen}
                disabled={isGuest}
                onCheckedChange={() => toggleEventDay(dateStr)}
                data-testid="ug-event-toggle-panel"
              />
              UG/Event offen
            </label>
            {surchargeActive && (
              <span className="inline-flex items-center rounded-full border border-violet-400 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-400 whitespace-nowrap">
                UG-Zuschlag aktiv{eventOpen ? ' (Event)' : ' (Winter Fr/Sa)'}
              </span>
            )}
          </div>

          {/* Chef-de-Service-Regel (Warnung bzw. aktiver CdS) */}
          {(cdsPriority?.length ?? 0) > 0 && (
            <div
              data-testid="staffing-cds-status"
              className={cn(
                'mb-3 rounded-md border px-3 py-2 text-xs flex items-start gap-2',
                cdsCheck.ok
                  ? 'border-border bg-muted/30'
                  : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20',
              )}
            >
              <UserCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
              {cdsCheck.ok ? (
                <span>
                  Chef de Service: <strong>{employeeName(cdsCheck.activeCdsId!)}</strong>
                  {cdsCheck.gastgeberId && (
                    <> · Gastgeber/GF: <strong>{employeeName(cdsCheck.gastgeberId)}</strong></>
                  )}
                </span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">{cdsCheck.warning}</span>
              )}
            </div>
          )}

          {/* Nachfrage-Kontext (Reservationen) — nur geöffnet, admin-only. */}
          <StaffingDemandContext date={dateStr} className="mb-3" />
          {loading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Lädt …</p>
          ) : !result.hasRequirements ? (
            <div
              data-testid="staffing-empty"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2"
            >
              <p className="text-sm text-muted-foreground">
                Für diesen Tag ist noch kein Personalbedarf definiert.
              </p>
              <Link
                to="/personalbedarf"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Definieren
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          ) : result.rows.length === 0 ? (
            <p
              data-testid="staffing-empty-scope"
              className="text-sm text-muted-foreground py-2"
            >
              Für deinen Bereich ist an diesem Tag kein Personalbedarf hinterlegt.
            </p>
          ) : (
            <div className="space-y-5" data-testid="staffing-content">
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
      )}
    </Card>
  );
}
