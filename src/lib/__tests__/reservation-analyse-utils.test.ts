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
