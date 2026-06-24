// @vitest-environment node
/**
 * Tests für die Gäste-Kundenakte-Analytik (reservation-guest-profile.ts).
 * Ausschliesslich synthetische Daten — KEINE echten Gäste/PII.
 */
import { describe, it, expect } from 'vitest';
import type { GuestReservationRecord } from '../reservation-crm';
import {
  mostFrequent,
  weekdayIndex,
  monthIndex,
  normalizeArea,
  computeGuestPreferences,
  computeVisitTrend,
  filterReservationHistory,
  visitsScore,
  recencyScore,
  regularityScore,
  partySizeScore,
  scoreTier,
  computeCrmScore,
  totalPersonsOnVisits,
  WEEKDAY_LABELS,
  MONTH_LABELS,
} from '../reservation-guest-profile';

const TODAY = '2026-06-22';

/** ISO-Datum n Tage vor `TODAY` (UTC-Tagesarithmetik, unabhängig von der Impl.). */
function daysAgo(n: number, today = TODAY): string {
  const ms = Date.parse(`${today}T00:00:00Z`) - n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function rec(p: Partial<GuestReservationRecord>): GuestReservationRecord {
  return {
    reservationDate: null,
    reservationTime: null,
    partySize: null,
    statusNormalized: 'completed',
    room: null,
    area: null,
    note: null,
    comment: null,
    ...p,
  };
}

describe('mostFrequent', () => {
  it('liefert den häufigsten Wert', () => {
    expect(mostFrequent(['a', 'b', 'a'])).toBe('a');
    expect(mostFrequent([2, 4, 2, 4, 2])).toBe(2);
  });
  it('ignoriert null/undefined', () => {
    expect(mostFrequent([null, 'x', undefined, 'x'])).toBe('x');
  });
  it('gewinnt bei Gleichstand der zuerst auftretende Wert', () => {
    expect(mostFrequent(['a', 'b'])).toBe('a');
    expect(mostFrequent(['b', 'a'])).toBe('b');
  });
  it('gibt null bei leerer/nullwertiger Liste', () => {
    expect(mostFrequent([])).toBeNull();
    expect(mostFrequent([null, undefined])).toBeNull();
  });
});

describe('weekdayIndex', () => {
  it('berechnet den Wochentag (0=Mo … 6=So)', () => {
    expect(weekdayIndex('2024-01-01')).toBe(0); // Montag
    expect(weekdayIndex('2024-01-02')).toBe(1); // Dienstag
    expect(weekdayIndex('2024-01-07')).toBe(6); // Sonntag
    expect(WEEKDAY_LABELS[weekdayIndex('2024-01-01')!]).toBe('Montag');
  });
  it('gibt null bei fehlendem/ungültigem Datum', () => {
    expect(weekdayIndex(null)).toBeNull();
    expect(weekdayIndex('keindatum')).toBeNull();
  });
});

describe('normalizeArea', () => {
  it('mappt Schlüsselwörter auf kanonische Bereiche', () => {
    expect(normalizeArea('Gartenterrasse', null)).toBe('Terrasse');
    expect(normalizeArea('Bar Lounge', null)).toBe('Bar');
    expect(normalizeArea('Hauptrestaurant', null)).toBe('Restaurant');
  });
  it('nutzt room als Fallback, wenn area leer ist', () => {
    expect(normalizeArea(null, 'Terrasse')).toBe('Terrasse');
    expect(normalizeArea('   ', 'Bar')).toBe('Bar');
  });
  it('behält unbekannte Rohwerte bei statt sie zu verwerfen', () => {
    expect(normalizeArea('Séparée', null)).toBe('Séparée');
  });
  it('gibt null, wenn weder area noch room gesetzt sind', () => {
    expect(normalizeArea(null, null)).toBeNull();
    expect(normalizeArea('', '')).toBeNull();
  });
});

describe('computeGuestPreferences', () => {
  it('leitet Präferenzen nur aus abgeschlossenen Besuchen ab', () => {
    const recs = [
      rec({ reservationDate: '2024-01-01', reservationTime: '19:00', partySize: 2, area: 'Terrasse' }),
      rec({ reservationDate: '2024-01-08', reservationTime: '19:00', partySize: 2, area: 'Gartenterrasse' }),
      rec({ reservationDate: '2024-01-02', reservationTime: '12:00', partySize: 4, area: 'Restaurant' }),
      // Storno/No-Show dürfen NICHT in die Präferenzen einfliessen:
      rec({ reservationDate: '2024-01-03', reservationTime: '21:00', partySize: 9, area: 'Bar', statusNormalized: 'cancelled' }),
      rec({ reservationDate: '2024-01-04', reservationTime: '21:00', partySize: 9, area: 'Bar', statusNormalized: 'noshow' }),
    ];
    const p = computeGuestPreferences(recs);
    expect(p.favoriteArea).toBe('Terrasse');
    expect(p.favoriteWeekday).toBe('Montag'); // 01.01.2024 + 08.01.2024 sind Montage
    expect(p.favoriteMonth).toBe('Januar');   // alle abgeschlossenen Besuche im Januar
    expect(p.favoriteTime).toBe('19:00');
    expect(p.mostCommonPartySize).toBe(2);
  });
  it('schneidet Uhrzeiten auf HH:mm', () => {
    const p = computeGuestPreferences([rec({ reservationDate: '2024-01-01', reservationTime: '18:30:00' })]);
    expect(p.favoriteTime).toBe('18:30');
  });
  it('ist defensiv bei leeren Daten', () => {
    expect(computeGuestPreferences([])).toEqual({
      favoriteArea: null, favoriteWeekday: null, favoriteMonth: null, favoriteTime: null, mostCommonPartySize: null,
    });
  });
});

describe('monthIndex', () => {
  it('liest den Monat (0 = Januar) direkt aus dem ISO-String', () => {
    expect(monthIndex('2024-01-15')).toBe(0);
    expect(monthIndex('2024-06-30')).toBe(5);
    expect(monthIndex('2024-12-01')).toBe(11);
  });
  it('ist defensiv bei fehlendem/ungültigem Datum', () => {
    expect(monthIndex(null)).toBeNull();
    expect(monthIndex('')).toBeNull();
    expect(monthIndex('2024-13-01')).toBeNull();
    expect(monthIndex('2024-00-01')).toBeNull();
  });
});

describe('computeGuestPreferences — Lieblingsmonat', () => {
  it('ist null ohne abgeschlossene Besuche', () => {
    expect(computeGuestPreferences([]).favoriteMonth).toBeNull();
    // Nur Storno/No-Show ⇒ kein Besuch ⇒ kein Lieblingsmonat:
    const p = computeGuestPreferences([
      rec({ reservationDate: '2024-03-01', statusNormalized: 'cancelled' }),
      rec({ reservationDate: '2024-03-02', statusNormalized: 'noshow' }),
    ]);
    expect(p.favoriteMonth).toBeNull();
  });
  it('entspricht bei genau einem Besuch dessen Monat', () => {
    const p = computeGuestPreferences([rec({ reservationDate: '2024-03-15' })]);
    expect(p.favoriteMonth).toBe('März');
    expect(p.favoriteMonth).toBe(MONTH_LABELS[2]);
  });
  it('liefert bei mehreren Besuchen den häufigsten Monat (nur abgeschlossene)', () => {
    const p = computeGuestPreferences([
      rec({ reservationDate: '2024-07-01' }),
      rec({ reservationDate: '2024-07-20' }),
      rec({ reservationDate: '2024-09-05' }),
      // Storno im November darf den Lieblingsmonat NICHT beeinflussen:
      rec({ reservationDate: '2024-11-11', statusNormalized: 'cancelled' }),
    ]);
    expect(p.favoriteMonth).toBe('Juli');
  });
});

describe('computeVisitTrend', () => {
  it('erkennt einen steigenden Trend', () => {
    const recs = [
      rec({ reservationDate: daysAgo(10) }),
      rec({ reservationDate: daysAgo(20) }),
      rec({ reservationDate: daysAgo(30) }),
      rec({ reservationDate: daysAgo(120) }),
    ];
    const t = computeVisitTrend(recs, TODAY);
    expect(t.last90).toBe(3);
    expect(t.previous90).toBe(1);
    expect(t.direction).toBe('steigend');
  });
  it('erkennt einen rückläufigen Trend', () => {
    const recs = [
      rec({ reservationDate: daysAgo(100) }),
      rec({ reservationDate: daysAgo(120) }),
      rec({ reservationDate: daysAgo(150) }),
    ];
    const t = computeVisitTrend(recs, TODAY);
    expect(t.last90).toBe(0);
    expect(t.previous90).toBe(3);
    expect(t.direction).toBe('rückläufig');
  });
  it('wertet kleine Differenzen als stabil', () => {
    const recs = [
      rec({ reservationDate: daysAgo(10) }),
      rec({ reservationDate: daysAgo(20) }),
      rec({ reservationDate: daysAgo(120) }),
    ];
    const t = computeVisitTrend(recs, TODAY);
    expect(t.last90).toBe(2);
    expect(t.previous90).toBe(1);
    expect(t.direction).toBe('stabil'); // Differenz 1 ≤ Toleranz
  });
  it('beachtet die Fenstergrenzen und ignoriert Zukunft/Storno', () => {
    const recs = [
      rec({ reservationDate: daysAgo(89) }),   // im letzten 90er-Fenster
      rec({ reservationDate: daysAgo(90) }),   // im vorherigen Fenster
      rec({ reservationDate: daysAgo(179) }),  // im vorherigen Fenster
      rec({ reservationDate: daysAgo(180) }),  // ausserhalb beider Fenster
      rec({ reservationDate: daysAgo(-5) }),   // Zukunft → ignoriert
      rec({ reservationDate: daysAgo(10), statusNormalized: 'cancelled' }), // kein Besuch
    ];
    const t = computeVisitTrend(recs, TODAY);
    expect(t.last90).toBe(1);
    expect(t.previous90).toBe(2);
  });
  it('ist defensiv bei leeren Daten', () => {
    expect(computeVisitTrend([], TODAY)).toEqual({ last90: 0, previous90: 0, direction: 'stabil' });
  });
});

describe('filterReservationHistory', () => {
  const recs = [
    rec({ statusNormalized: 'completed' }),
    rec({ statusNormalized: 'completed' }),
    rec({ statusNormalized: 'cancelled' }),
    rec({ statusNormalized: 'noshow' }),
    rec({ statusNormalized: 'confirmed' }),
  ];
  it('alle gibt eine Kopie aller Einträge zurück', () => {
    expect(filterReservationHistory(recs, 'alle')).toHaveLength(5);
  });
  it('besuche filtert auf abgeschlossene', () => {
    expect(filterReservationHistory(recs, 'besuche')).toHaveLength(2);
  });
  it('storniert filtert auf Stornos', () => {
    expect(filterReservationHistory(recs, 'storniert')).toHaveLength(1);
  });
  it('noshow filtert auf No-Shows', () => {
    expect(filterReservationHistory(recs, 'noshow')).toHaveLength(1);
  });
});

describe('CRM-Score Teilkomponenten', () => {
  it('visitsScore: linear, gedeckelt bei der VIP-Schwelle', () => {
    expect(visitsScore(0)).toBe(0);
    expect(visitsScore(10)).toBe(50);
    expect(visitsScore(20)).toBe(100);
    expect(visitsScore(40)).toBe(100);
  });
  it('recencyScore: voll ≤ 30 Tage, 0 ab 180 Tage', () => {
    expect(recencyScore(null)).toBe(0);
    expect(recencyScore(30)).toBe(100);
    expect(recencyScore(105)).toBe(50);
    expect(recencyScore(180)).toBe(0);
    expect(recencyScore(365)).toBe(0);
  });
  it('regularityScore: braucht ≥ 2 Besuche & gültiges Intervall', () => {
    expect(regularityScore(20, 1)).toBe(0);   // < 2 Besuche
    expect(regularityScore(null, 5)).toBe(0);
    expect(regularityScore(0, 5)).toBe(0);
    expect(regularityScore(30, 5)).toBe(100);
    expect(regularityScore(105, 5)).toBe(50);
    expect(regularityScore(180, 5)).toBe(0);
  });
  it('partySizeScore: voll ab 6 Personen', () => {
    expect(partySizeScore(null)).toBe(0);
    expect(partySizeScore(3)).toBe(50);
    expect(partySizeScore(6)).toBe(100);
    expect(partySizeScore(12)).toBe(100);
  });
});

describe('scoreTier', () => {
  it('ordnet die Stufen korrekt zu', () => {
    expect(scoreTier(0)).toBe('niedrig');
    expect(scoreTier(39)).toBe('niedrig');
    expect(scoreTier(40)).toBe('mittel');
    expect(scoreTier(69)).toBe('mittel');
    expect(scoreTier(70)).toBe('hoch');
    expect(scoreTier(89)).toBe('hoch');
    expect(scoreTier(90)).toBe('vip_potenzial');
    expect(scoreTier(100)).toBe('vip_potenzial');
  });
});

describe('computeCrmScore', () => {
  it('ergibt 0/niedrig ohne Besuche', () => {
    const s = computeCrmScore({ visits: 0, daysSinceLastVisit: null, avgDaysBetweenVisits: null, avgPartySize: null });
    expect(s.score).toBe(0);
    expect(s.tier).toBe('niedrig');
    expect(s.components).toEqual({ visits: 0, recency: 0, regularity: 0, partySize: 0 });
  });
  it('ergibt 100/VIP-Potenzial bei Bestwerten', () => {
    const s = computeCrmScore({ visits: 20, daysSinceLastVisit: 10, avgDaysBetweenVisits: 20, avgPartySize: 6 });
    expect(s.score).toBe(100);
    expect(s.tier).toBe('vip_potenzial');
  });
  it('berechnet die gewichtete Summe (Beispiel mittel)', () => {
    // visits 5→25, recency 105→50, regularity 105→50, party 3→50
    // = 25*.4 + 50*.25 + 50*.2 + 50*.15 = 10 + 12.5 + 10 + 7.5 = 40
    const s = computeCrmScore({ visits: 5, daysSinceLastVisit: 105, avgDaysBetweenVisits: 105, avgPartySize: 3 });
    expect(s.score).toBe(40);
    expect(s.tier).toBe('mittel');
    expect(s.components).toEqual({ visits: 25, recency: 50, regularity: 50, partySize: 50 });
  });
});

describe('totalPersonsOnVisits', () => {
  it('summiert nur Personen abgeschlossener Besuche', () => {
    const recs = [
      rec({ partySize: 2 }),
      rec({ partySize: 4 }),
      rec({ partySize: 10, statusNormalized: 'cancelled' }),
      rec({ partySize: null }),
    ];
    expect(totalPersonsOnVisits(recs)).toBe(6);
  });
  it('ist defensiv bei leeren Daten', () => {
    expect(totalPersonsOnVisits([])).toBe(0);
  });
});
