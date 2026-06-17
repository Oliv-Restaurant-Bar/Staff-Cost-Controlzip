/**
 * Gastronovi Personen/Umsatz-pro-Person CSV Parser
 *
 * Exportquelle: Gastronovi → Analyse → Verkäufe → Personen / Umsatz pro Person
 * Format: Semikolon-getrennt, Schweizer Zahlenformat.
 */

import { parseSwissNumber, simpleHash } from './gn-zbericht-parser';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnPersonRow {
  date: string | null;           // ISO yyyy-MM-dd (wenn parsebar)
  periodLabel: string | null;    // Originaltext (z.B. "KW 23", "Juni 2026")
  guestsCount: number;
  revPerPerson: number;
  revTotal: number | null;
  sourceRowJson: Record<string, string>;
}

export interface GnParsedPersonReport {
  fileName: string;
  checksum: string;
  warnings: string[];

  periodFrom: string;
  periodTo: string;
  periodRaw: string;

  totalGuests: number;
  avgRevPerPerson: number;
  totalRevenue: number | null;
  rowCount: number;

  rows: GnPersonRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deutsches Datum: 01.06.2026 → 2026-06-01 */
function parseGermanDate(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseCSVLine(line: string, delim: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function cleanCell(s: string): string {
  return (s || '').replace(/^["']+|["']+$/g, '').trim();
}

// Findet den Index einer Spalte (case-insensitive, partielle Übereinstimmung)
function findCol(headers: string[], ...patterns: string[]): number {
  for (const p of patterns) {
    const idx = headers.findIndex(h => h.toLowerCase().includes(p.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnPersonReport(csvText: string, fileName: string): GnParsedPersonReport {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);
  const delim = csvText.includes(';') ? ';' : ',';

  const allLines = csvText.split(/\r?\n/).map(l => parseCSVLine(l, delim));

  // ── Header-Metadaten ────────────────────────────────────────────────────────
  let periodRaw = '';
  let periodFrom = '';
  let periodTo = '';
  let headerRowIdx = -1;

  for (let i = 0; i < Math.min(allLines.length, 15); i++) {
    const first = cleanCell(allLines[i][0] ?? '').toLowerCase();
    if (first.includes('zeitraum') || first.includes('period')) {
      const val = cleanCell(allLines[i][1] ?? allLines[i][0] ?? '');
      if (val) {
        periodRaw = val;
        const parts = val.split(/\s*[-–]\s*/);
        periodFrom = parseGermanDate(parts[0] ?? '');
        periodTo   = parseGermanDate(parts[parts.length > 1 ? 1 : 0] ?? '');
      }
    }
    // Suche nach Spalten-Header-Zeile
    if (
      first.includes('datum') || first.includes('personen') ||
      first.includes('gäste') || first.includes('kw') || first.includes('woche') ||
      first.includes('monat') || first.includes('tag')
    ) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    warnings.push('Kopfzeile nicht gefunden — versuche erste Zeile als Header.');
    headerRowIdx = 0;
  }

  const rawHeaders = (allLines[headerRowIdx] ?? []).map(cleanCell);

  // Spalten-Indizes
  const colDate    = findCol(rawHeaders, 'datum', 'date', 'tag', 'kw', 'woche', 'monat', 'periode');
  const colGuests  = findCol(rawHeaders, 'personen', 'gäste', 'guests', 'anzahl personen', 'anz.');
  const colRevPP   = findCol(rawHeaders, 'umsatz pro person', 'umsatz/person', 'rev/person', 'durchschnitt', 'avg', 'ø');
  const colRevTot  = findCol(rawHeaders, 'umsatz total', 'total umsatz', 'gesamtumsatz', 'revenue total', 'umsatz gesamt');

  if (colGuests === -1) {
    warnings.push('Spalte "Personen/Gäste" nicht gefunden — Gästezahl kann nicht ermittelt werden.');
  }

  // ── Datenzeilen parsen ───────────────────────────────────────────────────────
  const rows: GnPersonRow[] = [];
  let totalGuestsFromData = 0;
  let totalRevFromData = 0;
  let totalRevPPSum = 0;
  let totalRowFromCsv: GnPersonRow | null = null;

  for (let i = headerRowIdx + 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.some(c => c.trim())) continue;

    const firstCell = cleanCell(line[0] ?? '');
    const isTotal = /^total$/i.test(firstCell) || /^gesamt/i.test(firstCell) || /^summe/i.test(firstCell);

    const rawLabel = colDate >= 0 ? cleanCell(line[colDate] ?? '') : firstCell;
    const parsedDate = parseGermanDate(rawLabel);
    const guests = colGuests >= 0 ? Math.round(parseSwissNumber(cleanCell(line[colGuests] ?? ''))) : 0;
    const revPP  = colRevPP  >= 0 ? parseSwissNumber(cleanCell(line[colRevPP]  ?? '')) : 0;
    const revTot = colRevTot >= 0 ? parseSwissNumber(cleanCell(line[colRevTot] ?? '')) : null;

    const sourceRow: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => { if (h) sourceRow[h] = cleanCell(line[idx] ?? ''); });

    const row: GnPersonRow = {
      date:         parsedDate || null,
      periodLabel:  parsedDate ? null : (rawLabel || null),
      guestsCount:  guests,
      revPerPerson: revPP,
      revTotal:     revTot && revTot > 0 ? revTot : null,
      sourceRowJson: sourceRow,
    };

    if (isTotal) {
      totalRowFromCsv = row;
    } else if (guests > 0 || rawLabel) {
      rows.push(row);
      totalGuestsFromData += guests;
      if (revTot && revTot > 0) totalRevFromData += revTot;
      if (revPP > 0) totalRevPPSum += revPP;
    }
  }

  if (rows.length === 0) {
    warnings.push('Keine Datenzeilen erkannt. Bitte prüfe das CSV-Format.');
  }

  // ── Zusammenfassung ─────────────────────────────────────────────────────────
  const totalGuests   = totalRowFromCsv?.guestsCount ?? totalGuestsFromData;
  const totalRevenue  = totalRowFromCsv?.revTotal ?? (totalRevFromData > 0 ? totalRevFromData : null);
  const avgRevPP      = totalRowFromCsv?.revPerPerson
    ?? (totalGuests > 0 && totalRevenue ? totalRevenue / totalGuests : (rows.length > 0 ? totalRevPPSum / rows.length : 0));

  if (!periodFrom) warnings.push('Zeitraum konnte nicht erkannt werden.');

  return {
    fileName,
    checksum,
    warnings,
    periodRaw,
    periodFrom,
    periodTo,
    totalGuests,
    avgRevPerPerson: avgRevPP,
    totalRevenue,
    rowCount: rows.length,
    rows,
  };
}
