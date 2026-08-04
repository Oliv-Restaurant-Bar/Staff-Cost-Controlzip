/**
 * Kontenmapping – Typen für die P&L-Logik
 * ==========================================
 *
 * Zweck:
 *   Wenn Buchhaltungsdaten (CSV/PDF) importiert werden, muss jede
 *   4-stellige Kontonummer automatisch der richtigen P&L-Position
 *   und dem richtigen Zwischenergebnis-Abschnitt zugeordnet werden.
 *
 * Aufbau:
 *   AccountMapping  → ein einzelnes Konto mit allen Zuordnungen
 *   PLCategory      → betriebswirtschaftliche Kategorie (z.B. "Speiseumsatz")
 *   PLSection       → Zwischenergebnis-Abschnitt (z.B. "Rohgewinn 1")
 *   AccountSign     → ob Soll- oder Haben-Konto (bestimmt Vorzeichen im P&L)
 *   DepartmentHint  → Abteilungs-Hinweis für spätere Kostenstellen-Aufteilung
 *
 * Matching-Logik (für späteren Import):
 *   1. Exakter Treffer: Kontonummer "3000" → direkte Zuordnung
 *   2. Bereichstreffer:  "3000–3099" → alle Speiseumsatz-Konten
 *   3. Kein Treffer:    → Import fragt nach manueller Zuordnung
 *      (Ergebnis wird als neue Mapping-Regel gespeichert)
 */

// ─── Abteilungs-Hinweis ───────────────────────────────────────────────────────

/**
 * Ordnet ein Konto einer Abteilung zu.
 * Nützlich für spätere Kostenstellen-Berichte.
 *
 *   kitchen  → Küche / Speisen (z.B. Warenaufwand Lebensmittel)
 *   service  → Service / Bar / Getränke (z.B. Getränkeumsatz)
 *   general  → Allgemeine Kosten ohne Abteilungszugehörigkeit (Miete, Strom…)
 *   admin    → Verwaltung (Buchhaltung, Beratung, Büro…)
 *   null     → noch nicht zugeordnet / manuell klären
 */
export type DepartmentHint = 'kitchen' | 'service' | 'general' | 'admin' | null;

// ─── P&L-Kategorien ──────────────────────────────────────────────────────────

/**
 * Betriebswirtschaftliche Kategorie für eine Kontonummer.
 * Bestimmt, wo der Betrag im P&L erscheint.
 *
 * Jede Kategorie gehört zu genau einem PLSection.
 */
export type PLCategory =
  // Umsatz
  | 'revenue_food'          // Speiseumsatz
  | 'revenue_beverage'      // Getränke-/Barumsatz
  | 'revenue_catering'      // Bankett / Catering
  | 'revenue_other'         // Sonstiger Umsatz
  // Wareneinsatz
  | 'cogs_food'             // Warenaufwand Küche/Lebensmittel
  | 'cogs_beverage'         // Warenaufwand Getränke
  | 'cogs_other'            // Warenaufwand Diverses
  | 'cogs_lager'            // Veränderung Warenvorrat (Lagerveränderung, 4900) — Teil des Wareneinsatzes, NICHT des Wareneinkaufs
  // Personalkosten
  | 'personnel_kitchen'     // Löhne Küche
  | 'personnel_service'     // Löhne Service
  | 'personnel_admin'       // Löhne Verwaltung
  | 'personnel_social'      // Sozialabgaben (AHV, BVG, UVG…)
  | 'personnel_other'       // Sonstige Personalkosten (Ausbildung…)
  // Betriebskosten
  | 'rent'                  // Miete
  | 'utilities'             // Energie & Wasser
  | 'cleaning'              // Reinigung & Hygiene
  | 'maintenance'           // Unterhalt & Reparaturen
  | 'insurance'             // Versicherungen
  | 'marketing'             // Marketing & Werbung
  | 'admin_costs'           // Verwaltungskosten (Buchhaltung, Beratung…)
  | 'office'                // Büro & Kommunikation
  | 'bank_fees'             // Bankgebühren & Zahlungsverkehr
  | 'other_operating'       // Diverses Betrieblich
  // Abschreibungen
  | 'depreciation'          // Abschreibungen
  // Nicht zugeordnet (temporär)
  | 'unmapped';             // Noch keine Zuordnung

// ─── P&L-Zwischenergebnisse ───────────────────────────────────────────────────

/**
 * Abschnitt im P&L-Schema.
 * Bestimmt, in welchem Bereich das Konto addiert/subtrahiert wird.
 *
 * Reihenfolge entspricht dem typischen Restaurant-GuV-Schema:
 *
 *   Nettoumsatz
 *   – Wareneinsatz
 *   = Rohgewinn 1
 *   – Personalkosten
 *   = Rohgewinn 2 / Deckungsbeitrag
 *   – Betriebskosten
 *   = EBITDA
 *   – Abschreibungen
 *   = Betriebsergebnis (EBIT)
 */
export type PLSection =
  | 'net_revenue'       // Nettoumsatz
  | 'cogs'              // Wareneinsatz (Cost of Goods Sold)
  | 'gross_profit_1'    // Zwischenergebnis: Rohgewinn 1 (Nettoumsatz − Wareneinsatz)
  | 'personnel'         // Personalkosten
  | 'gross_profit_2'    // Zwischenergebnis: Deckungsbeitrag (RG1 − Personalkosten)
  | 'operating_expenses'// Betriebskosten
  | 'ebitda'            // Zwischenergebnis: EBITDA
  | 'depreciation_section' // Abschreibungen
  | 'operating_result'; // Zwischenergebnis: Betriebsergebnis (EBIT)

/** Vorzeichen: Bestimmt ob der Betrag addiert (+) oder subtrahiert (−) wird */
export type AccountSign = 'income' | 'expense';

// ─── Einzelkonto-Mapping ──────────────────────────────────────────────────────

export interface AccountMapping {
  /** 4-stellige Kontonummer als String, z.B. "3000" */
  accountNumber: string;
  /** Kontobezeichnung, z.B. "Speiseumsatz" */
  accountName: string;
  /** Betriebswirtschaftliche P&L-Kategorie */
  plCategory: PLCategory;
  /**
   * P&L-Abschnitt, in dem dieses Konto aggregiert wird.
   * Kann auch ein Zwischenergebnis sein (wird dann berechnet, nicht direkt gebucht).
   */
  plSection: PLSection;
  /** Abteilungs-Hinweis für Kostenstellen-Berichte */
  department: DepartmentHint;
  /**
   * Vorzeichen: Umsatzkonten sind 'income', Aufwandskonten 'expense'.
   * Bestimmt ob der Betrag im P&L positiv oder negativ erscheint.
   */
  sign: AccountSign;
  /** Kann dieses Mapping während einem Import manuell übersteuert werden? */
  canOverride: boolean;
  /** Ist dieses Mapping aktiv? (false = wird ignoriert) */
  isActive: boolean;
  /**
   * Herkunft: 'default' = Standardmapping, 'custom' = vom Admin angepasst.
   * 'custom' überschreibt immer 'default'.
   */
  source: 'default' | 'custom';
  /** Optionale Notiz (z.B. "Früher Konto 3010 bei altem System") */
  notes?: string;
}

// ─── Konto-Bereich (Range) ────────────────────────────────────────────────────

/**
 * Definiert einen Kontonummern-Bereich, der automatisch einer PLCategory zugeordnet wird.
 * Nützlich für "catch-all"-Regeln wenn keine exakte Kontonummer bekannt.
 *
 * Beispiel: { from: '3000', to: '3099', plCategory: 'revenue_food' }
 * → Alle Konten 3000–3099 werden als Speiseumsatz behandelt, sofern kein
 *   exaktes Mapping existiert.
 */
export interface AccountRange {
  from: string;
  to: string;
  plCategory: PLCategory;
  plSection: PLSection;
  department: DepartmentHint;
  sign: AccountSign;
  description: string;
}

// ─── P&L-Abschnitt-Definition ─────────────────────────────────────────────────

export interface PLSectionDef {
  id: PLSection;
  label: string;
  description: string;
  /** Ist dies ein berechnetes Zwischenergebnis? (wird nicht direkt gebucht) */
  isCalculated: boolean;
  /** Farbe für die UI-Darstellung */
  color: string;
  /** Reihenfolge im P&L (aufsteigend) */
  order: number;
}

/** P&L-Kategorie-Definition */
export interface PLCategoryDef {
  id: PLCategory;
  label: string;
  section: PLSection;
  sign: AccountSign;
}

// ─── Lookup-Ergebnis ──────────────────────────────────────────────────────────

/**
 * Rückgabe der Lookup-Funktion für einen Import-Vorgang.
 */
export interface AccountLookupResult {
  /** Gefundenes Mapping oder null */
  mapping: AccountMapping | null;
  /** Wie wurde das Konto gefunden? */
  matchType: 'exact' | 'range' | 'none';
  /** Muss der Admin manuell zuordnen? */
  requiresManualMapping: boolean;
}
