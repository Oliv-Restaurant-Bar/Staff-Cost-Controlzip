import { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isToday, isBefore, startOfDay, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { Sun, Moon, Users } from 'lucide-react';

interface GroupReservation {
  id: string;
  date: string;
  shift: 'mittag' | 'abend';
  guest_count: number;
}

interface EmailReservation {
  id: string;
  date: string;
  time: string;
  guest_count: number;
}

interface CapacitySettings {
  mittag_capacity: number;
  abend_capacity: number;
  u1_capacity: number;
  u1_days: number[];
}

interface MonthlyAvailabilityListProps {
  currentMonth: Date;
  reservations: GroupReservation[];
  emailReservations: EmailReservation[];
  capacitySettings?: CapacitySettings;
}

const capacityColor = (pct: number) => {
  if (pct === 0) return 'text-muted-foreground';
  if (pct < 40) return 'text-emerald-600';
  if (pct < 70) return 'text-amber-600';
  if (pct < 90) return 'text-orange-600';
  return 'text-red-600';
};

const barColor = (pct: number) => {
  if (pct === 0) return 'bg-muted/40';
  if (pct < 40) return 'bg-emerald-500';
  if (pct < 70) return 'bg-amber-500';
  if (pct < 90) return 'bg-orange-500';
  return 'bg-red-500';
};

export const MonthlyAvailabilityList = ({
  currentMonth,
  reservations,
  emailReservations,
  capacitySettings,
}: MonthlyAvailabilityListProps) => {
  const MITTAG_CAPACITY = capacitySettings?.mittag_capacity ?? 80;
  const ABEND_STANDARD = capacitySettings?.abend_capacity ?? 80;
  const ABEND_U1 = capacitySettings?.u1_capacity ?? 80;
  const U1_DAYS = capacitySettings?.u1_days ?? [5, 6];

  const getAbendCap = (day: Date) => {
    const dow = getDay(day);
    return U1_DAYS.includes(dow) ? ABEND_STANDARD + ABEND_U1 : ABEND_STANDARD;
  };
  const days = useMemo(() => {
    const start = startOfMonth(currentMonth);
    const end = endOfMonth(currentMonth);
    return eachDayOfInterval({ start, end });
  }, [currentMonth]);

  // Pre-compute booked counts per date/shift
  const booked = useMemo(() => {
    const map: Record<string, { mittag: number; abend: number }> = {};

    const init = (d: string) => {
      if (!map[d]) map[d] = { mittag: 0, abend: 0 };
    };

    reservations.forEach((r) => {
      init(r.date);
      map[r.date][r.shift] += r.guest_count;
    });

    emailReservations.forEach((r) => {
      init(r.date);
      const hours = parseInt(r.time.split(':')[0], 10);
      const shift = hours < 15 ? 'mittag' : 'abend';
      map[r.date][shift] += r.guest_count;
    });

    return map;
  }, [reservations, emailReservations]);

  const today = startOfDay(new Date());

  return (
    <div className="mt-4 pt-3 border-t">
      <div className="flex items-center gap-2 mb-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Freie Plätze – {format(currentMonth, 'MMMM yyyy', { locale: de })}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
        {days.map((day) => {
          const dateStr = format(day, 'yyyy-MM-dd');
          const b = booked[dateStr] || { mittag: 0, abend: 0 };
          const abendCap = getAbendCap(day);
          const mittagFree = Math.max(MITTAG_CAPACITY - b.mittag, 0);
          const abendFree = Math.max(abendCap - b.abend, 0);
          const mittagPct = Math.min(Math.round((b.mittag / MITTAG_CAPACITY) * 100), 100);
          const abendPct = Math.min(Math.round((b.abend / abendCap) * 100), 100);
          const isPast = isBefore(day, today);
          const isDayToday = isToday(day);
          const dow = getDay(day);
          const isWeekend = dow === 0 || dow === 6;

          return (
            <div
              key={dateStr}
              className={cn(
                'flex items-center gap-2 px-2 py-1 rounded text-xs',
                isPast && !isDayToday && 'opacity-40',
                isDayToday && 'ring-1 ring-primary bg-primary/5',
                isWeekend && !isDayToday && 'bg-muted/30'
              )}
            >
              {/* Date label */}
              <span className={cn('w-16 shrink-0 font-medium', isDayToday && 'text-primary')}>
                {format(day, 'EEE d.', { locale: de })}
              </span>

              {/* Mittag */}
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <Sun className="h-3 w-3 text-amber-500 shrink-0" />
                <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                  <div className={cn('h-full rounded-full', barColor(mittagPct))} style={{ width: `${mittagPct}%` }} />
                </div>
                <span className={cn('w-8 text-right tabular-nums', capacityColor(mittagPct))}>
                  {mittagFree}
                </span>
              </div>

              {/* Abend */}
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <Moon className="h-3 w-3 text-indigo-500 shrink-0" />
                <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                  <div className={cn('h-full rounded-full', barColor(abendPct))} style={{ width: `${abendPct}%` }} />
                </div>
                <span className={cn('w-8 text-right tabular-nums', capacityColor(abendPct))}>
                  {abendFree}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 text-center">
        Zahlen = freie Plätze · Mittag {MITTAG_CAPACITY} · Abend {ABEND_STANDARD}{U1_DAYS.length > 0 ? ` (${U1_DAYS.map(d => ['So','Mo','Di','Mi','Do','Fr','Sa'][d]).join('+')} ${ABEND_STANDARD + ABEND_U1} inkl. U1)` : ''}
      </p>
    </div>
  );
};
