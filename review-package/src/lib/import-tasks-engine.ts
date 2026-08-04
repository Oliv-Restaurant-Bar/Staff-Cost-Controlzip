/**
 * import-tasks-engine.ts — Zentrale, reine Import-Aufgaben-Engine
 *
 * Erzeugt für einen gewählten Monat/Jahr automatisch offene Import-Aufgaben
 * pro Importtyp anhand der KONFIGURIERBAREN Frequenz (import-settings.ts):
 *   - taeglich:      eine Aufgabe pro Kalendertag (ohne Ruhetage)
 *   - woechentlich:  eine Aufgabe pro abgeschlossener ISO-Woche; eine
 *                    Monats-übergreifende Woche gehört zum Monat ihres SONNTAGS
 *   - monatlich:     eine Aufgabe pro Monat (Tages-Quellen: Status aus der
 *                    Tages-Abdeckung; Monats-Quellen: monthDone-Flag)
 *   - bei_bedarf / deaktiviert: KEINE Aufgaben (Quelle erscheint nur im Datenstand)
 *
 * Erwartungsbasiert:
 *   - Ruhetage (tenant-weit konfigurierte Wochentage) erzeugen keine
 *     Tagesaufgaben und zählen nie zum Nenner.
 *   - Karenz (delayDays je Quelle): Tag X ist erst ab X+1+delayDays fällig —
 *     der Deckel je Typ ist min(Monatsende, heute − 1 − delayDays).
 *   - Abhängigkeit (dependsOn): fehlt die Basis-Quelle (Z-Bericht) für Tag X,
 *     wird die nachgelagerte Tagesaufgabe (Tagesabschluss) UNTERDRÜCKT
 *     (`suppressedBy`) — es bleibt EINE Hauptwarnung. isOpenTask() ist der
 *     einzige Chokepoint: unterdrückte Aufgaben gelten nicht als offen.
 *
 * WICHTIG: Diese Datei ist DOM-/Supabase-frei und rein (nur Datenlogik).
 * Coverage-Daten liefert src/lib/import-tasks-db.ts. Für wöchentliche
 * Auswertung MÜSSEN die Tages-Coverage-Loader auch die 6 Tage VOR dem
 * Monatsersten mitliefern (Monats-übergreifende Wochen).
 */

import {
  CONFIGURABLE_IMPORT_TYPES,
  IMPORT_TYPE_COVERAGE_KIND,
  type ConfigurableImportType,
  type EffectiveImportSettings,
} from './import-settings';

// ── Typen ────────────────────────────────────────────────────────────────

export type ImportTaskType = ConfigurableImportType;
export { CONFIGURABLE_IMPORT_TYPES };

export type TaskFrequency = 'daily' | 'weekly' | 'monthly';

/** Aufgabenstatus: offen / teilweise erledigt / erledigt / Fehler beim Ermitteln */
export type ImportTaskStatus = 'open' | 'partial' | 'done' | 'error';

export interface TaskPeriod {
  year: number;
  /** 1–12 */
  month: number;
  /** Heutiges Datum als yyyy-MM-dd (Injektion für Testbarkeit) */
  today: string;
}

/** Abdeckung eines Importtyps im gewählten Monat (Input der Engine). */
export interface TypeCoverage {
  /**
   * Bereits importierte Tage (yyyy-MM-dd) — für Tages-Quellen.
   * MUSS für wöchentliche Auswertung auch die 6 Tage vor dem Monatsersten
   * enthalten (Loader-Vertrag, siehe import-tasks-db.ts).
   */
  coveredDays?: readonly string[];
  /** Monat vollständig importiert — für Monats-Quellen. */
  monthDone?: boolean;
  /** Letzter bekannter Importlauf (ISO-Timestamp), falls vorhanden. */
  lastImportAt?: string | null;
  /** Fehler beim Ermitteln der Abdeckung → Aufgabe mit Status 'error'. */
  error?: string | null;
}

export type MonthCoverage = Partial<Record<ImportTaskType, TypeCoverage>>;

export interface DateRange {
  from: string;
  to: string;
}

export interface ImportTask {
  id: string;
  type: ImportTaskType;
  frequency: TaskFrequency;
  /** Anzeige-Label, z. B. „Z-Bericht 04.07.2026" oder „Foratable KW 27 (…)". */
  label: string;
  /** Erwarteter Zeitraum (yyyy-MM-dd) */
  from: string;
  to: string;
  status: ImportTaskStatus;
  /** true bei Monats-Aufgaben, deren Periode noch läuft (dezent anzeigen). */
  notYetDue?: boolean;
  /** Anzahl abgedeckter / erwarteter Tage (weekly/monthly auf Tages-Quellen). */
  coveredDayCount?: number;
  expectedDayCount?: number;
  lastImportAt?: string | null;
  /** Fehlertext bei status 'error' (sichtbar machen, nie still verschlucken). */
  error?: string | null;
  /**
   * Gesetzt, wenn die Aufgabe durch eine fehlende Basis-Quelle unterdrückt ist
   * (z. B. Tagesabschluss wartet auf Z-Bericht). Unterdrückte Aufgaben zählen
   * NICHT als offen (isOpenTask) und mahnen nicht — die Hauptwarnung trägt die
   * Basis-Quelle.
   */
  suppressedBy?: ImportTaskType;
}

export interface ImportTarget {
  /** Zielroute des Import-Flows */
  path: string;
  /** Query-Params (advisory Prefill, niemals harte Einschränkung) */
  params: Record<string, string>;
  /** Fertige URL path?a=b&… */
  href: string;
}

// ── Typ-Definitionen ─────────────────────────────────────────────────────

export interface TaskTypeDef {
  type: ImportTaskType;
  label: string;
  /** Tages- oder Monats-Abdeckung (bestimmt die Aufgaben-Ableitung). */
  coverageKind: 'days' | 'month';
  /** Basis-Quelle: fehlt sie für Tag X, wird die Tagesaufgabe unterdrückt. */
  dependsOn?: ImportTaskType;
}

export const TASK_TYPE_DEFS: readonly TaskTypeDef[] = [
  { type: 'zbericht', label: 'Z-Bericht', coverageKind: 'days' },
  { type: 'gaeste_bon', label: 'Gäste & Bonanalyse', coverageKind: 'days' },
  { type: 'mirus', label: 'Mirus IST-Stunden', coverageKind: 'days' },
  { type: 'tagesabschluss', label: 'Tagesabschluss', coverageKind: 'days', dependsOn: 'zbericht' },
  { type: 'marketing', label: 'Marketing Umsatz', coverageKind: 'days' },
  { type: 'reservationen', label: 'Foratable / Reservationen', coverageKind: 'days' },
  { type: 'erfolgsrechnung', label: 'Erfolgsrechnung IST', coverageKind: 'month' },
  { type: 'warenrechnungen', label: 'Warenrechnungen', coverageKind: 'month' },
  { type: 'inventur', label: 'Inventur', coverageKind: 'month' },
] as const;

export function getTaskTypeDef(type: ImportTaskType): TaskTypeDef {
  const def = TASK_TYPE_DEFS.find(d => d.type === type);
  if (!def) throw new Error(`Unbekannter Importtyp: ${type}`);
  return def;
}

export const FREQUENCY_LABEL: Record<TaskFrequency, string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
};

export const FREQUENCY_ORDER: readonly TaskFrequency[] = ['daily', 'weekly', 'monthly'];

export const TASK_STATUS_LABEL: Record<ImportTaskStatus, string> = {
  open: 'Offen',
  partial: 'Teilweise erledigt',
  done: 'Erledigt',
  error: 'Fehler',
};

// ── Datums-Helfer (rein, UTC-sicher, ohne Abhängigkeiten) ────────────────

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthStartIso(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function monthEndIso(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

/** ISO-Wochentag 1=Mo … 7=So. */
export function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** ISO-Wochen-ID, z. B. „2026-W27" (Woche des übergebenen Tages). */
export function isoWeekId(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // 0=Mo
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Donnerstag dieser ISO-Woche
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** yyyy-MM-dd → dd.MM.yyyy */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** dd.MM. (ohne Jahr) für kompakte Zeitraum-Labels */
function formatDayMonth(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

export function formatIsoRange(from: string, to: string): string {
  if (from === to) return formatIsoDate(from);
  return `${formatDayMonth(from)}–${formatIsoDate(to)}`;
}

export const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES_DE[month - 1]} ${year}`;
}

/** Anzahl Kalendertage in [from, to] (beide inklusive). */
export function rangeDayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd);
  return Math.round(ms / 86_400_000) + 1;
}

/** Erwartete Tage in [from, to] ohne Ruhetage (ISO-Wochentage). */
export function expectedDaysInRange(
  from: string,
  to: string,
  restWeekdays: readonly number[],
): string[] {
  if (from > to) return [];
  const rest = new Set(restWeekdays);
  const days: string[] = [];
  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    if (!rest.has(isoWeekday(day))) days.push(day);
  }
  return days;
}

// ── Kern: Restzeitraum-Berechnung ────────────────────────────────────────

/**
 * Zerlegt den erwarteten Zeitraum [from, to] anhand der abgedeckten Tage in
 * zusammenhängende offene Restzeiträume. Leeres Ergebnis = alles abgedeckt.
 */
export function computeOpenRanges(
  from: string,
  to: string,
  coveredDays: readonly string[],
): DateRange[] {
  if (from > to) return [];
  const covered = new Set(coveredDays);
  const result: DateRange[] = [];
  let rangeStart: string | null = null;
  for (let day = from; day <= to; day = addDaysIso(day, 1)) {
    if (covered.has(day)) {
      if (rangeStart !== null) {
        result.push({ from: rangeStart, to: addDaysIso(day, -1) });
        rangeStart = null;
      }
    } else if (rangeStart === null) {
      rangeStart = day;
    }
  }
  if (rangeStart !== null) result.push({ from: rangeStart, to });
  return result;
}

/** Abgedeckte Tage innerhalb [from, to] — für Konflikt-Erkennung. */
export function coveredDaysInRange(
  from: string,
  to: string,
  coveredDays: readonly string[],
): string[] {
  return [...coveredDays].filter(d => d >= from && d <= to).sort();
}

/**
 * Konflikt-Prüfung vor einem Import: liegt im Zielzeitraum bereits etwas vor?
 * (Der eigentliche Behalten/Ersetzen-Flow bleibt in den bestehenden Importpfaden.)
 */
export function checkImportConflict(
  task: Pick<ImportTask, 'type' | 'from' | 'to'>,
  coverage: MonthCoverage,
): { hasConflict: boolean; coveredDays: string[] } {
  const cov = coverage[task.type];
  if (!cov) return { hasConflict: false, coveredDays: [] };
  if (IMPORT_TYPE_COVERAGE_KIND[task.type] === 'month') {
    return { hasConflict: cov.monthDone === true, coveredDays: [] };
  }
  const days = coveredDaysInRange(task.from, task.to, cov.coveredDays ?? []);
  return { hasConflict: days.length > 0, coveredDays: days };
}

// ── Aufgaben-Erzeugung ───────────────────────────────────────────────────

function errorTask(def: TaskTypeDef, frequency: TaskFrequency, from: string, to: string, error: string): ImportTask {
  return {
    id: `${def.type}:error`,
    type: def.type,
    frequency,
    label: def.label,
    from,
    to,
    status: 'error',
    error,
  };
}

function buildDailyTasks(
  def: TaskTypeDef,
  from: string,
  cap: string,
  cov: TypeCoverage,
  restWeekdays: readonly number[],
): ImportTask[] {
  if (from > cap) return [];
  const covered = new Set(cov.coveredDays ?? []);
  const tasks: ImportTask[] = [];
  for (const day of expectedDaysInRange(from, cap, restWeekdays)) {
    tasks.push({
      id: `${def.type}:${day}`,
      type: def.type,
      frequency: 'daily',
      label: `${def.label} ${formatIsoDate(day)}`,
      from: day,
      to: day,
      status: covered.has(day) ? 'done' : 'open',
      lastImportAt: cov.lastImportAt ?? null,
    });
  }
  return tasks;
}

/**
 * Wöchentliche Aufgaben: eine pro ISO-Woche, deren SONNTAG im gewählten Monat
 * liegt UND bereits vergangen ist (Aufgabe erst nach dem Wochenende, inkl.
 * Karenz-Deckel). Erwartete Tage = ganze Woche (Mo–So) ohne Ruhetage — dafür
 * müssen die Coverage-Loader die 6 Tage vor dem Monatsersten mitliefern.
 */
function buildWeeklyTasks(
  def: TaskTypeDef,
  period: TaskPeriod,
  cap: string,
  cov: TypeCoverage,
  restWeekdays: readonly number[],
): ImportTask[] {
  const monthStart = monthStartIso(period.year, period.month);
  const monthEnd = monthEndIso(period.year, period.month);
  const covered = new Set(cov.coveredDays ?? []);
  const tasks: ImportTask[] = [];

  // Ersten Sonntag des Monats finden, dann in 7-Tages-Schritten weiter.
  let sunday = monthStart;
  while (isoWeekday(sunday) !== 7) sunday = addDaysIso(sunday, 1);
  for (; sunday <= monthEnd && sunday <= cap; sunday = addDaysIso(sunday, 7)) {
    const monday = addDaysIso(sunday, -6);
    const expected = expectedDaysInRange(monday, sunday, restWeekdays);
    if (expected.length === 0) continue; // Woche komplett aus Ruhetagen
    const coveredCount = expected.filter(d => covered.has(d)).length;
    const status: ImportTaskStatus =
      coveredCount === expected.length ? 'done' : coveredCount > 0 ? 'partial' : 'open';
    const weekId = isoWeekId(sunday);
    tasks.push({
      id: `${def.type}:week:${weekId}`,
      type: def.type,
      frequency: 'weekly',
      label: `${def.label} KW ${weekId.slice(-2)} (${formatIsoRange(monday, sunday)})`,
      from: monday,
      to: sunday,
      status,
      coveredDayCount: coveredCount,
      expectedDayCount: expected.length,
      lastImportAt: cov.lastImportAt ?? null,
    });
  }
  return tasks;
}

/** Monats-Aufgabe für Tages-Quellen: Status aus der Tages-Abdeckung bis zum Deckel. */
function buildMonthlyTaskFromDays(
  def: TaskTypeDef,
  period: TaskPeriod,
  cap: string,
  cov: TypeCoverage,
  restWeekdays: readonly number[],
): ImportTask[] {
  const from = monthStartIso(period.year, period.month);
  const to = monthEndIso(period.year, period.month);
  if (from > cap) return [];
  const expected = expectedDaysInRange(from, cap, restWeekdays);
  if (expected.length === 0) return [];
  const covered = new Set(cov.coveredDays ?? []);
  const coveredCount = expected.filter(d => covered.has(d)).length;
  const status: ImportTaskStatus =
    coveredCount === expected.length ? 'done' : coveredCount > 0 ? 'partial' : 'open';
  return [{
    id: `${def.type}:${period.year}-${String(period.month).padStart(2, '0')}`,
    type: def.type,
    frequency: 'monthly',
    label: `${def.label} ${monthLabel(period.year, period.month)}`,
    from,
    to,
    status,
    notYetDue: status !== 'done' && period.today <= to,
    coveredDayCount: coveredCount,
    expectedDayCount: expected.length,
    lastImportAt: cov.lastImportAt ?? null,
  }];
}

/** Monats-Aufgabe für Monats-Quellen (monthDone-Flag). */
function buildMonthlyTask(def: TaskTypeDef, period: TaskPeriod, cov: TypeCoverage): ImportTask {
  const from = monthStartIso(period.year, period.month);
  const to = monthEndIso(period.year, period.month);
  return {
    id: `${def.type}:${period.year}-${String(period.month).padStart(2, '0')}`,
    type: def.type,
    frequency: 'monthly',
    label: `${def.label} ${monthLabel(period.year, period.month)}`,
    from,
    to,
    status: cov.monthDone ? 'done' : 'open',
    notYetDue: !cov.monthDone && period.today <= to,
    lastImportAt: cov.lastImportAt ?? null,
  };
}

/**
 * Abhängigkeits-Unterdrückung: offene TAGES-Aufgaben eines Typs mit
 * `dependsOn` werden unterdrückt, wenn die Basis-Quelle für denselben Tag
 * fehlt — EINE Hauptwarnung (Basis-Quelle) statt Doppel-Warnungen.
 * Keine Unterdrückung, wenn die Basis-Quelle keine Aufgaben erzeugt
 * (bei_bedarf/deaktiviert) oder ihre Abdeckung nicht ermittelbar war.
 */
function applyDependencySuppression(
  tasks: ImportTask[],
  coverage: MonthCoverage,
  settings: EffectiveImportSettings,
): void {
  for (const def of TASK_TYPE_DEFS) {
    const dep = def.dependsOn;
    if (!dep) continue;
    const depFrequency = settings.types[dep].frequency;
    if (depFrequency === 'bei_bedarf' || depFrequency === 'deaktiviert') continue;
    const depCov = coverage[dep];
    if (depCov?.error) continue;
    const depCovered = new Set(depCov?.coveredDays ?? []);
    for (const task of tasks) {
      if (task.type !== def.type || task.frequency !== 'daily') continue;
      if (task.status !== 'open') continue;
      if (!depCovered.has(task.from)) task.suppressedBy = dep;
    }
  }
}

/**
 * Erzeugt alle Import-Aufgaben für den gewählten Monat anhand der effektiven
 * Einstellungen (Frequenz, Karenz, Ruhetage). Tages-/Wochen-Aufgaben sind je
 * Typ auf min(Monatsende, heute − 1 − delayDays) gedeckelt.
 */
export function buildImportTasks(
  period: TaskPeriod,
  coverage: MonthCoverage,
  settings: EffectiveImportSettings,
): ImportTask[] {
  const from = monthStartIso(period.year, period.month);
  const monthEnd = monthEndIso(period.year, period.month);

  const tasks: ImportTask[] = [];
  for (const def of TASK_TYPE_DEFS) {
    const ts = settings.types[def.type];
    if (ts.frequency === 'bei_bedarf' || ts.frequency === 'deaktiviert') continue;
    const cov: TypeCoverage = coverage[def.type] ?? {};
    const capRaw = addDaysIso(period.today, -1 - ts.delayDays);
    const cap = capRaw < monthEnd ? capRaw : monthEnd;
    if (cov.error) {
      const freq: TaskFrequency =
        ts.frequency === 'taeglich' ? 'daily' : ts.frequency === 'woechentlich' ? 'weekly' : 'monthly';
      tasks.push(errorTask(def, freq, from, monthEnd, cov.error));
      continue;
    }
    if (def.coverageKind === 'month') {
      // Monats-Quellen kennen nur 'monatlich' (resolveImportSettings klemmt Rest).
      tasks.push(buildMonthlyTask(def, period, cov));
      continue;
    }
    switch (ts.frequency) {
      case 'taeglich':
        tasks.push(...buildDailyTasks(def, from, cap, cov, settings.restWeekdays));
        break;
      case 'woechentlich':
        tasks.push(...buildWeeklyTasks(def, period, cap, cov, settings.restWeekdays));
        break;
      case 'monatlich':
        tasks.push(...buildMonthlyTaskFromDays(def, period, cap, cov, settings.restWeekdays));
        break;
    }
  }
  applyDependencySuppression(tasks, coverage, settings);
  return tasks;
}

// ── Gruppierung & Zusammenfassung ────────────────────────────────────────

export interface ImportTaskGroups {
  daily: ImportTask[];
  weekly: ImportTask[];
  monthly: ImportTask[];
}

export function groupImportTasks(tasks: readonly ImportTask[]): ImportTaskGroups {
  const groups: ImportTaskGroups = { daily: [], weekly: [], monthly: [] };
  for (const t of tasks) groups[t.frequency].push(t);
  return groups;
}

/**
 * EINZIGER Chokepoint für „gilt als offen": offene/teilweise/fehlerhafte
 * Aufgaben, die NICHT durch eine fehlende Basis-Quelle unterdrückt sind.
 */
export function isOpenTask(task: Pick<ImportTask, 'status' | 'suppressedBy'>): boolean {
  if (task.suppressedBy) return false;
  return task.status === 'open' || task.status === 'partial' || task.status === 'error';
}

export interface ImportTaskKpis {
  open: number;
  partial: number;
  done: number;
  error: number;
}

export function summarizeImportTasks(tasks: readonly ImportTask[]): ImportTaskKpis {
  const kpis: ImportTaskKpis = { open: 0, partial: 0, done: 0, error: 0 };
  for (const t of tasks) kpis[t.status] += 1;
  return kpis;
}

// ── Navigation: Import direkt aus der Aufgabe ────────────────────────────

/**
 * Zielroute + Prefill-Params für den „Importieren"-Button einer Aufgabe.
 * Die Params sind ADVISORY: Zielseiten zeigen den erwarteten Zeitraum an
 * und wählen ihn vor, schränken Uploads aber nie hart ein.
 */
export function buildImportTarget(
  task: Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to'>,
): ImportTarget {
  const scope = task.frequency === 'daily' ? 'day'
    : task.frequency === 'weekly' ? 'range'
    : 'month';
  const year = task.from.slice(0, 4);
  const month = String(Number(task.from.slice(5, 7)));
  const monat = `${task.from.slice(0, 4)}-${task.from.slice(5, 7)}`;

  let path: string;
  let params: Record<string, string>;
  switch (task.type) {
    case 'zbericht':
      path = '/gastronovi-import';
      params = { from: task.from, to: task.to, scope };
      break;
    case 'gaeste_bon':
      path = '/gastronovi-import';
      params = { target: 'kpi', from: task.from, to: task.to, scope };
      break;
    case 'mirus':
      path = '/import';
      params = { target: 'mirus', from: task.from, to: task.to, scope };
      break;
    case 'tagesabschluss':
      path = '/tagesabschluesse';
      params = { monat };
      break;
    case 'marketing':
      path = '/import';
      params = { target: 'maison', from: task.from, to: task.to, scope };
      break;
    case 'reservationen':
      path = '/foratable-import';
      params = { from: task.from, to: task.to, scope };
      break;
    case 'erfolgsrechnung':
      path = '/reporting';
      params = { target: 'erfolgsrechnung', year, month };
      break;
    case 'warenrechnungen':
      path = '/warenrechnungen';
      params = { monat };
      break;
    case 'inventur':
      // Kein Importpfad — manuelles Monats-Häkchen im Cockpit selbst.
      path = '/import-cockpit';
      params = {};
      break;
  }
  const search = new URLSearchParams(params).toString();
  return { path, params, href: search ? `${path}?${search}` : path };
}

/**
 * „Ganzen Monat importieren"-Aufgabe für einen Tages-Typ
 * (immer verfügbar, auch wenn die Engine Restaufgaben vorschlägt).
 */
export function buildFullMonthTask(
  type: ImportTaskType,
  period: Pick<TaskPeriod, 'year' | 'month'>,
): Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to' | 'label'> {
  const def = getTaskTypeDef(type);
  return {
    type,
    frequency: 'monthly',
    from: monthStartIso(period.year, period.month),
    to: monthEndIso(period.year, period.month),
    label: `${def.label} ${monthLabel(period.year, period.month)}`,
  };
}
