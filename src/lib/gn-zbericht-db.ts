/**
 * Gastronovi Z-Bericht — Supabase DB Layer
 *
 * Schreiboperationen, Überschneidungsprüfung und Reporting.
 * Tabellen: gn_imports (v1) + neue Spalten (v2) + gn_zbericht_daily (v2)
 */

import { supabase } from '@/integrations/supabase/client';
import type { GnParsedZBericht } from './gn-zbericht-parser';

// ── Typen ────────────────────────────────────────────────────────────────────

export interface GnImportRow {
  id: string;
  restaurant_id: string;
  file_name: string;
  pdf_file_name: string | null;
  z_counter: string | null;
  cost_center: string | null;
  period_from: string | null;
  period_to: string | null;
  import_type: string | null;          // 'daily' | 'weekly' | 'monthly' | 'period'
  aggregation_level: string | null;    // 'day' | 'period'
  gross_revenue: number | null;
  net_revenue: number | null;
  food_revenue: number | null;
  bev_revenue: number | null;
  take_away_revenue: number | null;
  discount_total: number | null;
  cancellation_total: number | null;
  receipts_count: number | null;
  avg_receipt: number | null;
  status: string;
  raw_csv_json: unknown;
  checksum: string | null;
  imported_at: string;
  created_at: string;
}

/** Überschneidender Import — kompakte Darstellung für die Vorschau */
export interface OverlapInfo {
  id: string;
  file_name: string;
  period_from: string | null;
  period_to: string | null;
  z_counter: string | null;
  gross_revenue: number | null;
  import_type: string | null;
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Importart aus Perioden-Länge ableiten */
export function detectImportType(
  from: string | null | undefined,
  to: string | null | undefined,
): 'daily' | 'weekly' | 'monthly' | 'period' {
  if (!from || !to) return 'period';
  const ms   = new Date(to).getTime() - new Date(from).getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
  if (days === 1)                   return 'daily';
  if (days <= 7)                    return 'weekly';
  if (days >= 28 && days <= 32)     return 'monthly';
  return 'period';
}

/** Deutsch-Label für import_type */
export function importTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case 'daily':   return 'Tagesimport';
    case 'weekly':  return 'Wochenimport';
    case 'monthly': return 'Monatsimport';
    case 'period':  return 'Zeitraumimport';
    default:        return 'Import';
  }
}

// ── Überschneidungsprüfung ───────────────────────────────────────────────────

/**
 * Gibt alle aktiven Importe zurück, die sich mit dem neuen Zeitraum überschneiden.
 * Formel: existing.from <= new.to  AND  existing.to >= new.from
 */
/** Kostenstelle normalisieren (für Überschneidungs- und Duplikat-Vergleich). */
function normCostCenter(cc: string | null | undefined): string {
  return (cc || '').trim().toLowerCase();
}

export async function checkOverlappingImports(
  restaurantId: string,
  periodFrom: string,
  periodTo: string,
  excludeId?: string,
  costCenter?: string | null,
): Promise<OverlapInfo[]> {
  try {
    let q = (supabase as any)
      .from('gn_imports')
      .select('id, file_name, period_from, period_to, z_counter, gross_revenue, import_type, cost_center')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .lte('period_from', periodTo)
      .gte('period_to', periodFrom);

    if (excludeId) q = q.neq('id', excludeId);

    const { data, error } = await q;
    if (error || !data) return [];

    let rows = data as Array<OverlapInfo & { cost_center?: string | null }>;
    // Kostenstellen-Filter NUR wenn eine NICHT-LEERE Kostenstelle übergeben wurde.
    // Dann gilt ein Import einer anderen Kostenstelle am selben Tag nicht als
    // Überschneidung (z. B. Oliv vs. Beaulieu am gleichen Datum).
    //
    // Bei null/leerer Kostenstelle (oder im Einzeldatei-Pfad ganz ohne Argument)
    // bleibt es beim rein datumsbasierten Check.  Sonst würde eine Datei OHNE
    // erkannte Kostenstelle bestehende Tagesimporte MIT Kostenstelle übersehen
    // und denselben Tag ein zweites Mal aktiv anlegen → doppelter Umsatz.
    const want = normCostCenter(costCenter);
    if (want) {
      rows = rows.filter(r => normCostCenter(r.cost_center) === want);
    }
    return rows as OverlapInfo[];
  } catch {
    return [];
  }
}

// ── Import speichern ─────────────────────────────────────────────────────────

export async function saveGnImport(
  restaurantId: string,
  parsed: GnParsedZBericht,
  pdfFileName?: string,
  overlapIds?: string[],
  manualPeriodFrom?: string,
  manualPeriodTo?: string,
): Promise<{ importId: string; error: string | null }> {
  try {
    const periodFrom = manualPeriodFrom || parsed.periodFrom || null;
    const periodTo   = manualPeriodTo   || parsed.periodTo   || null;
    const impType    = detectImportType(periodFrom, periodTo);
    const aggLevel   = periodFrom && periodTo && periodFrom === periodTo ? 'day' : 'period';

    // gn_imports Haupteintrag
    const { data: imp, error: impErr } = await (supabase as any)
      .from('gn_imports')
      .insert({
        restaurant_id:      restaurantId,
        file_name:          parsed.fileName,
        pdf_file_name:      pdfFileName ?? null,
        z_counter:          parsed.zCounter || null,
        cost_center:        parsed.costCenter || null,
        period_from:        periodFrom,
        period_to:          periodTo,
        import_type:        impType,
        aggregation_level:  aggLevel,
        gross_revenue:      parsed.revenue.totalGross || null,
        net_revenue:        parsed.taxNetTotal || null,
        food_revenue:       parsed.foodAmount || null,
        bev_revenue:        parsed.bevAmount || null,
        take_away_revenue:  parsed.takeAwayAmount || null,
        discount_total:     parsed.discountTotal || null,
        cancellation_total: parsed.stornoTotal || null,
        receipts_count:     parsed.bonCount || null,
        avg_receipt:        parsed.avgBon || null,
        status:             'active',
        raw_csv_json:       parsed as unknown,
        checksum:           parsed.checksum || null,
      })
      .select('id')
      .single();

    if (impErr || !imp) {
      return { importId: '', error: impErr?.message ?? 'Import fehlgeschlagen' };
    }

    const importId: string = imp.id;

    // Alle abhängigen Tabellen + optional gn_zbericht_daily
    const childResults = await Promise.all([
      (supabase as any).from('gn_revenue_summary').insert({
        import_id: importId,
        total_gross: parsed.revenue.totalGross,
        total_excl_tip: parsed.revenue.totalExclTip,
        total_excl_rounding: parsed.revenue.totalExclRounding,
        total_excl_customer_card_topups: parsed.revenue.totalExclCardTopups,
      }),

      parsed.taxes.length > 0
        ? (supabase as any).from('gn_tax_summary').insert(
            parsed.taxes.map(t => ({
              import_id: importId,
              tax_rate: t.taxRate, net_amount: t.netAmount,
              tax_amount: t.taxAmount, gross_amount: t.grossAmount,
            })))
        : Promise.resolve({ error: null }),

      parsed.costCenters.length > 0
        ? (supabase as any).from('gn_cost_centers').insert(
            parsed.costCenters.map(c => ({ import_id: importId, name: c.name, count: c.count, amount: c.amount })))
        : Promise.resolve({ error: null }),

      parsed.waiters.length > 0
        ? (supabase as any).from('gn_waiters').insert(
            parsed.waiters.map(w => ({ import_id: importId, name: w.name, count: w.count, amount: w.amount })))
        : Promise.resolve({ error: null }),

      parsed.paymentMethods.length > 0
        ? (supabase as any).from('gn_payment_methods').insert(
            parsed.paymentMethods.map(p => ({ import_id: importId, name: p.name, count: p.count, amount: p.amount })))
        : Promise.resolve({ error: null }),

      parsed.productGroups.length > 0
        ? (supabase as any).from('gn_product_groups').insert(
            parsed.productGroups.map(p => ({
              import_id: importId, name: p.name, count: p.count,
              original_amount: p.originalAmount, amount: p.amount,
            })))
        : Promise.resolve({ error: null }),

      parsed.discounts.length > 0
        ? (supabase as any).from('gn_discounts').insert(
            parsed.discounts.map(d => ({
              import_id: importId, type: d.type, name: d.name, count: d.count, amount: d.amount,
            })))
        : Promise.resolve({ error: null }),

      parsed.cancellations.length > 0
        ? (supabase as any).from('gn_cancellations').insert(
            parsed.cancellations.map(c => ({ import_id: importId, name: c.name, count: c.count, amount: c.amount })))
        : Promise.resolve({ error: null }),

      parsed.accountingLines.length > 0
        ? (supabase as any).from('gn_accounting_lines').insert(
            parsed.accountingLines.map(a => ({
              import_id: importId, name: a.name, account: a.account, tax_rate: a.taxRate, gross_amount: a.grossAmount,
            })))
        : Promise.resolve({ error: null }),

      parsed.paymentAccounts.length > 0
        ? (supabase as any).from('gn_payment_accounts').insert(
            parsed.paymentAccounts.map(p => ({ import_id: importId, name: p.name, account: p.account, gross_amount: p.grossAmount })))
        : Promise.resolve({ error: null }),

      // gn_zbericht_daily — nur für Tagesimporte (period_from = period_to)
      aggLevel === 'day' && periodFrom
        ? (supabase as any).from('gn_zbericht_daily').insert({
            import_id:          importId,
            restaurant_id:      restaurantId,
            date:               periodFrom,
            gross_revenue:      parsed.revenue.totalGross || null,
            net_revenue:        parsed.taxNetTotal || null,
            food_revenue:       parsed.foodAmount || null,
            bev_revenue:        parsed.bevAmount || null,
            take_away_revenue:  parsed.takeAwayAmount || null,
            discount_total:     parsed.discountTotal || null,
            cancellation_total: parsed.stornoTotal || null,
            receipts_count:     parsed.bonCount || null,
            avg_receipt:        parsed.avgBon || null,
            source_period_from: periodFrom,
            source_period_to:   periodTo,
            aggregation_level:  'day',
          })
        : Promise.resolve({ error: null }),
    ]);

    // Bei Kind-Insert-Fehler: neuen Import kompensierend als 'deleted' markieren,
    // damit kein halb-aktiver Import zurückbleibt (keine stille Datenkorruption).
    const childError = (childResults as Array<{ error?: unknown } | null>)
      .find(r => r && (r as { error?: unknown }).error);
    if (childError) {
      await (supabase as any).from('gn_imports').update({ status: 'deleted' }).eq('id', importId);
      const msg = (childError as { error?: { message?: string } }).error?.message
        ?? 'Detaildaten konnten nicht gespeichert werden';
      return { importId: '', error: msg };
    }

    // Erst NACH erfolgreichem Insert die überschneidenden Importe ersetzen.
    // Kein delete-then-insert: schlägt der neue Insert fehl, bleibt der alte
    // Tag aktiv und es gehen keine Umsatzdaten verloren.
    //
    // Jeder Replace-Update wird auf Fehler geprüft.  Schlägt einer fehl, wird der
    // gesamte Replace zurückgerollt (bereits ersetzte Importe reaktivieren, neuen
    // Import löschen), damit nie alter UND neuer Import gleichzeitig aktiv sind
    // (sonst doppelter Umsatz) — und kein Tag ohne aktiven Import zurückbleibt.
    if (overlapIds && overlapIds.length > 0) {
      const replaced: string[] = [];
      let replaceError: string | null = null;
      for (const id of overlapIds) {
        // `.select('id')` gibt die tatsächlich geänderten Zeilen zurück.  So wird
        // ein "erfolgreicher" Update mit 0 betroffenen Zeilen (stale ID, RLS,
        // bereits geändert) als Fehler erkannt — sonst bliebe der alte Import aktiv.
        const { data: repData, error: repErr } = await (supabase as any)
          .from('gn_imports')
          .update({ status: 'replaced' })
          .eq('id', id)
          .select('id');
        if (repErr) { replaceError = repErr.message ?? String(repErr); break; }
        if (!repData || repData.length === 0) {
          replaceError = `Bestehender Import ${id} konnte nicht ersetzt werden (0 Zeilen betroffen).`;
          break;
        }
        replaced.push(id);
      }
      if (replaceError) {
        // Rollback: bereits ersetzte Importe reaktivieren, neuen Import löschen,
        // damit nie alter UND neuer Import gleichzeitig aktiv sind (doppelter
        // Umsatz) — und kein Tag ohne aktiven Import zurückbleibt.  Schlägt der
        // Rollback selbst fehl, wird ein harter Fehler mit Hinweis auf manuelle
        // Prüfung zurückgegeben (kein stilles Verschlucken).
        const rollbackErrors: string[] = [];
        for (const id of replaced) {
          const { error: rbErr } = await (supabase as any)
            .from('gn_imports').update({ status: 'active' }).eq('id', id);
          if (rbErr) rollbackErrors.push(`${id}: ${rbErr.message ?? String(rbErr)}`);
        }
        const { error: delErr } = await (supabase as any)
          .from('gn_imports').update({ status: 'deleted' }).eq('id', importId);
        if (delErr) rollbackErrors.push(`neuer Import ${importId}: ${delErr.message ?? String(delErr)}`);

        if (rollbackErrors.length > 0) {
          return {
            importId: '',
            error: `Ersetzen fehlgeschlagen UND Rollback unvollständig — bitte Daten manuell prüfen. `
              + `Ursache: ${replaceError}. Rollback-Fehler: ${rollbackErrors.join('; ')}`,
          };
        }
        return { importId: '', error: `Ersetzen fehlgeschlagen: ${replaceError}` };
      }
    }

    return { importId, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { importId: '', error: msg };
  }
}

// ── Multi-Datei-Import (Batch) ───────────────────────────────────────────────

/**
 * Ermittelt die bestehenden DB-Überschneidungen je Datei (für die Vorschau und
 * die Konfliktauflösung).  Rückgabe: Map Batch-ID → OverlapInfo[].
 */
export async function fetchBatchOverlaps(
  restaurantId: string,
  items: Array<{ id: string; periodFrom: string | null; periodTo: string | null; costCenter?: string | null }>,
): Promise<Record<string, OverlapInfo[]>> {
  const entries = await Promise.all(
    items.map(async (it) => {
      if (!it.periodFrom) return [it.id, [] as OverlapInfo[]] as const;
      const overlaps = await checkOverlappingImports(
        restaurantId,
        it.periodFrom,
        it.periodTo || it.periodFrom,
        undefined,
        it.costCenter ?? null,
      );
      return [it.id, overlaps] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export interface BatchSaveItem {
  /** Stabile Batch-ID (robust gegen gleiche Dateinamen). */
  id: string;
  fileName: string;
  /** null bei übersprungenen/fehlerhaften Dateien (wird dann nicht geschrieben). */
  parsed: GnParsedZBericht | null;
  action: 'import' | 'replace' | 'skip';
  overlapIds: string[];
  periodFrom?: string;
  periodTo?: string;
}

export interface BatchSaveResult {
  /** Stabile Batch-ID (entspricht BatchSaveItem.id). */
  id: string;
  fileName: string;
  ok: boolean;
  skipped: boolean;
  importId: string | null;
  error: string | null;
}

/**
 * Speichert mehrere Z-Berichte sequenziell und ATOMAR PRO DATEI.
 *
 * Jede Datei ist ein eigener `saveGnImport`-Aufruf.  Schlägt eine Datei fehl,
 * bleiben bereits erfolgreich gespeicherte Dateien unangetastet (keine
 * gegenseitige Beschädigung).  Übersprungene Dateien werden nicht geschrieben.
 */
export async function saveGnZBerichtBatch(
  restaurantId: string,
  items: BatchSaveItem[],
): Promise<BatchSaveResult[]> {
  const results: BatchSaveResult[] = [];
  for (const item of items) {
    if (item.action === 'skip') {
      results.push({ id: item.id, fileName: item.fileName, ok: false, skipped: true, importId: null, error: null });
      continue;
    }
    if (!item.parsed) {
      results.push({ id: item.id, fileName: item.fileName, ok: false, skipped: false, importId: null, error: 'Kein geparstes Ergebnis vorhanden.' });
      continue;
    }
    try {
      const { importId, error } = await saveGnImport(
        restaurantId,
        item.parsed,
        undefined,
        item.action === 'replace' ? item.overlapIds : [],
        item.periodFrom,
        item.periodTo,
      );
      results.push({
        id: item.id,
        fileName: item.fileName,
        ok: !error,
        skipped: false,
        importId: importId || null,
        error: error ?? null,
      });
    } catch (e: unknown) {
      results.push({
        id: item.id,
        fileName: item.fileName,
        ok: false,
        skipped: false,
        importId: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// ── Imports laden ────────────────────────────────────────────────────────────

export async function loadGnImports(restaurantId: string): Promise<GnImportRow[]> {
  const { data, error } = await (supabase as any)
    .from('gn_imports')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .in('status', ['active'])
    .order('period_from', { ascending: false });

  if (error || !data) return [];
  return data as GnImportRow[];
}

// ── GN-Umsatz pro Monat (für Umsatzabstimmung) ───────────────────────────────

/**
 * Liefert ein Array mit 12 Bruttoumsätzen (Index 0 = Jan, 11 = Dez).
 * Sums imports by month of period_from.
 */
export async function loadGnRevenueForYear(
  restaurantId: string,
  year: number,
): Promise<number[]> {
  try {
    const { data } = await (supabase as any)
      .from('gn_imports')
      .select('period_from, gross_revenue')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .gte('period_from', `${year}-01-01`)
      .lte('period_from', `${year}-12-31`)
      .not('gross_revenue', 'is', null);

    const result = new Array(12).fill(0) as number[];
    if (!data) return result;

    for (const row of data as Array<{ period_from: string; gross_revenue: number }>) {
      if (!row.period_from) continue;
      const month = new Date(row.period_from).getMonth(); // 0-indexed
      result[month] += row.gross_revenue ?? 0;
    }
    return result;
  } catch {
    return new Array(12).fill(0) as number[];
  }
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

// ── Import löschen ────────────────────────────────────────────────────────────

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
