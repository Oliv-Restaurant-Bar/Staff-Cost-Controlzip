/**
 * Basiskomponenten Store
 * ======================
 * Verwaltet wiederverwendbare Basis-Rezepturen (z.B. "Pasta Basis",
 * "Risotto Basis", "Tomatensauce"), die in beliebig vielen Produktrezepturen
 * als Komponenten referenziert werden können.
 *
 * Designprinzip:
 *   Eine Basiskomponente hat eigene Zutaten (RecipeIngredient[]) und berechnet
 *   automatisch ihren Kosten-/Portionspreis.
 *
 *   Wenn eine Basiskomponente geändert wird, werden alle verlinkten Rezepturen
 *   gezielt aktualisiert (propagateBaseComponentChange). Die Kosten werden dabei
 *   direkt in costPerUnit der verlinkten Zutat eingetragen – so funktionieren
 *   computeRecipeCosts, WES-Analyse und alle anderen Berechnungen weiterhin
 *   ohne Änderung.
 *
 * Speicherung: Supabase app_settings (via kvGet/kvSet) + localStorage Fallback.
 * Schlüssel: 'basis_komponenten_v1'
 */

import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet, kvSetConfirmed } from '@/lib/supabase-kv';
import type { RecipeIngredient, RezepturenMap, ProductRecipe } from '@/lib/rezeptur-store';

const STORE_KEY = 'basis_komponenten_v1';

// ── Typen ──────────────────────────────────────────────────────────────────────

/**
 * Eine Basiskomponente (z.B. "Pasta Basis", "Risotto Basis").
 * Hat eigene Zutaten aus dem Artikelstamm und einen berechneten Portionspreis.
 */
export interface BaseComponent {
  id: string;
  name: string;
  /** Einheit einer Portion, z.B. "Portion", "100g", "dl" */
  unit: string;
  /** Beschreibung / Verwendungshinweis */
  note: string;
  /** Zutaten der Basiskomponente – selbe Struktur wie Produktrezeptur */
  ingredients: RecipeIngredient[];
  updatedAt: string;
  createdAt: string;
}

export type BaseComponentMap = Record<string, BaseComponent>;

// ── Kosten-Berechnung ──────────────────────────────────────────────────────────

/**
 * Berechnet den Gesamtkosten einer Portion der Basiskomponente (CHF netto).
 * Entspricht der Summe aller Zutaten: quantity × costPerUnit
 */
export function computeBaseComponentCost(bc: BaseComponent): number {
  return bc.ingredients.reduce((sum, i) => sum + i.quantity * i.costPerUnit, 0);
}

// ── Propagation ────────────────────────────────────────────────────────────────

/**
 * Propagiert eine geänderte Basiskomponente in alle verlinkten Produktrezepturen.
 *
 * Für jede Rezeptur, die diese Basiskomponente als Zutat referenziert
 * (RecipeIngredient.baseRecipeId === bc.id), wird der costPerUnit
 * der Zutat auf den aktuellen Portionspreis der Basiskomponente gesetzt.
 *
 * @returns Aktualisierte RezepturenMap (unveränderter Eingang + geänderte Rezepturen)
 */
export function propagateBaseComponentChange(
  bc: BaseComponent,
  recipes: RezepturenMap,
): { updatedMap: RezepturenMap; affectedRecipeIds: string[] } {
  const newCost = computeBaseComponentCost(bc);
  const updatedMap: RezepturenMap = { ...recipes };
  const affectedRecipeIds: string[] = [];

  for (const [recipeId, recipe] of Object.entries(recipes)) {
    const hasLink = recipe.ingredients.some(i => i.baseRecipeId === bc.id);
    if (!hasLink) continue;

    const newIngredients = recipe.ingredients.map(i =>
      i.baseRecipeId === bc.id
        ? { ...i, costPerUnit: newCost, articleName: bc.name, unit: bc.unit }
        : i,
    );

    updatedMap[recipeId] = {
      ...recipe,
      ingredients: newIngredients,
      updatedAt: new Date().toISOString(),
    };
    affectedRecipeIds.push(recipeId);
  }

  return { updatedMap, affectedRecipeIds };
}

/**
 * Gibt alle Produktrezepturen zurück, die eine bestimmte Basiskomponente verwenden.
 */
export function getLinkedRecipes(bcId: string, recipes: RezepturenMap): ProductRecipe[] {
  return Object.values(recipes).filter(r =>
    r.ingredients.some(i => i.baseRecipeId === bcId),
  );
}

/**
 * Erstellt eine neue RecipeIngredient, die eine Basiskomponente referenziert.
 * costPerUnit wird sofort aus dem aktuellen Portionspreis befüllt.
 */
export function makeBaseComponentIngredient(bc: BaseComponent, quantity = 1): RecipeIngredient {
  return {
    id:               uuidv4(),
    articleId:        '',             // kein Artikel – ist eine Basis
    articleName:      bc.name,
    quantity,
    unit:             bc.unit,
    costPerUnit:      computeBaseComponentCost(bc),
    supplier:         '',
    accountingAccount: '',
    baseRecipeId:     bc.id,
  };
}

// ── Persistenz ─────────────────────────────────────────────────────────────────

function localLoad(): BaseComponentMap {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function localSave(map: BaseComponentMap): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(map));
}

export async function loadBasiskomponentenFromDB(): Promise<BaseComponentMap> {
  try {
    const remote = await kvGet(STORE_KEY) as BaseComponentMap | null;
    if (remote && typeof remote === 'object' && Object.keys(remote).length > 0) {
      localSave(remote);
      return remote;
    }
    const local = localLoad();
    if (Object.keys(local).length > 0) {
      await kvSet(STORE_KEY, local);
    }
    return local;
  } catch (err) {
    console.error('[Basis] loadBasiskomponentenFromDB Fehler:', err);
    return localLoad();
  }
}

export async function saveBasiskomponentenToDB(map: BaseComponentMap): Promise<void> {
  // Database-first (Issue #5): cache locally only after Supabase confirms.
  try {
    await kvSetConfirmed(STORE_KEY, map, 'Basiskomponenten');
  } catch (err) {
    console.error('[Basis] saveBasiskomponentenToDB Fehler:', err);
  }
}

// ── CRUD Helpers ───────────────────────────────────────────────────────────────

export function createBaseComponent(
  name: string,
  unit: string,
  note: string,
  ingredients: RecipeIngredient[],
): BaseComponent {
  const now = new Date().toISOString();
  return {
    id:          uuidv4(),
    name:        name.trim(),
    unit:        unit.trim() || 'Portion',
    note:        note.trim(),
    ingredients,
    updatedAt:   now,
    createdAt:   now,
  };
}
