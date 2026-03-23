/**
 * Artikelstamm Store
 * ==================
 * Zentrale Artikelverwaltung für Food & Beverage.
 * Speicherung: Supabase app_settings (via kvGet/kvSet) + localStorage Fallback.
 *
 * Zukünftige Migration: eigene `articles`-Tabelle in Supabase (siehe Migration SQL).
 */

import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvSet } from '@/lib/supabase-kv';

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
  /** Standardpreis (= standardSupplier.price, rückwärtskompatibel) */
  defaultCostPerUnit: number;
  /** Standard-Lieferant (immer gesetzt, Freitext) */
  standardSupplier: string;
  /** Ausweichlieferant aktiv? */
  fallbackEnabled: boolean;
  /** Ausweich-Lieferant (nur relevant wenn fallbackEnabled) */
  fallbackSupplier: string;
  /** Preis beim Ausweich-Lieferanten (nur relevant wenn fallbackEnabled) */
  fallbackPrice: number;
  storageLocations: string[];
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
      localSave(remote);
      console.log('[Artikel] Aus Supabase geladen:', remote.articles.length, 'Artikel');
      return remote;
    }
    const local = localLoad();
    if (local.articles.length > 0) {
      await kvSet(STORAGE_KEY, local);
      console.log('[Artikel] localStorage → Supabase (Erstmigration):', local.articles.length, 'Artikel');
    }
    return local;
  } catch (err) {
    console.error('[Artikel] loadArtikelFromDB Fehler:', err);
    return localLoad();
  }
}

export async function saveArtikelToDB(store: ArtikelStore): Promise<void> {
  localSave(store);
  try {
    await kvSet(STORAGE_KEY, store);
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

  return list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

// ── Statistiken ───────────────────────────────────────────────────────────────

export function getArtikelStats(articles: Artikel[]) {
  const total     = articles.length;
  const active    = articles.filter(a => a.active).length;
  const food      = articles.filter(a => a.inventoryType === 'food').length;
  const beverage  = articles.filter(a => a.inventoryType === 'beverage').length;
  const withCost  = articles.filter(a => a.defaultCostPerUnit > 0).length;
  return { total, active, food, beverage, withCost };
}
