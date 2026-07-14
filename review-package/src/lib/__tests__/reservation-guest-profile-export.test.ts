// @vitest-environment node
/**
 * Tests für den Export der Reservierungshistorie (typisierte Zellen).
 * Synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  RESERVATION_HISTORY_HEADERS,
  reservationHistoryRowToCells,
  type ReservationHistoryExportRow,
} from '../reservation-guest-profile';

const STATUS_LABEL: Record<string, string> = {
  completed: 'Besucht',
  cancelled: 'Storniert',
  noshow: 'No-Show',
};
const label = (s: string) => STATUS_LABEL[s] ?? s;

function row(over: Partial<ReservationHistoryExportRow> = {}): ReservationHistoryExportRow {
  return {
    reservationDate: null,
    reservationTime: null,
    partySize: null,
    room: null,
    area: null,
    statusNormalized: 'completed',
    note: null,
    comment: null,
    ...over,
  };
}

describe('reservationHistoryRowToCells', () => {
  it('bildet Datum als Date-Zelle und übersetzt den Status', () => {
    const cells = reservationHistoryRowToCells(
      row({
        reservationDate: '2026-03-05',
        reservationTime: '19:30',
        partySize: 4,
        room: 'Restaurant',
        area: 'Fenster',
        statusNormalized: 'completed',
        note: 'Geburtstag',
        comment: 'Tisch 7',
      }),
      label,
    );
    expect(cells).toHaveLength(RESERVATION_HISTORY_HEADERS.length);
    expect(cells[0]).toBeInstanceOf(Date);
    expect(cells[1]).toBe('19:30');
    expect(cells[2]).toBe(4);
    expect(cells[3]).toBe('Restaurant · Fenster');
    expect(cells[4]).toBe('Besucht');
    expect(cells[5]).toBe('Geburtstag — Tisch 7');
  });

  it('leere Felder bleiben leer; unbekannter Status fällt auf den Rohwert zurück', () => {
    const cells = reservationHistoryRowToCells(row({ statusNormalized: 'pending' }), label);
    expect(cells[0]).toBeNull(); // kein Datum
    expect(cells[1]).toBeNull(); // keine Uhrzeit
    expect(cells[2]).toBeNull(); // keine Personenzahl
    expect(cells[3]).toBeNull(); // kein Bereich
    expect(cells[4]).toBe('pending');
    expect(cells[5]).toBeNull(); // keine Notiz
  });

  it('verbindet nur vorhandene Bereich-/Notizteile', () => {
    expect(reservationHistoryRowToCells(row({ room: 'Bar' }), label)[3]).toBe('Bar');
    expect(reservationHistoryRowToCells(row({ comment: 'Allergie' }), label)[5]).toBe('Allergie');
  });
});
