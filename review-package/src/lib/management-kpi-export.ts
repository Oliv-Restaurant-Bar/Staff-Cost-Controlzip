/**
 * management-kpi-export.ts — Export der Management-KPIs (Ebene 1).
 * ================================================================
 * Profile (User-Vorgabe):
 *  - geschaeftsleitung: ALLE KPIs inkl. Monatskommentare.
 *  - bank:              Finanz-KPIs (P&L) gemäss Katalog-Flag, ohne Kommentare.
 *  - investoren:        Kern-KPIs (Umsatz/EBITDA/EBIT + Margen), ohne Kommentare.
 *
 * Regeln (§7 replit.md):
 *  - Exporte konsumieren DIESELBEN Rohwerte wie die UI: Zeilen werden aus
 *    getKpiValues/getKpiTone (kpi-catalog) gebaut — keine Zweitberechnung.
 *  - Excel: echte Zahlenzellen mit Rohwerten, Anzeige-Rundung NUR über
 *    Zellformate; fehlend = LEERE Zelle, nie 0.
 *  - Ampeln aus dem Rohwert (getKpiTone), nie aus dem Anzeigestring.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  KPI_CATALOG,
  getKpiTone,
  getKpiValues,
  KPI_QUELLE_LABEL,
  type KpiCatalogInput,
  type KpiDefinition,
  type KpiTone,
} from './kpi-catalog';
import { getVisibleKpiComment, type KpiCommentsBlob } from './kpi-comments';

export type KpiExportProfile = 'geschaeftsleitung' | 'bank' | 'investoren';

export const KPI_EXPORT_PROFILE_LABEL: Record<KpiExportProfile, string> = {
  geschaeftsleitung: 'Geschäftsleitung',
  bank: 'Bank',
  investoren: 'Investoren',
};

export interface ManagementKpiRow {
  def: KpiDefinition;
  actual: number | null;
  budget: number | null;
  priorYear: number | null;
  /** Abw. IST−Budget in der KPI-Einheit (Quoten: pp) — null wenn eine Seite fehlt. */
  abwBudget: number | null;
  tone: KpiTone;
  kommentar: string | null;
}

/** Zeilen aus DENSELBEN Katalog-Funktionen wie die UI (keine Zweitberechnung). */
export function buildManagementKpiRows(
  input: KpiCatalogInput,
  comments: KpiCommentsBlob,
  monthKey: string,
): ManagementKpiRow[] {
  return KPI_CATALOG.map(def => {
    const v = getKpiValues(def.id, input);
    return {
      def,
      actual: v.actual,
      budget: v.budget,
      priorYear: v.priorYear,
      abwBudget: v.actual !== null && v.budget !== null ? v.actual - v.budget : null,
      tone: getKpiTone(def.id, v.actual, input),
      kommentar: getVisibleKpiComment(comments, monthKey, def.id)?.text ?? null,
    };
  });
}

export function filterRowsForProfile(
  rows: ManagementKpiRow[],
  profile: KpiExportProfile,
): ManagementKpiRow[] {
  return rows.filter(r => r.def.export[profile]);
}

// ─── Formatierung (nur Anzeige/PDF — Excel nutzt Zellformate) ───────────────

const nf0 = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtValue(def: KpiDefinition, v: number | null): string {
  if (v === null) return '—';
  switch (def.einheit) {
    case 'chf': return `CHF ${nf0.format(v)}`;
    case 'pct': return `${v.toFixed(1)} %`;
    case 'anzahl': return nf0.format(v);
    case 'chf_pro_gast':
    case 'chf_pro_stunde': return `CHF ${nf2.format(v)}`;
  }
}

function fmtAbw(def: KpiDefinition, v: number | null): string {
  if (v === null) return '—';
  const sign = v >= 0 ? '+' : '';
  if (def.einheit === 'pct') return `${sign}${v.toFixed(1)} pp`;
  if (def.einheit === 'anzahl') return `${sign}${nf0.format(v)}`;
  return `${sign}CHF ${nf0.format(v)}`;
}

const TONE_LABEL: Record<KpiTone, string> = {
  good: 'gut', warn: 'Achtung', critical: 'kritisch', neutral: '',
};

const PDF_TONE_TEXT: Record<'good' | 'warn' | 'critical', [number, number, number]> = {
  good: [21, 128, 61], warn: [146, 64, 14], critical: [153, 27, 27],
};
const PDF_TONE_FILL: Record<'good' | 'warn' | 'critical', [number, number, number]> = {
  good: [220, 252, 231], warn: [254, 243, 199], critical: [254, 226, 226],
};

// ─── Excel ──────────────────────────────────────────────────────────────────

/** Zellformat je Einheit — Rundung NUR über das Format, Rohwert bleibt in der Zelle. */
function excelFormat(einheit: KpiDefinition['einheit']): string {
  switch (einheit) {
    case 'chf': return '#,##0';
    case 'pct': return '0.0" %"';
    case 'anzahl': return '#,##0';
    case 'chf_pro_gast':
    case 'chf_pro_stunde': return '#,##0.00';
  }
}

export function exportManagementKpisToExcel(
  rows: ManagementKpiRow[],
  profile: KpiExportProfile,
  monthLabel: string,
  restaurantName: string,
  /** Hinweiszeile für laufende Monate («Laufender Monat – Vergleich mit vollständigem Monatsbudget …»). */
  runningMonthNote?: string | null,
): void {
  const filtered = filterRowsForProfile(rows, profile);
  const withComments = profile === 'geschaeftsleitung';

  const header = [
    'KPI', 'IST', 'Budget', 'Vorjahr', 'Abw. Budget', 'Einheit', 'Quelle', 'Ampel',
    ...(withComments ? ['Kommentar'] : []),
  ];
  const headRows: (string | number | null)[][] = [
    [`Management-KPIs · ${monthLabel}`],
    [`${restaurantName} · Profil: ${KPI_EXPORT_PROFILE_LABEL[profile]} · Exportiert am ${new Date().toLocaleDateString('de-CH')}`],
    ...(runningMonthNote ? [[runningMonthNote]] : []),
    [],
    header,
  ];
  const aoa: (string | number | null)[][] = [
    ...headRows,
    ...filtered.map(r => [
      r.def.name,
      r.actual, // Rohwert; null ⇒ leere Zelle
      r.budget,
      r.priorYear,
      r.abwBudget,
      r.def.einheit === 'pct' ? '%' : r.def.einheit === 'anzahl' ? 'Anzahl' : 'CHF',
      KPI_QUELLE_LABEL[r.def.quelle],
      TONE_LABEL[r.tone],
      ...(withComments ? [r.kommentar ?? ''] : []),
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Zahlenformate: Spalten B–E (IST/Budget/VJ/Abw) je Zeilen-Einheit.
  // Offset dynamisch aus headRows (Hinweiszeile verschiebt die Datenzeilen).
  const dataStart = headRows.length;
  filtered.forEach((r, ri) => {
    const rowIdx = dataStart + ri; // 0-basiert: erste Datenzeile nach dem Kopf
    for (let ci = 1; ci <= 4; ci++) {
      const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: ci })];
      if (cell && typeof cell.v === 'number') cell.z = excelFormat(r.def.einheit);
    }
  });
  ws['!cols'] = [
    { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    { wch: 8 }, { wch: 16 }, { wch: 10 }, ...(withComments ? [{ wch: 50 }] : []),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Management-KPIs');
  const slug = monthLabel.replace(/\s+/g, '_');
  XLSX.writeFile(wb, `Management_KPIs_${KPI_EXPORT_PROFILE_LABEL[profile]}_${slug}.xlsx`);
}

// ─── PDF ────────────────────────────────────────────────────────────────────

export function exportManagementKpisToPDF(
  rows: ManagementKpiRow[],
  profile: KpiExportProfile,
  monthLabel: string,
  restaurantName: string,
  /** Hinweiszeile für laufende Monate («Laufender Monat – Vergleich mit vollständigem Monatsbudget …»). */
  runningMonthNote?: string | null,
): void {
  const filtered = filterRowsForProfile(rows, profile);
  const withComments = profile === 'geschaeftsleitung';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(30, 64, 175);
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(restaurantName, 10, 9);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(`Management-KPIs · ${monthLabel} · Profil ${KPI_EXPORT_PROFILE_LABEL[profile]}`, 10, 17);
  doc.text(`Exportiert am ${new Date().toLocaleDateString('de-CH')}`, pageW - 10, 17, { align: 'right' });
  doc.setTextColor(0, 0, 0);

  if (runningMonthNote) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(146, 64, 14); // Achtung-Ton (identisch zur Ampel-Palette)
    doc.text(runningMonthNote, 10, 26.5);
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');
  }

  const head = [[
    'KPI', 'IST', 'Budget', 'Vorjahr', 'Abw. Budget', 'Quelle',
    ...(withComments ? ['Kommentar'] : []),
  ]];
  const body = filtered.map(r => [
    r.def.name,
    fmtValue(r.def, r.actual),
    r.def.hatBudgetVj ? fmtValue(r.def, r.budget) : '—',
    fmtValue(r.def, r.priorYear),
    r.def.hatBudgetVj ? fmtAbw(r.def, r.abwBudget) : '—',
    KPI_QUELLE_LABEL[r.def.quelle],
    ...(withComments ? [r.kommentar ?? ''] : []),
  ]);

  autoTable(doc, {
    startY: runningMonthNote ? 30 : 28,
    head,
    body,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [30, 64, 175], fontSize: 8 },
    columnStyles: {
      1: { halign: 'right' }, 2: { halign: 'right' },
      3: { halign: 'right' }, 4: { halign: 'right' },
    },
    didParseCell: data => {
      if (data.section !== 'body' || data.column.index !== 1) return;
      const row = filtered[data.row.index];
      if (!row || row.tone === 'neutral') return;
      data.cell.styles.textColor = PDF_TONE_TEXT[row.tone];
      data.cell.styles.fillColor = PDF_TONE_FILL[row.tone];
      data.cell.styles.fontStyle = 'bold';
    },
  });

  const slug = monthLabel.replace(/\s+/g, '_');
  doc.save(`Management_KPIs_${KPI_EXPORT_PROFILE_LABEL[profile]}_${slug}.pdf`);
}
