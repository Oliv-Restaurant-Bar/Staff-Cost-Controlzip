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
  buildMonthWeekdayBreakdown,
  buildWeekdaySummary,
  countWeekdayOccurrences,
  countWeekdayOccurrencesInMonth,
  presetRange,
  seasonRange,
  parseSeasonSettings,
  serializeSeasonSettings,
  normalizeSeasonRange,
  DEFAULT_SEASON_SETTINGS,
  METRICS,
  METRIC_LABEL,
  metricValue,
  cellAverage,
  matrixCellDisplay,
  WEEKDAY_PLURAL,
  weekdayOccurrenceLabel,
  avgReservationsPerWeekdayLabel,
  avgPersonsPerWeekdayLabel,
  AVG_PERSONS_PER_RESERVATION_LABEL,
  headlineLabel,
  weekdayHeadlineValue,
  buildWeekdayHeadlines,
  WEEKDAY_RANK_LABEL,
  MONTH_COMPARISON_DEFAULT_OPEN,
  shiftMonthKey,
  monthRange,
  rangeFromMonthKeys,
  PRESET_LABEL,
  buildPeriodInterpretation,
  buildMonthComparison,
  buildMonthComparisonInsights,
  comparisonCellValue,
  comparisonCellSubLabel,
  headlineUnit,
  buildMonthWeekdayDetail,
  buildRangeWeekdayDetail,
  buildWeekdayComparison,
  classifyWeekdayHeat,
  HEAT_VERY_STRONG_RATIO,
  HEAT_ABOVE_RATIO,
  HEAT_BELOW_RATIO,
  HEAT_VERY_WEAK_RATIO,
  detailCellValue,
  buildDetailFormula,
  buildDetailComparison,
  buildDetailInsights,
  formatIsoDateDe,
  isoWeekdayOf,
  isoWeeksInYear,
  bernHolidayWeeks,
  bernHolidayPeriod,
  bernHolidayPeriods,
  holidayBounds,
  holidayPeriodForMonth,
  aggregateHolidayWeekday,
  buildHolidayMonthComparison,
  buildHolidayPeriodSummary,
  buildHolidayInterpretation,
  isBernHolidaySelection,
  BERN_HOLIDAY_KINDS,
  BERN_HOLIDAY_LABEL,
  BERN_HOLIDAY_SELECTION_LABEL,
  HOLIDAY_EVEN_RATIO,
  seasonsToComparisonPeriods,
  buildSeasonWeekdayRanking,
  buildSeasonChartSeries,
  buildSeasonRecommendations,
  validateSeasonDefinition,
  findOverlappingSeasons,
  exampleSeasonDefinitions,
  isValidIsoDate,
  type SeasonDefinition,
  type WeekdayStat,
  type ComparisonCell,
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

// ── Kennzahl-Umschalter (Reservationen / Personen / Ø Personen pro Reservation) ─

describe('Kennzahlen-Definitionen (Toggle-Optionen)', () => {
  it('bietet genau die drei Modi in fester Reihenfolge an', () => {
    expect(METRICS).toEqual(['reservations', 'persons', 'avgPersons']);
  });
  it('hat ein deutsches Label je Modus', () => {
    expect(METRIC_LABEL.reservations).toBe('Reservationen');
    expect(METRIC_LABEL.persons).toBe('Personen');
    expect(METRIC_LABEL.avgPersons).toBe('Personen pro Reservation');
  });
});

describe('metricValue', () => {
  it('liefert Reservationen / Personen / Ø je nach Modus', () => {
    expect(metricValue(4, 10, 'reservations')).toBe(4);
    expect(metricValue(4, 10, 'persons')).toBe(10);
    expect(metricValue(4, 10, 'avgPersons')).toBeCloseTo(2.5, 6);
  });
  it('Ø ohne Reservationen → 0 (keine Division durch 0)', () => {
    expect(metricValue(0, 0, 'avgPersons')).toBe(0);
  });
});

describe('cellAverage', () => {
  it('berechnet Ø Personen pro Reservation', () => {
    expect(cellAverage({ reservations: 4, persons: 10 })).toBeCloseTo(2.5, 6);
  });
  it('null bei leerer Zelle', () => {
    expect(cellAverage({ reservations: 0, persons: 0 })).toBeNull();
  });
});

describe('matrixCellDisplay', () => {
  it("Modus 'reservations': grosse Zahl = Reservationen, Personen mitgeführt", () => {
    const d = matrixCellDisplay({ reservations: 4, persons: 10 }, 'reservations');
    expect(d.primary).toBe(4);
    expect(d.primaryIsAverage).toBe(false);
    expect(d.reservations).toBe(4);
    expect(d.persons).toBe(10);
  });
  it("Modus 'persons': grosse Zahl = Personen, Reservationen bleiben sichtbar", () => {
    const d = matrixCellDisplay({ reservations: 4, persons: 10 }, 'persons');
    expect(d.primary).toBe(10);
    expect(d.primaryIsAverage).toBe(false);
    expect(d.reservations).toBe(4); // verschwindet nie
  });
  it("Modus 'avgPersons': grosse Zahl = Ø, mit Ø-Flag, Reservationen + Personen mitgeführt", () => {
    const d = matrixCellDisplay({ reservations: 4, persons: 10 }, 'avgPersons');
    expect(d.primary).toBeCloseTo(2.5, 6);
    expect(d.primaryIsAverage).toBe(true);
    expect(d.reservations).toBe(4);
    expect(d.persons).toBe(10);
  });
  it('leere Zelle → primary null in jedem Modus', () => {
    for (const m of METRICS) {
      expect(matrixCellDisplay({ reservations: 0, persons: 0 }, m).primary).toBeNull();
    }
  });
  it('Reservationen sind in JEDEM Modus mitgeführt (verschwinden nie)', () => {
    for (const m of METRICS) {
      const d = matrixCellDisplay({ reservations: 7, persons: 21 }, m);
      expect(d.reservations).toBe(7);
    }
  });
});

// Divergierende Daten: nach Reservationen gewinnt Mo, nach Personen/Ø gewinnt Di.
//   Mo: 3 Reservationen, 6 Personen, Ø 2.0
//   Di: 2 Reservationen, 10 Personen, Ø 5.0
const DIV_ROWS: ReservationAggRow[] = [
  r('2025-10-06', 2, 'confirmed'), // Mo
  r('2025-10-13', 2, 'confirmed'), // Mo
  r('2025-10-20', 2, 'confirmed'), // Mo
  r('2025-10-07', 4, 'confirmed'), // Di
  r('2025-10-14', 6, 'confirmed'), // Di
];

describe('buildWeekdaySummary — kennzahlabhängige Extreme', () => {
  it("Default ohne Kennzahl rankt nach Reservationen (Rückwärtskompatibilität)", () => {
    const agg = aggregateByWeekday(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const matrix = buildMonthWeekdayMatrix(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const s = buildWeekdaySummary(agg, matrix, 1);
    expect(s.metric).toBe('reservations');
    expect(s.strongestWeekday).toMatchObject({ weekday: 1, reservations: 3 });
    expect(s.weakestWeekday).toMatchObject({ weekday: 2, reservations: 2 });
  });

  it("Modus 'persons': stärkster/schwächster Wochentag wechselt, Reservationen bleiben im Extrem", () => {
    const agg = aggregateByWeekday(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const matrix = buildMonthWeekdayMatrix(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const s = buildWeekdaySummary(agg, matrix, 1, 'persons');
    expect(s.metric).toBe('persons');
    // Nach Personen gewinnt Dienstag (10) vor Montag (6).
    expect(s.strongestWeekday).toMatchObject({ weekday: 2, persons: 10, value: 10 });
    expect(s.weakestWeekday).toMatchObject({ weekday: 1, persons: 6, value: 6 });
    // Reservationen sind weiterhin im Extrem enthalten (für die kleine Zeile).
    expect(s.strongestWeekday!.reservations).toBe(2);
    expect(s.weakestWeekday!.reservations).toBe(3);
  });

  it("Modus 'avgPersons': rankt nach Ø Personen/Reservation; value = Ø", () => {
    const agg = aggregateByWeekday(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const matrix = buildMonthWeekdayMatrix(DIV_ROWS, '2025-10-01', '2025-10-31', 'booked');
    const s = buildWeekdaySummary(agg, matrix, 1, 'avgPersons');
    expect(s.metric).toBe('avgPersons');
    expect(s.strongestWeekday!.weekday).toBe(2);
    expect(s.strongestWeekday!.avgPersons).toBeCloseTo(5, 6);
    expect(s.strongestWeekday!.value).toBeCloseTo(5, 6);
    expect(s.weakestWeekday!.weekday).toBe(1);
    expect(s.weakestWeekday!.avgPersons).toBeCloseTo(2, 6);
  });
});

// Monatsextreme für einen Fokus-Wochentag, divergierend nach Kennzahl.
//   Fokus Dienstag — Okt: 2 Res / 4 Pers (Ø 2) · Nov: 1 Res / 10 Pers (Ø 10)
const MONTH_DIV_ROWS: ReservationAggRow[] = [
  r('2025-10-07', 2, 'confirmed'), // Di Okt
  r('2025-10-14', 2, 'confirmed'), // Di Okt
  r('2025-11-04', 10, 'confirmed'), // Di Nov
];

describe('buildWeekdaySummary — Monatsextreme je Kennzahl', () => {
  const FROM = '2025-10-01';
  const TO = '2025-11-30';
  it('nach Reservationen: bester Monat Okt, schwächster Nov', () => {
    const agg = aggregateByWeekday(MONTH_DIV_ROWS, FROM, TO, 'booked');
    const matrix = buildMonthWeekdayMatrix(MONTH_DIV_ROWS, FROM, TO, 'booked');
    const s = buildWeekdaySummary(agg, matrix, 2, 'reservations');
    expect(s.bestMonthForWeekday).toMatchObject({ monthKey: '2025-10', reservations: 2 });
    expect(s.worstMonthForWeekday).toMatchObject({ monthKey: '2025-11', reservations: 1 });
  });
  it('nach Personen: bester Monat Nov, schwächster Okt; Reservationen mitgeführt', () => {
    const agg = aggregateByWeekday(MONTH_DIV_ROWS, FROM, TO, 'booked');
    const matrix = buildMonthWeekdayMatrix(MONTH_DIV_ROWS, FROM, TO, 'booked');
    const s = buildWeekdaySummary(agg, matrix, 2, 'persons');
    expect(s.bestMonthForWeekday).toMatchObject({ monthKey: '2025-11', persons: 10 });
    expect(s.worstMonthForWeekday).toMatchObject({ monthKey: '2025-10', persons: 4 });
    expect(s.bestMonthForWeekday!.reservations).toBe(1);
  });
});

// ── Wochentags-Vorkommen im Zeitraum ──────────────────────────────────────────

describe('countWeekdayOccurrences', () => {
  it('zählt Wochentags-Vorkommen in einem Monat (Dez 2025: 5 Montage)', () => {
    const occ = countWeekdayOccurrences('2025-12-01', '2025-12-31');
    // Dez 2025: Mo 1/8/15/22/29 = 5, Di/Mi 5, Do–So 4
    expect(occ[1]).toBe(5); // Montag
    expect(occ[2]).toBe(5); // Dienstag
    expect(occ[3]).toBe(5); // Mittwoch
    expect(occ[4]).toBe(4); // Donnerstag
    expect(occ[7]).toBe(4); // Sonntag
    const total = (Object.values(occ) as number[]).reduce((s, n) => s + n, 0);
    expect(total).toBe(31);
  });

  it('summiert über mehrere Monate (Okt–Dez 2025: 13 Montage, 92 Tage)', () => {
    const occ = countWeekdayOccurrences(FULL_FROM, FULL_TO);
    expect(occ[1]).toBe(13); // Okt 4 + Nov 4 + Dez 5
    const total = (Object.values(occ) as number[]).reduce((s, n) => s + n, 0);
    expect(total).toBe(92); // 31 + 30 + 31
  });

  it('Grenzen inklusive; Einzeltag liefert genau einen Wochentag', () => {
    const occ = countWeekdayOccurrences('2025-12-25', '2025-12-25'); // Donnerstag
    expect(occ).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0, 7: 0 });
  });

  it('from > to oder ungültig → alle 0', () => {
    expect(countWeekdayOccurrences('2025-12-31', '2025-12-01')).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
    expect(countWeekdayOccurrences('kaputt', '2025-12-01')).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 });
  });
});

describe('countWeekdayOccurrencesInMonth', () => {
  it('begrenzt auf die Schnittmenge Monat × Zeitraum', () => {
    // Voller Oktober: 4 Montage (6/13/20/27)
    expect(countWeekdayOccurrencesInMonth('2025-10', FULL_FROM, FULL_TO)[1]).toBe(4);
    // Oktober ab dem 15.: nur 20 + 27 = 2 Montage
    expect(countWeekdayOccurrencesInMonth('2025-10', '2025-10-15', '2025-10-31')[1]).toBe(2);
  });

  it('Monat ausserhalb des Zeitraums → alle 0', () => {
    expect(countWeekdayOccurrencesInMonth('2025-09', FULL_FROM, FULL_TO)).toEqual({
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0,
    });
  });

  it('ungültiger Monatsschlüssel → alle 0', () => {
    expect(countWeekdayOccurrencesInMonth('2025-13', FULL_FROM, FULL_TO)).toEqual({
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0,
    });
  });
});

// ── Erweiterte Wochentags-Kennzahlen (Vorkommen + Durchschnitte) ──────────────

describe('aggregateByWeekday — Vorkommen + Tagesdurchschnitte', () => {
  it('führt Vorkommen, Ø Reservationen/Tag und Ø Personen/Tag je Wochentag', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    // Montag: 13 Vorkommen, 5 Reservationen, 17 Personen
    expect(mon.occurrences).toBe(13);
    expect(mon.avgReservationsPerDay).toBeCloseTo(5 / 13, 6);
    expect(mon.avgPersonsPerDay).toBeCloseTo(17 / 13, 6);
    expect(mon.avgPersons).toBeCloseTo(17 / 5, 6); // Personen pro Reservation bleibt
  });

  it('Gesamt: Vorkommen, Ø Reservationen/Tag und Ø Personen/Reservation', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    expect(agg.totalOccurrences).toBe(92);
    expect(agg.avgReservationsPerDay).toBeCloseTo(7 / 92, 6);
    expect(agg.avgPersonsPerReservation).toBeCloseTo(30 / 7, 6);
  });

  it('leere Daten: Vorkommen bleiben, Ø Reservationen/Tag = 0, Ø Personen/Res = null', () => {
    const agg = aggregateByWeekday([], FULL_FROM, FULL_TO, 'booked');
    expect(agg.totalOccurrences).toBe(92);
    expect(agg.avgReservationsPerDay).toBe(0); // 0/92, keine Division durch 0
    expect(agg.avgPersonsPerReservation).toBeNull(); // keine Reservation
    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    expect(mon.occurrences).toBe(13);
    expect(mon.avgReservationsPerDay).toBe(0);
    expect(mon.avgPersonsPerDay).toBe(0);
  });
});

// ── Monats-Wochentag-Aufschlüsselung ──────────────────────────────────────────

describe('buildMonthWeekdayBreakdown', () => {
  it('liefert eine Zeile je (Monat, Wochentag) mit Vorkommen + Durchschnitten', () => {
    const rows = buildMonthWeekdayBreakdown(ROWS, FULL_FROM, FULL_TO, 'booked');
    // Drei Monate, je 7 Wochentage (alle kommen im vollen Monat vor) = 21 Zeilen
    expect(rows).toHaveLength(21);
    expect([...new Set(rows.map((r2) => r2.monthKey))]).toEqual(['2025-10', '2025-11', '2025-12']);

    const octMon = rows.find((r2) => r2.monthKey === '2025-10' && r2.weekday === 1)!;
    expect(octMon).toMatchObject({ occurrences: 4, reservations: 3, persons: 9 });
    expect(octMon.avgReservationsPerDay).toBeCloseTo(3 / 4, 6);
    expect(octMon.avgPersonsPerDay).toBeCloseTo(9 / 4, 6);
    expect(octMon.avgPersons).toBeCloseTo(9 / 3, 6);

    // Wochentag ohne Reservationen erscheint trotzdem (Vorkommen > 0).
    const octSun = rows.find((r2) => r2.monthKey === '2025-10' && r2.weekday === 7)!;
    expect(octSun).toMatchObject({ occurrences: 4, reservations: 0, persons: 0 });
    expect(octSun.avgReservationsPerDay).toBe(0);
    expect(octSun.avgPersons).toBeNull();
  });

  it('zeigt nur Monate mit mindestens einer Reservation im geklemmten Zeitraum', () => {
    // Ab 20.10.: Oktober hat keine Reservationen mehr (06./13. fallen weg).
    const rows = buildMonthWeekdayBreakdown(ROWS, '2025-10-20', '2025-12-31', 'booked');
    expect([...new Set(rows.map((r2) => r2.monthKey))]).toEqual(['2025-11', '2025-12']);
  });
});

// ── Labels / Konstanten (Wochentags-Texte) ────────────────────────────────────

describe('Wochentags-Labels und Konstanten', () => {
  it('WEEKDAY_PLURAL + weekdayOccurrenceLabel', () => {
    expect(WEEKDAY_PLURAL[1]).toBe('Montage');
    expect(WEEKDAY_PLURAL[6]).toBe('Samstage');
    expect(weekdayOccurrenceLabel(1)).toBe('Anzahl Montage im Zeitraum');
    expect(weekdayOccurrenceLabel(6)).toBe('Anzahl Samstage im Zeitraum');
  });

  it('Durchschnitts-Labels je Wochentag', () => {
    expect(avgReservationsPerWeekdayLabel(1)).toBe('Ø Reservationen pro Montag');
    expect(avgPersonsPerWeekdayLabel(6)).toBe('Ø Personen pro Samstag');
    expect(AVG_PERSONS_PER_RESERVATION_LABEL).toBe('Ø Personen pro Reservation');
  });

  it('headlineLabel wechselt je Modus', () => {
    expect(headlineLabel(1, 'reservations')).toBe('Ø Reservationen pro Montag');
    expect(headlineLabel(1, 'persons')).toBe('Ø Personen pro Montag');
    expect(headlineLabel(1, 'avgPersons')).toBe('Ø Personen pro Reservation');
  });

  it('WEEKDAY_RANK_LABEL deckt alle Ränge ab', () => {
    expect(WEEKDAY_RANK_LABEL.strongest).toBe('stärkster Wochentag');
    expect(WEEKDAY_RANK_LABEL.weakest).toBe('schwächster Wochentag');
    expect(WEEKDAY_RANK_LABEL.above).toBe('über Durchschnitt');
    expect(WEEKDAY_RANK_LABEL.below).toBe('unter Durchschnitt');
  });

  it('MONTH_COMPARISON_DEFAULT_OPEN ist standardmässig eingeklappt', () => {
    expect(MONTH_COMPARISON_DEFAULT_OPEN).toBe(false);
  });
});

describe('shiftMonthKey / monthRange', () => {
  it('shiftMonthKey rollt über Jahresgrenzen', () => {
    expect(shiftMonthKey('2025-01', -1)).toBe('2024-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    expect(shiftMonthKey('2025-06', 0)).toBe('2025-06');
    expect(shiftMonthKey('kaputt', 1)).toBe('kaputt');
  });

  it('monthRange liefert Monatsanfang/-ende (Schaltjahr berücksichtigt)', () => {
    expect(monthRange('2025-02')).toEqual({ from: '2025-02-01', to: '2025-02-28' });
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2025-13')).toEqual({ from: '', to: '' });
  });
});

// ── Wochentags-Headlines (Hauptwert je Modus) ─────────────────────────────────

describe('weekdayHeadlineValue / buildWeekdayHeadlines', () => {
  it('weekdayHeadlineValue liefert den Modus-Durchschnitt', () => {
    const stat: WeekdayStat = {
      weekday: 1,
      reservations: 5,
      persons: 17,
      avgPersons: 17 / 5,
      sharePct: 50,
      occurrences: 13,
      avgReservationsPerDay: 5 / 13,
      avgPersonsPerDay: 17 / 13,
    };
    expect(weekdayHeadlineValue(stat, 'reservations')).toBeCloseTo(5 / 13, 6);
    expect(weekdayHeadlineValue(stat, 'persons')).toBeCloseTo(17 / 13, 6);
    expect(weekdayHeadlineValue(stat, 'avgPersons')).toBeCloseTo(17 / 5, 6);
  });

  it('buildWeekdayHeadlines bestimmt stärksten/schwächsten aktiven Wochentag', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    expect(head.metric).toBe('reservations');
    expect(head.headlines).toHaveLength(7);
    // Aktiv (booked): Mo 5, Di 1, Do 1 → stärkster Mo, schwächster Di (früher als Do).
    expect(head.strongest).toBe(1);
    expect(head.weakest).toBe(2);
    expect(head.average).toBeCloseTo((5 / 13 + 1 / 13 + 1 / 13) / 3, 6);
  });
});

// ── Monatsvergleich: Zellwert + Sekundärzeile + Einheit ───────────────────────

describe('comparisonCellValue', () => {
  it('reservations = Reservationen pro Vorkommen', () => {
    expect(comparisonCellValue(8, 16, 4, 'reservations')).toBeCloseTo(2, 6);
    expect(comparisonCellValue(8, 16, 0, 'reservations')).toBeNull(); // keine Vorkommen
  });
  it('persons = Personen pro Vorkommen', () => {
    expect(comparisonCellValue(4, 24, 4, 'persons')).toBeCloseTo(6, 6);
    expect(comparisonCellValue(4, 24, 0, 'persons')).toBeNull();
  });
  it('avgPersons = Personen pro Reservation', () => {
    expect(comparisonCellValue(5, 40, 5, 'avgPersons')).toBeCloseTo(8, 6);
    expect(comparisonCellValue(0, 0, 5, 'avgPersons')).toBeNull(); // keine Reservation
  });
});

describe('comparisonCellSubLabel', () => {
  const cell = (over: Partial<ComparisonCell>): ComparisonCell => ({
    monthKey: '2025-10', weekday: 5, occurrences: 5, reservations: 205, persons: 808,
    value: 41, rank: 'above', isTop: false, isLow: false, ...over,
  });
  it('reservations → „205 Res. / 5 Fr."', () => {
    expect(comparisonCellSubLabel(cell({}), 'reservations')).toBe('205 Res. / 5 Fr.');
  });
  it('persons → „808 Pers. / 5 Fr."', () => {
    expect(comparisonCellSubLabel(cell({}), 'persons')).toBe('808 Pers. / 5 Fr.');
  });
  it('avgPersons → „808 Pers. / 205 Res."', () => {
    expect(comparisonCellSubLabel(cell({}), 'avgPersons')).toBe('808 Pers. / 205 Res.');
  });
  it('leer, wenn nichts anzuzeigen ist', () => {
    expect(comparisonCellSubLabel(cell({ occurrences: 0 }), 'reservations')).toBe('');
    expect(comparisonCellSubLabel(cell({ reservations: 0 }), 'avgPersons')).toBe('');
  });
});

describe('headlineUnit', () => {
  it('wechselt je Modus', () => {
    expect(headlineUnit(6, 'reservations')).toBe('Reservationen pro Samstag');
    expect(headlineUnit(6, 'persons')).toBe('Personen pro Samstag');
    expect(headlineUnit(6, 'avgPersons')).toBe('Personen pro Reservation');
  });
});

// ── Monatsvergleich-Matrix + Insights ─────────────────────────────────────────

// Alle Reservationen je Monat auf EINEN passenden Wochentag gelegt; die Zell-
// werte ergeben sich aus den KALENDER-Vorkommen (nicht aus der Datenverteilung).
const repeat = (date: string, count: number, party: number): ReservationAggRow[] =>
  Array.from({ length: count }, () => r(date, party, 'confirmed'));

// Montag je Monat: Okt 8 Res/16 Pers (Ø 2.0/4.0/2.0), Nov 4/24 (1.0/6.0/6.0),
// Dez 5/40 (1.0/8.0/8.0). → Reservationen: bester Okt; Personen/Ø Pers.: bester Dez.
const COMP_ROWS: ReservationAggRow[] = [
  ...repeat('2025-10-06', 8, 2), // Mo, Okt (4 Montage)
  ...repeat('2025-11-03', 4, 6), // Mo, Nov (4 Montage)
  ...repeat('2025-12-01', 5, 8), // Mo, Dez (5 Montage)
];

describe('buildMonthComparison', () => {
  it('baut eine Zeile je Monat mit allen 7 Wochentagen', () => {
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    expect(cmp.metric).toBe('reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual(['2025-10', '2025-11', '2025-12']);
    for (const m of cmp.months) {
      expect(Object.keys(m.cells)).toHaveLength(7);
    }
  });

  it('Montag-Zellwerte + Spalten-Ø/Top/Tief (Modus Reservationen)', () => {
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const oct = cmp.months.find((m) => m.monthKey === '2025-10')!.cells[1];
    const nov = cmp.months.find((m) => m.monthKey === '2025-11')!.cells[1];
    const dec = cmp.months.find((m) => m.monthKey === '2025-12')!.cells[1];
    expect(oct.value).toBeCloseTo(2, 6); // 8 / 4
    expect(nov.value).toBeCloseTo(1, 6); // 4 / 4
    expect(dec.value).toBeCloseTo(1, 6); // 5 / 5

    const col = cmp.columns[1];
    expect(col.average).toBeCloseTo((2 + 1 + 1) / 3, 6);
    expect(col.best).toMatchObject({ monthKey: '2025-10' });
    expect(col.worst).toMatchObject({ monthKey: '2025-11' }); // Gleichstand → früher

    expect(oct.rank).toBe('above');
    expect(oct.isTop).toBe(true);
    expect(nov.rank).toBe('below');
    expect(nov.isLow).toBe(true);
  });

  it('Modus-Wechsel kehrt bester/schwächster Monat um (Personen)', () => {
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'persons');
    const col = cmp.columns[1];
    expect(col.best).toMatchObject({ monthKey: '2025-12' }); // 8.0 Pers./Montag
    expect(col.worst).toMatchObject({ monthKey: '2025-10' }); // 4.0 Pers./Montag
  });

  it('Gleichstand am Extremwert markiert ALLE betroffenen Zellen (Heatmap-Logik)', () => {
    // Nov 1.0 und Dez 1.0 liegen beide am Tief → beide isLow; best/worst nennen
    // aber nur den jeweils früheren Monat.
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const nov = cmp.months.find((m) => m.monthKey === '2025-11')!.cells[1];
    const dec = cmp.months.find((m) => m.monthKey === '2025-12')!.cells[1];
    expect(nov.isLow).toBe(true);
    expect(dec.isLow).toBe(true); // gleicher Tiefwert → ebenfalls markiert
    expect(cmp.columns[1].worst).toMatchObject({ monthKey: '2025-11' }); // früherer Monat
  });

  it('leere Daten → keine Monate, leere Spalten', () => {
    const cmp = buildMonthComparison([], FULL_FROM, FULL_TO, 'booked', 'reservations');
    expect(cmp.months).toHaveLength(0);
    expect(cmp.columns[1]).toEqual({ weekday: 1, average: null, best: null, worst: null });
  });
});

describe('buildMonthComparisonInsights', () => {
  it('nennt stärksten Wochentag + besten/schlechtesten Fokus-Monat (Reservationen)', () => {
    const agg = aggregateByWeekday(COMP_ROWS, FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const ins = buildMonthComparisonInsights(head, cmp, 1, 'reservations');
    expect(ins.length).toBeGreaterThanOrEqual(3);
    expect(ins.length).toBeLessThanOrEqual(5);
    expect(ins[0]).toContain('Stärkster Wochentag im Zeitraum: Montag');
    expect(ins).toContain('Bester Montag war im Oktober 2025 mit Ø 2.0 Reservationen pro Montag.');
    expect(ins).toContain('Schlechtester Montag war im November 2025 mit Ø 1.0 Reservationen pro Montag.');
  });

  it('Insights wechseln mit dem Modus (Personen: bester Montag im Dezember)', () => {
    const agg = aggregateByWeekday(COMP_ROWS, FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'persons');
    const cmp = buildMonthComparison(COMP_ROWS, FULL_FROM, FULL_TO, 'booked', 'persons');
    const ins = buildMonthComparisonInsights(head, cmp, 1, 'persons');
    expect(ins).toContain('Bester Montag war im Dezember 2025 mit Ø 8.0 Personen pro Montag.');
    expect(ins).toContain('Schlechtester Montag war im Oktober 2025 mit Ø 4.0 Personen pro Montag.');
  });

  it('Fallback: garantiert ≥ 3 Sätze auch bei einem einzigen Monat', () => {
    // Nur ein Monat mit Montags-Daten → wenig „natürliche" Insights; die
    // deskriptiven Fallback-Sätze füllen bis auf mindestens 3 auf.
    const ONE_MONTH: ReservationAggRow[] = [...repeat('2025-10-06', 8, 2)];
    const agg = aggregateByWeekday(ONE_MONTH, '2025-10-01', '2025-10-31', 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison(ONE_MONTH, '2025-10-01', '2025-10-31', 'booked', 'reservations');
    const ins = buildMonthComparisonInsights(head, cmp, 1, 'reservations');
    expect(ins.length).toBeGreaterThanOrEqual(3);
    expect(ins.length).toBeLessThanOrEqual(5);
    expect(ins.some((s) => s.includes('Verglichen wird 1 Monat'))).toBe(true);
  });

  it('Konsistenz-Insight: Wochentage über dem Durchschnitt in allen Monaten', () => {
    // Mo Ø1.0, Fr Ø3.0, Sa Ø4.0 je Monat → Referenz-Ø 8/3; Fr & Sa immer darüber.
    const CONSISTENCY_ROWS: ReservationAggRow[] = [
      ...repeat('2025-10-06', 4, 2), ...repeat('2025-10-03', 15, 2), ...repeat('2025-10-04', 16, 2),
      ...repeat('2025-11-03', 4, 2), ...repeat('2025-11-07', 12, 2), ...repeat('2025-11-01', 20, 2),
      ...repeat('2025-12-01', 5, 2), ...repeat('2025-12-05', 12, 2), ...repeat('2025-12-06', 16, 2),
    ];
    const agg = aggregateByWeekday(CONSISTENCY_ROWS, FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison(CONSISTENCY_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const ins = buildMonthComparisonInsights(head, cmp, 5, 'reservations');
    expect(ins).toContain('Freitag und Samstag liegen in allen Monaten über dem Durchschnitt.');
  });
});

// ── Detail-Popup (Monatsvergleich-Zelle) ──────────────────────────────────────
// Mondays im Oktober 2025 (2025-10-01 = Mi): 06., 13., 20., 27. (4×).
// Mondays im November 2025 (2025-11-01 = Sa): 03., 10., 17., 24. (4×).
const DETAIL_ROWS: ReservationAggRow[] = [
  // Mo 2025-10-06: 2 Res. (3 + 5 Pers. = 8)
  r('2025-10-06', 3, 'confirmed'),
  r('2025-10-06', 5, 'completed'),
  // Mo 2025-10-13: 3 Res. (2 + 4 + 6 Pers. = 12)
  r('2025-10-13', 2, 'confirmed'),
  r('2025-10-13', 4, 'confirmed'),
  r('2025-10-13', 6, 'confirmed'),
  // Mo 2025-10-20: 1 Res. (4 Pers.)
  r('2025-10-20', 4, 'confirmed'),
  // Mo 2025-10-20: 1 storniert → unter 'booked' ausgeschlossen
  r('2025-10-20', 9, 'cancelled'),
  // Mo 2025-10-27: keine Reservation → 0-Tag
  // Di 2025-10-07: anderer Wochentag → nicht im Montags-Detail
  r('2025-10-07', 7, 'confirmed'),
  // Mo 2025-11-03: anderer Monat (1 Res.)
  r('2025-11-03', 8, 'confirmed'),
];

describe('formatIsoDateDe', () => {
  it('wandelt yyyy-MM-dd in dd.MM.yyyy', () => {
    expect(formatIsoDateDe('2025-10-06')).toBe('06.10.2025');
    expect(formatIsoDateDe('2025-01-01')).toBe('01.01.2025');
  });
  it('lässt ungültige Eingaben unverändert', () => {
    expect(formatIsoDateDe('foo')).toBe('foo');
    expect(formatIsoDateDe('2025-10')).toBe('2025-10');
  });
});

describe('buildMonthWeekdayDetail', () => {
  it('enumeriert ALLE Montage im Oktober inkl. 0-Tag (days.length === occurrences)', () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');
    expect(d.occurrences).toBe(4);
    expect(d.days.map((x) => x.date)).toEqual([
      '2025-10-06', '2025-10-13', '2025-10-20', '2025-10-27',
    ]);
    expect(d.days.length).toBe(d.occurrences);
  });

  it('summiert Reservationen/Personen korrekt (storniert + Fremdtag/-monat ausgeschlossen)', () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');
    expect(d.reservations).toBe(6);
    expect(d.persons).toBe(24);
    expect(d.avgReservationsPerDay).toBeCloseTo(1.5, 6);
    expect(d.avgPersonsPerDay).toBeCloseTo(6.0, 6);
    expect(d.avgPersonsPerReservation).toBeCloseTo(4.0, 6);
  });

  it('liefert pro Tag Reservationen/Personen/Ø + null-Ø für den 0-Tag', () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');
    expect(d.days[0]).toEqual({ date: '2025-10-06', reservations: 2, persons: 8, avgPersonsPerReservation: 4 });
    expect(d.days[1]).toEqual({ date: '2025-10-13', reservations: 3, persons: 12, avgPersonsPerReservation: 4 });
    expect(d.days[2]).toEqual({ date: '2025-10-20', reservations: 1, persons: 4, avgPersonsPerReservation: 4 });
    expect(d.days[3]).toEqual({ date: '2025-10-27', reservations: 0, persons: 0, avgPersonsPerReservation: null });
  });

  it("Scope 'all' zählt den stornierten Montag mit", () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'all');
    expect(d.reservations).toBe(7);
    expect(d.persons).toBe(33);
    expect(d.days[2]).toEqual({ date: '2025-10-20', reservations: 2, persons: 13, avgPersonsPerReservation: 6.5 });
  });

  it('Detail-Summen entsprechen exakt der Matrix-Zelle', () => {
    const cmp = buildMonthComparison(DETAIL_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const oct = cmp.months.find((m) => m.monthKey === '2025-10')!;
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');
    expect(detailCellValue(d, 'reservations')).toBeCloseTo(oct.cells[1].value!, 6);
  });

  it('ungültiger Monatsschlüssel → leeres Detail', () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-13', 1, 'booked');
    expect(d.occurrences).toBe(0);
    expect(d.days).toEqual([]);
    expect(d.avgReservationsPerDay).toBeNull();
  });
});

describe('detailCellValue', () => {
  it('spiegelt comparisonCellValue je Modus', () => {
    const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');
    expect(detailCellValue(d, 'reservations')).toBeCloseTo(1.5, 6);
    expect(detailCellValue(d, 'persons')).toBeCloseTo(6.0, 6);
    expect(detailCellValue(d, 'avgPersons')).toBeCloseTo(4.0, 6);
  });
});

describe('buildDetailFormula', () => {
  const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');

  it('Reservationen: Vorkommen ÷ Vorkommen', () => {
    const f = buildDetailFormula(d, 'reservations');
    expect(f.lines[0]).toBe('Montag kam im Oktober 2025 4× vor.');
    expect(f.lines[1]).toBe('Total Reservationen an Montagen: 6');
    expect(f.lines[2]).toBe('Rechnung: 6 Reservationen ÷ 4 Montage = Ø 1.5 Reservationen pro Montag');
    expect(f.result).toBeCloseTo(1.5, 6);
    expect(f.resultLabel).toBe('Ø 1.5 Reservationen pro Montag');
  });

  it('Personen: Personen ÷ Vorkommen', () => {
    const f = buildDetailFormula(d, 'persons');
    expect(f.lines[1]).toBe('Total Personen an Montagen: 24');
    expect(f.lines[2]).toBe('Rechnung: 24 Personen ÷ 4 Montage = Ø 6.0 Personen pro Montag');
    expect(f.result).toBeCloseTo(6.0, 6);
  });

  it('Ø Personen/Reservation: Personen ÷ Reservationen', () => {
    const f = buildDetailFormula(d, 'avgPersons');
    expect(f.lines[0]).toBe('Total Personen an Montagen: 24');
    expect(f.lines[1]).toBe('Total Reservationen an Montagen: 6');
    expect(f.lines[2]).toBe('Rechnung: 24 Personen ÷ 6 Reservationen = Ø 4.0 Personen pro Reservation');
    expect(f.resultLabel).toBe('Ø 4.0 Personen pro Reservation');
  });
});

describe('buildDetailComparison', () => {
  const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');

  it('über dem Spalten-Durchschnitt', () => {
    const c = buildDetailComparison(d, 'reservations', 0.875);
    expect(c.cellValue).toBeCloseTo(1.5, 6);
    expect(c.columnAverage).toBe(0.875);
    expect(c.difference).toBeCloseTo(0.625, 6);
    expect(c.direction).toBe('above');
  });

  it('unter dem Spalten-Durchschnitt', () => {
    const c = buildDetailComparison(d, 'reservations', 2.0);
    expect(c.difference).toBeCloseTo(-0.5, 6);
    expect(c.direction).toBe('below');
  });

  it('gleich (innerhalb Epsilon)', () => {
    const c = buildDetailComparison(d, 'reservations', 1.5);
    expect(c.direction).toBe('equal');
  });

  it('kein Spalten-Ø → keine Richtung', () => {
    const c = buildDetailComparison(d, 'reservations', null);
    expect(c.difference).toBeNull();
    expect(c.direction).toBeNull();
  });

  it('Spalten-Ø aus buildMonthComparison passt zur Detail-Zelle (Integration)', () => {
    // Oktober Mo = 1.5, November Mo = 0.25 → Spalten-Ø = 0.875.
    const cmp = buildMonthComparison(DETAIL_ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const c = buildDetailComparison(d, 'reservations', cmp.columns[1].average);
    expect(c.columnAverage).toBeCloseTo(0.875, 6);
    expect(c.direction).toBe('above');
  });
});

describe('buildDetailInsights', () => {
  const d = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 1, 'booked');

  it('nennt Über-Durchschnitt, stärksten Tag und Ø-Personen-Einordnung', () => {
    const ins = buildDetailInsights(d, 'reservations', 0.875);
    expect(ins.length).toBeGreaterThanOrEqual(2);
    expect(ins.length).toBeLessThanOrEqual(3);
    expect(ins).toContain('Dieser Montag liegt über dem Durchschnitt aller Montage im Zeitraum.');
    expect(ins).toContain('Der stärkste Montag in diesem Monat war der 13.10.2025 mit 3 Reservationen.');
    expect(ins).toContain('Ø Personen pro Reservation liegt bei 4.0 und ist damit eher mittel.');
  });

  it('meldet Unter-Durchschnitt', () => {
    const ins = buildDetailInsights(d, 'reservations', 2.0);
    expect(ins).toContain('Dieser Montag liegt unter dem Durchschnitt aller Montage im Zeitraum.');
  });

  it('stärkster Tag folgt dem Modus (Personen)', () => {
    const ins = buildDetailInsights(d, 'persons', 6.0);
    expect(ins).toContain('Der stärkste Montag in diesem Monat war der 13.10.2025 mit 12 Personen.');
  });

  it('Fallback-Satz für eine Zelle ohne Reservationen', () => {
    // Sonntag im Oktober: DETAIL_ROWS hat keine Sonntags-Reservationen.
    const empty = buildMonthWeekdayDetail(DETAIL_ROWS, FULL_FROM, FULL_TO, '2025-10', 7, 'booked');
    const ins = buildDetailInsights(empty, 'reservations', null);
    expect(ins.length).toBeGreaterThanOrEqual(1);
    expect(ins.some((s) => s.includes('keine Reservationen'))).toBe(true);
  });
});

// ── Zeitraum-Auswahl: last3Months, rangeFromMonthKeys, PRESET_LABEL ───────────
// Bekannte ISO-Montage über den Jahreswechsel 2025/26:
//   2026-01-05 Mo · 2026-02-02 Mo · 2026-03-02 Mo
const CROSS_ROWS: ReservationAggRow[] = [
  r('2025-10-06', 4, 'confirmed'), // Mo Okt 2025
  r('2025-11-03', 2, 'confirmed'), // Mo Nov 2025
  r('2025-12-01', 6, 'confirmed'), // Mo Dez 2025
  r('2026-01-05', 3, 'confirmed'), // Mo Jan 2026
  r('2026-02-02', 5, 'confirmed'), // Mo Feb 2026
  r('2026-03-02', 2, 'confirmed'), // Mo Mär 2026
];

describe('presetRange – Letzte 3 Monate', () => {
  const seasons = DEFAULT_SEASON_SETTINGS;
  it('rollierendes 3-Monats-Fenster inkl. aktuellem Monat', () => {
    expect(presetRange('last3Months', { today: '2026-06-29', year: 2025, seasons })).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
  });
  it('überschlägt den Jahreswechsel', () => {
    expect(presetRange('last3Months', { today: '2026-01-15', year: 2026, seasons })).toEqual({
      from: '2025-11-01',
      to: '2026-01-31',
    });
  });
  it('PRESET_LABEL enthält die neuen/umbenannten Labels', () => {
    expect(PRESET_LABEL.thisMonth).toBe('Aktueller Monat');
    expect(PRESET_LABEL.last3Months).toBe('Letzte 3 Monate');
    expect(PRESET_LABEL.custom).toBe('Individuell');
  });
});

describe('rangeFromMonthKeys', () => {
  it('bildet Start-/Endmonat auf Monatsanfang/-ende ab', () => {
    expect(rangeFromMonthKeys('2025-10', '2025-12')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
  });
  it('funktioniert über den Jahreswechsel (Okt–Mär)', () => {
    expect(rangeFromMonthKeys('2025-10', '2026-03')).toEqual({ from: '2025-10-01', to: '2026-03-31' });
  });
  it('ungültige Schlüssel liefern leere Grenzen', () => {
    expect(rangeFromMonthKeys('kaputt', '2026-03')).toEqual({ from: '', to: '2026-03-31' });
    expect(rangeFromMonthKeys('2025-10', 'kaputt')).toEqual({ from: '2025-10-01', to: '' });
  });
});

describe('Zeitraum-Matrix: Oktober–Dezember und Jahreswechsel', () => {
  it('Oktober–Dezember 2025 → genau drei Monate in Reihenfolge', () => {
    const cmp = buildMonthComparison(ROWS, '2025-10-01', '2025-12-31', 'booked', 'reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual(['2025-10', '2025-11', '2025-12']);
  });
  it('engere Startmonat/Endmonat-Wahl grenzt die Matrix ein (nur Oktober)', () => {
    const range = rangeFromMonthKeys('2025-10', '2025-10');
    const cmp = buildMonthComparison(ROWS, range.from, range.to, 'booked', 'reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual(['2025-10']);
  });
  it('Cross-Year Okt–Mär → sechs Monate chronologisch', () => {
    const cmp = buildMonthComparison(CROSS_ROWS, '2025-10-01', '2026-03-31', 'booked', 'reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
    ]);
  });
  it('Wintersaison-Schnellwahl liefert Okt–Mär und umfasst alle sechs Monate', () => {
    const range = presetRange('winter', { today: '2026-06-29', year: 2025, seasons: DEFAULT_SEASON_SETTINGS })!;
    expect(range).toEqual({ from: '2025-10-01', to: '2026-03-31' });
    const cmp = buildMonthComparison(CROSS_ROWS, range.from, range.to, 'booked', 'reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual([
      '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
    ]);
  });
});

describe('buildPeriodInterpretation', () => {
  it('bester/schwächster Wochentag + auffällige Monate (Reservationen, Okt–Dez)', () => {
    const agg = aggregateByWeekday(ROWS, FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison(ROWS, FULL_FROM, FULL_TO, 'booked', 'reservations');
    const interp = buildPeriodInterpretation(head, cmp, 'reservations');

    expect(interp.hasData).toBe(true);
    expect(interp.bestWeekday?.weekday).toBe(1); // Montag
    expect(interp.worstWeekday?.weekday).toBe(2); // Dienstag (Gleichstand → früherer Wochentag)
    expect(interp.notableMonths).toEqual([
      { monthKey: '2025-10', value: 4, kind: 'best' },
      { monthKey: '2025-11', value: 1, kind: 'weak' },
    ]);
    expect(interp.recommendation).toContain('Montag');
    expect(interp.recommendation).toContain('Dienstag');
    expect(interp.recommendation).toContain('Oktober 2025');
  });

  it('nur ein aktiver Wochentag → Konzentrations-Empfehlung, keine auffälligen Monate', () => {
    const monOnly: ReservationAggRow[] = [
      r('2025-10-06', 4, 'confirmed'),
      r('2025-10-13', 2, 'confirmed'),
    ];
    const agg = aggregateByWeekday(monOnly, '2025-10-01', '2025-10-31', 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison(monOnly, '2025-10-01', '2025-10-31', 'booked', 'reservations');
    const interp = buildPeriodInterpretation(head, cmp, 'reservations');

    expect(interp.hasData).toBe(true);
    expect(interp.bestWeekday?.weekday).toBe(1);
    expect(interp.worstWeekday?.weekday).toBe(1);
    expect(interp.notableMonths).toEqual([]); // nur ein Monat → keine Spreizung
    expect(interp.recommendation).toContain('Montag');
    expect(interp.recommendation).toContain('übrigen Wochentagen');
  });

  it('keine Daten → hasData false + neutraler Hinweis', () => {
    const agg = aggregateByWeekday([], FULL_FROM, FULL_TO, 'booked');
    const head = buildWeekdayHeadlines(agg, 'reservations');
    const cmp = buildMonthComparison([], FULL_FROM, FULL_TO, 'booked', 'reservations');
    const interp = buildPeriodInterpretation(head, cmp, 'reservations');

    expect(interp.hasData).toBe(false);
    expect(interp.bestWeekday).toBeNull();
    expect(interp.worstWeekday).toBeNull();
    expect(interp.notableMonths).toEqual([]);
    expect(interp.recommendation).toContain('keine auswertbaren');
  });
});

describe('Detail-Popup bleibt korrekt für gefilterte (Cross-Year) Zeiträume', () => {
  it('Detail einer Zelle im gefilterten Winter-Zeitraum (Januar 2026, Montag)', () => {
    const range = presetRange('winter', { today: '2026-06-29', year: 2025, seasons: DEFAULT_SEASON_SETTINGS })!;
    const d = buildMonthWeekdayDetail(CROSS_ROWS, range.from, range.to, '2026-01', 1, 'booked');
    expect(d.occurrences).toBe(4); // 4 Montage im Januar 2026
    expect(d.days.length).toBe(d.occurrences);
    expect(d.reservations).toBe(1);
    expect(d.persons).toBe(3);
    expect(d.days[0]).toEqual({
      date: '2026-01-05',
      reservations: 1,
      persons: 3,
      avgPersonsPerReservation: 3,
    });
  });
});

// ── Schulferien Kanton Bern ───────────────────────────────────────────────────

describe('isBernHolidaySelection', () => {
  it('akzeptiert gültige Auswahlwerte', () => {
    expect(isBernHolidaySelection('all')).toBe(true);
    expect(isBernHolidaySelection('sport')).toBe(true);
    expect(isBernHolidaySelection('spring')).toBe(true);
    expect(isBernHolidaySelection('summer')).toBe(true);
    expect(isBernHolidaySelection('autumn')).toBe(true);
    expect(isBernHolidaySelection('winter')).toBe(true);
  });
  it('lehnt ungültige Werte ab', () => {
    expect(isBernHolidaySelection('')).toBe(false);
    expect(isBernHolidaySelection(null)).toBe(false);
    expect(isBernHolidaySelection(undefined)).toBe(false);
    expect(isBernHolidaySelection('herbst')).toBe(false);
    expect(isBernHolidaySelection('ALL')).toBe(false);
  });
});

describe('isoWeeksInYear', () => {
  it('erkennt 52- und 53-Wochen-Jahre', () => {
    expect(isoWeeksInYear(2025)).toBe(52);
    expect(isoWeeksInYear(2026)).toBe(53); // Do 1.1. → 53 Wochen
    expect(isoWeeksInYear(2027)).toBe(52);
    expect(isoWeeksInYear(2015)).toBe(53);
    expect(isoWeeksInYear(2020)).toBe(53); // Schaltjahr, Mi 1.1.
  });
});

describe('bernHolidayWeeks', () => {
  it('liefert die fixen DIN-Kalenderwochen je Ferienart', () => {
    expect(bernHolidayWeeks(2026, 'sport')).toEqual([{ isoYear: 2026, week: 6 }]);
    expect(bernHolidayWeeks(2026, 'spring').map((w) => w.week)).toEqual([15, 16]);
    expect(bernHolidayWeeks(2026, 'summer').map((w) => w.week)).toEqual([28, 29, 30, 31, 32]);
    expect(bernHolidayWeeks(2026, 'autumn').map((w) => w.week)).toEqual([39, 40, 41]);
  });
  it('berücksichtigt die Sommer-Ausnahme 2027 (KW 27–32)', () => {
    expect(bernHolidayWeeks(2027, 'summer').map((w) => w.week)).toEqual([27, 28, 29, 30, 31, 32]);
  });
  it('Winterferien = letzte KW des Jahres + KW 1 des Folgejahres', () => {
    expect(bernHolidayWeeks(2025, 'winter')).toEqual([
      { isoYear: 2025, week: 52 },
      { isoYear: 2026, week: 1 },
    ]);
    // 2026 ist ein 53-Wochen-Jahr → letzte KW ist 53.
    expect(bernHolidayWeeks(2026, 'winter')).toEqual([
      { isoYear: 2026, week: 53 },
      { isoYear: 2027, week: 1 },
    ]);
  });
});

describe('bernHolidayPeriod', () => {
  it('berechnet Mo→So-Datumsbereiche (2026) korrekt', () => {
    expect(bernHolidayPeriod(2026, 'sport')).toMatchObject({
      from: '2026-02-02',
      to: '2026-02-08',
      days: 7,
      weeks: [6],
    });
    expect(bernHolidayPeriod(2026, 'spring')).toMatchObject({
      from: '2026-04-06',
      to: '2026-04-19',
      days: 14,
    });
    expect(bernHolidayPeriod(2026, 'summer')).toMatchObject({
      from: '2026-07-06',
      to: '2026-08-09',
      days: 35,
    });
    expect(bernHolidayPeriod(2026, 'autumn')).toMatchObject({
      from: '2026-09-21',
      to: '2026-10-11',
      days: 21,
    });
  });
  it('Winterferien bilden einen zusammenhängenden Block über den Jahreswechsel', () => {
    const w = bernHolidayPeriod(2025, 'winter');
    expect(w).toMatchObject({ from: '2025-12-22', to: '2026-01-04', days: 14 });
    expect(w.from.slice(0, 4)).toBe('2025');
    expect(w.to.slice(0, 4)).toBe('2026');
  });
  it('Sommer 2027 ist sechs Wochen lang (Ausnahme, ab KW 27)', () => {
    expect(bernHolidayPeriod(2027, 'summer')).toMatchObject({
      from: '2027-07-05',
      to: '2027-08-15',
      days: 42,
    });
  });
  it('jede Periode beginnt an einem Montag und endet an einem Sonntag', () => {
    for (const kind of BERN_HOLIDAY_KINDS) {
      const p = bernHolidayPeriod(2026, kind);
      expect(isoWeekdayOf(p.from)).toBe(1);
      expect(isoWeekdayOf(p.to)).toBe(7);
    }
  });
});

describe('bernHolidayPeriods', () => {
  it('liefert bei "all" alle fünf Ferienarten chronologisch', () => {
    const ps = bernHolidayPeriods(2026, 'all');
    expect(ps.map((p) => p.kind)).toEqual(['sport', 'spring', 'summer', 'autumn', 'winter']);
    const froms = ps.map((p) => p.from);
    expect([...froms].sort()).toEqual(froms); // bereits aufsteigend
  });
  it('liefert bei einzelner Auswahl genau eine Periode', () => {
    const ps = bernHolidayPeriods(2026, 'autumn');
    expect(ps).toHaveLength(1);
    expect(ps[0].kind).toBe('autumn');
  });
});

describe('holidayBounds', () => {
  it('umschliesst alle Perioden einer Auswahl', () => {
    const ps = bernHolidayPeriods(2026, 'all');
    expect(holidayBounds(ps)).toEqual({ from: '2026-02-02', to: '2027-01-10' });
  });
  it('liefert null bei leerer Liste', () => {
    expect(holidayBounds([])).toBeNull();
  });
});

describe('holidayPeriodForMonth', () => {
  const ps = bernHolidayPeriods(2026, 'all');
  it('findet die den Monat überschneidende Periode', () => {
    expect(holidayPeriodForMonth(ps, '2026-07')?.kind).toBe('summer');
    expect(holidayPeriodForMonth(ps, '2026-08')?.kind).toBe('summer'); // Sommer spannt Jul+Aug
    expect(holidayPeriodForMonth(ps, '2026-02')?.kind).toBe('sport');
    expect(holidayPeriodForMonth(ps, '2026-12')?.kind).toBe('winter');
    expect(holidayPeriodForMonth(ps, '2027-01')?.kind).toBe('winter');
  });
  it('liefert null für Monate ohne Ferien', () => {
    expect(holidayPeriodForMonth(ps, '2026-03')).toBeNull();
    expect(holidayPeriodForMonth(ps, '2026-06')).toBeNull();
  });
});

describe('aggregateHolidayWeekday', () => {
  const ps = bernHolidayPeriods(2026, 'all');
  const rows: ReservationAggRow[] = [
    r('2026-02-02', 4, 'confirmed'), // Mo, Sportferien
    r('2026-02-07', 2, 'confirmed'), // Sa, Sportferien
    r('2026-04-06', 3, 'confirmed'), // Mo, Frühlingsferien
    r('2026-07-06', 5, 'confirmed'), // Mo, Sommerferien
    r('2026-03-16', 99, 'confirmed'), // Mo, KEINE Ferien → ausgeschlossen
  ];
  it('summiert je Wochentag NUR Ferientage über alle Perioden', () => {
    const agg = aggregateHolidayWeekday(rows, ps, 'booked');
    const mon = agg.weekdays.find((w) => w.weekday === 1)!;
    const sat = agg.weekdays.find((w) => w.weekday === 6)!;
    expect(mon.reservations).toBe(3); // Feb2 + Apr6 + Jul6 (Mär16 ausgeschlossen)
    expect(sat.reservations).toBe(1);
    expect(agg.totalReservations).toBe(4);
    expect(agg.totalPersons).toBe(4 + 2 + 3 + 5);
    expect(agg.avgPersonsPerReservation).toBeCloseTo(14 / 4, 6);
  });
  it('zählt Vorkommen als Summe aller Ferientage', () => {
    const agg = aggregateHolidayWeekday(rows, ps, 'booked');
    // 7 + 14 + 35 + 21 + 14 = 91 Ferientage
    expect(agg.totalOccurrences).toBe(91);
  });
});

describe('buildHolidayMonthComparison', () => {
  const ps = [bernHolidayPeriod(2026, 'summer')]; // 2026-07-06 .. 2026-08-09
  const rows: ReservationAggRow[] = [
    r('2026-07-06', 4, 'confirmed'), // Mo (Jul)
    r('2026-07-13', 4, 'confirmed'), // Mo (Jul)
    r('2026-08-03', 2, 'confirmed'), // Mo (Aug, im Zeitraum)
    r('2026-08-10', 99, 'confirmed'), // Mo (Aug, NACH Zeitraum → ausgeschlossen)
  ];
  it('führt Monate zusammen und zählt Vorkommen ferien-genau', () => {
    const cmp = buildHolidayMonthComparison(rows, ps, 'booked', 'reservations');
    expect(cmp.months.map((m) => m.monthKey)).toEqual(['2026-07', '2026-08']);
    const jul = cmp.months[0];
    const aug = cmp.months[1];
    // Juli: Montage im Zeitraum 06.–31.07 = 6,13,20,27 → 4 Vorkommen; 2 Reservationen
    expect(jul.cells[1].reservations).toBe(2);
    expect(jul.cells[1].occurrences).toBe(4);
    expect(jul.cells[1].value).toBeCloseTo(0.5, 6);
    // August: Montage im Zeitraum 01.–09.08 = nur 03.08 → 1 Vorkommen; 1 Reservation
    expect(aug.cells[1].reservations).toBe(1); // 10.08 ausgeschlossen
    expect(aug.cells[1].occurrences).toBe(1);
    expect(aug.cells[1].value).toBeCloseTo(1, 6);
    // Nicht-Montage bleiben leer
    expect(jul.cells[2].reservations).toBe(0);
  });
});

describe('buildHolidayPeriodSummary', () => {
  it('markiert zukünftige leere Perioden und liefert den Leer-Hinweis', () => {
    const p = bernHolidayPeriod(2030, 'sport');
    const s = buildHolidayPeriodSummary([], p, 'booked', 'reservations', '2026-07-01');
    expect(s.hasReservations).toBe(false);
    expect(s.isFuture).toBe(true);
    expect(s.interpretation).toBe('Während der Sportferien liegen keine Reservationen vor.');
  });
  it('erkennt einen deutlich stärkeren Wochentag', () => {
    const rows: ReservationAggRow[] = [
      // Herbstferien 2025: 22.09.–12.10. — Samstage 27.09, 04.10, 11.10; Montag 22.09
      r('2025-09-27', 10, 'confirmed'),
      r('2025-10-04', 10, 'confirmed'),
      r('2025-10-11', 10, 'confirmed'),
      r('2025-09-22', 2, 'confirmed'),
    ];
    const p = bernHolidayPeriod(2025, 'autumn');
    const s = buildHolidayPeriodSummary(rows, p, 'booked', 'reservations', '2026-07-01');
    expect(s.hasReservations).toBe(true);
    expect(s.isFuture).toBe(false);
    expect(s.strongest?.weekday).toBe(6);
    expect(s.weakest?.weekday).toBe(1);
    expect(s.interpretation).toBe(
      'Während der Herbstferien ist der Samstag stärker als der Montag.',
    );
  });
  it('erkennt eine gleichmässige Verteilung (Ratio ≤ HOLIDAY_EVEN_RATIO)', () => {
    // Sportferien-Woche: jeder Wochentag genau 1× → Wert = Anzahl Reservationen.
    const rows: ReservationAggRow[] = [
      ...Array.from({ length: 5 }, () => r('2026-02-02', 2, 'confirmed')), // Mo → 5
      ...Array.from({ length: 4 }, () => r('2026-02-03', 2, 'confirmed')), // Di → 4
    ];
    const p = bernHolidayPeriod(2026, 'sport');
    const s = buildHolidayPeriodSummary(rows, p, 'booked', 'reservations', '2026-07-01');
    expect(5 / 4).toBeLessThanOrEqual(HOLIDAY_EVEN_RATIO);
    expect(s.interpretation).toBe(
      'In den Sportferien verteilen sich die Reservationen gleichmässiger auf die Woche.',
    );
  });
  it('erkennt Konzentration auf einen einzigen Wochentag', () => {
    const rows: ReservationAggRow[] = [r('2026-02-02', 4, 'confirmed')]; // nur Montag
    const p = bernHolidayPeriod(2026, 'sport');
    const s = buildHolidayPeriodSummary(rows, p, 'booked', 'reservations', '2026-07-01');
    expect(s.interpretation).toBe(
      'Während der Sportferien konzentrieren sich die Reservationen auf Montag.',
    );
  });
});

describe('buildHolidayInterpretation / Labels', () => {
  it('Labels sind vollständig', () => {
    expect(BERN_HOLIDAY_LABEL.sport).toBe('Sportferien');
    expect(BERN_HOLIDAY_SELECTION_LABEL.all).toBe('Alle Schulferien');
    expect(BERN_HOLIDAY_SELECTION_LABEL.winter).toBe('Winterferien');
  });
  it('liefert den Leer-Hinweis ohne aktive Wochentage', () => {
    const p = bernHolidayPeriod(2026, 'spring');
    const empty = buildHolidayInterpretation(p, {
      headlines: [],
      strongest: null,
      weakest: null,
    } as never);
    expect(empty).toBe('Während der Frühlingsferien liegen keine Reservationen vor.');
  });
});

// ── Wochentagsvergleich (generisch: Zeiträume × Wochentage, Zeilen-Heatmap) ────
// 2026: Jan 1 = Do. ISO-Wochen: Mo 2026-01-05…So 01-11 (A), Mo 01-12…So 01-18 (B).
// Jede Zelle: genau 1 Vorkommen je Wochentag → Zellwert (Reservationen) = Anzahl.
const WD_CMP_ROWS: ReservationAggRow[] = [
  // Woche A (Summe 70 → Zeilen-Ø 10): Wed 9 (0.9), Thu 11 (1.1), Sat 15 (1.5), Sun 5 (0.5).
  ...repeat('2026-01-05', 10, 2), // Mo
  ...repeat('2026-01-06', 10, 2), // Di
  ...repeat('2026-01-07', 9, 2),  // Mi
  ...repeat('2026-01-08', 11, 2), // Do
  ...repeat('2026-01-09', 10, 2), // Fr
  ...repeat('2026-01-10', 15, 2), // Sa
  ...repeat('2026-01-11', 5, 2),  // So
  // Woche B (alle gleich 20 → Zeilen-Ø 20, alle 'average'), party 3.
  ...repeat('2026-01-12', 20, 3), // Mo
  ...repeat('2026-01-13', 20, 3), // Di
  ...repeat('2026-01-14', 20, 3), // Mi
  ...repeat('2026-01-15', 20, 3), // Do
  ...repeat('2026-01-16', 20, 3), // Fr
  ...repeat('2026-01-17', 20, 3), // Sa
  ...repeat('2026-01-18', 20, 3), // So
];
const WD_PERIODS = [
  { key: 'A', label: 'Woche A', from: '2026-01-05', to: '2026-01-11' },
  { key: 'B', label: 'Woche B', from: '2026-01-12', to: '2026-01-18' },
];
// Leere Woche (alle 7 Wochentage kommen vor, aber 0 Reservationen). Konvention
// (wie comparisonCellValue): vorkommender Wochentag mit 0 Reservationen → Wert 0
// (nicht null); '–'/null nur, wenn der Wochentag gar nicht im Bereich liegt.
const WD_EMPTY_PERIOD = [{ key: 'C', label: 'Woche C', from: '2026-01-19', to: '2026-01-25' }];

describe('classifyWeekdayHeat', () => {
  it('liefert none bei fehlendem Wert oder fehlendem/0 Zeilen-Ø', () => {
    expect(classifyWeekdayHeat(null, 10)).toBe('none');
    expect(classifyWeekdayHeat(5, null)).toBe('none');
    expect(classifyWeekdayHeat(5, 0)).toBe('none');
    expect(classifyWeekdayHeat(5, -1)).toBe('none');
  });
  it('stuft an den Schwellen inklusiv ein', () => {
    expect(classifyWeekdayHeat(120, 100)).toBe('veryStrong');   // 1.20
    expect(classifyWeekdayHeat(105, 100)).toBe('aboveAverage'); // 1.05
    expect(classifyWeekdayHeat(95, 100)).toBe('belowAverage');  // 0.95
    expect(classifyWeekdayHeat(80, 100)).toBe('veryWeak');      // 0.80
  });
  it('neutral zwischen den Schwellen und bei Gleichheit/Einzelwert', () => {
    expect(classifyWeekdayHeat(100, 100)).toBe('average');
    expect(classifyWeekdayHeat(101, 100)).toBe('average');
    expect(classifyWeekdayHeat(99, 100)).toBe('average');
    expect(classifyWeekdayHeat(7, 7)).toBe('average'); // Einzelwert → r=1
  });
  it('exportiert symmetrische Verhältnis-Konstanten', () => {
    expect(HEAT_VERY_STRONG_RATIO).toBe(1.2);
    expect(HEAT_ABOVE_RATIO).toBe(1.05);
    expect(HEAT_BELOW_RATIO).toBe(0.95);
    expect(HEAT_VERY_WEAK_RATIO).toBe(0.8);
  });
});

describe('buildWeekdayComparison', () => {
  it('baut eine Zeile je Zeitraum in Reihenfolge, Metrik durchgereicht', () => {
    const c = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations');
    expect(c.metric).toBe('reservations');
    expect(c.rows.map((r2) => r2.period.key)).toEqual(['A', 'B']);
    for (const row of c.rows) expect(Object.keys(row.cells)).toHaveLength(7);
  });
  it('Zeilen-Ø ist gleichgewichtetes Mittel der vorhandenen Zellwerte', () => {
    const c = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations');
    expect(c.rows[0].rowAverage).toBeCloseTo(10, 6);
    expect(c.rows[1].rowAverage).toBeCloseTo(20, 6);
  });
  it('Heatmap ist ZEILEN-relativ und deckt alle 5 Stufen ab', () => {
    const a = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations').rows[0];
    expect(a.cells[1].heat).toBe('average');      // Mo 10/10
    expect(a.cells[3].heat).toBe('belowAverage'); // Mi 9/10 = 0.9
    expect(a.cells[4].heat).toBe('aboveAverage'); // Do 11/10 = 1.1
    expect(a.cells[6].heat).toBe('veryStrong');   // Sa 15/10 = 1.5
    expect(a.cells[7].heat).toBe('veryWeak');     // So 5/10 = 0.5
    expect(a.cells[6].value).toBe(15);
    expect(a.cells[7].value).toBe(5);
  });
  it('alle-gleich-Zeile → jede Zelle average', () => {
    const b = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations').rows[1];
    for (const wd of [1, 2, 3, 4, 5, 6, 7] as const) expect(b.cells[wd].heat).toBe('average');
  });
  it('leere Woche → Zellen Wert 0 (Wochentag kommt vor), heat none, Summen 0, avgPersons null', () => {
    const empty = buildWeekdayComparison(WD_CMP_ROWS, WD_EMPTY_PERIOD, 'booked', 'reservations').rows[0];
    for (const wd of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(empty.cells[wd].value).toBe(0);
      expect(empty.cells[wd].heat).toBe('none');
    }
    expect(empty.rowAverage).toBe(0);
    expect(empty.totalReservations).toBe(0);
    expect(empty.totalPersons).toBe(0);
    expect(empty.avgPersons).toBeNull();
  });
  it('nicht vorkommender Wochentag → Wert null und heat none', () => {
    // Bereich Mo–Mi (2026-01-05..07): Do–So kommen NICHT vor → null/'–'.
    const partial = buildWeekdayComparison(
      WD_CMP_ROWS,
      [{ key: 'P', label: 'Mo–Mi', from: '2026-01-05', to: '2026-01-07' }],
      'booked',
      'reservations',
    ).rows[0];
    expect(partial.cells[1].value).toBe(10); // Mo vorhanden
    for (const wd of [4, 5, 6, 7] as const) {
      expect(partial.cells[wd].value).toBeNull();
      expect(partial.cells[wd].heat).toBe('none');
    }
  });
  it('Zeilen-Summen: Reservationen/Personen total + Ø Personen pro Reservation', () => {
    const c = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations');
    expect(c.rows[0].totalReservations).toBe(70);
    expect(c.rows[0].totalPersons).toBe(140); // 70 × 2
    expect(c.rows[0].avgPersons).toBeCloseTo(2, 6);
    expect(c.rows[1].totalReservations).toBe(140);
    expect(c.rows[1].totalPersons).toBe(420); // 140 × 3
    expect(c.rows[1].avgPersons).toBeCloseTo(3, 6);
  });
  it('weekdayAverages mittelt je Wochentag über Zeilen', () => {
    const c = buildWeekdayComparison(WD_CMP_ROWS, WD_PERIODS, 'booked', 'reservations');
    expect(c.weekdayAverages[1]).toBeCloseTo(15, 6); // Mo (10 + 20) / 2
    expect(c.weekdayAverages[6]).toBeCloseTo(17.5, 6); // Sa (15 + 20) / 2
  });
  it('leere Perioden-Liste → keine Zeilen, weekdayAverages null', () => {
    const c = buildWeekdayComparison(WD_CMP_ROWS, [], 'booked', 'reservations');
    expect(c.rows).toHaveLength(0);
    for (const wd of [1, 2, 3, 4, 5, 6, 7] as const) expect(c.weekdayAverages[wd]).toBeNull();
  });
  it('Mehr-Perioden-Bereich mit leerer Mittel-Periode → Null-Zeile bleibt in Reihenfolge', () => {
    // Analog Monats-Modus: alle Perioden im Bereich werden gerendert, auch die
    // leere Mitte (Woche C, 0 Reservationen). Reihenfolge A → C(leer) → B bleibt.
    const periods = [
      { key: 'A', label: 'Woche A', from: '2026-01-05', to: '2026-01-11' },
      { key: 'C', label: 'Woche C', from: '2026-01-19', to: '2026-01-25' },
      { key: 'B', label: 'Woche B', from: '2026-01-12', to: '2026-01-18' },
    ];
    const c = buildWeekdayComparison(WD_CMP_ROWS, periods, 'booked', 'reservations');
    expect(c.rows.map((r2) => r2.period.key)).toEqual(['A', 'C', 'B']);
    const mid = c.rows[1];
    expect(mid.period.key).toBe('C');
    expect(mid.totalReservations).toBe(0);
    expect(mid.totalPersons).toBe(0);
    expect(mid.avgPersons).toBeNull();
    for (const wd of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(mid.cells[wd].value).toBe(0);
      expect(mid.cells[wd].heat).toBe('none');
    }
    // Nachbarzeilen behalten ihre echten Werte (leere Mitte beeinflusst sie nicht).
    expect(c.rows[0].totalReservations).toBe(70);
    expect(c.rows[2].totalReservations).toBe(140);
  });
});

describe('buildRangeWeekdayDetail', () => {
  const RANGE_ROWS: ReservationAggRow[] = [
    ...repeat('2025-12-29', 3, 2), // Mo (Dez 2025)
    ...repeat('2026-01-05', 7, 2), // Mo (Jan 2026)
    ...repeat('2026-01-06', 4, 2), // Di — darf NICHT zählen (Wochentag ≠ Mo)
  ];
  it('summiert einen Wochentag über einen mehrere Monate umspannenden Bereich', () => {
    const d = buildRangeWeekdayDetail(RANGE_ROWS, '2025-12-29', '2026-01-11', 1, 'booked', {
      monthKey: 'winter-2025',
      label: 'Weihnachtsferien 2025/26',
    });
    expect(d.occurrences).toBe(2); // zwei Montage im Bereich
    expect(d.reservations).toBe(10); // 3 + 7
    expect(d.persons).toBe(20); // 10 × 2
    expect(d.avgPersonsPerReservation).toBeCloseTo(2, 6);
    expect(d.days.map((x) => x.date)).toEqual(['2025-12-29', '2026-01-05']);
    expect(d.label).toBe('Weihnachtsferien 2025/26');
    expect(d.monthKey).toBe('winter-2025');
  });
  it('monthKey fällt auf den Monat von `from` zurück, label bleibt undefined', () => {
    const d = buildRangeWeekdayDetail(RANGE_ROWS, '2026-01-05', '2026-01-11', 1, 'booked');
    expect(d.monthKey).toBe('2026-01');
    expect(d.label).toBeUndefined();
    expect(d.reservations).toBe(7);
  });
  it('ungültiger Bereich (from > to) → leeres Ergebnis', () => {
    const d = buildRangeWeekdayDetail(RANGE_ROWS, '2026-01-11', '2026-01-05', 1, 'booked');
    expect(d.occurrences).toBe(0);
    expect(d.reservations).toBe(0);
    expect(d.days).toEqual([]);
  });
  it('buildMonthWeekdayDetail delegiert und klemmt auf Monat∩Zeitraum', () => {
    // Bereich deckt Dez+Jan, aber monthKey Jan → nur Jan-Montage zählen.
    const d = buildMonthWeekdayDetail(RANGE_ROWS, '2025-12-01', '2026-01-31', '2026-01', 1, 'booked');
    expect(d.reservations).toBe(7); // nur 2026-01-05
    expect(d.occurrences).toBe(4); // 4 Montage im Januar 2026
    expect(d.monthKey).toBe('2026-01');
  });
});

// ── Saisonvergleich (frei definierte, fixe Datumsbereiche) ─────────────────────
// Je Saison eine vollständige ISO-Woche mit festen Werten je Wochentag, damit
// jede Zelle genau EIN Kalendervorkommen hat und die Werte exakt sind.
const SEASON_DEFS: SeasonDefinition[] = [
  { id: 'fr', name: 'Frühling', from: '2026-01-05', to: '2026-01-11', color: '#22c55e', active: true },
  { id: 'so', name: 'Sommer', from: '2026-01-12', to: '2026-01-18', color: '#ef4444', active: true },
];
const SEASON_ROWS: ReservationAggRow[] = [
  // Frühling: Mo10 Di10 Mi10 Do10 Fr10 Sa20 So5
  ...repeat('2026-01-05', 10, 2),
  ...repeat('2026-01-06', 10, 2),
  ...repeat('2026-01-07', 10, 2),
  ...repeat('2026-01-08', 10, 2),
  ...repeat('2026-01-09', 10, 2),
  ...repeat('2026-01-10', 20, 2),
  ...repeat('2026-01-11', 5, 2),
  // Sommer: Mo8 Di8 Mi8 Do8 Fr8 Sa25 So6
  ...repeat('2026-01-12', 8, 3),
  ...repeat('2026-01-13', 8, 3),
  ...repeat('2026-01-14', 8, 3),
  ...repeat('2026-01-15', 8, 3),
  ...repeat('2026-01-16', 8, 3),
  ...repeat('2026-01-17', 25, 3),
  ...repeat('2026-01-18', 6, 3),
];
const seasonComparison = () =>
  buildWeekdayComparison(
    SEASON_ROWS,
    seasonsToComparisonPeriods(SEASON_DEFS),
    'booked',
    'reservations',
  );

describe('seasonsToComparisonPeriods', () => {
  it('wandelt Saisons in ComparisonPeriods (key = Saison-ID), sortiert nach from', () => {
    const p = seasonsToComparisonPeriods(SEASON_DEFS);
    expect(p.map((x) => x.key)).toEqual(['fr', 'so']);
    expect(p.map((x) => x.label)).toEqual(['Frühling', 'Sommer']);
    expect(p[0]).toMatchObject({ from: '2026-01-05', to: '2026-01-11' });
  });
  it('verwirft ungültige Bereiche (kein Datum / from > to)', () => {
    const p = seasonsToComparisonPeriods([
      { id: 'bad1', name: 'Ungültig', from: '2026-13-01', to: '2026-01-05', active: true },
      { id: 'bad2', name: 'Verdreht', from: '2026-03-31', to: '2026-03-01', active: true },
      SEASON_DEFS[0],
    ]);
    expect(p.map((x) => x.key)).toEqual(['fr']);
  });
  it('sortiert bei gleichem from stabil nach Name', () => {
    const p = seasonsToComparisonPeriods([
      { id: 'b', name: 'Beta', from: '2026-05-01', to: '2026-05-31', active: true },
      { id: 'a', name: 'Alpha', from: '2026-05-01', to: '2026-05-31', active: true },
    ]);
    expect(p.map((x) => x.label)).toEqual(['Alpha', 'Beta']);
  });
});

describe('buildSeasonWeekdayRanking', () => {
  it('erzeugt je Wochentag (Mo→So) eine absteigende Rangliste', () => {
    const rank = buildSeasonWeekdayRanking(seasonComparison());
    expect(rank).toHaveLength(7);
    expect(rank.map((r2) => r2.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('Samstag: Sommer (25) vor Frühling (20)', () => {
    const sat = buildSeasonWeekdayRanking(seasonComparison()).find((r2) => r2.weekday === 6)!;
    expect(sat.entries.map((e) => e.seasonKey)).toEqual(['so', 'fr']);
    expect(sat.entries.map((e) => e.value)).toEqual([25, 20]);
  });
  it('Montag: Frühling (10) vor Sommer (8)', () => {
    const mon = buildSeasonWeekdayRanking(seasonComparison()).find((r2) => r2.weekday === 1)!;
    expect(mon.entries.map((e) => e.seasonKey)).toEqual(['fr', 'so']);
    expect(mon.entries.map((e) => e.value)).toEqual([10, 8]);
  });
});

describe('buildSeasonChartSeries', () => {
  it('liefert 7 Punkte (Mo→So, Kurzlabels) und je Saison eine Serie', () => {
    const chart = buildSeasonChartSeries(seasonComparison());
    expect(chart.points).toHaveLength(7);
    expect(chart.points.map((p) => p.label)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    expect(chart.points.map((p) => p.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(chart.series.map((s) => s.key)).toEqual(['fr', 'so']);
  });
  it('Punktwerte sind je Saison-ID indexiert', () => {
    const sat = buildSeasonChartSeries(seasonComparison()).points.find((p) => p.weekday === 6)!;
    expect(sat.values.fr).toBe(20);
    expect(sat.values.so).toBe(25);
  });
});

describe('buildSeasonRecommendations', () => {
  it('nennt stärksten und schwächsten Wochentag mit zugehöriger Saison', () => {
    const recs = buildSeasonRecommendations(seasonComparison());
    expect(recs.some((t) => t.includes('Sommer') && t.includes('stärksten') && t.includes('Samstag'))).toBe(true);
    expect(recs.some((t) => t.includes('Frühling') && t.includes('schwächsten') && t.includes('Sonntag'))).toBe(true);
  });
  it('nennt konstantesten Wochentag und grösste Abweichung', () => {
    const recs = buildSeasonRecommendations(seasonComparison());
    expect(recs.some((t) => t.includes('Sonntag') && t.includes('konstantesten'))).toBe(true);
    expect(recs.some((t) => t.includes('Montag') && t.includes('grösste Abweichung'))).toBe(true);
  });
  it('gibt [] bei weniger als 2 Saisons zurück', () => {
    const one = buildWeekdayComparison(
      SEASON_ROWS,
      seasonsToComparisonPeriods([SEASON_DEFS[0]]),
      'booked',
      'reservations',
    );
    expect(buildSeasonRecommendations(one)).toEqual([]);
  });
});

describe('Saison-Heatmap & leere Saison', () => {
  it('Vergleichszeilen tragen zeilenrelative Heatmap-Stufen', () => {
    const cmp = seasonComparison();
    expect(cmp.rows[0].period.key).toBe('fr');
    expect(cmp.rows[0].cells[6].heat).toBe('veryStrong'); // Sa 20 ≫ Zeilen-Ø
    expect(cmp.rows[0].cells[7].heat).toBe('veryWeak');    // So 5 ≪ Zeilen-Ø
  });
  it('leere Saison: vorkommende Wochentage = 0 (nicht null), landen zuletzt im Ranking', () => {
    const cmp = buildWeekdayComparison(
      SEASON_ROWS,
      seasonsToComparisonPeriods([
        SEASON_DEFS[0],
        { id: 'leer', name: 'Leer', from: '2026-02-02', to: '2026-02-08', active: true },
      ]),
      'booked',
      'reservations',
    );
    const mon = buildSeasonWeekdayRanking(cmp).find((r2) => r2.weekday === 1)!;
    expect(mon.entries.map((e) => e.seasonKey)).toEqual(['fr', 'leer']);
    expect(mon.entries.map((e) => e.value)).toEqual([10, 0]);
  });
});

describe('validateSeasonDefinition & isValidIsoDate', () => {
  it('akzeptiert eine gültige Definition', () => {
    expect(validateSeasonDefinition({ name: 'Herbst', from: '2026-09-01', to: '2026-11-30' }).valid).toBe(true);
  });
  it('meldet fehlenden Namen und ungültige Daten', () => {
    const res = validateSeasonDefinition({ name: '   ', from: '2026-13-01', to: 'foo' });
    expect(res.valid).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
  it('meldet Enddatum vor Startdatum', () => {
    const res = validateSeasonDefinition({ name: 'A', from: '2026-02-01', to: '2026-01-01' });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('Das Enddatum darf nicht vor dem Startdatum liegen.');
  });
  it('isValidIsoDate erkennt echte Kalenderdaten und weist Unsinn ab', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-31')).toBe(false);
    expect(isValidIsoDate('2026-2-3')).toBe(false);
    expect(isValidIsoDate('foo')).toBe(false);
  });
});

describe('findOverlappingSeasons', () => {
  it('findet überlappende Paare inkl. Randberührung und ignoriert getrennte', () => {
    const a: SeasonDefinition = { id: 'a', name: 'A', from: '2026-01-01', to: '2026-01-10', active: true };
    const b: SeasonDefinition = { id: 'b', name: 'B', from: '2026-01-10', to: '2026-01-20', active: true };
    const c: SeasonDefinition = { id: 'c', name: 'C', from: '2026-02-01', to: '2026-02-05', active: true };
    expect(findOverlappingSeasons([a, b, c])).toEqual([{ a: 'a', b: 'b' }]);
  });
  it('keine Überlappung bei getrennten Bereichen', () => {
    expect(
      findOverlappingSeasons([
        { id: 'x', name: 'X', from: '2026-01-01', to: '2026-01-05', active: true },
        { id: 'y', name: 'Y', from: '2026-03-01', to: '2026-03-05', active: true },
      ]),
    ).toEqual([]);
  });
});

describe('exampleSeasonDefinitions', () => {
  it('liefert die fünf Beispiel-Saisons der Spezifikation, alle aktiv und gültig', () => {
    const defs = exampleSeasonDefinitions();
    expect(defs).toHaveLength(5);
    for (const d of defs) {
      expect(d.active).toBe(true);
      expect(validateSeasonDefinition(d).valid).toBe(true);
    }
    expect(defs.map((d) => d.name)).toEqual([
      'Wintersaison 2026',
      'Frühlingssaison 2026',
      'Terrassensaison 2026',
      'Sommerferien 2026',
      'Weihnachtsgeschäft 2026',
    ]);
  });
  it('hat stabile, eindeutige Slug-IDs (erneutes Einfügen = gleiche IDs)', () => {
    const a = exampleSeasonDefinitions();
    const b = exampleSeasonDefinitions();
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
    expect(new Set(a.map((d) => d.id)).size).toBe(5);
    expect(a.map((d) => d.id)).toContain('winter-2026');
  });
  it('bekannte Überlappungen (z. B. Terrassensaison × Sommerferien) werden erkannt', () => {
    const overlaps = findOverlappingSeasons(exampleSeasonDefinitions());
    const pairs = overlaps.map((o) => [o.a, o.b].sort().join('+'));
    expect(pairs).toContain('sommerferien-2026+terrassen-2026');
    expect(pairs).toContain('weihnachten-2026+winter-2026');
  });
});

describe('buildRangeWeekdayDetail rangeLabel', () => {
  it('reicht das rangeLabel unverändert in das Detail durch', () => {
    const d = buildRangeWeekdayDetail([], '2026-10-01', '2026-12-31', 1, 'booked', {
      monthKey: 'winter-2026',
      label: 'Wintersaison 2026',
      rangeLabel: '01.10.2026 – 31.12.2026',
    });
    expect(d.rangeLabel).toBe('01.10.2026 – 31.12.2026');
    expect(d.label).toBe('Wintersaison 2026');
  });
  it('rangeLabel bleibt auch im Leer-/Fehlerfall erhalten', () => {
    const d = buildRangeWeekdayDetail([], '2026-12-31', '2026-01-01', 1, 'booked', {
      rangeLabel: 'X – Y',
    });
    expect(d.occurrences).toBe(0);
    expect(d.rangeLabel).toBe('X – Y');
  });
  it('ohne Option bleibt rangeLabel undefined', () => {
    const d = buildRangeWeekdayDetail([], '2026-01-01', '2026-01-31', 1, 'booked');
    expect(d.rangeLabel).toBeUndefined();
  });
});
