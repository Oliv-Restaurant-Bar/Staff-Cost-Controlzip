/**
 * Personaleintritt — PDF-Füllung (IO: pdf-lib + gebündelte Vorlagen)
 * ==================================================================
 * Füllt die L-GAV-Vertragsvorlage (SL/ML) client-seitig mit pdf-lib und
 * liefert ZWEI Varianten: editierbar (GF kann Felder nachbearbeiten) und
 * flach (Formularfelder eingebrannt, für Versand/Signatur).
 *
 * Die blanko Vorlagen liegen als gebündelte Assets im Frontend (keine PII);
 * die GEFÜLLTEN PDFs werden ausschliesslich in den privaten Storage-Bucket
 * hochgeladen (Aufrufer: detail-Seite via uploadDokument).
 */

import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';
import slVorlageUrl from '@/assets/vertragsvorlagen/SL_Arbeitsvertrag_Vorlage.pdf?url';
import mlVorlageUrl from '@/assets/vertragsvorlagen/ML_Arbeitsvertrag_Vorlage.pdf?url';
import type { PersonaleintrittRecord } from './types';
import { buildPdfFillMap } from './pdf-fill-mapping';

export interface VertragsPdfErgebnis {
  /** Editierbare Version (AcroForm-Felder bleiben bestehen). */
  editierbar: Uint8Array;
  /** Flache Version (Felder eingebrannt). */
  flach: Uint8Array;
  /** Mapping-Warnungen + Felder, die in der Vorlage nicht gefunden wurden. */
  warnungen: string[];
}

async function ladeVorlage(typ: 'SL' | 'ML'): Promise<ArrayBuffer> {
  const url = typ === 'SL' ? slVorlageUrl : mlVorlageUrl;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Vertragsvorlage ${typ} konnte nicht geladen werden (HTTP ${res.status}).`);
  return res.arrayBuffer();
}

/** Füllt die Vorlage gemäss Mapping. Wirft bei fehlender Vorlage/kaputtem PDF. */
export async function erzeugeVertragsPdf(record: PersonaleintrittRecord): Promise<VertragsPdfErgebnis> {
  if (record.vertragstyp !== 'SL' && record.vertragstyp !== 'ML') {
    throw new Error('Vertragstyp fehlt — PDF kann nicht erstellt werden.');
  }
  const { text, checkboxes, warnungen } = buildPdfFillMap(record);
  const vorlage = await ladeVorlage(record.vertragstyp);

  const doc = await PDFDocument.load(vorlage);
  const form = doc.getForm();
  const fehlend: string[] = [];

  for (const [name, wert] of Object.entries(text)) {
    try {
      const feld = form.getField(name);
      if (feld instanceof PDFTextField) feld.setText(wert);
      else fehlend.push(name);
    } catch {
      fehlend.push(name);
    }
  }
  for (const [name, an] of Object.entries(checkboxes)) {
    try {
      const feld = form.getField(name);
      if (feld instanceof PDFCheckBox) { if (an) feld.check(); else feld.uncheck(); }
      else fehlend.push(name);
    } catch {
      fehlend.push(name);
    }
  }
  if (fehlend.length > 0) {
    warnungen.push(`Nicht in der Vorlage gefunden (bitte manuell prüfen): ${fehlend.join(', ')}`);
  }

  form.updateFieldAppearances();
  const editierbar = await doc.save();

  // Flache Kopie aus den editierbaren Bytes (eigenes Dokument, damit die
  // editierbare Version ihre Felder behält).
  const flachDoc = await PDFDocument.load(editierbar);
  flachDoc.getForm().flatten();
  const flach = await flachDoc.save();

  return { editierbar, flach, warnungen };
}
