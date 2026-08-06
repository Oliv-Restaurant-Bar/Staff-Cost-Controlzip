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
 *   Mandanten-Regel Oliv (taVollFood, seit 08/2026): Take-Away-Netto zählt
 *   100% zu FOOD (kein Beverage über Take Away); nur der übrige Rest wird
 *   anteilig verteilt.
 *   Mandanten-Regel Beaulieu (restHaelftig, seit 08/2026): der nicht
 *   kategorisierte Rest (Non-Foods, Kundenkarten, Trinkgeld, Rundungen,
 *   Rabatte, Marketing) wird HÄLFTIG (50/50) verteilt statt anteilig.
 *
 * VERIFIKATION Juli 2026 (manueller 27-Tage-Import, gegengerechnet):
 *   Gesamt 235'219.00 · TakeAway 29'898.50 · Marketing 13'193.40
 *   → takeAwayNetto  = 29'898.50 / 1.026              = 29'140.84
 *     uebrigerNetto  = (235'219.00 − 29'898.50)/1.081 = 189'935.71
 *     marketingNetto = 13'193.40
 *     nettoUmsatz    = 232'269.95 ✓
 */
import type { TenantId } from '@/contexts/TenantContext';
import { mwstDivisorStandard, mwstDivisorTakeaway } from '@/lib/mwst';

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** @deprecated Default-Divisoren — für Berechnungen mwstDivisorStandard()/mwstDivisorTakeaway() aus mwst.ts verwenden (konfigurierbar). */
export const MWST_NORMAL = 1.081;
export const MWST_TAKEAWAY = 1.026;
export { mwstDivisorStandard, mwstDivisorTakeaway };

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
  /**
   * Mandanten-Regel: Take Away zählt 100% zu FOOD (kein Beverage-Anteil).
   * Wird vom Lader gesetzt (Oliv: true — keine Getränke über Take Away).
   * Übrige Positionen (Keine Gruppierung, Rabatte, Marketing) bleiben anteilig.
   */
  taVollFood?: boolean;
  /**
   * Mandanten-Regel: nicht kategorisierter Rest (Non-Foods, Aufladung
   * Kundenkarten, Trinkgeld, Rundungen, Rabatte, Marketing) wird HÄLFTIG
   * (50/50) auf Food/Beverage verteilt statt anteilig.
   * Wird vom Lader gesetzt (Beaulieu: true).
   */
  restHaelftig?: boolean;
}

/**
 * Kanonischer Netto-Umsatz eines Tages — UNGERUNDET.
 * Gerundet wird erst bei der Summe/Anzeige: so ergibt die Monatssumme exakt
 * die Monatsformel (Σ TA/1.026 + Σ (Gesamt−TA)/1.081 + Σ Marketing), ohne
 * Rappen-Drift aus Tagesrundungen.
 */
export function nettoUmsatzTag(tag: UmsatzTag): number {
  const takeAwayNetto = tag.takeAwayBrutto / mwstDivisorTakeaway();
  const uebrigerNetto = (tag.gesamtBrutto - tag.takeAwayBrutto) / mwstDivisorStandard();
  return takeAwayNetto + uebrigerNetto + tag.marketingNetto;
}

export interface FoodBeverageSplit {
  food: number;
  beverage: number;
}

/**
 * Food/Beverage-Aufteilung des Netto-Umsatzes: direkte Anteile netto,
 * Rest (nicht kategorisierter Umsatz, Marketing, Take-Away-Differenz)
 * ANTEILIG nach dem Food/Beverage-Verhältnis (basis = 0 → hälftig).
 * UNGERUNDET (Rundung erst bei Summe/Anzeige) — Invariante gilt exakt:
 * food + beverage === nettoUmsatzTag(tag).
 */
export function foodBeverageSplit(tag: UmsatzTag): FoodBeverageSplit {
  const netto = nettoUmsatzTag(tag);
  const foodDirekt = tag.foodBrutto / mwstDivisorStandard();
  const bevDirekt = tag.beverageBrutto / mwstDivisorStandard();
  const basis = foodDirekt + bevDirekt;
  // Rest-Verteilung: anteilig nach Direktverhältnis — oder hälftig (50/50),
  // wenn die Mandanten-Regel restHaelftig gesetzt ist (z.B. Beaulieu).
  const foodAnteil = tag.restHaelftig ? 0.5 : (basis > 0 ? foodDirekt / basis : 0.5);
  // Mandanten-Regel (z.B. Oliv): Take-Away-Netto zählt 100% zu Food; nur der
  // ÜBRIGE Rest (Keine Gruppierung, Rabatte, Marketing) wird anteilig verteilt.
  const taNetto = tag.taVollFood ? tag.takeAwayBrutto / mwstDivisorTakeaway() : 0;
  const rest = netto - foodDirekt - bevDirekt - taNetto;
  const food = foodDirekt + taNetto + rest * foodAnteil;
  return { food, beverage: netto - food };
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
        // Oliv verkauft keine Getränke über Take Away → TA zählt 100% zu Food.
        taVollFood: tenantId === 'oliv',
        // Beaulieu: Rest & Rabatte hälftig (50/50) auf Food/Beverage.
        restHaelftig: tenantId === 'beaulieu',
      });
    }
    return result;
  } catch (e) {
    console.warn(`[UMSATZ] ladeUmsatzTage(${tenantId}, ${fromIso}..${toIso}) Exception:`, e);
    return result;
  }
}
