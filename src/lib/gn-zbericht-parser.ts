/**
 * Gastronovi Z-Bericht CSV Parser
 *
 * Unterstützt Semikolon- und Komma-getrennte Exporte.
 * Schweizer Zahlenformat: 1'843.70
 * Robuste Sektion-Erkennung — fehlende Sektionen = Warnungen, kein Fehler.
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

export interface GnParsedZBericht {
  fileName: string;
  checksum: string;
  warnings: string[];

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
  netRevenue: number;        // aus Steuerbericht Total Netto
  foodAmount: number;        // aus Hauptwarengruppen
  bevAmount: number;         // aus Hauptwarengruppen
  barAmount: number;         // aus Kostenstellen "Bar"
  kitchenAmount: number;     // aus Kostenstellen "Küche" / Küchen
  takeAwayAmount: number;    // aus Kellner "Take Away" / Kostenstelle "Take Away"
  marketingAmount: number;   // aus Rabatte
  maisonAmount: number;      // aus Rabatte/Buchungskonten
  stornoTotal: number;       // aus Stornierte Artikel
  discountTotal: number;     // Rabatte gesamt
  bonCount: number;          // Anzahl Bons (aus Kellner oder Kostenstellen)
  avgBon: number;            // Umsatz / Anzahl Bons
}

// ── Bekannte Sektionsnamen ────────────────────────────────────────────────────

const SECTION_NAMES = [
  'Umsatz',
  'Steuerbericht',
  'Kostenstellen',
  'Kellner',
  'Bezahlarten',
  'Hauptwarengruppen',
  'Rundungsdifferenzen',
  'Trinkgeld',
  'Kunden auf Rechnung',
  'Aufladung Kundenkarten',
  'Rabatte',
  'Positionsrabatte',
  'Stornierte Artikel',
  'Buchungskonten',
  'Zahlungskonten',
];

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

/** Schweizer Zahl: 1'843.70 → 1843.70 */
export function parseSwissNumber(s: string): number {
  if (!s) return 0;
  const clean = s
    .replace(/["""]/g, '')
    .replace(/'/g, '')         // Tausendertrennzeichen
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

interface ParsedSection { name: string; rows: string[][] }

function splitIntoSections(allRows: string[][]): {
  headerRows: string[][];
  sections: ParsedSection[];
} {
  const namesLower = SECTION_NAMES.map(n => n.toLowerCase());
  const headerRows: string[][] = [];
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;
  let passedFirst = false;

  for (const row of allRows) {
    const first = (row[0] || '').replace(/["""]/g, '').trim();
    const firstLow = first.toLowerCase();
    const secondEmpty = !row[1] || !row[1].trim();
    const isSectionHdr = namesLower.includes(firstLow) && secondEmpty;

    if (isSectionHdr) {
      passedFirst = true;
      if (cur) sections.push(cur);
      cur = { name: SECTION_NAMES[namesLower.indexOf(firstLow)], rows: [] };
    } else if (!passedFirst) {
      if (row.some(c => c.trim())) headerRows.push(row);
    } else if (cur && row.some(c => c.trim())) {
      cur.rows.push(row);
    }
  }
  if (cur) sections.push(cur);
  return { headerRows, sections };
}

function getSection(sections: ParsedSection[], name: string): ParsedSection | undefined {
  return sections.find(s => s.name.toLowerCase() === name.toLowerCase());
}

/** Ersten Datenwert einer Header-Sektion holen (z.B. Zeitraum: → "01.06.–17.06.") */
function getHeaderValue(headerRows: string[][], ...keys: string[]): string {
  for (const row of headerRows) {
    const k = (row[0] || '').replace(/["""]/g, '').toLowerCase().replace(/:$/, '').trim();
    for (const key of keys) {
      if (k.includes(key.toLowerCase())) {
        return (row[1] || row[0] || '').replace(/["""]/g, '').trim();
      }
    }
  }
  return '';
}

/** Tabellen-Sektion parsen: erste Zeile = Header, Rest = Daten */
function parseTableSection(sec: ParsedSection | undefined): { header: string[]; data: string[][] } {
  if (!sec || sec.rows.length === 0) return { header: [], data: [] };
  const [header, ...data] = sec.rows;
  return { header, data: data.filter(r => r.some(c => c.trim())) };
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnZBericht(csvText: string, fileName: string): GnParsedZBericht {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);

  // Delimiter erkennen
  const delim = csvText.includes(';') ? ';' : ',';

  // CSV in Zeilen aufteilen
  const allRows = csvText
    .split(/\r?\n/)
    .map(l => parseCSVLine(l, delim));

  const { headerRows, sections } = splitIntoSections(allRows);

  // ── Header-Metadaten ────────────────────────────────────────────────────────
  const periodRaw = getHeaderValue(headerRows, 'zeitraum', 'period', 'datum');
  const zCounterRaw = getHeaderValue(headerRows, 'z-zähler', 'z-zaehler', 'z zähler', 'counter');
  const costCenter = getHeaderValue(headerRows, 'kostenstelle', 'filiale', 'restaurant');

  // Perioden-Datum parsen: "01.06.2026 - 17.06.2026" oder "01.06.2026 00:00 - 17.06.2026 23:59"
  let periodFrom = '';
  let periodTo = '';
  if (periodRaw) {
    const parts = periodRaw.split(/\s*[-–]\s*/);
    periodFrom = parseGermanDate(parts[0] || '');
    periodTo   = parseGermanDate(parts[parts.length > 1 ? 1 : 0] || '');
  }

  if (!periodFrom || !periodTo) warnings.push('Zeitraum konnte nicht erkannt werden.');
  if (!zCounterRaw)            warnings.push('Z-Zähler nicht gefunden.');
  if (!costCenter)             warnings.push('Kostenstelle nicht gefunden.');

  // ── Umsatz ──────────────────────────────────────────────────────────────────
  const revSec = getSection(sections, 'Umsatz');
  let revenue: GnRevenueSummary = { totalGross: 0, totalExclTip: 0, totalExclRounding: 0, totalExclCardTopups: 0 };
  if (revSec) {
    for (const row of revSec.rows) {
      const label = (row[0] || '').toLowerCase();
      const val   = parseSwissNumber(row[1] || '');
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
    // Fallback: nimm grössten Wert als Bruttoumsatz
    if (revenue.totalGross === 0) {
      const vals = revSec.rows.map(r => parseSwissNumber(r[1] || '')).filter(v => v > 0);
      if (vals.length > 0) revenue.totalGross = Math.max(...vals);
    }
  } else {
    warnings.push('Sektion "Umsatz" nicht gefunden.');
  }

  // ── Steuerbericht ───────────────────────────────────────────────────────────
  const taxTable = parseTableSection(getSection(sections, 'Steuerbericht'));
  const taxes: GnTaxRow[] = [];
  let taxNetTotal = 0;
  for (const row of taxTable.data) {
    const rate = (row[0] || '').trim();
    if (rate.toLowerCase() === 'total') {
      taxNetTotal = parseSwissNumber(row[1] || '');
    } else if (rate) {
      taxes.push({
        taxRate: rate,
        netAmount: parseSwissNumber(row[1] || ''),
        taxAmount: parseSwissNumber(row[2] || ''),
        grossAmount: parseSwissNumber(row[3] || ''),
      });
    }
  }
  if (taxes.length === 0) warnings.push('Sektion "Steuerbericht" nicht gefunden oder leer.');
  // Netto aus Summe aller Steuerzeilen
  if (taxNetTotal === 0 && taxes.length > 0) {
    taxNetTotal = taxes.reduce((s, t) => s + t.netAmount, 0);
  }

  // ── Kostenstellen ───────────────────────────────────────────────────────────
  const ccTable = parseTableSection(getSection(sections, 'Kostenstellen'));
  const costCenters: GnNameCountAmount[] = ccTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] || '0', 10) || 0,
      amount: parseSwissNumber(r[2] || r[1] || ''),
    }));
  if (costCenters.length === 0) warnings.push('Sektion "Kostenstellen" nicht gefunden oder leer.');

  // ── Kellner ─────────────────────────────────────────────────────────────────
  const waiterTable = parseTableSection(getSection(sections, 'Kellner'));
  const waiters: GnNameCountAmount[] = waiterTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] || '0', 10) || 0,
      amount: parseSwissNumber(r[2] || r[1] || ''),
    }));

  // ── Bezahlarten ─────────────────────────────────────────────────────────────
  const pmTable = parseTableSection(getSection(sections, 'Bezahlarten'));
  const paymentMethods: GnNameCountAmount[] = pmTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name:   r[0].trim(),
      count:  parseInt(r[1] || '0', 10) || 0,
      amount: parseSwissNumber(r[2] || r[1] || ''),
    }));

  // ── Hauptwarengruppen ───────────────────────────────────────────────────────
  const pgTable = parseTableSection(getSection(sections, 'Hauptwarengruppen'));
  // Spalten: Name; Anzahl; [Originalpreis;] Preis
  const hasOrigCol = pgTable.header.some(h => h.toLowerCase().includes('original'));
  const productGroups: GnProductGroup[] = pgTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => {
      if (hasOrigCol) {
        return {
          name: r[0].trim(),
          count: parseInt(r[1] || '0', 10) || 0,
          originalAmount: parseSwissNumber(r[2] || ''),
          amount: parseSwissNumber(r[3] || r[2] || ''),
        };
      }
      return {
        name: r[0].trim(),
        count: parseInt(r[1] || '0', 10) || 0,
        originalAmount: null,
        amount: parseSwissNumber(r[2] || r[1] || ''),
      };
    });

  // ── Rabatte ─────────────────────────────────────────────────────────────────
  const discountTable    = parseTableSection(getSection(sections, 'Rabatte'));
  const posDiscountTable = parseTableSection(getSection(sections, 'Positionsrabatte'));
  const discounts: GnDiscount[] = [
    ...discountTable.data
      .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
      .map(r => ({
        type: 'rabatt' as const,
        name: r[0].trim(),
        count: parseInt(r[1] || '0', 10) || 0,
        amount: parseSwissNumber(r[2] || r[1] || ''),
      })),
    ...posDiscountTable.data
      .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
      .map(r => ({
        type: 'positionsrabatt' as const,
        name: r[0].trim(),
        count: parseInt(r[1] || '0', 10) || 0,
        amount: parseSwissNumber(r[2] || r[1] || ''),
      })),
  ];

  // ── Stornierte Artikel ───────────────────────────────────────────────────────
  const cancelTable = parseTableSection(getSection(sections, 'Stornierte Artikel'));
  const cancellations: GnNameCountAmount[] = cancelTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(),
      count: parseInt(r[1] || '0', 10) || 0,
      amount: parseSwissNumber(r[2] || r[1] || ''),
    }));

  // ── Buchungskonten ───────────────────────────────────────────────────────────
  const acctTable = parseTableSection(getSection(sections, 'Buchungskonten'));
  // Spalten: Name; Konto; Steuersatz; Bruttobetrag
  const accountingLines: GnAccountingLine[] = acctTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(),
      account: r[1]?.trim() || '',
      taxRate: r[2]?.trim() || '',
      grossAmount: parseSwissNumber(r[3] || r[2] || r[1] || ''),
    }));

  // ── Zahlungskonten ───────────────────────────────────────────────────────────
  const payAcctTable = parseTableSection(getSection(sections, 'Zahlungskonten'));
  // Spalten: Name; Konto; Bruttobetrag
  const paymentAccounts: GnPaymentAccount[] = payAcctTable.data
    .filter(r => r[0]?.trim() && !/^total/i.test(r[0]))
    .map(r => ({
      name: r[0].trim(),
      account: r[1]?.trim() || '',
      grossAmount: parseSwissNumber(r[2] || r[1] || ''),
    }));

  // ── Abgeleitete KPIs ─────────────────────────────────────────────────────────

  // Netto-Umsatz: bevorzuge Steuerbericht Total, dann schätze aus Brutto
  const netRevenue = taxNetTotal > 0 ? taxNetTotal : revenue.totalGross / 1.077;

  // Food: Hauptwarengruppen mit Speise/Food
  const foodAmount = productGroups
    .filter(p => /speis|food|küche|küchen|kueche|essen/i.test(p.name))
    .reduce((s, p) => s + p.amount, 0);

  // Beverage: Hauptwarengruppen mit Getränk/Bev/Bar
  const bevAmount = productGroups
    .filter(p => /geträn|bev|drink|bar|wein|spirit|alk/i.test(p.name))
    .reduce((s, p) => s + p.amount, 0);

  // Bar-Umsatz: Kostenstellen "Bar"
  const barAmount = costCenters
    .filter(c => /^bar$/i.test(c.name.trim()) || /bar umsatz/i.test(c.name))
    .reduce((s, c) => s + c.amount, 0);

  // Küchen-Umsatz: Kostenstellen "Küche"
  const kitchenAmount = costCenters
    .filter(c => /küche|kueche|kitchen/i.test(c.name))
    .reduce((s, c) => s + c.amount, 0);

  // Take Away: Kellner "Take Away" oder Kostenstelle "Take Away"
  const takeAwayAmount = [
    ...waiters.filter(w => /take.?away|takeaway|abholung/i.test(w.name)),
    ...costCenters.filter(c => /take.?away|takeaway/i.test(c.name)),
  ].reduce((s, x) => s + x.amount, 0);

  // Marketing: Rabatte mit "marketing"
  const marketingAmount = Math.abs(discounts
    .filter(d => /marketing/i.test(d.name))
    .reduce((s, d) => s + d.amount, 0));

  // Maison: Rabatte/Buchungskonten mit "maison"
  const maisonDisc = Math.abs(discounts
    .filter(d => /maison/i.test(d.name))
    .reduce((s, d) => s + d.amount, 0));
  const maisonAcct = accountingLines
    .filter(a => /maison/i.test(a.name))
    .reduce((s, a) => s + a.grossAmount, 0);
  const maisonAmount = maisonDisc + maisonAcct;

  // Storno gesamt
  const stornoTotal = Math.abs(cancellations.reduce((s, c) => s + c.amount, 0));

  // Rabatte gesamt
  const discountTotal = Math.abs(discounts.reduce((s, d) => s + d.amount, 0));

  // Bon-Anzahl: Summe aller Kellner-Bons, oder grössten Kostenstellen-Count
  const bonCount = waiters.reduce((s, w) => s + w.count, 0)
    || costCenters.reduce((s, c) => s + c.count, 0);

  const avgBon = bonCount > 0 && revenue.totalGross > 0
    ? revenue.totalGross / bonCount : 0;

  return {
    fileName,
    checksum,
    warnings,
    periodRaw,
    periodFrom,
    periodTo,
    zCounter: zCounterRaw,
    costCenter,
    revenue,
    taxes,
    taxNetTotal,
    costCenters,
    waiters,
    paymentMethods,
    productGroups,
    discounts,
    cancellations,
    accountingLines,
    paymentAccounts,
    netRevenue,
    foodAmount,
    bevAmount,
    barAmount,
    kitchenAmount,
    takeAwayAmount,
    marketingAmount,
    maisonAmount,
    stornoTotal,
    discountTotal,
    bonCount,
    avgBon,
  };
}
