/**
 * Reine, abhängigkeitsfreie Blob-Helfer (Stabilisierungsrunde 2.7, T204)
 * ======================================================================
 * Gemeinsamer TECHNISCHER Kern der drei KV-Blob-Persistenzpfade
 * (Budget, Tagesumsätze/dailyBudgets, Reporting):
 *  - Shape-Guard für Remote-Blobs (Record erwartet, alles andere → {})
 *  - localStorage-JSON-Parse-Guard für lokale Record-Blobs
 *
 * BEWUSST NICHT hier: Merge-Regeln, Tombstones, Konfliktauflösung,
 * updatedAt-Semantik, Fehlerpolitik, localStorage-Schreib-Reihenfolge —
 * diese sind fachlich je Domäne verschieden und bleiben in den Domänen
 * (budget-store, reporting-store, supabase-kv-Upserts). Entscheid der
 * Runde 2.7: KEINE generische safeBlobUpsert-Abstraktion (siehe Bericht).
 *
 * Dieses Modul ist absichtlich frei von Supabase-Importen: budget-store
 * lädt supabase-kv nur dynamisch (Load-Pfade bleiben Supabase-frei) —
 * ein statischer Import von hier zieht keinen Client in Load-Pfade/Tests.
 */

/**
 * Shape-Guard: Wert ist nur dann ein Blob-Record, wenn er ein nicht-Array-
 * Objekt ist. `null`/Primitive/Arrays (korrupte oder fehlende Blobs) → {}.
 */
export function asRecordBlob(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Liest einen Record-Blob aus localStorage.
 * Unlesbarer/korrupter Inhalt (JSON-Fehler, kein Record) → {} —
 * niemals werfen, niemals ein Array/Primitive als Record durchreichen.
 */
export function readLocalRecord(storageKey: string): Record<string, unknown> {
  try {
    return asRecordBlob(JSON.parse(localStorage.getItem(storageKey) || '{}'));
  } catch {
    return {};
  }
}
