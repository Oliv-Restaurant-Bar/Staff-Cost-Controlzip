/**
 * cockpit-block-stil.ts
 * =====================
 * Gemeinsames Design-System der gestalteten Cockpit-PDF-Blöcke (Waren-Block,
 * Personal-Block): Farbwelt, Kopfband, Fortsetzungs-Kopf, KPI-Boxen,
 * Abschnitts-Titel, Tabellen-Stil, Status-Chips und Ampel-Punkte.
 *
 * Alle Seiten sind A4 HOCHFORMAT mit 13-mm-Rand; die Fusszeile (Firma ·
 * Seite x/y) kommt zentral aus cockpit-report-pdf.zeichneFusszeilen.
 * Hinweis: «≤» ist in jsPDF-Helvetica (WinAnsi) NICHT darstellbar — «max.»
 * o. ä. verwenden.
 */

import type { jsPDF } from 'jspdf';
import type { RestaurantBranding } from '@/lib/pl-branding';

export const PW = 210;                 // A4 hoch
export const M = 13;                   // Rand mm — identisch mit Report-Renderer
export const CW = PW - 2 * M;          // Inhaltsbreite
export const BAND_H = 16;              // Kopfband

export type Rgb = [number, number, number];

// Farbwelt (abgestimmt auf cockpit-report-pdf).
export const INK: Rgb = [28, 35, 33];
export const INK2: Rgb = [84, 96, 91];
export const MUTED: Rgb = [138, 147, 142];
export const LINIE: Rgb = [227, 231, 228];
export const ZEBRA: Rgb = [250, 251, 250];
export const BAND_BG: Rgb = [245, 247, 245];
export const GRUEN_BG: Rgb = [231, 243, 236];
export const GRUEN_INK: Rgb = [21, 121, 74];
export const AMBER_BG: Rgb = [253, 243, 226];
export const AMBER_INK: Rgb = [176, 114, 20];
export const ROT_BG: Rgb = [251, 236, 235];
export const ROT_INK: Rgb = [192, 57, 43];
export const BLATT: Rgb = [110, 146, 72];   // Blatt-Grün (Logo)
export const BLATT_HELL: Rgb = [138, 173, 96];
export const GOLD: Rgb = [182, 152, 72];    // Akzent-Gold (Branding)

export function fmtChfKompakt(n: number): string {
  return n.toLocaleString('de-CH', { maximumFractionDigits: 0 });
}

/** Einheitlicher Seitenkopf: Marken-Band + Akzentlinie. Liefert Inhalts-y. */
export function kopfband(
  pdf: jsPDF, branding: RestaurantBranding, titel: string,
  zeitraum: string, heute: Date,
): number {
  pdf.setFillColor(...branding.headerBg);
  pdf.rect(0, 0, PW, BAND_H, 'F');
  pdf.setTextColor(...branding.textPrimary);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12);
  pdf.text(titel, M, BAND_H / 2 - 0.6);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
  pdf.setTextColor(...branding.textSecondary);
  pdf.text(`${branding.displayName}  ·  ${zeitraum}  ·  Stand ${heute.toLocaleDateString('de-CH')}`,
    M, BAND_H / 2 + 4);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
  pdf.setTextColor(...branding.textPrimary);
  pdf.text('Cockpit-Report', PW - M, BAND_H / 2 + 1.4, { align: 'right' });
  pdf.setFillColor(...branding.accentColor);
  pdf.rect(0, BAND_H, PW, 1.2, 'F');
  return BAND_H + 1.2 + 6;
}

/** Schlanker Fortsetzungs-Kopf für Tabellen-Folgeseiten (autoTable-Hook). */
export function folgeKopf(pdf: jsPDF, branding: RestaurantBranding, titel: string): void {
  pdf.setFillColor(...branding.headerBg);
  pdf.rect(0, 0, PW, 10, 'F');
  pdf.setTextColor(...branding.textPrimary);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8.5);
  pdf.text(`${branding.displayName} — ${titel} (Fortsetzung)`, M, 6.3);
  pdf.setFillColor(...branding.accentColor);
  pdf.rect(0, 10, PW, 1, 'F');
}

export interface KpiBox {
  label: string;
  wert: string;
  /** Punkt-/Textfarbe für eine Ampel; undefined = neutral (INK). */
  ampel?: { dot: Rgb; ink: Rgb };
}

/** KPI-Zeile: 3–4 Boxen mit Label oben, Wert (optional mit Ampelpunkt) unten. */
export function kpiZeileBoxen(
  pdf: jsPDF, y: number, kpis: KpiBox[],
  /** Kompakt-Variante (z.B. zweizeilige KPI-Kopfe): niedrigere Boxen. */
  opts?: { boxH?: number },
): number {
  const gap = 4;
  const boxW = (CW - gap * (kpis.length - 1)) / kpis.length;
  const boxH = opts?.boxH ?? 15;
  kpis.forEach((k, i) => {
    const x = M + i * (boxW + gap);
    pdf.setFillColor(...BAND_BG);
    pdf.roundedRect(x, y, boxW, boxH, 1.6, 1.6, 'F');
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.8);
    pdf.setTextColor(...MUTED);
    pdf.text(k.label.toUpperCase(), x + 3, y + 4.6);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    let tx = x + 3;
    if (k.ampel) {
      pdf.setFillColor(...k.ampel.dot);
      pdf.circle(x + 4.4, y + 9.6, 1.5, 'F');
      tx = x + 7.4;
      pdf.setTextColor(...k.ampel.ink);
    } else {
      pdf.setTextColor(...INK);
    }
    pdf.text(k.wert, tx, y + 10.9);
  });
  return y + boxH + 6;
}

/** Abschnitts-Titelzeile über Chart/Tabelle. */
export function abschnitt(pdf: jsPDF, y: number, accent: Rgb, titel: string, sub?: string): number {
  pdf.setFillColor(...accent);
  pdf.rect(M, y, 1.6, 5.2, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5);
  pdf.setTextColor(...INK);
  pdf.text(titel, M + 4, y + 4);
  if (sub) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text(sub, PW - M, y + 4, { align: 'right' });
  }
  return y + 8;
}

/** Gemeinsamer Tabellen-Stil: Zebra, feine Linien, luftige Zeilen. */
export function tabellenStil(branding: RestaurantBranding) {
  return {
    theme: 'grid' as const,
    styles: {
      font: 'helvetica', fontSize: 8.6, cellPadding: { top: 2.1, bottom: 2.1, left: 2.4, right: 2.4 },
      textColor: INK, lineColor: LINIE, lineWidth: 0.15,
    },
    headStyles: {
      fillColor: branding.headerBg, textColor: [255, 255, 255] as Rgb,
      fontStyle: 'bold' as const, fontSize: 8.2, cellPadding: { top: 2.4, bottom: 2.4, left: 2.4, right: 2.4 },
      lineColor: branding.headerBg, lineWidth: 0.1,
    },
    alternateRowStyles: { fillColor: ZEBRA },
    margin: { left: M, right: M, top: 15, bottom: 12 },
  };
}

/** Zeichnet einen Status-Chip in eine Zelle (gruen=false → amber). */
export function zeichneChip(
  pdf: jsPDF, cell: { x: number; y: number; height: number; width?: number },
  text: string, tone: 'gruen' | 'amber' | 'grau',
  align: 'links' | 'rechts' = 'links',
): void {
  const bg = tone === 'gruen' ? GRUEN_BG : tone === 'amber' ? AMBER_BG : BAND_BG;
  const ink = tone === 'gruen' ? GRUEN_INK : tone === 'amber' ? AMBER_INK : INK2;
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'bold');
  const tw = pdf.getTextWidth(text);
  const chipW = tw + 5, chipH = 4.6;
  // rechtsbündig: Chip endet am rechten Zellrand und darf nach links wachsen
  const cx = align === 'rechts' && cell.width != null
    ? cell.x + cell.width - 2 - chipW
    : cell.x + 2.2;
  const cy = cell.y + (cell.height - chipH) / 2;
  pdf.setFillColor(...bg);
  pdf.roundedRect(cx, cy, chipW, chipH, chipH / 2, chipH / 2, 'F');
  pdf.setTextColor(...ink);
  pdf.text(text, cx + 2.5, cy + chipH / 2 + 0.9);
}

/** Ampel-Punkt links neben rechtsbündigem Zelltext. */
export function zeichneAmpelPunktFarbe(
  pdf: jsPDF, cell: { x: number; y: number; width: number; height: number }, dot: Rgb,
): void {
  pdf.setFillColor(...dot);
  pdf.circle(cell.x + 3.4, cell.y + cell.height / 2, 1.3, 'F');
}
