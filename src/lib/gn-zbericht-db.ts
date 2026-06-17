/**
 * Gastronovi Z-Bericht — Supabase DB Layer
 *
 * Alle Schreiboperationen für den Z-Bericht Import.
 * Tabellen werden durch die Migration 20260617_gn_zbericht.sql angelegt.
 */

import { supabase } from '@/integrations/supabase/client';
import type { GnParsedZBericht } from './gn-zbericht-parser';

// ── TypeScript-Typen für DB-Tabellen ─────────────────────────────────────────

export interface GnImportRow {
  id: string;
  restaurant_id: string;
  file_name: string;
  pdf_file_name: string | null;
  z_counter: string | null;
  cost_center: string | null;
  period_from: string | null;
  period_to: string | null;
  status: string;
  raw_csv_json: unknown;
  checksum: string | null;
  imported_at: string;
  created_at: string;
}

export interface GnImportWithSummary extends GnImportRow {
  revenue: {
    total_gross: number;
    total_excl_tip: number;
    net_total: number;
  } | null;
}

// ── Duplikat-Prüfung ─────────────────────────────────────────────────────────

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingId: string | null;
  existingImportedAt: string | null;
}

export async function checkDuplicate(
  restaurantId: string,
  checksum: string,
  zCounter: string,
  periodFrom: string,
  periodTo: string,
): Promise<DuplicateCheckResult> {
  try {
    // Prüfe zuerst per Checksum (schnellster Weg)
    if (checksum) {
      const { data: byHash } = await (supabase as any)
        .from('gn_imports')
        .select('id, imported_at')
        .eq('restaurant_id', restaurantId)
        .eq('checksum', checksum)
        .eq('status', 'active')
        .single();
      if (byHash) {
        return { isDuplicate: true, existingId: byHash.id, existingImportedAt: byHash.imported_at };
      }
    }

    // Prüfe per Z-Zähler + Zeitraum
    if (zCounter && periodFrom && periodTo) {
      const { data: byKey } = await (supabase as any)
        .from('gn_imports')
        .select('id, imported_at')
        .eq('restaurant_id', restaurantId)
        .eq('z_counter', zCounter)
        .eq('period_from', periodFrom)
        .eq('period_to', periodTo)
        .eq('status', 'active')
        .single();
      if (byKey) {
        return { isDuplicate: true, existingId: byKey.id, existingImportedAt: byKey.imported_at };
      }
    }

    return { isDuplicate: false, existingId: null, existingImportedAt: null };
  } catch {
    return { isDuplicate: false, existingId: null, existingImportedAt: null };
  }
}

// ── Import speichern ─────────────────────────────────────────────────────────

export async function saveGnImport(
  restaurantId: string,
  parsed: GnParsedZBericht,
  pdfFileName?: string,
  replaceId?: string,
): Promise<{ importId: string; error: string | null }> {
  try {
    // Falls wir einen bestehenden ersetzen: erst löschen
    if (replaceId) {
      await deleteGnImport(replaceId);
    }

    // gn_imports Haupteintrag
    const { data: imp, error: impErr } = await (supabase as any)
      .from('gn_imports')
      .insert({
        restaurant_id: restaurantId,
        file_name: parsed.fileName,
        pdf_file_name: pdfFileName ?? null,
        z_counter: parsed.zCounter || null,
        cost_center: parsed.costCenter || null,
        period_from: parsed.periodFrom || null,
        period_to: parsed.periodTo || null,
        status: 'active',
        raw_csv_json: parsed as unknown,
        checksum: parsed.checksum || null,
      })
      .select('id')
      .single();

    if (impErr || !imp) {
      return { importId: '', error: impErr?.message ?? 'Import fehlgeschlagen' };
    }

    const importId: string = imp.id;

    // Alle abhängigen Tabellen befüllen
    await Promise.all([
      // gn_revenue_summary
      (supabase as any).from('gn_revenue_summary').insert({
        import_id: importId,
        total_gross: parsed.revenue.totalGross,
        total_excl_tip: parsed.revenue.totalExclTip,
        total_excl_rounding: parsed.revenue.totalExclRounding,
        total_excl_customer_card_topups: parsed.revenue.totalExclCardTopups,
      }),

      // gn_tax_summary
      parsed.taxes.length > 0
        ? (supabase as any).from('gn_tax_summary').insert(
            parsed.taxes.map(t => ({
              import_id: importId,
              tax_rate: t.taxRate,
              net_amount: t.netAmount,
              tax_amount: t.taxAmount,
              gross_amount: t.grossAmount,
            })),
          )
        : Promise.resolve(),

      // gn_cost_centers
      parsed.costCenters.length > 0
        ? (supabase as any).from('gn_cost_centers').insert(
            parsed.costCenters.map(c => ({ import_id: importId, name: c.name, count: c.count, amount: c.amount })),
          )
        : Promise.resolve(),

      // gn_waiters
      parsed.waiters.length > 0
        ? (supabase as any).from('gn_waiters').insert(
            parsed.waiters.map(w => ({ import_id: importId, name: w.name, count: w.count, amount: w.amount })),
          )
        : Promise.resolve(),

      // gn_payment_methods
      parsed.paymentMethods.length > 0
        ? (supabase as any).from('gn_payment_methods').insert(
            parsed.paymentMethods.map(p => ({ import_id: importId, name: p.name, count: p.count, amount: p.amount })),
          )
        : Promise.resolve(),

      // gn_product_groups
      parsed.productGroups.length > 0
        ? (supabase as any).from('gn_product_groups').insert(
            parsed.productGroups.map(p => ({
              import_id: importId, name: p.name, count: p.count,
              original_amount: p.originalAmount, amount: p.amount,
            })),
          )
        : Promise.resolve(),

      // gn_discounts
      parsed.discounts.length > 0
        ? (supabase as any).from('gn_discounts').insert(
            parsed.discounts.map(d => ({
              import_id: importId, type: d.type, name: d.name, count: d.count, amount: d.amount,
            })),
          )
        : Promise.resolve(),

      // gn_cancellations
      parsed.cancellations.length > 0
        ? (supabase as any).from('gn_cancellations').insert(
            parsed.cancellations.map(c => ({ import_id: importId, name: c.name, count: c.count, amount: c.amount })),
          )
        : Promise.resolve(),

      // gn_accounting_lines
      parsed.accountingLines.length > 0
        ? (supabase as any).from('gn_accounting_lines').insert(
            parsed.accountingLines.map(a => ({
              import_id: importId, name: a.name, account: a.account, tax_rate: a.taxRate, gross_amount: a.grossAmount,
            })),
          )
        : Promise.resolve(),

      // gn_payment_accounts
      parsed.paymentAccounts.length > 0
        ? (supabase as any).from('gn_payment_accounts').insert(
            parsed.paymentAccounts.map(p => ({ import_id: importId, name: p.name, account: p.account, gross_amount: p.grossAmount })),
          )
        : Promise.resolve(),
    ]);

    return { importId, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { importId: '', error: msg };
  }
}

// ── Import laden (Liste) ─────────────────────────────────────────────────────

export async function loadGnImports(restaurantId: string): Promise<GnImportRow[]> {
  const { data, error } = await (supabase as any)
    .from('gn_imports')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .order('period_from', { ascending: false });

  if (error || !data) return [];
  return data as GnImportRow[];
}

// ── Einzelimport mit Details laden ───────────────────────────────────────────

export async function loadGnImportDetail(importId: string): Promise<GnParsedZBericht | null> {
  const { data } = await (supabase as any)
    .from('gn_imports')
    .select('raw_csv_json')
    .eq('id', importId)
    .single();

  if (!data?.raw_csv_json) return null;
  return data.raw_csv_json as GnParsedZBericht;
}

// ── Import löschen ───────────────────────────────────────────────────────────

export async function deleteGnImport(importId: string): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('gn_imports')
    .update({ status: 'deleted' })
    .eq('id', importId);
  return { error: error?.message ?? null };
}

// ── Tabellen-Setup prüfen ────────────────────────────────────────────────────

export async function checkGnTablesExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any)
      .from('gn_imports')
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}
