import React, { useState, useEffect } from 'react';
import { format, isWeekend, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Clock, Save, Star } from 'lucide-react';
import { DayOfWeek } from '@/types/personnel';

type HoursPreset = '8.5' | '8.4';

const PRESETS: Record<HoursPreset, { label: string; hours: string; description: string }> = {
  '8.4': { label: '8:24h (42h/5T)', hours: '8.4', description: '42 Std/Woche auf 5 Tage' },
  '8.5': { label: '8:30h', hours: '8.5', description: '8,5 Stunden pro Tag' },
};

interface Apply8HoursDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeName: string;
  employeeId: string;
  days: Date[];
  preferredWorkDays?: DayOfWeek[];
  onConfirm: (selectedDays: Date[], saveAsPreferred: boolean, hoursValue: string) => void;
}

const WEEKDAY_NAMES: Record<number, string> = {
  0: 'So',
  1: 'Mo',
  2: 'Di',
  3: 'Mi',
  4: 'Do',
  5: 'Fr',
  6: 'Sa',
};

const DAY_INDEX_TO_NAME: Record<number, DayOfWeek> = {
  0: 'sonntag',
  1: 'montag',
  2: 'dienstag',
  3: 'mittwoch',
  4: 'donnerstag',
  5: 'freitag',
  6: 'samstag',
};

const DAY_NAME_TO_INDEX: Record<DayOfWeek, number> = {
  'sonntag': 0,
  'montag': 1,
  'dienstag': 2,
  'mittwoch': 3,
  'donnerstag': 4,
  'freitag': 5,
  'samstag': 6,
};

export const Apply8HoursDialog = ({
  open,
  onOpenChange,
  employeeName,
  employeeId,
  days,
  preferredWorkDays,
  onConfirm,
}: Apply8HoursDialogProps) => {
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [saveAsPreferred, setSaveAsPreferred] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<HoursPreset>('8.4');

  // Check if current selection matches preferred days
  const hasPreferredDays = preferredWorkDays && preferredWorkDays.length > 0;

  // Reset selection when dialog opens
  useEffect(() => {
    if (open) {
      if (hasPreferredDays) {
        // Pre-select based on preferred work days
        const preferredDayIndices = new Set(preferredWorkDays!.map(d => DAY_NAME_TO_INDEX[d]));
        const preferredDates = days
          .filter(d => preferredDayIndices.has(getDay(d)))
          .map(d => format(d, 'yyyy-MM-dd'));
        setSelectedDays(new Set(preferredDates));
      } else {
        // Default: Pre-select all weekdays (Mo-Fr)
        const weekdays = days
          .filter(d => !isWeekend(d))
          .map(d => format(d, 'yyyy-MM-dd'));
        setSelectedDays(new Set(weekdays));
      }
      setSaveAsPreferred(false);
    }
  }, [open, days, preferredWorkDays, hasPreferredDays]);

  const toggleDay = (dateStr: string) => {
    setSelectedDays(prev => {
      const newSet = new Set(prev);
      if (newSet.has(dateStr)) {
        newSet.delete(dateStr);
      } else {
        newSet.add(dateStr);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedDays(new Set(days.map(d => format(d, 'yyyy-MM-dd'))));
  };

  const selectWeekdays = () => {
    const weekdays = days
      .filter(d => !isWeekend(d))
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDays(new Set(weekdays));
  };

  const selectPreferred = () => {
    if (hasPreferredDays) {
      const preferredDayIndices = new Set(preferredWorkDays!.map(d => DAY_NAME_TO_INDEX[d]));
      const preferredDates = days
        .filter(d => preferredDayIndices.has(getDay(d)))
        .map(d => format(d, 'yyyy-MM-dd'));
      setSelectedDays(new Set(preferredDates));
    }
  };

  const deselectAll = () => {
    setSelectedDays(new Set());
  };

  const handleConfirm = () => {
    const selectedDates = days.filter(d => selectedDays.has(format(d, 'yyyy-MM-dd')));
    onConfirm(selectedDates, saveAsPreferred, PRESETS[selectedPreset].hours);
    onOpenChange(false);
  };

  // Get unique weekdays from current selection for saving
  const getSelectedWeekdays = (): DayOfWeek[] => {
    const weekdays = new Set<DayOfWeek>();
    days.forEach(day => {
      const dateStr = format(day, 'yyyy-MM-dd');
      if (selectedDays.has(dateStr)) {
        weekdays.add(DAY_INDEX_TO_NAME[getDay(day)]);
      }
    });
    return Array.from(weekdays);
  };

  const selectedWeekdaysCount = getSelectedWeekdays().length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            Schicht eintragen
          </DialogTitle>
          <DialogDescription>
            Wählen Sie Stunden-Vorlage und Tage für <span className="font-semibold">{employeeName}</span>.
            {hasPreferredDays && (
              <span className="block mt-1 text-primary">
                <Star className="h-3 w-3 inline mr-1" />
                Bevorzugte Tage: {preferredWorkDays!.map(d => d.charAt(0).toUpperCase() + d.slice(1, 2)).join(', ')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Preset selection */}
          <div className="flex gap-2">
            {(Object.entries(PRESETS) as [HoursPreset, typeof PRESETS[HoursPreset]][]).map(([key, preset]) => (
              <Button
                key={key}
                variant={selectedPreset === key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedPreset(key)}
                className="flex-1"
              >
                <span className="font-semibold">{preset.label}</span>
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground text-center">{PRESETS[selectedPreset].description}</p>

          {/* Quick select buttons */}
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={selectAll}>
              Alle
            </Button>
            <Button variant="outline" size="sm" onClick={selectWeekdays}>
              Mo-Fr
            </Button>
            {hasPreferredDays && (
              <Button 
                variant="outline" 
                size="sm" 
                onClick={selectPreferred}
                className="text-indigo-600 border-indigo-300 hover:bg-indigo-50 dark:text-indigo-400 dark:border-indigo-700 dark:hover:bg-indigo-950"
              >
                <Star className="h-3 w-3 mr-1" />
                Bevorzugt
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={deselectAll}>
              Keine
            </Button>
          </div>

          {/* Day checkboxes */}
          <div className="grid grid-cols-7 gap-2">
            {days.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const isSelected = selectedDays.has(dateStr);
              const isWeekendDay = isWeekend(day);
              const dayName = DAY_INDEX_TO_NAME[getDay(day)];
              const isPreferredDay = hasPreferredDays && preferredWorkDays!.includes(dayName);
              
              return (
                <div
                  key={dateStr}
                  className={cn(
                    "flex flex-col items-center p-2 rounded-lg border cursor-pointer transition-all relative",
                    isSelected 
                      ? "bg-indigo-100 dark:bg-indigo-900/40 border-indigo-400 dark:border-indigo-600" 
                      : "bg-card border-border hover:bg-muted/50",
                    isWeekendDay && !isSelected && "bg-amber-50 dark:bg-amber-900/20",
                    isPreferredDay && !isSelected && "ring-1 ring-indigo-300 dark:ring-indigo-700"
                  )}
                  onClick={() => toggleDay(dateStr)}
                >
                  {isPreferredDay && (
                    <Star className="absolute top-0.5 right-0.5 h-2.5 w-2.5 text-indigo-500 fill-indigo-500" />
                  )}
                  <span className={cn(
                    "text-[10px] font-medium",
                    isWeekendDay ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                  )}>
                    {WEEKDAY_NAMES[day.getDay()]}
                  </span>
                  <span className={cn(
                    "text-sm font-semibold",
                    isSelected && "text-indigo-700 dark:text-indigo-300"
                  )}>
                    {format(day, 'd')}
                  </span>
                  <Checkbox 
                    checked={isSelected} 
                    className="mt-1 h-4 w-4"
                    onCheckedChange={() => toggleDay(dateStr)}
                  />
                </div>
              );
            })}
          </div>

          {/* Selection summary */}
          <div className="text-sm text-muted-foreground text-center">
            {selectedDays.size} {selectedDays.size === 1 ? 'Tag' : 'Tage'} ausgewählt
            {selectedDays.size > 0 && (
              <span className="text-primary ml-1">
                = {(selectedDays.size * parseFloat(PRESETS[selectedPreset].hours)).toFixed(1)}h
              </span>
            )}
          </div>

          {/* Save as preferred option */}
          {selectedDays.size > 0 && (
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
              <div className="flex items-center gap-2">
                <Save className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="save-preferred" className="text-sm cursor-pointer">
                  Als bevorzugte Arbeitstage speichern
                  <span className="text-xs text-muted-foreground block">
                    {selectedWeekdaysCount} Wochentag{selectedWeekdaysCount !== 1 ? 'e' : ''} werden gespeichert
                  </span>
                </Label>
              </div>
              <Switch
                id="save-preferred"
                checked={saveAsPreferred}
                onCheckedChange={setSaveAsPreferred}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button 
            onClick={handleConfirm}
            disabled={selectedDays.size === 0}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            {selectedDays.size} {selectedDays.size === 1 ? 'Tag' : 'Tage'} eintragen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Helper to get preferred weekdays from selected dates
export const getPreferredWeekdaysFromDates = (dates: Date[]): DayOfWeek[] => {
  const weekdays = new Set<DayOfWeek>();
  dates.forEach(day => {
    weekdays.add(DAY_INDEX_TO_NAME[getDay(day)]);
  });
  return Array.from(weekdays);
};
