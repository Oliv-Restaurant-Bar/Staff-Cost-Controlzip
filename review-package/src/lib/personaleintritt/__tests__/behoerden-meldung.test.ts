// @vitest-environment node
/**
 * Tests: Arbeitsbewilligung (Anpassung 5) — reine Logik.
 * Kontrollfrage/Ausweis-Ableitung, Gesuchstext (fehlend ≠ erfunden).
 */
import { describe, it, expect } from 'vitest';

import {
  bewilligungErforderlichEffektiv,
  buildBehoerdenGesuch,
  istBewilligungspflichtigerAusweis,
} from '../behoerden-meldung';
import type { PersonaleintrittRecord } from '../types';

function baseRecord(overrides: Partial<PersonaleintrittRecord> = {}): PersonaleintrittRecord {
  return {
    id: 'test-1',
    restaurantId: 'oliv',
    status: 'geprueft',
    vertragstyp: 'ML',
    betrieb: 'Oliv Restaurant & Bar',
    funktion: 'Koch',
    eintritt: '2026-09-01',
    pensumProzent: 100,
    lohnBerechnet: 4600,
    lohnEinheit: 'monat',
    maDaten: {
      personalien: {
        anrede: 'Herr', name: 'Muster', vorname: 'Max',
        strasse: 'Teststrasse 1', plz: '3000', ort: 'Bern',
        geburtsdatum: '1995-04-10', heimatort_nationalitaet: 'Syrien',
      },
      lohnprogramm: { aufenthaltsbewilligung: 'S', kinder: [] },
      vertrag: {},
    },
    ...overrides,
  };
}

describe('istBewilligungspflichtigerAusweis', () => {
  it('S und F (auch mit Zusatztext) ⇒ true', () => {
    expect(istBewilligungspflichtigerAusweis('S')).toBe(true);
    expect(istBewilligungspflichtigerAusweis('f')).toBe(true);
    expect(istBewilligungspflichtigerAusweis('F (vorläufig aufgenommen)')).toBe(true);
    expect(istBewilligungspflichtigerAusweis('S - Schutzstatus')).toBe(true);
  });
  it('CH/C/B/L/G, leere Werte und Nicht-Präfixe ⇒ false', () => {
    for (const w of ['CH (Schweizer/in)', 'C', 'B', 'L', 'G', '', undefined, null, 'Familiennachzug']) {
      expect(istBewilligungspflichtigerAusweis(w)).toBe(false);
    }
  });
});

describe('bewilligungErforderlichEffektiv', () => {
  it('GF-Kontrollfrage Ja ⇒ true (unabhängig vom Ausweis)', () => {
    expect(bewilligungErforderlichEffektiv({ bewilligungErforderlich: true, maDaten: undefined })).toBe(true);
  });
  it('Phase-2-Ausweis S/F ⇒ true, sonst false', () => {
    expect(bewilligungErforderlichEffektiv(baseRecord())).toBe(true);
    const ohne = baseRecord();
    ohne.maDaten!.lohnprogramm!.aufenthaltsbewilligung = 'C';
    expect(bewilligungErforderlichEffektiv(ohne)).toBe(false);
  });
});

describe('buildBehoerdenGesuch', () => {
  it('füllt vorhandene Daten und meldet nichts als fehlend', () => {
    const g = buildBehoerdenGesuch(baseRecord(), '2026-07-24');
    expect(g.fehlend).toEqual([]);
    expect(g.text).toContain('Max Muster');
    expect(g.text).toContain('10.04.1995');
    expect(g.text).toContain('Ausweis (Aufenthalt):     S');
    expect(g.text).toContain('Pensum:         100 %');
    expect(g.text).toContain('Datum: 24.07.2026');
    expect(g.text).not.toContain('(fehlt)');
    expect(g.dateiname).toBe('Behoerden_Gesuch_Max_Muster.txt');
  });
  it('fehlende Angaben ⇒ «(fehlt)»-Marker + Liste, nie erfundene Werte', () => {
    const r = baseRecord({ lohnBerechnet: undefined, pensumProzent: undefined });
    r.maDaten!.personalien!.geburtsdatum = undefined;
    const g = buildBehoerdenGesuch(r, '2026-07-24');
    expect(g.fehlend).toContain('Geburtsdatum');
    expect(g.fehlend).toContain('Pensum');
    expect(g.fehlend).toContain('Lohn');
    expect(g.text).toContain('FEHLENDE ANGABEN');
    expect(g.text).toContain('(fehlt)');
  });
  it('SL: Pensum variabel statt fehlend', () => {
    const g = buildBehoerdenGesuch(baseRecord({ vertragstyp: 'SL', pensumProzent: undefined, lohnBerechnet: 20.65, lohnEinheit: 'stunde' }), '2026-07-24');
    expect(g.fehlend).not.toContain('Pensum');
    expect(g.text).toContain('Stundenlohn (Pensum variabel)');
    expect(g.text).toContain('CHF 20.65 / Stunde');
  });
});
