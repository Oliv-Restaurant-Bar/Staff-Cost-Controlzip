/**
 * social-costs.ts — Zentrale AG-Sozialkostensätze (pure, DOM-/Supabase-frei).
 * ===========================================================================
 * EINZIGE Quelle der Wahrheit für den Arbeitgeber-Sozialkostenzuschlag:
 *   Personalaufwand = Bruttolohn + AG-Sozialkosten (KEINE Arbeitnehmerabzüge —
 *   AN-Anteile sind Durchlaufposten und gehören NICHT in den Personalaufwand).
 *
 * Die Sätze werden zentral unter Einstellungen gepflegt (NICHT pro Mitarbeiter)
 * und als versioniertes Blob `socialCostRates_v1` tenant-präfixiert persistiert
 * (localStorage primär + Supabase-KV-Backup, siehe social-costs-db.ts).
 *
 * Der frühere per-Mitarbeiter-`socialCostFactor` ist abgelöst (Hard-Cut):
 * DB-Spalte + contract-history bleiben historisch erhalten, werden aber von
 * KEINER Berechnung mehr gelesen.
 *
 * Alle Sätze sind %-Werte auf den BRUTTOLOHN (bei Stundenlöhnern inkl.
 * Ferien-/Feiertagsentschädigung und 13., d.h. auf den auszahlbaren Lohn —
 * das entspricht der Basis von Konto 5000 in der Erfolgsrechnung).
 */

export interface SocialCostRates {
  /** AHV/IV/EO Arbeitgeberbeitrag (%) */
  ahvPct: number;
  /** ALV Arbeitgeberbeitrag (%) */
  alvPct: number;
  /** Familienausgleichskasse FAK (%) */
  fakPct: number;
  /** Verwaltungskosten Ausgleichskasse (%) */
  vkPct: number;
  /** UVG Berufsunfallversicherung (AG-pflichtig) (%) */
  uvgBuPct: number;
  /** Krankentaggeld-Versicherung, AG-Anteil (%) */
  ktgPct: number;
  /** BVG / Pensionskasse, AG-Anteil (%) — Näherung als flacher Satz */
  bvgPct: number;
  /** L-GAV Vollzugskostenbeitrag AG (%) */
  lgavPct: number;
  /** Weitere AG-Kosten (%) — z.B. UVG-NBU-Übernahme, GAV-Fonds */
  otherPct: number;
}

export interface SocialCostRatesBlob {
  version: 1;
  rates: SocialCostRates;
  updatedAt: string | null;
  /** Reserviert für spätere Erweiterungen (z.B. Jahres-Staffelung) */
  meta?: Record<string, unknown>;
}

/** Storage-Key (tenant-präfixiert via tenantKey()) */
export const SOCIAL_COST_RATES_KEY = 'socialCostRates_v1';

/**
 * CH-Richtwerte 2026 (Gastgewerbe, Kanton Bern) — bewusst als Startwerte,
 * die effektiven Sätze (insb. BVG/KTG/UVG) sind policenabhängig und sollten
 * vom Betrieb in den Einstellungen präzisiert werden.
 *
 * AG-Faktor-Herleitung (Summe = 15.71 % ≈ 15.7 %):
 *   Gemeinsame Sozialkosten .............. 11.21 %
 *     AHV/IV/EO (AG) ......... 5.30
 *     ALV (AG) ............... 1.10
 *     FAK (BE) ............... 1.60
 *     Verwaltungskosten AK ... 0.37
 *     UVG Berufsunfall (½) ... 1.60
 *     KTG (AG-Anteil, ½) ..... 1.10
 *     Berufsbildung (L-GAV) .. 0.14
 *   BVG (AG-Anteil, Puffer) .............. 4.50 %  (auf alle angewandt)
 *   ───────────────────────────────────────────
 *   Total ................................ 15.71 %
 */
export const DEFAULT_SOCIAL_COST_RATES: SocialCostRates = {
  ahvPct: 5.30,
  alvPct: 1.10,
  fakPct: 1.60,   // FAK Kanton Bern
  vkPct: 0.37,    // Verwaltungskosten Ausgleichskasse
  uvgBuPct: 1.60, // UVG Berufsunfall (AG trägt ½)
  ktgPct: 1.10,   // KTG (AG trägt ½)
  bvgPct: 4.50,   // BVG-Puffer (auf alle Löhne)
  lgavPct: 0.14,  // Berufsbildungsbeitrag L-GAV
  otherPct: 0,
};

/**
 * Exakter Snapshot der ALTEN Defaults (Summe 14.2 %) — NUR für die einmalige
 * Rates-Migration: entspricht ein gespeicherter Blob EXAKT diesen 9 Werten,
 * wurde er nie angepasst und wird auf die neuen Defaults gehoben. Weicht auch
 * nur ein Wert ab, gelten es als bewusste User-Werte und bleiben unangetastet.
 */
export const LEGACY_DEFAULT_SOCIAL_COST_RATES_14_2: SocialCostRates = {
  ahvPct: 5.3,
  alvPct: 1.1,
  fakPct: 1.2,
  vkPct: 0.3,
  uvgBuPct: 0.4,
  ktgPct: 1.0,
  bvgPct: 4.5,
  lgavPct: 0.4,
  otherPct: 0,
};

/** Feld-Metadaten für UI (Einstellungen-Card) — Reihenfolge = Anzeige-Reihenfolge. */
export const SOCIAL_COST_RATE_FIELDS: ReadonlyArray<{
  key: keyof SocialCostRates;
  label: string;
  info: string;
}> = [
  { key: 'ahvPct',   label: 'AHV/IV/EO (AG)',                 info: 'Arbeitgeberbeitrag AHV/IV/EO. Gesetzlich 5.3% des Bruttolohns.' },
  { key: 'alvPct',   label: 'ALV (AG)',                       info: 'Arbeitgeberbeitrag Arbeitslosenversicherung. Gesetzlich 1.1% bis zur ALV-Höchstgrenze.' },
  { key: 'fakPct',   label: 'FAK (BE)',                       info: 'Familienausgleichskasse — vollständig vom Arbeitgeber getragen. Satz je nach Kasse/Kanton (Kanton Bern ca. 1.6%).' },
  { key: 'vkPct',    label: 'Verwaltungskosten AK',           info: 'Verwaltungskostenbeitrag der Ausgleichskasse, meist in % des AHV-Beitrags — hier vereinfacht als % des Bruttolohns.' },
  { key: 'uvgBuPct', label: 'UVG Berufsunfall',               info: 'Berufsunfallversicherung — Prämie trägt der Arbeitgeber. Satz gemäss Police.' },
  { key: 'ktgPct',   label: 'KTG (AG-Anteil)',                info: 'Krankentaggeldversicherung — im Gastgewerbe (L-GAV) trägt der Arbeitgeber mindestens die Hälfte der Prämie. Satz gemäss Police.' },
  { key: 'bvgPct',   label: 'BVG (AG-Anteil)',                info: 'Pensionskasse, Arbeitgeberanteil. Näherung als flacher %-Satz auf den Bruttolohn — effektiv hängt der BVG-Beitrag von Koordinationsabzug und Alter ab.' },
  { key: 'lgavPct',  label: 'Berufsbildung (L-GAV)',          info: 'Berufsbildungsbeitrag L-GAV Gastgewerbe, Arbeitgeberanteil.' },
  { key: 'otherPct', label: 'Weitere AG-Kosten',              info: 'Optionale weitere Arbeitgeberkosten in % des Bruttolohns (z.B. übernommene NBU-Prämie, weitere GAV-Fonds).' },
];

// ── Zentrale FIBU-Begriffe (Single Source of Truth für ALLE Module) ──────────
// Personalstamm, Personalbedarf, Dienstplanung, Kennzahlen, Budget, Forecast,
// Erfolgsrechnung, Controlling verwenden EXAKT diese Bezeichnungen — keine
// Modul-eigenen Begriffe wie „FIX-Kosten" für diese Grössen.
export const EMPLOYER_COST_LABELS = {
  /** Bruttolohn inkl. anteiligem 13. Monatslohn */
  gross: 'Bruttolohn',
  /** Sämtliche Arbeitgeberbeiträge (AHV/ALV/FAK/VK/UVG-BU/KTG/BVG/L-GAV/weitere) */
  social: 'Arbeitgeber-Sozialkosten',
  /** Bruttolohn + Arbeitgeber-Sozialkosten */
  total: 'Total Arbeitgeberkosten',
} as const;

/** Kurzformen für enge Tabellenspalten — Langform gehört in den Tooltip. */
export const EMPLOYER_COST_LABELS_SHORT = {
  gross: 'Brutto',
  social: 'AG-Sozialkosten',
  total: 'Total AG',
} as const;

/** Standard-Erklärsätze für Tooltips/InfoTips (überall identisch verwenden). */
export const EMPLOYER_COST_INFO = {
  gross: 'Bruttolohn inkl. anteiligem 13. Monatslohn (bei Stundenlohn inkl. Ferien-/Feiertagsentschädigung).',
  social: 'Sämtliche Arbeitgeberbeiträge: AHV/IV/EO, ALV, FAK, Verwaltungskosten AK, UVG-BU, KTG, BVG, L-GAV, weitere.',
  total: 'Total Arbeitgeberkosten = Bruttolohn + Arbeitgeber-Sozialkosten. Basis aller Personalkosten-Auswertungen.',
} as const;

// ── Normalisierung ───────────────────────────────────────────────────────────

const clampPct = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  // Schutz gegen Tippfehler (z.B. 530 statt 5.3): kein Einzelsatz über 50%.
  return Math.min(n, 50);
};

export function normalizeSocialCostRates(raw: unknown): SocialCostRates {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const out = {} as SocialCostRates;
  for (const { key } of SOCIAL_COST_RATE_FIELDS) {
    out[key] = clampPct(src[key], DEFAULT_SOCIAL_COST_RATES[key]);
  }
  return out;
}

/**
 * Einmalige Default-Migration (14.2 % → 15.7 %).
 * Entspricht ein gespeicherter Satz-Satz EXAKT den ALTEN Defaults (alle 9
 * Werte identisch), wurde er nie bewusst angepasst → auf die neuen Defaults
 * heben. Weicht auch nur EIN Wert ab, gelten es als bewusste User-Werte und
 * bleiben vollständig unangetastet. Idempotent (neue Defaults ≠ alte Defaults).
 */
export function migrateLegacyDefaultRates(rates: SocialCostRates): SocialCostRates {
  const isExactLegacyDefault = (SOCIAL_COST_RATE_FIELDS as ReadonlyArray<{ key: keyof SocialCostRates }>)
    .every(({ key }) => rates[key] === LEGACY_DEFAULT_SOCIAL_COST_RATES_14_2[key]);
  return isExactLegacyDefault ? { ...DEFAULT_SOCIAL_COST_RATES } : rates;
}

/** Roh-Blob (localStorage/KV) defensiv normalisieren — wirft nie. */
export function normalizeSocialCostRatesBlob(raw: unknown): SocialCostRatesBlob {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const updatedAt = typeof src.updatedAt === 'string' ? src.updatedAt : null;
  const meta = (src.meta && typeof src.meta === 'object' && !Array.isArray(src.meta))
    ? src.meta as Record<string, unknown>
    : undefined;
  return {
    version: 1,
    rates: normalizeSocialCostRates(src.rates),
    updatedAt,
    ...(meta ? { meta } : {}),
  };
}

// ── Berechnung ───────────────────────────────────────────────────────────────

/** Summe aller AG-Sozialkostensätze in % (Default 15.7). */
export function totalSocialRatePct(rates: SocialCostRates): number {
  return SOCIAL_COST_RATE_FIELDS.reduce((sum, f) => sum + (rates[f.key] || 0), 0);
}

/**
 * Multiplikator-Faktor für calcSL/calcML (Default 1.157).
 * Brücke zur bestehenden salaryCalc-Signatur (socialCostFactor-Parameter).
 */
export function socialCostFactorFromRates(rates: SocialCostRates): number {
  return 1 + totalSocialRatePct(rates) / 100;
}

export interface EmployerCostSplit {
  /** Bruttolohn (auszahlbar, inkl. Zuschlägen) */
  gross: number;
  /** AG-Sozialkosten */
  social: number;
  /** Total Arbeitgeberkosten = gross + social */
  total: number;
}

/** Zerlegt einen Bruttolohn-Betrag in Brutto / AG-Sozialkosten / Total. */
export function splitEmployerCost(gross: number, rates: SocialCostRates): EmployerCostSplit {
  const safeGross = Number.isFinite(gross) ? gross : 0;
  const social = safeGross * (totalSocialRatePct(rates) / 100);
  return { gross: safeGross, social, total: safeGross + social };
}
