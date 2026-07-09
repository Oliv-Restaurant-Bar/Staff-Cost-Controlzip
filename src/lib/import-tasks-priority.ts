/**
 * import-tasks-priority.ts — Priorisierung, Fälligkeit & Monatsfortschritt
 * ========================================================================
 * Reine Zusatz-Logik AUF den von import-tasks-engine.ts erzeugten Aufgaben:
 *   - Fälligkeit/Urgenz pro Aufgabe (überfällig / heute fällig / später)
 *   - Prioritäts-Sortierung offener Aufgaben (Fehler → überfällig → heute → rest)
 *   - „Heute zu erledigen"-Auswahl
 *   - Monatsfortschritt (x von y, Prozent) + Monatsabschluss-Status
 *   - Kompakte Typ-Zusammenfassung (erledigt/offen pro Importtyp)
 *
 * WICHTIG: DOM-/Supabase-frei; konsumiert NUR ImportTask[] + today. Dieselbe
 * Monatslogik ist später für Monatsabschluss, Controlling und das
 * OP-Listen-Tool wiederverwendbar. Die Engine selbst bleibt unverändert.
 *
 * Fälligkeits-Semantik: Tag X ist ab dem Folgetag X+1 importierbar (die
 * Engine deckelt Aufgaben auf min(Monatsende, gestern)). Eine Tagesaufgabe
 * für gestern ist damit HEUTE fällig; ältere Tage sind überfällig. Urgenz
 * wird bewusst NICHT aus `notYetDue` abgeleitet (yearly setzt das Flag nie),
 * sondern rein aus from/to + Frequenz + today.
 */

import {
  addDaysIso,
  monthEndIso,
  formatIsoRange,
  isOpenTask,
  TASK_TYPE_DEFS,
  type ImportTask,
  type ImportTaskType,
} from './import-tasks-engine';

// ── Fälligkeit pro Aufgabe ───────────────────────────────────────────────

export type TaskUrgency = 'overdue' | 'today' | 'later';

export interface TaskDueInfo {
  urgency: TaskUrgency;
  /** Deutsches Fälligkeits-Label („Heute erledigen", „2 Tage überfällig", …); null = kein Label. */
  dueLabel: string | null;
  /** Kalendertage über der Fälligkeit (0 wenn nicht überfällig). */
  daysOverdue: number;
}

/** Kalendertage-Differenz a − b (beide yyyy-MM-dd). */
function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

const NONE: TaskDueInfo = { urgency: 'later', dueLabel: null, daysOverdue: 0 };

export function getTaskDueInfo(
  task: Pick<ImportTask, 'status' | 'frequency' | 'from' | 'to'>,
  today: string,
): TaskDueInfo {
  if (task.status === 'done') return NONE;
  // Fehler-Aufgaben: keine Fälligkeits-Aussage möglich — Sortierung stellt sie
  // separat nach vorne (siehe prioritizeTasks).
  if (task.status === 'error') return { urgency: 'overdue', dueLabel: null, daysOverdue: 0 };

  switch (task.frequency) {
    case 'daily': {
      const overdueDays = diffDays(today, addDaysIso(task.to, 1));
      if (overdueDays === 0) return { urgency: 'today', dueLabel: 'Heute erledigen', daysOverdue: 0 };
      if (overdueDays < 0) return NONE;
      return {
        urgency: 'overdue',
        dueLabel: `${overdueDays} Tag${overdueDays === 1 ? '' : 'e'} überfällig`,
        daysOverdue: overdueDays,
      };
    }
    case 'range': {
      // Der ÄLTESTE fehlende Tag bestimmt die Urgenz.
      const overdueDays = diffDays(today, addDaysIso(task.from, 1));
      if (overdueDays === 0) return { urgency: 'today', dueLabel: 'Heute erledigen', daysOverdue: 0 };
      if (overdueDays < 0) return NONE;
      const span = diffDays(task.to, task.from) + 1;
      return {
        urgency: 'overdue',
        dueLabel: span === 1 ? '1 Tag offen' : `${span} Tage offen`,
        daysOverdue: overdueDays,
      };
    }
    case 'monthly': {
      // Während der Monat läuft, zeigt die UI bereits „Monat läuft noch".
      if (today <= task.to) return NONE;
      return {
        urgency: 'overdue',
        dueLabel: 'Monatsimport noch offen',
        daysOverdue: diffDays(today, addDaysIso(task.to, 1)),
      };
    }
    case 'yearly': {
      if (today <= task.to) return { urgency: 'later', dueLabel: 'Budget noch offen', daysOverdue: 0 };
      return {
        urgency: 'overdue',
        dueLabel: 'Budget noch offen',
        daysOverdue: diffDays(today, addDaysIso(task.to, 1)),
      };
    }
  }
}

// ── Priorisierung ────────────────────────────────────────────────────────

const URGENCY_RANK: Record<TaskUrgency, number> = { overdue: 1, today: 2, later: 3 };

export interface PrioritizedTask {
  task: ImportTask;
  due: TaskDueInfo;
}

/**
 * Aufgaben nach Priorität sortieren: Fehler zuerst, dann überfällig
 * (älteste zuerst), heute fällig, rest. Innerhalb gleicher Stufe chronologisch.
 */
export function prioritizeTasks(tasks: readonly ImportTask[], today: string): PrioritizedTask[] {
  return tasks
    .map((task) => ({ task, due: getTaskDueInfo(task, today) }))
    .sort((a, b) => {
      const ra = a.task.status === 'error' ? 0 : URGENCY_RANK[a.due.urgency];
      const rb = b.task.status === 'error' ? 0 : URGENCY_RANK[b.due.urgency];
      if (ra !== rb) return ra - rb;
      if (a.task.from !== b.task.from) return a.task.from < b.task.from ? -1 : 1;
      return a.task.label.localeCompare(b.task.label, 'de');
    });
}

/** Offene Aufgaben, die HEUTE anstehen (Fehler + überfällig + heute fällig), priorisiert. */
export function getTodayTasks(tasks: readonly ImportTask[], today: string): PrioritizedTask[] {
  return prioritizeTasks(tasks.filter(isOpenTask), today).filter(
    (p) => p.task.status === 'error' || p.due.urgency !== 'later',
  );
}

// ── Monatsfortschritt & Abschluss-Status ─────────────────────────────────

export type MonthClosureStatus = 'not_started' | 'partial' | 'almost' | 'complete';

export interface MonthProgress {
  /** Fällige Aufgaben (offene „später"-Aufgaben zählen NICHT zum Nenner). */
  total: number;
  done: number;
  /** 0–100 (done/total), null wenn keine fälligen Aufgaben existieren. */
  percent: number | null;
  /** Fällige offene Aufgaben (inkl. Fehler). */
  openNow: number;
  /** Offene, aber noch nicht fällige Aufgaben (Monat läuft noch / Budget im laufenden Jahr). */
  laterOpen: number;
  errors: number;
  /** WIRKLICH alle Aufgaben erledigt (inkl. monatlich/jährlich, keine Fehler). */
  allDone: boolean;
  /** Monatsende liegt in der Vergangenheit. */
  monthOver: boolean;
  closure: MonthClosureStatus;
}

/**
 * Fortschritt eines Monats aus seinen Aufgaben. Nenner = fällige Aufgaben:
 * Ohne diesen Ausschluss könnte ein laufender Monat nie 100 % erreichen
 * (Monats-/Jahresaufgaben werden erst nach Periodenende fällig).
 * „complete" erfordert ALLE Aufgaben erledigt UND Monat vorbei.
 */
export function computeMonthProgress(
  tasks: readonly ImportTask[],
  period: { year: number; month: number; today: string },
): MonthProgress {
  const monthOver = period.today > monthEndIso(period.year, period.month);
  let done = 0;
  let openNow = 0;
  let laterOpen = 0;
  let errors = 0;
  for (const t of tasks) {
    if (t.status === 'done') {
      done += 1;
    } else if (t.status === 'error') {
      errors += 1;
      openNow += 1;
    } else if (getTaskDueInfo(t, period.today).urgency === 'later') {
      laterOpen += 1;
    } else {
      openNow += 1;
    }
  }
  const total = done + openNow;
  const percent = total > 0 ? Math.round((done / total) * 100) : null;
  const allDone = tasks.length > 0 && done === tasks.length;

  let closure: MonthClosureStatus;
  if (tasks.length === 0 || done === 0) closure = 'not_started';
  else if (allDone && monthOver) closure = 'complete';
  else if (percent !== null && percent >= 80) closure = 'almost';
  else closure = 'partial';

  return { total, done, percent, openNow, laterOpen, errors, allDone, monthOver, closure };
}

export const CLOSURE_LABEL: Record<MonthClosureStatus, string> = {
  not_started: 'Nicht begonnen',
  partial: 'Teilweise importiert',
  almost: 'Fast abgeschlossen',
  complete: 'Vollständig abgeschlossen',
};

/** Ton-Zuordnung (kompatibel zu tones.ts, ohne UI-Import — Modul bleibt rein). */
export const CLOSURE_TONE: Record<MonthClosureStatus, 'neutral' | 'warn' | 'info' | 'good'> = {
  not_started: 'neutral',
  partial: 'warn',
  almost: 'info',
  complete: 'good',
};

/** Stabiler Cache-/Anzeige-Schlüssel yyyy-MM. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ── Kompakte Typ-Zusammenfassung (✓/⚠ pro Importtyp) ────────────────────

export type TypeCompletionStatus = 'done' | 'open' | 'later' | 'error';

export interface TypeCompletion {
  type: ImportTaskType;
  label: string;
  status: TypeCompletionStatus;
  /** Offene Zeiträume kompakt („24.06.–30.06.2026") bzw. Fehlertext; null wenn nichts anzuzeigen. */
  detail: string | null;
}

/** Benachbarte/überlappende offene Zeiträume zu kompakten Bereichen mergen. */
function mergeOpenRanges(open: readonly ImportTask[]): Array<{ from: string; to: string }> {
  const sorted = [...open].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: Array<{ from: string; to: string }> = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t.from <= addDaysIso(last.to, 1)) {
      if (t.to > last.to) last.to = t.to;
    } else {
      out.push({ from: t.from, to: t.to });
    }
  }
  return out;
}

/**
 * Eine Zeile pro Importtyp: vollständig / noch offen (mit Zeiträumen) /
 * noch nicht fällig / Fehler — für die kompakte Monats-Zusammenfassung.
 */
export function summarizeTypeCompletion(
  tasks: readonly ImportTask[],
  today: string,
): TypeCompletion[] {
  const result: TypeCompletion[] = [];
  for (const def of TASK_TYPE_DEFS) {
    const own = tasks.filter((t) => t.type === def.type);
    if (own.length === 0) continue;
    const errorTask = own.find((t) => t.status === 'error');
    if (errorTask) {
      result.push({
        type: def.type,
        label: def.label,
        status: 'error',
        detail: errorTask.error ?? 'Abdeckung konnte nicht ermittelt werden',
      });
      continue;
    }
    const open = own.filter(isOpenTask);
    if (open.length === 0) {
      result.push({ type: def.type, label: def.label, status: 'done', detail: null });
      continue;
    }
    const anyDue = open.some((t) => getTaskDueInfo(t, today).urgency !== 'later');
    if (!anyDue) {
      result.push({ type: def.type, label: def.label, status: 'later', detail: null });
      continue;
    }
    if (def.frequency === 'monthly' || def.frequency === 'yearly') {
      result.push({ type: def.type, label: def.label, status: 'open', detail: 'fehlt' });
      continue;
    }
    const detail = mergeOpenRanges(open)
      .map((r) => formatIsoRange(r.from, r.to))
      .join(', ');
    result.push({ type: def.type, label: def.label, status: 'open', detail });
  }
  return result;
}
