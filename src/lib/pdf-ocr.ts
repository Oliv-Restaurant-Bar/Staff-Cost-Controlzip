/**
 * PDF-OCR-Fallback (nur für Scans OHNE Textebene)
 * ================================================
 * Rendert die PDF-Seiten per pdfjs auf ein Canvas und gewinnt den Text via
 * tesseract.js (Sprache Deutsch). Wird AUSSCHLIESSLICH als Fallback benutzt,
 * wenn `extractGnPdfTextItems` keinen Text-Layer findet — text-basierte
 * Importe (Spahni, Terravigna, …) bleiben unverändert schnell.
 *
 * Grundsätze:
 * - Kein Raten: liefert der OCR-Lauf praktisch keinen Text, wird `null`
 *   zurückgegeben und der Aufrufer behandelt das PDF wie bisher (manuell).
 * - Browser-only (Canvas + Worker); bewusst KEINE Node-Pfade.
 */
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import { ensurePdfWorkerConfigured } from './pdf-worker-setup';

/** Render-Skalierung: 300-dpi-Äquivalent für saubere Ziffern-Erkennung. */
const OCR_SCALE = 3;
/** Unter dieser Zeichenzahl gilt der OCR-Lauf als gescheitert (kein Raten). */
const MIN_OCR_CHARS = 40;
/** Sicherheitsgrenze: Scans sind Einzel-Lieferscheine, keine Kataloge. */
const MAX_OCR_PAGES = 10;

export interface PdfOcrResult {
  /** Erkannter Text (Seiten mit \n getrennt). */
  text: string;
  pageCount: number;
}

/**
 * OCR über alle Seiten eines Scan-PDFs. Gibt `null` zurück, wenn praktisch
 * kein Text erkannt wurde — der Aufrufer darf dann NICHTS ableiten.
 */
export async function ocrPdfText(file: File): Promise<PdfOcrResult | null> {
  ensurePdfWorkerConfigured();
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    worker = await createWorker('deu');
  } catch (e) {
    // Worker-Start fehlgeschlagen (z.B. Sprachdaten nicht ladbar): Dokument
    // trotzdem sauber freigeben, dann Fehler weiterreichen.
    await doc.destroy().catch(() => undefined);
    throw e;
  }
  try {
    const seiten: string[] = [];
    const n = Math.min(doc.numPages, MAX_OCR_PAGES);
    for (let pageNumber = 1; pageNumber <= n; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: OCR_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const { data } = await worker.recognize(canvas);
      seiten.push(data.text ?? '');
      // Canvas freigeben (grosse Scans, mehrere Dateien pro Batch).
      canvas.width = 0; canvas.height = 0;
    }
    const text = seiten.join('\n');
    if (text.replace(/\s/g, '').length < MIN_OCR_CHARS) return null;
    return { text, pageCount: n };
  } finally {
    await worker.terminate().catch(() => undefined);
    await doc.destroy().catch(() => undefined);
  }
}
