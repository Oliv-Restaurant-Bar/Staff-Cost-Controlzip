// @vitest-environment node
/**
 * Dossier-Inhalt (Auftrag Punkt 10) — reine Logik.
 * Prüft: Kopfzeile, Q&A-Sektionen aller Phasen, «—» für fehlende Angaben
 * (nie erfunden), Anhang-Liste in MA_DOKUMENT_TYPEN-Reihenfolge und
 * fehlende Pflicht-Dokumente.
 */
import { describe, it, expect } from 'vitest';
import { buildDossierInhalt } from '../dossier-inhalt';
import type { PersonaleintrittRecord } from '../types';

function baseRecord(over: Partial<PersonaleintrittRecord> = {}): PersonaleintrittRecord {
  return {
    id: 'pe-1',
    restaurantId: 'oliv',
    status: 'geprueft',
    vertragstyp: 'ML',
    betrieb: 'Oliv Restaurant & Bar',
    funktion: 'Koch',
    eintritt: '2026-08-01',
    pensumProzent: 80,
    probezeitTage: 0,
    vertragsdauer: 'unbefristet',
    lohnModus: 'mindestlohn',
    lohnklasse: 'Ia',
    lohnBerechnet: 4471,
    lohnEinheit: 'monat',
    bewilligungAusweisS: true,
    maDaten: {
      personalien: {
        anrede: 'Frau', vorname: 'Anna', name: 'Muster', geburtsdatum: '1995-03-12',
        strasse: 'Weg 1', plz: '3000', ort: 'Bern',
      },
      lohnprogramm: { zemis_nr: '12345678', kinder: [{ name: 'Kim', geburtsdatum: '2020-01-05', familienzulage_bei: 'Mutter' }] },
      dokumente: { ahv_karte: 'oliv/pe-1/ahv.jpg', foto: 'oliv/pe-1/foto.png' },
    },
    ...over,
  } as PersonaleintrittRecord;
}

function antwort(inhalt: ReturnType<typeof buildDossierInhalt>, sektion: string, frage: string): string {
  const s = inhalt.sektionen.find(x => x.titel.includes(sektion));
  expect(s, `Sektion «${sektion}» fehlt`).toBeDefined();
  const z = s!.zeilen.find(x => x.frage === frage);
  expect(z, `Frage «${frage}» fehlt in «${sektion}»`).toBeDefined();
  return z!.antwort;
}

describe('buildDossierInhalt', () => {
  it('Kopf: Betrieb, Name, Eintritt, Erstellungsdatum', () => {
    const inhalt = buildDossierInhalt(baseRecord(), 'oliv', '2026-07-24');
    expect(inhalt.kopf).toEqual({
      betrieb: 'Oliv Restaurant & Bar',
      name: 'Anna Muster',
      eintritt: '01.08.2026',
      erstellt: '24.07.2026',
    });
    expect(inhalt.dateiname).toBe('Dossier_Anna_Muster.pdf');
  });

  it('Q&A: GF-Phase mit Probezeit «Keine», Pensum, Lohn und Bewilligung', () => {
    const inhalt = buildDossierInhalt(baseRecord(), 'oliv', '2026-07-24');
    expect(antwort(inhalt, 'Geschäftsführung', 'Probezeit')).toBe('Keine');
    expect(antwort(inhalt, 'Geschäftsführung', 'Pensum')).toBe('80 %');
    expect(antwort(inhalt, 'Geschäftsführung', 'Lohn (berechnet)')).toBe('CHF 4’471.00 / Monat');
    expect(antwort(inhalt, 'Geschäftsführung', 'Bewilligung erforderlich')).toBe('Ausweis S (Schutzstatus)');
  });

  it('Q&A: fehlende Angaben = «—», nie erfunden', () => {
    const inhalt = buildDossierInhalt(baseRecord({ maDaten: {} }), 'oliv', '2026-07-24');
    expect(antwort(inhalt, 'Personalien', 'Name')).toBe('—');
    expect(antwort(inhalt, 'Lohnprogramm', 'AHV-Nr.')).toBe('—');
    expect(antwort(inhalt, 'Vertragsangaben', 'Wochenstunden')).toBe('—');
    expect(inhalt.kopf.name).toBe('—');
  });

  it('Kinder werden lesbar zusammengefasst', () => {
    const inhalt = buildDossierInhalt(baseRecord(), 'oliv', '2026-07-24');
    expect(antwort(inhalt, 'Lohnprogramm', 'Kinder (Familienzulagen)'))
      .toBe('Kim, 05.01.2020, Zulage bei: Mutter');
  });

  it('Anhänge in Katalog-Reihenfolge; fehlende Pflicht-Dokumente benannt', () => {
    const inhalt = buildDossierInhalt(baseRecord(), 'oliv', '2026-07-24');
    expect(inhalt.anhaenge.map(a => a.typ)).toEqual(['ahv_karte', 'foto']);
    expect(inhalt.anhaenge[0]).toMatchObject({ label: 'AHV-Karte', path: 'oliv/pe-1/ahv.jpg' });
    expect(inhalt.fehlendeDokumente).toEqual(['Ausweis Vorderseite', 'Ausweis Rückseite']);
  });

  it('Status-Sektion nutzt die zentralen Status-Labels', () => {
    const inhalt = buildDossierInhalt(baseRecord({ status: 'uebernommen', personalstammId: '14' }), 'oliv', '2026-07-24');
    expect(antwort(inhalt, 'Ablauf', 'Status')).toBe('Übernommen');
    expect(antwort(inhalt, 'Ablauf', 'In Personalstamm übernommen')).toBe('Ja (ID 14)');
  });
});
