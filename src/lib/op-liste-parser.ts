/**
 * op-liste-parser — reiner Parser für das PDF "Offene Posten mit Fälligkeiten
 * Kreditoren" (Sage-artig).
 * ─────────────────────────────────────────────────────────────────────────────
 * REIN: kein DOM, kein Supabase, kein pdfjs — Input sind bereits extrahierte,
 * positionierte Textzeilen (siehe `extractPdfTextLines` in pdf-import-engine.ts).
 * Dadurch in Node testbar (synthetische Fixtures).
 *
 * WICHTIG (Spaltenzuordnung): Der reine Zeilentext reicht NICHT, um Beträge den
 * 6 Fälligkeits-Buckets zuzuordnen (leere Zellen sind im Text unsichtbar).
 * Deshalb kalibriert der Parser die Spalten-X-Positionen aus der Kopfzeile
 * („Offen", „über 29 Tage", …) und ordnet Beträge per nächstgelegener Spalte zu.
 * Schlägt die Kalibrierung fehl, wird NUR der „Offen"-Betrag gelesen und die
 * Buckets bleiben null (Warnung statt Komplettabbruch).
 *
 * VALIDIERUNG: Es lag KEIN echtes Beispiel-PDF vor — der Parser ist gegen die
 * in der Spezifikation beschriebene Struktur und synthetische Fixtures gebaut.
 * Vor Verlass auf die Zahlen mit einer ECHTEN OP-Liste validieren.
 *
 * Konvention (wie adyen-csv-parser): debug + failureReason auf ALLEN Pfaden.
 */

import {
  BUCKET_KEYS,
  EMPTY_BUCKETS,
  type BucketKey,
  type OpBuckets,
  type OpItemParsed,
  type OpListeParseResult,
  type OpParseDebug,
  type OpSupplierParsed,
  type OpTotalsParsed,
} from '@/types/op-liste';

/** Positionierte PDF-Zeile (strukturgleich zu TextLine in pdf-import-engine). */
export interface OpPdfLine {
  text: string;
  items: { x: number; text: string }[];
}

// ── Zahlen / Daten (Schweizer Formate) ───────────────────────────────────────

/**
 * Parst einen Schweizer Betrag ("1'234.50", "1 234.50", "234.50-", "-12.00").
 * Bewusst NUR mit 2 Nachkommastellen — so werden OP-Nummern (reine Ganzzahlen)
 * nie als Betrag fehlinterpretiert.
 */
export function parseSwissAmount(raw: string): number | null {
  let v = raw.trim();
  if (!v) return null;
  let neg = false;
  if (v.endsWith('-')) { neg = true; v = v.slice(0, -1).trim(); }
  if (v.startsWith('-')) { neg = true; v = v.slice(1).trim(); }
  if (v.startsWith('(') && v.endsWith(')')) { neg = true; v = v.slice(1, -1).trim(); }
  v = v.replace(/['’\u2019\u00a0 ]/g, '');
  if (!/^\d+\.\d{2}$/.test(v)) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/;

/** dd.mm.yy(yy) → ISO yyyy-mm-dd (2-stelliges Jahr → 20xx). Null bei Unsinn. */
export function parseChDate(raw: string): string | null {
  const m = raw.trim().match(DATE_RE);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (m[3].length === 2) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}`;
}

// ── Spalten-Kalibrierung aus der Kopfzeile ───────────────────────────────────

type ColumnKey = 'open' | BucketKey;

interface ColumnAnchor { key: ColumnKey; x: number; }

/** Label-Muster je Spalte (flexible Whitespaces, ö/oe-tolerant). */
const COLUMN_LABELS: { key: ColumnKey; re: RegExp }[] = [
  { key: 'open', re: /^offen$/i },
  { key: 'overdue29Plus', re: /^(ü|ue|u)ber\s*29\s*Tage[n]?$/i },
  { key: 'overdueSince29', re: /^seit\s*29\s*Tagen$/i },
  { key: 'overdueSince14', re: /^seit\s*14\s*Tagen$/i },
  { key: 'dueIn15', re: /^in\s*15\s*Tagen$/i },
  { key: 'dueIn30', re: /^in\s*30\s*Tagen$/i },
  { key: 'dueAfter30', re: /^nach\s*30\s*Tagen$/i },
];

/** Erkennt die Spalten-Kopfzeile (muss „Offen" UND mind. ein Bucket-Label tragen). */
function looksLikeColumnHeader(text: string): boolean {
  return /\boffen\b/i.test(text) && /\btage[n]?\b/i.test(text);
}

/**
 * Kalibriert Spalten-X-Anker aus der Kopfzeile. PDF-Text-Items können
 * fragmentiert sein („über 29" + „Tage") — deshalb werden bis zu 4 benachbarte
 * Items zusammengesetzt geprüft. Anker-X = letztes Fragment (Spalten sind
 * rechtsbündig, das letzte Fragment liegt den Beträgen am nächsten).
 * Gültig nur mit „Offen" + mindestens 4 Buckets.
 */
export function calibrateColumns(line: OpPdfLine): ColumnAnchor[] | null {
  const anchors = new Map<ColumnKey, number>();
  const items = line.items;
  for (let i = 0; i < items.length; i++) {
    let concat = '';
    for (let j = i; j < Math.min(i + 4, items.length); j++) {
      concat = concat ? `${concat} ${items[j].text.trim()}` : items[j].text.trim();
      for (const { key, re } of COLUMN_LABELS) {
        if (!anchors.has(key) && re.test(concat.replace(/\s+/g, ' '))) {
          anchors.set(key, items[j].x);
        }
      }
    }
  }
  const bucketCount = BUCKET_KEYS.filter(k => anchors.has(k)).length;
  if (!anchors.has('open') || bucketCount < 4) return null;
  return Array.from(anchors.entries()).map(([key, x]) => ({ key, x }));
}

/** Ordnet Beträge einer Zeile per nächstgelegenem Spalten-Anker zu. */
function assignAmounts(
  line: OpPdfLine,
  anchors: ColumnAnchor[] | null,
): { open: number | null; buckets: OpBuckets; amounts: number[] } {
  const amounts: { x: number; value: number }[] = [];
  for (const it of line.items) {
    const v = parseSwissAmount(it.text);
    if (v !== null) amounts.push({ x: it.x, value: v });
  }
  const values = amounts.map(a => a.value);
  if (amounts.length === 0) return { open: null, buckets: { ...EMPTY_BUCKETS }, amounts: values };

  if (!anchors) {
    // Fallback ohne Kalibrierung: erster Betrag = „Offen", Buckets unbekannt.
    return { open: amounts[0].value, buckets: { ...EMPTY_BUCKETS }, amounts: values };
  }

  const assigned = new Map<ColumnKey, number>();
  for (const a of amounts) {
    let best: ColumnAnchor | null = null;
    let bestDist = Infinity;
    for (const anchor of anchors) {
      const d = Math.abs(a.x - anchor.x);
      if (d < bestDist) { bestDist = d; best = anchor; }
    }
    if (best && !assigned.has(best.key)) assigned.set(best.key, a.value);
  }
  const buckets: OpBuckets = { ...EMPTY_BUCKETS };
  for (const k of BUCKET_KEYS) {
    if (assigned.has(k)) buckets[k] = assigned.get(k)!;
  }
  let open = assigned.get('open') ?? null;
  if (open === null) {
    // Sicherheitsnetz: „Offen" nicht getroffen → erster Betrag.
    open = amounts[0].value;
  }
  return { open, buckets, amounts: values };
}

// ── Zeilen-Klassifikation ────────────────────────────────────────────────────

const RE_TITLE = /offene\s+posten/i;
const RE_KREDITOREN = /kreditor/i;
const RE_STICHTAG = /op[-\s]?stich(datum|tag)/i;
const RE_TOTAL = /^total\b/i;
const RE_GESAMT = /gesamt\s?-?\s?(saldo|total)/i;
const RE_ANZAHL_POSTEN = /anzahl\s+(posten|rechnungen)/i;
const RE_ANZAHL_KONTEN = /(angezeigte\s+)?personenkonten/i;
const RE_SEITE = /^seite\s+\d+/i;

function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? '';
}

function extractInt(text: string): number | null {
  const nums = text.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return parseInt(nums[nums.length - 1], 10);
}

// ── Hauptparser ──────────────────────────────────────────────────────────────

const TOLERANCE_CHF = 0.05;

export function parseOpListe(lines: OpPdfLine[]): OpListeParseResult {
  const warnings: string[] = [];
  const unparsedLines: string[] = [];
  const suppliers: OpSupplierParsed[] = [];

  const debugBase = (headerFound: boolean, anchors: ColumnAnchor[] | null): OpParseDebug => ({
    lineCount: lines.length,
    headerFound,
    calibratedColumns: anchors ? anchors.map(a => a.key) : [],
    supplierCount: suppliers.length,
    itemCount: suppliers.reduce((s, sup) => s + sup.items.length, 0),
    sampleLines: lines.slice(0, 30).map(l => l.text),
    unparsedLines: unparsedLines.slice(0, 30),
  });

  const fail = (reason: string, headerFound = false, anchors: ColumnAnchor[] | null = null): OpListeParseResult => ({
    success: false,
    failureReason: reason,
    snapshotDate: null,
    snapshotTime: null,
    suppliers: [],
    totals: { openAmount: null, itemCount: null, accountCount: null, buckets: { ...EMPTY_BUCKETS } },
    itemsSum: 0,
    warnings,
    debug: debugBase(headerFound, anchors),
  });

  if (lines.length === 0) return fail('PDF enthält keinen extrahierbaren Text (evtl. gescanntes Bild-PDF).');

  // 1) Dokumenttyp prüfen (Titel in den ersten ~15 Zeilen).
  const head = lines.slice(0, 15).map(l => l.text).join(' ');
  if (!RE_TITLE.test(head) || !RE_KREDITOREN.test(head)) {
    return fail(
      'Kein Kreditoren-OP-Listen-PDF: Titel „Offene Posten … Kreditoren" nicht gefunden. '
      + 'Bitte die Original-OP-Liste (Offene Posten mit Fälligkeiten Kreditoren) hochladen.',
    );
  }

  // 2) OP-Stichdatum suchen (Pflicht — dient als Speicherschlüssel).
  let snapshotDate: string | null = null;
  let snapshotTime: string | null = null;
  for (const l of lines) {
    if (!RE_STICHTAG.test(l.text)) continue;
    const dm = l.text.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})/);
    if (dm) snapshotDate = parseChDate(dm[1]);
    const tm = l.text.match(/(\d{1,2}:\d{2})/);
    if (tm) snapshotTime = tm[1];
    if (snapshotDate) break;
  }
  if (!snapshotDate) {
    return fail('OP-Stichdatum nicht gefunden (erwartet z. B. „OP-Stichdatum: 09.06.2026 / 11:57").');
  }

  // 3) Spalten-Kalibrierung aus der ersten Kopfzeile.
  let anchors: ColumnAnchor[] | null = null;
  let headerFound = false;
  for (const l of lines) {
    if (!looksLikeColumnHeader(l.text)) continue;
    headerFound = true;
    anchors = calibrateColumns(l);
    if (anchors) break;
  }
  if (!headerFound) {
    warnings.push('Spalten-Kopfzeile („Offen", „über 29 Tage", …) nicht gefunden — Fälligkeits-Buckets bleiben leer.');
  } else if (!anchors) {
    warnings.push('Spalten-Kopfzeile gefunden, aber Kalibrierung unvollständig — Fälligkeits-Buckets bleiben leer.');
  }

  // 4) Zeilen durchlaufen (State-Machine: Lieferantenblock → Posten → Total).
  const totals: OpTotalsParsed = { openAmount: null, itemCount: null, accountCount: null, buckets: { ...EMPTY_BUCKETS } };
  let current: OpSupplierParsed | null = null;
  /** true, sobald der letzte Block per Total-Zeile geschlossen wurde. */
  let lastBlockClosed = true;

  const closeCurrent = () => {
    if (!current) return;
    current.itemsSum = round2(current.items.reduce((s, it) => s + it.openAmount, 0));
    if (current.items.length > 0) {
      if (current.total !== null && Math.abs(current.total - current.itemsSum) > TOLERANCE_CHF) {
        warnings.push(
          `Lieferant „${current.name}": Einzelposten (${current.itemsSum.toFixed(2)}) ≠ Total lt. PDF (${current.total.toFixed(2)}).`,
        );
      }
      suppliers.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (RE_SEITE.test(text)) continue;
    if (RE_STICHTAG.test(text)) continue;
    if (RE_TITLE.test(text) && RE_KREDITOREN.test(text)) continue; // Titel-Wiederholung je Seite
    if (looksLikeColumnHeader(text) && line.items.some(it => COLUMN_LABELS.some(c => c.re.test(it.text.trim())))) {
      continue; // Kopfzeilen-Wiederholung je Seite
    }

    // Gesamt-Totale / Zähler (Fussbereich)
    if (RE_GESAMT.test(text)) {
      closeCurrent();
      const { open, buckets } = assignAmounts(line, anchors);
      if (open !== null) { totals.openAmount = open; totals.buckets = buckets; }
      lastBlockClosed = true;
      continue;
    }
    if (RE_ANZAHL_POSTEN.test(text)) { totals.itemCount = extractInt(text); continue; }
    if (RE_ANZAHL_KONTEN.test(text)) { totals.accountCount = extractInt(text); continue; }

    // Lieferanten-Total (schliesst den aktuellen Block)
    if (RE_TOTAL.test(text)) {
      if (!current) { unparsedLines.push(text); continue; }
      const { open } = assignAmounts(line, anchors);
      current.total = open;
      const { buckets } = assignAmounts(line, anchors);
      current.buckets = buckets;
      closeCurrent();
      lastBlockClosed = true;
      continue;
    }

    // Einzelposten (beginnt mit OP-Datum) — nur innerhalb eines Lieferantenblocks.
    const tok = firstToken(text);
    const isDateLed = DATE_RE.test(tok);
    const { open, buckets, amounts } = assignAmounts(line, anchors);

    if (isDateLed && amounts.length > 0) {
      if (!current) {
        unparsedLines.push(text);
        continue;
      }
      const nonAmountTokens: string[] = [];
      for (const it of line.items) {
        if (parseSwissAmount(it.text) !== null) continue;
        nonAmountTokens.push(...it.text.trim().split(/\s+/));
      }
      // tokens[0] = Datum, tokens[1] = OP-Nr, Rest = Text/Rechnungsnummer
      const opDate = parseChDate(nonAmountTokens[0] ?? '');
      const opNumber = nonAmountTokens.length > 1 ? nonAmountTokens[1] : null;
      const invoiceText = nonAmountTokens.length > 2 ? nonAmountTokens.slice(2).join(' ') : null;
      const item: OpItemParsed = {
        opDate,
        opNumber,
        invoiceText,
        openAmount: open ?? 0,
        buckets,
      };
      if (open === null) warnings.push(`Posten ohne erkennbaren „Offen"-Betrag: „${text.slice(0, 60)}"`);
      current.items.push(item);
      lastBlockClosed = false;
      continue;
    }

    // Textzeile ohne Beträge:
    if (amounts.length === 0) {
      if (current && current.items.length === 0) {
        // Mehrzeiliger Lieferantenname
        current.name = `${current.name} ${text}`.trim();
      } else if (current && current.items.length > 0 && !lastBlockClosed) {
        // Umbruchzeile eines Postentexts → an letzten Posten anhängen
        const last = current.items[current.items.length - 1];
        last.invoiceText = last.invoiceText ? `${last.invoiceText} ${text}` : text;
      } else {
        // Neuer Lieferantenblock
        closeCurrent();
        current = { name: text, items: [], total: null, itemsSum: 0, buckets: { ...EMPTY_BUCKETS } };
        lastBlockClosed = false;
      }
      continue;
    }

    // Zeile mit Beträgen, aber ohne Datum und ohne Total-Präfix → nicht zuordenbar.
    unparsedLines.push(text);
  }
  closeCurrent();

  const itemsSum = round2(suppliers.reduce((s, sup) => s + sup.itemsSum, 0));

  if (suppliers.length === 0) {
    return fail(
      'Keine Lieferantenblöcke mit offenen Posten erkannt. '
      + 'Struktur des PDFs weicht vom erwarteten Aufbau ab (siehe debug.sampleLines).',
      headerFound, anchors,
    );
  }

  // 5) Plausibilisierung: Einzelposten vs. Gesamtsaldo lt. PDF.
  if (totals.openAmount !== null && Math.abs(totals.openAmount - itemsSum) > TOLERANCE_CHF) {
    warnings.push(
      `Summe der Einzelposten (${itemsSum.toFixed(2)}) weicht vom Gesamtsaldo lt. PDF (${totals.openAmount.toFixed(2)}) ab.`,
    );
  }
  if (totals.openAmount === null) {
    warnings.push('Gesamtsaldo im PDF nicht gefunden — Plausibilisierung nur eingeschränkt möglich.');
  }
  const parsedItemCount = suppliers.reduce((s, sup) => s + sup.items.length, 0);
  if (totals.itemCount !== null && totals.itemCount !== parsedItemCount) {
    warnings.push(`Anzahl Posten lt. PDF (${totals.itemCount}) ≠ erkannte Posten (${parsedItemCount}).`);
  }
  if (totals.accountCount !== null && totals.accountCount !== suppliers.length) {
    warnings.push(`Personenkonten lt. PDF (${totals.accountCount}) ≠ erkannte Lieferanten (${suppliers.length}).`);
  }

  return {
    success: true,
    snapshotDate,
    snapshotTime,
    suppliers,
    totals,
    itemsSum,
    warnings,
    debug: debugBase(headerFound, anchors),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
