/**
 * Gastronovi Z-Bericht — Supabase DB Layer
 *
 * Schreiboperationen, Überschneidungsprüfung und Reporting.
 * Tabellen: gn_imports (v1) + neue Spalten (v2) + gn_zbericht_daily (v2)
 */

import { supabase } from '@/integrations/supabase/client';
import type { GnExtendedData, GnExtendedEntry, GnHourlyRevenueRow, GnParsedZBericht } from './gn-zbericht-parser';
import type { GnDayClosing } from './tagesabschluss';

const r2 = (v: number): number => Math.round(v * 100) / 100;

// ── Erweiterter Bericht: Persistenz-Helfer ───────────────────────────────────

/** Abschnitts-Schlüssel in gn_extended_positions.section */
export type GnExtSection = 'main_categories_ct' | 'categories' | 'categories_ct' | 'positions';

/** Sichtbarer Hinweis, wenn die Migration noch nicht ausgeführt wurde. */
export const GN_EXT_MIGRATION_HINT =
  'Die Datenbank-Migration "20260723_gn_extended_positions.sql" wurde noch nicht ausgeführt. '
  + 'Bitte im Supabase SQL-Editor ausführen und den Import danach wiederholen.';

/**
 * Erkennt "Schema fehlt"-Fehler (Tabelle gn_extended_positions bzw. Spalte
 * gn_imports.report_type existiert noch nicht):
 *   42P01 = relation does not exist · PGRST205 = table not in schema cache
 *   42703 = column does not exist  · PGRST204 = column not in schema cache
 */
export function isMissingExtendedSchemaError(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  const msg  = err.message ?? '';
  if (!['42P01', 'PGRST205', '42703', 'PGRST204'].includes(code)) return false;
  return /gn_extended_positions|report_type/i.test(msg);
}

interface GnExtendedPositionInsert {
  import_id: string;
  restaurant_id: string;
  period_from: string | null;
  period_to: string | null;
  section: GnExtSection;
  name: string;
  quantity: number;
  gross_amount: number;
  original_amount: number | null;
  consumption_type: 'in_house' | 'takeaway' | null;
}

/**
 * Baut die Insert-Zeilen für gn_extended_positions und dedupliziert nach dem
 * UNIQUE-Schlüssel (section, name, consumption_type) — identische Namen im
 * selben Abschnitt werden summiert (gleiche fachliche Grenze wie beim
 * Produkt-CSV-Import: die Quelle ist eine flache CSV ohne Artikelnummer).
 */
export function buildExtendedPositionRows(
  importId: string,
  restaurantId: string,
  periodFrom: string | null,
  periodTo: string | null,
  extendedData: GnExtendedData,
): GnExtendedPositionInsert[] {
  const byKey = new Map<string, GnExtendedPositionInsert>();
  const collect = (section: GnExtSection, entries: GnExtendedEntry[]) => {
    for (const e of entries) {
      if (!e.name) continue;
      const key = `${section}\u0000${e.name}\u0000${e.consumptionType ?? ''}`;
      const prev = byKey.get(key);
      if (prev) {
        prev.quantity     += e.quantity;
        prev.gross_amount  = r2(prev.gross_amount + e.grossAmount);
        prev.original_amount = prev.original_amount === null && e.originalAmount === null
          ? null
          : r2((prev.original_amount ?? 0) + (e.originalAmount ?? 0));
      } else {
        byKey.set(key, {
          import_id: importId,
          restaurant_id: restaurantId,
          period_from: periodFrom,
          period_to: periodTo,
          section,
          name: e.name,
          quantity: e.quantity,
          gross_amount: r2(e.grossAmount),
          original_amount: e.originalAmount === null ? null : r2(e.originalAmount),
          consumption_type: e.consumptionType,
        });
      }
    }
  };
  collect('main_categories_ct', extendedData.mainCategoriesByConsumptionType);
  collect('categories',         extendedData.categories);
  collect('categories_ct',      extendedData.categoriesByConsumptionType);
  collect('positions',          extendedData.positions);
  return Array.from(byKey.values());
}

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
  /** 'extended' bei erweiterten Z-Berichten; null/fehlt = Standard (Spalte ab Migration 20260723). */
  report_type?: string | null;
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

// ── Checksum-Duplikat (Idempotenz) ───────────────────────────────────────────

/**
 * Identischer Reimport (gleicher Tenant + gleiche Checksum, aktiv) = No-op:
 * der Aufrufer prüft dies VOR jedem Write und speichert dann NICHT erneut.
 * Fehler ⇒ { isDuplicate: false } — der Import läuft dann regulär weiter
 * (der Perioden-Overlap-Check fängt echte Doppelimporte weiterhin ab).
 */
export async function checkGnChecksumDuplicate(
  restaurantId: string,
  checksum: string | null | undefined,
): Promise<{ isDuplicate: boolean; existingId: string | null; existingFileName: string | null; existingImportedAt: string | null }> {
  const none = { isDuplicate: false, existingId: null, existingFileName: null, existingImportedAt: null };
  if (!checksum) return none;
  try {
    const { data, error } = await (supabase as any)
      .from('gn_imports')
      .select('id, file_name, created_at')
      .eq('restaurant_id', restaurantId)
      .eq('checksum', checksum)
      .eq('status', 'active')
      .limit(1);
    if (error || !data || data.length === 0) return none;
    const row = data[0] as { id: string; file_name: string | null; created_at: string | null };
    return {
      isDuplicate: true,
      existingId: row.id,
      existingFileName: row.file_name,
      existingImportedAt: row.created_at,
    };
  } catch {
    return none;
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
        // report_type NUR bei erweiterten Berichten mitschicken: Standard-
        // Importe bleiben so auch VOR der Migration 20260723 voll funktionsfähig.
        ...(parsed.reportType === 'extended' ? { report_type: 'extended' } : {}),
      })
      .select('id')
      .single();

    if (impErr || !imp) {
      if (isMissingExtendedSchemaError(impErr)) {
        return { importId: '', error: GN_EXT_MIGRATION_HINT };
      }
      return { importId: '', error: impErr?.message ?? 'Import fehlgeschlagen' };
    }

    const importId: string = imp.id;

    // Detailpositionen des erweiterten Berichts (dedupliziert nach UNIQUE-Schlüssel)
    const extRows = parsed.reportType === 'extended' && parsed.extendedData
      ? buildExtendedPositionRows(importId, restaurantId, periodFrom, periodTo, parsed.extendedData)
      : [];

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

      // Erweiterter Bericht: aggregierte Detailpositionen (Periodensummen,
      // KEINE Einzeltransaktionen). Atomar mit dem Import: schlägt der Insert
      // fehl, markiert die Kind-Fehlerbehandlung unten den gesamten Import
      // als 'deleted' — nie Standard-Daten OHNE Detaildaten.
      extRows.length > 0
        ? (supabase as any).from('gn_extended_positions').insert(extRows)
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
      const errObj = (childError as { error?: { code?: string; message?: string } }).error;
      if (isMissingExtendedSchemaError(errObj)) {
        return { importId: '', error: GN_EXT_MIGRATION_HINT };
      }
      const msg = errObj?.message ?? 'Detaildaten konnten nicht gespeichert werden';
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

// ── GN-Tagesumsatz für Zeitraum (für gemeinsame Tagesanalyse) ────────────────

/**
 * Bruttoumsatz pro Geschäftstag aus aktiven Tages-Z-Berichten
 * (aggregation_level 'day').  Mehrtages-/Periodenberichte werden bewusst
 * NICHT auf Tage verteilt.  Bei mehreren aktiven Tagesimporten für dasselbe
 * Datum gewinnt der zuletzt importierte (Replace-Semantik der Importe).
 */
export async function loadGnDailyGrossRevenue(
  restaurantId: string,
  fromIso: string,
  toIso: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const { data } = await (supabase as any)
      .from('gn_imports')
      .select('period_from, gross_revenue, imported_at')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .eq('aggregation_level', 'day')
      .gte('period_from', fromIso)
      .lte('period_from', toIso)
      .not('gross_revenue', 'is', null)
      .order('imported_at', { ascending: true });

    for (const row of (data ?? []) as Array<{ period_from: string; gross_revenue: number }>) {
      if (!row.period_from) continue;
      if (typeof row.gross_revenue !== 'number' || !(row.gross_revenue > 0)) continue;
      result.set(row.period_from, row.gross_revenue); // später importierte überschreiben
    }
    return result;
  } catch {
    return result;
  }
}

// ── GN-Stundenumsätze für Zeitraum (für Zeitabschnittsanalyse) ───────────────

/**
 * Stundenumsätze (Zeitabschnitte) pro Geschäftstag aus aktiven
 * Tages-Z-Berichten (aggregation_level 'day').  Liest die Zeitabschnitte
 * direkt aus dem JSON-Blob (`raw_csv_json->hourlyRevenue`) — bewusst OHNE
 * Migration (Architektur-Entscheid).  Mehrtages-/Periodenberichte werden
 * NICHT auf Tage verteilt.  Bei mehreren aktiven Tagesimporten für dasselbe
 * Datum gewinnt der zuletzt importierte (Replace-Semantik der Importe).
 */
export async function loadGnHourlyRevenueByDay(
  restaurantId: string,
  fromIso: string,
  toIso: string,
): Promise<Map<string, GnHourlyRevenueRow[]>> {
  const result = new Map<string, GnHourlyRevenueRow[]>();
  try {
    const { data } = await (supabase as any)
      .from('gn_imports')
      .select('period_from, imported_at, hourly:raw_csv_json->hourlyRevenue')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .eq('aggregation_level', 'day')
      .gte('period_from', fromIso)
      .lte('period_from', toIso)
      .order('imported_at', { ascending: true });

    for (const row of (data ?? []) as Array<{ period_from: string; hourly: unknown }>) {
      if (!row.period_from) continue;
      if (!Array.isArray(row.hourly)) continue;
      const rows = (row.hourly as GnHourlyRevenueRow[]).filter(
        h => h && typeof h.totalAmount === 'number' && Number.isFinite(h.totalAmount),
      );
      if (rows.length === 0) continue;
      result.set(row.period_from, rows); // später importierte überschreiben
    }
    return result;
  } catch {
    return result;
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

// ── Zahlungsarten je Tag (für Adyen-Abgleich, read-only) ─────────────────────

export interface GnDayPaymentRow {
  name: string;
  count: number;
  amount: number;
}

/**
 * Liefert die Z-Bericht-Zahlungsarten je Tag eines Monats (read-only).
 * NUR Tages-Importe (period_from === period_to) — Wochen-/Monats-Importe würden
 * einen Tag doppelt zählen. Mehrere aktive Tages-Importe desselben Tags
 * (z. B. verschiedene Kostenstellen) werden defensiv zusammengeführt.
 */
export async function loadGnPaymentMethodsForMonth(
  restaurantId: string,
  year: number,
  month: number, // 1-basiert
): Promise<Record<string, GnDayPaymentRow[]>> {
  try {
    const mm = String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${year}-${mm}-01`;
    const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

    const { data: imports } = await (supabase as any)
      .from('gn_imports')
      .select('id, period_from, period_to')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .gte('period_from', from)
      .lte('period_from', to);

    const dayByImport = new Map<string, string>();
    for (const row of (imports ?? []) as Array<{ id: string; period_from: string | null; period_to: string | null }>) {
      if (!row.period_from || row.period_from !== row.period_to) continue; // nur Tagesimporte
      dayByImport.set(row.id, row.period_from);
    }
    if (dayByImport.size === 0) return {};

    const { data: pms } = await (supabase as any)
      .from('gn_payment_methods')
      .select('import_id, name, count, amount')
      .in('import_id', [...dayByImport.keys()]);

    const result: Record<string, GnDayPaymentRow[]> = {};
    for (const pm of (pms ?? []) as Array<{ import_id: string; name: string | null; count: number | null; amount: number | null }>) {
      const day = dayByImport.get(pm.import_id);
      if (!day || !pm.name?.trim()) continue;
      const list = (result[day] ??= []);
      const existing = list.find(e => e.name === pm.name!.trim());
      if (existing) {
        existing.count += pm.count ?? 0;
        existing.amount = Math.round((existing.amount + (pm.amount ?? 0)) * 100) / 100;
      } else {
        list.push({ name: pm.name.trim(), count: pm.count ?? 0, amount: pm.amount ?? 0 });
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ── Tagesabschluss-Daten je Tag (für Tagesabschluss-Übersicht, read-only) ────

/**
 * Liefert die kompletten Z-Bericht-Tagesdaten eines Monats für die
 * Tagesabschluss-Übersicht (read-only, KEIN raw_csv_json).
 * NUR Tages-Importe (period_from === period_to); mehrere aktive Tages-Importe
 * desselben Tags (z. B. Kostenstellen) werden defensiv SUMMIERT.
 */
export async function loadGnDayClosingsForMonth(
  restaurantId: string,
  year: number,
  month: number, // 1-basiert
): Promise<Record<string, GnDayClosing>> {
  try {
    const mm = String(month).padStart(2, '0');
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${year}-${mm}-01`;
    const to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

    const { data: imports } = await (supabase as any)
      .from('gn_imports')
      .select('id, period_from, period_to, gross_revenue, net_revenue')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .gte('period_from', from)
      .lte('period_from', to);

    const dayByImport = new Map<string, string>();
    const result: Record<string, GnDayClosing> = {};
    for (const row of (imports ?? []) as Array<{
      id: string; period_from: string | null; period_to: string | null;
      gross_revenue: number | null; net_revenue: number | null;
    }>) {
      if (!row.period_from || row.period_from !== row.period_to) continue; // nur Tagesimporte
      dayByImport.set(row.id, row.period_from);
      const day = (result[row.period_from] ??= {
        date: row.period_from,
        grossRevenue: null,
        netRevenue: null,
        tip: null,
        taxes: [],
        payments: [],
        accountingLines: [],
        paymentAccounts: [],
      });
      if (row.gross_revenue !== null) day.grossRevenue = r2((day.grossRevenue ?? 0) + row.gross_revenue);
      if (row.net_revenue !== null) day.netRevenue = r2((day.netRevenue ?? 0) + row.net_revenue);
    }
    if (dayByImport.size === 0) return {};
    const importIds = [...dayByImport.keys()];

    const [pmRes, taxRes, revRes, accRes, payAccRes] = await Promise.all([
      (supabase as any).from('gn_payment_methods').select('import_id, name, count, amount').in('import_id', importIds),
      (supabase as any).from('gn_tax_summary').select('import_id, tax_rate, net_amount, tax_amount, gross_amount').in('import_id', importIds),
      (supabase as any).from('gn_revenue_summary').select('import_id, total_gross, total_excl_tip').in('import_id', importIds),
      (supabase as any).from('gn_accounting_lines').select('import_id, name, account, tax_rate, gross_amount').in('import_id', importIds),
      (supabase as any).from('gn_payment_accounts').select('import_id, name, account, gross_amount').in('import_id', importIds),
    ]);

    for (const pm of (pmRes.data ?? []) as Array<{ import_id: string; name: string | null; count: number | null; amount: number | null }>) {
      const date = dayByImport.get(pm.import_id);
      if (!date || !pm.name?.trim()) continue;
      const list = result[date].payments;
      const existing = list.find(e => e.name === pm.name!.trim());
      if (existing) {
        existing.count += pm.count ?? 0;
        existing.amount = r2(existing.amount + (pm.amount ?? 0));
      } else {
        list.push({ name: pm.name.trim(), count: pm.count ?? 0, amount: pm.amount ?? 0 });
      }
    }

    for (const t of (taxRes.data ?? []) as Array<{ import_id: string; tax_rate: string | null; net_amount: number | null; tax_amount: number | null; gross_amount: number | null }>) {
      const date = dayByImport.get(t.import_id);
      if (!date || !t.tax_rate?.trim()) continue;
      const list = result[date].taxes;
      const rate = t.tax_rate.trim();
      const existing = list.find(e => e.rate === rate);
      if (existing) {
        existing.net = r2(existing.net + (t.net_amount ?? 0));
        existing.tax = r2(existing.tax + (t.tax_amount ?? 0));
        existing.gross = r2(existing.gross + (t.gross_amount ?? 0));
      } else {
        list.push({ rate, net: t.net_amount ?? 0, tax: t.tax_amount ?? 0, gross: t.gross_amount ?? 0 });
      }
    }

    for (const r of (revRes.data ?? []) as Array<{ import_id: string; total_gross: number | null; total_excl_tip: number | null }>) {
      const date = dayByImport.get(r.import_id);
      if (!date) continue;
      if (r.total_gross !== null && r.total_excl_tip !== null) {
        const tip = r2(r.total_gross - r.total_excl_tip);
        if (tip > 0) result[date].tip = r2((result[date].tip ?? 0) + tip);
      }
    }

    for (const a of (accRes.data ?? []) as Array<{ import_id: string; name: string | null; account: string | null; tax_rate: string | null; gross_amount: number | null }>) {
      const date = dayByImport.get(a.import_id);
      if (!date || !a.name?.trim()) continue;
      result[date].accountingLines.push({
        name: a.name.trim(),
        account: a.account?.trim() || null,
        taxRate: a.tax_rate?.trim() || null,
        grossAmount: a.gross_amount ?? 0,
      });
    }

    for (const p of (payAccRes.data ?? []) as Array<{ import_id: string; name: string | null; account: string | null; gross_amount: number | null }>) {
      const date = dayByImport.get(p.import_id);
      if (!date || !p.name?.trim()) continue;
      result[date].paymentAccounts.push({
        name: p.name.trim(),
        account: p.account?.trim() || null,
        grossAmount: p.gross_amount ?? 0,
      });
    }

    return result;
  } catch {
    return {};
  }
}

// ── Erweiterter Bericht: Lesepfade (strikt read-only) ────────────────────────

/** Zeitraum eines aktiven erweiterten Z-Berichts (für Abdeckungs-Checks). */
export interface GnExtendedCoverageRange {
  importId: string;
  periodFrom: string | null;
  periodTo: string | null;
}

/**
 * Zeiträume aller AKTIVEN erweiterten Z-Berichte eines Tenants.
 * Fehlt das Schema noch (Migration 20260723 nicht ausgeführt), können keine
 * erweiterten Importe existieren → leere Liste ist die korrekte Antwort,
 * kein Fehler. Alle anderen Fehler werden sichtbar zurückgegeben.
 */
export async function fetchExtendedCoverage(
  restaurantId: string,
): Promise<{ ranges: GnExtendedCoverageRange[]; error: string | null }> {
  const { data, error } = await (supabase as any)
    .from('gn_imports')
    .select('id, period_from, period_to')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .eq('report_type', 'extended');
  if (error) {
    if (isMissingExtendedSchemaError(error)) return { ranges: [], error: null };
    return { ranges: [], error: error.message ?? 'Abdeckung konnte nicht geladen werden' };
  }
  const ranges = ((data ?? []) as Array<{ id: string; period_from: string | null; period_to: string | null }>)
    .map(r => ({ importId: r.id, periodFrom: r.period_from, periodTo: r.period_to }));
  return { ranges, error: null };
}

/** Gespeicherte Detailposition eines erweiterten Z-Berichts (Lese-Shape). */
export interface GnExtendedPositionRow {
  importId: string;
  periodFrom: string | null;
  periodTo: string | null;
  section: GnExtSection;
  name: string;
  quantity: number;
  grossAmount: number;
  originalAmount: number | null;
  consumptionType: 'in_house' | 'takeaway' | null;
}

/**
 * Detailpositionen aller AKTIVEN erweiterten Z-Berichte eines Tenants, deren
 * Zeitraum sich mit [from, to] überschneidet (Überschneidungsformel wie
 * checkOverlappingImports). Ersetzte/gelöschte Importe zählen NIE mit —
 * Quelle der Statusprüfung ist der Join auf gn_imports (kein Duplikat-Status).
 * Fehlendes Schema (Migration 20260723 nicht ausgeführt) → leere Liste.
 */
export async function fetchExtendedPositions(
  restaurantId: string,
  from?: string,
  to?: string,
): Promise<{ rows: GnExtendedPositionRow[]; error: string | null }> {
  let q = (supabase as any)
    .from('gn_extended_positions')
    .select('import_id, period_from, period_to, section, name, quantity, gross_amount, original_amount, consumption_type, gn_imports!inner(status)')
    .eq('restaurant_id', restaurantId)
    .eq('gn_imports.status', 'active');
  if (to)   q = q.lte('period_from', to);
  if (from) q = q.gte('period_to', from);
  const { data, error } = await q;
  if (error) {
    if (isMissingExtendedSchemaError(error)) return { rows: [], error: null };
    return { rows: [], error: error.message ?? 'Detailpositionen konnten nicht geladen werden' };
  }
  const rows = ((data ?? []) as Array<{
    import_id: string; period_from: string | null; period_to: string | null;
    section: GnExtSection; name: string; quantity: number | null;
    gross_amount: number | null; original_amount: number | null;
    consumption_type: 'in_house' | 'takeaway' | null;
  }>).map(r => ({
    importId: r.import_id,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    section: r.section,
    name: r.name,
    quantity: r.quantity ?? 0,
    grossAmount: r.gross_amount ?? 0,
    originalAmount: r.original_amount,
    consumptionType: r.consumption_type,
  }));
  return { rows, error: null };
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
