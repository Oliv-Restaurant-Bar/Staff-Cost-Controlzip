// @vitest-environment node
/**
 * Test: Reservationen — „Beste Reservationszeiten" (reine Auswertung)
 * ==================================================================
 * Synthetische Daten, keine echten Personendaten. Geprüft:
 *   - Gruppierung nach exakter Startzeit (Anzahl + Personen)
 *   - Sortierung nach Anzahl bzw. Personen
 *   - Ausschluss von Storno/No-Show (excludedByStatus)
 *   - leerer Monat (leere Eingabe)
 *   - Anteile (summieren sich zu ~100 %)
 *   - Zeilen ohne Uhrzeit werden ignoriert (ignoredNoTime)
 *   - Top-N-Begrenzung
 *
 * Mandantentrennung ist in dieser reinen Schicht NICHT anwendbar: Zeilen sind
 * bereits im DB-Layer per `restaurant_id` gefiltert (siehe foratable-report-db).
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeReservationTimes,
  sortTimeSlots,
  topTimeSlots,
  isMeaningfulTimeStatus,
  MEANINGFUL_TIME_STATUSES,
  EXCLUDED_TIME_STATUSES,
  type TimeAnalysisInput,
} from '../reservation-time-analysis';

function row(p: Partial<TimeAnalysisInput>): TimeAnalysisInput {
  return {
    reservationTime: '19:00',
    partySize: 2,
    statusNormalized: 'completed',
    ...p,
  };
}

describe('analyzeReservationTimes — Gruppierung nach Zeit', () => {
  it('gruppiert nach exakter Uhrzeit und summiert Anzahl + Personen', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '18:30', partySize: 4 }),
      row({ reservationTime: '18:30', partySize: 2 }),
      row({ reservationTime: '19:00', partySize: 3 }),
    ]);
    expect(a.totalReservations).toBe(3);
    expect(a.totalPersons).toBe(9);
    const s1830 = a.slots.find((s) => s.time === '18:30');
    const s1900 = a.slots.find((s) => s.time === '19:00');
    expect(s1830).toMatchObject({ count: 2, persons: 6 });
    expect(s1900).toMatchObject({ count: 1, persons: 3 });
  });

  it('behandelt fehlende Gruppengrösse als 0 Personen', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '20:00', partySize: null }),
      row({ reservationTime: '20:00', partySize: 5 }),
    ]);
    const s = a.slots.find((x) => x.time === '20:00');
    expect(s).toMatchObject({ count: 2, persons: 5 });
  });
});

describe('analyzeReservationTimes — Sortierung', () => {
  // Zeit A: 3 Reservationen × 1 Person = count 3 / persons 3
  // Zeit B: 2 Reservationen × 5 Personen = count 2 / persons 10
  const rows: TimeAnalysisInput[] = [
    row({ reservationTime: '18:00', partySize: 1 }),
    row({ reservationTime: '18:00', partySize: 1 }),
    row({ reservationTime: '18:00', partySize: 1 }),
    row({ reservationTime: '21:00', partySize: 5 }),
    row({ reservationTime: '21:00', partySize: 5 }),
  ];

  it('Standard: nach Anzahl absteigend', () => {
    const a = analyzeReservationTimes(rows);
    expect(a.slots.map((s) => s.time)).toEqual(['18:00', '21:00']); // 3 > 2
  });

  it('sortTimeSlots(count): Anzahl absteigend', () => {
    const a = analyzeReservationTimes(rows);
    expect(sortTimeSlots(a.slots, 'count').map((s) => s.time)).toEqual(['18:00', '21:00']);
  });

  it('sortTimeSlots(persons): Personen absteigend', () => {
    const a = analyzeReservationTimes(rows);
    expect(sortTimeSlots(a.slots, 'persons').map((s) => s.time)).toEqual(['21:00', '18:00']); // 10 > 3
  });

  it('Gleichstand: Uhrzeit aufsteigend', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '20:00', partySize: 2 }),
      row({ reservationTime: '18:00', partySize: 2 }),
    ]);
    expect(sortTimeSlots(a.slots, 'count').map((s) => s.time)).toEqual(['18:00', '20:00']);
  });
});

describe('analyzeReservationTimes — Status-Ausschluss', () => {
  it('schliesst Storno und No-Show aus, zählt completed/confirmed/pending/unknown', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '19:00', statusNormalized: 'completed', partySize: 2 }),
      row({ reservationTime: '19:00', statusNormalized: 'confirmed', partySize: 3 }),
      row({ reservationTime: '19:00', statusNormalized: 'pending', partySize: 1 }),
      row({ reservationTime: '19:00', statusNormalized: 'unknown', partySize: 1 }),
      row({ reservationTime: '19:00', statusNormalized: 'cancelled', partySize: 4 }),
      row({ reservationTime: '19:00', statusNormalized: 'noshow', partySize: 8 }),
    ]);
    const s = a.slots.find((x) => x.time === '19:00');
    expect(s).toMatchObject({ count: 4, persons: 7 }); // 2+3+1+1
    expect(a.totalReservations).toBe(4);
    expect(a.excludedByStatus).toBe(2);
  });

  it('isMeaningfulTimeStatus / Konstanten konsistent', () => {
    for (const s of MEANINGFUL_TIME_STATUSES) expect(isMeaningfulTimeStatus(s)).toBe(true);
    for (const s of EXCLUDED_TIME_STATUSES) expect(isMeaningfulTimeStatus(s)).toBe(false);
  });
});

describe('analyzeReservationTimes — Randfälle', () => {
  it('leerer Monat: leere Eingabe → Nullwerte', () => {
    const a = analyzeReservationTimes([]);
    expect(a.slots).toEqual([]);
    expect(a.totalReservations).toBe(0);
    expect(a.totalPersons).toBe(0);
    expect(a.ignoredNoTime).toBe(0);
    expect(a.excludedByStatus).toBe(0);
  });

  it('nur Stornos/No-Shows → keine Zeitfenster', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '19:00', statusNormalized: 'cancelled' }),
      row({ reservationTime: '20:00', statusNormalized: 'noshow' }),
    ]);
    expect(a.slots).toEqual([]);
    expect(a.totalReservations).toBe(0);
    expect(a.excludedByStatus).toBe(2);
  });

  it('Reservationen ohne Uhrzeit werden ignoriert (zählen aber als geprüft)', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: null, partySize: 4 }),
      row({ reservationTime: '', partySize: 4 }),
      row({ reservationTime: '19:00', partySize: 2 }),
    ]);
    expect(a.ignoredNoTime).toBe(2);
    expect(a.totalReservations).toBe(1);
    expect(a.slots.map((s) => s.time)).toEqual(['19:00']);
  });
});

describe('analyzeReservationTimes — Anteile', () => {
  it('Anteile beziehen sich auf berücksichtigte Summen und addieren sich zu ~1', () => {
    const a = analyzeReservationTimes([
      row({ reservationTime: '18:00', partySize: 2 }),
      row({ reservationTime: '18:00', partySize: 2 }),
      row({ reservationTime: '19:00', partySize: 6 }),
      row({ reservationTime: '20:00', statusNormalized: 'cancelled', partySize: 99 }), // ignoriert
    ]);
    const sumCount = a.slots.reduce((s, x) => s + x.shareCount, 0);
    const sumPersons = a.slots.reduce((s, x) => s + x.sharePersons, 0);
    expect(sumCount).toBeCloseTo(1, 6);
    expect(sumPersons).toBeCloseTo(1, 6);

    const s1800 = a.slots.find((x) => x.time === '18:00')!;
    expect(s1800.shareCount).toBeCloseTo(2 / 3, 6);   // 2 von 3 Reservationen
    expect(s1800.sharePersons).toBeCloseTo(4 / 10, 6); // 4 von 10 Personen
  });
});

describe('topTimeSlots', () => {
  it('begrenzt auf die ersten N und kopiert (ohne Mutation)', () => {
    const a = analyzeReservationTimes(
      Array.from({ length: 12 }, (_, i) => row({ reservationTime: `${String(8 + i).padStart(2, '0')}:00` })),
    );
    expect(a.slots).toHaveLength(12);
    const top10 = topTimeSlots(a.slots, 10);
    expect(top10).toHaveLength(10);
    expect(a.slots).toHaveLength(12); // unverändert

    expect(topTimeSlots(a.slots, 0)).toHaveLength(12); // 0 → alle
  });
});
