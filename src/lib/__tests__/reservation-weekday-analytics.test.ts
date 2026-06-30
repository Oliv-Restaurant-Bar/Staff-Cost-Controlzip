// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { ReservationAggRow } from '@/lib/reservation-dashboard';
import {
  isoWeekdayOf,
  monthKeyOf,
  monthLabel,
  lastDayOfMonth,
  aggregateByWeekday,
  buildMonthWeekdayMatrix,
  buildWeekdaySummary,
  presetRange,
  seasonRange,
  parseSeasonSettings,
  serializeSeasonSettings,
  normalizeSeasonRange,
  DEFAULT_SEASON_SETTINGS,
} from '@/lib/reservation-weekday-analytics';

// ── Test-Daten ────────────────────────────────────────────────────────────────
// Bekannte ISO-Wochentage 2025:
//   2025-10-06 Mo · 2025-10-07 Di · 2025-10-11 Sa · 2025-10-13 Mo
//   2025-11-03 Mo · 2025-12-01 Mo · 2025-12-25 Do
const r = (date: string, partySize: number | null, status: string): ReservationAggRow => ({
  date,
  partySize,
  status,
});

const ROWS: ReservationAggRow[] = [
  r('2025-10-06', 4, 'confirmed'),
  r('2025-10-06', 2, 'completed'),
  r('2025-10-13', 3, 'confirmed'),
  r('2025-10-07', 5, 'confirmed'),
  r('2025-10-11', 2, 'cancelled'), // im 'booked'-Modus ausgeschlossen
  r('2025-11-03', 2, 'confirmed'),
  r('2025-12-01', 6, 'confirmed'),
  r('2025-12-25', 8, 'confirmed'),
];

const FULL_FROM = '2025-10-01';
const FULL_TO = '2025-12-31';

// ── Datums-Helfer ─────────────────────────────────────────────────────────────

describe('isoWeekdayOf', () => {
  it('liefert ISO-Wochentag 1..7 (Mo=1, So=7)', () => {
    expect(isoWeekdayOf('2025-10-06')).toBe(1); // Montag
    expect(isoWeekdayOf('2025-10-07')).toBe(2); // Dienstag
    expect(isoWeekdayOf('2025-10-11')).toBe(6); // Samstag
    expect(isoWeekdayOf('2025-10-12')).toBe(7); // Sonntag
    expect(isoWeekdayOf('2025-12-25')).toBe(4); // Donnerstag
  });
  it('akzeptiert Datum mit Zeitanhang', () => {
    expect(isoWeekdayOf('2025-10-06T19:30:00')).toBe(1);
  });
  it('liefert null bei fehlendem/ungültigem Datum', () => {
    expect(isoWeekdayOf(null)).toBeNull();
    expect(isoWeekdayOf(undefined)).toBeNull();
    expect(isoWeekdayOf('')).toBeNull();
    expect(isoWeekdayOf('kaputt')).toBeNull();
    expect(isoWeekdayOf('2025-02-30')).toBeNull(); // existiert nicht
    expect(isoWeekdayOf('2025-13-01')).toBeNull(); // Monat ungültig
  });
});

describe('monthKeyOf / monthLabel / lastDayOfMonth', () => {
  it('monthKeyOf liefert yyyy-MM', () => {
    expect(monthKeyOf('2025-10-06')).toBe('2025-10');
    expect(monthKeyOf(null)).toBeNull();
  });
  it('monthLabel liefert deutsches Kurzlabel', () => {
    expect(monthLabel('2025-10')).toBe('Okt 2025');
    expect(monthLabel('2025-12')).toBe('Dez 2025');
  });
  it('lastDayOfMonth berücksichtigt Schaltjahre', () => {
    expect(lastDayOfMonth(2025, 2)).toBe(28);
    expect(lastDayOfMonth(2024, 2)).toBe(29);
    expect(lastDayOfMonth(2025, 4)).toBe(30);
    expect(lastDayOfMonth(2025, 12)).toBe(31);
  });
});

// ── Gruppierung nach Wochentag + Summen ───────────────────────────────────────

describe('aggregateByWeekday', () => {
  it('gruppiert korrekt nach Wochentag und summiert Reservationen + Personen', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    expect(agg.weekdays).toHaveLength(7); // immer alle 7 Tage

    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    const tue = agg.weekdays.find((w) => w.weekday === 2)!;
    const thu = agg.weekdays.find((w) => w.weekday === 4)!;
    const sat = agg.weekdays.find((w) => w.weekday === 6)!;

    // Montag: 06.10 (×2) + 13.10 + 03.11 + 01.12 = 5 Reservationen, 4+2+3+2+6 = 17 Personen
    expect(mon).toMatchObject({ reservations: 5, persons: 17 });
    expect(mon.avgPersons).toBeCloseTo(17 / 5, 6);
    // Dienstag: 07.10 → 1 Reservation, 5 Personen
    expect(tue).toMatchObject({ reservations: 1, persons: 5 });
    // Donnerstag: 25.12 → 1 Reservation, 8 Personen
    expect(thu).toMatchObject({ reservations: 1, persons: 8 });
    // Samstag: nur Storno → im 'booked'-Modus 0
    expect(sat).toMatchObject({ reservations: 0, persons: 0 });
    expect(sat.avgPersons).toBeNull();
  });

  it('Gesamtsummen stimmen und Anteil-% summiert sich auf ~100', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    expect(agg.totalReservations).toBe(7);
    expect(agg.totalPersons).toBe(30);

    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    expect(mon.sharePct).toBeCloseTo((5 / 7) * 100, 6);

    const shareSum = agg.weekdays.reduce((s, w) => s + w.sharePct, 0);
    expect(shareSum).toBeCloseTo(100, 6);
  });

  it("Status-Scope 'all' bezieht Storno/No-Show ein", () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'all');
    const sat = agg.weekdays.find((w) => w.weekday === 6)!;
    expect(sat).toMatchObject({ reservations: 1, persons: 2 }); // Storno jetzt gezählt
    expect(agg.totalReservations).toBe(8);
    expect(agg.totalPersons).toBe(32);
  });

  it('unbekannte Personenzahl zählt als 0 Personen, aber 1 Reservation', () => {
    const rows = [r('2025-10-06', null, 'confirmed')];
    const agg = aggregateByWeekday(rows, FULL_FROM, FULL_TO, 'booked');
    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    expect(mon).toMatchObject({ reservations: 1, persons: 0 });
  });

  it('leere Daten → alle 0, keine Division durch 0', () => {
    const agg = aggregateByWeekday([], FULL_FROM, FULL_TO, 'booked');
    expect(agg.totalReservations).toBe(0);
    expect(agg.weekdays.every((w) => w.reservations === 0 && w.sharePct === 0 && w.avgPersons === null)).toBe(true);
  });
});

// ── Frei gewählter Zeitraum ───────────────────────────────────────────────────

describe('aggregateByWeekday — frei gewählter Zeitraum', () => {
  it('begrenzt auf [from, to] (inklusive)', () => {
    const agg = aggregateByWeekday(ROWS, '2025-10-01', '2025-10-31', 'booked');
    // Nur Oktober: Montag 06(×2)+13 = 3, Dienstag 07 = 1
    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    const tue = agg.weekdays.find((w) => w.weekday === 2)!;
    expect(mon).toMatchObject({ reservations: 3, persons: 9 });
    expect(tue).toMatchObject({ reservations: 1, persons: 5 });
    expect(agg.totalReservations).toBe(4);
    expect(agg.totalPersons).toBe(14);
  });

  it('Grenzen sind inklusive', () => {
    const single = aggregateByWeekday(ROWS, '2025-12-25', '2025-12-25', 'booked');
    expect(single.totalReservations).toBe(1);
    expect(single.weekdays.find((w) => w.weekday === 4)!.reservations).toBe(1);
  });
});

// ── Matrix Monat × Wochentag (Monatsvergleich) ────────────────────────────────

describe('buildMonthWeekdayMatrix', () => {
  it('baut Monatszeilen mit Wochentagsspalten + Zeilen-/Spalten-/Gesamtsummen', () => {
    const m = buildMonthWeekdayMatrix(ROWS, FULL_FROM, FULL_TO, 'booked');
    expect(m.months.map((x) => x.monthKey)).toEqual(['2025-10', '2025-11', '2025-12']);

    const oct = m.months.find((x) => x.monthKey === '2025-10')!;
    expect(oct.cells[1]).toEqual({ reservations: 3, persons: 9 }); // Mo
    expect(oct.cells[2]).toEqual({ reservations: 1, persons: 5 }); // Di
    expect(oct.total).toEqual({ reservations: 4, persons: 14 });

    const dec = m.months.find((x) => x.monthKey === '2025-12')!;
    expect(dec.cells[1]).toEqual({ reservations: 1, persons: 6 }); // Mo
    expect(dec.cells[4]).toEqual({ reservations: 1, persons: 8 }); // Do
    expect(dec.total).toEqual({ reservations: 2, persons: 14 });

    // Spaltensumme Montag über alle Monate
    expect(m.weekdayTotals[1]).toEqual({ reservations: 5, persons: 17 });
    expect(m.grandTotal).toEqual({ reservations: 7, persons: 30 });
  });

  it('zeigt nur Monate mit mindestens einer Reservation', () => {
    const m = buildMonthWeekdayMatrix(ROWS, '2025-11-01', '2025-11-30', 'booked');
    expect(m.months.map((x) => x.monthKey)).toEqual(['2025-11']);
  });
});

// ── Zusammenfassung ───────────────────────────────────────────────────────────

describe('buildWeekdaySummary', () => {
  it('bestimmt stärksten/schwächsten Wochentag + besten/schwächsten Monat für Fokus-Wochentag', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    const matrix = buildMonthWeekdayMatrix(ROWS, FULL_FROM, FULL_TO, 'booked');
    const s = buildWeekdaySummary(agg, matrix, 1); // Fokus Montag

    expect(s.strongestWeekday).toMatchObject({ weekday: 1, reservations: 5 });
    // Schwächster aktiver Wochentag: Di(1) und Do(1) → Gleichstand → früherer = Di
    expect(s.weakestWeekday).toMatchObject({ weekday: 2, reservations: 1 });

    // Montag je Monat: Okt 3, Nov 1, Dez 1 → bester Okt, schwächster (Tie Nov/Dez) → Nov
    expect(s.bestMonthForWeekday).toMatchObject({ monthKey: '2025-10', reservations: 3 });
    expect(s.worstMonthForWeekday).toMatchObject({ monthKey: '2025-11', reservations: 1 });
  });

  it('ignoriert leere Eimer; null wenn gar keine Daten', () => {
    const agg = aggregateByWeekday([], FULL_FROM, FULL_TO, 'booked');
    const matrix = buildMonthWeekdayMatrix([], FULL_FROM, FULL_TO, 'booked');
    const s = buildWeekdaySummary(agg, matrix, 1);
    expect(s.strongestWeekday).toBeNull();
    expect(s.weakestWeekday).toBeNull();
    expect(s.bestMonthForWeekday).toBeNull();
    expect(s.worstMonthForWeekday).toBeNull();
  });

  it('Fokus-Wochentag ohne Reservationen → keine Monatsextreme', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    const matrix = buildMonthWeekdayMatrix(ROWS, FULL_FROM, FULL_TO, 'booked');
    const s = buildWeekdaySummary(agg, matrix, 7); // Sonntag: keine Daten
    expect(s.bestMonthForWeekday).toBeNull();
    expect(s.worstMonthForWeekday).toBeNull();
  });
});

// ── Schnell-Auswahl / Saisons ─────────────────────────────────────────────────

describe('presetRange', () => {
  const seasons = DEFAULT_SEASON_SETTINGS;
  it('Dieser Monat / Letzter Monat (relativ zu today)', () => {
    expect(presetRange('thisMonth', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(presetRange('lastMonth', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
    });
  });
  it('Letzter Monat überschlägt Jahreswechsel', () => {
    expect(presetRange('lastMonth', { today: '2026-01-15', year: 2026, seasons })).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });
  it('Oktober bis Dezember (jahresgebunden)', () => {
    expect(presetRange('octDec', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });
  it('Wintersaison (Standard Okt–Mär) überschlägt ins Folgejahr', () => {
    expect(presetRange('winter', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2025-10-01',
      to: '2026-03-31',
    });
  });
  it('Sommersaison (Standard Apr–Sep)', () => {
    expect(presetRange('summer', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2025-04-01',
      to: '2025-09-30',
    });
  });
  it('Benutzerdefiniert → null', () => {
    expect(presetRange('custom', { today: '2026-06-29', year: 2025, seasons })).toBeNull();
  });
});

describe('seasonRange', () => {
  it('klemmt Tage an Monatslänge und überschlägt bei wrap', () => {
    const winter = { startMonth: 11, startDay: 15, endMonth: 2, endDay: 31 };
    expect(seasonRange(winter, 2025)).toEqual({ from: '2025-11-15', to: '2026-02-28' });
  });
  it('ohne wrap im selben Jahr', () => {
    const s = { startMonth: 10, startDay: 1, endMonth: 12, endDay: 31 };
    expect(seasonRange(s, 2025)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
  });
});

describe('parseSeasonSettings / serializeSeasonSettings', () => {
  it('liefert Defaults bei null/ungültig', () => {
    expect(parseSeasonSettings(null)).toEqual(DEFAULT_SEASON_SETTINGS);
    expect(parseSeasonSettings('kein-json')).toEqual(DEFAULT_SEASON_SETTINGS);
  });
  it('füllt fehlende Teile mit Defaults', () => {
    const parsed = parseSeasonSettings(JSON.stringify({ winter: { startMonth: 9, startDay: 1, endMonth: 2, endDay: 28 } }));
    expect(parsed.winter).toEqual({ startMonth: 9, startDay: 1, endMonth: 2, endDay: 28 });
    expect(parsed.summer).toEqual(DEFAULT_SEASON_SETTINGS.summer);
  });
  it('klemmt ungültige Werte beim Parsen', () => {
    const parsed = parseSeasonSettings(JSON.stringify({
      winter: { startMonth: 99, startDay: -3, endMonth: 0, endDay: 50 },
      summer: { startMonth: 4, startDay: 1, endMonth: 9, endDay: 30 },
    }));
    expect(parsed.winter).toEqual({ startMonth: 12, startDay: 1, endMonth: 1, endDay: 31 });
  });
  it('round-trip serialize → parse', () => {
    const s = serializeSeasonSettings(DEFAULT_SEASON_SETTINGS);
    expect(parseSeasonSettings(s)).toEqual(DEFAULT_SEASON_SETTINGS);
  });
  it('normalizeSeasonRange klemmt Bereiche', () => {
    expect(normalizeSeasonRange({ startMonth: 0, startDay: 0, endMonth: 13, endDay: 99 })).toEqual({
      startMonth: 1,
      startDay: 1,
      endMonth: 12,
      endDay: 31,
    });
  });
});
