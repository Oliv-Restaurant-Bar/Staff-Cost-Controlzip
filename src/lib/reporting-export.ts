import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { MonthlyFinancialRecord } from '@/types/reporting';
import { MONTH_NAMES_SHORT_DE } from '@/types/reporting';

const CHF = (v: number | undefined | null) =>
  v != null && v > 0
    ? new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(v)
    : '–';

export interface ReportingTotals {
  revenueActual: number;
  revenueBudget: number;
  revenuePreviousYear: number;
  personnelCostActual: number;
  personnelCostPlanned: number;
}

export function calcEffectiveTotals(months: MonthlyFinancialRecord[]): ReportingTotals {
  return months.reduce((acc, m) => ({
    revenueActual:       acc.revenueActual       + (m.revenueActual       ?? 0),
    revenueBudget:       acc.revenueBudget       + (m.revenueBudget       ?? 0),
    revenuePreviousYear: acc.revenuePreviousYear + (m.revenuePreviousYear ?? 0),
    personnelCostActual: acc.personnelCostActual + (m.personnelCostActual ?? 0),
    personnelCostPlanned:acc.personnelCostPlanned+ (m.personnelCostPlanned ?? 0),
  }), { revenueActual: 0, revenueBudget: 0, revenuePreviousYear: 0, personnelCostActual: 0, personnelCostPlanned: 0 });
}

export function exportReportingToPDF(
  months: MonthlyFinancialRecord[],
  totals: ReportingTotals,
  year: number,
) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const now = new Date().toLocaleDateString('de-CH');

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(`Oliv Gastro AG – Reporting ${year}`, 14, 18);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120);
  doc.text(`Exportiert am ${now}`, 14, 25);
  doc.setTextColor(0);

  const head = [['Monat', 'Umsatz Ist', 'Budget', 'Vorjahr', 'PK Ist', 'PK Geplant']];
  const body: string[][] = months.map(m => [
    MONTH_NAMES_SHORT_DE[m.month],
    CHF(m.revenueActual),
    CHF(m.revenueBudget),
    CHF(m.revenuePreviousYear),
    CHF(m.personnelCostActual),
    CHF(m.personnelCostPlanned),
  ]);

  body.push([
    'Total',
    CHF(totals.revenueActual),
    CHF(totals.revenueBudget),
    CHF(totals.revenuePreviousYear),
    CHF(totals.personnelCostActual),
    CHF(totals.personnelCostPlanned),
  ]);

  autoTable(doc, {
    startY: 30,
    head,
    body,
    theme: 'striped',
    headStyles: { fillColor: [50, 50, 80], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
    },
    didParseCell: (data) => {
      if (data.row.index === body.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [230, 230, 240];
        data.cell.styles.textColor = [20, 20, 60];
      }
    },
  });

  doc.save(`Reporting_${year}.pdf`);
}

export function exportReportingToExcel(
  months: MonthlyFinancialRecord[],
  totals: ReportingTotals,
  year: number,
) {
  const numFmt = '#\'##0.00" CHF"';

  const rows: (string | number | null)[][] = [
    ['Oliv Gastro AG – Reporting', year],
    [],
    ['Monat', 'Umsatz Ist', 'Budget', 'Vorjahr', 'PK Ist', 'PK Geplant', 'PK-Quote %'],
    ...months.map(m => {
      const pkQ = m.revenueActual && m.personnelCostActual
        ? Math.round((m.personnelCostActual / m.revenueActual) * 1000) / 10
        : null;
      return [
        MONTH_NAMES_SHORT_DE[m.month],
        m.revenueActual ?? null,
        m.revenueBudget ?? null,
        m.revenuePreviousYear ?? null,
        m.personnelCostActual ?? null,
        m.personnelCostPlanned ?? null,
        pkQ,
      ];
    }),
    [
      'Total',
      totals.revenueActual || null,
      totals.revenueBudget || null,
      totals.revenuePreviousYear || null,
      totals.personnelCostActual || null,
      totals.personnelCostPlanned || null,
      totals.revenueActual > 0 && totals.personnelCostActual > 0
        ? Math.round((totals.personnelCostActual / totals.revenueActual) * 1000) / 10
        : null,
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);

  ws['!cols'] = [
    { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Reporting ${year}`);
  XLSX.writeFile(wb, `Reporting_${year}.xlsx`);
}
