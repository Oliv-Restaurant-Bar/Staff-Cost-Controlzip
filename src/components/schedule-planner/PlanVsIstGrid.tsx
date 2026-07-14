import React from 'react';
import { format, isWeekend, isSunday } from 'date-fns';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { resolveBreakHours, useShiftConfig } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// Alle Abwesenheitscodes, die in Plan oder Ist neutral behandelt werden
// d.h. kein Soll-/Ist-Stundenvergleich, delta = 0
// FE=Ferien, FT=Feiertag, K=Krank, F=Frei
const ABSENCE_CODES: ReadonlySet<string> = new Set(['FE', 'FT', 'K', 'F']);

interface IstEntry {
  hours: number;
  start?: string;
  end?: string;
  absenceType?: string;
}

interface PlanVsIstGridProps {
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, IstEntry>;
}

const calcSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

// Ob ein Plan-Eintrag einen Abwesenheitscode trägt (FE / K / F / …)
const isPlanAbsenceDay = (ds: DaySchedule | undefined): boolean => {
  if (!ds) return false;
  return (
    ABSENCE_CODES.has(ds.frühAbsence ?? '') ||
    ABSENCE_CODES.has(ds.spätAbsence ?? '')
  );
};

// Ob ein Ist-Eintrag eine Abwesenheit markiert (kein Arbeitstag)
const isIstAbsenceDay = (entry: IstEntry | undefined): boolean => {
  if (!entry) return false;
  return ABSENCE_CODES.has(entry.absenceType ?? '');
};

// Color rule for a single cell
// diff = ist - plan (positive = worked more than planned)
// < 10 min abs → green
// 1 min – 60 min over → green
// > 60 min abs diff → red
// else → amber
// absence days → always neutral (no color)
const diffColorClass = (
  plan: number, ist: number, hasIst: boolean, isAbsence: boolean,
): string => {
  if (isAbsence) return '';
  if (!hasIst) return '';
  if (plan === 0 && ist === 0) return '';
  const diff = ist - plan;
  const abs = Math.abs(diff);
  if (abs < 1 / 6) return 'bg-green-100 dark:bg-green-900/30';
  if (diff > 0 && diff <= 1) return 'bg-green-100 dark:bg-green-900/30';
  if (abs > 1) return 'bg-red-100 dark:bg-red-900/30';
  return 'bg-amber-100 dark:bg-amber-900/20';
};

const diffTextClass = (diff: number, hasIst: boolean, isAbsence: boolean): string => {
  if (isAbsence || !hasIst) return 'text-muted-foreground';
  const abs = Math.abs(diff);
  if (abs < 1 / 6) return 'text-green-700 dark:text-green-400';
  if (diff > 0 && diff <= 1) return 'text-green-700 dark:text-green-400';
  if (abs > 1) return 'text-red-700 dark:text-red-400';
  return 'text-amber-700 dark:text-amber-400';
};

export const PlanVsIstGrid = ({
  employees,
  days,
  scheduleData,
  actualHoursData,
}: PlanVsIstGridProps) => {
  const { shiftMap } = useShiftConfig();

  /**
   * Plan-Stunden für Vergleich.
   * Regel: Wenn der Plan-Eintrag einen Abwesenheitscode hat (FE / K / F),
   * gilt der Tag als neutral → 0 Soll-Stunden für den Vergleich.
   * Nur echte Arbeitstage (Schichten ohne Abwesenheitscode) liefern Stunden.
   */
  const getPlanHours = (employeeId: string, dateStr: string): number => {
    const cellKey = `${employeeId}-${dateStr}`;
    const ds = scheduleData[cellKey];
    if (!ds) return 0;

    // ── Abwesenheit im Plan → neutral (kein Soll-Stundenvergleich) ──
    if (isPlanAbsenceDay(ds)) {
      console.log(
        `[VERGLEICH] employee: ${employeeId} | date: ${dateStr}` +
        ` | plan type: absence (${ds.frühAbsence ?? ds.spätAbsence})` +
        ` | plan hours used for compare: 0`,
      );
      return 0;
    }

    const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
    const net = Math.max(0, gross - resolveBreakHours(gross, ds.breakMinutes));

    // Abwesenheitscodes die zu Sollstunden zählen (z.B. Krank mit Lohnfortzahlung)
    if (gross === 0 && ds.frühAbsence) {
      const key = Object.keys(shiftMap).find(
        k => shiftMap[k]?.abbrev === ds.frühAbsence,
      );
      if (key && shiftMap[key].countsToTarget) {
        const h = shiftMap[key].hours;
        console.log(
          `[VERGLEICH] employee: ${employeeId} | date: ${dateStr}` +
          ` | plan type: work (countsToTarget shift: ${ds.frühAbsence})` +
          ` | plan hours used for compare: ${h}`,
        );
        return h;
      }
    }

    if (net > 0) {
      console.log(
        `[VERGLEICH] employee: ${employeeId} | date: ${dateStr}` +
        ` | plan type: work | plan hours used for compare: ${net.toFixed(2)}`,
      );
    }
    return net;
  };

  /**
   * Ist-Stunden für Vergleich.
   * Wenn der Ist-Eintrag ein Abwesenheitscode trägt (FE/K/F), werden 0 zurückgegeben.
   * Die Abwesenheit macht den Tag neutral — er verschlechtert nicht den Saldo.
   */
  const getIstHours = (employeeId: string, dateStr: string): number => {
    const entry = actualHoursData[`${employeeId}-${dateStr}`];
    if (!entry) return 0;
    if (isIstAbsenceDay(entry)) return 0;
    return entry.hours ?? 0;
  };

  /**
   * Gibt true zurück, wenn ein echter Ist-Arbeitseintrag vorliegt
   * (kein reiner Abwesenheits-Platzhalter).
   * Abwesenheitseinträge (hours=0, absenceType=FE/K/F) gelten nicht als
   * «Ist erfasst» für den Stundenvergleich.
   */
  const hasRealIstEntry = (employeeId: string, dateStr: string): boolean => {
    const entry = actualHoursData[`${employeeId}-${dateStr}`];
    if (!entry) return false;
    if (isIstAbsenceDay(entry)) return false;
    return true;
  };

  const hasAnyActualHours = Object.values(actualHoursData).some(
    e => !isIstAbsenceDay(e) && e.hours > 0,
  );

  return (
    <div>
      {!hasAnyActualHours && (
        <div className="mb-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-400">
          Noch keine Ist-Stunden erfasst. Wechsle in die <strong>Ist</strong>-Ansicht um Stunden einzutragen.
        </div>
      )}

      {/* Legende */}
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-100 dark:bg-green-900/40 border border-green-300 dark:border-green-700 inline-block" />
          <span>Abweichung &lt; 10 Min. oder bis +1h über Plan</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-red-100 dark:bg-red-900/40 border border-red-300 dark:border-red-700 inline-block" />
          <span>Abweichung &gt; 1 Stunde</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 inline-block" />
          <span>Leichte Abweichung</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 inline-block" />
          <span>Abwesenheit (FE / FT / K / F) — neutral</span>
        </div>
      </div>

      <div className="overflow-auto max-h-[calc(100vh-320px)]">
        <div className="min-w-max">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-30 bg-card">
              <tr className="bg-card">
                <th className="sticky left-0 z-20 bg-card px-2 py-1.5 text-left text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] w-[140px] min-w-[140px]">
                  Mitarbeiter
                </th>
                {days.map((day) => {
                  const isWe = isWeekend(day);
                  const isSu = isSunday(day);
                  const dateStr = format(day, 'yyyy-MM-dd');
                  let dayPlan = 0;
                  let dayIst = 0;
                  let dayHasRealIst = false;
                  employees.forEach(emp => {
                    dayPlan += getPlanHours(emp.id, dateStr);
                    if (hasRealIstEntry(emp.id, dateStr)) {
                      dayHasRealIst = true;
                      dayIst += getIstHours(emp.id, dateStr);
                    }
                  });
                  const dayDiff = dayIst - dayPlan;

                  return (
                    <th
                      key={day.toISOString()}
                      className={cn(
                        'px-1 py-1 text-center text-[10px] font-medium border-b border-r border-border min-w-[90px]',
                        isWe && 'bg-amber-100/50 dark:bg-amber-900/20',
                        isSu && 'border-r-4 border-r-primary/30 bg-amber-200/40 dark:bg-amber-900/30',
                      )}
                    >
                      <div className="text-muted-foreground text-[9px]">{WEEKDAY_NAMES[day.getDay()]}</div>
                      <div className="font-semibold">{format(day, 'd.M.')}</div>
                      <div className="mt-0.5 space-y-0">
                        <div className="text-[8px] text-blue-600 dark:text-blue-400">P: {dayPlan.toFixed(1)}h</div>
                        {dayHasRealIst && (
                          <>
                            <div className="text-[8px] font-medium">I: {dayIst.toFixed(1)}h</div>
                            <div className={cn('text-[8px] font-bold', diffTextClass(dayDiff, true, false))}>
                              {dayDiff >= 0 ? `+${dayDiff.toFixed(1)}` : dayDiff.toFixed(1)}
                            </div>
                          </>
                        )}
                      </div>
                    </th>
                  );
                })}
                <th className="sticky right-0 z-20 bg-card px-2 py-1 text-center text-xs font-semibold border-b border-l-2 border-border shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.1)] min-w-[80px]">
                  Gesamt
                </th>
              </tr>
            </thead>
            <tbody>
              {employees.map(employee => {
                let empPlanTotal = 0;
                let empIstTotal = 0;
                let empHasAnyRealIst = false;

                return (
                  <tr key={employee.id} className="group hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-card group-hover:bg-muted/30 px-2 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                      <div className="font-medium text-xs truncate" title={getEmployeeDisplayName(employee)}>{getEmployeeDisplayName(employee)}</div>
                      <div className="text-[9px] text-muted-foreground">
                        {employee.department === 'service' ? 'Service' : 'Küche'}
                      </div>
                    </td>

                    {days.map((day) => {
                      const dateStr = format(day, 'yyyy-MM-dd');
                      const cellKey = `${employee.id}-${dateStr}`;
                      const ds = scheduleData[cellKey];
                      const planIsAbsence = isPlanAbsenceDay(ds);
                      const istEntry = actualHoursData[cellKey];
                      const istIsAbsence = isIstAbsenceDay(istEntry);

                      // Neutral day: Plan hat Abwesenheitscode
                      const isNeutralDay = planIsAbsence;

                      const plan = getPlanHours(employee.id, dateStr);
                      const hasRealIst = hasRealIstEntry(employee.id, dateStr);
                      const ist = getIstHours(employee.id, dateStr);

                      // Plan-Gesamt und Ist-Gesamt nur für echte Arbeitstage
                      if (!isNeutralDay) {
                        empPlanTotal += plan;
                        if (hasRealIst) {
                          empHasAnyRealIst = true;
                          empIstTotal += ist;
                        }
                      }

                      // Delta-Logging
                      if (hasRealIst || planIsAbsence || istIsAbsence) {
                        const diff = isNeutralDay ? 0 : ist - plan;
                        console.log(
                          `[VERGLEICH] employee: ${getEmployeeDisplayName(employee)}` +
                          ` | date: ${dateStr}` +
                          ` | plan type: ${planIsAbsence ? `absence (${ds?.frühAbsence ?? ds?.spätAbsence})` : 'work'}` +
                          ` | plan hours used for compare: ${isNeutralDay ? 0 : plan.toFixed(2)}` +
                          ` | ist hours used for compare: ${isNeutralDay ? 0 : ist.toFixed(2)}` +
                          ` | delta: ${diff.toFixed(2)}`,
                        );
                      }

                      const diff = isNeutralDay ? 0 : ist - plan;
                      const isWe = isWeekend(day);
                      const isSu = isSunday(day);
                      const bgColor = isNeutralDay
                        ? 'bg-blue-50/60 dark:bg-blue-900/10'
                        : diffColorClass(plan, ist, hasRealIst, false);

                      const absenceLabel = planIsAbsence
                        ? (ds?.frühAbsence ?? ds?.spätAbsence ?? 'Abw.')
                        : istIsAbsence
                          ? (istEntry?.absenceType ?? 'Abw.')
                          : null;

                      return (
                        <td
                          key={dateStr}
                          className={cn(
                            'px-0.5 py-0.5 border-b border-r border-border/50 text-center min-w-[90px]',
                            isWe && !bgColor && 'bg-amber-50/50 dark:bg-amber-900/10',
                            isSu && 'border-r-4 border-r-primary/30',
                            bgColor,
                          )}
                        >
                          {isNeutralDay ? (
                            // Abwesenheits-Tag im Plan → neutral anzeigen
                            <div className="space-y-0.5 leading-tight">
                              <div className="text-[9px] font-semibold text-blue-500 dark:text-blue-400">
                                {absenceLabel}
                              </div>
                              <div className="text-[8px] text-muted-foreground">neutral</div>
                            </div>
                          ) : plan === 0 && !hasRealIst ? (
                            <span className="text-[9px] text-muted-foreground">–</span>
                          ) : (
                            <div className="space-y-0.5 leading-tight">
                              <div className="text-[9px] text-muted-foreground">
                                P: {plan > 0 ? `${plan.toFixed(1)}h` : '–'}
                              </div>
                              <div className="text-[9px] font-medium">
                                I: {hasRealIst
                                  ? `${ist.toFixed(1)}h`
                                  : istIsAbsence
                                    ? <span className="text-blue-400 text-[8px]">{istEntry?.absenceType}</span>
                                    : <span className="text-muted-foreground">–</span>
                                }
                              </div>
                              {hasRealIst && plan > 0 && (
                                <div className={cn('text-[9px] font-bold', diffTextClass(diff, true, false))}>
                                  {diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1)}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}

                    <td className="sticky right-0 z-10 bg-card group-hover:bg-muted/30 px-1.5 py-1 border-b border-l-2 border-border shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.1)] text-center min-w-[80px]">
                      <div className="text-[9px] text-muted-foreground">P: {empPlanTotal.toFixed(1)}h</div>
                      {empHasAnyRealIst && (
                        <>
                          <div className="text-[9px] font-medium">I: {empIstTotal.toFixed(1)}h</div>
                          <div className={cn(
                            'text-[9px] font-bold',
                            diffTextClass(empIstTotal - empPlanTotal, true, false),
                          )}>
                            {(empIstTotal - empPlanTotal) >= 0
                              ? `+${(empIstTotal - empPlanTotal).toFixed(1)}`
                              : (empIstTotal - empPlanTotal).toFixed(1)}
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 border-t-2 border-border">
                <td className="sticky left-0 z-10 bg-muted/80 px-2 py-1.5 border-b border-r font-semibold text-xs border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  Gesamt
                </td>
                {days.map((day) => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  let totalPlan = 0;
                  let totalIst = 0;
                  let dayHasRealIst = false;
                  employees.forEach(emp => {
                    const ds = scheduleData[`${emp.id}-${dateStr}`];
                    if (isPlanAbsenceDay(ds)) return; // Abwesenheitstage neutral
                    totalPlan += getPlanHours(emp.id, dateStr);
                    if (hasRealIstEntry(emp.id, dateStr)) {
                      dayHasRealIst = true;
                      totalIst += getIstHours(emp.id, dateStr);
                    }
                  });
                  const totalDiff = totalIst - totalPlan;
                  const isWe = isWeekend(day);
                  const isSu = isSunday(day);

                  return (
                    <td
                      key={`footer-${dateStr}`}
                      className={cn(
                        'px-0.5 py-1 border-b border-r text-center',
                        isWe && 'bg-amber-100/30 dark:bg-amber-900/10',
                        isSu && 'border-r-4 border-r-primary/30',
                      )}
                    >
                      <div className="text-[10px] font-semibold text-primary">P: {totalPlan.toFixed(1)}h</div>
                      {dayHasRealIst && (
                        <>
                          <div className="text-[10px] font-medium">I: {totalIst.toFixed(1)}h</div>
                          <div className={cn('text-[9px] font-bold', diffTextClass(totalDiff, true, false))}>
                            {totalDiff >= 0 ? `+${totalDiff.toFixed(1)}` : totalDiff.toFixed(1)}
                          </div>
                        </>
                      )}
                    </td>
                  );
                })}
                <td className="sticky right-0 z-10 bg-muted/80 px-1.5 py-1.5 border-b border-l-2 border-border text-center shadow-[-2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                  {(() => {
                    let grandPlan = 0;
                    let grandIst = 0;
                    let hasAny = false;
                    employees.forEach(emp => {
                      days.forEach(day => {
                        const dateStr = format(day, 'yyyy-MM-dd');
                        const ds = scheduleData[`${emp.id}-${dateStr}`];
                        if (isPlanAbsenceDay(ds)) return; // Abwesenheit neutral
                        grandPlan += getPlanHours(emp.id, dateStr);
                        if (hasRealIstEntry(emp.id, dateStr)) {
                          hasAny = true;
                          grandIst += getIstHours(emp.id, dateStr);
                        }
                      });
                    });
                    const grandDiff = grandIst - grandPlan;
                    return (
                      <div>
                        <div className="text-[9px] text-muted-foreground">P: {grandPlan.toFixed(1)}h</div>
                        {hasAny && (
                          <>
                            <div className="text-[9px] font-medium">I: {grandIst.toFixed(1)}h</div>
                            <div className={cn('text-[9px] font-bold', diffTextClass(grandDiff, true, false))}>
                              {grandDiff >= 0 ? `+${grandDiff.toFixed(1)}` : grandDiff.toFixed(1)}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
};
