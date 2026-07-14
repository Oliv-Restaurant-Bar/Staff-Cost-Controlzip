// @vitest-environment node
/**
 * effective-records.ts — die "effektiven" ER-Monats-Records (SSoT).
 *
 * Regel 1: IST-Umsatz aus der Tagesansicht (dailyBudgets) schlägt reporting_v1,
 *          AUSSER wenn Sage 3xxx-Umsatzkonten vorhanden sind; Monats-Take-Away
 *          wird auf Kto. 3000/3010 aufgeteilt.
 * Regel 2: Buchhaltungs-Lohnkonten (5000–5009) entfernen personnelCostActual.
 *
 * Erwartungswerte für Regel 1 kommen aus computeMonthlyIstNet/Gross selbst —
 * getestet wird die VERDRAHTUNG (gleiche Quelle wie die Erfolgsrechnung),
 * die Summenlogik ist in revenue-sync abgesichert.
 */
import { describe, expect, it } from 'vitest';
import {
  applyEffectiveMonthRules,
  applyEffectiveYearRules,
  hasIndividualRevenueAccounts,
  hasAccountingWageAccounts,
  type EffectiveRecordDeps,
} from '@/lib/effective-records';
import { computeMonthlyIstNet, computeMonthlyIstGross } from '@/lib/revenue-sync';
import type { MonthlyFinancialRecord } from '@/types/reporting';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mkRec = (
  year: number,
  month: number,
  over: Partial<MonthlyFinancialRecord> = {},
): MonthlyFinancialRecord => ({
  id: `${year}-${String(month).padStart(2, '0')}`,
  year,
  month,
  expenseCategories: [],
  ...over,
} as MonthlyFinancialRecord);

/** Tagesumsätze: an `days` Tagen im Monat je `gross` CHF Brutto. */
function mkDaily(year: number, month: number, days: number, gross: number): Record<string, { actualRevenue?: number }> {
  const mm = String(month).padStart(2, '0');
  const out: Record<string, { actualRevenue?: number }> = {};
  for (let d = 1; d <= days; d++) {
    out[`${year}-${mm}-${String(d).padStart(2, '0')}`] = { actualRevenue: gross };
  }
  return out;
}

const deps = (year: number, over: Partial<EffectiveRecordDeps> = {}): EffectiveRecordDeps => ({
  year,
  dailyBudgets: {},
  net: true,
  ...over,
});

// ─── Konto-Erkennung ──────────────────────────────────────────────────────────

describe('hasIndividualRevenueAccounts / hasAccountingWageAccounts', () => {
  it('erkennt 3xxx-Umsatzkonten (Grenzen inklusiv), ignoriert Nicht-Zahlen', () => {
    const r3 = mkRec(2026, 1, { expenseCategories: [{ categoryId: '3000', amount: 1, label: 'x' }] as never });
    const r4 = mkRec(2026, 1, { expenseCategories: [{ categoryId: '4000', amount: 1, label: 'x' }] as never });
    const rTxt = mkRec(2026, 1, { expenseCategories: [{ categoryId: 'food', amount: 1, label: 'x' }] as never });
    expect(hasIndividualRevenueAccounts(r3)).toBe(true);
    expect(hasIndividualRevenueAccounts(r4)).toBe(false);
    expect(hasIndividualRevenueAccounts(rTxt)).toBe(false);
  });

  it('Lohnkonten nur 5000–5009 (5010 zählt nicht)', () => {
    const r5000 = mkRec(2026, 1, { expenseCategories: [{ categoryId: '5000', amount: 1, label: 'x' }] as never });
    const r5009 = mkRec(2026, 1, { expenseCategories: [{ categoryId: '5009', amount: 1, label: 'x' }] as never });
    const r5010 = mkRec(2026, 1, { expenseCategories: [{ categoryId: '5010', amount: 1, label: 'x' }] as never });
    expect(hasAccountingWageAccounts(r5000)).toBe(true);
    expect(hasAccountingWageAccounts(r5009)).toBe(true);
    expect(hasAccountingWageAccounts(r5010)).toBe(false);
  });
});

// ─── Regel 1: Tagesansicht-Umsatz ────────────────────────────────────────────

describe('applyEffectiveMonthRules — Regel 1 (IST-Umsatz)', () => {
  const daily = mkDaily(2026, 3, 20, 1_000);

  it('ersetzt revenueActual durch den Tagesansicht-Nettowert (gleiche Quelle wie die ER)', () => {
    const rec = mkRec(2026, 3, { revenueActual: 15_000 });
    const out = applyEffectiveMonthRules(rec, 3, deps(2026, { dailyBudgets: daily }));
    const expected = computeMonthlyIstNet(2026, 3, daily, undefined, undefined, undefined);
    expect(expected).toBeGreaterThan(0);
    expect(out.revenueActual).toBe(expected);
    expect(out).not.toBe(rec); // immutabel, kein In-Place-Mutieren
  });

  it('Brutto-Modus nutzt computeMonthlyIstGross', () => {
    const rec = mkRec(2026, 3, {});
    const out = applyEffectiveMonthRules(rec, 3, deps(2026, { dailyBudgets: daily, net: false }));
    expect(out.revenueActual).toBe(computeMonthlyIstGross(2026, 3, daily));
  });

  it('greift NICHT, wenn Sage 3xxx-Umsatzkonten vorhanden sind', () => {
    const rec = mkRec(2026, 3, {
      revenueActual: 15_000,
      expenseCategories: [{ categoryId: '3000', amount: 15_000, label: 'Ertrag' }] as never,
    });
    const out = applyEffectiveMonthRules(rec, 3, deps(2026, { dailyBudgets: daily }));
    expect(out.revenueActual).toBe(15_000);
    expect(out).toBe(rec);
  });

  it('greift NICHT ohne Tagesumsätze (fehlend ≠ 0 — Record bleibt unverändert)', () => {
    const rec = mkRec(2026, 3, { revenueActual: 15_000 });
    const out = applyEffectiveMonthRules(rec, 3, deps(2026));
    expect(out).toBe(rec);
  });

  it('Monats-Take-Away wird auf Kto. 3000/3010 aufgeteilt (Summe ≡ revenueActual)', () => {
    const ta = 2_000;
    const rec = mkRec(2026, 3, {});
    const out = applyEffectiveMonthRules(rec, 3, deps(2026, {
      dailyBudgets: daily,
      takeawayMonthly: { '2026-03': ta },
    }));
    const expected = computeMonthlyIstNet(2026, 3, daily, undefined, undefined, ta);
    expect(out.revenueActual).toBe(expected);
    const k3000 = out.expenseCategories.find((c) => c.categoryId === '3000');
    const k3010 = out.expenseCategories.find((c) => c.categoryId === '3010');
    expect(k3010?.amount).toBe(ta); // Netto: 3010 = Take-Away direkt
    expect((k3000?.amount ?? 0) + (k3010?.amount ?? 0)).toBeCloseTo(expected, 6);
  });

  it('Take-Away eines ANDEREN Monats/Jahres wird nicht angewendet', () => {
    const out = applyEffectiveMonthRules(mkRec(2026, 3, {}), 3, deps(2026, {
      dailyBudgets: daily,
      takeawayMonthly: { '2026-04': 2_000, '2025-03': 999 },
    }));
    expect(out.expenseCategories.some((c) => c.categoryId === '3010')).toBe(false);
  });
});

// ─── Regel 2: Buchhaltung schlägt Dienstplan ─────────────────────────────────

describe('applyEffectiveMonthRules — Regel 2 (Personalkosten)', () => {
  it('entfernt personnelCostActual bei vorhandenen 5000–5009-Konten', () => {
    const rec = mkRec(2026, 1, {
      personnelCostActual: 50_000,
      expenseCategories: [{ categoryId: '5000', amount: 48_000, label: 'Löhne' }] as never,
    });
    const out = applyEffectiveMonthRules(rec, 1, deps(2026));
    expect(out.personnelCostActual).toBeUndefined();
  });

  it('behält personnelCostActual ohne Buchhaltungs-Lohnkonten', () => {
    const rec = mkRec(2026, 1, { personnelCostActual: 50_000 });
    const out = applyEffectiveMonthRules(rec, 1, deps(2026));
    expect(out.personnelCostActual).toBe(50_000);
  });
});

// ─── Jahres-Anwendung ─────────────────────────────────────────────────────────

describe('applyEffectiveYearRules', () => {
  it('wendet die Regeln je Monat an (records[idx] = Monat idx+1)', () => {
    const daily = { ...mkDaily(2026, 1, 10, 1_000), ...mkDaily(2026, 2, 10, 2_000) };
    const records = Array.from({ length: 12 }, (_, i) => mkRec(2026, i + 1, {}));
    const out = applyEffectiveYearRules(records, deps(2026, { dailyBudgets: daily }));
    expect(out).toHaveLength(12);
    expect(out[0].revenueActual).toBe(computeMonthlyIstNet(2026, 1, daily));
    expect(out[1].revenueActual).toBe(computeMonthlyIstNet(2026, 2, daily));
    // Monate ohne Tagesumsätze bleiben unverändert (fehlend ≠ 0):
    expect(out[2].revenueActual).toBeUndefined();
  });
});
