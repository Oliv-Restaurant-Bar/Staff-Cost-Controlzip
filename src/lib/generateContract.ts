/**
 * Arbeitsvertrag-Generator für oLiv Restaurant & Bar
 *
 * Erzeugt automatisch einen PDF-Arbeitsvertrag auf Basis der Mitarbeiterdaten.
 * Zwei Vorlagen:
 *   ML = Monatslohn (Festanstellung, Vollzeit oder Teilzeit)
 *   SL = Stundenlohn (Aushilfe / unregelmässige Arbeitszeit)
 */

import jsPDF from 'jspdf';
import { Employee } from '@/types/personnel';

// ── Hilfsfunktionen ────────────────────────────────────────────────────────────

function formatDate(iso?: string): string {
  if (!iso) return '___________';
  const d = new Date(iso);
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatCHF(v?: number): string {
  if (!v) return '___________';
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(v);
}

function formatAHV(ahv?: string): string {
  if (!ahv) return '___________';
  return ahv;
}

function permitLabel(p?: string): string {
  const map: Record<string, string> = {
    swiss: 'Schweizer Bürger/in',
    C: 'Ausweis C (Niederlassungsbewilligung)',
    B: 'Ausweis B (Aufenthaltsbewilligung)',
    L: 'Ausweis L (Kurzaufenthaltsbewilligung)',
    G: 'Ausweis G (Grenzgängerbewilligung)',
    other: 'Anderer Aufenthaltsstatus',
  };
  return p ? (map[p] ?? p) : '___________';
}

function maritalLabel(m?: string): string {
  const map: Record<string, string> = {
    single: 'Ledig',
    married: 'Verheiratet',
    divorced: 'Geschieden',
    widowed: 'Verwitwet',
  };
  return m ? (map[m] ?? m) : '___________';
}

function deptLabel(d?: string): string {
  return d === 'küche' ? 'Küche' : d === 'service' ? 'Service' : '___________';
}

/**
 * Bestimmt die Vertragsart anhand der Mitarbeiterdaten.
 *   'ML' = Monatslohn-Vertrag
 *   'SL' = Stundenlohn-Vertrag
 */
export function detectContractTemplate(emp: Employee): 'ML' | 'SL' {
  if (emp.contractType === 'monthly') return 'ML';
  if (emp.contractType === 'hourly' || emp.contractType === 'irregular') return 'SL';
  // Fallback auf Basis der Lohndaten
  if (emp.monthlySalary && emp.monthlySalary > 0) return 'ML';
  return 'SL';
}

// ── PDF-Layout-Konstanten ──────────────────────────────────────────────────────

const MARGIN_L = 20;
const MARGIN_R = 190;
const LINE_H   = 6;
const PAGE_H   = 287;

// ── Zeichenhilfen ──────────────────────────────────────────────────────────────

interface PDFContext {
  doc:   jsPDF;
  y:     number;
  page:  number;
}

function newPage(ctx: PDFContext): PDFContext {
  ctx.doc.addPage();
  return { doc: ctx.doc, y: 20, page: ctx.page + 1 };
}

function checkSpace(ctx: PDFContext, needed = 20): PDFContext {
  if (ctx.y + needed > PAGE_H - 15) return newPage(ctx);
  return ctx;
}

function drawHeader(ctx: PDFContext, template: 'ML' | 'SL'): PDFContext {
  const { doc } = ctx;
  let y = ctx.y;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(40, 40, 40);
  doc.text('oLiv Restaurant & Bar', MARGIN_L, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text('Seftigenstrasse 101 · 3007 Bern · Tel. +41 31 000 00 00', MARGIN_L, y + 5);
  doc.setTextColor(40, 40, 40);

  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  const title = template === 'ML'
    ? 'ARBEITSVERTRAG – MONATSLOHN (ML)'
    : 'ARBEITSVERTRAG – STUNDENLOHN (SL)';
  doc.text(title, MARGIN_R, y, { align: 'right' });

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(
    template === 'ML'
      ? 'Festanstellung (Vollzeit / Teilzeit)'
      : 'Aushilfe / Unregelmässige Arbeitszeit',
    MARGIN_R, y + 5, { align: 'right' }
  );

  doc.setTextColor(40, 40, 40);
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_L, y + 9, MARGIN_R, y + 9);

  return { ...ctx, y: y + 14 };
}

function drawSectionTitle(ctx: PDFContext, title: string): PDFContext {
  ctx = checkSpace(ctx, 16);
  const { doc } = ctx;
  let y = ctx.y + 3;

  doc.setFillColor(245, 245, 245);
  doc.rect(MARGIN_L - 2, y - 4, MARGIN_R - MARGIN_L + 4, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(40, 40, 80);
  doc.text(title, MARGIN_L, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40, 40, 40);

  return { ...ctx, y: y + 6 };
}

function drawField(ctx: PDFContext, label: string, value: string, indent = 0): PDFContext {
  ctx = checkSpace(ctx, 10);
  const { doc } = ctx;
  const y = ctx.y;
  const x = MARGIN_L + indent;
  const labelW = 58 - indent;

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 100, 100);
  doc.text(label + ':', x, y);

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'bold');
  const lines = doc.splitTextToSize(value, MARGIN_R - x - labelW - 2);
  doc.text(lines, x + labelW, y);
  doc.setFont('helvetica', 'normal');

  const h = lines.length * LINE_H;
  return { ...ctx, y: y + Math.max(LINE_H, h) };
}

function drawNote(ctx: PDFContext, text: string): PDFContext {
  ctx = checkSpace(ctx, 12);
  const { doc } = ctx;
  const lines = doc.splitTextToSize(text, MARGIN_R - MARGIN_L - 4);
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.setFont('helvetica', 'italic');
  doc.text(lines, MARGIN_L + 2, ctx.y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40, 40, 40);
  return { ...ctx, y: ctx.y + lines.length * 5 + 2 };
}

function drawParagraph(ctx: PDFContext, text: string): PDFContext {
  ctx = checkSpace(ctx, 16);
  const { doc } = ctx;
  const lines = doc.splitTextToSize(text, MARGIN_R - MARGIN_L);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(40, 40, 40);
  doc.text(lines, MARGIN_L, ctx.y);
  return { ...ctx, y: ctx.y + lines.length * 5.5 + 2 };
}

function gap(ctx: PDFContext, h = 4): PDFContext {
  return { ...ctx, y: ctx.y + h };
}

function drawSignatureBlock(ctx: PDFContext, city = 'Bern'): PDFContext {
  ctx = checkSpace(ctx, 55);
  const { doc } = ctx;
  let y = ctx.y + 8;

  doc.setFontSize(8.5);
  doc.setTextColor(60, 60, 60);
  doc.text(`Ort, Datum: ${city}, ___________________________`, MARGIN_L, y);
  y += 18;

  const mid = (MARGIN_L + MARGIN_R) / 2;

  doc.setDrawColor(120, 120, 120);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_L, y, mid - 10, y);
  doc.line(mid + 10, y, MARGIN_R, y);

  y += 5;
  doc.setFontSize(7.5);
  doc.setTextColor(100, 100, 100);
  doc.text('Für oLiv Restaurant & Bar\n(Arbeitgeberin)', MARGIN_L, y);
  doc.text('Arbeitnehmer/in', mid + 10, y);

  return { ...ctx, y: y + 12 };
}

function drawFooter(ctx: PDFContext, pageNum: number): void {
  const { doc } = ctx;
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(
    `oLiv Restaurant & Bar – Arbeitsvertrag – Seite ${pageNum} – Vertraulich`,
    105, PAGE_H, { align: 'center' }
  );
}

// ── Haupt-Generator ────────────────────────────────────────────────────────────

/**
 * Generiert einen Arbeitsvertrag als jsPDF-Dokument.
 * Gibt einen Blob-URL zurück (für Vorschau) und das jsPDF-Objekt (für Download).
 */
export function generateContract(emp: Employee): { blobUrl: string; fileName: string; doc: jsPDF } {
  const template = detectContractTemplate(emp);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let ctx: PDFContext = { doc, y: 18, page: 1 };

  // ── Header ─────────────────────────────────────────────────────────────────
  ctx = drawHeader(ctx, template);
  ctx = gap(ctx, 2);

  // ── 1. Vertragsparteien ────────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 1 · Vertragsparteien');
  ctx = drawField(ctx, 'Arbeitgeberin', 'oLiv Restaurant & Bar, Seftigenstrasse 101, 3007 Bern');
  ctx = drawField(ctx, 'Arbeitnehmer/in', emp.name || '___________');

  const address = [emp.addressStreet, [emp.addressZip, emp.addressCity].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  ctx = drawField(ctx, 'Adresse', address || '___________');
  ctx = drawField(ctx, 'Telefon', emp.phone || '___________');
  ctx = drawField(ctx, 'E-Mail', emp.email || '___________');
  ctx = drawField(ctx, 'Geburtsdatum', formatDate(emp.birthDate));
  ctx = drawField(ctx, 'Zivilstand', maritalLabel(emp.maritalStatus));
  ctx = drawField(ctx, 'Anzahl Kinder', emp.numberOfChildren != null ? String(emp.numberOfChildren) : '___________');
  ctx = drawField(ctx, 'AHV-Nummer', formatAHV(emp.ahvNumber));
  ctx = drawField(ctx, 'Aufenthaltsstatus', permitLabel(emp.permitType));
  ctx = gap(ctx);

  // ── 2. Beginn & Probezeit ──────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 2 · Beginn des Arbeitsverhältnisses');

  const contractKind = emp.isLimitedContract ? 'Befristet' : 'Unbefristet';
  ctx = drawField(ctx, 'Art des Vertrags', contractKind);
  ctx = drawField(ctx, 'Eintrittsdatum', formatDate(emp.contractStart));

  if (emp.isLimitedContract && emp.contractEnd) {
    ctx = drawField(ctx, 'Vertragsende', formatDate(emp.contractEnd));
  }

  const probezeit = emp.trialPeriodMonths
    ? `${emp.trialPeriodMonths} Monat${emp.trialPeriodMonths > 1 ? 'e' : ''}`
    : 'Keine Probezeit';
  ctx = drawField(ctx, 'Probezeit', probezeit);

  if (emp.trialPeriodMonths) {
    ctx = drawNote(ctx, 'Während der Probezeit beträgt die Kündigungsfrist 3 Werktage. Nach Ablauf der Probezeit gilt eine Kündigungsfrist von 1 Monat auf Ende des Kalendermonats (OR Art. 335b/c).');
  } else {
    ctx = drawNote(ctx, 'Es gilt eine Kündigungsfrist von 1 Monat auf Ende des Kalendermonats (OR Art. 335c).');
  }
  ctx = gap(ctx);

  // ── 3. Arbeitsbereich ─────────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 3 · Arbeitsbereich');
  ctx = drawField(ctx, 'Funktion / Stelle', emp.positionTitle || '___________');
  ctx = drawField(ctx, 'Abteilung', deptLabel(emp.department));
  ctx = drawParagraph(ctx, 'Die Arbeitgeberin kann dem/der Arbeitnehmer/in im Rahmen seiner/ihrer Fähigkeiten und der betrieblichen Erfordernisse auch andere zumutbare Aufgaben übertragen.');
  ctx = gap(ctx);

  // ── 4. Arbeitszeit ────────────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 4 · Arbeitszeit');

  if (template === 'ML') {
    const wh = emp.weeklyHours ?? 42;
    const pensum = Math.round((wh / 42) * 100);
    ctx = drawField(ctx, 'Beschäftigungsgrad', `${pensum}% (${wh} Stunden pro Woche)`);
    ctx = drawParagraph(ctx, 'Die Arbeitszeit wird durch den Dienstplan festgelegt. Überstunden werden nach Möglichkeit durch Freizeit kompensiert. Ist dies nicht möglich, werden sie gemäss den gesetzlichen Bestimmungen abgegolten.');
  } else {
    ctx = drawField(ctx, 'Arbeitszeit', 'Unregelmässig, gemäss Dienstplan');
    ctx = drawField(ctx, 'Max. Stunden/Woche', emp.weeklyHours ? `${emp.weeklyHours} Stunden` : 'Gemäss Dienstplan');
    ctx = drawParagraph(ctx, 'Es besteht kein Anspruch auf eine bestimmte Anzahl Arbeitsstunden pro Woche. Die Einsatzplanung erfolgt nach betrieblichen Bedürfnissen und nach Möglichkeit in gegenseitigem Einvernehmen.');
  }
  ctx = gap(ctx);

  // ── 5. Lohn ───────────────────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 5 · Lohn');

  if (template === 'ML') {
    ctx = drawField(ctx, 'Monatslohn (brutto)', formatCHF(emp.monthlySalary));
    if (emp.has13thSalary) {
      const monthly13 = emp.monthlySalary ? emp.monthlySalary / 12 : undefined;
      ctx = drawField(ctx, '13. Monatslohn', `Ja – entspricht CHF ${monthly13 ? monthly13.toFixed(2) : '___'} pro Monat (ausbezahlt im Dezember)`);
    } else {
      ctx = drawField(ctx, '13. Monatslohn', 'Nicht vereinbart');
    }
    ctx = drawParagraph(ctx, 'Der Lohn wird monatlich, spätestens am letzten Arbeitstag des Monats, auf das angegebene Bankkonto überwiesen. Alle gesetzlichen Sozialabzüge (AHV, IV, EO, ALV, BVG, UVG) werden vom Bruttolohn in Abzug gebracht.');
  } else {
    ctx = drawField(ctx, 'Stundenlohn (brutto)', formatCHF(emp.hourlyWage));
    if (emp.has13thSalary) {
      ctx = drawField(ctx, '13. Monatslohn', `Ja – als prozentualer Zuschlag von 8.33% auf dem Stundenlohn enthalten`);
    } else {
      ctx = drawField(ctx, '13. Monatslohn', 'Nicht vereinbart');
    }
    ctx = drawParagraph(ctx, 'Die Lohnabrechnung erfolgt monatlich auf Basis der geleisteten Stunden gemäss Arbeitszeiterfassung. Die Auszahlung erfolgt spätestens am letzten Arbeitstag des Monats. Alle gesetzlichen Sozialabzüge werden vorgenommen.');
  }
  ctx = gap(ctx);

  // ── 6. Ferien und Feiertage ───────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 6 · Ferien und Feiertage');

  const vacDays = emp.vacationDaysPerYear ?? 25;
  ctx = drawField(ctx, 'Ferienanspruch', `${vacDays} Arbeitstage pro Kalenderjahr (bei 100%-Anstellung)`);

  if (template === 'SL') {
    ctx = drawNote(ctx, 'Bei unregelmässiger Beschäftigung wird der Ferienanspruch anteilsmässig auf Basis der geleisteten Stunden berechnet (Ferienentschädigung von ca. 10.64% für 25 Ferientage).');
  } else {
    ctx = drawNote(ctx, 'Bei Teilzeitanstellung wird der Ferienanspruch pro rata temporis berechnet. Ferien sind grundsätzlich während der Betriebsferien oder nach Absprache mit der Vorgesetzten zu beziehen.');
  }

  ctx = drawField(ctx, 'Feiertage', '6 Feiertage pro Kalenderjahr gemäss Kanton Bern');
  ctx = gap(ctx);

  // ── 7. Sozialversicherungen ───────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 7 · Sozialversicherungen');
  ctx = drawParagraph(ctx, 'Arbeitnehmer/in und Arbeitgeberin entrichten die gesetzlich vorgeschriebenen Beiträge an AHV/IV/EO, die Arbeitslosenversicherung (ALV), die Pensionskasse (BVG, soweit beitragspflichtig) sowie die Unfallversicherung (UVG). Der Arbeitnehmeranteil wird vom Bruttolohn in Abzug gebracht.');

  if (emp.permitType && ['B', 'L', 'G', 'other'].includes(emp.permitType)) {
    ctx = gap(ctx, 2);
    ctx = drawField(ctx, 'Quellensteuer', 'Ja – wird monatlich direkt an die zuständige Steuerbehörde abgeführt');
    ctx = drawNote(ctx, 'Massgebend sind der Zivilstand, die Anzahl Kinder und der Beschäftigungsgrad gemäss den Angaben auf dem Personalblatt.');
  }
  ctx = gap(ctx);

  // ── 8. Schweigepflicht & Nebenbeschäftigung ───────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 8 · Schweigepflicht und Nebenbeschäftigung');
  ctx = drawParagraph(ctx, 'Der/die Arbeitnehmer/in verpflichtet sich, über alle Betriebs- und Geschäftsgeheimnisse, insbesondere Umsatzzahlen, Mitarbeiterdaten und betriebliche Abläufe, Stillschweigen zu bewahren – auch nach Beendigung des Arbeitsverhältnisses.');
  ctx = drawParagraph(ctx, 'Jede Nebenbeschäftigung, die geeignet ist, die volle Arbeitsleistung zu beeinträchtigen oder die Interessen der Arbeitgeberin zu verletzen, bedarf deren schriftlicher Zustimmung.');
  ctx = gap(ctx);

  // ── 9. Schlussbestimmungen ────────────────────────────────────────────────
  ctx = drawSectionTitle(ctx, 'Art. 9 · Schlussbestimmungen');
  ctx = drawParagraph(ctx, 'Änderungen und Ergänzungen dieses Vertrages bedürfen der Schriftform. Mündliche Abreden sind nicht verbindlich. Für alle nicht ausdrücklich geregelten Punkte gelten die Bestimmungen des Schweizerischen Obligationenrechts (OR), insbesondere Art. 319 ff., sowie das Arbeitsgesetz (ArG) und die darauf basierenden Verordnungen.');
  ctx = drawParagraph(ctx, 'Gerichtsstand ist Bern. Anwendbares Recht ist Schweizer Recht.');
  ctx = gap(ctx, 4);

  // ── Unterschriften ────────────────────────────────────────────────────────
  ctx = drawSignatureBlock(ctx, 'Bern');

  // Footer auf allen Seiten
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    drawFooter({ doc, y: 0, page: p }, p);
  }

  // Blob-URL für Vorschau
  const blob = doc.output('blob');
  const blobUrl = URL.createObjectURL(blob);

  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = (emp.name ?? 'Mitarbeiter').replace(/\s+/g, '_');
  const fileName = `Arbeitsvertrag_${template}_${safeName}_${dateStr}.pdf`;

  return { blobUrl, fileName, doc };
}
