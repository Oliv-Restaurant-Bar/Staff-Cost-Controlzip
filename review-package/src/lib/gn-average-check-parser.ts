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
 *
 * Diagnose: Jeder Parse liefert ein `debug`-Objekt (analog zum Z-Bericht), das
 * die reale CSV-Struktur ausgibt — erkanntes Trennzeichen, Zeilen, Datums-
 * Spalten, Durchschnitt-Zeile, erste Rohzeilen und den Grund, falls keine
 * Tageswerte extrahiert wurden.  So lässt sich ein Erkennungsfehler an der
 * tatsächlichen Datei diagnostizieren statt am erwarteten Format.
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

export interface GnAverageCheckDebug {
  /** Dateiname der analysierten CSV */
  fileName: string;
  /** Erkanntes Trennzeichen, menschenlesbar ("Semikolon" | "Komma" | "Tab") */
  delimiter: string;
  /** Anzahl Trennzeichen im CSV */
  delimCounts: { semicolon: number; comma: number; tab: number };
  /** Anzahl aller Zeilen (inkl. leerer) */
  rawLineCount: number;
  /** Anzahl nicht-leerer Zeilen */
  nonEmptyLineCount: number;
  /** Erste 20 Rohzeilen (Originaltext) */
  firstRawLines: string[];
  /** Erste 20 geparste Zeilen (Zellen-Arrays) */
  firstParsedRows: string[][];
  /** Index der erkannten Datums-Kopfzeile (1-basiert) oder null */
  headerRowIdx: number | null;
  /** Erkannte Datums-Spalten: Spaltenindex, Rohtext, ISO-Datum */
  dateColumns: Array<{ col: number; raw: string; iso: string }>;
  /** Anzahl datumsartiger Zellen im GANZEN Dokument (Langformat-Hinweis) */
  dateCellCount: number;
  /** Index der erkannten "Durchschnitt"-/Wertezeile (1-basiert) oder null */
  averageRowIdx: number | null;
  /** Label (Nicht-Datums-Zellen) der Wertezeile */
  averageRowLabel: string;
  /** Zeilen, die das Wort "Durchschnitt" enthalten (1-basiert) */
  averageCandidates: Array<{ lineNumber: number; rawText: string }>;
  /** Anzahl Zellen mit Geldwert > 0 im GANZEN Dokument */
  moneyCellCount: number;
  /** Erkanntes Layout: "wide" (Datums-Spalten) | "vertical" (eine Zeile pro Tag) | null */
  detectedFormat: 'wide' | 'vertical' | null;
  /** Verwendetes Basis-Jahr (immer gesetzt, sobald ein Layout erkannt wurde) */
  usedYear: number | null;
  /** Quelle des Jahres: "Datumsspalten" | "Zeitraum" | "Dateiname" | "Benutzerwahl" | "—" */
  usedYearSource: string;
  /** Erkannter Zeitraum-Text (Roh), z. B. "Zeitraum 01.06.2025 - 30.06.2025" oder "—" */
  detectedPeriod: string;
  /** Anzahl übersprungener leerer Tageswert-Spalten/-Zeilen (z. B. Ruhetage) */
  skippedEmptyColumns: number;
  /** Grund, warum keine Tageswerte extrahiert wurden (null = erfolgreich) */
  failureReason: string | null;
}

export interface GnParsedAverageCheck {
  fileName: string;
  checksum: string;
  warnings: string[];
  debug: GnAverageCheckDebug;

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

/** Trennzeichen ermitteln: zählt ; , \t und wählt das häufigste. */
function detectDelimiter(text: string): { delim: string; counts: { semicolon: number; comma: number; tab: number } } {
  const sample = text.slice(0, 4000);
  const counts = {
    semicolon: (sample.match(/;/g) ?? []).length,
    comma:     (sample.match(/,/g) ?? []).length,
    tab:       (sample.match(/\t/g) ?? []).length,
  };
  let delim = ';';
  if (counts.tab > counts.semicolon && counts.tab > counts.comma) delim = '\t';
  else if (counts.comma > counts.semicolon) delim = ',';
  return { delim, counts };
}

function delimiterLabel(delim: string): string {
  return delim === '\t' ? 'Tab' : delim === ';' ? 'Semikolon' : 'Komma';
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
 * Exportiert für den KPI-PDF-Parser (gn-kpi-pdf-parser.ts) — EINE Erkennung.
 */
export function parseHeaderDate(cell: string): { day: number; month: number; year: number | null } | null {
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

/** "CHF 54.07" / "CHF 54,07" / "1'234.50" → { value, currency }
 *  Exportiert für den KPI-PDF-Parser (gn-kpi-pdf-parser.ts) — EINE Geld-Erkennung. */
export function parseMoney(s: string): { value: number; currency: string | null } {
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
  /** Vom Aufrufer (UI) gewähltes Importjahr — nur Fallback, wenn im Bericht/Dateinamen kein Jahr steht. */
  userYear?: number,
): GnParsedAverageCheck {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);

  const { delim, counts: delimCounts } = detectDelimiter(csvText);

  const rawLines = csvText.split(/\r?\n/);
  const allLines = rawLines.map(l => parseCSVLine(l, delim));
  const nonEmptyLineCount = rawLines.filter(l => l.trim() !== '').length;

  // Mehrdeutiges Komma-Format: Komma gleichzeitig als Trennzeichen UND als
  // Dezimaltrenner (unquoted, z. B. "54,07") lässt sich nicht zuverlässig
  // auseinanderhalten — sichtbarer Hinweis statt falscher Zuordnung.
  if (delim === ',' && /\d,\d{2}(?:[,;]|\s|$)/m.test(csvText)) {
    warnings.push(
      'Trennzeichen als Komma erkannt, aber Geldwerte scheinen Komma-Dezimaltrennung zu nutzen ' +
      '(z. B. "54,07"). Werte können dadurch falsch zugeordnet werden — bitte die Datei mit ' +
      'Semikolon-Trennung exportieren.',
    );
  }

  // Datumsartige Zellen + Geldwert-Zellen im GANZEN Dokument zählen
  // (für die Diagnose / Langformat-Erkennung).
  let dateCellCount = 0;
  let moneyCellCount = 0;
  for (const line of allLines) {
    for (const cell of line) {
      const isDate = !!parseHeaderDate(cell);
      if (isDate) dateCellCount++;
      // Datums-Zellen (z. B. "01.06.2026") nicht als Geldwert mitzählen.
      if (!isDate && parseMoney(cell).value > 0) moneyCellCount++;
    }
  }

  // Zeilen, die "Durchschnitt" enthalten (Kandidaten für die Wertezeile).
  const averageCandidates: Array<{ lineNumber: number; rawText: string }> = [];
  rawLines.forEach((line, idx) => {
    if (line.trim() && /durchschnitt/i.test(line)) {
      averageCandidates.push({ lineNumber: idx + 1, rawText: line });
    }
  });

  const debug: GnAverageCheckDebug = {
    fileName,
    delimiter:        delimiterLabel(delim),
    delimCounts,
    rawLineCount:     rawLines.length,
    nonEmptyLineCount,
    firstRawLines:    rawLines.slice(0, 20),
    firstParsedRows:  allLines.slice(0, 20),
    headerRowIdx:     null,
    dateColumns:      [],
    dateCellCount,
    averageRowIdx:    null,
    averageRowLabel:  '',
    averageCandidates,
    moneyCellCount,
    detectedFormat:     null,
    usedYear:           null,
    usedYearSource:     '—',
    detectedPeriod:     '—',
    skippedEmptyColumns: 0,
    failureReason:    null,
  };

  // ── Metadaten (Zeitraum) ─────────────────────────────────────────────────────
  // Erkennt sowohl Schlüsselwort-Zeilen ("Zeitraum: …", "Periode …") als auch
  // reine Datumsbereiche ("01.06. - 30.06.2025"). Ein numerischer Zeitraum ist am
  // aussagekräftigsten und bricht die Suche ab; eine Schlüsselwort-Zeile mit Jahr
  // aber ohne numerisches Datum (z. B. "Zeitraum Juni 2025") wird als Fallback
  // gemerkt. Die reine Datums-Kopfzeile ("01.06. 02.06. …") ohne Jahr zählt NICHT
  // als Zeitraum.
  let periodRaw = '';
  let metaFrom = '';
  let metaTo = '';
  const RANGE_RE = /\d{1,2}\.\d{1,2}\.?(?:\d{2,4})?\s*(?:-|–|—|bis)\s*\d{1,2}\.\d{1,2}\.\d{2,4}/i;
  for (let i = 0; i < Math.min(allLines.length, 25); i++) {
    const joined = allLines[i].map(cleanCell).join(' ').trim();
    if (!joined) continue;
    const hasKeyword = /zeitraum|periode|datum von|von .* bis/i.test(joined);
    const hasRange = RANGE_RE.test(joined);
    if (!hasKeyword && !hasRange) continue;
    const dates = joined.match(/\d{1,2}\.\d{1,2}\.\d{2,4}/g);
    if (dates && dates.length >= 1) {
      periodRaw = joined;
      metaFrom = parseGermanDate(dates[0]);
      metaTo = parseGermanDate(dates[dates.length - 1]);
      break;
    }
    // Schlüsselwort-Zeile mit Jahr, aber ohne numerisches Datum ("Zeitraum Juni 2025").
    if (hasKeyword && !periodRaw && /(?:19|20)\d{2}/.test(joined)) {
      periodRaw = joined;
    }
  }
  debug.detectedPeriod = periodRaw || '—';

  // ── Kopfzeile mit Datums-Spalten finden ──────────────────────────────────────
  let headerRowIdx = -1;
  let bestCount = 0;
  for (let i = 0; i < allLines.length; i++) {
    const count = allLines[i].reduce((acc, cell) => acc + (parseHeaderDate(cell) ? 1 : 0), 0);
    if (count > bestCount) { bestCount = count; headerRowIdx = i; }
  }
  const isWide = headerRowIdx !== -1 && bestCount >= 2;

  // ── Basis-Jahr bestimmen (gilt für Wide- UND Vertical-Layout) ────────────────
  // Klare Priorität — das Jahr wird NIE stillschweigend geraten:
  //   1. Datumsspalten  (explizites Jahr in einer Datumszelle, z. B. 01.06.2026)
  //   2. Zeitraum       (Jahr aus einer Zeitraum-/Periode-Angabe im Bericht)
  //   3. Dateiname      (z. B. Durchschnittsbon_2025.csv)
  //   4. Benutzerwahl   (vom Aufrufer übergebenes Jahr; UI-Standard = aktuelles Jahr)
  // Das aktuelle Jahr ist nur UI-Standardwert für die Benutzerwahl, KEIN stiller
  // Parser-Fallback.
  let explicitYear: number | null = null;
  for (const line of allLines) {
    for (const cell of line) {
      const d = parseHeaderDate(cell);
      if (d?.year) { explicitYear = d.year; break; }
    }
    if (explicitYear) break;
  }
  const zeitraumYear = extractYear(periodRaw);
  const fileYear = extractYear(fileName);

  let baseYear: number;
  let usedYearSource: string;
  if (explicitYear != null) {
    baseYear = explicitYear;
    usedYearSource = 'Datumsspalten';
  } else if (zeitraumYear != null) {
    baseYear = zeitraumYear;
    usedYearSource = 'Zeitraum';
  } else if (fileYear != null) {
    baseYear = fileYear;
    usedYearSource = 'Dateiname';
  } else {
    baseYear = userYear ?? new Date().getFullYear();
    usedYearSource = 'Benutzerwahl';
    warnings.push('Bitte Importjahr prüfen, da im Bericht kein Jahr enthalten ist.');
  }
  debug.usedYear = baseYear;
  debug.usedYearSource = usedYearSource;

  // Datums-Zelle → ISO; eigene Rollover-Instanz je Layout (aufsteigende Monate).
  const makeIsoResolver = () => {
    let prevMonth = -1;
    let yearOffset = 0;
    return (cell: string): { iso: string; raw: string } | null => {
      const d = parseHeaderDate(cell);
      if (!d) return null;
      if (prevMonth !== -1 && d.month < prevMonth && !d.year) yearOffset++;
      prevMonth = d.month;
      const y = d.year ?? (baseYear + yearOffset);
      return { iso: `${y}-${pad2(d.month)}-${pad2(d.day)}`, raw: cleanCell(cell) };
    };
  };

  const currencyTally = new Map<string, number>();
  const rows: GnAverageCheckRow[] = [];
  let skippedEmpty = 0;

  if (isWide) {
    // ════════════════════════ WIDE-Layout (Datums-Spalten) ════════════════════
    debug.detectedFormat = 'wide';
    debug.headerRowIdx = headerRowIdx + 1;
    const headerCells = allLines[headerRowIdx];

    // Spalten-Index → ISO-Datum (mit Jahres-Rollover für Mehrmonats-Berichte).
    const resolve = makeIsoResolver();
    const colDates = new Map<number, { iso: string; raw: string }>();
    for (let c = 0; c < headerCells.length; c++) {
      const v = resolve(headerCells[c]);
      if (v) colDates.set(c, v);
    }
    debug.dateColumns = [...colDates.entries()].map(([col, v]) => ({ col, raw: v.raw, iso: v.iso }));

    // ── "Durchschnitt"-Zeile (bzw. Zeile mit den meisten Tageswerten) finden ──
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
      debug.failureReason =
        `Datums-Spalten erkannt (${colDates.size}), aber keine Zeile mit ` +
        `Tageswerten (Geldbeträgen) in diesen Spalten gefunden. ` +
        `Im Dokument: ${moneyCellCount} Geldwert-Zelle(n)` +
        (averageCandidates.length > 0
          ? `, ${averageCandidates.length} Zeile(n) mit "Durchschnitt" (aber ohne Werte in den Datums-Spalten).`
          : ', keine Zeile mit "Durchschnitt".');
      warnings.push('Keine Durchschnittsbon-Tageswerte gefunden.');
      return emptyResult(fileName, checksum, warnings, debug, periodRaw, metaFrom, metaTo);
    }

    debug.averageRowIdx = valueRowIdx + 1;
    debug.averageRowLabel = labelOf(allLines[valueRowIdx]);

    // ── Tageswerte einlesen ──
    const valueRow = allLines[valueRowIdx];
    for (const c of dateCols) {
      const col = colDates.get(c)!;
      const raw = cleanCell(valueRow[c] ?? '');
      const { value, currency } = parseMoney(raw);
      if (value <= 0) { if (!raw) skippedEmpty++; continue; }
      const cur = currency ?? 'CHF';
      currencyTally.set(cur, (currencyTally.get(cur) ?? 0) + 1);
      rows.push({ date: col.iso, averageCheck: value, currency: cur, rawDateHeader: col.raw, rawValue: raw });
    }
  } else {
    // ═══════════════════ VERTICAL-Layout (eine Zeile pro Tag) ══════════════════
    // Erkennung: Datumswerte liegen zeilenweise vor (genau EINE Datumszelle +
    // mind. ein Geldwert pro Zeile), z. B. "01.06.2026;CHF 45,22".
    const dateRows: Array<{ lineIdx: number; dateCol: number; cell: string }> = [];
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      const dateIdxs: number[] = [];
      for (let c = 0; c < line.length; c++) if (parseHeaderDate(line[c])) dateIdxs.push(c);
      if (dateIdxs.length !== 1) continue;
      if (line.some(cell => parseMoney(cell).value > 0)) {
        dateRows.push({ lineIdx: i, dateCol: dateIdxs[0], cell: line[dateIdxs[0]] });
      }
    }

    if (dateRows.length === 0) {
      debug.failureReason =
        `Weder Datums-Spalten-Kopfzeile (max. ${bestCount} Datumszelle(n) in einer ` +
        `Zeile) noch Langformat (eine Zeile pro Tag) erkannt. Im Dokument: ` +
        `${dateCellCount} datumsartige Zelle(n), ${moneyCellCount} Geldwert-Zelle(n). ` +
        `Bitte prüfe Trennzeichen (erkannt: "${debug.delimiter}") und Format.`;
      warnings.push('Keine Datums-Spalten gefunden. Bitte prüfe das CSV-Format (Tageswerte als Spalten 01.06, 02.06 … oder eine Zeile pro Tag).');
      return emptyResult(fileName, checksum, warnings, debug, periodRaw, metaFrom, metaTo);
    }

    debug.detectedFormat = 'vertical';
    warnings.push('Langformat erkannt (eine Zeile pro Tag).');

    // Wert-Spalte bestimmen:
    // 1) Header-Zeile (ohne Datum) mit "Durchschnitt"/"Ø Bon" → deren Spaltenindex.
    // 2) sonst: Spalte, die über die Datumszeilen am häufigsten einen Geldwert > 0 trägt.
    let valueCol = -1;
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (line.some(c => parseHeaderDate(c))) continue; // Datumszeilen sind keine Header
      for (let c = 0; c < line.length; c++) {
        if (/durchschnitt|ø\s*bon|avg|mittel/i.test(cleanCell(line[c]))) { valueCol = c; break; }
      }
      if (valueCol !== -1) break;
    }
    if (valueCol === -1) {
      const tally = new Map<number, number>();
      for (const dr of dateRows) {
        const line = allLines[dr.lineIdx];
        for (let c = 0; c < line.length; c++) {
          if (c === dr.dateCol) continue;
          if (parseMoney(line[c]).value > 0) tally.set(c, (tally.get(c) ?? 0) + 1);
        }
      }
      let best = 0;
      for (const [c, n] of tally) if (n > best) { best = n; valueCol = c; }
    }

    if (valueCol === -1) {
      debug.failureReason =
        `Langformat erkannt (${dateRows.length} Datumszeile(n)), aber keine ` +
        `Wert-Spalte mit Geldbeträgen gefunden.`;
      warnings.push('Keine Durchschnittsbon-Werte im Langformat gefunden.');
      return emptyResult(fileName, checksum, warnings, debug, periodRaw, metaFrom, metaTo);
    }

    debug.averageRowLabel = `Langformat — Wert-Spalte ${valueCol + 1}`;

    const resolve = makeIsoResolver();
    for (const dr of dateRows) {
      const col = resolve(dr.cell);
      if (!col) continue;
      const raw = cleanCell(allLines[dr.lineIdx][valueCol] ?? '');
      const { value, currency } = parseMoney(raw);
      if (value <= 0) { if (!raw) skippedEmpty++; continue; }
      const cur = currency ?? 'CHF';
      currencyTally.set(cur, (currencyTally.get(cur) ?? 0) + 1);
      rows.push({ date: col.iso, averageCheck: value, currency: cur, rawDateHeader: col.raw, rawValue: raw });
    }

    // Diagnose: Datums-"Spalten" = erkannte Datumszeilen (chronologisch).
    debug.dateColumns = rows
      .map(r => ({ col: valueCol, raw: r.rawDateHeader, iso: r.date }))
      .sort((a, b) => a.iso.localeCompare(b.iso));
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  debug.skippedEmptyColumns = skippedEmpty;

  if (rows.length === 0) {
    debug.failureReason =
      debug.failureReason ??
      (`Layout erkannt (${debug.detectedFormat ?? '?'}), aber kein Wert > 0 in den ` +
       `erkannten Tageswerten lesbar.`);
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

  // ── Console-Debug-Ausgabe (analog Z-Bericht) ───────────────────────────────
  console.group(`[GN-AVG-PARSER] ${fileName}`);
  console.log(`Trennzeichen: "${debug.delimiter}" — ;=${delimCounts.semicolon} ,=${delimCounts.comma} \\t=${delimCounts.tab}`);
  console.log(`Zeilen gesamt: ${debug.rawLineCount} (nicht leer: ${debug.nonEmptyLineCount})`);
  console.log(`Layout: ${debug.detectedFormat ?? '?'}`);
  console.log(`Datums-Kopfzeile: Zeile ${debug.headerRowIdx ?? '?'} — ${debug.dateColumns.length} Datums-Spalte(n)/-Zeile(n)`);
  console.log(`Wertezeile: Zeile ${debug.averageRowIdx ?? '?'} (Label: "${debug.averageRowLabel}")`);
  console.log(`Jahr: ${debug.usedYear} (Quelle: ${debug.usedYearSource})`);
  console.log(`Erkannter Zeitraum: ${debug.detectedPeriod}`);
  console.log(`Übersprungene leere Tage: ${debug.skippedEmptyColumns}`);
  console.log(`Datumsartige Zellen gesamt: ${dateCellCount}, Geldwert-Zellen gesamt: ${moneyCellCount}`);
  if (debug.failureReason) console.warn('Grund (keine Tageswerte):', debug.failureReason);
  console.log('Erste 20 Rohzeilen:');
  debug.firstRawLines.forEach((l, i) => console.log(`  Z${String(i + 1).padStart(2)}: ${l || '(leer)'}`));
  console.groupEnd();

  return {
    fileName,
    checksum,
    warnings,
    debug,
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
  debug: GnAverageCheckDebug,
  periodRaw: string,
  periodFrom: string,
  periodTo: string,
): GnParsedAverageCheck {
  // Console-Debug auch im Fehlerfall, damit die reale Struktur sichtbar ist.
  console.group(`[GN-AVG-PARSER] ${fileName} — KEINE TAGESWERTE`);
  console.log(`Trennzeichen: "${debug.delimiter}" — ;=${debug.delimCounts.semicolon} ,=${debug.delimCounts.comma} \\t=${debug.delimCounts.tab}`);
  console.log(`Zeilen gesamt: ${debug.rawLineCount} (nicht leer: ${debug.nonEmptyLineCount})`);
  console.log(`Datumsartige Zellen gesamt: ${debug.dateCellCount}, Geldwert-Zellen gesamt: ${debug.moneyCellCount}`);
  console.warn('Grund:', debug.failureReason ?? 'unbekannt');
  console.log('Erste 20 Rohzeilen:');
  debug.firstRawLines.forEach((l, i) => console.log(`  Z${String(i + 1).padStart(2)}: ${l || '(leer)'}`));
  console.groupEnd();

  return {
    fileName, checksum, warnings, debug,
    periodFrom, periodTo, periodRaw,
    currency: 'CHF',
    rows: [], rowCount: 0,
    averageMean: 0, averageMin: 0, averageMax: 0,
  };
}

// ── Idempotenz (reine Logik) ─────────────────────────────────────────────────

/**
 * Prüft, ob ein Reimport ein No-op wäre: JEDER geparste Tageswert existiert
 * bereits mit identischem Wert (±0.005 wegen numeric-Rundung).
 *
 * Wird VOR dem Tages-UPSERT geprüft — ein identischer Reimport darf keinen
 * Write auslösen (kein `updated_at`-Bump, keine neue import_id).
 */
export function isAverageCheckReimportNoop(
  parsedRows: ReadonlyArray<Pick<GnAverageCheckRow, 'date' | 'averageCheck'>>,
  existingRows: ReadonlyArray<{ report_date: string; average_check_chf: number | null }>,
): boolean {
  if (parsedRows.length === 0) return false;
  const existing = new Map<string, number | null>();
  for (const r of existingRows) existing.set(r.report_date, r.average_check_chf);
  return parsedRows.every(r => {
    const have = existing.get(r.date);
    return have != null && Math.abs(have - r.averageCheck) < 0.005;
  });
}
