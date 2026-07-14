import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Calendar, CalendarDays, CalendarRange, Download } from 'lucide-react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

export type BalanceExportRange = 'month' | 'week' | 'day';

export interface BalanceExportOptions {
  range: BalanceExportRange;
  startDate: Date;
  endDate: Date;
  periodLabel: string;
}

interface BalanceExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentDate: Date;
  onExport: (options: BalanceExportOptions) => void;
}

export const BalanceExportDialog = ({
  open,
  onOpenChange,
  currentDate,
  onExport
}: BalanceExportDialogProps) => {
  const [selectedRange, setSelectedRange] = useState<BalanceExportRange>('month');
  const [selectedDay, setSelectedDay] = useState<Date>(currentDate);

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const weekNumber = getISOWeek(currentDate);

  const handleExport = () => {
    let startDate: Date;
    let endDate: Date;
    let periodLabel: string;

    switch (selectedRange) {
      case 'day':
        startDate = selectedDay;
        endDate = selectedDay;
        periodLabel = format(selectedDay, 'dd.MM.yyyy', { locale: de });
        break;
      case 'week':
        startDate = weekStart;
        endDate = weekEnd;
        periodLabel = `KW ${weekNumber} (${format(weekStart, 'dd.MM.', { locale: de })} - ${format(weekEnd, 'dd.MM.yyyy', { locale: de })})`;
        break;
      case 'month':
      default:
        startDate = monthStart;
        endDate = monthEnd;
        periodLabel = format(currentDate, 'MMMM yyyy', { locale: de });
        break;
    }

    onExport({
      range: selectedRange,
      startDate,
      endDate,
      periodLabel,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Salden exportieren</DialogTitle>
          <DialogDescription>
            Wähle den Zeitraum für den Excel-Export
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={selectedRange}
          onValueChange={(value) => setSelectedRange(value as BalanceExportRange)}
          className="space-y-3 py-4"
        >
          {/* Month Option */}
          <div 
            className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
            onClick={() => setSelectedRange('month')}
          >
            <RadioGroupItem value="month" id="month" />
            <Label htmlFor="month" className="flex items-center gap-3 cursor-pointer flex-1">
              <Calendar className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Ganzer Monat</p>
                <p className="text-sm text-muted-foreground">
                  {format(currentDate, 'MMMM yyyy', { locale: de })}
                </p>
              </div>
            </Label>
          </div>

          {/* Week Option */}
          <div 
            className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
            onClick={() => setSelectedRange('week')}
          >
            <RadioGroupItem value="week" id="week" />
            <Label htmlFor="week" className="flex items-center gap-3 cursor-pointer flex-1">
              <CalendarDays className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Aktuelle Woche (KW {weekNumber})</p>
                <p className="text-sm text-muted-foreground">
                  {format(weekStart, 'dd.MM.', { locale: de })} - {format(weekEnd, 'dd.MM.yyyy', { locale: de })}
                </p>
              </div>
            </Label>
          </div>

          {/* Day Option */}
          <div 
            className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-accent cursor-pointer"
            onClick={() => setSelectedRange('day')}
          >
            <RadioGroupItem value="day" id="day" />
            <Label htmlFor="day" className="flex items-center gap-3 cursor-pointer flex-1">
              <CalendarRange className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium">Einzelner Tag</p>
                <p className="text-sm text-muted-foreground">
                  Tag auswählen
                </p>
              </div>
            </Label>
          </div>
        </RadioGroup>

        {/* Day Picker */}
        {selectedRange === 'day' && (
          <div className="pb-4">
            <Label className="text-xs text-muted-foreground mb-2 block">Datum wählen</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal"
                  )}
                >
                  <Calendar className="mr-2 h-4 w-4" />
                  {format(selectedDay, 'EEEE, dd. MMMM yyyy', { locale: de })}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <CalendarComponent
                  mode="single"
                  selected={selectedDay}
                  onSelect={(date) => date && setSelectedDay(date)}
                  initialFocus
                  className="pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" />
            Exportieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
