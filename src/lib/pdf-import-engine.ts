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

// ─── Worker-Konfiguration ─────────────────────────────────────────────────────

// Wir nutzen den CDN-Worker, um Bundler-Kompatibilitätsprobleme zu vermeiden.
// Version muss zur installierten pdfjs-dist-Version passen.
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
}

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
 * State-Machine-Parser für Sage Kontoblatt-PDFs.
 *
 * Format:
 *   4020            Wein Warenaufwand          ← Konto-Header (kein Betrag)
 *                   Saldo Vortrag  0.00         ← ignorieren
 *   20.01.2026  54  Paul Ullrich AG  2001  1'324.01  1'324.01  ← Buchungszeilen ignorieren
 *                   Total Soll      11'790.66   ← Debit-Summe
 *                   Total Haben     0.00        11'790.66  ← letzter Betrag = Netto-Saldo
 *
 * Ergebnis: eine ParsedCSVRow pro Konto mit dem Netto-Saldo als amount.
 * Mehrseitige Konten (Saldo-Vortrag auf Folgeseite) werden korrekt behandelt.
 */
function parseSageKontoblatt(lines: TextLine[]): ParsedCSVRow[] {
  const accountTotals = new Map<string, { name: string; saldo: number; lineIndex: number; raw: string }>();
  let currentAccount: { number: string; name: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const { text } = lines[i];
    const lower = text.toLowerCase().trim();

    // "Total Haben …  <saldo>" → letzter Betrag auf der Zeile ist der Netto-Saldo
    if (/^total\s+haben\b/i.test(lower) && currentAccount) {
      const lastAmt = findLastAmount(text);
      if (lastAmt) {
        const saldo = parseAmount(lastAmt.raw);
        if (saldo !== null && saldo >= 0) {
          accountTotals.set(currentAccount.number, {
            name:      currentAccount.name,
            saldo:     Math.abs(saldo),
            lineIndex: i + 1,
            raw:       lastAmt.raw,
          });
        }
      }
      currentAccount = null;
      continue;
    }

    // Konto-Header: 4-stellige Zahl am Anfang, gefolgt von Name – kein Betrag dahinter
    const accM = /^\s*(\d{4})\s+(.+)/.exec(text);
    if (accM) {
      const afterNum = accM[2].trim();
      const hasAmount = findLastAmount(afterNum) !== null;
      if (!hasAmount) {
        // Prüfe, dass der Name sinnvoll lang ist (mind. 2 Zeichen, keine reine Zahl)
        const cleanName = afterNum.replace(/^\s+|\s+$/g, '');
        if (cleanName.length >= 2 && !/^\d+$/.test(cleanName)) {
          currentAccount = { number: accM[1], name: cleanName };
        }
      }
    }
  }

  return Array.from(accountTotals.entries())
    .filter(([, v]) => v.saldo > 0)
    .map(([accNum, v]) => ({
      lineIndex:     v.lineIndex,
      rawLine:       `${accNum} ${v.name}  Total Haben ${v.raw}`,
      accountNumber: accNum.padStart(4, '0'),
      accountName:   v.name,
      rawAmount:     v.raw,
      amount:        v.saldo,
    }));
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
  const { month: detectedMonth, year: detectedYear } = detectMonthYear(rawLines);

  // Format-Erkennung: Sage Kontoblatt vs. generisches Kontenblatt
  if (isSageKontoblatt(rawLines)) {
    // Sage Kontoblatt: State-Machine — ein Saldo pro Konto via "Total Haben"-Zeile
    const sageRows = parseSageKontoblatt(allLines);
    rows.push(...sageRows);
    if (sageRows.length > 0) {
      warnings.push(
        `Sage Kontoblatt erkannt: ${sageRows.length} Konten mit Netto-Saldo importiert.`,
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

  return { rows, detectedMonth, detectedYear, pageCount, rawLines, warnings };
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

  // State-Machine: Konto-Header → Buchungszeilen → Total Haben
  const accountTotals = new Map<string, { name: string; saldo: number }>();
  let currentAccount: { number: string; name: string } | null = null;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const col0  = row[0];
    const col1  = row[1];   // BelegNr
    const col3  = String(row[3] ?? '').trim();
    const col6  = row[6];   // Soll-Betrag
    const col7  = row[7];   // Haben-Betrag (falls vorhanden)
    const col10 = row[10];  // Saldo

    // Konto-Header: col0 ist eine 4-stellige Zahl, col6 ist leer
    if (typeof col0 === 'number' && col0 >= 1000 && col0 <= 9999 && !col6 && col3) {
      const cleanName = col3.replace(/^\s+|\s+$/g, '');
      if (cleanName.length >= 2) {
        currentAccount = { number: String(Math.round(col0)), name: cleanName };
      }
      continue;
    }

    // "Total Haben" Zeile: col3 === "Total Haben", col10 = Netto-Saldo
    if ((col3 === 'Total Haben' || col3 === 'Total') && currentAccount) {
      const saldo = typeof col10 === 'number' ? col10
        : parseFloat(String(col10 ?? '0').replace(/[^0-9.-]/g, ''));
      if (!isNaN(saldo) && saldo > 0) {
        accountTotals.set(currentAccount.number, { name: currentAccount.name, saldo });
      }
      currentAccount = null;
      continue;
    }

    // Buchungszeile: col0 ist ein Excel-Datum-Serial (> 40000) oder Datumsstring
    // und wir sind innerhalb eines Konto-Abschnitts
    if (currentAccount && col3) {
      let dateStr = '';
      let isSageBookingLine = false;

      if (typeof col0 === 'number' && col0 > 40000) {
        // Excel date serial
        dateStr = excelSerialToDateStr(col0);
        isSageBookingLine = true;
      } else if (typeof col0 === 'string' && /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(col0)) {
        // Date string already formatted
        dateStr = col0.trim();
        isSageBookingLine = true;
      }

      if (isSageBookingLine) {
        // Parse Soll- und Haben-Beträge
        const sollRaw  = typeof col6 === 'number' ? col6
          : parseAmount(String(col6 ?? '')) ?? 0;
        const habenRaw = typeof col7 === 'number' ? col7
          : parseAmount(String(col7 ?? '')) ?? 0;
        const soll  = Math.abs(sollRaw);
        const haben = Math.abs(habenRaw);
        const amount = soll > 0 ? soll : haben;

        if (amount > 0 && col3 !== 'Saldo' && col3 !== 'Total' && col3 !== 'Total Haben') {
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

  let lineIndex = 0;
  for (const [accNum, { name, saldo }] of accountTotals.entries()) {
    rows.push({
      lineIndex:     ++lineIndex,
      rawLine:       `${accNum} ${name} → Saldo ${saldo.toFixed(2)}`,
      accountNumber: accNum.padStart(4, '0'),
      accountName:   name,
      rawAmount:     saldo.toFixed(2),
      amount:        saldo,
    });
  }

  if (rows.length === 0) {
    warnings.push(
      'Keine Konten gefunden. Prüfe ob das Excel im Sage-Kontoblatt-Format vorliegt ' +
      '(Konto-Header in Spalte A, "Total Haben" in Spalte D, Saldo in Spalte K).',
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
  detectedYear: number;
  warnings: string[];
}

/**
 * Liest ein Sage-Kontoblatt-Excel das einen ganzen Jahr-Zeitraum umfasst
 * (z.B. 01.01.25 – 31.12.25) und gruppiert Buchungszeilen nach Monat.
 *
 * Ergebnis: pro Monat ein Array von ParsedCSVRow[], die dann einzeln über
 * matchCSVRows + buildMonthRecord + saveMonth gespeichert werden können.
 */
export async function parseAnnualSageKontoblattByMonth(
  buffer: ArrayBuffer,
): Promise<AnnualKostenResult> {
  const warnings: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'array' });
  } catch (e) {
    warnings.push(`Excel-Datei konnte nicht geöffnet werden: ${String(e)}`);
    return { byMonth: new Map(), detectedYear: new Date().getFullYear() - 1, warnings };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data: (string | number | null)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as (string | number | null)[][];

  // Jahr aus Kopfzeile "vom: 01.01.25 bis 31.12.25"
  let detectedYear = new Date().getFullYear() - 1;
  const headerLine = String(data[1]?.join(' ') ?? '');
  const sageVomM = headerLine.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (sageVomM) {
    const yy = parseInt(sageVomM[3]);
    detectedYear = yy < 100 ? (yy < 50 ? 2000 + yy : 1900 + yy) : yy;
  }

  // Konten + Buchungszeilen einlesen
  // monthAccountSums: month → accountNumber → { name, soll, haben }
  const monthAccountSums = new Map<number, Map<string, { name: string; soll: number; haben: number }>>();

  let currentAccount: { number: string; name: string } | null = null;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    const col0 = row[0];
    const col3 = String(row[3] ?? '').trim();
    const col6 = row[6];
    const col7 = row[7];

    // Konto-Header: col0 ist 4-stellige Zahl, col6 leer
    if (typeof col0 === 'number' && col0 >= 1000 && col0 <= 9999 && !col6 && col3 && col3.length >= 2) {
      currentAccount = { number: String(Math.round(col0)), name: col3 };
      continue;
    }

    if (!currentAccount) continue;
    if (col3 === 'Total Haben' || col3 === 'Total' || col3 === 'Saldo Vortrag') continue;

    // Buchungszeile: col0 = Datum-String oder Excel-Serial
    let dateStr = '';
    if (typeof col0 === 'number' && col0 > 40000) {
      dateStr = excelSerialToDateStr(col0);
    } else if (typeof col0 === 'string' && /\d{1,2}\.\d{1,2}\.\d{2,4}/.test(col0)) {
      dateStr = col0.trim();
    }

    if (!dateStr) continue;

    // Monat aus Datum extrahieren
    const parts = dateStr.split('.');
    if (parts.length < 2) continue;
    const month = parseInt(parts[1]);
    if (isNaN(month) || month < 1 || month > 12) continue;

    const soll  = typeof col6 === 'number' ? Math.abs(col6) : Math.abs(parseAmount(String(col6 ?? '')) ?? 0);
    const haben = typeof col7 === 'number' ? Math.abs(col7) : Math.abs(parseAmount(String(col7 ?? '')) ?? 0);

    if (soll === 0 && haben === 0) continue;

    if (!monthAccountSums.has(month)) {
      monthAccountSums.set(month, new Map());
    }
    const accounts = monthAccountSums.get(month)!;
    const accKey = currentAccount.number;
    const prev = accounts.get(accKey) ?? { name: currentAccount.name, soll: 0, haben: 0 };
    accounts.set(accKey, {
      name: prev.name,
      soll:  prev.soll  + soll,
      haben: prev.haben + haben,
    });
  }

  if (monthAccountSums.size === 0) {
    warnings.push(
      'Keine Buchungszeilen gefunden. Prüfe ob das Excel im Sage-Kontoblatt-Format vorliegt ' +
      '(Datum in Spalte A, Soll in Spalte G, Haben in Spalte H).',
    );
  }

  // ParsedCSVRow[] pro Monat aufbauen
  const byMonth = new Map<number, ParsedCSVRow[]>();

  for (const [month, accounts] of monthAccountSums.entries()) {
    const rows: ParsedCSVRow[] = [];
    let lineIndex = 0;

    for (const [accNum, { name, soll, haben }] of accounts.entries()) {
      // Für Kosten (Haben-Seite) ist haben relevant; für Erträge (Soll-Seite) soll
      const amount = haben > 0 ? haben : soll;
      if (amount <= 0) continue;

      rows.push({
        lineIndex:     ++lineIndex,
        rawLine:       `${accNum} ${name} → ${amount.toFixed(2)}`,
        accountNumber: accNum.padStart(4, '0'),
        accountName:   name,
        rawAmount:     amount.toFixed(2),
        amount,
      });
    }

    if (rows.length > 0) {
      byMonth.set(month, rows);
    }
  }

  const monthCount = byMonth.size;
  warnings.push(
    `Sage-Jahres-Kontoblatt erkannt: ${monthCount} Monate mit Buchungsdaten (Jahr ${detectedYear}).`,
  );

  return { byMonth, detectedYear, warnings };
}
