/**
 * umsatz.ts — EINZIGE gemeinsame Netto-Umsatz-Quelle (Single Source of Truth)
 * ===========================================================================
 * Kanonische Netto-Umsatz-Berechnung pro Tag, summierbar auf Woche/Monat.
 * Konsumenten: Personalkosten (PKQ) und Monatsreport — KEINE zweite
 * Umsatzberechnung mehr ausserhalb dieser Datei.
 *
 * Quellen (keine neuen Tabellen):
 *  - gn_imports (Tages-Z-Berichte, aggregation_level='day', status='active'):
 *      gross_revenue      = Gesamt brutto (inkl. Food, Beverage,
 *                           «Keine Gruppierung», «Aufladung Kundenkarten»;
 *                           bereits nach Rabatten)
 *      take_away_revenue  = Take-Away brutto
 *      food_revenue       = Food brutto (Warengruppen-Summe)
 *      bev_revenue        = Beverage brutto (Warengruppen-Summe)
 *  - gn_discounts (via import_id): Positionen mit Name «Marketing»/«marketing»
 *    → Marketing-Zuschlag, zum Nennwert als netto. NICHT dazu: Maison,
 *    Mitarbeiter-Rabatt, sonstige Rabatte.
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
 *   food = foodDirekt + restNetto/2 ; beverage = beverageDirekt + restNetto/2
 *   (food + beverage ergibt exakt nettoUmsatz.)
 *
 * VERIFIKATION Juli 2026 (Beispiel aus der Spezifikation, gegengerechnet):
 *   Gesamt 233'643.90 · TakeAway 29'746.00 · Marketing 12'196.40 + 997.00
 *   → takeAwayNetto  = 29'746.00 / 1.026              = 28'992.20
 *     uebrigerNetto  = (233'643.90 − 29'746.00)/1.081 = 188'619.70
 *     marketingNetto = 13'193.40
 *     nettoUmsatz    = 230'805.30 ✓
 *   Food 149'509.08 / Beverage 81'296.22 ergeben zusammen 230'805.30 ✓
 */
import { supabase } from '@/integrations/supabase/client';
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
 * Rest (Keine Gruppierung, Aufladung, Marketing, Rundung) hälftig.
 * Invariante: food + beverage === nettoUmsatzTag(tag).
 */
export function foodBeverageSplit(tag: UmsatzTag): FoodBeverageSplit {
  const netto = nettoUmsatzTag(tag);
  const foodDirekt = tag.foodBrutto / MWST_NORMAL;
  const bevDirekt = tag.beverageBrutto / MWST_NORMAL;
  const rest = netto - foodDirekt - bevDirekt;
  const food = r2(foodDirekt + rest / 2);
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

/**
 * Lädt die kanonischen Umsatz-Tage eines Zeitraums aus den Tages-Z-Berichten.
 * Replace-Semantik: bei mehreren aktiven Tagesimporten desselben Datums
 * gewinnt der zuletzt importierte. Tage ohne Import fehlen in der Map
 * (Konsumenten zeigen leer, NIE 0).
 */
export async function ladeUmsatzTage(
  tenantId: TenantId,
  fromIso: string,
  toIso: string,
): Promise<Map<string, UmsatzTag>> {
  const result = new Map<string, UmsatzTag>();
  try {
    const { data: imports, error } = await (supabase as any)
      .from('gn_imports')
      .select('id, period_from, gross_revenue, take_away_revenue, food_revenue, bev_revenue, imported_at')
      .eq('restaurant_id', tenantId)
      .eq('status', 'active')
      .eq('aggregation_level', 'day')
      .gte('period_from', fromIso)
      .lte('period_from', toIso)
      .not('gross_revenue', 'is', null)
      .order('imported_at', { ascending: true });
    if (error || !data_ok(imports)) return result;

    // Später importierte überschreiben (Replace-Semantik)
    const winner = new Map<string, { id: string; row: any }>();
    for (const row of imports as any[]) {
      if (!row.period_from || !(row.gross_revenue > 0)) continue;
      winner.set(row.period_from, { id: row.id, row });
    }
    if (winner.size === 0) return result;

    // Marketing-Positionen der Gewinner-Importe (Name exakt «Marketing»/«marketing»)
    const marketingByImport = new Map<string, number>();
    const ids = [...winner.values()].map(w => w.id);
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data: disc } = await (supabase as any)
        .from('gn_discounts')
        .select('import_id, name, amount')
        .in('import_id', ids.slice(i, i + CHUNK));
      for (const d of (disc ?? []) as Array<{ import_id: string; name: string | null; amount: number | null }>) {
        if (!d.name || d.name.trim().toLowerCase() !== 'marketing') continue;
        marketingByImport.set(d.import_id,
          r2((marketingByImport.get(d.import_id) ?? 0) + Math.abs(d.amount ?? 0)));
      }
    }

    for (const [datum, { id, row }] of winner) {
      result.set(datum, {
        datum,
        gesamtBrutto: row.gross_revenue ?? 0,
        takeAwayBrutto: row.take_away_revenue ?? 0,
        foodBrutto: row.food_revenue ?? 0,
        beverageBrutto: row.bev_revenue ?? 0,
        marketingNetto: marketingByImport.get(id) ?? 0,
      });
    }
    return result;
  } catch {
    return result;
  }
}

function data_ok(d: unknown): d is any[] {
  return Array.isArray(d) && d.length > 0;
}
