/**
 * Artikel-Tracking Store – Einkaufs- und Verbrauchsanalyse
 * ==========================================================
 *
 * Speicherung: localStorage, MANDANTEN-GETRENNT via tenantKey():
 *   Oliv     → 'artikel_purchases_v1' (Legacy-Key, bestehende Daten bleiben Oliv)
 *   Beaulieu → 'beaulieu:artikel_purchases_v1'
 *
 * Zweck:
 *   Manuelle Erfassung von Einkäufen (Menge + Preis) für Artikel
 *   mit aktivem Tracking. Kombination mit theoretischem Verbrauch
 *   aus Rezepturen und Verkaufszahlen für monatliche Auswertung.
 *
 * Datenquellen:
 *   1. Einkäufe:          Manuelle Buchungen hier (ArtikelPurchase)
 *   2. Theo. Verbrauch:   Rezepturen × Verkaufsmengen (Produkte-Store)
 *
 * Wichtige Regel:
 *   Kein Soll-Lager, kein Bestandsmanagement.
 *   Nur Analyse: "Was haben wir eingekauft? Was haben wir verbraucht?"
 */

import { v4 as uuidv4 } from 'uuid';
import type { ProductRecipe } from './rezeptur-store';
import type { ProductEntry } from './produkte-store';
import { tenantKey } from './tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';

const PURCHASE_KEY = 'artikel_purchases_v1';

// ── Typen ─────────────────────────────────────────────────────────────────────

/**
 * Ein einzelner Einkaufsbeleg für einen getackten Artikel.
 * Erfasst werden: Menge, Netto-Preis/Einheit, Lieferant, Datum.
 * Aus Menge × Preis ergibt sich der Gesamtbetrag automatisch.
 */
export interface ArtikelPurchase {
  id: string;
  articleId: string;
  articleName: string;   // denormalisiert für historische Auswertung
  date: string;          // YYYY-MM-DD
  year: number;
  month: number;
  quantity: number;
  pricePerUnit: number;  // NET CHF / Einheit
  totalCost: number;     // quantity × pricePerUnit (NET CHF)
  supplier: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Monatliche Analyse für einen einzelnen Artikel. */
export interface ArtikelMonthStats {
  articleId: string;
  year: number;
  month: number;
  /** Anzahl erfasster Einkäufe */
  orderCount: number;
  /** Gesamte eingekaufte Menge (in Artikel-Einheit) */
  purchasedQty: number;
  /** Gesamte Einkaufskosten NET CHF */
  purchasedCHF: number;
  /** Durchschnittlicher Einkaufspreis/Einheit NET CHF (null wenn keine Käufe) */
  avgPricePerUnit: number | null;
  /** Durchschnittliche Tage zwischen Bestellungen (null wenn < 2 Käufe) */
  avgDaysBetweenOrders: number | null;
  /**
   * Theoretischer Verbrauch in Artikel-Einheit (aus Rezeptur × Verkauf).
   * null wenn der Artikel in keiner Rezeptur vorkommt ODER
   * keine Verkaufszahlen für diesen Monat vorhanden.
   */
  theoreticalConsumption: number | null;
  /** Differenz: purchasedQty − theoreticalConsumption (null wenn kein theo. Verbrauch) */
  diffQty: number | null;
  /** Wurde für diesen Artikel eine Rezeptur gefunden? */
  hasRecipes: boolean;
  /** Alle Einkäufe dieses Monats */
  purchases: ArtikelPurchase[];
}

// ── Persistenz ────────────────────────────────────────────────────────────────

type PurchaseStore = Record<string, ArtikelPurchase>;

function loadAll(tenantId: TenantId): PurchaseStore {
  try {
    const raw = localStorage.getItem(tenantKey(tenantId, PURCHASE_KEY));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveAll(tenantId: TenantId, store: PurchaseStore): void {
  localStorage.setItem(tenantKey(tenantId, PURCHASE_KEY), JSON.stringify(store));
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function addPurchase(tenantId: TenantId, input: {
  articleId: string;
  articleName: string;
  date: string;
  quantity: number;
  pricePerUnit: number;
  supplier: string;
  note?: string;
}): ArtikelPurchase {
  const all = loadAll(tenantId);
  const now = new Date().toISOString();
  const d   = new Date(input.date);
  const p: ArtikelPurchase = {
    id:           uuidv4(),
    articleId:    input.articleId,
    articleName:  input.articleName,
    date:         input.date,
    year:         d.getFullYear(),
    month:        d.getMonth() + 1,
    quantity:     input.quantity,
    pricePerUnit: input.pricePerUnit,
    totalCost:    Math.round(input.quantity * input.pricePerUnit * 10000) / 10000,
    supplier:     input.supplier,
    note:         input.note?.trim() || undefined,
    createdAt:    now,
    updatedAt:    now,
  };
  all[p.id] = p;
  saveAll(tenantId, all);
  return p;
}

export function deletePurchase(tenantId: TenantId, id: string): void {
  const all = loadAll(tenantId);
  delete all[id];
  saveAll(tenantId, all);
}

export function loadAllPurchases(tenantId: TenantId): ArtikelPurchase[] {
  return Object.values(loadAll(tenantId)).sort((a, b) => b.date.localeCompare(a.date));
}

export function loadPurchasesForArticle(tenantId: TenantId, articleId: string): ArtikelPurchase[] {
  return Object.values(loadAll(tenantId))
    .filter(p => p.articleId === articleId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function loadPurchasesForMonth(tenantId: TenantId, year: number, month: number): ArtikelPurchase[] {
  return Object.values(loadAll(tenantId))
    .filter(p => p.year === year && p.month === month)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Alle Jahre mit Einkaufsbelegen (+ aktuelles Jahr). */
export function availablePurchaseYears(tenantId: TenantId): number[] {
  const all = Object.values(loadAll(tenantId));
  const years = new Set(all.map(p => p.year));
  years.add(new Date().getFullYear());
  return [...years].sort((a, b) => b - a);
}

// ── Analyse ───────────────────────────────────────────────────────────────────

/**
 * Berechnet die monatliche Tracking-Auswertung für einen Artikel.
 *
 * Theoretischer Verbrauch wird berechnet aus:
 *   Σ (Rezeptur.Zutat.Menge × Verkaufsanzahl des Produkts im Monat)
 *   für alle Rezepturen, die diesen Artikel als Zutat enthalten.
 */
export function getArtikelMonthStats(
  tenantId: TenantId,
  articleId: string,
  year: number,
  month: number,
  rezepturen: ProductRecipe[],
  products: ProductEntry[],
): ArtikelMonthStats {
  const purchases = Object.values(loadAll(tenantId)).filter(
    p => p.articleId === articleId && p.year === year && p.month === month,
  );

  const orderCount   = purchases.length;
  const purchasedQty = purchases.reduce((s, p) => s + p.quantity, 0);
  const purchasedCHF = purchases.reduce((s, p) => s + p.totalCost, 0);

  const avgPricePerUnit: number | null =
    orderCount > 0 ? purchasedCHF / purchasedQty : null;

  // Ø Tage zwischen Bestellungen
  let avgDaysBetweenOrders: number | null = null;
  if (purchases.length >= 2) {
    const sorted = [...purchases].sort((a, b) => a.date.localeCompare(b.date));
    const diffs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const d1 = new Date(sorted[i - 1].date).getTime();
      const d2 = new Date(sorted[i].date).getTime();
      diffs.push((d2 - d1) / (1000 * 60 * 60 * 24));
    }
    avgDaysBetweenOrders = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  }

  // Theoretischer Verbrauch aus Rezeptur × Verkauf
  const monthKey        = `${year}-${String(month).padStart(2, '0')}`;
  const matchingRecipes = rezepturen.filter(r =>
    r.ingredients.some(i => i.articleId === articleId),
  );
  const hasRecipes = matchingRecipes.length > 0;

  let theoreticalConsumption: number | null = hasRecipes ? 0 : null;

  if (hasRecipes) {
    for (const recipe of matchingRecipes) {
      const sold = products.find(
        p =>
          p.name.trim().toLowerCase() === recipe.productName.trim().toLowerCase() &&
          p.month === monthKey,
      );
      if (sold && sold.count > 0) {
        const ing = recipe.ingredients.find(i => i.articleId === articleId);
        if (ing) {
          theoreticalConsumption = (theoreticalConsumption ?? 0) + ing.quantity * sold.count;
        }
      }
    }
    // Wenn Rezepturen vorhanden, aber keine Verkaufsdaten → null (kein Verkaufsmonat)
    const hasAnySales = matchingRecipes.some(r =>
      products.some(
        p =>
          p.name.trim().toLowerCase() === r.productName.trim().toLowerCase() &&
          p.month === monthKey &&
          p.count > 0,
      ),
    );
    if (!hasAnySales) theoreticalConsumption = null;
  }

  const diffQty =
    theoreticalConsumption !== null && purchasedQty > 0
      ? purchasedQty - theoreticalConsumption
      : null;

  return {
    articleId,
    year,
    month,
    orderCount,
    purchasedQty,
    purchasedCHF,
    avgPricePerUnit,
    avgDaysBetweenOrders,
    theoreticalConsumption,
    diffQty,
    hasRecipes,
    purchases,
  };
}
