/**
 * Gastronovi KPI-PDF-Parser (REINE Logik)
 * ========================================
 *
 * Parst die drei Gäste-/Bon-Analyseberichte aus Gastronovi-PDFs:
 *   'anzahl_personen'   — Analyse → Verkäufe → Anzahl Personen
 *   'umsatz_pro_person' — Analyse → Verkäufe → Umsatz pro Person
 *   'durchschnittsbon'  — Analyse → Verkäufe → Durchschnittsbon
 *
 * Arbeitet auf den rekonstruierten PDF-Zeilen aus gn-pdf-lines.ts (pdfjs-
 * Text-Items) — kein DOM, kein Supabase, kein pdfjs. Vollständig mit
 * JSON-/synthetischen Fixtures testbar.
 *
 * Layout (Wide-Tabelle): Datums-Spaltenköpfe («01.06.», «02.06.» …), darunter
 * eine Wertezeile. Mehrere Spaltenblöcke (Zeilenumbruch der Tabelle oder
 * Seitenumbruch) werden nacheinander gelesen — jeder Datums-Kopf eröffnet
 * einen neuen Block; Werte werden über die X-Position der Spalte zugeordnet.
 *
 * Verbindliche Regeln (Auftrag):
 *   - LEERE Tageswerte bleiben leer (null) — NIE als 0 gespeichert; ein
 *     explizites «0» im PDF bleibt dagegen 0.
 *   - Jahres-Priorität: 1. Jahr im PDF-Inhalt (Datumszellen) → 2. Zeitraum/
 *     Titel → 3. Benutzerwahl → 4. eindeutiger Dateiname → 5. Pflichtwahl
 *     (yearMissing=true, keine ISO-Daten, UI muss ein Jahr anfordern).
 *   - Konkrete Diagnose statt Blind-Adaption: jedes Parse-Ergebnis enthält
 *     ein debug-Objekt mit erkannten Blöcken, Kandidatenzeilen und
 *     failureReason auf ALLEN Fehlerpfaden.
 */

import { parseSwissNumber, simpleHash } from './gn-zbericht-parser';
import {
  parseHeaderDate,
  parseMoney,
  type GnParsedAverageCheck,
  type GnAverageCheckDebug,
} from './gn-average-check-parser';
import type { GnParsedPersonReport, GnPersonRow } from './gn-personen-parser';
import {
  reconstructGnPdfLines,
  stripGnPdfHeaderFooters,
  detectGnPdfReportKind,
  type GnPdfPageItems,
  type GnPdfLine,
  type GnPdfReportKind,
} from './gn-pdf-lines';

// ── Typen ─────────────────────────────────────────────────────────────────────

export type GnKpiKind = 'anzahl_personen' | 'umsatz_pro_person' | 'durchschnittsbon';

export const GN_KPI_KIND_LABELS: Record<GnKpiKind, string> = {
  anzahl_personen: 'Anzahl Personen',
  umsatz_pro_person: 'Umsatz pro Person',
  durchschnittsbon: 'Durchschnittsbon',
};

export interface GnKpiDay {
  /** ISO yyyy-MM-dd — '' solange das Jahr fehlt (yearMissing). */
  date: string;
  day: number;
  month: number;
  /** Tageswert; null = leeres Feld im PDF (z. B. Ruhetag) — NIE 0. */
  value: number | null;
  rawDateHeader: string;
  rawValue: string;
}

export interface GnKpiPdfDebug {
  fileName: string;
  pageCount: number;
  lineCount: number;
  strippedHeaderFooterCount: number;
  titleLine: string | null;
  detectedKindRaw: GnPdfReportKind;
  /** Erkannte Spaltenblöcke: Anzahl Datums-Spalten je Block. */
  blocks: Array<{ page: number; dateColumnCount: number; hasSummaryColumn: boolean }>;
  /** Label der verwendeten Wertezeile je Block. */
  valueRowLabels: string[];
  /** Zeilen mit Zahlenwerten, die NICHT als Wertezeile verwendet wurden. */
  ignoredValueRowLabels: string[];
  detectedPeriod: string;
  usedYear: number | null;
  usedYearSource: 'PDF-Inhalt' | 'Zeitraum' | 'Benutzerwahl' | 'Dateiname' | 'Pflichtwahl';
  /** Erste 25 rekonstruierten Zeilen (Diagnose der realen Struktur). */
  firstLines: string[];
  failureReason: string | null;
}

export interface GnParsedKpiPdf {
  fileName: string;
  checksum: string;
  kind: GnKpiKind | null;
  kindLabel: string;
  warnings: string[];
  debug: GnKpiPdfDebug;

  /** true ⇒ kein Jahr ermittelbar — UI MUSS eine Jahreswahl erzwingen. */
  yearMissing: boolean;
  year: number | null;

  periodRaw: string;
  periodFrom: string;
  periodTo: string;

  days: GnKpiDay[];
  /** Tage mit Wert (value !== null). */
  filledDayCount: number;
  /** Leere Felder (Datums-Spalte ohne Wert). */
  emptyDayCount: number;

  /** Wert der «Gesamt»/«Durchschnitt»-Summenspalte, falls im PDF vorhanden. */
  summaryValue: number | null;
  summaryLabel: string | null;

  /** Menschlich lesbare Kurzdiagnose, z. B.
   *  «Durchschnittsbon erkannt: 17 Tageswerte und 13 leere Felder.» */
  diagnosis: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUMMARY_HEADER_RE = /^(gesamt|total|durchschnitt|ø|mittelwert)\.?$/i;
const VALUE_ROW_PREFER_RE = /durchschnitt|gesamt|total|ø|personen|umsatz|bon/i;

function extractYearFrom(...sources: Array<string | null | undefined>): number | null {
  for (const s of sources) {
    const m = (s || '').match(/(20\d{2})/);
    if (m) return +m[1];
  }
  return null;
}

/** Zellwert → Zahl oder null (kein Zahlwert). Explizites «0» bleibt 0. */
function parseCellValue(text: string, kind: GnKpiKind): number | null {
  const t = text.trim();
  if (!t) return null;
  if (t === '—' || t === '-' || t === '–') return null;
  if (kind === 'anzahl_personen') {
    // Ganzzahl (auch mit Tausendertrennung), KEIN Geldbetrag-Zwang.
    if (!/^-?[\d'\u2019.,]+$/.test(t)) return null;
    const v = parseSwissNumber(t);
    return Number.isFinite(v) ? Math.round(v) : null;
  }
  // Geldwerte: «CHF 54.07» / «54.07» / «54,07»
  const { value } = parseMoney(t);
  if (value !== 0) return value;
  // parseMoney liefert 0 sowohl für «0.00» als auch für Nicht-Zahlen —
  // explizite Null nur akzeptieren, wenn die Zelle wirklich numerisch ist.
  const numPart = t.replace(/[A-Za-zÄÖÜäöü€$£\s]/g, '');
  return /^[0.,'\u2019-]*0[0.,'\u2019]*$/.test(numPart) && /\d/.test(numPart) ? 0 : null;
}

interface DateColumn { x: number; day: number; month: number; year: number | null; raw: string }
interface Block {
  page: number;
  headerLineIdx: number;
  dateCols: DateColumn[];
  summaryCol: { x: number; label: string } | null;
  lines: GnPdfLine[];
}

/** Zeile = Datums-Kopfzeile, wenn ≥2 Zellen als Tag.Monat-Datum lesbar sind. */
function dateHeaderCols(line: GnPdfLine): DateColumn[] {
  const cols: DateColumn[] = [];
  for (const cell of line.cells) {
    const d = parseHeaderDate(cell.text);
    if (d) cols.push({ x: cell.x, day: d.day, month: d.month, year: d.year, raw: cell.text });
  }
  return cols;
}

/** Nächstgelegene Datums-Spalte zu einer X-Position (Toleranz: halber Minimalabstand, mind. 12). */
function nearestColumn<T extends { x: number }>(cols: T[], x: number): T | null {
  if (cols.length === 0) return null;
  let best: T | null = null;
  let bestDist = Infinity;
  for (const c of cols) {
    const dist = Math.abs(c.x - x);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  let minGap = Infinity;
  const sorted = cols.slice().sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i].x - sorted[i - 1].x);
  const tolerance = Math.max(12, (Number.isFinite(minGap) ? minGap : 24) / 2 + 2);
  return best && bestDist <= tolerance ? best : null;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnKpiPdf(
  pages: GnPdfPageItems[],
  fileName: string,
  /** Vom Benutzer im Importformular gewähltes Jahr (Priorität 3). */
  userYear?: number,
): GnParsedKpiPdf {
  const warnings: string[] = [];

  const allLines = reconstructGnPdfLines(pages);
  const { lines, removedCount } = stripGnPdfHeaderFooters(allLines);
  const detection = detectGnPdfReportKind(allLines);
  const checksum = simpleHash(lines.map(l => l.text).join('\n'));

  const debug: GnKpiPdfDebug = {
    fileName,
    pageCount: pages.length,
    lineCount: lines.length,
    strippedHeaderFooterCount: removedCount,
    titleLine: detection.titleLine,
    detectedKindRaw: detection.kind,
    blocks: [],
    valueRowLabels: [],
    ignoredValueRowLabels: [],
    detectedPeriod: '—',
    usedYear: null,
    usedYearSource: 'Pflichtwahl',
    firstLines: lines.slice(0, 25).map(l => l.text),
    failureReason: null,
  };

  const base: Omit<GnParsedKpiPdf, 'kind' | 'kindLabel' | 'diagnosis'> = {
    fileName, checksum, warnings, debug,
    yearMissing: false, year: null,
    periodRaw: '', periodFrom: '', periodTo: '',
    days: [], filledDayCount: 0, emptyDayCount: 0,
    summaryValue: null, summaryLabel: null,
  };

  const fail = (kind: GnKpiKind | null, reason: string, diagnosis: string): GnParsedKpiPdf => {
    debug.failureReason = reason;
    warnings.push(diagnosis);
    return {
      ...base, kind,
      kindLabel: kind ? GN_KPI_KIND_LABELS[kind] : 'Unbekannter Bericht',
      diagnosis,
    };
  };

  // ── Berichtstyp (inhaltsbasiert, nie Dateiname) ─────────────────────────────
  if (detection.kind === 'zbericht') {
    return fail(null,
      `Berichtstyp «Z-Bericht» erkannt (Titel: ${detection.titleLine ?? '—'}).`,
      'Dieses PDF ist ein Z-Bericht — bitte im Bereich «Z-Bericht (PDF)» importieren.');
  }
  if (detection.kind === 'unbekannt') {
    return fail(null,
      `Kein bekannter Berichtstyp im Inhalt gefunden. Titelzeile: «${detection.titleLine ?? '—'}». ` +
      `Erwartet wird einer der Titel «Anzahl Personen», «Umsatz pro Person» oder «Durchschnittsbon».`,
      'Berichtstyp nicht erkannt — bitte einen Gastronovi-Analysebericht (Anzahl Personen, Umsatz pro Person oder Durchschnittsbon) als PDF exportieren.');
  }
  const kind = detection.kind as GnKpiKind;
  const kindLabel = GN_KPI_KIND_LABELS[kind];

  // ── Zeitraum-Metazeile ──────────────────────────────────────────────────────
  let periodRaw = '';
  let metaFrom = '';
  let metaTo = '';
  const RANGE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(?:-|–|—|bis)\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})/i;
  for (const line of lines.slice(0, 25)) {
    const t = line.text;
    if (!/zeitraum|periode/i.test(t) && !RANGE_RE.test(t)) continue;
    const m = t.match(RANGE_RE);
    if (m) {
      const iso = (d: string, mo: string, y: string) => {
        let yy = +y; if (yy < 100) yy += 2000;
        return `${yy}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
      };
      periodRaw = t;
      metaFrom = iso(m[1], m[2], m[3]);
      metaTo = iso(m[4], m[5], m[6]);
      break;
    }
    if (/zeitraum|periode/i.test(t) && !periodRaw) periodRaw = t;
  }
  debug.detectedPeriod = periodRaw || '—';

  // ── Spaltenblöcke sammeln ───────────────────────────────────────────────────
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = dateHeaderCols(lines[i]);
    if (cols.length >= 2) {
      // Summenspalte («Gesamt»/«Durchschnitt») im selben Kopf erkennen.
      let summaryCol: Block['summaryCol'] = null;
      for (const cell of lines[i].cells) {
        if (SUMMARY_HEADER_RE.test(cell.text.trim())) {
          summaryCol = { x: cell.x, label: cell.text.trim() };
        }
      }
      blocks.push({ page: lines[i].pageNumber, headerLineIdx: i, dateCols: cols, summaryCol, lines: [] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1].lines.push(lines[i]);
    }
  }
  debug.blocks = blocks.map(b => ({
    page: b.page, dateColumnCount: b.dateCols.length, hasSummaryColumn: b.summaryCol !== null,
  }));

  if (blocks.length === 0) {
    return fail(kind,
      `${kindLabel} erkannt, aber keine Datums-Spaltenkopfzeile (≥2 Datumszellen wie «01.06.») gefunden. ` +
      `${lines.length} Zeile(n) gelesen — erste Zeilen siehe Diagnose.`,
      `${kindLabel} erkannt, aber keine Tages-Tabelle gefunden — bitte den Tagesbericht (Spalten je Tag) als PDF exportieren.`);
  }

  // ── Jahr bestimmen (Priorität laut Auftrag) ─────────────────────────────────
  let explicitYear: number | null = null;
  for (const b of blocks) {
    for (const c of b.dateCols) if (c.year) { explicitYear = c.year; break; }
    if (explicitYear) break;
  }
  const periodYear = extractYearFrom(periodRaw, metaFrom, detection.titleLine);
  const fileYearMatches = (fileName.match(/20\d{2}/g) ?? []);
  const uniqueFileYears = [...new Set(fileYearMatches)];
  const fileYear = uniqueFileYears.length === 1 ? +uniqueFileYears[0] : null;

  let year: number | null = null;
  let yearMissing = false;
  if (explicitYear != null) {
    year = explicitYear; debug.usedYearSource = 'PDF-Inhalt';
  } else if (periodYear != null) {
    year = periodYear; debug.usedYearSource = 'Zeitraum';
  } else if (userYear != null) {
    year = userYear; debug.usedYearSource = 'Benutzerwahl';
  } else if (fileYear != null) {
    year = fileYear; debug.usedYearSource = 'Dateiname';
    warnings.push(`Jahr ${fileYear} aus dem Dateinamen übernommen — bitte prüfen.`);
  } else {
    yearMissing = true; debug.usedYearSource = 'Pflichtwahl';
  }
  debug.usedYear = year;

  // ── Wertezeile je Block finden und Tage einlesen ────────────────────────────
  const days: GnKpiDay[] = [];
  let summaryValue: number | null = null;
  let summaryLabel: string | null = null;

  for (const block of blocks) {
    type Candidate = { line: GnPdfLine; label: string; matches: Array<{ col: DateColumn; value: number; raw: string }> };
    const candidates: Candidate[] = [];

    for (const line of block.lines) {
      if (dateHeaderCols(line).length >= 2) continue; // Sicherheit
      const matches: Candidate['matches'] = [];
      const labelParts: string[] = [];
      for (const cell of line.cells) {
        const col = nearestColumn(block.dateCols, cell.x);
        const value = parseCellValue(cell.text, kind);
        if (col && value !== null) {
          matches.push({ col, value, raw: cell.text });
        } else if (!col || value === null) {
          const isSummaryCell = block.summaryCol && Math.abs(cell.x - block.summaryCol.x) <= 12;
          if (!isSummaryCell && value === null) labelParts.push(cell.text);
        }
      }
      if (matches.length > 0) {
        candidates.push({ line, label: labelParts.join(' ').trim(), matches });
      }
    }

    if (candidates.length === 0) continue;

    // Bevorzugt: Zeile mit passendem Label; sonst Zeile mit den meisten Werten.
    let chosen = candidates.find(c => VALUE_ROW_PREFER_RE.test(c.label)) ?? null;
    if (!chosen) chosen = candidates.reduce((a, b) => (b.matches.length > a.matches.length ? b : a));
    debug.valueRowLabels.push(chosen.label || '(ohne Label)');
    for (const c of candidates) {
      if (c !== chosen && c.matches.length > 0) {
        debug.ignoredValueRowLabels.push(c.label || '(ohne Label)');
      }
    }

    // Zuordnung Wert → Spalte (jede Spalte höchstens einmal).
    const byCol = new Map<DateColumn, { value: number; raw: string }>();
    for (const m of chosen.matches) {
      if (!byCol.has(m.col)) byCol.set(m.col, { value: m.value, raw: m.raw });
    }
    for (const col of block.dateCols) {
      const hit = byCol.get(col);
      days.push({
        date: '', day: col.day, month: col.month,
        value: hit ? hit.value : null,
        rawDateHeader: col.raw,
        rawValue: hit ? hit.raw : '',
      });
    }

    // Summenspalte auslesen (nur erster Treffer zählt).
    if (block.summaryCol && summaryValue === null) {
      for (const cell of chosen.line.cells) {
        if (Math.abs(cell.x - block.summaryCol.x) <= 12) {
          const v = parseCellValue(cell.text, kind);
          if (v !== null) { summaryValue = v; summaryLabel = block.summaryCol.label; }
        }
      }
    }
  }

  if (debug.ignoredValueRowLabels.length > 0) {
    warnings.push(
      `Mehrere Wertezeilen gefunden — verwendet: «${debug.valueRowLabels[0]}», ` +
      `ignoriert: ${debug.ignoredValueRowLabels.map(l => `«${l}»`).join(', ')}.`);
  }

  if (days.length === 0) {
    return fail(kind,
      `${kindLabel} erkannt, ${blocks.length} Spaltenblock/-blöcke mit Datums-Köpfen gefunden, ` +
      `aber keine Zeile mit Tageswerten darunter.`,
      `${kindLabel} erkannt, aber keine Tageswerte gefunden — Tabelle im PDF prüfen (Diagnose zeigt die gelesene Struktur).`);
  }

  // ── ISO-Daten setzen (Monats-Rollover über Jahresgrenze) ────────────────────
  if (!yearMissing && year != null) {
    let prevMonth = -1;
    let yearOffset = 0;
    for (const d of days) {
      if (prevMonth !== -1 && d.month < prevMonth) yearOffset++;
      prevMonth = d.month;
      const y = year + yearOffset;
      d.date = `${y}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
  }

  const filledDayCount = days.filter(d => d.value !== null).length;
  const emptyDayCount = days.length - filledDayCount;
  const withDate = days.filter(d => d.date);
  const periodFrom = withDate.length > 0 ? withDate[0].date : metaFrom;
  const periodTo = withDate.length > 0 ? withDate[withDate.length - 1].date : metaTo;

  let diagnosis: string;
  if (yearMissing) {
    diagnosis = `${kindLabel} erkannt, aber Jahr fehlt.`;
    warnings.push(`${diagnosis} Bitte das Importjahr wählen — ohne Jahr wird nichts gespeichert.`);
  } else {
    diagnosis = `${kindLabel} erkannt: ${filledDayCount} Tageswert${filledDayCount === 1 ? '' : 'e'} ` +
      `und ${emptyDayCount} leere${emptyDayCount === 1 ? 's' : ''} Feld${emptyDayCount === 1 ? '' : 'er'}.`;
    if (emptyDayCount > 0) {
      warnings.push(`${emptyDayCount} leere Tagesfeld(er) — bleiben leer (z. B. Ruhetage), werden NICHT als 0 gespeichert.`);
    }
  }

  return {
    ...base, kind, kindLabel,
    yearMissing, year,
    periodRaw, periodFrom, periodTo,
    days, filledDayCount, emptyDayCount,
    summaryValue, summaryLabel,
    diagnosis,
  };
}

// ── Konverter zu den bestehenden Import-Shapes ────────────────────────────────
// Die DB-Schichten (gn-personen-db.ts, gn-average-check-db.ts) und die
// Verlaufs-/Auswertungslogik bleiben unverändert — der PDF-Weg liefert exakt
// dieselben Ergebnis-Objekte wie die (nur noch intern erhaltenen) CSV-Parser.

/**
 * Durchschnittsbon-PDF → GnParsedAverageCheck (Tabelle gn_average_checks).
 * Nur gültig für kind='durchschnittsbon' mit aufgelöstem Jahr.
 */
export function kpiPdfToAverageCheck(parsed: GnParsedKpiPdf): GnParsedAverageCheck {
  if (parsed.kind !== 'durchschnittsbon') {
    throw new Error(`kpiPdfToAverageCheck: falscher Berichtstyp «${parsed.kindLabel}».`);
  }
  if (parsed.yearMissing) {
    throw new Error('kpiPdfToAverageCheck: Jahr fehlt — zuerst Importjahr wählen.');
  }
  const rows = parsed.days
    .filter(d => d.date && d.value !== null && d.value > 0)
    .map(d => ({
      date: d.date,
      averageCheck: d.value as number,
      currency: 'CHF',
      rawDateHeader: d.rawDateHeader,
      rawValue: d.rawValue,
    }));
  const values = rows.map(r => r.averageCheck);
  const debug: GnAverageCheckDebug = {
    fileName: parsed.fileName,
    delimiter: 'PDF',
    delimCounts: { semicolon: 0, comma: 0, tab: 0 },
    rawLineCount: parsed.debug.lineCount,
    nonEmptyLineCount: parsed.debug.lineCount,
    firstRawLines: parsed.debug.firstLines,
    firstParsedRows: [],
    headerRowIdx: null,
    dateColumns: rows.map((r, i) => ({ col: i, raw: r.rawDateHeader, iso: r.date })),
    dateCellCount: parsed.days.length,
    averageRowIdx: null,
    averageRowLabel: parsed.debug.valueRowLabels.join(' | '),
    averageCandidates: [],
    moneyCellCount: parsed.filledDayCount,
    detectedFormat: 'wide',
    usedYear: parsed.year,
    usedYearSource: parsed.debug.usedYearSource,
    detectedPeriod: parsed.debug.detectedPeriod,
    skippedEmptyColumns: parsed.emptyDayCount,
    failureReason: rows.length === 0 ? (parsed.debug.failureReason ?? 'Keine Tageswerte > 0.') : null,
  };
  return {
    fileName: parsed.fileName,
    checksum: parsed.checksum,
    warnings: parsed.warnings,
    debug,
    periodFrom: rows.length > 0 ? rows[0].date : parsed.periodFrom,
    periodTo: rows.length > 0 ? rows[rows.length - 1].date : parsed.periodTo,
    periodRaw: parsed.periodRaw,
    currency: 'CHF',
    rows,
    rowCount: rows.length,
    averageMean: values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0,
    averageMin: values.length > 0 ? Math.min(...values) : 0,
    averageMax: values.length > 0 ? Math.max(...values) : 0,
  };
}

/**
 * Personen-/Umsatz-pro-Person-PDF → GnParsedPersonReport
 * (Tabellen gn_person_imports/gn_person_metrics).
 * Leere Tage werden NICHT als Zeile gespeichert (fehlend ≠ 0).
 */
export function kpiPdfToPersonReport(parsed: GnParsedKpiPdf): GnParsedPersonReport {
  if (parsed.kind !== 'anzahl_personen' && parsed.kind !== 'umsatz_pro_person') {
    throw new Error(`kpiPdfToPersonReport: falscher Berichtstyp «${parsed.kindLabel}».`);
  }
  if (parsed.yearMissing) {
    throw new Error('kpiPdfToPersonReport: Jahr fehlt — zuerst Importjahr wählen.');
  }
  const isGuests = parsed.kind === 'anzahl_personen';
  const rows: GnPersonRow[] = parsed.days
    .filter(d => d.date && d.value !== null)
    .map(d => ({
      date: d.date,
      periodLabel: null,
      guestsCount: isGuests ? Math.round(d.value as number) : 0,
      revPerPerson: isGuests ? 0 : (d.value as number),
      revTotal: null,
      averageReceipt: null,
      sourceRowJson: { [d.rawDateHeader]: d.rawValue, quelle: 'PDF' },
    }));

  const guestSum = rows.reduce((s, r) => s + r.guestsCount, 0);
  const revPPValues = rows.map(r => r.revPerPerson).filter(v => v > 0);

  // Summenspalte: «Gesamt»/«Total» = Gästesumme; «Durchschnitt»/«Ø» = Mittelwert.
  const summaryIsMean = parsed.summaryLabel != null && /durchschnitt|ø|mittel/i.test(parsed.summaryLabel);
  const totalGuests = isGuests
    ? (parsed.summaryValue != null && !summaryIsMean ? Math.round(parsed.summaryValue) : guestSum)
    : 0;
  const avgRevPerPerson = !isGuests
    ? (parsed.summaryValue != null && summaryIsMean
        ? parsed.summaryValue
        : (revPPValues.length > 0 ? revPPValues.reduce((s, v) => s + v, 0) / revPPValues.length : 0))
    : 0;

  return {
    fileName: parsed.fileName,
    checksum: parsed.checksum,
    warnings: parsed.warnings,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    periodRaw: parsed.periodRaw,
    detectedCsvType: parsed.kind,
    totalGuests,
    avgRevPerPerson,
    totalRevenue: null,
    avgReceiptMonthly: 0,
    rowCount: rows.length,
    rows,
  };
}
