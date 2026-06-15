/**
 * Reporting / Finanzmodul – Datenstrukturen
 * ==========================================
 *
 * Kernprinzip: Ein Datensatz pro Monat ("MonthlyFinancialRecord").
 * Jeder Datensatz hat eine eindeutige ID ("YYYY-MM") – damit sind
 * Duplikate technisch ausgeschlossen.
 *
 * Import-Konzept (für spätere Implementierung):
 *   Modus "replace" – kompletten Monat überschreiben
 *   Modus "update"  – nur geänderte Felder mergen, Rest bleibt
 *
 * Alle Felder sind optional, damit ein Monat schrittweise befüllt
 * werden kann (zuerst Umsatz, später Buchhaltungsdaten usw.).
 */

// ─── Ausgabenkategorie ────────────────────────────────────────────────────────

/**
 * Eine einzelne Kostenkategorie aus der Buchhaltung.
 * z.B. Wareneinsatz, Miete, Energie, Marketing, Versicherung, …
 *
 * Für Vorjahreswerte wird dieselbe Struktur verwendet, damit der
 * Code-Aufwand für Vergleiche minimal bleibt.
 */
export interface ExpenseCategory {
  /** Eindeutiger Schlüssel pro Kategorie, z.B. "wareneinsatz" */
  categoryId: string;
  /** Anzeigename, z.B. "Wareneinsatz Küche" */
  label: string;
  /** Betrag in CHF */
  amount: number;
}

// ─── Standard-Kategorien ─────────────────────────────────────────────────────

/**
 * Vordefinierte Ausgabenkategorien für oLiv Restaurant & Bar.
 * Können im Einstellungsmodul später erweitert werden.
 *
 * Diese Liste dient nur als Startwert – echte Kategorien kommen
 * aus dem hochgeladenen Buchhaltungsexport.
 */
export const DEFAULT_EXPENSE_CATEGORIES: Omit<ExpenseCategory, 'amount'>[] = [
  { categoryId: 'wareneinsatz_kueche',   label: 'Wareneinsatz Küche' },
  { categoryId: 'wareneinsatz_bar',      label: 'Wareneinsatz Bar/Getränke' },
  { categoryId: 'miete',                 label: 'Miete & Nebenkosten' },
  { categoryId: 'energie',               label: 'Energie & Wasser' },
  { categoryId: 'marketing',             label: 'Marketing & Werbung' },
  { categoryId: 'versicherung',          label: 'Versicherungen' },
  { categoryId: 'unterhalt',             label: 'Unterhalt & Reparaturen' },
  { categoryId: 'sonstiges',             label: 'Sonstiges' },
];

// ─── Import-Protokolleintrag ──────────────────────────────────────────────────

/**
 * Jeder Datenimport wird protokolliert.
 * So ist nachvollziehbar, woher die Zahlen kommen und was wann
 * überschrieben wurde.
 *
 * Import-Modi:
 *   "replace" → kompletten Monatsdatensatz ersetzen (keine Vorjahresdaten)
 *   "update"  → nur die mitgelieferten Felder aktualisieren (Rest bleibt)
 */
export type ImportMode = 'replace' | 'update';

export type ImportSource =
  | 'manual'            // Manuelle Eingabe im UI
  | 'pdf_current'       // PDF-Import: laufendes Geschäftsjahr
  | 'pdf_previous_year' // PDF-Import: Vorjahresdaten
  | 'csv_current'       // CSV-Import: laufendes Jahr
  | 'csv_previous_year' // CSV-Import: Vorjahr
  | 'gastronovi'        // Zukünftig: Umsatz-Import aus gastronovi-Kassensystem
  | 'supabase_sync';    // Zukünftig: Sync aus Supabase-Tabelle

export interface ImportRecord {
  /** UUID des Import-Vorgangs */
  importId: string;
  /** Zeitpunkt des Imports (ISO-String) */
  importedAt: string;
  /** Herkunft der Daten */
  source: ImportSource;
  /** Importmodus */
  mode: ImportMode;
  /** Dateiname (bei PDF/CSV) */
  fileName?: string;
  /**
   * Welche Felder wurden durch diesen Import geändert?
   * Ermöglicht gezieltes Rückgängigmachen in einem späteren Schritt.
   */
  affectedFields: (keyof MonthlyFinancialRecord)[];
  /** Freitext-Notiz zum Import */
  note?: string;
}

// ─── Monats-Kerndatensatz ─────────────────────────────────────────────────────

/**
 * Der zentrale Datensatz pro Monat.
 * ID ist immer "YYYY-MM", z.B. "2026-03" → macht Duplikate unmöglich.
 *
 * Fehlende Werte (undefined) bedeuten: noch nicht erfasst.
 * Das ermöglicht schrittweise Befüllung.
 */
export interface MonthlyFinancialRecord {
  /** Eindeutiger Schlüssel: "YYYY-MM" */
  id: string;
  year: number;
  /** 1 = Januar, 12 = Dezember */
  month: number;

  // ── Umsatz ─────────────────────────────────────────────────────────
  /** Tatsächlicher Umsatz (CHF) */
  revenueActual?: number;
  /** Geplanter Umsatz / Budget (CHF) */
  revenueBudget?: number;
  /** Umsatz Vorjahr (CHF) – gleicher Monat */
  revenuePreviousYear?: number;
  /**
   * Manuell eingegebener Bruttoumsatz (CHF, inkl. MwSt).
   * Dient als Kontrollwert für den Abgleich mit Nettoumsatz (Erfolgsrechnung)
   * und der Summe der Tagesumsätze (Tagesansicht / Tagescontrolling).
   */
  grossRevenueManual?: number;
  /**
   * Manuell erfasster Take-Away-Umsatz (CHF, Brutto inkl. 2.6 % MwSt).
   * Wird für die Umsatzabstimmung separat ausgewiesen, da der reduzierte
   * MwSt-Satz (2.6 %) gilt.
   */
  takeAwayGrossManual?: number;

  // ── Personalkosten ──────────────────────────────────────────────────
  /** Tatsächliche Personalkosten (CHF) – aus Lohnlauf */
  personnelCostActual?: number;
  /** Geplante Personalkosten (CHF) – aus Dienstplan-Kalkulation */
  personnelCostPlanned?: number;
  /** Personalkosten Vorjahr (CHF) */
  personnelCostPreviousYear?: number;

  // ── Ausgabenkategorien laufendes Jahr ───────────────────────────────
  /**
   * Buchhaltungsdaten aus dem laufenden Geschäftsjahr.
   * Kommen aus PDF-/CSV-Import oder manueller Erfassung.
   */
  expenseCategories: ExpenseCategory[];

  // ── Ausgabenkategorien Vorjahr ──────────────────────────────────────
  /**
   * Vorjahresdaten für denselben Monat.
   * Werden separat importiert (eigenes PDF/Export).
   * Gleiche Struktur wie expenseCategories → einfaches Vergleichen.
   */
  expenseCategoriesPreviousYear: ExpenseCategory[];

  // ── Import-Protokoll ────────────────────────────────────────────────
  /**
   * Vollständige Importhistorie für diesen Monat.
   * Jeder Import (manuell oder PDF) wird hier eingetragen.
   * Ermöglicht Rückverfolgung und Duplikaterkennung.
   */
  imports: ImportRecord[];

  // ── Metadaten ───────────────────────────────────────────────────────
  createdAt: string;
  updatedAt: string;
}

// ─── Jahresübersicht ──────────────────────────────────────────────────────────

/**
 * Aggregierte Jahreswerte, aus MonthlyFinancialRecord[] berechnet.
 * Wird nicht gespeichert – immer zur Laufzeit aus Monatsdaten berechnet.
 */
export interface AnnualSummary {
  year: number;
  totalRevenueActual: number;
  totalRevenueBudget: number;
  totalRevenuePreviousYear: number;
  totalPersonnelCostActual: number;
  totalPersonnelCostPlanned: number;
  /** Personalkosten-Quote (actual / revenue actual) */
  personnelCostRatio: number;
  /** Anzahl Monate mit vollständigen Daten */
  monthsWithData: number;
}

// ─── Datenvollständigkeit pro Monat ──────────────────────────────────────────

/**
 * Zeigt an, welche Datentypen für einen Monat vorhanden sind.
 * Nützlich für die Übersichtstabelle im Reporting-Dashboard.
 */
export interface MonthDataCompleteness {
  hasRevenue: boolean;
  hasPersonnelCosts: boolean;
  hasExpenses: boolean;
  hasPreviousYearData: boolean;
  hasImports: boolean;
  /** Gesamtvollständigkeit in Prozent (0–100) */
  completenessPercent: number;
}

export function calcCompleteness(r: MonthlyFinancialRecord): MonthDataCompleteness {
  const hasRevenue         = r.revenueActual !== undefined;
  const hasPersonnelCosts  = r.personnelCostActual !== undefined;
  const hasExpenses        = r.expenseCategories.length > 0;
  const hasPreviousYearData = r.revenuePreviousYear !== undefined || r.expenseCategoriesPreviousYear.length > 0;
  const hasImports         = r.imports.length > 0;

  const flags = [hasRevenue, hasPersonnelCosts, hasExpenses, hasPreviousYearData];
  const completenessPercent = Math.round(
    (flags.filter(Boolean).length / flags.length) * 100,
  );

  return { hasRevenue, hasPersonnelCosts, hasExpenses, hasPreviousYearData, hasImports, completenessPercent };
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/** Erzeugt die eindeutige ID für einen Monat */
export function monthId(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Erstellt einen leeren Monats-Datensatz */
export function createEmptyMonth(year: number, month: number): MonthlyFinancialRecord {
  const now = new Date().toISOString();
  return {
    id:    monthId(year, month),
    year,
    month,
    expenseCategories:             [],
    expenseCategoriesPreviousYear: [],
    imports:                       [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Deutsche Monatsnamen */
// ─── Sage Buchungszeile (Einzelbuchung) ──────────────────────────────────────

/**
 * Eine einzelne Buchungszeile aus einem Sage-Import (Kontoblatt / Journal).
 * Gespeichert unter 'sage_journal_v1_{year}_{month}' in localStorage.
 */
export interface SageJournalEntry {
  /** Buchungsdatum als String "DD.MM.YYYY" */
  date: string;
  /** Belegnummer / Referenz (optional) */
  belegNr?: string;
  /** Buchungstext / Beschreibung */
  text: string;
  /** Kontonummer (4-stellig, mit führenden Nullen) */
  accountNumber: string;
  /** Kontobezeichnung */
  accountName: string;
  /** Soll-Betrag (CHF, 0 wenn nicht vorhanden) */
  soll: number;
  /** Haben-Betrag (CHF, 0 wenn nicht vorhanden) */
  haben: number;
  /** Netto-Betrag (absoluter Wert, immer positiv) */
  amount: number;
}

export const MONTH_NAMES_DE = [
  '', // Index 0 leer lassen
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export const MONTH_NAMES_SHORT_DE = [
  '',
  'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
];
