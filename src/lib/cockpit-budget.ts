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
import { mwstDivisorTakeaway } from '@/lib/mwst';
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
}

export const COCKPIT_BUDGET_KPIS: CockpitBudgetKpiDef[] = [
  { id: 'brutto_umsatz',    label: 'Brutto Umsatz',        unit: 'chf',   kind: 'base' },
  { id: 'netto_umsatz',     label: 'Netto Umsatz',         unit: 'chf',   kind: 'base' },
  { id: 'food',             label: 'Food (netto)',         unit: 'chf',   kind: 'base' },
  { id: 'beverage',         label: 'Beverage (netto)',     unit: 'chf',   kind: 'base' },
  { id: 'take_away_umsatz', label: 'Take Away Umsatz (brutto)', unit: 'chf', kind: 'base' },
  { id: 'gaeste_in',        label: 'Gäste IN',             unit: 'count', kind: 'base' },
  { id: 'prod_stunden',     label: 'Produktive Stunden',   unit: 'hours', kind: 'base' },
  { id: 'personalkosten',   label: 'Personalkosten',       unit: 'chf',   kind: 'base' },
  { id: 'avg_verkauf_gast', label: 'Ø-Verkauf pro Gast',   unit: 'chf',   kind: 'ratio',
    hint: 'Oliv: (Netto − TA-Netto) ÷ Gäste · Beaulieu: Netto ÷ Gäste' },
  { id: 'personalquote',    label: 'Personalkostenquote',  unit: 'pct',   kind: 'ratio',
    hint: 'Personalkosten ÷ Netto Umsatz × 100' },
  { id: 'produktivitaet',   label: 'Produktivität (Umsatz/Std)', unit: 'chf', kind: 'ratio',
    hint: 'Netto Umsatz ÷ Produktive Stunden' },
  { id: 'take_away_anteil', label: 'Take Away Anteil',     unit: 'pct',   kind: 'ratio',
    hint: 'TA brutto ÷ Brutto Umsatz × 100' },
];

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
  };
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
  return { year, positions, updatedAt: String(blob.updatedAt ?? '') };
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
    else if (kpiId === 'take_away_umsatz') add(date, tag.takeAwayBrutto);
  }
  if (!hatTage) {
    for (let mo = 1; mo <= 12; mo++) {
      const map = await loadVjDailyMonth(vorjahr, mo, tenantId)
        .catch(() => ({} as Record<string, VjDayRecord>));
      for (const [date, rec] of Object.entries(map)) {
        const w = vjTagWerte(tenantId, rec, date);
        if (kpiId === 'brutto_umsatz') add(date, Number(rec.actualRevenue ?? 0));
        else if (kpiId === 'take_away_umsatz') add(date, Number(rec.takeawayRevenue ?? 0));
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
  brutto: number | null; netto: number | null; ta: number | null;
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
      const zaehler = tenantId === 'oliv'
        ? b.netto - (b.ta ?? 0) / mwstDivisorTakeaway()
        : b.netto;
      return r2(zaehler / b.gaeste);
    }
    case 'personalquote':
      return b.pk !== null && b.netto !== null && b.netto > 0
        ? r2((b.pk / b.netto) * 100) : null;
    case 'produktivitaet':
      return b.netto !== null && b.stunden !== null && b.stunden > 0
        ? r2(b.netto / b.stunden) : null;
    case 'take_away_anteil':
      return b.ta !== null && b.brutto !== null && b.brutto > 0
        ? r2((b.ta / b.brutto) * 100) : null;
    default:
      return null;
  }
}

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
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const get = (id: string) => blob?.positions[id];
  const val = (id: string) => weekDays
    ? wochenBudget(get(id), weekDays)
    : periodenBudget(get(id), fromIso, toIso);
  for (const def of COCKPIT_BUDGET_KPIS) if (def.kind === 'base') out[def.id] = val(def.id);
  const basis: BasisBudgets = {
    brutto: out['brutto_umsatz'], netto: out['netto_umsatz'],
    ta: out['take_away_umsatz'], gaeste: out['gaeste_in'],
    stunden: out['prod_stunden'], pk: out['personalkosten'],
  };
  for (const def of COCKPIT_BUDGET_KPIS) {
    if (def.kind !== 'ratio') continue;
    const override = val(def.id); // direkte Eingabe auf der Ratio-Zeile
    out[def.id] = override !== null ? override : ratioBudget(def.id, tenantId, basis);
  }
  return out;
}
