/**
 * Gastronovi Durchschnittsbon-Bericht CSV Parser
 *
 * Dedizierter dritter Importtyp ("Durchschnittsbon pro Tag").
 *
 * Wide-Format: Eine Kopfzeile mit Datums-Spalten (01.06, 02.06, …) und eine
 * "Durchschnitt"-Zeile (bzw. -Sektion), deren Tageswerte als
 * "CHF 54.07" / "CHF 54,07" / "54.07" vorliegen.  Jeder Tageswert wird zu
 * einem eigenen Datensatz (report_date + average_check_chf).
 *
 * Der Durchschnittsbon wird NICHT aus Umsatz/Bons berechnet, sondern als
 * offizielle Gastronovi-Kennzahl importiert.
 */

import { parseSwissNumber, simpleHash } from './gn-zbericht-parser';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnAverageCheckRow {
  /** ISO yyyy-MM-dd */
  date: string;
  averageCheck: number;
  currency: string;
  rawDateHeader: string;
  rawValue: string;
}

export interface GnParsedAverageCheck {
  fileName: string;
  checksum: string;
  warnings: string[];

  periodFrom: string;
  periodTo: string;
  periodRaw: string;

  currency: string;

  rows: GnAverageCheckRow[];
  rowCount: number;

  averageMean: number;
  averageMin: number;
  averageMax: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Vollständiges deutsches Datum: 01.06.2026 → 2026-06-01 */
function parseGermanDate(s: string): string {
  const m = s.trim().match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return '';
  const d = +m[1], mo = +m[2];
  let y = +m[3];
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return '';
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}

/**
 * Erkennt eine reine Datums-Spaltenüberschrift wie "01.06", "01.06.2026" oder
 * "Mo 01.06.".  Geldbeträge ("CHF 54.07") werden bewusst NICHT als Datum
 * akzeptiert (Currency-Token + Tag/Monat-Plausibilität).
 */
function parseHeaderDate(cell: string): { day: number; month: number; year: number | null } | null {
  const c = cleanCell(cell);
  if (!c) return null;
  if (/(chf|eur|usd|gbp|€|\$|£)/i.test(c)) return null;
  const m = c.match(/^(?:[A-Za-zÄÖÜäöü]{2,4}\.?\s*)?(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?\.?$/);
  if (!m) return null;
  const day = +m[1], month = +m[2];
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year: number | null = null;
  if (m[3]) { year = +m[3]; if (year < 100) year += 2000; }
  return { day, month, year };
}

function normalizeCurrency(token: string): string {
  const t = token.toUpperCase();
  if (t === '€') return 'EUR';
  if (t === '$') return 'USD';
  if (t === '£') return 'GBP';
  return t;
}

/** "CHF 54.07" / "CHF 54,07" / "1'234.50" → { value, currency } */
function parseMoney(s: string): { value: number; currency: string | null } {
  const c = cleanCell(s);
  if (!c) return { value: 0, currency: null };
  const cur = c.match(/(CHF|EUR|USD|GBP|€|\$|£)/i);
  const currency = cur ? normalizeCurrency(cur[1]) : null;
  // Buchstaben und Währungssymbole entfernen, Rest über parseSwissNumber.
  const numPart = c.replace(/[A-Za-zÄÖÜäöü€$£]/g, '').trim();
  if (!/\d/.test(numPart)) return { value: 0, currency };
  return { value: parseSwissNumber(numPart), currency };
}

function extractYear(...sources: string[]): number | null {
  for (const s of sources) {
    const m = (s || '').match(/(20\d{2})/);
    if (m) return +m[1];
  }
  return null;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnAverageCheck(
  csvText: string,
  fileName: string,
): GnParsedAverageCheck {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);
  const delim = csvText.includes(';') ? ';' : ',';

  const allLines = csvText.split(/\r?\n/).map(l => parseCSVLine(l, delim));

  // ── Metadaten (Zeitraum) ─────────────────────────────────────────────────────
  let periodRaw = '';
  let metaFrom = '';
  let metaTo = '';
  for (let i = 0; i < Math.min(allLines.length, 25); i++) {
    const joined = allLines[i].map(cleanCell).join(' ').trim();
    if (/zeitraum|periode|datum von|von .* bis/i.test(joined)) {
      const dates = joined.match(/\d{1,2}\.\d{1,2}\.\d{2,4}/g);
      if (dates && dates.length >= 1) {
        periodRaw = joined;
        metaFrom = parseGermanDate(dates[0]);
        metaTo = parseGermanDate(dates[dates.length - 1]);
        break;
      }
    }
  }

  // ── Kopfzeile mit Datums-Spalten finden ──────────────────────────────────────
  let headerRowIdx = -1;
  let bestCount = 0;
  for (let i = 0; i < allLines.length; i++) {
    const count = allLines[i].reduce((acc, cell) => acc + (parseHeaderDate(cell) ? 1 : 0), 0);
    if (count > bestCount) { bestCount = count; headerRowIdx = i; }
  }

  if (headerRowIdx === -1 || bestCount < 2) {
    warnings.push('Keine Datums-Spalten gefunden. Bitte prüfe das CSV-Format (Tageswerte als Spalten 01.06, 02.06 …).');
    return emptyResult(fileName, checksum, warnings, periodRaw, metaFrom, metaTo);
  }

  const headerCells = allLines[headerRowIdx];

  // Basis-Jahr bestimmen: eigenes Jahr in Headern > Metadaten > Dateiname > aktuell.
  const headerYear = headerCells
    .map(parseHeaderDate)
    .find(d => d && d.year)?.year ?? null;
  const fallbackYear =
    headerYear ??
    extractYear(periodRaw, fileName) ??
    new Date().getFullYear();
  if (!headerYear && !extractYear(periodRaw, fileName)) {
    warnings.push(`Kein Jahr im Bericht erkannt — verwende ${fallbackYear}.`);
  }

  // Spalten-Index → ISO-Datum (mit Jahres-Rollover für Mehrmonats-Berichte).
  const colDates = new Map<number, { iso: string; raw: string }>();
  let prevMonth = -1;
  let yearOffset = 0;
  for (let c = 0; c < headerCells.length; c++) {
    const d = parseHeaderDate(headerCells[c]);
    if (!d) continue;
    if (prevMonth !== -1 && d.month < prevMonth && !d.year) yearOffset++;
    prevMonth = d.month;
    const y = d.year ?? (fallbackYear + yearOffset);
    colDates.set(c, { iso: `${y}-${pad2(d.month)}-${pad2(d.day)}`, raw: cleanCell(headerCells[c]) });
  }

  // ── "Durchschnitt"-Zeile (bzw. Zeile mit den meisten Tageswerten) finden ─────
  const dateCols = [...colDates.keys()];

  const labelOf = (line: string[]): string =>
    line.filter((_, idx) => !colDates.has(idx)).map(cleanCell).join(' ').trim();

  const valueCount = (line: string[]): number =>
    dateCols.reduce((acc, idx) => acc + (parseMoney(line[idx] ?? '').value > 0 ? 1 : 0), 0);

  let valueRowIdx = -1;
  // 1) Zeile, deren Label "Durchschnitt" enthält und Tageswerte hat.
  for (let i = 0; i < allLines.length; i++) {
    if (i === headerRowIdx) continue;
    if (/durchschnitt/i.test(labelOf(allLines[i])) && valueCount(allLines[i]) > 0) {
      valueRowIdx = i; break;
    }
  }
  // 2) Fallback: Zeile mit den meisten Tageswerten.
  if (valueRowIdx === -1) {
    let best = 0;
    for (let i = 0; i < allLines.length; i++) {
      if (i === headerRowIdx) continue;
      const cnt = valueCount(allLines[i]);
      if (cnt > best) { best = cnt; valueRowIdx = i; }
    }
    if (valueRowIdx !== -1) {
      warnings.push('"Durchschnitt"-Zeile nicht eindeutig erkannt — verwende Zeile mit den meisten Tageswerten.');
    }
  }

  if (valueRowIdx === -1) {
    warnings.push('Keine Durchschnittsbon-Tageswerte gefunden.');
    return emptyResult(fileName, checksum, warnings, periodRaw, metaFrom, metaTo);
  }

  // ── Tageswerte einlesen ──────────────────────────────────────────────────────
  const valueRow = allLines[valueRowIdx];
  const currencyTally = new Map<string, number>();
  const rows: GnAverageCheckRow[] = [];
  let skippedEmpty = 0;

  for (const c of dateCols) {
    const col = colDates.get(c)!;
    const raw = cleanCell(valueRow[c] ?? '');
    const { value, currency } = parseMoney(raw);
    if (value <= 0) { if (!raw) skippedEmpty++; continue; }
    const cur = currency ?? 'CHF';
    currencyTally.set(cur, (currencyTally.get(cur) ?? 0) + 1);
    rows.push({ date: col.iso, averageCheck: value, currency: cur, rawDateHeader: col.raw, rawValue: raw });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length === 0) {
    warnings.push('Keine gültigen Durchschnittsbon-Werte (> 0) gefunden.');
  }
  if (skippedEmpty > 0) {
    warnings.push(`${skippedEmpty} leere Tag(e) ohne Wert übersprungen (z. B. Ruhetage).`);
  }

  // Dominante Währung.
  let currency = 'CHF';
  let maxCur = 0;
  for (const [cur, n] of currencyTally) if (n > maxCur) { maxCur = n; currency = cur; }

  // Zeitraum: die tatsächlich importierten Tage (sortierte Rows) sind massgeblich
  // und konsistent mit der Verlaufs-Aggregation in gn-average-check-db.ts.
  // Metadaten dienen nur als Fallback, wenn keine Rows vorhanden sind — sie
  // werden NICHT vorgezogen, da abgekürzte Zeitraum-Angaben ("01.06.-30.06.2026")
  // sonst falsche Grenzen liefern und die Überschneidungsprüfung verfälschen.
  const values = rows.map(r => r.averageCheck);
  const periodFrom = rows.length > 0 ? rows[0].date : metaFrom;
  const periodTo = rows.length > 0 ? rows[rows.length - 1].date : metaTo;

  const averageMean = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const averageMin = values.length > 0 ? Math.min(...values) : 0;
  const averageMax = values.length > 0 ? Math.max(...values) : 0;

  return {
    fileName,
    checksum,
    warnings,
    periodFrom,
    periodTo,
    periodRaw,
    currency,
    rows,
    rowCount: rows.length,
    averageMean,
    averageMin,
    averageMax,
  };
}

function emptyResult(
  fileName: string,
  checksum: string,
  warnings: string[],
  periodRaw: string,
  periodFrom: string,
  periodTo: string,
): GnParsedAverageCheck {
  return {
    fileName, checksum, warnings,
    periodFrom, periodTo, periodRaw,
    currency: 'CHF',
    rows: [], rowCount: 0,
    averageMean: 0, averageMin: 0, averageMax: 0,
  };
}
