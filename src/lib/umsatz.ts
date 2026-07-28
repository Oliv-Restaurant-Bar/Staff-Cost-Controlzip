/**
 * umsatz.ts — EINZIGE gemeinsame Netto-Umsatz-Quelle (Single Source of Truth)
 * ===========================================================================
 * Kanonische Netto-Umsatz-Berechnung pro Tag, summierbar auf Woche/Monat.
 * Konsumenten: Personalkosten (PKQ) und Monatsreport — KEINE zweite
 * Umsatzberechnung mehr ausserhalb dieser Datei.
 *
 * Quellen (VERBINDLICH — Z-Berichte/gn_imports werden hier NICHT gelesen,
 * sie dienen nur den Tagesabschlüssen):
 *  - dailyBudgets (KV, tenant-präfixiert) — MANUELLER Tagesumsatz-Import
 *    («Nach Speisekarte»-Excel):
 *      actualRevenue   = Gesamt brutto («Gesamt»-Zeile, inkl. Take Away,
 *                        nach Rabatten)
 *      takeawayRevenue = Take-Away brutto («Take Away»-Zeile, Teil von Gesamt)
 *      actualFood      = Food brutto (Kategoriezeilen)
 *      actualBeverage  = Beverage brutto (Kategoriezeilen)
 *  - maison-daily (KV, tenant-präfixiert) — separater Marketing-Import:
 *    Marketing pro Tag, Nennwert = netto.
 *
 * Formel (nettoUmsatzTag):
 *   takeAwayNetto  = TakeAway_brutto / 1.026
 *   uebrigerNetto  = (Gesamt_brutto − TakeAway_brutto) / 1.081
 *   marketingNetto = Σ Marketing-Positionen (Nennwert)
 *   nettoUmsatz    = takeAwayNetto + uebrigerNetto + marketingNetto
 *
 * Food/Beverage-Split (foodBeverageSplit):
 *   foodDirektNetto     = Food_brutto / 1.081
 *   beverageDirektNetto = Beverage_brutto / 1.081
 *   restNetto           = nettoUmsatz − foodDirekt − beverageDirekt
 *   Rest wird ANTEILIG nach dem Food/Beverage-Verhältnis verteilt (nicht 50/50):
 *     basis = foodDirekt + beverageDirekt
 *     food     = foodDirekt     + restNetto * (foodDirekt / basis)
 *     beverage = beverageDirekt + restNetto * (beverageDirekt / basis)
 *   (basis = 0 → hälftig; food + beverage ergibt exakt nettoUmsatz.)
 *
 * VERIFIKATION Juli 2026 (manueller 27-Tage-Import, gegengerechnet):
 *   Gesamt 235'219.00 · TakeAway 29'898.50 · Marketing 13'193.40
 *   → takeAwayNetto  = 29'898.50 / 1.026              = 29'140.84
 *     uebrigerNetto  = (235'219.00 − 29'898.50)/1.081 = 189'935.71
 *     marketingNetto = 13'193.40
 *     nettoUmsatz    = 232'269.95 ✓
 */
import type { TenantId } from '@/contexts/TenantContext';

const r2 = (v: number): number => Math.round(v * 100) / 100;

export const MWST_NORMAL = 1.081;
export const MWST_TAKEAWAY = 1.026;

// ── Tagesmodell ──────────────────────────────────────────────────────────────

export interface UmsatzTag {
  /** 'YYYY-MM-DD' */
  datum: string;
  /** Gesamt brutto (inkl. Keine Gruppierung + Aufladung Kundenkarten, nach Rabatten) */
  gesamtBrutto: number;
  /** Take-Away brutto (Teil von gesamtBrutto) */
  takeAwayBrutto: number;
  /** Food brutto (Warengruppen) */
  foodBrutto: number;
  /** Beverage brutto (Warengruppen) */
  beverageBrutto: number;
  /** Marketing-Positionen, Nennwert = netto */
  marketingNetto: number;
}

/** Kanonischer Netto-Umsatz eines Tages. */
export function nettoUmsatzTag(tag: UmsatzTag): number {
  const takeAwayNetto = tag.takeAwayBrutto / MWST_TAKEAWAY;
  const uebrigerNetto = (tag.gesamtBrutto - tag.takeAwayBrutto) / MWST_NORMAL;
  return r2(takeAwayNetto + uebrigerNetto + tag.marketingNetto);
}

export interface FoodBeverageSplit {
  food: number;
  beverage: number;
}

/**
 * Food/Beverage-Aufteilung des Netto-Umsatzes: direkte Anteile netto,
 * Rest (nicht kategorisierter Umsatz, Marketing, Rundung) ANTEILIG nach
 * dem Food/Beverage-Verhältnis (basis = 0 → hälftig).
 * Invariante: food + beverage === nettoUmsatzTag(tag).
 */
export function foodBeverageSplit(tag: UmsatzTag): FoodBeverageSplit {
  const netto = nettoUmsatzTag(tag);
  const foodDirekt = tag.foodBrutto / MWST_NORMAL;
  const bevDirekt = tag.beverageBrutto / MWST_NORMAL;
  const basis = foodDirekt + bevDirekt;
  const foodAnteil = basis > 0 ? foodDirekt / basis : 0.5;
  const rest = netto - foodDirekt - bevDirekt;
  const food = r2(foodDirekt + rest * foodAnteil);
  return { food, beverage: r2(netto - food) };
}

/** Bequeme Summen über mehrere Tage. */
export function summiereUmsatz(tage: Iterable<UmsatzTag>): {
  bruttoGesamt: number; takeAwayBrutto: number; netto: number; food: number; beverage: number;
} {
  let bruttoGesamt = 0, takeAwayBrutto = 0, netto = 0, food = 0, beverage = 0;
  for (const t of tage) {
    bruttoGesamt += t.gesamtBrutto;
    takeAwayBrutto += t.takeAwayBrutto;
    netto += nettoUmsatzTag(t);
    const split = foodBeverageSplit(t);
    food += split.food;
    beverage += split.beverage;
  }
  return {
    bruttoGesamt: r2(bruttoGesamt), takeAwayBrutto: r2(takeAwayBrutto),
    netto: r2(netto), food: r2(food), beverage: r2(beverage),
  };
}

// ── Lader ────────────────────────────────────────────────────────────────────

/** Tenant-Schlüssel wie TenantContext.tenantKey: 'oliv' ohne Präfix. */
function tenantKvKey(tenantId: TenantId, base: string): string {
  return tenantId === 'oliv' ? base : `${tenantId}:${base}`;
}

/**
 * Lädt die kanonischen Umsatz-Tage eines Zeitraums aus dem MANUELLEN
 * Tagesumsatz-Import («Nach Speisekarte»-Excel → dailyBudgets-KV):
 *   actualRevenue   = Gesamt brutto (inkl. Take Away, nach Rabatten)
 *   takeawayRevenue = Take-Away brutto (Teil von actualRevenue)
 *   actualFood/actualBeverage = Kategorien brutto
 * Marketing pro Tag kommt aus dem separaten Marketing-Import (maison-daily,
 * Nennwert = netto). Z-Berichte (gn_imports) werden hier NICHT gelesen —
 * sie dienen nur den Tagesabschlüssen.
 * Tage ohne manuellen Import fehlen in der Map (Konsumenten zeigen leer, NIE 0).
 */
export async function ladeUmsatzTage(
  tenantId: TenantId,
  fromIso: string,
  toIso: string,
): Promise<Map<string, UmsatzTag>> {
  const result = new Map<string, UmsatzTag>();
  try {
    const { kvGet } = await import('@/lib/supabase-kv');
    const tk = (k: string) => tenantKvKey(tenantId, k);

    const [budgetsRaw, marketingRaw] = await Promise.all([
      kvGet(tk('dailyBudgets')),
      kvGet(tk('maison-daily')),
    ]);

    const budgets = (budgetsRaw && typeof budgetsRaw === 'object' && !Array.isArray(budgetsRaw))
      ? budgetsRaw as Record<string, Record<string, unknown>>
      : {};
    const marketing = (marketingRaw && typeof marketingRaw === 'object' && !Array.isArray(marketingRaw))
      ? marketingRaw as Record<string, number>
      : {};

    for (const [datum, day] of Object.entries(budgets)) {
      if (datum < fromIso || datum > toIso) continue;
      const gesamt = Number(day?.actualRevenue ?? 0);
      if (!(gesamt > 0)) continue; // kein manueller Umsatz-Import für diesen Tag
      result.set(datum, {
        datum,
        gesamtBrutto: gesamt,
        takeAwayBrutto: Number(day?.takeawayRevenue ?? 0),
        foodBrutto: Number(day?.actualFood ?? 0),
        beverageBrutto: Number(day?.actualBeverage ?? 0),
        marketingNetto: r2(Math.abs(Number(marketing[datum] ?? 0))),
      });
    }
    return result;
  } catch (e) {
    console.warn(`[UMSATZ] ladeUmsatzTage(${tenantId}, ${fromIso}..${toIso}) Exception:`, e);
    return result;
  }
}
