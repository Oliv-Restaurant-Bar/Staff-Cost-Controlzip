// @vitest-environment node
/**
 * Jahresvergleich (§5–§8 der 2024-Spec): buildYearKpiComparison,
 * buildPersonnelInsights, buildComparisonDrilldown, yearSelectOptions.
 *
 * Kernregeln: Schnittmenge der Datenmonate ALLER Jahre („Vergleich bis
 * gleicher Monat"), keine Hochrechnung, fehlend ≠ 0 (nie still untersummieren),
 * Δ% = (neu − alt)/|alt| mit Basis 0 → null, Quoten = Summen-Quotient.
 */
import { describe, expect, it, vi } from 'vitest';

// ─── Mocks (vor Produktions-Imports, vi.mock wird gehoisted) ─────────────────
// reporting-store zieht supabase-kv → Supabase-Client (localStorage) nach.

const localStorageStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
});

vi.mock('@/lib/supabase-kv', () => ({
  kvGet: vi.fn(async () => null),
  kvSet: vi.fn(async () => {}),
  safeUpsertReportingMonth: vi.fn(async () => {}),
  safeDeleteReportingMonth: vi.fn(async () => {}),
}));

import {
  buildYearKpiComparison,
  buildPersonnelInsights,
  buildComparisonDrilldown,
  YEAR_COMPARISON_ROWS,
  type YearSeries,
} from '@/lib/multi-year-analysis';
import { yearSelectOptions } from '@/lib/reporting-store';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Monatlich konstante Serie: revenue r, personnel p (80/15/5-Split), cogs 30 % */
function mkSeries(year: number, months: number, r: number, p: number): YearSeries {
  const val = (v: number): (number | null)[] =>
    Array.from({ length: 12 }, (_, m) => (m < months ? v : null));
  return {
    year,
    values: val(r),
    byPosition: {
      net_revenue: val(r),
      total_cogs: val(r * 0.3),
      gross_profit_1: val(r * 0.7),
      total_personnel: val(p),
      personnel_wages: val(p * 0.8),
      personnel_social: val(p * 0.15),
      personnel_other: val(p * 0.05),
      ebitda: val(r * 0.2),
      ebit: val(r * 0.15),
    },
  };
}

const S2024 = mkSeries(2024, 12, 100_000, 36_000);
const S2025 = mkSeries(2025, 12, 110_000, 37_800);
const S2026H1 = mkSeries(2026, 6, 120_000, 40_000);

const row = (cmp: ReturnType<typeof buildYearKpiComparison>, id: string) => {
  const r = cmp.rows.find((x) => x.def.id === id);
  if (!r) throw new Error(`row ${id} fehlt`);
  return r;
};

// ─── Jahresauswahl ────────────────────────────────────────────────────────────

describe('yearSelectOptions', () => {
  it('macht 2024 auswählbar (aktuell−2), auch ohne vorhandene Daten', () => {
    expect(yearSelectOptions([], 2026)).toEqual([2024, 2025, 2026, 2027]);
  });

  it('vereinigt Datenjahre mit dem Fenster und sortiert aufsteigend', () => {
    expect(yearSelectOptions([2026, 2023], 2026)).toEqual([2023, 2024, 2025, 2026, 2027]);
  });
});

// ─── Ganzjahresvergleich 2024 vs. 2025 ────────────────────────────────────────

describe('buildYearKpiComparison — volle Jahre', () => {
  const cmp = buildYearKpiComparison([S2024, S2025], [2024, 2025]);

  it('Umsatzvergleich 2024→2025: Werte, Δ CHF und Δ % korrekt', () => {
    const r = row(cmp, 'net_revenue');
    expect(r.valueByYear).toEqual([1_200_000, 1_320_000]);
    expect(r.deltas[0].chf).toBe(120_000);
    expect(r.deltas[0].pct).toBeCloseTo(10, 6);
    expect(cmp.isFullYears).toBe(true);
    expect(cmp.partialYears).toEqual([]);
    expect(cmp.commonMonths).toHaveLength(12);
  });

  it('Personalkostenvergleich 2024→2025 korrekt', () => {
    const r = row(cmp, 'total_personnel');
    expect(r.valueByYear).toEqual([432_000, 453_600]);
    expect(r.deltas[0].chf).toBeCloseTo(21_600, 6);
    expect(r.deltas[0].pct).toBeCloseTo(5, 6);
  });

  it('Personalquote = Personalaufwand/Umsatz (Summen-Quotient)', () => {
    const r = row(cmp, 'personnel_quote');
    expect(r.valueByYear[0]).toBeCloseTo(36, 6);
    expect(r.valueByYear[1]).toBeCloseTo((453_600 / 1_320_000) * 100, 6);
    expect(r.deltas[0].chf).toBeNull();
    expect(r.deltas[0].pct).toBeNull();
  });

  it('Δ Personalquote in Prozentpunkten korrekt (Verbesserung negativ)', () => {
    const r = row(cmp, 'personnel_quote');
    const expected = (453_600 / 1_320_000) * 100 - 36;
    expect(r.deltas[0].pp).toBeCloseTo(expected, 6);
    expect(expected).toBeLessThan(0);
  });

  it('EBIT-Marge korrekt, Vergleich endet bei EBIT (keine Jahresgewinn-Zeile)', () => {
    const r = row(cmp, 'ebit_margin');
    expect(r.valueByYear[0]).toBeCloseTo(15, 6);
    expect(YEAR_COMPARISON_ROWS.some((d) => /jahresgewinn|reingewinn/i.test(d.label))).toBe(false);
    expect(YEAR_COMPARISON_ROWS[YEAR_COMPARISON_ROWS.length - 1].id).toBe('ebit_margin');
  });
});

// ─── Common-Month / Teiljahr ──────────────────────────────────────────────────

describe('buildYearKpiComparison — Teiljahr 2026 (Common-Month)', () => {
  const cmp = buildYearKpiComparison([S2024, S2025, S2026H1], [2024, 2025, 2026]);

  it('vergleicht alle Jahre über Januar–Juni (Schnittmenge ALLER Jahre)', () => {
    expect(cmp.commonMonths).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cmp.commonMonthsLabel).toBe('Januar–Juni');
    expect(cmp.partialYears).toEqual([2026]);
    expect(cmp.isFullYears).toBe(false);
    const r = row(cmp, 'net_revenue');
    // Auch die vollen Jahre werden auf die gemeinsamen Monate gekürzt:
    expect(r.valueByYear).toEqual([600_000, 660_000, 720_000]);
  });

  it('rechnet das Teiljahr NICHT auf zwölf Monate hoch', () => {
    const r = row(cmp, 'net_revenue');
    expect(r.valueByYear[2]).toBe(720_000); // 6 × 120k, nie 12 × 120k
    expect(cmp.dataQuality.some((d) => d.text.includes('keine Hochrechnung'))).toBe(true);
  });

  it('liefert Δ je konsekutivem Paar und erstes→letztes Jahr', () => {
    const r = row(cmp, 'net_revenue');
    expect(r.deltas.map((d) => [d.fromYear, d.toYear])).toEqual([[2024, 2025], [2025, 2026]]);
    expect(r.firstToLast?.chf).toBe(120_000);
    expect(r.firstToLast?.pct).toBeCloseTo(20, 6);
  });
});

// ─── Fehlend ≠ 0 ──────────────────────────────────────────────────────────────

describe('buildYearKpiComparison — fehlende Werte', () => {
  it('Zeilenwert null in einem Vergleichsmonat ⇒ Jahreswert null + Warnung (nie untersummieren)', () => {
    const broken = mkSeries(2024, 12, 100_000, 36_000);
    broken.byPosition!.ebit = broken.byPosition!.ebit!.map((v, m) => (m === 3 ? null : v));
    const cmp = buildYearKpiComparison([broken, S2025], [2024, 2025]);
    expect(row(cmp, 'ebit').valueByYear[0]).toBeNull();
    expect(row(cmp, 'ebit_margin').valueByYear[0]).toBeNull();
    // Umsatz bleibt davon unberührt:
    expect(row(cmp, 'net_revenue').valueByYear[0]).toBe(1_200_000);
    expect(cmp.dataQuality.some((d) => d.severity === 'warnung' && d.text.includes('EBIT 2024'))).toBe(true);
  });

  it('Δ% mit Basis 0 ⇒ null; negative Basis nutzt |alt|', () => {
    const zero = mkSeries(2024, 12, 100_000, 36_000);
    zero.byPosition!.ebit = Array(12).fill(0);
    const neg = mkSeries(2025, 12, 110_000, 37_800);
    neg.byPosition!.ebit = Array(12).fill(-1_000);
    const pos = mkSeries(2026, 12, 120_000, 40_000);
    pos.byPosition!.ebit = Array(12).fill(500);
    // today NACH 2026: alle 12 Monate sind voll vergangen (deterministisch,
    // unabhängig vom realen Datum — sonst kappt der Laufmonats-Standard).
    const cmp = buildYearKpiComparison([zero, neg, pos], [2024, 2025, 2026], {
      today: new Date(2027, 1, 1),
    });
    const r = row(cmp, 'ebit');
    expect(r.deltas[0].pct).toBeNull(); // Basis 0
    // −12'000 → +6'000: Δ = 18'000, % = 18'000/|−12'000| = 150 %
    expect(r.deltas[1].chf).toBe(18_000);
    expect(r.deltas[1].pct).toBeCloseTo(150, 6);
  });

  it('keine gemeinsamen Datenmonate ⇒ Fehler-Hinweis, keine Werte', () => {
    const h1 = mkSeries(2024, 6, 100_000, 36_000);
    const h2: YearSeries = {
      ...mkSeries(2025, 12, 110_000, 37_800),
      values: Array.from({ length: 12 }, (_, m) => (m >= 6 ? 110_000 : null)),
    };
    h2.byPosition = Object.fromEntries(
      Object.entries(h2.byPosition!).map(([k, arr]) => [
        k, arr!.map((v, m) => (m >= 6 ? v : null)),
      ]),
    );
    const cmp = buildYearKpiComparison([h1, h2], [2024, 2025]);
    expect(cmp.rows).toHaveLength(0);
    expect(cmp.hasAnyData).toBe(false);
    expect(cmp.dataQuality.some((d) => d.severity === 'fehler' && d.text.includes('nicht möglich'))).toBe(true);
  });
});

// ─── Vergleichsmodi (Runde 6): fullYear + throughMonth ───────────────────────

describe('buildYearKpiComparison — Modus fullYear', () => {
  it('volle Jahre: identische Summen wie commonMonth, aber ohne Common-Month-Label', () => {
    const cmp = buildYearKpiComparison([S2024, S2025], [2024, 2025], { mode: 'fullYear' });
    expect(cmp.mode).toBe('fullYear');
    expect(row(cmp, 'net_revenue').valueByYear).toEqual([1_200_000, 1_320_000]);
    expect(cmp.commonMonthsLabel).toBeNull();
    expect(cmp.partialNote).toBeNull();
    expect(cmp.isFullYears).toBe(true);
  });

  it('Teiljahr: je Jahr die EIGENEN Datenmonate — nie Schnittmenge, nie Hochrechnung', () => {
    const cmp = buildYearKpiComparison([S2024, S2025, S2026H1], [2024, 2025, 2026], { mode: 'fullYear' });
    const r = row(cmp, 'net_revenue');
    // Volle Jahre bleiben 12 Monate, 2026 nur die eigenen 6 Monate:
    expect(r.valueByYear).toEqual([1_200_000, 1_320_000, 720_000]);
    expect(cmp.partialYears).toEqual([2026]);
    expect(cmp.partialNote).toContain('keine Hochrechnung');
    expect(cmp.dataQuality.some((d) =>
      d.severity === 'warnung' && d.text.includes('Ganzjahresmodus') && d.text.includes('2026'),
    )).toBe(true);
    // Selector-Basis bleibt die Schnittmenge (für den Wechsel zurück):
    expect(cmp.availableCommonMonths).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('Quote im fullYear-Modus = Quotient der jahres-eigenen Summen', () => {
    const cmp = buildYearKpiComparison([S2024, S2026H1], [2024, 2026], { mode: 'fullYear' });
    const r = row(cmp, 'personnel_quote');
    // 2026: 6×40k / 6×120k = 33.33 % — Teiljahr, aber konsistente Quote
    expect(r.valueByYear[1]).toBeCloseTo((240_000 / 720_000) * 100, 6);
  });
});

describe('buildYearKpiComparison — throughMonth (Monats-Selector)', () => {
  it('begrenzt die Vergleichsbasis auf Monate ≤ gewähltem Monat (1-basiert)', () => {
    const cmp = buildYearKpiComparison([S2024, S2025, S2026H1], [2024, 2025, 2026], {
      mode: 'commonMonth', throughMonth: 3,
    });
    expect(cmp.commonMonths).toEqual([0, 1, 2]);
    expect(cmp.commonMonthsLabel).toBe('Januar–März');
    expect(row(cmp, 'net_revenue').valueByYear).toEqual([300_000, 330_000, 360_000]);
    // Selector-Basis bleibt UNGEFILTERT (sonst verschwinden Auswahloptionen):
    expect(cmp.availableCommonMonths).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('throughMonth über der Schnittmenge wirkt wie ohne Begrenzung', () => {
    const cmp = buildYearKpiComparison([S2024, S2026H1], [2024, 2026], { throughMonth: 11 });
    expect(cmp.commonMonths).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keine gemeinsamen Monate bis zum gewählten Monat ⇒ Fehler, keine Werte', () => {
    // 2025 hat nur Jul–Dez ⇒ Schnittmenge mit 2024 (Jan–Dez) = Jul–Dez; tm=3 leert sie.
    const h2: YearSeries = mkSeries(2025, 12, 110_000, 37_800);
    h2.values = h2.values.map((v, m) => (m >= 6 ? v : null));
    h2.byPosition = Object.fromEntries(
      Object.entries(h2.byPosition!).map(([k, arr]) => [k, arr!.map((v, m) => (m >= 6 ? v : null))]),
    );
    const cmp = buildYearKpiComparison([S2024, h2], [2024, 2025], { throughMonth: 3 });
    expect(cmp.hasAnyData).toBe(false);
    expect(cmp.rows).toHaveLength(0);
    expect(cmp.availableCommonMonths).toEqual([6, 7, 8, 9, 10, 11]);
    expect(cmp.dataQuality.some((d) => d.severity === 'fehler' && d.text.includes('gewählten Monat'))).toBe(true);
  });
});

// ─── Laufmonats-Standard + leere Jahre (Runde 7) ─────────────────────────────

describe('buildYearKpiComparison — Standard schliesst den laufenden Monat aus', () => {
  it('Default endet beim letzten voll vergangenen gemeinsamen Monat (Juli-Teilmonat raus)', () => {
    // 2026 hat Jan–Jul Daten, heute = 14.07.2026 ⇒ Juli unvollständig ⇒ Basis Jan–Jun.
    const s2026Jul = mkSeries(2026, 7, 120_000, 40_000);
    const cmp = buildYearKpiComparison([S2025, s2026Jul], [2025, 2026], {
      today: new Date(2026, 6, 14),
    });
    expect(cmp.commonMonths).toEqual([0, 1, 2, 3, 4, 5]);
    expect(cmp.appliedThroughMonth).toBe(6);
    // Juli bleibt im Selector wählbar (Erweiterung «Vergleich bis» möglich):
    expect(cmp.availableCommonMonths).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cmp.dataQuality.some((d) => d.severity === 'hinweis' && d.text.includes('laufende Monat'))).toBe(true);
    expect(row(cmp, 'net_revenue').valueByYear).toEqual([660_000, 720_000]);
  });

  it('expliziter throughMonth übersteuert den Standard (Juli bewusst einbeziehbar)', () => {
    const s2026Jul = mkSeries(2026, 7, 120_000, 40_000);
    const cmp = buildYearKpiComparison([S2025, s2026Jul], [2025, 2026], {
      today: new Date(2026, 6, 14), throughMonth: 7,
    });
    expect(cmp.commonMonths).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cmp.appliedThroughMonth).toBe(7);
    expect(row(cmp, 'net_revenue').valueByYear).toEqual([770_000, 840_000]);
  });

  it('nur laufende Monate vorhanden ⇒ zeigen mit Warnung, nie leerer Vergleich', () => {
    const a = mkSeries(2025, 1, 100_000, 36_000);
    const b = mkSeries(2026, 1, 110_000, 37_800);
    const cmp = buildYearKpiComparison([a, b], [2025, 2026], {
      today: new Date(2026, 0, 20),
    });
    expect(cmp.commonMonths).toEqual([0]);
    expect(cmp.hasAnyData).toBe(true);
    expect(cmp.dataQuality.some((d) => d.severity === 'warnung' && d.text.includes('unvollständigen Monat'))).toBe(true);
  });
});

describe('buildYearKpiComparison — Jahre ohne Daten bleiben sichtbar', () => {
  it('leeres Jahr bleibt Spalte mit «—» + Import-Hinweis; Schnittmenge nur über Datenjahre', () => {
    const empty2024: YearSeries = {
      year: 2024,
      values: Array(12).fill(null),
      byPosition: Object.fromEntries(
        Object.keys(S2025.byPosition!).map((k) => [k, Array(12).fill(null)]),
      ),
    };
    const cmp = buildYearKpiComparison([empty2024, S2025, S2026H1], [2024, 2025, 2026], {
      today: new Date(2026, 6, 14),
    });
    expect(cmp.years).toEqual([2024, 2025, 2026]);
    expect(cmp.emptyYears).toEqual([2024]);
    expect(cmp.emptyNote).toContain('2024');
    expect(cmp.emptyNote).toContain('«—»');
    // Schnittmenge NUR über Jahre mit Daten (2025 ∩ 2026-H1 = Jan–Jun):
    expect(cmp.commonMonths).toEqual([0, 1, 2, 3, 4, 5]);
    const r = row(cmp, 'net_revenue');
    expect(r.valueByYear).toEqual([null, 660_000, 720_000]);
    // Δ 2025 vs. 2024 hat keine Basis ⇒ null (fehlend ≠ 0):
    expect(r.deltas[0].chf).toBeNull();
    // Leeres Jahr erzeugt KEINE Zeilen-Warnungsflut (nur den einen Hinweis):
    expect(cmp.dataQuality.filter((d) => d.text.includes('2024')).length).toBeLessThanOrEqual(1);
    expect(cmp.dataQuality.some((d) => d.text.includes('Jahresdaten importieren'))).toBe(true);
  });

  it('gänzlich fehlendes Jahr in der Auswahl wird wie ein leeres Jahr behandelt', () => {
    const cmp = buildYearKpiComparison([S2025, S2026H1], [2024, 2025, 2026], {
      today: new Date(2026, 6, 14),
    });
    expect(cmp.years).toEqual([2024, 2025, 2026]);
    expect(cmp.emptyYears).toEqual([2024]);
    expect(row(cmp, 'net_revenue').valueByYear).toEqual([null, 660_000, 720_000]);
  });
});

// ─── Personalkosten-Aussagen (§7) ─────────────────────────────────────────────

describe('buildPersonnelInsights', () => {
  it('Umsatz stärker gestiegen als Personalkosten + Quote verbessert', () => {
    const cmp = buildYearKpiComparison([S2024, S2025], [2024, 2025]);
    const lines = buildPersonnelInsights(cmp);
    expect(lines.some((l) => l.includes('Der Umsatz ist stärker gestiegen als die Personalkosten.'))).toBe(true);
    expect(lines.some((l) => l.includes('Die Personalquote hat sich verbessert'))).toBe(true);
  });

  it('Personalkosten stärker gestiegen + Quote verschlechtert', () => {
    const pricey = mkSeries(2025, 12, 105_000, 45_000);
    const cmp = buildYearKpiComparison([S2024, pricey], [2024, 2025]);
    const lines = buildPersonnelInsights(cmp);
    expect(lines.some((l) => l.includes('Die Personalkosten sind stärker gestiegen als der Umsatz.'))).toBe(true);
    expect(lines.some((l) => l.includes('Die Personalquote hat sich verschlechtert'))).toBe(true);
  });

  it('fehlende Daten ⇒ „Ein Vergleich ist aufgrund fehlender Daten nicht möglich."', () => {
    const noPers = mkSeries(2024, 12, 100_000, 36_000);
    noPers.byPosition!.total_personnel = Array(12).fill(null);
    const cmp = buildYearKpiComparison([noPers, S2025], [2024, 2025]);
    const lines = buildPersonnelInsights(cmp);
    expect(lines.some((l) => l.includes('Ein Vergleich ist aufgrund fehlender Daten nicht möglich.'))).toBe(true);
  });
});

// ─── Drilldown (§8) ───────────────────────────────────────────────────────────

describe('buildComparisonDrilldown', () => {
  it('Personal-Komponenten summieren sichtbar auf die übergeordnete Kennzahl', () => {
    const dd = buildComparisonDrilldown([S2024, S2025], [2024, 2025], 'total_personnel');
    expect(dd).not.toBeNull();
    for (const y of dd!.perYear) {
      expect(y.components).toHaveLength(3);
      expect(y.componentSum).toBeCloseTo(y.commonTotal!, 6);
      expect(Math.abs(y.reconciliationDiff!)).toBeLessThan(0.01);
    }
    // Monatszeilen: Wert je Jahr + Δ zum Vorjahr
    const jan = dd!.monthRows.find((m) => m.monthIdx === 0)!;
    expect(jan.valueByYear).toEqual([36_000, 37_800]);
    expect(jan.deltaPrev[1].chf).toBeCloseTo(1_800, 6);
  });

  it('fehlende Komponente ⇒ componentSum null, keine erfundene Abstimmung', () => {
    const broken = mkSeries(2024, 12, 100_000, 36_000);
    broken.byPosition!.personnel_other = Array(12).fill(null);
    const dd = buildComparisonDrilldown([broken, S2025], [2024, 2025], 'total_personnel');
    const y2024 = dd!.perYear.find((y) => y.year === 2024)!;
    expect(y2024.components!.find((c) => c.id === 'personnel_other')!.total).toBeNull();
    expect(y2024.componentSum).toBeNull();
    expect(y2024.reconciliationDiff).toBeNull();
  });

  it('Quoten-Zeilen haben keinen CHF-Drilldown (null)', () => {
    expect(buildComparisonDrilldown([S2024, S2025], [2024, 2025], 'personnel_quote')).toBeNull();
  });
});
