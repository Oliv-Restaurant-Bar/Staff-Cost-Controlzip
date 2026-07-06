/**
 * import-cockpit-tabs.ts — Reine 3-Tab-Logik für das überarbeitete Import-Cockpit.
 * =============================================================================
 * KEIN React / Supabase / DOM (nur `import`/`import type` aus import-cockpit.ts).
 * Baut auf den bereits berechneten `CockpitRow`s (Deskriptor + Signal + Status)
 * auf und leitet daraus die drei Tab-Sichten ab:
 *
 *   1. „Datenimporte"  → Zeilen mit `section === 'import'` (echte Importe/Erfassung)
 *   2. „Kontrollen"    → Zeilen mit `section === 'control'` (wiederkehrende Checks)
 *   3. „Aufgaben"      → offene Punkte aus BEIDEN Sektionen, nach Zeithorizont
 *                        (Heute/Woche/Monat/Jahr) gruppiert und priorisiert.
 *
 * READ-ONLY: Wie das gesamte Cockpit verändert dieses Modul keine Importprozesse,
 * keine Tabellen, keine Business-Logik. Es liest nur bestehende Signale.
 *
 * NO-FABRICATION-INVARIANTE: Kontrollen bzw. Quellen OHNE automatisch ableitbares
 * Signal (`checkable: false` → Status `uncheckable`, oder `never`) werden bewusst
 * als NEUTRAL („Nicht eingerichtet") geführt und erzeugen KEINE offene Aufgabe.
 * Es wird nie eine Fälligkeit erfunden, die nicht aus echten Daten ableitbar ist.
 */

import {
  matchesCockpitSearch,
  type CockpitImportType,
  type CockpitRow,
  type CockpitSection,
  type CockpitSignal,
  type CockpitSourceDef,
  type CockpitSourceId,
  type CockpitStatus,
  type CockpitStatusResult,
  type CockpitTabCategory,
  type ImportInterval,
} from './import-cockpit';
import { isCompletionActive, type ManualCompletionMap } from './import-cockpit-checks';

// ─── Tab-Kategorien („Bereiche") ──────────────────────────────────────────────

/** Anzeigename je Tab-Kategorie (gilt für beide Sektionen). */
export const TAB_CATEGORY_LABEL: Record<CockpitTabCategory, string> = {
  // Datenimporte
  reservationen: 'Reservationen',
  gaeste_crm: 'Gäste / CRM',
  umsatz: 'Umsatz',
  produkte: 'Produkte',
  personal: 'Personal',
  warenwirtschaft: 'Warenwirtschaft',
  finanzen: 'Finanzen',
  // Kontrollen
  forecast: 'Forecast',
  dienstplanung: 'Dienstplanung',
  controlling: 'Controlling',
  budget: 'Budget',
  inventur: 'Inventur',
  monatsabschluss: 'Monatsabschluss',
};

/** Kanonische Reihenfolge der Kategorien im Tab „Datenimporte". */
export const IMPORT_CATEGORY_ORDER: CockpitTabCategory[] = [
  'reservationen',
  'gaeste_crm',
  'umsatz',
  'produkte',
  'personal',
  'warenwirtschaft',
  'finanzen',
];

/** Kanonische Reihenfolge der Kategorien im Tab „Kontrollen". */
export const CONTROL_CATEGORY_ORDER: CockpitTabCategory[] = [
  'dienstplanung',
  'forecast',
  'personal',
  'budget',
  'monatsabschluss',
  'inventur',
  'controlling',
];

// ─── Kontroll-Status ──────────────────────────────────────────────────────────

/**
 * Status einer wiederkehrenden Kontrolle (abgeleitet aus dem Frische-Status).
 * - done           → grün:  erledigt / aktuell
 * - due_today      → rot:   heute fällig (nächste Fälligkeit == heute)
 * - due_soon       → gelb:  bald fällig
 * - overdue        → rot:   überfällig (oder letzter Lauf fehlgeschlagen)
 * - not_configured → grau:  kein automatisch ableitbares Signal (neutral)
 */
export type ControlStatus = 'done' | 'due_today' | 'due_soon' | 'overdue' | 'not_configured';

/**
 * Bildet den bereits berechneten Frische-Status einer Kontrolle DIREKT auf einen
 * Kontroll-Status ab (kein eigenes Fälligkeitsfenster — die Schwellen leben
 * zentral in computeSourceStatus/INTERVAL_THRESHOLDS).
 *
 * Reihenfolge:
 *   - nicht prüfbar / nie / kein Signal → not_configured (NEUTRAL, keine Aufgabe)
 *   - overdue                           → overdue
 *   - current  → due_today NUR wenn heute fällig, sonst done
 *   - due_soon → due_today NUR wenn heute fällig, sonst due_soon
 *
 * `today` = yyyy-MM-dd; wird mit `result.nextDue` (ebenfalls yyyy-MM-dd) verglichen.
 */
export function computeControlStatus(
  def: Pick<CockpitSourceDef, 'checkable'>,
  result: Pick<CockpitStatusResult, 'status' | 'nextDue'>,
  today: string,
): ControlStatus {
  if (!def.checkable) return 'not_configured';
  switch (result.status) {
    case 'never':
    case 'uncheckable':
      return 'not_configured';
    case 'overdue':
      return 'overdue';
    case 'current':
      return result.nextDue === today ? 'due_today' : 'done';
    case 'due_soon':
      return result.nextDue === today ? 'due_today' : 'due_soon';
    default:
      return 'not_configured';
  }
}

/** Kontroll-Zeile: Deskriptor + Signal + Frische-Status + abgeleiteter Kontroll-Status. */
export interface ControlRow {
  def: CockpitSourceDef;
  signal: CockpitSignal;
  result: CockpitStatusResult;
  controlStatus: ControlStatus;
  /** true, wenn die Kontrolle aktuell durch eine manuelle Erledigung als erledigt gilt. */
  manuallyCompleted?: boolean;
  /** yyyy-MM-dd — Tag der manuellen Erledigung (nur wenn manuallyCompleted). */
  completedAt?: string;
}

/**
 * Filtert die Kontroll-Zeilen aus allen Cockpit-Zeilen und berechnet den Kontroll-Status.
 * `completions` (optional) enthält manuelle „Erledigt"-Markierungen: ist eine Erledigung
 * an `today` noch aktiv, gilt die Kontrolle als `done`, und die nächste Fälligkeit wird
 * aus der Erledigung übernommen. Ohne `completions` verhält sich die Funktion wie bisher.
 */
export function buildControlRows(
  rows: CockpitRow[],
  today: string,
  completions?: ManualCompletionMap,
): ControlRow[] {
  return rows
    .filter((r) => r.def.section === 'control')
    .map((r) => {
      const completion = completions?.[r.def.id];
      if (completion && isCompletionActive(completion, today)) {
        return {
          def: r.def,
          signal: r.signal,
          result: { ...r.result, nextDue: completion.nextDue },
          controlStatus: 'done' as ControlStatus,
          manuallyCompleted: true,
          completedAt: completion.completedAt,
        };
      }
      return {
        def: r.def,
        signal: r.signal,
        result: r.result,
        controlStatus: computeControlStatus(r.def, r.result, today),
        manuallyCompleted: false,
      };
    });
}

/** Filtert die Import-Zeilen aus allen Cockpit-Zeilen (section === 'import'). */
export function buildImportRows(rows: CockpitRow[]): CockpitRow[] {
  return rows.filter((r) => r.def.section === 'import');
}

// ─── Aufgaben (aggregierte offene Punkte) ─────────────────────────────────────

/** Priorität einer offenen Aufgabe. */
export type TaskPriority = 'critical' | 'medium';

/** Zeithorizont einer Aufgabe (aus dem Intervall abgeleitet). */
export type TaskTimeframe = 'today' | 'week' | 'month' | 'year';

const TIMEFRAME_FROM_INTERVAL: Record<ImportInterval, TaskTimeframe> = {
  daily: 'today',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};

/**
 * Priorität einer OFFENEN Import-Aufgabe aus dem Frische-Status.
 * overdue (inkl. fehlgeschlagen) → critical; never/due_soon → medium.
 * current (aktuell) und uncheckable (neutral) sind KEINE Aufgabe → null.
 */
export function importTaskPriority(status: CockpitStatus): TaskPriority | null {
  switch (status) {
    case 'overdue':
      return 'critical';
    case 'never':
    case 'due_soon':
      return 'medium';
    default:
      return null; // current, uncheckable
  }
}

/**
 * Priorität einer OFFENEN Kontroll-Aufgabe aus dem Kontroll-Status.
 * overdue/due_today → critical; due_soon → medium.
 * done und not_configured (neutral) sind KEINE Aufgabe → null.
 */
export function controlTaskPriority(status: ControlStatus): TaskPriority | null {
  switch (status) {
    case 'overdue':
    case 'due_today':
      return 'critical';
    case 'due_soon':
      return 'medium';
    default:
      return null; // done, not_configured
  }
}

/** Eine offene Aufgabe (aggregiert aus Import- ODER Kontroll-Zeilen). */
export interface CockpitTask {
  id: CockpitSourceId;
  /** Voller Deskriptor (für Drawer/Suche/Aktion). */
  def: CockpitSourceDef;
  /** Herkunfts-Sektion (import | control). */
  section: CockpitSection;
  priority: TaskPriority;
  timeframe: TaskTimeframe;
  /** Aufgabentext (checklistLabel des Deskriptors). */
  label: string;
  /** Ehrliche Begründung aus dem Frische-Status (nie erfunden). */
  reason: string;
  route?: string;
  actionLabel?: string;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 0, medium: 1 };

/**
 * Baut die Liste der OFFENEN Aufgaben aus allen Cockpit-Zeilen. Import-Zeilen
 * werden über den Frische-Status, Kontroll-Zeilen über den Kontroll-Status
 * bewertet. Nur Zeilen mit Priorität (critical|medium) werden zur Aufgabe;
 * neutrale Zustände (aktuell/erledigt/nicht eingerichtet) werden übersprungen.
 * Sortierung: kritisch vor mittel, sonst stabil in Deskriptor-Reihenfolge.
 */
export function buildTasks(
  rows: CockpitRow[],
  today: string,
  completions?: ManualCompletionMap,
): CockpitTask[] {
  const tasks: CockpitTask[] = [];
  for (const row of rows) {
    let priority: TaskPriority | null;
    if (row.def.section === 'control') {
      const completion = completions?.[row.def.id];
      // Manuell (noch aktiv) erledigte Kontrollen erzeugen KEINE offene Aufgabe.
      const controlStatus =
        completion && isCompletionActive(completion, today)
          ? 'done'
          : computeControlStatus(row.def, row.result, today);
      priority = controlTaskPriority(controlStatus);
    } else {
      // Datenimporte sind NIE manuell erledigbar → Frische-Status entscheidet.
      priority = importTaskPriority(row.result.status);
    }
    if (!priority) continue;
    tasks.push({
      id: row.def.id,
      def: row.def,
      section: row.def.section,
      priority,
      timeframe: TIMEFRAME_FROM_INTERVAL[row.def.interval],
      label: row.def.checklistLabel,
      reason: row.result.reason,
      route: row.def.route,
      actionLabel: row.def.actionLabel,
    });
  }
  return tasks.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

/** Aufgaben nach Zeithorizont gruppiert (für die Sektionen im Aufgaben-Tab). */
export interface TaskGroups {
  today: CockpitTask[];
  week: CockpitTask[];
  month: CockpitTask[];
  year: CockpitTask[];
}

/** Gruppiert Aufgaben nach Zeithorizont (Heute/Woche/Monat/Jahr). */
export function groupTasksByTimeframe(tasks: CockpitTask[]): TaskGroups {
  const groups: TaskGroups = { today: [], week: [], month: [], year: [] };
  for (const t of tasks) groups[t.timeframe].push(t);
  return groups;
}

// ─── KPI-Zusammenfassungen ────────────────────────────────────────────────────

/** KPI-Zählung für den Kontrollen-Tab. */
export interface ControlSummary {
  done: number;
  dueToday: number;
  dueSoon: number;
  overdue: number;
  notConfigured: number;
}

/** Zählt die Kontroll-Status-Verteilung für die KPI-Karten. */
export function summarizeControls(rows: Array<Pick<ControlRow, 'controlStatus'>>): ControlSummary {
  const s: ControlSummary = { done: 0, dueToday: 0, dueSoon: 0, overdue: 0, notConfigured: 0 };
  for (const { controlStatus } of rows) {
    switch (controlStatus) {
      case 'done':
        s.done++;
        break;
      case 'due_today':
        s.dueToday++;
        break;
      case 'due_soon':
        s.dueSoon++;
        break;
      case 'overdue':
        s.overdue++;
        break;
      case 'not_configured':
        s.notConfigured++;
        break;
    }
  }
  return s;
}

/** KPI-Zählung für den Aufgaben-Tab. */
export interface TaskSummary {
  todayOpen: number;
  weekOpen: number;
  monthOpen: number;
  yearOpen: number;
  critical: number;
  total: number;
}

/** Zählt offene Aufgaben je Zeithorizont + kritische + Gesamt für die KPI-Karten. */
export function summarizeTasks(tasks: Array<Pick<CockpitTask, 'timeframe' | 'priority'>>): TaskSummary {
  const s: TaskSummary = { todayOpen: 0, weekOpen: 0, monthOpen: 0, yearOpen: 0, critical: 0, total: tasks.length };
  for (const t of tasks) {
    switch (t.timeframe) {
      case 'today':
        s.todayOpen++;
        break;
      case 'week':
        s.weekOpen++;
        break;
      case 'month':
        s.monthOpen++;
        break;
      case 'year':
        s.yearOpen++;
        break;
    }
    if (t.priority === 'critical') s.critical++;
  }
  return s;
}

// ─── Filter (rein, testbar) ───────────────────────────────────────────────────

/**
 * KPI-Kachel-Filter des Datenimporte-Tabs. Jede Kachel entspricht genau einer
 * Facette aus `summarizeCockpit`: die Status-Kacheln filtern auf den Frische-
 * Status, `never_uncheckable` bündelt „Nie / Nicht prüfbar" (wie die Kachel
 * selbst), `gaps` filtert auf Zeilen mit inneren Datenlücken (missingDays).
 */
export type ImportKpiFilter = 'current' | 'due_soon' | 'overdue' | 'never_uncheckable' | 'gaps';

/** Prüft eine Import-Zeile gegen einen KPI-Kachel-Filter (null = kein Filter). */
export function importRowMatchesKpi(
  row: Pick<CockpitRow, 'result'>,
  kpi: ImportKpiFilter | null,
): boolean {
  if (kpi === null) return true;
  if (kpi === 'gaps') return row.result.missingDays.length > 0;
  if (kpi === 'never_uncheckable') return row.result.status === 'never' || row.result.status === 'uncheckable';
  return row.result.status === kpi;
}

/** Toggle-Semantik der Kacheln: erneuter Klick auf die aktive Kachel hebt den Filter auf. */
export function toggleImportKpiFilter(
  current: ImportKpiFilter | null,
  clicked: ImportKpiFilter,
): ImportKpiFilter | null {
  return current === clicked ? null : clicked;
}

/** Filter des Datenimporte-Tabs (Kategorie = tabCategory; kpi = Kachel-Filter). */
export interface ImportTabFilterState {
  category: 'all' | CockpitTabCategory;
  importType: 'all' | CockpitImportType;
  interval: 'all' | ImportInterval;
  status: 'all' | CockpitStatus;
  kpi: ImportKpiFilter | null;
  search: string;
}

export const EMPTY_IMPORT_TAB_FILTER: ImportTabFilterState = {
  category: 'all',
  importType: 'all',
  interval: 'all',
  status: 'all',
  kpi: null,
  search: '',
};

/** Prüft eine Import-Zeile gegen alle Filterachsen des Datenimporte-Tabs (UND). */
export function importRowMatchesFilters(row: CockpitRow, f: ImportTabFilterState): boolean {
  if (f.category !== 'all' && row.def.tabCategory !== f.category) return false;
  if (f.importType !== 'all' && row.def.importType !== f.importType) return false;
  if (f.interval !== 'all' && row.def.interval !== f.interval) return false;
  if (f.status !== 'all' && row.result.status !== f.status) return false;
  if (!importRowMatchesKpi(row, f.kpi)) return false;
  return matchesCockpitSearch(row.def, f.search);
}

// ─── Dateiformate (rein, testbar) ─────────────────────────────────────────────

/** Erwartetes Dateiformat eines Datei-Uploads (kompakte Badge-Anzeige). */
export type ImportFileFormat = 'CSV' | 'Excel' | 'PDF';

const FILE_FORMAT_ORDER: ImportFileFormat[] = ['CSV', 'Excel', 'PDF'];

/**
 * Leitet die erwarteten Dateiformate einer Quelle aus ihrem `exampleFormat` ab
 * (Dateiendungen: csv → CSV, xls/xlsx → Excel, pdf → PDF). Nur für echte
 * Datei-Uploads (`importType === 'file_upload'`) — manuelle Erfassung,
 * Kontrollen etc. haben kein Dateiformat und liefern []. Reihenfolge stabil
 * CSV → Excel → PDF. Es wird NIE ein Format erfunden: ohne erkennbare Endung
 * bleibt die Liste leer.
 */
export function importFileFormats(
  def: Pick<CockpitSourceDef, 'importType' | 'exampleFormat'>,
): ImportFileFormat[] {
  if (def.importType !== 'file_upload') return [];
  const text = (def.exampleFormat ?? '').toLowerCase();
  if (!text) return [];
  const found = new Set<ImportFileFormat>();
  for (const m of text.matchAll(/\.([a-z0-9]+)/g)) {
    const ext = m[1];
    if (ext === 'csv') found.add('CSV');
    else if (ext === 'xls' || ext === 'xlsx') found.add('Excel');
    else if (ext === 'pdf') found.add('PDF');
  }
  return FILE_FORMAT_ORDER.filter((f) => found.has(f));
}

/** Filter des Kontrollen-Tabs (Status = ControlStatus). */
export interface ControlTabFilterState {
  category: 'all' | CockpitTabCategory;
  interval: 'all' | ImportInterval;
  status: 'all' | ControlStatus;
  search: string;
}

export const EMPTY_CONTROL_TAB_FILTER: ControlTabFilterState = {
  category: 'all',
  interval: 'all',
  status: 'all',
  search: '',
};

/** Prüft eine Kontroll-Zeile gegen alle Filterachsen des Kontrollen-Tabs (UND). */
export function controlRowMatchesFilters(row: ControlRow, f: ControlTabFilterState): boolean {
  if (f.category !== 'all' && row.def.tabCategory !== f.category) return false;
  if (f.interval !== 'all' && row.def.interval !== f.interval) return false;
  if (f.status !== 'all' && row.controlStatus !== f.status) return false;
  return matchesCockpitSearch(row.def, f.search);
}

/** Filter des Aufgaben-Tabs. */
export interface TaskTabFilterState {
  section: 'all' | CockpitSection;
  priority: 'all' | TaskPriority;
  timeframe: 'all' | TaskTimeframe;
  search: string;
}

export const EMPTY_TASK_TAB_FILTER: TaskTabFilterState = {
  section: 'all',
  priority: 'all',
  timeframe: 'all',
  search: '',
};

/** Prüft eine Aufgabe gegen alle Filterachsen des Aufgaben-Tabs (UND). */
export function taskMatchesFilters(task: CockpitTask, f: TaskTabFilterState): boolean {
  if (f.section !== 'all' && task.section !== f.section) return false;
  if (f.priority !== 'all' && task.priority !== f.priority) return false;
  if (f.timeframe !== 'all' && task.timeframe !== f.timeframe) return false;
  return matchesCockpitSearch(task.def, f.search);
}

// ─── Anzeige-Konstanten ───────────────────────────────────────────────────────

export const SECTION_LABEL: Record<CockpitSection, string> = {
  import: 'Datenimport',
  control: 'Kontrolle',
};

export const CONTROL_STATUS_LABEL: Record<ControlStatus, string> = {
  done: 'Erledigt',
  due_today: 'Heute fällig',
  due_soon: 'Bald fällig',
  overdue: 'Überfällig',
  not_configured: 'Nicht eingerichtet',
};

/** Reihenfolge (dringlichste zuerst) für Sortierung/Filter-Dropdown. */
export const CONTROL_STATUS_ORDER: ControlStatus[] = ['overdue', 'due_today', 'due_soon', 'done', 'not_configured'];

export const CONTROL_STATUS_BADGE_CLASS: Record<ControlStatus, string> = {
  done: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  due_today: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  due_soon:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  overdue: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  not_configured: 'bg-muted text-muted-foreground border-border',
};

export const CONTROL_STATUS_DOT_CLASS: Record<ControlStatus, string> = {
  done: 'bg-emerald-500',
  due_today: 'bg-red-500',
  due_soon: 'bg-amber-400',
  overdue: 'bg-red-500',
  not_configured: 'bg-muted-foreground/30',
};

export const CONTROL_STATUS_HINT: Partial<Record<ControlStatus, string>> = {
  not_configured:
    'Für diese Kontrolle gibt es kein automatisch ableitbares Signal – bitte im verlinkten Modul manuell prüfen.',
};

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  critical: 'Dringend',
  medium: 'Offen',
};

export const TASK_PRIORITY_ORDER: TaskPriority[] = ['critical', 'medium'];

export const TASK_PRIORITY_BADGE_CLASS: Record<TaskPriority, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  medium:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
};

export const TASK_PRIORITY_DOT_CLASS: Record<TaskPriority, string> = {
  critical: 'bg-red-500',
  medium: 'bg-amber-400',
};

export const TASK_TIMEFRAME_LABEL: Record<TaskTimeframe, string> = {
  today: 'Heute',
  week: 'Diese Woche',
  month: 'Diesen Monat',
  year: 'Dieses Jahr',
};

export const TASK_TIMEFRAME_ORDER: TaskTimeframe[] = ['today', 'week', 'month', 'year'];
