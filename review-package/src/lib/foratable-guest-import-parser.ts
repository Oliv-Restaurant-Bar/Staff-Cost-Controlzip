/**
 * Foratable Gästeexport — CSV-Parser (rein, ohne Supabase/DOM)
 * ============================================================
 * Liest den Foratable *Gäste*-Export (NICHT den Reservations-Export) und bildet
 * jede Zeile auf eine strukturierte `ParsedGuestRow` ab.  Das Ziel ist die
 * CRM-Anreicherung bestehender Gäste (`guest_crm_profiles`) — es werden KEINE
 * Reservationen, Besuchszahlen oder Segmente berührt.
 *
 * Datenschutz: Dieses Modul gibt NICHTS aus (kein Logging).  Personenbezogene
 * Felder bleiben in der Rückgabestruktur; Aggregat-Statistiken enthalten nur
 * Zahlen.
 *
 * Wiederverwendung: Die generischen CSV-/Normalisierungs-Helfer stammen aus
 * `reservation-import-parser.ts` (eine einzige Quelle der Wahrheit).
 */

import {
  stripBom, detectDelimiter, parseDelimited, stripDiacritics,
  normalizeEmail, normalizeMobile, parseGermanDate, computeChecksum,
} from './reservation-import-parser';

// ── Datentypen ───────────────────────────────────────────────────────────────

/** Eine geparste Gästezeile (bereits getrimmt + normalisiert für Matching). */
export interface ParsedGuestRow {
  rowNumber: number;            // 1-basiert (Datenzeilen, ohne Kopfzeile)
  title: string | null;        // Titel/Anrede (wird CRM-seitig ignoriert)
  company: string | null;      // Firma
  firstName: string | null;    // Vorname
  lastName: string | null;     // Name (im Export = Nachname)
  birthday: string | null;     // Geburtsdatum → "yyyy-MM-dd" | null
  guestInfo: string | null;    // Gästeinfo
  favoriteTable: string | null;// Sitzplatz / Lieblingsplatz
  dishes: string | null;       // Speisen / Präferenzen
  labels: string | null;       // Labels / Tags
  vip: boolean;                // VIP-Spalte ist positiv gesetzt
  newsletter: boolean;         // Newsletter = Ja
  blacklist: boolean;          // Blacklist / gesperrt = Ja
  // Matching-Schlüssel (normalisiert)
  normEmail: string | null;
  normMobile: string | null;
  normName: string | null;     // nur gesetzt, wenn Vor- UND Nachname vorhanden
  matchTier: 'email' | 'mobile' | 'name' | null; // Identitäts-Stufe nach Vorhandensein
}

/** Hinweis/Problem zu einer Zeile (nur Zahlen/Status, keine PII). */
export interface ForatableParseError {
  rowNumber: number;
  message: string;
}

/** Aggregat-Statistik der Vorschau (nur Zahlen). */
export interface ForatableGuestParseStats {
  rowCount: number;        // gelesene Datenzeilen gesamt (inkl. fehlerhafter)
  withEmail: number;
  withPhone: number;
  withName: number;        // Vor- UND Nachname vorhanden
  withAnyKey: number;      // mind. ein Identitäts-Schlüssel
  withoutKey: number;      // kein Identitäts-Schlüssel → später „nicht zuordenbar"
  vipCount: number;
  newsletterCount: number;
  blacklistCount: number;
  withCompany: number;
  withFavoriteTable: number;
  withBirthday: number;
  withNotes: number;       // Gästeinfo/Speisen/Labels vorhanden
}

export interface ForatableGuestParseResult {
  fileName: string;
  checksum: string;
  headerOk: boolean;
  rows: ParsedGuestRow[];
  errors: ForatableParseError[];
  stats: ForatableGuestParseStats;
}

// ── Spalten-Erkennung (über Header-Namen, robust gegen Umlaute/Reihenfolge) ───

type FieldKey =
  | 'title' | 'company' | 'firstName' | 'lastName' | 'birthday'
  | 'phone' | 'email' | 'guestInfo' | 'favoriteTable' | 'dishes'
  | 'labels' | 'vip' | 'newsletter' | 'blacklist';

/** Akzeptierte (normalisierte) Header-Bezeichnungen je Feld. */
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  title:         ['titel', 'title', 'anrede'],
  company:       ['firma', 'company', 'unternehmen'],
  firstName:     ['vorname', 'first name', 'firstname'],
  lastName:      ['name', 'nachname', 'last name', 'lastname'],
  birthday:      ['geburtsdatum', 'geburtstag', 'birthday', 'date of birth'],
  phone:         ['telefonnummer', 'telefon', 'telephone', 'phone', 'mobile', 'mobil', 'handy'],
  email:         ['e-mail', 'email', 'e mail', 'mail'],
  guestInfo:     ['gasteinfo', 'gastinfo', 'guest info', 'notiz', 'notizen', 'info', 'bemerkung'],
  favoriteTable: ['sitzplatz', 'lieblingsplatz', 'tisch', 'favorite table', 'table'],
  dishes:        ['speisen', 'praferenzen', 'preferences', 'lieblingsgericht', 'favorite dish'],
  labels:        ['labels', 'label', 'tags', 'tag'],
  vip:           ['vip'],
  newsletter:    ['newsletter', 'newsletter opt-in', 'newsletter opt in'],
  blacklist:     ['blacklist', 'gesperrt', 'sperrliste', 'blocked', 'blockiert'],
};

function normHeader(h: string): string {
  return stripDiacritics(String(h ?? '').trim().toLowerCase())
    .replace(/^"|"$/g, '')
    .replace(/\s+/g, ' ');
}

/** Baut eine Zuordnung FeldKey → Spaltenindex auf Basis der Kopfzeile. */
function mapColumns(header: string[]): Map<FieldKey, number> {
  const map = new Map<FieldKey, number>();
  header.forEach((cell, idx) => {
    const norm = normHeader(cell);
    for (const key of Object.keys(FIELD_ALIASES) as FieldKey[]) {
      if (map.has(key)) continue;            // erste passende Spalte gewinnt
      if (FIELD_ALIASES[key].includes(norm)) {
        map.set(key, idx);
        break;
      }
    }
  });
  return map;
}

// ── Wertparser ───────────────────────────────────────────────────────────────

/** Positive Boolean-Token (VIP-Spalte enthält z. B. das Wort „VIP", nicht „Ja"). */
const TRUE_TOKENS = new Set(['ja', 'vip', 'true', '1', 'yes', 'y', 'x', 'wahr', 'ok']);

/**
 * Erkennt nur EINEN positiven Wert.  „Nein"/leer/unbekannt = KEINE Information
 * (überschreibt später nie einen bestehenden Wert).
 */
export function isPositiveToken(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = stripDiacritics(String(raw).trim().toLowerCase());
  return s !== '' && TRUE_TOKENS.has(s);
}

function cellOrNull(value: string | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

/** Liefert nur dann einen Namensschlüssel, wenn Vor- UND Nachname vorhanden sind. */
export function strictNameKey(first: string | null, last: string | null): string | null {
  const f = stripDiacritics((first ?? '').trim().toLowerCase()).replace(/\s+/g, ' ');
  const l = stripDiacritics((last ?? '').trim().toLowerCase()).replace(/\s+/g, ' ');
  if (!f || !l) return null;
  const combined = `${f} ${l}`.trim();
  return combined.length < 3 ? null : combined;
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────

const EMPTY_STATS = (): ForatableGuestParseStats => ({
  rowCount: 0, withEmail: 0, withPhone: 0, withName: 0, withAnyKey: 0, withoutKey: 0,
  vipCount: 0, newsletterCount: 0, blacklistCount: 0,
  withCompany: 0, withFavoriteTable: 0, withBirthday: 0, withNotes: 0,
});

export function parseForatableGuestsCsv(fileName: string, rawText: string): ForatableGuestParseResult {
  const text = stripBom(rawText);
  const checksum = computeChecksum(text);
  const errors: ForatableParseError[] = [];
  const stats = EMPTY_STATS();

  const delimiter = detectDelimiter(text);
  const matrix = parseDelimited(text, delimiter);

  if (matrix.length === 0) {
    return { fileName, checksum, headerOk: false, rows: [], errors:
      [{ rowNumber: 0, message: 'Datei ist leer.' }], stats };
  }

  const header = matrix[0];
  const cols = mapColumns(header);

  // Mindestanforderung: ein Identitätsfeld (Name/E-Mail/Telefon) UND ein CRM-Merkmal.
  const hasIdentity = cols.has('lastName') || cols.has('email') || cols.has('phone');
  const hasCrmSignal = cols.has('vip') || cols.has('newsletter') || cols.has('blacklist')
    || cols.has('company') || cols.has('guestInfo') || cols.has('favoriteTable');
  if (!hasIdentity || !hasCrmSignal) {
    return {
      fileName, checksum, headerOk: false, rows: [], errors:
        [{ rowNumber: 0, message: 'Kopfzeile nicht als Foratable-Gästeexport erkannt.' }], stats,
    };
  }

  const get = (row: string[], key: FieldKey): string | undefined => {
    const idx = cols.get(key);
    return idx == null ? undefined : row[idx];
  };

  const rows: ParsedGuestRow[] = [];

  for (let i = 1; i < matrix.length; i++) {
    const raw = matrix[i];
    // Komplett leere Zeile überspringen (ohne sie als Fehler zu zählen).
    if (!raw || raw.every((c) => String(c ?? '').trim() === '')) continue;

    stats.rowCount++;
    const rowNumber = i; // 1-basiert über Datenzeilen hinweg

    const company       = cellOrNull(get(raw, 'company'));
    const firstName     = cellOrNull(get(raw, 'firstName'));
    const lastName      = cellOrNull(get(raw, 'lastName'));
    const title         = cellOrNull(get(raw, 'title'));
    const guestInfo     = cellOrNull(get(raw, 'guestInfo'));
    const favoriteTable = cellOrNull(get(raw, 'favoriteTable'));
    const dishes        = cellOrNull(get(raw, 'dishes'));
    const labels        = cellOrNull(get(raw, 'labels'));
    const birthday      = parseGermanDate(get(raw, 'birthday') ?? undefined);

    const vip        = isPositiveToken(get(raw, 'vip'));
    const newsletter = isPositiveToken(get(raw, 'newsletter'));
    const blacklist  = isPositiveToken(get(raw, 'blacklist'));

    const normEmail  = normalizeEmail(get(raw, 'email') ?? undefined);
    const normMobile = normalizeMobile(get(raw, 'phone') ?? undefined);
    const normName   = strictNameKey(firstName, lastName);

    const matchTier: ParsedGuestRow['matchTier'] =
      normEmail ? 'email' : normMobile ? 'mobile' : normName ? 'name' : null;

    // Statistik fortschreiben (nur Zahlen).
    if (normEmail) stats.withEmail++;
    if (normMobile) stats.withPhone++;
    if (normName) stats.withName++;
    if (matchTier) stats.withAnyKey++; else stats.withoutKey++;
    if (vip) stats.vipCount++;
    if (newsletter) stats.newsletterCount++;
    if (blacklist) stats.blacklistCount++;
    if (company) stats.withCompany++;
    if (favoriteTable) stats.withFavoriteTable++;
    if (birthday) stats.withBirthday++;
    if (guestInfo || dishes || labels) stats.withNotes++;

    rows.push({
      rowNumber, title, company, firstName, lastName, birthday,
      guestInfo, favoriteTable, dishes, labels,
      vip, newsletter, blacklist,
      normEmail, normMobile, normName, matchTier,
    });
  }

  return { fileName, checksum, headerOk: true, rows, errors, stats };
}
