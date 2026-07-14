/**
 * Personal FIX + VARIABEL — Abstimmungs- & Vergleichslogik (rein, DOM-/Supabase-frei)
 * ===================================================================================
 *
 * Diese Datei kapselt die reine Rechenlogik hinter drei Transparenz-Bausteinen der
 * Seite „Personal FIX + VARIABEL" (`src/pages/PersonalFix.tsx`):
 *
 *   1) `computeFlexScopes`          — macht die drei fachlich UNTERSCHIEDLICHEN
 *                                     „Flex Ist"-Grössen aus denselben Bausteinen
 *                                     ableitbar und stimmt sie explizit ab
 *                                     (Single Source of Truth statt Zweitberechnung).
 *   2) `buildErfolgsrechnungVergleich` — vergleicht den berechneten Personalaufwand
 *                                     mit dem effektiven Personalaufwand aus der
 *                                     Erfolgsrechnung (FIBU-5xxx).
 *   3) `buildPkqBreakdown`          — legt die PKQ-Herleitung (Personal / Umsatz)
 *                                     für einen InfoTip offen.
 *
 * WICHTIG (Boundary): Diese Datei ruft NICHT `computePLForMonth` o. Ä. auf — die
 * PL-Engine hängt an localStorage (Konto-Mapping) und würde die Node-Reinheit
 * brechen. Alle Funktionen nehmen ausschliesslich Primitive entgegen; die Seite
 * lädt Datensatz + PL-Ergebnis und reicht die Zahlen hier hinein.
 */

export type ComparisonTone = 'good' | 'warn' | 'critical' | 'neutral';

/** Schwellen für die Abweichung Berechnet ↔ Erfolgsrechnung, in Prozentpunkten der PK-Quote. */
export const PERSONALAUFWAND_DIFF_PP_GOOD = 1; // |Δ| ≤ 1 Pp → grün
export const PERSONALAUFWAND_DIFF_PP_WARN = 3; // |Δ| ≤ 3 Pp → orange, darüber rot

/** Mindest-Umsatz (CHF) für eine sinnvolle Quotenberechnung — verhindert absurde %-Werte. */
export const MIN_REVENUE_FOR_QUOTE = 1000;

/** P&L-Nettoumsatz gilt als abweichend, wenn er > 5 % vom PKQ-Umsatz differiert. */
export const REVENUE_MISMATCH_THRESHOLD = 0.05;

// ─── 1) Flex-Ist-Grössen abstimmen ──────────────────────────────────────────

/**
 * Bausteine der variablen (Flex-)Personalkosten Ist. Alle drei „Flex Ist"-Werte
 * der Seite werden AUSSCHLIESSLICH hieraus abgeleitet.
 */
export interface FlexScopeInput {
  /** Variable MA: Ist-Arbeitsstunden × Lohn (Basis der Flex-Auswertung). */
  varArbeitIst: number;
  /** Zusatzkosten von Fixlohn-MA (isAdditionalCost-Einträge). */
  zusatzIst: number;
  /** Ferienabbau Ist (variable MA). */
  ferienIst: number;
}

export interface FlexScopes {
  /** Nur Flex-Arbeit variabler MA — „Flex-Auswertung — Plan vs. Ist" (pfixAbw). */
  flexArbeitIst: number;
  /** Flex-Arbeit + Zusatzkosten Fix-MA — Tabelle „Flex Kosten pro Mitarbeiter". */
  flexMitZusatzIst: number;
  /** Flex-Arbeit + Zusatzkosten + Ferien — Summary „Total Flex Ist". */
  totalFlexIst: number;
  /** Δ zwischen Flex-Auswertung und Tabelle (= Zusatzkosten Fix-MA). */
  zusatzDelta: number;
  /** Δ zwischen Tabelle und Summary (= Ferienabbau Ist). */
  ferienDelta: number;
}

/**
 * Leitet die drei „Flex Ist"-Grössen aus denselben Bausteinen ab.
 *
 * Damit ist bewiesen und sichtbar, WARUM sich die Werte unterscheiden:
 *   flexArbeitIst  + zusatzDelta = flexMitZusatzIst
 *   flexMitZusatzIst + ferienDelta = totalFlexIst
 */
export function computeFlexScopes(i: FlexScopeInput): FlexScopes {
  const flexArbeitIst = i.varArbeitIst;
  const flexMitZusatzIst = flexArbeitIst + i.zusatzIst;
  const totalFlexIst = flexMitZusatzIst + i.ferienIst;
  return {
    flexArbeitIst,
    flexMitZusatzIst,
    totalFlexIst,
    zusatzDelta: i.zusatzIst,
    ferienDelta: i.ferienIst,
  };
}

// ─── Quotenhilfe ────────────────────────────────────────────────────────────

/**
 * Personalkostenquote mit Null-/Klein-Umsatz-Schutz (analog `safeQuote` der
 * Reporting-Seite). Gibt `null` zurück, wenn Zähler ≤ 0 oder Umsatz < 1'000 CHF.
 */
export function safePkQuote(
  personal: number | null | undefined,
  revenue: number | null | undefined,
): number | null {
  if (personal == null || personal <= 0) return null;
  if (revenue == null || revenue < MIN_REVENUE_FOR_QUOTE) return null;
  return (personal / revenue) * 100;
}

// ─── 2) Planung vs. Erfolgsrechnung ─────────────────────────────────────────

export interface ErfolgsrechnungVergleichInput {
  /** Berechneter Personalaufwand (App-Kalkulation, Total Personal Ist). */
  berechnetCHF: number;
  /**
   * FIBU-Ist laut Erfolgsrechnung = „Löhne (Total)" (personnel_wages) +
   * „Sozialleistungen" (personnel_social) aus DERSELBEN computePLForMonth-
   * Berechnung, die auch die Erfolgsrechnung/PLView rendert (Single Source of
   * Truth) — KEINE eigene 5xxx-Aggregation, KEINE separate Kontenauswahl, KEIN
   * „Übriger Personalaufwand". `null`/≤ 0 → Vergleich „missing" (nie 0 anzeigen).
   */
  fibuCHF: number | null | undefined;
  /** P&L-Nettoumsatz (`net_revenue.actual`) — nur als Kontroll-/Referenzwert. */
  plNetRevenue: number | null | undefined;
  /** Umsatz für BEIDE Quoten (identischer Nenner → Prozentpunkte vergleichbar). */
  effectiveRevenue: number;
}

export type ErfolgsrechnungVergleich =
  | { status: 'missing' }
  | {
      status: 'ok';
      /** Effektiver Personalaufwand laut Erfolgsrechnung (Löhne + Sozialleistungen). */
      fibuCHF: number;
      /** Berechneter Personalaufwand (durchgereicht). */
      berechnetCHF: number;
      /** Berechnet − FIBU (CHF). Positiv = App rechnet höher als die Buchhaltung. */
      diffCHF: number;
      /** PK-Quote berechnet (% vom Umsatz) — `null` bei zu kleinem Umsatz. */
      berechnetPct: number | null;
      /** PK-Quote FIBU (% vom Umsatz) — `null` bei zu kleinem Umsatz. */
      fibuPct: number | null;
      /** Differenz der Quoten in Prozentpunkten (berechnet − FIBU). */
      diffPp: number | null;
      /** Ampel-Ton anhand `diffPp`. */
      tone: ComparisonTone;
      /** P&L-Nettoumsatz weicht > 5 % vom PKQ-Umsatz ab (Warnhinweis). */
      revenueMismatch: boolean;
    };

/** Ampel-Ton aus der Quotenabweichung (Prozentpunkte). */
export function toneForDiffPp(diffPp: number | null): ComparisonTone {
  if (diffPp == null) return 'neutral';
  const a = Math.abs(diffPp);
  if (a <= PERSONALAUFWAND_DIFF_PP_GOOD) return 'good';
  if (a <= PERSONALAUFWAND_DIFF_PP_WARN) return 'warn';
  return 'critical';
}

/**
 * Generisches Vergleichspaar App-Kalkulation ↔ Erfolgsrechnung (eine Ebene).
 *
 * Bewusst wertneutral (kein „Plan"/„Ist" im Typ): dieselbe reine Funktion bildet
 * BEIDE Abgleiche der Seite ab —
 *   • Planung  vs. Erfolgsrechnung-Budget  (appCHF = App-Plan,  fibuCHF = FIBU-Budget)
 *   • Ist      vs. Erfolgsrechnung-Ist     (appCHF = App-Ist,   fibuCHF = FIBU-5xxx)
 * Beide Quoten teilen denselben `revenue`-Nenner → Prozentpunkte vergleichbar.
 * Fehlt der Erfolgsrechnungs-Wert (≤ 0) → `{ status: 'missing' }` (nie 0 anzeigen).
 */
export interface ErfolgsVergleichPaarInput {
  /** Von der App berechneter Personalaufwand dieser Ebene (Plan ODER Ist). */
  appCHF: number;
  /** Personalaufwand laut Erfolgsrechnung dieser Ebene (Budget ODER Ist). */
  fibuCHF: number | null | undefined;
  /** Umsatz-Nenner für BEIDE Quoten dieser Ebene (Plan-Umsatz bzw. Ist-Umsatz). */
  revenue: number;
}

export type ErfolgsVergleichPaar =
  | { status: 'missing' }
  | {
      status: 'ok';
      /** App-Personalaufwand (durchgereicht). */
      appCHF: number;
      /** Erfolgsrechnungs-Personalaufwand. */
      fibuCHF: number;
      /** App − FIBU (CHF). Positiv = App rechnet höher als die Buchhaltung. */
      diffCHF: number;
      /** PK-Quote App (% vom Umsatz) — `null` bei zu kleinem Umsatz. */
      appPct: number | null;
      /** PK-Quote FIBU (% vom Umsatz) — `null` bei zu kleinem Umsatz. */
      fibuPct: number | null;
      /** Differenz der Quoten in Prozentpunkten (App − FIBU). */
      diffPp: number | null;
      /** Ampel-Ton anhand `diffPp`. */
      tone: ComparisonTone;
    };

export function buildErfolgsVergleichPaar(i: ErfolgsVergleichPaarInput): ErfolgsVergleichPaar {
  const fibuCHF = i.fibuCHF != null && i.fibuCHF > 0 ? i.fibuCHF : null;
  if (fibuCHF == null) return { status: 'missing' };
  const appPct = safePkQuote(i.appCHF, i.revenue);
  const fibuPct = safePkQuote(fibuCHF, i.revenue);
  const diffPp = appPct != null && fibuPct != null ? appPct - fibuPct : null;
  return {
    status: 'ok',
    appCHF: i.appCHF,
    fibuCHF,
    diffCHF: i.appCHF - fibuCHF,
    appPct,
    fibuPct,
    diffPp,
    tone: toneForDiffPp(diffPp),
  };
}

/**
 * Vergleicht den berechneten Personalaufwand mit der Erfolgsrechnung (Ist-Ebene).
 *
 * Der FIBU-Wert (`fibuCHF`) ist EXAKT „Löhne (Total)" + „Sozialleistungen" aus
 * derselben computePLForMonth-Berechnung, die auch die Erfolgsrechnung/PLView
 * rendert (Single Source of Truth) — keine separate Kontenauswahl, keine eigene
 * Aggregation, kein „Übriger Personalaufwand". Der Wert enthält bereits den
 * vollen Arbeitgeberaufwand und wird NIE zusätzlich mit dem Sozialkostenfaktor
 * multipliziert. Fehlt er (≤ 0) → `{ status: 'missing' }` (nie 0 anzeigen).
 *
 * Dünner Wrapper um `buildErfolgsVergleichPaar` (gemeinsame Vergleichsmathematik);
 * ergänzt nur das Ist-spezifische `revenueMismatch`-Flag.
 */
export function buildErfolgsrechnungVergleich(
  i: ErfolgsrechnungVergleichInput,
): ErfolgsrechnungVergleich {
  const paar = buildErfolgsVergleichPaar({
    appCHF: i.berechnetCHF,
    fibuCHF: i.fibuCHF,
    revenue: i.effectiveRevenue,
  });
  if (paar.status === 'missing') return { status: 'missing' };

  const revenueMismatch =
    i.plNetRevenue != null && i.plNetRevenue > 0 && i.effectiveRevenue > 0
      ? Math.abs(i.plNetRevenue - i.effectiveRevenue) / i.effectiveRevenue > REVENUE_MISMATCH_THRESHOLD
      : false;

  return {
    status: 'ok',
    fibuCHF: paar.fibuCHF,
    berechnetCHF: paar.appCHF,
    diffCHF: paar.diffCHF,
    berechnetPct: paar.appPct,
    fibuPct: paar.fibuPct,
    diffPp: paar.diffPp,
    tone: paar.tone,
    revenueMismatch,
  };
}

// ─── 3) PKQ-Herleitung (für InfoTip) ────────────────────────────────────────

export interface PkqBreakdownInput {
  /** Total Personal Ist (Zähler). */
  personalIst: number;
  /** Effektiver Umsatz (Nenner). */
  revenue: number;
  /** Umsatz = manuelle Annahme statt Ist-Wert? */
  revenueIsAssumed: boolean;
  /** Umsatzquelle, z. B. „Ist-Umsatz", „exkl. Marketing", „Annahme". */
  revenueLabel: string;
  /** Monatslabel, z. B. „Juni 2026". */
  monthLabel: string;
  /** Stichtag (proRataDay) oder `null` (ganzer Monat). */
  cutoffDay?: number | null;
}

export interface PkqBreakdown {
  /** Quote (% vom Umsatz) — `null` bei fehlendem/zu kleinem Umsatz. */
  pkq: number | null;
  personalIst: number;
  revenue: number;
  revenueIsAssumed: boolean;
  revenueLabel: string;
  monthLabel: string;
  cutoffDay: number | null;
  hasRevenue: boolean;
}

/** Legt die PKQ-Herleitung (Personal / Umsatz) mit echten Werten + Quelle offen. */
export function buildPkqBreakdown(i: PkqBreakdownInput): PkqBreakdown {
  return {
    pkq: safePkQuote(i.personalIst, i.revenue),
    personalIst: i.personalIst,
    revenue: i.revenue,
    revenueIsAssumed: i.revenueIsAssumed,
    revenueLabel: i.revenueLabel,
    monthLabel: i.monthLabel,
    cutoffDay: i.cutoffDay ?? null,
    hasRevenue: i.revenue > 0,
  };
}

// ─── 4) Budget vs. Ist (Personalcontrolling, Block A) + Klartext-Wording ─────

/** Schweizer CHF-Format ohne Rappen (z. B. „CHF 2'761"). Node-Intl-fähig, DOM-frei. */
export function fmtChfWhole(n: number): string {
  return n.toLocaleString('de-CH', {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  });
}

/** Kleinste relevante CHF-Differenz (Rundungsrauschen darunter = „gleich"). */
export const BUDGET_DIFF_EPSILON = 0.005;

/** Richtung der Ist-Abweichung gegenüber dem Budget. */
export type BudgetDirection = 'under' | 'over' | 'onbudget';

export interface BudgetVsIstInput {
  /** Budget-Personalaufwand (App-Plan, Total Personal Budget). */
  budgetCHF: number;
  /** Ist-Personalaufwand (Total Personal Ist). */
  istCHF: number;
  /** Budget-Personalquote (% vom Umsatz) — `null` bei zu kleinem/fehlendem Umsatz. */
  budgetPct: number | null;
  /** Ist-Personalquote (% vom Umsatz, GLEICHER Nenner) — `null` bei zu kleinem/fehlendem Umsatz. */
  istPct: number | null;
}

export interface BudgetVsIst {
  budgetCHF: number;
  istCHF: number;
  /** Zentrale, eindeutige Differenz: Ist − Budget (negativ = unter Budget = gut). */
  diffCHF: number;
  budgetPct: number | null;
  istPct: number | null;
  /** Ist − Budget in Prozentpunkten (istPct − budgetPct); `null`, wenn eine Quote fehlt. */
  diffPp: number | null;
  direction: BudgetDirection;
  /** Fachlicher Ton: unter Budget → good, im Budget → neutral, über Budget → critical. */
  tone: ComparisonTone;
}

/**
 * Betriebswirtschaftlicher Vergleich Budget ↔ Ist (Block A des Personalcontrollings).
 *
 * Anders als `toneForDiffPp` (technischer Betragsvergleich) ist der Ton hier
 * RICHTUNGSABHÄNGIG: Ist unter Budget ist gut (grün), über Budget schlecht (rot).
 * Es findet KEINE Parallelberechnung des Personalaufwands statt — die Funktion
 * erhält die bereits berechneten CHF- und Quoten-Werte und leitet nur Differenz
 * (Ist − Budget), Prozentpunkte, Richtung und Ton daraus ab.
 */
export function buildBudgetVsIst(i: BudgetVsIstInput): BudgetVsIst {
  const diffCHF = i.istCHF - i.budgetCHF;
  const diffPp =
    i.istPct != null && i.budgetPct != null ? i.istPct - i.budgetPct : null;
  let direction: BudgetDirection;
  let tone: ComparisonTone;
  if (diffCHF > BUDGET_DIFF_EPSILON) {
    direction = 'over';
    tone = 'critical';
  } else if (diffCHF < -BUDGET_DIFF_EPSILON) {
    direction = 'under';
    tone = 'good';
  } else {
    direction = 'onbudget';
    tone = 'neutral';
  }
  return {
    budgetCHF: i.budgetCHF,
    istCHF: i.istCHF,
    diffCHF,
    budgetPct: i.budgetPct,
    istPct: i.istPct,
    diffPp,
    direction,
    tone,
  };
}

/**
 * Klartext-Bewertung der Budget-Abweichung (Block A + KPI-Karte „Abweichung
 * Ist − Budget"). „CHF X unter Budget" / „CHF X über Budget" / „Im Budget" —
 * der Nutzer erkennt die Richtung direkt, nicht nur ein mathematisches Vorzeichen.
 */
export function budgetDeltaText(diffCHF: number): string {
  if (diffCHF > BUDGET_DIFF_EPSILON) return `${fmtChfWhole(Math.abs(diffCHF))} über Budget`;
  if (diffCHF < -BUDGET_DIFF_EPSILON) return `${fmtChfWhole(Math.abs(diffCHF))} unter Budget`;
  return 'Im Budget';
}

/**
 * Sachliche Beschreibung der technischen App-↔-Erfolgsrechnung-Abweichung (Block B).
 * „App CHF X höher als ER" / „App CHF X tiefer als ER" / „App und ER stimmen überein".
 */
export function appVsErText(diffCHF: number): string {
  if (diffCHF > BUDGET_DIFF_EPSILON) return `App ${fmtChfWhole(Math.abs(diffCHF))} höher als ER`;
  if (diffCHF < -BUDGET_DIFF_EPSILON) return `App ${fmtChfWhole(Math.abs(diffCHF))} tiefer als ER`;
  return 'App und ER stimmen überein';
}
