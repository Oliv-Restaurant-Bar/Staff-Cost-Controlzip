/**
 * Artikelstamm Store
 * ==================
 * Zentrale Artikelverwaltung für Food & Beverage.
 * Speicherung: Supabase app_settings (via kvGet/kvSet) + localStorage Fallback.
 *
 * Zukünftige Migration: eigene `articles`-Tabelle in Supabase (siehe Migration SQL).
 */

import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet, kvSetConfirmed } from '@/lib/supabase-kv';
import { supabase } from '@/integrations/supabase/client';

// ── Konstanten ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'artikel_master_v1';

// ── Lagerorte ─────────────────────────────────────────────────────────────────

export const STORAGE_LOCATIONS_FOOD     = ['TK', 'Frigo', 'Gemüselager', 'Trockenlager'] as const;
export const STORAGE_LOCATIONS_BEVERAGE = ['Keller', 'EG Buffet', 'UG Buffet'] as const;

export const ALL_STORAGE_LOCATIONS = [
  ...STORAGE_LOCATIONS_FOOD,
  ...STORAGE_LOCATIONS_BEVERAGE,
] as const;

export type StorageLocation = (typeof ALL_STORAGE_LOCATIONS)[number];

// ── Einheiten ─────────────────────────────────────────────────────────────────

export const UNITS_FOOD     = ['kg', 'g', 'Stück', 'Portion', 'Bund', 'Packung', 'Liter', 'dl', 'cl', 'ml'];
export const UNITS_BEVERAGE = ['Flasche', 'Liter', 'dl', 'cl', 'Dose', 'Keg', 'Karton', 'Stück'];
export const ALL_UNITS      = [...new Set([...UNITS_FOOD, ...UNITS_BEVERAGE])].sort();

// ── Fibu-Konten ───────────────────────────────────────────────────────────────
//
// Wareneinsatz-Konten gemäss Kontenplan Oliv Gastro AG.
// Werden für den Vergleich:
//   Rezept-WES  vs.  Lieferanten-WES  vs.  Buchhaltungs-WES
// verwendet. Alle Preise sind NETTO (exkl. MwSt.).

export interface FibuAccount {
  code:  string;   // z.B. '4020'
  label: string;   // z.B. 'Wein'
}

export const FIBU_ACCOUNTS: FibuAccount[] = [
  { code: '4020', label: 'Wein'              },
  { code: '4030', label: 'Bier'              },
  { code: '4040', label: 'Spirituosen'       },
  { code: '4050', label: 'Mineral'           },
  { code: '4060', label: 'Küche / Food'      },
  { code: '4061', label: 'Rest Food'         },
  { code: '4070', label: 'Kaffee & Tee'      },
  { code: '4090', label: 'Diverses'          },
  { code: '4701', label: 'Betriebsmaterial'  },
];

export function getFibuLabel(code: string): string {
  const acc = FIBU_ACCOUNTS.find(a => a.code === code);
  return acc ? `${acc.code} ${acc.label}` : code;
}

// ── Typen ─────────────────────────────────────────────────────────────────────

export type InventoryType = 'food' | 'beverage';

/**
 * Lieferantenreferenz – heute Freitext, später FK in Lieferantenstamm.
 * Die Struktur ist so gewählt, dass spätere Erweiterungen (Bestellnummer,
 * Mindestbestellmenge, Lieferzeit usw.) einfach hinzugefügt werden können.
 */
export interface SupplierRef {
  name:  string;   // Lieferantenname (Freitext → später: id)
  price: number;   // Preis pro Einheit bei diesem Lieferanten
}

export interface Artikel {
  id: string;
  name: string;
  inventoryType: InventoryType;
  unit: string;
  /**
   * Standardpreis NETTO (exkl. MwSt.) beim Standard-Lieferanten.
   * Alle WES-Vergleiche (Rezept / Lieferant / Buchhaltung) nutzen ausschliesslich
   * Nettopreise, damit die MwSt. die Wareneinsatzquote nicht verzerrt.
   */
  defaultCostPerUnit: number;
  /** Standard-Lieferant (immer gesetzt, Freitext) */
  standardSupplier: string;
  /** Ausweichlieferant aktiv? */
  fallbackEnabled: boolean;
  /** Ausweich-Lieferant (nur relevant wenn fallbackEnabled) */
  fallbackSupplier: string;
  /**
   * Ausweich-Preis NETTO (exkl. MwSt.).
   * Gleiche Netto-Regel wie defaultCostPerUnit.
   */
  fallbackPrice: number;
  /**
   * Fibu-Konto für WES-Mapping (z.B. '4020', '4060').
   * Erlaubt Vergleich: Rezept-WES vs. Lieferanten-WES vs. Buchhaltungs-WES
   * auf Kontenebene.
   */
  accountingAccount: string;
  storageLocations: string[];
  /**
   * Inventur-relevant: Artikel soll bei der Inventur besonders beachtet werden.
   * Typisch: teure Artikel, vielseitig verwendete Grundzutaten (Öl, Rahm, Butter),
   * Artikel die nicht vollständig über Rezepte erfasst sind.
   * Standard: false
   */
  inventurRelevant: boolean;
  /**
   * Tracking aktiv: Vollständige Einkaufs- und Verbrauchsanalyse für diesen Artikel.
   * Manuelle Einkaufsbuchungen + theoretischer Verbrauch aus Rezeptur/Verkauf werden
   * pro Monat ausgewertet. Sinnvoll für hochpreisige oder kritische Artikel.
   * Standard: false
   */
  trackingAktiv: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArtikelStore {
  articles: Artikel[];
  updatedAt: string;
}

// ── localStorage Helpers ──────────────────────────────────────────────────────

function localLoad(): ArtikelStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { articles: [], updatedAt: new Date().toISOString() };
  } catch { return { articles: [], updatedAt: new Date().toISOString() }; }
}

function localSave(store: ArtikelStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

// ── Supabase-Sync ─────────────────────────────────────────────────────────────

export async function loadArtikelFromDB(): Promise<ArtikelStore> {
  try {
    const remote = await kvGet(STORAGE_KEY) as ArtikelStore | null;
    if (remote && Array.isArray(remote.articles) && remote.articles.length > 0) {
      // Sicherstellen, dass jeder Artikel ein Fibu-Konto hat (Migration)
      const { articles: fixed, patched } = ensureAccountingAccounts(remote.articles);
      const store: ArtikelStore = { ...remote, articles: fixed };
      localSave(store);
      if (patched > 0) {
        await kvSet(STORAGE_KEY, store);
        console.log('[Artikel] Fibu-Konto Migration:', patched, 'Artikel auf 4090 gesetzt');
      } else {
        console.log('[Artikel] Aus Supabase geladen:', fixed.length, 'Artikel');
      }
      return store;
    }
    const local = localLoad();
    const { articles: fixed, patched } = ensureAccountingAccounts(local.articles);
    const store: ArtikelStore = { ...local, articles: fixed };
    if (store.articles.length > 0) {
      await kvSet(STORAGE_KEY, store);
      console.log('[Artikel] localStorage → Supabase (Erstmigration):', store.articles.length, 'Artikel');
    }
    return store;
  } catch (err) {
    console.error('[Artikel] loadArtikelFromDB Fehler:', err);
    return localLoad();
  }
}

export async function saveArtikelToDB(store: ArtikelStore): Promise<void> {
  // Database-first (Issue #5): cache locally only after Supabase confirms —
  // `kvSet` used to swallow write errors silently while localStorage was
  // already updated, showing "saved" even when it wasn't. Kept non-throwing
  // (same contract as before) since callers don't currently await/catch this.
  try {
    await kvSetConfirmed(STORAGE_KEY, store, 'Artikelstamm');
  } catch (err) {
    console.error('[Artikel] saveArtikelToDB Fehler:', err);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createArtikel(
  data: Omit<Artikel, 'id' | 'createdAt' | 'updatedAt'>,
): Artikel {
  const now = new Date().toISOString();
  return {
    ...data,
    id:        uuidv4(),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateArtikel(existing: Artikel, patch: Partial<Omit<Artikel, 'id' | 'createdAt'>>): Artikel {
  return {
    ...existing,
    ...patch,
    id:        existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

// ── Filter & Suche ────────────────────────────────────────────────────────────

export function filterArtikel(
  articles: Artikel[],
  opts: {
    inventoryType?: InventoryType | 'all';
    storageLocation?: string | null;
    search?: string;
    showInactive?: boolean;
    onlyInventurRelevant?: boolean;
    onlyTracking?: boolean;
  },
): Artikel[] {
  let list = articles;

  if (!opts.showInactive) list = list.filter(a => a.active);

  if (opts.inventoryType && opts.inventoryType !== 'all') {
    list = list.filter(a => a.inventoryType === opts.inventoryType);
  }

  if (opts.storageLocation) {
    list = list.filter(a => a.storageLocations.includes(opts.storageLocation!));
  }

  if (opts.search) {
    const q = opts.search.toLowerCase();
    list = list.filter(a => a.name.toLowerCase().includes(q));
  }

  if (opts.onlyInventurRelevant) {
    list = list.filter(a => a.inventurRelevant === true);
  }

  if (opts.onlyTracking) {
    list = list.filter(a => a.trackingAktiv === true);
  }

  return list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ── Statistiken ───────────────────────────────────────────────────────────────

export function getArtikelStats(articles: Artikel[]) {
  const total          = articles.length;
  const active         = articles.filter(a => a.active).length;
  const food           = articles.filter(a => a.inventoryType === 'food').length;
  const beverage       = articles.filter(a => a.inventoryType === 'beverage').length;
  const withCost       = articles.filter(a => a.defaultCostPerUnit > 0).length;
  const inventurCount  = articles.filter(a => a.inventurRelevant === true).length;
  const trackingCount  = articles.filter(a => a.trackingAktiv === true).length;
  return { total, active, food, beverage, withCost, inventurCount, trackingCount };
}

// ── Fibu-Konto: Single Source of Truth ───────────────────────────────────────

/**
 * Gibt das Fibu-Konto eines Rezept-Zutaten-Eintrags zurück.
 *
 * Priorität:
 *  1. Live-Lookup aus Artikelstamm (wenn articleId gesetzt) → SINGLE SOURCE OF TRUTH
 *  2. Gespeicherter Snapshot auf der Zutat (Fallback für manuelle Zutaten ohne articleId)
 *  3. '4090' Diverses als letzter Fallback
 *
 * So bleibt das Fibu-Konto stets aktuell:
 * Änderst du das Konto im Artikelstamm, wird es beim nächsten Laden
 * der Rezeptur sofort korrekt angezeigt – ohne manuelle Anpassung.
 */
export function resolveIngredientAccount(
  ingredient: { articleId?: string; accountingAccount?: string },
  articles: Artikel[],
): string {
  if (ingredient.articleId) {
    const art = articles.find(a => a.id === ingredient.articleId);
    if (art?.accountingAccount) return art.accountingAccount;
  }
  return ingredient.accountingAccount || '4090';
}

// ── Import aus product_sales ──────────────────────────────────────────────────

/**
 * Liest alle eindeutigen product_name-Werte aus product_sales und legt
 * fehlende Artikel im Artikelstamm an.
 *
 * Regeln:
 *  - Keine bestehenden Artikel überschreiben (Dedup: exact lowercase match)
 *  - inventoryType aus `source`-Spalte (food_csv_export → food, beverage_ → beverage)
 *  - Fallback: Lookup in produkte_kosten nach category
 *  - Wenn keines verfügbar: inventoryType = 'food', accountingAccount = '4090'
 *
 * @returns { newCount, updatedStore }
 */
export async function importArtikelFromProductSales(
  currentStore: ArtikelStore,
): Promise<{ newCount: number; updatedStore: ArtikelStore }> {
  // 1. Alle eindeutigen Produkte aus product_sales (name + neueste source)
  const { data: salesRows, error: salesErr } = await (supabase as any)
    .from('product_sales')
    .select('product_name, source')
    .not('product_name', 'is', null);

  if (salesErr) throw new Error(`product_sales Fehler: ${salesErr.message}`);

  // Deduplizieren: pro product_name die zuerst gefundene source behalten
  const salesMap = new Map<string, string>(); // lc-name → source
  for (const row of salesRows ?? []) {
    const lc = (row.product_name as string).trim().toLowerCase();
    if (lc && !salesMap.has(lc)) salesMap.set(lc, row.source ?? '');
  }

  console.log(`[Artikel-Import] product_sales: ${salesMap.size} eindeutige Produkte`);

  // 2. Kategorie-Fallback aus produkte_kosten
  const { data: kostRows } = await (supabase as any)
    .from('produkte_kosten')
    .select('name, category');

  const kostMap = new Map<string, 'food' | 'beverage'>(); // lc-name → category
  for (const row of kostRows ?? []) {
    if (row.name && row.category) {
      kostMap.set((row.name as string).trim().toLowerCase(), row.category as 'food' | 'beverage');
    }
  }

  // 3. Bestehende Artikel-Namen (lowercase) für Dedup
  const existingNames = new Set(
    currentStore.articles.map(a => a.name.trim().toLowerCase()),
  );

  // 4. Neue Artikel erzeugen
  const newArticles: Artikel[] = [];
  const now = new Date().toISOString();

  for (const [lcName, source] of salesMap.entries()) {
    if (existingNames.has(lcName)) continue; // Bereits vorhanden – überspringen

    // originalName: erster Eintrag aus salesRows mit passendem lc-Name
    const original = salesRows?.find(
      (r: any) => r.product_name.trim().toLowerCase() === lcName,
    )?.product_name ?? lcName;

    // inventoryType aus source oder produkte_kosten
    let inventoryType: InventoryType = 'food';
    if (source.startsWith('beverage')) {
      inventoryType = 'beverage';
    } else if (source.startsWith('food')) {
      inventoryType = 'food';
    } else if (kostMap.has(lcName)) {
      inventoryType = kostMap.get(lcName)!;
    }

    // Fibu-Konto
    const accountingAccount = inventoryType === 'food' ? '4060' : '4090';

    const artikel: Artikel = {
      id:                 uuidv4(),
      name:               original.trim(),
      inventoryType,
      unit:               inventoryType === 'food' ? 'Portion' : 'Stück',
      defaultCostPerUnit: 0,
      standardSupplier:   '',
      fallbackEnabled:    false,
      fallbackSupplier:   '',
      fallbackPrice:      0,
      accountingAccount,
      storageLocations:   [],
      inventurRelevant:   false,
      trackingAktiv:      false,
      active:             true,
      createdAt:          now,
      updatedAt:          now,
    };

    newArticles.push(artikel);
    existingNames.add(lcName); // in-loop dedup
  }

  console.log(
    `[Artikel-Import] ${newArticles.length} neue Artikel (von ${salesMap.size} Produkten, ` +
    `${salesMap.size - newArticles.length} bereits vorhanden)`,
  );

  if (newArticles.length === 0) {
    return { newCount: 0, updatedStore: currentStore };
  }

  const updatedStore: ArtikelStore = {
    articles: [...currentStore.articles, ...newArticles],
    updatedAt: now,
  };
  return { newCount: newArticles.length, updatedStore };
}

export function ensureAccountingAccounts(articles: Artikel[]): { articles: Artikel[]; patched: number } {
  let patched = 0;
  const fixed = articles.map(a => {
    const needsAccount  = !a.accountingAccount;
    const needsTracking = (a as Record<string, unknown>).trackingAktiv === undefined;
    if (needsAccount || needsTracking) {
      patched++;
      return {
        ...a,
        accountingAccount: a.accountingAccount || '4090',
        trackingAktiv:     needsTracking ? (a.inventurRelevant ?? false) : a.trackingAktiv,
        updatedAt: new Date().toISOString(),
      };
    }
    return a;
  });
  return { articles: fixed, patched };
}
