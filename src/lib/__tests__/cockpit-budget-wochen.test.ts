// @vitest-environment happy-dom
/**
 * Wochen-Budget-Regeln (Spec 08/2026):
 *  - VERHÄLTNIS-Kennzahlen (Ø-Verkauf, PKQ, Produktivität, TA-Anteil) werden
 *    NIE pro rata geteilt — direkte Overrides bleiben über alle Perioden
 *    konstant (Bug: Ø-Verkauf 29 wurde zur Wochen-«Quote» 6.55).
 *  - Personalkosten-Wochen-Budget ohne direkte Position = 40 % × Netto-Budget
 *    der Woche; PKQ-Budget damit konstant 40 %.
 *  - ABSOLUTE Werte (Umsatz, Gäste, Stunden, CHF-Kosten) weiterhin pro rata.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCockpitBudgets, leereCockpitBudgetPosition, PK_WOCHEN_ZIELQUOTE_PCT,
} from '@/lib/cockpit-budget';
import type { CockpitBudgetYear, CockpitBudgetPosition } from '@/types/budget';

const pos = (id: string, unit: CockpitBudgetPosition['unit'], monthly: (number | null)[]): CockpitBudgetPosition => ({
  ...leereCockpitBudgetPosition(id, unit), monthlyValues: monthly,
});

const monat = (m1: number, v: number): (number | null)[] => {
  const a: (number | null)[] = Array(12).fill(null);
  a[m1 - 1] = v;
  return a;
};

// KW 32/2026 = 03.08.–09.08. (voll im August, 31 Tage)
const KW32: string[] = Array.from({ length: 7 }, (_, i) => `2026-08-0${3 + i}`);

const blobMit = (positions: Record<string, CockpitBudgetPosition>): CockpitBudgetYear =>
  ({ year: 2026, positions, updatedAt: '' } as unknown as CockpitBudgetYear);

// ER-Netto-Budget August: 250'000 → Woche pro rata 250000×7/31 = 56'451.61
const ER_MONATE = monat(8, 250_000);
const NETTO_WOCHE = 250_000 * 7 / 31;

describe('Wochen-Budget: Verhältnis-Kennzahlen konstant', () => {
  it('Ø-Verkauf-Override 29 bleibt 29 in der Woche (nicht 6.55)', () => {
    const blob = blobMit({
      avg_verkauf_gast: pos('avg_verkauf_gast', 'chf', monat(8, 29)),
    });
    const b = resolveCockpitBudgets(blob, 'oliv', KW32[0], KW32[6], KW32, ER_MONATE);
    expect(b['avg_verkauf_gast']).toBe(29);
  });

  it('Produktivitäts-Override bleibt konstant, auch als Monats-Periode', () => {
    const blob = blobMit({
      produktivitaet: pos('produktivitaet', 'chf', monat(8, 120)),
    });
    const w = resolveCockpitBudgets(blob, 'oliv', KW32[0], KW32[6], KW32, ER_MONATE);
    const m = resolveCockpitBudgets(blob, 'oliv', '2026-08-01', '2026-08-31', undefined, ER_MONATE);
    expect(w['produktivitaet']).toBe(120);
    expect(m['produktivitaet']).toBe(120);
  });

  it('absolute Positionen bleiben pro rata (Gäste 3100/Monat → 700/Woche)', () => {
    const blob = blobMit({ gaeste_in: pos('gaeste_in', 'count', monat(8, 3100)) });
    const b = resolveCockpitBudgets(blob, 'oliv', KW32[0], KW32[6], KW32, ER_MONATE);
    expect(b['gaeste_in']).toBeCloseTo(3100 * 7 / 31, 1);
  });
});

describe('Wochen-Budget: Personalkosten/PKQ 40 %', () => {
  it('PK-Woche = 40 % × Netto-Wochen-Budget, PKQ = 40 konstant', () => {
    const b = resolveCockpitBudgets(blobMit({}), 'oliv', KW32[0], KW32[6], KW32, ER_MONATE, true);
    expect(b['personalkosten']).toBeCloseTo(NETTO_WOCHE * PK_WOCHEN_ZIELQUOTE_PCT / 100, 1);
    expect(b['personalquote']).toBe(40);
  });

  it('direkte PK-Position hat Vorrang vor der 40 %-Ableitung', () => {
    const blob = blobMit({ personalkosten: pos('personalkosten', 'chf', monat(8, 93_000)) });
    const b = resolveCockpitBudgets(blob, 'oliv', KW32[0], KW32[6], KW32, ER_MONATE, true);
    expect(b['personalkosten']).toBeCloseTo(93_000 * 7 / 31, 1);
  });

  it('MONATS-Auflösung erhält KEINE 40 %-Ableitung (auch mit Flag)', () => {
    const b = resolveCockpitBudgets(blobMit({}), 'oliv', '2026-08-01', '2026-08-31', undefined, ER_MONATE, true);
    expect(b['personalkosten']).toBeNull();
  });

  it('ohne Opt-in-Flag KEIN 40 %-Fallback (Wochenverlauf-Verhalten unverändert)', () => {
    const b = resolveCockpitBudgets(blobMit({}), 'oliv', KW32[0], KW32[6], KW32, ER_MONATE);
    expect(b['personalkosten']).toBeNull();
    expect(b['personalquote']).toBeNull();
  });

  it('ohne Netto-Budget bleibt PK leer (leer statt 0)', () => {
    const b = resolveCockpitBudgets(blobMit({}), 'oliv', KW32[0], KW32[6], KW32, null, true);
    expect(b['personalkosten']).toBeNull();
    expect(b['personalquote']).toBeNull();
  });
});
