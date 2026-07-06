// @vitest-environment node
/**
 * Tests für reservation-analyse-utils — konsolidierte „Reservations Analyse".
 * Rein synthetische Daten (kein Supabase, kein DOM).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ANALYSE_METRIC,
  ANALYSE_METRICS,
  ANALYSE_METRIC_LABEL,
  ANALYSE_PRESETS,
  pickMetric,
  avgPersonsPerReservation,
  presetMonthRange,
  matchesPreset,
  buildWeekdayMonthBreakdown,
  buildMonthWeekdayHeatmap,
  cellMetricValue,
  heatmapValueScale,
  classifyHeatmapLevel,
  cellShareOfMonth,
  cellShareOfRange,
  monthWeekdayAverage,
  cellVsMonthAverage,
  buildHeatmapCellTooltip,
  buildWeekdayDayBreakdown,
  type AnalyseMetric,
} from '../reservation-analyse-utils';
import {
  buildYoyComparison,
  buildYoyWeekdayComparison,
  monthKeysInRange,
} from '../reservation-yoy-utils';
import type { ReservationAggRow } from '../reservation-dashboard';

const row = (
  date: string,
  partySize: number | null = 2,
  status = 'confirmed',
): ReservationAggRow => ({ date, partySize, status });

// ── Standard-Kennzahl + Umschalter ───────────────────────────────────────────

describe('AnalyseMetric (globaler Umschalter)', () => {
  it('Standard-Auswertung ist Personen', () => {
    expect(DEFAULT_ANALYSE_METRIC).toBe('persons');
    expect(ANALYSE_METRICS[0]).toBe('persons');
    expect(ANALYSE_METRIC_LABEL.persons).toBe('Personen');
    expect(ANALYSE_METRIC_LABEL.reservations).toBe('Reservationen');
  });

  it('pickMetric wirkt auf den Monatsvergleich (Personen vs. Reservationen)', () => {
    // Okt 2026: 2 Reservationen à 4 Personen; Okt 2025: 1 Reservation à 3.
    const comparison = buildYoyComparison({
      currentRows: [row('2026-10-05', 4), row('2026-10-12', 4)],
      priorRows: [row('2025-10-06', 3)],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const m = comparison.months[0];
    const persons = pickMetric(m, 'persons');
    const reservations = pickMetric(m, 'reservations');
    expect(persons.current).toBe(8);
    expect(persons.prior).toBe(3);
    expect(reservations.current).toBe(2);
    expect(reservations.prior).toBe(1);
    // Umschalten liefert wirklich andere Werte (Kennzahl-Steuerung greift).
    expect(persons.current).not.toBe(reservations.current);
  });

  it('pickMetric wirkt auf die Wochentagsanalyse', () => {
    // Mo 2026-10-05 (2 Res. à 5 Pers.), VJ Mo 2025-10-06 (1 Res. à 2 Pers.).
    const wd = buildYoyWeekdayComparison({
      currentRows: [row('2026-10-05', 5), row('2026-10-05', 5)],
      priorRows: [row('2025-10-06', 2)],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const monday = wd.rows.find((r) => r.weekday === 1)!;
    expect(pickMetric(monday, 'persons').current).toBe(10);
    expect(pickMetric(monday, 'reservations').current).toBe(2);
    expect(pickMetric(monday, 'persons').prior).toBe(2);
    expect(pickMetric(monday, 'reservations').prior).toBe(1);
  });

  it('Vorjahr 0 (Daten vorhanden, Kennzahl 0) → diffPct null, kein Div/0', () => {
    // Vorjahresmonat hat Zeilen, aber alle storniert → nach booked-Filter 0.
    const comparison = buildYoyComparison({
      currentRows: [row('2026-03-02', 4)],
      priorRows: [row('2025-03-03', 4, 'cancelled')],
      monthKeys: ['2026-03'],
      scope: 'booked',
    });
    const m = comparison.months[0];
    expect(m.hasPriorData).toBe(true);
    for (const metric of ANALYSE_METRICS) {
      const v = pickMetric(m, metric);
      expect(v.prior).toBe(0);
      expect(v.diffPct).toBeNull();
      expect(v.diff).toBeGreaterThan(0);
    }
  });

  it('leere Monate erscheinen mit 0 (nicht ausgelassen)', () => {
    const monthKeys = monthKeysInRange('2026-01', '2026-03');
    const comparison = buildYoyComparison({
      currentRows: [row('2026-02-10', 6)],
      priorRows: [],
      monthKeys,
      scope: 'booked',
    });
    expect(comparison.months).toHaveLength(3);
    expect(pickMetric(comparison.months[0], 'persons').current).toBe(0);
    expect(pickMetric(comparison.months[1], 'persons').current).toBe(6);
    expect(pickMetric(comparison.months[2], 'persons').current).toBe(0);
    // Kein Vorjahr → prior null + neutral (kein falsches Wachstum).
    expect(comparison.months[1].hasPriorData).toBe(false);
    expect(pickMetric(comparison.months[1], 'persons').prior).toBeNull();
    expect(pickMetric(comparison.months[1], 'persons').trend).toBe('neutral');
  });
});

// ── Ø Personen pro Reservation ───────────────────────────────────────────────

describe('avgPersonsPerReservation', () => {
  it('berechnet den Durchschnitt', () => {
    expect(avgPersonsPerReservation(10, 4)).toBe(2.5);
  });
  it('null bei 0 Reservationen oder ungültigen Werten', () => {
    expect(avgPersonsPerReservation(10, 0)).toBeNull();
    expect(avgPersonsPerReservation(10, -1)).toBeNull();
    expect(avgPersonsPerReservation(NaN, 5)).toBeNull();
    expect(avgPersonsPerReservation(10, NaN)).toBeNull();
  });
});

// ── Zeitraum-Presets ─────────────────────────────────────────────────────────

describe('presetMonthRange', () => {
  const july = new Date(2026, 6, 15); // 15. Juli 2026

  it('Aktueller Monat', () => {
    expect(presetMonthRange('currentMonth', july))
      .toEqual({ year: 2026, fromMonth: 7, toMonth: 7 });
  });

  it('Letzter Monat (Normalfall)', () => {
    expect(presetMonthRange('lastMonth', july))
      .toEqual({ year: 2026, fromMonth: 6, toMonth: 6 });
  });

  it('Letzter Monat rollt über den Jahreswechsel (Januar → Dezember Vorjahr)', () => {
    const january = new Date(2026, 0, 10);
    expect(presetMonthRange('lastMonth', january))
      .toEqual({ year: 2025, fromMonth: 12, toMonth: 12 });
  });

  it('Aktuelles Jahr / Letztes Jahr', () => {
    expect(presetMonthRange('currentYear', july))
      .toEqual({ year: 2026, fromMonth: 1, toMonth: 12 });
    expect(presetMonthRange('lastYear', july))
      .toEqual({ year: 2025, fromMonth: 1, toMonth: 12 });
  });

  it('Wintersaison Okt–Dez', () => {
    expect(presetMonthRange('winter', july))
      .toEqual({ year: 2026, fromMonth: 10, toMonth: 12 });
    // Saison-Monatskeys stimmen mit monthKeysInRange überein.
    const r = presetMonthRange('winter', july);
    expect(monthKeysInRange(`${r.year}-10`, `${r.year}-12`))
      .toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('alle Presets sind als Schnellbuttons definiert', () => {
    expect(ANALYSE_PRESETS.map((p) => p.key)).toEqual([
      'currentMonth', 'lastMonth', 'currentYear', 'lastYear', 'winter',
    ]);
  });

  it('matchesPreset erkennt exakte Übereinstimmung', () => {
    expect(matchesPreset({ year: 2026, fromMonth: 7, toMonth: 7 }, 'currentMonth', july)).toBe(true);
    expect(matchesPreset({ year: 2026, fromMonth: 6, toMonth: 7 }, 'currentMonth', july)).toBe(false);
    expect(matchesPreset({ year: 2026, fromMonth: 10, toMonth: 12 }, 'winter', july)).toBe(true);
    expect(matchesPreset({ year: 2025, fromMonth: 10, toMonth: 12 }, 'winter', july)).toBe(false);
  });
});

// ── Wochentag-Zusammensetzung (Popup) ────────────────────────────────────────

describe('buildWeekdayMonthBreakdown', () => {
  it('summiert je Ist-Monat NUR den gewählten Wochentag', () => {
    const rows = buildWeekdayMonthBreakdown({
      currentRows: [
        row('2026-10-05', 4),  // Montag Okt
        row('2026-10-06', 9),  // Dienstag Okt (ignoriert)
        row('2026-11-02', 2),  // Montag Nov
        row('2026-11-09', 3),  // Montag Nov
      ],
      priorRows: [
        row('2025-10-06', 5),  // Montag Okt VJ
        row('2025-11-04', 7),  // Dienstag Nov VJ (zählt nur für hasPriorData)
      ],
      monthKeys: ['2026-10', '2026-11', '2026-12'],
      weekday: 1,
      scope: 'booked',
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ monthKey: '2026-10', priorMonthKey: '2025-10' });
    expect(rows[0].persons.current).toBe(4);
    expect(rows[0].persons.prior).toBe(5);
    expect(rows[0].reservations.current).toBe(1);
    expect(rows[1].persons.current).toBe(5);
    expect(rows[1].reservations.current).toBe(2);
    // Nov VJ hat Zeilen (Dienstag) → Vorjahr BEKANNT, Montag-Wert echtes 0.
    expect(rows[1].hasPriorData).toBe(true);
    expect(rows[1].persons.prior).toBe(0);
    expect(rows[1].persons.diffPct).toBeNull();
    // Dez ohne jegliche Daten → 0 Ist + unbekanntes Vorjahr.
    expect(rows[2].persons.current).toBe(0);
    expect(rows[2].hasPriorData).toBe(false);
    expect(rows[2].persons.prior).toBeNull();
  });

  it('Status-Scope filtert (Storno zählt bei booked nicht, bei all schon)', () => {
    const args = {
      currentRows: [row('2026-10-05', 4), row('2026-10-12', 6, 'cancelled')],
      priorRows: [],
      monthKeys: ['2026-10'],
      weekday: 1 as const,
    };
    const booked = buildWeekdayMonthBreakdown({ ...args, scope: 'booked' });
    const all = buildWeekdayMonthBreakdown({ ...args, scope: 'all' });
    expect(booked[0].reservations.current).toBe(1);
    expect(all[0].reservations.current).toBe(2);
    expect(all[0].persons.current).toBe(10);
  });

  it('Umschalter wirkt auch hier (Personen vs. Reservationen)', () => {
    const rows = buildWeekdayMonthBreakdown({
      currentRows: [row('2026-10-05', 8), row('2026-10-12', 8)],
      priorRows: [row('2025-10-06', 1)],
      monthKeys: ['2026-10'],
      weekday: 1,
      scope: 'booked',
    });
    const byMetric = (m: AnalyseMetric) => pickMetric(rows[0], m);
    expect(byMetric('persons').current).toBe(16);
    expect(byMetric('reservations').current).toBe(2);
  });

  it('leere Eingaben → Zeilen mit 0/unbekanntem Vorjahr, kein Crash', () => {
    const rows = buildWeekdayMonthBreakdown({
      currentRows: [],
      priorRows: [],
      monthKeys: ['2026-01', '2026-02'],
      weekday: 5,
      scope: 'booked',
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.persons.current).toBe(0);
      expect(r.hasPriorData).toBe(false);
      expect(r.persons.prior).toBeNull();
      expect(r.persons.trend).toBe('neutral');
    }
  });

  it('ungültige Daten (kaputtes Datum, null partySize) werden robust behandelt', () => {
    const rows = buildWeekdayMonthBreakdown({
      currentRows: [
        row('2026-10-05', null),          // Montag, partySize null → 0 Personen
        { date: null, partySize: 4, status: 'confirmed' },
        { date: 'quatsch', partySize: 4, status: 'confirmed' },
      ],
      priorRows: [],
      monthKeys: ['2026-10'],
      weekday: 1,
      scope: 'booked',
    });
    expect(rows[0].reservations.current).toBe(1);
    expect(rows[0].persons.current).toBe(0);
  });
});

// ── Heatmap Monat × Wochentag ────────────────────────────────────────────────

describe('cellMetricValue (Kennzahl-Umschalter für Zellen)', () => {
  it('liefert Personen bzw. Reservationen je nach Metric', () => {
    const counts = { reservations: 3, persons: 12 };
    expect(cellMetricValue(counts, 'persons')).toBe(12);
    expect(cellMetricValue(counts, 'reservations')).toBe(3);
  });
});

describe('buildMonthWeekdayHeatmap', () => {
  it('erzeugt genau eine Zeile pro Ist-Monat mit je 7 Wochentag-Zellen (Mo..So)', () => {
    const hm = buildMonthWeekdayHeatmap({
      rows: [row('2026-10-05', 4)],
      monthKeys: ['2026-09', '2026-10'],
      scope: 'booked',
    });
    expect(hm.months.map((m) => m.monthKey)).toEqual(['2026-09', '2026-10']);
    for (const m of hm.months) {
      expect(m.cells).toHaveLength(7);
      expect(m.cells.map((c) => c.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('aggregiert Reservationen/Personen je Wochentag korrekt + Summen', () => {
    const hm = buildMonthWeekdayHeatmap({
      rows: [
        row('2026-10-05', 4),  // Mo
        row('2026-10-12', 6),  // Mo
        row('2026-10-06', 2),  // Di
      ],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const okt = hm.months[0];
    const mon = okt.cells.find((c) => c.weekday === 1)!;
    const die = okt.cells.find((c) => c.weekday === 2)!;
    expect(mon.reservations).toBe(2);
    expect(mon.persons).toBe(10);
    expect(die.reservations).toBe(1);
    expect(die.persons).toBe(2);
    expect(okt.total).toEqual({ reservations: 3, persons: 12 });
    expect(hm.grandTotal).toEqual({ reservations: 3, persons: 12 });
  });

  it('respektiert den Status-Scope (booked schliesst stornierte aus)', () => {
    const hm = buildMonthWeekdayHeatmap({
      rows: [row('2026-10-05', 4), row('2026-10-05', 9, 'cancelled')],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const mon = hm.months[0].cells.find((c) => c.weekday === 1)!;
    expect(mon.reservations).toBe(1);
    expect(mon.persons).toBe(4);
  });

  it('ignoriert Zeilen ausserhalb der Ist-Monate und mit kaputtem Datum', () => {
    const hm = buildMonthWeekdayHeatmap({
      rows: [
        row('2026-10-05', 4),
        row('2026-11-02', 5),  // ausserhalb monthKeys
        { date: 'quatsch', partySize: 3, status: 'confirmed' },
        { date: null, partySize: 3, status: 'confirmed' },
      ],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    expect(hm.grandTotal).toEqual({ reservations: 1, persons: 4 });
  });
});

describe('heatmapValueScale + classifyHeatmapLevel (5 Stufen, relativ)', () => {
  const hm = buildMonthWeekdayHeatmap({
    rows: [
      row('2026-10-05', 10),  // Mo → 10 Pers
      row('2026-10-06', 50),  // Di → 50 Pers
    ],
    monthKeys: ['2026-10'],
    scope: 'booked',
  });

  it('Skala umfasst nur Werte > 0 und erkennt eine Spanne', () => {
    const scale = heatmapValueScale(hm, 'persons');
    expect(scale.min).toBe(10);
    expect(scale.max).toBe(50);
    expect(scale.hasRange).toBe(true);
  });

  it('0-Werte → empty; Min → veryLow; Max → veryHigh', () => {
    const scale = heatmapValueScale(hm, 'persons');
    expect(classifyHeatmapLevel(0, scale)).toBe('empty');
    expect(classifyHeatmapLevel(10, scale)).toBe('veryLow');
    expect(classifyHeatmapLevel(50, scale)).toBe('veryHigh');
  });

  it('teilt die Spanne in 5 gleich breite Bänder', () => {
    // min=0, max=100 → step 20 → Bandgrenzen 0..20,20..40,...
    const scale = { min: 0, max: 100, hasRange: true };
    expect(classifyHeatmapLevel(1, scale)).toBe('veryLow');
    expect(classifyHeatmapLevel(25, scale)).toBe('low');
    expect(classifyHeatmapLevel(45, scale)).toBe('mid');
    expect(classifyHeatmapLevel(65, scale)).toBe('high');
    expect(classifyHeatmapLevel(85, scale)).toBe('veryHigh');
    expect(classifyHeatmapLevel(100, scale)).toBe('veryHigh');
  });

  it('ohne Spanne (alle Werte gleich) → mid; leere Heatmap → keine Spanne', () => {
    const flat = buildMonthWeekdayHeatmap({
      rows: [row('2026-10-05', 5), row('2026-10-12', 5)],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const scale = heatmapValueScale(flat, 'reservations');
    // beide Montage aggregieren zu einer Zelle (2 Res.) → nur eine Zelle > 0
    expect(scale.hasRange).toBe(false);
    expect(classifyHeatmapLevel(2, scale)).toBe('mid');

    const empty = heatmapValueScale(
      buildMonthWeekdayHeatmap({ rows: [], monthKeys: ['2026-10'], scope: 'booked' }),
      'persons',
    );
    expect(empty).toEqual({ min: 0, max: 0, hasRange: false });
  });

  it('Kennzahl-Umschalter verändert die Skala', () => {
    // 1 Res à 10 Pers vs 5 Res à je 2 Pers (=10) → Personen gleich, Res verschieden
    const h = buildMonthWeekdayHeatmap({
      rows: [
        row('2026-10-05', 10),
        row('2026-10-06', 2), row('2026-10-06', 2), row('2026-10-06', 2),
        row('2026-10-06', 2), row('2026-10-06', 2),
      ],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    expect(heatmapValueScale(h, 'persons').hasRange).toBe(false); // beide 10 Pers
    expect(heatmapValueScale(h, 'reservations').hasRange).toBe(true); // 1 vs 5
  });
});

describe('cellShareOfMonth / cellShareOfRange', () => {
  const hm = buildMonthWeekdayHeatmap({
    rows: [
      row('2026-10-05', 3),  // Mo
      row('2026-10-06', 1),  // Di
    ],
    monthKeys: ['2026-10'],
    scope: 'booked',
  });
  const okt = hm.months[0];
  const mon = okt.cells.find((c) => c.weekday === 1)!;

  it('Anteil am Monat (Personen)', () => {
    // Mo 3 von 4 Personen → 75 %
    expect(cellShareOfMonth(mon, okt, 'persons')).toBeCloseTo(75, 5);
  });

  it('Anteil am Zeitraum', () => {
    expect(cellShareOfRange(mon, hm.grandTotal, 'persons')).toBeCloseTo(75, 5);
  });

  it('leerer Monat / leerer Zeitraum → null (kein Div/0)', () => {
    const emptyRow = { monthKey: '2026-11', cells: mon ? [mon] : [], total: { reservations: 0, persons: 0 } };
    expect(cellShareOfMonth(mon, emptyRow, 'persons')).toBeNull();
    expect(cellShareOfRange(mon, { reservations: 0, persons: 0 }, 'persons')).toBeNull();
  });
});

describe('monthWeekdayAverage + cellVsMonthAverage', () => {
  const hm = buildMonthWeekdayHeatmap({
    rows: [
      row('2026-10-05', 10),  // Mo
      row('2026-10-06', 20),  // Di
    ],
    monthKeys: ['2026-10'],
    scope: 'booked',
  });
  const okt = hm.months[0];

  it('Ø nur über Wochentage mit Wert > 0', () => {
    // (10 + 20) / 2 = 15
    expect(monthWeekdayAverage(okt, 'persons')).toBeCloseTo(15, 5);
  });

  it('Vergleich Zelle vs. Monatsdurchschnitt (diff + pct)', () => {
    const mon = okt.cells.find((c) => c.weekday === 1)!;
    const c = cellVsMonthAverage(mon, okt, 'persons');
    expect(c.avg).toBeCloseTo(15, 5);
    expect(c.diff).toBeCloseTo(-5, 5);
    expect(c.pct).toBeCloseTo(-33.333, 2);
  });

  it('leerer Monat → alles null', () => {
    const empty = { monthKey: '2026-11', cells: [], total: { reservations: 0, persons: 0 } };
    expect(monthWeekdayAverage(empty, 'persons')).toBeNull();
    const c = cellVsMonthAverage(
      { weekday: 1, reservations: 0, persons: 0 },
      empty,
      'persons',
    );
    expect(c).toEqual({ avg: null, diff: null, pct: null });
  });
});

describe('buildHeatmapCellTooltip', () => {
  it('bündelt alle Tooltip-Kennzahlen einer Zelle', () => {
    const hm = buildMonthWeekdayHeatmap({
      rows: [row('2026-10-05', 6), row('2026-10-05', 4), row('2026-10-06', 5)],
      monthKeys: ['2026-10'],
      scope: 'booked',
    });
    const okt = hm.months[0];
    const mon = okt.cells.find((c) => c.weekday === 1)!;
    const tip = buildHeatmapCellTooltip(mon, okt, 'persons');
    expect(tip.monthKey).toBe('2026-10');
    expect(tip.weekday).toBe(1);
    expect(tip.reservations).toBe(2);
    expect(tip.persons).toBe(10);
    // Anteil am Monat: 10 von 15 → 66.66 %
    expect(tip.shareOfMonth).toBeCloseTo(66.667, 2);
    // Ø Pers./Res.: 10 / 2 = 5
    expect(tip.avgPersonsPerReservation).toBeCloseTo(5, 5);
    expect(tip.vsMonthAverage.diff).not.toBeNull();
  });
});

describe('buildWeekdayDayBreakdown (Detail-Popup)', () => {
  const timedRow = (
    date: string,
    partySize: number,
    time: string | null,
    status = 'confirmed',
  ) => ({ date, partySize, status, time });

  it('gruppiert je konkretem Datum + Uhrzeiten je voller Stunde', () => {
    const bd = buildWeekdayDayBreakdown({
      rows: [
        timedRow('2026-10-05', 4, '18:30'),  // Mo, 18h
        timedRow('2026-10-05', 2, '18:45'),  // Mo, 18h
        timedRow('2026-10-05', 3, '20:15'),  // Mo, 20h
        timedRow('2026-10-12', 5, '19:00'),  // Mo (anderes Datum)
      ],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
      metric: 'persons',
    });
    expect(bd.entries).toHaveLength(2);
    const d1 = bd.entries.find((e) => e.date === '2026-10-05')!;
    expect(d1.reservations).toBe(3);
    expect(d1.persons).toBe(9);
    expect(d1.day).toBe(5);
    // Uhrzeit-Buckets: 18h (2 Res / 6 Pers), 20h (1 Res / 3 Pers)
    expect(d1.times).toEqual([
      { hour: '18', reservations: 2, persons: 6 },
      { hour: '20', reservations: 1, persons: 3 },
    ]);
  });

  it('stärkster/schwächster Tag nach aktiver Kennzahl', () => {
    const bd = buildWeekdayDayBreakdown({
      rows: [
        timedRow('2026-10-05', 2, '18:00'),   // 2 Pers
        timedRow('2026-10-12', 10, '18:00'),  // 10 Pers
        timedRow('2026-10-19', 5, '18:00'),   // 5 Pers
      ],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
      metric: 'persons',
    });
    expect(bd.strongestDate).toBe('2026-10-12');
    expect(bd.weakestDate).toBe('2026-10-05');
  });

  it('Kennzahl-Umschalter beeinflusst stärkster/schwächster Tag', () => {
    const bd = buildWeekdayDayBreakdown({
      rows: [
        // 05.: 1 Res à 12 Pers ; 12.: 3 Res à je 2 Pers (=6 Pers)
        timedRow('2026-10-05', 12, '18:00'),
        timedRow('2026-10-12', 2, '18:00'),
        timedRow('2026-10-12', 2, '19:00'),
        timedRow('2026-10-12', 2, '20:00'),
      ],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
      metric: 'reservations',
    });
    // Nach Reservationen ist der 12. am stärksten (3 vs 1)
    expect(bd.strongestDate).toBe('2026-10-12');
    expect(bd.weakestDate).toBe('2026-10-05');
  });

  it('ohne Uhrzeit → leere times-Liste, keine Tage → alles null/leer', () => {
    const bd = buildWeekdayDayBreakdown({
      rows: [timedRow('2026-10-05', 4, null)],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
    });
    expect(bd.entries[0].times).toEqual([]);

    const empty = buildWeekdayDayBreakdown({
      rows: [],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
    });
    expect(empty.entries).toEqual([]);
    expect(empty.strongestDate).toBeNull();
    expect(empty.weakestDate).toBeNull();
  });

  it('filtert nach Monat, Wochentag und Status-Scope', () => {
    const bd = buildWeekdayDayBreakdown({
      rows: [
        timedRow('2026-10-05', 4, '18:00'),               // Mo Okt ✓
        timedRow('2026-10-06', 4, '18:00'),               // Di Okt ✗ (Wochentag)
        timedRow('2026-11-02', 4, '18:00'),               // Mo Nov ✗ (Monat)
        timedRow('2026-10-05', 9, '18:00', 'cancelled'),  // Mo Okt ✗ (Scope)
      ],
      monthKey: '2026-10',
      weekday: 1,
      scope: 'booked',
    });
    expect(bd.entries).toHaveLength(1);
    expect(bd.entries[0].persons).toBe(4);
  });
});
