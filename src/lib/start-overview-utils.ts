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
