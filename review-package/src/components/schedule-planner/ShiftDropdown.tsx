import { useState } from 'react';
import { ShiftType, CustomShift } from '@/pages/SchedulePlanner';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { useQuickTimes } from '@/hooks/useQuickTimes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { Clock, Palmtree, ThermometerSnowflake, Hash } from 'lucide-react';

interface ShiftDropdownProps {
  value: ShiftType | null;
  customShift?: CustomShift | null;
  onChange: (shift: ShiftType | null, customShift?: CustomShift | null) => void;
  department?: 'service' | 'küche' | 'all';
}

export const ShiftDropdown = ({ value, customShift, onChange, department }: ShiftDropdownProps) => {
  const { shiftMap, workShifts, absenceShifts, allShiftNames, getShiftsByDepartment } = useShiftConfig();
  const { presets: quickPresets } = useQuickTimes();
  
  // Filter work shifts by department if specified
  const filteredWorkShifts = department && department !== 'all' 
    ? workShifts.filter(shift => {
        const config = shiftMap[shift];
        if (!config) return false;
        // Include shifts that match the department or have no department set
        return config.department === department || !config.department;
      })
    : workShifts;
  
  const [open, setOpen] = useState(false);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [hasSplitShift, setHasSplitShift] = useState(false);
  const [customStart2, setCustomStart2] = useState('');
  const [customEnd2, setCustomEnd2] = useState('');
  const [fixedHoursDialogOpen, setFixedHoursDialogOpen] = useState(false);
  const [fixedHoursValue, setFixedHoursValue] = useState('');

  // Defensive: schedule imports/edits may leave slightly different values (trim/case/time-range)
  const normalizeShiftType = (raw: unknown): ShiftType | null => {
    if (!raw) return null;
    const rawStr = String(raw).trim();
    if (!rawStr) return null;
    
    // Ensure shiftMap is loaded
    if (!shiftMap || Object.keys(shiftMap).length === 0) return null;
    if (!rawStr) return null;

    // Exact match
    if (rawStr in shiftMap) return rawStr as ShiftType;

    // Case-insensitive match against names
    const lower = rawStr.toLowerCase();
    const byName = allShiftNames.find(
      (k) => k.toLowerCase() === lower
    );
    if (byName) return byName;

    // Match abbreviations (FE/K/F)
    const byAbbrev = allShiftNames.find((k) => {
      const ab = shiftMap[k]?.abbrev;
      return ab && ab.toLowerCase() === lower;
    });
    if (byAbbrev) return byAbbrev;

    // Match time-ranges like "17:00-23:30" or "17-23:30"
    const normalizeTimeRange = (s: string) =>
      s
        .replace(/\s+/g, '')
        .replace(/:00(?!\d)/g, '');

    const rawNorm = normalizeTimeRange(rawStr);
    const byTime = allShiftNames.find((k) => {
      const c = shiftMap[k];
      if (!c?.start || !c?.end) return false;
      const full = normalizeTimeRange(`${c.start}-${c.end}`);
      return full === rawNorm;
    });
    if (byTime) return byTime;

    return null;
  };

  const normalizedValue = normalizeShiftType(value);
  const currentConfig = normalizedValue ? shiftMap[normalizedValue] : null;

  const getDisplayLabel = (shift: ShiftType): string => {
    const config = shiftMap[shift];
    if (!config) return shift;

    // Split shifts: show both time ranges
    if (config.start && config.end && config.start2 && config.end2) {
      return `${config.start}-${config.end} / ${config.start2}-${config.end2} · ${config.hours}h`;
    }

    // Work shifts: show exact times + hours
    if (config.start && config.end) {
      return `${config.start}-${config.end} · ${config.hours}h`;
    }

    // Fixed hours shifts (like Zimmerstunde, 8.5h Fest): show hours only
    if (config.fixedHours && config.hours > 0) {
      return `${config.hours}h fest`;
    }

    // Absence shifts that count to target (e.g. Ferien): show abbreviation
    if (config.countsToTarget && !config.isPaid && config.abbrev) {
      return config.abbrev;
    }

    // Other absence shifts (Frei): show abbreviation
    if (config.abbrev) {
      return config.abbrev;
    }

    // Fallback: show the shift name
    return shift;
  };

  const calculateHours = (start: string, end: string): number => {
    if (!start || !end) return 0;
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    let hours = endH - startH + (endM - startM) / 60;
    if (hours < 0) hours += 24;
    return Math.round(hours * 10) / 10;
  };

  const handleCustomSubmit = () => {
    if (customStart && customEnd) {
      let totalHours = calculateHours(customStart, customEnd);
      
      if (hasSplitShift && customStart2 && customEnd2) {
        totalHours += calculateHours(customStart2, customEnd2);
        onChange(null, { 
          start: customStart, 
          end: customEnd, 
          hours: totalHours,
          start2: customStart2,
          end2: customEnd2
        });
      } else {
        onChange(null, { start: customStart, end: customEnd, hours: totalHours });
      }
      
      setCustomDialogOpen(false);
      resetCustomFields();
    }
  };

  const handleFixedHoursSubmit = () => {
    const hours = parseFloat(fixedHoursValue);
    if (!isNaN(hours) && hours > 0 && hours <= 24) {
      onChange(null, { 
        start: '', 
        end: '', 
        hours: Math.round(hours * 10) / 10,
        isFixedHours: true
      });
      setFixedHoursDialogOpen(false);
      setFixedHoursValue('');
    }
  };

  const resetCustomFields = () => {
    setCustomStart('');
    setCustomEnd('');
    setCustomStart2('');
    setCustomEnd2('');
    setHasSplitShift(false);
  };

  const formatTimeLabel = (time: string): string => {
    return time.replace(':00', '');
  };

  const displayLabel = customShift 
    ? customShift.isFixedHours
      ? `${customShift.hours}h fest`
      : customShift.start2 
        ? `${formatTimeLabel(customShift.start)}-${formatTimeLabel(customShift.end)} / ${formatTimeLabel(customShift.start2)}-${formatTimeLabel(customShift.end2 || '')} · ${customShift.hours}h`
        : `${formatTimeLabel(customShift.start)}-${formatTimeLabel(customShift.end)} · ${customShift.hours}h`
    : normalizedValue 
      ? getDisplayLabel(normalizedValue) 
      : value
        ? String(value)
        : '+';

  const displayColor = customShift
    ? customShift.isFixedHours
      ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-700'
      : 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700'
    : normalizedValue && currentConfig
      ? currentConfig.color 
      : 'bg-muted/50 text-muted-foreground border-dashed border-muted-foreground/30 hover:bg-muted';

  const tooltipText = customShift 
    ? customShift.isFixedHours
      ? `Feste Stunden: ${customShift.hours}h`
      : customShift.start2
        ? `${customShift.start}-${customShift.end} + ${customShift.start2}-${customShift.end2} (${customShift.hours}h)`
        : `${customShift.start}-${customShift.end} (${customShift.hours}h)`
    : normalizedValue && currentConfig && currentConfig.start
      ? `${normalizedValue}: ${currentConfig.start}-${currentConfig.end} (${currentConfig.hours}h)`
      : value 
        ? String(value)
        : undefined;
  
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "min-w-[115px] h-9 px-2 rounded text-[10px] font-medium border transition-all whitespace-nowrap",
              "hover:ring-2 hover:ring-ring hover:ring-offset-1",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
              customShift?.start2 && "min-w-[160px]",
              displayColor
            )}
            title={tooltipText}
          >
            {displayLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent 
          align="center" 
          className="w-52 z-50 bg-popover border border-border shadow-lg"
          sideOffset={4}
        >
          {/* Clear option */}
          <DropdownMenuItem
            onClick={() => {
              onChange(null, null);
              setOpen(false);
            }}
            className="cursor-pointer"
          >
            <div className="flex items-center gap-2 w-full">
              <span className="w-3 h-3 rounded border border-dashed border-muted-foreground/50" />
              <span className="text-muted-foreground">Leer</span>
            </div>
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />

          {/* Quick preset options from useQuickTimes */}
          {quickPresets.length > 0 && (
            <>
              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Schnellwahl</div>
              {quickPresets.map(p => {
                const hrs = (() => {
                  const [sh, sm] = p.start.split(':').map(Number);
                  const [eh, em] = p.end.split(':').map(Number);
                  let h = eh - sh + (em - sm) / 60;
                  if (h < 0) h += 24;
                  const h2 = p.start2 && p.end2 ? (() => {
                    const [sh2, sm2] = p.start2.split(':').map(Number);
                    const [eh2, em2] = p.end2.split(':').map(Number);
                    let hh = eh2 - sh2 + (em2 - sm2) / 60;
                    if (hh < 0) hh += 24;
                    return hh;
                  })() : 0;
                  return Math.round((h + h2) * 10) / 10;
                })();
                const label = p.start2 && p.end2
                  ? `${p.start.replace(':00', '')}-${p.end.replace(':00', '')} / ${p.start2.replace(':00', '')}-${p.end2.replace(':00', '')}`
                  : p.label;
                return (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => {
                      onChange(null, {
                        start: p.start,
                        end: p.end,
                        hours: hrs,
                        ...(p.start2 && p.end2 ? { start2: p.start2, end2: p.end2 } : {}),
                      });
                      setOpen(false);
                    }}
                    className="cursor-pointer p-1"
                  >
                    <div className="flex items-center justify-between w-full gap-2">
                      <div className="flex-1 px-2 py-1 rounded text-xs font-medium border bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-200 truncate">
                        {label}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{hrs}h</span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
            </>
          )}
          
          {/* Work shift options */}
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">
            {department === 'küche' ? 'Küche-Schichten' : department === 'service' ? 'Service-Schichten' : 'Arbeitsschichten'}
          </div>
          {filteredWorkShifts.map(shift => {
            const config = shiftMap[shift];
            if (!config) return null;
            return (
              <DropdownMenuItem
                key={shift}
                onClick={() => {
                  onChange(shift, null);
                  setOpen(false);
                }}
                className="cursor-pointer p-1"
              >
                <div className="flex items-center justify-between w-full gap-2">
                  <div className={cn(
                    "flex-1 px-2 py-1 rounded text-xs font-medium border",
                    config.color
                  )}>
                    {config.start2 && config.end2 
                      ? `${config.start}-${config.end} / ${config.start2}-${config.end2}`
                      : `${config.start}-${config.end}`
                    }
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {config.hours}h
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
          
          <DropdownMenuSeparator />
          
          {/* Off shift options */}
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Abwesenheit</div>
          {absenceShifts.map(shift => {
            const config = shiftMap[shift];
            if (!config) return null;
            return (
              <DropdownMenuItem
                key={shift}
                onClick={() => {
                  onChange(shift, null);
                  setOpen(false);
                }}
                className="cursor-pointer p-1"
              >
                <div className="flex items-center justify-between w-full gap-2">
                  <div className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border",
                    config.color
                  )}>
                    <span>{config.abbrev}</span>
                    {shift === 'Ferien' && <Palmtree className="h-3 w-3" />}
                    {shift === 'Krank' && <ThermometerSnowflake className="h-3 w-3" />}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {config.countsToTarget ? 'zählt zu Soll*' : '0h'}
                  </span>
                </div>
              </DropdownMenuItem>
            );
          })}
          
          <DropdownMenuSeparator />
          
          {/* Custom time option */}
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              // Pre-fill with existing custom shift if any
              if (customShift) {
                setCustomStart(customShift.start);
                setCustomEnd(customShift.end);
                if (customShift.start2 && customShift.end2) {
                  setHasSplitShift(true);
                  setCustomStart2(customShift.start2);
                  setCustomEnd2(customShift.end2);
                }
              }
              setCustomDialogOpen(true);
            }}
            className="cursor-pointer"
          >
            <div className="flex items-center gap-2 w-full">
              <Clock className="h-3 w-3 text-teal-600" />
              <span className="font-medium text-teal-600">Eigene Zeit...</span>
            </div>
          </DropdownMenuItem>
          
          {/* Fixed hours option */}
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              if (customShift?.isFixedHours) {
                setFixedHoursValue(customShift.hours.toString());
              }
              setFixedHoursDialogOpen(true);
            }}
            className="cursor-pointer"
          >
            <div className="flex items-center gap-2 w-full">
              <Hash className="h-3 w-3 text-indigo-600" />
              <span className="font-medium text-indigo-600">Feste Stunden...</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Custom Time Dialog */}
      <Dialog open={customDialogOpen} onOpenChange={(open) => {
        setCustomDialogOpen(open);
        if (!open) resetCustomFields();
      }}>
        <DialogContent className="sm:max-w-[350px]">
          <DialogHeader>
            <DialogTitle>Eigene Schichtzeit</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* First shift */}
            <div className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">Schicht 1</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="start">Start</Label>
                  <Input
                    id="start"
                    type="time"
                    step="900"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="end">Ende</Label>
                  <Input
                    id="end"
                    type="time"
                    step="900"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </div>
              </div>
              {customStart && customEnd && (
                <p className="text-sm text-muted-foreground">
                  = {calculateHours(customStart, customEnd)} Stunden
                </p>
              )}
            </div>

            {/* Split shift toggle */}
            <div className="flex items-center space-x-2">
              <Checkbox 
                id="split" 
                checked={hasSplitShift}
                onCheckedChange={(checked) => setHasSplitShift(checked === true)}
              />
              <Label htmlFor="split" className="text-sm cursor-pointer">
                Geteilte Schicht (z.B. mit Zimmerstunde)
              </Label>
            </div>

            {/* Second shift */}
            {hasSplitShift && (
              <div className="space-y-3 pt-2 border-t">
                <div className="text-sm font-medium text-muted-foreground">Schicht 2</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="start2">Start</Label>
                    <Input
                      id="start2"
                      type="time"
                      step="900"
                      value={customStart2}
                      onChange={(e) => setCustomStart2(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="end2">Ende</Label>
                    <Input
                      id="end2"
                      type="time"
                      step="900"
                      value={customEnd2}
                      onChange={(e) => setCustomEnd2(e.target.value)}
                    />
                  </div>
                </div>
                {customStart2 && customEnd2 && (
                  <p className="text-sm text-muted-foreground">
                    = {calculateHours(customStart2, customEnd2)} Stunden
                  </p>
                )}
              </div>
            )}

            {/* Total hours */}
            {customStart && customEnd && (
              <div className="pt-3 border-t">
                <p className="text-sm font-medium">
                  Gesamt: {(
                    calculateHours(customStart, customEnd) + 
                    (hasSplitShift && customStart2 && customEnd2 
                      ? calculateHours(customStart2, customEnd2) 
                      : 0)
                  ).toFixed(1)} Stunden
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setCustomDialogOpen(false);
              resetCustomFields();
            }}>
              Abbrechen
            </Button>
            <Button 
              onClick={handleCustomSubmit} 
              disabled={!customStart || !customEnd || (hasSplitShift && (!customStart2 || !customEnd2))}
            >
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fixed Hours Dialog */}
      <Dialog open={fixedHoursDialogOpen} onOpenChange={(open) => {
        setFixedHoursDialogOpen(open);
        if (!open) setFixedHoursValue('');
      }}>
        <DialogContent className="sm:max-w-[300px]">
          <DialogHeader>
            <DialogTitle>Feste Stunden eingeben</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Gib die Anzahl Stunden direkt ein (ohne Pausenabzug).
              </p>
              <div className="grid gap-2">
                <Label htmlFor="fixedHours">Stunden</Label>
                <Input
                  id="fixedHours"
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="24"
                  placeholder="z.B. 8.4"
                  value={fixedHoursValue}
                  onChange={(e) => setFixedHoursValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleFixedHoursSubmit();
                    }
                  }}
                />
              </div>
              {fixedHoursValue && !isNaN(parseFloat(fixedHoursValue)) && (
                <p className="text-sm font-medium text-indigo-600">
                  = {parseFloat(fixedHoursValue).toFixed(1)} Stunden (ohne Pause)
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setFixedHoursDialogOpen(false);
              setFixedHoursValue('');
            }}>
              Abbrechen
            </Button>
            <Button 
              onClick={handleFixedHoursSubmit} 
              disabled={!fixedHoursValue || isNaN(parseFloat(fixedHoursValue)) || parseFloat(fixedHoursValue) <= 0}
            >
              Übernehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
