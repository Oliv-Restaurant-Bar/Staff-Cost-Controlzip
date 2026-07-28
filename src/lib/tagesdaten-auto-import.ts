/**
 * tagesdaten-auto-import.ts — Auto-Typerkennung für den EINEN Tagesdaten-Import
 * =============================================================================
 * Das Import-Center hat eine einzige Upload-Zone. Diese Datei erkennt anhand der
 * ersten Spalte (Bezeichnung) und des Wertformats, welcher der vier bestehenden
 * Tagesdaten-Importe gemeint ist. Die eigentlichen Parser werden NICHT dupliziert
 * — nach der Erkennung ruft die UI den passenden bestehenden Parser auf
 * (parseGaesteXlsx, parseDurchschnittXlsx, parseGastronoviExcel, parseMaisonXlsx).
 *
 * Erkennungsmerkmale (bewusst zentral gebündelt, konsistent mit den Parsern):
 *   - gaeste       : Zeile «Gesamt» mit Personen-Suffix «… P.» (gaeste-import.ts)
 *   - marketing    : Zeile «marketing»/«Marketing» (maison-import.ts) — VOR umsatz
 *                    geprüft, weil Marketing-Dateien auch «Gesamt»-Zeilen haben.
 *   - durchschnitt : Zeile «Durchschnitt» mit CHF-Werten (gaeste-import.ts)
 *   - umsatz       : Zeilen «Gesamt»/«Food»/«Beverage»/«Take Away» in CHF
 *                    (revenue-parser.ts)
 *   - null         : nicht eindeutig / nichts erkannt → KEIN Import.
 *
 * Jahr: NICHT aus der Datei abgeleitet (keine Silvester-Heuristik). Massgeblich
 * ist ausschliesslich das Jahr-Dropdown der UI; die Datumsspalten liefern nur
 * «TT.MM.», das Jahr wird via isoFromDayMonth()/den Parsern beigesteuert.
 */

import ExcelJS from 'exceljs';

export type TagesdatenTyp = 'gaeste' | 'durchschnitt' | 'umsatz' | 'marketing';

/** Zellwert robust in Text wandeln (RichText-/Formel-/NBSP-tolerant). */
function cellToString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    const o = val as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (Array.isArray(o.richText)) return o.richText.map(t => t.text ?? '').join('');
    if (o.result !== undefined) return cellToString(o.result);
    if (typeof o.text === 'string') return o.text;
  }
  return String(val);
}

/** Erste Spalte einer Zeile normalisiert (klein, getrimmt, NBSP → Space). */
function label(row: string[]): string {
  return cellToString(row[0]).replace(/\u00A0/gu, ' ').trim().toLowerCase();
}

/** Trifft die erste Spalte genau (nach Normalisierung) auf eines der Labels? */
function labelIs(row: string[], ...names: string[]): boolean {
  const l = label(row);
  return names.some(n => l === n);
}

/** Enthält die erste Spalte eines der Teil-Labels? (Umsatz-Kategorien) */
function labelIncludes(row: string[], ...parts: string[]): boolean {
  const l = label(row);
  return parts.some(p => l.includes(p));
}

/** Personen-Suffix «… P.» in einer der Wertspalten (ab Spalte 3, Index 2)? */
function hasPersonSuffix(row: string[]): boolean {
  for (let c = 1; c < row.length; c++) {
    const s = cellToString(row[c]).trim();
    if (/\d\s*P\.?\s*$/iu.test(s)) return true;
  }
  return false;
}

/**
 * Trägt die Zeile in einer Wertspalte einen CHF-/Geldbetrag? Akzeptiert «CHF 100.00»,
 * «1'234.50», «100», «-50.00» usw. Ausgeschlossen: Personen-Werte («300 P.»), damit
 * eine Gäste-Zeile nicht fälschlich als Geldzeile zählt.
 */
function hasChfValue(row: string[]): boolean {
  for (let c = 1; c < row.length; c++) {
    const s = cellToString(row[c]).replace(/\u00A0/gu, ' ').trim();
    if (!s) continue;
    if (/\d\s*P\.?\s*$/iu.test(s)) continue; // Personen-Suffix → keine Geldzeile
    // Zahl mit optionalem CHF/Fr., Tausender-Apostroph/Punkt, Dezimalstellen
    if (/-?(?:chf|fr\.?)?\s*\d[\d'.,]*/iu.test(s) && /\d/u.test(s)) return true;
  }
  return false;
}

/** Take-Away-Zeile (verschiedene Schreibweisen wie im revenue-parser). */
function isTakeAwayLabel(row: string[]): boolean {
  const l = label(row);
  return l.includes('take away') || l.includes('take-away') || l.includes('takeaway')
    || l.includes('ausser haus') || l.includes('außer haus');
}

/**
 * Auto-Erkennung aus normalisierten Zeilen (Zeile 1 = Kopf mit «TT.MM.»-Spalten,
 * danach Daten). Reihenfolge der Prüfungen ist bewusst:
 *   1) gaeste     (Gesamt + «… P.»-Suffix — eindeutig Personen)
 *   2) marketing  (marketing-Zeile — VOR umsatz, da Marketing-Dateien auch Gesamt haben)
 *   3) durchschnitt (Durchschnitt-Zeile MIT CHF-Werten)
 *   4) umsatz     (Gesamt/Food/Beverage/Take Away MIT CHF-Werten)
 * Nichts davon → null.
 *
 * Randfall Durchschnitt vs. Umsatz: Enthält eine Datei BEIDES — eine
 * «Durchschnitt»-Zeile UND CHF-Kategorien (Gesamt/Food/Beverage/Take Away) —
 * entscheidet die Mehrheit der CHF-Kategorienzeilen → umsatz. Eine reine
 * Durchschnitt-Datei (nur «Durchschnitt», keine Kategorien) → durchschnitt.
 */
export function detectTagesdatenTyp(rows: string[][]): TagesdatenTyp | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let hasGesamt = false;
  let gesamtHasChf = false;
  let gesamtHasPersonSuffix = false;
  let hasMarketing = false;
  let hasDurchschnitt = false;
  let durchschnittHasChf = false;
  let hasFood = false, foodHasChf = false;
  let hasBeverage = false, beverageHasChf = false;
  let hasTakeAway = false, takeAwayHasChf = false;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const l = label(row);
    if (!l) continue;
    const chf = hasChfValue(row);

    if (labelIs(row, 'marketing')) hasMarketing = true;
    if (labelIs(row, 'durchschnitt')) { hasDurchschnitt = true; if (chf) durchschnittHasChf = true; }

    // «Gesamt»/«Total» (aber nicht die Take-Away-Zeile)
    if (!isTakeAwayLabel(row) && (l === 'gesamt' || l === 'total' || l.includes('gesamt') || l.includes('total'))) {
      hasGesamt = true;
      if (chf) gesamtHasChf = true;
      if (hasPersonSuffix(row)) gesamtHasPersonSuffix = true;
    }

    if (isTakeAwayLabel(row)) { hasTakeAway = true; if (chf) takeAwayHasChf = true; }
    if (labelIncludes(row, 'food', 'speisen')) { hasFood = true; if (chf) foodHasChf = true; }
    if (labelIncludes(row, 'beverage', 'getränke')) { hasBeverage = true; if (chf) beverageHasChf = true; }
  }

  // 1) Gäste: «Gesamt» mit Personen-Suffix
  if (hasGesamt && gesamtHasPersonSuffix) return 'gaeste';

  // 2) Marketing: vor Umsatz prüfen (Marketing-Dateien können Gesamt-Zeilen haben)
  if (hasMarketing) return 'marketing';

  // Anzahl echter CHF-Umsatz-Kategorien (Gesamt/Food/Beverage/Take Away)
  const umsatzKategorien =
    Number(gesamtHasChf) + Number(foodHasChf) + Number(beverageHasChf) + Number(takeAwayHasChf);

  // 3) Durchschnittsverkauf: «Durchschnitt» mit CHF …
  if (hasDurchschnitt && durchschnittHasChf) {
    // … aber wenn zusätzlich mehrheitlich CHF-Kategorien da sind → umsatz.
    if (umsatzKategorien >= 2) return 'umsatz';
    return 'durchschnitt';
  }

  // 4) Umsatz: Gesamt/Food/Beverage/Take Away MIT CHF-Werten
  if (umsatzKategorien >= 1) return 'umsatz';

  return null;
}

/** Liest die erste Tabelle einer Excel-Datei in ein rohes string[][] (Zeile 1 = Kopf). */
export async function readFirstSheetRows(file: File): Promise<string[][]> {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Keine Tabelle im Excel gefunden');

  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, row => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, cell => {
      cells.push(cellToString(cell.value));
    });
    rows.push(cells);
  });
  return rows;
}

/** Auto-Erkennung direkt aus einer Datei (liest die erste Tabelle). */
export async function detectTagesdatenTypFromFile(file: File): Promise<TagesdatenTyp | null> {
  const rows = await readFirstSheetRows(file);
  return detectTagesdatenTyp(rows);
}

/**
 * Bildet aus «TT.MM.» (aus einer Datums-Spaltenüberschrift) und dem gewählten
 * Jahr einen ISO-Schlüssel «YYYY-MM-DD». KEINE Jahres-Heuristik — das Jahr kommt
 * ausschliesslich aus dem übergebenen Parameter (UI-Dropdown).
 *
 * Validiert gegen echte Kalenderdaten: 29.02. nur in Schaltjahren, 31.04. nie
 * usw. Gibt null zurück, wenn der Header keinem «TT.MM.[.]»-Muster entspricht
 * ODER der Tag im gewählten Jahr nicht existiert.
 */
export function isoFromDayMonth(header: string, year: number): string | null {
  const m = String(header).trim().match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Echte Kalendergültigkeit: Date-Konstruktion muss verlustfrei zurückkommen
  // (fängt 29.02. in Nicht-Schaltjahren, 31.04., 31.06. usw. ab).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Menschliche Anzeige einer ungültigen Datumsspalte für Warnungen («29.02.»). */
export function formatInvalidDayMonth(header: string): string {
  return String(header).trim();
}
