/**
 * P&L / Erfolgsrechnung – Typen
 * ================================
 *
 * Diese Typen beschreiben:
 *   1. Die statische Zeilenstruktur des P&L (PLRowDef)
 *   2. Die berechneten Werte pro Zeile (PLRowValues, PLComputedRow)
 *   3. Das vollständige P&L-Ergebnis für einen Monat oder ein Jahr
 *
 * Datenfluss:
 *   MonthlyFinancialRecord[]  →  pl-engine  →  PLResult
 *
 * Die Zeilendefinitionen (PL_STRUCTURE) sind fest kodiert nach dem
 * Schweizer Gastronomie-GuV-Schema. Die Werte werden zur Laufzeit
 * aus den Monatsdaten berechnet.
 */

// ─── Zeilen-Typen ─────────────────────────────────────────────────────────────

/**
 * section       → Abschnittsüberschrift (z.B. "PERSONAL")
 * line          → Einzelposition (z.B. "Wareneinsatz Küche")
 * subtotal      → Zwischensumme (z.B. "Total Warenaufwand")
 * result        → Zwischenergebnis / berechnete Zeile (z.B. "Bruttogewinn 1")
 * percent_line  → Prozentkennzahl unter einem Ergebnis (z.B. "% vom Umsatz")
 * spacer        → Leerzeile zur optischen Trennung
 */
export type PLRowType = 'section' | 'line' | 'subtotal' | 'result' | 'percent_line' | 'spacer';

/** Wie ist der Wert zu interpretieren? */
export type PLValueRole = 'positive' | 'negative'; // positive = Ertrag, negative = Aufwand

/**
 * Definition einer P&L-Zeile.
 * Diese Daten sind statisch – sie beschreiben die Struktur des P&L.
 */
export interface PLRowDef {
  /** Eindeutiger Schlüssel der Zeile */
  id: string;
  /** Anzeigetyp */
  type: PLRowType;
  /** Beschriftung in der Tabelle */
  label: string;
  /** Einrücktiefe (0 = Abschnitt, 1 = Position, 2 = Unterposition) */
  indent: number;
  /** Soll % vom Umsatz berechnet und angezeigt werden? */
  showPercent: boolean;
  /**
   * Für type='line': welche categoryIds aus expenseCategories werden summiert?
   * Leer = keine direkte Kategorienzuordnung.
   */
  categoryIds?: string[];
  /**
   * Für type='line': direktes Feld aus MonthlyFinancialRecord.
   * Überschreibt categoryIds wenn gesetzt.
   */
  directField?: 'revenue' | 'personnel_actual' | 'personnel_planned' | 'personnel_py';
  /**
   * Für type='subtotal': welche Zeilen-IDs werden summiert?
   * Für type='result': Formel { base, subtract }
   * Für type='percent_line': Zeile für Dividend und Divisor
   */
  computedFrom?: PLFormula;
  /** Vorzeichen in der Darstellung: positive = Ertrag (grün), negative = Aufwand (rot) */
  valueRole?: PLValueRole;
}

/** Formel für berechnete Zeilen */
export interface PLFormula {
  /** Typ der Formel */
  type: 'sum' | 'subtract' | 'percent';
  /**
   * Für sum:      IDs der zu summierenden Zeilen
   * Für subtract: [0] = Minuend, [1..n] = Subtrahenden
   * Für percent:  [0] = Dividend (Wert), [1] = Divisor (Umsatz)
   */
  rowIds: string[];
}

// ─── Berechnete Werte ─────────────────────────────────────────────────────────

/**
 * Werte-Tupel für eine P&L-Zeile.
 * undefined = kein Wert vorhanden (noch nicht erfasst).
 */
export interface PLCellValues {
  actual?: number;      // Ist
  budget?: number;      // Budget / Plan
  prevYear?: number;    // Vorjahr
  vsBudget?: number;    // Abweichung Ist vs. Budget (absolut, CHF)
  vsBudgetPct?: number; // Abweichung Ist vs. Budget (%)
  vsPrevYear?: number;  // Abweichung Ist vs. Vorjahr (absolut, CHF)
  vsPrevYearPct?: number; // Abweichung Ist vs. Vorjahr (%)
}

/** Vollständige berechnete P&L-Zeile (Definition + Werte) */
export interface PLComputedRow {
  def: PLRowDef;
  values: PLCellValues;
  /**
   * Quelldaten für den Drilldown: welche Kategorien haben zu dieser Zeile beigetragen?
   */
  sourceCategories: PLSourceCategory[];
}

/**
 * Quelldaten für den Drilldown-Dialog.
 * Zeigt, aus welchen konkreten Buchhaltungspositionen ein P&L-Wert stammt.
 */
export interface PLSourceCategory {
  categoryId: string;
  label: string;
  actualAmount: number;
  prevYearAmount?: number;
  sourceType: 'manual_entry' | 'csv_import' | 'direct_field';
  /** Welcher Monat lieferte diesen Wert (z.B. "2026-03") */
  monthId: string;
}

/** P&L-Ergebnis für einen einzelnen Monat */
export interface PLMonthResult {
  year: number;
  month: number;
  monthId: string;
  rows: PLComputedRow[];
  /** Hat dieser Monat überhaupt Daten? */
  hasData: boolean;
}

/** P&L-Jahresübersicht: alle 12 Monate nebeneinander + Summe */
export interface PLYearResult {
  year: number;
  /** Pro Monat (Index 0 = Januar) */
  months: PLMonthResult[];
  /** Jahressumme (alle Monate kumuliert) */
  total: PLMonthResult;
}

// ─── Drilldown ────────────────────────────────────────────────────────────────

/** Was der Drilldown-Dialog anzeigt */
export interface PLDrilldown {
  rowId: string;
  rowLabel: string;
  month?: number;   // null = Jahresansicht
  year: number;
  /** Zeilenwerte auf Übersichtsebene */
  values: PLCellValues;
  /** Einzelne Kategorien, die zu diesem Wert beigetragen haben */
  sources: PLSourceCategory[];
}
