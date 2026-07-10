/**
 * warenkosten-export – Excel-Export der Warenkosten für einen Zeitraum
 * ====================================================================
 * Zwei Teile:
 *   1) `buildWarenkostenExport` – REINE Datenaufbereitung (DOM-/Supabase-frei,
 *      synthetisch testbar): erzeugt Rechnungs-Detailzeilen + Summenblock.
 *   2) `exportWarenkostenToExcel` – dünner exceljs-Builder (IO), lädt exceljs
 *      per dynamischem Import und stösst den Datei-Download an.
 *
 * SINGLE SOURCE OF TRUTH: Kategorie-Zuordnung, relevante Warenkosten und
 * Warenkostenquote stammen AUSSCHLIESSLICH aus `warenkosten-quote`
 * (Food+Beverage = relevant, Sonstiges separat, NIE in der Quote).
 *
 * Zahlenformate: Schweizer Darstellung über exceljs-`numFmt`
 * (CHF `#,##0.00`, Prozent `0.0"%"`). Die reine Lib rundet NICHT.
 *
 * Debug-Logs: keine (reine Lib + dünner IO-Wrapper).
 */

import {
  computeWarenkostenTotals,
  kategorieOf,
  istInQuote,
  warenkostenQuote,
  type WarenKategorie,
  type WarenkostenEntryInput,
} from './warenkosten-quote';

const MONTHS_LONG_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const KATEGORIE_LABEL: Record<WarenKategorie, string> = {
  Food: 'Food',
  Beverage: 'Beverage',
  Sonstiges: 'Sonstiges',
};

// ─── Eingaben ──────────────────────────────────────────────────────────────────

/** Rechnungseintrag wie er in den Export einfliesst. */
export interface WarenkostenExportInvoice extends WarenkostenEntryInput {
  date: string;          // YYYY-MM-DD
  supplierName: string;
  amountGross: number;
  reference?: string;
  note?: string;
}

export interface WarenkostenExportInput {
  /** Menschlesbares Zeitraum-Label, z. B. "Juli 2026" / "KW 28 · 2026". */
  periodLabel: string;
  from: string;          // ISO YYYY-MM-DD (inkl.)
  to: string;            // ISO YYYY-MM-DD (inkl.)
  tenantName: string;
  invoices: WarenkostenExportInvoice[];
  /** Umsatzbasis des Zeitraums (Betriebsertrag netto); null = unbekannt. */
  revenue: number | null;
}

// ─── Aufbereitete Daten ─────────────────────────────────────────────────────────

export interface WarenkostenExportRow {
  date: string;
  supplierName: string;
  kategorie: WarenKategorie;
  kategorieLabel: string;
  warenkonto: string;
  amountNet: number;
  amountVat: number;     // Brutto − Netto
  amountGross: number;
  reference: string;
  note: string;
  /** Fliesst dieser Eintrag in die Warenkostenquote ein? (Food/Beverage) */
  imQuote: boolean;
}

export interface WarenkostenExportSummary {
  foodNet: number;
  beverageNet: number;
  /** relevante Warenkosten = Food + Beverage (Basis der Quote) */
  relevantNet: number;
  sonstigeNet: number;
  /** Gesamtsumme inkl. Sonstiges (nur Info, NICHT für die Quote) */
  totalNet: number;
  totalGross: number;
  revenue: number | null;
  /** Warenkostenquote = relevantNet / revenue (Sonstiges ausgeschlossen) */
  quotePct: number | null;
}

export interface WarenkostenExportData {
  rows: WarenkostenExportRow[];
  summary: WarenkostenExportSummary;
  periodLabel: string;
  tenantName: string;
  from: string;
  to: string;
  fileName: string;
}

/**
 * Warenkonto-Anzeige eines Eintrags: primäres Warenkonto oder – bei
 * Kontoaufteilung – die beteiligten Konten. Rein für die Detailspalte.
 */
function warenkontoDisplay(inv: WarenkostenExportInvoice): string {
  const splits = (inv as { kontoSplits?: { warenkonto: string }[] }).kontoSplits;
  if (splits && splits.length > 0) {
    return splits.map(s => s.warenkonto).filter(Boolean).join(' / ');
  }
  return inv.warenkonto ?? '';
}

/**
 * Baut den Dateinamen `Warenkosten_<Monat>_<Jahr>.xlsx`. Umfasst der Zeitraum
 * genau EINEN Kalendermonat, wird der lange Monatsname verwendet; sonst der
 * ISO-Zeitraum (from_bis_to), damit der Name eindeutig bleibt.
 */
export function warenkostenExportFileName(from: string, to: string): string {
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  if (fy && fm && fy === ty && fm === tm) {
    const monthIdx = parseInt(fm, 10) - 1;
    const monthName = MONTHS_LONG_DE[monthIdx] ?? fm;
    return `Warenkosten_${monthName}_${fy}.xlsx`;
  }
  return `Warenkosten_${from}_bis_${to}.xlsx`;
}

/**
 * REINE Aufbereitung: erzeugt sortierte Detailzeilen + Summenblock.
 * Sortierung: Datum aufsteigend, dann Lieferant alphabetisch.
 */
export function buildWarenkostenExport(input: WarenkostenExportInput): WarenkostenExportData {
  const rows: WarenkostenExportRow[] = input.invoices
    .map((inv): WarenkostenExportRow => {
      const kategorie = kategorieOf(inv);
      const net = inv.amountNet ?? 0;
      const gross = inv.amountGross ?? 0;
      return {
        date: inv.date,
        supplierName: inv.supplierName,
        kategorie,
        kategorieLabel: KATEGORIE_LABEL[kategorie],
        warenkonto: warenkontoDisplay(inv),
        amountNet: net,
        amountVat: gross - net,
        amountGross: gross,
        reference: inv.reference ?? '',
        note: inv.note ?? '',
        imQuote: istInQuote(kategorie),
      };
    })
    .sort((a, b) => (a.date === b.date
      ? a.supplierName.localeCompare(b.supplierName, 'de-CH')
      : a.date.localeCompare(b.date)));

  const totals = computeWarenkostenTotals(input.invoices);
  const totalGross = input.invoices.reduce((s, e) => s + (e.amountGross ?? 0), 0);
  const quotePct = warenkostenQuote(totals.relevantNet, input.revenue);

  const summary: WarenkostenExportSummary = {
    foodNet: totals.foodNet,
    beverageNet: totals.beverageNet,
    relevantNet: totals.relevantNet,
    sonstigeNet: totals.sonstigeNet,
    totalNet: totals.totalNet,
    totalGross,
    revenue: input.revenue,
    quotePct,
  };

  return {
    rows,
    summary,
    periodLabel: input.periodLabel,
    tenantName: input.tenantName,
    from: input.from,
    to: input.to,
    fileName: warenkostenExportFileName(input.from, input.to),
  };
}

// ─── Excel-Builder (IO) ─────────────────────────────────────────────────────────

const HEADER_BG = '1E293B';
const HEADER_FG = 'FFFFFF';
const TOTAL_BG = 'F1F5F9';
const TOTAL_FG = '0F172A';
const RELEVANT_BG = 'ECFDF5';
const SONSTIGE_FG = '92400E';
const MUTED_FG = '64748B';
const ALT_BG = 'FAFBFC';

const CHF_FMT = '#,##0.00';
const PCT_FMT = '0.0"%"';

const COLUMNS: { header: string; width: number; align: 'left' | 'right' | 'center'; fmt?: string }[] = [
  { header: 'Datum',      width: 12, align: 'left' },
  { header: 'Lieferant',  width: 28, align: 'left' },
  { header: 'Kategorie',  width: 12, align: 'left' },
  { header: 'Warenkonto', width: 12, align: 'left' },
  { header: 'Netto CHF',  width: 14, align: 'right', fmt: CHF_FMT },
  { header: 'MwSt CHF',   width: 12, align: 'right', fmt: CHF_FMT },
  { header: 'Brutto CHF', width: 14, align: 'right', fmt: CHF_FMT },
  { header: 'In Quote',   width: 10, align: 'center' },
  { header: 'Referenz',   width: 16, align: 'left' },
  { header: 'Notiz',      width: 30, align: 'left' },
];

/**
 * Baut die Excel-Datei und stösst den Download an. Header eingefroren,
 * Autofilter aktiv, Schweizer Zahlenformate, Summenblock am Ende.
 */
export async function exportWarenkostenToExcel(input: WarenkostenExportInput): Promise<void> {
  const data = buildWarenkostenExport(input);
  const ExcelJS = (await import('exceljs')).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Personalkostentracker · Warenkosten';
  wb.created = new Date();

  // Titel (2) + Header (1) = 3 eingefrorene Zeilen.
  const ws = wb.addWorksheet('Warenkosten', { views: [{ state: 'frozen', ySplit: 3 }] });

  ws.addRow([`Warenkosten — ${data.periodLabel}`]);
  const titleRow = ws.getRow(1);
  titleRow.height = 22;
  titleRow.font = { bold: true, size: 13, color: { argb: 'FF' + HEADER_BG } };

  ws.addRow([`${data.tenantName} · ${data.from} – ${data.to}`]);
  ws.getRow(2).font = { italic: true, size: 9, color: { argb: 'FF' + MUTED_FG } };

  // Header
  const hdr = ws.addRow(COLUMNS.map(c => c.header));
  hdr.height = 16;
  hdr.eachCell((cell, col) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + HEADER_BG } };
    cell.font = { bold: true, color: { argb: 'FF' + HEADER_FG }, size: 9 };
    cell.alignment = { horizontal: COLUMNS[col - 1]?.align ?? 'left', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF94A3B8' } } };
  });
  const headerRowNumber = hdr.number;

  // Detailzeilen
  data.rows.forEach((r, idx) => {
    const row = ws.addRow([
      r.date,
      r.supplierName,
      r.kategorieLabel,
      r.warenkonto,
      r.amountNet,
      r.amountVat,
      r.amountGross,
      r.imQuote ? 'Ja' : 'Nein',
      r.reference,
      r.note,
    ]);
    if (idx % 2 === 0) {
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + ALT_BG } }; });
    }
    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.alignment = { horizontal: c.align };
      if (c.fmt) cell.numFmt = c.fmt;
    });
    if (!r.imQuote) {
      row.getCell(3).font = { color: { argb: 'FF' + SONSTIGE_FG } };
      row.getCell(8).font = { color: { argb: 'FF' + SONSTIGE_FG } };
    }
  });

  // Autofilter über die Kopfzeile inkl. Datenbereich
  ws.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + data.rows.length, column: COLUMNS.length },
  };

  // ── Summenblock ────────────────────────────────────────────────────────────
  ws.addRow([]);
  const s = data.summary;

  function summaryRow(label: string, value: number | string | null, opts?: { fmt?: string; strong?: boolean; tone?: 'relevant' | 'sonstige' | 'total' }) {
    const row = ws.addRow(['', '', '', label, value ?? '–']);
    const labelCell = row.getCell(4);
    const valCell = row.getCell(5);
    labelCell.alignment = { horizontal: 'left' };
    valCell.alignment = { horizontal: 'right' };
    if (typeof value === 'number' && opts?.fmt) valCell.numFmt = opts.fmt;
    const bold = opts?.strong ?? false;
    labelCell.font = { bold, size: 9, color: { argb: 'FF' + (opts?.tone === 'sonstige' ? SONSTIGE_FG : TOTAL_FG) } };
    valCell.font = { bold, size: 9, color: { argb: 'FF' + (opts?.tone === 'sonstige' ? SONSTIGE_FG : TOTAL_FG) } };
    if (opts?.tone === 'relevant' || opts?.tone === 'total') {
      [labelCell, valCell].forEach(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (opts.tone === 'relevant' ? RELEVANT_BG : TOTAL_BG) } }; });
    }
    return row;
  }

  summaryRow('Food (netto)', s.foodNet, { fmt: CHF_FMT });
  summaryRow('Beverage (netto)', s.beverageNet, { fmt: CHF_FMT });
  summaryRow('Relevante Warenkosten (Food + Beverage)', s.relevantNet, { fmt: CHF_FMT, strong: true, tone: 'relevant' });
  summaryRow('Sonstiges (nicht in Quote)', s.sonstigeNet, { fmt: CHF_FMT, tone: 'sonstige' });
  summaryRow('Total inkl. Sonstiges (netto)', s.totalNet, { fmt: CHF_FMT, strong: true, tone: 'total' });
  summaryRow('Total brutto', s.totalGross, { fmt: CHF_FMT });
  summaryRow('Umsatz (Betriebsertrag netto)', s.revenue, { fmt: CHF_FMT });
  summaryRow('Warenkostenquote (relevant / Umsatz)', s.quotePct, { fmt: PCT_FMT, strong: true, tone: 'relevant' });

  ws.columns = COLUMNS.map(c => ({ width: c.width }));

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = data.fileName;
  a.click();
  URL.revokeObjectURL(url);
}
