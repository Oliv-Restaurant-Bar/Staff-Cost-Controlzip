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
    onlyInventurRelevant?: boolean;
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
  return { total, active, food, beverage, withCost, inventurCount };
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

/**
 * Stellt sicher, dass jeder Artikel ein Fibu-Konto hat.
 * Fehlende Konten werden auf '4090' (Diverses) gesetzt.
 * Wird beim Laden aus der DB aufgerufen – keine UI-Interaktion nötig.
 */
export function ensureAccountingAccounts(articles: Artikel[]): { articles: Artikel[]; patched: number } {
  let patched = 0;
  const fixed = articles.map(a => {
    if (!a.accountingAccount) {
      patched++;
      return { ...a, accountingAccount: '4090', updatedAt: new Date().toISOString() };
    }
    return a;
  });
  return { articles: fixed, patched };
}
