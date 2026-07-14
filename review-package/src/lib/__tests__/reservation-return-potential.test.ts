// @vitest-environment node
/**
 * Tests für Rückkehrpotenzial & gefährdete Stammgäste (reine Berechnung).
 * Synthetische Daten, keine PII, keine DB.  Node-Umgebung (kein jsdom/canvas).
 */
import { describe, it, expect } from 'vitest';
import {
  OVERDUE_INTERVAL_FACTOR,
  overdueByDays,
  isOverdue,
  isAtRiskTier,
  returnPotentialKpis,
  buildReturnPotentialList,
} from '../reservation-dashboard';
import { baseSegmentByVisits, type GuestListMetrics } from '../reservation-crm';

function metric(p: Partial<GuestListMetrics>): GuestListMetrics {
  return {
    id: 'g',
    displayName: 'Gast',
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

describe('baseSegmentByVisits (Tier ohne Inaktiv-Überschreibung)', () => {
  it('mappt Besuchszahlen auf das zahlbasierte Tier', () => {
    expect(baseSegmentByVisits(0)).toBe('ohne_besuch');
    expect(baseSegmentByVisits(1)).toBe('neukunde');
    expect(baseSegmentByVisits(2)).toBe('neukunde');
    expect(baseSegmentByVisits(3)).toBe('wiederkehrend');
    expect(baseSegmentByVisits(7)).toBe('wiederkehrend');
    expect(baseSegmentByVisits(8)).toBe('stammgast');
    expect(baseSegmentByVisits(19)).toBe('stammgast');
    expect(baseSegmentByVisits(20)).toBe('vip');
    expect(baseSegmentByVisits(99)).toBe('vip');
  });
});

describe('overdueByDays / isOverdue', () => {
  it('ist null ohne Ø-Intervall (< 2 Besuche)', () => {
    const m = metric({ visits: 1, daysSinceLastVisit: 500, avgDaysBetweenVisits: null });
    expect(overdueByDays(m)).toBeNull();
    expect(isOverdue(m)).toBe(false);
  });

  it('ist null ohne letzten Besuch', () => {
    const m = metric({ visits: 5, daysSinceLastVisit: null, avgDaysBetweenVisits: 30 });
    expect(overdueByDays(m)).toBeNull();
    expect(isOverdue(m)).toBe(false);
  });

  it('ist null bei < 2 Besuchen oder nicht-positivem Ø-Intervall (defensiver Guard)', () => {
    // Ø-Intervall trotz nur 1 Besuch (sollte in echten Daten nie vorkommen).
    expect(overdueByDays(metric({ visits: 1, avgDaysBetweenVisits: 30, daysSinceLastVisit: 500 }))).toBeNull();
    // Ø-Intervall 0 → keine Erwartungshaltung.
    expect(overdueByDays(metric({ visits: 5, avgDaysBetweenVisits: 0, daysSinceLastVisit: 500 }))).toBeNull();
  });

  it('verwendet den Faktor 1,5', () => {
    expect(OVERDUE_INTERVAL_FACTOR).toBe(1.5);
    // Ø-Intervall 30 → Schwelle 45 Tage.
    const exact = metric({ visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 45 });
    expect(overdueByDays(exact)).toBe(0);      // genau auf der Schwelle
    expect(isOverdue(exact)).toBe(false);      // nicht überfällig (strikt >)

    const over = metric({ visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 46 });
    expect(overdueByDays(over)).toBe(1);
    expect(isOverdue(over)).toBe(true);

    const under = metric({ visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 40 });
    expect(overdueByDays(under)).toBe(-5);
    expect(isOverdue(under)).toBe(false);
  });
});

describe('isAtRiskTier (gefährdete Stammgäste / VIP)', () => {
  it('Stammgast-Tier > 90 Tage gilt als gefährdet', () => {
    const m = metric({ visits: 10, daysSinceLastVisit: 120, segment: 'inaktiv' });
    expect(isAtRiskTier(m, 'stammgast')).toBe(true);
    expect(isAtRiskTier(m, 'vip')).toBe(false);
  });

  it('VIP-Tier > 90 Tage gilt als gefährdet — auch wenn Live-Segment „inaktiv" ist', () => {
    // Kern-Edge-Case: classifySegment hätte hier längst „inaktiv" gesetzt.
    const m = metric({ visits: 25, daysSinceLastVisit: 200, segment: 'inaktiv' });
    expect(isAtRiskTier(m, 'vip')).toBe(true);
    expect(isAtRiskTier(m, 'stammgast')).toBe(false);
  });

  it('genau 90 Tage ist NICHT gefährdet (strikt > 90)', () => {
    const m = metric({ visits: 10, daysSinceLastVisit: 90 });
    expect(isAtRiskTier(m, 'stammgast')).toBe(false);
  });

  it('aktiver Stammgast (≤ 90 Tage) ist nicht gefährdet', () => {
    const m = metric({ visits: 10, daysSinceLastVisit: 30, segment: 'stammgast' });
    expect(isAtRiskTier(m, 'stammgast')).toBe(false);
  });

  it('niedrigere Tiers (wiederkehrend/neukunde) zählen nie als gefährdet', () => {
    const m = metric({ visits: 5, daysSinceLastVisit: 300 });
    expect(isAtRiskTier(m, 'stammgast')).toBe(false);
    expect(isAtRiskTier(m, 'vip')).toBe(false);
  });

  it('ohne letzten Besuch ist nicht gefährdet', () => {
    const m = metric({ visits: 10, daysSinceLastVisit: null });
    expect(isAtRiskTier(m, 'stammgast')).toBe(false);
  });
});

describe('returnPotentialKpis', () => {
  it('zählt überfällige, gefährdete Stammgäste und VIP getrennt', () => {
    const metrics: GuestListMetrics[] = [
      // überfälliger Wiederkehrer (kein gefährdetes Tier)
      metric({ id: 'a', visits: 5, avgDaysBetweenVisits: 20, daysSinceLastVisit: 60 }),
      // gefährdeter Stammgast (auch überfällig)
      metric({ id: 'b', visits: 10, avgDaysBetweenVisits: 30, daysSinceLastVisit: 120, segment: 'inaktiv' }),
      // gefährdeter VIP (auch überfällig)
      metric({ id: 'c', visits: 30, avgDaysBetweenVisits: 14, daysSinceLastVisit: 200, segment: 'inaktiv' }),
      // aktiver VIP (nicht gefährdet, nicht überfällig)
      metric({ id: 'd', visits: 25, avgDaysBetweenVisits: 14, daysSinceLastVisit: 10, segment: 'vip' }),
      // ohne Intervall → nicht überfällig
      metric({ id: 'e', visits: 1, daysSinceLastVisit: 400 }),
    ];
    const k = returnPotentialKpis(metrics);
    expect(k.overdueGuests).toBe(3);       // a, b, c
    expect(k.atRiskStammgaeste).toBe(1);   // b
    expect(k.atRiskVips).toBe(1);          // c
  });

  it('leere Liste → alle Kacheln 0', () => {
    expect(returnPotentialKpis([])).toEqual({ overdueGuests: 0, atRiskStammgaeste: 0, atRiskVips: 0 });
  });
});

describe('buildReturnPotentialList', () => {
  it('enthält nur überfällige Gäste, am überfälligsten zuerst', () => {
    const metrics: GuestListMetrics[] = [
      metric({ id: 'klein', visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 46 }),   // overdue 1
      metric({ id: 'gross', visits: 8, avgDaysBetweenVisits: 30, daysSinceLastVisit: 200 }),  // overdue 155
      metric({ id: 'mittel', visits: 4, avgDaysBetweenVisits: 30, daysSinceLastVisit: 90 }),  // overdue 45
      metric({ id: 'aktiv', visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 20 }),   // nicht überfällig
      metric({ id: 'einmal', visits: 1, daysSinceLastVisit: 999 }),                            // kein Intervall
    ];
    const list = buildReturnPotentialList(metrics);
    expect(list.map(r => r.id)).toEqual(['gross', 'mittel', 'klein']);
    expect(list[0].overdueByDays).toBe(155);
    expect(list[2].overdueByDays).toBe(1);
  });

  it('übernimmt die Anzeigefelder unverändert', () => {
    const m = metric({
      id: 'x', displayName: 'Anna B.', segment: 'inaktiv',
      visits: 12, avgDaysBetweenVisits: 25, lastVisit: '2026-01-01', daysSinceLastVisit: 150,
    });
    const [row] = buildReturnPotentialList([m]);
    expect(row).toMatchObject({
      id: 'x', displayName: 'Anna B.', segment: 'inaktiv',
      visits: 12, avgDaysBetweenVisits: 25, lastVisit: '2026-01-01', daysSinceLastVisit: 150,
    });
    expect(row.overdueByDays).toBeCloseTo(150 - 25 * 1.5);
  });

  it('leere Liste, wenn niemand überfällig ist', () => {
    const metrics = [metric({ id: 'a', visits: 5, avgDaysBetweenVisits: 30, daysSinceLastVisit: 10 })];
    expect(buildReturnPotentialList(metrics)).toEqual([]);
  });
});
