/**
 * Gastronovi Personen-Import — Supabase DB Layer
 * Unterstützt: anzahl_personen | umsatz_pro_person | durchschnittsbon | personen
 */

import { supabase } from '@/integrations/supabase/client';
import type { GnParsedPersonReport, PersonCsvType } from './gn-personen-parser';

// ── Typen ─────────────────────────────────────────────────────────────────────

export interface GnPersonImportRow {
  id: string;
  restaurant_id: string;
  file_name: string;
  period_from: string | null;
  period_to: string | null;
  import_type: string;
  csv_type: string | null;
  checksum: string | null;
  status: string;
  raw_csv_json: unknown;
  imported_at: string;
  created_at: string;
}

export interface GuestPeriodResult {
  totalGuests: number;
  avgRevPerGuest: number;
  rowCount: number;
}

export interface AvgReceiptResult {
  avgReceipt: number;
  rowCount: number;
}

// ── Duplikat-Prüfung ─────────────────────────────────────────────────────────

export async function checkPersonDuplicate(
  restaurantId: string,
  checksum: string,
  periodFrom: string,
  periodTo: string,
): Promise<{ isDuplicate: boolean; existingId: string | null; existingImportedAt: string | null }> {
  try {
    if (checksum) {
      const { data } = await (supabase as any)
        .from('gn_person_imports')
        .select('id, imported_at')
        .eq('restaurant_id', restaurantId)
        .eq('checksum', checksum)
        .eq('status', 'active')
        .single();
      if (data) return { isDuplicate: true, existingId: data.id, existingImportedAt: data.imported_at };
    }
    if (periodFrom && periodTo) {
      const { data } = await (supabase as any)
        .from('gn_person_imports')
        .select('id, imported_at')
        .eq('restaurant_id', restaurantId)
        .eq('period_from', periodFrom)
        .eq('period_to', periodTo)
        .eq('status', 'active')
        .single();
      if (data) return { isDuplicate: true, existingId: data.id, existingImportedAt: data.imported_at };
    }
    return { isDuplicate: false, existingId: null, existingImportedAt: null };
  } catch {
    return { isDuplicate: false, existingId: null, existingImportedAt: null };
  }
}

// ── Import speichern ─────────────────────────────────────────────────────────

export async function savePersonImport(
  restaurantId: string,
  parsed: GnParsedPersonReport,
  replaceId?: string,
  /** Manuell gewählter Typ überschreibt Auto-Erkennung */
  csvTypeOverride?: PersonCsvType,
): Promise<{ importId: string; error: string | null }> {
  try {
    if (replaceId) await deletePersonImport(replaceId);

    const csvType = csvTypeOverride ?? parsed.detectedCsvType ?? 'personen';

    const { data: imp, error: impErr } = await (supabase as any)
      .from('gn_person_imports')
      .insert({
        restaurant_id: restaurantId,
        file_name: parsed.fileName,
        period_from: parsed.periodFrom || null,
        period_to: parsed.periodTo || null,
        import_type: 'personen',
        csv_type: csvType,
        checksum: parsed.checksum || null,
        status: 'active',
        raw_csv_json: parsed as unknown,
      })
      .select('id')
      .single();

    if (impErr || !imp) {
      return { importId: '', error: impErr?.message ?? 'Import fehlgeschlagen' };
    }

    const importId: string = imp.id;

    if (parsed.rows.length > 0) {
      await (supabase as any).from('gn_person_metrics').insert(
        parsed.rows.map(r => ({
          import_id:       importId,
          date:            r.date || null,
          period_label:    r.periodLabel || null,
          guests_count:    r.guestsCount,
          revenue_per_person: r.revPerPerson || null,
          revenue_total:   r.revTotal || null,
          average_receipt: r.averageReceipt || null,
          metric_type:     csvType,
          source_row_json: r.sourceRowJson,
        })),
      );
    }

    return { importId, error: null };
  } catch (e: unknown) {
    return { importId: '', error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Import laden ─────────────────────────────────────────────────────────────

export async function loadPersonImports(restaurantId: string): Promise<GnPersonImportRow[]> {
  const { data, error } = await (supabase as any)
    .from('gn_person_imports')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .order('period_from', { ascending: false });
  if (error || !data) return [];
  return data as GnPersonImportRow[];
}

// ── Import löschen ───────────────────────────────────────────────────────────

export async function deletePersonImport(importId: string): Promise<{ error: string | null }> {
  const { error } = await (supabase as any)
    .from('gn_person_imports')
    .update({ status: 'deleted' })
    .eq('id', importId);
  return { error: error?.message ?? null };
}

// ── Gäste für Zeitraum ────────────────────────────────────────────────────────

export async function getGuestsForPeriod(
  restaurantId: string,
  fromIso: string,
  toIso: string,
): Promise<GuestPeriodResult> {
  try {
    const { data: imports } = await (supabase as any)
      .from('gn_person_imports')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .in('csv_type', ['anzahl_personen', 'personen'])
      .lte('period_from', toIso)
      .gte('period_to', fromIso);

    if (!imports?.length) {
      return _fallbackGuestFromRaw(restaurantId, fromIso, toIso, ['anzahl_personen', 'personen']);
    }

    const ids = (imports as { id: string }[]).map(i => i.id);
    const { data: metrics } = await (supabase as any)
      .from('gn_person_metrics')
      .select('guests_count, revenue_per_person, revenue_total, date')
      .in('import_id', ids)
      .gte('date', fromIso)
      .lte('date', toIso);

    if (!metrics?.length) return _fallbackGuestFromRaw(restaurantId, fromIso, toIso, ['anzahl_personen', 'personen']);

    type Row = { guests_count: number; revenue_per_person: number | null; revenue_total: number | null };
    const rows = metrics as Row[];
    const totalGuests = rows.reduce((s, r) => s + (r.guests_count ?? 0), 0);
    const totalRev    = rows.reduce((s, r) => s + (r.revenue_total ?? 0), 0);
    const avgRev      = totalGuests > 0 && totalRev > 0
      ? totalRev / totalGuests
      : rows.filter(r => (r.revenue_per_person ?? 0) > 0)
            .reduce((s, r) => s + (r.revenue_per_person ?? 0), 0) / Math.max(rows.length, 1);

    return { totalGuests, avgRevPerGuest: avgRev, rowCount: rows.length };
  } catch {
    return { totalGuests: 0, avgRevPerGuest: 0, rowCount: 0 };
  }
}

// ── Umsatz pro Person für Zeitraum ────────────────────────────────────────────

export async function getRevPerPersonForPeriod(
  restaurantId: string,
  fromIso: string,
  toIso: string,
): Promise<number> {
  try {
    const { data: imports } = await (supabase as any)
      .from('gn_person_imports')
      .select('id')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .in('csv_type', ['umsatz_pro_person', 'personen'])
      .lte('period_from', toIso)
      .gte('period_to', fromIso);

    if (!imports?.length) return 0;

    const ids = (imports as { id: string }[]).map(i => i.id);
    const { data: metrics } = await (supabase as any)
      .from('gn_person_metrics')
      .select('revenue_per_person, date')
      .in('import_id', ids)
      .gte('date', fromIso)
      .lte('date', toIso)
      .not('revenue_per_person', 'is', null);

    if (!metrics?.length) return 0;

    type Row = { revenue_per_person: number };
    const rows = metrics as Row[];
    const sum = rows.reduce((s, r) => s + (r.revenue_per_person ?? 0), 0);
    return rows.length > 0 ? sum / rows.length : 0;
  } catch {
    return 0;
  }
}

// ── Durchschnittsbon für Zeitraum ─────────────────────────────────────────────

export async function getAvgReceiptForPeriod(
  restaurantId: string,
  fromIso: string,
  toIso: string,
): Promise<AvgReceiptResult> {
  try {
    const { data: imports } = await (supabase as any)
      .from('gn_person_imports')
      .select('id, raw_csv_json')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .eq('csv_type', 'durchschnittsbon')
      .lte('period_from', toIso)
      .gte('period_to', fromIso);

    if (!imports?.length) return { avgReceipt: 0, rowCount: 0 };

    const ids = (imports as { id: string; raw_csv_json: unknown }[]).map(i => i.id);

    const { data: metrics } = await (supabase as any)
      .from('gn_person_metrics')
      .select('average_receipt, date')
      .in('import_id', ids)
      .gte('date', fromIso)
      .lte('date', toIso)
      .not('average_receipt', 'is', null);

    if (!metrics?.length) {
      // Fallback auf gespeicherten Monatsdurchschnitt aus raw_csv_json
      let bonSum = 0; let count = 0;
      for (const imp of imports as { raw_csv_json: { avgReceiptMonthly?: number } }[]) {
        if ((imp.raw_csv_json?.avgReceiptMonthly ?? 0) > 0) {
          bonSum += imp.raw_csv_json.avgReceiptMonthly!;
          count++;
        }
      }
      return count > 0 ? { avgReceipt: bonSum / count, rowCount: count } : { avgReceipt: 0, rowCount: 0 };
    }

    type Row = { average_receipt: number };
    const rows = metrics as Row[];
    const validRows = rows.filter(r => (r.average_receipt ?? 0) > 0);
    const avg = validRows.length > 0
      ? validRows.reduce((s, r) => s + r.average_receipt, 0) / validRows.length
      : 0;

    return { avgReceipt: avg, rowCount: validRows.length };
  } catch {
    return { avgReceipt: 0, rowCount: 0 };
  }
}

// ── Tabellen-Setup prüfen ────────────────────────────────────────────────────

export async function checkPersonTablesExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any)
      .from('gn_person_imports')
      .select('id')
      .limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ── Interner Fallback: aus raw_csv_json aggregieren ───────────────────────────

async function _fallbackGuestFromRaw(
  restaurantId: string,
  fromIso: string,
  toIso: string,
  csvTypes: string[],
): Promise<GuestPeriodResult> {
  try {
    const { data } = await (supabase as any)
      .from('gn_person_imports')
      .select('raw_csv_json')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .in('csv_type', csvTypes)
      .lte('period_from', toIso)
      .gte('period_to', fromIso);

    let totalGuests = 0; let totalRev = 0; let count = 0;
    for (const imp of (data ?? []) as { raw_csv_json: { totalGuests?: number; avgRevPerPerson?: number } }[]) {
      if (imp.raw_csv_json?.totalGuests) {
        totalGuests += imp.raw_csv_json.totalGuests;
        totalRev    += imp.raw_csv_json.totalGuests * (imp.raw_csv_json.avgRevPerPerson ?? 0);
        count++;
      }
    }
    const avg = totalGuests > 0 && count > 0 ? totalRev / totalGuests : 0;
    return { totalGuests, avgRevPerGuest: avg, rowCount: count };
  } catch {
    return { totalGuests: 0, avgRevPerGuest: 0, rowCount: 0 };
  }
}
