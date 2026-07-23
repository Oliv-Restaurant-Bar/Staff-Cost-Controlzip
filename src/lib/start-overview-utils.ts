/**
 * start-overview-utils.ts — Reine Logik für die vereinfachte Startseite (Admin).
 * ============================================================================
 * KEIN React / Supabase / DOM hier — nur date-fns + die reine Cockpit-Logik.
 *
 * Die Startseite zeigt 4 Statuskarten („Heute") + daraus abgeleitete Warnungen
 * („nur echte Handlungsbedarfe"). Es gibt bewusst KEINE eigenen Frische-Regeln:
 *   - Umsatzimport / Reservationen: Status kommt 1:1 aus `computeSourceStatus`
 *     (Import-Cockpit, Single Source of Truth für Frische-Schwellen).
 *   - Dienstplan: einfacher Datumsvergleich auf „geplant bis" (dataUntil des
 *     Cockpit-Signals) — geplant bis ≥ heute+7 Tage = in Ordnung.
 *   - Tagesabschluss: gestriger Tag im Adyen-Abgleich bestätigt? (read-only aus
 *     dem adyenAbstimmung_v1-Blob, NIE über die Save-Schicht).
 *
 * Warnungen = exakt die Karten mit Status `action`. `due_soon` ist bewusst
 * KEINE Warnung (bald fällig ≠ echter Handlungsbedarf), `unknown` ebenfalls
 * nicht (fehlende Einrichtung soll die Startseite nicht zuspammen).
 */

import { addDays, format, parseISO } from 'date-fns';
import {
  COCKPIT_SOURCES,
  computeSourceStatus,
  formatCockpitDate,
  type CockpitSignal,
  type CockpitSourceDef,
  type CockpitSourceId,
  type CockpitStatus,
} from './import-cockpit';
import {
  buildFullMonthTask,
  buildImportTarget,
  rangeDayCount,
  TASK_TYPE_DEFS,
  type DateRange,
  type ImportTask,
  type ImportTaskType,
} from './import-tasks-engine';
import type { PrioritizedTask, TypeCompletion } from './import-tasks-priority';
import { UMSATZ_MONTH_TONE, type UmsatzMonthSummary } from './umsatzabstimmung-status';

// ─── Typen ───────────────────────────────────────────────────────────────────

export type StartCardId = 'umsatz' | 'reservationen' | 'dienstplan' | 'tagesabschluss';

/**
 * Karten-Status der Startseite:
 * - ok       → grün:  alles aktuell
 * - due_soon → gelb:  bald fällig (Hinweis, KEINE Warnung)
 * - action   → rot:   echter Handlungsbedarf (erscheint unter „Warnungen")
 * - unknown  → grau:  keine Daten / nicht eingerichtet (KEINE Warnung)
 */
export type StartCardStatus = 'ok' | 'due_soon' | 'action' | 'unknown';

export interface StartCard {
  id: StartCardId;
  title: string;
  status: StartCardStatus;
  statusLabel: string;
  /** Kurzer deutscher Zustandstext, z. B. „Aktuell – Ist-Daten bis 07.07.2026". */
  detail: string;
  /** Zielroute der Detailseite („Öffnen"). */
  route: string;
}

export interface StartWarning {
  id: StartCardId;
  text: string;
  route: string;
}

export interface StartTagesabschlussInput {
  /**
   * true  = gestriger Tag ist im Adyen-Abgleich bestätigt,
   * false = Abgleichsdaten vorhanden, gestern aber (noch) nicht bestätigt,
   * null  = noch gar keine Tagesabschluss-Daten (nicht eingerichtet).
   */
  yesterdayConfirmed: boolean | null;
  /** Letzter bestätigter Tag (yyyy-MM-dd) oder null. */
  lastConfirmedDate: string | null;
}

export interface StartOverviewInput {
  /** Heutiges Datum (yyyy-MM-dd) — explizit für deterministische Tests. */
  todayIso: string;
  signals: {
    zbericht: CockpitSignal;
    reservationen: CockpitSignal;
    dienstplanung: CockpitSignal;
  };
  tagesabschluss: StartTagesabschlussInput;
}

export interface StartOverviewResult {
  cards: StartCard[];
  warnings: StartWarning[];
}

// ─── Anzeige-Konstanten ──────────────────────────────────────────────────────

export const START_STATUS_LABEL: Record<StartCardStatus, string> = {
  ok: 'Aktuell',
  due_soon: 'Bald fällig',
  action: 'Handlungsbedarf',
  unknown: 'Keine Daten',
};

/** Dienstplan gilt als „in Ordnung", wenn er mindestens so viele Tage vorausgeplant ist. */
export const DIENSTPLAN_MIN_DAYS_AHEAD = 7;

// ─── Helfer ──────────────────────────────────────────────────────────────────

function sourceDef(id: CockpitSourceId): CockpitSourceDef {
  const def = COCKPIT_SOURCES.find((s) => s.id === id);
  if (!def) throw new Error(`Unbekannte Cockpit-Quelle: ${id}`);
  return def;
}

/** Cockpit-Status → Karten-Status. `never` ist echter Handlungsbedarf (nie importiert). */
export function startStatusFromCockpit(status: CockpitStatus): StartCardStatus {
  switch (status) {
    case 'current':
      return 'ok';
    case 'due_soon':
      return 'due_soon';
    case 'overdue':
    case 'never':
      return 'action';
    case 'uncheckable':
    default:
      return 'unknown';
  }
}

/** Karte aus einem Cockpit-Signal (Umsatzimport / Reservationen) — Frische-Regeln 1:1 aus dem Cockpit. */
function cardFromCockpitSource(
  id: StartCardId,
  title: string,
  sourceId: CockpitSourceId,
  signal: CockpitSignal,
  todayIso: string,
): StartCard {
  const def = sourceDef(sourceId);
  const result = computeSourceStatus(def, signal, parseISO(todayIso));
  const status = startStatusFromCockpit(result.status);
  const detail = result.status === 'never' ? 'Noch nie importiert' : result.reason;
  return { id, title, status, statusLabel: START_STATUS_LABEL[status], detail, route: def.route ?? '/' };
}

/** Dienstplan-Karte: einfacher Vergleich „geplant bis" vs. heute(+7). */
export function dienstplanCard(signal: CockpitSignal, todayIso: string): StartCard {
  const base = { id: 'dienstplan' as const, title: 'Dienstplan', route: '/personal' };
  const plannedUntil = signal.dataUntil ?? signal.latestDataDate;
  if (!plannedUntil) {
    return {
      ...base,
      status: 'action',
      statusLabel: START_STATUS_LABEL.action,
      detail: 'Noch kein Dienstplan erfasst',
    };
  }
  const horizon = format(addDays(parseISO(todayIso), DIENSTPLAN_MIN_DAYS_AHEAD), 'yyyy-MM-dd');
  const fmt = formatCockpitDate(plannedUntil);
  if (plannedUntil < todayIso) {
    return {
      ...base,
      status: 'action',
      statusLabel: START_STATUS_LABEL.action,
      detail: `Plan endet am ${fmt} — keine geplanten Schichten mehr`,
    };
  }
  if (plannedUntil < horizon) {
    return {
      ...base,
      status: 'due_soon',
      statusLabel: START_STATUS_LABEL.due_soon,
      detail: `Geplant bis ${fmt} — weniger als ${DIENSTPLAN_MIN_DAYS_AHEAD} Tage im Voraus`,
    };
  }
  return { ...base, status: 'ok', statusLabel: START_STATUS_LABEL.ok, detail: `Geplant bis ${fmt}` };
}

/** Tagesabschluss-Karte: gestriger Tag bestätigt? */
export function tagesabschlussCard(input: StartTagesabschlussInput, todayIso: string): StartCard {
  const base = { id: 'tagesabschluss' as const, title: 'Tagesabschluss', route: '/tagesabschluesse' };
  const yesterday = format(addDays(parseISO(todayIso), -1), 'yyyy-MM-dd');
  const fmtYesterday = formatCockpitDate(yesterday);
  if (input.yesterdayConfirmed === null) {
    return {
      ...base,
      status: 'unknown',
      statusLabel: START_STATUS_LABEL.unknown,
      detail: 'Noch keine Tagesabschluss-Daten vorhanden',
    };
  }
  if (input.yesterdayConfirmed) {
    return {
      ...base,
      status: 'ok',
      statusLabel: START_STATUS_LABEL.ok,
      detail: `Gestern (${fmtYesterday}) bestätigt`,
    };
  }
  const lastHint = input.lastConfirmedDate
    ? ` — zuletzt bestätigt: ${formatCockpitDate(input.lastConfirmedDate)}`
    : '';
  return {
    ...base,
    status: 'action',
    statusLabel: START_STATUS_LABEL.action,
    detail: `Gestern (${fmtYesterday}) noch nicht bestätigt${lastHint}`,
  };
}

/**
 * Leitet den Tagesabschluss-Input read-only aus den Blob-Bestandteilen ab.
 * `hasAnyAdyenData` = es existieren importierte Adyen-Tage. Ohne Daten UND ohne
 * je eine Bestätigung → null (nicht eingerichtet, keine Warnung).
 */
export function tagesabschlussFromConfirmations(
  confirmations: Record<string, { confirmed?: boolean }>,
  hasAnyAdyenData: boolean,
  todayIso: string,
): StartTagesabschlussInput {
  const confirmedDates = Object.entries(confirmations)
    .filter(([date, c]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && c?.confirmed === true)
    .map(([date]) => date)
    .sort();
  if (!hasAnyAdyenData && confirmedDates.length === 0) {
    return { yesterdayConfirmed: null, lastConfirmedDate: null };
  }
  const yesterday = format(addDays(parseISO(todayIso), -1), 'yyyy-MM-dd');
  return {
    yesterdayConfirmed: confirmations[yesterday]?.confirmed === true,
    lastConfirmedDate: confirmedDates.at(-1) ?? null,
  };
}

// ─── Fehlende Tage kompakt formatieren ───────────────────────────────────────

/** Kompaktes Bereichs-Label ohne Jahr: „08.07." / „03.–05.07." / „28.06.–02.07.". */
export function formatShortRange(range: DateRange): string {
  const [fy, fm, fd] = range.from.split('-');
  const [ty, tm, td] = range.to.split('-');
  if (range.from === range.to) return `${fd}.${fm}.`;
  if (fy === ty && fm === tm) return `${fd}.–${td}.${tm}.`;
  return `${fd}.${fm}.–${td}.${tm}.`;
}

/**
 * Fehlende Tage kompakt: höchstens `maxRanges` Bereiche ausschreiben, Rest als
 * „+ N weitere" (N = fehlende Kalendertage in den weggekürzten Bereichen).
 * Leere Eingabe → leerer String (fehlend ≠ 0: nie „0 Tage" erzeugen).
 * Erwartet bereits GEMERGTE Bereiche (mergeOpenRanges) — hier wird NUR formatiert.
 */
export function formatMissingDays(ranges: readonly DateRange[], maxRanges = 2): string {
  if (ranges.length === 0) return '';
  const shown = ranges.slice(0, maxRanges).map(formatShortRange).join(', ');
  const rest = ranges.slice(maxRanges);
  if (rest.length === 0) return shown;
  const restDays = rest.reduce((sum, r) => sum + rangeDayCount(r.from, r.to), 0);
  return `${shown} + ${restDays} weitere${restDays === 1 ? 'r' : ''}`;
}

// ─── «Als Nächstes» — max. 3 priorisierte Aktionen ───────────────────────────

export const MAX_NEXT_ACTIONS = 3;

/**
 * Urgenz einer Aktion (Reihenfolge = Anzeige-Priorität):
 * error/overdue/today kommen 1:1 aus der SSoT-Priorisierung (getTodayTasks),
 * check = Karten-Handlungsbedarf (Tagesabschluss/Dienstplan), due_soon = bald fällig.
 */
export type NextActionUrgency = 'error' | 'overdue' | 'today' | 'check' | 'due_soon';

export interface NextAction {
  id: string;
  /** Fachlicher Titel, z. B. „Z-Bericht importieren". */
  title: string;
  /** Kurze Begründung, z. B. „Fehlend: 03.–05.07. + 4 weitere". */
  reason: string;
  urgency: NextActionUrgency;
  /** Deutsches Status-Label („5 Tage überfällig", „Heute erledigen", „Prüfen"). */
  urgencyLabel: string;
  /** Deep-Link zur bestehenden Arbeitsfläche (bestehende Routen + advisory Params). */
  href: string;
  /** true = Aktion führt auf eine Schreib-/Import- oder gastgesperrte Fläche. */
  guestHidden: boolean;
}

/** Ton je Urgenz — kompatibel zu tones.ts, ohne UI-Import (Modul bleibt rein). */
export const NEXT_ACTION_TONE: Record<NextActionUrgency, 'critical' | 'warn' | 'info'> = {
  error: 'critical',
  overdue: 'critical',
  today: 'warn',
  check: 'warn',
  due_soon: 'info',
};

export const NEXT_ACTION_URGENCY_FALLBACK_LABEL: Record<NextActionUrgency, string> = {
  error: 'Fehler',
  overdue: 'Überfällig',
  today: 'Heute erledigen',
  check: 'Prüfen',
  due_soon: 'Bald fällig',
};

/** Fachlicher Aktions-Titel je Importtyp (Fachbegriff zuerst, kein Systemjargon). */
export const NEXT_ACTION_TITLE: Record<ImportTaskType, string> = {
  zbericht: 'Z-Bericht importieren',
  gaeste_bon: 'Gäste & Bonanalyse importieren',
  mirus: 'Arbeitszeiten importieren',
  tagesabschluss: 'Tagesabschluss erfassen',
  marketing: 'Marketing-Umsatz importieren',
  reservationen: 'Fehlende Reservationstage ergänzen',
  erfolgsrechnung: 'Erfolgsrechnung importieren',
  warenrechnungen: 'Warenrechnungen erfassen',
  inventur: 'Inventur bestätigen',
};

export interface NextActionsInput {
  /**
   * Ergebnis von getTodayTasks (Fehler → überfällig → heute) — die Reihenfolge
   * wird UNVERÄNDERT übernommen (SSoT-Priorisierung, keine Zweitsortierung).
   */
  todayTasks: readonly PrioritizedTask[];
  /**
   * Typ-Zusammenfassung (summarizeTypeCompletion) desselben Aufgabenstands —
   * liefert die gemergten offenen Zeiträume für den Begründungstext.
   */
  typeCompletions: readonly TypeCompletion[];
  /** Statuskarten der Startseite (für Prüf-Aktionen Tagesabschluss/Dienstplan). */
  cards: readonly StartCard[];
  /** Gast-Session: Schreib-/Import-Aktionen ausblenden. */
  isGuest: boolean;
  max?: number;
}

/**
 * Baut die «Als Nächstes»-Liste (max. 3):
 *   1. Import-Aufgaben in der Reihenfolge von getTodayTasks, EINE Aktion pro
 *      Importtyp (erste Nennung gewinnt — die SSoT hat bereits sortiert).
 *   2. Prüf-Aktionen aus den Karten (Tagesabschluss/Dienstplan mit `action`).
 *   3. Bald-fällige Karten (nur Dienstplan `due_soon`).
 * Umsatz-/Reservations-Karten erzeugen KEINE eigene Aktion (Dopplung mit den
 * Import-Aufgaben, T409). Fehler-Aufgaben verweisen auf die Import-Checkliste.
 */
export function buildNextActions(input: NextActionsInput): NextAction[] {
  const max = input.max ?? MAX_NEXT_ACTIONS;
  const actions: NextAction[] = [];
  const seenTypes = new Set<ImportTaskType>();
  const completionByType = new Map(input.typeCompletions.map((c) => [c.type, c]));

  // 1. Import-Aufgaben (Reihenfolge = SSoT getTodayTasks, eine Aktion pro Typ).
  for (const { task, due } of input.todayTasks) {
    if (seenTypes.has(task.type)) continue;
    seenTypes.add(task.type);

    if (task.status === 'error') {
      actions.push({
        id: `task-${task.type}`,
        title: NEXT_ACTION_TITLE[task.type],
        reason: 'Status konnte nicht ermittelt werden — in der Import-Checkliste prüfen',
        urgency: 'error',
        urgencyLabel: NEXT_ACTION_URGENCY_FALLBACK_LABEL.error,
        href: '/import-cockpit',
        guestHidden: true, // Import-Checkliste ist für Gast-Sessions gesperrt
      });
      continue;
    }

    const urgency: NextActionUrgency = due.urgency === 'overdue' ? 'overdue' : 'today';
    const completion = completionByType.get(task.type);
    let reason: string;
    if (completion?.openRanges && completion.openRanges.length > 0) {
      reason = `Fehlend: ${formatMissingDays(completion.openRanges)}`;
    } else if (task.frequency === 'monthly') {
      reason = `${task.label} noch nicht importiert`;
    } else {
      reason = `Fehlend: ${formatShortRange({ from: task.from, to: task.to })}`;
    }
    actions.push({
      id: `task-${task.type}`,
      title: NEXT_ACTION_TITLE[task.type],
      reason,
      urgency,
      urgencyLabel: due.dueLabel ?? NEXT_ACTION_URGENCY_FALLBACK_LABEL[urgency],
      href: buildImportTarget(task).href,
      guestHidden: true, // Import-/Schreibflächen — nicht für Gast-Sessions
    });
  }

  // 2. Prüf-Aktionen aus den Karten (nur Nicht-Import-Karten, Dopplung vermeiden).
  const tagesabschluss = input.cards.find((c) => c.id === 'tagesabschluss');
  if (tagesabschluss?.status === 'action') {
    actions.push({
      id: 'card-tagesabschluss',
      title: 'Tagesabschluss bestätigen',
      reason: tagesabschluss.detail,
      urgency: 'check',
      urgencyLabel: NEXT_ACTION_URGENCY_FALLBACK_LABEL.check,
      href: tagesabschluss.route,
      guestHidden: true, // Bestätigen = Schreibaktion
    });
  }
  const dienstplan = input.cards.find((c) => c.id === 'dienstplan');
  if (dienstplan?.status === 'action') {
    actions.push({
      id: 'card-dienstplan',
      title: 'Dienstplan ergänzen',
      reason: dienstplan.detail,
      urgency: 'check',
      urgencyLabel: NEXT_ACTION_URGENCY_FALLBACK_LABEL.check,
      href: dienstplan.route,
      guestHidden: false, // Dienstplan ist für Gäste lesend zugänglich
    });
  } else if (dienstplan?.status === 'due_soon') {
    // 3. Bald fällig — nur anhängen, nie offene Aufgaben verdrängen (Kappung unten).
    actions.push({
      id: 'card-dienstplan',
      title: 'Dienstplan erweitern',
      reason: dienstplan.detail,
      urgency: 'due_soon',
      urgencyLabel: NEXT_ACTION_URGENCY_FALLBACK_LABEL.due_soon,
      href: dienstplan.route,
      guestHidden: false,
    });
  }

  return actions.filter((a) => !input.isGuest || !a.guestHidden).slice(0, max);
}

// ─── Datenstand-Zeilen (kompakt, aus der Typ-Zusammenfassung) ────────────────

export interface DatenstandRow {
  type: ImportTaskType;
  label: string;
  status: TypeCompletion['status'];
  /** Kompakter deutscher Anzeigetext (nie „0" für fehlende Daten). */
  text: string;
  /**
   * Deep-Link der GANZEN Zeile zur fachlich richtigen Import-/Arbeitsfläche
   * (bestehende Routen + advisory Params via buildImportTarget). null =
   * Zeile nicht interaktiv (Gast-Session: Import-/Schreibflächen gesperrt,
   * oder kein Zeitraum-Kontext übergeben).
   */
  href: string | null;
}

export interface DatenstandRowOptions {
  /** Monats-Kontext für die Deep-Links (advisory Prefill: Jahr/Monat). */
  period?: { year: number; month: number };
  /** Gast-Session: Import-/Schreibflächen nie verlinken. */
  isGuest?: boolean;
}

/** Ton je Typ-Status — identische Semantik wie die Checklisten-Zusammenfassung. */
export const DATENSTAND_TONE: Record<TypeCompletion['status'], 'good' | 'warn' | 'neutral' | 'critical'> = {
  done: 'good',
  open: 'warn',
  later: 'neutral',
  error: 'critical',
};

/**
 * Deep-Link einer Datenstand-/Monatsübersichts-Zeile: bestehende Zielrouten via
 * buildImportTarget (advisory Monats-Prefill), Fehlerzeilen → Import-Checkliste.
 * Gast-Sessions: null (alle Ziele sind Import-/Schreib- bzw. gastgesperrte Flächen).
 */
function rowHref(
  type: ImportTaskType,
  status: TypeCompletion['status'],
  opts: DatenstandRowOptions,
): string | null {
  if (opts.isGuest || !opts.period) return null;
  if (status === 'error') return '/import-cockpit';
  return buildImportTarget(buildFullMonthTask(type, opts.period)).href;
}

/**
 * Kompakte Datenstand-Zeilen aus summarizeTypeCompletion — reine Umformatierung,
 * KEINE eigene Statusberechnung. Monats-/Jahresaufgaben bleiben Monats-/Jahres-
 * status („Fehlt noch"), NIE eine künstliche Tagesliste.
 */
export function buildDatenstandRows(
  completions: readonly TypeCompletion[],
  opts: DatenstandRowOptions = {},
): DatenstandRow[] {
  return completions.map((c) => {
    let text: string;
    switch (c.status) {
      case 'done':
        text = 'Vollständig';
        break;
      case 'later':
        text = 'Noch nicht fällig';
        break;
      case 'error':
        text = 'Status konnte nicht ermittelt werden';
        break;
      case 'open':
      default:
        text =
          c.openRanges && c.openRanges.length > 0
            ? `Fehlend: ${formatMissingDays(c.openRanges)}`
            : 'Fehlt noch';
        break;
    }
    return { type: c.type, label: c.label, status: c.status, text, href: rowHref(c.type, c.status, opts) };
  });
}

// ─── Monatsübersicht (T503/T504) — reine Ableitung aus dem SSoT-Aufgabenstand ─

export interface MonthPeriod {
  year: number;
  /** 1–12 */
  month: number;
}

/** Monat verschieben (±n), Jahresgrenzen inklusive (Dez → Jan usw.). */
export function shiftMonth(p: MonthPeriod, delta: number): MonthPeriod {
  const idx = p.year * 12 + (p.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: ((idx % 12) + 12) % 12 + 1 };
}

/** Liegt der Monat NACH dem Monat von todayIso? (Zukunft nie als fehlend bewerten.) */
export function isFutureMonthPeriod(p: MonthPeriod, todayIso: string): boolean {
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  return p.year * 12 + p.month > y * 12 + m;
}

export interface MonthOverviewRow {
  type: ImportTaskType | 'umsatzabstimmung';
  label: string;
  tone: 'good' | 'warn' | 'neutral' | 'critical';
  /** z. B. „14 von 31 erwarteten Tagen vorhanden" — null wenn nicht sinnvoll (monatlich/jährlich). */
  progress: string | null;
  /** Kompakter Statustext („Vollständig", „Fehlend: …", „Monatsimport fehlt", „Noch nicht fällig"). */
  text: string;
  /** Letzter bekannter Importlauf (dd.MM.yyyy) oder null. */
  lastImport: string | null;
  /** Deep-Link zur Import-/Arbeitsfläche; null = keine Aktion (Gast). */
  href: string | null;
}

export interface MonthOverviewInput {
  period: MonthPeriod;
  /**
   * Aufgaben des gewählten Monats (buildImportTasks) und deren Typ-Zusammenfassung
   * (summarizeTypeCompletion) — DERSELBE SSoT-Stand wie Import-Checkliste/Cockpit.
   * null = Zukunftsmonat: Coverage wird NIE für die Zukunft geladen, alle Zeilen
   * erscheinen als „Noch nicht fällig".
   */
  tasks: readonly ImportTask[] | null;
  completions: readonly TypeCompletion[] | null;
  /** Umsatzabstimmungs-Kurzstatus (read-only aus bestehender Logik, T507); optional. */
  umsatzabstimmung?: UmsatzMonthSummary | null;
  /** Gast-Session: keine Aktionen/Links anzeigen. */
  isGuest: boolean;
}

/** Jüngster lastImportAt der eigenen Aufgaben, formatiert (dd.MM.yyyy) oder null. */
function latestImportLabel(own: readonly ImportTask[]): string | null {
  let latest: string | null = null;
  for (const t of own) {
    if (t.lastImportAt && (!latest || t.lastImportAt > latest)) latest = t.lastImportAt;
  }
  return latest ? formatCockpitDate(latest.slice(0, 10)) : null;
}

/**
 * Eine kompakte Zeile pro Importtyp für den GEWÄHLTEN Monat — reine
 * Umformatierung des SSoT-Aufgabenstands (buildImportTasks +
 * summarizeTypeCompletion), KEINE eigene Coverage-/Statusberechnung:
 *  - daily/range: Fortschritt „X von Y erwarteten Tagen vorhanden" direkt aus
 *    den Aufgaben (erwartete Tage sind bereits auf min(Monatsende, gestern)
 *    gedeckelt — Zukunft erzeugt NIE fehlende Tage).
 *  - monthly/yearly: nur Monats-/Jahresstatus, NIE künstliche Tageslücken.
 *  - Fehlerzeilen bleiben sichtbar, verdrängen aber keine anderen Quellen.
 *  - fehlend ≠ 0: ohne Aufgaben/„nicht fällig" gibt es keinen „0 von …"-Text.
 */
export function buildMonthOverviewRows(input: MonthOverviewInput): MonthOverviewRow[] {
  const opts: DatenstandRowOptions = { period: input.period, isGuest: input.isGuest };
  const rows: MonthOverviewRow[] = [];

  for (const def of TASK_TYPE_DEFS) {
    const base = {
      type: def.type,
      label: def.label,
      href: rowHref(def.type, 'open', opts),
    };
    if (input.tasks === null || input.completions === null) {
      // Zukunftsmonat: nichts geladen, nichts fällig — nie „fehlend".
      rows.push({ ...base, tone: 'neutral', progress: null, text: 'Noch nicht fällig', lastImport: null });
      continue;
    }
    const completion = input.completions.find((c) => c.type === def.type);
    const own = input.tasks.filter((t) => t.type === def.type);
    if (!completion || own.length === 0) {
      // Engine hat (noch) keine Aufgaben erzeugt (z. B. Monatsanfang: erwarteter
      // Zeitraum leer) → nicht fällig, NIE als fehlend bewerten.
      rows.push({ ...base, tone: 'neutral', progress: null, text: 'Noch nicht fällig', lastImport: null });
      continue;
    }
    if (completion.status === 'error') {
      rows.push({
        ...base,
        href: rowHref(def.type, 'error', opts),
        tone: 'critical',
        progress: null,
        text: 'Status konnte nicht ermittelt werden',
        lastImport: latestImportLabel(own),
      });
      continue;
    }

    // Fortschritt nur für Tages-Quellen: erwartete/abgedeckte Tage direkt aus
    // den Aufgaben (daily = 1 Tag pro Aufgabe; weekly/monthly auf Tages-Quellen
    // tragen expected-/coveredDayCount). Monats-Quellen: kein Tages-Fortschritt.
    let progress: string | null = null;
    if (def.coverageKind === 'days') {
      let expected = 0;
      let covered = 0;
      for (const t of own) {
        if (t.frequency === 'daily') {
          expected += 1;
          if (t.status === 'done') covered += 1;
        } else if (t.expectedDayCount !== undefined && t.expectedDayCount > 0) {
          expected += t.expectedDayCount;
          covered += t.coveredDayCount ?? 0;
        }
      }
      if (expected > 0) progress = `${covered} von ${expected} erwarteten Tagen vorhanden`;
    }

    let text: string;
    switch (completion.status) {
      case 'done':
        text = 'Vollständig';
        break;
      case 'later':
        text = 'Noch nicht fällig';
        break;
      case 'open':
      default:
        if (def.coverageKind === 'month') {
          text = def.type === 'inventur' ? 'Noch nicht bestätigt' : 'Monatsimport fehlt';
        } else {
          text =
            completion.openRanges && completion.openRanges.length > 0
              ? `Fehlend: ${formatMissingDays(completion.openRanges)}`
              : 'Fehlt noch';
        }
        break;
    }

    rows.push({
      ...base,
      tone: DATENSTAND_TONE[completion.status],
      progress,
      text,
      lastImport: latestImportLabel(own),
    });
  }

  // Umsatzabstimmung (T507): read-only Kurzstatus aus der bestehenden
  // Abstimmungslogik — Deep-Link mit Jahr + Monat auf die bestehende Seite.
  if (input.umsatzabstimmung) {
    rows.push({
      type: 'umsatzabstimmung',
      label: 'Umsatzabstimmung',
      tone: UMSATZ_MONTH_TONE[input.umsatzabstimmung.status],
      progress: null,
      text: input.umsatzabstimmung.text,
      lastImport: null,
      href: input.isGuest
        ? null
        : `/umsatzabstimmung?year=${input.period.year}&month=${input.period.month}`,
    });
  }

  return rows;
}

// ─── Hauptfunktion ───────────────────────────────────────────────────────────

/** Baut die 4 Statuskarten + Warnungsliste (Warnung = Karte mit Status `action`). */
export function buildStartOverview(input: StartOverviewInput): StartOverviewResult {
  const cards: StartCard[] = [
    cardFromCockpitSource('umsatz', 'Umsatzimport', 'zbericht', input.signals.zbericht, input.todayIso),
    cardFromCockpitSource(
      'reservationen',
      'Reservationen',
      'reservationen',
      input.signals.reservationen,
      input.todayIso,
    ),
    dienstplanCard(input.signals.dienstplanung, input.todayIso),
    tagesabschlussCard(input.tagesabschluss, input.todayIso),
  ];
  const warnings: StartWarning[] = cards
    .filter((c) => c.status === 'action')
    .map((c) => ({ id: c.id, text: `${c.title}: ${c.detail}`, route: c.route }));
  return { cards, warnings };
}
