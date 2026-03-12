import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useShiftConfig } from '@/hooks/useShiftConfig';

interface TimeSlot {
  start: string;
  end: string;
}

interface TimeInputCellProps {
  value: TimeSlot | null;
  absenceType?: string | null;
  onChange: (value: TimeSlot | null, absenceType?: string | null) => void;
  slotType: 'früh' | 'spät';
  isWeekend?: boolean;
  isDayOff?: boolean;
  department?: 'service' | 'küche' | 'all';
}

// Quick time presets for each slot type (fallback)
const DEFAULT_QUICK_TIMES = {
  früh: [
    { label: '10-14', start: '10:00', end: '14:00' },
    { label: '11-14', start: '11:00', end: '14:00' },
    { label: '11-15', start: '11:00', end: '15:00' },
    { label: '12-15', start: '12:00', end: '15:00' },
  ],
  spät: [
    { label: '17-22', start: '17:00', end: '22:00' },
    { label: '17-23', start: '17:00', end: '23:00' },
    { label: '18-22:30', start: '18:00', end: '22:30' },
    { label: '18-23', start: '18:00', end: '23:00' },
  ]
};

export const TimeInputCell = ({ 
  value, 
  absenceType,
  onChange, 
  slotType,
  isWeekend,
  isDayOff,
  department
}: TimeInputCellProps) => {
  const { shiftMap, absenceShifts, workShifts } = useShiftConfig();
  
  // Filter absence shifts by department if specified
  const filteredAbsenceShifts = department && department !== 'all'
    ? absenceShifts.filter(shift => {
        const config = shiftMap[shift];
        if (!config) return false;
        return config.department === department || !config.department;
      })
    : absenceShifts;

  // Get 8.4h split shifts for the department
  const splitShifts = workShifts.filter(shift => {
    const config = shiftMap[shift];
    if (!config) return false;
    // Must have split times (start2/end2) and be for this department
    if (!config.start2 || !config.end2) return false;
    if (department && department !== 'all') {
      return config.department === department || !config.department;
    }
    return true;
  });
  
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(value?.start || '');
  const [end, setEnd] = useState(value?.end || '');
  
  useEffect(() => {
    setStart(value?.start || '');
    setEnd(value?.end || '');
  }, [value]);

  const formatTime = (time: string): string => {
    if (!time) return '';
    return time.replace(':00', '');
  };

  const handleStartChange = (newStart: string) => {
    setStart(newStart);
    if (newStart && end) {
      onChange({ start: newStart, end }, null);
    }
  };

  const handleEndChange = (newEnd: string) => {
    setEnd(newEnd);
    if (start && newEnd) {
      onChange({ start, end: newEnd }, null);
    }
  };

  const handleQuickTimeSelect = (preset: { start: string; end: string }) => {
    setStart(preset.start);
    setEnd(preset.end);
    onChange({ start: preset.start, end: preset.end }, null);
    setOpen(false);
  };

  const handleAbsenceSelect = (abbrev: string) => {
    onChange(null, abbrev);
    setOpen(false);
    setStart('');
    setEnd('');
  };

  const handleClear = () => {
    onChange(null, null);
    setStart('');
    setEnd('');
    setOpen(false);
  };

  const displayValue = absenceType 
    ? absenceType
    : value?.start && value?.end 
      ? `${formatTime(value.start)}-${formatTime(value.end)}`
      : '';

  const getAbsenceConfig = (abbrev: string) => {
    return absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev) 
      ? shiftMap[absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev)!]
      : null;
  };

  const absenceConfig = absenceType ? getAbsenceConfig(absenceType) : null;
  const quickTimes = DEFAULT_QUICK_TIMES[slotType];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
            "hover:ring-1 hover:ring-ring focus:outline-none focus:ring-1 focus:ring-ring",
            isWeekend && "bg-primary/5",
            isDayOff && "bg-muted/50",
            absenceType && absenceConfig?.color,
            !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
            !absenceType && !value?.start && "bg-muted/30 border-dashed border-muted-foreground/20 text-muted-foreground"
          )}
        >
          {displayValue || '—'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2 z-50" align="center">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {slotType === 'früh' ? 'Frühschicht' : 'Spätschicht'}
          </div>
          
          {/* Quick time buttons */}
          <div className="grid grid-cols-4 gap-1">
            {quickTimes.map(preset => (
              <button
                key={preset.label}
                onClick={() => handleQuickTimeSelect(preset)}
                className={cn(
                  "px-1.5 py-1 text-[10px] rounded border transition-colors",
                  "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700",
                  "text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800/50",
                  "font-medium"
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* 8.4h Split shifts (e.g., 11-14 / 17-23:30) */}
          {splitShifts.length > 0 && slotType === 'früh' && (
            <div className="pt-1 border-t">
              <div className="text-[10px] text-muted-foreground mb-1">8.4h Geteilt (42h/5 Tage)</div>
              <div className="flex flex-wrap gap-1">
                {splitShifts.map(shift => {
                  const config = shiftMap[shift];
                  if (!config) return null;
                  const formatT = (t: string) => t.replace(':00', '');
                  const label = `${formatT(config.start)}-${formatT(config.end)} / ${formatT(config.start2!)}`;
                  return (
                    <button
                      key={shift}
                      onClick={() => {
                        // Set Früh part
                        onChange({ start: config.start, end: config.end }, null);
                        setOpen(false);
                      }}
                      title={`${config.start}-${config.end} + ${config.start2}-${config.end2} = ${config.hours}h`}
                      className={cn(
                        "px-2 py-1 text-[10px] rounded border transition-colors font-medium",
                        config.color,
                        "hover:opacity-80"
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          
          {/* Custom time inputs */}
          <div className="flex items-center gap-1 pt-1">
            <Input
              type="time"
              value={start}
              onChange={(e) => handleStartChange(e.target.value)}
              className="h-7 text-xs flex-1"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="time"
              value={end}
              onChange={(e) => handleEndChange(e.target.value)}
              className="h-7 text-xs flex-1"
            />
          </div>

          {/* Absence shortcuts */}
          <div className="flex flex-wrap gap-1 pt-2 border-t">
            {filteredAbsenceShifts.map(shift => {
              const config = shiftMap[shift];
              if (!config) return null;
              return (
                <button
                  key={shift}
                  onClick={() => handleAbsenceSelect(config.abbrev)}
                  className={cn(
                    "px-2 py-0.5 text-xs rounded border transition-colors",
                    config.color,
                    "hover:opacity-80"
                  )}
                >
                  {config.abbrev}
                </button>
              );
            })}
          </div>

          {/* Clear button */}
          <button
            onClick={handleClear}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-1 border-t"
          >
            Löschen
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
