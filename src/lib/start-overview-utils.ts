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
  buildImportTarget,
  rangeDayCount,
  type DateRange,
  type ImportTaskType,
} from './import-tasks-engine';
import type { PrioritizedTask, TypeCompletion } from './import-tasks-priority';

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
  reservationen: 'Fehlende Reservationstage ergänzen',
  umsatz: 'Tagesumsätze importieren',
  verkaufsdaten: 'Verkaufsdaten importieren',
  mirus: 'Arbeitszeiten importieren',
  marketing: 'Marketing-Umsatz importieren',
  erfolgsrechnung: 'Erfolgsrechnung importieren',
  istkosten: 'IST-Kosten importieren',
  budget: 'Budget erfassen',
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
    } else if (task.frequency === 'monthly' || task.frequency === 'yearly') {
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
}

/** Ton je Typ-Status — identische Semantik wie die Checklisten-Zusammenfassung. */
export const DATENSTAND_TONE: Record<TypeCompletion['status'], 'good' | 'warn' | 'neutral' | 'critical'> = {
  done: 'good',
  open: 'warn',
  later: 'neutral',
  error: 'critical',
};

/**
 * Kompakte Datenstand-Zeilen aus summarizeTypeCompletion — reine Umformatierung,
 * KEINE eigene Statusberechnung. Monats-/Jahresaufgaben bleiben Monats-/Jahres-
 * status („Fehlt noch"), NIE eine künstliche Tagesliste.
 */
export function buildDatenstandRows(completions: readonly TypeCompletion[]): DatenstandRow[] {
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
    return { type: c.type, label: c.label, status: c.status, text };
  });
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
