import { useState, useEffect, useRef } from 'react';
import { useShiftConfig } from '@/hooks/useShiftConfig';
import type { ShiftConfigItem } from '@/hooks/useShiftConfig';
import { cn } from '@/lib/utils';
import { Settings, Info, ChevronDown, ChevronRight, X, Paintbrush, Trash2, ChevronUp, ChevronDown as ChevronDownIcon, Plus, Palette } from 'lucide-react';
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

const SIDEBAR_COLORS = [
  { name: 'Gelb',    value: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700',   dot: 'bg-amber-400' },
  { name: 'Blau',    value: 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-700',         dot: 'bg-blue-400' },
  { name: 'Lila',    value: 'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-700', dot: 'bg-purple-400' },
  { name: 'Indigo',  value: 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-700', dot: 'bg-indigo-400' },
  { name: 'Grün',    value: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-200 border-green-300 dark:border-green-600',   dot: 'bg-green-400' },
  { name: 'Türkis',  value: 'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200 border-teal-300 dark:border-teal-700',         dot: 'bg-teal-400' },
  { name: 'Pink',    value: 'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200 border-pink-300 dark:border-pink-700',         dot: 'bg-pink-400' },
  { name: 'Cyan',    value: 'bg-cyan-100 dark:bg-cyan-900/40 text-cyan-800 dark:text-cyan-200 border-cyan-300 dark:border-cyan-700',         dot: 'bg-cyan-400' },
  { name: 'Orange',  value: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700', dot: 'bg-orange-400' },
  { name: 'Limette', value: 'bg-lime-100 dark:bg-lime-900/40 text-lime-800 dark:text-lime-200 border-lime-300 dark:border-lime-700',         dot: 'bg-lime-400' },
  { name: 'Rot',     value: 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 border-red-300 dark:border-red-700',               dot: 'bg-red-400' },
  { name: 'Grau',    value: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500',            dot: 'bg-gray-400' },
];

function calcHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (isNaN(sh) || isNaN(eh)) return 0;
  let s = sh + (sm || 0) / 60;
  let e = eh + (em || 0) / 60;
  if (e < s) e += 24;
  const gross = e - s;
  return Math.round((gross > 9 ? gross - 0.5 : gross) * 100) / 100;
}

const EMPTY_FORM = { name: '', abbrev: '', start: '', end: '', department: 'all' as 'all' | 'service' | 'küche', color: SIDEBAR_COLORS[0].value };

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
  const { shifts, shiftMap, workShifts, absenceShifts, updateShifts } = useShiftConfig();

  const handleDeleteShift = (name: string) => {
    updateShifts(shifts.filter(s => s.name !== name));
  };

  const handleMoveShift = (name: string, direction: 'up' | 'down') => {
    const idx = shifts.findIndex(s => s.name === name);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= shifts.length) return;
    const next = [...shifts];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    updateShifts(next);
  };

  const [colorEditFor, setColorEditFor] = useState<string | null>(null);

  const handleColorChange = (name: string, color: string) => {
    // excelColor/textColor leeren → werden in updateShifts neu aus der Tailwind-Farbe abgeleitet.
    updateShifts(shifts.map(s => (s.name === name ? { ...s, color, excelColor: '', textColor: '' } : s)));
    setColorEditFor(null);
  };

  const renderColorPanel = (shiftName: string) => (
    <div className="flex flex-wrap gap-1 px-1.5 pb-1 pt-0.5">
      {SIDEBAR_COLORS.map(c => (
        <button
          key={c.name}
          title={c.name}
          onClick={e => { e.stopPropagation(); handleColorChange(shiftName, c.value); }}
          className={cn(
            'w-4 h-4 rounded-full border-2 transition-transform',
            c.dot,
            shiftMap[shiftName]?.color === c.value ? 'border-foreground scale-125' : 'border-transparent',
          )}
        />
      ))}
    </div>
  );

  const [addForm, setAddForm] = useState<typeof EMPTY_FORM | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const openAddForm = () => {
    const nextColor = SIDEBAR_COLORS[workShifts.length % SIDEBAR_COLORS.length].value;
    setAddForm({ ...EMPTY_FORM, color: nextColor });
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const handleAddShift = () => {
    if (!addForm || !addForm.name.trim()) return;
    const name = addForm.name.trim();
    if (shifts.some(s => s.name === name)) return;
    const hours = addForm.start && addForm.end ? calcHours(addForm.start, addForm.end) : 0;
    const abbrev = addForm.abbrev.trim() || name.slice(0, 3).toUpperCase();
    const newShift: ShiftConfigItem = {
      name,
      abbrev,
      start: addForm.start || '',
      end: addForm.end || '',
      hours,
      color: addForm.color,
      isPaid: true,
      countsToTarget: true,
      department: addForm.department,
      showInQuickSelect: true,
    };
    updateShifts([...shifts, newShift]);
    setAddForm(null);
  };

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
              {filteredWorkShifts.map((shiftName, listIdx) => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = `shift:${shiftName}`;
                const active = isToolActive(toolValue);
                const isSplitShift = config.start2 && config.end2;
                const formatT = (t: string) => t.replace(':00', '').replace(':30', ':30');
                const shiftIdx = shifts.findIndex(s => s.name === shiftName);
                const isFirst = listIdx === 0;
                const isLast = listIdx === filteredWorkShifts.length - 1;

                return (
                  <div key={shiftName} className="group relative">
                    <div
                      draggable={hasPaintMode}
                      onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                      onDragEnd={hasPaintMode ? handleDragEnd : undefined}
                      onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                      className={cn(
                        "flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-medium border select-none transition-all pr-[4.75rem]",
                        config.color,
                        hasPaintMode ? "cursor-pointer" : "cursor-default",
                        active && "ring-2 ring-offset-1 ring-primary shadow-sm",
                        !active && hasPaintMode && activeTool && "opacity-50",
                        hasPaintMode && "hover:ring-1 hover:ring-foreground/30"
                      )}
                      title={hasPaintMode ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} aktivieren oder ziehen`) : shiftName}
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
                    {/* Inline action buttons — visible on hover */}
                    <div className="absolute right-0.5 top-0.5 bottom-0.5 hidden group-hover:flex items-center gap-0.5">
                      <button
                        onClick={e => { e.stopPropagation(); setColorEditFor(colorEditFor === shiftName ? null : shiftName); }}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted transition-colors"
                        title="Farbe ändern"
                      >
                        <Palette className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleMoveShift(shiftName, 'up'); }}
                        disabled={isFirst || shiftIdx <= 0}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="Nach oben verschieben"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleMoveShift(shiftName, 'down'); }}
                        disabled={isLast}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="Nach unten verschieben"
                      >
                        <ChevronDownIcon className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteShift(shiftName); }}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-red-200 hover:bg-red-50 hover:border-red-400 hover:text-red-600 transition-colors"
                        title={`${shiftName} löschen`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    {colorEditFor === shiftName && renderColorPanel(shiftName)}
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
              {filteredAbsenceShifts.map((shiftName, listIdx) => {
                const config = shiftMap[shiftName];
                if (!config) return null;
                const toolValue = config.abbrev || shiftName;
                const active = isToolActive(toolValue);
                const shiftIdx = shifts.findIndex(s => s.name === shiftName);
                const isFirst = listIdx === 0;
                const isLast = listIdx === filteredAbsenceShifts.length - 1;

                return (
                  <div key={shiftName} className="group relative">
                    <div
                      draggable={hasPaintMode}
                      onDragStart={hasPaintMode ? (e) => handleDragStart(e, toolValue) : undefined}
                      onDragEnd={hasPaintMode ? handleDragEnd : undefined}
                      onClick={() => hasPaintMode && handleShiftClick(toolValue)}
                      className={cn(
                        "flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-medium border select-none transition-all pr-[4.75rem]",
                        config.color,
                        hasPaintMode ? "cursor-pointer" : "cursor-default",
                        active && "ring-2 ring-offset-1 ring-primary shadow-sm",
                        !active && hasPaintMode && activeTool && "opacity-50",
                        hasPaintMode && "hover:ring-1 hover:ring-foreground/30"
                      )}
                      title={hasPaintMode ? (active ? 'Klicken zum Deaktivieren' : `${shiftName} aktivieren oder ziehen`) : shiftName}
                    >
                      <span className="font-bold shrink-0">{config.abbrev || shiftName}</span>
                      <span className="flex-1 truncate opacity-70 text-[10px]">{shiftName}</span>
                      {config.hours > 0 && (
                        <span className="text-[10px] opacity-60 shrink-0">{formatHours(config.hours)}</span>
                      )}
                      {hasPaintMode && active && <Paintbrush className="h-2.5 w-2.5 shrink-0 opacity-80" />}
                    </div>
                    {/* Inline action buttons — visible on hover */}
                    <div className="absolute right-0.5 top-0.5 bottom-0.5 hidden group-hover:flex items-center gap-0.5">
                      <button
                        onClick={e => { e.stopPropagation(); setColorEditFor(colorEditFor === shiftName ? null : shiftName); }}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted transition-colors"
                        title="Farbe ändern"
                      >
                        <Palette className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleMoveShift(shiftName, 'up'); }}
                        disabled={isFirst || shiftIdx <= 0}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="Nach oben verschieben"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleMoveShift(shiftName, 'down'); }}
                        disabled={isLast}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-border hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed transition-colors"
                        title="Nach unten verschieben"
                      >
                        <ChevronDownIcon className="h-3 w-3" />
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteShift(shiftName); }}
                        className="h-5 w-5 flex items-center justify-center rounded text-[10px] bg-background/90 border border-red-200 hover:bg-red-50 hover:border-red-400 hover:text-red-600 transition-colors"
                        title={`${shiftName} löschen`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    {colorEditFor === shiftName && renderColorPanel(shiftName)}
                  </div>
                );
              })}
            </div>
          )}

          {/* Add shift inline form */}
          {addForm ? (
            <div className="px-2 pb-2 border-t border-border/50 pt-2 space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Neue Schicht</div>

              {/* Name */}
              <input
                ref={nameInputRef}
                type="text"
                placeholder="Name (z.B. Früh)"
                value={addForm.name}
                onChange={e => setAddForm(f => f && { ...f, name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') handleAddShift(); if (e.key === 'Escape') setAddForm(null); }}
                className="w-full text-[11px] px-1.5 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              />

              {/* Abbrev */}
              <input
                type="text"
                placeholder="Kürzel (z.B. FRÜ)"
                value={addForm.abbrev}
                maxLength={6}
                onChange={e => setAddForm(f => f && { ...f, abbrev: e.target.value })}
                className="w-full text-[11px] px-1.5 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              />

              {/* Times */}
              <div className="flex gap-1 items-center">
                <input
                  type="time"
                  value={addForm.start}
                  onChange={e => setAddForm(f => f && { ...f, start: e.target.value })}
                  className="flex-1 text-[11px] px-1 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <input
                  type="time"
                  value={addForm.end}
                  onChange={e => setAddForm(f => f && { ...f, end: e.target.value })}
                  className="flex-1 text-[11px] px-1 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>

              {/* Department */}
              <select
                value={addForm.department}
                onChange={e => setAddForm(f => f && { ...f, department: e.target.value as 'all' | 'service' | 'küche' })}
                className="w-full text-[11px] px-1.5 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="all">Alle Abteilungen</option>
                <option value="service">Service</option>
                <option value="küche">Küche</option>
              </select>

              {/* Color swatches */}
              <div className="flex flex-wrap gap-1 pt-0.5">
                {SIDEBAR_COLORS.map(c => (
                  <button
                    key={c.name}
                    title={c.name}
                    onClick={() => setAddForm(f => f && { ...f, color: c.value })}
                    className={cn(
                      'w-4 h-4 rounded-full border-2 transition-transform',
                      c.dot,
                      addForm.color === c.value ? 'border-foreground scale-125' : 'border-transparent'
                    )}
                  />
                ))}
              </div>

              {/* Buttons */}
              <div className="flex gap-1 pt-0.5">
                <button
                  onClick={handleAddShift}
                  disabled={!addForm.name.trim()}
                  className="flex-1 text-[11px] px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Hinzufügen
                </button>
                <button
                  onClick={() => setAddForm(null)}
                  className="px-2 py-0.5 rounded text-[11px] border border-border hover:bg-muted transition-colors"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <div className="px-2 pb-1">
              <button
                onClick={openAddForm}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground w-full px-1.5 py-1 rounded hover:bg-muted transition-colors"
              >
                <Plus className="h-3 w-3" />
                Neue Schicht
              </button>
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
