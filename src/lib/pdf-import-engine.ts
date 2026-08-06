/**
 * PDF-Import-Engine – Kontenblatt-PDF einlesen und Buchungszeilen extrahieren
 * ===========================================================================
 *
 * Unterstützte Quellen:
 *   - Banana Accounting (Kontenblatt-Export)
 *   - AbaNinja / Abacus (Buchungsjournal als PDF)
 *   - Bexio Kontenblatt
 *   - Sage 50 Kontoauszug
 *   - Generische Buchungs-PDFs mit 4-stelliger Kontonummer am Zeilenanfang
 *
 * Algorithmus:
 *   1. PDF → Text-Items mit Position (x, y) via pdfjs-dist
 *   2. Items nach Y-Koordinate gruppieren → Zeilen rekonstruieren
 *   3. Zeilen nach Muster scannen:
 *      Kontonummer (3–5 Stellen) + Bezeichnung + Betrag(Saldo)
 *   4. Monat/Jahr aus Kopfzeilen/Datum-Mustern erkennen
 *   5. ParsedCSVRow[] zurückgeben → gleiche Matching-Pipeline wie CSV
 *
 * Wichtig:
 *   Die Rückgabe ist kompatibel mit ParsedCSVRow aus csv-import-engine.ts.
 *   Dadurch wird dieselbe Matching- und Speicher-Logik wiederverwendet.
 */

import * as pdfjsLib from 'pdfjs-dist';
import * as XLSX from 'xlsx';
import type { ParsedCSVRow } from './csv-import-engine';
import { parseAmount } from './csv-import-engine';
import type { SageJournalEntry } from '@/types/reporting';
import { ensurePdfWorkerConfigured } from './pdf-worker-setup';

// ─── Worker-Konfiguration (zentral in pdf-worker-setup.ts) ────────────────────
ensurePdfWorkerConfigured();

// ─── Typen ────────────────────────────────────────────────────────────────────

interface TextLine {
  y: number;          // Y-Koordinate (gerundet für Gruppierung)
  items: { x: number; text: string }[];
  text: string;       // Zusammengefügter Zeilentext
}

export interface PDFParseResult {
  rows: ParsedCSVRow[];
  detectedYear?: number;
  detectedMonth?: number;
  pageCount: number;
  rawLines: string[];    // Alle extrahierten Textzeilen (für Debug)
  warnings: string[];
  /** Sage Kontoblatt: Buchungszeilen (Lieferanten-Journal für den FIBU-Abgleich). */
  journalEntries?: SageJournalEntry[];
  /** Sage Kontoblatt: Firmenname aus dem Kopf (z. B. «Oliv Gastro AG»). */
  detectedCompany?: string;
  /** Aus dem Firmennamen abgeleiteter Mandant (Mandanten-Check beim Import). */
  detectedTenant?: 'oliv' | 'beaulieu';
  /**
   * Mehrmonats-Kontoblatt (Kopf-Zeitraum über Monatsgrenzen, gleiches Jahr):
   * Buchungszeilen nach Buchungsmonat gruppiert — Konten-Netto (Soll−Haben)
   * und Journal pro Monat. Nur gesetzt, wenn der Zeitraum >1 Monat umfasst
   * UND Buchungszeilen vorhanden sind.
   */
  monthly?: {
    year: number;
    rowsByMonth: Map<number, ParsedCSVRow[]>;
    journalByMonth: Map<number, SageJournalEntry[]>;
  };
}

// ─── Monats-Erkennung ─────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  januar: 1, january: 1, jan: 1,
  februar: 2, february: 2, feb: 2,
  märz: 3, maerz: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, oct: 10, okt: 10,
  november: 11, nov: 11,
  dezember: 12, december: 12, dec: 12, dez: 12,
};

/**
 * Versucht, Monat und Jahr aus einem Textblock zu extrahieren.
 * Scannt alle Zeilen und gibt das erste zuverlässige Ergebnis zurück.
 */
export function detectMonthYear(lines: string[]): {
  month?: number;
  year?: number;
} {
  const fullText = lines.slice(0, 30).join(' ').toLowerCase();

  // Muster 0: Sage-Format "vom: 01.01.26 bis 31.01.26" → Startmonat/-jahr
  const sageVomMatch = fullText.match(/vom\s*:\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})/i);
  if (sageVomMatch) {
    const yy = parseInt(sageVomMatch[3]);
    return {
      month: parseInt(sageVomMatch[2]),
      year:  yy < 100 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy,
    };
  }

  // Muster 1: "Periode: 01.01.2026 – 31.01.2026" → Monat aus Startdatum
  const periodeMatch = fullText.match(
    /periode[:\s]+(\d{1,2})\.(\d{1,2})\.(\d{4})/i,
  );
  if (periodeMatch) {
    return { month: parseInt(periodeMatch[2]), year: parseInt(periodeMatch[3]) };
  }

  // Muster 2: "01.2026" oder "01/2026"
  const mmYearMatch = fullText.match(/\b(0?[1-9]|1[0-2])[./](20\d{2})\b/);
  if (mmYearMatch) {
    return { month: parseInt(mmYearMatch[1]), year: parseInt(mmYearMatch[2]) };
  }

  // Muster 3: "Januar 2026" / "January 2026" / "Jan. 2026"
  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    const re = new RegExp(`\\b${name}\\.?\\s+(20\\d{2})\\b`, 'i');
    const m = fullText.match(re);
    if (m) return { month: num, year: parseInt(m[1]) };
  }

  // Muster 4: Nur Jahr erkennen "2026"
  const yearMatch = fullText.match(/\b(20\d{2})\b/);
  if (yearMatch) return { year: parseInt(yearMatch[1]) };

  return {};
}

// ─── Zeilen-Rekonstruktion aus PDF-Text-Items ─────────────────────────────────

/**
 * Gruppiert pdfjs TextItems nach Y-Koordinate (Toleranz: 3 Punkte),
 * sortiert sie horizontal und gibt rekonstruierte Textzeilen zurück.
 */
async function extractLinesFromPage(
  page: pdfjsLib.PDFPageProxy,
): Promise<TextLine[]> {
  const textContent = await page.getTextContent();

  // Map: gerundete Y → Einzel-Items
  const lineMap = new Map<number, { x: number; text: string }[]>();

  for (const rawItem of textContent.items) {
    if (!('str' in rawItem)) continue;
    const item = rawItem as pdfjsLib.TextItem;
    if (!item.str.trim()) continue;

    const x    = item.transform[4];
    const yRaw = item.transform[5];

    // Suche eine bereits vorhandene Zeile in ±3-Punkt-Nähe
    let matchedY: number | null = null;
    for (const existY of lineMap.keys()) {
      if (Math.abs(existY - yRaw) <= 3) {
        matchedY = existY;
        break;
      }
    }
    const key = matchedY ?? Math.round(yRaw);
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key)!.push({ x, text: item.str });
  }

  // Y absteigend sortieren (PDF-Koordinatensystem: Y wächst nach oben)
  const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);

  return sortedYs
    .map(y => {
      const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      const text  = items.map(i => i.text).join(' ').replace(/\s{2,}/g, '  ').trim();
      return { y, items, text };
    })
    .filter(l => l.text.length > 0);
}

// ─── Generische Text-Extraktion (für externe Parser, z. B. OP-Liste) ─────────

/** Positionierte Zeile für externe reine Parser (x-Koordinaten je Item). */
export interface PositionedPdfLine {
  text: string;
  items: { x: number; text: string }[];
}

export interface PdfTextLinesResult {
  lines: PositionedPdfLine[];
  pageCount: number;
  warnings: string[];
}

/**
 * Extrahiert ALLE Textzeilen eines PDFs mit X-Positionen der Einzel-Items
 * (Zeilen-Rekonstruktion wie extractLinesFromPage, Seiten in Lesereihenfolge).
 * Für Parser, die Spalten über X-Koordinaten zuordnen müssen (z. B.
 * Fälligkeits-Buckets der Kreditoren-OP-Liste, wo leere Zellen im reinen
 * Zeilentext unsichtbar sind).
 */
export async function extractPdfTextLines(buffer: ArrayBuffer): Promise<PdfTextLinesResult> {
  const warnings: string[] = [];
  const lines: PositionedPdfLine[] = [];

  let pdfDoc: pdfjsLib.PDFDocumentProxy;
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch (e) {
    warnings.push(`PDF konnte nicht geöffnet werden: ${String(e)}`);
    return { lines, pageCount: 0, warnings };
  }

  const pageCount = pdfDoc.numPages;
  for (let p = 1; p <= pageCount; p++) {
    try {
      const page = await pdfDoc.getPage(p);
      const pageLines = await extractLinesFromPage(page);
      for (const l of pageLines) lines.push({ text: l.text, items: l.items });
    } catch (e) {
      warnings.push(`Seite ${p} konnte nicht gelesen werden: ${String(e)}`);
    }
  }
  return { lines, pageCount, warnings };
}

// ─── Sage Kontoblatt-Parser ───────────────────────────────────────────────────

/**
 * Erkennt ob es sich um ein Sage Kontoblatt handelt.
 * Typische Sage-Kopfzeilen: "Kontoblatt", "vom: DD.MM.YY bis DD.MM.YY"
 */
function isSageKontoblatt(rawLines: string[]): boolean {
  const head = rawLines.slice(0, 20).join(' ').toLowerCase();
  return head.includes('kontoblatt') && (head.includes('vom:') || head.includes(' bis '));
}

/**
 * Kopf-Metadaten des Sage-Kontoblatts: Firmenname («Kontoblatt <Firma> Seite: N»)
 * und Zeitraum («vom: TT.MM.JJ bis TT.MM.JJ») → Mandant + Monat/Jahr.
 * Firmen-Zuordnung: «Oliv Gastro AG» → oliv, «Restaurant Beaulieu AG» → beaulieu.
 */
export function parseSageHeaderMeta(rawLines: string[]): {
  company?: string;
  tenant?: 'oliv' | 'beaulieu';
  month?: number;
  year?: number;
  /** Ende des Kopf-Zeitraums («bis TT.MM.JJ») — für Mehrmonats-/Jahresdateien. */
  monthTo?: number;
  yearTo?: number;
} {
  const head = rawLines.slice(0, 12);
  let company: string | undefined;
  let month: number | undefined;
  let year: number | undefined;
  let monthTo: number | undefined;
  let yearTo: number | undefined;

  for (const line of head) {
    if (!company) {
      const m = /kontoblatt\s+(.+?)\s+seite\s*:?/i.exec(line);
      if (m) company = m[1].trim();
    }
    if (month === undefined) {
      // «vom: 01.03.26 bis 31.03.26» (2- oder 4-stelliges Jahr)
      const p = /vom:?\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+bis\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4})/i.exec(line);
      if (p) {
        month = Number(p[2]);
        const y = Number(p[3]);
        year = y < 100 ? 2000 + y : y;
        monthTo = Number(p[5]);
        const yt = Number(p[6]);
        yearTo = yt < 100 ? 2000 + yt : yt;
      }
    }
  }

  let tenant: 'oliv' | 'beaulieu' | undefined;
  if (company) {
    if (/beaulieu/i.test(company)) tenant = 'beaulieu';
    else if (/oliv/i.test(company)) tenant = 'oliv';
  }
  return { company, tenant, month, year, monthTo, yearTo };
}

/**
 * State-Machine-Parser für Sage Kontoblatt-PDFs.
 *
 * Format:
 *   4020            Wein Warenaufwand          ← Konto-Header (kein CHF-Betrag)
 *                   Saldo Vortrag  0.00         ← ignorieren
 *   20.01.2026  54  Paul Ullrich AG  2001  1'324.01  1'324.01  ← Buchungszeile (ignoriert)
 *                   Total Soll      14'577.94   ← Debit-Summe des Monats
 *                   Total Haben     0.00        14'577.94  ← letzter Betrag = Monatssaldo
 *
 * Monatswert = letzter Betrag auf der "Total Haben"-Zeile
 *   = Total Soll − Total Haben (enthält den Netto-Monatsumsatz)
 *   NICHT den Saldo-Vortrag, NICHT den Endsaldo über alle Perioden
 *
 * Mehrseitige Konten (z.B. 4060 Küche über 2+ Seiten):
 *   - currentAccount wird nach "Total Haben" NICHT zurückgesetzt
 *   - Wenn dasselbe Konto erneut auftaucht (Seite 2), wird es als Fortsetzung erkannt
 *   - Jedes neue "Total Haben" für dasselbe Konto überschreibt mit dem kumulativen Wert
 *   - Damit enthält der letzte Eintrag immer den korrekten Monatswert
 *
 * Bug-Fix für Seiten-Nummern in Konto-Headers:
 *   Alte Logik: findLastAmount("4060 Küche Warenaufwand  Seite 2") → "2" → hasAmount=true → Header nicht erkannt
 *   Neue Logik: hasCHFAmount("Küche Warenaufwand  Seite 2") → false → Header korrekt erkannt
 */
/**
 * Sage Kontoblatt Parser (stabilisierte Version)
 *
 * ROBUSTE MONATSWERT-FORMEL:
 *   monatswert = finalSaldo − saldoVortrag
 *
 * Warum robuster als Total Soll − Total Haben:
 *   - Im PDF-Text kann die "0.00"-Spalte auf der Total-Haben-Zeile fehlen
 *     (Y-Koordinaten-Split zwischen Label und Betrag), wodurch
 *     allAmts[0] fälschlicherweise den kumulativen Saldo statt den Haben-Wert liest.
 *   - finalSaldo (= letzter/rechtester Wert auf Total-Haben-Zeile) und
 *     saldoVortrag (= erster Betrag nach dem Konto-Header) sind immer eindeutig.
 *   - Formel gilt auch bei Konten mit Haben > Soll (z.B. Retouren-Überhang).
 *   - Bei mehrseitigen Konten: saldoVortrag wird nur EINMAL gesetzt (Seite 1);
 *     Seitenanfang-Wiederholungen werden ignoriert.
 *
 * LOOKAHEAD bei Total-Zeilen:
 *   Falls Label (z.B. "Total Soll") und Betrag durch Y-Toleranz-Grenze getrennt
 *   landen, wird die Folgezeile in die Suche einbezogen.
 *
 * FALLBACK:
 *   Falls saldoVortrag oder finalSaldo fehlen → totalSoll − totalHaben (alte Formel)
 */
export function parseSageKontoblatt(lines: TextLine[]): {
  rows: ParsedCSVRow[];
  journalEntries: SageJournalEntry[];
  warnings: string[];
} {
  interface AccountEntry {
    name: string;
    saldoVortrag: number | null;  // Eröffnungssaldo (nur erstes Auftreten, Seite-2-Wiederholung ignorieren)
    totalSoll: number;
    totalHaben: number;
    finalSaldo: number | null;    // Letzter Betrag auf "Total Haben"-Zeile = kumulativer Endsaldo
    saldo: number;                // Monatswert = finalSaldo − saldoVortrag (oder Fallback totalSoll − totalHaben)
    usedFallback: boolean;        // true wenn Fallback-Formel verwendet wurde (für Debug-Log)
    lineIndex: number;
    raw: string;
    pageCount: number;
  }

  /** Gibt kombinierten Text dieser Zeile + ggf. nächster Zeile zurück (Lookahead bei Betrag fehlt). */
  function textWithLookahead(idx: number): string {
    const base = lines[idx].text;
    if (findLastAmount(base) !== null) return base;          // Betrag schon auf dieser Zeile → OK
    const next = idx + 1 < lines.length ? lines[idx + 1].text.trim() : '';
    return next ? `${base} ${next}` : base;
  }

  const accountData = new Map<string, AccountEntry>();
  const journalEntries: SageJournalEntry[] = [];
  const parserWarnings: string[] = [];
  let currentAccount: { number: string; name: string } | null = null;
  /** Laufender (signierter) Saldo je Konto — klassifiziert Soll vs. Haben über die Saldo-Bewegung. */
  const runningSaldo = new Map<string, number>();
  /** Signierter Saldo-Vortrag je Konto (für die Plausibilitäts-Gegenrechnung). */
  const vortragSigned = new Map<string, number>();
  /** Letzte Buchungszeile (für Referenz-/Rechnungsnummern auf der Folgezeile). */
  let lastBooking: SageJournalEntry | null = null;

  /** Signierter Betrag: «1'234.56-» (Sage-Trailing-Minus) → −1234.56. */
  function parseSigned(raw: string): number | null {
    const neg = /-\s*$/.test(raw);
    const v = parseAmount(raw.replace(/-\s*$/, ''));
    if (v === null) return null;
    return neg ? -Math.abs(v) : v;
  }

  /**
   * Buchungszeile: «TT.MM.JJJJ Blg Text… G-Konto Betrag Saldo».
   * Im PDF-Text steht nur EINE Betragsspalte (Soll ODER Haben) plus Saldo;
   * die Zuordnung erfolgt über die Saldo-Bewegung (steigt → Soll, fällt → Haben).
   */
  function tryParseBookingLine(line: string): boolean {
    if (!currentAccount) return false;
    const m = /^(\d{2}\.\d{2}\.\d{4})\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (!m) return false;
    const [, date, blg, rest] = m;
    const amts = findAllAmounts(rest);
    if (amts.length < 2) return false;              // braucht Betrag + Saldo
    const saldoRaw  = amts[amts.length - 1];
    const betragRaw = amts[amts.length - 2];
    const saldo  = parseSigned(saldoRaw);
    const betrag = parseSigned(betragRaw);
    if (saldo === null || betrag === null) return false;

    // Text = alles vor dem Betrag; G-Konto = letztes Token davor (Zahl oder «div»)
    const betragPos = rest.lastIndexOf(betragRaw);
    let textPart = rest.slice(0, betragPos).trim();
    textPart = textPart.replace(/\s+(\d{3,5}|div\.?)$/i, '').trim();
    if (!textPart) return false;

    // Soll/Haben über die Saldo-Bewegung (Aufwandskonto: Soll erhöht den Saldo).
    // Ohne bekannten Vor-Saldo (fehlender Vortrag) gilt Soll als Default.
    const prev = runningSaldo.get(currentAccount.number);
    const isSoll = prev === undefined ? true : (saldo - prev) >= 0;
    runningSaldo.set(currentAccount.number, saldo);

    const abs = Math.abs(betrag);
    const entry: SageJournalEntry = {
      date,
      belegNr: blg,
      text: textPart,
      accountNumber: currentAccount.number.padStart(4, '0'),
      accountName: currentAccount.name,
      soll:  isSoll ? abs : 0,
      haben: isSoll ? 0 : abs,
      amount: abs,
    };
    journalEntries.push(entry);
    lastBooking = entry;
    return true;
  }

  /** Referenz-/Rechnungsnummer unterhalb der Buchung → an die letzte Buchung anhängen. */
  function tryAttachReference(line: string): boolean {
    if (!lastBooking) return false;
    const t = line.trim();
    if (!t || t.length > 60) return false;
    if (/^\d{2}\.\d{2}\.\d{4}\b/.test(t)) return false;
    if (/^(total|saldo|kontoblatt|datum)\b/i.test(t)) return false;
    if (/^\d{4}\s+[A-Za-zäöüÄÖÜ]/.test(t)) return false;      // Konto-Header
    if (!/^[\wÄÖÜäöüß .,\/()-]+$/.test(t)) return false;
    lastBooking.belegNr = lastBooking.belegNr ? `${lastBooking.belegNr} · ${t}` : t;
    lastBooking = null;                                        // nur EINE Referenzzeile
    return true;
  }

  for (let i = 0; i < lines.length; i++) {
    const { text } = lines[i];
    const trimmed  = text.trim();

    // ── "Saldo Vortrag X" → Eröffnungssaldo (nur einmal pro Konto, nicht bei Seitenanfang-Wiederholungen)
    if (/^saldo\s+vortrag\b/i.test(trimmed) && currentAccount) {
      lastBooking = null;
      const prev = accountData.get(currentAccount.number);
      if (!prev || prev.saldoVortrag === null) {
        const combined = textWithLookahead(i);
        const lastAmt  = findLastAmount(combined);
        const sv       = lastAmt ? (parseAmount(lastAmt.raw) ?? null) : 0; // 0 bei neuen Konten ohne Saldo-Vortrag-Angabe
        // Signierter Start-Saldo für die Soll/Haben-Klassifikation der Buchungszeilen
        if (lastAmt && runningSaldo.get(currentAccount.number) === undefined) {
          const signed = parseSigned(lastAmt.raw);
          if (signed !== null) {
            runningSaldo.set(currentAccount.number, signed);
            vortragSigned.set(currentAccount.number, signed);
          }
        }

        accountData.set(currentAccount.number, {
          ...(prev ?? {
            name: currentAccount.name, totalSoll: 0, totalHaben: 0,
            finalSaldo: null, saldo: 0, usedFallback: false, lineIndex: i + 1, raw: '', pageCount: 0,
          }),
          saldoVortrag: sv !== null ? Math.abs(sv) : 0,
        });
      }
      continue;
    }

    // ── "Total Soll X" → Debit-Summe des Monats (kumulativ: späterer Wert überschreibt)
    if (/^total\s+soll\b/i.test(trimmed) && currentAccount) {
      lastBooking = null;
      const combined = textWithLookahead(i);
      const lastAmt  = findLastAmount(combined);
      if (lastAmt) {
        const soll = parseAmount(lastAmt.raw);
        if (soll !== null) {
          const prev = accountData.get(currentAccount.number);
          accountData.set(currentAccount.number, {
            ...(prev ?? {
              name: currentAccount.name, saldoVortrag: null, totalSoll: 0, totalHaben: 0,
              finalSaldo: null, saldo: 0, usedFallback: false, lineIndex: i + 1, raw: '', pageCount: 0,
            }),
            totalSoll: Math.abs(soll),
          });
        }
      }
      continue;
    }

    // ── "Total Haben [haben] [kumulativer-Endsaldo]"
    //
    // Spaltenformat:  Total Haben | Haben-Spalte | Saldo-Spalte
    //   ≥2 Beträge: allAmts[0] = Haben, allAmts[last] = kumulativer Endsaldo
    //   1 Betrag:   Haben=0.00 fehlt in PDF-Extraktion → einziger Wert = kumulativer Endsaldo
    //
    // PRIMÄRE FORMEL:  monatswert = finalSaldo − saldoVortrag
    //   Beispiel 4020: 44'599.40 − 32'816.68 = 11'782.72 ✓
    //   Beispiel 4040: 1'164.67  −  1'577.62 = −412.95   ✓ (Retouren-Überhang)
    //   Beispiel 4060: 191'738.42 − 147'446.88 = 44'291.54 ✓ (mehrseitig, 3 Seiten)
    //
    // FALLBACK: totalSoll − haben  (wenn saldoVortrag/finalSaldo nicht verfügbar)
    if (/^total\s+haben\b/i.test(trimmed) && currentAccount) {
      lastBooking = null;
      const combined = textWithLookahead(i);
      const allAmts  = findAllAmounts(combined);

      // letzter Wert = kumulativer Endsaldo (finalSaldo); erster Wert (wenn ≥2) = Haben-Spalte
      const finalSaldo = allAmts.length > 0
        ? Math.abs(parseAmount(allAmts[allAmts.length - 1]) ?? 0)
        : null;
      const habenRaw   = allAmts.length >= 2 ? allAmts[0] : '0';
      const haben      = Math.abs(parseAmount(habenRaw) ?? 0);

      const prev         = accountData.get(currentAccount.number);
      const totalSoll    = prev?.totalSoll ?? 0;
      const saldoVortrag = prev?.saldoVortrag ?? null;

      // PRIMÄRFORMEL (Spec): monatswert = Total Soll − Total Haben.
      //   Voraussetzung: Haben-Spalte eindeutig lesbar (≥2 Beträge auf der Zeile
      //   ODER Haben implizit 0 mit vorhandenem Total Soll).
      // FALLBACK: finalSaldo − saldoVortrag (mathematisch identisch, robust
      //   wenn die Haben-Spalte im PDF-Text fehlt).
      // Plausibilität: liefern beide Formeln unterschiedliche Werte → Warnung.
      let monatswert: number;
      let usedFallback = false;
      // Haben-Spalte nur eindeutig, wenn BEIDE Werte (Haben + Endsaldo) auf der
      // Zeile lesbar sind. Bei nur EINEM Betrag ist unklar, ob es der Endsaldo
      // oder der Haben-Wert ist (Y-Koordinaten-Split) → Saldo-Formel bevorzugen.
      const habenEindeutig = allAmts.length >= 2;
      // Signierte Werte für die Gegenrechnung (negative Salden mit führendem
      // oder Sage-typischem nachgestelltem Minus korrekt behandeln)
      const finalSaldoSigned = allAmts.length > 0
        ? parseSigned(allAmts[allAmts.length - 1]) : null;
      const vortragS = vortragSigned.get(currentAccount.number);
      const viaSaldo = (finalSaldoSigned !== null && vortragS !== undefined)
        ? finalSaldoSigned - vortragS
        : ((finalSaldo !== null && saldoVortrag !== null) ? finalSaldo - saldoVortrag : null);
      if (habenEindeutig) {
        monatswert = totalSoll - haben;
        if (viaSaldo !== null && Math.abs(viaSaldo - monatswert) > 0.05) {
          parserWarnings.push(
            `Konto ${currentAccount.number}: Plausibilitätswarnung — Total Soll−Haben (${monatswert.toFixed(2)}) ` +
            `weicht von Endsaldo−Vortrag (${viaSaldo.toFixed(2)}) ab. Bitte Beträge prüfen.`,
          );
        }
      } else if (viaSaldo !== null) {
        monatswert   = viaSaldo;
        usedFallback = true;
      } else {
        monatswert   = totalSoll - haben;
        usedFallback = true;
        parserWarnings.push(
          `Konto ${currentAccount.number}: Haben-Spalte nicht eindeutig lesbar und kein Saldo-Vortrag/Endsaldo verfügbar — ` +
          `Monatswert ${monatswert.toFixed(2)} bitte manuell prüfen.`,
        );
      }

      accountData.set(currentAccount.number, {
        ...(prev ?? {
          name: currentAccount.name, saldoVortrag: null, totalSoll: 0,
          lineIndex: i + 1, raw: '', pageCount: 0,
        }),
        name:        currentAccount.name,
        totalHaben:  haben,
        finalSaldo,
        saldo:       monatswert,
        usedFallback,
        lineIndex:   i + 1,
        raw:         allAmts.join(' / '),
      });
      // currentAccount bleibt aktiv für mehrseitige Konten
      continue;
    }

    // ── Buchungszeile (Datum + Blg + Text + Betrag + Saldo) → Lieferanten-Journal
    if (tryParseBookingLine(text)) continue;

    // ── Referenz-/Rechnungsnummer direkt unter der Buchungszeile
    if (tryAttachReference(text)) continue;

    // ── Konto-Header: 4-stellige Zahl am Anfang, gefolgt von Name (kein echter CHF-Betrag)
    const accM = /^\s*(\d{4})\s+(.+)/.exec(text);
    if (accM) {
      const accountNum = accM[1];
      const afterNum   = accM[2].trim();

      // Jahreszahlen (20xx) sind nie Kontonummern – erscheinen im Buchungstext
      // z.B. "Verrechnung Transgourmet RV 2024 63150508, 63156230, 792"
      if (/^20\d{2}$/.test(accountNum)) continue;

      if (!hasCHFAmount(afterNum)) {
        // Nur Tokens mit mindestens einem Buchstaben behalten:
        // entfernt Seitenzahlen (1–3 Stellen), Rechnungsnummern (8 Stellen),
        // Referenznummern und sonstige rein-numerischen Tokens jeder Länge
        const cleanName = afterNum
          .split(/\s+/)
          .filter(t => {
            const stripped = t.replace(/[,.:;]/g, '');
            return /[a-zA-ZäöüÄÖÜß]/.test(stripped);
          })
          .join(' ')
          .trim();

        // cleanName muss mindestens ein echtes Wort mit 2+ Buchstaben enthalten
        const hasRealWord = /[a-zA-ZäöüÄÖÜß]{2,}/.test(cleanName);

        if (hasRealWord && cleanName.length >= 2) {
          lastBooking = null;
          if (accountNum !== currentAccount?.number) {
            currentAccount = { number: accountNum, name: cleanName };
          } else {
            // Dasselbe Konto auf nächster Seite → Fortsetzung (saldoVortrag NICHT überschreiben)
            const prev = accountData.get(accountNum);
            if (prev) accountData.set(accountNum, { ...prev, pageCount: prev.pageCount + 1 });
            currentAccount = { number: accountNum, name: cleanName };
          }
        }
      }
    }
  }

  // ── Debug-Log
  console.group('[PDF Import] Sage Kontoblatt – Monatswerte');
  for (const [num, d] of accountData.entries()) {
    const multiPage = d.pageCount > 0 ? ` ⚠ mehrseitig (${d.pageCount + 1} Seiten)` : '';
    const formula   = !d.usedFallback && d.finalSaldo !== null && d.saldoVortrag !== null
      ? `Endsaldo(${d.finalSaldo.toFixed(2)}) − SaldoVortrag(${d.saldoVortrag!.toFixed(2)})`
      : `TotalSoll(${d.totalSoll.toFixed(2)}) − TotalHaben(${d.totalHaben.toFixed(2)}) [Fallback]`;
    console.log(`  ${num} "${d.name}": ${formula} = ${d.saldo.toFixed(2)}${multiPage}`);
  }
  console.groupEnd();

  const rows = Array.from(accountData.entries())
    .filter(([, v]) => Math.abs(v.saldo) > 0.005 || v.totalSoll > 0 || v.totalHaben > 0)
    .map(([accNum, v]) => ({
      lineIndex:     v.lineIndex,
      rawLine:       `${accNum} ${v.name}  TotalSoll:${v.totalSoll.toFixed(2)} TotalHaben:${v.totalHaben.toFixed(2)} = Monatswert:${v.saldo.toFixed(2)}`,
      accountNumber: accNum.padStart(4, '0'),
      accountName:   v.name,
      rawAmount:     v.saldo.toFixed(2),
      amount:        v.saldo,
    }));

  return { rows, journalEntries, warnings: parserWarnings };
}

// ─── Zeilen-Parser ────────────────────────────────────────────────────────────

/**
 * Zeilen, die eine Kontonummer (3–5 Stellen) gefolgt von Text und Betrag enthalten.
 *
 * Erkannte Muster (nach typischen Schweizer Buchhaltungs-PDFs):
 *   3000  Speiseumsatz                  12'500.00
 *   4000  Wareneinsatz Küche    3'800.00   0.00   3'800.00-
 *   5000  Löhne Service         4'200.00            4'200.00
 *
 * Strategie:
 *   - Suche 3–5-stellige Zahl am Zeilenanfang (ggf. mit führenden Leerzeichen)
 *   - Überspringe bekannte Aggregat-Zeilen (Total, Summe, etc.)
 *   - Nimm den letzten Betrag auf der Zeile als "Saldo"
 *   - Alles dazwischen = Bezeichnung
 */

// Zeilen, die nicht als Buchungszeilen gelten (Aggregate, Header)
const SKIP_LINE_RE = /^\s*(total|summe|zwischentotal|ertrag|aufwand|bruttogewinn|ergebnis|seite|page|datum|konto|bezeichn|soll|haben|saldo|debit|kredit)\b/i;

// Kontonummer am Zeilenanfang: 3–5 Ziffern, dann mind. 1 Leerzeichen
const ACCOUNT_START_RE = /^\s*(\d{3,5})\s+/;

// Sucht die letzte "Geld-Zahl" in einem String (Swiss/EU/Standard-Format)
// Gültige Formate: 1'234.56, 1.234,56, 1234.56, 1234.56-, -1234.56, (1234.56)
const MONEY_RE = /(?:^|[\s,;])(-?\d[\d'.,']*(?:[.,]\d{2})?[-+]?|\(\d[\d'.,]*(?:[.,]\d{2})?\))/g;

function findLastAmount(text: string): { raw: string; pos: number } | null {
  let last: { raw: string; pos: number } | null = null;
  let m: RegExpExecArray | null;
  const re = new RegExp(MONEY_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]?.trim() ?? m[0].trim();
    if (raw && parseAmount(raw) !== null) {
      last = { raw, pos: m.index };
    }
  }
  return last;
}

/** Gibt ALLE Beträge in einem Text zurück (in Reihenfolge links→rechts). */
function findAllAmounts(text: string): string[] {
  const results: string[] = [];
  const re = new RegExp(MONEY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]?.trim() ?? m[0].trim();
    if (raw && parseAmount(raw) !== null) results.push(raw);
  }
  return results;
}

/**
 * Prüft ob ein Text eine "echte" CHF-Geldangabe enthält.
 * Verlangt Apostroph-Tausendertrenner ODER zwei Dezimalstellen (.XX).
 * Filtert damit Seitenzahlen (z.B. "2", "3") und kurze Nummern heraus.
 */
function hasCHFAmount(text: string): boolean {
  // Matches: 1'234.56, 1'234, 1234.56, 0.00, 12.50 — NOT bare "2" or "3"
  return /\d{1,3}(?:'\d{3})+(?:\.\d+)?|\d+\.\d{2,}/.test(text);
}

function parseLine(
  line: TextLine,
  lineIndex: number,
): ParsedCSVRow | null {
  const { text } = line;

  // Zeilen überspringen, die keine Buchungszeilen sind
  if (SKIP_LINE_RE.test(text)) return null;

  // Kontonummer am Anfang suchen
  const accountMatch = ACCOUNT_START_RE.exec(text);
  if (!accountMatch) return null;

  const accountNumber = accountMatch[1].padStart(4, '0');

  // Jahreszahlen (20xx) sind keine Kontonummern im Buchungsformat
  if (/^20\d{2}$/.test(accountMatch[1])) return null;

  const afterAccount  = text.slice(accountMatch[0].length).trim();

  // Letzten Betrag finden
  const lastAmt = findLastAmount(afterAccount);
  if (!lastAmt) return null;

  const amount = parseAmount(lastAmt.raw);
  if (amount === null || amount === 0) return null;

  // Bezeichnung = Text zwischen Kontonummer und letztem Betrag
  let accountName = afterAccount.slice(0, lastAmt.pos).trim();

  // Bereinigung: Zwischensummen-Zahlen (Soll/Haben-Spalten) aus Name entfernen
  // → Entferne alle Tokens die wie Zahlen aussehen, behalte Texttokens
  accountName = accountName
    .split(/\s+/)
    .filter(token => {
      // Token ist eine Zahl (ggf. mit Apostroph/Punkt als Tausender) → raus
      return parseAmount(token) === null;
    })
    .join(' ')
    .trim();

  // Mindestlänge der Bezeichnung: 1 Zeichen
  if (!accountName) accountName = `Konto ${accountNumber}`;

  return {
    lineIndex,
    rawLine: text,
    accountNumber,
    accountName,
    rawAmount: lastAmt.raw,
    amount: Math.abs(amount),
  };
}

// ─── Haupt-Parse-Funktion ─────────────────────────────────────────────────────

/**
 * Liest eine PDF-Datei (als ArrayBuffer) und extrahiert alle Buchungszeilen.
 * Gibt ein PDFParseResult zurück, das in die CSV-Import-Pipeline eingespeist
 * werden kann.
 */
export async function parsePDF(buffer: ArrayBuffer): Promise<PDFParseResult> {
  const warnings: string[] = [];
  const rows: ParsedCSVRow[] = [];
  const rawLines: string[] = [];

  let pdfDoc: pdfjsLib.PDFDocumentProxy;
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
  } catch (e) {
    warnings.push(`PDF konnte nicht geöffnet werden: ${String(e)}`);
    return { rows, pageCount: 0, rawLines, warnings };
  }

  const pageCount = pdfDoc.numPages;
  const allLines: TextLine[] = [];

  for (let p = 1; p <= pageCount; p++) {
    try {
      const page  = await pdfDoc.getPage(p);
      const lines = await extractLinesFromPage(page);
      allLines.push(...lines);
    } catch (e) {
      warnings.push(`Seite ${p} konnte nicht gelesen werden: ${String(e)}`);
    }
  }

  // Alle Texte für Debug und Monats-Erkennung sammeln
  allLines.forEach(l => rawLines.push(l.text));

  // Monat/Jahr erkennen
  let { month: detectedMonth, year: detectedYear } = detectMonthYear(rawLines);
  let journalEntries: SageJournalEntry[] | undefined;
  let detectedCompany: string | undefined;
  let detectedTenant: 'oliv' | 'beaulieu' | undefined;
  let monthly: PDFParseResult['monthly'];

  // Format-Erkennung: Sage Kontoblatt vs. generisches Kontenblatt
  if (isSageKontoblatt(rawLines)) {
    // Kopf: Firmenname (Mandanten-Check) + Zeitraum «vom … bis …» (Monat/Jahr)
    const meta = parseSageHeaderMeta(rawLines);
    detectedCompany = meta.company;
    detectedTenant  = meta.tenant;
    if (meta.month !== undefined) detectedMonth = meta.month;
    if (meta.year  !== undefined) detectedYear  = meta.year;

    // Sage Kontoblatt: State-Machine — ein Saldo pro Konto via "Total Haben"-Zeile
    const sage = parseSageKontoblatt(allLines);
    rows.push(...sage.rows);
    journalEntries = sage.journalEntries;
    warnings.push(...sage.warnings);
    if (sage.rows.length > 0) {
      const je = sage.journalEntries.length > 0 ? `, ${sage.journalEntries.length} Buchungszeilen (Lieferanten-Journal)` : '';
      warnings.push(
        `Sage Kontoblatt erkannt: ${sage.rows.length} Konten importiert${je}.`,
      );
    }

    // ── Mehrmonats-PDF: Kopf-Zeitraum über Monatsgrenzen (gleiches Jahr) ──
    // Buchungszeilen nach Buchungsmonat gruppieren → pro Monat Konten-Netto
    // + Journal. Plausibilität: Summe über alle Monate je Konto muss dem
    // Totals-basierten Kontowert entsprechen (sonst Warnung).
    const spansMultipleMonths =
      meta.month !== undefined && meta.monthTo !== undefined &&
      meta.year !== undefined && meta.yearTo === meta.year &&
      meta.monthTo !== meta.month;
    if (spansMultipleMonths && sage.journalEntries.length > 0) {
      monthly = buildMonthlyFromJournal(meta.year!, sage.journalEntries, sage.rows, warnings);
    } else if (spansMultipleMonths) {
      warnings.push(
        'Zeitraum umfasst mehrere Monate, aber es wurden keine Buchungszeilen erkannt — ' +
        'eine Aufteilung pro Monat ist nicht möglich. Bitte Monats-PDFs oder das Jahres-Excel verwenden.',
      );
    }
  } else {
    // Generisches Kontenblatt: eine Zeile = Konto + Betrag
    const seen = new Set<string>();
    for (let i = 0; i < allLines.length; i++) {
      const parsed = parseLine(allLines[i], i + 1);
      if (!parsed) continue;
      const dedupeKey = `${parsed.accountNumber}_${parsed.amount.toFixed(2)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push(parsed);
    }
  }

  if (rows.length === 0) {
    warnings.push(
      'Keine Buchungszeilen erkannt. Mögliche Ursachen: ' +
      '(1) Das PDF enthält gescannte Bilder statt Text – bitte als Textdatei exportieren. ' +
      '(2) Das Format wird noch nicht unterstützt – bitte als CSV exportieren und über CSV-Import hochladen.',
    );
  }

  return {
    rows, detectedMonth, detectedYear, pageCount, rawLines, warnings,
    ...(journalEntries !== undefined ? { journalEntries } : {}),
    ...(detectedCompany !== undefined ? { detectedCompany } : {}),
    ...(detectedTenant  !== undefined ? { detectedTenant }  : {}),
    ...(monthly !== undefined ? { monthly } : {}),
  };
}

/**
 * Gruppiert Sage-Buchungszeilen nach Buchungsmonat (nur Buchungen des
 * Zieljahres) und baut daraus pro Monat Konten-Netto-Zeilen (Soll−Haben)
 * plus das Monats-Journal. Plausibilität: Summe der Monatswerte je Konto
 * wird gegen den Totals-basierten Kontowert (Endsaldo−Vortrag) geprüft.
 */
function buildMonthlyFromJournal(
  year: number,
  journal: SageJournalEntry[],
  totalsRows: ParsedCSVRow[],
  warnings: string[],
): PDFParseResult['monthly'] {
  const journalByMonth = new Map<number, SageJournalEntry[]>();
  const sums = new Map<number, Map<string, { name: string; net: number }>>();
  let skippedOutOfYear = 0;

  for (const e of journal) {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(e.date.trim());
    if (!m) { skippedOutOfYear++; continue; }
    const month = parseInt(m[2]);
    const y = expandYear(parseInt(m[3]));
    if (y !== year || month < 1 || month > 12) { skippedOutOfYear++; continue; }
    if (!journalByMonth.has(month)) journalByMonth.set(month, []);
    journalByMonth.get(month)!.push(e);
    if (!sums.has(month)) sums.set(month, new Map());
    const acc = sums.get(month)!;
    const prev = acc.get(e.accountNumber) ?? { name: e.accountName, net: 0 };
    acc.set(e.accountNumber, { name: prev.name, net: prev.net + e.soll - e.haben });
  }

  if (skippedOutOfYear > 0) {
    warnings.push(`${skippedOutOfYear} Buchung(en) mit Datum ausserhalb ${year} für die Monats-Aufteilung übersprungen.`);
  }

  const rowsByMonth = new Map<number, ParsedCSVRow[]>();
  const perAccountTotal = new Map<string, number>();
  for (const [month, accounts] of sums.entries()) {
    const rows: ParsedCSVRow[] = [];
    let lineIndex = 0;
    for (const [accNum, { name, net }] of accounts.entries()) {
      perAccountTotal.set(accNum, (perAccountTotal.get(accNum) ?? 0) + net);
      // net === 0 bewusst BEHALTEN: eine 0-Zeile ersetzt beim Re-Import
      // veraltete Kontowerte des Monats (sonst blieben stale Daten stehen).
      rows.push({
        lineIndex:     ++lineIndex,
        rawLine:       `${accNum} ${name} → ${net.toFixed(2)} (${String(month).padStart(2, '0')}.${year})`,
        accountNumber: accNum,
        accountName:   name,
        rawAmount:     net.toFixed(2),
        amount:        net,
      });
    }
    // Jeden Buchungsmonat aufnehmen (auch mit 0-Netto) — Monat gehört zum Zeitraum
    rowsByMonth.set(month, rows);
  }

  // Plausibilität gegen die Totals-basierten Kontowerte des ganzen Zeitraums
  for (const r of totalsRows) {
    const viaBookings = perAccountTotal.get(r.accountNumber) ?? 0;
    if (Math.abs(viaBookings - r.amount) > 0.05) {
      warnings.push(
        `Konto ${r.accountNumber}: Summe der Buchungszeilen über alle Monate (${viaBookings.toFixed(2)}) ` +
        `weicht vom Kontowert laut Totals (${r.amount.toFixed(2)}) ab — Monats-Aufteilung bitte prüfen.`,
      );
    }
  }

  if (rowsByMonth.size === 0) return undefined;
  warnings.push(`Mehrmonats-Kontoblatt: ${rowsByMonth.size} Monate mit Buchungsdaten (Jahr ${year}).`);
  return { year, rowsByMonth, journalByMonth };
}

// ─── Sage Kontoblatt Excel-Parser ─────────────────────────────────────────────

export interface ExcelParseResult {
  rows: ParsedCSVRow[];
  journalEntries: SageJournalEntry[];
  detectedYear?: number;
  detectedMonth?: number;
  warnings: string[];
}

/** Konvertiert einen Excel-Datum-Serial-Wert in "DD.MM.YYYY" */
function excelSerialToDateStr(serial: number): string {
  try {
    // Excel epoch: 1 Jan 1900, but has leap year bug (treats 1900 as leap year)
    const d = new Date(Date.UTC(1900, 0, 1) + (serial - 2) * 86400000);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
  } catch {
    return String(serial);
  }
}

/**
 * Liest ein Sage-Kontoblatt Excel (xlsx/xls) und extrahiert Netto-Saldi pro Konto.
 *
 * Erwartetes Format (Sage 50 Kontoblatt-Export):
 *   Zeile 0:  ["Kontoblatt", ..., "Oliv Gastro AG", ...]
 *   Zeile 1:  ["vom:", ..., "01.01.26 bis 31.01.26", ...]
 *   Konto-Header: row[0] = 4-stellige Zahl, row[6] leer
 *   Total Haben: row[3] = "Total Haben", row[10] = Saldo (Netto)
 */
export async function parseSageKontoblattExcel(buffer: ArrayBuffer): Promise<ExcelParseResult> {
  const warnings: string[] = [];
  const rows: ParsedCSVRow[] = [];
  const journalEntries: SageJournalEntry[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch (e) {
    warnings.push(`Excel-Datei konnte nicht geöffnet werden: ${String(e)}`);
    return { rows, journalEntries, warnings };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    warnings.push('Excel-Datei enthält kein Blatt.');
    return { rows, journalEntries, warnings };
  }

  const sheet = workbook.Sheets[sheetName];
  const data: (string | number | null)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as (string | number | null)[][];

  // Monat/Jahr aus Zeile 1 ("vom: 01.01.26 bis 31.01.26")
  let detectedMonth: number | undefined;
  let detectedYear: number | undefined;
  const headerLine = String(data[1]?.join(' ') ?? '');
  const sageVomM = headerLine.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (sageVomM) {
    const yy = parseInt(sageVomM[3]);
    detectedMonth = parseInt(sageVomM[2]);
    detectedYear  = yy < 100 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;
  }

  // Konto-Summen aus einzelnen Buchungszeilen aufbauen (Soll - Haben = Netto-Bewegung).
  // NICHT den Saldo aus "Total Haben" (Spalte K) verwenden – dieser ist kumulativ
  // und enthält den Saldo-Vortrag aus Vorperioden.
  const accountSums = new Map<string, { name: string; soll: number; haben: number }>();
  let currentAccount: { number: string; name: string } | null = null;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const col0 = row[0];
    const col1 = row[1];   // BelegNr
    const col3 = String(row[3] ?? '').trim();
    const col6 = row[6];   // Soll-Betrag
    const col7 = row[7];   // Haben-Betrag

    // Konto-Header: col0 ist eine 4-stellige Zahl, col6 ist leer
    if (typeof col0 === 'number' && col0 >= 1000 && col0 <= 9999 && !col6 && col3) {
      const cleanName = col3.replace(/^\s+|\s+$/g, '');
      if (cleanName.length >= 2) {
        currentAccount = { number: String(Math.round(col0)), name: cleanName };
      }
      continue;
    }

    // "Total Haben" / Trennzeilen: Konto-Sektion beenden, aber Saldo NICHT übernehmen
    if ((col3 === 'Total Haben' || col3 === 'Total') && currentAccount) {
      currentAccount = null;
      continue;
    }

    // "Saldo Vortrag" überspringen – enthält kumulierten Vorperioden-Saldo
    if (col3 === 'Saldo Vortrag') continue;

    // Buchungszeile: col0 = Datumsstring oder Excel-Datum-Serial
    if (currentAccount && col3) {
      let isSageBookingLine = false;
      let dateStr = '';

      if (typeof col0 === 'number' && col0 > 40000) {
        dateStr = excelSerialToDateStr(col0);
        isSageBookingLine = true;
      } else if (typeof col0 === 'string' && /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(col0)) {
        dateStr = col0.trim();
        isSageBookingLine = true;
      }

      if (isSageBookingLine) {
        // Sage-Beträge sind immer positiv in ihrer Spalte
        const soll  = typeof col6 === 'number' ? col6 : (parseAmount(String(col6 ?? '')) ?? 0);
        const haben = typeof col7 === 'number' ? col7 : (parseAmount(String(col7 ?? '')) ?? 0);

        if (soll > 0 || haben > 0) {
          const key = currentAccount.number;
          const prev = accountSums.get(key) ?? { name: currentAccount.name, soll: 0, haben: 0 };
          accountSums.set(key, {
            name: prev.name,
            soll:  prev.soll  + soll,
            haben: prev.haben + haben,
          });

          // Journal-Eintrag für Einzelbuchungen
          if (col3 !== 'Saldo' && col3 !== 'Total' && col3 !== 'Total Haben') {
            const amount = soll > 0 ? soll : haben;
            const belegNr = col1 !== null && col1 !== undefined ? String(col1).trim() : undefined;
            journalEntries.push({
              date:          dateStr,
              belegNr:       belegNr || undefined,
              text:          col3,
              accountNumber: currentAccount.number.padStart(4, '0'),
              accountName:   currentAccount.name,
              soll,
              haben,
              amount,
            });
          }
        }
      }
    }
  }

  // ParsedCSVRow[] aus Netto-Bewegungen aufbauen (Soll - Haben)
  let lineIndex = 0;
  for (const [accNum, { name, soll, haben }] of accountSums.entries()) {
    const netto = soll - haben;
    if (netto === 0) continue;
    rows.push({
      lineIndex:     ++lineIndex,
      rawLine:       `${accNum} ${name} → Soll ${soll.toFixed(2)} Haben ${haben.toFixed(2)} = ${netto.toFixed(2)}`,
      accountNumber: accNum.padStart(4, '0'),
      accountName:   name,
      rawAmount:     netto.toFixed(2),
      amount:        netto,
    });
  }

  if (rows.length === 0) {
    warnings.push(
      'Keine Konten gefunden. Prüfe ob das Excel im Sage-Kontoblatt-Format vorliegt ' +
      '(Konto-Header in Spalte A, Buchungszeilen mit Datum, Soll/Haben in Spalten G/H).',
    );
  } else {
    const je = journalEntries.length > 0 ? `, ${journalEntries.length} Einzelbuchungen` : '';
    warnings.push(`Sage Kontoblatt (Excel) erkannt: ${rows.length} Konten${je} importiert.`);
  }

  return { rows, journalEntries, detectedMonth, detectedYear, warnings };
}

// ─── Jahres-Kontoblatt-Parser (multi-month) ───────────────────────────────────

export interface AnnualKostenResult {
  /** Monat (1–12) → ParsedCSVRow[] (summiert pro Konto) */
  byMonth: Map<number, ParsedCSVRow[]>;
  /** Monat (1–12) → Buchungszeilen (Lieferanten-Journal für den FIBU-Abgleich) */
  journalByMonth: Map<number, SageJournalEntry[]>;
  /** Firmenname aus dem Dateikopf (z. B. «Oliv Gastro AG») */
  detectedCompany?: string;
  /** Aus dem Firmennamen abgeleiteter Mandant (Mandanten-Check beim Import) */
  detectedTenant?: 'oliv' | 'beaulieu';
  /** Erkanntes Geschäftsjahr — null wenn uneindeutig/nicht erkennbar (dann NICHT speichern) */
  detectedYear: number | null;
  /** Woher stammt das Jahr: Dateizeitraum-Kopf, Buchungsdaten oder nicht erkennbar */
  yearSource: 'period' | 'bookings' | 'none';
  /** Zeitraum aus dem Dateikopf, z.B. "01.01.25" / "31.12.25" */
  periodFrom?: string;
  periodTo?: string;
  /** true = Jahr uneindeutig (Zeitraum umfasst mehrere Jahre o.ä.) → Import abbrechen */
  ambiguousYear: boolean;
  /** Anzahl erkannter Konten (mit mind. einer Netto-Bewegung ≠ 0) */
  accountCount: number;
  /** Anzahl gültiger, verwendeter Buchungszeilen */
  bookingCount: number;
  /** Buchungen mit Datum ausserhalb des erkannten Jahres (übersprungen) */
  skippedOutOfYear: number;
  /** Sonstige übersprungene Zeilen (Totale, Saldo Vortrag, Zeilen ohne Datum/Betrag) */
  skippedOtherRows: number;
  warnings: string[];
  /** Gesetzt wenn nichts importierbar ist — beschreibt den konkreten Grund */
  failureReason?: string;
  /** Diagnose: reale Dateistruktur offenlegen statt Format zu raten */
  debug: {
    sheetName: string;
    rowCount: number;
    headerLines: string[];
    bookingYearCounts: Record<string, number>;
    sampleSkippedRows: string[];
  };
}

function expandYear(yy: number): number {
  return yy < 100 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;
}

/**
 * Liest ein Sage-Kontoblatt-Excel das einen ganzen Jahr-Zeitraum umfasst
 * (z.B. 01.01.25 – 31.12.25) und gruppiert Buchungszeilen nach Monat.
 *
 * Härtungsregeln (Spec Vorjahreskosten-Import):
 * - Geschäftsjahr aus dem Dateizeitraum ("vom 01.01.25 bis 31.12.25"), NIE aus dem Dateinamen.
 *   Fallback: eindeutiges Jahr der Buchungsdaten. Mehrere Jahre → ambiguousYear, kein Speichern.
 * - Buchungszeilen zählen nur, wenn ihr Buchungsdatum im erkannten Jahr liegt (sonst skippedOutOfYear).
 * - Struktur-/Saldozeilen (Total, Total Soll/Haben, Saldo Vortrag) werden explizit übersprungen.
 * - Beträge bleiben Soll − Haben (Netto-Bewegung); die Ertrags-Negation macht buildMonthRecord
 *   via Konten-Mapping-sign — hier KEINE Doppel-Negation.
 *
 * Ergebnis: pro Monat ein Array von ParsedCSVRow[], die dann über
 * matchCSVRows + Record-Builder + Replace-Scope gespeichert werden.
 */
/**
 * Liest ein Sage-Kontoblatt-PDF, das einen ganzen Jahres-/Mehrmonats-Zeitraum
 * umfasst (z.B. «vom 01.01.25 bis 31.12.25»), und liefert dasselbe
 * AnnualKostenResult wie der Excel-Jahresimport — damit läuft der PDF-Upload
 * über exakt denselben Vorschau-/Modus-/Undo-/Lock-Pfad im ImportHub.
 *
 * Regeln identisch zum Excel-Pfad:
 * - Buchungszeilen nach Buchungsdatum pro Monat gruppiert, Netto = Soll − Haben.
 * - «Saldo Vortrag»/Kontokopf-Wiederholungen sind keine Buchungen (Parser-State-Machine).
 * - Plausibilität je Konto: Σ Monate vs. Konto-Total (Endsaldo−Vortrag) > 0.05 → Warnung.
 * - Zeitraum über mehrere Jahre → ambiguousYear, kein Speichern.
 */
export async function parseAnnualSageKontoblattFromPdf(
  buffer: ArrayBuffer,
): Promise<AnnualKostenResult> {
  const empty = (failureReason: string, warnings: string[], debugPartial?: Partial<AnnualKostenResult['debug']>): AnnualKostenResult => ({
    byMonth: new Map(),
    journalByMonth: new Map(),
    detectedYear: null,
    yearSource: 'none',
    ambiguousYear: false,
    accountCount: 0,
    bookingCount: 0,
    skippedOutOfYear: 0,
    skippedOtherRows: 0,
    warnings,
    failureReason,
    debug: { sheetName: 'PDF', rowCount: 0, headerLines: [], bookingYearCounts: {}, sampleSkippedRows: [], ...debugPartial },
  });

  const pdf = await parsePDF(buffer);
  const warnings = [...pdf.warnings];
  const headerLines = pdf.rawLines.slice(0, 12);

  // Fail-closed: unlesbare Seiten dürfen NIE zu einem Teil-Jahresimport führen
  // (fehlende Buchungen würden sonst still als vollständige Monatswerte gespeichert).
  const pageFailures = warnings.filter((w) => /Seite \d+ konnte nicht gelesen werden/.test(w));
  if (pageFailures.length > 0) {
    const reason =
      `${pageFailures.length} Seite(n) des PDFs konnten nicht gelesen werden — der Jahresimport wurde abgebrochen, ` +
      'da sonst unvollständige Monatswerte gespeichert würden. Bitte das PDF neu exportieren.';
    warnings.push(reason);
    return empty(reason, warnings, { rowCount: pdf.rawLines.length, headerLines });
  }
  const debugPartial: Partial<AnnualKostenResult['debug']> = {
    rowCount: pdf.rawLines.length,
    headerLines,
  };

  // Zeitraum «vom … bis …» aus dem Kopf (für Registry/Anzeige)
  let periodFrom: string | undefined;
  let periodTo: string | undefined;
  for (const line of headerLines) {
    const p = /vom:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})\s+bis\s+(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(line);
    if (p) { periodFrom = p[1]; periodTo = p[2]; break; }
  }
  const meta = parseSageHeaderMeta(pdf.rawLines);
  if (meta.year !== undefined && meta.yearTo !== undefined && meta.year !== meta.yearTo) {
    const reason = `Dateizeitraum umfasst mehrere Jahre (${periodFrom ?? '?'} – ${periodTo ?? '?'}). ` +
      'Import abgebrochen — bitte eine Datei mit genau einem Geschäftsjahr exportieren.';
    warnings.push(reason);
    return { ...empty(reason, warnings, debugPartial), periodFrom, periodTo, ambiguousYear: true };
  }

  if (pdf.rows.length === 0) {
    return {
      ...empty(
        'Keine Buchungszeilen im PDF erkannt. Prüfe, ob es ein Sage-Kontoblatt mit Textebene ist ' +
        '(gescannte PDFs werden nicht unterstützt).',
        warnings, debugPartial,
      ),
      periodFrom, periodTo,
      ...(pdf.detectedCompany !== undefined ? { detectedCompany: pdf.detectedCompany } : {}),
      ...(pdf.detectedTenant !== undefined ? { detectedTenant: pdf.detectedTenant } : {}),
    };
  }

  if (!pdf.monthly) {
    return {
      ...empty(
        'Das PDF konnte nicht pro Monat aufgeteilt werden (kein Mehrmonats-Zeitraum im Kopf ' +
        'oder keine datierten Buchungszeilen). Für Einzelmonate bitte den Monats-Kostenimport verwenden.',
        warnings, debugPartial,
      ),
      periodFrom, periodTo,
      ...(pdf.detectedCompany !== undefined ? { detectedCompany: pdf.detectedCompany } : {}),
      ...(pdf.detectedTenant !== undefined ? { detectedTenant: pdf.detectedTenant } : {}),
    };
  }

  const { year, rowsByMonth, journalByMonth } = pdf.monthly;
  const accountSet = new Set<string>();
  let bookingCount = 0;
  for (const rows of rowsByMonth.values()) {
    for (const r of rows) if (r.amount !== 0) accountSet.add(r.accountNumber);
  }
  for (const entries of journalByMonth.values()) bookingCount += entries.length;
  const skippedOutOfYear = pdf.journalEntries
    ? pdf.journalEntries.length - bookingCount
    : 0;

  warnings.push(
    `Sage-Jahres-Kontoblatt (PDF) erkannt: ${rowsByMonth.size} Monate mit Buchungsdaten, ` +
    `${accountSet.size} Konten, ${bookingCount} Buchungen (Jahr ${year}).`,
  );

  return {
    byMonth: rowsByMonth,
    journalByMonth,
    ...(pdf.detectedCompany !== undefined ? { detectedCompany: pdf.detectedCompany } : {}),
    ...(pdf.detectedTenant !== undefined ? { detectedTenant: pdf.detectedTenant } : {}),
    detectedYear: year,
    yearSource: 'period',
    periodFrom,
    periodTo,
    ambiguousYear: false,
    accountCount: accountSet.size,
    bookingCount,
    skippedOutOfYear: Math.max(0, skippedOutOfYear),
    skippedOtherRows: 0,
    warnings,
    debug: {
      sheetName: 'PDF',
      rowCount: pdf.rawLines.length,
      headerLines,
      bookingYearCounts: {},
      sampleSkippedRows: [],
    },
  };
}

export async function parseAnnualSageKontoblattByMonth(
  buffer: ArrayBuffer,
): Promise<AnnualKostenResult> {
  const warnings: string[] = [];
  const emptyResult = (failureReason: string, debugPartial?: Partial<AnnualKostenResult['debug']>): AnnualKostenResult => ({
    byMonth: new Map(),
    journalByMonth: new Map(),
    detectedYear: null,
    yearSource: 'none',
    ambiguousYear: false,
    accountCount: 0,
    bookingCount: 0,
    skippedOutOfYear: 0,
    skippedOtherRows: 0,
    warnings,
    failureReason,
    debug: {
      sheetName: '',
      rowCount: 0,
      headerLines: [],
      bookingYearCounts: {},
      sampleSkippedRows: [],
      ...debugPartial,
    },
  });

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch (e) {
    const reason = `Excel-Datei konnte nicht geöffnet werden: ${String(e)}`;
    warnings.push(reason);
    return emptyResult(reason);
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data: (string | number | null)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as (string | number | null)[][];

  // ── Zeitraum aus den Kopfzeilen (erste 8 Zeilen): "vom 01.01.25 bis 31.12.25" ──
  const headerLines: string[] = [];
  let periodFrom: string | undefined;
  let periodTo: string | undefined;
  let periodYear: number | null = null;
  let ambiguousYear = false;

  for (let i = 0; i < Math.min(8, data.length); i++) {
    const line = (data[i] ?? []).filter(c => c !== null && c !== '').map(String).join(' ').trim();
    if (line) headerLines.push(line);
  }
  const dateRe = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/g;
  for (const line of headerLines) {
    const matches = Array.from(line.matchAll(dateRe));
    if (matches.length >= 2) {
      periodFrom = matches[0][0];
      periodTo   = matches[1][0];
      const yFrom = expandYear(parseInt(matches[0][3]));
      const yTo   = expandYear(parseInt(matches[1][3]));
      if (yFrom !== yTo) {
        ambiguousYear = true;
        warnings.push(
          `Dateizeitraum umfasst mehrere Jahre (${periodFrom} – ${periodTo}). ` +
          'Import abgebrochen — bitte eine Datei mit genau einem Geschäftsjahr exportieren.',
        );
      } else {
        periodYear = yFrom;
      }
      break;
    }
    if (matches.length === 1 && /vom|periode|zeitraum/i.test(line)) {
      periodFrom = matches[0][0];
      periodYear = expandYear(parseInt(matches[0][3]));
      break;
    }
  }

  // ── Firma/Mandant aus den Kopfzeilen (Mandanten-Check beim Import) ──
  let detectedCompany: string | undefined;
  for (const line of headerLines) {
    const m = /kontoblatt\s+(.+?)(?:\s+seite\s*:?.*)?$/i.exec(line);
    if (m && m[1].trim().length >= 3) { detectedCompany = m[1].trim(); break; }
  }
  if (!detectedCompany) {
    // Fallback: Firmenname steht als eigene Kopfzeile ohne «Kontoblatt»-Präfix
    const hit = headerLines.find(l => /beaulieu|oliv/i.test(l));
    if (hit) detectedCompany = hit.replace(/\s*seite\s*:?.*$/i, '').trim();
  }
  let detectedTenant: 'oliv' | 'beaulieu' | undefined;
  if (detectedCompany) {
    if (/beaulieu/i.test(detectedCompany)) detectedTenant = 'beaulieu';
    else if (/oliv/i.test(detectedCompany)) detectedTenant = 'oliv';
  }

  // ── Buchungszeilen einsammeln (Phase 1: rohe Buchungen mit vollem Datum) ──
  interface RawBooking {
    account: string; name: string; month: number; year: number; soll: number; haben: number;
    dateStr: string; belegNr?: string; text: string;
  }
  const rawBookings: RawBooking[] = [];
  const bookingYearCounts: Record<string, number> = {};
  const sampleSkippedRows: string[] = [];
  let skippedOtherRows = 0;

  let currentAccount: { number: string; name: string } | null = null;

  const noteSkip = (row: (string | number | null)[]) => {
    skippedOtherRows++;
    if (sampleSkippedRows.length < 10) {
      sampleSkippedRows.push(row.filter(c => c !== null && c !== '').map(String).join(' | ').slice(0, 160));
    }
  };

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const col0 = row[0];
    const col3 = String(row[3] ?? '').trim();
    const col6 = row[6];
    const col7 = row[7];

    // Konto-Header: col0 = 4-stellige Kontonummer (Zahl ODER Text), col6 leer, col3 = Kontoname
    const col0Str = typeof col0 === 'string' ? col0.trim() : '';
    const isNumericHeader = typeof col0 === 'number' && col0 >= 1000 && col0 <= 9999;
    const isTextHeader = /^\d{4}$/.test(col0Str) && parseInt(col0Str) >= 1000;
    if ((isNumericHeader || isTextHeader) && !col6 && col3 && col3.length >= 2) {
      currentAccount = {
        number: isNumericHeader ? String(Math.round(col0 as number)) : col0Str,
        name: col3,
      };
      continue;
    }

    if (!currentAccount) continue;

    // Struktur-/Saldozeilen explizit überspringen (keine Buchungen)
    if (/^(total( (soll|haben))?|saldo( vortrag)?)$/i.test(col3)) continue;

    // Buchungszeile: col0 = Datum-String oder Excel-Serial
    let dateStr = '';
    if (typeof col0 === 'number' && col0 > 40000) {
      dateStr = excelSerialToDateStr(col0);
    } else if (typeof col0 === 'string' && /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(col0)) {
      dateStr = col0.trim();
    }

    if (!dateStr) {
      // Zeile innerhalb eines Kontoblocks ohne erkennbares Datum → Diagnose-Zähler
      if (col3 || col6 || col7) noteSkip(row);
      continue;
    }

    const parts = dateStr.split('.');
    if (parts.length < 3) { noteSkip(row); continue; }
    const month = parseInt(parts[1]);
    const bookingYear = expandYear(parseInt(parts[2]));
    if (isNaN(month) || month < 1 || month > 12 || isNaN(bookingYear)) { noteSkip(row); continue; }

    // Sage: Soll- und Haben-Beträge sind immer positive Zahlen in ihrer Spalte
    const soll  = typeof col6 === 'number' ? col6 : (parseAmount(String(col6 ?? '')) ?? 0);
    const haben = typeof col7 === 'number' ? col7 : (parseAmount(String(col7 ?? '')) ?? 0);

    if (soll === 0 && haben === 0) continue;

    bookingYearCounts[String(bookingYear)] = (bookingYearCounts[String(bookingYear)] ?? 0) + 1;
    const belegRaw = row[1];
    rawBookings.push({
      account: currentAccount.number,
      name: currentAccount.name,
      month,
      year: bookingYear,
      soll,
      haben,
      dateStr,
      belegNr: belegRaw !== null && belegRaw !== undefined && String(belegRaw).trim() !== ''
        ? String(belegRaw).trim() : undefined,
      text: col3 || currentAccount.name,
    });
  }

  const debug: AnnualKostenResult['debug'] = {
    sheetName,
    rowCount: data.length,
    headerLines,
    bookingYearCounts,
    sampleSkippedRows,
  };

  if (ambiguousYear) {
    return {
      ...emptyResult('Geschäftsjahr uneindeutig: Dateizeitraum umfasst mehrere Jahre.', debug),
      periodFrom,
      periodTo,
      ambiguousYear: true,
      skippedOtherRows,
    };
  }

  if (rawBookings.length === 0) {
    const reason =
      'Keine Buchungszeilen gefunden. Prüfe ob das Excel im Sage-Kontoblatt-Format vorliegt ' +
      '(Kontonummer in Spalte A als Blockkopf, Datum in Spalte A, Text in Spalte D, Soll in Spalte G, Haben in Spalte H).';
    warnings.push(reason);
    return { ...emptyResult(reason, debug), periodFrom, periodTo, skippedOtherRows };
  }

  // ── Jahr bestimmen: Zeitraum-Kopf hat Vorrang, sonst eindeutiges Buchungsjahr ──
  let detectedYear: number | null = periodYear;
  let yearSource: AnnualKostenResult['yearSource'] = periodYear !== null ? 'period' : 'none';
  if (detectedYear === null) {
    const years = Object.keys(bookingYearCounts).map(Number).sort();
    if (years.length === 1) {
      detectedYear = years[0];
      yearSource = 'bookings';
      warnings.push(`Kein Zeitraum im Dateikopf gefunden — Jahr ${detectedYear} aus den Buchungsdaten abgeleitet.`);
    } else {
      const reason =
        `Geschäftsjahr uneindeutig: kein Zeitraum im Dateikopf und Buchungen aus mehreren Jahren ` +
        `(${years.join(', ')}). Import abgebrochen — keine Teildaten gespeichert.`;
      warnings.push(reason);
      return {
        ...emptyResult(reason, debug),
        periodFrom,
        periodTo,
        ambiguousYear: true,
        skippedOtherRows,
      };
    }
  }

  // ── Phase 2: nur Buchungen im erkannten Jahr aggregieren ──
  const monthAccountSums = new Map<number, Map<string, { name: string; soll: number; haben: number }>>();
  const journalByMonth = new Map<number, SageJournalEntry[]>();
  let bookingCount = 0;
  let skippedOutOfYear = 0;

  for (const b of rawBookings) {
    if (b.year !== detectedYear) { skippedOutOfYear++; continue; }
    bookingCount++;
    if (!monthAccountSums.has(b.month)) monthAccountSums.set(b.month, new Map());
    const accounts = monthAccountSums.get(b.month)!;
    const prev = accounts.get(b.account) ?? { name: b.name, soll: 0, haben: 0 };
    accounts.set(b.account, { name: prev.name, soll: prev.soll + b.soll, haben: prev.haben + b.haben });
    // Journal pro Monat (Lieferanten-FIBU-Abgleich): Einzelbuchung mit Soll/Haben
    if (!journalByMonth.has(b.month)) journalByMonth.set(b.month, []);
    journalByMonth.get(b.month)!.push({
      date:          b.dateStr,
      belegNr:       b.belegNr,
      text:          b.text,
      accountNumber: b.account.padStart(4, '0'),
      accountName:   b.name,
      soll:          b.soll,
      haben:         b.haben,
      amount:        b.soll > 0 ? b.soll : b.haben,
    });
  }

  if (skippedOutOfYear > 0) {
    warnings.push(
      `${skippedOutOfYear} Buchung(en) mit Datum ausserhalb ${detectedYear} übersprungen.`,
    );
  }

  // ── ParsedCSVRow[] pro Monat aufbauen (Netto: Soll − Haben, Vorzeichen via Mapping) ──
  const byMonth = new Map<number, ParsedCSVRow[]>();
  const accountSet = new Set<string>();

  for (const [month, accounts] of monthAccountSums.entries()) {
    const rows: ParsedCSVRow[] = [];
    let lineIndex = 0;

    for (const [accNum, { name, soll, haben }] of accounts.entries()) {
      const amount = soll - haben;
      if (amount === 0) continue;
      accountSet.add(accNum);
      rows.push({
        lineIndex:     ++lineIndex,
        rawLine:       `${accNum} ${name} → ${amount.toFixed(2)}`,
        accountNumber: accNum.padStart(4, '0'),
        accountName:   name,
        rawAmount:     amount.toFixed(2),
        amount,
      });
    }

    if (rows.length > 0) byMonth.set(month, rows);
  }

  warnings.push(
    `Sage-Jahres-Kontoblatt erkannt: ${byMonth.size} Monate mit Buchungsdaten, ` +
    `${accountSet.size} Konten, ${bookingCount} Buchungen (Jahr ${detectedYear}).`,
  );

  return {
    byMonth,
    journalByMonth,
    ...(detectedCompany !== undefined ? { detectedCompany } : {}),
    ...(detectedTenant  !== undefined ? { detectedTenant }  : {}),
    detectedYear,
    yearSource,
    periodFrom,
    periodTo,
    ambiguousYear: false,
    accountCount: accountSet.size,
    bookingCount,
    skippedOutOfYear,
    skippedOtherRows,
    warnings,
    debug,
  };
}
