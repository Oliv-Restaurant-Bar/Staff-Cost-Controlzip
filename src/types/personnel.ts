export type EmploymentType = 'vollzeit' | 'teilzeit' | 'minijob' | 'aushilfe';

export type Department = 'service' | 'küche';

export type DayOfWeek = 'montag' | 'dienstag' | 'mittwoch' | 'donnerstag' | 'freitag' | 'samstag' | 'sonntag';

export interface Employee {
  id: string;
  name: string;
  department: Department;
  employmentType: EmploymentType;
  hourlyWage: number;
  weeklyHours?: number;
  daysOff?: DayOfWeek[];
  preferredWorkDays?: DayOfWeek[];
  monthlySalary?: number;           // Monatslohn Basis (ohne 13.)
  monthlySalaryWith13th?: number;   // Monatslohn inkl. 13. Monatslohn (berechnet)
  hoursBalance?: number;            // Stundensaldo
  vacationBalance?: number;         // Feriensaldo
  vacationDaysPerYear?: number;     // Ferientage pro Jahr gemäss Vertrag

  // ─── Lohn-Erweiterung ──────────────────────────────────────────────────
  socialCostFactor?: number;        // AG-Sozialkostenanteil z.B. 1.13 = 13%
  has13thSalary?: boolean;          // 13. Monatslohn vereinbart?

  // ─── Persönliche Daten (für Onboarding / Vertrag) ──────────────────────
  birthDate?: string;               // ISO-Datum
  nationality?: string;
  phone?: string;
  email?: string;
  addressStreet?: string;
  addressZip?: string;
  addressCity?: string;
  ahvNumber?: string;               // Vertraulich – nur Admin
  iban?: string;                    // Vertraulich – nur Admin

  // ─── Vertragliche Grundlagen ───────────────────────────────────────────
  contractType?: 'monthly' | 'hourly' | 'irregular';
  positionTitle?: string;

  // ─── Station / Funktion ─────────────────────────────────────────────────
  /** Hauptstation (z.B. "Grill", "Bar", "Chef de Rang") */
  primaryStation?: string;
  /** Zusatzstationen — kann einspringen (z.B. ["Runner", "Event"]) */
  secondaryStations?: string[];
  contractStart?: string;           // ISO-Datum – Eintrittsdatum
  employmentEndDate?: string;       // ISO-Datum – Austrittsdatum / Beschäftigungsende
  contractEnd?: string;             // ISO-Datum – nur bei befristetem Vertrag
  isLimitedContract?: boolean;
  trialPeriodMonths?: 0 | 1 | 2 | 3;  // Probezeit-Auswahl (0 = keine)
  // noticePeriodWeeks entfernt – wird automatisch aus Probezeit abgeleitet:
  //   Während Probezeit: 3 Arbeitstage | Nach Probezeit: 1 Monat auf Monatsende

  // ─── Quellensteuer / Aufenthalt ─────────────────────────────────────────
  permitType?: 'swiss' | 'C' | 'B' | 'L' | 'G' | 'other'; // Aufenthaltsstatus
  maritalStatus?: 'single' | 'married' | 'divorced' | 'widowed';  // Zivilstand
  numberOfChildren?: number;             // Anzahl Kinder (Quellensteuer)
  spouseEmployed?: boolean;              // Ehepartner erwerbstätig?
  spouseLivesInSwitzerland?: boolean;    // Ehepartner wohnt in CH?

  // ─── Mitarbeiterstatus ──────────────────────────────────────────────────
  employeeStatus?: 'active' | 'pending_review'; // pending_review = neue Selbst-Anmeldung (noch nicht aktiviert)
  // ─── Integritätsfelder (Migration 20260605) ─────────────────────────────
  /** false = archiviert/deaktiviert; undefined/true = aktiv. Gesetzt von archiveEmployee(). */
  isActive?: boolean;
  /** ISO-Timestamp des Archivierungszeitpunkts. Nur für archivierte Mitarbeiter gesetzt. */
  archivedAt?: string;

  // ─── Onboarding ────────────────────────────────────────────────────────
  onboardingStatus?: 'none' | 'prepared' | 'sent' | 'in_progress' | 'completed';
  onboardingToken?: string;         // UUID-Token für persönlichen Onboarding-Link
  onboardingDocuments?: string;     // JSON-Array: [{type, name, url, uploadedAt}]

  // ─── Zeiterfassung ─────────────────────────────────────────────────────
  /** Admin-Einstellung: Mitarbeiter benötigt keine Zeiterfassung (z.B. Geschäftsführer).
   *  Mirus-Import: 0 Stunden werden als 100 % verifiziert akzeptiert.
   *  TODO: Spalte `no_time_tracking_required` in Supabase employees-Tabelle ergänzen. */
  no_time_tracking_required?: boolean;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  date: string;
  plannedStart: string;
  plannedEnd: string;
  plannedHours: number;
  actualStart?: string;
  actualEnd?: string;
  actualHours?: number;
  break?: number;
  /**
   * Woher kommt der Ist-Stunden-Wert?
   * 'mirus'  = aus Mirus XLS-Import
   * 'manual' = manuell erfasst im System
   * undefined = ältere Einträge ohne Herkunft
   */
  importSource?: 'mirus' | 'manual';
}


export interface HourlyRevenue {
  hour: number; // 0-23
  revenue: number;
  food?: number; // Revenue from food (Speisen) - relevant for Küche
  beverage?: number; // Revenue from beverages (Getränke) - relevant for Service
}

export interface DailyBudget {
  date: string;
  plannedRevenue: number;
  actualRevenue: number;
  previousYearRevenue: number;
  plannedLaborCost: number;
  actualLaborCost: number;
  hourlyRevenue?: HourlyRevenue[]; // Revenue per hour for analysis
  fixedBudget?: number; // Fixes Startbudget vom Monatsplan (bleibt konstant)
  takeawayRevenue?: number; // Take Away Umsatz (separate MWST: 2.6%)
  // Food / Beverage breakdown (from Gastronovi import)
  actualFood?: number;
  actualBeverage?: number;
  previousYearFood?: number;
  previousYearBeverage?: number;
}

// MWST rates for revenue calculation
export const VAT_RATES = {
  standard: 0.081, // 8.1% for regular revenue
  takeaway: 0.026, // 2.6% for takeaway revenue
};

// Helper to convert gross to net revenue
export const grossToNet = (
  grossRevenue: number, 
  takeawayRevenue: number = 0
): number => {
  const regularRevenue = grossRevenue - takeawayRevenue;
  const regularNet = regularRevenue / (1 + VAT_RATES.standard);
  const takeawayNet = takeawayRevenue / (1 + VAT_RATES.takeaway);
  return regularNet + takeawayNet;
};

// Helper to convert net to gross revenue
export const netToGross = (
  netRevenue: number,
  takeawayNetRevenue: number = 0
): number => {
  const regularNet = netRevenue - takeawayNetRevenue;
  const regularGross = regularNet * (1 + VAT_RATES.standard);
  const takeawayGross = takeawayNetRevenue * (1 + VAT_RATES.takeaway);
  return regularGross + takeawayGross;
};

export interface TimeSlot {
  start: string;
  end: string;
}

export interface DaySchedule {
  früh?: TimeSlot | null;
  spät?: TimeSlot | null;
  frühAbsence?: string | null;
  spätAbsence?: string | null;
  isAdditionalCostPlan?: boolean;
  isAdditionalCost?: boolean;
  /** Manuelle Pause 1. Einsatz in Minuten (0/30/60); null/undefined = keine manuelle Angabe */
  fruehBreakMinutes?: number | null;
  /** Manuelle Pause 2. Einsatz in Minuten (0/30/60); null/undefined = keine manuelle Angabe */
  spaetBreakMinutes?: number | null;
  /** @deprecated Legacy-Tages-Pause; nur Lese-Fallback in resolveDayBreakHours */
  breakMinutes?: number | null;
}

export interface DailySummary {
  date: string;
  totalPlannedHours: number;
  totalActualHours: number;
  totalPlannedCost: number;
  totalActualCost: number;
  plannedRevenue: number;
  actualRevenue: number;
  laborCostPercentage: number;
  variance: number;
}

export interface MirusImportEntry {
  name: string;
  department: Department;
  hours: number;
}

export interface MirusDailyImportEntry {
  name: string;
  department: Department;
  date: string;
  hours: number;
}

/**
 * Import-Modus für Mirus Ist-Stunden-Import:
 *   'replace' → Alle bestehenden Mirus-Einträge für den Zeitraum werden
 *               zuerst gelöscht, dann werden die neuen Einträge eingefügt.
 *               Verwenden wenn: neuer Mirus-Export, Daten sollen komplett ersetzt werden.
 *
 *   'update'  → Bestehende Einträge für dieselbe Person / dasselbe Datum
 *               werden überschrieben. Einträge für andere Tage bleiben erhalten.
 *               Verwenden wenn: Teilperioden-Nachtrag, manuelle Korrekturen nicht überschreiben.
 */
export type MirusImportMode = 'replace' | 'update';


export interface ScheduleImportEntry {
  name: string;
  department: Department;
  date: string;
  plannedHours: number;
  plannedStart?: string;
  plannedEnd?: string;
}

export interface RevenueImportEntry {
  date: string;
  revenue: number;
  type: 'planned' | 'actual' | 'previousYear';
}
