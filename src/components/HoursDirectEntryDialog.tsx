/**
 * HoursDirectEntryDialog
 * ======================
 * Direkte Ist-Stunden-Eingabe — Tabelle Mitarbeiter × Wochentage.
 *
 * - Wochennavigation (Mo–So)
 * - Pro Mitarbeiter eine Zeile, pro Tag eine Zahlen-Zelle
 * - Liest/schreibt direkt in localStorage (selbes Format wie SchedulePlanner)
 * - Löst 'schedule-updated' Event aus, damit SchedulePlanner reagiert
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ChevronLeft, ChevronRight, PenLine, Save, CheckCircle2,
} from 'lucide-react';
import { Employee } from '@/types/personnel';
import {
  format, startOfWeek, endOfWeek, eachDayOfInterval, addWeeks, subWeeks,
  isSameMonth, getISOWeek,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface HoursDirectEntryDialogProps {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  selectedDate: Date;
}

type DeptFilter = 'all' | 'service' | 'küche';

interface HourCell {
  hours: string;
  dirty: boolean;
}

function makeKey(empId: string, date: string) { return `${empId}-${date}`; }
function monthKey(date: Date) { return format(date, 'yyyy-MM'); }

function loadActualHours(date: Date): Record<string, { hours: number; start?: string; end?: string }> {
  try { return JSON.parse(localStorage.getItem(`actual-hours-${monthKey(date)}`) ?? '{}'); }
  catch { return {}; }
}

function saveActualHours(date: Date, data: Record<string, { hours: number; start?: string; end?: string }>) {
  localStorage.setItem(`actual-hours-${monthKey(date)}`, JSON.stringify(data));
  window.dispatchEvent(new CustomEvent('schedule-updated'));
}

export function HoursDirectEntryDialog({
  open, onClose, employees, selectedDate,
}: HoursDirectEntryDialogProps) {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(selectedDate, { weekStartsOn: 1 })
  );
  const [dept, setDept]       = useState<DeptFilter>('all');
  const [cells, setCells]     = useState<Record<string, HourCell>>({});
  const [saved, setSaved]     = useState(false);

  const days = eachDayOfInterval({
    start: weekStart,
    end:   endOfWeek(weekStart, { weekStartsOn: 1 }),
  });

  const visibleEmployees = employees.filter(e =>
    dept === 'all' ? true : e.department === dept
  );

  // Load existing values from localStorage when dialog opens or week changes
  const loadCells = useCallback(() => {
    const existing: Record<string, HourCell> = {};
    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const mk      = format(day, 'yyyy-MM');
      let stored: Record<string, { hours: number }> = {};
      try { stored = JSON.parse(localStorage.getItem(`actual-hours-${mk}`) ?? '{}'); }
      catch { /* empty */ }
      for (const emp of employees) {
        const key = makeKey(emp.id, dateStr);
        const val = stored[key];
        existing[key] = {
          hours: val?.hours != null && val.hours > 0 ? String(val.hours) : '',
          dirty: false,
        };
      }
    }
    setCells(existing);
    setSaved(false);
  }, [weekStart, employees]);

  useEffect(() => {
    if (open) loadCells();
  }, [open, loadCells]);

  const handleChange = (empId: string, dateStr: string, val: string) => {
    const key = makeKey(empId, dateStr);
    setCells(prev => ({ ...prev, [key]: { hours: val, dirty: true } }));
    setSaved(false);
  };

  const handleSave = () => {
    // Collect all months touched by this week
    const monthsAffected = new Set(days.map(d => format(d, 'yyyy-MM')));
    const byMonth: Record<string, Record<string, { hours: number; start?: string; end?: string }>> = {};
    for (const mk of monthsAffected) {
      try { byMonth[mk] = JSON.parse(localStorage.getItem(`actual-hours-${mk}`) ?? '{}'); }
      catch { byMonth[mk] = {}; }
    }

    let count = 0;
    for (const day of days) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const mk      = format(day, 'yyyy-MM');
      for (const emp of employees) {
        const key  = makeKey(emp.id, dateStr);
        const cell = cells[key];
        if (!cell || !cell.dirty) continue;

        const num = parseFloat(cell.hours.replace(',', '.'));
        if (isNaN(num) || num < 0) {
          // Delete entry
          delete byMonth[mk][key];
        } else if (num === 0) {
          delete byMonth[mk][key];
        } else {
          byMonth[mk][key] = { hours: num };
          count++;
        }
      }
    }

    for (const [mk, data] of Object.entries(byMonth)) {
      localStorage.setItem(`actual-hours-${mk}`, JSON.stringify(data));
    }
    window.dispatchEvent(new CustomEvent('schedule-updated'));

    setSaved(true);
    toast.success(`${count} Ist-Stunden gespeichert`);
    // mark all as not-dirty after save
    setCells(prev => {
      const updated = { ...prev };
      for (const key of Object.keys(updated)) {
        updated[key] = { ...updated[key], dirty: false };
      }
      return updated;
    });
    setTimeout(() => setSaved(false), 3000);
  };

  const dirtyCount = Object.values(cells).filter(c => c.dirty).length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5 text-primary" />
            Ist-Stunden direkt erfassen
          </DialogTitle>
        </DialogHeader>

        {/* Controls */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Week navigation */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(d => subWeeks(d, 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[180px] text-center">
              KW {getISOWeek(weekStart)} — {format(weekStart, 'dd.MM.')} – {format(endOfWeek(weekStart, { weekStartsOn: 1 }), 'dd.MM.yyyy')}
            </span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(d => addWeeks(d, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Dept filter */}
          <div className="flex items-center gap-2">
            <Select value={dept} onValueChange={v => setDept(v as DeptFilter)}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Abteilungen</SelectItem>
                <SelectItem value="service">Service</SelectItem>
                <SelectItem value="küche">Küche</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Hint */}
        <p className="text-xs text-muted-foreground">
          Trage die tatsächlich geleisteten Stunden pro Mitarbeiter und Tag ein. Leere Felder = kein Eintrag. Änderungen werden erst nach "Speichern" übernommen.
        </p>

        {/* Grid */}
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background z-10 min-w-[160px]">Mitarbeiter</TableHead>
                <TableHead className="w-16 text-center text-xs">Abt.</TableHead>
                {days.map(day => (
                  <TableHead key={day.toISOString()} className={cn(
                    'text-center min-w-[72px]',
                    !isSameMonth(day, selectedDate) ? 'text-muted-foreground/40' : '',
                  )}>
                    <div className="text-xs font-medium">{format(day, 'EEE', { locale: de })}</div>
                    <div className="text-xs text-muted-foreground">{format(day, 'dd.MM.')}</div>
                  </TableHead>
                ))}
                <TableHead className="text-right min-w-[60px]">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleEmployees.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={days.length + 3} className="text-center text-muted-foreground py-8">
                    Keine Mitarbeiter gefunden
                  </TableCell>
                </TableRow>
              ) : visibleEmployees.map(emp => {
                // compute row total from current cells
                const rowTotal = days.reduce((sum, day) => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  const val = cells[makeKey(emp.id, dateStr)]?.hours ?? '';
                  const num = parseFloat(val.replace(',', '.'));
                  return sum + (isNaN(num) ? 0 : num);
                }, 0);

                return (
                  <TableRow key={emp.id}>
                    <TableCell className="sticky left-0 bg-background z-10 font-medium text-sm">
                      {emp.firstName} {emp.lastName}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] px-1 py-0',
                          emp.department === 'küche'
                            ? 'border-orange-200 text-orange-700 bg-orange-50'
                            : 'border-blue-200 text-blue-700 bg-blue-50',
                        )}
                      >
                        {emp.department === 'küche' ? 'K' : 'S'}
                      </Badge>
                    </TableCell>
                    {days.map(day => {
                      const dateStr = format(day, 'yyyy-MM-dd');
                      const key     = makeKey(emp.id, dateStr);
                      const cell    = cells[key] ?? { hours: '', dirty: false };
                      return (
                        <TableCell key={dateStr} className="p-1">
                          <Input
                            type="number"
                            min="0"
                            max="24"
                            step="0.25"
                            placeholder="—"
                            value={cell.hours}
                            onChange={e => handleChange(emp.id, dateStr, e.target.value)}
                            className={cn(
                              'h-8 w-16 text-center text-sm px-1',
                              cell.dirty ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/20' : '',
                              cell.hours && !cell.dirty ? 'bg-green-50 dark:bg-green-950/20' : '',
                            )}
                          />
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right text-sm font-semibold tabular-nums">
                      {rowTotal > 0 ? `${rowTotal.toFixed(1)} h` : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {dirtyCount > 0
              ? <span className="text-amber-600 font-medium">{dirtyCount} ungespeicherte Änderungen</span>
              : <span>Keine Änderungen</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Schliessen</Button>
            <Button onClick={handleSave} disabled={dirtyCount === 0} variant={saved ? 'outline' : 'default'}>
              {saved
                ? <><CheckCircle2 className="h-4 w-4 mr-1.5 text-green-600" />Gespeichert</>
                : <><Save className="h-4 w-4 mr-1.5" />Speichern ({dirtyCount})</>}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
