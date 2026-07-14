/**
 * Personalbedarf — Typen der SOLL-Besetzung (staffing requirements).
 * ──────────────────────────────────────────────────────────────────────────────
 * Pro (Saison × Wochentag) wird je Position EINE oder MEHRERE Schichten
 * hinterlegt. Eine `StaffingRequirement`-Instanz = EINE Schicht.
 *
 * Diese Vorlagen sind VOLLSTÄNDIG GETRENNT von der Dienstplanung gespeichert
 * (eigene Tabelle `staffing_requirements`, kein Fremdschlüssel auf
 * schedule_entries). `positionKey` ist der stabile Positions-Slug
 * (positions.key) — bewusst kein FK, damit Umbenennen/Deaktivieren einer
 * Position die Vorlage nicht zerstört.
 *
 * ERWEITERBARKEIT OHNE SCHEMA-ÄNDERUNG: Der Geltungsbereich ist generisch über
 * `scopeType` + `scopeRef` modelliert. Aktuell wird nur `'weekly'` genutzt;
 * künftige Feiertage/Events/Sonderöffnung kommen als neue `scopeType`-Werte
 * hinzu (z.B. 'holiday' mit `scopeRef` = Datum), ohne neue Spalten.
 *
 * DB-Tabelle: `staffing_requirements`
 * (siehe supabase/migrations/20260625_staffing_requirements.sql).
 */

/**
 * Geltungsbereich-Typ. Aktuell genutzt: 'weekly' (Saison × Wochentag).
 * Künftig (ohne Migration): 'holiday' | 'event' | 'special_opening' |
 * 'custom_season'. Als breiter String-Typ gehalten, damit neue Werte aus der
 * DB nicht typgeprüft abgelehnt werden.
 */
export type StaffingScopeType = 'weekly' | (string & {});

/**
 * Saison. 'standard' | 'sommer' | 'winter' werden aktuell unterstützt;
 * 'custom' (Individuelle Saison) ist für später vorgesehen.
 */
export type StaffingSeason = 'standard' | 'sommer' | 'winter' | (string & {});

export interface StaffingRequirement {
  id: string;
  restaurantId: string;
  /** Geltungsbereich-Typ. 'weekly' = wochentagsbasierte Vorlage. */
  scopeType: StaffingScopeType;
  /** Saison ('standard' | 'sommer' | 'winter' | künftig 'custom'). */
  season: StaffingSeason;
  /** ISO-Wochentag 1..7 (Mo..So) für 'weekly'; null für datumsbasierte Bereiche. */
  weekday: number | null;
  /** Optionaler Bezug (Datum/Event-ID/Feiertags-Key). Für 'weekly' = null. */
  scopeRef: string | null;
  /** Stabiler Positions-Slug (positions.key). */
  positionKey: string;
  /** Schichtbeginn 'HH:MM'. */
  shiftStart: string;
  /** Schichtende 'HH:MM'. */
  shiftEnd: string;
  /** Anzahl benötigter Mitarbeitender (>= 0). */
  requiredCount: number;
  /** Reihenfolge der Schicht innerhalb (Bereich × Position × Geltungsbereich). */
  sortOrder: number;
  /** Sekundärer Erweiterungs-Auffangraum (künftige Felder ohne Migration). */
  meta: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** Felder, die beim Anlegen einer Schicht (vor DB-Insert) gesetzt werden. */
export type StaffingRequirementDraft = Omit<
  StaffingRequirement,
  'id' | 'restaurantId' | 'createdAt' | 'updatedAt'
>;

/**
 * Geltungsbereich-Selektor: identifiziert eine Menge zusammengehöriger
 * Schicht-Zeilen (alle Positionen/Schichten eines Saison-Wochentags). Wird vom
 * Speicherpfad genutzt, um genau diesen Bereich zu laden/diffen/löschen.
 */
export interface StaffingScope {
  scopeType: StaffingScopeType;
  season: StaffingSeason;
  weekday: number | null;
  scopeRef: string | null;
}
