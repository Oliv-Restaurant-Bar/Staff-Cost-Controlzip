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
  activeTool?: string | null;
  onToolSelect?: (tool: string | null) => void;
  mode?: 'bar' | 'sidebar';
}

export const ShiftLegend = ({
  onEditClick,
  department = 'all',
  activeTool,
  onToolSelect,
  mode = 'bar',
}: ShiftLegendProps) => {
  const { shiftMap, workShifts, absenceShifts } = useShiftConfig();

  const filteredWorkShifts = workShifts.filter(shiftName => {
    const config = shiftMap[shiftName];
    if (!config) return false;
    if (config.showInQuickSelect === false) return false;
    if (!config.department || config.department === 'all') return true;
    if (department === 'all') return true;
    return config.department === department;
  });

  const filteredAbsenceShifts = absenceShifts.filter(shiftName => {
    const config = shiftMap[shiftName];
    if (!config) return false;
    if (config.showInQuickSelect === false) return false;
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

  const handleDragStart = (e: React.DragEvent, toolValue: string) => {
    e.dataTransfer.setData('application/shift-tool', toolValue);
    e.dataTransfer.effectAllowed = 'copy';
    if (onToolSelect) onToolSelect(toolValue);
  };

  const handleDragEnd = () => {
  };

  if (mode === 'sidebar') {
    return (
      <TooltipProvider>
        <div className={cn(
          "rounded-lg border bg-card overflow-hidden",
          activeTool && "ring-2 ring-primary/40"
        )}>
          {/* Active tool banner */}
          {activeTool && onToolSelect && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-primary/10 border-b border-primary/20">
              <Paintbrush className="h-3 w-3 text-primary shrink-0" />
              <span className="text-[10px] font-semibold text-primary flex-1 truncate">
                {activeTool.startsWith('shift:') ? activeTool.slice(6) : activeTool} aktiv
              </span>
              <button
                onClick={() => onToolSelect(null)}
                className="text-muted-foreground hover:text-foreground"
                title="Deaktivieren (Esc)"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Work shifts */}
          {filteredWorkShifts.length > 0 && (
            <div className="px-2 py-1.5 space-y-0.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1">Schichten</p>
              {filteredWorkShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = `shift:${shiftName}`;
                const active = isToolActive(toolValue);
                const isSplitShift = config.start2 && config.end2;
                const formatT = (t: string) => t.replace(':00', '').replace(':30', ':30');

                return (
                  <div
                    key={shiftName}
                    draggable={hasPaintMode}
                    onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                    onDragEnd={hasPaintMode ? handleDragEnd : undefined}
                    onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                    className={cn(
                      "flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-medium border cursor-pointer select-none transition-all",
                      config.color,
                      active && "ring-2 ring-offset-1 ring-primary shadow-sm",
                      !active && hasPaintMode && activeTool && "opacity-50",
                      hasPaintMode && "hover:ring-1 hover:ring-foreground/30"
                    )}
                    title={hasPaintMode ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} aktivieren oder ziehen`) : undefined}
                  >
                    <span className="flex-1 truncate">{shiftName}</span>
                    <span className="text-[10px] opacity-60 shrink-0">
                      {isSplitShift
                        ? `${formatT(config.start)}-${formatT(config.end)}`
                        : config.start && config.end
                          ? `${formatT(config.start)}-${formatT(config.end)}`
                          : formatHours(config.hours)}
                    </span>
                    {hasPaintMode && active && <Paintbrush className="h-2.5 w-2.5 shrink-0 opacity-80" />}
                  </div>
                );
              })}
            </div>
          )}

          {/* Divider */}
          {filteredWorkShifts.length > 0 && filteredAbsenceShifts.length > 0 && (
            <div className="border-t border-border/50 mx-2" />
          )}

          {/* Absence shifts */}
          {filteredAbsenceShifts.length > 0 && (
            <div className="px-2 py-1.5 space-y-0.5">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground px-1 mb-1">Abwesenheiten</p>
              {filteredAbsenceShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = config.abbrev || shiftName;
                const active = isToolActive(toolValue);

                return (
                  <div
                    key={shiftName}
                    draggable={hasPaintMode}
                    onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                    onDragEnd={hasPaintMode ? handleDragEnd : undefined}
                    onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                    className={cn(
                      "flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-medium border cursor-pointer select-none transition-all",
                      config.color,
                      active && "ring-2 ring-offset-1 ring-primary shadow-sm",
                      !active && hasPaintMode && activeTool && "opacity-50",
                      hasPaintMode && "hover:ring-1 hover:ring-foreground/30"
                    )}
                    title={hasPaintMode ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} aktivieren oder ziehen`) : undefined}
                  >
                    <span className="font-bold shrink-0">{config.abbrev || shiftName}</span>
                    <span className="flex-1 truncate opacity-70 text-[10px]">{shiftName}</span>
                    {config.hours > 0 && (
                      <span className="text-[10px] opacity-60 shrink-0">{formatHours(config.hours)}</span>
                    )}
                    {hasPaintMode && active && <Paintbrush className="h-2.5 w-2.5 shrink-0 opacity-80" />}
                  </div>
                );
              })}
            </div>
          )}

          {/* Custom time */}
          <div className="px-2 pb-1.5">
            <div className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-medium border bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700 select-none">
              <span className="flex-1">Eigene Zeit</span>
            </div>
          </div>

          {/* Edit button */}
          {onEditClick && (
            <div className="px-2 pb-2 pt-0.5 border-t border-border/50">
              <button
                onClick={onEditClick}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground w-full px-1.5 py-1 rounded hover:bg-muted transition-colors"
              >
                <Settings className="h-3 w-3" />
                Schichten bearbeiten
              </button>
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

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
                    draggable={hasPaintMode}
                    onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                    onDragEnd={hasPaintMode ? handleDragEnd : undefined}
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

              <span className="text-muted-foreground/30 self-center">|</span>

              {filteredAbsenceShifts.map(shiftName => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = config.abbrev || shiftName;
                const active = isToolActive(toolValue);

                return (
                  <div
                    key={shiftName}
                    draggable={hasPaintMode}
                    onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                    onDragEnd={hasPaintMode ? handleDragEnd : undefined}
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

              <div className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700">
                <span>Eigene Zeit</span>
              </div>

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
                    <div>• bis 9:00 Stunden → keine automatische Pause</div>
                    <div>• über 9:00 Stunden → 30 Min. Pause automatisch</div>
                    <div className="text-muted-foreground pt-1">Manuelle Stundenüberschreibung bleibt möglich.</div>
                  </div>
                </TooltipContent>
              </Tooltip>

              {hasPaintMode && (
                <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70 italic">
                  <Paintbrush className="h-3 w-3" />
                  Schicht anklicken, dann Zellen befüllen
                </div>
              )}

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
