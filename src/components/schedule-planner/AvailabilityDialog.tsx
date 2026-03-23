/**
 * AvailabilityDialog
 * ─────────────────────────────────────────────────────────────────────────────
 * Zeigt pro Mitarbeiter die Verfügbarkeit für einen Monat an.
 * Planer können hier:
 *   - Wunschfrei (WF, amber) eintragen — soft-Anfrage
 *   - Gesperrte Tage (rot) markieren   — harter Block
 *   - Bestehende fixe freie Wochentage (daysOff) einsehen
 *
 * Klick auf ein Datum toggelt: normal → WF → Gesperrt → normal
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CalendarX2, ChevronLeft, ChevronRight, Info, Trash2, Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  format, getDaysInMonth, startOfMonth, getDay, addMonths, subMonths, isSameMonth,
} from 'date-fns';
import { de } from 'date-fns/locale';
import { Employee, DayOfWeek } from '@/types/personnel';
import {
  getAvailability,
  setAvailabilityStatus,
  clearMonthAvailability,
  DateAvailStatus,
  getDateStatus,
} from '@/lib/availability-store';
import { DEPT_BADGE_CLASS, DEPT_LABEL } from '@/lib/station-config';

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<DayOfWeek, number> = {
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4,
  freitag: 5, samstag: 6, sonntag: 0,
};

const STATUS_CONFIG: Record<DateAvailStatus | 'day-off', {
  label: string; shortLabel: string; bg: string; border: string; text: string;
}> = {
  'normal':         { label: 'Verfügbar',       shortLabel: '',   bg: '',                               border: '',                              text: '' },
  'requested-free': { label: 'Wunschfrei',       shortLabel: 'WF', bg: 'bg-amber-100 dark:bg-amber-900/40', border: 'border-amber-400 dark:border-amber-600', text: 'text-amber-800 dark:text-amber-300' },
  'blocked':        { label: 'Gesperrt',          shortLabel: '⛔', bg: 'bg-red-100 dark:bg-red-900/40',    border: 'border-red-400 dark:border-red-600',    text: 'text-red-800 dark:text-red-300' },
  'day-off':        { label: 'Fixer freier Tag',  shortLabel: 'F',  bg: 'bg-slate-200 dark:bg-slate-700',  border: 'border-slate-400 dark:border-slate-500', text: 'text-slate-600 dark:text-slate-300' },
};

// ─── Mini-Kalender für einen Mitarbeiter ──────────────────────────────────────

interface EmployeeCalendarProps {
  emp: Employee;
  month: Date;
  onStatusChange: () => void;
}

function EmployeeCalendar({ emp, month, onStatusChange }: EmployeeCalendarProps) {
  const [localState, setLocalState] = useState(0); // trigger re-render after change

  const refresh = useCallback(() => {
    setLocalState(s => s + 1);
    onStatusChange();
  }, [onStatusChange]);

  const year  = month.getFullYear();
  const mon   = month.getMonth() + 1; // 1-12
  const days  = getDaysInMonth(month);
  const first = startOfMonth(month);
  // Monday-first offset (0=Mon, 6=Sun)
  const startOffset = (getDay(first) + 6) % 7;

  // Fixed daysOff weekdays for this employee
  const fixedOffNums = useMemo(() =>
    (emp.daysOff ?? []).map(d => WEEKDAY_MAP[d]),
  [emp.daysOff]);

  const isFixedOff = (dayNum: number) =>
    fixedOffNums.includes((dayNum + 6) % 7 === 0 ? 0 : (dayNum + 6) % 7);

  // Get day-of-week (Mon=0 index)
  const dowOf = (day: number) => {
    const date = new Date(year, mon - 1, day);
    return (getDay(date) + 6) % 7; // 0=Mon, 6=Sun
  };

  const getStatus = (day: number): DateAvailStatus | 'day-off' => {
    const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const s = getDateStatus(emp.id, dateStr);
    if (s !== 'normal') return s;
    const jsDay = getDay(new Date(year, mon - 1, day)); // 0=Sun
    if (fixedOffNums.includes(jsDay)) return 'day-off';
    return 'normal';
  };

  const handleDayClick = (day: number) => {
    const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const current = getDateStatus(emp.id, dateStr);
    const next: DateAvailStatus =
      current === 'normal'         ? 'requested-free' :
      current === 'requested-free' ? 'blocked'         : 'normal';
    setAvailabilityStatus(emp.id, dateStr, next);
    refresh();
  };

  const handleClearMonth = () => {
    clearMonthAvailability(emp.id, year, mon);
    refresh();
  };

  // Count constraints this month
  const avail = getAvailability(emp.id);
  const prefix = `${year}-${String(mon).padStart(2, '0')}`;
  const monthWF = avail.requestedFreeDays.filter(d => d.startsWith(prefix)).length;
  const monthBlocked = avail.blockedDates.filter(d => d.startsWith(prefix)).length;
  const hasClear = monthWF > 0 || monthBlocked > 0;

  // Build calendar grid
  const cells: Array<{ day: number } | null> = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: days }, (_, i) => ({ day: i + 1 })),
  ];
  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void localState; // force re-render

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{emp.name}</span>
          <Badge variant="outline" className={cn('text-[10px] border', DEPT_BADGE_CLASS[emp.department])}>
            {DEPT_LABEL[emp.department]}
          </Badge>
          {monthWF > 0 && (
            <Badge variant="outline" className="text-[10px] border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              {monthWF} WF
            </Badge>
          )}
          {monthBlocked > 0 && (
            <Badge variant="outline" className="text-[10px] border-red-300 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {monthBlocked} ⛔
            </Badge>
          )}
        </div>
        {hasClear && (
          <button
            onClick={handleClearMonth}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-600 transition-colors"
            title="Alle Einschränkungen dieses Monats löschen"
          >
            <Trash2 className="h-3 w-3" />
            Monat leeren
          </button>
        )}
      </div>

      {/* Calendar grid */}
      <div className="select-none">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => (
            <div key={d} className="text-center text-[10px] text-muted-foreground font-medium py-0.5">{d}</div>
          ))}
        </div>
        {/* Day cells */}
        {Array.from({ length: cells.length / 7 }, (_, row) => (
          <div key={row} className="grid grid-cols-7 gap-0.5 mb-0.5">
            {cells.slice(row * 7, row * 7 + 7).map((cell, col) => {
              if (!cell) return <div key={col} />;
              const status = getStatus(cell.day);
              const cfg = STATUS_CONFIG[status];
              const isWeekend = dowOf(cell.day) >= 5; // Sa=5, So=6
              return (
                <button
                  key={col}
                  onClick={() => {
                    if (status === 'day-off') return; // can't override fixed off from here
                    handleDayClick(cell.day);
                  }}
                  title={cfg.label || `${cell.day}. – verfügbar`}
                  className={cn(
                    'relative w-full aspect-square flex items-center justify-center rounded text-[11px] font-medium transition-colors border',
                    status === 'normal' && !isWeekend && 'bg-muted/20 border-border/30 text-foreground hover:bg-muted/60',
                    status === 'normal' && isWeekend && 'bg-muted/40 border-border/30 text-muted-foreground hover:bg-muted/70',
                    status === 'day-off' && cn(cfg.bg, cfg.border, cfg.text, 'cursor-default opacity-70'),
                    status === 'requested-free' && cn(cfg.bg, cfg.border, cfg.text, 'hover:opacity-80'),
                    status === 'blocked' && cn(cfg.bg, cfg.border, cfg.text, 'hover:opacity-80'),
                  )}
                >
                  {cell.day}
                  {cfg.shortLabel && (
                    <span className="absolute top-0 right-0 text-[7px] font-bold leading-none pr-0.5 pt-0.5">
                      {cfg.shortLabel}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Fixed daysOff legend if any */}
      {emp.daysOff && emp.daysOff.length > 0 && (
        <p className="text-[10px] text-muted-foreground leading-tight">
          Fixe freie Tage: <strong>{emp.daysOff.map(d => {
            const map: Record<DayOfWeek, string> = {
              montag: 'Mo', dienstag: 'Di', mittwoch: 'Mi', donnerstag: 'Do',
              freitag: 'Fr', samstag: 'Sa', sonntag: 'So',
            };
            return map[d];
          }).join(', ')}</strong> (werden im Dienstplan als «F» angezeigt)
        </p>
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  initialMonth?: Date;
}

// ─── Hauptdialog ─────────────────────────────────────────────────────────────

export function AvailabilityDialog({ open, onClose, employees, initialMonth }: Props) {
  const [month, setMonth] = useState<Date>(initialMonth ?? new Date());
  const [filter, setFilter] = useState<'all' | 'service' | 'küche'>('all');
  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => { if (open) setSearch(''); }, [open]);

  const filteredEmployees = useMemo(() =>
    employees
      .filter(e => filter === 'all' || e.department === filter)
      .filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'de')),
  [employees, filter, search]);

  const monthLabel = format(month, 'MMMM yyyy', { locale: de });

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-3xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarX2 className="h-5 w-5 text-teal-500" />
            Verfügbarkeit & Wunschfrei
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Klicke auf einen Tag: normal → Wunschfrei (WF) → Gesperrt (⛔) → normal
          </DialogDescription>
        </DialogHeader>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded border border-amber-400 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-600 font-semibold">WF</span>
            <span className="text-muted-foreground">Wunschfrei — Planer sieht Warnung, Einplanung möglich</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded border border-red-400 bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 dark:border-red-600 font-semibold">⛔</span>
            <span className="text-muted-foreground">Gesperrt — Einplanung erfordert ausdrückliche Bestätigung</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded border border-slate-400 bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-500 font-semibold">F</span>
            <span className="text-muted-foreground">Fixer freier Tag (Wochentag-Muster)</span>
          </div>
        </div>

        {/* Month nav + filters */}
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setMonth(m => subMonths(m, 1))} className="p-1.5 rounded border hover:bg-muted transition-colors">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-semibold min-w-[130px] text-center">{monthLabel}</span>
          <button onClick={() => setMonth(m => addMonths(m, 1))} className="p-1.5 rounded border hover:bg-muted transition-colors">
            <ChevronRight className="h-4 w-4" />
          </button>
          <div className="flex gap-1 ml-2">
            {(['all', 'service', 'küche'] as const).map(d => (
              <button
                key={d}
                onClick={() => setFilter(d)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                  filter === d
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
                )}
              >
                {d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche'}
              </button>
            ))}
          </div>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Name suchen…"
            className="h-7 text-sm flex-1 max-w-[200px]"
          />
        </div>

        {/* Info box */}
        <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-2.5 text-[10px] text-muted-foreground shrink-0">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Einmalig-Klick = <strong>Wunschfrei</strong> (WF). Nochmal-Klick = <strong>Gesperrt</strong>. Dritter Klick = wieder frei.
            Diese Angaben gelten pro Datum, unabhängig von den fixen Wochentag-Freien.
            Im Dienstplan erscheinen WF-Tage amber, gesperrte Tage rot.
          </span>
        </div>

        {/* Employee list */}
        <div className="overflow-y-auto flex-1 min-h-0 space-y-3 pr-0.5">
          {filteredEmployees.length === 0 ? (
            <div className="text-center py-8">
              <Users className="h-8 w-8 text-muted-foreground mx-auto opacity-30 mb-2" />
              <p className="text-sm text-muted-foreground">Keine Mitarbeitenden gefunden</p>
            </div>
          ) : (
            filteredEmployees.map(emp => (
              <EmployeeCalendar
                key={`${emp.id}-${month.toISOString().slice(0, 7)}`}
                emp={emp}
                month={month}
                onStatusChange={() => setTick(t => t + 1)}
              />
            ))
          )}
        </div>

        <div className="flex justify-between items-center pt-2 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            {tick > 0 ? `${tick} Änderung${tick !== 1 ? 'en' : ''} gespeichert` : 'Änderungen werden sofort lokal gespeichert'}
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
