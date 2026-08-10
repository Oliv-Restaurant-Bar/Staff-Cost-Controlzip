// @vitest-environment happy-dom
/**
 * Selbstkontrolle Reservationen-Import — Monats-Aggregation aus Datei-Zeilen.
 * Prüft: zentrale Zählregel (nur gezählte Status), Gruppen-Schwelle,
 * Res.Nr.-Dedup (letzte Zeile gewinnt), leer statt 0, Monats-Zuordnung.
 */
import { describe, it, expect } from 'vitest';
import { monatsAggregateAusDatei, abweichendeMonate } from '@/lib/reservation-import-selfcheck';
import type { DbResRow } from '@/lib/reservation-import-selfcheck';
import { DEFAULT_RESERVATION_COUNTING } from '@/lib/reservation-cockpit-settings';
import type { ParsedReservation, ReservationStatusNormalized } from '@/lib/reservation-import-parser';

function row(
  id: string, date: string | null, pax: number | null,
  status: ReservationStatusNormalized,
): ParsedReservation {
  return {
    restaurantName: 'Oliv', externalReservationId: id, partySize: pax,
    reservationTime: null, reservationDate: date, company: '', firstName: '',
    lastName: '', mobile: '', email: '', statusRaw: status,
    statusNormalized: status, reservedAt: null, comment: '', note: '',
    tableName: '', selection: '', guestInformation: '', room: '', area: '',
    normalizedEmail: null, normalizedMobile: null, normalizedName: null,
    matchKey: null, rowNumber: 1,
  };
}

const S = DEFAULT_RESERVATION_COUNTING; // completed+confirmed, Schwelle 20

describe('monatsAggregateAusDatei', () => {
  it('zählt nur gezählte Status und summiert je Monat', () => {
    const out = monatsAggregateAusDatei([
      row('1', '2026-08-05', 4, 'completed'),
      row('2', '2026-08-06', 2, 'confirmed'),
      row('3', '2026-08-07', 10, 'cancelled'),   // zählt nicht
      row('4', '2026-08-08', 5, 'noshow'),        // zählt nicht
      row('5', '2026-08-09', 3, 'pending'),       // zählt nicht
      row('6', '2026-11-01', 25, 'completed'),    // Gruppe
    ], S);
    expect(out.map(m => m.month)).toEqual(['2026-08', '2026-11']);
    const aug = out[0];
    expect(aug.reservedGuests).toBe(6);
    expect(aug.countedReservations).toBe(2);
    expect(aug.totalReservations).toBe(5);
    expect(aug.groupCount).toBe(0);
    expect(aug.groupPersons).toBe(0);
    const nov = out[1];
    expect(nov.reservedGuests).toBe(25);
    expect(nov.groupCount).toBe(1);
    expect(nov.groupPersons).toBe(25);
  });

  it('Gruppen-Schwelle inklusiv (>= 20)', () => {
    const out = monatsAggregateAusDatei([
      row('1', '2026-08-01', 20, 'completed'),
      row('2', '2026-08-02', 19, 'completed'),
    ], S);
    expect(out[0].groupCount).toBe(1);
    expect(out[0].groupPersons).toBe(20);
    expect(out[0].reservedGuests).toBe(39);
  });

  it('dedupliziert je Res.Nr. — letzte Zeile gewinnt (Status-Update)', () => {
    const out = monatsAggregateAusDatei([
      row('77', '2026-08-10', 8, 'confirmed'),
      row('77', '2026-08-10', 8, 'cancelled'), // aktueller Status ersetzt
    ], S);
    expect(out[0].reservedGuests).toBeNull(); // keine gezählte Res. → leer statt 0
    expect(out[0].countedReservations).toBe(0);
    expect(out[0].totalReservations).toBe(1); // nie doppelt gezählt
  });

  it('Monat ohne gezählte Reservationen → null (leer statt 0)', () => {
    const out = monatsAggregateAusDatei([
      row('1', '2026-09-01', 6, 'cancelled'),
    ], S);
    expect(out[0].reservedGuests).toBeNull();
    expect(out[0].groupCount).toBeNull();
    expect(out[0].groupPersons).toBeNull();
  });

  it('Zeilen ohne Datum werden keinem Monat zugeordnet', () => {
    const out = monatsAggregateAusDatei([
      row('1', null, 4, 'completed'),
      row('2', '2026-08-01', 2, 'completed'),
    ], S);
    expect(out).toHaveLength(1);
    expect(out[0].reservedGuests).toBe(2);
  });

  it('null-Pax zählt als 0 Personen, Reservation zählt trotzdem', () => {
    const out = monatsAggregateAusDatei([
      row('1', '2026-08-01', null, 'completed'),
    ], S);
    expect(out[0].reservedGuests).toBe(0);
    expect(out[0].countedReservations).toBe(1);
  });
});

function db(extId: string, month: string | null, pax: number | null, status: string): DbResRow {
  return { extId, month, partySize: pax, status: status as DbResRow['status'] };
}

describe('abweichendeMonate — exakter Res.Nr.-Abgleich', () => {
  it('exakte Übereinstimmung → keine Abweichung', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'completed'), row('2', '2026-11-01', 25, 'confirmed')],
      [db('1', '2026-08', 4, 'completed'), db('2', '2026-11', 25, 'confirmed')],
    );
    expect(bad.size).toBe(0);
  });

  it('fehlende Res.Nr. in der DB → Monat weicht ab', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'completed')],
      [],
    );
    expect([...bad]).toEqual(['2026-08']);
  });

  it('Aggregat-Ausgleich täuscht nicht: Pax getauscht zwischen zwei Res.Nr. desselben Monats', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'completed'), row('2', '2026-08-06', 2, 'completed')],
      [db('1', '2026-08', 2, 'completed'), db('2', '2026-08', 4, 'completed')], // Summe gleich!
    );
    expect(bad.has('2026-08')).toBe(true);
  });

  it('Status-Abweichung → Monat weicht ab', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'completed')],
      [db('1', '2026-08', 4, 'cancelled')],
    );
    expect(bad.has('2026-08')).toBe(true);
  });

  it('Datum in anderem Monat → BEIDE Monate abweichend', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'completed')],
      [db('1', '2026-09', 4, 'completed')],
    );
    expect(bad.has('2026-08')).toBe(true);
    expect(bad.has('2026-09')).toBe(true);
  });

  it('Datei-Dedup: letzte Zeile je Res.Nr. ist der Vergleichsmassstab', () => {
    const bad = abweichendeMonate(
      [row('1', '2026-08-05', 4, 'confirmed'), row('1', '2026-08-05', 4, 'cancelled')],
      [db('1', '2026-08', 4, 'cancelled')], // DB trägt den letzten Stand → OK
    );
    expect(bad.size).toBe(0);
  });
});
