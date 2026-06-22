// @vitest-environment node
/**
 * Tests für die reine Filter-/Sortierlogik der Gästeliste (guest-list-filters.ts).
 * Ausschliesslich synthetische Daten — keine echten Gästedaten / PII.
 */

import { describe, it, expect } from 'vitest';
import type { GuestListMetrics, GuestSegment } from '../reservation-crm';
import { NO_SHOW_RISK_MIN } from '../reservation-dashboard';
import { EMPTY_CRM_PROFILE, type GuestCrmProfile } from '../guest-crm-profile';
import {
  DEFAULT_GUEST_FILTERS,
  hasActiveFilters,
  applyGuestFilters,
  searchAndFilterGuests,
  matchSearch,
  matchCrmMerkmale,
  sortGuests,
  type GuestFilterState,
  type CrmMerkmal,
} from '../guest-list-filters';

/** Baut ein manuelles CRM-Profil mit gezielten Overrides (synthetisch). */
function crm(over: Partial<GuestCrmProfile> = {}): GuestCrmProfile {
  return { ...EMPTY_CRM_PROFILE, ...over };
}

// ── Synthetische Metrik-Fabrik ────────────────────────────────────────────────

let seq = 0;
function metric(over: Partial<GuestListMetrics> = {}): GuestListMetrics {
  seq += 1;
  return {
    id: `g-${seq}`,
    displayName: `Gast ${seq}`,
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
    segment: 'ohne_besuch' as GuestSegment,
    ...over,
  };
}

function filters(over: Partial<GuestFilterState> = {}): GuestFilterState {
  return { ...DEFAULT_GUEST_FILTERS, ...over };
}

const ids = (ms: GuestListMetrics[]) => ms.map(m => m.id);

// ── hasActiveFilters ──────────────────────────────────────────────────────────

describe('hasActiveFilters', () => {
  it('Default ist inaktiv', () => {
    expect(hasActiveFilters(DEFAULT_GUEST_FILTERS)).toBe(false);
  });
  it('erkennt jeden einzelnen aktiven Filter', () => {
    expect(hasActiveFilters(filters({ segment: 'vip' }))).toBe(true);
    expect(hasActiveFilters(filters({ visitCount: '2-4' }))).toBe(true);
    expect(hasActiveFilters(filters({ lastVisit: '30' }))).toBe(true);
    expect(hasActiveFilters(filters({ partySize: '5+' }))).toBe(true);
    expect(hasActiveFilters(filters({ noShow: 'risk' }))).toBe(true);
    expect(hasActiveFilters(filters({ returnRisk: 'risk' }))).toBe(true);
  });
  it('erkennt eine aktive CRM-Merkmal-Auswahl', () => {
    expect(hasActiveFilters(filters({ crmMerkmale: ['vipManual'] }))).toBe(true);
    expect(hasActiveFilters(filters({ crmMerkmale: ['stammgastManual', 'newsletter'] }))).toBe(true);
    expect(hasActiveFilters(filters({ crmMerkmale: [] }))).toBe(false);
  });
});

// ── Segment-Filter ────────────────────────────────────────────────────────────

describe('Segment-Filter', () => {
  const data = [
    metric({ id: 'vip', segment: 'vip' }),
    metric({ id: 'stamm', segment: 'stammgast' }),
    metric({ id: 'ohne', segment: 'ohne_besuch' }),
  ];
  it('alle lässt alles durch', () => {
    expect(applyGuestFilters(data, filters())).toHaveLength(3);
  });
  it('filtert auf ein Segment', () => {
    expect(ids(applyGuestFilters(data, filters({ segment: 'vip' })))).toEqual(['vip']);
  });
});

// ── Besuchsanzahl-Filter ──────────────────────────────────────────────────────

describe('Besuchsanzahl-Filter', () => {
  const data = [
    metric({ id: 'v0', visits: 0 }),
    metric({ id: 'v1', visits: 1 }),
    metric({ id: 'v3', visits: 3 }),
    metric({ id: 'v7', visits: 7 }),
    metric({ id: 'v15', visits: 15 }),
  ];
  it('genau 1 Besuch', () => {
    expect(ids(applyGuestFilters(data, filters({ visitCount: '1' })))).toEqual(['v1']);
  });
  it('2 bis 4 Besuche', () => {
    expect(ids(applyGuestFilters(data, filters({ visitCount: '2-4' })))).toEqual(['v3']);
  });
  it('5 bis 10 Besuche', () => {
    expect(ids(applyGuestFilters(data, filters({ visitCount: '5-10' })))).toEqual(['v7']);
  });
  it('mehr als 10 Besuche', () => {
    expect(ids(applyGuestFilters(data, filters({ visitCount: '10+' })))).toEqual(['v15']);
  });
});

// ── Letzter-Besuch-Filter ─────────────────────────────────────────────────────

describe('Letzter-Besuch-Filter', () => {
  const data = [
    metric({ id: 'd10', daysSinceLastVisit: 10 }),
    metric({ id: 'd45', daysSinceLastVisit: 45 }),
    metric({ id: 'd80', daysSinceLastVisit: 80 }),
    metric({ id: 'd200', daysSinceLastVisit: 200 }),
    metric({ id: 'never', daysSinceLastVisit: null }),
  ];
  it('letzte 30 Tage', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: '30' })))).toEqual(['d10']);
  });
  it('letzte 60 Tage', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: '60' })))).toEqual(['d10', 'd45']);
  });
  it('letzte 90 Tage', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: '90' })))).toEqual(['d10', 'd45', 'd80']);
  });
  it('älter als 90 Tage', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: 'older90' })))).toEqual(['d200']);
  });
  it('älter als 180 Tage', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: 'older180' })))).toEqual(['d200']);
  });
  it('Gäste ohne Besuch (null) fallen aus jedem Aktualitätsfilter', () => {
    expect(ids(applyGuestFilters(data, filters({ lastVisit: '90' })))).not.toContain('never');
    expect(ids(applyGuestFilters(data, filters({ lastVisit: 'older90' })))).not.toContain('never');
  });
});

// ── Gruppengrössen-Filter (gerundeter Ø) ──────────────────────────────────────

describe('Gruppengrössen-Filter', () => {
  const data = [
    metric({ id: 'p1', avgPartySize: 1.2 }),    // → 1
    metric({ id: 'p2', avgPartySize: 2.4 }),    // → 2
    metric({ id: 'p3', avgPartySize: 3.5 }),    // → 4
    metric({ id: 'p6', avgPartySize: 6 }),      // → 6
    metric({ id: 'pnull', avgPartySize: null }),
  ];
  it('1 Person (gerundet)', () => {
    expect(ids(applyGuestFilters(data, filters({ partySize: '1' })))).toEqual(['p1']);
  });
  it('2 Personen (gerundet)', () => {
    expect(ids(applyGuestFilters(data, filters({ partySize: '2' })))).toEqual(['p2']);
  });
  it('3 bis 4 Personen (gerundet)', () => {
    expect(ids(applyGuestFilters(data, filters({ partySize: '3-4' })))).toEqual(['p3']);
  });
  it('5+ Personen', () => {
    expect(ids(applyGuestFilters(data, filters({ partySize: '5+' })))).toEqual(['p6']);
  });
  it('null avgPartySize fällt aus jedem Gruppengrössenfilter', () => {
    expect(ids(applyGuestFilters(data, filters({ partySize: '5+' })))).not.toContain('pnull');
  });
});

// ── No-Show-Risiko-Filter ─────────────────────────────────────────────────────

describe('No-Show-Risiko-Filter', () => {
  const data = [
    metric({ id: 'n0', noShowCount: 0 }),
    metric({ id: 'n1', noShowCount: NO_SHOW_RISK_MIN - 1 }),
    metric({ id: 'n2', noShowCount: NO_SHOW_RISK_MIN }),
    metric({ id: 'n5', noShowCount: NO_SHOW_RISK_MIN + 3 }),
  ];
  it('mit Risiko (≥ Schwelle)', () => {
    expect(ids(applyGuestFilters(data, filters({ noShow: 'risk' })))).toEqual(['n2', 'n5']);
  });
  it('ohne Risiko (< Schwelle)', () => {
    expect(ids(applyGuestFilters(data, filters({ noShow: 'norisk' })))).toEqual(['n0', 'n1']);
  });
});

// ── Rückkehrpotenzial-Filter ──────────────────────────────────────────────────

describe('Rückkehrpotenzial-Filter', () => {
  const data = [
    // gefährdet: Quote 3.0 (≥ Faktor 2), genügend Besuche
    metric({ id: 'risk', visits: 10, daysSinceLastVisit: 60, avgDaysBetweenVisits: 20 }),
    // im Rhythmus: Quote 1.0
    metric({ id: 'ontime', visits: 10, daysSinceLastVisit: 20, avgDaysBetweenVisits: 20 }),
    // zu wenige Besuche → kein belastbares Intervall
    metric({ id: 'tooFew', visits: 2, daysSinceLastVisit: 200, avgDaysBetweenVisits: null }),
    // ohne Besuch
    metric({ id: 'never', visits: 0, daysSinceLastVisit: null, avgDaysBetweenVisits: null }),
  ];
  it('alle lässt alles durch', () => {
    expect(applyGuestFilters(data, filters())).toHaveLength(4);
  });
  it('nur gefährdete Stammgäste', () => {
    expect(ids(applyGuestFilters(data, filters({ returnRisk: 'risk' })))).toEqual(['risk']);
  });
});

// ── Sortierung nach Rückkehr-Risiko ───────────────────────────────────────────

describe('sortGuests — returnRisk', () => {
  const data = [
    metric({ id: 'r3', visits: 5, daysSinceLastVisit: 60, avgDaysBetweenVisits: 20 }), // 3.0
    metric({ id: 'r1', visits: 5, daysSinceLastVisit: 20, avgDaysBetweenVisits: 20 }), // 1.0
    metric({ id: 'rnull', visits: 1, daysSinceLastVisit: 50, avgDaysBetweenVisits: null }), // null
  ];
  it('absteigend: höchste Überfälligkeit zuerst, null ans Ende', () => {
    expect(ids(sortGuests(data, 'returnRisk', 'desc'))).toEqual(['r3', 'r1', 'rnull']);
  });
  it('aufsteigend: null zuerst', () => {
    expect(ids(sortGuests(data, 'returnRisk', 'asc'))).toEqual(['rnull', 'r1', 'r3']);
  });
});

// ── Kombination mehrerer Filter ───────────────────────────────────────────────

describe('Filter-Kombination (UND)', () => {
  it('verknüpft Segment + Besuchsanzahl + Risiko UND', () => {
    const data = [
      metric({ id: 'a', segment: 'stammgast', visits: 10, noShowCount: 2 }),
      metric({ id: 'b', segment: 'stammgast', visits: 10, noShowCount: 0 }),
      metric({ id: 'c', segment: 'vip', visits: 10, noShowCount: 2 }),
    ];
    const out = applyGuestFilters(data, filters({ segment: 'stammgast', visitCount: '5-10', noShow: 'risk' }));
    expect(ids(out)).toEqual(['a']);
  });
});

// ── Suche ─────────────────────────────────────────────────────────────────────

describe('matchSearch', () => {
  const m = metric({ displayName: 'Anna Beispiel', email: 'anna@example.test', mobile: '0790000000' });
  it('leere Anfrage lässt alles durch', () => {
    expect(matchSearch(m, '   ')).toBe(true);
  });
  it('findet über Name, E-Mail, Telefon (case-insensitive)', () => {
    expect(matchSearch(m, 'anna')).toBe(true);
    expect(matchSearch(m, 'EXAMPLE')).toBe(true);
    expect(matchSearch(m, '079')).toBe(true);
    expect(matchSearch(m, 'zzz')).toBe(false);
  });
});

describe('searchAndFilterGuests', () => {
  it('kombiniert Suche und Filter', () => {
    const data = [
      metric({ id: 'x', displayName: 'Max', segment: 'vip' }),
      metric({ id: 'y', displayName: 'Maxime', segment: 'neukunde' }),
      metric({ id: 'z', displayName: 'Erik', segment: 'vip' }),
    ];
    expect(ids(searchAndFilterGuests(data, 'max', filters({ segment: 'vip' })))).toEqual(['x']);
  });
});

// ── Sortierung ────────────────────────────────────────────────────────────────

describe('sortGuests', () => {
  const data = [
    metric({ id: 'a', visits: 5, avgPartySize: 4, daysSinceLastVisit: 10, avgDaysBetweenVisits: 30 }),
    metric({ id: 'b', visits: 2, avgPartySize: 1, daysSinceLastVisit: 50, avgDaysBetweenVisits: 10 }),
    metric({ id: 'c', visits: 9, avgPartySize: 2, daysSinceLastVisit: 5, avgDaysBetweenVisits: 90 }),
  ];
  it('Besuche absteigend / aufsteigend', () => {
    expect(ids(sortGuests(data, 'visits', 'desc'))).toEqual(['c', 'a', 'b']);
    expect(ids(sortGuests(data, 'visits', 'asc'))).toEqual(['b', 'a', 'c']);
  });
  it('Gruppengrösse absteigend / aufsteigend', () => {
    expect(ids(sortGuests(data, 'partySize', 'desc'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortGuests(data, 'partySize', 'asc'))).toEqual(['b', 'c', 'a']);
  });
  it('Intervall absteigend', () => {
    expect(ids(sortGuests(data, 'interval', 'desc'))).toEqual(['c', 'a', 'b']);
  });
  it('mutiert die Eingabe nicht', () => {
    const before = ids(data);
    sortGuests(data, 'visits', 'desc');
    expect(ids(data)).toEqual(before);
  });
  it('null-Werte landen ans untere Ende (aufsteigend)', () => {
    const withNull = [
      metric({ id: 'has', avgPartySize: 3 }),
      metric({ id: 'none', avgPartySize: null }),
    ];
    expect(ids(sortGuests(withNull, 'partySize', 'asc'))).toEqual(['none', 'has']);
  });
});

// ── Manuelle CRM-Merkmale (Mehrfachauswahl, UND) ──────────────────────────────

describe('CRM-Merkmale (Mehrfachauswahl, UND-verknüpft)', () => {
  // „yes" hat das Merkmal, „no" hat ein Profil ohne Merkmal, „none" hat gar kein Profil.
  const build = (id: string, c: GuestCrmProfile | null) => metric({ id, crm: c });

  const cases: Array<[CrmMerkmal, GuestCrmProfile]> = [
    ['vipManual', crm({ vipManual: true })],
    ['stammgastManual', crm({ stammgastManual: true })],
    ['companyCustomer', crm({ companyCustomer: true })],
    ['newsletter', crm({ newsletterOptIn: true })],
    ['blocked', crm({ blockedGuest: true })],
    ['hasAllergies', crm({ allergies: 'Nüsse' })],
    ['hasBirthday', crm({ birthday: '1990-05-01' })],
    ['hasCrmNote', crm({ crmNotes: 'Stammtisch' })],
  ];

  for (const [key, withFlag] of cases) {
    it(`${key}: nur Gäste mit Merkmal (Profil fehlt ⇒ nicht gesetzt)`, () => {
      const data = [
        build('yes', withFlag),
        build('no', crm()),
        build('none', null),
      ];
      expect(ids(applyGuestFilters(data, filters({ crmMerkmale: [key] })))).toEqual(['yes']);
    });
  }

  it('leere Auswahl lässt alle Gäste durch', () => {
    const data = [build('a', crm({ vipManual: true })), build('b', null)];
    expect(applyGuestFilters(data, filters({ crmMerkmale: [] }))).toHaveLength(2);
  });

  it('mehrere Merkmale sind UND-verknüpft (Gast muss alle erfüllen)', () => {
    const data = [
      build('both', crm({ vipManual: true, newsletterOptIn: true })),
      build('onlyVip', crm({ vipManual: true })),
      build('onlyNews', crm({ newsletterOptIn: true })),
      build('none', null),
    ];
    expect(ids(applyGuestFilters(data, filters({ crmMerkmale: ['vipManual', 'newsletter'] })))).toEqual(['both']);
  });

  it('leere/whitespace Allergien & Notizen zählen als „nicht gesetzt"', () => {
    const data = [
      build('blankAllerg', crm({ allergies: '   ' })),
      build('blankNote', crm({ crmNotes: '' })),
    ];
    expect(applyGuestFilters(data, filters({ crmMerkmale: ['hasAllergies'] }))).toHaveLength(0);
    expect(applyGuestFilters(data, filters({ crmMerkmale: ['hasCrmNote'] }))).toHaveLength(0);
  });

  it('verknüpft CRM-Merkmal mit Standardfiltern UND', () => {
    const data = [
      build('a', crm({ vipManual: true })),
      build('b', crm({ vipManual: true })),
      build('c', crm({ vipManual: false })),
    ];
    data[0].segment = 'vip'; data[0].visits = 20;
    data[1].segment = 'neukunde'; data[1].visits = 1;
    data[2].segment = 'vip'; data[2].visits = 20;
    expect(ids(applyGuestFilters(data, filters({ crmMerkmale: ['vipManual'], segment: 'vip' })))).toEqual(['a']);
  });

  it('matchCrmMerkmale: leere Auswahl true, fehlendes Profil false bei Auswahl', () => {
    expect(matchCrmMerkmale(metric({ crm: null }), [])).toBe(true);
    expect(matchCrmMerkmale(metric({ crm: null }), ['vipManual'])).toBe(false);
    expect(matchCrmMerkmale(metric({ crm: crm({ vipManual: true }) }), ['vipManual'])).toBe(true);
  });
});

// ── Sortierung nach manuellen CRM-Feldern ─────────────────────────────────────

describe('sortGuests — birthday & company', () => {
  it('Geburtstag aufsteigend: fehlend zuerst, dann chronologisch', () => {
    const data = [
      metric({ id: 'late', crm: crm({ birthday: '1995-12-31' }) }),
      metric({ id: 'early', crm: crm({ birthday: '1980-01-01' }) }),
      metric({ id: 'none', crm: null }),
      metric({ id: 'noField', crm: crm({ birthday: null }) }),
    ];
    expect(ids(sortGuests(data, 'birthday', 'asc'))).toEqual(['none', 'noField', 'early', 'late']);
  });
  it('Geburtstag absteigend: jüngstes Datum zuerst, fehlend zuletzt', () => {
    const data = [
      metric({ id: 'late', crm: crm({ birthday: '1995-12-31' }) }),
      metric({ id: 'early', crm: crm({ birthday: '1980-01-01' }) }),
      metric({ id: 'none', crm: null }),
    ];
    expect(ids(sortGuests(data, 'birthday', 'desc'))).toEqual(['late', 'early', 'none']);
  });
  it('Firma alphabetisch (de), fehlend zuerst aufsteigend', () => {
    const data = [
      metric({ id: 'zeta', crm: crm({ company: 'Zeta AG' }) }),
      metric({ id: 'alpha', crm: crm({ company: 'Alpha GmbH' }) }),
      metric({ id: 'none', crm: null }),
    ];
    expect(ids(sortGuests(data, 'company', 'asc'))).toEqual(['none', 'alpha', 'zeta']);
    expect(ids(sortGuests(data, 'company', 'desc'))).toEqual(['zeta', 'alpha', 'none']);
  });
});
