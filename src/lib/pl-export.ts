/**
 * pl-export.ts – Professioneller PDF-Export für die Erfolgsrechnung
 * ==================================================================
 *
 * Modi:
 *   budget_pl: Budget P&L  – Ist | Ist% | Budget | Bud% | Abw.Bud CHF | VJ | VJ% | Abw.VJ CHF
 *   monthly:   Klassisch   – Ist | Ist% | VJ | VJ% | Abw.VJ CHF
 *   yearly:    Jahresübersicht – 12 Monate + Total
 *
 * Optionale Blöcke (PLExportOptions):
 *   1. Monatsreport – vollständige Erfolgsrechnung für den gewählten Monat
 *   2. Vormonatsvergleich – Kennzahlen aktueller Monat vs. Vormonat
 *   3. Kumulierte Übersicht – Jan bis gewählter Monat
 *   4. Ausgewählte Monate – Summe über benutzerdefinierte Monatsauswahl
 *
 * Format: A4 Hochformat (210 × 297 mm)
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { PLMonthResult, PLYearResult, PLComputedRow } from '@/types/pl';
import { MONTH_NAMES_SHORT_DE, MONTH_NAMES_DE } from '@/types/reporting';
import { RestaurantBranding } from '@/lib/pl-branding';

// ── Export-Optionen ───────────────────────────────────────────────────────────

export interface PLExportOptions {
  includeMonthReport:    boolean;
  includePrevMonth:      boolean;
  includeCumulative:     boolean;
  includeSelectedMonths: boolean;
  selectedMonths:        number[];  // 1-basiert (1 = Jan … 12 = Dez)
}

// ── Farb-Palette ──────────────────────────────────────────────────────────────

const C = {
  // Dunkelblau – nur für Tabellenzeilen-Sektionskopf (weisse Schrift)
  navy:        [22,  40,  90]  as [number, number, number],
  // Dunkelgrau – Ergebnis-Zeilen (EBITDA / EBIT)
  navyMid:     [78,  85, 106]  as [number, number, number],
  // Klares Blau – Tabellen-Spaltenköpfe (bleibt blau)
  navyLight:   [55, 105, 190]  as [number, number, number],
  // Hellgrau – Abschnitts-Balken über jeder Tabelle
  sectionBar:  [218, 220, 230] as [number, number, number],
  // Dezentes Hellgrau – alternating rows
  slateLight:  [245, 245, 248] as [number, number, number],
  white:       [255, 255, 255] as [number, number, number],
  // Petrolgrün – professionelles Controlling-Grün (auf weissem Hintergrund)
  green:       [13,  92,  64]  as [number, number, number],
  // Helles Aqua-Mint – positive Ergebnisse auf dunklem Grau-Hintergrund
  resultGreen: [92, 220, 162]  as [number, number, number],
  // Knallrot – vivid Crimson für Minuszahlen (auf weissem Hintergrund)
  red:         [210, 30,  48]  as [number, number, number],
  // Helles Rot – negative Ergebnisse auf dunklem Grau-Hintergrund
  resultRed:   [255, 135, 145] as [number, number, number],
  // Dezentes Grau für Prozentwerte – klar sekundär
  gray:        [162, 166, 178] as [number, number, number],
  // Dunkeltext für Abschnitts-Label auf hellgrauem Balken
  navyHeader:  [72,  80, 102]  as [number, number, number],
};

// ── Zahlenformate ─────────────────────────────────────────────────────────────

function swissNum(v: number): string {
  const abs = Math.round(Math.abs(v));
  const s   = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return v < 0 ? `-${s}` : s;
}
function fmtCHF(v: number | undefined | null): string {
  if (v == null || v === 0) return '–';
  return swissNum(v);
}
function fmtPctRatio(value: number | undefined | null, base: number | undefined | null): string {
  if (value == null || !base || base === 0) return '–';
  const p = (value / base) * 100;
  if (!isFinite(p)) return '–';
  // Kein Leerzeichen vor % → verhindert Zeilenumbruch in engen Spalten
  return `${p.toFixed(1)}%`;
}

// ── Farblogik ─────────────────────────────────────────────────────────────────

function varColor(value: number | undefined | null, isExpense: boolean): [number, number, number] {
  if (value == null || Math.abs(value) < 0.5) return C.gray;
  const positive = value > 0;
  return (positive !== isExpense) ? C.green : C.red;
}

function resultActualColor(
  actual: number | undefined | null,
  isResult: boolean,
  isSubtotal: boolean,
): [number, number, number] | undefined {
  if ((!isResult && !isSubtotal) || actual == null || Math.abs(actual) < 0.5) return undefined;
  // Auf dunklem Grau-Hintergrund (navyMid): helle Varianten für Lesbarkeit
  if (isResult)    return actual >= 0 ? C.resultGreen : C.resultRed;
  // Auf hellem Hintergrund (subtotal): normale Varianten
  return actual >= 0 ? C.green : C.red;
}

function isExpenseRow(row: PLComputedRow): boolean {
  return row.def.valueRole === 'negative';
}
function indent(row: PLComputedRow): string {
  return '  '.repeat(Math.max(0, row.def.indent - 1));
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function ensureSpace(doc: jsPDF, afterY: number, neededH: number, gap = 5): number {
  const PAGE_H = 297;
  const MARGIN = 12;
  const y = afterY + gap;
  if (y + neededH > PAGE_H - MARGIN) {
    doc.addPage();
    return 20; // Platz für Mini-Header auf Folgeseiten
  }
  return y;
}

/**
 * Simulierter horizontaler Gradient via N schmale Farbstreifen.
 * colorL = linke Farbe (heller), colorR = rechte Farbe (Basis).
 */
function drawGradientBlock(
  doc:    jsPDF,
  x:      number,
  y:      number,
  w:      number,
  h:      number,
  colorL: [number, number, number],
  colorR: [number, number, number],
  steps = 32,
): void {
  const sw = w / steps;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const r = Math.round(colorL[0] + t * (colorR[0] - colorL[0]));
    const g = Math.round(colorL[1] + t * (colorR[1] - colorL[1]));
    const b = Math.round(colorL[2] + t * (colorR[2] - colorL[2]));
    doc.setFillColor(r, g, b);
    doc.rect(x + i * sw, y, sw + 0.3, h, 'F'); // +0.3 verhindert sichtbare Lücken
  }
}

// ── Seitenkopf ────────────────────────────────────────────────────────────────

/**
 * Haupt-Seitenkopf (Seite 1):
 *   LINKS  – Restaurantname gross · Monat/Jahr · Berichtstyp
 *   RECHTS – Logo (SVG-Wordmark) · Exportdatum
 *   UNTEN  – dünne Akzentlinie in Restaurantfarbe
 *
 * Branding-spezifisch: Hintergrundfarbe + Textfarben + Logo aus RestaurantBranding.
 */
function addPageHeader(
  doc: jsPDF,
  reportType: string,
  branding: RestaurantBranding,
  logoDataUrl: string,
  exportDate: string,
  month: number,
  year: number,
  pageW: number,
  y = 8,
): number {
  const blockH = 28;
  const x      = 10;
  const w      = pageW - 20;

  // ── Gradient: links 18% heller → rechts Basis ─────────────────────────
  const bg     = branding.headerBg;
  const colorL: [number, number, number] = [
    Math.min(255, Math.round(bg[0] * 1.45)),
    Math.min(255, Math.round(bg[1] * 1.35)),
    Math.min(255, Math.round(bg[2] * 1.30)),
  ];
  drawGradientBlock(doc, x, y, w, blockH, colorL, bg);

  // ── Akzentlinie unten (dezent) ─────────────────────────────────────────
  doc.setDrawColor(...branding.accentColor);
  doc.setLineWidth(0.35);
  doc.line(x, y + blockH, x + w, y + blockH);

  // ── Logo rechts, vertikal zentriert ───────────────────────────────────
  const logoW = 40;
  const logoH = Math.round(logoW / (240 / 56)); // Seitenverhältnis beibehalten ≈ 9.3mm
  const logoX = pageW - 13 - logoW;
  const logoY = y + (blockH - logoH) / 2;       // vertikal zentriert
  if (logoDataUrl) {
    doc.addImage(logoDataUrl, 'PNG', logoX, logoY, logoW, logoH);
  }

  // ── Exportdatum – ganz unten rechts, sehr dezent ───────────────────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5);
  doc.setTextColor(...branding.textSecondary);
  doc.text(`Exportiert am ${exportDate}`, pageW - 13, y + blockH - 2.5, { align: 'right' });

  // ── 1. Restaurantname ─────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...branding.textPrimary);
  doc.text(branding.displayName.toUpperCase(), 15, y + 10);

  // ── 2. Monat / Jahr ───────────────────────────────────────────────────
  const mFull = (MONTH_NAMES_DE[month] ?? MONTH_NAMES_SHORT_DE[month] ?? '').toUpperCase();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...branding.textPrimary);
  doc.text(`${mFull} ${year}`, 15, y + 18);

  // ── 3. Berichtstyp ────────────────────────────────────────────────────
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...branding.textSecondary);
  doc.text(reportType, 15, y + 24.5);

  doc.setTextColor(0, 0, 0);
  return y + blockH + 3;
}

/**
 * Mini-Header für Folgeseiten – schlank, elegant, reduziert:
 *   LINKS  – Restaurantname · Monat klein
 *   RECHTS – Logo (mini) · Seitenzahl optional im Footer
 */
function addMiniHeader(
  doc: jsPDF,
  branding: RestaurantBranding,
  logoDataUrl: string,
  monthLabel: string,
  pageW: number,
): void {
  const miniH = 8;
  const y     = 2;
  const x     = 10;
  const w     = pageW - 20;

  // Gradient wie Haupt-Header, aber schmaler
  const bg     = branding.headerBg;
  const colorL: [number, number, number] = [
    Math.min(255, Math.round(bg[0] * 1.40)),
    Math.min(255, Math.round(bg[1] * 1.30)),
    Math.min(255, Math.round(bg[2] * 1.25)),
  ];
  drawGradientBlock(doc, x, y, w, miniH, colorL, bg, 24);

  // Akzentlinie
  doc.setDrawColor(...branding.accentColor);
  doc.setLineWidth(0.28);
  doc.line(x, y + miniH, x + w, y + miniH);

  // Logo mini – vertikal zentriert
  const logoW = 20;
  const logoH = Math.round(logoW / (240 / 56)); // ≈ 4.7mm
  const logoX = pageW - 13 - logoW;
  const logoY = y + (miniH - logoH) / 2;
  if (logoDataUrl) {
    doc.addImage(logoDataUrl, 'PNG', logoX, logoY, logoW, logoH);
  }

  // Restaurantname
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6);
  doc.setTextColor(...branding.textPrimary);
  doc.text(branding.displayName.toUpperCase(), 14, y + 4);

  // Monat dezent
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5);
  doc.setTextColor(...branding.textSecondary);
  doc.text(monthLabel, 14, y + 7);

  doc.setTextColor(0, 0, 0);
}

/** Kleiner Abschnitts-Header (hellgrauer Balken, dunkle Schrift) */
function addSectionHeader(
  doc: jsPDF,
  category: string,   // z.B. "VORMONATSVERGLEICH"
  title: string,      // z.B. "April vs. März 2026"
  y: number,
  pageW: number,
): number {
  const blockH = 12;
  doc.setFillColor(...C.sectionBar);
  doc.rect(10, y, pageW - 20, blockH, 'F');

  // Kategorie-Label: mittleres Grau auf hellgrauem Hintergrund
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...C.navyHeader);
  doc.text(category.toUpperCase(), 15, y + 4);

  // Titel: dunkelblau / fast schwarz für maximale Lesbarkeit
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...C.navy);
  doc.text(title, 15, y + 9.5);
  doc.setTextColor(0, 0, 0);
  return y + blockH + 1;
}

// ── KPI-Sektion (Monatskennzahlen oben) ──────────────────────────────────────

function addKpiSection(
  doc: jsPDF,
  monthResult: PLMonthResult,
  startY: number,
  pageW: number,
): number {
  const get = (id: string) => monthResult.rows.find(r => r.def.id === id);

  const revRow    = get('net_revenue');
  const ebitdaRow = get('ebitda');
  const ebitRow   = get('ebit');
  const cogsRow   = get('total_cogs');
  const persRow   = get('total_personnel');

  const revA  = revRow?.values.actual;
  const revB  = revRow?.values.budget;
  const revPY = revRow?.values.prevYear;

  type KpiEntry = {
    label: string;
    istCHF: string; istPct: string;
    budCHF: string; budPct: string;
    vjCHF:  string; vjPct:  string;
    istColor: [number, number, number];
  };

  const makeEntry = (
    label: string,
    row: PLComputedRow | undefined,
    isExpense: boolean,
    showPct: boolean,
  ): KpiEntry => {
    const v  = row?.values;
    const a  = v?.actual;
    const b  = v?.budget;
    const py = v?.prevYear;
    const istColor: [number, number, number] = isExpense
      ? C.gray
      : (a == null || Math.abs(a) < 0.5 ? C.gray : a >= 0 ? C.green : C.red);
    return {
      label,
      istCHF: fmtCHF(a),
      istPct: showPct ? fmtPctRatio(a, revA) : '–',
      budCHF: fmtCHF(b),
      budPct: showPct ? fmtPctRatio(b, revB) : '–',
      vjCHF:  fmtCHF(py),
      vjPct:  showPct ? fmtPctRatio(py, revPY) : '–',
      istColor,
    };
  };

  const kpis: KpiEntry[] = [
    makeEntry('Betriebsertrag netto',  revRow,    false, false),
    makeEntry('Warenaufwand total',    cogsRow,   true,  true),
    makeEntry('Personalaufwand total', persRow,   true,  true),
    makeEntry('EBITDA',                ebitdaRow, false, true),
    makeEntry('EBIT',                  ebitRow,   false, true),
  ];

  doc.setFontSize(6);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...C.navyMid);
  doc.text('KENNZAHLEN', 12, startY + 3);
  doc.setTextColor(0, 0, 0);

  autoTable(doc, {
    startY: startY + 4,
    head: [['Kennzahl', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'Vorjahr CHF', 'VJ %']],
    body: kpis.map(k => [
      { content: k.label,   styles: { fontStyle: 'bold' as const } },
      { content: k.istCHF,  styles: { halign: 'right' as const, fontStyle: 'bold' as const, textColor: k.istColor } },
      { content: k.istPct,  styles: { halign: 'right' as const, textColor: C.gray } },
      { content: k.budCHF,  styles: { halign: 'right' as const } },
      { content: k.budPct,  styles: { halign: 'right' as const, textColor: C.gray } },
      { content: k.vjCHF,   styles: { halign: 'right' as const } },
      { content: k.vjPct,   styles: { halign: 'right' as const, textColor: C.gray } },
    ]),
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 6.5,
      cellPadding: { top: 1.5, bottom: 1.5, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 7, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 22 },
      2: { halign: 'right', cellWidth: 14 },
      3: { halign: 'right', cellWidth: 22 },
      4: { halign: 'right', cellWidth: 14 },
      5: { halign: 'right', cellWidth: 22 },
      6: { halign: 'right', cellWidth: 14 },
    },
  });

  return (doc as any).lastAutoTable.finalY + 3;
}

// ── Budget P&L Tabellenkörper ─────────────────────────────────────────────────

function buildBPLBody(
  rows: PLComputedRow[],
  revA: number | undefined,
  revB: number | undefined,
  revPY: number | undefined,
) {
  type CellDef = string | { content: string; styles: Record<string, unknown> };
  const NCOLS = 9;
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;
    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: C.navy, textColor: C.white, colSpan: NCOLS } },
        ...Array(NCOLS - 1).fill(''),
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [228, 228, 238] as [number, number, number]
                     : undefined;
    const baseTxtColor = isResult ? C.white : undefined;
    const istValColor  = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor     = istValColor ?? baseTxtColor;
    const abwBudC      = varColor(v.vsBudget,   isExp);
    const abwVJC       = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    body.push([
      { content: label,               styles: cs() },
      { content: fmtCHF(v.actual),    styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(v.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.budget),    styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.budget,   revB),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsBudget),  styles: cs({ halign: 'right', textColor: isResult ? C.white : abwBudC }) },
      { content: fmtCHF(v.prevYear),  styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Klassisch Tabellenkörper ──────────────────────────────────────────────────

function buildKlassischBody(
  rows: PLComputedRow[],
  revA:  number | undefined,
  revPY: number | undefined,
) {
  type CellDef = string | { content: string; styles: Record<string, unknown> };
  const NCOLS = 6;
  const body: CellDef[][] = [];

  for (const row of rows) {
    const t = row.def.type;
    if (t === 'spacer' || t === 'percent_line') continue;
    const v     = row.values;
    const isExp = isExpenseRow(row);

    if (t === 'section') {
      body.push([
        { content: row.def.label.toUpperCase(), styles: { fontStyle: 'bold', fillColor: C.navy, textColor: C.white, colSpan: NCOLS } },
        ...Array(NCOLS - 1).fill(''),
      ]);
      continue;
    }

    const isResult   = t === 'result';
    const isSubtotal = t === 'subtotal';
    const bold       = isResult || isSubtotal ? 'bold' : 'normal';
    const fillColor  = isResult   ? C.navyMid
                     : isSubtotal ? [228, 228, 238] as [number, number, number]
                     : undefined;
    const baseTxtColor = isResult ? C.white : undefined;
    const istValColor  = resultActualColor(v.actual, isResult, isSubtotal);
    const istColor     = istValColor ?? baseTxtColor;
    const abwVJC       = varColor(v.vsPrevYear, isExp);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: bold,
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    const label = indent(row) + row.def.label;
    body.push([
      { content: label,                styles: cs() },
      { content: fmtCHF(v.actual),     styles: cs({ halign: 'right', fontStyle: 'bold', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(v.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.prevYear),   styles: cs({ halign: 'right' }) },
      { content: fmtPctRatio(v.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray }) },
      { content: fmtCHF(v.vsPrevYear), styles: cs({ halign: 'right', textColor: isResult ? C.white : abwVJC }) },
    ]);
  }
  return body;
}

// ── Block 2: Vormonatsvergleich ───────────────────────────────────────────────

function addPrevMonthComparison(
  doc: jsPDF,
  yearResult: PLYearResult,
  month: number,   // 1-basiert, aktueller Monat
  year: number,
  afterY: number,
  pageW: number,
): void {
  if (month < 2) return;
  const curIdx  = month - 1;   // 0-basiert
  const prevIdx = month - 2;

  const curResult  = yearResult.months[curIdx];
  const prevResult = yearResult.months[prevIdx];
  if (!curResult || !prevResult) return;

  const y = ensureSpace(doc, afterY, 55);

  const curName  = MONTH_NAMES_DE[month]      ?? '';
  const prevName = MONTH_NAMES_DE[month - 1]  ?? '';

  const tableStartY = addSectionHeader(
    doc,
    'VORMONATSVERGLEICH',
    `${curName} vs. ${prevName} ${year}`,
    y,
    pageW,
  );

  // KPI-Daten holen
  const getKpi = (result: PLMonthResult, id: string) =>
    result.rows.find(r => r.def.id === id)?.values.actual ?? 0;

  const curRev  = getKpi(curResult,  'net_revenue');
  const prevRev = getKpi(prevResult, 'net_revenue');

  interface VmRow { label: string; curV: number; prevV: number; isResult: boolean; isExpense: boolean; }

  const rows: VmRow[] = [
    { label: 'Betriebsertrag netto',  curV: curRev,                              prevV: prevRev,                              isResult: false, isExpense: false },
    { label: 'Warenaufwand total',    curV: getKpi(curResult, 'total_cogs'),      prevV: getKpi(prevResult, 'total_cogs'),      isResult: false, isExpense: true },
    { label: 'Personalaufwand total', curV: getKpi(curResult, 'total_personnel'), prevV: getKpi(prevResult, 'total_personnel'), isResult: false, isExpense: true },
    { label: 'EBITDA',                curV: getKpi(curResult, 'ebitda'),          prevV: getKpi(prevResult, 'ebitda'),          isResult: true,  isExpense: false },
    { label: 'EBIT',                  curV: getKpi(curResult, 'ebit'),            prevV: getKpi(prevResult, 'ebit'),            isResult: true,  isExpense: false },
  ];

  type CellDef = string | { content: string; styles: Record<string, unknown> };

  const body: CellDef[][] = rows.map(({ label, curV, prevV, isResult, isExpense }) => {
    const abwCHF = curV - prevV;
    const abwPct = prevV !== 0 ? (abwCHF / Math.abs(prevV)) * 100 : 0;
    const abwPctStr = prevV !== 0 ? `${abwPct > 0 ? '+' : ''}${abwPct.toFixed(1)} %` : '–';

    const fillColor    = isResult ? C.navyMid : undefined;
    const baseTxt      = isResult ? C.white   : undefined;
    // navyMid ist dunkelgrau → helle Varianten für gute Lesbarkeit
    const istColor     = isResult ? (curV >= 0 ? C.resultGreen : C.resultRed) : undefined;
    const abwColor     = isResult ? C.white : varColor(abwCHF, isExpense);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: 'bold' as const,
      ...(fillColor ? { fillColor }           : {}),
      ...(baseTxt   ? { textColor: baseTxt }  : {}),
      ...extra,
    });

    return [
      { content: label,               styles: cs() },
      { content: fmtCHF(curV),        styles: cs({ halign: 'right', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(curV,  curRev),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(prevV),       styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(prevV, prevRev), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(abwCHF),      styles: cs({ halign: 'right', textColor: abwColor, fontStyle: 'normal' }) },
      { content: abwPctStr,            styles: cs({ halign: 'right', textColor: abwColor, fontStyle: 'normal' }) },
    ];
  });

  autoTable(doc, {
    startY: tableStartY,
    head: [[
      'Kennzahl',
      `${MONTH_NAMES_SHORT_DE[month]} CHF`,    `${MONTH_NAMES_SHORT_DE[month]} %`,
      `${MONTH_NAMES_SHORT_DE[month - 1]} CHF`, `${MONTH_NAMES_SHORT_DE[month - 1]} %`,
      'Abw. CHF', 'Abw. %',
    ]],
    body: body as string[][],
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 6.5,
      cellPadding: { top: 1.5, bottom: 1.5, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 8, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 21 },
      2: { halign: 'right', cellWidth: 12 },   // % – schmal
      3: { halign: 'right', cellWidth: 21 },
      4: { halign: 'right', cellWidth: 12 },
      5: { halign: 'right', cellWidth: 21 },
      6: { halign: 'right', cellWidth: 19 },   // Abw.%
    },
    didParseCell: (data) => {
      // %-Spalten sekundär
      if (data.section === 'body' && [2, 4, 6].includes(data.column.index)) {
        data.cell.styles.fontSize = 5.5;
      }
    },
  });
}

// ── Block 3 + 4: Kumulierte / Ausgewählte Monate ─────────────────────────────

/**
 * Summiert Kennzahlen über beliebige Monate aus yearResult und rendert einen Block.
 * @param monthIndices  0-basierte Indizes in yearResult.months
 * @param category      Kopfzeile (z.B. "KUMULIERTE ÜBERSICHT")
 * @param title         Untertitel (z.B. "Januar bis April 2026")
 */
function addKpiSummaryBlock(
  doc: jsPDF,
  yearResult: PLYearResult,
  monthIndices: number[],
  category: string,
  title: string,
  afterY: number,
  pageW: number,
): void {
  if (monthIndices.length === 0) return;

  const y = ensureSpace(doc, afterY, 55);
  const tableStartY = addSectionHeader(doc, category, title, y, pageW);

  const sumKpi = (id: string) => {
    let actual = 0, budget = 0, prevYear = 0;
    for (const idx of monthIndices) {
      const mr = yearResult.months[idx];
      if (!mr) continue;
      const r = mr.rows.find(row => row.def.id === id);
      actual   += r?.values.actual   ?? 0;
      budget   += r?.values.budget   ?? 0;
      prevYear += r?.values.prevYear ?? 0;
    }
    return { actual, budget, prevYear };
  };

  const rev    = sumKpi('net_revenue');
  const cogs   = sumKpi('total_cogs');
  const pers   = sumKpi('total_personnel');
  const ebitda = sumKpi('ebitda');
  const ebit   = sumKpi('ebit');

  type CellDef = string | { content: string; styles: Record<string, unknown> };

  const makeRow = (
    label: string,
    vals: { actual: number; budget: number; prevYear: number },
    isResult: boolean,
    isExpense: boolean,
  ): CellDef[] => {
    const revA  = rev.actual;
    const revB  = rev.budget;
    const revPY = rev.prevYear;

    const abwBudRaw = vals.actual - vals.budget;
    const abwVJRaw  = vals.actual - vals.prevYear;

    const fillColor    = isResult ? C.navyMid : undefined;
    const baseTxtColor = isResult ? C.white   : undefined;
    const istColor     = isResult ? (vals.actual >= 0 ? C.green : C.red)
                       : isExpense ? undefined
                       : (vals.actual >= 0 ? C.green : C.red);
    const abwBudColor  = isResult ? C.white : varColor(abwBudRaw, isExpense);
    const abwVJColor   = isResult ? C.white : varColor(abwVJRaw,  isExpense);

    const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      fontStyle: 'bold',
      ...(fillColor    ? { fillColor }               : {}),
      ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
      ...extra,
    });

    return [
      { content: label,                      styles: cs() },
      { content: fmtCHF(vals.actual),        styles: cs({ halign: 'right', ...(istColor ? { textColor: istColor } : {}) }) },
      { content: fmtPctRatio(vals.actual,   revA),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(vals.budget),        styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(vals.budget,   revB),  styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(vals.prevYear),      styles: cs({ halign: 'right', fontStyle: 'normal' }) },
      { content: fmtPctRatio(vals.prevYear, revPY), styles: cs({ halign: 'right', textColor: isResult ? C.white : C.gray, fontStyle: 'normal' }) },
      { content: fmtCHF(abwBudRaw),          styles: cs({ halign: 'right', textColor: abwBudColor, fontStyle: 'normal' }) },
      { content: fmtCHF(abwVJRaw),           styles: cs({ halign: 'right', textColor: abwVJColor,  fontStyle: 'normal' }) },
    ];
  };

  const body: CellDef[][] = [
    makeRow('Betriebsertrag netto',  rev,    false, false),
    makeRow('Warenaufwand total',    cogs,   false, true),
    makeRow('Personalaufwand total', pers,   false, true),
    makeRow('EBITDA',                ebitda, true,  false),
    makeRow('EBIT',                  ebit,   true,  false),
  ];

  autoTable(doc, {
    startY: tableStartY,
    head: [['Kennzahl', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'VJ CHF', 'VJ %', 'Abw. Budget', 'Abw. VJ']],
    body: body as string[][],
    theme: 'plain',
    headStyles: {
      fillColor: C.navyLight, textColor: C.white,
      fontStyle: 'bold', fontSize: 6.5,
      cellPadding: { top: 1.5, bottom: 1.5, left: 2, right: 2 },
    },
    bodyStyles: { fontSize: 8, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
    alternateRowStyles: { fillColor: C.slateLight },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { halign: 'right', cellWidth: 18 },
      2: { halign: 'right', cellWidth: 12 },   // % – schmal
      3: { halign: 'right', cellWidth: 18 },
      4: { halign: 'right', cellWidth: 12 },
      5: { halign: 'right', cellWidth: 18 },
      6: { halign: 'right', cellWidth: 12 },
      7: { halign: 'right', cellWidth: 19 },
      8: { halign: 'right', cellWidth: 19 },
    },
    didParseCell: (data) => {
      if (data.section === 'body' && [2, 4, 6].includes(data.column.index)) {
        data.cell.styles.fontSize = 5.5;
      }
    },
  });
}

// ── Block 4: Monatsvergleich (Monate als Spalten + Totalspalte) ───────────────

/**
 * Zeigt ausgewählte Monate nebeneinander als Spalten.
 * Letzte Spalte = kumuliertes Total über alle ausgewählten Monate.
 * %-Zeilen: Total-% berechnet aus kumulierten CHF-Werten (nicht Durchschnitt).
 * Max. 6 Monate pro Tabelle; bei mehr folgt eine zweite Tabelle.
 *
 * Visuelles Konzept:
 *  - CHF-Zeilen:   8pt bold, dunkles Navy
 *  - %-Zeilen:     6.5pt normal, grau – direkt unter CHF
 *  - Total-Spalte: leicht hervorgehoben, immer fett
 *  - Gruppen:      Umsatz / Waren / Personal / Ergebnis – Padding-Trenner
 */
function addMonthComparisonBlock(
  doc: jsPDF,
  yearResult: PLYearResult,
  selectedMonths: number[],
  year: number,
  afterY: number,
  pageW: number,
): void {
  if (selectedMonths.length === 0) return;

  // ── Farben ───────────────────────────────────────────────────────────────
  const DARK_TEXT:       [number, number, number] = [22, 40, 90];    // = C.navy
  const PCT_TEXT:        [number, number, number] = [162, 166, 178]; // dezent grau, klar sekundär
  // Dunkelgrau – Ergebnis-Zeilen (identisch mit C.navyMid)
  const RESULT_BG:       [number, number, number] = [78, 85, 106];
  const RESULT_PCT:      [number, number, number] = [188, 192, 215]; // hell auf Grau
  const TOTAL_BG:        [number, number, number] = [228, 228, 238]; // nahezu neutral
  const TOTAL_RESULT_BG: [number, number, number] = [55, 62, 82];    // dunkleres Grau für Total
  // Petrolgrün – Controlling-Stil, kein Neon
  const PETROL_GREEN:    [number, number, number] = [13, 92, 64];
  // Knallrot – vivid Crimson
  const BORDEAUX:        [number, number, number] = [210, 30, 48];
  // Auf dunklem Grau: helle, gut lesbare Varianten (= C.resultGreen / C.resultRed)
  const RESULT_GREEN:    [number, number, number] = [92, 220, 162];
  const RESULT_RED:      [number, number, number] = [255, 135, 145];

  // ── %-Format ohne Leerzeichen (kein Umbruch) ─────────────────────────────
  const pctStr = (v: number | null | undefined, base: number | null | undefined): string => {
    if (v == null || !base || base === 0) return '–';
    const p = (v / base) * 100;
    return isFinite(p) ? `${p.toFixed(1)}%` : '–';
  };

  const CHUNK_SIZE = 6;
  const allIndices = selectedMonths.map(m => m - 1); // 0-basiert

  // ── Kumuliertes Total über ALLE ausgewählten Monate ──────────────────────
  const totalFor = (id: string): number =>
    allIndices.reduce((sum, idx) => {
      return sum + (yearResult.months[idx]?.rows.find(r => r.def.id === id)?.values.actual ?? 0);
    }, 0);

  const totalRev  = totalFor('net_revenue');
  const totalCogs = totalFor('total_cogs');
  const totalPers = totalFor('total_personnel');
  const totalEbitda = totalFor('ebitda');
  const totalEbit   = totalFor('ebit');

  // ── Titel ────────────────────────────────────────────────────────────────
  const isConsec = selectedMonths.every((m, i) => i === 0 || m === selectedMonths[i - 1] + 1);
  const title = isConsec && selectedMonths.length > 1
    ? `${MONTH_NAMES_DE[selectedMonths[0]]} bis ${MONTH_NAMES_DE[selectedMonths[selectedMonths.length - 1]]} ${year}`
    : `${selectedMonths.map(m => MONTH_NAMES_SHORT_DE[m]).filter(Boolean).join(', ')} ${year}`;

  const y = ensureSpace(doc, afterY, 70);
  const headerEndY = addSectionHeader(doc, 'MONATSVERGLEICH', title, y, pageW);

  // ── Kennzahlen-Definitionen ──────────────────────────────────────────────
  interface RowDef {
    id:         string;
    label:      string;
    isPctRow:   boolean;
    isResult:   boolean;
    groupStart: boolean;
    totalChf:   number;  // Vorberechnetes Total-CHF (für %-Zeilen: Zähler)
    totalBase:  number;  // Basis für %-Berechnung
  }

  const ROW_DEFS: RowDef[] = [
    // Gruppe Umsatz
    { id: 'net_revenue',     label: 'Betriebsertrag netto', isPctRow: false, isResult: false, groupStart: false, totalChf: totalRev,   totalBase: totalRev },
    // Gruppe Waren
    { id: 'total_cogs',      label: 'Warenaufwand',         isPctRow: false, isResult: false, groupStart: true,  totalChf: totalCogs,  totalBase: totalRev },
    { id: 'total_cogs',      label: 'Warenaufwand %',       isPctRow: true,  isResult: false, groupStart: false, totalChf: totalCogs,  totalBase: totalRev },
    // Gruppe Personal
    { id: 'total_personnel', label: 'Personalaufwand',      isPctRow: false, isResult: false, groupStart: true,  totalChf: totalPers,  totalBase: totalRev },
    { id: 'total_personnel', label: 'Personalaufwand %',    isPctRow: true,  isResult: false, groupStart: false, totalChf: totalPers,  totalBase: totalRev },
    // Gruppe Ergebnis
    { id: 'ebitda',          label: 'EBITDA',               isPctRow: false, isResult: true,  groupStart: true,  totalChf: totalEbitda, totalBase: totalRev },
    { id: 'ebitda',          label: 'EBITDA %',             isPctRow: true,  isResult: true,  groupStart: false, totalChf: totalEbitda, totalBase: totalRev },
    { id: 'ebit',            label: 'EBIT',                 isPctRow: false, isResult: true,  groupStart: false, totalChf: totalEbit,   totalBase: totalRev },
    { id: 'ebit',            label: 'EBIT %',               isPctRow: true,  isResult: true,  groupStart: false, totalChf: totalEbit,   totalBase: totalRev },
  ];

  const getVal    = (idx: number, id: string): number =>
    yearResult.months[idx]?.rows.find(r => r.def.id === id)?.values.actual ?? 0;
  const getRevVal = (idx: number): number => getVal(idx, 'net_revenue');

  // ── Chunks (max. 6 Monate pro Tabelle) ──────────────────────────────────
  const chunks: number[][] = [];
  for (let i = 0; i < allIndices.length; i += CHUNK_SIZE) {
    chunks.push(allIndices.slice(i, i + CHUNK_SIZE));
  }

  let currentY = headerEndY;

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const n     = chunk.length;

    // Spaltenbreiten: Label + n × Monate + Total = exakt 190mm
    // Kein Math.floor – Remainder geht in die Label-Spalte damit keine
    // Pixel-Lücke rechts entsteht (weisser Streifen).
    const TOTAL_W    = 26;
    const perMonthW  = Math.floor((pageW - 20 - TOTAL_W) / (n + 1.6)); // ~1.6× breiter als Monat
    const LABEL_W    = (pageW - 20) - n * perMonthW - TOTAL_W;          // Rest → Label

    // Tabellenkopf
    const head: string[] = [
      'Kennzahl',
      ...chunk.map(idx => MONTH_NAMES_SHORT_DE[idx + 1] ?? ''),
      'Total',
    ];

    type CellDef = string | { content: string; styles: Record<string, unknown> };
    const body: CellDef[][] = [];

    for (const rowDef of ROW_DEFS) {
      const { id, label, isPctRow, isResult, groupStart, totalChf, totalBase } = rowDef;

      // Padding: Gruppenstart → extra Abstand
      const topPad    = groupStart ? 3.5 : 1.0;
      const bottomPad = 1.0;

      // Farben je Zeilentyp
      const rowFill       = isResult ? RESULT_BG : undefined;
      const labelTxtColor = isResult
        ? (isPctRow ? RESULT_PCT : ([215, 228, 248] as [number, number, number]))
        : (isPctRow ? PCT_TEXT   : DARK_TEXT);
      const valueFontStyle: 'bold' | 'normal' = isPctRow ? 'normal' : 'bold';
      // CHF dominant (8.5pt), % sekundär (5.5pt)
      const valueFontSize  = isPctRow ? 5.5 : 8.5;

      const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        cellPadding: { top: topPad, bottom: bottomPad, left: 3, right: 3 },
        ...(rowFill ? { fillColor: rowFill } : {}),
        ...extra,
      });

      // ── Label ───────────────────────────────────────────────────────────
      const labelCell: CellDef = {
        content: label,
        styles: cs({
          fontStyle: isPctRow ? 'italic' : 'bold',
          fontSize:  isPctRow ? 6.5 : 8,
          textColor: labelTxtColor,
        }),
      };

      // ── Monatszellen ────────────────────────────────────────────────────
      const monthCells: CellDef[] = chunk.map(monthIdx => {
        const revV = getRevVal(monthIdx);
        const v    = getVal(monthIdx, id);

        let content: string;
        let cellColor: [number, number, number];

        if (isPctRow) {
          content   = pctStr(v, revV);
          cellColor = isResult ? RESULT_PCT : PCT_TEXT;
        } else {
          content = fmtCHF(v);
          if (isResult) {
            cellColor = v >= 0 ? RESULT_GREEN : RESULT_RED;
          } else {
            cellColor = v < 0 ? BORDEAUX : DARK_TEXT;
          }
        }

        return {
          content,
          styles: cs({
            halign:    'right',
            fontStyle: valueFontStyle,
            fontSize:  valueFontSize,
            textColor: cellColor,
          }),
        };
      });

      // ── Totalspalte ──────────────────────────────────────────────────────
      // CHF: Summe aller ausgewählten Monate
      // %:   kumulierter CHF / kumulierter Umsatz × 100
      const totalFill = isResult ? TOTAL_RESULT_BG : TOTAL_BG;

      let totalContent: string;
      let totalTxtColor: [number, number, number];

      if (isPctRow) {
        totalContent  = pctStr(totalChf, totalBase);
        totalTxtColor = isResult ? RESULT_PCT : PCT_TEXT;
      } else {
        totalContent = fmtCHF(totalChf);
        if (isResult) {
          totalTxtColor = totalChf >= 0 ? RESULT_GREEN : RESULT_RED;
        } else {
          totalTxtColor = totalChf < 0 ? BORDEAUX : DARK_TEXT;
        }
      }

      body.push([
        labelCell,
        ...monthCells,
        {
          content: totalContent,
          styles: {
            cellPadding: { top: topPad, bottom: bottomPad, left: 3, right: 3 },
            fillColor: totalFill,
            halign:    'right',
            fontStyle: 'bold',
            fontSize:  valueFontSize,
            textColor: totalTxtColor,
          },
        },
      ]);
    }

    // ── Spaltenbreiten ────────────────────────────────────────────────────
    const colStyles: Record<number, Record<string, unknown>> = {
      0: { cellWidth: LABEL_W },
    };
    for (let i = 0; i < n; i++) {
      colStyles[i + 1] = { halign: 'right', cellWidth: perMonthW };
    }
    colStyles[n + 1] = { halign: 'right', cellWidth: TOTAL_W };

    if (chunkIdx > 0) {
      currentY = ensureSpace(doc, (doc as any).lastAutoTable?.finalY ?? currentY, 80);
    }

    autoTable(doc, {
      startY: currentY,
      head:   [head],
      body:   body as string[][],
      theme:  'plain',
      headStyles: {
        fillColor: C.navyLight, textColor: C.white,
        fontStyle: 'bold', fontSize: 7,
        cellPadding: { top: 2, bottom: 2, left: 2.5, right: 2.5 },
        halign: 'right',
      },
      bodyStyles: {
        fontSize: 7.5,
        cellPadding: { top: 1.0, bottom: 1.0, left: 2.5, right: 2.5 },
        textColor: DARK_TEXT,
        overflow:  'ellipsize',
      },
      alternateRowStyles: {},
      columnStyles: colStyles,
      // Kopfzellen-Ausrichtung: Label links, Rest rechts
      didParseCell: (data) => {
        if (data.section === 'head') {
          data.cell.styles.halign = data.column.index === 0 ? 'left' : 'right';
        }
      },
      // tableLineWidth: 0 → kein Aussenrahmen, verhindert weissen Streifen rechts
      tableLineWidth: 0,
    });

    currentY = (doc as any).lastAutoTable?.finalY ?? currentY;
  }
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────

export async function exportPLToPDF(
  monthResult: PLMonthResult,
  yearResult:  PLYearResult,
  year:        number,
  month:       number,
  mode: 'budget_pl' | 'monthly' | 'yearly' = 'budget_pl',
  options?: PLExportOptions,
  branding?: RestaurantBranding,
): Promise<void> {
  // ── Branding laden ──────────────────────────────────────────────────────
  const { getBranding: _getBranding, renderLogoDataUrl } = await import('@/lib/pl-branding');
  const activeBranding = branding ?? _getBranding('oliv');
  const logoDataUrl    = await renderLogoDataUrl(activeBranding);

  // ── Defaults ─────────────────────────────────────────────────────────────
  const opts: PLExportOptions = options ?? {
    includeMonthReport:    true,
    includePrevMonth:      month > 1,
    includeCumulative:     month > 1,
    includeSelectedMonths: false,
    selectedMonths:        Array.from({ length: month }, (_, i) => i + 1),
  };

  const doc    = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const now    = new Date().toLocaleDateString('de-CH');
  const PAGE_W = 210;
  const mFull  = (MONTH_NAMES_DE[month] ?? MONTH_NAMES_SHORT_DE[month] ?? '').toUpperCase();
  const miniLabel = `${mFull} ${year}`;

  const revA  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.actual;
  const revB  = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.budget;
  const revPY = monthResult.rows.find(r => r.def.id === 'net_revenue')?.values.prevYear;

  // ──── Budget P&L ─────────────────────────────────────────────────────────
  if (mode === 'budget_pl' || mode === 'monthly') {
    const isBPL = mode === 'budget_pl';

    if (opts.includeMonthReport) {
      const reportType = isBPL ? 'Erfolgsrechnung – Budget P&L' : 'Erfolgsrechnung – Monatsansicht';
      const yH = addPageHeader(doc, reportType, activeBranding, logoDataUrl, now, month, year, PAGE_W);
      const yK = addKpiSection(doc, monthResult, yH, PAGE_W);

      if (isBPL) {
        const body = buildBPLBody(monthResult.rows, revA, revB, revPY);
        autoTable(doc, {
          startY: yK,
          margin: { top: 22, bottom: 15 },
          head: [['Position', 'Ist CHF', 'Ist %', 'Budget CHF', 'Bud %', 'Abw. Budget', 'Vorjahr CHF', 'VJ %', 'Abw. VJ']],
          body: body as string[][],
          theme: 'plain',
          headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 } },
          bodyStyles: { fontSize: 8, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
          alternateRowStyles: { fillColor: C.slateLight },
          columnStyles: {
            0: { cellWidth: 50 },
            1: { halign: 'right', cellWidth: 19 },
            2: { halign: 'right', cellWidth: 12 },   // % – schmal, weil 5.5pt
            3: { halign: 'right', cellWidth: 19 },
            4: { halign: 'right', cellWidth: 12 },
            5: { halign: 'right', cellWidth: 19 },
            6: { halign: 'right', cellWidth: 19 },
            7: { halign: 'right', cellWidth: 12 },
            8: { halign: 'right', cellWidth: 18 },
          },
          didParseCell: (data) => {
            // %-Spalten: dezenter Font, sekundäre Hierarchie
            if (data.section === 'body' && [2, 4, 7].includes(data.column.index)) {
              data.cell.styles.fontSize = 5.5;
            }
            // Section-Header Zeilen: navy Hintergrund für alle Zellen
            if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
              const first = (data.row.raw as any[])[0];
              if (first?.styles?.colSpan === 9) data.cell.styles.fillColor = C.navy;
            }
          },
        });
      } else {
        const body = buildKlassischBody(monthResult.rows, revA, revPY);
        autoTable(doc, {
          startY: yK,
          margin: { top: 22, bottom: 15 },
          head: [['Position', 'Ist CHF', 'Ist %', 'Vorjahr CHF', 'VJ %', 'Abw. VJ']],
          body: body as string[][],
          theme: 'plain',
          headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 7, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 } },
          bodyStyles: { fontSize: 8, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 1.5 } },
          alternateRowStyles: { fillColor: C.slateLight },
          columnStyles: {
            0: { cellWidth: 73 },
            1: { halign: 'right', cellWidth: 27 },
            2: { halign: 'right', cellWidth: 13 },   // % – schmal
            3: { halign: 'right', cellWidth: 27 },
            4: { halign: 'right', cellWidth: 13 },
            5: { halign: 'right', cellWidth: 27 },
          },
          didParseCell: (data) => {
            if (data.section === 'body' && [2, 4].includes(data.column.index)) {
              data.cell.styles.fontSize = 5.5;
            }
            if (data.row.raw && Array.isArray(data.row.raw) && data.column.index > 0) {
              const first = (data.row.raw as any[])[0];
              if (first?.styles?.colSpan === 6) data.cell.styles.fillColor = C.navy;
            }
          },
        });
      }
    }

    // ── Block 2: Vormonatsvergleich ──────────────────────────────────────
    if (opts.includePrevMonth && month > 1) {
      const prevAfterY = (doc as any).lastAutoTable?.finalY ?? 10;
      addPrevMonthComparison(doc, yearResult, month, year, prevAfterY, PAGE_W);
    }

    // ── Block 3: Kumulierte Übersicht Jan bis aktueller Monat ───────────
    if (opts.includeCumulative && month > 1) {
      const cumAfterY  = (doc as any).lastAutoTable?.finalY ?? 10;
      const cumIndices = Array.from({ length: month }, (_, i) => i);
      const monthName  = MONTH_NAMES_DE[month] ?? '';
      addKpiSummaryBlock(
        doc, yearResult, cumIndices,
        'KUMULIERTE ÜBERSICHT',
        `Januar bis ${monthName} ${year}`,
        cumAfterY, PAGE_W,
      );
    }

    // ── Block 4: Monatsvergleich (Monate als Spalten) ───────────────────
    if (opts.includeSelectedMonths && opts.selectedMonths.length > 0) {
      const selAfterY = (doc as any).lastAutoTable?.finalY ?? 10;
      const validMonths = opts.selectedMonths.filter(m => m >= 1 && m <= 12);
      addMonthComparisonBlock(doc, yearResult, validMonths, year, selAfterY, PAGE_W);
    }
  }

  // ──── Jahresübersicht ────────────────────────────────────────────────────
  else if (mode === 'yearly') {
    const blockH = 28;
    const bg     = activeBranding.headerBg;
    const colorL: [number, number, number] = [
      Math.min(255, Math.round(bg[0] * 1.45)),
      Math.min(255, Math.round(bg[1] * 1.35)),
      Math.min(255, Math.round(bg[2] * 1.30)),
    ];
    drawGradientBlock(doc, 10, 8, PAGE_W - 20, blockH, colorL, bg);

    doc.setDrawColor(...activeBranding.accentColor);
    doc.setLineWidth(0.35);
    doc.line(10, 8 + blockH, PAGE_W - 10, 8 + blockH);

    const logoW = 40;
    const logoH = Math.round(logoW / (240 / 56));
    if (logoDataUrl) {
      doc.addImage(logoDataUrl, 'PNG', PAGE_W - 13 - logoW, 8 + (blockH - logoH) / 2, logoW, logoH);
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    doc.setTextColor(...activeBranding.textSecondary);
    doc.text(`Exportiert am ${now}`, PAGE_W - 13, 8 + blockH - 2.5, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(...activeBranding.textPrimary);
    doc.text(activeBranding.displayName.toUpperCase(), 15, 18);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...activeBranding.textPrimary);
    doc.text(String(year), 15, 26);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...activeBranding.textSecondary);
    doc.text('Jahresübersicht', 15, 32.5);

    doc.setTextColor(0, 0, 0);
    const yH = 8 + blockH + 3;

    const KEY_ROWS: { id: string; isPct?: boolean; pctLabel?: string }[] = [
      { id: 'revenue_total' },
      { id: 'total_cogs',      isPct: true, pctLabel: 'Warenkosten %' },
      { id: 'total_personnel', isPct: true, pctLabel: 'Personalquote %' },
      { id: 'total_opex' },
      { id: 'ebitda',          isPct: true, pctLabel: 'EBITDA %' },
      { id: 'ebit',            isPct: true, pctLabel: 'EBIT %' },
    ];

    const months       = yearResult.months;
    const monthCols    = months.map((_, i) => MONTH_NAMES_SHORT_DE[i + 1]);
    const monthRevs    = months.map(mr => mr.rows.find(r => r.def.id === 'net_revenue')?.values.actual);
    const totalRevenue = yearResult.total.rows.find(r => r.def.id === 'net_revenue')?.values.actual;

    type YearCell = string | { content: string; styles: Record<string, unknown> };
    const yearBody: YearCell[][] = [];

    for (const keyRow of KEY_ROWS) {
      const template = monthResult.rows.find(r => r.def.id === keyRow.id);
      if (!template) continue;

      const isResult   = template.def.type === 'result';
      const isSubtotal = template.def.type === 'subtotal';
      const bold       = isResult || isSubtotal ? 'bold' : 'normal';
      const fillColor  = isResult   ? C.navyMid
                       : isSubtotal ? [228, 228, 238] as [number, number, number]
                       : undefined;
      const baseTxtColor = isResult ? C.white : undefined;
      const label = indent(template) + template.def.label;

      const cs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        fontStyle: bold,
        ...(fillColor    ? { fillColor }               : {}),
        ...(baseTxtColor ? { textColor: baseTxtColor } : {}),
        ...extra,
      });

      const totalRow   = yearResult.total.rows.find(r => r.def.id === keyRow.id);
      const totalV     = totalRow?.values.actual;
      const totalColor = resultActualColor(totalV, isResult, isSubtotal);

      const chfCells: YearCell[] = months.map((mr) => {
        const r    = mr.rows.find(row => row.def.id === keyRow.id);
        const v    = r?.values.actual;
        const vCol = resultActualColor(v, isResult, isSubtotal);
        return { content: fmtCHF(v), styles: cs({ halign: 'right', ...(vCol ? { textColor: vCol } : {}) }) };
      });

      yearBody.push([
        { content: label, styles: cs() },
        ...chfCells,
        { content: fmtCHF(totalV), styles: cs({ halign: 'right', fontStyle: 'bold', ...(totalColor ? { textColor: totalColor } : {}) }) },
      ]);

      if (keyRow.isPct) {
        const pctRowStyle: Record<string, unknown> = {
          fontStyle: 'italic' as const, fontSize: 6,
          textColor: isResult ? C.white : C.gray,
          fillColor: isResult ? C.navyMid : [244, 244, 247] as [number, number, number],
        };
        const pctCells: YearCell[] = months.map((mr, i) => {
          const r = mr.rows.find(row => row.def.id === keyRow.id);
          const v = r?.values.actual;
          return { content: fmtPctRatio(v, monthRevs[i]), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'normal' as const } };
        });
        yearBody.push([
          { content: `  ${keyRow.pctLabel ?? '% Umsatz'}`, styles: pctRowStyle },
          ...pctCells,
          { content: fmtPctRatio(totalV, totalRevenue), styles: { ...pctRowStyle, halign: 'right', fontStyle: 'bold' as const } },
        ]);
      }
    }

    const labelW = 34;
    const colW   = 12;
    autoTable(doc, {
      startY: yH,
      head: [['Position', ...monthCols, 'Total']],
      body: yearBody as string[][],
      theme: 'plain',
      headStyles: { fillColor: C.navyLight, textColor: C.white, fontStyle: 'bold', fontSize: 6, cellPadding: { top: 2, bottom: 2, left: 1, right: 1 } },
      bodyStyles: { fontSize: 6, cellPadding: { top: 1, bottom: 1, left: 1, right: 1 } },
      columnStyles: {
        0: { cellWidth: labelW },
        ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, { halign: 'right', cellWidth: colW }])),
      },
    });
  }

  // ── Seitenzahlen + Mini-Header auf Folgeseiten ────────────────────────────
  const totalPages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    // Mini-Header ab Seite 2
    if (p > 1) {
      addMiniHeader(doc, activeBranding, logoDataUrl, miniLabel, PAGE_W);
    }

    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...C.gray);
    doc.text(`Seite ${p} / ${totalPages}`, PAGE_W - 12, 290, { align: 'right' });
    doc.text(`${activeBranding.companyLine} · Erfolgsrechnung ${year} · ${now}`, 12, 290);
  }

  doc.save(`Erfolgsrechnung_${year}_${MONTH_NAMES_SHORT_DE[month]}.pdf`);
}
