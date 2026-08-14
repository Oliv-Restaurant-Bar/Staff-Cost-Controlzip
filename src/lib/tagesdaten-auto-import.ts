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

export type TagesdatenTyp = 'gaeste' | 'durchschnitt' | 'umsatzprogast' | 'umsatz' | 'marketing';

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
/** Gescannte Inhalts-Merkmale einer Datei (eine Durchlauf-Analyse aller Zeilen). */
interface RowScan {
  gesamtHasChf: boolean;
  gaesteEindeutig: boolean;      // «Gesamt» mit «… P.»-Suffix
  hasMarketing: boolean;
  durchschnittChf: boolean;      // Zeile «Durchschnitt» mit CHF
  umsatzProGastChf: boolean;     // Zeile «Umsatz pro Gast»/«Umsatz/Gast» mit CHF
  umsatzKategorien: number;      // CHF-Kategorien Gesamt/Food/Beverage/Take Away
}

function scanRows(rows: string[][]): RowScan {
  let hasGesamt = false;
  let gesamtHasChf = false;
  let gesamtHasPersonSuffix = false;
  let hasMarketing = false;
  let durchschnittChf = false;
  let umsatzProGastChf = false;
  let foodHasChf = false, beverageHasChf = false, takeAwayHasChf = false;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const l = label(row);
    if (!l) continue;
    const chf = hasChfValue(row);

    if (labelIs(row, 'marketing')) hasMarketing = true;
    if (labelIs(row, 'durchschnitt') && chf) durchschnittChf = true;
    // Bezeichnung explizit pro Person: «Umsatz pro Gast» / «Umsatz/Gast»
    if (labelIs(row, 'umsatz pro gast', 'umsatz/gast') && chf) umsatzProGastChf = true;

    // «Gesamt»/«Total» (aber nicht die Take-Away-Zeile)
    if (!isTakeAwayLabel(row) && (l === 'gesamt' || l === 'total' || l.includes('gesamt') || l.includes('total'))) {
      hasGesamt = true;
      if (chf) gesamtHasChf = true;
      if (hasPersonSuffix(row)) gesamtHasPersonSuffix = true;
    }

    if (isTakeAwayLabel(row)) { if (chf) takeAwayHasChf = true; }
    if (labelIncludes(row, 'food', 'speisen')) { if (chf) foodHasChf = true; }
    if (labelIncludes(row, 'beverage', 'getränke')) { if (chf) beverageHasChf = true; }
  }

  return {
    gesamtHasChf,
    gaesteEindeutig: hasGesamt && gesamtHasPersonSuffix,
    hasMarketing,
    durchschnittChf,
    umsatzProGastChf,
    umsatzKategorien:
      Number(gesamtHasChf) + Number(foodHasChf) + Number(beverageHasChf) + Number(takeAwayHasChf),
  };
}

export function detectTagesdatenTyp(rows: string[][]): TagesdatenTyp | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const s = scanRows(rows);

  // 1) Gäste: «Gesamt» mit Personen-Suffix
  if (s.gaesteEindeutig) return 'gaeste';

  // 2) Marketing: vor Umsatz prüfen (Marketing-Dateien können Gesamt-Zeilen haben)
  if (s.hasMarketing) return 'marketing';

  // 3) Explizite Bezeichnung «Umsatz pro Gast»/«Umsatz/Gast» → pro Person.
  if (s.umsatzProGastChf) return 'umsatzprogast';

  // 4) «Durchschnitt» mit CHF …
  if (s.durchschnittChf) {
    // … mit mehrheitlich CHF-Kategorien daneben → umsatz.
    if (s.umsatzKategorien >= 2) return 'umsatz';
    // Sonst MEHRDEUTIG (Ø pro Bon vs. CHF pro Person) → KEIN Auto-Vorschlag;
    // die UI zeigt einen neutralen Wahl-Hinweis (istDurchschnittMehrdeutig).
    return null;
  }

  // 5) Umsatz: Gesamt/Food/Beverage/Take Away MIT CHF-Werten
  if (s.umsatzKategorien >= 1) return 'umsatz';

  return null;
}

/**
 * Mehrdeutige «Durchschnitt»-CHF-Datei (Ø pro Bon ODER Umsatz/Gast)? Die UI
 * zeigt dann statt eines Auto-Vorschlags den neutralen Hinweis «Bitte wählen».
 */
export function istDurchschnittMehrdeutig(rows: string[][]): boolean {
  const s = scanRows(rows);
  return s.durchschnittChf && !s.umsatzProGastChf && !s.gaesteEindeutig
    && !s.hasMarketing && s.umsatzKategorien < 2;
}

/**
 * Enthält die Datei CHF-Werte PRO PERSON («Umsatz pro Gast»/«Umsatz/Gast»/
 * «Durchschnitt» mit CHF) statt Personen-Anzahlen? Für die klare Fehlermeldung,
 * wenn so eine Datei fälschlich als «Gäste / Anzahl Personen» geparst wird.
 */
export function istChfProPersonDatei(rows: string[][]): boolean {
  const s = scanRows(rows);
  return (s.durchschnittChf || s.umsatzProGastChf) && !s.gaesteEindeutig;
}

/**
 * Typ-Vorschlag aus dem DATEINAMEN («Anzahl Oliv 07.2026.xlsx» → gaeste).
 * Nur Vorschlag — der Nutzer bestätigt den Typ immer aktiv in der UI.
 */
export function suggestTypFromFileName(fileName: string): TagesdatenTyp | null {
  const n = fileName.toLowerCase();
  if (/anzahl|g[äa]ste|gaeste|personen|pax/u.test(n)) return 'gaeste';
  if (/marketing|maison/u.test(n)) return 'marketing';
  // «Umsatz pro Person/Gast»: gleicher Datei-Kopf «Durchschnitt» wie der
  // Durchschnittsbon — nur der Dateiname kann die pro-Person-Variante nahelegen.
  if (/pro[\s._-]*(person|gast)|umsatz[\s._-]*gast/u.test(n)) return 'umsatzprogast';
  if (/durchschnitt/u.test(n)) return 'durchschnitt';
  if (/umsatz|revenue/u.test(n)) return 'umsatz';
  return null;
}

/**
 * Kombinierter Typ-VORSCHLAG (Dateiname vor Inhalt): Ein Dateiname mit
 * «Anzahl»/«Gäste» schlägt IMMER gaeste vor — auch wenn die Inhalts-Erkennung
 * die Werte für CHF hält (verhindert die stille Umsatz-Zuordnung einer
 * Gästezählung ohne «P.»-Suffix). Kein automatisches Verbuchen: der Vorschlag
 * füllt nur das Auswahlfeld vor, der Nutzer bestätigt aktiv.
 */
export function suggestTagesdatenTyp(fileName: string, rows: string[][]): TagesdatenTyp | null {
  const ausName = suggestTypFromFileName(fileName);
  // «Durchschnitt» im DATEINAMEN ist genauso mehrdeutig (Ø pro Bon vs. pro
  // Person) wie die Inhalts-Zeile: bei mehrdeutigem Inhalt KEIN Vorschlag —
  // die UI zeigt den neutralen Wahl-Hinweis.
  if (ausName === 'durchschnitt' && istDurchschnittMehrdeutig(rows)) return null;
  return ausName ?? detectTagesdatenTyp(rows);
}

/** Grobes Wertemuster der Datenzeilen: Personenzahlen vs. CHF-Beträge. */
export type Wertemuster = 'anzahl' | 'chf' | null;

/**
 * Analysiert die Wertspalten (ab Spalte 3) aller Datenzeilen:
 *   - «… P.»-Suffix irgendwo            → 'anzahl'
 *   - «CHF»/«Fr.»-Präfix irgendwo       → 'chf'
 *   - sonst: alle Werte ganzzahlig und ≤ 5000 → 'anzahl' (typische Tages-Kopfzahlen);
 *            Dezimalwerte vorhanden          → 'chf';
 *            unklar                          → null.
 */
export function analyzeWertemuster(rows: string[][]): Wertemuster {
  let count = 0, integers = 0, decimals = 0, maxAbs = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    for (let c = 2; c < row.length; c++) {
      const s = cellToString(row[c]).replace(/\u00A0/gu, ' ').trim();
      if (!s) continue;
      if (/\d\s*P\.?\s*$/iu.test(s)) return 'anzahl';
      if (/^(?:chf|fr\.)/iu.test(s)) return 'chf';
      const n = parseFloat(s.replace(/['’\s]/gu, '').replace(',', '.'));
      if (!Number.isFinite(n)) continue;
      count++;
      maxAbs = Math.max(maxAbs, Math.abs(n));
      if (Number.isInteger(n)) integers++; else decimals++;
    }
  }
  if (count === 0) return null;
  if (decimals > 0) return 'chf';
  if (integers === count && maxAbs <= 5000) return 'anzahl';
  return null;
}

/**
 * Plausibilitäts-Riegel: Widerspricht das Wertemuster dem GEWÄHLTEN Typ,
 * liefert dies einen Warntext (UI verlangt dann eine bewusste Bestätigung).
 * Gäste-Werte dürfen NIE unbestätigt als Umsatz gespeichert werden.
 */
/**
 * HARTER Riegel: Ein klares ANZAHL-Muster darf NIE als Umsatz gespeichert
 * werden — auch nicht per Bestätigung (Spec: «dürfen NIE als Umsatz gespeichert
 * werden»). Der Nutzer muss den Typ wechseln (z.B. auf Gäste/Anzahl Personen).
 */
export function istHartBlockiert(typ: TagesdatenTyp, muster: Wertemuster): boolean {
  return typ === 'umsatz' && muster === 'anzahl';
}

export function wertemusterWarnung(typ: TagesdatenTyp, muster: Wertemuster): string | null {
  if (muster == null) return null;
  const chfTyp = typ === 'umsatz' || typ === 'marketing' || typ === 'durchschnitt' || typ === 'umsatzprogast';
  if (chfTyp && muster === 'anzahl') {
    return 'Die Werte sehen nach ANZAHL PERSONEN aus (ganze Zahlen im Personen-Bereich), gewählt ist aber ein CHF-Typ. Werte passen nicht zum gewählten Typ — bitte prüfen.';
  }
  if (typ === 'gaeste' && muster === 'chf') {
    return 'Die Werte sehen nach CHF-BETRÄGEN aus (Dezimalstellen/CHF), gewählt ist aber «Gäste/Anzahl Personen». Werte passen nicht zum gewählten Typ — bitte prüfen.';
  }
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
  // «TT.MM.» (Jahr aus Dropdown) ODER «TT.MM.JJJJ» (Jahr aus dem Header selbst)
  const m = String(header).trim().match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const y = m[3] ? parseInt(m[3], 10) : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Echte Kalendergültigkeit: Date-Konstruktion muss verlustfrei zurückkommen
  // (fängt 29.02. in Nicht-Schaltjahren, 31.04., 31.06. usw. ab).
  const dt = new Date(Date.UTC(y, month - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Menschliche Anzeige einer ungültigen Datumsspalte für Warnungen («29.02.»). */
export function formatInvalidDayMonth(header: string): string {
  return String(header).trim();
}
