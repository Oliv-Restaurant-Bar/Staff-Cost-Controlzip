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
 * Food/Beverage-Split (foodBeverageSplit) — EINHEITLICH beide Mandanten
 * (seit 08/2026):
 *   foodDirektNetto     = Food_brutto / 1.081      («Food (Speisen)» → Food)
 *   beverageDirektNetto = Beverage_brutto / 1.081  («Beverage (Getränke)» → Beverage)
 *   restNetto           = nettoUmsatz − foodDirekt − beverageDirekt (− TA bei Oliv)
 *   DEFAULT: der GESAMTE übrige Rest — inkl. neu/unbekannt auftauchender
 *   Positionen (Cornerbar, Keine Gruppierung, Aufladung Kundenkarten,
 *   Trinkgeld, Just Eat, Rundungsdifferenzen, Rabatte, Marketing, …) — wird
 *   HÄLFTIG (50/50) auf Food und Beverage verteilt. Keine Einzelkonfiguration
 *   nötig, keine Position geht verloren: alles, was nicht direkt Food/Beverage
 *   (bzw. Oliv-TA) ist, landet automatisch im 50/50-Rest.
 *   Mandanten-Regel Oliv (taVollFood): Take-Away-Netto zählt 100% zu FOOD
 *   (kein Beverage über Take Away; Beaulieu hat keinen Take Away).
 *   Invariante: food + beverage = nettoUmsatz — konstruktiv gesichert
 *   (beverage = netto − food), auf Rappen-Ebene exakt; IEEE-754-Restdrift
 *   liegt weit unterhalb der Anzeige-Rundung (r2).
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
 * Food/Beverage-Aufteilung des Netto-Umsatzes (einheitlich beide Mandanten):
 * direkte Anteile netto («Food (Speisen)» → Food, «Beverage (Getränke)» →
 * Beverage); Oliv-TA (taVollFood) 100% Food; der GESAMTE übrige Rest — auch
 * neue/unbekannte Positionen — wird HÄLFTIG (50/50) verteilt. Keine Position
 * geht verloren (Rest = Netto − Direktanteile − TA).
 * UNGERUNDET (Rundung erst bei Summe/Anzeige) — Invariante konstruktiv:
 * beverage = netto − food, d.h. food + beverage = nettoUmsatzTag(tag) bis auf
 * IEEE-754-Restdrift weit unterhalb der Anzeige-Rundung.
 */
export function foodBeverageSplit(tag: UmsatzTag): FoodBeverageSplit {
  const netto = nettoUmsatzTag(tag);
  const foodDirekt = tag.foodBrutto / mwstDivisorStandard();
  const bevDirekt = tag.beverageBrutto / mwstDivisorStandard();
  // Mandanten-Regel (Oliv): Take-Away-Netto zählt 100% zu Food.
  const taNetto = tag.taVollFood ? tag.takeAwayBrutto / mwstDivisorTakeaway() : 0;
  // DEFAULT: alles Übrige (bekannt oder unbekannt) hälftig 50/50 verteilen.
  const rest = netto - foodDirekt - bevDirekt - taNetto;
  const food = foodDirekt + taNetto + rest * 0.5;
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

// ── Vorjahr (vj_daily) — identische Regel wie das laufende Jahr ──────────────

/** Minimale Feldsicht eines vj_daily-Tagesrecords (brutto). */
export interface VjTagFelder {
  actualRevenue?: number;
  takeawayRevenue?: number;
  foodRevenue?: number;
  beverageRevenue?: number;
}

export interface VjTagWerte { netto: number; food: number; beverage: number; }

/**
 * Netto + Food/Beverage-Split eines VORJAHR-Tages (vj_daily-Record) nach
 * EXAKT derselben Regel wie das laufende Jahr:
 *   netto = TA/1.026 + (Gesamt−TA)/1.081 (vj_daily kennt kein Marketing)
 *   Food/Beverage direkt; Oliv-TA 100% Food; Rest (auch negativ, z.B.
 *   Rabatte) 50/50. Invariante food+beverage = netto konstruktiv.
 * Kein Umsatz (actualRevenue ≤ 0) → null («leer statt 0»).
 * Mandanten-Flag wird hier gesetzt (einziger UmsatzTag-Konstruktor neben
 * ladeUmsatzTage — Regeländerungen an BEIDEN Stellen nachziehen).
 */
export function vjTagWerte(tenantId: TenantId, rec: VjTagFelder, datum = ''): VjTagWerte | null {
  const gesamt = Number(rec.actualRevenue ?? 0);
  if (!(gesamt > 0)) return null;
  const tag: UmsatzTag = {
    datum,
    gesamtBrutto: gesamt,
    takeAwayBrutto: Number(rec.takeawayRevenue ?? 0),
    foodBrutto: Number(rec.foodRevenue ?? 0),
    beverageBrutto: Number(rec.beverageRevenue ?? 0),
    marketingNetto: 0,
    taVollFood: tenantId === 'oliv',
  };
  const s = foodBeverageSplit(tag);
  return { netto: nettoUmsatzTag(tag), food: s.food, beverage: s.beverage };
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
        // Oliv verkauft keine Getränke über Take Away → TA zählt 100% zu Food
        // (Beaulieu hat keinen Take Away). Rest immer 50/50 (Split-Default).
        taVollFood: tenantId === 'oliv',
      });
    }
    return result;
  } catch (e) {
    console.warn(`[UMSATZ] ladeUmsatzTage(${tenantId}, ${fromIso}..${toIso}) Exception:`, e);
    return result;
  }
}
