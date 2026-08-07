/**
 * Personalkosten-Seiten-Export (PDF) — 1:1-Abbild der PersonalFix-Seite.
 *
 * Reine Darstellung: ALLE Zahlen kommen fertig berechnet aus der Seite
 * (gleiche Memos wie das Rendering) — hier findet KEINE Rechnung statt.
 * Ohne Verlaufs-/PKQ-Diagramme (bewusst, Befehl 08/2026).
 *
 * Abschnitte (in Seitenreihenfolge):
 *   1) Kopf: Hochrechnung Total + Budget/Abweichung/PKQ + FIX/FLEX + Ist-Zeile
 *   2) Fix-Lohnkosten (Name, Abteilung, Basis/Mt, inkl. 13./Mt, Total AG/Mt)
 *   3) Flex Kosten pro Mitarbeiter (AG/h, Plan/Ist Std, Flex Plan/Ist, Diff.)
 *   4) Flex-Auswertung — Plan vs. Ist (Ampel, Zeitraum, Diff, kumuliert)
 */
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// ── Formatierer — bewusst ASCII-sicher für jsPDF-Standardfonts ──────────────
// KEIN toLocaleString: de-CH-Währungsausgabe enthält NBSP/Narrow-NBSP, die
// Helvetica (WinAnsi) zerreisst («CHF 3 0», kaputte Sonderzeichen). Eigene
// Gruppierung mit geradem Apostroph, Minus als ASCII '-'.
const grp = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
const fmtCHF = (n: number) => {
  const v = Math.round(Math.abs(n));
  return `${n < 0 ? '-' : ''}CHF ${grp(String(v))}`;
};
const fmtCHFDec = (n: number) => {
  const v = Math.abs(n).toFixed(2);
  const [int, dec] = v.split('.');
  return `${n < 0 ? '-' : ''}CHF ${grp(int)}.${dec}`;
};
const fmtDiff = (v: number) => {
  const s = fmtCHF(Math.abs(v));
  return v > 0.005 ? `+${s}` : v < -0.005 ? `-${s}` : s;
};
const fmtPct = (v: number | null) => {
  if (v === null) return '-';
  const s = `${Math.abs(v).toFixed(1)} %`;
  return v > 0.05 ? `+${s}` : v < -0.05 ? `-${s}` : s;
};

// ── PDF-Anonymisierung ───────────────────────────────────────────────────────
// «Ramadani Mejdi» darf im exportierten PDF NIRGENDS im Klartext stehen —
// zentral hier für ALLE Tabellen (Fix UND Flex). On-screen bleibt der Name.
const ANON_LABEL = 'Zusatzkosten Fix-Lohn';
const anonName = (name: string) =>
  /ramadani|mejdi/i.test(name) ? ANON_LABEL : name;

// ── Farben (an die Seite angelehnt) ─────────────────────────────────────────
const C = {
  headerBlue:  [30, 58, 138] as [number, number, number],
  blue:        [29, 78, 216] as [number, number, number],
  lightBlue:   [219, 234, 254] as [number, number, number],
  orange:      [194, 65, 12] as [number, number, number],
  lightOrange: [255, 237, 213] as [number, number, number],
  green:       [4, 120, 87] as [number, number, number],
  lightGreen:  [209, 250, 229] as [number, number, number],
  red:         [185, 28, 28] as [number, number, number],
  lightRed:    [254, 226, 226] as [number, number, number],
  amber:       [180, 83, 9] as [number, number, number],
  lightAmber:  [254, 243, 199] as [number, number, number],
  muted:       [100, 116, 139] as [number, number, number],
  rowAlt:      [248, 250, 252] as [number, number, number],
  tableHead:   [241, 245, 249] as [number, number, number],
  border:      [226, 232, 240] as [number, number, number],
  black:       [15, 23, 42] as [number, number, number],
  white:       [255, 255, 255] as [number, number, number],
};

export type PkAmpel = 'green' | 'yellow' | 'red' | 'neutral';

const AMPEL_LABEL: Record<PkAmpel, string> = {
  green: 'Im Plan', yellow: 'Leicht über Plan', red: 'Über Plan', neutral: 'Kein Vergleich',
};
const AMPEL_FILL: Record<PkAmpel, [number, number, number] | null> = {
  green: C.lightGreen, yellow: C.lightAmber, red: C.lightRed, neutral: null,
};
const AMPEL_TEXT: Record<PkAmpel, [number, number, number]> = {
  green: C.green, yellow: C.amber, red: C.red, neutral: C.muted,
};

export interface PkSeitePdfData {
  tenantLabel: string;
  monthLabel: string;
  year: number;
  month: number;
  /**
   * false = Datenschutz-Modus: Fix-Tabelle ohne CHF-Spalten
   * (nur Name · Abteilung · Pensum %); Total FIX (Aggregat) bleibt sichtbar.
   */
  showWageDetail: boolean;

  // 1) Kopf (PkHeadline, SSOT personalkosten.ts)
  hrTotalCHF: number;
  hrFixCHF: number;
  hrFlexCHF: number;
  budgetCHF: number | null;
  umsatzBudgetCHF: number;
  zielQuote: number;              // Bruch, z.B. 0.355
  pkqHochrechnung: number | null; // Bruch
  umsatzHochrechnungCHF: number;
  istTotalCHF: number;
  umsatzIstCHF: number;
  pkqIst: number | null;          // Bruch
  istTage: number;
  daysInMonth: number;
  stichtag: number;
  agOffFlexCount: number;

  // 2) Fix-Lohnkosten (wie gefiltert angezeigt)
  fixFilterLabel: string | null;  // z.B. 'nur Küche' — null = Alle
  fixRows: Array<{
    name: string; label: string | null; dept: string;
    basis: number | null; inkl13: number | null; agMt: number;
    /** Pensum in % (weeklyHours ÷ 42 × 100), für den Datenschutz-Modus. */
    pensumPct: number | null;
  }>;
  fixTotals: { basis: number; inkl13: number; agMt: number };

  // 3) Flex Kosten pro Mitarbeiter
  flexProRataDay: number | null;
  flexRows: Array<{
    name: string; dept: string; hourly: number;
    planH: number; istH: number; planCHF: number; istCHF: number; diff: number;
    zusatz: boolean; lohnFehlt: boolean; agOff: boolean; manuell: boolean;
  }>;
  flexTotals: { planH: number; istH: number; planCHF: number; istCHF: number };
  flexManualNote: string | null;

  // 4) Flex-Auswertung — Plan vs. Ist (aktuelle Aggregation der Seite)
  abwModeLabel: string;           // 'Tag' | 'Woche' | 'Monat' | 'Jahr'
  abwStatus: PkAmpel;
  abwRows: Array<{
    period: string; plan: number; ist: number; diff: number;
    diffPct: number | null; cum: number; status: PkAmpel;
    /** true = Zeitraum ohne Ist (Zukunft) — «noch offen», keine Abweichung. */
    offen?: boolean;
  }>;
  abwTotal: { plan: number; ist: number; diff: number; diffPct: number | null } | null;
}

function stichtagDatum(year: number, month: number, stichtag: number): string {
  if (stichtag <= 0) return '—';
  return new Date(year, month - 1, stichtag).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
}

export function exportPersonalkostenSeiteToPDF(d: PkSeitePdfData): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 14; // Seitenrand
  let y = 0;

  const ensureSpace = (needed: number) => {
    const pageH = doc.internal.pageSize.getHeight();
    if (y + needed > pageH - 12) { doc.addPage(); y = 16; }
  };

  // ── Kopfband ──────────────────────────────────────────────────────────────
  doc.setFillColor(...C.headerBlue);
  doc.rect(0, 0, pageW, 24, 'F');
  doc.setTextColor(...C.white);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(`Personalkosten ${d.monthLabel}`, M, 10);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(
    `${d.tenantLabel} · Hochrechnung · Stand: ${d.stichtag} von ${d.daysInMonth} Tagen abgeschlossen` +
    (d.istTage < d.stichtag ? `, davon ${d.istTage} mit Ist-Umsatz` : ''),
    M, 16,
  );
  doc.setFontSize(7.5);
  doc.text(`Erstellt am ${new Date().toLocaleDateString('de-CH')} — ohne Verlaufs-/PKQ-Diagramme`, M, 21);
  y = 30;

  // ── 1) Kopf-Kernzahlen ────────────────────────────────────────────────────
  const hasBudget = d.budgetCHF != null;
  const abwHr = hasBudget ? d.hrTotalCHF - (d.budgetCHF as number) : 0;
  const abwPct = hasBudget && (d.budgetCHF as number) > 0 ? (abwHr / (d.budgetCHF as number)) * 100 : null;
  const ueberBudget = hasBudget && abwHr > 0.5;
  const pkqHrPct = d.pkqHochrechnung != null ? d.pkqHochrechnung * 100 : null;
  const zielPct = d.zielQuote * 100;

  doc.setTextColor(...C.black);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text('Personalkosten (Hochrechnung)', M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(19);
  doc.text(fmtCHF(d.hrTotalCHF), M, y + 8);
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted);
  doc.text(
    `Budget ${hasBudget ? fmtCHF(d.budgetCHF as number) : '—'} · Ziel ${zielPct.toFixed(1)} % / Obergrenze 40 %`,
    M, y + 14,
  );

  // Kernzahlen rechts: 2×2-Kartengrid (Label klein/grau, Wert gross/fett,
  // einheitliche Ausrichtung, klare Abstände).
  const gridX = pageW / 2 + 2;
  const gridW = pageW - M - gridX;
  const gap = 3;
  const cardW = (gridW - gap) / 2;
  const cardH = 15;
  const card = (col: number, row: number, label: string, value: string, sub: string | null, color?: [number, number, number]) => {
    const cx = gridX + col * (cardW + gap);
    const cy = y - 4 + row * (cardH + gap);
    doc.setFillColor(...C.white);
    doc.setDrawColor(...C.border);
    doc.roundedRect(cx, cy, cardW, cardH, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...C.muted);
    doc.text(label.toUpperCase(), cx + 3, cy + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
    doc.setTextColor(...(color ?? C.black));
    // Werte (CHF/%-Beträge) einheitlich rechtsbündig in der Karte
    doc.text(value, cx + cardW - 3, cy + 9.5, { align: 'right' });
    if (sub) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(...C.muted);
      doc.text(sub, cx + 3, cy + 13);
    }
  };
  card(0, 0, 'Budget', hasBudget ? fmtCHF(d.budgetCHF as number) : '—',
    hasBudget ? `${zielPct.toFixed(1)} % von Umsatz-Budget ${fmtCHF(d.umsatzBudgetCHF)}` : `Kein Umsatz-Budget hinterlegt`);
  card(1, 0, 'Abweichung (HR - Budget)',
    hasBudget ? `${abwHr >= 0 ? '+' : '-'}${fmtCHF(Math.abs(abwHr))}${abwPct != null ? ` (${abwHr >= 0 ? '+' : '-'}${Math.abs(abwPct).toFixed(1)} %)` : ''}` : '—',
    hasBudget ? (ueberBudget ? 'über Budget' : abwHr < -0.5 ? 'unter Budget' : 'im Budget') : 'Kein Budget hinterlegt',
    hasBudget ? (ueberBudget ? C.red : C.green) : undefined);
  card(0, 1, 'PKQ Hochrechnung', pkqHrPct != null ? `${pkqHrPct.toFixed(1)} %` : '—',
    `Umsatz HR ${fmtCHF(d.umsatzHochrechnungCHF)}`,
    pkqHrPct != null ? (pkqHrPct > 40 ? C.red : pkqHrPct > zielPct ? C.amber : C.green) : undefined);
  card(1, 1, 'FIX + FLEX', `${fmtCHF(d.hrFixCHF)} + ${fmtCHF(d.hrFlexCHF)}`, 'Hochrechnung Fix + Flex');

  y += 2 * cardH + gap + 4;

  // Ist-Zeile (grauer Balken wie auf der Seite)
  doc.setFillColor(...C.rowAlt);
  doc.setDrawColor(...C.border);
  doc.roundedRect(M, y - 4.5, pageW - 2 * M, 9, 1.5, 1.5, 'FD');
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...C.muted);
  doc.text(`IST BIS ${stichtagDatum(d.year, d.month, d.stichtag)}`, M + 3, y + 1);
  doc.setTextColor(...C.black);
  const istParts = [
    `Personalkosten Ist ${fmtCHF(d.istTotalCHF)}`,
    `Netto-Umsatz Ist ${fmtCHF(d.umsatzIstCHF)}`,
    `PKQ Ist ${d.pkqIst != null ? `${(d.pkqIst * 100).toFixed(1)} %` : '—'}`,
  ];
  doc.text(istParts.join('    ·    '), pageW - M - 3, y + 1, { align: 'right' });
  y += 9;

  if (d.agOffFlexCount > 0) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C.muted);
    doc.text(`${d.agOffFlexCount} Mitarbeiter ohne AG-Sozialkosten gerechnet`, M, y + 2);
    y += 5;
  }
  y += 4;

  const sectionHead = (title: string, note: string | null, color: [number, number, number]) => {
    ensureSpace(18);
    doc.setFillColor(...color);
    doc.rect(M, y, pageW - 2 * M, 7, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...C.white);
    doc.text(title, M + 3, y + 4.8);
    if (note) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      doc.text(note, pageW - M - 3, y + 4.8, { align: 'right' });
    }
    y += 9;
  };

  // ── 2) Fix-Lohnkosten ─────────────────────────────────────────────────────
  if (d.fixRows.length > 0) {
    sectionHead(
      `Fix-Lohnkosten (${d.fixRows.length})${d.fixFilterLabel ? ` — ${d.fixFilterLabel}` : ''}${d.showWageDetail ? '' : ' — ohne Detaillöhne'}`,
      `Total AG/Mt ${fmtCHF(d.fixTotals.agMt)}`,
      C.headerBlue,
    );
    const totalLabel = `Total FIX${d.fixFilterLabel ? ` — ${d.fixFilterLabel.replace(/^nur /, '')}` : ''}`;
    autoTable(doc, d.showWageDetail ? {
      startY: y,
      margin: { left: M, right: M },
      head: [['Name', 'Abteilung', 'Basis-Lohn/Mt', 'inkl. 13. /Mt', 'Total AG/Mt']],
      body: d.fixRows.map(r => [
        r.label ? `${anonName(r.name)}  [${r.label}]` : anonName(r.name),
        r.dept,
        r.basis != null && r.basis > 0 ? fmtCHFDec(r.basis) : '-',
        r.inkl13 != null && r.inkl13 > 0 ? fmtCHFDec(r.inkl13) : '-',
        r.agMt > 0 ? fmtCHF(r.agMt) + (r.label ? ' *' : '') : '-',
      ]),
      foot: [[
        totalLabel,
        '',
        fmtCHF(d.fixTotals.basis),
        fmtCHF(d.fixTotals.inkl13),
        fmtCHF(d.fixTotals.agMt),
      ]],
      styles: { fontSize: 7.5, cellPadding: 1.6, textColor: C.black, lineColor: C.border, lineWidth: 0.1 },
      headStyles: { fillColor: C.tableHead, textColor: C.muted, fontStyle: 'bold' },
      footStyles: { fillColor: C.lightBlue, textColor: C.blue, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.rowAlt },
      // Feste Spaltenbreiten (A4 nutzbar 182 mm): CHF-Spalten rechtsbündig,
      // Zahlen «schwimmen» nicht zwischen den Spalten.
      columnStyles: {
        0: { cellWidth: 56 }, 1: { cellWidth: 26 },
        2: { halign: 'right', cellWidth: 32 },
        3: { halign: 'right', cellWidth: 32 },
        4: { halign: 'right', cellWidth: 36, textColor: C.blue, fontStyle: 'bold' },
      },
    } : {
      // Datenschutz-Modus: KEINE CHF-Spalten pro Mitarbeiter — nur
      // Name · Abteilung · Pensum. Total FIX (Aggregat) bleibt sichtbar.
      startY: y,
      margin: { left: M, right: M },
      head: [['Name', 'Abteilung', 'Pensum']],
      body: d.fixRows.map(r => [
        r.label ? `${anonName(r.name)}  [${r.label}]` : anonName(r.name),
        r.dept,
        r.pensumPct != null ? `${Math.round(r.pensumPct)} %` : '-',
      ]),
      foot: [[totalLabel, '', fmtCHF(d.fixTotals.agMt)]],
      styles: { fontSize: 7.5, cellPadding: 1.6, textColor: C.black, lineColor: C.border, lineWidth: 0.1 },
      headStyles: { fillColor: C.tableHead, textColor: C.muted, fontStyle: 'bold' },
      footStyles: { fillColor: C.lightBlue, textColor: C.blue, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.rowAlt },
      columnStyles: {
        0: { cellWidth: 92 }, 1: { cellWidth: 50 },
        2: { halign: 'right', cellWidth: 40 },
      },
    });
    y = (doc as any).lastAutoTable.finalY + 3;
    const hasProRata = d.fixRows.some(r => r.label);
    if (hasProRata) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(...C.muted);
      doc.text('* pro rata (Ein-/Austritt bzw. Lohnwechsel im Monat)', M, y);
      y += 4;
    }
    y += 3;
  }

  // ── 3) Flex Kosten pro Mitarbeiter ────────────────────────────────────────
  if (d.flexRows.length > 0) {
    sectionHead(
      `Flex Kosten pro Mitarbeiter (${d.flexRows.length} MA)` +
      (d.flexProRataDay !== null ? ` — bis ${d.flexProRataDay}.` : ''),
      `Flex Ist ${fmtCHF(d.flexTotals.istCHF)}`,
      C.orange,
    );
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [['Name', 'Abt.', 'Total AG/h', 'Plan Std', 'Ist Std', 'Flex Plan', 'Flex Ist', 'Diff.']],
      body: d.flexRows.map(r => {
        const badges: string[] = [];
        const name = anonName(r.name);
        // Anonymisierte Zeile: «Zusatzkosten»-Badge wäre redundant zum Ersatztext
        if (r.zusatz && name !== ANON_LABEL) badges.push('Zusatzkosten');
        if (r.lohnFehlt) badges.push('Lohn fehlt');
        if (r.agOff) badges.push('ohne AG-Kosten');
        if (r.manuell) badges.push('Ist manuell');
        return [
          badges.length ? `${name}  [${badges.join(', ')}]` : name,
          r.dept,
          r.hourly > 0 ? r.hourly.toFixed(2) + (r.agOff ? ' *' : '') : '-',
          r.planH > 0 ? `${r.planH.toFixed(1)} h` : '-',
          r.istH > 0 ? `${r.istH.toFixed(1)} h` : '-',
          r.planCHF > 0 ? fmtCHF(r.planCHF) : '-',
          r.istCHF > 0 ? fmtCHF(r.istCHF) : '-',
          r.diff === 0 ? '-' : `${r.diff > 0 ? '+' : ''}${fmtCHF(r.diff)}`,
        ];
      }),
      foot: [[
        'Total', '', '',
        `${d.flexTotals.planH.toFixed(1)} h`,
        `${d.flexTotals.istH.toFixed(1)} h`,
        fmtCHF(d.flexTotals.planCHF),
        fmtCHF(d.flexTotals.istCHF),
        '',
      ]],
      styles: { fontSize: 7.5, cellPadding: 1.6, textColor: C.black, lineColor: C.border, lineWidth: 0.1 },
      headStyles: { fillColor: C.tableHead, textColor: C.muted, fontStyle: 'bold' },
      footStyles: { fillColor: C.lightOrange, textColor: C.orange, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: C.rowAlt },
      // Feste Spaltenbreiten (Σ = 182 mm): alle CHF-/Zahlenspalten rechtsbündig
      columnStyles: {
        0: { cellWidth: 46 }, 1: { cellWidth: 14 },
        2: { halign: 'right', cellWidth: 20 },
        3: { halign: 'right', cellWidth: 19, textColor: C.blue },
        4: { halign: 'right', cellWidth: 19, textColor: C.orange },
        5: { halign: 'right', cellWidth: 22, textColor: C.blue, fontStyle: 'bold' },
        6: { halign: 'right', cellWidth: 22, textColor: C.orange, fontStyle: 'bold' },
        7: { halign: 'right', cellWidth: 20 },
      },
      didParseCell: (hook) => {
        if (hook.section !== 'body') return;
        const row = d.flexRows[hook.row.index];
        if (!row) return;
        if (row.zusatz) hook.cell.styles.fillColor = C.lightOrange;
        // «ohne AG-Kosten» klar abgegrenzt: ganze Zeile kursiv + eigene
        // (hellgelbe) Zeilenfarbe — auf einen Blick erkennbar.
        if (row.agOff) {
          hook.cell.styles.fillColor = [254, 249, 195];
          hook.cell.styles.fontStyle = hook.cell.styles.fontStyle === 'bold' ? 'bolditalic' : 'italic';
        }
        if (hook.column.index === 7) {
          hook.cell.styles.textColor = row.diff > 0 ? C.red : row.diff < 0 ? C.green : C.muted;
        }
      },
    });
    y = (doc as any).lastAutoTable.finalY + 3;
    const notes: string[] = [];
    if (d.flexRows.some(r => r.agOff)) notes.push('* Gelb/kursiv markierte Zeilen: Bruttolohn OHNE AG-Sozialkosten');
    if (d.flexManualNote) notes.push(d.flexManualNote);
    for (const n of notes) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(...C.muted);
      doc.text(n, M, y); y += 3.6;
    }
    y += 3;
  }

  // ── 4) Flex-Auswertung — Plan vs. Ist ─────────────────────────────────────
  if (d.abwRows.length > 0) {
    sectionHead(
      `Flex-Auswertung — Plan vs. Ist (${d.abwModeLabel})`,
      AMPEL_LABEL[d.abwStatus],
      C.amber,
    );
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [['Status', 'Zeitraum', 'Flex Arbeit Plan', 'Flex Arbeit Ist', 'Diff. CHF', 'Diff. %', 'Kum. Abw. CHF']],
      body: d.abwRows.map(r => r.offen ? [
        // Zukunftswoche ohne Ist: klar als «noch offen» markiert — KEINE
        // Abweichung, KEINE Kumulation («100 % unter Plan»-Falle).
        'noch offen',
        r.period,
        fmtCHF(r.plan),
        '-',
        'kein Ist',
        '-',
        '-',
      ] : [
        AMPEL_LABEL[r.status],
        r.period,
        fmtCHF(r.plan),
        fmtCHF(r.ist),
        fmtDiff(r.diff),
        fmtPct(r.diffPct),
        `${r.cum > 0.005 ? '+' : r.cum < -0.005 ? '-' : ''}${fmtCHF(Math.abs(r.cum))}`,
      ]),
      foot: d.abwTotal ? [[
        AMPEL_LABEL[d.abwStatus],
        d.abwRows.some(r => r.offen) ? 'Total (bis Ist)' : 'Total',
        fmtCHF(d.abwTotal.plan),
        fmtCHF(d.abwTotal.ist),
        fmtDiff(d.abwTotal.diff),
        fmtPct(d.abwTotal.diffPct),
        `${d.abwTotal.diff > 0.005 ? '+' : d.abwTotal.diff < -0.005 ? '-' : ''}${fmtCHF(Math.abs(d.abwTotal.diff))}`,
      ]] : undefined,
      styles: { fontSize: 7.5, cellPadding: 1.4, textColor: C.black, lineColor: C.border, lineWidth: 0.1, overflow: 'linebreak' },
      headStyles: { fillColor: C.tableHead, textColor: C.muted, fontStyle: 'bold', fontSize: 7 },
      footStyles: { fillColor: C.tableHead, textColor: C.black, fontStyle: 'bold' },
      // Feste Spaltenbreiten: nichts wird abgeschnitten/zerrissen; Zahlen
      // rechtsbündig (A4 nutzbar: 182 mm).
      columnStyles: {
        0: { cellWidth: 25 },
        1: { cellWidth: 33 },
        2: { halign: 'right', cellWidth: 26, textColor: C.blue },
        3: { halign: 'right', cellWidth: 26, textColor: C.orange },
        4: { halign: 'right', cellWidth: 26, fontStyle: 'bold' },
        5: { halign: 'right', cellWidth: 20 },
        6: { halign: 'right', cellWidth: 26, fontStyle: 'bold' },
      },
      didParseCell: (hook) => {
        const row = hook.section === 'body' ? d.abwRows[hook.row.index] : null;
        if (hook.section === 'body' && row?.offen) {
          hook.cell.styles.textColor = C.muted;
          hook.cell.styles.fontStyle = 'italic';
          return;
        }
        const status = hook.section === 'body' ? row?.status : d.abwTotal ? d.abwStatus : null;
        if (!status) return;
        if (hook.column.index === 0) {
          const fill = AMPEL_FILL[status];
          if (fill) hook.cell.styles.fillColor = fill;
          hook.cell.styles.textColor = AMPEL_TEXT[status];
          hook.cell.styles.fontSize = 6.8;
        }
        if (hook.column.index === 4 || hook.column.index === 5) {
          hook.cell.styles.textColor = AMPEL_TEXT[status];
        }
        if (hook.section === 'body' && hook.column.index === 6 && row) {
          hook.cell.styles.textColor = row.cum > 0.005 ? C.red : row.cum < -0.005 ? C.green : C.muted;
        }
      },
    });
    y = (doc as any).lastAutoTable.finalY + 3;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(...C.muted);
    doc.text('Ampel: Grün = im Plan · Gelb = bis 5 % über Plan · Rot = über 5 % über Plan · «noch offen» = Zeitraum ohne Ist (zählt nicht)', M, y);
  }

  // ── Fusszeile mit Seitenzahlen ────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.muted);
    doc.text(`Personalkosten ${d.monthLabel} — ${d.tenantLabel}`, M, pageH - 6);
    doc.text(`Seite ${p} von ${pages}`, pageW - M, pageH - 6, { align: 'right' });
  }

  const mm = String(d.month).padStart(2, '0');
  doc.save(`Personalkosten_${d.tenantLabel}_${d.year}-${mm}.pdf`);
}
