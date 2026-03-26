/**
 * sales-db.ts – Supabase Queries für Verkaufsdaten & Produktanalyse
 * ==================================================================
 * Lädt Daten aus den folgenden Supabase Views und Tabellen:
 *   Views:  management_dashboard, dashboard_category_kpis,
 *           dashboard_top_products, dashboard_problem_products,
 *           sales_import_batches, product_matrix
 *   Tabellen: products, product_sales
 *
 * Verwendet (supabase as any) für Views/Tabellen, die noch nicht
 * im generierten TypeScript-Typ erfasst sind.
 */

import { supabase } from '@/integrations/supabase/client';

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface ManagementDashboard {
  total_products:   number;
  avg_wes_percent:  number;
  total_revenue:    number;
  total_qty:        number;
  stars:            number;
  cash_cows:        number;
  puzzles:          number;
  dogs:             number;
}

export interface CategoryKpi {
  category:         string;
  total_products:   number;
  avg_wes_percent:  number;
  total_qty:        number;
  total_revenue:    number;
}

export interface TopProduct {
  category:     string;
  product_name: string;
  total_qty:    number;
  total_revenue: number;
}

export interface ProblemProduct {
  name:             string;
  category:         string;
  total_qty:        number;
  total_revenue:    number;
  wes_percent_fixed: number;
  matrix_category:  string;
}

export interface ImportBatch {
  import_batch:      string;
  source:            string;
  sales_date:        string;   // frühestes Datum im Batch
  rows_imported:     number;
  total_qty:         number;
  total_revenue:     number;
  imported_at:       string;   // aus Batch-ID geparst (YYYY-MM-DDTHH:MM:00)
}

export interface ProductMatrixRow {
  name:             string;
  category:         string;
  total_qty:        number;
  total_revenue:    number;
  wes_percent_fixed: number;
  matrix_category:  string;
}

// Columns that actually exist in the product_sales table.
// Any field NOT listed here is stripped before the insert to prevent
// "column X does not exist" errors from PostgREST.
const PRODUCT_SALES_COLUMNS = [
  'product_name',
  'quantity',
  'revenue',
  'sale_date',
  'source',
  'import_batch',
] as const;

type ProductSalesColumn = typeof PRODUCT_SALES_COLUMNS[number];

export interface ProductSaleInsert {
  product_name:  string;
  quantity:      number;
  revenue:       number;
  sale_date:     string;       // YYYY-MM-DD
  source?:       string;
  import_batch?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/** KPI-Zusammenfassung aus management_dashboard View */
export async function fetchManagementDashboard(): Promise<ManagementDashboard | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('management_dashboard')
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data as ManagementDashboard | null;
  } catch (err) {
    console.error('[sales-db] fetchManagementDashboard:', err);
    return null;
  }
}

/** Umsatz/WES pro Kategorie aus dashboard_category_kpis */
export async function fetchCategoryKpis(): Promise<CategoryKpi[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('dashboard_category_kpis')
      .select('*')
      .order('total_revenue', { ascending: false });
    if (error) throw error;
    return (data ?? []) as CategoryKpi[];
  } catch (err) {
    console.error('[sales-db] fetchCategoryKpis:', err);
    return [];
  }
}

/** Top-Produkte aus dashboard_top_products */
export async function fetchTopProducts(limit = 10): Promise<TopProduct[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('dashboard_top_products')
      .select('*')
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as TopProduct[];
  } catch (err) {
    console.error('[sales-db] fetchTopProducts:', err);
    return [];
  }
}

/** Problemprodukte aus dashboard_problem_products */
export async function fetchProblemProducts(): Promise<ProblemProduct[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('dashboard_problem_products')
      .select('*');
    if (error) throw error;
    return (data ?? []) as ProblemProduct[];
  } catch (err) {
    console.error('[sales-db] fetchProblemProducts:', err);
    return [];
  }
}

/** Parst Datum+Zeit aus der Batch-ID, z.B. "food-20260326-2226" → "2026-03-26T22:26:00"
 *  Wird als Sortierschlüssel und Anzeige-Timestamp verwendet.
 */
function parseBatchTimestamp(batchId: string): string {
  const m = batchId.match(/(\d{8})-(\d{4})$/);
  if (!m) return '';
  const d = m[1]; // "20260326"
  const t = m[2]; // "2226"
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:00`;
}

/** Import-Historie – aggregiert direkt aus product_sales.
 *  Kein separates sales_import_batches-View nötig.
 */
export async function fetchImportBatches(): Promise<ImportBatch[]> {
  try {
    // Nur die Felder holen, die wir für die Aggregation brauchen.
    const { data, error } = await (supabase as any)
      .from('product_sales')
      .select('import_batch, source, sale_date, quantity, revenue');

    if (error) {
      console.error('[sales-db] fetchImportBatches (product_sales):', error);
      return [];
    }

    // In-JS groupBy import_batch
    const map = new Map<string, ImportBatch>();
    for (const row of data ?? []) {
      const key: string = row.import_batch ?? '(unbekannt)';
      if (!map.has(key)) {
        map.set(key, {
          import_batch:  key,
          source:        row.source ?? '',
          sales_date:    row.sale_date ?? '',
          rows_imported: 0,
          total_qty:     0,
          total_revenue: 0,
          imported_at:   parseBatchTimestamp(key),
        });
      }
      const b = map.get(key)!;
      b.rows_imported += 1;
      b.total_qty     += Number(row.quantity ?? 0);
      b.total_revenue += Number(row.revenue  ?? 0);
      // Frühestes Datum im Batch
      if (row.sale_date && row.sale_date < b.sales_date) {
        b.sales_date = row.sale_date;
      }
    }

    // Neueste zuerst (nach import_batch-Timestamp sortiert)
    return Array.from(map.values()).sort((a, b) =>
      b.imported_at.localeCompare(a.imported_at),
    );
  } catch (err) {
    console.error('[sales-db] fetchImportBatches exception:', err);
    return [];
  }
}

/** Produkt-Matrix aus product_matrix */
export async function fetchProductMatrix(): Promise<ProductMatrixRow[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('product_matrix')
      .select('*')
      .order('total_revenue', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ProductMatrixRow[];
  } catch (err) {
    console.error('[sales-db] fetchProductMatrix:', err);
    return [];
  }
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Formatiert ein Supabase PostgREST-Fehlerobjekt als lesbaren String für die UI. */
function formatSupabaseError(err: unknown): string {
  const e = err as { message?: string; details?: string; hint?: string; code?: string } | null;
  const parts: string[] = [];
  if (e?.code)    parts.push(`code: ${e.code}`);
  if (e?.message) parts.push(`message: ${e.message}`);
  if (e?.details) parts.push(`details: ${e.details}`);
  if (e?.hint)    parts.push(`hint: ${e.hint}`);
  return parts.length > 0 ? parts.join('\n') : JSON.stringify(err);
}

/** Baut einen Insert-Row mit EXAKT den erlaubten Feldern – kein generischer Loop.
 *  Verhindert, dass unbekannte Felder (z.B. category, file_name, notes) mitgesendet werden. */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  // Explizit nur die Felder, die in product_sales existieren.
  // KEIN category, KEIN file_name, KEIN notes.
  const out: Record<string, unknown> = {
    product_name:  row.product_name,
    quantity:      row.quantity,
    revenue:       row.revenue,
    sale_date:     row.sale_date,
  };
  if (row.source      !== undefined) out.source      = row.source;
  if (row.import_batch !== undefined) out.import_batch = row.import_batch;
  return out;
}

/** Validiert Typen und gibt Warnungen aus. Gibt null zurück wenn ok, sonst Fehlermeldung. */
function validateRow(row: Record<string, unknown>, idx: number): string | null {
  const errors: string[] = [];
  if (typeof row.product_name !== 'string' || !row.product_name)
    errors.push(`row[${idx}].product_name ist kein non-empty string (${JSON.stringify(row.product_name)})`);
  if (typeof row.quantity !== 'number' || isNaN(row.quantity as number))
    errors.push(`row[${idx}].quantity ist keine Zahl (${JSON.stringify(row.quantity)})`);
  if (typeof row.revenue !== 'number' || isNaN(row.revenue as number))
    errors.push(`row[${idx}].revenue ist keine Zahl (${JSON.stringify(row.revenue)})`);
  if (typeof row.sale_date !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(row.sale_date as string))
    errors.push(`row[${idx}].sale_date ist kein YYYY-MM-DD Datum (${JSON.stringify(row.sale_date)})`);
  if (row.source !== undefined && row.source !== null && typeof row.source !== 'string')
    errors.push(`row[${idx}].source ist kein string (${JSON.stringify(row.source)})`);
  if (row.import_batch !== undefined && row.import_batch !== null && typeof row.import_batch !== 'string')
    errors.push(`row[${idx}].import_batch ist kein string (${JSON.stringify(row.import_batch)})`);
  return errors.length > 0 ? errors.join('; ') : null;
}

// ─── Insert ───────────────────────────────────────────────────────────────────

/** Verkaufsdaten in product_sales einfügen */
export async function insertProductSales(
  rows: ProductSaleInsert[],
): Promise<{ count: number; error: string | null }> {
  // Cast to generic map so we can inspect/strip fields at runtime regardless of
  // what the TypeScript type says (callers may pass a superset interface).
  const rawRows = rows as Array<Record<string, unknown>>;

  // ── 0. Auth diagnostics ───────────────────────────────────────────────────
  // Run BEFORE the insert to see if the client is authenticated or anon.
  const { data: { session: diagSession } } = await supabase.auth.getSession();
  const diagUserId   = diagSession?.user?.id ?? null;
  const diagRole     = diagSession?.user?.role ?? diagSession?.user?.app_metadata?.role ?? 'unknown';
  const diagHasToken = !!diagSession?.access_token;
  const diagExpiry   = diagSession?.expires_at
    ? new Date(diagSession.expires_at * 1000).toISOString() : 'none';
  const supabaseUrl  = (supabase as any).supabaseUrl ?? (supabase as any).rest?.url ?? '(unknown)';

  // Visible in browser console with eye-catching prefix
  console.error('🔴 [UPLOAD AUTH]', {
    hasSession:   diagHasToken,
    userId:       diagUserId,
    role:         diagRole,
    tokenExpiry:  diagExpiry,
    supabaseUrl,
    table:        'product_sales',
    verdict:      diagHasToken ? '✅ authenticated' : '❌ ANON – RLS will block insert',
  });

  if (!diagHasToken) {
    const msg = 'Kein aktiver Login – Upload läuft als anonymer Benutzer. Bitte neu einloggen.';
    console.error('[sales-db]', msg);
    return { count: 0, error: msg };
  }

  // ── 1. Pre-insert diagnostics ─────────────────────────────────────────────
  console.log('[sales-db] insertProductSales ─── START ───────────────────────');
  console.log('[sales-db] row count:', rawRows.length);
  if (rawRows.length > 0) {
    console.log('[sales-db] first row (raw):', JSON.stringify(rawRows[0], null, 2));
    console.log('[sales-db] fields on first row:', Object.keys(rawRows[0]));

    // Check structural consistency across all rows
    const firstKeys = JSON.stringify(Object.keys(rawRows[0]).sort());
    const inconsistent = rawRows.findIndex(r => JSON.stringify(Object.keys(r).sort()) !== firstKeys);
    if (inconsistent >= 0) {
      console.warn('[sales-db] WARNUNG: Zeile', inconsistent, 'hat andere Felder als Zeile 0');
      console.warn('[sales-db] Zeile 0 Felder:', Object.keys(rawRows[0]));
      console.warn('[sales-db] Zeile', inconsistent, 'Felder:', Object.keys(rawRows[inconsistent]));
    } else {
      console.log('[sales-db] alle Zeilen haben dieselbe Struktur ✓');
    }

    // Identify fields that are unknown to the DB and will be stripped
    const extra = Object.keys(rawRows[0]).filter(k => !(PRODUCT_SALES_COLUMNS as readonly string[]).includes(k));
    if (extra.length > 0) {
      console.warn('[sales-db] folgende Felder existieren NICHT in product_sales und werden entfernt:', extra);
    }
  }

  // ── 2. Sanitize: strip unknown columns ────────────────────────────────────
  const sanitized = rawRows.map(r => sanitizeRow(r));

  console.log('[sales-db] first row (nach Sanitizing, kein category/file_name/notes):', JSON.stringify(sanitized[0], null, 2));
  console.log('[sales-db] Felder die tatsächlich gesendet werden (fix list):', ['product_name','quantity','revenue','sale_date','source','import_batch']);
  // Double-check: make sure category is NOT in the sanitized row
  if (sanitized.length > 0 && 'category' in sanitized[0]) {
    console.error('[sales-db] BUG: category ist immer noch im sanitizierten Row!', sanitized[0]);
  }

  // ── 3. Type validation ────────────────────────────────────────────────────
  const typeErrors: string[] = [];
  for (let i = 0; i < Math.min(sanitized.length, 5); i++) {
    const err = validateRow(sanitized[i] as Record<string, unknown>, i);
    if (err) typeErrors.push(err);
  }
  if (typeErrors.length > 0) {
    const msg = 'Typfehler in Insert-Payload:\n' + typeErrors.join('\n');
    console.error('[sales-db] TYPFEHLER:', msg);
    return { count: 0, error: msg };
  }

  // ── 4. Insert ─────────────────────────────────────────────────────────────
  try {
    const { data, error } = await (supabase as any)
      .from('product_sales')
      .insert(sanitized)
      .select('id');

    if (error) {
      console.error('[sales-db] insertProductSales Supabase Fehler:', {
        message: error.message,
        details: error.details,
        hint:    error.hint,
        code:    error.code,
        raw:     error,
      });
      return { count: 0, error: formatSupabaseError(error) };
    }

    console.log('[sales-db] insertProductSales ─── OK: inserted', (data ?? []).length, 'rows');
    return { count: (data ?? []).length, error: null };

  } catch (err: unknown) {
    console.error('[sales-db] insertProductSales JS-Exception:', {
      message: (err as any)?.message,
      details: (err as any)?.details,
      hint:    (err as any)?.hint,
      code:    (err as any)?.code,
      raw:     err,
    });
    return { count: 0, error: formatSupabaseError(err) };
  }
}
