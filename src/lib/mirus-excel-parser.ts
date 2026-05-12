/**
 * Mirus Excel Parser — Koordinatenbasiert
 * ========================================
 * Position-basierter Parser für Mirus-Monatsblätter (Excel-Drucklayout).
 *
 * Strategie:
 *   - Mitarbeiterblock = Zeile mit "Name / Vorname" in Spalte C
 *   - Name kommt aus Zelle M(blockStart)
 *   - Wochenstunden aus BO(blockStart)
 *   - Tageszeilen ab blockStart+6, per Datumszellen-Suche
 *   - Spalten-Map wird per Header-Zeilen-Scan automatisch ermittelt
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
 * Standard-Layout für Mirus-Monatsblatt (Drucklayout).
 * Spalten werden per Header-Zeilen-Scan automatisch überschrieben,
 * wenn Schlüsselwörter ("Datum", "Arbeitszeit", "Pause", "Total") gefunden werden.
 */
const LAYOUT = {
  markerCol:       C('C'),   // "Name / Vorname" steht hier
  nameCol:         C('M'),   // Employee-Name
  weeklyHoursCol:  C('BO'),  // Wochenstunden
  metaRowOffset:   1,        // Kostenstelle etc. in der Zeile nach dem Block-Start
  daySearchOffset: 5,        // Tageszeilen-Suche startet ab blockStart + diesen Offset

  // Tagesspalten — Standard, wird per Header überschrieben
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

const ABSENCE_CODES = ['FR', 'FE', 'KR', 'Frei', 'Ferien', 'Krank', 'Unfall', 'Kompensation', 'KO'];

const TOTAL_LABELS: { key: keyof EmployeeTotals; patterns: string[] }[] = [
  { key: 'totalHours',   patterns: ['total stunden', 'total h', 'gesamtarbeitszeit', 'bruttoarbeitszeit', 'brutto'] },
  { key: 'pauseTotal',   patterns: ['pausen total', 'pause total', 'pause'] },
  { key: 'nettoTotal',   patterns: ['nettoarbeitszeit', 'netto'] },
  { key: 'sollStunden',  patterns: ['sollstunden', 'soll'] },
  { key: 'zeitzuschlag', patterns: ['zeitzuschlag', 'zuschlag'] },
  { key: 'ueberzeit',    patterns: ['überzeit', 'ueberzeit', 'überstunden'] },
  { key: 'saldo',        patterns: ['saldo'] },
  { key: 'ferien',       patterns: ['feriensaldo', 'ferien'] },
  { key: 'feiertag',     patterns: ['feiertag'] },
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
  rawBlock: RawBlock;
  mergedFromCount: number;           // 1 = einzelner Block, ≥2 = zusammengeführt
  mergedBlockRows: [number, number][]; // [startRow, endRow] jedes Teil-Blocks
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

function detectAbsence(text: string): string | null {
  for (const code of ABSENCE_CODES) {
    if (text.toLowerCase().includes(code.toLowerCase())) return code;
  }
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
  if (!s || s === '0' || s === '-') return null;

  // HH:MM im Rohwert
  const hhmmS = s.match(/^(\d{1,3}):(\d{2})$/);
  if (hhmmS) {
    const decimal = parseInt(hhmmS[1]) + parseInt(hhmmS[2]) / 60;
    return { display: s, decimal: Math.round(decimal * 100) / 100 };
  }

  const d = parseFloat(s.replace(',', '.'));
  if (!isNaN(d) && d > 0 && d < 500) return { display: s, decimal: d };
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
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell = getCell(ws, LAYOUT.markerCol, r);
    if (!cell) continue;
    const text = String(cell.v ?? cell.w ?? '').trim();
    if (/Name\s*\/\s*Vorname/i.test(text)) starts.push(r);
  }
  return starts;
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

  for (let r = startRow; r <= endRow; r++) {
    const dateCell = getCell(ws, map.dateCol, r);
    const date     = parseDateCell(dateCell);

    // Absenzen: erste 25 Spalten scannen
    let absenceCode: string | null = null;
    for (let c = range.s.c; c <= Math.min(range.e.c, 25); c++) {
      const cell = getCell(ws, c, r);
      if (!cell) continue;
      const code = detectAbsence(String(cell.v ?? ''));
      if (code) { absenceCode = code; break; }
    }

    if (!date && !absenceCode) continue;

    // Schichten
    const shifts: TimeBlock[] = [];
    const fromCell = getCell(ws, map.fromCol, r);
    const fromTime = parseTimeCell(fromCell);

    if (fromTime) {
      const toTime = map.toCol !== null ? parseTimeCell(getCell(ws, map.toCol, r)) : null;

      // Sometimes from/to are encoded "HH:MM–HH:MM" in one cell
      const rawW = (fromCell?.w ?? String(fromCell?.v ?? '')).trim();
      const rangeMatch = rawW.match(/(\d{1,2}[:\. ]\d{2})\s*[-–]\s*(\d{1,2}[:\. ]\d{2})/);
      if (rangeMatch) {
        shifts.push({
          from: rangeMatch[1].replace(/[. ]/, ':'),
          to:   rangeMatch[2].replace(/[. ]/, ':'),
        });
      } else if (toTime) {
        shifts.push({ from: fromTime, to: toTime });
      } else {
        shifts.push({ from: fromTime, to: '?' });
      }

      // Check for a second shift further right in the same row
      if (map.toCol !== null) {
        const nextFromCol = map.toCol + 1;
        const nextToCol   = map.toCol + 2;
        const from2 = parseTimeCell(getCell(ws, nextFromCol, r));
        const to2   = parseTimeCell(getCell(ws, nextToCol, r));
        if (from2 && to2) shifts.push({ from: from2, to: to2 });
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
            // Zuerst als Stundenwert interpretieren (HH:MM oder Dezimal)
            const parsed = parseHoursValue(valCell);
            if (parsed) {
              totals[key] = parsed.display || String(parsed.decimal);
              break;
            }
            // Fallback: beliebiger nicht-leerer String
            const s = (valCell.w ?? String(valCell.v ?? '')).trim();
            if (s && s !== '0' && s !== '-') {
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
// ─── MITARBEITER-META ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

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

    if (!costCenter && /Küche|Service|Housekeeping|Büro|Kitchen|Bar|Restaurant/i.test(text))
      costCenter = text;
    if (!employmentPeriod && /\d{2}\.\d{2}\.\d{4}/.test(text))
      employmentPeriod = text;
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
  // Name aus M(blockStart)
  const nameCell = getCell(ws, LAYOUT.nameCol, blockStart);
  const name = nameCell ? (nameCell.w ?? String(nameCell.v ?? '')).trim() || null : null;

  // Wochenstunden aus BO(blockStart)
  const whCell = getCell(ws, LAYOUT.weeklyHoursCol, blockStart);
  let weeklyHours: number | null = null;
  if (whCell?.t === 'n' && typeof whCell.v === 'number') {
    weeklyHours = whCell.v;
  } else if (whCell) {
    const n = parseFloat(String(whCell.v ?? '').replace(',', '.'));
    if (!isNaN(n)) weeklyHours = n;
  }

  // Meta-Zeile (Kostenstelle, Arbeitsverhältnis)
  const metaRow  = blockStart + LAYOUT.metaRowOffset;
  const meta     = readMetaRow(ws, metaRow);
  const { costCenter, employmentPeriod } = meta;

  // Abteilung ableiten
  let department: string | null = null;
  if (costCenter) {
    if (/küche|kitchen|koch/i.test(costCenter))   department = 'küche';
    else if (/service|sala|saal/i.test(costCenter)) department = 'service';
    else department = costCenter;
  }

  // Spalten-Map erkennen
  const { map: colMap, detected } = detectColMap(ws, blockStart, blockEnd);

  // Tageszeilen ab blockStart + daySearchOffset
  const dayStart = blockStart + LAYOUT.daySearchOffset;
  const days     = readDayRows(ws, dayStart, blockEnd, colMap);

  // Totale
  const totals = readTotals(ws, blockStart, blockEnd);
  computeTotalsCheck(totals, days);

  // Detected-ColMap als lesbare Strings
  const detectedForDisplay: Record<string, string> = {
    date:    `${XLSX.utils.encode_col(colMap.dateCol)}`,
    weekday: `${XLSX.utils.encode_col(colMap.weekdayCol)}`,
    from:    `${XLSX.utils.encode_col(colMap.fromCol)}`,
    to:      colMap.toCol    !== null ? XLSX.utils.encode_col(colMap.toCol)    : '—',
    pause:   colMap.pauseCol !== null ? XLSX.utils.encode_col(colMap.pauseCol) : '—',
    total:   colMap.totalCol !== null ? XLSX.utils.encode_col(colMap.totalCol) : '—',
    remark:  colMap.remarkCol !== null ? XLSX.utils.encode_col(colMap.remarkCol) : '—',
    ...detected,
  };

  const startRow1 = blockStart + 1;
  const endRow1   = blockEnd + 1;
  return {
    name, department, costCenter, weeklyHours, employmentPeriod,
    sheetName,
    blockStartRow: startRow1,
    blockEndRow:   endRow1,
    days, totals,
    rawBlock: {
      markerCell:       XLSX.utils.encode_cell({ r: blockStart, c: LAYOUT.markerCol }),
      nameCell:         XLSX.utils.encode_cell({ r: blockStart, c: LAYOUT.nameCol }),
      weeklyHoursCell:  XLSX.utils.encode_cell({ r: blockStart, c: LAYOUT.weeklyHoursCol }),
      metaRowText:      meta.text,
      detectedColMap:   detectedForDisplay,
    },
    mergedFromCount: 1,
    mergedBlockRows: [[startRow1, endRow1]],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── QUALITÄT ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function employeeQuality(emp: ExcelEmployee): number {
  let s = 0;
  if (emp.name)        s += 25;  // Name erkannt
  if (emp.weeklyHours) s += 8;   // Wochenstunden erkannt
  if (emp.costCenter)  s += 8;   // Kostenstelle / Abteilung erkannt
  // Tagesdaten
  if      (emp.days.length >= 20) s += 27;
  else if (emp.days.length >= 10) s += 20;
  else if (emp.days.length >= 5)  s += 13;
  else if (emp.days.length >= 1)  s += 6;
  // Zeitblöcke oder Absenzen
  const active = emp.days.filter(d => d.shifts.length > 0 || !!d.absenceCode).length;
  if      (active >= 15) s += 14;
  else if (active >= 5)  s += 9;
  else if (active >= 1)  s += 4;
  // Totale erkannt (+8) + validiert (+10)
  if (emp.totals.totalHours)      s += 8;
  if (emp.totals.totalsValidated) s += 10;
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
 * Restblock-Erkennung:
 * Ein Block gilt als Restblock wenn Tagesdaten oder Qualität sehr gering sind.
 * Restblöcke sollen mit dem vorangegangenen Block zusammengeführt werden.
 */
function isRestBlock(emp: ExcelEmployee): boolean {
  const shifts   = emp.days.reduce((s, d) => s + d.shifts.length, 0);
  const absences = emp.days.filter(d => !!d.absenceCode).length;
  const hasTotals = Object.values(emp.totals).some(Boolean);
  const q = employeeQuality(emp);
  return (
    emp.days.length < 8 ||
    (shifts === 0 && absences === 0) ||
    (!hasTotals && emp.days.length < 5) ||
    q < 45
  );
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
    rawBlock:         main.rawBlock,
    mergedFromCount:  main.mergedFromCount + 1,
    mergedBlockRows:  [...existingRows, extraRow],
  };
  // Totales-Cross-Check nach Merge neu berechnen (mehr Tage verfügbar)
  computeTotalsCheck(merged.totals, merged.days);
  return merged;
}

/**
 * Hauptfunktion: fügt Blöcke mit gleichem Namen oder Restblöcke zusammen.
 *
 * Merge-Bedingungen (eine genügt):
 *   A) Gleicher normalisierter Name, Abstand ≤ 30 Zeilen
 *   B) Block ist ein Restblock (< 8 Tage / Qualität < 45 %), Abstand ≤ 8 Zeilen
 */
function mergeBlocks(raw: ExcelEmployee[]): ExcelEmployee[] {
  const tagged: ExcelEmployee[] = raw.map(e => ({
    ...e,
    mergedFromCount: 1,
    mergedBlockRows: [[e.blockStartRow, e.blockEndRow ?? e.blockStartRow]] as [number, number][],
  }));

  const result: ExcelEmployee[] = [];
  for (const emp of tagged) {
    const last = result[result.length - 1];
    if (!last) { result.push(emp); continue; }

    const gap = emp.blockStartRow - (last.blockEndRow ?? last.blockStartRow);

    // Condition A: same name, close gap
    const sameNorm = normName(emp.name) === normName(last.name) && normName(emp.name) !== '';
    if (sameNorm && gap <= 30) {
      result[result.length - 1] = mergeTwoBlocks(last, emp);
      continue;
    }

    // Condition B: rest block very close (continuation page, different marker)
    if (isRestBlock(emp) && gap <= 8) {
      result[result.length - 1] = mergeTwoBlocks(last, emp);
      continue;
    }

    result.push(emp);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── DATEINAME / META ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const MONTH_MAP: Record<string, [number, string]> = {
  januar: [1, 'Januar'], february: [2, 'Februar'], februar: [2, 'Februar'],
  märz: [3, 'März'], april: [4, 'April'], mai: [5, 'Mai'],
  juni: [6, 'Juni'], juli: [7, 'Juli'], august: [8, 'August'],
  september: [9, 'September'], oktober: [10, 'Oktober'], november: [11, 'November'],
  dezember: [12, 'Dezember'],
};

function metaFromFileName(fileName: string): { month: number | null; monthName: string | null; year: number | null } {
  const lower = fileName.toLowerCase();
  let month: number | null = null;
  let monthName: string | null = null;
  for (const [token, [m, n]] of Object.entries(MONTH_MAP)) {
    if (lower.includes(token)) { month = m; monthName = n; break; }
  }
  const ym = fileName.match(/20\d{2}/);
  return { month, monthName, year: ym ? parseInt(ym[0]) : null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── HAUPT-EXPORT ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export async function parseMirusExcel(file: File): Promise<ExcelParsedDocument> {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array', cellDates: true, cellNF: true, cellText: true });

  const meta      = metaFromFileName(file.name);
  const employees: ExcelEmployee[] = [];
  const warnings:  string[]        = [];
  const sheetsProcessed: string[]  = [];

  for (const sheetName of wb.SheetNames) {
    const ws     = wb.Sheets[sheetName];
    const starts = findBlockStarts(ws);

    if (starts.length === 0) {
      warnings.push(`Sheet „${sheetName}": kein „Name / Vorname" in Spalte C gefunden`);
      continue;
    }

    sheetsProcessed.push(sheetName);
    const ref   = ws['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);

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

  // Blöcke mit gleichem Namen oder Restblöcke zusammenführen
  const rawCount   = employees.length;
  const merged     = mergeBlocks(employees);
  const mergedCount = rawCount - merged.length;
  if (mergedCount > 0) {
    warnings.push(`${mergedCount} Restblock${mergedCount !== 1 ? 'e' : ''} zusammengeführt (${rawCount} Roh-Blöcke → ${merged.length} Mitarbeiter)`);
  }

  return {
    fileName: file.name,
    ...meta,
    restaurant:   null,
    creationDate: null,
    employees:    merged,
    quality:      docQuality(merged),
    warnings,
    sheetsProcessed,
  };
}
