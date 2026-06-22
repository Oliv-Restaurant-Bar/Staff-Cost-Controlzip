/**
 * Gäste-CRM — Spaltenmodell der Gästeliste (reine Logik, KEINE DB/DOM)
 * =============================================================================
 * Beschreibt die in `/gaeste` verfügbaren Tabellenspalten, ihre Reihenfolge,
 * Standard-Sichtbarkeit und (sofern sortierbar) den zugehörigen Sortierschlüssel.
 * Die tatsächliche Zell-Darstellung lebt in der Seite (JSX); hier liegen nur die
 * Metadaten, damit die Auswahl rein getestet werden kann.
 *
 * Persistenz: Die sichtbare Spaltenauswahl wird (validiert) in `localStorage`
 * gehalten. Ungültige/leere gespeicherte Werte fallen immer auf den Standard
 * zurück — die Liste ist nie ohne Spalten.
 */

import type { GuestSortKey } from './guest-list-filters';

/** Stabile Schlüssel aller verfügbaren Spalten der Gästeliste. */
export type GuestColumnKey =
  | 'name' | 'segment' | 'company' | 'birthday' | 'visits' | 'partySize'
  | 'firstVisit' | 'lastVisit' | 'interval' | 'sinceLast' | 'returnRisk'
  | 'vipManual' | 'stammgastManual' | 'companyCustomer' | 'newsletter'
  | 'blocked' | 'allergies' | 'crmNote';

export interface GuestColumn {
  key: GuestColumnKey;
  /** Deutscher Spaltenkopf. */
  label: string;
  align: 'left' | 'right';
  /** Sortierschlüssel, falls die Spalte sortierbar ist. */
  sortKey?: GuestSortKey;
  /** Teil der Standard-Sichtbarkeit. */
  default: boolean;
}

/**
 * Kanonische Spaltenreihenfolge. Die Tabelle rendert immer in dieser Reihenfolge
 * (gefiltert auf die sichtbaren Spalten) — unabhängig von der Speicher-Reihenfolge.
 */
export const GUEST_COLUMNS: GuestColumn[] = [
  { key: 'name',            label: 'Gast',                align: 'left',  sortKey: 'name',       default: true },
  { key: 'segment',         label: 'Segment',             align: 'left',  sortKey: 'segment',    default: true },
  { key: 'company',         label: 'Firma',               align: 'left',  sortKey: 'company',    default: false },
  { key: 'birthday',        label: 'Geburtstag',          align: 'right', sortKey: 'birthday',   default: false },
  { key: 'visits',          label: 'Besuche',             align: 'right', sortKey: 'visits',     default: true },
  { key: 'partySize',       label: 'Ø Gruppe',            align: 'right', sortKey: 'partySize',  default: true },
  { key: 'firstVisit',      label: 'Erster Besuch',       align: 'right', sortKey: 'firstVisit', default: true },
  { key: 'lastVisit',       label: 'Letzter Besuch',      align: 'right', sortKey: 'lastVisit',  default: true },
  { key: 'interval',        label: 'Ø Intervall',         align: 'right', sortKey: 'interval',   default: true },
  { key: 'sinceLast',       label: 'Tage seit letztem',   align: 'right', sortKey: 'sinceLast',  default: true },
  { key: 'returnRisk',      label: 'Rückkehr-Risiko',     align: 'right', sortKey: 'returnRisk', default: true },
  { key: 'vipManual',       label: 'VIP (manuell)',       align: 'left',  default: false },
  { key: 'stammgastManual', label: 'Stammgast (manuell)', align: 'left',  default: false },
  { key: 'companyCustomer', label: 'Firmenkunde',         align: 'left',  default: false },
  { key: 'newsletter',      label: 'Newsletter',          align: 'left',  default: false },
  { key: 'blocked',         label: 'Sperrliste',          align: 'left',  default: false },
  { key: 'allergies',       label: 'Allergien',           align: 'left',  default: false },
  { key: 'crmNote',         label: 'CRM-Notiz',           align: 'left',  default: false },
];

/** Schnellzugriff Schlüssel → Spaltendefinition. */
export const GUEST_COLUMN_BY_KEY: Record<GuestColumnKey, GuestColumn> =
  Object.fromEntries(GUEST_COLUMNS.map(c => [c.key, c])) as Record<GuestColumnKey, GuestColumn>;

/** Standard-sichtbare Spalten in kanonischer Reihenfolge. */
export const DEFAULT_VISIBLE_COLUMNS: GuestColumnKey[] =
  GUEST_COLUMNS.filter(c => c.default).map(c => c.key);

const ALL_KEYS = new Set<string>(GUEST_COLUMNS.map(c => c.key));

/**
 * Bereinigt eine (ggf. unbekannte) Eingabe zu einer gültigen Spaltenauswahl:
 * unbekannte/duplizierte Schlüssel fallen weg, das Ergebnis steht in kanonischer
 * Reihenfolge. Ist nach der Bereinigung nichts mehr übrig → Standardauswahl.
 */
export function validateVisibleColumns(input: unknown): GuestColumnKey[] {
  if (!Array.isArray(input)) return [...DEFAULT_VISIBLE_COLUMNS];
  const seen = new Set<GuestColumnKey>();
  for (const v of input) {
    if (typeof v === 'string' && ALL_KEYS.has(v)) seen.add(v as GuestColumnKey);
  }
  if (seen.size === 0) return [...DEFAULT_VISIBLE_COLUMNS];
  return GUEST_COLUMNS.filter(c => seen.has(c.key)).map(c => c.key);
}

/**
 * Schaltet eine Spalte ein/aus. Mindestens eine Spalte bleibt immer sichtbar
 * (das Abwählen der letzten Spalte ist ein No-Op). Ergebnis in kanonischer Reihenfolge.
 */
export function toggleColumn(visible: GuestColumnKey[], key: GuestColumnKey): GuestColumnKey[] {
  const set = new Set(validateVisibleColumns(visible));
  if (set.has(key)) {
    if (set.size <= 1) return [...set];   // letzte Spalte nicht entfernen
    set.delete(key);
  } else {
    set.add(key);
  }
  return GUEST_COLUMNS.filter(c => set.has(c.key)).map(c => c.key);
}

const STORAGE_KEY = 'gaeste:visibleColumns';

/** Lädt die gespeicherte Spaltenauswahl (validiert) oder den Standard. */
export function loadVisibleColumns(): GuestColumnKey[] {
  if (typeof window === 'undefined') return [...DEFAULT_VISIBLE_COLUMNS];
  try {
    // Zugriff auf window.localStorage selbst kann (privater Modus) werfen.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_VISIBLE_COLUMNS];
    return validateVisibleColumns(JSON.parse(raw));
  } catch {
    return [...DEFAULT_VISIBLE_COLUMNS];
  }
}

/** Speichert die (validierte) Spaltenauswahl. Fehlt der Speicher, passiert nichts. */
export function saveVisibleColumns(keys: GuestColumnKey[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Zugriff auf window.localStorage selbst kann (privater Modus) werfen.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validateVisibleColumns(keys)));
  } catch {
    /* Speicher voll / privater Modus → UI bleibt funktionsfähig. */
  }
}
