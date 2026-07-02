// @vitest-environment node
/**
 * Tests für reservation-yoy-utils — Monatsvergleich „Ist vs. Vorjahr".
 * Rein synthetische Daten (kein Supabase, keine echten Gästedaten).
 */
import { describe, it, expect } from 'vitest';
import type { ReservationAggRow } from '../reservation-dashboard';
import {
  priorYearMonthKey,
  monthKeysInRange,
  lastDayOfMonthKey,
  makeYoyMetric,
  buildYoyComparison,
  buildYoyDayComparison,
} from '../reservation-yoy-utils';

/** Kurzhelfer: eine Reservationszeile. */
function row(date: string, partySize: number | null = 2, status = 'confirmed'): ReservationAggRow {
  return { date, partySize, status };
}

describe('priorYearMonthKey', () => {
  it('liefert denselben Monat im Vorjahr', () => {
    expect(priorYearMonthKey('2025-10')).toBe('2024-10');
    expect(priorYearMonthKey('2025-01')).toBe('2024-01');
    expect(priorYearMonthKey('2025-12')).toBe('2024-12');
  });
});

describe('monthKeysInRange', () => {
  it('liefert alle Monate inklusive Grenzen', () => {
    expect(monthKeysInRange('2025-10', '2025-12')).toEqual(['2025-10', '2025-11', '2025-12']);
  });
  it('einzelner Monat → genau ein Key', () => {
    expect(monthKeysInRange('2025-10', '2025-10')).toEqual(['2025-10']);
  });
  it('über den Jahreswechsel', () => {
    expect(monthKeysInRange('2025-11', '2026-02')).toEqual([
      '2025-11', '2025-12', '2026-01', '2026-02',
    ]);
  });
  it('Start > Ende oder ungültig → leer', () => {
    expect(monthKeysInRange('2025-12', '2025-10')).toEqual([]);
    expect(monthKeysInRange('quatsch', '2025-10')).toEqual([]);
    expect(monthKeysInRange('2025-10', '25-10')).toEqual([]);
  });
});

describe('lastDayOfMonthKey', () => {
  it('kennt Monatslängen inkl. Schaltjahr', () => {
    expect(lastDayOfMonthKey('2025-01')).toBe(31);
    expect(lastDayOfMonthKey('2025-04')).toBe(30);
    expect(lastDayOfMonthKey('2024-02')).toBe(29); // Schaltjahr
    expect(lastDayOfMonthKey('2025-02')).toBe(28);
    expect(lastDayOfMonthKey('ungültig')).toBe(0);
  });
});

describe('makeYoyMetric', () => {
  it('Wachstum: diff/diffPct positiv, Trend up', () => {
    const m = makeYoyMetric(120, 100, true);
    expect(m).toEqual({ current: 120, prior: 100, diff: 20, diffPct: 20, trend: 'up' });
  });
  it('Rückgang: Trend down', () => {
    const m = makeYoyMetric(80, 100, true);
    expect(m.diff).toBe(-20);
    expect(m.diffPct).toBe(-20);
    expect(m.trend).toBe('down');
  });
  it('gleich: Trend neutral, diffPct 0', () => {
    const m = makeYoyMetric(100, 100, true);
    expect(m.diff).toBe(0);
    expect(m.diffPct).toBe(0);
    expect(m.trend).toBe('neutral');
  });
  it('Vorjahr unbekannt: alles null + neutral', () => {
    const m = makeYoyMetric(50, 0, false);
    expect(m).toEqual({ current: 50, prior: null, diff: null, diffPct: null, trend: 'neutral' });
  });
  it('Vorjahr 0 (mit Daten): diffPct null, Trend nach diff', () => {
    const m = makeYoyMetric(5, 0, true);
    expect(m.prior).toBe(0);
    expect(m.diff).toBe(5);
    expect(m.diffPct).toBeNull();
    expect(m.trend).toBe('up');
  });
});

describe('buildYoyComparison', () => {
  it('Monat mit Wachstum (Reservationen UND Personen)', () => {
    const current = [row('2025-10-03', 4), row('2025-10-10', 2), row('2025-10-17', 6)];
    const prior = [row('2024-10-05', 3), row('2024-10-12', 2)];
    const cmp = buildYoyComparison({
      currentRows: current, priorRows: prior, monthKeys: ['2025-10'], scope: 'booked',
    });
    expect(cmp.months).toHaveLength(1);
    const m = cmp.months[0];
    expect(m.priorMonthKey).toBe('2024-10');
    expect(m.hasPriorData).toBe(true);
    expect(m.reservations.current).toBe(3);
    expect(m.reservations.prior).toBe(2);
    expect(m.reservations.diff).toBe(1);
    expect(m.reservations.diffPct).toBe(50);
    expect(m.reservations.trend).toBe('up');
    expect(m.persons.current).toBe(12);
    expect(m.persons.prior).toBe(5);
    expect(m.persons.diffPct).toBeCloseTo(140, 5);
    expect(m.persons.trend).toBe('up');
  });

  it('Monat mit Rückgang', () => {
    const current = [row('2025-11-07', 2)];
    const prior = [row('2024-11-01', 4), row('2024-11-08', 4), row('2024-11-15', 2)];
    const cmp = buildYoyComparison({
      currentRows: current, priorRows: prior, monthKeys: ['2025-11'], scope: 'booked',
    });
    const m = cmp.months[0];
    expect(m.reservations.current).toBe(1);
    expect(m.reservations.prior).toBe(3);
    expect(m.reservations.trend).toBe('down');
    expect(m.persons.current).toBe(2);
    expect(m.persons.prior).toBe(10);
    expect(m.persons.diffPct).toBe(-80);
    expect(m.persons.trend).toBe('down');
  });

  it('fehlende Vorjahr-Daten → neutral + null-Werte', () => {
    const current = [row('2025-09-05', 4)];
    const cmp = buildYoyComparison({
      currentRows: current, priorRows: [], monthKeys: ['2025-09'], scope: 'booked',
    });
    const m = cmp.months[0];
    expect(m.hasPriorData).toBe(false);
    expect(m.reservations.prior).toBeNull();
    expect(m.reservations.diff).toBeNull();
    expect(m.reservations.diffPct).toBeNull();
    expect(m.reservations.trend).toBe('neutral');
    expect(m.persons.trend).toBe('neutral');
    expect(cmp.totals.monthsWithPrior).toBe(0);
    expect(cmp.totals.reservations.prior).toBeNull();
    expect(cmp.totals.reservations.trend).toBe('neutral');
  });

  it('Zeitraum über mehrere Monate: je Monat eigener Vorjahresmonat + Totals', () => {
    const current = [
      row('2025-10-03', 2), row('2025-10-24', 2), // Okt: 2 Res / 4 Pers
      row('2025-11-07', 6),                        // Nov: 1 Res / 6 Pers
      row('2025-12-31', 8),                        // Dez: 1 Res / 8 Pers
    ];
    const prior = [
      row('2024-10-04', 2),                        // Okt VJ: 1 Res / 2 Pers
      row('2024-12-30', 4), row('2024-12-31', 4),  // Dez VJ: 2 Res / 8 Pers
      // Nov 2024: KEINE Daten
    ];
    const cmp = buildYoyComparison({
      currentRows: current, priorRows: prior,
      monthKeys: monthKeysInRange('2025-10', '2025-12'), scope: 'booked',
    });
    expect(cmp.months.map((m) => m.monthKey)).toEqual(['2025-10', '2025-11', '2025-12']);
    expect(cmp.months.map((m) => m.priorMonthKey)).toEqual(['2024-10', '2024-11', '2024-12']);
    expect(cmp.months[0].reservations.trend).toBe('up');      // 2 vs 1
    expect(cmp.months[1].hasPriorData).toBe(false);           // Nov ohne Vorjahr
    expect(cmp.months[1].reservations.trend).toBe('neutral');
    expect(cmp.months[2].reservations.trend).toBe('down');    // 1 vs 2
    // Totals: Ist über ALLE Monate, Vorjahr nur über Monate MIT Daten (Okt+Dez).
    expect(cmp.totals.monthCount).toBe(3);
    expect(cmp.totals.monthsWithPrior).toBe(2);
    expect(cmp.totals.reservations.current).toBe(4);
    expect(cmp.totals.reservations.prior).toBe(3);
    expect(cmp.totals.persons.current).toBe(18);
    expect(cmp.totals.persons.prior).toBe(10);
  });

  it('Personen- und Reservationen-Vergleich getrennt (gegensätzliche Trends)', () => {
    // Ist: mehr Reservationen, aber weniger Personen als im Vorjahr.
    const current = [row('2025-10-01', 1), row('2025-10-02', 1), row('2025-10-03', 1)];
    const prior = [row('2024-10-01', 10), row('2024-10-02', 10)];
    const cmp = buildYoyComparison({
      currentRows: current, priorRows: prior, monthKeys: ['2025-10'], scope: 'booked',
    });
    const m = cmp.months[0];
    expect(m.reservations.trend).toBe('up');    // 3 vs 2
    expect(m.persons.trend).toBe('down');       // 3 vs 20
  });

  it('Status-Scope filtert Stornos aus (booked), zählt sie aber bei "all"', () => {
    const current = [row('2025-10-01', 2, 'confirmed'), row('2025-10-02', 2, 'cancelled')];
    const prior = [row('2024-10-01', 2, 'no_show')];
    const booked = buildYoyComparison({
      currentRows: current, priorRows: prior, monthKeys: ['2025-10'], scope: 'booked',
    });
    // Storno zählt nicht; Vorjahresmonat hat aber DATEN (rawRows>0) → prior=0 bekannt.
    expect(booked.months[0].reservations.current).toBe(1);
    expect(booked.months[0].hasPriorData).toBe(true);
    expect(booked.months[0].reservations.prior).toBe(0);
    expect(booked.months[0].reservations.diffPct).toBeNull(); // Division durch 0 vermieden
    const all = buildYoyComparison({
      currentRows: current, priorRows: prior, monthKeys: ['2025-10'], scope: 'all',
    });
    expect(all.months[0].reservations.current).toBe(2);
    expect(all.months[0].reservations.prior).toBe(1);
  });

  it('partySize null zählt als 0 Personen, Reservation zählt trotzdem', () => {
    const cmp = buildYoyComparison({
      currentRows: [row('2025-10-01', null)], priorRows: [row('2024-10-01', 4)],
      monthKeys: ['2025-10'], scope: 'booked',
    });
    expect(cmp.months[0].reservations.current).toBe(1);
    expect(cmp.months[0].persons.current).toBe(0);
  });

  it('Zeilen ausserhalb der gewählten Monate fliessen nicht ein', () => {
    const cmp = buildYoyComparison({
      currentRows: [row('2025-09-30', 2), row('2025-10-01', 2), row('2025-11-01', 2)],
      priorRows: [row('2024-10-15', 2)],
      monthKeys: ['2025-10'], scope: 'booked',
    });
    expect(cmp.months[0].reservations.current).toBe(1);
    expect(cmp.totals.reservations.current).toBe(1);
  });
});

describe('buildYoyDayComparison', () => {
  it('paart Tage über den Tag im Monat und rechnet Differenzen', () => {
    const current = [row('2025-10-03', 4), row('2025-10-03', 2), row('2025-10-10', 2)];
    const prior = [row('2024-10-03', 2), row('2024-10-17', 6)];
    const day = buildYoyDayComparison({
      currentRows: current, priorRows: prior, monthKey: '2025-10', scope: 'booked',
    });
    expect(day.priorMonthKey).toBe('2024-10');
    expect(day.hasPriorData).toBe(true);
    expect(day.days).toHaveLength(31);
    const d3 = day.days[2];
    expect(d3.day).toBe(3);
    expect(d3.currentDate).toBe('2025-10-03');
    expect(d3.priorDate).toBe('2024-10-03');
    expect(d3.reservations.current).toBe(2);
    expect(d3.reservations.prior).toBe(1);
    expect(d3.persons.current).toBe(6);
    expect(d3.persons.prior).toBe(2);
    const d17 = day.days[16];
    expect(d17.reservations.current).toBe(0);
    expect(d17.reservations.prior).toBe(1);
    expect(d17.reservations.trend).toBe('down');
  });

  it('stärkste/schwächste Tage nur unter Tagen mit Ist > 0', () => {
    const current = [
      row('2025-10-01', 2), row('2025-10-01', 2), row('2025-10-01', 2), // Tag 1: 3 Res
      row('2025-10-08', 2), row('2025-10-08', 2),                       // Tag 8: 2 Res
      row('2025-10-15', 2),                                             // Tag 15: 1 Res
      row('2025-10-22', 2), row('2025-10-22', 2), row('2025-10-22', 2),
      row('2025-10-22', 2),                                             // Tag 22: 4 Res
    ];
    const day = buildYoyDayComparison({
      currentRows: current, priorRows: [], monthKey: '2025-10', scope: 'booked',
    });
    expect(day.strongestDays.map((d) => d.day)).toEqual([22, 1, 8]);
    expect(day.weakestDays.map((d) => d.day)).toEqual([15, 8, 1]);
    // Ruhetage (0 Reservationen) tauchen in keiner der Listen auf.
    expect(day.strongestDays.every((d) => d.reservations.current > 0)).toBe(true);
    expect(day.weakestDays.every((d) => d.reservations.current > 0)).toBe(true);
  });

  it('Kennzahl Personen für stärkste Tage wählbar', () => {
    const current = [
      row('2025-10-01', 2), row('2025-10-01', 2), // Tag 1: 2 Res / 4 Pers
      row('2025-10-08', 12),                       // Tag 8: 1 Res / 12 Pers
    ];
    const byRes = buildYoyDayComparison({
      currentRows: current, priorRows: [], monthKey: '2025-10', scope: 'booked',
    });
    const byPers = buildYoyDayComparison({
      currentRows: current, priorRows: [], monthKey: '2025-10', scope: 'booked', metric: 'persons',
    });
    expect(byRes.strongestDays[0].day).toBe(1);
    expect(byPers.strongestDays[0].day).toBe(8);
  });

  it('fehlendes Vorjahr → hasPriorData false, alle Tage neutral', () => {
    const day = buildYoyDayComparison({
      currentRows: [row('2025-10-03', 2)], priorRows: [], monthKey: '2025-10', scope: 'booked',
    });
    expect(day.hasPriorData).toBe(false);
    expect(day.days.every((d) => d.reservations.prior === null)).toBe(true);
    expect(day.days.every((d) => d.reservations.trend === 'neutral')).toBe(true);
  });

  it('Schaltjahr: 29. Februar existiert nur auf einer Seite', () => {
    // Ist Feb 2025 (28 Tage) vs. Vorjahr Feb 2024 (29 Tage).
    const day = buildYoyDayComparison({
      currentRows: [row('2025-02-10', 2)],
      priorRows: [row('2024-02-29', 4)],
      monthKey: '2025-02', scope: 'booked',
    });
    expect(day.days).toHaveLength(29);
    const d29 = day.days[28];
    expect(d29.currentDate).toBeNull();
    expect(d29.priorDate).toBe('2024-02-29');
    expect(d29.reservations.prior).toBe(1);
  });

  it('Zeilen anderer Monate fliessen nicht in den Tagesvergleich ein', () => {
    const day = buildYoyDayComparison({
      currentRows: [row('2025-10-03', 2), row('2025-11-03', 2)],
      priorRows: [row('2024-10-03', 2), row('2024-09-03', 2)],
      monthKey: '2025-10', scope: 'booked',
    });
    expect(day.days[2].reservations.current).toBe(1);
    expect(day.days[2].reservations.prior).toBe(1);
  });
});
