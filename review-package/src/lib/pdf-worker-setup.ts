/**
 * Gemeinsames pdfjs-Worker-Setup (EINE Stelle für die gesamte App)
 * ================================================================
 * Wir nutzen den CDN-Worker, um Bundler-Kompatibilitätsprobleme zu vermeiden.
 * Die Version muss zur installierten pdfjs-dist-Version passen — daher wird
 * sie direkt aus dem Paket gelesen. Wird von pdf-import-engine.ts (Sage/
 * Kontenblatt) UND gn-pdf-text.ts (Gastronovi) importiert.
 */
import * as pdfjsLib from 'pdfjs-dist';

export function ensurePdfWorkerConfigured(): void {
  if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  }
}
