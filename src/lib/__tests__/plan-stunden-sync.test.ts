// @vitest-environment happy-dom
/**
 * Regressionstests: Personalkosten «Plan Std» = Dienstplan (SSoT Supabase).
 *
 * Symptom (August 2026, Oliv, Küche): Personalkosten zeigte MEHR Plan-Stunden
 * als der Dienstplan, weil veraltete localStorage-Reste (schedule-v2-YYYY-MM)
 * in die Aggregation liefen. Fix: Supabase-Spiegel ersetzt den Cache
 * VOLLSTÄNDIG; Aggregation filtert strikt auf den Monat.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase-kv', () => ({ kvGet: vi.fn(), kvSet: vi.fn() }));

import { aggregatePlanHours, mirrorPlanMonthToLocalStorage } from '@/lib/plan-stunden-sync';
import { calculateDayNetHours } from '@/hooks/useShiftConfig';

type Slot = { start: string; end: string } | null;
const day = (früh: Slot, spät: Slot = null, extra: Record<string, unknown> = {}) => ({
  früh, spät, frühAbsence: null, spätAbsence: null, ...extra,
});

/** Baut N gleiche Tage à `hours` Netto (ohne Auto-Pause, ≤9h brutto). */
function buildMonth(empId: string, year: number, month: number, days: number, from: string, to: string) {
  const out: Record<string, unknown> = {};
  for (let d = 1; d <= days; d++) {
    out[`${empId}-${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`] = day({ start: from, end: to });
  }
  return out;
}

describe('aggregatePlanHours (SSoT-Aggregation)', () => {
  it('summiert Netto-Stunden pro Mitarbeiter via calculateDayNetHours', () => {
    const data = {
      'emp1-2026-08-01': day({ start: '10:00', end: '14:00' }, { start: '18:00', end: '22:00' }),
      'emp1-2026-08-02': day({ start: '10:00', end: '15:30' }),
      'emp2-2026-08-01': day({ start: '08:00', end: '16:00' }),
    };
    const agg = aggregatePlanHours(data, 2026, 8);
    expect(agg['emp1']).toBeCloseTo(8 + 5.5, 5);
    expect(agg['emp2']).toBeCloseTo(8, 5);
  });

  it('ignoriert Einträge fremder Monate im Blob (veraltete Cache-Reste)', () => {
    const data = {
      'pizza2-2026-08-01': day({ start: '10:00', end: '18:00' }),
      // Stale-Reste mit Fremdmonats-Datum dürfen NICHT zählen:
      'pizza2-2026-07-30': day({ start: '10:00', end: '18:00' }),
      'pizza2-2026-09-01': day({ start: '10:00', end: '18:00' }),
    };
    const agg = aggregatePlanHours(data, 2026, 8);
    expect(agg['pizza2']).toBeCloseTo(8, 5);
  });

  it('überspringt FE-markierte Tage (Ferien zählen nicht als Arbeit)', () => {
    const data = {
      'emp1-2026-08-01': day({ start: '10:00', end: '18:00' }),
      'emp1-2026-08-02': day({ start: '10:00', end: '18:00' }, null, { frühAbsence: 'FE' }),
      'emp1-2026-08-03': day(null, { start: '18:00', end: '22:00' }, { spätAbsence: 'FE' }),
    };
    expect(aggregatePlanHours(data, 2026, 8)['emp1']).toBeCloseTo(8, 5);
  });

  it('zieht Auto-Pause >9h ab — identisch zum Dienstplan (calculateDayNetHours)', () => {
    const ds = day({ start: '08:00', end: '18:00' }); // 10h brutto → 9.5h netto
    expect(calculateDayNetHours(ds as never)).toBeCloseTo(9.5, 5);
    const agg = aggregatePlanHours({ 'emp1-2026-08-01': ds }, 2026, 8);
    expect(agg['emp1']).toBeCloseTo(9.5, 5);
  });
});

describe('mirrorPlanMonthToLocalStorage (Vollersatz, Supabase gewinnt)', () => {
  it('ersetzt den Cache vollständig — keine Reste alter Einträge', () => {
    const key = 'schedule-v2-2026-08';
    // Veralteter Cache: Pizza 2 Aushilfe mit 4 zusätzlichen Geister-Tagen
    const stale = {
      ...buildMonth('pizza2', 2026, 8, 23, '08:00', '17:00'), // 23×8.5? nein: 9h brutto → 9h netto (≤9h keine Pause)
      'ghost-2026-08-01': day({ start: '10:00', end: '18:00' }),
    };
    localStorage.setItem(key, JSON.stringify(stale));
    // Supabase (kanonisch): nur 19 Tage
    const supabase = buildMonth('pizza2', 2026, 8, 19, '08:00', '17:00');
    expect(mirrorPlanMonthToLocalStorage(supabase, key)).toBe(true);
    const cached = JSON.parse(localStorage.getItem(key)!);
    expect(Object.keys(cached).length).toBe(19);
    expect(cached['ghost-2026-08-01']).toBeUndefined();
    const agg = aggregatePlanHours(cached, 2026, 8);
    expect(agg['pizza2']).toBeCloseTo(19 * 9, 1);
    expect(agg['ghost']).toBeUndefined();
  });

  it('leerer Supabase-Monat ersetzt ebenfalls (Supabase gewinnt bei Divergenz)', () => {
    const key = 'schedule-v2-2026-09';
    localStorage.setItem(key, JSON.stringify(buildMonth('emp1', 2026, 9, 5, '10:00', '18:00')));
    expect(mirrorPlanMonthToLocalStorage({}, key)).toBe(true);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({});
  });

  it('Kontrollwert-Szenario: Plan Std nach Spiegel = Dienstplan-Stunden (±0.1 h)', () => {
    const key = 'oliv:schedule-v2-2026-08';
    // Stale Cache mit ZU VIEL (Symptom: Personalkosten > Dienstplan)
    localStorage.setItem(key, JSON.stringify({
      ...buildMonth('aushilfe2k', 2026, 8, 21, '09:00', '17:15'), // 21×8.25 = 173.25 (stale, zu viel)
    }));
    // Supabase = Dienstplan: 20 Tage à 8.2h ≈ 164.0
    const supabase = buildMonth('aushilfe2k', 2026, 8, 20, '09:00', '17:12');
    mirrorPlanMonthToLocalStorage(supabase, key);
    const agg = aggregatePlanHours(JSON.parse(localStorage.getItem(key)!), 2026, 8);
    let dienstplan = 0;
    for (const ds of Object.values(supabase)) dienstplan += calculateDayNetHours(ds as never);
    expect(Math.abs(agg['aushilfe2k'] - dienstplan)).toBeLessThan(0.1);
    expect(agg['aushilfe2k']).toBeCloseTo(164, 1);
  });
});
