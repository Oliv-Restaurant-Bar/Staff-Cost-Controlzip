/**
 * Cockpit-KPI-Budget — Store + Engine (SEPARAT von budget_v1!).
 *
 * Speicherung: KV `cockpit-budget:<jahr>` (tenant-präfixiert via tenantKey),
 * ein Blob pro Jahr + Mandant (CockpitBudgetYear). budget_v1 (P&L) bleibt
 * unangetastet — nur die UMSATZ-Zeilen im Cockpit fallen ohne Cockpit-Budget
 * weiter auf budget_v1 zurück (bestehendes Verhalten).
 *
 * Regeln (Spec):
 *  - Einheiten pro Position: CHF · Anzahl · Stunden · %
 *  - Jahr → 12 Monate pro rata: 'seasonal' (Vorjahres-Ist-Muster GENAU dieser
 *    Kennzahl) oder 'even' (nach Kalendertagen), umschaltbar je Position.
 *  - Präzedenz: expliziter Monat > Jahres-Verteilung; explizite Woche (ISO-
 *    Wochen-Override) > Monats-Ableitung.
 *  - Woche ohne Override = Σ Tagesanteile (Monatswert ÷ Kalendertage des
 *    Monats), über Monatsgrenzen aus beiden Monaten.
 *  - leer statt 0 · nie ÷ 0 · mandantengetrennt · pro Jahr.
 */
import { kvGet, kvSetStrict } from '@/lib/supabase-kv';
import type {
  CockpitBudgetPosition, CockpitBudgetUnit, CockpitBudgetYear, CockpitProrataMode,
} from '@/types/budget';
import { ladeUmsatzTage, nettoUmsatzTag, foodBeverageSplit, vjTagWerte } from '@/lib/umsatz';
import { loadVjDailyMonth, type VjDayRecord } from '@/lib/vj-daily-supabase';
import { loadGaesteDaily } from '@/lib/gaeste-store';
import { ladePersonalkostenDaten, personalkosten } from '@/lib/personalkosten';
import { getMonthlyBudgetRevenue } from '@/lib/budgetDistribution';
import { mwstDivisorTakeaway, mwstDivisorStandard } from '@/lib/mwst';
import type { SocialCostRates } from '@/lib/social-costs';

export type TenantId = 'oliv' | 'beaulieu';
type KeyFn = (key: string) => string;

const r2 = (n: number) => Math.round(n * 100) / 100;
const pad2 = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (year: number, month1: number) => new Date(year, month1, 0).getDate();

// ── Positions-Katalog (Reihenfolge wie im Cockpit) ───────────────────────────

export interface CockpitBudgetKpiDef {
  id: string;
  label: string;
  unit: CockpitBudgetUnit;
  /** base = direkt budgetierbar; ratio = abgeleitet, pro Zeile überschreibbar. */
  kind: 'base' | 'ratio';
  /** Kurzbeschreibung der Ableitung (nur ratio; UI-Hinweis). */
  hint?: string;
  /** Position existiert nur bei diesem Mandanten (z.B. TripAdvisor = Oliv). */
  onlyTenant?: TenantId;
  /** Interne Eingabe-/Treiber-Position (z.B. Anteil-%): NUR Budget-Eingabe —
   *  wird von resolveCockpitBudgets NICHT emittiert (kein Report-Leck). */
  internal?: boolean;
}

export const COCKPIT_BUDGET_KPIS: CockpitBudgetKpiDef[] = [
  // Wareneinsatz ERSETZT die alte Food/Beverage-Budgetaufteilung (eine
  // Position, typischerweise als WKQ-% vom Netto-Umsatz-Budget erfasst).
  { id: 'wareneinsatz',     label: 'Wareneinsatz (netto)', unit: 'chf',   kind: 'base',
    hint: 'Empfohlen: als Wareneinsatzquote % vom Netto-Umsatz-Budget erfassen' },
  { id: 'take_away_umsatz', label: 'Take Away Umsatz (netto)', unit: 'chf', kind: 'base' },
  { id: 'gaeste_in',        label: 'Gäste IN',             unit: 'count', kind: 'base' },
  // Gäste-Kette (Spec 08/2026, Anteils-Logik): Gäste-IN-Budget →
  // Reservierungs-Anteil → reservierte Gäste → Gruppen-Anteil → Gruppen.
  // Beide Anteile sind je Monat überschreibbar (historische Defaults je Mandant).
  { id: 'reservierungs_anteil', label: 'Reservierungs-Anteil (% der Gäste IN)', unit: 'pct', kind: 'base',
    internal: true,
    hint: 'Historischer Monats-Anteil reservierter Gäste an den Gästen IN — treibt «Reservierte Gäste»' },
  { id: 'reservierte_gaeste', label: 'Reservierte Gäste',  unit: 'count', kind: 'base',
    hint: 'Reservierungs-Anteil-% × Gäste-IN-Budget, je Monat' },
  { id: 'gruppen_anteil',   label: 'Gruppen-Anteil ab 20 Pax (% der Reservierten)', unit: 'pct', kind: 'base',
    internal: true,
    hint: 'Historischer Monats-Anteil der Gruppen-Personen an den reservierten Gästen — treibt «Gruppen ab 20 Pax»' },
  { id: 'gruppen_20pax',    label: 'Gruppen ab 20 Pax (Personen)', unit: 'count', kind: 'base',
    hint: 'Gruppen-Anteil-% × reservierte-Gäste-Budget — Budget in PERSONEN' },
  { id: 'prod_stunden',     label: 'Produktive Stunden',   unit: 'hours', kind: 'base' },
  // EIGENER Wert aus dem Dienstplan — bewusst NICHT die Bedarf-Leitplanke.
  { id: 'dienstplan_stunden', label: 'Dienstplan-Stunden (Plan)', unit: 'hours', kind: 'base',
    hint: 'Eigener Wert aus dem Dienstplan (nicht = Bedarf-Stunden)' },
  { id: 'personalkosten',   label: 'Personalkosten',       unit: 'chf',   kind: 'base' },
  { id: 'avg_verkauf_gast', label: 'Ø-Verkauf pro Gast',   unit: 'chf',   kind: 'ratio',
    hint: 'Oliv: (Netto − TA-Netto) ÷ Gäste · Beaulieu: Netto ÷ Gäste' },
  { id: 'personalquote',    label: 'Personalkostenquote',  unit: 'pct',   kind: 'ratio',
    hint: 'Personalkosten ÷ Netto Umsatz × 100' },
  { id: 'produktivitaet',   label: 'Produktivität (Umsatz/Std)', unit: 'chf', kind: 'ratio',
    hint: 'Netto Umsatz ÷ Produktive Stunden' },
  { id: 'take_away_anteil', label: 'Take Away Anteil',     unit: 'pct',   kind: 'ratio',
    hint: 'TA brutto ÷ Brutto Umsatz × 100 (TA-Budget netto wird umgerechnet)' },
  // Bewertungs-Ziele (Anzahl je Monat): ohne Eingabe gelten die Standard-Ziele
  // (5-Sterne = 5/Woche, 1- und 3-Stern = 0) — hier je Monat überschreibbar.
  { id: 'google_5_sterne',  label: 'Google 5 Sterne (Ziel)', unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 5 pro Woche' },
  { id: 'google_3_sterne',  label: 'Google 3 Sterne (Ziel)', unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 0' },
  { id: 'google_1_stern',   label: 'Google 1 Stern (Ziel)',  unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 0' },
  { id: 'tripadvisor_5_sterne', label: 'TripAdvisor 5 Sterne (Ziel)', unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 5 pro Woche', onlyTenant: 'oliv' },
  { id: 'tripadvisor_3_sterne', label: 'TripAdvisor 3 Sterne (Ziel)', unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 0', onlyTenant: 'oliv' },
  { id: 'tripadvisor_1_stern',  label: 'TripAdvisor 1 Stern (Ziel)',  unit: 'count', kind: 'base',
    hint: 'Standard-Ziel ohne Eingabe: 0', onlyTenant: 'oliv' },
];

/**
 * Standard-Bewertungsziel OHNE Cockpit-Budget-Eintrag: 5-Sterne = 5 pro Woche
 * (Monat = 5 × Kalendertage ÷ 7, gerundet; Perioden analog über die Tageszahl),
 * 1- und 3-Stern = 0 (Zielwert — bewusst eine echte 0, kein «leer statt 0»:
 * das Ziel IST null neue schlechte Bewertungen). 2/4 Sterne: kein Ziel (null).
 */
export function reviewZielBudget(star: number, tage: number, fuenfSterneProWoche = 5): number | null {
  if (!(tage > 0)) return null;
  if (star === 5) return Math.round(fuenfSterneProWoche * tage / 7);
  if (star === 3 || star === 1) return 0;
  return null;
}

/**
 * Mandanten-/Plattform-spezifische 5★-Wochenrate (Spec 08/2026):
 * Beaulieu: Google 3/Woche, Lunchgate 10/Woche; Oliv: 5/Woche (Google +
 * TripAdvisor, unverändert). Unbekannte Kombinationen fallen auf 5 zurück.
 */
export function reviewWochenrate(tenantId: TenantId, platform: string): number {
  if (tenantId === 'beaulieu') return platform === 'Google' ? 3 : 10;
  return 5;
}

/**
 * Historische Standard-Anteile je Mandant (Spec 08/2026): Reservierungs-Anteil
 * (% der Gäste IN, Ø 2025+2026 Jan–Jul bzw. 2025 Aug–Dez) und Gruppen-Anteil
 * ab 20 Pax (% der reservierten Gäste). Sie greifen bei den Ableitungen als
 * Vorbelegung, wenn die jeweilige Anteil-Position (noch) leer ist — im Store
 * bleibt der Anteil je Monat überschreibbar.
 */
export const RESERVIERUNGS_ANTEIL_DEFAULT: Record<TenantId, number[]> = {
  oliv:     [39.7, 38.4, 38.6, 28.1, 25.5, 23.2, 14.7, 19.1, 24.1, 31.4, 42.2, 40.5],
  beaulieu: [27.5, 30.3, 30.7, 26.2, 31.3, 28.9, 21.1, 27.8, 29.5, 31.4, 36.2, 43.2],
};
/** Ø-Verkauf-pro-Gast-Ziel-Default je Mandant (CHF, 12 Monatswerte), NIE
 *  mandantenübergreifend: Oliv 29; Beaulieu 21.00 (Spec 08/2026, aus
 *  Gastronovi «Umsatz pro Person», Juli 21.55 — ersetzt die zu tiefen
 *  2025-Ist-Monatswerte ~14.71…). Nur Vorbelegung fürs «Ziel anwenden» —
 *  je Monat überschreibbar. */
export const AVG_VERKAUF_ZIEL_DEFAULT: Record<TenantId, number[]> = {
  oliv: Array(12).fill(29),
  beaulieu: Array(12).fill(21),
};

/**
 * Food-/Beverage-Umsatzanteil 2025 in % des Netto-Umsatzes (Spec 08/2026) —
 * Basis fürs abgeleitete Food-/Beverage-Umsatz-BUDGET (Anteil × Netto-Umsatz-
 * Budget des Monats) und damit fürs Warenkosten-Soll je Kategorie (WEQ ×
 * Kategorie-Umsatz-Budget). Bewusst KEINE eigene Cockpit-Position.
 * Anteile beziehen sich auf (Food + Beverage) und summieren zu 100 % —
 * Food-Budget + Beverage-Budget = Netto-Umsatz-Budget (Korrektur 08/2026).
 */
export const FB_UMSATZ_ANTEIL_2025: Record<TenantId, { food: number; beverage: number }> = {
  oliv: { food: 65.6, beverage: 34.4 },
  beaulieu: { food: 63.7, beverage: 36.3 },
};

/**
 * WEQ-Stufenlogik («letzter Wert hält», Spec 08/2026): ein manuell gesetzter
 * Monats-WEQ gilt für diesen Monat UND alle folgenden, bis ein neuer manueller
 * Wert kommt; ohne (noch) greifenden manuellen Wert gilt Auto/Import.
 * null-Einträge = «leer statt 0» (kein Wert vorhanden).
 */
export function weqMonatswerteMitStufen(
  monthlyValues: (number | null)[], monthlyExplicit: boolean[],
  erNetto: (number | null | undefined)[], autoQ: (number | null)[],
): (number | null)[] {
  const manualQ = monthlyValues.map((v, i) =>
    monthlyExplicit[i] && v !== null && typeof erNetto[i] === 'number' && (erNetto[i] as number) > 0
      ? (v / (erNetto[i] as number)) * 100 : null);
  const eff = weqCarryForward(manualQ, autoQ);
  return monthlyValues.map((v, i) => {
    if (monthlyExplicit[i]) return v; // manueller Monat bleibt exakt stehen
    const n = erNetto[i];
    return eff[i] !== null && typeof n === 'number'
      ? Math.round(n * (eff[i]! / 100) * 100) / 100 : null;
  });
}

/** Kern der Stufenlogik: manuelle Quoten mit Carry-Forward über Auto/Import. */
export function weqCarryForward(
  manuellQ: (number | null)[], autoQ: (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = Array(12).fill(null);
  let carry: number | null = null;
  for (let i = 0; i < 12; i++) {
    if (manuellQ[i] !== null && manuellQ[i] !== undefined) carry = manuellQ[i]!;
    out[i] = manuellQ[i] ?? carry ?? autoQ[i] ?? null;
  }
  return out;
}

export const GRUPPEN_ANTEIL_DEFAULT: Record<TenantId, number[]> = {
  oliv:     [11.9, 4.6, 7.0, 6.5, 11.8, 15.1, 2.6, 1.3, 6.0, 10.3, 16.2, 15.3],
  beaulieu: [13.0, 15.3, 13.5, 14.6, 20.7, 19.9, 6.6, 12.4, 16.9, 20.3, 16.2, 17.4],
};

// ── Store (KV, tenant-präfixiert, pro Jahr) ──────────────────────────────────

export const cockpitBudgetKvKey = (tenantKey: KeyFn, year: number) =>
  tenantKey(`cockpit-budget:${year}`);

export function leereCockpitBudgetPosition(
  id: string, unit: CockpitBudgetUnit,
): CockpitBudgetPosition {
  return {
    id, unit, prorataMode: 'seasonal', yearValue: null,
    monthlyValues: Array(12).fill(null),
    monthlyExplicit: Array(12).fill(false),
    weekOverrides: {},
  };
}

function normalisierePosition(p: unknown, id: string, unit: CockpitBudgetUnit): CockpitBudgetPosition {
  const raw = (p ?? {}) as Partial<CockpitBudgetPosition>;
  const mv = Array.isArray(raw.monthlyValues) ? raw.monthlyValues : [];
  const me = Array.isArray(raw.monthlyExplicit) ? raw.monthlyExplicit : [];
  return {
    id, unit,
    prorataMode: raw.prorataMode === 'even' ? 'even' : 'seasonal',
    yearValue: typeof raw.yearValue === 'number' && isFinite(raw.yearValue) ? raw.yearValue : null,
    monthlyValues: Array.from({ length: 12 }, (_, i) =>
      typeof mv[i] === 'number' && isFinite(mv[i] as number) ? (mv[i] as number) : null),
    monthlyExplicit: Array.from({ length: 12 }, (_, i) => me[i] === true),
    weekOverrides: raw.weekOverrides && typeof raw.weekOverrides === 'object'
      ? Object.fromEntries(Object.entries(raw.weekOverrides)
          .filter(([, v]) => typeof v === 'number' && isFinite(v as number))) as Record<string, number>
      : {},
    inputMode: raw.inputMode === 'pct' ? 'pct' : 'chf',
    pctValue: typeof raw.pctValue === 'number' && isFinite(raw.pctValue) ? raw.pctValue : null,
  };
}

/**
 * NETTO-Umsatz-BUDGET je Monat aus dem ER-/P&L-Budget (budget_v1, pl_revenue —
 * dieselbe Quelle wie die Budget-Spalte im Cockpit/Monatsreport). Die Umsatz-
 * Positionen wurden aus der Cockpit-Budget-Eingabe ENTFERNT: das Umsatz-Budget
 * wird ausschliesslich im Budget-Modul (ER) erfasst; alle %-Rechnungen und
 * Ableitungen hier rechnen gegen diese Monatswerte. ≤ 0 → null («leer statt 0»).
 */
export function erNettoBudgetMonate(year: number, budgetStoreKey: string): (number | null)[] {
  return Array.from({ length: 12 }, (_, i) => {
    const v = getMonthlyBudgetRevenue(year, i, budgetStoreKey);
    return v > 0 ? r2(v) : null;
  });
}

/**
 * Materialisiert Monats-CHF aus einem %-Satz: je Monat % × ER-Netto-Monats-
 * budget (Basis-Monat leer → Monat leer, «leer statt 0»).
 */
export function pctAufMonate(
  pct: number, basisMonate: (number | null)[],
): (number | null)[] {
  return Array.from({ length: 12 }, (_, i) => {
    const b = basisMonate[i];
    return typeof b === 'number' ? r2(b * pct / 100) : null;
  });
}

/** Lädt das Cockpit-Budget eines Jahres (null = noch keines erfasst). */
export async function loadCockpitBudget(
  tenantKey: KeyFn, year: number,
): Promise<CockpitBudgetYear | null> {
  const raw = await kvGet(cockpitBudgetKvKey(tenantKey, year)).catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const blob = raw as Partial<CockpitBudgetYear>;
  const positions: Record<string, CockpitBudgetPosition> = {};
  for (const def of COCKPIT_BUDGET_KPIS) {
    const p = blob.positions?.[def.id];
    if (p) positions[def.id] = normalisierePosition(p, def.id, def.unit);
  }
  // Einmalige, idempotente Migration: Alt-Blobs (ohne taNetto-Marker) haben
  // das TA-Budget BRUTTO gespeichert — beim Laden auf netto umrechnen
  // (Monate, Jahreswert, Wochen-Overrides). Der Marker wird erst beim
  // nächsten Speichern persistiert; bis dahin liegt der Blob unverändert
  // brutto in der DB und wird bei jedem Laden konsistent erneut umgerechnet
  // (nie doppelt: Division immer nur auf dem gespeicherten Brutto-Stand).
  if (blob.taNetto !== true && positions['take_away_umsatz']) {
    const div = mwstDivisorTakeaway();
    const p = positions['take_away_umsatz'];
    p.monthlyValues = p.monthlyValues.map(v => (v === null ? null : r2(v / div)));
    if (p.yearValue !== null) p.yearValue = r2(p.yearValue / div);
    p.weekOverrides = Object.fromEntries(
      Object.entries(p.weekOverrides).map(([k, v]) => [k, r2(v / div)]));
  }
  return { year, positions, updatedAt: String(blob.updatedAt ?? ''), taNetto: true };
}

/** Speichert das komplette Jahres-Blob (kvSetStrict — Finanzdaten). */
export async function saveCockpitBudget(
  tenantKey: KeyFn, blob: CockpitBudgetYear,
): Promise<void> {
  await kvSetStrict(cockpitBudgetKvKey(tenantKey, blob.year), {
    ...blob, updatedAt: new Date().toISOString(),
  });
}

// ── Verteilung Jahr → 12 Monate ──────────────────────────────────────────────

/** Kalendertage je Monat als Gewichte ('even'). */
export function kalendertagGewichte(year: number): number[] {
  return Array.from({ length: 12 }, (_, i) => daysInMonth(year, i + 1));
}

/**
 * Verteilt `yearValue` auf die NICHT expliziten Monate nach `weights` (12
 * Gewichte ≥ 0). Explizite Monate bleiben stehen und werden vom Jahreswert
 * abgezogen (Präzedenz Monat > Jahr). Rundung auf 2 Stellen, Korrektur am
 * letzten nicht-expliziten Monat, damit die Summe exakt stimmt.
 */
export function verteileJahreswert(
  yearValue: number,
  weights: number[],
  monthlyValues: (number | null)[],
  monthlyExplicit: boolean[],
): (number | null)[] {
  const out = monthlyValues.slice();
  const freie = Array.from({ length: 12 }, (_, i) => i).filter(i => !monthlyExplicit[i]);
  if (freie.length === 0) return out;
  const explizit = Array.from({ length: 12 }, (_, i) => i)
    .filter(i => monthlyExplicit[i])
    .reduce((s, i) => s + (monthlyValues[i] ?? 0), 0);
  const rest = yearValue - explizit;
  if (rest <= 0) { for (const i of freie) out[i] = 0; return out; }
  let wSum = freie.reduce((s, i) => s + Math.max(0, weights[i] ?? 0), 0);
  const w = wSum > 0 ? weights : kalendertagGewichte(new Date().getFullYear());
  if (wSum <= 0) wSum = freie.reduce((s, i) => s + w[i], 0);
  let verteilt = 0;
  freie.forEach((i, idx) => {
    if (idx === freie.length - 1) { out[i] = r2(rest - verteilt); return; }
    const v = r2(rest * Math.max(0, w[i] ?? 0) / wSum);
    out[i] = v; verteilt += v;
  });
  return out;
}

/**
 * Saisonale Gewichte = Vorjahres-Ist-MONATSSUMMEN genau dieser Kennzahl.
 * null = keine (oder nur 0-)Vorjahresdaten → Aufrufer fällt auf 'even' zurück.
 * `rates` nur für prod_stunden/personalkosten nötig (Personalkosten-Kern).
 * take_away_umsatz liefert NETTO-Summen (TA-brutto ÷ TA-MwSt-Divisor) —
 * die TA-Budget-Position ist netto («Überall nur Netto»).
 */
export async function ladeSaisonGewichte(
  tenantId: TenantId,
  tenantKey: KeyFn,
  vorjahr: number,
  kpiId: string,
  rates?: SocialCostRates | null,
): Promise<number[] | null> {
  const sums = Array(12).fill(0) as number[];
  let hat = false;
  const add = (dateIso: string, v: number) => {
    if (!(v > 0) || !dateIso.startsWith(`${vorjahr}-`)) return;
    sums[Number(dateIso.slice(5, 7)) - 1] += v; hat = true;
  };

  if (kpiId === 'gaeste_in') {
    const daily = await loadGaesteDaily(tenantKey).catch(() => ({} as Record<string, number>));
    for (const [d, n] of Object.entries(daily)) add(d, n);
    return hat ? sums : null;
  }

  if (kpiId === 'prod_stunden' || kpiId === 'personalkosten') {
    if (!rates) return null;
    for (let mo = 1; mo <= 12; mo++) {
      const pk = await ladePersonalkostenDaten(vorjahr, mo, tenantId, tenantKey, rates)
        .catch(() => null);
      if (!pk) continue;
      if (kpiId === 'prod_stunden') {
        for (const [d, perEmp] of Object.entries(pk.istStdProTag))
          for (const h of Object.values(perEmp)) add(d, h);
      } else {
        const s = personalkosten(pk, 'istBisHeute');
        if (s.total > 0) { sums[mo - 1] += s.total; hat = true; }
      }
    }
    return hat ? sums : null;
  }

  // Umsatz-Familie: primär dailyBudgets (ladeUmsatzTage), sonst vj_daily.
  const von = `${vorjahr}-01-01`, bis = `${vorjahr}-12-31`;
  const tage = await ladeUmsatzTage(tenantId, von, bis).catch(() => new Map());
  let hatTage = false;
  for (const [date, tag] of tage) {
    if (tag.gesamtBrutto <= 0) continue;
    hatTage = true;
    const netto = nettoUmsatzTag(tag);
    const split = foodBeverageSplit(tag);
    if (kpiId === 'brutto_umsatz') add(date, tag.gesamtBrutto);
    else if (kpiId === 'netto_umsatz') add(date, netto);
    else if (kpiId === 'food') add(date, split.food);
    else if (kpiId === 'beverage') add(date, split.beverage);
    else if (kpiId === 'take_away_umsatz') add(date, tag.takeAwayBrutto / mwstDivisorTakeaway());
  }
  if (!hatTage) {
    for (let mo = 1; mo <= 12; mo++) {
      const map = await loadVjDailyMonth(vorjahr, mo, tenantId)
        .catch(() => ({} as Record<string, VjDayRecord>));
      for (const [date, rec] of Object.entries(map)) {
        const w = vjTagWerte(tenantId, rec, date);
        if (kpiId === 'brutto_umsatz') add(date, Number(rec.actualRevenue ?? 0));
        else if (kpiId === 'take_away_umsatz') add(date, Number(rec.takeawayRevenue ?? 0) / mwstDivisorTakeaway());
        else if (w) {
          if (kpiId === 'netto_umsatz') add(date, w.netto);
          else if (kpiId === 'food') add(date, w.food);
          else if (kpiId === 'beverage') add(date, w.beverage);
        }
      }
    }
  }
  return hat ? sums : null;
}

// ── Auto-Befüllung: Ist-Monatswerte («Stand der Dinge») ─────────────────────

/** Abgeschlossene Monate (1-basiert) eines Jahres: laufendes Jahr bis zum
 *  Vormonat (der laufende Monat ist unvollständig), Vergangenheit = alle 12. */
export function abgeschlosseneMonate(year: number, heute: Date = new Date()): number[] {
  const cy = heute.getFullYear();
  if (year > cy) return [];
  const maxM = year === cy ? heute.getMonth() : 12; // getMonth() = Vormonat-Anzahl
  return Array.from({ length: maxM }, (_, i) => i + 1);
}

/** Ist-Waren-CHF (netto, nur Waren-Kontoklassen) je Monat eines Jahres. */
async function warenIstMonate(tenantId: TenantId, year: number): Promise<number[] | null> {
  const [{ loadMonthInvoices, loadWarenkostenGrenze }, { nurWarenAnteil }, { sumInvoicesNet }] =
    await Promise.all([
      import('@/lib/waren-db'), import('@/lib/waren-klassen'), import('@/lib/waren-cockpit')]);
  const grenze = await loadWarenkostenGrenze(tenantId).catch(() => undefined);
  const sums = Array(12).fill(0) as number[];
  let hat = false;
  await Promise.all(Array.from({ length: 12 }, (_, i) => i + 1).map(async m => {
    const inv = await loadMonthInvoices(tenantId, `${year}-${pad2(m)}`).catch(() => null);
    if (inv) {
      const v = sumInvoicesNet(nurWarenAnteil(inv, grenze));
      if (v > 0) { sums[m - 1] = v; hat = true; }
    }
  }));
  return hat ? sums : null;
}

/**
 * Ist-MONATSWERTE ALLER Budget-Positionen eines Jahres in EINEM Durchlauf
 * (Basis des Autofills «Ist-Werte übernehmen»): jede Quelle wird genau EINMAL
 * geladen; die Quoten-Zeilen rechnen auf denselben Arrays wie die absoluten
 * Zeilen (Zähler ÷ Nenner desselben Monats) — damit ist strukturell
 * ausgeschlossen, dass eine Basis-Position füllt, ihre Quote aber leer bleibt
 * (der alte Pfad lud jede Quelle pro Quote erneut; die parallelen Mehrfach-
 * Läufe der teuren Personalkosten-Ladung schlugen still fehl → Quoten leer).
 * Fehlerpfade werden geloggt statt still geschluckt.
 *
 * Werte: je Monat der echte Ist-Wert, null wo keine Daten («leer statt 0» —
 * 0-Summen gelten als fehlende Daten, die Quellen können echte 0 nicht
 * unterscheiden). take_away_umsatz ist NETTO. Position ohne Quelle → null.
 */
export async function istMonatswerteAlle(
  tenantId: TenantId, tenantKey: KeyFn, year: number,
  rates?: SocialCostRates | null,
): Promise<Record<string, (number | null)[] | null>> {
  const lade = (id: string) =>
    ladeSaisonGewichte(tenantId, tenantKey, year, id, rates ?? null)
      .catch(e => { console.error(`[CK-AUTOFILL] Ist-Quelle «${id}» (${year}) fehlgeschlagen:`, e); return null; });
  // Quellen EINMAL laden (netto/brutto sind keine Positionen mehr, aber
  // Nenner/Zähler der Quoten und der Ø-Verkauf-Rechnung).
  const [netto, brutto, ta, gaeste, stunden, pk, waren] = await Promise.all([
    lade('netto_umsatz'), lade('brutto_umsatz'), lade('take_away_umsatz'),
    lade('gaeste_in'), lade('prod_stunden'), lade('personalkosten'),
    warenIstMonate(tenantId, year)
      .catch(e => { console.error(`[CK-AUTOFILL] Waren-Ist (${year}) fehlgeschlagen:`, e); return null; }),
  ]);
  const zuMonaten = (arr: number[] | null): (number | null)[] | null =>
    arr ? arr.map(v => (v > 0 ? r2(v) : null)) : null;
  const quote = (
    z: number[] | null, n: number[] | null, map: (z: number, n: number) => number,
  ): (number | null)[] | null => {
    if (!z || !n) return null;
    const out = Array.from({ length: 12 }, (_, i) =>
      z[i] > 0 && n[i] > 0 ? r2(map(z[i], n[i])) : null);
    return out.some(v => v !== null) ? out : null;
  };
  const avg = (() => {
    if (!netto || !gaeste) return null;
    const out = Array.from({ length: 12 }, (_, i) => {
      if (!(netto[i] > 0) || !(gaeste[i] > 0)) return null;
      const z = tenantId === 'oliv' ? netto[i] - (ta?.[i] ?? 0) : netto[i]; // ta bereits netto
      return z > 0 ? r2(z / gaeste[i]) : null;
    });
    return out.some(v => v !== null) ? out : null;
  })();
  return {
    take_away_umsatz: zuMonaten(ta),
    gaeste_in: zuMonaten(gaeste),
    prod_stunden: zuMonaten(stunden),
    personalkosten: zuMonaten(pk),
    wareneinsatz: zuMonaten(waren),
    personalquote: quote(pk, netto, (z, n) => (z / n) * 100),
    produktivitaet: quote(netto, stunden, (n, st) => n / st),
    // Ist-Anteil wie die Cockpit-Ist-Seite: TA-BRUTTO ÷ Brutto-Umsatz × 100
    // (ta ist netto → zurückrechnen).
    take_away_anteil: quote(ta, brutto, (z, n) => (z * mwstDivisorTakeaway() / n) * 100),
    avg_verkauf_gast: avg,
  };
}

// ── Ziel-/Ableitungs-Quellen (Budget-Eingabe) ────────────────────────────────

/**
 * KALKULIERTE Wareneinsatzquote je Monat aus den Gastronovi-Verkaufsdaten:
 * je Monat Σ(Menge × WES-Stückkosten) ÷ Σ Umsatz der Produkte MIT bekanntem
 * WES × 100 (umsatzgewichtete Produkt-WES-Q; product_sales × produkte_kosten).
 * Monate ohne zuordenbare Verkäufe → null («leer statt 0»). Paginiert wegen
 * PostgREST-Zeilen-Cap; deterministische Ordnung für stabile Seiten.
 */
export async function kalkulierteWeqMonate(
  tenantId: TenantId, year: number,
): Promise<(number | null)[]> {
  const [{ supabase }, { loadProductWesMap }] = await Promise.all([
    import('@/integrations/supabase/client'), import('@/lib/sales-db')]);
  const wes = await loadProductWesMap();
  if (wes.size === 0) return Array(12).fill(null);
  const cost = Array(12).fill(0) as number[];
  const rev = Array(12).fill(0) as number[];
  const PAGE = 1000;
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await (supabase as any)
      .from('product_sales')
      .select('product_name, quantity, revenue, sale_date')
      .eq('restaurant_id', tenantId)
      .gte('sale_date', `${year}-01-01`).lte('sale_date', `${year}-12-31`)
      .order('sale_date', { ascending: true })
      .order('id', { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`product_sales: ${error.message}`);
    const rows = (data ?? []) as Array<{ product_name: string | null; quantity: number | null; revenue: number | null; sale_date: string | null }>;
    for (const r of rows) {
      const w = wes.get(String(r.product_name ?? '').trim().toLowerCase());
      if (w === undefined || !(w > 0)) continue; // nur Produkte mit bekanntem WES
      const m = Number(String(r.sale_date ?? '').slice(5, 7));
      const rv = Number(r.revenue ?? 0);
      if (!(m >= 1 && m <= 12) || !(rv > 0)) continue;
      cost[m - 1] += Number(r.quantity ?? 0) * w;
      rev[m - 1] += rv;
    }
    if (rows.length < PAGE) break;
  }
  return Array.from({ length: 12 }, (_, i) =>
    rev[i] > 0 ? r2((cost[i] / rev[i]) * 100) : null);
}

/**
 * Personalbedarf-SOLL-Stunden je Monat (netto, mit ArG-Pausenabzug): Summe
 * bedarfNettoHoursForDate über alle Kalendertage des Monats (Saison-Profil
 * je Datum). Kein Personalbedarf hinterlegt → alle Monate null (nie 0).
 */
export async function bedarfSollStundenMonate(
  tenantId: TenantId, year: number,
): Promise<(number | null)[]> {
  const [{ loadStaffingRequirements }, { loadStaffingProfilesConfig },
    { loadPositions }, { bedarfNettoHoursForDates }] = await Promise.all([
    import('@/lib/staffing-requirements-db'), import('@/lib/staffing-profiles-db'),
    import('@/lib/positions-db'), import('@/lib/bedarf-stunden-utils')]);
  const [requirements, config, positions] = await Promise.all([
    loadStaffingRequirements(tenantId), loadStaffingProfilesConfig(tenantId),
    loadPositions(tenantId)]);
  if (!config || requirements.length === 0 || positions.length === 0) {
    return Array(12).fill(null);
  }
  return Array.from({ length: 12 }, (_, i) => {
    const dim = daysInMonth(year, i + 1);
    const dates = Array.from({ length: dim }, (_, d) => `${year}-${pad2(i + 1)}-${pad2(d + 1)}`);
    return bedarfNettoHoursForDates({ positions, requirements, config, dates });
  });
}

/**
 * DIENSTPLAN-Stunden je Monat (netto, ArG-Pausenabzug): EIGENER Wert aus dem
 * tatsächlichen Dienstplan (planNettoHoursForDates) — bewusst NICHT der
 * Personalbedarf. Monate ohne Dienstplan-Einträge → null (nie 0).
 */
export async function dienstplanStundenMonate(
  tenantId: TenantId, year: number,
): Promise<(number | null)[]> {
  const [{ loadEmployees, loadScheduleForMonth }, { loadPositions },
    { planNettoHoursForDates }] = await Promise.all([
    import('@/lib/supabase-db'), import('@/lib/positions-db'),
    import('@/lib/bedarf-stunden-utils')]);
  const [employees, positions] = await Promise.all([
    loadEmployees(tenantId), loadPositions(tenantId)]);
  if (!employees || employees.length === 0) return Array(12).fill(null);
  return Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const scheduleData = await loadScheduleForMonth(new Date(year, i, 1), tenantId)
      .catch(() => null);
    if (!scheduleData) return null;
    const dim = daysInMonth(year, i + 1);
    const dates = Array.from({ length: dim }, (_, d) => `${year}-${pad2(i + 1)}-${pad2(d + 1)}`);
    return planNettoHoursForDates({ employees, scheduleData, positions, dates });
  }));
}

/**
 * IST-Reservationskette je Monat eines Jahres (Foratable-Quelle, zentrale
 * Zählregel): reservierte Gäste (Σ Personen gezählter Reservationen).
 * Monate ohne Daten → null.
 */
export async function reservierteGaesteIstMonate(
  tenantId: TenantId, tenantKey: KeyFn, year: number,
): Promise<(number | null)[]> {
  const [{ loadReservationCounting, DEFAULT_RESERVATION_COUNTING },
    { loadReservationMetrics }] = await Promise.all([
    import('@/lib/reservation-cockpit-settings'), import('@/lib/reservation-cockpit-metrics')]);
  const counting = (await loadReservationCounting(tenantKey).catch(() => null))
    ?? DEFAULT_RESERVATION_COUNTING;
  return Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const from = `${year}-${pad2(i + 1)}-01`;
    const to = `${year}-${pad2(i + 1)}-${pad2(daysInMonth(year, i + 1))}`;
    const m = await loadReservationMetrics(tenantId, from, to, counting)
      .catch(() => ({ reservedGuests: null }));
    return m.reservedGuests ?? null;
  }));
}

/**
 * IST «Gruppen ab 20 Pax» je Monat eines Jahres — in PERSONEN (Σ Personen der
 * grossen Gruppen, gleiche Einheit wie die Budget-Position gruppen_20pax).
 * Quelle Foratable-Reservationen, zentrale Zählregel. Monate ohne Daten → null
 * («leer statt 0», nie erfinden). Basis für «Aus Vorjahr übernehmen».
 */
export async function gruppenPersonenIstMonate(
  tenantId: TenantId, tenantKey: KeyFn, year: number,
): Promise<(number | null)[]> {
  const [{ loadReservationCounting, DEFAULT_RESERVATION_COUNTING },
    { loadReservationMetrics }] = await Promise.all([
    import('@/lib/reservation-cockpit-settings'), import('@/lib/reservation-cockpit-metrics')]);
  const counting = (await loadReservationCounting(tenantKey).catch(() => null))
    ?? DEFAULT_RESERVATION_COUNTING;
  return Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const from = `${year}-${pad2(i + 1)}-01`;
    const to = `${year}-${pad2(i + 1)}-${pad2(daysInMonth(year, i + 1))}`;
    const m = await loadReservationMetrics(tenantId, from, to, counting)
      .catch(() => ({ largeGroupPersons: null }));
    return m.largeGroupPersons ?? null;
  }));
}

// ── Auflösung (Monat / Woche / Periode) ──────────────────────────────────────

/** ISO-Wochen-Schlüssel 'GGGG-Www' eines Datums (ISO-Wochenjahr!). */
export function isoWeekKey(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const t = new Date(d);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // Donnerstag der Woche
  const kwYear = t.getFullYear();
  const jan4 = new Date(kwYear, 0, 4);
  const mon1 = new Date(jan4);
  mon1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const kw = Math.round((t.getTime() - mon1.getTime()) / 86400000 / 7) + 1;
  return `${kwYear}-W${pad2(kw)}`;
}

/** Monatswert (1-basiert); null = kein Budget. */
export function monatsBudget(pos: CockpitBudgetPosition | undefined, month1: number): number | null {
  return pos?.monthlyValues[month1 - 1] ?? null;
}

/**
 * Perioden-Budget [fromIso..toIso] als Σ Tagesanteile (Monatswert ÷ Kalender-
 * tage), über Monatsgrenzen hinweg. Damit ist die Stichtag-Kappung («Budget
 * pro rata bis heute», wie Personalkosten-pro-rata) automatisch enthalten.
 * null, wenn KEIN berührter Monat einen Wert hat («leer statt 0»).
 * Für %-Positionen (Quoten) NICHT summieren — dort tagesgewichteter Mittelwert.
 */
export function periodenBudget(
  pos: CockpitBudgetPosition | undefined, fromIso: string, toIso: string,
): number | null {
  if (!pos || !fromIso || !toIso || fromIso > toIso) return null;
  const y0 = Number(fromIso.slice(0, 4)), m0 = Number(fromIso.slice(5, 7));
  const y1 = Number(toIso.slice(0, 4)), m1 = Number(toIso.slice(5, 7));
  let sum = 0, hat = false, tage = 0, quoteSum = 0;
  for (let y = y0; y <= y1; y++) {
    const mFrom = y === y0 ? m0 : 1, mTo = y === y1 ? m1 : 12;
    for (let m = mFrom; m <= mTo; m++) {
      const dim = daysInMonth(y, m);
      const a = y === y0 && m === m0 ? Number(fromIso.slice(8, 10)) : 1;
      const b = y === y1 && m === m1 ? Number(toIso.slice(8, 10)) : dim;
      const overlap = b - a + 1;
      if (overlap <= 0) continue;
      const v = pos.monthlyValues[m - 1];
      tage += overlap;
      if (v === null || v === undefined) continue;
      hat = true;
      sum += v * overlap / dim;
      quoteSum += v * overlap;
    }
  }
  if (!hat) return null;
  return pos.unit === 'pct' ? r2(quoteSum / tage) : r2(sum);
}

/**
 * Wochen-Budget für die (ggf. geklemmten) Tage einer Woche:
 *  - Wochen-Override der ISO-Woche vorhanden → Override × Tage/7 (Klemmung).
 *  - sonst Σ Tagesanteile der berührten Monate (periodenBudget-Regel).
 * %-Positionen: Override gilt UNGEKÜRZT (Quote, kein Mengenwert).
 */
export function wochenBudget(
  pos: CockpitBudgetPosition | undefined, weekDays: string[],
): number | null {
  if (!pos || weekDays.length === 0) return null;
  const key = isoWeekKey(weekDays[0]);
  const ov = pos.weekOverrides[key];
  if (typeof ov === 'number') {
    if (pos.unit === 'pct') return r2(ov);
    return r2(ov * weekDays.length / 7);
  }
  return periodenBudget(pos, weekDays[0], weekDays[weekDays.length - 1]);
}

// ── Abgeleitete (Verhältnis-)Budgets ─────────────────────────────────────────

export interface BasisBudgets {
  /** ER-Netto-Umsatz-Budget der Periode (Quelle: Budget-Modul/ER, budget_v1). */
  netto: number | null; ta: number | null;
  gaeste: number | null; stunden: number | null; pk: number | null;
}

/**
 * Verhältnis-Budget aus Basis-Budgets derselben Periode. Ein direktes
 * Override der Ratio-Position hat Vorrang (Aufrufer prüft zuerst selbst).
 * nie ÷ 0 — fehlender Nenner → null.
 *
 * BEWUSST Ratio der PERIODEN-TOTALE (nicht tagesgewichteter Mittelwert der
 * Monatsquoten): die Ist-Seite rechnet exakt gleich (z.B. TA-Anteil-Ist =
 * Σ TA ÷ Σ Brutto, Ø-Verkauf-Ist = Σ Verkauf ÷ Σ Gäste) — Budget und Ist
 * müssen dieselbe Methodik haben, sonst hinkt der Vergleich. Die Tages-
 * gewichtung in periodenBudget gilt nur für DIREKT erfasste %-Monatswerte.
 */
export function ratioBudget(kpiId: string, tenantId: TenantId, b: BasisBudgets): number | null {
  switch (kpiId) {
    case 'avg_verkauf_gast': {
      if (b.netto === null || b.gaeste === null || b.gaeste <= 0) return null;
      // b.ta ist NETTO (TA-Budget-Position netto) — direkt abziehen.
      const zaehler = tenantId === 'oliv' ? b.netto - (b.ta ?? 0) : b.netto;
      return r2(zaehler / b.gaeste);
    }
    case 'personalquote':
      return b.pk !== null && b.netto !== null && b.netto > 0
        ? r2((b.pk / b.netto) * 100) : null;
    case 'produktivitaet':
      return b.netto !== null && b.stunden !== null && b.stunden > 0
        ? r2(b.netto / b.stunden) : null;
    case 'take_away_anteil': {
      // TA-Budget ist netto, der Ist-Anteil rechnet brutto ÷ brutto. Das
      // Brutto-Budget wird EXAKT nach der App-Netto-Split-Regel aus dem
      // ER-Netto-Budget rekonstruiert: brutto = (netto−ta)×divStd + ta×divTA.
      if (b.ta === null || b.netto === null) return null;
      const bruttoRek = (b.netto - b.ta) * mwstDivisorStandard() + b.ta * mwstDivisorTakeaway();
      return bruttoRek > 0 ? r2((b.ta * mwstDivisorTakeaway() / bruttoRek) * 100) : null;
    }
    default:
      return null;
  }
}

/**
 * Ziel-Personalkostenquote für das abgeleitete WOCHEN-Budget (Spec 08/2026):
 * PK-Wochen-Budget = 40 % × Netto-Umsatz-Budget der Woche, PKQ-Budget = 40 %
 * konstant. Spiegelt die harte Obergrenze der Personalkosten-Seite (40 %).
 */
export const PK_WOCHEN_ZIELQUOTE_PCT = 40;

/**
 * Komfort: alle aufgelösten Budgets einer Periode (Basis via periodenBudget,
 * Ratios mit Override-Vorrang). `weekDays` gesetzt → Wochenauflösung
 * (Wochen-Overrides greifen), sonst [fromIso..toIso].
 */
export function resolveCockpitBudgets(
  blob: CockpitBudgetYear | null,
  tenantId: TenantId,
  fromIso: string,
  toIso: string,
  weekDays?: string[],
  /** ER-Netto-Monatsbudgets (erNettoBudgetMonate) des Jahres von fromIso —
   *  Nenner der Verhältnis-Budgets (die Umsatz-Positionen wurden aus dem
   *  Cockpit-Budget entfernt; Umsatz-Budget = ER-/P&L-Budget). Ohne Angabe
   *  bleiben die Ratio-Budgets ohne direkten Override null. */
  erNettoMonate?: (number | null)[] | null,
  /** Opt-in (NUR Wochenübersicht des Monatsreports): fehlendes PK-Budget der
   *  Woche als 40 % × Netto-Wochenbudget ableiten (PKQ dadurch konstant 40 %).
   *  Bewusst KEIN Default — andere Wochen-Aufrufer (z.B. Wochenverlauf)
   *  behalten ihr bisheriges Verhalten (leer statt abgeleitet). */
  pkZielFallback = false,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const get = (id: string) => blob?.positions[id];
  const val = (id: string) => weekDays
    ? wochenBudget(get(id), weekDays)
    : periodenBudget(get(id), fromIso, toIso);
  for (const def of COCKPIT_BUDGET_KPIS) {
    if (def.kind === 'base' && !def.internal) out[def.id] = val(def.id);
  }
  // Pseudo-Position fürs ER-Netto: identische Pro-rata-/Wochenauflösung wie
  // echte Positionen (Wochen über den Jahreswechsel teilen die bekannte
  // Jahres-Blob-Grenze aller Cockpit-Positionen).
  const nettoPos: CockpitBudgetPosition | undefined = erNettoMonate
    ? { ...leereCockpitBudgetPosition('er_netto', 'chf'), monthlyValues: erNettoMonate }
    : undefined;
  const nettoVal = nettoPos
    ? (weekDays ? wochenBudget(nettoPos, weekDays) : periodenBudget(nettoPos, fromIso, toIso))
    : null;
  // Umsatz-Budgets fürs Reporting mit ausgeben (die Positionen existieren
  // nicht mehr — Quelle ist das ER-Budget): netto = ER pro rata; brutto exakt
  // nach der App-Netto-Split-Regel rekonstruiert (TA-Anteil mit TA-Satz).
  out['netto_umsatz'] = nettoVal !== null ? r2(nettoVal) : null;
  out['brutto_umsatz'] = nettoVal !== null
    ? r2((nettoVal - (out['take_away_umsatz'] ?? 0)) * mwstDivisorStandard()
        + (out['take_away_umsatz'] ?? 0) * mwstDivisorTakeaway())
    : null;
  // Personalkosten-Wochen-Budget (Spec 08/2026): ohne direkte PK-Position gilt
  // in der WOCHEN-Auflösung die Zielquote 40 % × Netto-Budget der Woche; die
  // Personalquote wird damit automatisch konstant 40 % (Ratio pk/netto).
  if (pkZielFallback && weekDays && out['personalkosten'] == null && nettoVal !== null) {
    out['personalkosten'] = r2(nettoVal * (PK_WOCHEN_ZIELQUOTE_PCT / 100));
  }
  const basis: BasisBudgets = {
    netto: nettoVal,
    ta: out['take_away_umsatz'], gaeste: out['gaeste_in'],
    stunden: out['prod_stunden'], pk: out['personalkosten'],
  };
  // Direkte Overrides auf Ratio-Zeilen sind VERHÄLTNIS-Werte: sie bleiben über
  // alle Perioden KONSTANT (nie pro rata teilen — sonst wird z.B. ein
  // Ø-Verkauf-Monatswert 29 zur Wochen-«Quote» 6.55). Auflösung deshalb immer
  // mit Quoten-Semantik (tagesgewichteter Mittelwert / KW-Override ungekürzt),
  // unabhängig von der Anzeige-Einheit (chf bei Ø-Verkauf/Produktivität).
  const valKonstant = (id: string): number | null => {
    const pos = get(id);
    if (!pos) return null;
    const quotePos: CockpitBudgetPosition = { ...pos, unit: 'pct' };
    return weekDays
      ? wochenBudget(quotePos, weekDays)
      : periodenBudget(quotePos, fromIso, toIso);
  };
  for (const def of COCKPIT_BUDGET_KPIS) {
    if (def.kind !== 'ratio') continue;
    const override = valKonstant(def.id); // direkte Eingabe auf der Ratio-Zeile
    out[def.id] = override !== null ? override : ratioBudget(def.id, tenantId, basis);
  }
  return out;
}
