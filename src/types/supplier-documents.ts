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

// ─── Kostenzuordnung (Allocation) ─────────────────────────────────────────────

/**
 * Kostenpool-Zuordnung: Welchem Bereich gehört ein Einkauf?
 *
 * Wird am Lieferantendokument gesetzt und dient der Lunch-WES-Analyse:
 * Ist-WES = Summe aller Einkäufe mit Zuordnung zu einem Lunch-Pool.
 *
 * Wichtig: Nur für Analysen – ändert NICHT die Monatssummen (food/beverage/other).
 */
export type CostAllocationTarget =
  | 'lunch_basic'       // Tagesmenu Basic / Tagesmenu 1
  | 'lunch_premium'     // Tagesmenu Premium / Tagesmenu 2
  | 'a_la_carte'        // A-la-carte Küche
  | 'pizza'             // Pizza
  | 'dessert'           // Dessert / Patisserie
  | 'kinder'            // Kindermenu
  | 'kueche_allgemein'  // Allgemeine Küche (Mise en place, Grundstock)
  | 'beverage'          // Getränke
  | 'unassigned';       // Nicht zugeordnet (Standard)

/** Anzeigenamen für die UI */
export const ALLOCATION_TARGET_LABELS: Record<CostAllocationTarget, string> = {
  lunch_basic:      'Lunch Basic (Menu 1)',
  lunch_premium:    'Lunch Premium (Menu 2)',
  a_la_carte:       'À la carte',
  pizza:            'Pizza',
  dessert:          'Dessert',
  kinder:           'Kindermenu',
  kueche_allgemein: 'Allg. Küche / Mise en place',
  beverage:         'Getränke',
  unassigned:       'Nicht zugeordnet',
};

/** Alle Lunch-bezogenen Allocation-Targets (für Filterung in der Analyse) */
export const LUNCH_ALLOCATION_TARGETS: CostAllocationTarget[] = [
  'lunch_basic',
  'lunch_premium',
];

/**
 * Optionaler prozentualer Aufteilungseintrag.
 * Erlaubt z.B. 60% Lunch Basic, 40% À la carte für einen Einkauf.
 */
export interface AllocationSplit {
  target: CostAllocationTarget;
  /** Anteil in % (0–100). Alle Splits zusammen müssen 100 ergeben. */
  pct: number;
}

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

// ─── Lieferanten-Stammdaten ───────────────────────────────────────────────────

/**
 * Lieferanten-Stammdatensatz.
 * Wird einmalig angelegt und dann bei der Belegerfassung ausgewählt.
 * Gespeichert in localStorage 'supplier_master_v1'.
 */
export interface SupplierMaster {
  /** UUID */
  id: string;
  /** Lieferantenname (z.B. 'Pistor AG', 'Transgourmet') */
  name: string;
  /** Standard-Warenkategorie (wird im Formular vorbelegt) */
  defaultCategory?: DocumentCategory;
  /** Standard-Kontonummer 4-stellig (z.B. '4000') – wird im Formular vorbelegt */
  defaultAccountNumber?: string;
  /** Aktiv/Inaktiv – inaktive Lieferanten erscheinen nicht im Dropdown */
  isActive: boolean;
  /** Optionale Notiz (Kontaktdaten, Zahlungsziel, etc.) */
  note?: string;
  /** Erstellt am (ISO-String) */
  createdAt: string;
  /** Zuletzt geändert (ISO-String) */
  updatedAt: string;
}

// ─── Hauptdatensatz ───────────────────────────────────────────────────────────

/**
 * Verknüpfungs-Status: Lieferschein ↔ Rechnung
 *
 * 'linked'    – Dokument ist mit einem anderen Beleg verknüpft (kein Doppelzählung)
 * 'suggested' – Mögliche Übereinstimmung gefunden (manuell zu bestätigen)
 * undefined   – Kein Matching, wird normal gezählt
 */
export type DocumentMatchStatus = 'linked' | 'suggested';

/**
 * Ein einzelner Lieferantenbeleg (Lieferschein oder Rechnung).
 */
export interface SupplierDocument {
  /** UUID, eindeutige ID */
  id: string;
  /** Name des Lieferanten, z.B. 'Pistor AG', 'Transgourmet', 'Feldschlösschen' */
  supplier: string;
  /** Dokumenttyp */
  documentType: DocumentType;
  /**
   * Belegdatum (ISO-String: YYYY-MM-DD).
   * Pflichtfeld – Datum der Rechnung oder des Lieferscheins.
   */
  date: string;
  /**
   * Lieferdatum (ISO-String: YYYY-MM-DD, optional).
   *
   * Fallback-Logik für alle Berechnungen (Monatszuordnung, WES, Tracking):
   *   1. deliveryDate (wenn gesetzt) – Datum der tatsächlichen Warenlieferung
   *   2. date           – Belegdatum (Rechnungs- oder Lieferscheindatum)
   *
   * Wann nötig: Bei Rechnungen, die erst Wochen nach der Lieferung eintreffen.
   * Beispiel: Lieferung 30. März, Rechnung 5. April → deliveryDate = 30. März,
   *           damit der WES dem richtigen Monat (März) zugeordnet wird.
   */
  deliveryDate?: string;
  /**
   * Kalender-Jahr (aus effectiveDate extrahiert, für schnelle Abfragen).
   * effectiveDate = deliveryDate ?? date
   */
  year: number;
  /**
   * Kalender-Monat 1–12 (aus effectiveDate extrahiert).
   * effectiveDate = deliveryDate ?? date
   */
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
  /**
   * Zugeordnete 4-stellige Kontonummer aus dem Kontenplan (optional).
   * Z.B. '4000' = Warenaufwand Lebensmittel, '4001' = Warenaufwand Getränke.
   * Dient der Verbindung zwischen operativen Lieferantendokumenten
   * und dem offiziellen Buchhaltungskontenplan.
   */
  accountNumber?: string;
  /** Optionale Notiz, z.B. Bestellnummer, Kommentar */
  note?: string;

  // ── Duplikat-Prävention: Lieferschein ↔ Rechnung Matching ──────────────
  /**
   * ID des verknüpften Gegenstücks (Lieferschein ↔ Rechnung).
   *
   * Wenn gesetzt: Dieses Dokument ist mit dem Gegenstück verknüpft.
   * Regel: Verknüpfte Lieferscheine werden aus der Monatssumme ausgeschlossen
   * (die Rechnung zählt), um Doppelzählung zu vermeiden.
   */
  linkedDocumentId?: string;
  /**
   * Matching-Status für die UI.
   * 'linked'    – Manuell bestätigt verknüpft → Lieferschein aus Summe ausgeschlossen
   * 'suggested' – Automatisch gefundene mögliche Übereinstimmung → manuell bestätigen
   */
  matchStatus?: DocumentMatchStatus;
  /**
   * Referenznummer des Dokuments (Lieferschein-Nr., Rechnungs-Nr., Bestellnummer).
   * Kann beim Matching als zusätzliches Signal verwendet werden.
   */
  referenceNumber?: string;

  // ── Kostenzuordnung (Allocation) – nur für Analyse, kein Einfluss auf Summen ──
  /**
   * Haupt-Kostenpool für diesen Beleg.
   * Wenn `allocationSplits` gesetzt, wird dieses Feld ignoriert.
   * Default: 'unassigned' (kein Pool zugeordnet).
   */
  allocationTarget?: CostAllocationTarget;
  /**
   * Prozentuale Aufteilung auf mehrere Kostenpools (optional).
   * Wenn gesetzt: übersteuert `allocationTarget`.
   * Alle Einträge müssen zusammen 100% ergeben.
   *
   * Beispiel: 60% Lunch Basic, 40% À la carte
   */
  allocationSplits?: AllocationSplit[];

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

// ─── Architektur-Vorbereitung: Lieferantenvergleich pro Lieferant ─────────────

/**
 * Vorbereitung für ein späteres Modul «Lieferantenvergleich».
 *
 * Ziel des späteren Moduls:
 *   Lieferscheine / Rechnungen pro Lieferant
 *   vs.
 *   Buchhaltungskosten aus PDF/CSV-Import
 *   → Abweichung pro Lieferant und Kategorie
 *
 * Diese Strukturen sind noch nicht in der UI eingebunden.
 * Sie definieren nur das Datenmodell für die spätere Implementierung.
 *
 * Wichtige Regel (gilt auch hier):
 *   Buchhaltungswerte sind immer die offiziellen Werte.
 *   Lieferantendokumente ersetzen niemals Buchhaltungswerte.
 */

/**
 * Aggregierte Kosten eines einzelnen Lieferanten für einen Monat.
 * Wird aus den SupplierDocuments berechnet.
 */
export interface SupplierCostSummary {
  /** Name des Lieferanten */
  supplier: string;
  /** Monat (1–12) */
  month: number;
  /** Jahr */
  year: number;
  /** Gesamtkosten Food (CHF, aus Lieferantendokumenten) */
  foodCost: number;
  /** Gesamtkosten Getränke (CHF) */
  beverageCost: number;
  /** Gesamtkosten Diverses (CHF) */
  otherCost: number;
  /** Gesamtkosten Total (CHF) */
  totalCost: number;
  /** Anzahl Belege */
  documentCount: number;
  /** Lieferscheine */
  deliveryNoteCount: number;
  /** Rechnungen */
  invoiceCount: number;
}

/**
 * Vergleich eines Lieferanten: Lieferantendokumente vs. Buchhaltungsanteil.
 *
 * Hinweis zur Buchhaltungsseite:
 *   Die Buchhaltung kennt keine «Lieferantennamen» in den Kontozeilen –
 *   sie gruppiert nur nach Kontonummer (4000–4999 Warenaufwand).
 *   Eine automatische Zuordnung «Pistor AG → Konto 4010» muss später
 *   manuell konfiguriert werden (AccountToSupplierMapping).
 *
 *   Ohne diese Konfiguration zeigt der Vergleich nur die operative Seite.
 */
export interface SupplierCostComparison {
  supplier: string;
  month: number;
  year: number;
  /** Operative Seite: Summe aus Lieferantendokumenten */
  operationalTotal: number;
  operationalFoodCost: number;
  operationalBeverageCost: number;
  operationalOtherCost: number;
  /**
   * Buchhaltungsseite: anteiliger Buchhaltungswert für diesen Lieferanten.
   * undefined solange keine Konto→Lieferant-Zuordnung konfiguriert ist.
   */
  accountingTotal?: number;
  /** Abweichung: operational − accounting */
  diff?: number;
  /** Abweichung in Prozent */
  diffPct?: number;
  /** true wenn Buchhaltungsdaten vorhanden und Zuordnung konfiguriert */
  hasAccountingData: boolean;
}

/**
 * Konfigurationseintrag: ordnet einem Lieferantennamen eine Kontonummer zu.
 * Wird für die spätere automatische Zuordnung in SupplierCostComparison benötigt.
 * Gespeichert in localStorage 'supplier_account_mapping_v1'.
 *
 * Beispiel:
 *   { supplier: 'Pistor AG', accountId: '4010', category: 'food' }
 *   { supplier: 'Feldschlösschen', accountId: '4100', category: 'beverage' }
 */
export interface AccountToSupplierMapping {
  /** Lieferantenname (exakt wie im SupplierDocument) */
  supplier: string;
  /**
   * Buchhaltungs-Kontonummer (4-stellig, z.B. '4010')
   * oder Bereich-ID (z.B. 'wareneinsatz_kueche')
   */
  accountId: string;
  category: DocumentCategory;
  /** Optionaler Prozentsatz des Kontos der diesem Lieferanten zugeordnet wird (0–100) */
  allocationPct?: number;
}
