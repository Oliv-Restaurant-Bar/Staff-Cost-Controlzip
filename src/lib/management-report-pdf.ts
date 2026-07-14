/**
 * Management-Report (PDF) — Mehrjahresanalyse Umsatz (Banken-/Investorensicht)
 * =============================================================================
 * Zweistufig für Testbarkeit (Muster: monatsabschluss-pdf.ts):
 *  - buildManagementReportData: REINE Datenaufbereitung (node-testbar, kein
 *    jsPDF) — alle Abschnitte als fertige Strings/Zeilen. Quelle ist
 *    AUSSCHLIESSLICH das MultiYearAnalysis-Objekt (keine Zweitberechnungen).
 *  - renderManagementReportPdf: Layout mit jsPDF + autoTable (KEINE Charts —
 *    Tabellen/Text genügen für den Bank-Report und bleiben robust).
 *
 * Zeichensicherheit: jsPDF-Helvetica (WinAnsi) kennt U+2212 (−) und U+00A0
 * (geschütztes Leerzeichen) nicht — pdfSafe() ersetzt beide.
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  fmtChf, fmtMio, fmtPct, fmtDeltaChf, fmtPpSigned, fmtQuotePct, buildMethodikNotes,
  type MultiYearAnalysis, type YearKpiComparison, type YearComparisonDelta,
} from './multi-year-analysis';
import { EBIT_REPORT_NOTE } from './bank-investor-analysis';

const SEVERITY_LABEL: Record<string, string> = {
  fehler: 'Fehler',
  warnung: 'Warnung',
  hinweis: 'Hinweis',
};

// ── Hilfen (rein) ────────────────────────────────────────────────────────────

/** Ersetzt Zeichen, die die PDF-Standardschrift (WinAnsi) nicht darstellt. */
export function pdfSafe(s: string): string {
  return s.replace(/\u2212/g, '-').replace(/\u00a0/g, ' ');
}

export function managementReportFileName(years: number[], restaurantName?: string): string {
  const slug = (restaurantName ?? 'restaurant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const span = years.length > 0 ? `${years[0]}-${years[years.length - 1]}` : 'ohne-daten';
  return `management-report_${slug || 'restaurant'}_${span}.pdf`;
}

// ── Datenmodell (rein) ───────────────────────────────────────────────────────

export interface ReportKeyValue {
  label: string;
  value: string;
}

export interface ManagementReportData {
  titel: string;
  untertitel: string;      // Jahresspanne
  restaurantName: string;
  erstelltAm: string;      // dd.MM.yyyy HH:mm
  executiveSummary: string[];
  kpis: ReportKeyValue[];
  /** Jahresübersicht: [Jahr, Umsatz, Δ VJ, Datenbasis] */
  jahresUebersichtHead: string[];
  jahresUebersicht: string[][];
  /** Monatstabelle: Kopf [Monat, <Jahr>…, Δ VJ %] + 12 Zeilen + Total */
  monatsTabelleHead: string[];
  monatsTabelle: string[][];
  /** Je Jahr: Top-/Flop-Monate + Quartalsanteile als Textzeilen */
  jahresDetails: { titel: string; zeilen: ReportKeyValue[] }[];
  hinweise: string[];
  /** Titel der Monatstabelle (positionsabhängig) */
  monatsTitel: string;
  /** §14: Datenqualität mit Schweregrad-Label (Fehler zuerst) */
  datenqualitaet: ReportKeyValue[];
  /** §14: Methodik-Hinweise (buildMethodikNotes + Datenquellen-Hinweise) */
  methodik: string[];
  /** Jahresvergleich (§5–§7): Kennzahlen × Jahre + Δ — leer, wenn kein cmp übergeben */
  jahresvergleichHead: string[];
  jahresvergleich: string[][];
  /** Teiljahr-/EBIT-/Datenqualitäts-Hinweise zum Jahresvergleich */
  jahresvergleichHinweise: string[];
  /** Personalkosten-Aussagen (§7) — identisch zur UI-HintBox */
  personalEntwicklung: string[];
  fileName: string;
}

/** REINE Aufbereitung — leitet alles aus dem Analysis-Objekt ab. */
export function buildManagementReportData(
  analysis: MultiYearAnalysis,
  opts: {
    restaurantName?: string; generatedAt?: string; dataSourceHints?: string[];
    /** DASSELBE cmp-Objekt wie die UI (UI ≡ Export, §10) */
    yearComparison?: YearKpiComparison;
    personnelInsights?: string[];
  } = {},
): ManagementReportData {
  const { years, baseYear, kpis, totals, monthRows, yearSummaries, position } = analysis;
  const isRevenue = position.semantics === 'revenue';
  const restaurantName = opts.restaurantName ?? 'Restaurant';

  const gen = opts.generatedAt ? new Date(opts.generatedAt) : new Date();
  const erstelltAm = Number.isNaN(gen.getTime())
    ? (opts.generatedAt ?? '')
    : `${String(gen.getDate()).padStart(2, '0')}.${String(gen.getMonth() + 1).padStart(2, '0')}.${gen.getFullYear()} ` +
      `${String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')}`;

  const kpiRows: ReportKeyValue[] = [
    {
      label: `${isRevenue ? 'Umsatz' : position.label} ${kpis.latestYear ?? '—'}${kpis.latestYearPartialLabel ? ` (${kpis.latestYearPartialLabel})` : ''}`,
      value: `CHF ${fmtChf(kpis.latestYearValue)}${kpis.latestYearValue != null ? ` (${fmtMio(kpis.latestYearValue)})` : ''}`,
    },
    {
      label: `${isRevenue ? 'Wachstum' : 'Veränderung'} vs. ${kpis.prevYear ?? 'Vorjahr'}${kpis.growthCommonMonths > 0 && kpis.growthCommonMonths < 12 ? ` (${kpis.growthCommonMonths} gemeinsame Monate)` : ''}`,
      value: kpis.growthPct == null ? '—' : `${fmtPct(kpis.growthPct)} (${fmtDeltaChf(kpis.growthChf)} CHF)`,
    },
    {
      label: kpis.cagrFromYear != null ? `CAGR ${kpis.cagrFromYear}–${kpis.cagrToYear} (volle Jahre)` : 'CAGR',
      value: kpis.cagrPct == null ? '— (braucht mind. 2 vollständige Jahre)' : fmtPct(kpis.cagrPct),
    },
    { label: isRevenue ? 'Ø monatliches Wachstum' : 'Ø monatliche Veränderung', value: fmtPct(kpis.avgMonthlyGrowthPct) },
    {
      label: `${isRevenue ? 'Bester Monat' : 'Höchster Monat'} ${kpis.latestYear ?? ''}`.trim(),
      value: kpis.bestMonth ? `${kpis.bestMonth.label} (CHF ${fmtChf(kpis.bestMonth.value)})` : '—',
    },
    {
      label: `${isRevenue ? 'Schwächster Monat' : 'Tiefster Monat'} ${kpis.latestYear ?? ''}`.trim(),
      value: kpis.worstMonth ? `${kpis.worstMonth.label} (CHF ${fmtChf(kpis.worstMonth.value)})` : '—',
    },
    {
      label: isRevenue ? 'Bestes Jahresergebnis' : 'Höchster Jahreswert',
      value: kpis.highestAnnual
        ? `${kpis.highestAnnual.year}: CHF ${fmtChf(kpis.highestAnnual.total)}${kpis.highestAnnual.isPartial ? ' (Teiljahr)' : ''}`
        : '—',
    },
    {
      label: isRevenue ? 'Umsatztrend' : `Trend ${position.label}`,
      value: kpis.trend === 'steigend' ? 'Steigend' : kpis.trend === 'ruecklaeufig' ? 'Rückläufig' : kpis.trend === 'stabil' ? 'Stabil' : '—',
    },
  ];

  const jahresUebersichtHead = ['Jahr', `${isRevenue ? 'Nettoumsatz' : position.label} CHF`, 'Δ Vorjahr', `Δ Basisjahr ${baseYear ?? ''}`.trim(), 'Datenbasis'];
  const jahresUebersicht = totals.map(t => [
    String(t.year),
    fmtChf(t.total),
    t.year === baseYear ? '—' : `${fmtPct(t.vsPrevYearCommon.pct)}${t.vsPrevYearCommon.commonMonths > 0 && t.vsPrevYearCommon.commonMonths < 12 ? ` (${t.vsPrevYearCommon.commonMonths} Mte.)` : ''}`,
    t.year === baseYear ? '—' : fmtPct(t.vsBaseYearCommon.pct),
    t.isPartial && t.partialLabel ? `Teiljahr: ${t.partialLabel}` : `${t.monthsWithData} Monate`,
  ]);

  // Monatsvergleich: Spalten = ALLE gewählten Jahre aus dem cmp-Objekt (auch
  // leere «—»-Jahre, mit «†» markiert) — identisch zur UI. Ohne cmp: Analysejahre.
  const monatsJahre = opts.yearComparison ? opts.yearComparison.years : years;
  const monatsLeereJahre = opts.yearComparison?.emptyYears ?? [];
  const monatsTabelleHead = [
    'Monat',
    ...monatsJahre.map(y => `${y}${monatsLeereJahre.includes(y) ? ' †' : ''}`),
    'Δ VJ',
  ];
  const monatsTabelle: string[][] = monthRows.map(row => {
    const lastCell = row.cells[row.cells.length - 1];
    return [
      row.label,
      ...monatsJahre.map(y => fmtChf(row.cells.find(c => c.year === y)?.value ?? null)),
      row.cells.length > 1 ? fmtPct(lastCell.vsPrevYear.pct) : '—',
    ];
  });
  const lastTotal = totals[totals.length - 1];
  monatsTabelle.push([
    'Total',
    ...monatsJahre.map(y => fmtChf(totals.find(t => t.year === y)?.total ?? null)),
    totals.length > 1 && lastTotal ? fmtPct(lastTotal.vsPrevYearCommon.pct) : '—',
  ]);

  const jahresDetails = yearSummaries.map(ys => ({
    titel: `${ys.year}${ys.isPartial && ys.partialLabel ? ` (Teiljahr: ${ys.partialLabel})` : ''} — CHF ${fmtChf(ys.total)}${ys.growthPct != null ? ` · ${fmtPct(ys.growthPct)} vs. VJ` : ''}`,
    zeilen: [
      {
        label: 'Top-Monate',
        value: ys.bestMonths.length > 0 ? ys.bestMonths.map(m => `${m.label} (${fmtChf(m.value)})`).join(', ') : '—',
      },
      {
        label: 'Schwächste Monate',
        value: ys.worstMonths.length > 0 ? ys.worstMonths.map(m => `${m.label} (${fmtChf(m.value)})`).join(', ') : '—',
      },
      {
        label: 'Quartalsanteile',
        value: ys.quarters.map(q => `${q.label}: ${q.sharePct != null ? `${q.sharePct.toFixed(0)} %` : '—'}`).join(' · '),
      },
    ],
  }));

  // §14: Datenqualität nach Schweregrad (Fehler zuerst), nie stillschweigend.
  const severityOrder = { fehler: 0, warnung: 1, hinweis: 2 } as const;
  const datenqualitaet: ReportKeyValue[] = [...analysis.dataQuality]
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .map(d => ({ label: SEVERITY_LABEL[d.severity] ?? d.severity, value: d.text }));

  // Jahresvergleich (§5–§7): reine Formatierung des übergebenen cmp-Objekts —
  // keine Zweitberechnung (UI ≡ Export).
  const cmp = opts.yearComparison;
  let jahresvergleichHead: string[] = [];
  let jahresvergleich: string[][] = [];
  const jahresvergleichHinweise: string[] = [];
  let personalEntwicklung: string[] = [];
  if (cmp && cmp.hasAnyData) {
    const pairs = cmp.years.slice(1).map((y, i) => ({ from: cmp.years[i], to: y }));
    const flPair = cmp.years.length >= 3
      ? { from: cmp.years[0], to: cmp.years[cmp.years.length - 1] }
      : null;
    jahresvergleichHead = [
      'Kennzahl',
      ...cmp.years.map(y => `${y}${cmp.partialYears.includes(y) ? ' *' : cmp.emptyYears.includes(y) ? ' †' : ''}`),
      ...pairs.map(p => `Δ ${p.to} vs. ${p.from}`),
      ...(flPair ? [`Δ ${flPair.to} vs. ${flPair.from}`] : []),
    ];
    const dText = (kind: 'chf' | 'quote', d: YearComparisonDelta | null): string => {
      if (!d) return '—';
      if (kind === 'quote') return fmtPpSigned(d.pp);
      return d.chf == null ? '—' : `${fmtDeltaChf(d.chf)} (${fmtPct(d.pct)})`;
    };
    jahresvergleich = cmp.rows.map(r => [
      r.def.label,
      ...r.valueByYear.map(v => (r.def.kind === 'quote' ? fmtQuotePct(v) : fmtChf(v))),
      ...r.deltas.map(d => dText(r.def.kind, d)),
      ...(flPair ? [dText(r.def.kind, r.firstToLast)] : []),
    ]);
    if (cmp.partialNote) {
      jahresvergleichHinweise.push(cmp.partialNote);
    }
    if (cmp.emptyNote) {
      jahresvergleichHinweise.push(cmp.emptyNote);
    }
    jahresvergleichHinweise.push(EBIT_REPORT_NOTE);
    for (const d of cmp.dataQuality) {
      jahresvergleichHinweise.push(`[${SEVERITY_LABEL[d.severity] ?? d.severity}] ${d.text}`);
    }
    personalEntwicklung = opts.personnelInsights ?? [];
  }

  return {
    titel: `Management-Report — Mehrjahresanalyse ${isRevenue ? 'Umsatz' : position.label}`,
    untertitel: years.length > 0 ? `Vergleichszeitraum ${years[0]}–${years[years.length - 1]}` : 'Keine Daten',
    restaurantName,
    erstelltAm,
    executiveSummary: analysis.executiveSummary,
    kpis: kpiRows,
    jahresUebersichtHead,
    jahresUebersicht,
    monatsTabelleHead,
    monatsTabelle,
    jahresDetails,
    hinweise: analysis.limitations,
    monatsTitel: isRevenue ? 'Monatsumsätze im Vergleich (CHF netto)' : `${position.label} pro Monat im Vergleich (CHF)`,
    datenqualitaet,
    methodik: buildMethodikNotes({ dataSourceHints: opts.dataSourceHints }),
    jahresvergleichHead,
    jahresvergleich,
    jahresvergleichHinweise,
    personalEntwicklung,
    fileName: managementReportFileName(years, opts.restaurantName),
  };
}

// ── Rendering (jsPDF + autoTable) ────────────────────────────────────────────

type RGB = [number, number, number];
const NAVY: RGB = [30, 41, 59];
const MUTED: RGB = [100, 116, 139];
const BORDER: RGB = [226, 232, 240];
const BG_LIGHT: RGB = [248, 250, 252];
const INDIGO: RGB = [79, 70, 229];

export function renderManagementReportPdf(data: ManagementReportData): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  let y = 16;

  const ensureSpace = (needed: number): void => {
    if (y + needed > pageH - 16) {
      doc.addPage();
      y = 16;
    }
  };

  // Kopf
  doc.setTextColor(...MUTED);
  doc.setFontSize(10);
  doc.text(pdfSafe(data.restaurantName), margin, y);
  y += 7;
  doc.setTextColor(...NAVY);
  doc.setFontSize(17);
  doc.setFont('helvetica', 'bold');
  doc.text(pdfSafe(data.titel), margin, y);
  doc.setFont('helvetica', 'normal');
  y += 6;
  doc.setFontSize(10);
  doc.setTextColor(...INDIGO);
  doc.text(pdfSafe(data.untertitel), margin, y);
  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(pdfSafe(`Erstellt am ${data.erstelltAm}`), margin, y);
  y += 5;
  doc.setDrawColor(...BORDER);
  doc.line(margin, y, pageW - margin, y);
  y += 3;

  const sectionTitle = (title: string): void => {
    ensureSpace(14);
    doc.setFontSize(12);
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    y += 6;
    doc.text(pdfSafe(title), margin, y);
    doc.setFont('helvetica', 'normal');
    y += 2;
  };

  const table = (head: string[][], body: string[][], opts: { numericFrom?: number } = {}): void => {
    autoTable(doc, {
      startY: y + 1,
      head: head.map(r => r.map(pdfSafe)),
      body: body.map(r => r.map(pdfSafe)),
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 1.8, textColor: NAVY as unknown as number[], lineColor: BORDER as unknown as number[], lineWidth: 0.1 },
      headStyles: { fillColor: NAVY as unknown as number[], textColor: [255, 255, 255] as unknown as number[], fontSize: 9 },
      alternateRowStyles: { fillColor: BG_LIGHT as unknown as number[] },
      theme: 'grid',
      didParseCell: (hook) => {
        if (opts.numericFrom != null && hook.column.index >= opts.numericFrom) {
          hook.cell.styles.halign = 'right';
        }
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
  };

  // 1. Jahresvergleich — Kennzahlen bis EBIT, dieselbe Datenbasis wie die UI
  if (data.jahresvergleich.length > 0) {
    sectionTitle('Jahresvergleich (Kennzahlen bis EBIT)');
    table([data.jahresvergleichHead], data.jahresvergleich, { numericFrom: 1 });
    if (data.jahresvergleichHinweise.length > 0) {
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      for (const h of data.jahresvergleichHinweise) {
        const lines = doc.splitTextToSize(pdfSafe(`• ${h}`), pageW - margin * 2) as string[];
        ensureSpace(lines.length * 4 + 2);
        y += 4;
        doc.text(lines, margin, y);
        y += (lines.length - 1) * 4;
      }
      y += 1;
    }
  }

  // 2. Monatsvergleich (Spalten = alle gewählten Jahre, leere Jahre «—»)
  sectionTitle(data.monatsTitel);
  table([data.monatsTabelleHead], data.monatsTabelle, { numericFrom: 1 });

  // 3. Personalkosten-Analyse — regelbasierte Aussagen aus dem cmp-Objekt
  if (data.jahresvergleich.length > 0 && data.personalEntwicklung.length > 0) {
    sectionTitle('Personalkosten-Analyse');
    doc.setFontSize(9.5);
    doc.setTextColor(...NAVY);
    for (const s of data.personalEntwicklung) {
      const lines = doc.splitTextToSize(pdfSafe(`• ${s}`), pageW - margin * 2) as string[];
      ensureSpace(lines.length * 4.6 + 2);
      y += 4.6;
      doc.text(lines, margin, y);
      y += (lines.length - 1) * 4.6;
    }
    y += 2;
  }

  // 4. Executive Summary
  sectionTitle('Executive Summary');
  if (data.executiveSummary.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    y += 5;
    doc.text('Keine Zusammenfassung verfügbar.', margin, y);
    y += 2;
  } else {
    doc.setFontSize(9.5);
    doc.setTextColor(...NAVY);
    for (const s of data.executiveSummary) {
      const lines = doc.splitTextToSize(pdfSafe(`• ${s}`), pageW - margin * 2) as string[];
      ensureSpace(lines.length * 4.6 + 2);
      y += 4.6;
      doc.text(lines, margin, y);
      y += (lines.length - 1) * 4.6;
    }
    y += 2;
  }

  // 5. Kennzahlen
  sectionTitle('Kennzahlen');
  table([['Kennzahl', 'Wert']], data.kpis.map(k => [k.label, k.value]), { numericFrom: 1 });

  // 6. Jahresübersicht
  sectionTitle('Jahresübersicht');
  table([data.jahresUebersichtHead], data.jahresUebersicht, { numericFrom: 1 });

  // Jahres-Details
  sectionTitle('Jahresanalysen');
  for (const jd of data.jahresDetails) {
    ensureSpace(24);
    doc.setFontSize(10);
    doc.setTextColor(...INDIGO);
    doc.setFont('helvetica', 'bold');
    y += 5.5;
    doc.text(pdfSafe(jd.titel), margin, y);
    doc.setFont('helvetica', 'normal');
    y += 1;
    table([], jd.zeilen.map(z => [z.label, z.value]));
  }

  // Datenqualität (§14 — Schweregrade, Fehler zuerst)
  if (data.datenqualitaet.length > 0) {
    sectionTitle('Datenqualität');
    table([['Schweregrad', 'Hinweis']], data.datenqualitaet.map(d => [d.label, d.value]));
  }

  // Methodik (§14 — nachvollziehbare Rechenregeln)
  if (data.methodik.length > 0) {
    sectionTitle('Methodik');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    for (const h of data.methodik) {
      const lines = doc.splitTextToSize(pdfSafe(`• ${h}`), pageW - margin * 2) as string[];
      ensureSpace(lines.length * 4.2 + 2);
      y += 4.2;
      doc.text(lines, margin, y);
      y += (lines.length - 1) * 4.2;
    }
  }

  // Fusszeile
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(
      pdfSafe(`${data.restaurantName} — ${data.titel} — Seite ${p}/${pages}`),
      pageW / 2,
      pageH - 8,
      { align: 'center' },
    );
  }
  return doc;
}

/** Komfort: aufbereiten, rendern und Download anstossen. */
export function exportManagementReportPDF(
  analysis: MultiYearAnalysis,
  opts: {
    restaurantName?: string; generatedAt?: string; dataSourceHints?: string[];
    yearComparison?: YearKpiComparison; personnelInsights?: string[];
  } = {},
): void {
  const data = buildManagementReportData(analysis, opts);
  const doc = renderManagementReportPdf(data);
  doc.save(data.fileName);
}
