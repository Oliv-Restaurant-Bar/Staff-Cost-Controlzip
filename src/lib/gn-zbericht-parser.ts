/**
 * Gastronovi Z-Bericht CSV Parser
 *
 * Unterstützt Semikolon-, Komma- und Tab-getrennte Exporte.
 * Schweizer Zahlenformat: 1'843.70
 * Robuste Sektion-Erkennung — fehlende Sektionen = Warnungen, kein Fehler.
 * Fuzzy-Matching für Sektionsnamen (Kostenstelle = Kostenstellen, etc.)
 */

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnRevenueSummary {
  totalGross: number;
  totalExclTip: number;
  totalExclRounding: number;
  totalExclCardTopups: number;
}

export interface GnTaxRow {
  taxRate: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

export interface GnNameCountAmount {
  name: string;
  count: number;
  amount: number;
}

export interface GnProductGroup {
  name: string;
  count: number;
  originalAmount: number | null;
  amount: number;
}

export interface GnDiscount {
  type: 'rabatt' | 'positionsrabatt';
  name: string;
  count: number;
  amount: number;
}

export interface GnAccountingLine {
  name: string;
  account: string;
  taxRate: string;
  grossAmount: number;
}

export interface GnPaymentAccount {
  name: string;
  account: string;
  grossAmount: number;
}

// ── Erweiterter Z-Bericht (Detailbericht) ────────────────────────────────────

/** Verzehrart: im Haus / ausser Haus. `null` = nicht angegeben. */
export type GnConsumptionType = 'in_house' | 'takeaway';

/** Eine Zeile aus einer Detailbericht-Sektion des erweiterten Z-Berichts. */
export interface GnExtendedEntry {
  /** Name OHNE «… - Inner Haus» / «… - Außer Haus»-Suffix (nur technisch normalisiert). */
  name: string;
  quantity: number;
  /** Betrag nach Rabatten (Spalte «Betrag»). 0-CHF-Zeilen bleiben erhalten. */
  grossAmount: number;
  /** Original-Betrag vor Rabatt (4. Spalte, falls vorhanden), sonst null. */
  originalAmount: number | null;
  /** Aus dem Namens-Suffix abgeleitet; null wenn kein Suffix vorhanden. */
  consumptionType: GnConsumptionType | null;
}

/** Detaildaten des erweiterten Z-Berichts (Abschnitt «Detailbericht»). */
export interface GnExtendedData {
  /** «Hauptwarengruppen (inner/außer Haus)» */
  mainCategoriesByConsumptionType: GnExtendedEntry[];
  /** «Warengruppen» (ohne Verzehrart-Aufteilung) */
  categories: GnExtendedEntry[];
  /** «Warengruppen (inner/außer Haus)» */
  categoriesByConsumptionType: GnExtendedEntry[];
  /** «Positionen» — einzelne Artikel */
  positions: GnExtendedEntry[];
}

export interface GnParseDebug {
  /** Erkanntes Trennzeichen */
  delimiter: string;
  /** Anzahl Trennzeichen im CSV */
  delimCounts: { semicolon: number; comma: number; tab: number };
  /** Erste 50 Rohzeilen */
  firstRawLines: string[];
  /** Erste 50 geparste Zeilen (Arrays) */
  firstParsedRows: string[][];
  /** Erkannte Header-Zeilen */
  headerRows: string[][];
  /** Kanonische Sektionsnamen die gefunden wurden */
  foundSections: string[];
  /** Sektionen die erwartet werden aber fehlen */
  missingSections: string[];
  /** Rohe Sektionsnamen wie im CSV */
  rawSectionNames: Array<{ raw: string; canonical: string }>;
  /** Roher Zeitraum-Text */
  periodRaw: string;
  /** Roher Z-Zähler-Text */
  zCounterRaw: string;
  /** Rohe Kostenstelle */
  costCenterRaw: string;
  /** Zeilennummer des Zeitraums (1-basiert) */
  periodLine: number | null;
  /** Zeilennummer des Z-Zählers (1-basiert) */
  zCounterLine: number | null;
  /** Mögliche Zeitraum-Treffer: Zeilen mit Zeitraum-Schlüsselwörtern */
  periodCandidates: Array<{ lineNumber: number; rawText: string }>;
  /** Mögliche Z-Zähler-Treffer */
  zCounterCandidates: Array<{ lineNumber: number; rawText: string }>;
  /** Mögliche Treffer je fehlender Sektion */
  sectionCandidates: Record<string, Array<{ lineNumber: number; rawText: string }>>;
}

export interface GnParsedZBericht {
  fileName: string;
  checksum: string;
  warnings: string[];
  debug: GnParseDebug;

  /**
   * Berichtstyp — rein inhaltsbasiert erkannt: 'extended' sobald mindestens
   * eine Detailbericht-Sektion (Warengruppen, Positionen, inner/außer Haus)
   * vorhanden ist, sonst 'standard'.
   */
  reportType: 'standard' | 'extended';
  /** Detaildaten des erweiterten Berichts; null bei Standard-Berichten. */
  extendedData: GnExtendedData | null;

  // Header-Metadaten
  periodFrom: string;    // ISO-Datum yyyy-MM-dd
  periodTo: string;      // ISO-Datum yyyy-MM-dd
  periodRaw: string;     // Originaltext
  zCounter: string;
  costCenter: string;

  // Sektionen
  revenue: GnRevenueSummary;
  taxes: GnTaxRow[];
  taxNetTotal: number;
  costCenters: GnNameCountAmount[];
  waiters: GnNameCountAmount[];
  paymentMethods: GnNameCountAmount[];
  productGroups: GnProductGroup[];
  discounts: GnDiscount[];
  cancellations: GnNameCountAmount[];
  accountingLines: GnAccountingLine[];
  paymentAccounts: GnPaymentAccount[];

  // Abgeleitete KPIs
  netRevenue: number;
  foodAmount: number;
  bevAmount: number;
  barAmount: number;
  kitchenAmount: number;
  takeAwayAmount: number;
  marketingAmount: number;
  maisonAmount: number;
  stornoTotal: number;
  discountTotal: number;
  bonCount: number;
  avgBon: number;
}

// ── Fuzzy-Sektion-Mapping ─────────────────────────────────────────────────────
// Reihenfolge wichtig: "positionsrabatt" vor "rabatt"!

const SECTION_FUZZY: Array<[RegExp, string]> = [
  [/^umsatz$/i,                'Umsatz'],
  [/^steuer/i,                 'Steuerbericht'],
  [/^kostenstell/i,            'Kostenstellen'],   // Kostenstelle / Kostenstellen
  [/^cost.?cent/i,             'Kostenstellen'],   // Cost Center
  [/^kellner$/i,               'Kellner'],
  [/^bedienung$/i,             'Kellner'],
  [/^server$/i,                'Kellner'],
  [/^waiter/i,                 'Kellner'],
  [/^bezahlart/i,              'Bezahlarten'],
  [/^zahlungsart/i,            'Bezahlarten'],
  [/^payment/i,                'Bezahlarten'],
  // Erweiterter Bericht: «… (inner/außer Haus)»-Varianten VOR den Basis-Mustern!
  [/^hauptwarengruppen?\s*\(.*haus/i, 'Hauptwarengruppen (inner/außer Haus)'],
  [/^warengruppen?\s*\(.*haus/i,      'Warengruppen (inner/außer Haus)'],
  [/^hauptwarengrupp/i,        'Hauptwarengruppen'],
  // Hinweis: plain «Warengruppen» wird kontextabhängig remappt (siehe
  // splitIntoSections): existiert im selben Bericht AUCH eine explizite
  // «Hauptwarengruppen»-Sektion, ist «Warengruppen» die Detailbericht-Sektion.
  [/^warengrupp/i,             'Hauptwarengruppen'],
  [/^produktgrupp/i,           'Hauptwarengruppen'],
  [/^positionen$/i,            'Positionen'],
  [/^rundungs/i,               'Rundungsdifferenzen'],
  [/^trinkgeld/i,              'Trinkgeld'],
  [/^kunden auf rech/i,        'Kunden auf Rechnung'],
  [/^aufladung/i,              'Aufladung Kundenkarten'],
  [/^positionsrabatt/i,        'Positionsrabatte'],
  [/^rabatt/i,                 'Rabatte'],
  [/^storniert/i,              'Stornierte Artikel'],
  [/^buchungskont/i,           'Buchungskonten'],
  [/^zahlungskont/i,           'Zahlungskonten'],
];

/** Liefert den kanonischen Sektionsnamen oder null */
function matchSectionName(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  for (const [re, canonical] of SECTION_FUZZY) {
    if (re.test(t)) return canonical;
  }
  return null;
}

/**
 * Bekannte Tabellenkopf-Bezeichnungen (Spaltenüberschriften).
 * Umlaute sind bereits zu ae/oe/ue/ss normalisiert (siehe normalizeHeaderCell).
 */
const COLUMN_HEADER_KEYWORDS = new Set<string>([
  'anzahl', 'betrag', 'name', 'typ', 'art', 'bezeichnung',
  'netto', 'brutto', 'mwst', 'mehrwertsteuer', 'steuer', 'steuersatz', 'satz',
  'umsatz', 'summe', 'total', 'gesamt',
  'konto', 'kontonummer', 'kontonr', 'original',
  'menge', 'preis', 'wert', 'prozent', 'differenz', 'waehrung',
  'chf', 'eur', 'euro',
]);

/** Normalisiert eine Zelle: klein + Umlaute zu ASCII. */
function normalizeHeaderCell(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

/**
 * Prüft, ob eine Zelle eine typische Spaltenüberschrift ist
 * (z. B. "Anzahl", "Betrag", "Netto", "MwSt").
 * Werte mit Ziffern (z. B. "CHF 75'535.90") oder freie Texte
 * (z. B. "Restaurant Oliv") gelten NICHT als Spaltenüberschrift.
 */
function isColumnHeaderCell(cell: string): boolean {
  const trimmed = cell.trim();
  if (!trimmed) return true;                 // leere Zellen sind unkritisch
  if (/\d/.test(trimmed)) return false;      // Werte mit Ziffern → keine Überschrift
  const tokens = normalizeHeaderCell(trimmed).split(/[^a-z]+/).filter(Boolean);
  return tokens.some(t => COLUMN_HEADER_KEYWORDS.has(t));
}

/**
 * Prüft ob eine Zeile eine Sektionsüberschrift ist.
 * Strenge Regel (robust gegen Metadaten-Zeilen wie "Kostenstelle;Restaurant Oliv"):
 *   1. Erste Zelle matcht einen bekannten Sektionsnamen (canonical != null).
 *   2. Jede weitere nicht-leere Zelle ist eine typische Spaltenüberschrift
 *      (Anzahl, Betrag, Name, Typ, Netto, Brutto, MwSt, …).
 * Ein Sektionsname allein auf einer Zeile (keine weiteren Zellen) gilt ebenfalls
 * als Sektionskopf. Eine Zeile wie "Kostenstelle;Restaurant Oliv" wird NICHT
 * als Sektionskopf erkannt, da "Restaurant Oliv" keine Spaltenüberschrift ist.
 */
function isSectionHeaderRow(row: string[], canonical: string | null): boolean {
  if (!canonical) return false;
  const otherCells = row.slice(1).filter(c => c.trim());
  if (otherCells.length === 0) return true;  // Sektionsname allein → Sektionskopf
  return otherCells.every(isColumnHeaderCell);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/** Schweizer Zahl: 1'843.70 → 1843.70 */
export function parseSwissNumber(s: string): number {
  if (!s) return 0;
  const clean = s
    .replace(/["""]/g, '')
    .replace(/'/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

/** Deutsches Datum: 01.06.2026 → 2026-06-01 */
function parseGermanDate(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Einfacher String-Hash (djb2) für Deduplizierung */
export function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Trennzeichen ermitteln: zählt ; , \t */
function detectDelimiter(text: string): { delim: string; counts: { semicolon: number; comma: number; tab: number } } {
  const sample = text.slice(0, 4000);
  const counts = {
    semicolon: (sample.match(/;/g) ?? []).length,
    comma:     (sample.match(/,/g) ?? []).length,
    tab:       (sample.match(/\t/g) ?? []).length,
  };
  let delim = ';';
  if (counts.tab > counts.semicolon && counts.tab > counts.comma) delim = '\t';
  else if (counts.comma > counts.semicolon) delim = ',';
  return { delim, counts };
}

/** CSV-Zeile parsen mit Quote-Unterstützung */
function parseCSVLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

interface ParsedSection { name: string; rawName: string; rows: string[][] }

/** Banner-Zeile des erweiterten Berichts («#####################»). */
const BANNER_ROW_RE = /^#{3,}$/;

function splitIntoSections(allRows: string[][]): {
  headerRows: string[][];
  sections: ParsedSection[];
  rawSectionNames: Array<{ raw: string; canonical: string }>;
} {
  const headerRows: string[][] = [];
  const sections: ParsedSection[] = [];
  const rawSectionNames: Array<{ raw: string; canonical: string }> = [];
  let cur: ParsedSection | null = null;
  let passedFirst = false;

  // Vorab-Pass: Gibt es eine EXPLIZITE «Hauptwarengruppen»-Sektion?
  // Nur dann ist eine plain «Warengruppen»/«Produktgruppen»-Sektion die
  // Detailbericht-Sektion des erweiterten Berichts. In Legacy-Berichten
  // (nur «Warengruppen», keine «Hauptwarengruppen») bleibt das bisherige
  // Mapping auf 'Hauptwarengruppen' unverändert bestehen.
  const hasExplicitHaupt = allRows.some(row => {
    const rawFirst = (row[0] ?? '').replace(/["""]/g, '').trim();
    return /^hauptwarengrupp/i.test(rawFirst)
      && isSectionHeaderRow(row, matchSectionName(rawFirst));
  });

  for (const row of allRows) {
    const rawFirst = (row[0] ?? '').replace(/["""]/g, '').trim();

    // Banner-Zeilen («#####…») trennen Detailbericht/Abrechnung vom Rest:
    // aktuelle Sektion schliessen, damit Bannertitel («Detailbericht»,
    // «Abrechnung») nicht als Datenzeilen in die Vorsektion laufen.
    if (BANNER_ROW_RE.test(rawFirst)) {
      if (cur) { sections.push(cur); cur = null; }
      continue;
    }

    let canonical = matchSectionName(rawFirst);
    // Kontext-Remap: plain «Warengruppen»/«Produktgruppen» neben expliziten
    // «Hauptwarengruppen» = Detailbericht-Sektion 'Warengruppen'.
    if (
      canonical === 'Hauptwarengruppen'
      && hasExplicitHaupt
      && !/^hauptwarengrupp/i.test(rawFirst)
      && /^(?:waren|produkt)grupp/i.test(rawFirst)
    ) {
      canonical = 'Warengruppen';
    }

    if (canonical && isSectionHeaderRow(row, canonical)) {
      passedFirst = true;
      if (cur) sections.push(cur);
      cur = { name: canonical, rawName: rawFirst, rows: [] };
      rawSectionNames.push({ raw: rawFirst, canonical });
    } else if (!passedFirst) {
      if (row.some(c => c.trim())) headerRows.push(row);
    } else if (cur && row.some(c => c.trim())) {
      cur.rows.push(row);
    }
  }
  if (cur) sections.push(cur);
  return { headerRows, sections, rawSectionNames };
}

function getSection(sections: ParsedSection[], name: string): ParsedSection | undefined {
  return sections.find(s => s.name.toLowerCase() === name.toLowerCase());
}

/**
 * Sucht einen Wert in den Header-Zeilen per Fuzzy-Key-Match.
 * Gibt Zeilennummer (1-basiert) zurück.
 */
function getHeaderEntry(
  headerRows: string[][],
  allRows: string[][],
  ...keys: string[]
): { value: string; lineNumber: number | null } {
  for (let i = 0; i < headerRows.length; i++) {
    const row = headerRows[i];
    const k = (row[0] ?? '').replace(/["""]/g, '').toLowerCase().replace(/:$/, '').trim();
    for (const key of keys) {
      const kl = key.toLowerCase();
      // Sehr kurze Keys (z. B. "z" für den Z-Zähler im Tab-Format) NUR exakt
      // matchen — includes() würde sonst jedes Label mit diesem Buchstaben treffen.
      const matches = kl.length <= 2 ? k === kl : k.includes(kl);
      if (matches) {
        const value = (row[1] ?? row[0] ?? '').replace(/["""]/g, '').trim();
        // Zeilennummer im Original
        const lineNumber = allRows.findIndex(r => r === row) + 1;
        return { value, lineNumber: lineNumber > 0 ? lineNumber : null };
      }
    }
  }
  return { value: '', lineNumber: null };
}

/**
 * Tabellen-Sektion parsen: erste Zeile = Header, Rest = Daten.
 * Trennzeilen («---------------------», im Tab-Format am Sektionsende vor dem
 * nächsten Sektionskopf) sind NIE Daten und werden herausgefiltert — die erste
 * Trennzeile direkt nach dem Sektionskopf dient weiterhin als Opfer-Header.
 */
function parseTableSection(sec: ParsedSection | undefined): { header: string[]; data: string[][] } {
  if (!sec || sec.rows.length === 0) return { header: [], data: [] };
  const [header, ...data] = sec.rows;
  return {
    header,
    data: data.filter(r => r.some(c => c.trim()) && !/^-{3,}$/.test((r[0] ?? '').trim())),
  };
}

// ── Erweiterter Bericht: Detailsektionen ─────────────────────────────────────

/**
 * Rein TECHNISCHE Namens-Normalisierung: Whitespace kollabieren + trimmen.
 * Keine fachliche Vereinheitlichung — «Pizza Prosciutto» und
 * «Pizza Prosciutto TA» bleiben getrennte Namen.
 */
function normalizeItemName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Verzehrart-Suffix «… - Inner Haus» / «… - Außer Haus» abtrennen.
 * WICHTIG: Nur das LETZTE Suffix strippen — Namen wie «Wein - Rose - Inner Haus»
 * enthalten selbst « - » und müssen zu «Wein - Rose» werden.
 */
const CT_SUFFIX_RE = /\s+[-–—]\s+(inner|außer|ausser)\s+haus\s*$/i;

function splitConsumptionSuffix(name: string): { base: string; ct: GnConsumptionType | null } {
  const m = name.match(CT_SUFFIX_RE);
  if (!m || m.index === undefined) return { base: name, ct: null };
  const ct: GnConsumptionType = /^inner$/i.test(m[1]) ? 'in_house' : 'takeaway';
  const base = name.slice(0, m.index).trim();
  // Leerer Basisname wäre Datenverlust — dann Suffix NICHT strippen.
  if (!base) return { base: name, ct: null };
  return { base, ct };
}

/**
 * Detailbericht-Sektion parsen (Warengruppen, Positionen, inner/außer Haus).
 * Behält 0-CHF-Zeilen (z. B. Garstufen, «ohne») — fachliche Vorgabe.
 * Überspringt Trennzeilen («-----»), «Total»-Summenzeilen und Kopfzeilen.
 */
function parseExtendedSection(
  sec: ParsedSection | undefined,
  opts: { splitCt: boolean },
): GnExtendedEntry[] {
  if (!sec) return [];
  const out: GnExtendedEntry[] = [];
  for (const row of sec.rows) {
    const first = (row[0] ?? '').trim();
    if (!first) continue;
    if (/^-{3,}$/.test(first)) continue;      // Trennzeile
    if (/^total$/i.test(first)) continue;     // Summenzeile
    // Defensive Kopfzeilen-Erkennung («Name  Anzahl  Betrag»): keine Ziffern
    // in den Wertspalten UND alle weiteren Zellen sind Spaltenüberschriften.
    const rest = row.slice(1).filter(c => c.trim());
    if (rest.length > 0 && !rest.some(c => /\d/.test(c)) && rest.every(isColumnHeaderCell)) continue;

    const rawName = normalizeItemName(first);
    const { base, ct } = opts.splitCt
      ? splitConsumptionSuffix(rawName)
      : { base: rawName, ct: null };

    const quantity    = parseInt(row[1] ?? '0', 10) || 0;
    const grossAmount = parseSwissNumber(row[2] ?? '');
    const origRaw     = (row[3] ?? '').trim();
    const originalAmount = origRaw ? parseSwissNumber(origRaw) : null;

    out.push({ name: base, quantity, grossAmount, originalAmount, consumptionType: ct });
  }
  return out;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

const EXPECTED_SECTIONS = [
  'Umsatz', 'Steuerbericht', 'Kostenstellen', 'Kellner',
  'Bezahlarten', 'Hauptwarengruppen', 'Rabatte', 'Stornierte Artikel',
];

export function parseGnZBericht(csvText: string, fileName: string): GnParsedZBericht {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);

  // ── Delimiter erkennen ──────────────────────────────────────────────────────
  const { delim, counts: delimCounts } = detectDelimiter(csvText);

  // ── CSV in Zeilen aufteilen ─────────────────────────────────────────────────
  const rawLines = csvText.split(/\r?\n/);
  const allRows  = rawLines.map(l => parseCSVLine(l, delim));

  // ── Sektionen erkennen ─────────────────────────────────────────────────────
  const { headerRows, sections, rawSectionNames } = splitIntoSections(allRows);

  // ── Header-Metadaten ────────────────────────────────────────────────────────
  const periodEntry = getHeaderEntry(
    headerRows, allRows,
    'zeitraum', 'berichtszeitraum', 'period', 'datum', 'von', 'datumsbereich'
  );
  const zEntry = getHeaderEntry(
    headerRows, allRows,
    'z-zähler', 'z-zaehler', 'z zähler', 'z-nummer', 'z nummer',
    'z counter', 'zähler', 'zaehler', 'z-nr', 'znr', 'z'
  );
  const ccEntry = getHeaderEntry(
    headerRows, allRows,
    'kostenstelle', 'filiale', 'restaurant', 'standort', 'betrieb'
  );

  const periodRaw    = periodEntry.value;
  const zCounterRaw  = zEntry.value;
  const costCenter   = ccEntry.value;

  // Perioden-Datum parsen: "01.06.2026 - 17.06.2026" oder "01.06.2026 00:00 - 17.06.2026 23:59"
  let periodFrom = '';
  let periodTo   = '';
  if (periodRaw) {
    const parts = periodRaw.split(/\s*[-–]\s*/);
    periodFrom = parseGermanDate(parts[0] ?? '');
    // Nur eine echte Bereichszeile ("von - bis") liefert auch das Enddatum.
    // Eine einzelne "Von"-Zeile liefert NUR das Startdatum — periodTo kommt
    // dann aus der separaten "Bis"-Zeile (Fallback unten). Sonst würde das
    // Startdatum fälschlich auch als Enddatum übernommen.
    if (parts.length > 1) {
      periodTo = parseGermanDate(parts[parts.length - 1] ?? '');
    }
  }
  // Fallback: Von / Bis als separate Header
  if (!periodFrom) {
    const vonEntry = getHeaderEntry(headerRows, allRows, 'von', 'beginn', 'start', 'period from');
    const bisEntry = getHeaderEntry(headerRows, allRows, 'bis', 'ende', 'end', 'period to');
    if (vonEntry.value) periodFrom = parseGermanDate(vonEntry.value);
    if (bisEntry.value) periodTo   = parseGermanDate(bisEntry.value);
    if (!periodTo && periodFrom) periodTo = periodFrom; // Tagesbericht
  }

  // Fix: Von-Zeile gefunden aber Bis-Zeile noch nicht gematcht
  if (periodFrom && !periodTo) {
    const bisOnly = getHeaderEntry(headerRows, allRows, 'bis', 'ende', 'end', 'period to');
    if (bisOnly.value) periodTo = parseGermanDate(bisOnly.value);
    if (!periodTo) periodTo = periodFrom;
  }

  // ── Kandidaten-Scanning (für Diagnose) ─────────────────────────────────────
  const PERIOD_SCAN_RE = /zeitraum|berichtszeitraum|periode|period\s*from|datumsbereich/i;
  const VON_BIS_RE     = /^(von|bis|datum|beginn|ende)\s*[;,\t:]/i;
  const periodCandidates: Array<{ lineNumber: number; rawText: string }> = [];
  if (!periodFrom || !periodTo) {
    rawLines.forEach((line, idx) => {
      if (!line.trim()) return;
      if (PERIOD_SCAN_RE.test(line) || VON_BIS_RE.test(line)) {
        periodCandidates.push({ lineNumber: idx + 1, rawText: line });
      }
    });
  }

  const ZCOUNTER_SCAN_RE = /z[-\s]?z[äa]hler|z[-\s]?zaehler|z[-\s]?counter|z[-\s]?nummer|z[-\s]?nr\b|abschluss[-\s]?nr|^bericht[-\s]?nr/i;
  const zCounterCandidates: Array<{ lineNumber: number; rawText: string }> = [];
  if (!zCounterRaw) {
    rawLines.forEach((line, idx) => {
      if (!line.trim()) return;
      if (ZCOUNTER_SCAN_RE.test(line)) {
        zCounterCandidates.push({ lineNumber: idx + 1, rawText: line });
      }
    });
  }

  // ── foundSections / missingSections zuerst berechnen (werden im Scan unten gebraucht) ──
  const foundSections   = sections.map(s => s.name);
  const missingSections = EXPECTED_SECTIONS.filter(n => !foundSections.includes(n));

  const SECTION_SCAN: Record<string, RegExp> = {
    'Steuerbericht':       /steuer|tax\b|mwst|mehrwertsteuer/i,
    'Kostenstellen':       /kostenstell|cost.?cent/i,
    'Kellner':             /kellner|bedienung|server\b|waiter/i,
    'Bezahlarten':         /bezahl|zahlungs?art|payment.?method/i,
    'Hauptwarengruppen':   /waren.?grupp|produkt.?grupp|hauptgrupp|article.?group/i,
    'Rabatte':             /\brabatt\b|discount/i,
    'Positionsrabatte':    /positions?rabatt/i,
    'Stornierte Artikel':  /storni|storniert|cancel/i,
    'Buchungskonten':      /buchungs?kont/i,
    'Zahlungskonten':      /zahlungs?kont/i,
  };
  const sectionCandidates: Record<string, Array<{ lineNumber: number; rawText: string }>> = {};
  for (const sec of missingSections) {
    const kw = SECTION_SCAN[sec];
    if (!kw) continue;
    const cands: Array<{ lineNumber: number; rawText: string }> = [];
    rawLines.forEach((line, idx) => {
      if (!line.trim()) return;
      if (kw.test(line)) cands.push({ lineNumber: idx + 1, rawText: line });
    });
    if (cands.length > 0) sectionCandidates[sec] = cands;
  }

  // ── Debug-Informationen zusammenstellen ────────────────────────────────────

  const debug: GnParseDebug = {
    delimiter:     delim === '\t' ? 'Tab' : delim === ';' ? 'Semikolon' : 'Komma',
    delimCounts,
    firstRawLines: rawLines.slice(0, 50),
    firstParsedRows: allRows.slice(0, 50),
    headerRows,
    foundSections,
    missingSections,
    rawSectionNames,
    periodRaw,
    zCounterRaw,
    costCenterRaw: costCenter,
    periodLine:    periodEntry.lineNumber,
    zCounterLine:  zEntry.lineNumber,
    periodCandidates,
    zCounterCandidates,
    sectionCandidates,
  };

  // ── Console-Debug-Ausgabe ───────────────────────────────────────────────────
  console.group(`[GN-PARSER] ${fileName}`);
  console.log(`Trennzeichen: "${debug.delimiter}" — ;=${delimCounts.semicolon} ,=${delimCounts.comma} \\t=${delimCounts.tab}`);
  console.log(`Gesamt Zeilen: ${rawLines.length}, gültige Header-Zeilen: ${headerRows.length}`);
  console.log('Header-Zeilen:', headerRows.map(r => r.join(' | ')));
  console.log(`Zeitraum (Zeile ${debug.periodLine ?? '?'}): "${periodRaw}" → ${periodFrom} – ${periodTo}`);
  console.log(`Z-Zähler (Zeile ${debug.zCounterLine ?? '?'}): "${zCounterRaw}"`);
  console.log(`Kostenstelle: "${costCenter}"`);
  console.log('Gefundene Sektionen:', foundSections.join(', ') || '(keine)');
  console.log('Rohe Sektionsnamen:', rawSectionNames.map(x => `"${x.raw}" → ${x.canonical}`).join(', '));
  if (missingSections.length) console.warn('Fehlende Sektionen:', missingSections.join(', '));
  console.log('Erste 20 geparste Zeilen:');
  allRows.slice(0, 20).forEach((r, i) =>
    console.log(`  Z${String(i + 1).padStart(3)}: [${r.map(c => `"${c}"`).join(', ')}]`)
  );
  console.groupEnd();

  // ── Warnungen ──────────────────────────────────────────────────────────────
  if (!periodFrom || !periodTo) warnings.push('Zeitraum konnte nicht erkannt werden.');
  if (!zCounterRaw)             warnings.push('Z-Zähler nicht gefunden.');
  if (!costCenter)              warnings.push('Kostenstelle nicht gefunden.');

  // ── Umsatz ─────────────────────────────────────────────────────────────────
  const revSec = getSection(sections, 'Umsatz');
  let revenue: GnRevenueSummary = { totalGross: 0, totalExclTip: 0, totalExclRounding: 0, totalExclCardTopups: 0 };
  if (revSec) {
    for (const row of revSec.rows) {
      const label = (row[0] ?? '').toLowerCase();
      const val   = parseSwissNumber(row[1] ?? '');
      if (label.includes('gesamtumsatz inkl') || label.includes('total inkl')) {
        revenue.totalGross = val;
      } else if (label.includes('exkl. trinkgeld') || label.includes('exkl trinkgeld')) {
        revenue.totalExclTip = val;
      } else if (label.includes('exkl. rundungs') || label.includes('exkl rundungs')) {
        revenue.totalExclRounding = val;
      } else if (label.includes('kundenkarten') || label.includes('card')) {
        revenue.totalExclCardTopups = val;
      }
    }
    if (revenue.totalGross === 0) {
      const vals = revSec.rows.map(r => parseSwissNumber(r[1] ?? '')).filter(v => v > 0);
      if (vals.length > 0) revenue.totalGross = Math.max(...vals);
    }
  } else {
    warnings.push('Sektion "Umsatz" nicht gefunden.');
  }

  // ── Steuerbericht ──────────────────────────────────────────────────────────
  const taxTable = parseTableSection(getSection(sections, 'Steuerbericht'));
  const taxes: GnTaxRow[] = [];
  let taxNetTotal = 0;
  for (const row of taxTable.data) {
    const rate = (row[0] ?? '').trim();
    if (/^total/i.test(rate)) {
      taxNetTotal = parseSwissNumber(row[1] ?? '');
    } else if (rate && row.slice(1).some(c => /\d/.test(c))) {
      // Kopfzeilen wie "%|Netto|Steuer|Brutto" (Tab-Format) haben keine
      // Ziffern in den Wertspalten und sind keine Steuerzeilen.
      taxes.push({
        taxRate:     rate,
        netAmount:   parseSwissNumber(row[1] ?? ''),
        taxAmount:   parseSwissNumber(row[2] ?? ''),
        grossAmount: parseSwissNumber(row[3] ?? ''),
      });
    }
  }
  if (taxes.length === 0) warnings.push('Sektion "Steuerbericht" nicht gefunden oder leer.');
  if (taxNetTotal === 0 && taxes.length > 0) {
    taxNetTotal = taxes.reduce((s, t) => s + t.netAmount, 0);
  }

  // ── Kostenstellen ──────────────────────────────────────────────────────────
  const ccTable = parseTableSection(getSection(sections, 'Kostenstellen'));
  const costCenters: GnNameCountAmount[] = ccTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] ?? '0', 10) || 0,
      amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
    }));
  if (costCenters.length === 0) warnings.push('Sektion "Kostenstellen" nicht gefunden oder leer.');

  // ── Kellner ────────────────────────────────────────────────────────────────
  const waiterTable = parseTableSection(getSection(sections, 'Kellner'));
  const waiters: GnNameCountAmount[] = waiterTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] ?? '0', 10) || 0,
      amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
    }));

  // ── Bezahlarten ───────────────────────────────────────────────────────────
  const pmTable = parseTableSection(getSection(sections, 'Bezahlarten'));
  const paymentMethods: GnNameCountAmount[] = pmTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] ?? '0', 10) || 0,
      amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
    }));

  // ── Hauptwarengruppen ──────────────────────────────────────────────────────
  const pgTable = parseTableSection(getSection(sections, 'Hauptwarengruppen'));
  const hasOrigCol = pgTable.header.some(h => h.toLowerCase().includes('original'));
  const productGroups: GnProductGroup[] = pgTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => {
      if (hasOrigCol) {
        return { name: r[0].trim(), count: parseInt(r[1] ?? '0', 10) || 0, originalAmount: parseSwissNumber(r[2] ?? ''), amount: parseSwissNumber(r[3] ?? r[2] ?? '') };
      }
      // Tab-Format ohne Kopfzeile: 4. Spalte = Original-Betrag vor Rabatt
      // (z. B. "Beverage (Getränke)"  439  3338.8  3404.9).
      const origRaw = (r[3] ?? '').trim();
      return {
        name: r[0].trim(),
        count: parseInt(r[1] ?? '0', 10) || 0,
        originalAmount: origRaw ? parseSwissNumber(origRaw) : null,
        amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
      };
    });

  // ── Rabatte ────────────────────────────────────────────────────────────────
  const discountTable    = parseTableSection(getSection(sections, 'Rabatte'));
  const posDiscountTable = parseTableSection(getSection(sections, 'Positionsrabatte'));
  const discounts: GnDiscount[] = [
    ...discountTable.data
      .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
      .map(r => ({
        type: 'rabatt' as const,
        name: r[0].trim(), count: parseInt(r[1] ?? '0', 10) || 0, amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
      })),
    ...posDiscountTable.data
      .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
      .map(r => ({
        type: 'positionsrabatt' as const,
        name: r[0].trim(), count: parseInt(r[1] ?? '0', 10) || 0, amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
      })),
  ];

  // ── Stornierte Artikel ─────────────────────────────────────────────────────
  const cancelTable = parseTableSection(getSection(sections, 'Stornierte Artikel'));
  const cancellations: GnNameCountAmount[] = cancelTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(), count: parseInt(r[1] ?? '0', 10) || 0, amount: parseSwissNumber(r[2] ?? r[1] ?? ''),
    }));

  // ── Buchungskonten ─────────────────────────────────────────────────────────
  const acctTable = parseTableSection(getSection(sections, 'Buchungskonten'));
  const accountingLines: GnAccountingLine[] = acctTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(), account: r[1]?.trim() ?? '',
      taxRate: r[2]?.trim() ?? '', grossAmount: parseSwissNumber(r[3] ?? r[2] ?? r[1] ?? ''),
    }));

  // ── Zahlungskonten ─────────────────────────────────────────────────────────
  const payAcctTable = parseTableSection(getSection(sections, 'Zahlungskonten'));
  const paymentAccounts: GnPaymentAccount[] = payAcctTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(), account: r[1]?.trim() ?? '',
      grossAmount: parseSwissNumber(r[2] ?? r[1] ?? ''),
    }));

  // ── Erweiterter Bericht (Detailbericht-Sektionen) ─────────────────────────
  const mainCtSec = getSection(sections, 'Hauptwarengruppen (inner/außer Haus)');
  const catSec    = getSection(sections, 'Warengruppen');
  const catCtSec  = getSection(sections, 'Warengruppen (inner/außer Haus)');
  const posSec    = getSection(sections, 'Positionen');

  const isExtended = !!(mainCtSec || catSec || catCtSec || posSec);
  const extendedData: GnExtendedData | null = isExtended
    ? {
        mainCategoriesByConsumptionType: parseExtendedSection(mainCtSec, { splitCt: true }),
        categories:                      parseExtendedSection(catSec,    { splitCt: false }),
        categoriesByConsumptionType:     parseExtendedSection(catCtSec,  { splitCt: true }),
        positions:                       parseExtendedSection(posSec,    { splitCt: false }),
      }
    : null;

  if (isExtended) {
    const missingExt: string[] = [];
    if (!mainCtSec) missingExt.push('Hauptwarengruppen (inner/außer Haus)');
    if (!catSec)    missingExt.push('Warengruppen');
    if (!catCtSec)  missingExt.push('Warengruppen (inner/außer Haus)');
    if (!posSec)    missingExt.push('Positionen');
    if (missingExt.length > 0) {
      warnings.push(`Erweiterter Bericht erkannt, aber Detailsektionen fehlen: ${missingExt.join(', ')}.`);
    }
    if (posSec && extendedData && extendedData.positions.length === 0) {
      warnings.push('Erweiterter Bericht: Sektion "Positionen" ist leer.');
    }
  }

  // ── Abgeleitete KPIs ──────────────────────────────────────────────────────
  const netRevenue    = taxNetTotal > 0 ? taxNetTotal : revenue.totalGross / 1.077;
  const foodAmount    = productGroups.filter(p => /speis|food|küche|küchen|kueche|essen/i.test(p.name)).reduce((s, p) => s + p.amount, 0);
  const bevAmount     = productGroups.filter(p => /geträn|bev|drink|bar|wein|spirit|alk/i.test(p.name)).reduce((s, p) => s + p.amount, 0);
  const barAmount     = costCenters.filter(c => /^bar$/i.test(c.name.trim()) || /bar umsatz/i.test(c.name)).reduce((s, c) => s + c.amount, 0);
  const kitchenAmount = costCenters.filter(c => /küche|kueche|kitchen/i.test(c.name)).reduce((s, c) => s + c.amount, 0);
  const takeAwayAmount = [
    ...waiters.filter(w => /take.?away|takeaway|abholung/i.test(w.name)),
    ...costCenters.filter(c => /take.?away|takeaway/i.test(c.name)),
  ].reduce((s, x) => s + x.amount, 0);
  const marketingAmount = Math.abs(discounts.filter(d => /marketing/i.test(d.name)).reduce((s, d) => s + d.amount, 0));
  const maisonAmount    = Math.abs(discounts.filter(d => /maison/i.test(d.name)).reduce((s, d) => s + d.amount, 0))
    + accountingLines.filter(a => /maison/i.test(a.name)).reduce((s, a) => s + a.grossAmount, 0);
  const stornoTotal    = Math.abs(cancellations.reduce((s, c) => s + c.amount, 0));
  const discountTotal  = Math.abs(discounts.reduce((s, d) => s + d.amount, 0));
  const bonCount       = waiters.reduce((s, w) => s + w.count, 0) || costCenters.reduce((s, c) => s + c.count, 0);
  const avgBon         = bonCount > 0 && revenue.totalGross > 0 ? revenue.totalGross / bonCount : 0;

  return {
    fileName, checksum, warnings, debug,
    reportType: isExtended ? 'extended' : 'standard',
    extendedData,
    periodRaw, periodFrom, periodTo,
    zCounter: zCounterRaw, costCenter,
    revenue, taxes, taxNetTotal,
    costCenters, waiters, paymentMethods, productGroups,
    discounts, cancellations, accountingLines, paymentAccounts,
    netRevenue, foodAmount, bevAmount, barAmount, kitchenAmount,
    takeAwayAmount, marketingAmount, maisonAmount,
    stornoTotal, discountTotal, bonCount, avgBon,
  };
}
