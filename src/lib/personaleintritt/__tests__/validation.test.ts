// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isValidAhv, formatAhv, isValidIban, formatIban, isValidIsoDate, pruefePflichtfelder } from '../validation';
import type { MaDaten } from '../types';

describe('AHV-Nummer', () => {
  it('akzeptiert gültige Nummern (mit und ohne Punkte)', () => {
    // 756.9217.0769.85 ist die offizielle Beispielnummer des BSV.
    expect(isValidAhv('756.9217.0769.85')).toBe(true);
    expect(isValidAhv('7569217076985')).toBe(true);
  });
  it('lehnt falsche Prüfziffer / falschen Präfix / falsche Länge ab', () => {
    expect(isValidAhv('756.9217.0769.84')).toBe(false);
    expect(isValidAhv('757.9217.0769.85')).toBe(false);
    expect(isValidAhv('756.9217.0769')).toBe(false);
    expect(isValidAhv('')).toBe(false);
  });
  it('formatiert 13 Ziffern mit Punkten', () => {
    expect(formatAhv('7569217076985')).toBe('756.9217.0769.85');
    expect(formatAhv('756')).toBe('756');
  });
});

describe('IBAN', () => {
  it('akzeptiert gültige CH-IBAN (Beispiel SIX)', () => {
    expect(isValidIban('CH93 0076 2011 6238 5295 7')).toBe(true);
    expect(isValidIban('ch9300762011623852957')).toBe(true);
  });
  it('lehnt falsche Prüfsumme / Länge ab', () => {
    expect(isValidIban('CH93 0076 2011 6238 5295 8')).toBe(false);
    expect(isValidIban('CH93 0076 2011 6238 5295')).toBe(false);
    expect(isValidIban('')).toBe(false);
  });
  it('formatiert in 4er-Gruppen', () => {
    expect(formatIban('CH9300762011623852957')).toBe('CH93 0076 2011 6238 5295 7');
  });
});

describe('isValidIsoDate', () => {
  it('akzeptiert echte Kalendertage', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });
  it('lehnt unechte Tage und andere Formate ab', () => {
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('01.09.2026')).toBe(false);
  });
});

describe('pruefePflichtfelder', () => {
  const voll: MaDaten = {
    personalien: {
      anrede: 'Frau', name: 'Muster', vorname: 'Anna', strasse: 'Weg 1',
      plz: '3000', ort: 'Bern', geburtsdatum: '1995-04-12',
      heimatort_nationalitaet: 'Bern BE', telefon: '079 000 00 00', email: 'a@b.ch',
    },
    vertrag: { wochenstunden: 42, ferientage: 35 },
    lohnprogramm: {
      zivilstand: 'ledig', ahv_nr: '756.9217.0769.85',
      iban: 'CH93 0076 2011 6238 5295 7', ausweisart: 'ID', ausweis_nr: 'X123',
      aufenthaltsbewilligung: 'CH',
    },
    dokumente: { ahv_karte: 'p/1', ausweis_vorne: 'p/2', ausweis_hinten: 'p/3' },
  };

  it('vollständig ⇒ keine Fehler (ML)', () => {
    expect(pruefePflichtfelder(voll, 'ML')).toEqual([]);
  });

  it('SL: Wochenstunden NICHT Pflicht', () => {
    const ohneStunden: MaDaten = { ...voll, vertrag: {} };
    expect(pruefePflichtfelder(ohneStunden, 'SL')).toEqual([]);
    expect(pruefePflichtfelder(ohneStunden, 'ML').map(f => f.feld)).toContain('vertrag.wochenstunden');
  });

  it('meldet fehlende Personalien und Pflicht-Dokumente', () => {
    const fehler = pruefePflichtfelder({}, 'SL').map(f => f.feld);
    expect(fehler).toContain('personalien.name');
    expect(fehler).toContain('lohnprogramm.ahv_nr');
    expect(fehler).toContain('dokumente.ahv_karte');
    expect(fehler).toContain('dokumente.ausweis_vorne');
    expect(fehler).not.toContain('dokumente.foto'); // optional
  });

  it('ungültige AHV/IBAN werden gemeldet', () => {
    const kaputt: MaDaten = {
      ...voll,
      lohnprogramm: { ...voll.lohnprogramm!, ahv_nr: '756.0000.0000.00', iban: 'CH00 1111' },
    };
    const felder = pruefePflichtfelder(kaputt, 'ML').map(f => f.feld);
    expect(felder).toContain('lohnprogramm.ahv_nr');
    expect(felder).toContain('lohnprogramm.iban');
  });

  it('verheiratet ⇒ Ehepartner-Name Pflicht; Kinder brauchen Name + Geburtsdatum', () => {
    const verh: MaDaten = {
      ...voll,
      lohnprogramm: {
        ...voll.lohnprogramm!,
        zivilstand: 'verheiratet',
        kinder: [{ name: '', geburtsdatum: '2020-13-01' }],
      },
    };
    const felder = pruefePflichtfelder(verh, 'ML').map(f => f.feld);
    expect(felder).toContain('lohnprogramm.ehepartner.name');
    expect(felder).toContain('lohnprogramm.kinder.0.name');
    expect(felder).toContain('lohnprogramm.kinder.0.geburtsdatum');
  });
});
