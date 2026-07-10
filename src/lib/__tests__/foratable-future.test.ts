// @vitest-environment node
/**
 * Tests für foratable-future.ts — reine Logik, synthetische Daten (keine PII).
 * Prüft insb. die WERTEGLEICHHEIT mit der zentralen CRM-Zähllogik (countInRange).
 */

import { describe, it, expect } from 'vitest';
import {
  futureQuickRange,
  isoWeekday,
  dayValueScale,
  buildCalendarDays,
  levelColor,
  levelTone,
  buildFutureOverview,
  buildDayDetail,
  WEEKDAY_LABEL_SHORT,
  type FutureRange,
} from '../foratable-future';
import {
  countInRange, isActiveStatus,
  type ReservationAggRow, type ReservationDetailRow,
} from '../reservation-dashboard';

// ── futureQuickRange ───────────────────────────────────────────────────────────

describe('futureQuickRange', () => {
  const today = '2026-07-10';

  it('current-month = heute … Monatsende', () => {
    expect(futureQuickRange('current-month', today)).toEqual({ kind: 'current-month', from: '2026-07-10', to: '2026-07-31' });
  });

  it('next-7/14/30 = heute … heute+6/+13/+29 (7/14/30 Kalendertage, Nutzervorgabe)', () => {
    expect(futureQuickRange('next-7', today)).toEqual({ kind: 'next-7', from: '2026-07-10', to: '2026-07-16' });
    expect(futureQuickRange('next-14', today)).toEqual({ kind: 'next-14', from: '2026-07-10', to: '2026-07-23' });
    expect(futureQuickRange('next-30', today)).toEqual({ kind: 'next-30', from: '2026-07-10', to: '2026-08-08' });
  });

  it('Monatsende korrekt bei Februar (kein Schaltjahr)', () => {
    expect(futureQuickRange('current-month', '2026-02-05').to).toBe('2026-02-28');
  });
});

// ── isoWeekday + Labels ────────────────────────────────────────────────────────

describe('isoWeekday', () => {
  it('liefert 1=Mo … 7=So', () => {
    expect(isoWeekday('2026-07-06')).toBe(1); // Montag
    expect(isoWeekday('2026-07-10')).toBe(5); // Freitag
    expect(isoWeekday('2026-07-12')).toBe(7); // Sonntag
    expect(WEEKDAY_LABEL_SHORT[isoWeekday('2026-07-12')]).toBe('So');
  });
});

// ── Skala + Farbabbildung ──────────────────────────────────────────────────────

describe('levelColor / levelTone / dayValueScale', () => {
  it('bildet die 6 Stufen auf 4 Ampelfarben ab', () => {
    expect(levelColor('empty')).toBe('grau');
    expect(levelColor('veryLow')).toBe('gruen');
    expect(levelColor('low')).toBe('gruen');
    expect(levelColor('mid')).toBe('gruen');
    expect(levelColor('high')).toBe('orange');
    expect(levelColor('veryHigh')).toBe('rot');
  });

  it('bildet Farben auf Design-System-Töne ab', () => {
    expect(levelTone('empty')).toBe('neutral');
    expect(levelTone('mid')).toBe('good');
    expect(levelTone('high')).toBe('warn');
    expect(levelTone('veryHigh')).toBe('critical');
  });

  it('Skala ignoriert Nullwerte, erkennt Spanne', () => {
    const scale = dayValueScale(
      [
        { date: '2026-07-10', reservations: 0, persons: 0 },
        { date: '2026-07-11', reservations: 2, persons: 4 },
        { date: '2026-07-12', reservations: 5, persons: 20 },
      ],
      'persons',
    );
    expect(scale).toEqual({ min: 4, max: 20, hasRange: true });
  });

  it('Nulltage werden als „grau/empty" eingestuft', () => {
    const days = buildCalendarDays(
      [
        { date: '2026-07-10', reservations: 0, persons: 0 },
        { date: '2026-07-11', reservations: 1, persons: 2 },
        { date: '2026-07-12', reservations: 10, persons: 40 },
      ],
      'persons',
    );
    expect(days[0].color).toBe('grau');
    expect(days[0].level).toBe('empty');
    expect(days[2].color).toBe('rot'); // Spitzenwert
  });
});

// ── buildFutureOverview: Wertegleichheit mit countInRange ───────────────────────

describe('buildFutureOverview', () => {
  const today = '2026-07-10';
  const rows: ReservationAggRow[] = [
    { date: '2026-07-05', partySize: 4, status: 'confirmed' },  // Vergangenheit → weg (clamp)
    { date: '2026-07-10', partySize: 4, status: 'confirmed' },  // heute
    { date: '2026-07-10', partySize: 2, status: 'seated' },     // heute, aktiv
    { date: '2026-07-12', partySize: 6, status: 'completed' },
    { date: '2026-07-12', partySize: 3, status: 'storniert' },  // ausgeschlossen
    { date: '2026-07-18', partySize: 8, status: 'confirmed' },  // in next-14 & 30
    { date: '2026-08-05', partySize: 5, status: 'confirmed' },  // in next-30
    { date: '2026-07-15', partySize: 2, status: 'pending' },    // offen → nicht aktiv
  ];

  it('totals sind exakt countInRange(isActiveStatus) über den effektiven Bereich', () => {
    const range = futureQuickRange('current-month', today); // 2026-07-10..2026-07-31
    const ov = buildFutureOverview(rows, range, today);
    const expected = countInRange(rows, '2026-07-10', '2026-07-31', isActiveStatus);
    expect(ov.totals).toEqual(expected);
    // konkret: 10.(4)+10.(2)+12.(6)+18.(8) = 4 Res / 20 Pers
    expect(ov.totals).toEqual({ reservations: 4, persons: 20 });
  });

  it('klammert die Vergangenheit ab (effectiveFrom = heute bei current-month)', () => {
    const range: FutureRange = { kind: 'custom', from: '2026-07-01', to: '2026-07-31' };
    const ov = buildFutureOverview(rows, range, today);
    expect(ov.effectiveFrom).toBe('2026-07-10');
    // 05.07 (Vergangenheit) darf nicht mitzählen
    expect(ov.totals.reservations).toBe(4);
  });

  it('Σ Kalendertage === totals (Kalender deckungsgleich mit KPI)', () => {
    const range = futureQuickRange('current-month', today);
    const ov = buildFutureOverview(rows, range, today);
    const sumRes = ov.days.reduce((s, d) => s + d.reservations, 0);
    const sumPers = ov.days.reduce((s, d) => s + d.persons, 0);
    expect(sumRes).toBe(ov.totals.reservations);
    expect(sumPers).toBe(ov.totals.persons);
  });

  it('next7/14/30 = absolute Fenster ab heute', () => {
    const range = futureQuickRange('current-month', today);
    const ov = buildFutureOverview(rows, range, today);
    expect(ov.next7).toEqual(countInRange(rows, '2026-07-10', '2026-07-16', isActiveStatus));   // 10.,10.,12. → 3/12
    expect(ov.next7).toEqual({ reservations: 3, persons: 12 });
    expect(ov.next14).toEqual(countInRange(rows, '2026-07-10', '2026-07-23', isActiveStatus));  // +18. → 4/20
    expect(ov.next30).toEqual(countInRange(rows, '2026-07-10', '2026-08-08', isActiveStatus));  // +05.08 → 5/25
    expect(ov.next30).toEqual({ reservations: 5, persons: 25 });
  });

  it('avgPartySize = Personen / Reservationen', () => {
    const range = futureQuickRange('current-month', today);
    const ov = buildFutureOverview(rows, range, today);
    expect(ov.avgPartySize).toBe(20 / 4);
  });

  it('stärkster Tag = meiste Personen; nächster starker Tag = früheste high/veryHigh-Stufe', () => {
    const range = futureQuickRange('current-month', today);
    const ov = buildFutureOverview(rows, range, today);
    expect(ov.strongestDay?.date).toBe('2026-07-18'); // 8 Personen
    expect(ov.strongestDay?.persons).toBe(8);
    expect(ov.nextStrongDay).not.toBeNull();
    expect(['high', 'veryHigh']).toContain(ov.nextStrongDay!.level);
  });

  it('rein vergangener Bereich → empty, totals 0, keine Tage', () => {
    const range: FutureRange = { kind: 'custom', from: '2026-06-01', to: '2026-06-30' };
    const ov = buildFutureOverview(rows, range, today);
    expect(ov.empty).toBe(true);
    expect(ov.totals).toEqual({ reservations: 0, persons: 0 });
    expect(ov.days).toEqual([]);
    expect(ov.strongestDay).toBeNull();
  });

  it('daysWithReservations zählt nur belegte Tage', () => {
    const range = futureQuickRange('current-month', today);
    const ov = buildFutureOverview(rows, range, today);
    // belegt: 10., 12., 18. = 3 (15. ist pending → nicht aktiv)
    expect(ov.daysWithReservations).toBe(3);
  });
});

// ── buildDayDetail: nur Aggregate, keine PII ────────────────────────────────────

describe('buildDayDetail', () => {
  const detailRows: ReservationDetailRow[] = [
    {
      id: 'r1', guestId: 'g1', date: '2026-07-18', partySize: 4, status: 'confirmed',
      displayName: 'Max Muster', time: '19:30', room: 'Terrasse', area: 'Aussen',
      phone: '+41790000000', email: 'max@example.com', comment: 'Fensterplatz', note: null,
    },
    {
      id: 'r2', guestId: 'g2', date: '2026-07-18', partySize: 2, status: 'completed',
      displayName: 'Anna B', time: '18:00', room: 'Saal', area: 'Innen',
      phone: null, email: null, comment: null, note: null,
    },
    {
      id: 'r3', guestId: 'g3', date: '2026-07-18', partySize: 6, status: 'storniert',
      displayName: 'Storno', time: '20:00', room: 'Saal', area: 'Innen',
      phone: null, email: null, comment: null, note: null,
    },
    {
      id: 'r4', guestId: 'g4', date: '2026-07-19', partySize: 3, status: 'confirmed',
      displayName: 'Anderer Tag', time: '12:00', room: 'Saal', area: null,
      phone: null, email: null, comment: null, note: null,
    },
  ];

  it('aggregiert aktive Totale deckungsgleich mit der Kalenderzelle', () => {
    const d = buildDayDetail(detailRows, '2026-07-18');
    expect(d.active).toEqual({ reservations: 2, persons: 6 }); // Storno zählt nicht
    expect(d.avgPartySize).toBe(3);
    expect(d.weekday).toBe(6); // 18.07.2026 = Samstag
  });

  it('liefert Zeitfenster + Räume der aktiven Reservationen', () => {
    const d = buildDayDetail(detailRows, '2026-07-18');
    expect(d.timeFrom).toBe('18:00');
    expect(d.timeTo).toBe('19:30');
    expect(d.rooms).toEqual([
      { room: 'Terrasse', reservations: 1, persons: 4 },
      { room: 'Saal', reservations: 1, persons: 2 },
    ]);
  });

  it('Statusverteilung umfasst ALLE Reservationen des Tages (auch Storno)', () => {
    const d = buildDayDetail(detailRows, '2026-07-18');
    const map = Object.fromEntries(d.statuses.map((s) => [s.status, s.reservations]));
    expect(map).toEqual({ confirmed: 1, completed: 1, storniert: 1 });
  });

  it('gibt KEINE PII zurück (keine Namen/Telefon/E-Mail/Kommentar-Felder)', () => {
    const d = buildDayDetail(detailRows, '2026-07-18');
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('Max Muster');
    expect(serialized).not.toContain('max@example.com');
    expect(serialized).not.toContain('+41790000000');
    expect(serialized).not.toContain('Fensterplatz');
    // Struktur enthält nur Aggregat-Schlüssel
    expect(Object.keys(d).sort()).toEqual(
      ['active', 'avgPartySize', 'date', 'rooms', 'statuses', 'timeFrom', 'timeTo', 'weekday'].sort(),
    );
  });

  it('leerer Tag → 0 Totale, keine Zeit/Räume', () => {
    const d = buildDayDetail(detailRows, '2026-07-25');
    expect(d.active).toEqual({ reservations: 0, persons: 0 });
    expect(d.avgPartySize).toBeNull();
    expect(d.timeFrom).toBeNull();
    expect(d.rooms).toEqual([]);
    expect(d.statuses).toEqual([]);
  });
});
