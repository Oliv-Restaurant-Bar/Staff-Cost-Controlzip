// @vitest-environment node
/**
 * Tests: PDF-Feld-Mapping (rein) + Validierung gegen die ECHTEN Vorlagen.
 * Der Vorlagen-Test lädt die AcroForm-Feldnamen aus den Original-PDFs und
 * stellt sicher, dass JEDES vom Mapping gesetzte Feld dort existiert und den
 * richtigen Typ hat (Text vs. Checkbox) — kein blindes Raten von Feldnamen.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';

import {
  BEMERKUNG_ARBEITSBEWILLIGUNG, STANDARD_BEMERKUNGEN, bemerkungenFuerVertrag,
  buildPdfFillMap, formatChfPdf, formatDatumPdf, wrapZeilen,
} from '../pdf-fill-mapping';
import type { PersonaleintrittRecord } from '../types';

const VORLAGEN_DIR = resolve(__dirname, '../../../assets/vertragsvorlagen');

function baseRecord(overrides: Partial<PersonaleintrittRecord> = {}): PersonaleintrittRecord {
  return {
    id: 'test-1',
    restaurantId: 'oliv',
    status: 'geprueft',
    vertragstyp: 'SL',
    betrieb: 'Oliv Restaurant & Bar',
    funktion: 'Servicemitarbeiterin',
    eintritt: '2026-03-05',
    probezeitTage: 90,
    vertragsdauer: 'unbefristet',
    lohnBerechnet: 20.65,
    lohnEinheit: 'stunde',
    maDaten: {
      personalien: {
        anrede: 'Frau', name: 'Muster', vorname: 'Anna',
        strasse: 'Teststrasse 1', plz: '3000', ort: 'Bern',
        geburtsdatum: '2000-12-07', telefon: '076 000 00 00',
        email: 'anna@example.com', heimatort_nationalitaet: 'Bern BE',
      },
      lohnprogramm: {
        zivilstand: 'ledig', ahv_nr: '756.0000.0000.00',
        aufenthaltsbewilligung: 'CH', kinder: [],
      },
      vertrag: { besondere_vereinbarungen: 'Arztzeugnisse werden ab dem 1. Tag verlangt.' },
    },
    ...overrides,
  };
}

describe('Formatierung', () => {
  it('formatChfPdf: Apostroph-Tausender + 2 Dezimalstellen', () => {
    expect(formatChfPdf(4600)).toBe('4\u2019600.00');
    expect(formatChfPdf(20.65)).toBe('20.65');
    expect(formatChfPdf(1234567.5)).toBe('1\u2019234\u2019567.50');
  });
  it('formatDatumPdf: ISO → dd.MM.yyyy, ungültig ⇒ leer', () => {
    expect(formatDatumPdf('2026-03-05')).toBe('05.03.2026');
    expect(formatDatumPdf(undefined)).toBe('');
    expect(formatDatumPdf('kein-datum')).toBe('');
  });
  it('wrapZeilen bricht an Wortgrenzen und respektiert maxZeilen', () => {
    const zeilen = wrapZeilen('eins zwei drei vier fünf sechs', 10, 3);
    expect(zeilen.length).toBeLessThanOrEqual(3);
    for (const z of zeilen) expect(z.length).toBeLessThanOrEqual(10);
  });
});

describe('buildPdfFillMap — SL', () => {
  const map = buildPdfFillMap(baseRecord(), '2026-07-24');

  it('füllt Personalien & Eckdaten', () => {
    expect(map.text['NameVorname']).toBe('Anna Muster');
    expect(map.text['PLZOrt']).toBe('3000 Bern');
    expect(map.text['Geburtsdatum']).toBe('07.12.2000');
    expect(map.text['Vertragsbeginn']).toBe('05.03.2026');
    expect(map.text['Anzahl Kinder']).toBe('-');
    expect(map.text['undefined_4']).toBe('Bern, 24.07.2026');
  });

  it('rechnet SL-Zuschläge auf der Basis (Referenzvertrag 20.65)', () => {
    expect(map.text['Fr']).toBe('20.65');
    expect(map.text['Fr_2']).toBe('2.20');   // Ferien 10.65 %
    expect(map.text['Fr_3']).toBe('0.47');   // Feiertag 2.27 %
    expect(map.text['Fr_4']).toBe('1.72');   // 13. ML 8.33 %
    expect(map.text['Fr_5']).toBe('25.04');  // Total
    expect(map.text['Ferien']).toBe('10.65');
  });

  it('Probezeit 90 Tage ⇒ 3 Monate; unbefristet ⇒ Checkbox a', () => {
    expect(map.text['Die Probezeit beträgt']).toBe('3');
    expect(map.checkboxes['a']).toBe(true);
  });

  it('befristet ⇒ keine Checkbox a, Warnung', () => {
    const m = buildPdfFillMap(baseRecord({ vertragsdauer: 'befristet', befristetBis: '2026-12-31' }));
    expect(m.checkboxes['a']).toBeUndefined();
    expect(m.warnungen.some(w => w.includes('Befristeter Vertrag'))).toBe(true);
  });
});

describe('buildPdfFillMap — ML', () => {
  const map = buildPdfFillMap(baseRecord({
    vertragstyp: 'ML', pensumProzent: 100, lohnBerechnet: 4600, lohnEinheit: 'monat',
  }), '2026-07-24');

  it('Monatslohn + 13. + Total (Referenzvertrag 4600)', () => {
    expect(map.text['Fr']).toBe('4\u2019600.00');
    expect(map.text['Fr_2']).toBe('383.18');
    expect(map.text['Fr_3']).toBe('4\u2019983.18');
  });

  it('Vollzeit-Checkbox + 42 h Standard', () => {
    expect(map.checkboxes['a für Vollzeitmitarbeiterin']).toBe(true);
    expect(map.text['Stunden unter 42 Stunden bei Kleinbetrieben unter 45 Stunden bei']).toBe('42');
  });

  it('Teilzeit ohne Wochenstunden ⇒ Warnung, Funktion mit Pensum', () => {
    const m = buildPdfFillMap(baseRecord({ vertragstyp: 'ML', pensumProzent: 60, lohnBerechnet: 2760 }));
    expect(m.checkboxes['b für Teilzeitmitarbeiterin mit regelmässigem festgelegtem Arbeitspensum']).toBe(true);
    expect(m.text['Funktion']).toContain('(60%)');
    expect(m.warnungen.some(w => w.includes('Wochenstunden'))).toBe(true);
  });
});

describe('Mapping-Feldnamen existieren in den echten Vorlagen', () => {
  async function feldTypen(datei: string): Promise<Map<string, 'text' | 'checkbox' | 'andere'>> {
    const bytes = await readFile(resolve(VORLAGEN_DIR, datei));
    const doc = await PDFDocument.load(new Uint8Array(bytes));
    const typen = new Map<string, 'text' | 'checkbox' | 'andere'>();
    for (const f of doc.getForm().getFields()) {
      typen.set(f.getName(), f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'checkbox' : 'andere');
    }
    return typen;
  }

  it('SL: alle gesetzten Felder vorhanden und typrichtig', async () => {
    const typen = await feldTypen('SL_Arbeitsvertrag_Vorlage.pdf');
    const map = buildPdfFillMap(baseRecord());
    for (const name of Object.keys(map.text)) {
      expect(typen.get(name), `Textfeld «${name}» fehlt in SL-Vorlage`).toBe('text');
    }
    for (const name of Object.keys(map.checkboxes)) {
      expect(typen.get(name), `Checkbox «${name}» fehlt in SL-Vorlage`).toBe('checkbox');
    }
  });

  it('ML: alle gesetzten Felder vorhanden und typrichtig', async () => {
    const typen = await feldTypen('ML_Arbeitsvertrag_Vorlage.pdf');
    const map = buildPdfFillMap(baseRecord({ vertragstyp: 'ML', pensumProzent: 80, lohnBerechnet: 3680 }));
    for (const name of Object.keys(map.text)) {
      expect(typen.get(name), `Textfeld «${name}» fehlt in ML-Vorlage`).toBe('text');
    }
    for (const name of Object.keys(map.checkboxes)) {
      expect(typen.get(name), `Checkbox «${name}» fehlt in ML-Vorlage`).toBe('checkbox');
    }
  });
});

describe('Standard-Bemerkungen «13 Besondere Vereinbarungen» (Anpassung 6)', () => {
  it('bemerkungenFuerVertrag: immer beide Standardsätze, GF-Freitext danach', () => {
    const zeilen = bemerkungenFuerVertrag(baseRecord());
    expect(zeilen[0]).toBe(STANDARD_BEMERKUNGEN[0]);
    expect(zeilen[1]).toBe(STANDARD_BEMERKUNGEN[1]);
    expect(zeilen[2]).toBe('Arztzeugnisse werden ab dem 1. Tag verlangt.'); // Freitext aus baseRecord
    expect(zeilen).not.toContain(BEMERKUNG_ARBEITSBEWILLIGUNG);
  });
  it('Bewilligungs-Satz NUR bei effektiv erforderlicher Bewilligung', () => {
    const r = baseRecord();
    r.maDaten!.lohnprogramm!.aufenthaltsbewilligung = 'S';
    expect(bemerkungenFuerVertrag(r)).toContain(BEMERKUNG_ARBEITSBEWILLIGUNG);
    const rGf = baseRecord({ bewilligungErforderlich: true });
    expect(bemerkungenFuerVertrag(rGf)).toContain(BEMERKUNG_ARBEITSBEWILLIGUNG);
  });
  it('PDF-Map: Standardsätze landen ab Zeile 1 (gewrappt, 60 Zeichen)', () => {
    const map = buildPdfFillMap(baseRecord(), '2026-07-24');
    expect(map.text['13 Besondere Vereinbarungen 1']).toBe(STANDARD_BEMERKUNGEN[0]);
    // Satz 2 ist länger als 60 Zeichen ⇒ beginnt in Zeile 2 und wird umbrochen
    expect(map.text['13 Besondere Vereinbarungen 2']).toBe(
      wrapZeilen(STANDARD_BEMERKUNGEN[1], 60, 10)[0],
    );
    expect(map.warnungen.some(w => w.includes('länger als der Platz'))).toBe(false);
  });
  it('Überlauf ⇒ Warnung statt stilles Abschneiden ohne Hinweis', () => {
    const r = baseRecord();
    r.maDaten!.vertrag!.besondere_vereinbarungen = 'wort '.repeat(300).trim();
    const map = buildPdfFillMap(r, '2026-07-24');
    expect(map.warnungen.some(w => w.includes('länger als der Platz'))).toBe(true);
    // SL-Vorlage: maximal 11 Zeilen gesetzt
    expect(map.text['13 Besondere Vereinbarungen 11']).toBeDefined();
    expect(map.text['13 Besondere Vereinbarungen 12']).toBeUndefined();
  });
});
