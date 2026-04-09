import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Employee } from '@/types/personnel';

// ── Formatierungshelfer ────────────────────────────────────────────────────────

function fmtCHF(n: number): string {
  return n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 });
}

function fmtCHFDec(n: number): string {
  return n.toLocaleString('de-CH', { style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getMonthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString('de-CH', { month: 'long', year: 'numeric' });
}

const EMP_TYPE_LABEL: Record<string, string> = {
  vollzeit: 'Vollzeit', teilzeit: 'Teilzeit', minijob: 'Minijob', aushilfe: 'Aushilfe',
};

const DEPT_LABEL: Record<string, string> = {
  service: 'Service', küche: 'Küche',
};

// ── Farben ─────────────────────────────────────────────────────────────────────

const C = {
  // Blues
  headerBlue:    [30, 58, 138] as [number, number, number],
  sectionBlue:   [37, 99, 235] as [number, number, number],
  lightBlue:     [219, 234, 254] as [number, number, number],
  textBlue:      [29, 78, 216] as [number, number, number],

  // Oranges
  sectionOrange: [234, 88, 12] as [number, number, number],
  lightOrange:   [255, 237, 213] as [number, number, number],
  textOrange:    [154, 52, 18] as [number, number, number],

  // Greens
  sectionGreen:  [16, 185, 129] as [number, number, number],
  lightGreen:    [209, 250, 229] as [number, number, number],
  textGreen:     [4, 120, 87] as [number, number, number],

  // Reds
  lightRed:      [254, 226, 226] as [number, number, number],
  textRed:       [185, 28, 28] as [number, number, number],

  // Violets
  lightViolet:   [237, 233, 254] as [number, number, number],
  textViolet:    [109, 40, 217] as [number, number, number],

  // Grays
  headerGray:    [100, 116, 139] as [number, number, number],
  rowGray:       [248, 250, 252] as [number, number, number],
  borderGray:    [226, 232, 240] as [number, number, number],
  tableHead:     [241, 245, 249] as [number, number, number],
  textMuted:     [100, 116, 139] as [number, number, number],
  black:         [15, 23, 42] as [number, number, number],
  white:         [255, 255, 255] as [number, number, number],
};

// ── Datentypen für den Export ──────────────────────────────────────────────────

export interface FixedRow {
  emp: Employee;
  cost: number;
  label: string | null;
  yearlyCost: number;
}

export interface VarRow {
  emp: Employee;
  hours: number;
  monthlyCost: number;
  hourlyWage: number;
}

export interface PersonalFixExportData {
  selectedYear: number;
  selectedMonth: number;

  // FIX Daten
  byDept: Record<string, FixedRow[]>;
  totalFixCost: number;
  totalFixBase: number;
  totalFixAnnual: number;

  // VARIABEL Daten
  varByDept: Record<string, VarRow[]>;
  totalVarCost: number;
  totalVarHours: number;

  // Gesamt
  totalCombined: number;

  // Budget
  personnelBudget: number;
  availableVarBudget: number;
  varBudgetDelta: number;
  varBudgetOverrun: boolean;

  // Quelle Variabel-Stunden
  varView: 'plan' | 'ist' | 'manual';
  avgHourlyWage: number;
  maxVarHours: number;
}

// ── Interne Helfer ─────────────────────────────────────────────────────────────

function setFont(pdf: jsPDF, weight: 'normal' | 'bold', size: number, color: [number, number, number] = C.black) {
  pdf.setFont('helvetica', weight);
  pdf.setFontSize(size);
  pdf.setTextColor(...color);
}

function drawRect(pdf: jsPDF, x: number, y: number, w: number, h: number, fill: [number, number, number], stroke?: [number, number, number]) {
  pdf.setFillColor(...fill);
  if (stroke) {
    pdf.setDrawColor(...stroke);
    pdf.roundedRect(x, y, w, h, 1.5, 1.5, 'FD');
  } else {
    pdf.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
  }
}

/** Zeichnet eine KPI-Karte */
function drawKpiCard(
  pdf: jsPDF,
  x: number, y: number, w: number, h: number,
  title: string, value: string, sub: string | null,
  accent: [number, number, number], border: [number, number, number],
  badge?: string,
  delta?: { amount: number; label: string },
) {
  // Background
  pdf.setFillColor(250, 250, 252);
  pdf.setDrawColor(...border);
  pdf.setLineWidth(0.4);
  pdf.roundedRect(x, y, w, h, 2, 2, 'FD');

  // Accent left bar
  pdf.setFillColor(...accent);
  pdf.rect(x, y + 2, 1.5, h - 4, 'F');

  const innerX = x + 5;
  const innerW = w - 10;

  // Title
  setFont(pdf, 'normal', 6.5, C.textMuted);
  pdf.text(title.toUpperCase(), innerX, y + 6);

  // Value
  setFont(pdf, 'bold', 13, C.black);
  pdf.text(value, innerX, y + 14);

  // Optional badge
  let nextY = y + 16.5;
  if (badge) {
    pdf.setFillColor(255, 237, 213);
    pdf.setDrawColor(251, 146, 60);
    pdf.setLineWidth(0.2);
    pdf.roundedRect(innerX, nextY, 38, 4, 1, 1, 'FD');
    setFont(pdf, 'bold', 5.5, [154, 52, 18]);
    pdf.text(badge, innerX + 2, nextY + 2.8);
    nextY += 5.5;
  }

  // Sub text
  if (sub) {
    setFont(pdf, 'normal', 6, C.textMuted);
    const lines = pdf.splitTextToSize(sub, innerW);
    pdf.text(lines[0], innerX, nextY + 2);
  }

  // Delta
  if (delta) {
    const isPositive = delta.amount > 0;
    const col: [number, number, number] = isPositive ? C.textRed : C.textGreen;
    setFont(pdf, 'bold', 6, col);
    const sign = isPositive ? '+' : '';
    pdf.text(`${sign}${fmtCHF(delta.amount)} ${delta.label}`, innerX, y + h - 3);
  }
}

/** Zeichnet einen Abschnitts-Header-Balken */
function drawSectionHeader(
  pdf: jsPDF,
  x: number, y: number, w: number,
  label: string, count?: number,
  accent: [number, number, number] = C.sectionBlue,
  light: [number, number, number] = C.lightBlue,
) {
  pdf.setFillColor(...light);
  pdf.setDrawColor(...accent);
  pdf.setLineWidth(0.3);
  pdf.rect(x, y, w, 8, 'FD');

  // left accent stripe
  pdf.setFillColor(...accent);
  pdf.rect(x, y, 2, 8, 'F');

  setFont(pdf, 'bold', 9, accent);
  pdf.text(label, x + 5, y + 5.5);

  if (count !== undefined) {
    const countLabel = String(count);
    const cw = pdf.getStringUnitWidth(countLabel) * 9 / pdf.internal.scaleFactor + 4;
    const cx = x + w - cw - 3;
    pdf.setFillColor(...accent);
    pdf.roundedRect(cx, y + 1.5, cw, 5, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 6.5, C.white);
    pdf.text(countLabel, cx + cw / 2, y + 5, { align: 'center' });
  }
}

/** Zeichnet eine schlanke Dept-Subheader-Zeile */
function drawDeptSubheader(
  pdf: jsPDF,
  x: number, y: number, w: number,
  dept: string, count: number, summaryText: string,
  accent: [number, number, number],
  light: [number, number, number],
) {
  pdf.setFillColor(...light);
  pdf.rect(x, y, w, 6.5, 'F');
  pdf.setDrawColor(...accent);
  pdf.setLineWidth(0.2);
  pdf.line(x, y + 6.5, x + w, y + 6.5);

  setFont(pdf, 'bold', 7.5, accent);
  const label = (DEPT_LABEL[dept] ?? dept).toUpperCase();
  pdf.text(`${label}  (${count})`, x + 4, y + 4.5);

  setFont(pdf, 'normal', 7, C.textMuted);
  pdf.text(summaryText, x + w - 2, y + 4.5, { align: 'right' });
}

/** Zeigt Seitennummer unten */
function addFooter(pdf: jsPDF, monthLabel: string) {
  const pages = pdf.getNumberOfPages();
  const pw = pdf.internal.pageSize.getWidth();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    const ph = pdf.internal.pageSize.getHeight();
    pdf.setDrawColor(...C.borderGray);
    pdf.setLineWidth(0.3);
    pdf.line(10, ph - 8, pw - 10, ph - 8);
    setFont(pdf, 'normal', 6, C.textMuted);
    pdf.text(`Personal FIX + VARIABEL · ${monthLabel}`, 10, ph - 4);
    pdf.text(`Seite ${i} / ${pages}`, pw - 10, ph - 4, { align: 'right' });
    const now = new Date().toLocaleString('de-CH');
    pdf.text(`Erstellt: ${now}`, pw / 2, ph - 4, { align: 'center' });
  }
}

// ── Hauptfunktion ──────────────────────────────────────────────────────────────

export function exportPersonalFixToPDF(data: PersonalFixExportData): void {
  const {
    selectedYear, selectedMonth,
    byDept, totalFixCost, totalFixBase, totalFixAnnual,
    varByDept, totalVarCost, totalVarHours, totalCombined,
    personnelBudget, availableVarBudget, varBudgetDelta, varBudgetOverrun,
    varView, avgHourlyWage, maxVarHours,
  } = data;

  const monthLabel = getMonthLabel(selectedYear, selectedMonth);

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const usableW = pw - margin * 2;

  // ── SEITE 1: Header ──────────────────────────────────────────────────────────

  // Header Banner
  pdf.setFillColor(...C.headerBlue);
  pdf.rect(0, 0, pw, 24, 'F');

  setFont(pdf, 'bold', 15, C.white);
  pdf.text('Personal FIX + VARIABEL', margin, 10);
  setFont(pdf, 'normal', 8, [186, 210, 255]);
  pdf.text('Lohnkosten-Übersicht & Hochrechnung', margin, 16);

  setFont(pdf, 'bold', 10, C.white);
  pdf.text(monthLabel, pw - margin, 10, { align: 'right' });
  setFont(pdf, 'normal', 7, [186, 210, 255]);
  pdf.text(`Oliv Gastro AG`, pw - margin, 16, { align: 'right' });

  let curY = 30;

  // ── KPI Zeile 1: Fix / Var / Total ──────────────────────────────────────────

  const kpiW = (usableW - 8) / 3;
  const kpiH = 30;

  drawKpiCard(pdf, margin,              curY, kpiW, kpiH,
    'Personal FIX / Monat', fmtCHF(totalFixCost),
    `${Object.values(byDept).flat().length} Mitarbeiter mit Fixlohn`,
    C.sectionBlue, C.lightBlue);

  const varBadge = varView === 'plan' ? '● Plan-Stunden'
    : varView === 'ist' ? '● Ist-Stunden' : '● Manuell';
  const varSub = totalVarHours > 0
    ? `${Math.round(totalVarHours * 10) / 10} h × Stundenlohn`
    : `${Object.values(varByDept).flat().length} MA · Stunden wählen`;

  drawKpiCard(pdf, margin + kpiW + 4,   curY, kpiW, kpiH,
    'Personal VARIABEL / Monat', fmtCHF(totalVarCost),
    varSub,
    C.sectionOrange, C.lightOrange, varBadge);

  drawKpiCard(pdf, margin + 2 * (kpiW + 4), curY, kpiW, kpiH,
    'Total Personal / Monat', fmtCHF(totalCombined),
    'FIX + VARIABEL',
    C.sectionGreen, C.lightGreen);

  curY += kpiH + 4;

  // ── KPI Zeile 2: Budget (optional) ──────────────────────────────────────────

  if (personnelBudget > 0) {
    const fixBudgetDiff = totalFixCost - personnelBudget;
    const totBudgetDiff = totalCombined - personnelBudget;

    drawKpiCard(pdf, margin,              curY, kpiW, kpiH,
      'FIX vs. Budget / Monat', fmtCHF(Math.abs(fixBudgetDiff)),
      fixBudgetDiff <= 0
        ? `FIX liegt ${fmtCHF(-fixBudgetDiff)} unter Budget`
        : `FIX übersteigt Budget um ${fmtCHF(fixBudgetDiff)}`,
      fixBudgetDiff <= 0 ? C.sectionGreen : [220, 38, 38],
      fixBudgetDiff <= 0 ? C.lightGreen : C.lightRed,
      undefined,
      { amount: fixBudgetDiff, label: 'FIX − Budget' });

    drawKpiCard(pdf, margin + kpiW + 4,   curY, kpiW, kpiH,
      'Total vs. Budget / Monat', fmtCHF(Math.abs(totBudgetDiff)),
      totBudgetDiff <= 0
        ? `Total liegt ${fmtCHF(-totBudgetDiff)} unter Budget`
        : `Total übersteigt Budget um ${fmtCHF(totBudgetDiff)}`,
      totBudgetDiff <= 0 ? C.sectionGreen : [220, 38, 38],
      totBudgetDiff <= 0 ? C.lightGreen : C.lightRed,
      undefined,
      { amount: totBudgetDiff, label: 'Total − Budget' });

    drawKpiCard(pdf, margin + 2 * (kpiW + 4), curY, kpiW, kpiH,
      'Budget Personalkosten', fmtCHF(personnelBudget),
      `Monatsbudget ${monthLabel}`,
      C.headerGray, C.borderGray);

    curY += kpiH + 4;
  }

  // ── Info-Zeile ───────────────────────────────────────────────────────────────

  pdf.setFillColor(239, 246, 255);
  pdf.setDrawColor(191, 219, 254);
  pdf.setLineWidth(0.3);
  pdf.roundedRect(margin, curY, usableW, 10, 1, 1, 'FD');
  pdf.setFillColor(...C.sectionBlue);
  pdf.rect(margin, curY, 2, 10, 'F');
  setFont(pdf, 'bold', 7, C.textBlue);
  pdf.text('Personal FIX:', margin + 5, curY + 4);
  setFont(pdf, 'normal', 7, C.textBlue);
  pdf.text('Garantierter Monatslohn inkl. amortisiertem 13. ML. Mitarbeiter im Austrittsmonat werden pro rata abgerechnet.', margin + 29, curY + 4);
  setFont(pdf, 'bold', 7, C.textBlue);
  pdf.text('Personal VARIABEL:', margin + 5, curY + 8);
  setFont(pdf, 'normal', 7, C.textBlue);
  pdf.text('Stunden × Stundenlohn. Quelle: Plan / Ist / Manuell.', margin + 40, curY + 8);
  curY += 14;

  // ── FIX-ABSCHNITT ────────────────────────────────────────────────────────────

  const fixDepts = Object.keys(byDept);
  const totalFixEmployees = fixDepts.reduce((s, d) => s + byDept[d].length, 0);

  if (totalFixEmployees > 0) {
    drawSectionHeader(pdf, margin, curY, usableW,
      '● Personal FIX — Garantierter Monatslohn', totalFixEmployees,
      C.sectionBlue, C.lightBlue);
    curY += 10;

    for (const dept of fixDepts) {
      const rows = byDept[dept];
      if (!rows || rows.length === 0) continue;

      const deptTotal = rows.reduce((s, r) => s + r.cost, 0);
      const deptBase  = rows.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);

      drawDeptSubheader(pdf, margin, curY, usableW,
        dept, rows.length,
        `Basis: ${fmtCHF(deptBase)}/Mt   FIX: ${fmtCHF(deptTotal)}/Mt`,
        C.sectionBlue, [239, 246, 255]);
      curY += 8;

      const tableBody = rows.map(({ emp, cost, label, yearlyCost }) => [
        emp.name + (label ? `\n(${label})` : ''),
        EMP_TYPE_LABEL[emp.employmentType] ?? emp.employmentType,
        emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–',
        emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–',
        cost > 0 ? fmtCHF(cost) : '–',
        yearlyCost > 0 ? fmtCHF(yearlyCost) : '–',
      ]);

      // Footer row
      const footerRow = [
        `Total ${DEPT_LABEL[dept] ?? dept}`,
        '',
        fmtCHF(deptBase),
        fmtCHF(rows.reduce((s, r) => s + (r.emp.monthlySalaryWith13th ?? 0), 0)),
        fmtCHF(deptTotal),
        fmtCHF(rows.reduce((s, r) => s + r.yearlyCost, 0)),
      ];

      autoTable(pdf, {
        startY: curY,
        margin: { left: margin, right: margin },
        head: [['Name', 'Anstellung', 'Basis-Lohn/Mt', 'inkl. 13./Mt', 'FIX-Kosten/Mt', 'FIX-Kosten/Jahr']],
        body: tableBody,
        foot: [footerRow],
        theme: 'plain',
        styles: {
          fontSize: 7.5,
          cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
          lineColor: C.borderGray,
          lineWidth: 0.2,
        },
        headStyles: {
          fillColor: C.tableHead,
          textColor: C.headerGray,
          fontStyle: 'bold',
          fontSize: 6.5,
        },
        footStyles: {
          fillColor: C.lightBlue,
          textColor: C.textBlue,
          fontStyle: 'bold',
          fontSize: 7.5,
        },
        columnStyles: {
          0: { cellWidth: 42, fontStyle: 'bold' },
          1: { cellWidth: 22, halign: 'center' },
          2: { cellWidth: 32, halign: 'right' },
          3: { cellWidth: 32, halign: 'right' },
          4: { cellWidth: 30, halign: 'right', textColor: C.textBlue, fontStyle: 'bold' },
          5: { cellWidth: 32, halign: 'right', textColor: C.textMuted },
        },
        alternateRowStyles: { fillColor: C.rowGray },
        didParseCell(hookData) {
          if (hookData.section === 'body') {
            const row = rows[hookData.row.index];
            if (!row) return;
            if (row.label && hookData.column.index === 0) {
              hookData.cell.styles.textColor = [180, 83, 9];
            }
          }
          if (hookData.section === 'foot' && hookData.column.index >= 2) {
            hookData.cell.styles.halign = 'right';
            if (hookData.column.index === 4) {
              hookData.cell.styles.textColor = C.textBlue;
            }
          }
        },
      });

      curY = (pdf as any).lastAutoTable.finalY + 4;
    }

    // Total FIX Band
    pdf.setFillColor(219, 234, 254);
    pdf.setDrawColor(...C.sectionBlue);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(margin, curY, usableW, 10, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionBlue);
    pdf.rect(margin, curY, 2.5, 10, 'F');
    setFont(pdf, 'bold', 8, C.textBlue);
    pdf.text('Total Personal FIX · alle Abteilungen', margin + 6, curY + 4);
    setFont(pdf, 'normal', 7.5, C.textMuted);
    pdf.text(`Basis: ${fmtCHF(totalFixBase)}/Mt`, pw - margin - 100, curY + 4);
    setFont(pdf, 'bold', 9, C.textBlue);
    pdf.text(`${fmtCHF(totalFixCost)}/Mt`, pw - margin - 50, curY + 4, { align: 'right' });
    setFont(pdf, 'normal', 7.5, C.textMuted);
    pdf.text(`| Jahr: ${fmtCHF(totalFixAnnual)}`, pw - margin - 2, curY + 4, { align: 'right' });
    curY += 14;
  }

  // ── VARIABEL-ABSCHNITT ───────────────────────────────────────────────────────

  const varDepts = Object.keys(varByDept);
  const totalVarEmployees = varDepts.reduce((s, d) => s + varByDept[d].length, 0);

  if (totalVarEmployees > 0) {
    // check page space
    if (curY > ph - 60) {
      pdf.addPage();
      curY = 15;
    }

    const varModeLabel = varView === 'plan' ? 'Plan-Stunden'
      : varView === 'ist' ? 'Ist-Stunden (Mirus)'
      : 'Manuelle Eingabe';

    drawSectionHeader(pdf, margin, curY, usableW,
      `● Variable Mitarbeiter — Stunden-Hochrechnung (${varModeLabel})`,
      totalVarEmployees,
      C.sectionOrange, C.lightOrange);
    curY += 10;

    // Budget Schnellinfo (if budget)
    if (personnelBudget > 0) {
      const statusColor: [number, number, number] = varBudgetOverrun ? [254, 226, 226]
        : varBudgetDelta < availableVarBudget * 0.15 ? [254, 249, 195] : [209, 250, 229];
      const statusText: [number, number, number] = varBudgetOverrun ? C.textRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [133, 77, 14] : C.textGreen;

      pdf.setFillColor(...statusColor);
      pdf.rect(margin, curY, usableW, 7, 'F');
      setFont(pdf, 'normal', 7, C.textMuted);
      pdf.text('Restbudget Variabel:', margin + 4, curY + 4.5);
      setFont(pdf, 'bold', 7.5, statusText);
      const budgetTxt = varBudgetOverrun
        ? `⚠ ${fmtCHF(Math.abs(varBudgetDelta))} überschritten`
        : `${fmtCHF(varBudgetDelta)} noch verfügbar`;
      pdf.text(budgetTxt, margin + 38, curY + 4.5);

      if (!varBudgetOverrun && avgHourlyWage > 0 && maxVarHours > 0) {
        const remaining = Math.max(0, maxVarHours - Math.round(totalVarHours));
        setFont(pdf, 'normal', 7, C.textMuted);
        pdf.text(`≈ ${remaining} h noch planbar`, margin + 38 + 55, curY + 4.5);
      }

      // Budget usage %
      const pct = Math.min(100, Math.round((totalVarCost / availableVarBudget) * 100));
      const barX = pw - margin - 45;
      setFont(pdf, 'normal', 7, C.textMuted);
      pdf.text(`${pct} %`, barX - 8, curY + 4.5, { align: 'right' });
      pdf.setFillColor(...C.borderGray);
      pdf.roundedRect(barX, curY + 1.5, 40, 4, 2, 2, 'F');
      const barFill: [number, number, number] = varBudgetOverrun ? [239, 68, 68]
        : varBudgetDelta < availableVarBudget * 0.15 ? [234, 179, 8] : [16, 185, 129];
      pdf.setFillColor(...barFill);
      pdf.roundedRect(barX, curY + 1.5, Math.max(1, 40 * pct / 100), 4, 2, 2, 'F');

      curY += 9;
    }

    for (const dept of varDepts) {
      const rows = varByDept[dept];
      if (!rows || rows.length === 0) continue;

      const deptHours = rows.reduce((s, r) => s + r.hours, 0);
      const deptCost  = rows.reduce((s, r) => s + r.monthlyCost, 0);

      const summaryRight = deptHours > 0
        ? `${Math.round(deptHours * 10) / 10} h → ${fmtCHF(deptCost)}`
        : fmtCHF(deptCost);

      drawDeptSubheader(pdf, margin, curY, usableW,
        dept, rows.length, summaryRight,
        C.sectionOrange, [255, 251, 235]);
      curY += 8;

      const hoursHeader = varView === 'plan' ? 'Plan-Std./Mt'
        : varView === 'ist' ? 'Ist-Std./Mt' : 'Std./Mt (Manuell)';

      const tableBody = rows.map(r => [
        r.emp.name,
        EMP_TYPE_LABEL[r.emp.employmentType] ?? r.emp.employmentType,
        r.hourlyWage > 0 ? `${fmtCHFDec(r.hourlyWage)}/h` : '–',
        r.hours > 0 ? `${Math.round(r.hours * 10) / 10} h` : '–',
        r.monthlyCost > 0 ? fmtCHF(r.monthlyCost) : '–',
        r.monthlyCost > 0 ? fmtCHF(r.monthlyCost * 12) : '–',
      ]);

      const footerRow = deptCost > 0 ? [
        `Total ${DEPT_LABEL[dept] ?? dept} Variabel`,
        '',
        '',
        deptHours > 0 ? `${Math.round(deptHours * 10) / 10} h` : '–',
        fmtCHF(deptCost),
        fmtCHF(deptCost * 12),
      ] : [];

      autoTable(pdf, {
        startY: curY,
        margin: { left: margin, right: margin },
        head: [['Name', 'Anstellung', 'Stundenlohn', hoursHeader, 'Kosten/Mt', 'Kosten/Jahr']],
        body: tableBody,
        foot: footerRow.length ? [footerRow] : [],
        theme: 'plain',
        styles: {
          fontSize: 7.5,
          cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
          lineColor: C.borderGray,
          lineWidth: 0.2,
        },
        headStyles: {
          fillColor: C.tableHead,
          textColor: C.headerGray,
          fontStyle: 'bold',
          fontSize: 6.5,
        },
        footStyles: {
          fillColor: C.lightOrange,
          textColor: C.textOrange,
          fontStyle: 'bold',
          fontSize: 7.5,
        },
        columnStyles: {
          0: { cellWidth: 42, fontStyle: 'bold' },
          1: { cellWidth: 22, halign: 'center' },
          2: { cellWidth: 32, halign: 'right', textColor: C.textMuted },
          3: { cellWidth: 32, halign: 'right' },
          4: { cellWidth: 30, halign: 'right', textColor: C.textOrange, fontStyle: 'bold' },
          5: { cellWidth: 32, halign: 'right', textColor: C.textMuted },
        },
        alternateRowStyles: { fillColor: C.rowGray },
        didParseCell(hookData) {
          if (hookData.section === 'foot') {
            if (hookData.column.index >= 3) {
              hookData.cell.styles.halign = 'right';
            }
            if (hookData.column.index === 4) {
              hookData.cell.styles.textColor = C.textOrange;
            }
          }
        },
      });

      curY = (pdf as any).lastAutoTable.finalY + 4;
    }

    // Total Variabel Band
    if (totalVarHours > 0 || totalVarCost > 0) {
      pdf.setFillColor(...C.lightOrange);
      pdf.setDrawColor(...C.sectionOrange);
      pdf.setLineWidth(0.4);
      pdf.roundedRect(margin, curY, usableW, 10, 1.5, 1.5, 'FD');
      pdf.setFillColor(...C.sectionOrange);
      pdf.rect(margin, curY, 2.5, 10, 'F');
      setFont(pdf, 'bold', 8, C.textOrange);
      pdf.text('Total Variabel · alle Abteilungen', margin + 6, curY + 4);
      if (totalVarHours > 0) {
        setFont(pdf, 'normal', 7.5, C.textMuted);
        pdf.text(`${Math.round(totalVarHours * 10) / 10} h`, pw - margin - 60, curY + 4, { align: 'right' });
      }
      setFont(pdf, 'bold', 9, C.textOrange);
      pdf.text(`${fmtCHF(totalVarCost)}/Mt`, pw - margin - 2, curY + 4, { align: 'right' });
      curY += 14;
    }
  }

  // ── BUDGET PLANUNG (optional, neue Seite wenn nötig) ─────────────────────────

  if (personnelBudget > 0) {
    if (curY > ph - 70) {
      pdf.addPage();
      curY = 15;
    }

    const budgetAvailForVar = Math.max(0, personnelBudget - totalFixCost);
    const overrun = varBudgetDelta < 0;

    drawSectionHeader(pdf, margin, curY, usableW,
      `● Budget-Planung Personal — ${monthLabel}`, undefined,
      C.textViolet, C.lightViolet);
    curY += 12;

    const colW = (usableW - 6) / 2;

    // Left: Budgetverteilung
    setFont(pdf, 'bold', 7, C.textMuted);
    pdf.text('BUDGETVERTEILUNG', margin, curY);
    curY += 4;

    const budgetRows = [
      ['Personalbudget gesamt', fmtCHF(personnelBudget)],
      ['− Personal FIX', `− ${fmtCHF(totalFixCost)}`],
    ];
    autoTable(pdf, {
      startY: curY,
      margin: { left: margin, right: margin + colW + 6 },
      body: budgetRows,
      theme: 'plain',
      styles: { fontSize: 8, cellPadding: { top: 2, bottom: 2, left: 3, right: 3 }, lineColor: C.borderGray, lineWidth: 0.2 },
      columnStyles: {
        0: { cellWidth: colW - 32 },
        1: { cellWidth: 32, halign: 'right', fontStyle: 'bold' },
      },
    });
    let leftY = (pdf as any).lastAutoTable.finalY + 1;

    // Result row left
    const resColorL: [number, number, number] = budgetAvailForVar > 0 ? C.lightGreen : C.lightRed;
    const resTextL: [number, number, number]  = budgetAvailForVar > 0 ? C.textGreen : C.textRed;
    pdf.setFillColor(...resColorL);
    pdf.roundedRect(margin, leftY, colW, 9, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 7.5, resTextL);
    pdf.text('= Verfügbar für Variabel', margin + 3, leftY + 5.5);
    pdf.text(fmtCHF(budgetAvailForVar), margin + colW - 3, leftY + 5.5, { align: 'right' });

    // Right: Schätzung vs Budget
    const rightX = margin + colW + 6;
    let rightY = curY - 4;
    setFont(pdf, 'bold', 7, C.textMuted);
    pdf.text('SCHÄTZUNG VS. BUDGET', rightX, rightY);
    rightY += 4;

    const compareRows = [
      ['Verfügbar für Variabel', fmtCHF(budgetAvailForVar)],
      [`− Geschätzte Kosten Variabel (${varView === 'plan' ? 'Plan' : varView === 'ist' ? 'Ist' : 'Manuell'})`, `− ${fmtCHF(totalVarCost)}`],
    ];
    autoTable(pdf, {
      startY: rightY,
      margin: { left: rightX, right: margin },
      body: compareRows,
      theme: 'plain',
      styles: { fontSize: 8, cellPadding: { top: 2, bottom: 2, left: 3, right: 3 }, lineColor: C.borderGray, lineWidth: 0.2 },
      columnStyles: {
        0: { cellWidth: colW - 32 },
        1: { cellWidth: 32, halign: 'right', fontStyle: 'bold' },
      },
    });
    const rightEndY = (pdf as any).lastAutoTable.finalY + 1;

    // Result row right
    const resColorR: [number, number, number] = !overrun ? C.lightGreen : C.lightRed;
    const resTextR: [number, number, number]  = !overrun ? C.textGreen : C.textRed;
    pdf.setFillColor(...resColorR);
    pdf.roundedRect(rightX, rightEndY, colW, 9, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 7.5, resTextR);
    pdf.text(overrun ? '⚠ Überziehung' : '✓ Verbleibend', rightX + 3, rightEndY + 5.5);
    pdf.text(`${overrun ? '– ' : '+ '}${fmtCHF(Math.abs(varBudgetDelta))}`, rightX + colW - 3, rightEndY + 5.5, { align: 'right' });

    curY = Math.max(leftY, rightEndY) + 12;

    // Planning hint (if avgHourlyWage known)
    if (avgHourlyWage > 0) {
      const hintColor: [number, number, number] = overrun ? C.lightRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [254, 249, 195] : C.lightGreen;
      const hintText: [number, number, number]  = overrun ? C.textRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [133, 77, 14] : C.textGreen;

      pdf.setFillColor(...hintColor);
      pdf.setDrawColor(...hintText);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(margin, curY, usableW, 16, 1.5, 1.5, 'FD');
      pdf.setFillColor(...hintText);
      pdf.rect(margin, curY, 2, 16, 'F');

      setFont(pdf, 'bold', 7.5, hintText);
      if (overrun) {
        const hoursToReduce = Math.ceil(Math.abs(varBudgetDelta) / avgHourlyWage);
        pdf.text(`⚠ Budget überschritten — ca. ${hoursToReduce} h reduzieren`, margin + 5, curY + 6);
      } else if (varBudgetDelta < availableVarBudget * 0.15) {
        pdf.text('Budgetausschöpfung nahezu vollständig — weniger als 15 % Spielraum verbleiben.', margin + 5, curY + 6);
      } else {
        const remainH = Math.max(0, maxVarHours - Math.round(totalVarHours));
        pdf.text(`Budget im grünen Bereich — noch ca. ${remainH} h planbar (ø ${fmtCHFDec(avgHourlyWage)}/h).`, margin + 5, curY + 6);
      }
      setFont(pdf, 'normal', 7, hintText);
      pdf.text(`Ø Stundenlohn: ${fmtCHFDec(avgHourlyWage)}/h · Budget Variabel: ${fmtCHF(budgetAvailForVar)} · Ist Variabel: ${fmtCHF(totalVarCost)}`, margin + 5, curY + 12);
    }
  }

  // ── Footer auf allen Seiten ──────────────────────────────────────────────────

  addFooter(pdf, monthLabel);

  // ── Speichern ────────────────────────────────────────────────────────────────

  const year  = String(selectedYear);
  const month = String(selectedMonth).padStart(2, '0');
  pdf.save(`PersonalFix_${year}-${month}.pdf`);
}
