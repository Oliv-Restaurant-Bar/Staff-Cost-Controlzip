import { format, addDays, subDays, startOfWeek, startOfMonth, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronLeft, ChevronRight, CalendarIcon, CalendarDays, Calendar as CalendarMonth } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWeekSync } from '@/hooks/useWeekSync';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface DateSelectorProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
}

export const DateSelector = ({ selectedDate, onDateChange }: DateSelectorProps) => {
  const { currentWeekStart, currentMonthStart, weekNumber, setWeek, setMonth, navigateWeek, navigateMonth } = useWeekSync('DateSelector', selectedDate);
  
  const isToday = format(selectedDate, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      onDateChange(date);
      // Also sync the week and month
      setWeek(date);
    }
  };

  const handleGoToToday = () => {
    const today = new Date();
    onDateChange(today);
    setWeek(today);
  };

  return (
    <div className="flex items-center gap-1 sm:gap-2">
      {/* Day Navigation */}
      <Button
        variant="outline"
        size="icon"
        onClick={() => onDateChange(subDays(selectedDate, 1))}
        title="Vorheriger Tag"
        className="h-8 w-8 sm:h-9 sm:w-9"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'justify-start text-left font-normal h-8 sm:h-9 px-2 sm:px-3',
              isToday && 'border-primary'
            )}
          >
            <CalendarIcon className="h-4 w-4 sm:mr-2 shrink-0" />
            {/* Mobile: short format, Desktop: full format */}
            <span className="hidden sm:inline">
              {format(selectedDate, 'EEEE, d. MMMM yyyy', { locale: de })}
            </span>
            <span className="sm:hidden text-xs">
              {format(selectedDate, 'd. MMM', { locale: de })}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={handleDateSelect}
            locale={de}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
          <Separator />
          <div className="p-3 space-y-2">
            <p className="text-xs text-muted-foreground font-medium">Schnellnavigation</p>
            <div className="flex flex-wrap gap-1">
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => handleDateSelect(new Date())}
              >
                Heute
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => {
                  const firstOfMonth = startOfMonth(new Date());
                  handleDateSelect(firstOfMonth);
                }}
              >
                Monatsanfang
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => {
                  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
                  handleDateSelect(weekStart);
                }}
              >
                Wochenanfang
              </Button>
            </div>
            {/* Mobile: Week/Month Navigation inside popover */}
            <Separator className="sm:hidden" />
            <div className="flex flex-wrap gap-1 sm:hidden">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateWeek('prev')}
                className="h-7 px-2 text-xs"
              >
                <ChevronLeft className="h-3 w-3" />
                KW
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateWeek('next')}
                className="h-7 px-2 text-xs"
              >
                KW
                <ChevronRight className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateMonth('prev')}
                className="h-7 px-2 text-xs"
              >
                <ChevronLeft className="h-3 w-3" />
                Monat
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigateMonth('next')}
                className="h-7 px-2 text-xs"
              >
                Monat
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant="outline"
        size="icon"
        onClick={() => onDateChange(addDays(selectedDate, 1))}
        title="Nächster Tag"
        className="h-8 w-8 sm:h-9 sm:w-9"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>


      {/* Today button - compact on mobile */}
      {!isToday && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleGoToToday}
          className="ml-1 h-8 px-2 text-xs sm:h-9 sm:px-3 sm:text-sm"
        >
          <span className="hidden sm:inline">Heute</span>
          <CalendarIcon className="h-4 w-4 sm:hidden" />
        </Button>
      )}
    </div>
  );
};
