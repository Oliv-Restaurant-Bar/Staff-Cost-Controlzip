/**
 * WES-Status Utility
 * ===================
 * Wareneinsatzquote (WES) Schwellenwerte und Hilfsfunktionen.
 *
 * Verwendung in: RezepturDialog, Produkte, WesMarginWidget (Dashboard)
 *
 * Schwellenwerte (gemäss Spezifikation):
 *   Grün:  WES ≤ 28%
 *   Amber: 28% < WES ≤ 35%
 *   Rot:   WES > 35%
 */

import type { ProductRecipe } from '@/lib/rezeptur-store';

export type WesStatus = 'green' | 'amber' | 'red' | 'unknown';

/** Obere Grenze für «Grün» */
export const WES_GREEN_MAX = 28;
/** Obere Grenze für «Amber» */
export const WES_AMBER_MAX = 35;
/** Schwelle für Kategorie-Alarm: > 30% der Produkte ROT → Warnung */
export const WES_CATEGORY_ALARM_PCT = 30;

// ─── Status-Berechnung ────────────────────────────────────────────────────────

export function getWesStatus(wesPct: number): WesStatus {
  if (wesPct <= 0) return 'unknown';
  if (wesPct <= WES_GREEN_MAX) return 'green';
  if (wesPct <= WES_AMBER_MAX) return 'amber';
  return 'red';
}

// ─── UI-Klassen ───────────────────────────────────────────────────────────────

/** Tailwind-Klassen für einen Badge-Chip (Border-Box Stil) */
export function getWesBadgeClasses(status: WesStatus): string {
  switch (status) {
    case 'green':
      return 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800';
    case 'amber':
      return 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800';
    case 'red':
      return 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

/** Tailwind-Klasse für einen kleinen Farbpunkt */
export function getWesDotClass(status: WesStatus): string {
  switch (status) {
    case 'green':  return 'bg-green-500';
    case 'amber':  return 'bg-amber-500';
    case 'red':    return 'bg-red-500';
    default:       return 'bg-gray-400';
  }
}

/** Kurzlabel für Badges */
export function getWesStatusLabel(status: WesStatus): string {
  switch (status) {
    case 'green':  return 'Gut';
    case 'amber':  return 'Prüfen';
    case 'red':    return 'Kritisch';
    default:       return '–';
  }
}

/** Vollständiges deutsches Label mit Schwellenwert */
export function getWesStatusFullLabel(status: WesStatus): string {
  switch (status) {
    case 'green':  return `Gut (≤ ${WES_GREEN_MAX}%)`;
    case 'amber':  return `Prüfen (${WES_GREEN_MAX}–${WES_AMBER_MAX}%)`;
    case 'red':    return `Kritisch (> ${WES_AMBER_MAX}%)`;
    default:       return 'Kein Verkaufspreis';
  }
}

// ─── Vertriebskanal-Klassifikation ───────────────────────────────────────────

export type ProductSalesCategory = 'Lunch' | 'Take Away' | 'Frühstück' | 'Getränke' | 'Restaurant';

export const ALL_SALES_CATEGORIES: ProductSalesCategory[] = [
  'Restaurant', 'Lunch', 'Take Away', 'Frühstück', 'Getränke',
];

export function getProductSalesCategory(
  recipe: Pick<ProductRecipe, 'salesChannel' | 'lunchPool' | 'category'>,
): ProductSalesCategory {
  if (recipe.salesChannel === 'takeaway')  return 'Take Away';
  if (recipe.salesChannel === 'breakfast') return 'Frühstück';
  if (recipe.salesChannel === 'lunch' || recipe.lunchPool)  return 'Lunch';
  if (recipe.category === 'beverage') return 'Getränke';
  return 'Restaurant';
}

// ─── Verbesserungsvorschläge ──────────────────────────────────────────────────

/**
 * Liefert konkrete Massnahmen-Vorschläge für Produkte mit schlechter Marge.
 * Leer wenn WES im grünen oder amberen Bereich.
 */
export function getSmartSuggestions(wesPct: number): string[] {
  if (wesPct <= WES_AMBER_MAX) return [];
  return [
    'Preis erhöhen empfohlen',
    'Portion reduzieren prüfen',
    'Einkaufspreis überprüfen',
  ];
}
