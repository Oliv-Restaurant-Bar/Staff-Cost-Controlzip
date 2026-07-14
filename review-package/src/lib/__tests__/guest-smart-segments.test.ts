// @vitest-environment node
/**
 * Tests für die Gäste-CRM Smart-Segmente (reine Berechnungs-/Export-Logik).
 * Ausschliesslich synthetische Daten, keine PII, keine DB, keine DOM-Abhängigkeit.
 * Node-Umgebung (kein jsdom/canvas).
 *
 * Deckt jede der 7 Segmentregeln an ihren Grenzwerten ab, die jahresunabhängige
 * Geburtstagslogik (inkl. Jahreswechsel + 29.02.), die Mehrfach-Zuordnung sowie
 * Filterung, Zusammenfassung und CSV-/Excel-Export.
 */
import { describe, it, expect } from 'vitest';
import type { GuestListMetrics } from '@/lib/reservation-crm';
import type { GuestCrmProfile } from '@/lib/guest-crm-profile';
import { EMPTY_CRM_PROFILE } from '@/lib/guest-crm-profile';
import { CSV_HEADERS } from '@/lib/reservation-campaigns';
import {
  SMART_SEGMENT_ORDER,
  SMART_SEGMENT_LABEL,
  SMART_SEGMENT_SLUG,
  SMART_SEGMENT_FILTER_OPTIONS,
  SMART_VIP_MIN,
  SMART_REGULAR_MIN,
  SMART_NEW_DAYS,
  SMART_AT_RISK_DAYS,
  SMART_LOST_DAYS,
  SMART_BIRTHDAY_WINDOW_DAYS,
  daysUntilBirthday,
  isUpcomingBirthday,
  hasSmartSegment,
  guestSmartSegments,
  filterBySmartSegment,
  summarizeSmartSegments,
  smartSegmentExportTable,
} from '@/lib/guest-smart-segments';

const TODAY = '2026-06-24';

/** Verschiebt ein ISO-Datum (UTC-Tagesarithmetik) um n Tage in die Vergangenheit. */
function isoMinusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * 86400000).toISOString().slice(0, 10);
}

/** Verschiebt ein ISO-Datum um n Tage in die Zukunft. */
function isoPlusDays(iso: string, n: number): string {
  return isoMinusDays(iso, -n);
}

/** Baut eine GuestListMetrics-Testzeile mit sinnvollen Defaults. */
function mk(over: Partial<GuestListMetrics> = {}): GuestListMetrics {
  return {
    id: 'g1',
    displayName: 'Test',
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
    crm: null,
    ...over,
  };
}

function crmWithBirthday(birthday: string | null): GuestCrmProfile {
  return { ...EMPTY_CRM_PROFILE, birthday };
}

describe('Schwellenwerte sind die erwarteten Konstanten', () => {
  it('verwendet die wiederverwendeten/vorgegebenen Schwellen', () => {
    expect(SMART_VIP_MIN).toBe(10);
    expect(SMART_REGULAR_MIN).toBe(4);
    expect(SMART_NEW_DAYS).toBe(30);
    expect(SMART_AT_RISK_DAYS).toBe(90);
    expect(SMART_LOST_DAYS).toBe(180);
    expect(SMART_BIRTHDAY_WINDOW_DAYS).toBe(30);
  });
});

describe('vip (≥ 10 Besuche)', () => {
  it('9 Besuche ⇒ nein, 10 ⇒ ja', () => {
    expect(hasSmartSegment(mk({ visits: 9 }), TODAY, 'vip')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 10 }), TODAY, 'vip')).toBe(true);
    expect(hasSmartSegment(mk({ visits: 25 }), TODAY, 'vip')).toBe(true);
  });
});

describe('regular (≥ 4 Besuche)', () => {
  it('3 Besuche ⇒ nein, 4 ⇒ ja', () => {
    expect(hasSmartSegment(mk({ visits: 3 }), TODAY, 'regular')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 4 }), TODAY, 'regular')).toBe(true);
  });
});

describe('never_returned (genau 1 Besuch)', () => {
  it('0/2 ⇒ nein, 1 ⇒ ja', () => {
    expect(hasSmartSegment(mk({ visits: 0 }), TODAY, 'never_returned')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 1 }), TODAY, 'never_returned')).toBe(true);
    expect(hasSmartSegment(mk({ visits: 2 }), TODAY, 'never_returned')).toBe(false);
  });
});

describe('at_risk (≥ 1 Besuch & ≥ 90 Tage ohne Besuch)', () => {
  it('89 Tage ⇒ nein, 90 ⇒ ja', () => {
    expect(hasSmartSegment(mk({ visits: 2, daysSinceLastVisit: 89 }), TODAY, 'at_risk')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 2, daysSinceLastVisit: 90 }), TODAY, 'at_risk')).toBe(true);
  });
  it('ohne Besuch (visits 0) ⇒ nie at_risk, auch bei grossem Abstand', () => {
    expect(hasSmartSegment(mk({ visits: 0, daysSinceLastVisit: 90 }), TODAY, 'at_risk')).toBe(false);
  });
  it('null daysSinceLastVisit ⇒ nein', () => {
    expect(hasSmartSegment(mk({ visits: 2, daysSinceLastVisit: null }), TODAY, 'at_risk')).toBe(false);
  });
});

describe('lost (≥ 1 Besuch & ≥ 180 Tage ohne Besuch)', () => {
  it('179 Tage ⇒ nein, 180 ⇒ ja', () => {
    expect(hasSmartSegment(mk({ visits: 1, daysSinceLastVisit: 179 }), TODAY, 'lost')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 1, daysSinceLastVisit: 180 }), TODAY, 'lost')).toBe(true);
  });
  it('lost überschneidet at_risk bewusst (200 Tage ⇒ beides)', () => {
    const m = mk({ visits: 3, daysSinceLastVisit: 200 });
    expect(hasSmartSegment(m, TODAY, 'at_risk')).toBe(true);
    expect(hasSmartSegment(m, TODAY, 'lost')).toBe(true);
  });
});

describe('new (erster Besuch in den letzten 30 Tagen)', () => {
  it('30 Tage ⇒ ja, 31 ⇒ nein', () => {
    expect(hasSmartSegment(
      mk({ visits: 1, firstVisit: isoMinusDays(TODAY, 30) }), TODAY, 'new',
    )).toBe(true);
    expect(hasSmartSegment(
      mk({ visits: 1, firstVisit: isoMinusDays(TODAY, 31) }), TODAY, 'new',
    )).toBe(false);
  });
  it('ohne Besuch ⇒ nein, fehlender firstVisit ⇒ nein', () => {
    expect(hasSmartSegment(mk({ visits: 0, firstVisit: isoMinusDays(TODAY, 5) }), TODAY, 'new')).toBe(false);
    expect(hasSmartSegment(mk({ visits: 1, firstVisit: null }), TODAY, 'new')).toBe(false);
  });
});

describe('upcoming_birthday & daysUntilBirthday (jahresunabhängig)', () => {
  it('Geburtstag heute ⇒ 0 Tage', () => {
    expect(daysUntilBirthday('1990-06-24', TODAY)).toBe(0);
  });
  it('Jahreswechsel: heute 20.12., Geburtstag 05.01. ⇒ 16 Tage', () => {
    expect(daysUntilBirthday('1990-01-05', '2026-12-20')).toBe(16);
  });
  it('29.02. in Nicht-Schaltjahr rollt auf 01.03. (deterministisch)', () => {
    // 2025 ist kein Schaltjahr; von 2025-02-01 bis 2025-03-01 sind 28 Tage.
    expect(daysUntilBirthday('2000-02-29', '2025-02-01')).toBe(28);
  });
  it('ungültiges/fehlendes Datum ⇒ null', () => {
    expect(daysUntilBirthday(null, TODAY)).toBeNull();
    expect(daysUntilBirthday('', TODAY)).toBeNull();
    expect(daysUntilBirthday('keinDatum', TODAY)).toBeNull();
  });
  it('isUpcomingBirthday: 0 und 30 Tage ⇒ ja, 31 ⇒ nein', () => {
    expect(isUpcomingBirthday(crmWithBirthday(TODAY.replace('2026', '1990')), TODAY)).toBe(true);
    expect(isUpcomingBirthday(crmWithBirthday(isoPlusDays(TODAY, 30)), TODAY)).toBe(true);
    expect(isUpcomingBirthday(crmWithBirthday(isoPlusDays(TODAY, 31)), TODAY)).toBe(false);
  });
  it('kein/leeres CRM-Profil ⇒ kein Geburtstags-Segment', () => {
    expect(isUpcomingBirthday(null, TODAY)).toBe(false);
    expect(isUpcomingBirthday(crmWithBirthday(null), TODAY)).toBe(false);
    expect(hasSmartSegment(mk({ crm: null }), TODAY, 'upcoming_birthday')).toBe(false);
  });
  it('hasSmartSegment liest den Geburtstag aus m.crm', () => {
    const m = mk({ visits: 1, crm: crmWithBirthday(isoPlusDays(TODAY, 5)) });
    expect(hasSmartSegment(m, TODAY, 'upcoming_birthday')).toBe(true);
  });
});

describe('guestSmartSegments — Mehrfach-Zuordnung in SMART_SEGMENT_ORDER', () => {
  it('VIP + regular + at_risk + lost gleichzeitig (Reihenfolge stabil)', () => {
    const m = mk({ visits: 12, daysSinceLastVisit: 200, firstVisit: isoMinusDays(TODAY, 400) });
    expect(guestSmartSegments(m, TODAY)).toEqual(['vip', 'regular', 'at_risk', 'lost']);
  });
  it('frischer VIP: vip + regular + new', () => {
    const m = mk({ visits: 10, daysSinceLastVisit: 0, firstVisit: isoMinusDays(TODAY, 5) });
    expect(guestSmartSegments(m, TODAY)).toEqual(['vip', 'regular', 'new']);
  });
  it('Einmalgast frisch: new + never_returned', () => {
    const m = mk({ visits: 1, daysSinceLastVisit: 2, firstVisit: isoMinusDays(TODAY, 2) });
    expect(guestSmartSegments(m, TODAY)).toEqual(['new', 'never_returned']);
  });
  it('ohne Besuch ⇒ keine Besuchs-Segmente', () => {
    expect(guestSmartSegments(mk({ visits: 0 }), TODAY)).toEqual([]);
  });
});

describe('filterBySmartSegment — Filter + Sortierung (Besuche desc, dann Name)', () => {
  const a = mk({ id: 'a', displayName: 'Anna', visits: 10 });
  const z = mk({ id: 'z', displayName: 'Zoe', visits: 10 });
  const b = mk({ id: 'b', displayName: 'Bob', visits: 12 });
  const c = mk({ id: 'c', displayName: 'Cara', visits: 3 }); // kein VIP
  it('liefert nur VIPs, sortiert nach Besuchen desc dann Name', () => {
    const out = filterBySmartSegment([a, z, b, c], 'vip', TODAY);
    expect(out.map(m => m.id)).toEqual(['b', 'a', 'z']);
  });
  it('mutiert das Eingabe-Array nicht (defensiv)', () => {
    const input = [a, z, b, c];
    filterBySmartSegment(input, 'vip', TODAY);
    expect(input.map(m => m.id)).toEqual(['a', 'z', 'b', 'c']);
  });
});

describe('summarizeSmartSegments', () => {
  it('zählt je Segment in SMART_SEGMENT_ORDER', () => {
    const rows = [
      mk({ visits: 12, daysSinceLastVisit: 200, firstVisit: isoMinusDays(TODAY, 400) }), // vip+regular+at_risk+lost
      mk({ visits: 4, daysSinceLastVisit: 10, firstVisit: isoMinusDays(TODAY, 200) }),    // regular
      mk({ visits: 1, daysSinceLastVisit: 2, firstVisit: isoMinusDays(TODAY, 2) }),       // new+never_returned
    ];
    const sum = summarizeSmartSegments(rows, TODAY);
    expect(sum.map(s => s.segment)).toEqual(SMART_SEGMENT_ORDER);
    const by = Object.fromEntries(sum.map(s => [s.segment, s.count]));
    expect(by.vip).toBe(1);
    expect(by.regular).toBe(2);
    expect(by.new).toBe(1);
    expect(by.never_returned).toBe(1);
    expect(by.at_risk).toBe(1);
    expect(by.lost).toBe(1);
    expect(by.upcoming_birthday).toBe(0);
  });
});

describe('SMART_SEGMENT_FILTER_OPTIONS', () => {
  it('beginnt mit „alle" und enthält alle Segmente in Reihenfolge', () => {
    expect(SMART_SEGMENT_FILTER_OPTIONS[0].value).toBe('alle');
    expect(SMART_SEGMENT_FILTER_OPTIONS.slice(1).map(o => o.value)).toEqual(SMART_SEGMENT_ORDER);
    for (const o of SMART_SEGMENT_FILTER_OPTIONS.slice(1)) {
      expect(o.label).toBe(SMART_SEGMENT_LABEL[o.value as typeof SMART_SEGMENT_ORDER[number]]);
    }
  });
});

describe('smartSegmentExportTable — wiederverwendete Kampagnen-Export-Bausteine', () => {
  it('nutzt CSV_HEADERS, mappt jede Zeile und benennt nach Segment-Slug', () => {
    const rows = [mk({ id: 'a', visits: 10 }), mk({ id: 'b', visits: 11 })];
    const table = smartSegmentExportTable('vip', rows);
    expect(table.headers).toEqual([...CSV_HEADERS]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toHaveLength(CSV_HEADERS.length);
    expect(table.filename).toBe(`crm-smart-segment-${SMART_SEGMENT_SLUG.vip}`);
  });
  it('leere Liste ⇒ keine Zeilen, gültige Kopfzeile', () => {
    const table = smartSegmentExportTable('lost', []);
    expect(table.rows).toEqual([]);
    expect(table.headers).toEqual([...CSV_HEADERS]);
  });
});
