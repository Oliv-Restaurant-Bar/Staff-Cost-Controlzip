import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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

/** Verfügbare Zellfarben für manuelle Uhrzeiten */
const CELL_COLORS: { hex: string; label: string }[] = [
  { hex: '#FCD34D', label: 'Gelb' },
  { hex: '#4ADE80', label: 'Grün' },
  { hex: '#60A5FA', label: 'Blau' },
  { hex: '#FB923C', label: 'Orange' },
  { hex: '#F87171', label: 'Rot' },
  { hex: '#C4B5FD', label: 'Violett' },
  { hex: '#9CA3AF', label: 'Grau' },
];

interface TimeInputCellProps {
  value: TimeSlot | null;
  absenceType?: string | null;
  onChange: (value: TimeSlot | null, absenceType?: string | null) => void;
  slotType: 'früh' | 'spät';
  isWeekend?: boolean;
  isDayOff?: boolean;
  isRequestedFree?: boolean;  // Wunschfrei — amber warning, kann eingetragen werden
  isBlocked?: boolean;        // Gesperrt   — rote Warnung, Bestätigung nötig
  department?: 'service' | 'küche' | 'all';
  activeTool?: string | null;
  copiedShift?: TimeSlot | null;
  onCopyShift?: (slot: TimeSlot) => void;
  /** Optional color hex for this cell (manual times only) */
  cellColor?: string | null;
  /** Called when the user selects/deselects a color; null = reset to default */
  onCellColorChange?: (color: string | null) => void;
  /** When provided, shows "Auch ins IST übernehmen" checkbox in the popover */
  onCopyToIst?: (slot: TimeSlot) => void;
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
  isRequestedFree,
  isBlocked,
  department,
  activeTool,
  copiedShift,
  onCopyShift,
  cellColor,
  onCellColorChange,
  onCopyToIst,
}: TimeInputCellProps) => {
  // For blocked days: require explicit override before showing inputs
  const [blockedOverride, setBlockedOverride] = useState(false);
  // Plan → IST copy checkbox
  const [copyToIst, setCopyToIst] = useState(false);
  // Prevents double-trigger when quick-preset already fired onCopyToIst before popover closes
  const copiedInSession = useRef(false);
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
    if (copyToIst && onCopyToIst) {
      onCopyToIst({ start: preset.start, end: preset.end });
      copiedInSession.current = true;
    }
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

  // Find if current time value matches a configured work shift (for displayMode support)
  const matchedWorkShift = value?.start && value?.end
    ? workShifts.find(s => shiftMap[s]?.start === value.start && shiftMap[s]?.end === value.end)
    : undefined;
  const matchedConfig = matchedWorkShift ? shiftMap[matchedWorkShift] : undefined;

  const displayValue = absenceType
    ? absenceType
    : value?.start && value?.end
      ? matchedConfig?.displayMode === 'code-in-cell' && matchedConfig.abbrev
        ? matchedConfig.abbrev
        : `${formatTime(value.start)}-${formatTime(value.end)}`
      : '';

  const getAbsenceConfig = (abbrev: string) => {
    return absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev) 
      ? shiftMap[absenceShifts.find(s => shiftMap[s]?.abbrev === abbrev)!]
      : null;
  };

  const absenceConfig = absenceType ? getAbsenceConfig(absenceType) : null;
  const quickTimes = DEFAULT_QUICK_TIMES[slotType];

  // When paint-tool is active, click directly applies the shift / absence
  if (activeTool) {
    const isShiftMode = activeTool.startsWith('shift:');

    // Helper: base classes for an "empty" cell in paint mode (respects isDayOff + availability)
    const emptyPaintClass =
      isBlocked && !value?.start && !absenceType
        ? "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 font-semibold"
        : isRequestedFree && !value?.start && !absenceType
          ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 font-semibold"
          : isDayOff && !value?.start && !absenceType
            ? "bg-slate-300 dark:bg-slate-600 border-slate-400 dark:border-slate-500 text-slate-600 dark:text-slate-300 font-bold"
            : "bg-muted/30 border-dashed border-muted-foreground/20 text-muted-foreground hover:bg-primary/10 hover:border-primary/40";
    const emptyPaintLabel =
      isBlocked && !value?.start && !absenceType ? '⛔' :
      isRequestedFree && !value?.start && !absenceType ? 'WF' :
      isDayOff && !value?.start && !absenceType ? 'F' : '—';

    if (isShiftMode) {
      // Work-shift paint mode
      const shiftName = activeTool.slice(6);
      const config = shiftMap[shiftName];
      const alreadySet =
        !absenceType &&
        !!value?.start &&
        value.start === config?.start &&
        value.end === config?.end;

      return (
        <button
          onClick={() => onChange(null, null)}
          title={alreadySet ? 'Klicken zum Entfernen' : `${shiftName} eintragen`}
          className={cn(
            "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
            "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none",
            "cursor-crosshair",
            alreadySet && config?.color,
            alreadySet && "ring-1 ring-foreground/30",
            !alreadySet && absenceType && absenceConfig?.color,
            !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
            !alreadySet && !absenceType && !value?.start && emptyPaintClass,
          )}
        >
          {alreadySet
            ? (config?.displayMode === 'code-in-cell' && config.abbrev ? config.abbrev : displayValue)
            : (displayValue || emptyPaintLabel)}
        </button>
      );
    }

    // Absence paint mode
    const toolConfig = absenceShifts.find(s => shiftMap[s]?.abbrev === activeTool)
      ? shiftMap[absenceShifts.find(s => shiftMap[s]?.abbrev === activeTool)!]
      : null;
    const alreadySet = absenceType === activeTool;
    return (
      <button
        onClick={() => onChange(null, null)}
        title={alreadySet ? 'Klicken zum Entfernen' : `${activeTool} eintragen`}
        className={cn(
          "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
          "hover:ring-2 hover:ring-offset-1 hover:ring-foreground focus:outline-none",
          "cursor-crosshair",
          alreadySet && toolConfig?.color,
          alreadySet && "ring-1 ring-foreground/30",
          !alreadySet && absenceType && absenceConfig?.color,
          !alreadySet && !absenceType && value?.start && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
          !alreadySet && !absenceType && !value?.start && emptyPaintClass,
        )}
      >
        {displayValue || emptyPaintLabel}
      </button>
    );
  }

  // A configured day-off with no manually entered content
  const isEmptyDayOff = isDayOff && !value?.start && !absenceType;
  // Availability overlay states
  const isEmptyRequestedFree = isRequestedFree && !value?.start && !absenceType && !isDayOff;
  const isEmptyBlocked       = isBlocked && !value?.start && !absenceType && !isDayOff;

  // Reset blocked override when popover closes; trigger IST copy on close for manual times
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      copiedInSession.current = false;
    }
    if (!nextOpen) {
      setBlockedOverride(false);
      if (copyToIst && onCopyToIst && start && end && !copiedInSession.current) {
        onCopyToIst({ start, end });
      }
    }
    setOpen(nextOpen);
  };

  // Custom cell color applies only to manual time entries (not absences)
  const hasCellColor = !absenceType && !!value?.start && !!cellColor;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "w-full h-8 px-1 text-[10px] font-medium border rounded transition-all",
            "hover:ring-1 hover:ring-ring focus:outline-none focus:ring-1 focus:ring-ring",
            // Base state: empty cell
            !absenceType && !value?.start && !isDayOff && !isRequestedFree && !isBlocked && "bg-muted/30 border-dashed border-muted-foreground/20 text-muted-foreground",
            // Weekend without a day-off override
            isWeekend && !isDayOff && !isRequestedFree && !isBlocked && "bg-primary/5",
            // Configured free day (empty) — clearly distinct from normal empty cells
            isEmptyDayOff && "bg-slate-300 dark:bg-slate-600 border-slate-400 dark:border-slate-500 text-slate-600 dark:text-slate-300 font-bold",
            // Configured free day with manually entered content
            isDayOff && !isEmptyDayOff && "ring-1 ring-slate-400/40 dark:ring-slate-500/40",
            // Wunschfrei (empty)
            isEmptyRequestedFree && "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 font-semibold",
            // Wunschfrei (with content) — amber ring
            isRequestedFree && !isEmptyRequestedFree && "ring-1 ring-amber-400/60 dark:ring-amber-600/60",
            // Blocked (empty)
            isEmptyBlocked && "bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-800 dark:text-red-300 font-semibold",
            // Blocked (with content) — red ring
            isBlocked && !isEmptyBlocked && "ring-1 ring-red-400/60 dark:ring-red-600/60",
            // Absence colors take priority
            absenceType && absenceConfig?.color,
            // Shift time colors (overridden by custom cell color via inline style below)
            !absenceType && value?.start && !isRequestedFree && !isBlocked && !hasCellColor && "bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200",
          )}
          style={hasCellColor ? { backgroundColor: cellColor!, borderColor: cellColor!, color: '#1e3a5f' } : undefined}
        >
          {displayValue || (isEmptyDayOff ? 'F' : isEmptyRequestedFree ? 'WF' : isEmptyBlocked ? '⛔' : '—')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-2 z-50" align="center">
        <div className="space-y-2">
          {/* Wunschfrei warning */}
          {isRequestedFree && (
            <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-2 py-1.5 -mx-0.5">
              <span className="text-amber-600 font-bold text-[11px] leading-tight shrink-0 mt-0.5">WF</span>
              <span className="text-[10px] text-amber-800 dark:text-amber-300 leading-tight">
                Wunschfrei beantragt. Einplanung möglich, aber bitte begründen.
              </span>
            </div>
          )}
          {/* Blocked warning — requires override */}
          {isBlocked && !blockedOverride && (
            <div className="space-y-2 -mx-0.5">
              <div className="flex items-start gap-1.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 px-2 py-1.5">
                <span className="text-red-600 font-bold text-[11px] leading-tight shrink-0 mt-0.5">⛔</span>
                <span className="text-[10px] text-red-800 dark:text-red-300 leading-tight">
                  Dieser Tag ist als gesperrt markiert.
                </span>
              </div>
              <button
                onClick={() => setBlockedOverride(true)}
                className="w-full text-xs font-medium text-red-700 dark:text-red-400 border border-red-300 dark:border-red-700 rounded py-1 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
              >
                Trotzdem eintragen ↓
              </button>
            </div>
          )}
          {isBlocked && blockedOverride && (
            <div className="flex items-center gap-1.5 rounded bg-red-50 dark:bg-red-900/30 border border-red-300 dark:border-red-700 px-2 py-1 -mx-0.5">
              <span className="text-[9px] text-red-700 dark:text-red-300 font-semibold uppercase tracking-wide">Override aktiv</span>
            </div>
          )}

          {/* Only show inputs when not blocked OR when override is granted */}
          {(!isBlocked || blockedOverride) && (<>
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

          {/* Copy / Paste row */}
          <div className="flex gap-1 pt-1 border-t">
            {value?.start && (
              <button
                onClick={() => { onCopyShift?.(value); setOpen(false); }}
                title="Schichtzeit in Zwischenablage kopieren"
                className="flex-1 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 py-1 rounded border border-blue-200 dark:border-blue-700 transition-colors"
              >
                📋 Kopieren
              </button>
            )}
            {copiedShift?.start && (
              <button
                onClick={() => { onChange(copiedShift, null); setOpen(false); }}
                title={`${copiedShift.start}–${copiedShift.end} einfügen`}
                className="flex-1 text-xs text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 py-1 rounded border border-green-200 dark:border-green-700 transition-colors"
              >
                📌 {copiedShift.start.replace(':00','')}-{copiedShift.end.replace(':00','')}
              </button>
            )}
          </div>

          {/* Cell color picker — only for manual time entries */}
          {value?.start && onCellColorChange && (
            <div className="pt-1.5 border-t">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[9px] text-muted-foreground shrink-0">Farbe:</span>
                {CELL_COLORS.map(c => {
                  const isActive = cellColor === c.hex;
                  return (
                    <button
                      key={c.hex}
                      title={isActive ? `${c.label} (klicken zum Entfernen)` : c.label}
                      onClick={() => onCellColorChange(isActive ? null : c.hex)}
                      className={cn(
                        "w-4 h-4 rounded-full transition-all shrink-0",
                        isActive
                          ? "ring-2 ring-offset-1 ring-foreground scale-110"
                          : "ring-1 ring-border hover:scale-110"
                      )}
                      style={{ backgroundColor: c.hex }}
                    />
                  );
                })}
                {cellColor && (
                  <button
                    onClick={() => onCellColorChange(null)}
                    className="text-[9px] text-muted-foreground hover:text-destructive ml-0.5"
                    title="Farbe zurücksetzen"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Plan → IST Checkbox */}
          {onCopyToIst && !absenceType && (
            <div
              className="flex items-center gap-2 pt-1.5 border-t"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                id="copy-to-ist-cb"
                checked={copyToIst}
                onCheckedChange={(checked) => setCopyToIst(!!checked)}
                className="h-3.5 w-3.5 data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
              />
              <label
                htmlFor="copy-to-ist-cb"
                className="text-[10px] text-foreground cursor-pointer select-none leading-tight"
              >
                Auch ins IST übernehmen
              </label>
            </div>
          )}

          {/* Clear button */}
          <button
            onClick={handleClear}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-1 border-t"
          >
            Löschen
          </button>
          </>)}
        </div>
      </PopoverContent>
    </Popover>
  );
};
