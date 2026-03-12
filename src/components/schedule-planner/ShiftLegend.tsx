import { useState } from 'react';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';
import { Settings, Info, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface ShiftLegendProps {
  onEditClick?: () => void;
  department?: 'service' | 'küche' | 'all';
}

export const ShiftLegend = ({ onEditClick, department = 'all' }: ShiftLegendProps) => {
  const { shiftMap, workShifts, absenceShifts, shifts } = useShiftConfig();

  // Filter shifts by department
  const filteredWorkShifts = workShifts.filter(shiftName => {
    const config = shiftMap[shiftName];
    if (!config) return false;
    if (!config.department || config.department === 'all') return true;
    if (department === 'all') return true;
    return config.department === department;
  });

  const filteredAbsenceShifts = absenceShifts.filter(shiftName => {
    const config = shiftMap[shiftName];
    if (!config) return false;
    if (!config.department || config.department === 'all') return true;
    if (department === 'all') return true;
    return config.department === department;
  });

  // Format hours display with decimals
  const formatHours = (hours: number): string => {
    // Show decimals if present, otherwise whole number
    const formatted = Number.isInteger(hours) ? hours.toString() : hours.toFixed(2).replace(/\.?0+$/, '');
    return `${formatted}h`;
  };

  const [isOpen, setIsOpen] = useState(false);

  return (
    <TooltipProvider>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="bg-muted/30 rounded-lg">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 w-full p-3 text-left hover:bg-muted/50 rounded-lg transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground">
                Legende {!isOpen && `(${filteredWorkShifts.length + filteredAbsenceShifts.length} Schichten)`}
              </span>
              {onEditClick && !isOpen && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditClick();
                  }}
                >
                  <Settings className="h-3 w-3 mr-1" />
                  Bearbeiten
                </Button>
              )}
            </button>
          </CollapsibleTrigger>
          
          <CollapsibleContent>
            <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
              {/* Work shifts */}
              {filteredWorkShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                
                // For split shifts, show abbreviated version with full time in tooltip
                const isSplitShift = config.start2 && config.end2;
                const formatT = (t: string) => t.replace(':00', '').replace(':30', ':30');
                const displayName = isSplitShift 
                  ? `${formatT(config.start)}-${formatT(config.end)} / ${formatT(config.start2!)}-${formatT(config.end2!)}`
                  : shiftName;
                
                return (
                  <Tooltip key={shiftName}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border cursor-help whitespace-nowrap",
                          config.color
                        )}
                      >
                        <span>{displayName}</span>
                        <span className="opacity-70">
                          ({formatHours(config.hours)})
                        </span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-xs">
                        <div className="font-medium">{displayName}</div>
                        <div>Effektive Arbeitszeit: {config.hours}h</div>
                        {isSplitShift && (
                          <div className="text-muted-foreground">
                            Früh: {config.start}-{config.end} + Spät: {config.start2}-{config.end2}
                          </div>
                        )}
                        {config.start && config.end && !isSplitShift && (
                          <div className="text-muted-foreground">
                            (inkl. automatischem Pausenabzug)
                          </div>
                        )}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              
              {/* Separator */}
              <span className="text-muted-foreground/30 self-center">|</span>
              
              {/* Absence shifts */}
              {filteredAbsenceShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                return (
                  <div
                    key={shiftName}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border",
                      config.color
                    )}
                  >
                    <span>{config.abbrev || shiftName}</span>
                    <span className="opacity-70">= {shiftName}</span>
                    {config.hours > 0 && (
                      <span className="opacity-70">({formatHours(config.hours)})</span>
                    )}
                    {config.countsToTarget && !config.isPaid && (
                      <span className="opacity-70">*</span>
                    )}
                  </div>
                );
              })}
              
              {/* Custom time indicator */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700">
                <span>Eigene Zeit</span>
              </div>
              
              {/* Legend footnote */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground self-center ml-2 cursor-help">
                    <Info className="h-3 w-3" />
                    <span>* zählt zu Soll, nicht zu Kosten</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <div className="text-xs space-y-1">
                    <div className="font-medium">Pausenregelung:</div>
                    <div>• ab 5:30 Stunden → 15 Min. Pause</div>
                    <div>• ab 7:00 Stunden → 30 Min. Pause</div>
                    <div>• ab 9:00 Stunden → 60 Min. Pause</div>
                  </div>
                </TooltipContent>
              </Tooltip>

              {/* Edit button */}
              {onEditClick && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 text-xs"
                  onClick={onEditClick}
                >
                  <Settings className="h-3 w-3 mr-1" />
                  Bearbeiten
                </Button>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </TooltipProvider>
  );
};
