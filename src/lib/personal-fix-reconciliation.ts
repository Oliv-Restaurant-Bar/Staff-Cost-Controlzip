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
  /** FIBU: explizit erfasster Personalaufwand-Ist (`personnelCostActual`), falls > 0. */
  personnelCostActual: number | null | undefined;
  /** FIBU: aus 5xxx abgeleiteter Personalaufwand (PL-Engine `total_personnel`, „clean"). */
  plTotalPersonnel: number | null | undefined;
  /** P&L-Nettoumsatz (`net_revenue.actual`) — nur als Kontroll-/Referenzwert. */
  plNetRevenue: number | null | undefined;
  /** Umsatz für BEIDE Quoten (identischer Nenner → Prozentpunkte vergleichbar). */
  effectiveRevenue: number;
}

export type ErfolgsrechnungVergleich =
  | { status: 'missing' }
  | {
      status: 'ok';
      /** Effektiver Personalaufwand laut Erfolgsrechnung. */
      fibuCHF: number;
      /** Herkunft des FIBU-Werts. */
      fibuSource: 'personnelCostActual' | 'pl5xxx';
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
 * Vergleicht den berechneten Personalaufwand mit der Erfolgsrechnung.
 *
 * FIBU-Wert: `personnelCostActual` (> 0) hat Vorrang, sonst der aus 5xxx
 * abgeleitete PL-Wert — exakt die Regel der Reporting-Seite (Single Source
 * of Truth). Der FIBU-Wert enthält BEREITS den effektiven Arbeitgeberaufwand
 * und wird NIE zusätzlich mit dem Sozialkostenfaktor multipliziert.
 *
 * Fehlt beides → `{ status: 'missing' }` (Aufrufer zeigt „keine Erfolgsrechnung",
 * niemals 0).
 */
export function buildErfolgsrechnungVergleich(
  i: ErfolgsrechnungVergleichInput,
): ErfolgsrechnungVergleich {
  const explicit =
    i.personnelCostActual != null && i.personnelCostActual > 0 ? i.personnelCostActual : null;
  const derived =
    i.plTotalPersonnel != null && i.plTotalPersonnel > 0 ? i.plTotalPersonnel : null;
  const fibuCHF = explicit ?? derived;
  if (fibuCHF == null) return { status: 'missing' };

  const fibuSource: 'personnelCostActual' | 'pl5xxx' =
    explicit != null ? 'personnelCostActual' : 'pl5xxx';

  const berechnetPct = safePkQuote(i.berechnetCHF, i.effectiveRevenue);
  const fibuPct = safePkQuote(fibuCHF, i.effectiveRevenue);
  const diffPp = berechnetPct != null && fibuPct != null ? berechnetPct - fibuPct : null;

  const revenueMismatch =
    i.plNetRevenue != null && i.plNetRevenue > 0 && i.effectiveRevenue > 0
      ? Math.abs(i.plNetRevenue - i.effectiveRevenue) / i.effectiveRevenue > REVENUE_MISMATCH_THRESHOLD
      : false;

  return {
    status: 'ok',
    fibuCHF,
    fibuSource,
    berechnetCHF: i.berechnetCHF,
    diffCHF: i.berechnetCHF - fibuCHF,
    berechnetPct,
    fibuPct,
    diffPp,
    tone: toneForDiffPp(diffPp),
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
