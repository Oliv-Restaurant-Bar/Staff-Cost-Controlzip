// @vitest-environment node
/**
 * Tests für den Foratable-Gästeexport-Parser.
 * Synthetische Daten, keine echten Gästedaten (Datenschutz).
 */
import { describe, it, expect } from 'vitest';
import {
  parseForatableGuestsCsv, isPositiveToken, strictNameKey,
} from '../foratable-guest-import-parser';

const HEADER =
  'Titel;Firma;Vorname;Name;Geburtsdatum;Telefonnummer;E-Mail;Reservationen;' +
  '"Letzte Reservation";avg;Gästeinfo;VIP;Sitzplatz;Speisen;Blacklist;Newsletter;Strasse;PLZ;Ort;Labels';

/** Baut eine synthetische CSV (mit BOM) aus Datenzeilen. */
function csv(lines: string[]): string {
  return '\uFEFF' + [HEADER, ...lines].join('\n');
}

describe('isPositiveToken', () => {
  it('erkennt VIP-Token, Ja, 1 als positiv', () => {
    expect(isPositiveToken('VIP')).toBe(true);
    expect(isPositiveToken('Ja')).toBe(true);
    expect(isPositiveToken('ja')).toBe(true);
    expect(isPositiveToken('1')).toBe(true);
    expect(isPositiveToken('x')).toBe(true);
  });
  it('behandelt Nein/leer/unbekannt als nicht positiv', () => {
    expect(isPositiveToken('Nein')).toBe(false);
    expect(isPositiveToken('')).toBe(false);
    expect(isPositiveToken(null)).toBe(false);
    expect(isPositiveToken(undefined)).toBe(false);
    expect(isPositiveToken('vielleicht')).toBe(false);
  });
});

describe('strictNameKey', () => {
  it('liefert nur bei Vor- UND Nachname einen Schlüssel', () => {
    expect(strictNameKey('Anna', 'Beispiel')).toBe('anna beispiel');
    expect(strictNameKey('Änna', 'Bëispiel')).toBe('anna beispiel'); // Diakritika entfernt
    expect(strictNameKey('Anna', null)).toBeNull();
    expect(strictNameKey(null, 'Beispiel')).toBeNull();
    expect(strictNameKey('', '')).toBeNull();
  });
});

describe('parseForatableGuestsCsv', () => {
  it('parst Header, Booleans, Geburtsdatum und Notizen', () => {
    const res = parseForatableGuestsCsv('gaeste.csv', csv([
      // Titel;Firma;Vorname;Name;Geburtsdatum;Telefon;E-Mail;Res;Letzte;avg;Gästeinfo;VIP;Sitzplatz;Speisen;Blacklist;Newsletter;Strasse;PLZ;Ort;Labels
      'Herr;Muster AG;Max;Testmann;15.03.1980;+41 79 111 22 33;max@example.test;5;01.01.2026;2;"mag Fenster; ruhig";VIP;Tisch 4;;Nein;Ja;;;;Stammtisch',
      ';;;Nurnachname;;044 222 33 44;;3;;1;;;;;Ja;Nein;;;;',
    ]));
    expect(res.headerOk).toBe(true);
    expect(res.rows).toHaveLength(2);

    const r0 = res.rows[0];
    expect(r0.company).toBe('Muster AG');
    expect(r0.firstName).toBe('Max');
    expect(r0.lastName).toBe('Testmann');
    expect(r0.birthday).toBe('1980-03-15');
    expect(r0.vip).toBe(true);
    expect(r0.newsletter).toBe(true);
    expect(r0.blacklist).toBe(false);
    expect(r0.favoriteTable).toBe('Tisch 4');
    expect(r0.guestInfo).toBe('mag Fenster; ruhig'); // eingebettetes Semikolon bleibt erhalten
    expect(r0.normEmail).toBe('max@example.test');
    expect(r0.normMobile).toBe('41791112233');
    expect(r0.normName).toBe('max testmann');
    expect(r0.matchTier).toBe('email');

    const r1 = res.rows[1];
    expect(r1.normEmail).toBeNull();
    expect(r1.normMobile).toBe('0442223344');
    expect(r1.normName).toBeNull();   // nur Nachname → kein Namensschlüssel
    expect(r1.matchTier).toBe('mobile');
    expect(r1.blacklist).toBe(true);
    expect(r1.newsletter).toBe(false);
  });

  it('aggregiert nur Zahlen in den Statistiken', () => {
    const res = parseForatableGuestsCsv('g.csv', csv([
      'Herr;;Max;Testmann;;;max@example.test;;;;;VIP;;;Nein;Ja;;;;',
      'Frau;;Eva;Beispiel;;079 000 11 22;;;;;Notiz;;;;Ja;Nein;;;;',
      ';;;;;;;;;;;;;;;;;;;',  // leere Zeile → wird übersprungen
    ]));
    expect(res.stats.rowCount).toBe(2);
    expect(res.stats.withEmail).toBe(1);
    expect(res.stats.withPhone).toBe(1);
    expect(res.stats.withName).toBe(2);
    expect(res.stats.withAnyKey).toBe(2);
    expect(res.stats.withoutKey).toBe(0);
    expect(res.stats.vipCount).toBe(1);
    expect(res.stats.newsletterCount).toBe(1);
    expect(res.stats.blacklistCount).toBe(1);
    expect(res.stats.withNotes).toBe(1);
  });

  it('lehnt eine nicht erkannte Kopfzeile ab', () => {
    const res = parseForatableGuestsCsv('x.csv', 'foo;bar;baz\n1;2;3');
    expect(res.headerOk).toBe(false);
    expect(res.rows).toHaveLength(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
