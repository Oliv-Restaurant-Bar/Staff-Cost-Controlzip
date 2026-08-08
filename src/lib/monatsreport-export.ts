/**
 * Cockpit — Excel-Export (.xlsx) der Report-Tabelle je Granularität.
 * DIESELBE Datenquelle wie die Bildschirmtabelle (MrRow), nur andere Felder:
 *  - 'monat': Budget = monthBudget, Vorjahr = vjMonth, Ist = month
 *  - 'woche': Budget = budget (Woche), Vorjahr = vj (Woche), Ist = week
 * Spalten: Kennzahl | Budget | Vorjahr | Ist | Δ %.
 * Schweizer Zahlenformat (1'234.56), Prozente als % mit einer Nachkommastelle.
 * Δ%-Färbung invertiert bei Kosten (deltaInverted); Ist-Wert rot bei warnAbove.
 */
import ExcelJS from 'exceljs';
import type { MrRow, MonatsreportDaten, WarenExportPeriod } from '@/lib/monatsreport';

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const FMT_CHF = "#'##0.00";
const FMT_COUNT = "#'##0";
const FMT_PCT = '0.0" %"';

/** Granularität des Exports (spiegelt den aktiven Cockpit-Tab). */
export type ExportGranularity = 'monat' | 'woche';

/** Aufbereitete Zellwerte einer Zeile für den Export (rein, ohne ExcelJS). */
export interface ExportCell {
  budget: number | null;
  vj: number | null;
  ist: number | null;
  /** Δ% (Ist vs. Budget der jeweiligen Granularität), null wenn nicht bestimmbar. */
  dev: number | null;
  /** Δ absolut (gleiche Basis wie dev); CHF bzw. PP bei Quoten. */
  devAbs: number | null;
  /** true → Ist-Wert rot (warnAbove überschritten). */
  istWarn: boolean;
  /** true → Δ% grün, false → rot (berücksichtigt deltaInverted). */
  devGut: boolean | null;
  /** Begleit-«Personen» für fmt='countPax' (Anzeige «Anzahl (Σ Personen)»). */
  vjPax: number | null;
  istPax: number | null;
  /** Anteil an Gäste IN in % (reservierte Gäste / Gruppen ab 20); null ohne Basis. */
  vjShare: number | null;
  istShare: number | null;
}

/**
 * Wählt je Granularität die passenden Felder derselben `MrRow` und berechnet
 * Δ% + Färb-Flags — identisch zur Bildschirmtabelle. Rein & testbar (canvas-frei).
 */
export function mapRowForExport(row: MrRow, granularity: ExportGranularity): ExportCell {
  const budget = granularity === 'monat' ? row.monthBudget : row.budget;
  const vj = granularity === 'monat' ? row.vjMonth : row.vj;
  const ist = granularity === 'monat' ? row.month : row.week;
  const devBudget = granularity === 'monat' ? row.monthBudget : row.weekBudget;
  // Δ-Basis wie die Bildschirmtabelle: Zeilen mit VJ-Vergleich (deltaVsVj/
  // sharePct) rechnen Ist − Vorjahr, alle übrigen Ist − Budget. Nie ÷ 0.
  const vsVj = !!(row.deltaVsVj || row.sharePct);
  const devBase = vsVj ? vj : devBudget;
  const devAbs = ist !== null && devBase !== null ? ist - devBase : null;
  const dev = ist !== null && devBase !== null && devBase > 0
    ? ((ist - devBase) / devBase) * 100 : null;
  const istWarn = row.warnAbove != null && ist !== null && ist > row.warnAbove;
  // Kosten-Zeilen (deltaInverted): über Budget (dev>0) = schlecht/rot.
  const devGut = dev === null ? null : (row.deltaInverted ? dev <= 0 : dev >= 0);
  const vjPax = granularity === 'monat' ? (row.vjMonthPax ?? null) : null;
  const istPax = granularity === 'monat' ? (row.monthPax ?? null) : (row.weekPax ?? null);
  // Anteile an Gäste IN — identische Feldwahl wie die Bildschirmtabelle.
  const istShare = (granularity === 'monat' ? row.sharePct?.month : row.sharePct?.week) ?? null;
  const vjShare = (granularity === 'monat' ? row.sharePct?.vjMonth : row.sharePct?.vj) ?? null;
  return { budget, vj, ist, dev, devAbs, istWarn, devGut, vjPax, istPax, vjShare, istShare };
}

/**
 * Eindeutiger Vorjahres-Spaltentitel mit DYNAMISCHEM Jahr (JJJJ−1), damit Ist
 * und Vorjahr im Export nicht verwechselt werden. Fehlt das Jahr → schlichtes
 * «Vorjahr» (Rückwärtskompatibilität).
 */
export function vjColumnHeader(
  granularity: ExportGranularity, year?: number,
): string {
  if (year == null || !Number.isFinite(year)) return 'Vorjahr';
  const kind = granularity === 'monat' ? 'Monat' : 'Woche';
  return `Vorjahr (${kind} ${year - 1})`;
}

/**
 * «Anzahl (Σ Personen · Anteil %)»-Text für fmt='countPax'; null → leer.
 * Gleiches Format wie die Bildschirmtabelle: «8 (255 Pers. · 1.8 %)»;
 * ohne Gäste-IN-Basis (share=null) nur «8 (255 Pers.)».
 */
function countPaxText(count: number | null, pax: number | null, share: number | null): string {
  if (count === null || count === undefined) return '';
  const c = Math.round(count).toLocaleString('de-CH');
  if (pax === null || pax === undefined) return c;
  const p = Math.round(pax).toLocaleString('de-CH');
  return share !== null && share !== undefined
    ? `${c} (${p} Pers. · ${share.toFixed(1)} %)`
    : `${c} (${p} Pers.)`;
}

/**
 * Baut die Arbeitsmappe (ohne Download-Seiteneffekt) — rein & testbar.
 * Zieht je Granularität dieselben Felder wie die Bildschirmtabelle.
 */
export function buildMonatsreportWorkbook(
  rows: MrRow[], month: number, granularity: ExportGranularity = 'woche',
  year?: number,
): ExcelJS.Workbook {
  const istHeader = granularity === 'monat' ? 'Ist (Monat)' : 'Woche';
  // Eindeutiger Vorjahres-Spaltentitel mit DYNAMISCHEM Jahr (Ist ≠ Vorjahr).
  const vjHeader = vjColumnHeader(granularity, year);
  const sheetName = granularity === 'monat'
    ? `Monatsübersicht ${MONATE[month - 1]}`
    : `Wochenübersicht ${MONATE[month - 1]}`;

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = [
    { width: 34 }, { width: 15 }, { width: 15 }, { width: 15 }, { width: 13 },
  ];

  // Kopfzeile
  const head = ws.addRow([
    `${granularity === 'monat' ? 'Monat' : 'Woche'} ${MONATE[month - 1]}`,
    'Budget', vjHeader, istHeader, 'Δ',
  ]);
  head.font = { bold: true };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFA0A0A0' } } };
  });
  for (let i = 2; i <= 5; i++) head.getCell(i).alignment = { horizontal: 'right' };

  for (const row of rows) {
    if (row.type === 'empty') { ws.addRow([]); continue; }

    // Felder je Granularität (identisch zur Bildschirm-Ansicht ReportTable).
    const c = mapRowForExport(row, granularity);

    // Darstellung wie am Bildschirm (Anteil-Zeilen):
    //  - Zahl gross, Anteil als zweite Zeile in derselben Zelle — Ist z.B.
    //    «1'735⏎18.3 % Anteil Gäste IN», Vorjahr «1'618⏎11.2 %».
    //  - Gruppen (countPax): Personenzahl bleibt in Klammern bei der Zahl.
    //  - Δ%-Spalte = Veränderung Ist vs. Vorjahr (c.dev, s. mapRowForExport).
    //  - Ohne Basis (share=null) keine Anteil-Zeile.
    const isCountPax = row.fmt === 'countPax';
    const isShareRow = row.sharePct !== undefined;
    const shareLineIst = isShareRow && c.ist !== null && c.istShare !== null
      ? `\n${c.istShare.toFixed(1)} % ${row.shareHint ?? 'Anteil Gäste IN'}` : '';
    const shareLineVj = isShareRow && c.vj !== null && c.vjShare !== null
      ? `\n${c.vjShare.toFixed(1)} %` : '';
    const vjBase = isCountPax ? countPaxText(c.vj, c.vjPax, null)
      : c.vj !== null ? Math.round(c.vj).toLocaleString('de-CH') : '';
    const istBase = isCountPax ? countPaxText(c.ist, c.istPax, null)
      : c.ist !== null ? Math.round(c.ist).toLocaleString('de-CH') : '';
    // Nur bei vorhandenem Anteil wird die Zelle zum zweizeiligen Text — sonst
    // bleibt sie numerisch (Zahlenformat/Filter in Excel intakt).
    const vjIsShareText = isShareRow && shareLineVj !== '';
    const istIsShareText = isShareRow && shareLineIst !== '';
    const vjOut = isCountPax ? `${vjBase}${shareLineVj}`
      : vjIsShareText ? `${vjBase}${shareLineVj}` : c.vj;
    const istOut = isCountPax ? `${istBase}${shareLineIst}`
      : istIsShareText ? `${istBase}${shareLineIst}` : c.ist;
    // Kombinierte Δ-Zelle wie am Bildschirm: Hauptwert = absolute Veränderung
    // (CHF, bzw. PP bei Quoten-Zeilen), darunter der Prozentwert (nicht bei
    // Quoten — dort IST der PP-Wert die Aussage). Leer statt 0.
    const isPctRow = row.fmt === 'pct' || !!row.deltaPp;
    const fmtAbs = (v: number): string => row.fmt === 'count' || row.fmt === 'hours' || row.fmt === 'countPax'
      ? Math.round(Math.abs(v)).toLocaleString('de-CH')
      : Math.abs(v).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const devOut = c.devAbs === null ? null
      : isPctRow
        ? `${c.devAbs >= 0 ? '+' : ''}${c.devAbs.toFixed(1)} PP`
        : `${c.devAbs >= 0 ? '+' : '−'}${fmtAbs(c.devAbs)}`
          + (c.dev !== null ? `\n${c.dev >= 0 ? '+' : ''}${c.dev.toFixed(1)} %` : '');

    const r = ws.addRow([row.label ?? '', c.budget, vjOut, istOut, devOut]);

    const numFmt = row.fmt === 'count' || row.fmt === 'hours' ? FMT_COUNT
      : row.fmt === 'pct' ? FMT_PCT
      : FMT_CHF;
    for (const col of [2, 3, 4]) {
      const cell = r.getCell(col);
      // Text-Zellen (countPax bzw. count mit Anteil, Spalten 3/4) — kein Zahlenformat.
      const isText = (col === 3 && (isCountPax || vjIsShareText))
        || (col === 4 && (isCountPax || istIsShareText));
      if (!isText) cell.numFmt = numFmt;
      // Anteil-Unterzeile: zweizeilige Zelle → Zeilenumbruch aktivieren.
      const wrap = (col === 3 && vjIsShareText) || (col === 4 && istIsShareText);
      cell.alignment = { horizontal: 'right', ...(wrap ? { wrapText: true } : {}) };
    }
    // Schwellen-Rot (warnAbove, z.B. PKQ > 40 %) für den Ist-Wert (Spalte 4).
    if (c.istWarn) {
      r.getCell(4).font = { color: { argb: 'FFC00000' }, bold: true };
    }
    // Δ%-Spalte (5): Kosten-Zeilen (deltaInverted) → über Budget (>0) = rot.
    // Anteil-Zeilen: Veränderung Ist vs. Vorjahr — grün/rot wie übrige Zeilen.
    const devCell = r.getCell(5);
    devCell.alignment = { horizontal: 'right', wrapText: true };
    if (c.devGut !== null) {
      devCell.font = { color: { argb: c.devGut ? 'FF196B24' : 'FFC00000' } };
    }
    // Fett pro Zelle mergen — r.font = {bold} würde die gesetzten Zellfarben
    // (istWarn / Δ%-Färbung) der ganzen Zeile überschreiben.
    if (row.bold) {
      for (let col = 1; col <= 5; col++) {
        const cell = r.getCell(col);
        cell.font = { ...(cell.font ?? {}), bold: true };
      }
    }
  }

  return wb;
}

/**
 * Zweites Tabellenblatt «Warenkosten»: Lieferanten-Aufstellung der Periode
 * (Lieferant | Betrag netto | Anteil vom Umsatz | Anzahl Rechnungen) plus
 * «Warenkosten total» und WKQ. Anteil = Lieferant ÷ Netto-Umsatz der Periode
 * (die Anteile summieren sich zur Gesamt-WKQ); ohne Umsatz bleibt die
 * Anteil-/WKQ-Spalte leer (nie durch 0 teilen). CH-Zahlenformat.
 */
export function addWarenkostenSheet(
  wb: ExcelJS.Workbook, waren: WarenExportPeriod, zielWkq: number | null,
  periodTitle: string,
): void {
  const ws = wb.addWorksheet('Warenkosten', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 12 }];

  const title = ws.addRow([`Warenkosten ${periodTitle}`]);
  title.font = { bold: true };

  const head = ws.addRow(['Lieferant', 'Betrag (CHF netto)', 'Anteil vom Umsatz', 'Rechnungen']);
  head.font = { bold: true };
  head.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFA0A0A0' } } };
  });
  for (let i = 2; i <= 4; i++) head.getCell(i).alignment = { horizontal: 'right' };

  const rev = waren.revenue;
  const share = (net: number): number | null => (rev != null && rev > 0 ? (net / rev) * 100 : null);

  for (const s of waren.suppliers) {
    const r = ws.addRow([s.name, s.net, share(s.net), s.count]);
    r.getCell(2).numFmt = FMT_CHF;
    r.getCell(3).numFmt = FMT_PCT;
    r.getCell(4).numFmt = FMT_COUNT;
    for (let i = 2; i <= 4; i++) r.getCell(i).alignment = { horizontal: 'right' };
  }

  const totalCount = waren.suppliers.reduce((a, s) => a + s.count, 0);
  const wkq = share(waren.total);
  const total = ws.addRow(['Warenkosten total', waren.total, wkq, totalCount]);
  total.font = { bold: true };
  total.getCell(2).numFmt = FMT_CHF;
  total.getCell(3).numFmt = FMT_PCT;
  total.getCell(4).numFmt = FMT_COUNT;
  for (let i = 2; i <= 4; i++) total.getCell(i).alignment = { horizontal: 'right' };
  total.eachCell(c => { c.border = { top: { style: 'thin', color: { argb: 'FFA0A0A0' } } }; });
  // WKQ über Ziel = rot, sonst grün (gleiche Ampel wie im Cockpit).
  if (wkq != null && zielWkq != null) {
    total.getCell(3).font = { bold: true, color: { argb: wkq <= zielWkq ? 'FF196B24' : 'FFC00000' } };
  }


  const foot = ws.addRow(['WKQ = Warenkosten ÷ Netto-Umsatz der Periode'
    + (rev != null ? ` (CHF ${rev.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ' — kein Umsatz importiert')
    + (zielWkq != null ? ` · Ziel-WKQ ${zielWkq.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %` : '')]);
  foot.font = { italic: true, size: 9, color: { argb: 'FF808080' } };
}

export async function exportMonatsreportXlsx(
  rows: MrRow[], year: number, month: number, granularity: ExportGranularity = 'woche',
  waren?: MonatsreportDaten['waren'],
): Promise<void> {
  const wb = buildMonatsreportWorkbook(rows, month, granularity, year);
  // Zweites Blatt «Warenkosten» (Lieferanten-Aufstellung der Periode).
  const periode = granularity === 'monat' ? waren?.monat : waren?.woche;
  if (waren && periode) {
    addWarenkostenSheet(wb, periode, waren.zielWkq ?? null,
      granularity === 'monat' ? `${MONATE[month - 1]} ${year}` : `Woche (${MONATE[month - 1]} ${year})`);
  }
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cockpit-${granularity === 'monat' ? 'monatsuebersicht' : 'wochenuebersicht'}-${year}-${String(month).padStart(2, '0')}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
