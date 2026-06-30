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
  buildMonthComparison,
  buildMonthComparisonInsights,
  comparisonCellValue,
  comparisonCellSubLabel,
  headlineUnit,
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
