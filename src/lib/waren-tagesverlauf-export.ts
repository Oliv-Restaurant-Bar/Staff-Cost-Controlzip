/**
 * PDF-Export des Tagesverlaufs (Warenkosten-Analyse) — sauberes A4-Hochformat
 * als jsPDF-Vektor (kein Screenshot): Monatskopf, alle Tageszeilen und eine
 * Total-/Endstand-Zeile. Die %-Ampeln (Tages % / Kum. %) werden dezent als
 * Textfarbe übernommen (grün ≤ Ziel, amber ≤ Ziel+2, rot darüber).
 *
 * «Leer statt 0»: Tage ohne Wert zeigen «–», nie 0.00.
 */
import { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';

export interface TagesverlaufPoint {
  date: string;        // YYYY-MM-DD
  dayNet: number;
  dayRev: number;
  dayPct: number | null;
  cumNet: number;
  cumRev: number;
  cumPct: number | null;
  hasEntry: boolean;
}

export interface TagesverlaufExportInput {
  points: TagesverlaufPoint[];
  /** Perioden-Label, z.B. «Juli 2026» oder «KW 28 2026». */
  periodLabel: string;
  tenantName: string;
  /** WKQ-Zielwert in % (Ampel-Schwellen: Ziel / Ziel+2). */
  targetPct: number;
  /** Perioden-WKQ für die Total-Zeile (analyseKPIs.pct). */
  totalPct: number | null;
  /** Dateiname ohne Endung. */
  fileBase: string;
}

const fmtChf = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (p: number | null) => (p === null ? '–' : `${p.toFixed(1)} %`);
const fmtDatum = (d: string) => {
  const [y, m, t] = d.split('-');
  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(`${d}T12:00:00`).getDay()];
  return `${wd} ${t}.${m}.${y}`;
};

/** Dezente Ampel-Textfarben (RGB) — bewusst gedeckt, nicht knallig. */
function pctColor(pct: number | null, targetPct: number): [number, number, number] | null {
  if (pct === null) return null;
  if (pct <= targetPct) return [21, 128, 61];      // grün-700
  if (pct <= targetPct + 2) return [180, 83, 9];   // amber-700
  return [185, 28, 28];                            // rot-700
}

export function exportTagesverlaufPdf(input: TagesverlaufExportInput): void {
  const { points, targetPct } = input;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const M = 14;

  // ── Kopf ──
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(20);
  doc.text(`Tagesverlauf Warenkosten · ${input.periodLabel}`, M, 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110);
  doc.text(`${input.tenantName} · Ziel-WKQ ${targetPct.toFixed(1)} % · erstellt ${new Date().toLocaleDateString('de-CH')}`, M, 24);

  const rows = points.filter(p => p.hasEntry || p.dayRev > 0);
  const last = points[points.length - 1];

  const body = rows.map(p => [
    fmtDatum(p.date),
    p.dayNet > 0 ? fmtChf(p.dayNet) : '–',
    p.dayRev > 0 ? fmtChf(p.dayRev) : '–',
    fmtPct(p.dayPct),
    fmtChf(p.cumNet),
    p.cumRev > 0 ? fmtChf(p.cumRev) : '–',
    fmtPct(p.cumPct),
  ]);
  const foot = last ? [[
    `Stand ${fmtDatum(last.date)}`,
    fmtChf(last.cumNet),
    last.cumRev > 0 ? fmtChf(last.cumRev) : '–',
    fmtPct(input.totalPct),
    fmtChf(last.cumNet),
    last.cumRev > 0 ? fmtChf(last.cumRev) : '–',
    fmtPct(last.cumPct),
  ]] : [];

  autoTable(doc, {
    startY: 29,
    margin: { left: M, right: M },
    head: [['Datum', 'Warenkosten', 'Umsatz', 'Tages %', 'Kum. Waren', 'Kum. Umsatz', 'Kum. %']],
    body,
    foot,
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 1.6, textColor: 40 },
    headStyles: { fillColor: [243, 244, 246], textColor: 70, fontStyle: 'bold', lineWidth: 0.1, lineColor: [220, 220, 220] },
    footStyles: { fillColor: [243, 244, 246], textColor: 20, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' },
    },
    alternateRowStyles: { fillColor: [250, 250, 250] },
    didParseCell: (data: CellHookData) => {
      // Dezente Ampelfarben nur auf den %-Spalten (3 = Tages %, 6 = Kum. %).
      if (data.column.index !== 3 && data.column.index !== 6) return;
      const idx = data.row.index;
      const src = data.section === 'body' ? rows[idx] : last;
      if (!src) return;
      const pct = data.section === 'body'
        ? (data.column.index === 3 ? src.dayPct : src.cumPct)
        : (data.column.index === 3 ? input.totalPct : src.cumPct);
      const c = pctColor(pct, targetPct);
      if (c) data.cell.styles.textColor = c;
    },
  });

  doc.save(`${input.fileBase}.pdf`);
}
