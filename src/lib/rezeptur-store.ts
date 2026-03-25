/**
 * Rezeptur Store – Produktkalkulation
 * =====================================
 * Drei Kalkulationsmodi pro Produkt:
 *   Pauschal  → manuell eingegebener Gesamtpreis
 *   Rezeptur  → Zutaten aus Artikelstamm, automatische Berechnung
 *   Gemischt  → Rezeptur + manuelle Zusatzkosten
 *
 * Alle Preise NETTO (exkl. MwSt.) – gleiche Basis wie Artikelstamm.
 * Speicherung: Supabase app_settings (via kvGet/kvSet) + localStorage Fallback.
 */

import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet } from '@/lib/supabase-kv';

const RECIPE_KEY = 'produkte_rezeptur_v1';

// ── Typen ─────────────────────────────────────────────────────────────────────

export type CostMode = 'pauschal' | 'rezeptur' | 'gemischt';

/**
 * Eine Zutat in einer Rezeptur.
 * Lieferanten-Infos werden denormalisiert gespeichert, damit die Rezeptur
 * auch ohne aktiven Internet-Zugriff auf den Artikelstamm lesbar bleibt.
 *
 * Erweiterung: Wenn `baseRecipeId` gesetzt ist, ist diese Zutat eine
 * Basiskomponente (z.B. "Pasta Basis"). costPerUnit enthält dann den
 * Portionspreis der Basiskomponente – so funktionieren alle Kalkulationen
 * ohne Änderung. Bei Änderung der Basiskomponente wird costPerUnit
 * via propagateBaseComponentChange() automatisch aktualisiert.
 */
export interface RecipeIngredient {
  id: string;
  articleId: string;           // UUID aus Artikelstamm (oder '' für manuelle Zutat / Basis)
  articleName: string;         // Anzeigename (denormalisiert)
  quantity: number;            // Menge (bei Basis: Anzahl Portionen)
  unit: string;                // Einheit
  costPerUnit: number;         // NETTO-Preis/Einheit – bei Basis: Portionspreis
  supplier: string;            // Standard-Lieferant (denormalisiert)
  accountingAccount: string;   // Fibu-Konto (denormalisiert)
  /** UUID einer Basiskomponente (aus basiskomponenten-store). Wenn gesetzt: ist eine Basis-Referenz. */
  baseRecipeId?: string;
}

/**
 * Zuordnung eines Produkts zum Lunch-WES-Analyse-Pool.
 * 'lunch_basic'   → Tagesmenu 1, Business Lunch Basic
 * 'lunch_premium' → Tagesmenu 2, Business Lunch Premium
 * 'lunch_allgemein' → Lunch ohne Unterscheidung
 * undefined       → kein Lunch-Produkt
 */
export type LunchPool = 'lunch_basic' | 'lunch_premium' | 'lunch_allgemein';

/**
 * Vertriebskanal eines Produkts.
 * 'restaurant' → À-la-carte, Standard-Restaurantbetrieb
 * 'lunch'      → Mittagsmenu (wird im Lunch-Pool weiter differenziert)
 * 'takeaway'   → Take Away (eigener Kostenpool, eigene Analyse)
 * undefined    → nicht zugeordnet / Standard (=restaurant)
 */
export type SalesChannel = 'restaurant' | 'lunch' | 'takeaway';

export interface ProductRecipe {
  id: string;               // `${productName}|${category}` – unique key
  productName: string;
  category: 'food' | 'beverage';
  costMode: CostMode;
  /** Pauschal: Gesamtkosten. Gemischt: Zusatzkosten (zu Rezeptur addiert). */
  manualCost: number;
  manualCostNote: string;   // z.B. "Verpackung", "Energie", "Overhead"
  ingredients: RecipeIngredient[];
  /**
   * Lunch-Pool-Zuordnung für WES-Analyse.
   * Wenn gesetzt: Dieses Produkt zählt zum angegebenen Lunch-Pool.
   * Soll-WES = Anzahl Portionen × manualCost (Pauschal) resp. berechnete Kosten.
   */
  lunchPool?: LunchPool;
  /**
   * Vertriebskanal des Produkts.
   * 'takeaway' → Produkt erscheint in der Take-Away-Analyse.
   * 'lunch'    → in Kombination mit lunchPool in der Lunch-Analyse.
   * 'restaurant' / undefined → Standard-Restaurantbetrieb.
   */
  salesChannel?: SalesChannel;
  updatedAt: string;
}

/** Berechnetes Ergebnis einer Rezeptur (abhängig von Modus + Verkaufspreis). */
export interface RecipeCosts {
  ingredientsCost: number;  // Summe aller Zutaten
  totalCost: number;        // Gesamtkosten (je nach Modus)
  wesQ: number;             // Wareneinsatzquote in %
  margeCHF: number;         // Marge in CHF (Netto-VKP − Kosten)
  margePct: number;         // Marge in %
  deckungsbeitrag: number;  // = margeCHF (Alias, für Klarheit in UI)
}

/** Map: recipe.id → ProductRecipe */
export type RezepturenMap = Record<string, ProductRecipe>;

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

export function makeRecipeId(productName: string, category: 'food' | 'beverage'): string {
  return `${productName.trim().toLowerCase()}|${category}`;
}

/**
 * Berechnet alle KPIs für eine Rezeptur.
 * @param nettoPrice  Netto-Verkaufspreis (bevorzugt)
 * @param bruttoPrice Brutto-Verkaufspreis (Fallback)
 */
export function computeRecipeCosts(
  recipe: ProductRecipe,
  nettoPrice: number,
  bruttoPrice: number,
): RecipeCosts {
  const refPrice = nettoPrice > 0 ? nettoPrice : bruttoPrice;

  const ingredientsCost = recipe.ingredients.reduce(
    (sum, i) => sum + i.quantity * i.costPerUnit,
    0,
  );

  let totalCost: number;
  switch (recipe.costMode) {
    case 'pauschal': totalCost = recipe.manualCost;                     break;
    case 'rezeptur': totalCost = ingredientsCost;                       break;
    case 'gemischt': totalCost = ingredientsCost + recipe.manualCost;  break;
    default:         totalCost = 0;
  }

  const wesQ            = refPrice > 0 ? (totalCost / refPrice) * 100 : 0;
  const margeCHF        = refPrice - totalCost;
  const margePct        = refPrice > 0 ? (margeCHF  / refPrice) * 100 : 0;

  return { ingredientsCost, totalCost, wesQ, margeCHF, margePct, deckungsbeitrag: margeCHF };
}

export function emptyRecipe(productName: string, category: 'food' | 'beverage'): ProductRecipe {
  return {
    id:             makeRecipeId(productName, category),
    productName,
    category,
    costMode:       'pauschal',
    manualCost:     0,
    manualCostNote: '',
    ingredients:    [],
    updatedAt:      new Date().toISOString(),
  };
}

export function emptyIngredient(): RecipeIngredient {
  return {
    id:               uuidv4(),
    articleId:        '',
    articleName:      '',
    quantity:         1,
    unit:             'kg',
    costPerUnit:      0,
    supplier:         '',
    accountingAccount: '',
  };
}

// ── Persistenz ────────────────────────────────────────────────────────────────

function localLoad(): RezepturenMap {
  try {
    const raw = localStorage.getItem(RECIPE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function localSave(map: RezepturenMap): void {
  localStorage.setItem(RECIPE_KEY, JSON.stringify(map));
}

export async function loadRezepturenFromDB(): Promise<RezepturenMap> {
  try {
    const remote = await kvGet(RECIPE_KEY) as RezepturenMap | null;
    if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
      localSave(remote);
      console.log('[Rezeptur] Aus Supabase geladen:', Object.keys(remote).length, 'Rezepturen');
      return remote;
    }
    const local = localLoad();
    if (Object.keys(local).length > 0) {
      await kvSet(RECIPE_KEY, local);
      console.log('[Rezeptur] localStorage → Supabase (Erstmigration):', Object.keys(local).length);
    }
    return local;
  } catch (err) {
    console.error('[Rezeptur] loadRezepturenFromDB Fehler:', err);
    return localLoad();
  }
}

export async function saveRezepturenToDB(map: RezepturenMap): Promise<void> {
  localSave(map);
  try {
    await kvSet(RECIPE_KEY, map);
  } catch (err) {
    console.error('[Rezeptur] saveRezepturenToDB Fehler:', err);
  }
}
