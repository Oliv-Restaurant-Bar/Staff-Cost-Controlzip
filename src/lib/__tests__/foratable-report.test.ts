// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  computeReservationStats,
  type ReservationStatsInput,
} from '../reservation-import-parser';
import {
  splitNewReturningGuests,
  buildForatableReport,
  quickRange,
} from '../foratable-report';

// Synthetische Zeilen — keine echten Personendaten.
function row(p: Partial<ReservationStatsInput>): ReservationStatsInput {
  return {
    partySize: 2,
    statusNormalized: 'completed',
    statusRaw: 'Abgeschlossen',
    reservationTime: '19:00',
    reservationDate: '2026-03-10',
    room: 'Restaurant',
    area: 'Innen',
    guestKey: 'g1',
    ...p,
  };
}

describe('computeReservationStats', () => {
  it('liefert für leere Eingabe Null-Werte', () => {
    const s = computeReservationStats([]);
    expect(s.reservationCount).toBe(0);
    expect(s.totalPersons).toBe(0);
    expect(s.avgPartySize).toBeNull();
    expect(s.periodFrom).toBeNull();
    expect(s.distinctGuestKeys).toEqual([]);
  });

  it('aggregiert Personen, Status, Zeitraum, Räume und Bereiche', () => {
    const rows: ReservationStatsInput[] = [
      row({ guestKey: 'g1', partySize: 2, reservationDate: '2026-03-01', statusNormalized: 'completed', statusRaw: 'Abgeschlossen', reservationTime: '18:00', room: 'Restaurant', area: 'Innen' }),
      row({ guestKey: 'g2', partySize: 4, reservationDate: '2026-03-15', statusNormalized: 'cancelled', statusRaw: 'Storniert', reservationTime: '18:00', room: 'Terrasse', area: 'Aussen' }),
      row({ guestKey: 'g1', partySize: 6, reservationDate: '2026-03-20', statusNormalized: 'completed', statusRaw: 'Abgeschlossen', reservationTime: '20:00', room: 'Restaurant', area: 'Innen' }),
      row({ guestKey: null, partySize: null, reservationDate: '2026-03-25', statusNormalized: 'noshow', statusRaw: 'No Show', reservationTime: null, room: '', area: '' }),
    ];
    const s = computeReservationStats(rows);

    expect(s.reservationCount).toBe(4);
    expect(s.totalPersons).toBe(12);       // 2 + 4 + 6 (null ignoriert)
    expect(s.avgPartySize).toBeCloseTo(4); // 12 / 3 bekannte
    expect(s.completedCount).toBe(2);
    expect(s.cancelledCount).toBe(1);
    expect(s.noshowCount).toBe(1);
    expect(s.periodFrom).toBe('2026-03-01');
    expect(s.periodTo).toBe('2026-03-25');
    expect(s.distinctGuestKeys.sort()).toEqual(['g1', 'g2']);
    expect(s.reservationsWithoutGuestKey).toBe(1);

    // Häufigste Zeit "18:00" → 2 Reservationen, 6 Personen
    const t1800 = s.topTimes.find((t) => t.time === '18:00');
    expect(t1800?.count).toBe(2);
    expect(t1800?.persons).toBe(6);

    const restaurant = s.rooms.find((r) => r.name === 'Restaurant');
    expect(restaurant?.count).toBe(2);
    const innen = s.areas.find((a) => a.name === 'Innen');
    expect(innen?.count).toBe(2);
  });
});

describe('splitNewReturningGuests', () => {
  it('zählt vorher bekannte Gäste als wiederkehrend', () => {
    const prior = new Set(['g2', 'g3']);
    const res = splitNewReturningGuests(['g1', 'g2', 'g4'], prior);
    expect(res.returningGuests).toBe(1); // g2
    expect(res.newGuests).toBe(2);       // g1, g4
  });

  it('alles neu, wenn keine vorherigen Gäste', () => {
    const res = splitNewReturningGuests(['g1', 'g2'], new Set());
    expect(res.newGuests).toBe(2);
    expect(res.returningGuests).toBe(0);
  });
});

describe('buildForatableReport', () => {
  it('kombiniert Statistik und Neu-/Wiederkehr-Aufteilung', () => {
    const rows: ReservationStatsInput[] = [
      row({ guestKey: 'g1' }),
      row({ guestKey: 'g2' }),
      row({ guestKey: 'g3' }),
    ];
    const prior = new Set(['g1']); // g1 war schon vorher da
    const report = buildForatableReport(rows, prior, { from: '2026-03-01', to: '2026-03-31' });

    expect(report.range).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(report.stats.reservationCount).toBe(3);
    expect(report.returningGuests).toBe(1);
    expect(report.newGuests).toBe(2);
  });
});

describe('quickRange', () => {
  const today = new Date(2026, 5, 15); // 15. Juni 2026 (Monat 0-indexiert)

  it('aktueller Monat', () => {
    expect(quickRange('current-month', today)).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });
  it('letzter Monat', () => {
    expect(quickRange('last-month', today)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });
  it('aktuelles Jahr', () => {
    expect(quickRange('current-year', today)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('letztes Jahr', () => {
    expect(quickRange('last-year', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });
});
