// @vitest-environment node
/**
 * Tests für staffing-demand-context — Reservationszahlen als Nachfrage-Kontext
 * im Personalbedarf-SOLL/Ist-Abgleich. Rein synthetische Daten.
 */

import { describe, it, expect } from 'vitest';
import {
  LOOKBACK_OCCURRENCES,
  lookbackDates,
  buildDayDemandContext,
  demandContextLoadFrom,
  type DemandContextRow,
} from '../staffing-demand-context';

const row = (
  date: string | null,
  partySize: number | null = 2,
  status = 'confirmed',
): DemandContextRow => ({ date, partySize, status });

// 2026-10-05 ist ein Montag.
const MONDAY = '2026-10-05';

describe('lookbackDates (k Vorkommen desselben Wochentags, strikt davor)', () => {
  it('liefert k Termine, aufsteigend, alle 7 Tage auseinander', () => {
    const dates = lookbackDates(MONDAY, 3);
    expect(dates).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('Default ist LOOKBACK_OCCURRENCES (8) und geht über Monatsgrenzen', () => {
    const dates = lookbackDates(MONDAY);
    expect(dates).toHaveLength(LOOKBACK_OCCURRENCES);
    expect(dates[0]).toBe('2026-08-10'); // 8 Wochen davor, über Sept./Aug.
    expect(dates[dates.length - 1]).toBe('2026-09-28');
  });

  it('geht über Jahresgrenzen (Montag 2026-01-05 → Dez. 2025)', () => {
    const dates = lookbackDates('2026-01-05', 2);
    expect(dates).toEqual(['2025-12-22', '2025-12-29']);
  });

  it('ungültiges Datum oder k ≤ 0 → leer', () => {
    expect(lookbackDates('quatsch')).toEqual([]);
    expect(lookbackDates(MONDAY, 0)).toEqual([]);
  });
});

describe('buildDayDemandContext', () => {
  it('zählt Zieltag und Ø über ALLE k Vorkommen (0-Tage zählen mit)', () => {
    const rows: DemandContextRow[] = [
      // Zieltag: 3 Res. / 10 Personen.
      row(MONDAY, 4), row(MONDAY, 4), row(MONDAY, 2),
      // Lookback (k=4): nur 2 der 4 Montage haben Daten.
      row('2026-09-28', 6), row('2026-09-28', 2), // 2 Res. / 8 Pers.
      row('2026-09-21', 4),                        // 1 Res. / 4 Pers.
      // 09-14 und 09-07: keine Zeilen (z. B. Schliesstage) → zählen als 0.
      // Fremde Tage werden ignoriert:
      row('2026-10-06', 99), row('2026-09-29', 99),
    ];
    const ctx = buildDayDemandContext({ rows, targetDate: MONDAY, today: '2026-10-01', k: 4 });
    expect(ctx).not.toBeNull();
    expect(ctx!.weekday).toBe(1);
    expect(ctx!.dayReservations).toBe(3);
    expect(ctx!.dayPersons).toBe(10);
    expect(ctx!.avgReservations).toBeCloseTo(3 / 4, 5);  // (2+1+0+0)/4
    expect(ctx!.avgPersons).toBeCloseTo(12 / 4, 5);      // (8+4+0+0)/4
    expect(ctx!.pctDiffPersons).toBeCloseTo(((10 - 3) / 3) * 100, 5);
    expect(ctx!.occurrences).toBe(4);
    expect(ctx!.occurrencesWithData).toBe(2);
  });

  it('Status-Scope greift: stornierte/no-show zählen bei "booked" nicht', () => {
    const rows = [
      row(MONDAY, 4, 'confirmed'),
      row(MONDAY, 6, 'cancelled'),
      row(MONDAY, 6, 'no_show'),
      row('2026-09-28', 4, 'cancelled'),
    ];
    const ctx = buildDayDemandContext({ rows, targetDate: MONDAY, today: MONDAY, k: 1 });
    expect(ctx!.dayReservations).toBe(1);
    expect(ctx!.dayPersons).toBe(4);
    expect(ctx!.avgReservations).toBe(0);
    expect(ctx!.occurrencesWithData).toBe(0);
  });

  it('partySize null → 1 Reservation / 0 Personen; Datum mit Zeitanteil wird gekürzt', () => {
    const rows = [row(`${MONDAY}T18:00:00`, null)];
    const ctx = buildDayDemandContext({ rows, targetDate: MONDAY, today: MONDAY, k: 2 });
    expect(ctx!.dayReservations).toBe(1);
    expect(ctx!.dayPersons).toBe(0);
  });

  it('Ø = 0 → pctDiff null (kein Div/0)', () => {
    const ctx = buildDayDemandContext({
      rows: [row(MONDAY, 4)], targetDate: MONDAY, today: MONDAY, k: 3,
    });
    expect(ctx!.avgPersons).toBe(0);
    expect(ctx!.pctDiffPersons).toBeNull();
    expect(ctx!.pctDiffReservations).toBeNull();
  });

  it('kind: Vergangenheit → past, heute/zukünftig → expected (deterministisch via today)', () => {
    const base = { rows: [] as DemandContextRow[], targetDate: MONDAY, k: 1 };
    expect(buildDayDemandContext({ ...base, today: '2026-10-06' })!.kind).toBe('past');
    expect(buildDayDemandContext({ ...base, today: MONDAY })!.kind).toBe('expected');
    expect(buildDayDemandContext({ ...base, today: '2026-10-01' })!.kind).toBe('expected');
  });

  it('ungültiges Zieldatum → null', () => {
    expect(buildDayDemandContext({ rows: [], targetDate: 'quatsch', today: MONDAY })).toBeNull();
    expect(buildDayDemandContext({ rows: [], targetDate: '', today: MONDAY })).toBeNull();
  });

  it('Zeilen ohne Datum werden ignoriert', () => {
    const ctx = buildDayDemandContext({
      rows: [row(null, 4)], targetDate: MONDAY, today: MONDAY, k: 1,
    });
    expect(ctx!.dayReservations).toBe(0);
  });
});

describe('demandContextLoadFrom', () => {
  it('liefert das älteste Lookback-Datum (Ladefenster-Beginn)', () => {
    expect(demandContextLoadFrom(MONDAY, 4)).toBe('2026-09-07');
    expect(demandContextLoadFrom(MONDAY)).toBe('2026-08-10');
  });

  it('ungültiges Datum → null', () => {
    expect(demandContextLoadFrom('quatsch')).toBeNull();
  });
});
