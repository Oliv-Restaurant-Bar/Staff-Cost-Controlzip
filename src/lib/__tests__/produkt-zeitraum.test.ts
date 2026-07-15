// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  addDays,
  shiftYearClamped,
  quickRangeSelection,
  prevPeriod,
  samePeriodPrevYear,
  comparisonPeriod,
  deltaAbs,
  deltaPct,
  QUICK_RANGE_KEYS,
  QUICK_RANGE_LABEL,
} from '../produkt-zeitraum';
import { periodBounds, periodLabel, filtersToParams, filtersFromParams } from '../product-analytics';
import type { PeriodSelection } from '../product-analytics';

// Fester Referenz-"Heute": Mittwoch, 15.07.2026 (KW 29)
const TODAY = new Date(2026, 6, 15);

// ─── Datums-Helfer ──────────────────────────────────────────────────────────────

describe('addDays / shiftYearClamped', () => {
  it('addDays rollt über Monats- und Jahresgrenzen', () => {
    expect(addDays('2026-07-15', -6)).toBe('2026-07-09');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 kein Schaltjahr
  });

  it('shiftYearClamped klemmt 29.02. auf 28.02. in Nicht-Schaltjahren', () => {
    expect(shiftYearClamped('2024-02-29', -1)).toBe('2023-02-28');
    expect(shiftYearClamped('2024-02-29', 1)).toBe('2025-02-28');
    expect(shiftYearClamped('2026-07-15', -1)).toBe('2025-07-15');
  });
});

// ─── Schnellwahl ────────────────────────────────────────────────────────────────

describe('quickRangeSelection', () => {
  it('Heute → Tages-Selektion', () => {
    expect(quickRangeSelection('heute', TODAY)).toEqual({ kind: 'day', date: '2026-07-15' });
  });

  it('Diese Woche → ISO-KW des Referenzdatums', () => {
    expect(quickRangeSelection('diese-woche', TODAY)).toEqual({ kind: 'week', year: 2026, week: 29 });
  });

  it('Letzte 7 Tage → inklusiver Bereich (heute − 6 … heute)', () => {
    expect(quickRangeSelection('letzte-7-tage', TODAY)).toEqual({
      kind: 'range', from: '2026-07-09', to: '2026-07-15',
    });
  });

  it('Dieser Monat / Vormonat inkl. Jahreswechsel im Januar', () => {
    expect(quickRangeSelection('dieser-monat', TODAY)).toEqual({ kind: 'month', year: 2026, month: 7 });
    expect(quickRangeSelection('vormonat', TODAY)).toEqual({ kind: 'month', year: 2026, month: 6 });
    const january = new Date(2026, 0, 10);
    expect(quickRangeSelection('vormonat', january)).toEqual({ kind: 'month', year: 2025, month: 12 });
  });

  it('alle Schnellwahl-Schlüssel haben ein Label', () => {
    for (const k of QUICK_RANGE_KEYS) expect(QUICK_RANGE_LABEL[k]).toBeTruthy();
  });
});

// ─── Vorperiode ─────────────────────────────────────────────────────────────────

describe('prevPeriod', () => {
  it('day → Vortag (über Jahresgrenze)', () => {
    expect(prevPeriod({ kind: 'day', date: '2026-01-01' })).toEqual({ kind: 'day', date: '2025-12-31' });
  });

  it('week → Vorwoche, KW1 rollt ins Vorjahr (2026 KW1 → 2025 KW53? nein: 2025 hat 52)', () => {
    // 2026-KW1 beginnt Mo 29.12.2025; die Vorwoche ist die letzte KW von 2025.
    const prev = prevPeriod({ kind: 'week', year: 2026, week: 1 });
    expect(prev).toEqual({ kind: 'week', year: 2025, week: 52 });
  });

  it('KW53-Jahr: 2021 KW1 → 2020 KW53', () => {
    expect(prevPeriod({ kind: 'week', year: 2021, week: 1 })).toEqual({ kind: 'week', year: 2020, week: 53 });
  });

  it('month → Vormonat inkl. Januar→Dezember', () => {
    expect(prevPeriod({ kind: 'month', year: 2026, month: 7 })).toEqual({ kind: 'month', year: 2026, month: 6 });
    expect(prevPeriod({ kind: 'month', year: 2026, month: 1 })).toEqual({ kind: 'month', year: 2025, month: 12 });
  });

  it('year → Vorjahr', () => {
    expect(prevPeriod({ kind: 'year', year: 2026 })).toEqual({ kind: 'year', year: 2025 });
  });

  it('range → unmittelbar davor liegender Bereich gleicher Länge', () => {
    const prev = prevPeriod({ kind: 'range', from: '2026-07-09', to: '2026-07-15' });
    expect(prev).toEqual({ kind: 'range', from: '2026-07-02', to: '2026-07-08' });
  });

  it('range: verkehrt herum übergebene Grenzen werden normalisiert', () => {
    const prev = prevPeriod({ kind: 'range', from: '2026-07-15', to: '2026-07-09' });
    expect(prev).toEqual({ kind: 'range', from: '2026-07-02', to: '2026-07-08' });
  });
});

// ─── Vorjahr ────────────────────────────────────────────────────────────────────

describe('samePeriodPrevYear', () => {
  it('day: 29.02.2024 → 28.02.2023', () => {
    expect(samePeriodPrevYear({ kind: 'day', date: '2024-02-29' })).toEqual({ kind: 'day', date: '2023-02-28' });
  });

  it('week: KW53 wird auf letzte KW des Vorjahres geklemmt', () => {
    // 2020 hat 53 Wochen, 2019 nur 52 → KW53/2020 → KW52/2019
    expect(samePeriodPrevYear({ kind: 'week', year: 2020, week: 53 })).toEqual({ kind: 'week', year: 2019, week: 52 });
    expect(samePeriodPrevYear({ kind: 'week', year: 2026, week: 29 })).toEqual({ kind: 'week', year: 2025, week: 29 });
  });

  it('month / year → gleiche Periode −1 Jahr', () => {
    expect(samePeriodPrevYear({ kind: 'month', year: 2026, month: 7 })).toEqual({ kind: 'month', year: 2025, month: 7 });
    expect(samePeriodPrevYear({ kind: 'year', year: 2026 })).toEqual({ kind: 'year', year: 2025 });
  });

  it('range → beide Grenzen −1 Jahr (mit Schaltjahr-Klemmung)', () => {
    expect(samePeriodPrevYear({ kind: 'range', from: '2024-02-28', to: '2024-02-29' }))
      .toEqual({ kind: 'range', from: '2023-02-28', to: '2023-02-28' });
  });
});

// ─── comparisonPeriod ───────────────────────────────────────────────────────────

describe('comparisonPeriod', () => {
  const sel: PeriodSelection = { kind: 'month', year: 2026, month: 7 };

  it('none → null', () => {
    expect(comparisonPeriod(sel, 'none')).toBeNull();
  });

  it('vorperiode / vorjahr delegieren korrekt', () => {
    expect(comparisonPeriod(sel, 'vorperiode')).toEqual({ kind: 'month', year: 2026, month: 6 });
    expect(comparisonPeriod(sel, 'vorjahr')).toEqual({ kind: 'month', year: 2025, month: 7 });
  });
});

// ─── Deltas (fehlend ≠ 0) ───────────────────────────────────────────────────────

describe('deltaAbs / deltaPct', () => {
  it('deltaAbs: null wenn ein Wert fehlt', () => {
    expect(deltaAbs(100, 80)).toBe(20);
    expect(deltaAbs(null, 80)).toBeNull();
    expect(deltaAbs(100, undefined)).toBeNull();
  });

  it('deltaPct: null bei fehlender oder 0-Basis, nie stilles 0 %', () => {
    expect(deltaPct(110, 100)).toBeCloseTo(10);
    expect(deltaPct(80, 100)).toBeCloseTo(-20);
    expect(deltaPct(100, 0)).toBeNull();
    expect(deltaPct(null, 100)).toBeNull();
    expect(deltaPct(100, null)).toBeNull();
  });

  it('deltaPct: negative Basis nutzt Betrag als Nenner', () => {
    expect(deltaPct(-50, -100)).toBeCloseTo(50);
  });
});

// ─── range-Erweiterung in product-analytics ─────────────────────────────────────

describe('PeriodSelection range (additive Erweiterung)', () => {
  it('periodBounds normalisiert from/to', () => {
    expect(periodBounds({ kind: 'range', from: '2026-07-09', to: '2026-07-15' }))
      .toEqual({ from: '2026-07-09', to: '2026-07-15' });
    expect(periodBounds({ kind: 'range', from: '2026-07-15', to: '2026-07-09' }))
      .toEqual({ from: '2026-07-09', to: '2026-07-15' });
  });

  it('periodLabel zeigt beide Grenzen', () => {
    expect(periodLabel({ kind: 'range', from: '2026-07-09', to: '2026-07-15' }))
      .toBe('09.07.2026 – 15.07.2026');
  });

  it('URL-Roundtrip: filtersToParams → filtersFromParams', () => {
    const filters = {
      period: { kind: 'range', from: '2026-07-09', to: '2026-07-15' } as PeriodSelection,
      category: 'food' as const,
      metric: 'qty' as const,
    };
    const params = filtersToParams(filters);
    expect(params).toMatchObject({ period: 'range', from: '2026-07-09', to: '2026-07-15' });
    const restored = filtersFromParams((k) => params[k] ?? null, TODAY);
    expect(restored).toEqual(filters);
  });

  it('ungültiger range in der URL fällt robust auf Monats-Default zurück', () => {
    const params: Record<string, string> = { period: 'range', from: 'kaputt' };
    const restored = filtersFromParams((k) => params[k] ?? null, TODAY);
    expect(restored.period).toEqual({ kind: 'month', year: 2026, month: 7 });
  });
});
