/**
 * Mirus PDF Parser — Monatsbericht Arbeitszeiten
 * ================================================
 * Liest Mirus-Monatsblätter (z.B. "Arbeitszeiten Januar 2026 OLIV.pdf")
 * und extrahiert:
 *   - Dokumentkopf (Monat, Jahr, Restaurant, Erstellungsdatum)
 *   - Pro Mitarbeiter: Stammdaten + Tageszeilen + Totale
 *
 * Kein Schreibvorgang — rein diagnostisch.
 *
 * Mirus-Seitenstruktur pro Mitarbeiter:
 *   "Name / Vorname  Müller  Peter"
 *   "Wöchentliche Arbeitszeit in Stunden  42.0"
 *   "Kostenstelle  Service"
 *   "Arbeitsverhältnis  Vollzeit"
 *   "01.02.  So  08:00  17:00  0:30  8:30"   (Tageszeile)
 *   …
 *   "TOTAL  168:30"
 *   "Zeitzuschlag  2:00"
 *   "Überzeit  …"
 *   "Unterschrift ______"
 */

import * as pdfjsLib from 'pdfjs-dist';

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
}

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface MirusTextItem {
  x: number;
  y: number;
  text: string;
}

export interface MirusLine {
  y: number;
  items: MirusTextItem[];
  text: string;
  pageNum: number;
}

export interface MirusDayRow {
  lineText: string;
  lineIndex: number;
  date: string | null;
  weekday: string | null;
  timeBlocks: { from: string; to: string }[];
  pause: string | null;
  totalHours: string | null;
  absenceCodes: string[];
  nightSupplement: boolean;
  remark: string | null;
  confidence: 'high' | 'medium' | 'low';
  uncertain: boolean;
}

export interface MirusTotals {
  totalHours: string | null;
  pauseTotal: string | null;
  nettoTotal: string | null;
  zeitzuschlag: string | null;
  ueberzeit: string | null;
  saldo: string | null;
  signatureFound: boolean;
  rawLines: string[];
}

export interface MirusEmployee {
  name: string | null;
  personalnummer: string | null;
  kostenstelle: string | null;
  department: string | null;
  employment: string | null;
  weeklyHours: string | null;
  dayRows: MirusDayRow[];
  totals: MirusTotals;
  rawLines: string[];
  uncertainRows: number;
  startLine: number;
  endLine: number;
}

export interface MirusParsedDocument {
  month: number | null;
  monthName: string | null;
  year: number | null;
  restaurant: string | null;
  creationDate: string | null;
  employees: MirusEmployee[];
  allLines: MirusLine[];
  warnings: string[];
  quality: {
    totalEmployees: number;
    totalDayRows: number;
    uncertainRows: number;
    unassignedTotals: number;
    qualityPercent: number;
  };
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAYS_SHORT_UPPER = WEEKDAYS_SHORT.map(w => w.toUpperCase());

const ABSENCE_CODES = [
  'FE', 'FR', 'KR', 'UN', 'UE', 'GF', 'AB', 'MU', 'MA',
  'BU', 'JU', 'KO', 'AZ', 'ML', 'UU', 'BL', 'ZA', 'NU', 'WK',
  'KI', 'SU', 'FL',
];

const MONTH_MAP: Record<string, number> = {
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

const MONTH_NAMES_DE = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function parseTimeHHMM(s: string): string | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (h > 99 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Alle HH:MM-Werte aus einem Text extrahieren, in Reihenfolge.
 */
function allTimesInText(text: string): string[] {
  return [...text.matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => m[1]);
}

/**
 * Zeitblöcke extrahieren.
 * Strategie 1: explizite Range "HH:MM - HH:MM"
 * Strategie 2: Mirus-Spalten-Format — erste zwei Zeiten >= 05:xx als From/To,
 *              Rest (kleine Werte) als Pause/Total.
 */
function extractTimeBlocks(text: string): { from: string; to: string }[] {
  const blocks: { from: string; to: string }[] = [];

  // Strategie 1: explizite Range mit Bindestrich
  const rangeRe = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const from = parseTimeHHMM(m[1]);
    const to   = parseTimeHHMM(m[2]);
    if (from && to) blocks.push({ from, to });
  }
  if (blocks.length > 0) return blocks;

  // Strategie 2: Mirus-Spalten (Zellen nebeneinander ohne Dash)
  // Arbeitsbeginn und -ende sind typischerweise >= 05:00
  const times = allTimesInText(text);
  const workTimes = times.filter(t => {
    const h = parseInt(t.split(':')[0]);
    return h >= 5;  // echte Arbeitszeiten, nicht Pause (0:30) oder kurze Totale
  });

  if (workTimes.length >= 2) {
    const from = parseTimeHHMM(workTimes[0]);
    const to   = parseTimeHHMM(workTimes[1]);
    if (from && to) blocks.push({ from, to });
  }

  return blocks;
}

/**
 * Absenzcodes erkennen — nur als eigenständige Tokens (nicht Teilwort).
 */
function extractAbsenceCodes(text: string): string[] {
  const found: string[] = [];
  for (const code of ABSENCE_CODES) {
    // Wort-Grenze, case-sensitive für 2-Buchstaben-Codes
    if (new RegExp(`(?<![A-Za-z])${code}(?![A-Za-z])`).test(text)) {
      found.push(code);
    }
  }
  return found;
}

/**
 * Pause extrahieren — kleine Zeitwerte (0:xx oder 1:xx).
 */
function extractPause(text: string): string | null {
  // Explicit label
  const labeled = text.match(/Pause\s*:?\s*(\d{1,3}:\d{2})/i);
  if (labeled) return labeled[1];

  // Erster Zeitwert mit Stunden 0 oder 1 — typisch für Pause
  const times = allTimesInText(text);
  for (const t of times) {
    const h = parseInt(t.split(':')[0]);
    if (h === 0 || h === 1) return t;
  }
  return null;
}

/**
 * Totalstunden extrahieren — letzter Zeitwert >= 2:00 (echter Arbeitstag),
 * oder der einzige Wert wenn nichts anderes passt.
 */
function extractTotalHours(text: string, timeBlocks: { from: string; to: string }[]): string | null {
  const usedTimes = new Set(timeBlocks.flatMap(b => [b.from, b.to]));
  const times = allTimesInText(text).filter(t => !usedTimes.has(t) && !usedTimes.has(parseTimeHHMM(t) ?? ''));

  // Bevorzuge Werte >= 2:00 (echter Arbeitstag) und < 24:00
  for (let i = times.length - 1; i >= 0; i--) {
    const h = parseInt(times[i].split(':')[0]);
    if (h >= 2 && h < 24) return times[i];
  }
  if (times.length > 0) return times[times.length - 1];
  return null;
}

/**
 * Wochentag aus Text, Rückgabe immer als 2-Buchstaben-Kürzel.
 */
function detectWeekday(text: string): string | null {
  // Suche nur nach eigenständigen 2-Buchstaben-Abkürzungen
  for (const wd of WEEKDAYS_SHORT) {
    if (new RegExp(`(?<![A-Za-z])${wd}(?![A-Za-z])`).test(text)) return wd;
  }
  // Uppercase-Varianten
  for (const wd of WEEKDAYS_SHORT_UPPER) {
    if (new RegExp(`(?<![A-Za-z])${wd}(?![A-Za-z])`).test(text)) {
      return wd.charAt(0) + wd.charAt(1).toLowerCase();
    }
  }
  return null;
}

function detectDepartment(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes('service') || lower.includes('saal') || lower.includes('restaurant')) return 'service';
  if (lower.includes('küche') || lower.includes('kueche') || lower.includes('kitchen') || lower.includes('cuisine')) return 'küche';
  if (lower.includes('bar') || lower.includes('bistro') || lower.includes('café') || lower.includes('cafe')) return 'service';
  return null;
}

// ─── PDF Text-Extraktion ──────────────────────────────────────────────────────

async function extractAllLines(file: File): Promise<MirusLine[]> {
  const buffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const allLines: MirusLine[] = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const textContent = await page.getTextContent();
    const lineMap = new Map<number, MirusTextItem[]>();

    for (const rawItem of textContent.items) {
      if (!('str' in rawItem)) continue;
      const item = rawItem as pdfjsLib.TextItem;
      if (!item.str.trim()) continue;

      const x    = item.transform[4];
      const yRaw = item.transform[5];

      // Y-Toleranz: Items innerhalb von 4 Punkten gelten als gleiche Zeile
      let matchedY: number | null = null;
      for (const existY of lineMap.keys()) {
        if (Math.abs(existY - yRaw) <= 4) { matchedY = existY; break; }
      }
      const key = matchedY ?? Math.round(yRaw);
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key)!.push({ x, y: yRaw, text: item.str });
    }

    // Oben nach unten sortieren (PDF: höhere Y = weiter oben)
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      // Einzelne Zellen mit 2 Leerzeichen verbinden, mehrfache Spaces komprimieren
      const text = items.map(i => i.text).join('  ').replace(/\s{3,}/g, '  ').trim();
      if (text) allLines.push({ y, items, text, pageNum: p });
    }
  }

  return allLines;
}

// ─── Dokument-Metadaten ───────────────────────────────────────────────────────

function detectDocumentMeta(lines: MirusLine[]): {
  month: number | null; monthName: string | null;
  year: number | null; restaurant: string | null; creationDate: string | null;
} {
  let month: number | null = null;
  let monthName: string | null = null;
  let year: number | null = null;
  let restaurant: string | null = null;
  let creationDate: string | null = null;

  // Ersten 40 Zeilen prüfen
  const head = lines.slice(0, 40);

  for (const line of head) {
    const t = line.text;

    // Erstellungsdatum
    const cdM = t.match(/(?:Erstellt|Druckdatum|Gedruckt|Datum)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (cdM && !creationDate) creationDate = cdM[1];

    // Standalone Datum DD.MM.YYYY
    if (!creationDate) {
      const d = t.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/);
      if (d) creationDate = d[1];
    }

    // Jahr
    const yM = t.match(/\b(202[0-9])\b/);
    if (yM && !year) year = parseInt(yM[1]);

    // Monat aus Monatsnamen
    if (!month) {
      for (const [name, num] of Object.entries(MONTH_MAP)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(t)) {
          month = num;
          monthName = MONTH_NAMES_DE[num] ?? null;
          break;
        }
      }
    }

    // Restaurant-Name
    if (!restaurant) {
      if (/\bOLIV\b/.test(t)) restaurant = 'OLIV';
      else if (/\bBeaulieu\b/i.test(t)) restaurant = 'Beaulieu';
    }
    if (!restaurant) {
      const rM = t.match(/(?:Restaurant|Betrieb)\s*:?\s*([A-ZÄÖÜa-z0-9\s-]{2,30})/i);
      if (rM) restaurant = rM[1].trim();
    }
  }

  return { month, monthName, year, restaurant, creationDate };
}

// ─── Mitarbeiter-Grenzen finden ───────────────────────────────────────────────

/**
 * Primäres Signal in Mirus-PDFs: jede Seite beginnt mit "Name / Vorname".
 * Fallback: "Mitarbeiter:", "Personal-Nr.", Kostenstelle-Nähe.
 */
function findEmployeeBoundaries(lines: MirusLine[]): number[] {
  const boundaries: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;

    // ── PRIMÄR: Mirus-Format "Name / Vorname ..." ──────────────────────────
    if (/Name\s*\/\s*Vorname/i.test(t)) {
      boundaries.push(i);
      continue;
    }

    // ── Fallback 1: "Mitarbeiter: ..." / "MA: ..." ─────────────────────────
    if (/^(Mitarbeiter|Mitarbeiterin|MA)\s*:/i.test(t)) {
      boundaries.push(i);
      continue;
    }

    // ── Fallback 2: Personalnummer-Zeile ───────────────────────────────────
    if (/Personal.?Nr\.?\s*:|P\.?Nr\.?\s*:/i.test(t) && /\d{3,}/.test(t)) {
      boundaries.push(i);
      continue;
    }
  }

  return [...new Set(boundaries)].sort((a, b) => a - b);
}

// ─── Mitarbeiter-Kopfzeile parsen ─────────────────────────────────────────────

/**
 * Liest bis zu 12 Zeilen ab startIdx und extrahiert Stammdaten.
 *
 * Erwartete Zeilen (Mirus-Format):
 *   "Name / Vorname  Müller  Peter"           → name
 *   "Wöchentliche Arbeitszeit in Stunden  42.0" → weeklyHours
 *   "Kostenstelle  Service / Saal"            → kostenstelle + department
 *   "Arbeitsverhältnis  Vollzeit"             → employment
 *   "Personal-Nr.  12345"                     → personalnummer
 */
function parseEmployeeHeader(lines: MirusLine[], startIdx: number): Partial<MirusEmployee> {
  const result: Partial<MirusEmployee> = {
    name: null, personalnummer: null, kostenstelle: null,
    department: null, employment: null, weeklyHours: null,
  };

  const windowLines = lines.slice(startIdx, startIdx + 12);

  for (let i = 0; i < windowLines.length; i++) {
    const t = windowLines[i].text;

    // ── Name / Vorname ─────────────────────────────────────────────────────
    if (/Name\s*\/\s*Vorname/i.test(t) && !result.name) {
      // Alles nach dem Label "Name / Vorname" ist der Name
      const after = t.replace(/Name\s*\/\s*Vorname\s*/i, '').trim();
      if (after.length >= 2) {
        result.name = after;
      } else {
        // Name könnte auf nächster Zeile stehen
        const next = windowLines[i + 1]?.text.trim() ?? '';
        if (next && !/Kostenstelle|Arbeitsverhältnis|Wöchentliche|TOTAL|^\d{1,2}\./i.test(next)) {
          result.name = next;
        }
      }
      continue;
    }

    // ── Wöchentliche Arbeitszeit ───────────────────────────────────────────
    if (/Wöchentliche/i.test(t) && !result.weeklyHours) {
      // Zahl mit Dezimalpunkt/Komma
      const num = t.match(/(\d+[.,]\d+)/);
      if (num) {
        result.weeklyHours = num[1].replace(',', '.');
      } else {
        // Ganzzahl am Ende: "... 42 Std"
        const intNum = t.match(/(\d{2,3})\s*(?:Std\.?|h|Stunden)?$/i);
        if (intNum) result.weeklyHours = intNum[1];
      }
      continue;
    }

    // ── Kostenstelle ───────────────────────────────────────────────────────
    if (/Kostenstelle/i.test(t) && !/Kostenstelle\s*Firma/i.test(t) && !result.kostenstelle) {
      const after = t.replace(/Kostenstelle\s*:?\s*/i, '').trim();
      if (after.length >= 1) {
        result.kostenstelle = after;
        if (!result.department) result.department = detectDepartment(after);
      }
      continue;
    }

    // ── Arbeitsverhältnis ──────────────────────────────────────────────────
    if (/Arbeitsverhältnis/i.test(t) && !result.employment) {
      const after = t.replace(/Arbeitsverhältnis\s*:?\s*/i, '').trim();
      if (after.length >= 2) result.employment = after;
      continue;
    }

    // ── Personal-Nr. ───────────────────────────────────────────────────────
    if (/Personal.?Nr\.?/i.test(t) && !result.personalnummer) {
      const pnr = t.match(/Personal.?Nr\.?\s*:?\s*(\d{1,8})/i);
      if (pnr) result.personalnummer = pnr[1];
      continue;
    }
  }

  return result;
}

// ─── Tageszeile erkennen ──────────────────────────────────────────────────────

/**
 * Erkennt Mirus-Tageszeilen.
 * Mögliche Formate:
 *   "01.02.  So  08:00  17:00  0:30  8:30"
 *   "01.02.  So  FE  8:00"
 *   "01.02. So"
 *   "1.2. Mo  08:00 - 16:00  0:30  7:30"
 */
function isDayRow(text: string): boolean {
  // Muss mit DD.MM. oder D.M. beginnen (mit optionalem führendem Leerzeichen)
  return /^\s*\d{1,2}\.\d{1,2}\.?\s/.test(text) ||
         /^\s*\d{1,2}\.\d{1,2}\.?$/.test(text.trim());
}

function parseDayRow(line: MirusLine, lineIndex: number): MirusDayRow {
  const t = line.text;

  // ── Datum ────────────────────────────────────────────────────────────────
  const dateMatch = t.match(/^\s*(\d{1,2})\.(\d{1,2})\.?(?:\s|$)/);
  let date: string | null = null;
  if (dateMatch) {
    const d = dateMatch[1].padStart(2, '0');
    const mo = dateMatch[2].padStart(2, '0');
    date = `${d}.${mo}`;
  }

  // ── Wochentag ────────────────────────────────────────────────────────────
  const weekday = detectWeekday(t);

  // ── Absenz-Codes ─────────────────────────────────────────────────────────
  const absenceCodes = extractAbsenceCodes(t);

  // ── Zeitblöcke ───────────────────────────────────────────────────────────
  // Nicht suchen wenn Absenz-Code die ganzen Stunden erklärt
  const timeBlocks = extractTimeBlocks(t);

  // ── Nachtzuschlag ────────────────────────────────────────────────────────
  const nightSupplement = /(?<![A-Za-z])N(?![A-Za-z])/.test(t);

  // ── Pause ────────────────────────────────────────────────────────────────
  const pause = extractPause(t);

  // ── Totalstunden ─────────────────────────────────────────────────────────
  const totalHours = extractTotalHours(t, timeBlocks);

  // ── Bemerkung ────────────────────────────────────────────────────────────
  let remark: string | null = null;
  const remarkM = t.match(/(?:Bemerkung|Bem\.?|Notiz)\s*:?\s*(.+)$/i);
  if (remarkM) remark = remarkM[1].trim();

  // ── Konfidenz ────────────────────────────────────────────────────────────
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!date) {
    confidence = 'low';
  } else if (!weekday && timeBlocks.length === 0 && absenceCodes.length === 0) {
    confidence = 'low';
  } else if (!weekday) {
    confidence = 'medium';
  } else if (timeBlocks.length === 0 && absenceCodes.length === 0 && !totalHours) {
    confidence = 'medium';
  }

  return {
    lineText: t,
    lineIndex,
    date,
    weekday,
    timeBlocks,
    pause,
    totalHours,
    absenceCodes,
    nightSupplement,
    remark,
    confidence,
    uncertain: confidence !== 'high',
  };
}

// ─── Totale parsen ────────────────────────────────────────────────────────────

function parseTotals(lines: string[]): MirusTotals {
  const totals: MirusTotals = {
    totalHours: null, pauseTotal: null, nettoTotal: null,
    zeitzuschlag: null, ueberzeit: null, saldo: null,
    signatureFound: false, rawLines: [],
  };

  for (const line of lines) {
    const allHHMM = allTimesInText(line);
    const lastHHMM = allHHMM.length > 0 ? allHHMM[allHHMM.length - 1] : null;

    // Unterschrift
    if (/unterschrift|visum/i.test(line)) {
      totals.signatureFound = true;
    }

    // TOTAL-Zeile (Hauptzeile)
    if (/^\s*TOTAL\b/i.test(line) && !totals.totalHours) {
      totals.totalHours = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Total Stunden (alternative Schreibweisen)
    if (/total.*(stunden|std)|stunden.?total|gesamt.*(stunden|std)/i.test(line) && !totals.totalHours) {
      totals.totalHours = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Pause Total
    if (/pause.*total|total.*pause|pause.*gesamt|gesamt.*pause/i.test(line) && !totals.pauseTotal) {
      totals.pauseTotal = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Netto / Nettoarbeitszeit
    if (/\bnetto\b/i.test(line) && !totals.nettoTotal) {
      totals.nettoTotal = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Zeitzuschlag
    if (/zeitzuschlag|zeit.?zuschlag/i.test(line) && !totals.zeitzuschlag) {
      totals.zeitzuschlag = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Überzeit / Überstunden
    if (/überzeit|uberzeit|überstunden|ueberzeit/i.test(line) && !totals.ueberzeit) {
      totals.ueberzeit = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Saldo (kann positiv oder negativ sein)
    if (/\bsaldo\b/i.test(line) && !totals.saldo) {
      const sM = line.match(/([+-]?\d{1,3}:\d{2})/);
      totals.saldo = sM ? sM[1] : lastHHMM;
      totals.rawLines.push(line);
      continue;
    }

    // Stunden als alleinstehende Zeile: "Stunden  168:30"
    if (/^\s*Stunden\b/i.test(line) && !totals.totalHours && lastHHMM) {
      totals.totalHours = lastHHMM;
      totals.rawLines.push(line);
      continue;
    }
  }

  return totals;
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

export async function parseMirusPDF(file: File): Promise<MirusParsedDocument> {
  const warnings: string[] = [];

  // 1. Text extrahieren
  let allLines: MirusLine[];
  try {
    allLines = await extractAllLines(file);
  } catch (err) {
    throw new Error(`PDF konnte nicht gelesen werden: ${String(err)}`);
  }

  if (allLines.length === 0) {
    throw new Error('PDF enthält keinen extrahierbaren Text (möglicherweise ein gescanntes Bild-PDF).');
  }

  // 2. Dokument-Metadaten
  const meta = detectDocumentMeta(allLines);
  if (!meta.month)      warnings.push('Monat konnte nicht erkannt werden.');
  if (!meta.year)       warnings.push('Jahr konnte nicht erkannt werden.');
  if (!meta.restaurant) warnings.push('Restaurant-Name konnte nicht erkannt werden.');

  // 3. Mitarbeiter-Grenzen finden
  const rawTexts  = allLines.map(l => l.text);
  const boundaries = findEmployeeBoundaries(allLines);

  if (boundaries.length === 0) {
    warnings.push('Keine "Name / Vorname"-Zeile gefunden — prüfe den Rohtext.');
    boundaries.push(0);
  }

  // 4. Mitarbeiter parsen
  const employees: MirusEmployee[] = [];

  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b];
    const endIdx   = b + 1 < boundaries.length ? boundaries[b + 1] : allLines.length;

    const sectionLines = allLines.slice(startIdx, endIdx);
    const sectionTexts = rawTexts.slice(startIdx, endIdx);

    const header = parseEmployeeHeader(allLines, startIdx);

    const dayRows: MirusDayRow[] = [];
    const totalsLines: string[]  = [];
    let inTotals = false;

    for (let i = 0; i < sectionLines.length; i++) {
      const line = sectionLines[i];
      const t = line.text;

      // Totale beginnen ab TOTAL-Zeile oder "Unterschrift"
      if (!inTotals && /^\s*TOTAL\b/i.test(t)) {
        inTotals = true;
      }
      if (!inTotals && /unterschrift|zeitzuschlag|überzeit|\bsaldo\b|netto.*stunden|stunden.*netto/i.test(t)) {
        inTotals = true;
      }

      if (inTotals) {
        totalsLines.push(t);
        continue;
      }

      if (isDayRow(t)) {
        dayRows.push(parseDayRow(line, startIdx + i));
      }
    }

    // Fallback für Totale: letzte 20 Zeilen
    const totals = parseTotals(
      totalsLines.length > 0 ? totalsLines : sectionTexts.slice(-20)
    );

    const uncertainRows = dayRows.filter(r => r.uncertain).length;

    employees.push({
      ...header,
      name:           header.name           ?? `Mitarbeiter ${b + 1}`,
      personalnummer: header.personalnummer  ?? null,
      kostenstelle:   header.kostenstelle    ?? null,
      department:     header.department      ?? null,
      employment:     header.employment      ?? null,
      weeklyHours:    header.weeklyHours     ?? null,
      dayRows,
      totals,
      rawLines:     sectionTexts,
      uncertainRows,
      startLine:    startIdx,
      endLine:      endIdx - 1,
    });
  }

  // 5. Qualitäts-Metriken
  const totalDayRows    = employees.reduce((s, e) => s + e.dayRows.length, 0);
  const uncertainRows   = employees.reduce((s, e) => s + e.uncertainRows, 0);
  const unassignedTotals = employees.filter(e =>
    !e.totals.totalHours && !e.totals.zeitzuschlag
  ).length;

  let qualityPercent = 0;
  if (employees.length > 0 && totalDayRows > 0) {
    const empOk   = employees.filter(e => e.name && e.name !== `Mitarbeiter ${employees.indexOf(e) + 1}`).length;
    const highRows = employees.reduce((s, e) => s + e.dayRows.filter(r => r.confidence === 'high').length, 0);
    const totalsOk = employees.filter(e => !!e.totals.totalHours).length;

    const empScore    = (empOk / employees.length) * 25;
    const rowScore    = (highRows / totalDayRows) * 50;
    const totalsScore = (totalsOk / employees.length) * 25;
    qualityPercent = Math.round(empScore + rowScore + totalsScore);
  }

  return {
    ...meta,
    employees,
    allLines,
    warnings,
    quality: { totalEmployees: employees.length, totalDayRows, uncertainRows, unassignedTotals, qualityPercent },
  };
}
