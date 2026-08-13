/**
 * cockpit-waren-block.ts — optionaler Waren-Block für den Cockpit-PDF-Export.
 * ===========================================================================
 * Drei zusätzliche Seiten (je eigene Seite) für den GEWÄHLTEN Monat:
 *  A) Lieferanten-Übersicht  — Lieferant · Betrag netto · Anteil Umsatz ·
 *     Rechnungen · Status (final/provisorisch).
 *  B) Tagesverlauf           — je Tag: Waren · Umsatz · Tages-% · Kum. Waren ·
 *     Kum. Umsatz · Kum.-%.
 *  C) Anomalie-Analyse KW    — je KW: Netto · Rechnungen · WKQ, Gesamttotal,
 *     plus Lieferanten-Aufschlüsselung je Woche (wie im aufgeklappten
 *     KW-Detail der Warenrechnungen-Seite).
 *
 * WICHTIG — Zahlenbasis (1:1 wie Warenrechnungen/Analyse):
 *  - NETTO, DIREKTER Warenaufwand 4020–4070 via direktAnteilNet (Splits zählen
 *    pro Konto, Pfand/Depot neutral, 4701/4090 etc. NICHT enthalten).
 *  - Umsatz = Netto-Umsatz-SSOT (umsatz.ts, leer statt 0).
 *  - Ignorierte Rechnungen (Privatbezug) werden wie in der App gefiltert.
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TenantId } from '@/contexts/TenantContext';
import type { RestaurantBranding } from '@/lib/pl-branding';
import {
  loadMonthInvoices, loadIgnorierteRechnungen, filtereIgnorierteRechnungen,
  type InvoiceEntry,
} from '@/lib/waren-db';
import { direktAnteilNet } from '@/lib/waren-analyse';
import { warenkostenQuote } from '@/lib/warenkosten-quote';
import { ladeNettoUmsatzByDate } from '@/lib/umsatz';
import {
  PW, M, CW, INK, INK2, MUTED, LINIE, BAND_BG, GRUEN_BG, GRUEN_INK,
  AMBER_INK, ROT_INK, BLATT, BLATT_HELL,
  fmtChfKompakt, kopfband, folgeKopf, kpiZeileBoxen, abschnitt, tabellenStil,
  zeichneChip, zeichneAmpelPunktFarbe,
} from '@/lib/cockpit-block-stil';

// ─── Datenmodell ─────────────────────────────────────────────────────────────

export interface WarenLieferantZeile {
  name: string;
  direktNet: number;
  anteilUmsatzPct: number | null; // direktNet ÷ Monats-Netto-Umsatz
  rechnungen: number;
  status: string; // «final» oder «n provisorisch»
}

export interface WarenTagZeile {
  datum: string; // ISO
  waren: number | null;   // direkter Warenaufwand des Tages (null = keine Rechnung)
  umsatz: number | null;  // Netto-Umsatz (null = kein Import, leer statt 0)
  tagesPct: number | null;
  kumWaren: number;
  kumUmsatz: number;
  kumPct: number | null;
}

export interface WarenWocheZeile {
  weekLabel: string; // «KW 32»
  von: string;
  bis: string;
  direktNet: number;
  rechnungen: number;
  umsatz: number;
  wkqPct: number | null;
  lieferanten: { name: string; direktNet: number; rechnungen: number; anteilKwPct: number | null }[];
}

export interface WarenBlockDaten {
  monatLabel: string;   // «August 2026»
  totalDirekt: number;
  totalUmsatz: number;
  monatsWkqPct: number | null;
  lieferanten: WarenLieferantZeile[];
  tage: WarenTagZeile[];
  wochen: WarenWocheZeile[];
}

// ─── Helfer ──────────────────────────────────────────────────────────────────

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtChf = (n: number | null) =>
  n === null ? '–' : n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (p: number | null) => (p === null ? '–' : `${p.toFixed(1)} %`);
const fmtDat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

function getIsoWeek(dateIso: string): { week: number; isoYear: number } {
  const d = new Date(dateIso + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { week, isoYear };
}

/** Effektiver Final-Status wie in der Lieferanten-Übersicht: nur explizit
 *  final === false gilt als provisorisch (Lieferschein→Monatsrechnung). */
function istProvisorisch(e: InvoiceEntry): boolean {
  return e.final === false;
}

// ─── Datenladung ─────────────────────────────────────────────────────────────

export async function ladeWarenBlockDaten(
  tenantId: TenantId,
  year: number,
  month: number,
  heuteIso: string,
): Promise<WarenBlockDaten> {
  const mk = `${year}-${String(month).padStart(2, '0')}`;
  const [invsRoh, ignoreListe, revenueByDate] = await Promise.all([
    loadMonthInvoices(tenantId, mk),
    loadIgnorierteRechnungen(tenantId),
    ladeNettoUmsatzByDate(tenantId, `${mk}-01`, `${mk}-31`),
  ]);
  // EINHEITLICHE Periodenbasis für ALLE Aggregationen (Lieferanten, Total,
  // Tage, Wochen): nur Tage bis heute — sonst weichen Lieferantensumme und
  // Totalzeile voneinander ab (zukünftig datierte Belege).
  const entries = filtereIgnorierteRechnungen(ignoreListe, invsRoh)
    .entries.filter(e => e.date <= heuteIso);

  // Tage des Monats bis heute (Kumulation läuft über ALLE Tage).
  const tageImMonat = new Date(year, month, 0).getDate();
  const alleTage: string[] = [];
  for (let t = 1; t <= tageImMonat; t++) {
    const iso = `${mk}-${String(t).padStart(2, '0')}`;
    if (iso <= heuteIso) alleTage.push(iso);
  }

  // Direkter Warenaufwand je Rechnung (einmal berechnen).
  const direktOf = new Map<string, number>();
  for (const e of entries) direktOf.set(e.id, r2(direktAnteilNet(e)));
  const direktSum = (list: InvoiceEntry[]) => r2(list.reduce((s, e) => s + (direktOf.get(e.id) ?? 0), 0));

  const totalDirekt = direktSum(entries);
  const totalUmsatz = r2(alleTage.reduce((s, d) => s + (revenueByDate[d] ?? 0), 0));
  const monatsWkqPct = warenkostenQuote(totalDirekt, totalUmsatz);

  // A) Lieferanten-Übersicht.
  const lieferMap = new Map<string, { direkt: number; n: number; prov: number }>();
  for (const e of entries) {
    const key = e.supplierName.trim() || '—';
    const cur = lieferMap.get(key) ?? { direkt: 0, n: 0, prov: 0 };
    cur.direkt += direktOf.get(e.id) ?? 0;
    cur.n += 1;
    if (istProvisorisch(e)) cur.prov += 1;
    lieferMap.set(key, cur);
  }
  const lieferanten: WarenLieferantZeile[] = Array.from(lieferMap.entries())
    .map(([name, v]) => ({
      name,
      direktNet: r2(v.direkt),
      anteilUmsatzPct: v.direkt > 0 ? warenkostenQuote(v.direkt, totalUmsatz) : null,
      rechnungen: v.n,
      status: v.prov > 0 ? `${v.prov} provisorisch` : 'final',
    }))
    .sort((a, b) => b.direktNet - a.direktNet);

  // B) Tagesverlauf mit Kumulation.
  let kumW = 0, kumU = 0;
  const tage: WarenTagZeile[] = [];
  for (const d of alleTage) {
    const tagesEntries = entries.filter(e => e.date === d);
    const waren = tagesEntries.length > 0 ? direktSum(tagesEntries) : null;
    const umsatz = d in revenueByDate ? revenueByDate[d] : null;
    kumW = r2(kumW + (waren ?? 0));
    kumU = r2(kumU + (umsatz ?? 0));
    tage.push({
      datum: d,
      waren, umsatz,
      tagesPct: waren !== null ? warenkostenQuote(waren, umsatz) : null,
      kumWaren: kumW, kumUmsatz: kumU,
      kumPct: warenkostenQuote(kumW, kumU),
    });
  }

  // C) Wochen (ISO-KW, Tage auf den Monat & Vergangenheit begrenzt).
  const wochenMap = new Map<string, string[]>();
  for (const d of alleTage) {
    const { week, isoYear } = getIsoWeek(d);
    const wk = `${isoYear}-W${String(week).padStart(2, '0')}`;
    wochenMap.set(wk, [...(wochenMap.get(wk) ?? []), d]);
  }
  const wochen: WarenWocheZeile[] = Array.from(wochenMap.entries()).sort()
    .map(([wk, days]) => {
      const wEntries = entries.filter(e => days.includes(e.date));
      const direktNet = direktSum(wEntries);
      const umsatz = r2(days.reduce((s, d) => s + (revenueByDate[d] ?? 0), 0));
      const perLief = new Map<string, { direkt: number; n: number }>();
      for (const e of wEntries) {
        const key = e.supplierName.trim() || '—';
        const cur = perLief.get(key) ?? { direkt: 0, n: 0 };
        cur.direkt += direktOf.get(e.id) ?? 0;
        cur.n += 1;
        perLief.set(key, cur);
      }
      return {
        weekLabel: `KW ${Number(wk.slice(-2))}`,
        von: days[0], bis: days[days.length - 1],
        direktNet, rechnungen: wEntries.length, umsatz,
        wkqPct: warenkostenQuote(direktNet, umsatz),
        lieferanten: Array.from(perLief.entries())
          .map(([name, v]) => ({
            name, direktNet: r2(v.direkt), rechnungen: v.n,
            anteilKwPct: v.direkt > 0 && direktNet > 0 ? (v.direkt / direktNet) * 100 : null,
          }))
          .sort((a, b) => b.direktNet - a.direktNet),
      };
    });

  return {
    monatLabel: `${MONATE[month - 1]} ${year}`,
    totalDirekt, totalUmsatz, monatsWkqPct,
    lieferanten, tage, wochen,
  };
}

// ─── PDF-Zeichnung ───────────────────────────────────────────────────────────
// ─── PDF-Zeichnung ───────────────────────────────────────────────────────────
//
// Design-System (alle Waren-Seiten, Hochformat A4):
//  - Kopfband in der Marken-Farbe (Oliv-Grün aus pl-branding) mit Titel ·
//    Mandant · Zeitraum · Stand; Akzentlinie darunter. Fusszeile kommt zentral
//    aus zeichneFusszeilen (Firma · Seite x/y).
//  - KPI-Zeile oben: Direkter Warenaufwand · WKQ · Netto-Umsatz · Ziel.
//  - Leichte Vektor-Visualisierungen: Lieferanten-Balken, Kumulations-Chart,
//    Wochen-WKQ-Balken mit Ziel-Linie — Zahlen bleiben exakt (nur Darstellung).
//  - Tabellen: Zebra, feine Spaltenlinien, mehr Zeilenhöhe, Status-Chips
//    (final grün / provisorisch amber), WKQ-Ampel (≤30 grün · 30–40 amber ·
//    >40 rot).

const ZIEL_WKQ = 30; // Ziel-Linie / KPI «Ziel ≤ 30 %»

type Rgb = [number, number, number];

/** Ampel: ≤30 grün · 30–40 amber · >40 rot (null = neutral). */
function wkqFarbe(pct: number | null): { dot: Rgb; ink: Rgb } {
  if (pct === null) return { dot: MUTED, ink: INK2 };
  if (pct <= 30) return { dot: GRUEN_INK, ink: GRUEN_INK };
  if (pct <= 40) return { dot: AMBER_INK, ink: AMBER_INK };
  return { dot: ROT_INK, ink: ROT_INK };
}

/** KPI-Zeile: Direkter Warenaufwand · WKQ (Ampel) · Netto-Umsatz · Ziel. */
function kpiZeile(pdf: jsPDF, y: number, d: WarenBlockDaten): number {
  return kpiZeileBoxen(pdf, y, [
    { label: 'Direkter Warenaufwand', wert: `CHF ${fmtChf(d.totalDirekt)}` },
    { label: 'WKQ Monat', wert: fmtPct(d.monatsWkqPct), ampel: wkqFarbe(d.monatsWkqPct) },
    { label: 'Netto-Umsatz', wert: `CHF ${fmtChf(d.totalUmsatz)}` },
    // «≤» ist in Helvetica/WinAnsi nicht darstellbar → «max.».
    { label: 'Ziel WKQ', wert: `max. ${ZIEL_WKQ.toFixed(0)} %` },
  ]);
}

/** Status-Chip (final grün · provisorisch amber). */
function zeichneStatusChip(pdf: jsPDF, cell: { x: number; y: number; height: number }, status: string): void {
  zeichneChip(pdf, cell, status, status === 'final' ? 'gruen' : 'amber');
}

/** WKQ-Ampel-Punkt links neben rechtsbündigem Zelltext. */
function zeichneAmpelPunkt(pdf: jsPDF, cell: { x: number; y: number; width: number; height: number }, pct: number | null): void {
  zeichneAmpelPunktFarbe(pdf, cell, wkqFarbe(pct).dot);
}

// ── Charts (reine Vektor-Zeichnung, Werte 1:1 aus den Tabellendaten) ─────────

/** Horizontales Balkendiagramm Netto-Anteil je Lieferant (grösster oben). */
function chartLieferanten(pdf: jsPDF, y: number, d: WarenBlockDaten): number {
  const positive = d.lieferanten.filter(l => l.direktNet > 0);
  if (positive.length === 0 || d.totalDirekt <= 0) return y;
  const MAX_BARS = 9;
  const top = positive.slice(0, MAX_BARS);
  const rest = positive.slice(MAX_BARS);
  const bars = [...top.map(l => ({ name: l.name, wert: l.direktNet })),
    ...(rest.length > 0
      ? [{ name: `Übrige (${rest.length})`, wert: r2(rest.reduce((s, l) => s + l.direktNet, 0)) }]
      : [])];
  const maxWert = Math.max(...bars.map(b => b.wert));
  const labelW = 46, wertW = 40;
  const barMaxW = CW - labelW - wertW;
  const rowH = 6.6, barH = 3.8;
  bars.forEach((b, i) => {
    const by = y + i * rowH;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.6);
    pdf.setTextColor(...INK2);
    const name = b.name.length > 30 ? `${b.name.slice(0, 29)}…` : b.name;
    pdf.text(name, M + labelW - 2, by + barH, { align: 'right' });
    // Spur + Balken.
    pdf.setFillColor(...BAND_BG);
    pdf.roundedRect(M + labelW, by + 0.6, barMaxW, barH, 1, 1, 'F');
    const w = Math.max(0.8, (b.wert / maxWert) * barMaxW);
    pdf.setFillColor(...(i === 0 ? BLATT : BLATT_HELL));
    pdf.roundedRect(M + labelW, by + 0.6, w, barH, 1, 1, 'F');
    // Wert + Anteil am Warenaufwand.
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.6);
    pdf.setTextColor(...INK);
    const anteil = (b.wert / d.totalDirekt) * 100;
    pdf.text(`${fmtChf(b.wert)}  ·  ${anteil.toFixed(1)} %`, M + labelW + barMaxW + 2, by + barH);
  });
  return y + bars.length * rowH + 4;
}

/** Linien-/Flächendiagramm: kumulierte Warenkosten & Umsatz über die Tage. */
function chartKumulation(pdf: jsPDF, y: number, d: WarenBlockDaten): number {
  const tage = d.tage;
  if (tage.length === 0) return y;
  const H = 52;
  const axW = 16;
  const x0 = M + axW, x1 = M + CW;
  const plotW = x1 - x0;
  const maxY0 = Math.max(...tage.map(t => Math.max(t.kumUmsatz, t.kumWaren)), 1);
  // «Schöne» Skala in 4 Schritten.
  const roh = maxY0 / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(roh)));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s * 4 >= maxY0) ?? roh;
  const maxY = step * 4;
  const px = (i: number) => tage.length === 1 ? x0 + plotW / 2 : x0 + (i / (tage.length - 1)) * plotW;
  const py = (v: number) => y + H - (v / maxY) * H;

  // Fläche unter Kum. Waren (helles Grün, VOR den Gitterlinien).
  const flaeche: [number, number][] = tage.map((t, i) => [px(i), py(t.kumWaren)]);
  pdf.setFillColor(...GRUEN_BG);
  const segs: [number, number][] = [];
  for (let i = 1; i < flaeche.length; i++) {
    segs.push([flaeche[i][0] - flaeche[i - 1][0], flaeche[i][1] - flaeche[i - 1][1]]);
  }
  segs.push([0, y + H - flaeche[flaeche.length - 1][1]]);
  segs.push([flaeche[0][0] - flaeche[flaeche.length - 1][0], 0]);
  if (flaeche.length > 1) pdf.lines(segs, flaeche[0][0], flaeche[0][1], [1, 1], 'F', true);

  // Gitter + y-Beschriftung.
  pdf.setFontSize(6.4); pdf.setFont('helvetica', 'normal');
  for (let i = 0; i <= 4; i++) {
    const gy = y + H - (i / 4) * H;
    pdf.setDrawColor(...LINIE); pdf.setLineWidth(0.15);
    pdf.line(x0, gy, x1, gy);
    pdf.setTextColor(...MUTED);
    pdf.text(fmtChfKompakt(step * i), x0 - 1.6, gy + 1, { align: 'right' });
  }
  // x-Beschriftung (alle ~5 Tage + letzter Tag).
  tage.forEach((t, i) => {
    if (i % 5 === 0 || i === tage.length - 1) {
      pdf.setTextColor(...MUTED);
      pdf.text(fmtDat(t.datum), px(i), y + H + 3.4, { align: 'center' });
    }
  });

  // Linien: Kum. Umsatz (Akzent-Gold) und Kum. Waren (Blatt-Grün).
  const zeichneLinie = (werte: number[], farbe: Rgb, dick: number) => {
    pdf.setDrawColor(...farbe); pdf.setLineWidth(dick);
    for (let i = 1; i < werte.length; i++) {
      pdf.line(px(i - 1), py(werte[i - 1]), px(i), py(werte[i]));
    }
    const li = werte.length - 1;
    pdf.setFillColor(...farbe);
    pdf.circle(px(li), py(werte[li]), 0.9, 'F');
  };
  zeichneLinie(tage.map(t => t.kumUmsatz), [182, 152, 72], 0.5);
  zeichneLinie(tage.map(t => t.kumWaren), BLATT, 0.6);

  // Legende.
  const ly = y + H + 7.5;
  pdf.setFontSize(7); pdf.setFont('helvetica', 'normal');
  pdf.setFillColor(...BLATT); pdf.circle(M + axW + 1.2, ly - 1, 1.1, 'F');
  pdf.setTextColor(...INK2);
  pdf.text(`Kum. Waren (CHF ${fmtChf(d.totalDirekt)})`, M + axW + 3.6, ly);
  pdf.setFillColor(182, 152, 72); pdf.circle(M + axW + 66, ly - 1, 1.1, 'F');
  pdf.text(`Kum. Umsatz (CHF ${fmtChf(d.totalUmsatz)})`, M + axW + 68.4, ly);
  return ly + 5;
}

/** Wochen-WKQ als Balken mit Ziel-30-%-Linie. */
function chartWochen(pdf: jsPDF, y: number, d: WarenBlockDaten): number {
  const wochen = d.wochen;
  if (wochen.length === 0) return y;
  const H = 40;
  const axW = 10;
  const x0 = M + axW, plotW = CW - axW;
  const maxPct = Math.max(ZIEL_WKQ, ...wochen.map(w => w.wkqPct ?? 0)) * 1.25;
  const py = (v: number) => y + H - (v / maxPct) * H;
  // Gitter.
  pdf.setFontSize(6.4); pdf.setFont('helvetica', 'normal');
  const stufen = [0, Math.round(maxPct / 2), Math.round(maxPct)];
  for (const s of stufen) {
    pdf.setDrawColor(...LINIE); pdf.setLineWidth(0.15);
    pdf.line(x0, py(s), x0 + plotW, py(s));
    pdf.setTextColor(...MUTED);
    pdf.text(`${s} %`, x0 - 1.4, py(s) + 1, { align: 'right' });
  }
  // Balken.
  const slotW = plotW / wochen.length;
  const barW = Math.min(20, slotW * 0.5);
  wochen.forEach((w, i) => {
    const cx = x0 + i * slotW + slotW / 2;
    const pct = w.wkqPct;
    const bh = pct !== null ? Math.max(0.8, (pct / maxPct) * H) : 0;
    const f = wkqFarbe(pct);
    if (pct !== null) {
      pdf.setFillColor(...f.dot);
      pdf.roundedRect(cx - barW / 2, y + H - bh, barW, bh, 0.8, 0.8, 'F');
    }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.4);
    pdf.setTextColor(...f.ink);
    pdf.text(fmtPct(pct), cx, y + H - bh - 1.6, { align: 'center' });
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
    pdf.setTextColor(...INK2);
    pdf.text(w.weekLabel, cx, y + H + 3.6, { align: 'center' });
  });
  // Ziel-Linie 30 % (gestrichelt, amber).
  pdf.setDrawColor(...AMBER_INK); pdf.setLineWidth(0.4);
  pdf.setLineDashPattern([1.6, 1.4], 0);
  pdf.line(x0, py(ZIEL_WKQ), x0 + plotW, py(ZIEL_WKQ));
  pdf.setLineDashPattern([], 0);
  pdf.setFontSize(6.6); pdf.setTextColor(...AMBER_INK);
  pdf.text(`Ziel ${ZIEL_WKQ} %`, x0 + plotW, py(ZIEL_WKQ) - 1.2, { align: 'right' });
  return y + H + 8;
}

// ── Seiten ───────────────────────────────────────────────────────────────────

/** Fügt die drei Waren-Seiten ans PDF an (einheitliches Hochformat-Design). */
export function zeichneWarenBlock(
  pdf: jsPDF, d: WarenBlockDaten, branding: RestaurantBranding, heute: Date = new Date(),
): void {
  const rechts = { halign: 'right' as const };
  const stil = tabellenStil(branding);
  const accent = branding.accentColor;

  // Fortsetzungs-Köpfe nur auf Überlauf-Seiten von autoTable.
  const mitFolgeKopf = (titel: string) => {
    let erste = true;
    return () => {
      if (!erste) folgeKopf(pdf, branding, titel);
      erste = false;
    };
  };

  // ── A) Lieferanten-Übersicht ──
  pdf.addPage('a4', 'portrait');
  let y = kopfband(pdf, branding, 'Waren · Lieferanten-Übersicht', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Netto-Anteil je Lieferant',
    'Anteil am direkten Warenaufwand (Konten 4020–4070, netto)');
  y = chartLieferanten(pdf, y, d);
  y = abschnitt(pdf, y + 2, accent, 'Lieferanten im Detail',
    `Umsatzbasis netto CHF ${fmtChf(d.totalUmsatz)}`);
  autoTable(pdf, {
    ...stil,
    startY: y,
    head: [['Lieferant', 'Betrag netto (CHF)', 'Anteil Umsatz', 'Rechnungen', 'Status']],
    body: [
      ...d.lieferanten.map(l => [
        l.name,
        l.direktNet > 0 ? fmtChf(l.direktNet) : '–', // leer statt 0
        fmtPct(l.anteilUmsatzPct),
        String(l.rechnungen), l.status,
      ]),
      [{ content: 'Total', styles: { fontStyle: 'bold' as const } },
       { content: fmtChf(d.totalDirekt), styles: { fontStyle: 'bold' as const, ...rechts } },
       { content: fmtPct(d.monatsWkqPct), styles: { fontStyle: 'bold' as const, ...rechts } },
       { content: String(d.lieferanten.reduce((s, l) => s + l.rechnungen, 0)), styles: { fontStyle: 'bold' as const, ...rechts } },
       ''],
    ],
    columnStyles: { 1: rechts, 2: rechts, 3: rechts },
    didParseCell: data => {
      // Status-Zelle wird als Chip gezeichnet — Text unterdrücken.
      if (data.section === 'body' && data.column.index === 4 && typeof data.cell.raw === 'string' && data.cell.raw) {
        data.cell.text = [''];
      }
    },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === 4 && typeof data.cell.raw === 'string' && data.cell.raw) {
        zeichneStatusChip(pdf, data.cell, data.cell.raw);
      }
    },
    didDrawPage: mitFolgeKopf('Waren · Lieferanten-Übersicht'),
  });

  // ── B) Kumulierte Warenkosten / Umsatz ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Waren · Kumulierte Warenkosten / Umsatz', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  // Kumulations-Liniendiagramm auf User-Wunsch entfernt — Tabelle bleibt.
  y = abschnitt(pdf, y + 1, accent, 'Tageswerte im Detail', 'fehlende Werte bleiben leer');
  autoTable(pdf, {
    ...stil,
    styles: { ...stil.styles, fontSize: 7.8, cellPadding: { top: 1.5, bottom: 1.5, left: 2.4, right: 2.4 } },
    startY: y,
    head: [['Datum', 'Waren (CHF)', 'Umsatz (CHF)', 'Tages-%', 'Kum. Waren', 'Kum. Umsatz', 'Kum.-%']],
    body: d.tage.map(t => [
      fmtDat(t.datum), fmtChf(t.waren), fmtChf(t.umsatz), fmtPct(t.tagesPct),
      fmtChf(t.kumWaren), fmtChf(t.kumUmsatz), fmtPct(t.kumPct),
    ]),
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts, 5: rechts, 6: rechts },
    didDrawPage: mitFolgeKopf('Waren · Kumulierte Warenkosten / Umsatz'),
  });

  // ── C) Anomalie-Analyse pro Woche ──
  pdf.addPage('a4', 'portrait');
  y = kopfband(pdf, branding, 'Waren · Anomalie-Analyse pro Woche', d.monatLabel, heute);
  y = kpiZeile(pdf, y, d);
  y = abschnitt(pdf, y, accent, 'Wochen-WKQ mit Ziel-Linie',
    'WKQ = direkter Warenaufwand ÷ Netto-Umsatz');
  y = chartWochen(pdf, y, d);
  y = abschnitt(pdf, y + 1, accent, 'Wochen & Lieferanten im Detail',
    `Monat gesamt: CHF ${fmtChf(d.totalDirekt)} (${fmtPct(d.monatsWkqPct)})`);
  type ZellDef = string | { content: string; styles?: Record<string, unknown> };
  const kwBody: ZellDef[][] = [];
  const wkqZeilen = new Map<number, number | null>(); // Zeilen-Index → WKQ für Ampel
  for (const w of d.wochen) {
    wkqZeilen.set(kwBody.length, w.wkqPct);
    kwBody.push([
      { content: `${w.weekLabel}  (${fmtDat(w.von)}–${fmtDat(w.bis)})`, styles: { fontStyle: 'bold' } },
      { content: fmtChf(w.direktNet), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: String(w.rechnungen), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: fmtChf(w.umsatz), styles: { fontStyle: 'bold', halign: 'right' } },
      { content: fmtPct(w.wkqPct), styles: { fontStyle: 'bold', halign: 'right', textColor: wkqFarbe(w.wkqPct).ink } },
    ]);
    for (const l of w.lieferanten) {
      kwBody.push([
        { content: `   · ${l.name}`, styles: { textColor: INK2 } },
        { content: l.direktNet > 0 ? fmtChf(l.direktNet) : '–', styles: { halign: 'right' } },
        { content: String(l.rechnungen), styles: { halign: 'right' } },
        { content: l.anteilKwPct !== null ? `${l.anteilKwPct.toFixed(1)} % der KW` : '–', styles: { halign: 'right' } },
        '',
      ]);
    }
  }
  wkqZeilen.set(kwBody.length, d.monatsWkqPct);
  kwBody.push([
    { content: 'Gesamttotal', styles: { fontStyle: 'bold' } },
    { content: fmtChf(d.totalDirekt), styles: { fontStyle: 'bold', halign: 'right' } },
    { content: String(d.wochen.reduce((s, w) => s + w.rechnungen, 0)), styles: { fontStyle: 'bold', halign: 'right' } },
    { content: fmtChf(d.totalUmsatz), styles: { fontStyle: 'bold', halign: 'right' } },
    { content: fmtPct(d.monatsWkqPct), styles: { fontStyle: 'bold', halign: 'right', textColor: wkqFarbe(d.monatsWkqPct).ink } },
  ]);
  autoTable(pdf, {
    ...stil,
    startY: y,
    head: [['Woche / Lieferant', 'Netto (CHF)', 'Rechnungen', 'Umsatz (CHF)', 'WKQ']],
    body: kwBody as Parameters<typeof autoTable>[1]['body'],
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts },
    didDrawCell: data => {
      if (data.section === 'body' && data.column.index === 4 && wkqZeilen.has(data.row.index)) {
        zeichneAmpelPunkt(pdf, data.cell, wkqZeilen.get(data.row.index) ?? null);
      }
    },
    didDrawPage: mitFolgeKopf('Waren · Anomalie-Analyse pro Woche'),
  });
}
