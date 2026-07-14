/**
 * PDF-Export „Banken-/Investorenbericht" (Geschäftsentwicklung Basis–Aktuell)
 * ============================================================================
 * Zweistufig für Testbarkeit (Muster: management-report-pdf.ts):
 *  - buildBankInvestorPdfData: REINE Datenaufbereitung (node-testbar, kein
 *    jsPDF) — alle Abschnitte als fertige Strings/Zeilen. Quelle ist
 *    AUSSCHLIESSLICH das BankInvestorAnalysis-Objekt (keine Zweitberechnung),
 *    d. h. exakt dieselben Zahlen wie Bildschirm & Excel.
 *  - renderBankInvestorPdf: Layout mit jsPDF + autoTable (Tabellen/Text —
 *    robust und druckbar, A4 hoch, saubere Seitenumbrüche, Seitenzahlen).
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { BankInvestorAnalysis } from './bank-investor-analysis';
import { fmtPctChange, fmtPp } from './bank-investor-analysis';
import { MONTH_LABELS_LONG } from './multi-year-analysis';

const SEVERITY_LABEL: Record<string, string> = {
  fehler: 'Fehler',
  warnung: 'Warnung',
  hinweis: 'Hinweis',
};

/** Ersetzt Zeichen, die die PDF-Standardschrift (WinAnsi) nicht darstellt. */
export function pdfSafe(s: string): string {
  return s.replace(/\u2212/g, '-').replace(/\u00a0/g, ' ');
}

export function bankInvestorPdfFileName(baseYear: number, currentYear: number, restaurantName?: string): string {
  const slug = (restaurantName ?? 'restaurant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `banken-investorenbericht_${slug || 'restaurant'}_${baseYear}-${currentYear}.pdf`;
}

// ── Datenmodell (rein) ───────────────────────────────────────────────────────

export interface BankPdfKeyValue {
  label: string;
  value: string;
  /** good | critical | neutral — steuert dezente Einfärbung */
  tone?: string;
}

export interface BankPdfTable {
  titel: string;
  head: string[];
  rows: string[][];
  /** Zeilenindizes, die fett hervorgehoben werden (Zwischentotale) */
  strongRows?: number[];
}

export interface BankInvestorPdfData {
  titel: string;
  untertitel: string;
  restaurantName: string;
  erstelltAm: string;
  vergleichsLabel: string;
  importStand: string;
  datenquelle: string;
  /** Gesamttrend (Phase 2 §2) — regelbasierte Einordnung */
  gesamtTrend: BankPdfKeyValue;
  kpis: BankPdfKeyValue[];
  /** Mehrjahres-Scorecard (Phase 2 §3) */
  scorecardTabelle: BankPdfTable;
  /** Waterfall Umsatz→EBIT (Phase 2 §4) */
  waterfallTabelle: BankPdfTable;
  /** EBIT-Treiber (Phase 2 §5) */
  ebitTreiberZusammenfassung: BankPdfKeyValue[];
  ebitTreiberTabelle: BankPdfTable;
  umsatzTabelle: BankPdfTable;
  umsatzErkenntnisse: BankPdfKeyValue[];
  warenTabelle: BankPdfTable;
  warenZusammenfassung: BankPdfKeyValue[];
  personalTabelle: BankPdfTable;
  personalZusammenfassung: BankPdfKeyValue[];
  zwischentotale: BankPdfTable;
  /** EBIT-Hinweis (identisch UI/Excel) — direkt unter den Zwischentotalen */
  ebitHinweis: string;
  kostenstruktur: BankPdfTable;
  /** Kennzahlenhistorie über alle gewählten Jahre (Phase 2 §6) */
  historieTabelle: BankPdfTable;
  /** Benchmark-Vergleich (Phase 2 §7) */
  benchmarkTabelle: BankPdfTable;
  /** Legacy-Kernaussagen (Phase 1, bleibt für Kompatibilität) */
  kernaussagen: string[];
  /** Kernaussagen 5+5 (Phase 2 §9) */
  kernaussagenPositive: string[];
  kernaussagenPotenziale: string[];
  /** Investor Timeline (Phase 2 §10) */
  timelineTabelle: BankPdfTable;
  datenhinweise: BankPdfKeyValue[];
  fileName: string;
}

const chfS = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('de-CH');
const pctS = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

/** REINE Aufbereitung — leitet alles aus dem Analysis-Objekt ab. */
export function buildBankInvestorPdfData(
  analysis: BankInvestorAnalysis,
  opts: { generatedAt?: string } = {},
): BankInvestorPdfData {
  const { baseYear, currentYear, header, comparison } = analysis;

  const gen = opts.generatedAt ? new Date(opts.generatedAt) : new Date();
  const erstelltAm = Number.isNaN(gen.getTime())
    ? (opts.generatedAt ?? '')
    : `${String(gen.getDate()).padStart(2, '0')}.${String(gen.getMonth() + 1).padStart(2, '0')}.${gen.getFullYear()} ` +
      `${String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')}`;

  const kpis: BankPdfKeyValue[] = analysis.kpis.map(k => ({
    label: k.label,
    value: k.delta ? `${k.value}  (${k.delta})` : k.value,
    tone: k.tone,
  }));

  const umsatzTabelle: BankPdfTable = {
    titel: 'Umsatzentwicklung nach Monat',
    head: ['Monat', `${baseYear} CHF`, `${currentYear} CHF`, 'Diff CHF', 'Diff %'],
    rows: analysis.revenueMonths.map(p => [
      MONTH_LABELS_LONG[p.monthIdx],
      chfS(p.base), chfS(p.current), chfS(p.diffChf),
      p.diffPct == null ? 'nicht vergleichbar' : fmtPctChange(p.diffPct),
    ]),
  };

  const ins = analysis.revenueInsights;
  const umsatzErkenntnisse: BankPdfKeyValue[] = [
    { label: 'Stärkster Monat', value: ins.strongestMonth ? `${ins.strongestMonth.label} (CHF ${chfS(ins.strongestMonth.value)})` : '—' },
    { label: 'Schwächster Monat', value: ins.weakestMonth ? `${ins.weakestMonth.label} (CHF ${chfS(ins.weakestMonth.value)})` : '—' },
    { label: 'Grösster Zuwachs', value: ins.largestGain ? `${ins.largestGain.label} (+CHF ${chfS(ins.largestGain.diffChf)})` : '—' },
    { label: 'Grösster Rückgang', value: ins.largestDecline ? `${ins.largestDecline.label} (−CHF ${chfS(Math.abs(ins.largestDecline.diffChf))})` : '—' },
    { label: 'Jahreswachstum', value: ins.growthPct == null ? 'nicht vergleichbar' : fmtPctChange(ins.growthPct) },
  ];

  const costTable = (titel: string, months: typeof analysis.wareMonths): BankPdfTable => ({
    titel,
    head: ['Monat', `${baseYear} CHF`, `${currentYear} CHF`, `Quote ${baseYear}`, `Quote ${currentYear}`],
    rows: months.map(p => [
      MONTH_LABELS_LONG[p.monthIdx],
      chfS(p.base), chfS(p.current), pctS(p.baseQuote), pctS(p.currentQuote),
    ]),
  });

  const costSummaryRows = (s: typeof analysis.wareSummary, name: string): BankPdfKeyValue[] => [
    { label: `${name} ${baseYear}`, value: `CHF ${chfS(s.baseTotal)}` },
    { label: `${name} ${currentYear}`, value: `CHF ${chfS(s.currentTotal)}` },
    { label: 'Veränderung', value: s.diffChf == null ? '—' : `${s.diffChf >= 0 ? '+' : '−'}CHF ${chfS(Math.abs(s.diffChf))} (${s.diffPct == null ? 'nicht vergleichbar' : fmtPctChange(s.diffPct)})` },
    { label: `Quote ${baseYear}`, value: pctS(s.baseQuote) },
    { label: `Quote ${currentYear}`, value: pctS(s.currentQuote) },
    { label: 'Veränderung Quote', value: s.quotePp == null ? '—' : fmtPp(s.quotePp) },
  ];

  const zwischentotale: BankPdfTable = {
    titel: 'Zwischentotale und Margen',
    head: ['Kennzahl', `${baseYear}`, `${currentYear}`, 'Δ CHF', 'Δ %', `Quote ${baseYear}`, `Quote ${currentYear}`, 'Δ Quote'],
    rows: analysis.totalsRows.map(r => [
      r.label,
      chfS(r.base), chfS(r.current), chfS(r.diffChf),
      r.diffPct == null ? 'n. vgl.' : fmtPctChange(r.diffPct),
      pctS(r.baseQuote), pctS(r.currentQuote),
      r.quotePp == null ? '—' : fmtPp(r.quotePp),
    ]),
    strongRows: analysis.totalsRows
      .map((r, i) => (r.emphasis ? i : -1))
      .filter(i => i >= 0),
  };

  const kostenstruktur: BankPdfTable = {
    titel: 'Kostenstruktur (Anteil am Umsatz)',
    head: ['Jahr', 'Warenaufwand', 'Personalaufwand', 'Übriger Betriebsaufwand', 'Abschreibungen', 'Betriebsergebnis'],
    rows: analysis.costStructure.map(cs => [
      String(cs.year),
      pctS(cs.shares.ware), pctS(cs.shares.personal), pctS(cs.shares.uebrig),
      pctS(cs.shares.abschreibungen), pctS(cs.shares.ebit),
    ]),
  };

  const datenhinweise: BankPdfKeyValue[] = analysis.dataQuality.length > 0
    ? analysis.dataQuality.map(d => ({ label: SEVERITY_LABEL[d.severity] ?? d.severity, value: d.text }))
    : [{ label: '—', value: 'Keine Datenqualitätshinweise.' }];

  // ── Phase 2: Gesamttrend + Scorecard + Waterfall + Treiber + Historie +
  //    Benchmark + Timeline (alles direkt aus dem Analysis-Objekt) ────────────
  const trend = analysis.executive.gesamtTrend;
  const gesamtTrend: BankPdfKeyValue = {
    label: 'Gesamttrend',
    value: `${trend.label} — ${trend.reasons.join(' · ')}`,
    tone: trend.tone,
  };

  const sc = analysis.scorecard;
  const TREND_WORD: Record<string, string> = {
    steigend: 'steigend', fallend: 'fallend', stabil: 'stabil', gemischt: 'gemischt',
  };
  const scorecardTabelle: BankPdfTable = {
    titel: `Mehrjahres-Scorecard (${sc.years.join(' / ')})`,
    head: ['Kennzahl', ...sc.years.map(String), ...sc.years.map(y => `Quote ${y}`), 'Δ CHF', 'Δ %', 'Trend'],
    rows: sc.rows.map(r => [
      r.label,
      ...r.values.map(chfS),
      ...r.quotes.map(pctS),
      chfS(r.diffChf),
      r.diffPct == null ? 'n. vgl.' : fmtPctChange(r.diffPct),
      r.trend ? TREND_WORD[r.trend] ?? r.trend : '—',
    ]),
    strongRows: sc.rows.map((r, i) => (r.emphasis ? i : -1)).filter(i => i >= 0),
  };

  const wf = analysis.waterfall;
  const waterfallTabelle: BankPdfTable = {
    titel: `Vom Umsatz zum EBIT ${wf.year}`,
    head: ['Stufe', 'Betrag CHF', 'Zwischenstand CHF'],
    rows: wf.steps.map(s => [
      s.label,
      s.value == null ? '—' : `${s.kind === 'cost' ? '−' : ''}${chfS(Math.abs(s.value))}`,
      chfS(s.cumulative),
    ]),
    strongRows: wf.steps.map((s, i) => (s.kind !== 'cost' ? i : -1)).filter(i => i >= 0),
  };

  const drv = analysis.ebitDrivers;
  const ebitTreiberZusammenfassung: BankPdfKeyValue[] = [
    { label: `EBIT ${drv.baseYear}`, value: `CHF ${chfS(drv.ebitBase)}` },
    { label: `EBIT ${drv.currentYear}`, value: `CHF ${chfS(drv.ebitCurrent)}` },
    { label: 'Veränderung', value: drv.ebitDelta == null ? '—' : `${drv.ebitDelta >= 0 ? '+' : '−'}CHF ${chfS(Math.abs(drv.ebitDelta))}` },
  ];
  const ebitTreiberTabelle: BankPdfTable = {
    titel: `EBIT-Treiber ${drv.baseYear} → ${drv.currentYear}`,
    head: ['Treiber', 'Beitrag CHF', 'in % des Basis-EBIT'],
    rows: drv.drivers.map(d => [
      d.label,
      d.contribution == null ? '—' : `${d.contribution >= 0 ? '+' : '−'}${chfS(Math.abs(d.contribution))}`,
      pctS(d.pctOfBaseEbit),
    ]),
  };

  const histYears = analysis.years;
  const historieTabelle: BankPdfTable = {
    titel: 'Kennzahlenhistorie (volle Jahressummen, * = Teiljahr)',
    head: ['Kennzahl', ...histYears.map(String)],
    rows: analysis.historie.map(s => [
      s.label,
      ...histYears.map(y => {
        const p = s.points.find(pt => pt.year === y);
        if (!p || p.value == null) return '—';
        const val = s.unit === 'chf' ? chfS(p.value) : pctS(p.value);
        return p.complete ? val : `${val} *`;
      }),
    ]),
  };

  const benchmarkTabelle: BankPdfTable = {
    titel: `Benchmark-Vergleich ${currentYear}`,
    head: ['Kennzahl', 'Ist', 'Ziel', 'Abweichung', 'Bewertung'],
    rows: analysis.benchmarks.map(b => [
      b.label,
      pctS(b.ist),
      `${b.direction === 'below' ? '<=' : '>='} ${pctS(b.target)}`,
      b.abweichungPp == null ? '—' : fmtPp(b.abweichungPp),
      b.ist == null ? 'keine Daten' : b.tone === 'good' ? 'erfüllt' : b.tone === 'critical' ? 'verfehlt' : 'im Toleranzband',
    ]),
  };

  const timelineTabelle: BankPdfTable = {
    titel: 'Datenbasis je Geschäftsjahr',
    head: ['Jahr', 'Status', 'Monate mit Daten', 'Umsatz CHF', 'EBIT CHF', 'Importiert am'],
    rows: analysis.timeline.map(tl => {
      let importedAt = '—';
      if (tl.importedAt) {
        const d = new Date(tl.importedAt);
        importedAt = Number.isNaN(d.getTime()) ? tl.importedAt :
          `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
      }
      return [String(tl.year), tl.status, `${tl.monthsWithData} / 12`, chfS(tl.umsatz), chfS(tl.ebit), importedAt];
    }),
  };

  return {
    titel: header.title,
    untertitel: `${baseYear}–${currentYear}`,
    restaurantName: header.restaurantName,
    erstelltAm,
    vergleichsLabel: comparison.label,
    importStand: header.importStand ?? '—',
    datenquelle: header.dataSource,
    gesamtTrend,
    kpis,
    scorecardTabelle,
    waterfallTabelle,
    ebitTreiberZusammenfassung,
    ebitTreiberTabelle,
    umsatzTabelle,
    umsatzErkenntnisse,
    warenTabelle: costTable('Warenaufwand und Warenquote', analysis.wareMonths),
    warenZusammenfassung: costSummaryRows(analysis.wareSummary, 'Warenaufwand'),
    personalTabelle: costTable('Personalaufwand und Personalquote', analysis.personalMonths),
    personalZusammenfassung: costSummaryRows(analysis.personalSummary, 'Personalaufwand'),
    zwischentotale,
    ebitHinweis: analysis.ebitNote,
    kostenstruktur,
    historieTabelle,
    benchmarkTabelle,
    kernaussagen: analysis.kernaussagen,
    kernaussagenPositive: analysis.kernaussagenPlus.positive,
    kernaussagenPotenziale: analysis.kernaussagenPlus.potenziale,
    timelineTabelle,
    datenhinweise,
    fileName: bankInvestorPdfFileName(baseYear, currentYear, header.restaurantName),
  };
}

// ── Rendering (jsPDF + autoTable) ────────────────────────────────────────────

const MARGIN = 14;
const ACCENT: [number, number, number] = [55, 65, 81];   // dezentes Grau-Blau
const LIGHT: [number, number, number] = [243, 244, 246];

export function renderBankInvestorPdf(data: BankInvestorPdfData): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  let y = MARGIN;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 18) { doc.addPage(); y = MARGIN; }
  };

  const sectionTitle = (titel: string) => {
    ensureSpace(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...ACCENT);
    doc.text(pdfSafe(titel), MARGIN, y);
    y += 5;
  };

  const kvTable = (rows: BankPdfKeyValue[], colored = false) => {
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [],
      body: rows.map(r => [pdfSafe(r.label), pdfSafe(r.value)]),
      theme: 'plain',
      styles: { fontSize: 9, cellPadding: 1.4 },
      columnStyles: { 0: { cellWidth: 70, textColor: [90, 90, 90] }, 1: { fontStyle: 'bold' } },
      didParseCell: colored ? (hook) => {
        if (hook.column.index === 1) {
          const tone = rows[hook.row.index]?.tone;
          if (tone === 'good') hook.cell.styles.textColor = [22, 121, 63];
          else if (tone === 'critical') hook.cell.styles.textColor = [185, 28, 28];
        }
      } : undefined,
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  };

  const dataTable = (table: BankPdfTable) => {
    sectionTitle(table.titel);
    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN },
      head: [table.head.map(pdfSafe)],
      body: table.rows.map(r => r.map(pdfSafe)),
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: ACCENT, textColor: 255, fontSize: 8 },
      alternateRowStyles: { fillColor: LIGHT },
      columnStyles: { 0: { halign: 'left' } },
      bodyStyles: { halign: 'right' },
      didParseCell: (hook) => {
        if (hook.section === 'body' && hook.column.index === 0) hook.cell.styles.halign = 'left';
        if (hook.section === 'body' && table.strongRows?.includes(hook.row.index)) {
          hook.cell.styles.fontStyle = 'bold';
        }
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  };

  // ── Berichtskopf ────────────────────────────────────────────────────────────
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, pageW, 30, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text(pdfSafe(data.titel), MARGIN, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(pdfSafe(`${data.restaurantName} · ${data.vergleichsLabel}`), MARGIN, 20);
  doc.text(pdfSafe(`Erstellt am ${data.erstelltAm} · Importstand: ${data.importStand} · Quelle: ${data.datenquelle}`), MARGIN, 25.5);
  y = 38;
  doc.setTextColor(0, 0, 0);

  // Kleingedruckter Hinweistext (z. B. EBIT-Hinweis) — mit Zeilenumbruch.
  const noteText = (text: string) => {
    const lines = doc.splitTextToSize(pdfSafe(text), pageW - 2 * MARGIN) as string[];
    ensureSpace(lines.length * 3.6 + 4);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 110);
    doc.text(lines, MARGIN, y);
    doc.setTextColor(0, 0, 0);
    y += lines.length * 3.6 + 4;
  };

  // ── Abschnitte (Reihenfolge = Bildschirm) ───────────────────────────────────
  // 1. Executive Summary: Gesamttrend + KPIs
  sectionTitle('Executive Summary');
  kvTable([data.gesamtTrend, ...data.kpis], true);

  // 2. Mehrjahres-Scorecard
  dataTable(data.scorecardTabelle);

  // 3. Waterfall Umsatz→EBIT
  dataTable(data.waterfallTabelle);

  // 4. EBIT-Treiber
  dataTable(data.ebitTreiberTabelle);
  kvTable(data.ebitTreiberZusammenfassung);

  // 5. Umsatzentwicklung
  dataTable(data.umsatzTabelle);
  sectionTitle('Erkenntnisse Umsatz');
  kvTable(data.umsatzErkenntnisse);

  // 6.+7. Waren-/Personalaufwand
  dataTable(data.warenTabelle);
  kvTable(data.warenZusammenfassung);

  dataTable(data.personalTabelle);
  kvTable(data.personalZusammenfassung);

  // 8. Zwischentotale + EBIT-Hinweis
  dataTable(data.zwischentotale);
  noteText(data.ebitHinweis);

  // 9. Kostenstruktur + Kennzahlenhistorie
  dataTable(data.kostenstruktur);
  dataTable(data.historieTabelle);

  // 10. Benchmark
  dataTable(data.benchmarkTabelle);

  // 11. Kernaussagen 5+5
  sectionTitle('Kernaussagen');
  const hasPlus = data.kernaussagenPositive.length > 0 || data.kernaussagenPotenziale.length > 0;
  if (hasPlus) {
    kvTable([
      ...data.kernaussagenPositive.map(s => ({ label: 'Positiv', value: s, tone: 'good' })),
      ...data.kernaussagenPotenziale.map(s => ({ label: 'Potenzial', value: s, tone: 'critical' })),
    ], true);
  } else if (data.kernaussagen.length > 0) {
    kvTable(data.kernaussagen.map((s, i) => ({ label: `${i + 1}.`, value: s })));
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Keine Kernaussagen verfügbar (unzureichende Datenbasis).', MARGIN, y);
    y += 8;
  }

  // 12. Investor Timeline + Datenhinweise
  dataTable(data.timelineTabelle);

  sectionTitle('Datenhinweise und Importstand');
  kvTable(data.datenhinweise);

  // ── Fusszeile: Seitenzahlen + Datenstand ────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    doc.text(pdfSafe(`${data.restaurantName} · ${data.titel} · Stand ${data.erstelltAm}`), MARGIN, pageH - 8);
    doc.text(`Seite ${i} / ${pageCount}`, pageW - MARGIN, pageH - 8, { align: 'right' });
  }

  return doc;
}

/** Bildschirm-identische Daten → PDF-Download (Browser). */
export function exportBankInvestorPDF(analysis: BankInvestorAnalysis): void {
  const data = buildBankInvestorPdfData(analysis);
  const doc = renderBankInvestorPdf(data);
  doc.save(data.fileName);
}
