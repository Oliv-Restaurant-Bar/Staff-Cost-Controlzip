/**
 * Dienstplan veröffentlichen — reine Logik (kein I/O).
 * Baut die öffentliche Wochen-Payload, erkennt Änderungen gegenüber der letzten
 * Veröffentlichung und erzeugt die WhatsApp-Nachricht.
 *
 * Enthält bewusst KEINE Löhne/Kosten — nur Anzeigename, Schichten, Abwesenheiten.
 */
import { addDays, format, getISOWeek, startOfWeek } from 'date-fns';

export type ShareDepartment = 'service' | 'kueche';

export const SHARE_DEPARTMENT_LABEL: Record<ShareDepartment, string> = {
  service: 'Service',
  kueche: 'Küche',
};

export interface PublicSlot {
  start: string;
  end: string;
}

export interface PublicDay {
  date: string; // yyyy-MM-dd
  früh: PublicSlot | null;
  spät: PublicSlot | null;
  frühAbsence: string | null;
  spätAbsence: string | null;
  /** Seit der vorherigen Veröffentlichung geändert */
  changed?: boolean;
  previousFrüh?: PublicSlot | null;
  previousSpät?: PublicSlot | null;
}

export interface PublicEmployee {
  id: string;
  name: string;
  days: PublicDay[];
}

export interface WeekPayload {
  version: 1;
  department: ShareDepartment;
  weekStart: string; // yyyy-MM-dd (Montag)
  weekEnd: string; // yyyy-MM-dd (Sonntag)
  kw: number;
  employees: PublicEmployee[];
}

export type PublishStatus = 'draft' | 'published' | 'changed';

/** Minimale Sicht auf die Planer-Typen (Employee / DaySchedule). */
export interface ShareSourceEmployee {
  id: string;
  name?: string | null;
  display_name?: string | null;
  department: 'service' | 'küche' | 'kueche';
}

export interface ShareSourceDay {
  früh?: { start: string; end: string } | null;
  spät?: { start: string; end: string } | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
}

const DATE_FMT = 'yyyy-MM-dd';

function normSlot(slot: { start: string; end: string } | null | undefined): PublicSlot | null {
  if (!slot || !slot.start || !slot.end) return null;
  return { start: slot.start, end: slot.end };
}

/**
 * Abwesenheiten werden nur grob veröffentlicht. Krankheit (K) und Unfall (U) —
 * und alles Unbekannte — erscheinen als "Abwesend": der Link ist weiterleitbar und
 * zeigt die ganze Abteilung, Gesundheitsdaten gehören nicht hinein.
 * Die DB-Funktion schedule_share_validate_payload erlaubt exakt diese vier Texte.
 */
const PUBLIC_ABSENCE: Record<string, string> = { FE: 'Ferien', FT: 'Feiertag', F: 'Frei' };

export function toPublicAbsence(code: string | null | undefined): string | null {
  const t = code?.trim();
  if (!t) return null;
  return PUBLIC_ABSENCE[t.toUpperCase()] ?? 'Abwesend';
}

function sameSlot(a: PublicSlot | null, b: PublicSlot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

function sameDay(a: PublicDay, b: PublicDay): boolean {
  return (
    sameSlot(a.früh, b.früh) &&
    sameSlot(a.spät, b.spät) &&
    a.frühAbsence === b.frühAbsence &&
    a.spätAbsence === b.spätAbsence
  );
}

function hasContent(d: PublicDay): boolean {
  return !!(d.früh || d.spät || d.frühAbsence || d.spätAbsence);
}

export function toShareDepartment(dep: 'service' | 'küche' | 'kueche'): ShareDepartment {
  return dep === 'service' ? 'service' : 'kueche';
}

/** Montage aller Kalenderwochen, die in `days` vollständig (7/7 Tage) enthalten sind. */
export function fullyCoveredWeekStarts(days: Date[]): Date[] {
  const have = new Set(days.map(d => format(d, DATE_FMT)));
  const starts = new Map<string, Date>();
  for (const d of days) {
    const monday = startOfWeek(d, { weekStartsOn: 1 });
    starts.set(format(monday, DATE_FMT), monday);
  }
  return [...starts.values()]
    .filter(monday =>
      Array.from({ length: 7 }, (_, i) => format(addDays(monday, i), DATE_FMT)).every(k => have.has(k)),
    )
    .sort((a, b) => a.getTime() - b.getTime());
}

export interface BuildWeekPayloadInput {
  department: ShareDepartment;
  weekStart: Date; // Montag
  employees: ShareSourceEmployee[];
  /** Schlüssel: `${employeeId}-${yyyy-MM-dd}` */
  scheduleData: Record<string, ShareSourceDay | undefined>;
  /** Zuletzt veröffentlichte Payload derselben Woche (für Änderungsmarkierung) */
  previous?: WeekPayload | null;
}

export interface BuildWeekPayloadResult {
  payload: WeekPayload;
  changedDays: number;
  changedEmployeeNames: string[];
}

export function buildWeekPayload(input: BuildWeekPayloadInput): BuildWeekPayloadResult {
  const { department, weekStart, employees, scheduleData, previous } = input;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const emps = employees
    .filter(e => toShareDepartment(e.department) === department)
    .map(e => ({
      id: e.id,
      name: e.display_name?.trim() || e.name?.trim() || 'Unbekannter Mitarbeiter',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));

  let changedDays = 0;
  const changedNames: string[] = [];

  const publicEmployees: PublicEmployee[] = emps.map(emp => {
    const prevEmp = previous?.employees.find(p => p.id === emp.id) ?? null;
    let empChanged = false;

    const days = dates.map((date): PublicDay => {
      const dateStr = format(date, DATE_FMT);
      const src = scheduleData[`${emp.id}-${dateStr}`];
      const day: PublicDay = {
        date: dateStr,
        früh: normSlot(src?.früh),
        spät: normSlot(src?.spät),
        frühAbsence: toPublicAbsence(src?.frühAbsence),
        spätAbsence: toPublicAbsence(src?.spätAbsence),
      };

      if (previous) {
        const prevDay = prevEmp?.days.find(d => d.date === dateStr) ?? null;
        const differs = prevDay ? !sameDay(day, prevDay) : hasContent(day);
        if (differs) {
          day.changed = true;
          day.previousFrüh = prevDay?.früh ?? null;
          day.previousSpät = prevDay?.spät ?? null;
          changedDays += 1;
          empChanged = true;
        }
      }
      return day;
    });

    if (empChanged) changedNames.push(emp.name);
    return { id: emp.id, name: emp.name, days };
  });

  // Erneutes Veröffentlichen ohne Änderung: bisherige Markierungen beibehalten,
  // damit Mitarbeitende, die den Link noch nicht geöffnet haben, sie weiterhin sehen.
  if (previous && changedDays === 0) {
    for (const emp of publicEmployees) {
      const prevEmp = previous.employees.find(p => p.id === emp.id);
      if (!prevEmp) continue;
      emp.days = emp.days.map(d => {
        const prevDay = prevEmp.days.find(p => p.date === d.date);
        return prevDay?.changed
          ? { ...d, changed: true, previousFrüh: prevDay.previousFrüh ?? null, previousSpät: prevDay.previousSpät ?? null }
          : d;
      });
    }
  }

  return {
    payload: {
      version: 1,
      department,
      weekStart: format(weekStart, DATE_FMT),
      weekEnd: format(addDays(weekStart, 6), DATE_FMT),
      kw: getISOWeek(weekStart),
      employees: publicEmployees,
    },
    changedDays,
    changedEmployeeNames: changedNames,
  };
}

/** Vergleichsschlüssel ohne Änderungsmarkierungen. */
function contentKey(p: WeekPayload): string {
  // Slots feldweise serialisieren: jsonb speichert Objektschlüssel in anderer
  // Reihenfolge ({end,start}), ein direktes JSON.stringify würde sonst abweichen.
  const slotKey = (s: PublicSlot | null | undefined) => (s ? `${s.start}|${s.end}` : null);
  return JSON.stringify(
    p.employees.map(e => [
      e.id,
      e.days.map(d => [d.date, slotKey(d.früh), slotKey(d.spät), d.frühAbsence ?? null, d.spätAbsence ?? null]),
    ]),
  );
}

export function computeStatus(published: WeekPayload | null, current: WeekPayload): PublishStatus {
  if (!published) return 'draft';
  return contentKey(published) === contentKey(current) ? 'published' : 'changed';
}

export interface ShareWeekInfo {
  kw: number;
  weekStart: Date;
}

/** Aufeinanderfolgende Wochen als Bereich: „KW 44–48“, sonst „KW 43, KW 45–46“. */
export function formatKwRuns(weeks: ShareWeekInfo[]): string {
  const sorted = [...weeks].sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
  const runs: ShareWeekInfo[][] = [];
  for (const w of sorted) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (prev && format(addDays(prev.weekStart, 7), DATE_FMT) === format(w.weekStart, DATE_FMT)) run.push(w);
    else runs.push([w]);
  }
  return runs
    .map(r => (r.length === 1 ? `KW ${r[0].kw}` : `KW ${r[0].kw}–${r[r.length - 1].kw}`))
    .join(', ');
}

/**
 * WhatsApp-Text. Beispiel:
 *   "Dienstplan Service KW 43 (20.10.–26.10.2026) ist online:\nhttps://…"
 */
export function buildWhatsAppMessage(opts: {
  department: ShareDepartment;
  weeks: ShareWeekInfo[];
  isUpdate: boolean;
  link: string;
}): string {
  const { department, weeks, isUpdate, link } = opts;
  const label = SHARE_DEPARTMENT_LABEL[department];
  const plural = weeks.length > 1;
  const verb = isUpdate ? (plural ? 'wurden aktualisiert' : 'wurde aktualisiert') : plural ? 'sind online' : 'ist online';

  let what: string;
  if (weeks.length === 1) {
    const start = weeks[0].weekStart;
    const end = addDays(start, 6);
    what = `KW ${weeks[0].kw} (${format(start, 'dd.MM.')}–${format(end, 'dd.MM.yyyy')})`;
  } else {
    what = formatKwRuns(weeks);
  }
  return `Dienstplan ${label} ${what} ${verb}:\n${link}`;
}

export function buildWhatsAppUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export function buildPublicScheduleLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/s/${token}`;
}
