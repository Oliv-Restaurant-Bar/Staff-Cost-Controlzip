import { format, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { useState } from 'react';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { Employee } from '@/types/personnel';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Clock, Users, TrendingUp, Pencil, RotateCcw, Check, X, AlertTriangle, Lightbulb, Palmtree, Stethoscope } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';
import {
  isFixedEmployee, isVariableEmployee, absenceKind, SKIP_CODES, netHoursFromSchedule,
} from '@/lib/absence-utils';

interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: Date | null;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  plannedRevenue?: number;
  isOverride?: boolean;
  onUpdatePlannedRevenue?: (dateStr: string, value: number | null) => void;
  laborCostThreshold?: number;
  actualHoursData?: Record<string, { hours: number; start?: string; end?: string }>;
}

// Calculate hours from a time slot
const calculateSlotHours = (slot: TimeSlot | null | undefined): number => {
  if (!slot?.start || !slot?.end) return 0;
  const [startH, startM] = slot.start.split(':').map(Number);
  const [endH, endM] = slot.end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Calculate total hours for a day (früh + spät) with break deduction
const calculateDayHours = (daySchedule: DaySchedule): number => {
  const frühHours = calculateSlotHours(daySchedule.früh);
  const spätHours = calculateSlotHours(daySchedule.spät);
  const totalGross = frühHours + spätHours;
  const breakDeduction = calculateBreakDeduction(totalGross);
  return Math.round((totalGross - breakDeduction) * 100) / 100;
};

export const DayDetailDialog = ({
  open,
  onOpenChange,
  date,
  employees,
  scheduleData,
  plannedRevenue,
  isOverride,
  onUpdatePlannedRevenue,
  laborCostThreshold = 40,
  actualHoursData,
}: DayDetailDialogProps) => {
  const { shiftMap } = useShiftConfig();
  const [editingRevenue, setEditingRevenue] = useState(false);
  const [revenueInput, setRevenueInput] = useState('');

  if (!date) return null;

  const dateStr = format(date, 'yyyy-MM-dd');
  const dayOfWeek = getDay(date);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const getEmployeeShiftInfo = (employeeId: string) => {
    const cellKey = `${employeeId}-${dateStr}`;
    const daySchedule = scheduleData[cellKey];

    if (!daySchedule) {
      return { hasShift: false, früh: null, spät: null, totalHours: 0 };
    }

    const getSlotDisplay = (slot: TimeSlot | null | undefined, absence: string | null | undefined) => {
      if (absence) {
        // Find the absence config
        const abbrev = absence;
        const shiftKey = Object.keys(shiftMap).find(k => shiftMap[k].abbrev === abbrev);
        if (shiftKey) {
          return {
            display: abbrev,
            color: shiftMap[shiftKey].color,
            hours: shiftMap[shiftKey].countsToTarget ? shiftMap[shiftKey].hours : 0
          };
        }
        return { display: abbrev, color: 'bg-muted', hours: 0 };
      }
      
      if (slot?.start && slot?.end) {
        return {
          display: `${slot.start}-${slot.end}`,
          color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300',
          hours: calculateSlotHours(slot)
        };
      }
      
      return null;
    };

    const frühInfo = getSlotDisplay(daySchedule.früh, daySchedule.frühAbsence);
    const spätInfo = getSlotDisplay(daySchedule.spät, daySchedule.spätAbsence);
    
    const hasShift = frühInfo || spätInfo;
    const totalHours = calculateDayHours(daySchedule);

    return {
      hasShift,
      früh: frühInfo,
      spät: spätInfo,
      totalHours
    };
  };

  // Group employees by department
  const serviceEmployees = employees.filter(e => e.department === 'service');
  const kücheEmployees = employees.filter(e => e.department === 'küche');

  // Calculate totals
  let totalHours = 0;
  let workingCount = 0;
  employees.forEach(emp => {
    const info = getEmployeeShiftInfo(emp.id);
    if (info.hasShift) {
      totalHours += info.totalHours;
      workingCount++;
    }
  });

  // Calculate planned cost (only employees with hourlyWage and work hours)
  // Also compute per-slot and per-dept breakdowns
  let totalPlannedCost = 0;
  let frühPlannedCost  = 0;
  let spätPlannedCost  = 0;
  const deptSlotCosts: Record<string, { früh: number; spät: number; frühH: number; spätH: number }> = {
    service: { früh: 0, spät: 0, frühH: 0, spätH: 0 },
    küche:   { früh: 0, spät: 0, frühH: 0, spätH: 0 },
  };

  employees.forEach(emp => {
    if (!emp.hourlyWage) return;
    const cellKey = `${emp.id}-${dateStr}`;
    const ds = scheduleData[cellKey];
    if (!ds) return;
    const frühH = calculateSlotHours(ds.früh);
    const spätH = calculateSlotHours(ds.spät);
    const gross = frühH + spätH;
    if (gross === 0) return;
    const breakDeduction = calculateBreakDeduction(gross);
    const net = Math.max(0, gross - breakDeduction);
    totalPlannedCost += net * emp.hourlyWage;

    // Split break deduction proportionally
    const frühNet = Math.max(0, frühH - breakDeduction * (frühH / gross));
    const spätNet = Math.max(0, spätH - breakDeduction * (spätH / gross));
    frühPlannedCost += frühNet * emp.hourlyWage;
    spätPlannedCost += spätNet * emp.hourlyWage;

    const dept = emp.department === 'küche' ? 'küche' : 'service';
    deptSlotCosts[dept].früh  += frühNet * emp.hourlyWage;
    deptSlotCosts[dept].spät  += spätNet * emp.hourlyWage;
    deptSlotCosts[dept].frühH += frühNet;
    deptSlotCosts[dept].spätH += spätNet;
  });

  const hasSlotData   = frühPlannedCost > 0 || spätPlannedCost > 0;
  const hasCostData = totalPlannedCost > 0;
  const costTarget = plannedRevenue && plannedRevenue > 0
    ? plannedRevenue * (laborCostThreshold / 100)
    : null;
  const excessCost = costTarget !== null ? totalPlannedCost - costTarget : null;
  const isOverCostTarget = excessCost !== null && excessCost > 0;

  // Identify the cost driver slot + dept (for smarter recommendations)
  const slotDriver: { slot: 'Früh' | 'Spät'; dept: string | null } | null = (() => {
    if (!isOverCostTarget || !hasSlotData) return null;
    const slot = frühPlannedCost > spätPlannedCost ? 'Früh' : 'Spät';
    // Which dept within that slot?
    const frühByDept = { service: deptSlotCosts.service.früh, küche: deptSlotCosts.küche.früh };
    const spätByDept = { service: deptSlotCosts.service.spät, küche: deptSlotCosts.küche.spät };
    const relevantByDept = slot === 'Früh' ? frühByDept : spätByDept;
    const deptEntry = Object.entries(relevantByDept).sort((a, b) => b[1] - a[1])[0];
    const dept = deptEntry && deptEntry[1] > 0 ? (deptEntry[0] === 'küche' ? 'Küche' : 'Service') : null;
    return { slot, dept };
  })();

  // Actual hours if available
  const totalActualHours = actualHoursData
    ? employees.reduce((sum, emp) => sum + (actualHoursData[`${emp.id}-${dateStr}`]?.hours ?? 0), 0)
    : null;
  const hasActualHours = totalActualHours !== null && totalActualHours > 0;

  // Recommendation text — now slot-aware
  const recommendation: { type: 'ok' | 'warning' | 'error'; text: string } | null = (() => {
    if (!costTarget || !hasCostData) return null;
    const excess = totalPlannedCost - costTarget;
    if (excess <= 0) return { type: 'ok', text: 'Tag ist innerhalb des Kostenziels. Gut geplant!' };

    // Build driver suffix
    const driverSuffix = slotDriver
      ? ` Kostentreiber: ${slotDriver.slot}dienst${slotDriver.dept ? ` ${slotDriver.dept}` : ''}.`
      : '';

    if (excess > 1000) return {
      type: 'error',
      text: `CHF ${excess.toFixed(0)} über Kostenziel. Mehrere Schichten kürzen oder einen Mitarbeitenden freistellen.${driverSuffix}`,
    };
    if (excess > 400) return {
      type: 'warning',
      text: `CHF ${excess.toFixed(0)} über Kostenziel.${driverSuffix ? driverSuffix : ' Spät- oder Zusatzschicht prüfen und ggf. kürzen.'}`,
    };
    return {
      type: 'warning',
      text: `CHF ${excess.toFixed(0)} über Kostenziel. Kleine Anpassung genügt.${driverSuffix}`,
    };
  })();

  const renderEmployeeList = (deptEmployees: Employee[], deptName: string, dotColor: string) => {
    const working = deptEmployees.filter(e => getEmployeeShiftInfo(e.id).hasShift);
    const notWorking = deptEmployees.filter(e => !getEmployeeShiftInfo(e.id).hasShift);

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className={cn("w-2.5 h-2.5 rounded-full", dotColor)} />
          <h4 className="font-semibold text-sm">{deptName}</h4>
          <Badge variant="secondary" className="text-xs">
            {working.length}/{deptEmployees.length}
          </Badge>
        </div>

        {working.length > 0 && (
          <div className="space-y-2 ml-4">
            {working.map(emp => {
              const info = getEmployeeShiftInfo(emp.id);
              return (
                <div key={emp.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">{emp.name}</span>
                  <div className="flex items-center gap-2">
                    {/* Früh slot */}
                    {info.früh && (
                      <span className={cn(
                        "px-2 py-0.5 rounded text-xs border",
                        info.früh.color
                      )}>
                        {info.früh.display}
                      </span>
                    )}
                    {/* Spät slot */}
                    {info.spät && (
                      <span className={cn(
                        "px-2 py-0.5 rounded text-xs border",
                        info.spät.color
                      )}>
                        {info.spät.display}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs w-12 text-right">
                      {info.totalHours.toFixed(1)}h
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {notWorking.length > 0 && (
          <div className="ml-4 text-xs text-muted-foreground">
            Frei: {notWorking.map(e => e.name).join(', ')}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className={cn(
              "text-lg",
              isWeekend && "text-primary"
            )}>
              {format(date, 'EEEE, d. MMMM yyyy', { locale: de })}
            </span>
            {isWeekend && (
              <Badge variant="outline" className="text-primary border-primary">
                Wochenende
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Summary */}
          <div className="flex gap-6 p-3 bg-muted/30 rounded-lg flex-wrap">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                <strong>{workingCount}</strong> Mitarbeiter
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                <strong>{totalHours.toFixed(1)}</strong> Stunden
              </span>
            </div>
            {plannedRevenue !== undefined && (
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  <strong>
                    {new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(plannedRevenue)}
                  </strong>
                  {' '}Zielumsatz
                  {isOverride && (
                    <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 rounded px-1">Event</span>
                  )}
                </span>
              </div>
            )}
          </div>

          {/* ── Abwesenheit & Ersatz ───────────────────────────────────────── */}
          {(() => {
            const absences = employees.filter(isFixedEmployee).flatMap(emp => {
              const ds = scheduleData[`${emp.id}-${dateStr}`];
              if (!ds) return [];
              const code = ds.frühAbsence || ds.spätAbsence;
              if (!code || SKIP_CODES.has(code)) return [];
              const kind = absenceKind(code);
              const plannedHrs = emp.weeklyHours ? Math.round(emp.weeklyHours / 5 * 10) / 10 : 8.4;

              const replacements = employees.filter(isVariableEmployee).filter(v =>
                v.department === emp.department
              ).flatMap(v => {
                const vDs = scheduleData[`${v.id}-${dateStr}`];
                const vActual = actualHoursData?.[`${v.id}-${dateStr}`];
                let hours = 0;
                if (vActual?.hours && vActual.hours > 0) hours = vActual.hours;
                else if (vDs && !vDs.frühAbsence && !vDs.spätAbsence) hours = netHoursFromSchedule(vDs);
                if (hours <= 0) return [];
                return [{ name: v.name, hours, cost: hours * (v.hourlyWage ?? 0) }];
              });

              const replacedHrs  = replacements.reduce((s, r) => s + r.hours, 0);
              const replacedCost = replacements.reduce((s, r) => s + r.cost, 0);
              return [{
                emp, code, kind, plannedHrs, replacements,
                replacedHrs, replacedCost,
                unreplacedHrs: Math.max(0, plannedHrs - replacedHrs),
              }];
            });

            if (absences.length === 0) return null;

            const totalAbsHrs   = absences.reduce((s, r) => s + r.plannedHrs, 0);
            const totalRepHrs   = absences.reduce((s, r) => s + r.replacedHrs, 0);
            const totalRepCost  = absences.reduce((s, r) => s + r.replacedCost, 0);
            const totalUnrep    = absences.reduce((s, r) => s + r.unreplacedHrs, 0);

            return (
              <div className="rounded-lg border bg-amber-50/60 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 p-3 space-y-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 uppercase tracking-wide">
                  <Palmtree className="h-3.5 w-3.5" />
                  Abwesenheit &amp; Ersatz
                </div>
                {absences.map(row => (
                  <div key={row.emp.id} className="space-y-0.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{row.emp.name}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={cn(
                          'text-xs px-1.5 py-0.5 rounded border font-medium',
                          row.kind === 'vacation'
                            ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
                            : 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300'
                        )}>
                          {row.kind === 'vacation' ? <Palmtree className="h-3 w-3 inline mr-0.5" /> : <Stethoscope className="h-3 w-3 inline mr-0.5" />}
                          {row.code}
                        </span>
                        <span className="text-xs text-muted-foreground">{row.plannedHrs.toFixed(1)} h</span>
                      </div>
                    </div>
                    {row.replacements.length > 0 ? (
                      <div className="text-xs text-muted-foreground ml-1">
                        Ersatz: {row.replacements.map(r => `${r.name} (${r.hours.toFixed(1)}h)`).join(', ')}
                        {row.replacedCost > 0 && (
                          <span className="ml-1 font-medium text-foreground">· CHF {row.replacedCost.toFixed(0)}</span>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground ml-1">Kein Ersatz erkannt</div>
                    )}
                    {row.unreplacedHrs > 0 && (
                      <div className="text-xs text-green-700 dark:text-green-400 ml-1">
                        Nicht ersetzt: {row.unreplacedHrs.toFixed(1)} h → geschätzte Einsparung
                      </div>
                    )}
                  </div>
                ))}
                {absences.length > 1 && (
                  <div className="border-t border-amber-200 dark:border-amber-700 pt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground">Abwesend: <strong>{totalAbsHrs.toFixed(1)} h</strong></span>
                    <span className="text-muted-foreground">Ersetzt: <strong>{totalRepHrs.toFixed(1)} h</strong></span>
                    {totalRepCost > 0 && <span className="text-muted-foreground">Ersatzkosten: <strong>CHF {totalRepCost.toFixed(0)}</strong></span>}
                    {totalUnrep > 0 && <span className="text-green-700 dark:text-green-400">Nicht ersetzt: <strong>{totalUnrep.toFixed(1)} h</strong></span>}
                  </div>
                )}
              </div>
            );
          })()}

          {/* KPI section: planned cost vs target — full width */}
          {hasCostData && (() => {
            const wageEmployees = employees.filter(e => e.hourlyWage && e.hourlyWage > 0);
            const avgWage = wageEmployees.length > 0
              ? wageEmployees.reduce((s, e) => s + (e.hourlyWage || 0), 0) / wageEmployees.length
              : 0;
            const overHours = isOverCostTarget && avgWage > 0 ? excessCost! / avgWage : null;

            // Per-dept slot info for secondary display
            const deptRows = [
              { key: 'service', label: 'Service', früh: deptSlotCosts.service.früh, spät: deptSlotCosts.service.spät },
              { key: 'küche',   label: 'Küche',   früh: deptSlotCosts.küche.früh,   spät: deptSlotCosts.küche.spät   },
            ].filter(r => r.früh > 0 || r.spät > 0);

            return (
              <div className={cn(
                "rounded-lg border bg-card p-3 space-y-1.5",
                isOverCostTarget && "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10"
              )}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Personalkosten
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Geplant</span>
                  <span className="font-semibold">CHF {totalPlannedCost.toFixed(0)}</span>
                </div>
                {/* Früh / Spät split */}
                {hasSlotData && (frühPlannedCost > 0 || spätPlannedCost > 0) && (
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border/50 bg-muted/20 p-2">
                    <div>
                      <div className="text-[10px] text-muted-foreground font-medium">☀ Frühdienst</div>
                      <div className={cn(
                        "text-xs font-semibold",
                        slotDriver?.slot === 'Früh' ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400"
                      )}>
                        CHF {frühPlannedCost.toFixed(0)}
                        {slotDriver?.slot === 'Früh' && <span className="ml-1 text-[9px] font-bold uppercase tracking-wide">▲ Treiber</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground font-medium">🌙 Spätdienst</div>
                      <div className={cn(
                        "text-xs font-semibold",
                        slotDriver?.slot === 'Spät' ? "text-red-600 dark:text-red-400" : "text-blue-700 dark:text-blue-400"
                      )}>
                        CHF {spätPlannedCost.toFixed(0)}
                        {slotDriver?.slot === 'Spät' && <span className="ml-1 text-[9px] font-bold uppercase tracking-wide">▲ Treiber</span>}
                      </div>
                    </div>
                    {/* Per-dept sub-rows */}
                    {deptRows.map(dr => (
                      <div key={dr.key} className="col-span-2 flex items-center justify-between text-[10px] text-muted-foreground border-t border-border/30 pt-1 mt-0.5">
                        <span className={cn("font-medium", dr.key === 'service' ? "text-blue-600 dark:text-blue-400" : "text-orange-600 dark:text-orange-400")}>
                          {dr.label}
                        </span>
                        <span className="text-amber-700 dark:text-amber-400">Früh CHF {dr.früh.toFixed(0)}</span>
                        <span className="text-blue-700 dark:text-blue-400">Spät CHF {dr.spät.toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Geplante Stunden</span>
                  <span className="font-semibold">{totalHours.toFixed(1)} h</span>
                </div>
                {costTarget !== null && (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Kostenziel ({laborCostThreshold}%)</span>
                      <span className="font-semibold">CHF {costTarget.toFixed(0)}</span>
                    </div>
                    <div className={cn(
                      "flex justify-between text-sm border-t pt-1.5",
                      isOverCostTarget ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
                    )}>
                      <span className="font-semibold">{isOverCostTarget ? 'Überschuss' : 'Spielraum'}</span>
                      <span className="font-bold">
                        {isOverCostTarget
                          ? `+CHF ${excessCost!.toFixed(0)}`
                          : `–CHF ${Math.abs(excessCost!).toFixed(0)}`}
                      </span>
                    </div>
                    {isOverCostTarget && overHours !== null && overHours > 0 && (
                      <div className="flex justify-between text-sm text-red-600 dark:text-red-400">
                        <span>Überplant (ca.)</span>
                        <span className="font-bold">+{overHours.toFixed(1)} h</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {/* Recommendation */}
          {recommendation && (
            <div className={cn(
              "flex items-start gap-2.5 rounded-lg border p-3 text-sm",
              recommendation.type === 'ok'
                ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300"
                : recommendation.type === 'error'
                  ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300"
                  : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"
            )}>
              {recommendation.type === 'ok'
                ? <TrendingUp className="h-4 w-4 shrink-0 mt-0.5" />
                : recommendation.type === 'error'
                  ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  : <Lightbulb className="h-4 w-4 shrink-0 mt-0.5" />}
              <span>{recommendation.text}</span>
            </div>
          )}

          {/* Umsatz-Override: Bearbeitungsbereich */}
          {onUpdatePlannedRevenue && (
            <div className="p-3 rounded-lg border bg-card space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <TrendingUp className="h-4 w-4" />
                  Zielumsatz für diesen Tag
                  {isOverride && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 rounded px-1">Event</span>
                  )}
                </div>
                {!editingRevenue && (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => {
                        setRevenueInput(String(Math.round(plannedRevenue ?? 0)));
                        setEditingRevenue(true);
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                      {isOverride ? 'Ändern' : 'Übersteuern'}
                    </Button>
                    {isOverride && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                        onClick={() => { onUpdatePlannedRevenue(dateStr, null); }}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Zurücksetzen
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {editingRevenue ? (
                <div className="flex gap-2 items-center">
                  <span className="text-sm text-muted-foreground shrink-0">CHF</span>
                  <Input
                    type="number"
                    min={0}
                    step={100}
                    className="h-8 text-sm"
                    value={revenueInput}
                    onChange={e => setRevenueInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const v = parseFloat(revenueInput);
                        if (!isNaN(v) && v >= 0) { onUpdatePlannedRevenue(dateStr, v); }
                        setEditingRevenue(false);
                      }
                      if (e.key === 'Escape') setEditingRevenue(false);
                    }}
                    autoFocus
                    placeholder="z.B. 15000"
                  />
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 px-2"
                    onClick={() => {
                      const v = parseFloat(revenueInput);
                      if (!isNaN(v) && v >= 0) { onUpdatePlannedRevenue(dateStr, v); }
                      setEditingRevenue(false);
                    }}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => setEditingRevenue(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isOverride
                    ? 'Manuell übersteuert – vom normalen Wochentag-Budget abweichend.'
                    : 'Automatisch aus Monatsbudget berechnet. Für Events manuell übersteuern.'}
                </p>
              )}
            </div>
          )}

          {/* Service */}
          {serviceEmployees.length > 0 && (
            renderEmployeeList(serviceEmployees, 'Service', 'bg-blue-500')
          )}

          {/* Küche */}
          {kücheEmployees.length > 0 && (
            renderEmployeeList(kücheEmployees, 'Küche', 'bg-orange-500')
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
