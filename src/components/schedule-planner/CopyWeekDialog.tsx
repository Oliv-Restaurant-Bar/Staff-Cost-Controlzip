import { useState } from 'react';
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
import { format, startOfWeek, endOfWeek, addWeeks, eachDayOfInterval, isSameMonth } from 'date-fns';
import { de } from 'date-fns/locale';
import { DaySchedule } from '@/components/schedule-planner/ScheduleGrid';

interface CopyWeekDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentMonth: Date;
  scheduleData: Record<string, DaySchedule>;
  employeeIds: string[];
  onCopy: (newScheduleData: Record<string, DaySchedule>) => void;
}

export const CopyWeekDialog = ({
  open,
  onOpenChange,
  currentMonth,
  scheduleData,
  employeeIds,
  onCopy,
}: CopyWeekDialogProps) => {
  const [sourceWeek, setSourceWeek] = useState<string>('');
  const [targetWeek, setTargetWeek] = useState<string>('');

  // Get all weeks that have at least one day in the current month
  const getWeeksInMonth = () => {
    const weeks: { start: Date; end: Date; label: string; value: string }[] = [];
    
    // Collect weeks
    for (let i = 0; i < 6; i++) {
      const weekStart = addWeeks(startOfWeek(currentMonth, { weekStartsOn: 1 }), i);
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      
      // Check if any day of this week is in the current month
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

  const weeks = getWeeksInMonth();

  const handleCopy = () => {
    if (!sourceWeek || !targetWeek) return;

    const sourceStart = new Date(sourceWeek);
    const targetStart = new Date(targetWeek);
    const sourceDays = eachDayOfInterval({
      start: sourceStart,
      end: endOfWeek(sourceStart, { weekStartsOn: 1 }),
    });
    const targetDays = eachDayOfInterval({
      start: targetStart,
      end: endOfWeek(targetStart, { weekStartsOn: 1 }),
    });

    const newScheduleData = { ...scheduleData };

    employeeIds.forEach(empId => {
      sourceDays.forEach((sourceDay, dayIndex) => {
        const targetDay = targetDays[dayIndex];
        if (!targetDay || !isSameMonth(targetDay, currentMonth)) return;

        const sourceDateStr = format(sourceDay, 'yyyy-MM-dd');
        const targetDateStr = format(targetDay, 'yyyy-MM-dd');
        const sourceKey = `${empId}-${sourceDateStr}`;
        const targetKey = `${empId}-${targetDateStr}`;

        // Copy schedule data (früh, spät, absences)
        if (scheduleData[sourceKey]) {
          newScheduleData[targetKey] = { ...scheduleData[sourceKey] };
        }
      });
    });

    onCopy(newScheduleData);
    onOpenChange(false);
    setSourceWeek('');
    setTargetWeek('');
  };

  const sourceWeekData = weeks.find(w => w.value === sourceWeek);
  const targetWeekData = weeks.find(w => w.value === targetWeek);

  // Count entries in source week (früh + spät slots)
  const countEntriesInWeek = (weekValue: string) => {
    if (!weekValue) return 0;
    const weekStart = new Date(weekValue);
    const days = eachDayOfInterval({
      start: weekStart,
      end: endOfWeek(weekStart, { weekStartsOn: 1 }),
    });
    
    let count = 0;
    employeeIds.forEach(empId => {
      days.forEach(day => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const key = `${empId}-${dateStr}`;
        const daySchedule = scheduleData[key];
        if (daySchedule) {
          if (daySchedule.früh || daySchedule.frühAbsence) count++;
          if (daySchedule.spät || daySchedule.spätAbsence) count++;
        }
      });
    });
    return count;
  };

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
          {/* Source Week */}
          <div className="space-y-2">
            <Label>Von Woche</Label>
            <Select value={sourceWeek} onValueChange={setSourceWeek}>
              <SelectTrigger>
                <SelectValue placeholder="Quell-Woche wählen" />
              </SelectTrigger>
              <SelectContent>
                {weeks.map(week => (
                  <SelectItem key={week.value} value={week.value}>
                    {week.label} ({countEntriesInWeek(week.value)} Einträge)
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

          {/* Target Week */}
          <div className="space-y-2">
            <Label>Auf Woche</Label>
            <Select value={targetWeek} onValueChange={setTargetWeek}>
              <SelectTrigger>
                <SelectValue placeholder="Ziel-Woche wählen" />
              </SelectTrigger>
              <SelectContent>
                {weeks
                  .filter(week => week.value !== sourceWeek)
                  .map(week => (
                    <SelectItem key={week.value} value={week.value}>
                      {week.label} ({countEntriesInWeek(week.value)} Einträge)
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
                {countEntriesInWeek(sourceWeek)} Einträge werden von{' '}
                <span className="font-medium text-foreground">{sourceWeekData?.label}</span>
                {' '}nach{' '}
                <span className="font-medium text-foreground">{targetWeekData?.label}</span>
                {' '}kopiert.
              </p>
              {countEntriesInWeek(targetWeek) > 0 && (
                <p className="text-amber-600 mt-2">
                  ⚠️ Bestehende {countEntriesInWeek(targetWeek)} Einträge in der Zielwoche werden überschrieben.
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
            disabled={!sourceWeek || !targetWeek || countEntriesInWeek(sourceWeek) === 0}
          >
            <Copy className="h-4 w-4 mr-2" />
            Kopieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
