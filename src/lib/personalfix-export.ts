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

export interface DeptSummaryRow {
  dept: string;
  fix: number;
  varArbeit: number;
  ferienabbau: number;
  variabel: number;
  total: number;
}

export interface ProRataEmpRow {
  name: string;
  dept: string;
  hours: number;
  monthlyCost: number;
  proRataCost: number;
  ferienCHF: number;
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

  // Ferienabbau
  totalVarArbeitCHF: number;
  totalFerienabbauCHF: number;
  totalVariabelCHF: number;
  ferienabbauByDept: Record<string, number>;
  deptSummary: DeptSummaryRow[];

  // Pro-Rata
  proRataDay: number | null;
  proRataFactor: number;
  proRataFixCost: number;
  proRataVarCost: number;
  proRataTotal: number;
  proRataVarByEmp: ProRataEmpRow[];
  daysInSelectedMonth: number;
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

/** Section-divider: a thin accent line + bold title with generous spacing */
function drawSectionTitle(
  pdf: jsPDF,
  x: number, y: number, w: number,
  title: string,
  accent: [number, number, number] = C.sectionBlue,
): void {
  pdf.setDrawColor(...accent);
  pdf.setLineWidth(0.6);
  pdf.line(x, y, x + w, y);
  pdf.setFillColor(...accent);
  pdf.rect(x, y - 0.3, 4, 7, 'F');
  setFont(pdf, 'bold', 9.5, accent);
  pdf.text(title, x + 7, y + 4.8);
}

/** Two-value row for budget analysis table */
function drawBudgetRow(
  pdf: jsPDF,
  x: number, y: number, w: number, h: number,
  label: string, value: string,
  labelColor: [number, number, number] = C.black,
  valueColor: [number, number, number] = C.black,
  bold = false,
  bg?: [number, number, number],
): number {
  if (bg) {
    pdf.setFillColor(...bg);
    pdf.roundedRect(x, y, w, h, 1.5, 1.5, 'F');
  } else {
    pdf.setDrawColor(...C.borderGray);
    pdf.setLineWidth(0.2);
    pdf.line(x, y + h, x + w, y + h);
  }
  setFont(pdf, bold ? 'bold' : 'normal', 8, labelColor);
  pdf.text(label, x + 3, y + h / 2 + 2.5);
  setFont(pdf, 'bold', 8, valueColor);
  pdf.text(value, x + w - 3, y + h / 2 + 2.5, { align: 'right' });
  return y + h;
}

export function exportPersonalFixToPDF(data: PersonalFixExportData): void {
  const {
    selectedYear, selectedMonth,
    byDept, totalFixCost, totalFixBase, totalFixAnnual,
    varByDept, totalVarCost, totalVarHours, totalCombined,
    personnelBudget, availableVarBudget, varBudgetDelta, varBudgetOverrun,
    varView, avgHourlyWage, maxVarHours,
    totalVarArbeitCHF, totalFerienabbauCHF, totalVariabelCHF,
    deptSummary,
    proRataDay, proRataFactor, proRataFixCost, proRataVarCost, proRataTotal,
    proRataVarByEmp, daysInSelectedMonth,
  } = data;

  const monthLabel = getMonthLabel(selectedYear, selectedMonth);

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw  = pdf.internal.pageSize.getWidth();
  const ph  = pdf.internal.pageSize.getHeight();
  const M   = 12;          // margin
  const W   = pw - M * 2;  // usable width

  // ── Seitenumbruch-Helfer ────────────────────────────────────────────────────
  function needsPage(space: number) {
    if (curY + space > ph - 16) { pdf.addPage(); curY = 16; }
  }

  const varModeLabel = varView === 'plan' ? 'Plan-Stunden'
    : varView === 'ist' ? 'Ist-Stunden (Mirus)' : 'Manuelle Eingabe';
  const varModeBadge = varView === 'plan' ? 'PLAN' : varView === 'ist' ? 'IST' : 'MANUELL';
  const totalNetCHF  = totalFixCost + totalVariabelCHF;
  const budgetAvailForVar = personnelBudget > 0 ? Math.max(0, personnelBudget - totalFixCost) : 0;
  const overrun = varBudgetDelta < 0;

  // ════════════════════════════════════════════════════════════════════════════
  // SEITE 1 — Deckblatt: Header · KPI · Budget-Analyse
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. HEADER BANNER ──────────────────────────────────────────────────────
  pdf.setFillColor(...C.headerBlue);
  pdf.rect(0, 0, pw, 28, 'F');

  // Accent stripe bottom of header
  pdf.setFillColor(29, 78, 216);
  pdf.rect(0, 26, pw, 2, 'F');

  setFont(pdf, 'bold', 16, C.white);
  pdf.text('Personal FIX + VARIABEL', M, 12);
  setFont(pdf, 'normal', 8.5, [186, 210, 255] as [number, number, number]);
  pdf.text('Personalkosten-Controlling · Oliv Gastro AG', M, 19);

  // Right side: period + mode badge
  setFont(pdf, 'bold', 11, C.white);
  pdf.text(monthLabel, pw - M, 12, { align: 'right' });

  // Mode pill
  const modeX = pw - M - 2;
  const modeTxt = `Modus: ${varModeBadge}`;
  const modeW = pdf.getStringUnitWidth(modeTxt) * 7 / pdf.internal.scaleFactor + 8;
  pdf.setFillColor(29, 78, 216);
  pdf.roundedRect(modeX - modeW, 20, modeW, 5.5, 1.5, 1.5, 'F');
  setFont(pdf, 'bold', 6.5, C.white);
  pdf.text(modeTxt, modeX - modeW / 2, 23.8, { align: 'center' });

  let curY = 34;

  // ── 2. KPI-BLOCK ──────────────────────────────────────────────────────────
  // Large KPI cards: FIX · Variable Arbeit · Total Personal

  const kpiW = (W - 8) / 3;
  const kpiH = 36;

  // Override drawKpiCard for larger value font on this page
  const drawBigKpi = (
    x: number, title: string, value: string,
    sub: string, badge: string | undefined,
    accent: [number, number, number], border: [number, number, number],
    delta?: { amount: number; label: string },
  ) => {
    pdf.setFillColor(250, 251, 255);
    pdf.setDrawColor(...border);
    pdf.setLineWidth(0.5);
    pdf.roundedRect(x, curY, kpiW, kpiH, 2.5, 2.5, 'FD');
    pdf.setFillColor(...accent);
    pdf.rect(x, curY + 2.5, 2, kpiH - 5, 'F');
    const ix = x + 6;
    setFont(pdf, 'normal', 6, C.textMuted);
    pdf.text(title.toUpperCase(), ix, curY + 7);
    setFont(pdf, 'bold', 15, accent);
    pdf.text(value, ix, curY + 18);
    if (badge) {
      pdf.setFillColor(255, 237, 213);
      pdf.setDrawColor(251, 146, 60);
      pdf.setLineWidth(0.2);
      const bW = pdf.getStringUnitWidth(badge) * 6 / pdf.internal.scaleFactor + 6;
      pdf.roundedRect(ix, curY + 20, bW, 5, 1, 1, 'FD');
      setFont(pdf, 'bold', 5.5, [154, 52, 18] as [number, number, number]);
      pdf.text(badge, ix + 3, curY + 23.5);
    }
    setFont(pdf, 'normal', 6.5, C.textMuted);
    const subLines = pdf.splitTextToSize(sub, kpiW - 10);
    pdf.text(subLines[0] ?? '', ix, curY + (badge ? 28 : 26));
    if (delta) {
      const isPos = delta.amount > 0;
      const col: [number, number, number] = isPos ? C.textRed : C.textGreen;
      setFont(pdf, 'bold', 6, col);
      pdf.text(`${isPos ? '+' : ''}${fmtCHF(delta.amount)} ${delta.label}`, ix, curY + kpiH - 3);
    }
  };

  drawBigKpi(M,              'Personal FIX / Monat',    fmtCHF(totalFixCost),
    `${Object.values(byDept).flat().length} Mitarbeiter mit Fixlohn`, undefined,
    C.sectionBlue, C.lightBlue);

  const varSub = totalVarHours > 0
    ? `${Math.round(totalVarHours * 10) / 10} h  ×  Stundenlohn`
    : `${Object.values(varByDept).flat().length} MA · Stunden wählen`;
  drawBigKpi(M + kpiW + 4,   'Variable Arbeit / Monat', fmtCHF(totalVarArbeitCHF),
    varSub, `● ${varModeBadge}-STUNDEN`,
    C.sectionOrange, C.lightOrange);

  const totalSub = totalFerienabbauCHF > 0
    ? `FIX + Variabel − ${fmtCHF(totalFerienabbauCHF)} Ferienabbau`
    : 'FIX + VARIABEL kombiniert';
  drawBigKpi(M + 2*(kpiW+4), 'Total Personal / Monat',  fmtCHF(totalNetCHF),
    totalSub, undefined,
    C.sectionGreen, C.lightGreen);

  curY += kpiH + 6;

  // Budget KPI row (only if budget configured)
  if (personnelBudget > 0) {
    const fixDiff = totalFixCost - personnelBudget;
    const totDiff = totalCombined - personnelBudget;
    const kpiH2 = 26;

    drawKpiCard(pdf, M,              curY, kpiW, kpiH2,
      'FIX vs. Budget', fmtCHF(Math.abs(fixDiff)),
      fixDiff <= 0 ? `${fmtCHF(-fixDiff)} unter Budget` : `${fmtCHF(fixDiff)} über Budget`,
      fixDiff <= 0 ? C.sectionGreen : [220, 38, 38] as [number, number, number],
      fixDiff <= 0 ? C.lightGreen  : C.lightRed,
      undefined, { amount: fixDiff, label: 'FIX − Budget' });

    drawKpiCard(pdf, M + kpiW + 4,   curY, kpiW, kpiH2,
      'Total vs. Budget', fmtCHF(Math.abs(totDiff)),
      totDiff <= 0 ? `${fmtCHF(-totDiff)} unter Budget` : `${fmtCHF(totDiff)} über Budget`,
      totDiff <= 0 ? C.sectionGreen : [220, 38, 38] as [number, number, number],
      totDiff <= 0 ? C.lightGreen  : C.lightRed,
      undefined, { amount: totDiff, label: 'Total − Budget' });

    drawKpiCard(pdf, M + 2*(kpiW+4), curY, kpiW, kpiH2,
      'Monatsbudget Personal', fmtCHF(personnelBudget),
      `Geplant für ${monthLabel}`,
      C.headerGray, C.borderGray);

    curY += kpiH2 + 6;
  }

  // Ferienabbau info-pill (only if relevant)
  if (totalFerienabbauCHF > 0) {
    pdf.setFillColor(239, 246, 255);
    pdf.setDrawColor(191, 219, 254);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(M, curY, W, 7, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionBlue);
    pdf.rect(M, curY, 1.5, 7, 'F');
    setFont(pdf, 'bold', 7, C.textBlue);
    pdf.text('Ferienabbau:', M + 4, curY + 4.5);
    setFont(pdf, 'normal', 7, C.textBlue);
    pdf.text(`${fmtCHF(totalFerienabbauCHF)} werden von den variablen Kosten abgezogen (FE-Einträge im Ist-Dienstplan).`, M + 28, curY + 4.5);
    curY += 11;
  }

  // ── 3. BUDGET-ANALYSE ─────────────────────────────────────────────────────
  if (personnelBudget > 0) {
    needsPage(68);
    drawSectionTitle(pdf, M, curY, W, `Budget-Analyse Personal — ${monthLabel}`, C.textViolet);
    curY += 10;

    const col = (W - 6) / 2;
    const rowH = 9;

    // LEFT: Budgetverteilung
    setFont(pdf, 'bold', 6.5, C.textMuted);
    pdf.text('BUDGETVERTEILUNG', M, curY + 1);
    curY += 5;

    let ly = curY;
    ly = drawBudgetRow(pdf, M, ly, col, rowH, 'Personalbudget gesamt', fmtCHF(personnelBudget), C.textMuted, C.black, true);
    ly = drawBudgetRow(pdf, M, ly, col, rowH, '− Personal FIX', `− ${fmtCHF(totalFixCost)}`, C.textMuted, C.textBlue);
    // Result
    const lvBg: [number, number, number] = budgetAvailForVar > 0 ? C.lightGreen : C.lightRed;
    const lvTx: [number, number, number] = budgetAvailForVar > 0 ? C.textGreen  : C.textRed;
    pdf.setFillColor(...lvBg);
    pdf.roundedRect(M, ly, col, rowH + 1, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 8, lvTx);
    pdf.text('= Verfügbar für Variabel', M + 3, ly + 6.5);
    pdf.text(fmtCHF(budgetAvailForVar), M + col - 3, ly + 6.5, { align: 'right' });
    const leftBottom = ly + rowH + 3;

    // RIGHT: Schätzung vs. Budget
    const rx = M + col + 6;
    setFont(pdf, 'bold', 6.5, C.textMuted);
    pdf.text('SCHÄTZUNG VS. BUDGET', rx, curY + 1 - 5 + 1);
    let ry = curY;
    ry = drawBudgetRow(pdf, rx, ry, col, rowH, 'Verfügbar für Variabel', fmtCHF(budgetAvailForVar), C.textMuted, C.black);
    ry = drawBudgetRow(pdf, rx, ry, col, rowH, `− Variable Arbeit (${varModeBadge})`, `− ${fmtCHF(totalVarArbeitCHF)}`, C.textMuted, C.textOrange);
    if (totalFerienabbauCHF > 0) {
      ry = drawBudgetRow(pdf, rx, ry, col, rowH, '+ Ferienabbau-Abzug', `− ${fmtCHF(totalFerienabbauCHF)}`, C.textMuted, [29, 78, 216] as [number, number, number]);
      ry = drawBudgetRow(pdf, rx, ry, col, rowH, '= Netto Variabel', fmtCHF(totalVariabelCHF), C.textMuted, C.textOrange, true);
    }
    // Result
    const rvBg: [number, number, number] = !overrun ? C.lightGreen : C.lightRed;
    const rvTx: [number, number, number] = !overrun ? C.textGreen  : C.textRed;
    pdf.setFillColor(...rvBg);
    pdf.roundedRect(rx, ry, col, rowH + 1, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 8, rvTx);
    pdf.text(!overrun ? '✓ Verbleibend' : '⚠ Überziehung', rx + 3, ry + 6.5);
    pdf.text(`${!overrun ? '+ ' : '– '}${fmtCHF(Math.abs(varBudgetDelta))}`, rx + col - 3, ry + 6.5, { align: 'right' });
    const rightBottom = ry + rowH + 3;

    curY = Math.max(leftBottom, rightBottom) + 5;

    // Planning hint bar
    if (avgHourlyWage > 0) {
      const hBg: [number, number, number] = overrun ? C.lightRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [254, 249, 195] : C.lightGreen;
      const hTx: [number, number, number] = overrun ? C.textRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [133, 77, 14] : C.textGreen;
      pdf.setFillColor(...hBg);
      pdf.setDrawColor(...hTx);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(M, curY, W, 13, 1.5, 1.5, 'FD');
      pdf.setFillColor(...hTx);
      pdf.rect(M, curY, 1.5, 13, 'F');

      let hintLine1: string;
      let hintLine2: string;
      if (overrun) {
        const reduce = Math.ceil(Math.abs(varBudgetDelta) / avgHourlyWage);
        hintLine1 = `⚠  Budget überschritten — ca. ${reduce} Stunden reduzieren, um das Budget einzuhalten.`;
      } else if (varBudgetDelta < availableVarBudget * 0.15) {
        hintLine1 = `Budget nahezu ausgeschöpft — weniger als 15 % Spielraum verbleiben.`;
      } else {
        const rem = Math.max(0, maxVarHours - Math.round(totalVarHours));
        hintLine1 = `Budget im grünen Bereich — noch ca. ${rem} Stunden planbar.`;
      }
      hintLine2 = `Ø Stundenlohn: ${fmtCHFDec(avgHourlyWage)}/h  ·  Budget Variabel: ${fmtCHF(budgetAvailForVar)}  ·  Variable Arbeit (${varModeBadge}): ${fmtCHF(totalVarArbeitCHF)}`;

      setFont(pdf, 'bold', 7.5, hTx);
      pdf.text(hintLine1, M + 5, curY + 5.5);
      setFont(pdf, 'normal', 6.5, hTx);
      pdf.text(hintLine2, M + 5, curY + 10.5);
      curY += 17;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SEITE 2+ — Abteilungsübersicht · Detailtabellen
  // ════════════════════════════════════════════════════════════════════════════

  // ── 4. ABTEILUNGSÜBERSICHT ────────────────────────────────────────────────
  if (deptSummary.length > 0 && (totalFixCost > 0 || totalVarArbeitCHF > 0)) {
    needsPage(55);
    drawSectionTitle(pdf, M, curY, W,
      `Personalkosten nach Abteilung — ${monthLabel}`, [109, 40, 217] as [number, number, number]);
    curY += 10;

    const deptCols  = deptSummary.map(ds => DEPT_LABEL[ds.dept] ?? ds.dept);
    const nCols     = deptSummary.length + 2;          // Kategorie + depts + Total
    const labelW    = 48;
    const numW      = (W - labelW) / (nCols - 1);

    const fix    = ['FIX',            ...deptSummary.map(ds => fmtCHF(ds.fix)),       fmtCHF(totalFixCost)];
    const varA   = ['Variable Arbeit', ...deptSummary.map(ds => fmtCHF(ds.varArbeit)), fmtCHF(totalVarArbeitCHF)];
    const feRow  = ['− Ferienabbau',   ...deptSummary.map(ds => ds.ferienabbau > 0 ? `− ${fmtCHF(ds.ferienabbau)}` : '–'), totalFerienabbauCHF > 0 ? `− ${fmtCHF(totalFerienabbauCHF)}` : '–'];
    const varNet = ['Netto Variabel',  ...deptSummary.map(ds => fmtCHF(ds.variabel)),  fmtCHF(totalVariabelCHF)];
    const totRow = ['TOTAL PERSONAL',  ...deptSummary.map(ds => fmtCHF(ds.total)),     fmtCHF(totalFixCost + totalVariabelCHF)];

    autoTable(pdf, {
      startY: curY,
      margin: { left: M, right: M },
      head: [['Kategorie', ...deptCols, 'Gesamt']],
      body: [fix, varA, ...(totalFerienabbauCHF > 0 ? [feRow] : []), varNet],
      foot: [totRow],
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 }, lineColor: C.borderGray, lineWidth: 0.2 },
      headStyles: { fillColor: [30, 58, 138] as [number, number, number], textColor: C.white, fontStyle: 'bold', fontSize: 8 },
      footStyles: { fillColor: [16, 185, 129] as [number, number, number], textColor: C.white, fontStyle: 'bold', fontSize: 9 },
      columnStyles: {
        0: { cellWidth: labelW, fontStyle: 'bold' },
        ...Object.fromEntries(deptSummary.map((_, i) => [i + 1, { cellWidth: numW, halign: 'right' as const }])),
        [deptSummary.length + 1]: { cellWidth: numW, halign: 'right' as const, fontStyle: 'bold' },
      },
      alternateRowStyles: { fillColor: C.rowGray },
      didParseCell(h) {
        if (h.section === 'body') {
          const label = (h.row.raw as string[])[0];
          if (label === 'FIX')            { h.cell.styles.textColor = C.textBlue; }
          if (label === 'Variable Arbeit'){ h.cell.styles.textColor = C.textOrange; }
          if (label === '− Ferienabbau')  { h.cell.styles.textColor = [29, 78, 216]; }
          if (label === 'Netto Variabel') { h.cell.styles.textColor = C.textOrange; h.cell.styles.fontStyle = 'bold'; }
          if (h.column.index > 0)         { h.cell.styles.halign = 'right'; }
        }
        if (h.section === 'foot') {
          h.cell.styles.halign = h.column.index === 0 ? 'left' : 'right';
        }
      },
    });
    curY = (pdf as any).lastAutoTable.finalY + 10;
  }

  // ── 5a. DETAIL: Personal FIX ──────────────────────────────────────────────
  const fixDepts = Object.keys(byDept);
  const totalFixEmps = fixDepts.reduce((s, d) => s + byDept[d].length, 0);

  if (totalFixEmps > 0) {
    needsPage(40);
    drawSectionTitle(pdf, M, curY, W,
      `Personal FIX — Garantierter Monatslohn (${totalFixEmps} MA)`, C.sectionBlue);
    curY += 10;

    for (const dept of fixDepts) {
      const rows = byDept[dept];
      if (!rows?.length) continue;

      const deptTotal = rows.reduce((s, r) => s + r.cost, 0);
      const deptBase  = rows.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);

      needsPage(24);
      drawDeptSubheader(pdf, M, curY, W, dept, rows.length,
        `Basis ${fmtCHF(deptBase)}/Mt  ·  FIX ${fmtCHF(deptTotal)}/Mt`,
        C.sectionBlue, [239, 246, 255]);
      curY += 8;

      autoTable(pdf, {
        startY: curY,
        margin: { left: M, right: M },
        head: [['Name', 'Anstellung', 'Basis/Mt', 'inkl. 13./Mt', 'FIX-Kosten/Mt', 'FIX/Jahr']],
        body: rows.map(({ emp, cost, label, yearlyCost }) => [
          emp.name + (label ? ` (${label})` : ''),
          EMP_TYPE_LABEL[emp.employmentType] ?? emp.employmentType,
          emp.monthlySalary ? fmtCHFDec(emp.monthlySalary) : '–',
          emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–',
          cost > 0 ? fmtCHF(cost) : '–',
          yearlyCost > 0 ? fmtCHF(yearlyCost) : '–',
        ]),
        foot: [[
          `Total ${DEPT_LABEL[dept] ?? dept}`, '',
          fmtCHF(deptBase),
          fmtCHF(rows.reduce((s, r) => s + (r.emp.monthlySalaryWith13th ?? 0), 0)),
          fmtCHF(deptTotal),
          fmtCHF(rows.reduce((s, r) => s + r.yearlyCost, 0)),
        ]],
        theme: 'plain',
        styles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 }, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightBlue, textColor: C.textBlue, fontStyle: 'bold', fontSize: 7.5 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: 50, fontStyle: 'bold' },
          1: { cellWidth: 22, halign: 'center' },
          2: { cellWidth: 28, halign: 'right' },
          3: { cellWidth: 28, halign: 'right' },
          4: { cellWidth: 28, halign: 'right', textColor: C.textBlue, fontStyle: 'bold' },
          5: { cellWidth: 28, halign: 'right', textColor: C.textMuted },
        },
        didParseCell(h) {
          if (h.section === 'body' && h.column.index === 0) {
            const row = rows[h.row.index];
            if (row?.label) h.cell.styles.textColor = [180, 83, 9];
          }
          if (h.section === 'foot' && h.column.index >= 2) h.cell.styles.halign = 'right';
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + 5;
    }

    // Total FIX summary band
    pdf.setFillColor(219, 234, 254);
    pdf.setDrawColor(...C.sectionBlue);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(M, curY, W, 10, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionBlue);
    pdf.rect(M, curY, 2.5, 10, 'F');
    setFont(pdf, 'bold', 8, C.textBlue);
    pdf.text('Total Personal FIX · alle Abteilungen', M + 6, curY + 6.5);
    setFont(pdf, 'normal', 7, C.textMuted);
    pdf.text(`Basis: ${fmtCHF(totalFixBase)}/Mt`, pw - M - 90, curY + 6.5);
    setFont(pdf, 'bold', 9, C.textBlue);
    pdf.text(fmtCHF(totalFixCost), pw - M - 38, curY + 6.5, { align: 'right' });
    setFont(pdf, 'normal', 7, C.textMuted);
    pdf.text(`| Jahr: ${fmtCHF(totalFixAnnual)}`, pw - M - 2, curY + 6.5, { align: 'right' });
    curY += 14;
  }

  // ── 5b. DETAIL: Variable Mitarbeiter ──────────────────────────────────────
  const varDepts = Object.keys(varByDept);
  const totalVarEmps = varDepts.reduce((s, d) => s + varByDept[d].length, 0);

  if (totalVarEmps > 0) {
    needsPage(40);
    drawSectionTitle(pdf, M, curY, W,
      `Variable Mitarbeiter — ${varModeLabel} (${totalVarEmps} MA)`, C.sectionOrange);
    curY += 10;

    for (const dept of varDepts) {
      const rows = varByDept[dept];
      if (!rows?.length) continue;

      const deptHours = rows.reduce((s, r) => s + r.hours, 0);
      const deptCost  = rows.reduce((s, r) => s + r.monthlyCost, 0);
      const sumTxt = deptHours > 0
        ? `${Math.round(deptHours * 10) / 10} h  →  ${fmtCHF(deptCost)}`
        : fmtCHF(deptCost);

      needsPage(24);
      drawDeptSubheader(pdf, M, curY, W, dept, rows.length, sumTxt, C.sectionOrange, [255, 251, 235]);
      curY += 8;

      const hH = varView === 'plan' ? 'Plan-Std./Mt' : varView === 'ist' ? 'Ist-Std./Mt' : 'Std./Mt';
      autoTable(pdf, {
        startY: curY,
        margin: { left: M, right: M },
        head: [['Name', 'Anstellung', 'Stundenlohn', hH, 'Kosten/Mt']],
        body: rows.map(r => [
          r.emp.name,
          EMP_TYPE_LABEL[r.emp.employmentType] ?? r.emp.employmentType,
          r.hourlyWage > 0 ? `${fmtCHFDec(r.hourlyWage)}/h` : '–',
          r.hours > 0 ? `${Math.round(r.hours * 10) / 10} h` : '–',
          r.monthlyCost > 0 ? fmtCHF(r.monthlyCost) : '–',
        ]),
        foot: deptCost > 0 ? [[
          `Total ${DEPT_LABEL[dept] ?? dept}`, '', '',
          deptHours > 0 ? `${Math.round(deptHours * 10) / 10} h` : '–',
          fmtCHF(deptCost),
        ]] : [],
        theme: 'plain',
        styles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 }, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightOrange, textColor: C.textOrange, fontStyle: 'bold', fontSize: 7.5 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: 55, fontStyle: 'bold' },
          1: { cellWidth: 24, halign: 'center' },
          2: { cellWidth: 30, halign: 'right', textColor: C.textMuted },
          3: { cellWidth: 30, halign: 'right' },
          4: { cellWidth: 'auto', halign: 'right', textColor: C.textOrange, fontStyle: 'bold' },
        },
        didParseCell(h) {
          if (h.section === 'foot' && h.column.index >= 3) h.cell.styles.halign = 'right';
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + 5;
    }

    // Total Variabel band
    const bandH = totalFerienabbauCHF > 0 ? 22 : 10;
    needsPage(bandH + 6);
    pdf.setFillColor(...C.lightOrange);
    pdf.setDrawColor(...C.sectionOrange);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(M, curY, W, bandH, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionOrange);
    pdf.rect(M, curY, 2.5, bandH, 'F');
    if (totalFerienabbauCHF > 0) {
      setFont(pdf, 'bold', 7, C.textOrange);
      pdf.text('Total Variable Arbeit:', M + 6, curY + 6);
      setFont(pdf, 'bold', 7.5, C.textOrange);
      pdf.text(fmtCHF(totalVarArbeitCHF), pw - M - 2, curY + 6, { align: 'right' });
      setFont(pdf, 'bold', 7, [29, 78, 216] as [number, number, number]);
      pdf.text('− Ferienabbau-Abzug:', M + 6, curY + 13);
      setFont(pdf, 'bold', 7.5, [29, 78, 216] as [number, number, number]);
      pdf.text(`− ${fmtCHF(totalFerienabbauCHF)}`, pw - M - 2, curY + 13, { align: 'right' });
      pdf.setDrawColor(...C.sectionOrange);
      pdf.setLineWidth(0.3);
      pdf.line(M + 3, curY + 15.5, pw - M - 3, curY + 15.5);
      setFont(pdf, 'bold', 8, C.textOrange);
      pdf.text('= Netto Variabel · alle Abteilungen', M + 6, curY + 20);
      setFont(pdf, 'bold', 9, C.textOrange);
      pdf.text(`${fmtCHF(totalVariabelCHF)}/Mt`, pw - M - 2, curY + 20, { align: 'right' });
    } else {
      setFont(pdf, 'bold', 8, C.textOrange);
      pdf.text('Total Variabel · alle Abteilungen', M + 6, curY + 6.5);
      setFont(pdf, 'bold', 9, C.textOrange);
      pdf.text(`${fmtCHF(totalVariabelCHF)}/Mt`, pw - M - 2, curY + 6.5, { align: 'right' });
    }
    curY += bandH + 10;
  }

  // ── PRO-RATA (optional) ───────────────────────────────────────────────────
  if (proRataDay !== null) {
    needsPage(60);
    const pctLbl = `${Math.round(proRataFactor * 100)} %`;
    drawSectionTitle(pdf, M, curY, W,
      `Pro-Rata-Abgrenzung — bis Tag ${proRataDay} von ${daysInSelectedMonth} (${pctLbl})`,
      C.sectionGreen);
    curY += 10;

    const prW = (W - 8) / 3;
    const prH = 22;
    const drawProCard = (x: number, label: string, val: string, from: string, col: [number,number,number], bg: [number,number,number]) => {
      pdf.setFillColor(...bg);
      pdf.setDrawColor(...col);
      pdf.setLineWidth(0.4);
      pdf.roundedRect(x, curY, prW, prH, 2, 2, 'FD');
      pdf.setFillColor(...col);
      pdf.rect(x, curY + 2, 1.5, prH - 4, 'F');
      setFont(pdf, 'normal', 6, C.textMuted);
      pdf.text(label.toUpperCase(), x + 4, curY + 5);
      setFont(pdf, 'bold', 11, col);
      pdf.text(val, x + 4, curY + 13);
      setFont(pdf, 'normal', 6, C.textMuted);
      pdf.text(`von ${from}`, x + 4, curY + 19);
    };
    drawProCard(M,             `FIX bis ${proRataDay}.`,      fmtCHF(proRataFixCost), fmtCHF(totalFixCost),                    C.sectionBlue,   C.lightBlue);
    drawProCard(M + prW + 4,   `Variabel bis ${proRataDay}.`, fmtCHF(proRataVarCost), fmtCHF(totalVariabelCHF),                C.sectionOrange, C.lightOrange);
    drawProCard(M + 2*(prW+4), `Total bis ${proRataDay}.`,    fmtCHF(proRataTotal),   fmtCHF(totalFixCost + totalVariabelCHF), C.sectionGreen,  C.lightGreen);
    curY += prH + 6;

    if (proRataVarByEmp.length > 0) {
      const hH = varView === 'plan' ? 'Plan-Std./Mt' : varView === 'ist' ? 'Ist-Std./Mt' : 'Std./Mt';
      autoTable(pdf, {
        startY: curY,
        margin: { left: M, right: M },
        head: [['Name', 'Abt.', hH, 'FE-Abzug', 'Netto/Mt', `bis ${proRataDay}.`]],
        body: proRataVarByEmp.map(r => [
          r.name, r.dept,
          r.hours > 0 ? `${Math.round(r.hours * 10) / 10} h` : '–',
          r.ferienCHF > 0 ? `− ${fmtCHF(r.ferienCHF)}` : '–',
          fmtCHF(r.monthlyCost),
          fmtCHF(r.proRataCost),
        ]),
        foot: [[
          'Total Variabel', '', '',
          proRataVarByEmp.reduce((s, r) => s + r.ferienCHF, 0) > 0
            ? `− ${fmtCHF(proRataVarByEmp.reduce((s, r) => s + r.ferienCHF, 0))}` : '–',
          fmtCHF(totalVariabelCHF), fmtCHF(proRataVarCost),
        ]],
        theme: 'plain',
        styles: { fontSize: 7.5, cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 }, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightGreen, textColor: C.textGreen, fontStyle: 'bold', fontSize: 7.5 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: 48, fontStyle: 'bold' },
          1: { cellWidth: 18 },
          2: { cellWidth: 24, halign: 'right' },
          3: { cellWidth: 26, halign: 'right', textColor: [29, 78, 216] as [number, number, number] },
          4: { cellWidth: 28, halign: 'right' },
          5: { cellWidth: 'auto', halign: 'right', textColor: C.textGreen, fontStyle: 'bold' },
        },
        didParseCell(h) {
          if (h.section === 'foot') {
            h.cell.styles.halign = h.column.index === 0 ? 'left' : 'right';
            if (h.column.index === 5) h.cell.styles.textColor = C.textGreen;
          }
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + 10;
    }
  }

  // ── 6. INTERPRETATION (automatisch generiert) ─────────────────────────────
  const insights: Array<{ text: string; color: [number, number, number]; icon: string }> = [];

  if (totalFerienabbauCHF > 0) {
    insights.push({
      text: `Ein Teil der variablen Kosten (${fmtCHF(totalFerienabbauCHF)}) ist auf Ferienabbau zurückzuführen. Die Netto-Variabelkosten betragen ${fmtCHF(totalVariabelCHF)} (statt ${fmtCHF(totalVarArbeitCHF)} brutto).`,
      color: C.textBlue,
      icon: 'i',
    });
  }
  if (personnelBudget > 0) {
    if (overrun) {
      insights.push({
        text: `Variable Kosten übersteigen das verfügbare Budget um ${fmtCHF(Math.abs(varBudgetDelta))}. Bitte variable Schichten entsprechend reduzieren.`,
        color: C.textRed,
        icon: '!',
      });
    } else if (varBudgetDelta < availableVarBudget * 0.15) {
      insights.push({
        text: `Das variable Budget ist nahezu ausgeschöpft — nur noch ${fmtCHF(varBudgetDelta)} (${Math.round((varBudgetDelta / availableVarBudget) * 100)} %) verbleiben. Zusätzliche Schichten könnten das Budget sprengen.`,
        color: [133, 77, 14] as [number, number, number],
        icon: '!',
      });
    } else {
      insights.push({
        text: `Personalkosten im Budgetrahmen. Verbleibendes Variabel-Budget: ${fmtCHF(varBudgetDelta)} (${Math.round((varBudgetDelta / availableVarBudget) * 100)} % Reserve).`,
        color: C.textGreen,
        icon: 'v',
      });
    }
    const fixShare = personnelBudget > 0 ? Math.round((totalFixCost / personnelBudget) * 100) : 0;
    if (fixShare > 0) {
      insights.push({
        text: `Der Fixlohn-Anteil am Gesamtbudget beträgt ${fixShare} % (${fmtCHF(totalFixCost)} von ${fmtCHF(personnelBudget)}). Der variable Anteil liegt bei ${100 - fixShare} %.`,
        color: C.textMuted,
        icon: 'i',
      });
    }
  }
  if (proRataDay !== null) {
    insights.push({
      text: `Pro-Rata-Abgrenzung (Tag ${proRataDay}/${daysInSelectedMonth} = ${Math.round(proRataFactor * 100)} %): Aufgelaufene Personalkosten bis Stichtag: ${fmtCHF(proRataTotal)}.`,
      color: C.textGreen,
      icon: 'i',
    });
  }

  if (insights.length > 0) {
    needsPage(20 + insights.length * 14);
    drawSectionTitle(pdf, M, curY, W, 'Interpretation & Hinweise', [100, 116, 139] as [number, number, number]);
    curY += 10;

    for (const ins of insights) {
      needsPage(16);
      const bgMap: Record<string, [number, number, number]> = {
        [String(C.textRed)]:   [254, 242, 242],
        [String(C.textGreen)]: [240, 253, 244],
        [String(C.textBlue)]:  [239, 246, 255],
      };
      const bg: [number, number, number] = bgMap[String(ins.color)] ?? [249, 250, 251];
      const lines = pdf.splitTextToSize(ins.text, W - 16);
      const boxH  = Math.max(12, lines.length * 5 + 5);
      pdf.setFillColor(...bg);
      pdf.setDrawColor(...ins.color);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(M, curY, W, boxH, 1.5, 1.5, 'FD');
      pdf.setFillColor(...ins.color);
      pdf.rect(M, curY, 2, boxH, 'F');
      setFont(pdf, 'normal', 7.5, ins.color);
      pdf.text(lines, M + 6, curY + 5.5);
      curY += boxH + 4;
    }
  }

  // ── Footer auf allen Seiten ──────────────────────────────────────────────
  addFooter(pdf, monthLabel);

  // ── Speichern ────────────────────────────────────────────────────────────
  const year  = String(selectedYear);
  const month = String(selectedMonth).padStart(2, '0');
  pdf.save(`PersonalFix_${year}-${month}.pdf`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIABEL KOSTENVERGLEICH EXPORT (Plan oder Ist)
// ═══════════════════════════════════════════════════════════════════════════════

export interface VarKostenvergleichData {
  selectedYear: number;
  selectedMonth: number;
  varByDept: Record<string, VarRow[]>;
  totalVarHours: number;
  totalVarCost: number;
  source: 'plan' | 'ist';
}

export function exportVarKostenvergleich(data: VarKostenvergleichData): void {
  const { selectedYear, selectedMonth, varByDept, source } = data;
  const monthLabel   = getMonthLabel(selectedYear, selectedMonth);
  const sourceLabel  = source === 'plan' ? 'Plan' : 'Ist';
  const now          = new Date();
  const createdLabel = `Erstellt: ${now.toLocaleDateString('de-CH')}, ${now.toLocaleTimeString('de-CH')}`;

  const pdf    = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W      = pdf.internal.pageSize.getWidth();
  const H      = pdf.internal.pageSize.getHeight();
  const margin = 14;

  // ── Dept-Farben nach Quelle ────────────────────────────────────────────────

  const accentBg:   [number, number, number] = source === 'plan' ? C.lightBlue   : C.lightOrange;
  const accentText: [number, number, number] = source === 'plan' ? C.textBlue    : C.textOrange;
  const accentFill: [number, number, number] = source === 'plan' ? C.sectionBlue : C.sectionOrange;
  const footBg:     [number, number, number] = source === 'plan' ? [219, 234, 254] : [255, 237, 213];

  // ── Footer-Helfer ─────────────────────────────────────────────────────────

  const addFooter = () => {
    const pageCount = pdf.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);
      setFont(pdf, 'normal', 7, C.textMuted);
      const footerY = H - 8;
      pdf.text(`Variabel Kostenvergleich (${sourceLabel}) · ${monthLabel} · Oliv Gastro AG`, margin, footerY);
      pdf.text(createdLabel, W / 2, footerY, { align: 'center' });
      pdf.text(`Seite ${i} / ${pageCount}`, W - margin, footerY, { align: 'right' });
    }
  };

  let y = 0;

  const addPageIfNeeded = (space: number) => {
    if (y + space > H - 18) {
      addFooter();
      pdf.addPage();
      y = margin;
    }
  };

  // ── HEADER BANNER ─────────────────────────────────────────────────────────

  pdf.setFillColor(...accentFill);
  pdf.rect(0, 0, W, 22, 'F');

  setFont(pdf, 'bold', 14, C.white);
  pdf.text(`Variabel Kostenvergleich — ${sourceLabel}`, margin, 10);

  setFont(pdf, 'normal', 9, [200, 220, 255] as [number, number, number]);
  pdf.text(monthLabel, margin, 17);
  pdf.text('Oliv Gastro AG', W - margin, 17, { align: 'right' });

  y = 28;

  // Source-Info Banner
  pdf.setFillColor(...accentBg);
  pdf.roundedRect(margin, y, W - 2 * margin, 8, 1.5, 1.5, 'F');
  setFont(pdf, 'normal', 8, accentText);
  const srcTxt = source === 'plan'
    ? 'Quelle: Dienstplan Plan-Stunden'
    : 'Quelle: Dienstplan Ist-Stunden (Mirus-Import)';
  pdf.text(srcTxt, W / 2, y + 5, { align: 'center' });
  y += 12;

  // ── ABTEILUNGS-TABELLEN ───────────────────────────────────────────────────

  let grandHours = 0;
  let grandCost  = 0;

  const deptEntries = Object.entries(varByDept);

  for (const [dept, rows] of deptEntries) {
    if (!rows || rows.length === 0) continue;

    const deptLabel = DEPT_LABEL[dept] ?? dept;
    const deptHours = rows.reduce((s, r) => s + r.hours, 0);
    const deptCost  = rows.reduce((s, r) => s + r.monthlyCost, 0);
    grandHours += deptHours;
    grandCost  += deptCost;

    addPageIfNeeded(40);

    // Dept-Unterheader
    const deptBg: [number, number, number]   = dept === 'küche' ? [255, 237, 213] : [254, 226, 226];
    const deptTxt: [number, number, number]  = dept === 'küche' ? C.textOrange    : [185, 28, 28];
    pdf.setFillColor(...deptBg);
    pdf.rect(margin, y, W - 2 * margin, 7, 'F');
    setFont(pdf, 'bold', 9, deptTxt);
    pdf.text(`${deptLabel} (${rows.length})`, margin + 3, y + 4.8);
    if (deptHours > 0) {
      setFont(pdf, 'normal', 8, deptTxt);
      pdf.text(
        `${Math.round(deptHours * 10) / 10} h  →  ${fmtCHF(deptCost)}`,
        W - margin - 3, y + 4.8, { align: 'right' },
      );
    }
    y += 8;

    autoTable(pdf, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Name', 'Anstellung', 'Stundenlohn', `${sourceLabel}-Std./Mt`, 'Kosten/Mt', 'Kosten/Jahr']],
      body: rows.map(r => [
        r.emp.name,
        EMP_TYPE_LABEL[r.emp.employmentType] ?? r.emp.employmentType,
        r.hourlyWage > 0 ? `${fmtCHFDec(r.hourlyWage)}/h` : '–',
        r.hours > 0 ? `${Math.round(r.hours * 10) / 10} h` : '–',
        r.monthlyCost > 0 ? fmtCHF(r.monthlyCost) : '–',
        r.monthlyCost > 0 ? fmtCHF(r.monthlyCost * 12) : '–',
      ]),
      foot: [[
        `Total ${deptLabel}`, '', '',
        deptHours > 0 ? `${Math.round(deptHours * 10) / 10} h` : '–',
        deptCost  > 0 ? fmtCHF(deptCost)      : '–',
        deptCost  > 0 ? fmtCHF(deptCost * 12) : '–',
      ]],
      headStyles:    { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7.5, cellPadding: 2.5 },
      bodyStyles:    { fontSize: 8, cellPadding: { vertical: 2, horizontal: 3 } },
      footStyles:    { fillColor: footBg, textColor: accentText, fontStyle: 'bold', fontSize: 8, cellPadding: 2.5 },
      alternateRowStyles: { fillColor: C.rowGray },
      showFoot: 'lastPage',
      columnStyles: {
        0: { cellWidth: 'auto' },
        1: { cellWidth: 22 },
        2: { halign: 'right', cellWidth: 26 },
        3: { halign: 'right', cellWidth: 24 },
        4: { halign: 'right', cellWidth: 24 },
        5: { halign: 'right', cellWidth: 24 },
      },
    });

    y = (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  // ── GESAMT-TOTAL ──────────────────────────────────────────────────────────

  addPageIfNeeded(14);
  pdf.setFillColor(...accentFill);
  pdf.roundedRect(margin, y, W - 2 * margin, 11, 2, 2, 'F');
  setFont(pdf, 'bold', 9, C.white);
  pdf.text(`Total Variabel · alle Abteilungen — ${sourceLabel}`, margin + 4, y + 7);
  pdf.text(
    `${Math.round(grandHours * 10) / 10} h  ·  ${fmtCHF(grandCost)}/Mt  ·  ${fmtCHF(grandCost * 12)}/Jahr`,
    W - margin - 4, y + 7, { align: 'right' },
  );

  // ── Footer + Speichern ────────────────────────────────────────────────────

  addFooter();

  const yr  = String(selectedYear);
  const mo  = String(selectedMonth).padStart(2, '0');
  pdf.save(`PersonalVariabel_${sourceLabel}_${yr}-${mo}.pdf`);
}
