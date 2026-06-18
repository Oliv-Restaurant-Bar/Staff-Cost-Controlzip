/**
 * Gastronovi Durchschnittsbon-Bericht — Supabase DB Layer
 *
 * Tabelle: gn_average_checks (eine Zeile pro Tag).
 * Ein Import wird über eine gemeinsame import_id gruppiert; der Importverlauf
 * aggregiert pro import_id (Zeitraum, Anzahl Tage, Mittelwert, Min, Max).
 *
 * Re-Import-Semantik: Tageswerte werden pro (business_id, report_date)
 * ATOMAR per UPSERT ersetzt (ON CONFLICT auf dem Unique-Constraint
 * uq_gn_average_checks_business_date).  Kein delete+insert → kein
 * Datenverlust-Fenster und keine Doppelzeilen bei Parallel-Import
 * (vgl. Datenintegritäts-Vorgabe in replit.md).
 */

import { supabase } from '@/integrations/supabase/client';
import type { GnParsedAverageCheck } from './gn-average-check-parser';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnAverageCheckRecord {
  id: string;
  import_id: string;
  business_id: string;
  report_date: string;
  average_check_chf: number | null;
  currency: string | null;
  source_file_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Aggregierter Import (eine Zeile im Importverlauf). */
export interface GnAverageCheckImportGroup {
  importId: string;
  fileName: string;
  periodFrom: string | null;
  periodTo: string | null;
  dayCount: number;
  mean: number;
  min: number;
  max: number;
  currency: string;
  importedAt: string;
}

function newImportId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (sollte im Browser nie nötig sein).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Überschneidungsprüfung (Tage, die ersetzt werden) ────────────────────────

export async function getOverlappingAverageCheckDates(
  businessId: string,
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  try {
    const { data, error } = await (supabase as any)
      .from('gn_average_checks')
      .select('report_date')
      .eq('business_id', businessId)
      .gte('report_date', fromIso)
      .lte('report_date', toIso);
    if (error || !data) return [];
    return (data as { report_date: string }[]).map(r => r.report_date);
  } catch {
    return [];
  }
}

// ── Import speichern ─────────────────────────────────────────────────────────

export async function saveAverageCheckImport(
  businessId: string,
  parsed: GnParsedAverageCheck,
): Promise<{ importId: string; error: string | null }> {
  try {
    if (parsed.rows.length === 0) {
      return { importId: '', error: 'Keine Tageswerte zum Speichern.' };
    }

    const importId = newImportId();

    // Atomarer UPSERT pro (business_id, report_date): bestehende Tage werden
    // aktualisiert, neue eingefügt — in EINER Anweisung, ohne Datenverlust-
    // Fenster.  Erfordert den Unique-Constraint uq_gn_average_checks_business_date.
    const { error: upErr } = await (supabase as any)
      .from('gn_average_checks')
      .upsert(
        parsed.rows.map(r => ({
          import_id: importId,
          business_id: businessId,
          report_date: r.date,
          average_check_chf: r.averageCheck,
          currency: r.currency || parsed.currency || 'CHF',
          source_file_name: parsed.fileName,
        })),
        { onConflict: 'business_id,report_date' },
      );
    if (upErr) return { importId: '', error: upErr.message };

    return { importId, error: null };
  } catch (e: unknown) {
    return { importId: '', error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Importverlauf laden (gruppiert pro import_id) ─────────────────────────────

export async function loadAverageCheckImports(
  businessId: string,
): Promise<GnAverageCheckImportGroup[]> {
  const { data, error } = await (supabase as any)
    .from('gn_average_checks')
    .select('import_id, report_date, average_check_chf, currency, source_file_name, created_at')
    .eq('business_id', businessId)
    .order('report_date', { ascending: true });

  if (error || !data) return [];

  const rows = data as Array<{
    import_id: string;
    report_date: string;
    average_check_chf: number | null;
    currency: string | null;
    source_file_name: string | null;
    created_at: string;
  }>;

  const byImport = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byImport.get(r.import_id);
    if (list) list.push(r);
    else byImport.set(r.import_id, [r]);
  }

  const groups: GnAverageCheckImportGroup[] = [];
  for (const [importId, list] of byImport) {
    const dates = list.map(r => r.report_date).sort((a, b) => a.localeCompare(b));
    const values = list.map(r => r.average_check_chf ?? 0).filter(v => v > 0);
    const sum = values.reduce((s, v) => s + v, 0);
    const createdAts = list.map(r => r.created_at).filter(Boolean).sort();
    groups.push({
      importId,
      fileName: list.find(r => r.source_file_name)?.source_file_name ?? 'Durchschnittsbon',
      periodFrom: dates[0] ?? null,
      periodTo: dates[dates.length - 1] ?? null,
      dayCount: list.length,
      mean: values.length > 0 ? sum / values.length : 0,
      min: values.length > 0 ? Math.min(...values) : 0,
      max: values.length > 0 ? Math.max(...values) : 0,
      currency: list.find(r => r.currency)?.currency ?? 'CHF',
      importedAt: createdAts[0] ?? '',
    });
  }

  groups.sort((a, b) => (b.periodFrom ?? '').localeCompare(a.periodFrom ?? ''));
  return groups;
}

// ── Import löschen ───────────────────────────────────────────────────────────

export async function deleteAverageCheckImport(importId: string): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('gn_average_checks')
    .delete()
    .eq('import_id', importId);
  return { error: error?.message ?? null };
}

// ── Durchschnittsbon für Zeitraum (für Reporting-Mapping) ─────────────────────

export interface AverageCheckPeriodResult {
  mean: number;
  dayCount: number;
}

export async function getAverageCheckForPeriod(
  businessId: string,
  fromIso: string,
  toIso: string,
): Promise<AverageCheckPeriodResult> {
  try {
    const { data, error } = await (supabase as any)
      .from('gn_average_checks')
      .select('average_check_chf')
      .eq('business_id', businessId)
      .gte('report_date', fromIso)
      .lte('report_date', toIso)
      .not('average_check_chf', 'is', null);
    if (error || !data) return { mean: 0, dayCount: 0 };
    const values = (data as { average_check_chf: number }[])
      .map(r => r.average_check_chf)
      .filter(v => v > 0);
    if (values.length === 0) return { mean: 0, dayCount: 0 };
    return { mean: values.reduce((s, v) => s + v, 0) / values.length, dayCount: values.length };
  } catch {
    return { mean: 0, dayCount: 0 };
  }
}

// ── Tabellen-Setup prüfen ────────────────────────────────────────────────────

export async function checkAverageCheckTableExists(): Promise<boolean> {
  try {
    const { error } = await (supabase as any)
      .from('gn_average_checks')
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}
