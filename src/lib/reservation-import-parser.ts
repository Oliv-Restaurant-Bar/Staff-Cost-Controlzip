/**
 * Foratable Reservationen — reiner Parser (KEINE DB-Abhängigkeit)
 * ================================================================
 * Liest CSV-Exporte aus dem Reservationstool Foratable:
 *   - Semikolon-getrennt
 *   - optionales UTF-8 BOM
 *   - in Anführungszeichen eingeschlossene Felder (mit "" als Escape)
 *
 * Header (Reihenfolge kann variieren — gemappt wird nach Spaltennamen):
 *   Restaurant;Res.Nr.;Personen;Zeit;Datum;Firma;Vorname;Nachname;Mobile;
 *   E-Mail;Status;"reserviert am";Kommentar;Notiz;Tisch;Auswahl;
 *   Gästeinformationen;Raum;Bereich
 *
 * Dieses Modul ist bewusst frei von Supabase/DOM, damit es als Unit ohne
 * Datenbank getestet werden kann.
 */

// ── Typen ────────────────────────────────────────────────────────────────────

export type ReservationStatusNormalized =
  | 'completed'
  | 'cancelled'
  | 'noshow'
  | 'confirmed'
  | 'pending'
  | 'unknown';

export interface ParsedReservation {
  restaurantName: string;
  externalReservationId: string;
  partySize: number | null;
  reservationTime: string | null;   // "HH:mm"
  reservationDate: string | null;    // "yyyy-MM-dd"
  company: string;
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  statusRaw: string;
  statusNormalized: ReservationStatusNormalized;
  reservedAt: string | null;         // ISO "yyyy-MM-ddTHH:mm:ss"
  comment: string;
  note: string;
  tableName: string;
  selection: string;
  guestInformation: string;
  room: string;
  area: string;
  // abgeleitete Gast-Identität
  normalizedEmail: string | null;
  normalizedMobile: string | null;
  normalizedName: string | null;
  matchKey: string | null;           // 'email:…' | 'mobile:…' | 'name:…'
  rowNumber: number;                 // 1-basierte Datenzeile (ohne Header)
}

export interface ReservationParseError {
  rowNumber: number;
  message: string;
}

export interface StatusDistributionEntry {
  status: string;                    // Rohwert (oder '(leer)')
  normalized: ReservationStatusNormalized;
  count: number;
}

export interface TopTimeEntry {
  time: string;                      // "HH:mm"
  count: number;
  persons: number;
}

export interface NameCountEntry {
  name: string;
  count: number;
}

export interface ReservationPreviewStats {
  reservationCount: number;
  totalPersons: number;
  periodFrom: string | null;         // yyyy-MM-dd
  periodTo: string | null;
  completedCount: number;
  cancelledCount: number;
  noshowCount: number;
  unknownStatusCount: number;
  statusDistribution: StatusDistributionEntry[];
  topTimes: TopTimeEntry[];
  rooms: NameCountEntry[];
  areas: NameCountEntry[];
  distinctGuestKeys: string[];       // matchKeys (für neue/wiederkehrende Klassifizierung)
  reservationsWithoutGuestKey: number;
  avgPartySize: number | null;
}

export interface ReservationParseResult {
  fileName: string;
  reservations: ParsedReservation[];
  errors: ReservationParseError[];
  stats: ReservationPreviewStats;
  checksum: string;
  headerOk: boolean;
  headerMissing: string[];           // fehlende Pflicht-/erwartete Spalten
}

// ── CSV-Grundfunktionen ──────────────────────────────────────────────────────

/** Entfernt ein eventuell vorhandenes UTF-8 BOM am Dateianfang. */
export function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  if (text.startsWith('\u00ef\u00bb\u00bf')) return text.slice(3);
  return text;
}

/**
 * Erkennt das Trennzeichen.  Foratable nutzt Semikolon; zur Sicherheit wird
 * gegen Komma/Tab abgewogen (Mehrheit in der ersten nicht-leeren Zeile).
 */
export function detectDelimiter(text: string): ';' | ',' | '\t' {
  const firstLine = stripBom(text).split(/\r?\n/).find(l => l.trim().length > 0) ?? '';
  const counts: Array<[';' | ',' | '\t', number]> = [
    [';', (firstLine.match(/;/g) || []).length],
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

/**
 * State-Machine-CSV-Parser: respektiert Anführungszeichen (auch mit
 * eingebetteten Trennzeichen und Zeilenumbrüchen) und "" als Escape.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // hat die aktuelle Zeile schon irgendeinen Inhalt?
  const n = text.length;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; started = false; };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; started = true; i++; continue; }
    if (c === delimiter) { endField(); started = true; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      if (started || field.length > 0 || row.length > 0) endRow();
      i++; continue;
    }
    field += c; started = true; i++;
  }
  if (started || field.length > 0 || row.length > 0) endRow();

  // Komplett leere Zeilen verwerfen.
  return rows.filter(r => r.some(cell => cell.trim().length > 0));
}

// ── Header-Mapping ───────────────────────────────────────────────────────────

type FieldKey =
  | 'restaurantName' | 'externalReservationId' | 'partySize' | 'reservationTime'
  | 'reservationDate' | 'company' | 'firstName' | 'lastName' | 'mobile' | 'email'
  | 'statusRaw' | 'reservedAt' | 'comment' | 'note' | 'tableName' | 'selection'
  | 'guestInformation' | 'room' | 'area';

function normHeaderCell(h: string): string {
  return stripDiacritics(h.replace(/^"|"$/g, '').trim().toLowerCase())
    .replace(/\s+/g, ' ');
}

const HEADER_LOOKUP: Record<string, FieldKey> = {
  'restaurant': 'restaurantName',
  'res.nr.': 'externalReservationId',
  'res.nr': 'externalReservationId',
  'res nr': 'externalReservationId',
  'resnr': 'externalReservationId',
  'reservierungsnr': 'externalReservationId',
  'reservierungsnummer': 'externalReservationId',
  'personen': 'partySize',
  'anzahl': 'partySize',
  'pers': 'partySize',
  'zeit': 'reservationTime',
  'uhrzeit': 'reservationTime',
  'datum': 'reservationDate',
  'firma': 'company',
  'vorname': 'firstName',
  'nachname': 'lastName',
  'name': 'lastName',
  'mobile': 'mobile',
  'telefon': 'mobile',
  'handy': 'mobile',
  'e-mail': 'email',
  'email': 'email',
  'e mail': 'email',
  'mail': 'email',
  'status': 'statusRaw',
  'reserviert am': 'reservedAt',
  'kommentar': 'comment',
  'notiz': 'note',
  'tisch': 'tableName',
  'auswahl': 'selection',
  'gasteinformationen': 'guestInformation',
  'gasteinformation': 'guestInformation',
  'raum': 'room',
  'bereich': 'area',
};

/** Spalten, deren Fehlen wir in der Vorschau melden (Pflicht: externalReservationId). */
const EXPECTED_HEADERS: Record<FieldKey, string> = {
  restaurantName: 'Restaurant',
  externalReservationId: 'Res.Nr.',
  partySize: 'Personen',
  reservationTime: 'Zeit',
  reservationDate: 'Datum',
  company: 'Firma',
  firstName: 'Vorname',
  lastName: 'Nachname',
  mobile: 'Mobile',
  email: 'E-Mail',
  statusRaw: 'Status',
  reservedAt: 'reserviert am',
  comment: 'Kommentar',
  note: 'Notiz',
  tableName: 'Tisch',
  selection: 'Auswahl',
  guestInformation: 'Gästeinformationen',
  room: 'Raum',
  area: 'Bereich',
};

function buildHeaderMap(headerRow: string[]): Partial<Record<FieldKey, number>> {
  const map: Partial<Record<FieldKey, number>> = {};
  headerRow.forEach((cell, idx) => {
    const key = HEADER_LOOKUP[normHeaderCell(cell)];
    if (key && map[key] === undefined) map[key] = idx;
  });
  return map;
}

// ── Normalisierung & Parsing einzelner Felder ────────────────────────────────

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** "dd.MM.yyyy" / "dd.MM.yy" / "yyyy-MM-dd" → "yyyy-MM-dd" | null */
export function parseGermanDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // bereits ISO?
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  let year = +m[3];
  if (year < 100) year += year < 70 ? 2000 : 1900;
  return validDate(year, +m[2], +m[1]);
}

function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const mm = String(mo).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** "HH:mm" / "H:mm" / "HH:mm:ss" / "HH.mm" → "HH:mm" | null */
export function parseTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?/);
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "dd.MM.yyyy HH:mm[:ss]" → ISO "yyyy-MM-ddTHH:mm:ss" | null */
export function parseReservedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const datePart = parseGermanDate(s);
  if (!datePart) return null;
  // Datums-Teil entfernen, damit parseTime nicht "01.05" als Zeit liest.
  const dateMatch =
    s.match(/^\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/) ?? s.match(/^\s*\d{4}-\d{2}-\d{2}/);
  const remainder = dateMatch ? s.slice(dateMatch[0].length) : s;
  const time = parseTime(remainder) ?? '00:00';
  return `${datePart}T${time}:00`;
}

export function parsePartySize(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

export function normalizeEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s.includes('@') || s.length < 5) return null;
  return s;
}

/**
 * Telefon-Normalisierung für Gast-Matching.  Reduziert auf Ziffern,
 * entfernt internationale Präfixe grob (00 → weg).  Bewusst tolerant:
 * verschiedene Schreibweisen derselben Nummer sollen zusammenfallen.
 */
export function normalizeMobile(raw: string | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  digits = digits.replace(/^\+/, '');
  digits = digits.replace(/^00/, '');
  if (digits.length < 7) return null;
  return digits;
}

export function normalizeName(first: string | undefined, last: string | undefined): string | null {
  const f = stripDiacritics((first ?? '').trim().toLowerCase()).replace(/\s+/g, ' ');
  const l = stripDiacritics((last ?? '').trim().toLowerCase()).replace(/\s+/g, ' ');
  const combined = `${f} ${l}`.trim();
  if (combined.length < 2) return null;
  return combined;
}

/** Identitäts-Schlüssel: E-Mail → Mobile → Name. */
export function buildMatchKey(
  normEmail: string | null,
  normMobile: string | null,
  normName: string | null,
): string | null {
  if (normEmail) return `email:${normEmail}`;
  if (normMobile) return `mobile:${normMobile}`;
  if (normName) return `name:${normName}`;
  return null;
}

export function normalizeStatus(raw: string | undefined): ReservationStatusNormalized {
  const s = stripDiacritics((raw ?? '').trim().toLowerCase());
  if (!s) return 'unknown';
  if (/(storn|abgesagt|abgelehnt|cancel|annull|declin|reject)/.test(s)) return 'cancelled';
  if (/(no.?show|nicht erschien|not arrived|nicht gekommen)/.test(s)) return 'noshow';
  if (/(abgeschloss|erledigt|beendet|eingecheckt|checked|besucht|seated|arrived|complete|eingelost|eingeloest|done)/.test(s)) return 'completed';
  if (/(bestatigt|confirmed|zugesagt|akzeptiert|accepted)/.test(s)) return 'confirmed';
  if (/(offen|angefragt|pending|reserviert|wartet|nicht beantwortet|unbeantwortet|keine antwort|open|request|neu|new)/.test(s)) return 'pending';
  return 'unknown';
}

/** Einfacher, stabiler Hash (djb2) als Hex — für Datei-Checksumme. */
export function computeChecksum(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────

/**
 * Dedupliziert Reservationen nach ihrem eindeutigen Upsert-Schlüssel
 * (`externalReservationId` — entspricht dem DB-Conflict-Key
 * `restaurant_id, external_reservation_id`). Mehrere CSV-Zeilen mit identischer
 * Res.Nr. würden sonst denselben Datensatz im selben Bulk-Upsert mehrfach
 * treffen ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 *
 * Deterministisch: die **zuletzt** vorkommende Zeile gewinnt; die Reihenfolge
 * (erstes Auftreten des Schlüssels) bleibt erhalten. Zeilen ohne Res.Nr. gibt
 * es nach dem Parsen nicht (sie werden im Parser übersprungen).
 *
 * @returns `deduped` (eine Zeile pro Res.Nr.) und `duplicateKeyMerged`
 *   (Anzahl der wegen identischem Schlüssel zusammengeführten Zeilen).
 */
export function dedupeReservationsByExternalId(
  reservations: ParsedReservation[],
): { deduped: ParsedReservation[]; duplicateKeyMerged: number } {
  const byKey = new Map<string, ParsedReservation>();
  for (const r of reservations) {
    // Map.set behält bei vorhandenem Schlüssel die Einfügeposition, ersetzt aber
    // den Wert → stabile Reihenfolge nach erstem Auftreten, letzte Zeile gewinnt.
    byKey.set(r.externalReservationId, r);
  }
  const deduped = [...byKey.values()];
  return { deduped, duplicateKeyMerged: reservations.length - deduped.length };
}

export function parseReservationsCsv(fileName: string, rawText: string): ReservationParseResult {
  const text = stripBom(rawText);
  const checksum = computeChecksum(text);
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);

  const empty: ReservationParseResult = {
    fileName,
    reservations: [],
    errors: [{ rowNumber: 0, message: 'Datei enthält keine Daten.' }],
    stats: emptyStats(),
    checksum,
    headerOk: false,
    headerMissing: Object.values(EXPECTED_HEADERS),
  };
  if (rows.length === 0) return empty;

  const headerRow = rows[0];
  const map = buildHeaderMap(headerRow);

  const headerMissing: string[] = [];
  (Object.keys(EXPECTED_HEADERS) as FieldKey[]).forEach(k => {
    if (map[k] === undefined) headerMissing.push(EXPECTED_HEADERS[k]);
  });
  const headerOk = map.externalReservationId !== undefined;

  if (!headerOk) {
    return {
      ...empty,
      errors: [{ rowNumber: 0, message: 'Pflichtspalte "Res.Nr." nicht gefunden. Ist es ein Foratable-Export?' }],
      headerMissing,
    };
  }

  const get = (cells: string[], key: FieldKey): string => {
    const idx = map[key];
    if (idx === undefined) return '';
    return (cells[idx] ?? '').trim();
  };

  const reservations: ParsedReservation[] = [];
  const errors: ReservationParseError[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const rowNumber = r; // 1-basierte Datenzeile
    const externalReservationId = get(cells, 'externalReservationId');
    if (!externalReservationId) {
      errors.push({ rowNumber, message: 'Zeile ohne Res.Nr. — übersprungen.' });
      continue;
    }

    const firstName = get(cells, 'firstName');
    const lastName = get(cells, 'lastName');
    const mobile = get(cells, 'mobile');
    const email = get(cells, 'email');

    const normalizedEmail = normalizeEmail(email);
    const normalizedMobile = normalizeMobile(mobile);
    const normalizedName = normalizeName(firstName, lastName);
    const matchKey = buildMatchKey(normalizedEmail, normalizedMobile, normalizedName);

    const statusRaw = get(cells, 'statusRaw');
    const reservationDate = parseGermanDate(get(cells, 'reservationDate'));

    if (!reservationDate && get(cells, 'reservationDate')) {
      errors.push({ rowNumber, message: `Datum "${get(cells, 'reservationDate')}" nicht erkannt (Res.Nr. ${externalReservationId}).` });
    }

    reservations.push({
      restaurantName: get(cells, 'restaurantName'),
      externalReservationId,
      partySize: parsePartySize(get(cells, 'partySize')),
      reservationTime: parseTime(get(cells, 'reservationTime')),
      reservationDate,
      company: get(cells, 'company'),
      firstName,
      lastName,
      mobile,
      email,
      statusRaw,
      statusNormalized: normalizeStatus(statusRaw),
      reservedAt: parseReservedAt(get(cells, 'reservedAt')),
      comment: get(cells, 'comment'),
      note: get(cells, 'note'),
      tableName: get(cells, 'tableName'),
      selection: get(cells, 'selection'),
      guestInformation: get(cells, 'guestInformation'),
      room: get(cells, 'room'),
      area: get(cells, 'area'),
      normalizedEmail,
      normalizedMobile,
      normalizedName,
      matchKey,
      rowNumber,
    });
  }

  return {
    fileName,
    reservations,
    errors,
    stats: computeStats(reservations),
    checksum,
    headerOk: true,
    headerMissing,
  };
}

// ── Statistik / Vorschau ─────────────────────────────────────────────────────

function emptyStats(): ReservationPreviewStats {
  return {
    reservationCount: 0,
    totalPersons: 0,
    periodFrom: null,
    periodTo: null,
    completedCount: 0,
    cancelledCount: 0,
    noshowCount: 0,
    unknownStatusCount: 0,
    statusDistribution: [],
    topTimes: [],
    rooms: [],
    areas: [],
    distinctGuestKeys: [],
    reservationsWithoutGuestKey: 0,
    avgPartySize: null,
  };
}

export function computeStats(reservations: ParsedReservation[]): ReservationPreviewStats {
  if (reservations.length === 0) return emptyStats();

  let totalPersons = 0;
  let personsKnown = 0;
  let completedCount = 0;
  let cancelledCount = 0;
  let noshowCount = 0;
  let unknownStatusCount = 0;
  let reservationsWithoutGuestKey = 0;
  let periodFrom: string | null = null;
  let periodTo: string | null = null;

  const statusMap = new Map<string, StatusDistributionEntry>();
  const timeMap = new Map<string, { count: number; persons: number }>();
  const roomMap = new Map<string, number>();
  const areaMap = new Map<string, number>();
  const guestKeys = new Set<string>();

  for (const res of reservations) {
    if (res.partySize !== null) { totalPersons += res.partySize; personsKnown++; }

    switch (res.statusNormalized) {
      case 'completed': completedCount++; break;
      case 'cancelled': cancelledCount++; break;
      case 'noshow':    noshowCount++; break;
      case 'unknown':   unknownStatusCount++; break;
    }

    const statusLabel = res.statusRaw || '(leer)';
    const sd = statusMap.get(statusLabel);
    if (sd) sd.count++;
    else statusMap.set(statusLabel, { status: statusLabel, normalized: res.statusNormalized, count: 1 });

    if (res.reservationTime) {
      const tm = timeMap.get(res.reservationTime) ?? { count: 0, persons: 0 };
      tm.count++;
      tm.persons += res.partySize ?? 0;
      timeMap.set(res.reservationTime, tm);
    }

    if (res.room) roomMap.set(res.room, (roomMap.get(res.room) ?? 0) + 1);
    if (res.area) areaMap.set(res.area, (areaMap.get(res.area) ?? 0) + 1);

    if (res.matchKey) guestKeys.add(res.matchKey);
    else reservationsWithoutGuestKey++;

    if (res.reservationDate) {
      if (!periodFrom || res.reservationDate < periodFrom) periodFrom = res.reservationDate;
      if (!periodTo || res.reservationDate > periodTo) periodTo = res.reservationDate;
    }
  }

  const statusDistribution = [...statusMap.values()].sort((a, b) => b.count - a.count);
  const topTimes: TopTimeEntry[] = [...timeMap.entries()]
    .map(([time, v]) => ({ time, count: v.count, persons: v.persons }))
    .sort((a, b) => b.count - a.count || a.time.localeCompare(b.time))
    .slice(0, 10);
  const rooms = [...roomMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const areas = [...areaMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return {
    reservationCount: reservations.length,
    totalPersons,
    periodFrom,
    periodTo,
    completedCount,
    cancelledCount,
    noshowCount,
    unknownStatusCount,
    statusDistribution,
    topTimes,
    rooms,
    areas,
    distinctGuestKeys: [...guestKeys],
    reservationsWithoutGuestKey,
    avgPartySize: personsKnown > 0 ? totalPersons / personsKnown : null,
  };
}
