// @vitest-environment node
/**
 * Test: Foratable Reservationen — Parser
 * =======================================
 * Deckt ab:
 *   - UTF-8 BOM am Dateianfang
 *   - in Anführungszeichen eingeschlossene Felder mit eingebettetem Semikolon
 *   - Header-Mapping unabhängig von der Spaltenreihenfolge
 *   - dd.MM.yyyy / HH:mm / "reserviert am"-Datumzeit-Parsing
 *   - Status-Normalisierung (completed/cancelled/noshow/confirmed/pending/unknown)
 *   - Gast-Identität: E-Mail → Mobile → Name + kanonischer match_key
 *   - Zeilen ohne Res.Nr. werden übersprungen, fehlerhafte Daten gemeldet
 *   - Vorschau-Statistik (Zeitraum, Personen, Status, Top-Zeiten, Räume/Bereiche)
 */
import { describe, it, expect } from 'vitest';
import {
  parseReservationsCsv,
  normalizeStatus,
  normalizeEmail,
  normalizeMobile,
  normalizeName,
  buildMatchKey,
  parseGermanDate,
  parseTime,
  parseReservedAt,
} from '@/lib/reservation-import-parser';

const HEADER =
  'Restaurant;Res.Nr.;Personen;Zeit;Datum;Firma;Vorname;Nachname;Mobile;E-Mail;Status;"reserviert am";Kommentar;Notiz;Tisch;Auswahl;Gästeinformationen;Raum;Bereich';

function row(parts: Partial<Record<string, string>>): string {
  const cols = [
    parts.restaurant ?? 'Oliv',
    parts.resnr ?? '',
    parts.personen ?? '',
    parts.zeit ?? '',
    parts.datum ?? '',
    parts.firma ?? '',
    parts.vorname ?? '',
    parts.nachname ?? '',
    parts.mobile ?? '',
    parts.email ?? '',
    parts.status ?? '',
    parts.reserviertAm ?? '',
    parts.kommentar ?? '',
    parts.notiz ?? '',
    parts.tisch ?? '',
    parts.auswahl ?? '',
    parts.gaeste ?? '',
    parts.raum ?? '',
    parts.bereich ?? '',
  ];
  return cols.join(';');
}

describe('Reservationen Parser — Feldnormalisierung', () => {
  it('normalisiert Status-Varianten', () => {
    expect(normalizeStatus('Abgeschlossen')).toBe('completed');
    expect(normalizeStatus('eingecheckt')).toBe('completed');
    expect(normalizeStatus('Storniert')).toBe('cancelled');
    expect(normalizeStatus('abgesagt')).toBe('cancelled');
    expect(normalizeStatus('Abgelehnt')).toBe('cancelled');
    expect(normalizeStatus('No-Show')).toBe('noshow');
    expect(normalizeStatus('nicht erschienen')).toBe('noshow');
    expect(normalizeStatus('Bestätigt')).toBe('confirmed');
    expect(normalizeStatus('Offen')).toBe('pending');
    expect(normalizeStatus('angefragt')).toBe('pending');
    expect(normalizeStatus('Nicht beantwortet')).toBe('pending');
    expect(normalizeStatus('')).toBe('unknown');
    expect(normalizeStatus('irgendwas Komisches')).toBe('unknown');
  });

  it('normalisiert E-Mail, Mobile und Name', () => {
    expect(normalizeEmail('  Max.Muster@Example.COM ')).toBe('max.muster@example.com');
    expect(normalizeEmail('keine-email')).toBeNull();

    expect(normalizeMobile('+41 79 123 45 67')).toBe('41791234567');
    expect(normalizeMobile('0041 79 123 45 67')).toBe('41791234567');
    expect(normalizeMobile('079-123-45-67')).toBe('0791234567');
    expect(normalizeMobile('123')).toBeNull();

    expect(normalizeName('Max', 'Müller')).toBe('max muller');
    expect(normalizeName('  ', '')).toBeNull();
  });

  it('baut match_key in Priorität E-Mail → Mobile → Name', () => {
    expect(buildMatchKey('a@b.com', '41791234567', 'max muller')).toBe('email:a@b.com');
    expect(buildMatchKey(null, '41791234567', 'max muller')).toBe('mobile:41791234567');
    expect(buildMatchKey(null, null, 'max muller')).toBe('name:max muller');
    expect(buildMatchKey(null, null, null)).toBeNull();
  });

  it('parst Datum, Zeit und reserviert-am', () => {
    expect(parseGermanDate('05.06.2026')).toBe('2026-06-05');
    expect(parseGermanDate('5.6.26')).toBe('2026-06-05');
    expect(parseGermanDate('2026-06-05')).toBe('2026-06-05');
    expect(parseGermanDate('31.02.2026')).toBeNull();
    expect(parseGermanDate('quatsch')).toBeNull();

    expect(parseTime('19:30')).toBe('19:30');
    expect(parseTime('9:05')).toBe('09:05');
    expect(parseTime('19:30:00')).toBe('19:30');
    expect(parseTime('25:00')).toBeNull();

    expect(parseReservedAt('01.05.2026 14:23')).toBe('2026-05-01T14:23:00');
    expect(parseReservedAt('01.05.2026')).toBe('2026-05-01T00:00:00');
    expect(parseReservedAt('')).toBeNull();
  });
});

describe('Reservationen Parser — CSV', () => {
  it('verarbeitet BOM, Anführungszeichen und Spalten-Mapping', () => {
    const csv = '\uFEFF' + [
      HEADER,
      row({
        resnr: '1001', personen: '4', zeit: '19:30', datum: '05.06.2026',
        vorname: 'Max', nachname: 'Müller', mobile: '+41 79 123 45 67',
        email: 'max@example.com', status: 'Abgeschlossen',
        reserviertAm: '01.06.2026 10:15', raum: 'Gartensaal', bereich: 'EG',
        kommentar: '"Tisch am Fenster; bitte ruhig"',
      }),
    ].join('\n');

    const r = parseReservationsCsv('Foratable 05.2026.csv', csv);
    expect(r.headerOk).toBe(true);
    expect(r.reservations).toHaveLength(1);

    const res = r.reservations[0];
    expect(res.externalReservationId).toBe('1001');
    expect(res.partySize).toBe(4);
    expect(res.reservationTime).toBe('19:30');
    expect(res.reservationDate).toBe('2026-06-05');
    expect(res.firstName).toBe('Max');
    expect(res.lastName).toBe('Müller');
    expect(res.statusNormalized).toBe('completed');
    expect(res.reservedAt).toBe('2026-06-01T10:15:00');
    expect(res.room).toBe('Gartensaal');
    expect(res.area).toBe('EG');
    // eingebettetes Semikolon im quotierten Feld bleibt erhalten
    expect(res.comment).toBe('Tisch am Fenster; bitte ruhig');
    // match_key bevorzugt E-Mail
    expect(res.matchKey).toBe('email:max@example.com');
    expect(res.normalizedMobile).toBe('41791234567');
  });

  it('mappt Spalten unabhängig von der Reihenfolge', () => {
    const csv = [
      'Res.Nr.;Datum;Personen;E-Mail;Status',
      '2002;06.06.2026;2;anna@example.com;Storniert',
    ].join('\n');
    const r = parseReservationsCsv('x.csv', csv);
    expect(r.headerOk).toBe(true);
    expect(r.reservations[0].externalReservationId).toBe('2002');
    expect(r.reservations[0].partySize).toBe(2);
    expect(r.reservations[0].statusNormalized).toBe('cancelled');
  });

  it('überspringt Zeilen ohne Res.Nr. und meldet ungültige Daten', () => {
    const csv = [
      HEADER,
      row({ resnr: '', vorname: 'Ohne', nachname: 'Nummer' }),
      row({ resnr: '3003', datum: '99.99.9999', email: 'a@b.com' }),
    ].join('\n');
    const r = parseReservationsCsv('x.csv', csv);
    expect(r.reservations).toHaveLength(1);
    expect(r.reservations[0].externalReservationId).toBe('3003');
    expect(r.reservations[0].reservationDate).toBeNull();
    // ein Fehler für übersprungene Zeile + ein Fehler für ungültiges Datum
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('erkennt fehlenden Foratable-Header', () => {
    const csv = ['Spalte A;Spalte B', 'x;y'].join('\n');
    const r = parseReservationsCsv('x.csv', csv);
    expect(r.headerOk).toBe(false);
    expect(r.reservations).toHaveLength(0);
  });

  it('berechnet Vorschau-Statistik korrekt', () => {
    const csv = [
      HEADER,
      row({ resnr: '1', personen: '4', zeit: '19:00', datum: '01.06.2026', email: 'a@x.com', status: 'Abgeschlossen', raum: 'Saal', bereich: 'EG' }),
      row({ resnr: '2', personen: '2', zeit: '19:00', datum: '02.06.2026', email: 'b@x.com', status: 'Storniert', raum: 'Saal', bereich: 'EG' }),
      row({ resnr: '3', personen: '6', zeit: '20:00', datum: '03.06.2026', mobile: '+41 79 000 00 00', status: 'No-Show', raum: 'Terrasse', bereich: 'Aussen' }),
      row({ resnr: '4', personen: '3', zeit: '19:00', datum: '01.06.2026', status: 'Komisch' }),
    ].join('\n');
    const r = parseReservationsCsv('x.csv', csv);
    const s = r.stats;

    expect(s.reservationCount).toBe(4);
    expect(s.totalPersons).toBe(15);
    expect(s.periodFrom).toBe('2026-06-01');
    expect(s.periodTo).toBe('2026-06-03');
    expect(s.completedCount).toBe(1);
    expect(s.cancelledCount).toBe(1);
    expect(s.noshowCount).toBe(1);
    expect(s.unknownStatusCount).toBe(1);
    expect(s.topTimes[0].time).toBe('19:00');
    expect(s.topTimes[0].count).toBe(3);
    expect(s.avgPartySize).toBeCloseTo(15 / 4, 5);
    // Res. 4 hat keine Gast-Kennung
    expect(s.reservationsWithoutGuestKey).toBe(1);
    expect(s.distinctGuestKeys).toHaveLength(3);
    expect(s.rooms.find(x => x.name === 'Saal')?.count).toBe(2);
    expect(s.areas.find(x => x.name === 'EG')?.count).toBe(2);
  });

  it('produziert stabile Checksumme für identischen Inhalt', () => {
    const csv = [HEADER, row({ resnr: '1', email: 'a@b.com' })].join('\n');
    const a = parseReservationsCsv('f.csv', csv);
    const b = parseReservationsCsv('f.csv', '\uFEFF' + csv); // BOM darf Checksumme nicht ändern
    expect(a.checksum).toBe(b.checksum);
  });
});
