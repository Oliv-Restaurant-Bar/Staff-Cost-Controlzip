// @vitest-environment happy-dom
/**
 * Gäste IN abgeleitet aus Umsatz ÷ Umsatz-pro-Person (Spec 08/2026).
 * Schutzregeln: nie ÷ 0, Tag ohne pp bleibt LEER (nicht 0), keine pp-Quelle →
 * leeres Ergebnis (kein Rückfall auf den getippten Personen-Import).
 */
import { describe, it, expect } from 'vitest';
import { deriveGaesteDaily } from '@/lib/gaeste-derived';

describe('deriveGaesteDaily', () => {
  it('rundet kaufmännisch auf ganze Gäste', () => {
    expect(deriveGaesteDaily(
      { '2026-08-13': 24.0 },
      { '2026-08-13': 7249.90 },
    )).toEqual({ '2026-08-13': 302 }); // 302.07 → 302
    expect(deriveGaesteDaily(
      { '2026-08-01': 20.0 },
      { '2026-08-01': 1010.0 },
    )).toEqual({ '2026-08-01': 51 }); // 50.5 → 51 (kaufmännisch)
  });

  it('pp = 0 oder fehlend → Tag bleibt leer (nie ÷ 0, nie 0 erfinden)', () => {
    const out = deriveGaesteDaily(
      { '2026-08-01': 0, '2026-08-02': -5 },
      { '2026-08-01': 5000, '2026-08-02': 4000, '2026-08-03': 3000 },
    );
    expect(out).toEqual({}); // Tag 03 hat Umsatz, aber keinen pp-Wert → leer
  });

  it('Tag mit pp aber ohne Umsatz bleibt leer', () => {
    expect(deriveGaesteDaily(
      { '2026-08-02': 21.5 },
      {},
    )).toEqual({});
  });

  it('leere pp-Quelle → leeres Ergebnis (kein Fallback)', () => {
    expect(deriveGaesteDaily({}, { '2026-08-01': 5000 })).toEqual({});
  });

  it('Beaulieu-Abnahme-Muster: Summe der Tageswerte, nicht Zeitraum-Skalierung', () => {
    // pp so gewählt, dass die Soll-Tageswerte entstehen (Brutto = korrigierte Ist-Tage).
    const brutto = {
      '2026-08-10': 5742.60, '2026-08-11': 5889.00,
      '2026-08-12': 6720.60, '2026-08-13': 7249.90,
    };
    const pp = {
      '2026-08-10': 20.51, '2026-08-11': 16.68,
      '2026-08-12': 21.75, '2026-08-13': 24.01,
    };
    const out = deriveGaesteDaily(pp, brutto);
    expect(out).toEqual({
      '2026-08-10': 280, '2026-08-11': 353, '2026-08-12': 309, '2026-08-13': 302,
    });
    expect(Object.values(out).reduce((s, n) => s + n, 0)).toBe(1244);
  });
});
