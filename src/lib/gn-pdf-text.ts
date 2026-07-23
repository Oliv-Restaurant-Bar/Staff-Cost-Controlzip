/**
 * Gastronovi PDF — Textextraktion (IO-Schicht, pdfjs)
 * ====================================================
 * EINZIGES Gastronovi-Modul mit pdfjs-Abhängigkeit. Liefert rohe Text-Items
 * mit Position (x/y/str) je Seite — die gesamte Interpretation passiert in
 * den REINEN Modulen gn-pdf-lines.ts / gn-zbericht-pdf-parser.ts (testbar
 * ohne PDF-Laufzeit).
 *
 * Scan-Erkennung: PDFs ohne Textebene (reine Bild-Scans) werden hier erkannt
 * und mit `hasTextLayer: false` gemeldet — der Aufrufer zeigt die konkrete
 * Diagnose «PDF enthält keinen auslesbaren Text (vermutlich Scan)». Es gibt
 * bewusst KEIN OCR.
 */
import * as pdfjsLib from 'pdfjs-dist';
import { ensurePdfWorkerConfigured } from './pdf-worker-setup';
import type { GnPdfPageItems } from './gn-pdf-lines';

/** Mindestanzahl Nicht-Whitespace-Zeichen, ab der eine Textebene als vorhanden gilt. */
const MIN_TEXT_CHARS = 50;

export interface GnPdfExtractResult {
  pages: GnPdfPageItems[];
  pageCount: number;
  /** Anzahl Nicht-Whitespace-Zeichen über alle Seiten. */
  totalTextChars: number;
  /** false ⇒ vermutlich Scan ohne Textebene (kein OCR verfügbar). */
  hasTextLayer: boolean;
}

/** Extrahiert alle Text-Items (mit Position) aus einem Gastronovi-PDF. */
export async function extractGnPdfTextItems(file: File): Promise<GnPdfExtractResult> {
  ensurePdfWorkerConfigured();

  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pages: GnPdfPageItems[] = [];
  let totalTextChars = 0;

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items: GnPdfPageItems['items'] = [];
      for (const rawItem of textContent.items) {
        if (!('str' in rawItem)) continue;
        // pdfjs exportiert den TextItem-Typ nicht sauber → strukturell typisieren
        const item = rawItem as { str: string; transform: number[] };
        items.push({
          x: item.transform[4],
          y: item.transform[5],
          str: item.str,
        });
        totalTextChars += item.str.replace(/\s/g, '').length;
      }
      pages.push({ pageNumber, items });
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }

  return {
    pages,
    pageCount: pages.length,
    totalTextChars,
    hasTextLayer: totalTextChars >= MIN_TEXT_CHARS,
  };
}
