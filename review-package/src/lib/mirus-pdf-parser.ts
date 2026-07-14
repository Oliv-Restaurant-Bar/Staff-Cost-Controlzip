/**
 * Mirus PDF Parser — Monatsbericht Arbeitszeiten
 * ================================================
 * Liest Mirus-Monatsblätter und extrahiert Stammdaten + Tageszeilen + Totale.
 * Kein Schreibvorgang — rein diagnostisch.
 *
 * Erkannte Mirus-Spalten-Struktur (pdfjs fasst gleiche Y-Zeile zusammen):
 *   "Name / Vorname  Bedzeti  Mensur  Wöchentliche Arbeitszeit in Stunden  42.0"
 *   "Kostenstelle  1 Küche  Arbeitsverhältnis  Vollzeit  01.01.2026 - …"
 *   "01.01. Do  10:00-14:00  Küche  9.00  0.58  8.42"   ← Dezimalstunden!
 *   "TOTAL  168.50"
 */

import * as pdfjsLib from 'pdfjs-dist';

if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
}

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface MirusTextItem { x: number; y: number; text: string; }

export interface MirusLine {
  y: number; items: MirusTextItem[]; text: string; pageNum: number;
}

export interface MirusDayRow {
  lineText: string;
  lineIndex: number;
  date: string | null;
  weekday: string | null;
  timeBlocks: { from: string; to: string }[];
  pause: string | null;        // Dezimal-Stunden-String, z.B. "0.58"
  totalHours: string | null;   // Netto-Stunden, z.B. "8.42"
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

const ABSENCE_CODES = [
  'FE', 'FR', 'KR', 'UN', 'UE', 'GF', 'AB', 'MU', 'MA',
  'BU', 'JU', 'KO', 'AZ', 'ML', 'UU', 'BL', 'ZA', 'NU', 'WK', 'KI', 'SU', 'FL',
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
  const h = parseInt(m[1]), min = parseInt(m[2]);
  if (h > 99 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Zeitblöcke im Format HH:MM-HH:MM oder HH:MM – HH:MM extrahieren.
 * Mirus schreibt oft ohne Leerzeichen um den Dash.
 */
function extractTimeBlocks(text: string): { from: string; to: string }[] {
  const blocks: { from: string; to: string }[] = [];
  const re = /(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = parseTimeHHMM(m[1]);
    const to   = parseTimeHHMM(m[2]);
    if (from && to) blocks.push({ from, to });
  }
  return blocks;
}

/**
 * Dezimalstunden extrahieren (Mirus-Format): X.XX (genau 2 Nachkommastellen).
 * Datums-Pattern (DD.MM.) wird durch negative Lookahead ausgeschlossen.
 *
 * Rückgabe: [brutto?, pause?, netto?] — letzte Zahl = Netto, kleinste mittlere = Pause
 */
function extractDecimalHours(text: string): {
  brutto: string | null; pause: string | null; netto: string | null;
} {
  // Nur exakt 2 Nachkommastellen, nicht gefolgt von weiterer Ziffer oder Punkt (kein Datum DD.MM.YYYY)
  const re = /(?<![.\d])(\d{1,2})\.(\d{2})(?![.\d])/g;
  const vals: number[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(`${m[1]}.${m[2]}`);
    if (v >= 0 && v <= 24) vals.push(v);
  }

  if (vals.length === 0) return { brutto: null, pause: null, netto: null };
  if (vals.length === 1) return { brutto: vals[0].toFixed(2), pause: null, netto: vals[0].toFixed(2) };
  if (vals.length === 2) return { brutto: vals[0].toFixed(2), pause: null, netto: vals[1].toFixed(2) };

  // 3+ Werte: brutto, pause, netto (Pause ist typisch 0.xx)
  const brutto = vals[0].toFixed(2);
  const netto  = vals[vals.length - 1].toFixed(2);
  // Pause: erster Wert < 2 zwischen brutto und netto
  const pauseVal = vals.slice(1, -1).find(v => v < 2.0) ?? vals[1];
  return { brutto, pause: pauseVal.toFixed(2), netto };
}

/**
 * Absenzcodes als eigenständige Token (keine Teilwörter).
 */
function extractAbsenceCodes(text: string): string[] {
  const found: string[] = [];
  for (const code of ABSENCE_CODES) {
    if (new RegExp(`(?<![A-Za-z])${code}(?![A-Za-z])`).test(text)) found.push(code);
  }
  return found;
}

function detectWeekday(text: string): string | null {
  for (const wd of WEEKDAYS_SHORT) {
    if (new RegExp(`(?<![A-Za-z])${wd}(?![A-Za-z])`).test(text)) return wd;
  }
  return null;
}

function detectDepartment(text: string): string | null {
  const l = text.toLowerCase();
  if (l.includes('service') || l.includes('saal') || l.includes('restaurant')) return 'service';
  if (l.includes('küche') || l.includes('kueche') || l.includes('kitchen')) return 'küche';
  if (l.includes('bar') || l.includes('bistro') || l.includes('café') || l.includes('cafe')) return 'service';
  return null;
}

// ─── PDF Text-Extraktion ──────────────────────────────────────────────────────

async function extractAllLines(file: File): Promise<MirusLine[]> {
  const buffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const allLines: MirusLine[] = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const lineMap = new Map<number, MirusTextItem[]>();

    for (const rawItem of content.items) {
      if (!('str' in rawItem)) continue;
      const item = rawItem as pdfjsLib.TextItem;
      if (!item.str.trim()) continue;
      const x = item.transform[4], yRaw = item.transform[5];

      let matchedY: number | null = null;
      for (const ey of lineMap.keys()) {
        if (Math.abs(ey - yRaw) <= 4) { matchedY = ey; break; }
      }
      const key = matchedY ?? Math.round(yRaw);
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key)!.push({ x, y: yRaw, text: item.str });
    }

    for (const y of Array.from(lineMap.keys()).sort((a, b) => b - a)) {
      const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      const text  = items.map(i => i.text).join('  ').replace(/\s{3,}/g, '  ').trim();
      if (text) allLines.push({ y, items, text, pageNum: p });
    }
  }

  return allLines;
}

// ─── Dokument-Metadaten ───────────────────────────────────────────────────────

function detectDocumentMeta(lines: MirusLine[]) {
  let month: number | null = null, monthName: string | null = null;
  let year: number | null = null, restaurant: string | null = null;
  let creationDate: string | null = null;

  for (const line of lines.slice(0, 40)) {
    const t = line.text;
    const cdM = t.match(/(?:Erstellt|Druckdatum|Gedruckt|Datum)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (cdM && !creationDate) creationDate = cdM[1];
    if (!creationDate) { const d = t.match(/\b(\d{1,2}\.\d{1,2}\.\d{4})\b/); if (d) creationDate = d[1]; }
    const yM = t.match(/\b(202[0-9])\b/); if (yM && !year) year = parseInt(yM[1]);
    if (!month) {
      for (const [name, num] of Object.entries(MONTH_MAP)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(t)) { month = num; monthName = MONTH_NAMES_DE[num]; break; }
      }
    }
    if (!restaurant) {
      if (/\bOLIV\b/.test(t)) restaurant = 'OLIV';
      else if (/\bBeaulieu\b/i.test(t)) restaurant = 'Beaulieu';
    }
    if (!restaurant) { const rM = t.match(/(?:Restaurant|Betrieb)\s*:?\s*([A-ZÄÖÜa-z0-9\s-]{2,30})/i); if (rM) restaurant = rM[1].trim(); }
  }
  return { month, monthName, year, restaurant, creationDate };
}

// ─── Mitarbeiter-Grenzen ──────────────────────────────────────────────────────

function findEmployeeBoundaries(lines: MirusLine[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (/Name\s*\/\s*Vorname/i.test(t)) { boundaries.push(i); continue; }
    if (/^(Mitarbeiter|Mitarbeiterin|MA)\s*:/i.test(t)) { boundaries.push(i); continue; }
    if (/Personal.?Nr\.?\s*:/i.test(t) && /\d{3,}/.test(t)) { boundaries.push(i); continue; }
  }
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

// ─── Mitarbeiter-Kopfzeile ────────────────────────────────────────────────────

/**
 * Mirus legt Header-Felder als 2-Spalten-Grid an.
 * pdfjs fasst gleiche Y-Koordinaten zusammen, daher landen Label + Wert
 * (und ggf. zweite Spalte) in einer einzigen Textzeile:
 *
 *   "Name / Vorname  Bedzeti  Mensur  Wöchentliche Arbeitszeit in Stunden  42.0"
 *   "Kostenstelle  1 Küche  Arbeitsverhältnis  Vollzeit  01.01.2026 - 31.12.2026"
 *
 * → Splitten an den bekannten Schlüsselwörtern.
 */
function parseEmployeeHeader(lines: MirusLine[], startIdx: number): Partial<MirusEmployee> {
  const result: Partial<MirusEmployee> = {
    name: null, personalnummer: null, kostenstelle: null,
    department: null, employment: null, weeklyHours: null,
  };

  const windowLines = lines.slice(startIdx, startIdx + 15);

  for (const line of windowLines) {
    const t = line.text;

    // ── "Name / Vorname  Bedzeti Mensur  Wöchentliche Arbeitszeit in Stunden  42.0" ──
    if (/Name\s*\/\s*Vorname/i.test(t) && !result.name) {
      // Alles nach "Name / Vorname" und vor "Wöchentliche" (oder Zeilenende)
      const afterLabel = t.replace(/.*Name\s*\/\s*Vorname\s*/i, '');
      const wochIdx = afterLabel.search(/Wöchentliche/i);
      const namePart = (wochIdx >= 0 ? afterLabel.slice(0, wochIdx) : afterLabel)
        .replace(/\s{2,}/g, ' ').trim();

      // Name enthält nur Buchstaben, Leerzeichen, Bindestriche, Apostrophe
      result.name = namePart.replace(/[^A-ZÄÖÜa-zäöü\s'\-]/g, '').trim() || namePart.trim();

      // Wochenstunden aus demselben "Wöchentliche"-Abschnitt
      if (wochIdx >= 0) {
        const wochPart = afterLabel.slice(wochIdx);
        const numM = wochPart.match(/(\d+[.,]\d+)/);
        if (numM && !result.weeklyHours) result.weeklyHours = numM[1].replace(',', '.');
      }
      continue;
    }

    // ── "Kostenstelle  1 Küche  Arbeitsverhältnis  Vollzeit  01.01.2026 …" ──
    if (/Kostenstelle/i.test(t) && !/Kostenstelle\s*Firma/i.test(t) && !result.kostenstelle) {
      const afterLabel = t.replace(/.*Kostenstelle\s*/i, '');
      const avIdx = afterLabel.search(/Arbeitsverhältnis/i);

      let ksPart = (avIdx >= 0 ? afterLabel.slice(0, avIdx) : afterLabel).trim();
      // Nummer + Abteilungsname: "1 Küche" oder "2 Service" — kürzen wenn zu lang
      ksPart = ksPart.replace(/\s{2,}/g, ' ').trim();
      // Max. 30 Zeichen, kein Datum, kein Vollzeit/Teilzeit drin
      ksPart = ksPart.replace(/\s*(Vollzeit|Teilzeit|\d{2}\.\d{2}\.\d{4}).*/i, '').trim();
      result.kostenstelle = ksPart.slice(0, 30).trim();
      if (!result.department) result.department = detectDepartment(ksPart);

      if (avIdx >= 0) {
        const empPart = afterLabel.slice(avIdx)
          .replace(/Arbeitsverhältnis\s*/i, '')
          // Datum-Range entfernen: "01.01.2026 - 31.12.2026"
          .replace(/\s*\d{2}\.\d{2}\.\d{4}\s*[-–]?\s*\d{0,2}\.?\d{0,2}\.?\d{0,4}\s*/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        result.employment = empPart.slice(0, 30).trim();
      }
      continue;
    }

    // ── Fallback: separate "Wöchentliche …" Zeile ──────────────────────────
    if (/Wöchentliche/i.test(t) && !result.weeklyHours) {
      const numM = t.match(/(\d+[.,]\d+)/);
      if (numM) result.weeklyHours = numM[1].replace(',', '.');
      continue;
    }

    // ── Arbeitsverhältnis auf eigener Zeile ────────────────────────────────
    if (/Arbeitsverhältnis/i.test(t) && !result.employment) {
      const after = t.replace(/.*Arbeitsverhältnis\s*/i, '')
        .replace(/\s*\d{2}\.\d{2}\.\d{4}.*/g, '').trim();
      if (after.length >= 2) result.employment = after.slice(0, 30);
      continue;
    }

    // ── Personal-Nr. ───────────────────────────────────────────────────────
    if (/Personal.?Nr\.?/i.test(t) && !result.personalnummer) {
      const pnr = t.match(/Personal.?Nr\.?\s*:?\s*(\d{1,8})/i);
      if (pnr) result.personalnummer = pnr[1];
    }
  }

  return result;
}

// ─── Tageszeile ───────────────────────────────────────────────────────────────

function isDayRow(text: string): boolean {
  return /^\s*\d{1,2}\.\d{1,2}\.?\s/.test(text) ||
         /^\s*\d{1,2}\.\d{1,2}\.?$/.test(text.trim());
}

/** Zeile die nur einen Zeitblock enthält (Fortsetzung Vortagszeile) */
function isTimeContinuationLine(text: string): boolean {
  return !isDayRow(text) &&
    /^\s*\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}/.test(text);
}

function parseDayRow(line: MirusLine, lineIndex: number): MirusDayRow {
  const t = line.text;

  // ── Datum ─────────────────────────────────────────────────────────────────
  const dateM = t.match(/^\s*(\d{1,2})\.(\d{1,2})\.?\s*/);
  let date: string | null = null;
  let rest = t;
  if (dateM) {
    date = `${dateM[1].padStart(2, '0')}.${dateM[2].padStart(2, '0')}`;
    rest = t.slice(dateM[0].length);  // alles nach Datum
  }

  // ── Wochentag ─────────────────────────────────────────────────────────────
  const weekday = detectWeekday(rest);
  if (weekday) rest = rest.replace(new RegExp(`(?<![A-Za-z])${weekday}(?![A-Za-z])`), ' ');

  // ── Zeitblöcke ────────────────────────────────────────────────────────────
  const timeBlocks = extractTimeBlocks(rest);

  // ── Absenz-Codes ──────────────────────────────────────────────────────────
  const absenceCodes = extractAbsenceCodes(rest);

  // ── Nachtzuschlag ─────────────────────────────────────────────────────────
  const nightSupplement = /(?<![A-Za-z])N(?![A-Za-z])/.test(rest);

  // ── Dezimalstunden (Mirus-Format) ─────────────────────────────────────────
  // Zeitblöcke zuerst aus rest entfernen, damit Stunden nicht doppelt gezählt werden
  let restForDecimals = rest;
  for (const tb of timeBlocks) {
    restForDecimals = restForDecimals.replace(`${tb.from}-${tb.to}`, '')
                                     .replace(`${tb.from} - ${tb.to}`, '')
                                     .replace(`${tb.from}–${tb.to}`, '');
  }
  // Ebenfalls HH:MM Einzelwerte entfernen die Arbeitszeiten sein könnten
  restForDecimals = restForDecimals.replace(/\d{1,2}:\d{2}/g, '');

  const dec = extractDecimalHours(restForDecimals);
  const pause      = dec.pause;
  const totalHours = dec.netto ?? dec.brutto;

  // ── Konfidenz ─────────────────────────────────────────────────────────────
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
    lineText: t, lineIndex, date, weekday,
    timeBlocks, pause, totalHours, absenceCodes,
    nightSupplement, remark: null,
    confidence, uncertain: confidence !== 'high',
  };
}

// ─── Totale ───────────────────────────────────────────────────────────────────

function parseTotals(lines: string[]): MirusTotals {
  const t: MirusTotals = {
    totalHours: null, pauseTotal: null, nettoTotal: null,
    zeitzuschlag: null, ueberzeit: null, saldo: null,
    signatureFound: false, rawLines: [],
  };

  for (const line of lines) {
    if (/unterschrift|visum/i.test(line)) t.signatureFound = true;

    // Dezimalstunden bevorzugen, Fallback auf HH:MM
    const dec = extractDecimalHours(line);
    const decVal = dec.netto ?? dec.brutto;

    const allHHMM = [...line.matchAll(/\b(\d{1,3}:\d{2})\b/g)].map(m => m[1]);
    const lastHHMM = allHHMM.length > 0 ? allHHMM[allHHMM.length - 1] : null;
    const best = decVal ?? lastHHMM;

    if (/^\s*TOTAL\b/i.test(line) && !t.totalHours) {
      t.totalHours = best; t.rawLines.push(line); continue;
    }
    if (/total.*(stunden|std)|stunden.?total|gesamt.*(stunden|std)/i.test(line) && !t.totalHours) {
      t.totalHours = best; t.rawLines.push(line); continue;
    }
    if (/^\s*Stunden\b/i.test(line) && !t.totalHours && best) {
      t.totalHours = best; t.rawLines.push(line); continue;
    }
    if (/pause.*total|total.*pause|pause.*gesamt/i.test(line) && !t.pauseTotal) {
      t.pauseTotal = best; t.rawLines.push(line); continue;
    }
    if (/\bnetto\b/i.test(line) && !t.nettoTotal) {
      t.nettoTotal = best; t.rawLines.push(line); continue;
    }
    if (/zeitzuschlag|zeit.?zuschlag/i.test(line) && !t.zeitzuschlag) {
      t.zeitzuschlag = best; t.rawLines.push(line); continue;
    }
    if (/überzeit|uberzeit|überstunden|ueberzeit/i.test(line) && !t.ueberzeit) {
      t.ueberzeit = best; t.rawLines.push(line); continue;
    }
    if (/\bsaldo\b/i.test(line) && !t.saldo) {
      const sM = line.match(/([+-]?\d{1,3}[.:]\d{2})/);
      t.saldo = sM ? sM[1] : best; t.rawLines.push(line); continue;
    }
  }

  return t;
}

// ─── Qualitäts-Score ──────────────────────────────────────────────────────────

function calcQuality(employees: MirusEmployee[]): number {
  if (employees.length === 0) return 0;

  const totalDayRows = employees.reduce((s, e) => s + e.dayRows.length, 0);
  if (totalDayRows === 0) return 0;

  // 35 % — Namen vollständig erkannt (nicht "Mitarbeiter N")
  const namedCount = employees.filter((e, i) => e.name && e.name !== `Mitarbeiter ${i + 1}`).length;
  const nameScore  = (namedCount / employees.length) * 35;

  // 45 % — Tageszeilen mit high confidence
  const highRows  = employees.reduce((s, e) => s + e.dayRows.filter(r => r.confidence === 'high').length, 0);
  const rowScore  = (highRows / totalDayRows) * 45;

  // 15 % — Totale erkannt
  const totOk = employees.filter(e => !!e.totals.totalHours).length;
  const totScore = (totOk / employees.length) * 15;

  // 5 % — Wochenstunden erkannt
  const whOk = employees.filter(e => !!e.weeklyHours).length;
  const whScore = (whOk / employees.length) * 5;

  return Math.round(nameScore + rowScore + totScore + whScore);
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

export async function parseMirusPDF(file: File): Promise<MirusParsedDocument> {
  const warnings: string[] = [];

  let allLines: MirusLine[];
  try {
    allLines = await extractAllLines(file);
  } catch (err) {
    throw new Error(`PDF konnte nicht gelesen werden: ${String(err)}`);
  }
  if (allLines.length === 0)
    throw new Error('PDF enthält keinen extrahierbaren Text (möglicherweise gescanntes Bild-PDF).');

  const meta = detectDocumentMeta(allLines);
  if (!meta.month)      warnings.push('Monat konnte nicht erkannt werden.');
  if (!meta.year)       warnings.push('Jahr konnte nicht erkannt werden.');
  if (!meta.restaurant) warnings.push('Restaurant-Name konnte nicht erkannt werden.');

  const rawTexts  = allLines.map(l => l.text);
  const boundaries = findEmployeeBoundaries(allLines);

  if (boundaries.length === 0) {
    warnings.push('Keine "Name / Vorname"-Zeile gefunden — prüfe den Rohtext.');
    boundaries.push(0);
  }

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

      // Totale-Abschnitt erkennen
      if (!inTotals && /^\s*TOTAL\b/i.test(t)) inTotals = true;
      if (!inTotals && /zeitzuschlag|überzeit|\bsaldo\b|netto.*stunden|unterschrift/i.test(t)) inTotals = true;

      if (inTotals) { totalsLines.push(t); continue; }

      if (isDayRow(t)) {
        dayRows.push(parseDayRow(line, startIdx + i));
      } else if (isTimeContinuationLine(t) && dayRows.length > 0) {
        // Zeitblock einer Fortsetzungszeile zum letzten Tageseintrag hinzufügen
        const extra = extractTimeBlocks(t);
        const last  = dayRows[dayRows.length - 1];
        last.timeBlocks.push(...extra);
        if (extra.length > 0 && last.confidence === 'medium') last.confidence = 'high';
      }
    }

    const totals = parseTotals(totalsLines.length > 0 ? totalsLines : sectionTexts.slice(-20));
    const uncertainRows = dayRows.filter(r => r.uncertain).length;

    employees.push({
      ...header,
      name:           header.name           ?? `Mitarbeiter ${b + 1}`,
      personalnummer: header.personalnummer  ?? null,
      kostenstelle:   header.kostenstelle    ?? null,
      department:     header.department      ?? null,
      employment:     header.employment      ?? null,
      weeklyHours:    header.weeklyHours     ?? null,
      dayRows, totals,
      rawLines: sectionTexts, uncertainRows,
      startLine: startIdx, endLine: endIdx - 1,
    });
  }

  const totalDayRows    = employees.reduce((s, e) => s + e.dayRows.length, 0);
  const uncertainRows   = employees.reduce((s, e) => s + e.uncertainRows, 0);
  const unassignedTotals = employees.filter(e => !e.totals.totalHours).length;
  const qualityPercent  = calcQuality(employees);

  return {
    ...meta, employees, allLines, warnings,
    quality: { totalEmployees: employees.length, totalDayRows, uncertainRows, unassignedTotals, qualityPercent },
  };
}
