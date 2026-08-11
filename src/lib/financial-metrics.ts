/**
 * Financial Metrics Registry — zentrale, REIN LESENDE Kennzahlen-Registry
 * ========================================================================
 *
 * Verbindliche Regeln (KEINE zweite Finanzengine):
 *   - IST      = P&L-Engine (`computePLForMonth` → rows[].values.actual)
 *   - PLAN     = Budget-Overrides derselben P&L-Berechnung (values.budget,
 *                via `buildBudgetByRowForMonth` + `buildCogsBudgetSplitForMonth`)
 *   - VORJAHR  = VJ-Spalte derselben P&L-Berechnung (values.prevYear,
 *                via `buildPrevYearByRowForMonth` — exakt die VJ-Logik der
 *                Erfolgsrechnung, keine Zweitberechnung)
 *   - Quoten   = aus den ROHEN Beträgen derselben Spalte; Nenner fehlt/0 ⇒ null
 *                (fehlend ≠ 0); KEINE Rundung — gerundet wird nur die Anzeige.
 *
 * Dieses Modul ist reine Logik: keine DOM-, Supabase- oder Storage-Zugriffe.
 * Der Input wird vom IO-Builder (`financial-metrics-input.ts`) oder von
 * bestehenden P&L-Konsumenten (z. B. PLView) geliefert.
 */

import type { PLMonthResult } from '@/types/pl';
import { PL_STRUCTURE } from '@/lib/pl-engine';

// ─── Typen (vom User vorgegeben — verbatim) ──────────────────────────────────

export type FinancialMetricId =
  | "net_revenue"
  | "total_cogs"
  | "total_cogs_einkauf"
  | "total_cogs_direct"
  | "gross_profit_1"
  | "total_personnel"
  | "gross_profit_2"
  | "total_opex"
  | "ebitda"
  | "total_depreciation"
  | "ebit"
  | "cogs_ratio"
  | "personnel_ratio"
  | "ebitda_margin"
  | "ebit_margin";

export type FinancialMetricKind =
  | "amount"
  | "ratio";

export type FinancialMetricSource =
  | "pl"
  | "budget"
  | "prior_year_pl";

export type FinancialMetricContext = {
  tenantId: string;
  year: number;
  month: number;
};

export type FinancialMetricValues = {
  actual: number | null;
  budget: number | null;
  priorYear: number | null;
};

/**
 * Input der Registry: EIN vollständiges P&L-Monatsergebnis, berechnet mit
 * allen drei Spalten (actual + budget + prevYear via Overrides).
 * Damit ist garantiert: Registry-Werte ≡ Erfolgsrechnungs-Werte.
 */
export type FinancialMetricRegistryInput = {
  pl: PLMonthResult;
};

export type FinancialMetricDefinition = {
  id: FinancialMetricId;
  label: string;
  kind: FinancialMetricKind;
  unit: "CHF" | "%";
  actualSource: "pl";
  budgetSource: "budget";
  priorYearSource: "prior_year_pl";
  getValues: (
    input: FinancialMetricRegistryInput
  ) => FinancialMetricValues;
};

// ─── interne Helfer ──────────────────────────────────────────────────────────

/** PL-Zeilenwerte einer Row-ID als {actual,budget,priorYear} — undefined ⇒ null. */
function rowCell(pl: PLMonthResult, rowId: string): FinancialMetricValues {
  const v = pl.rows.find(r => r.def.id === rowId)?.values;
  return {
    actual:    v?.actual   ?? null,
    budget:    v?.budget   ?? null,
    priorYear: v?.prevYear ?? null,
  };
}

/** Quote in % aus Rohwerten; Zähler oder Nenner fehlt bzw. Nenner 0 ⇒ null. */
function ratioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/** Label aus der PL_STRUCTURE (SSoT der Zeilenbeschriftungen). */
function plLabel(rowId: string): string {
  return PL_STRUCTURE.find(r => r.id === rowId)?.label ?? rowId;
}

function amountMetric(id: FinancialMetricId & string): FinancialMetricDefinition {
  return {
    id, label: plLabel(id), kind: "amount", unit: "CHF",
    actualSource: "pl", budgetSource: "budget", priorYearSource: "prior_year_pl",
    getValues: input => rowCell(input.pl, id),
  };
}

function ratioMetric(id: FinancialMetricId, label: string, numeratorRowId: string): FinancialMetricDefinition {
  return {
    id, label, kind: "ratio", unit: "%",
    actualSource: "pl", budgetSource: "budget", priorYearSource: "prior_year_pl",
    getValues: input => {
      const num = rowCell(input.pl, numeratorRowId);
      const den = rowCell(input.pl, "net_revenue");
      return {
        actual:    ratioPct(num.actual,    den.actual),
        budget:    ratioPct(num.budget,    den.budget),
        priorYear: ratioPct(num.priorYear, den.priorYear),
      };
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const FINANCIAL_METRICS: Record<FinancialMetricId, FinancialMetricDefinition> = {
  // Beträge (CHF) — 1:1 auf PL_STRUCTURE-Zeilen-IDs
  net_revenue:        amountMetric("net_revenue"),
  total_cogs:         amountMetric("total_cogs"),
  total_cogs_einkauf: amountMetric("total_cogs_einkauf"),
  total_cogs_direct:  amountMetric("total_cogs_direct"),
  gross_profit_1:     amountMetric("gross_profit_1"),
  total_personnel:    amountMetric("total_personnel"),
  gross_profit_2:     amountMetric("gross_profit_2"),
  total_opex:         amountMetric("total_opex"),
  ebitda:             amountMetric("ebitda"),
  total_depreciation: amountMetric("total_depreciation"),
  ebit:               amountMetric("ebit"),
  // Quoten (%) — je Spalte aus denselben Rohbeträgen
  // WKQ = DIREKTER Warenaufwand (Konten 4020–4070) ÷ Betriebsertrag netto.
  // 4090/4701/4800 (übriger Warenaufwand) und 4900 (Lager) sind AUSGESCHLOSSEN —
  // identisch mit der P&L-Zeile «Direkter Warenaufwand» und dem Waren-Analyse-Modul.
  cogs_ratio:      ratioMetric("cogs_ratio",      "Warenkostenquote", "total_cogs_direct"),
  personnel_ratio: ratioMetric("personnel_ratio", "Personalquote",    "total_personnel"),
  ebitda_margin:   ratioMetric("ebitda_margin",   "EBITDA-Marge",     "ebitda"),
  ebit_margin:     ratioMetric("ebit_margin",     "EBIT-Marge",       "ebit"),
};

export const FINANCIAL_METRIC_IDS = Object.keys(FINANCIAL_METRICS) as FinancialMetricId[];

export function getFinancialMetric(id: FinancialMetricId): FinancialMetricDefinition {
  return FINANCIAL_METRICS[id];
}

/** Öffentliche API (Spezifikation): Definition einer Kennzahl. */
export function getFinancialMetricDefinition(id: FinancialMetricId): FinancialMetricDefinition {
  return FINANCIAL_METRICS[id];
}

/** Öffentliche API (Spezifikation): alle Kennzahl-Definitionen (stabile Reihenfolge). */
export function getAllFinancialMetricDefinitions(): FinancialMetricDefinition[] {
  return FINANCIAL_METRIC_IDS.map(id => FINANCIAL_METRICS[id]);
}

/** Bequemer Direktzugriff: Werte einer Kennzahl aus dem Registry-Input. */
export function getFinancialMetricValues(
  id: FinancialMetricId,
  input: FinancialMetricRegistryInput,
): FinancialMetricValues {
  return FINANCIAL_METRICS[id].getValues(input);
}

// ─── Abhängigkeits-Vollständigkeit (Dependency-Gate) ─────────────────────────
//
// Die P&L-Engine berechnet Ergebniszeilen (subtract) als Kette: fehlt eine
// Kostenkomponente, fliesst sie dort als 0 in die Zwischensumme ein — in der
// Erfolgsrechnung ist diese Ketten-Darstellung GEWOLLT (sichtbare Zeilen).
// Für Management-Flächen (Startseite/Dashboard/Exporte) gilt dagegen:
// fehlt eine erforderliche Komponente, ist die Kennzahl «—», NIE ein aus
// impliziten Nullen entstandener Scheinwert (z. B. EBIT ≡ Nettoumsatz, wenn
// nur Tagesumsätze, aber kein Kostenimport vorliegen).
//
// Die Abhängigkeitsstruktur ist Kennzahl-Wissen und lebt deshalb HIER
// (je Kennzahl GENAU EINE Definition) — `getValues` selbst bleibt unverändert
// (Erfolgsrechnung/PLView/bpl-aggregate konsumieren weiterhin die Kette).

/** Spalte der Registry-Werte. */
export type FinancialMetricColumn = keyof FinancialMetricValues;

/**
 * Erforderliche Basis-Komponenten je Kennzahl (leere Liste = Blatt-Wert,
 * bereits null-sicher über die hasActual-Guards der Engine-Summenzeilen).
 */
export const FINANCIAL_METRIC_DEPENDENCIES: Record<
  FinancialMetricId,
  ReadonlyArray<FinancialMetricId>
> = {
  net_revenue:        [],
  total_cogs:         [],
  total_cogs_einkauf: [],
  total_cogs_direct:  [],
  total_personnel:    [],
  total_opex:         [],
  total_depreciation: [],
  gross_profit_1:     ['net_revenue', 'total_cogs'],
  gross_profit_2:     ['net_revenue', 'total_cogs', 'total_personnel'],
  ebitda:             ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex'],
  ebit:               ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex', 'total_depreciation'],
  cogs_ratio:         ['total_cogs_direct', 'net_revenue'],
  personnel_ratio:    ['total_personnel', 'net_revenue'],
  ebitda_margin:      ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex'],
  ebit_margin:        ['net_revenue', 'total_cogs', 'total_personnel', 'total_opex', 'total_depreciation'],
};

/**
 * Fehlende Abhängigkeiten einer Kennzahl für EINE Spalte (rein lesend).
 * Leer = vollständig; die Spalte darf angezeigt werden.
 */
export function getFinancialMetricMissingDependencies(
  id: FinancialMetricId,
  input: FinancialMetricRegistryInput,
  column: FinancialMetricColumn,
): FinancialMetricId[] {
  return FINANCIAL_METRIC_DEPENDENCIES[id].filter(
    dep => getFinancialMetricValues(dep, input)[column] === null,
  );
}

/**
 * Registry-Werte mit Dependency-Gate, PRO SPALTE unabhängig: eine Spalte wird
 * nur geliefert, wenn ALLE erforderlichen Komponenten dieser Spalte vorhanden
 * sind — sonst null («—»). Keine Teilberechnung, keine impliziten Nullen.
 * Budget bleibt sichtbar, solange die Budget-Spalte selbst vollständig ist
 * (laufender Monat: vollständiges Monatsbudget als Kontext).
 */
export function getGatedFinancialMetricValues(
  id: FinancialMetricId,
  input: FinancialMetricRegistryInput,
): FinancialMetricValues {
  const raw = getFinancialMetricValues(id, input);
  const deps = FINANCIAL_METRIC_DEPENDENCIES[id];
  if (deps.length === 0) return raw;
  const gate = (column: FinancialMetricColumn): number | null =>
    deps.some(dep => getFinancialMetricValues(dep, input)[column] === null)
      ? null
      : raw[column];
  return { actual: gate('actual'), budget: gate('budget'), priorYear: gate('priorYear') };
}

/** Anzeige-Label einer Kennzahl (für «Noch nicht vollständig»-Hinweise). */
export function getFinancialMetricLabel(id: FinancialMetricId): string {
  return FINANCIAL_METRICS[id].label;
}
