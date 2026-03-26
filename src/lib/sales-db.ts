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
  import_batch:    string;
  source:          string;
  file_name:       string;
  sales_date:      string;
  rows_imported:   number;
  total_qty:       number;
  total_revenue:   number;
  first_imported_at: string;
  last_imported_at:  string;
}

export interface ProductMatrixRow {
  name:             string;
  category:         string;
  total_qty:        number;
  total_revenue:    number;
  wes_percent_fixed: number;
  matrix_category:  string;
}

export interface ProductSaleInsert {
  product_name: string;
  quantity:     number;
  revenue:      number;
  sale_date:    string;
  source?:      string;
  import_batch?: string;
  file_name?:   string;
  notes?:       string;
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

/** Import-Historie aus sales_import_batches */
export async function fetchImportBatches(): Promise<ImportBatch[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('sales_import_batches')
      .select('*')
      .order('last_imported_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ImportBatch[];
  } catch (err) {
    console.error('[sales-db] fetchImportBatches:', err);
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

/** Verkaufsdaten in product_sales einfügen */
export async function insertProductSales(rows: ProductSaleInsert[]): Promise<{ count: number; error: string | null }> {
  try {
    const { data, error } = await (supabase as any)
      .from('product_sales')
      .insert(rows)
      .select('id');
    if (error) throw error;
    return { count: (data ?? []).length, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sales-db] insertProductSales:', err);
    return { count: 0, error: msg };
  }
}
