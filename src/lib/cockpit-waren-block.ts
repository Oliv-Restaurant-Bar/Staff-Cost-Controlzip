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
import {
  loadMonthInvoices, loadIgnorierteRechnungen, filtereIgnorierteRechnungen,
  type InvoiceEntry,
} from '@/lib/waren-db';
import { direktAnteilNet } from '@/lib/waren-analyse';
import { warenkostenQuote } from '@/lib/warenkosten-quote';
import { ladeNettoUmsatzByDate } from '@/lib/umsatz';

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

const M = 12; // Rand mm

function seitenKopf(pdf: jsPDF, titel: string, sub: string): number {
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(20, 20, 20);
  pdf.text(titel, M, M + 4);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text(sub, M, M + 10);
  return M + 16;
}

const KOPF_STIL = {
  styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.6, textColor: [30, 30, 30] as [number, number, number] },
  headStyles: { fillColor: [38, 50, 56] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: [246, 247, 248] as [number, number, number] },
  margin: { left: M, right: M },
};

/** Fügt die drei Waren-Seiten ans PDF an (jede Sektion = eigene Seite, Hochformat). */
export function zeichneWarenBlock(pdf: jsPDF, d: WarenBlockDaten): void {
  const rechts = { halign: 'right' as const };

  // A) Lieferanten-Übersicht.
  pdf.addPage('a4', 'portrait');
  let y = seitenKopf(pdf, `Waren · Lieferanten-Übersicht — ${d.monatLabel}`,
    `Direkter Warenaufwand (Konten 4020–4070, netto) · Umsatzbasis netto CHF ${fmtChf(d.totalUmsatz)}`);
  autoTable(pdf, {
    ...KOPF_STIL,
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
  });

  // B) Tagesverlauf kumuliert.
  pdf.addPage('a4', 'portrait');
  y = seitenKopf(pdf, `Waren · Kumulierte Warenkosten / Umsatz — ${d.monatLabel}`,
    'Je Tag: direkter Warenaufwand (netto) und Netto-Umsatz · fehlende Werte bleiben leer');
  autoTable(pdf, {
    ...KOPF_STIL,
    startY: y,
    head: [['Datum', 'Waren (CHF)', 'Umsatz (CHF)', 'Tages-%', 'Kum. Waren', 'Kum. Umsatz', 'Kum.-%']],
    body: d.tage.map(t => [
      fmtDat(t.datum), fmtChf(t.waren), fmtChf(t.umsatz), fmtPct(t.tagesPct),
      fmtChf(t.kumWaren), fmtChf(t.kumUmsatz), fmtPct(t.kumPct),
    ]),
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts, 5: rechts, 6: rechts },
  });

  // C) Anomalie-Analyse pro KW inkl. Lieferanten-Aufschlüsselung.
  pdf.addPage('a4', 'portrait');
  y = seitenKopf(pdf, `Waren · Anomalie-Analyse pro Woche — ${d.monatLabel}`,
    `WKQ = direkter Warenaufwand ÷ Netto-Umsatz · Monat gesamt: CHF ${fmtChf(d.totalDirekt)} (${fmtPct(d.monatsWkqPct)})`);
  const kwBody: Parameters<typeof autoTable>[1]['body'] = [];
  for (const w of d.wochen) {
    kwBody!.push([
      { content: `${w.weekLabel}  (${fmtDat(w.von)}–${fmtDat(w.bis)})`, styles: { fontStyle: 'bold' as const } },
      { content: fmtChf(w.direktNet), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: String(w.rechnungen), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtChf(w.umsatz), styles: { fontStyle: 'bold' as const, ...rechts } },
      { content: fmtPct(w.wkqPct), styles: { fontStyle: 'bold' as const, ...rechts } },
    ]);
    for (const l of w.lieferanten) {
      kwBody!.push([
        { content: `   · ${l.name}`, styles: { textColor: [90, 90, 90] as [number, number, number] } },
        { content: l.direktNet > 0 ? fmtChf(l.direktNet) : '–', styles: rechts },
        { content: String(l.rechnungen), styles: rechts },
        { content: l.anteilKwPct !== null ? `${l.anteilKwPct.toFixed(1)} % der KW` : '–', styles: rechts },
        '',
      ]);
    }
  }
  kwBody!.push([
    { content: 'Gesamttotal', styles: { fontStyle: 'bold' as const } },
    { content: fmtChf(d.totalDirekt), styles: { fontStyle: 'bold' as const, ...rechts } },
    { content: String(d.wochen.reduce((s, w) => s + w.rechnungen, 0)), styles: { fontStyle: 'bold' as const, ...rechts } },
    { content: fmtChf(d.totalUmsatz), styles: { fontStyle: 'bold' as const, ...rechts } },
    { content: fmtPct(d.monatsWkqPct), styles: { fontStyle: 'bold' as const, ...rechts } },
  ]);
  autoTable(pdf, {
    ...KOPF_STIL,
    startY: y,
    head: [['Woche / Lieferant', 'Netto (CHF)', 'Rechnungen', 'Umsatz (CHF)', 'WKQ']],
    body: kwBody,
    columnStyles: { 1: rechts, 2: rechts, 3: rechts, 4: rechts },
  });
}
