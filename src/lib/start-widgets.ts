/**
 * start-widgets.ts — Widget-Katalog «Heute» der Startseite (REINE LOGIK).
 * =======================================================================
 * Der Bereich «Heute» wird personalisierbar: Neben den 4 bestehenden
 * Statuskarten (buildStartOverview — Frische-Regeln bleiben 1:1 die SSoT)
 * gibt es zusätzliche Widgets aus BESTEHENDEN Datenquellen. Es werden NUR
 * Widgets angeboten, für die echte Quellen existieren — bewusst NICHT dabei:
 * Google-Bewertungen (keine Anbindung) und Inventur (kein Datenmodell).
 *
 * Regeln:
 *  - KEINE eigene Status-/Frische-Berechnung: Statuskarten-Widgets nehmen die
 *    fertigen StartCards; Info-Widgets sind reine Anzeige-Projektionen ohne
 *    Ampel (tone-frei bzw. neutral) — keine neuen Schwellen.
 *  - fehlend ≠ 0: Ladefehler/fehlende Daten ⇒ «—» mit sichtbarem Grund,
 *    nie stille 0-Werte. 0 erscheint nur, wenn die Quelle wirklich 0 liefert
 *    (z. B. keine Reservationen für heute nach erfolgreicher Abfrage).
 *  - Gast-Sessions: PII-freie Aggregate ohne Links auf gastgesperrte Flächen;
 *    Import-orientierte Widgets sind für Gäste ganz ausgeblendet.
 * IO (Laden der Widget-Daten) liegt im Hook useHeuteWidgets.
 */

import type { TypeCompletion } from './import-tasks-priority';
import { formatCockpitDate } from './import-cockpit';
import type { StartCard, StartCardStatus } from './start-overview-utils';

// ─── Widget-Katalog ──────────────────────────────────────────────────────────

export type HeuteWidgetId =
  | 'umsatz'
  | 'reservationen'
  | 'dienstplan'
  | 'tagesabschluss'
  | 'offene_importe'
  | 'reservationen_heute'
  | 'personalausfaelle'
  | 'warenrechnungen'
  | 'kreditoren';

export interface HeuteWidgetDef {
  id: HeuteWidgetId;
  title: string;
  /** Kurzbeschreibung für den Anpassen-Dialog. */
  beschreibung: string;
  /** true = für Gast-Sessions nie anbieten (Import-/gastgesperrte Flächen). */
  guestHidden?: boolean;
}

export const HEUTE_WIDGET_DEFS: readonly HeuteWidgetDef[] = [
  { id: 'umsatz', title: 'Umsatzimport', beschreibung: 'Frische des Z-Bericht-Imports (Import-Cockpit-Regeln)' },
  { id: 'reservationen', title: 'Reservationen', beschreibung: 'Frische des Reservations-Imports (Foratable)' },
  { id: 'dienstplan', title: 'Dienstplan', beschreibung: 'Planungshorizont des Dienstplans' },
  { id: 'tagesabschluss', title: 'Tagesabschluss', beschreibung: 'Bestätigung des gestrigen Tagesabschlusses' },
  { id: 'offene_importe', title: 'Offene Importe', beschreibung: 'Anzahl offener Importtypen im laufenden Monat', guestHidden: true },
  { id: 'reservationen_heute', title: 'Reservationen heute', beschreibung: 'Anzahl Reservationen und Personen für heute' },
  { id: 'personalausfaelle', title: 'Abwesenheiten heute', beschreibung: 'Abwesenheiten im heutigen Dienstplan' },
  { id: 'warenrechnungen', title: 'Warenrechnungen', beschreibung: 'Erfasste Warenrechnungen im laufenden Monat' },
  { id: 'kreditoren', title: 'Kreditoren (OP)', beschreibung: 'Offener Betrag der neuesten OP-Liste' },
];

/** Default = exakt die 4 bisherigen Statuskarten (Verhalten unverändert). */
export const DEFAULT_HEUTE_WIDGET_IDS: readonly HeuteWidgetId[] = [
  'umsatz',
  'reservationen',
  'dienstplan',
  'tagesabschluss',
];

export function isHeuteWidgetId(v: unknown): v is HeuteWidgetId {
  return typeof v === 'string' && HEUTE_WIDGET_DEFS.some((d) => d.id === v);
}

// ─── Anzeige-Shape ───────────────────────────────────────────────────────────

/**
 * Einheitliches Karten-Shape:
 *  - Statuskarten-Widgets: status/statusLabel aus der bestehenden StartCard.
 *  - Info-Widgets: status null (kein Ampel-Punkt), value = grosse Kennzahl.
 *  - error: sichtbarer Ladefehler des Widgets (statt stiller «—»).
 */
export interface HeuteWidgetView {
  id: HeuteWidgetId;
  title: string;
  status: StartCardStatus | null;
  statusLabel: string | null;
  /** Grosse Kennzahl der Info-Widgets (bereits formatiert); null = keine. */
  value: string | null;
  detail: string;
  /** Zielroute («Öffnen»); null = kein Link (Gast bzw. keine Zielseite). */
  route: string | null;
  error?: string;
}

const DASH = '—';
const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });

// ─── Builder: Statuskarten-Widgets (1:1 aus StartCard) ───────────────────────

export function widgetFromStartCard(card: StartCard, opts: { hideRoute?: boolean } = {}): HeuteWidgetView {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    statusLabel: card.statusLabel,
    value: null,
    detail: card.detail,
    route: opts.hideRoute ? null : card.route,
  };
}

// ─── Builder: Info-Widgets (reine Projektionen bestehender Quellen) ──────────

/** Offene Importe: Anzahl offener/fehlerhafter Importtypen (SSoT-Zusammenfassung). */
export function buildOffeneImporteWidget(
  completions: readonly TypeCompletion[] | null,
  coverageError: string | null,
): HeuteWidgetView {
  const base: HeuteWidgetView = {
    id: 'offene_importe',
    title: 'Offene Importe',
    status: null,
    statusLabel: null,
    value: null,
    detail: '',
    route: '/import-cockpit',
  };
  if (!completions) {
    return { ...base, value: DASH, detail: 'Aufgabenstand konnte nicht geladen werden', error: coverageError ?? undefined };
  }
  const open = completions.filter((c) => c.status === 'open').length;
  const errors = completions.filter((c) => c.status === 'error').length;
  const total = open + errors;
  if (total === 0) return { ...base, value: '0', detail: 'Alle fälligen Importe sind aktuell' };
  const parts = [
    open > 0 ? `${open} offen` : null,
    errors > 0 ? `${errors} ohne Status` : null,
  ].filter(Boolean);
  return { ...base, value: nf0.format(total), detail: `Importtypen: ${parts.join(' · ')}` };
}

/** PII-freie Projektion der heutigen Reservationen: NUR Anzahl + Personen. */
export interface ReservationenHeuteData {
  count: number;
  /** Summe partySize der Reservationen mit bekannter Personenzahl; null = keine bekannt. */
  persons: number | null;
}

export function buildReservationenHeuteWidget(
  data: ReservationenHeuteData | null,
  error: string | null,
  isGuest: boolean,
): HeuteWidgetView {
  const base: HeuteWidgetView = {
    id: 'reservationen_heute',
    title: 'Reservationen heute',
    status: null,
    statusLabel: null,
    value: null,
    detail: '',
    route: isGuest ? null : '/gaeste', // Gäste-CRM ist gastgesperrt
  };
  if (!data) {
    return { ...base, value: DASH, detail: 'Reservationen konnten nicht geladen werden', error: error ?? undefined };
  }
  if (data.count === 0) return { ...base, value: '0', detail: 'Keine Reservationen für heute erfasst' };
  const persons = data.persons !== null ? ` · ${nf0.format(data.persons)} Personen` : '';
  return { ...base, value: nf0.format(data.count), detail: `Reservationen für heute${persons}` };
}

/** Abwesenheiten im heutigen Dienstplan (kein Plan ⇒ «—», NIE 0). */
export interface PersonalausfaelleData {
  /** true = für heute existieren Dienstplan-Einträge. */
  dayPlanned: boolean;
  absenceCount: number;
}

export function buildPersonalausfaelleWidget(
  data: PersonalausfaelleData | null,
  error: string | null,
): HeuteWidgetView {
  const base: HeuteWidgetView = {
    id: 'personalausfaelle',
    title: 'Abwesenheiten heute',
    status: null,
    statusLabel: null,
    value: null,
    detail: '',
    route: '/personal',
  };
  if (!data) {
    return { ...base, value: DASH, detail: 'Dienstplan konnte nicht geladen werden', error: error ?? undefined };
  }
  if (!data.dayPlanned) return { ...base, value: DASH, detail: 'Kein Dienstplan für heute erfasst' };
  if (data.absenceCount === 0) return { ...base, value: '0', detail: 'Keine Abwesenheiten im heutigen Dienstplan' };
  return {
    ...base,
    value: nf0.format(data.absenceCount),
    detail: `Abwesenheit${data.absenceCount === 1 ? '' : 'en'} im heutigen Dienstplan`,
  };
}

/** Warenrechnungen des laufenden Monats (KV-Liste; leere Liste = «Keine erfasst»). */
export interface WarenrechnungenData {
  count: number;
  /** Netto-Summe (Rohwerte summiert; Rundung erst hier bei der Anzeige). */
  totalNet: number;
}

export function buildWarenrechnungenWidget(
  data: WarenrechnungenData | null,
  error: string | null,
  monthLabel: string,
): HeuteWidgetView {
  const base: HeuteWidgetView = {
    id: 'warenrechnungen',
    title: 'Warenrechnungen',
    status: null,
    statusLabel: null,
    value: null,
    detail: '',
    route: '/warenrechnungen',
  };
  if (!data) {
    return { ...base, value: DASH, detail: 'Warenrechnungen konnten nicht geladen werden', error: error ?? undefined };
  }
  if (data.count === 0) return { ...base, value: DASH, detail: `Keine Warenrechnungen im ${monthLabel} erfasst` };
  return {
    ...base,
    value: `CHF ${nf0.format(data.totalNet)}`,
    detail: `${nf0.format(data.count)} Rechnung${data.count === 1 ? '' : 'en'} netto im ${monthLabel}`,
  };
}

/** Kreditoren: neueste aktive OP-Liste (Stichtag + offener Betrag). */
export interface KreditorenData {
  /** true = OP-Tabellen existieren (Migration eingespielt). */
  tableAvailable: boolean;
  latest: {
    snapshotDate: string; // yyyy-MM-dd
    totalOpenAmount: number | null;
    totalItems: number | null;
  } | null;
}

export function buildKreditorenWidget(
  data: KreditorenData | null,
  error: string | null,
): HeuteWidgetView {
  const base: HeuteWidgetView = {
    id: 'kreditoren',
    title: 'Kreditoren (OP)',
    status: null,
    statusLabel: null,
    value: null,
    detail: '',
    route: '/op-liste',
  };
  if (!data) {
    return { ...base, value: DASH, detail: 'OP-Liste konnte nicht geladen werden', error: error ?? undefined };
  }
  if (!data.tableAvailable) return { ...base, value: DASH, detail: 'OP-Listen-Tool noch nicht eingerichtet' };
  if (!data.latest) return { ...base, value: DASH, detail: 'Noch keine OP-Liste importiert' };
  const amount = data.latest.totalOpenAmount !== null ? `CHF ${nf0.format(data.latest.totalOpenAmount)}` : DASH;
  const items = data.latest.totalItems !== null ? ` · ${nf0.format(data.latest.totalItems)} Posten` : '';
  return {
    ...base,
    value: amount,
    detail: `Offen per ${formatCockpitDate(data.latest.snapshotDate)}${items}`,
  };
}
