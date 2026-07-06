/**
 * import-cockpit-checks.ts — Reine Logik für MANUELL erledigte Kontrollen/Aufgaben.
 * ================================================================================
 * KEIN React / Supabase / DOM (nur date-fns + `import type` aus import-cockpit.ts).
 *
 * Das Import-Cockpit ist ansonsten strikt READ-ONLY. Dieses Modul ergänzt die
 * EINZIGE Ausnahme: der Benutzer kann wiederkehrende **Kontrollen** (section
 * 'control') und **Kontroll-Aufgaben** manuell als „erledigt" markieren. Echte
 * **Datenimporte** (section 'import') dürfen NIE manuell erledigt werden — ihr
 * Status kommt ausschliesslich aus echten Importdaten.
 *
 * Ein „erledigt" wird als `ManualCompletion` gespeichert: das Datum der Erledigung
 * (`completedAt`) plus die daraus neu berechnete nächste Fälligkeit (`nextDue`,
 * = completedAt + Rhythmus). Solange `today < nextDue`, gilt die Kontrolle als
 * erledigt; ab der nächsten Fälligkeit greift wieder der abgeleitete Status.
 *
 * Persistenz (localStorage + Supabase-KV-Backup, mandantengetrennt) liegt in
 * `import-cockpit-checks-db.ts` — dieses Modul bleibt rein/testbar.
 */

import { addDays, addMonths, addYears, format, parseISO } from 'date-fns';
import type { CockpitSourceId, ImportInterval } from './import-cockpit';
import type { CockpitTask } from './import-cockpit-tabs';

/** KV-/localStorage-Schlüssel (wird mandantenspezifisch via tenantKey präfixiert). */
export const MANUAL_CHECKS_KEY = 'importCockpitControlChecks';

/** Ein manuell erledigter Check: Erledigungsdatum + neu berechnete Fälligkeit. */
export interface ManualCompletion {
  /** yyyy-MM-dd — Tag der manuellen Erledigung („Letzte Durchführung"). */
  completedAt: string;
  /** yyyy-MM-dd — nächste Fälligkeit = completedAt + Rhythmus. */
  nextDue: string;
}

/** Zuordnung Quellen-ID → manuelle Erledigung. */
export type ManualCompletionMap = Record<string, ManualCompletion>;

/**
 * Nächste Fälligkeit nach einer Erledigung (rein). Spiegelt die Semantik von
 * `computeNextDue` in import-cockpit.ts: täglich +1 Tag, wöchentlich +7 Tage,
 * monatlich +1 Monat, jährlich +1 Jahr.
 */
export function nextDueAfterCompletion(interval: ImportInterval, completedAt: string): string {
  const base = parseISO(completedAt);
  let next: Date;
  switch (interval) {
    case 'daily':
      next = addDays(base, 1);
      break;
    case 'weekly':
      next = addDays(base, 7);
      break;
    case 'monthly':
      next = addMonths(base, 1);
      break;
    case 'yearly':
      next = addYears(base, 1);
      break;
  }
  return format(next, 'yyyy-MM-dd');
}

/** Baut einen `ManualCompletion`-Datensatz für „heute erledigt". */
export function makeCompletion(interval: ImportInterval, today: string): ManualCompletion {
  return { completedAt: today, nextDue: nextDueAfterCompletion(interval, today) };
}

/**
 * Gilt eine manuelle Erledigung an `today` noch als aktiv (= Kontrolle erledigt)?
 * Aktiv, solange `today < nextDue`. Ab der nächsten Fälligkeit (today >= nextDue)
 * ist sie abgelaufen und der abgeleitete Frische-Status übernimmt wieder.
 */
export function isCompletionActive(c: ManualCompletion | null | undefined, today: string): boolean {
  if (!c) return false;
  return today < c.nextDue;
}

/** Entfernt abgelaufene Erledigungen (hält den gespeicherten Map klein/tidy). */
export function pruneCompletions(map: ManualCompletionMap, today: string): ManualCompletionMap {
  const next: ManualCompletionMap = {};
  for (const [id, c] of Object.entries(map)) {
    if (isCompletionActive(c, today)) next[id] = c;
  }
  return next;
}

/**
 * Markiert die übergebenen Kontrollen als „heute erledigt" und liefert einen NEUEN
 * Map zurück (abgelaufene Einträge werden zuvor entfernt). Jede Kontrolle bringt
 * ihren Rhythmus mit, damit die nächste Fälligkeit korrekt berechnet wird.
 */
export function markControlsDone(
  map: ManualCompletionMap,
  controls: Array<{ id: CockpitSourceId; interval: ImportInterval }>,
  today: string,
): ManualCompletionMap {
  const next = pruneCompletions(map, today);
  for (const c of controls) {
    next[c.id] = makeCompletion(c.interval, today);
  }
  return next;
}

/** Aufteilung ausgewählter Aufgaben in manuell erledigbare vs. blockierte (Import). */
export interface TaskCompletionPartition {
  /** Kontroll-Aufgaben (section 'control') — dürfen manuell erledigt werden. */
  completable: CockpitTask[];
  /** Datenimport-Aufgaben (section 'import') — NICHT manuell erledigbar. */
  blocked: CockpitTask[];
}

/**
 * Teilt die ausgewählten Aufgaben nach Erledigbarkeit auf: nur Kontroll-Aufgaben
 * sind manuell erledigbar; echte Datenimporte werden blockiert (Hinweis in der UI).
 */
export function partitionTasksForCompletion(
  tasks: CockpitTask[],
  selectedIds: Set<CockpitSourceId>,
): TaskCompletionPartition {
  const completable: CockpitTask[] = [];
  const blocked: CockpitTask[] = [];
  for (const t of tasks) {
    if (!selectedIds.has(t.id)) continue;
    if (t.section === 'control') completable.push(t);
    else blocked.push(t);
  }
  return { completable, blocked };
}
