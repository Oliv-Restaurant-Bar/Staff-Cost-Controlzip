/**
 * Warenrechnungen — automatische PDF-Erkennung.
 *
 * Pure Parsing-/Matching-Logik (node-testbar, KEINE supabase/pdfjs-Imports auf
 * Top-Level). Die eigentliche Text-Extraktion (pdfjs) und der OCR-Fallback
 * (tesseract.js) laufen über dynamische Imports in `extractPdfInvoiceText`.
 *
 * Ablauf: PDF hochladen → Text auslesen (Text-PDF direkt, Scan per OCR) →
 * `parseInvoiceText` erkennt Datum/Betrag/MWST/Referenz → `matchSupplier`
 * ordnet den Lieferanten über Name/Alias zu (normalisiert wie beim
 * MIRUS-Namens-Matching). Gespeichert wird IMMER erst nach Bestätigung durch
 * den Nutzer (Vorschau im Formular, unsichere Felder markiert).
 */

// ─── Normalisierung (gleiche Regeln wie MIRUS-Namens-Matching) ───────────────

/** Kleinbuchstaben, Umlaute expandiert, Diakritika/Punktuation raus. */
export function normalizeSupplierKey(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Reihenfolge-unabhängige Token-Menge («Café Blaser» ↔ «Blaser Café»). */
function tokenSet(raw: string): string {
  return normalizeSupplierKey(raw).split(/\s+/).filter(Boolean).sort().join(' ');
}

// Rechtsform-Zusätze, die beim Matching nichts beitragen («Prodega AG» = «Prodega»).
const STOP_TOKENS = new Set(['ag', 'gmbh', 'sa', 'sarl', 'srl', 'co', 'cie', 'kg', 'ltd', 'inc']);

function coreTokens(raw: string): string[] {
  return normalizeSupplierKey(raw).split(/\s+/).filter(t => t && !STOP_TOKENS.has(t));
}

// ─── Lieferanten-Aliasse ─────────────────────────────────────────────────────

/** Alias-Store: normalisierte erkannte Schreibweise → Lieferanten-Name. */
export type SupplierAliasMap = Record<string, string>;

/**
 * Lieferanten-Matching über Namen/Alias.
 * Reihenfolge: gespeicherter Alias → exakter normalisierter Name →
 * Token-Menge (Reihenfolge egal, Rechtsform ignoriert) → eindeutiges
 * Enthaltensein (alle Kern-Tokens des Lieferanten kommen im erkannten Text
 * vor). Mehrdeutig → kein Auto-Match (null, manuell zuordnen).
 */
export function matchSupplier(
  erkannt: string,
  supplierNames: string[],
  aliases: SupplierAliasMap,
): { name: string; via: 'alias' | 'exakt' | 'tokens' | 'enthalten' } | null {
  const key = normalizeSupplierKey(erkannt);
  if (!key) return null;

  const aliasHit = aliases[key];
  if (aliasHit && supplierNames.includes(aliasHit)) return { name: aliasHit, via: 'alias' };

  const exakt = supplierNames.filter(n => normalizeSupplierKey(n) === key);
  if (exakt.length === 1) return { name: exakt[0], via: 'exakt' };

  const erkanntTokens = tokenSet(erkannt);
  const tokens = supplierNames.filter(n => tokenSet(n) === erkanntTokens);
  if (tokens.length === 1) return { name: tokens[0], via: 'tokens' };

  // Kern-Tokens des Lieferanten alle im erkannten Text enthalten (z.B.
  // «Transgourmet Schweiz AG, Basel» → Lieferant «Transgourmet»).
  const erkanntSet = new Set(coreTokens(erkannt));
  const enthalten = supplierNames.filter(n => {
    const ct = coreTokens(n);
    return ct.length > 0 && ct.every(t => erkanntSet.has(t));
  });
  if (enthalten.length === 1) return { name: enthalten[0], via: 'enthalten' };

  return null;
}

/**
 * Lieferanten direkt im PDF-VOLLTEXT suchen (wenn keine einzelne
 * Absender-Zeile isolierbar ist): eindeutiger Treffer, dessen Kern-Tokens
 * alle im Text vorkommen. Der längste (spezifischste) Treffer gewinnt;
 * bleibt es mehrdeutig → null.
 */
export function findSupplierInText(
  text: string,
  supplierNames: string[],
  aliases: SupplierAliasMap,
  /**
   * Optionale Kanonisierung (Alias-Gruppen-Resolver): Gleichstand zweier
   * Treffer, die auf DENSELBEN kanonischen Lieferanten auflösen («Terravigna»
   * und Gruppen-Alias «Terravigna AG» → beide Kern-Token «terravigna»), ist
   * KEINE Mehrdeutigkeit — ohne diesen Parameter blieben solche Buchungstexte
   * fälschlich unzugeordnet.
   */
  canonicalize?: (name: string) => string,
): string | null {
  const norm = ' ' + normalizeSupplierKey(text) + ' ';
  const hits: { name: string; len: number }[] = [];
  const seen = new Set<string>();
  for (const [aliasKey, supplierName] of Object.entries(aliases)) {
    if (aliasKey && supplierNames.includes(supplierName) && norm.includes(' ' + aliasKey + ' ')) {
      if (!seen.has(supplierName)) { hits.push({ name: supplierName, len: aliasKey.length }); seen.add(supplierName); }
    }
  }
  for (const n of supplierNames) {
    const ct = coreTokens(n);
    if (ct.length === 0) continue;
    // Ein-Token-Namen nur ab 4 Zeichen matchen — sehr kurze/generische Namen
    // («La», «Co») erzeugen sonst False-Positives im Volltext/Buchungstext.
    if (ct.length === 1 && ct[0].length < 4) continue;
    if (ct.every(t => norm.includes(' ' + t + ' ')) && !seen.has(n)) {
      hits.push({ name: n, len: ct.join(' ').length });
      seen.add(n);
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.len - a.len);
  // Eindeutig, wenn der beste Treffer klar länger ist ODER es nur einen gibt.
  if (hits.length === 1 || hits[0].len > hits[1].len) return hits[0].name;
  // Gleichstand: lösen ALLE gleichlangen Top-Treffer auf denselben kanonischen
  // Namen auf (Alias-Gruppe), ist es faktisch EIN Lieferant → bester Treffer.
  if (canonicalize) {
    const top = hits.filter(h => h.len === hits[0].len);
    const canons = new Set(top.map(h => canonicalize(h.name)));
    if (canons.size === 1) return hits[0].name;
  }
  return null;
}

// ─── Text-Parsing (Datum, Betrag, MWST, Referenz) ────────────────────────────

export interface ErkannteRechnung {
  /** Lieferdatum/Rechnungsdatum als YYYY-MM-DD (null = nicht erkannt). */
  date: string | null;
  dateSicher: boolean;
  /** Bruttobetrag (Total inkl. MWST), null = nicht erkannt. */
  amount: number | null;
  amountSicher: boolean;
  /** MWST-Satz in % (8.1 / 2.6 / 3.8 …), null = nicht erkannt. */
  vatRate: number | null;
  /** Rechnungs-/Referenznummer. */
  reference: string | null;
}

const CH_VAT_RATES = [8.1, 2.6, 3.8, 7.7, 2.5];

function parseChf(raw: string): number | null {
  // «1'234.50», «1’234,50», «1 234.50» → 1234.50
  const cleaned = raw.replace(/[’'\u00A0\s]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toIsoDate(d: number, m: number, y: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2}(?:\d{2})?)/g;
const AMOUNT_RE = /(\d{1,3}(?:[’'\u00A0\s]?\d{3})*[.,]\d{2})(?!\d)/g;

/**
 * Erkennt aus dem PDF-Volltext: Datum, Brutto-Total, MWST-Satz, Referenz.
 * Heuristik mit Label-Vorrang («Rechnungsdatum», «Total», «Rechnungs-Nr.»);
 * ohne Label wird konservativ geraten und das Feld als UNSICHER markiert.
 */
export function parseInvoiceText(text: string): ErkannteRechnung {
  const t = text.replace(/\u00A0/g, ' ');

  // ── Datum: Label-Nähe gewinnt (Lieferdatum > Rechnungsdatum > Datum) ──
  let date: string | null = null;
  let dateSicher = false;
  for (const label of [/liefer(?:ungs)?datum/i, /rechnungs?datum|belegdatum|fakturadatum/i, /\bdatum\b/i]) {
    const li = t.search(label);
    if (li < 0) continue;
    const nach = t.slice(li, li + 120);
    const m = new RegExp(DATE_RE.source).exec(nach);
    if (m) {
      const iso = toIsoDate(+m[1], +m[2], +m[3]);
      if (iso) { date = iso; dateSicher = true; break; }
    }
  }
  if (!date) {
    // Fallback: erstes plausibles Datum im Dokument (unsicher).
    for (const m of t.matchAll(DATE_RE)) {
      const iso = toIsoDate(+m[1], +m[2], +m[3]);
      if (iso) { date = iso; break; }
    }
  }

  // ── Betrag: Label-Vorrang, sonst grösster Betrag (unsicher) ──
  let amount: number | null = null;
  let amountSicher = false;
  const totalLabels = /(?:total(?:betrag)?|gesamt(?:betrag|total)?|rechnungs(?:betrag|total)|endbetrag|zu\s+(?:zahlen|bezahlen)|brutto(?:betrag)?)\b/gi;
  const kandidaten: number[] = [];
  for (const lm of t.matchAll(totalLabels)) {
    const nach = t.slice(lm.index!, lm.index! + 100);
    for (const m of nach.matchAll(new RegExp(AMOUNT_RE.source, 'g'))) {
      const n = parseChf(m[1]);
      if (n !== null) { kandidaten.push(n); break; }
    }
  }
  if (kandidaten.length > 0) {
    amount = Math.max(...kandidaten); // Total inkl. MWST ist der grösste Label-Betrag
    amountSicher = true;
  } else {
    let max = 0;
    for (const m of t.matchAll(AMOUNT_RE)) {
      const n = parseChf(m[1]);
      if (n !== null && n > max && n < 1_000_000) max = n;
    }
    if (max > 0) amount = max;
  }

  // ── MWST-Satz ──
  let vatRate: number | null = null;
  for (const m of t.matchAll(/(\d{1,2}[.,]\d)\s?%/g)) {
    const r = Number(m[1].replace(',', '.'));
    if (CH_VAT_RATES.includes(r)) { vatRate = r; break; }
  }

  // ── Referenz (Rechnungs-Nr.) ──
  let reference: string | null = null;
  const refM = t.match(/(?:rechnungs?|beleg|faktura|dokument)[\s-]*(?:nr|nummer|no)\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9\-/._]{2,24})/i);
  if (refM) reference = refM[1];

  return { date, dateSicher, amount, amountSicher, vatRate, reference };
}

// ─── PDF-Text-Extraktion (pdfjs) + OCR-Fallback (tesseract.js) ───────────────

export interface PdfTextErgebnis {
  text: string;
  /** true = Text-PDF; false = per OCR gelesen (Scan). */
  textLayer: boolean;
  /** OCR versucht, aber fehlgeschlagen/nicht verfügbar. */
  ocrFehler?: string;
}

/**
 * Liest den Text eines PDFs aus: Text-PDF direkt via pdfjs; hat das PDF
 * (fast) keinen Text-Layer (Scan), wird die erste Seite gerendert und per
 * tesseract.js (OCR, deutsch) gelesen. OCR lädt lazy — schlägt es fehl,
 * kommt der bisherige Text zurück und `ocrFehler` ist gesetzt (die UI fällt
 * dann nahtlos auf die manuelle Erfassung zurück).
 */
export async function extractPdfInvoiceText(file: File): Promise<PdfTextErgebnis> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  let text = '';
  const maxPages = Math.min(pdf.numPages, 3); // Rechnungskopf steht vorne
  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => ((it as { str?: string }).str ?? '')).join(' ') + '\n';
  }
  if (text.replace(/\s/g, '').length >= 40) {
    return { text, textLayer: true };
  }

  // ── OCR-Fallback (gescanntes PDF) ──
  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas nicht verfügbar');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const { default: Tesseract } = await import('tesseract.js');
    const result = await Tesseract.recognize(canvas, 'deu');
    return { text: result.data.text ?? '', textLayer: false };
  } catch (err) {
    return {
      text,
      textLayer: false,
      ocrFehler: err instanceof Error ? err.message : String(err),
    };
  }
}
