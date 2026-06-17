/**
 * Gastronovi DB-Diagnostik
 * Prüft alle benötigten Tabellen und Spalten mit aussagekräftigen Fehlermeldungen.
 */

import { supabase } from '@/integrations/supabase/client';

export interface GnCheckResult {
  table: string;
  column?: string;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  hint: string | null;
  migration: string | null;
}

export interface GnDiagnosticResult {
  allOk: boolean;
  checks: GnCheckResult[];
  schemaHint: boolean;
}

// ── Hilfsfunktion ─────────────────────────────────────────────────────────────

async function checkTable(
  table: string,
  migration: string,
  column = 'id',
): Promise<GnCheckResult> {
  try {
    const { error } = await (supabase as any)
      .from(table)
      .select(column)
      .limit(1);

    if (!error) {
      return { table, column, ok: true, errorCode: null, errorMessage: null, hint: null, migration };
    }

    const code = error.code ?? '';
    const msg  = error.message ?? String(error);

    console.error(`[GN-DIAG] ${table}.${column}: [${code}] ${msg}`);

    let hint: string | null = null;
    if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist') || msg.includes('schema cache')) {
      hint = `Fehlende Tabelle: ${table} → Migration ausführen: ${migration}`;
    } else if (code === '42703' || (msg.includes('column') && msg.includes('does not exist'))) {
      hint = `Spalte "${column}" fehlt in "${table}" → Migration ausführen: ${migration}`;
    } else if (code === '42501' || msg.includes('permission denied')) {
      hint = `Keine SELECT-Berechtigung auf "${table}" → GRANT-Migration ausführen`;
    } else if (code === 'PGRST200') {
      hint = `Supabase Schema Cache veraltet → Seite neu laden oder Cache aktualisieren`;
    }

    return { table, column, ok: false, errorCode: code, errorMessage: msg, hint, migration };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[GN-DIAG] ${table}: Exception: ${msg}`);
    return {
      table, column, ok: false,
      errorCode: 'EXCEPTION', errorMessage: msg,
      hint: 'Netzwerkfehler oder Supabase-URL falsch konfiguriert', migration,
    };
  }
}

// ── Haupt-Diagnostik ──────────────────────────────────────────────────────────

export async function runGnDiagnostic(): Promise<GnDiagnosticResult> {
  const results = await Promise.all([
    // ── Migration 1: gn_zbericht.sql ────────────────────────────────────────
    checkTable('gn_imports',           '20260617_gn_zbericht.sql'),
    checkTable('gn_revenue_summary',   '20260617_gn_zbericht.sql'),
    checkTable('gn_tax_summary',       '20260617_gn_zbericht.sql'),
    checkTable('gn_cost_centers',      '20260617_gn_zbericht.sql'),
    checkTable('gn_waiters',           '20260617_gn_zbericht.sql'),
    checkTable('gn_payment_methods',   '20260617_gn_zbericht.sql'),
    checkTable('gn_product_groups',    '20260617_gn_zbericht.sql'),
    checkTable('gn_discounts',         '20260617_gn_zbericht.sql'),
    checkTable('gn_cancellations',     '20260617_gn_zbericht.sql'),
    checkTable('gn_accounting_lines',  '20260617_gn_zbericht.sql'),
    checkTable('gn_payment_accounts',  '20260617_gn_zbericht.sql'),

    // ── Migration 2: gn_personen.sql ────────────────────────────────────────
    checkTable('gn_person_imports',    '20260617_gn_personen.sql'),
    checkTable('gn_person_metrics',    '20260617_gn_personen.sql'),

    // ── Migration 3: gn_analysis.sql — neue Spalten ─────────────────────────
    checkTable('gn_person_imports',    '20260617_gn_analysis.sql',  'csv_type'),
    checkTable('gn_person_metrics',    '20260617_gn_analysis.sql',  'average_receipt'),
    checkTable('gn_person_metrics',    '20260617_gn_analysis.sql',  'metric_type'),

    // ── Migration 4: gn_analysis_create_missing_tables.sql ──────────────────
    checkTable('gn_analysis_imports',  '20260617_gn_analysis_create_missing_tables.sql'),
    checkTable('gn_analysis_metrics',  '20260617_gn_analysis_create_missing_tables.sql'),
  ]);

  const failures = results.filter(r => !r.ok);
  const allOk    = failures.length === 0;
  const schemaHint = failures.some(f =>
    (f.errorCode === 'PGRST200') ||
    (f.errorMessage?.includes('schema') ?? false),
  );

  if (allOk) {
    console.log('[GN-DIAG] Alle Tabellen und Spalten vorhanden ✓');
  } else {
    console.warn('[GN-DIAG] Fehlende Tabellen/Spalten:', failures.map(f =>
      `${f.table}.${f.column ?? 'id'} (${f.errorCode}: ${f.errorMessage})`
    ));
  }

  return { allOk, checks: results, schemaHint };
}
