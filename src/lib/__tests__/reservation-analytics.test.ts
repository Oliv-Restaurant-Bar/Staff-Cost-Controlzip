// @vitest-environment node
/**
 * Test: Reservationen — Auswertungs-Helper
 * =========================================
 * Reine Funktionen, keine DB. Geprüft:
 *   - Reservationen/Personen pro Tag (mit/ohne Storno)
 *   - Reservationen nach Uhrzeit (Stunde vs. exakt)
 *   - Storno-/No-Show-Quote, Ø Gruppengrösse
 *   - Gäste-Wiederkehrrate
 *   - Vorlaufzeit (reserved_at → Datum)
 *   - Vergleich mit Tagesumsatz
 */
import { describe, it, expect } from 'vitest';
import type { ReservationAnalyticsRow } from '@/lib/reservation-analytics';
import {
  reservationsPerDay,
  personsPerDay,
  reservationsByTime,
  cancellationRate,
  noShowRate,
  avgGroupSize,
  guestReturnRate,
  leadTimeDays,
  leadTimeStats,
  compareWithRevenue,
} from '@/lib/reservation-analytics';

function r(p: Partial<ReservationAnalyticsRow>): ReservationAnalyticsRow {
  return {
    reservationDate: p.reservationDate ?? null,
    reservationTime: p.reservationTime ?? null,
    partySize: p.partySize ?? null,
    statusNormalized: p.statusNormalized ?? 'confirmed',
    reservedAt: p.reservedAt ?? null,
    guestKey: p.guestKey ?? null,
  };
}

const SAMPLE: ReservationAnalyticsRow[] = [
  r({ reservationDate: '2026-06-01', reservationTime: '19:00', partySize: 4, statusNormalized: 'completed', reservedAt: '2026-05-28T10:00:00', guestKey: 'email:a@x.com' }),
  r({ reservationDate: '2026-06-01', reservationTime: '19:30', partySize: 2, statusNormalized: 'cancelled', reservedAt: '2026-05-31T09:00:00', guestKey: 'email:b@x.com' }),
  r({ reservationDate: '2026-06-02', reservationTime: '20:00', partySize: 6, statusNormalized: 'noshow', reservedAt: '2026-06-01T18:00:00', guestKey: 'mobile:4179' }),
  r({ reservationDate: '2026-06-02', reservationTime: '19:00', partySize: 3, statusNormalized: 'completed', reservedAt: '2026-05-20T12:00:00', guestKey: 'email:a@x.com' }),
];

describe('Reservationen Analytics', () => {
  it('zählt Reservationen pro Tag (inkl. und exkl. Storno)', () => {
    const all = reservationsPerDay(SAMPLE);
    expect(all).toEqual([
      { date: '2026-06-01', count: 2 },
      { date: '2026-06-02', count: 2 },
    ]);
    const noCancel = reservationsPerDay(SAMPLE, { excludeCancelled: true });
    expect(noCancel.find(d => d.date === '2026-06-01')?.count).toBe(1);
  });

  it('summiert Personen pro Tag', () => {
    const p = personsPerDay(SAMPLE);
    expect(p.find(d => d.date === '2026-06-01')?.persons).toBe(6);
    expect(p.find(d => d.date === '2026-06-02')?.persons).toBe(9);
  });

  it('gruppiert nach Uhrzeit (Stunde und exakt)', () => {
    const byHour = reservationsByTime(SAMPLE, 'hour');
    // 19:00, 19:30, 19:00 fallen alle in die Stunde "19:00"
    expect(byHour.find(t => t.time === '19:00')?.count).toBe(3);
    expect(byHour.find(t => t.time === '20:00')?.count).toBe(1);

    const exact = reservationsByTime(SAMPLE, 'exact');
    expect(exact.find(t => t.time === '19:30')?.count).toBe(1);
  });

  it('berechnet Storno- und No-Show-Quote', () => {
    expect(cancellationRate(SAMPLE)).toBeCloseTo(1 / 4, 5);
    expect(noShowRate(SAMPLE)).toBeCloseTo(1 / 4, 5);
    expect(cancellationRate([])).toBe(0);
  });

  it('berechnet durchschnittliche Gruppengrösse (Storno ausgeschlossen)', () => {
    // 4 + 6 + 3 = 13 über 3 nicht-stornierte = 4.333…
    expect(avgGroupSize(SAMPLE)).toBeCloseTo(13 / 3, 5);
    // mit Storno: (4+2+6+3)/4 = 3.75
    expect(avgGroupSize(SAMPLE, { excludeCancelled: false })).toBeCloseTo(15 / 4, 5);
  });

  it('berechnet die Gäste-Wiederkehrrate', () => {
    const res = guestReturnRate(SAMPLE);
    // 3 eindeutige Gäste, a@x.com kommt 2× → 1 wiederkehrend
    expect(res.totalGuests).toBe(3);
    expect(res.returningGuests).toBe(1);
    expect(res.oneTimeGuests).toBe(2);
    expect(res.returnRate).toBeCloseTo(1 / 3, 5);
  });

  it('berechnet Vorlaufzeiten', () => {
    expect(leadTimeDays(SAMPLE[0])).toBe(4);   // 28.05 → 01.06
    expect(leadTimeDays(SAMPLE[3])).toBe(13);  // 20.05 → 02.06
    expect(leadTimeDays(r({ reservationDate: '2026-06-01' }))).toBeNull();

    const stats = leadTimeStats(SAMPLE);
    expect(stats.count).toBe(4);
    expect(stats.minDays).toBe(1);
    expect(stats.maxDays).toBe(13);
  });

  it('vergleicht Reservationen mit Tagesumsatz (Storno ausgeschlossen)', () => {
    const revenue = { '2026-06-01': 1200, '2026-06-02': 2000 };
    const cmp = compareWithRevenue(SAMPLE, revenue);

    const day1 = cmp.find(c => c.date === '2026-06-01')!;
    expect(day1.reservations).toBe(1);   // Storno ausgeschlossen
    expect(day1.persons).toBe(4);
    expect(day1.revenue).toBe(1200);
    expect(day1.revenuePerPerson).toBeCloseTo(300, 5);

    const day2 = cmp.find(c => c.date === '2026-06-02')!;
    expect(day2.reservations).toBe(2);
    expect(day2.persons).toBe(9);
    expect(day2.revenuePerReservation).toBeCloseTo(1000, 5);
  });

  it('ist robust gegen leere Eingaben', () => {
    expect(reservationsPerDay([])).toEqual([]);
    expect(avgGroupSize([])).toBeNull();
    expect(guestReturnRate([]).returnRate).toBe(0);
    expect(leadTimeStats([]).avgDays).toBeNull();
  });
});
