/**
 * L-GAV Lohnberechnungen für die Gastronomie
 * Gesamtarbeitsvertrag für das Gastgewerbe der Schweiz (L-GAV)
 *
 * Referenzwerte (Kanton Bern):
 *  - Vollzeit-Normalarbeitszeit: 42 Stunden pro Woche
 *  - Monatsstunden (offiziell L-GAV): 182 h/Monat
 *  - Ferienentschädigung SL (25 Tage):  10.65%
 *  - Feiertagsentschädigung SL (6 Tage): 2.27%
 *  - 13. Monatslohn-Zuschlag:            8.33% (= 1/12)
 */

export const LGAV = {
  WEEKLY_HOURS_FULLTIME: 42,
  MONTHLY_HOURS:         182,    // 42 h/Woche × 52 ÷ 12 ≈ 182 h/Monat (L-GAV Standard)
  VACATION_DAYS:         35,     // 5 Wochen = 35 Ferientage (Kalender) = 25 Arbeitstage
  PUBLIC_HOLIDAY_DAYS:   6,      // 6 bezahlte Feiertage (Kanton Bern)
  // SL-Zuschläge (auf den Basis-Stundenlohn)
  VACATION_RATE:         0.1065, // 10.65% für 5 Wochen (25 Arbeitstage) Ferien
  PUBLIC_HOLIDAY_RATE:   0.0227, // 2.27%  für 6 Feiertage (Kt. Bern)
  THIRTEENTH_RATE:       0.0833, // 8.33%  = 1/12 (13. Monatslohn)
} as const;

// ── Stundenlohn (SL) ─────────────────────────────────────────────────────────

export interface SlBreakdown {
  baseWage:              number;  // Basis-Stundenlohn brutto (Vertragslohn)
  vacationComp:          number;  // + Ferienentschädigung 10.65%
  holidayComp:           number;  // + Feiertagsentschädigung 2.27%
  subtotal:              number;  // Zwischensumme vor 13. ML
  thirteenthComp:        number;  // + 13. Monatslohn 8.33% (auf Zwischensumme)
  totalPayableHourly:    number;  // = Auszahlbarer Stundenlohn (Lohnzettel-Wert)
  socialCostPerHour:     number;  // + AG-Sozialkosten-Anteil pro Stunde
  internalHourlyCost:    number;  // = Interner Stundenansatz (Kostenstelle)
}

/**
 * Berechnet den vollständigen Stundenlohn-Breakdown nach L-GAV.
 * @param baseWage       Basis-Stundenlohn brutto (ohne Entschädigungen)
 * @param has13th        13. Monatslohn vereinbart?
 * @param socialCostFactor  AG-Sozialkostenfaktor z.B. 1.13
 */
export function calcSL(
  baseWage:         number,
  has13th:          boolean,
  socialCostFactor: number,
): SlBreakdown {
  const vacationComp    = baseWage * LGAV.VACATION_RATE;
  const holidayComp     = baseWage * LGAV.PUBLIC_HOLIDAY_RATE;
  const subtotal        = baseWage + vacationComp + holidayComp;
  const thirteenthComp  = has13th ? subtotal * LGAV.THIRTEENTH_RATE : 0;
  const totalPayableHourly  = subtotal + thirteenthComp;
  const socialCostPerHour   = totalPayableHourly * (socialCostFactor - 1);
  const internalHourlyCost  = totalPayableHourly * socialCostFactor;

  return {
    baseWage,
    vacationComp,
    holidayComp,
    subtotal,
    thirteenthComp,
    totalPayableHourly,
    socialCostPerHour,
    internalHourlyCost,
  };
}

// ── Monatslohn (ML) ──────────────────────────────────────────────────────────

export interface MlBreakdown {
  baseSalaryMonthly:        number;  // Vertragsmonatslohn brutto
  effectiveMonthlyGross:    number;  // inkl. 13. (× 13/12) wenn vereinbart
  annualGross:              number;  // Jahresbrutto (effectiveMonthly × 12)
  socialCostMonthly:        number;  // AG-Sozialkosten pro Monat
  totalMonthlyEmployerCost: number;  // Vollkosten pro Monat (= Basis der internen Stundenkostenkalkulation)
  annualEmployerCost:       number;  // Jahresvollkosten
  internalHourlyCost:       number;  // = Vollkosten/Monat ÷ 182 h (L-GAV Standard)
}

/**
 * Berechnet den vollständigen Monatslohn-Breakdown nach L-GAV.
 *
 * Interner Stundenansatz = Vollkosten pro Monat ÷ 182 h
 * (L-GAV Standardwert: 42 h/Woche × 52 Wochen ÷ 12 Monate = 182 h/Monat)
 *
 * @param baseSalaryMonthly  Monatslohn brutto laut Vertrag (ohne 13.)
 * @param has13th            13. Monatslohn vereinbart?
 * @param weeklyHours        Vertragsarbeitszeit (wird für Jahreskosten genutzt)
 * @param socialCostFactor   AG-Sozialkostenfaktor z.B. 1.13
 */
export function calcML(
  baseSalaryMonthly: number,
  has13th:           boolean,
  weeklyHours:       number,
  socialCostFactor:  number,
): MlBreakdown {
  const effectiveMonthlyGross    = has13th
    ? baseSalaryMonthly * (13 / 12)
    : baseSalaryMonthly;
  const annualGross              = effectiveMonthlyGross * 12;
  const socialCostMonthly        = effectiveMonthlyGross * (socialCostFactor - 1);
  const totalMonthlyEmployerCost = effectiveMonthlyGross + socialCostMonthly;
  const annualEmployerCost       = annualGross * socialCostFactor;
  // L-GAV: interner Stundenansatz = Vollkosten/Monat ÷ 182 h
  const internalHourlyCost       = totalMonthlyEmployerCost / LGAV.MONTHLY_HOURS;

  return {
    baseSalaryMonthly,
    effectiveMonthlyGross,
    annualGross,
    socialCostMonthly,
    totalMonthlyEmployerCost,
    annualEmployerCost,
    internalHourlyCost,
  };
}
