/**
 * Perioden-Aggregation für die Budget-P&L-Ansicht (Monat/Quartal/Jahr)
 * =====================================================================
 *
 * REINE Logik — keine DOM-, Supabase- oder Storage-Zugriffe.
 *
 * Verbindliche Regeln (keine Zweitberechnung):
 *   - Eingabe sind die UNVERÄNDERTEN Monats-Zeilen aus `computeBPLRows`
 *     (PLView) bzw. Monats-Ergebnisse aus `computePLForMonth` (pl-engine).
 *   - Beträge werden über die Monate summiert; Abweichungen (vsBudget,
 *     vsPrevYear) und Prozente werden aus den SUMMIERTEN Rohwerten neu
 *     berechnet — exakt mit der `makeCell`-Formel der Monatsansicht
 *     (Gleichheit ist per Test abgesichert).
 *   - Kennzahlen: Beträge null-erhaltend summieren (nur Monate mit Wert;
 *     ALLE fehlend ⇒ null, NIE 0); Quoten aus den Rohsummen, Nenner
 *     fehlt/0 ⇒ null (fehlend ≠ 0) — identisch zur Financial-Metrics-
 *     Registry (`financial-metrics.ts`).
 */

import type { BPLCell, BPLRowWithValues } from '@/pages/PLView';
import type { PLMonthResult } from '@/types/pl';
import type { FinancialMetricId, FinancialMetricValues } from '@/lib/financial-metrics';
import { getFinancialMetric } from '@/lib/financial-metrics';

// ─── BPL-Zeilen-Aggregation ──────────────────────────────────────────────────

/** Repliziert die makeCell-Formel aus PLView auf summierten Rohwerten. */
function makeAggregatedCell(actual: number, budget: number, prevYear: number, isExpense: boolean): BPLCell {
  const vsBudget   = actual - budget;
  const vsPrevYear = actual - prevYear;
  return {
    isExpense, actual, budget, prevYear,
    vsBudget,
    vsBudgetPct:   budget   !== 0 ? (vsBudget   / Math.abs(budget))   * 100 : undefined,
    vsPrevYear,
    vsPrevYearPct: prevYear !== 0 ? (vsPrevYear / Math.abs(prevYear)) * 100 : undefined,
  };
}

/** Stabiler Identitätsschlüssel einer BPL-Zeile über Monatsgrenzen hinweg. */
function rowKey(r: BPLRowWithValues): string {
  if (r.isCategory) return `cat|${r.catId}|${r.catType}`;
  return `item|${r.catId}|${r.itemId ?? `lbl:${r.itemLabel ?? ''}`}`;
}

export interface AggregatedBPLResult {
  rows: BPLRowWithValues[];
  /** Anzahl Monate der Periode mit Ist-Daten (für den «X von Y Monaten»-Hinweis). */
  monthsWithData: number;
  monthsTotal: number;
}

/**
 * Aggregiert die Monats-Zeilenlisten einer Periode (Quartal = 3, Jahr = 12)
 * zu EINER Zeilenliste. Zeilen werden über einen stabilen Schlüssel
 * zusammengeführt (Zeilen, die nur in einzelnen Monaten vorkommen, bleiben
 * erhalten und werden positionsgetreu einsortiert). Da alle Zwischentotale
 * und Ergebniszeilen linear aus den Mitgliederzeilen entstehen, bleibt die
 * Summenabstimmung nach der Aggregation automatisch konsistent.
 */
export function aggregateBPLRows(
  rowsPerMonth: BPLRowWithValues[][],
  hasDataFlags: boolean[],
): AggregatedBPLResult {
  const order: string[] = [];
  const byKey = new Map<string, { row: BPLRowWithValues; actual: number; budget: number; prevYear: number }>();

  for (const monthRows of rowsPerMonth) {
    let prevIdx = -1;
    for (const r of monthRows) {
      const k = rowKey(r);
      let idx = order.indexOf(k);
      if (idx === -1) {
        idx = prevIdx + 1;
        order.splice(idx, 0, k);
        byKey.set(k, { row: r, actual: 0, budget: 0, prevYear: 0 });
      }
      const agg = byKey.get(k)!;
      agg.actual   += r.values.actual;
      agg.budget   += r.values.budget;
      agg.prevYear += r.values.prevYear;
      prevIdx = idx;
    }
  }

  const rows = order.map(k => {
    const agg = byKey.get(k)!;
    return {
      ...agg.row,
      // «Ausgeblendet» gilt für die Periode nur, wenn ALLE Monatssummen leer sind
      // (ein Monat mit Wert ⇒ normale Zeile, auch wenn der erste Monat leer war).
      isAutoHidden: agg.row.isAutoHidden && agg.actual === 0 && agg.budget === 0 && agg.prevYear === 0
        ? true : undefined,
      values: makeAggregatedCell(agg.actual, agg.budget, agg.prevYear, agg.row.isExpense),
    };
  });

  return {
    rows,
    monthsWithData: hasDataFlags.filter(Boolean).length,
    monthsTotal: rowsPerMonth.length,
  };
}

// ─── Kennzahlen-Aggregation (Financial-Metrics-Registry) ─────────────────────

type MetricColumn = 'actual' | 'budget' | 'prevYear';

/**
 * Null-erhaltende Summe einer P&L-Zeilenspalte über mehrere Monate:
 * nur Monate mit Wert zählen; haben ALLE Monate keinen Wert ⇒ null (nie 0).
 */
function sumRowColumn(pls: PLMonthResult[], rowId: string, col: MetricColumn): number | null {
  let sum = 0;
  let any = false;
  for (const pl of pls) {
    const v = pl.rows.find(r => r.def.id === rowId)?.values[col];
    if (v === undefined || v === null) continue;
    sum += v;
    any = true;
  }
  return any ? sum : null;
}

/** Quote in % aus Rohsummen; Zähler/Nenner fehlt bzw. Nenner 0 ⇒ null. */
function ratioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/**
 * Zähler-Zeile je Quoten-Kennzahl — spiegelt exakt die ratioMetric-
 * Definitionen der Registry (financial-metrics.ts); Gleichheit ist per
 * Test (1-Monats-Aggregat ≡ getFinancialMetricValues) abgesichert.
 */
const RATIO_NUMERATOR_ROW: Partial<Record<FinancialMetricId, string>> = {
  cogs_ratio:      'total_cogs_einkauf',
  personnel_ratio: 'total_personnel',
  ebitda_margin:   'ebitda',
  ebit_margin:     'ebit',
};

/**
 * Aggregiert eine Registry-Kennzahl über mehrere Monats-P&L-Ergebnisse
 * (Quartal/Jahr). Beträge = null-erhaltende Summe; Quoten = aus den
 * Rohsummen von Zähler und Nettoumsatz derselben Spalte.
 */
export function aggregateFinancialMetricValues(
  id: FinancialMetricId,
  pls: PLMonthResult[],
): FinancialMetricValues {
  const def = getFinancialMetric(id);

  if (def.kind === 'amount') {
    return {
      actual:    sumRowColumn(pls, id, 'actual'),
      budget:    sumRowColumn(pls, id, 'budget'),
      priorYear: sumRowColumn(pls, id, 'prevYear'),
    };
  }

  const numRowId = RATIO_NUMERATOR_ROW[id];
  if (!numRowId) {
    return { actual: null, budget: null, priorYear: null };
  }
  return {
    actual:    ratioPct(sumRowColumn(pls, numRowId, 'actual'),   sumRowColumn(pls, 'net_revenue', 'actual')),
    budget:    ratioPct(sumRowColumn(pls, numRowId, 'budget'),   sumRowColumn(pls, 'net_revenue', 'budget')),
    priorYear: ratioPct(sumRowColumn(pls, numRowId, 'prevYear'), sumRowColumn(pls, 'net_revenue', 'prevYear')),
  };
}
