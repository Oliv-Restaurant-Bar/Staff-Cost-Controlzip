/**
 * produkt-stamm-db.ts
 * ===================
 * CRUD für die Tabelle produkte_kosten (Supabase).
 *
 * Schema:
 *   id           BIGSERIAL  PK
 *   name         TEXT       NOT NULL
 *   category     TEXT       'food' | 'beverage'
 *   wes          NUMERIC    WES pro Stück (CHF)   ← das ist wes_per_unit
 *   wes_q        NUMERIC    WES-Quote (%) — wird auto berechnet / optional
 *   updated_at   TIMESTAMPTZ
 *   UNIQUE (name, category)
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
  name:     string;
  category: 'food' | 'beverage';
  wes:      number;
  wes_q?:   number;
}

// ─── Lesen ───────────────────────────────────────────────────────────────────

export async function loadProduktStamm(): Promise<ProduktStammRow[]> {
  const { data, error } = await (supabase as any)
    .from('produkte_kosten')
    .select('id, name, category, wes, updated_at')
    .order('name', { ascending: true });

  if (error) {
    console.error('[ProduktStamm] loadProduktStamm error:', error);
    throw new Error(`Laden fehlgeschlagen: ${error.message} (${error.code})`);
  }

  return (data ?? []).map((r: any) => ({
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
        name:     entry.name.trim(),
        category: entry.category,
        wes:      entry.wes,
        wes_q:    entry.wes_q ?? 0,
      },
      { onConflict: 'name,category' },
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
