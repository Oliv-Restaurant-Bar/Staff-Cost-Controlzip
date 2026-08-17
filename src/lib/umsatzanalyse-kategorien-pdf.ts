/**
 * umsatzanalyse-kategorien-pdf.ts — Vektor-Seite «Umsatzanalyse Kategorien»
 * ==========================================================================
 * EINE A4-Hochformat-Seite im Design der gelieferten PDF-Vorlage mit ZWEI
 * Blöcken untereinander (Food, Beverage):
 *   • Kopf (dunkelblau): Titel «Umsatzanalyse Food & Beverage Kategorien»,
 *     Zeitraum, rechts zwei Boxen «TOTAL FOOD/BEVERAGE UMSATZ»
 *   • Je Block: links Ranking (Rang | Kategorie | Umsatz | Anteil %, Top 12,
 *     Top 3 fett, Abschluss TOTAL … 100.0 %), rechts horizontale Teal-Balken,
 *     darunter eine Kernaussage-Zeile (Top-2 / Top-4 kumuliert)
 *   • Fusszeile: «Quelle: Upload Produkteanalyse | Werte {Jahr} | {Mandant}»
 *
 * Reine jsPDF-Primitives (Vektor). Wird als GENAU EINE letzte Seite an den
 * Cockpit-PDF-Export angehängt (kind:'zeichner' → hängt die Seite selbst an)
 * und für den Einzel-Export aus der Produkteanalyse verwendet.
 */

import type { jsPDF } from 'jspdf';
import type { KatAuswertung, KatGruppenAuswertung } from './umsatz-kategorien';

const PW = 210, PH = 297, M = 13;

type Rgb = [number, number, number];
const DUNKELBLAU: Rgb = [23, 42, 69];
const DUNKELBLAU_HELL: Rgb = [38, 62, 96];
const TEAL: Rgb = [13, 148, 136];
const TEAL_HELL: Rgb = [204, 235, 232];
const INK: Rgb = [28, 35, 33];
const MUTED: Rgb = [120, 130, 126];
const LINIE: Rgb = [225, 229, 227];
const ZEBRA: Rgb = [247, 249, 248];

/** Anzahl Ranking-Zeilen je Block (Vorgabe: Top 12). */
export const KAT_PDF_TOP_N = 12;

const fmtChf = (n: number) =>
  n.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct = (p: number | null) => (p == null ? '—' : `${p.toFixed(1)} %`);
const fmtDatum = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Kernaussage-Text (Top-2 / Top-4 kumuliert) — null wenn zu wenig Daten. */
function kernaussage(g: KatGruppenAuswertung, label: string): string | null {
  const pctSum = (n: number) => {
    const v = g.zeilen.slice(0, n).map(z => z.anteilPct).filter((p): p is number => p != null);
    return v.length ? Math.round(v.reduce((s, p) => s + p, 0) * 10) / 10 : null;
  };
  const top2 = pctSum(2), top4 = pctSum(4);
  if (top2 == null) return null;
  return `${label}: Top 2 zusammen ${top2.toFixed(1)} %` +
    (top4 != null ? `, Top 4 zusammen ${top4.toFixed(1)} %.` : '.');
}

/** Zeichnet einen Gruppen-Block (Titel, Ranking links, Balken rechts, Kernaussage). Liefert End-y. */
function blockFuerGruppe(
  pdf: jsPDF, y: number, gruppeLabel: 'Food' | 'Beverage', g: KatGruppenAuswertung, jahr: number,
): number {
  // Block-Titel
  pdf.setFillColor(...TEAL);
  pdf.rect(M, y, 1.6, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
  pdf.setTextColor(...INK);
  pdf.text(gruppeLabel, M + 4, y + 4);
  y += 8;

  if (g.zeilen.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5);
    pdf.setTextColor(...MUTED);
    pdf.text(`Keine ${gruppeLabel}-Kategoriedaten für ${jahr} importiert.`, M, y + 3);
    return y + 10;
  }

  const spaltGap = 8;
  const tblW = 96;
  const chartX = M + tblW + spaltGap;
  const chartW = PW - M - chartX;

  const top = g.zeilen.slice(0, KAT_PDF_TOP_N);

  // ── Ranking-Tabelle links ──────────────────────────────────────────────────
  const colRang = 9, colUms = 25, colAnt = 15;
  const colKat = tblW - colRang - colUms - colAnt;
  const rowH = 5.6;
  let ty = y;
  pdf.setFillColor(...DUNKELBLAU);
  pdf.rect(M, ty, tblW, rowH, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(6.6);
  pdf.setTextColor(255, 255, 255);
  pdf.text('Rang', M + 2, ty + rowH - 1.8);
  pdf.text('Kategorie', M + colRang + 2, ty + rowH - 1.8);
  pdf.text('Umsatz (CHF)', M + colRang + colKat + colUms - 2, ty + rowH - 1.8, { align: 'right' });
  pdf.text('Anteil %', M + tblW - 2, ty + rowH - 1.8, { align: 'right' });
  ty += rowH;
  top.forEach((z, i) => {
    if (i % 2 === 1) { pdf.setFillColor(...ZEBRA); pdf.rect(M, ty, tblW, rowH, 'F'); }
    pdf.setDrawColor(...LINIE); pdf.setLineWidth(0.15);
    pdf.line(M, ty + rowH, M + tblW, ty + rowH);
    pdf.setFont('helvetica', i < 3 ? 'bold' : 'normal'); pdf.setFontSize(7.2);
    pdf.setTextColor(...INK);
    pdf.text(String(i + 1), M + 2, ty + rowH - 1.8);
    const kat = pdf.splitTextToSize(z.kategorie, colKat - 3)[0] as string;
    pdf.text(kat, M + colRang + 2, ty + rowH - 1.8);
    pdf.text(fmtChf(z.umsatz), M + colRang + colKat + colUms - 2, ty + rowH - 1.8, { align: 'right' });
    pdf.text(fmtPct(z.anteilPct), M + tblW - 2, ty + rowH - 1.8, { align: 'right' });
    ty += rowH;
  });
  if (g.zeilen.length > KAT_PDF_TOP_N) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.2);
    pdf.setTextColor(...MUTED);
    pdf.text(`… ${g.zeilen.length - KAT_PDF_TOP_N} weitere Kategorien`, M + 2, ty + 3.2);
    ty += 4.6;
  }
  // TOTAL-Zeile
  pdf.setFillColor(...TEAL_HELL);
  pdf.rect(M, ty, tblW, rowH, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.2);
  pdf.setTextColor(...INK);
  pdf.text(`TOTAL ${gruppeLabel.toUpperCase()}`, M + 2, ty + rowH - 1.8);
  pdf.text(g.total != null ? fmtChf(g.total) : '—', M + colRang + colKat + colUms - 2, ty + rowH - 1.8, { align: 'right' });
  pdf.text('100.0 %', M + tblW - 2, ty + rowH - 1.8, { align: 'right' });
  ty += rowH;

  // ── Balkendiagramm rechts (gleiche Top-Kategorien) ─────────────────────────
  let cy = y + rowH; // optisch auf Höhe des Tabellenkörpers
  const maxPct = Math.max(...top.map(z => z.anteilPct ?? 0), 0.001);
  const labelW = 32, pctW = 11;
  const barMaxW = chartW - labelW - pctW - 2;
  const barH = 3.8, barGap = 1.8;
  pdf.setFontSize(6.4);
  for (const z of top) {
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(...INK);
    const lbl = pdf.splitTextToSize(z.kategorie, labelW - 1)[0] as string;
    pdf.text(lbl, chartX + labelW - 1, cy + barH - 0.9, { align: 'right' });
    const w = Math.max(((z.anteilPct ?? 0) / maxPct) * barMaxW, 0.6);
    pdf.setFillColor(...TEAL);
    pdf.roundedRect(chartX + labelW + 1, cy, w, barH, 0.7, 0.7, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...MUTED);
    pdf.text(fmtPct(z.anteilPct), chartX + labelW + 1 + w + 1.5, cy + barH - 0.9);
    cy += barH + barGap;
  }

  // ── Kernaussage (eine Zeile) ───────────────────────────────────────────────
  let endY = Math.max(ty, cy) + 3;
  const kern = kernaussage(g, gruppeLabel);
  if (kern) {
    pdf.setFillColor(...ZEBRA);
    pdf.roundedRect(M, endY, PW - 2 * M, 6.4, 1.2, 1.2, 'F');
    pdf.setFillColor(...TEAL);
    pdf.rect(M, endY, 1.4, 6.4, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7);
    pdf.setTextColor(...INK);
    pdf.text('Kernaussage', M + 4, endY + 4.3);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(...MUTED);
    pdf.text(kern, M + 26, endY + 4.3);
    endY += 6.4 + 3;
  }
  return endY;
}

/**
 * Zeichnet die EINE Kategorien-Seite (Food- und Beverage-Block untereinander).
 * `mandantLabel`: Anzeigename des Mandanten für die Fusszeile.
 * `neueSeiteVorab`: true beim Anhängen an ein bestehendes PDF (Cockpit-Export);
 * false, wenn das PDF frisch erzeugt wurde und Seite 1 genutzt werden soll.
 */
export function zeichneUmsatzKategorienSeite(
  pdf: jsPDF, auswertung: KatAuswertung, mandantLabel: string, neueSeiteVorab = true,
): void {
  if (neueSeiteVorab) pdf.addPage('a4', 'portrait');
  const { zeitraum, jahr } = auswertung;

  // ── Kopfband (dunkelblau) ──────────────────────────────────────────────────
  pdf.setFillColor(...DUNKELBLAU);
  pdf.rect(0, 0, PW, 30, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13.5);
  pdf.text('Umsatzanalyse Food & Beverage Kategorien', M, 13);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
  pdf.setTextColor(200, 210, 224);
  pdf.text(
    zeitraum ? `Zeitraum: ${fmtDatum(zeitraum.von)} bis ${fmtDatum(zeitraum.bis)}` : `Zeitraum: — (keine Daten ${jahr})`,
    M, 20,
  );
  // Rechts: zwei TOTAL-Boxen
  const boxW = 44, boxGap = 4;
  const boxen: Array<[string, number | null]> = [
    ['TOTAL FOOD UMSATZ', auswertung.food.total],
    ['TOTAL BEVERAGE UMSATZ', auswertung.beverage.total],
  ];
  boxen.forEach(([label, total], i) => {
    const bx = PW - M - (boxen.length - i) * boxW - (boxen.length - 1 - i) * boxGap;
    pdf.setFillColor(...DUNKELBLAU_HELL);
    pdf.roundedRect(bx, 5.5, boxW, 19, 1.8, 1.8, 'F');
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(5.8);
    pdf.setTextColor(170, 185, 205);
    pdf.text(label, bx + boxW / 2, 11.5, { align: 'center' });
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5);
    pdf.setTextColor(255, 255, 255);
    pdf.text(total != null ? `CHF ${fmtChf(total)}` : '—', bx + boxW / 2, 19.5, { align: 'center' });
  });

  // ── Zwei Blöcke untereinander ──────────────────────────────────────────────
  let y = 38;
  y = blockFuerGruppe(pdf, y, 'Food', auswertung.food, jahr);
  y += 4;
  blockFuerGruppe(pdf, y, 'Beverage', auswertung.beverage, jahr);

  // ── Fusszeile ──────────────────────────────────────────────────────────────
  pdf.setDrawColor(...LINIE); pdf.setLineWidth(0.2);
  pdf.line(M, PH - 12, PW - M, PH - 12);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.8);
  pdf.setTextColor(...MUTED);
  pdf.text(`Quelle: Upload Produkteanalyse | Werte ${jahr} | ${mandantLabel}`, M, PH - 8);
  pdf.text('Umsatzanalyse Kategorien', PW - M, PH - 8, { align: 'right' });
}
