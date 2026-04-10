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

/** Seitennummer + Metadaten unten — verwendet dasselbe M wie die Hauptfunktion */
function addFooter(pdf: jsPDF, monthLabel: string, footerM = 14) {
  const pages = pdf.getNumberOfPages();
  const pw    = pdf.internal.pageSize.getWidth();
  const now   = new Date().toLocaleString('de-CH');
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    const ph = pdf.internal.pageSize.getHeight();
    pdf.setFillColor(...C.tableHead);
    pdf.rect(0, ph - 10, pw, 10, 'F');
    pdf.setDrawColor(...C.borderGray);
    pdf.setLineWidth(0.3);
    pdf.line(footerM, ph - 10, pw - footerM, ph - 10);
    setFont(pdf, 'normal', 6, C.textMuted);
    pdf.text(`Personal FIX + VARIABEL — ${monthLabel} — Oliv Gastro AG`, footerM, ph - 4);
    pdf.text(`Erstellt: ${now}`, pw / 2, ph - 4, { align: 'center' });
    setFont(pdf, 'bold', 6, C.textMuted);
    pdf.text(`${i} / ${pages}`, pw - footerM, ph - 4, { align: 'right' });
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

  // ── Seitenraster-Konstanten ────────────────────────────────────────────────
  const pdf  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw   = pdf.internal.pageSize.getWidth();   // 210
  const ph   = pdf.internal.pageSize.getHeight();  // 297
  const M    = 14;            // Rand links/rechts/top (neue Seite)
  const FOOT = 18;            // Platz unten für Footer
  const W    = pw - M * 2;   // Nutzbreite: 182 mm
  const BOTTOM = ph - FOOT;  // unterste nutzbare Y-Position

  // Abstände (mm)
  const SP_SECTION = 10;  // Abstand vor einer neuen Sektion
  const SP_BLOCK   = 7;   // Abstand zwischen Blöcken innerhalb einer Sektion
  const SP_ITEM    = 5;   // kleiner Abstand (z.B. nach Dept-Tabelle)

  // Zell-Padding für alle autoTable-Aufrufe
  const CP = { top: 3.5, bottom: 3.5, left: 4, right: 4 };

  // ── Seitenumbruch-Helfer ───────────────────────────────────────────────────
  // Gibt true zurück wenn eine neue Seite erstellt wurde
  function needsPage(space: number): boolean {
    if (curY + space > BOTTOM) {
      pdf.addPage();
      curY = M;
      return true;
    }
    return false;
  }

  // ── Berechnete Werte ───────────────────────────────────────────────────────
  const varModeLabel = varView === 'plan' ? 'Plan-Stunden'
    : varView === 'ist' ? 'Ist-Stunden (Mirus)' : 'Manuelle Eingabe';
  const varModeBadge = varView === 'plan' ? 'PLAN' : varView === 'ist' ? 'IST' : 'MANUELL';
  const varModeLong  = varView === 'plan' ? 'PLAN-STUNDEN' : varView === 'ist' ? 'IST-STUNDEN (MIRUS)' : 'MANUELLE EINGABE';
  const totalNetCHF  = totalFixCost + totalVariabelCHF;
  const budgetAvailForVar = personnelBudget > 0 ? Math.max(0, personnelBudget - totalFixCost) : 0;
  const overrun = varBudgetDelta < 0;

  // ════════════════════════════════════════════════════════════════════════════
  // SEITE 1 — Header · KPI-Block · Budget-Analyse
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. HEADER-BANNER (volle Seitenbreite) ─────────────────────────────────
  const HDR_H = 30;
  pdf.setFillColor(...C.headerBlue);
  pdf.rect(0, 0, pw, HDR_H, 'F');
  // untere Akzentlinie
  pdf.setFillColor(37, 99, 235);
  pdf.rect(0, HDR_H - 2, pw, 2, 'F');

  // Links: Titel + Untertitel
  setFont(pdf, 'bold', 17, C.white);
  pdf.text('Personal FIX + VARIABEL', M, 13);
  setFont(pdf, 'normal', 8, [186, 210, 255] as [number, number, number]);
  pdf.text('Personalkosten-Controlling  ·  Oliv Gastro AG', M, 21);

  // Rechts: Monat + Modus-Pill
  setFont(pdf, 'bold', 11, C.white);
  pdf.text(monthLabel, pw - M, 13, { align: 'right' });

  // Modus-Pill (gerundet, farblich hervorgehoben)
  const pillTxt  = `Stundenbasis: ${varModeLong}`;
  const pillFS   = 6.5;
  const pillW    = pdf.getStringUnitWidth(pillTxt) * pillFS / pdf.internal.scaleFactor + 10;
  const pillX    = pw - M - pillW;
  const pillY    = HDR_H - 10;
  const pillH    = 6;
  pdf.setFillColor(29, 78, 216);
  pdf.roundedRect(pillX, pillY, pillW, pillH, 1.5, 1.5, 'F');
  setFont(pdf, 'bold', pillFS, C.white);
  pdf.text(pillTxt, pillX + pillW / 2, pillY + 4, { align: 'center' });

  let curY = HDR_H + SP_BLOCK;

  // ── 2. KPI-BLOCK: 3 grosse Karten ─────────────────────────────────────────
  // Breite: (182 − 2 × 4 Abstand) / 3 = 58 mm
  const KPI_GAP = 4;
  const KPI_W   = (W - KPI_GAP * 2) / 3;
  const KPI_H   = 36;

  // Hilfs-Lambda — alle Karten bei gleichem curY
  const drawMainKpi = (
    x: number,
    title: string, value: string, sub: string,
    accent: [number, number, number],
    bg: [number, number, number],
    badge?: string,
  ) => {
    const kY = curY;
    pdf.setFillColor(...bg);
    pdf.setDrawColor(...accent);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(x, kY, KPI_W, KPI_H, 2, 2, 'FD');
    // Akzent-Streifen links
    pdf.setFillColor(...accent);
    pdf.rect(x, kY + 2, 2.5, KPI_H - 4, 'F');
    const ix = x + 7;
    // Titel (uppercase, gedimmt)
    setFont(pdf, 'normal', 6, C.textMuted);
    pdf.text(title.toUpperCase(), ix, kY + 7);
    // Betrag (gross, Akzentfarbe)
    setFont(pdf, 'bold', 15, accent);
    pdf.text(value, ix, kY + 19);
    // Modus-Badge (nur bei Variable)
    let subY = kY + 23;
    if (badge) {
      const bTxt = badge;
      const bW   = pdf.getStringUnitWidth(bTxt) * 6 / pdf.internal.scaleFactor + 6;
      pdf.setFillColor(255, 237, 213);
      pdf.setDrawColor(251, 146, 60);
      pdf.setLineWidth(0.2);
      pdf.roundedRect(ix, kY + 22, bW, 5, 1, 1, 'FD');
      setFont(pdf, 'bold', 5.5, C.textOrange);
      pdf.text(bTxt, ix + 3, kY + 25.5);
      subY = kY + 30;
    }
    // Subtext
    setFont(pdf, 'normal', 6.5, C.textMuted);
    pdf.text(pdf.splitTextToSize(sub, KPI_W - 10)[0] ?? '', ix, subY);
  };

  const nFixEmpsTotal = Object.values(byDept).flat().length;
  const nVarEmpsTotal = Object.values(varByDept).flat().length;
  const totalSub = totalFerienabbauCHF > 0
    ? `FIX + Variabel − ${fmtCHF(totalFerienabbauCHF)} Ferienabbau`
    : 'FIX + VARIABEL kombiniert';
  const varSub = totalVarHours > 0
    ? `${Math.round(totalVarHours * 10) / 10} h × Stundenlohn · ${nVarEmpsTotal} MA`
    : `${nVarEmpsTotal} Mitarbeiter · Stunden wählen`;

  drawMainKpi(M,                  'Personal FIX / Monat',    fmtCHF(totalFixCost),
    `${nFixEmpsTotal} Mitarbeiter mit Fixlohn`, C.sectionBlue,   [244, 247, 255] as [number, number, number]);
  drawMainKpi(M + KPI_W + KPI_GAP, 'Variable Arbeit / Monat', fmtCHF(totalVarArbeitCHF),
    varSub, C.sectionOrange, [255, 251, 245] as [number, number, number],
    `● ${varModeBadge}-STUNDEN`);
  drawMainKpi(M + 2*(KPI_W + KPI_GAP), 'Total Personal / Monat',  fmtCHF(totalNetCHF),
    totalSub, C.sectionGreen,  [244, 255, 250] as [number, number, number]);

  curY += KPI_H + SP_BLOCK;

  // ── 2b. BUDGET-KPI-ZEILE (nur wenn Budget gesetzt) ────────────────────────
  if (personnelBudget > 0) {
    const BKH = 26;   // Budget-Karten-Höhe
    const fixDiff = totalFixCost - personnelBudget;
    const totDiff = totalCombined - personnelBudget;

    // Karte 1: FIX vs. Budget
    drawKpiCard(pdf, M, curY, KPI_W, BKH,
      'Personal FIX vs. Budget',
      fmtCHF(Math.abs(fixDiff)),
      fixDiff <= 0 ? `${fmtCHF(-fixDiff)} unter Budget` : `${fmtCHF(fixDiff)} über Budget`,
      fixDiff <= 0 ? C.sectionGreen : [220, 38, 38] as [number, number, number],
      fixDiff <= 0 ? C.lightGreen   : C.lightRed,
      undefined, { amount: fixDiff, label: '' });

    // Karte 2: Total vs. Budget
    drawKpiCard(pdf, M + KPI_W + KPI_GAP, curY, KPI_W, BKH,
      'Total Personal vs. Budget',
      fmtCHF(Math.abs(totDiff)),
      totDiff <= 0 ? `${fmtCHF(-totDiff)} unter Budget` : `${fmtCHF(totDiff)} über Budget`,
      totDiff <= 0 ? C.sectionGreen : [220, 38, 38] as [number, number, number],
      totDiff <= 0 ? C.lightGreen   : C.lightRed,
      undefined, { amount: totDiff, label: '' });

    // Karte 3: Monatsbudget (neutral)
    drawKpiCard(pdf, M + 2*(KPI_W + KPI_GAP), curY, KPI_W, BKH,
      'Personalbudget Gesamt',
      fmtCHF(personnelBudget),
      `Verfügbar Variabel: ${fmtCHF(budgetAvailForVar)}`,
      C.headerGray, C.borderGray);

    curY += BKH + SP_BLOCK;
  }

  // ── 2c. Ferienabbau-Infozeile (wenn vorhanden) ────────────────────────────
  if (totalFerienabbauCHF > 0) {
    const fH = 8;
    pdf.setFillColor(239, 246, 255);
    pdf.setDrawColor(191, 219, 254);
    pdf.setLineWidth(0.25);
    pdf.roundedRect(M, curY, W, fH, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionBlue);
    pdf.rect(M, curY, 2, fH, 'F');
    setFont(pdf, 'bold', 7, C.textBlue);
    pdf.text('Ferienabbau:', M + 5, curY + 5.2);
    setFont(pdf, 'normal', 7, C.textBlue);
    pdf.text(
      `${fmtCHF(totalFerienabbauCHF)} werden von den variablen Kosten abgezogen (FE-Einträge im Ist-Dienstplan).`,
      M + 31, curY + 5.2,
    );
    curY += fH + SP_BLOCK;
  }

  // ── 3. BUDGET-ANALYSE (zweispaltig) ───────────────────────────────────────
  if (personnelBudget > 0) {
    needsPage(70);

    // Section-Titel
    drawSectionTitle(pdf, M, curY, W,
      `Budget-Analyse Personalkosten — ${monthLabel}`, C.textViolet);
    curY += SP_SECTION;

    // Spalten: gleiche Breite, Abstand 6 mm
    const colW  = (W - 6) / 2;
    const rowH  = 9;     // Höhe jeder Budget-Zeile
    const rxBdg = M + colW + 6;

    // Spaltentitel
    setFont(pdf, 'bold', 6.5, C.textMuted);
    pdf.text('BUDGETVERTEILUNG', M, curY);
    pdf.text('SCHÄTZUNG VS. BUDGET', rxBdg, curY);
    curY += 4;

    // LINKE Spalte
    let ly = curY;
    ly = drawBudgetRow(pdf, M, ly, colW, rowH,
      'Personalbudget gesamt',  fmtCHF(personnelBudget),  C.textMuted, C.black, true);
    ly = drawBudgetRow(pdf, M, ly, colW, rowH,
      '− Personal FIX',         `− ${fmtCHF(totalFixCost)}`, C.textMuted, C.textBlue);
    // Ergebnis-Zeile links
    const lvBg: [number, number, number] = budgetAvailForVar > 0 ? C.lightGreen : C.lightRed;
    const lvTx: [number, number, number] = budgetAvailForVar > 0 ? C.textGreen  : C.textRed;
    pdf.setFillColor(...lvBg);
    pdf.roundedRect(M, ly, colW, rowH, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 8, lvTx);
    pdf.text('= Verfügbar für Variabel', M + 4, ly + rowH / 2 + 3);
    pdf.text(fmtCHF(budgetAvailForVar), M + colW - 4, ly + rowH / 2 + 3, { align: 'right' });
    const leftEnd = ly + rowH + SP_ITEM;

    // RECHTE Spalte
    let ry = curY;
    ry = drawBudgetRow(pdf, rxBdg, ry, colW, rowH,
      'Verfügbar für Variabel',             fmtCHF(budgetAvailForVar), C.textMuted, C.black);
    ry = drawBudgetRow(pdf, rxBdg, ry, colW, rowH,
      `− Variable Arbeit (${varModeBadge})`, `− ${fmtCHF(totalVarArbeitCHF)}`, C.textMuted, C.textOrange);
    if (totalFerienabbauCHF > 0) {
      ry = drawBudgetRow(pdf, rxBdg, ry, colW, rowH,
        '+ Ferienabbau-Abzug', `− ${fmtCHF(totalFerienabbauCHF)}`,
        C.textMuted, [29, 78, 216] as [number, number, number]);
      ry = drawBudgetRow(pdf, rxBdg, ry, colW, rowH,
        '= Netto Variabel', fmtCHF(totalVariabelCHF), C.textMuted, C.textOrange, true);
    }
    // Ergebnis-Zeile rechts
    const rvBg: [number, number, number] = !overrun ? C.lightGreen : C.lightRed;
    const rvTx: [number, number, number] = !overrun ? C.textGreen  : C.textRed;
    pdf.setFillColor(...rvBg);
    pdf.roundedRect(rxBdg, ry, colW, rowH, 1.5, 1.5, 'F');
    setFont(pdf, 'bold', 8, rvTx);
    pdf.text(!overrun ? '✓ Verbleibend' : '⚠ Überziehung', rxBdg + 4, ry + rowH / 2 + 3);
    pdf.text(
      `${!overrun ? '+ ' : '– '}${fmtCHF(Math.abs(varBudgetDelta))}`,
      rxBdg + colW - 4, ry + rowH / 2 + 3, { align: 'right' });
    const rightEnd = ry + rowH + SP_ITEM;

    curY = Math.max(leftEnd, rightEnd) + SP_BLOCK;

    // Planungshinweis-Balken
    if (avgHourlyWage > 0) {
      const hBg: [number, number, number] = overrun
        ? C.lightRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [254, 249, 195] : C.lightGreen;
      const hTx: [number, number, number] = overrun
        ? C.textRed
        : varBudgetDelta < availableVarBudget * 0.15 ? [133, 77, 14] : C.textGreen;
      const hintH = 14;
      pdf.setFillColor(...hBg);
      pdf.setDrawColor(...hTx);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(M, curY, W, hintH, 1.5, 1.5, 'FD');
      pdf.setFillColor(...hTx);
      pdf.rect(M, curY, 2, hintH, 'F');

      let line1: string;
      if (overrun) {
        const red = Math.ceil(Math.abs(varBudgetDelta) / avgHourlyWage);
        line1 = `⚠  Budget überschritten — ca. ${red} Stunden reduzieren, um das Budget einzuhalten.`;
      } else if (varBudgetDelta < availableVarBudget * 0.15) {
        line1 = 'Budget nahezu ausgeschöpft — weniger als 15 % Spielraum verbleiben.';
      } else {
        const remH = Math.max(0, maxVarHours - Math.round(totalVarHours));
        line1 = `Budget im grünen Bereich — noch ca. ${remH} Stunden planbar.`;
      }
      const line2 = `Ø Stundenlohn: ${fmtCHFDec(avgHourlyWage)}/h  ·  Budget Variabel: ${fmtCHF(budgetAvailForVar)}  ·  Variable Arbeit: ${fmtCHF(totalVarArbeitCHF)} (${varModeBadge})`;

      setFont(pdf, 'bold', 7.5, hTx);
      pdf.text(line1, M + 5, curY + 5.5);
      setFont(pdf, 'normal', 6.5, hTx);
      pdf.text(line2, M + 5, curY + 11);
      curY += hintH + SP_BLOCK;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SEITE 2+ — Abteilungsübersicht · Detail-Tabellen
  // ════════════════════════════════════════════════════════════════════════════

  // ── 4. ABTEILUNGSÜBERSICHT ────────────────────────────────────────────────
  if (deptSummary.length > 0 && (totalFixCost > 0 || totalVarArbeitCHF > 0)) {
    needsPage(52);
    drawSectionTitle(pdf, M, curY, W,
      `Personalkosten nach Abteilung — ${monthLabel}`, [109, 40, 217] as [number, number, number]);
    curY += SP_SECTION;

    // Spaltenbreiten: Kategorie=50, je Abt. und Total = (182-50) / (n+1)
    const labelW = 50;
    const n      = deptSummary.length;
    const numW   = (W - labelW) / (n + 1);

    const deptCols = deptSummary.map(ds => DEPT_LABEL[ds.dept] ?? ds.dept);
    const fix    = ['FIX',            ...deptSummary.map(ds => fmtCHF(ds.fix)),       fmtCHF(totalFixCost)];
    const varA   = ['Variable Arbeit', ...deptSummary.map(ds => fmtCHF(ds.varArbeit)), fmtCHF(totalVarArbeitCHF)];
    const feRow  = ['− Ferienabbau',   ...deptSummary.map(ds => ds.ferienabbau > 0 ? `− ${fmtCHF(ds.ferienabbau)}` : '–'),
      totalFerienabbauCHF > 0 ? `− ${fmtCHF(totalFerienabbauCHF)}` : '–'];
    const varNet = ['Netto Variabel',  ...deptSummary.map(ds => fmtCHF(ds.variabel)),  fmtCHF(totalVariabelCHF)];
    const totRow = ['TOTAL PERSONAL',  ...deptSummary.map(ds => fmtCHF(ds.total)),
      fmtCHF(totalFixCost + totalVariabelCHF)];

    autoTable(pdf, {
      startY: curY,
      margin: { left: M, right: M },
      head: [['Kategorie', ...deptCols, 'Gesamt']],
      body: [fix, varA, ...(totalFerienabbauCHF > 0 ? [feRow] : []), varNet],
      foot: [totRow],
      theme: 'plain',
      styles: { fontSize: 8.5, cellPadding: CP, lineColor: C.borderGray, lineWidth: 0.2 },
      headStyles: {
        fillColor: C.headerBlue, textColor: C.white,
        fontStyle: 'bold', fontSize: 8, cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
      },
      footStyles: {
        fillColor: C.sectionGreen, textColor: C.white,
        fontStyle: 'bold', fontSize: 8.5, cellPadding: { top: 4, bottom: 4, left: 4, right: 4 },
      },
      columnStyles: {
        0: { cellWidth: labelW, fontStyle: 'bold' },
        ...Object.fromEntries(
          Array.from({ length: n + 1 }, (_, i) => [i + 1, { cellWidth: numW, halign: 'right' as const }])
        ),
      },
      alternateRowStyles: { fillColor: C.rowGray },
      didParseCell(h) {
        if (h.section === 'body') {
          const label = (h.row.raw as string[])[0];
          if (label === 'FIX')            { h.cell.styles.textColor = C.textBlue; }
          if (label === 'Variable Arbeit'){ h.cell.styles.textColor = C.textOrange; }
          if (label === '− Ferienabbau')  { h.cell.styles.textColor = [29, 78, 216]; }
          if (label === 'Netto Variabel') { h.cell.styles.textColor = C.textOrange; h.cell.styles.fontStyle = 'bold'; }
          if (h.column.index > 0) h.cell.styles.halign = 'right';
        }
        if (h.section === 'foot') h.cell.styles.halign = h.column.index === 0 ? 'left' : 'right';
      },
    });
    curY = (pdf as any).lastAutoTable.finalY + SP_SECTION;
  }

  // ── 5a. DETAIL — Personal FIX ─────────────────────────────────────────────
  // Spaltenbreiten FIX-Tabelle: Name(60) + Typ(22) + Basis(24) + 13.(24) + FIX/Mt(26) + FIX/J(26) = 182 ✓
  const FIX_COLS = { 0: 60, 1: 22, 2: 24, 3: 24, 4: 26, 5: 26 };

  const fixDepts    = Object.keys(byDept);
  const nFixEmpsTot = fixDepts.reduce((s, d) => s + byDept[d].length, 0);

  if (nFixEmpsTot > 0) {
    needsPage(42);
    drawSectionTitle(pdf, M, curY, W,
      `Personal FIX — Garantierter Monatslohn  (${nFixEmpsTot} MA)`, C.sectionBlue);
    curY += SP_SECTION;

    for (const dept of fixDepts) {
      const rows = byDept[dept];
      if (!rows?.length) continue;

      const deptTotal = rows.reduce((s, r) => s + r.cost, 0);
      const deptBase  = rows.reduce((s, r) => s + (r.emp.monthlySalary ?? 0), 0);

      // Dept-Subheader + Tabelle zusammenhalten (min. 28 mm)
      needsPage(28);
      drawDeptSubheader(pdf, M, curY, W, dept, rows.length,
        `Basis ${fmtCHF(deptBase)}/Mt  ·  FIX ${fmtCHF(deptTotal)}/Mt`,
        C.sectionBlue, [239, 246, 255]);
      curY += 7;

      autoTable(pdf, {
        startY: curY,
        margin: { left: M, right: M },
        head: [['Name', 'Anstellung', 'Basis/Mt', 'inkl. 13./Mt', 'FIX/Monat', 'FIX/Jahr']],
        body: rows.map(({ emp, cost, label, yearlyCost }) => [
          emp.name + (label ? `  (${label})` : ''),
          EMP_TYPE_LABEL[emp.employmentType] ?? emp.employmentType,
          emp.monthlySalary         ? fmtCHFDec(emp.monthlySalary)         : '–',
          emp.monthlySalaryWith13th ? fmtCHFDec(emp.monthlySalaryWith13th) : '–',
          cost      > 0 ? fmtCHF(cost)      : '–',
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
        styles: { fontSize: 8, cellPadding: CP, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightBlue, textColor: C.textBlue, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: FIX_COLS[0], fontStyle: 'bold' },
          1: { cellWidth: FIX_COLS[1], halign: 'center' },
          2: { cellWidth: FIX_COLS[2], halign: 'right' },
          3: { cellWidth: FIX_COLS[3], halign: 'right' },
          4: { cellWidth: FIX_COLS[4], halign: 'right', textColor: C.textBlue, fontStyle: 'bold' },
          5: { cellWidth: FIX_COLS[5], halign: 'right', textColor: C.textMuted },
        },
        didParseCell(h) {
          if (h.section === 'body' && h.column.index === 0) {
            if (rows[h.row.index]?.label) h.cell.styles.textColor = [180, 83, 9];
          }
          if (h.section === 'foot' && h.column.index >= 2) h.cell.styles.halign = 'right';
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + SP_ITEM;
    }

    // Total-FIX-Band
    needsPage(12);
    const tfH = 11;
    pdf.setFillColor(219, 234, 254);
    pdf.setDrawColor(...C.sectionBlue);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(M, curY, W, tfH, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionBlue);
    pdf.rect(M, curY, 3, tfH, 'F');
    setFont(pdf, 'bold', 8, C.textBlue);
    pdf.text('Total Personal FIX · alle Abteilungen', M + 7, curY + 7);
    setFont(pdf, 'normal', 7, C.textMuted);
    pdf.text(`Basis: ${fmtCHF(totalFixBase)}/Mt`, pw - M - 80, curY + 7);
    setFont(pdf, 'bold', 9, C.textBlue);
    pdf.text(fmtCHF(totalFixCost), pw - M - 36, curY + 7, { align: 'right' });
    setFont(pdf, 'normal', 7, C.textMuted);
    pdf.text(`| Jahr: ${fmtCHF(totalFixAnnual)}`, pw - M - 2, curY + 7, { align: 'right' });
    curY += tfH + SP_SECTION;
  }

  // ── 5b. DETAIL — Variable Mitarbeiter ─────────────────────────────────────
  // Spaltenbreiten VAR-Tabelle: Name(66) + Typ(22) + Lohn(28) + Std(28) + Kosten/Mt(38) = 182 ✓
  const VAR_COLS = { 0: 66, 1: 22, 2: 28, 3: 28, 4: 38 };

  const varDepts    = Object.keys(varByDept);
  const nVarEmpsTot = varDepts.reduce((s, d) => s + varByDept[d].length, 0);
  const hH          = varView === 'plan' ? 'Plan-Std./Mt' : varView === 'ist' ? 'Ist-Std./Mt' : 'Std./Mt';

  if (nVarEmpsTot > 0) {
    needsPage(42);
    drawSectionTitle(pdf, M, curY, W,
      `Variable Mitarbeiter — ${varModeLabel}  (${nVarEmpsTot} MA)`, C.sectionOrange);
    curY += SP_SECTION;

    for (const dept of varDepts) {
      const rows = varByDept[dept];
      if (!rows?.length) continue;

      const deptHours = rows.reduce((s, r) => s + r.hours, 0);
      const deptCost  = rows.reduce((s, r) => s + r.monthlyCost, 0);
      const sumTxt    = deptHours > 0
        ? `${Math.round(deptHours * 10) / 10} h  →  ${fmtCHF(deptCost)}`
        : fmtCHF(deptCost);

      needsPage(28);
      drawDeptSubheader(pdf, M, curY, W, dept, rows.length, sumTxt, C.sectionOrange, [255, 251, 235]);
      curY += 7;

      autoTable(pdf, {
        startY: curY,
        margin: { left: M, right: M },
        head: [['Name', 'Anstellung', 'Stundenlohn', hH, 'Kosten/Monat']],
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
        styles: { fontSize: 8, cellPadding: CP, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightOrange, textColor: C.textOrange, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: VAR_COLS[0], fontStyle: 'bold' },
          1: { cellWidth: VAR_COLS[1], halign: 'center' },
          2: { cellWidth: VAR_COLS[2], halign: 'right', textColor: C.textMuted },
          3: { cellWidth: VAR_COLS[3], halign: 'right' },
          4: { cellWidth: VAR_COLS[4], halign: 'right', textColor: C.textOrange, fontStyle: 'bold' },
        },
        didParseCell(h) {
          if (h.section === 'foot' && h.column.index >= 3) h.cell.styles.halign = 'right';
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + SP_ITEM;
    }

    // Total-Variabel-Band (mit Ferienabbau-Split wenn vorhanden)
    const tvH = totalFerienabbauCHF > 0 ? 23 : 11;
    needsPage(tvH + SP_BLOCK);
    pdf.setFillColor(...C.lightOrange);
    pdf.setDrawColor(...C.sectionOrange);
    pdf.setLineWidth(0.4);
    pdf.roundedRect(M, curY, W, tvH, 1.5, 1.5, 'FD');
    pdf.setFillColor(...C.sectionOrange);
    pdf.rect(M, curY, 3, tvH, 'F');

    if (totalFerienabbauCHF > 0) {
      setFont(pdf, 'bold', 7.5, C.textOrange);
      pdf.text('Total Variable Arbeit:', M + 7, curY + 6.5);
      setFont(pdf, 'bold', 8, C.textOrange);
      pdf.text(fmtCHF(totalVarArbeitCHF), pw - M - 2, curY + 6.5, { align: 'right' });
      setFont(pdf, 'bold', 7.5, [29, 78, 216] as [number, number, number]);
      pdf.text('− Ferienabbau-Abzug:', M + 7, curY + 14);
      pdf.text(`− ${fmtCHF(totalFerienabbauCHF)}`, pw - M - 2, curY + 14, { align: 'right' });
      pdf.setDrawColor(...C.sectionOrange);
      pdf.setLineWidth(0.3);
      pdf.line(M + 4, curY + 16.5, pw - M - 4, curY + 16.5);
      setFont(pdf, 'bold', 8.5, C.textOrange);
      pdf.text('= Netto Variabel · alle Abteilungen', M + 7, curY + 21);
      pdf.text(`${fmtCHF(totalVariabelCHF)}/Mt`, pw - M - 2, curY + 21, { align: 'right' });
    } else {
      setFont(pdf, 'bold', 8.5, C.textOrange);
      pdf.text('Total Variabel · alle Abteilungen', M + 7, curY + 7.5);
      pdf.text(`${fmtCHF(totalVariabelCHF)}/Mt`, pw - M - 2, curY + 7.5, { align: 'right' });
    }
    curY += tvH + SP_SECTION;
  }

  // ── PRO-RATA (optional) ───────────────────────────────────────────────────
  if (proRataDay !== null) {
    const pctLbl = `${Math.round(proRataFactor * 100)} %`;
    needsPage(55);
    drawSectionTitle(pdf, M, curY, W,
      `Pro-Rata-Abgrenzung — bis Tag ${proRataDay} von ${daysInSelectedMonth}  (${pctLbl})`,
      C.sectionGreen);
    curY += SP_SECTION;

    // 3 gleichgrosse Karten
    const PRW = (W - KPI_GAP * 2) / 3;
    const PRH = 24;
    const drawProCard = (
      x: number, lbl: string, val: string, from: string,
      col: [number,number,number], bg: [number,number,number],
    ) => {
      const ky = curY;
      pdf.setFillColor(...bg);
      pdf.setDrawColor(...col);
      pdf.setLineWidth(0.4);
      pdf.roundedRect(x, ky, PRW, PRH, 2, 2, 'FD');
      pdf.setFillColor(...col);
      pdf.rect(x, ky + 2, 2.5, PRH - 4, 'F');
      setFont(pdf, 'normal', 6, C.textMuted);
      pdf.text(lbl.toUpperCase(), x + 5, ky + 6);
      setFont(pdf, 'bold', 12, col);
      pdf.text(val, x + 5, ky + 15);
      setFont(pdf, 'normal', 6.5, C.textMuted);
      pdf.text(`von ${from}`, x + 5, ky + 21);
    };
    drawProCard(M,                   `FIX bis ${proRataDay}.`,      fmtCHF(proRataFixCost), fmtCHF(totalFixCost),                    C.sectionBlue,   C.lightBlue);
    drawProCard(M + PRW + KPI_GAP,   `Variabel bis ${proRataDay}.`, fmtCHF(proRataVarCost), fmtCHF(totalVariabelCHF),                C.sectionOrange, C.lightOrange);
    drawProCard(M + 2*(PRW+KPI_GAP), `Total bis ${proRataDay}.`,    fmtCHF(proRataTotal),   fmtCHF(totalFixCost + totalVariabelCHF), C.sectionGreen,  C.lightGreen);
    curY += PRH + SP_BLOCK;

    if (proRataVarByEmp.length > 0) {
      // Pro-Rata-Tabelle: Name(52)+Dept(18)+Std(24)+FE(26)+Netto(28)+ProRata(34) = 182 ✓
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
        styles: { fontSize: 8, cellPadding: CP, lineColor: C.borderGray, lineWidth: 0.2 },
        headStyles: { fillColor: C.tableHead, textColor: C.headerGray, fontStyle: 'bold', fontSize: 7 },
        footStyles: { fillColor: C.lightGreen, textColor: C.textGreen, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: C.rowGray },
        columnStyles: {
          0: { cellWidth: 52, fontStyle: 'bold' },
          1: { cellWidth: 18 },
          2: { cellWidth: 24, halign: 'right' },
          3: { cellWidth: 26, halign: 'right', textColor: [29, 78, 216] as [number, number, number] },
          4: { cellWidth: 28, halign: 'right' },
          5: { cellWidth: 34, halign: 'right', textColor: C.textGreen, fontStyle: 'bold' },
        },
        didParseCell(h) {
          if (h.section === 'foot') {
            h.cell.styles.halign = h.column.index === 0 ? 'left' : 'right';
            if (h.column.index === 5) h.cell.styles.textColor = C.textGreen;
          }
        },
      });
      curY = (pdf as any).lastAutoTable.finalY + SP_SECTION;
    }
  }

  // ── 6. INTERPRETATION & HINWEISE ──────────────────────────────────────────
  type Insight = { text: string; col: [number, number, number]; bg: [number, number, number] };
  const insights: Insight[] = [];

  if (totalFerienabbauCHF > 0) {
    insights.push({
      text: `Ferienabbau: Ein Teil der variablen Kosten (${fmtCHF(totalFerienabbauCHF)}) ist auf Ferienabbau zurückzuführen. Die Netto-Variabelkosten betragen ${fmtCHF(totalVariabelCHF)} (Brutto-Variabel: ${fmtCHF(totalVarArbeitCHF)}).`,
      col: C.textBlue,
      bg:  [239, 246, 255] as [number, number, number],
    });
  }
  if (personnelBudget > 0) {
    if (overrun) {
      insights.push({
        text: `Budget überschritten: Variable Kosten übersteigen das verfügbare Variabel-Budget um ${fmtCHF(Math.abs(varBudgetDelta))}. Bitte variable Schichten entsprechend reduzieren.`,
        col: C.textRed,
        bg:  [254, 242, 242] as [number, number, number],
      });
    } else if (varBudgetDelta < availableVarBudget * 0.15) {
      insights.push({
        text: `Budget knapp: Nur noch ${fmtCHF(varBudgetDelta)} (${Math.round((varBudgetDelta / availableVarBudget) * 100)} %) des Variabel-Budgets verbleiben. Zusätzliche Schichten könnten das Budget überschreiten.`,
        col: [133, 77, 14] as [number, number, number],
        bg:  [254, 249, 195] as [number, number, number],
      });
    } else {
      insights.push({
        text: `Budget im Rahmen: Personalkosten liegen innerhalb des Budgets. Verbleibendes Variabel-Budget: ${fmtCHF(varBudgetDelta)} (${Math.round((varBudgetDelta / availableVarBudget) * 100)} % Reserve).`,
        col: C.textGreen,
        bg:  [240, 253, 244] as [number, number, number],
      });
    }
    const fixShare = Math.round((totalFixCost / personnelBudget) * 100);
    insights.push({
      text: `Kostenstruktur: Fixlohn-Anteil am Gesamtbudget: ${fixShare} % (${fmtCHF(totalFixCost)} von ${fmtCHF(personnelBudget)}). Variabel-Anteil: ${100 - fixShare} %.`,
      col: C.textMuted,
      bg:  C.rowGray,
    });
  }
  if (proRataDay !== null) {
    insights.push({
      text: `Pro-Rata-Abgrenzung (Tag ${proRataDay}/${daysInSelectedMonth} = ${Math.round(proRataFactor * 100)} %): Aufgelaufene Personalkosten bis Stichtag: ${fmtCHF(proRataTotal)}.`,
      col: C.textGreen,
      bg:  [240, 253, 244] as [number, number, number],
    });
  }

  if (insights.length > 0) {
    // Interpretation möglichst am Ende der letzten Seite, aber auf neuer Seite falls zu wenig Platz
    needsPage(22 + insights.length * 16);
    drawSectionTitle(pdf, M, curY, W, 'Interpretation & Hinweise', C.headerGray);
    curY += SP_SECTION;

    for (const ins of insights) {
      const lines = pdf.splitTextToSize(ins.text, W - 14);
      const boxH  = Math.max(12, lines.length * 5.5 + 5);
      needsPage(boxH + 3);
      pdf.setFillColor(...ins.bg);
      pdf.setDrawColor(...ins.col);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(M, curY, W, boxH, 1.5, 1.5, 'FD');
      pdf.setFillColor(...ins.col);
      pdf.rect(M, curY, 2.5, boxH, 'F');
      setFont(pdf, 'normal', 7.5, ins.col);
      pdf.text(lines, M + 6, curY + 6);
      curY += boxH + SP_ITEM;
    }
  }

  // ── Footer auf allen Seiten ───────────────────────────────────────────────
  addFooter(pdf, monthLabel, M);

  // ── Speichern ─────────────────────────────────────────────────────────────
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
