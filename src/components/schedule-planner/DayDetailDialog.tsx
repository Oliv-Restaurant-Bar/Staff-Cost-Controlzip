import { format, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { useState } from 'react';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { Employee } from '@/types/personnel';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Clock, Users, TrendingUp, Pencil, RotateCcw, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DaySchedule, TimeSlot } from './ScheduleGrid';
import { calculateBreakDeduction } from '@/hooks/useShiftConfig';

interface DayDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: Date | null;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  plannedRevenue?: number;
  isOverride?: boolean;
  onUpdatePlannedRevenue?: (dateStr: string, value: number | null) => void;
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
