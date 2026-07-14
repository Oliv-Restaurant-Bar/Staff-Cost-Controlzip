/**
 * Gäste-CRM — Smart-Segmente (reine Berechnungs-/Export-Logik, KEINE DB/DOM)
 * ===========================================================================
 * Dynamische, MEHRFACH-zuordenbare Gästesegmente, die LIVE aus den bereits
 * berechneten Listen-Kennzahlen (`GuestListMetrics`, siehe reservation-crm.ts)
 * abgeleitet werden.  Ein Gast kann gleichzeitig in mehreren Smart-Segmenten
 * sein (z. B. VIP + Gefährdet + „Geburtstag bald").
 *
 * WICHTIG — strikt additiv:
 *   Diese Segmente sind völlig getrennt von der bestehenden Einzel-Segmentierung
 *   (`GuestSegment`/`classifySegment`).  Sie verändern weder das berechnete
 *   Segment noch den CRM-Score; sie werden nirgends dorthin zurückgeführt.
 *
 * Da alles rein über `GuestListMetrics` läuft (Besuche, erster/letzter Besuch,
 * Tage seit letztem Besuch, manuelles CRM-Profil), aktualisieren sich die
 * Smart-Segmente automatisch mit jedem Import.  Es gibt KEINE eigene DB-Abfrage
 * und KEINE Migration; die Mandantentrennung erbt das Modul vollständig von den
 * tenant-gefilterten Reads, die die Kennzahlen liefern.
 *
 * Schwellen (vom Nutzer vorgegeben):
 *   - Einmalgast (never_returned) : genau 1 abgeschlossener Besuch
 *   - Gefährdet  (at_risk)        : ≥ 1 Besuch UND ≥ 90 Tage kein Besuch mehr
 *   - Verloren   (lost)           : ≥ 1 Besuch UND ≥ 180 Tage kein Besuch mehr
 *   - Regelmässig(regular)        : ≥ 4 abgeschlossene Besuche
 *   - VIP        (vip)            : ≥ 10 abgeschlossene Besuche
 *   - Neu        (new)            : erster Besuch innerhalb der letzten 30 Tage
 *   - Geburtstag bald (upcoming_birthday): manueller Geburtstag in den nächsten 30 Tagen
 *
 * Überschneidung „Gefährdet"/„Verloren" ist BEWUSST: ein seit 200 Tagen
 * abwesender Gast ist beides.  Das entspricht dem Mehrfach-Zuordnungs-Konzept.
 */

import {
  daysSince,
  SIMPLE_STATUS_REGULAR_MIN,
  SIMPLE_STATUS_VIP_MIN,
  type GuestListMetrics,
} from './reservation-crm';
import { NEW_GUEST_DAYS } from './reservation-dashboard';
import { CSV_HEADERS, campaignRowToCells } from './reservation-campaigns';
import type { GuestCrmProfile } from './guest-crm-profile';
import type { ExportTable } from './export-cell';

// ── Segment-Identität ─────────────────────────────────────────────────────────

export type SmartSegment =
  | 'vip'
  | 'regular'
  | 'new'
  | 'upcoming_birthday'
  | 'never_returned'
  | 'at_risk'
  | 'lost';

/** Anzeigereihenfolge (Wert/Chance zuerst, Risiko zuletzt). */
export const SMART_SEGMENT_ORDER: SmartSegment[] = [
  'vip',
  'regular',
  'new',
  'upcoming_birthday',
  'never_returned',
  'at_risk',
  'lost',
];

export const SMART_SEGMENT_LABEL: Record<SmartSegment, string> = {
  vip:               'VIP',
  regular:           'Regelmässig',
  new:               'Neu',
  upcoming_birthday: 'Geburtstag bald',
  never_returned:    'Einmalgast',
  at_risk:           'Gefährdet',
  lost:              'Verloren',
};

export const SMART_SEGMENT_DESCRIPTION: Record<SmartSegment, string> = {
  vip:               'Mindestens 10 abgeschlossene Besuche.',
  regular:           'Mindestens 4 abgeschlossene Besuche.',
  new:               'Erster Besuch innerhalb der letzten 30 Tage.',
  upcoming_birthday: 'Geburtstag (manuelles CRM-Profil) innerhalb der nächsten 30 Tage.',
  never_returned:    'Genau 1 abgeschlossener Besuch — nie zurückgekehrt.',
  at_risk:           'Hat schon besucht, aber seit mindestens 90 Tagen nicht mehr.',
  lost:              'Seit mindestens 180 Tagen kein Besuch mehr.',
};

/** Datei-Slug für den CSV-Export (ohne Präfix/Erweiterung). */
export const SMART_SEGMENT_SLUG: Record<SmartSegment, string> = {
  vip:               'vip',
  regular:           'regelmaessig',
  new:               'neu',
  upcoming_birthday: 'geburtstag-bald',
  never_returned:    'einmalgast',
  at_risk:           'gefaehrdet',
  lost:              'verloren',
};

// ── Schwellen (zentral; teils aus bestehenden Modulen wiederverwendet) ────────

/** „VIP": mindestens so viele abgeschlossene Besuche (= SIMPLE_STATUS_VIP_MIN). */
export const SMART_VIP_MIN = SIMPLE_STATUS_VIP_MIN;          // 10
/** „Regelmässig": mindestens so viele Besuche (= SIMPLE_STATUS_REGULAR_MIN). */
export const SMART_REGULAR_MIN = SIMPLE_STATUS_REGULAR_MIN;  // 4
/** „Neu": erster Besuch innerhalb dieser Tage (= NEW_GUEST_DAYS). */
export const SMART_NEW_DAYS = NEW_GUEST_DAYS;                // 30
/** „Gefährdet": seit mindestens so vielen Tagen kein Besuch mehr. */
export const SMART_AT_RISK_DAYS = 90;
/** „Verloren": seit mindestens so vielen Tagen kein Besuch mehr. */
export const SMART_LOST_DAYS = 180;
/** „Geburtstag bald": Geburtstag innerhalb dieser Tage in der Zukunft. */
export const SMART_BIRTHDAY_WINDOW_DAYS = 30;

// ── Geburtstags-Helfer (jahresunabhängig, mit Jahreswechsel) ──────────────────

/** Tagesnummer (UTC) eines Y-M-D ohne Zeitzonen-/DST-Fallen. */
function dayNumber(year: number, month1: number, day: number): number {
  return Math.floor(Date.UTC(year, month1 - 1, day) / 86400000);
}

/** "yyyy-MM-dd" → Tagesnummer (UTC) oder null bei ungültigem Format. */
function isoDayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Tage bis zum nächsten Vorkommen des Geburtstags (Monat/Tag, jahresunabhängig).
 * 0 = heute, sonst 1…~365.  Berücksichtigt den Jahreswechsel (z. B. heute 20.12.,
 * Geburtstag 05.01. ⇒ 16 Tage).  Ungültiges/fehlendes Datum ⇒ null.  Der 29.02.
 * rollt in Nicht-Schaltjahren deterministisch auf den 01.03. (JS-Date-Verhalten).
 */
export function daysUntilBirthday(birthday: string | null | undefined, today: string): number | null {
  if (!birthday) return null;
  const bm = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday);
  const todayNum = isoDayNumber(today);
  if (!bm || todayNum === null) return null;
  const month = Number(bm[2]);
  const day = Number(bm[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const todayMatch = /^(\d{4})-/.exec(today);
  if (!todayMatch) return null;
  const ty = Number(todayMatch[1]);
  // Kandidat in diesem Jahr; ist er bereits vorbei, das nächste Jahr nehmen.
  for (const year of [ty, ty + 1]) {
    const cand = dayNumber(year, month, day);
    if (cand >= todayNum) return cand - todayNum;
  }
  return null;
}

/** Geburtstag innerhalb der nächsten SMART_BIRTHDAY_WINDOW_DAYS Tage (inkl. heute). */
export function isUpcomingBirthday(
  crm: GuestCrmProfile | null | undefined,
  today: string,
): boolean {
  const d = daysUntilBirthday(crm?.birthday ?? null, today);
  return d !== null && d >= 0 && d <= SMART_BIRTHDAY_WINDOW_DAYS;
}

// ── Prädikate je Smart-Segment ────────────────────────────────────────────────
// Grenzwerte inklusive: „90+ Tage" ⇒ ≥ 90, „letzte 30 Tage" ⇒ ≤ 30.

export const SMART_SEGMENT_PREDICATES: Record<
  SmartSegment,
  (m: GuestListMetrics, today: string) => boolean
> = {
  vip:               m => m.visits >= SMART_VIP_MIN,
  regular:           m => m.visits >= SMART_REGULAR_MIN,
  new:               (m, today) => {
    if (m.visits < 1) return false;
    const since = daysSince(m.firstVisit, today);
    return since !== null && since <= SMART_NEW_DAYS;
  },
  upcoming_birthday: (m, today) => isUpcomingBirthday(m.crm ?? null, today),
  never_returned:    m => m.visits === 1,
  at_risk:           m =>
    m.visits >= 1 && m.daysSinceLastVisit !== null && m.daysSinceLastVisit >= SMART_AT_RISK_DAYS,
  lost:              m =>
    m.visits >= 1 && m.daysSinceLastVisit !== null && m.daysSinceLastVisit >= SMART_LOST_DAYS,
};

/** True, wenn der Gast dem angegebenen Smart-Segment angehört. */
export function hasSmartSegment(m: GuestListMetrics, today: string, segment: SmartSegment): boolean {
  return SMART_SEGMENT_PREDICATES[segment](m, today);
}

/** Alle Smart-Segmente eines Gastes (in SMART_SEGMENT_ORDER). */
export function guestSmartSegments(m: GuestListMetrics, today: string): SmartSegment[] {
  return SMART_SEGMENT_ORDER.filter(seg => SMART_SEGMENT_PREDICATES[seg](m, today));
}

// ── Filterung, Zusammenfassung ────────────────────────────────────────────────

const cmpName = (a: GuestListMetrics, b: GuestListMetrics): number =>
  a.displayName.localeCompare(b.displayName, 'de');

/** Höchste Besuchszahl zuerst, dann Name — stabile Reihenfolge für Liste/Export. */
const byVisitsDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  b.visits - a.visits || cmpName(a, b);

/** Filtert die Gäste eines Smart-Segments und sortiert sie (relevanteste zuerst). */
export function filterBySmartSegment(
  metrics: GuestListMetrics[],
  segment: SmartSegment,
  today: string,
): GuestListMetrics[] {
  return metrics
    .filter(m => SMART_SEGMENT_PREDICATES[segment](m, today))
    .sort(byVisitsDesc);
}

export interface SmartSegmentSummary {
  segment: SmartSegment;
  label: string;
  description: string;
  count: number;
}

/** Anzahl Treffer je Smart-Segment (für Übersichts-Kacheln/Filter-Badges). */
export function summarizeSmartSegments(
  metrics: GuestListMetrics[],
  today: string,
): SmartSegmentSummary[] {
  return SMART_SEGMENT_ORDER.map(segment => ({
    segment,
    label: SMART_SEGMENT_LABEL[segment],
    description: SMART_SEGMENT_DESCRIPTION[segment],
    count: metrics.reduce((n, m) => n + (SMART_SEGMENT_PREDICATES[segment](m, today) ? 1 : 0), 0),
  }));
}

// ── UI-Filteroptionen ─────────────────────────────────────────────────────────

export type SmartSegmentFilter = 'alle' | SmartSegment;

export interface SmartSegmentFilterOption {
  value: SmartSegmentFilter;
  label: string;
}

export const SMART_SEGMENT_FILTER_OPTIONS: SmartSegmentFilterOption[] = [
  { value: 'alle', label: 'Alle Smart-Segmente' },
  ...SMART_SEGMENT_ORDER.map((seg): SmartSegmentFilterOption => ({
    value: seg,
    label: SMART_SEGMENT_LABEL[seg],
  })),
];

// ── CSV-/Excel-Export je Segment ──────────────────────────────────────────────
// Wiederverwendung der getesteten, rein über GuestListMetrics arbeitenden
// Kampagnen-Export-Bausteine (CSV_HEADERS + campaignRowToCells) — keine eigene
// Spaltenlogik, damit Smart-Segment- und Kampagnen-Exporte identisch aufgebaut sind.

/** Baut eine `ExportTable` (CSV/Excel) für die Gäste eines Smart-Segments. */
export function smartSegmentExportTable(
  segment: SmartSegment,
  rows: GuestListMetrics[],
): ExportTable {
  return {
    filename: `crm-smart-segment-${SMART_SEGMENT_SLUG[segment]}`,
    sheetName: 'Smart-Segment',
    headers: CSV_HEADERS.slice(),
    rows: rows.map(campaignRowToCells),
  };
}
