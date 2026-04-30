import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Copy, ArrowRight } from 'lucide-react';
import {
  format,
  startOfMonth,
  startOfWeek,
  endOfWeek,
  addWeeks,
  subWeeks,
  eachDayOfInterval,
  isSameMonth,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';

interface CopyWeekDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentMonth: Date;
  currentWeekStart?: Date;
  scheduleData: Record<string, DaySchedule>;
  employeeIds: string[];
  onCopy: (newScheduleData: Record<string, DaySchedule>) => void;
  /** tenantKey function so the dialog can load previous-month data from localStorage */
  tenantKey: (key: string) => string;
}

/** Parse a "yyyy-MM-dd" string in LOCAL time (avoids UTC midnight → previous day in UTC+x zones). */
function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const CopyWeekDialog = ({
  open,
  onOpenChange,
  currentMonth,
  currentWeekStart,
  scheduleData,
  employeeIds,
  onCopy,
  tenantKey,
}: CopyWeekDialogProps) => {
  const [sourceWeek, setSourceWeek] = useState<string>('');
  const [targetWeek, setTargetWeek] = useState<string>('');
  /** Merged schedule data: current month + previous month loaded from localStorage */
  const [extendedScheduleData, setExtendedScheduleData] =
    useState<Record<string, DaySchedule>>(scheduleData);

  // ── Source weeks: today's week + last 4 weeks (covers previous month too) ──
  const getSourceWeeks = () => {
    const today = new Date();
    const thisWeek = startOfWeek(today, { weekStartsOn: 1 });
    const weeks: { start: Date; end: Date; label: string; value: string }[] = [];
    for (let i = 0; i <= 4; i++) {
      const weekStart = subWeeks(thisWeek, i);
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      weeks.push({
        start: weekStart,
        end: weekEnd,
        label: `${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM', { locale: de })}`,
        value: format(weekStart, 'yyyy-MM-dd'),
      });
    }
    return weeks;
  };

  // ── Target weeks: all weeks that have at least one day in the current month ─
  // FIX: use startOfMonth(currentMonth) so the loop always starts from the
  // first week of the month, not from mid-month when currentMonth === day 28/30.
  const getTargetWeeks = () => {
    const weeks: { start: Date; end: Date; label: string; value: string }[] = [];
    const monthFirst = startOfMonth(currentMonth);
    for (let i = 0; i < 6; i++) {
      const weekStart = addWeeks(startOfWeek(monthFirst, { weekStartsOn: 1 }), i);
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      const daysInWeek = eachDayOfInterval({ start: weekStart, end: weekEnd });
      const hasAnyDayInMonth = daysInWeek.some(d => isSameMonth(d, currentMonth));
      if (hasAnyDayInMonth) {
        weeks.push({
          start: weekStart,
          end: weekEnd,
          label: `${format(weekStart, 'd. MMM', { locale: de })} - ${format(weekEnd, 'd. MMM', { locale: de })}`,
          value: format(weekStart, 'yyyy-MM-dd'),
        });
      }
    }
    return weeks;
  };

  const sourceWeeks = getSourceWeeks();
  const targetWeeks = getTargetWeeks();

  // Pre-select on open + load previous month data for cross-month copy
  useEffect(() => {
    if (!open) return;

    // Load previous month's schedule from localStorage so cross-month copying works
    const merged: Record<string, DaySchedule> = { ...scheduleData };
    try {
      // Load up to 2 previous months to cover all possible source weeks
      for (let mBack = 1; mBack <= 2; mBack++) {
        const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - mBack, 1);
        const monthKey = format(d, 'yyyy-MM');
        const raw = localStorage.getItem(tenantKey(`schedule-v2-${monthKey}`));
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, DaySchedule>;
          Object.assign(merged, parsed);
        }
      }
    } catch { /* ignore */ }
    setExtendedScheduleData(merged);

    // Pre-select: try to match currentWeekStart in source list, else first week
    if (currentWeekStart) {
      const key = format(currentWeekStart, 'yyyy-MM-dd');
      const inList = sourceWeeks.some(w => w.value === key);
      setSourceWeek(inList ? key : (sourceWeeks[0]?.value ?? ''));
    } else {
      setSourceWeek(sourceWeeks[0]?.value ?? '');
    }
    setTargetWeek('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Count entries in a week using the extended (cross-month) schedule data
  const countEntriesInWeek = (weekValue: string, data: Record<string, DaySchedule>) => {
    if (!weekValue) return 0;
    const weekStart = parseLocalDate(weekValue);
    const days = eachDayOfInterval({
      start: weekStart,
      end: endOfWeek(weekStart, { weekStartsOn: 1 }),
    });
    let count = 0;
    employeeIds.forEach(empId => {
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const key = `${empId}-${dateStr}`;
        const daySchedule = data[key];
        if (daySchedule) {
          if (daySchedule.früh || daySchedule.frühAbsence) count++;
          if (daySchedule.spät || daySchedule.spätAbsence) count++;
        }
      });
    });
    return count;
  };

  const handleCopy = () => {
    if (!sourceWeek || !targetWeek) return;

    const sourceStart = parseLocalDate(sourceWeek);
    const targetStart = parseLocalDate(targetWeek);
    const sourceDays = eachDayOfInterval({
      start: sourceStart,
      end: endOfWeek(sourceStart, { weekStartsOn: 1 }),
    });
    const targetDays = eachDayOfInterval({
      start: targetStart,
      end: endOfWeek(targetStart, { weekStartsOn: 1 }),
    });

    // Write into a copy of the CURRENT month's data only
    const newScheduleData = { ...scheduleData };

    employeeIds.forEach(empId => {
      sourceDays.forEach((sourceDay, dayIndex) => {
        const targetDay = targetDays[dayIndex];
        if (!targetDay || !isSameMonth(targetDay, currentMonth)) return;

        const sourceDateStr = format(sourceDay, 'yyyy-MM-dd');
        const targetDateStr = format(targetDay, 'yyyy-MM-dd');
        const sourceKey = `${empId}-${sourceDateStr}`;
        const targetKey = `${empId}-${targetDateStr}`;

        // Read from extended data (may include previous months)
        if (extendedScheduleData[sourceKey]) {
          newScheduleData[targetKey] = { ...extendedScheduleData[sourceKey] };
        }
      });
    });

    onCopy(newScheduleData);
    onOpenChange(false);
    setSourceWeek('');
    setTargetWeek('');
  };

  const sourceWeekData = sourceWeeks.find(w => w.value === sourceWeek);
  const targetWeekData = targetWeeks.find(w => w.value === targetWeek);

  const sourceCount = countEntriesInWeek(sourceWeek, extendedScheduleData);
  const targetCount = countEntriesInWeek(targetWeek, scheduleData);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            Woche kopieren
          </DialogTitle>
          <DialogDescription>
            Kopiere alle Schichten (Früh/Spät) von einer Woche auf eine andere.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Source Week — last 5 weeks (including previous month) */}
          <div className="space-y-2">
            <Label>Von Woche</Label>
            <Select value={sourceWeek} onValueChange={setSourceWeek}>
              <SelectTrigger>
                <SelectValue placeholder="Quell-Woche wählen" />
              </SelectTrigger>
              <SelectContent>
                {sourceWeeks.map(week => (
                  <SelectItem key={week.value} value={week.value}>
                    {week.label} ({countEntriesInWeek(week.value, extendedScheduleData)} Einträge)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Arrow indicator */}
          {sourceWeek && (
            <div className="flex justify-center">
              <ArrowRight className="h-6 w-6 text-muted-foreground" />
            </div>
          )}

          {/* Target Week — weeks in current month */}
          <div className="space-y-2">
            <Label>Auf Woche</Label>
            <Select value={targetWeek} onValueChange={setTargetWeek}>
              <SelectTrigger>
                <SelectValue placeholder="Ziel-Woche wählen" />
              </SelectTrigger>
              <SelectContent>
                {targetWeeks
                  .filter(week => week.value !== sourceWeek)
                  .map(week => (
                    <SelectItem key={week.value} value={week.value}>
                      {week.label} ({countEntriesInWeek(week.value, scheduleData)} Einträge)
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* Preview */}
          {sourceWeek && targetWeek && (
            <div className="p-3 bg-muted/50 rounded-lg text-sm">
              <p className="font-medium mb-1">Vorschau:</p>
              <p className="text-muted-foreground">
                {sourceCount} Einträge werden von{' '}
                <span className="font-medium text-foreground">{sourceWeekData?.label}</span>
                {' '}nach{' '}
                <span className="font-medium text-foreground">{targetWeekData?.label}</span>
                {' '}kopiert.
              </p>
              {targetCount > 0 && (
                <p className="text-amber-600 mt-2">
                  ⚠️ Bestehende {targetCount} Einträge in der Zielwoche werden überschrieben.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            onClick={handleCopy}
            disabled={!sourceWeek || !targetWeek}
          >
            <Copy className="h-4 w-4 mr-2" />
            Kopieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
