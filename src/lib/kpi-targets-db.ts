/**
 * kpi-targets-db.ts — IO-Schicht der eigenen KPI-Zielwerte.
 * =========================================================
 * localStorage = schneller Primärspeicher (tenant-präfixierter Schlüssel),
 * Supabase-KV = Backup. Persistenz-Regeln (§2):
 *  - Laden: localStorage sofort; KV-Backup wird dazu-GEMERGT (Union, newer-wins)
 *    und das Ergebnis lokal gespiegelt. Reines Laden schreibt NIE ins KV.
 *  - Speichern: read→merge→write — lokaler Stand ist die Basis-Union; vor dem
 *    KV-Write wird der Remote-Stand strikt gelesen (kvGetStrict: Lesefehler ≠
 *    leer!) und gemergt, damit nie fremde Zielwerte überschrieben werden.
 *  - Backup-Fehler sichtbar über notifyKVBackupProblem (kein stiller Fallback).
 */

import type { TenantId } from '@/contexts/TenantContext';
import { tenantKey } from '@/lib/tenant-utils';
import { kvGet, kvGetStrict, kvSetStrict, notifyKVBackupProblem } from '@/lib/supabase-kv';
import {
  KPI_TARGETS_KEY,
  mergeKpiTargets,
  normalizeKpiTargets,
  type KpiTargetsBlob,
} from '@/lib/kpi-targets';

function storageKey(tenantId: TenantId): string {
  return tenantKey(tenantId, KPI_TARGETS_KEY);
}

export function loadKpiTargetsLocal(tenantId: TenantId): KpiTargetsBlob {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    return raw ? normalizeKpiTargets(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeLocal(tenantId: TenantId, blob: KpiTargetsBlob): void {
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
export async function loadKpiTargets(tenantId: TenantId): Promise<KpiTargetsBlob> {
  const local = loadKpiTargetsLocal(tenantId);
  try {
    const remoteRaw = await kvGet(storageKey(tenantId));
    if (remoteRaw === null) return local;
    const remote = normalizeKpiTargets(remoteRaw);
    const merged = mergeKpiTargets(local, remote);
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
export async function saveKpiTargets(tenantId: TenantId, blob: KpiTargetsBlob): Promise<void> {
  // Database-first (Issue #5): local cache is only written AFTER the merged
  // write is confirmed (previously written immediately, before the KV
  // write even started — a reload after an interrupted save could show a
  // value the database never confirmed).
  const key = storageKey(tenantId);
  try {
    const remoteRaw = await kvGetStrict(key);
    const remote = remoteRaw === null ? {} : normalizeKpiTargets(remoteRaw);
    // Basis-Union: lokaler Stand + Remote — nie destruktiv gegenüber Remote.
    const merged = mergeKpiTargets(remote, blob);
    await kvSetStrict(key, merged);
    // Merge-Ergebnis lokal spiegeln (Remote kann neuere fremde Einträge haben).
    writeLocal(tenantId, merged);
  } catch (err) {
    void notifyKVBackupProblem(err, 'KPI-Zielwerte', {
      toastId: 'kpi-targets-backup',
      retry: () => saveKpiTargets(tenantId, loadKpiTargetsLocal(tenantId)),
    });
  }
}
