// @vitest-environment node
/**
 * Tests für die Gäste-CRM-Berechnungslogik (reservation-crm.ts).
 * Ausschliesslich synthetische Daten — KEINE echte PII.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySegment,
  averageDaysBetweenVisits,
  daysBetween,
  daysSince,
  guestDisplayName,
  guestListMetrics,
  guestDetailMetrics,
  countSegments,
  returnRiskRatio,
  isAtReturnRisk,
  RETURN_RISK_MIN_VISITS,
  RETURN_RISK_FACTOR,
  type GuestProfile,
  type GuestReservationRecord,
} from '../reservation-crm';
import type { ReservationStatusNormalized } from '../reservation-import-parser';

const TODAY = '2026-06-19';

function profile(over: Partial<GuestProfile> = {}): GuestProfile {
  return {
    id: 'g1',
    restaurant_id: 'oliv',
    first_name: 'Test',
    last_name: 'Gast',
    email: 'test.gast@example.test',
    mobile: '+41000000000',
    first_seen_at: '2026-01-01',
    last_seen_at: '2026-06-01',
    total_reservations: 5,
    total_persons: 10,
    cancelled_reservations: 0,
    completed_reservations: 5,
    ...over,
  };
}

function res(
  date: string | null,
  status: ReservationStatusNormalized,
  partySize: number | null = 2,
): GuestReservationRecord {
  return {
    reservationDate: date,
    reservationTime: '19:00',
    partySize,
    statusNormalized: status,
    room: 'Hauptraum',
    area: 'Innen',
    note: null,
    comment: null,
  };
}

describe('Datums-Helfer', () => {
  it('daysBetween rechnet vorzeichenbehaftet', () => {
    expect(daysBetween('2026-06-01', '2026-06-11')).toBe(10);
    expect(daysBetween('2026-06-11', '2026-06-01')).toBe(-10);
    expect(daysBetween(null, '2026-06-01')).toBeNull();
    expect(daysBetween('2026-06-01', undefined)).toBeNull();
  });

  it('daysSince ist nie negativ', () => {
    expect(daysSince('2026-06-09', TODAY)).toBe(10);
    expect(daysSince('2026-06-19', TODAY)).toBe(0);
    expect(daysSince('2026-12-31', TODAY)).toBe(0); // Zukunft → 0
    expect(daysSince(null, TODAY)).toBeNull();
  });
});

describe('averageDaysBetweenVisits', () => {
  it('liefert null bei weniger als zwei Besuchen', () => {
    expect(averageDaysBetweenVisits('2026-01-01', '2026-01-01', 1)).toBeNull();
    expect(averageDaysBetweenVisits('2026-01-01', '2026-06-01', 0)).toBeNull();
  });

  it('= Spanne / (Besuche − 1)', () => {
    // 100 Tage Spanne, 5 Besuche → 4 Intervalle → 25 Tage
    expect(averageDaysBetweenVisits('2026-01-01', '2026-04-11', 5)).toBe(25);
  });

  it('null bei nicht-positiver Spanne', () => {
    expect(averageDaysBetweenVisits('2026-06-01', '2026-06-01', 3)).toBeNull();
  });
});

describe('classifySegment — Schwellen', () => {
  it('0 Besuche → ohne_besuch', () => {
    expect(classifySegment(0, null)).toBe('ohne_besuch');
    expect(classifySegment(0, 200)).toBe('ohne_besuch');
  });

  it('1–2 → neukunde', () => {
    expect(classifySegment(1, 0)).toBe('neukunde');
    expect(classifySegment(2, 10)).toBe('neukunde');
  });

  it('3–7 → wiederkehrend', () => {
    expect(classifySegment(3, 0)).toBe('wiederkehrend');
    expect(classifySegment(7, 5)).toBe('wiederkehrend');
  });

  it('8–19 → stammgast', () => {
    expect(classifySegment(8, 0)).toBe('stammgast');
    expect(classifySegment(19, 10)).toBe('stammgast');
  });

  it('≥20 → vip', () => {
    expect(classifySegment(20, 0)).toBe('vip');
    expect(classifySegment(50, 30)).toBe('vip');
  });
});

describe('classifySegment — Inaktiv-Regel', () => {
  it('≥3 Besuche und > 90 Tage seit letztem Besuch → inaktiv', () => {
    expect(classifySegment(5, 91)).toBe('inaktiv');
    expect(classifySegment(3, 200)).toBe('inaktiv');
  });

  it('genau 90 Tage ist NICHT inaktiv (Schwelle ist strikt > 90)', () => {
    expect(classifySegment(5, 90)).toBe('wiederkehrend');
  });

  it('weniger als 3 Besuche wird nie inaktiv (bleibt neukunde)', () => {
    expect(classifySegment(2, 365)).toBe('neukunde');
    expect(classifySegment(1, 365)).toBe('neukunde');
  });

  it('Inaktiv überschreibt VIP/Stammgast bei langer Abwesenheit', () => {
    expect(classifySegment(25, 120)).toBe('inaktiv');
    expect(classifySegment(10, 120)).toBe('inaktiv');
  });

  it('unbekannte Tage seit letztem Besuch → zahlbasiert (nicht inaktiv)', () => {
    expect(classifySegment(5, null)).toBe('wiederkehrend');
  });
});

describe('guestDisplayName', () => {
  it('Name vor E-Mail vor Mobile vor Fallback', () => {
    expect(guestDisplayName({ first_name: 'A', last_name: 'B', email: 'x@y.z', mobile: '1' })).toBe('A B');
    expect(guestDisplayName({ first_name: null, last_name: null, email: 'x@y.z', mobile: '1' })).toBe('x@y.z');
    expect(guestDisplayName({ first_name: null, last_name: null, email: null, mobile: '12345' })).toBe('12345');
    expect(guestDisplayName({ first_name: null, last_name: null, email: null, mobile: null })).toBe('Unbekannter Gast');
  });
});

describe('guestListMetrics', () => {
  it('berechnet Besuche, Intervall und Segment aus dem Profil', () => {
    const m = guestListMetrics(
      profile({
        total_reservations: 6,
        cancelled_reservations: 1,
      }),
      { visits: 5, firstVisit: '2026-01-01', lastVisit: '2026-04-11' },
      TODAY,
    );
    expect(m.visits).toBe(5);
    expect(m.totalReservations).toBe(6);
    expect(m.cancelledReservations).toBe(1);
    expect(m.avgDaysBetweenVisits).toBe(25);
    expect(m.daysSinceLastVisit).toBe(daysSince('2026-04-11', TODAY));
    expect(m.segment).toBe('wiederkehrend');
  });

  it('markiert lange abwesende Stammgäste als inaktiv', () => {
    const m = guestListMetrics(
      profile(),
      { visits: 12, firstVisit: '2025-01-01', lastVisit: '2026-01-01' },
      TODAY,
    );
    expect(m.segment).toBe('inaktiv');
  });

  it('nutzt abgeschlossene Besuchsdaten, nicht das Profil-last_seen_at (Konsistenz mit Detail)', () => {
    // Profil meldet kürzliche Aktivität (z. B. offene/künftige Reservation),
    // der letzte ABGESCHLOSSENE Besuch liegt aber > 90 Tage zurück.
    const m = guestListMetrics(
      profile({ last_seen_at: TODAY, first_seen_at: '2025-01-01' }),
      { visits: 6, firstVisit: '2025-01-01', lastVisit: '2026-01-01' },
      TODAY,
    );
    expect(m.lastVisit).toBe('2026-01-01');
    expect(m.daysSinceLastVisit).toBe(daysSince('2026-01-01', TODAY));
    expect(m.segment).toBe('inaktiv');
  });

  it('0 abgeschlossene Besuche → ohne_besuch', () => {
    const m = guestListMetrics(
      profile({ cancelled_reservations: 2, total_reservations: 2 }),
      undefined,
      TODAY,
    );
    expect(m.visits).toBe(0);
    expect(m.segment).toBe('ohne_besuch');
    expect(m.avgDaysBetweenVisits).toBeNull();
  });

  it('verträgt fehlende Aggregate/Besuche', () => {
    const m = guestListMetrics(
      profile({
        total_reservations: null,
        cancelled_reservations: null,
        first_seen_at: null,
        last_seen_at: null,
      }),
      undefined,
      TODAY,
    );
    expect(m.visits).toBe(0);
    expect(m.daysSinceLastVisit).toBeNull();
    expect(m.segment).toBe('ohne_besuch');
  });
});

describe('guestDetailMetrics', () => {
  it('zählt abgeschlossen/storniert/no-show und berechnet Besuche aus den Reservationen', () => {
    const reservations: GuestReservationRecord[] = [
      res('2026-01-01', 'completed', 2),
      res('2026-02-01', 'completed', 4),
      res('2026-03-01', 'cancelled', 2),
      res('2026-04-01', 'noshow', 3),
      res('2026-04-11', 'completed', 6),
    ];
    const m = guestDetailMetrics(reservations, TODAY);
    expect(m.totalReservations).toBe(5);
    expect(m.visits).toBe(3);
    expect(m.completedCount).toBe(3);
    expect(m.cancelledCount).toBe(1);
    expect(m.noShowCount).toBe(1);
    expect(m.firstVisit).toBe('2026-01-01');
    expect(m.lastVisit).toBe('2026-04-11');
    // 100 Tage Spanne / 2 Intervalle = 50
    expect(m.avgDaysBetweenVisits).toBe(50);
    // Ø Gruppe nur über abgeschlossene: (2+4+6)/3 = 4
    expect(m.avgPartySize).toBe(4);
    expect(m.segment).toBe('wiederkehrend');
  });

  it('ignoriert fehlende Daten/Personenzahlen sauber', () => {
    const reservations: GuestReservationRecord[] = [
      res(null, 'completed', null),
      res('2026-05-01', 'completed', null),
    ];
    const m = guestDetailMetrics(reservations, TODAY);
    expect(m.visits).toBe(2);
    expect(m.firstVisit).toBe('2026-05-01');
    expect(m.lastVisit).toBe('2026-05-01');
    expect(m.avgPartySize).toBeNull();
    // nur ein datierter Besuch → Intervall null
    expect(m.avgDaysBetweenVisits).toBeNull();
  });

  it('leere Reservationsliste → ohne_besuch', () => {
    const m = guestDetailMetrics([], TODAY);
    expect(m.visits).toBe(0);
    expect(m.segment).toBe('ohne_besuch');
    expect(m.avgPartySize).toBeNull();
    expect(m.daysSinceLastVisit).toBeNull();
  });
});

describe('returnRiskRatio', () => {
  it('= Tage seit letztem Besuch ÷ Ø-Intervall', () => {
    expect(returnRiskRatio({ visits: 5, daysSinceLastVisit: 60, avgDaysBetweenVisits: 30 })).toBe(2);
    expect(returnRiskRatio({ visits: 4, daysSinceLastVisit: 45, avgDaysBetweenVisits: 30 })).toBe(1.5);
  });

  it('null bei zu wenigen Besuchen (Intervall nicht belastbar)', () => {
    expect(returnRiskRatio({ visits: RETURN_RISK_MIN_VISITS - 1, daysSinceLastVisit: 200, avgDaysBetweenVisits: 10 })).toBeNull();
  });

  it('null bei fehlenden/unbrauchbaren Kennzahlen', () => {
    expect(returnRiskRatio({ visits: 5, daysSinceLastVisit: null, avgDaysBetweenVisits: 30 })).toBeNull();
    expect(returnRiskRatio({ visits: 5, daysSinceLastVisit: 60, avgDaysBetweenVisits: null })).toBeNull();
    expect(returnRiskRatio({ visits: 5, daysSinceLastVisit: 60, avgDaysBetweenVisits: 0 })).toBeNull();
  });
});

describe('isAtReturnRisk', () => {
  it('gefährdet, sobald Quote ≥ Schwellenfaktor', () => {
    expect(isAtReturnRisk({ visits: 5, daysSinceLastVisit: 60, avgDaysBetweenVisits: 30 })).toBe(true); // 2.0
    expect(isAtReturnRisk({ visits: 5, daysSinceLastVisit: 90, avgDaysBetweenVisits: 30 })).toBe(true); // 3.0
  });

  it('nicht gefährdet im gewohnten Rhythmus (Quote < Faktor)', () => {
    expect(isAtReturnRisk({ visits: 5, daysSinceLastVisit: 30, avgDaysBetweenVisits: 30 })).toBe(false); // 1.0
    expect(isAtReturnRisk({ visits: 5, daysSinceLastVisit: 45, avgDaysBetweenVisits: 30 })).toBe(false); // 1.5
  });

  it('genau am Schwellenfaktor zählt als gefährdet', () => {
    expect(isAtReturnRisk({ visits: 5, daysSinceLastVisit: RETURN_RISK_FACTOR * 20, avgDaysBetweenVisits: 20 })).toBe(true);
  });

  it('erfasst auch (noch) nicht inaktive Gäste früh (< 90 Tage abwesend)', () => {
    // Ø-Intervall 7 Tage, seit 21 Tagen weg → Quote 3.0, aber noch nicht „inaktiv".
    const m = { visits: 10, daysSinceLastVisit: 21, avgDaysBetweenVisits: 7 };
    expect(isAtReturnRisk(m)).toBe(true);
    expect(classifySegment(m.visits, m.daysSinceLastVisit)).not.toBe('inaktiv');
  });

  it('Gäste mit zu wenigen Besuchen sind nie gefährdet', () => {
    expect(isAtReturnRisk({ visits: RETURN_RISK_MIN_VISITS - 1, daysSinceLastVisit: 365, avgDaysBetweenVisits: 5 })).toBe(false);
  });
});

describe('countSegments', () => {
  it('zählt je Segment', () => {
    const metrics = [
      guestListMetrics(profile(), { visits: 25, firstVisit: '2024-01-01', lastVisit: TODAY }, TODAY),
      guestListMetrics(profile(), { visits: 10, firstVisit: '2025-01-01', lastVisit: TODAY }, TODAY),
      guestListMetrics(profile(), { visits: 1, firstVisit: TODAY, lastVisit: TODAY }, TODAY),
      guestListMetrics(profile(), undefined, TODAY),
    ];
    const counts = countSegments(metrics);
    expect(counts.vip).toBe(1);
    expect(counts.stammgast).toBe(1);
    expect(counts.neukunde).toBe(1);
    expect(counts.ohne_besuch).toBe(1);
    expect(counts.wiederkehrend).toBe(0);
  });
});
