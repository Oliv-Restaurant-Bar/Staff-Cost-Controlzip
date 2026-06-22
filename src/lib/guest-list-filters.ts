/**
 * Gäste-CRM — reine Filter- und Sortierlogik (KEINE DB-/DOM-Abhängigkeit)
 * =======================================================================
 * Kapselt die kombinierbaren Filter und die Sortierung der Gästeliste (/gaeste).
 * Bewusst frei von Supabase/React, damit die Logik mit synthetischen Daten als
 * Unit getestet werden kann.  Arbeitet ausschliesslich auf `GuestListMetrics`
 * (siehe reservation-crm.ts) — also auf bereits berechneten Kennzahlen.
 *
 * Begriffe / Schwellen:
 *  - Besuch          = abgeschlossene Reservation (siehe reservation-crm.ts).
 *  - Letzter Besuch  = Tage seit letztem abgeschlossenen Besuch (daysSinceLastVisit).
 *  - Gruppengrösse   = gerundete Ø Personenzahl der abgeschlossenen Besuche.
 *  - No-Show-Risiko  = ≥ NO_SHOW_RISK_MIN No-Shows (zentral in reservation-dashboard.ts).
 */

import {
  SEGMENT_LABEL, SEGMENT_ORDER, returnRiskRatio, isAtReturnRisk,
  type GuestListMetrics, type GuestSegment,
} from './reservation-crm';
import { NO_SHOW_RISK_MIN } from './reservation-dashboard';

// ── Filter-Wertebereiche ──────────────────────────────────────────────────────

export type SegmentFilter = 'alle' | GuestSegment;
export type VisitCountFilter = 'alle' | '1' | '2-4' | '5-10' | '10+';
export type LastVisitFilter = 'alle' | '30' | '60' | '90' | 'older90' | 'older180';
export type PartySizeFilter = 'alle' | '1' | '2' | '3-4' | '5+';
export type NoShowFilter = 'alle' | 'risk' | 'norisk';
export type ReturnRiskFilter = 'alle' | 'risk';

/** Ja/Nein-Filter für boolesche, manuell gepflegte CRM-Merkmale. */
export type BoolFilter = 'alle' | 'ja' | 'nein';

export interface GuestFilterState {
  segment: SegmentFilter;
  visitCount: VisitCountFilter;
  lastVisit: LastVisitFilter;
  partySize: PartySizeFilter;
  noShow: NoShowFilter;
  returnRisk: ReturnRiskFilter;
  // ── Manuelle CRM-Merkmale (guest_crm_profiles) — rein additiv ──────────────
  vipManual: BoolFilter;
  stammgastManual: BoolFilter;
  companyCustomer: BoolFilter;
  newsletter: BoolFilter;
  blocked: BoolFilter;
  hasAllergies: BoolFilter;
  hasBirthday: BoolFilter;
  hasCrmNote: BoolFilter;
}

export const DEFAULT_GUEST_FILTERS: GuestFilterState = {
  segment: 'alle',
  visitCount: 'alle',
  lastVisit: 'alle',
  partySize: 'alle',
  noShow: 'alle',
  returnRisk: 'alle',
  vipManual: 'alle',
  stammgastManual: 'alle',
  companyCustomer: 'alle',
  newsletter: 'alle',
  blocked: 'alle',
  hasAllergies: 'alle',
  hasBirthday: 'alle',
  hasCrmNote: 'alle',
};

/** True, sobald mindestens ein Filter vom Default ('alle') abweicht. */
export function hasActiveFilters(f: GuestFilterState): boolean {
  return (
    f.segment !== 'alle' ||
    f.visitCount !== 'alle' ||
    f.lastVisit !== 'alle' ||
    f.partySize !== 'alle' ||
    f.noShow !== 'alle' ||
    f.returnRisk !== 'alle' ||
    f.vipManual !== 'alle' ||
    f.stammgastManual !== 'alle' ||
    f.companyCustomer !== 'alle' ||
    f.newsletter !== 'alle' ||
    f.blocked !== 'alle' ||
    f.hasAllergies !== 'alle' ||
    f.hasBirthday !== 'alle' ||
    f.hasCrmNote !== 'alle'
  );
}

// ── Auswahl-Optionen für die UI (Wert + deutsches Label) ──────────────────────

export interface FilterOption<T extends string> {
  value: T;
  label: string;
}

export const SEGMENT_FILTER_OPTIONS: FilterOption<SegmentFilter>[] = [
  { value: 'alle', label: 'Alle Segmente' },
  ...SEGMENT_ORDER.map((seg): FilterOption<SegmentFilter> => ({ value: seg, label: SEGMENT_LABEL[seg] })),
];

export const VISIT_COUNT_FILTER_OPTIONS: FilterOption<VisitCountFilter>[] = [
  { value: 'alle', label: 'Alle Besuche' },
  { value: '1', label: '1 Besuch' },
  { value: '2-4', label: '2 bis 4 Besuche' },
  { value: '5-10', label: '5 bis 10 Besuche' },
  { value: '10+', label: 'Mehr als 10 Besuche' },
];

export const LAST_VISIT_FILTER_OPTIONS: FilterOption<LastVisitFilter>[] = [
  { value: 'alle', label: 'Letzter Besuch: alle' },
  { value: '30', label: 'Letzte 30 Tage' },
  { value: '60', label: 'Letzte 60 Tage' },
  { value: '90', label: 'Letzte 90 Tage' },
  { value: 'older90', label: 'Älter als 90 Tage' },
  { value: 'older180', label: 'Älter als 180 Tage' },
];

export const PARTY_SIZE_FILTER_OPTIONS: FilterOption<PartySizeFilter>[] = [
  { value: 'alle', label: 'Alle Gruppengrössen' },
  { value: '1', label: '1 Person' },
  { value: '2', label: '2 Personen' },
  { value: '3-4', label: '3 bis 4 Personen' },
  { value: '5+', label: '5+ Personen' },
];

export const NO_SHOW_FILTER_OPTIONS: FilterOption<NoShowFilter>[] = [
  { value: 'alle', label: 'No-Show: alle' },
  { value: 'risk', label: 'Mit No-Show-Risiko' },
  { value: 'norisk', label: 'Ohne No-Show-Risiko' },
];

export const RETURN_RISK_FILTER_OPTIONS: FilterOption<ReturnRiskFilter>[] = [
  { value: 'alle', label: 'Rückkehrpotenzial: alle' },
  { value: 'risk', label: 'Nur gefährdete Stammgäste' },
];

/** Gemeinsame Alle/Ja/Nein-Optionen für alle booleschen CRM-Merkmal-Filter. */
export const BOOL_FILTER_OPTIONS: FilterOption<BoolFilter>[] = [
  { value: 'alle', label: 'Alle' },
  { value: 'ja', label: 'Ja' },
  { value: 'nein', label: 'Nein' },
];

// ── Einzel-Prädikate (rein, defensiv bei null) ────────────────────────────────

function matchSegment(m: GuestListMetrics, f: SegmentFilter): boolean {
  return f === 'alle' || m.segment === f;
}

function matchVisitCount(m: GuestListMetrics, f: VisitCountFilter): boolean {
  switch (f) {
    case 'alle': return true;
    case '1':    return m.visits === 1;
    case '2-4':  return m.visits >= 2 && m.visits <= 4;
    case '5-10': return m.visits >= 5 && m.visits <= 10;
    case '10+':  return m.visits > 10;
    default:     return true;
  }
}

function matchLastVisit(m: GuestListMetrics, f: LastVisitFilter): boolean {
  if (f === 'alle') return true;
  const d = m.daysSinceLastVisit;
  // Ohne abgeschlossenen Besuch (null) lässt sich keine Aktualität bestimmen →
  // solche Gäste fallen aus allen "Letzter Besuch"-Filtern heraus.
  if (d === null) return false;
  switch (f) {
    case '30':       return d <= 30;
    case '60':       return d <= 60;
    case '90':       return d <= 90;
    case 'older90':  return d > 90;
    case 'older180': return d > 180;
    default:         return true;
  }
}

function matchPartySize(m: GuestListMetrics, f: PartySizeFilter): boolean {
  if (f === 'alle') return true;
  const p = m.avgPartySize;
  // Ohne bekannte Personenzahl (null) kann nicht nach Gruppengrösse gefiltert werden.
  if (p === null) return false;
  const rounded = Math.round(p);
  switch (f) {
    case '1':   return rounded === 1;
    case '2':   return rounded === 2;
    case '3-4': return rounded >= 3 && rounded <= 4;
    case '5+':  return rounded >= 5;
    default:    return true;
  }
}

function matchNoShow(m: GuestListMetrics, f: NoShowFilter): boolean {
  if (f === 'alle') return true;
  const isRisk = m.noShowCount >= NO_SHOW_RISK_MIN;
  return f === 'risk' ? isRisk : !isRisk;
}

function matchReturnRisk(m: GuestListMetrics, f: ReturnRiskFilter): boolean {
  if (f === 'alle') return true;
  // 'risk' → nur gefährdete Stammgäste (überfällig ggü. persönlichem Intervall).
  return isAtReturnRisk(m);
}

// ── Manuelle CRM-Merkmale (defensiv: fehlendes Profil → Merkmal „nicht gesetzt") ─

/** Vergleicht einen booleschen Ist-Wert gegen den Alle/Ja/Nein-Filter. */
function matchBool(actual: boolean, f: BoolFilter): boolean {
  if (f === 'alle') return true;
  return f === 'ja' ? actual : !actual;
}

/** Liefert die aus dem CRM-Profil abgeleiteten booleschen Merkmale eines Gastes. */
function crmFlags(m: GuestListMetrics) {
  const crm = m.crm ?? null;
  return {
    vipManual: crm?.vipManual === true,
    stammgastManual: crm?.stammgastManual === true,
    companyCustomer: crm?.companyCustomer === true,
    newsletter: crm?.newsletterOptIn === true,
    blocked: crm?.blockedGuest === true,
    hasAllergies: !!(crm?.allergies && crm.allergies.trim() !== ''),
    hasBirthday: !!crm?.birthday,
    hasCrmNote: !!(crm?.crmNotes && crm.crmNotes.trim() !== ''),
  };
}

/**
 * Volltextsuche über Name, E-Mail und Telefon (case-insensitive).  Leere Anfrage
 * lässt alle Gäste durch.  Identisch zur bisherigen Inline-Suche der Seite.
 */
export function matchSearch(m: GuestListMetrics, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    m.displayName.toLowerCase().includes(q) ||
    (m.email ?? '').toLowerCase().includes(q) ||
    (m.mobile ?? '').toLowerCase().includes(q)
  );
}

/** Wendet alle Filter (UND-verknüpft) auf die Gästeliste an. */
export function applyGuestFilters(metrics: GuestListMetrics[], f: GuestFilterState): GuestListMetrics[] {
  return metrics.filter(m => {
    if (!(
      matchSegment(m, f.segment) &&
      matchVisitCount(m, f.visitCount) &&
      matchLastVisit(m, f.lastVisit) &&
      matchPartySize(m, f.partySize) &&
      matchNoShow(m, f.noShow) &&
      matchReturnRisk(m, f.returnRisk)
    )) return false;

    const c = crmFlags(m);
    return (
      matchBool(c.vipManual, f.vipManual) &&
      matchBool(c.stammgastManual, f.stammgastManual) &&
      matchBool(c.companyCustomer, f.companyCustomer) &&
      matchBool(c.newsletter, f.newsletter) &&
      matchBool(c.blocked, f.blocked) &&
      matchBool(c.hasAllergies, f.hasAllergies) &&
      matchBool(c.hasBirthday, f.hasBirthday) &&
      matchBool(c.hasCrmNote, f.hasCrmNote)
    );
  });
}

/** Kombiniert Suche und Filter (beides UND-verknüpft). */
export function searchAndFilterGuests(
  metrics: GuestListMetrics[],
  query: string,
  f: GuestFilterState,
): GuestListMetrics[] {
  return applyGuestFilters(metrics, f).filter(m => matchSearch(m, query));
}

// ── Sortierung ────────────────────────────────────────────────────────────────

export type GuestSortKey =
  | 'name' | 'segment' | 'visits' | 'firstVisit'
  | 'lastVisit' | 'interval' | 'sinceLast' | 'partySize' | 'returnRisk'
  | 'birthday' | 'company';
export type SortDir = 'asc' | 'desc';

/** Stabiler Vergleich zweier Gäste nach Schlüssel (immer aufsteigend). */
export function compareGuests(a: GuestListMetrics, b: GuestListMetrics, key: GuestSortKey): number {
  const nullableNum = (x: number | null) => (x === null ? Number.NEGATIVE_INFINITY : x);
  const nullableStr = (x: string | null | undefined) => x ?? '';
  switch (key) {
    case 'name':       return a.displayName.localeCompare(b.displayName, 'de');
    case 'segment':    return SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment);
    case 'visits':     return a.visits - b.visits;
    case 'firstVisit': return nullableStr(a.firstVisit).localeCompare(nullableStr(b.firstVisit));
    case 'lastVisit':  return nullableStr(a.lastVisit).localeCompare(nullableStr(b.lastVisit));
    case 'interval':   return nullableNum(a.avgDaysBetweenVisits) - nullableNum(b.avgDaysBetweenVisits);
    case 'sinceLast':  return nullableNum(a.daysSinceLastVisit) - nullableNum(b.daysSinceLastVisit);
    case 'partySize':  return nullableNum(a.avgPartySize) - nullableNum(b.avgPartySize);
    case 'returnRisk': return nullableNum(returnRiskRatio(a)) - nullableNum(returnRiskRatio(b));
    // Manuelle CRM-Felder: fehlend (null/kein Profil) → leerer String → in
    // aufsteigender Sortierung zuerst, in absteigender zuletzt.
    case 'birthday':   return nullableStr(a.crm?.birthday).localeCompare(nullableStr(b.crm?.birthday));
    case 'company':    return nullableStr(a.crm?.company).localeCompare(nullableStr(b.crm?.company), 'de');
    default:           return 0;
  }
}

/** Liefert eine neue, sortierte Liste (mutiert die Eingabe nicht). */
export function sortGuests(
  metrics: GuestListMetrics[],
  key: GuestSortKey,
  dir: SortDir,
): GuestListMetrics[] {
  const arr = [...metrics];
  arr.sort((a, b) => {
    const base = compareGuests(a, b, key);
    return dir === 'asc' ? base : -base;
  });
  return arr;
}
