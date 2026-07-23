/**
 * Gastronovi Z-Bericht — PDF-Parser (REINE Logik, kein pdfjs/DOM/Supabase)
 * ========================================================================
 *
 * Architektur (SSoT): Dieses Modul ist NUR ein Adapter. Es rekonstruiert aus
 * den PDF-Text-Items normalisierte Zeilen (string[][]) und übergibt sie dem
 * EXISTIERENDEN Sektions-Kern `parseGnZBerichtFromRows` aus
 * gn-zbericht-parser.ts — CSV und PDF teilen damit EINE Sektions-,
 * Parsing- und KPI-Logik. Es gibt keine zweite Z-Bericht-Berechnung.
 *
 * PDF-Besonderheiten, die der Adapter behandelt:
 *   - Kopf-/Fusszeilen je Seite entfernen (Seitenumbrüche ohne Duplikate).
 *   - Umsatzbox rechts oben (Total / exkl. Kundenkarten-Aufladung) →
 *     synthetische «Umsatz»-Sektion für den Kern.
 *   - «CHF»-Präfixe/Suffixe strippen; Klammerbeträge = Originalbetrag VOR
 *     Rabatt → ans Zeilenende (Kern-Konvention: 4. Spalte = Original).
 *   - Parent/Child-Zahlarten («Gastronovi Pay» eingerückt unter Visa etc.):
 *     Kinder werden NIE als eigene Zahlart gezählt (keine Doppelzählung),
 *     bleiben aber als paymentMethodProviders erhalten.
 *   - Sektionen ohne Kopfzeile: synthetische Kopfzeile injizieren (der Kern
 *     konsumiert die erste Zeile jeder Tabellensektion als Header).
 *   - Zeitabschnitte (Stundenumsätze): eigene Auswertung inkl. negativer
 *     Werte; Zeilen laufen nicht durch den Tabellen-Kern.
 *   - Geschäftstagsregel: Spanne ≤ 26 h ⇒ EIN Geschäftstag (Bis-Datum,
 *     ausser Bis-Uhrzeit < 08:00 ⇒ Von-Datum); periodFrom/periodTo werden
 *     auf den Geschäftstag gesetzt. Längere Spannen bleiben Periodensummen
 *     und werden NIE auf Tage verteilt.
 *   - Plausibilitätsprüfung (8 Summenabgleiche) mit Status
 *     Plausibel / Mit Rundungsdifferenz / Abweichung prüfen / Unvollständig.
 */

import {
  parseGnZBerichtFromRows,
  matchSectionName,
  simpleHash,
  parseSwissNumber,
  type GnParsedZBericht,
  type GnHourlyRevenueRow,
  type GnNameCountAmount,
  type GnPaymentProvider,
  type GnValidationCheck,
  type GnValidationResult,
  type GnValidationStatus,
} from './gn-zbericht-parser';
import {
  reconstructGnPdfLines,
  stripGnPdfHeaderFooters,
  detectGnPdfReportKind,
  normalizeGnMoneyCell,
  extractGnParenMoney,
  type GnPdfPageItems,
  type GnPdfLine,
  type GnPdfCell,
} from './gn-pdf-lines';

// ── Konstanten ────────────────────────────────────────────────────────────────

/** Grosse zentrierte Abschnittsbanner des PDF-Layouts. */
const PDF_BANNER_RE = /^(z-bericht|detailbericht|buchhaltung|auswertungen|abrechnung)$/i;

/** Zellen ab dieser X-Position gehören im Seitenkopf zur Umsatzbox rechts. */
const REVENUE_BOX_MIN_X = 310;

/** Einrückungs-Schwelle für Kind-Zahlarten (Parent x≈31, Child x≈44). */
const CHILD_INDENT_PX = 6;

/** Geschäftstagsregel: Berichte bis zu dieser Spanne = EIN Geschäftstag. */
const BUSINESS_DAY_MAX_HOURS = 26;

/** Bis-Uhrzeit vor dieser Stunde ⇒ Geschäftstag = Von-Datum (Nachtabschluss). */
const BUSINESS_DAY_CUTOFF_HOUR = 8;

/** Plausibilität: |Differenz| ≤ 0.05 CHF plausibel; ≤ 2.00 Rundungsdifferenz. */
const TOL_PLAUSIBLE = 0.05;
const TOL_ROUNDING = 2.0;

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const TIME_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*,?\s*(\d{1,2})[:.](\d{2}))?/;

interface ParsedStamp { iso: string; time: string | null; date: Date }

function parseGermanStamp(raw: string): ParsedStamp | null {
  const m = raw.match(TIME_RE);
  if (!m) return null;
  const [, d, mo, y, hh, mm] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const time = hh !== undefined ? `${hh.padStart(2, '0')}:${mm}` : null;
  const date = new Date(
    Number(y), Number(mo) - 1, Number(d),
    hh !== undefined ? Number(hh) : 0, mm !== undefined ? Number(mm) : 0,
  );
  return { iso, time, date };
}

/** Erste Zeile einer Tabellensektion: reine Spaltenüberschrift (keine Ziffern)? */
function looksLikeColumnHeaderRow(row: string[]): boolean {
  const rest = row.slice(1).filter(c => c.trim() !== '');
  if (rest.length === 0) return false;
  return !rest.some(c => /\d/.test(c));
}

function isHourLabel(text: string): boolean {
  return /^\d{1,2}[:.]\d{2}$/.test(text.trim());
}

/** Zelltexte einer Zeile → normalisierte Kernzeile.
 *  Klammerbetrag (Original vor Rabatt) wandert an Position 4 (Index 3). */
function cellsToRow(cells: GnPdfCell[]): string[] {
  const name = cells[0]?.text ?? '';
  let original: string | null = null;
  const values: string[] = [];
  for (const cell of cells.slice(1)) {
    const paren = extractGnParenMoney(cell.text);
    if (paren !== null) {
      original = paren;
    } else {
      values.push(normalizeGnMoneyCell(cell.text));
    }
  }
  const row = [name, ...values];
  if (original !== null) {
    while (row.length < 3) row.push('');
    row[3] = original;
  }
  return row;
}

// ── Haupt-Parser ──────────────────────────────────────────────────────────────

export function parseGnZBerichtPdf(pages: GnPdfPageItems[], fileName: string): GnParsedZBericht {
  const rawLineList = reconstructGnPdfLines(pages);
  const checksum = simpleHash(rawLineList.map(l => l.text).join('\n'));
  const { lines } = stripGnPdfHeaderFooters(rawLineList);
  const kindInfo = detectGnPdfReportKind(rawLineList);

  // ── Adapter-Pass: Zeilen → Kern-Rows + PDF-Extras ──────────────────────────
  const rows: string[][] = [];
  const boxTokens: string[] = [];
  const hourlyRows: GnHourlyRevenueRow[] = [];
  const providers: GnPaymentProvider[] = [];
  const topups: GnNameCountAmount[] = [];

  let preamble = true;               // Seite-1-Kopf (Meta links, Umsatzbox rechts)
  let currentSection: string | null = null;
  let awaitingFirstDataRow = false;  // direkt nach Sektionskopf: Headerprüfung
  let paymentBaseX: number | null = null;
  let lastPaymentParent: string | null = null;
  let inZeitabschnitte = false;
  let zeitabschnitteSeen = false;
  let hourlyTotal: number | null = null;
  let hourlyEnded = false;
  let topupTotal: { count: number; amount: number } | null = null;
  let vonRaw = '';
  let bisRaw = '';

  const emitSectionHeader = (headerText: string, canonical: string) => {
    preamble = false;
    rows.push([headerText]);
    currentSection = canonical;
    awaitingFirstDataRow = true;
    paymentBaseX = null;
    lastPaymentParent = null;
    inZeitabschnitte = canonical === 'Zeitabschnitte';
    if (inZeitabschnitte) { zeitabschnitteSeen = true; hourlyEnded = false; }
  };

  for (const line of lines) {
    if (line.cells.length === 0) continue;
    const firstCell = line.cells[0];

    // Banner («Z-Bericht», «Detailbericht», «Buchhaltung», «Auswertungen»)
    if (line.cells.length === 1 && PDF_BANNER_RE.test(firstCell.text) && firstCell.x > 100) {
      if (!preamble) {
        rows.push(['#####']);   // schliesst die laufende Sektion (Kern-Konvention)
        currentSection = null;
        inZeitabschnitte = false;
      }
      continue;
    }

    // Sektionskopf? (einzelne Zelle mit bekanntem Sektionsnamen)
    const canonical = line.cells.length === 1 ? matchSectionName(firstCell.text) : null;
    if (canonical) {
      emitSectionHeader(firstCell.text, canonical);
      continue;
    }

    // Präambel (Seite-1-Kopf): links Meta-Zeilen, rechts Umsatzbox
    if (preamble) {
      const leftCells = line.cells.filter(c => c.x < REVENUE_BOX_MIN_X);
      const rightCells = line.cells.filter(c => c.x >= REVENUE_BOX_MIN_X);
      for (const c of rightCells) boxTokens.push(c.text);
      if (leftCells.length > 0) {
        const metaRow = leftCells.map(c => c.text);
        const key = metaRow[0].toLowerCase().replace(/:$/, '').trim();
        if (key === 'von') vonRaw = metaRow[1] ?? '';
        if (key === 'bis') bisRaw = metaRow[1] ?? '';
        rows.push(metaRow);
      }
      continue;
    }

    // Zeitabschnitte: eigene Auswertung, Zeilen NICHT an den Kern
    if (inZeitabschnitte) {
      if (hourlyEnded) continue;
      const label = firstCell.text.trim();
      if (/^gesamt$/i.test(label)) {
        const nums = line.cells.slice(1).map(c => c.text);
        const pctCell = nums.length > 0 && /%\s*$/.test(nums[nums.length - 1]) ? nums.pop() : null;
        void pctCell;
        const totalCell = nums.pop();
        hourlyTotal = totalCell !== undefined ? parseSwissNumber(normalizeGnMoneyCell(totalCell)) : null;
        hourlyEnded = true;
        continue;
      }
      if (isHourLabel(label)) {
        const nums = line.cells.slice(1).map(c => c.text);
        let sharePct: number | null = null;
        if (nums.length > 0 && /%\s*$/.test(nums[nums.length - 1])) {
          sharePct = parseSwissNumber(nums.pop()!.replace(/%\s*$/, ''));
        }
        const totalCell = nums.pop();
        if (totalCell !== undefined) {
          hourlyRows.push({
            label,
            hour: Number.parseInt(label, 10),
            totalAmount: parseSwissNumber(normalizeGnMoneyCell(totalCell)),
            sharePct,
          });
        }
        continue;
      }
      continue; // Kopfzeile «Abschnitt … Gesamt Anteil» u. Ä.
    }

    // Normale Datenzeile einer Sektion
    const row = cellsToRow(line.cells);

    // Synthetische Kopfzeile injizieren, wenn die Sektion ohne Kopf startet
    if (awaitingFirstDataRow) {
      awaitingFirstDataRow = false;
      if (!looksLikeColumnHeaderRow(row)) {
        rows.push(['Name', 'Anzahl', 'Betrag']);
      }
    }

    // Parent/Child-Zahlarten: eingerückte Kinder NIE doppelt zählen
    if (currentSection === 'Bezahlarten') {
      if (paymentBaseX === null) paymentBaseX = firstCell.x;
      if (firstCell.x > paymentBaseX + CHILD_INDENT_PX) {
        providers.push({
          parent: lastPaymentParent ?? '',
          name: row[0],
          count: parseInt(row[1] ?? '0', 10) || 0,
          amount: parseSwissNumber(row[2] ?? ''),
        });
        continue; // nicht an den Kern
      }
      if (/\d/.test(row[1] ?? '') || /\d/.test(row[2] ?? '')) {
        lastPaymentParent = row[0];
      }
    }

    // Aufladung Kundenkarten: zusätzlich separat erfassen
    if (currentSection === 'Aufladung Kundenkarten') {
      const entry = {
        name: row[0],
        count: parseInt(row[1] ?? '0', 10) || 0,
        amount: parseSwissNumber(row[2] ?? ''),
      };
      if (/^total$/i.test(entry.name)) {
        topupTotal = { count: entry.count, amount: entry.amount };
      } else if (entry.name && /\d/.test(row[2] ?? row[1] ?? '')) {
        topups.push(entry);
      }
    }

    rows.push(row);
  }

  // ── Umsatzbox → synthetische «Umsatz»-Sektion ──────────────────────────────
  const boxEntries: Array<{ label: string; value: number }> = [];
  {
    let pendingLabel: string | null = null;
    for (const token of boxTokens) {
      const normalized = normalizeGnMoneyCell(token);
      const isMoney = normalized !== token.trim() && normalized !== '';
      if (isMoney && pendingLabel !== null) {
        boxEntries.push({ label: pendingLabel, value: parseSwissNumber(normalized) });
        pendingLabel = null;
      } else if (!isMoney) {
        pendingLabel = token;
      }
    }
  }
  const umsatzRows: string[][] = [];
  for (const e of boxEntries) {
    const l = e.label.toLowerCase();
    if (l.startsWith('total')) {
      umsatzRows.push(['Gesamtumsatz inkl. Kundenkarten-Aufladung', String(e.value)]);
    } else if (l.includes('exkl')) {
      umsatzRows.push(['exkl. Kundenkarten-Aufladung', String(e.value)]);
    }
  }
  if (umsatzRows.length > 0) {
    // Vor der ersten echten Sektion einfügen: Meta-Zeilen bleiben Header-Zeilen.
    const firstSectionIdx = rows.findIndex(r => r.length === 1 && matchSectionName(r[0]) !== null);
    const insertAt = firstSectionIdx >= 0 ? firstSectionIdx : rows.length;
    rows.splice(insertAt, 0, ['Umsatz'], ...umsatzRows);
  }

  // ── Kern aufrufen (EINZIGE Sektions-/KPI-Logik, identisch zu CSV) ──────────
  const parsed = parseGnZBerichtFromRows(rows, {
    fileName,
    checksum,
    sourceFormat: 'pdf',
    delimiterLabel: 'PDF',
    delimCounts: { semicolon: 0, comma: 0, tab: 0 },
    rawLines: lines.map(l => l.text),
    verboseConsole: false,
  });

  // ── PDF-Zusatzfelder ───────────────────────────────────────────────────────
  const von = vonRaw ? parseGermanStamp(vonRaw) : null;
  const bis = bisRaw ? parseGermanStamp(bisRaw) : null;

  parsed.periodFromTime = von?.time ?? null;
  parsed.periodToTime = bis?.time ?? null;
  if (vonRaw && bisRaw) parsed.periodRaw = `${vonRaw} – ${bisRaw}`;

  // Geschäftstagsregel (nur mit vollständigen Von/Bis-Angaben)
  parsed.businessDay = null;
  if (von && bis) {
    const spanHours = (bis.date.getTime() - von.date.getTime()) / 3_600_000;
    if (spanHours >= 0 && spanHours <= BUSINESS_DAY_MAX_HOURS) {
      let businessDay = bis.iso;
      if (bis.time !== null && Number.parseInt(bis.time, 10) < BUSINESS_DAY_CUTOFF_HOUR && bis.iso !== von.iso) {
        businessDay = von.iso; // Nachtabschluss kurz nach Mitternacht → Von-Tag
      }
      parsed.businessDay = businessDay;
      parsed.periodFrom = businessDay;
      parsed.periodTo = businessDay;
    }
  }

  parsed.hourlyRevenue = hourlyRows.length > 0 ? hourlyRows : null;
  parsed.hourlyRevenueTotal = hourlyTotal;
  parsed.customerCardTopups = topups.length > 0 ? topups : null;
  parsed.customerCardTopupTotal = topupTotal?.amount ?? null;
  parsed.paymentMethodProviders = providers.length > 0 ? providers : null;

  if (zeitabschnitteSeen && hourlyRows.length === 0) {
    parsed.warnings.push('Abschnitt Zeitabschnitte erkannt, aber Gesamtspalte konnte nicht gelesen werden.');
  }
  if (kindInfo.isExtendedHint && parsed.reportType !== 'extended') {
    parsed.warnings.push('Erweiterter Z-Bericht erkannt, jedoch keine Produktpositionen gefunden.');
  }

  // ── Plausibilitätsprüfung ──────────────────────────────────────────────────
  parsed.validation = buildGnZBerichtPdfValidation(parsed);

  return parsed;
}

// ── Plausibilitätsprüfung ─────────────────────────────────────────────────────

function statusForDiff(diff: number): GnValidationStatus {
  const abs = Math.abs(diff);
  if (abs <= TOL_PLAUSIBLE) return 'plausibel';
  if (abs <= TOL_ROUNDING) return 'rundungsdifferenz';
  return 'abweichung';
}

function makeCheck(
  id: string,
  label: string,
  expected: number | null,
  actual: number | null,
  note?: string,
): GnValidationCheck {
  if (expected === null || actual === null) {
    return { id, label, expected, actual, diff: null, status: 'unvollstaendig', note };
  }
  const diff = actual - expected;
  return { id, label, expected, actual, diff, status: statusForDiff(diff), note };
}

const STATUS_RANK: Record<GnValidationStatus, number> = {
  plausibel: 0,
  rundungsdifferenz: 1,
  unvollstaendig: 2,
  abweichung: 3,
};

/**
 * 8 Summenabgleiche gemäss Auftrag — Rohwerte, Toleranzen 0.05/2.00 CHF.
 * Fehlende Vergleichsseiten ⇒ «unvollstaendig», nie stille 0-Annahme.
 */
export function buildGnZBerichtPdfValidation(p: GnParsedZBericht): GnValidationResult {
  const total = p.revenue.totalGross > 0 ? p.revenue.totalGross : null;
  const checks: GnValidationCheck[] = [];

  // 1. Steuer-Brutto-Total gegen Berichtstotal
  const taxGross = p.taxes.length > 0 ? p.taxes.reduce((s, t) => s + t.grossAmount, 0) : null;
  checks.push(makeCheck('steuer_total', 'Steuer-Brutto gegen Berichtstotal', total, taxGross));

  // 2. Summe Kostenstellen gegen Berichtstotal
  const ccSum = p.costCenters.length > 0 ? p.costCenters.reduce((s, c) => s + c.amount, 0) : null;
  checks.push(makeCheck('kostenstellen', 'Kostenstellen gegen Berichtstotal', total, ccSum));

  // 3. Summe Zahlarten gegen Berichtstotal
  const pmSum = p.paymentMethods.length > 0 ? p.paymentMethods.reduce((s, m) => s + m.amount, 0) : null;
  checks.push(makeCheck('zahlarten', 'Zahlarten gegen Berichtstotal', total, pmSum));

  // 4. Hauptwarengruppen + Rabatte + Kundenkarten-Aufladung gegen Berichtstotal
  //    (Warengruppenbeträge sind NACH Positionsrabatten, VOR Bestellrabatten.)
  if (p.productGroups.length > 0) {
    const pgSum = p.productGroups.reduce((s, g) => s + g.amount, 0);
    const rabattSum = p.discounts.filter(d => d.type === 'rabatt').reduce((s, d) => s + d.amount, 0);
    const topup = p.customerCardTopupTotal ?? 0;
    checks.push(makeCheck(
      'hauptwarengruppen',
      'Hauptwarengruppen + Rabatte + Aufladung gegen Berichtstotal',
      total,
      pgSum + rabattSum + topup,
    ));
  } else {
    checks.push(makeCheck('hauptwarengruppen', 'Hauptwarengruppen + Rabatte + Aufladung gegen Berichtstotal', total, null));
  }

  // 5. Inner Haus + Ausser Haus gegen Hauptwarengruppe (nur erweiterter Bericht)
  if (p.extendedData && p.extendedData.mainCategoriesByConsumptionType.length > 0) {
    const byName = new Map<string, number>();
    for (const e of p.extendedData.mainCategoriesByConsumptionType) {
      byName.set(e.name, (byName.get(e.name) ?? 0) + e.grossAmount);
    }
    let worstDiff = 0;
    let compared = 0;
    for (const g of p.productGroups) {
      const split = byName.get(g.name);
      if (split === undefined) continue;
      compared++;
      const diff = split - g.amount;
      if (Math.abs(diff) > Math.abs(worstDiff)) worstDiff = diff;
    }
    if (compared > 0) {
      checks.push({
        id: 'inner_ausser',
        label: 'Inner + Ausser Haus gegen Hauptwarengruppe',
        expected: 0,
        actual: worstDiff,
        diff: worstDiff,
        status: statusForDiff(worstDiff),
        note: `${compared} Hauptwarengruppen verglichen (grösste Abweichung).`,
      });
    } else {
      checks.push(makeCheck('inner_ausser', 'Inner + Ausser Haus gegen Hauptwarengruppe', null, null,
        'Keine übereinstimmenden Gruppennamen gefunden.'));
    }
  }

  // 6. Summe Stundenumsätze gegen Berichtstotal
  if (p.hourlyRevenue && p.hourlyRevenue.length > 0) {
    const hourlySum = p.hourlyRevenue.reduce((s, h) => s + h.totalAmount, 0);
    checks.push(makeCheck('zeitabschnitte', 'Stundenumsätze gegen Berichtstotal', total, hourlySum));
  }

  // 7. Zahlungskonten gegen Zahlarten
  const paSum = p.paymentAccounts.length > 0 ? p.paymentAccounts.reduce((s, a) => s + a.grossAmount, 0) : null;
  if (paSum !== null || pmSum !== null) {
    checks.push(makeCheck('zahlungskonten', 'Zahlungskonten gegen Zahlarten', pmSum, paSum));
  }

  // 8. Buchungskonten gegen Berichtstotal (Brutto inkl. negativer Korrekturen)
  const acctSum = p.accountingLines.length > 0 ? p.accountingLines.reduce((s, a) => s + a.grossAmount, 0) : null;
  if (acctSum !== null) {
    checks.push(makeCheck('buchungskonten', 'Buchungskonten gegen Berichtstotal', total, acctSum));
  }

  const worst = checks.reduce<GnValidationStatus>(
    (acc, c) => (STATUS_RANK[c.status] > STATUS_RANK[acc] ? c.status : acc),
    'plausibel',
  );
  return { status: worst, checks };
}
