import { useParams } from 'react-router-dom';
import { format, startOfWeek, addDays, getISOWeek } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Calendar, Clock } from 'lucide-react';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

interface MockShift {
  start: string;
  end: string;
}
interface MockEmployee {
  name: string;
  department: 'service' | 'küche';
  shifts: (MockShift | 'FE' | 'F' | null)[];
}

function deriveWeekFromToken(token: string): Date {
  const parts = token.split('-');
  if (parts.length >= 2) {
    const yearMonth = parts[1];
    if (yearMonth && yearMonth.length === 6) {
      const year = parseInt(yearMonth.slice(0, 4), 10);
      const month = parseInt(yearMonth.slice(4, 6), 10) - 1;
      if (!isNaN(year) && !isNaN(month)) {
        return startOfWeek(new Date(year, month, 1), { weekStartsOn: 1 });
      }
    }
  }
  return startOfWeek(new Date(), { weekStartsOn: 1 });
}

function deriveRestaurantFromToken(token: string): string {
  if (token.startsWith('beaulieu')) return 'Beaulieu';
  return 'Oliv';
}

const MOCK_EMPLOYEES: MockEmployee[] = [
  {
    name: 'Anna Müller',
    department: 'service',
    shifts: [
      { start: '08:00', end: '16:00' },
      { start: '12:00', end: '20:00' },
      null,
      { start: '08:00', end: '16:00' },
      { start: '08:00', end: '16:00' },
      { start: '10:00', end: '18:00' },
      null,
    ],
  },
  {
    name: 'Thomas Berger',
    department: 'service',
    shifts: [
      null,
      { start: '12:00', end: '22:00' },
      { start: '12:00', end: '22:00' },
      { start: '12:00', end: '22:00' },
      null,
      { start: '12:00', end: '22:00' },
      { start: '12:00', end: '22:00' },
    ],
  },
  {
    name: 'Sophie Wagner',
    department: 'service',
    shifts: [
      { start: '09:00', end: '17:00' },
      null,
      { start: '09:00', end: '17:00' },
      null,
      { start: '09:00', end: '17:00' },
      'FE',
      'FE',
    ],
  },
  {
    name: 'Marco Rossi',
    department: 'küche',
    shifts: [
      { start: '07:00', end: '15:00' },
      { start: '07:00', end: '15:00' },
      null,
      { start: '07:00', end: '15:00' },
      { start: '07:00', end: '15:00' },
      { start: '07:00', end: '13:00' },
      null,
    ],
  },
  {
    name: 'Lisa Keller',
    department: 'küche',
    shifts: [
      null,
      { start: '11:00', end: '20:00' },
      { start: '11:00', end: '20:00' },
      { start: '11:00', end: '20:00' },
      null,
      { start: '11:00', end: '20:00' },
      { start: '11:00', end: '20:00' },
    ],
  },
  {
    name: 'David Schmid',
    department: 'küche',
    shifts: [
      { start: '08:00', end: '16:00' },
      'F',
      { start: '08:00', end: '16:00' },
      { start: '08:00', end: '16:00' },
      { start: '08:00', end: '16:00' },
      null,
      null,
    ],
  },
];

function ShiftChip({ shift }: { shift: MockShift | 'FE' | 'F' | null }) {
  if (!shift) {
    return <span className="text-muted-foreground/30 text-xs">–</span>;
  }
  if (shift === 'FE') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-700">
        Ferien
      </span>
    );
  }
  if (shift === 'F') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
        Frei
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-primary/10 text-primary border border-primary/20 tabular-nums whitespace-nowrap">
      <Clock className="h-2.5 w-2.5 shrink-0" />
      {shift.start}–{shift.end}
    </span>
  );
}

const StaffSchedulePage = () => {
  const { token } = useParams<{ token: string }>();

  const weekStart = deriveWeekFromToken(token ?? '');
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const kw = getISOWeek(weekStart);
  const restaurantName = deriveRestaurantFromToken(token ?? '');
  const weekLabel = `KW ${kw} · ${format(weekStart, 'd. MMM', { locale: de })} – ${format(weekDays[6], 'd. MMM yyyy', { locale: de })}`;

  const serviceEmps = MOCK_EMPLOYEES.filter(e => e.department === 'service');
  const kücheEmps = MOCK_EMPLOYEES.filter(e => e.department === 'küche');

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border px-4 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary mb-0.5">{restaurantName}</p>
            <h1 className="text-xl font-bold text-foreground">Dienstplan</h1>
            <div className="flex items-center gap-1.5 mt-1">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{weekLabel}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Nur zur Ansicht</p>
            <p className="text-[10px] text-muted-foreground/40 mt-0.5">Keine Lohnangaben</p>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">

        {/* Day header bar */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left py-2 px-3 w-40 text-xs font-semibold text-muted-foreground border-b-2 border-border">
                  Mitarbeiter
                </th>
                {weekDays.map((day, i) => {
                  const isWeekend = i >= 5;
                  return (
                    <th
                      key={i}
                      className={cn(
                        "text-center py-2 px-1 border-b-2 border-border",
                        isWeekend ? "bg-amber-50/60 dark:bg-amber-950/20 border-b-amber-300 dark:border-b-amber-700" : "border-b-border"
                      )}
                    >
                      <div className={cn(
                        "text-[10px] font-semibold uppercase tracking-wide",
                        isWeekend ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                      )}>
                        {WEEKDAYS[i]}
                      </div>
                      <div className={cn(
                        "text-base font-bold mt-0.5",
                        isWeekend ? "text-amber-700 dark:text-amber-400" : "text-foreground"
                      )}>
                        {format(day, 'd')}
                      </div>
                      <div className="text-[10px] text-muted-foreground/60">
                        {format(day, 'MMM', { locale: de })}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            {/* Service */}
            <tbody>
              <tr>
                <td colSpan={8} className="pt-4 pb-1 px-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">Service</span>
                  </div>
                </td>
              </tr>
              {serviceEmps.map((emp, ei) => (
                <tr
                  key={ei}
                  className={cn(
                    "border-t border-border/40",
                    ei % 2 === 0 ? "bg-background" : "bg-muted/20"
                  )}
                >
                  <td className="py-2 px-3 font-medium text-sm whitespace-nowrap">
                    {emp.name}
                  </td>
                  {emp.shifts.map((shift, di) => {
                    const isWeekend = di >= 5;
                    return (
                      <td
                        key={di}
                        className={cn(
                          "py-2 px-1 text-center",
                          isWeekend && "bg-amber-50/30 dark:bg-amber-950/10"
                        )}
                      >
                        <ShiftChip shift={shift} />
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* Küche */}
              <tr>
                <td colSpan={8} className="pt-5 pb-1 px-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-orange-600 dark:text-orange-400">Küche</span>
                  </div>
                </td>
              </tr>
              {kücheEmps.map((emp, ei) => (
                <tr
                  key={ei}
                  className={cn(
                    "border-t border-border/40",
                    ei % 2 === 0 ? "bg-background" : "bg-muted/20"
                  )}
                >
                  <td className="py-2 px-3 font-medium text-sm whitespace-nowrap">
                    {emp.name}
                  </td>
                  {emp.shifts.map((shift, di) => {
                    const isWeekend = di >= 5;
                    return (
                      <td
                        key={di}
                        className={cn(
                          "py-2 px-1 text-center",
                          isWeekend && "bg-amber-50/30 dark:bg-amber-950/10"
                        )}
                      >
                        <ShiftChip shift={shift} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="flex items-center flex-wrap gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Legende</p>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-semibold bg-primary/10 text-primary border border-primary/20">
              <Clock className="h-2.5 w-2.5" />08:00–16:00
            </span>
            <span className="text-[10px] text-muted-foreground">Schichtzeit</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 border border-blue-200">FE</span>
            <span className="text-[10px] text-muted-foreground">Ferien</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">F</span>
            <span className="text-[10px] text-muted-foreground">Frei</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/30 text-xs">–</span>
            <span className="text-[10px] text-muted-foreground">Kein Dienst</span>
          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-8 px-4 py-4 text-center">
        <p className="text-[10px] text-muted-foreground/50">
          {restaurantName} · Personalkostentracker · Dienstplan {weekLabel}
        </p>
        <p className="text-[9px] text-muted-foreground/30 mt-0.5">
          Dieser Link ist nur zur Ansicht · Keine vertraulichen Kostendaten enthalten
        </p>
      </footer>
    </div>
  );
};

export default StaffSchedulePage;
