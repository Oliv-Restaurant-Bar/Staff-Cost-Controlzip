/**
 * warenkosten-export – Excel-Export der Warenkosten für einen Zeitraum
 * ====================================================================
 * Zwei Teile:
 *   1) `buildWarenkostenExport` – REINE Datenaufbereitung (DOM-/Supabase-frei,
 *      synthetisch testbar): erzeugt Rechnungs-Detailzeilen + Summenblock.
 *   2) `exportWarenkostenToExcel` – dünner exceljs-Builder (IO), lädt exceljs
 *      per dynamischem Import und stösst den Datei-Download an.
 *
 * SINGLE SOURCE OF TRUTH: Die WKQ stammt aus `berechneWarenrechnungsWkq`
 * (zählende Belege, Netto 4020–4070 / kanonischer Netto-Umsatz).
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
  type WarenKategorie,
  type WarenkostenEntryInput,
} from './warenkosten-quote';
import { zaehlendeEintraege } from './waren-monatsabgleich';
import { berechneWarenrechnungsWkq, isoWeekKeyOf, weekLabelOf } from './waren-analyse';
import type { InvoiceEntry } from './waren-db';

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

/** Summenzeile eines Summenblocks (pro Lieferant / Konto / Woche). */
export interface WarenkostenSumRow {
  label: string;
  totalNet: number;
  totalGross: number;
  count: number;
}

export interface WarenkostenExportData {
  rows: WarenkostenExportRow[];
  summary: WarenkostenExportSummary;
  /** Summenblöcke: Total pro Lieferant (Top zuerst), pro Konto, pro Woche (chronologisch). */
  bySupplier: WarenkostenSumRow[];
  byKonto: WarenkostenSumRow[];
  byWeek: WarenkostenSumRow[];
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
 * Baut den Dateinamen `Warenkosten_<Mandant>_<yyyy-MM>.xlsx` (Ein-Monats-
 * Zeitraum); sonst `Warenkosten_<Mandant>_<from>_bis_<to>.xlsx`, damit der
 * Name eindeutig bleibt. Mandantenname wird dateisystem-sicher bereinigt.
 */
export function warenkostenExportFileName(from: string, to: string, tenantName = ''): string {
  const tenant = tenantName.trim().replace(/[^A-Za-z0-9ÄÖÜäöüß-]+/g, '');
  const prefix = tenant ? `Warenkosten_${tenant}` : 'Warenkosten';
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  if (fy && fm && fy === ty && fm === tm) {
    return `${prefix}_${fy}-${fm}.xlsx`;
  }
  return `${prefix}_${from}_bis_${to}.xlsx`;
}

/** Summenblock über eine Schlüsselfunktion; sortiert nach sort. */
function sumBlock(
  invoices: WarenkostenExportInvoice[],
  keyOf: (inv: WarenkostenExportInvoice) => string,
  sort: 'desc' | 'chrono',
  labelOf: (key: string) => string = k => k,
): WarenkostenSumRow[] {
  const map = new Map<string, { net: number; gross: number; count: number }>();
  for (const inv of invoices) {
    const k = keyOf(inv);
    const cur = map.get(k) ?? { net: 0, gross: 0, count: 0 };
    cur.net += inv.amountNet ?? 0;
    cur.gross += inv.amountGross ?? 0;
    cur.count += 1;
    map.set(k, cur);
  }
  const rows = [...map.entries()].map(([k, v]) => ({
    key: k, label: labelOf(k), totalNet: v.net, totalGross: v.gross, count: v.count,
  }));
  if (sort === 'chrono') rows.sort((a, b) => a.key.localeCompare(b.key));
  else rows.sort((a, b) => b.totalNet - a.totalNet);
  return rows.map(({ key: _key, ...rest }) => rest);
}

/**
 * REINE Aufbereitung: erzeugt sortierte Detailzeilen + Summenblock.
 * Sortierung: Datum aufsteigend, dann Lieferant alphabetisch.
 */
export function buildWarenkostenExport(input: WarenkostenExportInput): WarenkostenExportData {
  const invoices = zaehlendeEintraege(input.invoices);
  const rows: WarenkostenExportRow[] = invoices
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

  const totals = computeWarenkostenTotals(invoices);
  const totalGross = invoices.reduce((s, e) => s + (e.amountGross ?? 0), 0);
  const wkq = berechneWarenrechnungsWkq(invoices as unknown as InvoiceEntry[], input.revenue);

  const summary: WarenkostenExportSummary = {
    foodNet: totals.foodNet,
    beverageNet: totals.beverageNet,
    relevantNet: wkq.directNet,
    sonstigeNet: totals.sonstigeNet,
    totalNet: totals.totalNet,
    totalGross,
    revenue: input.revenue,
    quotePct: wkq.pct,
  };

  // Summenblöcke: pro Lieferant (Top-Betrag zuerst), pro Konto, pro Woche.
  const bySupplier = sumBlock(invoices, inv => inv.supplierName.trim() || '—', 'desc');
  const byKonto = sumBlock(invoices, inv => warenkontoDisplay(inv) || 'Ohne Konto', 'desc');
  const byWeek = sumBlock(invoices, inv => isoWeekKeyOf(inv.date), 'chrono', weekLabelOf);

  return {
    rows,
    summary,
    bySupplier,
    byKonto,
    byWeek,
    periodLabel: input.periodLabel,
    tenantName: input.tenantName,
    from: input.from,
    to: input.to,
    fileName: warenkostenExportFileName(input.from, input.to, input.tenantName),
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

  // ── Summenblöcke: pro Lieferant / Konto / Woche ───────────────────────────
  function sumBlockSection(title: string, rows2: WarenkostenSumRow[]) {
    if (rows2.length === 0) return;
    ws.addRow([]);
    const t = ws.addRow(['', '', '', title]);
    t.getCell(4).font = { bold: true, size: 10, color: { argb: 'FF' + HEADER_BG } };
    const h = ws.addRow(['', '', '', '', 'Netto CHF', 'Brutto CHF', 'Rechn.']);
    [5, 6, 7].forEach(c => {
      h.getCell(c).font = { bold: true, size: 8, color: { argb: 'FF' + MUTED_FG } };
      h.getCell(c).alignment = { horizontal: 'right' };
    });
    for (const r of rows2) {
      const row = ws.addRow(['', '', '', r.label, r.totalNet, r.totalGross, r.count]);
      row.getCell(4).font = { size: 9 };
      row.getCell(4).alignment = { horizontal: 'left' };
      [5, 6].forEach(c => {
        row.getCell(c).numFmt = CHF_FMT;
        row.getCell(c).alignment = { horizontal: 'right' };
        row.getCell(c).font = { size: 9 };
      });
      row.getCell(7).alignment = { horizontal: 'right' };
      row.getCell(7).font = { size: 9, color: { argb: 'FF' + MUTED_FG } };
    }
    const tot = ws.addRow(['', '', '', 'Total',
      rows2.reduce((s2, r) => s2 + r.totalNet, 0),
      rows2.reduce((s2, r) => s2 + r.totalGross, 0),
      rows2.reduce((s2, r) => s2 + r.count, 0)]);
    [4, 5, 6, 7].forEach(c => {
      tot.getCell(c).font = { bold: true, size: 9 };
      tot.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + TOTAL_BG } };
      if (c >= 5 && c <= 6) tot.getCell(c).numFmt = CHF_FMT;
      tot.getCell(c).alignment = { horizontal: c === 4 ? 'left' : 'right' };
    });
  }
  sumBlockSection('Total pro Lieferant', data.bySupplier);
  sumBlockSection('Total pro Konto', data.byKonto);
  sumBlockSection('Total pro Woche', data.byWeek);

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
