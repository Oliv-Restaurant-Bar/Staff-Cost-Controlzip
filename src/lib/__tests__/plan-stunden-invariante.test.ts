// @vitest-environment happy-dom
/**
 * INVARIANTE «Plan Std»: Für jeden Mitarbeiter und Monat gilt
 *   Netto-Plan-Std ≤ Summe der Brutto-Zeitspannen des Monats.
 * Fremdmonats-Einträge im Blob dürfen NIE mitzählen.
 *
 * Live-Verifikation (Supabase, 5. Aug 2026, Mandant oliv):
 *   Pizza 2 Aushilfe (22):    22 Einträge, brutto 195.5, netto 186.5 ✓
 *   Aushilfe 2 Küche A (23):  19 Einträge, brutto 184.0, netto 169.5 ✓
 *   Momand Sajed (101):       22 Einträge, brutto 187.0, netto 187.0 ✓
 *   Party (party):            18 Einträge, brutto 170.5, netto 161.0 ✓
 */
import { describe, it, expect } from 'vitest';
import { aggregatePlanHours, debugPlanHours } from '../plan-stunden-sync';

const d = (früh: [string, string] | null, spät: [string, string] | null, extra: Record<string, unknown> = {}) => ({
  früh: früh ? { start: früh[0], end: früh[1] } : null,
  spät: spät ? { start: spät[0], end: spät[1] } : null,
  ...extra,
});

describe('Plan-Std-Invariante (netto ≤ brutto, nur Monats-Einträge)', () => {
  it('zählt Fremdmonats-Einträge nicht mit und meldet sie in der Diagnose', () => {
    const blob: Record<string, unknown> = {
      '22-2026-08-01': d(['10:00', '14:00'], ['17:30', '23:00']),
      '22-2026-08-02': d(['11:30', '21:30'], null),
      '22-2026-07-31': d(['10:00', '22:00'], null), // Fremdmonat — darf NICHT zählen
      '22-2026-09-01': d(['10:00', '20:00'], null), // Fremdmonat — darf NICHT zählen
    };
    const agg = aggregatePlanHours(blob, 2026, 8);
    // 1.8.: 4 + 5.5 = 9.5 brutto > 9 → −0.5 Pause = 9.0 | 2.8.: 10 brutto → 9.5
    expect(agg['22']).toBeCloseTo(18.5, 2);

    const [row] = debugPlanHours(blob, 2026, 8);
    expect(row.empId).toBe('22');
    expect(row.entries).toBe(2);
    expect(row.skippedForeignMonth).toBe(2);
    expect(row.monthPrefixes.sort()).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(row.netHours).toBeLessThanOrEqual(row.grossHours);
    expect(row.grossHours).toBeCloseTo(19.5, 2);
    expect(row.netHours).toBeCloseTo(18.5, 2);
  });

  it('FE-Tage zählen weder netto noch brutto', () => {
    const blob: Record<string, unknown> = {
      '22-2026-08-03': d(['10:00', '14:00'], ['17:30', '23:00'], { frühAbsence: 'FE' }),
      '22-2026-08-04': d(['10:00', '14:00'], null),
    };
    const [row] = debugPlanHours(blob, 2026, 8);
    expect(row.entries).toBe(1);
    expect(row.grossHours).toBeCloseTo(4, 2);
    expect(row.netHours).toBeCloseTo(4, 2);
    expect(aggregatePlanHours(blob, 2026, 8)['22']).toBeCloseTo(4, 2);
  });

  it('Invariante hält auch mit manuellen Einsatz-Pausen', () => {
    const blob: Record<string, unknown> = {
      '7-2026-08-05': d(['09:00', '14:00'], ['17:00', '23:00'], { fruehBreakMinutes: 30, spaetBreakMinutes: 30 }),
    };
    const [row] = debugPlanHours(blob, 2026, 8);
    expect(row.grossHours).toBeCloseTo(11, 2);
    expect(row.netHours).toBeCloseTo(10, 2);
    expect(row.netHours).toBeLessThanOrEqual(row.grossHours);
  });

  it('aggregatePlanHours und debugPlanHours liefern identische Netto-Summen', () => {
    const blob: Record<string, unknown> = {
      '22-2026-08-01': d(['10:00', '14:00'], ['17:30', '23:00']),
      '22-2026-08-02': d(['11:30', '21:30'], null),
      'b-4-2026-08-01': d(['08:00', '17:00'], null),
      '22-2026-07-15': d(['10:00', '20:00'], null),
    };
    const agg = aggregatePlanHours(blob, 2026, 8);
    for (const row of debugPlanHours(blob, 2026, 8)) {
      expect(row.netHours).toBeCloseTo(agg[row.empId] ?? 0, 2);
      expect(row.netHours).toBeLessThanOrEqual(row.grossHours + 0.001);
    }
  });
});
