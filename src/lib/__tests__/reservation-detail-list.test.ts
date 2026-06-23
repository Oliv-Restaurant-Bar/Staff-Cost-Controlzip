// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  futureReservationKpis,
  futureReservationList,
  rangeReservationList,
  countInRange,
  maxFutureBoundary,
  isActiveStatus,
  isOpenStatus,
  type FutureBoundaries,
  type FutureSelectionKey,
  type ReservationDetailRow,
} from '../reservation-dashboard';

// Fixe Grenzen (Stichtag 23.06.2026) — keine PII, rein synthetische Gäste.
const B: FutureBoundaries = {
  today: '2026-06-23',
  endOfMonth: '2026-06-30',
  startNextMonth: '2026-07-01',
  endNextMonth: '2026-07-31',
  plus30: '2026-07-23',
  plus60: '2026-08-22',
  plus90: '2026-09-21',
};

function row(
  p: Partial<ReservationDetailRow> & { id: string; date: string | null; status: string },
): ReservationDetailRow {
  return {
    id: p.id,
    date: p.date,
    partySize: p.partySize ?? null,
    status: p.status,
    displayName: p.displayName ?? `Gast ${p.id}`,
    time: p.time ?? null,
    room: p.room ?? null,
    area: p.area ?? null,
    phone: p.phone ?? null,
    email: p.email ?? null,
    comment: p.comment ?? null,
    note: p.note ?? null,
  };
}

const ROWS: ReservationDetailRow[] = [
  row({ id: 'a', date: '2026-06-25', status: 'confirmed', partySize: 2, time: '19:00' }),
  row({ id: 'b', date: '2026-06-28', status: 'completed', partySize: 4, time: '12:30' }),
  row({ id: 'c', date: '2026-07-05', status: 'confirmed', partySize: 3, time: '20:00' }),
  row({ id: 'd', date: '2026-07-25', status: 'confirmed', partySize: 5, time: '18:00' }),
  row({ id: 'e', date: '2026-08-15', status: 'confirmed', partySize: 6, time: '19:30' }),
  row({ id: 'f', date: '2026-09-10', status: 'confirmed', partySize: 2, time: '21:00' }),
  row({ id: 'g', date: '2026-06-26', status: 'cancelled', partySize: 9, time: '19:00' }), // ausgeschlossen
  row({ id: 'h', date: '2026-06-27', status: 'noshow', partySize: 9, time: '19:00' }),    // ausgeschlossen
  row({ id: 'i', date: '2026-06-29', status: 'pending', partySize: 2, time: '13:00' }),   // offen
  row({ id: 'j', date: '2026-07-10', status: 'unknown', partySize: 3, time: '11:00' }),   // offen (Auffang)
  row({ id: 'k', date: '2026-09-25', status: 'confirmed', partySize: 4, time: '19:00' }), // jenseits plus90
  row({ id: 'l', date: null, status: 'confirmed', partySize: 4, time: '19:00' }),          // ohne Datum
];

const KEYS: FutureSelectionKey[] = [
  'currentMonth', 'nextMonth', 'next30', 'next60', 'next90', 'openNext90',
];

describe('futureReservationList ↔ futureReservationKpis (exakte Übereinstimmung)', () => {
  const kpis = futureReservationKpis(ROWS, B);

  it.each(KEYS)('Listenlänge und Personen entsprechen der Kachel für %s', (key) => {
    const list = futureReservationList(ROWS, B, key);
    expect(list.length).toBe(kpis[key].reservations);
    expect(list.reduce((s, r) => s + (r.partySize ?? 0), 0)).toBe(kpis[key].persons);
  });

  it('schliesst Stornos und No-Shows aus allen aktiven Kacheln aus', () => {
    for (const key of ['currentMonth', 'nextMonth', 'next30', 'next60', 'next90'] as FutureSelectionKey[]) {
      const ids = futureReservationList(ROWS, B, key).map(r => r.id);
      expect(ids).not.toContain('g');
      expect(ids).not.toContain('h');
    }
  });

  it('openNext90 enthält nur offene (pending/unknown), nicht aktive/ausgeschlossene/ausserhalb', () => {
    const ids = futureReservationList(ROWS, B, 'openNext90').map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining(['i', 'j']));
    expect(ids).not.toContain('a'); // aktiv
    expect(ids).not.toContain('g'); // ausgeschlossen
    expect(ids).not.toContain('k'); // jenseits der 90-Tage-Grenze
  });

  it('sortiert nächste zuerst, dann chronologisch aufsteigend (Datum, dann Uhrzeit)', () => {
    const list = futureReservationList(ROWS, B, 'next90');
    const keys = list.map(r => `${r.date} ${r.time ?? ''}`);
    expect(keys).toEqual([...keys].sort());
    expect(list[0].id).toBe('a'); // früheste anstehende aktive Reservation
  });

  it('enthält nie Zeilen ohne Datum', () => {
    for (const key of KEYS) {
      expect(futureReservationList(ROWS, B, key).map(r => r.id)).not.toContain('l');
    }
  });
});

describe('rangeReservationList ↔ countInRange (exakte Übereinstimmung)', () => {
  const from = '2026-06-23';
  const to = '2026-07-31';

  it('aktive Liste entspricht countInRange(aktiv)', () => {
    const list = rangeReservationList(ROWS, from, to, 'active');
    const c = countInRange(ROWS, from, to, isActiveStatus);
    expect(list.length).toBe(c.reservations);
    expect(list.reduce((s, r) => s + (r.partySize ?? 0), 0)).toBe(c.persons);
  });

  it('offene Liste entspricht countInRange(offen)', () => {
    const list = rangeReservationList(ROWS, from, to, 'open');
    const c = countInRange(ROWS, from, to, isOpenStatus);
    expect(list.length).toBe(c.reservations);
    expect(list.reduce((s, r) => s + (r.partySize ?? 0), 0)).toBe(c.persons);
  });

  it('aktive und offene Liste sind disjunkt', () => {
    const active = new Set(rangeReservationList(ROWS, from, to, 'active').map(r => r.id));
    for (const id of rangeReservationList(ROWS, from, to, 'open').map(r => r.id)) {
      expect(active.has(id)).toBe(false);
    }
  });
});

describe('maxFutureBoundary', () => {
  it('ist die späteste aller Zukunftsgrenzen', () => {
    expect(maxFutureBoundary(B)).toBe('2026-09-21'); // plus90
  });
});
