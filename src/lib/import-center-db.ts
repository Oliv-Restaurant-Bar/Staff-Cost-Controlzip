/**
 * import-center-db.ts — Read-only status aggregator for the Import Center.
 * =======================================================================
 * Fetches the "last import" signal for the categories that HAVE a cheap,
 * reliable source (Foratable=import_runs, Gastronovi=gn_imports,
 * Produktumsätze=product_sales batches). Every fetch is isolated via
 * Promise.allSettled so one failing source never blocks the others — a
 * failed/missing source simply leaves that category out of the map (the UI
 * then falls back to "Kein Protokoll" / unknown).
 *
 * This module performs NO writes and changes NO import logic. Categories whose
 * statusSource is 'none' are intentionally not fetched here (no central log).
 */

import { fetchLatestImportRuns } from './import-runs-db';
import { loadGnImports } from './gn-zbericht-db';
import { fetchImportBatches } from './sales-db';
import {
  deriveStatusFromRun,
  deriveStatusFromTimestamp,
  pickLatestRun,
  type ImportCategoryId,
  type ImportStatus,
  type ImportStatusSource,
} from './import-center';

export type ImportStatusMap = Partial<Record<ImportCategoryId, ImportStatus>>;

/**
 * Load the available "last import" statuses for the Import Center.
 * Only categories backed by a real signal appear in the returned map.
 *
 * `allowedSources` scopes the reads to the status sources of the cards the
 * current role can actually SEE. A role that sees no card backed by a given
 * source (e.g. a Beaulieu viewer who only sees Warenrechnungen → statusSource
 * 'none') must never trigger that source's read — both for least-privilege and
 * to avoid pointless metadata fetches.
 */
export async function loadImportCenterStatuses(
  restaurantId: string,
  allowedSources: ReadonlySet<ImportStatusSource>,
): Promise<ImportStatusMap> {
  const out: ImportStatusMap = {};

  await Promise.allSettled([
    // Foratable → import_runs (most recent of reservations + guest_export)
    (async () => {
      if (!allowedSources.has('import_runs')) return;
      const runs = await fetchLatestImportRuns(restaurantId);
      out.foratable = deriveStatusFromRun(pickLatestRun([runs.reservations, runs.guest_export]));
    })(),

    // Gastronovi Z-Bericht → gn_imports (max imported_at)
    (async () => {
      if (!allowedSources.has('gn_imports')) return;
      const rows = await loadGnImports(restaurantId);
      const latest = rows
        .map((r) => r.imported_at)
        .filter((t): t is string => Boolean(t))
        .sort()
        .at(-1) ?? null;
      out.gastronovi = deriveStatusFromTimestamp(latest);
    })(),

    // Produktumsätze → product_sales import batches (already sorted newest-first)
    (async () => {
      if (!allowedSources.has('product_batches')) return;
      const batches = await fetchImportBatches(restaurantId as any);
      const latest = batches[0]?.imported_at ?? null;
      out.produktumsaetze = deriveStatusFromTimestamp(latest);
    })(),
  ]);

  return out;
}
