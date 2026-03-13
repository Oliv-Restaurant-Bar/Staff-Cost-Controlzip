/**
 * Budget-Modul – Datenstrukturen
 * ================================
 *
 * Konzept:
 *   Pro Budgetjahr gibt es eine Liste von BudgetPositionen.
 *   Jede Position hat 12 Monatswerte (Jan–Dez).
 *   Positionen können als CHF-Festbetrag ODER als %-Anteil am Umsatz definiert werden.
 *
 * Wichtigste Entscheidung pro Position:
 *   valueType = 'chf'     → monatlicher CHF-Betrag fix hinterlegt
 *   valueType = 'percent' → Wert = X % des budgetierten Monatsumsatzes
 *
 * Kompatibilität:
 *   Die positionIds sind auf die PLRowDef-IDs abgestimmt (pl.ts / pl-engine.ts),
 *   damit Budget-Werte direkt in der P&L-Ansicht verwendbar sind.
 *
 * localStorage-Schlüssel:  'budget_v1'
 */

// ─── Positions-Typen ──────────────────────────────────────────────────────────

/**
 * Kategorie einer Budgetposition – ausgerichtet auf die P&L-Struktur.
 */
export type BudgetCategory =
  | 'revenue'        // Umsatz (Ertrag)
  | 'food_cost'      // Wareneinsatz Küche (4000–4099)
  | 'beverage_cost'  // Wareneinsatz Bar / Getränke (4100–4199)
  | 'personnel'      // Personalkosten (Löhne, Sozialleistungen)
  | 'rent'           // Miete & Nebenkosten
  | 'energy'         // Energie & Wasser
  | 'marketing'      // Marketing & Werbung
  | 'insurance'      // Versicherungen
  | 'maintenance'    // Unterhalt & Reparaturen
  | 'other_cost';    // Sonstiges / Diverses

/**
 * Wie wird der Wert eines Monats berechnet?
 *
 *   'chf'     → Wert ist ein fixer CHF-Betrag (direkt aus monthlyValues)
 *   'percent' → Wert = monthlyValues[m] % × Umsatzbudget des gleichen Monats
 */
export type BudgetValueType = 'chf' | 'percent';

/**
 * Eine einzelne Budgetposition.
 * Deckt eine Zeile des P&L ab (z.B. "Wareneinsatz Küche", "Personalkosten", "Miete").
 */
export interface BudgetPosition {
  /** Eindeutiger Schlüssel – aligned auf PLRowDef.id wo möglich */
  id: string;
  /** Anzeigename */
  label: string;
  /** Kategorie (für Gruppierung und P&L-Mapping) */
  category: BudgetCategory;
  /**
   * Werttyp:
   *   'chf'     → monthlyValues enthält CHF-Beträge
   *   'percent' → monthlyValues enthält Prozentwerte (z.B. 30.5 = 30.5 %)
   */
  valueType: BudgetValueType;
  /**
   * 12 Werte (Index 0 = Januar, Index 11 = Dezember).
   * Bei valueType='chf':     CHF-Beträge
   * Bei valueType='percent': Prozentwerte (0–100)
   */
  monthlyValues: [number, number, number, number, number, number,
                  number, number, number, number, number, number];
  /**
   * Reihenfolge für die Anzeige in der Tabelle.
   * Kleinere Zahl = weiter oben.
   */
  sortOrder: number;
  /** Ist diese Position im P&L-Bericht ein Aufwand (negative = Kosten)? */
  isExpense: boolean;
}

// ─── Standardpositionen ───────────────────────────────────────────────────────

const ZERO_MONTHS: BudgetPosition['monthlyValues'] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Vordefinierte Budgetpositionen für oLiv Restaurant & Bar.
 * Ausgerichtet auf die P&L-Struktur in pl-engine.ts.
 *
 * Alle Startbeträge sind 0 – werden beim ersten Import oder durch
 * manuelle Eingabe befüllt.
 */
export const DEFAULT_BUDGET_POSITIONS: Omit<BudgetPosition, 'monthlyValues'>[] = [
  { id: 'budget_revenue',     label: 'Umsatz (Total)',        category: 'revenue',       valueType: 'chf',     sortOrder: 1,  isExpense: false },
  { id: 'budget_food_cost',   label: 'Wareneinsatz Küche',   category: 'food_cost',     valueType: 'percent', sortOrder: 10, isExpense: true  },
  { id: 'budget_bev_cost',    label: 'Wareneinsatz Bar',     category: 'beverage_cost', valueType: 'percent', sortOrder: 11, isExpense: true  },
  { id: 'budget_personnel',   label: 'Personalkosten',       category: 'personnel',     valueType: 'percent', sortOrder: 20, isExpense: true  },
  { id: 'budget_rent',        label: 'Miete & Nebenkosten',  category: 'rent',          valueType: 'chf',     sortOrder: 30, isExpense: true  },
  { id: 'budget_energy',      label: 'Energie & Wasser',     category: 'energy',        valueType: 'chf',     sortOrder: 31, isExpense: true  },
  { id: 'budget_marketing',   label: 'Marketing & Werbung',  category: 'marketing',     valueType: 'chf',     sortOrder: 32, isExpense: true  },
  { id: 'budget_insurance',   label: 'Versicherungen',       category: 'insurance',     valueType: 'chf',     sortOrder: 33, isExpense: true  },
  { id: 'budget_maintenance', label: 'Unterhalt & Reparatur',category: 'maintenance',   valueType: 'chf',     sortOrder: 34, isExpense: true  },
  { id: 'budget_other',       label: 'Sonstiges / Diverses', category: 'other_cost',    valueType: 'chf',     sortOrder: 35, isExpense: true  },
];

/** Erstellt eine BudgetPosition mit 0-Werten */
export function createDefaultPosition(
  def: Omit<BudgetPosition, 'monthlyValues'>,
): BudgetPosition {
  return { ...def, monthlyValues: [...ZERO_MONTHS] as BudgetPosition['monthlyValues'] };
}

// ─── Regeln / Rule Engine ─────────────────────────────────────────────────────

/**
 * Typen automatischer Budget-Anpassungsregeln.
 *
 *   increase_revenue_by_pct   → Umsatz aller / ausgewählter Monate um X % erhöhen
 *   set_cost_ratio            → Kostenstelle auf X % des Umsatzes setzen (valueType → percent)
 *   reduce_cost_by_pct        → Kosten-CHF-Position um X % reduzieren
 *   monthly_factor            → Einzelmonat mit Faktor multiplizieren
 *   monthly_fixed_override    → Einzelmonat mit fixem CHF-Wert überschreiben
 */
export type BudgetRuleType =
  | 'increase_revenue_by_pct'
  | 'set_cost_ratio'
  | 'reduce_cost_by_pct'
  | 'monthly_factor'
  | 'monthly_fixed_override';

/**
 * Eine automatische Budget-Anpassungsregel.
 *
 * Regeln werden beim Erstellen eines neuen Budgetjahres oder beim
 * manuellen «Regeln anwenden» ausgeführt.
 *
 * Reihenfolge:
 *   Regeln werden in der Reihenfolge ihrer Erstellung angewendet.
 *   Monatliche Overrides werden zuletzt angewendet (überschreiben alles).
 */
export interface BudgetRule {
  id: string;
  /** Typ der Regel */
  type: BudgetRuleType;
  /** Auf welche Budgetposition wirkt die Regel? */
  positionId: string;
  /**
   * Hauptwert der Regel:
   *   increase_revenue_by_pct  → Prozentsatz (z.B. 5.0 = +5 %)
   *   set_cost_ratio           → Ziel-Quote in % (z.B. 32.0 = 32 %)
   *   reduce_cost_by_pct       → Prozentsatz der Reduktion (z.B. 3.0 = -3 %)
   *   monthly_factor           → Faktor (z.B. 1.2 = +20 %)
   *   monthly_fixed_override   → CHF-Betrag
   */
  value: number;
  /**
   * Für monthly_factor / monthly_fixed_override:
   * Auf welchen Monat wirkt diese Regel? (1 = Januar, 12 = Dezember)
   * undefined = alle Monate
   */
  month?: number;
  /** Beschreibung der Regel für die Anzeige */
  description: string;
  /** Wann wurde die Regel erstellt? */
  createdAt: string;
}

// ─── Budget-Jahr ──────────────────────────────────────────────────────────────

/**
 * Das vollständige Budget für ein Jahr.
 * Enthält alle Positionen + Regeln für dieses Jahr.
 */
export interface BudgetYear {
  /** Jahreszahl, z.B. 2026 */
  year: number;
  /** Alle Budgetpositionen dieses Jahres (Legacy-Kompatibilität) */
  positions: BudgetPosition[];
  /** Automatische Anpassungsregeln */
  rules: BudgetRule[];
  /**
   * War dieses Budget das Ergebnis einer Jahr-Kopie?
   * undefined = manuell erstellt, number = Quell-Jahr
   */
  copiedFromYear?: number;
  /** Wurde das Budget durch eine Regel berechnet? */
  wasAutoCalculated: boolean;
  createdAt: string;
  updatedAt: string;

  /** P&L Struktur: Kategorien (optional – wird beim ersten Öffnen initialisiert) */
  plCategories?: BudgetPLCategory[];
  /** P&L Struktur: Einzelpositionen / Unterkonten */
  plLineItems?: BudgetPLLineItem[];
}

// ─── Berechnete Werte ─────────────────────────────────────────────────────────

/**
 * Berechnete Monatswerte einer Position.
 * 'chf'-Positionen geben direkt den Betrag zurück.
 * 'percent'-Positionen geben den berechneten CHF-Wert zurück
 * (basierend auf dem Umsatzbudget des gleichen Monats).
 */
export interface BudgetPositionResolved {
  position: BudgetPosition;
  /** 12 berechnete CHF-Werte (auch für 'percent'-Positionen) */
  resolvedCHF: [number, number, number, number, number, number,
                number, number, number, number, number, number];
  /** Jahrestotal (CHF) */
  totalCHF: number;
}

/**
 * Vollständig berechnetes Budget für ein Jahr.
 * Enthält alle Positionen mit CHF-Werten + berechnete Summen.
 */
export interface BudgetYearResolved {
  year: number;
  positions: BudgetPositionResolved[];
  /** Budgetierter Jahresumsatz */
  totalRevenueBudget: number;
  /** Budgetierter Gesamtaufwand */
  totalCostBudget: number;
  /** Budgetiertes Betriebsergebnis (Umsatz − Aufwand) */
  operatingResultBudget: number;
  /** Monatliche Umsatzwerte (CHF), Index 0 = Januar */
  monthlyRevenue: number[];
}

// ─── Monatsnamen ──────────────────────────────────────────────────────────────

export const BUDGET_MONTH_NAMES = [
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];

export const BUDGET_MONTH_NAMES_FULL = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// ─── P&L Strukturtypen (Budget-Erfolgsrechnung) ───────────────────────────────

/**
 * Ein P&L-Abschnitt (Hauptkategorie wie "Betriebsertrag", "Personal", etc.)
 * type='items'  → enthält einzelne Positionen (Zeilen)
 * type='result' → wird berechnet (Summenzeile / Zwischenergebnis)
 */
export interface BudgetPLCategory {
  id: string;
  label: string;
  type: 'items' | 'result';
  isExpense: boolean;
  sortOrder: number;
  color: 'green' | 'blue' | 'orange' | 'amber' | 'red' | 'gray' | 'purple';
  /** Nur für type='result': Welche Kategorien werden addiert/subtrahiert? */
  resultFormula?: Array<{ sign: 1 | -1; categoryId: string }>;
}

/**
 * Eine einzelne Budgetposition (Unterkategorie / Konto)
 * Gehört zu einer BudgetPLCategory.
 */
export interface BudgetPLLineItem {
  id: string;
  categoryId: string;
  accountNumber: string;
  label: string;
  valueType: 'chf' | 'percent';
  department?: 'küche' | 'service' | 'allgemein';
  monthlyValues: [number, number, number, number, number, number,
                  number, number, number, number, number, number];
  sortOrder: number;
  isDefault?: boolean;
}

// ─── Standard P&L Kategorien für oLiv ────────────────────────────────────────

export const DEFAULT_PL_CATEGORIES: BudgetPLCategory[] = [
  { id: 'pl_revenue',          label: 'Betriebsertrag netto',              type: 'items',  isExpense: false, sortOrder: 10, color: 'green'  },
  { id: 'pl_goods_cost',       label: 'Direkter Warenaufwand',             type: 'items',  isExpense: true,  sortOrder: 20, color: 'orange' },
  { id: 'pl_gross_1',          label: 'Bruttogewinn 1',                    type: 'result', isExpense: false, sortOrder: 30, color: 'green',
    resultFormula: [{ sign:  1, categoryId: 'pl_revenue' }, { sign: -1, categoryId: 'pl_goods_cost' }] },
  { id: 'pl_wages',            label: 'Löhne & Gehälter',                  type: 'items',  isExpense: true,  sortOrder: 40, color: 'blue'   },
  { id: 'pl_social',           label: 'Sozialleistungen',                  type: 'items',  isExpense: true,  sortOrder: 50, color: 'blue'   },
  { id: 'pl_personnel_other',  label: 'Übriger Personalaufwand',           type: 'items',  isExpense: true,  sortOrder: 60, color: 'blue'   },
  { id: 'pl_total_personnel',  label: 'Total Personal',                    type: 'result', isExpense: true,  sortOrder: 70, color: 'blue',
    resultFormula: [{ sign: 1, categoryId: 'pl_wages' }, { sign: 1, categoryId: 'pl_social' }, { sign: 1, categoryId: 'pl_personnel_other' }] },
  { id: 'pl_gross_2',          label: 'Bruttogewinn 2',                    type: 'result', isExpense: false, sortOrder: 80, color: 'green',
    resultFormula: [{ sign: 1, categoryId: 'pl_gross_1' }, { sign: -1, categoryId: 'pl_total_personnel' }] },
  { id: 'pl_rent',             label: 'Raumaufwand',                       type: 'items',  isExpense: true,  sortOrder: 90, color: 'gray'   },
  { id: 'pl_maintenance',      label: 'Unterhalt & Reinigung',             type: 'items',  isExpense: true,  sortOrder: 100, color: 'gray'  },
  { id: 'pl_admin',            label: 'Versicherungen / Verwaltung / Übriges', type: 'items', isExpense: true, sortOrder: 110, color: 'gray' },
  { id: 'pl_ebitda',           label: 'EBITDA / Betriebsergebnis',         type: 'result', isExpense: false, sortOrder: 120, color: 'purple',
    resultFormula: [
      { sign:  1, categoryId: 'pl_gross_2' },
      { sign: -1, categoryId: 'pl_rent' },
      { sign: -1, categoryId: 'pl_maintenance' },
      { sign: -1, categoryId: 'pl_admin' },
    ] },
];

// ─── Standard P&L Positionen (Unterkonten) ────────────────────────────────────

const Z12: BudgetPLLineItem['monthlyValues'] = [0,0,0,0,0,0,0,0,0,0,0,0];

export const DEFAULT_PL_LINE_ITEMS: Omit<BudgetPLLineItem, 'monthlyValues'>[] = [
  // Betriebsertrag
  { id: 'pli_wein',           categoryId: 'pl_revenue',         accountNumber: '3000', label: 'Wein',                       valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_bier',           categoryId: 'pl_revenue',         accountNumber: '3100', label: 'Bier',                       valueType: 'chf',     sortOrder: 2  },
  { id: 'pli_spirituosen',    categoryId: 'pl_revenue',         accountNumber: '3200', label: 'Spirituosen',                valueType: 'chf',     sortOrder: 3  },
  { id: 'pli_kueche_ertrag',  categoryId: 'pl_revenue',         accountNumber: '3300', label: 'Küche',                      valueType: 'chf',     sortOrder: 4,  department: 'küche'   },
  { id: 'pli_kaffee',         categoryId: 'pl_revenue',         accountNumber: '3400', label: 'Kaffee / Non-Alc',           valueType: 'chf',     sortOrder: 5  },

  // Warenaufwand
  { id: 'pli_waren_wein',     categoryId: 'pl_goods_cost',      accountNumber: '4000', label: 'Wein Warenaufwand',          valueType: 'percent', sortOrder: 1  },
  { id: 'pli_waren_bier',     categoryId: 'pl_goods_cost',      accountNumber: '4100', label: 'Bier Warenaufwand',          valueType: 'percent', sortOrder: 2  },
  { id: 'pli_waren_spirit',   categoryId: 'pl_goods_cost',      accountNumber: '4200', label: 'Spirituosen Warenaufwand',   valueType: 'percent', sortOrder: 3  },
  { id: 'pli_waren_mineral',  categoryId: 'pl_goods_cost',      accountNumber: '4300', label: 'Mineral / Softdrinks',       valueType: 'percent', sortOrder: 4  },
  { id: 'pli_waren_kueche',   categoryId: 'pl_goods_cost',      accountNumber: '4400', label: 'Küche Warenaufwand',         valueType: 'percent', sortOrder: 5,  department: 'küche'   },

  // Löhne
  { id: 'pli_lohn_fix',       categoryId: 'pl_wages',           accountNumber: '5000', label: 'Lohn Fix',                   valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_lohn_flex',      categoryId: 'pl_wages',           accountNumber: '5100', label: 'Lohn Flex',                  valueType: 'chf',     sortOrder: 2  },
  { id: 'pli_lohn_13',        categoryId: 'pl_wages',           accountNumber: '5200', label: '13. Monatslohn',             valueType: 'chf',     sortOrder: 3  },
  { id: 'pli_lohn_zulagen',   categoryId: 'pl_wages',           accountNumber: '5300', label: 'Lohn Zulagen',               valueType: 'chf',     sortOrder: 4  },

  // Sozialleistungen
  { id: 'pli_ahv',            categoryId: 'pl_social',          accountNumber: '5400', label: 'AHV / IV / EO / ALV',        valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_bvg',            categoryId: 'pl_social',          accountNumber: '5500', label: 'BVG / Pensionskasse',         valueType: 'chf',     sortOrder: 2  },
  { id: 'pli_uvg',            categoryId: 'pl_social',          accountNumber: '5600', label: 'UVG / Krankentaggeld',        valueType: 'chf',     sortOrder: 3  },

  // Übriger Personalaufwand
  { id: 'pli_weiterbildung',  categoryId: 'pl_personnel_other', accountNumber: '5700', label: 'Aus- und Weiterbildung',      valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_personalverpf',  categoryId: 'pl_personnel_other', accountNumber: '5800', label: 'Personalverpflegung / übriges', valueType: 'chf',  sortOrder: 2  },

  // Raumaufwand
  { id: 'pli_miete',          categoryId: 'pl_rent',            accountNumber: '6000', label: 'Miete',                      valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_nebenkosten',    categoryId: 'pl_rent',            accountNumber: '6100', label: 'Nebenkosten',                valueType: 'chf',     sortOrder: 2  },

  // Unterhalt
  { id: 'pli_unterhalt',      categoryId: 'pl_maintenance',     accountNumber: '6200', label: 'Unterhalt Gebäude/Einrichtung', valueType: 'chf',  sortOrder: 1  },
  { id: 'pli_reinigung',      categoryId: 'pl_maintenance',     accountNumber: '6300', label: 'Reinigung',                  valueType: 'chf',     sortOrder: 2  },

  // Versicherungen/Verwaltung
  { id: 'pli_versicherungen', categoryId: 'pl_admin',           accountNumber: '6400', label: 'Versicherungen',             valueType: 'chf',     sortOrder: 1  },
  { id: 'pli_verwaltung',     categoryId: 'pl_admin',           accountNumber: '6500', label: 'Verwaltungskosten',          valueType: 'chf',     sortOrder: 2  },
  { id: 'pli_uebrig_aufwand', categoryId: 'pl_admin',           accountNumber: '6600', label: 'Übriger Betriebsaufwand',    valueType: 'chf',     sortOrder: 3  },
];

export function createDefaultPLLineItem(
  def: Omit<BudgetPLLineItem, 'monthlyValues'>,
): BudgetPLLineItem {
  return { ...def, monthlyValues: [...Z12] as BudgetPLLineItem['monthlyValues'], isDefault: true };
}
