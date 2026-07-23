/**
 * Gastronovi KPI-CSV-Parser (REINE Logik)
 * ========================================
 *
 * Parst die drei Gäste-/Bon-Analyseberichte aus Gastronovi-CSV-Exporten
 * (Wide-Format) und liefert EXAKT dasselbe Ergebnis-Objekt wie der
 * KPI-PDF-Parser (GnParsedKpiPdf) — Jahreswahl, Konverter, Duplikat-
 * Prüfung und Speicherpfade bleiben unverändert (keine neuen Datenmodelle).
 *
 *   'anzahl_personen'   — Analyse → Verkäufe → Anzahl Personen
 *   'umsatz_pro_person' — Analyse → Verkäufe → Umsatz pro Person
 *   'durchschnittsbon'  — Analyse → Verkäufe → Durchschnittsbon
 *
 * Erwartetes Format (Tab-/Semikolon-/Komma-getrennt, Zellen ggf. in «"»):
 *   Kopfzeile:  "Bezeichnung"  "Zeitraum"  "01.06."  "02.06."  …
 *   Wertezeile: "Gesamt"       "6036 P."   "263 P."  "295 P."  …
 *           bzw."Durchschnitt" "CHF 54,07" "CHF 45,22" …
 *
 * Verbindliche Regeln (identisch zum PDF-Weg):
 *   - LEERE Tageszellen bleiben leer (null) — NIE als 0 gespeichert; ein
 *     explizites «0» bleibt dagegen 0.
 *   - Jahres-Priorität: 1. Jahr im CSV-Inhalt (Datums-Spaltenköpfe) →
 *     2. Zeitraum-Zeile → 3. Benutzerwahl → 4. eindeutiger Dateiname →
 *     5. Pflichtwahl (yearMissing=true, UI muss ein Jahr anfordern).
 *   - Konkrete Diagnose statt Blind-Adaption: debug-Objekt mit erkannten
 *     Spalten, Wertezeilen-Labels und failureReason auf ALLEN Fehlerpfaden.
 *
 * Berichtstyp-Erkennung (bewusste Abweichung vom PDF, dokumentiert):
 *   CSV-Exporte tragen KEINE Titelzeile. «Anzahl Personen» ist inhaltlich
 *   an der Einheit «P.» erkennbar; die beiden CHF-Berichte (Umsatz pro
 *   Person vs. Durchschnittsbon) sind inhaltlich identisch aufgebaut und
 *   werden über den Gastronovi-Dateinamen unterschieden. Ohne eindeutigen
 *   Dateinamen wird der Import mit klarer Diagnose abgelehnt — nie geraten.
 */

import { simpleHash } from './gn-zbericht-parser';
import { parseHeaderDate, parseMoney } from './gn-average-check-parser';
import {
  GN_KPI_KIND_LABELS,
  parseGnKpiCellValue,
  type GnKpiKind,
  type GnKpiDay,
  type GnKpiPdfDebug,
  type GnParsedKpiPdf,
} from './gn-kpi-pdf-parser';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALUE_ROW_PREFER_RE = /durchschnitt|gesamt|total|ø|personen|umsatz|bon/i;
const RANGE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(?:-|–|—|bis)\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})/i;

function detectDelimiter(text: string): string {
  const counts = {
    '\t': (text.match(/\t/g) ?? []).length,
    ';': (text.match(/;/g) ?? []).length,
    ',': (text.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) ?? []).length,
  };
  if (counts['\t'] > 0) return '\t';
  return counts[';'] >= counts[','] ? ';' : ',';
}

function splitCsvLine(line: string, delim: string): string[] {
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

interface CsvDateColumn { idx: number; day: number; month: number; year: number | null; raw: string }

/** Dateinamen-Hinweis auf den Berichtstyp («Anzahl_Personen_….csv» usw.). */
function kindFromFileName(fileName: string): GnKpiKind | null {
  const n = fileName.toLowerCase().replace(/[_\-.\s]+/g, ' ');
  if (n.includes('durchschnittsbon') || (n.includes('durchschnitt') && n.includes('bon'))) {
    return 'durchschnittsbon';
  }
  if (n.includes('umsatz') && n.includes('person')) return 'umsatz_pro_person';
  if (n.includes('anzahl') && n.includes('person')) return 'anzahl_personen';
  return null;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnKpiCsv(
  csvText: string,
  fileName: string,
  /** Vom Benutzer im Importformular gewähltes Jahr (Priorität 3). */
  userYear?: number,
): GnParsedKpiPdf {
  const warnings: string[] = [];
  const checksum = simpleHash(csvText);
  const delim = detectDelimiter(csvText);

  const rawLines = csvText.split(/\r?\n/);
  const rows = rawLines
    .map(l => splitCsvLine(l, delim).map(cleanCell))
    .filter(cells => cells.some(c => c !== ''));

  const debug: GnKpiPdfDebug = {
    fileName,
    pageCount: 1,
    lineCount: rows.length,
    strippedHeaderFooterCount: 0,
    titleLine: null,
    detectedKindRaw: 'unbekannt',
    blocks: [],
    valueRowLabels: [],
    ignoredValueRowLabels: [],
    detectedPeriod: '—',
    usedYear: null,
    usedYearSource: 'Pflichtwahl',
    firstLines: rawLines.filter(l => l.trim()).slice(0, 25),
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

  // ── Kopfzeile mit Datums-Spalten finden ─────────────────────────────────────
  let headerRowIdx = -1;
  let dateCols: CsvDateColumn[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cols: CsvDateColumn[] = [];
    rows[i].forEach((cell, idx) => {
      const d = parseHeaderDate(cell);
      if (d) cols.push({ idx, day: d.day, month: d.month, year: d.year, raw: cell });
    });
    if (cols.length >= 2) { headerRowIdx = i; dateCols = cols; break; }
  }

  if (headerRowIdx === -1) {
    return fail(null,
      `Keine Datums-Spaltenkopfzeile (≥2 Datumszellen wie «01.06.») gefunden. ` +
      `${rows.length} Zeile(n) gelesen, Trennzeichen «${delim === '\t' ? 'Tab' : delim}» — erste Zeilen siehe Diagnose.`,
      'Kein Gastronovi-Tagesbericht erkannt — bitte den Analyse-Export (Anzahl Personen, ' +
      'Umsatz pro Person oder Durchschnittsbon) mit Tagesspalten als CSV oder PDF hochladen.');
  }

  const headerCells = rows[headerRowIdx];
  debug.titleLine = headerCells.slice(0, 3).join('  ');

  // Summenspalte: «Zeitraum» (CSV) bzw. «Gesamt»/«Durchschnitt»/«Total».
  const dateIdxSet = new Set(dateCols.map(c => c.idx));
  let summaryColIdx = -1;
  headerCells.forEach((cell, idx) => {
    if (dateIdxSet.has(idx) || summaryColIdx !== -1) return;
    if (/^(zeitraum|gesamt|total|durchschnitt|ø|mittelwert)\.?$/i.test(cell)) summaryColIdx = idx;
  });
  debug.blocks = [{ page: 1, dateColumnCount: dateCols.length, hasSummaryColumn: summaryColIdx !== -1 }];

  // ── Wertezeilen-Kandidaten (nach der Kopfzeile) ─────────────────────────────
  interface Candidate { rowIdx: number; label: string; nonEmptyDayCells: number }
  const candidates: Candidate[] = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    const nonEmptyDayCells = dateCols.filter(c => (cells[c.idx] ?? '') !== '').length;
    if (nonEmptyDayCells === 0) continue;
    const labelParts = cells.filter((c, idx) => !dateIdxSet.has(idx) && idx !== summaryColIdx && c !== '');
    candidates.push({ rowIdx: i, label: labelParts.join(' ').trim(), nonEmptyDayCells });
  }

  if (candidates.length === 0) {
    return fail(null,
      `Datums-Kopfzeile mit ${dateCols.length} Spalten gefunden, aber keine Zeile mit Tageswerten darunter.`,
      'Tages-Tabelle erkannt, aber keine Tageswerte gefunden — CSV-Inhalt prüfen (Diagnose zeigt die gelesene Struktur).');
  }

  let chosen = candidates.find(c => VALUE_ROW_PREFER_RE.test(c.label)) ?? null;
  if (!chosen) chosen = candidates.reduce((a, b) => (b.nonEmptyDayCells > a.nonEmptyDayCells ? b : a));
  debug.valueRowLabels.push(chosen.label || '(ohne Label)');
  for (const c of candidates) {
    if (c !== chosen) debug.ignoredValueRowLabels.push(c.label || '(ohne Label)');
  }
  if (debug.ignoredValueRowLabels.length > 0) {
    warnings.push(
      `Mehrere Wertezeilen gefunden — verwendet: «${debug.valueRowLabels[0]}», ` +
      `ignoriert: ${debug.ignoredValueRowLabels.map(l => `«${l}»`).join(', ')}.`);
  }
  const valueCells = rows[chosen.rowIdx];

  // ── Berichtstyp bestimmen (Einheit «P.» inhaltlich; CHF via Dateiname) ──────
  const rawDayValues = dateCols.map(c => valueCells[c.idx] ?? '').filter(v => v !== '');
  const personsUnitCount = rawDayValues.filter(v => /(^|\d)\s*P\.?$/i.test(v)).length;
  const moneyUnitCount = rawDayValues.filter(v => /chf|eur|€/i.test(v)).length;
  const fileHint = kindFromFileName(fileName);

  let kind: GnKpiKind;
  if (personsUnitCount > 0 && moneyUnitCount === 0) {
    kind = 'anzahl_personen';
    if (fileHint && fileHint !== 'anzahl_personen') {
      warnings.push(
        `Dateiname deutet auf «${GN_KPI_KIND_LABELS[fileHint]}», die Werte tragen aber die ` +
        `Personen-Einheit «P.» — importiert wird als «Anzahl Personen».`);
    }
  } else if (moneyUnitCount > 0 || rawDayValues.length > 0) {
    if (moneyUnitCount > 0 && fileHint === 'anzahl_personen') {
      return fail(null,
        `Dateiname deutet auf «Anzahl Personen», die Werte sind aber Geldbeträge (CHF).`,
        'Widerspruch zwischen Dateiname («Anzahl Personen») und CHF-Werten — bitte die Datei ' +
        'unverändert wie von Gastronovi exportiert hochladen.');
    }
    if (!fileHint) {
      return fail(null,
        `${moneyUnitCount > 0 ? 'CHF-Werte' : 'Zahlenwerte ohne Einheit'} erkannt, aber der Berichtstyp ` +
        `ist ohne Titelzeile nicht aus dem Inhalt bestimmbar und der Dateiname enthält keinen Hinweis.`,
        'Berichtstyp nicht erkennbar — bitte den Original-Dateinamen aus Gastronovi beibehalten ' +
        '(«Anzahl_Personen…», «Umsatz_pro_Person…», «Durchschnittsbon…») oder als PDF importieren.');
    }
    kind = fileHint;
  } else {
    return fail(null,
      'Keine auswertbaren Tageswerte in der Wertezeile.',
      'Keine Tageswerte gefunden — CSV-Inhalt prüfen (Diagnose zeigt die gelesene Struktur).');
  }
  const kindLabel = GN_KPI_KIND_LABELS[kind];
  debug.detectedKindRaw = kind;

  // ── Zeitraum-Zeile (optional, oberhalb der Kopfzeile) ───────────────────────
  let periodRaw = '';
  let metaFrom = '';
  let metaTo = '';
  for (let i = 0; i < headerRowIdx; i++) {
    const t = rows[i].join(' ');
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
    if (/zeitraum|periode/i.test(t) && !periodRaw && !rows[i].includes('Bezeichnung')) periodRaw = t;
  }
  debug.detectedPeriod = periodRaw || '—';

  // ── Jahr bestimmen (Priorität wie beim PDF-Weg) ─────────────────────────────
  const explicitYear = dateCols.find(c => c.year != null)?.year ?? null;
  const periodYearMatch = (periodRaw + ' ' + metaFrom).match(/(20\d{2})/);
  const periodYear = periodYearMatch ? +periodYearMatch[1] : null;
  // Jahr im Dateinamen nur als eigenständige Zahl (nie Teil längerer
  // Ziffernfolgen wie Upload-Zeitstempel «…1784820255774…»).
  const uniqueFileYears = [...new Set(fileName.match(/(?<!\d)20\d{2}(?!\d)/g) ?? [])];
  const fileYear = uniqueFileYears.length === 1 ? +uniqueFileYears[0] : null;

  let year: number | null = null;
  let yearMissing = false;
  if (explicitYear != null) {
    year = explicitYear; debug.usedYearSource = 'CSV-Inhalt';
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

  // ── Tage einlesen (leer = null, NIE 0) ──────────────────────────────────────
  const days: GnKpiDay[] = dateCols.map(col => {
    const raw = valueCells[col.idx] ?? '';
    return {
      date: '', day: col.day, month: col.month,
      value: parseGnKpiCellValue(raw, kind),
      rawDateHeader: col.raw,
      rawValue: raw,
    };
  });

  // Summenwert («Zeitraum»-Spalte) + Label aus der Wertezeile («Gesamt»/«Durchschnitt»).
  let summaryValue: number | null = null;
  let summaryLabel: string | null = null;
  if (summaryColIdx !== -1) {
    const rawSummary = valueCells[summaryColIdx] ?? '';
    const v = kind === 'anzahl_personen'
      ? parseGnKpiCellValue(rawSummary, kind)
      : (() => { const { value } = parseMoney(rawSummary); return value !== 0 ? value : parseGnKpiCellValue(rawSummary, kind); })();
    if (v !== null) {
      summaryValue = v;
      const rowLabel = chosen.label.trim();
      summaryLabel = rowLabel || headerCells[summaryColIdx] || null;
    }
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

  if (filledDayCount === 0) {
    return fail(kind,
      `${kindLabel} erkannt, ${dateCols.length} Datums-Spalten gefunden, aber alle Tageszellen sind leer.`,
      `${kindLabel} erkannt, aber keine Tageswerte gefunden — CSV-Inhalt prüfen (Diagnose zeigt die gelesene Struktur).`);
  }

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
