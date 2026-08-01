// @vitest-environment node
/** Rezensionen: pure Kennzahlen-/Verlaufsberechnung (kein Supabase). */
import { describe, it, expect } from 'vitest';
import {
  computeReviewKpis, computeReviewTrend, latestRowsPerPlatform,
  computeWeeklyStarColumns, summarizeStarColumns, isoWeekKeyOf,
  type MonthlyReviewRow, type ReviewsData, type SingleReview,
} from '@/lib/reviews-store';

const row = (p: Partial<MonthlyReviewRow>): MonthlyReviewRow => ({
  id: p.id ?? `${p.platform}-${p.month}`,
  month: p.month ?? '2026-07',
  platform: p.platform ?? 'Google',
  avgRating: p.avgRating ?? null,
  newCount: p.newCount ?? null,
  totalCount: p.totalCount ?? null,
  totalAvg: p.totalAvg ?? null,
  updatedAt: '2026-07-01T00:00:00Z',
  ...p,
});

const data: ReviewsData = {
  monthlyRows: [
    row({ platform: 'Google', month: '2026-06', avgRating: 4.4, newCount: 6, totalCount: 504, totalAvg: 4.5 }),
    row({ platform: 'Google', month: '2026-07', avgRating: 4.6, newCount: 8, totalCount: 512, totalAvg: 4.5 }),
    row({ platform: 'TripAdvisor', month: '2026-07', avgRating: 4.0, newCount: 2, totalCount: 128, totalAvg: 4.1 }),
  ],
  singleReviews: [
    { id: 's1', date: '2026-07-03', platform: 'Google', stars: 5, text: 'Top', answered: true, updatedAt: '' },
    { id: 's2', date: '2026-07-10', platform: 'Google', stars: 2, text: 'Nja', answered: false, updatedAt: '' },
    { id: 's3', date: '2026-07-11', platform: 'TripAdvisor', stars: 4, text: '', answered: true, updatedAt: '' },
  ],
};

describe('reviews-store Kennzahlen', () => {
  it('letzte Zeile je Plattform', () => {
    const latest = latestRowsPerPlatform(data.monthlyRows);
    expect(latest.get('Google')?.month).toBe('2026-07');
    expect(latest.get('TripAdvisor')?.totalCount).toBe(128);
  });

  it('KPIs über alle Plattformen: gewichteter Ø, Summe kumuliert, neue im Monat, Antwortquote', () => {
    const k = computeReviewKpis(data, '2026-07', null);
    // gewichtet: (4.5*512 + 4.1*128) / 640 = 4.42
    expect(k.overallAvg).toBeCloseTo((4.5 * 512 + 4.1 * 128) / 640, 5);
    expect(k.totalCount).toBe(640);
    expect(k.newInMonth).toBe(10);
    expect(k.responseRate).toBeCloseTo(2 / 3, 5);
  });

  it('KPIs pro Plattform gefiltert', () => {
    const k = computeReviewKpis(data, '2026-07', 'TripAdvisor');
    expect(k.overallAvg).toBeCloseTo(4.1, 5);
    expect(k.totalCount).toBe(128);
    expect(k.newInMonth).toBe(2);
    expect(k.responseRate).toBe(1);
  });

  it('leere Daten → alles null (nie stille 0)', () => {
    const k = computeReviewKpis({ monthlyRows: [], singleReviews: [] }, '2026-07', null);
    expect(k).toEqual({ overallAvg: null, totalCount: null, newInMonth: null, responseRate: null });
  });

  it('Verlauf: aufsteigend, Monats-Ø nach newCount gewichtet, Summen', () => {
    const t = computeReviewTrend(data.monthlyRows, null);
    expect(t.map(p => p.month)).toEqual(['2026-06', '2026-07']);
    expect(t[1].newCount).toBe(10);
    expect(t[1].avgRating).toBeCloseTo((4.6 * 8 + 4.0 * 2) / 10, 5);
  });

  it('Verlauf gefiltert auf Plattform', () => {
    const t = computeReviewTrend(data.monthlyRows, 'Google');
    expect(t).toHaveLength(2);
    expect(t[0].avgRating).toBeCloseTo(4.4, 5);
  });
});

describe('Wochentracking nach Sternen', () => {
  const sr = (date: string, stars: number, platform = 'Google'): SingleReview => ({
    id: `${date}-${stars}-${platform}`, date, platform, stars, text: '', answered: false, updatedAt: '',
  });

  it('ISO-Wochen-Key nutzt Wochenjahr (Jahreswechsel-Falle)', () => {
    expect(isoWeekKeyOf(new Date('2026-07-28T12:00:00'))).toBe('2026-W31');
    // 1. Januar 2027 gehört zur KW 53 des ISO-Wochenjahrs 2026
    expect(isoWeekKeyOf(new Date('2027-01-01T12:00:00'))).toBe('2026-W53');
  });

  it('zählt pro Woche und Sternwert; ausserhalb liegende und ungültige Einträge ignoriert', () => {
    const reviews = [
      sr('2026-07-20', 5), sr('2026-07-22', 5), sr('2026-07-26', 3), // KW 30
      sr('2026-07-27', 1), sr('2026-08-01', 4),                      // KW 31
      sr('2026-06-01', 5),                                           // ausserhalb
      sr('2026-07-28', 4.6), sr('2026-07-28', 0), sr('bogus', 5),    // ungültig
    ];
    const cols = computeWeeklyStarColumns(reviews, ['2026-W30', '2026-W31'], null);
    expect(cols[0].label).toBe('KW 30');
    expect(cols[0].counts[5]).toBe(2);
    expect(cols[0].counts[3]).toBe(1);
    expect(cols[0].total).toBe(3);
    expect(cols[1].counts[1]).toBe(1);
    expect(cols[1].counts[4]).toBe(1);
    expect(cols[1].total).toBe(2);
  });

  it('Plattform-Filter und Summen-Verteilung', () => {
    const reviews = [sr('2026-07-20', 5), sr('2026-07-21', 5, 'TripAdvisor'), sr('2026-07-22', 2)];
    const cols = computeWeeklyStarColumns(reviews, ['2026-W30'], 'Google');
    expect(cols[0].total).toBe(2);
    const sum = summarizeStarColumns(cols);
    expect(sum.counts[5]).toBe(1);
    expect(sum.counts[2]).toBe(1);
    expect(sum.total).toBe(2);
  });
});

describe('countGoogleReviewsByStar', () => {
  const mk = (date: string, stars: number, platform = 'Google', deleted = false) => ({
    id: `${date}-${stars}-${platform}`, date, platform, stars, text: '',
    answered: false, updatedAt: '2026-08-01T00:00:00Z', deleted,
  });
  it('zählt nur Google, richtige Sternzahl, im Datumsbereich, nicht gelöscht', async () => {
    const { countGoogleReviewsByStar } = await import('@/lib/reviews-store');
    const list = [
      mk('2026-07-01', 5), mk('2026-07-31', 5), mk('2026-08-01', 5), // 3. ausserhalb
      mk('2026-07-10', 5, 'google'),                                  // case-insensitiv
      mk('2026-07-11', 5, 'TripAdvisor'),                             // andere Plattform
      mk('2026-07-12', 3), mk('2026-07-13', 1),
      mk('2026-07-14', 5, 'Google', true),                            // gelöscht
    ];
    expect(countGoogleReviewsByStar(list, '2026-07-01', '2026-07-31', 5)).toBe(3);
    expect(countGoogleReviewsByStar(list, '2026-07-01', '2026-07-31', 3)).toBe(1);
    expect(countGoogleReviewsByStar(list, '2026-07-01', '2026-07-31', 1)).toBe(1);
    expect(countGoogleReviewsByStar([], '2026-07-01', '2026-07-31', 5)).toBe(0);
  });
});
