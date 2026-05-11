/**
 * Mirus PDF Parser — Monatsbericht Arbeitzeiten
 * ================================================
 * Liest Mirus-Monatsblätter (z. B. "Arbeitzeiten Januar 2026 OLIV.pdf")
 * und extrahiert:
 *   - Dokumentkopf (Monat, Jahr, Restaurant, Erstellungsdatum)
 *   - Pro Mitarbeiter: Stammdaten + Tageszeilen + Totale
 *
 * Kein Schreibvorgang — rein diagnostisch.
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
  date: string | null;         // "01.01.2026" oder "01.01"
  weekday: string | null;      // "Mo" | "Di" | ... | "So"
  timeBlocks: { from: string; to: string }[];
  pause: string | null;        // "0:30"
  totalHours: string | null;   // "7:30"
  absenceCodes: string[];      // ["FE"], ["KR"], ["FR"], …
  nightSupplement: boolean;    // "N" Markierung
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
  department: string | null;     // "service" | "küche" | "andere" | null
  employment: string | null;     // "Vollzeit" | "Teilzeit" | …
  weeklyHours: string | null;    // "42.0"
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

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So',
                  'MO', 'DI', 'MI', 'DO', 'FR', 'SA', 'SO',
                  'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

const ABSENCE_CODES = [
  'FE', 'FR', 'KR', 'UN', 'UE', 'GF', 'AB', 'MU', 'MA', 'MI',
  'BU', 'JU', 'KO', 'AZ', 'ML', 'UU', 'SO', 'BL', 'ZA', 'NU', 'WK',
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
  const m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const h = parseInt(m[1]);
  const min = parseInt(m[2]);
  if (h > 99 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function extractTimeBlocks(text: string): { from: string; to: string }[] {
  const blocks: { from: string; to: string }[] = [];
  const re = /(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = parseTimeHHMM(m[1]);
    const to   = parseTimeHHMM(m[2]);
    if (from && to) blocks.push({ from, to });
  }
  return blocks;
}

function extractAbsenceCodes(text: string): string[] {
  const found: string[] = [];
  for (const code of ABSENCE_CODES) {
    const re = new RegExp(`\\b${code}\\b`);
    if (re.test(text)) found.push(code);
  }
  return found;
}

function extractPause(text: string): string | null {
  // Look for pause after time blocks — usually a standalone HH:MM or H:MM
  // Context: last value before total hours, or labeled "Pause"
  const m = text.match(/Pause\s*:?\s*(\d{1,3}:\d{2})/i);
  if (m) return m[1];
  // Look for standalone short time values — often pause is expressed as 0:30
  const pausePatterns = text.match(/\b(0:\d{2}|1:\d{2})\b/g);
  if (pausePatterns && pausePatterns.length > 0) return pausePatterns[0];
  return null;
}

function extractHoursValue(text: string): string | null {
  // Total hours: typically the last HH:MM or H:MM that's > 1:00 on a day row
  const all = [...text.matchAll(/\b(\d{1,3}:\d{2})\b/g)];
  if (all.length === 0) return null;
  // Prefer values > 2:00 (actual work hours, not pause)
  for (let i = all.length - 1; i >= 0; i--) {
    const val = all[i][1];
    const [h] = val.split(':').map(Number);
    if (h >= 2) return val;
  }
  return all[all.length - 1][1];
}

function detectWeekday(text: string): string | null {
  for (const d of WEEKDAYS) {
    const re = new RegExp(`\\b${d}\\b`, 'i');
    if (re.test(text)) {
      // Normalise to short form
      return d.slice(0, 2).charAt(0).toUpperCase() + d.slice(1, 2).toLowerCase();
    }
  }
  return null;
}

function detectDepartment(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes('service') || lower.includes('saal')) return 'service';
  if (lower.includes('küche') || lower.includes('kueche') || lower.includes('kitchen')) return 'küche';
  if (lower.includes('bar') || lower.includes('bistro')) return 'service';
  if (lower.includes('lieferung') || lower.includes('delivery')) return 'küche';
  return null;
}

// ─── PDF Text-Extraktion (gleicher Ansatz wie pdf-import-engine) ──────────────

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

      let matchedY: number | null = null;
      for (const existY of lineMap.keys()) {
        if (Math.abs(existY - yRaw) <= 3) { matchedY = existY; break; }
      }
      const key = matchedY ?? Math.round(yRaw);
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key)!.push({ x, y: yRaw, text: item.str });
    }

    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      const text  = items.map(i => i.text).join('  ').replace(/\s{3,}/g, '  ').trim();
      if (text) allLines.push({ y, items, text, pageNum: p });
    }
  }

  return allLines;
}

// ─── Dokument-Metadaten erkennen ──────────────────────────────────────────────

function detectDocumentMeta(lines: MirusLine[]): {
  month: number | null;
  monthName: string | null;
  year: number | null;
  restaurant: string | null;
  creationDate: string | null;
} {
  let month: number | null = null;
  let monthName: string | null = null;
  let year: number | null = null;
  let restaurant: string | null = null;
  let creationDate: string | null = null;

  const head = lines.slice(0, 30);

  for (const line of head) {
    const t = line.text;

    // Erstellungsdatum: "Erstellt: 15.02.2026" or "Druckdatum: ..."
    const cdMatch = t.match(/(?:Erstellt|Druckdatum|Gedruckt|Datum)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (cdMatch && !creationDate) creationDate = cdMatch[1];

    // Jahr aus 4-stelliger Zahl
    const yearMatch = t.match(/\b(202[0-9]|20[0-9]{2})\b/);
    if (yearMatch && !year) year = parseInt(yearMatch[1]);

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

    // Restaurant-Name: "OLIV" / "Beaulieu" / "Restaurant ..."
    const restMatch = t.match(/(?:Restaurant|Betrieb|Kostenstelle Firma)[\s:]+([A-ZÄÖÜa-z0-9\s-]+)/i);
    if (restMatch && !restaurant) restaurant = restMatch[1].trim();

    // Fallback: wenn "OLIV" oder "Beaulieu" im Titel vorkommt
    if (!restaurant) {
      if (/\bOLIV\b/i.test(t)) restaurant = 'OLIV';
      else if (/\bBeaulieu\b/i.test(t)) restaurant = 'Beaulieu';
    }
  }

  // Second pass: scan filename-style lines like "Arbeitszeiten Januar 2026 OLIV"
  for (const line of head) {
    const t = line.text;
    if (/arbeit.?zeit/i.test(t)) {
      if (!month) {
        for (const [name, num] of Object.entries(MONTH_MAP)) {
          if (new RegExp(`\\b${name}\\b`, 'i').test(t)) {
            month = num;
            monthName = MONTH_NAMES_DE[num] ?? null;
            break;
          }
        }
      }
      if (!year) {
        const ym = t.match(/\b(202\d)\b/);
        if (ym) year = parseInt(ym[1]);
      }
      if (!restaurant) {
        if (/\bOLIV\b/i.test(t)) restaurant = 'OLIV';
        else if (/\bBeaulieu\b/i.test(t)) restaurant = 'Beaulieu';
      }
    }
  }

  return { month, monthName, year, restaurant, creationDate };
}

// ─── Mitarbeiter-Sektionen finden ─────────────────────────────────────────────

/**
 * Versucht, Zeilen zu finden, die einen neuen Mitarbeiter einleiten.
 * Mögliche Muster (variiert je Mirus-Version):
 *   "Mitarbeiter: Hans Muster"
 *   "Name: Hans Muster"
 *   "Hans Muster" (Name allein, gefolgt von Kostenstelle)
 *   "Personal-Nr.: 001  Name: Hans Muster"
 */
function findEmployeeBoundaries(lines: MirusLine[]): number[] {
  const boundaries: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;

    // Explizite Marker
    if (/^(Mitarbeiter|Mitarbeiterin|Name|MA)\s*:/i.test(t)) {
      boundaries.push(i);
      continue;
    }

    // "Personal-Nr." Zeile
    if (/Personal.?Nr|PN\s*:/i.test(t) && /\d{3,}/.test(t)) {
      boundaries.push(i);
      continue;
    }

    // Linie, die "Kostenstelle" enthält UND auf der vorherigen oder nächsten Zeile ein Name steht
    if (/Kostenstelle/i.test(t)) {
      // Prüfen ob prev oder curr auch einen Namen enthält
      const prev = i > 0 ? lines[i - 1].text : '';
      const curr = t;
      // Wenn die gleiche Zeile sowohl Name als auch Kostenstelle enthält
      if (/Name\s*:/i.test(curr)) {
        boundaries.push(i);
      } else if (
        // Vorherige Zeile sieht wie ein Name aus (Vorname Nachname)
        /^[A-ZÄÖÜ][a-zäöü]+ [A-ZÄÖÜ][a-zäöü]+/.test(prev.trim()) &&
        i > 0 && !boundaries.includes(i - 1)
      ) {
        boundaries.push(i - 1);
      }
    }
  }

  // Deduplizieren und sortieren
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

// ─── Mitarbeiter-Kopfzeile parsen ─────────────────────────────────────────────

function parseEmployeeHeader(lines: MirusLine[], startIdx: number): Partial<MirusEmployee> {
  const result: Partial<MirusEmployee> = {
    name: null, personalnummer: null, kostenstelle: null,
    department: null, employment: null, weeklyHours: null,
  };

  // Scan bis zu 8 Zeilen ab startIdx
  const headerLines = lines.slice(startIdx, startIdx + 8);

  for (const line of headerLines) {
    const t = line.text;

    // Name
    const nameMatch =
      t.match(/(?:Mitarbeiter|Name|MA)\s*:\s*([A-ZÄÖÜa-zäöü][^\d\n,;:]{2,40})/i) ??
      t.match(/^([A-ZÄÖÜ][a-zäöü]+ [A-ZÄÖÜ][a-zäöü]+(?:\s+[A-ZÄÖÜ][a-zäöü]+)?)\s*$/);
    if (nameMatch && !result.name) result.name = nameMatch[1].trim();

    // Personalnummer
    const pnrMatch = t.match(/(?:Personal.?Nr|PNr|P\.?Nr|PN)\s*\.?:?\s*(\d{1,6})/i);
    if (pnrMatch && !result.personalnummer) result.personalnummer = pnrMatch[1];

    // Kostenstelle
    const ksMatch = t.match(/Kostenstelle\s*:?\s*([^\n,;]{2,30})/i);
    if (ksMatch && !result.kostenstelle) {
      result.kostenstelle = ksMatch[1].trim();
      // Abteilung aus Kostenstelle ableiten
      if (!result.department) result.department = detectDepartment(ksMatch[1]);
    }

    // Abteilung direkt
    const deptMatch = t.match(/(?:Abteilung|Dept)\s*:?\s*([^\n,;]{2,20})/i);
    if (deptMatch && !result.department) {
      result.department = detectDepartment(deptMatch[1]) ?? deptMatch[1].trim();
    }

    // Arbeitsverhältnis
    const empMatch = t.match(/(?:Arbeitsverhältnis|Anstellung|Vertrag|Beschäftigungsart)\s*:?\s*([^\n,;]{2,30})/i);
    if (empMatch && !result.employment) result.employment = empMatch[1].trim();

    // Wöchentliche Arbeitszeit
    const whMatch = t.match(/(?:Wöchentliche|Soll.?Zeit|Soll|Wochenstunden|wöch\.)\s*.*?(\d+[.,]\d+)\s*(?:Std|h|Stunden)/i);
    if (whMatch && !result.weeklyHours) result.weeklyHours = whMatch[1].replace(',', '.');
  }

  return result;
}

// ─── Tageszeilen parsen ───────────────────────────────────────────────────────

/**
 * Prüft ob eine Zeile eine Tageszeile ist (beginnt mit DD.MM oder DD.MM.YYYY).
 */
function isDayRow(text: string): boolean {
  return /^\s*\d{1,2}\.\d{1,2}(\.\d{4})?/.test(text);
}

function parseDayRow(line: MirusLine, lineIndex: number): MirusDayRow {
  const t = line.text;

  // Datum extrahieren
  const dateMatch = t.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  let date: string | null = null;
  if (dateMatch) {
    const d = dateMatch[1].padStart(2, '0');
    const m = dateMatch[2].padStart(2, '0');
    const y = dateMatch[3] ?? '';
    date = y ? `${d}.${m}.${y}` : `${d}.${m}`;
  }

  // Wochentag
  const weekday = detectWeekday(t);

  // Zeitblöcke
  const timeBlocks = extractTimeBlocks(t);

  // Absenz-Codes
  const absenceCodes = extractAbsenceCodes(t);

  // Nachtzuschlag
  const nightSupplement = /\bN\b/.test(t);

  // Pause
  const pause = extractPause(t);

  // Totalstunden
  const totalHours = timeBlocks.length === 0 && absenceCodes.length === 0
    ? extractHoursValue(t)
    : (extractHoursValue(t));

  // Bemerkung: alles nach dem letzten erkannten Feld
  let remark: string | null = null;
  const remarkMatch = t.match(/(?:Bemerkung|Bem\.?|Notiz)\s*:?\s*(.+)$/i);
  if (remarkMatch) remark = remarkMatch[1].trim();
  else {
    // Reste, die nicht als bekannte Felder passen — könnte Bemerkung sein
    const stripped = t
      .replace(/^\d{1,2}\.\d{1,2}(\.\d{4})?/, '')
      .replace(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/i, '')
      .replace(/\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/g, '')
      .replace(/\b(0|1):\d{2}\b/g, '')
      .replace(new RegExp(`\\b(${ABSENCE_CODES.join('|')})\\b`, 'g'), '')
      .replace(/\bN\b/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (stripped.length > 2 && !/^\d+$/.test(stripped)) remark = stripped;
  }

  // Konfidenz bestimmen
  let confidence: 'high' | 'medium' | 'low' = 'high';
  if (!date) confidence = 'low';
  else if (!weekday && timeBlocks.length === 0 && absenceCodes.length === 0) confidence = 'low';
  else if (!weekday || (!totalHours && absenceCodes.length === 0)) confidence = 'medium';

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
    const l = line.toLowerCase();
    const firstHHMM = parseTimeHHMM(line.match(/\b(\d{1,3}:\d{2})\b/)?.[1] ?? '');
    const allHHMM   = [...line.matchAll(/\b(\d{1,3}:\d{2})\b/g)].map(m => m[1]);
    const lastHHMM  = allHHMM.length > 0 ? allHHMM[allHHMM.length - 1] : null;

    if (/total.*(stunden|std|h$)|stunden.?total/i.test(line) && !totals.totalHours) {
      totals.totalHours = lastHHMM;
      totals.rawLines.push(line);
    } else if (/pause.*total|total.*pause|pause.*gesamt/i.test(line) && !totals.pauseTotal) {
      totals.pauseTotal = lastHHMM;
      totals.rawLines.push(line);
    } else if (/netto|neto/i.test(line) && !totals.nettoTotal) {
      totals.nettoTotal = lastHHMM;
      totals.rawLines.push(line);
    } else if (/zeitzuschlag|zeit.?zuschlag/i.test(line) && !totals.zeitzuschlag) {
      totals.zeitzuschlag = lastHHMM;
      totals.rawLines.push(line);
    } else if (/überzeit|uberzeit|überstunden/i.test(line) && !totals.ueberzeit) {
      totals.ueberzeit = lastHHMM;
      totals.rawLines.push(line);
    } else if (/\bsaldo\b/i.test(line) && !totals.saldo) {
      // Saldo kann +/- sein
      const saldoMatch = line.match(/[+-]?\d{1,3}:\d{2}/);
      totals.saldo = saldoMatch ? saldoMatch[0] : lastHHMM;
      totals.rawLines.push(line);
    }

    if (/unterschrift|visum|datum.*unterschrift/i.test(line)) {
      totals.signatureFound = true;
    }

    // TOTAL-Zeile ohne Schlüsselwort: "TOTAL  168:30"
    if (/^\s*TOTAL\b/i.test(line) && !totals.totalHours) {
      totals.totalHours = lastHHMM;
      totals.rawLines.push(line);
    }
  }

  return totals;
}

// ─── Haupt-Parser ─────────────────────────────────────────────────────────────

/**
 * Parst eine Mirus-PDF-Datei vollständig.
 * Gibt ein MirusParsedDocument zurück — kein Supabase-Zugriff, kein Schreibvorgang.
 */
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
  const rawTexts = allLines.map(l => l.text);
  const boundaries = findEmployeeBoundaries(allLines);

  // Fallback wenn keine Boundaries erkannt: ganzes Dokument als ein Mitarbeiter
  if (boundaries.length === 0) {
    warnings.push('Keine Mitarbeiter-Abschnitte erkannt — zeige gesamten Text als einzelnen Block.');
    boundaries.push(0);
  }

  // 4. Mitarbeiter parsen
  const employees: MirusEmployee[] = [];

  for (let b = 0; b < boundaries.length; b++) {
    const startIdx = boundaries[b];
    const endIdx   = b + 1 < boundaries.length ? boundaries[b + 1] : allLines.length;

    const sectionLines  = allLines.slice(startIdx, endIdx);
    const sectionTexts  = rawTexts.slice(startIdx, endIdx);

    const header  = parseEmployeeHeader(allLines, startIdx);

    const dayRows: MirusDayRow[] = [];
    const totalsLines: string[]  = [];
    let inTotals = false;

    for (let i = 0; i < sectionLines.length; i++) {
      const line = sectionLines[i];
      const t = line.text;

      // Totale erkennen: nach "TOTAL" oder "Summe"-Marker
      if (/^\s*TOTAL\b|^Summe\b|^Total\s+Stunden/i.test(t)) {
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

    const totals  = parseTotals(totalsLines.length > 0 ? totalsLines : sectionTexts.slice(-15));
    const uncertainRows = dayRows.filter(r => r.uncertain).length;

    employees.push({
      ...header,
      name: header.name ?? `Mitarbeiter ${b + 1}`,
      personalnummer: header.personalnummer ?? null,
      kostenstelle: header.kostenstelle ?? null,
      department: header.department ?? null,
      employment: header.employment ?? null,
      weeklyHours: header.weeklyHours ?? null,
      dayRows,
      totals,
      rawLines: sectionTexts,
      uncertainRows,
      startLine: startIdx,
      endLine: endIdx - 1,
    });
  }

  // 5. Qualitäts-Metriken
  const totalDayRows   = employees.reduce((s, e) => s + e.dayRows.length, 0);
  const uncertainRows  = employees.reduce((s, e) => s + e.uncertainRows, 0);
  const unassignedTotals = employees.filter(e =>
    !e.totals.totalHours && !e.totals.nettoTotal
  ).length;

  const qualityScore =
    totalDayRows === 0 ? 0 :
    Math.round(
      ((totalDayRows - uncertainRows) / totalDayRows) * 70 +
      (employees.filter(e => e.name && e.name !== `Mitarbeiter ${employees.indexOf(e) + 1}`).length / employees.length) * 15 +
      (employees.filter(e => e.totals.totalHours).length / employees.length) * 15
    );

  if (totalDayRows === 0) warnings.push('Keine Tageszeilen erkannt — Format möglicherweise unbekannt.');

  return {
    month: meta.month,
    monthName: meta.monthName,
    year: meta.year,
    restaurant: meta.restaurant,
    creationDate: meta.creationDate,
    employees,
    allLines,
    warnings,
    quality: {
      totalEmployees: employees.length,
      totalDayRows,
      uncertainRows,
      unassignedTotals,
      qualityPercent: qualityScore,
    },
  };
}
