/**
 * gastronovi-csv-parser.ts
 * ========================
 * Robuster Parser für Tab-getrennte Gastronovi-Exportdateien.
 *
 * Dateiformat:
 *   - Tab-getrennt (\t)
 *   - UTF-8 (optional mit BOM)
 *   - Zeile 1: Header  [Bezeichnung, Zeitraum, 01.03., 02.03., ...]
 *   - Spalte A: Produktname (Bezeichnung)
 *   - Spalte B: Gesamtzeitraum (Summe – wird ignoriert)
 *   - Spalten C+: Tageswerte mit Datum-Header "DD.MM." oder "DD.MM"
 *
 * Zwei Dateitypen werden zusammen verarbeitet:
 *   - "Anzahl ..."  → enthält Mengen
 *   - "Umsatz ..."  → enthält Umsätze in CHF
 *
 * Diese Utility wird von SalesUpload für Food und Beverage gleich genutzt.
 */

// ─── Typen ────────────────────────────────────────────────────────────────────

export type ProductCategory = 'food' | 'beverage';

/** Eine geparste Tabellenzeile (breites Format) */
export interface ParsedWideRow {
  /** Produktbezeichnung (Spalte A) */
  productName: string;
  /** Datums-Spalten: Key = "DD.MM.", Value = numerischer Wert */
  dayValues:   Record<string, number>;
  /** Rohe Werte für Diagnose */
  rawValues:   Record<string, string>;
}

/** Ergebnis eines Datei-Parsings */
export interface ParseResult {
  rows:          ParsedWideRow[];
  dateColumns:   string[];   // alle erkannten Datums-Spalten-Header
  skippedRows:   string[];   // übersprungene Zeilen (Summen/Strukturzeilen)
  warningRows:   string[];   // Zeilen mit Warnungen (unbekannte Werte)
  rawLineCount:  number;
}

/** Ein normalisierter Tagesdatensatz für den Supabase-Import */
export interface NormalizedSaleRow {
  product_name: string;
  quantity:     number;
  revenue:      number;
  sale_date:    string;      // ISO: YYYY-MM-DD
  source?:      string;
  import_batch?: string;
  file_name?:   string;
  notes?:       string;
  category?:    ProductCategory;
}

/** Ergebnis des Matchings zweier Dateien (Anzahl + Umsatz) */
export interface MatchResult {
  rows:          NormalizedSaleRow[];
  skippedCount:  number;   // Summen/Struktur-Zeilen total
  warningCount:  number;   // Zeilen mit Warnungen
  unmatchedProducts: string[];  // in Anzahl aber nicht in Umsatz (oder umgekehrt)
  duplicateProducts: string[];  // Produkte, die in Anzahl und/oder Umsatz auf mehreren Zeilen standen und zusammengeführt wurden
  dateColumnCount: number;
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

/** Produktnamen-Muster, die als Strukturzeilen übersprungen werden */
const STRUCTURAL_PATTERNS: RegExp[] = [
  /^gesamt\s*[-–—]/i,
  /^total\s*[-–—]/i,
  /^subtotal/i,
  /^summe/i,
  /^pizza\s+und\s+k[üu]che/i,
  /^men[üu]$/i,
  /^food$/i,
  /^beverage$/i,
  /^getr[äa]nke$/i,
  /^speisen$/i,
  /^k[üu]che$/i,
  /^restaurant$/i,
  /^bar$/i,
  /^takeaway$/i,
  /^take.?away$/i,
  /^sonstiges$/i,
  // Zeilen die mit "Gesamt" beginnen
  /^gesamt/i,
  // Kategorie-Summenzeilen im hierarchischen Export (Belt & Braces —
  // im hierarchischen Modus werden Nicht-Detail-Zeilen ohnehin übersprungen)
  /^food\s*\(speisen\)$/i,
  /^beverage\s*\(getr[äa]nke\)$/i,
];

/**
 * Blattwerte OHNE Detailzeilen im hierarchischen Export («> …»-Format):
 * Trinkgeld und Non-Foods haben keine «> »-Kinder und zählen selbst einmal.
 */
const HIERARCHIE_BLATT_AUSNAHMEN: RegExp[] = [
  /^trinkgeld$/i,
  /^non-?foods?\s*(\(nichtlebensmittel\))?$/i,
];

/** Erkennt eine Detailzeile («> Produkt») des hierarchischen Exports. */
const DETAIL_PREFIX_REGEX = /^>+\s*/;

/** Datumsformat der Spaltenheader: "01.03." / "01.03" / "01.03.2026" (mit Jahr) */
const DATE_COL_REGEX = /^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/;

// ─── Numerisches Parsen ───────────────────────────────────────────────────────

/**
 * Parst einen Zahlenwert aus diversen Formaten:
 *   1'234.56  → 1234.56
 *   1.234,56  → 1234.56
 *   CHF 1234  → 1234
 *   "1 234"   → 1234
 *   ""        → 0
 *   "-"       → 0
 */
export function parseNumeric(raw: string | undefined): number {
  if (!raw || !raw.trim() || raw.trim() === '-' || raw.trim() === '–') return 0;

  let s = raw.trim();

  // CHF entfernen
  s = s.replace(/^CHF\s*/i, '').replace(/\s*CHF$/i, '');

  // Tausendertrennzeichen: Apostroph oder Leerzeichen
  s = s.replace(/'/g, '').replace(/\u00a0/g, '').replace(/\s/g, '');

  // Deutsche Schreibweise: 1.234,56 → 1234.56
  // Wenn Komma als Dezimal-Trenner und Punkt als Tausender:
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Nur Komma als Dezimal-Trenner (kein Punkt): 1234,56
    s = s.replace(',', '.');
  }

  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ─── Datum aus Spaltenheader ──────────────────────────────────────────────────

/**
 * Wandelt einen Spaltenheader ("01.03.") und ein Jahr (2026)
 * in ein ISO-Datum "2026-03-01" um.
 * Gibt null zurück wenn der Header kein Datum ist.
 */
export function headerToIsoDate(header: string, year: number): string | null {
  const m = DATE_COL_REGEX.exec(header.trim());
  if (!m) return null;
  const day   = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  // Header MIT Jahr («01.08.2026») ist massgeblich — sonst Dropdown-Jahr.
  const y = m[3] ? parseInt(m[3], 10) : year;
  return `${y}-${month}-${day}`;
}

/** Erkennt ob ein Spaltenheader ein Datumsspalte ist */
export function isDateColumn(header: string): boolean {
  return DATE_COL_REGEX.test(header.trim());
}

/**
 * Pure: ermittelt den datierten Zeitraum (min/max sale_date) über eine Liste
 * bereits datierter Zeilen. Dient der Vorschau («TT.MM.»-Spalten sind ohne
 * Jahr — das gewählte Jahr wird über headerToIsoDate eingesetzt; hier wird der
 * resultierende, tatsächlich datierte Bereich sichtbar gemacht). Ignoriert
 * leere/ungültige ISO-Daten. Leere Eingabe → { from: null, to: null }.
 */
export function saleDateRange(
  rows: Array<{ sale_date?: string | null }>,
): { from: string | null; to: string | null } {
  let from: string | null = null;
  let to: string | null = null;
  for (const r of rows) {
    const d = r.sale_date;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
  }
  return { from, to };
}

// ─── Strukturzeilen-Erkennung ─────────────────────────────────────────────────

/** Gibt true wenn die Zeile eine Summen- oder Strukturzeile ist */
export function isStructuralRow(name: string): boolean {
  if (!name || !name.trim()) return true;
  const n = name.trim();
  return STRUCTURAL_PATTERNS.some(pat => pat.test(n));
}

// ─── BOM-Handling ─────────────────────────────────────────────────────────────

/** Entfernt UTF-8 BOM (EF BB BF) am Anfang eines Strings */
function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

// ─── Datei einlesen ───────────────────────────────────────────────────────────

/** Liest eine Datei als Text (UTF-8) */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(stripBom(e.target?.result as string ?? ''));
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.readAsText(file, 'UTF-8');
  });
}

// ─── Tab-CSV parsen ───────────────────────────────────────────────────────────

/** Parst eine Zeile als Tab-getrennte Felder, entfernt Anführungszeichen */
function parseTsvLine(line: string): string[] {
  return line.split('\t').map(cell => {
    const t = cell.trim();
    // Doppelte Anführungszeichen entfernen
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
      return t.slice(1, -1).replace(/""/g, '"');
    }
    return t;
  });
}

// ─── Breit-Datei parsen ───────────────────────────────────────────────────────

/**
 * Parst eine Gastronovi-Exportdatei im breiten Format.
 * Ergibt eine ParseResult mit einer Zeile pro Produkt und
 * allen erkannten Datumsspalten.
 */
export async function parseWideFile(file: File): Promise<ParseResult> {
  const text       = await readFileAsText(file);
  const lines      = text.split(/\r?\n/);
  const rawLineCount = lines.filter(l => l.trim()).length;

  if (lines.length === 0) {
    throw new Error(`Datei "${file.name}" ist leer`);
  }

  // Header-Zeile (Zeile 1)
  const headerCells = parseTsvLine(lines[0]);
  if (headerCells.length < 3) {
    throw new Error(
      `Datei "${file.name}": Kopfzeile hat zu wenige Spalten (${headerCells.length}). ` +
      `Erwartet: Tab-getrennte Datei mit mind. 3 Spalten.`
    );
  }

  // Spalten-Positionen ermitteln
  // Spalte 0 = Bezeichnung, Spalte 1 = Zeitraum, Spalten 2+ = Tage
  const dateColumns: string[] = [];
  for (let c = 2; c < headerCells.length; c++) {
    const h = headerCells[c].trim();
    if (h && isDateColumn(h)) dateColumns.push(h);
  }

  if (dateColumns.length === 0) {
    throw new Error(
      `Datei "${file.name}": Keine Datumsspalten gefunden. ` +
      `Erwartet: Spalten ab Position C im Format "01.03." (Tag.Monat.)`
    );
  }

  const rows:        ParsedWideRow[] = [];
  const skippedRows: string[]        = [];
  const warningRows: string[]        = [];

  // HIERARCHISCHER Export erkannt? (Detailzeilen mit «> »-Präfix vorhanden)
  // Dann sind Zeilen OHNE Präfix Kategorie-SUMMEN ihrer «> »-Kinder
  // («Beverage (Getränke)», «Food (Speisen)», «Gesamt») und werden komplett
  // übersprungen — sonst zählt jede Position mehrfach (Dreifachzählung).
  // Ausnahme: Trinkgeld/Non-Foods haben keine Kinder → selbst Blattwerte.
  const istHierarchisch = lines.some((l, i) =>
    i >= 1 && DETAIL_PREFIX_REGEX.test((parseTsvLine(l)[0] ?? '').trim()) && (parseTsvLine(l)[0] ?? '').trim().length > 1);

  // Datenzeilen (ab Zeile 2)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const cells = parseTsvLine(line);
    let productName = cells[0]?.trim() ?? '';

    if (istHierarchisch) {
      if (DETAIL_PREFIX_REGEX.test(productName)) {
        // Detailzeile: «> »-Präfix für Speicherung/Matching entfernen
        productName = productName.replace(DETAIL_PREFIX_REGEX, '').trim();
        if (!productName) { skippedRows.push(`Zeile ${i + 1}`); continue; }
      } else if (!HIERARCHIE_BLATT_AUSNAHMEN.some(p => p.test(productName))) {
        // Kategorie-/Gesamt-Summenzeile → NIE mitzählen
        skippedRows.push(productName || `Zeile ${i + 1}`);
        continue;
      }
    }

    // Strukturzeilen überspringen
    if (isStructuralRow(productName)) {
      skippedRows.push(productName || `Zeile ${i + 1}`);
      continue;
    }

    // Tageswerte einlesen
    const dayValues: Record<string, number> = {};
    const rawValues: Record<string, string> = {};
    let hasAnyValue = false;
    let hasWarning  = false;

    for (let c = 2; c < headerCells.length; c++) {
      const header = headerCells[c].trim();
      if (!isDateColumn(header)) continue;
      const raw  = cells[c]?.trim() ?? '';
      const val  = parseNumeric(raw);
      dayValues[header] = val;
      rawValues[header] = raw;
      if (val !== 0) hasAnyValue = true;

      // Warnung wenn Rohwert vorhanden aber nicht parsierbar (unerwartetes Format)
      if (raw && raw !== '-' && raw !== '–' && isNaN(parseFloat(raw.replace(/['^,\s]/g, '').replace(',', '.')))) {
        hasWarning = true;
      }
    }

    // Zeilen ohne jeglichen Wert überspringen
    if (!hasAnyValue) {
      skippedRows.push(productName);
      continue;
    }

    if (hasWarning) warningRows.push(productName);

    rows.push({ productName, dayValues, rawValues });
  }

  return { rows, dateColumns, skippedRows, warningRows, rawLineCount };
}

// ─── Mehrfachzeilen je Produkt zusammenführen ────────────────────────────────

/** Eine pro Produktname zusammengeführte Zeile (mehrere Exportzeilen summiert) */
interface AggregatedProduct {
  /** Erste gesehene Original-Bezeichnung (für die Anzeige/Speicherung) */
  displayName: string;
  /** Pro Datum aufsummierte Tageswerte */
  dayValues:   Record<string, number>;
  /** Anzahl der zusammengeführten Exportzeilen (>1 ⇒ Duplikat) */
  lineCount:   number;
}

/**
 * Fasst alle Exportzeilen mit identischem (normalisiertem) Produktnamen zusammen.
 * Tageswerte werden pro Datum **aufsummiert** – so geht weder Menge noch Umsatz
 * verloren, wenn ein Produkt im Gastronovi-Export mehrfach auftaucht (z. B. auf
 * mehreren Kostenstellen-/Gruppenzeilen). Dies ersetzt sowohl das frühere
 * `Map.set`-Überschreiben (verlor Umsatz) als auch das zeilenweise Emittieren
 * (erzeugte doppelte product_sales-Datensätze pro Produkt/Tag).
 */
function aggregateRowsByName(rows: ParsedWideRow[]): Map<string, AggregatedProduct> {
  const map = new Map<string, AggregatedProduct>();
  for (const r of rows) {
    const key = normalizeProductName(r.productName);
    let entry = map.get(key);
    if (!entry) {
      entry = { displayName: r.productName.trim(), dayValues: {}, lineCount: 0 };
      map.set(key, entry);
    }
    entry.lineCount += 1;
    for (const [dateCol, val] of Object.entries(r.dayValues)) {
      entry.dayValues[dateCol] = (entry.dayValues[dateCol] ?? 0) + val;
    }
  }
  return map;
}

// ─── Paar-übergreifende Dublettensicherung ───────────────────────────────────

/**
 * Entfernt aus `secondary` die HIERARCHIE-BLATTWERTE (nur Trinkgeld/Non-Foods),
 * deren (normalisierter Name, Datum) bereits in `primary` vorkommt. Diese
 * Blattwerte stehen in BEIDEN Dateipaaren — sie dürfen pro Tag genau EINMAL
 * einfliessen (das Food-Paar gewinnt). Bewusst NICHT auf beliebige Produkte
 * angewandt: Ein echtes Food- und ein echtes Beverage-Produkt mit zufällig
 * gleichem Namen bleiben beide erhalten (verschiedene Kategorien/Quellen).
 */
export function dedupeAcrossPairs(
  primary: NormalizedSaleRow[],
  secondary: NormalizedSaleRow[],
): { rows: NormalizedSaleRow[]; removed: string[] } {
  const seen = new Set(primary.map(r => `${normalizeProductName(r.product_name)}|${r.sale_date}`));
  const rows: NormalizedSaleRow[] = [];
  const removedSet = new Set<string>();
  for (const r of secondary) {
    const istBlattAusnahme = HIERARCHIE_BLATT_AUSNAHMEN.some(p => p.test(r.product_name.trim()));
    if (istBlattAusnahme && seen.has(`${normalizeProductName(r.product_name)}|${r.sale_date}`)) {
      removedSet.add(r.product_name);
    } else {
      rows.push(r);
    }
  }
  return { rows, removed: [...removedSet] };
}

// ─── Matching: Anzahl + Umsatz → Tagesdatensätze ────────────────────────────

/**
 * Kombiniert zwei ParseResults (Anzahl + Umsatz) zu normierten Tagesdatensätzen.
 *
 * Normalisierungslogik:
 *   1. Anzahl- UND Umsatzzeilen werden je (normalisiertem) Produktnamen
 *      zusammengeführt – Mehrfachzeilen desselben Produkts werden pro Datum
 *      aufsummiert (kein Überschreiben, keine doppelten Datensätze).
 *   2. Für jedes zusammengeführte Produkt und jede erkannte Datumsspalte:
 *        - quantity = aufsummierter Anzahl-Wert für diesen Tag
 *        - revenue  = aufsummierter Umsatz-Wert für diesen Tag
 *        - Nur einfügen wenn qty > 0 ODER revenue > 0
 *      → garantiert genau **eine** Zeile pro Produkt/Datum.
 *   3. sale_date = ISO-Datum aus Spaltenheader + Formular-Jahr
 */
export function matchAnzahlUmsatz(
  anzahlResult: ParseResult,
  umsatzResult:  ParseResult,
  year:          number,
  category:      ProductCategory,
  meta: {
    source?:       string;
    importBatch?:  string;
    anzahlFileName?: string;
    umsatzFileName?: string;
    notes?:        string;
  }
): MatchResult {
  // Anzahl- und Umsatzzeilen je Produktname zusammenführen (Mehrfachzeilen summieren)
  const anzahlAgg = aggregateRowsByName(anzahlResult.rows);
  const umsatzAgg = aggregateRowsByName(umsatzResult.rows);

  // Alle erkannten Datumsspalten (Union aus beiden Dateien)
  const allDateCols = [
    ...new Set([...anzahlResult.dateColumns, ...umsatzResult.dateColumns]),
  ].sort((a, b) => {
    const ia = headerToIsoDate(a, year) ?? '';
    const ib = headerToIsoDate(b, year) ?? '';
    return ia.localeCompare(ib);
  });

  const rows:        NormalizedSaleRow[] = [];
  const unmatched:   string[]            = [];
  let skippedCount = anzahlResult.skippedRows.length + umsatzResult.skippedRows.length;
  let warningCount = anzahlResult.warningRows.length + umsatzResult.warningRows.length;

  // Produkte, die auf mehreren Exportzeilen standen (Anzahl ODER Umsatz) und
  // pro Tag zusammengeführt wurden – jedes Produkt nur einmal melden.
  const duplicateProducts: string[] = [];
  const seenDuplicate = new Set<string>();
  for (const [key, anzahlEntry] of anzahlAgg) {
    const umsatzEntry = umsatzAgg.get(key);
    if ((anzahlEntry.lineCount > 1 || (umsatzEntry?.lineCount ?? 0) > 1) && !seenDuplicate.has(key)) {
      duplicateProducts.push(anzahlEntry.displayName);
      seenDuplicate.add(key);
    }
  }
  for (const [key, umsatzEntry] of umsatzAgg) {
    // Nur-in-Umsatz-Duplikate (kein Anzahl-Gegenstück) ebenfalls melden
    if (umsatzEntry.lineCount > 1 && !anzahlAgg.has(key) && !seenDuplicate.has(key)) {
      duplicateProducts.push(umsatzEntry.displayName);
      seenDuplicate.add(key);
    }
  }

  const fileNames = [meta.anzahlFileName, meta.umsatzFileName]
    .filter(Boolean).join(', ');

  // Je zusammengeführtem Produkt genau eine Zeile pro Datum erzeugen
  for (const [key, anzahlEntry] of anzahlAgg) {
    const umsatzEntry = umsatzAgg.get(key);

    if (!umsatzEntry) {
      unmatched.push(anzahlEntry.displayName);
      // Importiere trotzdem mit revenue=0 um keinen Datenverlust zu haben
    }

    for (const dateCol of allDateCols) {
      const isoDate = headerToIsoDate(dateCol, year);
      if (!isoDate) continue;

      const qty = anzahlEntry.dayValues[dateCol] ?? 0;
      const rev = umsatzEntry?.dayValues[dateCol] ?? 0;

      // Nur einfügen wenn mind. ein Wert > 0
      if (qty === 0 && rev === 0) continue;

      rows.push({
        product_name: anzahlEntry.displayName,
        quantity:     qty,
        revenue:      rev,
        sale_date:    isoDate,
        category,
        source:       meta.source || `${category}_csv_export`,
        import_batch: meta.importBatch,
        file_name:    fileNames,
        notes:        meta.notes,
      });
    }
  }

  // Produkte nur in Umsatz (kein Anzahl-Gegenstück): trotzdem importieren
  // (Umsatz ohne Menge — quantity 0 als «leerer Gegenwert», kein Datenverlust)
  for (const [key, umsatzEntry] of umsatzAgg) {
    if (anzahlAgg.has(key)) continue;
    unmatched.push(`(nur in Umsatz) ${umsatzEntry.displayName}`);
    for (const dateCol of allDateCols) {
      const isoDate = headerToIsoDate(dateCol, year);
      if (!isoDate) continue;
      const rev = umsatzEntry.dayValues[dateCol] ?? 0;
      if (rev === 0) continue;
      rows.push({
        product_name: umsatzEntry.displayName,
        quantity:     0,
        revenue:      rev,
        sale_date:    isoDate,
        category,
        source:       meta.source || `${category}_csv_export`,
        import_batch: meta.importBatch,
        file_name:    fileNames,
        notes:        meta.notes,
      });
    }
  }

  return {
    rows,
    skippedCount,
    warningCount,
    unmatchedProducts: unmatched,
    duplicateProducts,
    dateColumnCount:   allDateCols.length,
  };
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/** Normalisiert Produktnamen für stabilen Vergleich */
function normalizeProductName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Erzeugt einen automatischen Import-Batch-String */
export function generateImportBatch(category: ProductCategory, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const i = String(date.getMinutes()).padStart(2, '0');
  return `${category}-${y}${m}${d}-${h}${i}`;
}
