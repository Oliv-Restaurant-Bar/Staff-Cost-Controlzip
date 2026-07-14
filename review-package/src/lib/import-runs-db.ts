/**
 * import-runs-db — Supabase-Anbindung der gemeinsamen Import-Historie
 * ==================================================================
 * Schreibt/liest Einträge der Tabelle `import_runs`. Beide Foratable-Importe
 * (Reservationen + Gästeexport/CRM) nutzen `logImportRun` als EINHEITLICHEN
 * Protokoll-Mechanismus.
 *
 * Wichtig: `logImportRun` ist BEWUSST best-effort und wirft NIE — ein
 * fehlgeschlagener Protokoll-Schreibvorgang darf einen ansonsten erfolgreichen
 * Import niemals zum Fehler machen (das Protokoll ist sekundär gegenüber den
 * eigentlichen Importdaten). Bei Schreibfehlern wird nur eine Konsolenwarnung
 * ausgegeben.
 *
 * Mandantentrennung: Alle Lesezugriffe filtern strikt nach `restaurant_id`.
 * Der Zeitstempel `finished_at` kommt aus der Datenbank (Default `now()`),
 * nicht aus dem Browserzustand.
 */

import { supabase } from '@/integrations/supabase/client';
import {
  rowToImportRun,
  type ImportRunRow, type ImportRunStats,
  type ImportRunType, type ImportRunStatus,
} from './import-runs';

export interface LogImportRunInput {
  importType: ImportRunType;
  status: ImportRunStatus;
  fileName?: string | null;
  recordCount?: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  errorMessage?: string | null;
  stats?: ImportRunStats | null;
  /** Beginn des Laufs (Client-Zeit, informativ). Ende = DB-`now()`. */
  startedAt?: string | null;
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Einen Importlauf protokollieren. Best-effort: wirft nie, gibt `true` bei
 * Erfolg zurück. `finished_at` wird vom DB-Default (`now()`) gesetzt.
 */
export async function logImportRun(
  restaurantId: string,
  input: LogImportRunInput,
): Promise<boolean> {
  try {
    const createdBy = await currentUserId();
    const payload = {
      restaurant_id: restaurantId,
      import_type: input.importType,
      status: input.status,
      file_name: input.fileName ?? null,
      record_count: input.recordCount ?? null,
      period_from: input.periodFrom ?? null,
      period_to: input.periodTo ?? null,
      error_message: input.errorMessage ?? null,
      stats_json: input.stats ?? null,
      created_by: createdBy,
      started_at: input.startedAt ?? null,
      // finished_at: DB-Default now() — massgeblicher Zeitstempel.
    };
    const { error } = await (supabase as any).from('import_runs').insert(payload);
    if (error) {
      console.warn('[import-runs] Protokoll konnte nicht gespeichert werden:', error.message ?? error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[import-runs] Protokoll-Fehler:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Importläufe eines Mandanten laden (neueste zuerst), optional nach Typ gefiltert. */
export async function fetchImportRuns(
  restaurantId: string,
  opts: { type?: ImportRunType; limit?: number } = {},
): Promise<ImportRunRow[]> {
  try {
    let q = (supabase as any)
      .from('import_runs')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('finished_at', { ascending: false, nullsFirst: false })
      .limit(opts.limit ?? 100);
    if (opts.type) q = q.eq('import_type', opts.type);
    const { data, error } = await q;
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map(rowToImportRun);
  } catch {
    return [];
  }
}

/**
 * Letzten Lauf je Importtyp ermitteln (für die „Letzter Import"-Anzeige).
 * Zwei typgefilterte Abfragen (je `limit: 1`) — robust auch dann, wenn ein Typ
 * sehr viel häufiger importiert wurde als der andere.
 */
export async function fetchLatestImportRuns(
  restaurantId: string,
): Promise<Record<ImportRunType, ImportRunRow | null>> {
  const [reservations, guest_export] = await Promise.all([
    fetchImportRuns(restaurantId, { type: 'reservations', limit: 1 }),
    fetchImportRuns(restaurantId, { type: 'guest_export', limit: 1 }),
  ]);
  return {
    reservations: reservations[0] ?? null,
    guest_export: guest_export[0] ?? null,
  };
}

/** Prüfen, ob die Tabelle `import_runs` existiert (Migration eingespielt?). */
export async function checkImportRunsTableExist(): Promise<boolean> {
  try {
    const { error } = await (supabase as any).from('import_runs').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}
