import React from 'react';
import { format, isWeekend, isSunday } from 'date-fns';
import { Employee } from '@/types/personnel';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction, useShiftConfig } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

interface PlanVsIstGridProps {
  employees: Employee[];
  days: Date[];
  scheduleData: Record<string, DaySchedule>;
  actualHoursData: Record<string, { hours: number; start?: string; end?: string }>;
}

const calcSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  let h = eh - sh + (em - sm) / 60;
  if (h < 0) h += 24;
  return Math.round(h * 100) / 100;
};

// Color rule for a single cell
// diff = ist - plan (positive = worked more than planned)
// < 10 min abs → green
// 1 min – 60 min over → green
// > 60 min abs diff → red
// else → amber
const diffColorClass = (plan: number, ist: number, hasIst: boolean): string => {
  if (!hasIst) return '';
  if (plan === 0 && ist === 0) return '';
  const diff = ist - plan;
  const abs = Math.abs(diff);
  if (abs < 1 / 6) return 'bg-green-100 dark:bg-green-900/30';
  if (diff > 0 && diff <= 1) return 'bg-green-100 dark:bg-green-900/30';
  if (abs > 1) return 'bg-red-100 dark:bg-red-900/30';
  return 'bg-amber-100 dark:bg-amber-900/20';
};

const diffTextClass = (diff: number, hasIst: boolean): string => {
  if (!hasIst) return 'text-muted-foreground';
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

  const getPlanHours = (employeeId: string, dateStr: string): number => {
    const cellKey = `${employeeId}-${dateStr}`;
    const ds = scheduleData[cellKey];
    if (!ds) return 0;

    const gross = calcSlotHours(ds.früh) + calcSlotHours(ds.spät);
    const net = Math.max(0, gross - calculateBreakDeduction(gross));

    // Absence hours (only when no work hours and absence countsToTarget)
    if (gross === 0 && ds.frühAbsence) {
      const key = Object.keys(shiftMap).find(k => shiftMap[k]?.abbrev === ds.frühAbsence);
      if (key && shiftMap[key].countsToTarget) return shiftMap[key].hours;
    }
    return net;
  };

  const getIstHours = (employeeId: string, dateStr: string): number =>
    actualHoursData[`${employeeId}-${dateStr}`]?.hours ?? 0;

  const hasIstEntry = (employeeId: string, dateStr: string): boolean =>
    actualHoursData[`${employeeId}-${dateStr}`] !== undefined;

  const hasAnyActualHours = Object.keys(actualHoursData).length > 0;

  return (
    <div>
      {!hasAnyActualHours && (
        <div className="mb-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-400">
          Noch keine Ist-Stunden erfasst. Wechsle in die <strong>Ist</strong>-Ansicht um Stunden einzutragen.
        </div>
      )}

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
      </div>

      <div className="overflow-auto max-h-[calc(100vh-320px)]">
        <ScrollArea className="w-full">
          <div className="min-w-max">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-30">
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
                    let dayHasIst = false;
                    employees.forEach(emp => {
                      dayPlan += getPlanHours(emp.id, dateStr);
                      if (hasIstEntry(emp.id, dateStr)) {
                        dayHasIst = true;
                        dayIst += getIstHours(emp.id, dateStr);
                      }
                    });
                    const dayDiff = dayIst - dayPlan;

                    return (
                      <th
                        key={day.toISOString()}
                        className={cn(
                          "px-1 py-1 text-center text-[10px] font-medium border-b border-r border-border min-w-[90px]",
                          isWe && "bg-amber-100/50 dark:bg-amber-900/20",
                          isSu && "border-r-4 border-r-primary/30 bg-amber-200/40 dark:bg-amber-900/30"
                        )}
                      >
                        <div className="text-muted-foreground text-[9px]">{WEEKDAY_NAMES[day.getDay()]}</div>
                        <div className="font-semibold">{format(day, 'd.M.')}</div>
                        <div className="mt-0.5 space-y-0">
                          <div className="text-[8px] text-blue-600 dark:text-blue-400">P: {dayPlan.toFixed(1)}h</div>
                          {dayHasIst && (
                            <>
                              <div className="text-[8px] font-medium">I: {dayIst.toFixed(1)}h</div>
                              <div className={cn("text-[8px] font-bold", diffTextClass(dayDiff, true))}>
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
                  let empHasAnyIst = false;

                  return (
                    <tr key={employee.id} className="group hover:bg-muted/30">
                      <td className="sticky left-0 z-10 bg-card group-hover:bg-muted/30 px-2 py-1 border-b border-r border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                        <div className="font-medium text-xs truncate" title={employee.name}>{employee.name}</div>
                        <div className="text-[9px] text-muted-foreground">
                          {employee.department === 'service' ? 'Service' : 'Küche'}
                        </div>
                      </td>

                      {days.map((day) => {
                        const dateStr = format(day, 'yyyy-MM-dd');
                        const plan = getPlanHours(employee.id, dateStr);
                        const hasIst = hasIstEntry(employee.id, dateStr);
                        const ist = getIstHours(employee.id, dateStr);
                        const diff = ist - plan;
                        empPlanTotal += plan;
                        if (hasIst) { empHasAnyIst = true; empIstTotal += ist; }
                        const isWe = isWeekend(day);
                        const isSu = isSunday(day);
                        const bgColor = diffColorClass(plan, ist, hasIst);

                        return (
                          <td
                            key={dateStr}
                            className={cn(
                              "px-0.5 py-0.5 border-b border-r border-border/50 text-center min-w-[90px]",
                              isWe && !bgColor && "bg-amber-50/50 dark:bg-amber-900/10",
                              isSu && "border-r-4 border-r-primary/30",
                              bgColor
                            )}
                          >
                            {plan === 0 && !hasIst ? (
                              <span className="text-[9px] text-muted-foreground">–</span>
                            ) : (
                              <div className="space-y-0.5 leading-tight">
                                <div className="text-[9px] text-muted-foreground">
                                  P: {plan > 0 ? `${plan.toFixed(1)}h` : '–'}
                                </div>
                                <div className="text-[9px] font-medium">
                                  I: {hasIst ? `${ist.toFixed(1)}h` : <span className="text-muted-foreground">–</span>}
                                </div>
                                {hasIst && plan > 0 && (
                                  <div className={cn("text-[9px] font-bold", diffTextClass(diff, true))}>
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
                        {empHasAnyIst && (
                          <>
                            <div className="text-[9px] font-medium">I: {empIstTotal.toFixed(1)}h</div>
                            <div className={cn(
                              "text-[9px] font-bold",
                              diffTextClass(empIstTotal - empPlanTotal, true)
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
                    let dayHasIst = false;
                    employees.forEach(emp => {
                      totalPlan += getPlanHours(emp.id, dateStr);
                      if (hasIstEntry(emp.id, dateStr)) {
                        dayHasIst = true;
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
                          "px-0.5 py-1 border-b border-r text-center",
                          isWe && "bg-amber-100/30 dark:bg-amber-900/10",
                          isSu && "border-r-4 border-r-primary/30"
                        )}
                      >
                        <div className="text-[10px] font-semibold text-primary">P: {totalPlan.toFixed(1)}h</div>
                        {dayHasIst && (
                          <>
                            <div className="text-[10px] font-medium">I: {totalIst.toFixed(1)}h</div>
                            <div className={cn("text-[9px] font-bold", diffTextClass(totalDiff, true))}>
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
                          grandPlan += getPlanHours(emp.id, dateStr);
                          if (hasIstEntry(emp.id, dateStr)) {
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
                              <div className={cn("text-[9px] font-bold", diffTextClass(grandDiff, true))}>
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
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </div>
  );
};
