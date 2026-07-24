// @vitest-environment node
/**
 * SEM-Meldeformular — reines Feld-Mapping (Auftrag Punkt 9).
 * Prüft: Spec-Feldnamen (NrSymic, Noms, NuméroIDEB, Group3/4/5, …), Feldwerte
 * aus dem Datensatz, fehlende Angaben (nie erfunden), Radio-Routing und
 * Betreff/Empfänger (Kanton Bern) samt Dateiname.
 */
import { describe, it, expect } from 'vitest';
import { buildSemFillMap, wochenstundenFuerSem } from '../sem-formular-mapping';
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
    pensumProzent: 100,
    lohnBerechnet: 4471,
    lohnEinheit: 'monat',
    bewilligungAusweisF: true,
    maDaten: {
      personalien: {
        anrede: 'Frau', vorname: 'Anna', name: 'Muster', geburtsdatum: '1995-03-12',
        heimatort_nationalitaet: 'Ukraine', strasse: 'Weg 1', plz: '3000', ort: 'Bern',
        telefon: '079 111 22 33', email: 'anna@example.ch',
      },
      lohnprogramm: { aufenthaltsbewilligung: 'S', zemis_nr: '12345678' },
    },
    ...over,
  } as PersonaleintrittRecord;
}

type FillMap = ReturnType<typeof buildSemFillMap>;

function feld(map: FillMap, label: string) {
  const f = map.felder.find(x => x.label === label);
  expect(f, `Feld «${label}» fehlt im Mapping`).toBeDefined();
  return f!;
}

describe('buildSemFillMap', () => {
  it('füllt Personen-/Anstellungs-/Arbeitgeber-Felder mit Spec-Feldnamen zuerst', () => {
    const map = buildSemFillMap(baseRecord(), 'oliv', '2026-07-24');
    expect(feld(map, 'Name').wert).toBe('Muster');
    expect(feld(map, 'Name').kandidaten[0]).toBe('Noms');
    expect(feld(map, 'Vorname').wert).toBe('Anna');
    expect(feld(map, 'Vorname').kandidaten[0]).toBe('Prénoms');
    expect(feld(map, 'Geburtsdatum').wert).toBe('12.03.1995');
    expect(feld(map, 'ZEMIS-/SYMIC-Nr.').wert).toBe('12345678');
    expect(feld(map, 'ZEMIS-/SYMIC-Nr.').kandidaten[0]).toBe('NrSymic');
    expect(feld(map, 'PLZ/Ort').wert).toBe('3000 Bern');
    expect(feld(map, 'E-Mail').kandidaten[0]).toBe('Courriel1');
    expect(feld(map, 'Stellenantritt').wert).toBe('01.08.2026');
    expect(feld(map, 'Stellenantritt').kandidaten[0]).toBe('DtStartTaetigkeit');
    expect(feld(map, 'Funktion/Tätigkeit').kandidaten[0]).toBe('ActiviteExercee');
    expect(feld(map, 'Branche').wert).toBe('Gastronomie');
    expect(feld(map, 'Beschäftigungsgrad').wert).toBe('100 %');
    expect(feld(map, 'Beschäftigungsgrad').kandidaten[0]).toBe('Beschaeftigunsgrad');
    expect(feld(map, 'Bruttolohn').wert).toBe('4’471.00');
    expect(feld(map, 'Stunden').wert).toBe('42');
    expect(feld(map, 'Minuten').wert).toBe('0');
    expect(feld(map, 'Kanton').wert).toBe('Bern');
    expect(feld(map, 'Firmenname').wert).toBe('Oliv Gastro AG');
    expect(feld(map, 'Firmenname').kandidaten[0]).toBe('NomB');
    expect(feld(map, 'UID/IDE').kandidaten[0]).toBe('NuméroIDEB');
    expect(feld(map, 'Kontaktperson').wert).toBe('Berat Osmani');
    expect(feld(map, 'Kontaktperson').kandidaten[0]).toBe('Nom2');
    expect(feld(map, 'Telefon Kontakt').wert).toBe('076 398 67 47');
    expect(feld(map, 'Ort (Unterschrift)').wert).toBe('Bern');
    expect(feld(map, 'Datum (Unterschrift)').wert).toBe('24.07.2026');
  });

  it('Radios: Geschlecht aus Anrede, GAV=Ja, Lohnart ML, Start unselbständig; Checkbox Start=an', () => {
    const map = buildSemFillMap(baseRecord(), 'oliv');
    const radio = (label: string) => map.radios.find(r => r.label.includes(label))!;
    expect(radio('Group3').aktiv).toBe(true);
    expect(radio('Group3').optionKandidaten).toContain('Weiblich');
    expect(radio('Group4').optionKandidaten[0]).toBe('Ja');
    expect(radio('Group5').optionKandidaten[0]).toBe('monatlich (13 Monatslöhne)');
    expect(radio('GroupStartTaetigkeit').optionKandidaten[0]).toBe('Unselbstaedige');
    expect(map.checkboxen[0]).toMatchObject({ an: true, kandidaten: ['ChkBxStartTaetigkeit'] });
  });

  it('meldet fehlende Angaben sichtbar statt Werte zu erfinden (Oliv: UID fehlt)', () => {
    const map = buildSemFillMap(baseRecord(), 'oliv');
    expect(map.fehlend).toContain('UID/IDE (betriebs-config)');
    expect(feld(map, 'UID/IDE').wert).toBe('');
  });

  it('leerer Datensatz: Angaben in fehlend, Felder leer, Geschlecht-Radio inaktiv', () => {
    const map = buildSemFillMap(
      baseRecord({ maDaten: {}, funktion: undefined, eintritt: undefined, lohnBerechnet: undefined, pensumProzent: undefined }),
      'oliv',
    );
    expect(map.fehlend).toEqual(expect.arrayContaining([
      'Name', 'Vorname', 'Geburtsdatum', 'ZEMIS-/SYMIC-Nr.', 'Stellenantritt',
      'Funktion/Tätigkeit', 'Pensum', 'Bruttolohn (Basislohn)', 'Geschlecht (Anrede)',
    ]));
    expect(feld(map, 'Name').wert).toBe('');
    expect(map.radios.find(r => r.label.includes('Group3'))!.aktiv).toBe(false);
  });

  it('Stundenlohn (SL): Pensum «variabel», Lohnart Stundenlohn, keine Wochenstunden', () => {
    const map = buildSemFillMap(
      baseRecord({ vertragstyp: 'SL', pensumProzent: undefined, lohnBerechnet: 28.31, lohnEinheit: 'stunde' }),
      'oliv',
    );
    expect(feld(map, 'Beschäftigungsgrad').wert).toBe('variabel (Stundenlohn)');
    expect(feld(map, 'Bruttolohn').wert).toBe('28.31');
    expect(feld(map, 'Stunden').wert).toBe('');
    expect(map.radios.find(r => r.label.includes('Group5'))!.optionKandidaten[0]).toBe('Stundenlohn');
    expect(map.fehlend).not.toContain('Pensum');
  });

  it('Betreff, Empfänger (Kanton Bern) und Dateiname', () => {
    const map = buildSemFillMap(baseRecord(), 'oliv');
    expect(map.betreff).toBe('Meldung Erwerbstätigkeit – Anna Muster – Oliv Restaurant & Bar');
    expect(map.empfaengerEmail).toBe('meldeverfahren.midi@be.ch');
    expect(map.dateiname).toBe('SEM_Meldung_Anna_Muster.pdf');
  });

  it('Beaulieu ohne juristische Daten: Firmenname/Adresse/UID als fehlend gemeldet', () => {
    const map = buildSemFillMap(baseRecord({ restaurantId: 'beaulieu' }), 'beaulieu');
    expect(map.fehlend).toEqual(expect.arrayContaining([
      'Firmenname (betriebs-config)', 'Strasse Arbeitgeber (betriebs-config)',
      'PLZ/Ort Arbeitgeber (betriebs-config)', 'UID/IDE (betriebs-config)',
    ]));
    expect(map.betreff).toContain('Restaurant Beaulieu');
  });
});

describe('wochenstundenFuerSem', () => {
  it('ML: aus vertrag.wochenstunden inkl. Minuten-Rest', () => {
    expect(wochenstundenFuerSem(baseRecord({ maDaten: { vertrag: { wochenstunden: 42.5 } } })))
      .toEqual({ stunden: 42, minuten: 30 });
  });
  it('ML ohne Angabe: 42 h × Pensum', () => {
    expect(wochenstundenFuerSem(baseRecord({ pensumProzent: 50 }))).toEqual({ stunden: 21, minuten: 0 });
  });
  it('SL: null (variabel)', () => {
    expect(wochenstundenFuerSem(baseRecord({ vertragstyp: 'SL' }))).toBeNull();
  });
});
