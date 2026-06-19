// @vitest-environment node
/**
 * Test: Foratable Reservationen — REAL-FILE-Validierung
 * =====================================================
 * Validiert den Parser gegen den ECHTEN Foratable-Export (Mai 2026), der als
 * Fixture im Projekt liegt:  `fixtures/foratable-05-2026.csv`
 *
 * Zweck: Spätere Änderungen am Parser werden automatisch gegen die reale
 * Exportdatei getestet (nicht nur gegen synthetische Fixtures). Die hier
 * geprüften Zahlen stammen 1:1 aus der echten Datei und ändern sich nur, wenn
 * sich die Fixture selbst ändert.
 *
 * Erkannte Spalten (19, Header 1:1 aus dem Export):
 *   Restaurant; Res.Nr.; Personen; Zeit; Datum; Firma; Vorname; Nachname;
 *   Mobile; E-Mail; Status; "reserviert am"; Kommentar; Notiz; Tisch; Auswahl;
 *   Gästeinformationen; Raum; Bereich
 *
 * Besonderheiten der echten Datei, die hier mit abgedeckt werden:
 *   - UTF-8 BOM am Dateianfang
 *   - in Anführungszeichen eingeschlossene Felder mit eingebetteten Semikolons
 *     UND eingebetteten Zeilenumbrüchen (mehrzeilige Adresse in Gästeinfo)
 *   - Status-Rohwerte: Abgeschlossen / Storniert / No-show / Abgelehnt /
 *     "Nicht beantwortet"  →  completed / cancelled / noshow / cancelled / pending
 *   - Gast-Erkennung E-Mail → Mobile → Name; wiederkehrende Gäste innerhalb der Datei
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseReservationsCsv } from '@/lib/reservation-import-parser';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'foratable-05-2026.csv',
);

const raw = readFileSync(FIXTURE, 'utf8');
const result = parseReservationsCsv('foratable-05-2026.csv', raw);
const s = result.stats;

describe('Foratable Real-File — Parsing & Header', () => {
  it('erkennt alle erwarteten Spalten ohne Fehlmeldung', () => {
    expect(result.headerOk).toBe(true);
    expect(result.headerMissing).toEqual([]);
  });

  it('parst die gesamte Datei fehlerfrei (inkl. mehrzeiliger, gequoteter Felder)', () => {
    expect(result.errors).toEqual([]);
  });

  it('liefert einen stabilen Datei-Checksum', () => {
    expect(result.checksum).toBe(parseReservationsCsv('x', raw).checksum);
  });
});

describe('Foratable Real-File — Vorschau-Statistik', () => {
  it('zählt Reservationen und Personen korrekt', () => {
    expect(s.reservationCount).toBe(789);
    expect(s.totalPersons).toBe(3753);
  });

  it('erkennt den Zeitraum (Mai 2026)', () => {
    expect(s.periodFrom).toBe('2026-05-01');
    expect(s.periodTo).toBe('2026-05-31');
  });

  it('berechnet die durchschnittliche Gruppengrösse', () => {
    expect(s.avgPartySize).toBeCloseTo(3753 / 789, 4);
  });

  it('zählt die Status-Kategorien korrekt', () => {
    expect(s.completedCount).toBe(713);
    expect(s.cancelledCount).toBe(65); // 62 Storniert + 3 Abgelehnt
    expect(s.noshowCount).toBe(9);
    expect(s.unknownStatusCount).toBe(0);
  });

  it('listet die Top-Reservationszeit (19:00 Uhr)', () => {
    expect(s.topTimes[0]).toEqual({ time: '19:00', count: 107, persons: 534 });
  });

  it('aggregiert Räume und Bereiche', () => {
    expect(s.rooms).toEqual([
      { name: 'Restaurant & Bar', count: 575 },
      { name: 'Terrasse', count: 147 },
      { name: 'Bar', count: 67 },
    ]);
    expect(s.areas).toEqual([
      { name: 'Restaurant', count: 448 },
      { name: 'Terrasse', count: 131 },
      { name: 'Bar', count: 60 },
    ]);
  });
});

describe('Foratable Real-File — Status-Verteilung', () => {
  it('bildet jeden Status-Rohwert auf die korrekte Normalisierung ab', () => {
    const byRaw = new Map(s.statusDistribution.map(d => [d.status, d]));
    expect(byRaw.get('Abgeschlossen')).toMatchObject({ normalized: 'completed', count: 713 });
    expect(byRaw.get('Storniert')).toMatchObject({ normalized: 'cancelled', count: 62 });
    expect(byRaw.get('No-show')).toMatchObject({ normalized: 'noshow', count: 9 });
    expect(byRaw.get('Abgelehnt')).toMatchObject({ normalized: 'cancelled', count: 3 });
    expect(byRaw.get('Nicht beantwortet')).toMatchObject({ normalized: 'pending', count: 2 });
    // Summe aller Status-Rohwerte == Gesamtzahl Reservationen
    const sum = s.statusDistribution.reduce((a, d) => a + d.count, 0);
    expect(sum).toBe(789);
  });
});

describe('Foratable Real-File — Gast-Erkennung & Dedup', () => {
  it('löst für jede Reservation eine Gast-Identität auf', () => {
    expect(s.reservationsWithoutGuestKey).toBe(0);
    expect(s.distinctGuestKeys.length).toBe(756);
  });

  it('priorisiert die Identitätsquelle E-Mail → Mobile → Name', () => {
    const bySrc = { email: 0, mobile: 0, name: 0, none: 0 };
    for (const r of result.reservations) {
      if (!r.matchKey) bySrc.none++;
      else if (r.matchKey.startsWith('email:')) bySrc.email++;
      else if (r.matchKey.startsWith('mobile:')) bySrc.mobile++;
      else if (r.matchKey.startsWith('name:')) bySrc.name++;
    }
    expect(bySrc).toEqual({ email: 573, mobile: 165, name: 51, none: 0 });
  });

  it('erkennt wiederkehrende Gäste innerhalb der Datei', () => {
    const byKey = new Map<string, number>();
    for (const r of result.reservations) {
      if (r.matchKey) byKey.set(r.matchKey, (byKey.get(r.matchKey) ?? 0) + 1);
    }
    const returning = [...byKey.values()].filter(c => c > 1);
    expect(returning.length).toBe(27);
    // konkreter Wiederkehrer: gleiche E-Mail, zwei Reservationen
    expect(byKey.get('email:meyerce@gmx.ch')).toBe(2);
  });

  it('enthält keine doppelten Res.Nr. (Dedup-Schlüssel ist eindeutig)', () => {
    const ids = result.reservations.map(r => r.externalReservationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(789);
  });
});

describe('Foratable Real-File — Einzelsatz-Parsing', () => {
  it('parst einen bekannten Datensatz (Res.Nr. 24326) vollständig korrekt', () => {
    const r = result.reservations.find(x => x.externalReservationId === '24326');
    expect(r).toBeDefined();
    expect(r).toMatchObject({
      restaurantName: 'Oliv Restaurant & Bar',
      reservationDate: '2026-05-31',
      reservationTime: '20:30',
      partySize: 1,
      statusNormalized: 'completed',
      reservedAt: '2026-05-31T16:02:00',
      normalizedEmail: 'mattia.corazzolla@outlook.it',
      normalizedName: 'mattia corazzolla',
      room: 'Restaurant & Bar',
      area: 'Restaurant',
      matchKey: 'email:mattia.corazzolla@outlook.it',
    });
  });

  it('nutzt ein einziges Restaurant (Oliv Restaurant & Bar)', () => {
    const names = new Set(result.reservations.map(r => r.restaurantName));
    expect([...names]).toEqual(['Oliv Restaurant & Bar']);
  });
});
