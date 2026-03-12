// Actual Hours Grid Component - For displaying and editing Ist-Stunden in schedule view
import React, { useState } from 'react';
import { format, isWeekend, isSunday, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { cn } from '@/lib/utils';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Check, X, Clock } from 'lucide-react';

export interface ActualHoursEntry {
  hours: number;
  start?: string;
  end?: string;
}

interface ActualHoursGridProps {
  employees: Employee[];
  days: Date[];
  actualHoursData: Record<string, ActualHoursEntry>; // key: employeeId-date
  onHoursChange: (employeeId: string, date: string, entry: ActualHoursEntry | null) => void;
  getEmployeeActualHours: (employeeId: string) => number;
  getTargetHours: (employee: Employee) => number;
  showCosts?: boolean;
}

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAY_MAP: Record<string, number> = {
  'sonntag': 0,
  'montag': 1,
  'dienstag': 2,
  'mittwoch': 3,
  'donnerstag': 4,
  'freitag': 5,
  'samstag': 6,
};

// Check if a day is configured as a day off
const isDayOff = (employee: Employee, day: Date): boolean => {
  if (!employee.daysOff || employee.daysOff.length === 0) return false;
  const dayOfWeek = getDay(day);
  return employee.daysOff.some(dayName => WEEKDAY_MAP[dayName] === dayOfWeek);
};

// Calculate hours from start/end times
const calculateHoursFromTimes = (start: string, end: string): number => {
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Cell editing component
const ActualHoursCell = ({
  employee,
  day,
  entry,
  onSave,
  showCosts = false,
}: {
  employee: Employee;
  day: Date;
  entry: ActualHoursEntry | undefined;
  onSave: (entry: ActualHoursEntry | null) => void;
  showCosts?: boolean;
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [inputMode, setInputMode] = useState<'hours' | 'times' | 'chf'>('hours');
  const [hoursInput, setHoursInput] = useState('');
  const [chfInput, setChfInput] = useState('');
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  const isWeekendDay = isWeekend(day);
  const isSundayDay = isSunday(day);
  const isDayOffDay = isDayOff(employee, day);

  // Calculate hours from CHF amount
  const hoursFromChf = chfInput ? (parseFloat(chfInput.replace(',', '.')) / employee.hourlyWage) : 0;

  const handleCellClick = () => {
    if (entry) {
      setHoursInput(entry.hours.toString());
      setChfInput((entry.hours * employee.hourlyWage).toFixed(0));
      setStartInput(entry.start || '');
      setEndInput(entry.end || '');
      setInputMode(entry.start && entry.end ? 'times' : 'hours');
    } else {
      setHoursInput('');
      setChfInput('');
      setStartInput('');
      setEndInput('');
      setInputMode('hours');
    }
    setIsEditing(true);
  };

  const handleSave = () => {
    if (inputMode === 'hours') {
      const hours = parseFloat(hoursInput.replace(',', '.'));
      if (!isNaN(hours) && hours > 0) {
        onSave({ hours });
      } else if (hoursInput === '' || hours === 0) {
        onSave(null);
      }
    } else if (inputMode === 'chf') {
      const chf = parseFloat(chfInput.replace(',', '.'));
      if (!isNaN(chf) && chf > 0) {
        const hours = chf / employee.hourlyWage;
        onSave({ hours: Math.round(hours * 100) / 100 });
      } else if (chfInput === '' || chf === 0) {
        onSave(null);
      }
    } else {
      if (startInput && endInput) {
        const hours = calculateHoursFromTimes(startInput, endInput);
        onSave({ hours, start: startInput, end: endInput });
      }
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  const hours = entry?.hours || 0;
  const cost = hours * employee.hourlyWage;

  return (
    <>
      <td
        className={cn(
          "px-1 py-1 text-center text-xs border-r border-b cursor-pointer transition-colors hover:bg-primary/10",
          "min-w-[60px]",
          isWeekendDay && "bg-amber-50 dark:bg-amber-900/20",
          isSundayDay && "bg-amber-100/50 dark:bg-amber-900/30 border-r-2 border-r-primary/30",
          isDayOffDay && "bg-muted/50",
          hours > 0 && "bg-green-50 dark:bg-green-900/20"
        )}
        onClick={handleCellClick}
        title="Klicken zum Bearbeiten"
      >
        {hours > 0 ? (
          <div className="flex flex-col items-center gap-0.5">
            <span className="font-medium text-green-700 dark:text-green-400">
              {hours.toFixed(1)}h
            </span>
            {entry?.start && entry?.end && (
              <span className="text-[9px] text-muted-foreground">
                {entry.start}-{entry.end}
              </span>
            )}
            {showCosts && (
              <span className="text-[9px] text-muted-foreground">
                {cost.toFixed(0)} CHF
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>

      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Ist-Stunden: {employee.name}
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground mb-4">
            {format(day, 'EEEE, d. MMMM yyyy', { locale: de })}
          </div>

          {/* Mode Toggle */}
          <div className="flex gap-2 mb-4">
            <Button
              size="sm"
              variant={inputMode === 'hours' ? 'default' : 'outline'}
              onClick={() => setInputMode('hours')}
              className="flex-1"
            >
              Stunden
            </Button>
            <Button
              size="sm"
              variant={inputMode === 'chf' ? 'default' : 'outline'}
              onClick={() => setInputMode('chf')}
              className="flex-1"
            >
              CHF
            </Button>
            <Button
              size="sm"
              variant={inputMode === 'times' ? 'default' : 'outline'}
              onClick={() => setInputMode('times')}
              className="flex-1"
            >
              Zeit
            </Button>
          </div>

          {inputMode === 'hours' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Ist-Stunden</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 6.5"
                  value={hoursInput}
                  onChange={(e) => setHoursInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
              </div>
              
              {/* Quick selection buttons */}
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Schnellauswahl</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setHoursInput('8.4')}
                    className="text-xs"
                  >
                    8.4h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setHoursInput('8')}
                    className="text-xs"
                  >
                    8h
                  </Button>
                </div>
              </div>
            </div>
          ) : inputMode === 'chf' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Betrag in CHF</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 200"
                  value={chfInput}
                  onChange={(e) => setChfInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                {chfInput && hoursFromChf > 0 && (
                  <div className="text-sm text-center text-muted-foreground">
                    = {hoursFromChf.toFixed(2)} Stunden ({employee.hourlyWage.toFixed(2)} CHF/h)
                  </div>
                )}
              </div>
              
              {/* Quick CHF selection buttons */}
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Schnellauswahl</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('200')}
                    className="text-xs"
                  >
                    200 CHF = {(200 / employee.hourlyWage).toFixed(1)}h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('300')}
                    className="text-xs"
                  >
                    300 CHF = {(300 / employee.hourlyWage).toFixed(1)}h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('250')}
                    className="text-xs"
                  >
                    250 CHF = {(250 / employee.hourlyWage).toFixed(1)}h
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Start</Label>
                <Input
                  type="time"
                  value={startInput}
                  onChange={(e) => setStartInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label>Ende</Label>
                <Input
                  type="time"
                  value={endInput}
                  onChange={(e) => setEndInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>
              {startInput && endInput && (
                <div className="col-span-2 text-sm text-center text-muted-foreground">
                  = {calculateHoursFromTimes(startInput, endInput).toFixed(1)} Stunden
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              <X className="h-4 w-4 mr-1" />
              Abbrechen
            </Button>
            <Button size="sm" onClick={handleSave} className="bg-green-600 hover:bg-green-700">
              <Check className="h-4 w-4 mr-1" />
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const ActualHoursGrid = ({
  employees,
  days,
  actualHoursData,
  onHoursChange,
  getEmployeeActualHours,
  getTargetHours,
  showCosts = false,
}: ActualHoursGridProps) => {
  const isWeekView = days.length <= 7;

  // Calculate daily totals
  const getDailyStats = (day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;

    employees.forEach((emp) => {
      const cellKey = `${emp.id}-${dateStr}`;
      const entry = actualHoursData[cellKey];
      if (entry?.hours) {
        totalHours += entry.hours;
        totalCosts += entry.hours * emp.hourlyWage;
      }
    });

    return { totalHours, totalCosts };
  };

  return (
    <ScrollArea className={cn("w-full", isWeekView && "overflow-visible")}>
      <div className={cn("min-w-max", isWeekView && "min-w-0")}>
        <table className={cn("w-full border-collapse", isWeekView && "table-fixed")}>
          <thead>
            <tr>
              <th
                className={cn(
                  "sticky left-0 z-20 bg-card px-2 py-1 text-left text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}
              >
                Mitarbeiter
              </th>
              <th
                className={cn(
                  "sticky z-20 bg-card px-1 py-1 text-center text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                )}
              >
                Ist-Std.
              </th>
              {days.map((day) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                const stats = getDailyStats(day);
                return (
                  <th
                    key={day.toISOString()}
                    className={cn(
                      "px-1 py-1 text-center font-medium border-b",
                      "border-r border-border/50",
                      isWeekendDay && "bg-amber-100 dark:bg-amber-900/30",
                      isSundayDay && "bg-amber-200/70 dark:bg-amber-900/50 border-r-2 border-r-primary/30",
                      isWeekView ? "min-w-[80px] text-xs" : "min-w-[60px] text-[10px]"
                    )}
                  >
                    <div className={cn(
                      "text-muted-foreground text-[9px]",
                      isWeekendDay && "text-amber-700 dark:text-amber-400 font-semibold"
                    )}>
                      {WEEKDAY_NAMES[day.getDay()]}
                    </div>
                    <div className={cn(
                      "font-semibold text-[10px]",
                      isWeekendDay && "text-amber-700 dark:text-amber-400"
                    )}>
                      {format(day, 'd.M.')}
                    </div>
                    {stats.totalHours > 0 && (
                      <div className="flex flex-col items-center mt-0.5">
                        <span className="text-[8px] text-green-600 dark:text-green-400 font-medium">
                          {stats.totalHours.toFixed(1)}h
                        </span>
                        {showCosts && (
                          <span className="text-[7px] text-muted-foreground">
                            {stats.totalCosts.toFixed(0)} CHF
                          </span>
                        )}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => {
              const actualHours = getEmployeeActualHours(employee.id);
              const targetHours = getTargetHours(employee);
              const percentage = Math.min((actualHours / targetHours) * 100, 100);
              const isInRange = percentage >= 90 && percentage <= 110;
              const isUnder = percentage < 90;

              return (
                <tr key={employee.id} className="group hover:bg-muted/30">
                  {/* Employee name */}
                  <td
                    className={cn(
                      "sticky left-0 z-10 bg-card px-2 py-1 text-xs border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                      isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                    )}
                  >
                    <div className="flex items-center gap-1 truncate">
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          employee.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                        )}
                      />
                      <span className="truncate font-medium" title={employee.name}>
                        {employee.name}
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-0.5">
                      {employee.hourlyWage.toFixed(2)} CHF/h
                    </div>
                  </td>

                  {/* Hours summary */}
                  <td
                    className={cn(
                      "sticky z-10 bg-card px-1 py-1 text-center text-[10px] border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                      isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                    )}
                  >
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="space-y-0.5">
                            <div className={cn(
                              "font-semibold",
                              isInRange && "text-green-600 dark:text-green-400",
                              isUnder && "text-amber-600 dark:text-amber-400",
                              !isInRange && !isUnder && "text-red-600 dark:text-red-400"
                            )}>
                              {actualHours.toFixed(1)}
                            </div>
                            <div className="text-[8px] text-muted-foreground">
                              / {targetHours.toFixed(0)}
                            </div>
                            <Progress
                              value={percentage}
                              className={cn(
                                "h-1",
                                isInRange && "[&>div]:bg-green-500",
                                isUnder && "[&>div]:bg-amber-500",
                                !isInRange && !isUnder && "[&>div]:bg-red-500"
                              )}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-xs">
                            <div>Ist: {actualHours.toFixed(1)}h</div>
                            <div>Soll: {targetHours.toFixed(1)}h</div>
                            <div>Diff: {(actualHours - targetHours).toFixed(1)}h</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </td>

                  {/* Day cells */}
                  {days.map((day) => {
                    const dateStr = format(day, 'yyyy-MM-dd');
                    const cellKey = `${employee.id}-${dateStr}`;
                    const entry = actualHoursData[cellKey];

                    return (
                      <ActualHoursCell
                        key={dateStr}
                        employee={employee}
                        day={day}
                        entry={entry}
                        onSave={(newEntry) => onHoursChange(employee.id, dateStr, newEntry)}
                        showCosts={showCosts}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          
          {/* Footer with daily totals */}
          <tfoot>
            <tr className="bg-muted/50 border-t-2 border-border">
              {/* Total label */}
              <td
                className={cn(
                  "sticky left-0 z-10 bg-muted/80 px-2 py-2 text-xs font-bold border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-primary">Σ</span>
                  Tages-Summen
                </div>
              </td>
              
              {/* Total hours for all employees */}
              <td
                className={cn(
                  "sticky z-10 bg-muted/80 px-1 py-2 text-center text-[10px] font-bold border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                )}
              >
                {(() => {
                  const grandTotalHours = days.reduce((sum, day) => {
                    const stats = getDailyStats(day);
                    return sum + stats.totalHours;
                  }, 0);
                  const grandTotalCosts = days.reduce((sum, day) => {
                    const stats = getDailyStats(day);
                    return sum + stats.totalCosts;
                  }, 0);
                  return (
                    <div className="space-y-0.5">
                      <div className="text-green-600 dark:text-green-400">
                        {grandTotalHours.toFixed(1)}h
                      </div>
                      {showCosts && (
                        <div className="text-[8px] text-muted-foreground">
                          {grandTotalCosts.toFixed(0)} CHF
                        </div>
                      )}
                    </div>
                  );
                })()}
              </td>
              
              {/* Daily totals */}
              {days.map((day) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                const stats = getDailyStats(day);
                
                return (
                  <td
                    key={`footer-${day.toISOString()}`}
                    className={cn(
                      "px-1 py-2 text-center text-xs font-semibold border-r",
                      isWeekendDay && "bg-amber-100/50 dark:bg-amber-900/20",
                      isSundayDay && "bg-amber-200/30 dark:bg-amber-900/30 border-r-2 border-r-primary/30",
                      stats.totalHours > 0 && "text-green-700 dark:text-green-400"
                    )}
                  >
                    {stats.totalHours > 0 ? (
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="font-bold">
                          {stats.totalHours.toFixed(1)}h
                        </span>
                        {showCosts && (
                          <span className="text-[9px] text-muted-foreground font-normal">
                            {stats.totalCosts.toFixed(0)} CHF
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
};
