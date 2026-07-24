/**
 * Personaleintritt — SEM-Meldeformular «Meldung Erwerbstätigkeit» (Auftrag Punkt 9)
 * =================================================================================
 * IO-Schicht: lädt die amtliche Vorlage aus dem privaten Bucket und füllt sie
 * client-seitig (pdf-lib) für Ausweis F/S. Ausweis N und das generische Flag
 * «Arbeitsbewilligung» lösen dieses Formular bewusst NICHT aus (Routing in
 * behoerden-meldung.ts). Feldwerte kommen aus dem REINEN Mapping
 * (sem-formular-mapping.ts, Kandidaten-Listen pro logischem Feld).
 *
 * Die Vorlage ist ein amtliches Formular und wird NICHT im Frontend gebündelt:
 * sie liegt im privaten Bucket unter `vorlagen/sem_meldung.pdf` und wird vom
 * Admin einmalig hochgeladen. Fehlt sie, wirft der Füller einen klaren Fehler
 * (SemVorlageFehltError) — die Detailseite bietet dann den Upload an; der
 * bestehende .txt-Gesuch-Fallback bleibt unabhängig davon verfügbar.
 *
 * Nicht gefundene Formularfelder werden SICHTBAR als Warnung gemeldet (inkl.
 * der realen Feldnamen der Vorlage zur Diagnose) — nie stilles Raten.
 */

import { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown } from 'pdf-lib';
import type { TenantId } from '@/contexts/TenantContext';
import type { PersonaleintrittRecord } from './types';
import { buildSemFillMap } from './sem-formular-mapping';
import { downloadDokument } from './db';

export { buildSemFillMap } from './sem-formular-mapping';
export type { SemFeld, SemFillMap } from './sem-formular-mapping';

/** Ablage-Pfad der amtlichen Vorlage im privaten Bucket. */
export const SEM_VORLAGE_PATH = 'vorlagen/sem_meldung.pdf';

/** Vorlage fehlt im Bucket — Detailseite bietet Admin-Upload an. */
export class SemVorlageFehltError extends Error {
  constructor() {
    super(
      'Die SEM-Formular-Vorlage fehlt im Dokumente-Bucket '
      + `(${SEM_VORLAGE_PATH}). Bitte das amtliche PDF (AcroForm) hochladen.`,
    );
    this.name = 'SemVorlageFehltError';
  }
}

export interface SemFormularErgebnis {
  /** Editierbare Version (AcroForm-Felder bleiben bestehen — GF prüft/ergänzt). */
  editierbar: Uint8Array;
  /** Mapping-/Vorlagen-Warnungen (nicht gefundene Felder, Diagnose). */
  warnungen: string[];
  /** Fachlich fehlende Angaben aus dem Datensatz. */
  fehlend: string[];
  betreff: string;
  empfaengerEmail: string;
  dateiname: string;
}

/** Füllt die SEM-Vorlage. Wirft SemVorlageFehltError, wenn die Vorlage fehlt. */
export async function erzeugeSemFormular(
  record: PersonaleintrittRecord,
  tenantId: TenantId,
): Promise<SemFormularErgebnis> {
  const vorlage = await downloadDokument(SEM_VORLAGE_PATH);
  if (!vorlage) throw new SemVorlageFehltError();

  const map = buildSemFillMap(record, tenantId);
  const warnungen: string[] = [];

  const doc = await PDFDocument.load(await vorlage.arrayBuffer());
  const form = doc.getForm();
  const vorhandeneNamen = form.getFields().map(f => f.getName());
  const nichtGefunden: string[] = [];

  const findeFeld = (kandidaten: string[]) => {
    for (const name of kandidaten) {
      try {
        return form.getField(name);
      } catch {
        // Kandidat existiert nicht — nächsten probieren.
      }
    }
    return null;
  };

  for (const f of map.felder) {
    const feld = findeFeld(f.kandidaten);
    if (feld instanceof PDFTextField) {
      try {
        feld.setText(f.wert);
      } catch {
        // z. B. maxLength überschritten — sichtbar melden, nie stilles Kürzen.
        warnungen.push(`Feld «${f.label}»: Wert konnte nicht gesetzt werden (bitte manuell eintragen): ${f.wert}`);
      }
    } else {
      nichtGefunden.push(f.label);
    }
  }
  for (const c of map.checkboxen) {
    const feld = findeFeld(c.kandidaten);
    if (feld instanceof PDFCheckBox) { if (c.an) feld.check(); else feld.uncheck(); }
    else if (c.an) nichtGefunden.push(`${c.label} (Checkbox)`);
  }
  // Radio-/Auswahl-Gruppen (Group3/4/5, GroupStartTaetigkeit): Optionen sind je
  // Formular-Version zu verifizieren — bei Nichttreffern die realen Optionen offenlegen.
  for (const r of map.radios) {
    if (!r.aktiv) continue; // Wert im Datensatz unbekannt — nie raten.
    const feld = findeFeld(r.kandidaten);
    if (feld instanceof PDFRadioGroup || feld instanceof PDFDropdown) {
      const optionen = feld.getOptions();
      const treffer = r.optionKandidaten
        .map(k => optionen.find(o => o === k)
          ?? optionen.find(o => o.toLowerCase() === k.toLowerCase())
          ?? optionen.find(o => o.toLowerCase().startsWith(k.toLowerCase())))
        .find(Boolean);
      if (treffer) {
        feld.select(treffer);
      } else {
        warnungen.push(
          `«${r.label}»: keine passende Option gefunden — bitte manuell wählen. `
          + `Optionen der Vorlage: ${optionen.join(', ') || '(keine)'}`,
        );
      }
    } else {
      nichtGefunden.push(r.label);
    }
  }

  if (nichtGefunden.length > 0) {
    warnungen.push(`Im Formular nicht zugeordnet (bitte manuell ausfüllen): ${nichtGefunden.join(', ')}`);
    // Diagnose: reale Feldnamen der Vorlage offenlegen (nie stilles Raten).
    warnungen.push(
      vorhandeneNamen.length > 0
        ? `Feldnamen der Vorlage: ${vorhandeneNamen.join(', ')}`
        : 'Die Vorlage enthält KEINE AcroForm-Felder — bitte die ausfüllbare PDF-Version des SEM verwenden.',
    );
  }

  form.updateFieldAppearances();
  const editierbar = await doc.save();

  return {
    editierbar,
    warnungen,
    fehlend: map.fehlend,
    betreff: map.betreff,
    empfaengerEmail: map.empfaengerEmail,
    dateiname: map.dateiname,
  };
}
