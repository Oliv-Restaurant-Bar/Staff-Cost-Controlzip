// Actual Hours Grid Component - For displaying and editing Ist-Stunden in schedule view
import React, { useState } from 'react';
import { format, isWeekend, isSunday, getDay } from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee } from '@/types/personnel';
import { getEmployeeDisplayName } from '@/lib/personnel-utils';
import { LGAV } from '@/lib/salaryCalc';
import { getEffectiveHourlyRate, getWageLabel } from '@/lib/employee-rate';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Check, X, Clock, AlertTriangle, TrendingDown, Lightbulb, Zap, CheckCircle2, Minus as MinusIcon } from 'lucide-react';

export type AbsenceCode = 'FE' | 'FT' | 'K' | 'U' | 'F';
export const ABSENCE_CODES: ReadonlySet<AbsenceCode> = new Set(['FE', 'FT', 'K', 'U', 'F']);
export const isProductiveEntry = (entry: ActualHoursEntry | undefined): boolean =>
  !!entry && entry.hours > 0 && !entry.absenceType;

export interface ActualHoursEntry {
  hours: number;
  start?: string;
  end?: string;
  start2?: string;
  end2?: string;
  absenceType?: AbsenceCode;
  /** Markiert als Zusatzkosten-Tag: Stunden eines Fixlohn-MA die als variable Flex-Kosten gezählt werden sollen */
  isAdditionalCost?: boolean;
}

interface ActualHoursGridProps {
  employees: Employee[];
  days: Date[];
  actualHoursData: Record<string, ActualHoursEntry>; // key: employeeId-date
  onHoursChange: (employeeId: string, date: string, entry: ActualHoursEntry | null) => void;
  getEmployeeActualHours: (employeeId: string) => number;
  getTargetHours: (employee: Employee) => number;
  showCosts?: boolean;
  dailyBudgets?: Record<string, { plannedRevenue?: number; actualRevenue?: number }>;
  laborCostThreshold?: number;
  /** External day-click handler: opens the day detail popup for ANY day */
  onDayClick?: (day: Date) => void;
}

const WEEKDAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAY_MAP: Record<string, number> = {
  'sonntag': 0,
  'montag': 1,
  'dienstag': 2,
  'mittwoch': 3,
  'donnerstag': 4,
  'freitag': 5,
  'samstag': 6,
};

// Check if a day is configured as a day off
const isDayOff = (employee: Employee, day: Date): boolean => {
  if (!employee.daysOff || employee.daysOff.length === 0) return false;
  const dayOfWeek = getDay(day);
  return employee.daysOff.some(dayName => WEEKDAY_MAP[dayName] === dayOfWeek);
};

// ── Effektiver Stundenansatz ──────────────────────────────────────────────────
// getEffectiveHourlyRate + getWageLabel leben jetzt in der puren Lib
// '@/lib/employee-rate'. Re-Export hier, damit bestehende Importe aus
// ActualHoursGrid (PersonalFix, IstDayDetailDialog) unverändert funktionieren.
export { getEffectiveHourlyRate, getWageLabel } from '@/lib/employee-rate';

// Calculate hours from start/end times
const calculateHoursFromTimes = (start: string, end: string): number => {
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  let hours = endH - startH + (endM - startM) / 60;
  if (hours < 0) hours += 24;
  return Math.round(hours * 100) / 100;
};

// Cell editing component
const ActualHoursCell = ({
  employee,
  day,
  entry,
  onSave,
  showCosts = false,
  quickEntry = null,
}: {
  employee: Employee;
  day: Date;
  entry: ActualHoursEntry | undefined;
  onSave: (entry: ActualHoursEntry | null) => void;
  showCosts?: boolean;
  quickEntry?: AbsenceCode | null;
}) => {
  const { rates: socialCostRates } = useSocialCostRates();
  const [isEditing, setIsEditing] = useState(false);
  const [inputMode, setInputMode] = useState<'hours' | 'times' | 'chf'>('hours');
  const [hoursInput, setHoursInput] = useState('');
  const [chfInput, setChfInput] = useState('');
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');
  const [startInput2, setStartInput2] = useState('');
  const [endInput2, setEndInput2] = useState('');
  const [isAdditionalCost, setIsAdditionalCost] = useState(false);

  // Ist dieser MA ein Fixlohn-MA (hat Monatslohn)?
  // Identisch mit ModernScheduleGrid: Nur monthlySalary > 0 entscheidet,
  // unabhängig vom employmentType – gilt für beide Mandanten (Oliv + Beaulieu).
  const isFixedEmployee = (employee.monthlySalary ?? 0) > 0;

  const isWeekendDay = isWeekend(day);
  const isSundayDay = isSunday(day);
  const isDayOffDay = isDayOff(employee, day);

  // Effektiver Stundenansatz: hourlyWage > 0 → direkt; Monatslohn → L-GAV intern; sonst 0
  const effectiveRate = getEffectiveHourlyRate(employee, socialCostRates) ?? 0;

  // Calculate hours from CHF amount
  const hoursFromChf = (chfInput && effectiveRate > 0) ? (parseFloat(chfInput.replace(',', '.')) / effectiveRate) : 0;

  const handleCellClick = () => {
    // ── Schnellerfassung-Modus: kein Dialog, direkte Zuweisung ──
    if (quickEntry) {
      if (entry?.absenceType === quickEntry) {
        // Gleicher Typ nochmal → aufheben
        onSave(null);
      } else {
        onSave({ hours: 0, absenceType: quickEntry });
      }
      return;
    }
    // ── Normaler Modus: Dialog öffnen ──
    if (entry) {
      setHoursInput(entry.hours.toString());
      setChfInput(effectiveRate > 0 ? (entry.hours * effectiveRate).toFixed(0) : '');
      setStartInput(entry.start || '');
      setEndInput(entry.end || '');
      setStartInput2(entry.start2 || '');
      setEndInput2(entry.end2 || '');
      setInputMode(entry.start && entry.end ? 'times' : 'hours');
      setIsAdditionalCost(entry.isAdditionalCost ?? false);
    } else {
      setHoursInput('');
      setChfInput('');
      setStartInput('');
      setEndInput('');
      setStartInput2('');
      setEndInput2('');
      setInputMode('hours');
      setIsAdditionalCost(false);
    }
    setIsEditing(true);
  };

  const handleSave = () => {
    const zusatz = isFixedEmployee && isAdditionalCost ? true : undefined;
    if (inputMode === 'hours') {
      const hours = parseFloat(hoursInput.replace(',', '.'));
      if (!isNaN(hours) && hours > 0) {
        onSave({ hours, isAdditionalCost: zusatz });
      } else if (hoursInput === '' || hours === 0) {
        onSave(null);
      }
    } else if (inputMode === 'chf') {
      const chf = parseFloat(chfInput.replace(',', '.'));
      if (!isNaN(chf) && chf > 0 && effectiveRate > 0) {
        const hours = chf / effectiveRate;
        onSave({ hours: Math.round(hours * 100) / 100, isAdditionalCost: zusatz });
      } else if (chfInput === '' || chf === 0) {
        onSave(null);
      }
    } else {
      if (startInput && endInput) {
        const hours1 = calculateHoursFromTimes(startInput, endInput);
        const hours2 = (startInput2 && endInput2) ? calculateHoursFromTimes(startInput2, endInput2) : 0;
        const totalHours = Math.round((hours1 + hours2) * 100) / 100;
        onSave({
          hours: totalHours,
          start: startInput,
          end: endInput,
          ...(startInput2 && endInput2 ? { start2: startInput2, end2: endInput2 } : {}),
          isAdditionalCost: zusatz,
        });
      }
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  const hours = entry?.hours || 0;
  const cost = hours * effectiveRate;
  const absenceType = entry?.absenceType;

  const handleAbsenceQuick = (type: AbsenceCode) => {
    onSave({ hours: 0, absenceType: type });
    setIsEditing(false);
  };

  // Quick-entry hover color matches the active type
  const quickHoverClass = quickEntry === 'FE'
    ? 'hover:bg-blue-100 dark:hover:bg-blue-900/40 ring-1 ring-inset ring-blue-300/60 dark:ring-blue-700/60'
    : quickEntry === 'FT'
      ? 'hover:bg-violet-100 dark:hover:bg-violet-900/40 ring-1 ring-inset ring-violet-300/60 dark:ring-violet-700/60'
      : quickEntry === 'K'
        ? 'hover:bg-red-100 dark:hover:bg-red-900/40 ring-1 ring-inset ring-red-300/60 dark:ring-red-700/60'
        : quickEntry === 'F'
          ? 'hover:bg-slate-200 dark:hover:bg-slate-700/40 ring-1 ring-inset ring-slate-400/60 dark:ring-slate-600/60'
          : 'hover:bg-primary/10';

  return (
    <>
      <td
        className={cn(
          "px-1 py-1 text-center text-xs border-r border-b transition-colors",
          "min-w-[60px]",
          quickEntry ? "cursor-cell" : "cursor-pointer",
          isWeekendDay && "bg-amber-50 dark:bg-amber-900/20",
          isSundayDay && "bg-amber-100/50 dark:bg-amber-900/30 border-r-2 border-r-primary/30",
          isDayOffDay && "bg-muted/50",
          absenceType === 'FE' && "bg-blue-50 dark:bg-blue-900/20",
          absenceType === 'FT' && "bg-violet-50 dark:bg-violet-900/20",
          absenceType === 'K' && "bg-red-50 dark:bg-red-900/20",
          absenceType === 'U' && "bg-amber-50 dark:bg-amber-900/20",
          absenceType === 'F' && "bg-slate-100 dark:bg-slate-800/50",
          !absenceType && hours > 0 && "bg-green-50 dark:bg-green-900/20",
          quickHoverClass,
        )}
        onClick={handleCellClick}
        title={quickEntry ? `Klicken → ${quickEntry} setzen (nochmal klicken zum Aufheben)` : "Klicken zum Bearbeiten"}
      >
        {absenceType ? (
          <div className="flex flex-col items-center gap-0.5">
            <span className={cn(
              "font-bold text-xs px-1.5 py-0.5 rounded",
              absenceType === 'FE' && "text-blue-600 dark:text-blue-400",
              absenceType === 'FT' && "text-violet-600 dark:text-violet-400",
              absenceType === 'K' && "text-red-600 dark:text-red-400",
              absenceType === 'U' && "text-amber-600 dark:text-amber-400",
              absenceType === 'F' && "text-slate-500 dark:text-slate-400"
            )}>
              {absenceType}
            </span>
            {showCosts && (
              <span className="text-[9px] text-muted-foreground">
                {cost.toFixed(0)} CHF
              </span>
            )}
          </div>
        ) : hours > 0 ? (
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-0.5">
              <span className="font-medium text-green-700 dark:text-green-400">
                {hours.toFixed(1)}h
              </span>
              {entry?.isAdditionalCost && (
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-orange-500 text-white text-[8px] font-bold leading-none" title="Zusatzkosten">
                  +
                </span>
              )}
            </div>
            {entry?.start && entry?.end && (
              <span className="text-[9px] text-muted-foreground">
                {entry.start}–{entry.end}
                {entry.start2 && entry.end2 && (
                  <> / {entry.start2}–{entry.end2}</>
                )}
              </span>
            )}
            {showCosts && (
              <span className={cn("text-[9px]", entry?.isAdditionalCost ? "text-orange-600 dark:text-orange-400 font-semibold" : "text-muted-foreground")}>
                {cost.toFixed(0)} CHF{entry?.isAdditionalCost ? ' ✚' : ''}
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>

      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Ist-Stunden: {getEmployeeDisplayName(employee)}
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground mb-4">
            {format(day, 'EEEE, d. MMMM yyyy', { locale: de })}
          </div>

          {/* FE / FT / K / U / F Schnellauswahl */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleAbsenceQuick('FE')}
              className={cn("font-semibold text-blue-600 border-blue-300 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/30", absenceType === 'FE' && "bg-blue-50 border-blue-400 dark:bg-blue-900/30")}
            >
              FE – Ferien
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleAbsenceQuick('FT')}
              className={cn("font-semibold text-violet-600 border-violet-300 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-950/30", absenceType === 'FT' && "bg-violet-50 border-violet-400 dark:bg-violet-900/30")}
            >
              FT – Feiertag
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleAbsenceQuick('K')}
              className={cn("font-semibold text-red-600 border-red-300 hover:bg-red-50", absenceType === 'K' && "bg-red-50 dark:bg-red-900/30")}
            >
              K – Krank
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleAbsenceQuick('U')}
              className={cn("font-semibold text-amber-600 border-amber-300 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/30", absenceType === 'U' && "bg-amber-50 border-amber-400 dark:bg-amber-900/30")}
            >
              U – Unfall
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleAbsenceQuick('F')}
              className={cn("col-span-2 font-semibold text-slate-500 border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800/30", absenceType === 'F' && "bg-slate-100 border-slate-400 dark:bg-slate-800/50")}
            >
              F – Frei
            </Button>
          </div>
          <div className="relative mb-4">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">oder Stunden eingeben</span>
            </div>
          </div>

          {/* Mode Toggle */}
          <div className="flex gap-2 mb-4">
            <Button
              size="sm"
              variant={inputMode === 'hours' ? 'default' : 'outline'}
              onClick={() => setInputMode('hours')}
              className="flex-1"
            >
              Stunden
            </Button>
            <Button
              size="sm"
              variant={inputMode === 'chf' ? 'default' : 'outline'}
              onClick={() => setInputMode('chf')}
              className="flex-1"
            >
              CHF
            </Button>
            <Button
              size="sm"
              variant={inputMode === 'times' ? 'default' : 'outline'}
              onClick={() => setInputMode('times')}
              className="flex-1"
            >
              Zeit
            </Button>
          </div>

          {inputMode === 'hours' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Ist-Stunden</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 6.5"
                  value={hoursInput}
                  onChange={(e) => setHoursInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
              </div>
              
              {/* Quick selection buttons */}
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Schnellauswahl</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setHoursInput('8.4')}
                    className="text-xs"
                  >
                    8.4h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setHoursInput('8')}
                    className="text-xs"
                  >
                    8h
                  </Button>
                </div>
              </div>
            </div>
          ) : inputMode === 'chf' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Betrag in CHF</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="z.B. 200"
                  value={chfInput}
                  onChange={(e) => setChfInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                {chfInput && hoursFromChf > 0 && effectiveRate > 0 && (
                  <div className="text-sm text-center text-muted-foreground">
                    = {hoursFromChf.toFixed(2)} Stunden ({effectiveRate.toFixed(2)} CHF/h)
                  </div>
                )}
              </div>
              
              {/* Quick CHF selection buttons */}
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Schnellauswahl</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('200')}
                    className="text-xs"
                    disabled={effectiveRate <= 0}
                  >
                    200 CHF = {effectiveRate > 0 ? (200 / effectiveRate).toFixed(1) : '?'}h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('300')}
                    className="text-xs"
                    disabled={effectiveRate <= 0}
                  >
                    300 CHF = {effectiveRate > 0 ? (300 / effectiveRate).toFixed(1) : '?'}h
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setChfInput('250')}
                    className="text-xs"
                    disabled={effectiveRate <= 0}
                  >
                    250 CHF = {effectiveRate > 0 ? (250 / effectiveRate).toFixed(1) : '?'}h
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Schicht 1 */}
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Schicht 1</Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Start</Label>
                    <Input
                      type="time"
                      value={startInput}
                      onChange={(e) => setStartInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Ende</Label>
                    <Input
                      type="time"
                      value={endInput}
                      onChange={(e) => setEndInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                  </div>
                </div>
                {startInput && endInput && (
                  <div className="text-xs text-muted-foreground mt-1 text-right">
                    {calculateHoursFromTimes(startInput, endInput).toFixed(1)} h
                  </div>
                )}
              </div>

              {/* Schicht 2 (optional) */}
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Schicht 2 <span className="normal-case font-normal">(optional)</span>
                </Label>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Start</Label>
                    <Input
                      type="time"
                      value={startInput2}
                      onChange={(e) => setStartInput2(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="—"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Ende</Label>
                    <Input
                      type="time"
                      value={endInput2}
                      onChange={(e) => setEndInput2(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="—"
                    />
                  </div>
                </div>
                {startInput2 && endInput2 && (
                  <div className="text-xs text-muted-foreground mt-1 text-right">
                    {calculateHoursFromTimes(startInput2, endInput2).toFixed(1)} h
                  </div>
                )}
              </div>

              {/* Gesamtanzeige */}
              {startInput && endInput && (
                <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-center font-medium">
                  Total: {(
                    calculateHoursFromTimes(startInput, endInput) +
                    (startInput2 && endInput2 ? calculateHoursFromTimes(startInput2, endInput2) : 0)
                  ).toFixed(1)} Stunden
                </div>
              )}
            </div>
          )}

          {/* Zusatzkosten-Checkbox: nur für Fixlohn-Mitarbeiter */}
          {isFixedEmployee && (
            <div className="mt-3 flex items-start gap-2.5 rounded-md border border-orange-200 bg-orange-50 dark:border-orange-700/50 dark:bg-orange-900/20 px-3 py-2.5">
              <input
                id="isAdditionalCost"
                type="checkbox"
                checked={isAdditionalCost}
                onChange={(e) => setIsAdditionalCost(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-orange-400 accent-orange-500 cursor-pointer"
              />
              <label htmlFor="isAdditionalCost" className="cursor-pointer text-sm leading-tight">
                <span className="font-semibold text-orange-700 dark:text-orange-400">Als Zusatzkosten erfassen</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Diese Stunden werden in der Flex-Kostenrechnung (PersonalFix) als variable Kosten ausgewiesen.
                </span>
              </label>
            </div>
          )}

          <DialogFooter className="gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              <X className="h-4 w-4 mr-1" />
              Abbrechen
            </Button>
            <Button size="sm" onClick={handleSave} className="bg-green-600 hover:bg-green-700">
              <Check className="h-4 w-4 mr-1" />
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const ActualHoursGrid = ({
  employees,
  days,
  actualHoursData,
  onHoursChange,
  getEmployeeActualHours,
  getTargetHours,
  showCosts = false,
  dailyBudgets = {},
  laborCostThreshold: laborCostThresholdProp,
  onDayClick,
}: ActualHoursGridProps) => {
  const isWeekView = days.length <= 7;

  // Zentrale AG-Sozialkostensätze für alle Stundenkostensätze in diesem Grid
  const { rates: socialCostRates } = useSocialCostRates();

  // ── Schnellerfassung-Modus ─────────────────────────────────────────────────
  const [quickEntry, setQuickEntry] = useState<AbsenceCode | null>(null);

  const toggleQuickEntry = (type: AbsenceCode) => {
    setQuickEntry(prev => prev === type ? null : type);
  };

  // Over-budget dialog state
  const [openDialogDay, setOpenDialogDay] = useState<string | null>(null);
  const [showIdealPlan, setShowIdealPlan] = useState(false);

  // Use prop if provided (allows per-department threshold), else fall back to localStorage
  const LABOR_COST_THRESHOLD = laborCostThresholdProp ?? parseFloat(localStorage.getItem('labor_cost_threshold') || '40');

  // Calculate daily totals with budget awareness + Ampel marker
  const getDailyStats = (day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    let totalHours = 0;
    let totalCosts = 0;

    let absenceCellsSkipped = 0;

    employees.forEach((emp) => {
      const cellKey = `${emp.id}-${dateStr}`;
      const entry = actualHoursData[cellKey];
      if (!entry) return;

      // Exclude ALL absence types from productive day totals
      if (entry.absenceType) {
        absenceCellsSkipped++;
        console.log(`[ABSENCE] type: ${entry.absenceType} excluded from day totals | employee: ${emp.name}`);
        return;
      }

      if (entry.hours > 0) {
        const effRate = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
        const istCost = entry.hours * effRate;
        totalHours += entry.hours;
        totalCosts += istCost;
        // [WAGE-COST] logs per employee with IST hours
        console.log(`[WAGE-COST] employee: ${emp.name} (${emp.id})`);
        console.log(`[WAGE-COST] hourly_rate: ${emp.hourlyWage ?? 0}`);
        console.log(`[WAGE-COST] monthly_salary: ${emp.monthlySalary ?? 0}`);
        console.log(`[WAGE-COST] target_hours: ${emp.weeklyHours ?? LGAV.WEEKLY_HOURS_FULLTIME}h/Woche → ${LGAV.MONTHLY_HOURS}h/Monat (L-GAV)`);
        console.log(`[WAGE-COST] effective hourly rate: ${effRate.toFixed(2)} CHF/h${effRate === 0 ? ' → LOHN FEHLT' : ''}`);
        console.log(`[WAGE-COST] ist hours: ${entry.hours.toFixed(2)}`);
        console.log(`[WAGE-COST] ist cost: CHF ${istCost.toFixed(2)}`);
      }
    });

    if (absenceCellsSkipped > 0) {
      console.log(`[ABSENCE] absence cells skipped: ${absenceCellsSkipped}`);
      console.log(`[ABSENCE] productive day hours: ${totalHours.toFixed(2)}`);
      console.log(`[ABSENCE] totals recalculated: hours=${totalHours.toFixed(2)} cost=${totalCosts.toFixed(2)}`);
    }

    const plannedRevenue = dailyBudgets[dateStr]?.plannedRevenue || 0;
    const actualRevenue  = dailyBudgets[dateStr]?.actualRevenue;
    // IST revenue preferred; fall back to planned revenue
    const revenueForMark = (actualRevenue !== undefined && actualRevenue > 0) ? actualRevenue : plannedRevenue;
    const laborCostPct = revenueForMark > 0 ? (totalCosts / revenueForMark * 100) : null;
    const maxAllowedCosts = revenueForMark > 0 ? revenueForMark * (LABOR_COST_THRESHOLD / 100) : 0;
    const excessCosts = Math.max(0, totalCosts - maxAllowedCosts);
    const isOverBudget = revenueForMark > 0 && totalCosts > maxAllowedCosts;
    const empsWithRate = employees.map(e => getEffectiveHourlyRate(e, socialCostRates) ?? 0).filter(r => r > 0);
    const avgWage = empsWithRate.length > 0 ? empsWithRate.reduce((s, r) => s + r, 0) / empsWithRate.length : 0;
    const excessHours = avgWage > 0 ? excessCosts / avgWage : 0;

    // Ampel: excessPct = how much over the allowed budget in %
    const excessPct = revenueForMark > 0 && maxAllowedCosts > 0
      ? ((totalCosts - maxAllowedCosts) / maxAllowedCosts) * 100
      : null;
    const markerStatus: 'none' | 'green' | 'yellow' | 'red' =
      excessPct === null ? 'none'
      : excessPct <= 0   ? 'green'
      : excessPct <= 5   ? 'yellow'
      : 'red';

    // Debug logs (only when there is IST data for the day)
    if (totalHours > 0 || revenueForMark > 0) {
      console.log(`[IST-DAY] date: ${dateStr}`);
      console.log(`[IST-DAY] ist revenue: ${revenueForMark}`);
      console.log(`[IST-DAY] ist hours: ${totalHours.toFixed(2)}`);
      console.log(`[IST-DAY] ist cost: ${totalCosts.toFixed(2)}`);
      console.log(`[IST-DAY] target pct: ${LABOR_COST_THRESHOLD}`);
      console.log(`[IST-DAY] allowed cost: ${maxAllowedCosts.toFixed(2)}`);
      console.log(`[IST-DAY] cost diff: ${(totalCosts - maxAllowedCosts).toFixed(2)}`);
      console.log(`[IST-DAY] approx extra hours: ${excessHours.toFixed(2)}`);
      console.log(`[IST-DAY] marker status: ${markerStatus}`);
    }

    return { totalHours, totalCosts, plannedRevenue, actualRevenue, laborCostPct, isOverBudget, excessCosts, excessHours, markerStatus, revenueForMark };
  };

  // Per-employee breakdown for a specific day (only productive entries, no absences)
  const getDayEmployeeBreakdown = (dateStr: string) => {
    return employees.map(emp => {
      const cellKey = `${emp.id}-${dateStr}`;
      const entry = actualHoursData[cellKey];
      const isAbsence = !!entry?.absenceType;
      const hours = (!isAbsence && entry?.hours) ? entry.hours : 0;
      const effRate = getEffectiveHourlyRate(emp, socialCostRates) ?? 0;
      const cost = hours * effRate;
      return { employee: emp, hours, cost, effRate };
    }).filter(e => e.hours > 0).sort((a, b) => b.cost - a.cost);
  };

  // Calculate ideal planning suggestions for a day
  const getIdealPlanSuggestions = (dateStr: string) => {
    const stats = getDailyStats(new Date(dateStr));
    if (!stats.isOverBudget) return [];
    const breakdown = getDayEmployeeBreakdown(dateStr);
    const targetTotalCosts = stats.plannedRevenue * (LABOR_COST_THRESHOLD / 100);
    let remainingExcess = stats.excessCosts;
    const suggestions: { employee: typeof employees[0]; currentHours: number; suggestedCut: number; saving: number }[] = [];
    for (const { employee, hours, cost } of breakdown) {
      if (remainingExcess <= 0) break;
      const empRate = getEffectiveHourlyRate(employee, socialCostRates) ?? 0;
      const maxCut = Math.min(hours, remainingExcess / (empRate || 1));
      const actualCut = Math.ceil(maxCut * 2) / 2; // round to 0.5h
      const saving = actualCut * (empRate || 0);
      if (actualCut > 0) {
        suggestions.push({ employee, currentHours: hours, suggestedCut: actualCut, saving });
        remainingExcess -= saving;
      }
    }
    return suggestions;
  };

  return (
    <>
    {/* ── Schnellerfassung-Toolbar ───────────────────────────────────────────── */}
    <div className={cn(
      "flex items-center gap-2 mb-2 px-2 py-1.5 rounded-lg border text-sm transition-colors",
      quickEntry
        ? quickEntry === 'FE'
          ? "bg-blue-50 border-blue-300 dark:bg-blue-950/40 dark:border-blue-700"
          : quickEntry === 'FT'
            ? "bg-violet-50 border-violet-300 dark:bg-violet-950/40 dark:border-violet-700"
            : quickEntry === 'K'
              ? "bg-red-50 border-red-300 dark:bg-red-950/40 dark:border-red-700"
              : "bg-slate-100 border-slate-300 dark:bg-slate-800/60 dark:border-slate-600"
        : "bg-muted/40 border-border"
    )}>
      <Zap className={cn(
        "h-3.5 w-3.5 shrink-0",
        quickEntry ? "text-amber-500" : "text-muted-foreground"
      )} />
      <span className="text-xs font-medium text-muted-foreground shrink-0">Schnellerfassung:</span>
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => toggleQuickEntry('FE')}
          className={cn(
            "px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all",
            quickEntry === 'FE'
              ? "bg-blue-500 text-white border-blue-500 shadow-sm"
              : "border-blue-300 text-blue-600 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950/40"
          )}
        >
          FE – Ferien
        </button>
        <button
          onClick={() => toggleQuickEntry('FT')}
          className={cn(
            "px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all",
            quickEntry === 'FT'
              ? "bg-violet-500 text-white border-violet-500 shadow-sm"
              : "border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-950/40"
          )}
        >
          FT – Feiertag
        </button>
        <button
          onClick={() => toggleQuickEntry('K')}
          className={cn(
            "px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all",
            quickEntry === 'K'
              ? "bg-red-500 text-white border-red-500 shadow-sm"
              : "border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
          )}
        >
          K – Krank
        </button>
        <button
          onClick={() => toggleQuickEntry('F')}
          className={cn(
            "px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all",
            quickEntry === 'F'
              ? "bg-slate-500 text-white border-slate-500 shadow-sm"
              : "border-slate-300 text-slate-500 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800/30"
          )}
        >
          F – Frei
        </button>
      </div>
      {quickEntry ? (
        <div className="flex items-center gap-1.5 ml-1">
          <span className={cn(
            "text-xs font-medium",
            quickEntry === 'FE' && "text-blue-700 dark:text-blue-400",
            quickEntry === 'FT' && "text-violet-700 dark:text-violet-400",
            quickEntry === 'K' && "text-red-700 dark:text-red-400",
            quickEntry === 'F' && "text-slate-600 dark:text-slate-400",
          )}>
            Aktiv – direkt auf Zellen klicken
          </span>
          <button
            onClick={() => setQuickEntry(null)}
            className="ml-1 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            title="Schnellerfassung beenden"
          >
            <X className="h-3 w-3 text-muted-foreground" />
          </button>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground italic">
          Typ wählen, dann Zellen anklicken
        </span>
      )}
    </div>

    <div className="overflow-auto max-h-[calc(100vh-280px)]">
      <div className={cn("min-w-max", isWeekView && "min-w-0")}>
        <table className={cn("w-full border-collapse", isWeekView && "table-fixed")}>
          <thead className="sticky top-0 z-30 bg-card">
            <tr className="bg-card">
              <th
                className={cn(
                  "sticky left-0 z-20 bg-card px-2 py-1 text-left text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}
              >
                Mitarbeiter
              </th>
              <th
                className={cn(
                  "sticky z-20 bg-card px-1 py-1 text-center text-xs font-semibold border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                )}
              >
                Ist-Std.
              </th>
              {days.map((day) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                const stats = getDailyStats(day);
                const dateStr = format(day, 'yyyy-MM-dd');
                const ms = stats.markerStatus;

                // Background based on Ampel status (takes priority over weekend colors)
                const headerBg =
                  ms === 'red'    ? "bg-red-100 dark:bg-red-900/30 hover:bg-red-200/80 dark:hover:bg-red-900/40"
                  : ms === 'yellow' ? "bg-amber-100 dark:bg-amber-900/20 hover:bg-amber-200/70 dark:hover:bg-amber-900/40"
                  : ms === 'green'  ? "bg-green-50 dark:bg-green-900/10 hover:bg-green-100/70 dark:hover:bg-green-900/20"
                  : isWeekendDay    ? "bg-amber-100 dark:bg-amber-900/30 hover:bg-amber-200/70 dark:hover:bg-amber-900/50"
                  : "hover:bg-muted/50";

                const textColor =
                  ms === 'red'    ? "text-red-700 dark:text-red-400"
                  : ms === 'yellow' ? "text-amber-700 dark:text-amber-500"
                  : ms === 'green'  ? "text-green-700 dark:text-green-400"
                  : isWeekendDay    ? "text-amber-700 dark:text-amber-400"
                  : "text-muted-foreground";

                return (
                  <th
                    key={day.toISOString()}
                    className={cn(
                      "px-1 py-1 text-center font-medium border-b transition-colors cursor-pointer",
                      "border-r border-border/50",
                      headerBg,
                      isSundayDay && ms === 'none' && "bg-amber-200/70 dark:bg-amber-900/50 border-r-2 border-r-primary/30",
                      isWeekView ? "min-w-[80px] text-xs" : "min-w-[60px] text-[10px]"
                    )}
                    onClick={() => {
                      if (onDayClick) {
                        onDayClick(day);
                      } else {
                        setShowIdealPlan(false);
                        setOpenDialogDay(dateStr);
                      }
                    }}
                    title={
                      ms === 'red'    ? "🔴 Ziel überschritten – Klicken für Details"
                      : ms === 'yellow' ? "🟡 Leicht über Ziel – Klicken für Details"
                      : ms === 'green'  ? "🟢 Im Ziel – Klicken für Details"
                      : "Klicken für Tagesdetails"
                    }
                  >
                    <div className={cn("text-[9px] font-semibold", textColor)}>
                      {WEEKDAY_NAMES[day.getDay()]}
                    </div>
                    <div className={cn("font-semibold text-[10px]", textColor)}>
                      {format(day, 'd.M.')}
                    </div>
                    {/* Ampel badge – always shown when there is revenue data */}
                    {ms === 'red' ? (
                      <div className="flex items-center justify-center gap-0.5 bg-red-200 dark:bg-red-900/60 border border-red-400 dark:border-red-700 rounded px-1 py-0.5 mt-0.5">
                        <AlertTriangle className="h-2.5 w-2.5 text-red-700 dark:text-red-400 shrink-0" />
                        <span className="text-[8px] font-bold text-red-700 dark:text-red-400">
                          +{stats.excessCosts.toFixed(0)}
                        </span>
                      </div>
                    ) : ms === 'yellow' ? (
                      <div className="flex items-center justify-center gap-0.5 bg-amber-200 dark:bg-amber-900/60 border border-amber-400 dark:border-amber-700 rounded px-1 py-0.5 mt-0.5">
                        <MinusIcon className="h-2.5 w-2.5 text-amber-700 dark:text-amber-400 shrink-0" />
                        <span className="text-[8px] font-bold text-amber-700 dark:text-amber-400">
                          +{stats.excessCosts.toFixed(0)}
                        </span>
                      </div>
                    ) : ms === 'green' ? (
                      <div className="flex items-center justify-center mt-0.5">
                        <CheckCircle2 className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
                      </div>
                    ) : stats.totalHours > 0 ? (
                      <div className="flex flex-col items-center mt-0.5">
                        <span className="text-[8px] text-green-600 dark:text-green-400 font-medium">
                          {stats.totalHours.toFixed(1)}h
                        </span>
                        {showCosts && (
                          <span className="text-[7px] text-muted-foreground">
                            {stats.totalCosts.toFixed(0)} CHF
                          </span>
                        )}
                      </div>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => {
              const actualHours = getEmployeeActualHours(employee.id);
              const targetHours = getTargetHours(employee);
              const percentage = Math.min((actualHours / targetHours) * 100, 100);
              const isInRange = percentage >= 90 && percentage <= 110;
              const isUnder = percentage < 90;

              return (
                <tr key={employee.id} className="group hover:bg-muted/30">
                  {/* Employee name */}
                  <td
                    className={cn(
                      "sticky left-0 z-10 bg-card px-2 py-1 text-xs border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                      isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                    )}
                  >
                    <div className="flex items-center gap-1 truncate">
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          employee.department === 'service' ? "bg-blue-500" : "bg-orange-500"
                        )}
                      />
                      <span className="truncate font-medium" title={getEmployeeDisplayName(employee)}>
                        {getEmployeeDisplayName(employee)}
                      </span>
                    </div>
                    <div className={`text-[9px] mt-0.5 ${getEffectiveHourlyRate(employee, socialCostRates) == null ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
                      {getWageLabel(employee, socialCostRates)}
                    </div>
                  </td>

                  {/* Hours summary */}
                  <td
                    className={cn(
                      "sticky z-10 bg-card px-1 py-1 text-center text-[10px] border-b border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                      isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                    )}
                  >
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="space-y-0.5">
                            <div className={cn(
                              "font-semibold",
                              isInRange && "text-green-600 dark:text-green-400",
                              isUnder && "text-amber-600 dark:text-amber-400",
                              !isInRange && !isUnder && "text-red-600 dark:text-red-400"
                            )}>
                              {actualHours.toFixed(1)}
                            </div>
                            <div className="text-[8px] text-muted-foreground">
                              / {targetHours.toFixed(0)}
                            </div>
                            <Progress
                              value={percentage}
                              className={cn(
                                "h-1",
                                isInRange && "[&>div]:bg-green-500",
                                isUnder && "[&>div]:bg-amber-500",
                                !isInRange && !isUnder && "[&>div]:bg-red-500"
                              )}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-xs">
                            <div>Ist: {actualHours.toFixed(1)}h</div>
                            <div>Soll: {targetHours.toFixed(1)}h</div>
                            <div>Diff: {(actualHours - targetHours).toFixed(1)}h</div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </td>

                  {/* Day cells */}
                  {days.map((day) => {
                    const dateStr = format(day, 'yyyy-MM-dd');
                    const cellKey = `${employee.id}-${dateStr}`;
                    const entry = actualHoursData[cellKey];

                    return (
                      <ActualHoursCell
                        key={dateStr}
                        employee={employee}
                        day={day}
                        entry={entry}
                        onSave={(newEntry) => onHoursChange(employee.id, dateStr, newEntry)}
                        showCosts={showCosts}
                        quickEntry={quickEntry}
                      />
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          
          {/* Footer with daily totals */}
          <tfoot>
            <tr className="bg-muted/50 border-t-2 border-border">
              {/* Total label */}
              <td
                className={cn(
                  "sticky left-0 z-10 bg-muted/80 px-2 py-2 text-xs font-bold border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "w-[110px] min-w-[110px] max-w-[110px]" : "w-[140px] min-w-[140px] max-w-[140px]"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-primary">Σ</span>
                  Tages-Summen
                </div>
              </td>
              
              {/* Total hours for all employees */}
              <td
                className={cn(
                  "sticky z-10 bg-muted/80 px-1 py-2 text-center text-[10px] font-bold border-r-2 border-border shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]",
                  isWeekView ? "left-[110px] w-[50px] min-w-[50px] max-w-[50px]" : "left-[140px] w-[60px] min-w-[60px] max-w-[60px]"
                )}
              >
                {(() => {
                  const grandTotalHours = days.reduce((sum, day) => {
                    const stats = getDailyStats(day);
                    return sum + stats.totalHours;
                  }, 0);
                  const grandTotalCosts = days.reduce((sum, day) => {
                    const stats = getDailyStats(day);
                    return sum + stats.totalCosts;
                  }, 0);
                  return (
                    <div className="space-y-0.5">
                      <div className="text-green-600 dark:text-green-400">
                        {grandTotalHours.toFixed(1)}h
                      </div>
                      {showCosts && (
                        <div className="text-[8px] text-muted-foreground">
                          {grandTotalCosts.toFixed(0)} CHF
                        </div>
                      )}
                    </div>
                  );
                })()}
              </td>
              
              {/* Daily totals */}
              {days.map((day) => {
                const isWeekendDay = isWeekend(day);
                const isSundayDay = isSunday(day);
                const stats = getDailyStats(day);
                
                return (
                  <td
                    key={`footer-${day.toISOString()}`}
                    className={cn(
                      "px-1 py-2 text-center text-xs font-semibold border-r",
                      isWeekendDay && "bg-amber-100/50 dark:bg-amber-900/20",
                      isSundayDay && "bg-amber-200/30 dark:bg-amber-900/30 border-r-2 border-r-primary/30",
                      stats.totalHours > 0 && "text-green-700 dark:text-green-400"
                    )}
                  >
                    {stats.totalHours > 0 ? (
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="font-bold">
                          {stats.totalHours.toFixed(1)}h
                        </span>
                        {showCosts && (
                          <span className="text-[9px] text-muted-foreground font-normal">
                            {stats.totalCosts.toFixed(0)} CHF
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    {/* ── Over-budget Ist Dialog ─────────────────────────────────────── */}
    {openDialogDay && showCosts && (() => {
      const stats = getDailyStats(new Date(openDialogDay));
      const breakdown = getDayEmployeeBreakdown(openDialogDay);
      const suggestions = getIdealPlanSuggestions(openDialogDay);
      const parsedDate = new Date(openDialogDay);
      const dateLabel = format(parsedDate, 'EEEE, d. MMMM yyyy', { locale: de });
      const totalSaving = suggestions.reduce((s, x) => s + x.saving, 0);

      return (
        <Dialog open={true} onOpenChange={() => { setOpenDialogDay(null); setShowIdealPlan(false); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="h-5 w-5" />
                Ist-Kostenübersicht: {dateLabel}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Actual overview */}
              <div className="rounded-lg bg-muted/50 p-3 space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tagesübersicht (Ist)</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Budgetierter Umsatz</span>
                  <span className="font-medium">CHF {stats.plannedRevenue.toFixed(0)}</span>
                  <span className="text-muted-foreground">Ist-Stunden total</span>
                  <span className="font-medium">{stats.totalHours.toFixed(1)} h</span>
                  <span className="text-muted-foreground">Ist-Kosten total</span>
                  <span className="font-medium">CHF {stats.totalCosts.toFixed(0)}</span>
                  <span className="text-muted-foreground">Personalkostenquote (PKQ)</span>
                  <span className="font-semibold text-red-600">
                    {stats.laborCostPct !== null ? `${stats.laborCostPct.toFixed(1)}%` : '–'}
                    <span className="text-xs font-normal text-muted-foreground ml-1">(Ziel: {LABOR_COST_THRESHOLD}%)</span>
                  </span>
                </div>
                <div className="border-t pt-2 mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-red-600 font-medium">Zu viel Kosten</span>
                  <span className="font-bold text-red-600">CHF {stats.excessCosts.toFixed(0)}</span>
                  <span className="text-red-600 font-medium">Zu viel Stunden (ca.)</span>
                  <span className="font-bold text-red-600">{stats.excessHours.toFixed(1)} h</span>
                </div>
              </div>

              {/* Employee breakdown */}
              {breakdown.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ist-Stunden nach Mitarbeiter</div>
                  {breakdown.map(({ employee, hours, cost, effRate }) => (
                    <div key={employee.id} className="flex items-center gap-2 text-xs">
                      <div className="flex-1 truncate">{getEmployeeDisplayName(employee)}</div>
                      <div className={`shrink-0 ${effRate === 0 ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
                        {hours.toFixed(1)}h × CHF {effRate > 0 ? effRate.toFixed(2) : '—'}
                        {effRate === 0 && ' (Lohn fehlt)'}
                      </div>
                      <div className="font-semibold shrink-0 w-20 text-right">
                        {effRate > 0 ? `CHF ${cost.toFixed(0)}` : <span className="text-red-500">—</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Ideal Plan section */}
              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide flex items-center gap-1">
                    <Lightbulb className="h-3.5 w-3.5" />
                    Ideale Planung
                  </div>
                  {!showIdealPlan && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-blue-300 text-blue-700 hover:bg-blue-100"
                      onClick={() => setShowIdealPlan(true)}
                    >
                      <TrendingDown className="h-3 w-3 mr-1" />
                      Sparvorschläge anzeigen
                    </Button>
                  )}
                </div>
                {showIdealPlan && suggestions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Um die PKQ-Ziel von {LABOR_COST_THRESHOLD}% zu erreichen, hätten folgende Anpassungen helfen können:
                    </p>
                    {suggestions.map(({ employee, currentHours, suggestedCut, saving }) => (
                      <div key={employee.id} className="bg-white dark:bg-card rounded p-2 border border-blue-200 dark:border-blue-700 text-xs space-y-0.5">
                        <div className="font-semibold">{getEmployeeDisplayName(employee)}</div>
                        <div className="text-muted-foreground">
                          Gearbeitet: {currentHours.toFixed(1)}h → Vorschlag: {(currentHours - suggestedCut).toFixed(1)}h
                          <span className="ml-2 text-[10px]">(−{suggestedCut.toFixed(1)}h)</span>
                        </div>
                        <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                          Einsparung: CHF {saving.toFixed(0)}
                        </div>
                      </div>
                    ))}
                    <div className="border-t pt-2 flex justify-between text-xs font-semibold">
                      <span>Gesamteinsparung</span>
                      <span className="text-emerald-600 dark:text-emerald-400">CHF {totalSaving.toFixed(0)}</span>
                    </div>
                  </div>
                )}
                {showIdealPlan && suggestions.length === 0 && (
                  <p className="text-xs text-muted-foreground">Keine konkreten Vorschläge verfügbar.</p>
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      );
    })()}
    </>
  );
};
