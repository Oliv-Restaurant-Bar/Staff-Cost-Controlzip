/**
 * Lieferantendokumente – Typen
 * ==============================
 *
 * Zweck:
 *   Erfassung von Lieferscheinen und Rechnungen während des Monats
 *   als operative Schätzung der Warenkosten.
 *
 * Wichtige Regel:
 *   Diese Werte sind OPERATIVER NATUR und ersetzen NIEMALS die
 *   offiziellen Buchhaltungswerte aus dem PDF/CSV-Import.
 *   Die Buchhaltung hat immer Vorrang.
 *
 * Vergleichsstruktur:
 *   Operative Schätzung (Lieferantendokumente)
 *   vs.
 *   Buchhaltungsweite (aus PDF/CSV-Import, in reporting-store)
 *
 *   Diese Felder sind in CostComparisonRecord abgebildet und werden
 *   später in einer Vergleichs-UI dargestellt.
 */

// ─── Basisdokument ────────────────────────────────────────────────────────────

/**
 * Dokumenttyp des Lieferantenbelegs.
 */
export type DocumentType = 'delivery_note' | 'invoice';

/**
 * Warenkategorie – bestimmt in welche Kostenkategorie der Betrag fliesst.
 * food     → Wareneinsatz Küche (Konto 4000–4099)
 * beverage → Wareneinsatz Getränke (Konto 4100–4199)
 * other    → Sonstiger Wareneinsatz (Konto 4200–4299)
 */
export type DocumentCategory = 'food' | 'beverage' | 'other';

/**
 * Anzeigenamen für Dokumenttypen.
 */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  delivery_note: 'Lieferschein',
  invoice:       'Rechnung',
};

/**
 * Anzeigenamen für Warenkategorien.
 */
export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  food:     'Küche / Food',
  beverage: 'Getränke / Beverage',
  other:    'Diverses / Other',
};

/**
 * Farbklassen für Kategorien (Tailwind).
 */
export const CATEGORY_COLORS: Record<DocumentCategory, { bg: string; text: string; border: string }> = {
  food:     { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  beverage: { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200' },
  other:    { bg: 'bg-gray-50',   text: 'text-gray-700',   border: 'border-gray-200' },
};

// ─── Hauptdatensatz ───────────────────────────────────────────────────────────

/**
 * Ein einzelner Lieferantenbele (Lieferschein oder Rechnung).
 */
export interface SupplierDocument {
  /** UUID, eindeutige ID */
  id: string;
  /** Name des Lieferanten, z.B. 'Pistor AG', 'Transgourmet', 'Feldschlösschen' */
  supplier: string;
  /** Dokumenttyp */
  documentType: DocumentType;
  /** Belegdatum (ISO-String: YYYY-MM-DD) */
  date: string;
  /** Kalender-Jahr (aus date extrahiert, für schnelle Abfragen) */
  year: number;
  /** Kalender-Monat 1–12 (aus date extrahiert) */
  month: number;
  /** Warenkategorie */
  category: DocumentCategory;
  /**
   * Betrag in CHF (netto, ohne MwSt.).
   * Hinweis: Falls Bruttobetrag bekannt, muss der Anwender selbst
   * auf Netto umrechnen oder den Bruttobetrag eintragen
   * (wird im Reporting als operativer Schätzwert behandelt).
   */
  amount: number;
  /** Optionale Notiz, z.B. Bestellnummer, Kommentar */
  note?: string;
  /** Erstellt am (ISO-String) */
  createdAt: string;
  /** Zuletzt geändert (ISO-String) */
  updatedAt: string;
}

// ─── Monatliche Aggregation ───────────────────────────────────────────────────

/**
 * Aggregierte Zusammenfassung aller Lieferantendokumente eines Monats.
 * Wird zur Anzeige der operativen Warenkostenschätzung verwendet.
 */
export interface SupplierMonthSummary {
  year: number;
  month: number;
  /** Operative Schätzung Warenkosten Küche (CHF) */
  foodCost: number;
  /** Operative Schätzung Warenkosten Getränke (CHF) */
  beverageCost: number;
  /** Operative Schätzung Sonstiger Warenaufwand (CHF) */
  otherCost: number;
  /** Gesamte operative Warenkostenschätzung (CHF) */
  totalCost: number;
  /** Anzahl erfasster Belege */
  documentCount: number;
  /** Alle Dokumente für diesen Monat */
  documents: SupplierDocument[];
}

// ─── Buchhaltungsvergleich ────────────────────────────────────────────────────

/**
 * Vergleichsstruktur: Operative Lieferantendokumente vs. Buchhaltungswerte.
 *
 * Wichtige Regel:
 *   Buchhaltungswerte (accountingXxx) kommen IMMER aus dem reporting-store
 *   (PDF/CSV-Import). Sie dürfen NICHT durch Lieferantendokumente
 *   überschrieben oder verändert werden.
 *
 * Diese Struktur dient als Vorbereitung für eine spätere Vergleichs-UI,
 * die Abweichungen zwischen operativer Schätzung und Buchhaltungsabschluss
 * anzeigt.
 */
export interface CostComparisonRecord {
  year: number;
  month: number;

  // ── Operative Schätzwerte (Lieferantendokumente) ─────────────────────
  /** Operativer Wareneinsatz Küche (CHF, aus Lieferantendokumenten) */
  operationalFoodCost: number;
  /** Operativer Wareneinsatz Getränke (CHF) */
  operationalBeverageCost: number;
  /** Sonstiger operativer Warenaufwand (CHF) */
  operationalOtherCost: number;
  /** Gesamter operativer Warenaufwand (CHF) */
  operationalTotalCost: number;
  /** Anzahl Lieferantendokumente */
  documentCount: number;

  // ── Buchhaltungswerte (aus PDF/CSV-Import) ───────────────────────────
  /** Warenaufwand Küche laut Buchhaltung (CHF, undefined wenn noch kein Import) */
  accountingFoodCost?: number;
  /** Warenaufwand Getränke laut Buchhaltung (CHF) */
  accountingBeverageCost?: number;
  /** Gesamter Warenaufwand laut Buchhaltung (CHF) */
  accountingTotalCost?: number;

  // ── Abweichungen (positiv = operative Schätzung höher als Buchhaltung) ──
  /** Abweichung Küche: operational − accounting */
  diffFoodCost?: number;
  /** Abweichung Getränke: operational − accounting */
  diffBeverageCost?: number;
  /** Abweichung Total: operational − accounting */
  diffTotalCost?: number;
  /** Abweichung in Prozent: diffTotal / accountingTotal × 100 */
  diffTotalPct?: number;

  // ── Status ──────────────────────────────────────────────────────────
  /**
   * Wurde für diesen Monat bereits ein Buchhaltungsimport durchgeführt?
   * false = nur operative Schätzwerte vorhanden, noch kein Abschluss.
   */
  hasAccountingData: boolean;
}
