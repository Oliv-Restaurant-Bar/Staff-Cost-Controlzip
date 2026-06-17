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
}

export interface GnParsedZBericht {
  fileName: string;
  checksum: string;
  warnings: string[];
  debug: GnParseDebug;

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
  [/^hauptwarengrupp/i,        'Hauptwarengruppen'],
  [/^warengrupp/i,             'Hauptwarengruppen'],
  [/^produktgrupp/i,           'Hauptwarengruppen'],
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
 * Prüft ob eine Zeile eine Sektionsüberschrift ist.
 * Kriterium: erste Zelle matcht einen Sektionsnamen UND
 * keine weitere Zelle enthält einen numerischen Wert (= Datenzeile wäre es).
 * Textspalten (Spaltenköpfe wie "Anzahl", "Betrag") sind erlaubt!
 */
function isSectionHeaderRow(row: string[], canonical: string | null): boolean {
  if (!canonical) return false;
  // Wenn alle anderen Zellen leer oder nur Text sind → Sektionskopf
  const otherCells = row.slice(1).filter(c => c.trim());
  const hasNumericData = otherCells.some(c =>
    /^-?\d[\d'.]*([.,]\d+)?$/.test(c.trim())
  );
  return !hasNumericData;
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

  for (const row of allRows) {
    const rawFirst = (row[0] ?? '').replace(/["""]/g, '').trim();
    const canonical = matchSectionName(rawFirst);

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
      if (k.includes(key.toLowerCase())) {
        const value = (row[1] ?? row[0] ?? '').replace(/["""]/g, '').trim();
        // Zeilennummer im Original
        const lineNumber = allRows.findIndex(r => r === row) + 1;
        return { value, lineNumber: lineNumber > 0 ? lineNumber : null };
      }
    }
  }
  return { value: '', lineNumber: null };
}

/** Tabellen-Sektion parsen: erste Zeile = Header, Rest = Daten */
function parseTableSection(sec: ParsedSection | undefined): { header: string[]; data: string[][] } {
  if (!sec || sec.rows.length === 0) return { header: [], data: [] };
  const [header, ...data] = sec.rows;
  return { header, data: data.filter(r => r.some(c => c.trim())) };
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
    'z counter', 'zähler', 'zaehler', 'z-nr', 'znr'
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
    periodTo   = parseGermanDate(parts[parts.length > 1 ? 1 : 0] ?? '');
  }
  // Fallback: Von / Bis als separate Header
  if (!periodFrom) {
    const vonEntry = getHeaderEntry(headerRows, allRows, 'von', 'beginn', 'start', 'period from');
    const bisEntry = getHeaderEntry(headerRows, allRows, 'bis', 'ende', 'end', 'period to');
    if (vonEntry.value) periodFrom = parseGermanDate(vonEntry.value);
    if (bisEntry.value) periodTo   = parseGermanDate(bisEntry.value);
    if (!periodTo && periodFrom) periodTo = periodFrom; // Tagesbericht
  }

  // ── Debug-Informationen zusammenstellen ────────────────────────────────────
  const foundSections   = sections.map(s => s.name);
  const missingSections = EXPECTED_SECTIONS.filter(n => !foundSections.includes(n));

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
    } else if (rate) {
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
      return { name: r[0].trim(), count: parseInt(r[1] ?? '0', 10) || 0, originalAmount: null, amount: parseSwissNumber(r[2] ?? r[1] ?? '') };
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
