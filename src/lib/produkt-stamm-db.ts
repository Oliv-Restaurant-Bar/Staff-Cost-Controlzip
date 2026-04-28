/**
 * produkt-stamm-db.ts
 * ===================
 * CRUD für die Tabelle produkte_kosten (Supabase).
 *
 * Schema:
 *   id            BIGSERIAL  PK
 *   restaurant_id TEXT       Tenant-Kennung (z.B. 'oliv', 'beaulieu')
 *   name          TEXT       NOT NULL
 *   category      TEXT       'food' | 'beverage'
 *   wes           NUMERIC    WES pro Stück (CHF)   ← das ist wes_per_unit
 *   wes_q         NUMERIC    WES-Quote (%) — wird auto berechnet / optional
 *   updated_at    TIMESTAMPTZ
 *   UNIQUE (restaurant_id, name, category)
 *
 * Authentifizierung: RLS-Policies erlauben Lesen + Schreiben für alle
 * eingeloggten Benutzer.
 */

import { supabase } from '@/integrations/supabase/client';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface ProduktStammRow {
  id:          number;
  name:        string;
  category:    'food' | 'beverage';
  wes_per_unit: number;   // DB-Spalte: wes
  updated_at:  string;
}

export interface ProduktStammInsert {
  name:          string;
  category:      'food' | 'beverage';
  wes:           number;
  wes_q?:        number;
  restaurant_id: string;
}

// Fehlercode wenn Tabelle nicht existiert
const TABLE_NOT_FOUND_CODE = 'PGRST205';

// ─── Lesen ───────────────────────────────────────────────────────────────────

export async function loadProduktStamm(restaurantId: string = 'oliv'): Promise<ProduktStammRow[]> {
  console.log(`[PRODUCTS] tenant: ${restaurantId}`);
  console.log(`[PRODUCTS] table name used: produkte_kosten`);

  const { data, error } = await (supabase as any)
    .from('produkte_kosten')
    .select('id, name, category, wes, updated_at')
    .eq('restaurant_id', restaurantId)
    .order('name', { ascending: true });

  if (error) {
    // Immer den vollen Fehler loggen damit wir den echten Code sehen
    console.error('[PRODUCTS] Supabase error full object:', JSON.stringify(error));
    console.log('[PRODUCTS] error.code:', error.code);
    console.log('[PRODUCTS] error.message:', error.message);
    console.log('[PRODUCTS] error.details:', error.details);
    console.log('[PRODUCTS] error.hint:', error.hint);

    // PGRST205 = Relation does not exist (Tabelle fehlt)
    // 42P01 = PostgreSQL undefined_table
    const isTableMissing =
      error.code === 'PGRST205' ||
      error.code === '42P01' ||
      (typeof error.message === 'string' && (
        error.message.toLowerCase().includes('relation') && error.message.toLowerCase().includes('does not exist')
      )) ||
      (typeof error.message === 'string' && error.message.toLowerCase().includes('undefined_table'));

    if (isTableMissing) {
      console.warn(`[PRODUCTS] table exists: no — Tabelle fehlt, bitte Migration ausführen`);
      console.log(`[PRODUCTS] empty state vs error: TABLE_MISSING`);
      throw new Error(`Tabelle 'produkte_kosten' fehlt. Bitte die SQL-Migration ausführen. (${error.code})`);
    }
    console.error('[ProduktStamm] loadProduktStamm error:', error);
    console.log(`[PRODUCTS] table exists: unknown — Fehler beim Laden`);
    throw new Error(`Laden fehlgeschlagen: ${error.message} (${error.code})`);
  }

  const rows = data ?? [];
  console.log(`[PRODUCTS] table exists: yes`);
  console.log(`[PRODUCTS] rows loaded: ${rows.length}`);
  console.log(`[PRODUCTS] empty state vs error: ${rows.length === 0 ? 'EMPTY_OK' : 'HAS_DATA'}`);

  return rows.map((r: any) => ({
    id:           r.id,
    name:         r.name,
    category:     r.category,
    wes_per_unit: Number(r.wes ?? 0),
    updated_at:   r.updated_at ?? '',
  }));
}

// ─── Einfügen / Aktualisieren (UPSERT) ───────────────────────────────────────

export async function upsertProduktStamm(
  entry: ProduktStammInsert,
): Promise<ProduktStammRow> {
  const { data, error } = await (supabase as any)
    .from('produkte_kosten')
    .upsert(
      {
        restaurant_id: entry.restaurant_id,
        name:          entry.name.trim(),
        category:      entry.category,
        wes:           entry.wes,
        wes_q:         entry.wes_q ?? 0,
      },
      { onConflict: 'restaurant_id,name,category' },
    )
    .select('id, name, category, wes, updated_at')
    .single();

  if (error) {
    console.error('[ProduktStamm] upsertProduktStamm error:', error);
    throw new Error(`Speichern fehlgeschlagen: ${error.message} (${error.code})`);
  }

  return {
    id:           data.id,
    name:         data.name,
    category:     data.category,
    wes_per_unit: Number(data.wes ?? 0),
    updated_at:   data.updated_at ?? '',
  };
}

// ─── Aktualisieren per ID ─────────────────────────────────────────────────────

export async function updateProduktStammRow(
  id: number,
  fields: { name?: string; category?: 'food' | 'beverage'; wes?: number },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (fields.name     !== undefined) patch.name     = fields.name.trim();
  if (fields.category !== undefined) patch.category = fields.category;
  if (fields.wes      !== undefined) patch.wes      = fields.wes;

  const { error } = await (supabase as any)
    .from('produkte_kosten')
    .update(patch)
    .eq('id', id);

  if (error) {
    console.error('[ProduktStamm] updateProduktStammRow error:', error);
    throw new Error(`Update fehlgeschlagen: ${error.message}`);
  }
}

// ─── Löschen ─────────────────────────────────────────────────────────────────

export async function deleteProduktStammRow(id: number): Promise<void> {
  const { error } = await (supabase as any)
    .from('produkte_kosten')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[ProduktStamm] deleteProduktStammRow error:', error);
    throw new Error(`Löschen fehlgeschlagen: ${error.message}`);
  }
}

// ─── Aus product_sales befüllen ───────────────────────────────────────────────

/**
 * Lädt alle distinct product_names aus product_sales (mit source).
 * Gibt nur Namen zurück, die noch NICHT in produkte_kosten vorhanden sind.
 */
export async function loadNewNamesFromSales(
  existing: ProduktStammRow[],
): Promise<string[]> {
  const { data, error } = await (supabase as any)
    .from('product_sales')
    .select('product_name')
    .not('source', 'is', null);

  if (error) {
    console.error('[ProduktStamm] loadNewNamesFromSales error:', error);
    return [];
  }

  const existingNames = new Set(existing.map(r => r.name.trim().toLowerCase()));
  const distinct = new Set<string>();
  for (const r of data ?? []) {
    if (r.product_name) {
      const n = r.product_name.trim();
      if (!existingNames.has(n.toLowerCase())) distinct.add(n);
    }
  }
  return Array.from(distinct).sort();
}
