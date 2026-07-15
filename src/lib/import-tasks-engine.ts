/**
 * import-tasks-engine.ts — Zentrale, reine Import-Aufgaben-Engine
 *
 * Erzeugt für einen gewählten Monat/Jahr automatisch offene Import-Aufgaben
 * pro Importtyp anhand der Frequenz:
 *   - daily:   eine Aufgabe pro Kalendertag (Z-Bericht, Foratable)
 *   - range:   zeitraum-basiert mit Teilzeitraum-Restberechnung
 *              (Umsatz, Verkaufsdaten, Mirus, Marketing)
 *   - monthly: eine Aufgabe pro Monat (Erfolgsrechnung, IST-Kosten)
 *   - yearly:  eine Aufgabe pro Jahr (Budget)
 *
 * WICHTIG: Diese Datei ist DOM-/Supabase-frei und rein (nur Datenlogik).
 * Coverage-Daten werden von src/lib/import-tasks-db.ts geliefert.
 * Erwartete Zeiträume sind IMMER auf min(Monatsende, gestern) gedeckelt —
 * für zukünftige Tage entstehen keine Aufgaben.
 */

// ── Typen ────────────────────────────────────────────────────────────────

export type ImportTaskType =
  | 'zbericht'
  | 'reservationen'
  | 'umsatz'
  | 'verkaufsdaten'
  | 'mirus'
  | 'marketing'
  | 'erfolgsrechnung'
  | 'istkosten'
  | 'budget';

export type TaskFrequency = 'daily' | 'range' | 'monthly' | 'yearly';

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
  /** Bereits importierte Tage (yyyy-MM-dd) — für daily- und range-Typen. */
  coveredDays?: readonly string[];
  /** Monat vollständig importiert — für monthly-Typen. */
  monthDone?: boolean;
  /** Jahr vollständig importiert — für yearly-Typen. */
  yearDone?: boolean;
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
  /** Anzeige-Label, z. B. „Z-Bericht 04.07.2026" oder „Umsatz 09.07.–31.07.2026" */
  label: string;
  /** Erwarteter Zeitraum (yyyy-MM-dd) */
  from: string;
  to: string;
  status: ImportTaskStatus;
  /** true bei monthly/yearly-Aufgaben, deren Periode noch läuft (dezent anzeigen). */
  notYetDue?: boolean;
  /** Anzahl abgedeckter / erwarteter Tage (nur range-Typen, für Fortschrittstext). */
  coveredDayCount?: number;
  expectedDayCount?: number;
  lastImportAt?: string | null;
  /** Fehlertext bei status 'error' (sichtbar machen, nie still verschlucken). */
  error?: string | null;
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
  frequency: TaskFrequency;
}

export const TASK_TYPE_DEFS: readonly TaskTypeDef[] = [
  { type: 'zbericht', label: 'Z-Bericht', frequency: 'daily' },
  { type: 'reservationen', label: 'Foratable / Reservationen', frequency: 'daily' },
  { type: 'umsatz', label: 'Umsatz', frequency: 'range' },
  { type: 'verkaufsdaten', label: 'Verkaufsdaten', frequency: 'range' },
  { type: 'mirus', label: 'Mirus Stunden', frequency: 'range' },
  { type: 'marketing', label: 'Marketing Umsatz', frequency: 'range' },
  { type: 'erfolgsrechnung', label: 'Erfolgsrechnung / Kontoblätter', frequency: 'monthly' },
  { type: 'istkosten', label: 'IST-Kosten Buchhaltung', frequency: 'monthly' },
  { type: 'budget', label: 'Budget', frequency: 'yearly' },
] as const;

export function getTaskTypeDef(type: ImportTaskType): TaskTypeDef {
  const def = TASK_TYPE_DEFS.find(d => d.type === type);
  if (!def) throw new Error(`Unbekannter Importtyp: ${type}`);
  return def;
}

export const FREQUENCY_LABEL: Record<TaskFrequency, string> = {
  daily: 'Täglich',
  range: 'Zeitraum-basiert',
  monthly: 'Monatlich',
  yearly: 'Jährlich',
};

export const FREQUENCY_ORDER: readonly TaskFrequency[] = ['daily', 'range', 'monthly', 'yearly'];

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
  task: Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to'>,
  coverage: MonthCoverage,
): { hasConflict: boolean; coveredDays: string[] } {
  const cov = coverage[task.type];
  if (!cov) return { hasConflict: false, coveredDays: [] };
  if (task.frequency === 'monthly') {
    return { hasConflict: cov.monthDone === true, coveredDays: [] };
  }
  if (task.frequency === 'yearly') {
    return { hasConflict: cov.yearDone === true, coveredDays: [] };
  }
  const days = coveredDaysInRange(task.from, task.to, cov.coveredDays ?? []);
  return { hasConflict: days.length > 0, coveredDays: days };
}

// ── Aufgaben-Erzeugung ───────────────────────────────────────────────────

function errorTask(def: TaskTypeDef, from: string, to: string, error: string): ImportTask {
  return {
    id: `${def.type}:error`,
    type: def.type,
    frequency: def.frequency,
    label: def.label,
    from,
    to,
    status: 'error',
    error,
  };
}

function buildDailyTasks(def: TaskTypeDef, from: string, cap: string, cov: TypeCoverage): ImportTask[] {
  if (from > cap) return [];
  const covered = new Set(cov.coveredDays ?? []);
  const tasks: ImportTask[] = [];
  for (let day = from; day <= cap; day = addDaysIso(day, 1)) {
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

function buildRangeTasks(def: TaskTypeDef, from: string, cap: string, cov: TypeCoverage): ImportTask[] {
  if (from > cap) return [];
  const coveredDays = coveredDaysInRange(from, cap, cov.coveredDays ?? []);
  const openRanges = computeOpenRanges(from, cap, coveredDays);
  const expectedDayCount = rangeDayCount(from, cap);
  const hasCoverage = coveredDays.length > 0;

  if (openRanges.length === 0) {
    // Alles abgedeckt → EINE erledigte Aufgabe für den ganzen erwarteten Zeitraum.
    return [{
      id: `${def.type}:${from}:${cap}`,
      type: def.type,
      frequency: 'range',
      label: `${def.label} ${formatIsoRange(from, cap)}`,
      from,
      to: cap,
      status: 'done',
      coveredDayCount: coveredDays.length,
      expectedDayCount,
      lastImportAt: cov.lastImportAt ?? null,
    }];
  }

  // Pro zusammenhängendem Restzeitraum eine Aufgabe; „partial" wenn der Typ im
  // Monat schon Teilabdeckung hat (Teilimport erledigt Teilzeitraum).
  return openRanges.map(r => ({
    id: `${def.type}:${r.from}:${r.to}`,
    type: def.type,
    frequency: 'range' as const,
    label: `${def.label} ${formatIsoRange(r.from, r.to)}`,
    from: r.from,
    to: r.to,
    status: hasCoverage ? ('partial' as const) : ('open' as const),
    coveredDayCount: coveredDays.length,
    expectedDayCount,
    lastImportAt: cov.lastImportAt ?? null,
  }));
}

function buildMonthlyTask(
  def: TaskTypeDef,
  period: TaskPeriod,
  cov: TypeCoverage,
): ImportTask {
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

function buildYearlyTask(def: TaskTypeDef, period: TaskPeriod, cov: TypeCoverage): ImportTask {
  return {
    id: `${def.type}:${period.year}`,
    type: def.type,
    frequency: 'yearly',
    label: `${def.label} ${period.year}`,
    from: `${period.year}-01-01`,
    to: `${period.year}-12-31`,
    status: cov.yearDone ? 'done' : 'open',
    lastImportAt: cov.lastImportAt ?? null,
  };
}

/**
 * Erzeugt alle Import-Aufgaben für den gewählten Monat.
 * Tages-/Zeitraum-Aufgaben sind auf min(Monatsende, gestern) gedeckelt.
 */
export function buildImportTasks(period: TaskPeriod, coverage: MonthCoverage): ImportTask[] {
  const from = monthStartIso(period.year, period.month);
  const monthEnd = monthEndIso(period.year, period.month);
  const yesterday = addDaysIso(period.today, -1);
  const cap = yesterday < monthEnd ? yesterday : monthEnd;

  const tasks: ImportTask[] = [];
  for (const def of TASK_TYPE_DEFS) {
    const cov: TypeCoverage = coverage[def.type] ?? {};
    if (cov.error) {
      tasks.push(errorTask(def, from, monthEnd, cov.error));
      continue;
    }
    switch (def.frequency) {
      case 'daily':
        tasks.push(...buildDailyTasks(def, from, cap, cov));
        break;
      case 'range':
        tasks.push(...buildRangeTasks(def, from, cap, cov));
        break;
      case 'monthly':
        tasks.push(buildMonthlyTask(def, period, cov));
        break;
      case 'yearly':
        tasks.push(buildYearlyTask(def, period, cov));
        break;
    }
  }
  return tasks;
}

// ── Gruppierung & Zusammenfassung ────────────────────────────────────────

export interface ImportTaskGroups {
  daily: ImportTask[];
  range: ImportTask[];
  monthly: ImportTask[];
  yearly: ImportTask[];
}

export function groupImportTasks(tasks: readonly ImportTask[]): ImportTaskGroups {
  const groups: ImportTaskGroups = { daily: [], range: [], monthly: [], yearly: [] };
  for (const t of tasks) groups[t.frequency].push(t);
  return groups;
}

export function isOpenTask(task: Pick<ImportTask, 'status'>): boolean {
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
    : task.frequency === 'range' ? 'range'
    : task.frequency === 'monthly' ? 'month'
    : 'year';
  const year = task.from.slice(0, 4);
  const month = String(Number(task.from.slice(5, 7)));

  let path: string;
  let params: Record<string, string>;
  switch (task.type) {
    case 'zbericht':
      path = '/gastronovi-import';
      params = { from: task.from, to: task.to, scope };
      break;
    case 'reservationen':
      path = '/foratable-import';
      params = { from: task.from, to: task.to, scope };
      break;
    case 'umsatz':
      path = '/import';
      params = { target: 'tagesumsatz', from: task.from, to: task.to, scope };
      break;
    case 'verkaufsdaten':
      path = '/sales-upload';
      params = { from: task.from, to: task.to, scope };
      break;
    case 'mirus':
      path = '/import';
      params = { target: 'mirus', from: task.from, to: task.to, scope };
      break;
    case 'marketing':
      path = '/import';
      params = { target: 'maison', from: task.from, to: task.to, scope };
      break;
    case 'erfolgsrechnung':
      path = '/reporting';
      params = { target: 'erfolgsrechnung', year, month };
      break;
    case 'istkosten':
      path = '/reporting';
      params = { target: 'istkosten', year, month };
      break;
    case 'budget':
      path = '/budget';
      params = { year };
      break;
  }
  const search = new URLSearchParams(params).toString();
  return { path, params, href: `${path}?${search}` };
}

/**
 * „Ganzen Monat importieren"-Aufgabe für einen zeitraum-basierten Typ
 * (immer verfügbar, auch wenn die Engine Restaufgaben vorschlägt).
 */
export function buildFullMonthTask(
  type: ImportTaskType,
  period: Pick<TaskPeriod, 'year' | 'month'>,
): Pick<ImportTask, 'type' | 'frequency' | 'from' | 'to' | 'label'> {
  const def = getTaskTypeDef(type);
  return {
    type,
    frequency: def.frequency,
    from: monthStartIso(period.year, period.month),
    to: monthEndIso(period.year, period.month),
    label: `${def.label} ${monthLabel(period.year, period.month)}`,
  };
}
