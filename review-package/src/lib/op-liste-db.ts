/**
 * op-liste-db — Supabase-Anbindung des Kreditoren-OP-Listen-Tools.
 * ─────────────────────────────────────────────────────────────────────────────
 * Tabellen: `creditor_op_imports` / `creditor_op_items`
 * (Migration supabase/migrations/20260708_creditor_op.sql — wird manuell im
 * SQL-Editor ausgeführt; Loads sind deshalb best-effort mit `tableMissing`).
 *
 * MANDANTENTRENNUNG (Pflicht): jeder Read/Write filtert `restaurant_id`.
 *
 * REPLACE-FLOW (kein delete-then-insert, Muster gn-zbericht-db):
 *   1. neuen Import mit status='processing' anlegen
 *   2. Items chunked (200) einfügen — bei Fehler: neuen Import → 'deleted'
 *   3. alten Import (falls Ersetzen) → 'replaced' (0-Zeilen-Update = Fehler)
 *   4. neuen Import → 'active' — bei Fehler: kompensierendes Rollback
 *   Reads filtern status='active'; der partielle Unique-Index in der DB
 *   verhindert doppelt-aktive Stichtage zusätzlich serverseitig.
 */

import { supabase } from '@/integrations/supabase/client';
import type {
  OpBuckets, OpImportRecord, OpItemRecord, OpListeParseResult,
} from '@/types/op-liste';

const IMPORTS = 'creditor_op_imports';
const ITEMS = 'creditor_op_items';
const WRITE_CHUNK = 200;

const TABLE_MISSING = /relation .* does not exist|schema cache|not exist|404/i;

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToImport(row: any): OpImportRecord {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    snapshotDate: row.snapshot_date,
    importedAt: row.imported_at ?? null,
    sourceFilename: row.source_filename ?? null,
    totalOpenAmount: num(row.total_open_amount),
    totalItems: row.total_items ?? null,
    supplierCount: row.supplier_count ?? null,
    status: row.status,
    rawTotals: row.raw_totals_json?.totals ?? null,
  };
}

function rowToItem(row: any): OpItemRecord {
  const buckets: OpBuckets = {
    overdue29Plus: num(row.overdue_29_plus),
    overdueSince29: num(row.overdue_since_29),
    overdueSince14: num(row.overdue_since_14),
    dueIn15: num(row.due_in_15),
    dueIn30: num(row.due_in_30),
    dueAfter30: num(row.due_after_30),
  };
  return {
    id: row.id,
    importId: row.import_id,
    restaurantId: row.restaurant_id,
    supplierName: row.supplier_name,
    opDate: row.op_date ?? null,
    opNumber: row.op_number ?? null,
    invoiceText: row.invoice_text ?? null,
    openAmount: num(row.open_amount) ?? 0,
    buckets,
  };
}

export interface OpImportsLoadResult {
  imports: OpImportRecord[];
  /** true = Tabelle existiert (noch) nicht → UI-Hinweis „Migration ausführen" */
  tableMissing: boolean;
  error: string | null;
}

/** Aktive Importe eines Mandanten, neuester Stichtag zuerst. Best-effort. */
export async function loadOpImports(restaurantId: string): Promise<OpImportsLoadResult> {
  try {
    const { data, error } = await (supabase as any)
      .from(IMPORTS)
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .order('snapshot_date', { ascending: false });
    if (error) {
      const msg = error.message ?? String(error);
      if (TABLE_MISSING.test(msg)) return { imports: [], tableMissing: true, error: null };
      return { imports: [], tableMissing: false, error: msg };
    }
    return { imports: (data ?? []).map(rowToImport), tableMissing: false, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (TABLE_MISSING.test(msg)) return { imports: [], tableMissing: true, error: null };
    return { imports: [], tableMissing: false, error: msg };
  }
}

/** Einzelposten eines Imports (tenant-gefiltert). WIRFT bei Fehler. */
export async function loadOpItems(restaurantId: string, importId: string): Promise<OpItemRecord[]> {
  const { data, error } = await (supabase as any)
    .from(ITEMS)
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('import_id', importId)
    .order('supplier_name', { ascending: true });
  if (error) throw new Error(error.message ?? String(error));
  return (data ?? []).map(rowToItem);
}

/** Aktiver Import zum Stichtag (für den Ersetzen-Dialog). Null bei Fehler/keinem. */
export async function findActiveImport(
  restaurantId: string,
  snapshotDate: string,
): Promise<OpImportRecord | null> {
  try {
    const { data, error } = await (supabase as any)
      .from(IMPORTS)
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('snapshot_date', snapshotDate)
      .eq('status', 'active')
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return rowToImport(data[0]);
  } catch {
    return null;
  }
}

export interface SaveOpImportParams {
  restaurantId: string;
  fileName: string | null;
  parsed: OpListeParseResult;
  /** ID des bestehenden aktiven Imports, der ersetzt werden soll (Ersetzen-Dialog). */
  replaceImportId?: string | null;
  createdBy?: string | null;
}

/**
 * Speichert einen geparsten OP-Listen-Import (Status-Lifecycle, siehe Kopf).
 * Gibt `{ importId, error }` zurück — `error` ist ein sichtbarer Fehlertext,
 * KEIN stilles Fallback.
 */
export async function saveOpImport(params: SaveOpImportParams): Promise<{ importId: string; error: string | null }> {
  const { restaurantId, fileName, parsed, replaceImportId, createdBy } = params;
  if (!parsed.success || !parsed.snapshotDate) {
    return { importId: '', error: 'Parser-Ergebnis unvollständig (kein Stichtag) — Import abgebrochen.' };
  }

  const flatItems = parsed.suppliers.flatMap(sup =>
    sup.items.map(it => ({
      restaurant_id: restaurantId,
      supplier_name: sup.name,
      op_date: it.opDate,
      op_number: it.opNumber,
      invoice_text: it.invoiceText,
      open_amount: it.openAmount,
      overdue_29_plus: it.buckets.overdue29Plus,
      overdue_since_29: it.buckets.overdueSince29,
      overdue_since_14: it.buckets.overdueSince14,
      due_in_15: it.buckets.dueIn15,
      due_in_30: it.buckets.dueIn30,
      due_after_30: it.buckets.dueAfter30,
    })),
  );
  if (flatItems.length === 0) return { importId: '', error: 'Keine Einzelposten zum Speichern.' };

  try {
    // 1) Neuer Import als 'processing'
    const { data: impData, error: impErr } = await (supabase as any)
      .from(IMPORTS)
      .insert({
        restaurant_id: restaurantId,
        snapshot_date: parsed.snapshotDate,
        source_filename: fileName,
        total_open_amount: parsed.totals.openAmount ?? parsed.itemsSum,
        total_items: flatItems.length,
        supplier_count: parsed.suppliers.length,
        status: 'processing',
        raw_totals_json: {
          totals: parsed.totals,
          itemsSum: parsed.itemsSum,
          snapshotTime: parsed.snapshotTime,
          warnings: parsed.warnings,
        },
        created_by: createdBy ?? null,
      })
      .select('id')
      .single();
    if (impErr || !impData?.id) {
      return { importId: '', error: `Import konnte nicht angelegt werden: ${impErr?.message ?? 'unbekannt'}` };
    }
    const importId: string = impData.id;

    // 2) Items chunked einfügen
    for (let i = 0; i < flatItems.length; i += WRITE_CHUNK) {
      const chunk = flatItems.slice(i, i + WRITE_CHUNK).map(it => ({ ...it, import_id: importId }));
      const { error: itemErr } = await (supabase as any).from(ITEMS).insert(chunk);
      if (itemErr) {
        await (supabase as any).from(IMPORTS).update({ status: 'deleted' }).eq('id', importId);
        return { importId: '', error: `Einzelposten konnten nicht gespeichert werden: ${itemErr.message}` };
      }
    }

    // 3) Bestehenden Import ersetzen (falls gewünscht)
    let replacedOld = false;
    if (replaceImportId) {
      const { data: repData, error: repErr } = await (supabase as any)
        .from(IMPORTS)
        .update({ status: 'replaced' })
        .eq('id', replaceImportId)
        .eq('restaurant_id', restaurantId)
        .select('id');
      if (repErr || !repData || repData.length === 0) {
        await (supabase as any).from(IMPORTS).update({ status: 'deleted' }).eq('id', importId);
        return {
          importId: '',
          error: `Bestehender Import konnte nicht ersetzt werden`
            + `${repErr ? `: ${repErr.message}` : ' (0 Zeilen betroffen — RLS/ID prüfen)'}.`,
        };
      }
      replacedOld = true;
    }

    // 4) Neuen Import aktivieren
    const { data: actData, error: actErr } = await (supabase as any)
      .from(IMPORTS)
      .update({ status: 'active' })
      .eq('id', importId)
      .select('id');
    if (actErr || !actData || actData.length === 0) {
      // Kompensation: alten Import reaktivieren, neuen löschen — nie beide aktiv,
      // nie Stichtag ohne aktiven Import zurücklassen.
      const rollbackErrors: string[] = [];
      if (replacedOld && replaceImportId) {
        const { error: rbErr } = await (supabase as any)
          .from(IMPORTS).update({ status: 'active' }).eq('id', replaceImportId);
        if (rbErr) rollbackErrors.push(`Reaktivierung alter Import: ${rbErr.message}`);
      }
      const { error: delErr } = await (supabase as any)
        .from(IMPORTS).update({ status: 'deleted' }).eq('id', importId);
      if (delErr) rollbackErrors.push(`Aufräumen neuer Import: ${delErr.message}`);
      const base = `Import konnte nicht aktiviert werden: ${actErr?.message ?? '0 Zeilen betroffen'}`;
      return {
        importId: '',
        error: rollbackErrors.length > 0
          ? `${base}. Rollback unvollständig — bitte Daten manuell prüfen (${rollbackErrors.join('; ')})`
          : base,
      };
    }

    return { importId, error: null };
  } catch (e) {
    return { importId: '', error: e instanceof Error ? e.message : String(e) };
  }
}
