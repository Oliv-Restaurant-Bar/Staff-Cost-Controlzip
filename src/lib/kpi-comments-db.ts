/**
 * kpi-comments-db.ts — IO-Schicht der KPI-Monatskommentare.
 * =========================================================
 * localStorage = schneller Primärspeicher (tenant-präfixierter Schlüssel),
 * Supabase-KV = Backup. Persistenz-Regeln (§2):
 *  - Laden: localStorage sofort; KV-Backup wird dazu-GEMERGT (Union, newer-wins)
 *    und das Ergebnis lokal gespiegelt. Reines Laden schreibt NIE ins KV.
 *  - Speichern: read→merge→write — lokaler Stand ist die Basis-Union; vor dem
 *    KV-Write wird der Remote-Stand strikt gelesen (kvGetStrict: Lesefehler ≠
 *    leer!) und gemergt, damit nie fremde Monate/KPIs überschrieben werden.
 *  - Backup-Fehler sichtbar über notifyKVBackupProblem (kein stiller Fallback).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { tenantKey } from '@/lib/tenant-utils';
import { kvGet, kvGetStrict, kvSetStrict, notifyKVBackupProblem } from '@/lib/supabase-kv';
import {
  KPI_COMMENTS_KEY,
  mergeKpiComments,
  normalizeKpiComments,
  type KpiCommentsBlob,
} from '@/lib/kpi-comments';

function storageKey(tenantId: TenantId): string {
  return tenantKey(tenantId, KPI_COMMENTS_KEY);
}

export function loadKpiCommentsLocal(tenantId: TenantId): KpiCommentsBlob {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    return raw ? normalizeKpiComments(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeLocal(tenantId: TenantId, blob: KpiCommentsBlob): void {
  try {
    localStorage.setItem(storageKey(tenantId), JSON.stringify(blob));
  } catch {
    /* localStorage voll/gesperrt — KV bleibt Backup */
  }
}

/**
 * Laden mit KV-Merge: lokaler Stand sofort nutzbar; das KV-Backup wird
 * best-effort dazugemergt und lokal gespiegelt. Schreibt NIE ins KV.
 */
export async function loadKpiComments(tenantId: TenantId): Promise<KpiCommentsBlob> {
  const local = loadKpiCommentsLocal(tenantId);
  try {
    const remoteRaw = await kvGet(storageKey(tenantId));
    if (remoteRaw === null) return local;
    const remote = normalizeKpiComments(remoteRaw);
    const merged = mergeKpiComments(local, remote);
    writeLocal(tenantId, merged);
    return merged;
  } catch {
    return local; // Lesen best-effort — lokaler Stand bleibt massgeblich.
  }
}

/**
 * Speichern: lokal sofort, dann KV-Backup über sicheren Merge-Schreibpfad
 * (read→merge→write). Backup-Fehler werden sichtbar gemeldet, der lokale
 * Stand bleibt in jedem Fall erhalten.
 */
export async function saveKpiComments(
  tenantId: TenantId,
  blob: KpiCommentsBlob,
): Promise<void> {
  // Database-first (Issue #5): local cache only written after the merged
  // write is confirmed (was written immediately before, ahead of the KV
  // write even starting).
  const key = storageKey(tenantId);
  try {
    const remoteRaw = await kvGetStrict(key);
    const remote = remoteRaw === null ? {} : normalizeKpiComments(remoteRaw);
    // Basis-Union: lokaler Stand + Remote — nie destruktiv gegenüber Remote.
    const merged = mergeKpiComments(remote, blob);
    await kvSetStrict(key, merged);
    // Merge-Ergebnis lokal spiegeln (Remote kann neuere fremde Einträge haben).
    writeLocal(tenantId, merged);
  } catch (err) {
    void notifyKVBackupProblem(err, 'KPI-Kommentare', {
      toastId: 'kpi-comments-backup',
      retry: () => saveKpiComments(tenantId, loadKpiCommentsLocal(tenantId)),
    });
  }
}
