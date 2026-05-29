/**
 * Mirus Excel Parser — Marker-basiert
 * =====================================
 * Layout-unabhängiger Parser für Mirus-Monatsblätter (Excel-Drucklayout).
 *
 * Strategie:
 *   - Mitarbeiterblock = Zeile mit "Name / Vorname" (JEDE Spalte, nicht nur C)
 *   - Name = erste nicht-leere Zelle RECHTS vom Marker (keine fixen Spalten)
 *   - Wochenstunden = label-basiert ("Pensum"/"Soll") oder Fallback auf BO
 *   - Arbeitsverhältnis = "Arbeitsverhältnis"-Marker oder Datums-Range-Pattern
 *   - Header-Zeile = Zeile mit "Datum" + "Arbeitszeit" (dynamisch gesucht)
 *   - Tageszeilen beginnen NACH der Header-Zeile
 *   - Eindeutige Tage über Set(dates) gezählt
 *
 * Kein Supabase, kein Speichern — rein diagnostisch.
 */

import * as XLSX from 'xlsx';

// ═══════════════════════════════════════════════════════════════════════════════
// ─── LAYOUT-KONFIGURATION ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** Alle Spaltenbuchstaben → 0-basierte Indices */
const C = (letter: string) => XLSX.utils.decode_col(letter);

/**
 * Fallback-Layout — nur noch als Notfall-Defaults.
 * Alle kritischen Werte (Name, Wochenstunden, Tagesstart) werden
 * marker-basiert erkannt; diese Werte greifen nur wenn kein Marker gefunden wird.
 */
const LAYOUT = {
  weeklyHoursCol:  C('BO'),  // Fallback: Wochenstunden-Spalte
  metaRowOffset:   1,        // Fallback: Kostenstelle in der Zeile nach Block-Start
  daySearchOffset: 5,        // Fallback: Tageszeilen-Suche ab blockStart + Offset

  // Fallback-Tagesspalten — werden per Header-Scan dynamisch überschrieben
  day: {
    dateCol:    C('B'),
    weekdayCol: C('D'),
    fromCol:    C('H'),
    toCol:      C('I'),
    pauseCol:   C('AD'),
    totalCol:   C('AH'),
    remarkCol:  C('BJ'),
  },
};

/**
 * Abwesenheitserkennung:
 * - Exakt-Codes (≤4 Zeichen): müssen exakt (case-insensitiv) dem Zellinhalt entsprechen
 * - Pattern-Codes: Substring-Match, sicher da lang genug
 */
const ABSENCE_EXACT = new Set([
  'FE', 'FR', 'FT', 'KR', 'KO', 'K', 'U', 'F', 'AUF', 'UVG',
]);
const ABSENCE_PATTERNS = [
  'ferien', 'feri', 'urlaub', 'unfall', 'uvg', 'unfalltag', 'krank', 'krankheit',
  'feiertag', 'frei', 'kompensation',
];

const TOTAL_LABELS: { key: keyof EmployeeTotals; patterns: string[] }[] = [
  { key: 'totalHours',   patterns: ['total stunden', 'total h', 'gesamtarbeitszeit', 'bruttoarbeitszeit', 'brutto'] },
  { key: 'pauseTotal',   patterns: ['pausen total', 'pause total', 'pause'] },
  { key: 'nettoTotal',   patterns: ['nettoarbeitszeit', 'netto'] },
  { key: 'sollStunden',  patterns: ['sollstunden', 'soll'] },
  { key: 'zeitzuschlag', patterns: ['zeitzuschlag', 'zuschlag'] },
  { key: 'ueberzeit',    patterns: ['überzeit', 'ueberzeit', 'überstunden'] },
  { key: 'saldo',        patterns: ['saldo'] },
  { key: 'ferien',       patterns: ['feriensaldo', 'ferien', 'feri', 'ferienguthaben', 'ferien guthaben', 'ferienrest', 'ferien rest', 'ferienbestand', 'ferienendsaldo', 'urlaub', 'urlaubssaldo', 'urlaubsguthaben', 'urlaub saldo', 'urlaubsrest', 'endsaldo ferien', 'schlussbestand ferien', 'ferienstand', 'resturlaub'] },
  { key: 'feiertag',     patterns: ['feiertag', 'feier', 'feiertagguthaben', 'feiertag guthaben', 'feiertagssaldo', 'feiertagsaldo', 'feiertage saldo', 'feiertage', 'feiertagbestand', 'feiertag rest', 'feiertage rest', 'endsaldo feiertag', 'schlussbestand feiertag', 'ft saldo', 'ft rest', 'ft guthaben'] },
  { key: 'kompensation', patterns: ['kompensation', 'komp'] },
  { key: 'krankheit',    patterns: ['krankheit', 'krank', 'unfall'] },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TYPEN ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export interface TimeBlock {
  from: string;
  to: string;
  department?: string;
}

export interface DayRecord {
  date: string | null;
  weekday: string | null;
  shifts: TimeBlock[];
  breakMinutes: number | null;
  totalHours: number | null;
  absenceCode: string | null;
  notes: string | null;
  rawCells: {
    dateCell?: string;
    workTimeCell?: string;
    pauseCell?: string;
    totalCell?: string;
    remarkCell?: string;
  };
  confidence: 'high' | 'medium' | 'low';
}

export interface EmployeeTotals {
  totalHours?: string;
  pauseTotal?: string;
  nettoTotal?: string;
  sollStunden?: string;
  zeitzuschlag?: string;
  ueberzeit?: string;
  saldo?: string;
  ferien?: string;
  feiertag?: string;
  kompensation?: string;
  krankheit?: string;
  // Berechnet aus Tageszeilen (nach Parsing befüllt)
  calculatedTotalHours?: number;
  totalsValidated?: boolean;
  totalsDiff?: number;
}

// ─── MONATSKONTEN ─────────────────────────────────────────────────────────────

export interface MonthlyAccountEntry {
  openingBalance: string | null;
  correction:     string | null;
  planned:        string | null;
  actual:         string | null;
  paidOut:        string | null;
  difference:     string | null;
  compensation:   string | null;
  surcharge:      string | null;
  days:           string | null;
  closingBalance: string | null;
}

export interface AccountRawLine {
  label:       string;
  value:       string;
  cellAddr:    string;
  accountType: string;
}

export interface MonthlyAccounts {
  hours:    Partial<MonthlyAccountEntry>;
  vacation: Partial<MonthlyAccountEntry>;
  holiday:  Partial<MonthlyAccountEntry>;
  overtime: Partial<MonthlyAccountEntry>;
  comp:     Partial<MonthlyAccountEntry>;
  rawLines: AccountRawLine[];
}

export interface RawBlock {
  markerCell: string;
  nameCell: string;
  weeklyHoursCell: string;
  metaRowText: string;
  detectedColMap: Record<string, string>;
}

export interface ExcelEmployee {
  name: string | null;
  department: string | null;
  costCenter: string | null;
  weeklyHours: number | null;
  employmentPeriod: string | null;
  sheetName: string;
  blockStartRow: number;   // 1-basiert (für Anzeige)
  blockEndRow: number | null;
  days: DayRecord[];
  totals: EmployeeTotals;
  monthlyAccounts: MonthlyAccounts;
  rawBlock: RawBlock;
  mergedFromCount: number;           // 1 = einzelner Block, ≥2 = zusammengeführt
  mergedBlockRows: [number, number][]; // [startRow, endRow] jedes Teil-Blocks
  vacationRowFound?: boolean;          // Ferien-Zeile im Sheet gefunden (auch wenn Wert 0 oder leer)
  holidayRowFound?:  boolean;          // Feiertag-Zeile im Sheet gefunden
}

export interface ExcelDocQuality {
  totalEmployees: number;
  employeesWithName: number;
  employeesWithDays: number;
  employeesWithTotals: number;
  totalDayRecords: number;
  daysWithShifts: number;
  qualityPercent: number;
}

export interface ExcelParseStats {
  markersFound: number;        // "Name / Vorname" Marker im Sheet
  headerTablesFound: number;   // Tabellen mit "Datum"+"Arbeitszeit" Header
  rawBlocks: number;           // Roh-Blöcke vor Merge/Skip
  skippedEmpty: number;        // Übersprungene leere Blöcke (kein Name, kein Tag, kein Total)
  mergedDuplicates: number;    // Zusammengeführte doppelte Mitarbeiter-Blöcke
  finalEmployees: number;      // Finale importierbare Mitarbeiter
  // ─── Qualitäts-Metriken ───────────────────────────────────────────────────
  monthDetected: boolean;                   // Monat + Jahr erkannt
  daysWithHours: number;                    // Tage mit totalHours > 0
  daysWithTimeBlocks: number;               // Tage mit ≥1 Zeitblock (shifts)
  employeesWithVacationBalance: number;     // MA mit Ferienguthaben (inkl. 0.0)
  employeesWithHolidayBalance: number;      // MA mit Feiertagguthaben (inkl. 0.0)
  employeesMissingVacation: string[];       // MA: Zeile nicht gefunden
  employeesMissingHoliday: string[];        // MA: Zeile nicht gefunden
  employeesVacationRowFoundNoValue: string[];  // MA: Zeile vorhanden, Wert nicht lesbar
  employeesHolidayRowFoundNoValue: string[];   // MA: Zeile vorhanden, Wert nicht lesbar
  incompleteTimeBlocks: number;             // Tage mit unvollständiger Stempelung
  qualityWarnings: string[];                // Warnungen bei tiefer Erkennungsquote
}

export interface ExcelParsedDocument {
  fileName: string;
  month: number | null;
  monthName: string | null;
  year: number | null;
  restaurant: string | null;
  creationDate: string | null;
  employees: ExcelEmployee[];
  quality: ExcelDocQuality;
  warnings: string[];
  sheetsProcessed: string[];
  parseStats: ExcelParseStats;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ZELL-HELFER ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function getCell(ws: XLSX.WorkSheet, col: number, row: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r: row, c: col })] as XLSX.CellObject | undefined;
}

function cellText(ws: XLSX.WorkSheet, col: number, row: number): string {
  const cell = getCell(ws, col, row);
  if (!cell) return '';
  return (cell.w ?? String(cell.v ?? '')).trim();
}

function cellNum(ws: XLSX.WorkSheet, col: number, row: number): number | null {
  const cell = getCell(ws, col, row);
  if (!cell) return null;
  if (cell.t === 'n' && typeof cell.v === 'number') return cell.v;
  const n = parseFloat(String(cell.v ?? '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function formatDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function timeSerial(v: number): string {
  // 0.0 = 00:00, 0.5 = 12:00
  const frac = v % 1;
  const totalMin = Math.round(frac * 1440);
  return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
}

function parseTimeCell(cell: XLSX.CellObject | undefined): string | null {
  if (!cell) return null;
  if (cell.t === 'n' && typeof cell.v === 'number') {
    // Fractional = time (0.0–1.0), or could be > 1 (date+time combined)
    const frac = cell.v % 1;
    if (frac > 0) return timeSerial(frac);
  }
  const w = (cell.w ?? String(cell.v ?? '')).trim();
  const m = w.match(/^(\d{1,2})[:\.](\d{2})(?:\s*[-–]\s*(\d{1,2})[:\.](\d{2}))?/);
  if (m) {
    const from = `${m[1].padStart(2, '0')}:${m[2]}`;
    if (m[3] && m[4]) return from; // return just "from" here; "to" parsed separately
    return from;
  }
  return null;
}

function parseDateCell(cell: XLSX.CellObject | undefined): string | null {
  if (!cell) return null;
  if (cell.v instanceof Date) return formatDate(cell.v);
  if (cell.t === 'n' && typeof cell.v === 'number' && cell.v > 25569) {
    // Excel serial date (Jan 1 1970 = 25569)
    try {
      const info = XLSX.SSF.parse_date_code(cell.v);
      if (info && info.y > 2000)
        return `${String(info.d).padStart(2, '0')}.${String(info.m).padStart(2, '0')}.${info.y}`;
    } catch { /* ignore */ }
  }
  const w = (cell.w ?? String(cell.v ?? '')).trim();
  // Accepts "01.01.2026", "01.01.", "01.01"
  if (/^\d{1,2}\.\d{1,2}/.test(w)) return w;
  return null;
}

/**
 * Erkennt Abwesenheitscodes aus dem Zellinhalt.
 * Kurze Codes (≤4 Zeichen) werden nur bei exaktem Zellinhalt erkannt,
 * um Fehlerkennungen zu vermeiden (z.B. 'FR' in 'Früh', 'K' in 'Kantine').
 */
function detectAbsence(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();

  if (ABSENCE_EXACT.has(upper)) return upper;

  for (const pat of ABSENCE_PATTERNS) {
    if (lower.includes(pat)) return trimmed;
  }
  return null;
}

/**
 * Normalisiert einen rohen Absence-Code auf einen kanonischen Typ.
 * Rückgabe: 'vacation' | 'accident' | 'sick' | 'holiday' | 'free' | null
 */
export function normalizeAbsenceCode(raw: string | null | undefined): 'vacation' | 'accident' | 'sick' | 'holiday' | 'free' | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  const upper = raw.toUpperCase().trim();
  if (/feri|ferien|urlaub/.test(lower) || upper === 'FE' || upper === 'U') return 'vacation';
  if (/unfall|uvg|unfalltag/.test(lower) || upper === 'AUF') return 'accident';
  if (/krank|krankheit/.test(lower) || upper === 'KR' || upper === 'K') return 'sick';
  if (/feiertag/.test(lower) || upper === 'FT') return 'holiday';
  if (/frei|kompensation/.test(lower) || upper === 'FR' || upper === 'KO' || upper === 'F') return 'free';
  return null;
}

// ─── TOTALE-HELFER ────────────────────────────────────────────────────────────

/** Normalisiert Label-Text: lowercase, Punkte entfernen, Mehrfach-Space → 1 */
function normLabel(text: string): string {
  return text.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Parst einen Zellwert als Dezimalstunden.
 * Akzeptiert: HH:MM-String, Excel-Zeitfraktion (0..~3), direkte Dezimalzahl.
 * Wichtig: 0.0 ist ein gültiger Wert (z.B. kein Ferienguthaben) und wird
 * NICHT als "kein Wert" behandelt. Nur leere Zellen liefern null.
 */
function parseHoursValue(cell: XLSX.CellObject | undefined): { display: string; decimal: number } | null {
  if (!cell) return null;

  // Formatierter Text — zuerst auf HH:MM prüfen
  const w = (cell.w ?? '').trim();
  const hhmmW = w.match(/^(\d{1,3}):(\d{2})$/);
  if (hhmmW) {
    const decimal = parseInt(hhmmW[1]) + parseInt(hhmmW[2]) / 60;
    return { display: w, decimal: Math.round(decimal * 100) / 100 };
  }

  if (cell.t === 'n' && typeof cell.v === 'number') {
    const v = cell.v;
    // 0.0 = gültiger Nullwert (z.B. kein Ferienguthaben)
    if (v === 0) return { display: w || '0', decimal: 0 };
    // Excel-Zeitfraktion (Bruchteile eines Tages, < 3 = < 72 h)
    if (v > 0 && v < 3) {
      const decimal = Math.round(v * 24 * 100) / 100;
      return { display: w || String(decimal), decimal };
    }
    // Direkte Dezimalstunden
    if (v > 0 && v < 500) return { display: w || String(v), decimal: v };
    return null;
  }

  const s = String(cell.v ?? '').trim();
  if (!s || s === '-') return null;

  // Explizit "0" oder "0.0" / "0,0" als Nullwert akzeptieren
  if (s === '0' || /^0[.,]0+$/.test(s)) return { display: s, decimal: 0 };

  // HH:MM im Rohwert
  const hhmmS = s.match(/^(\d{1,3}):(\d{2})$/);
  if (hhmmS) {
    const decimal = parseInt(hhmmS[1]) + parseInt(hhmmS[2]) / 60;
    return { display: s, decimal: Math.round(decimal * 100) / 100 };
  }

  // Schweizer Dezimalformat: 7,5 oder 7.5 (negativ erlaubt für Saldoabzüge)
  const d = parseFloat(s.replace(',', '.'));
  if (!isNaN(d) && Math.abs(d) < 500) return { display: s, decimal: d };
  return null;
}

/** Konvertiert "HH:MM" oder Dezimalstring → Dezimalstunden (null wenn nicht parsebar) */
function toDecimalHours(s: string): number | null {
  const hmm = s.match(/^(\d{1,3}):(\d{2})$/);
  if (hmm) return parseInt(hmm[1]) + parseInt(hmm[2]) / 60;
  const d = parseFloat(s.replace(',', '.'));
  return isNaN(d) || d <= 0 ? null : d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BLOCK-ERKENNUNG ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function findBlockStarts(ws: XLSX.WorkSheet): number[] {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const starts: number[] = [];
  // Scan ALL columns — not a fixed column C
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = String(cell.v ?? cell.w ?? '').trim();
      if (/Name\s*\/\s*Vorname/i.test(text)) {
        starts.push(r);
        break; // Only one marker per row
      }
    }
  }
  return starts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MARKER-BASIERTE LAYOUT-ERKENNUNG ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * detectMirusLayout:
 * Sucht "Name / Vorname" in JEDER Spalte und gibt alle gefundenen
 * Marker-Positionen zurück (Zeile + Spalte).
 * Ersetzt den früheren fixen Ansatz (nur Spalte C).
 */
function detectMirusLayout(ws: XLSX.WorkSheet): Array<{ row: number; markerCol: number }> {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const blocks: Array<{ row: number; markerCol: number }> = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = String(cell.v ?? cell.w ?? '').trim();
      if (/Name\s*\/\s*Vorname/i.test(text)) {
        blocks.push({ row: r, markerCol: c });
        break;
      }
    }
  }
  return blocks;
}

/**
 * findMarkerCol:
 * Findet die Spalte des "Name / Vorname" Markers in einer gegebenen Zeile.
 */
function findMarkerCol(ws: XLSX.WorkSheet, row: number): number {
  const ref = ws['!ref'];
  if (!ref) return C('C'); // Fallback
  const range = XLSX.utils.decode_range(ref);
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = getCell(ws, c, row);
    if (!cell) continue;
    if (/Name\s*\/\s*Vorname/i.test(String(cell.v ?? cell.w ?? '').trim())) return c;
  }
  return C('C');
}

/**
 * extractEmployee:
 * Liest den Mitarbeiternamen als ERSTE nicht-leere Zelle RECHTS vom Marker.
 * Keine fixen Spalten — passt sich an jedes Layout an.
 */
function extractEmployee(ws: XLSX.WorkSheet, markerRow: number, markerCol: number): string | null {
  const ref = ws['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  for (let c = markerCol + 1; c <= range.e.c; c++) {
    const cell = getCell(ws, c, markerRow);
    if (!cell) continue;
    const name = (cell.w ?? String(cell.v ?? '')).trim();
    if (name && name.length > 1 && !/Name\s*\/\s*Vorname/i.test(name)) {
      return name;
    }
  }
  return null;
}

/**
 * extractWeeklyHours:
 * Sucht "Pensum", "Soll-Std", "Wochenstunden" als Label in den Header-Zeilen.
 * Fallback auf feste Spalte BO aus LAYOUT (Rückwärts-Kompatibilität).
 */
function extractWeeklyHours(ws: XLSX.WorkSheet, blockStart: number, blockEnd: number): number | null {
  const ref = ws['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const scanLimit = Math.min(blockStart + 10, blockEnd);

  for (let r = blockStart; r <= scanLimit; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = String(cell.v ?? '').toLowerCase().trim();
      if (/pensum|wochenstunden|sollstunden|soll[- ]?std/.test(text)) {
        for (let dc = 1; dc <= 6; dc++) {
          const vc = getCell(ws, c + dc, r);
          if (!vc) continue;
          if (vc.t === 'n' && typeof vc.v === 'number' && vc.v > 0 && vc.v <= 60)
            return Math.round(vc.v * 10) / 10;
          const n = parseFloat(String(vc.v ?? '').replace(',', '.'));
          if (!isNaN(n) && n > 0 && n <= 60) return n;
        }
      }
    }
  }

  // Fallback: feste Spalte BO auf der Marker-Zeile
  const whCell = getCell(ws, LAYOUT.weeklyHoursCol, blockStart);
  if (whCell?.t === 'n' && typeof whCell.v === 'number' && whCell.v > 0) return whCell.v;
  const n = parseFloat(String(whCell?.v ?? '').replace(',', '.'));
  if (!isNaN(n) && n > 0) return n;
  return null;
}

/**
 * extractEmployment:
 * Sucht "Arbeitsverhältnis" als Marker und liest das Datums-Range rechts davon.
 * Erkennt auch direkte "DD.MM.YYYY - DD.MM.YYYY" Patterns ohne Marker.
 */
function extractEmployment(ws: XLSX.WorkSheet, blockStart: number, blockEnd: number): string | null {
  const ref = ws['!ref'];
  if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  const scanLimit = Math.min(blockStart + 12, blockEnd);

  for (let r = blockStart; r <= scanLimit; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = (cell.w ?? String(cell.v ?? '')).trim();

      // Direktes Pattern: "01.11.2025 - 31.03.2026" oder "01.11.2025 – 31.03.2026"
      const directMatch = text.match(/\d{2}\.\d{2}\.\d{4}\s*[-–]\s*\d{2}\.\d{2}\.\d{4}/);
      if (directMatch) return directMatch[0];

      // Label: "Arbeitsverhältnis" → Wert in der gleichen Zeile rechts davon
      if (/Arbeitsverhältnis|Arbeitsverh\./i.test(text)) {
        for (let nc = c + 1; nc <= Math.min(range.e.c, c + 12); nc++) {
          const vc = getCell(ws, nc, r);
          if (!vc) continue;
          const vt = (vc.w ?? String(vc.v ?? '')).trim();
          if (/\d{2}\.\d{2}\.\d{4}/.test(vt)) return vt;
        }
        // Auch nächste Zeile prüfen
        for (let nc = range.s.c; nc <= range.e.c; nc++) {
          const vc = getCell(ws, nc, r + 1);
          if (!vc) continue;
          const vt = (vc.w ?? String(vc.v ?? '')).trim();
          if (/\d{2}\.\d{2}\.\d{4}/.test(vt)) return vt;
        }
      }
    }
  }
  return null;
}

/**
 * extractHeaders:
 * Sucht dynamisch die Header-Zeile mit "Datum" + ("Arbeitszeit" / "Von" / "Zeit").
 * Gibt die Zeilennummer zurück, NACH der Tageszeilen beginnen.
 * Kein fixer Offset mehr — reagiert auf jede Layout-Variante.
 */
function extractHeaders(ws: XLSX.WorkSheet, blockStart: number, blockEnd: number): number {
  const ref = ws['!ref'];
  if (!ref) return blockStart + LAYOUT.daySearchOffset - 1;
  const range = XLSX.utils.decode_range(ref);

  for (let r = blockStart + 1; r <= Math.min(blockEnd, blockStart + 20); r++) {
    let hasDatum = false;
    let hasZeit  = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = String(cell.v ?? '').toLowerCase().trim();
      if (text === 'datum' || text === 'date') hasDatum = true;
      if (/arbeitszeit|von\b|zeit\b|beginn|from\b/.test(text)) hasZeit = true;
    }
    if (hasDatum && hasZeit) return r; // Tageszeilen starten ab r+1
  }

  // Fallback: fixer Offset
  return blockStart + LAYOUT.daySearchOffset - 1;
}

// ─── Ferien/Feiertag Label-Muster ────────────────────────────────────────────

const FERIEN_LABEL_PATS = [
  // Standardbezeichnungen
  'ferien', 'feri',
  // Saldo / Guthaben / Rest
  'feriensaldo', 'ferienguthaben', 'ferien saldo', 'ferien guthaben',
  'ferienrest', 'ferien rest', 'ferienrestguthaben', 'ferien rest guthaben',
  'ferienbestand', 'ferienendsaldo', 'ferien endsaldo',
  'endsaldo ferien', 'schlussbestand ferien', 'ferienstand',
  'ferienresttage', 'ferien resttage', 'ferien restguthaben',
  // Urlaub-Varianten (DE)
  'urlaub', 'urlaubssaldo', 'urlaubsguthaben', 'urlaub saldo', 'urlaub rest',
  'urlaubsrest', 'urlaubsbestand', 'urlaubsendsaldo', 'resturlaub',
  'endsaldo urlaub', 'schlussbestand urlaub',
];

const FEIERTAG_LABEL_PATS = [
  // Standardbezeichnungen
  'feiertag', 'feiertage', 'feier',
  // Saldo / Guthaben / Rest
  'feiertagguthaben', 'feiertagssaldo', 'feiertagsaldo',
  'feiertag guthaben', 'feiertage saldo', 'feiertag saldo', 'feiertage rest',
  'feiertagbestand', 'feiertag bestand', 'feiertag rest',
  'endsaldo feiertag', 'feiertage endsaldo',
  'feiertagendsaldo', 'feiertag endsaldo', 'feiertagstand',
  'schlussbestand feiertag',
  // FT-Abkürzungen
  'ft saldo', 'ft rest', 'ft guthaben', 'ft bestand',
  'gesetzliche feiertage', 'ges. feiertage',
];

// Spalten-Header-Muster die auf eine "Saldo"-Spalte in einer Balance-Tabelle hinweisen
const SALDO_COL_EXACT  = ['saldo', 'endsaldo', 'schlussbestand', 'schluss'];
const SALDO_COL_STARTS = ['saldo ', 'endsaldo ', 'schlussbestand '];
const BALANCE_TABLE_COLS = [
  'vortrag', 'soll', 'ist', 'monat', 'korrektur', 'korr', 'ausbezahlt',
  'saldo', 'endsaldo', 'schlussbestand', 'total', 'bestand', 'kompens',
];

/**
 * Hilfsfunktion: liest Stundenwert einer Zelle inkl. Nullwert (0.0 = gültiger Wert).
 * Gibt null zurück wenn die Zelle leer / kein Zahlenwert ist.
 */
function readBalanceCellValue(cell: XLSX.CellObject | undefined): string | null {
  if (!cell) return null;
  const parsed = parseHoursValue(cell);
  if (parsed !== null) return parsed.display || String(parsed.decimal);
  const raw = (cell.w ?? String(cell.v ?? '')).trim();
  if (raw && raw !== '-') return raw;
  return null;
}

/**
 * extractBalances (v2):
 * Verbesserte Balance-Erkennung mit:
 *  1. Dynamischer Saldo-Spalten-Erkennung (für Tabellenformat)
 *  2. Vollem Block-Scan (nicht nur Top/Bottom)
 *  3. Akzeptiert 0.0 als gültigen Wert
 *  4. "Last value"-Strategie bei Tabellen (Endsaldo ist meist ganz rechts)
 *  5. Erweiterte Label-Varianten
 *  6. Debug-Logging für fehlende Mitarbeiter
 */
function extractBalances(
  ws: XLSX.WorkSheet,
  blockStart: number,
  blockEnd: number,
  employeeName?: string,
): {
  ferien:         string | null;
  feiertag:       string | null;
  total:          string | null;
  ferienRowFound:  boolean;
  feierRowFound:   boolean;
} {
  const EMPTY = { ferien: null, feiertag: null, total: null, ferienRowFound: false, feierRowFound: false };
  const ref = ws['!ref'];
  if (!ref) return EMPTY;
  const range = XLSX.utils.decode_range(ref);

  // ── 1. Saldo-Spalte dynamisch ermitteln ──────────────────────────────────
  // Eine Balance-Tabellen-Headerzeile hat ≥3 bekannte Balance-Spalten-Begriffe.
  // Die "Saldo"- oder "Schlussbestand"-Spalte ist der bevorzugte Wertträger.
  let saldoCol: number | null = null;

  outer:
  for (let r = blockStart; r <= Math.min(blockStart + 30, blockEnd); r++) {
    let matchCount = 0;
    let bestSaldoC: number | null = null;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell || cell.t !== 's') continue;
      const t = normLabel(String(cell.v ?? ''));
      if (BALANCE_TABLE_COLS.some(p => t === p || t.startsWith(p + ' '))) {
        matchCount++;
        if (SALDO_COL_EXACT.includes(t) || SALDO_COL_STARTS.some(p => t.startsWith(p))) {
          bestSaldoC = c;
        }
      }
    }
    if (matchCount >= 3 && bestSaldoC !== null) {
      saldoCol = bestSaldoC;
      break outer;
    }
  }

  // ── 2. Ganzen Block nach Ferien/Feiertag-Zeilen scannen ─────────────────
  let ferien:  string | null = null;
  let feiertag: string | null = null;
  let total:   string | null = null;
  let ferienRowFound  = false;
  let feierRowFound   = false;

  for (let r = blockStart; r <= blockEnd; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const text = normLabel(String(cell.v ?? '').trim());
      if (!text || text.length < 3) continue;

      const isFerienRow  = FERIEN_LABEL_PATS.some(p =>
        text === p || text === p.replace(/\s/g, '') || text.startsWith(p + ' '));
      const isFeierRow   = FEIERTAG_LABEL_PATS.some(p =>
        text === p || text === p.replace(/\s/g, '') || text.startsWith(p + ' '));
      const isTotalRow   = (text === 'total' || text === 'total stunden' || text === 'totals') && !total;

      if (!isFerienRow && !isFeierRow && !isTotalRow) continue;
      if (isFerienRow  && ferien  !== null)  continue; // bereits gefunden
      if (isFeierRow   && feiertag !== null) continue;

      if (isFerienRow)  ferienRowFound = true;
      if (isFeierRow)   feierRowFound  = true;

      // ── Wert ermitteln ────────────────────────────────────────────────────
      let val: string | null = null;

      // Option A: Saldo-Spalte bekannt und rechts vom Label → direkt lesen
      if (saldoCol !== null && saldoCol > c) {
        val = readBalanceCellValue(getCell(ws, saldoCol, r));
      }

      // Option B: Alle Zahlenwerte in der Zeile rechts sammeln
      //   → Bei Tabellenformat: letzter Wert = Schlussbestand
      //   → Bei einfachem Format: erster Wert
      if (val === null) {
        const candidates: string[] = [];
        for (let dc = 1; dc <= 25; dc++) {
          const vc = getCell(ws, c + dc, r);
          if (!vc) continue;
          const v = readBalanceCellValue(vc);
          if (v !== null) candidates.push(v);
        }
        if (candidates.length > 0) {
          // Mit Saldo-Spalte → letzter Wert (Schlussbestand ist rechts)
          // Ohne Saldo-Spalte → erster Wert (einfacher inline-Wert)
          val = saldoCol !== null ? candidates[candidates.length - 1] : candidates[0];
        }
      }

      if (isFerienRow)  ferien   = val ?? null;
      if (isFeierRow)   feiertag = val ?? null;
      if (isTotalRow && val) total = val;
    }
  }

  // ── 3. Debug-Ausgabe für fehlende Werte ──────────────────────────────────
  if (employeeName && (!ferien || !feiertag)) {
    console.debug(
      `[PARSER] Balance-Debug "${employeeName}" (Zeilen ${blockStart + 1}–${blockEnd + 1}):`,
      {
        saldoCol:       saldoCol !== null ? XLSX.utils.encode_col(saldoCol) : '—',
        ferienRowFound, ferien:   ferien   ?? 'null',
        feierRowFound,  feiertag: feiertag ?? 'null',
      }
    );
  }

  return { ferien, feiertag, total, ferienRowFound, feierRowFound };
}

/**
 * extractDayEntries:
 * Wrapper rund um readDayRows — startet NACH der dynamisch erkannten Header-Zeile.
 * Gibt alle von readDayRows erkannten Einträge zurück (Tage + Abwesenheiten).
 * Ferien/Feiertag/Total-Zeilen haben kein gültiges Datum und werden von
 * readDayRows bereits nicht als DayRecord erzeugt.
 */
function extractDayEntries(
  ws: XLSX.WorkSheet,
  headerRow: number,
  blockEnd: number,
  map: ColMap,
): DayRecord[] {
  return readDayRows(ws, headerRow + 1, blockEnd, map);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── SPALTEN-AUTO-ERKENNUNG ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

interface ColMap {
  dateCol: number;
  weekdayCol: number;
  fromCol: number;
  toCol: number | null;
  pauseCol: number | null;
  totalCol: number | null;
  remarkCol: number | null;
}

const HEADER_MAP: { key: keyof ColMap; patterns: string[] }[] = [
  { key: 'dateCol',    patterns: ['datum', 'date'] },
  { key: 'weekdayCol', patterns: ['tag', 'wochentag'] },
  { key: 'fromCol',    patterns: ['von', 'from', 'arbeitszeit', 'beginn'] },
  { key: 'toCol',      patterns: ['bis', 'to', 'ende'] },
  { key: 'pauseCol',   patterns: ['pause'] },
  { key: 'totalCol',   patterns: ['total', 'gesamt'] },
  { key: 'remarkCol',  patterns: ['bemerkung', 'remark', 'notiz'] },
];

function detectColMap(ws: XLSX.WorkSheet, blockStart: number, limit: number): { map: ColMap; detected: Record<string, string> } {
  const map: ColMap = {
    dateCol:    LAYOUT.day.dateCol,
    weekdayCol: LAYOUT.day.weekdayCol,
    fromCol:    LAYOUT.day.fromCol,
    toCol:      LAYOUT.day.toCol,
    pauseCol:   LAYOUT.day.pauseCol,
    totalCol:   LAYOUT.day.totalCol,
    remarkCol:  LAYOUT.day.remarkCol,
  };
  const detected: Record<string, string> = {};

  const ref = ws['!ref'];
  if (!ref) return { map, detected };
  const range = XLSX.utils.decode_range(ref);

  for (let r = blockStart; r <= Math.min(blockStart + 12, limit); r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = getCell(ws, c, r);
      if (!cell || cell.t !== 's') continue;
      const text = String(cell.v ?? '').toLowerCase().trim();
      for (const { key, patterns } of HEADER_MAP) {
        if (patterns.some(p => text.includes(p))) {
          (map as Record<string, number | null>)[key] = c;
          detected[key] = `${XLSX.utils.encode_col(c)} (${cell.v})`;
        }
      }
    }
  }
  return { map, detected };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TAGESZEILEN ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function readDayRows(
  ws: XLSX.WorkSheet,
  startRow: number,
  endRow: number,
  map: ColMap,
): DayRecord[] {
  const records: DayRecord[] = [];
  const ref = ws['!ref'];
  if (!ref) return records;
  const range = XLSX.utils.decode_range(ref);

  // Rows consumed as continuation blocks (no date, belong to previous day)
  const skipRows = new Set<number>();

  for (let r = startRow; r <= endRow; r++) {
    if (skipRows.has(r)) continue;

    const dateCell = getCell(ws, map.dateCol, r);
    const date     = parseDateCell(dateCell);

    // Absenzen: erste 25 Spalten + Bemerkungsspalte scannen
    let absenceCode: string | null = null;
    const absenceColLimit = Math.min(range.e.c, 25);
    for (let c = range.s.c; c <= absenceColLimit; c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const code = detectAbsence(String(cell.v ?? ''));
      if (code) { absenceCode = code; break; }
    }
    // Bemerkungsspalte (z.B. BJ) separat prüfen — liegt ausserhalb des 0-25 Scans
    if (!absenceCode && map.remarkCol !== null && map.remarkCol > absenceColLimit) {
      const remarkCell = getCell(ws, map.remarkCol, r);
      if (remarkCell) {
        const code = detectAbsence(String(remarkCell.v ?? ''));
        if (code) absenceCode = code;
      }
    }

    if (!date && !absenceCode) continue;

    // ── Schichten ─────────────────────────────────────────────────────────────
    const shifts: TimeBlock[] = [];
    const fromCell = getCell(ws, map.fromCol, r);
    const fromTime = parseTimeCell(fromCell);

    if (fromTime) {
      const toTime = map.toCol !== null ? parseTimeCell(getCell(ws, map.toCol, r)) : null;

      // FIX 1: matchAll — handles "10:00-14:00 / 17:00-22:00" in a single cell
      const rawW = (fromCell?.w ?? String(fromCell?.v ?? '')).trim();
      const allRanges = [...rawW.matchAll(/(\d{1,2}[:\. ]\d{2})\s*[-–]\s*(\d{1,2}[:\. ]\d{2})/g)];

      if (allRanges.length > 0) {
        for (const m of allRanges) {
          shifts.push({
            from: m[1].replace(/[. ]/, ':'),
            to:   m[2].replace(/[. ]/, ':'),
          });
        }
      } else if (toTime) {
        shifts.push({ from: fromTime, to: toTime });

        // FIX 3: Wider column scan — up to 15 columns right of toCol for second shift pair.
        // Mirus layouts can have gap columns between the first and second shift columns.
        if (map.toCol !== null) {
          for (let offset = 1; offset <= 15; offset++) {
            const f2 = parseTimeCell(getCell(ws, map.toCol + offset, r));
            if (!f2 || f2 === fromTime || f2 === toTime) continue;
            const t2 = parseTimeCell(getCell(ws, map.toCol + offset + 1, r));
            if (t2) {
              shifts.push({ from: f2, to: t2 });
              break;
            }
          }
        }
      } else {
        shifts.push({ from: fromTime, to: '?' });
      }
    }

    // FIX 2: Continuation rows — in Mirus, split shifts often occupy multiple consecutive
    // rows where only the FIRST row has a date cell; subsequent rows have no date.
    // Without this fix, those rows are silently dropped by the `!date && !absenceCode` guard.
    if (date) {
      for (let cr = r + 1; cr <= endRow; cr++) {
        const crDate = parseDateCell(getCell(ws, map.dateCol, cr));
        if (crDate) break; // A new calendar day starts — stop looking

        // If the row already has an absence code, it's its own entry — stop
        let crAbsence: string | null = null;
        for (let c = range.s.c; c <= Math.min(range.e.c, 25); c++) {
          const cell = getCell(ws, c, cr);
          if (!cell) continue;
          const code = detectAbsence(String(cell.v ?? ''));
          if (code) { crAbsence = code; break; }
        }
        if (crAbsence) break;

        // Check for a time block on this dateless continuation row
        const crFrom = parseTimeCell(getCell(ws, map.fromCol, cr));
        if (!crFrom) break; // No time value — not a continuation shift row
        const crTo = map.toCol !== null ? parseTimeCell(getCell(ws, map.toCol, cr)) : null;
        if (crTo) {
          shifts.push({ from: crFrom, to: crTo });
          skipRows.add(cr); // Mark so outer loop skips this row
        } else {
          break;
        }
      }
    }

    // Pause
    let breakMinutes: number | null = null;
    if (map.pauseCol !== null) {
      const pauseCell = getCell(ws, map.pauseCol, r);
      if (pauseCell) {
        if (pauseCell.t === 'n' && typeof pauseCell.v === 'number') {
          // Could be fraction of hour, minutes, or serial time
          const v = pauseCell.v % 1 > 0 ? pauseCell.v : pauseCell.v;
          if (v < 5) breakMinutes = Math.round(v * 60); // hours → minutes
          else       breakMinutes = Math.round(v);       // already minutes
        } else {
          const w = (pauseCell.w ?? String(pauseCell.v ?? '')).trim();
          const m = w.match(/^(\d+)[:\.](\d+)/);
          if (m) breakMinutes = parseInt(m[1]) * 60 + parseInt(m[2]);
          else {
            const n = parseFloat(w.replace(',', '.'));
            if (!isNaN(n)) breakMinutes = n < 5 ? Math.round(n * 60) : Math.round(n);
          }
        }
      }
    }

    // Total
    let totalHours: number | null = null;
    if (map.totalCol !== null) {
      const totalCell = getCell(ws, map.totalCol, r);
      if (totalCell?.t === 'n' && typeof totalCell.v === 'number') {
        const v = totalCell.v;
        // Serial time fraction → hours
        totalHours = v < 2 ? Math.round(v * 24 * 100) / 100 : v;
      } else {
        const n = cellNum(ws, map.totalCol, r);
        if (n !== null) totalHours = n;
      }
    }

    const weekday = cellText(ws, map.weekdayCol, r) || null;
    const notes   = map.remarkCol !== null ? cellText(ws, map.remarkCol, r) || null : null;

    const confidence: 'high' | 'medium' | 'low' =
      date && (shifts.length > 0 || absenceCode) ? 'high' :
      date ? 'medium' : 'low';

    records.push({
      date, weekday, shifts,
      breakMinutes, totalHours, absenceCode, notes,
      rawCells: {
        dateCell:     dateCell   ? XLSX.utils.encode_cell({ r, c: map.dateCol })   : undefined,
        workTimeCell: fromCell   ? XLSX.utils.encode_cell({ r, c: map.fromCol })   : undefined,
        pauseCell:    map.pauseCol !== null ? XLSX.utils.encode_cell({ r, c: map.pauseCol }) : undefined,
        totalCell:    map.totalCol !== null ? XLSX.utils.encode_cell({ r, c: map.totalCol }) : undefined,
        remarkCell:   map.remarkCol !== null ? XLSX.utils.encode_cell({ r, c: map.remarkCol }) : undefined,
      },
      confidence,
    });
  }
  return records;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TOTALE ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Zonenbasierte Totale-Erkennung:
 * Scannt nur die obersten 15 und untersten 15 Zeilen des Blocks,
 * wo Mirus-Monatstotale typischerweise stehen.
 * Konvertiert HH:MM automatisch zu Dezimalstunden.
 */
function readTotals(ws: XLSX.WorkSheet, blockStart: number, blockEnd: number): EmployeeTotals {
  const totals: EmployeeTotals = {};
  const ref = ws['!ref'];
  if (!ref) return totals;
  const range = XLSX.utils.decode_range(ref);

  // Nur obere und untere Zone scannen (Totale stehen nie in der Mitte)
  const topEnd      = Math.min(blockStart + 14, blockEnd);
  const bottomStart = Math.max(blockEnd - 14, topEnd + 1);
  const zones: [number, number][] = [[blockStart, topEnd]];
  if (bottomStart <= blockEnd) zones.push([bottomStart, blockEnd]);

  for (const [zStart, zEnd] of zones) {
    for (let r = zStart; r <= zEnd; r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
        const cell = getCell(ws, c, r);
        if (!cell) continue;
        // Labels sind immer Strings — Zahlen-Zellen überspringen
        const rawText = String(cell.v ?? cell.w ?? '').trim();
        if (!rawText || rawText.length < 2) continue;
        const norm = normLabel(rawText);

        for (const { key, patterns } of TOTAL_LABELS) {
          if (totals[key]) continue; // bereits gefunden
          // Exakter Match oder Pattern ist vollständiges Wort am Anfang
          const hit = patterns.some(p =>
            norm === p ||
            norm.startsWith(p + ' ') ||
            norm === p.replace(/\s/g, '')
          );
          if (!hit) continue;

          // Wert in den nächsten 5 Spalten suchen
          for (let dc = 1; dc <= 5; dc++) {
            const valCell = getCell(ws, c + dc, r);
            if (!valCell) continue;
            // Zuerst als Stundenwert interpretieren (HH:MM oder Dezimal, inkl. 0.0)
            const parsed = parseHoursValue(valCell);
            if (parsed !== null) {
              totals[key] = parsed.display || String(parsed.decimal);
              break;
            }
            // Fallback: beliebiger nicht-leerer String (ausser Strich/leer)
            const s = (valCell.w ?? String(valCell.v ?? '')).trim();
            if (s && s !== '-') {
              totals[key] = s;
              break;
            }
          }
        }
      }
    }
  }
  return totals;
}

/** Berechnet Gesamtstunden aus Tageszeilen und vergleicht mit geparsten Totalen. */
function computeTotalsCheck(totals: EmployeeTotals, days: DayRecord[]): void {
  const daySum = days.reduce((s, d) => s + (d.totalHours ?? 0), 0);
  totals.calculatedTotalHours = Math.round(daySum * 100) / 100;

  if (totals.totalHours) {
    const parsed = toDecimalHours(totals.totalHours);
    if (parsed !== null && parsed > 0) {
      totals.totalsDiff      = Math.round(Math.abs(parsed - daySum) * 100) / 100;
      totals.totalsValidated = totals.totalsDiff < 1.0;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MONATSKONTEN ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type AcctKey = 'hours' | 'vacation' | 'holiday' | 'overtime' | 'comp';
type SubKey  = keyof MonthlyAccountEntry;

const ACCT_SECTION_PATS: { type: AcctKey; pats: string[] }[] = [
  { type: 'hours',    pats: ['stundenkonto', 'zeitkonto', 'std-kto', 'stunden-kto', 'stunden kto', 'std kto', 'std.kto', 'arbeitszeitkonto', 'arbeitszeit konto'] },
  { type: 'vacation', pats: ['ferienkonto', 'ferien-kto', 'ferien kto', 'ferien-konto', 'ferien kto.', 'ferienkto', 'urlaubskonto', 'urlaub konto', 'urlaub-kto'] },
  { type: 'holiday',  pats: ['feiertagskonto', 'feiertag konto', 'feiertag-kto', 'feiertagsk.', 'feiertag kto', 'feiertagskto', 'feiertage konto', 'gesetzl. feiertage'] },
  { type: 'overtime', pats: ['überzeitkonto', 'ueberzeit konto', 'überzeit-kto', 'überstdkonto', 'überstunden', 'überzeit kto', 'überzeitkto', 'ueberzeit-kto'] },
  { type: 'comp',     pats: ['kompensationskonto', 'kompens.-kto', 'komp-konto', 'kompkonto', 'kompensation konto', 'komp konto', 'kompens kto'] },
];

const ACCT_SUB_PATS: { key: SubKey; pats: string[] }[] = [
  { key: 'openingBalance', pats: ['vortr', 'vorsaldo', 'übertrag', 'übertr.', 'anfangss', 'anfang', 'anfangssaldo', 'vortrag'] },
  { key: 'correction',     pats: ['korr', 'korrekt', 'korrektur'] },
  { key: 'planned',        pats: ['soll', 'gut.', 'gutschr', 'gutschrift', 'geplant', 'anspruch'] },
  { key: 'actual',         pats: ['ist', 'bez.', 'bezug', 'bezogen', 'bez', 'verb.', 'verbrauch', 'genommen', 'genommene', 'tatsächlich', 'tatsächl.'] },
  { key: 'paidOut',        pats: ['ausbez.', 'ausb.', 'ausbez', 'ausgezahlt', 'auszahlung'] },
  { key: 'difference',     pats: ['diff.', 'diff', 'differenz', 'abw.', 'abweichung'] },
  { key: 'compensation',   pats: ['komp.', 'kompens', 'kompensation'] },
  { key: 'surcharge',      pats: ['zus.', 'zuschlag', 'zeitzu', 'zeitzuschlag'] },
  { key: 'days',           pats: ['tage', 'arbeitstage', 'ferientage', 'tg.', 'tg'] },
  { key: 'closingBalance', pats: ['saldo', 'endsaldo', 'schluss', 'schlussbestand', 'endbestand', 'rest', 'guthaben'] },
];

function readMonthlyAccounts(ws: XLSX.WorkSheet, blockStart: number, blockEnd: number): MonthlyAccounts {
  const result: MonthlyAccounts = {
    hours: {}, vacation: {}, holiday: {}, overtime: {}, comp: {},
    rawLines: [],
  };
  const ref = ws['!ref'];
  if (!ref) return result;
  const range = XLSX.utils.decode_range(ref);

  function toNorm(s: string): string {
    return s.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function matchSection(norm: string): AcctKey | null {
    for (const { type, pats } of ACCT_SECTION_PATS) {
      if (pats.some(p => norm === p || norm.startsWith(p) || norm.includes(p))) return type;
    }
    return null;
  }
  function matchSub(norm: string): SubKey | null {
    for (const { key, pats } of ACCT_SUB_PATS) {
      if (pats.some(p => norm === p || norm.startsWith(p + ' ') || norm.startsWith(p))) return key;
    }
    return null;
  }
  function readRight(c: number, r: number): string | null {
    for (let dc = 1; dc <= 8; dc++) {
      const vc = getCell(ws, c + dc, r);
      if (!vc) continue;
      const ph = parseHoursValue(vc);
      if (ph) return ph.display || String(ph.decimal);
      const s = (vc.w ?? String(vc.v ?? '')).trim();
      // Accept numeric-ish values (incl. negative) but not label text
      if (s && s !== '0' && s !== '-' && s.length < 20 && /^-?[\d:.,]/.test(s)) return s;
    }
    return null;
  }

  let currentSection: AcctKey | null = null;

  // Scan the entire block — Mirus places Monatskonten both at the top (header zone)
  // and at the bottom (summary zone). Limiting to top 15 rows missed bottom-placed accounts.
  for (let r = blockStart; r <= blockEnd; r++) {
    for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const raw  = (cell.w ?? String(cell.v ?? '')).trim();
      if (!raw || raw.length < 2) continue;
      const norm = toNorm(raw);

      // 1. Section header detection — takes priority
      const sec = matchSection(norm);
      if (sec) {
        currentSection = sec;
        result.rawLines.push({ label: raw, value: '', cellAddr: XLSX.utils.encode_cell({ r, c }), accountType: sec });
        continue;
      }

      // 2. Sub-label detection (needs active section context)
      if (currentSection) {
        const sub = matchSub(norm);
        if (sub) {
          const acct = result[currentSection] as Record<string, string | null>;
          if (!acct[sub]) {
            const val = readRight(c, r);
            if (val) {
              acct[sub] = val;
              result.rawLines.push({ label: raw, value: val, cellAddr: XLSX.utils.encode_cell({ r, c }), accountType: currentSection });
            }
          }
        }
      }
    }
  }

  // Compound-label fallback: e.g. "Feriensaldo", "Ferien Vortr." without explicit section header
  // Scans the ENTIRE block — Mirus places these labels anywhere (top header or bottom summary).
  type CompoundRule = { acct: AcctKey; sub: SubKey; pats: string[] };
  const COMPOUND: CompoundRule[] = [
    // ── Ferien: Endsaldo / Rest ──────────────────────────────────────────────
    { acct: 'vacation', sub: 'closingBalance', pats: [
      'feriensaldo', 'ferien saldo', 'ferien endsaldo', 'ferienguthaben', 'ferien guthaben',
      'ferienendsaldo', 'urlaub saldo', 'urlaubssaldo', 'urlaubsguthaben',
      'schlussbestand ferien', 'endsaldo ferien', 'ferienbestand', 'ferienrest',
      'ferien rest', 'ferien restguthaben', 'ferienrestguthaben',
      'urlaubsrest', 'urlaubsbestand', 'urlaubsendsaldo', 'resturlaub',
      'endsaldo urlaub', 'schlussbestand urlaub',
    ]},
    // ── Ferien: Vortrag ──────────────────────────────────────────────────────
    { acct: 'vacation', sub: 'openingBalance', pats: [
      'ferien vortr', 'ferien vorsaldo', 'ferienvortrag', 'ferien vortrag',
      'urlaub vortr', 'urlaubsvortrag', 'ferien übertrag', 'ferienvortrag',
    ]},
    // ── Ferien: Bezogen / IST ────────────────────────────────────────────────
    { acct: 'vacation', sub: 'actual', pats: [
      'ferien bezogen', 'ferien ist', 'ferienbezug', 'ferien bezug',
      'ferien-bezogen', 'ferien-bezug', 'bezogen ferien', 'ferienbezogen',
      'ferien verb.', 'ferien verbrauch', 'ferienistsaldo',
      'urlaub bezogen', 'urlaubsbezug', 'urlaub bezug',
      'ferien tage bezogen', 'ferien-tage', 'ferien genommen',
    ]},
    // ── Ferien: Soll / Anspruch ──────────────────────────────────────────────
    { acct: 'vacation', sub: 'planned', pats: [
      'ferien soll', 'ferien anspruch', 'ferienanspruch', 'feriengutsoll',
      'urlaub soll', 'urlaubsanspruch',
    ]},
    // ── Stunden: Endsaldo ───────────────────────────────────────────────────
    { acct: 'hours',    sub: 'closingBalance', pats: ['stundensaldo', 'std saldo', 'zeit saldo', 'zeitkonto saldo'] },
    { acct: 'hours',    sub: 'openingBalance', pats: ['stunden vortr', 'std vortr', 'stundenvortrag', 'std. vortr'] },
    // ── Feiertage: Endsaldo / Rest ───────────────────────────────────────────
    { acct: 'holiday',  sub: 'closingBalance', pats: [
      'feiertagssaldo', 'feiertage saldo', 'feiertagguthaben', 'feiertag guthaben',
      'feiertage endsaldo', 'feiertagendsaldo', 'feiertagbestand', 'endsaldo feiertag',
      'schlussbestand feiertag', 'feiertage rest', 'feiertag rest',
      'ft saldo', 'ft rest', 'ft guthaben',
    ]},
    // ── Feiertage: Vortrag ───────────────────────────────────────────────────
    { acct: 'holiday',  sub: 'openingBalance', pats: [
      'feiertage vortr', 'feiertag vortrag', 'feiertage vortrag', 'feiertag vortr',
      'ft vortr', 'ft vortrag',
    ]},
    // ── Feiertage: Bezogen / IST ─────────────────────────────────────────────
    { acct: 'holiday',   sub: 'actual', pats: [
      'feiertag bezogen', 'feiertage bezogen', 'feiertag ist', 'feiertagbezogen',
      'feiertag-bezogen', 'feiertag verb.', 'feiertag bezug', 'feiertage bezug',
      'ft bezogen', 'ft bezug', 'ft ist', 'feiertag genommen',
    ]},
    // ── Überzeit ─────────────────────────────────────────────────────────────
    { acct: 'overtime', sub: 'closingBalance', pats: ['überzeitsaldo', 'ueberzeit saldo', 'überstd saldo', 'ueberzeit saldo'] },
    { acct: 'overtime',  sub: 'openingBalance', pats: ['überzeit vortr', 'ueberzeit vortr', 'überstd vortr'] },
  ];
  // CRITICAL: scan the full block, not just the top 15 rows.
  // Mirus can place compound balance labels at the bottom of the employee block.
  for (let r = blockStart; r <= blockEnd; r++) {
    for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
      const cell = getCell(ws, c, r);
      if (!cell || cell.t !== 's') continue;
      const raw  = String(cell.v ?? '').trim();
      if (!raw) continue;
      const norm = toNorm(raw);
      for (const { acct, sub, pats } of COMPOUND) {
        if (!pats.some(p => norm === p || norm.includes(p))) continue;
        const a = result[acct] as Record<string, string | null>;
        if (a[sub]) break;
        const val = readRight(c, r);
        if (val) {
          a[sub] = val;
          result.rawLines.push({ label: raw, value: val, cellAddr: XLSX.utils.encode_cell({ r, c }), accountType: acct });
        }
        break;
      }
    }
  }

  return result;
}

function mergeMonthlyAccounts(a: MonthlyAccounts, b: MonthlyAccounts): MonthlyAccounts {
  function mergeEntry(
    x: Partial<MonthlyAccountEntry>,
    y: Partial<MonthlyAccountEntry>,
  ): Partial<MonthlyAccountEntry> {
    return {
      openingBalance: x.openingBalance ?? y.openingBalance ?? null,
      correction:     x.correction     ?? y.correction     ?? null,
      planned:        x.planned        ?? y.planned        ?? null,
      actual:         x.actual         ?? y.actual         ?? null,
      paidOut:        x.paidOut        ?? y.paidOut        ?? null,
      difference:     x.difference     ?? y.difference     ?? null,
      compensation:   x.compensation   ?? y.compensation   ?? null,
      surcharge:      x.surcharge      ?? y.surcharge      ?? null,
      days:           x.days           ?? y.days           ?? null,
      closingBalance: x.closingBalance ?? y.closingBalance ?? null,
    };
  }
  return {
    hours:    mergeEntry(a.hours,    b.hours),
    vacation: mergeEntry(a.vacation, b.vacation),
    holiday:  mergeEntry(a.holiday,  b.holiday),
    overtime: mergeEntry(a.overtime, b.overtime),
    comp:     mergeEntry(a.comp,     b.comp),
    rawLines: [...a.rawLines, ...b.rawLines],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MITARBEITER-META ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const DEPT_PATTERN = /küche|service|housekeeping|büro|kitchen|bar|restaurant|sala|saal|administration|admin|empfang|reception/i;
const DEPT_NUMBERED = /^\d[\s.]+/;

function readMetaRow(ws: XLSX.WorkSheet, row: number): { costCenter: string | null; employmentPeriod: string | null; text: string } {
  const ref = ws['!ref'];
  if (!ref) return { costCenter: null, employmentPeriod: null, text: '' };
  const range = XLSX.utils.decode_range(ref);

  const parts: string[] = [];
  let costCenter: string | null = null;
  let employmentPeriod: string | null = null;

  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = getCell(ws, c, row);
    if (!cell) continue;
    const text = (cell.w ?? String(cell.v ?? '')).trim();
    if (!text) continue;
    parts.push(text);

    // Kostenstelle: "Küche", "1 Küche", "2. Service", "3 Bar" usw.
    if (!costCenter && DEPT_PATTERN.test(text))
      costCenter = text.replace(DEPT_NUMBERED, '').trim() || text;

    // Datum für Beschäftigungsperiode
    if (!employmentPeriod && /\d{2}\.\d{2}\.\d{4}/.test(text))
      employmentPeriod = text;
  }

  // Zweiter Pass: kombinierte Felder "Kostenstelle: Küche" oder "Kü" / "Sv" Kürzel
  if (!costCenter) {
    for (const part of parts) {
      const low = part.toLowerCase();
      if (/\bkü\b/.test(low) || /^ku$/i.test(low))              { costCenter = 'Küche'; break; }
      if (/\bsv\b/.test(low) || /^serv$/i.test(low))            { costCenter = 'Service'; break; }
      if (/kostenstelle\s*:?\s*([\w\s]+)/i.test(part)) {
        costCenter = RegExp.$1.trim(); break;
      }
    }
  }

  return { costCenter, employmentPeriod, text: parts.join(' | ') };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BLOCK PARSEN ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function parseBlock(
  ws: XLSX.WorkSheet,
  blockStart: number,  // 0-basiert
  blockEnd: number,    // 0-basiert
  sheetName: string,
): ExcelEmployee {
  // ── 1. Marker-Spalte ermitteln (nicht mehr fix auf C) ────────────────────────
  const markerCol = findMarkerCol(ws, blockStart);

  // ── 2. extractEmployee: Name RECHTS vom Marker — keine fixen Spalten ────────
  const name = extractEmployee(ws, blockStart, markerCol);

  // ── 3. extractWeeklyHours: label-basiert + Fallback auf BO ──────────────────
  const weeklyHours = extractWeeklyHours(ws, blockStart, blockEnd);

  // ── 4. extractEmployment: "Arbeitsverhältnis"-Marker + Datums-Pattern ───────
  const employmentPeriod = extractEmployment(ws, blockStart, blockEnd);

  // ── 5. Meta-Zeile für Kostenstelle (Abteilung) ───────────────────────────────
  const metaRow  = blockStart + LAYOUT.metaRowOffset;
  const meta     = readMetaRow(ws, metaRow);
  const { costCenter } = meta;

  // Abteilung ableiten
  let department: string | null = null;
  if (costCenter) {
    if (/küche|kitchen|koch/i.test(costCenter))     department = 'Küche';
    else if (/service|sala|saal/i.test(costCenter)) department = 'Service';
    else if (/bar/i.test(costCenter))               department = 'Bar';
    else if (/housekeeping|hk/i.test(costCenter))   department = 'Housekeeping';
    else if (/büro|admin|office/i.test(costCenter)) department = 'Büro';
    else department = costCenter;
  }

  // ── 6. extractHeaders: Header-Zeile dynamisch suchen ─────────────────────────
  const headerRow = extractHeaders(ws, blockStart, blockEnd);

  // ── 7. Spalten-Map auf Basis der Header-Zeile ────────────────────────────────
  const { map: colMap, detected } = detectColMap(ws, blockStart, Math.min(headerRow + 2, blockEnd));

  // ── 8. extractDayEntries: Tageszeilen ab NACH der Header-Zeile ───────────────
  const days = extractDayEntries(ws, headerRow, blockEnd, colMap);

  // ── 9. Totale + Monatskonten ─────────────────────────────────────────────────
  const totals = readTotals(ws, blockStart, blockEnd);
  computeTotalsCheck(totals, days);

  // extractBalances: Ferien/Feiertag/Total-Saldi ergänzen falls readTotals leer
  // Mitarbeitername für Debug-Ausgabe mitgeben
  const balances = extractBalances(ws, blockStart, blockEnd, name ?? undefined);
  if (!totals.ferien   && balances.ferien   != null) totals.ferien   = balances.ferien;
  if (!totals.feiertag && balances.feiertag != null) totals.feiertag = balances.feiertag;
  // Row-Found-Flags: OR aus readTotals-Treffern und extractBalances-Befunden
  const vacationRowFound = balances.ferienRowFound  || !!(totals.ferien);
  const holidayRowFound  = balances.feierRowFound   || !!(totals.feiertag);

  const monthlyAccounts = readMonthlyAccounts(ws, blockStart, blockEnd);

  // ── 10. Fallback: Abteilung aus Tageszeilen-Bemerkungen ─────────────────────
  if (!department && days.length > 0) {
    const deptHints = days
      .map(d => d.notes ?? '')
      .filter(Boolean)
      .flatMap(n => {
        if (/küche|kitchen/i.test(n)) return ['Küche'];
        if (/service/i.test(n))       return ['Service'];
        if (/\bbar\b/i.test(n))       return ['Bar'];
        return [];
      });
    if (deptHints.length > 0) department = deptHints[0];
  }

  // ── Display-Infos für Diagnose ───────────────────────────────────────────────
  const detectedForDisplay: Record<string, string> = {
    markerCol: XLSX.utils.encode_col(markerCol),
    headerRow: String(headerRow + 1),
    date:      XLSX.utils.encode_col(colMap.dateCol),
    weekday:   XLSX.utils.encode_col(colMap.weekdayCol),
    from:      XLSX.utils.encode_col(colMap.fromCol),
    to:        colMap.toCol    !== null ? XLSX.utils.encode_col(colMap.toCol)    : '—',
    pause:     colMap.pauseCol !== null ? XLSX.utils.encode_col(colMap.pauseCol) : '—',
    total:     colMap.totalCol !== null ? XLSX.utils.encode_col(colMap.totalCol) : '—',
    remark:    colMap.remarkCol !== null ? XLSX.utils.encode_col(colMap.remarkCol) : '—',
    ...detected,
  };

  const startRow1 = blockStart + 1;
  const endRow1   = blockEnd + 1;
  return {
    name, department, costCenter, weeklyHours, employmentPeriod,
    sheetName,
    blockStartRow: startRow1,
    blockEndRow:   endRow1,
    days, totals, monthlyAccounts,
    rawBlock: {
      markerCell:       XLSX.utils.encode_cell({ r: blockStart, c: markerCol }),
      nameCell:         `${XLSX.utils.encode_col(markerCol + 1)}${blockStart + 1} (rechts vom Marker)`,
      weeklyHoursCell:  `label-basiert + Fallback ${XLSX.utils.encode_col(LAYOUT.weeklyHoursCol)}`,
      metaRowText:      meta.text,
      detectedColMap:   detectedForDisplay,
    },
    mergedFromCount: 1,
    mergedBlockRows: [[startRow1, endRow1]],
    vacationRowFound,
    holidayRowFound,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── QUALITÄT ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function employeeQuality(emp: ExcelEmployee): number {
  let s = 0;
  const days   = emp.days;
  const totals = emp.totals;
  const active = days.filter(d => d.shifts.length > 0 || !!d.absenceCode).length;

  if (emp.name)                         s += 25;
  if (emp.weeklyHours)                  s += 8;
  if (emp.costCenter || emp.department) s += 8;

  // Tagesdaten: validierter Cross-Check → volle Punktzahl unabhängig von Tagesanzahl
  // (Aushilfen, Krankenmonate, Eintritt/Austritt haben oft weniger Tage)
  if (totals.totalsValidated && days.length > 0) {
    s += 27;
  } else if (days.length >= 20) s += 27;
  else if   (days.length >= 14) s += 22;
  else if   (days.length >= 7)  s += 15;
  else if   (days.length >= 1)  s += 8;

  // Aktive Tage (Schichten oder Absenzen)
  if      (active >= 10) s += 14;
  else if (active >= 3)  s += 9;
  else if (active >= 1)  s += 4;

  // Totale erkannt (+8) + validiert (+10)
  if (totals.totalHours)      s += 8;
  if (totals.totalsValidated) s += 10;

  // Monatskonten erkannt: Vorsaldo+Endsaldo Stunden (+4), Ferien (+2)
  const ma = emp.monthlyAccounts;
  if (ma?.hours?.openingBalance && ma?.hours?.closingBalance) s += 4;
  if (ma?.vacation?.closingBalance)                           s += 2;

  return Math.min(100, s);
}

function docQuality(employees: ExcelEmployee[]): ExcelDocQuality {
  if (!employees.length) return {
    totalEmployees: 0, employeesWithName: 0, employeesWithDays: 0,
    employeesWithTotals: 0, totalDayRecords: 0, daysWithShifts: 0, qualityPercent: 0,
  };
  const employeesWithName   = employees.filter(e => !!e.name).length;
  const employeesWithDays   = employees.filter(e => e.days.length > 0).length;
  const employeesWithTotals = employees.filter(e => !!e.totals.totalHours).length;
  const totalDayRecords     = employees.reduce((s, e) => s + e.days.length, 0);
  const daysWithShifts      = employees.reduce((s, e) => s + e.days.filter(d => d.shifts.length > 0 || !!d.absenceCode).length, 0);
  const avg = employees.reduce((s, e) => s + employeeQuality(e), 0) / employees.length;
  return { totalEmployees: employees.length, employeesWithName, employeesWithDays, employeesWithTotals, totalDayRecords, daysWithShifts, qualityPercent: Math.round(avg) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── BLOCK-ZUSAMMENFÜHRUNG ────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** Normalisierter Name für Vergleich (Akzente, Gross/Klein, Leerzeichen) */
function normName(name: string | null): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Leerer-Block-Erkennung:
 * Ein Block ist wirklich leer wenn er KEINEN Namen, KEINE Tage und KEINE Totale hat.
 * Leere Blöcke werden übersprungen (nicht mit dem vorherigen Block zusammengeführt).
 * NICHT mehr: "weniger als 8 Tage" — das würde in grossen Sheets alle MA zusammenführen.
 */
function isEmptyBlock(emp: ExcelEmployee): boolean {
  const hasName   = !!emp.name;
  const hasDays   = emp.days.length > 0;
  const hasTotals = Object.values(emp.totals).some(v => v !== undefined && v !== null && v !== '');
  return !hasName && !hasDays && !hasTotals;
}

function mergeTotals(a: EmployeeTotals, b: EmployeeTotals): EmployeeTotals {
  return {
    totalHours:   a.totalHours   ?? b.totalHours,
    pauseTotal:   a.pauseTotal   ?? b.pauseTotal,
    nettoTotal:   a.nettoTotal   ?? b.nettoTotal,
    sollStunden:  a.sollStunden  ?? b.sollStunden,
    zeitzuschlag: a.zeitzuschlag ?? b.zeitzuschlag,
    ueberzeit:    a.ueberzeit    ?? b.ueberzeit,
    saldo:        a.saldo        ?? b.saldo,
    ferien:       a.ferien       ?? b.ferien,
    feiertag:     a.feiertag     ?? b.feiertag,
    kompensation: a.kompensation ?? b.kompensation,
    krankheit:    a.krankheit    ?? b.krankheit,
    // Computed fields werden nach dem Merge neu berechnet
    calculatedTotalHours: undefined,
    totalsValidated:      undefined,
    totalsDiff:           undefined,
  };
}

function mergeTwoBlocks(main: ExcelEmployee, extra: ExcelEmployee): ExcelEmployee {
  const existingRows = main.mergedBlockRows.length > 0
    ? main.mergedBlockRows
    : [[main.blockStartRow, main.blockEndRow ?? main.blockStartRow]] as [number, number][];
  const extraRow: [number, number] = [extra.blockStartRow, extra.blockEndRow ?? extra.blockStartRow];
  const merged: ExcelEmployee = {
    name:             main.name             ?? extra.name,
    department:       main.department       ?? extra.department,
    costCenter:       main.costCenter       ?? extra.costCenter,
    weeklyHours:      main.weeklyHours      ?? extra.weeklyHours,
    employmentPeriod: main.employmentPeriod ?? extra.employmentPeriod,
    sheetName:        main.sheetName,
    blockStartRow:    main.blockStartRow,
    blockEndRow:      extra.blockEndRow ?? main.blockEndRow,
    days:             [...main.days, ...extra.days],
    totals:           mergeTotals(main.totals, extra.totals),
    monthlyAccounts:  mergeMonthlyAccounts(main.monthlyAccounts, extra.monthlyAccounts),
    rawBlock:         main.rawBlock,
    mergedFromCount:  main.mergedFromCount + 1,
    mergedBlockRows:  [...existingRows, extraRow],
    vacationRowFound: (main.vacationRowFound || extra.vacationRowFound) ?? false,
    holidayRowFound:  (main.holidayRowFound  || extra.holidayRowFound)  ?? false,
  };
  // Totales-Cross-Check nach Merge neu berechnen (mehr Tage verfügbar)
  computeTotalsCheck(merged.totals, merged.days);
  return merged;
}

/**
 * Hauptfunktion: fügt Blöcke mit gleichem Namen zusammen und überspringt leere Blöcke.
 *
 * Merge-Bedingungen:
 *   A) Gleicher normalisierter Name (nicht leer) → immer zusammenführen (Fortsetzungs-Seiten)
 *   B) Block ist vollständig leer (kein Name, keine Tage, keine Totale) → überspringen
 *
 * ENTFERNT: Gap-basierte Restblock-Zusammenführung.
 * Grund: blockEnd = nextStart-1 → gap ist immer 1 → alle Blöcke würden zusammengeführt.
 */
function mergeBlocks(raw: ExcelEmployee[]): ExcelEmployee[] {
  const tagged: ExcelEmployee[] = raw.map(e => ({
    ...e,
    mergedFromCount: 1,
    mergedBlockRows: [[e.blockStartRow, e.blockEndRow ?? e.blockStartRow]] as [number, number][],
  }));

  let skippedEmpty = 0;
  const result: ExcelEmployee[] = [];

  for (const emp of tagged) {
    // Condition B: truly empty block → überspringen, nicht zusammenführen
    if (isEmptyBlock(emp)) {
      skippedEmpty++;
      continue;
    }

    const last = result[result.length - 1];
    if (!last) { result.push(emp); continue; }

    // Condition A: gleicher Name (nicht leer) → Fortsetzungs-Seite zusammenführen
    const normA = normName(emp.name);
    const normB = normName(last.name);
    const sameNorm = normA !== '' && normA === normB;
    if (sameNorm) {
      result[result.length - 1] = mergeTwoBlocks(last, emp);
      continue;
    }

    result.push(emp);
  }

  const mergedDuplicates = result.reduce((s, e) => s + (e.mergedFromCount > 1 ? e.mergedFromCount - 1 : 0), 0);

  if (skippedEmpty > 0) {
    console.log(`[MIRUS-PARSER] ${skippedEmpty} leere Block(e) übersprungen`);
  }

  return { result, skippedEmpty, mergedDuplicates };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DATEINAME / META ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const MONTH_MAP: Record<string, [number, string]> = {
  januar: [1, 'Januar'],  january: [1, 'Januar'],
  februar: [2, 'Februar'], february: [2, 'Februar'],
  maerz: [3, 'März'],     märz: [3, 'März'],    march: [3, 'März'],
  april: [4, 'April'],
  mai: [5, 'Mai'],        may: [5, 'Mai'],
  juni: [6, 'Juni'],      june: [6, 'Juni'],
  juli: [7, 'Juli'],      july: [7, 'Juli'],
  august: [8, 'August'],
  september: [9, 'September'],
  oktober: [10, 'Oktober'], october: [10, 'Oktober'],
  november: [11, 'November'],
  dezember: [12, 'Dezember'], december: [12, 'Dezember'],
};

/** Normalisiert Umlaute: ä→ae, ö→oe, ü→ue, ß→ss (für Dateiname-Matching) */
function normalizeUmlauts(s: string): string {
  return s
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'ae').replace(/Ö/g, 'oe').replace(/Ü/g, 'ue');
}

function metaFromFileName(fileName: string): { month: number | null; monthName: string | null; year: number | null; restaurant: string | null } {
  // Normalisierung: Umlauts → ASCII + lowercase
  const lower = normalizeUmlauts(fileName).toLowerCase().replace(/[_\-]/g, ' ');
  let month: number | null = null;
  let monthName: string | null = null;
  let restaurant: string | null = null;

  // Restaurant aus Dateiname
  if (/\boliv\b/.test(lower))    restaurant = 'oliv';
  else if (/beaulieu/.test(lower)) restaurant = 'beaulieu';

  // Monatsname-Match (inkl. normalisierte Umlauts)
  for (const [token, [m, n]] of Object.entries(MONTH_MAP)) {
    if (lower.includes(token)) { month = m; monthName = n; break; }
  }

  // Numerischer Monats-Fallback: "03 2026", "03.2026", "2026-03", "2026/03"
  if (!month) {
    const m1 = lower.match(/\b(0[1-9]|1[0-2])[.\s](20\d{2})\b/);
    if (m1) { month = parseInt(m1[1]); }
    const m2 = lower.match(/\b(20\d{2})[.\-\/\s](0[1-9]|1[0-2])\b/);
    if (!month && m2) { month = parseInt(m2[2]); }
    if (month) {
      monthName = Object.values(MONTH_MAP).find(([m]) => m === month)?.[1] ?? null;
    }
  }

  const ym = fileName.match(/20\d{2}/);
  return { month, monthName, year: ym ? parseInt(ym[0]) : null, restaurant };
}

/** Versucht Monat/Jahr aus dem Workbook-Inhalt zu lesen (erste 15 Zeilen, alle Sheets) */
function metaFromWorkbook(wb: XLSX.WorkBook): { month: number | null; year: number | null } {
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const ref = ws['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    for (let r = range.s.r; r <= Math.min(range.e.r, 14); r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 20); c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const raw = String(cell.v ?? cell.w ?? '');
        // Normalisiere Umlauts für Monatsname-Erkennung
        const norm = normalizeUmlauts(raw).toLowerCase();
        // "März 2026", "Monatsblatt März 2026"
        for (const [token, [m]] of Object.entries(MONTH_MAP)) {
          if (norm.includes(token)) {
            const ymatch = raw.match(/20\d{2}/);
            const y = ymatch ? parseInt(ymatch[0]) : null;
            if (y) return { month: m, year: y };
          }
        }
        // "03.2026", "2026-03", "03/2026"
        const n1 = raw.match(/\b(0[1-9]|1[0-2])[.\-\/](20\d{2})\b/);
        if (n1) return { month: parseInt(n1[1]), year: parseInt(n1[2]) };
        const n2 = raw.match(/\b(20\d{2})[.\-\/](0[1-9]|1[0-2])\b/);
        if (n2) return { month: parseInt(n2[2]), year: parseInt(n2[1]) };
      }
    }
  }
  return { month: null, year: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPT-EXPORT ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** Versucht Restaurant aus Workbook-Inhalt zu erkennen (Tabellenblatt-Namen + erste Zellen) */
function restaurantFromWorkbook(wb: XLSX.WorkBook): string | null {
  // 1. Tabellenblatt-Namen prüfen
  for (const sn of wb.SheetNames) {
    const snl = sn.toLowerCase();
    if (/\boliv\b/.test(snl))   return 'oliv';
    if (/beaulieu/.test(snl))   return 'beaulieu';
  }
  // 2. Ersten Sheet nach Text in A1–AZ10 durchsuchen
  const firstWs = wb.Sheets[wb.SheetNames[0]];
  if (firstWs) {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 52; c++) {
        const cell = firstWs[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const txt = String(cell.v ?? '').toLowerCase();
        if (/\boliv\b/.test(txt))  return 'oliv';
        if (/beaulieu/.test(txt))  return 'beaulieu';
      }
    }
  }
  return null;
}

// ─── Parser-Fehlerklasse ──────────────────────────────────────────────────────

export type MirusParseStage =
  | 'fileRead'       // file.arrayBuffer() / FileReader fehlgeschlagen
  | 'xlsRead'        // XLSX.read() fehlgeschlagen (kein gültiges Excel)
  | 'noSheets'       // Workbook hat keine Sheets
  | 'noMarkers'      // Kein „Name / Vorname"-Marker in keinem Sheet
  | 'noEmployees'    // Parsing ergab keine Mitarbeiter
  | 'parse'          // Unbekannter Fehler beim Parsen

export class MirusParseError extends Error {
  stage:  MirusParseStage;
  detail: string;
  constructor(stage: MirusParseStage, detail: string, cause?: unknown) {
    super(`[MirusParser:${stage}] ${detail}`);
    this.name    = 'MirusParseError';
    this.stage   = stage;
    this.detail  = detail;
    if (cause instanceof Error && cause.stack) {
      this.stack = this.stack + '\nCaused by: ' + cause.stack;
    }
  }
}

/** Liest eine Datei als BinaryString über FileReader (Fallback für alte XLS-Dateien) */
function readAsBinaryString(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message ?? 'unbekannt'}`));
    reader.readAsBinaryString(file);
  });
}

/** Liest eine Datei als ArrayBuffer über FileReader */
function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target?.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message ?? 'unbekannt'}`));
    reader.readAsArrayBuffer(file);
  });
}

export async function parseMirusExcel(file: File): Promise<ExcelParsedDocument> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  console.debug(`[MIRUS-PARSER] Datei erkannt: „${file.name}" (${(file.size / 1024).toFixed(1)} KB, type="${file.type}", ext=".${ext}")`);

  // ── Stage 1: Datei lesen ────────────────────────────────────────────────────
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
    console.debug(`[MIRUS-PARSER] ArrayBuffer gelesen: ${buf.byteLength} Bytes`);
  } catch (e) {
    // Fallback via FileReader (einige Browser unterstützen arrayBuffer() bei alten Files nicht)
    console.warn('[MIRUS-PARSER] file.arrayBuffer() fehlgeschlagen, versuche FileReader…', e);
    try {
      buf = await readAsArrayBuffer(file);
      console.debug(`[MIRUS-PARSER] FileReader ArrayBuffer gelesen: ${buf.byteLength} Bytes`);
    } catch (e2) {
      throw new MirusParseError('fileRead', `Datei konnte nicht gelesen werden: ${e2 instanceof Error ? e2.message : String(e2)}`, e2);
    }
  }

  // ── Stage 2: Workbook öffnen ────────────────────────────────────────────────
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'array', cellDates: true, cellNF: true, cellText: true });
    console.debug(`[MIRUS-PARSER] Workbook geöffnet (array-Modus): ${wb.SheetNames.length} Sheets: [${wb.SheetNames.join(', ')}]`);
  } catch (e) {
    // Fallback: binary-Modus über FileReader.readAsBinaryString (häufig besser für alte .xls)
    console.warn('[MIRUS-PARSER] XLSX.read(array) fehlgeschlagen, versuche binary-Fallback…', e);
    try {
      const binaryStr = await readAsBinaryString(file);
      wb = XLSX.read(binaryStr, { type: 'binary', cellDates: true, cellNF: true, cellText: true });
      console.debug(`[MIRUS-PARSER] Workbook geöffnet (binary-Fallback): ${wb.SheetNames.length} Sheets: [${wb.SheetNames.join(', ')}]`);
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      console.error('[MIRUS-PARSER] Workbook konnte nicht geöffnet werden (array + binary fehlgeschlagen):', e, e2);
      throw new MirusParseError(
        'xlsRead',
        `Excel-Datei konnte nicht geöffnet werden (weder array- noch binary-Modus). Ist die Datei ein gültiges .xlsx/.xls? Fehler: ${msg}`,
        e2,
      );
    }
  }

  // ── Stage 3: Sheets prüfen ──────────────────────────────────────────────────
  if (!wb.SheetNames.length) {
    throw new MirusParseError('noSheets', 'Das Workbook enthält keine Sheets.');
  }
  console.debug(`[MIRUS-PARSER] Parsing gestartet für ${wb.SheetNames.length} Sheet(s)…`);

  const meta      = metaFromFileName(file.name);
  const employees: ExcelEmployee[] = [];
  const warnings:  string[]        = [];
  const sheetsProcessed: string[]  = [];

  // Restaurant: erst aus Dateiname, dann aus Workbook-Inhalt
  const restaurant = meta.restaurant ?? restaurantFromWorkbook(wb);

  // Monat/Jahr: Dateiname hat Vorrang, dann Workbook-Inhalt scannen
  let fileMonth: number | null = meta.month;
  let fileYear:  number | null = meta.year;
  if (!fileMonth || !fileYear) {
    const wbMeta = metaFromWorkbook(wb);
    fileMonth = fileMonth ?? wbMeta.month;
    fileYear  = fileYear  ?? wbMeta.year;
  }

  let totalMarkersFound = 0;
  let totalHeaderTablesFound = 0;

  for (const sheetName of wb.SheetNames) {
    const ws     = wb.Sheets[sheetName];
    console.debug(`[MIRUS-PARSER] Sheet „${sheetName}" wird analysiert…`);
    const starts = findBlockStarts(ws);

    if (starts.length === 0) {
      console.debug(`[MIRUS-PARSER] Sheet „${sheetName}": kein Marker gefunden`);
      warnings.push(`Sheet „${sheetName}": kein „Name / Vorname"-Marker gefunden (Sheet übersprungen)`);
      continue;
    }

    totalMarkersFound += starts.length;
    sheetsProcessed.push(sheetName);
    console.debug(`[MIRUS-PARSER] Sheet „${sheetName}": ${starts.length} Marker auf Zeilen ${starts.map(r => r + 1).join(', ')}`);
    const ref   = ws['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);

    // Zähle Tabellen mit "Datum"+"Arbeitszeit" Header für Debug
    let headerTablesInSheet = 0;
    for (const startRow of starts) {
      const endRow = starts[starts.indexOf(startRow) + 1] ?? range.e.r;
      const hRow = extractHeaders(ws, startRow, endRow);
      // extractHeaders gibt blockStart+daySearchOffset-1 zurück wenn kein Header gefunden
      // Prüfen ob es wirklich eine Header-Zeile ist (nicht nur Fallback)
      const ref2 = ws['!ref'];
      if (ref2) {
        const r2 = XLSX.utils.decode_range(ref2);
        let hasDatum = false, hasZeit = false;
        for (let c = r2.s.c; c <= r2.e.c; c++) {
          const cell = getCell(ws, c, hRow);
          if (!cell) continue;
          const t = String(cell.v ?? '').toLowerCase().trim();
          if (t === 'datum' || t === 'date') hasDatum = true;
          if (/arbeitszeit|von\b|zeit\b|beginn|from\b/.test(t)) hasZeit = true;
        }
        if (hasDatum && hasZeit) headerTablesInSheet++;
      }
    }
    totalHeaderTablesFound += headerTablesInSheet;

    for (let i = 0; i < starts.length; i++) {
      const blockStart = starts[i];
      const blockEnd   = i < starts.length - 1 ? starts[i + 1] - 1 : range.e.r;
      try {
        employees.push(parseBlock(ws, blockStart, blockEnd, sheetName));
      } catch (err) {
        warnings.push(`Block ab Zeile ${blockStart + 1}: ${String(err)}`);
      }
    }
  }

  // ── Stage 4: Marker-Check ────────────────────────────────────────────────────
  if (totalMarkersFound === 0) {
    const sheetList = wb.SheetNames.join(', ');
    throw new MirusParseError(
      'noMarkers',
      `Kein „Name / Vorname"-Marker in keinem Sheet gefunden. ` +
      `Sheets: [${sheetList}]. ` +
      `Ist das die richtige Mirus-Datei? Wird das korrekte Format verwendet?`,
    );
  }

  console.debug(`[MIRUS-PARSER] Parsing beendet: ${employees.length} Roh-Blöcke aus ${sheetsProcessed.length} Sheet(s)`);

  // Blöcke mit gleichem Namen zusammenführen, leere überspringen
  const rawCount = employees.length;
  const { result: merged, skippedEmpty, mergedDuplicates } = mergeBlocks(employees);

  // ─── QUALITÄTS-METRIKEN ───────────────────────────────────────────────────
  // Balance erkannt = Wert vorhanden (inkl. '0') in totals, monthlyAccounts.vacation oder .holiday
  const hasVacBal = (e: ExcelEmployee): boolean =>
    e.totals.ferien != null ||
    e.monthlyAccounts.vacation?.closingBalance != null ||
    e.monthlyAccounts.vacation?.actual != null;

  const hasHolBal = (e: ExcelEmployee): boolean =>
    e.totals.feiertag != null ||
    e.monthlyAccounts.holiday?.closingBalance != null ||
    e.monthlyAccounts.holiday?.actual != null;

  const daysWithHours      = merged.reduce((s, e) => s + e.days.filter(d => (d.totalHours ?? 0) > 0).length, 0);
  const daysWithTimeBlocks = merged.reduce((s, e) => s + e.days.filter(d => d.shifts.length > 0).length, 0);
  const empWithVacation    = merged.filter(hasVacBal).length;
  const empWithHoliday     = merged.filter(hasHolBal).length;

  // Unterscheide: "Zeile nicht vorhanden" vs "Zeile vorhanden aber Wert nicht gelesen"
  const empMissingVacation = merged
    .filter(e => !hasVacBal(e) && !e.vacationRowFound)
    .map(e => e.name ?? '?');
  const empMissingHoliday = merged
    .filter(e => !hasHolBal(e) && !e.holidayRowFound)
    .map(e => e.name ?? '?');
  const empVacRowFoundNoValue = merged
    .filter(e => !hasVacBal(e) && !!e.vacationRowFound)
    .map(e => e.name ?? '?');
  const empHolRowFoundNoValue = merged
    .filter(e => !hasHolBal(e) && !!e.holidayRowFound)
    .map(e => e.name ?? '?');

  const incompleteBlocks = merged.reduce(
    (s, e) => s + e.days.filter(d => d.shifts.some(sh => sh.to === '?')).length, 0
  );

  const qualityWarnings: string[] = [];
  if (merged.length > 0) {
    const blockRate = daysWithHours > 0 ? daysWithTimeBlocks / daysWithHours : 1;
    if (blockRate < 0.90) {
      qualityWarnings.push(
        `Zeitblöcke: nur ${Math.round(blockRate * 100)} % erkannt (${daysWithTimeBlocks}/${daysWithHours} Tage) — bitte Import prüfen`
      );
    }
    const vacRate = empWithVacation / merged.length;
    if (vacRate < 0.80) {
      qualityWarnings.push(
        `Ferienguthaben: nur ${Math.round(vacRate * 100)} % erkannt (${empWithVacation}/${merged.length} MA) — bitte Import prüfen`
      );
    }
    const holRate = empWithHoliday / merged.length;
    if (holRate < 0.80) {
      qualityWarnings.push(
        `Feiertagguthaben: nur ${Math.round(holRate * 100)} % erkannt (${empWithHoliday}/${merged.length} MA) — bitte Import prüfen`
      );
    }
  }

  const parseStats: ExcelParseStats = {
    markersFound:      totalMarkersFound,
    headerTablesFound: totalHeaderTablesFound,
    rawBlocks:         rawCount,
    skippedEmpty,
    mergedDuplicates,
    finalEmployees:    merged.length,
    monthDetected:     !!(fileMonth && fileYear),
    daysWithHours,
    daysWithTimeBlocks,
    employeesWithVacationBalance:    empWithVacation,
    employeesWithHolidayBalance:     empWithHoliday,
    employeesMissingVacation:        empMissingVacation,
    employeesMissingHoliday:         empMissingHoliday,
    employeesVacationRowFoundNoValue: empVacRowFoundNoValue,
    employeesHolidayRowFoundNoValue:  empHolRowFoundNoValue,
    incompleteTimeBlocks:             incompleteBlocks,
    qualityWarnings,
  };

  // Debug-Ausgabe in Konsole
  console.log(
    `[MIRUS-PARSER] „${file.name}": ` +
    `Marker=${parseStats.markersFound} | Tabellen=${parseStats.headerTablesFound} | ` +
    `Roh-Blöcke=${parseStats.rawBlocks} | Übersprungen=${parseStats.skippedEmpty} | ` +
    `Zusammengeführt=${parseStats.mergedDuplicates} | Finale MA=${parseStats.finalEmployees} | ` +
    `Monat=${fileMonth ?? '?'}/${fileYear ?? '?'}`
  );

  // Warnung wenn Monat nicht erkannt
  if (!fileMonth || !fileYear) {
    warnings.push(`Monat/Jahr konnte nicht automatisch erkannt werden — bitte manuell prüfen`);
  }

  return {
    fileName:    file.name,
    month:       fileMonth,
    monthName:   meta.monthName ?? (fileMonth ? (Object.values(MONTH_MAP).find(([m]) => m === fileMonth)?.[1] ?? null) : null),
    year:        fileYear,
    restaurant,
    creationDate: null,
    employees:    merged,
    quality:      docQuality(merged),
    warnings,
    sheetsProcessed,
    parseStats,
  };
}
