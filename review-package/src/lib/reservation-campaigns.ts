/**
 * Gäste-CRM — Kampagnenlisten (reine Berechnungs-/Export-Logik, KEINE DB/DOM)
 * ===========================================================================
 * Leitet aus den bereits vorhandenen Listen-Kennzahlen (`GuestListMetrics`)
 * nutzbare Kampagnenlisten ab und exportiert sie als CSV.  Bewusst frei von
 * Supabase und DOM, damit alles als Unit ohne Datenbank/Browser getestet werden
 * kann.  Der eigentliche Datei-Download (Blob/Anchor) liegt in der Seite.
 *
 * Es werden ausschliesslich bestehende CRM-Daten verwendet — keine neue Abfrage,
 * keine Migration, keine Änderung an der Import-Logik oder am `guest_statistics`-
 * View.  Die Überfällig-/Gefährdet-Definitionen stammen wiederverwendet aus der
 * Rückkehrpotenzial-Logik (reservation-dashboard.ts).
 *
 * Segment-Entscheidung: Die segmentbasierten Kampagnen (Wiederkehrende,
 * Stammgäste, VIP, Ohne Besuch) nutzen das LIVE-Segment (`m.segment`) — exakt das,
 * was in der Gästeliste angezeigt wird.  Dadurch enthalten „Stammgäste"/„VIP" die
 * aktiven hochwertigen Gäste, während die seit > 90 Tagen abwesenden über die
 * eigenen „Gefährdete …"-Kampagnen erreichbar sind (klare, nicht-redundante Cuts).
 */

import {
  daysSince,
  SEGMENT_LABEL,
  INACTIVE_DAYS_THRESHOLD,
  type GuestListMetrics,
} from './reservation-crm';
import {
  isOverdue,
  isAtRiskTier,
  overdueByDays,
  NEW_GUEST_DAYS,
  NO_SHOW_RISK_MIN,
} from './reservation-dashboard';
import { isoToDate, type ExportCell, type ExportTable } from './export-cell';

// ── Schwellen ────────────────────────────────────────────────────────────────

/** „Inaktiv (kurz)": letzter Besuch liegt länger als 90 Tage zurück. */
export const INACTIVE_SHORT_DAYS = INACTIVE_DAYS_THRESHOLD; // 90
/** „Inaktiv (lang)": letzter Besuch liegt länger als 180 Tage zurück. */
export const INACTIVE_LONG_DAYS = 180;

// ── Kampagnen-Definition ─────────────────────────────────────────────────────

export type CampaignId =
  | 'ueberfaellige'
  | 'gefaehrdete-stammgaeste'
  | 'gefaehrdete-vip'
  | 'inaktiv-90'
  | 'inaktiv-180'
  | 'no-show-2plus'
  | 'wiederkehrende'
  | 'stammgaeste'
  | 'vip'
  | 'neukunden-30'
  | 'ohne-besuch'
  // ── Manuelle CRM-Merkmale (guest_crm_profiles) ──────────────────────────────
  | 'manuelle-vip'
  | 'manuelle-stammgaeste'
  | 'firmenkunden'
  | 'newsletter'
  | 'mit-allergien'
  | 'mit-geburtstag'
  | 'sperrliste';

export interface CampaignDef {
  id: CampaignId;
  /** Anzeigename (deutsch). */
  label: string;
  /** Kurzbeschreibung der Auswahl-Regel (deutsch). */
  description: string;
  /** Datei-Slug für den CSV-Export (ohne Präfix/Erweiterung). */
  slug: string;
  /** Auswahl-Prädikat über eine Gast-Kennzahl. `today` für datumsabhängige Regeln. */
  predicate: (m: GuestListMetrics, today: string) => boolean;
  /** Sortier-Vergleich für die Detail-/Exportliste (relevanteste zuerst). */
  sort: (a: GuestListMetrics, b: GuestListMetrics) => number;
}

// ── Sortier-Vergleiche ───────────────────────────────────────────────────────

const cmpName = (a: GuestListMetrics, b: GuestListMetrics): number =>
  a.displayName.localeCompare(b.displayName, 'de');

/** Längste Abwesenheit zuerst (null = unbekannt ans Ende). */
const byDaysSinceDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  (b.daysSinceLastVisit ?? -1) - (a.daysSinceLastVisit ?? -1) ||
  b.visits - a.visits || cmpName(a, b);

/** Höchste Besuchszahl zuerst. */
const byVisitsDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  b.visits - a.visits ||
  (b.daysSinceLastVisit ?? -1) - (a.daysSinceLastVisit ?? -1) || cmpName(a, b);

/** Meiste No-Shows zuerst. */
const byNoShowDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  b.noShowCount - a.noShowCount || b.visits - a.visits || cmpName(a, b);

/** Jüngster erster Besuch zuerst (null ans Ende). */
const byFirstVisitDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  (b.firstVisit ?? '').localeCompare(a.firstVisit ?? '') || cmpName(a, b);

/** Am stärksten überfällig zuerst. */
const byOverdueDesc = (a: GuestListMetrics, b: GuestListMetrics): number =>
  (overdueByDays(b) ?? 0) - (overdueByDays(a) ?? 0) ||
  (b.daysSinceLastVisit ?? -1) - (a.daysSinceLastVisit ?? -1) || cmpName(a, b);

// ── Inaktiv-Prädikat (rein datumsbasiert, unabhängig vom Segment) ────────────
// „Inaktiv" zählt jeden Gast mit bekanntem letztem Besuch, der länger als die
// Schwelle zurückliegt — auch Gäste mit nur 1–2 Besuchen.  Gäste „ohne Besuch"
// (kein letzter Besuch) sind hier ausgeschlossen und haben eine eigene Kampagne.
const inactiveLongerThan = (days: number) => (m: GuestListMetrics): boolean =>
  m.daysSinceLastVisit !== null && m.daysSinceLastVisit > days;

// ── Kampagnenliste ───────────────────────────────────────────────────────────

export const CAMPAIGNS: CampaignDef[] = [
  {
    id: 'ueberfaellige',
    label: 'Überfällige Gäste',
    slug: 'ueberfaellige-gaeste',
    description:
      'Letzter Besuch liegt länger als das 1,5-fache des gewohnten Besuchsintervalls zurück (mindestens 2 Besuche).',
    predicate: m => isOverdue(m),
    sort: byOverdueDesc,
  },
  {
    id: 'gefaehrdete-stammgaeste',
    label: 'Gefährdete Stammgäste',
    slug: 'gefaehrdete-stammgaeste',
    description:
      'Stammgäste (8–19 Besuche), die seit mehr als 90 Tagen nicht mehr da waren.',
    predicate: m => isAtRiskTier(m, 'stammgast'),
    sort: byDaysSinceDesc,
  },
  {
    id: 'gefaehrdete-vip',
    label: 'Gefährdete VIP-Gäste',
    slug: 'gefaehrdete-vip-gaeste',
    description:
      'VIP-Gäste (≥ 20 Besuche), die seit mehr als 90 Tagen nicht mehr da waren.',
    predicate: m => isAtRiskTier(m, 'vip'),
    sort: byDaysSinceDesc,
  },
  {
    id: 'inaktiv-90',
    label: 'Inaktive Gäste > 90 Tage',
    slug: 'inaktive-gaeste-90-tage',
    description:
      'Gäste, deren letzter Besuch mehr als 90 Tage zurückliegt.',
    predicate: inactiveLongerThan(INACTIVE_SHORT_DAYS),
    sort: byDaysSinceDesc,
  },
  {
    id: 'inaktiv-180',
    label: 'Inaktive Gäste > 180 Tage',
    slug: 'inaktive-gaeste-180-tage',
    description:
      'Gäste, deren letzter Besuch mehr als 180 Tage zurückliegt.',
    predicate: inactiveLongerThan(INACTIVE_LONG_DAYS),
    sort: byDaysSinceDesc,
  },
  {
    id: 'no-show-2plus',
    label: 'Gäste mit 2+ No-Shows',
    slug: 'gaeste-mit-2-plus-no-shows',
    description:
      'Gäste mit mindestens 2 No-Shows (nicht erschienen ohne Storno).',
    predicate: m => m.noShowCount >= NO_SHOW_RISK_MIN,
    sort: byNoShowDesc,
  },
  {
    id: 'wiederkehrende',
    label: 'Wiederkehrende Gäste',
    slug: 'wiederkehrende-gaeste',
    description:
      'Gäste mit 3–7 Besuchen (Segment „Wiederkehrend", aktiv).',
    predicate: m => m.segment === 'wiederkehrend',
    sort: byVisitsDesc,
  },
  {
    id: 'stammgaeste',
    label: 'Stammgäste',
    slug: 'stammgaeste',
    description:
      'Gäste mit 8–19 Besuchen (Segment „Stammgast", aktiv).',
    predicate: m => m.segment === 'stammgast',
    sort: byVisitsDesc,
  },
  {
    id: 'vip',
    label: 'VIP-Gäste',
    slug: 'vip-gaeste',
    description:
      'Gäste mit ≥ 20 Besuchen (Segment „VIP", aktiv).',
    predicate: m => m.segment === 'vip',
    sort: byVisitsDesc,
  },
  {
    id: 'neukunden-30',
    label: 'Neukunden letzte 30 Tage',
    slug: 'neukunden-letzte-30-tage',
    description:
      'Gäste mit ihrem ersten Besuch innerhalb der letzten 30 Tage.',
    predicate: (m, today) => {
      if (m.visits <= 0) return false;
      const since = daysSince(m.firstVisit, today);
      return since !== null && since <= NEW_GUEST_DAYS;
    },
    sort: byFirstVisitDesc,
  },
  {
    id: 'ohne-besuch',
    label: 'Gäste ohne Besuch',
    slug: 'gaeste-ohne-besuch',
    description:
      'Gäste mit Reservationen, aber ohne einen einzigen abgeschlossenen Besuch (z. B. nur Stornos/offene Buchungen).',
    predicate: m => m.segment === 'ohne_besuch',
    sort: cmpName,
  },
  // ── Manuelle CRM-Merkmale (guest_crm_profiles) — rein additiv, unabhängig vom
  //    automatisch berechneten Segment.  Fehlt das Profil, ist das Merkmal nicht
  //    gesetzt (defensiv über `m.crm?`). ───────────────────────────────────────
  {
    id: 'manuelle-vip',
    label: 'Manuelle VIP',
    slug: 'manuelle-vip',
    description:
      'Gäste, die im CRM-Profil manuell als VIP markiert wurden.',
    predicate: m => m.crm?.vipManual === true,
    sort: byVisitsDesc,
  },
  {
    id: 'manuelle-stammgaeste',
    label: 'Manuelle Stammgäste',
    slug: 'manuelle-stammgaeste',
    description:
      'Gäste, die im CRM-Profil manuell als Stammgast markiert wurden.',
    predicate: m => m.crm?.stammgastManual === true,
    sort: byVisitsDesc,
  },
  {
    id: 'firmenkunden',
    label: 'Firmenkunden',
    slug: 'firmenkunden',
    description:
      'Gäste, die im CRM-Profil als Firmenkunde markiert sind.',
    predicate: m => m.crm?.companyCustomer === true,
    sort: cmpName,
  },
  {
    id: 'newsletter',
    label: 'Newsletter erlaubt',
    slug: 'newsletter-erlaubt',
    description:
      'Gäste mit Newsletter-Einwilligung (Opt-in) im CRM-Profil.',
    predicate: m => m.crm?.newsletterOptIn === true,
    sort: cmpName,
  },
  {
    id: 'mit-allergien',
    label: 'Gäste mit Allergien',
    slug: 'gaeste-mit-allergien',
    description:
      'Gäste mit hinterlegten Allergien im CRM-Profil.',
    predicate: m => !!(m.crm?.allergies && m.crm.allergies.trim() !== ''),
    sort: cmpName,
  },
  {
    id: 'mit-geburtstag',
    label: 'Gäste mit Geburtstag',
    slug: 'gaeste-mit-geburtstag',
    description:
      'Gäste mit hinterlegtem Geburtstag im CRM-Profil.',
    predicate: m => !!m.crm?.birthday,
    sort: cmpName,
  },
  {
    id: 'sperrliste',
    label: 'Sperrliste',
    slug: 'sperrliste',
    description:
      'Gäste, die im CRM-Profil auf die Sperrliste gesetzt wurden.',
    predicate: m => m.crm?.blockedGuest === true,
    sort: cmpName,
  },
];

/** Schneller Zugriff auf eine Kampagnen-Definition per Id. */
export const CAMPAIGN_BY_ID: Record<CampaignId, CampaignDef> = CAMPAIGNS.reduce(
  (acc, def) => { acc[def.id] = def; return acc; },
  {} as Record<CampaignId, CampaignDef>,
);

// ── Filterung & Zusammenfassung ──────────────────────────────────────────────

/** Wendet das Prädikat an und sortiert die Treffer (relevanteste zuerst). */
export function filterCampaign(
  metrics: GuestListMetrics[],
  campaign: CampaignDef,
  today: string,
): GuestListMetrics[] {
  return metrics
    .filter(m => campaign.predicate(m, today))
    .sort(campaign.sort);
}

export interface CampaignSummary {
  def: CampaignDef;
  count: number;
}

/** Anzahl Treffer je Kampagne (für die Übersichts-Kacheln). */
export function summarizeCampaigns(
  metrics: GuestListMetrics[],
  today: string,
): CampaignSummary[] {
  return CAMPAIGNS.map(def => ({
    def,
    count: metrics.reduce((n, m) => n + (def.predicate(m, today) ? 1 : 0), 0),
  }));
}

// ── CSV-Export ───────────────────────────────────────────────────────────────

/** Spaltenüberschriften (deutsch) — Reihenfolge = Spaltenreihenfolge der Zeilen. */
export const CSV_HEADERS: readonly string[] = [
  'Name',
  'E-Mail',
  'Telefon',
  'Segment',
  'Besuche',
  'Letzter Besuch',
  'Tage seit letztem Besuch',
  'Durchschnittliches Intervall',
  'No Shows',
  // ── Manuelle CRM-Felder (guest_crm_profiles) — leer, wenn kein Profil ───────
  'VIP (manuell)',
  'Stammgast (manuell)',
  'Firmenkunde',
  'Newsletter',
  'Sperrliste',
  'Geburtstag',
  'Firma',
  'Allergien',
];

/** ISO-Datum „yyyy-MM-dd" → „dd.MM.yyyy"; leer bei fehlendem/ungültigem Wert. */
function formatGermanDate(iso: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Quotet eine Zelle nur, wenn nötig (Trennzeichen, Anführungszeichen, Umbruch). */
function escapeCsvCell(value: string): string {
  if (value === '') return '';
  if (/[";\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** „Ja" bei true, sonst leer — für boolesche Merkmal-Spalten. */
const yesOrEmpty = (b: boolean | null | undefined): string => (b ? 'Ja' : '');

/** Eine Kampagnenzeile als Zellwerte (fehlende Werte → leerer String). */
export function campaignRowToCsvValues(m: GuestListMetrics): string[] {
  const crm = m.crm ?? null;
  return [
    m.displayName,
    m.email ?? '',
    m.mobile ?? '',
    SEGMENT_LABEL[m.segment],
    String(m.visits),
    formatGermanDate(m.lastVisit),
    m.daysSinceLastVisit === null ? '' : String(m.daysSinceLastVisit),
    m.avgDaysBetweenVisits === null ? '' : String(Math.round(m.avgDaysBetweenVisits)),
    String(m.noShowCount),
    // ── Manuelle CRM-Felder (leer, wenn kein Profil/Wert) ─────────────────────
    yesOrEmpty(crm?.vipManual),
    yesOrEmpty(crm?.stammgastManual),
    yesOrEmpty(crm?.companyCustomer),
    yesOrEmpty(crm?.newsletterOptIn),
    yesOrEmpty(crm?.blockedGuest),
    formatGermanDate(crm?.birthday ?? null),
    crm?.company ?? '',
    crm?.allergies ?? '',
  ];
}

/**
 * Baut den CSV-Inhalt (ohne BOM): Kopfzeile + eine Zeile je Gast, Semikolon als
 * Trennzeichen, CRLF als Zeilenumbruch.  Das UTF-8-BOM wird erst beim Download
 * (in der Seite) vorangestellt, damit Excel die Umlaute korrekt erkennt.
 */
export function buildCampaignCsv(rows: GuestListMetrics[]): string {
  const lines = [CSV_HEADERS.slice(), ...rows.map(campaignRowToCsvValues)];
  return lines
    .map(cols => cols.map(escapeCsvCell).join(';'))
    .join('\r\n');
}

/** Dateiname für den Export, z. B. „crm-kampagne-ueberfaellige-gaeste.csv". */
export function campaignCsvFilename(campaign: CampaignDef): string {
  return `crm-kampagne-${campaign.slug}.csv`;
}

// ── Typisierter Export (CSV + Excel) ──────────────────────────────────────────

/**
 * Eine Kampagnenzeile als typisierte Zellen (Spaltenreihenfolge = `CSV_HEADERS`):
 * Datumswerte als `Date`, Zahlen als Zahlen — Basis für den Excel-Export. Bei
 * fehlenden Werten leere Zellen (`null`); boolesche Merkmale als „Ja"/"".
 */
export function campaignRowToCells(m: GuestListMetrics): ExportCell[] {
  const crm = m.crm ?? null;
  return [
    m.displayName,
    m.email ?? null,
    m.mobile ?? null,
    SEGMENT_LABEL[m.segment],
    m.visits,
    isoToDate(m.lastVisit),
    m.daysSinceLastVisit,
    m.avgDaysBetweenVisits === null ? null : Math.round(m.avgDaysBetweenVisits),
    m.noShowCount,
    crm?.vipManual ? 'Ja' : '',
    crm?.stammgastManual ? 'Ja' : '',
    crm?.companyCustomer ? 'Ja' : '',
    crm?.newsletterOptIn ? 'Ja' : '',
    crm?.blockedGuest ? 'Ja' : '',
    isoToDate(crm?.birthday ?? null),
    crm?.company ?? null,
    crm?.allergies ?? null,
  ];
}

/** Baut eine `ExportTable` (für CSV/Excel) aus einer gefilterten Kampagnenliste. */
export function campaignExportTable(
  campaign: CampaignDef,
  rows: GuestListMetrics[],
): ExportTable {
  return {
    filename: `crm-kampagne-${campaign.slug}`,
    sheetName: 'Kampagne',
    headers: CSV_HEADERS.slice(),
    rows: rows.map(campaignRowToCells),
  };
}
