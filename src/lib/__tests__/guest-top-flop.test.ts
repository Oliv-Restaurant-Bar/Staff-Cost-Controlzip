// @vitest-environment node
/**
 * Tests für Top/Flop-Listen + Zeitraum-Auflösung (guest-top-flop.ts).
 * Reine Logik, synthetische Daten, keine PII, keine DB/DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveZeitraum,
  inRangeVisitCounts,
  buildTopList,
  buildFlopList,
  type ActiveVisitRow,
  type RangeVisitCount,
} from '../guest-top-flop';
import { type GuestListMetrics } from '../reservation-crm';

function metric(p: Partial<GuestListMetrics> & { id: string }): GuestListMetrics {
  return {
    displayName: p.id,
    email: null,
    mobile: null,
    visits: 0,
    totalReservations: 0,
    cancelledReservations: 0,
    firstVisit: null,
    lastVisit: null,
    daysSinceLastVisit: null,
    avgDaysBetweenVisits: null,
    avgPartySize: null,
    noShowCount: 0,
    segment: 'ohne_besuch',
    ...p,
  };
}

const visit = (guestId: string, date: string, partySize: number, status = 'completed'): ActiveVisitRow =>
  ({ guestId, date, partySize, status });

// ── Zeitraum-Auflösung ────────────────────────────────────────────────────────

describe('resolveZeitraum', () => {
  const today = new Date(2026, 5, 15); // 15. Juni 2026 (Monat 0-indexiert)

  it('aktueller Monat = ganzer Monat', () => {
    expect(resolveZeitraum('akt_monat', today)).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });
  it('letzter Monat = ganzer Vormonat', () => {
    expect(resolveZeitraum('letzter_monat', today)).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });
  it('letzte 30 Tage endet heute', () => {
    expect(resolveZeitraum('letzte_30', today)).toEqual({ from: '2026-05-16', to: '2026-06-15' });
  });
  it('letzte 90 Tage endet heute und beginnt früher', () => {
    const r = resolveZeitraum('letzte_90', today);
    expect(r.to).toBe('2026-06-15');
    expect(r.from < r.to).toBe(true);
  });
  it('YTD = Jahresanfang bis heute', () => {
    expect(resolveZeitraum('ytd', today)).toEqual({ from: '2026-01-01', to: '2026-06-15' });
  });
  it('individuell nutzt custom (und tauscht verdrehte Grenzen)', () => {
    expect(resolveZeitraum('individuell', today, { from: '2026-02-01', to: '2026-02-28' }))
      .toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveZeitraum('individuell', today, { from: '2026-03-31', to: '2026-03-01' }))
      .toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });
  it('individuell ohne custom fällt auf heute…heute zurück', () => {
    expect(resolveZeitraum('individuell', today)).toEqual({ from: '2026-06-15', to: '2026-06-15' });
  });
});

// ── In-Range-Zählung ──────────────────────────────────────────────────────────

describe('inRangeVisitCounts', () => {
  it('zählt aktive Besuche + Personen im Bereich, ignoriert Rest', () => {
    const rows: ActiveVisitRow[] = [
      visit('a', '2026-06-05', 2),
      visit('a', '2026-06-20', 4, 'confirmed'),
      visit('a', '2026-05-31', 2),            // ausserhalb (vor from)
      visit('b', '2026-06-10', 3),
      visit('b', '2026-06-11', 5, 'cancelled'), // inaktiver Status
      visit('', '2026-06-12', 2),              // keine guestId
      { guestId: 'c', date: null, partySize: 2, status: 'completed' }, // kein Datum
    ];
    const counts = inRangeVisitCounts(rows, '2026-06-01', '2026-06-30');
    expect(counts.get('a')).toEqual<RangeVisitCount>({ visits: 2, persons: 6 });
    expect(counts.get('b')).toEqual<RangeVisitCount>({ visits: 1, persons: 3 });
    expect(counts.has('c')).toBe(false);
  });

  it('Bereich ist inklusiv an beiden Grenzen', () => {
    const rows = [visit('a', '2026-06-01', 2), visit('a', '2026-06-30', 2)];
    expect(inRangeVisitCounts(rows, '2026-06-01', '2026-06-30').get('a')?.visits).toBe(2);
  });
});

// ── Top-Liste ─────────────────────────────────────────────────────────────────

describe('buildTopList', () => {
  it('sortiert nach Besuchen ↓, dann Personen, dann Lebenszeit-Besuche; kürzt auf limit', () => {
    const metrics = [
      metric({ id: 'a', visits: 10 }),
      metric({ id: 'b', visits: 30 }),
      metric({ id: 'c', visits: 5 }),
      metric({ id: 'd', visits: 50 }),
    ];
    const counts = new Map<string, RangeVisitCount>([
      ['a', { visits: 3, persons: 6 }],
      ['b', { visits: 3, persons: 12 }], // gleiche Besuche wie a, mehr Personen → vor a
      ['c', { visits: 5, persons: 10 }], // meiste Besuche → zuerst
      ['d', { visits: 0, persons: 0 }],  // 0 → ausgeschlossen
    ]);
    const top = buildTopList(metrics, counts, 2);
    expect(top.map(r => r.metric.id)).toEqual(['c', 'b']);
    expect(top[0].rangeVisits).toBe(5);
  });

  it('schliesst Gäste ohne Besuch im Zeitraum aus', () => {
    const top = buildTopList([metric({ id: 'a', visits: 4 })], new Map(), 10);
    expect(top).toHaveLength(0);
  });
});

// ── Flop-Liste ────────────────────────────────────────────────────────────────

describe('buildFlopList', () => {
  it('listet früher aktive Gäste ohne Besuch im Zeitraum, Tier↓ → Besuche↓ → Abwesenheit↓', () => {
    const metrics = [
      metric({ id: 'vip', visits: 25, daysSinceLastVisit: 100 }),
      metric({ id: 'reg1', visits: 10, daysSinceLastVisit: 200 }),
      metric({ id: 'reg2', visits: 10, daysSinceLastVisit: 50 }),
      metric({ id: 'never', visits: 0, daysSinceLastVisit: null }), // nie aktiv → raus
      metric({ id: 'active', visits: 5, daysSinceLastVisit: 10 }),  // im Zeitraum aktiv → raus
    ];
    const counts = new Map<string, RangeVisitCount>([['active', { visits: 2, persons: 4 }]]);
    const flop = buildFlopList(metrics, counts, 50);
    expect(flop.map(r => r.metric.id)).toEqual(['vip', 'reg1', 'reg2']);
    expect(flop.every(r => r.rangeVisits === 0)).toBe(true);
  });

  it('respektiert das Limit', () => {
    const metrics = Array.from({ length: 60 }, (_, i) => metric({ id: `g${i}`, visits: 5, daysSinceLastVisit: i }));
    expect(buildFlopList(metrics, new Map(), 50)).toHaveLength(50);
  });
});
