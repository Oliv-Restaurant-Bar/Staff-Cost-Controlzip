// @vitest-environment node
/**
 * Tests für reservation-dashboard.ts — reine Logik, synthetische Daten (keine PII).
 */

import { describe, it, expect } from 'vitest';
import {
  isActiveStatus, isOpenStatus, isExcludedStatus, countInRange,
  aggregateReservationsByDay, addIsoDays,
  futureReservationKpis, guestDashboardKpis,
  type ReservationAggRow, type FutureBoundaries,
} from '../reservation-dashboard';
import {
  guestListMetrics, type GuestProfile, type CompletedVisitAgg,
} from '../reservation-crm';

// ── Status-Prädikate (vom Nutzer vorgegebene Vokabularien) ──────────────────────

describe('Statusprädikate', () => {
  const ACTIVE = ['confirmed', 'completed', 'seated', 'arrived', 'active'];
  const OPEN = ['pending', 'unknown', 'not_answered', 'offen'];
  const EXCLUDED = ['cancelled', 'canceled', 'storniert', 'no_show', 'noshow', 'rejected', 'abgelehnt'];

  it('erkennt alle aktiven Status', () => {
    for (const s of ACTIVE) {
      expect(isActiveStatus(s)).toBe(true);
      expect(isOpenStatus(s)).toBe(false);
      expect(isExcludedStatus(s)).toBe(false);
    }
  });

  it('erkennt alle offenen/unbeantworteten Status', () => {
    for (const s of OPEN) {
      expect(isOpenStatus(s)).toBe(true);
      expect(isActiveStatus(s)).toBe(false);
      expect(isExcludedStatus(s)).toBe(false);
    }
  });

  it('erkennt alle ausgeschlossenen Status (zählen nirgends)', () => {
    for (const s of EXCLUDED) {
      expect(isExcludedStatus(s)).toBe(true);
      expect(isActiveStatus(s)).toBe(false);
      expect(isOpenStatus(s)).toBe(false);
    }
  });

  it('vergleicht case-insensitive und getrimmt', () => {
    expect(isActiveStatus('  SEATED ')).toBe(true);
    expect(isActiveStatus('Confirmed')).toBe(true);
    expect(isExcludedStatus('STORNIERT')).toBe(true);
    expect(isOpenStatus(' Not_Answered ')).toBe(true);
  });

  it('behandelt unbekannte Status als offen (Auffangkorb, nichts geht verloren)', () => {
    expect(isOpenStatus('waitlist')).toBe(true);
    expect(isOpenStatus('')).toBe(true);
    expect(isActiveStatus('waitlist')).toBe(false);
    expect(isExcludedStatus('waitlist')).toBe(false);
  });
});

// ── countInRange ──────────────────────────────────────────────────────────────

describe('countInRange', () => {
  const rows: ReservationAggRow[] = [
    { date: '2026-06-22', partySize: 4, status: 'confirmed' },   // Untergrenze inkl.
    { date: '2026-06-29', partySize: 2, status: 'seated' },      // seated = aktiv
    { date: '2026-06-30', partySize: 2, status: 'completed' },   // Obergrenze inkl.
    { date: '2026-07-01', partySize: 5, status: 'confirmed' },   // ausserhalb
    { date: '2026-06-25', partySize: 3, status: 'storniert' },   // ausgeschlossen
    { date: '2026-06-26', partySize: null, status: 'arrived' },  // aktiv, Personen unbekannt → 0
    { date: null, partySize: 9, status: 'confirmed' },           // ohne Datum → ignoriert
  ];

  it('zählt inklusive Grenzen und filtert nach Status', () => {
    const r = countInRange(rows, '2026-06-22', '2026-06-30', isActiveStatus);
    expect(r.reservations).toBe(4);   // 22., 29.(seated), 30., 26.(arrived)
    expect(r.persons).toBe(8);        // 4 + 2 + 2 + 0
  });

  it('leere Eingabe ergibt 0/0', () => {
    expect(countInRange([], '2026-01-01', '2026-12-31', isActiveStatus)).toEqual({ reservations: 0, persons: 0 });
  });
});

// ── aggregateReservationsByDay + addIsoDays ────────────────────────────────────

describe('addIsoDays', () => {
  it('addiert Tage UTC-sicher inkl. Monats-/Jahreswechsel', () => {
    expect(addIsoDays('2026-06-29', 1)).toBe('2026-06-30');
    expect(addIsoDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addIsoDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addIsoDays('2026-07-01', 6)).toBe('2026-07-07');
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29'); // Schaltjahr
  });
});

describe('aggregateReservationsByDay', () => {
  const rows: ReservationAggRow[] = [
    { date: '2026-06-22', partySize: 4, status: 'confirmed' },
    { date: '2026-06-22', partySize: 2, status: 'seated' },     // gleicher Tag, aktiv
    { date: '2026-06-24', partySize: 3, status: 'completed' },
    { date: '2026-06-24', partySize: 5, status: 'storniert' },  // ausgeschlossen → zählt nicht
    { date: '2026-06-26', partySize: null, status: 'arrived' }, // aktiv, Personen unbekannt → 0
    { date: '2026-06-30', partySize: 8, status: 'confirmed' },  // Obergrenze inkl.
    { date: '2026-07-01', partySize: 9, status: 'confirmed' },  // ausserhalb
    { date: null, partySize: 6, status: 'confirmed' },          // ohne Datum → ignoriert
  ];

  it('liefert einen Eintrag pro Kalendertag inkl. Nulltagen (lückenlos)', () => {
    const days = aggregateReservationsByDay(rows, '2026-06-22', '2026-06-30', isActiveStatus);
    expect(days).toHaveLength(9); // 22.–30. Juni = 9 Tage
    expect(days.map(d => d.date)[0]).toBe('2026-06-22');
    expect(days.map(d => d.date)[8]).toBe('2026-06-30');
    // Nulltag 23. Juni vorhanden mit 0/0
    const d23 = days.find(d => d.date === '2026-06-23')!;
    expect(d23).toEqual({ date: '2026-06-23', reservations: 0, persons: 0 });
  });

  it('summiert aktive Reservationen/Personen je Tag (Storno zählt nicht, null=0 Personen)', () => {
    const days = aggregateReservationsByDay(rows, '2026-06-22', '2026-06-30', isActiveStatus);
    expect(days.find(d => d.date === '2026-06-22')).toEqual({ date: '2026-06-22', reservations: 2, persons: 6 });
    expect(days.find(d => d.date === '2026-06-24')).toEqual({ date: '2026-06-24', reservations: 1, persons: 3 });
    expect(days.find(d => d.date === '2026-06-26')).toEqual({ date: '2026-06-26', reservations: 1, persons: 0 });
    expect(days.find(d => d.date === '2026-06-30')).toEqual({ date: '2026-06-30', reservations: 1, persons: 8 });
  });

  it('ist über denselben Bereich exakt deckungsgleich mit countInRange (Kernpflicht)', () => {
    const from = '2026-06-22', to = '2026-06-30';
    const days = aggregateReservationsByDay(rows, from, to, isActiveStatus);
    const total = countInRange(rows, from, to, isActiveStatus);
    const sumRes = days.reduce((s, d) => s + d.reservations, 0);
    const sumPers = days.reduce((s, d) => s + d.persons, 0);
    expect(sumRes).toBe(total.reservations);
    expect(sumPers).toBe(total.persons);
  });

  it('leerer/ungültiger Bereich ergibt []', () => {
    expect(aggregateReservationsByDay(rows, '2026-07-05', '2026-07-01', isActiveStatus)).toEqual([]);
    expect(aggregateReservationsByDay([], '2026-06-22', '2026-06-23', isActiveStatus)).toEqual([
      { date: '2026-06-22', reservations: 0, persons: 0 },
      { date: '2026-06-23', reservations: 0, persons: 0 },
    ]);
  });
});

// ── futureReservationKpis ─────────────────────────────────────────────────────

describe('futureReservationKpis', () => {
  const boundaries: FutureBoundaries = {
    today:          '2026-06-22',
    endOfMonth:     '2026-06-30',
    startNextMonth: '2026-07-01',
    endNextMonth:   '2026-07-31',
    plus30:         '2026-07-22',
    plus60:         '2026-08-21',
    plus90:         '2026-09-20',
  };

  const rows: ReservationAggRow[] = [
    { date: '2026-06-25', partySize: 4, status: 'confirmed' },  // laufender Monat + 30/60/90
    { date: '2026-07-10', partySize: 2, status: 'seated' },     // nächster Monat + 30/60/90 (aktiv via seated)
    { date: '2026-08-15', partySize: 6, status: 'arrived' },    // 60/90 (aktiv via arrived)
    { date: '2026-09-25', partySize: 3, status: 'confirmed' },  // jenseits +90 → nirgends
    { date: '2026-06-28', partySize: 5, status: 'storniert' },  // ausgeschlossen
    { date: '2026-06-23', partySize: 8, status: 'no_show' },    // ausgeschlossen
    { date: '2026-07-05', partySize: 2, status: 'not_answered' }, // offen separat
  ];

  it('bucketet aktive Reservationen korrekt', () => {
    const k = futureReservationKpis(rows, boundaries);
    expect(k.currentMonth).toEqual({ reservations: 1, persons: 4 });
    expect(k.nextMonth).toEqual({ reservations: 1, persons: 2 });
    expect(k.next30).toEqual({ reservations: 2, persons: 6 });
    expect(k.next60).toEqual({ reservations: 3, persons: 12 });
    expect(k.next90).toEqual({ reservations: 3, persons: 12 });
  });

  it('weist offene/unbeantwortete separat aus (Stornos/No-Shows zählen nicht)', () => {
    const k = futureReservationKpis(rows, boundaries);
    expect(k.openNext90).toEqual({ reservations: 1, persons: 2 });
  });

  it('leere Eingabe ergibt überall 0', () => {
    const k = futureReservationKpis([], boundaries);
    expect(k.currentMonth).toEqual({ reservations: 0, persons: 0 });
    expect(k.next90).toEqual({ reservations: 0, persons: 0 });
    expect(k.openNext90).toEqual({ reservations: 0, persons: 0 });
  });
});

// ── guestDashboardKpis ────────────────────────────────────────────────────────

function profile(id: string): GuestProfile {
  return {
    id,
    first_name: null, last_name: null, email: null, mobile: null,
    first_seen_at: null, last_seen_at: null,
    total_reservations: null, total_persons: null,
    cancelled_reservations: null, completed_reservations: null,
  };
}

describe('guestDashboardKpis', () => {
  const today = '2026-06-22';

  // visitAgg je Gast (abgeschlossene Besuche)
  const aggs: Record<string, CompletedVisitAgg | undefined> = {
    g1: { visits: 25, firstVisit: '2024-01-01', lastVisit: '2026-06-20' }, // VIP, aktiv
    g2: { visits: 10, firstVisit: '2024-01-01', lastVisit: '2026-01-01' }, // inaktiv (>90 T.)
    g3: { visits: 1,  firstVisit: '2026-06-01', lastVisit: '2026-06-01' }, // Neukunde, neu30, aktiv
    g4: undefined,                                                          // ohne Besuch
    g5: { visits: 5,  firstVisit: '2025-01-01', lastVisit: '2026-06-10' }, // wiederkehrend, aktiv
    g6: { visits: 12, firstVisit: '2024-06-01', lastVisit: '2026-06-15' }, // Stammgast, aktiv
  };

  const metrics = Object.keys(aggs).map(id => guestListMetrics(profile(id), aggs[id], today));
  const noShow = new Map<string, number>([['g5', 2], ['g1', 1]]);

  it('berechnet Überblicks-Kennzahlen', () => {
    const k = guestDashboardKpis(metrics, noShow, today);
    expect(k.totalGuests).toBe(6);
    expect(k.activeGuests).toBe(4);          // g1, g3, g5, g6
    expect(k.inactiveGuests).toBe(1);        // g2
    expect(k.newGuests30).toBe(1);           // g3
    expect(k.repeatRatePct).toBe(80);        // 4 von 5 mit Besuch haben ≥ 2
    expect(k.vipGuests).toBe(1);             // g1
    expect(k.stammgaeste).toBe(1);           // g6
    expect(k.guestsWithoutVisit).toBe(1);    // g4
    expect(k.noShowRiskGuests).toBe(1);      // g5 (≥ 2); g1 hat nur 1
  });

  it('ist defensiv bei leerer Gästeliste', () => {
    const k = guestDashboardKpis([], new Map(), today);
    expect(k.totalGuests).toBe(0);
    expect(k.activeGuests).toBe(0);
    expect(k.repeatRatePct).toBeNull();
    expect(k.noShowRiskGuests).toBe(0);
    expect(k.returnRiskGuests).toBe(0);
  });

  it('zählt gefährdete Stammgäste (Rückkehrpotenzial)', () => {
    // g2: Ø-Intervall = 731/9 ≈ 81 T., seit 169 T. weg → Quote ≈ 2.08 ≥ 2 → gefährdet.
    // g1/g5/g6 sind im Rhythmus (kürzlich da); g3 hat 1 Besuch (kein Intervall).
    const k = guestDashboardKpis(metrics, noShow, today);
    expect(k.returnRiskGuests).toBe(1);      // nur g2
  });
});
