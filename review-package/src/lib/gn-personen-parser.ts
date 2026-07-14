/**
 * Gastronovi Personen/Analyse CSV Parser
 *
 * Unterstützte Exporttypen:
 *   'anzahl_personen'   — Analyse → Verkäufe → Anzahl Personen
 *   'umsatz_pro_person' — Analyse → Verkäufe → Umsatz pro Person
 *   'durchschnittsbon'  — Analyse → Verkäufe → Durchschnittsbon
 *   'personen'          — Kombinierter Export (Personen + Umsatz)
 */

import { parseSwissNumber, simpleHash } from './gn-zbericht-parser';

// ── Typen ─────────────────────────────────────────────────────────────────────

export type PersonCsvType =
  | 'anzahl_personen'
  | 'umsatz_pro_person'
  | 'durchschnittsbon'
  | 'personen';

export interface GnPersonRow {
  date: string | null;
  periodLabel: string | null;
  guestsCount: number;
  revPerPerson: number;
  revTotal: number | null;
  averageReceipt: number | null;
  sourceRowJson: Record<string, string>;
}

export interface GnParsedPersonReport {
  fileName: string;
  checksum: string;
  warnings: string[];

  periodFrom: string;
  periodTo: string;
  periodRaw: string;

  /** Automatisch erkannter Typ, kann vom Benutzer überschrieben werden */
  detectedCsvType: PersonCsvType;

  // Gäste (anzahl_personen / personen)
  totalGuests: number;

  // Umsatz pro Person (umsatz_pro_person / personen)
  avgRevPerPerson: number;
  totalRevenue: number | null;

  // Durchschnittsbon
  avgReceiptMonthly: number;

  rowCount: number;
  rows: GnPersonRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      result.push(cur.trim()); cur = '';
    } else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function cleanCell(s: string): string {
  return (s || '').replace(/^["']+|["']+$/g, '').trim();
}

function findCol(headers: string[], ...patterns: string[]): number {
  for (const p of patterns) {
    const idx = headers.findIndex(h => h.toLowerCase().includes(p.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Auto-Erkennung des CSV-Typs anhand der Spaltenköpfe */
function detectCsvType(headers: string[]): PersonCsvType {
  const h = headers.map(x => x.toLowerCase().replace(/\s+/g, ' ').trim());

  const hasBon      = h.some(x => x.includes('durchschnitt') && x.includes('bon')
                                || x === 'durchschnittsbon'
                                || x.includes('bon-durchschnitt')
                                || x.includes('avg receipt')
                                || x.includes('avg. bon'));
  const hasRevPP    = h.some(x => (x.includes('umsatz') && x.includes('person'))
                                || x.includes('rev/person') || x.includes('umsatz/person'));
  const hasGuests   = h.some(x => x === 'personen' || x === 'gäste'
                                || x.includes('anzahl personen') || x.includes('gästezahl'));

  if (hasBon && !hasGuests && !hasRevPP) return 'durchschnittsbon';
  if (hasRevPP && !hasGuests)            return 'umsatz_pro_person';
  if (hasGuests && !hasRevPP && !hasBon) return 'anzahl_personen';
  return 'personen';
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnPersonReport(
  csvText: string,
  fileName: string,
): GnParsedPersonReport {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);
  const delim = csvText.includes(';') ? ';' : ',';

  const allLines = csvText.split(/\r?\n/).map(l => parseCSVLine(l, delim));

  // ── Metadaten (Zeitraum) ─────────────────────────────────────────────────────
  let periodRaw = '';
  let periodFrom = '';
  let periodTo = '';
  let headerRowIdx = -1;

  for (let i = 0; i < Math.min(allLines.length, 20); i++) {
    const first = cleanCell(allLines[i][0] ?? '').toLowerCase();
    if (first.includes('zeitraum') || first.includes('period')) {
      const val = cleanCell(allLines[i][1] ?? allLines[i][0] ?? '');
      if (val && val.toLowerCase() !== 'zeitraum') {
        periodRaw = val;
        const stripped = val.replace(/zeitraum[:\s]*/i, '').trim();
        const parts = stripped.split(/\s*[-–]\s*/);
        periodFrom = parseGermanDate(parts[0] ?? '');
        periodTo   = parseGermanDate(parts[parts.length > 1 ? 1 : 0] ?? '');
      }
    }
    const isHeaderCandidate =
      first.includes('datum')  || first.includes('tag')   ||
      first.includes('personen') || first.includes('gäste') ||
      first.includes('kw')    || first.includes('woche')  ||
      first.includes('monat') || first.includes('umsatz') ||
      first.includes('durchschnitt');
    if (isHeaderCandidate) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) {
    warnings.push('Kopfzeile nicht gefunden — versuche erste nicht-leere Zeile.');
    headerRowIdx = allLines.findIndex(l => l.some(c => c.trim())) ?? 0;
  }

  const rawHeaders = (allLines[headerRowIdx] ?? []).map(cleanCell);
  const detectedCsvType = detectCsvType(rawHeaders);

  // ── Spalten-Indizes ────────────────────────────────────────────────────────
  const colDate    = findCol(rawHeaders, 'datum', 'date', 'tag', 'kw', 'woche', 'monat', 'periode');
  const colGuests  = findCol(rawHeaders, 'anzahl personen', 'personen', 'gäste', 'guests', 'anz.');
  const colRevPP   = findCol(rawHeaders, 'umsatz pro person', 'umsatz/person', 'rev/person', 'ø umsatz');
  const colRevTot  = findCol(rawHeaders, 'umsatz total', 'total umsatz', 'gesamtumsatz', 'umsatz gesamt');
  const colBon     = findCol(rawHeaders, 'durchschnittsbon', 'bon-durchschnitt', 'avg receipt', 'avg. bon', 'durchschnitt bon');

  if (detectedCsvType === 'durchschnittsbon' && colBon === -1) {
    warnings.push('Spalte "Durchschnittsbon" nicht gefunden — prüfe das CSV-Format.');
  }
  if (detectedCsvType === 'anzahl_personen' && colGuests === -1) {
    warnings.push('Spalte "Personen/Gäste" nicht gefunden.');
  }
  if (detectedCsvType === 'umsatz_pro_person' && colRevPP === -1) {
    warnings.push('Spalte "Umsatz pro Person" nicht gefunden.');
  }

  // ── Datenzeilen parsen ───────────────────────────────────────────────────────
  const rows: GnPersonRow[] = [];
  let totalGuestsFromData  = 0;
  let totalRevFromData     = 0;
  let totalRevPPSum        = 0;
  let totalBonSum          = 0;
  let totalBonCount        = 0;
  let totalRowFromCsv: GnPersonRow | null = null;

  for (let i = headerRowIdx + 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.some(c => c.trim())) continue;

    const firstCell = cleanCell(line[0] ?? '');
    const isTotal = /^total$/i.test(firstCell) || /^gesamt/i.test(firstCell) || /^summe/i.test(firstCell);

    const rawLabel   = colDate >= 0 ? cleanCell(line[colDate] ?? '') : firstCell;
    const parsedDate = parseGermanDate(rawLabel);

    const guests  = colGuests >= 0 ? Math.round(parseSwissNumber(cleanCell(line[colGuests] ?? ''))) : 0;
    const revPP   = colRevPP  >= 0 ? parseSwissNumber(cleanCell(line[colRevPP]  ?? '')) : 0;
    const revTot  = colRevTot >= 0 ? parseSwissNumber(cleanCell(line[colRevTot] ?? '')) : null;
    const bon     = colBon    >= 0 ? parseSwissNumber(cleanCell(line[colBon]    ?? '')) : 0;

    const sourceRow: Record<string, string> = {};
    rawHeaders.forEach((h, idx) => { if (h) sourceRow[h] = cleanCell(line[idx] ?? ''); });

    const row: GnPersonRow = {
      date:           parsedDate || null,
      periodLabel:    parsedDate ? null : (rawLabel || null),
      guestsCount:    guests,
      revPerPerson:   revPP,
      revTotal:       revTot && revTot > 0 ? revTot : null,
      averageReceipt: bon > 0 ? bon : null,
      sourceRowJson:  sourceRow,
    };

    if (isTotal) {
      totalRowFromCsv = row;
    } else if (guests > 0 || revPP > 0 || bon > 0 || rawLabel) {
      rows.push(row);
      totalGuestsFromData += guests;
      if (revTot && revTot > 0) totalRevFromData += revTot;
      if (revPP > 0) totalRevPPSum += revPP;
      if (bon > 0)  { totalBonSum += bon; totalBonCount++; }
    }
  }

  if (rows.length === 0) {
    warnings.push('Keine Datenzeilen erkannt. Bitte prüfe das CSV-Format.');
  }

  // ── Zusammenfassung ──────────────────────────────────────────────────────────
  const totalGuests  = totalRowFromCsv?.guestsCount ?? totalGuestsFromData;
  const totalRevenue = totalRowFromCsv?.revTotal ?? (totalRevFromData > 0 ? totalRevFromData : null);
  const avgRevPP     = totalRowFromCsv?.revPerPerson
    ?? (totalGuests > 0 && totalRevenue
        ? totalRevenue / totalGuests
        : (rows.length > 0 && totalRevPPSum > 0 ? totalRevPPSum / rows.length : 0));

  const avgReceiptMonthly =
    (totalRowFromCsv?.averageReceipt) ??
    (totalBonCount > 0 ? totalBonSum / totalBonCount : 0);

  if (!periodFrom) warnings.push('Zeitraum konnte nicht erkannt werden.');

  return {
    fileName,
    checksum,
    warnings,
    periodRaw,
    periodFrom,
    periodTo,
    detectedCsvType,
    totalGuests,
    avgRevPerPerson: avgRevPP,
    totalRevenue,
    avgReceiptMonthly,
    rowCount: rows.length,
    rows,
  };
}
