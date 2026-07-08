/**
 * PDF-Monatsabschluss (§9 Buchhaltungs-Export-Assistent)
 * =============================================================================
 * Zweistufig für Testbarkeit:
 *  - buildMonatsabschlussPdfData: REINE Datenaufbereitung (node-testbar,
 *    kein jsPDF) — alle Abschnitte des PDFs als fertige Strings/Zeilen.
 *  - renderMonatsabschlussPdf: Layout mit jsPDF + autoTable (Logo optional
 *    als dataURL-Parameter — kein DOM-/Asset-Zugriff in der Lib).
 */

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  TAGESABSCHLUSS_FIELD_LABEL,
  cashDiffReasonLabel,
  type TagesabschlussBlob,
  type TagesabschlussMonth,
  type TagesabschlussField,
} from './tagesabschluss';
import {
  buildMonatspruefung,
  type ExportChecklistItem,
} from './buchhaltungs-export';

// ── Formatierung ─────────────────────────────────────────────────────────────

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
] as const;

/** yyyy-MM → „Juli 2026" (rein textuell, kein Date-Parsing). */
export function monthKeyLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) return monthKey;
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_NAMES_DE[idx]} ${m[1]}` : monthKey;
}

function chf(v: number | null): string {
  if (v === null) return '—';
  return new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

/** yyyy-MM-dd → dd.MM.yyyy. */
function chDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function monatsabschlussPdfFilename(monthKey: string, restaurantName: string): string {
  const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `monatsabschluss_${slug || 'restaurant'}_${monthKey}.pdf`;
}

// ── Datenmodell (rein) ───────────────────────────────────────────────────────

export interface PdfKeyValue {
  label: string;
  value: string;
}

export interface PdfBegruendeteDifferenz {
  datum: string;   // dd.MM.yyyy
  differenz: string; // formatiert
  gruende: string; // Labels, kommagetrennt
  notiz: string;
}

export interface PdfKommentar {
  datum: string;   // dd.MM.yyyy
  feld: string;    // Feld-Label oder „Tag"
  text: string;
}

export interface MonatsabschlussPdfData {
  titel: string;            // „Monatsabschluss Juli 2026"
  restaurantName: string;
  monthKey: string;
  erstelltAm: string;       // formatiert
  erstelltVon: string;
  /** Kennzahlen §9: Anfangs-/Endbestand, Umsatz, KK, Debitoren, … */
  kennzahlen: PdfKeyValue[];
  /** Cash- und Adyen-Differenz-Zusammenfassung. */
  differenzen: PdfKeyValue[];
  /** Begründete Kassendifferenzen (Tage mit Grund/Notiz). */
  begruendeteDifferenzen: PdfBegruendeteDifferenz[];
  /** Tagesbemerkungen + Feld-Kommentare des Monats. */
  kommentare: PdfKommentar[];
  /** Offene Punkte = Checklisten-Items, die nicht ok sind (leer = keine). */
  offenePunkte: string[];
}

export interface MonatsabschlussPdfParams {
  monthKey: string;
  restaurantName: string;
  month: TagesabschlussMonth;
  blob: TagesabschlussBlob;
  checklist: readonly ExportChecklistItem[];
  generatedBy: string;
  generatedAt: string; // ISO
}

/** Reine Datenaufbereitung — enthält ALLE Abschnitte aus Spec §9. */
export function buildMonatsabschlussPdfData(params: MonatsabschlussPdfParams): MonatsabschlussPdfData {
  const { monthKey, restaurantName, month, blob, checklist, generatedBy, generatedAt } = params;
  const t = month.totals;

  // Kennzahlen: Monatsprüfung-Totale in PDF-Reihenfolge (§9).
  const pruefung = buildMonatspruefung(month);
  const byKey = Object.fromEntries(pruefung.map(i => [i.key, i]));
  const kennzahlen: PdfKeyValue[] = [
    { label: 'Anfangsbestand Kasse', value: chf(byKey['saldo_anfang']?.value ?? null) },
    { label: 'Endbestand Kasse', value: chf(byKey['saldo_ende']?.value ?? null) },
    { label: 'Umsatz Total', value: chf(byKey['umsatz']?.value ?? null) },
    { label: 'Kreditkarten Total (inkl. TWINT)', value: chf(byKey['kreditkarten']?.value ?? null) },
    { label: 'Debitoren Total', value: chf(byKey['debitoren']?.value ?? null) },
    { label: 'Barausgaben Total', value: chf(byKey['barausgaben']?.value ?? null) },
    { label: 'Verkaufte Gutscheine', value: chf(byKey['gutscheine_verkauft']?.value ?? null) },
    { label: 'Eingelöste Gutscheine', value: chf(byKey['gutscheine_eingeloest']?.value ?? null) },
    { label: 'Einzahlungen Bank', value: chf(byKey['einzahlung_bank']?.value ?? null) },
  ];

  const adyenDiffDays = month.rows.filter(
    r => r.adyenDiffStatus !== null && r.adyenDiffStatus !== 'ok',
  ).length;
  const differenzen: PdfKeyValue[] = [
    { label: 'Cash-Differenzen (Summe)', value: chf(t.cashDiffTotal) },
    { label: 'Tage mit Cash-Differenz', value: String(t.daysWithCashDiff) },
    { label: 'davon begründet', value: String(t.daysBegruendet) },
    { label: 'Adyen-Differenzen (Summe)', value: chf(t.adyenDiff) },
    { label: 'Tage mit Adyen-Differenz', value: String(adyenDiffDays) },
  ];

  const begruendeteDifferenzen: PdfBegruendeteDifferenz[] = month.rows
    .filter(r => r.cashDiff !== null && r.cashDiffStatus !== 'ok' && r.cashDiffBegruendet)
    .map(r => ({
      datum: chDate(r.date),
      differenz: chf(r.cashDiff),
      gruende: r.cashDiffReasons.map(cashDiffReasonLabel).join(', '),
      notiz: r.cashDiffNote ?? '',
    }));

  // Kommentare: Tagesbemerkungen + Feld-Kommentare (Blob) des Monats.
  const kommentare: PdfKommentar[] = [];
  for (const r of month.rows) {
    if (r.bemerkung && r.bemerkung.trim() !== '') {
      kommentare.push({ datum: chDate(r.date), feld: 'Tag', text: r.bemerkung.trim() });
    }
  }
  const prefix = `${monthKey}-`;
  for (const [key, c] of Object.entries(blob.comments)) {
    if (!key.startsWith(prefix)) continue;
    if (c.deleted) continue; // Tombstone = entfernter Kommentar
    const text = (c as { text?: string }).text ?? '';
    if (text.trim() === '') continue;
    const date = key.slice(0, 10);
    const field = key.slice(11) as TagesabschlussField;
    kommentare.push({
      datum: chDate(date),
      feld: TAGESABSCHLUSS_FIELD_LABEL[field] ?? field,
      text: text.trim(),
    });
  }
  kommentare.sort((a, b) => a.datum.localeCompare(b.datum) || a.feld.localeCompare(b.feld));

  const offenePunkte = checklist.filter(i => !i.ok).map(i => `${i.label}: ${i.detail}`);

  const gen = new Date(generatedAt);
  const erstelltAm = Number.isNaN(gen.getTime())
    ? generatedAt
    : `${String(gen.getDate()).padStart(2, '0')}.${String(gen.getMonth() + 1).padStart(2, '0')}.${gen.getFullYear()} ` +
      `${String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')}`;

  return {
    titel: `Monatsabschluss ${monthKeyLabel(monthKey)}`,
    restaurantName,
    monthKey,
    erstelltAm,
    erstelltVon: generatedBy,
    kennzahlen,
    differenzen,
    begruendeteDifferenzen,
    kommentare,
    offenePunkte,
  };
}

// ── Rendering (jsPDF) ────────────────────────────────────────────────────────

type RGB = [number, number, number];
const NAVY: RGB = [30, 41, 59];
const MUTED: RGB = [100, 116, 139];
const BORDER: RGB = [226, 232, 240];
const BG_LIGHT: RGB = [248, 250, 252];
const RED_TEXT: RGB = [153, 27, 27];

/**
 * Rendert das Monatsabschluss-PDF. `logoDataUrl` optional (PNG/JPEG-dataURL);
 * ohne Logo bleibt der Kopf textbasiert — kein stiller Asset-Zugriff.
 */
export function renderMonatsabschlussPdf(
  data: MonatsabschlussPdfData,
  logoDataUrl?: string | null,
): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 16;

  // Kopf: Logo (optional) + Restaurant + Titel.
  if (logoDataUrl) {
    try {
      const fmt = logoDataUrl.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      doc.addImage(logoDataUrl, fmt, pageW - margin - 24, y - 4, 24, 24);
    } catch {
      // Logo defekt → PDF trotzdem erzeugen (sichtbar bleibt der Textkopf).
    }
  }
  doc.setTextColor(...MUTED);
  doc.setFontSize(10);
  doc.text(data.restaurantName, margin, y);
  y += 7;
  doc.setTextColor(...NAVY);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text(data.titel, margin, y);
  doc.setFont('helvetica', 'normal');
  y += 6;
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Erstellt am ${data.erstelltAm} von ${data.erstelltVon}`, margin, y);
  y += 6;
  doc.setDrawColor(...BORDER);
  doc.line(margin, y, pageW - margin, y);
  y += 4;

  const sectionTable = (
    title: string,
    head: string[][],
    body: string[][],
    opts: { emptyText?: string; headRed?: boolean } = {},
  ): void => {
    doc.setFontSize(12);
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    y += 6;
    doc.text(title, margin, y);
    doc.setFont('helvetica', 'normal');
    y += 2;
    if (body.length === 0) {
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      y += 5;
      doc.text(opts.emptyText ?? 'Keine Einträge.', margin, y);
      y += 2;
      return;
    }
    autoTable(doc, {
      startY: y + 1,
      head,
      body,
      margin: { left: margin, right: margin },
      styles: { fontSize: 9, cellPadding: 1.8, textColor: NAVY as unknown as number[], lineColor: BORDER as unknown as number[], lineWidth: 0.1 },
      headStyles: {
        fillColor: (opts.headRed ? RED_TEXT : NAVY) as unknown as number[],
        textColor: [255, 255, 255] as unknown as number[],
        fontSize: 9,
      },
      alternateRowStyles: { fillColor: BG_LIGHT as unknown as number[] },
      theme: 'grid',
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2;
  };

  sectionTable('Kennzahlen', [['Kennzahl', 'CHF']], data.kennzahlen.map(k => [k.label, k.value]));
  sectionTable('Differenzen', [['Position', 'Wert']], data.differenzen.map(k => [k.label, k.value]));
  sectionTable(
    'Begründete Differenzen',
    [['Datum', 'Differenz', 'Gründe', 'Notiz']],
    data.begruendeteDifferenzen.map(d => [d.datum, d.differenz, d.gruende, d.notiz]),
    { emptyText: 'Keine begründeten Differenzen.' },
  );
  sectionTable(
    'Kommentare',
    [['Datum', 'Feld', 'Kommentar']],
    data.kommentare.map(k => [k.datum, k.feld, k.text]),
    { emptyText: 'Keine Kommentare.' },
  );
  if (data.offenePunkte.length > 0) {
    sectionTable(
      'Offene Punkte',
      [['Punkt']],
      data.offenePunkte.map(p => [p]),
      { headRed: true },
    );
  }

  // Fusszeile mit Seitenzahlen.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(
      `${data.restaurantName} — ${data.titel} — Seite ${p}/${pages}`,
      pageW / 2,
      doc.internal.pageSize.getHeight() - 8,
      { align: 'center' },
    );
  }
  return doc;
}

/** Komfort: Daten aufbereiten + rendern in einem Schritt. */
export function buildMonatsabschlussPdf(
  params: MonatsabschlussPdfParams,
  logoDataUrl?: string | null,
): jsPDF {
  return renderMonatsabschlussPdf(buildMonatsabschlussPdfData(params), logoDataUrl);
}
