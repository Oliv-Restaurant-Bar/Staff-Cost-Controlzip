import { useState, useEffect } from 'react';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';
import { Settings, Info, ChevronDown, ChevronRight, X, Paintbrush } from 'lucide-react';
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
  /** Currently active paint tool: absence abbrev ('FE') or work shift ('shift:Früh') */
  activeTool?: string | null;
  /** Called when user clicks a legend item to select/deselect it as paint tool */
  onToolSelect?: (tool: string | null) => void;
}

export const ShiftLegend = ({
  onEditClick,
  department = 'all',
  activeTool,
  onToolSelect,
}: ShiftLegendProps) => {
  const { shiftMap, workShifts, absenceShifts } = useShiftConfig();

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

  const formatHours = (hours: number): string => {
    const formatted = Number.isInteger(hours)
      ? hours.toString()
      : hours.toFixed(2).replace(/\.?0+$/, '');
    return `${formatted}h`;
  };

  // Auto-expand when a tool is active so user can see which item is selected
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    if (activeTool) setIsOpen(true);
  }, [activeTool]);

  const hasPaintMode = !!onToolSelect;

  const handleShiftClick = (toolValue: string) => {
    if (!onToolSelect) return;
    onToolSelect(activeTool === toolValue ? null : toolValue);
  };

  const isToolActive = (toolValue: string) => activeTool === toolValue;

  return (
    <TooltipProvider>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className={cn(
          "bg-muted/30 rounded-lg transition-all",
          activeTool && "ring-2 ring-primary/40 bg-primary/5"
        )}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 w-full p-3 text-left hover:bg-muted/50 rounded-lg transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground flex-1">
                {activeTool ? (
                  <span className="flex items-center gap-1.5 text-primary font-semibold">
                    <Paintbrush className="h-3.5 w-3.5" />
                    Schnellzuweisung aktiv —{' '}
                    {activeTool.startsWith('shift:')
                      ? activeTool.slice(6)
                      : activeTool}
                    {' '}— auf Mitarbeiterzelle klicken
                  </span>
                ) : (
                  <>
                    Legende{' '}
                    {!isOpen && `(${filteredWorkShifts.length + filteredAbsenceShifts.length} Schichten)`}
                    {hasPaintMode && !isOpen && (
                      <span className="ml-1.5 text-[10px] text-muted-foreground/70 font-normal">
                        · Klicken zum Aktivieren
                      </span>
                    )}
                  </>
                )}
              </span>

              {/* Cancel button when tool is active */}
              {activeTool && onToolSelect && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                  onClick={e => { e.stopPropagation(); onToolSelect(null); }}
                >
                  <X className="h-3 w-3 mr-1" />
                  Beenden (Esc)
                </Button>
              )}

              {onEditClick && !isOpen && !activeTool && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 text-xs shrink-0"
                  onClick={e => { e.stopPropagation(); onEditClick(); }}
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
                const toolValue = `shift:${shiftName}`;
                const active = isToolActive(toolValue);
                const isSplitShift = config.start2 && config.end2;
                const formatT = (t: string) => t.replace(':00', '').replace(':30', ':30');

                const badge = (
                  <div
                    key={shiftName}
                    role={hasPaintMode ? 'button' : undefined}
                    tabIndex={hasPaintMode ? 0 : undefined}
                    onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                    onKeyDown={e => {
                      if (hasPaintMode && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        handleShiftClick(toolValue);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border",
                      "whitespace-nowrap transition-all select-none",
                      config.color,
                      hasPaintMode && "cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-foreground/40",
                      active && "ring-2 ring-offset-1 ring-foreground scale-105 shadow-md",
                      !active && hasPaintMode && activeTool && "opacity-50"
                    )}
                    title={hasPaintMode
                      ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} als Pinsel aktivieren`)
                      : undefined}
                  >
                    {config.displayMode === 'code-in-cell' ? (
                      <>
                        <span>{config.abbrev || shiftName}</span>
                        {config.start && config.end && (
                          <span className="opacity-60 text-[10px]">
                            ({formatT(config.start)}–{formatT(config.end)})
                          </span>
                        )}
                      </>
                    ) : isSplitShift ? (
                      <>
                        <span>{`${formatT(config.start)}-${formatT(config.end)} / ${formatT(config.start2!)}-${formatT(config.end2!)}`}</span>
                        <span className="opacity-70">({formatHours(config.hours)})</span>
                      </>
                    ) : (
                      <>
                        <span>{shiftName}</span>
                        <span className="opacity-70">({formatHours(config.hours)})</span>
                      </>
                    )}
                    {hasPaintMode && active && (
                      <Paintbrush className="h-2.5 w-2.5 ml-0.5 opacity-80" />
                    )}
                  </div>
                );

                if (!hasPaintMode) {
                  return (
                    <Tooltip key={shiftName}>
                      <TooltipTrigger asChild>
                        <div className={cn(
                          "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border cursor-help whitespace-nowrap",
                          config.color
                        )}>
                          {isSplitShift ? (
                            <>
                              <span>{`${formatT(config.start)}-${formatT(config.end)} / ${formatT(config.start2!)}-${formatT(config.end2!)}`}</span>
                              <span className="opacity-70">({formatHours(config.hours)})</span>
                            </>
                          ) : (
                            <>
                              <span>{shiftName}</span>
                              <span className="opacity-70">({formatHours(config.hours)})</span>
                            </>
                          )}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="text-xs">
                          <div className="font-medium">{shiftName}</div>
                          <div>Effektive Arbeitszeit: {config.hours}h</div>
                          {isSplitShift && (
                            <div className="text-muted-foreground">
                              Früh: {config.start}-{config.end} + Spät: {config.start2}-{config.end2}
                            </div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                }

                return badge;
              })}

              {/* Separator */}
              <span className="text-muted-foreground/30 self-center">|</span>

              {/* Absence shifts */}
              {filteredAbsenceShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = config.abbrev || shiftName;
                const active = isToolActive(toolValue);

                return (
                  <div
                    key={shiftName}
                    role={hasPaintMode ? 'button' : undefined}
                    tabIndex={hasPaintMode ? 0 : undefined}
                    onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                    onKeyDown={e => {
                      if (hasPaintMode && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        handleShiftClick(toolValue);
                      }
                    }}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border",
                      "whitespace-nowrap transition-all select-none",
                      config.color,
                      hasPaintMode && "cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-foreground/40",
                      active && "ring-2 ring-offset-1 ring-foreground scale-105 shadow-md",
                      !active && hasPaintMode && activeTool && "opacity-50"
                    )}
                    title={hasPaintMode
                      ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} als Pinsel aktivieren`)
                      : undefined}
                  >
                    <span>{config.abbrev || shiftName}</span>
                    <span className="opacity-70">= {shiftName}</span>
                    {config.hours > 0 && (
                      <span className="opacity-70">({formatHours(config.hours)})</span>
                    )}
                    {config.countsToTarget && !config.isPaid && (
                      <span className="opacity-70">*</span>
                    )}
                    {hasPaintMode && active && (
                      <Paintbrush className="h-2.5 w-2.5 ml-0.5 opacity-80" />
                    )}
                  </div>
                );
              })}

              {/* Custom time indicator */}
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700">
                <span>Eigene Zeit</span>
              </div>

              {/* Footnote */}
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

              {hasPaintMode && (
                <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70 italic">
                  <Paintbrush className="h-3 w-3" />
                  Schicht anklicken, dann Zellen befüllen
                </div>
              )}

              {/* Edit button */}
              {onEditClick && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn("h-7 text-xs", !hasPaintMode && "ml-auto")}
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
