/**
 * „Nächste Schicht“ einer Person für die Mitarbeiterseite.
 * Reine Logik über den veröffentlichten Wochen (WeekPayload). Schichten, die heute schon
 * zu Ende sind, zählen nicht mehr; Abwesenheiten sind keine Schichten.
 */
import { format } from 'date-fns';
import type { PublicDay, WeekPayload } from '@/lib/schedule-publish-payload';

export interface NextShift {
  /** yyyy-MM-dd */
  date: string;
  /** Wochenstart (Montag, yyyy-MM-dd) der Woche, in der die Schicht liegt */
  weekStart: string;
  /** Noch offene Schichten des Tages, z. B. „17:00 – 23:00“ */
  times: string[];
  isToday: boolean;
}

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Ende der Schicht in Minuten seit Tagesbeginn; Nachtschichten (Ende ≤ Start) laufen über Mitternacht. */
function endMinutes(start: string, end: string): number | null {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null) return null;
  return e <= s ? e + 24 * 60 : e;
}

function openShifts(day: PublicDay, isToday: boolean, nowMin: number): string[] {
  const out: string[] = [];
  for (const slot of [day.früh, day.spät]) {
    if (!slot) continue;
    if (isToday) {
      const end = endMinutes(slot.start, slot.end);
      if (end !== null && end <= nowMin) continue; // heute schon vorbei
    }
    out.push(`${slot.start} – ${slot.end}`);
  }
  return out;
}

export function nextShiftFor(weeks: WeekPayload[], name: string, now: Date): NextShift | null {
  if (!name) return null;
  const todayKey = format(now, 'yyyy-MM-dd');
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let best: NextShift | null = null;
  for (const w of weeks) {
    for (const emp of w.employees) {
      if (emp.name !== name) continue;
      for (const day of emp.days) {
        if (day.date < todayKey) continue;
        if (best && day.date >= best.date) continue;
        const times = openShifts(day, day.date === todayKey, nowMin);
        if (times.length > 0) {
          best = { date: day.date, weekStart: w.weekStart, times, isToday: day.date === todayKey };
        }
      }
    }
  }
  return best;
}
