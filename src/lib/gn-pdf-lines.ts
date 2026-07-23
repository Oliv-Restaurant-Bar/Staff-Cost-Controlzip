/**
 * Gastronovi PDF — Zeilenrekonstruktion und Berichtstyp-Erkennung (REINE Logik)
 * =============================================================================
 *
 * Arbeitet ausschliesslich auf Text-Items mit Position (x/y/str), wie sie das
 * IO-Modul `gn-pdf-text.ts` (pdfjs) liefert. Kein DOM, kein Supabase, kein pdfjs
 * — dadurch vollständig mit JSON-Fixtures testbar.
 *
 * Aufgaben:
 *   1. Items nach Y-Koordinate zu Zeilen gruppieren, Zellen nach X sortieren.
 *   2. Wiederholte Kopfzeilen (Berichtstitel je Seite) und Fusszeilen
 *      («Gastronovi Office …», Seitenzahlen «3/10») entfernen — Seitenumbrüche
 *      dürfen weder Datenverlust noch Duplikate erzeugen.
 *   3. Berichtstyp INHALTSBASIERT erkennen (nie über den Dateinamen):
 *      Z-Bericht (Standard/Erweitert), Anzahl Personen, Umsatz pro Person,
 *      Durchschnittsbon.
 *   4. Zell-Normalisierung: «CHF 12'225.20» / «-434.60 CHF» → «12225.20» /
 *      «-434.60»; Klammerbeträge «(CHF 65.00)» = Originalbetrag VOR Rabatt.
 */

// ── Typen ─────────────────────────────────────────────────────────────────────

/** Ein Text-Item aus der PDF-Textebene (Ursprung: pdfjs getTextContent). */
export interface GnPdfTextItem {
  x: number;
  y: number;
  str: string;
}

/** Text-Items einer PDF-Seite. */
export interface GnPdfPageItems {
  pageNumber: number;
  items: GnPdfTextItem[];
}

/** Eine Zelle einer rekonstruierten Zeile (X-Position bleibt erhalten). */
export interface GnPdfCell {
  x: number;
  text: string;
}

/** Eine rekonstruierte Textzeile mit Seitenbezug. */
export interface GnPdfLine {
  pageNumber: number;
  y: number;
  cells: GnPdfCell[];
  /** Zelltexte mit «  » verbunden (nur für Diagnose/Erkennung). */
  text: string;
}

export type GnPdfReportKind =
  | 'zbericht'
  | 'anzahl_personen'
  | 'umsatz_pro_person'
  | 'durchschnittsbon'
  | 'unbekannt';

export interface GnPdfKindDetection {
  kind: GnPdfReportKind;
  /** Titelzeile (oberste Zeile der ersten Seite), falls vorhanden. */
  titleLine: string | null;
  /** Hinweis «(Erweiterte Version)» im Titel — die verbindliche Erkennung
   *  Standard/Erweitert bleibt inhaltsbasiert (Detailbericht-Sektionen). */
  isExtendedHint: boolean;
}

// ── Zeilenrekonstruktion ──────────────────────────────────────────────────────

/** Y-Toleranz: Items mit |Δy| ≤ Toleranz gehören zur selben Zeile. */
const Y_TOLERANCE = 3;

/**
 * Items einer Seite zu Zeilen gruppieren (Y absteigend = oben nach unten),
 * Zellen strikt nach X sortiert — nur so bleibt «(CHF 65.00)  CHF 52.00»
 * als (Original, Betrag)-Paar lesbar. Leere Items (nur Whitespace) entfallen.
 */
export function reconstructGnPdfLines(pages: GnPdfPageItems[]): GnPdfLine[] {
  const lines: GnPdfLine[] = [];
  for (const page of pages) {
    const items = page.items
      .filter(it => typeof it.str === 'string' && it.str.trim() !== '')
      .slice()
      .sort((a, b) => b.y - a.y || a.x - b.x);

    let current: { anchorY: number; items: GnPdfTextItem[] } | null = null;
    const flush = () => {
      if (!current || current.items.length === 0) return;
      const cells = current.items
        .slice()
        .sort((a, b) => a.x - b.x)
        .map(it => ({ x: it.x, text: it.str.replace(/\s+/g, ' ').trim() }));
      lines.push({
        pageNumber: page.pageNumber,
        y: current.anchorY,
        cells,
        text: cells.map(c => c.text).join('  '),
      });
    };

    for (const it of items) {
      if (current && Math.abs(it.y - current.anchorY) <= Y_TOLERANCE) {
        current.items.push(it);
      } else {
        flush();
        current = { anchorY: it.y, items: [it] };
      }
    }
    flush();
  }
  return lines;
}

// ── Kopf-/Fusszeilen entfernen ────────────────────────────────────────────────

const FOOTER_RE = /gastronovi\s+office/i;
const PAGE_NUMBER_RE = /^\d+\s*\/\s*\d+$/;

export interface GnPdfStripResult {
  lines: GnPdfLine[];
  /** Anzahl entfernter Kopf-/Fusszeilen (Diagnose). */
  removedCount: number;
  /** Wiederholter Seitenkopf (Berichtstitel), falls erkannt. */
  repeatedHeaderText: string | null;
}

/**
 * Entfernt Fusszeilen («Gastronovi Office …», reine Seitenzahlen) und den auf
 * jeder Seite wiederholten Berichtstitel (oberste Zeile). Der Titel wird nur
 * entfernt, wenn er auf mindestens zwei Seiten identisch als oberste Zeile
 * vorkommt ODER das Dokument einseitig ist und die oberste Zeile wie ein
 * Berichtstitel aussieht — Letzteres bleibt bewusst konservativ (nur exakte
 * Wiederholungen werden gestrippt, einseitige Titel bleiben stehen und landen
 * unschädlich in den Header-Metazeilen des Parsers).
 */
export function stripGnPdfHeaderFooters(lines: GnPdfLine[]): GnPdfStripResult {
  // Oberste Zeile je Seite ermitteln
  const topByPage = new Map<number, GnPdfLine>();
  for (const line of lines) {
    const cur = topByPage.get(line.pageNumber);
    if (!cur || line.y > cur.y) topByPage.set(line.pageNumber, line);
  }
  const topTextCounts = new Map<string, number>();
  for (const line of topByPage.values()) {
    topTextCounts.set(line.text, (topTextCounts.get(line.text) ?? 0) + 1);
  }
  let repeatedHeaderText: string | null = null;
  for (const [text, count] of topTextCounts) {
    if (count >= 2) { repeatedHeaderText = text; break; }
  }

  const kept: GnPdfLine[] = [];
  let removedCount = 0;
  for (const line of lines) {
    const isFooter =
      FOOTER_RE.test(line.text)
      || (line.cells.length === 1 && PAGE_NUMBER_RE.test(line.cells[0].text));
    const isRepeatedHeader =
      repeatedHeaderText !== null
      && line.text === repeatedHeaderText
      && topByPage.get(line.pageNumber) === line;
    if (isFooter || isRepeatedHeader) {
      removedCount++;
    } else {
      kept.push(line);
    }
  }
  return { lines: kept, removedCount, repeatedHeaderText };
}

// ── Berichtstyp-Erkennung (inhaltsbasiert) ────────────────────────────────────

/**
 * Erkennt den Berichtstyp aus dem INHALT der ersten Seite(n) — nie aus dem
 * Dateinamen. Z-Bericht gewinnt vor den KPI-Berichten, da deren Begriffe in
 * einem Z-Bericht nicht als Titel vorkommen.
 */
export function detectGnPdfReportKind(lines: GnPdfLine[]): GnPdfKindDetection {
  const firstPage = lines.filter(l => l.pageNumber === lines[0]?.pageNumber);
  const titleLine = firstPage.length > 0
    ? firstPage.reduce((top, l) => (l.y > top.y ? l : top), firstPage[0]).text
    : null;
  const scanText = lines.slice(0, 30).map(l => l.text).join('\n').toLowerCase();
  const isExtendedHint = /erweiterte\s+version/i.test(scanText);

  // Titelzeile hat Vorrang: ein «Anzahl Personen»-Bericht kann im Inhalt
  // z. B. eine «Durchschnitt»-Zeile enthalten — der Titel ist eindeutig.
  const pick = (text: string): GnPdfReportKind => {
    if (/z[\s-]?bericht/.test(text)) return 'zbericht';
    if (/umsatz\s+pro\s+person/.test(text)) return 'umsatz_pro_person';
    if (/anzahl\s+personen/.test(text)) return 'anzahl_personen';
    if (/durchschnittsbon/.test(text)) return 'durchschnittsbon';
    return 'unbekannt';
  };
  let kind = pick((titleLine ?? '').toLowerCase());
  if (kind === 'unbekannt') kind = pick(scanText);

  return { kind, titleLine, isExtendedHint };
}

// ── Zell-Normalisierung ───────────────────────────────────────────────────────

/** «(CHF 65.00)» oder «(65.00)» — Originalbetrag VOR Rabatt, KEIN Negativwert. */
const PAREN_MONEY_RE = /^\(\s*(?:CHF\s*)?(-?[\d''\u2019.,]+)\s*(?:CHF)?\s*\)$/i;
/** «CHF 12'225.20» / «CHF -818.60» */
const MONEY_PREFIX_RE = /^CHF\s*(-?[\d''\u2019.,]+)$/i;
/** «-434.60 CHF» / «12225.20 CHF» */
const MONEY_SUFFIX_RE = /^(-?[\d''\u2019.,]+)\s*CHF$/i;

export function isGnParenMoneyCell(text: string): boolean {
  return PAREN_MONEY_RE.test(text.trim());
}

/** Klammerbetrag → nackte Zahl (als String); null wenn kein Klammerbetrag. */
export function extractGnParenMoney(text: string): string | null {
  const m = text.trim().match(PAREN_MONEY_RE);
  return m ? m[1] : null;
}

/**
 * Entfernt CHF-Präfix/-Suffix aus reinen Betragszellen. Alle anderen Zellen
 * (Namen, Konten, Prozentwerte, Datumsangaben) bleiben unverändert.
 */
export function normalizeGnMoneyCell(text: string): string {
  const t = text.trim();
  const pre = t.match(MONEY_PREFIX_RE);
  if (pre) return pre[1];
  const suf = t.match(MONEY_SUFFIX_RE);
  if (suf) return suf[1];
  return t;
}
